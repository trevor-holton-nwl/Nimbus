/* =============================================================================
   ALERT MONITOR MODEL — pure, DOM-free helpers behind AlertMonitorPane.

   No Store, no DOM, no globals: every input is passed in and every string comes
   through an injected `t`, so the node tests exercise it directly.
   ========================================================================== */

import type { AlertCategory, AlertProfile, AlertProfileRule, AlertRanking } from '../platform/types.mjs';
import { categoryOf as _catOf, ALERT_CATEGORY_ORDER, effectiveCategories, ruleAppliesTo, alertOrderIds, ALL_ALERTS_PROFILE_ID, NONE_KEY, alertDayOffset, dayKeyOf, isFixableAlert, isUnfixableToolAlert, OVERRIDE_ALERT_TYPES, CALENDAR_ALERT_TYPES, SLOT_ALERT_TYPES } from '../insights/alert-profiles.mjs';
import type { LeverageItem, LeveragePair } from '../insights/alert-leverage.mjs';
import { dayBucketKey, horizonDayKeys } from './alert-monitor-overview.mjs';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The structural slice of a NimbusAlert this module reads. */
export interface AlertLike {
  id: string;
  sev: 'err' | 'warn';
  type: string;
  taskId?: string;
  /** The other order of a pairwise alert (overlap, tool-conflict). */
  peerId?: string;
  /** Every other order of a count-aware tool conflict; read through alertOrderIds(). */
  peerIds?: string[];
  line?: string;
  time?: Date | null;
  /** Tool-conflict only: copies the plant can use; 0 = no move can clear it. */
  available?: number | null;
}

export type MonitorGroupBy = 'category' | 'type' | 'line' | 'day' | 'order' | 'none';

/** The two sorts the page offers (Priority / Date); the stored `severity` / `orders` of earlier builds read as `impact`. */
export const MONITOR_SORTS: AlertRanking[] = ['impact', 'time'];
export const MONITOR_CATEGORIES: readonly AlertCategory[] = ALERT_CATEGORY_ORDER;

/** What the summary line says about the alerts the list shows. */
export interface SummaryInput {
  /** No plant selected: the line is just the select-a-plant message. */
  hasPlant: boolean;
  /** The alerts the list below shows (profile-filtered, acknowledged excluded unless asked; the focus set in focus mode). */
  alerts: ReadonlyArray<AlertLike>;
  profileId: string;
  profileName: string;
  profile: AlertProfile | null | undefined;
  /** A leverage card's "Show alerts" is active: its chip text replaces the first clause. */
  focus: { title: string; outside: number } | null;
  /** Machines carrying at least one alert in the list, and the plant's machine count; both set = "M of N machines". */
  machinesNoisy?: number;
  machinesTotal?: number;
  /** The filtered count; set only while a filter is active ("showing V"). */
  showing?: number | null;
  /** Lines picked in the global machine filter (read-only clause "N lines selected"); absent or 0 = none. */
  linesSelected?: number;
}

export interface SummaryLine {
  /** The sentence up to (not including) the confidence link. */
  text: string;
}

/**
 * The whole-day window a profile covers when every rule shares the same `dayFrom` and `dayTo` (both set),
 * else null (an open bound, differing windows, no rules, or the built-in All alerts).
 */
export function profileWindow(profile: AlertProfile | null | undefined): { from: number; to: number } | null {
  if (!profile || profile.builtIn) return null;
  if (profile.categories) return _categoryWindow(profile);
  if (!profile.rules?.length) return null;
  let win: { from: number; to: number } | null = null;
  for (const rule of profile.rules) {
    const from = rule.dayFrom, to = rule.dayTo;
    if (typeof from !== 'number' || typeof to !== 'number') return null;
    if (!win) win = { from, to };
    else if (win.from !== from || win.to !== to) return null;
  }
  return win;
}

/** Stored-categories form: every ON group needs at least one applicable rule and all applicable rules share one whole-day window. */
function _categoryWindow(profile: AlertProfile): { from: number; to: number } | null {
  const eff = effectiveCategories(profile);
  let win: { from: number; to: number } | null = null;
  for (const cat of ALERT_CATEGORY_ORDER) {
    if (!eff[cat].on) continue;
    const applicable = (profile.rules ?? []).filter(r => ruleAppliesTo(r, cat));
    if (!applicable.length) return null;
    for (const rule of applicable) {
      const from = rule.dayFrom, to = rule.dayTo;
      if (typeof from !== 'number' || typeof to !== 'number') return null;
      if (!win) win = { from, to };
      else if (win.from !== from || win.to !== to) return null;
    }
  }
  return win;
}

/** `_one` form at exactly 1 (Util.t has no plural support). */
const _plural = (n: number, key: string, vars: Record<string, string | number>, t: Translate): string =>
  t(n === 1 ? `${key}_one` : key, vars);

/** The one-sentence page summary (row 2 of the header). Counts are over the alerts the list shows. */
export function summaryLine(input: SummaryInput, t: Translate): SummaryLine {
  if (!input.hasPlant) return { text: t('am.empty_no_plant') };
  let errors = 0, warnings = 0;
  const orders = new Set<string>();
  for (const a of input.alerts) {
    if (a.sev === 'err') errors++; else warnings++;
    for (const id of alertOrderIds(a)) orders.add(id);   // an overlap affects both orders; a tool conflict every holder
  }
  const n = input.alerts.length;
  let lead: string;
  if (input.focus) {
    lead = input.focus.outside > 0
      ? t('am.focus_chip_outside', { n, title: input.focus.title, k: input.focus.outside })
      : t('am.focus_chip', { n, title: input.focus.title });
  } else if (input.profileId === ALL_ALERTS_PROFILE_ID) {
    lead = _plural(n, 'am.summary_all', { n }, t);
  } else {
    const win = profileWindow(input.profile);
    lead = win
      ? _plural(n, 'am.summary_window', { n, from: win.from, to: win.to, name: input.profileName }, t)
      : _plural(n, 'am.summary_profile', { n, name: input.profileName }, t);
  }
  const parts = [lead];
  if (errors > 0) parts.push(_plural(errors, 'am.summary_errors', { e: errors }, t));
  if (warnings > 0) parts.push(_plural(warnings, 'am.summary_warnings', { w: warnings }, t));
  if (orders.size > 0) parts.push(_plural(orders.size, 'am.summary_orders', { o: orders.size }, t));
  if (typeof input.machinesNoisy === 'number' && typeof input.machinesTotal === 'number' && input.machinesTotal > 0) {
    parts.push(t('am.summary_machines', { m: input.machinesNoisy, total: input.machinesTotal }));
  }
  if (typeof input.showing === 'number') parts.push(t('am.summary_showing', { v: input.showing }));
  if (typeof input.linesSelected === 'number' && input.linesSelected > 0) parts.push(t(input.linesSelected === 1 ? 'am.lines_selected_one' : 'am.lines_selected', { n: input.linesSelected }));
  return { text: parts.join(' · ') };
}

const _DAY_MARK = '\u0001';

