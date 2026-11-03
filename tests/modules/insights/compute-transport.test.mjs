import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../../../frontend/platform/store.mjs';
import { ErrorLog, Util } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
let moduleId = 0;

// Each import gives the closure-private worker a fresh lifetime. Only the browser
// Worker boundary is replaced: snapshot construction and request dispatch are real.
async function transport(t, constructorError = false) {
  const workers = [];
  t.mock.method(ErrorLog, 'warn', () => {});
  t.mock.method(ErrorLog, 'error', () => {});
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({}) }));
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class {
    constructor(url) {
      if (constructorError) throw new Error('CSP blocked worker');
      this.url = url;
      this.sent = [];
      workers.push(this);
    }
    postMessage(message) { this.sent.push(structuredClone(message)); }
    reply(index, data) { this.onmessage({ data: { id: this.sent[index].id, ...data } }); }
    crash() { this.onerror({ message: 'crash', filename: 'worker.js', lineno: 2 }); }
    terminate() { this.terminated = true; }
  };
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'Worker', prior);
    else delete globalThis.Worker;
  });
  Store.setSelectedPlant(null, 'test');
  Store.setTasks([], 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  for (const line of Object.keys(Store.lineSettings)) delete Store.lineSettings[line];
  Store.setMasterData({ plants: [], lines: [] }, 'test');
  const mod = await import(`../../../frontend/insights/services.mjs?transport=${++moduleId}`);
  return { Compute: mod.Compute, workers, mod };
}

test('worker is created lazily and reused by concurrent request types', async t => {
  const { Compute, workers } = await transport(t);
  assert.equal(Compute.available(), true);
  assert.equal(workers.length, 0);
  const alerts = Compute.alerts();
  const utilization = Compute.utilization(123, 7);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent.map(m => m.type), ['ALERTS', 'UTILIZATION']);
  workers[0].reply(0, { alerts: [], elapsed: 1 });
  workers[0].reply(1, { matrix: {} });
  await Promise.all([alerts, utilization]);
});

test('out-of-order responses resolve only their matching request', async t => {
  const { Compute, workers } = await transport(t);
  const first = Compute.alerts();
  const second = Compute.utilization(1, 2);
  const worker = workers[0];
  assert.notEqual(worker.sent[0].id, worker.sent[1].id);
  worker.reply(1, { matrix: { L2: {} } });
  worker.reply(0, { alerts: [{ id: 'a' }], elapsed: 4 });
  assert.deepEqual(await first, { id: worker.sent[0].id, alerts: [{ id: 'a' }], elapsed: 4 });
  assert.deepEqual((await second).matrix, { L2: {} });
});

test('unknown and duplicate replies do not consume another pending request', async t => {
  const { Compute, workers } = await transport(t);
  const first = Compute.alerts();
  const second = Compute.alerts();
  workers[0].onmessage({ data: { id: -1, alerts: ['unknown'] } });
  workers[0].reply(0, { alerts: ['first'] });
  workers[0].reply(0, { alerts: ['duplicate'] });
  workers[0].reply(1, { alerts: ['second'] });
  assert.deepEqual((await first).alerts, ['first']);
  assert.deepEqual((await second).alerts, ['second']);
});

test('compute ERROR rejects its request and preserves unrelated requests and worker availability', async t => {
  const { Compute, workers } = await transport(t);
  const failed = Compute.alerts();
  const rejection = assert.rejects(failed, /bad calendar/);
  const good = Compute.utilization(0, 1);
  workers[0].reply(0, { type: 'ERROR', error: 'bad calendar', failingType: 'ALERTS', stack: 'worker stack' });
  workers[0].reply(1, { matrix: {} });
  await rejection;
  await good;
  assert.equal(Compute.available(), true);
  assert.equal(ErrorLog.error.mock.calls.length, 1);
  assert.equal(ErrorLog.error.mock.calls[0].arguments[3].stack, 'worker stack');
});

test('first crash rejects every pending request and next call creates a fresh worker', async t => {
  const { Compute, workers } = await transport(t);
  const a = assert.rejects(Compute.alerts(), /worker error/);
  const b = assert.rejects(Compute.utilization(0, 1), /worker error/);
  workers[0].crash();
  await Promise.all([a, b]);
  assert.equal(workers[0].terminated, true, 'the crashed worker is terminated before the reference is dropped');
  assert.equal(Compute.available(), true);
  const retry = Compute.alerts();
  assert.equal(workers.length, 2);
  assert.ok(workers[1].sent[0].id > workers[0].sent[1].id);
  workers[1].reply(0, { alerts: [] });
  await retry;
});

