// Tool Inventory Wave 5: the Slot dialog's warn-only tool clause (slotToolOverage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { slotToolOverage } from '../../../frontend/alert-monitor/alert-slot-modal.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const at = h => new Date(`2035-08-10T${String(h).padStart(2, '0')}:00:00`);
const placed = (id, line, s, e, tool) => ({ id, PLANT: 'P', MACHINE: line, RUN_TIME: e - s, start_date: at(s), end_date: at(e), PRT_01: tool });
const queued = (id, tool) => ({ id, PLANT: 'P', MACHINE: 'Unknown', RUN_TIME: 2, start_date: null, end_date: null, PRT_01: tool, planning_status: 'needs_planning' });

function run(inventory, tasks, task, finish, needHours) {
  const prior = { md: Store.masterData, tasks: structuredClone(Store.tasksArr) };
  Store.setTasks([...tasks, task], 'unit-test');
  Store.setMasterData({ plants: [], lines: [], workcenters: [], tool_inventory: inventory }, 'unit-test');
  try { return slotToolOverage({ task: Store.tasks[task.id], machine: 'L2', finish, needHours, plant: 'P' }); }
  finally { Store.setTasks(prior.tasks, 'unit-test'); if (prior.md) Store.setMasterData(prior.md, 'unit-test'); }
}

test('slotToolOverage: names the tool when the slotted interval would exceed its copies; null when it fits', () => {
  const others = [placed('x', 'L1', 8, 12, 'T100')];
  assert.deepEqual(run([], others, queued('q', 'T100'), at(11), 2), { tool: 'T100', available: 1 }, 'no row = 1 copy, already in use on L1');
  assert.equal(run([{ plant: 'P', tool_id: 'T100', total_qty: 2, out_of_service_qty: 0 }], others, queued('q', 'T100'), at(11), 2), null, '2 copies cover both');
  assert.equal(run([], others, queued('q', 'T100'), at(16), 2), null, 'a gap after the other order');
  assert.equal(run([], others, queued('q', 'T999'), at(11), 2), null, 'a different tool');
  assert.deepEqual(run([{ plant: 'P', tool_id: 'T100', total_qty: 1, out_of_service_qty: 1 }], [], queued('q', 'T100'), at(11), 2), { tool: 'T100', available: 0 }, 'zero copies');
});

test('slotToolOverage: unloaded inventory, no tool, or no run time says nothing (warn-only, never blocks)', () => {
  const others = [placed('x', 'L1', 8, 12, 'T100')];
  assert.equal(run(undefined, others, queued('q', 'T100'), at(11), 2), null);
  assert.equal(run([], others, queued('q', ''), at(11), 2), null);
  assert.equal(run([], others, { ...queued('q', 'T100'), RUN_TIME: 0 }, at(11), null), null);
});
