// optimization/run-params.mjs: the pure leaf of run parameters every Optimize entry point shares (the dialog,
// the Jobs headless CLI, the engine's budget constants). No imports and no Store access on purpose: the dialog
// (optimize-ui), headless-cli and the engine each used to carry a private copy, and the copies could drift.
//
// All date math reads LOCAL getters, exactly as the old per-file copies did: the dialog runs in the browser zone,
// headless-cli starts its process with TZ=<plant timezone>.

/** Search budget (ms) of a Normal run and of the Exhaustive background run. */
export const SETUP_AWARE_NORMAL_BUDGET_MS = 8000;
export const SETUP_AWARE_EXHAUSTIVE_BUDGET_MS = 180000;

/** The primary search budget for a run. */
export function budgetFor(exhaustive: boolean): number {
  return exhaustive ? SETUP_AWARE_EXHAUSTIVE_BUDGET_MS : SETUP_AWARE_NORMAL_BUDGET_MS;
}

/** The strategies a run accepts (the order the picker shows them; `OptimizerMode` in platform/types). */
export const RUN_MODES = ['spt', 'changeover', 'duedate', 'backlog'] as const;

export function isRunMode(value: unknown): boolean {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

/** `date` plus whole calendar months, the day clamped to the month's end (Jan 31 + 1 month = Feb 28/29). */
export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, last));
  return result;
}

/** The slice of an order the Remove Backlog window reads. */
export interface BacklogWindowTask {
  MACHINE?: string | null;
  start_date?: Date | null;
  end_date?: Date | null;
}

/** Calendar months the Remove Backlog window may reach past "now". */
export const BACKLOG_WINDOW_MONTHS = 4;

/**
 * Remove Backlog's default window: from the earliest start in the past to the latest end, capped four calendar
 * months past `now`; a plant with nothing in the past starts at `now`. `lines` (optional) restricts the orders by
 * MACHINE (an order with no machine is on "Unknown"). One pass over the orders.
 */
export function backlogWindow(
  tasks: ReadonlyArray<BacklogWindowTask>, now: Date, lines?: ReadonlySet<string> | null,
): { start: Date; end: Date } {
  let earliestPast = Infinity;
  let latestEnd = -Infinity;
  const nowMs = now.getTime();
  for (const task of tasks) {
    if (lines && !lines.has(task.MACHINE || 'Unknown')) continue;
    const start = task.start_date;
    if (start && start < now) { const ms = start.getTime(); if (ms < earliestPast) earliestPast = ms; }
    const end = task.end_date;
    if (end) { const ms = end.getTime(); if (ms > latestEnd) latestEnd = ms; }
  }
  const capEnd = addCalendarMonths(now, BACKLOG_WINDOW_MONTHS);
  const start = earliestPast !== Infinity ? new Date(earliestPast) : new Date(nowMs);
  let end = latestEnd !== -Infinity ? new Date(Math.min(latestEnd, capEnd.getTime())) : capEnd;
  if (end < start) end = addCalendarMonths(start, BACKLOG_WINDOW_MONTHS);
  return { start, end };
}
