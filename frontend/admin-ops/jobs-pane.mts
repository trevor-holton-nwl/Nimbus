/* =============================================================================
   JOBS PANE — Admin > Jobs (#admin-jobs-pane): sub-tabs Jobs / Runs / Upcoming.

   Lifecycle (the DistributionPane / AlertMonitor shape): AdminCockpit._setSub('jobs') calls
   render() on every entry and setActive(false) on leave; init() wires the delegated handlers
   once. `_active` gates every timer: the Runs list polls every 15 s only while the Runs tab is
   showing and the document is visible; the open run's log polls itself (jobs-run-detail.mts).
   A health strip (GET /jobs/summary) sits above the three views: each tile filters the Runs list, and the
   whole pane polls every 30 s (15 s when a run started here is being watched) only while a run is active.

   Admin controls (New, Run now, Pause, Edit, Duplicate, Delete) exist only for admins;
   other Admin-page users read jobs, runs and logs for Session.allowedPlants() (server re-checks).
   Plant is a searchable combobox, never chips; the jobs table and the runs list are server-paginated
   by a before_id cursor (no total count: a Load more button while next_before_id is set). Times show
   on each row's plant wall clock. Module state only: no Store events.
   ========================================================================== */

import { Util, Toast, Modal } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import { OverflowMenu } from '../platform/overflow-menu.mjs';
import type { MenuItem } from '../platform/overflow-menu.mjs';
import { JobsClient } from './jobs-client.mjs';
import type { Job, JobRun, JobType } from './jobs-client.mjs';
import type { Batch, Timeline, TlRange, JobTemplate } from './jobs-model.mjs';
import { JobsDialog, mkCombobox, allowedPlantList, jobsDeps, plantTimezone } from './jobs-dialog.mjs';
import { JobsRunDetail, resultBadgeHtml, reportBadgeHtml } from './jobs-run-detail.mjs';
import {
  RUN_STATUSES, PERIODICITIES, JOBS_PAGE, runStatusHtml, recurrenceText, durationText, weekStrip, isoDayKey, addDays, plantWall, stripOffset,
  mergeRuns, stripCompleteThrough, healthTiles, heartbeatState, ageText, shouldPollJobs, runSequential, isActiveRun, isLongerThanUsual, tzShort,
  typeLabel, typeGroups, findType, isReportType, targetsLabel, batchTiles, statusBadgeHtml, statusLabel, BATCH_STATUSES, plural,
  TL_RANGES, TL_W, timelineWindow, timelineBars, timelineTicks, timelineRows, policyNoteText, statusBadgeClass,
  chainSummaryText, diffLines, stepFromWire, isChainKey, firstUnsafeStep,
} from './jobs-model.mjs';
import type { UpcomingRun, HealthSummary, RunsQuery } from './jobs-model.mjs';
import type { UpcomingEntry } from './jobs-client.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

export const RUNS_POLL_MS = 15000;
export const JOBS_POLL_MS = 30000;
export const IDLE_POLL_MS = 60000;
type SubTab = 'jobs' | 'runs' | 'upcoming' | 'templates';

let _wired = false;
let _active = false;
let _tab: SubTab = 'jobs';
let _plant = '';                 // '' = every plant the viewer may see
let _q = '';
let _status = '';                // jobs: last-run status filter
let _runStatus = '';             // runs: run status filter (set by the health tiles; separate from the Jobs tab's)
let _runType = '';               // runs: job type filter
let _jobPages = 1;               // pages of the jobs list loaded (the quiet poll merges instead of replacing when > 1)
let _bulkBusy = false;           // a bulk action is running: the bar is disabled and a second click is ignored
let _watchBusy = false;          // a _checkWatched pass is in flight
const _watchFails = new Map<number, number>();   // consecutive failed reads per watched run id
let _periodicity = '';           // runs: schedule kind (or manual)
let _scheduledBy = '';           // runs: '' | 'schedule' | the viewer's own email
let _since = 0;                  // runs: look-back window in hours (set by the Failed / Missed health tiles); 0 = none
let _health: HealthSummary | null = null;
let _selected = new Set<number>();   // jobs ticked for the bulk bar (loaded rows only)
const _watched = new Map<number, string>();   // run ids started from here -> job name: a completion toast when one ends
const _watchedBatches = new Map<number, string>();   // a fan-out is followed by its BATCH (every plant), not by its first child
let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _type = '';
let _types: JobType[] = [];
let _templates: JobTemplate[] = [];
let _tplSeq = 0;                 // _loadTemplates: only the newest response may replace the list
let _tplArchived = false;        // templates tab: also list archived ones
let _jobs: Job[] = [];
let _nextBeforeJob: number | null = null;
let _runs: JobRun[] = [];
let _nextBefore: number | null = null;
let _runPages = 1;               // pages of the runs list loaded (the poll merges instead of replacing when > 1)
let _runView: 'runs' | 'batches' | 'timeline' = 'runs';   // Runs tab: every child run as one flat list, one row per fan-out batch, or the lanes timeline
let _tlRange: TlRange = '24h';
let _tlListOpen = false;         // the timeline's "list" <details> stays open across the 15 s repaints
let _tlOffset = 0;               // first plant lane of the page (the server pages the lanes by plant)
let _tlSeq = 0;                  // the newest timeline request wins
let _batchStatus = '';           // batches view: rollup status filter
let _batches: Batch[] = [];
let _nextBeforeBatch: number | null = null;
/** Batches opened in the list: their child runs (null while loading) or the load error. */
const _openBatches = new Map<number, { runs: JobRun[] | null; error?: string; hasMore?: boolean; more?: boolean }>();
const _kidsSig = new Map<number, string>();         // last painted kids markup per batch (an unchanged poll leaves the DOM alone)
const BATCH_KIDS_PAGE = 200;
let _upcomingRequested = 20;
let _upcoming: UpcomingRun[] = [];
let _stripPlant = '';
let _runsTimer: ReturnType<typeof setTimeout> | null = null;
let _seq = 0;                    // guards every async fetch against a newer one
let _qTimer: ReturnType<typeof setTimeout> | null = null;

const _el = <E extends HTMLElement = HTMLElement>(id: string): E | null => document.getElementById(id) as E | null;
const _isAdmin = (): boolean => Session.isAdmin();
/** A tz-aware instant (or a naive plant-local value) in the viewer's date/time format, on the plant's wall clock. */
const _fmt = (iso: string | null | undefined, plant?: string): string => {
  if (!iso) return '—';
  const tz = plant ? plantTimezone(plant) : '';
  const z = tzShort(tz, iso);
  return `${Util.fmtDTPref(plantWall(iso, tz))}${z ? ` ${z}` : ''}`;
};
const _visible = (): boolean => _active && !document.hidden && !!_el('admin-tab')?.classList.contains('active');

/** Loading placeholder rows that keep a table row's height (aria-busy on the host says it is loading). */
const _skeletonHtml = (rows = 5): string => Array.from({ length: rows }, () => '<div class="job-skel job-skel-row" aria-hidden="true"></div>').join('');
const _errorHtml = (e: Error): string => `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: e.message }))} `
  + `<button type="button" class="btn btn-ghost sm" data-jobs-act="retry">${esc(t('jobs.retry'))}</button></div>`;
function _busy(host: HTMLElement, on: boolean): void { host.setAttribute('aria-busy', on ? 'true' : 'false'); }

/** Paint a list host, skipping the write when the markup is unchanged (a poll that found nothing new must not
 *  rebuild the table: it would drop focus, text selection and scroll anchoring). */
const _painted = new WeakMap<HTMLElement, string>();
const _FOCUS_ATTRS = ['data-jobs-batch', 'data-jobs-batch-open', 'data-jobs-batch-restart', 'data-jobs-batch-cancel', 'data-jobs-batch-more',
  'data-jobs-menu', 'data-jobs-sel', 'data-run-id', 'data-jobs-act', 'data-tl-key'];
/** A selector that finds the control that has focus again after a repaint (null when nothing in the host is focused). */
function _focusSelector(host: HTMLElement): string | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !host.contains(a)) return null;
  if (a.id) return `#${a.id}`;
  for (const attr of _FOCUS_ATTRS) {
    const v = a.getAttribute(attr);
    if (v !== null) return `${a.tagName.toLowerCase()}[${attr}="${v}"]`;
  }
  return null;
}
function _setHtml(host: HTMLElement, html: string): void {
  if (_painted.get(host) === html) return;
  _painted.set(host, html);
  const sel = _focusSelector(host);
  const top = host.scrollTop;
  host.innerHTML = html;
  if (host.scrollTop !== top) host.scrollTop = top;
  if (sel) { try { host.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true }); } catch { /* an odd id: leave focus alone */ } }
}

/** One small polite status node announces list loads; the list hosts themselves are not live regions, so a quiet
 *  poll repaint is not read out in full. */
let _announced = '';
function _announce(msg: string, id = 'jobs-live'): void {
  const n = _el(id);
  if (!n || msg === _announced) return;
  _announced = msg;
  n.textContent = msg;
}

/* ---------------------------------------------------------------------------
   Shared filter bar
   ------------------------------------------------------------------------- */
// The three sub-views stay in the DOM side by side (only `hidden` toggles), so every control id is per view:
// jobs-*, jobs-runs-*, jobs-up-*. A shared id would make getElementById answer with the first (hidden) copy.
function _plantFilterHtml(prefix: string): string {
  return `<div class="job-field job-plant-field"><span class="job-field-l">${esc(t('jobs.f_plant'))}</span><div id="${prefix}-plant-host"></div></div>`;
}

function _mountPlantCombo(prefix: string, onChange: () => void): void {
  mkCombobox(_el(`${prefix}-plant-host`), allowedPlantList(), {
    value: _plant, placeholder: t('jobs.all_plants'), id: `${prefix}-plant`,
    onSelect: (v) => { _plant = v; onChange(); },
  });
}

function _statusOptions(sel: string): string {
  return `<option value="">${esc(t('jobs.status_any'))}</option>`
    + RUN_STATUSES.map(s => `<option value="${s}"${s === sel ? ' selected' : ''}>${esc(t(`jobs.status_${s}`))}</option>`).join('');
}

/* ---------------------------------------------------------------------------
   Health strip (above the three views)
   ------------------------------------------------------------------------- */
