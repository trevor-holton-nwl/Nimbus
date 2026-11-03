// P2-1: the optimizer worker session (one pool of reusable workers, runId-multiplexed) and its cancel / stale-core /
// parity guarantees. Fake workers count spawns and terminations; the real worker_threads tests prove a reused worker
// answers every request exactly as a fresh worker (no module-level memo leaks across different snapshots).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOptimizerWorkerSession, runOptimizerPreview } from '../../../frontend/optimization/optimizer-worker-client.mjs';
import { buildOptimizerWorkerResponse } from '../../../frontend/optimization/optimizer-worker.mjs';
import { evaluateSchedule } from '../../../frontend/optimization/engine.mjs';
import { evalRequestOf } from '../../../frontend/optimization/optimizer-worker-contract.mjs';
import { ErrorLog } from '../../../frontend/platform/foundation.mjs';
import * as TF from '../helpers/tool-overflow-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};   // Util.t reads window.__NIMBUS_LOCALES
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const emptySnapshot = { tasks: [], firmedIds: [], alerts: [], selectedPlant: null, blocks: [], plantBlocks: [],
  calendars: {}, plants: {}, lineSettings: {}, masterData: null, priorityRankMaps: {}, readModelVersion: '1' };
const req = (runId, extra = {}) => ({ runId, mode: 'spt', snapshot: emptySnapshot, request: { mode: 'spt', respectCalendar: false }, ...extra });
const cand = id => ({ patches: [], score: [], explanation: [], diagnostics: { candidateCount: 1 }, unchangedLines: [], missingEdges: [], id });
const validation = {
  setup: { plant: 'P', plant_active: true, definition: null, plant_rows: [], machine_rows: [], machine_states: [], overrides: [] },
  exactSearchThreshold: 8, iterationCap: 20, deadline: 900,
  now: '2035-08-06T08:00:00.000Z', planningStart: '2035-08-06T07:00:00.000Z',
  runNow: '2035-08-06T08:00:00.000Z', placementStart: '2035-08-06T08:00:00.000Z',
  horizonEnd: '2035-08-07T08:00:00.000Z', lines: ['L1'], respectCalendar: false,
  notBeforeById: {}, notAfterById: {}, effectiveFirmedIds: [],
};

/** A fake worker pool that records every spawn, post and terminate. */
function fakePool() {
  const workers = [];
  const factory = () => {
    const worker = {
      onmessage: null, onerror: null, onmessageerror: null, terminated: false, posted: [],
      postMessage(m) { this.posted.push(m); },
      terminate() { this.terminated = true; },
      // What the realm would send back: only a live handler receives it (a terminated worker has none).
      reply(data) { this.onmessage?.({ data }); },
    };
    workers.push(worker);
    return worker;
  };
  return { workers, factory };
}

test('session: one worker serves several requests in turn and is terminated only at close', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory });
  const first = session.run(req('r1'));
  assert.equal(pool.workers.length, 1);
  pool.workers[0].reply({ runId: 'other', candidate: cand('wrong') });                 // a foreign answer is ignored
  pool.workers[0].reply({ runId: 'r1', candidate: cand('one'), validation });
  assert.equal((await first).id, 'one');
  assert.equal(pool.workers[0].terminated, false, 'the worker stays alive for the next request');
  const second = session.run(req('r2'));
  assert.equal(pool.workers.length, 1, 'the second request reuses the warm worker (no second spawn)');
  assert.deepEqual(pool.workers[0].posted.map(m => m.runId), ['r1', 'r2']);
  pool.workers[0].reply({ runId: 'r2', candidate: cand('two'), validation });
  assert.equal((await second).id, 'two');
  assert.equal(session.stats.spawned, 1);
  session.close();
  assert.equal(pool.workers[0].terminated, true);
  assert.equal(session.stats.terminated, 1);
  session.close();
  assert.equal(session.stats.terminated, 1, 'closing twice terminates nothing twice');
});

