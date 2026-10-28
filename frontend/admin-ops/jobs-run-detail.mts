/* =============================================================================
   JOBS RUN DETAIL — one run: header facts, step-timing bar, result tiles and the log viewer.

   Rendered into the Runs sub-tab's #jobs-run-detail host by the pane. The log is fetched whole
   (every level) and cached by seq; the level filter and search are client-side, so a filter
   change never refetches. The log is polled every 2 s with after_seq = the response's last_seq and
   stops when the response says done (or the pane stops being visible); on done the run is re-read by
   id (GET /jobs/runs/{id}) so the header, tiles and error show the final state. Times are shown in
   the plant's timezone (the run's instants are tz-aware).
   The viewer is a fixed-row VirtualList (a wrapped line makes the row taller, estimated from the
   character count). Module state only; no Store events.
   ========================================================================== */

import { Util, Toast, VirtualList } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import { JobsClient } from './jobs-client.mjs';
import type { JobRun } from './jobs-client.mjs';
import {
  statusBadgeHtml, isActiveRun, durationText, stepSegments, resultTiles, mergeLog, lastSeq, filterLog, logToText,
  LOG_LEVELS, plantWall,
} from './jobs-model.mjs';
import type { LogLine } from './jobs-model.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));
const deps = { t, esc };

export const LOG_POLL_MS = 2000;
const ROW_H = 20;
const CHAR_W = 7.4;   // JetBrains Mono at 12 px, for the wrapped-row estimate

interface DetailState {
  host: HTMLElement;
  run: JobRun;
  lines: LogLine[];
  tz: string;
  lastSeq: number;
  done: boolean;
  level: string;
  q: string;
  follow: boolean;
  wrap: boolean;
  vl: VirtualList<LogLine> | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  onChanged: (() => void) | null;
  visible: () => boolean;
}
let _d: DetailState | null = null;

const _q = <E extends HTMLElement = HTMLElement>(sel: string): E | null => (_d?.host.querySelector(sel) as E | null);
const _fmt = (iso: string | null | undefined): string => (iso ? Util.fmtDTPref(plantWall(iso, _d?.tz)) : '—');