function _typesText(rule: AlertProfileRule, t: Translate): string {
  const types = rule.types;
  if (!types || !types.length) return t('am.profile_all');
  if (types.length <= 2) return types.map(x => t(`alert.type.${x}`)).join(', ');
  // Many types read better as the categories they span than as a long list.
  const cats: string[] = [];
  for (const cat of MONITOR_CATEGORIES) {
    const label = t(`ape.cat_${cat}`);
    if (types.some(x => _catOf(x) === cat) && !cats.includes(label)) cats.push(label);
  }
  return cats.join(', ');
}

function _sevText(rule: AlertProfileRule, t: Translate): string {
  // A stored 'warn' is the same as no limit (every alert is a warning or an error).
  return t(rule.minSev === 'err' ? 'am.window_sev_err' : 'am.window_sev_any');
}

/** One-line description of a profile's rules, e.g. "Order overlap · D0–7 · errors only". */
export function windowSummary(profile: AlertProfile | null | undefined, t: Translate): string {
  if (!profile || profile.builtIn) return t('am.window_all');
  if (profile.categories) return _categorySummary(profile, t);
  if (!profile.rules?.length) return t('am.window_all');
  return profile.rules.map(rule => _ruleLine(rule, _typesText(rule, t), t)).join(' | ');
}

/** Stored-categories form: one line per narrowing rule (named by the ON groups it applies to), plus one for ON groups no rule narrows. */
function _categorySummary(profile: AlertProfile, t: Translate): string {
  const eff = effectiveCategories(profile);
  const on = ALERT_CATEGORY_ORDER.filter(c => eff[c].on);
  if (!on.length) return t('am.window_all');
  // Every group on and no rule narrowing any of them is the whole horizon, the same sentence as All alerts.
  if (on.length === ALERT_CATEGORY_ORDER.length && !(profile.rules ?? []).some(r => on.some(c => ruleAppliesTo(r, c)))) return t('am.window_all');
  const label = (cats: readonly AlertCategory[]): string => cats.length === ALERT_CATEGORY_ORDER.length ? t('am.profile_all') : cats.map(c => t(`ape.cat_${c}`)).join(', ');
  const rules = profile.rules ?? [];
  const lines: string[] = [];
  const open = on.filter(c => !rules.some(r => ruleAppliesTo(r, c)));
  if (open.length) lines.push(_ruleLine({ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null }, label(open), t));
  for (const rule of rules) {
    const names = on.filter(c => ruleAppliesTo(rule, c));
    if (names.length) lines.push(_ruleLine(rule, label(names), t));
  }
  return lines.join(' | ');
}

function _ruleLine(rule: AlertProfileRule, typesText: string, t: Translate): string {
  {
    const from = rule.dayFrom, to = rule.dayTo;
    const anyDays = from == null && to == null;
    const line = t('am.window_rule', {
      types: typesText,
      from: anyDays ? _DAY_MARK : (from == null ? '…' : from),
      to: anyDays ? _DAY_MARK : (to == null ? '…' : to),
      sev: _sevText(rule, t),
    });
    if (!anyDays) return line;
    // Replace the whole "D{from}–{to}" segment (bounded by the template's own separators) with "any day".
    return line.split(' · ').map(seg => seg.includes(_DAY_MARK) ? t('am.window_any_days') : seg).join(' · ');
  }
}

/** What the monitor lists: alerts the profile matched, minus acknowledged ones unless asked. */
export function visibleAlertsFor<A extends { id: string }>(
  alerts: ReadonlyArray<A>,
  matched: ReadonlySet<string>,
  acked: ReadonlyMap<string, unknown>,
  showAcked: boolean,
): A[] {
  return alerts.filter(a => matched.has(a.id) && (showAcked || !acked.has(a.id)));
}

/** Plant-scope + alert-horizon filter (mirrors AlertsUIAdapter._visibleAlerts, without the profile step). */
export function horizonAlerts<A extends { line?: string; time?: Date | null }>(
  alerts: ReadonlyArray<A>,
  plantLines: ReadonlySet<string>,
  cutoff: Date | null,
): A[] {
  const scoped = alerts.filter(a => !a.line || plantLines.has(a.line));
  return cutoff ? scoped.filter(a => !a.time || a.time <= cutoff) : scoped;
}

export type EmptyKind = 'no-plant' | 'no-alerts' | 'no-match' | 'all-acked' | null;

/** Which `.empty-state` (if any) the body shows. */
export function emptyStateFor(input: {
  plant: string | null;
  scopedCount: number;
  matchedCount: number;
  visibleCount: number;
  isAllAlerts: boolean;
}): EmptyKind {
  if (!input.plant) return 'no-plant';
  if (input.scopedCount === 0) return 'no-alerts';
  if (input.visibleCount > 0) return null;
  // Matches exist but none is visible: acknowledgement is the only thing that hides a matched alert.
  if (input.matchedCount > 0) return 'all-acked';
  return !input.isAllAlerts ? 'no-match' : 'no-alerts';
}

/* ---------------------------------------------------------------------------
   Row helpers — shared constants and pure HTML builders.

   Every dynamic string is escaped here; every label comes through the injected `t`. The pane
   resolves Store / Util / NIMBUS reads and hands them in, so these stay DOM-free.
   ------------------------------------------------------------------------- */

/** Rows shown per group before "Show all N". */
export const GROUP_ROW_CAP = 40;
/** Compact Inbox / side-list row height (px); an open row adds its detail block (`detailHeightFor`). */
export const ROW_H = 32;
/** The two-line row height once the list container is at most `NARROW_AT` px wide. */
export const ROW_H_NARROW = 52;
/** Container width (px) at or below which the compact row and its detail switch to the narrow layout (the CSS `@container` query has the same breakpoint). */
export const NARROW_AT = 520;
/** Matrix side list width (px): default, bounds, and the matrix floor the clamp protects. */
export const SIDE_W_DEFAULT = 660, SIDE_W_MIN = 380, SIDE_W_MAX = 900;
/** Row-head column (240) + two 64 px data columns: the least matrix width beside the side list. */
export const MATRIX_MIN_W = 240 + 2 * 64;
/** Layout gap (12) + resize handle column (8). */
export const SIDE_GAP_W = 12 + 8;
/** Clamp a stored or dragged side-list width; non-numbers fall back to the default, and a known layout width keeps the matrix at `MATRIX_MIN_W` (never below `SIDE_W_MIN`). */
export function clampSideWidth(px: unknown, layoutW?: number): number {
  const n = typeof px === 'number' ? px : (px == null || px === '' ? NaN : Number(px));
  let w = Number.isFinite(n) ? Math.round(n) : SIDE_W_DEFAULT;
  w = Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, w));
  if (typeof layoutW === 'number' && Number.isFinite(layoutW) && layoutW > 0) {
    w = Math.max(SIDE_W_MIN, Math.min(w, Math.round(layoutW) - SIDE_GAP_W - MATRIX_MIN_W));
  }
  return w;
}
/** The alert types a group's "Move N orders" moves: `overload` is excluded, its fix runs the line-day changeover optimizer. */
export const MOVABLE_ALERT_TYPES: ReadonlySet<string> = new Set(['overlap', 'blackout', 'tool-conflict']);
/** Above this many orders "Move N orders" asks first. */
export const GROUP_MOVE_CONFIRM_ABOVE = 5;

