// Order Rules test matrix (Plant > System Settings > Scheduling Rules > Order Rules).
//
// Six settings, three optimizer modes (SPT, Min Changeover, Due Date):
//   max pull-forward days, max push-forward days, productive segment floor,
//   split order policy, unknown setup policy, and the tooling rule (Off / Hard;
//   see the "Sixth setting" section at the foot of this file).
// Remove Backlog is out of scope.
//
// Every scenario in CASES is plain JSON built by tests/modules/helpers/
// order-rules-fixture.mjs and is run through four passes:
//   direct  - the three evaluators called straight on a detached snapshot
//             (deterministic clock, never-expiring deadline, tiny search caps)
//   engine  - Engine.evaluateSchedule on the same snapshot (adds gap-fill)
//   worker  - buildOptimizerWorkerResponse, compared with the engine pass
//   live    - Engine.runAndApply against a real Store, in ONE spawnSync child
//             so Store/Toast/Persistence state stays out of this process
// and judged by checkInvariants() below, which derives every bound from the
// scenario inputs alone. It never calls Engine.earliestAllowedStart,
// validateCandidate or any engine constant; the expected values are hard-coded.
//
// Defect cases (plan items O1, O2, O3, O5 of the order-rules-hardening plan)
// are EXPECTED to fail until Phase 2 fixes them. They carry node:test's
// { todo } option, so a failure does not fail the run; a Phase 2 step flips one
// by deleting its entry from the case's `todo` map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import * as SetupScheduler from '../../../frontend/optimization/setup-scheduler.mjs';
import { buildOptimizerWorkerResponse } from '../../../frontend/optimization/optimizer-worker.mjs';
import {
  at, normalizeScenario, scenarioSnapshot, scenarioBounds,
} from '../helpers/order-rules-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
// Engine's toast/log guards reference bare window/document (same stub as engine.test.mjs).
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const MIN = 60 * 1000;
const L = text => +at(text);

const MODES = [
  { mode: 'spt', label: 'SPT', direct: SetupScheduler.evaluateSptWithSetup },
  { mode: 'changeover', label: 'MinChangeover', direct: SetupScheduler.evaluateMinChangeover },
  { mode: 'duedate', label: 'DueDate', direct: (snapshot, bounds) => SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date') },
];

// ── Independent invariant checker ──────────────────────────────────────────

function shiftDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Local midnight of the calendar day the due instant closes (a date-only due
 * at 00:00 belongs to the day before, hence the minus one millisecond). */
function dueDayStart(dueText) {
  const day = new Date(L(dueText) - 1);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Merged working windows (ms pairs) from the scenario's own calendar inputs:
 * the line's hours, or the plant's when the line has no calendar row, minus
 * blackout blocks. Windows that touch (24 h shifts, midnight rollover) merge. */
function workingWindows(spec) {
  const hours = spec.lineHours === null ? spec.plantHours : spec.lineHours;
  const first = new Date(L(spec.now)); first.setHours(0, 0, 0, 0);
  const windows = [];
  for (let day = new Date(first); +day < L(spec.horizonEnd) + 24 * 60 * MIN; day = shiftDays(day, 1)) {
    const span = hours[day.getDay()];
    if (!span) continue;
    windows.push([+day + Math.round(span[0] * 60) * MIN, +day + Math.round(span[1] * 60) * MIN]);
  }
  const merged = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && last[1] === window[0]) last[1] = window[1]; else merged.push([...window]);
  }
  let open = merged;
  for (const [blockStart, blockEnd] of spec.blocks) {
    const [bs, be] = [L(blockStart), L(blockEnd)];
    open = open.flatMap(([ws, we]) => {
      if (be <= ws || bs >= we) return [[ws, we]];
      return [[ws, Math.max(ws, bs)], [Math.min(we, be), we]].filter(([a, b]) => b > a);
    });
  }
  return open;
}

/** Setup charge for a transition, from the scenario's matrix and policy. */
function expectedCharge(spec, from, to) {
  const policy = spec.rules.setup_policy_config?.unknownSetupPolicy ?? 'zero';
  const fallback = policy === 'plantDefaultMinutes' ? (spec.rules.setup_policy_config?.unknownSetupDefaultMinutes ?? 0) : 0;
  if (!from || !to) return { minutes: fallback, unrecorded: false };
  const row = spec.rows.find(([a, b]) => a === from && b === to);
  if (row) return { minutes: row[2], unrecorded: false };
  return { minutes: fallback, unrecorded: policy === 'excludeFromSearch' };
}

/** Task-like rows -> normalized rows. A row is {id, status, code, start, end,
 * segments:[{start,end}]}; an order with no row (an incumbent the optimizer
 * left alone) stays at its scenario slot. */
function normalizeRows(spec, list) {
  const byId = new Map(list.map(item => [item.id, item]));
  return spec.tasks.map(t => {
    const item = byId.get(t.id);
    const fixed = spec.firmed.includes(t.id);
    if (!item || item.status === 'unchanged') {
      if (t.start && t.end) {
        return { id: t.id, scheduled: true, pieces: [[L(t.start), L(t.end)]], code: null, fixed, unchanged: true };
      }
      return { id: t.id, scheduled: false, pieces: [], code: item?.code ?? null, fixed, lost: true };
    }
    if (item.status === 'needs_planning') {
      return { id: t.id, scheduled: false, pieces: [], code: item.code ?? null, fixed };
    }
    const segments = item.segments ?? [];
    const pieces = segments.length
      ? segments.map(piece => [+new Date(piece.start), +new Date(piece.end)])
      : [[+new Date(item.start), +new Date(item.end)]];
    return { id: t.id, scheduled: true, pieces, code: null, fixed };
  });
}

