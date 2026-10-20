/* =============================================================================
   ALERT PROFILE EDITOR — the modal where planners create and edit the shared
   per-plant alert profiles (spec section D "Profile editor").

   Static shell `#modal-alert-profile` lives in index.html; this module renders the
   body (`#ape-body`) and footer (`#ape-foot`) at runtime and opens/closes the shell
   through Modal.open/close (the single central focus trap). It is never opened from
   inside the User Settings modal.

   Layout: left rail = the plant's profiles (+ New profile, Duplicate, Copy to plants…),
   right = the form for the draft (name, rules, ranking, "use for me") or, while copying,
   a searchable multi-select of the plants the user may access.

   Validation is NOT re-implemented here: `validateProfile` (insights/alert-profiles)
   returns i18n keys per field path and this module only renders them. Typing never
   re-renders the whole body (it would drop focus); only the live day range, the live
   match count and structural changes (tick a type, add/remove a rule, switch profile)
   touch the DOM.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import type { AlertProfile, AlertProfileRule, AlertRanking, AlertType, AlertCategory, NimbusTask } from '../platform/types.mjs';
import { AlertProfileClient } from '../insights/alert-profile-client.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import { AlertApiError } from '../insights/plant-lru.mjs';
import {
  ALERT_CATEGORIES, FIRING_ALERT_TYPES, filterByProfile, validateProfile,
} from '../insights/alert-profiles.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

const MAX_NAME = 60;
const RANKINGS: AlertRanking[] = ['impact', 'time', 'severity', 'orders'];
const CATEGORIES = Object.keys(ALERT_CATEGORIES) as AlertCategory[];
const FIRING: ReadonlySet<string> = new Set<string>(FIRING_ALERT_TYPES);

// ---- Draft model ----------------------------------------------------------------------------

export interface RuleDraft {
  /** Ticked types. `null` on the wire (= every type) is shown as every firing type ticked. */
  types: string[];
  dayFrom: number | null;
  dayTo: number | null;
  minSev: 'warn' | 'err' | null;
  minLateHours: number | null;
}

export interface EditorDraft {
  id?: string;
  plant: string;
  name: string;
  description: string;
  ranking: AlertRanking;
  /** The row's updated_at when it was loaded: the optimistic-concurrency token for update. */
  updated_at: string | null;
  rules: RuleDraft[];
}

export interface ProfileFromDraft {
  id?: string;
  plant: string;
  name: string;
  description: string;
  ranking: AlertRanking;
  rules: AlertProfileRule[];
  expected_updated_at: string | null;
}

const blankRule = (): RuleDraft => ({ types: [], dayFrom: null, dayTo: null, minSev: null, minLateHours: null });

function blankDraft(plant: string): EditorDraft {
  return { plant, name: '', description: '', ranking: 'impact', updated_at: null, rules: [blankRule()] };
}

/** Tri-state of one category header checkbox over the ticked types. */
export function categoryCheckState(catTypes: readonly string[], selected: Iterable<string>): 'all' | 'some' | 'none' {
  const sel = new Set(selected);
  const n = catTypes.filter(x => sel.has(x)).length;
  return n === 0 ? 'none' : n === catTypes.length ? 'all' : 'some';
}

/** Server rule: PUT/DELETE need the creator (case-insensitive) or an admin. */
export function canDeleteProfile(
  p: { created_by?: string | null } | null | undefined, user: { username?: string } | null | undefined, isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  const me = (user?.username ?? '').trim().toLowerCase();
  const owner = (p?.created_by ?? '').trim().toLowerCase();
  return !!me && !!owner && me === owner;
}

export function draftFromProfile(p: AlertProfile): EditorDraft {
  return {
    id: p.id,
    plant: p.plant,
    name: p.name,
    description: p.description ?? '',
    ranking: p.ranking,
    updated_at: p.updated_at,
    rules: (p.rules ?? []).map(r => ({
      types: r.types == null ? [...FIRING_ALERT_TYPES] : (r.types as string[]).filter(x => FIRING.has(x)),
      dayFrom: r.dayFrom ?? null,
      dayTo: r.dayTo ?? null,
      minSev: r.minSev ?? null,
      minLateHours: r.minLateHours ?? null,
    })),
  };
}

