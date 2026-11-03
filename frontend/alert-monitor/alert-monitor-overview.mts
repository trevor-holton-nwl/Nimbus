/* =============================================================================
   ALERT MONITOR OVERVIEW (day-bucket helpers only) — the day-bucket data both monitor views read:
   the bucket keys (`OVERDUE_KEY`, `LATER_KEY`, `NONE_KEY`), `horizonDayKeys`, `horizonDays` and the
   per-call anchor memo `_memoAnchor`. The Overview band that rendered it was retired in W6b (its
   charts became the Matrix row bars and the Inbox facets). No Store, no DOM, no globals: every
   input is passed in.
   ========================================================================== */

import type { NimbusTask } from '../platform/types.mjs';
import { anchorTime, dayKeyOf, NONE_KEY } from '../insights/alert-profiles.mjs';
import type { ProfileDeps } from '../insights/alert-profiles.mjs';

// The day-bucket sentinels. A bucket is `OVERDUE_KEY` (before today), a `YYYY-MM-DD` day key, `LATER_KEY` (past the horizon) or
// `NONE_KEY` (no anchor). Re-exported with the other two so every reader takes the three from one place.
export { NONE_KEY };
export const OVERDUE_KEY = 'overdue';
export const LATER_KEY = 'later';

// ---- Types ----------------------------------------------------------------------------------

export interface OverviewDeps {
  tasksById: Record<string, NimbusTask | undefined>;
  /** Start of the plant-local day. */
  plantToday: Date;
  horizonMinutes: number;
  window: { from: number; to: number } | null;
  deps?: ProfileDeps;
}

/** Day columns are capped here; alerts past the cap fall in the `LATER_KEY` bucket. */
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

/** The horizon's day keys, today first (local-date construction: DST-safe, never derived from alerts). */
export function horizonDayKeys(plantToday: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(dayKeyOf(new Date(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate() + i)));
  return out;
}

/** Columns shown: the alert horizon in days, widened to cover the profile window, clamped 1..60. */
export function horizonDays(horizonMinutes: number, win: { from: number; to: number } | null): number {
  const fromHorizon = Math.ceil((Number(horizonMinutes) || 0) / 1440);
  const fromWindow = win ? win.to + 1 : 0;
  return Math.min(MAX_DAYS, Math.max(1, Math.max(fromHorizon, fromWindow)));
}
