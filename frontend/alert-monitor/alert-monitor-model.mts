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

export type EmptyKind = 'no-plant' | 'no-alerts' | 'no-match' | null;

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
  return !input.isAllAlerts && input.matchedCount === 0 ? 'no-match' : 'no-alerts';
}