function _healthHtml(h: HealthSummary): string {
  const tiles = healthTiles(h).map(x => {
    const label = esc(t(`jobs.health_${x.key}`));
    const next = h.nextFire;
    // The Failed tile's detail line also splits the count by cause (fix the job / system / the board changed).
    const detail = x.key === 'next'
      ? (next ? `${next.jobName} · ${next.plant} · ${tzShort(plantTimezone(next.plant), next.atUtc)}` : t('jobs.health_next_none'))
      : x.key === 'failed' ? `${t('jobs.health_24h')}${h.failed24h > 0 ? ` · ${t('jobs.health_failed_split', { config: h.failedConfig24h, system: h.failedSystem24h, transient: h.failedTransient24h })}` : ''}${h.failedBatches24h > 0 ? ` · ${plural('jobs.health_failed_batches', h.failedBatches24h, jobsDeps())}` : ''}`
      : x.key === 'missed' ? t('jobs.health_24h') : '';
    const v = x.key === 'next'
      ? `<div class="v job-kpi-text">${next ? esc(Util.fmtDTShortPref(stripOffset(next.atLocal))) : '—'}</div><div class="d" title="${esc(detail)}">${esc(detail)}</div>`
      : `<div class="v">${esc(x.value)}</div>${detail ? `<div class="d" title="${esc(detail)}">${esc(detail)}</div>` : ''}`;
    return `<button type="button" class="kpi-tile is-actionable${x.tone ? ` ${x.tone}` : ''}" data-jobs-tile="${x.key}" title="${esc(`${t(`jobs.health_${x.key}`)}${detail ? ` — ${detail}` : ''}`)}"><div class="k">${label}</div>${v}</button>`;
  }).join('');
  const hb = heartbeatState(h.scheduler, Date.now());
  const hbText = hb.state === 'ok' ? t('jobs.hb_ok', { age: ageText(hb.ageS) })
    : hb.state === 'stale' ? t('jobs.hb_stale', { age: ageText(hb.ageS) }) : t('jobs.hb_none');
  return `<div class="job-health-tiles">${tiles}</div>`
    + `<div class="job-heartbeat" role="status"><span class="badge ${hb.state === 'ok' ? 'badge-ok' : 'badge-warn'}">${esc(hbText)}</span>`
    + (h.warning24h ? ` <span class="job-sub">${esc(t('jobs.health_warn24', { n: h.warning24h }))}</span>` : '') + `</div>`;
}

let _healthSeq = 0;              // the newest summary request wins; a slower older one is dropped
let _healthSig = '';             // last painted summary: an unchanged poll does not repaint (keeps text selection / focus)
const _healthSkeletonHtml = (): string => `<div class="job-health-tiles" aria-hidden="true">${Array.from({ length: 5 }, () => '<div class="job-skel job-skel-row"></div>').join('')}</div>`;

async function _loadHealth(): Promise<void> {
  const host = _el('jobs-health');
  if (!host) return;
  const my = ++_healthSeq;
  if (!_health) { host.innerHTML = _healthSkeletonHtml(); _healthSig = ''; host.setAttribute('aria-busy', 'true'); }
  try {
    const h = await JobsClient.summary(_plant);
    if (my !== _healthSeq) return;
    _health = h;
    _renderMaint(h.maintenance);
    // The heartbeat age is computed from the clock, so the minute bucket is part of the signature.
    const sig = `${JSON.stringify(h)}|${Math.floor(Date.now() / 60000)}`;
    if (sig !== _healthSig) { host.innerHTML = _healthHtml(h); _healthSig = sig; }
    host.setAttribute('aria-label', t('jobs.health_label'));
    host.setAttribute('aria-busy', 'false');
  } catch (e) {
    if (my !== _healthSeq) return;
    host.setAttribute('aria-busy', 'false');
    if (!_health) {
      host.innerHTML = `<div class="job-sub" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))} `
        + `<button type="button" class="btn btn-ghost sm" data-jobs-act="retry-health">${esc(t('jobs.retry'))}</button></div>`;
    }
  }
}

/** A tile applies its filter to the Runs list (Failed / Missed also limit to the last 24 h); Next fire opens Upcoming.
 *  The Runs tab keeps its own status filter, so a tile never leaks into the Jobs tab's Last run filter. */
function _tileClick(key: string): void {
  const tile = healthTiles(_health ?? { running: 0, queued: 0, failed24h: 0, missed24h: 0, warning24h: 0, failedConfig24h: 0, failedSystem24h: 0, failedTransient24h: 0, failedBatches24h: 0, nextFire: null, scheduler: { ok: false, lastTickAt: null }, longerThanUsual: [] }).find(x => x.key === key);
  if (!tile) return;
  if (tile.tab === 'upcoming') { _stripPlant = _plant; _setTab('upcoming'); return; }
  _runStatus = tile.status ?? ''; _since = tile.sinceHours ?? 0; _periodicity = ''; _scheduledBy = ''; _runType = '';
  _runView = 'runs';                    // the tiles count plant runs, so they open the flat Runs list (never a stale Batches view)
  _setTab('runs');
}

/* ---------------------------------------------------------------------------
   Poll: every 30 s while a run is active (15 s while one started here is watched); never while hidden
   ------------------------------------------------------------------------- */
/** The single owner of the health strip and watcher polling (the Runs timer only refreshes the runs list):
 *  15 s while a run started here is watched, 30 s while anything is running, else 60 s so the heartbeat badge and
 *  next fire never freeze on an idle pane. */
function _armPoll(): void {
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = null;
  if (!_visible()) return;
  const ms = _watched.size || _watchedBatches.size ? RUNS_POLL_MS : shouldPollJobs(_health, _jobs) ? JOBS_POLL_MS : IDLE_POLL_MS;
  _pollTimer = setTimeout(() => { _pollTimer = null; void _pollTick(); }, ms);
}

async function _pollTick(): Promise<void> {
  if (!_visible()) return;
  await _loadHealth();
  void _checkWatched();
  if (_tab === 'jobs') void _loadJobs(false, true);
  _armPoll();
}

const WATCH_MAX_FAILS = 5;

/** A run started from here that has finished raises one toast with a View action. A run that is gone (404) or
 *  unreadable five polls in a row is dropped, so the watcher cannot poll it forever. */
async function _checkWatched(): Promise<void> {
  if (_watchBusy) return;
  _watchBusy = true;
  try { await _checkWatchedOnce(); } finally { _watchBusy = false; }
}

async function _checkWatchedOnce(): Promise<void> {
  for (const [id, name] of [..._watchedBatches]) {
    try {
      const { batch: b } = await JobsClient.batch(id, { limit: 1 });
      _watchFails.delete(-id);
      if (b.status === 'running') continue;
      _watchedBatches.delete(id);
      Toast.show(t('jobs.toast_run_done', { name, status: t(`jobs.status_${b.status}`) }), b.status === 'failed' ? 'error' : b.status === 'warning' ? 'warn' : 'success', 8000,
        { label: t('jobs.view'), run: () => { _plant = ''; _runStatus = ''; _since = 0; _periodicity = ''; _scheduledBy = ''; _runType = ''; _setTab('runs'); void _openBatchFromRun(id); } });
    } catch (e) {
      const n = (_watchFails.get(-id) ?? 0) + 1;
      if (/not found|404/i.test((e as Error).message) || n >= WATCH_MAX_FAILS) { _watchedBatches.delete(id); _watchFails.delete(-id); }
      else _watchFails.set(-id, n);
    }
  }
  for (const [id, name] of [..._watched]) {
    try {
      const r = await JobsClient.getRun(id);
      _watchFails.delete(id);
      if (isActiveRun(r.status)) continue;
      _watched.delete(id);
      const failed = r.status === 'failed';
      Toast.show(t('jobs.toast_run_done', { name, status: t(`jobs.status_${r.status}`) }), failed ? 'error' : r.status === 'warning' ? 'warn' : 'success', 8000,
        { label: t('jobs.view'), run: () => { _plant = r.plant; _runStatus = ''; _since = 0; _periodicity = ''; _scheduledBy = ''; _runType = ''; _runView = 'runs'; _setTab('runs'); void _openRun(id); } });
    } catch (e) {
      const n = (_watchFails.get(id) ?? 0) + 1;
      if (/not found|404/i.test((e as Error).message) || n >= WATCH_MAX_FAILS) { _watched.delete(id); _watchFails.delete(id); }
      else _watchFails.set(id, n);
    }
  }
}

/* ---------------------------------------------------------------------------
   Jobs sub-tab
   ------------------------------------------------------------------------- */
/** The type filter's options, grouped Optimization | Reports (every registered type is listed). */
function _typeOptionsHtml(selected: string): string {
  const d = jobsDeps();
  return typeGroups(_types).map(g => `<optgroup label="${esc(t(g.labelKey))}">`
    + g.types.map(x => `<option value="${esc(x.key)}"${x.key === selected ? ' selected' : ''}>${esc(typeLabel(x, d))}</option>`).join('') + `</optgroup>`).join('');
}

const _isReport = (jobType: string): boolean => isReportType(jobType, _types);

/** New job: the dialog renders its params from the served types, so load them first when the first load failed. */
async function _openNew(templateId?: number): Promise<void> {
  if (!_types.length) { try { _types = await JobsClient.types(); } catch { /* the dialog opens with the type unnamed */ } }
  await _loadTemplates();
  JobsDialog.open({ plant: _plant, types: _types, templates: _templates, templateId, jobType: templateId != null ? 'chain' : undefined, onSaved: () => void _loadJobs() });
}

/** Admins read the templates (the dialog's picker, the Templates tab); a failed load just leaves the list as it was. */
async function _loadTemplates(): Promise<void> {
  if (!_isAdmin()) return;
  const seq = ++_tplSeq;
  try {
    const list = await JobsClient.templates(_tplArchived);
    if (seq === _tplSeq) _templates = list;         // a slower, older response never overwrites a newer one
  } catch { /* keep the last list */ }
}

/** Under a job's name: the Result badge and search time for an optimizer job, the Report badge and type for a report. */
function _jobSubHtml(j: Job): string {
  const meta = findType(_types, j.job_type);
  // A report whose type metadata failed to load is still a report (no Apply badge on it).
  if (isReportType(j.job_type, _types)) return `${reportBadgeHtml()} ${esc(meta ? typeLabel(meta, jobsDeps()) : j.job_type)}`;
  if (isChainKey(j.job_type)) {                       // a chain: its steps in one line, and a note when its template moved on
    const steps = Array.isArray(j.params.steps) ? (j.params.steps as Array<Record<string, unknown>>).map(stepFromWire) : [];
    const tpl = j.template;
    return `<span class="badge badge-info job-kind">${esc(t('jobs.kind_chain'))}</span> ${esc(chainSummaryText(steps, _types, jobsDeps()))}`
      + (tpl?.editedLocally ? ` <span class="badge badge-muted job-tpl-edited">${esc(t('jobs.tpl_edited_locally'))}</span>` : '')
      + (tpl?.changed && _isAdmin() ? ` <button type="button" class="btn btn-ghost sm job-tpl-changed" data-jobs-act="tpl-update" data-job-id="${j.id}">${esc(t('jobs.tpl_changed', { name: tpl.name }))}</button>`
        : tpl?.changed ? ` <span class="badge badge-warn">${esc(t('jobs.tpl_changed_badge'))}</span>` : '');
  }
  const search = j.params.search ? esc(j.params.search === 'normal' ? t('jobs.search_normal') : t('jobs.search_exhaustive')) : '';
  return `${resultBadgeHtml({ summary: { apply_mode: String(j.params.apply_mode ?? 'apply') } })} ${search}`;
}

