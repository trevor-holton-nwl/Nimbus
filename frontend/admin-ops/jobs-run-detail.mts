/* =============================================================================
   JOBS RUN DETAIL — one run: header facts, error panel, step-timing bar, result tiles, dry-run
   proposal and the log viewer.

   Rendered into the Runs sub-tab's #jobs-run-detail host by the pane. The log is fetched whole
   (every level) and cached by seq; the level filter, errors-only toggle and search are client-side,
   so a filter change never refetches. The log is polled every 2 s with after_seq = the response's
   last_seq and stops when the response says done (or the pane stops being visible); on done the run
   is re-read by id (GET /jobs/runs/{id}) so the header, tiles and error show the final state. Times
   are shown in the plant's timezone (the run's instants are tz-aware).
   A failed run opens on its Error panel (failing step, message, "Fix the job" / "System error").
   A dry run (result mode Dry run) shows a read-only proposal table from GET /jobs/runs/{id}/proposal:
   nothing was applied, so there is no Approve or Discard step anywhere.
   The viewer is a VirtualList whose rows are estimated from the character count (a wrapped line, or
   a line with its structured `data` expanded, makes the row taller). Module state only; no Store events.
   ========================================================================== */

import { Util, Toast, Modal, VirtualList } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import { JobsClient } from './jobs-client.mjs';
import type { JobRun } from './jobs-client.mjs';
import {
  runStatusHtml, isActiveRun, durationText, stepSegments, resultTiles, mergeLog, lastSeq, filterLog,
  logToText, errorsToText, firstErrorIndex, lineDataText, elapsedText, elapsedMs, errorKindOf, isDryRun, deltaText,
  LOG_LEVELS, LOG_PAGE, plantWall, tzShort,
} from './jobs-model.mjs';
import type { LogLine, Proposal, ProposalRow } from './jobs-model.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));
const deps = { t, esc };

export const LOG_POLL_MS = 2000;
const ROW_H = 20;
const DATA_LINE_H = 16;
const DATA_MAX_H = 160;
const PROPOSAL_ROW_H = 28;
const CHAR_W = 7.4;   // JetBrains Mono at 12 px, for the wrapped-row estimate

interface DetailState {
  host: HTMLElement;
  run: JobRun;
  lines: LogLine[];
  tz: string;
  lastSeq: number;
  done: boolean;
  level: string;
  errorsOnly: boolean;
  q: string;
  follow: boolean;
  wrap: boolean;
  open: Set<number>;               // seqs whose structured data is expanded
  vl: VirtualList<LogLine> | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  proposal: { vl: VirtualList<ProposalRow> | null; seq: number };
  onChanged: (() => void) | null;
  onRestart: ((run: JobRun) => void) | null;
  visible: () => boolean;
  longer: () => boolean;
}
let _d: DetailState | null = null;

const _q = <E extends HTMLElement = HTMLElement>(sel: string): E | null => (_d?.host.querySelector(sel) as E | null);
const _fmt = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const z = tzShort(_d?.tz, iso);
  return `${Util.fmtDTPref(plantWall(iso, _d?.tz))}${z ? ` ${z}` : ''}`;
};

/** Result mode badge text for an optimizer run (Apply / Dry run), or '' for a run that has no such mode. */
export function resultBadgeHtml(r: { summary: { apply_mode?: string | null } | null }): string {
  const m = r.summary?.apply_mode;
  if (m !== 'apply' && m !== 'propose') return '';
  return `<span class="badge ${m === 'propose' ? 'badge-info' : 'badge-muted'} job-result" title="${esc(t(`jobs.result_${m}_tip`))}">${esc(t(`jobs.result_${m}`))}</span>`;
}

