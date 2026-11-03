/* =============================================================================
   ALERT PROFILES — pure semantics shared by the Alert Monitor page, the alert
   drawer / bell filter and the Gantt highlight: "does this alert match the
   user's profile", ranking, grouping, validation and active-profile resolution.

   Deliberately pure: no Store, no DOM, no fetch, no UI strings. The only import
   is `import type` from platform/types.mjs, so a node test can load it bare.

   Collaborators arrive through two seams:
   - Scoring primitives (alertPoints, CONFIDENCE_WEIGHTS, dueDateInstant) come from
     `globalThis.NimbusComputeCore` when it is loaded (browser: a classic script;
     node tests: createRequire), with literal fallbacks matching the core so the
     module also works without it.
   - Order facts that need Store-backed calendars (`dueInstant`, `latenessHours`)
     are injectable through a small `deps` object. The default lazily reads
     `globalThis.NIMBUS?.Util` (the legacy namespace the browser exposes) at call
     time, never at import time, so this module stays DOM-free and testable. With
     neither present, `dueInstant` degrades to the core's calendar-less reading of
     the due date and `latenessHours` to 0.

   Day arithmetic is calendar-based (`new Date(y, m, d + n)` / Date.UTC of the
   calendar fields), never "+ 86400000 ms", so DST days do not shift offsets.
   `plantToday` is always passed in by the caller (start of the plant-local day).
   ========================================================================== */

import type { AlertType, AlertCategory, AlertProfile, AlertProfileRule, AlertRanking, NimbusTask, PaletteName, ProfileCategories } from '../platform/types.mjs';

// ---- Dependencies ---------------------------------------------------------------------------

export interface ProfileDeps {
  /** The order's due date as an instant (a date-only SAP due resolved to its line's close). */
  dueInstant?: (task: NimbusTask) => Date | null;
  /** Hours the order finishes after its due date (0 when on time). */
  latenessHours?: (task: NimbusTask) => number;
}

interface NimbusUtilLike {
  dueInstant?: (task: NimbusTask) => Date | null;
  latenessHours?: (task: NimbusTask) => number;
}

type TaskLookup = Record<string, NimbusTask | undefined>;

const _core = () => (globalThis as { NimbusComputeCore?: NimbusComputeCoreApi }).NimbusComputeCore;
const _util = (): NimbusUtilLike | undefined =>
  (globalThis as unknown as { NIMBUS?: { Util?: NimbusUtilLike } }).NIMBUS?.Util;

// Mirrors NimbusComputeCore.CONFIDENCE_WEIGHTS (Task 4) for use without the core.
const FALLBACK_WEIGHTS = { err: 5, warn: 2, tw3: 1.5, tw7: 1.25 } as const;

function _resolveDeps(deps?: ProfileDeps): Required<ProfileDeps> {
  const util = _util();
  const dueInstant = deps?.dueInstant
    ?? (util?.dueInstant ? (t: NimbusTask) => util.dueInstant!(t) : _calendarlessDue);
  const latenessHours = deps?.latenessHours
    ?? (util?.latenessHours ? (t: NimbusTask) => util.latenessHours!(t) : () => 0);
  return { dueInstant, latenessHours };
}

function _calendarlessDue(task: NimbusTask): Date | null {
  const raw = task.original_end_date;
  if (!(raw instanceof Date) || isNaN(raw.getTime())) return null;
  const core = _core();
  return core?.dueDateInstant ? core.dueDateInstant(raw, () => null) : raw;
}

function _validDate(d: unknown): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
}

// ---- Built-in profile + categories ----------------------------------------------------------

export const ALL_ALERTS_PROFILE_ID = '__all__';

/** The built-in "All alerts" pseudo-profile: one all-null rule, never a stored row. */
export const ALL_ALERTS_PROFILE: AlertProfile = Object.freeze({
  id: ALL_ALERTS_PROFILE_ID,
  plant: '',
  name: 'All alerts',
  description: '',
  rules: Object.freeze([Object.freeze({ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null })]) as unknown as AlertProfileRule[],
  ranking: 'impact',
  created_by: null,
  updated_at: null,
  builtIn: true,
}) as AlertProfile;

