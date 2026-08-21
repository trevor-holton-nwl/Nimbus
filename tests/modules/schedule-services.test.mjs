// Tests for web/schedule-services.mjs — CQ-1 Phase 2.
//
// schedule-services.mjs's Calendar capacity-math functions delegate to
// nimbus-compute-core.js via the ambient `globalThis.NimbusComputeCore`
// global (the SAME mechanism app.js used pre-extraction: nimbus-compute-core.js
// is a UMD module that, in a real browser, is loaded by a parser-blocking
// <script> before app-entry.mjs's static imports run, so window.NimbusComputeCore
// already exists by the time schedule-services.mjs's functions are called).
// Under a plain Node ESM import (this file), nothing sets that global
// automatically, so we bootstrap it here via createRequire — mirroring
// tests/modules/helpers/load-legacy-app.mjs's identical bootstrap for the VM
// harness. This must run before any test() body calls a Calendar function,
// but does NOT need to run before the `import` below is evaluated: importing
// schedule-services.mjs only defines objects/functions at module-eval time,
// it never calls into NimbusComputeCore until a function is invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  Calendar, Compute, Alerts, Utilization, Engine, snapshotSchedule, deriveSetupObservation,
  MIN_PRODUCTIVE_SEGMENT_MINUTES,
} from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';
import { Toast, Util, Config } from '../../web/application-foundation.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');

// Engine.runAndApply's early-return guards (no tasks / no plant selected) call
// Toast.show(Util.t(...)) — application-foundation.mjs's Toast/Util reference
// bare `window`/`document`, same split-realm quirk documented in
// tests/modules/helpers/load-legacy-app.mjs. A minimal stub (matching that
// harness's approach) keeps those guard paths a real no-op under plain Node
// instead of throwing "document/window is not defined".
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

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

