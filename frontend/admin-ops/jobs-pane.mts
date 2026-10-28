/* =============================================================================
   JOBS PANE — Admin > Jobs (#admin-jobs-pane): sub-tabs Jobs / Runs / Upcoming.

   Lifecycle (the DistributionPane / AlertMonitor shape): AdminCockpit._setSub('jobs') calls
   render() on every entry and setActive(false) on leave; init() wires the delegated handlers
   once. `_active` gates every timer: the Runs list polls every 15 s only while the Runs tab is
   showing and the document is visible; the open run's log polls itself (jobs-run-detail.mts).

   Admin controls (New, Run now, Pause, Edit, Duplicate, Copy, Delete) exist only for admins;
   other Admin-page users read jobs, runs and logs for Session.allowedPlants() (server re-checks).
   Plant is a searchable combobox, never chips; the jobs table is server-paginated (limit/offset)
   and the runs list pages by a before_id cursor. Module state only: no Store events.
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
  RUN_STATUSES, JOBS_PAGE, statusBadgeHtml, recurrenceText, pageRange, durationText, weekStrip, isoDayKey, addDays,
} from './jobs-model.mjs';
import type { UpcomingRun } from './jobs-model.mjs';

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
let _offset = 0;
let _jobs: Job[] = [];
let _total = 0;
let _runs: JobRun[] = [];
let _nextBefore: number | null = null;
let _upcoming: UpcomingRun[] = [];
let _stripPlant = '';
let _runsTimer: ReturnType<typeof setTimeout> | null = null;
let _seq = 0;                    // guards every async fetch against a newer one
let _qTimer: ReturnType<typeof setTimeout> | null = null;

const _el = <E extends HTMLElement = HTMLElement>(id: string): E | null => document.getElementById(id) as E | null;
const _isAdmin = (): boolean => Session.isAdmin();
const _fmt = (iso: string | null | undefined): string => (iso ? Util.fmtDTPref(iso) : '—');
const _visible = (): boolean => _active && !document.hidden && !!_el('admin-tab')?.classList.contains('active');

/* ---------------------------------------------------------------------------
   Shared filter bar
   ------------------------------------------------------------------------- */
function _plantFilterHtml(): string {
  return `<div class="job-field job-plant-field"><span class="job-field-l">${esc(t('jobs.f_plant'))}</span><div id="jobs-plant-host"></div></div>`;
}

