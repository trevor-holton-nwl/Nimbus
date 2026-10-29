/* =============================================================================
   JOB DIALOG — create / edit / duplicate a job, and "Copy to plants…".

   The static shell (#modal-job-edit) lives in index.html; this module fills the body (#jb-body)
   and footer (#jb-foot) at runtime and opens/closes it through Modal.open/close. Admin only: the
   pane never offers the entry points to anyone else and the server re-checks every write.

   Save = POST /jobs with the schedule inline (create) or PATCH /jobs + PATCH the job's one schedule (edit).
   The recurrence goes to the server as a PRESET kind (time_of_day, days_of_week, day_of_month); the
   server compiles the cron and previews it with its own trigger (POST /jobs/schedules/preview), so
   what the planner sees is what will fire.
   The searchable plant combobox here is the deliberate duplicate the frontend CLAUDE.md allows.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import { JobsClient } from './jobs-client.mjs';
import type { Job } from './jobs-client.mjs';
import {
  RECUR_PRESETS, JOB_MODES, JOB_SEARCHES, JOB_RESULTS, NAME_MAX, defaultJobForm, jobToForm, validateJobForm, buildJobPayload,
  recurrenceText, stripOffset, dowLabelKey,
} from './jobs-model.mjs';
import type { JobForm, FormErrors, Recurrence, JobsDeps } from './jobs-model.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

/** Injected into the pure model. fmtTime follows the viewer's time-format preference. */
export const jobsDeps = (): JobsDeps => ({
  t, esc, fmtTime: (h, m) => Util._fmtTimePref(new Date(2000, 0, 1, h, m)),
});

/** Plants the viewer may use: the known plants, narrowed to role_plants scope. */
export function allowedPlantList(): string[] {
  const all = Store.knownPlants();
  const scope = Session.allowedPlants();
  return scope ? all.filter(p => scope.includes(p)) : all;
}

export function plantTimezone(plant: string): string {
  const row = Store.masterData?.plants?.find(p => p.plant === plant);
  return typeof row?.timezone === 'string' ? row.timezone.trim() : '';
}

/* ---------------------------------------------------------------------------
   Searchable combobox (copy of master-data's / distribution's _mkCombobox; never chips)
   ------------------------------------------------------------------------- */
const _comboAborts = new WeakMap<HTMLElement, AbortController>();