/** The Error panel of a failed run: kind badge, the failing step, the message. */
export function errorPanelHtml(r: JobRun): string {
  if (r.status !== 'failed' && !(r.status === 'skipped' && r.error)) return '';
  if (!r.error && !r.summary?.failed_step) return '';
  const kind = errorKindOf(r.summary);
  const step = r.summary?.failed_step;
  return `<section class="job-error-panel" role="alert" aria-label="${esc(t('jobs.error_panel'))}">`
    + `<div class="job-error-head"><strong>${esc(t('jobs.error_panel'))}</strong>`
    + (kind ? ` <span class="badge ${kind === 'system' ? 'badge-err' : 'badge-warn'} job-error-kind">${esc(t(`jobs.error_kind_${kind}`))}</span>` : '')
    + (step ? ` <span class="job-sub">${esc(t('jobs.error_step'))} <span class="job-mono">${esc(step)}</span></span>` : '') + `</div>`
    + (r.error ? `<div class="job-error-msg">${esc(r.error)}</div>` : '')
    + (kind ? `<div class="ape-hint">${esc(t(`jobs.error_kind_${kind}_hint`))}</div>` : '')
    // Both buttons stay hidden until the log holds an error line (_paintLog reveals them): a failure with no error line has nothing to jump to.
    + `<div class="job-error-actions"><button type="button" class="btn btn-ghost sm" data-jr-act="show-errors" id="jr-panel-show-errors" hidden>${esc(t('jobs.err_show_errors'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="first-error" id="jr-panel-first-error" hidden>${esc(t('jobs.err_first'))}</button></div></section>`;
}

function _elapsedFact(r: JobRun): string {
  const ms = r.duration_ms ?? elapsedMs(r.started_at, r.ended_at, Date.now());
  return durationText(ms) || '—';
}

function _headerHtml(r: JobRun, o: { canCancel: boolean; canRestart: boolean; longer: boolean }): string {
  const facts: Array<[string, string, string?]> = [
    [t('jobs.run_scheduled'), _fmt(r.scheduled_for)], [t('jobs.run_started'), _fmt(r.started_at)],
    [t('jobs.run_ended'), _fmt(r.ended_at)], [t('jobs.run_elapsed'), _elapsedFact(r), 'jr-elapsed'],
    [t('jobs.run_trigger'), r.trigger ? t(`jobs.trigger_${r.trigger}`) : '—'], [t('jobs.run_by'), r.triggered_by || '—'],
  ];
  if (isActiveRun(r.status)) facts.push([t('jobs.run_step'), '—', 'jr-step']);
  const tz = _d?.tz;
  return `<div class="job-run-head"><button type="button" class="btn btn-ghost sm" data-jr-act="back">${esc(t('jobs.back_to_runs'))}</button>`
    + `<h3 class="job-run-title">${esc(r.job_name)} <span class="job-mono job-run-id">#${esc(r.id)}</span> ${runStatusHtml(r, deps)} ${resultBadgeHtml(r)}`
    + `<span class="badge badge-warn job-longer" id="jr-longer"${o.longer ? '' : ' hidden'}>${esc(t('jobs.longer_than_usual'))}</span></h3>`
    + `<span class="job-run-plant job-mono">${esc(r.plant)}${tz ? ` · ${esc(tz)}` : ''}</span>`
    + (o.canCancel ? `<button type="button" class="btn btn-ghost sm" data-jr-act="cancel">${esc(t('jobs.cancel_run'))}</button>` : '')
    + (o.canRestart ? `<button type="button" class="btn btn-ghost sm" data-jr-act="restart">${esc(t('jobs.restart'))}</button>` : '') + `</div>`
    + errorPanelHtml(r)
    + `<dl class="job-facts">${facts.map(([k, v, id]) => `<div><dt>${esc(k)}</dt><dd class="job-mono"${id ? ` id="${id}"` : ''}>${esc(v)}</dd></div>`).join('')}</dl>`;
}

