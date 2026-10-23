// Utilization cache (per-plant LRU keyed on Store.dataRev()), slicing, the filtered-equals-full property and
// Utilization.computeMatrixAsync (dedupe, queue merge, stale drop, rejection/timeout fallback, id hydration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Compute, Utilization } from '../../../frontend/insights/services.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, PerfMonitor } from '../../../frontend/platform/foundation.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };
// Selecting a plant triggers the distribution-summary loader; answer it quietly.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ needs_review: 0, changed: 0, problems: 0 }) });

const PLANT = 'UC-P';
const DAY = new Date(2026, 7, 3);   // a Monday, local midnight
const at = (dayOffset, hour) => new Date(2026, 7, 3 + dayOffset, hour, 0, 0, 0);
const task = (id, line, s, e) => ({ id, PLANT, MACHINE: line, RUN_TIME: 4, start_date: s, end_date: e });

function fixture() {
  Store.setMasterData({ plants: [{ plant: PLANT }], lines: [
    { plant: PLANT, machine: 'UC-L1' }, { plant: PLANT, machine: 'UC-L2' }, { plant: PLANT, machine: 'UC-L3' }] }, 'unit-test');
  Store.setTasks([
    task('uc1', 'UC-L1', at(0, 8), at(0, 12)),
    task('uc2', 'UC-L1', at(2, 9), at(2, 14)),
    task('uc3', 'UC-L2', at(1, 8), at(1, 13)),
    task('uc4', 'UC-L2', at(8, 8), at(8, 12)),   // day 8: only inside a 14-day window
  ], 'unit-test');
  Store.setSelectedPlant(PLANT, 'unit-test');
  Utilization._cacheClear();
}
function restore() {
  Utilization._cacheClear();
  Store.setSelectedPlant(null, 'unit-test');
  Store.setTasks([], 'unit-test');
}
const rowIds = m => Object.fromEntries(Object.entries(m).map(([l, rows]) => [l, Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.tasks.map(t => t.id)]))]));