const _esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type DiagnoseKind = 'cell' | 'order' | 'none';

export interface RowActions { goto: boolean; fix: boolean; override: boolean; slot: boolean; diagnose: DiagnoseKind }

/** Which actions an alert row offers — the same eligibility the drawer uses, plus Diagnose. */
export function rowActionsFor(a: { type: string; taskId?: string | null; line?: string; time?: Date | null; available?: number | null }): RowActions {
  const hasTask = a.taskId != null && a.taskId !== '';
  return {
    goto: hasTask || !!(a.line && a.time),
    fix: isFixableAlert(a),
    override: OVERRIDE_ALERT_TYPES.has(a.type) && hasTask,
    slot: SLOT_ALERT_TYPES.has(a.type) && hasTask,
    diagnose: hasTask ? 'order' : (a.line && a.time ? 'cell' : 'none'),
  };
}

/** "today" / "in 9 days" / "3 days overdue" for a whole-day offset from the plant's today. */
export function relativeDaysText(offset: number, t: Translate): string {
  if (offset === 0) return t('am.rel_today');
  return offset > 0 ? t('am.rel_in_days', { n: offset }) : t('am.rel_overdue_days', { n: -offset });
}

/** "from → to" text for a setup alert's pairKey (`<from>-><to>`, each half `unknown` or a JSON array of [field, value] pairs). */
export function formatPairKey(pairKey: string | null | undefined): string {
  if (!pairKey) return '';
  const state = (raw: string): string => {
    if (raw === 'unknown') return '?';
    try {
      const pairs = JSON.parse(raw);
      if (Array.isArray(pairs) && pairs.length) {
        return pairs.map(p => (Array.isArray(p) ? `${p[0]} ${p[1]}` : String(p))).join(', ');
      }
    } catch { /* fall through to the raw text */ }
    return raw;
  };
  if (pairKey.startsWith('unknown->')) return `? → ${state(pairKey.slice(9))}`;
  const split = pairKey.indexOf(']->');
  if (split < 0) return pairKey;
  return `${state(pairKey.slice(0, split + 1))} → ${state(pairKey.slice(split + 3))}`;
}

export interface GroupCounts {
  errors: number;
  warnings: number;
  /** Distinct orders the group touches (alertOrderIds). */
  orders: number;
  /** The whole group's alerts "Move N orders" would move, in list order. */
  movableIds: string[];
  /** Distinct orders (taskId) those movable alerts sit on: the N of "Move N orders". */
  movableOrders: number;
  /** The whole group's alerts that are not acknowledged yet (what "Acknowledge N…" covers). */
  unackedIds: string[];
}

/** What a group head shows and offers. Counts only: a group head carries no totals. */
export function groupCounts<A extends AlertLike>(alerts: ReadonlyArray<A>, isAcked: (id: string) => boolean): GroupCounts {
  const orders = new Set<string>();
  const movable = new Set<string>();
  const out: GroupCounts = { errors: 0, warnings: 0, orders: 0, movableIds: [], movableOrders: 0, unackedIds: [] };
  for (const a of alerts) {
    if (a.sev === 'err') out.errors++; else out.warnings++;
    for (const id of alertOrderIds(a)) orders.add(id);
    if (MOVABLE_ALERT_TYPES.has(a.type) && !isUnfixableToolAlert(a)) { out.movableIds.push(a.id); movable.add(String(a.taskId ?? a.id)); }
    if (!isAcked(a.id)) out.unackedIds.push(a.id);
  }
  out.orders = orders.size;
  out.movableOrders = movable.size;
  return out;
}

/** One decimal at most, no trailing ".0". */
export function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}


const _SEV_GLYPH = { err: '✖', warn: '⚠' } as const;

function _sevGlyph(type: string, sev: 'err' | 'warn'): string {
  return CALENDAR_ALERT_TYPES.has(type) ? '⊘' : _SEV_GLYPH[sev];
}

export type RowActionId = 'focus' | 'fix' | 'override' | 'slot' | 'diagnose' | 'ack' | 'unack';

export interface RowMenuItem {
  action: RowActionId;
  labelKey: string;
  /** Rendered disabled (aria-disabled) with `hintKey` as its hint. */
  disabled?: boolean;
  hintKey?: string;
}

export interface RowPrimary {
  /** The row's [Go to] button. */
  goto: boolean;
  /** The row's second button, when the alert is eligible: Fix, Override or Slot (never two: the type sets are disjoint). */
  second?: 'fix' | 'override' | 'slot';
  /** The ⋯ menu, in order: Go to, Fix / Override / Slot…, Diagnose, Acknowledge… / Remove acknowledgement. Never Dismiss. */
  menu: RowMenuItem[];
}

/**
 * What a row offers. Eligibility is `rowActionsFor` (the drawer's). `task` is the order the alert names (or null);
 * it stands in for a missing `taskId` on the alert. Fix / Override / Slot are disabled in What-If.
 */
export function rowPrimaryActions(
  a: { type: string; taskId?: string | null; line?: string; time?: Date | null },
  task: { id?: unknown } | null | undefined,
  ctx: { whatIf: boolean; acked: boolean },
): RowPrimary {
  const taskId = a.taskId != null && a.taskId !== '' ? a.taskId : (task?.id != null ? String(task.id) : a.taskId);
  const acts = rowActionsFor({ ...a, taskId });
  const second: RowPrimary['second'] = acts.fix ? 'fix' : acts.override ? 'override' : acts.slot ? 'slot' : undefined;
  const lock = (item: RowMenuItem): RowMenuItem => (ctx.whatIf ? { ...item, disabled: true, hintKey: 'am.whatif_blocked' } : item);
  const menu: RowMenuItem[] = [];
  if (acts.goto) menu.push({ action: 'focus', labelKey: 'btn.go_to' });
  if (second === 'fix') menu.push(lock({ action: 'fix', labelKey: 'btn.fix_it' }));
  if (second === 'override') menu.push(lock({ action: 'override', labelKey: 'btn.override' }));
  if (second === 'slot') menu.push(lock({ action: 'slot', labelKey: 'am.slot' }));
  if (acts.diagnose !== 'none') menu.push({ action: 'diagnose', labelKey: 'am.diagnose' });
  menu.push(ctx.acked ? { action: 'unack', labelKey: 'am.unack' } : { action: 'ack', labelKey: 'am.ack' });
  return { goto: acts.goto, second, menu };
}

/** "⚙ Fix" -> glyph "⚙" + text "Fix"; a label with no leading glyph is all text. */
function _splitGlyph(label: string): { glyph: string; text: string } {
  const m = /^([^\p{L}\p{N}\s]+)\s+(.+)$/u.exec(label);
  return m ? { glyph: m[1]!, text: m[2]! } : { glyph: '', text: label };
}

/* ---------------------------------------------------------------------------
   Top fixes (Task 13, reworked as a ranked list in Task 23) — pure row / section builders.

   The pane decides the context (plant cap, admin, What-If, remaining count) and hands it in as a
   LevCtx; nothing here reads a global. The fix engine's `points` only ORDER the list; they are never
   rendered (spec §1). A `requiresMinutes` row never shows a confidence clause: it asks for minutes and
   shows the replayed score only after the replay returns.
   ------------------------------------------------------------------------- */

