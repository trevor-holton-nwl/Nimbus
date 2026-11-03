// A5/A3: the shared Compute worker client. Latest-wins coalescing of ALERTS jobs (one in flight, one waiting
// slot, payload built lazily), a line-scoped setup derivation, the dataRev-keyed snapshot memo shared by the alerts
// and utilization paths, the per-job ALERTS timeout, and postMessage-throw / unknown-message handling.
// Only the browser Worker boundary is replaced; snapshot construction and dispatch are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../../../frontend/platform/store.mjs';
import { ErrorLog, Util } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
let moduleId = 0;

async function transport(t) {
  const workers = [];
  t.mock.method(ErrorLog, 'warn', () => {});
  t.mock.method(ErrorLog, 'error', () => {});
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({}) }));
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class {
    constructor() { this.sent = []; workers.push(this); }
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
  Store.replaceSetupSnapshot(null, 'test');
  const mod = await import(`../../../frontend/insights/services.mjs?coalesce=${++moduleId}`);
  return { Compute: mod.Compute, workers, mod };
}

const types = w => w.sent.map(m => m.type);

test('a burst of ALERTS requests posts one job, then only the newest waiting request; superseded jobs are never computed', async t => {
  const { Compute, workers } = await transport(t);
  const first = Compute.alerts();
  const second = Compute.alerts();
  const third = Compute.alerts();
  const fourth = Compute.alerts();
  assert.deepEqual(types(workers[0]), ['ALERTS'], 'only the first request is posted while it is in flight');
  const superseded = [second, third].map(p => assert.rejects(p, { name: 'ComputeSuperseded' }));
  workers[0].reply(0, { alerts: ['a'], elapsed: 1 });
  assert.deepEqual(types(workers[0]), ['ALERTS', 'ALERTS'], 'the waiting slot is sent when the first job returns');
  assert.deepEqual((await first).alerts, ['a']);
  workers[0].reply(1, { alerts: ['d'], elapsed: 2 });
  assert.deepEqual((await fourth).alerts, ['d']);
  await Promise.all(superseded);
  assert.equal(workers[0].sent.length, 2, 'the two superseded requests were never posted, so never computed');
});

test('ALERTS and UTILIZATION do not block each other and the slot keeps ordering', async t => {
  const { Compute, workers } = await transport(t);
  const a1 = Compute.alerts();
  const u = Compute.utilization(0, 1);
  const a2 = Compute.alerts();
  assert.deepEqual(types(workers[0]), ['ALERTS', 'UTILIZATION']);
  workers[0].reply(1, { matrix: {} });
  await u;
  assert.equal(workers[0].sent.length, 2, 'a utilization reply does not release the alerts slot');
  workers[0].reply(0, { alerts: [] });
  await a1;
  assert.deepEqual(types(workers[0]), ['ALERTS', 'UTILIZATION', 'ALERTS']);
  workers[0].reply(2, { alerts: [] });
  await a2;
});

test('the waiting slot builds its payload when sent, from the then-current Store', async t => {
  const { Compute, workers } = await transport(t);
  const first = Compute.alerts();
  const second = Compute.alerts();
  Store.setTasks([{ id: 'late', MACHINE: 'L1', RUN_TIME: 1 }], 'test');
  assert.equal(workers[0].sent.length, 1);
  workers[0].reply(0, { alerts: [] });
  await first;
  assert.deepEqual(workers[0].sent[1].payload.tasks.map(x => x.id), ['late']);
  workers[0].reply(1, { alerts: [] });
  await second;
});

test('folded line-scoped requests are computed once for the merged scope and the reply names it', async t => {
  const { Compute, workers } = await transport(t);
  const full = Compute.alerts();
  const a = Compute.alerts({ lines: new Set(['L1']) });
  const b = Compute.alerts({ lines: new Set(['L2']) });
  const rejected = assert.rejects(a, { name: 'ComputeSuperseded' });
  workers[0].reply(0, { alerts: [] });
  await full;
  assert.deepEqual(workers[0].sent[1].payload.opts.lines.sort(), ['L1', 'L2']);
  workers[0].reply(1, { alerts: [{ id: 'x' }], elapsed: 3 });
  const out = await b;
  assert.deepEqual(out.lines.sort(), ['L1', 'L2'], 'reply carries the scope that was computed');
  assert.deepEqual(out.alerts, [{ id: 'x' }]);
  await rejected;
});