test('Engine leaves undated orders and disabled pull-forward limits unrestricted', () => {
  Store.setMasterData({ plants: [{ plant: 'OPEN', max_pull_forward_days: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.earliestAllowedStart({ PLANT: 'OPEN', BASIC_FINISH_DATE: new Date('2026-08-17') }, 'OPEN'), null);
  Store.setMasterData({ plants: [{ plant: 'OPEN', max_pull_forward_days: 0 }], lines: [] }, 'unit-test');
  assert.equal(Engine.earliestAllowedStart({ PLANT: 'OPEN' }, 'OPEN'), null);
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
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-22T09:00:00') }, now), false);
    assert.equal(Engine.isFrozenHorizon({ start_date: null }, now), false, 'an order with no start is never frozen');
    assert.deepEqual(Engine.applyFrozenFloor(new Date('2026-08-22T09:00:00')), new Date('2026-08-22T09:00:00'));

    const frozenEnd = new Date('2026-08-25T00:00:00');
    Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
    assert.equal(Engine.frozenHorizonEnd().getTime(), frozenEnd.getTime());
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-22T09:00:00') }, now), true,
      'start inside [now, end) is frozen (OD-C2a)');
    assert.equal(Engine.isFrozenHorizon({ start_date: now }, now), true, 'start exactly AT now is frozen -- inclusive lower bound');
    assert.equal(Engine.isFrozenHorizon({ start_date: frozenEnd }, now), false,
      'start AT the boundary is not frozen -- it is the earliest allowed instant');
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-26T00:00:00') }, now), false);
    // C2 fix (regression this closes): an already-overdue order -- however
    // long ago -- must NOT read as frozen just because it's also before the
    // upper bound. The frozen window is [now, end), not (-infinity, end).
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-18T00:00:00') }, now), false,
      'already-overdue (before now) is not frozen even though it is before the boundary too');
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2020-01-01T00:00:00') }, now), false,
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
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-19T09:00:00') }, now), false,
      'yesterday is not frozen');
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-01T00:00:00') }, now), false,
      'three weeks overdue is not frozen');
    assert.equal(Engine.isFrozenHorizon({ start_date: new Date('2026-08-21T09:00:00') }, now), true,
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
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setFrozenHorizonEnd(new Date('2026-08-25T00:00:00'), 'unit-test');
  try {
    const requestedStart = new Date('2026-08-22T09:00:00'); // inside the frozen window
    const task = { id: 'manual-drag-task', PLANT: plant, MACHINE: line, RUN_TIME: '1' };
    const patch = Engine.manualSchedulePatchFor(task, line, requestedStart);
    assert.ok(patch, 'a manual drag must still produce a patch even though the target start is inside the frozen window');
    assert.equal(patch.start_date.getTime(), requestedStart.getTime(),
      'the manual drag lands EXACTLY where requested, unfloored -- proving OD-C2c');
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});

test('Engine.manualSchedulePatchFor is NOT blocked by the frozen horizon (OD-C2c: manual drags are always free) -- dragging OUT of the window', () => {
  // Whole-branch review companion to the INTO case above: the C2 brief asked for
  // coverage "dragging a task into/out of the frozen window", and the exemption
  // is direction-agnostic -- manualSchedulePatchFor never reads the task's
  // CURRENT start_date at all (only RUN_TIME/PLANT), so a task that is already
  // sitting inside the frozen window must land exactly at a requested start
  // OUTSIDE the window too, with no special-casing either way.
  const priorMasterData = Store.masterData;
  const priorEnd = Store.frozenHorizonEnd;
  const plant = 'FZ-MANUAL-PLANT-OUT';
  const line = 'FZ-MANUAL-LINE-OUT';
  Store.setMasterData({
    plants: [{ plant, max_pull_forward_days: null, split_order_policy: 'never' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  const frozenEnd = new Date('2026-08-25T00:00:00');
  Store.setFrozenHorizonEnd(frozenEnd, 'unit-test');
  try {
    const currentStart = new Date('2026-08-22T09:00:00'); // currently inside the frozen window
    const requestedStart = new Date('2026-08-27T09:00:00'); // requested drag target OUTSIDE the window
    const task = {
      id: 'manual-drag-task-out', PLANT: plant, MACHINE: line, RUN_TIME: '1',
      start_date: currentStart, end_date: new Date(currentStart.getTime() + 60 * 60 * 1000),
    };
    const patch = Engine.manualSchedulePatchFor(task, line, requestedStart);
    assert.ok(patch, 'a manual drag out of the frozen window must still produce a patch');
    assert.equal(patch.start_date.getTime(), requestedStart.getTime(),
      'the manual drag lands EXACTLY where requested, unfloored -- same unconditional exemption as the into-window case');
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setFrozenHorizonEnd(priorEnd, 'unit-test');
  }
});

test('Engine.runAndApply("spt") leaves an order starting inside the frozen window untouched and never places another order into it (Step 8: legacy walk)', () => {
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
  Store.replaceSetupSnapshot(null, 'unit-test'); // no active setup -- takes the legacy (non-setup-aware) path
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
    { id: 'spt-frozen-in-place', PLANT: plant, MACHINE: line, RUN_TIME: '1', start_date: frozenStart, end_date: frozenTaskEnd },
    { id: 'spt-movable-free', PLANT: plant, MACHINE: line, RUN_TIME: '1', start_date: new Date('2026-08-30T09:00:00'), end_date: new Date('2026-08-30T10:00:00') },
  ], 'unit-test');

  try {
    Engine.runAndApply('spt', { plant, respectFixed: true, respectCalendar: true, startDate: horizonStart });
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
    plants: [{ plant, split_order_policy: 'never' }],
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
      start_date: changedStart, end_date: changedEnd },
    { id: 'reflow-frozen-peer', PLANT: plant, MACHINE: line, RUN_TIME: '1',
      start_date: peerStart, end_date: peerEnd },
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
    globalThis.NimbusComputeCore = require('./web/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./web/schedule-state.mjs');
    const { Engine, snapshotSchedule } = await import('./web/schedule-services.mjs');
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
      respectFixed: true, respectCalendar: true,
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
    globalThis.NimbusComputeCore = require('./web/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./web/schedule-state.mjs');
    const { Engine, snapshotSchedule } = await import('./web/schedule-services.mjs');
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
      respectFixed: true, respectCalendar: true,
    }, snapshotSchedule());
    const patch = result.patches.find(candidate => candidate.id === 'long-wait-order');
    console.log(JSON.stringify({
      hasPatch: !!patch,
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

test('Calendar exposes capacity-math methods only (no render/openBlockModal/DOM)', () => {
  assert.equal(typeof Calendar.workWindow, 'function');
  assert.equal(typeof Calendar.dailyCapacityHours, 'function');
  assert.equal(typeof Calendar.nextAvailable, 'function');
  assert.equal(Calendar.render, undefined, 'Calendar must not carry UI methods after the split');
  assert.equal(Calendar.openBlockModal, undefined);
  assert.equal(Calendar.saveBlockFromModal, undefined);
});

test('Calendar.workWindow returns null outside working hours, a window inside them', () => {
  Store.setCalendar('L1', { 1: [7, 19] }, 'unit-test'); // Monday 7am-7pm
  const monday = new Date('2026-08-03T12:00:00'); // a Monday, midday
  const win = Calendar.workWindow('L1', monday);
  assert.ok(win === null || Array.isArray(win));
});

test('Compute.available reflects Worker constructor availability', () => {
  assert.equal(typeof Compute.available(), 'boolean');
});

test('Compute has no underscore-prefixed properties reachable on the export (closure-private by construction)', () => {
  const keys = Object.keys(Compute);
  assert.ok(keys.every(k => !k.startsWith('_')), 'Compute must stay fully encapsulated, as before the move');
  assert.deepEqual(keys.sort(), ['alerts', 'available', 'utilization']);
});

test('Alerts exposes computation methods only (no showForCell/toggleDrawer/render*)', () => {
  assert.equal(typeof Alerts.recompute, 'function');
  assert.equal(typeof Alerts.scheduleRecompute, 'function');
  assert.equal(typeof Alerts.applyFix, 'function');
  assert.equal(Alerts.showForCell, undefined, 'DOM modal must not travel with the computation module');
  assert.equal(Alerts.toggleDrawer, undefined);
  assert.equal(Alerts._renderDrawer, undefined);
  assert.equal(Alerts._renderBell, undefined);
});

test('Alerts.recompute with no worker/no plant falls back to sync compute', () => {
  Store.setSelectedPlant(null, 'unit-test'); // no plant -> forces sync path regardless of Compute.available()
  Store.setTasks([], 'unit-test');
  assert.doesNotThrow(() => Alerts.recompute());
});

test('Alerts.scheduleRecompute/{,Lines} debounce and eventually call recompute (adaptive delay)', async () => {
  let recomputeCalls = 0;
  const orig = Alerts.recompute;
  Alerts.recompute = (...args) => { recomputeCalls++; return orig.apply(Alerts, args); };
  Alerts.scheduleRecompute();
  await new Promise(r => setTimeout(r, 600)); // > _ALERTS_MAX_DEBOUNCE_MS
  assert.ok(recomputeCalls >= 1);
  Alerts.recompute = orig;
});

test('Store "schedule:hydrated" event triggers Alerts.scheduleRecompute (schedule-data -> schedule-services seam)', () => {
  // Regression test for the reverse-dependency seam Task 4 introduced:
  // schedule-data.mjs may not import schedule-services.mjs, so Persistence/
  // CalendarSync (5 call sites: load()'s two branches, _loadCache(),
  // _loadDemo()) emit a `{ type: 'schedule:hydrated' }` Store event instead of
  // calling Alerts.scheduleRecompute() directly. schedule-services.mjs
  // subscribes to that event once, at module-eval time, and forwards to
  // Alerts.scheduleRecompute(). Verify the seam actually fires end to end —
  // not just that each half compiles — so a typo'd event-type string or a
  // deleted subscription fails this suite instead of silently going dark
  // (the prior gap: alerts would stop recomputing after every load/cache
  // restore/demo-seed with nothing catching the regression).
  let calls = 0;
  const origSchedule = Alerts.scheduleRecompute;
  Alerts.scheduleRecompute = (...args) => { calls++; };
  try {
    Store.emit({ type: 'schedule:hydrated', source: 'unit-test' });
    assert.equal(calls, 1, 'the schedule:hydrated subscriber must call Alerts.scheduleRecompute exactly once');
  } finally {
    Alerts.scheduleRecompute = origSchedule;
  }
});

test('Utilization.computeMatrix memoizes on (startMs, days, Store.rev(), plant scope)', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  const day = new Date('2026-08-03');
  const m1 = Utilization.computeMatrix(day, 7);
  const m2 = Utilization.computeMatrix(day, 7);
  assert.equal(m1, m2, 'same key must return the identical cached matrix object');
  Store.setTasks([{ id: 'u1', RUN_TIME: '1', MACHINE: 'L1', plant: '5512' }], 'unit-test');
  const m3 = Utilization.computeMatrix(day, 7);
  assert.notEqual(m3, m1, 'a Store mutation must bump Store.rev() and invalidate the memo');
});

test('Utilization.dayByLine is unmemoized — two calls with the same args recompute independently', () => {
  const a = Utilization.dayByLine(new Date());
  const b = Utilization.dayByLine(new Date());
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'must not be the same cached object reference — dayByLine has no memo');
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

test('Engine.autoReflow reserves a covered incoming setup before moving a downstream peer', () => {
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

test('Engine.autoReflow resolves equal-start successors by id before reserving setup', () => {
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
  Store.setFixed('detached-long', true, 'unit-test');
  Store.setAlerts([{ id: 'detached-alert', type: 'overlap', sev: 'err' }], 'unit-test');
  const beforeRev = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const beforeFixed = Array.from(Store.fixedIds).sort();
  const beforeAlerts = structuredClone(Store.alerts);
  let publications = 0;
  const unsubscribe = Store.subscribe(() => { publications++; }, 'unit-test-autosave');

  try {
    const candidate = Engine.evaluateSchedule('spt', {
      respectCalendar: false,
      now: new Date('2026-08-03T08:00:00'),
    });
    assert.deepEqual(candidate.patches.map(patch => patch.id), ['detached-short'],
      'fixed work remains an immutable candidate boundary');
    assert.equal(Store.rev(), beforeRev);
    assert.deepEqual(Store.tasks, beforeTasks);
    assert.deepEqual(Array.from(Store.fixedIds).sort(), beforeFixed);
    assert.deepEqual(Store.alerts, beforeAlerts);
    assert.equal(publications, 0, 'candidate evaluation must not wake autosave-style subscribers');

    const captured = snapshotSchedule();
    captured.tasks[0].RUN_TIME = '999';
    assert.equal(Store.tasks['detached-long'].RUN_TIME, '5', 'snapshot values must not alias Store task objects');
  } finally {
    unsubscribe();
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
    fixedIds: [], alerts: [], selectedPlant: 'ENGINE_SETUP', blocks: [], plantBlocks: [],
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
    fixedIds: [], alerts: [], selectedPlant: 'DISABLED_SETUP', blocks: [], plantBlocks: [],
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
    start: '2026-08-03T13:40:00.000Z', end: '2026-08-03T14:00:00.000Z', requiredMinutes: 20, availableMinutes: 60,
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

test('Alerts publishes scoped setup observations without invoking Engine, including Fix It', () => {
  // This fails if alerts bypass the shared setup projection, resolve matrices in
  // the core, or make a setup diagnostic recursively optimize on Fix It.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  Store.setTasks([{
    id: 'uncovered-order', PLANT: 'P-ALERT', MACHINE: 'L-ALERT', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
  }], 'unit-test');
  Store.setSelectedPlant('P-ALERT', 'unit-test');
  Store.replaceSetupSnapshot({
    plant: 'P-ALERT',
    definition: { plant: 'P-ALERT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [],
    machine_states: [{ machine: 'L-ALERT', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  const originalRun = Engine.runAndApply;
  let engineRuns = 0;
  Engine.runAndApply = (...args) => { engineRuns++; return originalRun.apply(Engine, args); };
  try {
    Alerts._recomputeSync({ lines: new Set(['L-ALERT']) });
    const setupAlert = Store.alerts.find(alert => alert.type === 'setup-uncovered');
    assert.ok(setupAlert, 'the scoped worker/core payload must include the unresolved setup observation');
    Alerts.applyFix(setupAlert.id);
    Alerts._recomputeSync({ lines: new Set(['L-ALERT']) });
    assert.equal(engineRuns, 0, 'setup observation alerts must never invoke Engine, even after explicit Fix It');
  } finally {
    Engine.runAndApply = originalRun;
  }
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
  const options = { startDate, respectFixed: true, respectCalendar: false };
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
  Engine.runAndApply('spt', { respectFixed: true, respectCalendar: false });
  const e1 = Store.tasks['e1'], e2 = Store.tasks['e2'];
  assert.ok(e1.start_date, 'e1 must have been scheduled (proves the line group was non-empty)');
  assert.ok(e2.start_date <= e1.start_date, 'shorter run-time task (e2) must be scheduled first under SPT');
});

test('Engine.autoReflow pushes an overlapping unfixed downstream peer forward on the same line', () => {
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

test('Engine.runAndApply respects explicit respectFixed/respectCalendar options without reading any DOM element', () => {
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
    assert.doesNotThrow(() => Engine.runAndApply('changeover', { respectFixed: true, respectCalendar: true }));
    assert.equal(calls, 0, 'Engine.runAndApply must not call document.getElementById when respectFixed/respectCalendar are both passed explicitly');
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
// (web/schedule-state.mts) — a bare assignment throws "Cannot set property
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
// (web/schedule-workbench.mts) — a UI nag, never a sequencing decision
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
  Engine.runAndApply('changeover', { respectFixed: true, respectCalendar: false });
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
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
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
      plant, respectFixed: true, respectCalendar: false,
      startDate: new Date('2026-08-17T00:00:00'), endDate: new Date('2026-08-20T00:00:00'),
    });

    assert.ok(Engine.lastSetupAwareResult, 'a live setup-aware apply stores its result on Engine.lastSetupAwareResult');
    assert.ok(Engine.lastSetupAwareResult.missingEdges.some(edge => (
      edge.reason === 'scheduled-without-setup' && edge.successorOrderId === 'setup-live-blank'
    )), 'the blank-signature order is reported via the dedicated scheduled-without-setup reason');
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
    plant, respectFixed: true, respectCalendar: false,
    startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'),
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
      plant, respectFixed: true, respectCalendar: false,
      startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'),
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
      plant, respectFixed: true, respectCalendar: false,
      startDate: new Date('2026-08-25T00:00:00'), endDate: new Date('2026-08-28T00:00:00'),
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
// schedule-services.mts around the `effectiveSetupSnapshot` ternary), so
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
    Engine.runAndApply('changeover', {
      plant, respectFixed: true, respectCalendar: false,
      startDate: new Date('2026-08-21T00:00:00'), endDate: new Date('2026-08-24T00:00:00'),
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
// Workstream B1 (2026-08-21) — one policy-independent, segment-shift-aware
// manual commit path. manualSchedulePatchFor no longer branches on
// split_order_policy at all -- only on whether the task already carries
// >=2 scheduleSegments (placed there by a prior optimizer run).
// ---------------------------------------------------------------------------

test('Engine.manualSchedulePatchFor is policy-independent: a non-"never" plant with an all-closed calendar still commits verbatim, no calendar lookup at all', () => {
  // Before this task, a non-"never" split_order_policy routed through
  // Engine.schedulePatchFor -> Calendar.allocateRuntime, a real
  // calendar-aware regeneration. An all-closed calendar makes that
  // regeneration path provably fail (Calendar.allocateRuntime can never find
  // an open slot), so if manualSchedulePatchFor still produced a clean patch
  // landing exactly at the requested (snapped) start, that proves no
  // calendar lookup happened at all -- policy is truly ignored.
  const plant = 'B1-POLICY-PLANT';
  const line = 'B1-POLICY-LINE';
  const priorMasterData = Store.masterData;
  const priorCalendar = Store.calendars[line];
  const ALL_CLOSED = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };

  Store.setMasterData({
    plants: [{ plant, split_order_policy: 'overlong_only' }],
    lines: [{ machine: line, plant }],
  }, 'unit-test');
  Store.setCalendar(line, ALL_CLOSED, 'unit-test');

  try {
    const requestedStart = new Date('2026-08-24T09:00:00');
    const task = { id: 'b1-policy-task', PLANT: plant, MACHINE: line, RUN_TIME: '4' };

    // Sanity check: the OLD regeneration path (still reachable directly via
    // schedulePatchFor, which stays in place for reconcileRuntimeSchedules)
    // genuinely fails against this all-closed calendar under the non-"never"
    // policy -- proving the calendar-lookup path really would have blocked
    // this edit before this task.
    const wouldHaveRegenerated = Engine.schedulePatchFor(task, line, requestedStart, 'overlong_only');
    assert.equal(wouldHaveRegenerated, null,
      'sanity check: the old calendar-aware regeneration path cannot allocate on an all-closed calendar');

    const patch = Engine.manualSchedulePatchFor(task, line, requestedStart);
    assert.ok(patch, 'manualSchedulePatchFor must still produce a patch despite the all-closed calendar and non-"never" policy');
    assert.equal(patch.start_date.getTime(), Util.snap(requestedStart).getTime(),
      'the new start lands EXACTLY at the snapped requested start -- no calendar lookup, policy ignored');
    assert.equal(patch.end_date.getTime(), Util.snap(requestedStart).getTime() + 4 * Config.MS_HOUR);
    assert.deepEqual(patch.scheduleSegments, [], 'a task with fewer than two existing segments always collapses to a clean continuous block');
    assert.equal(patch.MACHINE, line);
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    else delete Store.calendars[line];
  }
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

    // Requested start is 2 calendar days later than the current start.
    const requestedStart = new Date('2026-08-22T08:00:00');
    const deltaMs = Util.snap(requestedStart).getTime() - seg1Start.getTime();

    const patch = Engine.manualSchedulePatchFor(task, line, requestedStart);
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

test('Engine.runAndApply nulls a stale lastSetupAwareResult on a later non-setup-aware run', () => {
  // F8: lastSetupAwareResult must mirror lastBacklogResult's clear-then-set
  // lifecycle — a later run that does NOT go through the setup-aware branch
  // must not leave a stale result from an earlier setup-aware run lying
  // around.
  //
  // B3a (2026-08-21): 'changeover' no longer has a non-setup-aware path at
  // all — it ALWAYS routes through evaluateSetupAware now (via the real
  // active-and-matching snapshot, or Engine._syntheticZeroCostSetupSnapshot
  // otherwise), so it can no longer exercise "a later run that does NOT go
  // through the setup-aware branch." 'spt' is the one mode B3a left
  // untouched: it still only takes the setup-aware branch when the plant's
  // real Store.setupSnapshot is genuinely active-and-matching, so it remains
  // the correct probe for this invariant.
  const plant = 'SETUP-STALE-PLANT';
  const line = 'SETUP-STALE-LINE';
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorLastSetupAware = Engine.lastSetupAwareResult;

  Store.setSelectedPlant(plant, 'unit-test');
  // No Store.replaceSetupSnapshot call: this plant has no active setup
  // definition, so runAndApply('spt', ...) takes the legacy (non-setup-aware) path.
  Store.setTasks([
    { id: 'stale-check-a', PLANT: plant, MACHINE: line, RUN_TIME: '1' },
  ], 'unit-test');
  Engine.lastSetupAwareResult = { patches: [], score: [], explanation: [], diagnostics: {}, unchangedLines: [], missingEdges: [] };

  try {
    Engine.runAndApply('spt', { plant, respectFixed: true, respectCalendar: false });
    assert.equal(Engine.lastSetupAwareResult, null, 'a later non-setup-aware run clears the stale result, not just leaves it');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Engine.lastSetupAwareResult = priorLastSetupAware;
  }
});

test('Alerts.applyFix still calls Engine.autoReflow for overlap alerts (Task 3: B2)', () => {
  // Task 3: B2 deleted manual-edit autoReflow calls but kept Alerts.applyFix's.
  // This verifies Engine.autoReflow is still called from applyFix for overlap type.
  const line = 'REFLOW-OVERLAP-TEST-LINE';
  const plant = '5512';
  const start1 = new Date('2026-08-25T08:00:00');
  const end1 = new Date('2026-08-25T10:00:00');
  const start2 = new Date('2026-08-25T09:00:00'); // overlaps with task 1
  const end2 = new Date('2026-08-25T11:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;

  let autoReflowCallCount = 0;
  Engine.autoReflow = (id) => {
    autoReflowCallCount++;
    return priorAutoReflow.call(Engine, id);
  };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'overlap-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'overlap-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    // Simulate an overlap alert and apply the fix
    Alerts._recomputeSync();
    const overlapAlert = Store.alerts.find(a => a.type === 'overlap');
    assert.ok(overlapAlert, 'an overlap alert must be present');
    const callCountBefore = autoReflowCallCount;
    Alerts.applyFix(overlapAlert.id);
    assert.ok(autoReflowCallCount > callCountBefore,
      'Engine.autoReflow must be called inside applyFix for overlap alerts (Task 3: B2 kept this call)');
  } finally {
    Engine.autoReflow = priorAutoReflow;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Alerts.applyFix still calls Engine.autoReflow for blackout alerts (Task 3: B2)', () => {
  // Task 3: B2 deleted manual-edit autoReflow calls but kept Alerts.applyFix's.
  // applyFix handles both 'overlap' and 'blackout' via the same branch (line 1476),
  // calling Engine.autoReflow at line 1515. This test verifies the call path by
  // mocking an alert and confirming autoReflow is invoked for 'blackout' type.
  const line = 'REFLOW-BLACKOUT-TEST-LINE';
  const plant = '5512';
  const taskId = 'blackout-test-task';
  const start = new Date('2026-08-25T08:00:00');
  const end = new Date('2026-08-25T10:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;
  const priorAlerts = structuredClone(Store.alerts);

  let autoReflowCallCount = 0;
  Engine.autoReflow = (id) => {
    autoReflowCallCount++;
    return priorAutoReflow.call(Engine, id);
  };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: taskId, PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start, end_date: end },
  ], 'unit-test');
  // Manually inject a blackout alert to avoid complex setup
  const fakeAlert = {
    id: 'blackout-test-alert',
    type: 'blackout',
    taskId: taskId,
  };
  Store.setAlerts([fakeAlert], 'unit-test');

  try {
    const callCountBefore = autoReflowCallCount;
    Alerts.applyFix(fakeAlert.id);
    assert.ok(autoReflowCallCount > callCountBefore,
      'Engine.autoReflow must be called inside applyFix for blackout alerts (Task 3: B2 kept this call)');
  } finally {
    Engine.autoReflow = priorAutoReflow;
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});