export function mkCombobox(host: HTMLElement | null, options: string[], opts: { value?: string; placeholder?: string; disabled?: boolean; id?: string; onSelect?: (v: string) => void } = {}): void {
  if (!host) return;
  _comboAborts.get(host)?.abort();
  const ac = new AbortController();
  _comboAborts.set(host, ac);
  const { value = '', placeholder = '', onSelect } = opts;
  host.innerHTML = `<div class="hps-combobox job-combobox">`
    + `<input type="text"${opts.id ? ` id="${esc(opts.id)}"` : ''} class="hps-input" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off" spellcheck="false" aria-haspopup="listbox" aria-expanded="false"${opts.disabled ? ' disabled' : ''}>`
    + `<button type="button" class="hps-clear" hidden aria-label="${esc(t('btn.clear'))}">&times;</button>`
    + `<div class="hps-dropdown" role="listbox" hidden></div></div>`;
  const root = host.querySelector('.hps-combobox') as HTMLElement | null;
  if (!root) return;   // a host that does not parse markup (the node test stub)
  const input = root.querySelector('.hps-input') as HTMLInputElement;
  const clearBtn = root.querySelector('.hps-clear') as HTMLButtonElement;
  const dd = root.querySelector('.hps-dropdown') as HTMLElement;
  let filtered: string[] = [];
  let active = -1;
  let isOpen = false;
  let selected = value;

  const reflect = (): void => { input.value = selected || ''; root.classList.toggle('has-value', !!selected); clearBtn.hidden = !selected || !!opts.disabled; };
  const hl = (): void => {
    const items = dd.querySelectorAll('.hps-option');
    items.forEach((el, i) => el.classList.toggle('active', i === active));
    items[active]?.scrollIntoView({ block: 'nearest' });
  };
  const render = (query: string): void => {
    const q = (query || '').trim().toLowerCase();
    const filterQ = selected && q === selected.toLowerCase() ? '' : q;
    filtered = filterQ ? options.filter(o => o.toLowerCase().includes(filterQ)) : options.slice();
    if (!filtered.length) { dd.innerHTML = `<div class="hps-empty">${esc(options.length ? t('ui.no_matches') : t('ui.no_options'))}</div>`; active = -1; return; }
    dd.innerHTML = filtered.map((o, i) => `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${esc(o)}</div>`).join('');
    active = Math.max(0, filtered.indexOf(selected));
    hl();
    dd.querySelectorAll('.hps-option').forEach((el, i) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(filtered[i]); }));
  };
  const openDd = (): void => { dd.hidden = false; isOpen = true; input.setAttribute('aria-expanded', 'true'); };
  const closeDd = (): void => { dd.hidden = true; isOpen = false; active = -1; input.setAttribute('aria-expanded', 'false'); };
  function pick(o: string): void { selected = o; reflect(); closeDd(); input.blur(); onSelect?.(o); }

  input.addEventListener('focus', () => { render(input.value); openDd(); });
  input.addEventListener('input', () => { render(input.value); openDd(); });
  input.addEventListener('keydown', (e) => {
    if (!isOpen) { if (e.key === 'ArrowDown' || e.key === 'Enter') { render(input.value); openDd(); e.preventDefault(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); hl(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); hl(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeDd(); reflect(); input.blur(); }
  });
  input.addEventListener('blur', () => { setTimeout(() => { closeDd(); reflect(); }, 120); });
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => { selected = ''; reflect(); onSelect?.(''); input.focus(); });
  document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); }, { signal: ac.signal });
  reflect();
}

/* ---------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
type DialogMode = 'new' | 'edit' | 'copy';
interface DialogState {
  mode: DialogMode;
  job: Job | null;
  form: JobForm;
  /** Copy mode: target plants (checked) and the filter text. */
  targets: Set<string>;
  filter: string;
  busy: boolean;
  /** JSON of the form as opened; Escape / X ask before discarding when the live form differs. */
  baseline: string;
  previewSeq: number;
  previewTimer: ReturnType<typeof setTimeout> | null;
  onSaved: (() => void) | null;
}
let _s: DialogState | null = null;

const _el = <E extends HTMLElement = HTMLElement>(id: string): E | null => document.getElementById(id) as E | null;
const _val = (id: string): string => (_el<HTMLInputElement>(id)?.value ?? '');
const _chk = (id: string): boolean => !!_el<HTMLInputElement>(id)?.checked;

const DOW_ORDER = [0, 1, 2, 3, 4, 5, 6];   // backend numbering, Monday first

/* ---------------------------------------------------------------------------
   Markup
   ------------------------------------------------------------------------- */
function _opt(value: string, label: string, sel: string): string {
  return `<option value="${esc(value)}"${value === sel ? ' selected' : ''}>${esc(label)}</option>`;
}
const _err = (field: string): string => `<div class="ape-err" id="jb-err-${field}" role="alert" hidden></div>`;

