import '../helpers/force-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireFixture, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { hydrateStoreLikeBrowser } = await import('../helpers/browser-store-hydrate.mjs');
const { snapshotSchedule } = await import('../../../frontend/optimization/engine.mjs');
const { buildScheduleSnapshot } = await import('../../../frontend/optimization/headless-snapshot.mjs');

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
