import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOptimizerPreview } from '../../../frontend/optimization/optimizer-worker-client.mjs';
import {
  buildOptimizerWorkerResponse,
  installOptimizerWorkerHandler,
  evaluateOptimizerWorkerRequest,
  localizeOptimizerDeadline,
} from '../../../frontend/optimization/optimizer-worker.mjs';
import {
  rehydrateOptimizerCandidate,
  SETUP_AWARE_NORMAL_BUDGET_MS,
  SETUP_AWARE_EXHAUSTIVE_BUDGET_MS,
} from '../../../frontend/optimization/engine.mjs';
import { validateCandidateForApply } from '../../../frontend/optimization/setup-scheduler.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const snapshot = { tasks: [], firmedIds: [], alerts: [], selectedPlant: null, blocks: [], plantBlocks: [],
  calendars: {}, plants: {}, lineSettings: {}, masterData: null, priorityRankMaps: {}, readModelVersion: '1' };

function candidate(id = 'sync') {
  return { patches: [], score: [], explanation: [], diagnostics: { candidateCount: 1 },
    unchangedLines: [], missingEdges: [], id };
}

const validation = {
  setup: { plant: 'P', plant_active: true, definition: null, plant_rows: [], machine_rows: [], machine_states: [], overrides: [] },
  exactSearchThreshold: 8, iterationCap: 20, deadline: 900,
  now: '2035-08-06T08:00:00.000Z', planningStart: '2035-08-06T07:00:00.000Z',
  runNow: '2035-08-06T08:00:00.000Z', placementStart: '2035-08-06T08:00:00.000Z',
  horizonEnd: '2035-08-07T08:00:00.000Z', lines: ['L1'], respectCalendar: false,
  notBeforeById: {}, notAfterById: {}, effectiveFirmedIds: [],
};

test('a message posted before the compute core load resolves is held, then handled; a failed load answers with an error', async () => {
  const req = (runId) => ({ runId, mode: 'spt', snapshot, request: { mode: 'spt', respectCalendar: false } });
  const settle = () => new Promise(r => setImmediate(r));
  let release;
  const sent = [];
  const realm = { postMessage: (m) => sent.push(m), onmessage: null };
  installOptimizerWorkerHandler(realm, new Promise(r => { release = r; }));
  assert.equal(typeof realm.onmessage, 'function', 'onmessage is assigned synchronously');
  const pending = realm.onmessage({ data: req('early') });
  await settle();
  assert.equal(sent.length, 0, 'nothing is evaluated before the core is ready');
  release();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].runId, 'early', 'the early message is answered once the core resolves');

  const failing = { postMessage: (m) => sent.push(m), onmessage: null };
  installOptimizerWorkerHandler(failing, Promise.reject(new Error('core boom')));
  await failing.onmessage({ data: req('doomed') });
  const err = sent[sent.length - 1];
  assert.equal(err.runId, 'doomed');
  assert.match(err.error, /core boom/);
});