export function recurFieldsHtml(r: Recurrence): string {
  const time = `<div class="form-row"><label for="jb-time">${esc(t('jobs.f_time'))}</label>`
    + `<input class="input job-time" id="jb-time" type="time" value="${esc(r.time)}" step="60">${_err('time')}</div>`;
  switch (r.preset) {
    case 'once':
      return `<div class="form-row"><label for="jb-runat">${esc(t('jobs.f_run_at'))}</label>`
        + `<input class="input" id="jb-runat" type="datetime-local" value="${esc(r.runAt)}">${_err('runAt')}</div>`;
    case 'hourly':
      return `<div class="form-row"><label for="jb-minute">${esc(t('jobs.f_minute'))}</label>`
        + `<input class="input job-num" id="jb-minute" type="number" min="0" max="59" value="${esc(r.minute)}">${_err('minute')}</div>`;
    case 'weekly':
      return time + `<div class="form-row"><label>${esc(t('jobs.f_days'))}</label><div class="job-dows" role="group" aria-label="${esc(t('jobs.f_days'))}">`
        + DOW_ORDER.map(d => `<label class="chk-inline"><input type="checkbox" id="jb-dow-${d}"${r.days.includes(d) ? ' checked' : ''}><span>${esc(t(dowLabelKey(d)))}</span></label>`).join('')
        + `</div>${_err('days')}</div>`;
    case 'monthly':
      return time + `<div class="form-row"><label for="jb-dom">${esc(t('jobs.f_dom'))}</label>`
        + `<input class="input job-num" id="jb-dom" type="number" min="1" max="31" value="${esc(r.dom)}">${_err('dom')}</div>`;
    case 'cron':
      return `<div class="form-row"><label for="jb-cron">${esc(t('jobs.f_cron'))}</label>`
        + `<input class="input job-mono" id="jb-cron" type="text" value="${esc(r.cron)}" placeholder="0 8 * * 1-5" autocomplete="off" spellcheck="false">`
        + `<div class="ape-hint">${esc(t('jobs.f_cron_hint'))}</div>${_err('cron')}</div>`;
    default:
      return time;
  }
}

export function bodyHtml(f: JobForm, mode: DialogMode, isAdmin: boolean): string {
  const tz = plantTimezone(f.plant);
  return `<div class="job-form">`
    + `<div class="form-row"><label for="jb-name">${esc(t('jobs.f_name'))}</label>`
    + `<input class="input" id="jb-name" type="text" maxlength="${NAME_MAX}" value="${esc(f.name)}" autocomplete="off">${_err('name')}</div>`
    + `<div class="form-row-2"><div class="form-row"><label>${esc(t('jobs.f_type'))}</label><div class="readonly" id="jb-type">${esc(t('jobs.type_optimizer'))}</div></div>`
    + `<div class="form-row"><label for="jb-plant">${esc(t('jobs.f_plant'))}</label><div id="jb-plant-host"></div>${_err('plant')}</div></div>`
    + `<div class="form-row-2"><div class="form-row"><label for="jb-mode">${esc(t('jobs.f_mode'))}</label><select class="input" id="jb-mode">`
    + JOB_MODES.map(m => _opt(m, t('jobs.mode_' + m), f.mode)).join('') + `</select>${_err('mode')}</div>`
    + `<div class="form-row"><label for="jb-search">${esc(t('jobs.f_search'))}</label><select class="input" id="jb-search">`
    + JOB_SEARCHES.map(s => _opt(s, t(`jobs.search_${s}`), f.search)).join('') + `</select>${_err('search')}</div></div>`
    + `<div class="ape-hint" id="jb-search-note">${esc(t('jobs.search_note'))}</div>`
    + `<div class="form-row job-checks"><label class="chk-inline"><input type="checkbox" id="jb-firmed"${f.respectFirmed ? ' checked' : ''}><span>${esc(t('jobs.f_firmed'))}</span></label></div>`
    + `<div class="form-row"><label for="jb-result">${esc(t('jobs.f_result'))}</label><select class="input" id="jb-result"${isAdmin ? '' : ' disabled'}>`
    + JOB_RESULTS.map(r => _opt(r, t(`jobs.result_${r}`), f.result)).join('') + `</select>`
    + `<div class="ape-hint">${esc(t('jobs.result_hint'))}</div>${_err('result')}</div>`
    + `<fieldset class="job-recur"><legend>${esc(t('jobs.f_recurrence'))}</legend>`
    + `<div class="form-row"><label for="jb-recur">${esc(t('jobs.f_repeat'))}</label><select class="input" id="jb-recur">`
    + RECUR_PRESETS.map(p => _opt(p, t(`jobs.preset_${p}`), f.recur.preset)).join('') + `</select></div>`
    + `<div id="jb-recur-fields">${recurFieldsHtml(f.recur)}</div>`
    + `<div class="form-row"><label>${esc(t('jobs.f_tz'))}</label><div class="readonly job-mono" id="jb-tz">${esc(tz || t('jobs.tz_unknown'))}</div>`
    + `<div class="ape-hint">${esc(t('jobs.tz_hint'))}</div></div>`
    + `<div class="form-row-2"><div class="form-row"><label for="jb-from">${esc(t('jobs.f_valid_from'))}</label><input class="input" id="jb-from" type="date" value="${esc(f.validFrom)}"></div>`
    + `<div class="form-row"><label for="jb-until">${esc(t('jobs.f_valid_until'))}</label><input class="input" id="jb-until" type="date" value="${esc(f.validUntil)}"></div></div>${_err('validity')}`
    + `<label class="chk-inline"><input type="checkbox" id="jb-overlap"${f.skipIfRunning ? ' checked' : ''}><span>${esc(t('jobs.f_skip_overlap'))}</span></label>`
    + `<div class="job-preview" id="jb-preview" aria-live="polite"></div></fieldset></div>`;
}