function _headerHtml(r: JobRun, canCancel: boolean): string {
  const facts: Array<[string, string]> = [
    [t('jobs.run_scheduled'), _fmt(r.scheduled_for)], [t('jobs.run_started'), _fmt(r.started_at)],
    [t('jobs.run_ended'), _fmt(r.ended_at)], [t('jobs.run_duration'), durationText(r.duration_ms) || '—'],
    [t('jobs.run_trigger'), r.trigger ? t(`jobs.trigger_${r.trigger}`) : '—'], [t('jobs.run_by'), r.triggered_by || '—'],
  ];
  return `<div class="job-run-head"><button type="button" class="btn btn-ghost sm" data-jr-act="back">${esc(t('jobs.back_to_runs'))}</button>`
    + `<h3 class="job-run-title">${esc(r.job_name)} <span class="job-mono job-run-id">#${esc(r.id)}</span> ${statusBadgeHtml(r.status, deps)}</h3>`
    + `<span class="job-run-plant job-mono">${esc(r.plant)}</span>`
    + (canCancel ? `<button type="button" class="btn btn-ghost sm" data-jr-act="cancel">${esc(t('jobs.cancel_run'))}</button>` : '') + `</div>`
    + `<dl class="job-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="job-mono">${esc(v)}</dd></div>`).join('')}</dl>`
    + (r.error ? `<div class="job-run-error" role="alert">${esc(r.error)}</div>` : '');
}

export function stepBarHtml(r: JobRun): string {
  const segs = stepSegments(r.summary?.steps);
  if (!segs.length) return '';
  return `<div class="job-steps"><div class="job-steps-bar" role="img" aria-label="${esc(t('jobs.steps'))}">`
    + segs.map((s, i) => `<span class="job-step job-step-${i % 4}" style="flex:${s.pct} 1 0" title="${esc(s.step)} ${esc(s.label)}"></span>`).join('')
    + `</div><ul class="job-steps-legend">`
    + segs.map((s, i) => `<li><i class="job-step-dot job-step-${i % 4}"></i><span>${esc(s.step)}</span> <span class="job-mono">${esc(s.label)}</span></li>`).join('')
    + `</ul></div>`;
}

export function tilesHtml(r: JobRun): string {
  const tiles = resultTiles(r.summary);
  const action = r.summary?.action_id;
  if (!tiles.length && action == null) return '';
  return `<div class="job-tiles">`
    + tiles.map(x => `<div class="job-tile${x.key === 'dropped' && x.value > 0 ? ' warn' : ''}"><div class="job-tile-n job-mono">${esc(x.value)}</div><div class="job-tile-l">${esc(t(`jobs.tile_${x.key}`))}</div></div>`).join('')
    + (action != null ? `<div class="job-tile"><div class="job-tile-n job-mono">${esc(action)}</div><div class="job-tile-l">${esc(t('jobs.tile_action'))}</div>`
      + `<button type="button" class="btn btn-ghost sm" data-jr-act="history">${esc(t('jobs.open_history'))}</button></div>` : '')
    + `</div>`;
}

function _toolbarHtml(s: DetailState): string {
  return `<div class="job-log-bar"><select class="input" id="jr-level" aria-label="${esc(t('jobs.log_level'))}"><option value="all">${esc(t('jobs.level_all'))}</option>`
    + LOG_LEVELS.map(l => `<option value="${l}"${l === s.level ? ' selected' : ''}>${esc(t(`jobs.level_${l}`))}</option>`).join('') + `</select>`
    + `<input class="input" id="jr-q" type="search" value="${esc(s.q)}" placeholder="${esc(t('jobs.log_search'))}" aria-label="${esc(t('jobs.log_search'))}" autocomplete="off">`
    + `<label class="chk-inline"><input type="checkbox" id="jr-follow"${s.follow ? ' checked' : ''}><span>${esc(t('jobs.log_follow'))}</span></label>`
    + `<label class="chk-inline"><input type="checkbox" id="jr-wrap"${s.wrap ? ' checked' : ''}><span>${esc(t('jobs.log_wrap'))}</span></label>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="copy">${esc(t('jobs.log_copy'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="download">${esc(t('jobs.log_download'))}</button>`
    + `<span class="ape-hint" id="jr-count" aria-live="polite"></span></div>`;
}

export function logRowHtml(l: LogLine, tz = ''): string {
  return `<div class="job-log-row job-lv-${esc(l.level)}"><span class="job-log-at job-mono">${esc(l.at ? Util.fmtDTShortPref(plantWall(l.at, tz)) : '')}</span>`
    + `<span class="job-log-lv">${esc(t(`jobs.level_${l.level}`))}</span>`
    + `<span class="job-log-step job-mono">${esc(l.step ?? '')}</span><span class="job-log-msg">${esc(l.msg)}</span>`
    + `<span class="job-log-dur job-mono">${esc(l.duration_ms != null ? durationText(l.duration_ms) : '')}</span></div>`;
}

function _rowHeight(l: LogLine, s: DetailState): number {
  if (!s.wrap) return ROW_H;
  const w = (_q('#jr-log')?.clientWidth || 800) - 330;   // minus the time / level / step / duration columns
  const per = Math.max(20, Math.floor(w / CHAR_W));
  return ROW_H * Math.max(1, Math.ceil(l.msg.length / per));
}

function _paintLog(): void {
  const s = _d;
  const scroll = _q('#jr-log');
  if (!s || !scroll) return;
  if (!s.vl) {
    s.vl = new VirtualList<LogLine>(scroll, { getRowH: (l) => _rowHeight(l, s), renderFn: (l) => logRowHtml(l, s.tz), buffer: 12 });
  }
  const shown = filterLog(s.lines, { level: s.level, q: s.q });
  s.vl._getRowH = (l) => _rowHeight(l, s);
  s.vl.update(shown);
  const cnt = _q('#jr-count');
  if (cnt) cnt.textContent = t('jobs.log_count', { shown: shown.length, total: s.lines.length });
  const empty = _q('#jr-empty');
  if (empty) empty.hidden = shown.length > 0;
  if (s.follow && shown.length) scroll.scrollTop = scroll.scrollHeight;
}

async function _fetchLog(): Promise<void> {
  const s = _d;
  if (!s || s.inflight) return;
  s.inflight = true;
  try {
    const res = await JobsClient.log(s.run.id, { afterSeq: s.lastSeq });
    if (_d !== s) return;
    if (res.lines.length) { s.lines = mergeLog(s.lines, res.lines); _paintLog(); }
    s.lastSeq = Math.max(s.lastSeq, res.lastSeq, lastSeq(s.lines));
    s.done = res.done;
    if (res.truncated && !s.run.log_truncated) s.run = { ...s.run, log_truncated: true };
    if (res.done || (res.status && res.status !== s.run.status)) {
      // The run changed state: re-read it so ended_at, summary and error show (the log page only carries status).
      s.run = await JobsClient.getRun(s.run.id).catch(() => ({ ...s.run, status: res.status ?? s.run.status }));
      if (_d !== s) return;
      _paintHead();
      s.onChanged?.();
    }
  } catch { /* transient: the next tick retries */ } finally { s.inflight = false; }
}

function _paintHead(): void {
  const s = _d;
  const head = _q('#jr-head');
  if (!s || !head) return;
  head.innerHTML = _headerHtml(s.run, Session.isAdmin() && isActiveRun(s.run.status)) + stepBarHtml(s.run) + tilesHtml(s.run);
}

function _tick(): void {
  const s = _d;
  if (!s) return;
  s.timer = null;
  if (!s.visible()) return;   // paused while hidden; JobsRunDetail.resume() restarts it
  void _fetchLog().then(() => {
    if (_d !== s) return;
    if (!s.done) s.timer = setTimeout(_tick, LOG_POLL_MS);
  });
}

function _download(s: DetailState): void {
  const text = logToText(s.lines, x => Util.fmtDTPref(plantWall(x, s.tz)));
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.href = url; a.download = `job-run-${s.run.id}.log`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const JobsRunDetail = {
  show(host: HTMLElement, run: JobRun, opts: { onBack: () => void; onChanged?: () => void; visible: () => boolean; tz?: string }): void {
    JobsRunDetail.stop();
    const s: DetailState = {
      host, run, lines: [], tz: opts.tz ?? '', lastSeq: 0, done: false, level: 'all', q: '', follow: isActiveRun(run.status), wrap: false, vl: null, timer: null,
      inflight: false, onChanged: opts.onChanged ?? null, visible: opts.visible,
    };
    _d = s;
    host.innerHTML = `<div id="jr-head"></div>${_toolbarHtml(s)}<div class="job-log" id="jr-log" tabindex="0" role="log" aria-label="${esc(t('jobs.log'))}"></div>`
      + `<div class="job-log-empty" id="jr-empty">${esc(t('jobs.log_empty'))}</div>`
      + (run.log_truncated ? `<div class="ape-hint">${esc(t('jobs.log_truncated'))}</div>` : '');
    _paintHead();
    host.onclick = (e: MouseEvent) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-jr-act]')?.dataset.jrAct;
      if (!act || _d !== s) return;
      if (act === 'back') { opts.onBack(); }
      else if (act === 'copy') {
        const txt = logToText(filterLog(s.lines, { level: s.level, q: s.q }), x => Util.fmtDTPref(plantWall(x, s.tz)));
        navigator.clipboard?.writeText(txt).then(() => Toast.show(t('jobs.log_copied'), 'ok'), () => Toast.show(t('jobs.log_copy_failed'), 'err'));
      }
      else if (act === 'download') _download(s);
      else if (act === 'cancel') {
        void JobsClient.cancelRun(s.run.id).then(() => { Toast.show(t('jobs.toast_cancel_requested'), 'ok'); void _fetchLog(); opts.onChanged?.(); })
          .catch((err: Error) => Toast.show(err.message, 'err'));
      } else if (act === 'history') {
        (globalThis as unknown as { NIMBUS?: { App?: { goto?(tab: string): void } } }).NIMBUS?.App?.goto?.('gantt');
        Toast.show(t('jobs.history_hint', { id: String(s.run.summary?.action_id ?? '') }), 'info');
      }
    };
    host.onchange = (e: Event) => {
      const id = (e.target as HTMLElement).id;
      if (_d !== s) return;
      if (id === 'jr-level') { s.level = (e.target as HTMLSelectElement).value; _paintLog(); }
      else if (id === 'jr-follow') { s.follow = (e.target as HTMLInputElement).checked; if (s.follow) _paintLog(); }
      else if (id === 'jr-wrap') { s.wrap = (e.target as HTMLInputElement).checked; _paintLog(); }
    };
    host.oninput = (e: Event) => {
      if ((e.target as HTMLElement).id === 'jr-q' && _d === s) { s.q = (e.target as HTMLInputElement).value; _paintLog(); }
    };
    // Reading back up the log turns follow off, as a terminal does.
    _q('#jr-log')?.addEventListener('wheel', () => {
      if (_d !== s || !s.follow) return;
      s.follow = false;
      const cb = _q<HTMLInputElement>('#jr-follow');
      if (cb) cb.checked = false;
    }, { passive: true });
    _paintLog();
    void _fetchLog().then(() => { if (_d === s && !s.done) s.timer = setTimeout(_tick, LOG_POLL_MS); });
  },

  /** Restart the poll after the pane became visible again. */
  resume(): void {
    const s = _d;
    if (s && !s.timer && !s.done) s.timer = setTimeout(_tick, 0);
  },

  stop(): void {
    if (_d?.timer) clearTimeout(_d.timer);
    if (_d) { _d.host.onclick = null; _d.host.onchange = null; _d.host.oninput = null; }
    _d = null;
  },

  isOpen(): boolean { return _d !== null; },
};
