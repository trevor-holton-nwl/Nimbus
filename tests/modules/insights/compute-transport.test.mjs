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
  const { Compute } = await import(`../../../frontend/insights/services.mjs?transport=${++moduleId}`);
  return { Compute, workers };
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
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [
    { machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P2' },
  ] }, 'test');
  Store.setTasks([
    { id: 'a', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1, PRODUCTION_VERSION: 'PV', PRT_01: 'TOOL' },
    { id: 'b', PLANT: 'P2', MACHINE: 'L2', RUN_TIME: 1 },
  ], 'test');
  Store.replaceCalendars({ L1: { workHours: {} }, L2: { workHours: {} } }, 'test');
  Store.setLineSetting('L1', { color: 'red' }, 'test');
  Store.setLineSetting('L2', { color: 'blue' }, 'test');
  Store.replacePlants({ P1: { workHours: {} }, P2: { workHours: {} } }, 'test');
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