function fromCandidate(spec, candidate) {
  const changesById = new Map(candidate.patches.map(patch => [patch.id, patch.changes]));
  const dispositions = new Map((candidate.dispositions ?? []).map(d => [d.id, d]));
  return spec.tasks.map(t => {
    const changes = changesById.get(t.id);
    const disposition = dispositions.get(t.id);
    if (changes?.planning_status === 'needs_planning') {
      return { id: t.id, status: 'needs_planning', code: changes.planning_reason?.code ?? disposition?.reason?.code };
    }
    if (changes?.start_date) {
      return {
        id: t.id, status: 'scheduled', start: changes.start_date, end: changes.end_date,
        segments: (changes.scheduleSegments ?? []).map(s => ({ start: s.startDate, end: s.endDate })),
      };
    }
    if (disposition?.status === 'needs_planning') {
      return { id: t.id, status: 'needs_planning', code: disposition.reason?.code };
    }
    return { id: t.id, status: 'unchanged' };
  });
}

function fromStoreTasks(list) {
  return list.map(t => (t.planning_status === 'needs_planning'
    ? { id: t.id, status: 'needs_planning', code: t.planning_reason?.code }
    : {
      id: t.id, status: t.start_date ? 'scheduled' : 'unchanged', start: t.start_date, end: t.end_date,
      segments: (t.scheduleSegments ?? []).map(s => ({ start: s.startDate, end: s.endDate })),
    }));
}

/** Throws (assert) when the result breaks any Order Rules invariant. Moved,
 * non-firmed orders are held to the windows, floor, split policy and pull/push
 * limits; every order sits in the setup chain, whose gaps must cover the
 * expected charge. */
function checkInvariants(specInput, rows) {
  const spec = normalizeScenario(specInput);
  const rules = spec.rules;
  const pull = Number.isInteger(rules.max_pull_forward_days) ? rules.max_pull_forward_days : null;
  const push = Number.isInteger(rules.max_push_forward_days) ? rules.max_push_forward_days : null;
  const floorMinutes = rules.min_productive_segment_minutes ?? 30;
  const split = rules.split_order_policy ?? 'never';
  const windows = workingWindows(spec);
  const longestWindow = Math.max(0, ...windows.map(([a, b]) => (b - a) / MIN));
  const taskById = new Map(spec.tasks.map(t => [t.id, t]));
  const now = L(spec.now);

  for (const row of rows) {
    assert.ok(!row.lost, `${row.id}: the order vanished (no patch, no disposition, no incumbent slot)`);
    if (!row.scheduled) {
      assert.ok(typeof row.code === 'string' && row.code.length > 0, `${row.id}: a queued order must carry a specific planning_reason.code`);
      continue;
    }
    if (row.fixed) continue;
    const t = taskById.get(row.id);
    const runMinutes = Math.round(t.run * 60);
    const total = row.pieces.reduce((sum, [a, b]) => sum + (b - a) / MIN, 0);
    assert.equal(total, runMinutes, `${row.id}: pieces must add up to the ${runMinutes} minute run time, got ${total}`);
    for (const [a, b] of row.pieces) {
      assert.ok(windows.some(([ws, we]) => ws <= a && b <= we), `${row.id}: piece ${new Date(a)} - ${new Date(b)} is outside the working windows`);
      assert.ok(a >= now, `${row.id}: piece starts before the run's now`);
    }
    if (row.pieces.length > 1) {
      for (const [a, b] of row.pieces) {
        assert.ok((b - a) / MIN >= floorMinutes, `${row.id}: a split piece of ${(b - a) / MIN} min is under the ${floorMinutes} min segment floor`);
      }
    }
    if (split === 'never') assert.equal(row.pieces.length, 1, `${row.id}: split policy never must place one continuous bar`);
    if (split === 'overlong_only' && row.pieces.length > 1) {
      assert.ok(runMinutes > longestWindow, `${row.id}: overlong_only split an order (${runMinutes} min) that fits one ${longestWindow} min window`);
    }
    const day = dueDayStart(t.due);
    if (pull !== null) {
      const floor = +shiftDays(day, -pull);
      assert.ok(row.pieces[0][0] >= floor, `${row.id}: starts ${new Date(row.pieces[0][0])}, before the pull-forward floor ${new Date(floor)}`);
    }
    if (push !== null) {
      const ceiling = +shiftDays(day, push + 1);
      assert.ok(row.pieces[row.pieces.length - 1][1] <= ceiling, `${row.id}: ends after the push-forward ceiling ${new Date(ceiling)}`);
    }
  }

  const chain = rows.filter(row => row.scheduled)
    .map(row => ({ ...row, first: row.pieces[0][0], last: row.pieces[row.pieces.length - 1][1], color: taskById.get(row.id).color || null }))
    .sort((x, y) => x.first - y.first);
  const checkEdge = (prev, next, gapStart) => {
    const charge = expectedCharge(spec, prev, next.color);
    const label = `${prev ?? 'current'} -> ${next.id}(${next.color ?? 'blank'})`;
    if (charge.unrecorded && !next.fixed) assert.fail(`${label}: excludeFromSearch placed an order behind an unrecorded transition`);
    if (!(next.fixed && gapStart.fixed)) {
      assert.ok(next.first - gapStart.at >= charge.minutes * MIN, `${label}: gap is ${(next.first - gapStart.at) / MIN} min, the setup charge is ${charge.minutes} min`);
    }
  };
  if (chain.length && !chain[0].fixed) checkEdge(spec.current, chain[0], { at: now, fixed: false });
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(chain[i].first >= chain[i - 1].last, `${chain[i - 1].id} and ${chain[i].id} overlap on the line`);
    checkEdge(chain[i - 1].color, chain[i], { at: chain[i - 1].last, fixed: chain[i - 1].fixed });
  }
}

// ── Scenarios ──────────────────────────────────────────────────────────────

const T = (id, run, color, due, start, end) => ({ id, run, color, due, start, end });
const DUE_FRI = '2035-08-10T18:00:00';
const DUE_WED = '2035-08-08T18:00:00';
const DUE_MON = '2035-08-06T18:00:00';
const policy = (unknownSetupPolicy, unknownSetupDefaultMinutes) => ({
  setup_policy_config: { unknownSetupPolicy, ...(unknownSetupDefaultMinutes === undefined ? {} : { unknownSetupDefaultMinutes }), version: 2 },
});
const SHORT_WINDOWS = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 10]]));
const byId = (rows, id) => rows.find(row => row.id === id);
const starts = rows => rows.filter(r => r.scheduled).map(r => r.pieces[0][0]);
const scheduledCount = rows => rows.filter(r => r.scheduled).length;
const pieceMinutes = row => row.pieces.map(([a, b]) => (b - a) / MIN);
const allScheduled = rows => assert.equal(scheduledCount(rows), rows.length, 'every order is scheduled');

