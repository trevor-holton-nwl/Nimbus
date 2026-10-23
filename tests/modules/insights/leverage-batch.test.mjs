// Task 7: buildPlantSnapshot (setup override hook), runLeverageBatchSync (per-variant isolation) and the
// Compute.leverageBatch surface. The worker handler itself is a classic script (no exports), so its loop is
// pinned through the synchronous twin, which runs the same core calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Compute, buildPlantSnapshot, runLeverageBatchSync } from '../../../frontend/insights/services.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const EMPTY = { intervals: [], diagnostics: [] };
const MARKER = { intervals: [], diagnostics: [{ code: 'what-if-marker' }] };

function seed() {
  const day = new Date(); day.setDate(day.getDate() + 1); day.setHours(8, 0, 0, 0);
  Store.setMasterData({ plants: [{ plant: 'LP' }], lines: [{ plant: 'LP', line: 'LL1' }] }, 'test');
  Store.setTasks([
    { id: 'a', MACHINE: 'LL1', PLANT: 'LP', PRODUCTION_VERSION: 'PV', RUN_TIME: 2, planning_status: 'scheduled',
      start_date: day, end_date: new Date(+day + 2 * 3600000) },
  ], 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setSelectedPlant('LP', 'test');
}

test('Compute exposes leverageBatch and stays closure-private', () => {
  assert.deepEqual(Object.keys(Compute).sort(), ['alerts', 'available', 'leverageBatch', 'utilization']);
  assert.equal(typeof runLeverageBatchSync, 'function');
});

test('buildPlantSnapshot derives setup by default and uses the override when given', () => {
  seed();
  const derived = buildPlantSnapshot('LP');
  assert.deepEqual(derived.tasks.map(t => t.id), ['a']);
  assert.equal('PRODUCTION_VERSION' in derived.tasks[0], false);
  assert.deepEqual(derived.lines, ['LL1']);
  assert.deepEqual(Object.keys(derived).sort(),
    ['blockedPlants', 'blocks', 'calendars', 'lineSettings', 'lines', 'masterData', 'now', 'plantBlocks', 'plants', 'setup', 'tasks']);
  assert.notDeepEqual(derived.setup, MARKER);
  const over = buildPlantSnapshot('LP', { setupObservation: MARKER });
  assert.equal(over.setup, MARKER);
  assert.deepEqual(over.tasks.map(t => t.id), ['a']);
  const keep = buildPlantSnapshot('LP', { stripPriorityFields: false });
  assert.equal(keep.tasks[0].PRODUCTION_VERSION, 'PV');
  assert.equal(buildPlantSnapshot(null).lines, null);
});

test('runLeverageBatchSync returns one {key, alerts, matrix} per variant and leaves the base untouched', () => {
  seed();
  const snap = buildPlantSnapshot('LP');
  const base = {
    tasks: snap.tasks, blocks: snap.blocks, plantBlocks: snap.plantBlocks, calendars: snap.calendars,
    plants: snap.plants, lineSettings: snap.lineSettings, masterData: snap.masterData,
    now: snap.now, blockedPlants: snap.blockedPlants, dismissed: [], opts: { lines: null },
    startMs: new Date().setHours(0, 0, 0, 0), days: 7, lines: snap.lines,
  };
  const before = structuredClone({ calendars: base.calendars, plants: base.plants });
  const results = runLeverageBatchSync(base, [{ key: 'v1', setup: EMPTY }, { key: 'v2', setup: MARKER }]);
  assert.deepEqual(results.map(r => r.key), ['v1', 'v2']);
  for (const r of results) {
    assert.ok(Array.isArray(r.alerts));
    assert.ok(r.matrix.LL1, 'matrix covers the plant line');
    assert.equal(Object.keys(r.matrix.LL1).length, 7);
  }
  assert.deepEqual({ calendars: base.calendars, plants: base.plants }, before,
    'ensureCalendar/ensurePlant writes must not leak into the base payload (or the next variant)');
  assert.deepEqual(runLeverageBatchSync(base, []), []);
});

test('Compute.leverageBatch falls back to the synchronous core when no Worker exists', async () => {
  seed();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  delete globalThis.Worker;
  try {
    const snap = buildPlantSnapshot('LP');
    const out = await Compute.leverageBatch({
      ...snap, dismissed: [], opts: { lines: null }, startMs: new Date().setHours(0, 0, 0, 0), days: 3,
    }, [{ key: 'only', setup: EMPTY }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 'only');
    assert.ok(Array.isArray(out[0].alerts));
    assert.ok(out[0].matrix.LL1);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'Worker', prior);
  }
});

test('compiled worker handles LEVERAGE_BATCH and matches runLeverageBatchSync', async () => {
  const { default: vm } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const posted = [];
  const self = { NimbusComputeCore: globalThis.NimbusComputeCore, location: { search: '' }, postMessage: m => posted.push(m) };
  const ctx = vm.createContext({ self, importScripts() {}, structuredClone });
  vm.runInContext(readFileSync(new URL('../../../frontend/nimbus-worker.js', import.meta.url), 'utf8'), ctx);
  seed();
  const snap = buildPlantSnapshot('LP');
  const base = {
    ...snap, dismissed: [], opts: { lines: null }, startMs: new Date().setHours(0, 0, 0, 0), days: 4,
  };
  const variants = [{ key: 'v1', setup: EMPTY }, { key: 'v2', setup: MARKER }];
  self.onmessage({ data: { type: 'LEVERAGE_BATCH', id: 7, payload: { base, variants } } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'LEVERAGE_BATCH_RESULT');
  assert.equal(posted[0].id, 7);
  const sync = runLeverageBatchSync(base, variants);
  assert.deepEqual(posted[0].results.map(r => r.key), ['v1', 'v2']);
  assert.equal(JSON.stringify(posted[0].results), JSON.stringify(sync));
  assert.equal(Object.keys(posted[0].results[0].matrix.LL1).length, 4, 'days and lines reach computeUtilization');
});

test('Compute.leverageBatch stops the worker and rejects with TimeoutError when it never answers (no main-thread rerun)', async t => {
  seed();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const made = [];
  globalThis.Worker = class { constructor() { made.push(this); } postMessage() {} terminate() { this.terminated = true; } };
  try {
    const { Compute: C } = await import('../../../frontend/insights/services.mjs?silentworker=1');
    const snap = buildPlantSnapshot('LP');
    const p = C.leverageBatch({ ...snap, dismissed: [], opts: { lines: null }, startMs: Date.now(), days: 2 },
      [{ key: 'k', setup: EMPTY }]);
    const rejection = assert.rejects(p, { name: 'TimeoutError' });
    t.mock.timers.tick(31000);
    await rejection;
    assert.equal(made.length, 1);
    assert.equal(made[0].terminated, true);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'Worker', prior); else delete globalThis.Worker;
  }
});

test('no-plant snapshot aliases the live Store maps, yet runLeverageBatchSync adds no keys to them (shallow per-call copies)', () => {
  seed();
  Store.setSelectedPlant(null, 'test');
  try {
    const snap = buildPlantSnapshot(null);
    assert.equal(snap.calendars, Store.calendars, 'the no-plant payload aliases the live calendars map');
    assert.equal(snap.plants, Store.plants, 'and the live plants map');
    const calendarKeys = Object.keys(Store.calendars).sort();
    const plantKeys = Object.keys(Store.plants).sort();
    const base = { ...snap, dismissed: [], opts: { lines: null }, startMs: new Date().setHours(0, 0, 0, 0), days: 3, lines: undefined };
    const out = runLeverageBatchSync(base, [{ key: 'v1', setup: EMPTY }, { key: 'v2', setup: MARKER }]);
    assert.equal(out.length, 2);
    assert.deepEqual(Object.keys(Store.calendars).sort(), calendarKeys, 'Store.calendars gained no keys');
    assert.deepEqual(Object.keys(Store.plants).sort(), plantKeys, 'Store.plants gained no keys');
    assert.deepEqual(Object.keys(base.calendars).sort(), calendarKeys, 'neither did the base the caller passed');
  } finally { Store.setSelectedPlant('LP', 'test'); }
});