test('second crash permanently disables transport for the session', async t => {
  const { Compute, workers } = await transport(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = assert.rejects(Compute.alerts(), /worker error/);
    workers[attempt].crash();
    await rejected;
  }
  assert.equal(Compute.available(), false);
  await assert.rejects(Compute.utilization(0, 1), /worker unavailable/);
  assert.equal(workers.length, 2);
});

test('constructor failure rejects the request and disables future initialization', async t => {
  const { Compute, workers } = await transport(t, true);
  await assert.rejects(Compute.alerts(), /worker unavailable/);
  assert.equal(Compute.available(), false);
  await assert.rejects(Compute.alerts(), /worker unavailable/);
  assert.equal(workers.length, 0);
});

test('postMessage failure rejects promptly without disabling a usable worker', async t => {
  const { Compute, workers } = await transport(t);
  const initial = Compute.alerts();
  workers[0].reply(0, { alerts: [] });
  await initial;
  workers[0].postMessage = () => { throw new DOMException('uncloneable', 'DataCloneError'); };
  await assert.rejects(Compute.alerts(), { name: 'DataCloneError' });
  assert.equal(Compute.available(), true);
});

for (const [scope, expected] of [[undefined, null], [new Set(), []], [new Set(['L2', 'L1']), ['L2', 'L1']]]) {
  test(`alert scope serializes ${JSON.stringify(expected)} with dismissal IDs`, async t => {
    const { Compute, workers } = await transport(t);
    const result = Compute.alerts({ lines: scope }, new Set(['dismissed']));
    assert.deepEqual(workers[0].sent[0].payload.opts.lines, expected);
    assert.deepEqual(workers[0].sent[0].payload.dismissed, ['dismissed']);
    workers[0].reply(0, { alerts: [] });
    await result;
  });
}

test('selected plant scopes tasks, calendars, line settings and blackouts together', async t => {
  const { Compute, workers } = await transport(t);
  Store.setMasterData({ plants: [{ plant: 'P1', timezone: 'UTC' }, { plant: 'P2', timezone: 'UTC' }], lines: [
    { machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P2' },
  ] }, 'test');
  Store.setTasks([
    { id: 'a', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1, PRODUCTION_VERSION: 'PV', PRT_01: 'TOOL' },
    { id: 'b', PLANT: 'P2', MACHINE: 'L2', RUN_TIME: 1 },
  ], 'test');
  Store.replaceCalendars({ L1: { workHours: {} }, L2: { workHours: {} } }, 'test');
  Store.setLineSetting('L1', { color: 'red' }, 'test');
  Store.setLineSetting('L2', { color: 'blue' }, 'test');
  const periodP1 = { id: 'per1', name: 'Winter', validFrom: '2026-10-20', validTo: null, workHours: { 1: [6, 14] } };
  Store.replacePlants({ P1: { workHours: {}, periods: [periodP1] }, P2: { workHours: {}, periods: [{ ...periodP1, id: 'per2' }] } }, 'test');
  Store.replaceBlocks([
    { id: 'local', plant: 'P1', line: 'L1' }, { id: 'other', plant: 'P2', line: 'L2' },
    { id: 'plant-wide', plant: 'P1', line: null },
  ], 'test');
  Store.replacePlantBlocks([{ id: 'p1', plant: 'P1' }, { id: 'p2', plant: 'P2' }], 'test');
  Store.setSelectedPlant('P1', 'test');
  const result = Compute.alerts();
  const payload = workers[0].sent[0].payload;
  assert.deepEqual(payload.tasks.map(task => task.id), ['a']);
  assert.deepEqual(Object.keys(payload.calendars), ['L1']);
  assert.deepEqual(Object.keys(payload.lineSettings), ['L1']);
  assert.deepEqual(Object.keys(payload.plants), ['P1']);
  assert.deepEqual(payload.plants.P1.periods, [periodP1], 'dated periods ride along with the selected plant only');
  assert.equal(JSON.stringify(payload).includes('per2'), false, 'another plant\'s periods stay out of the worker payload');
  assert.deepEqual(payload.blocks.map(block => block.id), ['local', 'plant-wide']);
  assert.deepEqual(payload.plantBlocks.map(block => block.id), ['p1']);
  assert.equal(payload.tasks[0].PRT_01, 'TOOL');
  assert.equal(Object.hasOwn(payload.tasks[0], 'PRODUCTION_VERSION'), false);
  assert.equal(Store.tasks.a.PRODUCTION_VERSION, 'PV');
  workers[0].reply(0, { alerts: [] });
  await result;
});

test('request snapshot remains detached from edits made while computation is in flight', async t => {
  const { Compute, workers } = await transport(t);
  Store.setTasks([{ id: 'a', MACHINE: 'L1', RUN_TIME: 1, PRT_01: 'OLD' }], 'test');
  const result = Compute.utilization(123456, 3);
  Store.tasks.a.PRT_01 = 'NEW';
  assert.equal(workers[0].sent[0].payload.tasks[0].PRT_01, 'OLD');
  assert.equal(workers[0].sent[0].payload.startMs, 123456);
  assert.equal(workers[0].sent[0].payload.days, 3);
  workers[0].reply(0, { matrix: {} });
  await result;
});

// ---- Dedicated leverage worker (workload relief B) ----
const levBase = mod => ({ ...mod.buildPlantSnapshot(null), dismissed: [], opts: { lines: null }, startMs: 0, days: 1 });

test('a leverage batch gets its own worker, replies by its own id and terminates the worker', async t => {
  const { Compute, workers, mod } = await transport(t);
  const p = Compute.leverageBatch(levBase(mod), []);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].sent[0].type, 'LEVERAGE_BATCH');
  assert.match(workers[0].url, /nimbus-worker\.js\?v=/);
  workers[0].onmessage({ data: { id: workers[0].sent[0].id + 99, results: ['wrong'] } });   // someone else's id: ignored
  assert.equal(workers[0].terminated, undefined);
  workers[0].reply(0, { type: 'LEVERAGE_BATCH_RESULT', results: [{ key: 'k' }] });
  assert.deepEqual(await p, [{ key: 'k' }]);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].onmessage, null);
});

