/* =============================================================================
   ALERT MONITOR MODEL — pure, DOM-free helpers behind AlertMonitorPane.

   No Store, no DOM, no globals: every input is passed in and every string comes
   through an injected `t`, so the node tests exercise it directly.
   ========================================================================== */

import type { AlertCategory, AlertProfile, AlertProfileRule, AlertRanking } from '../platform/types.mjs';
import { categoryOf as _catOf, FIXABLE_ALERT_TYPES, OVERRIDE_ALERT_TYPES, CALENDAR_ALERT_TYPES } from '../insights/alert-profiles.mjs';
import type { LeverageItem, LeveragePair } from '../insights/alert-leverage.mjs';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The structural slice of a NimbusAlert this module reads. */
export interface AlertLike {
  id: string;
  sev: 'err' | 'warn';
  type: string;
  taskId?: string;
  /** The other order of a pairwise alert (overlap, tool-conflict). */
  peerId?: string;
  line?: string;
  time?: Date | null;
}

export type MonitorGroupBy = 'category' | 'type' | 'line' | 'day' | 'order' | 'none';

export const MONITOR_GROUP_BYS: MonitorGroupBy[] = ['category', 'type', 'line', 'day', 'order', 'none'];
export const MONITOR_SORTS: AlertRanking[] = ['impact', 'time', 'severity', 'orders'];
export const MONITOR_CATEGORIES: AlertCategory[] = ['capacity', 'conflicts', 'calendar', 'setup', 'exceptions'];
export const DEFAULT_GROUP_BY: MonitorGroupBy = 'category';

export interface MonitorView { groupBy: MonitorGroupBy; sort: AlertRanking }

export interface KpiSummary {
  matched: number;
  /** Alerts inside the plant's alert horizon (all profiles). */
  total: number;
  /** The plant horizon in whole days (null when the plant has none). */
  days: number | null;
  errors: number;
  warnings: number;
  /** Distinct orders carrying at least one matched alert. */
  orders: number;
  /** The plant confidence score now (null until computed). */
  confidence: number | null;
  /** Alerts inside the confidence window (the `.d` line of the confidence tile). */
  confidenceWindowAlerts: number;
}

/**
 * KPI strip numbers. `matched` is what the monitor lists (profile window, acknowledged
 * hidden); `all` is the plant-horizon set the "of N" caption quotes.
 */
export function kpiSummary(
  matched: ReadonlyArray<AlertLike>,
  all: ReadonlyArray<AlertLike>,
  plantHorizonMinutes: number | null | undefined,
  confidence: number | null | undefined,
  confidenceWindowAlerts = 0,
): KpiSummary {
  let errors = 0, warnings = 0;
  const orders = new Set<string>();
  for (const a of matched) {
    if (a.sev === 'err') errors++; else warnings++;
    if (a.taskId) orders.add(String(a.taskId));
    if (a.peerId) orders.add(String(a.peerId));   // an overlap / tool conflict affects both orders
  }
  const days = typeof plantHorizonMinutes === 'number' && isFinite(plantHorizonMinutes) && plantHorizonMinutes > 0
    ? Math.max(1, Math.round(plantHorizonMinutes / 1440)) : null;
  return {
    matched: matched.length,
    total: all.length,
    days,
    errors,
    warnings,
    orders: orders.size,
    confidence: typeof confidence === 'number' && isFinite(confidence) ? confidence : null,
    confidenceWindowAlerts,
  };
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
  return t(rule.minSev === 'err' ? 'am.window_sev_err' : rule.minSev === 'warn' ? 'am.window_sev_warn' : 'am.window_sev_any');
}