/** A hand-made worker reply (task ids in row.tasks) for the window, with one order on UC-L1 each day. */
function fakeWorkerMatrix(startMs, days, ids = ['uc1']) {
  const rows = {};
  const start = new Date(startMs);
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    rows[Util.dayKey(d)] = { date: d, scheduled: 1, capacity: 8, effectiveCapacity: 8, pct: 0.125, tasks: [...ids] };
  }
  return { 'UC-L1': rows };
}
function stubCompute(handler) {
  const prior = { available: Compute.available, utilization: Compute.utilization };
  const calls = [];
  Compute.available = () => true;
  Compute.utilization = (startMs, days) => { calls.push({ startMs, days }); return handler(startMs, days, calls.length); };
  return { calls, undo() { Compute.available = prior.available; Compute.utilization = prior.utilization; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// ---- sync cache -------------------------------------------------------------------------------------------------

test('events that cannot change utilization keep the cached matrix; data events evict it', () => {
  fixture();
  try {
    const m1 = Utilization.computeMatrix(DAY, 7);
    for (const type of ['alerts:change', 'lines:selected', 'distribution:summary', 'undo:pushed', 'settings:change']) {
      Store.emit({ type });
      assert.equal(Utilization.computeMatrix(DAY, 7), m1, `${type} must not evict the cache`);
    }
    const evicting = [
      () => Store.updateTask('uc1', { RUN_TIME: 5 }, 'unit-test'),
      () => Store.emit({ type: 'calendar:change', source: 'unit-test' }),
      () => Store.emit({ type: 'blocks:change', source: 'unit-test' }),
      () => Store.emit({ type: 'plantBlocks:change', source: 'unit-test' }),
      () => Store.emit({ type: 'setup-snapshot:replace', snapshot: null, source: 'unit-test' }),
      () => Store.emit({ type: 'plants:replace', source: 'unit-test' }),
      () => Store.emit({ type: 'master-data-changed', source: 'unit-test' }),
      () => Store.emit({ type: 'some-future-event' }),   // exclusion list: an unknown event invalidates
    ];
    let prev = m1;
    for (const fire of evicting) {
      fire();
      const next = Utilization.computeMatrix(DAY, 7);
      assert.notEqual(next, prev, `${fire} must evict the cache`);
      prev = next;
    }
  } finally { restore(); }
});

test('the cache is per plant: switching plants never serves another plant\'s matrix', () => {
  fixture();
  try {
    const a = Utilization.computeMatrix(DAY, 7);
    Store.setSelectedPlant(null, 'unit-test');
    const none = Utilization.computeMatrix(DAY, 7);
    assert.notEqual(none, a);
    Store.setSelectedPlant(PLANT, 'unit-test');
    assert.notEqual(Utilization.computeMatrix(DAY, 7), none);
  } finally { restore(); }
});

test('the cache is bounded (LRU)', () => {
  fixture();
  try {
    for (let d = 1; d <= 9; d++) Utilization.computeMatrix(DAY, d);
    assert.ok(Utilization._cacheEntries().length <= 6);
  } finally { restore(); }
});

test('a 7-day request is the first 7 days of a cached 14-day matrix, exactly equal to a fresh compute', () => {
  fixture();
  try {
    const long = Utilization.computeMatrix(DAY, 14);
    const sliced = Utilization.computeMatrix(DAY, 7);
    assert.notEqual(sliced, long);
    assert.equal(Utilization._cacheEntries().length, 1, 'served from the 14-day entry, no new compute');
    assert.equal(Object.keys(sliced['UC-L1']).length, 7);
    Utilization._cacheClear();
    const fresh = Utilization.computeMatrix(DAY, 7);
    assert.deepEqual(sliced, fresh);
    assert.deepEqual(rowIds(sliced), rowIds(fresh));
    // a window starting inside the cached one, and one that spills past it, behave too
    Utilization._cacheClear();
    Utilization.computeMatrix(DAY, 14);
    const day3 = new Date(2026, 7, 6);
    const mid = Utilization.computeMatrix(day3, 5);
    Utilization._cacheClear();
    assert.deepEqual(mid, Utilization.computeMatrix(day3, 5));
    Utilization._cacheClear();
    Utilization.computeMatrix(DAY, 7);
    Utilization.computeMatrix(DAY, 14);   // longer than cached: a real compute, then it holds both
    assert.equal(Object.keys(Utilization.computeMatrix(DAY, 14)['UC-L1']).length, 14);
  } finally { restore(); }
});

test('a task-subset matrix equals the full matrix row-for-row on the filtered lines (Dashboard filter-after)', () => {
  fixture();
  try {
    const full = Utilization.computeMatrix(DAY, 7);
    for (const keep of [['UC-L1'], ['UC-L2'], ['UC-L1', 'UC-L2']]) {
      const subset = Store.tasksForSelectedPlant().filter(t => keep.includes(t.MACHINE));
      const filtered = Utilization.computeMatrix(DAY, 7, subset);
      for (const line of keep) assert.deepEqual(filtered[line], full[line], `${line} identical in the subset and full matrix`);
      assert.deepEqual(Object.keys(filtered).sort(), Object.keys(full).sort(), 'the padded line set is the same');
    }
  } finally { restore(); }
});

// ---- async path -------------------------------------------------------------------------------------------------

test('no plant selected: computeMatrixAsync is the synchronous path and never touches the worker', async () => {
  fixture();
  Store.setSelectedPlant(null, 'unit-test');
  const stub = stubCompute(() => { throw new Error('worker must not be used'); });
  try {
    const m = await Utilization.computeMatrixAsync(DAY, 7);
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(m, Utilization.computeMatrix(DAY, 7));
  } finally { stub.undo(); restore(); }
});

test('worker unavailable: computeMatrixAsync computes synchronously', async () => {
  fixture();
  const prior = Compute.available;
  Compute.available = () => false;
  try {
    const m = await Utilization.computeMatrixAsync(DAY, 7);
    assert.equal(Object.keys(m['UC-L1']).length, 7);
  } finally { Compute.available = prior; restore(); }
});

test('two concurrent identical requests make one Compute.utilization call and share the result; later ones hit the cache', async () => {
  fixture();
  const gate = deferred();
  const stub = stubCompute(() => gate.promise);
  try {
    const a = Utilization.computeMatrixAsync(DAY, 7);
    const b = Utilization.computeMatrixAsync(DAY, 7);
    const c = Utilization.computeMatrixAsync(DAY, 5);   // a sub-window of the in-flight one
    assert.equal(stub.calls.length, 1);
    gate.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    const [ma, mb, mc] = await Promise.all([a, b, c]);
    assert.equal(ma, mb);
    assert.equal(Object.keys(mc['UC-L1']).length, 5);
    assert.equal(await Utilization.computeMatrixAsync(DAY, 7), ma, 'cache hit');
    assert.equal(stub.calls.length, 1);
  } finally { stub.undo(); restore(); }
});

test('worker task ids are re-hydrated to task objects before caching (the id regression)', async () => {
  fixture();
  const stub = stubCompute(async (startMs, days) => ({ matrix: fakeWorkerMatrix(startMs, days, ['uc1', 'gone']) }));
  try {
    await Utilization.computeMatrixAsync(DAY, 7);
    const later = Utilization.computeMatrix(DAY, 7);   // sync read of the shared cache
    const cell = later['UC-L1'][Util.dayKey(DAY)];
    assert.equal(cell.tasks.length, 1, 'ids that resolve to no task are dropped');
    assert.equal(typeof cell.tasks[0], 'object');
    assert.equal(cell.tasks[0].id, 'uc1');
    assert.equal(stub.calls.length, 1, 'the later sync call was a cache hit');
  } finally { stub.undo(); restore(); }
});

test('a result that lands after the data revision moved is re-posted once; the caller gets the fresh reply and no sync compute', async () => {
  fixture();
  const gate = deferred();
  const fresh = fakeWorkerMatrix(DAY.getTime(), 7, ['uc2']);
  const stub = stubCompute((s, d, n) => (n === 1 ? gate.promise : Promise.resolve({ matrix: fresh })));
  const core = globalThis.NimbusComputeCore;
  const priorCompute = core.computeUtilization;
  let syncComputes = 0;
  core.computeUtilization = (...a) => { syncComputes++; return priorCompute(...a); };
  try {
    const p = Utilization.computeMatrixAsync(DAY, 7);
    Store.updateTask('uc1', { RUN_TIME: 6 }, 'unit-test');   // data moved while the worker ran
    gate.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    const m = await p;
    assert.equal(stub.calls.length, 2, 're-posted exactly once');
    assert.equal(m, fresh);
    assert.equal(syncComputes, 0);
  } finally { core.computeUtilization = priorCompute; stub.undo(); restore(); }
});

test('syncFallback:false callers never pay a main-thread compute when the reply stays stale; they get a named rejection', async () => {
  fixture();
  const gates = [deferred(), deferred()];
  const stub = stubCompute((s, d, n) => gates[n - 1].promise);
  const core = globalThis.NimbusComputeCore;
  const priorCompute = core.computeUtilization;
  let syncComputes = 0;
  core.computeUtilization = (...a) => { syncComputes++; return priorCompute(...a); };
  try {
    const p = Utilization.computeMatrixAsync(DAY, 7, { syncFallback: false });
    const settled = p.then(() => 'resolved', e => e.name);
    Store.updateTask('uc1', { RUN_TIME: 6 }, 'unit-test');
    gates[0].resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    await tick();
    Store.updateTask('uc1', { RUN_TIME: 7 }, 'unit-test');   // and again during the single re-post
    gates[1].resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    assert.equal(await settled, 'UtilizationStale');
    assert.equal(stub.calls.length, 2);
    assert.equal(syncComputes, 0, 'no synchronous compute for a no-paint caller');
  } finally { core.computeUtilization = priorCompute; stub.undo(); restore(); }
});

test('an unrelated event (alerts:change) while the worker runs does not drop the result', async () => {
  fixture();
  const gate = deferred();
  const stub = stubCompute(() => gate.promise);
  try {
    const p = Utilization.computeMatrixAsync(DAY, 7);
    Store.emit({ type: 'alerts:change' });
    const fromWorker = fakeWorkerMatrix(DAY.getTime(), 7);
    gate.resolve({ matrix: fromWorker });
    assert.equal(await p, fromWorker);
  } finally { stub.undo(); restore(); }
});

test('a worker rejection falls back to the synchronous matrix', async () => {
  fixture();
  const stub = stubCompute(() => Promise.reject(new Error('worker error')));
  try {
    const m = await Utilization.computeMatrixAsync(DAY, 7);
    assert.equal(stub.calls.length, 1);
    Utilization._cacheClear();
    assert.deepEqual(m, Utilization.computeMatrix(DAY, 7));
  } finally { stub.undo(); restore(); }
});

test('a worker that never answers falls back to the synchronous matrix after the 20 s budget; a late reply is still cached', async (t) => {
  fixture();
  const gate = deferred();
  const stub = stubCompute(() => gate.promise);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = Utilization.computeMatrixAsync(DAY, 7);
    t.mock.timers.tick(3000);
    let early = false; p.then(() => { early = true; });
    await tick();
    assert.equal(early, false, 'still waiting at 3 s');
    t.mock.timers.tick(17000);
    const m = await p;
    Utilization._cacheClear();
    assert.deepEqual(m, Utilization.computeMatrix(DAY, 7));
    // late reply, data unchanged since the post: cached
    Utilization._cacheClear();
    gate.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    await tick();
    assert.ok(Utilization._cacheEntries().some(e => e.days === 7), 'the late reply was cached');
  } finally { t.mock.timers.reset(); stub.undo(); restore(); }
});

test('a no-paint caller is rejected (not computed synchronously) on timeout', async (t) => {
  fixture();
  const stub = stubCompute(() => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = Utilization.computeMatrixAsync(DAY, 7, { syncFallback: false });
    const settled = p.then(() => 'resolved', e => e.name);
    t.mock.timers.tick(20000);
    assert.equal(await settled, 'UtilizationTimeout');
  } finally { t.mock.timers.reset(); stub.undo(); restore(); }
});

test('at most one request is queued behind the one in flight: newer requests merge into it (one union call)', async () => {
  fixture();
  const first = deferred();
  const second = deferred();
  const stub = stubCompute((s, d, n) => (n === 1 ? first.promise : second.promise));
  try {
    const a = Utilization.computeMatrixAsync(DAY, 7);                       // posted
    const b = Utilization.computeMatrixAsync(DAY, 14);                      // queued
    const c = Utilization.computeMatrixAsync(new Date(2026, 7, 6), 7);      // merged into the queued one
    assert.equal(stub.calls.length, 1, 'nothing else is posted while one is in flight');
    first.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    await a;
    await tick();
    assert.equal(stub.calls.length, 2, 'exactly one queued request was posted');
    assert.equal(stub.calls[1].days, 14);
    assert.equal(stub.calls[1].startMs, DAY.getTime());
    second.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 14) });
    const [mb, mc] = await Promise.all([b, c]);
    assert.equal(Object.keys(mb['UC-L1']).length, 14);
    assert.equal(Object.keys(mc['UC-L1']).length, 7);
    assert.ok(Object.keys(mc['UC-L1'])[0] === Util.dayKey(new Date(2026, 7, 6)));
  } finally { stub.undo(); restore(); }
});

