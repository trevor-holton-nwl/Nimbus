/* =============================================================================
   JOB DIALOG — create / edit / duplicate a job (one job, one or many plants).

   The static shell (#modal-job-edit) lives in index.html; this module fills the body (#jb-body)
   and footer (#jb-foot) at runtime and opens/closes it through Modal.open/close. Admin only: the
   pane never offers the entry points to anyone else and the server re-checks every write.

   Save = POST /jobs with the schedule inline (create) or PATCH /jobs + PATCH the job's one schedule (edit).
   The recurrence goes to the server as a PRESET kind (time_of_day, days_of_week, day_of_month); the
   server compiles the cron and previews it with its own trigger (POST /jobs/schedules/preview), so
   what the planner sees is what will fire.
   Targets (W3a): Single plant (default, today's job) | Selected plants | All plants I can access | Subnetwork, as radios over a
   searchable checkbox list (never chips), exclusions for All / Subnetwork, a live expansion line from POST /jobs/targets/preview,
   fan-out settings under Advanced. The schedule's time zone is each plant's own, one fixed zone, or UTC.
   The searchable plant combobox here is the deliberate duplicate the frontend CLAUDE.md allows.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import { JobsClient } from './jobs-client.mjs';
import type { Job, JobType } from './jobs-client.mjs';
import {
  RECUR_PRESETS, NAME_MAX, WINDOW_CHOICES, WINDOW_ANCHORS, WINDOW_UNITS, WINDOW_OPEN_START, defaultJobForm, jobToForm,
  validateJobForm, buildJobPayload, recurrenceText, stripOffset, dowLabelKey, seedParams, resultOf, findType, hasApplyMode, typeGroups,
  typeLabel, paramLabel, enumLabel, paramHint, windowToUi, uiToWindow, validateWindowUi,
  TARGET_MODES, TZ_MODES, STAGGER_MAX, PARALLEL_MAX, buildTargetRows, filterPlants, targetsPreviewText, plural, TARGET_ROWS_MAX, targetRowCount, timeZoneList, tzShort,
  DST_GAPS, DST_OVERLAPS, WINDOW_ACTIONS, MONTHLY_MODES, GRACE_MAX_MIN, closedDayChoices, policyToOptions, policyNoteText, skipReasonCodeText,
} from './jobs-model.mjs';
import type { JobForm, FormErrors, Recurrence, JobsDeps, TypeMeta, ParamMeta, DateWindow, WindowUi, TargetMode, TzMode, PolicyForm } from './jobs-model.mjs';
import type { SkippedEntry } from './jobs-client.mjs';

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

/** Subnetwork codes the plants list knows (the Subnetwork target picks one of these). */
export function subnetworkList(): string[] {
  const rows = (Store.masterData?.plants ?? []) as Array<{ subnetwork?: unknown }>;
  return [...new Set(rows.map(p => String(p.subnetwork ?? '').trim()).filter(Boolean))].sort();
}

export function plantTimezone(plant: string): string {
  const row = Store.masterData?.plants?.find(p => p.plant === plant);
  return typeof row?.timezone === 'string' ? row.timezone.trim() : '';
}

/* ---------------------------------------------------------------------------
   Searchable combobox (copy of master-data's / distribution's _mkCombobox; never chips)
   ------------------------------------------------------------------------- */
const _comboAborts = new WeakMap<HTMLElement, AbortController>();
const _comboByKey = new Map<string, AbortController>();