export function profileFromDraft(d: EditorDraft): ProfileFromDraft {
  return {
    ...(d.id ? { id: d.id } : {}),
    plant: d.plant,
    name: (d.name ?? '').trim(),
    description: d.description ?? '',
    ranking: d.ranking,
    rules: d.rules.map(r => ({
      // Every firing type ticked is the same thing as "any type": store null so new types are included later.
      types: FIRING_ALERT_TYPES.every(x => r.types.includes(x)) ? null : [...r.types] as AlertType[],
      dayFrom: r.dayFrom,
      dayTo: r.dayTo,
      minSev: r.minSev,
      minLateHours: r.minLateHours,
    })),
    expected_updated_at: d.updated_at,
  };
}

/** "<name> (copy)", then "(copy 2)", … — unique among `existing` names (case-insensitive), capped at 60 characters. */
export function uniqueCopyName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map(n => n.trim().toLowerCase()));
  const base = name.trim();
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const candidate = base.slice(0, MAX_NAME - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const _defaultFmt = (d: Date): string => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** The plant-local dates a day window covers (inclusive); a blank side is "…". Null when both are blank. */
export function liveRange(
  dayFrom: number | null, dayTo: number | null, plantToday: Date, fmt: (d: Date) => string = _defaultFmt,
): { from: string; to: string } | null {
  const ok = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!ok(dayFrom) && !ok(dayTo)) return null;
  const y = plantToday.getFullYear(), m = plantToday.getMonth(), d = plantToday.getDate();
  const at = (n: number) => fmt(new Date(y, m, d + n));
  return { from: ok(dayFrom) ? at(dayFrom) : '…', to: ok(dayTo) ? at(dayTo) : '…' };
}

/** How many of `alerts` the whole draft matches right now (same matcher the page uses). */
export function liveMatchCount(
  draft: { plant: string; name?: string; rules: RuleDraft[] | AlertProfileRule[] },
  alerts: NimbusAlert[], tasksById: Record<string, NimbusTask | undefined>, plantToday: Date,
): number {
  const profile = profileFromDraft({
    plant: draft.plant, name: draft.name ?? '', description: '', ranking: 'impact', updated_at: null,
    rules: (draft.rules as Array<RuleDraft | AlertProfileRule>).map(r => ({
      types: r.types == null ? [...FIRING_ALERT_TYPES] : [...(r.types as string[])],
      dayFrom: r.dayFrom ?? null, dayTo: r.dayTo ?? null, minSev: r.minSev ?? null, minLateHours: r.minLateHours ?? null,
    })),
  });
  return filterByProfile(alerts, tasksById, { ...profile, id: '', created_by: null, updated_at: null } as unknown as AlertProfile, plantToday).length;
}

// ---- Editor state ---------------------------------------------------------------------------

interface CopyState { srcId: string; sel: Set<string>; query: string; busy: boolean }

interface EditorState {
  plant: string;
  profiles: AlertProfile[];
  draft: EditorDraft;
  /** JSON of `profileFromDraft(draft)` as loaded: the unsaved-edits check compares against it. */
  baseline: string;
  errors: Record<string, string>;
  serverError: string | null;
  showErrors: boolean;
  saving: boolean;
  setMine: boolean;
  copy: CopyState | null;
}

let _s: EditorState | null = null;

const _snap = (d: EditorDraft): string => JSON.stringify(profileFromDraft(d));
function _setDraft(s: EditorState, d: EditorDraft): void { s.draft = d; s.baseline = _snap(d); }
function _dirty(s: EditorState): boolean { return _snap(s.draft) !== s.baseline; }

/** Run `go` now when nothing is unsaved; otherwise only after the planner confirms discarding the edits. */
function _guardDiscard(s: EditorState, go: () => void): void {
  if (!_dirty(s)) { go(); return; }
  void Modal.confirm({
    tone: 'warn',
    title: t('ape.discard_title'),
    message: t('ape.discard_confirm'),
    confirmLabel: t('btn.discard'),
  }).then(ok => { if (ok && _s === s) go(); });
}