test('the default worker URL carries the build id so the worker can cache-bust the compute core', () => {
  let seen;
  const result = runOptimizerPreview({
    runId: 'url-run', mode: 'spt', snapshot, request: { mode: 'spt', respectCalendar: false },
  }, {
    workerFactory: (url) => { seen = url; return { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; },
  });
  assert.match(seen, /optimizer-worker\.mjs\?v=[^&]+$/);
  result.catch(() => {});
});

test('optimizer preview keeps a synchronous evaluator fallback for non-UI callers', async () => {
  let calls = 0;
  const result = await runOptimizerPreview({
    runId: 'sync-run', mode: 'spt', snapshot,
    request: { mode: 'spt', respectCalendar: false },
  }, {
    workerFactory: null,
    syncEvaluator: (source, request) => {
      calls += 1;
      assert.equal(source, snapshot);
      assert.equal(request.mode, 'spt');
      return candidate();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.id, 'sync');
});

test('optimizer preview evaluates through a worker and ignores unrelated responses', async () => {
  let worker;
  let posted;
  const resultPromise = runOptimizerPreview({
    runId: 'worker-run', mode: 'changeover', snapshot,
    request: { mode: 'changeover', deadlineAt: performance.now() + 1000 },
  }, {
    workerFactory: (url) => {
      assert.match(url, /optimizer-worker\.mjs/);
      worker = {
        onmessage: null, onerror: null, terminated: false,
        postMessage(message) { posted = message; },
        terminate() { this.terminated = true; },
      };
      return worker;
    },
  });
  assert.equal(posted.runId, 'worker-run');
  assert.equal(posted.mode, 'changeover');
  assert.equal(posted.request.deadlineAt, undefined);
  assert.ok(posted.deadlineDurationMs > 0 && posted.deadlineDurationMs <= 1000);
  worker.onmessage({ data: { runId: 'other-run', candidate: candidate('other') } });
  worker.onmessage({ data: { runId: 'worker-run', candidate: candidate('worker'), validation } });
  const result = await resultPromise;
  assert.equal(result.id, 'worker');
  assert.equal(result.validationContext?.bounds.horizonEnd.toISOString(), validation.horizonEnd,
    'worker results rehydrate apply-time validation bounds on the main thread');
  assert.equal(worker.terminated, true, 'the worker is released after a completed preview');
});

test('worker transport sends remaining budget and rejects missing or malformed validation metadata', async () => {
  let worker;
  let posted;
  const deadlineAt = performance.now() + 2500;
  const resultPromise = runOptimizerPreview({
    runId: 'metadata-run', mode: 'changeover', snapshot,
    request: { mode: 'changeover', deadlineAt },
  }, {
    workerFactory: () => {
      worker = {
        onmessage: null, onerror: null,
        postMessage(message) { posted = message; },
        terminate() {},
      };
      return worker;
    },
  });
  assert.equal(posted.request.deadlineAt, undefined,
    'a main-thread monotonic deadline must not be sent as an absolute worker deadline');
  assert.ok(posted.deadlineDurationMs > 0 && posted.deadlineDurationMs <= 2500,
    'worker transport should carry the remaining duration');
  worker.onmessage({ data: { runId: 'metadata-run', candidate: candidate('missing') } });
  await assert.rejects(resultPromise, /validation metadata/);

  let malformedWorker;
  const malformedPromise = runOptimizerPreview({
    runId: 'malformed-run', mode: 'changeover', snapshot,
    request: { mode: 'changeover' },
  }, {
    workerFactory: () => {
      malformedWorker = {
        onmessage: null, onerror: null,
        postMessage() {},
        terminate() {},
      };
      return malformedWorker;
    },
  });
  malformedWorker.onmessage({ data: {
    runId: 'malformed-run', candidate: candidate('malformed'),
    validation: { ...validation, effectiveFirmedIds: 'not-an-array' },
  } });
  await assert.rejects(malformedPromise, /validation metadata/);

  assert.throws(() => rehydrateOptimizerCandidate(candidate('bad-setup'), snapshot, {
    ...validation, setup: { plant: 'P', plant_active: true },
  }), /validation metadata/, 'incomplete setup truth must not cross the worker boundary');
  assert.throws(() => rehydrateOptimizerCandidate(candidate('missing-calendar-flag'), snapshot, {
    ...validation, respectCalendar: undefined,
  }), /validation metadata/, 'worker validation must carry the explicit calendar contract');
});

test('worker transport carries the chosen search budget as the remaining deadline duration', () => {
  const post = (budgetMs, exhaustive) => {
    let posted;
    const pending = runOptimizerPreview({
      runId: `budget-${budgetMs}`, mode: 'spt', snapshot,
      request: { mode: 'spt', deadlineAt: performance.now() + budgetMs, searchBudgetMs: budgetMs, exhaustive },
    }, {
      workerFactory: () => ({ onmessage: null, onerror: null, postMessage(message) { posted = message; }, terminate() {} }),
    });
    pending.catch(() => {});
    return posted;
  };
  const exhaustive = post(SETUP_AWARE_EXHAUSTIVE_BUDGET_MS, true);
  assert.ok(exhaustive.deadlineDurationMs > 175000 && exhaustive.deadlineDurationMs <= 180000,
    'the Exhaustive primary posts its 180 s budget');
  assert.equal(exhaustive.request.searchBudgetMs, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS);
  assert.equal(exhaustive.request.exhaustive, true);
  const normal = post(SETUP_AWARE_NORMAL_BUDGET_MS, false);
  assert.ok(normal.deadlineDurationMs > 3000 && normal.deadlineDurationMs <= 8000, 'a Normal request posts its 8 s budget');
});

test('real optimizer worker boundary localizes its deadline and round-trips effective firming', () => {
  const localized = localizeOptimizerDeadline({
    runId: 'deadline-boundary', mode: 'spt', snapshot,
    request: { mode: 'spt', deadlineAt: 12 }, deadlineDurationMs: 250,
  }, () => 1000);
  assert.equal(localized.request.deadlineAt, 1250,
    'the duration must override a conflicting absolute deadline from another realm');

  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const workerSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    tasks: [
      { id: 'worker-sap', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 1,
        ecc_firmed: true, start_date: new Date('2035-08-10T08:00:00'), end_date: new Date('2035-08-10T09:00:00') },
      { id: 'worker-running', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 2,
        user_scheduled: true, start_date: new Date('2035-08-06T07:00:00'), end_date: new Date('2035-08-06T09:00:00') },
      { id: 'worker-frozen', PLANT: 'P', MACHINE: 'L1', COLOR: 'BLUE', RUN_TIME: 1,
        user_scheduled: true, start_date: new Date('2035-08-06T09:00:00'), end_date: new Date('2035-08-06T10:00:00') },
    ],
    calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
    masterData: { plants: [{ plant: 'P' }], lines: [{ plant: 'P', machine: 'L1' }] },
    setupSnapshot: {
      plant: 'P', plant_active: true,
      definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    },
    frozenHorizonEnd: new Date('2035-08-07T00:00:00'),
  };
  const request = {
    runId: 'worker-boundary', mode: 'changeover', snapshot: workerSnapshot,
    deadlineDurationMs: 2000,
    request: {
      mode: 'changeover', plant: 'P', respectFirmed: true, respectCalendar: false,
      planningStart: new Date('2035-08-06T08:00:00'),
      runNow: new Date('2035-08-06T08:00:00'), endDate: new Date('2035-08-11T00:00:00'),
    },
  };
  const evaluated = evaluateOptimizerWorkerRequest(request, () => 5000);
  assert.ok(evaluated.validationContext, 'the worker evaluator must produce apply metadata');
  const response = buildOptimizerWorkerResponse(request, () => 5000);
  assert.ok(response.validation, 'the real worker response must include validation metadata');
  assert.deepEqual(new Set(response.validation.effectiveFirmedIds), new Set(['worker-running', 'worker-frozen']),
    'running and frozen effective firming must survive worker serialization; SAP firm never folds');

  // Plant-scoped runs send `lines: null` (Optimize dialog default). That must
  // serialize as undefined and rehydrate on the main thread without throwing.
  const plantScoped = { ...request, runId: 'worker-plant-scope', request: { ...request.request, lines: null } };
  const plantResponse = buildOptimizerWorkerResponse(plantScoped, () => 5000);
  assert.equal(plantResponse.validation.lines, undefined,
    'a null lines scope must not cross the worker boundary as null');
  assert.doesNotThrow(() => rehydrateOptimizerCandidate(plantResponse.candidate, workerSnapshot, plantResponse.validation),
    'plant-scoped worker metadata must rehydrate on the main thread');
});

test('worker round-trip carries user_scheduled and holds a window-end straddler (windowEndHeldIds is clone-safe)', () => {
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const workerSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    tasks: [
      { id: 'worker-straddle', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 8, user_scheduled: true,
        planning_status: 'scheduled',
        start_date: new Date('2035-08-10T20:00:00'), end_date: new Date('2035-08-11T04:00:00') },
      { id: 'worker-free', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 2,
        original_end_date: new Date('2035-08-10T12:00:00') },
    ],
    calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
    masterData: { plants: [{ plant: 'P' }], lines: [{ plant: 'P', machine: 'L1' }] },
    setupSnapshot: {
      plant: 'P', plant_active: true,
      definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    },
    frozenHorizonEnd: new Date('2035-08-07T00:00:00'),
  };
  const request = {
    runId: 'worker-straddle', mode: 'changeover', snapshot: workerSnapshot, deadlineDurationMs: 2000,
    request: {
      mode: 'changeover', plant: 'P', respectFirmed: true, respectCalendar: false,
      planningStart: new Date('2035-08-06T08:00:00'), runNow: new Date('2035-08-06T08:00:00'),
      endDate: new Date('2035-08-11T00:00:00'),
    },
  };
  const response = buildOptimizerWorkerResponse(structuredClone(request), () => 5000);
  assert.deepEqual([...response.candidate.windowEndHeldIds], ['worker-straddle']);
  assert.equal(response.candidate.patches.some(p => p.id === 'worker-straddle'), false);
  const rehydrated = rehydrateOptimizerCandidate(response.candidate, workerSnapshot, response.validation);
  assert.deepEqual(validateCandidateForApply(rehydrated, workerSnapshot).filter(f => f.severity === 'error'), []);
});

test('real optimizer worker preserves validation metadata on the legacy fallback path', () => {
  const legacySnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    setupSnapshot: null,
    masterData: { plants: [{ plant: 'P' }], lines: [{ plant: 'P', machine: 'L1' }] },
    tasks: [{ id: 'legacy-worker-task', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 1,
      original_end_date: '2035-08-07T18:00:00.000Z', start_date: null, end_date: null,
      planning_status: 'scheduled' }],
  };
  const response = buildOptimizerWorkerResponse({
    runId: 'legacy-worker', mode: 'spt', snapshot: legacySnapshot,
    request: { mode: 'spt', plant: 'P', respectCalendar: false,
      now: '2035-08-06T08:00:00.000Z', endDate: '2035-08-07T18:00:00.000Z' },
    deadlineDurationMs: 250,
  }, () => 7000);
  assert.ok(response.validation, 'legacy worker candidates must also carry apply metadata');
  assert.ok(response.candidate?.patches.some(patch => patch.id === 'legacy-worker-task'));
  assert.deepEqual(response.validation.effectiveFirmedIds, []);
});