/** One neutral fill for every step (width = share of the run); only the failed step is marked, in the error colour. */
export function stepBarHtml(r: JobRun): string {
  const segs = stepSegments(r.summary?.steps);
  if (!segs.length) return '';
  const failed = r.summary?.failed_step;
  const cls = (step: string): string => `job-step${r.status === 'failed' && failed === step ? ' job-step-failed' : ''}`;
  return `<div class="job-steps"><div class="job-steps-bar" role="img" aria-label="${esc(t('jobs.steps'))}">`
    + segs.map(s => `<span class="${cls(s.step)}" style="flex:${s.pct} 1 0" title="${esc(s.step)} ${esc(s.label)}"></span>`).join('')
    + `</div><ul class="job-steps-legend">`
    + segs.map(s => `<li class="job-mono"><span>${esc(s.step)}</span> <span>${esc(s.label)}</span></li>`).join('')
    + `</ul></div>`;
}

export function tilesHtml(r: JobRun): string {
  const tiles = resultTiles(r.summary);
  const action = r.summary?.action_id;
  if (!tiles.length && action == null) return '';
  return `<div class="job-tiles">`
    + tiles.map(x => `<div class="kpi-tile${x.key === 'dropped' && x.value > 0 ? ' warn' : ''}"><div class="k">${esc(t(`jobs.tile_${x.key}`))}</div><div class="v">${esc(x.value)}</div></div>`).join('')
    + (action != null ? `<div class="kpi-tile"><div class="k">${esc(t('jobs.tile_action'))}</div><div class="v">${esc(action)}</div>`
      + `<button type="button" class="btn btn-ghost sm" data-jr-act="history">${esc(t('jobs.open_history'))}</button></div>` : '')
    + `</div>`;
}

function _toolbarHtml(s: DetailState): string {
  return `<div class="job-log-bar"><select class="input" id="jr-level" aria-label="${esc(t('jobs.log_level'))}"><option value="all">${esc(t('jobs.level_all'))}</option>`
    + LOG_LEVELS.map(l => `<option value="${l}"${l === s.level ? ' selected' : ''}>${esc(t(`jobs.level_${l}`))}</option>`).join('') + `</select>`
    + `<input class="input" id="jr-q" type="search" value="${esc(s.q)}" placeholder="${esc(t('jobs.log_search'))}" aria-label="${esc(t('jobs.log_search'))}" autocomplete="off">`
    + `<label class="chk-inline"><input type="checkbox" id="jr-errors"${s.errorsOnly ? ' checked' : ''}><span>${esc(t('jobs.log_errors_only'))}</span></label>`
    + `<label class="chk-inline"><input type="checkbox" id="jr-follow"${s.follow ? ' checked' : ''}><span>${esc(t('jobs.log_follow'))}</span></label>`
    + `<label class="chk-inline"><input type="checkbox" id="jr-wrap"${s.wrap ? ' checked' : ''}><span>${esc(t('jobs.log_wrap'))}</span></label>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="first-error" id="jr-first-error" hidden>${esc(t('jobs.err_first'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="copy">${esc(t('jobs.log_copy'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="download">${esc(t('jobs.log_download'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="copy-errors" id="jr-copy-errors" hidden>${esc(t('jobs.log_copy_errors'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jr-act="download-errors" id="jr-download-errors" hidden>${esc(t('jobs.log_download_errors'))}</button>`
    + `<span class="ape-hint" id="jr-count" aria-live="polite"></span></div>`;
}

export function logRowHtml(l: LogLine, tz = '', startIso: string | null = null, open = false): string {
  const data = lineDataText(l.data);
  const toggle = data
    ? `<button type="button" class="job-log-toggle" data-jr-data="${esc(l.seq)}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${esc(t('jobs.log_data'))}">${open ? '▾' : '▸'}</button>` : '';
  return `<div class="job-log-row job-lv-${esc(l.level)}"><span class="job-log-el job-mono">${esc(elapsedText(l.at, startIso))}</span>`
    + `<span class="job-log-at job-mono">${esc(l.at ? Util.fmtDTShortPref(plantWall(l.at, tz)) : '')}</span>`
    + `<span class="job-log-lv">${esc(t(`jobs.level_${l.level}`))}</span>`
    + `<span class="job-log-step job-mono">${esc(l.step ?? '')}</span><span class="job-log-msg">${toggle}${esc(l.msg)}</span>`
    + `<span class="job-log-dur job-mono">${esc(l.duration_ms != null ? durationText(l.duration_ms) : '')}</span>`
    + (data && open ? `<pre class="job-log-data job-mono">${esc(data)}</pre>` : '') + `</div>`;
}