type Nim = { AlertsUIAdapter?: { headlineFor?(type: string): string } };
function _headline(type: string): string {
  const viaAdapter = (globalThis as unknown as { NIMBUS?: Nim }).NIMBUS?.AlertsUIAdapter?.headlineFor?.(type);
  if (viaAdapter) return viaAdapter;
  const key = `alert.type.${type}`;
  const row = t(key);
  return row && row !== key ? row : String(type).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _plantToday(plant: string): Date {
  const now = Store.plantNow(plant) ?? new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function _sortedProfiles(list: AlertProfile[] | null | undefined): AlertProfile[] {
  return [...(list ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

function _canEdit(s: EditorState): boolean {
  if (!s.draft.id) return true;
  const p = s.profiles.find(x => x.id === s.draft.id);
  return !!p && canDeleteProfile(p, Session.currentUser(), Session.isAdmin());
}

function _copyTargets(plant: string): string[] {
  const allowed = Session.allowedPlants();
  const all = [...new Set((Store.masterData?.plants ?? []).map(p => p.plant))];
  return all.filter(p => p !== plant && (!allowed || allowed.includes(p))).sort((a, b) => a.localeCompare(b));
}

// ---- Rendering ------------------------------------------------------------------------------

const _err = (key: string | undefined): string =>
  key ? `<div class="ape-err" role="alert">${esc(t(key))}</div>` : '';

function _numVal(v: number | null): string { return v == null || Number.isNaN(v) ? '' : String(v); }

function _railHtml(s: EditorState): string {
  const rows = _sortedProfiles(s.profiles).map(p => {
    const sel = p.id === s.draft.id;
    return `<div class="ape-prow${sel ? ' ape-prow-sel' : ''}">`
      + `<button type="button" class="ape-pname" data-ape-act="select" data-ape-id="${esc(p.id)}"${sel ? ' aria-current="true"' : ''}>${esc(p.name)}</button>`
      + `<div class="ape-pacts">`
      + `<button type="button" class="btn sm btn-ghost" data-ape-act="dup" data-ape-id="${esc(p.id)}">${esc(t('ape.duplicate'))}</button>`
      + `<button type="button" class="btn sm btn-ghost" data-ape-act="copy" data-ape-id="${esc(p.id)}">${esc(t('ape.copy_to_plants'))}</button>`
      + `</div></div>`;
  }).join('');
  return `<aside class="ape-rail"><button type="button" class="btn sm${s.draft.id ? '' : ' ape-new-sel'}" data-ape-act="new">${esc(t('ape.new_profile'))}</button>`
    + `<div class="ape-plist">${rows}</div></aside>`;
}

function _ruleHtml(s: EditorState, r: RuleDraft, i: number, editable: boolean): string {
  const e = s.errors;
  const dis = editable ? '' : ' disabled';
  const groups = CATEGORIES.map(cat => {
    const types = ALERT_CATEGORIES[cat].filter(x => FIRING.has(x));
    if (!types.length) return '';
    const st = categoryCheckState(types, r.types);
    const catLabel = t(`ape.cat_${cat}`);
    const boxes = types.map(x =>
      `<label class="chk-inline"><input type="checkbox" data-ape-type="${esc(x)}" data-ape-rule="${i}"${r.types.includes(x) ? ' checked' : ''}${dis}>`
      + `<span>${esc(_headline(x))}</span></label>`).join('');
    return `<div class="ape-cat">`
      + `<label class="chk-inline ape-cat-head" title="${esc(t('ape.select_category', { cat: catLabel }))}">`
      + `<input type="checkbox" data-ape-cat="${cat}" data-ape-rule="${i}"${st === 'all' ? ' checked' : ''}${st === 'some' ? ' data-indet="1"' : ''}${dis}>`
      + `<span>${esc(catLabel)}</span></label><div class="ape-cat-types">${boxes}</div></div>`;
  }).join('');
  const range = liveRange(r.dayFrom, r.dayTo, _plantToday(s.plant));
  const bad = (k: string) => (e[`rules.${i}.${k}`] ? ' is-invalid' : '');
  return `<div class="ape-rule" data-ape-rulecard="${i}">`
    + `<div class="ape-rule-head"><span class="ape-eyebrow">${esc(t('ape.rule_n', { n: i + 1 }))}</span>`
    + (s.draft.rules.length > 1 && editable
      ? `<button type="button" class="icon-btn sm" data-ape-act="rm-rule" data-ape-rule="${i}" aria-label="${esc(t('ape.remove_rule'))}" title="${esc(t('ape.remove_rule'))}">✕</button>` : '')
    + `</div>`
    + `<div class="ape-types-label">${esc(t('ape.types'))}</div>${groups}${_err(e[`rules.${i}.types`])}`
    + `<div class="ape-days">`
    + `<div class="form-row"><label>${esc(t('ape.day_from'))}</label>`
    + `<input class="input${bad('dayFrom')}" type="number" min="-365" max="365" step="1" data-ape-field="dayFrom" data-ape-rule="${i}" value="${esc(_numVal(r.dayFrom))}"${dis}>${_err(e[`rules.${i}.dayFrom`])}</div>`
    + `<div class="form-row"><label>${esc(t('ape.day_to'))}</label>`
    + `<input class="input${bad('dayTo')}" type="number" min="-365" max="365" step="1" data-ape-field="dayTo" data-ape-rule="${i}" value="${esc(_numVal(r.dayTo))}"${dis}>${_err(e[`rules.${i}.dayTo`])}</div>`
    + `</div>`
    + `<div class="ape-range" id="ape-range-${i}">${range ? esc(t('ape.live_range', range)) : ''}</div>`
    + `<div class="ape-hint">${esc(t('ape.days_hint'))}</div>${_err(e[`rules.${i}.days`])}`
    + `<div class="ape-days">`
    + `<div class="form-row"><label>${esc(t('ape.min_sev'))}</label>`
    + `<select class="input${bad('minSev')}" data-ape-field="minSev" data-ape-rule="${i}"${dis}>`
    + `<option value=""${r.minSev == null ? ' selected' : ''}>${esc(t('ape.sev_any'))}</option>`
    + `<option value="warn"${r.minSev === 'warn' ? ' selected' : ''}>${esc(t('ape.sev_warn'))}</option>`
    + `<option value="err"${r.minSev === 'err' ? ' selected' : ''}>${esc(t('ape.sev_err'))}</option></select>${_err(e[`rules.${i}.minSev`])}</div>`
    + `<div class="form-row"><label>${esc(t('ape.late_hours'))}</label>`
    + `<input class="input${bad('minLateHours')}" type="number" min="0" step="any" data-ape-field="minLateHours" data-ape-rule="${i}" value="${esc(_numVal(r.minLateHours))}"${dis}>${_err(e[`rules.${i}.minLateHours`])}</div>`
    + `</div>${_err(e[`rules.${i}.dup`])}</div>`;
}

function _formHtml(s: EditorState): string {
  const d = s.draft, e = s.errors, editable = _canEdit(s);
  const dis = editable ? '' : ' disabled';
  return `<section class="ape-form">`
    + (s.serverError ? _err(s.serverError) : '')
    + (editable ? '' : `<div class="ape-hint">${esc(t('ape.not_editable'))}</div>`)
    + `<div class="form-row"><label for="ape-name">${esc(t('ape.name'))}</label>`
    + `<input class="input${e.name ? ' is-invalid' : ''}" id="ape-name" type="text" maxlength="${MAX_NAME}" data-ape-field="name" placeholder="${esc(t('ape.name_ph'))}" value="${esc(d.name)}"${dis}>${_err(e.name)}</div>`
    + `<div class="ape-rules-head"><span class="ape-eyebrow">${esc(t('ape.rules'))}</span><span class="ape-live" id="ape-matches"></span></div>`
    + _err(e.rules)
    + d.rules.map((r, i) => _ruleHtml(s, r, i, editable)).join('')
    + (editable ? `<button type="button" class="btn sm" data-ape-act="add-rule">${esc(t('ape.add_rule'))}</button>` : '')
    + `<div class="form-row ape-ranking"><label>${esc(t('ape.ranking'))}</label>`
    + `<select class="input" data-ape-field="ranking"${dis}>`
    + RANKINGS.map(k => `<option value="${k}"${d.ranking === k ? ' selected' : ''}>${esc(t(`am.sort_${k}`))}</option>`).join('')
    + `</select></div>`
    + `<label class="chk-inline ape-mine"><input type="checkbox" data-ape-field="setMine"${s.setMine ? ' checked' : ''}><span>${esc(t('ape.set_mine', { plant: s.plant }))}</span></label>`
    + `</section>`;
}

function _copyListHtml(c: CopyState, plant: string): string {
  const q = c.query.trim().toLowerCase();
  const all = _copyTargets(plant);
  const shown = q ? all.filter(p => p.toLowerCase().includes(q)) : all;
  if (!shown.length) return `<div class="us-combo-empty">${esc(t('us.no_matches'))}</div>`;
  return shown.map(p =>
    `<label class="us-combo-option ape-copy-opt"><input type="checkbox" data-ape-copy-plant="${esc(p)}"${c.sel.has(p) ? ' checked' : ''}>`
    + `<span class="us-combo-option-prefix">${esc(t('ui.plant_label'))}</span><span>${esc(p)}</span></label>`).join('');
}

function _copyHtml(s: EditorState, c: CopyState): string {
  const src = s.profiles.find(p => p.id === c.srcId);
  return `<section class="ape-form ape-copy">`
    + `<div class="ape-rules-head"><span class="ape-eyebrow">${esc(t('ape.copy_to_plants'))}</span></div>`
    + `<div class="ape-hint">${esc(src?.name ?? '')}</div>`
    + `<div class="us-combo"><input type="text" class="input us-combo-input" role="combobox" aria-expanded="true" autocomplete="off" data-ape-field="copyQuery"`
    + ` placeholder="${esc(t('us.default_plant_ph'))}" value="${esc(c.query)}"></div>`
    + `<div class="ape-copy-list" id="ape-copy-list" role="listbox" aria-multiselectable="true">${_copyListHtml(c, s.plant)}</div>`
    + `<div class="ape-hint" id="ape-copy-count">${esc(t('ape.copy_selected', { n: c.sel.size }))}</div>`
    + `</section>`;
}

function _footHtml(s: EditorState): string {
  if (s.copy) {
    return `<button type="button" class="btn" data-ape-act="copy-cancel">${esc(t('btn.cancel'))}</button>`
      + `<button type="button" class="btn btn-primary" id="ape-copy-go" data-ape-act="copy-go"${s.copy.sel.size && !s.copy.busy ? '' : ' disabled'}>${esc(t('ape.copy_go'))}</button>`;
  }
  const p = s.draft.id ? s.profiles.find(x => x.id === s.draft.id) : null;
  const canDelete = !!p && canDeleteProfile(p, Session.currentUser(), Session.isAdmin());
  return (canDelete
      ? `<button type="button" class="btn btn-danger ape-delete" data-ape-act="delete"${s.saving ? ' disabled' : ''}>${esc(t('ape.delete'))}</button>` : '')
    + `<button type="button" class="btn" data-ape-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" data-ape-act="save"${s.saving || !_canEdit(s) ? ' disabled' : ''}>${esc(t('btn.save'))}</button>`;
}

function _render(): void {
  const s = _s;
  if (!s) return;
  const body = document.getElementById('ape-body');
  const foot = document.getElementById('ape-foot');
  const title = document.getElementById('ape-title');
  if (title) title.textContent = t(s.draft.id ? 'ape.title_edit' : 'ape.title_new');
  if (body) {
    const top = body.scrollTop;
    body.innerHTML = `<div class="ape-layout">${_railHtml(s)}${s.copy ? _copyHtml(s, s.copy) : _formHtml(s)}</div>`;
    body.querySelectorAll<HTMLInputElement>('input[data-indet="1"]').forEach(el => { el.indeterminate = true; });
    body.scrollTop = top;
  }
  if (foot) foot.innerHTML = _footHtml(s);
  _refreshLive();
}

/** Updates only the live day-range lines and the match count: safe to call on every keystroke. */
function _refreshLive(): void {
  const s = _s;
  if (!s || s.copy) return;
  const today = _plantToday(s.plant);
  s.draft.rules.forEach((r, i) => {
    const el = document.getElementById(`ape-range-${i}`);
    const range = liveRange(r.dayFrom, r.dayTo, today);
    if (el) el.textContent = range ? t('ape.live_range', range) : '';
  });
  const m = document.getElementById('ape-matches');
  if (m) m.textContent = t('ape.live_matches', { n: liveMatchCount(s.draft, Store.alerts, Store.tasks, today) });
}

// ---- Actions --------------------------------------------------------------------------------

function _revalidate(s: EditorState): boolean {
  const p = profileFromDraft(s.draft);
  const v = validateProfile({ id: p.id, plant: p.plant, name: p.name, rules: p.rules }, s.profiles);
  s.errors = v.errors;
  return v.ok;
}

async function _save(): Promise<void> {
  const s = _s;
  if (!s || s.saving) return;
  s.serverError = null;
  s.showErrors = true;
  if (!_revalidate(s)) { _render(); return; }
  s.saving = true;
  _render();
  const p = profileFromDraft(s.draft);
  try {
    const saved = s.draft.id
      ? await AlertProfileClient.update(s.draft.id, {
          plant: p.plant, name: p.name, description: p.description, rules: p.rules, ranking: p.ranking, expected_updated_at: p.expected_updated_at,
        })
      : await AlertProfileClient.create({ plant: p.plant, name: p.name, description: p.description, rules: p.rules, ranking: p.ranking });
    Toast.show(t('toast.alert_profile_saved', { name: p.name }), 'success');
    if (s.setMine) {
      const id = saved?.id ?? s.draft.id
        ?? (AlertProfileClient.cached(s.plant) ?? []).find(x => x.name === p.name)?.id;
      if (id) {
        const existing = (Store.pref('alertProfileByPlant') as Record<string, string> | null | undefined) ?? {};
        Session.setPref('alertProfileByPlant', { ...existing, [s.plant]: id });
        AlertProfileMatches.setSessionProfile(null);   // the pref now says the same thing
      }
    }
    AlertProfileEditor.close();
  } catch (err) {
    if (_s !== s) return;
    s.saving = false;
    const code = err instanceof AlertApiError ? err.code : null;
    if (code === 'name_taken') s.errors = { ...s.errors, name: 'ape.err_name_dup' };
    else if (code === 'stale') s.serverError = 'ape.err_stale';
    else Toast.show((err as Error)?.message || t('ape.err_save_failed'), 'error');
    _render();
  }
}

async function _delete(): Promise<void> {
  const s = _s;
  if (!s || !s.draft.id) return;
  const id = s.draft.id;
  const ok = await Modal.confirm({
    tone: 'danger',
    title: t('ape.delete_confirm_title'),
    message: t('ape.delete_confirm_msg', { name: s.draft.name, plant: s.plant }),
  });
  if (!ok || _s !== s) return;
  try {
    await AlertProfileClient.remove(id, s.plant);
    Toast.show(t('toast.alert_profile_deleted'), 'success');
    AlertProfileEditor.close();
  } catch (err) {
    Toast.show((err as Error)?.message || t('ape.err_save_failed'), 'error');
  }
}

async function _copyGo(): Promise<void> {
  const s = _s;
  const c = s?.copy;
  if (!s || !c || c.busy) return;
  const src = s.profiles.find(p => p.id === c.srcId);
  if (!src) return;
  c.busy = true;
  const foot = document.getElementById('ape-foot');
  if (foot) foot.innerHTML = _footHtml(s);
  const ok: string[] = [];
  const failed: string[] = [];
  for (const target of [...c.sel].filter(p => p !== s.plant)) {
    try {
      await AlertProfileClient.create({ plant: target, name: src.name, description: src.description, rules: src.rules, ranking: src.ranking });
      ok.push(target);
    } catch (err) {
      const code = err instanceof AlertApiError ? err.code : null;
      failed.push(`${target}: ${code === 'name_taken' ? t('ape.err_name_dup') : ((err as Error)?.message || t('ape.err_save_failed'))}`);
    }
  }
  if (ok.length) Toast.show(t('toast.alert_profile_saved', { name: `${src.name} → ${ok.join(', ')}` }), 'success');
  if (failed.length) Toast.show(failed.join('; '), 'error');
  if (_s !== s) return;
  s.copy = null;
  _render();
}

function _selectProfile(id: string): void {
  const s = _s;
  const p = s?.profiles.find(x => x.id === id);
  if (!s || !p) return;
  _setDraft(s, draftFromProfile(p));
  s.errors = {}; s.serverError = null; s.showErrors = false; s.copy = null; s.setMine = false;
  _render();
}

function _newDraft(): void {
  const s = _s;
  if (!s) return;
  _setDraft(s, blankDraft(s.plant));
  s.errors = {}; s.serverError = null; s.showErrors = false; s.copy = null; s.setMine = false;
  _render();
}

function _duplicate(id: string): void {
  const s = _s;
  const p = s?.profiles.find(x => x.id === id);
  if (!s || !p) return;
  const d = draftFromProfile(p);
  delete d.id;
  d.updated_at = null;
  d.name = uniqueCopyName(p.name, s.profiles.map(x => x.name));
  _setDraft(s, d);
  s.errors = {}; s.serverError = null; s.showErrors = false; s.copy = null; s.setMine = false;
  _render();
}

/** Copy to plants… swaps the form for the plant list; any unsaved edits were confirmed away, so revert to the saved profile. */
function _startCopy(s: EditorState, srcId: string): void {
  const saved = s.draft.id ? s.profiles.find(x => x.id === s.draft.id) : undefined;
  _setDraft(s, saved ? draftFromProfile(saved) : blankDraft(s.plant));
  s.copy = { srcId, sel: new Set(), query: '', busy: false };
  _render();
}

function _parseNum(v: string): number | null {
  if (v == null || String(v).trim() === '') return null;
  return Number(v);
}

function _rule(s: EditorState, ds: DOMStringMap): RuleDraft | undefined {
  return s.draft.rules[Number(ds.apeRule)];
}

function _afterEdit(s: EditorState): void {
  if (s.showErrors) _revalidate(s);
}

// ---- Event handlers (delegated; wired once on the static shell) ------------------------------

function _onClick(e: Event): void {
  const s = _s;
  const btn = (e.target as HTMLElement | null)?.closest?.('[data-ape-act]') as HTMLElement | null;
  if (!s || !btn) return;
  const ds = btn.dataset;
  switch (ds.apeAct) {
    case 'select': _guardDiscard(s, () => _selectProfile(ds.apeId ?? '')); break;
    case 'new': _guardDiscard(s, _newDraft); break;
    case 'dup': _guardDiscard(s, () => _duplicate(ds.apeId ?? '')); break;
    case 'copy': _guardDiscard(s, () => _startCopy(s, ds.apeId ?? '')); break;
    case 'copy-cancel': s.copy = null; _render(); break;
    case 'copy-go': void _copyGo(); break;
    case 'add-rule':
      s.draft.rules.push(blankRule());
      _afterEdit(s);
      _render();
      break;
    case 'rm-rule':
      if (s.draft.rules.length > 1) s.draft.rules.splice(Number(ds.apeRule), 1);
      s.errors = {};
      _afterEdit(s);
      _render();
      break;
    case 'save': void _save(); break;
    case 'delete': void _delete(); break;
    case 'cancel': AlertProfileEditor.close(); break;
  }
}

function _onField(e: Event, kind: 'input' | 'change'): void {
  const s = _s;
  const el = e.target as (HTMLInputElement & HTMLSelectElement) | null;
  if (!s || !el?.dataset) return;
  const ds = el.dataset;

  // Checkboxes only react to `change` (browsers also fire `input` for them); the handlers are idempotent.
  if (ds.apeType !== undefined) {
    if (kind !== 'change') return;
    const r = _rule(s, ds);
    if (!r) return;
    const has = r.types.includes(ds.apeType);
    if (el.checked && !has) r.types.push(ds.apeType);
    else if (!el.checked && has) r.types = r.types.filter(x => x !== ds.apeType);
    _afterEdit(s); _render();
    return;
  }
  if (ds.apeCat !== undefined) {
    if (kind !== 'change') return;
    const r = _rule(s, ds);
    if (!r) return;
    const catTypes = ALERT_CATEGORIES[ds.apeCat as AlertCategory].filter(x => FIRING.has(x));
    const rest = r.types.filter(x => !catTypes.includes(x as AlertType));
    r.types = el.checked ? [...rest, ...catTypes] : rest;
    _afterEdit(s); _render();
    return;
  }
  if (ds.apeCopyPlant !== undefined) {
    if (kind !== 'change' || !s.copy) return;
    if (el.checked) s.copy.sel.add(ds.apeCopyPlant); else s.copy.sel.delete(ds.apeCopyPlant);
    const count = document.getElementById('ape-copy-count');
    if (count) count.textContent = t('ape.copy_selected', { n: s.copy.sel.size });
    const go = document.getElementById('ape-copy-go') as HTMLButtonElement | null;
    if (go) go.disabled = s.copy.sel.size === 0 || s.copy.busy;
    return;
  }

  switch (ds.apeField) {
    case 'name': s.draft.name = el.value; _afterEdit(s); _refreshLive(); break;
    case 'dayFrom': { const r = _rule(s, ds); if (r) { r.dayFrom = _parseNum(el.value); _afterEdit(s); _refreshLive(); } break; }
    case 'dayTo': { const r = _rule(s, ds); if (r) { r.dayTo = _parseNum(el.value); _afterEdit(s); _refreshLive(); } break; }
    case 'minLateHours': { const r = _rule(s, ds); if (r) { r.minLateHours = _parseNum(el.value); _afterEdit(s); _refreshLive(); } break; }
    case 'minSev': { const r = _rule(s, ds); if (r) { r.minSev = el.value === 'warn' || el.value === 'err' ? el.value : null; _afterEdit(s); _refreshLive(); } break; }
    case 'ranking': if (RANKINGS.includes(el.value as AlertRanking)) s.draft.ranking = el.value as AlertRanking; break;
    case 'setMine': if (kind === 'change') s.setMine = !!el.checked; break;
    case 'copyQuery': {
      if (!s.copy) break;
      s.copy.query = el.value;
      const list = document.getElementById('ape-copy-list');
      if (list) list.innerHTML = _copyListHtml(s.copy, s.plant);
      break;
    }
  }
}

function _wire(): void {
  const shell = document.getElementById('modal-alert-profile') as (HTMLElement & { _apeWired?: boolean }) | null;
  if (!shell || shell._apeWired) return;
  shell._apeWired = true;
  const body = document.getElementById('ape-body');
  const foot = document.getElementById('ape-foot');
  body?.addEventListener('click', _onClick);
  foot?.addEventListener('click', _onClick);
  body?.addEventListener('input', e => _onField(e, 'input'));
  body?.addEventListener('change', e => _onField(e, 'change'));
  document.getElementById('ape-close')?.addEventListener('click', () => AlertProfileEditor.close());
  shell.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) AlertProfileEditor.close();
  });
}

// ---- Public API -----------------------------------------------------------------------------

export const AlertProfileEditor = {
  /** Open the editor for `plant`: an existing profile when `profileId` matches, else a blank draft. */
  open(opts: { plant: string; profileId?: string }): void {
    const plant = opts.plant;
    if (!plant) return;
    const profiles = AlertProfileClient.cached(plant) ?? [];
    const found = opts.profileId ? profiles.find(p => p.id === opts.profileId) : undefined;
    const draft = found ? draftFromProfile(found) : blankDraft(plant);
    const s: EditorState = {
      plant, profiles,
      draft, baseline: _snap(draft),
      errors: {}, serverError: null, showErrors: false, saving: false, setMine: false, copy: null,
    };
    _s = s;
    _wire();
    _render();
    Modal.open('modal-alert-profile');
    // The cache may be cold or stale: refresh the rail once, without clobbering an in-progress draft.
    void AlertProfileClient.list(plant).then(list => {
      if (_s !== s) return;
      s.profiles = list;
      if (opts.profileId && !s.draft.id && !s.draft.name && list.some(p => p.id === opts.profileId)) {
        _setDraft(s, draftFromProfile(list.find(p => p.id === opts.profileId)!));
      }
      _render();
    }).catch(() => { /* the cached rail stays; the load failure is toasted by the pane */ });
  },

  close(): void {
    if (!_s) return;
    _s = null;
    Modal.close('modal-alert-profile');
  },
};