/** The cell briefing's former CAT_MAP, hoisted, plus the setup-diagnostic group. */
export const ALERT_CATEGORIES: Record<AlertCategory, AlertType[]> = {
  capacity: ['overload', 'near-capacity'],
  conflicts: ['overlap', 'tool-conflict', 'distribution-separation'],
  calendar: [
    'blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours',
    'finish_moved_earlier', 'plant_no_timezone', 'line_no_calendar', 'no_operating_window',
  ],
  setup: [
    'setup-violated', 'setup-uncovered', 'initial-state-unknown', 'current-state-diverged',
    'override-inactive', 'predecessor-state-unknown', 'successor-state-unknown',
  ],
  planning: ['queued_now_fits', 'needs_planning'],
  late: ['late'],
  exceptions: [
    'runtime-schedule-mismatch', 'runtime-unknown', 'pv-lot-size',
    'reversal_forward', 'placement_exception', 'frozen_window_crossed',
    'pull_floor_crossed', 'setup_override_orphaned', 'no_anchor', 'derivation_issue', 'run_time_zero',
  ],
};

/** The one category order (capacity first, Other last); CATEGORY_ORDER and MONITOR_CATEGORIES alias it. */
export const ALERT_CATEGORY_ORDER: readonly AlertCategory[] = Object.keys(ALERT_CATEGORIES) as AlertCategory[];

/** The nine fixed swatches a profile colours its alert groups from (CSS tokens --pal-<name>, -fg, -ring). */
export const PALETTE: readonly PaletteName[] = ['amber', 'orange', 'magenta', 'violet', 'teal', 'sky', 'slate', 'sand', 'stone'];

/** The colour each group wears unless a profile says otherwise (also the built-in "All alerts" and legacy profiles). */
export const DEFAULT_CATEGORY_COLORS: Readonly<Record<AlertCategory, PaletteName>> = Object.freeze({
  capacity: 'amber', conflicts: 'violet', calendar: 'teal', setup: 'magenta', planning: 'orange', late: 'slate', exceptions: 'stone',
});

/**
 * The full 21-key custom-property map for a profile: `--bar-pm-<cat>`, `-fg` and `-ring` for every group, each pointing
 * at the group's palette swatch. A built-in or legacy (no `categories`) profile yields the defaults, never `{}`, so
 * writing it always restores the stylesheet's own colours. The values are `var(--pal-...)` references, written inline
 * on `document.body` (or a descendant), where they resolve against the theme's swatches (see applyCategoryColors).
 */
export function categoryColorDecls(p: AlertProfile | null | undefined): Record<string, string> {
  const cats = p && !p.builtIn ? p.categories ?? null : null;
  const out: Record<string, string> = {};
  for (const cat of ALERT_CATEGORY_ORDER) {
    const name = cats?.[cat]?.color ?? DEFAULT_CATEGORY_COLORS[cat];
    out[`--bar-pm-${cat}`] = `var(--pal-${name})`;
    out[`--bar-pm-${cat}-fg`] = `var(--pal-${name}-fg)`;
    out[`--bar-pm-${cat}-ring`] = `var(--pal-${name}-ring)`;
  }
  return out;
}

const _categoryByType = new Map<string, AlertCategory>();
for (const [cat, types] of Object.entries(ALERT_CATEGORIES) as Array<[AlertCategory, AlertType[]]>) {
  for (const t of types) _categoryByType.set(t, cat);
}

export function categoryOf(type: string): AlertCategory {
  return _categoryByType.get(type) ?? 'exceptions';
}

/** Types the drawer and the Alert Monitor offer a one-click Fix for. */
export const FIXABLE_ALERT_TYPES: ReadonlySet<string> = new Set(['overlap', 'blackout', 'overload', 'tool-conflict']);
/** The types a group's "Move N orders" moves: every fixable type except `overload` (its fix runs the line-day changeover optimizer). */
export function movableAlertTypes(): ReadonlySet<string> {
  return new Set([...FIXABLE_ALERT_TYPES].filter(t => t !== 'overload'));
}
/** A tool conflict with no usable copy (available 0) can never be cleared by moving an order: the Fix action and "Move N orders" skip it. */
export function isUnfixableToolAlert(a: { type: string; available?: number | null }): boolean {
  return a.type === 'tool-conflict' && a.available === 0;
}
/** Whether an alert offers the one-click Fix: a fixable type, minus a tool conflict with zero available copies. */
export function isFixableAlert(a: { type: string; available?: number | null }): boolean {
  return FIXABLE_ALERT_TYPES.has(a.type) && !isUnfixableToolAlert(a);
}
/** Types offered Override (when the alert carries a taskId). */
export const OVERRIDE_ALERT_TYPES: ReadonlySet<string> = new Set(['closed', 'firmed-closed', 'firmed-out-of-hours']);
/** Calendar-family types: drawn with the ⊘ glyph / calendar styling. */
export const CALENDAR_ALERT_TYPES: ReadonlySet<string> = new Set(['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours']);

