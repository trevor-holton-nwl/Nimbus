import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../frontend/calendar/calendar-engine.mjs';
import { Engine, snapshotSchedule } from '../../frontend/optimization/engine.mjs';
import { Store } from '../../frontend/platform/store.mjs';
import { allowedPlanningWindow, validateCandidateForApply } from '../../frontend/optimization/setup-scheduler.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const HOUR = 60 * 60 * 1000;
const plant = 'P-BACKLOG';
const line = 'L-BACKLOG';
const allDays = (start, end) => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [start, end]]));

function at(text) {
  return new Date(text);
}

function task(id, start, hours, extra = {}) {
  return {
    id,
    plant,
    PLANT: plant,
    MACHINE: line,
    RUN_TIME: String(hours),
    user_scheduled: true, start_date: at(start),
    end_date: new Date(+at(start) + hours * HOUR),
    BASIC_START_DATE: at('2000-01-01T00:00'),
    BASIC_FINISH_DATE: at('2000-01-01T01:00'),
    firmed: false,
    ...extra,
  };
}

function seed({ tasks = [], hours = allDays(8, 16), lineName = line, splitOrderPolicy = 'never' } = {}) {
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.replaceFirmedIds(new Set(), 'test');
  // C2 (2026-08-20): reset between tests, same as every other piece of Store
  // state seed() already resets, so a frozen-horizon test never bleeds into
  // one that doesn't expect it.
  Store.setFrozenHorizonEnd(null, 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: splitOrderPolicy }],
    lines: [{ machine: lineName, plant }],
  }, 'test');
  Store.setLineSetting(lineName, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(lineName, hours, 'test');
  for (const day of Object.keys(hours).map(Number)) Store.setPlantWorkHours(plant, day, hours[day], 'test');
  Store.setSelectedPlant(plant, 'test');
  Store.setTasks(tasks, 'test');
}

function opts(overrides = {}) {
  return {
    plant,
    lines: [line],
    startDate: at('2026-08-12T00:00'),
    endDate: at('2026-08-12T23:59'),
    runAt: at('2026-08-12T12:00:00Z'),
    ...overrides,
  };
}

function patch(result, id) {
  return result.patches.find((entry) => entry.id === id);
}

afterEach(() => seed());

test('Calendar moves a one-minute shift-close overrun to the next working day', () => {
  seed();
  const result = Calendar.findContiguousSlot(line, at('2026-08-12T08:01'), 8 * HOUR);
  assert.equal(result.kind, 'slot');
  assert.equal(+result.start, +at('2026-08-13T08:00'));
});

test('Calendar classifies an order longer than every nominal operating window as overlong', () => {
  seed();
  const result = Calendar.findContiguousSlot(line, at('2026-08-12T08:00'), 9 * HOUR);
  assert.equal(result.kind, 'overlong');
  assert.equal(+result.start, +at('2026-08-12T08:00'));
});

test('Calendar keeps the requested operating minute for an overlong exception', () => {
  seed();
  const result = Calendar.findContiguousSlot(line, at('2026-08-12T08:01'), 9 * HOUR);
  assert.equal(result.kind, 'overlong');
  assert.equal(+result.start, +at('2026-08-12T08:01'));
});

test('Engine compresses backlogged gaps and stops at a future gap', () => {
  seed({
    tasks: [
      task('past-a', '2026-08-12T06:00', 2),
      task('past-b', '2026-08-12T07:00', 2),
      task('future', '2026-08-12T15:00', 1),
    ],
  });
  const result = Engine.removeBacklog(opts());
  assert.equal(+patch(result, 'past-a').changes.start_date, +at('2026-08-12T08:00'));
  assert.equal(+patch(result, 'past-b').changes.start_date, +at('2026-08-12T10:00'));
  assert.equal(patch(result, 'future'), undefined);
});

test('Engine uses RUN_TIME and moves a firmed order without clearing its firmed state', () => {
  const firmed = task('fixed-past', '2026-08-12T06:00', 3, { firmed: true });
  seed({ tasks: [firmed] });
  const result = Engine.removeBacklog(opts());
  const change = patch(result, 'fixed-past').changes;
  assert.equal(+change.end_date - +change.start_date, 3 * HOUR);
  assert.ok(Store.firmedIds.has('fixed-past'));
  assert.equal(result.diagnostics.firmedMoved, 1);
});