/** Rows shown before "Show 10 more". */
export const LEV_TOP_N = 5;
/** "Show 10 more" reveals this many more rows per click ... */
export const LEV_STEP = 10;
/** ... and never renders more than this many (a 636-row DOM froze the page for 30+ s). */
export const LEV_MAX_RENDER = 50;

export interface LevCtx {
  /** This row's alerts that persist after a fix was attempted from the page (0 = none / not attempted). */
  remaining: number;
  /** The user may open the setup matrix review (else "copy for the setup owner"). */
  canReviewPairs: boolean;
  isAdmin: boolean;
  /** The plant's setup tracking is on (`plants.setup_active`); when off a setup pair only clears a warning. */
  setupActive: boolean;
  /** What-If is active: Fix movable renders disabled. */
  whatIf: boolean;
  /** Localised label of a setup-definition field (`colorWheel` → "Color"). */
  fieldLabel: (fieldKey: string) => string;
  /** How many of this fix's alerts are in the current view; set only while the view is a partial one (adds the `am.lev_in_view` clause). */
  inView?: number;
  /** Live alerts by id: lets `levActions` tell a queued fix (no bar to show) from a placed one. */
  alertsById?: ReadonlyMap<string, { type: string }>;
}

export interface LevAction {
  act: string;
  labelKey: string;
  labelVars?: Record<string, string | number>;
  primary: boolean;
  disabled?: boolean;
  /** The write behind this action needs an admin; the button says so. */
  admin?: boolean;
}

const _ROUTING_UPLOAD = new Set(['no_routing', 'pv_not_found', 'pv_expired', 'no_operation_at_workcenter', 'pv_workcenter_mismatch']);

function _stateText(state: ReadonlyArray<{ fieldKey: string; value: string }>, fieldLabel: (k: string) => string): string {
  return state.map(p => `${fieldLabel(p.fieldKey)}: ${p.value}`).join(', ');
}

/** The row title. Setup pairs are re-localised from the pair states (the engine's `titleVars` are English). */
export function levTitle(item: LeverageItem, ctx: LevCtx, t: Translate): string {
  let vars = item.titleVars;
  if (item.action.kind === 'open-setup-matrix') {
    const p = item.action.pairs[0];
    if (p) {
      const names = item.lines.slice(0, 3).join(', ') + (item.lines.length > 3 ? ` +${item.lines.length - 3}` : '');
      vars = { ...vars, from: _stateText(p.fromState, ctx.fieldLabel), to: _stateText(p.toState, ctx.fieldLabel), lines: names || vars.lines };
    }
  }
  return t(item.titleKey, vars);
}

/**
 * What a row offers: ONE primary button and the rest for the ⋯ menu; the pane dispatches on `act`.
 * For an `adminOnly` item viewed by a non-admin the primary is "Copy summary for owner" and the admin deep link
 * (with its admin tag) moves to the head of the menu.
 */
export function levActions(item: LeverageItem, ctx: LevCtx): { primary: LevAction | null; menu: LevAction[] } {
  const out: LevAction[] = [];
  const add = (act: string, labelKey: string, primary = false, extra: Partial<LevAction> = {}) =>
    { out.push({ act, labelKey, primary, ...extra }); };
  const n = item.orderIds.length;
  const a = item.action;
  const toOrders = n > 0 && fixPrimaryAction(item, ctx.alertsById) === 'orders';
  switch (a.kind) {
    case 'open-setup-matrix':
      if (ctx.canReviewPairs) add('setup-review', 'leverage.action.setup-pair', true);
      else add('setup-copy', 'btn.setup_copy_missing', true);
      break;
    case 'calendar-day': {
      const fixable = a.fixableAlertIds.length > 0;
      if (fixable) add('cal-fix', 'leverage.action.calendar-day', true, { disabled: ctx.whatIf });
      add('diagnose-cell', 'am.diagnose', !fixable);
      if (ctx.isAdmin) add('edit-calendar', 'btn.edit_calendar', false, { admin: true });
      add('goto', 'btn.go_to');
      break;
    }
    case 'routing-gap':
      if (a.step === 'workcenter_unmapped') add('rg-workcenters', 'leverage.action.routing-gap.workcenter_unmapped', true, { admin: true });
      else if (_ROUTING_UPLOAD.has(a.step)) add('rg-routing', 'leverage.action.routing-gap', true, { admin: true });
      else if (a.step === 'no_machine') add('open-table', 'am.open_in_table', true, { labelVars: { n } });
      else add('copy-summary', 'am.lev_copy_summary', true);
      break;
    case 'tool':
      add('focus-first', 'leverage.action.tool', true);
      // The remedy for a conflict (or a zero-copy tool) is often the copy count: Master Data > Tool Inventory on this tool.
      add('tool-inventory', 'am.act_open_tool_inventory');
      break;
    case 'machine-state':
      add('focus-first', 'leverage.action.machine-state', true);
      break;
    case 'optimize-window': {
      const room = (item.headroomHours ?? 1) > 0;
      if (room) { add('optimize', 'leverage.action.optimize-window', true); add('diagnose-worst', 'am.diagnose'); }
      else { add('diagnose-worst', 'am.diagnose', true); add('optimize', 'leverage.action.optimize-window'); }
      break;
    }
    case 'needs-planning':
      add('show-alerts', 'leverage.action.needs-planning', true);
      break;
    default: break;
  }
  if (n > 0 && !out.some(x => x.act === 'open-table')) add('open-table', 'am.open_in_table', false, { labelVars: { n } });
  if (!out.some(x => x.act === 'show-alerts')) add('show-alerts', 'am.lev_show_alerts');
  if (toOrders) {
    // Several orders, or queued ones with no bar: the outline "Show alerts" draws cannot show them all, so the Orders table takes
    // the primary slot. Only that outline primary is swapped: Go To (one place on the Gantt) and fixes that write keep their button.
    const show = out.find(x => x.primary && x.act === 'show-alerts');
    const table = out.find(x => x.act === 'open-table');
    if (show && table) { show.primary = false; table.primary = true; table.labelKey = 'am.open_in_orders'; table.labelVars = undefined; }
  }
  if (item.adminOnly && !out.some(x => x.act === 'copy-summary')) add('copy-summary', 'am.lev_copy_summary');

  if (item.adminOnly && !ctx.isAdmin) {
    // Someone else owns this fix: the row's button hands it over; the admin deep link stays reachable in the menu.
    const copy = out.find(x => x.act === 'copy-summary')!;
    const rest = out.filter(x => x !== copy).map(x => ({ ...x, primary: false }));
    return { primary: { ...copy, primary: true }, menu: rest };
  }
  const primary = out.find(x => x.primary) ?? null;
  return { primary, menu: out.filter(x => x !== primary) };
}

/** "Clears 6 alerts on 4 orders", in the plural form the counts call for. */
export function fixClearsText(item: LeverageItem, t: Translate): string {
  const n = item.alertIds.length;
  const m = item.orderIds.length;
  if (n === 1 && m === 1) return t('am.fix_clears_one');
  if (n === 1) return t('am.fix_clears_one_alert', { m });
  if (m === 1) return t('am.fix_clears_one_order', { n });
  return t('am.fix_clears', { n, m });
}

