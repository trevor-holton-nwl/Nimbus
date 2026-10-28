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
  /** Tool Inventory (structured, so the text follows the locale and never goes stale): the tool id, the copies available
   *  and the holder order ids (an array, or already joined). */
  tool_id?: unknown;
  available?: unknown;
  holders?: unknown;
  /** `tool_contention` queued at the tool pass's budget expiry carries `incomplete: true` (the code stays `tool_contention`). */
  incomplete?: unknown;
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
  if (reason.code === 'tool_contention' || reason.code === 'tool_contention_incomplete' || reason.code === 'tool_unavailable') {
    const tool = typeof reason.tool_id === 'string' ? reason.tool_id.trim() : '';
    const available = typeof reason.available === 'number' && Number.isFinite(reason.available) ? reason.available : null;
    // The optimizer queues at its budget expiry with code 'tool_contention' + incomplete: true; the older dedicated code still reads the same.
    const incomplete = reason.code === 'tool_contention_incomplete' || (reason.code === 'tool_contention' && reason.incomplete === true);
    if (tool && (incomplete || reason.code !== 'tool_contention' || available !== null)) {
      if (reason.code === 'tool_unavailable') return t('planning_reason.tool_unavailable', { tool });
      if (incomplete) return t('planning_reason.tool_contention_incomplete', { tool });
      return t('planning_reason.tool_contention', { tool, available: available as number, holders: formatToolHolders(reason.holders, t) });
    }
  }
  return reason.message ?? '';
}

/** One holder as text: a plain id, or an object carrying `id` / `order`; anything else JSON, never "[object Object]". */
function holderText(holder: unknown): string {
  if (holder && typeof holder === 'object') {
    const record = holder as Record<string, unknown>;
    const id = record.id ?? record.order;
    if (id != null) return String(id);
    try { return JSON.stringify(holder) ?? ''; } catch { return ''; }
  }
  return String(holder ?? '');
}

/** Holder order ids as one short neutral string: the first five, then "(+N more)". Accepts an array or a ready string. */
export function formatToolHolders(holders: unknown, t: PlanningReasonTranslate): string {
  if (typeof holders === 'string') return holders;
  if (!Array.isArray(holders)) return '';
  const ids = holders.map(holderText).filter(Boolean);
  const shown = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${shown} ${t('ui.opt_bg_more', { count: ids.length - 5 })}` : shown;
}