test('Engine allocates backlog runtime as productive segments when the plant permits partial orders', () => {
  seed({
    tasks: [task('split-past', '2026-08-12T06:00', 14)],
    hours: allDays(8, 20),
    splitOrderPolicy: 'partial_allowed',
  });

  const result = Engine.removeBacklog(opts());
  const change = patch(result, 'split-past').changes;

  assert.deepEqual(change.scheduleSegments.map(segment => [
    segment.startDate.getHours(), segment.endDate.getHours(),
  ]), [
    [8, 20], [8, 10],
  ]);
  assert.equal(+change.end_date, +at('2026-08-13T10:00'));
});

test('Engine.removeBacklog sends a never-policy overlong order to Needs Planning instead of a continuous elapsed bar (OQ50 c)', () => {
  // The old compatibility exception stretched the bar through closed time. Under finish-anchored scheduling no
  // forward path may do that: the order is queued with reason overlong_never and still reported in overlongIds.
  seed({ tasks: [task('legacy-overlong', '2026-08-12T06:00', 9)] });

  const result = Engine.removeBacklog(opts());
  const change = patch(result, 'legacy-overlong').changes;

  assert.equal(change.planning_status, 'needs_planning');
  assert.equal(change.planning_reason.code, 'overlong_never');
  assert.equal(change.start_date, null);
  assert.equal(change.end_date, null);
  assert.deepEqual(change.scheduleSegments, []);
  assert.deepEqual(result.diagnostics.overlongIds, ['legacy-overlong']);
  assert.equal(result.diagnostics.moved, 0, 'a queued order is not counted as moved');
});

test('Engine leaves a protected task after To untouched and reports a boundary conflict', () => {
  seed({
    tasks: [
      task('past', '2026-08-12T06:00', 8),
      task('protected', '2026-08-12T15:00', 2),
    ],
  });
  const result = Engine.removeBacklog(opts({ endDate: at('2026-08-12T12:00') }));
  assert.equal(patch(result, 'protected'), undefined);
  assert.equal(result.diagnostics.boundaryConflicts.length, 1);
});

test('Engine skips invalid runtime without advancing the cursor and continues another line after capacity failure', () => {
  const otherLine = 'L-OPEN';
  seed({
    tasks: [
      task('invalid', '2026-08-12T06:00', 1, { RUN_TIME: '0' }),
      task('closed', '2026-08-12T07:00', 1),
      { ...task('other', '2026-08-12T06:00', 1), id: 'other', MACHINE: otherLine },
    ],
    hours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, null])),
  });
  Store.setCalendar(otherLine, allDays(8, 16), 'test');
  Store.setLineSetting(otherLine, { plant, excludeFromOpt: false }, 'test');
  for (const day of Object.keys(allDays(8, 16)).map(Number)) Store.setPlantWorkHours(plant, day, [8, 16], 'test');
  const result = Engine.removeBacklog(opts({ lines: [line, otherLine] }));
  assert.deepEqual(result.diagnostics.invalidRuntimeIds, ['invalid']);
  assert.ok(result.diagnostics.calendarSearchFailures.some((failure) => failure.line === line));
  assert.equal(+patch(result, 'other').changes.start_date, +at('2026-08-12T08:00'));
});

test('Engine leaves a scheduled row with a malformed interval immutable', () => {
  const malformed = task('malformed-end', '2026-08-12T06:00', 1, { end_date: new Date('not-a-date') });
  seed({ tasks: [malformed] });

  assert.doesNotThrow(() => Engine.removeBacklog(opts()));
  const result = Engine.removeBacklog(opts());
  assert.equal(patch(result, 'malformed-end'), undefined,
    'a malformed scheduled interval must be excluded before backlog repair');
});