function _jobsToolbarHtml(): string {
  return `<div class="job-toolbar">${_plantFilterHtml('jobs')}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-type">${esc(t('jobs.f_type'))}</label><select class="input" id="jobs-type"><option value="">${esc(t('jobs.type_any'))}</option>`
    + _typeOptionsHtml(_type) + `</select></div>`
    + `<div class="job-field"><label class="job-field-l" for="jobs-status">${esc(t('jobs.f_last_run'))}</label><select class="input" id="jobs-status">${_statusOptions(_status)}</select></div>`
    + `<div class="job-field job-grow"><label class="job-field-l" for="jobs-q">${esc(t('jobs.search'))}</label><input class="input" id="jobs-q" type="search" value="${esc(_q)}" placeholder="${esc(t('jobs.search_ph'))}" autocomplete="off"></div>`
    + (_isAdmin() ? `<button type="button" class="btn btn-primary" data-jobs-act="new">${esc(t('jobs.new'))}</button>` : '')
    + `</div>`;
}

function _jobRowHtml(j: Job): string {
  const d = jobsDeps();
  const lr = j.last_run;
  const paused = !j.enabled || j.schedule?.paused;
  const next = paused ? `<span class="badge badge-muted">${esc(t('jobs.paused'))}</span>` : esc(j.next_run_local ? `${Util.fmtDTPref(stripOffset(j.next_run_local))} ${tzShort(plantTimezone(j.plant), j.next_run_at)}`.trim() : '—');
  const admin = _isAdmin();
  return `<tr data-job-id="${j.id}">`
    + (admin ? `<td class="job-sel"><input type="checkbox" data-jobs-sel="${j.id}" aria-label="${esc(t('jobs.sel_row', { name: j.name }))}"${_selected.has(j.id) ? ' checked' : ''}></td>` : '')
    + `<td class="job-name"><button type="button" class="job-link" data-jobs-act="runs-of" data-job-id="${j.id}">${esc(j.name)}</button>`
    + `<div class="job-sub">${_jobSubHtml(j)}</div></td>`
    + `<td class="job-mono">${esc(j.plant)}</td>`
    + `<td class="job-targets-cell">${esc(targetsLabel(j, d))}${j.targetSkipped ? ` <span class="badge badge-warn">${esc(t('jobs.targets_skipped', { n: j.targetSkipped }))}</span>` : ''}</td>`
    + `<td class="job-col-recur">${esc(recurrenceText(j.schedule, d, x => _fmt(x, j.plant)))}</td>`
    + `<td class="job-mono">${next}</td>`
    + `<td>${j.lastBatch ? `<span title="${esc(t('jobs.lb_title', { id: j.lastBatch.id }))}">${statusBadgeHtml(j.lastBatch.status, d)} <span class="job-sub">${esc(t('jobs.lb_counts', { ok: (j.lastBatch.counts.succeeded ?? 0), total: (j.lastBatch.counts.total ?? 0) }))}</span></span>` : lr ? `${runStatusHtml(lr, d)} <span class="job-sub job-mono">${esc(_fmt(lr.ended_at ?? lr.started_at ?? lr.scheduled_for, j.plant))}</span>` : `<span class="job-sub">${esc(t('jobs.never_run'))}</span>`}</td>`
    + `<td class="job-actions"><button type="button" class="icon-btn sm" data-jobs-menu="${j.id}" data-ovf-key="job-${j.id}" aria-haspopup="menu" aria-label="${esc(t('jobs.row_actions'))}">⋯</button></td></tr>`;
}

function _bulkBarHtml(): string {
  const n = _selected.size;
  return `<div class="job-bulk" id="jobs-bulk" role="toolbar" aria-label="${esc(t('jobs.bulk'))}"${n ? '' : ' hidden'}>`
    + `<span class="job-bulk-n" id="jobs-bulk-n">${esc(t('jobs.bulk_selected', { n }))}</span>`
    + ['run', 'pause', 'resume', 'archive'].map(a => `<button type="button" class="btn btn-ghost sm" data-jobs-bulk="${a}">${esc(t(`jobs.bulk_${a}`))}</button>`).join('')
    + `<button type="button" class="btn btn-ghost sm" data-jobs-bulk="clear">${esc(t('jobs.bulk_clear'))}</button></div>`;
}

function _syncBulk(): void {
  const bar = _el('jobs-bulk'); const n = _el('jobs-bulk-n');
  if (bar) bar.hidden = !_selected.size;
  if (n) n.textContent = t('jobs.bulk_selected', { n: _selected.size });
  const all = _el<HTMLInputElement>('jobs-sel-all');
  if (all) all.checked = _jobs.length > 0 && _jobs.every(j => _selected.has(j.id));
}

function _jobsTableHtml(): string {
  if (!_jobs.length) return `<div class="empty-state job-empty">${esc(_plant || _q || _status || _type ? t('jobs.empty_filtered') : t('jobs.empty'))}</div>`;
  const admin = _isAdmin();
  return (admin ? _bulkBarHtml() : '') + `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + (admin ? `<th scope="col" class="job-sel"><input type="checkbox" id="jobs-sel-all" aria-label="${esc(t('jobs.sel_all'))}"></th>` : '')
    + [t('jobs.col_name'), t('jobs.col_plant'), t('jobs.col_targets'), t('jobs.col_recurrence'), t('jobs.col_next'), t('jobs.col_last'), ''].map((h, i) => `<th scope="col"${i === 3 ? ' class="job-col-recur"' : ''}>${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_jobs.map(_jobRowHtml).join('')}</tbody></table></div>`
    + (_nextBeforeJob != null ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-act="more-jobs">${esc(t('jobs.load_more'))}</button></div>` : '');
}

/** `quiet` (the poll) swaps the rows in without the loading skeleton. */
async function _loadJobs(append = false, quiet = false): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-table');
  if (!host) return;
  if (!append && !quiet) { _busy(host, true); _setHtml(host, _skeletonHtml()); }
  try {
    const res = await JobsClient.list({ plant: _plant, q: _q, status: _status, type: _type, limit: JOBS_PAGE, beforeId: append ? _nextBeforeJob : null });
    if (my !== _seq) return;
    if (append) { _jobs = [...(_jobs), ...res.items.filter(x => !_jobs.some(y => y.id === x.id))]; _nextBeforeJob = res.nextBeforeId; _jobPages++; }
    else if (quiet && _jobPages > 1) {
      // The poll re-read page 1 only: fold it into what is loaded (later pages, their cursor and the ticked rows stay).
      _jobs = mergeRuns(_jobs, res.items);
    } else { _jobs = res.items; _nextBeforeJob = res.nextBeforeId; _jobPages = 1; _selected = new Set([..._selected].filter(id => _jobs.some(j => j.id === id))); }
    _setHtml(host, _jobsTableHtml());
    _busy(host, false);
    _announce(t('jobs.count_jobs', { n: _jobs.length }));
    _syncBulk();
    _armPoll();
  } catch (e) {
    if (my === _seq) { _setHtml(host, _errorHtml(e as Error)); _busy(host, false); }
  }
}

function _renderJobsTab(): void {
  const host = _el('jobs-view-jobs');
  if (!host) return;
  host.innerHTML = `${_jobsToolbarHtml()}<div id="jobs-table"></div><span class="job-sr" id="jobs-live" role="status" aria-live="polite"></span>`;
  _announced = '';
  _mountPlantCombo('jobs', () => { void _loadJobs(); void _loadHealth(); });
  void _loadJobs();
}

function _menuItems(j: Job): MenuItem[] {
  const paused = !j.enabled;
  const admin = _isAdmin();
  const items: MenuItem[] = [
    { id: 'runs', label: t('jobs.m_runs'), onSelect: () => _gotoRuns(j) },
    { id: 'upcoming', label: t('jobs.m_upcoming'), onSelect: () => { _stripPlant = j.plant; _setTab('upcoming'); } },
  ];
  if (admin) {
    items.push(
      { id: 'run', label: t('jobs.m_run_now'), disabled: paused, hint: paused ? t('jobs.m_paused_hint') : undefined, onSelect: () => void _runNow(j) },
      { id: 'restart', label: j.lastBatch ? t('jobs.restart_batch') : t('jobs.m_restart'), disabled: !j.last_run || paused, hint: !j.last_run ? t('jobs.m_restart_none') : undefined,
        onSelect: () => void (j.lastBatch ? _restartBatch(j.lastBatch.id) : _restartLast(j)) },
      { id: 'pause', label: paused ? t('jobs.m_resume') : t('jobs.m_pause'), onSelect: () => void _setEnabled(j, paused) },
      { id: 'edit', label: t('jobs.m_edit'), onSelect: () => JobsDialog.open({ job: j, types: _types, templates: _templates, onSaved: () => void _loadJobs() }) },
      { id: 'dup', label: t('jobs.m_duplicate'), onSelect: () => JobsDialog.open({ job: j, duplicate: true, types: _types, templates: _templates, onSaved: () => void _loadJobs() }) },
      { id: 'del', label: t('jobs.m_delete'), danger: true, onSelect: () => void _delete(j) },
    );
  }
  return items;
}