/** One-line description of a profile's rules, e.g. "Order overlap · D0–7 · errors only". */
export function windowSummary(profile: AlertProfile | null | undefined, t: Translate): string {
  if (!profile || profile.builtIn || !profile.rules?.length) return t('am.window_all');
  return profile.rules.map(rule => {
    const from = rule.dayFrom, to = rule.dayTo;
    const anyDays = from == null && to == null;
    const line = t('am.window_rule', {
      types: _typesText(rule, t),
      from: anyDays ? _DAY_MARK : (from == null ? '…' : from),
      to: anyDays ? _DAY_MARK : (to == null ? '…' : to),
      sev: _sevText(rule, t),
    });
    if (!anyDays) return line;
    // Replace the whole "D{from}–{to}" segment (bounded by the template's own separators) with "any day".
    return line.split(' · ').map(seg => seg.includes(_DAY_MARK) ? t('am.window_any_days') : seg).join(' · ');
  }).join(' | ');
}

/**
 * The group-by / sort for a profile: the user's stored choice (`alertMonitorView[profileId]`)
 * wins, else category grouping and the profile's own default ranking.
 */
export function viewFor(
  profileId: string,
  pref: Record<string, { groupBy?: unknown; sort?: unknown } | undefined> | null | undefined,
  profile: Pick<AlertProfile, 'ranking'> | null | undefined,
): MonitorView {
  const stored = pref && typeof pref === 'object' ? pref[profileId] : undefined;
  const groupBy = MONITOR_GROUP_BYS.includes(stored?.groupBy as MonitorGroupBy)
    ? stored!.groupBy as MonitorGroupBy : DEFAULT_GROUP_BY;
  const fallback: AlertRanking = MONITOR_SORTS.includes(profile?.ranking as AlertRanking) ? profile!.ranking : 'impact';
  const sort = MONITOR_SORTS.includes(stored?.sort as AlertRanking) ? stored!.sort as AlertRanking : fallback;
  return { groupBy, sort };
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
   Rows, group heads and diagnose — pure HTML builders (Task 12).

   Every dynamic string is escaped here; every label comes through the injected `t`. The pane
   computes a RowView (Store / Util / NIMBUS reads) and hands it in, so these stay DOM-free.
   ------------------------------------------------------------------------- */

/** Rows shown per group before "Show all N". */
export const GROUP_ROW_CAP = 40;
/** Fixed row height (px) — also the VirtualList rowH in group-by none. */
export const ROW_H = 56;
/** Height (px) of the inline diagnose panel under an order row. */
export const DIAG_H = 96;

const _esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type DiagnoseKind = 'cell' | 'order' | 'none';

export interface RowActions { goto: boolean; fix: boolean; override: boolean; diagnose: DiagnoseKind }

/** Which actions an alert row offers — the same eligibility the drawer uses, plus Diagnose. */
export function rowActionsFor(a: { type: string; taskId?: string | null; line?: string; time?: Date | null }): RowActions {
  const hasTask = a.taskId != null && a.taskId !== '';
  return {
    goto: hasTask || !!(a.line && a.time),
    fix: FIXABLE_ALERT_TYPES.has(a.type),
    override: OVERRIDE_ALERT_TYPES.has(a.type) && hasTask,
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

export interface GroupTotals { count: number; errors: number; warnings: number; points: number; orders: number; lateH: number }

/**
 * Group-head sums. Orders = distinct taskId ∪ peerId; late hours are summed once per distinct
 * order (an order carrying three alerts is not three times late).
 */
export function groupTotals<A extends AlertLike>(
  alerts: ReadonlyArray<A>,
  pointsOf: (a: A) => number,
  lateOf: (taskId: string) => number,
): GroupTotals {
  const orders = new Set<string>();
  let errors = 0, warnings = 0, points = 0;
  for (const a of alerts) {
    if (a.sev === 'err') errors++; else warnings++;
    points += pointsOf(a);
    if (a.taskId) orders.add(String(a.taskId));
    if (a.peerId) orders.add(String(a.peerId));
  }
  let lateH = 0;
  for (const id of orders) lateH += lateOf(id) || 0;
  return { count: alerts.length, errors, warnings, points, orders: orders.size, lateH };
}

/** One decimal at most, no trailing ".0" (impact points are 5 / 2 times 1 / 1.25 / 1.5). */
export function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export interface RowView {
  id: string;
  type: string;
  sev: 'err' | 'warn';
  taskId?: string;
  line?: string;
  time?: Date | null;
  headline: string;
  message: string;
  help: string;
  orderNo: string;
  dateText: string;
  relText: string;
  anchorTip: string;
  points: number;
  orders: number;
  lateH: number;
  /** What-If is active: Fix / Override render disabled. */
  whatIf: boolean;
  /** Set when an acknowledged row is shown ("Acknowledged by …"). */
  ackLabel: string | null;
  diagOpen: boolean;
  diagHtml: string;
}

const _SEV_GLYPH = { err: '✖', warn: '⚠' } as const;

function _sevGlyph(type: string, sev: 'err' | 'warn'): string {
  return CALENDAR_ALERT_TYPES.has(type) ? '⊘' : _SEV_GLYPH[sev];
}

/** Label/value pairs as a compact definition grid (inside the fixed-height diagnose panel). */
export function diagnoseHtml(fields: ReadonlyArray<{ label: string; value: string }>): string {
  const cells = fields.filter(f => f.value !== '' && f.value != null)
    .map(f => `<div class="am-diag-f"><dt>${_esc(f.label)}</dt><dd title="${_esc(f.value)}">${_esc(f.value)}</dd></div>`).join('');
  return `<dl class="am-diag-grid">${cells}</dl>`;
}

/** One alert row (and, when open, its inline diagnose panel). */
export function rowHtml(v: RowView, t: Translate): string {
  const acts = rowActionsFor(v);
  const id = _esc(v.id);
  const lock = v.whatIf ? ` disabled aria-disabled="true" title="${_esc(t('am.whatif_blocked'))}"` : '';
  const buttons: string[] = [];
  if (acts.goto) {
    buttons.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="focus" data-alert-id="${id}">${_esc(t('btn.go_to'))}</button>`);
  }
  if (acts.fix) {
    buttons.push(v.whatIf
      ? `<button type="button" class="btn-fix" data-alert-action="fix" data-alert-id="${id}"${lock}>${_esc(t('btn.fix_it'))}</button>`
      : `<button type="button" class="btn-fix" title="${_esc(t('tip.fix_alert'))}" data-alert-action="fix" data-alert-id="${id}">${_esc(t('btn.fix_it'))}</button>`);
  }
  if (acts.override) {
    buttons.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="override" data-alert-id="${id}" data-task-id="${_esc(v.taskId)}"${lock}>${_esc(t('btn.override'))}</button>`);
  }
  if (acts.diagnose === 'order') {
    buttons.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="diagnose" data-alert-id="${id}" aria-expanded="${v.diagOpen}">${_esc(t('am.diagnose'))}</button>`);
  } else if (acts.diagnose === 'cell') {
    buttons.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="diagnose" data-alert-id="${id}">${_esc(t('am.diagnose'))}</button>`);
  }
  // An acknowledged row (shown when "Show acknowledged" is on) offers its removal instead; acks are server state, so What-If does not lock them.
  buttons.push(v.ackLabel
    ? `<button type="button" class="btn btn-ghost sm" data-alert-action="unack" data-alert-id="${id}">${_esc(t('am.unack'))}</button>`
    : `<button type="button" class="btn btn-ghost sm" data-alert-action="ack" data-alert-id="${id}">${_esc(t('am.ack'))}</button>`);
  buttons.push(`<button type="button" class="icon-btn sm" data-alert-action="dismiss" data-alert-id="${id}" title="${_esc(t('btn.dismiss'))}" aria-label="${_esc(t('btn.dismiss'))}">×</button>`);

  const pts = v.points > 0
    ? `<span class="am-num">${_esc(fmtNum(v.points))}</span>`
    : `<span class="am-num am-num-out" title="${_esc(t('am.points_outside_tip'))}">${_esc(t('am.points_outside'))}</span>`;
  const late = v.lateH > 0 ? fmtNum(v.lateH) : '—';
  const meta = _esc([v.orderNo, v.line].filter(Boolean).join(' · '));
  const help = v.help
    ? `<span class="am-help" tabindex="0" role="img" aria-label="${_esc(v.help)}" title="${_esc(v.help)}">ⓘ</span>` : '';
  const ack = v.ackLabel ? `<span class="badge badge-info am-ack-badge" title="${_esc(v.ackLabel)}">${_esc(v.ackLabel)}</span>` : '';

  return `<div class="am-rowwrap" role="listitem" data-alert-id="${id}">`
    + `<div class="am-row am-row-${v.sev}">`
    + `<span class="am-sev am-sev-${v.sev}" aria-hidden="true">${_sevGlyph(v.type, v.sev)}</span>`
    + `<div class="am-main"><div class="am-hl"><span class="am-headline" title="${_esc(v.headline)}">${_esc(v.headline)}</span>${help}${ack}</div>`
    + `<div class="am-msg" title="${_esc(v.message)}">${_esc(v.message)}</div></div>`
    + `<div class="am-meta"><div class="am-meta-l" title="${meta}">${meta}</div>`
    + `<div class="am-meta-l" title="${_esc(v.anchorTip)}">${_esc(v.dateText)}</div>`
    + `<div class="am-meta-l am-meta-rel" title="${_esc(v.anchorTip)}">${_esc(v.relText)}</div></div>`
    + `<div class="am-imp">${pts}<span class="am-num">${_esc(v.orders)}</span><span class="am-num">${_esc(late)}</span></div>`
    + `<div class="am-acts">${buttons.join('')}</div>`
    + `</div>`
    + (v.diagOpen && acts.diagnose === 'order' ? `<div class="am-diag">${v.diagHtml}</div>` : '')
    + `</div>`;
}

/** The column captions above a group's rows, aligned to the row grid. */
export function colsHtml(t: Translate): string {
  return `<div class="am-cols" aria-hidden="true"><span></span><span></span><span></span>`
    + `<span class="am-imp"><span class="am-num">${_esc(t('am.col_points'))}</span><span class="am-num">${_esc(t('am.col_orders'))}</span><span class="am-num">${_esc(t('am.col_late'))}</span></span>`
    + `<span></span></div>`;
}

export interface GroupHeadView {
  key: string;
  label: string;
  expanded: boolean;
  totals: GroupTotals;
  /** First alert of the group, for the head's Go To. */
  firstAlertId: string | null;
  firstGoto: boolean;
}

/** The card head: toggle button (glyph, label, counts, totals, caret) plus its three actions. */
export function groupHeadHtml(v: GroupHeadView, t: Translate): string {
  const tot = v.totals;
  const key = _esc(v.key);
  const worst: 'err' | 'warn' = tot.errors > 0 ? 'err' : 'warn';
  const badges = (tot.errors ? `<span class="badge badge-err">${tot.errors}</span>` : '')
    + (tot.warnings ? `<span class="badge badge-warn">${tot.warnings}</span>` : '');
  const total = (val: string, label: string) =>
    `<span class="am-tot"><span class="am-tot-v">${_esc(val)}</span><span class="am-tot-k">${_esc(label)}</span></span>`;
  const goto = v.firstAlertId && v.firstGoto
    ? `<button type="button" class="btn btn-ghost sm" data-alert-action="focus" data-alert-id="${_esc(v.firstAlertId)}">${_esc(t('btn.go_to'))}</button>` : '';
  return `<div class="am-ghead">`
    + `<button type="button" class="am-gtoggle" aria-expanded="${v.expanded}" data-am-action="toggle-group" data-group-key="${key}">`
    + `<span class="am-caret" aria-hidden="true">${v.expanded ? '▾' : '▸'}</span>`
    + `<span class="am-sev am-sev-${worst}" aria-hidden="true">${_SEV_GLYPH[worst]}</span>`
    + `<span class="am-glabel" title="${_esc(v.label)}">${_esc(v.label)}</span>${badges}`
    + `<span class="am-gtots">${total(fmtNum(tot.points), t('am.col_points'))}${total(String(tot.orders), t('am.col_orders'))}${total(tot.lateH > 0 ? fmtNum(tot.lateH) : '—', t('am.col_late'))}</span>`
    + `</button>`
    + `<div class="am-gacts">${goto}`
    + `<button type="button" class="btn btn-ghost sm" data-am-action="group-dismiss" data-group-key="${key}">${_esc(t('am.group_dismiss_n', { n: tot.count }))}</button>`
    + (tot.orders > 0
      ? `<button type="button" class="btn btn-ghost sm" data-am-action="group-open-table" data-group-key="${key}">${_esc(t('am.open_in_table', { n: tot.orders }))}</button>` : '')
    + `</div></div>`;
}

export interface GroupLabelDeps {
  headlineFor: (type: string) => string;
  /** Order number + material for a task id (empty when the task is unknown). */
  orderLabel: (taskId: string) => string;
  /** Whole-day offset of a `YYYY-MM-DD` key from the plant's today. */
  dayOffset: (dayKey: string) => number;
  /** "Thu 23 Oct" for a `YYYY-MM-DD` key. */
  fmtDay: (dayKey: string) => string;
}

/** Display label of a group. `none` is the single "everything" group. */
export function groupLabel(by: MonitorGroupBy, key: string, d: GroupLabelDeps, t: Translate): string {
  const unassigned = t('am.group_unassigned');
  switch (by) {
    case 'category': return t(`ape.cat_${key}`);
    case 'type': return d.headlineFor(key);
    case 'line': return key === 'none' ? unassigned : key;
    case 'order': return key === 'none' ? unassigned : (d.orderLabel(key) || key);
    case 'day': return key === 'none' ? unassigned : `${d.fmtDay(key)} · ${relativeDaysText(d.dayOffset(key), t)}`;
    case 'none':
    default: return t('am.group_none');
  }
}

/* ---------------------------------------------------------------------------
   High-leverage fixes (Task 13) — pure card / section builders.

   The pane decides the context (plant cap, admin, What-If, remaining count) and hands it in as a
   LevCtx; nothing here reads a global. Points lead (D12); a `requiresMinutes` card never shows a
   predicted score — it asks for minutes and shows the exact number only after the replay returns.
   ------------------------------------------------------------------------- */

/** Cards shown before "Show all fixes". */
export const LEV_TOP_N = 5;

export interface LevCtx {
  /** The plant's alert penalty is at the cap, so removing this card's alerts cannot move the score. */
  capped: boolean;
  /** This card's alerts that persist after a fix was attempted from the page (0 = none / not attempted). */
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

/** The alert category whose swatch/label stands in for the family badge. */
const _FAMILY_CAT: Record<LeverageItem['family'], AlertCategory> = {
  'setup-pair': 'setup', 'calendar-day': 'calendar', 'routing-gap': 'exceptions',
  tool: 'conflicts', 'machine-state': 'setup', 'optimize-window': 'capacity',
};

const _ROUTING_UPLOAD = new Set(['no_routing', 'pv_not_found', 'pv_expired', 'no_operation_at_workcenter']);

function _stateText(state: ReadonlyArray<{ fieldKey: string; value: string }>, fieldLabel: (k: string) => string): string {
  return state.map(p => `${fieldLabel(p.fieldKey)}: ${p.value}`).join(', ');
}

/** The card title. Setup pairs are re-localised from the pair states (the engine's `titleVars` are English). */
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

/** Every action a card offers, primary first; the pane dispatches on `act`. */
export function levActions(item: LeverageItem, ctx: LevCtx): LevAction[] {
  const out: LevAction[] = [];
  const add = (act: string, labelKey: string, primary = false, extra: Partial<LevAction> = {}) =>
    { out.push({ act, labelKey, primary, ...extra }); };
  const n = item.orderIds.length;
  const a = item.action;
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
    default: break;
  }
  if (n > 0 && !out.some(x => x.act === 'open-table')) add('open-table', 'am.open_in_table', false, { labelVars: { n } });
  add('show-alerts', 'am.lev_show_alerts');
  if (item.adminOnly && !out.some(x => x.act === 'copy-summary')) add('copy-summary', 'am.lev_copy_summary');
  return out;
}

function _levScoreHtml(item: LeverageItem, ctx: LevCtx, t: Translate): string {
  if (item.requiresMinutes === true) {
    const key = _esc(item.key);
    const needs = _esc(t('am.lev_needs_minutes'));
    return `<div class="am-lev-minutes"><label class="am-lev-needs"><span>${needs}</span>`
      + `<input type="number" class="am-lev-min-input" min="1" step="1" inputmode="numeric" data-lev-minutes="${key}" `
      + `placeholder="${_esc(t('am.lev_minutes_ph'))}" aria-label="${needs}"></label></div>`;
  }
  const after = item.confidenceAfter;
  if (after == null) return '';
  if (item.points <= 0) {
    return `<div class="am-lev-score am-lev-na"><span class="am-lev-val">${_esc(t('am.lev_conf_na'))}</span>`
      + `<span class="am-lev-note">${_esc(t('am.lev_outside_window'))}</span></div>`;
  }
  const method = item.method === 'replay' ? 'am.lev_method_exact' : item.method === 'removal' ? 'am.lev_method_estimate' : '';
  const eyebrow = method ? `<span class="am-eyebrow am-lev-method">${_esc(t(method))}</span>` : '';
  if (after === item.confidenceBefore && ctx.capped) {
    return `<div class="am-lev-score"><span class="am-lev-note">${_esc(t('am.lev_score_capped'))}</span>${eyebrow}</div>`;
  }
  const d = after - item.confidenceBefore;
  const delta = d === 0 ? '' : `<span class="am-lev-delta ${d > 0 ? 'am-lev-up' : 'am-lev-down'}">${d > 0 ? '+' : ''}${d}</span>`;
  const partial = item.outsideConfidenceWindowCount > 0
    ? `<span class="am-lev-note">${_esc(t('am.lev_partial_window', { n: item.outsideConfidenceWindowCount }))}</span>` : '';
  return `<div class="am-lev-score"><span class="am-lev-val">${_esc(t('am.lev_score', { before: item.confidenceBefore, after }))}</span>${delta}${eyebrow}${partial}</div>`;
}

/** One leverage card. */
export function levCardHtml(item: LeverageItem, ctx: LevCtx, t: Translate): string {
  const key = _esc(item.key);
  const title = levTitle(item, ctx, t);
  const cat = _FAMILY_CAT[item.family];
  const admin = item.adminOnly ? `<span class="badge badge-info am-lev-admin">${_esc(t('am.lev_admin_fix'))}</span>` : '';
  let room = '';
  if (item.family === 'optimize-window' && item.headroomHours != null) {
    const h = item.headroomHours;
    room = `<div class="am-lev-room${h > 0 ? '' : ' am-lev-room-none'}">${_esc(h > 0
      ? t('am.lev_headroom', { h: fmtNum(h) }) : t('am.lev_no_headroom', { h: fmtNum(Math.abs(h)) }))}</div>`;
  }
  if (item.family === 'setup-pair' && !ctx.setupActive) {
    room = `<div class="am-lev-room am-lev-room-none">${_esc(t('am.lev_setup_inactive'))}</div>`;
  }
  const remaining = ctx.remaining > 0
    ? `<div class="am-lev-remaining">${_esc(t('am.lev_remaining', { n: ctx.remaining }))}</div>` : '';
  const buttons = levActions(item, ctx).map(a => {
    const label = t(a.labelKey, a.labelVars);
    const tag = a.admin ? ` <span class="am-lev-adm">${_esc(t('am.lev_admin_fix'))}</span>` : '';
    return `<button type="button" class="btn sm ${a.primary ? 'btn-primary' : 'btn-ghost'}" data-lev-action="${_esc(a.act)}" data-lev-key="${key}"`
      + `${a.disabled ? ` disabled aria-disabled="true" title="${_esc(t('am.whatif_blocked'))}"` : ''}>${_esc(label)}${tag}</button>`;
  }).join('');
  return `<article class="am-lev-card panel" data-lev-key="${key}">`
    + `<div class="am-lev-top"><span class="am-lev-fam"><span class="am-cat-swatch am-cat-${cat}" aria-hidden="true"></span>${_esc(t(`ape.cat_${cat}`))}</span>${admin}</div>`
    + `<div class="am-lev-title" title="${_esc(title)}">${_esc(title)}</div>`
    + `<div class="am-lev-mono">${_esc(t('am.lev_alerts', { n: item.alertIds.length, m: item.orderIds.length }))}</div>`
    + `<div class="am-lev-points">${_esc(t('am.lev_points', { n: fmtNum(item.points) }))}</div>`
    + _levScoreHtml(item, ctx, t) + room + remaining
    + `<div class="am-lev-acts">${buttons}</div></article>`;
}

export interface LevSectionOpts {
  showAll: boolean;
  /** The first pass has not produced results yet. */
  computing: boolean;
  ctxFor: (item: LeverageItem) => LevCtx;
}

/** The whole panel: head, cards (top 5 or all), "Show all fixes", skeleton or the empty copy. */
export function levSectionHtml(items: ReadonlyArray<LeverageItem>, o: LevSectionOpts, t: Translate): string {
  const head = `<div class="am-lev-head"><span class="am-eyebrow">${_esc(t('am.leverage_title'))}</span>`
    + `<span class="am-lev-hint">${_esc(t('am.leverage_hint'))}</span></div>`;
  let body: string;
  if (o.computing && !items.length) {
    body = `<div class="am-lev-skeleton" aria-busy="true">${_esc(t('am.lev_computing'))}</div>`;
  } else if (!items.length) {
    body = `<div class="am-lev-empty">${_esc(t('am.lev_none'))}</div>`;
  } else {
    const shown = o.showAll ? items : items.slice(0, LEV_TOP_N);
    body = `<div class="am-lev-list">${shown.map(it => levCardHtml(it, o.ctxFor(it), t)).join('')}</div>`
      + (!o.showAll && items.length > LEV_TOP_N
        ? `<div class="am-more"><button type="button" class="btn sm btn-ghost" data-am-action="lev-show-more">${_esc(t('am.lev_show_more'))}</button></div>` : '');
  }
  return `<section class="am-lev-panel" aria-label="${_esc(t('am.leverage_title'))}">${head}${body}</section>`;
}

/** Plain text for the owner hand-off (clipboard): title, lines, orders, points. */
export function levSummaryText(item: LeverageItem, title: string, t: Translate): string {
  const orders = item.orderIds.length > 50 ? `${item.orderIds.slice(0, 50).join(', ')} …` : item.orderIds.join(', ');
  return [
    title,
    t('am.lev_alerts', { n: item.alertIds.length, m: item.orderIds.length }),
    `${t('am.group_line')}: ${item.lines.join(', ')}`,
    `${t('am.col_orders')}: ${orders}`,
    t('am.lev_points', { n: fmtNum(item.points) }),
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