export function copyRowsHtml(job: Job, targets: Set<string>, filter: string): string {
  const q = filter.trim().toLowerCase();
  const plants = allowedPlantList().filter(p => p !== job.plant && (!q || p.toLowerCase().includes(q)));
  return plants.length
    ? plants.map(p => `<label class="chk-inline job-copy-row"><input type="checkbox" data-jb-plant="${esc(p)}"${targets.has(p) ? ' checked' : ''}><span>${esc(p)}</span></label>`).join('')
    : `<div class="hps-empty">${esc(t('ui.no_matches'))}</div>`;
}

export function copyBodyHtml(job: Job, targets: Set<string>, filter: string): string {
  const rows = copyRowsHtml(job, targets, filter);
  return `<div class="job-form"><p class="ape-hint">${esc(t('jobs.copy_hint', { name: job.name }))}</p>`
    + `<div class="form-row"><input class="input" id="jb-copy-filter" type="search" value="${esc(filter)}" placeholder="${esc(t('jobs.copy_search'))}" aria-label="${esc(t('jobs.copy_search'))}" autocomplete="off"></div>`
    + `<div class="job-copy-actions"><button type="button" class="btn btn-ghost sm" data-jb-act="all">${esc(t('jobs.copy_all_shown'))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jb-act="none">${esc(t('jobs.copy_clear'))}</button>`
    + `<span class="ape-hint" id="jb-copy-count">${esc(t('jobs.copy_count', { n: targets.size }))}</span></div>`
    + `<div class="job-copy-list" id="jb-copy-list">${rows}</div></div>`;
}

function _footHtml(): string {
  const label = _s?.mode === 'copy' ? t('jobs.copy_btn') : t('btn.save');
  return `<button type="button" class="btn btn-ghost" data-jb-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" id="jb-save" data-jb-act="save">${esc(label)}</button>`;
}

/* ---------------------------------------------------------------------------
   Form <-> DOM
   ------------------------------------------------------------------------- */