export function mkCombobox(host: HTMLElement | null, options: string[], opts: { value?: string; placeholder?: string; disabled?: boolean; id?: string; onSelect?: (v: string) => void } = {}): void {
  if (!host) return;
  _comboAborts.get(host)?.abort();
  // A re-render replaces the host element, so the host key alone leaks the old document click listener: also key by id.
  if (opts.id) _comboByKey.get(opts.id)?.abort();
  const ac = new AbortController();
  _comboAborts.set(host, ac);
  if (opts.id) _comboByKey.set(opts.id, ac);
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
type DialogMode = 'new' | 'edit';
interface DialogState {
  mode: DialogMode;
  job: Job | null;
  form: JobForm;
  /** The job types (GET /jobs/types) and the one the form is for; the params block renders from `meta`. */
  types: JobType[];
  meta: TypeMeta | null;
  /** Sequence + timer of the live "Resolves today to ..." lines (one debounce for every window widget). */
  winSeq: number;
  winTimer: ReturnType<typeof setTimeout> | null;
  /** Live "12 plants; 2 skipped" line: sequence + timer (stale responses are dropped). */
  tpSeq: number;
  tpTimer: ReturnType<typeof setTimeout> | null;
  /** How many plants the multi-plant schedule preview lists (grows by PLANT_PAGE through Show more, server max 50). */
  planLimit: number;
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
const PLANT_PAGE = 10;
const PLANT_PAGE_MAX = 50;

/* ---------------------------------------------------------------------------
   Markup
   ------------------------------------------------------------------------- */
function _opt(value: string, label: string, sel: string): string {
  return `<option value="${esc(value)}"${value === sel ? ' selected' : ''}>${esc(label)}</option>`;
}
/** What the chosen result mode does, in one sentence: Apply writes the plan, Dry run only shows it. */
export const resultHint = (result: string): string => t(result === 'propose' ? 'jobs.result_hint_propose' : 'jobs.result_hint_apply');

const _err = (field: string): string => `<div class="ape-err" id="jb-err-${field}" role="alert" hidden></div>`;

export function recurFieldsHtml(r: Recurrence, monthlyMode: PolicyForm['monthly'] = 'day_of_month'): string {
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
      // The day box only exists for a fixed day; "last day" and the working-day modes (Advanced) have no day to enter.
      return time + (monthlyMode === 'day_of_month' ? `<div class="form-row"><label for="jb-dom">${esc(t('jobs.f_dom'))}</label>`
        + `<input class="input job-num" id="jb-dom" type="number" min="1" max="31" value="${esc(r.dom)}">${_err('dom')}</div>` : '');
    case 'cron':
      return `<div class="form-row"><label for="jb-cron">${esc(t('jobs.f_cron'))}</label>`
        + `<input class="input job-mono" id="jb-cron" type="text" value="${esc(r.cron)}" placeholder="0 8 * * 1-5" autocomplete="off" spellcheck="false">`
        + `<div class="ape-hint">${esc(t('jobs.f_cron_hint'))}</div>${_err('cron')}</div>`;
    default:
      return time;
  }
}

/** A labelled select with its in-place hint (the hint is rewritten from the current value on every render). */
function _polSelect(id: string, labelKey: string, values: readonly string[], cur: string, optKey: (v: string) => string, hintKey: string): string {
  return `<div class="form-row"><label for="${id}">${esc(t(labelKey))}</label><select class="input" id="${id}">`
    + values.map(v => _opt(v, t(optKey(v)), cur)).join('') + `</select><div class="ape-hint" id="${id}-hint">${esc(t(hintKey))}</div></div>`;
}

/** The Advanced rules, rendered from the form (re-rendered whole when a choice changes what else applies): DST handling,
 *  closed days, run window, monthly mode, catch-up. Conditional parts are present or absent, never toggled with `hidden`. */
export function policyInnerHtml(f: JobForm): string {
  const p = f.policy; const preset = f.recur.preset;
  const dst = preset === 'hourly'
    ? `<div class="ape-hint">${esc(t('jobs.adv_dst_hourly'))}</div>`
    : _polSelect('jb-pol-gap', 'jobs.adv_dst_gap', DST_GAPS, p.dstGap, v => `jobs.adv_dst_gap_${v}`, `jobs.adv_dst_gap_hint_${p.dstGap}`)
      + _polSelect('jb-pol-overlap', 'jobs.adv_dst_overlap', DST_OVERLAPS, p.dstOverlap, v => `jobs.adv_dst_overlap_${v}`, `jobs.adv_dst_overlap_hint_${p.dstOverlap}`);
  const closed = _polSelect('jb-pol-closed', 'jobs.adv_closed', closedDayChoices(preset), closedDayChoices(preset).includes(p.closedDay) ? p.closedDay : 'run',
    v => `jobs.adv_closed_${v}`, `jobs.adv_closed_hint_${closedDayChoices(preset).includes(p.closedDay) ? p.closedDay : 'run'}`);
  const win = `<div class="form-row"><label class="chk-inline"><input type="checkbox" id="jb-pol-win-on"${p.winOn ? ' checked' : ''}><span>${esc(t('jobs.adv_win_on'))}</span></label>`
    + (p.winOn
      ? `<div class="form-row-2"><div class="form-row"><label for="jb-pol-win-start">${esc(t('jobs.adv_win_start'))}</label><input class="input job-time" id="jb-pol-win-start" type="time" value="${esc(p.winStart)}" step="60"></div>`
        + `<div class="form-row"><label for="jb-pol-win-end">${esc(t('jobs.adv_win_end'))}</label><input class="input job-time" id="jb-pol-win-end" type="time" value="${esc(p.winEnd)}" step="60"></div></div>`
        + _polSelect('jb-pol-win-action', 'jobs.adv_win_action', WINDOW_ACTIONS, p.winAction, v => `jobs.adv_win_${v}`, 'jobs.adv_win_hint')
      : '')
    + `${_err('policyWin')}</div>`;
  const monthly = preset === 'monthly'
    ? _polSelect('jb-pol-monthly', 'jobs.adv_monthly', MONTHLY_MODES, p.monthly, v => `jobs.adv_monthly_${v}`, 'jobs.adv_monthly_hint')
      + (p.monthly === 'day_of_month' ? `<label class="chk-inline"><input type="checkbox" id="jb-pol-clamp"${p.monthlyClamp ? ' checked' : ''}><span>${esc(t('jobs.adv_monthly_clamp'))}</span></label>` : '')
    : '';
  const catchUp = `<div class="form-row"><label class="chk-inline"><input type="checkbox" id="jb-pol-cu-on"${p.catchUp ? ' checked' : ''}><span>${esc(t('jobs.adv_catch_on'))}</span></label>`
    + (p.catchUp ? `<div class="form-row"><label for="jb-pol-cu-min">${esc(t('jobs.adv_catch_min'))}</label><input class="input job-num" id="jb-pol-cu-min" type="number" min="1" max="${GRACE_MAX_MIN}" value="${esc(p.graceMin)}"></div>` : '')
    + `<div class="ape-hint">${esc(t('jobs.adv_catch_hint'))}</div>${_err('policyGrace')}</div>`;
  return dst + closed + `${_err('policyTz')}` + monthly + win + catchUp;
}

export function policyBlockHtml(f: JobForm): string {
  const open = policyToOptions(f.policy, f.recur.preset) !== null;
  return `<details class="job-adv" id="jb-sadv"${open ? ' open' : ''}><summary>${esc(t('jobs.adv_title'))}</summary><div id="jb-pol">${policyInnerHtml(f)}</div></details>`;
}

/** The type select: grouped Optimization | Reports; locked once a job exists (its type never changes). With no types
 *  loaded it is a read-only line naming the current type. */
function _typeHtml(f: JobForm, types: JobType[], locked: boolean): string {
  const d = jobsDeps();
  if (!types.length) return `<div class="form-row"><label>${esc(t('jobs.f_type'))}</label><div class="readonly" id="jb-type">${esc(typeLabel({ key: f.jobType, label: f.jobType }, d))}</div></div>`;
  return `<div class="form-row"><label for="jb-jobtype">${esc(t('jobs.f_type'))}</label><select class="input" id="jb-jobtype"${locked ? ' disabled' : ''}>`
    + typeGroups(types).map(g => `<optgroup label="${esc(t(g.labelKey))}">${g.types.map(x => _opt(x.key, typeLabel(x, d), f.jobType)).join('')}</optgroup>`).join('')
    + `</select></div>`;
}

const _errP = (key: string): string => `<div class="ape-err" id="jb-err-p-${esc(key)}" role="alert" hidden></div>`;

/** Number box, text box, select, checkbox(es) or the window picker for one param, from the server's metadata. */
export function paramHtml(p: ParamMeta, v: unknown, isAdmin: boolean, hideWindow = false): string {
  const d = jobsDeps();
  const id = `jb-p-${p.key}`;
  const label = esc(paramLabel(p, d));
  // Apply / Dry run keeps its sentence that follows the value; every other hint is a translation (or none).
  const hint = p.key === 'apply_mode' ? resultHint(resultOf({ apply_mode: v })) : paramHint(p, d);
  const hintHtml = hint ? `<div class="ape-hint" id="${id}-hint">${esc(hint)}</div>` : '';
  const desc = hint ? ` aria-describedby="${id}-hint"` : '';
  switch (p.type) {
    case 'boolean':
      return `<div class="form-row job-checks"><label class="chk-inline"><input type="checkbox" id="${id}"${v === true ? ' checked' : ''}${desc}><span>${label}</span></label>${hintHtml}</div>`;
    case 'enum': {
      const locked = p.key === 'apply_mode' && !isAdmin;
      return `<div class="form-row"><label for="${id}">${label}</label><select class="input" id="${id}"${desc}${locked ? ' disabled' : ''}>`
        + (p.enum ?? []).map(o => _opt(o, enumLabel(p, o, d), String(v ?? ''))).join('') + `</select>${hintHtml}${_errP(p.key)}</div>`;
    }
    case 'multi_enum': {
      const on = new Set(Array.isArray(v) ? v.map(String) : []);
      return `<div class="form-row"><label id="${id}-l">${label}</label><div class="job-dows" role="group" aria-labelledby="${id}-l">`
        + (p.enum ?? []).map(o => `<label class="chk-inline"><input type="checkbox" id="${id}-${esc(o)}"${on.has(o) ? ' checked' : ''}><span>${esc(enumLabel(p, o, d))}</span></label>`).join('')
        + `</div>${hintHtml}${_errP(p.key)}</div>`;
    }
    case 'integer': case 'number':
      return `<div class="form-row"><label for="${id}">${label}</label><input class="input job-num" id="${id}" type="number"`
        + `${p.min != null ? ` min="${p.min}"` : ''}${p.max != null ? ` max="${p.max}"` : ''} step="${p.type === 'integer' ? 1 : 'any'}" value="${esc(v ?? '')}"${desc}>${hintHtml}${_errP(p.key)}</div>`;
    case 'date_window':
      return windowWidgetHtml(p, windowToUi(v as DateWindow | null), hideWindow);
    default:
      return `<div class="form-row"><label for="${id}">${label}</label><input class="input" id="${id}" type="text" value="${esc(v ?? '')}" autocomplete="off"${desc}>${hintHtml}${_errP(p.key)}</div>`;
  }
}

export function paramsHtml(meta: TypeMeta | null, f: JobForm, isAdmin: boolean): string {
  // The Result control (Apply / Dry run) belongs to action types only; a report never offers it.
  // The aggregate window means nothing while "Limit the aggregate view to a date window" is off: hide it until it is on.
  const gated = !!meta && meta.params.some(q => q.key === 'filter_by_window' && q.type === 'boolean');
  return meta ? meta.params.filter(p => p.key !== 'apply_mode' || hasApplyMode(meta))
    .map(p => paramHtml(p, f.params[p.key], isAdmin, gated && p.key === 'window' && f.params.filter_by_window !== true)).join('') : '';
}

/* ---------------------------------------------------------------------------
   Window picker: ONE select (Fixed dates | rolling presets | Custom) plus the fields the choice uses, and a live
   "Resolves today to ..." line from POST /jobs/windows/preview (the resolver a run uses).
   ------------------------------------------------------------------------- */
function _numBox(id: string, label: string, value: unknown, min: number, max: number): string {
  return `<div class="form-row"><label for="${id}">${esc(label)}</label><input class="input job-num" id="${id}" type="number" min="${min}" max="${max}" step="1" value="${esc(value)}"></div>`;
}

export function windowFieldsHtml(id: string, ui: WindowUi): string {
  switch (ui.choice) {
    case 'fixed':
      return `<div class="form-row-2"><div class="form-row"><label for="${id}-from">${esc(t('jobs.win_from'))}</label><input class="input" id="${id}-from" data-jb-wdate type="date" value="${esc(ui.from)}"></div>`
        + `<div class="form-row"><label for="${id}-to">${esc(t('jobs.win_to'))}</label><input class="input" id="${id}-to" data-jb-wdate type="date" value="${esc(ui.to)}"></div></div>`;
    case 'older_than':
      return _numBox(`${id}-n`, t('jobs.win_days_older'), ui.n, 0, WINDOW_OPEN_START);
    case 'last': case 'next':
      return _numBox(`${id}-n`, t('jobs.win_days'), ui.n, 1, WINDOW_OPEN_START);
    case 'custom':
      return `<div class="form-row"><label for="${id}-anchor">${esc(t('jobs.win_anchor'))}</label><select class="input" id="${id}-anchor">`
        + WINDOW_ANCHORS.map(a => _opt(a, t(`jobs.win_anchor_${a}`), ui.anchor)).join('') + `</select></div>`
        + `<div class="form-row-2">${_numBox(`${id}-foff`, t('jobs.win_from_offset'), ui.fromOffset, -3660, 3660)}${_numBox(`${id}-toff`, t('jobs.win_to_offset'), ui.toOffset, -3660, 3660)}</div>`
        + `<div class="form-row"><label for="${id}-unit">${esc(t('jobs.win_unit'))}</label><select class="input" id="${id}-unit">`
        + WINDOW_UNITS.map(u => _opt(u, t(`jobs.win_unit_${u}`), ui.unit)).join('') + `</select></div>`
        + `<div class="ape-hint">${esc(t('jobs.win_custom_hint'))}</div>`;
    default:
      return '';
  }
}

export function windowWidgetHtml(p: ParamMeta, ui: WindowUi, hidden = false): string {
  const id = `jb-p-${p.key}`;
  return `<fieldset class="job-window" id="${id}"${hidden ? ' hidden' : ''}><legend>${esc(paramLabel(p, jobsDeps()))}</legend>`
    + `<div class="form-row"><label for="${id}-choice">${esc(t('jobs.win_choice'))}</label><select class="input" id="${id}-choice">`
    + WINDOW_CHOICES.map(c => _opt(c, t(`jobs.win_${c}`), ui.choice)).join('') + `</select></div>`
    + `<div id="${id}-fields">${windowFieldsHtml(id, ui)}</div>`
    + `<div class="ape-hint job-window-line" id="${id}-line" aria-live="polite"></div>${_errP(p.key)}</fieldset>`;
}

/** A number box's value; a blank box is NaN (an error), never 0. */
const _numOrNaN = (v: string): number => (v.trim() === '' ? NaN : Number(v));

/** The picker state read from the live fields (a field that is not on screen keeps its previous value). */
function _readWindowUi(id: string, prev: WindowUi): WindowUi {
  const has = (s: string): boolean => !!_el(`${id}-${s}`);
  const choice = (_val(`${id}-choice`) || prev.choice) as WindowUi['choice'];
  return {
    choice,
    n: has('n') ? _numOrNaN(_val(`${id}-n`)) : prev.n,
    from: has('from') ? _val(`${id}-from`) : prev.from, to: has('to') ? _val(`${id}-to`) : prev.to,
    anchor: has('anchor') ? _val(`${id}-anchor`) : prev.anchor, unit: has('unit') ? _val(`${id}-unit`) : prev.unit,
    fromOffset: has('foff') ? _numOrNaN(_val(`${id}-foff`)) : prev.fromOffset, toOffset: has('toff') ? _numOrNaN(_val(`${id}-toff`)) : prev.toOffset,
  };
}

const _radio = (name: string, id: string, value: string, label: string, on: boolean): string =>
  `<label class="chk-inline"><input type="radio" name="${name}" id="${id}" value="${esc(value)}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;

const _PICK = {
  sel: { filter: 'jb-tsel-filter', list: 'jb-tsel-list', count: 'jb-tsel-count', attr: 'data-jb-tp', label: 'jobs.t_pick_plants' },
  excl: { filter: 'jb-texcl-filter', list: 'jb-texcl-list', count: 'jb-texcl-count', attr: 'data-jb-tx', label: 'jobs.t_exclude_plants' },
} as const;
type PickKind = keyof typeof _PICK;
const _chosen = (f: JobForm, kind: PickKind): string[] => (kind === 'sel' ? f.targetPlants : f.excludedPlants);

/** The checkbox rows of one plant picker (at most 200 rendered; the rest is reached by searching). */
export function pickRowsHtml(kind: PickKind, chosen: string[], filter: string): string {
  const all = allowedPlantList();
  const { shown, total } = filterPlants(all, filter);
  const on = new Set(chosen);
  const known = new Set(all);
  // A selected code that is not in the viewer's plant list (a plant removed, or outside their access) stays visible and
  // removable: it would otherwise ride along invisibly and survive Clear.
  const unknown = chosen.filter(c => !known.has(c)).map(c => `<label class="chk-inline job-copy-row"><input type="checkbox" ${_PICK[kind].attr}="${esc(c)}" checked><span>${esc(c)} <span class="badge badge-warn">${esc(t('jobs.t_unknown_plant'))}</span></span></label>`).join('');
  if (!shown.length) return unknown + `<div class="hps-empty">${esc(t('ui.no_matches'))}</div>`;
  return unknown + shown.map(p => `<label class="chk-inline job-copy-row"><input type="checkbox" ${_PICK[kind].attr}="${esc(p)}"${on.has(p) ? ' checked' : ''}><span>${esc(p)}</span></label>`).join('')
    + (total > shown.length ? `<div class="ape-hint">${esc(t('jobs.t_more', { shown: shown.length, total }))}</div>` : '');
}

/** A searchable multi-select with a count summary line (the Copy-to-plants pattern, not chips). */
export function pickerHtml(kind: PickKind, f: JobForm): string {
  const c = _PICK[kind];
  const label = t(c.label);
  return `<div class="form-row job-pick"><label id="${c.filter}-lbl" for="${c.filter}">${esc(label)}</label>`
    + `<input class="input" id="${c.filter}" type="search" placeholder="${esc(t('jobs.copy_search'))}" aria-label="${esc(label)}" autocomplete="off">`
    + `<div class="job-copy-actions"><button type="button" class="btn btn-ghost sm" data-jb-act="${kind}-all">${esc(t('jobs.t_select_all', { n: allowedPlantList().length }))}</button>`
    + `<button type="button" class="btn btn-ghost sm" data-jb-act="${kind}-none">${esc(t('jobs.copy_clear'))}</button>`
    + `<span class="ape-hint" id="${c.count}">${esc(t('jobs.copy_count', { n: _chosen(f, kind).length }))}</span></div>`
    + `<div class="job-copy-list" id="${c.list}" role="group" aria-labelledby="${c.filter}-lbl">${pickRowsHtml(kind, _chosen(f, kind), '')}</div></div>`;
}

export function fanOutHtml(f: JobForm): string {
  const fo = f.fanOut;
  const dflt = !fo.staggerS && fo.maxParallel == null && !fo.failFast;
  return `<details class="job-adv" id="jb-adv"${dflt ? '' : ' open'}><summary>${esc(t('jobs.t_adv'))}</summary>`
    + `<div class="form-row-2"><div class="form-row"><label for="jb-fo-stagger">${esc(t('jobs.t_stagger'))}</label>`
    + `<input class="input job-num" id="jb-fo-stagger" type="number" min="0" max="${STAGGER_MAX}" step="1" value="${esc(fo.staggerS)}"></div>`
    + `<div class="form-row"><label for="jb-fo-par">${esc(t('jobs.t_parallel'))}</label>`
    + `<input class="input job-num" id="jb-fo-par" type="number" min="1" max="${PARALLEL_MAX}" step="1" value="${esc(fo.maxParallel ?? '')}" placeholder="${esc(t('jobs.t_no_limit'))}"></div></div>`
    + `<label class="chk-inline"><input type="checkbox" id="jb-fo-ff"${fo.failFast ? ' checked' : ''}><span>${esc(t('jobs.t_fail_fast'))}</span></label>`
    + `<div class="ape-hint">${esc(t('jobs.t_adv_hint'))}</div>${_err('fanOut')}</details>`;
}

/** What sits under the mode radios for the current mode (swapped as one block when the mode changes). */
export function targetsBodyHtml(f: JobForm): string {
  const m = f.targetMode;
  return (m === 'selected' ? pickerHtml('sel', f) : '')
    + (m === 'subnetwork' ? `<div class="form-row"><label for="jb-tsub">${esc(t('jobs.t_subnetwork'))}</label><div id="jb-tsub-host"></div></div>` : '')
    + (m === 'all' || m === 'subnetwork' ? pickerHtml('excl', f) : '')
    + (m !== 'single' ? `<div class="ape-hint job-tpreview" id="jb-tpreview" role="status" aria-live="polite"></div>${fanOutHtml(f)}` : '');
}

export function targetsFieldsetHtml(f: JobForm): string {
  if (f.targetsLocked) {
    return `<fieldset class="job-targets"><legend>${esc(t('jobs.t_legend'))}</legend><div class="ape-hint" role="note">${esc(t('jobs.t_locked'))}</div></fieldset>`;
  }
  const hasSubs = subnetworkList().length > 0;
  return `<fieldset class="job-targets"><legend>${esc(t('jobs.t_legend'))}</legend>`
    + `<div class="job-radios" role="radiogroup" aria-label="${esc(t('jobs.t_legend'))}">`
    + TARGET_MODES.filter(m => m !== 'subnetwork' || hasSubs || f.targetMode === 'subnetwork').map(m => _radio('jb-tmode', `jb-tmode-${m}`, m, t(`jobs.t_mode_${m}`), m === f.targetMode)).join('')
    + `</div><div class="ape-hint">${esc(t('jobs.t_home_hint'))}</div>`
    + `<div id="jb-t-body">${targetsBodyHtml(f)}</div>${_err('targets')}</fieldset>`;
}

/** The schedule's time zone choice: each plant's own, one fixed zone (searchable), or UTC. */
export function tzBlockHtml(f: JobForm): string {
  const multi = f.targetMode !== 'single';
  const home = plantTimezone(f.plant);
  const shown = f.tzMode === 'utc' ? 'UTC' : f.tzMode === 'fixed' ? (f.fixedTz || '—') : multi ? t('jobs.tz_each_plant') : (home || t('jobs.tz_unknown'));
  return `<div class="form-row"><label id="jb-tzmode-l">${esc(t('jobs.f_tz'))}</label>`
    + `<div class="job-radios" role="radiogroup" aria-labelledby="jb-tzmode-l">`
    + TZ_MODES.map(m => _radio('jb-tzmode', `jb-tzmode-${m}`, m, t(`jobs.tz_mode_${m}`), m === f.tzMode)).join('') + `</div>`
    + (f.tzMode === 'fixed' ? `<div id="jb-fixedtz-host"></div>${_err('fixedTz')}` : '')
    + `<div class="readonly job-mono" id="jb-tz">${esc(shown)}</div>`
    + `<div class="ape-hint">${esc(t(f.tzMode === 'plant' ? 'jobs.tz_hint' : 'jobs.tz_hint_other'))}</div></div>`;
}

export function bodyHtml(f: JobForm, mode: DialogMode, isAdmin: boolean, meta: TypeMeta | null = null, types: JobType[] = []): string {
  return `<div class="job-form">`
    + `<div class="form-row"><label for="jb-name">${esc(t('jobs.f_name'))}</label>`
    + `<input class="input" id="jb-name" type="text" maxlength="${NAME_MAX}" value="${esc(f.name)}" autocomplete="off">${_err('name')}</div>`
    + `<div class="form-row-2">${_typeHtml(f, types, mode === 'edit')}`
    + `<div class="form-row"><label for="jb-plant">${esc(t('jobs.f_plant'))}</label><div id="jb-plant-host"></div>${_err('plant')}</div></div>`
    + targetsFieldsetHtml(f)
    + `<div id="jb-params">${paramsHtml(meta, f, isAdmin)}${_err('result')}</div>`
    + `<fieldset class="job-recur"><legend>${esc(t('jobs.f_recurrence'))}</legend>`
    + `<div class="form-row"><label for="jb-recur">${esc(t('jobs.f_repeat'))}</label><select class="input" id="jb-recur">`
    + RECUR_PRESETS.map(p => _opt(p, t(`jobs.preset_${p}`), f.recur.preset)).join('') + `</select></div>`
    + `<div id="jb-recur-fields">${recurFieldsHtml(f.recur, f.policy.monthly)}</div>`
    + `<div id="jb-tz-block">${tzBlockHtml(f)}</div>`
    + `<div class="form-row-2"><div class="form-row"><label for="jb-from">${esc(t('jobs.f_valid_from'))}</label><input class="input" id="jb-from" type="date" value="${esc(f.validFrom)}"></div>`
    + `<div class="form-row"><label for="jb-until">${esc(t('jobs.f_valid_until'))}</label><input class="input" id="jb-until" type="date" value="${esc(f.validUntil)}"></div></div>${_err('validity')}`
    + `<label class="chk-inline"><input type="checkbox" id="jb-overlap"${f.skipIfRunning ? ' checked' : ''}><span>${esc(t('jobs.f_skip_overlap'))}</span></label>`
    + policyBlockHtml(f)
    + `<div class="job-preview" id="jb-preview"></div><span class="job-sr" id="jb-preview-live" role="status" aria-live="polite"></span></fieldset></div>`;
}

function _footHtml(): string {
  const label = t('btn.save');
  return `<button type="button" class="btn btn-ghost" data-jb-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" id="jb-save" data-jb-act="save">${esc(label)}</button>`;
}

