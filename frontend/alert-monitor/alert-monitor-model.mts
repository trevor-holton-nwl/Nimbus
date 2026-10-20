/* =============================================================================
   ALERT MONITOR MODEL — pure, DOM-free helpers behind AlertMonitorPane.

   No Store, no DOM, no globals: every input is passed in and every string comes
   through an injected `t`, so the node tests exercise it directly.
   ========================================================================== */

import type { AlertCategory, AlertProfile, AlertProfileRule, AlertRanking } from '../platform/types.mjs';
import { categoryOf as _catOf } from '../insights/alert-profiles.mjs';

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

/** Types the drawer offers a one-click Fix for (mirrors AlertsUIAdapter._renderAlertRow). */
export const FIXABLE_TYPES: readonly string[] = ['overlap', 'blackout', 'overload', 'tool-conflict'];
/** Types the drawer offers Override for (when the alert carries a taskId). */
export const OVERRIDE_TYPES: readonly string[] = ['closed', 'firmed-closed', 'firmed-out-of-hours'];
/** Calendar-family types: drawn with the ⊘ glyph. */
export const CALENDAR_TYPES: readonly string[] = ['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours'];

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
    fix: FIXABLE_TYPES.includes(a.type),
    override: OVERRIDE_TYPES.includes(a.type) && hasTask,
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
  return CALENDAR_TYPES.includes(type) ? '⊘' : _SEV_GLYPH[sev];
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
  // Acknowledge opens its modal in Task 15; until then it renders disabled with no handler.
  buttons.push(`<button type="button" class="btn btn-ghost sm" data-alert-action="ack" data-alert-id="${id}" disabled aria-disabled="true">${_esc(t('am.ack'))}</button>`);
  buttons.push(`<button type="button" class="icon-btn sm" data-alert-action="dismiss" data-alert-id="${id}" title="${_esc(t('btn.dismiss'))}" aria-label="${_esc(t('btn.dismiss'))}">×</button>`);

  const pts = v.points > 0
    ? `<span class="am-num">${_esc(fmtNum(v.points))}</span>`
    : `<span class="am-num am-num-out" title="${_esc(t('am.points_outside_tip'))}">${_esc(t('am.points_outside'))}</span>`;
  const late = v.lateH > 0 ? fmtNum(v.lateH) : '—';
  const meta = [v.orderNo, v.line].filter(Boolean).map(_esc).join(' · ');
  const help = v.help
    ? `<span class="am-help" tabindex="0" role="img" aria-label="${_esc(v.help)}" title="${_esc(v.help)}">ⓘ</span>` : '';
  const ack = v.ackLabel ? `<span class="badge badge-info am-ack-badge" title="${_esc(v.ackLabel)}">${_esc(v.ackLabel)}</span>` : '';

  return `<div class="am-rowwrap" role="listitem" data-alert-id="${id}">`
    + `<div class="am-row am-row-${v.sev}">`
    + `<span class="am-sev am-sev-${v.sev}" aria-hidden="true">${_sevGlyph(v.type, v.sev)}</span>`
    + `<div class="am-main"><div class="am-hl"><span class="am-headline" title="${_esc(v.headline)}">${_esc(v.headline)}</span>${help}${ack}</div>`
    + `<div class="am-msg" title="${_esc(v.message)}">${_esc(v.message)}</div></div>`
    + `<div class="am-meta"><div class="am-meta-l" title="${_esc(meta)}">${meta}</div>`
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