/** Queued-order types offered the Slot recommendation (Task 5 onward); disjoint from Fix / Override / Calendar. */
export const SLOT_ALERT_TYPES: ReadonlySet<string> = new Set(['needs_planning']);

/** Alert types that can actually fire: every type except `near-capacity` and `line_no_calendar` (mirrors the server's ALERT_TYPES). */
export const FIRING_ALERT_TYPES: AlertType[] =
  Object.values(ALERT_CATEGORIES).flat().filter(t => t !== 'near-capacity' && t !== 'line_no_calendar');

// ---- Anchor + day offset --------------------------------------------------------------------

/**
 * The instant a profile window is evaluated on (D15): the order's due date when the alert
 * has a task that carries one, else the alert's own time. Null when neither exists.
 */
export function anchorTime(alert: NimbusAlert, task: NimbusTask | undefined, deps?: ProfileDeps): Date | null {
  if (alert.taskId && task && task.original_end_date) {
    const due = _resolveDeps(deps).dueInstant(task);
    if (_validDate(due)) return due;
  }
  return _validDate(alert.time) ? alert.time : null;
}

/** Whole calendar days from `plantToday` to the anchor's calendar day (negative = overdue). DST-safe. */
export function alertDayOffset(anchor: Date, plantToday: Date): number {
  const a = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const b = Date.UTC(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate());
  return Math.round((a - b) / 86400000);
}

// ---- Matching -------------------------------------------------------------------------------

export function ruleMatches(
  alert: NimbusAlert, task: NimbusTask | undefined, rule: AlertProfileRule, plantToday: Date, deps?: ProfileDeps,
): boolean {
  if (rule.types && !(rule.types as string[]).includes(alert.type)) return false;
  if (rule.minSev === 'err' && alert.sev !== 'err') return false;

  if (rule.dayFrom != null || rule.dayTo != null) {
    const anchor = anchorTime(alert, task, deps);
    if (!anchor) return false;
    const y = plantToday.getFullYear(), m = plantToday.getMonth(), d = plantToday.getDate();
    // [today + dayFrom 00:00, today + dayTo + 1 00:00), stepped by calendar day.
    if (rule.dayFrom != null && anchor < new Date(y, m, d + rule.dayFrom)) return false;
    if (rule.dayTo != null && anchor >= new Date(y, m, d + rule.dayTo + 1)) return false;
  }

  if (rule.minLateHours != null) {
    if (!task) return false;
    if (!(_resolveDeps(deps).latenessHours(task) >= rule.minLateHours)) return false;
  }
  return true;
}

/**
 * Whether a rule narrows the alerts of `cat`: no type list (applies everywhere) or a list naming at least one type of that
 * category. Category-level on purpose: a rule `{types:['setup-violated'], dayFrom:0, dayTo:3}` narrows the whole Setup group,
 * so under a profile that switches Setup on it never lets a `setup-uncovered` alert through (the rule names another type).
 */
export function ruleAppliesTo(rule: { types: readonly string[] | null }, cat: AlertCategory): boolean {
  if (rule.types == null) return true;
  return rule.types.some(t => categoryOf(t) === cat);
}

function _isPaletteName(v: unknown): v is PaletteName {
  return typeof v === 'string' && (PALETTE as readonly string[]).includes(v);
}

/**
 * A profile's seven groups, each `{on, color}`. A stored `categories` map wins; a legacy profile (null/absent) derives it:
 * a group is on when some rule applies to it, its colour is the default. Within a stored map a missing key is derived the
 * same way and an unknown colour is replaced by the default. Always a fresh object; the frozen built-in is never written to.
 */
