/* =============================================================================
   JOBS PANE — Admin > Jobs (#admin-jobs-pane): sub-tabs Jobs / Runs / Upcoming.

   Lifecycle (the DistributionPane / AlertMonitor shape): AdminCockpit._setSub('jobs') calls
   render() on every entry and setActive(false) on leave; init() wires the delegated handlers
   once. `_active` gates every timer: the Runs list polls every 15 s only while the Runs tab is
   showing and the document is visible; the open run's log polls itself (jobs-run-detail.mts).

   Admin controls (New, Run now, Pause, Edit, Duplicate, Copy, Delete) exist only for admins;
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
import { JobsDialog, mkCombobox, allowedPlantList, jobsDeps, plantTimezone } from './jobs-dialog.mjs';
import { JobsRunDetail } from './jobs-run-detail.mjs';
import {
  RUN_STATUSES, JOBS_PAGE, statusBadgeHtml, recurrenceText, durationText, weekStrip, isoDayKey, addDays, plantWall, stripOffset,
  mergeRuns, stripCompleteThrough,
} from './jobs-model.mjs';
import type { UpcomingRun } from './jobs-model.mjs';
import type { UpcomingEntry } from './jobs-client.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

export const RUNS_POLL_MS = 15000;
type SubTab = 'jobs' | 'runs' | 'upcoming';

let _wired = false;
let _active = false;
let _tab: SubTab = 'jobs';
let _plant = '';                 // '' = every plant the viewer may see
let _q = '';
let _status = '';                // jobs: last-run status filter; runs: run status filter
let _type = '';
let _types: JobType[] = [];
let _jobs: Job[] = [];
let _nextBeforeJob: number | null = null;
let _runs: JobRun[] = [];
let _nextBefore: number | null = null;
let _runPages = 1;               // pages of the runs list loaded (the poll merges instead of replacing when > 1)
let _upcomingRequested = 20;
let _upcoming: UpcomingRun[] = [];
let _stripPlant = '';
let _runsTimer: ReturnType<typeof setTimeout> | null = null;
let _seq = 0;                    // guards every async fetch against a newer one
let _qTimer: ReturnType<typeof setTimeout> | null = null;

const _el = <E extends HTMLElement = HTMLElement>(id: string): E | null => document.getElementById(id) as E | null;
const _isAdmin = (): boolean => Session.isAdmin();
/** A tz-aware instant (or a naive plant-local value) in the viewer's date/time format, on the plant's wall clock. */
const _fmt = (iso: string | null | undefined, plant?: string): string => (iso ? Util.fmtDTPref(plantWall(iso, plant ? plantTimezone(plant) : '')) : '—');
const _visible = (): boolean => _active && !document.hidden && !!_el('admin-tab')?.classList.contains('active');

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
   Jobs sub-tab
   ------------------------------------------------------------------------- */
function _jobsToolbarHtml(): string {
  return `<div class="job-toolbar">${_plantFilterHtml('jobs')}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-type">${esc(t('jobs.f_type'))}</label><select class="input" id="jobs-type"><option value="">${esc(t('jobs.type_any'))}</option>`
    + _types.map(x => `<option value="${esc(x.key)}"${x.key === _type ? ' selected' : ''}>${esc(x.key === 'optimizer.plant' ? t('jobs.type_optimizer') : x.label)}</option>`).join('') + `</select></div>`
    + `<div class="job-field"><label class="job-field-l" for="jobs-status">${esc(t('jobs.f_last_run'))}</label><select class="input" id="jobs-status">${_statusOptions(_status)}</select></div>`
    + `<div class="job-field job-grow"><label class="job-field-l" for="jobs-q">${esc(t('jobs.search'))}</label><input class="input" id="jobs-q" type="search" value="${esc(_q)}" placeholder="${esc(t('jobs.search_ph'))}" autocomplete="off"></div>`
    + (_isAdmin() ? `<button type="button" class="btn btn-primary" data-jobs-act="new">${esc(t('jobs.new'))}</button>` : '')
    + `</div>`;
}