test('a malformed worker reply (no matrix) falls back to the synchronous matrix instead of an unhandled rejection', async () => {
  fixture();
  const stub = stubCompute(() => Promise.resolve({ alerts: [] }));
  try {
    const m = await Utilization.computeMatrixAsync(DAY, 7);
    Utilization._cacheClear();
    assert.deepEqual(m, Utilization.computeMatrix(DAY, 7));
  } finally { stub.undo(); restore(); }
});

test('disjoint windows become separate queued jobs (no union across a gap); overlapping ones still merge', async () => {
  fixture();
  const first = deferred();
  const stub = stubCompute((s, d, n) => (n === 1 ? first.promise : Promise.resolve({ matrix: fakeWorkerMatrix(s, d) })));
  try {
    const far = new Date(2026, 7, 3 + 280);   // Labor's far horizon
    const a = Utilization.computeMatrixAsync(DAY, 7);
    const b = Utilization.computeMatrixAsync(far, 7);
    const c = Utilization.computeMatrixAsync(DAY, 14);
    first.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    await Promise.all([a, b, c]);
    assert.equal(stub.calls.length, 3, 'one in flight, then two separate jobs');
    assert.deepEqual(stub.calls.slice(1).map(x => x.days).sort((x, y) => x - y), [7, 14], 'no ~290-day union');
  } finally { stub.undo(); restore(); }
});