test('real optimizer worker preserves validation metadata for backlog candidates', () => {
  const backlogSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    setupSnapshot: null,
    masterData: {
      plants: [{ plant: 'P', timezone: 'America/New_York' }],
      lines: [{ plant: 'P', machine: 'L1' }],
    },
    calendars: { L1: { workHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]])) } },
    tasks: [{ id: 'backlog-worker-task', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 1,
      start_date: new Date('2035-08-05T07:00:00'), end_date: new Date('2035-08-05T08:00:00'),
      planning_status: 'scheduled' },
      { id: 'backlog-worker-post-window', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 1,
        start_date: new Date('2035-08-06T12:30:00'), end_date: new Date('2035-08-06T13:30:00'),
        planning_status: 'scheduled' },
      { id: 'backlog-worker-unselected-queue', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 1,
        start_date: null, end_date: null, planning_status: 'needs_planning' }],
  };
  const response = buildOptimizerWorkerResponse({
    runId: 'backlog-worker', mode: 'backlog', snapshot: backlogSnapshot,
    request: { mode: 'backlog', plant: 'P', startDate: new Date('2035-08-04T00:00:00'),
      endDate: new Date('2035-08-06T00:00:00'), runAt: new Date('2035-08-06T12:00:00') },
    deadlineDurationMs: 250,
  }, () => 7000);
  assert.ok(response.validation, 'backlog worker candidates must also carry apply metadata');
  assert.ok(Array.isArray(response.candidate?.dispositions));
  assert.deepEqual(response.validation.effectiveFirmedIds, []);
  assert.deepEqual(response.validation.scopeTaskIds, ['backlog-worker-task'],
    'worker validation scope must match Remove Backlog selection exactly');
  assert.deepEqual(response.validation.boundaryTaskIds, ['backlog-worker-post-window'],
    'post-window collisions belong to occupancy context without dispositions');
  assert.equal(response.candidate.dispositions.some(disposition => disposition.id === 'backlog-worker-unselected-queue'), false,
    'queued rows outside Remove Backlog selection must not receive dispositions');
  const rehydrated = rehydrateOptimizerCandidate(response.candidate, backlogSnapshot, response.validation);
  const applyFindings = validateCandidateForApply(rehydrated, backlogSnapshot);
  assert.ok(applyFindings.some(finding => finding.code === 'capacity_overlap' && finding.severity === 'error'),
    'post-window occupancy collisions must be rejected at apply without dispositioning the boundary');
});