/** @type {Array<{name:string, spec:object, expect?:(rows:object[])=>void, todo?:Record<string,string>}>} */
const CASES = [];
const add = (name, spec, expectFn, todo) => CASES.push({ name, spec, expect: expectFn, todo });

// pull-forward: null / 0 / 2 / 7 days (floor = due day midnight - N days, never before "now")
for (const [pull, earliest] of [[null, '2035-08-06T08:00:00'], [0, '2035-08-10T08:00:00'], [2, '2035-08-08T08:00:00'], [7, '2035-08-06T08:00:00']]) {
  add(`pull-forward ${pull === null ? 'blank (no limit)' : `${pull} day(s)`} starts the earliest order at ${earliest}`,
    { rules: { max_pull_forward_days: pull }, tasks: [T('a', 4, 'GREEN', DUE_FRI), T('b', 2, 'GREEN', DUE_FRI)] },
    rows => { allScheduled(rows); assert.equal(Math.min(...starts(rows)), L(earliest)); });
}

// push-forward: null / 0 / 2 days (ceiling = midnight after the due day + N days)
const PUSH_TASKS = [T('a', 4, 'GREEN', DUE_MON), T('b', 4, 'GREEN', DUE_MON), T('c', 4, 'GREEN', DUE_MON)];
add('push-forward blank (no limit) places all three 4 h orders', { rules: { max_push_forward_days: null }, tasks: PUSH_TASKS }, allScheduled);
add('push-forward 2 days places all three 4 h orders', { rules: { max_push_forward_days: 2 }, tasks: PUSH_TASKS }, allScheduled);
add('push-forward 0 days fits two 4 h orders on the due day and queues the third with a specific reason',
  { rules: { max_push_forward_days: 0 }, tasks: PUSH_TASKS },
  (rows, pass, mode) => {
    assert.equal(scheduledCount(rows), 2);
    const queued = rows.find(r => !r.scheduled);
    // Only the detached SPT search is genuinely unproven (heuristic, never enumerates sequences); every other path proves the limit is the cause.
    const expected = pass === 'direct' && mode === 'spt' ? ['push_limit_unmet', 'search_incomplete'] : ['push_limit_unmet'];
    assert.ok(expected.includes(queued.code), `queued reason ${queued.code}`);
  });
add('push-forward 0 days with no compliant sequence (due and ceiling already past) queues every order as expired_window',
  { now: '2035-08-09T08:00:00', rules: { max_push_forward_days: 0 }, tasks: [T('a', 2, 'GREEN', DUE_MON), T('b', 2, 'GREEN', DUE_MON)] },
  rows => { assert.equal(scheduledCount(rows), 0); for (const row of rows) assert.equal(row.code, 'expired_window'); });
add('pull-forward 0 with push-forward 0 pins both orders to the due day',
  { rules: { max_pull_forward_days: 0, max_push_forward_days: 0 }, tasks: [T('a', 4, 'GREEN', DUE_WED), T('b', 4, 'GREEN', DUE_WED)] },
  rows => {
    allScheduled(rows);
    for (const row of rows) assert.equal(new Date(row.pieces[0][0]).getDate(), 8, `${row.id} sits on Wednesday the 8th`);
  });

// productive segment floor: 15 / 30 / 60 / 90 on 2 h windows, plus unset and larger-than-any-window
const SPLIT_2H = { lineHours: SHORT_WINDOWS, plantHours: SHORT_WINDOWS };
for (const floor of [15, 30, 60, 90]) {
  add(`segment floor ${floor} min splits a 3 h order across the 2 h windows with every piece at least ${floor} min`,
    { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: floor }, tasks: [T('a', 3, 'GREEN', DUE_FRI)] },
    rows => { allScheduled(rows); assert.ok(byId(rows, 'a').pieces.length >= 2); if (floor === 90) assert.deepEqual(pieceMinutes(byId(rows, 'a')), [90, 90]); });
}
add('segment floor 15 min lets a 135 min order take a 120 + 15 split',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: 15 }, tasks: [T('a', 2.25, 'GREEN', DUE_FRI)] },
  rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [120, 15]); });
add('segment floor 30 min forces the same 135 min order into 105 + 30',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: 30 }, tasks: [T('a', 2.25, 'GREEN', DUE_FRI)] },
  rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [105, 30]); });
add('segment floor unset behaves as 30 min (135 min order splits 105 + 30)',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed' }, tasks: [T('a', 2.25, 'GREEN', DUE_FRI)] },
  rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [105, 30]); });
add('segment floor 150 min (larger than any 2 h window) cannot split a 3 h order: it is queued with a reason, never half-placed',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: 150 }, tasks: [T('a', 3, 'GREEN', DUE_FRI)] },
  rows => { assert.equal(scheduledCount(rows), 0); assert.ok(byId(rows, 'a').code); });
add('O5: segment floor 150 min reports segment_floor_unfittable instead of a generic no-fit',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: 150 }, tasks: [T('a', 3, 'GREEN', DUE_FRI)] },
  rows => { assert.equal(byId(rows, 'a').code, 'segment_floor_unfittable'); });
add('segment floor 150 min still places a 1 h order shorter than the floor as one bar',
  { ...SPLIT_2H, rules: { split_order_policy: 'partial_allowed', min_productive_segment_minutes: 150 }, tasks: [T('a', 1, 'GREEN', DUE_FRI)] },
  rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [60]); });