export function effectiveCategories(p: AlertProfile): ProfileCategories {
  const stored = p.categories && typeof p.categories === 'object' ? p.categories : null;
  const rules = p.rules ?? [];
  const out = {} as ProfileCategories;
  for (const cat of ALERT_CATEGORY_ORDER) {
    const s = stored?.[cat];
    if (s && typeof s === 'object') {
      out[cat] = { on: s.on === true, color: _isPaletteName(s.color) ? s.color : DEFAULT_CATEGORY_COLORS[cat] };
    } else {
      out[cat] = { on: rules.some(r => ruleAppliesTo(r, cat)), color: DEFAULT_CATEGORY_COLORS[cat] };
    }
  }
  return out;
}

interface CompiledProfile {
  rules: AlertProfileRule[];
  categories: AlertProfile['categories'];
  cats: ProfileCategories;
  byCat: Record<AlertCategory, AlertProfileRule[]>;
}

// Memoised per profile object (never a property on the frozen built-in); re-compiled when rules/categories are replaced.
const _compiled = new WeakMap<AlertProfile, CompiledProfile>();

function _compile(profile: AlertProfile): CompiledProfile {
  const hit = _compiled.get(profile);
  if (hit && hit.rules === profile.rules && hit.categories === profile.categories) return hit;
  const byCat = {} as Record<AlertCategory, AlertProfileRule[]>;
  for (const cat of ALERT_CATEGORY_ORDER) byCat[cat] = (profile.rules ?? []).filter(r => ruleAppliesTo(r, cat));
  const next: CompiledProfile = { rules: profile.rules, categories: profile.categories, cats: effectiveCategories(profile), byCat };
  _compiled.set(profile, next);
  return next;
}

function _narrowMatches(
  alert: NimbusAlert, task: NimbusTask | undefined, applicable: AlertProfileRule[], plantToday: Date, deps?: ProfileDeps,
): boolean {
  return applicable.length === 0 || applicable.some(r => ruleMatches(alert, task, r, plantToday, deps));
}

/** The group's switch is on AND (no rule narrows the group OR some narrowing rule matches). */
export function profileMatches(
  alert: NimbusAlert, task: NimbusTask | undefined, profile: AlertProfile, plantToday: Date, deps?: ProfileDeps,
): boolean {
  const c = _compile(profile);
  const cat = categoryOf(alert.type);
  return c.cats[cat].on && _narrowMatches(alert, task, c.byCat[cat], plantToday, deps);
}

/** Per-group alert counts for the editor's live numbers: every switch treated as on, the per-group rules still narrowing. One pass. */
export function profileCategoryCounts(
  alerts: NimbusAlert[], tasksById: TaskLookup, profile: AlertProfile, plantToday: Date, deps?: ProfileDeps,
): Record<AlertCategory, number> {
  const c = _compile(profile);
  const out = {} as Record<AlertCategory, number>;
  for (const cat of ALERT_CATEGORY_ORDER) out[cat] = 0;
  for (const a of alerts) {
    const cat = categoryOf(a.type);
    if (_narrowMatches(a, a.taskId ? tasksById?.[a.taskId] : undefined, c.byCat[cat], plantToday, deps)) out[cat]++;
  }
  return out;
}

export function filterByProfile(
  alerts: NimbusAlert[], tasksById: TaskLookup, profile: AlertProfile, plantToday: Date, deps?: ProfileDeps,
): NimbusAlert[] {
  return alerts.filter(a => profileMatches(a, a.taskId ? tasksById?.[a.taskId] : undefined, profile, plantToday, deps));
}

// ---- Ranking --------------------------------------------------------------------------------

export interface RankContext {
  tasksById: TaskLookup;
  horizonStart: Date;
  horizonMinutes: number;
  deps?: ProfileDeps;
}