function _jobRowHtml(j: Job): string {
  const d = jobsDeps();
  const lr = j.last_run;
  const paused = !j.enabled || j.schedule?.paused;
  const next = paused ? `<span class="badge badge-muted">${esc(t('jobs.paused'))}</span>` : esc(j.next_run_local ? Util.fmtDTPref(stripOffset(j.next_run_local)) : '—');
  return `<tr data-job-id="${j.id}"><td class="job-name"><button type="button" class="job-link" data-jobs-act="runs-of" data-job-id="${j.id}">${esc(j.name)}</button>`
    + `<div class="job-sub">${esc(j.params.apply_mode === 'apply' ? t('jobs.result_apply') : t('jobs.result_propose'))} · ${esc(j.params.search === 'normal' ? t('jobs.search_normal') : t('jobs.search_exhaustive'))}</div></td>`
    + `<td class="job-mono">${esc(j.plant)}</td>`
    + `<td>${esc(recurrenceText(j.schedule, d, x => _fmt(x, j.plant)))}</td>`
    + `<td class="job-mono">${next}</td>`
    + `<td>${lr ? `${statusBadgeHtml(lr.status, d)} <span class="job-sub job-mono">${esc(_fmt(lr.ended_at ?? lr.started_at ?? lr.scheduled_for, j.plant))}</span>` : `<span class="job-sub">${esc(t('jobs.never_run'))}</span>`}</td>`
    + `<td class="job-actions"><button type="button" class="icon-btn sm" data-jobs-menu="${j.id}" data-ovf-key="job-${j.id}" aria-haspopup="menu" aria-label="${esc(t('jobs.row_actions'))}">⋯</button></td></tr>`;
}

function _jobsTableHtml(): string {
  if (!_jobs.length) return `<div class="empty-state job-empty">${esc(_plant || _q || _status || _type ? t('jobs.empty_filtered') : t('jobs.empty'))}</div>`;
  return `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_name'), t('jobs.col_plant'), t('jobs.col_recurrence'), t('jobs.col_next'), t('jobs.col_last'), ''].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_jobs.map(_jobRowHtml).join('')}</tbody></table></div>`
    + (_nextBeforeJob != null ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-act="more-jobs">${esc(t('jobs.load_more'))}</button></div>` : '');
}

async function _loadJobs(append = false): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-table');
  if (!host) return;
  try {
    const res = await JobsClient.list({ plant: _plant, q: _q, status: _status, type: _type, limit: JOBS_PAGE, beforeId: append ? _nextBeforeJob : null });
    if (my !== _seq) return;
    _jobs = append ? [..._jobs, ...res.items.filter(x => !_jobs.some(y => y.id === x.id))] : res.items;
    _nextBeforeJob = res.nextBeforeId;
    host.innerHTML = _jobsTableHtml();
  } catch (e) {
    if (my === _seq) host.innerHTML = `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`;
  }
}

function _renderJobsTab(): void {
  const host = _el('jobs-view-jobs');
  if (!host) return;
  host.innerHTML = `${_jobsToolbarHtml()}<div id="jobs-table" aria-live="polite"></div>`;
  _mountPlantCombo('jobs', () => void _loadJobs());
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
      { id: 'pause', label: paused ? t('jobs.m_resume') : t('jobs.m_pause'), onSelect: () => void _setEnabled(j, paused) },
      { id: 'edit', label: t('jobs.m_edit'), onSelect: () => JobsDialog.open({ job: j, onSaved: () => void _loadJobs() }) },
      { id: 'dup', label: t('jobs.m_duplicate'), onSelect: () => JobsDialog.open({ job: j, duplicate: true, onSaved: () => void _loadJobs() }) },
      { id: 'copy', label: t('jobs.m_copy'), onSelect: () => JobsDialog.openCopy(j, () => void _loadJobs()) },
      { id: 'del', label: t('jobs.m_delete'), danger: true, onSelect: () => void _delete(j) },
    );
  }
  return items;
}

async function _runNow(j: Job): Promise<void> {
  try { await JobsClient.runNow(j.id); Toast.show(t('jobs.toast_run_started', { name: j.name }), 'success'); void _loadJobs(); }
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
  return `<tr class="job-run-row" data-run-id="${r.id}" tabindex="0"><td class="job-name">${esc(r.job_name)}</td><td class="job-mono">${esc(r.plant)}</td>`
    + `<td>${statusBadgeHtml(r.status, d)}</td><td class="job-mono">${esc(_fmt(r.scheduled_for ?? r.started_at, r.plant))}</td>`
    + `<td class="job-mono">${esc(durationText(r.duration_ms) || '—')}</td>`
    + `<td>${esc(r.trigger ? t(`jobs.trigger_${r.trigger}`) : '')}</td></tr>`;
}

function _runsListHtml(): string {
  if (!_runs.length) return `<div class="empty-state job-empty">${esc(t('jobs.runs_empty'))}</div>`;
  return `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_name'), t('jobs.col_plant'), t('jobs.col_status'), t('jobs.col_scheduled'), t('jobs.run_duration'), t('jobs.run_trigger')].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_runs.map(_runRowHtml).join('')}</tbody></table></div>`
    + (_nextBefore != null ? `<div class="job-pager"><button type="button" class="btn btn-ghost sm" data-jobs-act="more-runs">${esc(t('jobs.load_more'))}</button></div>` : '');
}

/** 'replace' = a fresh first page (filters changed, Refresh); 'append' = Load more; 'refresh' = the poll: page 1 is
 *  merged into what is loaded, so extra pages the viewer already pulled stay (and so does their cursor). */
async function _loadRuns(mode: 'replace' | 'append' | 'refresh' = 'replace'): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-runs-list');
  if (!host) return;
  try {
    const res = await JobsClient.runs({ plant: _plant, status: _status, beforeId: mode === 'append' ? _nextBefore : null });
    if (my !== _seq) return;
    if (mode === 'append') { _runs = mergeRuns(_runs, res.items); _nextBefore = res.nextBeforeId; _runPages++; }
    else if (mode === 'refresh' && _runPages > 1) _runs = mergeRuns(_runs, res.items);
    else { _runs = res.items; _nextBefore = res.nextBeforeId; _runPages = 1; }
    host.innerHTML = _runsListHtml();
  } catch (e) {
    if (my === _seq) host.innerHTML = `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`;
  }
}