// split order policy: never / overlong_only / partial_allowed, with and without a line calendar row
for (const lineRow of [true, false]) {
  const calendar = lineRow ? {} : { lineHours: null };
  const where = lineRow ? 'with a line calendar row' : 'with no line calendar row (plant hours apply)';
  add(`split never ${where}: a 12 h order longer than every 10 h window is queued as overlong_never`,
    { ...calendar, rules: { split_order_policy: 'never' }, tasks: [T('a', 12, 'GREEN', DUE_FRI)] },
    rows => { assert.equal(scheduledCount(rows), 0); assert.equal(byId(rows, 'a').code, 'overlong_never'); });
  for (const value of ['overlong_only', 'partial_allowed']) {
    add(`split ${value} ${where}: a 12 h order is split 10 h + 2 h`,
      { ...calendar, rules: { split_order_policy: value }, tasks: [T('a', 12, 'GREEN', DUE_FRI)] },
      rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [600, 120]); });
  }
}
const BLACKOUT = [['2035-08-06T10:00:00', '2035-08-06T11:00:00']];
add('split never with a blackout keeps a 4 h order continuous after the blackout (11:00-15:00)',
  { blocks: BLACKOUT, rules: { split_order_policy: 'never' }, tasks: [T('a', 4, 'GREEN', DUE_WED)] },
  rows => { allScheduled(rows); assert.deepEqual(byId(rows, 'a').pieces, [[L('2035-08-06T11:00:00'), L('2035-08-06T15:00:00')]]); });
add('split overlong_only with a blackout keeps a 4 h order continuous (it fits a 10 h window, so it is not overlong)',
  { blocks: BLACKOUT, rules: { split_order_policy: 'overlong_only' }, tasks: [T('a', 4, 'GREEN', DUE_WED)] },
  rows => { allScheduled(rows); assert.equal(byId(rows, 'a').pieces.length, 1); });
add('split partial_allowed with a blackout fills the gap before it (08:00-10:00 + 11:00-13:00)',
  { blocks: BLACKOUT, rules: { split_order_policy: 'partial_allowed' }, tasks: [T('a', 4, 'GREEN', DUE_WED)] },
  rows => { allScheduled(rows); assert.deepEqual(pieceMinutes(byId(rows, 'a')), [120, 120]); });
add('split never with a blackout and no line calendar row keeps a 4 h order continuous',
  { blocks: BLACKOUT, lineHours: null, rules: { split_order_policy: 'never' }, tasks: [T('a', 4, 'GREEN', DUE_WED)] },
  rows => { allScheduled(rows); assert.equal(byId(rows, 'a').pieces.length, 1); });
add('O3: split overlong_only with a blackout and NO line calendar row keeps a 4 h order continuous (plant hours show it is not overlong)',
  { blocks: BLACKOUT, lineHours: null, rules: { split_order_policy: 'overlong_only' }, tasks: [T('a', 4, 'GREEN', DUE_WED)] },
  rows => { allScheduled(rows); assert.equal(byId(rows, 'a').pieces.length, 1); });

