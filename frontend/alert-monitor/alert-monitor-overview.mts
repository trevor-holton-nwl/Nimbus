/* =============================================================================
   ALERT MONITOR OVERVIEW (data helpers only) — the day-bucket data both monitor views read:
   `overviewData`, `dayBucketKey`, `horizonDayKeys`, `horizonDays` and the per-call anchor memo
   `_memoAnchor`. The Overview band that rendered it was retired in W6b (its charts became the
   Matrix row bars and the Inbox facets). No Store, no DOM, no globals: every input is passed in.
   ========================================================================== */

import type { AlertCategory, NimbusTask } from '../platform/types.mjs';
import { anchorTime, alertDayOffset, categoryOf, dayKeyOf, ALERT_CATEGORY_ORDER, NONE_KEY } from '../insights/alert-profiles.mjs';
import type { ProfileDeps } from '../insights/alert-profiles.mjs';

// ---- Types ----------------------------------------------------------------------------------


export interface OverviewDeps {
  tasksById: Record<string, NimbusTask | undefined>;
  /** Start of the plant-local day. */
  plantToday: Date;
  horizonMinutes: number;
  window: { from: number; to: number } | null;
  deps?: ProfileDeps;
}

export interface DayBar {
  key: string;
  offset: number;
  err: number;
  warn: number;
  inWindow: boolean;
  isToday: boolean;
}

export interface OverviewData {
  total: number;
  undated: number;
  overdue: { err: number; warn: number; inWindow: boolean };
  days: DayBar[];
  later: { err: number; warn: number };
  /** The tallest day bar (err + warn); buckets are clamped to it. */
  maxDay: number;
  lines: Array<{ line: string; err: number; warn: number; overload: boolean }>;
  categories: Array<{ cat: AlertCategory; count: number }>;
}

const MAX_DAYS = 60;

/**
 * `anchorTime` with the order's due instant memoised per task for one call: about five alerts share an order, and the
 * production due path (date-only due -> calendar window walk) costs microseconds per call. Same result as `anchorTime`:
 * the due when the order carries one and it resolves, else the alert's own time.
 */
export function _memoAnchor(d: OverviewDeps): (a: NimbusAlert, task: NimbusTask | undefined) => Date | null {
  const dueBy = new Map<NimbusTask, Date | null>();
  const valid = (x: unknown): x is Date => x instanceof Date && !isNaN(x.getTime());
  return (a, task) => {
    if (a.taskId && task && task.original_end_date) {
      let due = dueBy.get(task);
      if (due === undefined) {
        due = anchorTime({ id: '', taskId: a.taskId, time: null } as unknown as NimbusAlert, task, d.deps);   // an invalid own time: only the due can answer
        dueBy.set(task, due);
      }
      if (due) return due;
    }
    return valid(a.time) ? a.time : null;
  };
}

// ---- Day buckets (shared with the Matrix and the Inbox facets) --------------------------------

/**
 * The bucket of one anchor instant: `'none'` (no anchor), `'overdue'` (before today), `'later'` (past the `n`-day horizon),
 * else the `YYYY-MM-DD` key of its day. The same rule `overviewData` applies, so a Matrix column and a facet never disagree.
 */
export function dayBucketKey(anchor: Date | null, plantToday: Date, n: number): string {
  if (!anchor) return NONE_KEY;
  const off = alertDayOffset(anchor, plantToday);
  if (off < 0) return 'overdue';
  if (off >= n) return 'later';
  return dayKeyOf(new Date(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate() + off));
}

/** The horizon's day keys, today first (the same keys `overviewData` builds). */
export function horizonDayKeys(plantToday: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(dayKeyOf(new Date(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate() + i)));
  return out;
}

// ---- Data -----------------------------------------------------------------------------------

/** Columns shown: the alert horizon in days, widened to cover the profile window, clamped 1..60. */
export function horizonDays(horizonMinutes: number, win: { from: number; to: number } | null): number {
  const fromHorizon = Math.ceil((Number(horizonMinutes) || 0) / 1440);
  const fromWindow = win ? win.to + 1 : 0;
  return Math.min(MAX_DAYS, Math.max(1, Math.max(fromHorizon, fromWindow)));
}

/** One pass over the listed alerts: day buckets, per-line and per-category counts. */
export function overviewData(listed: ReadonlyArray<NimbusAlert>, d: OverviewDeps): OverviewData {
  const win = d.window;
  const n = horizonDays(d.horizonMinutes, win);
  const y = d.plantToday.getFullYear(), m = d.plantToday.getMonth(), day = d.plantToday.getDate();
  const days: DayBar[] = [];
  for (let i = 0; i < n; i++) {
    days.push({
      key: dayKeyOf(new Date(y, m, day + i)),   // local-date construction: DST-safe, never derived from alerts
      offset: i, err: 0, warn: 0,
      inWindow: !!win && i >= win.from && i <= win.to,
      isToday: i === 0,
    });
  }
  const overdue = { err: 0, warn: 0, inWindow: !!win && win.from < 0 };
  const later = { err: 0, warn: 0 };
  const lineMap = new Map<string, { line: string; err: number; warn: number; overload: boolean }>();
  const catCount = new Map<AlertCategory, number>();
  let undated = 0;
  const anchorOf = _memoAnchor(d);

  for (const a of listed) {
    const isErr = a.sev === 'err';
    const task = a.taskId ? d.tasksById?.[a.taskId] : undefined;
    const anchor = anchorOf(a, task);
    if (!anchor) undated++;
    else {
      const off = alertDayOffset(anchor, d.plantToday);
      const bucket = off < 0 ? overdue : off >= n ? later : days[off];
      if (isErr) bucket.err++; else bucket.warn++;
    }
    const lineKey = a.line || NONE_KEY;
    let row = lineMap.get(lineKey);
    if (!row) { row = { line: lineKey, err: 0, warn: 0, overload: false }; lineMap.set(lineKey, row); }
    if (isErr) row.err++; else row.warn++;
    if (a.type === 'overload') row.overload = true;
    const cat = categoryOf(a.type);
    catCount.set(cat, (catCount.get(cat) ?? 0) + 1);
  }

  let maxDay = 0;
  for (const b of days) maxDay = Math.max(maxDay, b.err + b.warn);
  const lines = [...lineMap.values()].sort((p, q) =>
    (q.err + q.warn) - (p.err + p.warn) || (p.line < q.line ? -1 : p.line > q.line ? 1 : 0));
  return {
    total: listed.length, undated, overdue, days, later, maxDay, lines,
    categories: ALERT_CATEGORY_ORDER.map(cat => ({ cat, count: catCount.get(cat) ?? 0 })),
  };
}