// ---------------------------------------------------------------------------
// Workstream C2 (2026-08-20), carved out for 'backlog' mode on 2026-08-22.
//
// removeBacklog's own doc comment says it deliberately has no firmed-
// protection/day-integrity/frozen-horizon branches. The original C2 guard
// (obstacle-skip + placement floor) was removed for this mode by planner
// decision (SAP002 "Remove Backlog" parity): the overdue backlog compresses
// fully into now, including into the frozen window, and a frozen-window
// order is only ever shifted LATER when the compressing cursor reaches it
// (never pulled earlier -- the `cursor <= item.snapshotStart` break still
// guarantees that). Both cases are tracked via diagnostics.frozenMoved,
// mirroring the pre-existing diagnostics.firmedMoved treatment of a
// genuinely Store.isFirmed-pinned order (see 'Engine uses RUN_TIME and moves
// a firmed order...' above, unmodified).
// ---------------------------------------------------------------------------

// "now" (plant-local, America/New_York, per opts()' default runAt) is
// 2026-08-12T08:00 -- Engine.isFrozenHorizon's lower bound is evaluated
// against THIS instant (removeBacklog passes its own plant-wall-clock `now`
// through explicitly), not the real wall clock, so these fixtures stay
// deterministic regardless of when the suite actually runs.

test('Engine.removeBacklog shifts a frozen-window order later when the compressing cursor collides with it, and counts it in diagnostics.frozenMoved', () => {
  const frozenEnd = at('2026-08-15T00:00');
  seed({
    hours: allDays(0, 24),
    tasks: [
      // Overdue (before "now") with a 3h runtime -- placed at now (08:00) it
      // runs through 11:00, colliding with frozen-inside-window's original
      // 09:00 start.
      task('trigger-overdue', '2026-08-12T06:00', 3),
      // Starts AFTER "now" but still genuinely inside [now, frozenEnd) --
      // this is the one under test. The compressing cursor reaches it (its
      // own start, 09:00, is before the overdue order's new end, 11:00), so
      // it is shifted later rather than left in place or skipped.
      task('frozen-inside-window', '2026-08-12T09:00', 1),
    ],
  });
  Store.setFrozenHorizonEnd(frozenEnd, 'test');
  const result = Engine.removeBacklog(opts());

  const overdue = patch(result, 'trigger-overdue');
  assert.ok(overdue, 'the overdue order is repaired');
  assert.equal(+overdue.changes.start_date, +at('2026-08-12T08:00'));
  assert.equal(+overdue.changes.end_date, +at('2026-08-12T11:00'));

  const frozen = patch(result, 'frozen-inside-window');
  assert.ok(frozen, 'the frozen-window order the cursor collides with IS patched -- shifted later, not skipped');
  assert.equal(+frozen.changes.start_date, +at('2026-08-12T11:00'),
    'sequence is preserved: it starts right after the overdue order it collided with');
  assert.ok(frozen.changes.start_date.getTime() >= overdue.changes.start_date.getTime());

  // Finish-based since 2026-10-27: the overdue trigger (06:00-09:00) is RUNNING and its finish is inside
  // [now, frozenEnd), so it counts too (Backlog moves running orders); both orders are counted.
  assert.equal(result.diagnostics.frozenMoved, 2);
});

test('Engine.removeBacklog no longer floors overdue orders to the frozen boundary, and still leaves a frozen order the cursor never reaches unpatched', () => {
  const frozenEnd = at('2026-08-14T00:00');
  seed({
    hours: allDays(0, 24),
    tasks: [
      // Genuinely overdue (before "now", 2026-08-12T08:00) and short -- with
      // the C2 floor removed for this mode, it lands exactly at `now`
      // (inside the frozen window), not floored forward to frozenEnd.
      task('trigger-overdue', '2026-08-12T06:00', 0.5),
      // Genuinely inside [now, frozenEnd) but far enough out (next day) that
      // the short overdue order's repair (08:00-08:30) ends long before it
      // starts -- the pre-existing line-caught-up break
      // (`cursor <= item.snapshotStart` => break) still protects it.
      task('frozen-window-uncaught', '2026-08-13T09:00', 1),
    ],
  });
  Store.setFrozenHorizonEnd(frozenEnd, 'test');
  // Widen endDate so the next-day frozen order is in scope at all.
  const result = Engine.removeBacklog(opts({ endDate: at('2026-08-15T00:00') }));

  const overdue = patch(result, 'trigger-overdue');
  assert.ok(overdue, 'the overdue order is repaired');
  assert.equal(+overdue.changes.start_date, +at('2026-08-12T08:00'),
    'no C2 floor: it lands at "now", inside the frozen window, not pushed out to frozenEnd');
  assert.ok(overdue.changes.start_date.getTime() < frozenEnd.getTime());

  assert.equal(patch(result, 'frozen-window-uncaught'), undefined,
    'the line-caught-up break still protects a frozen order the cursor never reaches');

  assert.equal(result.diagnostics.frozenMoved, 0,
    'neither order here is itself a frozen order that got moved');
});