/** Read the live fields into a JobForm (plant and job type come from state: the combobox owns the plant). */
export function readForm(prev: JobForm): JobForm {
  const preset = (_val('jb-recur') || prev.recur.preset) as Recurrence['preset'];
  const days = [0, 1, 2, 3, 4, 5, 6].filter(d => _chk(`jb-dow-${d}`));
  const recur: Recurrence = {
    ...prev.recur, preset,
    time: _el('jb-time') ? _val('jb-time') : prev.recur.time,
    minute: _el('jb-minute') ? Number(_val('jb-minute')) : prev.recur.minute,
    days: _el('jb-dow-1') ? days : prev.recur.days,
    dom: _el('jb-dom') ? Number(_val('jb-dom')) : prev.recur.dom,
    cron: _el('jb-cron') ? _val('jb-cron') : prev.recur.cron,
    runAt: _el('jb-runat') ? _val('jb-runat') : prev.recur.runAt,
  };
  return {
    ...prev, name: _val('jb-name'), mode: _val('jb-mode') || prev.mode, search: _val('jb-search') || prev.search,
    respectFirmed: _chk('jb-firmed'),
    result: _val('jb-result') || prev.result, recur,
    validFrom: _val('jb-from'), validUntil: _val('jb-until'), skipIfRunning: _chk('jb-overlap'),
  };
}

function _showErrors(errs: FormErrors): void {
  for (const f of ['name', 'plant', 'mode', 'search', 'result', 'time', 'minute', 'days', 'dom', 'cron', 'runAt', 'validity'] as const) {
    const el = _el(`jb-err-${f}`);
    if (!el) continue;
    el.textContent = errs[f] ? t(errs[f] as string) : '';
    el.hidden = !errs[f];
  }
}

/* ---------------------------------------------------------------------------
   Server preview (next 5 + prose + DST warning)
   ------------------------------------------------------------------------- */
function _schedulePreview(): void {
  const s = _s;
  if (!s || s.mode === 'copy') return;
  if (s.previewTimer) clearTimeout(s.previewTimer);
  s.previewTimer = setTimeout(() => void _runPreview(), 300);
}

async function _runPreview(): Promise<void> {
  const s = _s;
  const box = _el('jb-preview');
  if (!s || !box) return;
  s.form = readForm(s.form);
  const r = s.form.recur;
  // The form-level check only gates the request; the server's trigger is the authority on what is valid.
  const errs = validateJobForm({ ...s.form, name: s.form.name || 'x' }, { isAdmin: true, plants: null });
  const bad = r.preset === 'once' ? !!errs.runAt : r.preset === 'hourly' ? !!errs.minute : r.preset === 'cron' ? !!errs.cron
    : !!(errs.time || errs.days || errs.dom);
  if (bad || !s.form.plant) { box.innerHTML = ''; return; }
  const seq = ++s.previewSeq;
  try {
    const p = buildJobPayload(s.form).schedule;
    const prose = recurrenceText(p, jobsDeps(), x => Util.fmtDTPref(x));
    const res = await JobsClient.preview(s.form.plant, p, 5);
    if (_s !== s || seq !== s.previewSeq) return;
    box.innerHTML = `<div class="job-preview-head">${esc(t('jobs.next_runs'))} <span class="ape-hint">${esc(prose)}</span></div>`
      + (res.entries.length ? `<ol class="job-preview-list">${res.entries.map(x => `<li class="job-mono">${esc(Util.fmtDTPref(stripOffset(x.atLocal)))}</li>`).join('')}</ol>` : `<div class="ape-hint">${esc(t('jobs.no_runs'))}</div>`)
      + (res.entries.some(x => x.dstShifted) ? `<div class="job-dst" role="note">${esc(t('jobs.dst_warning'))}</div>` : '');
  } catch (e) {
    if (_s !== s || seq !== s.previewSeq) return;
    box.innerHTML = `<div class="ape-err">${esc((e as Error).message)}</div>`;
  }
}

/* ---------------------------------------------------------------------------
   Wiring + lifecycle
   ------------------------------------------------------------------------- */