function _mountPlantCombo(onChange: () => void): void {
  mkCombobox(_el('jobs-plant-host'), allowedPlantList(), {
    value: _plant, placeholder: t('jobs.all_plants'), id: 'jobs-plant',
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
  return `<div class="job-toolbar">${_plantFilterHtml()}`
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
  const next = paused ? `<span class="badge badge-muted">${esc(t('jobs.paused'))}</span>` : esc(_fmt(j.next_run_at));
  return `<tr data-job-id="${j.id}"><td class="job-name"><button type="button" class="job-link" data-jobs-act="runs-of" data-job-id="${j.id}">${esc(j.name)}</button>`
    + `<div class="job-sub">${esc(j.params.apply_mode === 'apply' ? t('jobs.result_apply') : t('jobs.result_propose'))} · ${esc(j.params.search === 'normal' ? t('jobs.search_normal') : t('jobs.search_exhaustive'))}</div></td>`
    + `<td class="job-mono">${esc(j.plant)}</td>`
    + `<td>${esc(recurrenceText(j.schedule, d, _fmt))}</td>`
    + `<td class="job-mono">${next}</td>`
    + `<td>${lr ? `${statusBadgeHtml(lr.status, d)} <span class="job-sub job-mono">${esc(_fmt(lr.ended_at))}</span>` : `<span class="job-sub">${esc(t('jobs.never_run'))}</span>`}</td>`
    + `<td class="job-actions"><button type="button" class="icon-btn sm" data-jobs-menu="${j.id}" data-ovf-key="job-${j.id}" aria-haspopup="menu" aria-label="${esc(t('jobs.row_actions'))}">⋯</button></td></tr>`;
}

function _jobsTableHtml(): string {
  if (!_jobs.length) return `<div class="empty-state job-empty">${esc(_plant || _q || _status || _type ? t('jobs.empty_filtered') : t('jobs.empty'))}</div>`;
  const r = pageRange(_offset, _jobs.length, _total);
  return `<div class="job-table-wrap"><table class="job-table"><thead><tr>`
    + [t('jobs.col_name'), t('jobs.col_plant'), t('jobs.col_recurrence'), t('jobs.col_next'), t('jobs.col_last'), ''].map(h => `<th scope="col">${esc(h)}</th>`).join('')
    + `</tr></thead><tbody>${_jobs.map(_jobRowHtml).join('')}</tbody></table></div>`
    + `<div class="job-pager"><span class="ape-hint">${esc(t('jobs.page_range', { from: r.from, to: r.to, total: _total }))}</span>`
    + `<button type="button" class="btn btn-ghost sm" data-jobs-act="prev"${_offset <= 0 ? ' disabled' : ''}>${esc(t('jobs.prev'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jobs-act="next"${_offset + _jobs.length >= _total ? ' disabled' : ''}>${esc(t('jobs.next'))}</button></div>`;
}

async function _loadJobs(): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-table');
  if (!host) return;
  try {
    const res = await JobsClient.list({ plant: _plant, q: _q, status: _status, type: _type, limit: JOBS_PAGE, offset: _offset });
    if (my !== _seq) return;
    // A delete on the last page can leave an empty page: step back once.
    if (!res.items.length && _offset > 0 && res.total > 0) { _offset = Math.max(0, _offset - JOBS_PAGE); return void _loadJobs(); }
    _jobs = res.items; _total = res.total;
    host.innerHTML = _jobsTableHtml();
  } catch (e) {
    if (my === _seq) host.innerHTML = `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`;
  }
}

function _renderJobsTab(): void {
  const host = _el('jobs-view-jobs');
  if (!host) return;
  host.innerHTML = `${_jobsToolbarHtml()}<div id="jobs-table" aria-live="polite"></div>`;
  _mountPlantCombo(() => { _offset = 0; void _loadJobs(); });
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
  try { await JobsClient.runNow(j.id); Toast.show(t('jobs.toast_run_started', { name: j.name }), 'ok'); void _loadJobs(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'err'); }
}
async function _setEnabled(j: Job, enabled: boolean): Promise<void> {
  try { await JobsClient.setEnabled(j.id, enabled); void _loadJobs(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'err'); }
}
async function _delete(j: Job): Promise<void> {
  const ok = await Modal.confirm({ title: t('jobs.confirm_delete', { name: j.name }), message: t('jobs.confirm_delete_msg'), confirmLabel: t('jobs.m_delete'), tone: 'danger' });
  if (!ok) return;
  try { await JobsClient.remove(j.id); Toast.show(t('jobs.toast_deleted'), 'ok'); void _loadJobs(); }
  catch (e) { Toast.show(t('jobs.toast_action_failed', { msg: (e as Error).message }), 'err'); }
}

/* ---------------------------------------------------------------------------
   Runs sub-tab
   ------------------------------------------------------------------------- */
function _runRowHtml(r: JobRun): string {
  const d = jobsDeps();
  return `<tr class="job-run-row" data-run-id="${r.id}" tabindex="0"><td class="job-name">${esc(r.job_name)}</td><td class="job-mono">${esc(r.plant)}</td>`
    + `<td>${statusBadgeHtml(r.status, d)}</td><td class="job-mono">${esc(_fmt(r.scheduled_for ?? r.started_at))}</td>`
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

async function _loadRuns(append = false): Promise<void> {
  const my = ++_seq;
  const host = _el('jobs-runs-list');
  if (!host) return;
  try {
    const res = await JobsClient.runs({ plant: _plant, status: _status, beforeId: append ? _nextBefore : null });
    if (my !== _seq) return;
    _runs = append ? [..._runs, ...res.items.filter(x => !_runs.some(y => y.id === x.id))] : res.items;
    _nextBefore = res.nextBeforeId;
    host.innerHTML = _runsListHtml();
  } catch (e) {
    if (my === _seq) host.innerHTML = `<div class="empty-state job-empty" role="alert">${esc(t('jobs.load_failed', { msg: (e as Error).message }))}</div>`;
  }
}

function _renderRunsTab(): void {
  const host = _el('jobs-view-runs');
  if (!host) return;
  JobsRunDetail.stop();
  host.innerHTML = `<div id="jobs-runs-main"><div class="job-toolbar">${_plantFilterHtml()}`
    + `<div class="job-field"><label class="job-field-l" for="jobs-status">${esc(t('jobs.col_status'))}</label><select class="input" id="jobs-status">${_statusOptions(_status)}</select></div>`
    + `<button type="button" class="btn btn-ghost" data-jobs-act="refresh-runs">${esc(t('btn.refresh'))}</button></div>`
    + `<div id="jobs-runs-list" aria-live="polite"></div></div><div id="jobs-run-detail" hidden></div>`;
  _mountPlantCombo(() => void _loadRuns());
  void _loadRuns();
  _armRunsPoll();
}

function _armRunsPoll(): void {
  if (_runsTimer) clearTimeout(_runsTimer);
  _runsTimer = null;
  if (!_visible() || _tab !== 'runs') return;
  _runsTimer = setTimeout(() => {
    _runsTimer = null;
    if (_visible() && _tab === 'runs' && !JobsRunDetail.isOpen()) void _loadRuns();
    _armRunsPoll();
  }, RUNS_POLL_MS);
}

function _openRun(id: number): void {
  const run = _runs.find(r => r.id === id);
  const main = _el('jobs-runs-main'); const det = _el('jobs-run-detail');
  if (!run || !main || !det) return;
  main.hidden = true; det.hidden = false;
  JobsRunDetail.show(det, run, {
    visible: _visible,
    onBack: () => { JobsRunDetail.stop(); det.hidden = true; main.hidden = false; void _loadRuns(); },
    onChanged: () => { void JobsClient.runs({ plant: _plant, status: _status }).then(r => { const f = r.items.find(x => x.id === id); if (f) { _runs = r.items; } }).catch(() => undefined); },
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
    // Jobs of the chosen plant only (the strip is per plant); the list view is bounded to the first page of enabled jobs.
    const jobs = (await JobsClient.list({ plant: _stripPlant || _plant, limit: JOBS_PAGE })).items.filter(j => j.enabled && !j.schedule?.paused);
    const per = await Promise.all(jobs.map(async j => ({ j, times: await JobsClient.upcoming(j.id, 10).catch(() => [] as string[]) })));
    if (my !== _seq) return;
    _upcoming = per.flatMap(x => x.times.map(at => ({ at, jobId: x.j.id, jobName: x.j.name, plant: x.j.plant }))).sort((a, b) => a.at.localeCompare(b.at));
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
  } else {
    strip = `<div class="ape-hint">${esc(t('jobs.strip_pick'))}</div>`;
  }
  return strip + `<ol class="job-upcoming">${list.map(r => `<li><span class="job-mono">${esc(Util.fmtDTPref(r.at))}</span> <span>${esc(r.jobName)}</span> <span class="job-sub job-mono">${esc(r.plant ?? '')}</span></li>`).join('')}</ol>`;
}

function _renderUpcomingTab(): void {
  const host = _el('jobs-view-upcoming');
  if (!host) return;
  host.innerHTML = `<div class="job-toolbar"><div class="job-field job-plant-field"><span class="job-field-l">${esc(t('jobs.f_plant'))}</span><div id="jobs-plant-host"></div></div></div><div id="jobs-upcoming-body"></div>`;
  mkCombobox(_el('jobs-plant-host'), allowedPlantList(), {
    value: _stripPlant, placeholder: t('jobs.pick_plant'), id: 'jobs-plant',
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
    if (runRow) { _openRun(Number(runRow.dataset.runId)); return; }
    const act = target.closest<HTMLElement>('[data-jobs-act]')?.dataset.jobsAct;
    if (act === 'new') JobsDialog.open({ plant: _plant, onSaved: () => void _loadJobs() });
    else if (act === 'prev') { _offset = Math.max(0, _offset - JOBS_PAGE); void _loadJobs(); }
    else if (act === 'next') { _offset += JOBS_PAGE; void _loadJobs(); }
    else if (act === 'more-runs') void _loadRuns(true);
    else if (act === 'refresh-runs') void _loadRuns();
    else if (act === 'runs-of') { const j = _jobs.find(x => x.id === Number((target.closest<HTMLElement>('[data-job-id]'))?.dataset.jobId)); if (j) _gotoRuns(j); }
  });
  pane.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.job-run-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); _openRun(Number(row.dataset.runId)); }
  });
  pane.addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).id;
    const v = (e.target as HTMLSelectElement).value;
    if (id === 'jobs-type') { _type = v; _offset = 0; void _loadJobs(); }
    else if (id === 'jobs-status') { _status = v; _offset = 0; if (_tab === 'runs') void _loadRuns(); else void _loadJobs(); }
  });
  pane.addEventListener('input', (e) => {
    if ((e.target as HTMLElement).id !== 'jobs-q') return;
    _q = (e.target as HTMLInputElement).value;
    if (_qTimer) clearTimeout(_qTimer);
    _qTimer = setTimeout(() => { _offset = 0; void _loadJobs(); }, 250);
  });
  document.addEventListener('visibilitychange', () => {
    if (_active && _tab === 'runs' && !document.hidden) { void _loadRuns(); _armRunsPoll(); JobsRunDetail.resume(); }
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

  setActive(on: boolean): void {
    _active = on;
    if (!on) {
      if (_runsTimer) { clearTimeout(_runsTimer); _runsTimer = null; }
      OverflowMenu.closeAll();
      JobsRunDetail.stop();
    }
  },
};
