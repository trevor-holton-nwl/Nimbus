/* =============================================================================
   ALERT PROFILE EDITOR — the modal where planners create and edit the shared
   per-plant alert profiles (spec: docs/superpowers/specs/2026-10-30-alert-profiles-revamp-design.md, W5).

   Static shell `#modal-alert-profile` lives in index.html; this module renders the
   body (`#ape-body`) and footer (`#ape-foot`) at runtime and opens/closes the shell
   through Modal.open/close (the single central focus trap). It is never opened from
   inside the User Settings modal.

   Layout: left rail = the plant's profiles (+ New profile, Duplicate, Copy to plants…),
   right = the form for the draft or, while copying, a searchable multi-select of the
   plants the user may access. The form is two tiers:
     1. the seven alert groups (switch, name, description, live count, colour swatch);
     2. a collapsed "Fine-tune" disclosure with the per-group narrowing (day preset,
        errors only, alert types, late hours) for the groups that are on.

   Validation is NOT re-implemented here: `validateProfile` (insights/alert-profiles)
   returns i18n keys per field path and this module only renders them. Typing never
   re-renders the whole body (it would drop focus); only the live day range, the live
   counts and structural changes (switch, preset, tick a type, add/remove a rule,
   switch profile) touch the DOM. Typing in the Name box recounts nothing.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import { OverflowMenu } from '../platform/overflow-menu.mjs';
import type { MenuItem } from '../platform/overflow-menu.mjs';
import { Session } from '../security/session.mjs';
import type {
  AlertProfile, AlertProfileRule, AlertRanking, AlertType, AlertCategory, NimbusTask, PaletteName, ProfileCategories,
} from '../platform/types.mjs';
import { AlertProfileClient } from '../insights/alert-profile-client.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import { AlertApiError } from '../insights/plant-lru.mjs';
import {
  ALERT_CATEGORIES, ALERT_CATEGORY_ORDER, DEFAULT_CATEGORY_COLORS, FIRING_ALERT_TYPES, PALETTE,
  categoryOf, effectiveCategories, profileCategoryCounts, validateProfile,
} from '../insights/alert-profiles.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

const MAX_NAME = 60;
const FIRING: ReadonlySet<string> = new Set<string>(FIRING_ALERT_TYPES);

/** The firing types of one group, in the group's own order. */
const groupTypes = (cat: AlertCategory): AlertType[] => ALERT_CATEGORIES[cat].filter(x => FIRING.has(x));

// ---- Draft model ----------------------------------------------------------------------------

export interface RuleDraft {
  /** Ticked types. `null` on the wire (= every type) is shown as every firing type ticked. */
  types: string[];
  dayFrom: number | null;
  dayTo: number | null;
  /** Only 'err' (Errors only) or null: a stored 'warn' filtered nothing, so it reads as unchecked and is saved as null. */
  minSev: 'warn' | 'err' | null;
  minLateHours: number | null;
  /** UI only (never saved): the planner picked Custom, so the two day inputs stay visible even when the values match a preset. */
  custom?: boolean;
}

export interface EditorDraft {
  id?: string;
  plant: string;
  name: string;
  description: string;
  /** The row's updated_at when it was loaded: the optimistic-concurrency token for update. */
  updated_at: string | null;
  /** The seven groups: switch + colour. A deep copy, never the cached profile's object. */
  categories: ProfileCategories;
  /** "Colour the Gantt": fill this profile's matched bars on the Gantt and minimap. */
  gantt_colors: boolean;
  /** "Include acknowledged alerts": list and count acknowledged alerts under this profile (default off). */
  show_acknowledged: boolean;
  rules: RuleDraft[];
}

export interface ProfileFromDraft {
  id?: string;
  plant: string;
  name: string;
  description: string;
  ranking: AlertRanking;
  categories: ProfileCategories;
  gantt_colors: boolean;
  show_acknowledged: boolean;
  rules: AlertProfileRule[];
  expected_updated_at: string | null;
}

const blankRule = (): RuleDraft => ({ types: [], dayFrom: null, dayTo: null, minSev: null, minLateHours: null });
const groupRule = (cat: AlertCategory): RuleDraft => ({ ...blankRule(), types: groupTypes(cat) });

function _cloneCategories(c: ProfileCategories): ProfileCategories {
  const out = {} as ProfileCategories;
  for (const cat of ALERT_CATEGORY_ORDER) out[cat] = { on: !!c[cat]?.on, color: c[cat]?.color ?? DEFAULT_CATEGORY_COLORS[cat] };
  return out;
}

/** A new profile: every group on in its default colour, no narrowing rules. */
export function blankDraft(plant: string): EditorDraft {
  const categories = {} as ProfileCategories;
  for (const cat of ALERT_CATEGORY_ORDER) categories[cat] = { on: true, color: DEFAULT_CATEGORY_COLORS[cat] };
  return { plant, name: '', description: '', updated_at: null, categories, gantt_colors: true, show_acknowledged: false, rules: [] };
}

/** Tri-state of one group's type checkboxes over the ticked types. */
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

export type DayPreset = 'any' | 'overdue' | 'next3' | 'next7' | 'next14' | 'custom';
const NEXT_DAYS: Record<string, DayPreset> = { 2: 'next3', 6: 'next7', 13: 'next14' };

/** Which preset a day window is: "Next N" is day 0 to N-1, Overdue is everything before today, anything else is Custom. */
export function dayPresetOf(dayFrom: number | null, dayTo: number | null): DayPreset {
  if (dayFrom == null && dayTo == null) return 'any';
  if (dayFrom == null && dayTo === -1) return 'overdue';
  if (dayFrom === 0 && dayTo != null && NEXT_DAYS[String(dayTo)]) return NEXT_DAYS[String(dayTo)]!;
  return 'custom';
}

/** The window a preset stands for; null for Custom (the planner types the numbers). */
export function dayPresetRange(preset: DayPreset): { dayFrom: number | null; dayTo: number | null } | null {
  switch (preset) {
    case 'any': return { dayFrom: null, dayTo: null };
    case 'overdue': return { dayFrom: null, dayTo: -1 };
    case 'next3': return { dayFrom: 0, dayTo: 2 };
    case 'next7': return { dayFrom: 0, dayTo: 6 };
    case 'next14': return { dayFrom: 0, dayTo: 13 };
    default: return null;
  }
}