/* ---------------------------------------------------------------------------
   Flatpickr (time, date and date-time inputs; the native pickers ignore the viewer's date/time format).
   The original input keeps the machine value ('HH:MM', 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM') that readForm reads;
   flatpickr shows an alt input in the display format and fires `change` on the original, so the form's
   existing change handler (preview, dirty check) still runs. Without flatpickr (tests) the native input stays.
   ------------------------------------------------------------------------- */
interface PickerLike { destroy(): void; altInput?: HTMLInputElement }
let _pickers: PickerLike[] = [];

function _destroyPickers(): void {
  for (const p of _pickers) { try { p.destroy(); } catch { /* already gone */ } }
  _pickers = [];
}

function _initPickers(): void {
  _destroyPickers();
  if (typeof flatpickr === 'undefined') return;
  const h24 = Util._timeFormatPref() === '24h';
  const mount = (id: string, labelKey: string, cfg: Record<string, unknown>): void => {
    const el = _el<HTMLInputElement>(id);
    if (!el) return;
    try {
      const p = flatpickr(el, { altInput: true, altInputClass: 'input', allowInput: false, ...cfg }) as unknown as PickerLike;
      p.altInput?.setAttribute?.('aria-label', t(labelKey));
      _pickers.push(p);
    } catch { /* the native input stays usable */ }
  };
  mount('jb-time', 'jobs.f_time', { enableTime: true, noCalendar: true, dateFormat: 'H:i', altFormat: Util._fpTimeAltFormat(), time_24hr: h24, minuteIncrement: 1 });
  mount('jb-runat', 'jobs.f_run_at', { enableTime: true, dateFormat: 'Y-m-d\\TH:i', altFormat: Util._fpAltFormat(), time_24hr: h24, minuteIncrement: 1 });
  mount('jb-from', 'jobs.f_valid_from', { dateFormat: 'Y-m-d', altFormat: Util._dateFormatPref() });
  mount('jb-until', 'jobs.f_valid_until', { dateFormat: 'Y-m-d', altFormat: Util._dateFormatPref() });
  // The window picker's Fixed dates inputs (they come and go with the choice, so scan what is on screen).
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-jb-wdate]'))) {
    mount(el.id, el.id.endsWith('-to') ? 'jobs.win_to' : 'jobs.win_from', { dateFormat: 'Y-m-d', altFormat: Util._dateFormatPref() });
  }
}