test('detached Remove Backlog leaves skipped invalid-runtime work unchanged', () => {
  const invalidRuntime = {
    ...snapshot,
    selectedPlant: 'P',
    setupSnapshot: null,
    masterData: {
      plants: [{ plant: 'P', timezone: 'America/New_York' }],
      lines: [{ plant: 'P', machine: 'L1' }],
    },
    calendars: { L1: { workHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]])) } },
    tasks: [{ id: 'backlog-invalid-runtime', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 'not-a-number',
      start_date: new Date('2035-08-05T07:00:00'), end_date: new Date('2035-08-05T08:00:00'),
      planning_status: 'scheduled' }],
  };
  const response = buildOptimizerWorkerResponse({
    runId: 'backlog-invalid-runtime', mode: 'backlog', snapshot: invalidRuntime,
    request: { mode: 'backlog', plant: 'P', startDate: new Date('2035-08-04T00:00:00'),
      endDate: new Date('2035-08-06T00:00:00'), runAt: new Date('2035-08-06T12:00:00') },
    deadlineDurationMs: 250,
  }, () => 7000);

  assert.ok(response.validation);
  assert.equal(response.validation.scopeTaskIds.includes('backlog-invalid-runtime'), false,
    'invalid-runtime work skipped by Remove Backlog must not enter mutable validation scope');
  assert.ok(response.validation.boundaryTaskIds.includes('backlog-invalid-runtime'),
    'skipped valid intervals remain occupancy boundaries for detached validation');
  assert.equal(response.candidate?.patches.some(patch => patch.id === 'backlog-invalid-runtime'), false,
    'detached preview must not fabricate a needs-planning patch for skipped work');
  assert.equal(response.candidate?.dispositions.some(disposition => disposition.id === 'backlog-invalid-runtime'), false,
    'detached preview must not emit a disposition for skipped work');

  const rehydrated = rehydrateOptimizerCandidate(response.candidate, invalidRuntime, response.validation);
  assert.equal(rehydrated.patches.some(patch => patch.id === 'backlog-invalid-runtime'), false);
  assert.equal(rehydrated.dispositions.some(disposition => disposition.id === 'backlog-invalid-runtime'), false);
});

