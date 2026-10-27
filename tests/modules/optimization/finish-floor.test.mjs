// Universal firm, Wave A (2026-10-27): the frozen horizon is a FINISH floor for every unprotected order.
// Covers placeWithFinishFloor (closed form, split bisect, last resort), the detached evaluator under
// bounds.finishFloor, the validator, and the worker round trip of the new bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as SetupScheduler from '../../../frontend/optimization/setup-scheduler.mjs';
import { Engine, rehydrateOptimizerCandidate } from '../../../frontend/optimization/engine.mjs';
import { serializeOptimizerValidation } from '../../../frontend/optimization/optimizer-worker-contract.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const at = text => new Date(text);

// ---- placeWithFinishFloor: pure helper over an attempt callback that rebuilds intervals per call ----
function windowAttempt(windows, runtimeMinutes, policy, calls) {
  // `windows` are [startText, endText]; each call rebuilds from `earliest` like freeIntervalsForPlacement.
  return earliest => {
    calls.push(+earliest);
    const free = windows.map(([s, e]) => ({ start: at(s), end: at(e) }));
    return SetupScheduler.placeWithSetup({
      earliestStart: earliest, runtimeMinutes, policy, setup: { kind: 'resolved', minutes: 0 },
      freeIntervals: free, minProductiveSegmentMinutes: 30,
    });
  };
}

test('placeWithFinishFloor: no floor is a single attempt at the earliest start', () => {
  const calls = [];
  const result = SetupScheduler.placeWithFinishFloor(
    windowAttempt([['2026-08-03T08:00:00', '2026-08-03T18:00:00']], 120, 'never', calls),
    at('2026-08-03T08:00:00'), null, 0, 120, 'never');
  assert.equal(result.kind, 'placed');
  assert.equal(calls.length, 1);
});

test('placeWithFinishFloor (never): closed form starts at floor - setup - run and a floor inside open time is met exactly', () => {
  const calls = [];
  const result = SetupScheduler.placeWithFinishFloor(
    windowAttempt([['2026-08-03T08:00:00', '2026-08-03T18:00:00']], 120, 'never', calls),
    at('2026-08-03T08:00:00'), at('2026-08-03T14:00:00'), 0, 120, 'never');
  assert.equal(result.kind, 'placed');
  assert.equal(+result.productiveSegments.at(-1).end, +at('2026-08-03T14:00:00'), 'the order finishes exactly at the floor');
  assert.equal(+result.productiveSegments[0].start, +at('2026-08-03T12:00:00'));
  assert.equal(calls.length, 1, 'one exact placement');
});

test('placeWithFinishFloor (never): a floor in closed time pushes to the next window (intervals rebuilt per attempt, T3 regression)', () => {
  // 08-18 each day. Floor 20:00 on day 1 is closed time: the only legal finish at or after it is on day 2.
  const calls = [];
  const attempt = windowAttempt([
    ['2026-08-03T08:00:00', '2026-08-03T18:00:00'], ['2026-08-04T08:00:00', '2026-08-04T18:00:00'],
  ], 120, 'never', calls);
  const result = SetupScheduler.placeWithFinishFloor(attempt, at('2026-08-03T08:00:00'), at('2026-08-03T20:00:00'), 0, 120, 'never');
  assert.equal(result.kind, 'placed');
  assert.equal(+result.productiveSegments[0].start, +at('2026-08-04T08:00:00'));
  assert.ok(+result.productiveSegments.at(-1).end >= +at('2026-08-03T20:00:00'));
});

test('placeWithFinishFloor (split-capable): bisects toward the minimal start instead of overshooting', () => {
  const calls = [];
  const attempt = windowAttempt([['2026-08-03T00:00:00', '2026-08-03T08:00:00'], ['2026-08-04T00:00:00', '2026-08-04T08:00:00']], 360, 'partial_allowed', calls);
  const floor = at('2026-08-04T02:00:00');
  const result = SetupScheduler.placeWithFinishFloor(attempt, at('2026-08-03T00:00:00'), floor, 0, 360, 'partial_allowed');
  assert.equal(result.kind, 'placed');
  assert.ok(+result.productiveSegments.at(-1).end >= +floor, 'finishes at or after the floor');
  assert.ok(+result.productiveSegments[0].start < +at('2026-08-04T00:00:00'),
    'it starts in the first window (the naive floor - run shift would have started on day 2)');
  assert.ok(calls.length <= 6, `bounded retries, got ${calls.length}`);
});