/* ---------------------------------------------------------------------------
   Form <-> DOM
   ------------------------------------------------------------------------- */
/** The type's params read from the live fields; a control that is not on screen keeps its previous value. */
function _readParams(meta: TypeMeta, prev: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  for (const p of meta.params) {
    const id = `jb-p-${p.key}`;
    switch (p.type) {
      case 'boolean': if (_el(id)) out[p.key] = _chk(id); break;
      case 'enum': case 'string': if (_el(id)) out[p.key] = _val(id); break;
      case 'integer': case 'number':
        if (_el(id)) {
          const raw = _val(id).trim();
          // A blank box sends the param's own default (null for an optional one), never a null the server would refuse.
          out[p.key] = raw === '' ? (p.required ? null : (p.default ?? null)) : Number(raw);
        }
        break;
      case 'multi_enum': {
        const live = (p.enum ?? []).filter(o => _el(`${id}-${o}`));
        if (live.length) out[p.key] = live.filter(o => _chk(`${id}-${o}`));
        break;
      }
      case 'date_window': if (_el(`${id}-choice`)) out[p.key] = uiToWindow(_readWindowUi(id, windowToUi(prev[p.key] as DateWindow | null))); break;
    }
  }
  return out;
}

/** The Advanced rules from the live fields; a control that is not on screen keeps its previous value. */
function _readPolicy(prev: PolicyForm, preset: Recurrence['preset']): PolicyForm {
  const pick = <T extends string>(id: string, all: readonly T[], fb: T): T => (_el(id) && (all as readonly string[]).includes(_val(id)) ? (_val(id) as T) : fb);
  const has = (id: string): boolean => !!_el(id);
  return {
    dstGap: pick('jb-pol-gap', DST_GAPS, prev.dstGap), dstOverlap: pick('jb-pol-overlap', DST_OVERLAPS, prev.dstOverlap),
    closedDay: pick('jb-pol-closed', closedDayChoices(preset), prev.closedDay),
    winOn: has('jb-pol-win-on') ? _chk('jb-pol-win-on') : prev.winOn,
    winStart: has('jb-pol-win-start') ? _val('jb-pol-win-start') : prev.winStart, winEnd: has('jb-pol-win-end') ? _val('jb-pol-win-end') : prev.winEnd,
    winAction: pick('jb-pol-win-action', WINDOW_ACTIONS, prev.winAction),
    monthly: pick('jb-pol-monthly', MONTHLY_MODES, prev.monthly), monthlyClamp: has('jb-pol-clamp') ? _chk('jb-pol-clamp') : prev.monthlyClamp,
    catchUp: has('jb-pol-cu-on') ? _chk('jb-pol-cu-on') : prev.catchUp, graceMin: has('jb-pol-cu-min') ? Number(_val('jb-pol-cu-min')) : prev.graceMin,
  };
}

