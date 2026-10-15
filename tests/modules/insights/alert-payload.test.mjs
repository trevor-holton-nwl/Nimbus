// Task 3.3: the alert request the main thread builds (worker path and synchronous fallback) carries the plant
// clock (`now`, per plant) and the plants the clock refused (`blockedPlants`), so the compute core, never the
// main thread, renders the clock-dependent alerts. Own file: the Worker stub must exist before Compute's first
// (lazy) worker construction, and Compute keeps process-wide state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const posted = [];
class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; }
  postMessage(message) {
    posted.push(message);
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, type: 'RESULT', alerts: [], elapsed: 0, matrix: {} } }));
  }
}
globalThis.Worker = FakeWorker;

const { Compute, Alerts } = await import('../../../frontend/insights/services.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');

function seed() {
  Store._blockedPlants.clear();
  Store.setMasterData({
    plants: [{ plant: 'GOOD', timezone: 'America/New_York' }, { plant: 'BAD', timezone: '' }],
    lines: [{ machine: 'G1', plant: 'GOOD' }, { machine: 'B1', plant: 'BAD' }],
  }, 'unit-test');
  Store.setTasks([
    { id: 'g', PLANT: 'GOOD', MACHINE: 'G1', RUN_TIME: 1 },
    { id: 'b', PLANT: 'BAD', MACHINE: 'B1', RUN_TIME: 1 },
  ], 'unit-test');
}

test('Compute.alerts (worker request) carries the selected plant clock and no blocked plants for a plant with a zone', async () => {
  seed();
  Store.setSelectedPlant('GOOD', 'unit-test');
  posted.length = 0;
  await Compute.alerts({}, new Set());
  const request = posted.find(message => message.type === 'ALERTS');
  assert.ok(request, 'the request reached the worker');
  assert.ok(request.payload.now.GOOD instanceof Date, 'payload.now holds the plant wall-clock Date');
  assert.deepEqual(Object.keys(request.payload.now), ['GOOD']);
  assert.deepEqual(request.payload.blockedPlants, []);
});

test('Compute.alerts for a plant with no timezone sends no clock and lists it as blocked', async () => {
  seed();
  Store.setSelectedPlant('BAD', 'unit-test');
  posted.length = 0;
  await Compute.alerts({}, new Set());
  const request = posted.find(message => message.type === 'ALERTS');
  assert.deepEqual(request.payload.now, {});
  assert.deepEqual(request.payload.blockedPlants, ['BAD']);
});

test('the synchronous fallback hands the core the same clock payload (now + blockedPlants), once, from the shared builder', () => {
  seed();
  const core = globalThis.NimbusComputeCore;
  const original = core.computeAlerts;
  const seen = [];
  core.computeAlerts = (payload) => { seen.push(payload); return original(payload); };
  try {
    Alerts._recomputeSync({});
  } finally { core.computeAlerts = original; }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].now.GOOD instanceof Date);
  assert.equal('BAD' in seen[0].now, false);
  assert.deepEqual(seen[0].blockedPlants, ['BAD']);
  const rendered = Store.alerts.filter(alert => alert.type === 'plant_no_timezone');
  assert.deepEqual(rendered.map(alert => alert.id), ['plant-no-timezone-BAD'], 'the core renders the blocked plant as an alert');
});

test('a plant that resolves is pruned from the blocked set and its alert goes away on the next pass', () => {
  seed();
  Alerts._recomputeSync({});
  assert.ok(Store._blockedPlants.has('BAD'));
  Store.setMasterData({
    plants: [{ plant: 'GOOD', timezone: 'America/New_York' }, { plant: 'BAD', timezone: 'Europe/Paris' }],
    lines: [{ machine: 'G1', plant: 'GOOD' }, { machine: 'B1', plant: 'BAD' }],
  }, 'unit-test');
  Alerts._recomputeSync({});
  assert.equal(Store._blockedPlants.has('BAD'), false);
  assert.equal(Store.alerts.some(alert => alert.type === 'plant_no_timezone'), false);
});
