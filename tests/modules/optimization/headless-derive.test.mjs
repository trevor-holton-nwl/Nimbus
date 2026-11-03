import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireWithUnplaced, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { hydrateStoreLikeBrowser } = await import('../helpers/browser-store-hydrate.mjs');
const { Engine, snapshotSchedule } = await import('../../../frontend/optimization/engine.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');
const { buildScheduleSnapshot } = await import('../../../frontend/optimization/headless-snapshot.mjs');
const { deriveDisplayStarts } = await import('../../../frontend/optimization/headless-runtime.mjs');

const withoutRevision = snapshot => { const { readModelVersion: _rev, ...rest } = snapshot; return rest; };
const byId = (snapshot, id) => snapshot.tasks.find(task => task.id === id);

function withClock(fn) {
  const realNow = Date.now;
  Date.now = () => SERVER_NOW.getTime();
  try { return fn(); } finally { Date.now = realNow; }
}

test('derived display starts match the browser path (hydrate, calendar lands, reconcile, snapshot)', () => withClock(() => {
  const wire = wireWithUnplaced();
  const base = buildScheduleSnapshot(wire, { plant: PLANT, serverNow: SERVER_NOW });
  assert.equal(byId(base, '3001').start_date, null, 'the wire snapshot has no derived start yet');
  const headless = deriveDisplayStarts(base, { plant: PLANT, serverNow: SERVER_NOW });
  hydrateStoreLikeBrowser(wire, PLANT);
  const browser = snapshotSchedule(PLANT);
  assert.deepEqual(withoutRevision(headless), withoutRevision(browser));
  for (const id of ['3001', '3002']) {
    const task = byId(headless, id);
    assert.ok(task.start_date instanceof Date && task.start_date < task.end_date, `${id} got a derived start`);
    assert.equal(task.user_scheduled, false, `${id} stays display-only (never placed)`);
  }
  assert.equal(byId(headless, '3003').runtime_schedule_mismatch, false, 'a stale-flagged row is re-derived');
  assert.equal(base.tasks.length, headless.tasks.length);
}));

test('an order with unsaved edits is never re-derived (injected isDirty), same as the browser dirty set', () => withClock(() => {
  const wire = wireWithUnplaced();
  const isDirty = id => id === '3001';
  const headless = deriveDisplayStarts(buildScheduleSnapshot(wire, { plant: PLANT, serverNow: SERVER_NOW }),
    { plant: PLANT, serverNow: SERVER_NOW, isDirty });
  hydrateStoreLikeBrowser(wire, PLANT, { isDirty });
  const browser = snapshotSchedule(PLANT);
  assert.equal(byId(headless, '3001').start_date, null);
  assert.deepEqual(withoutRevision(headless), withoutRevision(browser));
}));

test('nothing is derived while the plant calendar is not hydrated (OQ51)', () => withClock(() => {
  const base = buildScheduleSnapshot(wireWithUnplaced(), { plant: PLANT, serverNow: SERVER_NOW });
  const pending = deriveDisplayStarts(base, { plant: PLANT, serverNow: SERVER_NOW, calendarState: 'pending' });
  assert.equal(byId(pending, '3001').start_date, null);
  assert.equal(byId(pending, '3002').start_date, null);
}));

test('the input snapshot is not modified by the derivation', () => withClock(() => {
  const base = buildScheduleSnapshot(wireWithUnplaced(), { plant: PLANT, serverNow: SERVER_NOW });
  const before = structuredClone(base);
  deriveDisplayStarts(base, { plant: PLANT, serverNow: SERVER_NOW });
  assert.deepEqual(base, before);
}));

// P0-21: derive reads one pinned clock. Store.serverNow drifts with wall time since the wire was received, so a minute
// boundary crossed mid-derive (serverNow hh:mm:59.9) would read two different "now"s inside one reconcile.
test('P0-21: the clock the reconcile reads is the injected instant, however long the derive takes', () => {
  const serverNow = new Date(SERVER_NOW.getTime() + 59_900);
  let tick = 0;
  const realNow = Date.now;
  Date.now = () => serverNow.getTime() + (tick += 400);   // wall time advances 400 ms per read
  const priorReconcile = Engine.reconcileRuntimeSchedules;
  const seen = [];
  Engine.reconcileRuntimeSchedules = function (plant) {
    seen.push(Store.serverNow().getTime());
    seen.push(Store.serverNow().getTime());
    return priorReconcile.call(this, plant);
  };
  try {
    deriveDisplayStarts(buildScheduleSnapshot(wireWithUnplaced(), { plant: PLANT, serverNow }), { plant: PLANT, serverNow });
  } finally {
    Engine.reconcileRuntimeSchedules = priorReconcile;
    Date.now = realNow;
  }
  assert.deepEqual(seen, [serverNow.getTime(), serverNow.getTime()]);
});