test('an ALERTS request posted while a batch is pending goes to the shared worker and resolves', async t => {
  const { Compute, workers, mod } = await transport(t);
  const batch = Compute.leverageBatch(levBase(mod), []);
  const alerts = Compute.alerts();
  assert.equal(workers.length, 2, 'leverage worker plus the shared worker');
  assert.deepEqual(workers[0].sent.map(m => m.type), ['LEVERAGE_BATCH']);
  assert.deepEqual(workers[1].sent.map(m => m.type), ['ALERTS']);
  workers[1].reply(0, { alerts: [], elapsed: 1 });
  await alerts;
  assert.equal(workers[0].terminated, undefined, 'the pending batch is untouched');
  workers[0].reply(0, { type: 'LEVERAGE_BATCH_RESULT', results: [] });
  await batch;
});

test('timeout terminates only the leverage worker, rejects with TimeoutError and never reruns on the main thread', async t => {
  const { Compute, workers, mod } = await transport(t);
  const shared = Compute.alerts();           // creates the shared worker first
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const batch = Compute.leverageBatch(levBase(mod), []);
  const rejection = assert.rejects(batch, { name: 'TimeoutError' });   // a sync fallback would resolve []
  t.mock.timers.tick(31000);
  await rejection;
  assert.equal(workers[1].terminated, true);
  assert.equal(workers[0].terminated, undefined, 'shared worker survives');
  assert.equal(Compute.available(), true);
  workers[0].reply(0, { alerts: [], elapsed: 1 });
  await shared;
  const again = Compute.alerts();
  assert.equal(workers.length, 2, 'no new shared worker: the shared worker slot was never touched');
  workers[0].reply(1, { alerts: [] });
  await again;
  assert.equal(workers[1].onmessage, null, 'detached handler: a late reply from the terminated worker is a no-op');
});

test('an abort signal terminates the leverage worker and rejects with AbortError', async t => {
  const { Compute, workers, mod } = await transport(t);
  const ctl = new AbortController();
  const p = Compute.leverageBatch(levBase(mod), [], { signal: ctl.signal });
  const rejection = assert.rejects(p, { name: 'AbortError' });
  ctl.abort();
  await rejection;
  assert.equal(workers[0].terminated, true);
  assert.equal(Compute.available(), true);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(Compute.leverageBatch(levBase(mod), [], { signal: pre.signal }), { name: 'AbortError' });
  assert.equal(workers.length, 1, 'an already-aborted signal never spawns a worker');
});