test('Engine rejects a missing plant timezone and never mutates schedule', () => {
  seed({ tasks: [task('past', '2026-08-12T06:00', 1)] });
  Store.setMasterData({ plants: [{ subnetwork: 'SN', plant }], lines: [{ machine: line, plant }] }, 'test');
  assert.throws(() => Engine.removeBacklog(opts()), /timezone/i);
});

test('Engine.removeBacklog may still move a running (in-progress) order -- the one exemption from the running lock', () => {
  seed({ hours: allDays(0, 24), tasks: [task('running-backlog', '2026-08-12T06:00', 3)] });
  assert.equal(Engine.isInProgress(Store.tasks['running-backlog'], at('2026-08-12T08:00')), true, 'fixture is running at "now"');
  const result = Engine.removeBacklog(opts());
  const moved = patch(result, 'running-backlog');
  assert.ok(moved, 'Remove Backlog repairs a running order');
  assert.equal(+moved.changes.start_date, +at('2026-08-12T08:00'));
});

// X3 (Order Rules hardening): Remove Backlog is exempt from the plant's pull/push planning window, at candidate
// time and at Apply time. Due Date mode (the same bounds without the flag) still reports those defects.
function seedWindowPlant(extraTasks = []) {
  seed({ hours: allDays(0, 24), tasks: [
    task('bk-nodue', '2026-08-12T06:00', 1),
    task('bk-olddue', '2026-08-12T07:00', 1, { original_end_date: at('2026-08-05T12:00') }),
    ...extraTasks,
  ] });
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'never',
      max_pull_forward_days: 0, max_push_forward_days: 0 }],
    lines: [{ machine: line, plant }],
  }, 'test');
}
const WINDOW_CODES = ['date_window', 'missing_due_date', 'expired_window'];

test('Remove Backlog ignores the plant pull/push window: candidate and Apply validation stay clean; Due Date still reports it (X3)', () => {
  seedWindowPlant();
  const candidate = Engine.evaluateSchedule('backlog', opts({ plant }));
  const moved = candidate.patches.filter(p => p.id === 'bk-nodue' || p.id === 'bk-olddue');
  assert.ok(moved.length >= 1, 'the past-start orders move forward to now (past their due ceiling)');
  const { snapshot, bounds } = candidate.validationContext;
  assert.equal(bounds.ignorePlantWindow, true, 'only the Backlog bounds carry the flag');
  const codesOf = findings => findings.filter(f => WINDOW_CODES.includes(f.code)).map(f => f.code);
  assert.deepEqual(codesOf(candidate.validationFindings ?? []), [], 'candidate-time validation is clean');
  assert.deepEqual(codesOf(validateCandidateForApply(candidate, snapshot)), [], 'Apply-time validation is clean');
  // The same candidate judged without the exemption (what Due Date mode does) reports the defects.
  const strict = { ...candidate, validationContext: { snapshot, bounds: { ...bounds, ignorePlantWindow: false } } };
  assert.ok(codesOf(validateCandidateForApply(strict, snapshot)).length >= 1,
    'without the flag the plant window rejects the same placement');
  assert.deepEqual(allowedPlanningWindow(snapshot, bounds, Store.tasks['bk-nodue']),
    { floor: null, ceiling: null, missingDue: false });
  assert.equal(allowedPlanningWindow(snapshot, { ...bounds, ignorePlantWindow: false }, Store.tasks['bk-nodue']).missingDue, true);
});