function _rowHeight(l: LogLine, s: DetailState): number {
  let h = ROW_H;
  if (s.wrap) {
    const w = (_q('#jr-log')?.clientWidth || 800) - 400;   // minus the elapsed / time / level / step / duration columns
    const per = Math.max(20, Math.floor(w / CHAR_W));
    h = ROW_H * Math.max(1, Math.ceil(l.msg.length / per));
  }
  if (s.open.has(l.seq)) {
    const d = lineDataText(l.data);
    // <pre> = lines x 16 px + 8 px padding (capped at 160 incl. padding), plus its 8 px bottom margin and the grid's 8 px row gap.
    if (d) h += Math.min(DATA_MAX_H, d.split('\n').length * DATA_LINE_H + 8) + 16;
  }
  return h;
}

function _shown(s: DetailState): LogLine[] {
  return filterLog(s.lines, { level: s.errorsOnly ? 'error' : s.level, q: s.q });
}

function _paintLog(): void {
  const s = _d;
  const scroll = _q('#jr-log');
  if (!s || !scroll) return;
  if (!s.vl) {
    s.vl = new VirtualList<LogLine>(scroll, { getRowH: (l) => _rowHeight(l, s), renderFn: (l) => logRowHtml(l, s.tz, s.run.started_at, s.open.has(l.seq)), buffer: 12 });
  }
  const shown = _shown(s);
  s.vl._getRowH = (l) => _rowHeight(l, s);
  s.vl._renderFn = (l) => logRowHtml(l, s.tz, s.run.started_at, s.open.has(l.seq));
  s.vl.update(shown);
  const cnt = _q('#jr-count');
  if (cnt) cnt.textContent = t('jobs.log_count', { shown: shown.length, total: s.lines.length });
  const empty = _q('#jr-empty');
  if (empty) empty.hidden = shown.length > 0;
  const hasErr = firstErrorIndex(s.lines) >= 0;
  for (const id of ['#jr-first-error', '#jr-copy-errors', '#jr-download-errors', '#jr-panel-show-errors', '#jr-panel-first-error']) { const b = _q(id); if (b) b.hidden = !hasErr; }
  if (s.follow && shown.length) scroll.scrollTop = scroll.scrollHeight;
}

/** Scroll the viewer to the first error line (the log is switched to errors-only first when the filter hides it). */
function _jumpFirstError(s: DetailState): void {
  const scroll = _q('#jr-log');
  if (!scroll) return;
  s.follow = false;
  const cb = _q<HTMLInputElement>('#jr-follow');
  if (cb) cb.checked = false;
  const shown = _shown(s);
  const idx = firstErrorIndex(shown);
  if (idx < 0) { Toast.show(t('jobs.err_none'), 'info'); return; }
  let top = 0;
  for (let i = 0; i < idx; i++) top += _rowHeight(shown[i], s);
  scroll.scrollTop = Math.max(0, top - ROW_H);
  _q('#jr-log')?.focus();
}

function _updateLive(): void {
  const s = _d;
  if (!s) return;
  const el = _q('#jr-elapsed'); if (el) el.textContent = _elapsedFact(s.run);
  const step = _q('#jr-step');
  if (step) { const last = [...s.lines].reverse().find(l => l.step); step.textContent = last?.step ?? '—'; }
  const lg = _q('#jr-longer'); if (lg) lg.hidden = !s.longer();
}

