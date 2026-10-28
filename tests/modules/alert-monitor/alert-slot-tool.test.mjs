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

test('slotToolOverage: every order of a multi-order slot is checked, not only the first', () => {
  const prior = { md: Store.masterData, tasks: structuredClone(Store.tasksArr) };
  const mine = [queued('q1', 'T1'), queued('q2', 'T100')];
  Store.setTasks([placed('x', 'L1', 8, 12, 'T100'), ...mine], 'unit-test');
  Store.setMasterData({ plants: [], lines: [], workcenters: [], tool_inventory: [] }, 'unit-test');
  try {
    const args = { task: Store.tasks.q1, machine: 'L2', finish: at(11), needHours: 2, plant: 'P' };
    assert.equal(slotToolOverage(args), null, 'the first order alone is fine (T1 is free)');
    assert.deepEqual(slotToolOverage({ ...args, orders: [Store.tasks.q1, Store.tasks.q2] }), { tool: 'T100', available: 1 }, 'the second order collides on T100');
  } finally { Store.setTasks(prior.tasks, 'unit-test'); if (prior.md) Store.setMasterData(prior.md, 'unit-test'); }
});

test('slotToolOverage: plant resolution falls back to the selected plant like order-tooling (no PLANT, unmapped line)', () => {
  const prior = { md: Store.masterData, tasks: structuredClone(Store.tasksArr), plant: Store.selectedPlant };
  const noPlant = (id, line, s, e, tool) => ({ id, MACHINE: line, RUN_TIME: e - s, start_date: at(s), end_date: at(e), PRT_01: tool });
  Store.setSelectedPlant('P', 'unit-test');
  Store.setTasks([noPlant('x', 'ZZ-UNMAPPED', 8, 12, 'T100'), { ...queued('q', 'T100'), PLANT: undefined }], 'unit-test');
  Store.setMasterData({ plants: [], lines: [], workcenters: [], tool_inventory: [] }, 'unit-test');
  try {
    assert.deepEqual(slotToolOverage({ task: Store.tasks.q, machine: 'L2', finish: at(11), needHours: 2, plant: 'P' }), { tool: 'T100', available: 1 });
  } finally { Store.setTasks(prior.tasks, 'unit-test'); Store.setSelectedPlant(prior.plant, 'unit-test'); if (prior.md) Store.setMasterData(prior.md, 'unit-test'); }
});

test('slotToolOverage: a split order occupies its tool for the envelope of its segments', () => {
  const split = { ...placed('x', 'L1', 8, 9, 'T100'), scheduleSegments: [{ sequence: 1, start_date: at(8), end_date: at(9) }, { sequence: 2, start_date: at(14), end_date: at(15) }] };
  const prior = { md: Store.masterData, tasks: structuredClone(Store.tasksArr) };
  Store.setTasks([queued('q', 'T100')], 'unit-test');   // the split row is passed in directly: Store.setTasks would normalise its segments away
  Store.setMasterData({ plants: [], lines: [], workcenters: [], tool_inventory: [] }, 'unit-test');
  try {
    // x holds T100 from 8 to 15 (envelope): a slot ending at 11 collides although the segments themselves do not.
    assert.deepEqual(slotToolOverage({ task: Store.tasks.q, machine: 'L2', finish: at(11), needHours: 2, plant: 'P', tasks: [split] }), { tool: 'T100', available: 1 });
  } finally { Store.setTasks(prior.tasks, 'unit-test'); if (prior.md) Store.setMasterData(prior.md, 'unit-test'); }
});
