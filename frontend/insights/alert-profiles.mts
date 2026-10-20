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

import type { AlertType, AlertCategory, AlertProfile, AlertProfileRule, AlertRanking, NimbusTask } from '../platform/types.mjs';

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
  exceptions: [
    'runtime-schedule-mismatch', 'runtime-unknown', 'pv-lot-size',
    'late', 'reversal_forward', 'placement_exception', 'frozen_window_crossed',
    'pull_floor_crossed', 'setup_override_orphaned', 'no_anchor', 'derivation_issue', 'run_time_zero',
  ],
};

const _categoryByType = new Map<string, AlertCategory>();
for (const [cat, types] of Object.entries(ALERT_CATEGORIES) as Array<[AlertCategory, AlertType[]]>) {
  for (const t of types) _categoryByType.set(t, cat);
}

export function categoryOf(type: string): AlertCategory {
  return _categoryByType.get(type) ?? 'exceptions';
}

/** Types the drawer and the Alert Monitor offer a one-click Fix for. */
export const FIXABLE_ALERT_TYPES: ReadonlySet<string> = new Set(['overlap', 'blackout', 'overload', 'tool-conflict']);
/** Types offered Override (when the alert carries a taskId). */
export const OVERRIDE_ALERT_TYPES: ReadonlySet<string> = new Set(['closed', 'firmed-closed', 'firmed-out-of-hours']);
/** Calendar-family types: drawn with the ⊘ glyph / calendar styling. */
export const CALENDAR_ALERT_TYPES: ReadonlySet<string> = new Set(['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours']);

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

export function profileMatches(
  alert: NimbusAlert, task: NimbusTask | undefined, profile: AlertProfile, plantToday: Date, deps?: ProfileDeps,
): boolean {
  return profile.rules.some(r => ruleMatches(alert, task, r, plantToday, deps));
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
  if (!_validDate(alert.time) || alert.time < horizonStart || alert.time >= horizonEnd) return 0;
  const base = alert.sev === 'err' ? FALLBACK_WEIGHTS.err : alert.sev === 'warn' ? FALLBACK_WEIGHTS.warn : 0;
  const days = (alert.time.getTime() - horizonStart.getTime()) / 86400000;
  return base * (days <= 3 ? FALLBACK_WEIGHTS.tw3 : days <= 7 ? FALLBACK_WEIGHTS.tw7 : 1);
}

function _affectedOrders(alert: NimbusAlert): number {
  return 1 + (alert.peerId ? 1 : 0);
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

/** Comparator for `Array.prototype.sort`; ties always end on alert id so the order is deterministic. */
export function compareAlerts(ranking: AlertRanking, ctx: RankContext): (a: NimbusAlert, b: NimbusAlert) => number {
  const byId = (a: NimbusAlert, b: NimbusAlert) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byAnchor = (a: NimbusAlert, b: NimbusAlert) => _cmpNum(_anchorKey(a, ctx), _anchorKey(b, ctx));
  switch (ranking) {
    case 'time':
      return (a, b) => byAnchor(a, b) || byId(a, b);
    case 'severity':
      return (a, b) => _cmpNum(a.sev === 'err' ? 0 : 1, b.sev === 'err' ? 0 : 1) || byAnchor(a, b) || byId(a, b);
    case 'orders':
      return (a, b) => _cmpNum(_affectedOrders(b), _affectedOrders(a)) || byAnchor(a, b) || byId(a, b);
    case 'impact':
    default:
      return (a, b) =>
        _cmpNum(impactPoints(b, ctx.horizonStart, ctx.horizonMinutes), impactPoints(a, ctx.horizonStart, ctx.horizonMinutes))
        || byAnchor(a, b) || byId(a, b);
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
  /** Distinct orders touched (taskId and peerId). */
  orderIds: string[];
}

export interface GroupContext extends RankContext {
  plantToday: Date;
}

const NONE_KEY = 'none';

function _dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function groupAlerts(alerts: NimbusAlert[], by: AlertGroupBy, ctx: GroupContext): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
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
    }
    g.alerts.push(a);
    g.points += impactPoints(a, ctx.horizonStart, ctx.horizonMinutes);
    for (const id of [a.taskId, a.peerId]) if (id && !g.orderIds.includes(id)) g.orderIds.push(id);
  }
  return [...groups.values()].sort((x, y) =>
    _cmpNum(y.points, x.points) || _cmpNum(y.alerts.length, x.alerts.length) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

// ---- Validation -----------------------------------------------------------------------------

export interface AlertProfileDraft {
  id?: string;
  plant: string;
  name: string;
  rules: AlertProfileRule[];
}

export interface ProfileValidation {
  ok: boolean;
  /** field path -> i18n key. Paths: `name`, `rules`, `rules.<i>.{types|dayFrom|dayTo|days|minLateHours|dup}`. */
  errors: Record<string, string>;
}

const DAY_BOUND = 365;
const MAX_NAME_LEN = 60;
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

  const rules = draft.rules ?? [];
  if (!rules.length) errors.rules = 'ape.err_no_rules';
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

/** "Acknowledged by X until D" / "Acknowledged by X" (shared by the Alert Monitor row and the drawer row). */
export function ackLabel(
  ack: { acknowledged_by?: string | null; until?: string | null } | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (!ack) return null;
  const who = ack.acknowledged_by ?? '—';
  return ack.until ? t('am.ack_by', { who, until: String(ack.until).slice(0, 10) }) : t('am.ack_by_noend', { who });
}