test('a leverage worker crash falls back to the synchronous core once and leaves the shared counters alone', async t => {
  const { Compute, workers, mod } = await transport(t);
  const p = Compute.leverageBatch(levBase(mod), []);
  workers[0].crash();
  assert.deepEqual(await p, [], 'sync core ran (empty variant list)');
  assert.equal(workers[0].terminated, true);
  assert.equal(Compute.available(), true, 'a leverage crash is not a shared-worker crash');
  const a = Compute.alerts();
  assert.equal(workers.length, 2);
  workers[1].reply(0, { alerts: [] });
  await a;
});

test('an ERROR reply is logged, terminates the worker and falls back to the synchronous core', async t => {
  const { Compute, workers, mod } = await transport(t);
  const p = Compute.leverageBatch(levBase(mod), []);
  workers[0].reply(0, { type: 'ERROR', error: 'boom', failingType: 'LEVERAGE_BATCH', stack: 's' });
  assert.deepEqual(await p, []);
  assert.equal(workers[0].terminated, true);
  assert.equal(ErrorLog.error.mock.calls.length, 1);
});

test('a malformed reply rejects the worker path (then the sync core) instead of resolving garbage', async t => {
  const { Compute, workers, mod } = await transport(t);
  const p = Compute.leverageBatch(levBase(mod), [{ key: 'x', setup: { intervals: [], diagnostics: [] } }]);
  workers[0].reply(0, { type: 'LEVERAGE_BATCH_RESULT' });   // no results array
  const out = await p;
  assert.equal(workers[0].terminated, true);
  assert.equal(out[0].key, 'x', 'sync core produced the result');
});

test('a postMessage throw terminates the worker and falls back to the synchronous core', async t => {
  const { Compute, workers, mod } = await transport(t);
  globalThis.Worker.prototype.postMessage = function () { this.terminated = this.terminated; throw new DOMException('uncloneable', 'DataCloneError'); };
  const p = Compute.leverageBatch(levBase(mod), []);
  assert.deepEqual(await p, []);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true, 'no leaked worker');
});

test('after a successful reply neither the timer nor a later abort has any effect', async t => {
  const { Compute, workers, mod } = await transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctl = new AbortController();
  const p = Compute.leverageBatch(levBase(mod), [], { signal: ctl.signal });
  workers[0].reply(0, { type: 'LEVERAGE_BATCH_RESULT', results: [{ key: 'ok' }] });
  assert.deepEqual(await p, [{ key: 'ok' }]);
  t.mock.timers.tick(31000);
  ctl.abort();
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 1);
});

test('a reply arriving after the timeout is ignored', async t => {
  const { Compute, workers, mod } = await transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = Compute.leverageBatch(levBase(mod), []);
  const rejection = assert.rejects(p, { name: 'TimeoutError' });
  t.mock.timers.tick(31000);
  await rejection;
  assert.equal(workers[0].onmessage, null);
  assert.equal(workers[0].terminated, true);
});

test('two leverage-worker crashes latch the main-thread path; the shared worker state is untouched', async t => {
  const { Compute, workers, mod } = await transport(t);
  for (let i = 0; i < 2; i++) {
    const p = Compute.leverageBatch(levBase(mod), []);
    workers[i].crash();
    assert.deepEqual(await p, []);
  }
  assert.equal(workers.length, 2);
  assert.deepEqual(await Compute.leverageBatch(levBase(mod), []), []);
  assert.equal(workers.length, 2, 'third batch never creates a worker');
  assert.equal(Compute.available(), true);
  const a = Compute.alerts();
  assert.equal(workers.length, 3, 'shared worker still creatable');
  workers[2].reply(0, { alerts: [] });
  await a;
});

test('worker constructor failure and a missing Worker both use the synchronous core', async t => {
  const failing = await transport(t, true);
  assert.deepEqual(await failing.Compute.leverageBatch(levBase(failing.mod), []), []);
  delete globalThis.Worker;
  const none = await transport(t);
  delete globalThis.Worker;
  assert.deepEqual(await none.Compute.leverageBatch(levBase(none.mod), []), []);
  assert.equal(none.workers.length, 0);
});