/** Whether the rule names a type of group `cat` (so it narrows that group). */
const _ruleApplies = (r: { types: readonly string[] }, cat: AlertCategory): boolean => r.types.some(x => categoryOf(x) === cat);

/** Whether an applicable rule actually narrows `cat`: a day window, a severity, a late-hours floor, or a type left unticked. */
const _ruleNarrows = (r: RuleDraft, cat: AlertCategory): boolean =>
  r.dayFrom != null || r.dayTo != null || r.minSev === 'err' || r.minLateHours != null
  || groupTypes(cat).some(x => !r.types.includes(x));

/** The ON groups that carry a real narrowing rule (the "Fine-tuned" badge and the Fine-tune auto-open). */
export function tunedCategories(d: { categories: ProfileCategories; rules: RuleDraft[] }): AlertCategory[] {
  return ALERT_CATEGORY_ORDER.filter(cat => d.categories[cat]?.on && d.rules.some(r => _ruleApplies(r, cat) && _ruleNarrows(r, cat)));
}

function _wireRule(r: RuleDraft): AlertProfileRule {
  return {
    // Every firing type ticked is the same thing as "any type": store null so new types are included later.
    types: FIRING_ALERT_TYPES.every(x => r.types.includes(x)) ? null : [...r.types] as AlertType[],
    dayFrom: r.dayFrom,
    dayTo: r.dayTo,
    minSev: r.minSev === 'err' ? 'err' : null,
    minLateHours: r.minLateHours,
  };
}

/** A rule that cannot change what matches: no window, severity or late floor, and every type of every group it names ticked. */
function _isNoop(w: AlertProfileRule): boolean {
  if (w.dayFrom != null || w.dayTo != null || w.minSev != null || w.minLateHours != null) return false;
  if (w.types == null) return true;
  if (!w.types.length) return false;
  const touched = new Set((w.types as string[]).map(categoryOf));
  return [...touched].every(cat => groupTypes(cat).every(x => (w.types as string[]).includes(x)));
}

/**
 * The draft rules as they go to the server: wire form, no-op rules dropped (the editor keeps a blank rule per ON group so
 * its controls have something to edit), exact duplicates dropped silently. `src[k]` is the draft index of output rule k, so
 * validation errors can be shown under the control that caused them.
 */
export function normalizeRules(drafts: readonly RuleDraft[]): { rules: AlertProfileRule[]; src: number[] } {
  const seen = new Set<string>();
  const all: AlertProfileRule[] = [];
  const idx: number[] = [];
  drafts.forEach((r, i) => {
    const w = _wireRule(r);
    const sig = JSON.stringify([w.types == null ? null : [...new Set(w.types)].sort(), w.dayFrom, w.dayTo, w.minSev, w.minLateHours]);
    if (seen.has(sig)) return;
    seen.add(sig);
    all.push(w);
    idx.push(i);
  });
  // Under any-of matching a no-op rule beside a narrowing rule makes the whole group match, so it is dropped only when it
  // is the SOLE rule applying to every group it names (then zero rules means the same thing). Otherwise it stays on the wire.
  const touches = (w: AlertProfileRule): AlertCategory[] =>
    w.types == null ? [...ALERT_CATEGORY_ORDER] : [...new Set((w.types as string[]).map(categoryOf))];
  const rules: AlertProfileRule[] = [];
  const src: number[] = [];
  all.forEach((w, k) => {
    if (_isNoop(w) && touches(w).every(cat => !all.some((o, j) => j !== k && touches(o).includes(cat)))) return;
    rules.push(w);
    src.push(idx[k]!);
  });
  return { rules, src };
}

export function draftFromProfile(p: AlertProfile): EditorDraft {
  return {
    id: p.id,
    plant: p.plant,
    name: p.name,
    description: p.description ?? '',
    updated_at: p.updated_at,
    categories: _cloneCategories(effectiveCategories(p)),
    gantt_colors: p.gantt_colors !== false,
    show_acknowledged: p.show_acknowledged === true,
    rules: (p.rules ?? []).map(r => {
      const dayFrom = r.dayFrom ?? null, dayTo = r.dayTo ?? null;
      const d: RuleDraft = {
        types: r.types == null ? [...FIRING_ALERT_TYPES] : (r.types as string[]).filter(x => FIRING.has(x)),
        dayFrom,
        dayTo,
        minSev: r.minSev === 'err' ? 'err' : null,
        minLateHours: r.minLateHours ?? null,
      };
      if (dayPresetOf(dayFrom, dayTo) === 'custom') d.custom = true;
      return d;
    }),
  };
}