/**
 * Whether a fix's confidence clause ("71 → 78", the dial's ghost) is shown: a replayed, minutes-free fix whose
 * rounded after-score differs from its rounded before-score. The one predicate for the fix row and the Overview dial.
 */
export function fixConfidenceChanged(item: LeverageItem): boolean {
  const after = item.confidenceAfter;
  return item.method === 'replay' && item.requiresMinutes !== true && after != null
    && Math.round(after) !== Math.round(item.confidenceBefore);
}

/**
 * The muted second line, as already-escaped HTML fragments the caller joins with " · ":
 * the counts, the confidence clause (replayed rows only, and only when the score changes; a lower
 * after-score is shown with its delta in the error colour), the no-headroom note, what remains after a fix.
 */
export function fixLineParts(item: LeverageItem, ctx: LevCtx, t: Translate): string[] {
  // needs-planning: one alert per order, so "Clears N alerts on N orders" would only repeat the title's count.
  const parts: string[] = item.family === 'needs-planning' ? [] : [_esc(fixClearsText(item, t))];
  const after = item.confidenceAfter;
  if (after != null && fixConfidenceChanged(item)) {
    const d = after - item.confidenceBefore;
    const delta = d < 0 ? ` <span class="am-fix-down">${_esc(`−${Math.abs(d)}`)}</span>` : '';
    parts.push(`<span class="am-fix-conf">${_esc(t('am.fix_conf', { before: item.confidenceBefore, after }))}</span>${delta}`);
  }
  if (item.family === 'optimize-window' && item.headroomHours != null && item.headroomHours <= 0) {
    parts.push(_esc(t('am.lev_no_headroom', { h: fmtNum(Math.abs(item.headroomHours)) })));
  }
  if (ctx.inView != null) parts.push(_esc(t('am.lev_in_view', { n: ctx.inView })));
  if (ctx.remaining > 0) parts.push(`<span class="am-fix-left">${_esc(_plural(ctx.remaining, 'am.lev_remaining', { n: ctx.remaining }, t))}</span>`);
  return parts;
}

/** The row tooltip: free hours in an optimize window, and the setup-tracking-off note. */
function _fixTip(item: LeverageItem, ctx: LevCtx, t: Translate): string {
  const tips: string[] = [];
  if (item.family === 'optimize-window' && item.headroomHours != null && item.headroomHours > 0) {
    tips.push(t('am.lev_headroom', { h: fmtNum(item.headroomHours) }));
  }
  if (item.family === 'setup-pair' && !ctx.setupActive) tips.push(t('am.lev_setup_inactive'));
  return tips.join(' · ');
}

/** One ranked fix row. `rank` is null for the admin list (no number). */
export function fixRowHtml(item: LeverageItem, rank: number | null, ctx: LevCtx, t: Translate): string {
  const key = _esc(item.key);
  const title = levTitle(item, ctx, t);
  const tip = _fixTip(item, ctx, t);
  const admin = item.adminOnly ? ` <span class="badge badge-info am-lev-admin">${_esc(t('am.lev_admin_fix'))}</span>` : '';
  const { primary } = levActions(item, ctx);
  const btn = primary ? (() => {
    const tag = primary.admin ? ` <span class="am-lev-adm">${_esc(t('am.lev_admin_fix'))}</span>` : '';
    return `<button type="button" class="btn sm btn-primary" data-lev-action="${_esc(primary.act)}" data-lev-key="${key}"`
      + `${primary.disabled ? ` disabled aria-disabled="true" title="${_esc(t('am.whatif_blocked'))}"` : ''}>${_esc(t(primary.labelKey, primary.labelVars))}${tag}</button>`;
  })() : '';
  const more = `<button type="button" class="icon-btn sm" data-lev-menu="${key}" data-ovf-key="${key}" aria-haspopup="menu" aria-label="${_esc(t('am.more_actions'))}">⋯</button>`;
  let minutes = '';
  if (item.requiresMinutes === true) {
    const label = _esc(t('am.fix_minutes'));
    minutes = `<span class="am-fix-minutes"><label>${label} <input type="number" class="am-fix-min-input" min="1" step="1" inputmode="numeric" `
      + `data-lev-minutes="${key}" aria-label="${label}"></label> `
      + `<button type="button" class="btn sm" data-lev-action="replay-minutes" data-lev-key="${key}">${_esc(t('am.fix_replay'))}</button></span>`;
  }
  const lineParts = fixLineParts(item, ctx, t);
  const rankHtml = rank == null
    ? `<span class="am-fix-rank" aria-hidden="true"></span>`
    : `<span class="am-fix-rank" role="img" aria-label="${_esc(t('am.rank_n', { n: rank }))}">${rank}</span>`;
  return `<div class="am-fix" role="listitem" data-lev-key="${key}"${tip ? ` title="${_esc(tip)}"` : ''}>`
    + rankHtml
    + `<div class="am-fix-main"><div class="am-fix-title" title="${_esc(title)}">${_esc(title)}${admin}</div>`
    + (lineParts.length || minutes
      ? `<div class="am-fix-line">${lineParts.join(' · ')}${minutes ? `${lineParts.length ? ' · ' : ''}${minutes}` : ''}</div>` : '')
    + `</div>`
    + `<div class="am-fix-acts">${btn}${more}</div></div>`;
}

export interface FixesSectionOpts {
  /** Top fixes is collapsed to its head (`alertMonitorFixes: 'collapsed'`); the count stays live. */
  collapsed?: boolean;
  /** Admins see one list; everyone else gets the actionable list plus a collapsed "Needs an admin" list. */
  isAdmin: boolean;
  /** The "Needs an admin" disclosure is expanded. */
  adminOpen: boolean;
  /** How many main-list rows to render (LEV_TOP_N first; +LEV_STEP per click; capped at LEV_MAX_RENDER). */
  limit: number;
  /** The first pass has not produced results yet. */
  computing: boolean;
  ctxFor: (item: LeverageItem) => LevCtx;
  /** The list was narrowed to the current view and nothing in it is left: say so instead of the plant-wide empty copy. */
  noneInView?: boolean;
}

/**
 * The whole panel: head, ranked list (partition first, then slice), "Show 10 more", the collapsed admin list,
 * skeleton or the empty copy.
 */