function _wire(): void {
  const shell = _el('modal-job-edit') as (HTMLElement & { _jbWired?: boolean }) | null;
  if (!shell || shell._jbWired) return;
  shell._jbWired = true;
  const body = _el('jb-body');
  body?.addEventListener('change', (e) => {
    const s = _s; const id = (e.target as HTMLElement | null)?.id ?? '';
    if (!s) return;
    if (s.mode === 'copy') {
      const p = (e.target as HTMLElement).dataset?.jbPlant;
      if (p) { if ((e.target as HTMLInputElement).checked) s.targets.add(p); else s.targets.delete(p); _copyCount(); }
      return;
    }
    if (id === 'jb-recur') {
      s.form = readForm(s.form);
      const host = _el('jb-recur-fields');
      if (host) host.innerHTML = recurFieldsHtml(s.form.recur);
    }
    _schedulePreview();
  });
  body?.addEventListener('input', (e) => {
    const id = (e.target as HTMLElement | null)?.id ?? '';
    if (id === 'jb-copy-filter' && _s?.mode === 'copy' && _s.job) {
      _s.filter = _val('jb-copy-filter');
      const list = _el('jb-copy-list');
      if (list) list.innerHTML = copyRowsHtml(_s.job, _s.targets, _s.filter);
    } else if (_s && _s.mode !== 'copy' && id !== 'jb-name') _schedulePreview();
  });
  body?.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-jb-act]')?.dataset.jbAct;
    if (act === 'all' || act === 'none') JobsDialog.copyBulk(act);
  });
  _el('jb-foot')?.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-jb-act]')?.dataset.jbAct;
    if (act === 'cancel') JobsDialog.close();
    else if (act === 'save') void JobsDialog.submit();
  });
  _el('jb-close')?.addEventListener('click', () => void JobsDialog.requestClose());
  shell.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) void JobsDialog.requestClose(); });
}

function _copyCount(): void {
  const el = _el('jb-copy-count');
  if (el && _s) el.textContent = t('jobs.copy_count', { n: _s.targets.size });
}

function _show(title: string): void {
  const h = _el('jb-title');
  if (h) h.textContent = title;
  const foot = _el('jb-foot');
  if (foot) foot.innerHTML = _footHtml();
  Modal.open('modal-job-edit');
}