// unknown setup policy: zero / plantDefaultMinutes (0 and 45) / excludeFromSearch
// DEFAULT_SETUP_ROWS: current line state GREEN; GREEN -> BLUE 5 min; nothing covers GREEN -> RED.
const RED = [T('red', 1, 'RED', DUE_WED)];
add('unknown setup zero: an uncovered GREEN -> RED transition costs nothing (starts at 08:00)',
  { rules: policy('zero'), tasks: RED }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:00:00')); });
add('unknown setup zero: an order with a blank state costs nothing (starts at 08:00)',
  { rules: policy('zero'), tasks: [T('blank', 1, '', DUE_WED)] }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:00:00')); });
add('unknown setup plantDefaultMinutes 0 behaves like zero (starts at 08:00)',
  { rules: policy('plantDefaultMinutes', 0), tasks: RED }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:00:00')); });
add('unknown setup plantDefaultMinutes 45: an uncovered transition reserves 45 min (starts at 08:45)',
  { rules: policy('plantDefaultMinutes', 45), tasks: RED }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:45:00')); });
add('unknown setup plantDefaultMinutes 45: a blank state reserves 45 min (starts at 08:45)',
  { rules: policy('plantDefaultMinutes', 45), tasks: [T('blank', 1, '', DUE_WED)] }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:45:00')); });
add('unknown setup plantDefaultMinutes 45 leaves a covered GREEN -> BLUE transition at its recorded 5 min (starts at 08:05)',
  { rules: policy('plantDefaultMinutes', 45), tasks: [T('blue', 1, 'BLUE', DUE_WED)] }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:05:00')); });
for (const [what, boundaryColor] of [['an uncovered', 'RED'], ['a blank-state', '']]) {
  add(`O1: unknown setup plantDefaultMinutes 45 reserves the default before a firmed order behind ${what} boundary (the 2 h predecessor must still be placed)`,
    {
      rules: policy('plantDefaultMinutes', 45), firmed: ['F'],
      tasks: [T('F', 1, boundaryColor, DUE_WED, '2035-08-06T10:00:00', '2035-08-06T11:00:00'), T('M', 2, 'GREEN', DUE_WED)],
    },
    rows => { assert.ok(byId(rows, 'M').scheduled, 'M is placed, not dropped'); });
}
add('unknown setup excludeFromSearch: a fresh uncovered order is queued setup_transition_unrecorded and the covered order is still placed',
  { rules: policy('excludeFromSearch'), tasks: [T('n8-red', 1, 'RED', DUE_WED), T('n8-zblue', 1, 'BLUE', DUE_WED)] },
  rows => {
    assert.ok(byId(rows, 'n8-zblue').scheduled);
    assert.equal(byId(rows, 'n8-red').scheduled, false);
    assert.equal(byId(rows, 'n8-red').code, 'setup_transition_unrecorded');
  });
add('unknown setup excludeFromSearch: a blank-state order is not excluded (starts at 08:00)',
  { rules: policy('excludeFromSearch'), tasks: [T('blank', 1, '', DUE_WED)] }, rows => { allScheduled(rows); assert.equal(starts(rows)[0], L('2035-08-06T08:00:00')); });
add('O2: unknown setup excludeFromSearch also pulls an already-scheduled order behind an unrecorded transition',
  { rules: policy('excludeFromSearch'), tasks: [T('A', 1, 'RED', DUE_WED, '2035-08-06T08:00:00', '2035-08-06T09:00:00')] },
  rows => { assert.equal(byId(rows, 'A').scheduled, false); assert.equal(byId(rows, 'A').code, 'setup_transition_unrecorded'); });

// O2 (continued): incumbents behind an unrecorded edge, and the cascade rule. DEFAULT_SETUP_ROWS cover GREEN -> BLUE and nothing into RED.
add('O2: excludeFromSearch queues an incumbent whose uncovered edge does not overlap its predecessor (BLUE -> RED, 3 h gap)',
  { rules: policy('excludeFromSearch'), tasks: [T('B', 1, 'BLUE', DUE_WED, '2035-08-06T09:00:00', '2035-08-06T10:00:00'), T('A', 1, 'RED', DUE_WED, '2035-08-06T13:00:00', '2035-08-06T14:00:00')] },
  rows => { assert.ok(byId(rows, 'B').scheduled); assert.equal(byId(rows, 'A').scheduled, false); assert.equal(byId(rows, 'A').code, 'setup_transition_unrecorded'); });
add('O2: excludeFromSearch does not cascade - queuing X (GREEN -> RED) leaves Y (RED -> BLUE as an incumbent, GREEN -> BLUE once X is gone) scheduled',
  { rules: policy('excludeFromSearch'), tasks: [T('X', 1, 'RED', DUE_WED, '2035-08-06T09:00:00', '2035-08-06T10:00:00'), T('Y', 1, 'BLUE', DUE_WED, '2035-08-06T11:00:00', '2035-08-06T12:00:00')] },
  rows => { assert.equal(byId(rows, 'X').scheduled, false); assert.equal(byId(rows, 'X').code, 'setup_transition_unrecorded'); assert.ok(byId(rows, 'Y').scheduled, 'Y keeps a slot'); });
add('unknown setup zero and plantDefaultMinutes keep an incumbent behind an uncovered edge scheduled (warning only)',
  { rules: policy('zero'), tasks: [T('A', 1, 'RED', DUE_WED, '2035-08-06T09:00:00', '2035-08-06T10:00:00')] },
  rows => { assert.ok(byId(rows, 'A').scheduled); });

add('O8 (suspected): unknown setup excludeFromSearch still places two RED orders that are reachable through YELLOW (GREEN -> YELLOW -> RED)',
  {
    rules: policy('excludeFromSearch'), current: 'GREEN',
    rows: [['GREEN', 'GREEN', 0], ['GREEN', 'YELLOW', 5], ['YELLOW', 'RED', 5], ['YELLOW', 'YELLOW', 0], ['RED', 'RED', 0]],
    tasks: [T('t0', 1, 'RED', DUE_WED), T('t1', 1, 'RED', DUE_WED), T('t2', 3, 'YELLOW', DUE_WED)],
  },
  rows => { allScheduled(rows); },
  // Found by fuzzing. NOT an O8 leak (winner-only exclusions do not change it): detached SPT evaluates ONE sequence
  // (runtime-first: t0, t1, t2), so t0/t1 follow GREEN directly, an uncovered pair, and are refused at that position even
  // though GREEN -> YELLOW -> RED is covered. SPT never reorders for coverage by design, so only the Engine pass
  // (fillPlanningGaps places them after t2) recovers them. Left as a todo: fixing it means making SPT coverage-aware.
  { 'direct:spt': 'SPT keeps its runtime-first order, so RED is refused behind GREEN; recovered by gap-fill (not O8)' });

// all five settings together
add('all five Order Rules together: pull 1, push 1, floor 60, overlong_only, plantDefaultMinutes 30',
  {
    rules: { max_pull_forward_days: 1, max_push_forward_days: 1, min_productive_segment_minutes: 60, split_order_policy: 'overlong_only', ...policy('plantDefaultMinutes', 30) },
    tasks: [T('a', 4, 'GREEN', DUE_WED), T('b', 3, 'RED', DUE_WED), T('c', 2, 'BLUE', DUE_WED)],
  },
  rows => { allScheduled(rows); });

// ── Passes ─────────────────────────────────────────────────────────────────

const todoFor = (testCase, pass, mode) => testCase.todo?.[`${pass}:${mode}`] ?? testCase.todo?.[pass] ?? testCase.todo?.['*'];
const options = (testCase, pass, mode) => {
  const reason = todoFor(testCase, pass, mode);
  return reason ? { todo: reason } : {};
};

function judge(testCase, rows, pass, mode) {
  checkInvariants(testCase.spec, rows);
  testCase.expect?.(rows, pass, mode);
}

function engineOptions(spec) {
  const s = normalizeScenario(spec);
  return {
    plant: 'P1', respectFirmed: true, respectCalendar: true,
    now: at(s.now), runNow: at(s.now), planningStart: at(s.now), startDate: at(s.now), endDate: at(s.horizonEnd),
    deadlineAt: performance.now() + 60000,
  };
}

for (const testCase of CASES) {
  for (const { mode, label, direct } of MODES) {
    test(`direct ${label}: ${testCase.name}`, options(testCase, 'direct', mode), () => {
      const result = direct(scenarioSnapshot(testCase.spec), scenarioBounds(testCase.spec));
      const rows = normalizeRows(normalizeScenario(testCase.spec), fromCandidate(testCase.spec, result));
      judge(testCase, rows, 'direct', mode);
    });
  }
}

for (const testCase of CASES) {
  for (const { mode, label } of MODES) {
    test(`Engine.evaluateSchedule ${label}: ${testCase.name}`, options(testCase, 'engine', mode), () => {
      const result = Engine.evaluateSchedule(mode, engineOptions(testCase.spec), scenarioSnapshot(testCase.spec));
      judge(testCase, normalizeRows(normalizeScenario(testCase.spec), fromCandidate(testCase.spec, result)), 'engine', mode);
    });
  }
}

// Worker parity: the worker's candidate must match the main-thread Engine pass
// (same patches, same reasons) and satisfy the same invariants.
for (const testCase of CASES) {
  for (const { mode, label } of MODES) {
    test(`worker parity ${label}: ${testCase.name}`, options(testCase, 'worker', mode), () => {
      const spec = normalizeScenario(testCase.spec);
      const request = {
        mode, plant: 'P1', respectFirmed: true, respectCalendar: true,
        now: at(spec.now), runNow: at(spec.now), planningStart: at(spec.now), endDate: at(spec.horizonEnd),
      };
      const response = buildOptimizerWorkerResponse({
        runId: `matrix-${mode}`, mode, snapshot: scenarioSnapshot(spec), request, deadlineDurationMs: 5000,
      }, () => 5000);
      const workerRows = normalizeRows(spec, fromCandidate(spec, response.candidate));
      const engineResult = Engine.evaluateSchedule(mode, engineOptions(spec), scenarioSnapshot(spec));
      const engineRows = normalizeRows(spec, fromCandidate(spec, engineResult));
      assert.deepEqual(workerRows, engineRows, 'the worker and the main-thread Engine must agree');
      judge(testCase, workerRows, 'worker', mode);
    });
  }
}

// Live runAndApply: ONE child process loops over every (case, mode), applying
// into a real Store, and prints the resulting tasks as JSON.
let liveResults = null;
function liveRun() {
  if (liveResults) return liveResults;
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine } = await import('./frontend/optimization/engine.mjs');
    const F = await import('./tests/modules/helpers/order-rules-fixture.mjs');
    const jobs = JSON.parse(process.env.ORDER_RULES_JOBS);
    const out = {};
    for (const job of jobs) {
      const spec = F.normalizeScenario(job.spec);
      const snapshot = F.scenarioSnapshot(spec);
      Store.setMasterData(snapshot.masterData, 'child-test');
      Store.setSelectedPlant('P1', 'child-test');
      Store.replaceCalendars(snapshot.calendars, 'child-test');
      Store.replacePlants(snapshot.plants, 'child-test');
      Store.replaceSetupSnapshot(snapshot.setupSnapshot, 'child-test');
      Store.replaceBlocks(snapshot.blocks, 'child-test');
      Store.replaceFirmedIds(new Set(spec.firmed), 'child-test');
      Store.setTasks(snapshot.tasks, 'child-test');
      Engine.runAndApply(job.mode, {
        plant: 'P1', respectFirmed: true, respectCalendar: true,
        runNow: F.at(spec.now), startDate: F.at(spec.now), endDate: F.at(spec.horizonEnd),
      });
      out[job.key] = Store.tasksArr.map(t => ({
        id: t.id, planning_status: t.planning_status, planning_reason: t.planning_reason ?? null,
        start_date: t.start_date, end_date: t.end_date, scheduleSegments: t.scheduleSegments ?? [],
      }));
    }
    console.log('@@RESULT@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const jobs = CASES.flatMap((testCase, index) => MODES.map(({ mode }) => ({ key: `${index}:${mode}`, mode, spec: testCase.spec })));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ORDER_RULES_JOBS: JSON.stringify(jobs) },
  });
  assert.equal(run.error, undefined, `live runAndApply probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'live runAndApply probe exited unsuccessfully');
  const line = run.stdout.split('\n').find(text => text.startsWith('@@RESULT@@'));
  assert.ok(line, `live probe printed no result: ${run.stdout.slice(-400)}`);
  liveResults = JSON.parse(line.slice('@@RESULT@@'.length));
  return liveResults;
}

CASES.forEach((testCase, index) => {
  for (const { mode, label } of MODES) {
    test(`live Engine.runAndApply ${label}: ${testCase.name}`, options(testCase, 'live', mode), () => {
      const spec = normalizeScenario(testCase.spec);
      judge(testCase, normalizeRows(spec, fromStoreTasks(liveRun()[`${index}:${mode}`])), 'live', mode);
    });
  }
});

// ── O2 / O8: validator and repair, called directly ─────────────────────────
// A hand-built candidate that leaves every order in place, so the validator alone judges the incumbent schedule.
function unrecordedFindings(spec, { queue = [], boundsPatch } = {}) {
  const snapshot = scenarioSnapshot(spec);
  const bounds = boundsPatch ? boundsPatch(scenarioBounds(spec)) : scenarioBounds(spec);
  const firmed = new Set(normalizeScenario(spec).firmed);
  const patches = queue.map(id => ({ id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: { code: 'no_fit_found', message: 'x' } } }));
  const dispositions = snapshot.tasks.map(t => ({
    id: t.id, line: 'L1', status: firmed.has(t.id) ? 'protected' : queue.includes(t.id) ? 'needs_planning' : 'scheduled',
    ...(queue.includes(t.id) ? { reason: { code: 'no_fit_found', message: 'x' } } : {}),
  }));
  const findings = SetupScheduler.validateCandidate(snapshot, bounds, { patches, dispositions });
  return { findings, unrecorded: findings.filter(f => f.code === 'setup_transition_unrecorded') };
}
const CHAIN = [T('X', 1, 'RED', DUE_WED, '2035-08-06T09:00:00', '2035-08-06T10:00:00'), T('Y', 1, 'BLUE', DUE_WED, '2035-08-06T11:00:00', '2035-08-06T12:00:00')];

test('O2 validator: excludeFromSearch reports an error per unrecorded incoming edge, naming both states and the line', () => {
  const { unrecorded } = unrecordedFindings({ rules: policy('excludeFromSearch'), tasks: CHAIN });
  assert.deepEqual(unrecorded.map(f => [f.taskId, f.severity, f.line]), [['X', 'error', 'L1'], ['Y', 'error', 'L1']]);
  assert.match(unrecorded[0].message, /GREEN to RED on L1/);
  assert.match(unrecorded[1].message, /RED to BLUE on L1/);
});

test('O2 validator: once X is queued Y\'s new predecessor (GREEN) is covered, so Y raises nothing (the cascade repairCandidate relies on)', () => {
  const { unrecorded } = unrecordedFindings({ rules: policy('excludeFromSearch'), tasks: CHAIN }, { queue: ['X'] });
  assert.deepEqual(unrecorded, []);
});

test('O2 validator: a protected (firmed) order behind an unrecorded edge stays a warning, its unprotected successor is an error', () => {
  const { findings, unrecorded } = unrecordedFindings({ rules: policy('excludeFromSearch'), firmed: ['X'], tasks: CHAIN });
  assert.deepEqual(unrecorded.map(f => f.taskId), ['Y']);
  assert.ok(findings.some(f => f.code === 'missing_setup' && f.taskId === 'X' && f.severity === 'warning'));
});

for (const [name, rules] of [['zero', policy('zero')], ['plantDefaultMinutes 30', policy('plantDefaultMinutes', 30)]]) {
  test(`O2 validator: ${name} never raises setup_transition_unrecorded (missing_setup stays a warning)`, () => {
    const { findings, unrecorded } = unrecordedFindings({ rules, tasks: [T('X', 1, 'RED', DUE_WED, '2035-08-06T09:00:00', '2035-08-06T10:00:00')] });
    assert.deepEqual(unrecorded, []);
    assert.ok(findings.some(f => f.code === 'missing_setup' && f.severity === 'warning'));
  });
}

test('O2 validator: a synthetic zero-cost snapshot (Remove Backlog, setup-inactive plants) forces the policy to zero and is unaffected', () => {
  const { findings, unrecorded } = unrecordedFindings({ rules: policy('excludeFromSearch'), tasks: CHAIN }, {
    boundsPatch: bounds => ({ ...bounds, setup: { ...bounds.setup, synthetic: true } }),
  });
  assert.deepEqual(unrecorded, []);
  assert.equal(findings.some(f => f.code === 'missing_setup'), false, 'the synthetic snapshot reports no missing-setup warning either');
});

test('O2: gap-fill is not disabled after finalize (the repaired candidate is internally valid, so fillPlanningGaps still runs its check)', () => {
  const spec = { rules: policy('excludeFromSearch'), tasks: [T('A', 1, 'RED', DUE_WED, '2035-08-06T08:00:00', '2035-08-06T09:00:00')] };
  const snapshot = scenarioSnapshot(spec); const bounds = scenarioBounds(spec);
  const result = SetupScheduler.evaluateSptWithSetup(snapshot, bounds);
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false, 'the finalized candidate carries no error finding');
  const filled = SetupScheduler.fillPlanningGaps(snapshot, bounds, result);
  assert.equal(filled.gapFill.complete, true, 'an invalid candidate would have skipped the gap check and reported it incomplete');
  assert.equal(filled.dispositions.find(d => d.id === 'A').reason.code, 'setup_transition_unrecorded');
});

// ── Sixth setting: the tooling rule column (Off / Hard), crossed with every case above ────────────────────────────
// Each case is run again with every task carrying T1 and with the rule in each variant (see applyToolVariant in the
// fixture): 'off' (inventory loaded), 'hard' (inventory loaded, 3 copies: one machine can never exceed them) and
// 'hard-unloaded' (inventory not loaded). The tooling rule must be INVISIBLE on this single-line matrix: patches,
// dispositions, score and findings are byte-identical to the baseline snapshot with no inventory and the rule absent,
// for all three strategies and the direct / engine / worker / live passes. The three tool fields are absent when the
// rule is Off or the inventory is not loaded; under a loaded Hard rule only `toolPass` appears (nothing to move or queue).
const TOOL_VARIANTS = ['off', 'hard', 'hard-unloaded'];
const withTool = (spec, tool) => ({ ...spec, tool });
const PATCH_KEYS = ['start_date', 'end_date', 'scheduleSegments', 'planning_status', 'planning_reason'];

/** The comparable face of a candidate: everything but timings and the tool fields. */
function canonCandidate(candidate) {
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  return JSON.stringify({
    patches: [...candidate.patches].sort(byId).map(p => ({ id: p.id, changes: p.changes })),
    dispositions: [...(candidate.dispositions ?? [])].sort(byId),
    score: candidate.score,
    findings: (candidate.validationFindings ?? []).map(f => [f.code, f.severity, f.taskId ?? null, f.message]).sort(),
  });
}

/** checkInvariants, tool edition: a patch never changes MACHINE (or any business field), every tool outcome carries its
 * structured reason, and the tool fields obey the Off / unloaded / Hard presence rule. */
function checkToolInvariants(tool, candidate) {
  for (const patch of candidate.patches) {
    assert.deepEqual(Object.keys(patch.changes).filter(key => !PATCH_KEYS.includes(key)), [], `patch ${patch.id} changes only schedule fields (never MACHINE)`);
    const reason = patch.changes.planning_reason;
    if (reason && /^tool_/.test(reason.code)) {
      assert.equal(typeof reason.tool_id, 'string', 'a tool reason names the tool');
      assert.equal(typeof reason.available, 'number', 'and the copies available');
      assert.ok(Array.isArray(reason.holders), 'and the holders');
    }
  }
  assert.equal((candidate.validationFindings ?? []).some(f => f.severity === 'error' && f.code === 'tool_overflow'), false, 'no unresolved tool overflow');
  if (tool === 'hard') {
    assert.equal(candidate.toolPass?.complete, true);
    assert.equal(candidate.toolBlocked, undefined); assert.equal(candidate.toolMoved, undefined);
  } else {
    assert.equal(candidate.toolPass, undefined); assert.equal(candidate.toolBlocked, undefined); assert.equal(candidate.toolMoved, undefined);
  }
}

for (const testCase of CASES) {
  for (const { mode, label, direct } of MODES) {
    for (const tool of TOOL_VARIANTS) {
      test(`tooling ${tool} parity, direct ${label}: ${testCase.name}`, options(testCase, 'direct', mode), () => {
        const base = direct(scenarioSnapshot(testCase.spec), scenarioBounds(testCase.spec));
        const spec = withTool(testCase.spec, tool);
        const result = direct(scenarioSnapshot(spec), scenarioBounds(spec));
        assert.equal(canonCandidate(result), canonCandidate(base), 'identical to the snapshot with no inventory');
        checkToolInvariants(tool, result);
      });
      test(`tooling ${tool} parity, Engine.evaluateSchedule ${label}: ${testCase.name}`, options(testCase, 'engine', mode), () => {
        const base = Engine.evaluateSchedule(mode, engineOptions(testCase.spec), scenarioSnapshot(testCase.spec));
        const spec = withTool(testCase.spec, tool);
        const result = Engine.evaluateSchedule(mode, engineOptions(spec), scenarioSnapshot(spec));
        assert.equal(canonCandidate(result), canonCandidate(base), 'identical to the snapshot with no inventory');
        checkToolInvariants(tool, result);
      });
      test(`tooling ${tool} parity, worker ${label}: ${testCase.name}`, options(testCase, 'worker', mode), () => {
        const spec = withTool(normalizeScenario(testCase.spec), tool);
        const request = { mode, plant: 'P1', respectFirmed: true, respectCalendar: true,
          now: at(spec.now), runNow: at(spec.now), planningStart: at(spec.now), endDate: at(spec.horizonEnd) };
        const run = s => buildOptimizerWorkerResponse({ runId: `matrix-tool-${mode}`, mode, snapshot: scenarioSnapshot(s), request, deadlineDurationMs: 5000 }, () => 5000);
        const base = run(normalizeScenario(testCase.spec)).candidate;
        const response = run(spec);
        assert.equal(canonCandidate(response.candidate), canonCandidate(base));
        const engineResult = Engine.evaluateSchedule(mode, engineOptions(spec), scenarioSnapshot(spec));
        assert.equal(canonCandidate(response.candidate), canonCandidate(engineResult), 'worker == main thread');
        checkToolInvariants(tool, response.candidate);
      });
    }
  }
}

// Live: one more child, every (case, mode, variant) plus the baseline, compared task by task.
let liveToolResults = null;
function liveToolRun() {
  if (liveToolResults) return liveToolResults;
  const child = String.raw`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    globalThis.NimbusComputeCore = require('./frontend/nimbus-compute-core.js');
    globalThis.window = {};
    globalThis.document = { getElementById: () => null };
    const { Store } = await import('./frontend/platform/store.mjs');
    const { Engine } = await import('./frontend/optimization/engine.mjs');
    const F = await import('./tests/modules/helpers/order-rules-fixture.mjs');
    const jobs = JSON.parse(process.env.ORDER_RULES_TOOL_JOBS);
    const out = {};
    for (const job of jobs) {
      const spec = F.normalizeScenario({ ...job.spec, tool: job.tool || undefined });
      const snapshot = F.scenarioSnapshot(spec);
      Store.setMasterData(snapshot.masterData, 'child-test');
      Store.setSelectedPlant('P1', 'child-test');
      Store.replaceCalendars(snapshot.calendars, 'child-test');
      Store.replacePlants(snapshot.plants, 'child-test');
      Store.replaceSetupSnapshot(snapshot.setupSnapshot, 'child-test');
      Store.replaceBlocks(snapshot.blocks, 'child-test');
      Store.replaceFirmedIds(new Set(spec.firmed), 'child-test');
      Store.setTasks(snapshot.tasks, 'child-test');
      Engine.runAndApply(job.mode, {
        plant: 'P1', respectFirmed: true, respectCalendar: true,
        runNow: F.at(spec.now), startDate: F.at(spec.now), endDate: F.at(spec.horizonEnd),
      });
      out[job.key] = Store.tasksArr.map(t => ({
        id: t.id, planning_status: t.planning_status, planning_reason: t.planning_reason ?? null,
        start_date: t.start_date, end_date: t.end_date, scheduleSegments: t.scheduleSegments ?? [], MACHINE: t.MACHINE,
      }));
    }
    console.log('@@RESULT@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const jobs = CASES.flatMap((testCase, index) => MODES.flatMap(({ mode }) => ['', ...TOOL_VARIANTS].map(tool => (
    { key: `${index}:${mode}:${tool}`, mode, tool, spec: testCase.spec }))));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ORDER_RULES_TOOL_JOBS: JSON.stringify(jobs) },
  });
  assert.equal(run.error, undefined, `live tooling probe did not complete: ${run.error?.message || run.stderr}`);
  assert.equal(run.status, 0, run.stderr || 'live tooling probe exited unsuccessfully');
  const line = run.stdout.split('\n').find(text => text.startsWith('@@RESULT@@'));
  assert.ok(line, `live tooling probe printed no result: ${run.stdout.slice(-400)}`);
  liveToolResults = JSON.parse(line.slice('@@RESULT@@'.length));
  return liveToolResults;
}

