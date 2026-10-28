import '../helpers/force-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { wireFixture, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const { Store } = await import('../../../frontend/platform/store.mjs');
const { Persistence } = await import('../../../frontend/scheduling/persistence.mjs');
const { CalendarSync } = await import('../../../frontend/calendar/calendar-sync.mjs');
const { snapshotSchedule } = await import('../../../frontend/optimization/engine.mjs');
const { buildScheduleSnapshot } = await import('../../../frontend/optimization/headless-snapshot.mjs');

/** Populate the live Store through the same calls the browser's load makes, in the same order. */
function hydrateStoreLikeBrowser(wire, plant) {
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
  CalendarSync._applyConfig(plant, structuredClone(wire.calendar));
  Store.replaceSetupSnapshot(structuredClone(wire.setup), 'unit-test');
  Store.setPriorityRankMaps(structuredClone(wire.priorityRankMaps), 'unit-test');
}

const withoutRevision = snapshot => { const { readModelVersion: _rev, ...rest } = snapshot; return rest; };

test('buildScheduleSnapshot deep-equals snapshotSchedule(plant) from a Store hydrated like the browser', () => {
  const realNow = Date.now;
  Date.now = () => SERVER_NOW.getTime();
  try {
    const wire = wireFixture();
    const before = structuredClone(wire);
    hydrateStoreLikeBrowser(wire, PLANT);
    const live = snapshotSchedule(PLANT);
    const built = buildScheduleSnapshot(wire, { plant: PLANT, serverNow: SERVER_NOW });
    assert.deepEqual(wire, before, 'the wire bundle is never mutated');
    assert.deepEqual(built.tasks.map(t => t.id), live.tasks.map(t => t.id), 'same rows in the same order (numeric ids first)');
    assert.deepEqual(withoutRevision(built), withoutRevision(live));
    // Sanity: the fixture really exercises the interesting parts.
    assert.equal(live.tasks.length, 5, 'the other plant is out of scope');
    assert.ok(live.frozenHorizonEnd instanceof Date, 'rolling frozen horizon from the plant clock');
    assert.deepEqual(live.firmedIds, ['1001']);
    assert.equal(live.calendars.L1.inherited, false);
    assert.equal(live.calendars.L2.inherited, true);
    assert.equal(live.plants[PLANT].periods.length, 1);
    assert.equal(live.masterData.tool_inventory[0].tool_id, 'T1');
  } finally { Date.now = realNow; }
});

test('a plant with no calendar response keeps the default calendar (no plant entry, inherited lines)', () => {
  const wire = wireFixture();
  wire.calendar = null;
  wire.masterData.tool_inventory = null;
  const built = buildScheduleSnapshot(wire, { plant: PLANT, serverNow: SERVER_NOW });
  assert.deepEqual(built.plants, {});
  assert.equal(built.masterData.tool_inventory, undefined, 'an unloaded inventory is undefined, never []');
  assert.ok(Object.values(built.calendars).every(entry => entry.inherited === true));
});
