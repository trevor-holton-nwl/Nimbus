// Populate the live Store through the same calls the browser's load makes, in the same order: the reference the
// headless snapshot and derivation tests compare against. Import AFTER force-utc.mjs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

export const { Store } = await import('../../../frontend/platform/store.mjs');
export const { Persistence } = await import('../../../frontend/scheduling/persistence.mjs');
export const { CalendarSync } = await import('../../../frontend/calendar/calendar-sync.mjs');
export const { Toast } = await import('../../../frontend/platform/foundation.mjs');

/** `options.isDirty(id)` marks rows as carrying unsaved edits BEFORE the calendar lands (which wakes the
 *  engine's own reconcile subscriber, exactly as in the browser). */
export function hydrateStoreLikeBrowser(wire, plant, { isDirty } = {}) {
  Persistence._dirtyIds.clear();
  CalendarSync._hydration = {};
  const toast = Toast.show;
  Toast.show = () => undefined;
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    const tasks = wire.tasks.data.map(raw => Persistence._prepTask(structuredClone(raw)));
    for (const t of tasks) {
      if (!t.MACHINE || !t.PLANT) continue;
      Store.ensureLineSettings(t.MACHINE);
      Store.lineSettings[t.MACHINE].plant = t.PLANT;
    }
    Store.setServerNow(wire.tasks.meta.server_now, Date.now());
    Store.setFrozenHorizonEnd(wire.tasks.meta.frozen_horizon_end ? new Date(wire.tasks.meta.frozen_horizon_end) : null, 'unit-test');
    Store.setTasks(tasks, 'unit-test');
    if (isDirty) for (const t of Store.tasksArr) if (isDirty(String(t.id))) Persistence._dirtyIds.add(String(t.id));
    for (const t of Store.tasksArr) Store.ensureCalendar(t.MACHINE || 'Unknown');
    Store.setMasterData({
      plants: wire.masterData.plants.rows,
      lines: wire.masterData.machine.rows,
      workcenters: wire.masterData.sap_workcenter?.rows ?? [],
      tool_inventory: wire.masterData.tool_inventory
        ? wire.masterData.tool_inventory.rows.slice().sort((a, b) => (a.tool_id < b.tool_id ? -1 : a.tool_id > b.tool_id ? 1 : 0))
        : undefined,
    }, 'unit-test');
    Store.applyMasterLinesToSettings();   // the shell's master-data-changed subscriber
    Store.rebuildPlantIndex();
    Store.replaceSetupSnapshot(structuredClone(wire.setup), 'unit-test');
    Store.setPriorityRankMaps(structuredClone(wire.priorityRankMaps), 'unit-test');
    // Last: it emits calendar:change from 'calendar-sync', which runs the engine's reconcile.
    CalendarSync._applyConfig(plant, structuredClone(wire.calendar));
  } finally { Toast.show = toast; }
}