test('Tool Inventory: Remove Backlog is exempt from the tool rule (Hard + loaded inventory: no pass, no finding, no static defect, fields absent)', () => {
  seed({ tasks: [
    task('tb-a', '2026-08-12T06:00', 2, { PRT_01: 'T1' }),
    task('tb-b', '2026-08-12T07:00', 2, { PRT_01: 'T1' }),
    { ...task('tb-other', '2026-08-12T08:00', 2, { PRT_01: 'T1' }), MACHINE: 'L-OTHER' },
    { ...task('tb-dead', '2026-08-12T05:00', 1, { PRT_01: 'T9' }) },
  ] });
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'never', setup_policy_config: { toolingRule: 'hard' } }],
    lines: [{ machine: line, plant }, { machine: 'L-OTHER', plant }],
    tool_inventory: [{ plant, tool_id: 'T1', total_qty: 1, out_of_service_qty: 0, note: null }, { plant, tool_id: 'T9', total_qty: 1, out_of_service_qty: 1, note: null }],
  }, 'test');
  Store.setLineSetting('L-OTHER', { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar('L-OTHER', allDays(8, 16), 'test');
  const candidate = Engine.evaluateSchedule('backlog', opts({ plant }));
  const { snapshot, bounds } = candidate.validationContext;
  assert.equal(bounds.ignoreToolRule, true, 'only the Backlog bounds carry the flag');
  assert.ok(candidate.patches.length >= 2, 'backlog still compresses the past-start orders');
  assert.equal(candidate.toolPass, undefined);
  assert.equal(candidate.toolBlocked, undefined);
  assert.equal(candidate.toolMoved, undefined);
  const tool = findings => findings.filter(f => f.code === 'tool_overflow' || f.code === 'tool_unavailable');
  assert.deepEqual(tool(candidate.validationFindings ?? []), []);
  assert.deepEqual(tool(validateCandidateForApply(candidate, snapshot)), [], 'Apply-time validation is exempt too');
  assert.equal(candidate.patches.some(p => /^tool_/.test(p.changes.planning_reason?.code ?? '')), false, 'no tool queue reason');
  // The same candidate judged WITHOUT the exemption (what a normal run does) sees the overlap with the other line.
  const strict = { ...candidate, toolPass: { complete: true, elapsedMs: 0 }, validationContext: { snapshot, bounds: { ...bounds, ignoreToolRule: false } } };
  assert.ok(tool(validateCandidateForApply(strict, snapshot)).length >= 1, 'without the flag the same placement is a tool finding');
});

// ---- PR3: Remove Backlog in a store-less (worker-like) realm, diagnostics accuracy, perf helpers ----

function clearLiveStore() {
  Store.setMasterData(null, 'test');
  Store.setSelectedPlant(null, 'test');
  Store.setFrozenHorizonEnd(null, 'test');
  Store.setTasks([], 'test');
}

function normPatches(result) {
  return result.patches.map(p => ({ id: p.id, changes: JSON.parse(JSON.stringify(p.changes)) }));
}

test('P0-3: a detached run with an empty live Store counts frozenMoved from the snapshot and matches the live-Store run', () => {
  seed({ hours: allDays(0, 24), tasks: [
    task('trigger-overdue', '2026-08-12T06:00', 3),
    task('frozen-inside-window', '2026-08-12T09:00', 1),
  ] });
  Store.setFrozenHorizonEnd(at('2026-08-15T00:00'), 'test');
  const live = Engine.removeBacklog(opts());
  const snapshot = snapshotSchedule(plant);
  clearLiveStore();
  const detached = Engine.evaluateSchedule('backlog', opts(), snapshot);
  assert.equal(live.diagnostics.frozenMoved, 2);
  assert.equal(detached.backlogResult.diagnostics.frozenMoved, 2,
    'the snapshot frozen end is used, not the empty live Store');
  assert.deepEqual(normPatches(detached), normPatches(live));
});