test('session: with every worker busy a request waits, then runs on the freed worker (one request per worker)', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 1 });
  const a = session.run(req('a'));
  const b = session.run(req('b'));
  assert.deepEqual(pool.workers[0].posted.map(m => m.runId), ['a'], 'b is not posted while a runs');
  pool.workers[0].reply({ runId: 'a', candidate: cand('A'), validation });
  assert.equal((await a).id, 'A');
  assert.deepEqual(pool.workers[0].posted.map(m => m.runId), ['a', 'b'], 'b goes out as soon as the worker is free');
  pool.workers[0].reply({ runId: 'b', candidate: cand('B'), validation });
  assert.equal((await b).id, 'B');
  assert.equal(pool.workers.length, 1);
  session.close();
});

test('session: two requests under maxWorkers 2 are BOTH posted before either resolves, on two workers', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 2 });
  const a = session.run(req('a'), { kpiOnly: true });
  const b = session.run(req('b'), { kpiOnly: true });
  assert.equal(pool.workers.length, 2);
  assert.deepEqual(pool.workers.map(w => w.posted.length), [1, 1], 'each worker already holds its request');
  assert.ok(pool.workers.every(w => w.posted[0].kpiOnly === true), 'the kpiOnly flag rides on the request');
  const c = session.run(req('c'));
  assert.equal(pool.workers.length, 2, 'the cap holds: a third request waits');
  pool.workers[1].reply({ runId: 'b', candidate: cand('B') });                      // kpiOnly: no validation needed
  assert.equal((await b).id, 'B', 'a kpiOnly answer resolves without a validation seam');
  assert.equal(pool.workers[1].posted.at(-1).runId, 'c', 'the freed worker takes the waiting request');
  pool.workers[0].reply({ runId: 'a', candidate: cand('A') });
  assert.equal((await a).id, 'A');
  pool.workers[1].reply({ runId: 'c', candidate: cand('C'), validation });
  assert.equal((await c).id, 'C');
  session.close();
  assert.equal(session.stats.spawned, 2);
  assert.equal(session.stats.terminated, 2);
});

test('session abort: a request signal terminates its running worker, rejects, and a late answer is never applied', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 2 });
  const controller = new AbortController();
  const aborted = session.run(req('x'), { signal: controller.signal });
  const other = session.run(req('y'));
  const lateHandler = pool.workers[0].onmessage;
  controller.abort();
  await assert.rejects(aborted, e => e?.name === 'AbortError');
  assert.equal(pool.workers[0].terminated, true);
  assert.equal(pool.workers[1].terminated, false, 'the other request keeps its worker');
  lateHandler?.({ data: { runId: 'x', candidate: cand('late'), validation } });       // would resolve if it were still wired
  assert.equal(pool.workers[0].onmessage, null);
  pool.workers[1].reply({ runId: 'y', candidate: cand('Y'), validation });
  assert.equal((await other).id, 'Y');
  session.close();
  assert.ok(pool.workers.every(w => w.terminated));
});

test('session abort: the session signal terminates EVERY worker and rejects running and waiting requests (no leak)', async () => {
  const pool = fakePool();
  const controller = new AbortController();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 2, signal: controller.signal });
  const runs = [session.run(req('a')), session.run(req('b')), session.run(req('c'))];   // c waits
  const settled = Promise.allSettled(runs);
  assert.equal(pool.workers.length, 2);
  controller.abort();
  const results = await settled;
  assert.ok(results.every(r => r.status === 'rejected' && r.reason?.name === 'AbortError'), 'all three reject with AbortError');
  assert.ok(pool.workers.every(w => w.terminated), 'every spawned worker is terminated');
  assert.equal(session.stats.spawned, session.stats.terminated, 'spawns equal terminations: nothing leaked');
  assert.equal(pool.workers.length, 2, 'the waiting request never spawned a worker after the abort');
  assert.ok(pool.workers.every(w => w.onmessage === null));
  await assert.rejects(Promise.resolve(session.run(req('late'))), e => e?.name === 'AbortError', 'a closed session refuses new work');
});