function _renderRunsTab(): void {
  const host = _el('jobs-view-runs');
  if (!host) return;
  JobsRunDetail.stop();
  host.innerHTML = `<div id="jobs-runs-main"><div class="job-toolbar">${_plantFilterHtml('jobs-runs')}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-runs-status">${esc(t('jobs.col_status'))}</label><select class="input" id="jobs-runs-status">${_statusOptions(_status)}</select></div>`
    + `<button type="button" class="btn btn-ghost" data-jobs-act="refresh-runs">${esc(t('btn.refresh'))}</button></div>`
    + `<div id="jobs-runs-list" aria-live="polite"></div></div><div id="jobs-run-detail" hidden></div>`;
  _mountPlantCombo('jobs-runs', () => void _loadRuns());
  void _loadRuns();
  _armRunsPoll();
}

function _armRunsPoll(): void {
  if (_runsTimer) clearTimeout(_runsTimer);
  _runsTimer = null;
  if (!_visible() || _tab !== 'runs') return;
  _runsTimer = setTimeout(() => {
    _runsTimer = null;
    if (_visible() && _tab === 'runs' && !JobsRunDetail.isOpen()) void _loadRuns('refresh');
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
    tz: plantTimezone(run.plant),
    onBack: () => { JobsRunDetail.stop(); det.hidden = true; main.hidden = false; void _loadRuns('refresh'); },
    // The open run changed state: fold page 1 into the list (never replace it, later pages stay loaded).
    onChanged: () => { void JobsClient.runs({ plant: _plant, status: _status }).then(r => { if (r.items.some(x => x.id === id)) _runs = mergeRuns(_runs, r.items); }).catch(() => undefined); },
  });
}

function _gotoRuns(j: Job): void {
  _plant = j.plant; _status = '';
  _setTab('runs');
}