test('placeWithFinishFloor (split-capable): searches earlier starts when the probe at the floor is infeasible', () => {
  // Day-2 window is cut to 00-03 by the completion ceiling, so a start AT the floor (day 2, 02:00) has
  // only 1 h and fails; a start on day 1 around 04:00 finishes 02:00-03:00 and fits.
  const calls = [];
  const attempt = windowAttempt([['2026-08-03T00:00:00', '2026-08-03T08:00:00'], ['2026-08-04T00:00:00', '2026-08-04T03:00:00']], 360, 'partial_allowed', calls);
  const floor = at('2026-08-04T02:00:00');
  const result = SetupScheduler.placeWithFinishFloor(attempt, at('2026-08-03T00:00:00'), floor, 0, 360, 'partial_allowed');
  assert.equal(result.kind, 'placed');
  const finish = +result.productiveSegments.at(-1).end;
  assert.ok(finish >= +floor && finish <= +at('2026-08-04T03:00:00'), 'finishes between the floor and the ceiling');
  assert.ok(+result.productiveSegments[0].start >= +at('2026-08-03T00:00:00'));
  assert.ok(calls.length <= 6, `bounded probes, got ${calls.length}`);
});

test('placeWithFinishFloor: nothing at or after the floor fits -> the infeasible result is returned', () => {
  const calls = [];
  const result = SetupScheduler.placeWithFinishFloor(
    windowAttempt([['2026-08-03T08:00:00', '2026-08-03T18:00:00']], 120, 'never', calls),
    at('2026-08-03T08:00:00'), at('2026-08-05T00:00:00'), 0, 120, 'never');
  assert.equal(result.kind, 'infeasible');
});

// ---- detached evaluator under bounds.finishFloor ----
const OPEN = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, [8, 18]]));
const task = (id, hours, extra = {}) => ({
  id, PLANT: 'P1', plant: 'P1', MACHINE: 'L1', RUN_TIME: hours, COLOR: 'GREEN',
  start_date: null, end_date: null, original_start_date: null, BASIC_START_DATE: null, BASIC_FINISH_DATE: null,
  firmed: false, row_version: null, original_end_date: at('2026-08-06T18:00:00'), ...extra,
});
const snapshotOf = (tasks, firmedIds = []) => ({
  tasks, firmedIds, alerts: [], selectedPlant: 'P1', blocks: [], plantBlocks: [],
  calendars: { L1: { workHours: OPEN } }, plants: { P1: { workHours: OPEN } }, lineSettings: {},
  masterData: { plants: [{ plant: 'P1' }], lines: [{ plant: 'P1', machine: 'L1' }] }, priorityRankMaps: {},
});
const setupTruth = () => ({
  plant: 'P1', plant_active: true, definition: null, plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
});
const boundsOf = (extra = {}) => ({
  setup: setupTruth(), exactSearchThreshold: 6, iterationCap: 200, clock: () => 0, deadline: 1,
  now: at('2026-08-03T08:00:00'), horizonEnd: at('2026-08-06T18:00:00'), ...extra,
});
const patchFor = (result, id) => result.patches.find(p => p.id === id && p.changes.planning_status !== 'needs_planning');

test('detached evaluator: with a finish floor no unprotected order ends before it; the first order may finish exactly at the edge', () => {
  const floor = at('2026-08-03T14:00:00');
  const snapshot = snapshotOf([task('a', 2), task('b', 2), task('c', 2)]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({ finishFloor: floor }));
  const ends = ['a', 'b', 'c'].map(id => patchFor(result, id)).filter(Boolean).map(p => +p.changes.end_date);
  assert.equal(ends.length, 3, 'all three placed');
  for (const end of ends) assert.ok(end >= +floor, 'no order finishes before the floor');
  assert.equal(Math.min(...ends), +floor, 'the first order is pulled to finish exactly at the edge (equality is valid)');
  assert.deepEqual(result.validationFindings.filter(f => f.severity === 'error'), []);
});

test('detached evaluator: a horizon ending before the floor admits nothing', () => {
  const snapshot = snapshotOf([task('a', 2)]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({
    finishFloor: at('2026-08-10T00:00:00'), horizonEnd: at('2026-08-04T18:00:00'),
  }));
  assert.equal(patchFor(result, 'a'), undefined, 'nothing is placed when no placement can finish at or after the floor');
});

test('detached evaluator: an order may START inside the window while finishing at the edge (straddler rule)', () => {
  // Floor 14:00; a 4 h order may start at 10:00 (inside the window) and finish at 14:00.
  const snapshot = snapshotOf([task('s', 4)]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({ finishFloor: at('2026-08-03T14:00:00') }));
  const patch = patchFor(result, 's');
  assert.equal(+patch.changes.start_date, +at('2026-08-03T10:00:00'), 'starts inside the window');
  assert.equal(+patch.changes.end_date, +at('2026-08-03T14:00:00'));
});

