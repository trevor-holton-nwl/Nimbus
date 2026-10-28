// scheduling/order-tooling.mjs: the read-only "Tooling" facts of one order (Inspector row) and the soft warning shown
// when a planner types a tool id that has no inventory row. Pure reads of Store + the compute core's shared tool functions
// (taskToolIds / toolOccupancyInterval / buildToolCapacity / availableCopies), so the Inspector can never disagree with the
// Gantt alert or the optimizer. Nothing here writes, and nothing blocks an edit.

import { Util, Toast } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { NimbusTask } from '../platform/types.mjs';

export interface OrderToolStatus {
  tool: string;
  available: number;
  /** Distinct machines using the tool while this order holds it (this order's machine included). */
  inUse: number;
  hasRow: boolean;
  over: boolean;
}

export type OrderToolingState =
  | { state: 'none' }
  | { state: 'not_loaded' }
  | { state: 'ok'; plant: string; tools: OrderToolStatus[] };

function _plantOf(task: NimbusTask): string {
  return task.PLANT || Store.getPlantForLine(task.MACHINE || 'Unknown') || Store.selectedPlant || '';
}

/** Per tool the order carries: copies available and the peak number of machines using it during this order's occupancy. */
export function orderToolingState(task: NimbusTask): OrderToolingState {
  const core = globalThis.NimbusComputeCore;
  if (!core) return { state: 'none' };
  const tools = core.taskToolIds(task);
  if (!tools.length) return { state: 'none' };
  const inventory = Store.masterData?.tool_inventory;
  if (inventory === undefined) return { state: 'not_loaded' };
  const plant = _plantOf(task);
  const capacity = core.buildToolCapacity({ tool_inventory: inventory });
  const mine = core.toolOccupancyInterval(task);
  const myLine = task.MACHINE || 'Unknown';
  const others = Store.tasksArr.filter(t => String(t.id) !== String(task.id) && _plantOf(t) === plant);
  const out: OrderToolStatus[] = tools.map(tool => {
    const { available, hasRow } = core.availableCopies(capacity, plant, tool);
    const holders: Array<{ line: string; s: number; e: number }> = [];
    for (const t of others) {
      if (!core.taskToolIds(t).includes(tool)) continue;
      const iv = core.toolOccupancyInterval(t);
      if (iv) holders.push({ line: t.MACHINE || 'Unknown', s: +iv.start, e: +iv.end });
    }
    let peak = 1;
    if (mine) {
      const s0 = +mine.start, e0 = +mine.end;
      const overlapping = holders.filter(h => h.s < e0 && h.e > s0);
      const points = [s0, ...overlapping.map(h => Math.max(h.s, s0))];
      for (const at of points) {
        const lines = new Set<string>([myLine]);
        for (const h of overlapping) if (h.s <= at && at < h.e) lines.add(h.line);
        peak = Math.max(peak, lines.size);
      }
    }
    return { tool, available, inUse: peak, hasRow, over: peak > available };
  });
  return { state: 'ok', plant, tools: out };
}

/** The Inspector row's inner HTML (already escaped); '' when the order carries no tool. */
export function toolingRowHtml(task: NimbusTask): string {
  const s = orderToolingState(task);
  if (s.state === 'none') return '';
  const label = Util.escapeHtml(Util.t('ui.insp_tooling'));
  if (s.state === 'not_loaded') {
    return `<div class="insp-row" data-insp-tooling><label>${label}</label><div class="insp-val">${Util.escapeHtml(Util.t('ui.insp_tool_not_loaded'))}</div></div>`;
  }
  const lines = s.tools.map(x => {
    const text = Util.t(x.hasRow ? 'ui.insp_tool_line' : 'ui.insp_tool_line_norow', { tool: x.tool, available: x.available, inUse: x.inUse });
    const over = x.over ? ` <span class="insp-var insp-var-late">${Util.escapeHtml(Util.t('ui.insp_tool_over'))}</span>` : '';
    return `<div>${Util.escapeHtml(text)}${over} <button type="button" class="btn btn-ghost sm" data-act="open-tool-inventory" data-tool="${Util.escapeHtml(x.tool)}" data-plant="${Util.escapeHtml(s.plant)}">${Util.escapeHtml(Util.t('ui.alert_open_tool_inventory'))}</button></div>`;
  }).join('');
  return `<div class="insp-row" data-insp-tooling><label>${label}</label><div class="insp-val">${lines}</div></div>`;
}

/** True when the (already trimmed) typed id is a real tool that has no inventory row and that no other loaded order of the
 *  plant carries (so it is probably a typo). False whenever it cannot tell (inventory not loaded, blank/placeholder). */
export function isUnknownToolId(task: NimbusTask, typed: string): boolean {
  const core = globalThis.NimbusComputeCore;
  if (!core) return false;
  const tool = core.normalizeToolId(typed);
  if (!tool) return false;
  const inventory = Store.masterData?.tool_inventory;
  if (inventory === undefined) return false;
  const plant = _plantOf(task);
  if (core.availableCopies(core.buildToolCapacity({ tool_inventory: inventory }), plant, tool).hasRow) return false;
  return !Store.tasksArr.some(t => String(t.id) !== String(task.id) && _plantOf(t) === plant && core.taskToolIds(t).includes(tool));
}

/** The soft toast for one PRT edit; never blocks the edit. Returns whether it showed. */
export function warnUnknownToolId(task: NimbusTask, typed: string): boolean {
  if (!isUnknownToolId(task, typed)) return false;
  const tool = globalThis.NimbusComputeCore!.normalizeToolId(typed) ?? typed;
  Toast.show(Util.t('toast.tool_id_unknown', { tool }), 'warn', 6000);
  return true;
}
