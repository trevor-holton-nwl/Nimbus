// A7: a worker that reports compute-core-stale must not push an exhaustive / background run onto the main
// thread (up to 180 s, deaf to the AbortSignal). A normal foreground run keeps the synchronous fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOptimizerPreview } from '../../../frontend/optimization/optimizer-worker-client.mjs';
import { SETUP_AWARE_EXHAUSTIVE_BUDGET_MS, SETUP_AWARE_NORMAL_BUDGET_MS } from '../../../frontend/optimization/engine.mjs';
import { ErrorLog } from '../../../frontend/platform/foundation.mjs';

globalThis.window = globalThis.window || {};   // Util.t reads window.__NIMBUS_LOCALES

const snapshot = { tasks: [], firmedIds: [], alerts: [], selectedPlant: null, blocks: [], plantBlocks: [],
  calendars: {}, plants: {}, lineSettings: {}, masterData: null, priorityRankMaps: {}, readModelVersion: '1' };

function staleRun(runId, evalRequest) {
  let worker;
  let syncCalls = 0;
  const promise = runOptimizerPreview({ runId, mode: 'spt', snapshot, request: { mode: 'spt', respectCalendar: false, ...evalRequest } }, {
    workerFactory: () => {
      worker = { onmessage: null, onerror: null, terminated: false, postMessage() {}, terminate() { this.terminated = true; } };
      return worker;
    },
    syncEvaluator: () => { syncCalls += 1; return { id: 'sync-fallback' }; },
  });
  worker.onmessage({ data: { runId, error: 'compute-core-stale' } });
  return { promise, worker, calls: () => syncCalls };
}

test('stale core: an exhaustive run is refused with a clear error, never evaluated on the main thread', async (t) => {
  const warn = ErrorLog.warn;
  ErrorLog.warn = () => {};
  t.after(() => { ErrorLog.warn = warn; });
  for (const evalRequest of [{ exhaustive: true }, { searchBudgetMs: SETUP_AWARE_EXHAUSTIVE_BUDGET_MS }, { searchBudgetMs: SETUP_AWARE_NORMAL_BUDGET_MS + 1 }]) {
    const run = staleRun(`stale-long-${JSON.stringify(evalRequest)}`, evalRequest);
    await assert.rejects(run.promise, (err) => err.name === 'OptimizerCoreStale' && err.message.length > 0, JSON.stringify(evalRequest));
    assert.equal(run.calls(), 0, 'the synchronous evaluator must not run for a long request');
    assert.equal(run.worker.terminated, true, 'the worker is still released');
  }
});

test('stale core: a Normal foreground run (budget at or below the Normal one) keeps the synchronous fallback', async (t) => {
  const warn = ErrorLog.warn;
  ErrorLog.warn = () => {};
  t.after(() => { ErrorLog.warn = warn; });
  for (const evalRequest of [{}, { searchBudgetMs: SETUP_AWARE_NORMAL_BUDGET_MS }, { exhaustive: false, searchBudgetMs: 5000 }]) {
    const run = staleRun(`stale-short-${JSON.stringify(evalRequest)}`, evalRequest);
    const result = await run.promise;
    assert.equal(result.id, 'sync-fallback');
    assert.equal(run.calls(), 1);
    assert.equal(run.worker.terminated, true);
  }
});