/** `existing` (the stored profile being edited) carries its ranking through unchanged; new profiles get 'impact'. */
export function profileFromDraft(d: EditorDraft, existing?: { ranking?: AlertRanking } | null): ProfileFromDraft {
  const rules = normalizeRules(d.rules).rules;
  return {
    ...(d.id ? { id: d.id } : {}),
    plant: d.plant,
    name: (d.name ?? '').trim(),
    description: d.description ?? '',
    ranking: existing?.ranking ?? 'impact',
    categories: d.categories ? _cloneCategories(d.categories) : _cloneCategories(effectiveCategories({ rules: d.rules.map(_wireRule) } as AlertProfile)),
    gantt_colors: d.gantt_colors !== false,
    show_acknowledged: d.show_acknowledged === true,
    rules,
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

const _defaultFmt = (d: Date): string => Util._fmtDatePref(d);

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

/** Seam the tests replace: the one count pass per draft change. */
export const editorSeams = {
  categoryCounts: (
    alerts: NimbusAlert[], tasksById: Record<string, NimbusTask | undefined>, profile: AlertProfile, plantToday: Date,
  ): Record<AlertCategory, number> => profileCategoryCounts(alerts, tasksById, profile, plantToday),
};

function _countProfile(d: { plant: string; rules: AlertProfileRule[]; categories: ProfileCategories }): AlertProfile {
  return {
    id: '', plant: d.plant, name: '', description: '', ranking: 'impact', created_by: null, updated_at: null,
    rules: d.rules, categories: d.categories,
  } as AlertProfile;
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
  /** Opened from the Alert Monitor's profile picker: a save then makes the page view the saved profile. */
  fromPicker: boolean;
  copy: CopyState | null;
  /** Fine-tune disclosure: auto-set on load / profile switch (see _autoTune), then the planner's own toggle wins. */
  tuneOpen: boolean;
  /** Per-group live counts from the last (single) count pass. */
  counts: Record<AlertCategory, number>;
}

let _s: EditorState | null = null;

const _snap = (d: EditorDraft): string => JSON.stringify(profileFromDraft(d));
function _setDraft(s: EditorState, d: EditorDraft): void { s.draft = d; s.baseline = _snap(d); }
function _dirty(s: EditorState): boolean { return _snap(s.draft) !== s.baseline; }

/** Fine-tune opens by itself only when something is tuned, there is more than one saved rule, or a rule has an error. */
function _autoTune(s: EditorState): boolean {
  return tunedCategories(s.draft).length > 0
    || normalizeRules(s.draft.rules).rules.length > 1
    || Object.keys(s.errors).some(k => k.startsWith('rules.'));
}

/** A save, delete or copy is on the wire: the editor must not close, switch profile or take other clicks until it settles. */
const _busy = (s: EditorState): boolean => s.saving || !!s.copy?.busy;

/** The matches line's number: every ON group's narrowed count, summed. */
const _totalOn = (s: EditorState): number =>
  ALERT_CATEGORY_ORDER.reduce((n, cat) => n + (s.draft.categories[cat].on ? (s.counts[cat] ?? 0) : 0), 0);

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

/** Cancel, the X, Escape and a backdrop click all land here: closing asks first when edits are unsaved, and waits out a save. */
function _requestClose(): void {
  const s = _s;
  if (!s || _busy(s)) return;
  _guardDiscard(s, () => AlertProfileEditor.close());
}

/** The alert type's display name: the same lookup and fallback as `AlertsUIAdapter.headlineFor`, kept local so the editor needs no NIMBUS global. */
function _headline(type: string): string {
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

/**
 * Every ON group needs one rule for its Fine-tune controls to edit. A blank group rule (every type of the group ticked, no
 * limits) matches the same as no rule and normalizeRules drops it, so adding them never changes what is saved or "dirty".
 */
function _ensureGroupRules(d: EditorDraft): void {
  for (const cat of ALERT_CATEGORY_ORDER) {
    if (d.categories[cat]?.on && !d.rules.some(r => _ruleApplies(r, cat))) d.rules.push(groupRule(cat));
  }
}

function _computeCounts(s: EditorState): Record<AlertCategory, number> {
  const rules = normalizeRules(s.draft.rules).rules;
  return editorSeams.categoryCounts(
    Store.alerts ?? [], Store.tasks ?? {}, _countProfile({ plant: s.plant, rules, categories: s.draft.categories }), _plantToday(s.plant),
  );
}

// ---- Rendering ------------------------------------------------------------------------------

const _err = (key: string | undefined): string =>
  key ? `<div class="ape-err" role="alert">${esc(t(key))}</div>` : '';

function _numVal(v: number | null): string { return v == null || Number.isNaN(v) ? '' : String(v); }

function _railHtml(s: EditorState): string {
  const dis = _busy(s) ? ' disabled' : '';
  const rows = _sortedProfiles(s.profiles).map(p => {
    const sel = p.id === s.draft.id;
    return `<div class="ape-prow${sel ? ' ape-prow-sel' : ''}">`
      + `<button type="button" class="ape-pname" data-ape-act="select" data-ape-id="${esc(p.id)}" data-ape-key="rail:sel:${esc(p.id)}"${sel ? ' aria-current="true"' : ''}${dis}>${esc(p.name)}</button>`
      + `<div class="ape-pacts">`
      + `<button type="button" class="btn sm btn-ghost" data-ape-act="dup" data-ape-id="${esc(p.id)}" data-ape-key="rail:dup:${esc(p.id)}"${dis}>${esc(t('ape.duplicate'))}</button>`
      + `<button type="button" class="btn sm btn-ghost" data-ape-act="copy" data-ape-id="${esc(p.id)}" data-ape-key="rail:copy:${esc(p.id)}"${dis}>${esc(t('ape.copy_to_plants'))}</button>`
      + `</div></div>`;
  }).join('');
  return `<aside class="ape-rail"><button type="button" class="btn sm${s.draft.id ? '' : ' ape-new-sel'}" data-ape-act="new" data-ape-key="rail:new"${dis}>${esc(t('ape.new_profile'))}</button>`
    + `<div class="ape-plist">${rows}</div></aside>`;
}

function _colorLabel(cat: AlertCategory, name: PaletteName): string {
  return t('ape.color_for', { group: t(`ape.cat_${cat}`), color: t(`ape.color_${name}`) });
}

/** Tier 1: one row per group. Grid `36px minmax(0,1fr) 48px 28px`. */
function _groupRowHtml(s: EditorState, cat: AlertCategory, editable: boolean): string {
  const c = s.draft.categories[cat];
  const dis = editable ? '' : ' disabled';
  const name = t(`ape.cat_${cat}`);
  const tuned = tunedCategories(s.draft).includes(cat);
  const err = s.errors[`categories.${cat}.color`];
  return `<div class="ape-grp${c.on ? '' : ' ape-grp-off'}" data-ape-grp="${cat}">`
    + `<label class="cal-day-toggle-wrap ape-switch" title="${esc(t('ape.switch_label', { group: name }))}">`
    + `<input type="checkbox" role="switch" aria-checked="${c.on}" aria-label="${esc(name)}" data-ape-grp-on="${cat}" data-ape-key="sw:${cat}"${c.on ? ' checked' : ''}${dis}>`
    + `<span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span></label>`
    + `<div class="ape-grp-text"><div class="ape-grp-name"><span class="ape-grp-label">${esc(name)}</span>`
    + `<span class="ape-badge" id="ape-badge-${cat}" title="${esc(t('ape.grp_tuned_tip'))}"${tuned ? '' : ' hidden'}>${esc(t('ape.grp_tuned'))}</span>`
    + `</div><span class="ape-grp-desc">${esc(t(`ape.cat_${cat}_desc`))}</span>${_err(err)}</div>`
    + `<span class="ape-grp-cnt" id="ape-cnt-${cat}">${s.counts[cat] ?? 0}</span>`
    + `<button type="button" class="ape-swbtn" data-ape-act="color" data-ape-cat="${cat}" data-color="${c.color}" data-ape-key="sw-color:${cat}"`
    + ` data-ovf-key="ape-color-${cat}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(_colorLabel(cat, c.color))}"${dis}>`
    + `<span class="ape-sw" aria-hidden="true"></span></button>`
    + `</div>`;
}

/** One rule row inside a group's Fine-tune block: day preset (+ Custom numbers), Errors only, late hours, the group's types. */
function _ruleHtml(s: EditorState, cat: AlertCategory, r: RuleDraft, i: number, rows: number, editable: boolean): string {
  const e = s.errors;
  const dis = editable ? '' : ' disabled';
  const preset = r.custom ? 'custom' : dayPresetOf(r.dayFrom, r.dayTo);
  const bad = (k: string) => (e[`rules.${i}.${k}`] ? ' is-invalid' : '');
  const types = groupTypes(cat);
  const ticked = types.filter(x => r.types.includes(x));
  const state = categoryCheckState(types, r.types);
  const key = (k: string) => `data-ape-key="${k}:${cat}:${i}"`;
  const presetOpts = (['any', 'overdue', 'next3', 'next7', 'next14', 'custom'] as DayPreset[]).map(p =>
    `<option value="${p}"${p === preset ? ' selected' : ''}>${esc(t(`ape.day_preset_${p}`))}</option>`).join('');
  const boxes = types.map(x =>
    `<label class="chk-inline"><input type="checkbox" data-ape-type="${esc(x)}" data-ape-rule="${i}" data-ape-cat="${cat}" ${key('ty-' + x)}`
    + `${r.types.includes(x) ? ' checked' : ''}${!editable || (ticked.length === 1 && r.types.includes(x)) ? ' disabled' : ''}`
    + `${editable && ticked.length === 1 && r.types.includes(x) ? ` title="${esc(t('ape.type_keep_one'))}"` : ''}>`
    + `<span>${esc(_headline(x))}</span></label>`).join('');
  const range = liveRange(r.dayFrom, r.dayTo, _plantToday(s.plant));
  const custom = preset === 'custom'
    ? `<div class="ape-days">`
      + `<div class="form-row"><label>${esc(t('ape.day_from'))}</label>`
      + `<input class="input${bad('dayFrom')}" type="number" min="-365" max="365" step="1" data-ape-field="dayFrom" data-ape-rule="${i}" value="${esc(_numVal(r.dayFrom))}"${dis}>${_err(e[`rules.${i}.dayFrom`])}</div>`
      + `<div class="form-row"><label>${esc(t('ape.day_to'))}</label>`
      + `<input class="input${bad('dayTo')}" type="number" min="-365" max="365" step="1" data-ape-field="dayTo" data-ape-rule="${i}" value="${esc(_numVal(r.dayTo))}"${dis}>${_err(e[`rules.${i}.dayTo`])}</div>`
      + `</div><div class="ape-hint">${esc(t('ape.days_hint'))}</div>${_err(e[`rules.${i}.days`])}`
    : '';
  const late = cat === 'late' || r.minLateHours != null
    ? `<div class="form-row ape-late"><label>${esc(t('ape.late_hours'))}</label>`
      + `<input class="input${bad('minLateHours')}" type="number" min="0" step="any" data-ape-field="minLateHours" data-ape-rule="${i}" value="${esc(_numVal(r.minLateHours))}"${dis}>${_err(e[`rules.${i}.minLateHours`])}</div>`
    : '';
  return `<div class="ape-rule" data-ape-rulecard="${i}">`
    + (rows > 1
      ? `<div class="ape-rule-head"><span class="ape-eyebrow">${esc(t('ape.rule_n', { n: i + 1 }))}</span>`
        + (editable ? `<button type="button" class="icon-btn sm" data-ape-act="rm-rule" data-ape-rule="${i}" aria-label="${esc(t('ape.remove_rule'))}" title="${esc(t('ape.remove_rule'))}">✕</button>` : '')
        + `</div>` : '')
    + `<div class="ape-rule-row">`
    + `<label class="ape-fld"><span class="ape-fld-l">${esc(t('ape.days'))}</span>`
    + `<select class="input" data-ape-field="dayPreset" data-ape-rule="${i}" ${key('pr')}${dis}>${presetOpts}</select></label>`
    + `<label class="chk-inline"><input type="checkbox" data-ape-field="errOnly" data-ape-rule="${i}" ${key('es')}${r.minSev === 'err' ? ' checked' : ''}${dis}>`
    + `<span>${esc(t('ape.sev_err'))}</span></label></div>`
    + `<div class="ape-range" id="ape-range-${cat}-${i}">${preset === 'custom' && range ? esc(t('ape.live_range', range)) : ''}</div>`
    + custom + late
    + (rows > 1 ? `<div class="ape-muted" id="ape-all-${cat}-${i}"${_ruleNarrows(r, cat) ? ' hidden' : ''}>${esc(t('ape.rule_matches_all'))}</div>` : '')
    + (types.length > 1
      ? `<div class="ape-types" data-state="${state}"><span class="ape-types-label">${esc(t('ape.types'))}</span><div class="ape-types-boxes">${boxes}</div></div>` : '')
    + _err(e[`rules.${i}.types`]) + _err(e[`rules.${i}.dup`])
    + `</div>`;
}

/** Tier 2 body: one block per ON group, then the muted Off and inert lines. */
function _tuneBodyHtml(s: EditorState, editable: boolean): string {
  const d = s.draft;
  const blocks = ALERT_CATEGORY_ORDER.filter(cat => d.categories[cat].on).map(cat => {
    const idx = d.rules.map((r, i) => (_ruleApplies(r, cat) ? i : -1)).filter(i => i >= 0);
    // The Add button and each rule's "matches everything" line are always in the markup (hidden when they do not apply):
    // typing in a day or late-hours box toggles them through _refreshLive, where a re-render would drop focus.
    const allNarrow = idx.every(i => _ruleNarrows(d.rules[i]!, cat));
    return `<div class="ape-tblock" data-ape-block="${cat}">`
      + `<div class="ape-tname">${esc(t(`ape.cat_${cat}`))}</div>`
      + idx.map(i => _ruleHtml(s, cat, d.rules[i]!, i, idx.length, editable)).join('')
      + (editable && idx.length
        ? `<button type="button" class="btn sm btn-ghost" id="ape-add-${cat}" data-ape-act="add-rule" data-ape-cat="${cat}"${allNarrow ? '' : ' hidden'}>${esc(t('ape.add_rule'))}</button>` : '')
      + `</div>`;
  }).join('');
  const off = ALERT_CATEGORY_ORDER.filter(cat => !d.categories[cat].on).map(cat => t(`ape.cat_${cat}`));
  const inert = normalizeRules(d.rules).rules.filter(w =>
    w.types != null && (w.types as string[]).length > 0 && (w.types as string[]).every(x => !d.categories[categoryOf(x)]?.on)).length;
  return blocks
    + _err(s.errors.rules)
    + (off.length ? `<div class="ape-muted">${esc(t('ape.groups_off', { groups: off.join(', ') }))}</div>` : '')
    + (inert ? `<div class="ape-muted">${esc(t('ape.rule_inert', { n: inert }))}</div>` : '');
}

function _formHtml(s: EditorState): string {
  const d = s.draft, e = s.errors, editable = _canEdit(s);
  const dis = editable ? '' : ' disabled';
  return `<section class="ape-form">`
    + (s.serverError ? _err(s.serverError) : '')
    + (editable ? '' : `<div class="ape-hint">${esc(t('ape.not_editable'))}</div>`)
    + `<div class="form-row"><label for="ape-name">${esc(t('ape.name'))}</label>`
    + `<input class="input${e.name ? ' is-invalid' : ''}" id="ape-name" type="text" maxlength="${MAX_NAME}" data-ape-field="name" data-ape-key="name" placeholder="${esc(t('ape.name_ph'))}" value="${esc(d.name)}"${dis}>${_err(e.name)}</div>`
    + `<div class="ape-rules-head"><span class="ape-eyebrow">${esc(t('ape.groups'))}</span><span class="ape-live" id="ape-matches">${esc(t('ape.live_matches', { n: _totalOn(s) }))}</span></div>`
    + `<div class="ape-hint">${esc(t('ape.groups_hint'))}</div>`
    + _err(e.categories)
    + `<div class="ape-groups" role="group" aria-label="${esc(t('ape.groups'))}">${ALERT_CATEGORY_ORDER.map(cat => _groupRowHtml(s, cat, editable)).join('')}</div>`
    + `<label class="chk-inline ape-gantt"><input type="checkbox" data-ape-field="ganttColors"${d.gantt_colors ? ' checked' : ''}${dis}><span>${esc(t('ape.gantt_colors'))}</span></label>`
    + `<div class="ape-hint">${esc(t('ape.gantt_colors_hint'))}</div>`
    + `<label class="chk-inline ape-gantt"><input type="checkbox" data-ape-field="showAcked"${d.show_acknowledged ? ' checked' : ''}${dis}><span>${esc(t('ape.show_acked'))}</span></label>`
    + `<div class="ape-hint">${esc(t('ape.show_acked_hint'))}</div>`
    + `<details class="ape-tune" data-ape-tune${s.tuneOpen ? ' open' : ''}>`
    + `<summary><span class="ape-tune-t">${esc(t('ape.tune'))}</span><span class="ape-hint">${esc(t('ape.tune_hint'))}</span></summary>`
    + `<div class="ape-tune-body">${_tuneBodyHtml(s, editable)}</div></details>`
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
    return `<button type="button" class="btn" data-ape-act="copy-cancel" data-ape-key="foot:copy-cancel"${s.copy.busy ? ' disabled' : ''}>${esc(t('btn.cancel'))}</button>`
      + `<button type="button" class="btn btn-primary" id="ape-copy-go" data-ape-act="copy-go" data-ape-key="foot:copy-go"${s.copy.sel.size && !s.copy.busy ? '' : ' disabled'}>${esc(t('ape.copy_go'))}</button>`;
  }
  const p = s.draft.id ? s.profiles.find(x => x.id === s.draft.id) : null;
  const canDelete = !!p && canDeleteProfile(p, Session.currentUser(), Session.isAdmin());
  return (canDelete
      ? `<button type="button" class="btn btn-danger ape-delete" data-ape-act="delete" data-ape-key="foot:delete"${s.saving ? ' disabled' : ''}>${esc(t('ape.delete'))}</button>` : '')
    + `<button type="button" class="btn" data-ape-act="cancel" data-ape-key="foot:cancel"${s.saving ? ' disabled' : ''}>${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" data-ape-act="save" data-ape-key="foot:save"${s.saving || !_canEdit(s) ? ' disabled' : ''}>${esc(t('btn.save'))}</button>`;
}

function _render(): void {
  const s = _s;
  if (!s) return;
  const body = document.getElementById('ape-body');
  const foot = document.getElementById('ape-foot');
  const title = document.getElementById('ape-title');
  if (title) title.textContent = t(s.draft.id ? 'ape.title_edit' : 'ape.title_new');
  const closeBtn = document.getElementById('ape-close') as HTMLButtonElement | null;
  if (closeBtn) closeBtn.disabled = _busy(s);
  if (!s.copy) { _ensureGroupRules(s.draft); s.counts = _computeCounts(s); }
  // A structural re-render replaces the focused control (a switch, a preset, a type, a rail or footer button, the Name box):
  // note it first, then put focus (and the caret) back on its twin once the body and footer are rebuilt.
  const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null;
  const focusKey = active?.dataset?.apeKey;
  const caret: [number | null, number | null] = [active?.selectionStart ?? null, active?.selectionEnd ?? null];
  if (body) {
    const top = body.scrollTop;
    body.innerHTML = `<div class="ape-layout">${_railHtml(s)}${s.copy ? _copyHtml(s, s.copy) : _formHtml(s)}</div>`;
    body.scrollTop = top;
  }
  if (foot) foot.innerHTML = _footHtml(s);
  if (focusKey) {
    const sel = `[data-ape-key="${focusKey.replace(/["\\]/g, '\\$&')}"]`;
    const twin = body?.querySelector?.<HTMLInputElement>(sel) ?? foot?.querySelector?.<HTMLInputElement>(sel);
    twin?.focus?.();
    if (twin && caret[0] != null) { try { twin.setSelectionRange(caret[0], caret[1] ?? caret[0]); } catch { /* not a text input */ } }
  }
  OverflowMenu.reconcile();
}

/** Recounts (one pass) and rewrites the live day-range lines, the per-group counts and the total: safe on every keystroke except Name. */
function _refreshLive(): void {
  const s = _s;
  if (!s || s.copy) return;
  const today = _plantToday(s.plant);
  s.counts = _computeCounts(s);
  const tuned = tunedCategories(s.draft);
  for (const cat of ALERT_CATEGORY_ORDER) {
    const cell = document.getElementById(`ape-cnt-${cat}`);
    if (cell) cell.textContent = String(s.counts[cat] ?? 0);
    const badge = document.getElementById(`ape-badge-${cat}`);
    if (badge) badge.hidden = !tuned.includes(cat);
    if (!s.draft.categories[cat].on) continue;
    let allNarrow = true;
    s.draft.rules.forEach((r, i) => {
      if (!_ruleApplies(r, cat)) return;
      const el = document.getElementById(`ape-range-${cat}-${i}`);
      const range = liveRange(r.dayFrom, r.dayTo, today);
      if (el) el.textContent = (r.custom || dayPresetOf(r.dayFrom, r.dayTo) === 'custom') && range ? t('ape.live_range', range) : '';
      const narrows = _ruleNarrows(r, cat);
      if (!narrows) allNarrow = false;
      const all = document.getElementById(`ape-all-${cat}-${i}`);
      if (all) all.hidden = narrows;
    });
    const add = document.getElementById(`ape-add-${cat}`);
    if (add) add.hidden = !allNarrow;
  }
  const m = document.getElementById('ape-matches');
  if (m) m.textContent = t('ape.live_matches', { n: _totalOn(s) });
}

let _liveTimer: ReturnType<typeof setTimeout> | null = null;
/** Number inputs fire per keystroke: coalesce the recount into one pass 120 ms after the last one. */
function _refreshLiveSoon(): void {
  if (_liveTimer) clearTimeout(_liveTimer);
  _liveTimer = setTimeout(() => { _liveTimer = null; _refreshLive(); }, 120);
}

// ---- Actions --------------------------------------------------------------------------------

function _revalidate(s: EditorState): boolean {
  const p = profileFromDraft(s.draft);
  const norm = normalizeRules(s.draft.rules);
  const v = validateProfile({ id: p.id, plant: p.plant, name: p.name, rules: p.rules, categories: p.categories }, s.profiles);
  // Errors are indexed by the saved rule list; show them under the draft rule that produced them.
  const errors: Record<string, string> = {};
  for (const [k, key] of Object.entries(v.errors)) {
    const m = /^rules\.(\d+)\.(.+)$/.exec(k);
    errors[m ? `rules.${norm.src[Number(m[1])] ?? m[1]}.${m[2]}` : k] = key;
  }
  s.errors = errors;
  return v.ok;
}

/** What a save or error says when the planner sees it as a toast (the in-editor path maps name_taken / stale to field messages). */
function _saveErrorText(err: unknown): string {
  const code = err instanceof AlertApiError ? err.code : null;
  if (code === 'name_taken') return t('ape.err_name_dup');
  if (code === 'stale') return t('ape.err_stale');
  return (err as Error)?.message || t('ape.err_save_failed');
}

async function _save(): Promise<void> {
  const s = _s;
  if (!s || s.saving) return;
  s.serverError = null;
  s.showErrors = true;
  if (!_revalidate(s)) {
    if (Object.keys(s.errors).some(k => k.startsWith('rules.'))) s.tuneOpen = true;
    _render();
    return;
  }
  s.saving = true;
  _render();
  const stored = s.draft.id ? s.profiles.find(x => x.id === s.draft.id) : undefined;
  // One wire body for create and update: a new profile field is added in profileFromDraft and travels on both.
  const { id: _id, expected_updated_at, ...body } = profileFromDraft(s.draft, stored);
  const name = body.name;
  try {
    const saved = s.draft.id
      ? await AlertProfileClient.update(s.draft.id, { ...body, expected_updated_at })
      : await AlertProfileClient.create(body);
    Toast.show(t('toast.alert_profile_saved', { name }), 'success');
    if (s.setMine) {
      const id = saved?.id ?? s.draft.id
        ?? (AlertProfileClient.cached(s.plant) ?? []).find(x => x.name === name)?.id;
      if (id) {
        const existing = (Store.pref('alertProfileByPlant') as Record<string, string> | null | undefined) ?? {};
        Session.setPref('alertProfileByPlant', { ...existing, [s.plant]: id });
        AlertProfileMatches.setSessionProfile(null);   // the pref now says the same thing
      }
    } else if (s.fromPicker) {
      // Opened from the page's picker: show what was just made, or what the page was already viewing and just changed.
      const savedId = saved?.id ?? s.draft.id;
      if (savedId && (!s.draft.id || savedId === AlertProfileMatches.current()?.profileId)) AlertProfileMatches.setSessionProfile(savedId);
    }
    if (_s === s) AlertProfileEditor.close();   // closed or replaced meanwhile: the save still stands, there is nothing to close
  } catch (err) {
    // The editor may be gone by now, but a failed save must still be told: the planner believes it is on the wire.
    if (_s !== s) { Toast.show(_saveErrorText(err), 'error'); return; }
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
  if (!s || !s.draft.id || s.saving) return;
  const id = s.draft.id;
  // The stored name, not the Name box: the planner may have typed an unsaved rename over it.
  const name = s.profiles.find(p => p.id === id)?.name ?? s.draft.name;
  const ok = await Modal.confirm({
    tone: 'danger',
    title: t('ape.delete_confirm_title'),
    message: t('ape.delete_confirm_msg', { name, plant: s.plant }),
  });
  if (!ok || _s !== s || s.saving) return;
  s.saving = true;
  _render();
  try {
    await AlertProfileClient.remove(id, s.plant);
    Toast.show(t('toast.alert_profile_deleted'), 'success');
    if (_s === s) AlertProfileEditor.close();
  } catch (err) {
    Toast.show((err as Error)?.message || t('ape.err_save_failed'), 'error');
    if (_s === s) { s.saving = false; _render(); }
  }
}

async function _copyGo(): Promise<void> {
  const s = _s;
  const c = s?.copy;
  if (!s || !c || c.busy) return;
  const src = s.profiles.find(p => p.id === c.srcId);
  if (!src) return;
  c.busy = true;
  _render();
  const ok: string[] = [];
  const failed: string[] = [];
  for (const target of [...c.sel].filter(p => p !== s.plant)) {
    try {
      await AlertProfileClient.create({
        plant: target, name: src.name, description: src.description, ranking: src.ranking,
        rules: (src.rules ?? []).map(r => ({ ...r, types: r.types == null ? null : [...r.types] })),
        categories: _cloneCategories(effectiveCategories(src)),
        gantt_colors: src.gantt_colors !== false,
        show_acknowledged: src.show_acknowledged === true,
      });
      ok.push(target);
    } catch (err) {
      const code = err instanceof AlertApiError ? err.code : null;
      failed.push(`${target}: ${code === 'name_taken' ? t('ape.err_name_dup') : ((err as Error)?.message || t('ape.err_save_failed'))}`);
    }
  }
  if (ok.length) Toast.show(t('toast.alert_profile_saved', { name: `${src.name} → ${ok.join(', ')}` }), 'success');
  if (failed.length) Toast.show(failed.join('; '), 'error');
  if (_s !== s) return;
  if (s.copy === c) s.copy = null;   // the planner may have moved on already (a rail pick); never tear down that view
  _render();
}

/** Switch to `d` as a fresh draft: clear errors, re-decide whether Fine-tune opens by itself. */
function _loadDraft(s: EditorState, d: EditorDraft): void {
  _setDraft(s, d);
  s.errors = {}; s.serverError = null; s.showErrors = false; s.copy = null; s.setMine = false;
  s.tuneOpen = _autoTune(s);
  _render();
}

function _selectProfile(id: string): void {
  const s = _s;
  const p = s?.profiles.find(x => x.id === id);
  if (!s || !p) return;
  _loadDraft(s, draftFromProfile(p));
}

function _newDraft(): void {
  const s = _s;
  if (!s) return;
  _loadDraft(s, blankDraft(s.plant));
}

function _duplicate(id: string): void {
  const s = _s;
  const p = s?.profiles.find(x => x.id === id);
  if (!s || !p) return;
  const d = draftFromProfile(p);
  delete d.id;
  d.updated_at = null;
  d.name = uniqueCopyName(p.name, s.profiles.map(x => x.name));
  _loadDraft(s, d);
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

/** The other ON groups wearing `name`, for the palette's "Also used by" hint. */
function _sharedWith(s: EditorState, cat: AlertCategory, name: PaletteName): string {
  return ALERT_CATEGORY_ORDER
    .filter(c => c !== cat && s.draft.categories[c].on && s.draft.categories[c].color === name)
    .map(c => t(`ape.cat_${c}`)).join(', ');
}

/** Opens the palette popover for a group's swatch. A pick patches the draft and the swatch in place: no re-render. */
function _openPalette(s: EditorState, anchor: HTMLElement, cat: AlertCategory): void {
  if (!_canEdit(s)) return;
  const current = s.draft.categories[cat].color;
  const items: MenuItem[] = PALETTE.map(name => {
    const shared = _sharedWith(s, cat, name);
    const isCurrent = name === current;
    const item: MenuItem = {
      id: `ape-color-${cat}-${name}`,
      label: t(`ape.color_${name}`) + (isCurrent ? '  ✓' : ''),
      data: { apColor: name, ...(isCurrent ? { current: '1' } : {}) },
      onSelect: () => {
        const st = _s;
        if (!st || st !== s) return;
        st.draft.categories[cat].color = name;
        anchor.setAttribute('data-color', name);
        anchor.setAttribute('aria-label', _colorLabel(cat, name));
        _afterEdit(st);
      },
    };
    if (shared) item.hint = t('ape.color_shared', { groups: shared });
    return item;
  });
  OverflowMenu.open(anchor, items, { align: 'end', key: `ape-color-${cat}` });
}

// ---- Event handlers (delegated; wired once on the static shell) ------------------------------

function _onClick(e: Event): void {
  const s = _s;
  const btn = (e.target as HTMLElement | null)?.closest?.('[data-ape-act]') as HTMLElement | null;
  if (!s || !btn || _busy(s)) return;   // a save, delete or copy is in flight: no switching, closing or editing under it
  const ds = btn.dataset;
  switch (ds.apeAct) {
    case 'select': _guardDiscard(s, () => _selectProfile(ds.apeId ?? '')); break;
    case 'new': _guardDiscard(s, _newDraft); break;
    case 'dup': _guardDiscard(s, () => _duplicate(ds.apeId ?? '')); break;
    case 'copy': _guardDiscard(s, () => _startCopy(s, ds.apeId ?? '')); break;
    case 'copy-cancel': s.copy = null; _render(); break;
    case 'copy-go': void _copyGo(); break;
    case 'color': _openPalette(s, btn, ds.apeCat as AlertCategory); break;
    case 'add-rule':
      s.draft.rules.push(groupRule(ds.apeCat as AlertCategory));
      _afterEdit(s);
      _render();
      break;
    case 'rm-rule':
      s.draft.rules.splice(Number(ds.apeRule), 1);
      s.errors = {};
      _afterEdit(s);
      _render();
      break;
    case 'save': void _save(); break;
    case 'delete': void _delete(); break;
    case 'cancel': _requestClose(); break;
  }
}

function _onField(e: Event, kind: 'input' | 'change'): void {
  const s = _s;
  const el = e.target as (HTMLInputElement & HTMLSelectElement) | null;
  if (!s || !el?.dataset) return;
  const ds = el.dataset;

  // Checkboxes only react to `change` (browsers also fire `input` for them); the handlers are idempotent.
  if (ds.apeGrpOn !== undefined) {
    if (kind !== 'change') return;
    const cat = ds.apeGrpOn as AlertCategory;
    if (!s.draft.categories[cat]) return;
    s.draft.categories[cat].on = !!el.checked;
    el.setAttribute?.('aria-checked', String(!!el.checked));   // the markup can never disagree with the input
    _afterEdit(s); _render();
    return;
  }
  if (ds.apeType !== undefined) {
    if (kind !== 'change') return;
    const r = _rule(s, ds);
    if (!r) return;
    const cat = ds.apeCat as AlertCategory;
    const ticked = groupTypes(cat).filter(x => r.types.includes(x));
    const has = r.types.includes(ds.apeType);
    if (el.checked && !has) r.types.push(ds.apeType);
    // A group always keeps one type ticked: with none, the rule would stop naming the group and the group would go unnarrowed.
    else if (!el.checked && has && ticked.length > 1) r.types = r.types.filter(x => x !== ds.apeType);
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
    // Name never recounts: only the saved/unsaved comparison and (when shown) the validation message depend on it.
    case 'name': s.draft.name = el.value; _afterEdit(s); break;
    case 'dayFrom': { const r = _rule(s, ds); if (r) { r.dayFrom = _parseNum(el.value); _afterEdit(s); _refreshLiveSoon(); } break; }
    case 'dayTo': { const r = _rule(s, ds); if (r) { r.dayTo = _parseNum(el.value); _afterEdit(s); _refreshLiveSoon(); } break; }
    case 'minLateHours': { const r = _rule(s, ds); if (r) { r.minLateHours = _parseNum(el.value); _afterEdit(s); _refreshLiveSoon(); } break; }
    case 'dayPreset': {
      if (kind !== 'change') break;
      const r = _rule(s, ds);
      if (!r) break;
      const range = dayPresetRange(el.value as DayPreset);
      if (range) { r.dayFrom = range.dayFrom; r.dayTo = range.dayTo; delete r.custom; } else r.custom = true;
      _afterEdit(s); _render();
      break;
    }
    case 'errOnly': {
      if (kind !== 'change') break;
      const r = _rule(s, ds);
      // A structural change (it can flip the group's Add rule button and "matches everything" line): re-render, focus returns by key.
      if (r) { r.minSev = el.checked ? 'err' : null; _afterEdit(s); _render(); }
      break;
    }
    case 'setMine': if (kind === 'change') s.setMine = !!el.checked; break;
    case 'ganttColors': if (kind === 'change') { s.draft.gantt_colors = !!el.checked; _afterEdit(s); } break;
    case 'showAcked': if (kind === 'change') { s.draft.show_acknowledged = !!el.checked; _afterEdit(s); } break;
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
  // `toggle` does not bubble: a capture-phase listener on the body records the planner's own open/close of Fine-tune.
  body?.addEventListener('toggle', e => {
    const d = e.target as (HTMLDetailsElement & { dataset?: DOMStringMap }) | null;
    if (_s && d?.dataset?.apeTune !== undefined) _s.tuneOpen = !!d.open;
  }, true);
  document.getElementById('ape-close')?.addEventListener('click', _requestClose);
  shell.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) _requestClose();
  });
  // The shell is data-no-backdrop-close (the generic handler would bypass the unsaved-edits check). A backdrop click closes
  // only when it both started and ended on the backdrop: a text selection dragged out of the form ends there too.
  let downOnBackdrop = false;
  shell.addEventListener('mousedown', e => { downOnBackdrop = e.target === shell; });
  shell.addEventListener('click', e => {
    const hit = e.target === shell && downOnBackdrop;
    downOnBackdrop = false;
    if (hit) _requestClose();
  });
}

// ---- Public API -----------------------------------------------------------------------------

export const AlertProfileEditor = {
  /** Open the editor for `plant`: an existing profile when `profileId` matches, else a blank draft. */
  open(opts: { plant: string; profileId?: string; fromPicker?: boolean }): void {
    const plant = opts.plant;
    if (!plant) return;
    if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
    const profiles = AlertProfileClient.cached(plant) ?? [];
    const found = opts.profileId ? profiles.find(p => p.id === opts.profileId) : undefined;
    const draft = found ? draftFromProfile(found) : blankDraft(plant);
    const s: EditorState = {
      plant, profiles,
      draft, baseline: _snap(draft),
      errors: {}, serverError: null, showErrors: false, saving: false, setMine: false, fromPicker: !!opts.fromPicker, copy: null,
      tuneOpen: false, counts: {} as Record<AlertCategory, number>,
    };
    s.tuneOpen = _autoTune(s);
    _s = s;
    _wire();
    _render();
    Modal.open('modal-alert-profile');
    // The cache may be cold or stale: refetch (force) so the rail shows a colleague's profiles, without clobbering an
    // in-progress draft. An unchanged list repaints nothing (a rebuild resets the caret for no gain).
    void AlertProfileClient.list(plant, { force: true }).then(list => {
      if (_s !== s) return;
      if (JSON.stringify(list) === JSON.stringify(s.profiles)) return;
      s.profiles = list;
      const wanted = opts.profileId ? list.find(p => p.id === opts.profileId) : undefined;
      // The cache lacked the asked-for profile: show it, but only over a blank draft nobody has touched.
      if (wanted && !s.draft.id && !s.copy && !_dirty(s)) {
        _setDraft(s, draftFromProfile(wanted));
        s.tuneOpen = _autoTune(s);
      }
      _render();
    }).catch(() => { /* the cached rail stays; the load failure is toasted by the pane */ });
  },

  close(): void {
    if (!_s) return;
    _s = null;
    if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
    OverflowMenu.closeAll();
    Modal.close('modal-alert-profile');
  },

  /** Test seam: the live editor state and a forced re-render. Not for page code. */
  _test: { state: (): unknown => _s, render: _render },
};