/** Uncapped impact points of one alert (err 5 / warn 2, x time weight; 0 outside the horizon). */
export function impactPoints(alert: NimbusAlert, horizonStart: Date, horizonMinutes: number): number {
  const horizonEnd = new Date(horizonStart.getTime() + horizonMinutes * 60000);
  const core = _core();
  if (core?.alertPoints) return core.alertPoints(alert, horizonStart, horizonEnd);
  // Mirrors the core: an alert with a `due` is scored by it (past due counts as due now), else by `time`.
  let when: Date;
  if (_validDate(alert.due)) {
    if (alert.due >= horizonEnd) return 0;
    when = alert.due < horizonStart ? horizonStart : alert.due;
  } else {
    if (!_validDate(alert.time) || alert.time >= horizonEnd) return 0;
    if (alert.time < horizonStart) {
      const dayStart = new Date(horizonStart.getFullYear(), horizonStart.getMonth(), horizonStart.getDate());
      if (alert.time < dayStart) return 0;   // an earlier day is history; earlier today counts as due now
      when = horizonStart;
    } else when = alert.time;
  }
  const base = alert.sev === 'err' ? FALLBACK_WEIGHTS.err : alert.sev === 'warn' ? FALLBACK_WEIGHTS.warn : 0;
  const days = (when.getTime() - horizonStart.getTime()) / 86400000;
  return base * (days <= 3 ? FALLBACK_WEIGHTS.tw3 : days <= 7 ? FALLBACK_WEIGHTS.tw7 : 1);
}

/** Every order an alert touches: the anchor order, then every peer (`peerIds` when present, else the single
 *  `peerId`), de-duplicated. THE one reader of the peer fields: a count-aware tool conflict carries many peers, so
 *  no consumer may read `alert.peerId` directly (tests/modules/insights/alert-order-ids.test.mjs gates this). */
export function alertOrderIds(alert: Pick<NimbusAlert, "taskId" | "peerId" | "peerIds">): string[] {
  const out: string[] = [];
  const add = (id: unknown): void => { if (id != null && id !== "" && !out.includes(String(id))) out.push(String(id)); };
  add(alert.taskId);
  if (alert.peerIds) for (const id of alert.peerIds) add(id);
  else add(alert.peerId);
  return out;
}

function _affectedOrders(alert: NimbusAlert): number {
  return alertOrderIds(alert).length;
}

/** Anchor as sortable ms; alerts with no anchor sort last. */
function _anchorKey(alert: NimbusAlert, ctx: RankContext): number {
  const task = alert.taskId ? ctx.tasksById?.[alert.taskId] : undefined;
  const a = anchorTime(alert, task, ctx.deps);
  return a ? a.getTime() : Infinity;
}

function _cmpNum(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;   // handles Infinity - Infinity without NaN
}

/** A closure-local, lazily filled key cache: each alert's key is computed once per comparator instance, not once per
 *  comparison (a sort makes O(n log n) comparisons and each needs two keys). Keyed by the alert object. */
function _memoKey(compute: (alert: NimbusAlert) => number): (alert: NimbusAlert) => number {
  const cache = new Map<NimbusAlert, number>();
  return (alert) => {
    let v = cache.get(alert);
    if (v === undefined) { v = compute(alert); cache.set(alert, v); }
    return v;
  };
}

/** Comparator for `Array.prototype.sort`; ties always end on alert id so the order is deterministic. The sort keys
 *  (anchor, impact, affected orders) are memoised per alert for the comparator's lifetime: build one comparator per sort
 *  and do not mutate the alerts between its calls. */
export function compareAlerts(ranking: AlertRanking, ctx: RankContext): (a: NimbusAlert, b: NimbusAlert) => number {
  const byId = (a: NimbusAlert, b: NimbusAlert) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const anchorKey = _memoKey(a => _anchorKey(a, ctx));
  const byAnchor = (a: NimbusAlert, b: NimbusAlert) => _cmpNum(anchorKey(a), anchorKey(b));
  switch (ranking) {
    case 'time':
      return (a, b) => byAnchor(a, b) || byId(a, b);
    case 'severity':
      return (a, b) => _cmpNum(a.sev === 'err' ? 0 : 1, b.sev === 'err' ? 0 : 1) || byAnchor(a, b) || byId(a, b);
    case 'orders': {
      const orders = _memoKey(_affectedOrders);
      return (a, b) => _cmpNum(orders(b), orders(a)) || byAnchor(a, b) || byId(a, b);
    }
    case 'impact':
    default: {
      const points = _memoKey(a => impactPoints(a, ctx.horizonStart, ctx.horizonMinutes));
      return (a, b) => _cmpNum(points(b), points(a)) || byAnchor(a, b) || byId(a, b);
    }
  }
}

// ---- Grouping -------------------------------------------------------------------------------

export type AlertGroupBy = 'category' | 'type' | 'line' | 'day' | 'order' | 'none';

