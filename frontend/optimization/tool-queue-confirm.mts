/**
 * Tool Inventory: the ONE confirm that guards every path which commits an optimizer candidate (Apply, "Apply what
 * still fits", "Apply without preview", Alert "Fix overload"). It counts only the KEPT patches, never the whole candidate,
 * and asks only when at least one kept patch newly queues an order for tooling. Kept in a small neutral module so the
 * Alerts service and the preview can share it without an import cycle. `candidate.toolBlocked/toolMoved` are filled by
 * the optimizer's overflow pass; when absent (rule Off, or before that pass exists) nothing here ever shows.
 */
import { Util, Modal } from '../platform/foundation.mjs';
import type { CandidateResult, SchedulePatch, ToolBlockedEntry } from './setup-scheduler.mjs';

export const TOOL_QUEUE_LIST_CAP = 5;

export interface ToolQueueSummary { queued: ToolBlockedEntry[]; queuedIds: string[]; moved: number }

/** Counts from the kept patches only: an order counts as queued/moved when its patch is among `kept`. */
export function toolQueueSummary(
  candidate: Pick<CandidateResult, 'toolBlocked' | 'toolMoved'> | null | undefined,
  kept: ReadonlyArray<Pick<SchedulePatch, 'id'>>,
): ToolQueueSummary {
  const keptIds = new Set(kept.map(patch => String(patch.id)));
  const seen = new Set<string>();
  const queued = (candidate?.toolBlocked ?? []).filter(entry => {
    const id = String(entry.orderId);
    if (!keptIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const movedIds = new Set((candidate?.toolMoved ?? []).map(entry => String(entry.orderId)).filter(id => keptIds.has(id)));
  return { queued, queuedIds: queued.map(entry => String(entry.orderId)), moved: movedIds.size };
}

/** Resolves true when there is nothing to confirm or the planner confirms; false on Cancel (the default focus). */
export async function confirmToolQueue(
  candidate: Pick<CandidateResult, 'toolBlocked' | 'toolMoved'> | null | undefined,
  kept: ReadonlyArray<Pick<SchedulePatch, 'id'>>,
): Promise<boolean> {
  const summary = toolQueueSummary(candidate, kept);
  if (!summary.queued.length) return true;
  const shown = summary.queuedIds.slice(0, TOOL_QUEUE_LIST_CAP).map(id => Util.escapeHtml(id)).join(', ');
  const more = summary.queuedIds.length > TOOL_QUEUE_LIST_CAP
    ? ` ${Util.t('ui.opt_bg_more', { count: summary.queuedIds.length - TOOL_QUEUE_LIST_CAP })}` : '';
  return Modal.confirm({
    title: Util.t('modal.opt_tool_confirm_title'),
    message: summary.moved > 0 ? Util.t('modal.opt_tool_confirm_moved', { n: summary.moved }) : '',   // no "moved: 0" line
    detail: `<p>${Util.escapeHtml(Util.t('modal.opt_tool_confirm_queued', { n: summary.queued.length }))}</p><p>${shown}${Util.escapeHtml(more)}</p>`,
    confirmLabel: Util.t('btn.opt_tool_confirm_apply'),
    tone: 'warn',
  });
}

/** "Raise inventory": Master Data > Tool Inventory filtered to the tool (same lazy import as the alert deep link). */
export function raiseToolInventory(plant: string | null | undefined, tool: string): void {
  NIMBUS?.App?.goto?.('masterdata');
  NIMBUS?.App?.gotoMasterSub?.('tool-inventory');
  void import('../master-data/tool-inventory.mjs').then(m => m.ToolInventory.openForTool(String(plant ?? ''), tool));
}
