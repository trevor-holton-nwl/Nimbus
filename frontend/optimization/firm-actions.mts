// Pure firm-action rules (universal firm, 2026-10-27, C-1). No Store / Engine /
// DOM imports: `Engine.firmActionFor/firmPlan/firmReasonsText/firmStatusText/
// applyFirm` (optimization/engine.mts) feed it the already-computed reasons.
//
// D1: an order is firmed by a planner (manual), the frozen horizon (finish
// inside [now, frozenEnd)) or because it is running. SAP's own firm flag is
// display-only and is never a reason here.
// D4: not firmed -> "firm"; manual only -> "unfirm"; frozen or running (with or
// without a manual firm) -> no firm/unfirm action anywhere (null). A planner can
// still drag it; only the firm toggle is withheld.

export type FirmReason = 'frozen' | 'manual' | 'running';
export type FirmAction = 'firm' | 'unfirm' | null;

/** The one action a surface may offer for an order with these reasons. */
export function firmActionForReasons(reasons: readonly FirmReason[]): FirmAction {
  if (reasons.includes('frozen') || reasons.includes('running')) return null;
  return reasons.includes('manual') ? 'unfirm' : 'firm';
}

export interface FirmReasonLabelOptions {
  /** Translator (Util.t). */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Pre-formatted frozen-window edge date and time ("10/30/2026 · 06:00 PM"); omitted -> the plain label. */
  frozenUntil?: string | null;
}

/** Human labels in the fixed order running, frozen, manual. */
export function firmReasonLabels(reasons: readonly FirmReason[], opts: FirmReasonLabelOptions): string[] {
  const out: string[] = [];
  if (reasons.includes('running')) out.push(opts.t('ui.firm_reason_running_short'));
  if (reasons.includes('frozen')) {
    out.push(opts.frozenUntil
      ? opts.t('ui.firm_reason_frozen_until', { date: opts.frozenUntil })
      : opts.t('ui.firm_reason_frozen'));
  }
  if (reasons.includes('manual')) out.push(opts.t('ui.firm_reason_manual'));
  return out;
}

export interface FirmPlan { firm: string[]; unfirm: string[]; locked: string[] }

/** Split ids by the action each may take. `reasonsFor` returns null for an id
 *  that no longer resolves to a task (it is dropped from every list). */
export function planFirmActions(
  ids: ReadonlyArray<string | number>,
  reasonsFor: (id: string) => readonly FirmReason[] | null,
): FirmPlan {
  const plan: FirmPlan = { firm: [], unfirm: [], locked: [] };
  for (const raw of ids) {
    const id = String(raw);
    const reasons = reasonsFor(id);
    if (!reasons) continue;
    const action = firmActionForReasons(reasons);
    if (action === 'firm') plan.firm.push(id);
    else if (action === 'unfirm') plan.unfirm.push(id);
    else plan.locked.push(id);
  }
  return plan;
}