test('optimizer preview cancellation terminates the worker and rejects promptly', async () => {
  const controller = new AbortController();
  let worker;
  const resultPromise = runOptimizerPreview({
    runId: 'cancel-run', mode: 'duedate', snapshot,
    request: { mode: 'duedate' },
  }, {
    workerFactory: () => {
      worker = {
        onmessage: null, onerror: null, terminated: false,
        postMessage() {},
        terminate() { this.terminated = true; },
      };
      return worker;
    },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(resultPromise, error => error?.name === 'AbortError');
  assert.equal(worker.terminated, true);
});

test('optimizer worker runs in a real worker_threads realm with clone round-trip and independent clock', async () => {
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const workerSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    tasks: [{ id: 'runtime-worker-task', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 1,
      original_end_date: new Date('2035-08-07T18:00:00'), start_date: null, end_date: null,
      planning_status: 'needs_planning' }],
    calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
    masterData: { plants: [{ plant: 'P' }], lines: [{ plant: 'P', machine: 'L1' }] },
  };
  const workerPath = pathToFileURL(resolve('frontend/optimization/optimizer-worker.mjs')).href;
  const corePath = resolve('frontend/nimbus-compute-core.js');
  const bridge = `
    import { parentPort } from 'node:worker_threads';
    import { createRequire } from 'node:module';
    globalThis.postMessage = value => parentPort.postMessage(value);
    Object.defineProperty(globalThis, 'onmessage', {
      configurable: true,
      set(handler) { parentPort.on('message', data => {
        parentPort.postMessage({ type: 'worker-clock', now: performance.now() });
        handler({ data });
      }); },
    });
    globalThis.NimbusComputeCore = createRequire(${JSON.stringify(corePath)})(${JSON.stringify(corePath)});
    await import(${JSON.stringify(workerPath)});
  `;
  const worker = new Worker(bridge, { eval: true, type: 'module' });
  let ticked = false;
  let workerClock;
  const tick = new Promise(resolveTick => setImmediate(() => { ticked = true; resolveTick(); }));
  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error('real optimizer worker timed out')), 5000);
    worker.on('message', value => {
      if (value?.type === 'worker-clock') {
        workerClock = value.now;
        return;
      }
      clearTimeout(timer);
      resolveResponse(value);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.postMessage({
      runId: 'runtime-worker-round-trip', mode: 'spt', snapshot: workerSnapshot,
      deadlineDurationMs: 1000,
      request: { mode: 'spt', plant: 'P', respectCalendar: false,
        deadlineAt: -1000000000,
        planningStart: new Date('2035-08-07T08:00:00'), runNow: new Date('2035-08-07T08:00:00'),
        endDate: new Date('2035-08-08T00:00:00') },
    });
  });
  await tick;
  assert.equal(response.runId, 'runtime-worker-round-trip');
  assert.ok(response.validation, 'structured-cloned worker response must retain validation metadata');
  assert.equal(response.validation.respectCalendar, false);
  assert.equal(typeof workerClock, 'number');
  const workerDeadline = response.candidate?.diagnostics?.deadlineAt;
  assert.equal(typeof workerDeadline, 'number');
  assert.ok(workerDeadline - workerClock >= 500 && workerDeadline - workerClock <= 2000,
    'the worker must use the localized duration instead of the expired foreign absolute deadline');
  assert.equal(ticked, true, 'the main event loop must remain responsive while the worker evaluates');
  await worker.terminate();
});