function _watch(r: JobRun, name: string): void {
  if (r.batchId != null) _watchedBatches.set(r.batchId, name); else _watched.set(r.id, name);
  _armPoll();
}
async function _runNow(j: Job): Promise<void> {
  try { const r = await JobsClient.runNow(j.id); _watch(r, j.name); Toast.show(t('jobs.toast_run_started', { name: j.name }), 'success'); void _loadJobs(false, true); void _loadHealth(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}
/** Restart = run the job again with its current params (a new manual run; the old run stays as it was). */
async function _restartLast(j: Job): Promise<void> {
  if (!j.last_run) return;
  // Restart runs the job NOW with its current settings, so the confirm names the job's current mode.
  const mode = t(String(j.params.apply_mode ?? 'apply') === 'propose' ? 'jobs.result_propose' : 'jobs.result_apply');
  // A chain with a step that is not safe to repeat (a purge) gets the stronger warning and the server's confirm flag.
  const unsafe = isChainKey(j.job_type) && Array.isArray(j.params.steps)
    ? firstUnsafeStep((j.params.steps as Array<Record<string, unknown>>).map(stepFromWire), _types, jobsDeps()) : null;
  if (!await Modal.confirm(unsafe
    ? { title: t('jobs.confirm_restart', { name: j.name }), message: t('jobs.confirm_restart_unsafe', { step: unsafe }), confirmLabel: t('jobs.restart'), tone: 'warn' }
    : { title: t('jobs.confirm_restart', { name: j.name }), message: t('jobs.confirm_restart_msg', { mode }), confirmLabel: t('jobs.restart') })) return;
  try { const r = await JobsClient.restartRun(j.last_run.id, { confirm: unsafe != null }); _watch(r, j.name); Toast.show(t('jobs.toast_run_started', { name: j.name }), 'success'); void _loadJobs(false, true); void _loadHealth(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

/** Bulk bar over the ticked rows: sequential requests, one summary toast. Archive asks first. */
async function _bulk(action: string): Promise<void> {
  if (_bulkBusy) return;                              // re-entrancy guard: one bulk action at a time
  if (action === 'clear') { _selected.clear(); _jobsRerender(); return; }
  const rows = _jobs.filter(j => _selected.has(j.id));
  if (!rows.length) return;
  _bulkBusy = true;
  _setBulkDisabled(true);
  try {
    if (action === 'archive') {
      const ok = await Modal.confirm({ title: t('jobs.bulk_confirm_archive', { n: rows.length }), message: t('jobs.confirm_delete_msg'), confirmLabel: t('jobs.m_delete'), tone: 'danger' });
      if (!ok) return;
    }
    const res = await runSequential(rows, async (j) => {
      if (action === 'run') { const r = await JobsClient.runNow(j.id); _watch(r, j.name); }
      else if (action === 'pause') await JobsClient.setEnabled(j.id, false);
      else if (action === 'resume') await JobsClient.setEnabled(j.id, true);
      else if (action === 'archive') await JobsClient.remove(j.id);
    });
    Toast.show(res.failed ? t('jobs.bulk_done_partial', { ok: res.ok, failed: res.failed, reason: res.firstError }) : t('jobs.bulk_done', { n: res.ok }), res.failed ? 'warn' : 'success');
    _selected.clear();
    void _loadJobs(false, true); void _loadHealth();
  } finally {
    _bulkBusy = false;
    _setBulkDisabled(false);
  }
}
function _setBulkDisabled(on: boolean): void {
  _el('jobs-bulk')?.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = on; });
  _el('jobs-bulk')?.setAttribute('aria-busy', on ? 'true' : 'false');
}
function _jobsRerender(): void {
  const host = _el('jobs-table');
  if (host) { _setHtml(host, _jobsTableHtml()); _syncBulk(); }
}
/** "Template changed, update?": show the step diff, then replace the job's copy of its steps (runs under way keep theirs). */
async function _templateUpdate(j: Job): Promise<void> {
  try {
    const d = await JobsClient.templateDiff(j.id);
    const lines = diffLines(d.diff, _types, jobsDeps());
    const ok = await Modal.confirm({ title: t('jobs.tpl_update_title', { name: j.name }), message: t('jobs.tpl_update_msg', { tpl: d.template.name }),
      detail: lines.length ? lines.join('\n') : t('jobs.tpl_no_diff'), confirmLabel: t('jobs.tpl_update_btn') });
    if (!ok) return;
    const res = await JobsClient.updateFromTemplate(j.id);
    Toast.show(t('jobs.tpl_updated'), 'success');
    // A plant whose per-plant override replaces the steps keeps its own steps: say so rather than let it look updated.
    if (res.overriddenPlants.length) Toast.show(t('jobs.tpl_overridden_note', { plants: res.overriddenPlants.slice(0, 6).join(', ') + (res.overriddenPlants.length > 6 ? ', ...' : '') }), 'info');
    void _loadJobs();
  } catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

/* ---------------------------------------------------------------------------
   Templates sub-tab (admin): the reusable step lists. New job from one, archive / restore. A template's steps are edited
   from a job made from it (its dialog's "Update the template with these steps").
   ------------------------------------------------------------------------- */
function _templatesHtml(): string {
  const d = jobsDeps();
  const rows = _templates.map(x => `<tr data-tpl-id="${x.id}"><td class="job-name">${esc(x.name)}${x.archived ? ` <span class="badge badge-muted">${esc(t('jobs.tpl_archived'))}</span>` : ''}`
    + (x.description ? `<div class="job-sub">${esc(x.description)}</div>` : '') + `</td>`
    + `<td>${esc(chainSummaryText(x.steps.map(stepFromWire), _types, d, 4))}</td>`
    + `<td class="job-mono">v${x.version}</td><td class="job-mono">${esc(x.modifiedAt ? Util.fmtDTPref(stripOffset(x.modifiedAt)) : '—')}</td>`
    + `<td class="job-actions">${x.archived ? '' : `<button type="button" class="btn btn-ghost sm" data-jobs-act="tpl-new" data-tpl-id="${x.id}">${esc(t('jobs.tpl_new_job'))}</button>`}`
    + `<button type="button" class="btn btn-ghost sm" data-jobs-act="tpl-archive" data-tpl-id="${x.id}">${esc(t(x.archived ? 'jobs.tpl_restore' : 'jobs.tpl_archive'))}</button></td></tr>`).join('');
  return `<div class="job-toolbar"><label class="chk-inline"><input type="checkbox" id="jobs-tpl-archived"${_tplArchived ? ' checked' : ''}><span>${esc(t('jobs.tpl_show_archived'))}</span></label></div>`
    + (_templates.length
      ? `<div class="job-table-wrap"><table class="job-table"><thead><tr><th>${esc(t('jobs.col_name'))}</th><th>${esc(t('jobs.tpl_col_steps'))}</th><th>${esc(t('jobs.tpl_col_version'))}</th><th>${esc(t('jobs.tpl_col_modified'))}</th><th><span class="job-sr">${esc(t('jobs.row_actions'))}</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty-state job-empty">${esc(t('jobs.tpl_empty'))}</div>`);
}

function _renderTemplatesTab(): void {
  const host = _el('jobs-view-templates');
  if (!host) return;
  host.innerHTML = `<div id="jobs-tpl-body" aria-busy="true">${_skeletonHtml(3)}</div>`;
  void _loadTemplates().then(() => {
    const body = _el('jobs-tpl-body');
    if (!body || _tab !== 'templates') return;
    body.setAttribute('aria-busy', 'false');
    body.innerHTML = _templatesHtml();
  });
}

async function _archiveTemplate(id: number): Promise<void> {
  const x = _templates.find(q => q.id === id);
  if (!x) return;
  try { await JobsClient.updateTemplate(id, { archived: !x.archived }); _renderTemplatesTab(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

async function _setEnabled(j: Job, enabled: boolean): Promise<void> {
  try { await JobsClient.setEnabled(j.id, enabled); void _loadJobs(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}
async function _delete(j: Job): Promise<void> {
  const ok = await Modal.confirm({ title: t('jobs.confirm_delete', { name: j.name }), message: t('jobs.confirm_delete_msg'), confirmLabel: t('jobs.m_delete'), tone: 'danger' });
  if (!ok) return;
  try { await JobsClient.remove(j.id); Toast.show(t('jobs.toast_deleted'), 'success'); void _loadJobs(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

/* ---------------------------------------------------------------------------
   Runs sub-tab
   ------------------------------------------------------------------------- */
function _runRowHtml(r: JobRun): string {
  const d = jobsDeps();
  const longer = isLongerThanUsual(r.id, _health?.longerThanUsual) ? ` <span class="badge badge-warn job-longer">${esc(t('jobs.longer_than_usual'))}</span>` : '';
  const batch = r.batchId ? ` <button type="button" class="badge badge-muted job-batch-link" data-jobs-batch-open="${r.batchId}" aria-label="${esc(t('jobs.batch_open', { id: r.batchId }))}">${esc(t('jobs.batch_badge', { id: r.batchId }))}</button>` : '';
  return `<tr class="job-run-row" data-run-id="${r.id}" tabindex="0"><td class="job-name">${esc(r.job_name)}${batch}</td><td class="job-mono">${esc(r.plant)}</td>`
    + `<td>${runStatusHtml(r, d)}${longer}</td><td>${resultBadgeHtml(r) || (_isReport(r.job_type) ? reportBadgeHtml() : '')}</td><td class="job-mono">${esc(_fmt(r.scheduled_for ?? r.started_at, r.plant))}</td>`
    + `<td class="job-mono">${esc(durationText(r.duration_ms) || '—')}</td>`
    + `<td>${esc(r.trigger ? t(`jobs.trigger_${r.trigger}`) : '')}${r.triggered_by && r.triggered_by !== 'schedule' ? ` <span class="job-sub">${esc(r.triggered_by)}</span>` : ''}</td></tr>`;
}

function _runsListHtml(): string {
  if (!_runs.length) return `<div class="empty-state job-empty">${esc(t('jobs.runs_empty'))}</div>`;
  return `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_name'), t('jobs.col_plant'), t('jobs.col_status'), t('jobs.col_result'), t('jobs.col_scheduled'), t('jobs.run_duration'), t('jobs.run_trigger')].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_runs.map(_runRowHtml).join('')}</tbody></table></div>`
    + (_nextBefore != null ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-act="more-runs">${esc(t('jobs.load_more'))}</button></div>` : '');
}

/** 'replace' = a fresh first page (filters changed, Refresh); 'append' = Load more; 'refresh' = the poll: page 1 is
 *  merged into what is loaded, so extra pages the viewer already pulled stay (and so does their cursor). */
function _runsQuery(beforeId: number | null = null): RunsQuery {
  return { plant: _plant, status: _runStatus, jobType: _runType, periodicity: _periodicity, scheduledBy: _scheduledBy, sinceHours: _since || undefined, beforeId };
}

async function _loadRuns(mode: 'replace' | 'append' | 'refresh' = 'replace'): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-runs-list');
  if (!host) return;
  if (mode === 'replace') { _busy(host, true); _setHtml(host, _skeletonHtml()); }
  try {
    const res = await JobsClient.runs(_runsQuery(mode === 'append' ? _nextBefore : null));
    if (my !== _seq) return;
    if (mode === 'append') { _runs = mergeRuns(_runs, res.items); _nextBefore = res.nextBeforeId; _runPages++; }
    else if (mode === 'refresh' && _runPages > 1) _runs = mergeRuns(_runs, res.items);
    else { _runs = res.items; _nextBefore = res.nextBeforeId; _runPages = 1; }
    _setHtml(host, _runsListHtml());
    _busy(host, false);
    _announce(t('jobs.count_runs', { n: _runs.length }), 'jobs-runs-live');
  } catch (e) {
    if (my === _seq) { _setHtml(host, _errorHtml(e as Error)); _busy(host, false); }
  }
}

/* ---- Batches view: one row per fan-out, expandable to its per-plant runs ---- */
/** Rows found by a report run (the sum over its sections); null when the run has no counts. */
const _rowsFound = (r: JobRun): number | null => {
  const rc = r.summary?.row_counts as Record<string, number> | undefined;
  return rc && typeof rc === 'object' ? Object.values(rc).reduce((a, n) => a + (Number(n) || 0), 0) : null;
};

function _batchChildrenHtml(b: Batch): string {
  const d = jobsDeps();
  const o = _openBatches.get(b.id);
  if (!o) return '';
  const hasRows = !!o.runs?.some(r => _rowsFound(r) != null);
  const span = hasRows ? 8 : 7;
  if (o.error) return `<tr class="job-batch-kids" data-kids-of="${b.id}"><td colspan="${span}" role="alert">${esc(t('jobs.load_failed', { msg: o.error }))}</td></tr>`;
  if (!o.runs) return `<tr class="job-batch-kids" data-kids-of="${b.id}"><td colspan="${span}"><div class="job-skel job-skel-row" aria-hidden="true"></div></td></tr>`;
  const rows = o.runs.map(r => `<tr class="job-run-row" data-run-id="${r.id}" tabindex="0"><td class="job-mono">${esc(r.plant)}</td><td>${runStatusHtml(r, d)}</td>`
    + `<td class="job-mono">${esc(_fmt(r.started_at ?? r.scheduled_for, r.plant))}</td><td class="job-mono">${esc(durationText(r.duration_ms) || '—')}</td>`
    + `<td>${r.summary?.error_kind ? esc(t(`jobs.error_kind_${r.summary.error_kind}`)) : ''}</td>`
    + (hasRows ? `<td class="job-mono">${(() => { const n = _rowsFound(r); return n == null ? '' : esc(n); })()}</td>` : '')
    + `<td class="job-sub">${esc(r.error ?? '')}</td><td><button type="button" class="btn btn-ghost sm" data-run-id="${r.id}">${esc(t('jobs.batch_view_run'))}</button></td></tr>`).join('');
  const total = b.counts.total ?? o.runs.length;
  const more = o.hasMore ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-batch-more="${b.id}"${o.more ? ' disabled' : ''}>${esc(t('jobs.batch_load_more', { shown: o.runs.length, total }))}</button></div>` : '';
  return `<tr class="job-batch-kids" data-kids-of="${b.id}"><td colspan="${span}"><table class="job-table job-batch-table"><caption class="job-sr">${esc(t('jobs.batch_children', { id: b.id }))}</caption><thead><tr>`
    + [t('jobs.col_plant'), t('jobs.col_status'), t('jobs.run_started'), t('jobs.run_duration'), t('jobs.col_error_kind'), ...(hasRows ? [t('jobs.col_row_counts')] : []), t('jobs.col_error'), ''].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${rows}</tbody></table>${more}</td></tr>`;
}

function _batchRowHtml(b: Batch): string {
  const d = jobsDeps();
  const open = _openBatches.has(b.id);
  const tiles = batchTiles(b).map(x => `<span class="kpi-tile job-batch-tile"><span class="job-sub">${esc(t(`jobs.batch_tile_${x.key}`))}</span> <b>${x.value}</b></span>`).join(' ');
  const admin = _isAdmin();
  const redo = (b.counts.failed ?? 0) + (b.counts.skipped ?? 0) + (b.counts.cancelled ?? 0) > 0;
  const actions = admin
    ? (b.status === 'running'
      ? `<button type="button" class="btn btn-ghost sm" data-jobs-batch-cancel="${b.id}">${esc(t('jobs.cancel_batch'))}</button>`
      : redo ? `<button type="button" class="btn btn-ghost sm" data-jobs-batch-restart="${b.id}">${esc(t('jobs.restart_batch'))}</button>` : '')
    : '';
  return `<tr class="job-batch-row" data-batch-id="${b.id}"><td class="job-name"><button type="button" class="job-link" data-jobs-batch="${b.id}" aria-expanded="${open ? 'true' : 'false'}">`
    + `<span class="job-caret" aria-hidden="true">${open ? '▾' : '▸'}</span> ${esc(b.jobName)}</button></td><td>${statusBadgeHtml(b.status, d)}</td><td class="job-batch-counts">${tiles}</td>`
    + `<td class="job-mono">${esc(_fmt(b.startedAt))}</td><td class="job-mono">${esc(durationText(b.durationMs) || '—')}</td>`
    + `<td>${esc(b.trigger ? t(`jobs.batch_trigger_${b.trigger}`) : '')}${b.triggeredBy && b.triggeredBy !== 'schedule' ? ` <span class="job-sub">${esc(b.triggeredBy)}</span>` : ''}</td>`
    + `<td class="job-actions">${actions}</td></tr>`
    + _batchChildrenHtml(b);
}

function _batchesListHtml(): string {
  if (!_batches.length) return `<div class="empty-state job-empty">${esc(t('jobs.batches_empty'))}</div>`;
  return `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_name'), t('jobs.col_status'), t('jobs.col_batch_counts'), t('jobs.run_started'), t('jobs.run_duration'), t('jobs.run_trigger'), ''].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_batches.map(_batchRowHtml).join('')}</tbody></table></div>`
    + (_nextBeforeBatch != null ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-act="more-batches">${esc(t('jobs.load_more'))}</button></div>` : '');
}

async function _loadBatches(mode: 'replace' | 'append' | 'refresh' = 'replace'): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-runs-list');
  if (!host) return;
  if (mode === 'replace') { _busy(host, true); _setHtml(host, _skeletonHtml()); }
  try {
    const res = await JobsClient.batches({ plant: _plant, status: _batchStatus, beforeId: mode === 'append' ? _nextBeforeBatch : null });
    if (my !== _seq) return;
    if (mode === 'append') { _batches = mergeRuns(_batches, res.items); _nextBeforeBatch = res.nextBeforeId; }
    else if (mode === 'refresh' && _batches.length > res.items.length) _batches = mergeRuns(_batches, res.items);
    else { _batches = res.items; _nextBeforeBatch = res.nextBeforeId; }
    _setHtml(host, _batchesListHtml());
    _busy(host, false);
    _announce(t('jobs.count_batches', { n: _batches.length }), 'jobs-runs-live');
    // Open batches that are still running re-read their children so the per-plant table follows the run.
    for (const b of _batches) if (_openBatches.has(b.id) && b.status === 'running') void _loadBatchKids(b.id);
  } catch (e) {
    if (my === _seq) { _setHtml(host, _errorHtml(e as Error)); _busy(host, false); }
  }
}

/** Read a batch's plant runs: the first page, or (`more`) the next page appended; a poll re-reads as many as are loaded. */
async function _loadBatchKids(id: number, more = false): Promise<void> {
  const cur = _openBatches.get(id);
  try {
    const have = cur?.runs?.length ?? 0;
    if (more && cur) { cur.more = true; _paintKids(id); }
    const r = more ? await JobsClient.batch(id, { limit: BATCH_KIDS_PAGE, offset: have })
      : await JobsClient.batch(id, { limit: Math.min(500, Math.max(BATCH_KIDS_PAGE, have)) });
    if (!_openBatches.has(id)) return;
    _openBatches.set(id, { runs: more ? [...(cur?.runs ?? []), ...r.runs] : r.runs, hasMore: r.hasMore });
    const i = _batches.findIndex(x => x.id === id);
    if (i >= 0) _batches[i] = r.batch;
  } catch (e) { if (_openBatches.has(id)) _openBatches.set(id, { runs: more ? cur?.runs ?? null : null, hasMore: cur?.hasMore, error: (e as Error).message }); }
  _paintKids(id);
}

/** Repaint only one batch's plant table (and its row's counts) in place: no list rebuild, so focus and scroll stay. */
function _paintKids(id: number): void {
  const host = _el('jobs-runs-list');
  const b = _batches.find(x => x.id === id);
  const row = host?.querySelector<HTMLElement>(`tr[data-batch-id="${id}"]`);
  if (!host || !b || _runView !== 'batches') return;
  if (!row) { _setHtml(host, _batchesListHtml()); return; }       // the row is not in the DOM (yet): paint the whole list
  const html = _batchChildrenHtml(b);
  const next = row.nextElementSibling;
  const kids = next?.classList.contains('job-batch-kids') ? next : null;
  if (_kidsSig.get(id) !== html) {
    _kidsSig.set(id, html);
    const focus = _focusSelector(host);
    if (kids) kids.outerHTML = html; else row.insertAdjacentHTML('afterend', html);
    if (focus) host.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  }
  _painted.set(host, _batchesListHtml());      // the in-place edit is what the full markup would have been
}

/** Open or close one batch IN PLACE (the kids row is inserted or removed, `aria-expanded` flips): the list is not
 *  rebuilt, so focus stays on the button just pressed and the scroll does not move. */
function _toggleBatch(id: number): void {
  const host = _el('jobs-runs-list');
  const btn = host?.querySelector<HTMLElement>(`[data-jobs-batch="${id}"]`);
  const row = btn?.closest?.('tr') ?? null;
  if (!row && host) {                                              // no row to edit in place: toggle the state and repaint
    if (_openBatches.has(id)) { _openBatches.delete(id); _kidsSig.delete(id); } else { _openBatches.set(id, { runs: null }); void _loadBatchKids(id); }
    _setHtml(host, _batchesListHtml());
    return;
  }
  if (_openBatches.has(id)) {
    _openBatches.delete(id); _kidsSig.delete(id);
    const next = row?.nextElementSibling;
    if (next?.classList.contains('job-batch-kids')) next.remove();
  } else {
    _openBatches.set(id, { runs: null });
    const b = _batches.find(x => x.id === id);
    if (row && b) { const html = _batchChildrenHtml(b); _kidsSig.set(id, html); row.insertAdjacentHTML('afterend', html); }
    void _loadBatchKids(id);
  }
  const open = _openBatches.has(id);
  btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  const caret = btn?.querySelector('.job-caret');
  if (caret) caret.textContent = open ? '▾' : '▸';
  if (host) _painted.set(host, _batchesListHtml());
}

async function _cancelBatch(id: number): Promise<void> {
  if (!await Modal.confirm({ title: t('jobs.confirm_cancel_batch', { id }), message: t('jobs.confirm_cancel_batch_msg'), confirmLabel: t('jobs.cancel_batch'), tone: 'danger' })) return;
  try { await JobsClient.cancelBatch(id); Toast.show(t('jobs.toast_batch_cancelled', { id }), 'success'); void _loadBatches('refresh'); void _loadHealth(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

async function _restartBatch(id: number): Promise<void> {
  if (!await Modal.confirm({ title: t('jobs.confirm_restart_batch', { id }), message: t('jobs.confirm_restart_batch_msg'), confirmLabel: t('jobs.restart_batch') })) return;
  try {
    const r = await JobsClient.restartBatch(id);
    _watch(r, r.job_name); Toast.show(t('jobs.toast_run_started', { name: r.job_name }), 'success');
    void _loadJobs(false, true); void _loadHealth();
    if (_tab === 'runs' && _runView === 'batches') void _loadBatches('refresh');
  } catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); }
}

/** A child run's "Batch #n" badge: show the batches view with that batch opened (read by id when it is not on page 1). */
async function _openBatchFromRun(id: number): Promise<void> {
  _runView = 'batches'; _openBatches.set(id, { runs: null });
  _renderRunsTab();
  try { const r = await JobsClient.batch(id); if (!_batches.some(x => x.id === id)) _batches = [r.batch, ..._batches]; } catch { /* the kids loader shows the error */ }
  void _loadBatchKids(id);
}

function _periodicityOptions(sel: string): string {
  return `<option value="">${esc(t('jobs.period_any'))}</option>`
    + PERIODICITIES.map(p => `<option value="${p}"${p === sel ? ' selected' : ''}>${esc(t(p === 'manual' ? 'jobs.trigger_manual' : `jobs.preset_${p}`))}</option>`).join('');
}
function _byOptions(sel: string): string {
  const me = Session.actor();
  return `<option value="">${esc(t('jobs.by_any'))}</option><option value="schedule"${sel === 'schedule' ? ' selected' : ''}>${esc(t('jobs.by_scheduler'))}</option>`
    + (me && me !== 'system' ? `<option value="${esc(me)}"${sel === me ? ' selected' : ''}>${esc(t('jobs.by_me'))}</option>` : '');
}

function _renderRunsTab(): void {
  const host = _el('jobs-view-runs');
  if (!host) return;
  JobsRunDetail.stop();
  const viewSel = `<div class="job-field"><label class="job-field-l" for="jobs-runs-view">${esc(t('jobs.f_view'))}</label><select class="input" id="jobs-runs-view">`
    + (['runs', 'batches', 'timeline'] as const).map(v => `<option value="${v}"${v === _runView ? ' selected' : ''}>${esc(t(`jobs.view_${v}`))}</option>`).join('') + `</select></div>`;
  const batchToolbar = `<div class="job-toolbar">${_plantFilterHtml('jobs-runs')}${viewSel}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-runs-bstatus">${esc(t('jobs.col_status'))}</label><select class="input" id="jobs-runs-bstatus"><option value="">${esc(t('jobs.status_any'))}</option>`
    + BATCH_STATUSES.map(b => `<option value="${b}"${b === _batchStatus ? ' selected' : ''}>${esc(statusLabel(b === 'running' ? 'running' : b, jobsDeps()))}</option>`).join('') + `</select></div>`
    + `<button type="button" class="btn btn-ghost" data-jobs-act="refresh-runs">${esc(t('btn.refresh'))}</button></div>`;
  const tlToolbar = `<div class="job-toolbar">${_plantFilterHtml('jobs-runs')}${viewSel}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-tl-range">${esc(t('jobs.tl_range'))}</label><select class="input" id="jobs-tl-range">`
    + TL_RANGES.map(r => `<option value="${r}"${r === _tlRange ? ' selected' : ''}>${esc(t(`jobs.tl_${r}`))}</option>`).join('') + `</select></div>`
    + `<button type="button" class="btn btn-ghost" data-jobs-act="refresh-runs">${esc(t('btn.refresh'))}</button></div>`;
  host.innerHTML = `<div id="jobs-runs-main">${_runView === 'batches' ? batchToolbar : _runView === 'timeline' ? tlToolbar : `<div class="job-toolbar">${_plantFilterHtml('jobs-runs')}${viewSel}`}`
    + (_runView !== 'runs' ? '' : `<div class="job-field"><label class="job-field-l" for="jobs-runs-status">${esc(t('jobs.col_status'))}</label><select class="input" id="jobs-runs-status">${_statusOptions(_runStatus)}</select></div>`
    + `<div class="job-field"><label class="job-field-l" for="jobs-runs-type">${esc(t('jobs.f_type'))}</label><select class="input" id="jobs-runs-type"><option value="">${esc(t('jobs.type_any'))}</option>`
    + _typeOptionsHtml(_runType) + `</select></div>`
    + `<div class="job-field"><label class="job-field-l" for="jobs-runs-period">${esc(t('jobs.f_periodicity'))}</label><select class="input" id="jobs-runs-period">${_periodicityOptions(_periodicity)}</select></div>`
    + `<div class="job-field"><label class="job-field-l" for="jobs-runs-by">${esc(t('jobs.f_scheduled_by'))}</label><select class="input" id="jobs-runs-by">${_byOptions(_scheduledBy)}</select></div>`
    + (_since ? `<button type="button" class="btn btn-ghost sm job-chip" data-jobs-act="clear-since">${esc(t('jobs.since_chip', { h: _since }))} ×</button>` : '')
    + `<button type="button" class="btn btn-ghost" data-jobs-act="refresh-runs">${esc(t('btn.refresh'))}</button></div>`)
    + `<div id="jobs-runs-list"></div><span class="job-sr" id="jobs-runs-live" role="status" aria-live="polite"></span></div><div id="jobs-run-detail" hidden></div>`;
  _announced = '';
  _mountPlantCombo('jobs-runs', () => { _tlOffset = 0; void _loadRunsView(); void _loadHealth(); });
  void _loadRunsView();
  _armRunsPoll();
}

/* ---------------------------------------------------------------------------
   Runs timeline (Runs tab, View = Timeline): one lane per plant on ONE shared time axis; plain SVG, no timeline library.
   Bars are runs (colour from the status vocabulary; the label and title always say the status) and upcoming fires
   (dashed outline) computed by the server's own occurrence stream. The same items are listed as a table below.
   ------------------------------------------------------------------------- */
const TL_PAGE = 20;              // plant lanes per page (the server's default)

function _loadRunsView(mode: 'replace' | 'append' | 'refresh' = 'replace'): Promise<void> {
  if (_runView === 'timeline') return _loadTimeline(mode);
  return _runView === 'batches' ? _loadBatches(mode) : _loadRuns(mode);
}

async function _loadTimeline(mode: 'replace' | 'append' | 'refresh' = 'replace'): Promise<void> {
  const my = ++_tlSeq;
  const host = _el('jobs-runs-list');
  if (!host) return;
  if (mode === 'replace') { _busy(host, true); _setHtml(host, _skeletonHtml()); }
  const now = Date.now();
  const win = timelineWindow(_tlRange, now);
  try {
    const tl = await JobsClient.timeline({ from: win.from, to: win.to, plant: _plant, plantOffset: _tlOffset, plantLimit: TL_PAGE });
    if (my !== _tlSeq || _runView !== 'timeline') return;          // a newer request, or the view changed meanwhile
    if (_tlOffset > 0 && !tl.lanes.length) {                       // the page is past the end (plants went away): clamp, ask again
      _tlOffset = tl.totalPlants > 0 ? Math.floor((tl.totalPlants - 1) / TL_PAGE) * TL_PAGE : 0;
      if (_tlOffset !== tl.plantOffset) { void _loadTimeline(mode); return; }
    }
    _setHtml(host, _timelineHtml(tl, win.fromMs, win.toMs, now));
    _busy(host, false);
    _announce(t('jobs.tl_page', { from: tl.lanes.length ? tl.plantOffset + 1 : 0, to: tl.plantOffset + tl.lanes.length, total: tl.totalPlants }), 'jobs-runs-live');
  } catch (e) {
    if (my === _tlSeq && _runView === 'timeline') { _setHtml(host, _errorHtml(e as Error)); _busy(host, false); }
  }
}

/** A bar's or row's one-line description: job, status, and the plant's own wall clock. */
function _tlWhen(iso: string, tz: string): string {
  const z = tzShort(tz, iso);
  return `${Util.fmtDTPref(plantWall(iso, tz))}${z ? ` ${z}` : ''}`;
}

function _timelineHtml(tl: Timeline, fromMs: number, toMs: number, nowMs: number): string {
  const d = jobsDeps();
  const paging = tl.totalPlants > TL_PAGE || tl.plantOffset > 0
    ? `<div class="job-pager"><span class="job-sub">${esc(t('jobs.tl_page', { from: tl.lanes.length ? tl.plantOffset + 1 : 0, to: tl.plantOffset + tl.lanes.length, total: tl.totalPlants }))}</span>`
      + `<button type="button" class="btn btn-ghost sm" data-jobs-act="tl-prev"${tl.plantOffset <= 0 ? ' disabled' : ''}>${esc(t('jobs.tl_prev'))}</button>`
      + `<button type="button" class="btn btn-ghost sm" data-jobs-act="tl-next"${tl.plantOffset + tl.lanes.length >= tl.totalPlants ? ' disabled' : ''}>${esc(t('jobs.tl_next'))}</button></div>`
    : '';
  if (!tl.lanes.length) return `<div class="empty-state job-empty">${esc(t('jobs.tl_empty'))}</div>${paging}`;
  const ticks = timelineTicks(_tlRange, fromMs, toMs, nowMs);
  const axis = `<div class="job-tl-row job-tl-axis-row"><div></div><div class="job-tl-axis" aria-hidden="true">${ticks.map(k => `<span>${esc(k.labelKey === 'jobs.tl_now_axis' ? t(k.labelKey) : t(k.labelKey, { n: k.n }))}</span>`).join('')}</div></div>`;
  const nowX = ((nowMs - fromMs) / (toMs - fromMs)) * TL_W;
  const lanes = tl.lanes.map(l => {
    const bars = timelineBars(l, fromMs, toMs, nowMs).map(b => {
      const iso = new Date(b.startMs).toISOString();
      const label = b.kind === 'run'
        ? `${b.jobName}: ${statusLabel(b.status, d)}, ${_tlWhen(iso, l.timezone)}`
        : `${b.jobName}: ${t('jobs.tl_kind_upcoming')}, ${_tlWhen(iso, l.timezone)}${b.note ? ` (${policyNoteText(b.note, d)})` : b.shifted ? ` (${policyNoteText('dst_gap_shifted', d)})` : ''}`;
      const target = b.runId != null ? `data-tl-run="${b.runId}"` : `data-tl-job="${b.jobId}" data-tl-name="${esc(b.jobName)}"`;
      return `<g class="job-tl-bar s-${esc(b.status)}" tabindex="0" role="button" data-tl-key="${esc(b.key)}" ${target} aria-label="${esc(label)}"><title>${esc(label)}</title>`
        + `<rect x="${b.x.toFixed(1)}" y="5" width="${b.w.toFixed(1)}" height="18" rx="3"/></g>`;
    }).join('');
    const grid = ticks.map(k => `<line class="job-tl-grid" x1="${(k.pct * TL_W / 100).toFixed(1)}" x2="${(k.pct * TL_W / 100).toFixed(1)}" y1="0" y2="28"/>`).join('');
    const nowTxt = `${Util.fmtDTPref(stripOffset(l.nowLocal))} ${tzShort(l.timezone, tl.nowUtc)}`.trim();
    return `<div class="job-tl-row"><div class="job-tl-name"><span class="job-mono job-tl-plant">${esc(l.plant)}</span>`
      + `<span class="job-sub">${esc(l.timezone)}</span><span class="job-sub job-tl-now">${esc(t('jobs.tl_now', { time: nowTxt }))}</span></div>`
      + `<svg class="job-tl-svg" viewBox="0 0 ${TL_W} 28" preserveAspectRatio="none" role="group" aria-label="${esc(t('jobs.tl_lane', { plant: l.plant }))}">`
      + `${grid}<line class="job-tl-nowline" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="0" y2="28"/>${bars}</svg></div>`;
  }).join('');
  const rows = timelineRows(tl);
  const table = `<details class="job-tl-list"${_tlListOpen ? ' open' : ''}><summary id="jobs-tl-sum">${esc(t('jobs.tl_list'))}</summary><div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_plant'), t('jobs.col_name'), t('jobs.tl_col_kind'), t('jobs.col_status'), t('jobs.tl_col_when')].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${rows.map((r, i) => {
      const target = r.runId != null ? `data-tl-run="${r.runId}"` : `data-tl-job="${r.jobId}" data-tl-name="${esc(r.jobName)}"`;
      const status = r.kind === 'run' ? `<span class="badge ${statusBadgeClass(r.status)} job-status">${esc(statusLabel(r.status, d))}</span>` : `<span class="badge badge-muted job-status">${esc(t('jobs.tl_kind_upcoming'))}</span>`;
      const note = r.note ? ` <span class="job-sub">${esc(policyNoteText(r.note, d))}</span>` : '';
      return `<tr class="job-run-row" tabindex="0" data-tl-key="row${i}" ${target}><td class="job-mono">${esc(r.plant)}</td><td class="job-name">${esc(r.jobName)}</td>`
        + `<td>${esc(t(r.kind === 'run' ? 'jobs.tl_kind_run' : 'jobs.tl_kind_upcoming'))}</td><td>${status}</td><td class="job-mono">${esc(_tlWhen(r.whenUtc, r.timezone))}${note}</td></tr>`;
    }).join('')}</tbody></table></div></details>`;
  return `<div class="job-tl" role="region" aria-label="${esc(t('jobs.tl_label'))}">${axis}${lanes}</div>`
    + `<div class="ape-hint">${esc(t('jobs.tl_note'))}</div>`
    + (tl.truncated ? `<div class="ape-hint" role="note">${esc(t('jobs.tl_truncated'))}</div>` : '')
    + (tl.upcomingTruncated ? `<div class="ape-hint" role="note">${esc(t('jobs.tl_upcoming_truncated'))}</div>` : '') + paging + table;
}

/** A bar or a table row of the timeline was activated: a run opens its detail, an upcoming fire opens its job in the Jobs tab. */
function _tlActivate(el: HTMLElement): void {
  if (el.dataset.tlRun) { void _openRun(Number(el.dataset.tlRun)); return; }
  if (el.dataset.tlJob) { _q = el.dataset.tlName ?? ''; _plant = ''; _status = ''; _type = ''; _setTab('jobs'); }
}

/* ---------------------------------------------------------------------------
   Maintenance mode: an admin toggle beside the sub-tabs and a persistent banner while it is on
   ------------------------------------------------------------------------- */
let _maintSig = '';
/** The pause switch is global, so only a plant-unrestricted admin may use it (the server answers 403 to a scoped one):
 *  a scoped admin sees the button disabled with the reason beside it. A plain button whose LABEL says the next action
 *  (no aria-pressed: a pressed state plus a flipping label would be read twice). */
function _renderMaint(m: HealthSummary['maintenance']): void {
  const host = _el('jobs-maint');
  if (!host) return;
  const on = !!m?.enabled; const admin = _isAdmin(); const scoped = Session.allowedPlants() !== null;
  const sig = `${on}|${m?.since ?? ''}|${m?.by ?? ''}|${admin}|${scoped}`;
  if (sig === _maintSig) return;
  _maintSig = sig;
  const hadFocus = document.activeElement?.id === 'jobs-maint-btn';
  const since = on && m?.since ? t('jobs.maint_since', { at: _fmt(m.since), who: m.by ?? '—' }) : '';
  host.innerHTML = (on ? `<div class="job-banner job-maint-banner" role="status">${esc(t('jobs.maint_banner'))}${since ? ` <span class="job-maint-since">${esc(since)}</span>` : ''}</div>` : '')
    + (admin ? `<button type="button" class="btn btn-ghost sm job-maint-btn" id="jobs-maint-btn" data-jobs-act="maint"${scoped ? ' disabled aria-describedby="jobs-maint-why"' : ''}>${esc(t(on ? 'jobs.maint_off_btn' : 'jobs.maint_on_btn'))}</button>`
      + (scoped ? `<span class="ape-hint" id="jobs-maint-why">${esc(t('jobs.maint_scoped_hint'))}</span>` : '') : '');
  if (hadFocus) _el('jobs-maint-btn')?.focus();
}

async function _toggleMaint(): Promise<void> {
  if (Session.allowedPlants() !== null) return;          // global setting: the button is disabled for a scoped admin
  const on = !!_health?.maintenance?.enabled;
  const ok = await Modal.confirm({
    title: t(on ? 'jobs.maint_confirm_off_title' : 'jobs.maint_confirm_on_title'), message: t(on ? 'jobs.maint_confirm_off_msg' : 'jobs.maint_confirm_on_msg'),
    confirmLabel: t(on ? 'jobs.maint_off_btn' : 'jobs.maint_on_btn'), ...(on ? {} : { tone: 'warn' as const }),
  });
  if (!ok) return;
  try { await JobsClient.setMaintenance(!on); } catch (e) { Toast.show(t('jobs.maint_failed', { msg: (e as Error).message }), 'error'); return; }
  _healthSig = ''; _maintSig = '';
  await _loadHealth();
  _el('jobs-maint-btn')?.focus();                       // the button was rebuilt: put focus back on it
}

function _armRunsPoll(): void {
  if (_runsTimer) clearTimeout(_runsTimer);
  _runsTimer = null;
  if (!_visible() || _tab !== 'runs') return;
  _runsTimer = setTimeout(() => {
    _runsTimer = null;
    // Health and the watcher belong to _pollTimer (one owner), so the Runs tab never duplicates those requests.
    if (_visible() && _tab === 'runs' && !JobsRunDetail.isOpen()) void _loadRunsView('refresh');
    _armRunsPoll();
  }, RUNS_POLL_MS);
}

async function _openRun(id: number): Promise<void> {
  const main = _el('jobs-runs-main'); const det = _el('jobs-run-detail');
  if (!main || !det) return;
  // The list row is the usual source; a run not in it (or not loaded yet) is read by id.
  let run = _runs.find(r => r.id === id);
  if (!run) { try { run = await JobsClient.getRun(id); } catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'error'); return; } }
  main.hidden = true; det.hidden = false;
  JobsRunDetail.show(det, run, {
    visible: _visible,
    longer: () => isLongerThanUsual(run.id, _health?.longerThanUsual),
    tz: plantTimezone(run.plant), types: _types,
    onBack: () => { JobsRunDetail.stop(); det.hidden = true; main.hidden = false; void _loadRunsView('refresh'); void _loadHealth(); },
    // The open run changed state: fold page 1 into the list (never replace it, later pages stay loaded).
    onChanged: () => { void _loadHealth(); void JobsClient.runs(_runsQuery()).then(r => { if (r.items.some(x => x.id === id)) _runs = mergeRuns(_runs, r.items); }).catch(() => undefined); },
    // Restart started a new manual run: watch it and open it.
    onRestart: (nr) => { _watch(nr, nr.job_name); void _loadHealth(); void _openRun(nr.id); },
  });
}

function _gotoRuns(j: Job): void {
  _plant = j.targets.length ? '' : j.plant; _runStatus = ''; _since = 0; _periodicity = ''; _scheduledBy = ''; _runType = '';
  _runView = 'runs';
  _setTab('runs');
}

/* ---------------------------------------------------------------------------
   Upcoming sub-tab: the next-N list across the viewer's plants, and a 7-day strip for one plant
   ------------------------------------------------------------------------- */
async function _loadUpcoming(): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-upcoming-body');
  if (!host) return;
  _busy(host, true);
  _setHtml(host, _skeletonHtml(4));
  try {
    // One server call: GET /jobs/upcoming, soonest first across the viewer's visible jobs (a plant narrows it).
    // The 7-day strip needs the whole week, so a chosen plant asks for more entries than the list shows.
    // The server caps the list at 50 soonest-first entries: a busy plant can fill it before the week ends, which
    // the strip then says (stripCompleteThrough) instead of silently showing a short week.
    _upcomingRequested = _stripPlant ? 50 : 20;
    const entries: UpcomingEntry[] = await JobsClient.upcomingAll(_stripPlant, _upcomingRequested);
    if (my !== _seq) return;
    _upcoming = entries.map(e => ({ at: stripOffset(e.atLocal), jobId: e.jobId, jobName: e.jobName, plant: e.plant, tz: e.timezone }));
    _setHtml(host, _upcomingHtml());
    _busy(host, false);
  } catch (e) {
    if (my === _seq) _setHtml(host, _errorHtml(e as Error));
  }
}

function _plantToday(plant: string): string {
  const d = plant ? Util.plantToday(plant) : null;
  return d ? Util.dayKey(d) : (_upcoming[0] ? isoDayKey(_upcoming[0].at) : Util.dayKey(new Date()));
}

function _upcomingHtml(): string {
  if (!_upcoming.length) return `<div class="empty-state job-empty">${esc(t('jobs.upcoming_empty'))}</div>`;
  const list = _upcoming.slice(0, 20);
  let strip = '';
  if (_stripPlant) {
    const start = _plantToday(_stripPlant);
    strip = `<div class="job-strip" role="list" aria-label="${esc(t('jobs.strip'))}">`
      + weekStrip(_upcoming, start).map(b => `<div class="job-strip-day" role="listitem"><div class="job-strip-h">${esc(Util.fmtDayLabelPref(b.day))}</div>`
        + (b.runs.length ? b.runs.map(r => `<div class="job-strip-run job-mono" title="${esc(r.jobName ?? '')}">${esc(Util._fmtTimePref(Util.parseDate(r.at) as Date))}</div>`).join('') : `<div class="job-strip-none">—</div>`)
        + `</div>`).join('') + `</div><div class="ape-hint">${esc(t('jobs.strip_note', { tz: plantTimezone(_stripPlant) || '—', end: addDays(start, 6) }))}</div>`;
    const through = stripCompleteThrough(_upcoming, _upcomingRequested);
    if (through && through < addDays(start, 6)) {
      strip += `<div class="ape-hint" role="note">${esc(t('jobs.strip_truncated', { n: _upcomingRequested, day: through }))}</div>`;
    }
  } else {
    strip = `<div class="ape-hint">${esc(t('jobs.strip_pick'))}</div>`;
  }
  return strip + `<ol class="job-upcoming">${list.map(r => `<li><span class="job-mono">${esc(`${Util.fmtDTPref(r.at)} ${tzShort(r.tz || plantTimezone(r.plant ?? ''))}`.trim())}</span> <span>${esc(r.jobName)}</span> <span class="job-sub job-mono">${esc(r.plant ?? '')}</span></li>`).join('')}</ol>`;
}

function _renderUpcomingTab(): void {
  const host = _el('jobs-view-upcoming');
  if (!host) return;
  host.innerHTML = `<div class="job-toolbar">${_plantFilterHtml('jobs-up')}</div><div id="jobs-upcoming-body"></div>`;
  mkCombobox(_el('jobs-up-plant-host'), allowedPlantList(), {
    value: _stripPlant, placeholder: t('jobs.pick_plant'), id: 'jobs-up-plant',
    onSelect: (v) => { _stripPlant = v; void _loadUpcoming(); },
  });
  void _loadUpcoming();
}

/* ---------------------------------------------------------------------------
   Sub-tab switching, wiring, lifecycle
   ------------------------------------------------------------------------- */
function _setTab(tab: SubTab): void {
  _tab = tab;
  OverflowMenu.closeAll();
  if (tab !== 'runs') JobsRunDetail.stop();
  document.querySelectorAll<HTMLElement>('#admin-jobs-pane .admin-ov-tabs .sub-subtab').forEach(b => {
    const on = b.dataset.jobsTab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  for (const k of ['jobs', 'runs', 'upcoming', 'templates'] as const) { const v = _el(`jobs-view-${k}`); if (v) v.hidden = k !== tab; }
  if (tab === 'jobs') _renderJobsTab();
  else if (tab === 'runs') _renderRunsTab();
  else if (tab === 'templates') _renderTemplatesTab();
  else _renderUpcomingTab();
  if (tab !== 'runs' && _runsTimer) { clearTimeout(_runsTimer); _runsTimer = null; }
  void _loadHealth().then(() => _armPoll());
}

/** `/` jumps to the search box (Jobs) or the plant filter (Runs / Upcoming), unless the viewer is already typing. */
function _focusSearch(e: KeyboardEvent): void {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !_visible()) return;
  const tgt = e.target as HTMLElement | null;
  if (tgt && (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable)) return;
  if (Modal.anyOpen()) return;
  const el = _el<HTMLInputElement>(_tab === 'jobs' ? 'jobs-q' : _tab === 'runs' ? 'jobs-runs-plant' : 'jobs-up-plant');
  if (!el || el.offsetParent === null) return;      // not laid out (a hidden sub-view or pane)
  e.preventDefault();
  el.focus();
}

function _wire(): void {
  if (_wired) return;
  const pane = _el('admin-jobs-pane');
  if (!pane) return;
  _wired = true;
  pane.querySelectorAll<HTMLElement>('[data-jobs-tab]').forEach(b => b.addEventListener('click', () => _setTab(b.dataset.jobsTab as SubTab)));
  pane.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const menu = target.closest<HTMLElement>('[data-jobs-menu]');
    if (menu) {
      const j = _jobs.find(x => x.id === Number(menu.dataset.jobsMenu));
      if (j) OverflowMenu.open(menu, _menuItems(j), { align: 'end', key: `job-${j.id}` });
      return;
    }
    const tile = target.closest<HTMLElement>('[data-jobs-tile]');
    if (tile) { _tileClick(String(tile.dataset.jobsTile)); return; }
    const bulk = target.closest<HTMLElement>('[data-jobs-bulk]');
    if (bulk) { void _bulk(String(bulk.dataset.jobsBulk)); return; }
    const sel = target.closest<HTMLElement>('[data-jobs-sel]');
    if (sel) {
      const id = Number(sel.dataset.jobsSel);
      if ((sel as HTMLInputElement).checked) _selected.add(id); else _selected.delete(id);
      _syncBulk();
      return;
    }
    if (target.id === 'jobs-sel-all') {
      if ((target as HTMLInputElement).checked) _jobs.forEach(j => _selected.add(j.id)); else _selected.clear();
      _jobsRerender();
      return;
    }
    const bOpen = target.closest<HTMLElement>('[data-jobs-batch-open]');
    if (bOpen) { void _openBatchFromRun(Number(bOpen.dataset.jobsBatchOpen)); return; }
    const bCancel = target.closest<HTMLElement>('[data-jobs-batch-cancel]');
    if (bCancel) { void _cancelBatch(Number(bCancel.dataset.jobsBatchCancel)); return; }
    const bRestart = target.closest<HTMLElement>('[data-jobs-batch-restart]');
    if (bRestart) { void _restartBatch(Number(bRestart.dataset.jobsBatchRestart)); return; }
    const bMore = target.closest<HTMLElement>('[data-jobs-batch-more]');
    if (bMore) { void _loadBatchKids(Number(bMore.dataset.jobsBatchMore), true); return; }
    const bTog = target.closest<HTMLElement>('[data-jobs-batch]');
    if (bTog) { _toggleBatch(Number(bTog.dataset.jobsBatch)); return; }
    const tlEl = target.closest<HTMLElement>('[data-tl-key]');
    if (tlEl) { _tlActivate(tlEl); return; }
    const runRow = target.closest<HTMLElement>('[data-run-id]');
    if (runRow) { void _openRun(Number(runRow.dataset.runId)); return; }
    const act = target.closest<HTMLElement>('[data-jobs-act]')?.dataset.jobsAct;
    if (act === 'retry-health') { void _loadHealth(); return; }
    if (act === 'retry') { if (_tab === 'jobs') void _loadJobs(); else if (_tab === 'runs') void _loadRunsView(); else void _loadUpcoming(); return; }
    if (act === 'clear-since') { _since = 0; _renderRunsTab(); return; }
    if (act === 'maint') { void _toggleMaint(); return; }
    if (act === 'tl-prev' || act === 'tl-next') { _tlOffset = Math.max(0, _tlOffset + (act === 'tl-next' ? TL_PAGE : -TL_PAGE)); void _loadTimeline(); return; }
    const tplId = Number(target.closest<HTMLElement>('[data-tpl-id]')?.dataset.tplId);
    if (act === 'tpl-new') { void _openNew(tplId); return; }
    if (act === 'tpl-archive') { void _archiveTemplate(tplId); return; }
    if (act === 'tpl-update') { const j = _jobs.find(x => x.id === Number(target.closest<HTMLElement>('[data-job-id]')?.dataset.jobId)); if (j) void _templateUpdate(j); return; }
    if (act === 'new') void _openNew();
    else if (act === 'more-jobs') void _loadJobs(true);
    else if (act === 'more-runs') void _loadRuns('append');
    else if (act === 'more-batches') void _loadBatches('append');
    else if (act === 'refresh-runs') void _loadRunsView();
    else if (act === 'runs-of') { const j = _jobs.find(x => x.id === Number((target.closest<HTMLElement>('[data-job-id]'))?.dataset.jobId)); if (j) _gotoRuns(j); }
  });
  pane.addEventListener('toggle', (e) => {                // `toggle` does not bubble: listen in the capture phase
    const d = e.target as HTMLDetailsElement;
    if (d?.classList?.contains('job-tl-list')) _tlListOpen = d.open;
  }, true);
  pane.addEventListener('keydown', (e) => {
    const tlRow = (e.target as HTMLElement).closest<HTMLElement>('[data-tl-key]');
    if (tlRow && e.target === tlRow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); _tlActivate(tlRow); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>('.job-run-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void _openRun(Number(row.dataset.runId)); }
  });
  pane.addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).id;
    const v = (e.target as HTMLSelectElement).value;
    if (id === 'jobs-tpl-archived') { _tplArchived = (e.target as HTMLInputElement).checked; _renderTemplatesTab(); }
    else if (id === 'jobs-type') { _type = v; void _loadJobs(); }
    else if (id === 'jobs-status') { _status = v; void _loadJobs(); }
    else if (id === 'jobs-runs-view') { _runView = v === 'batches' ? 'batches' : v === 'timeline' ? 'timeline' : 'runs'; _tlOffset = 0; _renderRunsTab(); }
    else if (id === 'jobs-tl-range') { _tlRange = v === '7d' ? '7d' : '24h'; _tlOffset = 0; void _loadTimeline(); }
    else if (id === 'jobs-runs-bstatus') { _batchStatus = v; void _loadBatches(); }
    else if (id === 'jobs-runs-status') { _runStatus = v; _since = 0; void _loadRuns(); }
    else if (id === 'jobs-runs-type') { _runType = v; void _loadRuns(); }
    else if (id === 'jobs-runs-period') { _periodicity = v; void _loadRuns(); }
    else if (id === 'jobs-runs-by') { _scheduledBy = v; void _loadRuns(); }
  });
  document.addEventListener('keydown', _focusSearch);
  pane.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'jobs-q') return;
    _q = (e.target as HTMLInputElement).value;
    if (_qTimer) clearTimeout(_qTimer);
    _qTimer = setTimeout(() => void _loadJobs(), 250);
  });
  document.addEventListener('visibilitychange', () => {
    if (_active && !document.hidden) { void _loadHealth().then(() => _armPoll()); }
    if (_active && _tab === 'runs' && !document.hidden) { void _loadRunsView('refresh'); _armRunsPoll(); JobsRunDetail.resume(); }
  });
}

export const JobsAdmin = {
  init(): void { _wire(); },

  async render(): Promise<void> {
    _wire();
    _active = true;
    const admin = _isAdmin();
    _el('admin-jobs-pane')?.classList.toggle('job-readonly', !admin);
    const note = _el('jobs-readonly-note');
    if (note) note.hidden = admin;
    if (!_types.length) { try { _types = await JobsClient.types(); } catch { /* the type filter just stays at Any */ } }
    const tplTab = _el('jobs-tab-templates');
    if (tplTab) tplTab.hidden = !admin;                  // templates are an admin tool
    if (!admin && _tab === 'templates') _tab = 'jobs';
    _setTab(_tab);
  },

  /** Open one run in the Runs tab (deep-link from the Overview and Logs panes). */
  openRun(id: number): void { _setTab('runs'); void _openRun(id); },

  /** Test seam: switch the sub-view the way a tab click does. */
  _setTab(tab: SubTab): void { _setTab(tab); },

  setActive(on: boolean): void {
    _active = on;
    if (!on) {
      if (_runsTimer) { clearTimeout(_runsTimer); _runsTimer = null; }
      if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
      OverflowMenu.closeAll();
      JobsRunDetail.stop();
    }
  },
};