test('session abort: aborting a request that is still waiting only removes it', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 1 });
  const controller = new AbortController();
  const first = session.run(req('a'));
  const waiting = session.run(req('b'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, e => e?.name === 'AbortError');
  assert.equal(pool.workers[0].terminated, false, 'the running request is untouched');
  assert.deepEqual(pool.workers[0].posted.map(m => m.runId), ['a']);
  pool.workers[0].reply({ runId: 'a', candidate: cand('A'), validation });
  assert.equal((await first).id, 'A');
  assert.deepEqual(pool.workers[0].posted.map(m => m.runId), ['a'], 'the aborted request is never posted');
  session.close();
});

test('session: a pre-aborted signal rejects before any spawn', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(Promise.resolve(session.run(req('z'), { signal: controller.signal })), e => e?.name === 'AbortError');
  assert.equal(pool.workers.length, 0);
  session.close();
});

test('session stale core: the first stale answer falls back to the main thread, retires the workers, and later runs skip workers', async () => {
  const priorWarn = ErrorLog.warn;
  ErrorLog.warn = () => {};
  try {
    const pool = fakePool();
    const sync = [];
    const session = createOptimizerWorkerSession({
      workerFactory: pool.factory, maxWorkers: 2,
      syncEvaluator: (_s, r) => { sync.push(r.mode); return cand(`sync-${sync.length}`); },
    });
    const a = session.run(req('a'));
    const b = session.run(req('b'));
    pool.workers[0].reply({ runId: 'a', error: 'compute-core-stale' });
    assert.equal((await a).id, 'sync-1', 'the stale request is answered on the main thread');
    assert.equal(pool.workers[0].terminated, true);
    assert.equal(session.workerBacked, false, 'the session stops using workers');
    pool.workers[1].reply({ runId: 'b', error: 'compute-core-stale' });
    assert.equal((await b).id, 'sync-2', 'the in-flight sibling is answered by its own stale reply');
    assert.equal(pool.workers[1].terminated, true);
    const next = session.run(req('c'));
    assert.equal(next.id, 'sync-3', 'later runs evaluate synchronously and spawn nothing');
    assert.equal(pool.workers.length, 2);
    await assert.rejects(Promise.resolve(session.run(req('d', { request: { mode: 'spt', exhaustive: true, respectCalendar: false } }))),
      e => e?.name === 'OptimizerCoreStale', 'an exhaustive run never falls back to the main thread');
    session.close();
    assert.equal(session.stats.spawned, session.stats.terminated);
  } finally {
    ErrorLog.warn = priorWarn;
  }
});

test('session: no worker (null factory result) answers synchronously in the same tick; a throwing factory follows the long-run rule', async () => {
  const priorWarn = ErrorLog.warn;
  ErrorLog.warn = () => {};
  try {
    const nullSession = createOptimizerWorkerSession({ workerFactory: () => null, syncEvaluator: () => cand('sync') });
    assert.equal(nullSession.run(req('n')).id, 'sync');
    assert.equal(nullSession.workerBacked, false);
    const throwing = createOptimizerWorkerSession({
      workerFactory: () => { throw new Error('blocked'); }, syncEvaluator: () => cand('sync-after-throw'),
    });
    assert.equal(throwing.run(req('t')).id, 'sync-after-throw');
    await assert.rejects(Promise.resolve(throwing.run(req('long', { request: { mode: 'spt', exhaustive: true, respectCalendar: false } }))), /blocked/);
  } finally {
    ErrorLog.warn = priorWarn;
  }
});