export function fixesSectionHtml(items: ReadonlyArray<LeverageItem>, o: FixesSectionOpts, t: Translate): string {
  const main = o.isAdmin ? items : items.filter(i => !i.adminOnly);
  const collapsed = o.collapsed === true;
  const toggle = t(collapsed ? 'am.fixes_expand' : 'am.fixes_collapse');
  const head = `<header class="panel-head"><button type="button" class="am-fixes-toggle" data-am-action="fixes-toggle" aria-expanded="${!collapsed}"`
    + ` aria-controls="am-fixes-body" title="${_esc(toggle)}" aria-label="${_esc(toggle)}"><span class="am-caret" aria-hidden="true">${collapsed ? '▸' : '▾'}</span></button>`
    + `<h3>${_esc(t('am.fixes_title'))}</h3><span class="am-fixes-count">${items.length}</span>`
    + (collapsed ? '' : `<span class="panel-hint">${_esc(t('am.fixes_hint'))}</span>`) + `</header>`;
  if (collapsed) return `<section class="panel am-fixes am-fixes-collapsed" aria-label="${_esc(t('am.fixes_title'))}">${head}</section>`;
  const adminList = o.isAdmin ? [] : items.filter(i => i.adminOnly);
  let body: string;
  if (o.computing && !items.length) {
    body = `<div class="am-lev-skeleton" aria-busy="true">${_esc(t('am.lev_computing'))}</div>`;
  } else if (!items.length) {
    body = `<div class="am-lev-empty">${_esc(t(o.noneInView ? 'am.lev_none_in_view' : 'am.lev_none'))}</div>`;
  } else {
    const limit = Math.min(Math.max(o.limit, LEV_TOP_N), LEV_MAX_RENDER);
    const shown = main.slice(0, limit);
    const list = shown.length
      ? `<div class="am-fix-list" role="list">${shown.map((it, i) => fixRowHtml(it, i + 1, o.ctxFor(it), t)).join('')}</div>` : '';
    const more = main.length > limit && limit < LEV_MAX_RENDER
      ? `<div class="am-more"><button type="button" class="btn sm btn-ghost" data-am-action="fixes-show-more">${_esc(t('am.fixes_more'))}</button></div>` : '';
    let adminHtml = '';
    if (adminList.length) {
      adminHtml = `<button type="button" class="am-fix-divider" aria-expanded="${o.adminOpen}" aria-controls="am-fix-admin-list" data-am-action="fixes-admin-toggle">`
        + `<span class="am-caret" aria-hidden="true">${o.adminOpen ? '▾' : '▸'}</span>${_esc(t('am.fixes_admin_divider', { n: adminList.length }))}</button>`
        + (o.adminOpen
          ? `<div class="am-fix-list" id="am-fix-admin-list" role="list">${adminList.slice(0, LEV_MAX_RENDER).map(it => fixRowHtml(it, null, o.ctxFor(it), t)).join('')}</div>` : '');
    }
    body = list + more + adminHtml;
    if (!body) body = `<div class="am-lev-empty">${_esc(t('am.lev_none'))}</div>`;
  }
  return `<section class="panel am-fixes" aria-label="${_esc(t('am.fixes_title'))}">${head}<div id="am-fixes-body">${body}</div></section>`;
}

/** Plain text for the owner hand-off (clipboard): title, what it clears, lines, orders. */
export function levSummaryText(item: LeverageItem, title: string, t: Translate): string {
  const orders = item.orderIds.length > 50 ? `${item.orderIds.slice(0, 50).join(', ')} …` : item.orderIds.join(', ');
  return [
    title,
    fixClearsText(item, t),
    `${t('am.copy_lines')}: ${item.lines.join(', ')}`,
    `${t('am.copy_orders')}: ${orders}`,
  ].join('\n');
}

/** Setup-pair action pairs in the shape `SetupAdmin.reviewMissingPairs` reads (`fieldKey=value | …` state text). */
export function levPairsForReview(pairs: ReadonlyArray<LeveragePair>, remedy: string): Array<{
  line: string; predecessorOrderId: string | null; successorOrderId: string | null;
  fromState: string; toState: string; reason: string; remedy: string;
}> {
  const text = (s: ReadonlyArray<{ fieldKey: string; value: string }>) => s.map(p => `${p.fieldKey}=${p.value}`).join(' | ');
  return pairs.map(p => ({
    line: p.line, predecessorOrderId: p.predecessorOrderId ?? null, successorOrderId: p.successorOrderId ?? null,
    fromState: text(p.fromState), toState: text(p.toState), reason: p.reason, remedy,
  }));
}

/* ---------------------------------------------------------------------------
   W6a — the Inbox | Matrix model: view + lens, the shared filter, day buckets, the
   compact 32 px row, the short tag and Top-fixes scoping. All pure; W6b wires them.
   ------------------------------------------------------------------------- */

export type MonitorViewKind = 'matrix' | 'inbox';
export type MonitorLens = 'machine' | 'day' | 'group';
/** What `alertMonitorView['*']` stores. */
export interface MonitorView { view: MonitorViewKind; lens: MonitorLens }
export const DEFAULT_VIEW: MonitorView = { view: 'matrix', lens: 'machine' };

const _isView = (v: unknown): v is MonitorViewKind => v === 'matrix' || v === 'inbox';
const _isLens = (v: unknown): v is MonitorLens => v === 'machine' || v === 'day' || v === 'group';

/**
 * The page's view and lens. `settings['*']` wins; a lens it lacks falls back to the stored per-profile `groupBy`
 * of earlier builds (`type` / `category` -> group, `day` -> day, anything else -> machine); the view defaults to matrix.
 */
export function viewFor(
  settings: Record<string, { view?: unknown; lens?: unknown; groupBy?: unknown } | undefined> | null | undefined,
  profileId: string,
): MonitorView {
  const map = settings && typeof settings === 'object' ? settings : {};
  const star = map['*'];
  const per = map[profileId];
  const migrated = (g: unknown): MonitorLens | null =>
    g === 'type' || g === 'category' ? 'group' : g === 'day' ? 'day' : typeof g === 'string' && g ? 'machine' : null;
  const view = _isView(star?.view) ? star!.view : _isView(per?.view) ? per!.view : DEFAULT_VIEW.view;
  const lens = _isLens(star?.lens) ? star!.lens
    : _isLens(per?.lens) ? per!.lens
      : migrated(per?.groupBy) ?? DEFAULT_VIEW.lens;
  return { view: view as MonitorViewKind, lens: lens as MonitorLens };
}

/** The filter's dimensions both views read (session-only). */
export interface MonitorFilter {
  machines: Set<string>;
  wcGroups: Set<string>;
  days: Set<string>;
  categories: Set<AlertCategory>;
  q: string;
}
export type FilterDim = 'machines' | 'wcGroups' | 'days' | 'categories' | 'q';

export function emptyFilter(): MonitorFilter {
  return { machines: new Set(), wcGroups: new Set(), days: new Set(), categories: new Set(), q: '' };
}
export function filterIsEmpty(f: MonitorFilter): boolean {
  return !f.machines.size && !f.wcGroups.size && !f.days.size && !f.categories.size && !f.q.trim();
}

export interface FilterChipLabels {
  machine?: (key: string) => string;
  wc?: (key: string) => string;
  day?: (key: string) => string;
  category?: (cat: AlertCategory) => string;
  q?: (q: string) => string;
}
/** One removable chip per active value, in a stable dimension order. */
export function filterChips(f: MonitorFilter, labels: FilterChipLabels = {}): Array<{ dim: FilterDim; key: string; label: string }> {
  const out: Array<{ dim: FilterDim; key: string; label: string }> = [];
  for (const k of f.wcGroups) out.push({ dim: 'wcGroups', key: k, label: labels.wc ? labels.wc(k) : k });
  for (const k of f.machines) out.push({ dim: 'machines', key: k, label: labels.machine ? labels.machine(k) : k });
  for (const k of f.days) out.push({ dim: 'days', key: k, label: labels.day ? labels.day(k) : k });
  for (const k of f.categories) out.push({ dim: 'categories', key: k, label: labels.category ? labels.category(k) : k });
  const q = f.q.trim();
  if (q) out.push({ dim: 'q', key: q, label: labels.q ? labels.q(q) : q });
  return out;
}