test('real optimizer worker can be cancelled before returning a response', async () => {
  // Run-id stale-response filtering is a main-thread client responsibility:
  // the client owns the active run and rejects unrelated worker messages, as
  // covered by the fake-worker test above. This boundary test instead proves
  // that a dedicated worker can be stopped after it has begun this request.
  const workerPath = pathToFileURL(resolve('frontend/optimization/optimizer-worker.mjs')).href;
  const corePath = resolve('frontend/nimbus-compute-core.js');
  const bridge = `
    import { parentPort } from 'node:worker_threads';
    import { createRequire } from 'node:module';
    globalThis.postMessage = value => parentPort.postMessage(value);
    Object.defineProperty(globalThis, 'onmessage', {
      configurable: true,
      set(handler) { parentPort.on('message', data => {
        setImmediate(() => {
          parentPort.postMessage({ type: 'started', runId: data.runId });
          handler({ data });
        });
      }); },
    });
    globalThis.NimbusComputeCore = createRequire(${JSON.stringify(corePath)})(${JSON.stringify(corePath)});
    await import(${JSON.stringify(workerPath)});
  `;
  const worker = new Worker(bridge, { eval: true, type: 'module' });
  const colors = ['RED', 'BLUE', 'YELLOW', 'BLACK', 'WHITE', 'ORANGE', 'PURPLE', 'TEAL'];
  const cancellationSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    masterData: { plants: [{ plant: 'P' }], lines: [{ plant: 'P', machine: 'L1' }] },
    tasks: Array.from({ length: 256 }, (_, index) => ({
      id: `runtime-worker-cancel-${index}`,
      PLANT: 'P', MACHINE: 'L1', COLOR: colors[index % colors.length], RUN_TIME: 1,
      start_date: null, end_date: null, planning_status: 'needs_planning',
    })),
  };
  let response = false;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolvePromise, rejectPromise) => {
    resolveStarted = resolvePromise;
    rejectStarted = rejectPromise;
  });
  const timer = setTimeout(() => rejectStarted(new Error('real optimizer worker did not acknowledge receipt')), 5000);
  worker.on('message', value => {
    if (value?.type === 'started') {
      clearTimeout(timer);
      resolveStarted();
    } else {
      response = true;
    }
  });
  worker.postMessage({ runId: 'runtime-worker-cancel', mode: 'spt', snapshot: cancellationSnapshot,
    deadlineDurationMs: 5000, request: { mode: 'spt', respectCalendar: false } });
  await started;
  await worker.terminate();
  assert.equal(response, false, 'terminating the acknowledged worker must prevent a stale response');
});

test('gate 16: a worker-produced patch keeps end = the last productive edge (finish-first) and carries the run time, on a segmented and a continuous order', () => {
  const hours = { 0: [8, 12], 1: [8, 12], 2: [8, 12], 3: [8, 12], 4: [8, 12], 5: [8, 12], 6: [8, 12] };
  const workerSnapshot = {
    ...snapshot, selectedPlant: 'P', setupSnapshot: null,
    masterData: { plants: [{ plant: 'P', split_order_policy: 'partial_allowed' }], lines: [{ plant: 'P', machine: 'L1' }] },
    calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
    tasks: [
      { id: 'w-seg', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 6, original_end_date: '2035-08-09T18:00:00.000Z',
        start_date: null, end_date: null, planning_status: 'scheduled' },
      { id: 'w-one', PLANT: 'P', MACHINE: 'L1', RUN_TIME: 2, original_end_date: '2035-08-09T18:00:00.000Z',
        start_date: null, end_date: null, planning_status: 'scheduled' },
    ],
  };
  const response = buildOptimizerWorkerResponse({
    runId: 'finish-first', mode: 'spt', snapshot: workerSnapshot,
    request: { mode: 'spt', plant: 'P', respectCalendar: true,
      now: '2035-08-06T08:00:00.000Z', planningStart: '2035-08-06T08:00:00.000Z', endDate: '2035-08-12T00:00:00.000Z' },
    deadlineDurationMs: 1000,
  }, () => 7000);
  const when = value => new Date(value).getTime();
  const byId = Object.fromEntries(response.candidate.patches.map(patch => [patch.id, patch.changes]));
  assert.ok(byId['w-seg'] && byId['w-one'], 'both orders are placed by the worker');
  for (const [id, changes] of Object.entries(byId)) {
    const segs = changes.scheduleSegments ?? [];
    const last = segs.length ? segs[segs.length - 1].endDate : changes.end_date;
    const first = segs.length ? segs[0].startDate : changes.start_date;
    assert.equal(when(changes.end_date), when(last), `${id}: end_date is the last productive edge`);
    assert.equal(when(changes.start_date), when(first), `${id}: start_date is the first productive edge`);
    const productive = segs.length
      ? segs.reduce((sum, s) => sum + (when(s.endDate) - when(s.startDate)), 0)
      : when(changes.end_date) - when(changes.start_date);
    assert.equal(productive / 3600000, id === 'w-seg' ? 6 : 2, `${id}: the pieces add up to the run time`);
  }
  assert.ok((byId['w-seg'].scheduleSegments ?? []).length >= 2, 'the 6 h order does not fit one 4 h window, so it is split');
});

