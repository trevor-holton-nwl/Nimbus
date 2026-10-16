// Tests for frontend/optimization/engine.mjs, split from
// tests/modules/schedule-services.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-services.mts
// into 4 domain files: optimization/scheduler-contract.mjs,
// optimization/engine.mjs, calendar/calendar-engine.mjs,
// insights/services.mjs). By far the largest of the four split test files,
// mirroring the source split's own imbalance (Engine absorbed most of the
// original file). Two of this phase's 5 accepted pre-existing baseline test
// failures live here (`Engine.autoReflow reserves a covered incoming setup
// before moving a downstream peer`, `Engine.autoReflow resolves equal-start
// successors by id before reserving setup`).
//
// Engine's setup-observation/dispatch functions delegate to
// nimbus-compute-core.js via the ambient `globalThis.NimbusComputeCore`
// global (a real browser loads it via a parser-blocking <script> before
// app-entry.mjs's static imports run). Under plain Node ESM (this file)
// nothing sets that global automatically, so we bootstrap it here via
// createRequire — mirroring tests/modules/helpers/load-legacy-app.mjs's
// identical bootstrap. Two tests spawn a child Node process running an
// inline module script (`spawnSync` below) to probe optimizer behavior in a
// clean module cache; that child script's own `import()` calls were updated
// to the new file paths (./frontend/platform/store.mjs,
// ./frontend/optimization/engine.mjs) — a plain string inside a template
// literal, not a static import, so `npm run build` cannot catch a stale path
// there; only a whole-tree text grep for the old filenames would.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  Engine, snapshotSchedule, deriveSetupObservation,
  MIN_PRODUCTIVE_SEGMENT_MINUTES, effectiveFirmedIdSet,
} from '../../../frontend/optimization/engine.mjs';
import { capAwareSequence } from '../../../frontend/optimization/scheduler-contract.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Toast, Util, Config } from '../../../frontend/platform/foundation.mjs';
import { App } from '../../../frontend/shell/application-shell.mjs';
import { evaluateOptimizerWorkerRequest } from '../../../frontend/optimization/optimizer-worker.mjs';
import { validateCandidateForApply } from '../../../frontend/optimization/setup-scheduler.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

// Engine.runAndApply's early-return guards (no tasks / no plant selected) call
// Toast.show(Util.t(...)) — platform/foundation.mjs's Toast/Util reference
// bare `window`/`document`, same split-realm quirk documented in
// tests/modules/helpers/load-legacy-app.mjs. A minimal stub (matching that
// harness's approach) keeps those guard paths a real no-op under plain Node
// instead of throwing "document/window is not defined".
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

// These fixtures build dates from the real clock as naive local values, so their plant's clock is this machine's
// own zone (a plant with no valid zone has no clock: OQ52, see the one-clock tests at the end of this file).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Manual placement derives from the plant's clock (backward scheduling Task 2.5): pin the server instant so a
// fixture dated in August never reads as "in the past", and give the plant a zone. The naive string is read in
// this machine's zone, which is also the plant's zone, so the plant's wall clock is exactly that string.
function pinPlantClock(nowNaive) {
  const priorOffset = Store.serverOffsetMs;
  Store.serverOffsetMs = new Date(nowNaive).getTime() - Date.now();
  Store._blockedPlants.clear();
  return () => { Store.serverOffsetMs = priorOffset; Store._blockedPlants.clear(); };
}
function captureToasts() {
  const prior = Toast.show;
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  return { toasts, restore: () => { Toast.show = prior; } };
}

test('Engine derives a due-date-day pull-forward floor using calendar days', () => {
  Store.setMasterData({ plants: [{ plant: 'PULL', max_pull_forward_days: 7 }], lines: [] }, 'unit-test');
  const floor = Engine.earliestAllowedStart(
    { PLANT: 'PULL', original_end_date: new Date('2026-08-17T18:30:00') },
    'PULL',
  );
  assert.deepEqual(
    [floor?.getFullYear(), floor?.getMonth(), floor?.getDate(), floor?.getHours()],
    [2026, 7, 10, 0],
    'seven calendar days before the due-date calendar day, at local midnight rather than 168 elapsed hours earlier',
  );
  const dstFloor = Engine.earliestAllowedStart(
    { PLANT: 'PULL', original_end_date: new Date('2026-03-09T12:00:00') },
    'PULL',
  );
  assert.deepEqual([dstFloor?.getMonth(), dstFloor?.getDate(), dstFloor?.getHours()], [2, 2, 0],
    'crossing daylight saving still subtracts seven calendar dates and lands at local midnight');
});


test('Engine floor and ceiling on a 06:00-24:00 line use the due DAY, not the next-day-00:00 close (R-I6)', () => {
  const all = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setMasterData({ plants: [{ plant: 'P24', max_pull_forward_days: 3, max_push_forward_days: 1 }], lines: [{ machine: 'L24', plant: 'P24' }] }, 'unit-test');
  const hours = all([6, 24]);
  Util.setDueCalendarResolver(line => (line === 'L24' ? { lineHours: hours, plantHours: hours, plant: 'P24', rev: 1 } : null));
  try {
  const task = { PLANT: 'P24', MACHINE: 'L24', original_end_date: new Date(2026, 7, 17, 0, 0, 0) };
  assert.equal(+Util.sapDueDate(task), +new Date(2026, 7, 18, 0, 0, 0), 'precondition: the due is the exclusive close');
  const floor = Engine.earliestAllowedStart(task, 'P24');
  assert.deepEqual([floor.getMonth(), floor.getDate(), floor.getHours()], [7, 14, 0], 'due day 17 Aug minus 3 days');
  const ceiling = Engine.latestAllowedEnd(task, 'P24');
  assert.deepEqual([ceiling.getMonth(), ceiling.getDate(), ceiling.getHours()], [7, 19, 0], 'due day 17 Aug + 1 + 1 days');
  } finally { Util.setDueCalendarResolver(null); }
});

test('Engine leaves undated orders and disabled pull-forward limits unrestricted', () => {
  Store.setMasterData({ plants: [{ plant: 'OPEN', max_pull_forward_days: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.earliestAllowedStart({ PLANT: 'OPEN', BASIC_FINISH_DATE: new Date('2026-08-17') }, 'OPEN'), null);
  Store.setMasterData({ plants: [{ plant: 'OPEN', max_pull_forward_days: 0 }], lines: [] }, 'unit-test');
  assert.equal(Engine.earliestAllowedStart({ PLANT: 'OPEN' }, 'OPEN'), null);
});

test('Engine derives a due-date-day push-forward ceiling using calendar days', () => {
  Store.setMasterData({ plants: [{ plant: 'PUSH', max_push_forward_days: 7 }], lines: [] }, 'unit-test');
  const ceiling = Engine.latestAllowedEnd(
    { PLANT: 'PUSH', original_end_date: new Date('2026-08-17T18:30:00') },
    'PUSH',
  );
  assert.deepEqual(
    [ceiling?.getFullYear(), ceiling?.getMonth(), ceiling?.getDate(), ceiling?.getHours()],
    [2026, 7, 25, 0],
    'seven calendar days after the due-date calendar day, at local midnight rather than 168 elapsed hours later',
  );
  const dstCeiling = Engine.latestAllowedEnd(
    { PLANT: 'PUSH', original_end_date: new Date('2026-03-05T12:00:00') },
    'PUSH',
  );
  assert.deepEqual([dstCeiling?.getMonth(), dstCeiling?.getDate(), dstCeiling?.getHours()], [2, 13, 0],
    'crossing daylight saving still adds seven calendar days and lands at local midnight');
});

test('Engine push-forward ceiling: zero means end of due day; unset/undated are unrestricted', () => {
  Store.setMasterData({ plants: [{ plant: 'PUSH', max_push_forward_days: 0 }], lines: [] }, 'unit-test');
  const ceiling = Engine.latestAllowedEnd(
    { PLANT: 'PUSH', original_end_date: new Date('2026-08-17T18:30:00') },
    'PUSH',
  );
  assert.deepEqual(
    [ceiling?.getFullYear(), ceiling?.getMonth(), ceiling?.getDate(), ceiling?.getHours()],
    [2026, 7, 18, 0],
    'zero days means end of the due day itself',
  );

  Store.setMasterData({ plants: [{ plant: 'PUSH', max_push_forward_days: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.latestAllowedEnd({ PLANT: 'PUSH', original_end_date: new Date('2026-08-17') }, 'PUSH'), null,
    'null limit is unrestricted');

  Store.setMasterData({ plants: [{ plant: 'PUSH', max_push_forward_days: 7 }], lines: [] }, 'unit-test');
  assert.equal(Engine.latestAllowedEnd({ PLANT: 'PUSH' }, 'PUSH'), null,
    'no due date is unrestricted');

  Store.setMasterData({ plants: [{ plant: 'PUSH', max_push_forward_days: -1 }], lines: [] }, 'unit-test');
  assert.equal(Engine.latestAllowedEnd({ PLANT: 'PUSH', original_end_date: new Date('2026-08-17') }, 'PUSH'), null,
    'negative limit is unrestricted');
});

// ---------------------------------------------------------------------------
// B3 (2026-08-21) — plant-configurable productive-segment floor.
// ---------------------------------------------------------------------------


test('Engine.minProductiveSegmentMinutesFor resolves the plant override and falls back to the default', () => {
  Store.setMasterData({ plants: [{ plant: 'SEG', min_productive_segment_minutes: 15 }], lines: [] }, 'unit-test');
  assert.equal(Engine.minProductiveSegmentMinutesFor('SEG'), 15,
    'a plant-configured positive integer floor must be honored');

  Store.setMasterData({ plants: [{ plant: 'SEG', min_productive_segment_minutes: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.minProductiveSegmentMinutesFor('SEG'), MIN_PRODUCTIVE_SEGMENT_MINUTES,
    'a null override must fall back to the exported default');

  Store.setMasterData({ plants: [{ plant: 'SEG', min_productive_segment_minutes: 0 }], lines: [] }, 'unit-test');
  assert.equal(Engine.minProductiveSegmentMinutesFor('SEG'), MIN_PRODUCTIVE_SEGMENT_MINUTES,
    'a non-positive override must fall back to the exported default, not disable the floor');

  assert.equal(Engine.minProductiveSegmentMinutesFor('UNKNOWN'), MIN_PRODUCTIVE_SEGMENT_MINUTES,
    'an absent plant row must fall back to the exported default');
});

// ---------------------------------------------------------------------------
// capAwareSequence tests — deadline-respecting SPT sequencer
// ---------------------------------------------------------------------------

test('capAwareSequence returns the input unchanged when no task has a ceiling', () => {
  const tasks = [
    { id: 'A', runMs: 1 * 3600_000, ceilingMs: null },
    { id: 'B', runMs: 2 * 3600_000, ceilingMs: null },
    { id: 'C', runMs: 3 * 3600_000, ceilingMs: null },
  ];
  const result = capAwareSequence(
    tasks,
    0,
    (t) => t.ceilingMs,
    (t) => t.runMs,
  );
  assert.deepEqual(result.map(t => t.id), ['A', 'B', 'C'],
    'returns input in original order when no ceilings exist');
  assert.notStrictEqual(result, tasks, 'does not return the same array reference');
});

test('capAwareSequence pulls a threatened, savable order ahead of shorter SPT work', () => {
  const tasks = [
    { id: 'A', runMs: 1 * 3600_000, ceilingMs: null },
    { id: 'B', runMs: 2 * 3600_000, ceilingMs: null },
    { id: 'C', runMs: 5 * 3600_000, ceilingMs: 7 * 3600_000 },  // latestStart = 2h
  ];
  const result = capAwareSequence(
    tasks,
    0,
    (t) => t.ceilingMs,
    (t) => t.runMs,
  );
  assert.deepEqual(result.map(t => t.id), ['A', 'C', 'B'],
    'after A (ends at 1h), cursor is at 1h; placing B would end at 3h > C\'s latestStart 2h, so C is at risk and preempted; then B');
});

test('capAwareSequence leaves an unreachable ceiling in SPT order and ignores zero-runtime tasks', () => {
  const tasks = [
    { id: 'A', runMs: 1 * 3600_000, ceilingMs: null },
    { id: 'Z', runMs: 0, ceilingMs: null },
    { id: 'C', runMs: 5 * 3600_000, ceilingMs: 3 * 3600_000 },  // latestStart = -2h < cursor 0, not savable
  ];
  const result = capAwareSequence(
    tasks,
    0,
    (t) => t.ceilingMs,
    (t) => t.runMs,
  );
  assert.deepEqual(result.map(t => t.id), ['A', 'Z', 'C'],
    'C is unreachable (latestStart < cursor), Z has zero runtime; both stay in SPT order');
});

// ---------------------------------------------------------------------------
// Workstream C2 (2026-08-20) — plant frozen horizon.
//
// Engine.isFrozenHorizon/frozenHorizonEnd/applyFrozenFloor and the extended
// Engine.earliestAllowedStart read Store.frozenHorizonEnd — a plain Date the
// frontend never computes itself (see db.compute_frozen_horizon_end). These
// tests set/restore that field directly, mirroring how the pull-forward
// tests above set/restore Store.masterData.
// ---------------------------------------------------------------------------


test('Engine.isFrozenHorizon/frozenHorizonEnd/applyFrozenFloor read Store.frozenHorizonEnd directly', () => {
  const priorEnd = Store.frozenHorizonEnd;
  // A fixed reference "now" passed explicitly to isFrozenHorizon throughout,
  // so this test is deterministic regardless of the real wall clock (no
  // reliance on real-time "today" the way an earlier version implicitly did).
  const now = new Date('2026-08-20T08:00:00');
  try {
    Store.setFrozenHorizonEnd(null, 'unit-test');
    assert.equal(Engine.frozenHorizonEnd(), null);
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-22T09:00:00') }, now), false);
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: null }, now), false, 'an order with no start is never frozen');
    assert.deepEqual(Engine.applyFrozenFloor(new Date('2026-08-22T09:00:00')), new Date('2026-08-22T09:00:00'));

    const frozenEnd = new Date('2026-08-25T00:00:00');
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    assert.equal(Engine.frozenHorizonEnd().getTime(), frozenEnd.getTime());
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-22T09:00:00') }, now), true,
      'start inside [now, end) is frozen (OD-C2a)');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: now }, now), true, 'start exactly AT now is frozen -- inclusive lower bound');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: frozenEnd }, now), false,
      'start AT the boundary is not frozen -- it is the earliest allowed instant');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-26T00:00:00') }, now), false);
    // C2 fix (regression this closes): an already-overdue order -- however
    // long ago -- must NOT read as frozen just because it's also before the
    // upper bound. The frozen window is [now, end), not (-infinity, end).
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-18T00:00:00') }, now), false,
      'already-overdue (before now) is not frozen even though it is before the boundary too');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2020-01-01T00:00:00') }, now), false,
      'an order overdue by years is still not frozen -- no lower bound would wrongly pin it forever');
    assert.equal(Engine.applyFrozenFloor(new Date('2026-08-22T09:00:00')).getTime(), frozenEnd.getTime(),
      'a candidate before the boundary is pushed forward to it');
    assert.equal(Engine.applyFrozenFloor(new Date('2026-08-26T09:00:00')).getTime(), new Date('2026-08-26T09:00:00').getTime(),
      'a candidate already past the boundary is left alone');
  } finally {
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});


test('Engine.isFrozenHorizon requires BOTH bounds — an already-overdue order is never frozen, no matter how old (regression closed)', () => {
  // This is the exact defect the C2 review caught: an earlier version of
  // isFrozenHorizon checked only `start_date < end`, which is trivially true
  // for ANY past date, silently treating every genuinely-overdue order as
  // frozen/immovable at all ~11 placement sites this task touches (not just
  // removeBacklog). The frozen window is a near-term BAND [now, end) --
  // matching the Timeline's `.frozen-horizon-zone` band shape exactly -- not
  // a from-time-zero cutoff like C1's visibility gate.
  const priorEnd = Store.frozenHorizonEnd;
  const now = new Date('2026-08-20T08:00:00');
  const frozenEnd = new Date('2026-08-23T00:00:00');
  try {
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-19T09:00:00') }, now), false,
      'yesterday is not frozen');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-01T00:00:00') }, now), false,
      'three weeks overdue is not frozen');
    assert.equal(Engine.isFrozenHorizon({ user_scheduled: true, start_date: new Date('2026-08-21T09:00:00') }, now), true,
      'tomorrow, genuinely inside [now, end), IS frozen -- the lower bound does not overcorrect into never firing');
  } finally {
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});