/** Read the live fields into a JobForm (plant and job type come from state: the combobox owns the plant). */
export function readForm(prev: JobForm, meta: TypeMeta | null = _s?.meta ?? null): JobForm {
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
  const radio = <T extends string>(ids: readonly T[], base: string, fallback: T): T => ids.find(m => _chk(`${base}${m}`)) ?? fallback;
  const hasFan = !!_el('jb-fo-stagger');
  const par = _val('jb-fo-par').trim();
  return {
    ...prev, name: _val('jb-name'), params: meta ? _readParams(meta, prev.params) : prev.params, recur, policy: _readPolicy(prev.policy, preset),
    validFrom: _val('jb-from'), validUntil: _val('jb-until'), skipIfRunning: _chk('jb-overlap'),
    targetMode: radio(TARGET_MODES, 'jb-tmode-', prev.targetMode), tzMode: radio(TZ_MODES, 'jb-tzmode-', prev.tzMode),
    fanOut: hasFan ? { staggerS: _val('jb-fo-stagger').trim() === '' ? 0 : Number(_val('jb-fo-stagger')), maxParallel: par === '' ? null : Number(par), failFast: _chk('jb-fo-ff') } : prev.fanOut,
  };
}

function _showErrors(errs: FormErrors): void {
  for (const f of ['name', 'plant', 'result', 'time', 'minute', 'days', 'dom', 'cron', 'runAt', 'validity', 'targets', 'fixedTz', 'fanOut', 'policyWin', 'policyGrace', 'policyTz'] as const) {
    const el = _el(`jb-err-${f}`);
    if (!el) continue;
    el.textContent = errs[f] ? t(errs[f] as string) : '';
    el.hidden = !errs[f];
  }
  for (const p of _s?.meta?.params ?? []) {
    const el = _el(`jb-err-p-${p.key}`);
    const key = errs.params?.[p.key];
    if (!el) continue;
    el.textContent = key ? t(key, { min: p.min ?? '', max: p.max ?? '' }) : '';
    el.hidden = !key;
  }
}

/* ---------------------------------------------------------------------------
   Server preview (next 5 + prose + DST warning)
   ------------------------------------------------------------------------- */
function _schedulePreview(): void {
  const s = _s;
  if (!s) return;
  if (s.previewTimer) clearTimeout(s.previewTimer);
  s.previewTimer = setTimeout(() => void _runPreview(), 300);
}