test('worker validation bounds are snapshot-bound: a date-only due on a closed Friday keeps its in-run floor (post-cutover Apply rejected)', () => {
  // Friday 2035-08-10 is closed on the line, so the date-only due (exact local midnight) resolves to Thursday's
  // close; with max_pull_forward_days 1 the floor is Wednesday 00:00. The worker serializes the bounds closures
  // AFTER the run, in a realm whose Store is empty: before the fix the due fell back to end-of-Friday and the
  // serialized floor came back as Thursday 00:00, so Apply (main thread) rejected a legal Wednesday placement.
  const open = [7, 19];
  const workHours = { 0: null, 1: open, 2: open, 3: open, 4: open, 5: null, 6: null };
  const plantHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dueFriday = new Date(2035, 7, 10, 0, 0, 0);
  const task = { id: 'due-window-task', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 2,
    original_end_date: dueFriday, start_date: new Date(2035, 7, 9, 7, 0, 0), end_date: new Date(2035, 7, 9, 9, 0, 0),
    planning_status: 'scheduled' };
  const dueSnapshot = {
    ...snapshot,
    selectedPlant: 'P',
    tasks: [task],
    calendars: { L1: { workHours } }, plants: { P: { workHours: plantHours } },
    masterData: {
      plants: [{ plant: 'P', timezone: zone, max_pull_forward_days: 1, max_push_forward_days: 1 }],
      lines: [{ plant: 'P', machine: 'L1' }],
    },
    setupSnapshot: {
      plant: 'P', plant_active: true,
      definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    },
    frozenHorizonEnd: null,
  };
  const request = {
    runId: 'worker-due-window', mode: 'duedate', snapshot: dueSnapshot, deadlineDurationMs: 2000,
    request: { mode: 'duedate', plant: 'P', respectFirmed: true, respectCalendar: true,
      planningStart: new Date(2035, 7, 6, 8, 0, 0), runNow: new Date(2035, 7, 6, 8, 0, 0),
      endDate: new Date(2035, 7, 14, 0, 0, 0) },
  };
  const response = buildOptimizerWorkerResponse(request, () => 5000);
  assert.ok(response.validation, 'the worker response must carry validation metadata');
  const wednesday = new Date(2035, 7, 8, 0, 0, 0);
  const saturday = new Date(2035, 7, 11, 0, 0, 0);
  const floor = response.validation.notBeforeById['due-window-task'];
  const ceiling = response.validation.notAfterById['due-window-task'];
  assert.equal(+new Date(floor), +wednesday, `floor must be Wednesday 00:00, got ${floor}`);
  assert.equal(+new Date(ceiling), +saturday, `ceiling must be Saturday 00:00, got ${ceiling}`);

  // Apply side: a candidate placing the task on the Wednesday must not trip date_window on the main thread.
  const legal = { ...response.candidate, patches: [{ id: 'due-window-task', changes: {
    start_date: new Date(2035, 7, 8, 7, 0, 0), end_date: new Date(2035, 7, 8, 9, 0, 0) } }] };
  const rehydrated = rehydrateOptimizerCandidate(legal, dueSnapshot, response.validation);
  const findings = validateCandidateForApply(rehydrated, dueSnapshot);
  assert.equal(findings.some(finding => finding.code === 'date_window'), false,
    `no date_window error for a Wednesday placement, got ${JSON.stringify(findings.map(f => f.code))}`);
});