test('Engine.earliestAllowedStart folds the frozen-horizon floor in as an ADDITIONAL floor, maxed with pull-forward (C2)', () => {
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  try {
    // No pull-forward, no due date -- floor comes ONLY from the frozen window.
    Store.setMasterData({ plants: [{ plant: 'FZ', max_pull_forward_days: null }], lines: [] }, 'unit-test');
    const frozenEnd = new Date('2026-08-25T00:00:00');
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    assert.equal(Engine.earliestAllowedStart({ PLANT: 'FZ' }, 'FZ').getTime(), frozenEnd.getTime());

    // Pull-forward floor is LATER than the frozen floor -- pull-forward wins.
    Store.setMasterData({ plants: [{ plant: 'FZ', max_pull_forward_days: 2 }], lines: [] }, 'unit-test');
    const laterDue = { PLANT: 'FZ', original_end_date: new Date('2026-09-05T18:00:00') };
    const pullForwardFloor = Engine.earliestAllowedStart(laterDue, 'FZ');
    assert.ok(pullForwardFloor.getTime() > frozenEnd.getTime());

    // Frozen floor is LATER than the pull-forward floor -- frozen wins.
    const soonDue = { PLANT: 'FZ', original_end_date: new Date('2026-08-21T18:00:00') };
    const frozenWins = Engine.earliestAllowedStart(soonDue, 'FZ');
    assert.equal(frozenWins.getTime(), frozenEnd.getTime());

    // Frozen horizon off -- reverts to pure pull-forward behavior (parity
    // with the pre-C2 test above).
    Store.setFrozenHorizonEnd(null, 'unit-test');
    assert.equal(Engine.earliestAllowedStart({ PLANT: 'FZ' }, 'FZ'), null,
      'no due date and frozen horizon off -- unrestricted, exactly as before C2');
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});


test('Engine.manualSchedulePatchFor is NOT blocked by the frozen horizon (OD-C2c: manual drags are always free) -- dragging INTO the window', () => {
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const plant = 'FZ-MANUAL-PLANT';
  const line = 'FZ-MANUAL-LINE';
  Store.setMasterData({
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never', timezone: LOCAL_TZ }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setFrozenHorizonEnd(new Date('2026-08-25T00:00:00'), 'unit-test');
  const restoreClock = pinPlantClock('2026-08-20T09:00:00');
  try {
    // The drop is a FINISH now (Monday 10:00, inside the frozen window); the 1 h run time puts the start at 09:00.
    const requestedFinish = new Date('2026-08-24T10:00:00');
    const task = { id: 'manual-drag-task', PLANT: plant, MACHINE: line, RUN_TIME: '1' };
    const patch = Engine.manualSchedulePatchFor(task, line, requestedFinish);
    assert.ok(patch, 'a manual drag must still produce a patch even though the target finish is inside the frozen window');
    assert.equal(patch.end_date.getTime(), requestedFinish.getTime(),
      'the manual drag holds the requested finish EXACTLY, unfloored -- proving OD-C2c');
    assert.equal(patch.start_date.getTime(), new Date('2026-08-24T09:00:00').getTime(), 'the start is derived');
  } finally {
    restoreClock();
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});


test('Engine.manualSchedulePatchFor is NOT blocked by the frozen horizon (OD-C2c: manual drags are always free) -- dragging OUT of the window', () => {
  // Whole-branch review companion to the INTO case above: the exemption is direction-agnostic --
  // manualSchedulePatchFor never reads the frozen horizon at all, so a task that is already sitting
  // inside the frozen window must land exactly at a requested finish OUTSIDE the window too.
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const plant = 'FZ-MANUAL-PLANT-OUT';
  const line = 'FZ-MANUAL-LINE-OUT';
  Store.setMasterData({
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never', timezone: LOCAL_TZ }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  const frozenEnd = new Date('2026-08-25T00:00:00');
  Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
  const restoreClock = pinPlantClock('2026-08-20T09:00:00');
  try {
    const currentStart = new Date('2026-08-24T09:00:00'); // currently inside the frozen window
    const requestedFinish = new Date('2026-08-27T10:00:00'); // requested finish OUTSIDE the window
    const task = {
      id: 'manual-drag-task-out', PLANT: plant, MACHINE: line, RUN_TIME: '1',
      start_date: currentStart, end_date: new Date(currentStart.getTime() + 60 * 60 * 1000),
    };
    const patch = Engine.manualSchedulePatchFor(task, line, requestedFinish);
    assert.ok(patch, 'a manual drag out of the frozen window must still produce a patch');
    assert.equal(patch.end_date.getTime(), requestedFinish.getTime(),
      'the manual drag holds the requested finish exactly -- same unconditional exemption as the into-window case');
  } finally {
    restoreClock();
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Engine.firmingStatus — union of frozen/manual/running firming reasons (SAP firm is display-only).
// ---------------------------------------------------------------------------


test('Engine.firmingStatus reports each reason alone, a combination, and none', () => {
  const priorEnd = Store.frozenHorizonEnd;
  const now = new Date('2026-08-20T08:00:00');
  try {
    Store.setFrozenHorizonEnd(null, 'unit-test');

    // No reasons at all.
    Store.setTasks([{ id: 'firming-none', RUN_TIME: '1', user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') }], 'unit-test');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-none'], now), { firmed: false, reasons: [] });

    // SAP firm is display-only: never a reason, never firmed.
    Store.setTasks([{ id: 'firming-ecc', RUN_TIME: '1', ecc_firmed: true, user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') }], 'unit-test');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-ecc'], now), { firmed: false, reasons: [] });
    assert.equal(Engine.isSapFirmed(Store.tasks['firming-ecc']), true);
    assert.equal(Engine.isSapFirmed({ id: 'plain' }), false);

    // 'running' alone -- start <= now < end, both set; boundaries are half-open.
    const runStart = new Date('2026-08-20T06:00:00'), runEnd = new Date('2026-08-20T10:00:00');
    Store.setTasks([{ id: 'firming-run', RUN_TIME: '4', ecc_firmed: true, user_scheduled: true, start_date: runStart, end_date: runEnd }], 'unit-test');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-run'], now), { firmed: true, reasons: ['running'] });
    assert.equal(Engine.isInProgress(Store.tasks['firming-run'], runStart), true, 'start boundary is inclusive');
    assert.equal(Engine.isInProgress(Store.tasks['firming-run'], runEnd), false, 'end boundary is exclusive');
    assert.equal(Engine.isInProgress({ id: 'x', user_scheduled: true, start_date: runStart, end_date: null }, now), false, 'missing end is never running');
    assert.equal(Engine.isInProgress({ id: 'x', user_scheduled: true, start_date: null, end_date: runEnd }, now), false, 'missing start is never running');

    // 'frozen' alone -- inside the horizon band, not manually firmed, not ECC-firmed.
    const frozenEnd = new Date('2026-08-25T00:00:00');
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    Store.setTasks([{ id: 'firming-frozen', RUN_TIME: '1', user_scheduled: true, start_date: new Date('2026-08-22T09:00:00') }], 'unit-test');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-frozen'], now), { firmed: true, reasons: ['frozen'] });
    Store.setFrozenHorizonEnd(null, 'unit-test');

    // 'manual' alone -- reflects Store.isFirmed (set via setFirmed), not a stale task.firmed property.
    Store.setTasks([{ id: 'firming-manual', RUN_TIME: '1', firmed: false, user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') }], 'unit-test');
    Store.setFirmed('firming-manual', true, 'unit-test');
    assert.equal(Store.tasks['firming-manual'].firmed, true, 'setFirmed also mirrors onto task.firmed');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-manual'], now), { firmed: true, reasons: ['manual'] });
    // Prove the read is live off Store.isFirmed, not a cached task.firmed: force
    // task.firmed stale (true) while firmedIds no longer contains the id.
    Store.tasks['firming-manual'].firmed = true;
    Store.firmedIds.delete('firming-manual');
    assert.equal(Store.isFirmed('firming-manual'), false);
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-manual'], now), { firmed: false, reasons: [] },
      'firmingStatus must follow Store.isFirmed, not a stale task.firmed mirror');

    // Combination -- frozen + manual + running at once (frozen needs start >= now, so use a later "now" for running via end).
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    Store.setTasks([{ id: 'firming-all', RUN_TIME: '1', ecc_firmed: true, user_scheduled: true, start_date: new Date('2026-08-22T09:00:00') }], 'unit-test');
    Store.setFirmed('firming-all', true, 'unit-test');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-all'], now), { firmed: true, reasons: ['frozen', 'manual'] });
    const atStart = new Date('2026-08-22T09:00:00');
    Store.tasks['firming-all'].end_date = new Date('2026-08-22T10:00:00');
    assert.deepEqual(Engine.firmingStatus(Store.tasks['firming-all'], atStart), { firmed: true, reasons: ['frozen', 'manual', 'running'] });
  } finally {
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});


test('Engine.runAndApply("spt") leaves an order starting inside the frozen window untouched and never places another order into it (Step 8: setup-aware path)', () => {
  const plant = 'FZ-SPT-PLANT';
  const line = 'FZ-SPT-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const priorCalendar = Store.calendars[line];
  const priorSetup = Store.setupSnapshot;
  const ALL_DAY = { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot(null, 'unit-test'); // no active setup -- uses the synthetic zero-cost setup-aware path
  Store.setMasterData({
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setCalendar(line, ALL_DAY, 'unit-test');
  const frozenEnd = new Date('2026-08-25T00:00:00');
  Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
  // Pinned explicitly via opts.startDate below (this run's "now" for
  // isAged/isOutOfWin/isFrozenHorizon alike) so this test is deterministic
  // regardless of the real wall clock -- not implicitly tied to whatever day
  // it happens to run on.
  const horizonStart = new Date('2026-08-20T08:00:00');

  const frozenStart = new Date('2026-08-22T09:00:00'); // inside [horizonStart, frozenEnd)
  const frozenTaskEnd = new Date('2026-08-22T10:00:00');
  Store.setTasks([
    { id: 'spt-frozen-in-place', PLANT: plant, MACHINE: line, RUN_TIME: '1', user_scheduled: true, start_date: frozenStart, end_date: frozenTaskEnd },
    { id: 'spt-movable-free', PLANT: plant, MACHINE: line, RUN_TIME: '1', user_scheduled: true, start_date: new Date('2026-08-30T09:00:00'), end_date: new Date('2026-08-30T10:00:00') },
  ], 'unit-test');

  try {
    Engine.runAndApply('spt', { plant, respectFirmed: true, respectCalendar: true, startDate: horizonStart, runNow: horizonStart });
    assert.equal(Store.tasks['spt-frozen-in-place'].start_date.getTime(), frozenStart.getTime(),
      'an order already starting inside the frozen window is left EXACTLY where it was -- never rescheduled into or through the window');
    assert.equal(Store.tasks['spt-frozen-in-place'].end_date.getTime(), frozenTaskEnd.getTime());
    assert.ok(Store.tasks['spt-movable-free'].start_date.getTime() >= frozenEnd.getTime(),
      'a movable order is never (re)placed with a start inside the frozen window');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


test('Engine.autoReflow leaves a frozen-window peer exactly in place even when it would otherwise be pushed by an overlapping predecessor (Step 8: autoReflow)', () => {
  const plant = 'FZ-REFLOW-PLANT';
  const line = 'FZ-REFLOW-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const priorCalendar = Store.calendars[line];
  const priorSetup = Store.setupSnapshot;
  const ALL_DAY = { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot(null, 'unit-test');
  Store.setMasterData({
    plants: [{ plant, split_order_policy: 'never', timezone: LOCAL_TZ }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setCalendar(line, ALL_DAY, 'unit-test');
  // autoReflow has no injectable "now" (unlike runAndApply/removeBacklog),
  // so this test's dates are built RELATIVE to the real wall clock at run
  // time (Date.now()) rather than hardcoded calendar literals -- a fixed
  // "near future" date would eventually become "already past" as real time
  // advances, which is exactly the kind of fixture the C2 review flagged.
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const frozenEnd = new Date(Date.now() + 3 * DAY);
  Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');

  const anchor = new Date(Date.now() + 1 * DAY); // tomorrow -- genuinely inside [now, frozenEnd)
  anchor.setMinutes(0, 0, 0);
  const changedStart = anchor;
  const changedEnd = new Date(anchor.getTime() + 1.5 * HOUR);
  const peerStart = new Date(anchor.getTime() + 1.25 * HOUR); // 15 min before changedEnd -- genuine overlap
  const peerEnd = new Date(peerStart.getTime() + 1 * HOUR);
  Store.setTasks([
    // The manually-dragged trigger: OD-C2c means the drag itself is never
    // blocked, and it is extended (1.5h) so it genuinely OVERLAPS the
    // frozen peer below -- without the C2 pinning check, autoReflow's
    // "already fits" shortcut would not apply and the peer would be pushed.
    { id: 'reflow-changed', PLANT: plant, MACHINE: line, RUN_TIME: '1.5',
      user_scheduled: true, start_date: changedStart, end_date: changedEnd },
    { id: 'reflow-frozen-peer', PLANT: plant, MACHINE: line, RUN_TIME: '1',
      user_scheduled: true, start_date: peerStart, end_date: peerEnd },
  ], 'unit-test');

  try {
    Engine.autoReflow('reflow-changed');
    assert.equal(Store.tasks['reflow-frozen-peer'].start_date.getTime(), peerStart.getTime(),
      'a peer already starting inside the frozen window is never moved by autoReflow, even to resolve a genuine overlap');
    assert.equal(Store.tasks['reflow-frozen-peer'].end_date.getTime(), peerEnd.getTime());
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


test('changeover advances to a future order pull-forward floor instead of stalling on an ineligible queue', () => {
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
    const now = new Date('2035-08-06T08:00:00');
    Store.setMasterData({
      plants: [{ plant: 'PULL', max_pull_forward_days: 7 }],
      lines: [{ plant: 'PULL', machine: 'L1' }],
    }, 'child-test');
    Store.setSelectedPlant('PULL', 'child-test');
    Store.replaceCalendars({ L1: { workHours: hours } }, 'child-test');
    Store.replacePlants({ PULL: { workHours: hours } }, 'child-test');
    // B3a (2026-08-21): 'changeover' now always routes through the
    // setup-aware evaluator (real snapshot or a synthetic zero-cost one).
    // That evaluator preserves an order that is ALREADY scheduled (real
    // start_date/end_date) as its line's "current first order" anchor when
    // no persisted machine setup state exists (setup-domain.mts's
    // initialScheduledAnchor) -- deliberately never rewriting a physical
    // predecessor. Leaving start_date/end_date null (as a freshly-created
    // order would be) keeps this order a genuinely free candidate, so the
    // pull-forward floor this test targets is still the thing that decides
    // its placement, not the anchor-preservation rule.
    Store.setTasks([{
      id: 'future-order', PLANT: 'PULL', MACHINE: 'L1', RUN_TIME: 2,
      original_end_date: new Date('2035-08-17T18:00:00'),
      start_date: null, end_date: null,
    }], 'child-test');
    const result = Engine.evaluateSchedule('changeover', {
      plant: 'PULL', startDate: now, endDate: new Date('2035-08-31T18:00:00'), now,
      respectFirmed: true, respectCalendar: true,
    }, snapshotSchedule());
    const patch = result.patches.find(candidate => candidate.id === 'future-order');
    const start = patch?.changes.start_date;
    console.log(JSON.stringify({
      year: start?.getFullYear(), month: start?.getMonth(), date: start?.getDate(), hour: start?.getHours(),
    }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  assert.deepEqual(JSON.parse(run.stdout.trim()), { year: 2035, month: 7, date: 10, hour: 8 });
});


test('changeover leaves a permanently-uncalendarable order unplaced (surfaced, never silent) instead of using the retired legacy force-placement escape hatch', () => {
  // B3a (2026-08-21): this test used to pin the LEGACY day-integrity
  // dispatcher's FORCE_PLACE_AFTER_DAYS escape hatch (Engine.
  // _dispatchDayIntegrity, deleted by this task) -- a mechanism that, after
  // 90 consecutive empty calendar days, force-placed an order by bypassing
  // fitsAt() entirely, i.e. placing it into a calendar slot that violates
  // the calendar. 'changeover' now always routes through the setup-aware
  // evaluator (setup-scheduler.mjs), which has no equivalent: a line whose
  // calendar is closed EVERY day, forever, is never a valid placement
  // target, so the order is correctly left unplaced (no patch) rather than
  // forced into an impossible slot -- and that fact is surfaced via
  // explanation/missingEdges (and, at the live runAndApply layer, the
  // "orders left in place" toast for a real/active plant), never silently
  // dropped. This is arguably safer than the old escape hatch, not merely
  // "different" -- it never violates the calendar it was told to respect.
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const closed = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, null]));
    const now = new Date('2035-08-06T08:00:00');
    Store.setMasterData({
      plants: [{ plant: 'PULL', max_pull_forward_days: 100 }],
      lines: [{ plant: 'PULL', machine: 'L1' }],
    }, 'child-test');
    Store.setSelectedPlant('PULL', 'child-test');
    Store.replaceCalendars({ L1: { workHours: closed } }, 'child-test');
    Store.replacePlants({ PULL: { workHours: closed } }, 'child-test');
    Store.setTasks([{
      id: 'long-wait-order', PLANT: 'PULL', MACHINE: 'L1', RUN_TIME: 2,
      original_end_date: new Date('2036-02-22T18:00:00'),
      start_date: null, end_date: null,
    }, {
      id: 'undated-order', PLANT: 'PULL', MACHINE: 'L1', RUN_TIME: 2,
      original_end_date: null,
      start_date: null, end_date: null,
    }], 'child-test');
    const result = Engine.evaluateSchedule('changeover', {
      plant: 'PULL', startDate: now, endDate: new Date('2036-04-01T18:00:00'), now,
      respectFirmed: true, respectCalendar: true,
    }, snapshotSchedule());
    const patch = result.patches.find(candidate => candidate.id === 'long-wait-order');
    console.log(JSON.stringify({
      hasPatch: !!patch && patch.changes.planning_status !== 'needs_planning',
      surfaced: result.missingEdges.length > 0 || result.explanation.some(e => e.taskId === 'long-wait-order'),
    }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.hasPatch, false,
    'a permanently closed calendar must never be violated by a forced placement');
  assert.equal(output.surfaced, true,
    'leaving the order unplaced must be surfaced in the result, never a silent drop');
});


test('Engine exposes the documented public API and no DOM-dependent surprises', () => {
  assert.equal(typeof Engine.runAndApply, 'function');
  assert.equal(typeof Engine.autoReflow, 'function');
  assert.equal(typeof Engine.constraintEnabled, 'function');
  assert.ok(Array.isArray(Engine.CONSTRAINT_CATALOG));
});


test('Engine.runAndApply no-ops with a toast when there are no tasks', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  assert.doesNotThrow(() => Engine.runAndApply('spt'));
});


test('Engine.autoReflow reserves a covered incoming setup before moving a downstream peer', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-17T00:00:00') });
  // This fails if reflow only protects productive runtime: the blue successor
  // would land at 09:00 instead of leaving the required red->blue setup slot.
  const line = 'SETUP-REFLOW-LINE';
  const plant = 'SETUP-REFLOW-PLANT';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1,
      from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
    machine_rows: [], machine_states: [], overrides: [],
  }, 'unit-test');
  Store.setTasks([
    { id: 'reflow-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED', start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') },
    { id: 'reflow-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE', start_date: new Date('2026-08-17T09:15:00'), end_date: new Date('2026-08-17T10:15:00') },
  ], 'unit-test');
  try {
    Engine.autoReflow('reflow-red');
    assert.equal(Store.tasks['reflow-red'].end_date.getTime(), new Date('2026-08-17T09:00:00').getTime(),
      'the manually dropped production order remains exactly where the user put it');
    assert.equal(Store.tasks['reflow-blue'].start_date.getTime(), new Date('2026-08-17T09:30:00').getTime());
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


test('Engine.autoReflow resolves equal-start successors by id before reserving setup', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-17T00:00:00') });
  // This fails if equal starts retain object insertion order: z-first would
  // put Z at 09:30 instead of preserving A's valid 09:15 slot first.
  const line = 'SETUP-TIE-LINE';
  const plant = 'SETUP-TIE-PLANT';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], setup_min: 10 },
      { machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 60 },
      { machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 },
    ],
    machine_rows: [], machine_states: [], overrides: [],
  }, 'unit-test');
  // Deliberately opposite to the expected id tie-break order.
  Store.setTasks([
    { id: 'tie-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED', start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') },
    { id: 'z-successor', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE', start_date: new Date('2026-08-17T09:15:00'), end_date: new Date('2026-08-17T10:15:00') },
    { id: 'a-successor', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'GREEN', start_date: new Date('2026-08-17T09:15:00'), end_date: new Date('2026-08-17T10:15:00') },
  ], 'unit-test');
  try {
    Engine.autoReflow('tie-red');
    assert.equal(Store.tasks['a-successor'].start_date.getTime(), new Date('2026-08-17T09:15:00').getTime());
    assert.equal(Store.tasks['z-successor'].start_date.getTime(), new Date('2026-08-17T11:15:00').getTime());
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


test('Engine.evaluateSchedule snapshots the live read model without publishing a candidate', () => {
  Store.setTasks([
    { id: 'detached-long', MACHINE: 'L1', PLANT: 'DETACHED', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'detached-short', MACHINE: 'L1', PLANT: 'DETACHED', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('DETACHED', 'unit-test');
  Store.setFirmed('detached-long', true, 'unit-test');
  Store.setAlerts([{ id: 'detached-alert', type: 'overlap', sev: 'err' }], 'unit-test');
  const beforeRev = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const beforeFirmed = Array.from(Store.firmedIds).sort();
  const beforeAlerts = structuredClone(Store.alerts);
  let publications = 0;
  const unsubscribe = Store.subscribe(() => { publications++; }, 'unit-test-autosave');

  try {
    const candidate = Engine.evaluateSchedule('spt', {
      respectCalendar: false,
      now: new Date('2026-08-03T08:00:00'),
    });
    assert.deepEqual(candidate.patches.map(patch => patch.id), ['detached-short'],
      'firmed work remains an immutable candidate boundary');
    assert.equal(Store.rev(), beforeRev);
    assert.deepEqual(Store.tasks, beforeTasks);
    assert.deepEqual(Array.from(Store.firmedIds).sort(), beforeFirmed);
    assert.deepEqual(Store.alerts, beforeAlerts);
    assert.equal(publications, 0, 'candidate evaluation must not wake autosave-style subscribers');

    const captured = snapshotSchedule();
    captured.tasks[0].RUN_TIME = '999';
    assert.equal(Store.tasks['detached-long'].RUN_TIME, '5', 'snapshot values must not alias Store task objects');
    assert.equal(captured.readModelVersion, String(Store.rev()), 'a snapshot records the read-model revision used for apply validation');
  } finally {
    unsubscribe();
  }
});

test('snapshotSchedule scopes a reused line calendar by the task-resolved plant', () => {
  const plant = 'SNAPSHOT-TASK-PLANT';
  const mappedPlant = 'SNAPSHOT-MAPPED-PLANT';
  const line = 'SNAPSHOT-REUSED-LINE';
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorCalendars = structuredClone(Store.calendars);
  try {
    // Master data points the reused machine at another plant, while the task
    // carries the authoritative plant selected for this candidate. The
    // detached scheduler makes the same task-level choice.
    Store.setMasterData({
      plants: [{ plant }, { plant: mappedPlant }],
      lines: [{ machine: line, plant: mappedPlant }],
    }, 'unit-test');
    Store.replaceCalendars({
      ...structuredClone(priorCalendars),
      [line]: { workHours: { 1: [0, 24] } },
    }, 'unit-test');
    Store.setTasks([{ id: 'snapshot-reused-task', PLANT: plant, MACHINE: line, RUN_TIME: 1,
      start_date: null, end_date: null }], 'unit-test');

    const captured = snapshotSchedule(plant);
    assert.ok(captured.calendars[line],
      'a direct task plant must retain the line calendar even when line metadata maps elsewhere');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
  }
});

test('snapshotSchedule(plant) clones only that plant\'s (and un-stamped) blackout blocks (#39)', () => {
  const priorBlocks = structuredClone(Store.blocks);
  const priorPlantBlocks = structuredClone(Store.plantBlocks);
  try {
    const mk = (id, plant) => ({ id, plant, line: null, start: '2030-01-01T00:00:00', end: '2030-01-01T01:00:00' });
    Store.replaceBlocks([mk('b-a', 'P-A'), mk('b-b', 'P-B'), mk('b-g', undefined)], 'unit-test');
    Store.replacePlantBlocks([mk('pb-a', 'P-A'), mk('pb-b', 'P-B')], 'unit-test');
    const scoped = snapshotSchedule('P-A');
    assert.deepEqual(scoped.blocks.map(b => b.id), ['b-a', 'b-g']);
    assert.deepEqual(scoped.plantBlocks.map(b => b.id), ['pb-a']);
    const whole = snapshotSchedule();
    assert.equal(whole.blocks.length, 3);
    assert.equal(whole.plantBlocks.length, 2);
  } finally {
    Store.replaceBlocks(priorBlocks, 'unit-test');
    Store.replacePlantBlocks(priorPlantBlocks, 'unit-test');
  }
});

test('Engine.evaluateSchedule uses setup truth captured in the detached snapshot', () => {
  const plant = 'DETACHED-SETUP-TRUTH';
  const line = 'DETACHED-SETUP-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorMasterData = structuredClone(Store.masterData);
  const priorCalendar = Store.calendars[line];
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot({
      plant,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1,
        from_key: [{ fieldKey: 'colorWheel', value: 'RED' }],
        to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 60 }],
      machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');
    Store.setTasks([
      { id: 'detached-setup-red', PLANT: plant, MACHINE: line, COLOR: 'RED', RUN_TIME: 1, start_date: null, end_date: null },
      { id: 'detached-setup-blue', PLANT: plant, MACHINE: line, COLOR: 'BLUE', RUN_TIME: 1, start_date: null, end_date: null },
    ], 'unit-test');
    const captured = snapshotSchedule(plant);
    Store.replaceSetupSnapshot({
      plant,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1,
        from_key: [{ fieldKey: 'colorWheel', value: 'RED' }],
        to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 0 }],
      machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');

    const result = Engine.evaluateSchedule('changeover', {
      plant, respectCalendar: false, runNow: new Date('2026-08-03T08:00:00'),
      endDate: new Date('2026-08-04T18:00:00'),
    }, captured);

    assert.equal(result.validationContext?.bounds.setup.plant_rows[0].setup_min, 60,
      'a detached candidate must resolve setup transitions from its captured snapshot');
    assert.equal(result.validationContext?.baselineSnapshot?.setupSnapshot?.plant_rows[0].setup_min, 60,
      'apply validation retains the same captured setup truth');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});

test('Engine.evaluateSchedule keeps planningStart separate from runNow and placementStart', () => {
  const plant = 'CLOCK-SEPARATION';
  const line = 'CLOCK-L1';
  const planningStart = new Date('2035-08-06T06:00:00');
  const runNow = new Date('2035-08-06T10:00:00');
  const horizonEnd = new Date('2035-08-06T18:00:00');
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  try {
    Store.setTasks([{ id: 'clock-queued', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'GREEN', start_date: null, end_date: null }], 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');

    const result = Engine.evaluateSchedule('changeover', {
      plant,
      planningStart,
      runNow,
      endDate: horizonEnd,
      respectCalendar: false,
    });
    const patch = result.patches.find(item => item.id === 'clock-queued' && item.changes.planning_status !== 'needs_planning');
    assert.ok(patch, 'the queued order should receive a detached placement');
    assert.ok(patch.changes.start_date >= runNow,
      'new setup and production must not start before the captured runNow');
    assert.equal(result.validationContext?.bounds.planningStart.getTime(), planningStart.getTime());
    assert.equal(result.validationContext?.bounds.runNow.getTime(), runNow.getTime());
    assert.equal(result.validationContext?.bounds.placementStart.getTime(), runNow.getTime());
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});

test('running orders never move: changeover and autoReflow leave an in-progress order in place, even with respectFirmed off', () => {
  const plant = 'RUN-LOCK-PLANT';
  const line = 'RUN-LOCK-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorEnd = Store.frozenHorizonEnd;
  const priorCalendar = Store.calendars[line];
  const ALL_DAY = { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] };
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setFrozenHorizonEnd(null, 'unit-test');
    Store.setMasterData({ plants: [{ plant, split_order_policy: 'never', timezone: LOCAL_TZ }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setCalendar(line, ALL_DAY, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    const runStart = new Date('2035-08-06T07:00:00');
    const runEnd = new Date('2035-08-06T09:00:00');
    const runNow = new Date('2035-08-06T08:00:00');
    const base = () => ([
      { id: 'run-sap', PLANT: plant, MACHINE: line, RUN_TIME: 2, ecc_firmed: true, user_scheduled: true, start_date: runStart, end_date: runEnd },
      { id: 'run-free', PLANT: plant, MACHINE: line, RUN_TIME: 1, user_scheduled: true, start_date: new Date('2035-08-06T08:30:00'), end_date: new Date('2035-08-06T09:30:00') },
    ]);
    const runOpts = { plant, respectFirmed: false, respectCalendar: true, planningStart: runNow, runNow, endDate: new Date('2035-08-10T00:00:00') };

    // Setup-aware changeover path.
    Store.setTasks(base(), 'unit-test');
    Engine.runAndApply('changeover', { ...runOpts, startDate: runNow });
    assert.equal(Store.tasks['run-sap'].start_date.getTime(), runStart.getTime(), 'changeover must not move a running order');
    assert.equal(Store.tasks['run-sap'].end_date.getTime(), runEnd.getTime());

    // autoReflow: a running peer overlapped by a dragged order stays put (real clock).
    const HOUR = 60 * 60 * 1000;
    const stepMs = 15 * 60 * 1000; // the Store snaps stored times to Config.STEP_MS marks
    const nowSnapped = Math.floor(Date.now() / stepMs) * stepMs;
    const liveStart = new Date(nowSnapped - HOUR);
    const liveEnd = new Date(nowSnapped + HOUR);
    const dragStart = new Date(nowSnapped - 2 * HOUR);
    Store.setTasks([
      { id: 'drag', PLANT: plant, MACHINE: line, RUN_TIME: '2', user_scheduled: true, start_date: dragStart, end_date: new Date(dragStart.getTime() + 2.5 * HOUR) },
      { id: 'live-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', user_scheduled: true, start_date: liveStart, end_date: liveEnd },
    ], 'unit-test');
    Engine.autoReflow('drag');
    assert.equal(Store.tasks['live-peer'].start_date.getTime(), liveStart.getTime(), 'autoReflow must not move a running peer');
    assert.equal(Store.tasks['live-peer'].end_date.getTime(), liveEnd.getTime());
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});

test('Engine setup-aware routing carries respectCalendar into bounds and placement', () => {
  const plant = 'ENGINE-CALENDAR-CONTRACT';
  const line = 'ENGINE-CALENDAR-L1';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorBlocks = structuredClone(Store.blocks);
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setCalendar(line, { 1: [8, 18] }, 'unit-test');
    Store.addBlock({ id: 'engine-calendar-blackout', plant, line, start: new Date('2035-08-06T09:00:00'), end: new Date('2035-08-06T10:00:00') }, 'unit-test');
    Store.replaceSetupSnapshot({
      plant, plant_active: true,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');
    Store.setTasks([{ id: 'engine-calendar-order', PLANT: plant, MACHINE: line, COLOR: 'GREEN', RUN_TIME: 2,
      original_end_date: new Date('2035-08-06T18:00:00'), start_date: null, end_date: null }], 'unit-test');

    const result = Engine.evaluateSchedule('changeover', {
      plant, respectCalendar: false, planningStart: new Date('2035-08-06T08:00:00'),
      runNow: new Date('2035-08-06T08:00:00'), endDate: new Date('2035-08-06T12:00:00'),
    });
    const patch = result.patches.find(item => item.id === 'engine-calendar-order');
    assert.equal(result.validationContext?.bounds.respectCalendar, false,
      'Engine must propagate the calendar contract through the setup-aware route');
    assert.equal(patch?.changes.start_date?.getTime(), new Date('2035-08-06T08:00:00').getTime(),
      'calendar-neutral setup-aware placement must ignore a blackout');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.replaceBlocks(priorBlocks, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});

test('F4: setup-aware iteration cap scales with this plant\'s lines only, even from an unscoped snapshot', () => {
  const plant = 'ENGINE-CAP-A';
  const other = 'ENGINE-CAP-B';
  const lines = ['ENGINE-CAP-A1', 'ENGINE-CAP-A2', 'ENGINE-CAP-A3'];
  const otherLines = ['ENGINE-CAP-B1', 'ENGINE-CAP-B2'];
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({
      plants: [{ plant }, { plant: other }],
      lines: [...lines.map(machine => ({ plant, machine })), ...otherLines.map(machine => ({ plant: other, machine }))],
    }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    const mk = (line, owner, index) => ({
      id: `engine-cap-${line}`, PLANT: owner, MACHINE: line, COLOR: 'GREEN', RUN_TIME: 2,
      original_end_date: new Date(`2035-08-0${index + 1}T18:00:00`), start_date: null, end_date: null,
    });
    Store.setTasks([
      ...lines.map((line, i) => mk(line, plant, i)),
      ...otherLines.map((line, i) => mk(line, other, i)),
    ], 'unit-test');
    const opts = {
      plant, planningStart: new Date('2035-08-01T08:00:00'),
      runNow: new Date('2035-08-01T08:00:00'), endDate: new Date('2035-08-20T12:00:00'),
    };
    // Default snapshot is unscoped: it carries the other plant's tasks too.
    const unscoped = snapshotSchedule();
    assert.equal(unscoped.tasks.length, 5);
    const all = Engine.evaluateSchedule('changeover', opts, unscoped);
    assert.equal(all.validationContext?.bounds.iterationCap, 3 * 20000);
    const scoped = Engine.evaluateSchedule('changeover', { ...opts, lines: lines.slice(0, 2) }, snapshotSchedule(plant));
    assert.equal(scoped.validationContext?.bounds.iterationCap, 2 * 20000);
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
  }
});

test('Engine rejects invalid date inputs, parses date-only bounds as local wall time, and derives placementStart', () => {
  const plant = 'ENGINE-DATE-CONTRACT';
  const line = 'ENGINE-DATE-L1';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    Store.setTasks([{ id: 'engine-date-order', PLANT: plant, MACHINE: line, RUN_TIME: 1,
      start_date: null, end_date: null }], 'unit-test');

    const result = Engine.evaluateSchedule('changeover', {
      plant, startDate: '2035-08-06', endDate: '2035-08-07',
      runNow: '2035-08-06T10:00:00', placementStart: '2035-08-05T00:00:00', respectCalendar: false,
    });
    const planningStart = result.validationContext?.bounds.planningStart;
    const placementStart = result.validationContext?.bounds.placementStart;
    assert.deepEqual(
      [planningStart?.getFullYear(), planningStart?.getMonth(), planningStart?.getDate(), planningStart?.getHours()],
      [2035, 7, 6, 0],
      'date-only planning input must represent local plant midnight rather than UTC-shifted wall time',
    );
    assert.equal(placementStart?.getTime(), new Date('2035-08-06T10:00:00').getTime(),
      'placementStart is derived as max(planningStart, runNow) and ignores an earlier explicit value');
    assert.ok(result.patches.find(item => item.id === 'engine-date-order' && item.changes.start_date >= placementStart));

    const invalid = Engine.evaluateSchedule('changeover', {
      plant, startDate: 'not-a-date', endDate: '2035-08-07', runNow: '2035-08-06T10:00:00',
    });
    assert.equal(invalid.status, 'invalid_horizon');
    assert.deepEqual(invalid.patches, []);
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});

test('optimizer scopes malformed historical intervals before repair eligibility', () => {
  const plant = 'LEGACY-HORIZON-SCOPE';
  const line = 'LEGACY-HORIZON-L1';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setCalendar(line, { 1: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    const historical = {
      id: 'legacy-malformed-historical', PLANT: plant, MACHINE: line, RUN_TIME: 1,
      start_date: new Date('2035-08-04T08:00:00'), end_date: null, planning_status: 'scheduled',
    };
    Store.setTasks([historical], 'unit-test');
    const result = Engine.evaluateSchedule('spt', {
      plant, respectFirmed: true, respectCalendar: false,
      planningStart: new Date('2035-08-06T08:00:00'), runNow: new Date('2035-08-06T08:00:00'),
      endDate: new Date('2035-08-07T00:00:00'),
    });
    assert.equal(result.patches.some(patch => patch.id === historical.id), false,
      'a malformed interval before the half-open planning scope must remain immutable');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
});


test('Engine.evaluateSetupAware forwards only an explicit detached setup request', () => {
  // This fails if Task 3 leaves the pure evaluator unreachable from the
  // Engine seam, or if the seam falls back to Store setup state rather than
  // requiring the caller-supplied setup truth and bounds.
  assert.equal(typeof Engine.evaluateSetupAware, 'function');
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const snapshot = {
    tasks: [{
      id: 'engine-setup-blue', PLANT: 'ENGINE_SETUP', MACHINE: 'L1', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: null, end_date: null, original_end_date: new Date('2026-08-03T10:00:00'),
    }],
    firmedIds: [], alerts: [], selectedPlant: 'ENGINE_SETUP', blocks: [], plantBlocks: [],
    calendars: { L1: { workHours: hours } }, plants: { ENGINE_SETUP: { workHours: hours } },
    lineSettings: {}, masterData: { plants: [{ plant: 'ENGINE_SETUP' }], lines: [{ plant: 'ENGINE_SETUP', machine: 'L1' }] },
    priorityRankMaps: {},
  };
  const bounds = {
    setup: {
      plant: 'ENGINE_SETUP',
      definition: { plant: 'ENGINE_SETUP', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
      machine_rows: [],
      machine_states: [{ machine: 'L1', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
      overrides: [],
    },
    exactSearchThreshold: 2, iterationCap: 2, clock: () => 0, deadline: 1,
    now: new Date('2026-08-03T08:00:00'), horizonEnd: new Date('2026-08-03T18:00:00'),
  };
  const beforeRev = Store.rev();

  const result = Engine.evaluateSetupAware('due-date-first', bounds, snapshot);

  assert.equal(result.patches[0].changes.start_date.getTime(), new Date('2026-08-03T08:05:00').getTime());
  assert.equal(Store.rev(), beforeRev, 'explicit setup candidate routing must not publish to Store');
});


test('Engine.evaluateSetupAware refuses candidates when setup activation is disabled', () => {
  // This fails if a false activation flag can still reach either setup-aware
  // evaluator and produce patches from observation-only setup data.
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const snapshot = {
    tasks: [{
      id: 'disabled-setup-blue', PLANT: 'DISABLED_SETUP', MACHINE: 'L1', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: null, end_date: null, original_end_date: new Date('2026-08-03T10:00:00'),
    }],
    firmedIds: [], alerts: [], selectedPlant: 'DISABLED_SETUP', blocks: [], plantBlocks: [],
    calendars: { L1: { workHours: hours } }, plants: { DISABLED_SETUP: { workHours: hours } },
    lineSettings: {}, masterData: { plants: [{ plant: 'DISABLED_SETUP' }], lines: [{ plant: 'DISABLED_SETUP', machine: 'L1' }] },
    priorityRankMaps: {},
  };
  const bounds = {
    setup: {
      plant: 'DISABLED_SETUP',
      definition: { plant: 'DISABLED_SETUP', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: false }, plant_active: false,
      plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
      machine_rows: [],
      machine_states: [{ machine: 'L1', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
      overrides: [],
    },
    exactSearchThreshold: 2, iterationCap: 2, clock: () => 0, deadline: 1,
    now: new Date('2026-08-03T08:00:00'), horizonEnd: new Date('2026-08-03T18:00:00'),
  };

  assert.throws(() => Engine.evaluateSetupAware('due-date-first', bounds, snapshot), /disabled/i);
});


test('deriveSetupObservation resolves one scoped override interval without invoking Engine', () => {
  // This fails if the worker-facing setup observation is unavailable, resolves
  // an override as its matrix standard, or routes through Engine.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-OBSERVE',
    definition: { plant: 'P-OBSERVE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 0 },
      { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 60 },
    ],
    machine_rows: [],
    machine_states: [{ machine: 'L-OBSERVE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [{
      id: 'override-1', machine: 'L-OBSERVE', signature_version: 1,
      predecessor_order_id: 'red', successor_order_id: 'blue', predecessor_state_key: state('RED'), successor_state_key: state('BLUE'),
      standard_min: 60, remaining_min: 20, status: 'active', reason: 'already started',
    }],
  }, [
    { id: 'red', PLANT: 'P-OBSERVE', MACHINE: 'L-OBSERVE', COLOR: 'RED', RUN_TIME: 1, start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'blue', PLANT: 'P-OBSERVE', MACHINE: 'L-OBSERVE', COLOR: 'BLUE', RUN_TIME: 1, start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
  ], new Set(['L-OBSERVE']));

  assert.deepEqual(observation.intervals.map(interval => ({
    line: interval.line, predecessorOrderId: interval.predecessorOrderId, successorOrderId: interval.successorOrderId,
    start: interval.start.toISOString(), end: interval.end.toISOString(), requiredMinutes: interval.requiredMinutes,
    availableMinutes: interval.availableMinutes,
  })), [{
    line: 'L-OBSERVE', predecessorOrderId: 'red', successorOrderId: 'blue',
    // Zone-independent (M3): the fixtures are naive local wall-clock times, so the expected instants are parsed the same way.
    start: new Date('2026-08-03T09:40:00').toISOString(), end: new Date('2026-08-03T10:00:00').toISOString(), requiredMinutes: 20, availableMinutes: 60,
  }]);
  assert.deepEqual(observation.diagnostics, []);
});


test('deriveSetupObservation keeps inactive setup truth visible without enabling scheduling', () => {
  // This fails if the activation gate suppresses observation-only setup bars,
  // overrides, or missing-pair diagnostics instead of only scheduler routing.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-INACTIVE-OBSERVE',
    definition: { plant: 'P-INACTIVE-OBSERVE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: false }, plant_active: false,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 40 },
      { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 30 },
    ],
    machine_rows: [],
    machine_states: [{ machine: 'L-INACTIVE-OBSERVE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [{
      id: 'inactive-observation-override', machine: 'L-INACTIVE-OBSERVE', signature_version: 1,
      predecessor_order_id: 'red', successor_order_id: 'blue', predecessor_state_key: state('RED'), successor_state_key: state('BLUE'),
      standard_min: 30, remaining_min: 20, status: 'active', reason: 'already started',
    }],
  }, [
    { id: 'red', PLANT: 'P-INACTIVE-OBSERVE', MACHINE: 'L-INACTIVE-OBSERVE', COLOR: 'RED', RUN_TIME: 1, start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'blue', PLANT: 'P-INACTIVE-OBSERVE', MACHINE: 'L-INACTIVE-OBSERVE', COLOR: 'BLUE', RUN_TIME: 1, start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
    { id: 'yellow', PLANT: 'P-INACTIVE-OBSERVE', MACHINE: 'L-INACTIVE-OBSERVE', COLOR: 'YELLOW', RUN_TIME: 1, start_date: new Date('2026-08-03T12:00:00'), end_date: new Date('2026-08-03T13:00:00') },
  ], new Set(['L-INACTIVE-OBSERVE']));

  assert.deepEqual(observation.intervals.map(interval => ({
    predecessorOrderId: interval.predecessorOrderId,
    successorOrderId: interval.successorOrderId,
    requiredMinutes: interval.requiredMinutes,
  })), [
    { predecessorOrderId: null, successorOrderId: 'red', requiredMinutes: 40 },
    { predecessorOrderId: 'red', successorOrderId: 'blue', requiredMinutes: 20 },
  ]);
  assert.ok(observation.diagnostics.some(diagnostic =>
    diagnostic.type === 'setup-uncovered' && diagnostic.successorOrderId === 'yellow'));
});


test('deriveSetupObservation keeps a covered zero-minute override active', () => {
  // This fails if override validity is inferred from visible positive bars
  // instead of the resolved adjacency (zero setup intentionally has no bar).
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-ZERO',
    definition: { plant: 'P-ZERO', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 0 },
      { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 30 },
    ], machine_rows: [],
    machine_states: [{ machine: 'L-ZERO', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [{
      id: 'zero-override', machine: 'L-ZERO', signature_version: 1,
      predecessor_order_id: 'red', successor_order_id: 'blue', predecessor_state_key: state('RED'), successor_state_key: state('BLUE'),
      standard_min: 30, remaining_min: 0, status: 'active', reason: 'complete',
    }],
  }, [
    { id: 'red', PLANT: 'P-ZERO', MACHINE: 'L-ZERO', COLOR: 'RED', RUN_TIME: 1, start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'blue', PLANT: 'P-ZERO', MACHINE: 'L-ZERO', COLOR: 'BLUE', RUN_TIME: 1, start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
  ]);

  assert.deepEqual(observation.intervals, []);
  assert.deepEqual(observation.diagnostics, []);
});


test('D4: an identical-signature covered transition pushes a fully-populated no-change diagnostic, never an interval', () => {
  // Before D4, deriveSetupObservation pushed neither an interval nor a
  // diagnostic for this case, so the Inspector's hasObservedEntry gate found
  // nothing and blanked every detail row to '—'. Two orders with the same
  // color on the same line, no matrix row and no override covering the
  // transition, must resolve via setup-domain's 'implicit-zero' branch.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-NOCHANGE',
    definition: { plant: 'P-NOCHANGE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  }, [
    { id: 'nochange-a', ORDER: '111', PLANT: 'P-NOCHANGE', MACHINE: 'L-NOCHANGE', COLOR: 'RED', RUN_TIME: 1,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'nochange-b', ORDER: '112', PLANT: 'P-NOCHANGE', MACHINE: 'L-NOCHANGE', COLOR: 'RED', RUN_TIME: 1,
      start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
  ], new Set(['L-NOCHANGE']));

  // No bar, no consumed capacity: this transition must never appear as an interval.
  assert.deepEqual(observation.intervals, []);

  const noChange = observation.diagnostics.find(d => d.successorOrderId === 'nochange-b');
  assert.ok(noChange, 'the identical-signature transition must still produce a detail-bearing diagnostic');
  assert.deepEqual(noChange, {
    type: 'setup-no-change', line: 'L-NOCHANGE', scope: 'P-NOCHANGE/L-NOCHANGE',
    predecessorOrderId: 'nochange-a', successorOrderId: 'nochange-b', time: new Date('2026-08-03T10:00:00'),
    predecessorState: state('RED'), successorState: state('RED'),
    requiredMinutes: 0, effectiveMinutes: 0, standardMinutes: 0, source: 'implicit-zero',
  });
});


test('D4: a genuinely uncovered (different-signature, no-matrix-row) zero-minute transition stays a distinct, alert-worthy diagnostic — not the no-change shape', () => {
  // Both this and the previous test resolve to zero minutes, but they are not
  // the same state: an uncovered transition keeps its existing 'setup-uncovered'
  // shape (no predecessorState/successorState/source fields, alert-eligible),
  // which must never be confused with D4's silent, fully-populated no-change fact.
  const observation = deriveSetupObservation({
    plant: 'P-UNCOVERED',
    definition: { plant: 'P-UNCOVERED', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  }, [
    { id: 'uncovered-a', ORDER: '211', PLANT: 'P-UNCOVERED', MACHINE: 'L-UNCOVERED', COLOR: 'RED', RUN_TIME: 1,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'uncovered-b', ORDER: '212', PLANT: 'P-UNCOVERED', MACHINE: 'L-UNCOVERED', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
  ], new Set(['L-UNCOVERED']));

  assert.deepEqual(observation.intervals, []);
  const uncovered = observation.diagnostics.find(d => d.successorOrderId === 'uncovered-b');
  assert.ok(uncovered);
  assert.equal(uncovered.type, 'setup-uncovered');
  assert.equal('source' in uncovered, false, 'an uncovered diagnostic must never carry a source field — no matrix row exists to name one');

  const noChange = observation.diagnostics.find(d => d.type === 'setup-no-change');
  assert.equal(noChange, undefined, 'an uncovered transition must never be reported as a no-change transition');
});


test('D4: computeAlerts never raises an alert for a setup-no-change diagnostic, but does for setup-uncovered', () => {
  // The no-change diagnostic type is deliberately excluded from
  // computeAlerts' diagnosticTypes allowlist (nimbus-compute-core.js) — this
  // is what keeps the identical-signature case silent (no alert, no bar)
  // while the genuinely-uncovered case (already shipped, out of scope here)
  // continues to raise one.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const { alerts } = globalThis.NimbusComputeCore.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {}, masterData: null,
    dismissed: [], opts: {},
    setup: {
      intervals: [],
      diagnostics: [
        { type: 'setup-no-change', line: 'L1', scope: 'P/L1', predecessorOrderId: 'a', successorOrderId: 'b',
          time: new Date(), predecessorState: state('RED'), successorState: state('RED'),
          requiredMinutes: 0, effectiveMinutes: 0, standardMinutes: 0, source: 'implicit-zero' },
        { type: 'setup-uncovered', line: 'L1', scope: 'P/L1', pairKey: 'x->y', predecessorOrderId: 'a', successorOrderId: 'c', time: new Date() },
      ],
    },
  });
  assert.ok(!alerts.some(a => a.type === 'setup-no-change'), 'a no-change transition must never surface as an alert');
  assert.ok(alerts.some(a => a.type === 'setup-uncovered'), 'an uncovered transition must still surface as an alert (unaffected by D4)');
});


test('deriveSetupObservation never projects one plant setup truth onto another plant', () => {
  // This fails if a stale selected-plant snapshot leaks setup capacity or
  // diagnostics onto a task that explicitly belongs to another plant.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-ONE',
    definition: { plant: 'P-ONE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'REUSED-LINE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, [{
    id: 'other-plant-order', PLANT: 'P-TWO', MACHINE: 'REUSED-LINE', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
  }]);

  assert.deepEqual(observation, { intervals: [], diagnostics: [] });
});


test('deriveSetupObservation: a blank-signature MIDDLE order breaks the chain as predecessor-state-unknown (showing the Order Number), and the chain recovers on the next valid order', () => {
  // The core regression this feature exists for. Before this fix, a null
  // stateForOrder() result on a real (non-first) predecessor was silently
  // treated the same as "genuinely no predecessor", misreporting
  // initial-state-unknown instead of naming the actual order whose setup
  // attributes are missing. Chain: red (valid) -> blank (unresolvable) ->
  // blue (valid) -> green (valid). The blank order breaks state continuity,
  // so 'blue' must report predecessor-state-unknown pointing at 'blank', while
  // 'green' — once 'blue' re-establishes a valid state — must resolve
  // normally with no unknown-state diagnostic of its own.
  const observation = deriveSetupObservation({
    plant: 'P-CHAIN',
    definition: { plant: 'P-CHAIN', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  }, [
    { id: 'chain-red', ORDER: '2021339583', PLANT: 'P-CHAIN', MACHINE: 'L-CHAIN', COLOR: 'RED', RUN_TIME: 1,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'chain-blank', ORDER: '2021339584', PLANT: 'P-CHAIN', MACHINE: 'L-CHAIN', COLOR: '', RUN_TIME: 1,
      start_date: new Date('2026-08-03T09:00:00'), end_date: new Date('2026-08-03T10:00:00') },
    { id: 'chain-blue', ORDER: '2021339585', PLANT: 'P-CHAIN', MACHINE: 'L-CHAIN', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00') },
    { id: 'chain-green', ORDER: '2021339586', PLANT: 'P-CHAIN', MACHINE: 'L-CHAIN', COLOR: 'GREEN', RUN_TIME: 1,
      start_date: new Date('2026-08-03T11:00:00'), end_date: new Date('2026-08-03T12:00:00') },
  ], new Set(['L-CHAIN']));

  const bySuccessor = new Map(observation.diagnostics.map(d => [d.successorOrderId, d]));

  // 'chain-red' is genuinely the line's first order — the pre-existing
  // initial-state-unknown case, unaffected by this fix.
  assert.equal(bySuccessor.get('chain-red')?.type, 'initial-state-unknown');

  // 'chain-blank' itself: its predecessor (red) had a real, valid state, so
  // this is a plain successor-state-unknown (the blank order's own state
  // can't be determined) — NOT predecessor-state-unknown.
  assert.equal(bySuccessor.get('chain-blank')?.type, 'successor-state-unknown');

  // 'chain-blue': the REAL regression target. Its predecessor (chain-blank)
  // exists but its state could not be derived — this must be
  // predecessor-state-unknown, carrying chain-blank's internal ID as data, NOT
  // initial-state-unknown (which would wrongly claim there's no real
  // predecessor at all).
  const blueDiagnostic = bySuccessor.get('chain-blue');
  assert.equal(blueDiagnostic?.type, 'predecessor-state-unknown');
  assert.equal(blueDiagnostic?.predecessorOrderId, 'chain-blank');
  assert.match(blueDiagnostic?.message, /2021339584/);
  assert.doesNotMatch(blueDiagnostic?.message, /chain-blank/);

  // 'chain-green': the chain recovers. chain-blue has a real, valid
  // (non-blank) state, so chain-green must NOT get any "unknown state"
  // diagnostic — whatever diagnostic it does get (if any) must be a
  // different type entirely.
  const greenDiagnostic = bySuccessor.get('chain-green');
  if (greenDiagnostic) {
    assert.notEqual(greenDiagnostic.type, 'initial-state-unknown');
    assert.notEqual(greenDiagnostic.type, 'predecessor-state-unknown');
    assert.notEqual(greenDiagnostic.type, 'successor-state-unknown');
  }
});


test('deriveSetupObservation excludes a NULL/absent-PLANT order even when its MACHINE code belongs to another plant\'s setup', () => {
  // This fails if a truthy-only PLANT check (the pre-fix behavior) lets a
  // null/undefined-PLANT order leak into ANY plant's chain merely because its
  // line code happens to match — the exact ambiguity db.reattribute_null_plant_orders
  // leaves unresolved when a line code maps to more than one plant.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-NULLPLANT',
    definition: { plant: 'P-NULLPLANT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'AMBIGUOUS-LINE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, [{
    // No PLANT (and no lowercase plant) field at all.
    id: 'null-plant-order', MACHINE: 'AMBIGUOUS-LINE', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
  }]);

  assert.deepEqual(observation, { intervals: [], diagnostics: [] },
    'an order with no resolvable PLANT must never enter any plant\'s setup chain, even on a matching line code');
});


test('deriveSetupObservation skips an order with an empty/absent MACHINE instead of bucketing it under \'Unknown\'', () => {
  // This fails if the old `|| 'Unknown'` fallback is still in effect: it would
  // chain every line-less order across the whole plant together, producing
  // spurious cross-order diagnostics for orders that don't actually share a
  // production line.
  const observation = deriveSetupObservation({
    plant: 'P-NOLINE',
    definition: { plant: 'P-NOLINE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  }, [
    { id: 'no-line-order', PLANT: 'P-NOLINE', MACHINE: '', COLOR: 'RED', RUN_TIME: 1,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00') },
    { id: 'also-no-line-order', PLANT: 'P-NOLINE', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: new Date('2026-08-03T09:00:00'), end_date: new Date('2026-08-03T10:00:00') },
  ]);

  assert.deepEqual(observation, { intervals: [], diagnostics: [] },
    'orders with no production line must be skipped entirely, never bucketed together under an implicit line');
});


test('deriveSetupObservation emits current-state-diverged when asserted state conflicts with the observed plan', () => {
  // This fails if the projection never compares a real asserted line state to
  // the planned state that completed before its observed-at timestamp.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-DIVERGED',
    definition: { plant: 'P-DIVERGED', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [],
    machine_states: [{
      machine: 'L-DIVERGED', state_key: state('RED'), signature_version: 1, source: 'actual',
      observed_at: '2026-08-03T12:00:00Z', reason: 'line walk',
    }], overrides: [],
  }, [{
    id: 'planned-blue', PLANT: 'P-DIVERGED', MACHINE: 'L-DIVERGED', COLOR: 'BLUE', RUN_TIME: 1,
    start_date: new Date('2026-08-03T08:00:00Z'), end_date: new Date('2026-08-03T10:00:00Z'),
  }]);

  assert.ok(observation.diagnostics.some(diagnostic => diagnostic.type === 'current-state-diverged'));
});


test('deriveSetupObservation marks an active override inactive when its line has no scheduled intervals, but only when that line is explicitly in scope', () => {
  // This fails if override checks only iterate lines that happened to have a
  // scheduled task, leaving orphaned active bindings invisible when their
  // line IS explicitly in scope. (Scoping itself is covered by the next test:
  // an orphaned override's line outside the caller's scope must NOT be pulled
  // in — that was the fix for the always-unscoped Timeline path spuriously
  // surfacing override-inactive diagnostics for every off-screen line.)
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-ORPHAN',
    definition: { plant: 'P-ORPHAN', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [],
    overrides: [{
      id: 'orphan', machine: 'L-ORPHAN', signature_version: 1,
      predecessor_order_id: 'gone', successor_order_id: 'also-gone', predecessor_state_key: state('GREEN'), successor_state_key: state('RED'),
      standard_min: 30, remaining_min: 30, status: 'active', reason: 'unit test',
    }],
  }, [], new Set(['L-ORPHAN']));

  assert.deepEqual(observation.diagnostics.map(diagnostic => diagnostic.type), ['override-inactive']);
});


test('deriveSetupObservation does not surface an orphaned override diagnostic for a line outside the caller\'s scope', () => {
  // This is the scoping half of the fix above: on the (always unscoped in the
  // old code) caller path, pulling in EVERY active override's line — including
  // ones with zero loaded orders and outside what the caller asked about —
  // produced spurious override-inactive diagnostics with an undefined time.
  // A line must now be either explicitly scoped-in or already have orders
  // before an orphaned override on it is diagnosed.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const observation = deriveSetupObservation({
    plant: 'P-ORPHAN-SCOPE',
    definition: { plant: 'P-ORPHAN-SCOPE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [],
    overrides: [{
      id: 'out-of-scope-orphan', machine: 'L-NOT-IN-SCOPE', signature_version: 1,
      predecessor_order_id: 'gone', successor_order_id: 'also-gone', predecessor_state_key: state('GREEN'), successor_state_key: state('RED'),
      standard_min: 30, remaining_min: 30, status: 'active', reason: 'unit test',
    }],
  }, [], new Set(['L-SOME-OTHER-LINE']));

  assert.deepEqual(observation.diagnostics, [], 'a line neither in scope nor carrying loaded orders must not surface an orphaned-override diagnostic');
});


test('deriveSetupObservation measures setup availability against a preceding blackout', () => {
  // This fails if availability is the raw predecessor-to-successor wall time
  // instead of the contiguous operating time immediately before production.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const observation = deriveSetupObservation({
    plant: 'P-BLOCK',
    definition: { plant: 'P-BLOCK', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 90 }],
    machine_rows: [],
    machine_states: [{ machine: 'L-BLOCK', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }], overrides: [],
  }, [{
    id: 'blocked-successor', PLANT: 'P-BLOCK', MACHINE: 'L-BLOCK', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00'),
  }], undefined, {
    calendars: { 'L-BLOCK': { workHours: hours } }, plants: { 'P-BLOCK': { workHours: hours } },
    lineSettings: { 'L-BLOCK': { plant: 'P-BLOCK' } }, masterData: { lines: [{ machine: 'L-BLOCK', plant: 'P-BLOCK' }] },
    blocks: [{ line: 'L-BLOCK', plant: 'P-BLOCK', start: new Date('2026-08-03T09:30:00'), end: new Date('2026-08-03T10:00:00') }], plantBlocks: [],
  });

  assert.equal(observation.intervals[0].availableMinutes, 0);
});


test('deriveSetupObservation intersects line and plant hours when measuring setup availability', () => {
  // This fails if a wider line calendar is allowed to admit setup after the
  // plant-level capacity window has closed.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const lineHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const plantHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 16]]));
  const observation = deriveSetupObservation({
    plant: 'P-INTERSECT',
    definition: { plant: 'P-INTERSECT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'L-INTERSECT', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }], overrides: [],
  }, [{
    id: 'after-plant-close', PLANT: 'P-INTERSECT', MACHINE: 'L-INTERSECT', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T17:00:00'), end_date: new Date('2026-08-03T18:00:00'),
  }], undefined, {
    calendars: { 'L-INTERSECT': { workHours: lineHours } }, plants: { 'P-INTERSECT': { workHours: plantHours } },
    lineSettings: { 'L-INTERSECT': { plant: 'P-INTERSECT' } }, masterData: { lines: [{ machine: 'L-INTERSECT', plant: 'P-INTERSECT' }] },
    blocks: [], plantBlocks: [],
  });

  assert.equal(observation.intervals[0].availableMinutes, 0);
});


test('deriveSetupObservation uses the setup snapshot plant for a reused line capacity window', () => {
  // This fails if a same-named line's first master-data/line-settings plant
  // overrides the explicit setup snapshot plant while measuring capacity.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const lineHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const observation = deriveSetupObservation({
    plant: 'P-SNAPSHOT',
    definition: { plant: 'P-SNAPSHOT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'REUSED-LINE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }], overrides: [],
  }, [{
    id: 'snapshot-successor', PLANT: 'P-SNAPSHOT', MACHINE: 'REUSED-LINE', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00'),
  }], undefined, {
    calendars: { 'REUSED-LINE': { workHours: lineHours } },
    plants: {
      'P-SNAPSHOT': { workHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [9, 10]])) },
      'P-OTHER': { workHours: lineHours },
    },
    lineSettings: { 'REUSED-LINE': { plant: 'P-OTHER' } },
    masterData: { lines: [{ machine: 'REUSED-LINE', plant: 'P-OTHER' }, { machine: 'REUSED-LINE', plant: 'P-SNAPSHOT' }] },
    blocks: [], plantBlocks: [],
  });

  assert.equal(observation.intervals[0].availableMinutes, 60);
});


test('deriveSetupObservation uses the core default line calendar when its record is absent', () => {
  // Core capacity supplies the standard 07:00â€“19:00 weekday line calendar for
  // an absent entry, then intersects it with the stored plant window.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const plantHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 16]]));
  const observation = deriveSetupObservation({
    plant: 'P-DEFAULT-LINE',
    definition: { plant: 'P-DEFAULT-LINE', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'L-DEFAULT-LINE', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }], overrides: [],
  }, [{
    id: 'default-line-successor', PLANT: 'P-DEFAULT-LINE', MACHINE: 'L-DEFAULT-LINE', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00'),
  }], undefined, {
    calendars: {}, plants: { 'P-DEFAULT-LINE': { workHours: plantHours } },
    lineSettings: { 'L-DEFAULT-LINE': { plant: 'P-DEFAULT-LINE' } }, masterData: { lines: [{ machine: 'L-DEFAULT-LINE', plant: 'P-DEFAULT-LINE' }] },
    blocks: [], plantBlocks: [],
  });

  assert.equal(observation.intervals[0].availableMinutes, 120);
});


test('deriveSetupObservation uses the core default plant calendar when its record is absent', () => {
  // Core capacity supplies the standard 07:00â€“19:00 weekday plant calendar for
  // an absent entry, then intersects it with the stored line window.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const lineHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const observation = deriveSetupObservation({
    plant: 'P-DEFAULT-PLANT',
    definition: { plant: 'P-DEFAULT-PLANT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 30 }],
    machine_rows: [],
    machine_states: [{ machine: 'L-DEFAULT-PLANT', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }], overrides: [],
  }, [{
    id: 'default-plant-successor', PLANT: 'P-DEFAULT-PLANT', MACHINE: 'L-DEFAULT-PLANT', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T10:00:00'), end_date: new Date('2026-08-03T11:00:00'),
  }], undefined, {
    calendars: { 'L-DEFAULT-PLANT': { workHours: lineHours } }, plants: {},
    lineSettings: { 'L-DEFAULT-PLANT': { plant: 'P-DEFAULT-PLANT' } }, masterData: { lines: [{ machine: 'L-DEFAULT-PLANT', plant: 'P-DEFAULT-PLANT' }] },
    blocks: [], plantBlocks: [],
  });

  assert.equal(observation.intervals[0].availableMinutes, 120);
});


test('Engine.evaluateSchedule preserves changeover-mode placement from the live path', () => {
  const startDate = new Date('2035-08-06T08:00:00');
  Store.setTasks([
    { id: 'parity-blue-long', MACHINE: 'L1', PLANT: 'PARITY', COLOR: 'BLUE', FORM_SIZE: 'B', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'parity-red-short', MACHINE: 'L1', PLANT: 'PARITY', COLOR: 'RED', FORM_SIZE: 'A', RUN_TIME: '1', start_date: null, end_date: null },
    { id: 'parity-blue-short', MACHINE: 'L1', PLANT: 'PARITY', COLOR: 'BLUE', FORM_SIZE: 'A', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('PARITY', 'unit-test');
  const options = { startDate, respectFirmed: true, respectCalendar: false };
  const candidate = Engine.evaluateSchedule('changeover', options);

  Engine.runAndApply('changeover', options);
  const committed = candidate.patches.map(patch => ({
    id: patch.id,
    start: patch.changes.start_date?.getTime(),
    end: patch.changes.end_date?.getTime(),
  }));
  const legacy = candidate.patches.map(patch => ({
    id: patch.id,
    start: Store.tasks[patch.id].start_date?.getTime(),
    end: Store.tasks[patch.id].end_date?.getTime(),
  }));
  assert.deepEqual(committed, legacy,
    'detached evaluation must reuse the same changeover/day-integrity placement as the live path');
});


test('Engine.runAndApply(\'spt\') sorts a single line\'s free tasks by ascending run-hours', () => {
  // PLANT (uppercase) is the real field name — db.py's query_orders aliases
  // `o.plant AS "PLANT"`, and Store.rebuildPlantIndex()/tasksByPlant() key off
  // `t.PLANT`, not a lowercase `plant`. Using the real casing is what makes
  // Store.tasksByPlant('5512') (which Engine.runAndApply groups from) actually
  // return these tasks instead of silently grouping zero tasks.
  Store.setTasks([
    { id: 'e1', MACHINE: 'L1', PLANT: '5512', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'e2', MACHINE: 'L1', PLANT: '5512', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.runAndApply('spt', { respectFirmed: true, respectCalendar: false });
  const e1 = Store.tasks['e1'], e2 = Store.tasks['e2'];
  assert.ok(e1.start_date, 'e1 must have been scheduled (proves the line group was non-empty)');
  assert.ok(e2.start_date <= e1.start_date, 'shorter run-time task (e2) must be scheduled first under SPT');
});


test('Engine.autoReflow pushes an overlapping unfirmed downstream peer forward on the same line', () => {
  // Keep this calendar-aware regression in the future: aged orders are
  // intentionally excluded from reflow, and the previous fixed 2026 date is
  // now historical. Pick the next Monday to avoid a default weekend closure.
  const start1 = new Date();
  start1.setDate(start1.getDate() + ((8 - start1.getDay()) % 7 || 7));
  start1.setHours(8, 0, 0, 0);
  const end1 = new Date(start1); end1.setHours(10, 0, 0, 0);
  const start2 = new Date(start1); start2.setHours(9, 0, 0, 0);
  const end2 = new Date(start1); end2.setHours(11, 0, 0, 0);
  Store.setTasks([
    { id: 'r1', MACHINE: 'L2', PLANT: '5512', RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'r2', MACHINE: 'L2', PLANT: '5512', RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.autoReflow('r1');
  const r2 = Store.tasks['r2'];
  assert.ok(r2.start_date.getTime() !== start2.getTime(), 'peer must have actually moved (proves the peer set was non-empty)');
  assert.ok(r2.start_date >= end1, 'downstream peer must have moved to start at/after the changed task\'s end');
});


test('Engine.runAndApply respects explicit respectFirmed/respectCalendar options without reading any DOM element', () => {
  // Regression test for the DOM-read fix in Step 4: call runAndApply with both
  // flags explicit and confirm `document.getElementById` is never invoked.
  // The shared harness stub installed at the top of this file
  // (`document = { getElementById: () => null }`, needed for the no-plant/
  // no-task guard-path tests) silently absorbs any `getElementById` call and
  // returns `null` rather than throwing, so asserting `doesNotThrow` against
  // it alone would pass even if a DOM read were reintroduced. Swap in a
  // counting spy for the duration of this test instead, and assert it was
  // never called — then restore the shared stub.
  const priorDocument = globalThis.document;
  let calls = 0;
  globalThis.document = { getElementById: () => { calls++; return null; } };
  try {
    Store.setTasks([{ id: 'e3', MACHINE: 'L1', plant: '5512', RUN_TIME: '1' }], 'unit-test');
    Store.setSelectedPlant('5512', 'unit-test');
    assert.doesNotThrow(() => Engine.runAndApply('changeover', { respectFirmed: true, respectCalendar: true }));
    assert.equal(calls, 0, 'Engine.runAndApply must not call document.getElementById when respectFirmed/respectCalendar are both passed explicitly');
  } finally {
    globalThis.document = priorDocument;
  }
});

// ---------------------------------------------------------------------------
// Stage 3 seam 3 — Engine.flattenConstraints + the _sortTerms term factory.
// These are _sortTerms' first-ever direct coverage (Task 0's audit confirmed no
// test anywhere referenced _sortTerms / _comparator / colorMap before this).
//
// NOTE on `Store.setMasterData(...)` vs. the plan's illustrative
// `Store.masterData = {...}`: `masterData` is a getter-ONLY accessor on Store
// (frontend/platform/store.mts) — a bare assignment throws "Cannot set property
// masterData of #<Object> which has only a getter" under ESM strict mode.
// `setMasterData` is the real public setter (and the one Persistence itself
// uses), so these tests go through it. Appended at the END of the file on
// purpose: setMasterData rebuilds Store's line→plant index, which the
// pre-existing Engine tests above depend on.
// ---------------------------------------------------------------------------


test('flattenConstraints does pre-order DFS, drops duplicates, skips disabled subtrees', () => {
  Store.setMasterData({ plants: [{ plant: 'P1', constraints: [
    { key: 'colorWheel', enabled: true, order: 1, children: [
      { key: 'prt01', enabled: true, order: 1 },
      { key: 'colorWheel', enabled: true, order: 2 },  // duplicate — must be dropped
    ] },
    { key: 'prt02', enabled: false, order: 2, children: [
      { key: 'productionVersion', enabled: true, order: 1 },  // whole subtree skipped (parent disabled)
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('P1'), ['colorWheel', 'prt01']);
});


test('flattenConstraints falls back to CONSTRAINT_CATALOG order when plant has no stored tree', () => {
  Store.setMasterData({ plants: [{ plant: 'P2', constraints: null }], lines: [] }, 'unit-test');
  const keys = Engine.flattenConstraints('P2');
  assert.deepEqual(keys, ['colorWheel']); // only colorWheel defaults enabled, per constraintEnabled's existing rule
});

// --- constraintEnabled is tree-aware ---------------------------------------
// Regression cover for the top-level-only `find()` this replaced. Harmless
// while plants.constraints was always flat; a real defect once the Stage 3
// Scheduling Constraints UI made nesting reachable, because a nested key fell
// through to the `key === 'colorWheel'` default. Its one real consumer is
// OptimizeDialog's pre-run "no color wheel configured" confirm
// (frontend/schedule-workbench.mts) — a UI nag, never a sequencing decision
// (_sortTerms goes through flattenConstraints, which has always walked the
// tree). Semantics must stay identical to flattenConstraints': a disabled node
// takes its whole subtree with it, and any reachable enabled occurrence counts.


test('constraintEnabled finds a key nested BELOW the root, not just at the top level', () => {
  Store.setMasterData({ plants: [{ plant: 'CE1', constraints: [
    { key: 'colorWheel', enabled: true, order: 1, children: [
      { key: 'prt01', enabled: true, order: 1, children: [
        { key: 'prt02', enabled: true, order: 1 },   // depth 3 — must still be found
      ] },
    ] },
  ] }], lines: [] }, 'unit-test');
  // Deliberately asserted on NON-colorWheel keys: the old top-level find()
  // missed them and then returned `key === 'colorWheel'` => false, so these two
  // are the assertions that actually fail against the pre-fix implementation.
  assert.equal(Engine.constraintEnabled('CE1', 'prt01'), true,
    'prt01 nested under an enabled parent is enabled — the old top-level find() reported false');
  assert.equal(Engine.constraintEnabled('CE1', 'prt02'), true, 'found at the deepest allowed level too');
  assert.equal(Engine.constraintEnabled('CE1', 'colorWheel'), true);
  // Agrees with the function it mirrors.
  assert.deepEqual(Engine.flattenConstraints('CE1'), ['colorWheel', 'prt01', 'prt02']);
});


test('constraintEnabled returns false for a nested key whose ancestor is disabled (subtree is off)', () => {
  Store.setMasterData({ plants: [{ plant: 'CE2', constraints: [
    { key: 'prt01', enabled: false, order: 1, children: [
      { key: 'colorWheel', enabled: true, order: 1 },  // reachable only through a disabled parent
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE2', 'colorWheel'), false,
    'a disabled ancestor takes its whole subtree with it — and this must NOT fall through to the colorWheel-ON default');
  assert.equal(Engine.constraintEnabled('CE2', 'prt01'), false);
  assert.deepEqual(Engine.flattenConstraints('CE2'), [], 'flattenConstraints must agree: nothing is in effect');
});


test('constraintEnabled returns false for a nested key that is itself disabled', () => {
  Store.setMasterData({ plants: [{ plant: 'CE3', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [
      { key: 'colorWheel', enabled: false, order: 1 },
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE3', 'colorWheel'), false);
  assert.deepEqual(Engine.flattenConstraints('CE3'), ['prt01']);
});


test('constraintEnabled: any REACHABLE enabled occurrence wins, matching the one flattenConstraints emits', () => {
  Store.setMasterData({ plants: [{ plant: 'CE4', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },        // off at the root...
    { key: 'prt01', enabled: true, order: 2, children: [
      { key: 'colorWheel', enabled: true, order: 1 },       // ...but on, and reachable, here
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE4', 'colorWheel'), true);
  assert.ok(Engine.flattenConstraints('CE4').includes('colorWheel'),
    'flattenConstraints emits it, so constraintEnabled must not claim otherwise');
});


test('constraintEnabled preserves the flat top-level behavior it always had', () => {
  Store.setMasterData({ plants: [{ plant: 'CE5', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },
    { key: 'prt01', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE5', 'colorWheel'), false, 'explicit top-level off stays off');
  assert.equal(Engine.constraintEnabled('CE5', 'prt01'), true, 'explicit top-level on stays on');
  // A key a configured tree does not mention is off — it does NOT fall through
  // to the everything-else-OFF default (same answer here, different reason).
  assert.equal(Engine.constraintEnabled('CE5', 'prt02'), false);
});


test('constraintEnabled: a configured tree that OMITS the key returns false, not the colorWheel default', () => {
  // Reachable in practice: removing the Color Wheel row in the tree UI leaves a
  // non-empty tree with no colorWheel node. Falling through to
  // `key === 'colorWheel'` here would report colorWheel ON while
  // flattenConstraints correctly reports it as not in effect — the same
  // spurious-nag symptom the tree-walk fix closed, one level up.
  Store.setMasterData({ plants: [{ plant: 'CE8', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE8', 'colorWheel'), false,
    'a configured tree is authoritative about what it omits');
  assert.deepEqual(Engine.flattenConstraints('CE8'), ['prt01']);
  assert.ok(!Engine.flattenConstraints('CE8').includes('colorWheel'),
    'and flattenConstraints agrees — the equivalence the doc comment claims');
  // Same for a nested-only tree that omits it.
  Store.setMasterData({ plants: [{ plant: 'CE9', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [{ key: 'prt02', enabled: true, order: 1 }] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE9', 'colorWheel'), false);
  assert.equal(Engine.constraintEnabled('CE9', 'productionVersion'), false);
});


test('constraintEnabled: duplicate root keys resolve position-independently, like flattenConstraints', () => {
  // off-then-on and on-then-off must give the same answer: flattenConstraints
  // emits the key as long as SOME reachable occurrence is enabled, regardless
  // of order, so a positional find() (first match wins) would disagree.
  for (const [label, constraints] of [
    ['off then on', [{ key: 'colorWheel', enabled: false, order: 1 }, { key: 'colorWheel', enabled: true, order: 2 }]],
    ['on then off', [{ key: 'colorWheel', enabled: true, order: 1 }, { key: 'colorWheel', enabled: false, order: 2 }]],
  ]) {
    Store.setMasterData({ plants: [{ plant: 'CE10', constraints }], lines: [] }, 'unit-test');
    assert.equal(Engine.constraintEnabled('CE10', 'colorWheel'), true, `${label}: any enabled occurrence wins`);
    assert.ok(Engine.flattenConstraints('CE10').includes('colorWheel'), `${label}: flattenConstraints agrees`);
  }
  // Both off -> off, in either arrangement.
  Store.setMasterData({ plants: [{ plant: 'CE11', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },
    { key: 'colorWheel', enabled: false, order: 2 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE11', 'colorWheel'), false);
  assert.deepEqual(Engine.flattenConstraints('CE11'), []);
});


test('constraintEnabled preserves the never-configured default (colorWheel ON, rest OFF)', () => {
  Store.setMasterData({ plants: [{ plant: 'CE6', constraints: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE6', 'colorWheel'), true);
  assert.equal(Engine.constraintEnabled('CE6', 'prt01'), false);
  // Same for an unknown plant, and for an empty stored array (which
  // flattenConstraints also treats as never-configured).
  assert.equal(Engine.constraintEnabled('NOPE', 'colorWheel'), true);
  Store.setMasterData({ plants: [{ plant: 'CE7', constraints: [] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE7', 'colorWheel'), true);
  assert.equal(Engine.constraintEnabled('CE7', 'prt01'), false);
});


test('_sortTerms resolves rank via Store.priorityRankMaps, line override winning over plant-wide', () => {
  Store.setMasterData({ plants: [{ plant: 'P3', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 5 } }, L01: { colorWheel: { RED: 1 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P3' });
  const key = terms[0].get({ COLOR: 'red', MACHINE: 'L01' });
  assert.equal(key, '0000001|RED');  // line override (rank 1), not plant-wide (rank 5)
  const keyNoLine = terms[0].get({ COLOR: 'red', MACHINE: 'L99' });
  assert.equal(keyNoLine, '0000005|RED');  // falls back to plant-wide for an unmapped line
});


test('_sortTerms groups unranked values together, after ranked ones, instead of interleaving (N12)', () => {
  Store.setMasterData({ plants: [{ plant: 'P4', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P4' });
  const redKey    = terms[0].get({ COLOR: 'RED',    MACHINE: 'L1' });
  const blueKey   = terms[0].get({ COLOR: 'BLUE',   MACHINE: 'L1' });   // unranked
  const greenKey  = terms[0].get({ COLOR: 'GREEN',  MACHINE: 'L1' });   // unranked
  assert.ok(redKey < blueKey);            // ranked sorts before unranked
  assert.notEqual(blueKey, greenKey);     // both rank 999999 but keys still differ by value
  assert.ok(blueKey.startsWith('0999999|') && greenKey.startsWith('0999999|'));  // grouped under the same rank prefix
});


test('_sortTerms keeps the rank half exactly 7 digits for fractional and oversized ranks', () => {
  // Ranks are floats end to end (brain.py persists float(rank); JSON round-trips
  // 1.4 verbatim), so the padded-key encoding has to survive a non-integer.
  // Unguarded, String(1.4).padStart(7,'0') === '00001.4' — already 7 chars, so
  // NOTHING is padded — and it compares AFTER '0000003' on the 4th character,
  // silently putting rank 1.4 behind rank 3. Same class of break above 1e7,
  // where the rank half overflows to 8 digits.
  Store.setMasterData({ plants: [{ plant: 'P7', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1.4, BLUE: 3, HUGE: 99999999 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P7' });
  const redKey  = terms[0].get({ COLOR: 'RED',  MACHINE: 'L1' });
  const blueKey = terms[0].get({ COLOR: 'BLUE', MACHINE: 'L1' });
  const hugeKey = terms[0].get({ COLOR: 'HUGE', MACHINE: 'L1' });
  assert.match(redKey,  /^\d{7}\|RED$/,  'a fractional rank must still yield a 7-digit rank half');
  assert.match(hugeKey, /^\d{7}\|HUGE$/, 'an oversized rank must be clamped to a 7-digit rank half');
  assert.equal(redKey, '0000001|RED');   // 1.4 rounds to 1
  assert.equal(hugeKey, '9999999|HUGE'); // clamped at the 7-digit ceiling
  assert.ok(redKey < blueKey,
    'fractional rank 1.4 must still sort before integer rank 3 — the unguarded encoding inverted this');
});


test('_sortTerms with no rank map for the field falls back to 999999 for every value (no crash)', () => {
  Store.setMasterData({ plants: [{ plant: 'P5', constraints: [{ key: 'prt01', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({}, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P5' });
  assert.equal(terms[0].get({ PRT_01: 'DOG', MACHINE: 'L1' }), '0999999|DOG');
});


test('_sortTerms maps every registered priority key to its REAL task field, not key.toUpperCase()', () => {
  // Task 0's audit defect 4a: 'prt01' -> 'PRT_01' (not 'PRT01'),
  // 'productionVersion' -> 'PRODUCTION_VERSION' (not 'PRODUCTIONVERSION'). A
  // toUpperCase() guess would read an undefined field and rank every order
  // 999999 — configured, inert, silent. Assert the mapping directly AND that a
  // real rank resolves off the real field name.
  assert.equal(Engine._taskFieldFor('colorWheel'), 'COLOR');
  assert.equal(Engine._taskFieldFor('prt01'), 'PRT_01');
  assert.equal(Engine._taskFieldFor('prt02'), 'PRT_02');
  assert.equal(Engine._taskFieldFor('productionVersion'), 'PRODUCTION_VERSION');
  Store.setMasterData({ plants: [{ plant: 'P6', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
    { key: 'productionVersion', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': {
    prt01: { 'TOOL-A': 2 },
    productionVersion: { V1: 3 },
  } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P6' });
  assert.equal(terms[0].get({ PRT_01: 'tool-a', MACHINE: 'L1' }), '0000002|TOOL-A');
  assert.equal(terms[1].get({ PRODUCTION_VERSION: 'v1', MACHINE: 'L1' }), '0000003|V1');
});

// ---------------------------------------------------------------------------
// Task 7 — Engine.setConstraintCatalog / Engine.setFieldTaskFields. Both were
// added in the prior task (Task 6) with zero direct test coverage; this
// task's boot wiring (application-shell.mts's App.init(), calling both once
// GET /priority-fields resolves) is their first real caller. Two behaviors
// matter and are covered here: (a) a partial/empty registry response MERGES
// over whatever the function already holds rather than replacing/clearing
// it — the other three fields' known mappings/catalog entries must survive
// — and (b) an empty/falsy `fields` array is a pure no-op. Each test
// snapshots and restores module state in a finally, since Engine is a
// shared singleton across this whole file.
// ---------------------------------------------------------------------------


test('setConstraintCatalog merges a partial response over existing entries, not wiping the other three', () => {
  const before = Engine.CONSTRAINT_CATALOG.map(c => ({ ...c }));
  try {
    // Seed a full 4-entry catalog (mirrors a real GET /priority-fields
    // response, which the backend always spreads from RANKABLE_FIELDS).
    Engine.setConstraintCatalog([
      { field_key: 'colorWheel', default_label: 'Color Wheel' },
      { field_key: 'prt01', default_label: 'Prod. Resource Tool (01)' },
      { field_key: 'prt02', default_label: 'Prod. Resource Tool (02)' },
      { field_key: 'productionVersion', default_label: 'Production Version' },
    ]);
    assert.equal(Engine.CONSTRAINT_CATALOG.length, 4);

    // A later PARTIAL response (e.g. a degraded /reload) mentions only one
    // field — the other three must still be there afterward, unwiped.
    Engine.setConstraintCatalog([{ field_key: 'colorWheel', default_label: 'Color Wheel (updated)' }]);
    const keys = Engine.CONSTRAINT_CATALOG.map(c => c.key);
    assert.ok(keys.includes('prt01'), 'partial response must not wipe prt01');
    assert.ok(keys.includes('prt02'), 'partial response must not wipe prt02');
    assert.ok(keys.includes('productionVersion'), 'partial response must not wipe productionVersion');
    const cw = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'colorWheel');
    assert.equal(cw.label, 'Color Wheel (updated)', 'the field the partial response DID mention must still update');
  } finally {
    Engine.CONSTRAINT_CATALOG = before;
  }
});


test('setConstraintCatalog fills desc from the local field_key -> description fallback (backend carries none)', () => {
  // Regression coverage: the prior task's implementation hardcoded desc: ''
  // for every entry once the registry started driving CONSTRAINT_CATALOG,
  // blanking the Scheduling Constraints UI's per-field description text.
  const before = Engine.CONSTRAINT_CATALOG.map(c => ({ ...c }));
  try {
    Engine.setConstraintCatalog([
      { field_key: 'colorWheel', default_label: 'Color Wheel' },
      { field_key: 'prt01', default_label: 'Prod. Resource Tool (01)' },
    ]);
    const cw = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'colorWheel');
    const prt01 = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'prt01');
    assert.ok(cw.desc, 'colorWheel must keep a non-empty description');
    assert.ok(prt01.desc, 'prt01 must also get a non-empty description from the local fallback map');
    assert.equal(cw.label, 'Color Wheel', 'label stays backend-authoritative — only desc is sourced locally');
  } finally {
    Engine.CONSTRAINT_CATALOG = before;
  }
});


test('setConstraintCatalog with an empty/falsy fields array is a no-op', () => {
  const before = Engine.CONSTRAINT_CATALOG;
  Engine.setConstraintCatalog([]);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'empty array must leave the existing catalog untouched');
  Engine.setConstraintCatalog(null);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'null must leave the existing catalog untouched');
  Engine.setConstraintCatalog(undefined);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'undefined must leave the existing catalog untouched');
});


test('setFieldTaskFields merges a partial response over the hardcoded defaults, not wiping the other three', () => {
  const before = { ...Engine._fieldTaskFields };
  try {
    Engine.setFieldTaskFields([{ field_key: 'colorWheel', task_field: 'COLOR_OVERRIDE' }]);
    assert.equal(Engine._fieldTaskFields.colorWheel, 'COLOR_OVERRIDE', 'the mentioned field must update');
    assert.equal(Engine._fieldTaskFields.prt01, 'PRT_01', 'a partial response must not wipe prt01\'s known mapping');
    assert.equal(Engine._fieldTaskFields.prt02, 'PRT_02', 'a partial response must not wipe prt02\'s known mapping');
    assert.equal(Engine._fieldTaskFields.productionVersion, 'PRODUCTION_VERSION', 'a partial response must not wipe productionVersion\'s known mapping');
  } finally {
    Engine._fieldTaskFields = before;
  }
});


test('setFieldTaskFields with an empty/falsy fields array is a no-op', () => {
  const before = { ...Engine._fieldTaskFields };
  Engine.setFieldTaskFields([]);
  assert.deepEqual(Engine._fieldTaskFields, before, 'empty array must leave the existing defaults untouched');
  Engine.setFieldTaskFields(null);
  assert.deepEqual(Engine._fieldTaskFields, before, 'null must leave the existing defaults untouched');
  Engine.setFieldTaskFields(undefined);
  assert.deepEqual(Engine._fieldTaskFields, before, 'undefined must leave the existing defaults untouched');
});


test('runAndApply with NO explicit plant/map resolves real ranks from Store state (alert auto-fix path)', () => {
  // The one call site Task 0's audit flagged as silently breakable:
  // Alerts.applyFix's overload branch calls Engine.runAndApply('changeover', {
  // lines, startDate, endDate }) with no plant and no rank argument, so it
  // depends entirely on Store.selectedPlant + Store.priorityRankMaps. Assert an
  // end-to-end sequence, not just the term factory in isolation.
  Store.setMasterData({ plants: [{ plant: '5512', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1, BLUE: 2 } } }, 'unit-test');
  Store.setTasks([
    // BLUE first in insertion order, and the LONGER job, so neither input order
    // nor the SPT tail term could produce the expected result by accident.
    { id: 'cw-blue', MACHINE: 'LC', PLANT: '5512', RUN_TIME: '2', COLOR: 'BLUE', start_date: null, end_date: null },
    { id: 'cw-red',  MACHINE: 'LC', PLANT: '5512', RUN_TIME: '3', COLOR: 'RED',  start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.runAndApply('changeover', { respectFirmed: true, respectCalendar: false });
  const red = Store.tasks['cw-red'], blue = Store.tasks['cw-blue'];
  assert.ok(red.start_date && blue.start_date, 'both orders must have been scheduled');
  assert.ok(red.start_date <= blue.start_date,
    'rank-1 RED must be sequenced before rank-2 BLUE — a 999999-for-everything fallback would leave the longer RED job last under the SPT tail term');
});

/* ---------------------------------------------------------------------------
   Final-review fix wave (2026-08-11). The whole-branch review found three
   defects whose seams live here:
     - effectiveConstraintPaths: per-NODE effectiveness, so the Scheduling
       Constraints "Effective sequence" panel stops crediting the wrong
       occurrence of a duplicated key.
     - unrankedActiveFields: the generic (all-fields) form of "is this priority
       actually configured?" behind the pre-Run confirm (N11).
     - changeoverTaskFields: what the changeover KPI must measure so it tracks
       the same fields _sortTerms sequences on.
   Plus the two contained _sortTerms fixes (dead term, empty-override shadowing).
   ------------------------------------------------------------------------ */


test('effectiveConstraintPaths credits the ENABLED duplicate, not the disabled one before it', () => {
  // The reviewer's exact repro. Real optimizer order is prt01 -> prt02 ->
  // colorWheel: the colorWheel at index 1 is OFF, so index 3 is what takes
  // effect. The old panel logic (`flat.includes(key) && !seen.has(key)`) marked
  // index 1 effective and index 3 "(no effect)" — precisely inverted.
  const tree = [
    { key: 'prt01',      enabled: true,  order: 1 },
    { key: 'colorWheel', enabled: false, order: 2 },
    { key: 'prt02',      enabled: true,  order: 3 },
    { key: 'colorWheel', enabled: true,  order: 4 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP1', constraints: tree }], lines: [] }, 'unit-test');

  assert.deepEqual(Engine.flattenConstraints('EP1'), ['prt01', 'prt02', 'colorWheel'],
    'optimizer order must skip the disabled duplicate and emit the enabled one last');
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.deepEqual([...paths].sort(), ['0', '2', '3'],
    'index 1 (disabled colorWheel) must NOT be effective; index 3 (enabled colorWheel) must be');
  assert.ok(!paths.has('1'), 'the switched-OFF row must never be reported as in effect');
});


test('effectiveConstraintPaths: a node under a disabled ancestor loses to an enabled copy below', () => {
  const tree = [
    { key: 'prt01', enabled: false, order: 1, children: [{ key: 'colorWheel', enabled: true, order: 1 }] },
    { key: 'colorWheel', enabled: true, order: 2 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP2', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP2'), ['colorWheel']);
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.deepEqual([...paths], ['1'],
    'only the root-level enabled colorWheel is in effect — not the one inside the disabled subtree');
  assert.ok(!paths.has('0.0'), 'a child of a disabled parent is unreachable, so it cannot be the effective occurrence');
});


test('effectiveConstraintPaths addresses ORIGINAL array positions, not the order-sorted view', () => {
  // Array order deliberately disagrees with `order` — what a persisted tree from
  // an older client can look like. Paths must point at the caller's own indices
  // or a renderer would highlight the wrong row.
  const tree = [
    { key: 'prt02',      enabled: true, order: 3 },
    { key: 'colorWheel', enabled: true, order: 1 },
    { key: 'prt01',      enabled: true, order: 2 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP3', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP3'), ['colorWheel', 'prt01', 'prt02'],
    'effective ORDER follows `order`');
  assert.deepEqual([...Engine.effectiveConstraintPaths(tree)].sort(), ['0', '1', '2'],
    'every node is effective here, addressed by its own array index');
  assert.equal(Engine.effectiveConstraintPaths(null).size, 0);
  assert.equal(Engine.effectiveConstraintPaths([]).size, 0);
});


test('effectiveConstraintPaths still reaches a repeated node CHILD that introduces a new key', () => {
  // A repeated parent contributes nothing itself but must not swallow its
  // subtree — flattenConstraints walks children regardless of the dedupe.
  const tree = [
    { key: 'colorWheel', enabled: true, order: 1 },
    { key: 'colorWheel', enabled: true, order: 2, children: [{ key: 'prt01', enabled: true, order: 1 }] },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP4', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP4'), ['colorWheel', 'prt01']);
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.ok(paths.has('0'),   'first colorWheel is the effective occurrence');
  assert.ok(!paths.has('1'),  'the repeat contributes nothing');
  assert.ok(paths.has('1.0'), 'but the child prt01 under the repeat is still reached and effective');
});


test('unrankedActiveFields reports every ACTIVE field with no ranks — not just colorWheel', () => {
  Store.setMasterData({ plants: [{ plant: 'UF1', constraints: [
    { key: 'colorWheel', enabled: true,  order: 1 },
    { key: 'prt01',      enabled: true,  order: 2 },
    { key: 'prt02',      enabled: false, order: 3 },   // off -> not active, must not be nagged about
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF1'), ['prt01'],
    'colorWheel has ranks; prt02 is switched off; only the enabled-but-empty prt01 is reported');
});


test('unrankedActiveFields treats an EMPTY cache (failed fetch) as every active field unranked', () => {
  // This is what lets OptimizeDialog.run() cover "ranks unavailable" with the
  // same call as "nothing uploaded", including the case where a failed REFETCH
  // wiped the cache while Persistence._rankMapsPlant still matched the plant.
  Store.setMasterData({ plants: [{ plant: 'UF2', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
    { key: 'prt02', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({}, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF2'), ['prt01', 'prt02']);
  // A plant that sequences ONLY on non-color fields is exactly the case the old
  // colorWheel-only gate stayed silent for.
  assert.ok(!Engine.flattenConstraints('UF2').includes('colorWheel'));
});


test('unrankedActiveFields counts a per-LINE override as ranked (no plant-wide list required)', () => {
  Store.setMasterData({ plants: [{ plant: 'UF3', constraints: [{ key: 'prt01', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ L01: { prt01: { DOG: 1 } } }, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF3'), [],
    'a plant configured purely with per-line overrides must not be reported as unconfigured');
});


test('changeoverTaskFields tracks active priority fields, defaulting to COLOR+FORM_SIZE', () => {
  // Never-configured plant: byte-identical to the hardcoded pair it replaces.
  Store.setMasterData({ plants: [{ plant: 'CO1' }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO1'), ['COLOR', 'FORM_SIZE']);

  // PRT-only plant: COLOR drops out (not sequenced on), FORM_SIZE stays because
  // _sortTerms appends it in both grouping modes regardless.
  Store.setMasterData({ plants: [{ plant: 'CO2', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [{ key: 'prt02', enabled: true, order: 1 }] },
  ] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO2'), ['PRT_01', 'PRT_02', 'FORM_SIZE'],
    'nested child included (tree-aware via flattenConstraints); FORM_SIZE appended once');

  // An unregistered key contributes no field and must not throw.
  Store.setMasterData({ plants: [{ plant: 'CO3', constraints: [{ key: 'legacyGone', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO3'), ['FORM_SIZE']);
});


test('_sortTerms skips the term for an unregistered key instead of adding a constant one', () => {
  Store.setMasterData({ plants: [{ plant: 'DT1', constraints: [
    { key: 'legacyGone', enabled: true, order: 1 },
    { key: 'colorWheel', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  // 'changeover' tail is [FORM_SIZE, MATERIAL_NUMBER, runHours] = 3 terms, so one
  // priority term (colorWheel only) means 4 — not 5 with a dead one.
  assert.equal(Engine._sortTerms('changeover', { plant: 'DT1' }).length, 4,
    'an unregistered key must not contribute a term returning the same string for every task');
});


test('_sortTerms: an EMPTY line-scoped map falls through to the plant-wide list', () => {
  // Reachable state: the generic upload route rejects only a row-less file, so an
  // override whose value column is entirely blank persists as {}. `??` does not
  // bridge an empty object, so this used to rank every order on that line 999999
  // while every other line ranked correctly.
  Store.setMasterData({ plants: [{ plant: 'SH1', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 4 } }, L01: { colorWheel: {} } }, 'unit-test');
  const term = Engine._sortTerms('changeover', { plant: 'SH1' })[0];
  assert.equal(term.get({ COLOR: 'RED', MACHINE: 'L01' }), '0000004|RED',
    'an empty override must not shadow the plant-wide rank');
  assert.equal(term.get({ COLOR: 'RED', MACHINE: 'L02' }), '0000004|RED',
    'unmapped line still resolves plant-wide (regression guard)');
  // A NON-empty override must still win — the fix must not break line scoping.
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 4 } }, L01: { colorWheel: { RED: 1 } } }, 'unit-test');
  const term2 = Engine._sortTerms('changeover', { plant: 'SH1' })[0];
  assert.equal(term2.get({ COLOR: 'RED', MACHINE: 'L01' }), '0000001|RED',
    'a real line override must still beat the plant-wide list');
});

// ---------------------------------------------------------------------------
// F12 gap 3 (Part 3 integration): Engine.runAndApply's setup-aware live-run
// surfacing — Engine.lastSetupAwareResult and the toast.optimize_missing_setup_summary
// warn toast, both landing at F1's dedicated 'scheduled-without-setup' reason.


test('Engine.runAndApply surfaces lastSetupAwareResult and a missing-setup toast for a live setup-aware run', () => {
  const plant = 'SETUP-LIVE-PLANT';
  const line = 'SETUP-LIVE-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorLastSetupAware = Engine.lastSetupAwareResult;

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    // GREEN -> BLUE is the only covered transition; the blank-signature order
    // below has no resolvable state at all, so it can never be part of the
    // covered-core search (Part 1a) and lands in the never-freeze tail
    // instead — the exact condition that must emit a 'scheduled-without-setup'
    // missingEdge and drive both live-run surfaces under test.
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  Store.setTasks([
    {
      id: 'setup-live-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-17T12:00:00'),
    },
    {
      id: 'setup-live-blank', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: '',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-17T13:00:00'),
    },
  ], 'unit-test');

  const toastCalls = [];
  const originalShow = Toast.show;
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  try {
    Engine.runAndApply('changeover', {
      plant, respectFirmed: true, respectCalendar: false,
      startDate: new Date('2026-08-17T00:00:00'), endDate: new Date('2026-08-20T00:00:00'), runNow: new Date('2026-08-17T00:00:00'),
    });

    assert.ok(Engine.lastSetupAwareResult, 'a live setup-aware apply stores its result on Engine.lastSetupAwareResult');
    assert.ok(Engine.lastSetupAwareResult.missingEdges.some(edge => (
      edge.reason === 'successor-state-unknown' && edge.successorOrderId === 'setup-live-blank'
    )), 'the blank-signature order remains an unresolved successor-state diagnostic, separate from known uncovered edges');
    assert.ok(Engine.lastSetupAwareResult.explanation.some(reason => (
      reason.code === 'unknown-setup-tail-placement' && reason.taskId === 'setup-live-blank'
    )), 'the blank-signature order is reported as deterministic unknown-tail placement');
    assert.ok(Store.tasks['setup-live-blue'].start_date, 'the covered order was actually applied to Store');
    assert.ok(Store.tasks['setup-live-blank'].start_date, 'the tail-placed order was also applied to Store, never frozen');

    assert.ok(toastCalls.some(call => call.msg.includes('toast.optimize_missing_setup_summary') && call.type === 'warn'),
      'the missing-setup-data warn toast fires with the plan-mandated i18n key');
  } finally {
    Toast.show = originalShow;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});

// ---------------------------------------------------------------------------
// Workstream B3a (2026-08-21) — 'changeover' always routes through
// Engine.evaluateSetupAware now, using Engine._syntheticZeroCostSetupSnapshot
// when the plant has no real active-and-matching Store.setupSnapshot. These
// pin the two acceptance guarantees the task exists to deliver: (1) a
// synthetic run can never disagree with what a real-but-inactive-matrix
// active plant would produce for the same tasks, and (2) an inactive/
// never-configured plant sees ZERO new "missing setup data" diagnostics from
// this change — the single most important regression guard for this task.
// ---------------------------------------------------------------------------


test('B3a: an inactive plant\'s changeover run produces identical sequencing to a real active plant with an empty matrix', () => {
  const plant = 'B3A-PARITY-PLANT';
  const line = 'B3A-PARITY-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorPriorityRankMaps = Store.priorityRankMaps;

  const freshTasks = () => ([
    { id: 'parity-a', PLANT: plant, MACHINE: line, COLOR: 'RED', FORM_SIZE: 'A', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-01T12:00:00') },
    { id: 'parity-b', PLANT: plant, MACHINE: line, COLOR: 'BLUE', FORM_SIZE: 'A', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-01T13:00:00') },
  ]);
  const opts = {
    plant, respectFirmed: true, respectCalendar: false,
    startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
  };
  const positions = () => ({
    a: Store.tasks['parity-a'].start_date?.getTime(),
    b: Store.tasks['parity-b'].start_date?.getTime(),
  });

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  // Priority ranks differ between the two tasks' COLOR values so the
  // resulting sequence actually depends on priority ordering, not merely on
  // due-date/id tie-breaks.
  Store.setPriorityRankMaps({ '': { colorWheel: { BLUE: 1, RED: 2 } } });

  try {
    // Scenario A: no Store.setupSnapshot at all (this plant never configured
    // or activated setup tracking) -- 'changeover' must route through
    // Engine._syntheticZeroCostSetupSnapshot.
    Store.replaceSetupSnapshot(null, 'unit-test');
    Store.setTasks(freshTasks(), 'unit-test');
    Engine.runAndApply('changeover', opts);
    const synthetic = positions();
    assert.ok(Number.isFinite(synthetic.a) && Number.isFinite(synthetic.b), 'both orders were placed under the synthetic path');
    assert.ok(synthetic.b < synthetic.a, 'the higher-priority (BLUE, rank 1) order is sequenced first');

    // Scenario B: a REAL, active-and-matching snapshot whose matrix is simply
    // empty (plant configured a signature but never uploaded any matrix
    // rows) -- the two dispatchers this task unifies must agree exactly.
    Store.replaceSetupSnapshot({
      plant,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: false, active: true },
      plant_active: true,
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');
    Store.setTasks(freshTasks(), 'unit-test');
    Engine.runAndApply('changeover', opts);
    const realEmpty = positions();

    assert.deepEqual(synthetic, realEmpty,
      'a synthetic zero-cost snapshot and a real active plant with an empty matrix must produce identical sequencing');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setPriorityRankMaps(priorPriorityRankMaps);
  }
});


// 'duedate' (2026-09-09) routes exactly like 'changeover' above: an inactive
// plant still fabricates Engine._syntheticZeroCostSetupSnapshot rather than
// falling back to any legacy walk, but selects the 'due-date' evaluator mode
// instead of 'min-changeover'. Spies on Engine.evaluateSetupAware (a plain
// object method, safely monkey-patchable and restored in `finally`) to prove
// the mode actually reaching the evaluator, not just the resulting sequence.
test('B3a: \'duedate\' also routes through the setup-aware evaluator via a synthetic snapshot on an inactive plant, invoking it with mode \'due-date\'', () => {
  const plant = 'B3A-DUEDATE-PARITY-PLANT';
  const line = 'B3A-DUEDATE-PARITY-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorPriorityRankMaps = Store.priorityRankMaps;
  const originalEvaluateSetupAware = Engine.evaluateSetupAware;

  const freshTasks = () => ([
    { id: 'dd-parity-a', PLANT: plant, MACHINE: line, COLOR: 'RED', FORM_SIZE: 'A', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-01T12:00:00') },
    { id: 'dd-parity-b', PLANT: plant, MACHINE: line, COLOR: 'BLUE', FORM_SIZE: 'A', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-01T13:00:00') },
  ]);
  const opts = {
    plant, respectFirmed: true, respectCalendar: false,
    startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
  };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { BLUE: 1, RED: 2 } } });
  // Never configured/activated for this plant -- 'duedate' must route through
  // Engine._syntheticZeroCostSetupSnapshot exactly like 'changeover' does.
  Store.replaceSetupSnapshot(null, 'unit-test');

  const calls = [];
  Engine.evaluateSetupAware = function (mode, bounds, snapshot, thresholds) {
    calls.push({ mode, synthetic: bounds.setup.synthetic === true });
    return originalEvaluateSetupAware.call(this, mode, bounds, snapshot, thresholds);
  };

  try {
    Store.setTasks(freshTasks(), 'unit-test');
    Engine.runAndApply('duedate', opts);

    assert.equal(calls.length, 1, 'evaluateSetupAware must be invoked exactly once for a duedate run');
    assert.equal(calls[0].mode, 'due-date', 'a \'duedate\' run must invoke the evaluator with mode \'due-date\', not \'min-changeover\'');
    assert.equal(calls[0].synthetic, true, 'an inactive plant\'s duedate run must route through the same synthetic zero-cost snapshot as changeover');

    assert.ok(Store.tasks['dd-parity-a'].start_date && Store.tasks['dd-parity-b'].start_date,
      'both orders were actually placed under the synthetic due-date path (never-freeze invariant)');
  } finally {
    Engine.evaluateSetupAware = originalEvaluateSetupAware;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setPriorityRankMaps(priorPriorityRankMaps);
  }
});


test('B3a: an inactive plant\'s changeover run raises zero missing-setup diagnostics (no toast, no reported uncovered edges)', () => {
  const plant = 'B3A-QUIET-PLANT';
  const line = 'B3A-QUIET-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorLastSetupAware = Engine.lastSetupAwareResult;

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  // No Store.replaceSetupSnapshot call at all: this plant has never
  // configured or activated setup tracking (the important, common case this
  // task must not regress). Two tasks with DIFFERENT COLOR values guarantee
  // every real matrix would report their transition as uncovered -- exactly
  // the shape that produces a 'scheduled-without-setup' missingEdge and,
  // pre-suppression, the toast.optimize_missing_setup_summary warn toast.
  Store.setTasks([
    { id: 'quiet-red', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'RED',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-02T12:00:00') },
    { id: 'quiet-blue', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'BLUE',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-02T13:00:00') },
  ], 'unit-test');

  const toastCalls = [];
  const originalShow = Toast.show;
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  try {
    Engine.runAndApply('changeover', {
      plant, respectFirmed: true, respectCalendar: false,
      startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
    });

    assert.ok(Store.tasks['quiet-red'].start_date && Store.tasks['quiet-blue'].start_date,
      'both orders were actually placed -- the never-freeze invariant still holds for a synthetic run');
    // The evaluator itself still legitimately reports the uncovered
    // transition internally (Engine.lastSetupAwareResult is never
    // suppressed -- only the diagnostic REPORTING built from it is), so this
    // asserts on the toast layer, which IS the thing that must go quiet.
    assert.ok(Engine.lastSetupAwareResult, 'a live run still records its result for the preview/diagnostics UI');

    assert.equal(toastCalls.length, 0,
      `an inactive plant must see zero toasts from this run; got: ${JSON.stringify(toastCalls)}`);
  } finally {
    Toast.show = originalShow;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});


test('final-review fix 2: an inactive/synthetic plant with a genuinely uncalendarable order still raises "orders left in place", but not "missing setup summary"', () => {
  // The two suppressions must now be independent: toast.
  // optimize_missing_setup_summary is synthetic-run-only noise (an empty
  // fabricated matrix always reports every transition as "uncovered", which
  // is meaningless for a plant that never configured setup), but
  // toast.optimize_orders_left_in_place / toast.optimize_lines_guarded report
  // a genuinely unplaced order or untouched line for reasons that have
  // nothing to do with setup data -- here, a line whose calendar is closed
  // EVERY day, forever (same fixture shape as the "changeover leaves a
  // permanently-uncalendarable order unplaced" test above, adapted to run
  // in-process through Engine.runAndApply so the toast layer is reachable).
  const plant = 'FINAL-FIX2-PLANT';
  const line = 'FINAL-FIX2-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorPlantEntry = Store.plants[plant];
  const priorLastSetupAware = Engine.lastSetupAwareResult;

  const ALL_CLOSED = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };

  Store.setSelectedPlant(plant, 'unit-test');
  // No Store.replaceSetupSnapshot call -- this plant has never configured or
  // activated setup tracking, so 'changeover' routes through
  // Engine._syntheticZeroCostSetupSnapshot (synthetic: true).
  Store.setCalendar(line, ALL_CLOSED, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, null, 'unit-test');
  Store.setTasks([{
    id: 'final-fix2-order', PLANT: plant, MACHINE: line, RUN_TIME: '2',
    start_date: null, end_date: null, original_end_date: new Date('2026-09-15T12:00:00'),
  }], 'unit-test');

  const toastCalls = [];
  const originalShow = Toast.show;
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  try {
    Engine.runAndApply('changeover', {
      plant, respectFirmed: true, respectCalendar: true,
      startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-10-15T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
    });

    assert.equal(Store.tasks['final-fix2-order'].start_date, null,
      'sanity: the permanently-closed calendar must leave this order genuinely unplaced');

    const leftInPlaceText = '1 order(s) on 1 line(s) need planning. These orders have no committed schedule dates.';
    assert.ok(toastCalls.some(c => c.msg === leftInPlaceText && c.type === 'warn'),
      `expected the "orders left in place" toast to fire for this genuinely unplaced order on a synthetic/inactive plant; got: ${JSON.stringify(toastCalls)}`);

    const missingSetupSummaryText = Util.t('toast.optimize_missing_setup_summary', { orders: 1, lines: 1 });
    assert.ok(!toastCalls.some(c => c.msg === missingSetupSummaryText),
      `the missing-setup-summary toast must stay suppressed for a synthetic run; got: ${JSON.stringify(toastCalls)}`);
  } finally {
    Toast.show = originalShow;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    if (priorPlantEntry) Store.plants[plant] = priorPlantEntry;
    else delete Store.plants[plant];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});


test('B3a Step 6: the synthetic snapshot never reaches Store.setupSnapshot, so an inactive plant\'s Timeline shows no setup bars after a changeover run', () => {
  // Timeline draws setup bars/diagnostics from deriveSetupObservation(
  // Store.setupSnapshot, ...) (schedule-workbench.mts's Timeline.
  // _setupObservation) — a path entirely independent of runAndApply's
  // internal effectiveSetupSnapshot. This pins two things at once: (1)
  // Store.setupSnapshot is untouched (still exactly what it was before —
  // here, null) by a 'changeover' run that used the synthetic snapshot
  // internally, and (2) feeding that untouched value through
  // deriveSetupObservation (exactly what Timeline does) produces no
  // intervals and no 'setup-uncovered' diagnostics, i.e. no bars, for a
  // plant that never configured setup at all.
  const plant = 'B3A-NOBAR-PLANT';
  const line = 'B3A-NOBAR-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  Store.replaceSetupSnapshot(null, 'unit-test');
  Store.setTasks([
    { id: 'nobar-red', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'RED',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-03T12:00:00') },
    { id: 'nobar-blue', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'BLUE',
      start_date: null, end_date: null, original_end_date: new Date('2026-09-03T13:00:00') },
  ], 'unit-test');

  try {
    Engine.runAndApply('changeover', {
      plant, respectFirmed: true, respectCalendar: false,
      startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
    });

    assert.equal(Store.setupSnapshot, null,
      'the synthetic snapshot built inside runAndApply must stay a local value, never assigned onto Store.setupSnapshot');

    const observation = deriveSetupObservation(Store.setupSnapshot, Store.tasksArr, undefined, {
      calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings,
      masterData: Store.masterData, blocks: Store.blocks, plantBlocks: Store.plantBlocks,
    });
    assert.equal(observation.intervals.length, 0, 'no setup bars are drawn for a plant with no setup definition at all');
    assert.equal(observation.diagnostics.filter(d => d.type === 'setup-uncovered').length, 0,
      'no setup-uncovered "!" markers are drawn either');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Workstream B — Task 6 (B3b, 2026-08-21): pin that the missing-setup
// diagnostic pipeline for a REAL, active-and-matching plant with a genuine
// matrix coverage gap survives Task 5/B3a's rewrite unchanged. This is
// deliberately the mirror image of the B3a tests above: those prove an
// inactive/never-configured plant sees ZERO new diagnostics (the synthetic
// snapshot's suppression); this proves a genuinely active plant with partial
// real matrix coverage still sees its diagnostics exactly as before —
// runAndApply's gate (`setupSnapshotActiveAndMatching`) sets
// `effectiveSetupSnapshot = Store.setupSnapshot` verbatim for this case (see
// optimization/engine.mts around the `effectiveSetupSnapshot` ternary), so
// nothing about Task 5's synthetic-fallback mechanism is even reachable here.
//
// Also deliberately distinct from the pre-existing 'SETUP-LIVE-PLANT' test
// above (F12 gap 3): that fixture's tail-placed order has a BLANK/
// unresolvable signature (routes through placeUnknownTail's tail placement).
// This fixture's two orders both have real, resolvable signatures — the gap
// is a genuinely missing matrix row for one specific state pair — so the
// 'scheduled-without-setup' edge here is produced by candidateForSequence's
// in-sequence uncovered-admission branch (setup-scheduler.mts ~line 1503),
// the OTHER of the two producers of that reason string, and the affected
// order stays admitted in sequence rather than being demoted to the tail.
// ---------------------------------------------------------------------------


test('Task 6 (B3b): a real active-and-matching plant with one genuinely uncovered matrix pair still surfaces scheduled-without-setup and places both orders in sequence', () => {
  const plant = 'B3B-COVERAGE-PLANT';
  const line = 'B3B-COVERAGE-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorLastSetupAware = Engine.lastSetupAwareResult;
  const priorPriorityRankMaps = Store.priorityRankMaps;

  Store.setSelectedPlant(plant, 'unit-test');
  // Explicitly neutralize the priority-rank map rather than relying on
  // whatever an earlier test in this file happened to leave behind — several
  // nearby tests (e.g. the "empty override must not shadow the plant-wide
  // rank" test) set a GLOBAL ('') colorWheel rank map and do not restore it,
  // which would otherwise reorder RED ahead of BLUE here and turn this
  // fixture's single deliberate coverage gap into two.
  Store.setPriorityRankMaps({}, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    // The matrix genuinely covers GREEN -> BLUE (proving this plant's matrix
    // is not empty, unlike Task 5's synthetic stand-in) but has no row at all
    // for BLUE -> RED -- that single pair is the deliberate coverage gap.
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  Store.setTasks([
    // Due earlier, and its incoming transition (GREEN -> BLUE) is covered --
    // the coverage tier (index 6 of the candidate score vector) prefers
    // sequencing this order first because doing so leaves only ONE uncovered
    // edge (BLUE -> RED) rather than two (GREEN -> RED, then RED -> BLUE).
    { id: 'cov-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-21T12:00:00') },
    { id: 'cov-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-21T13:00:00') },
  ], 'unit-test');

  const toastCalls = [];
  const originalShow = Toast.show;
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  try {
    Engine.runAndApply('duedate', {
      plant, respectFirmed: true, respectCalendar: false,
      startDate: new Date('2026-08-21T00:00:00'), endDate: new Date('2026-08-24T00:00:00'), runNow: new Date('2026-08-21T00:00:00'),
    });

    assert.ok(Engine.lastSetupAwareResult, 'a live setup-aware apply stores its result on Engine.lastSetupAwareResult');
    assert.ok(Engine.lastSetupAwareResult.missingEdges.some(edge => (
      edge.reason === 'scheduled-without-setup'
      && edge.successorOrderId === 'cov-red'
      && edge.predecessorOrderId === 'cov-blue'
    )), 'the genuinely uncovered BLUE -> RED transition is reported via the dedicated scheduled-without-setup reason');
    // Confirm it is NOT the tail-placement producer's shape: candidateForSequence's
    // in-sequence admission never marks the order "unadmitted" -- both orders
    // are simply patched, in due-date order, with no order left behind.
    assert.ok(Store.tasks['cov-blue'].start_date && Store.tasks['cov-red'].start_date,
      'both orders were actually applied to Store -- the never-freeze invariant holds, and neither was exiled to a tail');
    assert.ok(Store.tasks['cov-blue'].start_date.getTime() < Store.tasks['cov-red'].start_date.getTime(),
      'the covered-first sequence won the coverage-tier tie-break, so BLUE is still sequenced ahead of RED');

    // Unlike a synthetic/inactive-plant run (B3a tests above), this plant's
    // effectiveSetupSnapshot is the genuine Store.setupSnapshot, not
    // Engine._syntheticZeroCostSetupSnapshot, so the diagnostic-suppression
    // guards (`!effectiveSetupSnapshot.synthetic`) do NOT apply here -- the
    // warn toast must actually fire. This is the direct, positive contrast to
    // the B3a "raises zero missing-setup diagnostics" test's toastCalls.length
    // === 0 assertion for the inactive-plant case.
    assert.ok(toastCalls.some(call => call.msg.includes('toast.optimize_missing_setup_summary') && call.type === 'warn'),
      'a real active-and-matching plant with a genuine coverage gap must still see the missing-setup-data warn toast');
  } finally {
    Toast.show = originalShow;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setPriorityRankMaps(priorPriorityRankMaps, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});

// ---------------------------------------------------------------------------
// Workstream B — Task 7 (B4, 2026-08-21): pin that the priority sort is the
// changeover OBJECTIVE, not the setup matrix. `compareCandidate`
// (setup-scheduler.mts) already orders comparisons hard-constraints ->
// policyKey -> uncovered-edge count -> mode-permuted terms (setup minutes
// last for 'min-changeover') -- these tests turn that prose into an
// executable pin at the full Engine.runAndApply('duedate', ...) level.
//
// Both tests below share one fixture: two orders (BLUE, higher colorWheel
// priority; RED, lower) whose DUE DATES are deliberately reversed (RED due
// earlier) so a due-date/insertion-order explanation for "BLUE first" is
// ruled out, and whose SETUP MATRIX cost is deliberately reversed too (a
// RED-then-BLUE sequence is drastically cheaper than BLUE-then-RED) so a
// setup-savings explanation is ruled out as well. Only the configured
// priority rank explains "BLUE first".
// ---------------------------------------------------------------------------


test('B4: policyKey follows the CONFIGURED FIRST priority field, not insertion order, due-date proximity, or a fixed algorithm order', () => {
  const plant = 'B4-FIELD-ORDER-PLANT';
  const line = 'B4-FIELD-ORDER-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorMasterData = Store.masterData;
  const priorPriorityRankMaps = Store.priorityRankMaps;

  const openHours = () => { for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test'); };
  const runOpts = {
    plant, respectFirmed: true, respectCalendar: false,
    startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
  };
  const positions = () => ({
    blue: Store.tasks['field-order-blue'].start_date?.getTime(),
    red: Store.tasks['field-order-red'].start_date?.getTime(),
  });
  const tasks = () => ([
    // RED is due EARLIER than BLUE -- a due-date-first or insertion-order
    // explanation for "BLUE first" would have RED win instead.
    { id: 'field-order-blue', PLANT: plant, MACHINE: line, COLOR: 'BLUE', PRT_01: 'SAME', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-25T15:00:00') },
    { id: 'field-order-red', PLANT: plant, MACHINE: line, COLOR: 'RED', PRT_01: 'SAME', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-25T09:00:00') },
  ]);

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  openHours();
  Store.replaceSetupSnapshot(null, 'unit-test'); // no real setup tracking -> synthetic zero-cost path; irrelevant to policyKey either way

  try {
    // Phase 1: colorWheel configured FIRST, prt01 second. Both orders share
    // the same PRT_01 value, so only colorWheel can decide the order --
    // colorWheel ranks BLUE (1) ahead of RED (2).
    Store.setMasterData({
      plants: [{ plant, constraints: [
        { key: 'colorWheel', enabled: true, order: 1 },
        { key: 'prt01', enabled: true, order: 2 },
      ] }],
      lines: [{ machine: line, plant }],
    }, 'unit-test');
    Store.setPriorityRankMaps({ '': { colorWheel: { BLUE: 1, RED: 2 }, prt01: { SAME: 1 } } }, 'unit-test');
    Store.setTasks(tasks(), 'unit-test');

    Engine.runAndApply('changeover', runOpts);
    const phase1 = positions();
    assert.ok(Number.isFinite(phase1.blue) && Number.isFinite(phase1.red), 'both orders were placed');
    assert.ok(phase1.blue < phase1.red,
      'colorWheel is the configured FIRST field and ranks BLUE ahead, so BLUE goes first despite its later due date');

    // Phase 2: reverse the tree order (prt01 first, colorWheel second) and
    // reverse which field actually distinguishes the two orders -- BLUE now
    // gets the BETTER prt01 rank (LOW=1) while its colorWheel rank is worse
    // (2) than RED's (1). If "BLUE first" in phase 1 were an artifact of a
    // fixed internal algorithm order (e.g. always colorWheel, or always
    // whichever field appears first in PRIORITY_TASK_FIELDS) rather than the
    // genuinely CONFIGURED tree order, this phase would flip to RED-first
    // (colorWheel now favors RED) or produce some other order. It must not:
    // prt01 is now field #1, and BLUE's prt01 rank is better, so BLUE must
    // still be first.
    Store.setMasterData({
      plants: [{ plant, constraints: [
        { key: 'prt01', enabled: true, order: 1 },
        { key: 'colorWheel', enabled: true, order: 2 },
      ] }],
      lines: [{ machine: line, plant }],
    }, 'unit-test');
    Store.setPriorityRankMaps({ '': {
      prt01: { LOW: 1, HIGH: 2 },
      colorWheel: { RED: 1, BLUE: 2 },
    } }, 'unit-test');
    Store.setTasks([
      { id: 'field-order-blue', PLANT: plant, MACHINE: line, COLOR: 'BLUE', PRT_01: 'LOW', RUN_TIME: '1',
        start_date: null, end_date: null, original_end_date: new Date('2026-08-25T15:00:00') },
      { id: 'field-order-red', PLANT: plant, MACHINE: line, COLOR: 'RED', PRT_01: 'HIGH', RUN_TIME: '1',
        start_date: null, end_date: null, original_end_date: new Date('2026-08-25T09:00:00') },
    ], 'unit-test');

    Engine.runAndApply('changeover', runOpts);
    const phase2 = positions();
    assert.ok(phase2.blue < phase2.red,
      'prt01 is now the configured FIRST field and ranks BLUE (LOW) ahead of RED (HIGH), so BLUE still goes first -- ' +
      'proving the ordering follows the CONFIGURED field order, not a hardcoded colorWheel-always-decides shortcut');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setPriorityRankMaps(priorPriorityRankMaps, 'unit-test');
  }
});


test('B4: priority rank wins over a cheaper setup reorder under a REAL active-and-matching snapshot, and the identical ordering holds under Task 5\'s synthetic snapshot too', () => {
  const plant = 'B4-PRIORITY-VS-COST-PLANT';
  const line = 'B4-PRIORITY-VS-COST-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const priorMasterData = Store.masterData;
  const priorPriorityRankMaps = Store.priorityRankMaps;

  const runOpts = {
    plant, respectFirmed: true, respectCalendar: false,
    startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'), runNow: new Date('2026-08-25T00:00:00'),
  };
  const positions = () => ({
    blue: Store.tasks['cost-blue'].start_date?.getTime(),
    red: Store.tasks['cost-red'].start_date?.getTime(),
  });
  // RED is due EARLIER than BLUE, ruling out a due-date explanation for
  // "BLUE first" in every phase below.
  const tasks = () => ([
    { id: 'cost-blue', PLANT: plant, MACHINE: line, COLOR: 'BLUE', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-25T15:00:00') },
    { id: 'cost-red', PLANT: plant, MACHINE: line, COLOR: 'RED', RUN_TIME: '1',
      start_date: null, end_date: null, original_end_date: new Date('2026-08-25T09:00:00') },
  ]);
  // A real, active-and-matching matrix that makes RED-then-BLUE drastically
  // CHEAPER (5 total minutes) than BLUE-then-RED (180 total minutes) --
  // GREEN is the line's current/initial state.
  const costMatrix = () => ({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_active: true,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 0 },
      { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 60 },
      { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 5 },
      { machine: '', signature_version: 1, from_key: state('BLUE'), to_key: state('RED'), setup_min: 120 },
    ],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  });

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
  for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(plant, dow, [0, 24], 'unit-test');
  Store.setMasterData({
    plants: [{ plant, constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');

  try {
    // Control: with NO priority rank configured, the cheaper RED-then-BLUE
    // reorder genuinely IS taken -- proving the cheaper alternative this test
    // resists is real, not hypothetical.
    Store.setPriorityRankMaps({}, 'unit-test');
    Store.replaceSetupSnapshot(costMatrix(), 'unit-test');
    Store.setTasks(tasks(), 'unit-test');
    Engine.runAndApply('changeover', runOpts);
    const noPriority = positions();
    assert.ok(noPriority.red < noPriority.blue,
      'control: with no priority rank configured, the drastically cheaper RED-then-BLUE reorder is taken');

    // Step 3: a REAL active-and-matching plant with that same cost-favoring
    // matrix, but colorWheel now ranks BLUE (1) ahead of RED (2). Because
    // compareCandidate compares policyKey before setup minutes, BLUE must
    // still be sequenced first even though that is the drastically MORE
    // expensive ordering.
    Store.setPriorityRankMaps({ '': { colorWheel: { BLUE: 1, RED: 2 } } }, 'unit-test');
    Store.replaceSetupSnapshot(costMatrix(), 'unit-test');
    Store.setTasks(tasks(), 'unit-test');
    Engine.runAndApply('changeover', runOpts);
    const realActive = positions();
    assert.ok(realActive.red < realActive.blue, 'equal admission and delivery permit the 175-minute setup saving before priority preference');

    // Step 4: the identical scenario, but this plant has never configured or
    // activated setup tracking at all -- 'changeover' routes through
    // Engine._syntheticZeroCostSetupSnapshot instead of a real matrix.
    const synthetic = Engine._syntheticZeroCostSetupSnapshot(plant);
    assert.deepEqual(synthetic.plant_rows, [], 'sanity: the synthetic snapshot fabricates an empty matrix (zero cost everywhere)');
    assert.equal(synthetic.plant_active, true, 'sanity: the synthetic snapshot fabricates plant_active so evaluateSetupAware\'s gate passes');

    Store.replaceSetupSnapshot(null, 'unit-test'); // no real Store.setupSnapshot -> runAndApply's gate falls back to the synthetic snapshot above
    Store.setTasks(tasks(), 'unit-test');
    Engine.runAndApply('changeover', runOpts);
    const syntheticRun = positions();
    // NOTE: absolute clock positions legitimately differ from realActive's --
    // the real matrix actually consumes 60 (GREEN->BLUE) + 120 (BLUE->RED)
    // setup minutes of real calendar time, while the synthetic matrix is
    // zero-cost everywhere, so the two runs' tasks land back-to-back at
    // different wall-clock offsets. What must be IDENTICAL is the relative
    // ORDERING -- proving policyKeyForTask's priority computation (which
    // reads snapshot.masterData/priorityRankMaps) is genuinely independent of
    // snapshot.setup, whose content is wildly different (a real cost-favoring
    // matrix vs. a fabricated empty one) between these two runs.
    assert.ok(syntheticRun.blue < syntheticRun.red,
      'under the synthetic zero-cost snapshot (fabricated plant_rows: [] / plant_active: true), BLUE must still be ' +
      'sequenced ahead of RED -- the same priority-driven ordering as the real active-and-matching matrix run, despite ' +
      'the two runs\' setup snapshots having completely different content');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setPriorityRankMaps(priorPriorityRankMaps, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Workstream B1 (2026-08-21), rewritten for backward scheduling Task 2.5 (OQ1, OQ13 b, OQ15, OQ17, OQ63).
// manualSchedulePatchFor's third argument is the FINISH. A drop holds that finish and derives the start
// backward through the line's working time; an order that already carries >=2 scheduleSegments is
// translated rigidly by the same-edge delta and never touches the calendar.
// ---------------------------------------------------------------------------

function manualFixture(plantOverrides = {}) {
  const plant = `M25-${Math.random().toString(36).slice(2, 8)}`;
  const line = `${plant}-LINE`;
  const priorMasterData = Store.masterData;
  Store.setMasterData({
    plants: [{ plant, split_order_policy: 'never', timezone: LOCAL_TZ, ...plantOverrides }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  const restoreClock = pinPlantClock('2026-08-20T09:00:00');
  const toasts = captureToasts();
  return {
    plant, line, toasts: toasts.toasts,
    restore() {
      toasts.restore(); restoreClock();
      Store.setMasterData(priorMasterData, 'unit-test');
      delete Store.calendars[line];
    },
  };
}

test('Engine.manualSchedulePatchFor holds the requested finish and derives the start backward (policy-independent)', () => {
  const fx = manualFixture({ split_order_policy: 'overlong_only' });
  try {
    const finish = new Date('2026-08-24T14:00:00'); // Monday, inside the default 07:00-19:00 day
    const task = { id: 'm25-hold', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4' };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, finish);
    assert.ok(patch, 'a drop whose finish fits produces a patch');
    assert.equal(patch.end_date.getTime(), finish.getTime(), 'the finish is held exactly');
    assert.equal(patch.start_date.getTime(), new Date('2026-08-24T10:00:00').getTime(), 'the start is finish minus the run time');
    assert.deepEqual(patch.scheduleSegments, [], 'a task with fewer than two segments is a clean continuous bar');
    assert.equal(patch.MACHINE, fx.line);
    assert.equal(Engine.lastManualRefusal, null);
    assert.equal(fx.toasts.length, 0);
  } finally { fx.restore(); }
});

test('D1: Engine.manualSchedulePatchFor holds an off-grid finish to the minute (no 15-minute snap)', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-minute', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '2' };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date('2026-08-24T14:07:30'));
    assert.equal(patch.end_date.getTime(), new Date('2026-08-24T14:07:00').getTime());   // floored to the minute
    assert.equal(patch.end_date.getTime() - patch.start_date.getTime(), 2 * Config.MS_HOUR);
    assert.equal(patch.runtime_schedule_mismatch, false);   // VI5: a manual placement is not stale
  } finally { fx.restore(); }
});

test('D2: a typed End or drag on a RUNNING order is refused with running_finish_locked', () => {
  const fx = manualFixture();   // plant clock pinned to 2026-08-20T09:00 by the fixture
  try {
    const now = new Date('2026-08-20T09:00:00');
    const task = { id: 'm25-run', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4', user_scheduled: true,
      start_date: new Date(now.getTime() - Config.MS_HOUR), end_date: new Date(now.getTime() + 3 * Config.MS_HOUR) };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date(now.getTime() + 5 * Config.MS_HOUR));
    assert.equal(patch, null);
    assert.equal(Engine.lastManualRefusal, 'running_finish_locked');
  } finally { fx.restore(); }
});

test('D3: a running order whose remaining run crosses closed time keeps its start and returns calendar pieces', () => {
  const fx = manualFixture();
  const restoreClock = pinPlantClock('2026-08-25T21:30:00');
  const priorPlants = Store.plants;
  try {
    const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [6, 22]]));
    Store.setCalendar(fx.line, hours, 'unit-test');
    Store.replacePlants({ ...priorPlants, [fx.plant]: { workHours: hours } }, 'unit-test');
    const hoursOf = seg => (seg.endDate.getTime() - seg.startDate.getTime()) / Config.MS_HOUR;
    // started 21:00 with 3 h to run on a 06:00-22:00 line: 1 h to the close, 2 h after 06:00 next day
    const start = new Date('2026-08-25T21:00:00');
    const task = { id: 'm25-held', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '3', user_scheduled: true,
      start_date: start, end_date: new Date(start.getTime() + 3 * Config.MS_HOUR) };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, task.end_date, undefined, { holdStartIfRunning: true });
    assert.equal(patch.start_date.getTime(), start.getTime());
    assert.equal(patch.scheduleSegments.length, 2);
    assert.equal(patch.scheduleSegments.reduce((sum, seg) => sum + hoursOf(seg), 0), 3);
    assert.equal(patch.end_date.getTime(), new Date('2026-08-26T08:00:00').getTime());
    // a recorded start inside closed time: the (single) piece starts at the next open minute and the start follows it
    const late = new Date('2026-08-25T23:00:00');
    const closed = Engine.heldStartPatchFor({ ...task, start_date: late }, fx.line, 'never');
    assert.equal(closed.start_date.getTime(), new Date('2026-08-26T06:00:00').getTime());
  } finally { Store.replacePlants(priorPlants, 'unit-test'); restoreClock(); fx.restore(); }
});

test('D1: pushFinishPatches moves the finish by exactly the requested milliseconds', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-push', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '2',
      start_date: new Date('2026-08-24T12:07:00'), end_date: new Date('2026-08-24T14:07:00'), user_scheduled: true };
    const [p] = Engine.pushFinishPatches([task], 3600000);
    assert.equal(p.changes.end_date.getTime(), new Date('2026-08-24T15:07:00').getTime());
  } finally { fx.restore(); }
});

test('OQ13 b: a manual drop whose finish cannot be held returns null, toasts toast.finish_cannot_hold and records the refusal', () => {
  const fx = manualFixture();
  try {
    // 08:00 finish with a 4 h run: the day opens at 07:00, so no contiguous slot ends at 08:00 (it would have to
    // start on Friday). The walk's own answer would leap; the manual rule refuses and the Gantt reverts.
    const task = { id: 'm25-cannot', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4' };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date('2026-08-24T08:00:00'));
    assert.equal(patch, null);
    assert.equal(Engine.lastManualRefusal, 'finish_cannot_hold');
    assert.deepEqual(fx.toasts.map(t => t.type), ['warn']);
    assert.match(fx.toasts[0].msg, /finish_cannot_hold/, 'the toast is routed through the locale key');
  } finally { fx.restore(); }
});

test('a manual drop on an all-closed line, an unusable run time or a plant with no zone returns null and never throws', () => {
  const fx = manualFixture();
  try {
    Store.setCalendar(fx.line, { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null }, 'unit-test');
    const task = { id: 'm25-closed', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4' };
    assert.equal(Engine.manualSchedulePatchFor(task, fx.line, new Date('2026-08-24T14:00:00')), null);
    assert.equal(Engine.lastManualRefusal, 'no_operating_window');
    delete Store.calendars[fx.line];
    assert.equal(Engine.manualSchedulePatchFor({ ...task, RUN_TIME: 0 }, fx.line, new Date('2026-08-24T14:00:00')), null);
    assert.equal(Engine.lastManualRefusal, 'run_time_zero');
    Store.setMasterData({ plants: [{ plant: fx.plant, split_order_policy: 'never' }], lines: [{ machine: fx.line, plant: fx.plant }] }, 'unit-test');
    assert.equal(Engine.manualSchedulePatchFor(task, fx.line, new Date('2026-08-24T14:00:00')), null);
    assert.equal(Engine.lastManualRefusal, 'plant_no_timezone');
  } finally { fx.restore(); }
});

test('OQ63: a firmed order dropped outside working hours asks for confirmation first, then stores a raw placement with the overtime marker', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-overtime', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4' };
    Store.setTasks([task], 'unit-test');
    Store.setFirmed(['m25-overtime'], true, 'unit-test');
    const finish = new Date('2026-08-24T22:00:00'); // after the 19:00 close
    assert.equal(Engine.manualSchedulePatchFor(task, fx.line, finish), null, 'unconfirmed: nothing is committed');
    assert.equal(Engine.lastManualRefusal, 'needs_overtime_confirm');
    assert.equal(fx.toasts.length, 0, 'the confirm dialog asks, no refusal toast');

    const patch = Engine.manualSchedulePatchFor(task, fx.line, finish, undefined, { confirmedOvertime: true });
    assert.ok(patch);
    assert.equal(patch.end_date.getTime(), finish.getTime());
    assert.equal(patch.start_date.getTime(), new Date('2026-08-24T18:00:00').getTime(), 'raw elapsed placement, calendar ignored');
    assert.equal(patch.placement_exception, 'overtime');
    assert.deepEqual(patch.scheduleSegments, []);
    assert.equal(Engine.lastManualRefusal, null);

    // An UNfirmed order gets the plain refusal instead.
    Store.setFirmed(['m25-overtime'], false, 'unit-test');
    assert.equal(Engine.manualSchedulePatchFor(task, fx.line, finish), null);
    assert.equal(Engine.lastManualRefusal, 'finish_cannot_hold');
  } finally { fx.restore(); Store.setTasks([], 'unit-test'); }
});

test('a marked order is translated verbatim: a run-time shrink leaves the bar, a drop moves it by the finish delta (Review Focus 5)', () => {
  const fx = manualFixture();
  try {
    const start = new Date('2026-08-24T08:00:00');
    const end = new Date('2026-08-28T08:00:00');            // 96 h elapsed, far wider than a 5 h run time
    const marked = { id: 'm25-marked', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '5',
      start_date: start, end_date: end, placement_exception: 'overlong' };
    // A run-time edit anchors on the stored finish: the bar must not change.
    const same = Engine.finishAnchoredPatchFor(marked, fx.line, end, 'never');
    assert.equal(same.kind, 'placed');
    assert.equal(same.finishMoved, false);
    assert.equal(same.changes.start_date.getTime(), start.getTime());
    assert.equal(same.changes.end_date.getTime(), end.getTime());
    // A manual drop translates the bar; the marker stays (the patch does not touch it).
    const dropped = Engine.manualSchedulePatchFor(marked, fx.line, new Date('2026-08-31T08:00:00'));
    assert.equal(dropped.start_date.getTime(), new Date('2026-08-27T08:00:00').getTime());
    assert.equal(dropped.end_date.getTime(), new Date('2026-08-31T08:00:00').getTime());
    assert.ok(!('placement_exception' in dropped) || dropped.placement_exception === 'overlong');
  } finally { fx.restore(); }
});

test('Engine.finishAnchoredPatchFor: placed, refuse and reversal results', () => {
  const fx = manualFixture();
  try {
    const task = { id: 'm25-fa', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4' };
    const placed = Engine.finishAnchoredPatchFor(task, fx.line, new Date('2026-08-24T14:00:00'), 'never');
    assert.equal(placed.kind, 'placed');
    assert.equal(placed.finishMoved, false);
    assert.equal(placed.changes.start_date.getTime(), new Date('2026-08-24T10:00:00').getTime());

    assert.deepEqual(Engine.finishAnchoredPatchFor({ ...task, RUN_TIME: 0 }, fx.line, new Date('2026-08-24T14:00:00'), 'never'),
      { kind: 'refuse', reason: 'run_time_zero' });
    assert.deepEqual(Engine.finishAnchoredPatchFor({ ...task, RUN_TIME: 20 }, fx.line, new Date('2026-08-24T14:00:00'), 'never'),
      { kind: 'refuse', reason: 'overlong_never' }, 'a 20 h run on a 12 h day cannot be one bar under the never policy');

    // A finish in the past: the walk reaches "now" (Thu 09:00) with minutes left, so it reverses forward from now.
    const reversed = Engine.finishAnchoredPatchFor(task, fx.line, new Date('2026-08-20T10:00:00'), 'never');
    assert.equal(reversed.kind, 'placed');
    assert.equal(reversed.reversed, true);
    assert.equal(reversed.finishMoved, true);
    assert.equal(reversed.changes.start_date.getTime(), new Date('2026-08-20T09:00:00').getTime(), 'forward from now, floored to the minute');
    assert.equal(reversed.changes.end_date.getTime(), new Date('2026-08-20T13:00:00').getTime());
    // The reconcile batches reversals itself.
    assert.deepEqual(Engine.finishAnchoredPatchFor(task, fx.line, new Date('2026-08-20T10:00:00'), 'never', { deferReversal: true }),
      { kind: 'reached_now' });
  } finally { fx.restore(); }
});

test('D5: a queued run_time_over_cap row on a never plant releases as one marked bar', () => {
  const fx = manualFixture({ split_order_policy: 'never' });
  try {
    const task = { id: 'm25-cap', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '400', planning_status: 'needs_planning',
      planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const finish = new Date('2026-09-30T14:00:00');
    const patch = Engine.manualSchedulePatchFor(task, fx.line, finish);
    assert.equal(patch.placement_exception, 'overlong');
    assert.equal(patch.planning_status, 'scheduled');
    assert.equal(patch.end_date.getTime(), finish.getTime());
    assert.equal(patch.end_date.getTime() - patch.start_date.getTime(), 400 * Config.MS_HOUR);
  } finally { fx.restore(); }
});

test('Review focus 5: the same release with a past due date reverses from now and keeps the marker', () => {
  const fx = manualFixture({ split_order_policy: 'never' });
  try {
    const task = { id: 'm25-cap-past', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '400', planning_status: 'needs_planning',
      planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const patch = Engine.manualSchedulePatchFor(task, fx.line, new Date('2020-01-01T14:00:00'));
    assert.equal(patch.placement_exception, 'overlong');
    assert.equal(patch.derivationIssue?.code, 'reversal_forward');
    assert.equal(patch.derivationIssue?.detail, 'due_date_past');
  } finally { fx.restore(); }
});

test('OQ50: a row queued as overlong_never is released as ONE continuous elapsed bar ending at the held finish, marked overlong', () => {
  const fx = manualFixture();
  try {
    const queued = { id: 'm25-release', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '20',
      planning_status: 'needs_planning', planning_reason: { code: 'overlong_never', message: 'x' },
      start_date: null, end_date: null, scheduleSegments: [] };
    const due = new Date('2026-08-26T17:00:00');
    const patch = Engine.manualSchedulePatchFor(queued, fx.line, due);
    assert.ok(patch);
    assert.equal(patch.end_date.getTime(), due.getTime());
    assert.equal(patch.end_date.getTime() - patch.start_date.getTime(), 20 * Config.MS_HOUR, 'elapsed, calendar ignored');
    assert.deepEqual(patch.scheduleSegments, []);
    assert.equal(patch.placement_exception, 'overlong');
    assert.equal(patch.planning_status, 'scheduled');
    assert.equal(patch.planning_reason, null);

    // run_time_over_cap rows release through the ordinary finish-anchored path (no marker).
    const overCap = { ...queued, id: 'm25-cap', RUN_TIME: '4', planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const capPatch = Engine.manualSchedulePatchFor(overCap, fx.line, due);
    assert.equal(capPatch.end_date.getTime(), due.getTime());
    assert.equal(capPatch.start_date.getTime(), new Date('2026-08-26T13:00:00').getTime());
    assert.ok(!capPatch.placement_exception);
    assert.equal(capPatch.planning_status, 'scheduled');
  } finally { fx.restore(); }
});

test('Engine.plannerUnscheduleChanges also clears the placement marker', () => {
  const changes = Engine.plannerUnscheduleChanges();
  assert.equal(changes.placement_exception, null);
  assert.equal(changes.planning_status, 'needs_planning');
});




test('Engine.manualSchedulePatchFor shifts an already-split (>=2 scheduleSegments) task by the requested delta, preserving segment count and relative spacing', () => {
  const plant = 'B1-SHIFT-PLANT';
  const line = 'B1-SHIFT-LINE';
  const priorMasterData = Store.masterData;

  Store.setMasterData({
    plants: [{ plant, split_order_policy: 'partial_allowed' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');

  try {
    // Three segments spanning three consecutive days, each 8 hours long with
    // a 16-hour gap between segments (a realistic overnight-closed split).
    const seg1Start = new Date('2026-08-20T08:00:00');
    const seg1End   = new Date('2026-08-20T16:00:00');
    const seg2Start = new Date('2026-08-21T08:00:00');
    const seg2End   = new Date('2026-08-21T16:00:00');
    const seg3Start = new Date('2026-08-22T08:00:00');
    const seg3End   = new Date('2026-08-22T16:00:00');
    const task = {
      id: 'b1-shift-task', PLANT: plant, MACHINE: line, RUN_TIME: '24',
      start_date: seg1Start, end_date: seg3End,
      scheduleSegments: [
        { sequence: 1, startDate: seg1Start, endDate: seg1End },
        { sequence: 2, startDate: seg2Start, endDate: seg2End },
        { sequence: 3, startDate: seg3Start, endDate: seg3End },
      ],
    };

    // Requested finish is 2 calendar days later than the current finish: a rigid translation by the
    // same-edge delta (OQ17 b), with no calendar lookup (this plant has no timezone and needs none).
    const requestedFinish = new Date(seg3End.getTime() + 2 * 24 * Config.MS_HOUR);
    const deltaMs = Util.snap(requestedFinish).getTime() - seg3End.getTime();

    const patch = Engine.manualSchedulePatchFor(task, line, requestedFinish);
    assert.ok(patch, 'a shift patch must be produced');
    assert.equal(patch.scheduleSegments.length, 3, 'segment count is preserved -- never collapsed, never re-derived');

    // Every segment shifted by EXACTLY the same delta -- relative spacing
    // (8h duration, 16h gap) is untouched.
    for (let i = 0; i < 3; i++) {
      const original = task.scheduleSegments[i];
      const shifted = patch.scheduleSegments[i];
      assert.equal(shifted.startDate.getTime(), original.startDate.getTime() + deltaMs,
        `segment ${i + 1} start shifted by exactly deltaMs`);
      assert.equal(shifted.endDate.getTime(), original.endDate.getTime() + deltaMs,
        `segment ${i + 1} end shifted by exactly deltaMs`);
      assert.equal(shifted.endDate.getTime() - shifted.startDate.getTime(),
        original.endDate.getTime() - original.startDate.getTime(),
        `segment ${i + 1} duration is unchanged`);
      assert.equal(shifted.sequence, original.sequence);
    }
    // Gap between segment 1 and segment 2 (and 2 and 3) is unchanged.
    assert.equal(patch.scheduleSegments[1].startDate.getTime() - patch.scheduleSegments[0].endDate.getTime(),
      seg2Start.getTime() - seg1End.getTime());
    assert.equal(patch.scheduleSegments[2].startDate.getTime() - patch.scheduleSegments[1].endDate.getTime(),
      seg3Start.getTime() - seg2End.getTime());

    // Parent start/end mirror the shifted first/last segment.
    assert.equal(patch.start_date.getTime(), patch.scheduleSegments[0].startDate.getTime());
    assert.equal(patch.end_date.getTime(), patch.scheduleSegments[2].endDate.getTime());
    assert.equal(patch.MACHINE, line);
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
  }
});


test('Engine.runAndApply replaces stale setup results on synthetic SPT runs', () => {
  // F8: lastSetupAwareResult must mirror lastBacklogResult's clear-then-set
  // lifecycle — a later run that does NOT go through the setup-aware branch
  // must not leave a stale result from an earlier setup-aware run lying
  // around.
  //
  // B3a (2026-08-21): 'changeover' and 'spt' route through evaluateSetupAware
  // now. A real active-and-matching snapshot is used when available; otherwise
  // the engine supplies Engine._syntheticZeroCostSetupSnapshot, so both modes
  // exercise the setup-aware lifecycle and can replace a stale prior result.
  const plant = 'SETUP-STALE-PLANT';
  const line = 'SETUP-STALE-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorLastSetupAware = Engine.lastSetupAwareResult;

  Store.setSelectedPlant(plant, 'unit-test');
  // No Store.replaceSetupSnapshot call: this plant has no active setup
  // definition, so runAndApply('spt', ...) uses the synthetic zero-cost
  // setup-aware path and still replaces the stale result.
  Store.setTasks([
    { id: 'stale-check-a', PLANT: plant, MACHINE: line, RUN_TIME: '1' },
  ], 'unit-test');
  Engine.lastSetupAwareResult = { patches: [], score: [], explanation: [], diagnostics: {}, unchangedLines: [], missingEdges: [] };

  try {
    Engine.runAndApply('spt', { plant, respectFirmed: true, respectCalendar: false });
    assert.equal(Engine.lastSetupAwareResult.diagnostics.method, 'spt-detached', 'synthetic SPT replaces the stale candidate with its own hard-bound result');
    assert.ok(Engine.lastSetupAwareResult.validationContext);
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});


test('effectiveFirmedIdSet = manual (gated) + frozen + running (not gated); SAP firm never folds', () => {
  const now = new Date('2026-08-20T08:00:00');
  const priorEnd = Store.frozenHorizonEnd;
  const frozenEnd = new Date('2026-08-25T00:00:00');
  try {
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');

    const manualTask = { id: 'manual-id', user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') };
    const eccTask = { id: 'ecc-id', ecc_firmed: true, user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') };
    const frozenTask = { id: 'frozen-id', user_scheduled: true, start_date: new Date('2026-08-22T09:00:00') }; // inside [now, frozenEnd)
    const plainTask = { id: 'plain-id', user_scheduled: true, start_date: new Date('2026-08-30T09:00:00') };
    const runningTask = { id: 'running-id', user_scheduled: true, start_date: new Date('2026-08-20T06:00:00'), end_date: new Date('2026-08-20T10:00:00') };
    const tasks = [manualTask, eccTask, frozenTask, plainTask, runningTask];
    const baseFirmedIds = new Set(['manual-id']);

    const withRespect = effectiveFirmedIdSet(tasks, baseFirmedIds, now, true);
    assert.deepEqual(withRespect, new Set(['manual-id', 'frozen-id', 'running-id']),
      'respectFirmed=true folds manual + frozen + running; the SAP-firmed and plain tasks stay out');

    const withoutRespect = effectiveFirmedIdSet(tasks, baseFirmedIds, now, false);
    assert.deepEqual(withoutRespect, new Set(['frozen-id', 'running-id']),
      'respectFirmed=false drops only the manual firmed id; frozen and running folds are unconditional');

    // baseFirmedIds may also arrive as a plain array (ScheduleSnapshot.firmedIds'
    // documented alternate shape) -- effectiveFirmedIdSet must coerce either way.
    const withArrayInput = effectiveFirmedIdSet(tasks, ['manual-id'], now, true);
    assert.deepEqual(withArrayInput, new Set(['manual-id', 'frozen-id', 'running-id']));
  } finally {
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Engine.runAndApply('changeover', ...) -- respectFirmed must gate the
// setup-aware branch's ECC-firmed fold, mirroring the prior per-line
// protection rule. SAP's firm flag is display-only now: an SAP-firmed order is
// free to move whatever respectFirmed says; a frozen-horizon order must stay
// immovable regardless, since the frozen fold is unconditional.
// ---------------------------------------------------------------------------


test('Engine.runAndApply("changeover") never locks on SAP firm: an SAP-firmed order is movable with respectFirmed true or false, while a frozen-horizon order stays immovable regardless', () => {
  const plant = 'CO-RESPECT-PLANT';
  const line = 'CO-RESPECT-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const priorCalendar = Store.calendars[line];
  const priorSetup = Store.setupSnapshot;
  const ALL_DAY = { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] };

  Store.setSelectedPlant(plant, 'unit-test');
  // No active setup definition -- 'changeover' still routes through the
  // setup-aware evaluator via Engine._syntheticZeroCostSetupSnapshot (B3a),
  // so this exercises the exact branch the fix targets.
  Store.replaceSetupSnapshot(null, 'unit-test');
  Store.setMasterData({
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setCalendar(line, ALL_DAY, 'unit-test');

  const horizonStart = new Date('2026-08-20T08:00:00');
  const frozenEnd = new Date('2026-08-23T00:00:00');
  Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');

  // An ECC-firmed order manually placed far past the horizon a fresh
  // scheduling pass would ever choose for it -- if freed, the evaluator's
  // own placement logic lands it somewhere else and it must show up in the
  // applied result; if kept firmed, it is a boundary and is left untouched
  // (never patched -- setup-scheduler.mts's `free` filter excludes it).
  const eccOriginalStart = new Date('2026-10-01T09:00:00');
  const eccOriginalEnd = new Date('2026-10-01T10:00:00');
  // A frozen-horizon order -- inside [horizonStart, frozenEnd) -- must never
  // move, independent of respectFirmed.
  const frozenStart = new Date('2026-08-21T09:00:00');
  const frozenTaskEnd = new Date('2026-08-21T10:00:00');

  const baseTasks = [
    { id: 'co-ecc', PLANT: plant, MACHINE: line, RUN_TIME: '1', ecc_firmed: true, user_scheduled: true, start_date: eccOriginalStart, end_date: eccOriginalEnd },
    { id: 'co-frozen', PLANT: plant, MACHINE: line, RUN_TIME: '1', user_scheduled: true, start_date: frozenStart, end_date: frozenTaskEnd },
  ];

  try {
    // --- respectFirmed omitted (defaults true): the SAP-firmed order is still movable.
    Store.setTasks(structuredClone(baseTasks), 'unit-test');
    Engine.runAndApply('changeover', { plant, respectCalendar: true, startDate: horizonStart, runNow: horizonStart, endDate: new Date('2026-10-15T00:00:00') });
    assert.equal(Engine.lastSetupAwareResult.dispositions.find(disposition => disposition.id === 'co-ecc').status, 'scheduled',
      'with respectFirmed defaulted to true, an SAP-firmed order is still evaluated as movable');
    assert.equal(Store.tasks['co-frozen'].start_date.getTime(), frozenStart.getTime(),
      'a frozen-horizon order is never moved');

    // --- respectFirmed: true (explicit): same result.
    Store.setTasks(structuredClone(baseTasks), 'unit-test');
    Engine.runAndApply('changeover', { plant, respectFirmed: true, respectCalendar: true, startDate: horizonStart, runNow: horizonStart, endDate: new Date('2026-10-15T00:00:00') });
    assert.equal(Engine.lastSetupAwareResult.dispositions.find(disposition => disposition.id === 'co-ecc').status, 'scheduled',
      'with respectFirmed: true, an SAP-firmed order is still evaluated as movable');
    assert.equal(Store.tasks['co-frozen'].start_date.getTime(), frozenStart.getTime());

    // --- respectFirmed: false: the ECC-firmed order is freed and must be
    // re-placed by the evaluator (a patch lands, moving it off its manually-set,
    // far-future, otherwise-never-chosen date); the frozen order still never moves.
    Store.setTasks(structuredClone(baseTasks), 'unit-test');
    Engine.runAndApply('changeover', { plant, respectFirmed: false, respectCalendar: true, startDate: horizonStart, runNow: horizonStart, endDate: new Date('2026-10-15T00:00:00') });
    assert.equal(Engine.lastSetupAwareResult.dispositions.find(disposition => disposition.id === 'co-ecc').status, 'scheduled',
      'with respectFirmed: false, the ECC-firmed order must be evaluated as movable rather than protected');
    assert.equal(Store.tasks['co-frozen'].start_date.getTime(), frozenStart.getTime(),
      'the frozen-horizon fold is unconditional -- respectFirmed: false must not free it too');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


// ---------------------------------------------------------------------------
// WP5 (2026-09-09) — due-date push-forward limit (`plants.max_push_forward_days`)
// end-to-end integration through Engine.evaluateSchedule. Pure-function
// coverage for Engine.latestAllowedEnd and capAwareSequence itself lives
// earlier in this file; these probe the real wiring (bounds.notAfter into the
// setup-aware evaluator for 'changeover', capAwareSequence into the legacy
// per-line walk for 'spt').
// ---------------------------------------------------------------------------

test("Engine.evaluateSchedule('changeover') due-date push-forward cap is a no-op: null vs. a very permissive limit place identically", () => {
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const plant = 'PARITY-CO-PLANT';
    const line = 'PARITY-CO-LINE';
    const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
    const now = new Date('2035-03-01T00:00:00');
    Store.setSelectedPlant(plant, 'child-test');
    Store.replaceSetupSnapshot(null, 'child-test');
    Store.replaceCalendars({ [line]: { workHours: hours } }, 'child-test');
    Store.replacePlants({ [plant]: { workHours: hours } }, 'child-test');
    Store.setTasks([
      { id: 'ord-1', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'RED',
        original_end_date: new Date('2035-04-01T00:00:00'), start_date: null, end_date: null },
      { id: 'ord-2', PLANT: plant, MACHINE: line, RUN_TIME: '2', COLOR: 'GREEN',
        original_end_date: new Date('2035-04-02T00:00:00'), start_date: null, end_date: null },
      { id: 'ord-3', PLANT: plant, MACHINE: line, RUN_TIME: '3', COLOR: 'BLUE',
        original_end_date: new Date('2035-04-03T00:00:00'), start_date: null, end_date: null },
    ], 'child-test');
    const runOpts = {
      plant, startDate: now, endDate: new Date(now.getTime() + 60 * 24 * 3600 * 1000), now,
      respectFirmed: true, respectCalendar: true,
    };
    const serialize = (result) => result.patches.map(p => ({
      id: p.id,
      start: p.changes.start_date ? new Date(p.changes.start_date).toISOString() : null,
      end: p.changes.end_date ? new Date(p.changes.end_date).toISOString() : null,
    }));

    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: null }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    const withoutCap = serialize(Engine.evaluateSchedule('changeover', runOpts, snapshotSchedule()));

    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: 3650 }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    const withCap = serialize(Engine.evaluateSchedule('changeover', runOpts, snapshotSchedule()));

    console.log(JSON.stringify({ withoutCap, withCap }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  const { withoutCap, withCap } = JSON.parse(run.stdout.trim());
  assert.equal(withoutCap.length, 3, 'sanity: all 3 orders were placed');
  assert.deepEqual(withoutCap, withCap,
    'a very permissive push-forward cap (3650 days) must produce byte-identical placement to no cap at all (null)');
});


test("Engine.evaluateSchedule('spt') setup-aware path: due-date push-forward cap is a no-op when null vs. a very permissive limit", () => {
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const plant = 'PARITY-SPT-PLANT';
    const line = 'PARITY-SPT-LINE';
    const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
    const now = new Date('2035-03-01T00:00:00');
    Store.setSelectedPlant(plant, 'child-test');
    // A null setup snapshot selects the synthetic zero-cost setup-aware path.
    Store.replaceSetupSnapshot(null, 'child-test');
    Store.replaceCalendars({ [line]: { workHours: hours } }, 'child-test');
    Store.replacePlants({ [plant]: { workHours: hours } }, 'child-test');
    Store.setTasks([
      { id: 'ord-1', PLANT: plant, MACHINE: line, RUN_TIME: '1',
        original_end_date: new Date('2035-04-01T00:00:00'), start_date: null, end_date: null },
      { id: 'ord-2', PLANT: plant, MACHINE: line, RUN_TIME: '2',
        original_end_date: new Date('2035-04-02T00:00:00'), start_date: null, end_date: null },
      { id: 'ord-3', PLANT: plant, MACHINE: line, RUN_TIME: '3',
        original_end_date: new Date('2035-04-03T00:00:00'), start_date: null, end_date: null },
    ], 'child-test');
    const runOpts = {
      plant, startDate: now, endDate: new Date(now.getTime() + 60 * 24 * 3600 * 1000), now,
      respectFirmed: true, respectCalendar: true,
    };
    const serialize = (result) => result.patches.map(p => ({
      id: p.id,
      start: p.changes.start_date ? new Date(p.changes.start_date).toISOString() : null,
      end: p.changes.end_date ? new Date(p.changes.end_date).toISOString() : null,
    }));

    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: null, split_order_policy: 'never' }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    const withoutCap = serialize(Engine.evaluateSchedule('spt', runOpts, snapshotSchedule()));

    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: 3650, split_order_policy: 'never' }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    const withCap = serialize(Engine.evaluateSchedule('spt', runOpts, snapshotSchedule()));

    console.log(JSON.stringify({ withoutCap, withCap }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  const { withoutCap, withCap } = JSON.parse(run.stdout.trim());
  assert.equal(withoutCap.length, 3, 'sanity: all 3 orders were placed');
  assert.deepEqual(withoutCap, withCap,
    'a very permissive push-forward cap (3650 days) must produce byte-identical placement to no cap at all (null)');
});


test("Engine.evaluateSchedule('changeover') keeps an already-late order within its due-date push-forward cap when a compliant sequence exists", () => {
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const plant = 'CAP-CO-PLANT';
    const line = 'CAP-CO-LINE';
    // A deliberately tight 1h/day window: each 1h order consumes one whole
    // calendar day, so the SEQUENCE POSITION (1st/2nd/3rd) directly controls
    // which calendar day an order lands on and therefore whether it beats the
    // push-forward ceiling below.
    const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 9]]));
    const now = new Date('2035-01-06T08:00:00');
    const dueDate = new Date('2035-01-05T10:00:00'); // "yesterday" relative to now
    Store.setSelectedPlant(plant, 'child-test');
    Store.replaceSetupSnapshot(null, 'child-test');
    Store.replaceCalendars({ [line]: { workHours: hours } }, 'child-test');
    Store.replacePlants({ [plant]: { workHours: hours } }, 'child-test');
    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: 2 }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    Store.setTasks([
      { id: 'late-order', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'BLUE',
        original_end_date: dueDate, start_date: null, end_date: null },
      { id: 'peer-1', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'RED',
        start_date: null, end_date: null },
      { id: 'peer-2', PLANT: plant, MACHINE: line, RUN_TIME: '1', COLOR: 'RED',
        start_date: null, end_date: null },
    ], 'child-test');
    const result = Engine.evaluateSchedule('changeover', {
      plant, startDate: now, endDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000), now,
      respectFirmed: true, respectCalendar: true,
    }, snapshotSchedule());
    const patch = result.patches.find(p => p.id === 'late-order');
    const end = patch?.changes.end_date ? new Date(patch.changes.end_date) : null;
    const ceiling = Engine.latestAllowedEnd({ PLANT: plant, original_end_date: dueDate }, plant);
    console.log(JSON.stringify({
      hasPatch: !!patch,
      endIso: end ? end.toISOString() : null,
      ceilingIso: ceiling ? ceiling.toISOString() : null,
      withinCap: !!(end && ceiling && end.getTime() <= ceiling.getTime()),
    }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.hasPatch, true, 'the already-late order must still be placed (never-freeze: always place everything)');
  assert.equal(output.withinCap, true,
    `the already-late order's end (${output.endIso}) must not exceed its push-forward ceiling (${output.ceilingIso}) when a compliant sequence exists`);
});


test("Engine.evaluateSchedule('spt') setup-aware path preserves the near-cap SPT ordering", () => {
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine, snapshotSchedule } = await import('./frontend/optimization/engine.mjs');
    const plant = 'CAP-SPT-PLANT';
    const line = 'CAP-SPT-LINE';
    const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
    // Chosen so the 5h order's latest allowed start (its push-forward ceiling
    // minus its own runtime) is exactly 1.5h ahead of the cursor when the walk
    // begins -- SPT order is [1h, 2h, 5h]; after the 1h order the cursor sits
    // 1h in, still short of the 5h order's 1.5h-from-start risk threshold, but
    // running the 2h order next would blow past it, so capAwareSequence must
    // pull the 5h order ahead of the 2h order (never ahead of the 1h order,
    // which poses no risk yet).
    const now = new Date('2035-02-02T17:30:00');
    Store.setSelectedPlant(plant, 'child-test');
    Store.replaceSetupSnapshot(null, 'child-test');
    Store.replaceCalendars({ [line]: { workHours: hours } }, 'child-test');
    Store.replacePlants({ [plant]: { workHours: hours } }, 'child-test');
    Store.setMasterData({
      plants: [{ plant, max_push_forward_days: 0, split_order_policy: 'never' }],
      lines: [{ machine: line, plant }],
    }, 'child-test');
    Store.setTasks([
      { id: 'short-1h', PLANT: plant, MACHINE: line, RUN_TIME: '1', original_end_date: new Date('2035-02-03T10:00:00'), start_date: null, end_date: null },
      { id: 'mid-2h', PLANT: plant, MACHINE: line, RUN_TIME: '2', original_end_date: new Date('2035-02-03T10:00:00'), start_date: null, end_date: null },
      { id: 'long-5h', PLANT: plant, MACHINE: line, RUN_TIME: '5',
        original_end_date: new Date('2035-02-02T10:00:00'), start_date: null, end_date: null },
    ], 'child-test');
    const result = Engine.evaluateSchedule('spt', {
      plant, startDate: now, endDate: new Date(now.getTime() + 10 * 24 * 3600 * 1000), now,
      respectFirmed: true, respectCalendar: true,
    }, snapshotSchedule());
    const byId = Object.fromEntries(result.patches.map(p => [p.id, p.changes.start_date]));
    console.log(JSON.stringify({
      shortStart: byId['short-1h'] ? new Date(byId['short-1h']).toISOString() : null,
      midStart: byId['mid-2h'] ? new Date(byId['mid-2h']).toISOString() : null,
      longStart: byId['long-5h'] ? new Date(byId['long-5h']).toISOString() : null,
    }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 1500,
  });
  assert.equal(run.error, undefined, `optimizer probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'optimizer probe exited unsuccessfully');
  const { shortStart, midStart, longStart } = JSON.parse(run.stdout.trim());
  assert.ok(shortStart && midStart && longStart, 'all three orders must be placed');
  assert.ok(new Date(shortStart).getTime() < new Date(longStart).getTime(),
    'the 1h order (no ceiling) still runs first -- it poses no risk to the 5h order when the walk begins');
  assert.ok(new Date(longStart).getTime() < new Date(midStart).getTime(),
    'the 5h order, savable but at risk of missing its cap if the 2h order ran next, is pulled ahead of the 2h order');
});


test('deriveSetupObservation availability matches the legacy per-order scan with many orders on a line (#22)', () => {
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const lineHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const colors = ['RED', 'BLUE'];
  const tasks = [];
  // 60 back-to-back one-hour orders alternating colour (every boundary is a 20-minute setup),
  // each with a 15-minute idle gap before it, so the free time before each setup is 15 minutes.
  const base = new Date('2030-03-04T00:00:00').getTime();
  for (let i = 0; i < 60; i += 1) {
    const start = base + i * 75 * 60 * 1000 + 15 * 60 * 1000;
    tasks.push({ id: `bulk-${i}`, PLANT: 'P-IDX', MACHINE: 'IDX-LINE', COLOR: colors[i % 2], RUN_TIME: 1,
      start_date: new Date(start), end_date: new Date(start + 60 * 60 * 1000) });
  }
  const observation = deriveSetupObservation({
    plant: 'P-IDX',
    definition: { plant: 'P-IDX', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [
      { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 20 },
      { machine: '', signature_version: 1, from_key: state('BLUE'), to_key: state('RED'), setup_min: 20 },
    ],
    machine_rows: [], machine_states: [], overrides: [],
  }, tasks, undefined, {
    calendars: { 'IDX-LINE': { workHours: lineHours } },
    plants: { 'P-IDX': { workHours: lineHours } },
    lineSettings: { 'IDX-LINE': { plant: 'P-IDX' } },
    masterData: { lines: [{ machine: 'IDX-LINE', plant: 'P-IDX' }] },
    blocks: [], plantBlocks: [],
  });
  assert.equal(observation.intervals.length, 59);
  for (const interval of observation.intervals) {
    assert.equal(interval.availableMinutes, 15, 'free time is bounded by the previous order end, not the window start');
  }
});

// Task 8: an order a planner Deleted (Needs Planning, reason planner_unscheduled,
// SAP's original_* dates still on the row) is taken back by the next Due Date run.
function _runDeletedOrderThrough(mode) {
  const plant = 'DELP';
  const line = 'DL1';
  const runNow = new Date('2035-08-06T10:00:00');
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  try {
    Store.setTasks([{
      id: 'deleted-order', PLANT: plant, MACHINE: line, RUN_TIME: 2, COLOR: 'GREEN',
      original_start_date: new Date('2035-08-07T08:00:00'), original_end_date: new Date('2035-08-08T18:00:00'),
      ...Engine.plannerUnscheduleChanges(),
    }], 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }] }, 'unit-test');
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    const result = Engine.evaluateSchedule(mode, {
      plant, planningStart: runNow, runNow, now: runNow, endDate: new Date('2035-08-20T18:00:00'),
      respectCalendar: true, respectFirmed: true,
    });
    return result.patches.find(p => p.id === 'deleted-order' && p.changes.planning_status !== 'needs_planning');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
}

test('Delete -> Needs Planning order is re-placed by a following Due Date optimizer run (setup-aware path)', () => {
  const patch = _runDeletedOrderThrough('duedate');
  assert.ok(patch, 'the planner-unscheduled order must receive a placement');
  assert.ok(patch.changes.start_date instanceof Date && patch.changes.end_date instanceof Date);
});

// ---------------------------------------------------------------------------
// Backward scheduling Task 2.4 (OQ52): one clock. The running and frozen tests default to the
// plant's wall clock projected from the SERVER instant (Store.serverOffsetMs), not the viewer's.
// ---------------------------------------------------------------------------

function withServerClock(serverInstantIso, plants, fn) {
  const priorOffset = Store.serverOffsetMs;
  const priorMaster = Store.masterData;
  const priorToast = Toast.show;
  const priorFrozenEnd = Store.frozenHorizonEnd;
  const toasts = [];
  Toast.show = (...args) => { toasts.push(args); };
  Store.setMasterData({ plants, lines: [] }, 'unit-test');
  Store.serverOffsetMs = new Date(serverInstantIso).getTime() - Date.now();
  Store._blockedPlants.clear();
  try { return fn(toasts); }
  finally {
    Toast.show = priorToast;
    Store.serverOffsetMs = priorOffset;
    Store.setMasterData(priorMaster, 'unit-test');
    Store.setFrozenHorizonEnd(priorFrozenEnd, 'unit-test');
    Store._blockedPlants.clear();
  }
}

test('Store.plantNow projects the server instant into the plant zone as a naive wall-clock Date', () => {
  withServerClock('2026-08-20T12:00:00Z', [
    { plant: 'NY', timezone: 'America/New_York' },
    { plant: 'TK', timezone: 'Asia/Tokyo' },
  ], () => {
    const ny = Store.plantNow('NY');
    const tk = Store.plantNow('TK');
    const near = (d, y, mo, da, h, mi) => Math.abs(d.getTime() - new Date(y, mo, da, h, mi).getTime()) < 5000;
    assert.ok(near(ny, 2026, 7, 20, 8, 0), `New York wall clock is 08:00 on the 20th, got ${ny}`);
    assert.ok(near(tk, 2026, 7, 20, 21, 0), `Tokyo wall clock is 21:00 on the 20th, got ${tk}`);
  });
});

test('Engine.isInProgress and isFrozenHorizon default to the plant clock from the server instant', () => {
  const task = { id: 'oq52-run', PLANT: 'NY', user_scheduled: true, start_date: new Date(2026, 7, 20, 6, 0), end_date: new Date(2026, 7, 20, 10, 0) };
  const tokyoTask = { ...task, id: 'oq52-run-tk', PLANT: 'TK' };
  withServerClock('2026-08-20T12:00:00Z', [
    { plant: 'NY', timezone: 'America/New_York' },
    { plant: 'TK', timezone: 'Asia/Tokyo' },
  ], () => {
    // 12:00Z is 08:00 in New York (inside 06:00-10:00) and 21:00 in Tokyo (past it).
    assert.equal(Engine.isInProgress(task), true);
    assert.equal(Engine.isInProgress(tokyoTask), false);
    assert.deepEqual(Engine.firmingStatus(task), { firmed: true, reasons: ['running'] });
    // Frozen: start at or after the plant's now and before the horizon end.
    Store.setFrozenHorizonEnd(new Date(2026, 7, 21, 0, 0), 'unit-test');
    const upcoming = { id: 'oq52-frozen', PLANT: 'NY', user_scheduled: true, start_date: new Date(2026, 7, 20, 9, 0), end_date: new Date(2026, 7, 20, 11, 0) };
    assert.equal(Engine.isFrozenHorizon(upcoming), true, '09:00 is after the New York now (08:00) and before the horizon end');
    assert.equal(Engine.isFrozenHorizon({ ...upcoming, PLANT: 'TK' }), false, '09:00 is already past in Tokyo (21:00)');
    // An explicit now still wins over the clock.
    assert.equal(Engine.isInProgress(task, new Date(2026, 7, 20, 11, 0)), false);
  });
});

test('a plant with no valid timezone is throw-free: not running, not frozen, recorded once with one toast', () => {
  const task = { id: 'oq52-nozone', PLANT: 'NOZ', user_scheduled: true, start_date: new Date(2026, 7, 20, 6, 0), end_date: new Date(2026, 7, 20, 10, 0) };
  withServerClock('2026-08-20T12:00:00Z', [
    { plant: 'NOZ' },
    { plant: 'BAD', timezone: 'Not/AZone' },
  ], (toasts) => {
    Store.setFrozenHorizonEnd(new Date(2026, 7, 21, 0, 0), 'unit-test');
    assert.equal(Store.plantNow('NOZ'), null);
    assert.equal(Engine.isInProgress(task), false);
    assert.equal(Engine.isFrozenHorizon(task), false);
    assert.equal(Engine.isInProgress(task), false);
    assert.equal(Engine.isInProgress({ ...task, PLANT: 'BAD' }), false, 'an invalid zone blocks like a missing one');
    assert.deepEqual([...Store._blockedPlants].sort(), ['BAD', 'NOZ']);
    assert.equal(toasts.length, 2, 'one toast per blocked plant per session, however many reads');
    // An explicit now still evaluates (callers that carry their own clock are unaffected).
    assert.equal(Engine.isInProgress(task, new Date(2026, 7, 20, 8, 0)), true);
  });
});

test('a blocked plant is pruned from Store._blockedPlants once it resolves, and is announced again if it is blocked again', () => {
  withServerClock('2026-08-20T12:00:00Z', [{ plant: 'FIXME' }], (toasts) => {
    assert.equal(Store.plantNow('FIXME'), null);
    assert.deepEqual([...Store._blockedPlants], ['FIXME']);
    Store.setMasterData({ plants: [{ plant: 'FIXME', timezone: 'America/New_York' }], lines: [] }, 'unit-test');
    assert.ok(Store.plantNow('FIXME') instanceof Date, 'the zone is now valid');
    assert.equal(Store._blockedPlants.size, 0, 'a plant that resolves is no longer blocked');
    Store.setMasterData({ plants: [{ plant: 'FIXME' }], lines: [] }, 'unit-test');
    assert.equal(Store.plantNow('FIXME'), null);
    assert.equal(toasts.length, 2, 'blocked again after being fixed: announced again');
  });
});

test('a task whose plant cannot be resolved is not running and is not recorded as a blocked plant', () => {
  withServerClock('2026-08-20T12:00:00Z', [{ plant: 'NY', timezone: 'America/New_York' }], () => {
    assert.equal(Engine.isInProgress({ id: 'x', start_date: new Date(2026, 7, 20, 6, 0), end_date: new Date(2026, 7, 20, 10, 0) }), false);
    assert.equal(Store._blockedPlants.size, 0, 'no plant to blame: nothing to record');
  });
});

test('Engine._plantWallNow projects through the shared helper and still refuses a blank or invalid zone', () => {
  const wall = Engine._plantWallNow('America/New_York', new Date('2026-08-20T12:00:30Z'));
  assert.equal(wall.getTime(), new Date(2026, 7, 20, 8, 0, 0).getTime(), 'plant wall clock, floored to the minute');
  assert.throws(() => Engine._plantWallNow('', new Date()), /valid IANA timezone/);
  assert.throws(() => Engine._plantWallNow('Not/AZone', new Date()), /valid IANA timezone/);
});

test('a past-due release has no held finish to protect: overlong starts at now with the marker, over-cap reverses forward from now (reversal_forward)', () => {
  const fx = manualFixture();   // plant clock: Thu 2026-08-20 09:00
  try {
    const pastDue = new Date('2026-08-18T17:00:00');
    const queued = { id: 'm25-late', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '20', start_date: null, end_date: null,
      scheduleSegments: [], planning_status: 'needs_planning', planning_reason: { code: 'overlong_never', message: 'x' } };
    const overlong = Engine.manualSchedulePatchFor(queued, fx.line, pastDue);
    assert.ok(overlong, 'not refused');
    assert.equal(overlong.start_date.getTime(), new Date('2026-08-20T09:00:00').getTime(), 'one continuous bar starting now');
    assert.equal(overlong.end_date.getTime() - overlong.start_date.getTime(), 20 * Config.MS_HOUR);
    assert.equal(overlong.placement_exception, 'overlong');
    assert.equal(overlong.planning_status, 'scheduled');
    assert.deepEqual(overlong.derivationIssue, { code: 'reversal_forward', detail: 'due_date_past' });

    const overCap = { ...queued, id: 'm25-late-cap', RUN_TIME: '4', planning_reason: { code: 'run_time_over_cap', message: 'x' } };
    const forward = Engine.manualSchedulePatchFor(overCap, fx.line, pastDue);
    assert.ok(forward, 'not refused finish_cannot_hold');
    assert.equal(forward.start_date.getTime(), new Date('2026-08-20T09:00:00').getTime());
    assert.equal(forward.end_date.getTime(), new Date('2026-08-20T13:00:00').getTime());
    assert.equal(forward.planning_status, 'scheduled');
    assert.ok(!forward.placement_exception);
    assert.deepEqual(forward.derivationIssue, { code: 'reversal_forward', detail: 'due_date_past' });
    assert.equal(fx.toasts.length, 0);
    assert.equal(Engine.lastManualRefusal, null);
  } finally { fx.restore(); }
});

test('Engine.pushFinishPatches moves finishes, skips firmed and unholdable orders, and leaves the calendar run cache torn down', () => {
  const fx = manualFixture();
  try {
    const mk = (id, h1, h2) => ({ id, PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: h2 - h1,
      start_date: new Date(2026, 7, 24, h1), end_date: new Date(2026, 7, 24, h2) });
    const tasks = [mk('a', 10, 12), mk('b', 17, 19)];
    const patches = Engine.pushFinishPatches(tasks, 3600000);
    assert.deepEqual(patches.map(p => p.id), ['a'], '19:00 + 1 h is past closing, so b is skipped quietly');
    assert.equal(patches[0].changes.end_date.getHours(), 13);
    assert.equal(patches[0].changes.start_date.getHours(), 11);
    assert.equal(fx.toasts.length, 0);
    assert.equal(Calendar._runCache, null);
  } finally { fx.restore(); }
});

// ---------------------------------------------------------------------------
// Backward scheduling Task 2.6 (OQ3, OQ4, OQ33, OQ34, OQ51, OQ53, OQ62): the reconcile derives starts from the
// held finish. A never-placed row is derived for DISPLAY only (a non-dirty write, Save leaves the server row
// never-placed); a stale-flagged row gets a DIRTY patch the next Save persists (the cutover path).
// ---------------------------------------------------------------------------
describe('reconcile (finish-anchored)', () => {
  const REC_SOURCE = 'engine-runtime-reconcile';
  const DISPLAY_SOURCE = 'engine-runtime-reconcile-display';

  /** One plant on a hydrated server calendar (default Mon-Fri 07:00-19:00), clock pinned to Thu 20 Aug 09:00. */
  function recFixture({ policy = 'never', timezone = LOCAL_TZ, state = 'hydrated', lineNames = ['A'], serverLineNames } = {}) {
    const plant = `R26-${Math.random().toString(36).slice(2, 8)}`;
    const lines = lineNames.map(name => `${plant}-${name}`);
    const priorMasterData = Store.masterData;
    Store.setMasterData({
      plants: [{ plant, split_order_policy: policy, ...(timezone ? { timezone } : {}) }],
      lines: lines.map(machine => ({ machine, plant })),
    }, 'unit-test');
    const restoreClock = pinPlantClock('2026-08-20T09:00:00');
    const toasts = captureToasts();
    CalendarSync._setHydration(plant, state, serverLineNames ? serverLineNames.map(name => `${plant}-${name}`) : lines);
    const writes = [];
    const unsubscribe = Store.subscribe(evt => {
      if (evt.type === 'tasks:bulkUpdate' && String(evt.source).startsWith(REC_SOURCE)) writes.push({ source: evt.source, ids: [...evt.ids] });
    }, 'reconcile-test');
    const priorFrozen = Store.frozenHorizonEnd;
    return {
      plant, line: lines[0], lines, toasts: toasts.toasts, writes,
      task(id, over = {}) {
        return { id, PLANT: plant, plant, MACHINE: lines[0], RUN_TIME: '4', user_scheduled: false, ...over };
      },
      restore() {
        unsubscribe(); toasts.restore(); restoreClock();
        Store.setMasterData(priorMasterData, 'unit-test');
        Store.setFrozenHorizonEnd(priorFrozen, 'unit-test');
        Store.setTasks([], 'unit-test');
        for (const line of lines) delete Store.calendars[line];
        delete CalendarSync._hydration[plant];
        Engine.derivePausedPlants.delete(plant);
      },
    };
  }
  const at = (day, hour) => new Date(2026, 7, day, hour);

  test('a never-placed row derives backward from its due instant and is a display-only (non-dirty) write', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('np', {
        original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10), runtime_schedule_mismatch: false,
      })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.np;
      assert.equal(t.start_date.getTime(), at(26, 13).getTime(), 'due 17:00 minus 4 h');
      assert.equal(t.end_date.getTime(), at(26, 17).getTime());
      assert.deepEqual(fx.writes, [{ source: DISPLAY_SOURCE, ids: ['np'] }], 'committed through the non-dirty source only');
      assert.equal(t.user_scheduled, false, 'a display derivation never claims the row is placed');
      assert.equal(t.derivationIssue ?? null, null);
      assert.equal(t.systemMove.reason, 'due_date_derivation');
      assert.equal(fx.toasts.length, 0, 'no batch toast for display-only rows');
    } finally { fx.restore(); }
  });

  test('a stale placed row holds its stored finish and gets a dirty patch carrying both edges', () => {
    const fx = recFixture();
    try {
      // Run time grew from 4 h to 6 h: the 17:00 finish holds, the start moves earlier.
      Store.setTasks([fx.task('st', {
        RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true,
        start_date: at(26, 13), end_date: at(26, 17),
      })], 'unit-test');
      const sawMismatch = [];
      const stop = Store.subscribe(evt => { if (String(evt.source) === REC_SOURCE) sawMismatch.push(Store.tasks.st.runtime_schedule_mismatch); }, 'rec-flag');
      Engine.reconcileRuntimeSchedules(fx.plant);
      stop();
      const t = Store.tasks.st;
      assert.equal(t.end_date.getTime(), at(26, 17).getTime(), 'the finish is held');
      assert.equal(t.start_date.getTime(), at(26, 11).getTime());
      assert.deepEqual(t.scheduleSegments ?? [], []);
      assert.equal(t.runtime_schedule_mismatch, false, 'display state until the server clears it on Save');
      assert.deepEqual(sawMismatch, [false]);
      assert.deepEqual(fx.writes, [{ source: REC_SOURCE, ids: ['st'] }]);
      assert.equal(t.user_scheduled, true);
      assert.deepEqual([t.systemMove.from.getTime(), t.systemMove.to.getTime()], [at(26, 13).getTime(), at(26, 11).getTime()]);
      assert.equal(t.systemMove.reason, 'run_time_changed');
      assert.equal(fx.toasts.length, 1, 'one batch toast');
    } finally { fx.restore(); }
  });

  test('a dirty stale row (unsaved local edits) is left untouched; once saved the same row is re-derived', () => {
    const fx = recFixture();
    try {
      // Identical to the stale-row case above, which IS re-derived: only the dirty mark differs.
      Store.setTasks([fx.task('dt', {
        RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true,
        start_date: at(26, 13), end_date: at(26, 17),
      })], 'unit-test');
      Persistence._dirtyIds.add('dt');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.dt;
      assert.equal(t.start_date.getTime(), at(26, 13).getTime(), 'a dirty row keeps the planner\'s unsaved start');
      assert.equal(t.end_date.getTime(), at(26, 17).getTime());
      assert.equal(t.runtime_schedule_mismatch, true, 'the stale flag is not cleared');
      assert.equal(t.systemMove ?? null, null);
      assert.deepEqual(fx.writes, [], 'no display write for a dirty row');
      Persistence._dirtyIds.delete('dt');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.dt.start_date.getTime(), at(26, 11).getTime(), 'saved: re-derived from the held finish');
      assert.deepEqual(fx.writes, [{ source: REC_SOURCE, ids: ['dt'] }]);
    } finally { Persistence._dirtyIds.delete('dt'); fx.restore(); }
  });

  test('Review Focus 3: a running stale row keeps its start and moves its finish later', () => {
    const fx = recFixture();
    try {
      // Now is Thu 09:00: started 08:00, was due to end 12:00 (4 h); the run time grew to 6 h.
      Store.setTasks([fx.task('run', {
        RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true,
        start_date: at(20, 8), end_date: at(20, 12),
      })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.run;
      assert.equal(t.start_date.getTime(), at(20, 8).getTime(), 'a running order never loses its start');
      assert.equal(t.end_date.getTime(), at(20, 14).getTime(), 'the finish follows the new run time');
      assert.equal(t.runtime_schedule_mismatch, false);
      assert.deepEqual(fx.writes, [{ source: REC_SOURCE, ids: ['run'] }]);
      assert.equal(t.derivationIssue ?? null, null, 'no reversal, no overlap repair');
    } finally { fx.restore(); }
  });

  test('OQ4 / D19: a firmed row is re-derived like any other, stays firmed, and a start moving from outside to inside the frozen window is flagged', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('fm', {
        RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true,
        start_date: at(26, 13), end_date: at(26, 17),
      })], 'unit-test');
      Store.setFirmed(['fm'], true, 'unit-test');
      Store.setFrozenHorizonEnd(at(26, 12), 'unit-test');   // the old 13:00 start is outside; the derived 11:00 start is inside
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.fm;
      assert.equal(t.start_date.getTime(), at(26, 11).getTime());
      assert.equal(Store.isFirmed('fm'), true, 'nothing is un-firmed');
      assert.equal(t.firmed, true);
      assert.equal(t.derivationIssue.code, 'frozen_window_crossed');
      assert.equal(t.derivationIssue.from.getTime(), at(26, 13).getTime());
      assert.equal(t.derivationIssue.to.getTime(), at(26, 11).getTime());
    } finally { fx.restore(); }
  });

  test('D19: a firmed row already inside the frozen window gets no frozen_window_crossed note', () => {
    const fx = recFixture();
    try {
      Store.setTasks([
        fx.task('in', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 13), end_date: at(26, 17) }),
        fx.task('np', { RUN_TIME: '4', original_end_date: at(26, 17) }),   // never placed, due inside the window
      ], 'unit-test');
      Store.setFirmed(['in', 'np'], true, 'unit-test');
      Store.setFrozenHorizonEnd(at(27, 0), 'unit-test');   // both the held 13:00 and derived 11:00 starts are inside
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.in.derivationIssue ?? null, null);
      assert.notEqual(Store.tasks.np.derivationIssue?.code, 'frozen_window_crossed');
    } finally { fx.restore(); }
  });

  test('R26 (gate 14): an unfirmed PLACED row whose derived start flips into the frozen window records frozen_window_crossed; staying outside, or never placed, records nothing', () => {
    const fx = recFixture();
    try {
      Store.setFrozenHorizonEnd(at(27, 12), 'unit-test');
      // Run time grew 4 h -> 6 h with the 17:00 finish held: the start moves 13:00 -> 11:00, from outside the window (ends 12:00) to inside it.
      Store.setTasks([
        fx.task('flip', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(27, 13), end_date: at(27, 17) }),
        fx.task('stay', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(28, 13), end_date: at(28, 17) }),
        fx.task('never', { RUN_TIME: '6', original_end_date: at(26, 17), start_date: at(27, 13), end_date: at(27, 17) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.isFirmed('flip'), false);
      assert.equal(Store.tasks.flip.derivationIssue?.code, 'frozen_window_crossed');
      assert.equal(Store.tasks.flip.derivationIssue.from.getTime(), at(27, 13).getTime());
      assert.equal(Store.tasks.flip.derivationIssue.to.getTime(), at(27, 11).getTime());
      assert.equal(Store.tasks.stay.derivationIssue ?? null, null, 'start stays outside the window');
      assert.equal(Store.tasks.never.derivationIssue ?? null, null, 'never-placed rows are excluded');
      // End to end: the compute core (the worker's function) renders the recorded note as the alert.
      const { alerts } = globalThis.NimbusComputeCore.computeAlerts({
        tasks: Store.tasksArr, blocks: [], plantBlocks: [], calendars: Store.calendars, plants: Store.plants,
        lineSettings: Store.lineSettings, masterData: Store.masterData, dismissed: [], opts: {}, now: { [fx.plant]: Store.plantNow(fx.plant) },
      });
      assert.deepEqual(alerts.filter(a => a.type === 'frozen_window_crossed').map(a => a.id), ['derivation-flip-frozen_window_crossed']);
    } finally { fx.restore(); }
  });

  test('OQ53: three reversing orders on one line land X at now, Y after X, Z in the next window (finish order)', () => {
    const fx = recFixture();
    try {
      // Due dates all in the past (now is Thu 09:00), 4 h each on a 07:00-19:00 line with the never-split policy.
      Store.setTasks([
        fx.task('z', { original_end_date: at(20, 8) }),
        fx.task('x', { original_end_date: at(19, 17) }),
        fx.task('y', { original_end_date: at(19, 18) }),
      ].map(task => ({ ...task, start_date: at(10, 6), end_date: at(10, 10) })), 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const span = id => [Store.tasks[id].start_date.getTime(), Store.tasks[id].end_date.getTime()];
      assert.deepEqual(span('x'), [at(20, 9).getTime(), at(20, 13).getTime()], 'X starts at now');
      assert.deepEqual(span('y'), [at(20, 13).getTime(), at(20, 17).getTime()], 'Y follows X');
      assert.deepEqual(span('z'), [at(21, 7).getTime(), at(21, 11).getTime()], 'Z does not fit the rest of today and takes the next window');
      for (const id of ['x', 'y', 'z']) {
        assert.deepEqual(Store.tasks[id].derivationIssue, { code: 'reversal_forward', detail: 'due_date_past' }, id);
        assert.equal(Store.tasks[id].systemMove.reason, 'reversal_forward');
      }
      assert.deepEqual(fx.writes.map(w => w.source), [DISPLAY_SOURCE], 'never-placed reversals are display-only');
    } finally { fx.restore(); }
  });

  test('U16: the reconcile reversal queue hands the plant zone to placeForwardSequence, and the forward leg measures plant-zone elapsed time under never and partial policies', () => {
    const fx = recFixture();
    const original = Engine.placeForwardSequence;
    const seen = [];
    Engine.placeForwardSequence = function (...args) { seen.push(args[4]); return original.apply(this, args); };
    try {
      Store.setTasks([fx.task('u16', { original_end_date: at(19, 17) })].map(task => ({ ...task, start_date: at(10, 6), end_date: at(10, 10) })), 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(seen.length, 1, 'one reversal queue ran');
      assert.equal(seen[0]?.plantTz, LOCAL_TZ, 'the plant zone is passed on the reversal forward call');
    } finally { Engine.placeForwardSequence = original; fx.restore(); }
    // The leg itself: Chicago spring-forward, 24/7 line, 5 h from Sun 00:00 ends 06:00 wall (5 elapsed hours).
    const all = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
    Store.setCalendar('U16-247', all([0, 24]), 'unit-test');
    for (const policy of ['never', 'partial_allowed']) {
      const out = Engine.placeForwardSequence('U16-247', [{ task: { id: 't', RUN_TIME: '5', MACHINE: 'U16-247' } }],
        new Date(2026, 2, 8, 0, 0), policy, { plantTz: 'America/Chicago' });
      assert.equal(out.placed.length, 1, policy);
      assert.equal(out.placed[0].end.getHours(), 6, `${policy}: wall end 06:00 after the 02:00 jump`);
    }
  });

  test('U16 round 2: the never-policy reversal leg picks its slot in plant-zone instants on a Chicago DST night (22:00-06:00 line)', async () => {
    // A viewer outside the plant zone (UTC): wall-clock windows know nothing of the Chicago jump.
    const previousTz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
    const tz = 'America/Chicago';
    const night = () => ({ 0: [0, 6], 1: null, 2: null, 3: null, 4: null, 5: null, 6: [22, 24] });
    Store.setCalendar('U16-NIGHT', night(), 'unit-test');
    const seq = (hours, from) => Engine.placeForwardSequence('U16-NIGHT',
      [{ task: { id: 't', RUN_TIME: String(hours), MACHINE: 'U16-NIGHT' } }], from, 'never', { plantTz: tz });
    // Sat 7 Mar 22:00 -> Sun 8 Mar 06:00 is 7 elapsed hours (02:00 does not exist): a 7 h run fits and ends at the close...
    const fits = seq(7, new Date(2026, 2, 7, 21, 0));
    assert.equal(fits.placed.length, 1);
    assert.deepEqual([fits.placed[0].start.getDate(), fits.placed[0].start.getHours()], [7, 22]);
    assert.deepEqual([fits.placed[0].end.getDate(), fits.placed[0].end.getHours()], [8, 6], 'ends at the 06:00 close, not an hour past it');
    // ...an 8 h run does not fit the 7 h night (the wall clock reads 8 h): it must not be placed running into closed time.
    const over = seq(8, new Date(2026, 2, 7, 21, 0));
    assert.equal(over.placed.length, 1);
    assert.deepEqual([over.placed[0].start.getDate(), over.placed[0].start.getHours()], [14, 22], 'skips the short night, takes the next Saturday');
    assert.deepEqual([over.placed[0].end.getDate(), over.placed[0].end.getHours()], [15, 6]);
    // Fall-back night Sat 31 Oct -> Sun 1 Nov 2026 holds 9 elapsed hours in the same 22:00-06:00 window: a 9 h run fits.
    const back = seq(9, new Date(2026, 9, 31, 21, 0));
    assert.equal(back.placed.length, 1, 'the 9 elapsed-hour night holds a 9 h run');
    assert.deepEqual([back.placed[0].end.getDate(), back.placed[0].end.getHours()], [1, 6]);
    } finally { process.env.TZ = previousTz ?? LOCAL_TZ; }   // set explicitly: deleting TZ can leave the process on UTC
  });

  test('VI3: schedulePatchFor measures the run in the plant zone (8 h across the spring-forward gap ends 09:00 wall, not 08:00)', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'UTC';   // a viewer outside the plant zone: elapsed wall arithmetic knows nothing of the Chicago jump
    const fx = recFixture({ timezone: 'America/Chicago' });
    try {
      const all = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
      Store.setCalendar(fx.line, all([0, 24]), 'unit-test');
      for (let dow = 0; dow < 7; dow += 1) Store.setPlantWorkHours(fx.plant, dow, [0, 24], 'unit-test');
      const patch = Engine.schedulePatchFor({ id: 'vi3', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '8' }, fx.line, new Date(2026, 2, 8, 0, 0), 'never');
      assert.ok(patch, 'a patch is produced');
      assert.deepEqual([patch.start_date.getDate(), patch.start_date.getHours()], [8, 0]);
      assert.deepEqual([patch.end_date.getDate(), patch.end_date.getHours(), patch.end_date.getMinutes()], [8, 9, 0], 'the walk ran on instants: 09:00 wall');
    } finally { fx.restore(); process.env.TZ = previousTz ?? LOCAL_TZ; }
  });

  test('senior review M1: the never-branch reversal rounds the run time to whole minutes (no fractional-minute finish)', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('frac', { RUN_TIME: '2.33', original_end_date: at(19, 17), start_date: at(10, 6), end_date: at(10, 10) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.frac;
      assert.equal(t.start_date.getTime(), at(20, 9).getTime(), 'reversed from now');
      assert.equal(t.end_date.getTime() - t.start_date.getTime(), 140 * 60000, '2.33 h = 140 whole minutes, not 139.8');
    } finally { fx.restore(); }
  });

  test('gate 4a: the resulting running status of a reversed order is read on the plant clock (X runs from now, Y and Z are queued behind it)', () => {
    const fx = recFixture();
    try {
      Store.setTasks([
        fx.task('x', { original_end_date: at(19, 17) }),
        fx.task('y', { original_end_date: at(19, 18) }),
        fx.task('z', { original_end_date: at(20, 8) }),
      ].map(task => ({ ...task, start_date: at(10, 6), end_date: at(10, 10) })), 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      // Plant now is Thu 09:00: the first reversal starts exactly now, so it is running; the others start later.
      // Senior review I10: a never-placed (display-derived) reversal is NOT running even though its bar straddles now.
      assert.equal(Engine.isInProgress(Store.tasks.x), false, 'X is display-derived, never placed: not running');
      assert.equal(Engine.isInProgress({ ...Store.tasks.x, user_scheduled: true }), true, 'the same bar on a placed row is running');
      assert.deepEqual(Engine.firmingStatus(Store.tasks.x).reasons, []);
      assert.equal(Engine.isInProgress(Store.tasks.y), false, 'Y starts after X ends');
      assert.equal(Engine.isInProgress(Store.tasks.z), false, 'Z starts in the next window');
      assert.equal(Engine.firmingStatus(Store.tasks.z).firmed, false);
    } finally { fx.restore(); }
  });

  test('senior review I9: the reversal queue (placeForwardSequence, never) places a 24/7 30 h run as one bar and a night-shift 8 h run in its merged span', () => {
    const all = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
    Store.setCalendar('I9-247', all([0, 24]), 'unit-test');
    Store.setCalendar('I9-NIGHT', { 0: null, 1: [22, 24], 2: [0, 6], 3: null, 4: null, 5: null, 6: null }, 'unit-test');
    const mk = (line, hours) => [{ task: { id: 't', RUN_TIME: String(hours), MACHINE: line } }];
    const from = at(17, 8);   // a Monday
    const long = Engine.placeForwardSequence('I9-247', mk('I9-247', 30), from, 'never');
    assert.equal(long.overlong.length, 0);
    assert.equal(long.placed.length, 1);
    assert.equal(long.placed[0].end.getTime() - long.placed[0].start.getTime(), 30 * 3600000);
    const fits = Engine.placeForwardSequence('I9-NIGHT', mk('I9-NIGHT', 8), from, 'never');
    assert.equal(fits.overlong.length, 0);
    assert.equal(fits.placed.length, 1);
    const over = Engine.placeForwardSequence('I9-NIGHT', mk('I9-NIGHT', 8.5), from, 'never');
    assert.equal(over.overlong.length, 1);
  });

  test('senior review I10: running / frozen / the effective-firmed set apply only to rows with a persisted placement', () => {
    const fx = recFixture();
    try {
      const now = at(20, 15);
      const frozenEnd = at(23, 0);
      const derived = fx.task('np', { start_date: at(20, 14), end_date: at(20, 18), systemMove: { from: at(20, 14), to: at(20, 14), reason: 'due_date_derivation' } });
      const placed = fx.task('pl', { user_scheduled: true, start_date: at(20, 14), end_date: at(20, 18) });
      const stored = fx.task('st', { start_date: at(20, 14), end_date: at(20, 18) });   // a never-placed server row: basic_start_date as its start, user_scheduled false, no stamp
      const cleared = fx.task('cl', { start_date: at(20, 14), end_date: at(20, 18), systemMove: null });   // a refreshed row whose derivation stamp was cleared
      const derivedFuture = fx.task('nf', { start_date: at(21, 8), end_date: at(21, 12), systemMove: { from: at(21, 8), to: at(21, 8), reason: 'due_date_derivation' } });
      const placedFuture = fx.task('pf', { user_scheduled: true, start_date: at(21, 8), end_date: at(21, 12) });
      assert.equal(Engine.isInProgress(derived, now), false);
      assert.equal(Engine.isInProgress(placed, now), true);
      assert.equal(Engine.isInProgress(stored, now), false);
      assert.equal(Engine.isInProgress(cleared, now), false);
      assert.equal(Engine.isFrozenHorizon(derivedFuture, now, frozenEnd), false);
      assert.equal(Engine.isFrozenHorizon(placedFuture, now, frozenEnd), true);
      const ids = effectiveFirmedIdSet([derived, placed, stored, cleared, derivedFuture, placedFuture], new Set(), now, false, frozenEnd);
      assert.deepEqual([...ids].sort(), ['pf', 'pl']);
    } finally { fx.restore(); }
  });

  test('a stale reversing row records run_time_grew and is dirty; reason cutover tags every reversal cutover', () => {
    const fx = recFixture();
    try {
      const stale = (id) => fx.task(id, {
        user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(19, 10), end_date: at(19, 14),
      });
      Store.setTasks([stale('g1')], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.deepEqual(Store.tasks.g1.derivationIssue, { code: 'reversal_forward', detail: 'run_time_grew' });
      assert.equal(Store.tasks.g1.start_date.getTime(), at(20, 9).getTime());
      assert.deepEqual(fx.writes, [{ source: REC_SOURCE, ids: ['g1'] }], 'a stale row is a dirty write');

      Store.setTasks([stale('g2')], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant, { reason: 'cutover' });
      assert.deepEqual(Store.tasks.g2.derivationIssue, { code: 'reversal_forward', detail: 'cutover' });
      assert.equal(Store.tasks.g2.systemMove.reason, 'cutover');
    } finally { fx.restore(); }
  });

  test('Review Focus 4: a failed or pending calendar derives nothing, moves nothing, and raises the paused banner', () => {
    const fx = recFixture({ state: 'failed' });
    const priorDocument = globalThis.document;
    const banner = { hidden: true, textContent: '' };
    globalThis.document = { getElementById: id => (id === 'derive-paused-banner' ? banner : null), body: { classList: { add() {}, remove() {}, toggle() {} } } };
    try {
      Store.setTasks([fx.task('f1', {
        original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10),
      }), fx.task('f2', {
        RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 13), end_date: at(26, 17),
      })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.f1.start_date.getTime(), at(18, 6).getTime(), 'nothing moved on the default hours');
      assert.equal(Store.tasks.f2.start_date.getTime(), at(26, 13).getTime());
      assert.equal(Store.tasks.f2.runtime_schedule_mismatch, true, 'the flag stays for the next hydrated pass');
      assert.deepEqual(fx.writes, []);
      assert.equal(fx.toasts.length, 0);
      assert.ok(Engine.derivePausedPlants.has(fx.plant));
      assert.equal(banner.hidden, false);
      assert.match(banner.textContent, /ui\.derive_paused/);

      CalendarSync._setHydration(fx.plant, 'pending');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.deepEqual(fx.writes, [], 'pending is not hydrated either');

      CalendarSync._setHydration(fx.plant, 'hydrated', fx.lines);
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.ok(fx.writes.length > 0, 'derivation resumes once the server calendar is in');
      assert.equal(Engine.derivePausedPlants.has(fx.plant), false);
      assert.equal(banner.hidden, true);
    } finally { globalThis.document = priorDocument; fx.restore(); }
  });

  test('D14: a line with no server calendar row derives on the default calendar instead of being blocked', () => {
    const fx = recFixture({ lineNames: ['A', 'B'], serverLineNames: ['A'] });
    try {
      const withRow = fx.task('ok', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) });
      const noRow = fx.task('nr', { MACHINE: fx.lines[1], original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) });
      Store.setTasks([withRow, noRow], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.ok.start_date.getTime(), at(26, 13).getTime());
      assert.equal(Store.tasks.nr.start_date.getTime(), at(26, 13).getTime(), 'derived on the default 07:00-19:00 hours');
      assert.equal(Store.tasks.nr.end_date.getTime(), at(26, 17).getTime());
      assert.equal(Store.tasks.nr.derivationIssue ?? null, null);
    } finally { fx.restore(); }
  });

  test('OQ52: a plant with no time zone is skipped whole, every row carries plant_no_timezone, nothing is toasted twice', () => {
    const fx = recFixture({ timezone: null });
    try {
      Store.setTasks([
        fx.task('n1', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        fx.task('n2', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 13), end_date: at(26, 17) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      Engine.reconcileRuntimeSchedules(fx.plant);
      for (const id of ['n1', 'n2']) assert.equal(Store.tasks[id].derivationIssue.code, 'plant_no_timezone', id);
      assert.equal(Store.tasks.n1.start_date.getTime(), at(18, 6).getTime());
      assert.equal(Store.tasks.n2.start_date.getTime(), at(26, 13).getTime());
      assert.equal(Store.tasks.n2.runtime_schedule_mismatch, true);
      assert.equal(fx.toasts.filter(t => /system_moved/.test(t.msg)).length, 0);
      assert.equal(fx.toasts.length, 1, 'only the one-time plant toast from Store.plantNow');
    } finally { fx.restore(); }
  });

  test('a row carrying placement_exception, and a queued row, are left alone', () => {
    const fx = recFixture();
    try {
      Store.setTasks([
        fx.task('pe', { RUN_TIME: '5', user_scheduled: true, runtime_schedule_mismatch: true, placement_exception: 'overlong',
          start_date: at(24, 8), end_date: at(28, 8) }),
        fx.task('qd', { planning_status: 'needs_planning', planning_reason: { code: 'planner_unscheduled', message: 'x' },
          start_date: null, end_date: null, original_end_date: at(26, 17) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.pe.start_date.getTime(), at(24, 8).getTime());
      assert.equal(Store.tasks.pe.end_date.getTime(), at(28, 8).getTime());
      assert.equal(Store.tasks.pe.runtime_schedule_mismatch, true);
      assert.equal(Store.tasks.qd.start_date, null);
      assert.deepEqual(fx.writes, []);
    } finally { fx.restore(); }
  });

  test('the batch toast counts dirty patches only (display-only rows are not counted)', () => {
    const fx = recFixture();
    const priorT = Util.t;
    Util.t = (key, vars) => key === 'toast.system_moved_n' ? `${key}:${vars.count}` : priorT.call(Util, key, vars);
    try {
      Store.setTasks([
        fx.task('d1', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 13), end_date: at(26, 17) }),
        fx.task('d2', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(27, 13), end_date: at(27, 17) }),
        fx.task('np', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const dirtyCount = fx.writes.filter(w => w.source === REC_SOURCE).reduce((n, w) => n + w.ids.length, 0);
      assert.equal(dirtyCount, 2);
      assert.deepEqual(fx.toasts.map(t => t.msg), ['toast.system_moved_n:2']);
    } finally { Util.t = priorT; fx.restore(); }
  });

  // Task 4.2 (OQ53): the first load after the cutover finds most of a plant stale; one summary Toast replaces the
  // per-row batch Toast. The threshold is "more than half of the plant's non-queued rows were stale".
  const cutoverToastStub = () => {
    const priorT = Util.t;
    Util.t = (key, vars) => key === 'toast.cutover_summary' ? `${key}:${vars.n},${vars.m},${vars.k},${vars.j}`
      : key === 'toast.system_moved_n' ? `${key}:${vars.count}` : priorT.call(Util, key, vars);
    return () => { Util.t = priorT; };
  };

  test('OQ53: when more than half of a plant is stale one cutover summary Toast carries the four counts and replaces the per-row Toast', () => {
    const fx = recFixture({ lineNames: ['A', 'B'], serverLineNames: ['A'] });
    const unstub = cutoverToastStub();
    try {
      const lineB = fx.lines[1];
      Store.setTasks([
        fx.task('a1', { original_end_date: at(26, 17), runtime_schedule_mismatch: true }),
        fx.task('a2', { original_end_date: at(27, 17), runtime_schedule_mismatch: true }),
        ...[28, 29, 30, 31].map(day => fx.task(`a${day}`, { original_end_date: at(day, 17), runtime_schedule_mismatch: true })),   // U24: the signature needs >= 10 non-queued rows
        fx.task('rv', { original_end_date: at(19, 14), runtime_schedule_mismatch: true }),               // due date already past: reversed from now
        fx.task('run', { user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(20, 7), end_date: at(20, 11) }),   // producing now: keeps its start
        fx.task('bl', { MACHINE: lineB, original_end_date: at(26, 17), runtime_schedule_mismatch: true }),   // D14: no server calendar row on the line, derives on the default hours
        fx.task('ok', { user_scheduled: true, runtime_schedule_mismatch: false, start_date: at(27, 7), end_date: at(27, 11) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);   // 9 of 10 non-queued rows were stale
      assert.deepEqual(fx.toasts.map(t => t.msg), ['toast.cutover_summary:7,1,1,0'], 're-anchored 7 (D14: the no-server-row line derives too), reversed 1, kept running start 1, blocked 0');
      assert.deepEqual(Store.tasks.rv.derivationIssue, { code: 'reversal_forward', detail: 'cutover' }, 'the first-load pass is tagged cutover');
      assert.equal(Store.tasks.bl.derivationIssue ?? null, null, 'D14: the no-server-row line is no longer blocked');
    } finally { unstub(); fx.restore(); }
  });

  test('OQ53: an ordinary re-upload (most of the plant stale but still PLACED) is not a cutover; per-row Toast and run_time_grew stand', () => {
    const fx = recFixture();
    const unstub = cutoverToastStub();
    try {
      // Three of four rows flagged stale after a re-upload, each still carrying its placement; two have a finish already past.
      const stale = (id, day, h) => fx.task(id, { user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(day, h), end_date: at(day, h + 4) });
      const current = id => fx.task(id, { user_scheduled: true, runtime_schedule_mismatch: false, start_date: at(31, 7), end_date: at(31, 11) });
      Store.setTasks([stale('r1', 19, 10), stale('r2', 18, 10), stale('r3', 26, 13), current('c1')], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.deepEqual(fx.toasts.map(x => x.msg), ['toast.system_moved_n:3']);
      assert.deepEqual(Store.tasks.r1.derivationIssue, { code: 'reversal_forward', detail: 'run_time_grew' });
      assert.equal(Store.tasks.r3.systemMove.reason, 'run_time_changed');
    } finally { unstub(); fx.restore(); }
  });

  test('OQ53: a one-order plant whose single row is stale and placed is not a cutover either', () => {
    const fx = recFixture();
    const unstub = cutoverToastStub();
    try {
      Store.setTasks([fx.task('only', { RUN_TIME: '6', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 13), end_date: at(26, 17) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.deepEqual(fx.toasts.map(x => x.msg), ['toast.system_moved_n:1']);
    } finally { unstub(); fx.restore(); }
  });

  test('OQ53: queued rows count in neither side of the threshold', () => {
    const fx = recFixture();
    const unstub = cutoverToastStub();
    try {
      const queued = id => fx.task(id, { planning_status: 'needs_planning', start_date: null, end_date: null, user_scheduled: false });
      const stale = id => fx.task(id, { original_end_date: at(26, 17), runtime_schedule_mismatch: true });
      const ten = Array.from({ length: 10 }, (_, i) => stale(`s${i}`));
      Store.setTasks([...ten, queued('q1'), queued('q2'), queued('q3'), queued('q4'), queued('q5'), queued('q6')], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);   // ten non-queued rows, all with the cutover signature
      assert.deepEqual(fx.toasts.map(t => t.msg), ['toast.cutover_summary:10,0,0,0']);
    } finally { unstub(); fx.restore(); }
  });

  test('U24: the cutover signature needs at least ten non-queued rows; nine stale rows keep the per-row toast', () => {
    const fx = recFixture();
    const unstub = cutoverToastStub();
    try {
      const stale = id => fx.task(id, { original_end_date: at(26, 17), runtime_schedule_mismatch: true });
      Store.setTasks(Array.from({ length: 9 }, (_, i) => stale(`n${i}`)), 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.deepEqual(fx.toasts.map(t => t.msg), ['toast.system_moved_n:9']);
      assert.notEqual(Store.tasks.n0.systemMove?.reason, 'cutover');
    } finally { unstub(); fx.restore(); }
  });

  // F10 (Phase 3 whole-branch ruling): undo of rows that were never placed server-side leaves them display-only.
  test('F10: undoing an Apply on never-placed rows leaves them neither dirty nor placed; a placed row\'s undo still is', () => {
    const fx = recFixture();
    const unsubscribe = Store.subscribe(evt => App._trackDirty(evt), 'f10-dirty');
    const priorDirty = new Set(Persistence._dirtyIds), priorForce = new Set(Persistence._forceIds);
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    try {
      Store.setTasks([
        fx.task('np1', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        fx.task('np2', { original_end_date: at(27, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        fx.task('pl', { user_scheduled: true, runtime_schedule_mismatch: false, start_date: at(26, 13), end_date: at(26, 17) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);   // the display derivation: never-placed rows get bars, stay unplaced
      assert.equal(Store.tasks.np1.user_scheduled, false);
      const ids = ['np1', 'np2', 'pl'];
      const snapshot = UndoStack.snapshotTasks(ids);
      // An Apply (optimizer / drop) writes new dates: each row becomes placed and dirty.
      Store.updateMany(ids.map(id => ({ id, changes: { start_date: at(21, 7), end_date: at(21, 11) } })), 'engine');
      assert.ok(ids.every(id => Store.tasks[id].user_scheduled && Persistence._dirtyIds.has(id)), 'precondition: the Apply placed and dirtied all three');
      UndoStack.restoreTasks(snapshot);
      for (const id of ['np1', 'np2']) {
        assert.equal(Store.tasks[id].user_scheduled, false, `${id} is not marked placed`);
        assert.equal(Persistence._dirtyIds.has(id), false, `${id} is not dirty, so Save cannot persist a placement it never had`);
        assert.equal(Persistence._forceIds.has(id), false);
        assert.equal(Store.tasks[id].end_date.getTime(), id === 'np1' ? at(26, 17).getTime() : at(27, 17).getTime(), 'still displayed from its due date');
      }
      assert.equal(Store.tasks.pl.user_scheduled, true);
      assert.equal(Persistence._dirtyIds.has('pl'), true, 'a placed row\'s undo is still a saveable edit');
    } finally {
      unsubscribe();
      Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
      priorDirty.forEach(id => Persistence._dirtyIds.add(id)); priorForce.forEach(id => Persistence._forceIds.add(id));
      fx.restore();
    }
  });

  test('F10 (I2): undo of an Apply on a never-placed row keeps its earlier unsaved attribute edit dirty and sends no dates', () => {
    const fx = recFixture();
    const unsubscribe = Store.subscribe(evt => App._trackDirty(evt), 'f10-dirty2');
    const priorDirty = new Set(Persistence._dirtyIds), priorForce = new Set(Persistence._forceIds);
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    try {
      Store.setTasks([
        fx.task('ed', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        fx.task('cl', { original_end_date: at(27, 17), start_date: at(18, 6), end_date: at(18, 10) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      // The planner edits the run time of 'ed' (unsaved, no dates written), then an Apply touches both rows.
      Store.updateMany([{ id: 'ed', changes: { RUN_TIME: '3' } }], 'engine');
      assert.ok(Persistence._dirtyIds.has('ed') && !Persistence._dirtyIds.has('cl'), 'precondition');
      const snapshot = UndoStack.snapshotTasks(['ed', 'cl']);
      Store.updateMany(['ed', 'cl'].map(id => ({ id, changes: { start_date: at(21, 7), end_date: at(21, 10) } })), 'engine');
      UndoStack.restoreTasks(snapshot);
      assert.equal(Persistence._dirtyIds.has('ed'), true, 'the earlier unsaved RUN_TIME edit stays saveable');
      assert.equal(Persistence._dirtyIds.has('cl'), false, 'a row with no earlier edit is not dirty');
      assert.equal(Store.tasks.ed.user_scheduled, false);
      assert.equal(Store.tasks.ed.RUN_TIME, '3');
      const sent = Persistence._taskEditSnapshot(Store.tasks.ed);
      assert.equal(sent.RUN_TIME, '3');
      for (const key of ['start_date', 'end_date', 'schedule_segments']) assert.equal(key in sent, false, `Save sends no ${key}`);
    } finally {
      unsubscribe();
      Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
      priorDirty.forEach(id => Persistence._dirtyIds.add(id)); priorForce.forEach(id => Persistence._forceIds.add(id));
      fx.restore();
    }
  });

  test('overlong under a never-split plant queues the row (overlong_never); run time zero places nothing and says so', () => {
    const fx = recFixture();
    try {
      Store.setTasks([
        fx.task('ol', { RUN_TIME: '20', original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        fx.task('rz', { RUN_TIME: '0', original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
      ], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const ol = Store.tasks.ol;
      assert.equal(ol.planning_status, 'needs_planning');
      assert.equal(ol.planning_reason.code, 'overlong_never');
      assert.equal(ol.start_date, null);
      assert.deepEqual(ol.scheduleSegments, []);
      assert.equal(Store.tasks.rz.start_date.getTime(), at(18, 6).getTime(), 'no bar is derived');
      assert.equal(Store.tasks.rz.derivationIssue.code, 'run_time_zero');
    } finally { fx.restore(); }
  });

  test('D9c: a never-placed order with a date-only due on a full-day blackout resolves silently to the previous working close', () => {
    const fx = recFixture();
    // The due-instant seam needs the line's 07:00-19:00 hours so a date-only due reads as that day's 19:00 close.
    Util.setDueCalendarResolver(() => ({ lineHours: { 0: [7, 19], 1: [7, 19], 2: [7, 19], 3: [7, 19], 4: [7, 19], 5: [7, 19], 6: [7, 19] },
      plantHours: null, plant: fx.plant, rev: 0 }));
    try {
      Store.addBlock({ id: 'd9c-blackout', plant: fx.plant, line: fx.line, start: at(26, 0), end: at(27, 0) }, 'unit-test');
      Store.setTasks([fx.task('hol', { RUN_TIME: '4', original_end_date: at(26, 0), start_date: at(18, 6), end_date: at(18, 10) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.hol;
      assert.equal(t.end_date.getTime(), at(25, 19).getTime(), 'finish is the previous working close, before the blackout');
      assert.equal(t.derivationIssue ?? null, null, 'no finish_moved_earlier for a date-only due resolving');
    } finally { Util.setDueCalendarResolver(null); Store.removeBlock('d9c-blackout', 'unit-test'); fx.restore(); }
  });

  test('finish_moved_earlier is recorded with the held and the derived finish when the walk cannot hold it', () => {
    const fx = recFixture();
    try {
      // 20:00 is after the 19:00 close: the walk lands on the latest operating instant before it.
      Store.setTasks([fx.task('fe', { RUN_TIME: '4', user_scheduled: true, runtime_schedule_mismatch: true,
        start_date: at(26, 16), end_date: at(26, 20) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const t = Store.tasks.fe;
      assert.equal(t.end_date.getTime(), at(26, 19).getTime());
      assert.equal(t.derivationIssue.code, 'finish_moved_earlier');
      assert.equal(t.derivationIssue.from.getTime(), at(26, 20).getTime());
      assert.equal(t.derivationIssue.to.getTime(), at(26, 19).getTime());
    } finally { fx.restore(); }
  });

  test('a planner-placed never-placed row is marked scheduled, survives a second reconcile untouched (dirty), and keeps its placement once saved', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('dr', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) })], 'unit-test');
      // The planner drops it on Fri 21 Aug 15:00-19:00 (any non-display client write is a placement).
      Store.updateMany([{ id: 'dr', changes: { start_date: at(21, 15), end_date: at(21, 19) } }], 'engine');
      Persistence._dirtyIds.add('dr');
      assert.equal(Store.tasks.dr.user_scheduled, true, 'the client marks a placed row as scheduled');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.dr.start_date.getTime(), at(21, 15).getTime(), 'a dirty placement is never re-derived');
      assert.equal(Store.tasks.dr.end_date.getTime(), at(21, 19).getTime());
      assert.deepEqual(fx.writes, [], 'and is absent from the display writes');
      // Saved: no longer dirty. A hydration event must still leave it where the planner put it.
      Persistence._dirtyIds.delete('dr');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.dr.start_date.getTime(), at(21, 15).getTime());
      assert.deepEqual(fx.writes, []);
      // A display derivation never claims placement.
      Store.setTasks([fx.task('dp', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.notEqual(Store.tasks.dp.user_scheduled, true);
    } finally { Persistence._dirtyIds.delete('dr'); fx.restore(); }
  });

  test('a candidate with no finish to hold carries no_anchor and is left as it is', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('na', { start_date: at(18, 6), end_date: at(18, 10) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.na.start_date.getTime(), at(18, 6).getTime());
      assert.equal(Store.tasks.na.derivationIssue.code, 'no_anchor');
    } finally { fx.restore(); }
  });

  test('the next edit of a task clears its session-only derivation notes', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('cl', { original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10), RUN_TIME: '0' })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.cl.derivationIssue.code, 'run_time_zero');
      Store.updateMany([{ id: 'cl', changes: { start_date: at(26, 9), end_date: at(26, 13) } }], 'unit-test');
      assert.equal(Store.tasks.cl.derivationIssue ?? null, null);
      assert.equal(Store.tasks.cl.systemMove ?? null, null);
    } finally { fx.restore(); }
  });

  // -------------------------------------------------------------------------
  // Task 3.1 (OQ21, OQ20, G-0.25, OQ50 c, OQ56 a, group 21)
  // -------------------------------------------------------------------------
  test('OQ21: an undo restores the finish and re-derives the start from the current run time, quietly, even for a dirty row', () => {
    const fx = recFixture();
    try {
      // The recorded start (10:00) does not belong to the 4 h run time; the finish (17:00) does.
      Store.setTasks([fx.task('u', { user_scheduled: true, start_date: at(26, 13), end_date: at(26, 17), runtime_schedule_mismatch: false })], 'unit-test');
      const snap = UndoStack.snapshotTasks(['u']);
      snap[0].start_date = at(26, 10);
      Persistence._dirtyIds.add('u');   // restored rows are dirty by construction; the reconcile must not skip them
      UndoStack.restoreTasks(snap);
      const t = Store.tasks.u;
      assert.equal(t.end_date.getTime(), at(26, 17).getTime(), 'the restored finish holds');
      assert.equal(t.start_date.getTime(), at(26, 13).getTime(), 'the start follows the current run time (17:00 minus 4 h)');
      assert.equal(t.runtime_schedule_mismatch, false, 'derived, so the stale flag is cleared');
      assert.equal(fx.toasts.length, 0, 'an undo announces itself; the re-derivation adds no "N moved" toast');
      assert.ok(fx.writes.some(w => w.source === REC_SOURCE && w.ids.includes('u')));
    } finally { Persistence._dirtyIds.delete('u'); fx.restore(); }
  });

  test('group 15: Ctrl+Z of a task edit after a calendar edit re-derives against the CURRENT calendar and leaves the calendar edit alone', () => {
    const fx = recFixture({ policy: 'never' });
    try {
      Store.setTasks([fx.task('cz', { RUN_TIME: '4', user_scheduled: true, runtime_schedule_mismatch: false, start_date: at(26, 13), end_date: at(26, 17) })], 'unit-test');
      const snap = UndoStack.snapshotTasks(['cz']);           // the state before the task edit (finish Wed 17:00, plant window 07-19)
      Store.updateMany([{ id: 'cz', changes: { start_date: at(27, 9), end_date: at(27, 13) } }], 'unit-test');   // the task edit
      // Between the snapshot and the undo the planner shortens the line's day: it now closes at 16:00.
      const shortWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, d >= 1 && d <= 5 ? [7, 16] : null]));
      Store.setCalendar(fx.line, shortWeek, 'unit-test');
      UndoStack.restoreTasks(snap);
      const t = Store.tasks.cz;
      assert.equal(fmtLocal(t.end_date), '8/26 16:00', 'the restored 17:00 finish cannot be held on the shortened day: the end lands on the new close');
      assert.equal(fmtLocal(t.start_date), '8/26 12:00', 'and the 4 h start follows from it, not from the stale 13:00');
      assert.equal(t.derivationIssue?.code, 'finish_moved_earlier', 'the move is recorded, not silent');
      assert.deepEqual(Store.calendars[fx.line].workHours[3], [7, 16], 'the undo restored the task only; the calendar edit stands');
    } finally { fx.restore(); }
  });

  test('OQ21: restoreTasks flags every restored row stale before the engine derives', () => {
    const fx = recFixture({ state: 'pending' });   // nothing is derived, so the flag is still visible
    try {
      Store.setTasks([fx.task('u2', { user_scheduled: true, start_date: at(26, 13), end_date: at(26, 17), runtime_schedule_mismatch: false })], 'unit-test');
      UndoStack.restoreTasks(UndoStack.snapshotTasks(['u2']));
      assert.equal(Store.tasks.u2.runtime_schedule_mismatch, true);
    } finally { fx.restore(); }
  });

  test('U23: restoreTasks flags only the rows the reconcile will process (overtime marker and a calendar-less line keep their flag)', () => {
    const fx = recFixture({ lineNames: ['A', 'B'], serverLineNames: ['A'] });
    try {
      const placed = { user_scheduled: true, start_date: at(26, 13), end_date: at(26, 17), runtime_schedule_mismatch: false };
      Store.setTasks([
        fx.task('plain', placed),
        fx.task('ot', { ...placed, placement_exception: 'overtime' }),
        fx.task('nocal', { ...placed, MACHINE: fx.lines[1] }),
      ], 'unit-test');
      UndoStack.restoreTasks(UndoStack.snapshotTasks(['plain', 'ot', 'nocal']));
      assert.equal(Store.tasks.ot.runtime_schedule_mismatch, false, 'an overtime-marked bar is never re-derived, so it is never flagged');
      assert.equal(Store.tasks.nocal.runtime_schedule_mismatch, false, 'a line with no server calendar row is never re-derived');
      assert.equal(Store.tasks.plain.runtime_schedule_mismatch, false, 'a processed row ends derived and clear');
      assert.equal(Store.tasks.plain.end_date.getTime(), at(26, 17).getTime());
    } finally { fx.restore(); }
  });

  test('gate 23 a / gate 16: restoring an Apply snapshot brings back the finish AND the run time of a row whose run time changed after the Apply', () => {
    const fx = recFixture();
    try {
      Store.setTasks([fx.task('ap', { user_scheduled: true, RUN_TIME: '4', start_date: at(26, 13), end_date: at(26, 17), runtime_schedule_mismatch: false })], 'unit-test');
      const snap = UndoStack.snapshotTasks(['ap']);              // what OptimizerPreview.apply / runAndApply push
      // After the Apply the planner (or a routing change) edits the run time and the finish moves with the new bar.
      Store.updateMany([{ id: 'ap', changes: { RUN_TIME: '6', start_date: at(26, 14), end_date: at(26, 20) } }], 'unit-test');
      assert.equal(String(Store.tasks.ap.RUN_TIME), '6', 'sanity: the edit landed');
      UndoStack.restoreTasks(snap);
      const t = Store.tasks.ap;
      assert.equal(String(t.RUN_TIME), '4', 'the run time is restored together with the finish');
      assert.equal(t.end_date.getTime(), at(26, 17).getTime(), 'the finish is restored');
      assert.equal(t.start_date.getTime(), at(26, 13).getTime(), 'and the start is re-derived from them (17:00 minus 4 h)');
    } finally { fx.restore(); }
  });

  test('OQ20 (verified): a derived start below the pull floor records pull_floor_crossed', () => {
    const fx = recFixture();
    try {
      Store.setMasterData({ plants: [{ plant: fx.plant, split_order_policy: 'never', timezone: LOCAL_TZ, max_pull_forward_days: 0 }],
        lines: [{ machine: fx.line, plant: fx.plant }] }, 'unit-test');
      // Due 26 Aug with a pull limit of 0 days: the floor is 26 Aug 00:00. A 4 h run held to an 11:00 finish on
      // the 25th starts at 07:00 on the 25th, below that floor.
      Store.setTasks([fx.task('pf', { RUN_TIME: '4', user_scheduled: true, runtime_schedule_mismatch: true,
        original_end_date: at(26, 17), start_date: at(25, 8), end_date: at(25, 11) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      assert.equal(Store.tasks.pf.derivationIssue?.code, 'pull_floor_crossed');
    } finally { fx.restore(); }
  });

  test('G-0.25: a marked, unfirmed row keeps its edges through runAndApply with respectFirmed off; Remove Backlog leaves it too', () => {
    const fx = recFixture();
    try {
      const marked = fx.task('mk', { RUN_TIME: '2', user_scheduled: true, placement_exception: 'overtime',
        start_date: at(20, 6), end_date: at(20, 8), original_end_date: at(20, 8) });
      const free = fx.task('fr', { RUN_TIME: '2', user_scheduled: true, start_date: at(20, 9), end_date: at(20, 11), original_end_date: at(21, 17) });
      Store.setTasks([marked, free], 'unit-test');
      const before = [Store.tasks.mk.start_date.getTime(), Store.tasks.mk.end_date.getTime()];
      Engine.runAndApply('changeover', { plant: fx.plant, respectFirmed: false, respectCalendar: true,
        planningStart: at(20, 0), runNow: at(20, 9), endDate: at(27, 0) });
      assert.deepEqual([Store.tasks.mk.start_date.getTime(), Store.tasks.mk.end_date.getTime()], before, 'the marked row is fixed whatever the toggle says');
      assert.equal(Store.tasks.mk.placement_exception, 'overtime');
      const backlog = Engine.removeBacklog({ plant: fx.plant, startDate: at(19, 0), endDate: at(27, 0), runAt: at(20, 9) });
      assert.equal(backlog.patches.some(p => p.id === 'mk'), false, 'Remove Backlog does not move a marked row');
      const detached = Engine.evaluateSchedule('changeover', { plant: fx.plant, respectFirmed: false, respectCalendar: true,
        planningStart: at(20, 0), runNow: at(20, 9), endDate: at(27, 0) });
      assert.equal(detached.patches.some(p => p.id === 'mk'), false, 'the detached candidate leaves it alone too');
    } finally { fx.restore(); }
  });

  test('G-0.25: autoReflow on a never-split plant leaves a marked peer where it is', () => {
    const fx = recFixture();
    try {
      Store.setTasks([
        fx.task('drag', { RUN_TIME: '3', user_scheduled: true, start_date: at(20, 9), end_date: at(20, 12) }),
        fx.task('mkp', { RUN_TIME: '14', user_scheduled: true, placement_exception: 'overlong', start_date: at(20, 10), end_date: at(21, 0) }),
      ], 'unit-test');
      const before = [Store.tasks.mkp.start_date.getTime(), Store.tasks.mkp.end_date.getTime()];
      Engine.autoReflow('drag');
      assert.deepEqual([Store.tasks.mkp.start_date.getTime(), Store.tasks.mkp.end_date.getTime()], before);
    } finally { fx.restore(); }
  });

  test('OQ50 c: Remove Backlog queues a never-policy overlong order as overlong_never; overlongIds still reports it; the cursor does not advance', () => {
    const fx = recFixture();
    try {
      // 07:00-19:00 line: a 14 h order cannot be one bar. It is backlog (started in the past).
      Store.setTasks([
        fx.task('ol', { RUN_TIME: '14', user_scheduled: true, start_date: at(19, 7), end_date: at(19, 21) }),
        fx.task('ok', { RUN_TIME: '2', user_scheduled: true, start_date: at(19, 22), end_date: at(20, 0) }),
      ], 'unit-test');
      const result = Engine.removeBacklog({ plant: fx.plant, startDate: at(19, 0), endDate: at(27, 0), runAt: at(20, 9) });
      assert.deepEqual(result.diagnostics.overlongIds, ['ol']);
      const queued = result.patches.find(p => p.id === 'ol').changes;
      assert.equal(queued.planning_status, 'needs_planning');
      assert.equal(queued.planning_reason.code, 'overlong_never');
      assert.equal(queued.start_date, null);
      assert.deepEqual(queued.scheduleSegments, []);
      const next = result.patches.find(p => p.id === 'ok').changes;
      assert.equal(next.start_date.getTime(), at(20, 9).getTime(), 'the refused order took no time from the compressing cursor');
    } finally { fx.restore(); }
  });

  test('OQ56 a: the Remove Backlog count is the rows tagged reversal_forward / run_time_grew', () => {
    const fx = recFixture();
    try {
      const stale = id => fx.task(id, { user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(19, 10), end_date: at(19, 14) });
      Store.setTasks([stale('g1'), stale('g2'), fx.task('d', { original_end_date: at(19, 17) })], 'unit-test');
      Engine.reconcileRuntimeSchedules(fx.plant);
      const grew = Store.tasksByPlant(fx.plant).filter(t => t.derivationIssue?.code === 'reversal_forward' && t.derivationIssue.detail === 'run_time_grew');
      assert.deepEqual(grew.map(t => t.id).sort(), ['g1', 'g2'], 'due_date_past reversals are not counted');
    } finally { fx.restore(); }
  });

  test('group 21: the optimizer, the reconcile and the manual path place a reversal at the same floored minute, never after now', () => {
    const fx = recFixture();
    try {
      // Plant now 09:00:30; every path floors it to 09:00 so the start is at or before now.
      const restore = pinPlantClock('2026-08-20T09:00:30');
      try {
        const now = Store.plantNow(fx.plant);
        assert.ok(now.getSeconds() === 30, 'the pinned clock carries seconds');
        const floored = Calendar._floorMinute(now).getTime();
        Store.setTasks([fx.task('rv', { RUN_TIME: '2', original_end_date: at(19, 12), start_date: at(10, 6), end_date: at(10, 8) })], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        const reconcileStart = Store.tasks.rv.start_date.getTime();
        Store.setTasks([fx.task('rv', { RUN_TIME: '2', original_end_date: at(19, 12) })], 'unit-test');
        const result = Engine.evaluateSchedule('duedate', { plant: fx.plant, respectFirmed: true, respectCalendar: true,
          planningStart: at(20, 0), endDate: at(27, 0) });
        const optimizerStart = result.patches.find(p => p.id === 'rv')?.changes.start_date?.getTime();
        // The manual path: a release whose finish is already past reverses forward from the same floored now.
        const queued = { id: 'rv-manual', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '2', start_date: null, end_date: null,
          scheduleSegments: [], planning_status: 'needs_planning', planning_reason: { code: 'run_time_over_cap', message: 'x' } };
        const manual = Engine.manualSchedulePatchFor(queued, fx.line, at(19, 12));
        assert.ok(manual, 'the manual release is not refused');
        assert.equal(manual.start_date.getTime(), floored, 'manual reversal starts at the floored minute (no 15-minute snap)');
        assert.equal(reconcileStart, floored, 'reconcile reversal starts at the floored minute');
        assert.equal(optimizerStart, floored, 'optimizer reversal starts at the same floored minute');
        assert.equal(optimizerStart, manual.start_date.getTime(), 'optimizer and manual snap agree to the minute');
        assert.ok(optimizerStart <= now.getTime(), 'the order is running the instant it is placed');
      } finally { restore(); }
    } finally { fx.restore(); }
  });

  // -------------------------------------------------------------------------
  // Task 3.2 (OQ2 V1, OQ40): the reconcile reserves the required changeover ahead of the productive start
  // -------------------------------------------------------------------------
  const colorState = value => [{ fieldKey: 'colorWheel', value }];
  function withSetup(fx, { overrides = [], minutes = 60 } = {}, fn) {
    const prior = Store.setupSnapshot;
    Store.replaceSetupSnapshot({
      plant: fx.plant,
      definition: { plant: fx.plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1, from_key: colorState('RED'), to_key: colorState('BLUE'), setup_min: minutes }],
      machine_rows: [], machine_states: [], overrides,
    }, 'unit-test');
    try { fn(); } finally { Store.replaceSetupSnapshot(prior, 'unit-test'); }
  }
  const fmtLocal = d => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  test('Task 3.2: the reconcile reserves the predecessor-pair changeover before the earliest piece (same window)', () => {
    const fx = recFixture({ policy: 'partial_allowed' });
    try {
      withSetup(fx, {}, () => {
        // Window 07-19. A (RED) ran Tue 25 07-09; B (BLUE, 4 h) is held to a Wed 26 11:00 finish. The 60-minute
        // changeover cannot sit before 07:00 on Wednesday. D6 (VM9): B fits that one window, so setup never splits
        // it: it stays one piece 07:00-11:00 and the unreserved changeover is left to the setup alert (repaired
        // from the earlier clip-and-split expectation).
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pb', { COLOR: 'BLUE', original_end_date: at(26, 11), start_date: at(18, 6), end_date: at(18, 10) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        const t = Store.tasks.pb;
        assert.equal(fmtLocal(t.start_date), '8/26 07:00');
        assert.equal(fmtLocal(t.end_date), '8/26 11:00', 'the finish is held');
        assert.deepEqual(t.scheduleSegments ?? [], [], 'D6: one piece, never split to make room for the changeover');
        assert.equal(t.derivationIssue ?? null, null);
      });
    } finally { fx.restore(); }
  });

  test('Task 3.2: no changeover is reserved when the predecessor is unplaced, the pair has no rule, or there is no setup snapshot', () => {
    const fx = recFixture({ policy: 'partial_allowed' });
    try {
      const run = extra => {
        let out;
        withSetup(fx, {}, () => {
          Store.setTasks([
            fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9), ...extra }),
            fx.task('pb', { COLOR: 'BLUE', original_end_date: at(26, 11), start_date: at(18, 6), end_date: at(18, 10) }),
          ], 'unit-test');
          Engine.reconcileRuntimeSchedules(fx.plant);
          out = fmtLocal(Store.tasks.pb.start_date);
        });
        return out;
      };
      assert.equal(run({ planning_status: 'needs_planning', start_date: null, end_date: null, user_scheduled: false }), '8/26 07:00', 'queued predecessor: unknown, 0');
      assert.equal(run({ COLOR: 'GREEN' }), '8/26 07:00', 'no rule for GREEN -> BLUE: 0, no invented default');
      const prior = Store.setupSnapshot;
      Store.replaceSetupSnapshot(null, 'unit-test');
      try {
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pb', { COLOR: 'BLUE', original_end_date: at(26, 11), start_date: at(18, 6), end_date: at(18, 10) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        assert.equal(fmtLocal(Store.tasks.pb.start_date), '8/26 07:00', 'no setup snapshot: 0');
      } finally { Store.replaceSetupSnapshot(prior, 'unit-test'); }
    } finally { fx.restore(); }
  });

  test('Task 3.2 fix round 1: a setup-aware walk that cannot place keeps the zero-setup held-finish placement (no reversal)', () => {
    const fx = recFixture({ policy: 'never' });
    try {
      withSetup(fx, { minutes: 30 }, () => {
        Store.setCalendar(fx.line, Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, d >= 1 && d <= 5 ? [7, 15] : null])), 'unit-test');
        // 07-15 window (inside the plant's 07-19), 8 h order held to Wed 26 15:00 after a RED -> BLUE 30-minute changeover. No window holds
        // 8 h + 30 min, so the setup-aware walk fails; the zero-setup bar (07:00-15:00) must stand.
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pb', { COLOR: 'BLUE', RUN_TIME: '8', original_end_date: at(26, 15), start_date: at(18, 6), end_date: at(18, 14) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        const t = Store.tasks.pb;
        assert.equal(fmtLocal(t.start_date), '8/26 07:00');
        assert.equal(fmtLocal(t.end_date), '8/26 15:00');
        assert.notEqual(t.derivationIssue?.code, 'reversal_forward');
        assert.equal(t.derivationIssue ?? null, null);
      });
    } finally { fx.restore(); }
  });

  test('senior review I8: a setup-aware walk that would MOVE the held finish is discarded; the zero-setup held-finish bar stands', () => {
    const fx = recFixture({ policy: 'never' });
    try {
      withSetup(fx, { minutes: 90 }, () => {
        // 07-19 window (12 h), 10 h order held to Wed 26 17:00, RED -> BLUE 90 min. 10 h + 90 min does not fit the 12 h window slack
        // at the finish, so the setup-aware walk would pick an earlier day (finishMoved). Setup is a preference: the finish holds.
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pb', { COLOR: 'BLUE', RUN_TIME: '10', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 7), end_date: at(26, 17) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        const t = Store.tasks.pb;
        assert.equal(fmtLocal(t.end_date), '8/26 17:00', 'the held finish never moves for a changeover');
        assert.equal(fmtLocal(t.start_date), '8/26 07:00');
        assert.notEqual(t.derivationIssue?.code, 'finish_moved_earlier');
      });
    } finally { fx.restore(); }
  });

  test('group 7 (pipeline): a reconcile that holds the finish leaves a shrunk changeover gap, and the alerts name it (setup-violated with the available minutes)', async () => {
    const { Alerts } = await import('../../../frontend/insights/services.mjs');
    const fx = recFixture({ policy: 'never' });
    const priorAlerts = Store.alerts;
    try {
      withSetup(fx, { minutes: 90 }, () => {
        // RED ends Tue 25 19:00 (window close). BLUE is 10 h held to Wed 26 17:00, so its zero-setup start is Wed 07:00.
        // The 90-minute RED -> BLUE changeover would need 05:30-07:00 (before the window opens), so the setup-aware walk is
        // discarded (I8) and the held bar stands with 0 working minutes of gap: the violation must be raised, not hidden.
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 17), end_date: at(25, 19) }),
          fx.task('pb', { COLOR: 'BLUE', RUN_TIME: '10', user_scheduled: true, runtime_schedule_mismatch: true, start_date: at(26, 7), end_date: at(26, 17) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        assert.equal(fmtLocal(Store.tasks.pb.start_date), '8/26 07:00');
        assert.equal(fmtLocal(Store.tasks.pb.end_date), '8/26 17:00', 'the finish is held');
        Alerts._recomputeSync();
        const violated = Store.alerts.filter(a => a.type === 'setup-violated' && a.taskId === 'pb');
        assert.equal(violated.length, 1, 'one setup-violated alert on the successor');
        assert.equal(violated[0].requiredMinutes, 90);
        assert.ok(violated[0].availableMinutes < 90, `the available gap (${violated[0].availableMinutes} min) is below the 90 required`);
        assert.equal(violated[0].shortMinutes, 90 - violated[0].availableMinutes);
      });
    } finally { Store.setAlerts(priorAlerts, 'unit-test'); fx.restore(); }
  });

  test('Task 3.2 (OQ40): a manual drop reserves no changeover; finishAnchoredPatchFor honours an explicit setupMinutes', () => {
    const fx = recFixture({ policy: 'partial_allowed' });
    try {
      withSetup(fx, {}, () => {
        Store.setTasks([fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) })], 'unit-test');
        const task = fx.task('pb', { COLOR: 'BLUE', user_scheduled: true, start_date: at(26, 7), end_date: at(26, 11) });
        const manual = Engine.manualSchedulePatchFor(task, fx.line, at(26, 11), 'partial_allowed');
        assert.equal(fmtLocal(manual.start_date), '8/26 07:00', 'alert-only: the manual placement is not clipped');
        const asked = Engine.finishAnchoredPatchFor(task, fx.line, at(26, 11), 'partial_allowed', { setupMinutes: 60 });
        assert.equal(asked.kind, 'placed');
        assert.equal(fmtLocal(asked.changes.start_date), '8/26 07:00', 'D6: the order fits one window, so the requested changeover does not split it');
      });
    } finally { fx.restore(); }
  });

  test('Task 3.2: an active override whose pair no longer sits adjacent after a re-derive is recorded on the successor', () => {
    const fx = recFixture({ policy: 'partial_allowed' });
    try {
      const override = { id: 'ov1', machine: fx.line, signature_version: 1, predecessor_order_id: 'pa', successor_order_id: 'pb',
        predecessor_state_key: colorState('RED'), successor_state_key: colorState('BLUE'), standard_min: 60, remaining_min: 20, status: 'active', reason: 'started' };
      withSetup(fx, { overrides: [override] }, () => {
        // pz (RED) now sits between pa and pb, so pa -> pb is no longer an adjacent pair.
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pz', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 10), end_date: at(25, 12) }),
          fx.task('pb', { COLOR: 'BLUE', original_end_date: at(26, 17), start_date: at(18, 6), end_date: at(18, 10) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        assert.equal(Store.tasks.pb.derivationIssue.code, 'setup_override_orphaned');
        assert.equal(Store.tasks.pa.derivationIssue ?? null, null, 'only the successor carries it');
      });
      withSetup(fx, { overrides: [override] }, () => {
        // Still adjacent: no note, and the override's remaining minutes (20) are what is reserved.
        Store.setTasks([
          fx.task('pa', { COLOR: 'RED', user_scheduled: true, start_date: at(25, 7), end_date: at(25, 9) }),
          fx.task('pb', { COLOR: 'BLUE', original_end_date: at(26, 11), start_date: at(18, 6), end_date: at(18, 10) }),
        ], 'unit-test');
        Engine.reconcileRuntimeSchedules(fx.plant);
        assert.equal(Store.tasks.pb.derivationIssue ?? null, null);
        assert.equal(fmtLocal(Store.tasks.pb.start_date), '8/26 07:00', 'D6: the order fits one window, so no clip for the 20 remaining setup minutes either');
      });
    } finally { fx.restore(); }
  });
});

test('F1: a planner placement whose backward start falls before now reverses forward from now (reversal_forward), for any queue code; only a finish that would move EARLIER is refused', () => {
  const fx = manualFixture();   // plant clock: Thu 2026-08-20 09:00
  try {
    const queued = { id: 'g-guard', PLANT: fx.plant, MACHINE: fx.line, RUN_TIME: '4',
      planning_status: 'needs_planning', planning_reason: { code: 'planner_unscheduled', message: 'x' },
      start_date: null, end_date: null, scheduleSegments: [] };
    // 10:00 finish, 4 h run: the backward start (06:00) is before now. Reversal: placed 09:00-13:00 from now, late.
    const patch = Engine.manualSchedulePatchFor(queued, fx.line, new Date('2026-08-20T10:00:00'), 'never');
    assert.ok(patch, 'not refused');
    assert.equal(patch.start_date.getTime(), new Date('2026-08-20T09:00:00').getTime());
    assert.equal(patch.end_date.getTime(), new Date('2026-08-20T13:00:00').getTime());
    assert.deepEqual(patch.derivationIssue, { code: 'reversal_forward', detail: 'run_time_grew' }, 'the finish is still ahead of now: the run time is what pushed the start back');
    assert.equal(patch.planning_status, undefined, 'a non-releasable queue code is not released by the engine');
    assert.equal(Engine.lastManualRefusal, null);
    assert.equal(fx.toasts.length, 0);
    // A due date already in the past: the due_date_past detail.
    const past = Engine.manualSchedulePatchFor(queued, fx.line, new Date('2026-08-18T17:00:00'), 'never');
    assert.deepEqual(past.derivationIssue, { code: 'reversal_forward', detail: 'due_date_past' });
    // The other side of the ruling: a future finish on a closed day that the walk would have to move earlier
    // is still refused and toasted.
    const closed = Engine.manualSchedulePatchFor({ ...queued, id: 'g-guard2' }, fx.line, new Date('2026-08-24T08:00:00'), 'never');
    assert.equal(closed, null);
    assert.equal(Engine.lastManualRefusal, 'finish_cannot_hold');
    assert.equal(fx.toasts.length, 1);
  } finally { fx.restore(); }
});

test('Task 3.2 (A.3 #9): setup availability counts across midnight on merged 24/7 intervals', () => {
  // The previous order ends 23:50 and the successor starts 00:10 the next day: 20 minutes are free before the
  // 30-minute changeover, not the 10 minutes since midnight.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const all = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const observation = deriveSetupObservation({
    plant: 'P-MID',
    definition: { plant: 'P-MID', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 30 }],
    machine_rows: [], machine_states: [], overrides: [],
  }, [
    { id: 'mid-a', PLANT: 'P-MID', MACHINE: 'L-MID', COLOR: 'RED', RUN_TIME: 1, start_date: new Date('2026-08-03T22:50:00'), end_date: new Date('2026-08-03T23:50:00') },
    { id: 'mid-b', PLANT: 'P-MID', MACHINE: 'L-MID', COLOR: 'BLUE', RUN_TIME: 1, start_date: new Date('2026-08-04T00:10:00'), end_date: new Date('2026-08-04T01:10:00') },
  ], undefined, {
    calendars: { 'L-MID': { workHours: all } }, plants: { 'P-MID': { workHours: all } },
    lineSettings: { 'L-MID': { plant: 'P-MID' } }, masterData: { lines: [{ machine: 'L-MID', plant: 'P-MID' }] },
    blocks: [], plantBlocks: [],
  });
  const interval = observation.intervals.find(entry => entry.successorOrderId === 'mid-b');
  assert.equal(interval.requiredMinutes, 30);
  assert.equal(interval.availableMinutes, 20);

});

// Snapshot-bound due-window floors (post-cutover Apply rejected): Friday is closed on the line in the captured
// snapshot but open in the live Store, so any read of the live Store moves the date-only due and the floor by a day.
function dueWindowFixture() {
  const open = [7, 19];
  const closedFriday = { 0: null, 1: open, 2: open, 3: open, 4: open, 5: null, 6: null };
  const openFriday = { ...closedFriday, 5: open };
  const plantHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const md = { plants: [{ plant: 'DW', timezone: zone, max_pull_forward_days: 1, max_push_forward_days: 1 }],
    lines: [{ plant: 'DW', machine: 'DW1' }] };
  const task = { id: 'dw-task', PLANT: 'DW', MACHINE: 'DW1', COLOR: 'GREEN', RUN_TIME: 2,
    original_end_date: new Date(2035, 7, 10, 0, 0, 0), start_date: new Date(2035, 7, 9, 7, 0, 0),
    end_date: new Date(2035, 7, 9, 9, 0, 0), planning_status: 'scheduled' };
  const view = { calendars: { DW1: { workHours: closedFriday } }, plants: { DW: { workHours: plantHours } },
    lineSettings: {}, masterData: md };
  return { closedFriday, openFriday, plantHours, md, task, view };
}

test('Engine.earliestAllowedStart/latestAllowedEnd read the explicit view, not the live Store', () => {
  const { openFriday, plantHours, md, task, view } = dueWindowFixture();
  const priorCal = Store.calendars.DW1;
  const priorPlant = Store.plants.DW;
  Store.calendars.DW1 = { workHours: openFriday };
  Store.plants.DW = { workHours: plantHours };
  try {
    const live = Engine.earliestAllowedStart(task, 'DW', null, md);
    const bound = Engine.earliestAllowedStart(task, 'DW', null, md, view);
    assert.deepEqual([live.getMonth(), live.getDate(), live.getHours()], [7, 9, 0],
      'live Store (Friday open): due day Friday, floor Thursday 00:00');
    assert.deepEqual([bound.getMonth(), bound.getDate(), bound.getHours()], [7, 8, 0],
      'view (Friday closed): due resolves to Thursday, floor Wednesday 00:00');
    const liveCeil = Engine.latestAllowedEnd(task, 'DW', md);
    const boundCeil = Engine.latestAllowedEnd(task, 'DW', md, view);
    assert.deepEqual([liveCeil.getDate(), boundCeil.getDate()], [12, 11], 'the ceiling follows the view too');
  } finally {
    if (priorCal === undefined) delete Store.calendars.DW1; else Store.calendars.DW1 = priorCal;
    if (priorPlant === undefined) delete Store.plants.DW; else Store.plants.DW = priorPlant;
  }
});

test('sync preview bounds stay snapshot-bound after the run: a later live-Store calendar edit does not move the floor', () => {
  const { openFriday, plantHours, md, task, view } = dueWindowFixture();
  const snap = {
    tasks: [task], firmedIds: [], alerts: [], selectedPlant: 'DW', blocks: [], plantBlocks: [],
    calendars: view.calendars, plants: view.plants, lineSettings: {}, masterData: md, priorityRankMaps: {},
    readModelVersion: '1', frozenHorizonEnd: null,
    setupSnapshot: {
      plant: 'DW', plant_active: true,
      definition: { plant: 'DW', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    },
  };
  const candidate = evaluateOptimizerWorkerRequest({
    runId: 'dw-sync', mode: 'duedate', snapshot: snap, deadlineDurationMs: 2000,
    request: { mode: 'duedate', plant: 'DW', respectFirmed: true, respectCalendar: true,
      planningStart: new Date(2035, 7, 6, 8, 0, 0), runNow: new Date(2035, 7, 6, 8, 0, 0),
      endDate: new Date(2035, 7, 14, 0, 0, 0) },
  }, () => 5000);
  const priorCal = Store.calendars.DW1;
  const priorPlant = Store.plants.DW;
  Store.calendars.DW1 = { workHours: openFriday };   // the live Store drifts after the preview ran
  Store.plants.DW = { workHours: plantHours };
  try {
    const floor = candidate.validationContext.bounds.notBefore(task);
    assert.deepEqual([floor.getMonth(), floor.getDate(), floor.getHours()], [7, 8, 0],
      'the closure must keep the captured snapshot floor (Wednesday), not move to Thursday with the live Store');
    const legal = { ...candidate, patches: [{ id: 'dw-task', changes: {
      start_date: new Date(2035, 7, 8, 7, 0, 0), end_date: new Date(2035, 7, 8, 9, 0, 0) } }] };
    const findings = validateCandidateForApply({ ...legal, validationContext: candidate.validationContext }, snap);
    assert.equal(findings.some(finding => finding.code === 'date_window'), false,
      `no date_window error for a Wednesday placement, got ${JSON.stringify(findings.map(f => f.code))}`);
  } finally {
    if (priorCal === undefined) delete Store.calendars.DW1; else Store.calendars.DW1 = priorCal;
    if (priorPlant === undefined) delete Store.plants.DW; else Store.plants.DW = priorPlant;
  }
});

test('search budget: opts.searchBudgetMs / exhaustive scale the bounds the engine builds', () => {
  const plant = 'ENGINE-BUDGET-A';
  const lines = ['ENGINE-BUDGET-A1', 'ENGINE-BUDGET-A2'];
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const original = Engine.evaluateSetupAware;
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setMasterData({ plants: [{ plant }], lines: lines.map(machine => ({ plant, machine })) }, 'unit-test');
    Store.replaceSetupSnapshot(null, 'unit-test');
    Store.setTasks(lines.map((line, i) => ({
      id: `engine-budget-${line}`, PLANT: plant, MACHINE: line, COLOR: 'GREEN', RUN_TIME: 2,
      original_end_date: new Date(`2035-08-0${i + 1}T18:00:00`), start_date: null, end_date: null,
    })), 'unit-test');
    const base = {
      plant, planningStart: new Date('2035-08-01T08:00:00'),
      runNow: new Date('2035-08-01T08:00:00'), endDate: new Date('2035-08-20T12:00:00'),
    };
    const capture = (extra) => {
      let seen = null;
      Engine.evaluateSetupAware = function (mode, bounds, snapshot, thresholds) {
        seen = bounds;
        return original.call(this, mode, { ...bounds, deadline: -1 }, snapshot, thresholds);
      };
      const before = performance.now();
      Engine.evaluateSchedule('changeover', { ...base, ...extra }, snapshotSchedule(plant));
      return { bounds: seen, before };
    };

    const normal = capture({ searchBudgetMs: 8000 });
    assert.equal(normal.bounds.iterationCap, 64000);
    assert.equal(normal.bounds.gapFillBudgetMs, 2000);
    assert.equal(normal.bounds.exactSearchThreshold, 8);
    assert.equal(normal.bounds.exactSearchLeafCap, undefined);
    assert.equal(normal.bounds.convergenceWindow, 2000);
    assert.equal(normal.bounds.exhaustive, false);
    {
      const window = normal.bounds.deadline - normal.before;   // `before` precedes the call, so the window is the budget plus scheduling delay: bounded below by the budget, loosely above
      assert.ok(window >= 8000 && window < 13000, `normal deadline window ${window}`);
    }

    const exhaustive = capture({ searchBudgetMs: 180000, exhaustive: true });
    assert.equal(exhaustive.bounds.iterationCap, 1440000);
    assert.equal(exhaustive.bounds.gapFillBudgetMs, 36000);
    assert.equal(exhaustive.bounds.exactSearchThreshold, 10);
    assert.equal(exhaustive.bounds.exactSearchLeafCap, 5000);
    assert.equal(exhaustive.bounds.convergenceWindow, 10000);
    assert.equal(exhaustive.bounds.exhaustive, true);
    {
      const window = exhaustive.bounds.deadline - exhaustive.before;
      assert.ok(window >= 180000 && window < 185000, `exhaustive deadline window ${window}`);
    }

    const dflt = capture({});
    assert.equal(dflt.bounds.iterationCap, 40000);
    assert.equal(dflt.bounds.gapFillBudgetMs, 1000);
    assert.equal(dflt.bounds.exactSearchThreshold, 8);
    assert.equal(dflt.bounds.exactSearchLeafCap, undefined);
    assert.equal(dflt.bounds.convergenceWindow, 2000);
    {
      const window = dflt.bounds.deadline - dflt.before;
      assert.ok(window >= 5000 && window < 10000, `default deadline window ${window}`);
    }
  } finally {
    Engine.evaluateSetupAware = original;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Dated plant calendar periods (W3): the engine's plant-hours readers resolve the pattern per date.
// ---------------------------------------------------------------------------
describe('calendar periods: engine plant-hours readers', () => {
  const weekdays = (open, close) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, d >= 1 && d <= 5 ? [open, close] : null]));
  const allDays = hours => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, hours]));
  const period = (id, validFrom, validTo, workHours) => ({ id, name: id, validFrom, validTo, workHours });
  const PERIODS = [period('p1', '2026-10-22', null, weekdays(8, 12))];

  test('sourcePlantWorkHours(plant, date) resolves the pattern per date on the live Store; no date returns the default', async () => {
    const { sourcePlantWorkHours, sourcePlantPeriods } = await import('../../../frontend/optimization/engine.mjs');
    Store.ensurePlant('SPW-LIVE');
    for (let d = 0; d < 7; d++) Store.setPlantWorkHours('SPW-LIVE', d, weekdays(6, 18)[d], 'unit-test');
    try {
      assert.deepEqual(sourcePlantPeriods('SPW-LIVE'), []);
      const noPeriods = sourcePlantWorkHours('SPW-LIVE', new Date('2026-10-22T12:00:00'));
      assert.equal(noPeriods, Store.plants['SPW-LIVE'].workHours, 'no periods: the default by reference');
      Store.setPlantPeriods('SPW-LIVE', PERIODS, 'unit-test');
      assert.deepEqual(sourcePlantPeriods('SPW-LIVE'), PERIODS);
      assert.deepEqual(sourcePlantWorkHours('SPW-LIVE', new Date('2026-10-21T12:00:00'))[3], [6, 18]);
      assert.deepEqual(sourcePlantWorkHours('SPW-LIVE', new Date('2026-10-22T12:00:00'))[4], [8, 12]);
      assert.equal(sourcePlantWorkHours('SPW-LIVE'), Store.plants['SPW-LIVE'].workHours, 'no date: the default pattern');
    } finally {
      Store.setPlantPeriods('SPW-LIVE', [], 'unit-test');
    }
  });

  test('sourcePlantWorkHours and sourcePlantPeriods read the detached candidate snapshot, not the live Store', async () => {
    const { sourcePlantWorkHours, sourcePlantPeriods } = await import('../../../frontend/optimization/engine.mjs');
    Store.ensurePlant('SPW-SNAP');
    Store.setPlantPeriods('SPW-SNAP', [period('live', '2026-10-01', null, allDays(null))], 'unit-test');
    const originalRun = Engine.runAndApply;
    try {
      const snapshot = {
        ...snapshotSchedule(),
        plants: { 'SPW-SNAP': { workHours: weekdays(6, 18), periods: PERIODS } },
      };
      let seen = null;
      // evaluateSchedule sets the detached candidate snapshot around runAndApply; read the accessors from inside it.
      Engine.runAndApply = () => {
        seen = {
          periods: sourcePlantPeriods('SPW-SNAP'),
          before: sourcePlantWorkHours('SPW-SNAP', new Date('2026-10-21T12:00:00'))[3],
          during: sourcePlantWorkHours('SPW-SNAP', new Date('2026-10-22T12:00:00'))[4],
          noDate: sourcePlantWorkHours('SPW-SNAP'),
          missing: sourcePlantPeriods('SPW-MISSING'),
        };
        return null;
      };
      Engine.evaluateSchedule('spt', {}, snapshot);
      assert.deepEqual(seen.periods, PERIODS, 'the snapshot periods, not the live all-closed period');
      assert.deepEqual(seen.before, [6, 18]);
      assert.deepEqual(seen.during, [8, 12]);
      assert.equal(seen.noDate, snapshot.plants['SPW-SNAP'].workHours);
      assert.deepEqual(seen.missing, []);
    } finally {
      Engine.runAndApply = originalRun;
      Store.setPlantPeriods('SPW-SNAP', [], 'unit-test');
    }
  });

  test('setupAvailabilityMinutes resolves the plant pattern per day (period opens later than the default)', () => {
    const state = value => [{ fieldKey: 'colorWheel', value }];
    const run = (periods) => {
      const plants = { 'P-AV': { workHours: weekdays(6, 18), ...(periods ? { periods } : {}) } };
      return deriveSetupObservation({
        plant: 'P-AV',
        definition: { plant: 'P-AV', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
        plant_rows: [{ machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 20 }],
        machine_rows: [], machine_states: [], overrides: [],
      }, [
        { id: 'red', PLANT: 'P-AV', MACHINE: 'L-AV', COLOR: 'RED', RUN_TIME: 1, start_date: new Date('2026-10-21T15:00:00'), end_date: new Date('2026-10-21T17:00:00') },
        { id: 'blue', PLANT: 'P-AV', MACHINE: 'L-AV', COLOR: 'BLUE', RUN_TIME: 1, start_date: new Date('2026-10-22T10:00:00'), end_date: new Date('2026-10-22T11:00:00') },
      ], new Set(['L-AV']), {
        calendars: { 'L-AV': { workHours: allDays([0, 24]) } }, plants, lineSettings: {}, masterData: null, blocks: [], plantBlocks: [],
      }).intervals.map(i => i.availableMinutes);
    };
    assert.deepEqual(run(null), [240], 'default pattern opens 06:00: four free hours before the 10:00 end');
    assert.deepEqual(run(PERIODS), [120], 'the period that covers Thursday opens 08:00: two free hours');
  });
});