/** One fire as "Fri 30 Oct 08:00 (CDT) · 13:00 UTC": the plant's wall clock (offset kept on the wire, ignored) and the instant in UTC. */
function _fireText(e: { atLocal: string; atUtc: string }, tz: string): string {
  const zone = tzShort(tz, e.atUtc);
  return `${Util.fmtDTPref(stripOffset(e.atLocal))}${zone ? ` ${zone}` : ''} · ${Util.fmtDTPref(stripOffset(e.atUtc))} UTC`;
}

/** A fire's rule note as a badge: a DST shift or a move (next / previous working day, deferred to the window). */
function _noteBadge(e: { dstShifted: boolean; policyNote?: string | null }): string {
  const code = e.policyNote ?? (e.dstShifted ? 'dst_gap_shifted' : null);
  return code ? ` <span class="badge badge-warn job-note">${esc(policyNoteText(code, jobsDeps()))}</span>` : '';
}

/** The occurrences the rules removed, with the reason beside each (at most 10 are listed). */
function _skippedHtml(list: SkippedEntry[], tz: string): string {
  if (!list.length) return '';
  const d = jobsDeps();
  return `<div class="job-skipped" role="note"><div class="ape-hint">${esc(t('jobs.skipped_title'))}</div><ul class="job-preview-list">`
    + list.slice(0, 10).map(x => `<li class="job-mono">${esc(_fireText(x, tz))} <span class="job-sub">${esc(skipReasonCodeText(x.reason, d))}</span></li>`).join('') + `</ul></div>`;
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
    : !!(errs.time || errs.days || errs.dom || errs.fixedTz || errs.targets);
  if (bad || errs.policyWin || errs.policyGrace || errs.policyTz) { box.innerHTML = ''; return; }
  if (bad || !s.form.plant) { box.innerHTML = ''; return; }
  const seq = ++s.previewSeq;
  try {
    const { job, schedule: p } = buildJobPayload(s.form);
    const prose = recurrenceText(p, jobsDeps(), x => Util.fmtDTPref(x));
    const multi = job.targets.length > 0 && s.form.tzMode === 'plant';
    const res = await JobsClient.preview(s.form.plant, p, multi ? 3 : 5, { targets: job.targets, plantLimit: s.planLimit });
    if (_s !== s || seq !== s.previewSeq) return;
    const hadMoreFocus = document.activeElement?.getAttribute?.('data-jb-act') === 'plants-more';
    const live = _el('jb-preview-live');
    if (live) live.textContent = multi ? t('jobs.preview_live', { shown: res.plants.length, total: res.totalPlants }) : '';
    const head = `<div class="job-preview-head">${esc(t('jobs.next_runs'))} <span class="ape-hint">${esc(prose)}</span></div>`;
    // The generic warning only fits the default rules; with a DST choice made, each fire carries its own note instead.
    const defaultDst = s.form.policy.dstGap === 'shift' && s.form.policy.dstOverlap === 'once';
    const dst = defaultDst && (res.entries.some(x => x.dstShifted) || res.plants.some(pl => pl.entries.some(x => x.dstShifted))) ? `<div class="job-dst" role="note">${esc(t('jobs.dst_warning'))}</div>` : '';
    const skipped = res.warnings.length ? `<div class="ape-hint">${esc(plural('jobs.t_skipped_note', res.warnings.length, jobsDeps()))}</div>` : '';
    if (multi) {
      const more = res.totalPlants > res.plants.length
        ? (res.plants.length < PLANT_PAGE_MAX
          ? `<button type="button" class="btn btn-ghost sm" data-jb-act="plants-more">${esc(t('jobs.t_show_more', { shown: res.plants.length, total: res.totalPlants }))}</button>`
          : `<div class="ape-hint">${esc(t('jobs.t_showing', { shown: res.plants.length, total: res.totalPlants }))}</div>`)
        : '';
      box.innerHTML = head + `<div class="ape-hint">${esc(plural('jobs.t_preview_plants', res.totalPlants, jobsDeps()))}</div>` + skipped
        + (res.plants.length ? res.plants.map(pl => `<div class="job-pp"><span class="job-mono job-pp-plant">${esc(pl.plant)}</span> <span class="ape-hint">${esc(pl.timezone)}</span>`
          + `<ol class="job-preview-list">${pl.entries.map(x => `<li class="job-mono">${esc(_fireText(x, pl.timezone))}${_noteBadge(x)}</li>`).join('')}</ol>${_skippedHtml(pl.skipped, pl.timezone)}</div>`).join('')
          : `<div class="ape-hint">${esc(t('jobs.no_runs'))}</div>`) + more + dst;
      if (hadMoreFocus) (box.querySelector('[data-jb-act="plants-more"]') as HTMLElement | null)?.focus();
      return;
    }
    box.innerHTML = head + skipped
      + (res.entries.length ? `<ol class="job-preview-list">${res.entries.map(x => `<li class="job-mono">${esc(s.form.tzMode === 'utc' ? `${Util.fmtDTPref(stripOffset(x.atUtc))} UTC` : _fireText(x, res.timezone))}${_noteBadge(x)}</li>`).join('')}</ol>` : `<div class="ape-hint">${esc(t('jobs.no_runs'))}</div>`)
      + _skippedHtml(res.skipped, res.timezone) + dst;
  } catch (e) {
    if (_s !== s || seq !== s.previewSeq) return;
    box.innerHTML = `<div class="ape-err">${esc((e as Error).message)}</div>`;
  }
}

/** The "12 plants; 2 skipped: no timezone" line under the targets (debounced, newest response wins). */
function _scheduleTargetsPreview(): void {
  const s = _s;
  if (!s || s.form.targetMode === 'single') return;
  if (s.tpTimer) clearTimeout(s.tpTimer);
  s.tpTimer = setTimeout(() => void _runTargetsPreview(), 300);
}

async function _runTargetsPreview(): Promise<void> {
  const s = _s;
  const box = _el('jb-tpreview');
  if (!s || !box) return;
  s.form = readForm(s.form);
  const rows = buildTargetRows(s.form);
  const say = (text: string, err: boolean): void => { box.textContent = text; box.classList.toggle('ape-err', err); box.classList.toggle('ape-hint', !err); };
  if (!rows.length || (s.form.targetMode === 'selected' && !s.form.targetPlants.length)) { say('', false); return; }
  const seq = ++s.tpSeq;
  try {
    const r = await JobsClient.targetsPreview(rows, { limit: 1 });
    if (_s !== s || seq !== s.tpSeq) return;
    say(targetsPreviewText(r, jobsDeps()), false);
  } catch (e) {
    if (_s !== s || seq !== s.tpSeq) return;
    say((e as Error).message, true);               // e.g. a plant outside the admin's scope
  }
}

/** The mode radios changed: swap the block under them, re-mount what needs a live widget, refresh both previews. */
function _renderTargets(s: DialogState): void {
  const host = _el('jb-t-body');
  if (host) host.innerHTML = targetsBodyHtml(s.form);
  _mountSubnetwork(s);
  _renderTz(s);
  _scheduleTargetsPreview();
  _schedulePreview();
}

function _mountSubnetwork(s: DialogState): void {
  mkCombobox(_el('jb-tsub-host'), subnetworkList(), {
    value: s.form.targetSubnetwork, placeholder: t('jobs.t_subnetwork'), id: 'jb-tsub',
    onSelect: (v) => { if (!_s) return; _s.form.targetSubnetwork = v; _scheduleTargetsPreview(); _schedulePreview(); },
  });
}