CASES.forEach((testCase, index) => {
  for (const { mode, label } of MODES) {
    for (const tool of TOOL_VARIANTS) {
      test(`tooling ${tool} parity, live Engine.runAndApply ${label}: ${testCase.name}`, options(testCase, 'live', mode), () => {
        const all = liveToolRun();
        const strip = rows => JSON.stringify(rows.map(r => ({ ...r, planning_reason: r.planning_reason && { code: r.planning_reason.code, message: r.planning_reason.message } })));
        assert.equal(strip(all[`${index}:${mode}:${tool}`]), strip(all[`${index}:${mode}:`]), 'live result identical to the snapshot with no inventory');
        assert.ok(all[`${index}:${mode}:${tool}`].every(r => r.MACHINE === 'L1'), 'MACHINE never changes');
      });
    }
  }
});

// Hard with available 0: every order carrying the tool goes to Needs Planning with the structured tool_unavailable reason.
test('tooling Hard with 0 copies available: every optimizable order is queued with tool_unavailable on every strategy and pass', () => {
  const spec = { rules: {}, tasks: [T('a', 2, 'GREEN', DUE_WED), T('b', 1, 'BLUE', DUE_WED)] };
  for (const { mode, direct } of MODES) {
    const make = () => { const s = scenarioSnapshot(withTool(spec, 'hard')); s.masterData.tool_inventory[0].out_of_service_qty = 3; return s; };
    for (const result of [direct(make(), scenarioBounds(spec)), Engine.evaluateSchedule(mode, engineOptions(spec), make())]) {
      const queued = result.patches.filter(p => p.changes.planning_status === 'needs_planning');
      assert.deepEqual(queued.map(p => p.id).sort(), ['a', 'b']);
      assert.ok(queued.every(p => p.changes.planning_reason.code === 'tool_unavailable' && p.changes.planning_reason.tool_id === 'T1' && p.changes.planning_reason.available === 0));
      assert.deepEqual((result.toolBlocked ?? []).map(e => e.orderId).sort(), ['a', 'b']);
      assert.equal((result.validationFindings ?? []).some(f => f.severity === 'error'), false);
    }
  }
});
