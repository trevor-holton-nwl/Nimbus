/**
 * Tool Inventory: the ONE confirm that guards every path which commits an optimizer candidate (Apply, "Apply what
 * still fits", "Apply without preview", Alert "Fix overload"). It counts only the KEPT patches, never the whole candidate,
 * and asks only when at least one kept patch newly queues an order for tooling. Kept in a small neutral module so the
 * Alerts service and the preview can share it without an import cycle. `candidate.toolBlocked/toolMoved` are filled by
 * the optimizer's overflow pass; when absent (rule Off, or before that pass exists) nothing here ever shows.
 */
import { Util, Modal, ErrorLog } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { CandidateResult, SchedulePatch, ToolBlockedEntry } from './setup-scheduler.mjs';

export const TOOL_QUEUE_LIST_CAP = 5;

/** `queued` = every kept order queued for tooling; `cascade` = how many of those were queued by the repair cascade after a tool move
 *  (their setup changed), not by tool contention itself. */
export interface ToolQueueSummary { queued: ToolBlockedEntry[]; queuedIds: string[]; moved: number; cascade: number }

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
  return { queued, queuedIds: queued.map(entry => String(entry.orderId)), moved: movedIds.size, cascade: queued.filter(entry => entry.cause === 'cascade').length };
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
    ? ` ${Util.t('modal.opt_tool_confirm_more', { count: summary.queuedIds.length - TOOL_QUEUE_LIST_CAP })}` : '';
  const directQueued = summary.queued.length - summary.cascade;   // no "Of which tool: 0 queued" line when every one is a cascade
  return Modal.confirm({
    title: Util.t('modal.opt_tool_confirm_title'),
    message: summary.moved > 0 ? Util.t('modal.opt_tool_confirm_moved', { n: summary.moved }) : '',   // no "moved: 0" line
    detail: `${directQueued > 0 ? `<p>${Util.escapeHtml(Util.t('modal.opt_tool_confirm_queued', { n: directQueued }))}</p>` : ''}${summary.cascade > 0 ? `<p>${Util.escapeHtml(Util.t('modal.opt_tool_confirm_cascade', { n: summary.cascade }))}</p>` : ''}<p>${shown}${Util.escapeHtml(more)}</p>`,
    confirmLabel: Util.t('btn.opt_tool_confirm_apply'),
    tone: 'warn',
  });
}

/** "Raise inventory": Master Data > Tool Inventory filtered to the tool (same lazy import as the alert deep link).
 *  Never rejects (its callers fire it from click handlers without awaiting). Resolves true when the planner was taken to
 *  Tool Inventory, false when they cancelled the plant-switch confirm or the step failed (logged). */
export async function raiseToolInventory(plant: string | null | undefined, tool: string): Promise<boolean> {
  const target = String(plant ?? '');
  try {
    // openForTool switches the selected plant: honour the unsaved-edits guard first (no await, so no delay, when the plant is unchanged).
    if (target && target !== Store.selectedPlant) {
      const { Persistence } = await import('../scheduling/persistence.mjs');   // lazy: keeps this leaf free of an import cycle
      if (!(await Persistence.confirmPlantSwitch(target))) return false;
    }
    NIMBUS?.App?.goto?.('masterdata');
    NIMBUS?.App?.gotoMasterSub?.('tool-inventory');
    const m = await import('../master-data/tool-inventory.mjs');
    m.ToolInventory.openForTool(target, tool);
    return true;
  } catch (err) {
    ErrorLog.warn('optimizer', `Could not open Tool Inventory: ${err instanceof Error ? err.message : String(err)}`, err);
    return false;
  }
}