test('session: prewarm boots idle workers up to the cap, a request takes one of them, and close terminates them all', async () => {
  const pool = fakePool();
  const session = createOptimizerWorkerSession({ workerFactory: pool.factory, maxWorkers: 2 });
  session.prewarm(5);
  assert.equal(pool.workers.length, 2, 'capped at maxWorkers');
  const run = session.run(req('a'));
  assert.equal(pool.workers.length, 2, 'the request uses a pre-warmed worker');
  pool.workers[0].reply({ runId: 'a', candidate: cand('A'), validation });
  await run;
  session.close();
  assert.ok(pool.workers.every(w => w.terminated));
});

// ── real worker_threads: a reused worker answers exactly like a fresh one ───────────────────────────────────────────
const workerUrl = pathToFileURL(resolve('frontend/optimization/optimizer-worker.mjs')).href;
const corePath = resolve('frontend/nimbus-compute-core.js');
const bridge = `
  import { parentPort } from 'node:worker_threads';
  import { createRequire } from 'node:module';
  globalThis.postMessage = value => parentPort.postMessage(value);
  Object.defineProperty(globalThis, 'onmessage', { configurable: true, set(handler) { parentPort.on('message', data => handler({ data })); } });
  globalThis.NimbusComputeCore = createRequire(${JSON.stringify(corePath)})(${JSON.stringify(corePath)});
  await import(${JSON.stringify(workerUrl)});
`;
const spawned = [];
function nodeWorkerFactory() {
  const worker = new Worker(bridge, { eval: true, type: 'module' });
  const like = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage: m => worker.postMessage(m),
    terminate: () => worker.terminate(),
  };
  worker.on('message', data => like.onmessage?.({ data }));
  worker.on('error', error => like.onerror?.({ message: error.message }));
  worker.on('messageerror', () => like.onmessageerror?.({}));
  spawned.push(worker);
  return like;
}