test('a full request folded with a scoped one makes the slot a full recompute', async t => {
  const { Compute, workers } = await transport(t);
  const busy = Compute.alerts();
  const scoped = Compute.alerts({ lines: new Set(['L1']) });
  const full = Compute.alerts();
  const rejected = assert.rejects(scoped, { name: 'ComputeSuperseded' });
  workers[0].reply(0, { alerts: [] });
  await busy;
  assert.equal(workers[0].sent[1].payload.opts.lines, null);
  workers[0].reply(1, { alerts: [] });
  const out = await full;
  assert.equal(out.lines, null);
  await rejected;
});

test('when the folded job fails every folded caller gets the error, so each recomputes on its own', async t => {
  const { Compute, workers } = await transport(t);
  const busy = Compute.alerts();
  const a = Compute.alerts({ lines: new Set(['L1']) });
  const b = Compute.alerts({ lines: new Set(['L2']) });
  const rejections = [a, b].map(p => assert.rejects(p, /boom/));
  workers[0].reply(0, { alerts: [] });
  await busy;
  workers[0].reply(1, { type: 'ERROR', error: 'boom', failingType: 'ALERTS' });
  await Promise.all(rejections);
  const next = Compute.alerts();
  assert.equal(workers[0].sent.length, 3, 'the queue is free again after a failure');
  workers[0].reply(2, { alerts: [] });
  await next;
});

test('a crash rejects the in-flight job and sends the waiting slot to a fresh worker', async t => {
  const { Compute, workers } = await transport(t);
  const busy = assert.rejects(Compute.alerts(), /worker error/);
  const waiting = Compute.alerts({ lines: new Set(['L1']) });
  workers[0].crash();
  await busy;
  assert.equal(workers.length, 2);
  assert.equal(workers[1].sent[0].payload.opts.lines[0], 'L1');
  workers[1].reply(0, { alerts: ['r'] });
  assert.deepEqual((await waiting).alerts, ['r']);
});

test('a line-scoped recompute scopes the derived setup observation but still ships every task', async t => {
  const { Compute, workers } = await transport(t);
  const day = new Date(); day.setDate(day.getDate() + 1); day.setHours(8, 0, 0, 0);
  const at = h => new Date(+day + h * 3600000);
  Store.setMasterData({ plants: [{ plant: 'P', timezone: 'UTC' }], lines: [
    { plant: 'P', machine: 'L1' }, { plant: 'P', machine: 'L2' },
  ] }, 'test');
  const mk = (id, line, color, s, e) => ({ id, MACHINE: line, PLANT: 'P', plant: 'P', COLOR: color, RUN_TIME: e - s,
    planning_status: 'scheduled', start_date: at(s), end_date: at(e) });
  Store.setTasks([mk('a', 'L1', 'R', 0, 2), mk('b', 'L1', 'B', 2, 4), mk('c', 'L2', 'R', 0, 2), mk('d', 'L2', 'B', 2, 4)], 'test');
  Store.setSelectedPlant('P', 'test');
  Store.replaceSetupSnapshot({
    plant: 'P', definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: false, active: true },
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [], plant_active: true,
  }, 'test');
  const linesOf = o => [...new Set([...o.intervals.map(i => i.line), ...o.diagnostics.map(d => d.line)])].sort();
  const full = Compute.alerts();
  const fullSetup = workers[0].sent[0].payload.setup;
  workers[0].reply(0, { alerts: [] });
  await full;
  const scoped = Compute.alerts({ lines: new Set(['L1']) });
  const scopedPayload = workers[0].sent[1].payload;
  workers[0].reply(1, { alerts: [] });
  await scoped;
  assert.ok(linesOf(fullSetup).includes('L2'), 'the fixture produces setup findings on both lines');
  assert.deepEqual(linesOf(scopedPayload.setup), ['L1'], 'setup derivation is scoped to the recomputed lines');
  assert.deepEqual(scopedPayload.tasks.map(x => x.id).sort(), ['a', 'b', 'c', 'd'], 'no task is dropped (tool conflicts cross lines)');
});