test('a worker error compute-core-stale falls back to the synchronous evaluator and warns once', async () => {
  const { ErrorLog } = await import('../../../frontend/platform/foundation.mjs');
  const originalWarn = ErrorLog.warn;
  const warnings = [];
  ErrorLog.warn = (...args) => { warnings.push(args); };
  try {
    const run = async (runId) => {
      let worker;
      let syncCalls = 0;
      const promise = runOptimizerPreview({
        runId, mode: 'spt', snapshot, request: { mode: 'spt', respectCalendar: false },
      }, {
        workerFactory: () => {
          worker = { onmessage: null, onerror: null, terminated: false, postMessage() {}, terminate() { this.terminated = true; } };
          return worker;
        },
        syncEvaluator: () => { syncCalls += 1; return candidate('sync-fallback'); },
      });
      worker.onmessage({ data: { runId, error: 'compute-core-stale' } });
      const result = await promise;
      assert.equal(result.id, 'sync-fallback');
      assert.equal(syncCalls, 1, 'the main-thread evaluator ran once');
      assert.equal(worker.terminated, true, 'the stale worker is released');
    };
    await run('stale-1');
    await run('stale-2');
    assert.equal(warnings.length, 1, 'logged once, not per run');
    assert.match(String(warnings[0][1]), /stale compute core/);
    // Any other worker error still rejects (no silent fallback).
    let worker;
    const failing = runOptimizerPreview({ runId: 'other-error', mode: 'spt', snapshot, request: { mode: 'spt' } }, {
      workerFactory: () => { worker = { onmessage: null, onerror: null, postMessage() {}, terminate() {} }; return worker; },
      syncEvaluator: () => { throw new Error('must not run'); },
    });
    worker.onmessage({ data: { runId: 'other-error', error: 'boom' } });
    await assert.rejects(failing, /boom/);
  } finally {
    ErrorLog.warn = originalWarn;
  }
});

test('Tool Inventory: the optional toolBlocked / toolMoved / toolPass fields survive the worker structuredClone and rehydrate unchanged', () => {
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const workerSnapshot = {
    ...snapshot, selectedPlant: 'P',
    tasks: [{ id: 'tool-free', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 2, original_end_date: new Date('2035-08-10T12:00:00') }],
    calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
    masterData: { plants: [{ plant: 'P', setup_policy_config: { toolingRule: 'hard' } }], lines: [{ plant: 'P', machine: 'L1' }], tool_inventory: [] },
    setupSnapshot: { plant: 'P', plant_active: true, definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_rows: [], machine_rows: [], machine_states: [], overrides: [] },
    frozenHorizonEnd: new Date('2035-08-07T00:00:00'),
  };
  const request = {
    runId: 'tool-fields', mode: 'changeover', snapshot: workerSnapshot, deadlineDurationMs: 2000,
    request: { mode: 'changeover', plant: 'P', respectFirmed: true, respectCalendar: false,
      planningStart: new Date('2035-08-06T08:00:00'), runNow: new Date('2035-08-06T08:00:00'), endDate: new Date('2035-08-11T00:00:00') },
  };
  const response = buildOptimizerWorkerResponse(structuredClone(request), () => 5000);
  // Transport proof with synthetic values (the real worker-path round trip with a loaded inventory is the next test).
  response.candidate.toolBlocked = [{ orderId: 'a', tool: 'T100', available: 1, inUse: 2, holderIds: ['h1', 'h2'] }];
  response.candidate.toolMoved = [{ orderId: 'b', tool: 'T100', fromStart: null, fromEnd: null, toStart: '2035-08-10T08:00:00', toEnd: '2035-08-10T10:00:00' }];
  response.candidate.toolPass = { complete: false, elapsedMs: 7 };
  const crossed = structuredClone(response);
  const rehydrated = rehydrateOptimizerCandidate(crossed.candidate, workerSnapshot, crossed.validation);
  assert.deepEqual(rehydrated.toolBlocked, response.candidate.toolBlocked);
  assert.deepEqual(rehydrated.toolMoved, response.candidate.toolMoved);
  assert.deepEqual(rehydrated.toolPass, { complete: false, elapsedMs: 7 });
  // Absent fields stay absent (rule Off).
  const offRequest = structuredClone(request);
  offRequest.snapshot.masterData.plants[0].setup_policy_config = { toolingRule: 'off' };
  const plain = structuredClone(buildOptimizerWorkerResponse(offRequest, () => 5000));
  const plainRe = rehydrateOptimizerCandidate(plain.candidate, workerSnapshot, plain.validation);
  assert.equal(plainRe.toolBlocked, undefined);
  assert.equal(plainRe.toolPass, undefined);
});
