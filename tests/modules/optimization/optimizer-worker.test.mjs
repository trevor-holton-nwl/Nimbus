import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOptimizerPreview } from '../../../frontend/optimization/optimizer-worker-client.mjs';

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
  notBeforeById: {}, notAfterById: {},
};

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
    request: { mode: 'changeover', deadlineAt: 123 },
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
  assert.equal(posted.request.deadlineAt, 123);
  worker.onmessage({ data: { runId: 'other-run', candidate: candidate('other') } });
  worker.onmessage({ data: { runId: 'worker-run', candidate: candidate('worker'), validation } });
  const result = await resultPromise;
  assert.equal(result.id, 'worker');
  assert.equal(result.validationContext?.bounds.horizonEnd.toISOString(), validation.horizonEnd,
    'worker results rehydrate apply-time validation bounds on the main thread');
  assert.equal(worker.terminated, true, 'the worker is released after a completed preview');
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