test('alerts and utilization at one dataRev share one snapshot build; a data change rebuilds it', async t => {
  const { Compute, workers, mod } = await transport(t);
  Store.setMasterData({ plants: [{ plant: 'P', timezone: 'UTC' }], lines: [{ plant: 'P', machine: 'L1' }] }, 'test');
  Store.setTasks([{ id: 'a', MACHINE: 'L1', PLANT: 'P', RUN_TIME: 1 }], 'test');
  Store.setSelectedPlant('P', 'test');
  mod._snapshotMemoClear();
  const before = mod._snapshotMemoStats();
  const a = Compute.alerts();
  const u = Compute.utilization(0, 1);
  const a2 = Compute.alerts({ lines: new Set(['L1']) });
  workers[0].reply(0, { alerts: [] });
  await a;
  workers[0].reply(2, { alerts: [] });
  workers[0].reply(1, { matrix: {} });
  await Promise.all([u, a2]);
  const after = mod._snapshotMemoStats();
  assert.equal(after.builds - before.builds, 1, 'three requests at one dataRev: one snapshot build');
  assert.equal(after.hits - before.hits, 2);
  Store.setTasks([{ id: 'a', MACHINE: 'L1', PLANT: 'P', RUN_TIME: 2 }], 'test');
  const a3 = Compute.alerts();
  assert.equal(mod._snapshotMemoStats().builds - after.builds, 1, 'a Store data change invalidates the memo');
  workers[0].reply(3, { alerts: [] });
  await a3;
  assert.equal(workers[0].sent[3].payload.tasks[0].RUN_TIME, 2);
});

test('a memoized payload is identical to a fresh build', async t => {
  const { Compute, workers, mod } = await transport(t);
  Store.setMasterData({ plants: [{ plant: 'P', timezone: 'UTC' }], lines: [{ plant: 'P', machine: 'L1' }] }, 'test');
  Store.setTasks([{ id: 'a', MACHINE: 'L1', PLANT: 'P', RUN_TIME: 1, PRODUCTION_VERSION: 'PV' }], 'test');
  Store.setSelectedPlant('P', 'test');
  mod._snapshotMemoClear();
  const first = Compute.alerts();
  workers[0].reply(0, { alerts: [] });
  await first;
  const second = Compute.alerts();   // memo hit
  const memo = workers[0].sent[1].payload;
  workers[0].reply(1, { alerts: [] });
  await second;
  const fresh = mod.buildPlantSnapshot('P');
  for (const k of ['tasks', 'blocks', 'plantBlocks', 'calendars', 'plants', 'lineSettings', 'masterData', 'setup']) {
    assert.deepEqual(memo[k], fresh[k], k);
  }
  assert.equal('PRODUCTION_VERSION' in memo.tasks[0], false);
});

test('an ALERTS job that never answers times out: reject, terminate, fresh worker, no crash counted', async t => {
  const { Compute, workers } = await transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = assert.rejects(Compute.alerts(), { name: 'ComputeTimeout' });
  const util = assert.rejects(Compute.utilization(0, 1), /worker restarted/);
  const waiting = Compute.alerts({ lines: new Set(['L1']) });
  t.mock.timers.tick(19999);
  assert.equal(workers.length, 1);
  t.mock.timers.tick(1);
  await stuck;
  await util;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].onmessage, null, 'a late reply from the discarded worker can no longer land');
  assert.equal(Compute.available(), true, 'one timeout does not disable the worker');
  assert.equal(workers.length, 2, 'the waiting slot went to a fresh worker');
  assert.equal(workers[1].sent[0].payload.opts.lines[0], 'L1');
  workers[1].reply(0, { alerts: [] });
  await waiting;
  // One crash after a timeout is still only the first crash: the timeout did not count toward _crashCount.
  const c = assert.rejects(Compute.alerts(), /worker error/);
  workers[1].crash();
  await c;
  assert.equal(Compute.available(), true);
});