test('P0-3: detached run across a DST fall-back reads the plant zone from the snapshot and matches the live run', () => {
  seed({ hours: allDays(0, 24), tasks: [task('dst-overdue', '2026-11-01T00:30', 4)] });
  const o = opts({ startDate: at('2026-11-01T00:00'), endDate: at('2026-11-03T00:00'), runAt: at('2026-11-01T06:30:00Z') });
  const live = Engine.removeBacklog(o);
  const snapshot = snapshotSchedule(plant);
  clearLiveStore();
  const detached = Engine.evaluateSchedule('backlog', o, snapshot);
  assert.deepEqual(normPatches(detached), normPatches(live));
});

test('P0-4: an unmoved placement-exception row inside the window is boundary-only and Apply validation raises no window error', () => {
  seed({ hours: allDays(0, 24), tasks: [
    task('exc-overdue', '2026-08-12T06:00', 1, { placement_exception: 'overtime' }),
  ] });
  const candidate = Engine.evaluateSchedule('backlog', opts({ plant }));
  const { snapshot, bounds } = candidate.validationContext;
  assert.ok(!bounds.scopeTaskIds.includes('exc-overdue'));
  assert.ok(bounds.boundaryTaskIds.includes('exc-overdue'));
  assert.deepEqual(validateCandidateForApply(candidate, snapshot).filter(f => f.code === 'date_window'), []);
});

test('P0-5: sub-30-second and unit-suffixed RUN_TIME parse one way; the bad row is invalid and the line continues', () => {
  seed({ hours: allDays(0, 24), tasks: [
    task('tiny', '2026-08-12T06:00', 1, { RUN_TIME: '0.004' }),
    task('suffix', '2026-08-12T07:00', 1, { RUN_TIME: '2.5 h' }),
  ] });
  const result = Engine.removeBacklog(opts());
  assert.deepEqual(result.diagnostics.invalidRuntimeIds, ['tiny']);
  assert.deepEqual(result.diagnostics.calendarSearchFailures, []);
  const placed = patch(result, 'suffix');
  assert.ok(placed, 'the line continues past the invalid row');
  assert.equal((placed.changes.end_date - placed.changes.start_date) / 60000, 150);
});

test('P0-6: queued (needs_planning) rows are not counted as missing a start; a blank MACHINE is on the Unknown line', () => {
  seed({ tasks: [
    ...['q1', 'q2', 'q3'].map(id => task(id, '2026-08-12T09:00', 1, { start_date: null, end_date: null, planning_status: 'needs_planning' })),
    task('never-placed', '2026-08-12T09:00', 1, { start_date: null, end_date: null }),
  ] });
  const result = Engine.removeBacklog(opts());
  assert.deepEqual(result.diagnostics.missingStartIds, ['never-placed']);

  seed({ tasks: [task('blank-line', '2026-08-12T06:00', 1, { MACHINE: '' })] });
  const c = Engine.evaluateSchedule('backlog', opts({ lines: ['Unknown'] }));
  assert.ok(c.validationContext.bounds.scopeTaskIds.includes('blank-line'));
});

test('P1-1: array firmed/boundary ids protect like a Set', () => {
  seed({ hours: allDays(0, 24), tasks: [task('a', '2026-08-12T06:00', 1), task('b', '2026-08-12T12:00', 1)] });
  const candidate = Engine.evaluateSchedule('backlog', opts({ plant }));
  const { snapshot, bounds } = candidate.validationContext;
  assert.ok(Array.isArray(bounds.boundaryTaskIds));
  const base = validateCandidateForApply(candidate, snapshot).map(f => f.code);
  const asSets = { ...candidate, validationContext: { snapshot: { ...snapshot, firmedIds: new Set(snapshot.firmedIds) },
    bounds: { ...bounds, boundaryTaskIds: new Set(bounds.boundaryTaskIds), scopeTaskIds: new Set(bounds.scopeTaskIds) } } };
  assert.deepEqual(validateCandidateForApply(asSets, asSets.validationContext.snapshot).map(f => f.code), base);

});