test('detached evaluator: a floor in closed time places on the next open day (free intervals rebuilt per attempt, T3 regression)', () => {
  // 08-18 open; floor 20:00 on day 1 is closed time, so the only legal finish is on day 2.
  const snapshot = snapshotOf([task('t3', 2)]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({ finishFloor: at('2026-08-03T20:00:00') }));
  const patch = patchFor(result, 't3');
  assert.ok(patch, 'placed (a stale first-interval build would leave it unadmitted)');
  assert.equal(+patch.changes.start_date, +at('2026-08-04T08:00:00'));
  assert.ok(+patch.changes.end_date >= +at('2026-08-03T20:00:00'));
});

test('validator: date_window for an unprotected end before the floor (fixed message), nothing for a protected one', () => {
  const floor = at('2026-08-03T14:00:00');
  const unprotected = task('u', 2);
  const protectedTask = task('p', 2, {
    user_scheduled: true, planning_status: 'scheduled', start_date: at('2026-08-03T09:00:00'), end_date: at('2026-08-03T11:00:00'),
  });
  const snapshot = snapshotOf([unprotected, protectedTask], ['p']);
  const bounds = boundsOf({ finishFloor: floor });
  const candidate = {
    patches: [{ id: 'u', changes: { start_date: at('2026-08-03T08:00:00'), end_date: at('2026-08-03T10:00:00'), scheduleSegments: [], planning_status: 'scheduled', planning_reason: null } }],
    dispositions: [{ id: 'u', line: 'L1', status: 'scheduled' }, { id: 'p', line: 'L1', status: 'protected' }],
    score: [], explanation: [], diagnostics: {}, unchangedLines: [], missingEdges: [],
  };
  const findings = SetupScheduler.validateCandidate(snapshot, bounds, candidate);
  const frozen = findings.filter(f => f.code === 'date_window' && f.message === 'Production finishes inside the frozen horizon.');
  assert.deepEqual(frozen.map(f => f.taskId), ['u'], 'only the unprotected order is flagged');
  assert.equal(frozen[0].severity, 'error');
});

test('completion ceiling before the floor leaves the order unplaced; ceiling == floor is valid', () => {
  const floor = at('2026-08-03T14:00:00');
  const snapshot = snapshotOf([task('x', 2)]);
  const early = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({ finishFloor: floor, notAfter: () => at('2026-08-03T13:00:00') }));
  assert.equal(patchFor(early, 'x'), undefined, 'ceiling 13:00 < floor 14:00 can never hold the order');
  const equal = SetupScheduler.evaluateDueDateFirst(snapshot, boundsOf({ finishFloor: floor, notAfter: () => floor }));
  assert.ok(patchFor(equal, 'x'), 'ceiling == floor: the order may finish exactly at both');
});

// ---- worker contract round trip ----
test('worker contract: finishFloor serializes, rehydrates, and a malformed value is rejected (null allowed)', () => {
  const floor = at('2026-08-03T14:00:00');
  const snapshot = snapshotOf([task('a', 2)]);
  const bounds = boundsOf({
    finishFloor: floor, planningStart: at('2026-08-03T08:00:00'), runNow: at('2026-08-03T08:00:00'),
    placementStart: at('2026-08-03T08:00:00'), respectCalendar: true, notBefore: () => null, notAfter: () => null,
  });
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  const withContext = { ...candidate, validationContext: { snapshot, baselineSnapshot: snapshot, bounds } };
  const serialized = serializeOptimizerValidation(withContext);
  assert.equal(+new Date(serialized.finishFloor), +floor);
  const wire = JSON.parse(JSON.stringify(serialized));
  const { validationContext: _drop, ...plain } = withContext;
  const plainWire = JSON.parse(JSON.stringify(plain));
  const rehydrated = rehydrateOptimizerCandidate(plainWire, snapshot, wire);
  assert.equal(+rehydrated.validationContext.bounds.finishFloor, +floor);
  const noFloor = rehydrateOptimizerCandidate(plainWire, snapshot, { ...wire, finishFloor: null });
  assert.equal(noFloor.validationContext.bounds.finishFloor, null);
  assert.throws(() => rehydrateOptimizerCandidate(plainWire, snapshot, { ...wire, finishFloor: 'not-a-date' }), /finishFloor/);
});

test('Engine.frozenFinishFloor feeds the optimizer: snapshot edge after run-now, else none', () => {
  const now = at('2026-08-03T08:00:00');
  assert.equal(+Engine.frozenFinishFloor(now, at('2026-08-05T00:00:00')), +at('2026-08-05T00:00:00'));
  assert.equal(Engine.frozenFinishFloor(now, now), null);
  assert.equal(Engine.frozenFinishFloor(now, undefined), null);
});