test('three consecutive timeouts give the worker up; a reply in between resets the count', async t => {
  const { Compute, workers } = await transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const expire = async (p) => { const r = assert.rejects(p, { name: 'ComputeTimeout' }); t.mock.timers.tick(20000); await r; };
  await expire(Compute.alerts());
  await expire(Compute.alerts());
  const ok = Compute.alerts();
  workers[2].reply(0, { alerts: [] });
  await ok;
  await expire(Compute.alerts());
  await expire(Compute.alerts());
  assert.equal(Compute.available(), true, 'two in a row after a reply is below the limit');
  await expire(Compute.alerts());
  assert.equal(Compute.available(), false);
  await assert.rejects(Compute.alerts(), /worker unavailable/);
});

test('a reply before the deadline clears the timer', async t => {
  const { Compute, workers } = await transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = Compute.alerts();
  workers[0].reply(0, { alerts: [] });
  await p;
  t.mock.timers.tick(60000);
  assert.equal(workers[0].terminated, undefined);
  assert.equal(Compute.available(), true);
});

test('a throwing postMessage frees the alerts queue so the next request is posted', async t => {
  const { Compute, workers } = await transport(t);
  const first = Compute.alerts();
  workers[0].reply(0, { alerts: [] });
  await first;
  workers[0].postMessage = () => { throw new DOMException('uncloneable', 'DataCloneError'); };
  await assert.rejects(Compute.alerts(), { name: 'DataCloneError' });
  delete workers[0].postMessage;
  const again = Compute.alerts();
  assert.equal(workers[0].sent.length, 2, 'not stuck behind a phantom in-flight job');
  workers[0].reply(1, { alerts: [] });
  await again;
});

test('a null worker message is ignored', async t => {
  const { Compute, workers } = await transport(t);
  const p = Compute.alerts();
  workers[0].onmessage({ data: null });
  workers[0].reply(0, { alerts: [] });
  await p;
});

test('Alerts.recompute: folded line-scoped requests publish once for the merged scope, with no fallback or duplicates', async t => {
  const { workers, mod } = await transport(t);
  Store.setMasterData({ plants: [{ plant: 'P', timezone: 'UTC' }], lines: [
    { plant: 'P', machine: 'L1' }, { plant: 'P', machine: 'L2' },
  ] }, 'test');
  Store.setSelectedPlant('P', 'test');
  mod.Alerts._allAlerts = null;
  Store.setAlerts([], 'test');
  const alert = (id, line) => ({ id, line, sev: 'warn', type: 'overload', time: new Date(), msg: id });
  mod.Alerts.recompute();
  mod.Alerts.recompute({ lines: new Set(['L1']) });
  mod.Alerts.recompute({ lines: new Set(['L2']) });
  assert.equal(workers[0].sent.length, 1);
  workers[0].reply(0, { alerts: [alert('a1', 'L1'), alert('a2', 'L2')], elapsed: 1 });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(Store.alerts.map(a => a.id).sort(), ['a1', 'a2']);
  assert.equal(workers[0].sent.length, 2);
  workers[0].reply(1, { alerts: [alert('b1', 'L1'), alert('b2', 'L2')], elapsed: 1 });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(Store.alerts.map(a => a.id).sort(), ['b1', 'b2'], 'replaced for both lines, not appended');
  assert.equal(ErrorLog.warn.mock.calls.filter(c => /fell back/.test(String(c.arguments[1]))).length, 0,
    'the superseded request did not trigger a main-thread recompute');
});