/** Same order ids and lines in every variant, different data: a memo keyed by id, line or tool would leak. */
function variant(name) {
  if (name === 'v1') {
    return TF.toolSnapshot([
      { id: 'A', line: 'L1', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
      { id: 'B', line: 'L2', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
      { id: 'Q', line: 'L3', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
      { id: 'M1', line: 'L4', run: 4, tools: ['T2'], due: '2035-08-08T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
      { id: 'M2', line: 'L5', run: 4, tools: ['T2'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    ], { inventory: [{ tool_id: 'T1', total_qty: 1 }, { tool_id: 'T2', total_qty: 1 }], rule: 'hard', plantExtra: { max_push_forward_days: 0 } });
  }
  if (name === 'v2') {
    return TF.toolSnapshot([
      { id: 'A', line: 'L1', run: 6, tools: ['T2'], due: '2035-08-07T12:00:00' },
      { id: 'B', line: 'L2', run: 14, tools: ['T1'], due: '2035-08-06T12:00:00' },
      { id: 'Q', line: 'L3', run: 3, tools: ['T1', 'T2'], due: '2035-08-09T18:00:00' },
      { id: 'M1', line: 'L4', run: 8, tools: ['T1'], due: '2035-08-08T08:00:00', start: '2035-08-06T12:00:00', end: '2035-08-06T20:00:00' },
      { id: 'M2', line: 'L5', run: 2, tools: ['T2'], due: '2035-08-09T08:00:00' },
    ], { inventory: [{ tool_id: 'T1', total_qty: 2 }, { tool_id: 'T2', total_qty: 1 }], rule: 'hard', plantExtra: { max_push_forward_days: 2 } });
  }
  return TF.toolSnapshot([   // v3: the same ids with the rule Off
    { id: 'A', line: 'L1', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
    { id: 'B', line: 'L2', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
    { id: 'Q', line: 'L3', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
    { id: 'M1', line: 'L4', run: 4, tools: ['T2'], due: '2035-08-08T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'M2', line: 'L5', run: 4, tools: ['T2'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }, { tool_id: 'T2', total_qty: 1 }], rule: 'off', plantExtra: { max_push_forward_days: 0 } });
}
const workerReq = (name, mode, runId) => ({
  runId, mode, snapshot: variant(name), deadlineDurationMs: 600000,
  request: { ...TF.toolRequest(), mode },
});
/** Everything a planner can see of a candidate except wall-clock facts. */
const canon = c => JSON.stringify({
  patches: [...c.patches].sort((a, b) => (a.id < b.id ? -1 : 1)).map(p => ({ id: p.id, c: JSON.parse(JSON.stringify(p.changes)) })),
  dispositions: [...(c.dispositions ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
  score: c.score, status: c.status, searchComplete: c.searchComplete,
  toolBlocked: c.toolBlocked, toolMoved: c.toolMoved, toolComplete: c.toolPass?.complete,
  findings: (c.validationFindings ?? []).map(f => `${f.severity}|${f.code}|${f.taskId}`).sort(),
});
const direct = (name, mode) => {
  const r = workerReq(name, mode, 'direct');
  return evaluateSchedule(r.snapshot, evalRequestOf({ ...r, request: { ...r.request, deadlineAt: performance.now() + 600000 } }));
};

test('real workers: a reused worker answers every request like a fresh worker and like the main thread (no memo leaks across snapshots)', async () => {
  const sequence = [['v1', 'changeover'], ['v2', 'changeover'], ['v3', 'spt'], ['v2', 'duedate'], ['v1', 'changeover'], ['v3', 'changeover']];
  const session = createOptimizerWorkerSession({ workerFactory: nodeWorkerFactory, maxWorkers: 1 });
  const before = spawned.length;
  try {
    for (const [i, [name, mode]] of sequence.entries()) {
      const reused = await session.run(workerReq(name, mode, `reuse-${i}`));
      const fresh = await runOptimizerPreview(workerReq(name, mode, `fresh-${i}`), { workerFactory: nodeWorkerFactory });
      assert.equal(canon(reused), canon(fresh), `step ${i} (${name}/${mode}): reused worker == fresh worker`);
      assert.equal(canon(reused), canon(direct(name, mode)), `step ${i} (${name}/${mode}): worker == main thread`);
      assert.ok(reused.validationContext, 'a full request is rehydrated with its validation seam');
    }
    assert.equal(spawned.length - before, 1 + sequence.length, 'one session worker plus one fresh worker per comparison');
    assert.equal(session.stats.spawned, 1, 'the session itself spawned exactly one worker for six requests');
  } finally {
    session.close();
  }
});

test('real workers: a kpiOnly answer carries the same patches as the full answer, without a validation seam', async () => {
  const session = createOptimizerWorkerSession({ workerFactory: nodeWorkerFactory, maxWorkers: 2 });
  try {
    const [full, kpi] = await Promise.all([
      session.run(workerReq('v1', 'changeover', 'full')),
      session.run(workerReq('v1', 'changeover', 'kpi'), { kpiOnly: true }),
    ]);
    assert.equal(session.stats.spawned, 2, 'both ran at once on two workers');
    assert.equal(canon({ ...kpi, validationFindings: undefined }), canon({ ...full, validationFindings: undefined }), 'same patches, dispositions and score');
    assert.equal(kpi.validationContext, undefined, 'no validation seam for an alternate');
    // The full response is a superset: the kpiOnly worker response simply lacks `validation`.
    const raw = buildOptimizerWorkerResponse({ ...workerReq('v1', 'changeover', 'raw'), kpiOnly: true, deadlineDurationMs: 600000 });
    assert.equal(raw.validation, undefined);
    assert.ok(raw.candidate.patches.length >= 0);
  } finally {
    session.close();
  }
});

test('real workers: aborting a running search terminates it promptly and leaves no worker alive', async () => {
  const session = createOptimizerWorkerSession({ workerFactory: nodeWorkerFactory, maxWorkers: 2 });
  const controller = new AbortController();
  const heavy = { ...workerReq('v1', 'changeover', 'abort-me'), deadlineDurationMs: 600000 };
  const running = session.run(heavy, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, e => e?.name === 'AbortError');
  session.close();
  assert.equal(session.stats.spawned, session.stats.terminated);
});
