// P3-5f: the validation seam crosses the worker boundary as JSON (serializeOptimizerValidation) and is rebuilt by
// rehydrateOptimizerCandidate. Every key the engine puts on DueDateFirstBounds must either survive that round trip
// (CARRIED, compared here) or be listed in NOT_CARRIED with the reason. A new bounds key fails this test until it is
// classified, so a field cannot be silently dropped at the worker boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateOptimizerWorkerRequest } from '../../../frontend/optimization/optimizer-worker.mjs';
import { rehydrateOptimizerCandidate } from '../../../frontend/optimization/engine.mjs';
import { serializeOptimizerValidation } from '../../../frontend/optimization/optimizer-worker-contract.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
const realClock = () => performance.now();

/** Bounds keys that cross the boundary and must come back equal. */
const CARRIED = new Set([
  'setup', 'exactSearchThreshold', 'iterationCap', 'now', 'planningStart', 'runNow', 'placementStart', 'horizonEnd',
  'lines', 'scopeTaskIds', 'boundaryTaskIds', 'respectCalendar', 'notBefore', 'notAfter', 'finishFloor',
  'ignorePlantWindow', 'ignoreToolRule', 'clock',
]);
/** Bounds keys deliberately NOT carried, each with the reason. */
const NOT_CARRIED = new Map([
  ['deadline', 'carried as a number but it is a performance.now() instant of the WORKER realm; the rehydrated value is stale and is read only by search paths that never run at apply time (not set to Infinity: the evaluator requires a finite deadline)'],
  ['exhaustive', 'search-only: it only changes the capacity-check advice wording and exact-search limits'],
  ['exactSearchLeafCap', 'search-only limit'],
  ['gapFillBudgetMs', 'search-only soft budget; apply-time validation never runs gap fill'],
  ['convergenceWindow', 'search-only limit'],
  ['strategy', 'search-only fragment mode'],
  ['searchBudget', 'search-only shared budget object'],
  ['runContext', 'per-run memo, rebuilt on demand and never valid across realms'],
  ['toolIndex', 'per-run memo of tool facts, rebuilt from snapshot.tasks by every reader'],
  ['disableFreeIndex', 'test-only switch'],
  ['skipToolOverflowFinding', 'internal per-line trial flag, never set on a candidate-level bounds object'],
]);

const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
const baseSnapshot = {
  tasks: [
    { id: 'a', PLANT: 'P', MACHINE: 'L1', COLOR: 'GREEN', RUN_TIME: 4, user_scheduled: true, planning_status: 'scheduled',
      start_date: new Date('2035-08-06T10:00:00'), end_date: new Date('2035-08-06T14:00:00'), original_end_date: new Date('2035-08-08T12:00:00') },
    { id: 'b', PLANT: 'P', MACHINE: 'L1', COLOR: 'BLUE', RUN_TIME: 2, original_end_date: new Date('2035-08-09T12:00:00') },
  ],
  firmedIds: ['a'], alerts: [], selectedPlant: 'P', blocks: [], plantBlocks: [],
  calendars: { L1: { workHours: hours } }, plants: { P: { workHours: hours } },
  lineSettings: {}, priorityRankMaps: {}, readModelVersion: '1',
  masterData: { plants: [{ plant: 'P', timezone: 'America/New_York' }], lines: [{ plant: 'P', machine: 'L1' }] },
  setupSnapshot: {
    plant: 'P', plant_active: true,
    definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  },
  frozenHorizonEnd: new Date('2035-08-07T00:00:00'),
};

function sameValue(a, b, label) {
  if (a instanceof Date || b instanceof Date) { assert.equal(+new Date(a), +new Date(b), label); return; }
  if (a instanceof Set || b instanceof Set) { assert.deepEqual([...a].map(String).sort(), [...b].map(String).sort(), label); return; }
  assert.deepEqual(a, b, label);
}

for (const mode of ['changeover', 'backlog']) {
  test(`validation bounds round trip (${mode}): every bounds key is carried or explicitly not carried`, () => {
    const request = {
      runId: `rt-${mode}`, mode, snapshot: structuredClone(baseSnapshot), deadlineDurationMs: 600000,
      request: {
        mode, plant: 'P', respectFirmed: true, respectCalendar: mode === 'backlog',
        planningStart: new Date('2035-08-06T08:00:00'), runNow: new Date('2035-08-06T08:00:00'),
        startDate: new Date('2035-08-06T08:00:00'), endDate: new Date('2035-08-12T00:00:00'),
      },
    };
    const candidate = evaluateOptimizerWorkerRequest(request, realClock);
    const original = candidate.validationContext.bounds;
    const wire = JSON.parse(JSON.stringify(serializeOptimizerValidation(candidate)));
    const { validationContext: _drop, ...plain } = candidate;
    const back = rehydrateOptimizerCandidate(JSON.parse(JSON.stringify(plain)), candidate.validationContext.baselineSnapshot, wire).validationContext.bounds;

    for (const key of Object.keys(original)) {
      assert.ok(CARRIED.has(key) || NOT_CARRIED.has(key),
        `bounds key "${key}" is neither carried across the worker boundary nor in NOT_CARRIED: classify it (and carry it in serializeOptimizerValidation / rehydrateOptimizerCandidate if apply-time validation reads it)`);
    }
    for (const key of Object.keys(original)) {
      if (!CARRIED.has(key) || original[key] === undefined) continue;
      if (key === 'clock') { assert.equal(typeof back.clock, 'function'); continue; }
      if (key === 'notBefore' || key === 'notAfter') {
        for (const task of request.snapshot.tasks) {
          const o = original[key](task); const r = back[key](task);
          assert.equal(o ? +new Date(o) : null, r ? +new Date(r) : null, `${key}(${task.id})`);
        }
        continue;
      }
      assert.ok(key in back, `carried key "${key}" is missing after rehydration`);
      sameValue(original[key], back[key], key);
    }
    // the reverse direction: nothing appears on the rehydrated bounds that the original never had (other than the clock)
    for (const key of Object.keys(back)) {
      if (key === 'clock' || key === 'deadline') continue;
      if (back[key] === null || back[key] === undefined) continue;
      assert.ok(key in original, `rehydrated bounds invented key "${key}"`);
    }
    if (mode === 'backlog') {
      assert.equal(back.ignorePlantWindow, true);
      assert.equal(back.ignoreToolRule, true);
      assert.ok(original.scopeTaskIds !== undefined && back.scopeTaskIds !== undefined, 'backlog scope survives');
    }
  });
}

test('the NOT_CARRIED allowlist does not hide a carried key', () => {
  for (const key of NOT_CARRIED.keys()) assert.equal(CARRIED.has(key), false, key);
});