test('an exception while settling a worker reply rejects the waiters, frees the queue and never hangs a joiner', async () => {
  fixture();
  const gate = deferred();
  const stub = stubCompute((s, d, n) => (n === 1 ? gate.promise : Promise.resolve({ matrix: fakeWorkerMatrix(s, d) })));
  const priorRecord = PerfMonitor.record;
  try {
    const a = Utilization.computeMatrixAsync(DAY, 7);
    const aSettled = a.then(() => 'resolved', e => String(e.message));
    const joiner = Utilization.computeMatrixAsync(DAY, 5);   // joins the in-flight request
    PerfMonitor.record = (label, ...rest) => { if (label === 'Utilization.computeMatrixAsync') throw new Error('boom'); return priorRecord.call(PerfMonitor, label, ...rest); };
    gate.resolve({ matrix: fakeWorkerMatrix(DAY.getTime(), 7) });
    assert.equal(await aSettled, 'boom');
    PerfMonitor.record = priorRecord;
    const m = await joiner;   // re-enqueued, answered by the second worker call
    assert.equal(Object.keys(m['UC-L1']).length, 5);
  } finally { PerfMonitor.record = priorRecord; stub.undo(); restore(); }
});

test('worker and synchronous producers fill the shared cache with the SAME matrix, including an idle line with no orders or calendar entry', async () => {
  fixture();
  const core = globalThis.NimbusComputeCore;
  const priorWorker = globalThis.Worker;
  // A real-core "worker": runs the actual compute core on a structured clone of whatever payload Compute posts.
  globalThis.Worker = class {
    postMessage({ type, id, payload }) {
      const result = type === 'UTILIZATION' ? core.computeUtilization(structuredClone(payload)) : { alerts: [] };
      queueMicrotask(() => this.onmessage({ data: { type: 'UTILIZATION_RESULT', id, ...result } }));
    }
  };
  try {
    assert.equal(Compute.available(), true);
    delete Store.calendars['UC-L3'];   // idle line: no orders, no calendar entry
    const viaWorker = await Utilization.computeMatrixAsync(DAY, 7);
    assert.deepEqual(Object.keys(viaWorker).sort(), ['UC-L1', 'UC-L2', 'UC-L3'], 'the idle plant line is present in the worker-filled entry');
    Utilization._cacheClear();
    delete Store.calendars['UC-L3'];
    const viaSync = Utilization.computeMatrix(DAY, 7);
    assert.deepEqual(viaWorker, viaSync, 'row-for-row identical, task objects included');
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker; else globalThis.Worker = priorWorker;
    restore();
  }
});

test('slicing equals a fresh compute in a zone where DST skips local midnight (America/Santiago), or cleanly misses', () => {
  const probe = fileURLToPath(new URL('../helpers/utilization-dst-probe.mjs', import.meta.url));
  const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
  const run = spawnSync(process.execPath, [probe, root, '2026', '8', '3'], { env: { ...process.env, TZ: 'America/Santiago' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(out.mismatches, 0, 'a served slice is identical to a fresh compute');
  assert.ok(out.slices > 0);
});