// Counts Sets built from array iterables while `work` runs. The id-array memos (setup-scheduler `taskIsFirmed`/`idSet`,
// engine `sourceIsFirmed`) build one Set per array; without them every per-order membership check builds its own, so
// the count grows with the number of orders and calls. Scaling both is what makes this fail when a memo is removed.
function arraySetBuilds(work) {
  const RealSet = globalThis.Set;
  let n = 0;
  // Only id Sets: arrays of order-id strings ('m*' orders, 'fx-*' firmed sentinels), not unrelated Sets of lines or dates.
  const isIdArray = it => Array.isArray(it) && it.some(v => typeof v === 'string' && /^(md|fx-)/.test(v));
  globalThis.Set = class extends RealSet { constructor(it) { super(it); if (isIdArray(it)) n++; } };
  try { work(); } finally { globalThis.Set = RealSet; }
  return n;
}

test('P1-1: id arrays build their Set once per array, independent of order count and validation calls', () => {
  const measure = (orders, calls) => {
    seed({ hours: allDays(0, 24), tasks: Array.from({ length: orders }, (_, i) => task(`m${i}`, '2026-08-12T06:00', 0.5)) });
    // Detached run on a snapshot whose firmed ids are an ARRAY: engine `sourceIsFirmed` is asked once per moved order.
    const detached = { ...snapshotSchedule(plant), firmedIds: ['fx-1', 'fx-2'] };
    clearLiveStore();
    let candidate;
    const builds = arraySetBuilds(() => {
      candidate = Engine.evaluateSchedule('backlog', opts({ endDate: at('2026-08-20T00:00') }), detached);
      // validateCandidateForApply reads the candidate's own context, so the id arrays go in there: the firmed ids
      // (setup-scheduler `taskIsFirmed`, asked per order) and the scope/boundary ids (`idSet`, asked per validation).
      const context = candidate.validationContext;
      const bounds = { ...context.bounds, scopeTaskIds: [...context.bounds.scopeTaskIds], boundaryTaskIds: ['fx-3', ...context.bounds.boundaryTaskIds] };
      const snapshot = { ...context.snapshot, firmedIds: ['fx-1', 'fx-2', ...context.snapshot.firmedIds] };
      candidate = { ...candidate, validationContext: { snapshot, bounds } };
      for (let call = 0; call < calls; call += 1) validateCandidateForApply(candidate, snapshot);
    });
    assert.ok(candidate.validationContext.bounds.scopeTaskIds.length >= orders, 'every order is in scope');
    assert.ok(candidate.patches.length > 0, 'orders moved, so sourceIsFirmed ran');
    return builds;
  };
  measure(5, 1); // warm any one-time module state
  const small = measure(10, 2);
  const large = measure(200, 10);
  // A memoised run builds one Set per array regardless of size; an unmemoised one builds one per order and per call
  // (>= 200 x 10 here), so removing any of the three memos makes `large` explode.
  assert.ok(large < 20, `large run built ${large} Sets from id arrays`);
  assert.ok(large <= small + 2, `Set builds must not grow with orders and calls (small ${small}, large ${large})`);
});

test('P1-2: boundaryConflicts golden order and a large patch set stays fast', () => {
  seed({ hours: allDays(0, 24), tasks: [
    task('over', '2026-08-12T06:00', 3),
    task('fixed1', '2026-08-12T09:00', 1),
    task('fixed2', '2026-08-12T10:00', 1),
  ] });
  const result = Engine.removeBacklog(opts({ endDate: at('2026-08-12T08:30') }));
  assert.deepEqual(result.diagnostics.boundaryConflicts.map(c => `${c.movedTaskId}>${c.protectedTaskId}`),
    ['over>fixed1', 'over>fixed2']);

  seed({ hours: allDays(0, 24), tasks: Array.from({ length: 3000 }, (_, i) => task(`b${i}`, '2026-08-12T00:00', 0.01)) });
  const t0 = performance.now();
  Engine.removeBacklog(opts({ endDate: at('2026-08-14T00:00') }));
  // Timing is deliberately only a generous sanity bound (a loaded CI box can be several times slower); the memo
  // behaviour is pinned by the Set-build count above, not by time.
  assert.ok(performance.now() - t0 < 120000, 'generous timing bound');
});
