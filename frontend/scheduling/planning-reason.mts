// scheduling/planning-reason.mjs — the Planning reason's localized text as a pure function.
// Zero imports on purpose: the Orders grid (`Table._planningReasonText`) and the Alert Monitor's
// needs_planning producer (`insights/services.mts`) both need this text, and `services.mts` must
// not import `orders.mjs` (an import cycle). Translation is the injected `t`; whether an
// `overlong_never` order now fits is the caller's knowledge, passed as `opts.nowFits`.

/** The shape this function reads; structurally compatible with `NimbusTask['planning_reason']`. */
export interface PlanningReasonLike {
  code?: string;
  message?: string;
  run_time?: unknown;
  cap_hours?: unknown;
}

export type PlanningReasonTranslate = (key: string, vars?: Record<string, string | number>) => string;

/** A planner Delete carries a fixed code; resolve it through the locale so the label follows the user's
 *  language. The run-time-over-cap reason does the same, filling in the hours the server stored beside the
 *  message. Other codes keep their stored message. An `overlong_never` reason reads "Now fits the calendar"
 *  when `opts.nowFits` is true (display only; the stored reason is never touched). */
export function planningReasonText(
  reason: PlanningReasonLike | null | undefined,
  t: PlanningReasonTranslate,
  opts: { nowFits?: boolean } = {},
): string {
  if (!reason) return '';
  if (reason.code === 'planner_unscheduled') return t('planning_reason.planner_unscheduled');
  if (reason.code === 'overlong_never') {
    return t(opts.nowFits ? 'planning_reason.overlong_released_pending' : 'planning_reason.overlong_never');
  }
  if (reason.code === 'segment_floor_unfittable') return t('planning_reason.segment_floor_unfittable');
  if (reason.code === 'push_limit_unmet') return t('planning_reason.push_limit_unmet');
  if (reason.code === 'run_time_over_cap' && typeof reason.run_time === 'number' && typeof reason.cap_hours === 'number') {
    return t('planning_reason.run_time_over_cap', { hours: String(Math.round(reason.run_time * 10) / 10), cap: String(Math.round(reason.cap_hours * 10) / 10) });
  }
  return reason.message ?? '';
}