function _renderPolicy(s: DialogState): void {
  const host = _el('jb-pol');
  if (host) host.innerHTML = policyInnerHtml(s.form);
}

/** An Advanced control changed: read it, rebuild the block (a choice can change what else applies), keep focus on it. */
function _policyChanged(s: DialogState, id: string): void {
  const prevMonthly = s.form.policy.monthly;
  s.form = readForm(s.form);
  _renderPolicy(s);
  if (s.form.policy.monthly !== prevMonthly) {            // "last day" and the working-day modes have no day box
    const host = _el('jb-recur-fields');
    if (host) host.innerHTML = recurFieldsHtml(s.form.recur, s.form.policy.monthly);
    _initPickers();
  }
  _el(id)?.focus();
  _schedulePreview();
}

function _renderTz(s: DialogState): void {
  const host = _el('jb-tz-block');
  if (host) host.innerHTML = tzBlockHtml(s.form);
  _renderTzCombo(s);
}

function _renderTzCombo(s: DialogState): void {
  mkCombobox(_el('jb-fixedtz-host'), timeZoneList(), {
    value: s.form.fixedTz, placeholder: t('jobs.tz_fixed_ph'), id: 'jb-fixedtz',
    onSelect: (v) => { if (!_s) return; _s.form.fixedTz = v; const tz = _el('jb-tz'); if (tz) tz.textContent = v || '—'; _schedulePreview(); },
  });
}

/** A picker's rows and count after a tick, a search or a bulk action. */
function _refreshPick(s: DialogState, kind: PickKind): void {
  const c = _PICK[kind];
  const list = _el(c.list);
  if (list) list.innerHTML = pickRowsHtml(kind, _chosen(s.form, kind), _val(c.filter));
  _refreshPickCount(s, kind);
  // The bulk button names how many plants the search matches ("Select all 37 matches").
  const btn = document.querySelector<HTMLElement>(`[data-jb-act="${kind}-all"]`);
  if (btn) btn.textContent = t('jobs.t_select_all', { n: filterPlants(allowedPlantList(), _val(c.filter), Number.MAX_SAFE_INTEGER).total });
}

/** A tick only moves the count: the rows (and the focus on the box just ticked) stay exactly where they are. */
function _refreshPickCount(s: DialogState, kind: PickKind): void {
  const n = _el(_PICK[kind].count);
  if (n) n.textContent = t('jobs.copy_count', { n: _chosen(s.form, kind).length });
  const row = _el(_PICK[kind].list);
  // An unticked unknown code has nothing left to show: drop its row (the ticked box that was clicked keeps focus otherwise).
  if (row) row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(i => {
    const code = i.getAttribute(_PICK[kind].attr) ?? '';
    if (!i.checked && !allowedPlantList().includes(code)) i.closest('label')?.remove();
  });
}

function _pickBulk(s: DialogState, kind: PickKind, all: boolean): void {
  const c = _PICK[kind];
  const key = kind === 'sel' ? 'targetPlants' : 'excludedPlants';
  const shown = filterPlants(allowedPlantList(), _val(c.filter), Number.MAX_SAFE_INTEGER).shown;
  // Clear means clear: the whole selection goes, including codes the list no longer shows (unknown plants, other searches).
  const cur = new Set(all ? s.form[key] : []);
  if (all) for (const p of shown) cur.add(p);
  const next = { ...s.form, [key]: [...cur] };
  if (all && targetRowCount(next) > TARGET_ROWS_MAX) {
    Toast.show(t('jobs.err_targets_cap', { max: TARGET_ROWS_MAX, n: targetRowCount(next) }), 'error');
    return;                                        // the server refuses more rows than this: say so before the Save
  }
  s.form = next;
  _refreshPick(s, kind);
  _scheduleTargetsPreview();
  _schedulePreview();
}

/* ---------------------------------------------------------------------------
   Window preview: "Resolves today to <from> to <to> (<tz>, plant time)" for every window param, debounced, with a
   stale-response guard (winSeq). The server resolves it with the same code a run uses.
   ------------------------------------------------------------------------- */
function _scheduleWindowPreview(): void {
  const s = _s;
  if (!s || !s.meta?.params.some(p => p.type === 'date_window')) return;
  if (s.winTimer) clearTimeout(s.winTimer);
  for (const p of s.meta.params.filter(x => x.type === 'date_window')) {        // the old line is stale the moment the window changes
    const l = _el(`jb-p-${p.key}-line`);
    if (l) { l.textContent = ''; l.classList.remove('ape-err'); l.classList.add('ape-hint'); }
  }
  s.winTimer = setTimeout(() => void _runWindowPreviews(), 300);
}

async function _runWindowPreviews(): Promise<void> {
  const s = _s;
  if (!s || !s.meta) return;
  s.form = readForm(s.form);
  const seq = ++s.winSeq;
  const lookback = Number(s.form.params.first_run_lookback_days) || undefined;
  for (const p of s.meta.params.filter(x => x.type === 'date_window')) {
    const line = _el(`jb-p-${p.key}-line`);
    if (!line) continue;
    const w = s.form.params[p.key] as DateWindow;
    const setLine = (text: string, err: boolean): void => { line.textContent = text; line.classList.toggle('ape-err', err); line.classList.toggle('ape-hint', !err); };
    if ((_el(`jb-p-${p.key}`) as HTMLElement | null)?.hidden) { setLine('', false); continue; }
    const bad = validateWindowUi(windowToUi(w));
    if (bad) { setLine(t(bad), true); continue; }                                  // an invalid window says why, inline
    if (!s.form.plant) { setLine('', false); continue; }
    try {
      const r = await JobsClient.windowPreview(s.form.plant, w, { jobId: s.job?.id ?? null, lookbackDays: lookback });
      if (_s !== s || seq !== s.winSeq) return;
      setLine(t('jobs.win_resolves', { label: r.label, tz: r.timezone }), false);
    } catch (e) {
      if (_s !== s || seq !== s.winSeq) return;
      setLine((e as Error).message, true);          // e.g. the plant has no timezone
    }
  }
}

/** A window picker's choice changed: swap the fields under it. Switching to Custom keeps the meaning of the preset it left. */
function _windowChoiceChanged(s: DialogState, id: string, key: string): void {
  const prevUi = windowToUi(s.form.params[key] as DateWindow | null);
  const ui = _readWindowUi(id, prevUi);
  if (ui.choice === 'custom' && prevUi.choice !== 'custom') {
    const r = uiToWindow(prevUi).rolling;
    if (r) { ui.anchor = r.anchor; ui.fromOffset = r.from_offset; ui.toOffset = r.to_offset; ui.unit = r.unit; }
  }
  if (['older_than', 'last', 'next'].includes(ui.choice) && !(Number(ui.n) >= (ui.choice === 'older_than' ? 0 : 1))) ui.n = 7;
  const host = _el(`${id}-fields`);
  if (host) host.innerHTML = windowFieldsHtml(id, ui);
  s.form.params = { ...s.form.params, [key]: uiToWindow(ui) };
  _initPickers();
}