async function _fetchLog(): Promise<void> {
  const s = _d;
  if (!s || s.inflight) return;
  s.inflight = true;
  try {
    // A page is at most LOG_PAGE lines: keep reading while a page comes back full, so the viewer, Copy and Download
    // hold the WHOLE log and not just its first page. (`done` is only trusted from the last, short page.)
    let res = await JobsClient.log(s.run.id, { afterSeq: s.lastSeq, limit: LOG_PAGE });
    for (;;) {
      if (_d !== s) return;
      if (res.lines.length) { s.lines = mergeLog(s.lines, res.lines); }
      s.lastSeq = Math.max(s.lastSeq, res.lastSeq, lastSeq(s.lines));
      if (res.lines.length < LOG_PAGE) break;
      res = await JobsClient.log(s.run.id, { afterSeq: s.lastSeq, limit: LOG_PAGE });
    }
    _paintLog();
    _updateLive();
    s.done = res.done;
    if (res.truncated && !s.run.log_truncated) { s.run = { ...s.run, log_truncated: true }; const note = _q('#jr-trunc'); if (note) note.hidden = false; }
    if (res.done || (res.status && res.status !== s.run.status)) {
      // The run changed state: re-read it so ended_at, summary and error show (the log page only carries status).
      s.run = await JobsClient.getRun(s.run.id).catch(() => ({ ...s.run, status: res.status ?? s.run.status }));
      if (_d !== s) return;
      _paintHead();
      _paintLog();
      void _loadProposal(s);
      s.onChanged?.();
    }
  } catch { /* transient: the next tick retries */ } finally { s.inflight = false; }
}

function _paintHead(): void {
  const s = _d;
  const head = _q('#jr-head');
  if (!s || !head) return;
  const admin = Session.isAdmin();
  head.innerHTML = _headerHtml(s.run, { canCancel: admin && isActiveRun(s.run.status), canRestart: admin && !isActiveRun(s.run.status), longer: s.longer() })
    + stepBarHtml(s.run) + tilesHtml(s.run);
  _updateLive();
}

/* ---------------------------------------------------------------------------
   Dry-run proposal
   ------------------------------------------------------------------------- */
export function proposalRowHtml(r: ProposalRow): string {
  const fin = (iso: string | null): string => (iso ? esc(Util.fmtDTShortPref(iso)) : '—');
  const delta = deltaText(r.deltaHours);
  return `<div class="job-prop-row${r.changedSince ? ' job-prop-stale' : ''}"><span class="job-mono" title="${esc(r.id)}">${esc(r.id)}</span><span class="job-mono">${esc(r.machine ?? '—')}</span>`
    + `<span class="job-mono">${fin(r.finishBefore)}</span><span class="job-mono">${fin(r.finishAfter)}</span>`
    + `<span class="job-mono">${esc(delta || '—')}</span><span>${esc(r.status ?? '—')}${r.changedSince ? ` <span class="job-sub">${esc(t('jobs.prop_changed'))}</span>` : ''}</span></div>`;
}

function _proposalShellHtml(): string {
  return `<section class="job-proposal" id="jr-proposal" aria-label="${esc(t('jobs.prop_title'))}">`
    + `<div class="job-banner" role="status">${esc(t('jobs.dry_run_banner'))}</div>`
    + `<div id="jr-prop-body" aria-busy="true"><div class="job-skel job-skel-row" aria-hidden="true"></div><div class="job-skel job-skel-row" aria-hidden="true"></div></div></section>`;
}