/* ---------------------------------------------------------------------------
   Upcoming sub-tab: the next-N list across the viewer's plants, and a 7-day strip for one plant
   ------------------------------------------------------------------------- */
async function _loadUpcoming(): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-upcoming-body');
  if (!host) return;
  host.innerHTML = `<div class="empty-state job-empty">${esc(t('jobs.loading'))}</div>`;
  try {
    // One server call: GET /jobs/upcoming, soonest first across the viewer's visible jobs (a plant narrows it).
    // The 7-day strip needs the whole week, so a chosen plant asks for more entries than the list shows.
    // The server caps the list at 50 soonest-first entries: a busy plant can fill it before the week ends, which
    // the strip then says (stripCompleteThrough) instead of silently showing a short week.
    _upcomingRequested = _stripPlant ? 50 : 20;
    const entries: UpcomingEntry[] = await JobsClient.upcomingAll(_stripPlant, _upcomingRequested);
    if (my !== _seq) return;
    _upcoming = entries.map(e => ({ at: stripOffset(e.atLocal), jobId: e.jobId, jobName: e.jobName, plant: e.plant }));
    host.innerHTML = _upcomingHtml();
  } catch (e) {
    if (my === _seq) host.innerHTML = `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`;
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
  return strip + `<ol class="job-upcoming">${list.map(r => `<li><span class="job-mono">${esc(Util.fmtDTPref(r.at))}</span> <span>${esc(r.jobName)}</span> <span class="job-sub job-mono">${esc(r.plant ?? '')}</span></li>`).join('')}</ol>`;
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
  for (const k of ['jobs', 'runs', 'upcoming'] as const) { const v = _el(`jobs-view-${k}`); if (v) v.hidden = k !== tab; }
  if (tab === 'jobs') _renderJobsTab();
  else if (tab === 'runs') _renderRunsTab();
  else _renderUpcomingTab();
  if (tab !== 'runs' && _runsTimer) { clearTimeout(_runsTimer); _runsTimer = null; }
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
    const runRow = target.closest<HTMLElement>('[data-run-id]');
    if (runRow) { void _openRun(Number(runRow.dataset.runId)); return; }
    const act = target.closest<HTMLElement>('[data-jobs-act]')?.dataset.jobsAct;
    if (act === 'new') JobsDialog.open({ plant: _plant, defaults: _types.find(x => x.key === 'optimizer.plant')?.defaults, onSaved: () => void _loadJobs() });
    else if (act === 'more-jobs') void _loadJobs(true);
    else if (act === 'more-runs') void _loadRuns('append');
    else if (act === 'refresh-runs') void _loadRuns();
    else if (act === 'runs-of') { const j = _jobs.find(x => x.id === Number((target.closest<HTMLElement>('[data-job-id]'))?.dataset.jobId)); if (j) _gotoRuns(j); }
  });
  pane.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.job-run-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void _openRun(Number(row.dataset.runId)); }
  });
  pane.addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).id;
    const v = (e.target as HTMLSelectElement).value;
    if (id === 'jobs-type') { _type = v; void _loadJobs(); }
    else if (id === 'jobs-status') { _status = v; void _loadJobs(); }
    else if (id === 'jobs-runs-status') { _status = v; void _loadRuns(); }
  });
  pane.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'jobs-q') return;
    _q = (e.target as HTMLInputElement).value;
    if (_qTimer) clearTimeout(_qTimer);
    _qTimer = setTimeout(() => void _loadJobs(), 250);
  });
  document.addEventListener('visibilitychange', () => {
    if (_active && _tab === 'runs' && !document.hidden) { void _loadRuns('refresh'); _armRunsPoll(); JobsRunDetail.resume(); }
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
    _setTab(_tab);
  },

  /** Test seam: switch the sub-view the way a tab click does. */
  _setTab(tab: SubTab): void { _setTab(tab); },

  setActive(on: boolean): void {
    _active = on;
    if (!on) {
      if (_runsTimer) { clearTimeout(_runsTimer); _runsTimer = null; }
      OverflowMenu.closeAll();
      JobsRunDetail.stop();
    }
  },
};