export interface AlertGroup {
  key: string;
  /** Interpolation variables for the group's label (keyed by the grouping dimension). */
  vars: Record<string, string | number>;
  alerts: NimbusAlert[];
  /** Summed uncapped impact points. */
  points: number;
  /** Distinct orders touched (`alertOrderIds`). */
  orderIds: string[];
}

export interface GroupContext extends RankContext {
  plantToday: Date;
}

/** Group / narrow key of an alert with no line (or no order, or no anchor day). */
export const NONE_KEY = 'none';

/** `YYYY-MM-DD` of a local date: the one day key shared by `groupAlerts('day')` and the Alert Monitor Overview bars. */
export function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const _dayKey = dayKeyOf;

export function groupAlerts(alerts: NimbusAlert[], by: AlertGroupBy, ctx: GroupContext): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  const orderSets = new Map<string, Set<string>>();   // O(1) de-dup while grouping; flattened to `orderIds` at the end
  const keyOf = (a: NimbusAlert): string => {
    switch (by) {
      case 'category': return categoryOf(a.type);
      case 'type': return a.type;
      case 'line': return a.line || NONE_KEY;
      case 'order': return a.taskId || NONE_KEY;
      case 'day': {
        const task = a.taskId ? ctx.tasksById?.[a.taskId] : undefined;
        const anchor = anchorTime(a, task, ctx.deps);
        return anchor ? _dayKey(anchor) : NONE_KEY;
      }
      case 'none':
      default: return 'all';
    }
  };
  for (const a of alerts) {
    const key = keyOf(a);
    let g = groups.get(key);
    if (!g) {
      g = { key, vars: by === 'none' ? {} : { [by]: key }, alerts: [], points: 0, orderIds: [] };
      groups.set(key, g);
      orderSets.set(key, new Set());
    }
    g.alerts.push(a);
    g.points += impactPoints(a, ctx.horizonStart, ctx.horizonMinutes);
    const ids = orderSets.get(key)!;
    for (const id of alertOrderIds(a)) ids.add(id);
  }
  for (const [key, g] of groups) g.orderIds = [...orderSets.get(key)!];
  return [...groups.values()].sort((x, y) =>
    _cmpNum(y.points, x.points) || _cmpNum(y.alerts.length, x.alerts.length) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

// ---- Validation -----------------------------------------------------------------------------

export interface AlertProfileDraft {
  id?: string;
  plant: string;
  name: string;
  rules: AlertProfileRule[];
  /** Per-group switch + colour; when present it is validated and `rules` may be empty. */
  categories?: ProfileCategories | null;
  gantt_colors?: boolean;
  show_acknowledged?: boolean;
}

export interface ProfileValidation {
  ok: boolean;
  /** field path -> i18n key. Paths: `name`, `rules`, `categories`, `categories.<cat>.color`, `rules.<i>.{types|dayFrom|dayTo|days|minLateHours|dup}`. */
  errors: Record<string, string>;
}

/** The largest whole-day offset a rule bound may take (either sign); mirrors the server. */
export const DAY_BOUND = 365;
/** The longest profile name; mirrors the server. */
export const MAX_NAME_LEN = 60;
const MAX_RULES = 20;
const _firing = new Set<string>(FIRING_ALERT_TYPES);

function _dayOk(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= -DAY_BOUND && v <= DAY_BOUND;
}

/** Mirrors backend/alert_profiles/data.py validate_rules plus per-plant name uniqueness (case-insensitive, excluding self). */
export function validateProfile(draft: AlertProfileDraft, existing: AlertProfile[]): ProfileValidation {
  const errors: Record<string, string> = {};

  const name = (draft.name ?? '').trim();
  if (!name) errors.name = 'ape.err_name_required';
  else if (name.length > MAX_NAME_LEN) errors.name = 'ape.err_name_long';
  else if (existing.some(p => p.plant === draft.plant && p.id !== draft.id && p.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'ape.err_name_dup';
  }

  const hasCategories = draft.categories != null;
  if (hasCategories) {
    const c = draft.categories as unknown;
    if (typeof c !== 'object' || Array.isArray(c)) errors.categories = 'ape.err_no_categories';
    else {
      let anyOn = false;
      for (const cat of ALERT_CATEGORY_ORDER) {
        const e = (c as Record<string, unknown>)[cat] as { on?: unknown; color?: unknown } | undefined;
        if (!e || typeof e !== 'object' || typeof e.on !== 'boolean') { errors.categories = 'ape.err_no_categories'; continue; }
        if (e.on) anyOn = true;
        if (!_isPaletteName(e.color)) errors[`categories.${cat}.color`] = 'ape.err_color';
      }
      if (!anyOn) errors.categories = 'ape.err_no_categories';
      // The server insists on exactly the seven keys: an extra one is a shape error (and wins over the others).
      if (Object.keys(c as Record<string, unknown>).some(k => !(ALERT_CATEGORY_ORDER as readonly string[]).includes(k))) {
        errors.categories = 'ape.err_categories_shape';
      }
    }
  }

  const rules = draft.rules ?? [];
  if (!rules.length) { if (!hasCategories) errors.rules = 'ape.err_no_rules'; }
  else if (rules.length > MAX_RULES) errors.rules = 'ape.err_too_many_rules';

  const seen = new Set<string>();
  rules.forEach((r, i) => {
    const at = (f: string) => `rules.${i}.${f}`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { errors[at('types')] = 'ape.err_rule_no_types'; return; }
    if (r.types != null && (!Array.isArray(r.types) || !r.types.length || r.types.some(t => !_firing.has(t)))) {
      errors[at('types')] = 'ape.err_rule_no_types';
    }
    const fromBad = r.dayFrom != null && !_dayOk(r.dayFrom);
    const toBad = r.dayTo != null && !_dayOk(r.dayTo);
    if (fromBad) errors[at('dayFrom')] = 'ape.err_days_range';
    if (toBad) errors[at('dayTo')] = 'ape.err_days_range';
    if (!fromBad && !toBad && r.dayFrom != null && r.dayTo != null && r.dayFrom > r.dayTo) errors[at('days')] = 'ape.err_days_order';
    if (r.minLateHours != null && !(typeof r.minLateHours === 'number' && Number.isFinite(r.minLateHours) && r.minLateHours >= 0)) {
      errors[at('minLateHours')] = 'ape.err_late_hours';
    }
    if (r.minSev != null && r.minSev !== 'warn' && r.minSev !== 'err') errors[at('minSev')] = 'ape.err_min_sev';
    const sig = JSON.stringify([
      Array.isArray(r.types) ? [...new Set(r.types)].sort() : null, r.dayFrom ?? null, r.dayTo ?? null, r.minSev ?? null, r.minLateHours ?? null,
    ]);
    if (seen.has(sig)) errors[at('dup')] = 'ape.err_rule_dup';
    seen.add(sig);
  });

  return { ok: Object.keys(errors).length === 0, errors };
}

// ---- Active profile -------------------------------------------------------------------------

type ProfileSettings = { alertProfileByPlant?: Record<string, string> | null } | null | undefined;

/**
 * user setting > role default > the built-in All alerts. An id that is not in `available`
 * (deleted, or another plant's) resolves to All alerts rather than falling through to the next tier.
 */
export function resolveActiveProfileId(
  plant: string, userSettings: ProfileSettings, roleDefaults: ProfileSettings, available: Array<{ id: string }>,
): string {
  const id = userSettings?.alertProfileByPlant?.[plant] ?? roleDefaults?.alertProfileByPlant?.[plant] ?? ALL_ALERTS_PROFILE_ID;
  if (id === ALL_ALERTS_PROFILE_ID) return id;
  return available.some(p => p.id === id) ? id : ALL_ALERTS_PROFILE_ID;
}

// ---- Acknowledgement label --------------------------------------------------------------------

/** "YYYY-MM-DD[...]" -> "MM/DD/YYYY" from string parts (mirrors Util.fmtIsoDate; this module stays Util-free). */
const _isoToMdy = (s: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
};

/** "Acknowledged by X until D" / "Acknowledged by X" (shared by the Alert Monitor row and the drawer row). */
export function ackLabel(
  ack: { acknowledged_by?: string | null; until?: string | null } | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (!ack) return null;
  const who = ack.acknowledged_by ?? '—';
  return ack.until ? t('am.ack_by', { who, until: _isoToMdy(String(ack.until)) }) : t('am.ack_by_noend', { who });
}