export const JobsDialog = {
  /** `job` edits it; `duplicate` seeds a new job from it (name cleared, same plant). */
  open(opts: { job?: Job; duplicate?: boolean; plant?: string; defaults?: Record<string, unknown>; onSaved?: () => void }): void {
    if (!Session.isAdmin()) return;
    const { job, duplicate } = opts;
    const mode: DialogMode = job && !duplicate ? 'edit' : 'new';
    // A new job is seeded from the server's parameter defaults (GET /jobs/types), else the product defaults (propose).
    const form = job ? jobToForm(job) : defaultJobForm(opts.plant ?? '', 'optimizer.plant', opts.defaults ?? null);
    if (duplicate) form.name = '';
    _s = { mode, job: job && !duplicate ? job : null, form, targets: new Set(), filter: '', busy: false, baseline: JSON.stringify(form), previewSeq: 0, previewTimer: null, onSaved: opts.onSaved ?? null };
    _wire();
    const body = _el('jb-body');
    if (body) body.innerHTML = bodyHtml(form, mode, Session.isAdmin());
    mkCombobox(_el('jb-plant-host'), allowedPlantList(), {
      value: form.plant, placeholder: t('jobs.f_plant'), id: 'jb-plant', disabled: mode === 'edit',
      onSelect: (v) => { if (!_s) return; _s.form.plant = v; const tz = _el('jb-tz'); if (tz) tz.textContent = plantTimezone(v) || t('jobs.tz_unknown'); _schedulePreview(); },
    });
    _show(mode === 'edit' ? t('jobs.title_edit') : t('jobs.title_new'));
    _s.baseline = JSON.stringify(readForm(form));   // read back from the rendered fields, so dirty = a real edit
    _el('jb-name')?.focus();
    void _runPreview();
  },

  /** Copy one job's definition and schedule to many plants (one POST /jobs + schedule per plant, each in its own plant timezone). */
  openCopy(job: Job, onSaved?: () => void): void {
    if (!Session.isAdmin()) return;
    _s = { mode: 'copy', job, form: jobToForm(job), targets: new Set(), filter: '', busy: false, baseline: '', previewSeq: 0, previewTimer: null, onSaved: onSaved ?? null };
    _wire();
    const body = _el('jb-body');
    if (body) body.innerHTML = copyBodyHtml(job, _s.targets, '');
    _show(t('jobs.title_copy'));
    _el('jb-copy-filter')?.focus();
  },

  copyBulk(act: 'all' | 'none'): void {
    const s = _s;
    if (!s || s.mode !== 'copy') return;
    const shown = Array.from(_el('jb-copy-list')?.querySelectorAll<HTMLInputElement>('[data-jb-plant]') ?? []);
    for (const cb of shown) {
      const p = cb.dataset.jbPlant as string;
      cb.checked = act === 'all';
      if (act === 'all') s.targets.add(p); else s.targets.delete(p);
    }
    _copyCount();
  },

  async submit(): Promise<void> {
    const s = _s;
    if (!s || s.busy) return;
    if (s.mode === 'copy') return _submitCopy(s);
    s.form = readForm(s.form);
    const errs = validateJobForm(s.form, { isAdmin: Session.isAdmin(), plants: Session.allowedPlants() });
    _showErrors(errs);
    if (Object.keys(errs).length) return;
    const { job, schedule } = buildJobPayload(s.form);
    s.busy = true;
    const btn = _el<HTMLButtonElement>('jb-save');
    if (btn) btn.disabled = true;
    try {
      if (s.job) {
        await JobsClient.update(s.job.id, { name: job.name, params: job.params });
        if (s.job.schedule) await JobsClient.updateSchedule(s.job.schedule.id, schedule);
        else await JobsClient.addSchedule(s.job.id, schedule);
      } else {
        await JobsClient.create({ ...job, schedules: [schedule] });
      }
      Toast.show(t('jobs.toast_saved'), 'success');
      const cb = s.onSaved;
      JobsDialog.close();
      cb?.();
    } catch (e) {
      Toast.show(t('jobs.toast_save_failed', { msg: (e as Error).message }), 'error');
    } finally {
      s.busy = false;
      if (btn) btn.disabled = false;
    }
  },

  /** Escape / X: close at once when nothing was changed, else ask first (Cancel is the default, the form stays open). */
  async requestClose(): Promise<void> {
    const s = _s;
    if (!s) return;
    if (s.mode !== 'copy' && s.baseline && JSON.stringify(readForm(s.form)) !== s.baseline) {
      const discard = await Modal.confirm({ title: t('jobs.confirm_discard'), message: t('jobs.confirm_discard_msg'), confirmLabel: t('btn.discard'), tone: 'warn' });
      if (!discard || _s !== s) return;
    }
    JobsDialog.close();
  },

  close(): void {
    if (_s?.previewTimer) clearTimeout(_s.previewTimer);
    _s = null;
    Modal.close('modal-job-edit');
  },

  /** Test seam. */
  _state(): DialogState | null { return _s; },
};

async function _submitCopy(s: DialogState): Promise<void> {
  const src = s.job;
  if (!src || !s.targets.size) { Toast.show(t('jobs.copy_none'), 'warn'); return; }
  const form = jobToForm(src);
  s.busy = true;
  let ok = 0; const failed: string[] = [];
  let reason = '';   // the first failure's message: usually the same for every plant (e.g. no timezone)
  for (const plant of [...s.targets]) {
    try {
      const { job, schedule } = buildJobPayload({ ...form, plant });
      await JobsClient.create({ ...job, schedules: [schedule] });
      ok++;
    } catch (e) { failed.push(plant); if (!reason) reason = (e as Error).message; }
  }
  s.busy = false;
  Toast.show(failed.length ? t('jobs.toast_copy_partial', { ok, failed: failed.join(', '), reason }) : t('jobs.toast_copy_done', { n: ok }), failed.length ? 'warn' : 'success');
  const cb = s.onSaved;
  if (!failed.length) JobsDialog.close(); else s.targets = new Set(failed);
  if (ok) cb?.();
}