async function _loadProposal(s: DetailState): Promise<void> {
  const r = s.run;
  if (!isDryRun(r.summary) || (r.status !== 'succeeded' && r.status !== 'warning')) return;
  // The shell appears once the run has finished (a run opened while still going gets it on completion).
  if (!_q('#jr-proposal')) _q('#jr-head')?.insertAdjacentHTML('afterend', _proposalShellHtml());
  const host = _q('#jr-prop-body');
  if (!host) return;
  const my = ++s.proposal.seq;
  host.setAttribute('aria-busy', 'true');
  try {
    const p: Proposal = await JobsClient.proposal(r.id);
    if (_d !== s || my !== s.proposal.seq) return;
    host.setAttribute('aria-busy', 'false');
    if (p.pending) { host.innerHTML = `<div class="ape-hint">${esc(t('jobs.prop_pending'))}</div>`; return; }
    if (p.truncated) { host.innerHTML = `<div class="ape-hint">${esc(t('jobs.prop_truncated', { n: p.total }))}</div>`; return; }
    if (!p.rows.length) { host.innerHTML = `<div class="ape-hint">${esc(t('jobs.prop_empty'))}</div>`; return; }
    const head = [t('jobs.prop_order'), t('jobs.prop_machine'), t('jobs.prop_before'), t('jobs.prop_after'), t('jobs.prop_delta'), t('jobs.col_status')];
    host.innerHTML = `<div class="job-prop-note">${esc(t('jobs.prop_count', { shown: p.shown, total: p.total }))}`
      + (p.findings ? ` · ${esc(t('jobs.prop_findings', { n: p.findings }))}` : '') + `</div>`
      + (p.boardMatches === false ? `<div class="job-prop-warn" role="note">${esc(t('jobs.prop_board_changed'))}</div>` : '')
      + (p.boardMatches === true ? `<div class="ape-hint" role="note">${esc(t('jobs.prop_board_same'))}</div>` : '')
      + `<div class="ape-hint" role="note">${esc(t('jobs.prop_may_skip'))}</div>`
      + `<div class="job-prop-row job-prop-head" role="presentation">${head.map(h => `<span title="${esc(h)}">${esc(h)}</span>`).join('')}</div>`
      + `<div class="job-prop-list" id="jr-prop-list" tabindex="0" role="region" aria-label="${esc(t('jobs.prop_title'))}"></div>`;
    const list = _q('#jr-prop-list');
    if (!list) return;
    s.proposal.vl = new VirtualList<ProposalRow>(list, { rowH: PROPOSAL_ROW_H, renderFn: (row) => proposalRowHtml(row), buffer: 10 });
    s.proposal.vl.update(p.rows);
  } catch (e) {
    if (_d !== s || my !== s.proposal.seq) return;
    host.setAttribute('aria-busy', 'false');
    host.innerHTML = `<div class="job-run-error" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`
      + `<button type="button" class="btn btn-ghost sm" data-jr-act="retry-proposal">${esc(t('jobs.retry'))}</button>`;
  }
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

function _save(name: string, text: string): void {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _copy(text: string): void {
  navigator.clipboard?.writeText(text).then(() => Toast.show(t('jobs.log_copied'), 'success'), () => Toast.show(t('jobs.log_copy_failed'), 'error'));
}

export const JobsRunDetail = {
  show(host: HTMLElement, run: JobRun, opts: { onBack: () => void; onChanged?: () => void; onRestart?: (run: JobRun) => void; visible: () => boolean; longer?: () => boolean; tz?: string }): void {
    JobsRunDetail.stop();
    const s: DetailState = {
      host, run, lines: [], tz: opts.tz ?? '', lastSeq: 0, done: false, level: 'all', errorsOnly: false, q: '', follow: isActiveRun(run.status),
      wrap: false, open: new Set(), vl: null, timer: null, inflight: false, proposal: { vl: null, seq: 0 },
      onChanged: opts.onChanged ?? null, onRestart: opts.onRestart ?? null, visible: opts.visible, longer: opts.longer ?? (() => false),
    };
    _d = s;
    host.innerHTML = `<div id="jr-head"></div>${_toolbarHtml(s)}`
      + `<div class="job-log" id="jr-log" tabindex="0" role="log" aria-label="${esc(t('jobs.log'))}"></div>`
      + `<div class="job-log-empty" id="jr-empty">${esc(t('jobs.log_empty'))}</div>`
      + `<div class="ape-hint" id="jr-trunc"${run.log_truncated ? '' : ' hidden'}>${esc(t('jobs.log_truncated'))}</div>`;
    _paintHead();
    void _loadProposal(s);
    host.onclick = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      if (_d !== s) return;
      const dataBtn = tgt.closest<HTMLElement>('[data-jr-data]');
      if (dataBtn) {
        const seq = Number(dataBtn.dataset.jrData);
        if (s.open.has(seq)) s.open.delete(seq); else s.open.add(seq);
        _paintLog();
        return;
      }
      const act = tgt.closest<HTMLElement>('[data-jr-act]')?.dataset.jrAct;
      if (!act) return;
      if (act === 'back') { opts.onBack(); }
      else if (act === 'copy') _copy(logToText(_shown(s), x => Util.fmtDTPref(plantWall(x, s.tz))));
      else if (act === 'download') _save(`job-run-${s.run.id}.log`, logToText(s.lines, x => Util.fmtDTPref(plantWall(x, s.tz))));
      else if (act === 'copy-errors') _copy(errorsToText(s.lines, x => Util.fmtDTPref(plantWall(x, s.tz))));
      else if (act === 'download-errors') _save(`job-run-${s.run.id}-errors.log`, errorsToText(s.lines, x => Util.fmtDTPref(plantWall(x, s.tz))));
      else if (act === 'first-error') _jumpFirstError(s);
      else if (act === 'show-errors') {
        s.errorsOnly = true;
        const cb = _q<HTMLInputElement>('#jr-errors'); if (cb) cb.checked = true;
        _paintLog();
        _q('#jr-log')?.scrollIntoView?.({ block: 'nearest' });
      }
      else if (act === 'retry-proposal') void _loadProposal(s);
      else if (act === 'restart') {
        // Restart = run the job now with its CURRENT settings, so the confirm names its current mode (not the old run's).
        void JobsClient.jobParams(s.run.job_id).then(p => Modal.confirm({
          title: t('jobs.confirm_restart', { name: s.run.job_name }),
          message: t('jobs.confirm_restart_msg', { mode: t(String(p.apply_mode) === 'propose' ? 'jobs.result_propose' : 'jobs.result_apply') }),
          confirmLabel: t('jobs.restart'),
        })).then(ok => ok ? JobsClient.restartRun(s.run.id).then(nr => { Toast.show(t('jobs.toast_run_started', { name: nr.job_name }), 'success'); s.onRestart?.(nr); }) : undefined)
          .catch((err: Error) => Toast.show(t('jobs.toast_action_failed', { msg: err.message }), 'error'));
      }
      else if (act === 'cancel') {
        void JobsClient.cancelRun(s.run.id).then(() => { Toast.show(t('jobs.toast_cancel_requested'), 'success'); void _fetchLog(); opts.onChanged?.(); })
          .catch((err: Error) => Toast.show(err.message, 'error'));
      } else if (act === 'history') {
        (globalThis as unknown as { NIMBUS?: { App?: { goto?(tab: string): void } } }).NIMBUS?.App?.goto?.('gantt');
        Toast.show(t('jobs.history_hint', { id: String(s.run.summary?.action_id ?? '') }), 'info');
      }
    };
    host.onchange = (e: Event) => {
      const id = (e.target as HTMLElement).id;
      if (_d !== s) return;
      if (id === 'jr-level') { s.level = (e.target as HTMLSelectElement).value; _paintLog(); }
      else if (id === 'jr-errors') { s.errorsOnly = (e.target as HTMLInputElement).checked; _paintLog(); }
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
    void _fetchLog().then(() => {
      if (_d !== s) return;
      // A failed run opens with the error already in view: the errors-only filter would hide the context, so only jump.
      if (s.run.status === 'failed' && firstErrorIndex(s.lines) >= 0) s.follow = false;
      if (!s.done) s.timer = setTimeout(_tick, LOG_POLL_MS);
    });
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