/** New job only: another type swaps the params block for that type's own defaults (name, plant and recurrence stay). */
function _changeType(s: DialogState, key: string): void {
  const meta = findType(s.types, key);
  if (!meta || s.mode !== 'new') return;
  s.form = { ...readForm(s.form), jobType: key, params: seedParams(meta, meta.defaults) };
  s.meta = meta;
  const host = _el('jb-params');
  if (host) host.innerHTML = paramsHtml(meta, s.form, Session.isAdmin()) + _err('result');
  _initPickers();
  _scheduleWindowPreview();
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
    const ds = (e.target as HTMLElement).dataset ?? {};
    const tick = (kind: PickKind, plant: string | undefined): boolean => {
      if (plant === undefined) return false;
      const key = kind === 'sel' ? 'targetPlants' : 'excludedPlants';
      const cur = new Set(s.form[key]);
      if ((e.target as HTMLInputElement).checked) cur.add(plant); else cur.delete(plant);
      s.form = { ...s.form, [key]: [...cur] };
      _refreshPickCount(s, kind);
      _scheduleTargetsPreview(); _schedulePreview();
      return true;
    };
    if (tick('sel', ds.jbTp) || tick('excl', ds.jbTx)) return;
    if (id.startsWith('jb-tmode-')) { s.form = readForm(s.form); s.planLimit = PLANT_PAGE; _renderTargets(s); return; }
    if (id.startsWith('jb-tzmode-')) { s.form = readForm(s.form); _renderTz(s); _schedulePreview(); return; }
    if (id.startsWith('jb-fo-')) { s.form = readForm(s.form); _scheduleTargetsPreview(); return; }
    if (id === 'jb-jobtype') { _changeType(s, _val('jb-jobtype')); return; }
    if (id.startsWith('jb-pol-')) { _policyChanged(s, id); return; }
    if (id === 'jb-recur') {
      s.form = readForm(s.form);
      const host = _el('jb-recur-fields');
      if (host) host.innerHTML = recurFieldsHtml(s.form.recur, s.form.policy.monthly);
      _renderPolicy(s);                                    // hourly drops the DST rules, monthly adds its own, closed-day choices differ
      _initPickers();
    }
    const wm = /^(jb-p-(.+))-choice$/.exec(id);
    if (wm) _windowChoiceChanged(s, wm[1], wm[2]);
    if (id === 'jb-p-filter_by_window') { const w = _el('jb-p-window'); if (w) w.hidden = !_chk(id); }
    if (id === 'jb-p-apply_mode') { const hint = _el('jb-p-apply_mode-hint'); if (hint) hint.textContent = resultHint(_val('jb-p-apply_mode')); }
    if (id.startsWith('jb-p-')) _scheduleWindowPreview();
    _schedulePreview();
  });
  body?.addEventListener('input', (e) => {
    const id = (e.target as HTMLElement | null)?.id ?? '';
    const s = _s;
    if (!s) return;
    if (id === _PICK.sel.filter) _refreshPick(s, 'sel');
    else if (id === _PICK.excl.filter) _refreshPick(s, 'excl');
    else if (id.startsWith('jb-fo-')) _scheduleTargetsPreview();
    else if (id !== 'jb-name') {
      if (id.startsWith('jb-p-')) _scheduleWindowPreview();
      else _schedulePreview();
    }
  });
  body?.addEventListener('click', (e) => {
    const s = _s;
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-jb-act]')?.dataset.jbAct;
    if (!s || !act) return;
    if (act === 'sel-all' || act === 'sel-none') _pickBulk(s, 'sel', act === 'sel-all');
    else if (act === 'excl-all' || act === 'excl-none') _pickBulk(s, 'excl', act === 'excl-all');
    else if (act === 'plants-more') { s.planLimit = Math.min(PLANT_PAGE_MAX, s.planLimit + PLANT_PAGE); void _runPreview(); }
  });
  _el('jb-foot')?.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-jb-act]')?.dataset.jbAct;
    if (act === 'cancel') JobsDialog.close();
    else if (act === 'save') void JobsDialog.submit();
  });
  _el('jb-close')?.addEventListener('click', () => void JobsDialog.requestClose());
  shell.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) void JobsDialog.requestClose(); });
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
  open(opts: { job?: Job; duplicate?: boolean; plant?: string; defaults?: Record<string, unknown>; types?: JobType[]; jobType?: string; onSaved?: () => void }): void {
    if (!Session.isAdmin()) return;
    const { job, duplicate } = opts;
    const mode: DialogMode = job && !duplicate ? 'edit' : 'new';
    const types = opts.types ?? [];
    // A new job starts as the first action type (the optimizer) unless the caller names one, seeded from that type's own
    // param defaults (GET /jobs/types); a saved job renders with its own type and params.
    const typeKey = job ? job.job_type : (opts.jobType ?? types.find(x => x.kind === 'action')?.key ?? types[0]?.key ?? 'optimizer.plant');
    const meta = findType(types, typeKey) ?? null;
    const form = job ? jobToForm(job, meta) : defaultJobForm(opts.plant ?? '', typeKey, opts.defaults ?? meta?.defaults ?? null, meta);
    if (duplicate) form.name = '';
    _s = { mode, job: job && !duplicate ? job : null, form, types, meta, winSeq: 0, winTimer: null, tpSeq: 0, tpTimer: null, planLimit: PLANT_PAGE, busy: false, baseline: JSON.stringify(form), previewSeq: 0, previewTimer: null, onSaved: opts.onSaved ?? null };
    _wire();
    const body = _el('jb-body');
    if (body) body.innerHTML = bodyHtml(form, mode, Session.isAdmin(), meta, types);
    _initPickers();
    mkCombobox(_el('jb-plant-host'), allowedPlantList(), {
      value: form.plant, placeholder: t('jobs.f_plant'), id: 'jb-plant', disabled: mode === 'edit',
      onSelect: (v) => { if (!_s) return; _s.form.plant = v; const tz = _el('jb-tz'); if (tz && _s.form.tzMode === 'plant' && _s.form.targetMode === 'single') tz.textContent = plantTimezone(v) || t('jobs.tz_unknown'); _schedulePreview(); _scheduleWindowPreview(); },
    });
    _mountSubnetwork(_s);
    _renderTzCombo(_s);
    _show(mode === 'edit' ? t('jobs.title_edit') : t('jobs.title_new'));
    _s.baseline = JSON.stringify(readForm(form));   // read back from the rendered fields, so dirty = a real edit
    _el('jb-name')?.focus();
    void _runPreview();
    void _runWindowPreviews();
    void _runTargetsPreview();
  },

  async submit(): Promise<void> {
    const s = _s;
    if (!s || s.busy) return;
    s.form = readForm(s.form);
    const errs = validateJobForm(s.form, { isAdmin: Session.isAdmin(), plants: Session.allowedPlants(), meta: s.meta });
    _showErrors(errs);
    if (Object.keys(errs).length) return;
    const { job, schedule } = buildJobPayload(s.form);
    s.busy = true;
    const btn = _el<HTMLButtonElement>('jb-save');
    if (btn) btn.disabled = true;
    try {
      if (s.job) {
        await JobsClient.update(s.job.id, { name: job.name, params: job.params, targets: job.targets, fan_out: job.fan_out });
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
    if (s.baseline && JSON.stringify(readForm(s.form)) !== s.baseline) {
      const discard = await Modal.confirm({ title: t('jobs.confirm_discard'), message: t('jobs.confirm_discard_msg'), confirmLabel: t('btn.discard'), tone: 'warn' });
      if (!discard || _s !== s) return;
    }
    JobsDialog.close();
  },

  close(): void {
    if (_s?.previewTimer) clearTimeout(_s.previewTimer);
    if (_s?.winTimer) clearTimeout(_s.winTimer);
    if (_s?.tpTimer) clearTimeout(_s.tpTimer);
    _s = null;
    _destroyPickers();
    Modal.close('modal-job-edit');
  },

  /** Test seam. */
  _state(): DialogState | null { return _s; },
};