/** The key of the bucket holding lines with no work-center group. */
export const UNGROUPED_KEY = '__ungrouped__';

export interface MonitorMachine { id: string; name?: string; wc_group?: string }

/** A line's work-center group key (`wc_group` of the master line; blank or unknown -> UNGROUPED_KEY). */
export function wcGroupOf(line: string | null | undefined, masterLines: ReadonlyArray<{ machine?: string; id?: string; wc_group?: string }>): string {
  if (!line) return UNGROUPED_KEY;
  for (const m of masterLines) {
    if ((m.id ?? m.machine) === line) return m.wc_group ? String(m.wc_group) : UNGROUPED_KEY;
  }
  return UNGROUPED_KEY;
}

/** What the filter and the matrix need from the page. The pane builds it from the Store (W6b). */
export interface MonitorCtx {
  plantToday: Date;
  /** Day columns: the alert horizon in days (`horizonDays`). */
  horizonDays: number;
  /** The anchor instant of an alert (its order's due, else its own time): built from the overview module's `_memoAnchor(deps)`. */
  anchorOf?: (a: NimbusAlert) => Date | null;
  machines: ReadonlyArray<MonitorMachine>;
  /** Search text sources; blank when absent. */
  orderNoOf?: (a: NimbusAlert) => string;
  materialOf?: (a: NimbusAlert) => string;
  tagOf?: (a: NimbusAlert) => string;
}

/** An alert's anchor, with the plain own-time fallback when the ctx gives no resolver. */
function _anchor(a: NimbusAlert, ctx: Pick<MonitorCtx, 'anchorOf'>): Date | null {
  if (ctx.anchorOf) return ctx.anchorOf(a);
  return a.time instanceof Date && !isNaN(a.time.getTime()) ? a.time : null;
}

/**
 * `'overdue'`, a `YYYY-MM-DD` day key, `'later'` or `'none'`: the Overview band's own bucket rule (`dayBucketKey`),
 * so a Matrix column and an Inbox facet never disagree on what a day is.
 */
export function dayBucketOf(alert: NimbusAlert, plantToday: Date, horizonDays: number, anchorOf?: (a: NimbusAlert) => Date | null): string {
  return dayBucketKey(_anchor(alert, { anchorOf }), plantToday, horizonDays);
}

/** A cached bucketer for one pass (the day keys are built once); same result as `dayBucketOf`. */
export function makeBucketer(ctx: Pick<MonitorCtx, 'plantToday' | 'horizonDays' | 'anchorOf'>): (a: NimbusAlert) => string {
  const keys = horizonDayKeys(ctx.plantToday, ctx.horizonDays);
  return a => {
    const anchor = _anchor(a, ctx);
    if (!anchor) return NONE_KEY;
    const off = alertDayOffset(anchor, ctx.plantToday);
    return off < 0 ? 'overdue' : off >= ctx.horizonDays ? 'later' : keys[off]!;
  };
}

/** The alerts matching every active dimension (AND) and the search text. An empty filter returns the same array. */
export function filterAlerts<A extends NimbusAlert>(alerts: ReadonlyArray<A>, f: MonitorFilter, ctx: MonitorCtx): A[] {
  if (filterIsEmpty(f)) return alerts as A[];
  const wcByLine = new Map<string, string>();
  if (f.wcGroups.size) for (const m of ctx.machines) wcByLine.set(m.id, m.wc_group ? String(m.wc_group) : UNGROUPED_KEY);
  const bucket = f.days.size ? makeBucketer(ctx) : null;
  const q = f.q.trim().toLowerCase();
  return alerts.filter(a => {
    // Same file-under rule as matrixModel: a `wc:`-prefixed id would collide with a group row key, so it counts as no machine.
    if (f.machines.size && !f.machines.has(a.line && !a.line.startsWith('wc:') ? a.line : NONE_KEY)) return false;
    if (f.wcGroups.size && !f.wcGroups.has(a.line ? (wcByLine.get(a.line) ?? UNGROUPED_KEY) : UNGROUPED_KEY)) return false;
    if (f.categories.size && !f.categories.has(_catOf(a.type))) return false;
    if (bucket && !f.days.has(bucket(a))) return false;
    if (q) {
      const hay = [a.taskId ?? '', ctx.orderNoOf?.(a) ?? (a.msgVars?.order ?? ''), a.line ?? '', ctx.materialOf?.(a) ?? '', ctx.tagOf?.(a) ?? '']
        .join('\u0001').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** The order's material description (else its number); an alert with no order reads "machine · day". */
export function materialOf(
  a: Pick<NimbusAlert, 'taskId' | 'line' | 'time'>,
  tasksById: Record<string, { MATERIAL_DESCRIPTION?: string; MATERIAL_NUMBER?: string } | undefined> | null | undefined,
  dayLabel?: (a: Pick<NimbusAlert, 'time'>) => string,
): string {
  const task = a.taskId ? tasksById?.[a.taskId] : undefined;
  if (task) {
    const desc = String(task.MATERIAL_DESCRIPTION ?? '').trim();
    if (desc) return desc;
    const no = String(task.MATERIAL_NUMBER ?? '').trim();
    if (no) return no;
  }
  const day = dayLabel ? dayLabel(a) : (a.time instanceof Date && !isNaN(a.time.getTime()) ? dayKeyOf(a.time) : '');
  return [a.line ?? '', day].filter(Boolean).join(' · ');
}

/** The short tag: `alert.tag.<type>` with the alert's own message variables. */
export function tagOf(a: { type: string; msgVars?: Record<string, string | number> }, t: Translate): string {
  return t('alert.tag.' + a.type, a.msgVars);
}

export interface CompactRowOpts {
  /** The machine column is dropped (the filter is one machine). */
  hideMachine: boolean;
  /** Open: the detail block follows the row. */
  open: boolean;
  material: string;
  tag: string;
  t: Translate;
  /** Order number shown mono; falls back to `msgVars.order`, then `taskId`. */
  orderNo?: string;
  /** Category name; it is the severity dot's `title` (the dot color reads `--bar-pm-<category>`). */
  groupLabel?: string;
  /** The due column text and whether it is overdue. */
  dueText?: string;
  overdue?: boolean;
  /** What-If is active: Fix / Override / Move render disabled. */
  whatIf?: boolean;
  /** `rowDetailHtml(...)` output, appended when `open`. */
  detailHtml?: string;
}

/** One 32 px Inbox / side-list row: grid `14px 10px 92px minmax(0,1fr) 54px 150px 58px auto`; actions show on hover / focus (CSS). */
export function rowHtml(a: NimbusAlert, o: CompactRowOpts): string {
  const t = o.t;
  const id = _esc(a.id);
  const cat = _catOf(a.type);
  const acts = rowActionsFor(a);
  const lock = o.whatIf ? ` disabled aria-disabled="true" title="${_esc(t('am.whatif_blocked'))}"` : '';
  const btns: string[] = [];
  if (acts.goto) btns.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="focus" data-alert-id="${id}">${_esc(t('btn.go_to'))}</button>`);
  const second = acts.fix ? 'fix' : acts.override ? 'override' : acts.slot ? 'slot' : acts.diagnose !== 'none' ? 'diagnose' : null;
  if (second) {
    const label = second === 'fix' ? _splitGlyph(t('btn.fix_it')).text
      : second === 'override' ? _splitGlyph(t('btn.override')).text
        : second === 'slot' ? t('am.slot') : t('am.diagnose');
    const locked = second === 'diagnose' ? '' : lock;
    btns.push(`<button type="button" class="btn sm${second === 'fix' ? ' btn-fix' : ' btn-ghost'} am-act-2" data-alert-action="${second}" data-alert-id="${id}"`
      + (a.taskId ? ` data-task-id="${_esc(a.taskId)}"` : '') + `${locked}>${_esc(label)}</button>`);
  }
  btns.push(`<button type="button" class="icon-btn sm am-row-menu" data-alert-id="${id}" data-ovf-key="${id}" aria-haspopup="menu" aria-expanded="false"`
    + ` aria-label="${_esc(t('am.more_actions'))}" title="${_esc(t('am.more_actions'))}">⋯</button>`);
  const orderNo = o.orderNo ?? String(a.msgVars?.order ?? a.taskId ?? '');
  return `<div class="am-xwrap" role="listitem" data-alert-id="${id}">`
    + `<div class="am-xrow am-xrow-${a.sev}${o.hideMachine ? ' am-xrow-nomc' : ''}${o.open ? ' open' : ''}" tabindex="0" data-alert-id="${id}" aria-expanded="${o.open}">`
    + `<span class="am-sev am-sev-${a.sev}" aria-hidden="true">${_sevGlyph(a.type, a.sev)}</span>`
    + `<span class="am-gdot" style="--c:var(--bar-pm-${cat})" title="${_esc(o.groupLabel ?? cat)}"></span>`
    + `<span class="am-oid">${_esc(orderNo)}</span>`
    + `<span class="am-sub">`
    + `<span class="am-mat" title="${_esc(o.material)}">${_esc(o.material)}</span>`
    + (o.hideMachine ? '' : `<span class="am-mc">${_esc(a.line ?? '')}</span>`)
    + `<span class="am-tag" title="${_esc(o.tag)}">${_esc(o.tag)}</span>`
    + `<span class="am-due${o.overdue ? ' am-when-overdue' : ''}">${_esc(o.dueText ?? '')}</span>`
    + `</span>`
    + `<span class="am-acts">${btns.join('')}</span>`
    + `</div>`
    + (o.open && o.detailHtml ? o.detailHtml : '')
    + `</div>`;
}

export interface RowDetailCtx {
  /** The full message (the Gantt-hover sentence). */
  message: string;
  material: string;
  /** Label key of the first line; an alert with no order reads `am.detail_machine_day` ("Machine · day") instead of Material. */
  materialLabelKey?: string;
  /** The order's lines; each is skipped when undefined (an alert with no order has none of them). */
  due?: string;
  plannedFinish?: string;
  firming?: string;
  /** `overload` only: how many orders sit on that machine-day. */
  ordersOnDay?: number;
  /** Render the "Day details" action (`data-alert-action="cell"`, opens the cell briefing). */
  dayAction?: boolean;
  t: Translate;
}

/** The key/value lines of a detail block, in order (the message line is separate). */
function _detailCells(c: RowDetailCtx): Array<[string, string]> {
  const out: Array<[string, string]> = [[c.materialLabelKey ?? 'am.detail_material', c.material]];
  if (c.due !== undefined) out.push(['am.detail_due', c.due]);
  if (c.plannedFinish !== undefined) out.push(['am.detail_finish', c.plannedFinish]);
  if (c.firming !== undefined) out.push(['am.detail_firming', c.firming]);
  if (c.ordersOnDay !== undefined) out.push(['am.detail_orders_on_day', String(c.ordersOnDay)]);
  return out;
}

const XD_COLS = 4, XD_PAD = 16, XD_MSG = 36, XD_CELL = 30, XD_GAP = 4, XD_ACT = 28, XD_LINE_NARROW = 32;
/**
 * The pixel height of an open row's detail block for exactly the lines `rowDetailHtml` renders (wide: the message line, then
 * the cells four across, then the action row; narrow: one 32 px line each). The Inbox's VirtualList adds it to the row height.
 */
export function detailHeightFor(c: RowDetailCtx, narrow = false): number {
  const cells = _detailCells(c).length;
  if (narrow) return XD_PAD + XD_LINE_NARROW * (1 + cells + (c.dayAction ? 1 : 0));
  const rows = Math.ceil(cells / XD_COLS);
  return XD_PAD + XD_MSG + XD_GAP + rows * XD_CELL + (rows - 1) * XD_GAP + (c.dayAction ? XD_GAP + XD_ACT : 0);
}

/** The expanded row: the full message, then material (or machine and day) and, for an alert with an order, due, planned finish and firming. */
export function rowDetailHtml(a: Pick<NimbusAlert, 'id'>, c: RowDetailCtx): string {
  const f = (cls: string, key: string, v: string) =>
    `<div${cls ? ` class="${cls}"` : ''}><b>${_esc(c.t(key))}</b>${_esc(v)}</div>`;
  const act = c.dayAction
    ? `<div class="am-xact"><button type="button" class="btn sm" data-alert-action="cell" data-alert-id="${_esc(a.id)}">${_esc(c.t('am.day_details'))}</button></div>` : '';
  return `<div class="am-xdetail" style="--am-xd-h:${detailHeightFor(c)}px;--am-xd-hn:${detailHeightFor(c, true)}px" data-alert-id="${_esc(a.id)}">`
    + f('am-xfull', 'am.detail_alert', c.message) + _detailCells(c).map(([k, v]) => f('', k, v)).join('') + act
    + `</div>`;
}

/** What a fix's (or the view's) primary "show me" button does: a lone placed order opens on the Gantt; several orders, or any queued alert (no bar exists), open the Orders table. */
export function fixPrimaryAction(
  item: { orderIds: ReadonlyArray<string>; alertIds: ReadonlyArray<string> },
  alertsById: ReadonlyMap<string, { type: string }> | undefined,
): 'gantt' | 'orders' {
  if (item.orderIds.length === 0) return 'gantt';
  if (item.orderIds.length > 1) return 'orders';
  for (const id of item.alertIds) {
    const type = alertsById?.get(id)?.type;
    if (type === 'needs_planning' || type === 'queued_now_fits') return 'orders';
  }
  return 'gantt';
}

/** Top fixes scoped to the alerts in view: keeps an item when any of its alerts is in `viewIds`, in rank order, with how many are. */
export function fixesInView<I extends { alertIds: ReadonlyArray<string> }>(items: ReadonlyArray<I>, viewIds: ReadonlySet<string>): Array<{ item: I; inView: number }> {
  const out: Array<{ item: I; inView: number }> = [];
  for (const item of items) {
    let n = 0;
    for (const id of item.alertIds) if (viewIds.has(id)) n++;
    if (n > 0) out.push({ item, inView: n });
  }
  return out;
}
