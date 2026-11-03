import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateSchedule, deriveSetupObservation } from '../../frontend/optimization/engine.mjs';
import * as SetupScheduler from '../../frontend/optimization/setup-scheduler.mjs';
import { ErrorLog } from '../../frontend/platform/foundation.mjs';
import { Store } from '../../frontend/platform/store.mjs';
import { Engine } from '../../frontend/optimization/engine.mjs';
import * as ToolFx from './helpers/tool-overflow-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../frontend/nimbus-compute-core.js');

function task(id, runHours) {
  return {
    id,
    PLANT: 'P1',
    plant: 'P1',
    MACHINE: 'L1',
    RUN_TIME: runHours,
    start_date: null,
    end_date: null,
    original_start_date: null,
    original_end_date: null,
    BASIC_START_DATE: null,
    BASIC_FINISH_DATE: null,
    firmed: false,
    row_version: null,
  };
}

function legacySnapshot(tasks) {
  return {
    tasks,
    firmedIds: [],
    alerts: [],
    selectedPlant: 'P1',
    blocks: [],
    plantBlocks: [],
    calendars: {},
    plants: {},
    lineSettings: {},
    masterData: { plants: [{ plant: 'P1' }], lines: [{ plant: 'P1', machine: 'L1' }] },
    priorityRankMaps: {},
  };
}

const OPEN_HOURS = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));

function setupState(value) {
  return [{ fieldKey: 'colorWheel', value }];
}

function setupDefinition() {
  return {
    plant: 'P1', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true,
  };
}

function setupRow(from, to, minutes, machine = '') {
  return { machine, signature_version: 1, from_key: setupState(from), to_key: setupState(to), setup_min: minutes };
}

function setupTruth({ current = 'GREEN', rows = [], overrides = [], definition = setupDefinition() } = {}) {
  return {
    plant: 'P1', definition,
    plant_rows: rows,
    machine_rows: [],
    machine_states: current === null ? [] : [{
      machine: 'L1', state_key: setupState(current), signature_version: 1,
      source: 'manual', reason: 'unit-test current state',
    }],
    overrides,
  };
}

function scheduledTask(id, runHours, color, due, start = null, end = null) {
  return {
    ...task(id, runHours), COLOR: color,
    original_end_date: due ? at(due) : null,
    start_date: start ? at(start) : null,
    end_date: end ? at(end) : null,
  };
}

function setupSnapshot(tasks, { firmedIds = [], lineSettings = {} } = {}) {
  return {
    ...legacySnapshot(tasks),
    firmedIds,
    calendars: { L1: { workHours: OPEN_HOURS } },
    plants: { P1: { workHours: OPEN_HOURS } },
    lineSettings,
  };
}

function dueDateBounds(setup, overrides = {}) {
  return {
    setup,
    exactSearchThreshold: 6,
    iterationCap: 64,
    clock: () => 0,
    deadline: 1,
    now: at('2026-08-03T08:00:00'),
    horizonEnd: at('2026-08-03T18:00:00'),
    ...overrides,
  };
}

function patchFor(result, id) {
  return result.patches.find(patch => patch.id === id && patch.changes.planning_status !== 'needs_planning');
}

function at(text) {
  return new Date(text);
}

function interval(start, end) {
  return { start: at(start), end: at(end) };
}

function resolvedSetup(minutes) {
  return { kind: 'resolved', minutes };
}

function segmentMinutes(result) {
  return result.productiveSegments.map(segment => (
    (segment.end.getTime() - segment.start.getTime()) / (60 * 1000)
  ));
}

function gapFillFixture(tasks, setup = setupTruth(), overrides = {}) {
  const snapshot = setupSnapshot(tasks);
  const bounds = dueDateBounds(setup, { deadline: -2000, ...overrides });
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  return { snapshot, bounds, candidate };
}

test('setup-aware diagnostics identify strict-blank orders as an unknown tail', () => {
  const known = scheduledTask('contract-known-blue', 1, 'BLUE', '2026-08-03T18:00');
  const unknown = scheduledTask('contract-unknown-blank', 1, '', '2026-08-03T18:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([known, unknown]),
    dueDateBounds(setup),
  );

  assert.equal(result.diagnostics.unknownTailCount, 1,
    'an unresolved successor signature must be counted as an opaque tail order');
  assert.equal(result.diagnostics.unknownEdgeCount, 1,
    'unknown setup edges must remain distinct from known uncovered matrix edges');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'unknown-setup-tail-placement' && reason.taskId === 'contract-unknown-blank'
  )));
  assert.equal(result.missingEdges.some(edge => (
    edge.successorOrderId === 'contract-unknown-blank' && edge.reason === 'scheduled-without-setup'
  )), false, 'a null signature is not a known uncovered matrix transition');
});

test('unknown-tail diagnostics count opaque demand even when placement remains unserved', () => {
  const unknown = scheduledTask('contract-unknown-unplaced', 2, '', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([unknown]),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T09:00') }),
  );

  assert.equal(result.diagnostics.unknownTailCount, 1,
    'unknown-tail count must include every eligible opaque order');
  assert.equal(result.diagnostics.unknownTailPlacedCount, 0);
  assert.equal(result.diagnostics.unknownTailUnplacedCount, 1,
    'opaque placement accounting must expose its unplaced remainder');
  assert.equal(result.diagnostics.unplacedCount, 1);
});

test('unknown-tail diagnostics exclude opaque protected occupancy boundaries', () => {
  const protectedBoundary = scheduledTask(
    'contract-unknown-protected-boundary', 1, '', '2026-08-03T18:00',
    '2026-08-03T13:00', '2026-08-03T14:00',
  );
  const mutable = scheduledTask('contract-known-mutable', 1, 'GREEN', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([protectedBoundary, mutable], { firmedIds: [protectedBoundary.id] }),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T12:00') }),
  );

  assert.equal(result.dispositions.some(disposition => disposition.id === protectedBoundary.id), false,
    'an opaque protected boundary is occupancy context, not mutable demand');
  assert.equal(result.diagnostics.unknownTailCount, 0,
    'unknown-tail counts must exclude opaque protected boundaries outside the horizon');
  assert.equal(result.diagnostics.unknownTailUnplacedCount, 0);
});

test('unknown-tail diagnostics exclude opaque protected work inside the horizon', () => {
  const protectedOpaque = scheduledTask(
    'contract-unknown-protected-in-window', 1, '', '2026-08-03T18:00',
    '2026-08-03T10:00', '2026-08-03T11:00',
  );
  const mutable = scheduledTask('contract-known-mutable-in-window', 1, 'GREEN', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([protectedOpaque, mutable], { firmedIds: [protectedOpaque.id] }),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T12:00') }),
  );

  assert.equal(result.dispositions.find(disposition => disposition.id === protectedOpaque.id)?.status, 'protected');
  assert.equal(result.diagnostics.unknownTailCount, 0,
    'opaque firmed work inside the horizon is protected occupancy, not unknown demand');
  assert.equal(result.diagnostics.unknownTailPlacedCount, 0);
  assert.equal(result.diagnostics.unknownTailUnplacedCount, 0);
});

test('greedy required-final adjacency dead ends report heuristic convergence', () => {
  const predecessor = scheduledTask('diagnostic-required-final-predecessor', 1, 'RED', '2026-08-03T08:30');
  const requiredFinal = scheduledTask('diagnostic-required-final-order', 1, 'BLUE', '2026-08-03T09:00');
  const unrelated = scheduledTask('diagnostic-required-final-unrelated', 1, 'YELLOW', '2026-08-03T10:00');
  const fixed = scheduledTask(
    'diagnostic-required-final-boundary', 1, 'ORANGE', '2026-08-03T12:00',
    '2026-08-03T12:00', '2026-08-03T13:00',
  );
  const setup = setupTruth({ overrides: [
    { id: 'diagnostic-required-final-boundary-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: requiredFinal.id, successor_order_id: fixed.id,
      predecessor_state_key: setupState('BLUE'), successor_state_key: setupState('ORANGE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'required final fixture' },
    { id: 'diagnostic-required-final-chain', machine: 'L1', signature_version: 1,
      predecessor_order_id: predecessor.id, successor_order_id: requiredFinal.id,
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'required final fixture' },
  ] });
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([predecessor, requiredFinal, unrelated, fixed], { firmedIds: [fixed.id] }),
    dueDateBounds(setup, { exactSearchThreshold: 0 }),
  );

  assert.equal(result.diagnostics.termination, 'converged',
    'a greedy fragment that cannot place its required final adjacency is not exact completion');
  assert.equal(result.diagnostics.quality, 'heuristic');
  assert.equal(result.diagnostics.exhaustive, false);
});

test('setup-aware respectCalendar controls blackout placement for production and setup', () => {
  const waiting = scheduledTask('contract-calendar-order', 2, 'GREEN', '2026-08-03T18:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'GREEN', 0)] });
  const snapshot = setupSnapshot([waiting]);
  snapshot.blocks = [{
    id: 'contract-calendar-blackout', line: 'L1',
    start: at('2026-08-03T09:00'), end: at('2026-08-03T10:00'),
  }];

  const respecting = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, {
    respectCalendar: true,
    horizonEnd: at('2026-08-03T12:00'),
  }));
  const ignoring = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, {
    respectCalendar: false,
    horizonEnd: at('2026-08-03T12:00'),
  }));

  assert.equal(+patchFor(respecting, 'contract-calendar-order').changes.start_date, +at('2026-08-03T10:00'),
    'calendar-respecting placement must avoid the blackout');
  assert.equal(+patchFor(ignoring, 'contract-calendar-order').changes.start_date, +at('2026-08-03T08:00'),
    'calendar-neutral placement must use continuous capacity');
  assert.equal(ignoring.diagnostics.respectCalendar, false);
});

test('setup-aware diagnostics expose a global budget and heuristic quality', () => {
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('contract-diagnostics-order', 1, 'GREEN', '2026-08-03T18:00')]),
    dueDateBounds(setupTruth()),
  );

  assert.equal(typeof result.diagnostics.budgetMs, 'number');
  assert.equal(typeof result.diagnostics.deadlineAt, 'number');
  assert.equal(typeof result.diagnostics.iterationsUsed, 'number');
  assert.equal(typeof result.diagnostics.exhaustive, 'boolean');
  assert.ok(['exact', 'heuristic'].includes(result.diagnostics.quality));
});

test('heuristic no-fit dispositions use an incomplete-search reason', () => {
  const fixed = scheduledTask('diagnostic-full-day', 10, 'GREEN', '2026-08-03T18:00', '2026-08-03T08:00', '2026-08-03T18:00');
  const waiting = scheduledTask('diagnostic-waiting', 1, 'GREEN', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([fixed, waiting], { firmedIds: ['diagnostic-full-day'] }),
    dueDateBounds(setupTruth({ rows: [setupRow('GREEN', 'GREEN', 0)] }), { exactSearchThreshold: 0 }),
  );

  assert.equal(result.diagnostics.quality, 'heuristic');
  assert.equal(result.diagnostics.exhaustive, false);
  assert.equal(result.diagnostics.termination, 'converged',
    'a bounded greedy search must converge even when no candidate wins');
  assert.equal(result.dispositions.find(disposition => disposition.id === 'diagnostic-waiting').reason.code, 'search_incomplete',
    'a heuristic search cannot prove that no alternate legal sequence exists');
});

test('greedy and SPT no-winner searches report converged heuristic termination', () => {
  const first = scheduledTask('diagnostic-no-winner-first', 1, 'RED', '2026-08-03T18:00');
  const second = scheduledTask('diagnostic-no-winner-second', 1, 'BLUE', '2026-08-03T18:00');
  const third = scheduledTask('diagnostic-no-winner-third', 1, 'YELLOW', '2026-08-03T18:00');
  const snapshot = setupSnapshot([first, second, third]);
  const setup = setupTruth({ overrides: [
    { id: 'diagnostic-conflicting-override-one', machine: 'L1', signature_version: 1,
      predecessor_order_id: first.id, successor_order_id: second.id,
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'conflicting fixture one' },
    { id: 'diagnostic-conflicting-override-two', machine: 'L1', signature_version: 1,
      predecessor_order_id: first.id, successor_order_id: third.id,
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('YELLOW'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'conflicting fixture two' },
  ] });
  const bounds = dueDateBounds(setup, { exactSearchThreshold: 0 });

  const dueDate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date');
  const spt = SetupScheduler.evaluateSptWithSetup(snapshot, bounds);
  for (const [mode, result] of [['greedy', dueDate], ['spt', spt]]) {
    assert.equal(result.diagnostics.termination, 'converged', `${mode} no-winner search should converge`);
    assert.equal(result.diagnostics.quality, 'heuristic', `${mode} remains heuristic`);
    assert.equal(result.diagnostics.exhaustive, false, `${mode} cannot claim exhaustive completion`);
    assert.ok(result.patches.every(patch => patch.changes.planning_status === 'needs_planning'),
      `${mode} fixture intentionally has no scheduled winner`);
  }
});

test('setup-aware heuristic modes use deterministic seeds and bounded local search', () => {
  const colors = ['RED', 'BLUE', 'YELLOW', 'BLACK', 'WHITE', 'ORANGE', 'PURPLE', 'TEAL'];
  const tasks = colors.map((color, index) => scheduledTask(
    `quality-${index + 1}`,
    index % 3 + 1,
    color,
    `2026-08-03T${18 - index}:00`,
  ));
  const snapshot = setupSnapshot(tasks);
  const setup = setupTruth();
  const bounds = dueDateBounds(setup, {
    exactSearchThreshold: 0,
    iterationCap: 1000,
    convergenceWindow: 1000,
  });

  const dueDate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date');
  const spt = SetupScheduler.evaluateSptWithSetup(snapshot, bounds);
  const minChangeover = SetupScheduler.evaluateMinChangeover(snapshot, bounds);

  for (const [name, result] of [['Due Date', dueDate], ['SPT', spt], ['Min Changeover', minChangeover]]) {
    assert.ok((result.diagnostics.seedCount ?? 0) >= 3, `${name} should report its deterministic seed set`);
    assert.ok((result.diagnostics.localMoveCount ?? 0) > 0, `${name} should report bounded local moves`);
  }
  assert.equal(dueDate.diagnostics.termination, 'converged',
    'a bounded greedy search must report convergence rather than exact completion');
  assert.equal(dueDate.searchComplete, false,
    'heuristic convergence cannot claim exhaustive search completeness');

  const repeat = SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date');
  assert.deepEqual(
    repeat.patches.map(patch => [patch.id, patch.changes.start_date?.getTime(), patch.changes.end_date?.getTime()]),
    dueDate.patches.map(patch => [patch.id, patch.changes.start_date?.getTime(), patch.changes.end_date?.getTime()]),
    'mode-specific seed ordering must remain deterministic',
  );
});

test('canonical Min Changeover objectives prefer covered edges before setup savings', () => {
  const base = {
    hardErrors: 0, overCap: 0, lateCount: 0, latenessMinutes: 0,
    setupMinutes: 0, scheduledCount: 2, instabilityMinutes: 0,
    policyKey: '00', sequenceKey: 'A|B',
  };
  const covered = { ...base, uncoveredEdges: 0, setupMinutes: 20 };
  const uncovered = { ...base, uncoveredEdges: 1, setupMinutes: 0 };

  assert.ok(SetupScheduler.compareObjectiveFacts(covered, uncovered, 'min-changeover') < 0,
    'Min Changeover must not trade a known uncovered edge for setup-minute savings');
});

test('canonical SPT objectives protect coverage before productive-runtime order', () => {
  const base = {
    hardErrors: 0, overCap: 0, lateCount: 0, latenessMinutes: 0,
    setupMinutes: 0, scheduledCount: 2, instabilityMinutes: 0,
    policyKey: '', sequenceKey: '', productiveRuntimeMinutes: 2,
  };
  const covered = { ...base, uncoveredEdges: 0, productiveRuntimeKey: '0000000000000002|0000000000000002' };
  const uncovered = { ...base, uncoveredEdges: 1, productiveRuntimeKey: '0000000000000001|0000000000000002' };
  assert.ok(SetupScheduler.compareObjectiveFacts(covered, uncovered, 'spt') < 0,
    'SPT must compare final coverage before its runtime ordering metric');

  const sameCoverageShortFirst = { ...base, uncoveredEdges: 0, productiveRuntimeKey: '0000000000000001|0000000000000002' };
  assert.ok(SetupScheduler.compareObjectiveFacts(sameCoverageShortFirst, covered, 'spt') < 0,
    'SPT must retain productive-runtime ordering after hard feasibility and coverage');
});

test('objective facts prefer the smaller worst-case lateness when late count and total lateness tie', () => {
  const base = {
    hardErrors: 0, overCap: 0, lateCount: 2, latenessMinutes: 120, uncoveredEdges: 0,
    setupMinutes: 0, scheduledCount: 2, instabilityMinutes: 0, policyKey: '00', sequenceKey: 'A|B',
  };
  const balanced = { ...base, maxLatenessMinutes: 60 };
  const lopsided = { ...base, maxLatenessMinutes: 110 };
  for (const mode of ['due-date-first', 'due-date', 'min-changeover', 'spt', 'throughput']) {
    assert.ok(SetupScheduler.compareObjectiveFacts(balanced, lopsided, mode) < 0,
      `${mode} must rank worst-case lateness immediately after total lateness`);
  }
  // Legacy facts without the field compare as 0 — never NaN.
  assert.equal(SetupScheduler.compareObjectiveFacts(base, base, 'due-date'), 0);
});

test('final setup-aware results expose canonical objective facts and compatible score slots', () => {
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('contract-objective-order', 1, 'GREEN', '2026-08-03T18:00')]),
    dueDateBounds(setupTruth()),
  );

  assert.equal(typeof result.objective?.uncoveredEdges, 'number');
  assert.equal(result.score[6], result.objective?.uncoveredEdges);
  assert.equal(result.score[7], result.objective?.overCap);
  assert.equal(result.score[2], result.objective?.lateCount);
  assert.equal(result.score[5], result.objective?.setupMinutes);
});

test('setup-aware placement uses placementStart when planningStart is in the past', () => {
  const waiting = scheduledTask('contract-past-planning-start', 1, 'GREEN', '2026-08-03T18:00');
  const setup = setupTruth();
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([waiting]),
    dueDateBounds(setup, {
      now: at('2026-08-03T08:00'),
      planningStart: at('2026-08-03T06:00'),
      runNow: at('2026-08-03T10:00'),
      horizonEnd: at('2026-08-03T18:00'),
    }),
  );

  assert.ok(patchFor(result, 'contract-past-planning-start'));
  assert.ok(patchFor(result, 'contract-past-planning-start').changes.start_date >= at('2026-08-03T10:00'),
    'a past planning window must never backdate a new placement before runNow');
});

test('setup-aware eligibility leaves a scheduled order wholly beyond the horizon unchanged', () => {
  const inWindow = scheduledTask('contract-horizon-in-window', 1, 'GREEN', '2026-08-03T18:00');
  const outside = scheduledTask(
    'contract-horizon-outside', 1, 'GREEN', '2026-08-03T18:00',
    '2026-08-03T13:00', '2026-08-03T14:00',
  );
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([outside, inWindow]),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T12:00') }),
  );

  assert.equal(result.dispositions.some(disposition => disposition.id === 'contract-horizon-outside'), false,
    'wholly out-of-window scheduled work is outside optimizer accounting');
  assert.equal(patchFor(result, 'contract-horizon-outside'), undefined,
    'wholly out-of-window scheduled work must remain unchanged');
  assert.ok(patchFor(result, 'contract-horizon-in-window'));
});

test('setup-aware eligibility keeps out-of-window firmed work as occupancy only', () => {
  const outside = scheduledTask(
    'contract-horizon-firmed-boundary', 1, 'GREEN', '2026-08-03T18:00',
    '2026-08-03T13:00', '2026-08-03T14:00',
  );
  const inWindow = scheduledTask('contract-horizon-mutable', 1, 'GREEN', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([outside, inWindow], { firmedIds: [outside.id] }),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T12:00') }),
  );

  assert.equal(result.dispositions.some(disposition => disposition.id === outside.id), false,
    'a protected boundary outside the planning horizon must not receive a disposition');
  assert.equal(patchFor(result, outside.id), undefined,
    'a protected boundary must remain immutable');
  assert.equal(result.diagnostics.placedCount, 1,
    'final placement counts must describe mutable scope only');
  assert.equal(result.objective?.scheduledCount, 1,
    'objective facts must exclude occupancy-only boundary work');
});

test('needs-planning status admits stale malformed dates as queue demand', () => {
  const stale = {
    ...scheduledTask(
      'contract-queued-stale-interval', 1, 'GREEN', '2026-08-03T18:00',
      '2026-08-03T12:00', '2026-08-03T11:00',
    ),
    planning_status: 'needs_planning',
    planning_reason: { code: 'stale_interval', message: 'stale imported dates' },
  };
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([stale]),
    dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-03T18:00') }),
  );

  assert.ok(result.dispositions.some(disposition => disposition.id === stale.id),
    'explicit queue status must be admitted before scheduled interval validation');
  assert.ok(patchFor(result, stale.id),
    'queued demand with stale dates should be normalized and placed when capacity exists');
});

test('setup-aware eligibility scopes malformed historical work before repair eligibility', () => {
  const malformedPast = scheduledTask(
    'contract-malformed-past', 2, 'GREEN', '2026-08-03T18:00',
    '2026-08-02T08:00', '2026-08-02T09:00',
  );
  const inWindow = scheduledTask('contract-malformed-in-window', 2, 'GREEN', '2026-08-03T18:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([malformedPast, inWindow]),
    dueDateBounds(setupTruth(), {
      planningStart: at('2026-08-03T08:00'),
      now: at('2026-08-03T08:00'),
      horizonEnd: at('2026-08-04T18:00'),
    }),
  );

  assert.equal(result.dispositions.some(disposition => disposition.id === 'contract-malformed-past'), false,
    'a malformed interval wholly before the half-open planning scope is immutable historical data');
  assert.equal(patchFor(result, 'contract-malformed-past'), undefined);
  assert.ok(result.dispositions.some(disposition => disposition.id === 'contract-malformed-in-window'),
    'a malformed order inside the scope remains eligible for repair');
});

test('final diagnostics do not count a protected schedule with an invalid boundary as placed', () => {
  const malformedProtected = scheduledTask(
    'contract-malformed-protected', 1, 'GREEN', '2026-08-03T18:00',
    '2026-08-03T10:00', 'not-a-date',
  );
  const reversedProtected = scheduledTask(
    'contract-reversed-protected', 1, 'GREEN', '2026-08-03T18:00',
    '2026-08-03T12:00', '2026-08-03T11:00',
  );
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([malformedProtected, reversedProtected], {
      firmedIds: [malformedProtected.id, reversedProtected.id],
    }),
    dueDateBounds(setupTruth()),
  );

  assert.equal(result.dispositions.find(disposition => disposition.id === malformedProtected.id)?.status, 'protected');
  assert.equal(result.diagnostics.placedCount, 0,
    'placedCount must describe valid final intervals, including protected boundaries');
  assert.equal(result.objective?.scheduledCount, 0,
    'objective scheduledCount must exclude reversed final intervals too');
});

test('setup-aware firming follows the effective firmed id set instead of a stale task mirror', () => {
  const staleMirror = { ...scheduledTask(
    'contract-stale-firmed-mirror', 1, 'GREEN', '2026-08-03T18:00',
    '2026-08-03T10:00', '2026-08-03T11:00',
  ), firmed: true };
  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([staleMirror], { firmedIds: [] }),
    dueDateBounds(setupTruth()),
  );

  assert.equal(result.dispositions.find(disposition => disposition.id === 'contract-stale-firmed-mirror')?.status, 'scheduled',
    'task.firmed is only a stale Store mirror and must not override the caller effective set');
});

test('final objective recomputes known uncovered transitions from the final schedule', () => {
  const first = scheduledTask('contract-final-edge-red', 1, 'RED', '2026-08-03T18:00', '2026-08-03T08:00', '2026-08-03T09:00');
  const second = scheduledTask('contract-final-edge-blue', 1, 'BLUE', '2026-08-03T18:00', '2026-08-03T09:00', '2026-08-03T10:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0)] });
  const snapshot = setupSnapshot([first, second]);
  const bounds = dueDateBounds(setup, { respectCalendar: false });
  const facts = SetupScheduler.objectiveFactsForCandidate(snapshot, bounds, {
    patches: [], score: [0, 0, 0, 0, 0, 0, 0, 0], explanation: [],
    diagnostics: { candidateCount: 1, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 0, limitReached: false, events: [] },
    unchangedLines: [], missingEdges: [],
  });

  assert.equal(facts.uncoveredEdges, 1,
    'rejected alternative diagnostics must not decide the final uncovered-edge objective');
});

test('setup-aware evaluators return a structured invalid_horizon result', () => {
  const snapshot = setupSnapshot([scheduledTask('contract-invalid-horizon', 1, 'GREEN', '2026-08-03T18:00')]);
  const setup = setupTruth();
  const bounds = dueDateBounds(setup, {
    planningStart: at('2026-08-03T12:00'),
    runNow: at('2026-08-03T12:00'),
    horizonEnd: at('2026-08-03T11:00'),
  });

  for (const result of [
    SetupScheduler.evaluateDueDateFirst(snapshot, bounds),
    SetupScheduler.evaluateSptWithSetup(snapshot, bounds),
    SetupScheduler.evaluateMinChangeover(snapshot, bounds),
    SetupScheduler.evaluateThroughput(snapshot, bounds, { throughputMinSavingsMin: 0, throughputMaxSlipMin: 1440 }),
  ]) {
    assert.equal(result.status, 'invalid_horizon');
    assert.deepEqual(result.patches, []);
    assert.equal(result.diagnostics.termination, 'infeasible');
    assert.equal(result.explanation[0].code, 'invalid_horizon');
  }
});

test('gap fill finds unused capacity after search expires without moving accepted production', () => {
  const fixed = scheduledTask('accepted', 1, 'GREEN', '2026-08-03T18:00', '2026-08-03T12:00', '2026-08-03T13:00');
  const waiting = scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00');
  const { snapshot, bounds, candidate } = gapFillFixture([fixed, waiting]);
  assert.equal(candidate.dispositions.find(d => d.id === 'waiting').status, 'needs_planning');
  assert.equal(typeof SetupScheduler.fillPlanningGaps, 'function');
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  const final = SetupScheduler.applyPatchesToSnapshot(snapshot.tasks, result.patches);
  assert.equal(+final.find(t => t.id === 'accepted').start_date, +fixed.start_date);
  assert.equal(+final.find(t => t.id === 'waiting').start_date, +at('2026-08-03T08:00'));
  assert.equal(result.gapFill.complete, true);
  assert.equal(result.gapFill.placed, 1);
  assert.equal(result.unchangedLines.includes('L1'), false, 'recovered lines must not still be reported as guarded/unchanged');
  assert.equal(result.score[4], -2);
  assert.equal(result.searchComplete, false, 'capacity completion is separate from sequence search');
  assert.equal(result.diagnostics.placedCount, 2, 'placed count reflects the final post-gap schedule');
  assert.equal(result.diagnostics.unknownTailCount, 0, 'unknown-tail count reflects final scheduled state');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('gap fill reserves setup on both sides and reports a completed no-fit check', () => {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 60), setupRow('RED', 'BLUE', 60), setupRow('GREEN', 'BLUE', 0)] });
  const fixed = scheduledTask('accepted', 1, 'BLUE', '2026-08-03T18:00', '2026-08-03T11:00', '2026-08-03T12:00');
  const waiting = scheduledTask('waiting', 2, 'RED', '2026-08-03T18:00');
  const { snapshot, bounds, candidate } = gapFillFixture([fixed, waiting], setup, { horizonEnd: at('2026-08-03T12:00') });
  assert.equal(typeof SetupScheduler.fillPlanningGaps, 'function');
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.complete, true);
  assert.equal(result.gapFill.placed, 0);
  assert.equal(result.dispositions.find(d => d.id === 'waiting').reason.code, 'no_fit_found');
});

test('gap fill has a separate budget and labels unchecked orders when it expires', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00')]);
  assert.equal(typeof SetupScheduler.fillPlanningGaps, 'function');
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate, 0);
  assert.equal(result.gapFill.complete, false);
  assert.equal(result.gapFill.unchecked, 1);
  assert.match(result.dispositions[0].reason.message, /Capacity check incomplete/);
  assert.match(result.dispositions[0].reason.message, /Tick Run in background/);
  assert.equal(result.patches[0].changes.start_date, null);
});

test('gap fill on an exhaustive run does not tell the planner to run in the background', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00')]);
  const result = SetupScheduler.fillPlanningGaps(snapshot, { ...bounds, exhaustive: true }, candidate, 0);
  assert.equal(result.dispositions[0].reason.code, 'search_limit');
  assert.match(result.dispositions[0].reason.message, /Capacity check incomplete/);
  assert.doesNotMatch(result.dispositions[0].reason.message, /Run in background/);
});

test('VI10: fillPlanningGaps with a zero budget keeps overlong_never for an overlong order on a never plant', () => {
  const snapshot = setupSnapshot([scheduledTask('vi10', 12, 'RED', '2026-08-03T18:00:00')]);   // windows are 10 h
  snapshot.calendars = { L1: { workHours: OPEN_HOURS } };
  snapshot.plants = { P1: { workHours: OPEN_HOURS } };
  const bounds = dueDateBounds(setupTruth({ current: null, definition: null }), { placementStart: at('2026-08-03T08:00:00'), horizonEnd: at('2026-08-10T18:00:00') });
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds, 'due-date');
  assert.equal(candidate.dispositions.find(d => d.id === 'vi10').reason.code, 'overlong_never');
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate, 0);
  assert.equal(result.gapFill.complete, false, 'the budget did expire');
  assert.equal(result.dispositions.find(d => d.id === 'vi10').reason.code, 'overlong_never', 'an overlong order is a calendar fact, not a search result');
});

test('gap fill runs through the shared engine adapter for all three hard-bound strategies', () => {
  for (const mode of ['due-date', 'spt', 'min-changeover']) {
    const { snapshot, bounds } = gapFillFixture([scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00')], { ...setupTruth(), plant_active: true });
    const result = Engine.evaluateSetupAware(mode, bounds, snapshot);
    assert.equal(result.dispositions[0].status, 'scheduled', mode);
    assert.equal(result.gapFill.complete, true, mode);
  }
});

test('gap fill retries an urgent order after a new setup bridge makes it fit', () => {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 240), setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0)] });
  const urgent = scheduledTask('urgent', 1, 'RED', '2026-08-03T10:00');
  const bridge = scheduledTask('bridge', 1, 'BLUE', '2026-08-03T11:00');
  const { snapshot, bounds, candidate } = gapFillFixture([urgent, bridge], setup, { horizonEnd: at('2026-08-03T11:00') });
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.placed, 2);
  assert.equal(result.gapFill.complete, true);
  assert.equal(+patchFor(result, 'bridge').changes.start_date, +at('2026-08-03T08:00'));
  assert.equal(+patchFor(result, 'urgent').changes.start_date, +at('2026-08-03T09:00'));
  assert.equal(result.score[5], 0);
});

test('gap fill enforces floors, ceilings, blackouts and whole-order split policy', () => {
  const waiting = scheduledTask('waiting', 2, 'GREEN', '2026-08-03T18:00');
  const { snapshot, bounds, candidate } = gapFillFixture([waiting], setupTruth(), {
    notBefore: () => at('2026-08-03T10:00'), notAfter: () => at('2026-08-03T13:00'),
  });
  snapshot.blocks = [{ id: 'break', line: 'L1', start: at('2026-08-03T11:00'), end: at('2026-08-03T12:00') }];
  const noSplit = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(noSplit.gapFill.placed, 0);
  snapshot.masterData.plants[0].split_order_policy = 'partial_allowed';
  const split = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  const patch = patchFor(split, 'waiting');
  assert.equal(split.gapFill.placed, 1);
  assert.equal(+patch.changes.start_date, +at('2026-08-03T10:00'));
  assert.equal(+patch.changes.end_date, +at('2026-08-03T13:00'));
  assert.equal(patch.changes.scheduleSegments.length, 2);
  assert.equal(split.validationFindings.some(f => f.severity === 'error'), false);
});

test('gap fill uses missing transitions as zero setup with separate warning and clean bound counts', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([scheduledTask('waiting', 1, 'RED', '2026-08-03T18:00')]);
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.placed, 1);
  assert.ok(result.validationFindings.some(f => f.code === 'missing_setup'));
  assert.equal(result.score[7], 0, 'hard completion violations');
  assert.equal(result.score[6], 1, 'uncovered setup transitions');
});

test('gap fill keeps successful insertions when its shared budget expires on another line', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([
    scheduledTask('first', 1, 'GREEN', '2026-08-03T10:00'),
    { ...scheduledTask('second', 1, 'GREEN', '2026-08-03T12:00'), MACHINE: 'L2' },
  ]);
  // Calls are entry, loop, gap, next-loop: expiration follows one validated addition.
  let ticks = 0;
  const result = SetupScheduler.fillPlanningGaps(snapshot, { ...bounds, clock: () => ticks++ }, candidate, 3);
  assert.equal(result.gapFill.placed, 1);
  assert.equal(result.gapFill.unchecked, 1);
  assert.equal(result.dispositions.find(d => d.id === 'first').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'second').reason.code, 'search_limit');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('gap fill checks a fixed successor beyond the search horizon at its actual setup time', () => {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('RED', 'BLUE', 60)] });
  const fixed = scheduledTask('fixed', 1, 'BLUE', '2026-08-04T18:00', '2026-08-04T10:00', '2026-08-04T11:00');
  const waiting = scheduledTask('waiting', 10, 'RED', '2026-08-03T18:00');
  const snapshot = setupSnapshot([fixed, waiting], { firmedIds: ['fixed'] });
  const bounds = dueDateBounds(setup, { deadline: -2000 });
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.placed, 1);
  assert.equal(+patchFor(result, 'waiting').changes.end_date, +bounds.horizonEnd);
});

test('gap fill preserves overlapping protected reservations and their visible exceptions', () => {
  const fixed = scheduledTask('fixed', 2, 'GREEN', '2026-08-03T18:00', '2026-08-03T10:00', '2026-08-03T12:00');
  const overlap = scheduledTask('overlap', 2, 'GREEN', '2026-08-03T18:00', '2026-08-03T11:00', '2026-08-03T13:00');
  const waiting = scheduledTask('waiting', 4, 'GREEN', '2026-08-03T18:00');
  const snapshot = setupSnapshot([fixed, overlap, waiting], { firmedIds: ['fixed', 'overlap'] });
  const bounds = dueDateBounds(setupTruth(), { deadline: -2000 });
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, SetupScheduler.evaluateDueDateFirst(snapshot, bounds));
  assert.equal(+patchFor(result, 'waiting').changes.start_date, +at('2026-08-03T13:00'));
  assert.ok(result.validationFindings.some(f => f.code === 'capacity_overlap' && f.severity === 'warning'));
  assert.equal(result.patches.some(p => p.id === 'fixed' || p.id === 'overlap'), false);
});

test('gap fill cannot create a setup-floor violation on a protected successor', () => {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('RED', 'BLUE', 60)] });
  const fixed = scheduledTask('fixed', 1, 'BLUE', '2026-08-03T18:00', '2026-08-03T11:00', '2026-08-03T12:00');
  const waiting = scheduledTask('waiting', 1, 'RED', '2026-08-03T18:00');
  const snapshot = setupSnapshot([fixed, waiting], { firmedIds: ['fixed'] });
  const bounds = dueDateBounds(setup, { deadline: -2000, horizonEnd: at('2026-08-03T12:00'), notBefore: t => t.id === 'fixed' ? at('2026-08-03T11:00') : null });
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, SetupScheduler.evaluateDueDateFirst(snapshot, bounds));
  assert.equal(result.gapFill.placed, 0);
  assert.equal(result.validationFindings.some(f => f.code === 'setup_floor'), false);
});

test('gap fill uses machine-specific priorities when queued orders compete for a gap', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([
    scheduledTask('a-green', 1, 'GREEN', '2026-08-03T18:00'),
    scheduledTask('z-red', 1, 'RED', '2026-08-03T18:00'),
  ], setupTruth(), { horizonEnd: at('2026-08-03T09:00') });
  snapshot.priorityRankMaps = { '': { colorWheel: { GREEN: 0, RED: 1 } }, L1: { colorWheel: { RED: 0, GREEN: 1 } } };
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.dispositions.find(d => d.id === 'z-red').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'a-green').status, 'needs_planning');
});

test('gap fill cannot break an active override between accepted orders', () => {
  const setup = setupTruth({ overrides: [{ id: 'pair', machine: 'L1', signature_version: 1,
    predecessor_order_id: 'first', successor_order_id: 'next',
    predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('BLUE'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'bound pair',
  }] });
  const { snapshot, bounds, candidate } = gapFillFixture([
    scheduledTask('first', 1, 'GREEN', '2026-08-03T18:00', '2026-08-03T08:00', '2026-08-03T09:00'),
    scheduledTask('next', 1, 'BLUE', '2026-08-03T18:00', '2026-08-03T11:00', '2026-08-03T12:00'),
    scheduledTask('waiting', 1, 'RED', '2026-08-03T18:00'),
  ], setup, { horizonEnd: at('2026-08-03T12:00') });
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.placed, 0);
  assert.equal(result.gapFill.complete, true);
});

test('gap fill leaves hard planning defects intact and respects selected lines', () => {
  const { snapshot, bounds } = gapFillFixture([
    scheduledTask('missing-due', 1, 'GREEN', null),
    scheduledTask('runtime', 0, 'GREEN', '2026-08-03T18:00'),
    scheduledTask('expired', 1, 'GREEN', '2026-08-02T18:00'),
    { ...scheduledTask('excluded', 1, 'GREEN', '2026-08-03T18:00'), MACHINE: 'L2' },
  ], setupTruth(), { lines: ['L1'] });
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.deepEqual(result.dispositions.map(d => d.reason.code), ['missing_due_date', 'invalid_runtime', 'expired_window']);
  assert.equal(result.patches.some(p => p.id === 'excluded'), false);
  assert.equal(result.gapFill.unchecked, 0);
});

test('gap fill clears the unchanged-line notice after recovering an unknown-setup tail', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00')], setupTruth({ definition: null }));
  assert.equal(candidate.unchangedLines.includes('L1'), true);
  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);
  assert.equal(result.gapFill.placed, 1);
  assert.equal(result.unchangedLines.includes('L1'), false);
});

test('placeWithSetup applies never, overlong_only, and partial_allowed without short productive pieces', () => {
  // This fails if Stage 1 never adds the pure placement primitive, or if a
  // policy starts splitting ordinary work / emits a sub-30-minute piece.
  assert.equal(typeof SetupScheduler.placeWithSetup, 'function');

  const windows = [
    interval('2026-08-12T08:00', '2026-08-12T10:00'),
    interval('2026-08-13T08:00', '2026-08-13T10:00'),
  ];
  const base = {
    earliestStart: at('2026-08-12T08:00'),
    runtimeMinutes: 150,
    setup: resolvedSetup(20),
    freeIntervals: windows,
  };

  const never = SetupScheduler.placeWithSetup({ ...base, policy: 'never' });
  assert.equal(never.kind, 'infeasible');
  assert.equal(never.reason, 'no-feasible-capacity');

  const ordinary = SetupScheduler.placeWithSetup({
    ...base, policy: 'overlong_only', isInherentlyOverlong: false,
  });
  assert.equal(ordinary.kind, 'infeasible', 'an ordinary order must remain whole under overlong_only');

  const overlong = SetupScheduler.placeWithSetup({
    ...base, policy: 'overlong_only', isInherentlyOverlong: true,
  });
  assert.equal(overlong.kind, 'placed');
  assert.equal(overlong.setup.minutes, 20);
  assert.deepEqual(segmentMinutes(overlong), [100, 50]);
  assert.ok(segmentMinutes(overlong).every(minutes => minutes >= 30));

  const partial = SetupScheduler.placeWithSetup({ ...base, policy: 'partial_allowed' });
  assert.equal(partial.kind, 'placed');
  assert.deepEqual(segmentMinutes(partial), [100, 50]);

  const coveredZero = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-12T11:00'), runtimeMinutes: 30,
    setup: resolvedSetup(0), policy: 'never',
    freeIntervals: [interval('2026-08-12T11:00', '2026-08-12T11:30')],
  });
  assert.equal(coveredZero.kind, 'placed');
  assert.equal(Object.hasOwn(coveredZero, 'setup'), false,
    'covered zero setup is omitted instead of becoming a zero-length pseudo-order');

  const completeShort = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-12T12:00'),
    runtimeMinutes: 20,
    setup: resolvedSetup(20),
    policy: 'partial_allowed',
    freeIntervals: [interval('2026-08-12T12:00', '2026-08-12T12:40')],
  });
  assert.equal(completeShort.kind, 'placed');
  assert.deepEqual(segmentMinutes(completeShort), [20],
    'a complete under-30-minute order remains legal only when it is unsplit');
});

test('placeWithSetup respects a non-default configured productive-segment floor (B3)', () => {
  // Two 20-minute windows: neither alone meets the hardcoded 30-minute
  // default, but together (20+15) they satisfy a plant-configured 15-minute
  // floor. This fails if minProductiveSegmentMinutes threading is incomplete
  // and the request field is silently ignored in favor of the module default.
  const windows = [
    interval('2026-08-12T08:00', '2026-08-12T08:20'),
    interval('2026-08-13T08:00', '2026-08-13T08:20'),
  ];
  const base = {
    earliestStart: at('2026-08-12T08:00'),
    runtimeMinutes: 35,
    setup: resolvedSetup(0),
    policy: 'partial_allowed',
    freeIntervals: windows,
  };

  const underDefaultFloor = SetupScheduler.placeWithSetup(base);
  assert.equal(underDefaultFloor.kind, 'infeasible',
    'neither 20-minute window alone meets the hardcoded 30-minute default floor');

  const withConfiguredFloor = SetupScheduler.placeWithSetup({ ...base, minProductiveSegmentMinutes: 15 });
  assert.equal(withConfiguredFloor.kind, 'placed');
  assert.deepEqual(segmentMinutes(withConfiguredFloor), [20, 15],
    'a plant-configured 15-minute floor allows a productive piece the default 30-minute floor would reject');
});

test('Min Changeover stays detached and reports its due-safe setup savings decision', () => {
  const red = scheduledTask('red-due', 1, 'RED', '2026-08-03T09:30:00');
  const blue = scheduledTask('blue-future', 1, 'BLUE', '2026-08-03T13:00:00');
  const red2 = scheduledTask('red-future', 1, 'RED', '2026-08-03T13:00:00');
  const snapshot = setupSnapshot([red, blue, red2]);
  const result = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setupTruth({
    current: 'GREEN', rows: [
      setupRow('GREEN', 'RED', 20), setupRow('GREEN', 'BLUE', 20),
      setupRow('RED', 'BLUE', 60), setupRow('BLUE', 'RED', 60),
    ],
  })));
  assert.ok(result.explanation.some(reason => reason.code === 'min-changeover-selected'));
  assert.equal(snapshot.tasks[0].start_date, null, 'policy evaluation never mutates the snapshot');
});

test('Throughput rejects policy candidates that do not meet the explicit savings threshold', () => {
  const red = scheduledTask('throughput-red', 1, 'RED', '2026-08-03T12:00:00');
  const snapshot = setupSnapshot([red]);
  const result = SetupScheduler.evaluateThroughput(snapshot, dueDateBounds(setupTruth({
    current: 'GREEN', rows: [setupRow('GREEN', 'RED', 20)],
  })), { throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440 });
  assert.ok(result.explanation.some(reason => reason.code === 'throughput-rejected-threshold'));
});

test('Throughput applies exact savings and per-order slip boundaries without mutating the snapshot', () => {
  // Regression target: a fleet-level average or an off-by-one comparison can
  // approve a 59-minute saving or a 1441-minute delay hidden beside a safe ID.
  const original = setupSnapshot([
    scheduledTask('slip-1439', 1, 'RED', '2026-08-05T12:00:00', '2026-08-03T08:00:00', '2026-08-03T09:00:00'),
    scheduledTask('slip-1440', 1, 'BLUE', '2026-08-05T12:00:00', '2026-08-03T09:00:00', '2026-08-03T10:00:00'),
    scheduledTask('slip-1441', 1, 'GREEN', '2026-08-05T12:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00'),
  ]);
  const before = structuredClone(original);
  const candidate = (setupMinutes, delays = []) => ({
    patches: delays.map(([id, minutes]) => ({
      id, changes: { end_date: new Date(original.tasks.find(task => task.id === id).end_date.getTime() + minutes * 60 * 1000) },
    })),
    score: [0, 0, 0, 0, 0, setupMinutes], explanation: [], missingEdges: [], unchangedLines: [],
    diagnostics: { candidateCount: 1, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 0, limitReached: false, events: [] },
  });
  const baseline = candidate(100);

  const below = SetupScheduler.selectThroughputCandidate(original, baseline, candidate(41), {
    throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440,
  });
  assert.ok(below.explanation.some(reason => reason.code === 'throughput-rejected-threshold'));

  const exactSavings = SetupScheduler.selectThroughputCandidate(original, baseline, candidate(40), {
    throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440,
  });
  assert.ok(exactSavings.explanation.some(reason => reason.code === 'throughput-accepted'));

  const exactCap = SetupScheduler.selectThroughputCandidate(original, baseline, candidate(40, [
    ['slip-1439', 1439], ['slip-1440', 1440],
  ]), { throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440 });
  assert.ok(exactCap.explanation.some(reason => reason.code === 'throughput-accepted'));

  const overCap = SetupScheduler.selectThroughputCandidate(original, baseline, candidate(40, [
    ['slip-1439', 1439], ['slip-1440', 1440], ['slip-1441', 1441],
  ]), { throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440 });
  const rejection = overCap.explanation.find(reason => reason.code === 'throughput-rejected-threshold');
  assert.match(rejection.message, /slip-1441 \(1441 min\)/);
  assert.doesNotMatch(rejection.message, /slip-1439|slip-1440/);
  assert.deepEqual(original, before, 'policy comparison must not mutate the snapshot before Apply');
});

test('placeWithSetup skips shift tails that fit setup alone or too little production', () => {
  // This fails if setup is placed by itself at shift end, shortened, or paired
  // with less than the fixed 30-minute productive minimum.
  assert.equal(typeof SetupScheduler.placeWithSetup, 'function');
  const result = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-12T08:00'),
    runtimeMinutes: 40,
    setup: resolvedSetup(20),
    policy: 'partial_allowed',
    freeIntervals: [
      interval('2026-08-12T08:00', '2026-08-12T08:20'), // setup only
      interval('2026-08-13T08:00', '2026-08-13T08:40'), // setup + 20 minutes
      interval('2026-08-14T08:00', '2026-08-14T09:00'),
    ],
  });

  assert.equal(result.kind, 'placed');
  assert.equal(+result.setup.start, +at('2026-08-14T08:00'));
  assert.equal(+result.setup.end, +at('2026-08-14T08:20'));
  assert.deepEqual(result.productiveSegments.map(segment => [segment.start, segment.end]), [
    [at('2026-08-14T08:20'), at('2026-08-14T09:00')],
  ]);
});

test('placeWithSetup preserves state through downtime, charges no setup on a continuation, and exposes unresolved state', () => {
  // This fails if an operating gap resets line state, a split continuation
  // gets another setup, or missing initial/transition truth is silently zeroed.
  assert.equal(typeof SetupScheduler.placeWithSetup, 'function');
  const continuousState = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-12T08:00'),
    runtimeMinutes: 80,
    setup: resolvedSetup(20),
    policy: 'partial_allowed',
    freeIntervals: [
      interval('2026-08-12T08:00', '2026-08-12T09:00'),
      interval('2026-08-13T08:00', '2026-08-13T09:00'),
    ],
  });
  assert.equal(continuousState.kind, 'placed');
  assert.equal(continuousState.setup.minutes, 20);
  assert.deepEqual(segmentMinutes(continuousState), [40, 40]);
  assert.equal(continuousState.setup.start.getTime(), at('2026-08-12T08:00').getTime(),
    'the one derived setup occurrence remains attached to the first productive segment');

  const intoIntervening = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-14T07:30'),
    runtimeMinutes: 30,
    setup: resolvedSetup(10),
    policy: 'partial_allowed',
    freeIntervals: [interval('2026-08-14T07:30', '2026-08-14T08:10')],
  });
  assert.equal(intoIntervening.kind, 'placed');
  assert.equal(intoIntervening.setup.minutes, 10,
    'an observed intervening order pays the transition into its own state');

  const backIntoOriginal = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-14T08:00'),
    runtimeMinutes: 30,
    setup: resolvedSetup(15),
    policy: 'partial_allowed',
    freeIntervals: [interval('2026-08-14T08:00', '2026-08-14T08:45')],
  });
  assert.equal(backIntoOriginal.kind, 'placed');
  assert.equal(backIntoOriginal.setup.minutes, 15,
    'a caller that observed an intervening predecessor receives a full return transition');

  const missingInitial = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-14T09:00'), runtimeMinutes: 30,
    setup: { kind: 'unresolved', reason: 'initial-state-unknown' },
    policy: 'partial_allowed', freeIntervals: [interval('2026-08-14T09:00', '2026-08-14T10:00')],
  });
  assert.equal(missingInitial.kind, 'infeasible');
  assert.equal(missingInitial.reason, 'initial-state-unknown');
  assert.equal(missingInitial.setup.kind, 'unresolved');
  assert.deepEqual(missingInitial.productiveSegments, []);

  const missingTransition = SetupScheduler.placeWithSetup({
    earliestStart: at('2026-08-14T10:00'), runtimeMinutes: 30,
    setup: { kind: 'unresolved', reason: 'transition-unresolved' },
    policy: 'partial_allowed', freeIntervals: [interval('2026-08-14T10:00', '2026-08-14T11:00')],
  });
  assert.equal(missingTransition.kind, 'infeasible');
  assert.equal(missingTransition.reason, 'transition-unresolved');
  assert.equal(missingTransition.setup.kind, 'unresolved');
});

test('evaluateSchedule produces detached SPT patches without publishing or mutating Store state', () => {
  // This fails if a candidate evaluator regresses to the old preview strategy:
  // routing a trial through Store.updateMany/restoreTasks would bump revision,
  // call subscribers, and replace the live task schedule before Apply.
  Store.setTasks([task('live', 9)], 'unit-test');
  Store.setSelectedPlant('P1', 'unit-test');
  Store.setFirmed('live', true, 'unit-test');
  Store.setAlerts([{ id: 'existing-alert', type: 'overlap', sev: 'err' }], 'unit-test');

  const beforeRevision = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const beforeFixedIds = Array.from(Store.firmedIds).sort();
  const beforeAlerts = structuredClone(Store.alerts);
  let published = 0;
  const unsubscribe = Store.subscribe(() => { published++; }, 'unit-test-autosave');

  try {
    const result = evaluateSchedule(legacySnapshot([task('long', 5), task('short', 1)]), {
      mode: 'spt',
      plant: 'P1',
      respectCalendar: false,
      now: new Date('2026-08-03T08:00:00'),
    });

    assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['short', 'long'],
      'the detached result retains setup-aware SPT productive-runtime ordering');
    assert.equal(scheduledPatches(result)[0].changes.start_date.getTime(), new Date('2026-08-03T08:00:00').getTime());
    assert.equal(Store.rev(), beforeRevision, 'candidate evaluation must not publish Store mutations');
    assert.deepEqual(Store.tasks, beforeTasks, 'candidate patches must not enter live task state');
    assert.deepEqual(Array.from(Store.firmedIds).sort(), beforeFixedIds, 'candidate evaluation must not alter fixed boundaries');
    assert.deepEqual(Store.alerts, beforeAlerts, 'candidate evaluation must not publish alerts');
    assert.equal(published, 0, 'candidate evaluation must not wake autosave-like subscribers');
  } finally {
    unsubscribe();
  }
});

test('evaluateSchedule keeps exhausted-calendar diagnostics in the candidate, not ErrorLog persistence', () => {
  // Removing the candidate diagnostic sink would reintroduce ErrorLog.error()
  // from Calendar.nextAvailable(), which persists a discarded trial.
  const closedHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, null]));
  const beforeEntries = ErrorLog.entries();
  const priorSave = ErrorLog._scheduleSave;
  const priorShip = ErrorLog._scheduleShip;
  let saveCalls = 0;
  let shipCalls = 0;
  ErrorLog._scheduleSave = () => { saveCalls++; };
  ErrorLog._scheduleShip = () => { shipCalls++; };

  try {
    const result = evaluateSchedule({
      ...legacySnapshot([task('closed-line-order', 1)]),
      calendars: { L1: { workHours: closedHours } },
      plants: { P1: { workHours: closedHours } },
    }, {
      mode: 'spt',
      plant: 'P1',
      respectCalendar: true,
      now: new Date('2026-08-03T08:00:00'),
    });

    assert.deepEqual(ErrorLog.entries(), beforeEntries,
      'a discarded candidate must not enter the persistent error log');
    assert.equal(saveCalls, 0, 'candidate diagnostics must not schedule IndexedDB persistence');
    assert.equal(shipCalls, 0, 'candidate diagnostics must not schedule backend error shipping');
    assert.equal(result.dispositions?.[0]?.reason?.code, 'no_fit_found',
      'the exhaustion reason remains structured on the detached candidate');
  } finally {
    ErrorLog._entries = beforeEntries;
    ErrorLog._scheduleSave = priorSave;
    ErrorLog._scheduleShip = priorShip;
  }
});

test('evaluateDueDateFirst uses explicit setup truth and charges setup before due-first production', () => {
  // This fails if Task 3 has not added the detached Due-date-first evaluator,
  // or if it bypasses the caller-supplied setup state/matrix and places
  // productive work before its required incoming setup capacity.
  assert.equal(typeof SetupScheduler.evaluateDueDateFirst, 'function');

  const early = {
    ...task('due-first-early', 1),
    COLOR: 'RED',
    original_end_date: at('2026-08-03T10:00:00'),
  };
  const later = {
    ...task('due-first-later', 1),
    COLOR: 'BLUE',
    original_end_date: at('2026-08-03T12:00:00'),
  };
  const openHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const definition = {
    plant: 'P1', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true,
  };
  const result = SetupScheduler.evaluateDueDateFirst({
    ...legacySnapshot([later, early]),
    calendars: { L1: { workHours: openHours } },
    plants: { P1: { workHours: openHours } },
  }, {
    setup: {
      plant: 'P1',
      definition,
      plant_rows: [
        { machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 20 },
        { machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 10 },
      ],
      machine_rows: [],
      machine_states: [{
        machine: 'L1', state_key: state('GREEN'), signature_version: 1,
        source: 'manual', reason: 'unit-test current state',
      }],
      overrides: [],
    },
    exactSearchThreshold: 4,
    iterationCap: 8,
    clock: () => 0,
    deadline: 1,
    now: at('2026-08-03T08:00:00'),
    horizonEnd: at('2026-08-03T18:00:00'),
  });

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['due-first-early', 'due-first-later']);
  assert.equal(scheduledPatches(result)[0].changes.start_date.getTime(), at('2026-08-03T08:20:00').getTime());
  assert.equal(scheduledPatches(result)[1].changes.start_date.getTime(), at('2026-08-03T09:30:00').getTime());
});

test('evaluateDueDateFirst never freezes an uncovered line: it tail-places the uncovered order while a covered line optimizes normally', () => {
  // Never-freeze semantics (A1/A2): a line whose only orders are behind
  // uncovered transitions is no longer left unchanged. The uncovered order
  // now stays IN the covered-core sequence (admitted at zero setup minutes,
  // grouped by signature) rather than being demoted to the tail, while an
  // unrelated covered line is unaffected.
  const uncovered = scheduledTask('uncovered-red', 1, 'RED', '2026-08-03T10:00:00');
  const covered = {
    ...scheduledTask('covered-blue', 1, 'BLUE', '2026-08-03T10:00:00'),
    MACHINE: 'L2',
  };
  const snapshot = setupSnapshot([uncovered, covered]);
  snapshot.calendars = {
    L1: { workHours: OPEN_HOURS },
    L2: { workHours: OPEN_HOURS },
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 10)] });
  setup.machine_states.push({
    machine: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'second line current state',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['covered-blue', 'uncovered-red']);
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(Object.hasOwn(patchFor(result, 'uncovered-red').changes, 'scheduleSegments'), true);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-without-setup' && reason.taskId === 'uncovered-red'
  )), 'the uncovered order is admitted into the covered sequence at zero setup minutes rather than freezing the line');
  // F1/F12: a tail-placed order must produce a 'scheduled-without-setup'
  // missingEdge (the only source both the live-run toast and OptimizerPreview's
  // scheduledWithoutSetup tally read from) — this regressed silently once
  // before because appendRejectedCoverageDiagnostics hard-filters everything
  // that isn't the uncovered-transition reason.
  assert.ok(result.missingEdges.some(edge => (
    edge.reason === 'scheduled-without-setup' && edge.successorOrderId === 'uncovered-red'
  )), 'the tail placement is reported via the dedicated scheduled-without-setup reason');
});

test('evaluateDueDateFirst preserves a fixed run while honoring its incoming and outgoing setup boundaries', () => {
  // This fails if fixed work is treated as movable/free, if the predecessor
  // does not leave its transition into the fixed state, or if the fixed state
  // is not used as the successor fragment's predecessor.
  const before = scheduledTask('free-before', 1, 'RED', '2026-08-03T09:00:00');
  const fixed = scheduledTask(
    'fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const after = scheduledTask('free-after', 1, 'RED', '2026-08-03T13:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 10),
    setupRow('RED', 'BLUE', 30),
    setupRow('BLUE', 'RED', 10),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([before, fixed, after], { firmedIds: ['fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'fixed-blue'), undefined, 'a fixed production run must never become a candidate patch');
  assert.equal(patchFor(result, 'free-before').changes.start_date.getTime(), at('2026-08-03T08:10:00').getTime());
  assert.equal(patchFor(result, 'free-before').changes.end_date.getTime(), at('2026-08-03T09:10:00').getTime());
  assert.equal(patchFor(result, 'free-after').changes.start_date.getTime(), at('2026-08-03T11:10:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst preserves a fixed production run and still patches free work when its incoming setup cannot fit', () => {
  // Never-freeze semantics (Part 1f): `incoming-firmed-setup-infeasible` skips
  // the reservation and keeps the candidate feasible instead of freezing the
  // whole line. The fixed run itself must still never receive a patch.
  const before = scheduledTask('too-late-before', 1, 'RED', '2026-08-03T09:00:00');
  const fixed = scheduledTask(
    'fixed-blue-tight', 1, 'BLUE', '2026-08-03T10:30:00', '2026-08-03T09:30:00', '2026-08-03T10:30:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 10),
    setupRow('RED', 'BLUE', 30),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([before, fixed], { firmedIds: ['fixed-blue-tight'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'fixed-blue-tight'), undefined, 'a fixed production run must never become a candidate patch');
  assert.equal(patchFor(result, 'too-late-before').changes.start_date.getTime(), at('2026-08-03T10:30:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst uses each next fixed order as the outgoing setup boundary', () => {
  // This fails if a free fragment after one fixed order is allowed to consume
  // the setup interval immediately required by the following fixed order.
  const firstFixed = scheduledTask(
    'first-fixed-blue', 1, 'BLUE', '2026-08-03T09:30:00', '2026-08-03T08:30:00', '2026-08-03T09:30:00',
  );
  const freeMiddle = scheduledTask('free-middle-red', 1, 'RED', '2026-08-03T10:00:00');
  const secondFixed = scheduledTask(
    'second-fixed-yellow', 1, 'YELLOW', '2026-08-03T12:15:00', '2026-08-03T11:15:00', '2026-08-03T12:15:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 10), setupRow('BLUE', 'RED', 10), setupRow('RED', 'YELLOW', 30),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([firstFixed, freeMiddle, secondFixed], { firmedIds: ['first-fixed-blue', 'second-fixed-yellow'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'free-middle-red').changes.start_date.getTime(), at('2026-08-03T09:40:00').getTime());
  assert.equal(patchFor(result, 'free-middle-red').changes.end_date.getTime(), at('2026-08-03T10:40:00').getTime());
  assert.equal(patchFor(result, 'first-fixed-blue'), undefined);
  assert.equal(patchFor(result, 'second-fixed-yellow'), undefined);
});

test('evaluateDueDateFirst protects an active occurrence override’s exact adjacency', () => {
  // This fails if an active RED -> BLUE override lets the optimizer prefer the
  // otherwise due-safer BLUE -> RED sequence, effectively making the override
  // follow BLUE to a new predecessor rather than protecting its real work.
  const red = scheduledTask('override-red', 1, 'RED', '2026-08-03T12:00:00');
  const blue = scheduledTask('override-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 10),
      setupRow('RED', 'BLUE', 20),
      setupRow('GREEN', 'BLUE', 0),
      setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'override-1', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'override-red', successor_order_id: 'override-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 20, remaining_min: 4, status: 'active', reason: 'crew already changed tooling',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red, blue]), dueDateBounds(setup));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['override-red', 'override-blue']);
  assert.equal(patchFor(result, 'override-blue').changes.start_date.getTime(), at('2026-08-03T09:14:00').getTime());
});

test('evaluateDueDateFirst reports an override inactive when its bound predecessor changes', () => {
  // This fails if a stale override is applied to BLUE after whichever order
  // happens to precede it, instead of becoming inactive when its saved order
  // binding no longer exists in the candidate sequence.
  const red = scheduledTask('bound-red', 1, 'RED', '2026-08-03T12:00:00');
  const blue = scheduledTask('bound-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 10), setupRow('RED', 'BLUE', 20),
      setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'stale-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-red', successor_order_id: 'bound-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 20, remaining_min: 4, status: 'active', reason: 'stale binding fixture',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red, blue]), dueDateBounds(setup));

  assert.deepEqual(scheduledPatches(result), []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.missingEdges.some(edge => (
    edge.successorOrderId === 'bound-blue' && edge.reason === 'override-inactive'
  )));
});

test('evaluateDueDateFirst is deterministic, eliminates duplicate state-group candidates, and reports explicit limits', () => {
  // This fails if repeated identical state groups are searched as different
  // candidates, if reruns depend on insertion order, or if caller-provided
  // iteration/deadline bounds are ignored.
  const redEarly = scheduledTask('red-early', 1, 'RED', '2026-08-03T10:00:00');
  const redLater = scheduledTask('red-later', 1, 'RED', '2026-08-03T11:00:00');
  const sameStateSetup = setupTruth({ rows: [setupRow('GREEN', 'RED', 5)] });
  const sameStateSnapshot = setupSnapshot([redLater, redEarly]);
  const first = SetupScheduler.evaluateDueDateFirst(sameStateSnapshot, dueDateBounds(sameStateSetup));
  const second = SetupScheduler.evaluateDueDateFirst(sameStateSnapshot, dueDateBounds(sameStateSetup));

  const serial = result => scheduledPatches(result).map(patch => [
    patch.id, patch.changes.start_date.getTime(), patch.changes.end_date.getTime(),
  ]);
  assert.deepEqual(serial(first), serial(second));
  assert.equal(first.diagnostics.candidateCount, 1, 'one known state group produces one unique exact candidate');
  assert.equal(first.diagnostics.method, 'due-date-first-exact');

  const colors = ['RED', 'BLUE', 'YELLOW'];
  const cappedTasks = colors.map((color, index) => (
    scheduledTask(`cap-${color}`, 1, color, `2026-08-03T${10 + index}:00:00`)
  ));
  const allEdges = [];
  for (const from of ['GREEN', ...colors]) {
    for (const to of colors) allEdges.push(setupRow(from, to, 0));
  }
  const capped = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot(cappedTasks),
    dueDateBounds(setupTruth({ rows: allEdges }), { iterationCap: 3 }),
  );
  assert.equal(capped.diagnostics.candidateCount, 1);
  assert.equal(capped.diagnostics.termination, 'iteration-cap');
  assert.equal(capped.diagnostics.limitReached, true);

  const expired = SetupScheduler.evaluateDueDateFirst(
    sameStateSnapshot,
    dueDateBounds(sameStateSetup, { clock: () => 10, deadline: 1 }),
  );
  assert.equal(expired.diagnostics.termination, 'deadline');
  assert.equal(expired.diagnostics.limitReached, true);
  // Part 2b: a deadline exhausted before any covered sequence completes no
  // longer freezes the line either — the whole fragment is placed as an
  // unknown tail instead.
  assert.deepEqual(expired.unchangedLines, []);
  assert.ok(expired.explanation.some(reason => ['unknown-setup-tail-placement', 'initial-state-unknown', 'admitted-state-unrecorded'].includes(reason.code)));
});

test('evaluateDueDateFirst bounds exact occurrence traversal before a low-cap same-state search can recurse deeply', () => {
  // This fails if the cap is consumed only at completed leaves: one state group
  // with many ordered occurrences can then recurse through every task even
  // though the caller supplied a deliberately tiny bound and a fixed clock.
  const manyRed = Array.from({ length: 10 }, (_, index) => (
    scheduledTask(`traversal-red-${index}`, 0.5, 'RED', `2026-08-03T${10 + index}:00:00`)
  ));
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0)] });
  let lowCapClockCalls = 0;
  const fixedClock = () => {
    lowCapClockCalls += 1;
    return 0;
  };

  const lowCap = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot(manyRed),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: 2, clock: fixedClock }),
  );

  assert.equal(lowCap.diagnostics.termination, 'iteration-cap');
  assert.equal(lowCap.diagnostics.limitReached, true);
  assert.equal(lowCap.diagnostics.candidateCount, 0,
    'two bounded occurrence expansions cannot reach a ten-order leaf');
  // Phase 1.5 repair: the never-freeze fallback now tail-places all ten
  // orders when the covered-core search finds no winner, and the Phase 1.5
  // tail-pass valve (requirement 4) deliberately reads bounds.clock() once
  // per tail-placement attempt — plus one more read for the per-line
  // deadline-share computation (requirement 3). Neither is the "recursive
  // occurrence visit" this assertion actually guards against, so the bound
  // is widened to tolerate exactly that many legitimate extra reads while
  // still catching exactSearch itself degrading to unbounded traversal.
  assert.ok(lowCapClockCalls <= manyRed.length + 6,
    'the fixed clock observes only the bounded path plus the never-freeze tail placement, not ten recursive occurrence visits');

  const enoughCap = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot(manyRed),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: manyRed.length }),
  );

  assert.equal(enoughCap.diagnostics.termination, 'completed');
  assert.equal(enoughCap.diagnostics.candidateCount, 1);
  assert.equal(enoughCap.patches.length, manyRed.length,
    'a caller that supplies enough explicit search work still receives the useful deterministic candidate');
});

test('evaluateDueDateFirst shares its caller iteration cap across lines', () => {
  // Part 2b: the SearchBudget is constructed fresh inside the per-line loop,
  // so a caller iteration cap of 1 still lets EVERY line search its own
  // single-candidate fragment rather than only the first line in plant order.
  const firstLine = scheduledTask('global-cap-l1', 1, 'BLUE', '2026-08-03T10:00:00');
  const secondLine = {
    ...scheduledTask('global-cap-l2', 1, 'BLUE', '2026-08-03T10:00:00'),
    MACHINE: 'L2',
  };
  const snapshot = setupSnapshot([firstLine, secondLine]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  setup.machine_states.push({
    machine: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'second global-cap line',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { iterationCap: 1 }));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['global-cap-l1']);
  assert.equal(result.dispositions.find(disposition => disposition.id === 'global-cap-l2').status, 'needs_planning');
  assert.equal(result.diagnostics.iterationsUsed, 1);
  assert.equal(result.diagnostics.termination, 'iteration-cap');
});

test('evaluateDueDateFirst uses bounded strict-improvement local search after greedy group selection', () => {
  // This fails if fragments above the exact threshold stop at a due-sorted
  // greedy candidate even when one deterministic swap preserves due service
  // and strictly reduces covered setup minutes.
  const laterA = scheduledTask('greedy-a', 1, 'RED', '2026-08-03T13:00:00');
  const earlierB = scheduledTask('greedy-b', 1, 'BLUE', '2026-08-03T12:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 30), setupRow('BLUE', 'RED', 30),
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([laterA, earlierB]),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: 3 }),
  );

  assert.equal(result.diagnostics.method, 'due-date-first-greedy');
  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['greedy-a', 'greedy-b']);
  assert.equal(result.diagnostics.candidateCount, 2);
});

test('evaluateSptWithSetup orders by productive runtime while reserving covered setup capacity', () => {
  // This fails if setup becomes an SPT sort term, or if the SPT result ignores
  // the covered setup time that must occupy capacity immediately before work.
  assert.equal(typeof SetupScheduler.evaluateSptWithSetup, 'function');
  const longRed = scheduledTask('spt-long-red', 2, 'RED', null);
  const shortBlue = scheduledTask('spt-short-blue', 1, 'BLUE', null);
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 20),
    setupRow('BLUE', 'RED', 10),
  ] });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([longRed, shortBlue]),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['spt-short-blue', 'spt-long-red']);
  assert.equal(patchFor(result, 'spt-short-blue').changes.start_date.getTime(), at('2026-08-03T08:20:00').getTime());
  assert.equal(patchFor(result, 'spt-long-red').changes.start_date.getTime(), at('2026-08-03T09:30:00').getTime());
});

test('evaluateSptWithSetup never freezes a line whose pure SPT sequence has a missing edge: the demoted order is tail-placed', () => {
  // Never-freeze semantics (A1/A2): the order behind the missing edge (RED ->
  // BLUE has no matrix row) now stays in the SPT sequence, admitted at zero
  // setup minutes, rather than being demoted into the unknown tail.
  const longRed = scheduledTask('spt-missing-long-red', 2, 'RED', null);
  const shortBlue = scheduledTask('spt-missing-short-blue', 1, 'BLUE', null);
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 5)] });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([longRed, shortBlue]),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['spt-missing-long-red', 'spt-missing-short-blue']);
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-without-setup' && reason.taskId === 'spt-missing-short-blue'
  )), 'the order behind the missing edge is admitted into the sequence at zero setup minutes');
  // F1/F12: the demoted-then-tail-placed order reports via the dedicated
  // 'scheduled-without-setup' missingEdge reason.
  assert.ok(result.missingEdges.some(edge => (
    edge.reason === 'scheduled-without-setup' && edge.successorOrderId === 'spt-missing-short-blue'
  )));
});

test('evaluateDueDateFirst never freezes a line with an incomplete (strict-blank) setup state', () => {
  // Never-freeze semantics: a strict-blank order has an unresolvable state
  // (`successor-state-unknown`), so it is partitioned straight into the
  // unknown tail by `searchFragment` (Part 1a) and tail-placed, while an
  // unrelated fully-known line is scheduled normally.
  const incomplete = scheduledTask('incomplete-state', 1, '', '2026-08-03T10:00:00');
  const known = {
    ...scheduledTask('known-state', 1, 'BLUE', '2026-08-03T10:00:00'),
    MACHINE: 'L2',
  };
  const snapshot = setupSnapshot([incomplete, known]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  setup.machine_states.push({
    machine: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'known second line state',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['incomplete-state', 'known-state']);
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.line === 'L1' && ['unknown-setup-tail-placement', 'initial-state-unknown', 'admitted-state-unrecorded'].includes(reason.code) && reason.taskId === 'incomplete-state'
  )));
  // Unknown signatures remain separate from known uncovered transitions.
  assert.ok(result.missingEdges.some(edge => (
    edge.line === 'L1' && edge.reason === 'successor-state-unknown' && edge.successorOrderId === 'incomplete-state'
  )));
});

test('evaluateDueDateFirst retains policy tiers while allowing equal-tier due work to interleave states', () => {
  // This fails if the state-group search flattens BLUE work contiguously or
  // ignores the supplied priority-rank snapshot. Equal-tier BLUE(09),
  // RED(10), BLUE(12) must remain eligible as BLUE -> RED -> BLUE instead of
  // forcing all BLUE work ahead of the intervening due obligation.
  const blueEarly = scheduledTask('tier-blue-early', 1, 'BLUE', '2026-08-03T09:00:00');
  const redMiddle = scheduledTask('tier-red-middle', 1, 'RED', '2026-08-03T10:00:00');
  const blueLate = scheduledTask('tier-blue-late', 1, 'BLUE', '2026-08-03T12:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 0), setupRow('GREEN', 'RED', 0),
    setupRow('BLUE', 'RED', 0), setupRow('RED', 'BLUE', 0),
  ] });
  const snapshot = setupSnapshot([blueLate, redMiddle, blueEarly]);
  snapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 1, RED: 1 } } };

  const equalTier = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(equalTier.patches.map(patch => patch.id), [
    'tier-blue-early', 'tier-red-middle', 'tier-blue-late',
  ]);

  const rankedSnapshot = setupSnapshot([blueEarly, redMiddle]);
  rankedSnapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 2, RED: 1 } } };
  const ranked = SetupScheduler.evaluateDueDateFirst(rankedSnapshot, dueDateBounds(setup));

  assert.deepEqual(ranked.patches.map(patch => patch.id), ['tier-red-middle', 'tier-blue-early'],
    'the detached policy comparison must read priorityRankMaps before due score');
});

test('evaluateSptWithSetup solves free fragments around a fixed order without changing its pure runtime order', () => {
  // This fails when SPT bypasses every line that contains fixed work instead
  // of using the fixed order as the predecessor of its trailing fragment.
  const fixed = scheduledTask(
    'spt-fixed-blue', 1, 'BLUE', null, '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const longer = scheduledTask('spt-fixed-long-yellow', 2, 'YELLOW', null);
  const shorter = scheduledTask('spt-fixed-short-red', 1, 'RED', null);
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 0), setupRow('GREEN', 'RED', 0), setupRow('BLUE', 'RED', 0), setupRow('RED', 'BLUE', 0),
    setupRow('BLUE', 'YELLOW', 0), setupRow('RED', 'YELLOW', 0),
  ] });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([longer, fixed, shorter], { firmedIds: ['spt-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['spt-fixed-short-red', 'spt-fixed-long-yellow']);
  assert.equal(patchFor(result, 'spt-fixed-short-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateSptWithSetup admits unscheduled short-runtime work before a fixed boundary before carrying the remainder', () => {
  // This fails if SPT decides a free task belongs after a fixed boundary from
  // its stale/null planned end instead of its pure productive-runtime sequence
  // and the actual available capacity in the preceding fragment.
  const fixed = scheduledTask(
    'spt-pre-fixed-blue', 1, 'BLUE', null, '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const short = scheduledTask('spt-pre-fixed-short-red', 0.5, 'RED', null);
  const medium = scheduledTask('spt-pre-fixed-medium-yellow', 0.75, 'YELLOW', null);
  const long = scheduledTask('spt-pre-fixed-long-red', 1, 'RED', null);
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('RED', 'YELLOW', 0), setupRow('YELLOW', 'BLUE', 0),
    setupRow('YELLOW', 'RED', 0), setupRow('BLUE', 'RED', 0),
  ] });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([long, fixed, medium, short], { firmedIds: ['spt-pre-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), [
    'spt-pre-fixed-short-red', 'spt-pre-fixed-medium-yellow', 'spt-pre-fixed-long-red',
  ]);
  assert.equal(patchFor(result, 'spt-pre-fixed-short-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(patchFor(result, 'spt-pre-fixed-medium-yellow').changes.start_date.getTime(), at('2026-08-03T08:30:00').getTime());
  assert.equal(patchFor(result, 'spt-pre-fixed-long-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst preserves active override adjacency across each fixed-boundary orientation', () => {
  // This fails if free work is assigned solely by due timestamp and an active
  // free -> fixed or fixed -> free override becomes incorrectly inactive.
  const beforeFixed = scheduledTask('override-before-fixed-red', 1, 'RED', '2026-08-03T15:00:00');
  const fixedBlue = scheduledTask(
    'override-fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const beforeSetup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0), setupRow('GREEN', 'BLUE', 0),
  ], overrides: [{
    id: 'override-before-fixed', machine: 'L1', signature_version: 1,
    predecessor_order_id: 'override-before-fixed-red', successor_order_id: 'override-fixed-blue',
    predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected pre-fixed adjacency',
  }] });

  const beforeResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([beforeFixed, fixedBlue], { firmedIds: ['override-fixed-blue'] }),
    dueDateBounds(beforeSetup),
  );

  assert.equal(patchFor(beforeResult, 'override-before-fixed-red').changes.end_date.getTime(), at('2026-08-03T09:00:00').getTime());
  assert.deepEqual(beforeResult.unchangedLines, []);

  const fixedBlueAgain = scheduledTask(
    'override-fixed-blue-again', 1, 'BLUE', '2026-08-03T11:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const afterFixed = scheduledTask('override-after-fixed-red', 1, 'RED', '2026-08-03T09:00:00');
  const afterSetup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
  ], overrides: [{
    id: 'override-after-fixed', machine: 'L1', signature_version: 1,
    predecessor_order_id: 'override-fixed-blue-again', successor_order_id: 'override-after-fixed-red',
    predecessor_state_key: setupState('BLUE'), successor_state_key: setupState('RED'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected post-fixed adjacency',
  }] });

  const afterResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([afterFixed, fixedBlueAgain], { firmedIds: ['override-fixed-blue-again'] }),
    dueDateBounds(afterSetup),
  );

  assert.equal(patchFor(afterResult, 'override-after-fixed-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.deepEqual(afterResult.unchangedLines, []);
});

test('an in-progress firmed boundary with an active free->firmed override reports override-inactive without changing placement', () => {
  // The in-progress boundary starts at or before the cursor, so the free
  // predecessor named by the override cannot be placed immediately before it.
  // The branch stays never-freeze (placement unchanged) but must report the
  // inactive override instead of silently charging a B -> A setup.
  const freeRed = scheduledTask('elapsed-override-free-red', 1, 'RED', '2026-08-03T15:00:00');
  const running = scheduledTask(
    'elapsed-override-running-blue', 1, 'BLUE', '2026-08-03T09:00:00', '2026-08-03T07:00:00', '2026-08-03T09:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0), setupRow('BLUE', 'RED', 15),
  ], overrides: [{
    id: 'elapsed-override', machine: 'L1', signature_version: 1,
    predecessor_order_id: 'elapsed-override-free-red', successor_order_id: 'elapsed-override-running-blue',
    predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'free before running',
  }] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([freeRed, running], { firmedIds: ['elapsed-override-running-blue'] }),
    dueDateBounds(setup),
  );

  // Placement is the never-freeze placement, identical to before the report.
  assert.equal(patchFor(result, 'elapsed-override-running-blue'), undefined);
  assert.equal(patchFor(result, 'elapsed-override-free-red').changes.start_date.getTime(), at('2026-08-03T09:15:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.missingEdges.some(edge => (
    edge.reason === 'override-inactive'
    && edge.predecessorOrderId === 'elapsed-override-free-red'
    && edge.successorOrderId === 'elapsed-override-running-blue'
  )), 'the unreachable free->running override is reported as an override-inactive edge');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'override-inactive'
    && reason.taskId === 'elapsed-override-running-blue'
    && reason.message.includes('elapsed-override-free-red')
    && reason.message.includes('elapsed-override-running-blue')
  )), 'the explanation names both orders');
});

test('evaluateDueDateFirst honors an active override already bound between adjacent fixed orders', () => {
  // This fails if fixed -> fixed is treated as an inactive binding merely
  // because neither endpoint is free. The protected physical adjacency already
  // exists and its override must resolve the incoming transition to the second
  // fixed order without emitting override-inactive.
  const fixedRed = scheduledTask(
    'override-fixed-red', 1, 'RED', null, '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const fixedBlue = scheduledTask(
    'override-fixed-blue', 1, 'BLUE', null, '2026-08-03T09:10:00', '2026-08-03T10:10:00',
  );
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'RED', 0)],
    overrides: [{
      id: 'override-fixed-to-fixed', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'override-fixed-red', successor_order_id: 'override-fixed-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 10, remaining_min: 10, status: 'active', reason: 'protected fixed adjacency',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([fixedBlue, fixedRed], { firmedIds: ['override-fixed-red', 'override-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result), []);
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'firmed-incoming-setup' && reason.taskId === 'override-fixed-blue' && reason.message.includes('10')
  )), 'the bound override must resolve the transition into the second fixed production run');
});

test('evaluateDueDateFirst admits a feasible pre-fixed due prefix and carries the remainder past the boundary', () => {
  // This fails when an order that cannot fit before a fixed run makes the
  // entire candidate infeasible instead of retaining the feasible due work
  // and scheduling the remainder after the fixed outgoing state.
  const red = scheduledTask('admitted-a-red', 1, 'RED', '2026-08-03T09:15:00');
  const yellow = scheduledTask('admitted-b-yellow', 1, 'YELLOW', '2026-08-03T09:15:00');
  const fixed = scheduledTask(
    'admitted-fixed-blue', 1, 'BLUE', '2026-08-03T10:30:00', '2026-08-03T09:30:00', '2026-08-03T10:30:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'YELLOW', 0), setupRow('RED', 'YELLOW', 0),
    setupRow('RED', 'BLUE', 0), setupRow('YELLOW', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([yellow, fixed, red], { firmedIds: ['admitted-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'admitted-a-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(patchFor(result, 'admitted-b-yellow').changes.start_date.getTime(), at('2026-08-03T10:30:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst accepts a zero-minute transition into a fixed run at the fragment boundary', () => {
  // This fails when a zero-duration setup is incorrectly required to occupy a
  // non-empty availability interval before a fixed production start.
  const fixed = scheduledTask(
    'zero-fixed-blue', 1, 'BLUE', '2026-08-03T09:00:00', '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([fixed], { firmedIds: ['zero-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result), []);
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'incoming-firmed-setup-infeasible'), false);
});

test('setup-aware evaluators never freeze a line over a stale-signature line state: they proceed with a null initial state', () => {
  // Never-freeze semantics (Part 1d): a stale signature version is not merely
  // unknown physical state, but it no longer skips the line either. The
  // evaluator proceeds with `initialState = null`; the diagnostic is
  // retained, and the first order's incoming setup is reported unknown
  // rather than charged, but it is still scheduled.
  const blue = scheduledTask(
    'signature-incompatible-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  setup.machine_states[0].signature_version = 2;

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([blue]), dueDateBounds(setup));

  assert.equal(SetupScheduler.applyPatchesToSnapshot([blue], result.patches)[0].start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.missingEdges.some(edge => edge.reason === 'signature-incompatible'));
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-state-unrecorded' && reason.taskId === 'signature-incompatible-blue'
  )), 'the first order reports an unknown incoming setup rather than being frozen');
});

test('evaluateDueDateFirst treats a same-state active override as an exact pair despite due inversion', () => {
  // This fails if the one-state group's normal due ordering is treated as
  // immutable: the active predecessor -> successor occurrence must remain
  // physically adjacent even though the successor's due date is earlier.
  const predecessor = scheduledTask('same-state-predecessor', 1, 'RED', '2026-08-03T12:00:00');
  const successor = scheduledTask('same-state-successor', 1, 'RED', '2026-08-03T09:00:00');
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'RED', 0)],
    overrides: [{
      id: 'same-state-active-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'same-state-predecessor', successor_order_id: 'same-state-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected same-state occurrence',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['same-state-predecessor', 'same-state-successor']);
  assert.deepEqual(result.unchangedLines, []);

  const greedyResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup, { exactSearchThreshold: 0 }),
  );
  assert.equal(greedyResult.diagnostics.method, 'due-date-first-greedy');
  assert.deepEqual(scheduledPatches(greedyResult).map(patch => patch.id), ['same-state-predecessor', 'same-state-successor']);
});

test('evaluateDueDateFirst rejects an orphaned protected predecessor when its successor cannot fit', () => {
  // This fails if a capacity-bound fragment emits the override's predecessor
  // then silently defers its successor, breaking the protected physical pair.
  const predecessor = scheduledTask('capacity-pair-predecessor', 1, 'RED', '2026-08-03T09:00:00');
  const successor = scheduledTask('capacity-pair-successor', 1, 'BLUE', '2026-08-03T10:00:00');
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
      setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'capacity-pair-active-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'capacity-pair-predecessor', successor_order_id: 'capacity-pair-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected capacity-bound occurrence',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([predecessor, successor]),
    dueDateBounds(setup, { horizonEnd: at('2026-08-03T09:30:00') }),
  );

  assert.deepEqual(scheduledPatches(result), []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.missingEdges.some(edge => (
    edge.successorOrderId === 'capacity-pair-successor' && edge.reason === 'override-inactive'
  )));
});

test('evaluateDueDateFirst keeps a free active override pair on one side of a fixed boundary', () => {
  // This fails if due-based fragment partitioning puts the protected
  // predecessor before fixed work and its successor after it. The pair must
  // move together so no fixed production breaks their physical adjacency.
  const predecessor = scheduledTask('cross-boundary-pair-predecessor', 0.5, 'RED', '2026-08-03T09:00:00');
  const successor = scheduledTask('cross-boundary-pair-successor', 0.5, 'BLUE', '2026-08-03T12:00:00');
  const fixed = scheduledTask(
    'cross-boundary-fixed-yellow', 1, 'YELLOW', '2026-08-03T11:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0),
      setupRow('RED', 'YELLOW', 0), setupRow('YELLOW', 'BLUE', 0),
    ],
    overrides: [{
      id: 'cross-boundary-active-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'cross-boundary-pair-predecessor', successor_order_id: 'cross-boundary-pair-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected across due partition',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, fixed, predecessor], { firmedIds: ['cross-boundary-fixed-yellow'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), [
    'cross-boundary-pair-predecessor', 'cross-boundary-pair-successor',
  ]);
  assert.equal(patchFor(result, 'cross-boundary-pair-successor').changes.end_date.getTime(), at('2026-08-03T09:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst keeps a caller-bounded high-occurrence exact search stack-safe', () => {
  // This fails with a RangeError when exact traversal recurses once per
  // occurrence: a caller cap that is lower than the fragment size must stop
  // work without consuming the JavaScript call stack.
  const taskCount = 25_001;
  const manySameStateTasks = Array.from({ length: taskCount }, (_, index) => (
    scheduledTask(`stack-safe-red-${index}`, 0.5, 'RED', null)
  ));
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot(manySameStateTasks),
    dueDateBounds(setup, {
      exactSearchThreshold: 1,
      iterationCap: taskCount - 1,
      clock: () => 0,
      deadline: 1,
    }),
  );

  assert.equal(result.diagnostics.termination, 'iteration-cap');
  assert.equal(result.diagnostics.limitReached, true);
  assert.equal(result.diagnostics.candidateCount, 0);
  // Never-freeze semantics: the exhausted exact search itself still never
  // completed a candidate (proving the stack-safety property this test
  // exists for), but the fragment is no longer discarded wholesale — it is
  // placed as an unknown tail bounded by real calendar capacity (20 orders
  // of 30 minutes fit an 8-18 single-day window); the remainder overflows
  // as unadmitted rather than crashing or fabricating capacity.
  assert.equal(scheduledPatches(result).length, 20);
  assert.deepEqual(result.unchangedLines, []);
});

test('setup-aware evaluators reserve the pre-fixed fragment for a valid initial-state override', () => {
  // This fails if boundary locking ignores a null predecessor_order_id: free
  // RED then enters the pre-fixed fragment, breaks the persisted GREEN ->
  // fixed BLUE adjacency, and makes the valid override look inactive.
  const freeRed = scheduledTask('initial-override-free-red', 1, 'RED', '2026-08-03T09:00:00');
  const fixedBlue = scheduledTask(
    'initial-override-fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    rows: [setupRow('BLUE', 'RED', 0)],
    overrides: [{
      id: 'initial-to-fixed-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: null, successor_order_id: 'initial-override-fixed-blue',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('BLUE'),
      standard_min: 10, remaining_min: 10, status: 'active', reason: 'line is already staged for fixed run',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([freeRed, fixedBlue], { firmedIds: ['initial-override-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['initial-override-free-red'], `${label} moves free work after fixed`);
    assert.equal(patchFor(result, 'initial-override-free-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
    assert.deepEqual(result.unchangedLines, []);
    assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'firmed-incoming-setup'
      && reason.taskId === 'initial-override-fixed-blue'
      && reason.message.includes('10')
    )), `${label} resolves the incoming fixed setup from the protected override`);
  }
});

// Postgres jsonb returns object keys shorter-first ({value, fieldKey}); the
// order side builds {fieldKey, value}. State keys must compare equal anyway.
function jsonbOrderedState(value) {
  return [{ value, fieldKey: 'colorWheel' }];
}

test('override state keys in jsonb {value, fieldKey} order still match (free adjacency + boundary lock)', () => {
  const red = scheduledTask('jsonb-red', 1, 'RED', '2026-08-03T12:00:00');
  const blue = scheduledTask('jsonb-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const adjacencySetup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 10), setupRow('RED', 'BLUE', 20),
      setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'jsonb-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'jsonb-red', successor_order_id: 'jsonb-blue',
      predecessor_state_key: jsonbOrderedState('RED'), successor_state_key: jsonbOrderedState('BLUE'),
      standard_min: 20, remaining_min: 4, status: 'active', reason: 'jsonb key order',
    }],
  });
  const adj = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red, blue]), dueDateBounds(adjacencySetup));
  assert.equal(adj.missingEdges.some(edge => edge.reason === 'override-inactive'), false,
    'reordered override keys must not read as inactive');
  assert.deepEqual(scheduledPatches(adj).map(patch => patch.id), ['jsonb-red', 'jsonb-blue']);
  assert.equal(patchFor(adj, 'jsonb-blue').changes.start_date.getTime(), at('2026-08-03T09:14:00').getTime());

  const freeRed = scheduledTask('jsonb-initial-free-red', 1, 'RED', '2026-08-03T09:00:00');
  const fixedBlue = scheduledTask(
    'jsonb-initial-fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const lockSetup = setupTruth({
    rows: [setupRow('BLUE', 'RED', 0)],
    overrides: [{
      id: 'jsonb-initial-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: null, successor_order_id: 'jsonb-initial-fixed-blue',
      predecessor_state_key: jsonbOrderedState('GREEN'), successor_state_key: jsonbOrderedState('BLUE'),
      standard_min: 10, remaining_min: 10, status: 'active', reason: 'jsonb key order',
    }],
  });
  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([freeRed, fixedBlue], { firmedIds: ['jsonb-initial-fixed-blue'] }),
      dueDateBounds(lockSetup),
    );
    assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['jsonb-initial-free-red'], `${label} boundary lock holds`);
    assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false, label);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'firmed-incoming-setup' && reason.taskId === 'jsonb-initial-fixed-blue'
    )), `${label} audit resolves the incoming fixed setup from the override`);
  }
});

test('unknown tail orders are placed once when the trailing fragment has no winner', () => {
  const known = scheduledTask('tail-once-known', 1, 'BLUE', '2026-08-03T18:00');
  const blanks = ['A', 'B', 'C'].map(letter => scheduledTask(`tail-once-${letter}`, 1, '', '2026-08-03T18:00'));
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    // The clock expires on the first search tick: the trailing fragment has no
    // winner, so its whole fragment (known + blank) falls to the unknown tail.
    let ticks = 0;
    const result = evaluate(
      setupSnapshot([known, ...blanks]),
      dueDateBounds(setup, { deadline: 1, clock: () => ticks++ }),
    );
    for (const { id } of blanks) {
      assert.equal(result.patches.filter(patch => patch.id === id).length, 1, `${label}: ${id} gets exactly one patch`);
    }
    assert.equal(result.diagnostics.unknownTailPlacedCount, 3, label);
    const starts = blanks.map(({ id }) => patchFor(result, id).changes.start_date.getTime()).sort((x, y) => x - y);
    for (let i = 1; i < starts.length; i += 1) {
      assert.equal(starts[i] - starts[i - 1], 60 * 60 * 1000, `${label}: tail orders are contiguous (no phantom hole)`);
    }
    const sws = result.missingEdges
      .filter(edge => edge.reason === 'scheduled-without-setup')
      .map(edge => `${edge.predecessorOrderId}>${edge.successorOrderId}`);
    assert.equal(new Set(sws).size, sws.length, `${label}: no duplicated scheduled-without-setup edges`);
  }
});

test('setup-aware evaluators reject invalid null-predecessor overrides on fixed boundaries', () => {
  // This protects the new null-predecessor lock: it belongs only to the first
  // fixed boundary and only when its predecessor state matches persisted line
  // state. A later target or stale state must remain inactive, not reserve an
  // unrelated fragment.
  const firstFixed = scheduledTask(
    'invalid-null-first-blue', 1, 'BLUE', null, '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const laterFixed = scheduledTask(
    'invalid-null-later-yellow', 1, 'YELLOW', null, '2026-08-03T11:00:00', '2026-08-03T12:00:00',
  );
  const laterSetup = setupTruth({
    rows: [setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0)],
    overrides: [{
      id: 'invalid-null-later', machine: 'L1', signature_version: 1,
      predecessor_order_id: null, successor_order_id: 'invalid-null-later-yellow',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('YELLOW'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'invalid later-boundary binding',
    }],
  });
  const staleStateFixed = scheduledTask(
    'invalid-null-state-blue', 1, 'BLUE', null, '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const staleStateSetup = setupTruth({
    current: 'RED', rows: [setupRow('RED', 'BLUE', 0)],
    overrides: [{
      id: 'invalid-null-state', machine: 'L1', signature_version: 1,
      predecessor_order_id: null, successor_order_id: 'invalid-null-state-blue',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'stale initial-state binding',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    for (const [caseLabel, snapshot, setup] of [
      [
        'later fixed boundary',
        setupSnapshot([firstFixed, laterFixed], { firmedIds: ['invalid-null-first-blue', 'invalid-null-later-yellow'] }),
        laterSetup,
      ],
      [
        'stale initial state',
        setupSnapshot([staleStateFixed], { firmedIds: ['invalid-null-state-blue'] }),
        staleStateSetup,
      ],
    ]) {
      const result = evaluate(snapshot, dueDateBounds(setup));
      assert.deepEqual(scheduledPatches(result), [], `${label} ${caseLabel} makes no mutable candidate`);
      assert.deepEqual(result.unchangedLines, ['L1']);
      assert.ok(result.missingEdges.some(edge => edge.reason === 'override-inactive'));
    }
  }
});

test('setup-aware evaluators admit an initial-state free override and its protected component before a later fixed boundary', () => {
  // This fails if Due-date-first partitions free work only by due date: a
  // valid persisted GREEN -> RED override with RED due after the fixed run
  // must still make RED the first physical free order, carrying RED -> BLUE
  // with it and never inserting unrelated YELLOW before RED.
  const red = scheduledTask('initial-free-red', 0.5, 'RED', '2026-08-03T12:00:00');
  const blue = scheduledTask('initial-free-blue', 0.5, 'BLUE', '2026-08-03T12:30:00');
  const yellow = scheduledTask('initial-free-unrelated-yellow', 0.5, 'YELLOW', '2026-08-03T08:30:00');
  const fixed = scheduledTask(
    'initial-free-fixed-yellow', 1, 'YELLOW', '2026-08-03T11:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    rows: [setupRow('BLUE', 'YELLOW', 0), setupRow('GREEN', 'YELLOW', 0)],
    overrides: [
      {
        id: 'initial-free-override', machine: 'L1', signature_version: 1,
        predecessor_order_id: null, successor_order_id: 'initial-free-red',
        predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'line is staged for red',
      },
      {
        id: 'initial-free-component-override', machine: 'L1', signature_version: 1,
        predecessor_order_id: 'initial-free-red', successor_order_id: 'initial-free-blue',
        predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'red and blue are one physical setup occurrence',
      },
    ],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([yellow, fixed, blue, red], { firmedIds: ['initial-free-fixed-yellow'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(scheduledPatches(result).map(patch => patch.id), [
      'initial-free-red', 'initial-free-blue', 'initial-free-unrelated-yellow',
    ], `${label} preserves the initial physical adjacency before the fixed run`);
    assert.equal(patchFor(result, 'initial-free-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.equal(patchFor(result, 'initial-free-blue').changes.start_date.getTime(), at('2026-08-03T08:30:00').getTime());
    assert.equal(patchFor(result, 'initial-free-unrelated-yellow').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime());
    assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false);
  }
});

test('setup-aware evaluators leave an initial-state free override unchanged when its protected component cannot fit before fixed work', () => {
  // This fails if a solver emits RED alone, defers BLUE through a fixed run,
  // or otherwise breaks an initial-state protected component when there is not
  // enough pre-fixed capacity for the whole physical adjacency.
  const red = scheduledTask('initial-free-tight-red', 1, 'RED', '2026-08-03T12:00:00');
  const blue = scheduledTask('initial-free-tight-blue', 1, 'BLUE', '2026-08-03T12:30:00');
  const fixed = scheduledTask(
    'initial-free-tight-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const setup = setupTruth({
    rows: [setupRow('BLUE', 'YELLOW', 0)],
    overrides: [
      {
        id: 'initial-free-tight-override', machine: 'L1', signature_version: 1,
        predecessor_order_id: null, successor_order_id: 'initial-free-tight-red',
        predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'line is staged for red',
      },
      {
        id: 'initial-free-tight-component', machine: 'L1', signature_version: 1,
        predecessor_order_id: 'initial-free-tight-red', successor_order_id: 'initial-free-tight-blue',
        predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'red and blue are one occurrence',
      },
    ],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([blue, fixed, red], { firmedIds: ['initial-free-tight-fixed-yellow'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(scheduledPatches(result), [], `${label} does not emit a partial protected component`);
    assert.deepEqual(result.unchangedLines, ['L1']);
  }
});

test('setup-aware evaluators keep every earlier fragment patch when trailing capacity leaves work unadmitted', () => {
  // Never-freeze semantics (Part 1f): the terminal discard guard is removed.
  // The pre-fixed patch and the fixed run's reservation both survive; only
  // the orders that genuinely cannot fit in the remaining trailing capacity
  // stay at their current dates with a diagnostic, rather than the whole
  // line's patches being thrown away.
  //
  // A1/A2 side effect: `terminal-first-yellow` has no currently-scheduled
  // dates, so which fragment (pre- or post-fixed) it lands in is decided by
  // the search, not fixed up front. RED -> YELLOW has no matrix row, so
  // folding it in behind `terminal-before-red` (RED, 08:00-09:00) exactly
  // fills the pre-fixed gap (08:00-10:00) at the cost of one
  // admitted-without-setup edge. SPT's search finds and prefers this
  // arrangement, leaving only `terminal-old-overlap-red` (which has real
  // pre-existing dates) unable to fit the 30-minute trailing gap. The
  // due-date-first search does not fold YELLOW into the earlier fragment the
  // same way, so both trailing orders stay unadmitted there instead. Each
  // mode is asserted against its own actual unplaced order rather than
  // assuming the two modes must agree on which one that is.
  const before = scheduledTask('terminal-before-red', 1, 'RED', '2026-08-03T09:00:00');
  const fixed = scheduledTask(
    'terminal-fixed-blue', 1, 'BLUE', '2026-08-03T10:30:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const firstTrailing = scheduledTask('terminal-first-yellow', 1, 'YELLOW', '2026-08-03T11:30:00');
  const oldOverlap = scheduledTask(
    'terminal-old-overlap-red', 1, 'RED', '2026-08-03T12:00:00',
    '2026-08-03T11:30:00', '2026-08-03T12:30:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
    setupRow('BLUE', 'YELLOW', 0), setupRow('YELLOW', 'RED', 0), setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, evaluate, unplacedId] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst, 'terminal-first-yellow'],
    ['SPT', SetupScheduler.evaluateSptWithSetup, 'terminal-old-overlap-red'],
  ]) {
    const result = evaluate(
      setupSnapshot([oldOverlap, fixed, firstTrailing, before], { firmedIds: ['terminal-fixed-blue'] }),
      // Keep the pre-existing overlap in scope by one minute; an interval
      // beginning exactly at horizonEnd is intentionally outside optimizer
      // accounting and must remain untouched.
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T11:31:00') }),
    );

    assert.equal(patchFor(result, 'terminal-fixed-blue'), undefined, `${label} never patches the fixed run`);
    assert.ok(patchFor(result, 'terminal-before-red'), `${label} keeps the earlier fragment's patch instead of discarding it`);
    assert.deepEqual(result.unchangedLines, [], `${label} never freezes the whole line`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'unknown-setup-tail-unplaced' && reason.taskId === unplacedId
      && reason.message.includes('current dates')
    )), `${label} leaves capacity-starved trailing work at its current dates with a diagnostic`);
  }
});

test('setup-aware evaluators whole-line tail-place an explicitly incompatible snapshot line without blocking a compatible line', () => {
  // Never-freeze semantics (Part 1e): `setup_compatible === false` still
  // opts the line out of setup-awareness, but the whole line is now
  // tail-placed (policy/due order, zero setup capacity, one line-level
  // `setup-compatibility-disabled` edge) instead of being left unchanged.
  const incompatible = scheduledTask('compatibility-disabled-blue', 1, 'BLUE', '2026-08-03T10:00:00');
  const compatible = {
    ...scheduledTask('compatibility-enabled-blue', 1, 'BLUE', '2026-08-03T10:00:00'),
    MACHINE: 'L2',
  };
  const snapshot = setupSnapshot([incompatible, compatible]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  snapshot.masterData = {
    plants: [{ plant: 'P1' }],
    lines: [
      {
        plant: 'P1', machine: 'L1', setup_compatible: false,
        setup_compatibility_reason: 'Tooling signature differs on this line',
      },
      { plant: 'P1', machine: 'L2' },
    ],
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  setup.machine_states.push({
    machine: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'compatible second-line state',
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(snapshot, dueDateBounds(setup));

    assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), [
      'compatibility-disabled-blue', 'compatibility-enabled-blue',
    ], `${label} still evaluates L2 and tail-places L1`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => (
      edge.line === 'L1' && edge.reason === 'setup-compatibility-disabled'
    )));
    assert.ok(result.explanation.some(reason => (
      reason.line === 'L1'
      && reason.code === 'setup-incompatible'
      && reason.message.includes('Tooling signature differs on this line')
    )));
    assert.ok(result.explanation.some(reason => (
      reason.line === 'L1' && ['unknown-setup-tail-placement', 'initial-state-unknown', 'admitted-state-unrecorded'].includes(reason.code)
      && reason.taskId === 'compatibility-disabled-blue'
    )), `${label} places L1's order at the tail with no per-order override diagnostic noise`);
  }
});

test('evaluateDueDateFirst reports an active override whose successor no longer exists while scheduling unrelated work', () => {
  // This fails if an active binding to a deleted successor silently vanishes.
  // It must be inspectable as inactive without freezing unrelated remaining
  // work on the same line.
  const predecessor = scheduledTask('missing-successor-predecessor-red', 1, 'RED', '2026-08-03T09:00:00');
  const unrelated = scheduledTask('missing-successor-unrelated-blue', 1, 'BLUE', '2026-08-03T10:00:00');
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0)],
    overrides: [{
      id: 'missing-successor-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'missing-successor-predecessor-red', successor_order_id: 'deleted-successor-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'the successor was removed from this line',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([unrelated, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), [
    'missing-successor-predecessor-red', 'missing-successor-unrelated-blue',
  ]);
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.missingEdges.some(edge => (
    edge.line === 'L1'
    && edge.predecessorOrderId === 'missing-successor-predecessor-red'
    && edge.successorOrderId === 'deleted-successor-blue'
    && edge.reason === 'override-inactive'
  )));
  assert.ok(result.explanation.some(reason => (
    reason.line === 'L1' && reason.code === 'override-inactive' && reason.taskId === 'deleted-successor-blue'
  )));
});

test('evaluateDueDateFirst retains a missing-successor override diagnostic when current line state is unavailable', () => {
  // Never-freeze semantics: the early initial-state guard still must not
  // exit before surfacing an active override whose successor was deleted
  // from the immutable line snapshot, but the line is no longer frozen
  // either — it proceeds with a null initial state and the binding stays
  // visible as inactive.
  const remaining = scheduledTask('missing-successor-no-state-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({
    current: null,
    overrides: [{
      id: 'missing-successor-no-state-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'missing-successor-no-state-red', successor_order_id: 'deleted-successor-no-state-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'the successor was removed from this line',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([remaining]), dueDateBounds(setup));

  assert.ok(patchFor(result, 'missing-successor-no-state-red'), 'the line is not frozen');
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.missingEdges.some(edge => (
    edge.successorOrderId === 'deleted-successor-no-state-blue' && edge.reason === 'override-inactive'
  )));
  assert.ok(result.explanation.some(reason => (
    reason.code === 'override-inactive' && reason.taskId === 'deleted-successor-no-state-blue'
  )));
});

test('evaluateSptWithSetup keeps an active free-order override pair contiguous over pure runtime order', () => {
  // This fails if the SPT path treats an active occurrence override as a
  // post-hoc validation instead of a hard physical adjacency constraint.
  const predecessor = scheduledTask('spt-pair-long-red', 2, 'RED', null);
  const successor = scheduledTask('spt-pair-short-blue', 1, 'BLUE', null);
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
      setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'spt-pair-active-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'spt-pair-long-red', successor_order_id: 'spt-pair-short-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected SPT occurrence',
    }],
  });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), ['spt-pair-long-red', 'spt-pair-short-blue']);
  assert.deepEqual(result.unchangedLines, []);
});

test('setup-aware evaluators never freeze on an uncovered pre-fixed transition: the order is tail-placed ahead of the fixed run', () => {
  // Never-freeze semantics (A1): GREEN -> RED is uncovered, so RED is now
  // admitted directly into the covered-core sequence at zero setup minutes
  // (rather than being demoted into the unknown tail by a backstop that no
  // longer exists). The fixed run's own incoming reservation still uses the
  // real (covered) GREEN -> BLUE transition. RED still lands at the start of
  // the pre-fixed fragment (08:00) — the same timestamp as before, since a
  // single pre-fixed order beginning at the fragment's earliest cursor is
  // unaffected by whether it was placed via the tail mechanism or admitted
  // in-sequence.
  const red = scheduledTask('covered-fallback-red', 1, 'RED', '2026-08-03T08:30:00');
  const fixedBlue = scheduledTask(
    'covered-fallback-fixed-blue', 1, 'BLUE', '2026-08-03T09:00:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 0),
    setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([red, fixedBlue], { firmedIds: ['covered-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.equal(patchFor(result, 'covered-fallback-fixed-blue'), undefined, `${label} never patches the fixed run`);
    assert.equal(patchFor(result, 'covered-fallback-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
      `${label} places RED in the leftover pre-fixed capacity`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'admitted-without-setup' && reason.taskId === 'covered-fallback-red'
    )));
  }
});

test('setup-aware evaluators preserve the earliest usable scheduled order when initial state is unknown', () => {
  // This fails if an absent persisted line state makes the evaluator abandon
  // all work. The earliest valid scheduled interval is the deterministic
  // physical anchor: it is not patched, its incoming setup is reported as
  // unknown, and its fully-known BLUE state drives later RED placement.
  const anchor = scheduledTask(
    'unknown-state-anchor-blue', 1, 'BLUE', '2026-08-03T09:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const later = scheduledTask('unknown-state-later-red', 1, 'RED', '2026-08-03T11:00:00');
  const setup = setupTruth({
    current: null,
    rows: [setupRow('BLUE', 'RED', 0)],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([later, anchor]), dueDateBounds(setup));

    assert.equal(patchFor(result, 'unknown-state-anchor-blue'), undefined, `${label} keeps the physical anchor immovable`);
    assert.equal(patchFor(result, 'unknown-state-later-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
      `${label} schedules later work from the anchor state`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === null
      && edge.successorOrderId === 'unknown-state-anchor-blue'
      && edge.reason === 'initial-state-unknown'
    )), `${label} retains the anchor's unknown incoming setup as a structured diagnostic`);
  }
});

test('unknown-state anchor preservation never reopens capacity before the caller scheduling horizon', () => {
  // This fails if an old preserved anchor makes post-anchor work start at the
  // anchor's historical end instead of the caller's explicit `now` boundary.
  const completedAnchor = scheduledTask(
    'unknown-state-past-anchor-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const later = scheduledTask('unknown-state-horizon-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({ current: null, rows: [setupRow('BLUE', 'RED', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([later, completedAnchor], { firmedIds: [completedAnchor.id] }),
      dueDateBounds(setup, { now: at('2026-08-03T11:00:00') }),
    );

    assert.equal(patchFor(result, 'unknown-state-horizon-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime(),
      `${label} honors caller now after retaining an old physical anchor`);
  }
});

test('setup-aware evaluators proceed with a null initial state (never freeze) when there is no usable scheduled anchor', () => {
  // Never-freeze semantics (Part 1d): without a valid interval and complete
  // state there is no safe physical predecessor to preserve as an anchor,
  // but the evaluator no longer invents one OR skips the line — it proceeds
  // with `initialState = null` and the first order absorbs the unknown
  // incoming setup as a diagnostic rather than the line staying frozen.
  const onlyUnscheduled = scheduledTask('unknown-state-no-anchor-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({ current: null, rows: [setupRow('GREEN', 'RED', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([onlyUnscheduled]), dueDateBounds(setup));

    assert.ok(patchFor(result, 'unknown-state-no-anchor-red'), `${label} does not freeze the line`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => edge.reason === 'initial-state-unknown'));
    assert.ok(result.explanation.some(reason => (
      reason.code === 'admitted-state-unrecorded' && reason.taskId === 'unknown-state-no-anchor-red'
    )), `${label} charges no incoming setup and reports it as unknown instead`);
  }
});

test('unknown-state preservation reports a stale deleted predecessor override while scheduling safely after the anchor', () => {
  // This fails if the early no-current-state branch skips validation of an
  // active override whose successor still exists but predecessor was deleted.
  // The anchor makes later BLUE -> RED work safe, but the old binding must be
  // surfaced as inactive rather than silently disappearing.
  const anchor = scheduledTask(
    'unknown-state-stale-anchor-blue', 1, 'BLUE', '2026-08-03T09:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const successor = scheduledTask('unknown-state-stale-successor-red', 1, 'RED', '2026-08-03T11:00:00');
  const setup = setupTruth({
    current: null,
    rows: [setupRow('BLUE', 'RED', 0)],
    overrides: [{
      id: 'unknown-state-stale-predecessor', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-predecessor-green', successor_order_id: 'unknown-state-stale-successor-red',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'predecessor removed before planning',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([successor, anchor], { firmedIds: [anchor.id] }), dueDateBounds(setup));

    assert.equal(patchFor(result, 'unknown-state-stale-anchor-blue'), undefined, `${label} preserves the anchor`);
    assert.equal(patchFor(result, 'unknown-state-stale-successor-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime());
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'deleted-predecessor-green'
      && edge.successorOrderId === 'unknown-state-stale-successor-red'
      && edge.reason === 'override-inactive'
    )), `${label} retains the deleted-predecessor binding as inactive`);
  }
});

test('setup-aware evaluators do not skip an earlier scheduled order with an unusable setup state to anchor a later order', () => {
  // This fails if the preservation path filters state before finding the
  // current first physical interval. A later BLUE order must not become the
  // anchor while the earlier scheduled strict-blank order remains untouched;
  // the only safe outcome is an unchanged line with initial state unknown.
  const unusableFirst = scheduledTask(
    'unknown-state-unusable-first', 1, '', '2026-08-03T09:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const laterKnown = scheduledTask(
    'unknown-state-later-known-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const setup = setupTruth({ current: null, rows: [setupRow('BLUE', 'BLUE', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([laterKnown, unusableFirst]), dueDateBounds(setup));

    // Never-freeze semantics: the preservation path still must not skip the
    // true first scheduled order (with its unusable state) to anchor a later
    // one, but neither order is frozen anymore — both are scheduled with a
    // null initial state, and the unusable-state order is diagnosed as the
    // unresolved physical boundary rather than silently becoming an anchor.
    assert.ok(result.dispositions.some(d => d.id === 'unknown-state-later-known-blue' && d.status === 'scheduled'), `${label} does not freeze the line`);
    assert.ok(result.dispositions.some(d => d.id === 'unknown-state-unusable-first' && d.status === 'scheduled'), `${label} still schedules the true first order`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => (
      edge.successorOrderId === 'unknown-state-unusable-first'
      && edge.reason === 'successor-state-unknown'
    )), `${label} identifies the actual first scheduled order as the unresolved physical boundary`);
  }
});

test('setup-aware evaluators retain a deleted-predecessor override diagnostic when no unknown-state anchor is usable', () => {
  // This fails if the early no-anchor branch only inspects deleted successors.
  // Even though no safe scheduling can continue, the active binding whose
  // predecessor disappeared must remain visible as override-inactive.
  const successor = scheduledTask('unknown-no-anchor-stale-successor-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({
    current: null,
    overrides: [{
      id: 'unknown-no-anchor-stale-predecessor', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-no-anchor-predecessor', successor_order_id: 'unknown-no-anchor-stale-successor-red',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'predecessor no longer exists',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([successor]), dueDateBounds(setup));

    assert.deepEqual(scheduledPatches(result), [], `${label} cannot schedule without a physical anchor`);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'deleted-no-anchor-predecessor'
      && edge.successorOrderId === 'unknown-no-anchor-stale-successor-red'
      && edge.reason === 'override-inactive'
    )), `${label} retains the stale predecessor diagnostic without an anchor`);
  }
});

test('setup-aware evaluators admit a covered pre-fixed order directly, skipping its uncovered outgoing fixed transition', () => {
  // Never-freeze semantics (Part 1f): RED -> fixed BLUE is uncovered, but
  // that no longer disqualifies RED's admission — the reservation is simply
  // skipped and kept as a diagnostic, so RED is admitted directly ahead of
  // the fixed run through the normal search (no demotion/tail placement
  // needed at all).
  const red = scheduledTask('outgoing-fallback-red', 1, 'RED', '2026-08-03T08:30:00');
  const fixedBlue = scheduledTask(
    'outgoing-fallback-fixed-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([red, fixedBlue], { firmedIds: ['outgoing-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );
    const redPatch = patchFor(result, 'outgoing-fallback-red');

    assert.equal(patchFor(result, 'outgoing-fallback-fixed-blue'), undefined, `${label} never patches fixed BLUE`);
    assert.ok(redPatch, `${label} still schedules RED`);
    assert.equal(redPatch.changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
      `${label} uses zero minutes for the missing outgoing setup`);
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('setup-aware evaluators admit a covered pre-fixed order even when its incoming setup cannot fit before fixed work', () => {
  // Never-freeze semantics (Part 1f): `incoming-firmed-setup-infeasible`
  // skips the reservation and stays feasible, so RED is still admitted
  // directly ahead of fixed BLUE through the normal search rather than
  // being deferred to evaluate from BLUE's outgoing state.
  const red = scheduledTask('capacity-fallback-red', 1, 'RED', '2026-08-03T08:30:00');
  const fixedBlue = scheduledTask(
    'capacity-fallback-fixed-blue', 1, 'BLUE', '2026-08-03T09:15:00',
    '2026-08-03T09:15:00', '2026-08-03T10:15:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 30),
    setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([red, fixedBlue], { firmedIds: ['capacity-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );
    const redPatch = patchFor(result, 'capacity-fallback-red');

    assert.equal(patchFor(result, 'capacity-fallback-fixed-blue'), undefined, `${label} preserves fixed BLUE`);
    assert.ok(redPatch, `${label} still schedules RED`);
    assert.equal(redPatch.changes.start_date.getTime(), at('2026-08-03T10:15:00').getTime(),
      `${label} retries RED after the protected incoming setup reservation`);
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('setup-aware evaluators admit the full pre-fixed sequence directly, skipping its uncovered outgoing fixed transition', () => {
  // Never-freeze semantics (Part 1f): A -> B is fully covered internally
  // (YELLOW -> RED), and B -> fixed BLUE being uncovered no longer
  // disqualifies the sequence — it is admitted as a whole directly through
  // the normal search, contiguous, ahead of the fixed run.
  const a = scheduledTask('suffix-fallback-a-yellow', 0.5, 'YELLOW', '2026-08-03T08:30:00');
  const b = scheduledTask('suffix-fallback-b-red', 0.5, 'RED', '2026-08-03T08:45:00');
  const fixedBlue = scheduledTask(
    'suffix-fallback-fixed-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'YELLOW', 0), setupRow('YELLOW', 'RED', 0),
    setupRow('YELLOW', 'BLUE', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([b, fixedBlue, a], { firmedIds: ['suffix-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.equal(patchFor(result, 'suffix-fallback-a-yellow').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
      `${label} preserves the feasible pre-fixed prefix`);
    assert.equal(patchFor(result, 'suffix-fallback-b-red').changes.start_date.getTime(), at('2026-08-03T08:30:00').getTime(),
      `${label} admits B directly after A, ahead of the fixed run`);
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('unknown-state anchor preservation reports an active later-predecessor override targeting the anchor as inactive', () => {
  // Production change caught: filtering the preserved BLUE anchor out of the
  // mutable fragment hides a stale RED -> BLUE binding. BLUE -> RED remains a
  // safe physical sequence, but the now-impossible binding must be reported.
  const anchor = scheduledTask(
    'anchor-target-blue', 1, 'BLUE', '2026-08-03T09:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const laterRed = scheduledTask(
    'anchor-target-later-red', 1, 'RED', '2026-08-03T12:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    current: null,
    rows: [setupRow('BLUE', 'RED', 0)],
    overrides: [{
      id: 'anchor-target-stale-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'anchor-target-later-red', successor_order_id: 'anchor-target-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'later work cannot precede the preserved anchor',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([laterRed, anchor], { firmedIds: [anchor.id] }), dueDateBounds(setup));

    assert.equal(patchFor(result, 'anchor-target-blue'), undefined, `${label} preserves BLUE as the physical anchor`);
    assert.equal(result.dispositions.find(d => d.id === 'anchor-target-later-red').status, 'scheduled',
      `${label} retains the valid current interval and reports the stale override`);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'anchor-target-later-red'
      && edge.successorOrderId === 'anchor-target-blue'
      && edge.reason === 'override-inactive'
    )), `${label} does not silently omit the stale anchor override`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'override-inactive' && reason.taskId === 'anchor-target-blue'
    )), `${label} exposes the stale anchor override in explanation data`);
  }
});

test('fixed-boundary failure retains preserved-anchor and stale-override diagnostics', () => {
  // Production change caught: boundary early returns replace accumulated
  // unknown-current-state and stale-binding diagnostics with only the final
  // fixed failure. Both facts remain relevant to a rejected detached result.
  const anchor = scheduledTask(
    'early-exit-anchor-blue', 1, 'BLUE', '2026-08-03T09:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const fixedRed = scheduledTask(
    'early-exit-fixed-red', 1, 'RED', '2026-08-03T11:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    current: null,
    rows: [],
    overrides: [{
      id: 'early-exit-stale-fixed', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-early-exit-green', successor_order_id: 'early-exit-fixed-red',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'deleted predecessor fixture',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([fixedRed, anchor], { firmedIds: ['early-exit-fixed-red'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(scheduledPatches(result), [], `${label} retains the failed fixed boundary`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => (
      edge.successorOrderId === 'early-exit-anchor-blue' && edge.reason === 'initial-state-unknown'
    )), `${label} keeps the preserved-anchor diagnostic`);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'deleted-early-exit-green'
      && edge.successorOrderId === 'early-exit-fixed-red'
      && edge.reason === 'override-inactive'
    )), `${label} keeps the stale override diagnostic`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'admitted-state-unrecorded' && reason.taskId === 'early-exit-anchor-blue'
    )), `${label} keeps the preserved-anchor explanation`);
    assert.ok(result.explanation.some(reason => reason.code === 'override-inactive'),
      `${label} keeps the stale override explanation`);
  }
});

test('setup-aware evaluators honor a configured partial_allowed plant policy', () => {
  // Production change caught: hard-coding `never` in the detached evaluator
  // rejects a two-hour order that has two valid one-hour operating windows.
  const blue = scheduledTask('partial-policy-blue', 2, 'BLUE', '2026-08-04T09:00:00');
  const oneHourWindows = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 9]]));
  const snapshot = setupSnapshot([blue]);
  snapshot.calendars = { L1: { workHours: oneHourWindows } };
  snapshot.plants = { P1: { workHours: oneHourWindows } };
  snapshot.masterData = {
    plants: [{ plant: 'P1', split_order_policy: 'partial_allowed' }],
    lines: [{ plant: 'P1', machine: 'L1' }],
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-04T09:00:00') }));
    const patch = patchFor(result, 'partial-policy-blue');

    assert.ok(patch, `${label} routes the configured plant policy into detached placement`);
    assert.equal(patch.changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.equal(patch.changes.end_date.getTime(), at('2026-08-04T09:00:00').getTime());
    assert.deepEqual(patch.changes.scheduleSegments.map(segment => [segment.startDate, segment.endDate]), [
      [at('2026-08-03T08:00:00'), at('2026-08-03T09:00:00')],
      [at('2026-08-04T08:00:00'), at('2026-08-04T09:00:00')],
    ]);
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('setup-aware evaluators derive immutable overlong_only eligibility from snapshot operating windows', () => {
  // Production change caught: forwarding overlong_only without its immutable
  // nominal-window eligibility silently behaves as never. Two one-hour days
  // make this two-hour order inherently overlong, so it may split.
  const blue = scheduledTask('overlong-policy-blue', 2, 'BLUE', '2026-08-04T09:00:00');
  const oneHourWindows = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 9]]));
  const snapshot = setupSnapshot([blue]);
  snapshot.calendars = { L1: { workHours: oneHourWindows } };
  snapshot.plants = { P1: { workHours: oneHourWindows } };
  snapshot.masterData = {
    plants: [{ plant: 'P1', split_order_policy: 'overlong_only' }],
    lines: [{ plant: 'P1', machine: 'L1' }],
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-04T09:00:00') }));
    const patch = patchFor(result, 'overlong-policy-blue');

    assert.ok(patch, `${label} recognizes the order as inherently overlong from the snapshot`);
    assert.deepEqual(patch.changes.scheduleSegments.map(segment => [segment.startDate, segment.endDate]), [
      [at('2026-08-03T08:00:00'), at('2026-08-03T09:00:00')],
      [at('2026-08-04T08:00:00'), at('2026-08-04T09:00:00')],
    ]);
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('split-policy orders that cross an interval boundary keep their segments and setup (T3 guard)', () => {
  // Pins placement behavior that any early-exit in free-interval building must
  // preserve: a split-eligible order must see every window, not just the first
  // that could hold part of it. Mon is open 08-10 only, other days 08-12; a
  // 5-hour order (longer than any nominal window, so inherently overlong) after
  // a 30-minute setup cannot finish on Monday, so it must span Monday and Tuesday.
  const hours = { ...Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 12]])), 1: [8, 10] };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 30)] });
  for (const policy of ['partial_allowed', 'overlong_only']) {
    const blue = scheduledTask('t3-split-' + policy, 5, 'BLUE', '2026-08-05T12:00:00');
    const snapshot = setupSnapshot([blue]);
    snapshot.calendars = { L1: { workHours: hours } };
    snapshot.plants = { P1: { workHours: hours } };
    snapshot.masterData = {
      plants: [{ plant: 'P1', split_order_policy: policy }],
      lines: [{ plant: 'P1', machine: 'L1' }],
    };
    for (const [label, evaluate] of [
      ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
      ['SPT', SetupScheduler.evaluateSptWithSetup],
    ]) {
      const result = evaluate(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-05T12:00:00') }));
      const patch = patchFor(result, blue.id);
      assert.ok(patch, label + '/' + policy + ' places the split order');
      assert.deepEqual(patch.changes.scheduleSegments.map(segment => [segment.startDate, segment.endDate]), [
        [at('2026-08-03T08:30:00'), at('2026-08-03T10:00:00')],
        [at('2026-08-04T08:00:00'), at('2026-08-04T11:30:00')],
      ], label + '/' + policy + ' segments');
      assert.equal(patch.changes.start_date.getTime(), at('2026-08-03T08:30:00').getTime());
      assert.equal(patch.changes.end_date.getTime(), at('2026-08-04T11:30:00').getTime());
    }
  }
});

test('a continuous order that does not fit the first free interval lands in the second (T3 guard)', () => {
  // Monday offers only 2 hours; the 3-hour order after a 30-minute setup needs
  // 3.5 contiguous hours, so it must start at Tuesday 08:00 (setup 08:00-08:30).
  const hours = { ...Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 14]])), 1: [8, 10] };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 30)] });
  const blue = scheduledTask('t3-continuous-blue', 3, 'BLUE', '2026-08-05T14:00:00');
  const snapshot = setupSnapshot([blue]);
  snapshot.calendars = { L1: { workHours: hours } };
  snapshot.plants = { P1: { workHours: hours } };
  snapshot.masterData = {
    plants: [{ plant: 'P1', split_order_policy: 'never' }],
    lines: [{ plant: 'P1', machine: 'L1' }],
  };
  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-05T14:00:00') }));
    const patch = patchFor(result, blue.id);
    assert.ok(patch, label + ' places the continuous order');
    assert.equal(patch.changes.start_date.getTime(), at('2026-08-04T08:30:00').getTime(), label + ' start');
    assert.equal(patch.changes.end_date.getTime(), at('2026-08-04T11:30:00').getTime(), label + ' end');
  }
});

test('setup-aware evaluators never schedule through a fixed boundary beyond the caller horizon', () => {
  // Production change caught: retaining an out-of-horizon fixed BLUE makes
  // its noon start leak into a caller horizon ending at 10:00. RED cannot fit
  // before the cutoff and must remain unadmitted rather than schedule at noon.
  const red = scheduledTask('bounded-horizon-red', 3, 'RED', '2026-08-03T09:00:00');
  const fixedBlue = scheduledTask(
    'bounded-horizon-fixed-blue', 1, 'BLUE', '2026-08-03T13:00:00',
    '2026-08-03T12:00:00', '2026-08-03T13:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
  ] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([red, fixedBlue], { firmedIds: ['bounded-horizon-fixed-blue'] }),
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
    );

    // Never-freeze semantics: RED genuinely has no capacity (a real 3-hour
    // order against a 2-hour window), so it still cannot be patched — but
    // that is a capacity fact surfaced via the tail-placement diagnostic,
    // not the line being reported as frozen/unchanged.
    assert.deepEqual(scheduledPatches(result), [], `${label} does not emit work beyond the caller horizon`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.explanation.some(reason => (
      reason.taskId === 'bounded-horizon-red' && reason.message.includes('current dates')
    )), `${label} reports the capacity-starved order left at its current dates`);
  }
});

test('due-date fallback admits the fully-covered internal pair before fixed work, skipping the unverified boundary reservation', () => {
  // Never-freeze semantics (Part 1f): RED -> BLUE is uncovered so that
  // permutation fails outright, but BLUE -> RED is fully covered
  // internally. The only uncovered edge left is the outgoing RED -> fixed
  // YELLOW transition, which no longer disqualifies the candidate — it now
  // only skips the reservation and stays a diagnostic, so BOTH orders are
  // admitted together ahead of the fixed run instead of RED being deferred
  // past it.
  const red = scheduledTask('fallback-choice-red', 1, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('fallback-choice-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const fixedYellow = scheduledTask(
    'fallback-choice-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('BLUE', 'RED', 0), setupRow('BLUE', 'YELLOW', 0),
    setupRow('GREEN', 'YELLOW', 0), setupRow('YELLOW', 'RED', 0), setupRow('YELLOW', 'BLUE', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([red, fixedYellow, blue], { firmedIds: ['fallback-choice-fixed-yellow'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'fallback-choice-fixed-yellow'), undefined, 'fixed YELLOW stays immutable');
  assert.equal(patchFor(result, 'fallback-choice-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'BLUE is admitted first (its covered internal transition into RED)');
  assert.equal(patchFor(result, 'fallback-choice-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
    'RED is admitted immediately after BLUE, ahead of fixed YELLOW');
  assert.deepEqual(result.unchangedLines, []);
});

test('due-date final-boundary fallback: the fully covered protected pair is admitted, and the demoted order is tail-placed', () => {
  // Never-freeze semantics (A1/A2): RED -> ORANGE is a protected active
  // override pair (adjacency must stay together), and BLUE cannot chain with
  // either (no BLUE<->RED/ORANGE row), so no single sequence covers all
  // three internally — one internal edge is always uncovered. The coverage-
  // demotion backstop is gone; instead the priority list (colorWheel: BLUE=1,
  // RED/ORANGE=2) puts BLUE first since `policyKey` is compared before the
  // coverage tier, so BLUE is admitted normally (GREEN -> BLUE, covered),
  // then RED is admitted into the sequence at zero setup minutes (BLUE ->
  // RED has no matrix row), then the protected ORANGE follows RED via the
  // override's covered adjacency. All three land before the fixed boundary —
  // RED and ORANGE both shift 1 hour later than the old tail-demotion
  // fixture expected, since they now sit directly behind BLUE's real hour
  // of production instead of being placed independently at the fragment's
  // earliest cursor.
  const red = scheduledTask('complete-fallback-red', 0.5, 'RED', '2026-08-03T08:30:00');
  const orange = scheduledTask('complete-fallback-orange', 0.5, 'ORANGE', '2026-08-03T08:45:00');
  const blue = scheduledTask('complete-fallback-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const fixed = scheduledTask(
    'complete-fallback-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
      setupRow('BLUE', 'YELLOW', 0), setupRow('RED', 'YELLOW', 0),
      setupRow('YELLOW', 'RED', 0), setupRow('YELLOW', 'BLUE', 0),
    ],
    overrides: [{
      id: 'complete-fallback-protected-red-orange', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'complete-fallback-red', successor_order_id: 'complete-fallback-orange',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('ORANGE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'component fixture',
    }],
  });
  const snapshot = setupSnapshot([red, fixed, orange, blue], { firmedIds: ['complete-fallback-fixed-yellow'] });
  snapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 1, RED: 2, ORANGE: 2 } } };

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.equal(patchFor(result, 'complete-fallback-fixed-yellow'), undefined, 'fixed YELLOW remains immutable');
  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), [
    'complete-fallback-blue', 'complete-fallback-orange', 'complete-fallback-red',
  ]);
  assert.equal(patchFor(result, 'complete-fallback-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'BLUE (higher priority-list rank) is admitted first, ahead of fixed work');
  assert.equal(patchFor(result, 'complete-fallback-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
    'the protected RED -> ORANGE pair follows BLUE, still ahead of fixed work');
  assert.equal(patchFor(result, 'complete-fallback-orange').changes.start_date.getTime(), at('2026-08-03T09:30:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-without-setup' && reason.taskId === 'complete-fallback-red'
  )), 'RED is admitted into the sequence at zero setup minutes instead of being demoted and tail-placed');
});

test('due-date final-boundary fallback: BLUE is admitted through the fixed boundary, and the demoted RED/ORANGE chain is tail-placed', () => {
  // Never-freeze semantics (A1/A2): BLUE -> fixed YELLOW is fully covered
  // (with a real reservation), while GREEN (the line's initial state) has no
  // row into RED or ORANGE directly. But RED -> ORANGE -> BLUE -> YELLOW is a
  // fully-covered chain once GREEN transitions into it, so the coverage tier
  // now prefers sequencing RED and ORANGE FIRST (accepting exactly one
  // uncovered edge, GREEN -> RED, the unavoidable entry point) and placing
  // BLUE last, immediately ahead of the fixed boundary — the reverse order
  // from the old tail-demotion fixture, which put BLUE first and pushed
  // RED/ORANGE to the tail (2 uncovered edges: GREEN -> BLUE was covered,
  // but neither RED nor ORANGE chains from BLUE at all). The new order has
  // strictly fewer uncovered edges, which is exactly what the coverage tier
  // optimizes for.
  const red = scheduledTask('non-contiguous-fallback-red', 0.5, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('non-contiguous-fallback-blue', 0.5, 'BLUE', '2026-08-03T09:30:00');
  const orange = scheduledTask('non-contiguous-fallback-orange', 0.5, 'ORANGE', '2026-08-03T09:45:00');
  const fixedYellow = scheduledTask(
    'non-contiguous-fallback-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0), setupRow('GREEN', 'YELLOW', 0),
    setupRow('YELLOW', 'RED', 0), setupRow('RED', 'ORANGE', 0), setupRow('ORANGE', 'BLUE', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([red, fixedYellow, blue, orange], { firmedIds: ['non-contiguous-fallback-fixed-yellow'] }),
    dueDateBounds(setup, { iterationCap: 512 }),
  );

  assert.equal(patchFor(result, 'non-contiguous-fallback-fixed-yellow'), undefined, 'fixed YELLOW remains immutable');
  assert.equal(patchFor(result, 'non-contiguous-fallback-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'RED is admitted first (the unavoidable uncovered entry from GREEN)');
  assert.equal(patchFor(result, 'non-contiguous-fallback-orange').changes.start_date.getTime(), at('2026-08-03T08:30:00').getTime(),
    'ORANGE follows RED via a covered transition');
  assert.equal(patchFor(result, 'non-contiguous-fallback-blue').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
    'BLUE is admitted last, immediately ahead of the fixed boundary via a covered transition');
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-without-setup' && reason.taskId === 'non-contiguous-fallback-red'
  )), 'RED is admitted into the sequence at zero setup minutes instead of being demoted and tail-placed');
});

test('due-date earlier fixed-boundary fallback fails closed when multiple local routes are feasible', () => {
  // Superseded by A7: `firmed-boundary-fallback-ambiguous` used to freeze the
  // whole line here (the one fail-closed path the earlier never-freeze pass
  // deliberately left alone, since ranking between multiple locally-feasible
  // routes needs a full branching planner this detached evaluator doesn't
  // have). A7 closes that last freeze path — genuine ambiguity about *which*
  // covered route to pick is no longer a reason to leave the orders
  // unscheduled. Separately, A1/A2's coverage tier now also picks a route
  // outright before the ambiguity guard is even reached: RED -> YELLOW and
  // BLUE -> YELLOW are both covered here, so both orders are admitted
  // directly in front of the first fixed run (RED -> BLUE has no matrix row,
  // so BLUE is admitted-without-setup) rather than either freezing or
  // falling back to a single-route search. This test now asserts the
  // never-freeze outcome instead of the retired freeze.
  const red = scheduledTask('ambiguous-earlier-red', 1, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('ambiguous-earlier-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const firstFixed = scheduledTask(
    'ambiguous-earlier-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const secondFixed = scheduledTask(
    'ambiguous-earlier-fixed-purple', 1, 'PURPLE', '2026-08-03T13:00:00',
    '2026-08-03T13:00:00', '2026-08-03T14:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('RED', 'YELLOW', 0), setupRow('BLUE', 'YELLOW', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([red, firstFixed, blue, secondFixed], {
      firmedIds: ['ambiguous-earlier-fixed-yellow', 'ambiguous-earlier-fixed-purple'],
    }),
    dueDateBounds(setup),
  );

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['ambiguous-earlier-blue', 'ambiguous-earlier-red']);
  assert.equal(patchFor(result, 'ambiguous-earlier-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(patchFor(result, 'ambiguous-earlier-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.explanation.some(reason => reason.code === 'firmed-boundary-fallback-ambiguous'), false,
    'the ambiguity freeze path no longer fires; both orders are admitted instead');
});

test('due-date earlier fixed-boundary fallback proceeds when exactly one local route is feasible', () => {
  // Regression guard for the new coverage tier (A2): kept deliberately, per
  // plan directive, as the one test proving a FULLY-COVERED route beats a
  // route with uncovered edges. RED -> YELLOW has no matrix row (only
  // BLUE -> YELLOW is covered), so any sequence ending with RED immediately
  // before the fixed boundary carries one more uncovered edge than a
  // sequence ending with BLUE there. The coverage tier (score[6], compared
  // right after policyKey) makes the search prefer [RED, BLUE] — RED
  // admitted-without-setup from GREEN, then BLUE covered into the fixed
  // boundary — over [BLUE, RED], which would tally two uncovered edges
  // (BLUE -> RED internally, then RED -> YELLOW at the boundary). This is a
  // different winning order than the old single-route-fallback fixture (which
  // put BLUE first and deferred RED past the boundary entirely): now RED and
  // BLUE are both admitted together ahead of the fixed run, with BLUE last so
  // it is the one that actually enters YELLOW via a covered transition.
  const red = scheduledTask('unique-earlier-red', 1, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('unique-earlier-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const firstFixed = scheduledTask(
    'unique-earlier-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const secondFixed = scheduledTask(
    'unique-earlier-fixed-purple', 1, 'PURPLE', '2026-08-03T13:00:00',
    '2026-08-03T13:00:00', '2026-08-03T14:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('BLUE', 'YELLOW', 0),
    setupRow('YELLOW', 'RED', 0), setupRow('RED', 'PURPLE', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([red, firstFixed, blue, secondFixed], {
      firmedIds: ['unique-earlier-fixed-yellow', 'unique-earlier-fixed-purple'],
    }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'unique-earlier-fixed-yellow'), undefined);
  assert.equal(patchFor(result, 'unique-earlier-fixed-purple'), undefined);
  assert.equal(patchFor(result, 'unique-earlier-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'RED (admitted without setup) is sequenced first');
  assert.equal(patchFor(result, 'unique-earlier-blue').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
    'BLUE is sequenced last, immediately ahead of the fixed boundary, via the only fully-covered route');
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.explanation.some(reason => reason.code === 'firmed-boundary-fallback-ambiguous'), false);
});

test('setup-aware evaluators preserve active relations crossing a strictly post-horizon fixed boundary', () => {
  // This fails when filtering a fixed run after the hard horizon also erases
  // active physical adjacency constraints. A valid pair is not inactive just
  // because this candidate cannot safely include its fixed endpoint; leave
  // the line unchanged rather than placing one side inside the horizon.
  const cases = [
    {
      label: 'free predecessor to fixed successor',
      tasks: [
        scheduledTask('post-horizon-before-blue', 0.5, 'BLUE', '2026-08-03T08:30:00'),
        scheduledTask('post-horizon-other-red', 0.5, 'RED', '2026-08-03T09:00:00'),
        scheduledTask(
          'post-horizon-fixed-yellow', 1, 'YELLOW', '2026-08-03T13:00:00',
          '2026-08-03T12:00:00', '2026-08-03T13:00:00',
        ),
      ],
      predecessorOrderId: 'post-horizon-before-blue',
      successorOrderId: 'post-horizon-fixed-yellow',
      predecessorState: 'BLUE',
      successorState: 'YELLOW',
      rows: [setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0), setupRow('BLUE', 'YELLOW', 0)],
    },
    {
      label: 'fixed predecessor to free successor',
      tasks: [
        scheduledTask('post-horizon-before-blue-2', 0.5, 'BLUE', '2026-08-03T08:30:00'),
        scheduledTask('post-horizon-after-red', 0.5, 'RED', '2026-08-03T09:00:00'),
        scheduledTask(
          'post-horizon-fixed-yellow-2', 1, 'YELLOW', '2026-08-03T13:00:00',
          '2026-08-03T12:00:00', '2026-08-03T13:00:00',
        ),
      ],
      predecessorOrderId: 'post-horizon-fixed-yellow-2',
      successorOrderId: 'post-horizon-after-red',
      predecessorState: 'YELLOW',
      successorState: 'RED',
      rows: [setupRow('GREEN', 'BLUE', 0), setupRow('GREEN', 'RED', 0), setupRow('YELLOW', 'RED', 0)],
    },
    {
      label: 'free component chained into fixed successor',
      tasks: [
        scheduledTask('post-horizon-chain-blue', 0.5, 'BLUE', '2026-08-03T08:30:00'),
        scheduledTask('post-horizon-chain-red', 0.5, 'RED', '2026-08-03T09:00:00'),
        scheduledTask(
          'post-horizon-fixed-yellow-3', 1, 'YELLOW', '2026-08-03T13:00:00',
          '2026-08-03T12:00:00', '2026-08-03T13:00:00',
        ),
      ],
      predecessorOrderId: 'post-horizon-chain-red',
      successorOrderId: 'post-horizon-fixed-yellow-3',
      predecessorState: 'RED',
      successorState: 'YELLOW',
      rows: [setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0), setupRow('RED', 'YELLOW', 0)],
      additionalOverrides: [{
        id: 'post-horizon-chain-free-pair', machine: 'L1', signature_version: 1,
        predecessor_order_id: 'post-horizon-chain-blue', successor_order_id: 'post-horizon-chain-red',
        predecessor_state_key: setupState('BLUE'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected free component fixture',
      }],
    },
  ];

  for (const fixture of cases) {
    const override = {
      id: `post-horizon-${fixture.label}`, machine: 'L1', signature_version: 1,
      predecessor_order_id: fixture.predecessorOrderId, successor_order_id: fixture.successorOrderId,
      predecessor_state_key: setupState(fixture.predecessorState), successor_state_key: setupState(fixture.successorState),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'post-horizon fixed boundary fixture',
    };
    const setup = setupTruth({ rows: fixture.rows, overrides: [override, ...(fixture.additionalOverrides ?? [])] });
    for (const [mode, evaluate] of [
      ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
      ['SPT', SetupScheduler.evaluateSptWithSetup],
    ]) {
      const result = evaluate(
        setupSnapshot(fixture.tasks, { firmedIds: [fixture.tasks.at(-1).id] }),
        dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
      );

      assert.deepEqual(scheduledPatches(result), [], `${mode} preserves ${fixture.label}`);
      assert.deepEqual(result.unchangedLines, ['L1']);
      assert.ok(result.missingEdges.some(edge => (
        edge.predecessorOrderId === fixture.predecessorOrderId
        && edge.successorOrderId === fixture.successorOrderId
        && edge.reason === 'protected-firmed-boundary-outside-horizon'
      )), `${mode} reports the retained boundary constraint`);
      assert.equal(result.missingEdges.some(edge => (
        edge.predecessorOrderId === fixture.predecessorOrderId
        && edge.successorOrderId === fixture.successorOrderId
        && edge.reason === 'override-inactive'
      )), false, `${mode} does not mislabel the valid protected pair inactive`);
    }
  }
});

test('setup-aware evaluators diagnose stale post-horizon override bindings as inactive', () => {
  // These bindings name a fixed order beyond the detached horizon, but no
  // longer describe its real physical relation. They must remain visible as
  // inactive diagnostics rather than being mistaken for protected work.
  const cases = [
    {
      label: 'state-mismatched fixed endpoint',
      predecessorOrderId: 'post-horizon-stale-blue',
      successorOrderId: 'post-horizon-stale-fixed-yellow',
      predecessorState: 'BLUE',
      successorState: 'PURPLE',
      tasks: [
        scheduledTask('post-horizon-stale-blue', 0.5, 'BLUE', '2026-08-03T08:30:00'),
        scheduledTask(
          'post-horizon-stale-fixed-yellow', 1, 'YELLOW', '2026-08-03T13:00:00',
          '2026-08-03T12:00:00', '2026-08-03T13:00:00',
        ),
      ],
      fixedId: 'post-horizon-stale-fixed-yellow',
    },
    {
      label: 'missing counterpart',
      predecessorOrderId: 'post-horizon-missing-fixed-yellow',
      successorOrderId: 'post-horizon-missing-deleted-red',
      predecessorState: 'YELLOW',
      successorState: 'RED',
      tasks: [
        scheduledTask('post-horizon-missing-blue', 0.5, 'BLUE', '2026-08-03T08:30:00'),
        scheduledTask(
          'post-horizon-missing-fixed-yellow', 1, 'YELLOW', '2026-08-03T13:00:00',
          '2026-08-03T12:00:00', '2026-08-03T13:00:00',
        ),
      ],
      fixedId: 'post-horizon-missing-fixed-yellow',
    },
  ];

  for (const fixture of cases) {
    const setup = setupTruth({
      rows: [setupRow('GREEN', 'BLUE', 0)],
      overrides: [{
        id: `post-horizon-stale-${fixture.label}`, machine: 'L1', signature_version: 1,
        predecessor_order_id: fixture.predecessorOrderId, successor_order_id: fixture.successorOrderId,
        predecessor_state_key: setupState(fixture.predecessorState), successor_state_key: setupState(fixture.successorState),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'stale post-horizon fixture',
      }],
    });
    for (const [mode, evaluate] of [
      ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
      ['SPT', SetupScheduler.evaluateSptWithSetup],
    ]) {
      const result = evaluate(
        setupSnapshot(fixture.tasks, { firmedIds: [fixture.fixedId] }),
        dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
      );

      assert.deepEqual(result.unchangedLines, [], `${mode} keeps unrelated mutable work eligible for ${fixture.label}`);
      assert.ok(result.missingEdges.some(edge => (
        edge.predecessorOrderId === fixture.predecessorOrderId
        && edge.successorOrderId === fixture.successorOrderId
        && edge.reason === 'override-inactive'
      )), `${mode} exposes ${fixture.label} as an inactive override`);
      assert.equal(result.missingEdges.some(edge => (
        edge.predecessorOrderId === fixture.predecessorOrderId
        && edge.successorOrderId === fixture.successorOrderId
        && edge.reason === 'protected-firmed-boundary-outside-horizon'
      )), false, `${mode} does not protect a stale ${fixture.label} binding`);
    }
  }
});

test('setup-aware evaluators retain a fixed order at horizonEnd as the terminal incoming boundary and still place RED', () => {
  // This still fails when `start >= horizonEnd` removes a fixed order whose
  // incoming setup belongs to the candidate horizon (the terminal-boundary
  // recognition itself is unchanged). But never-freeze semantics (Part 1f)
  // mean an uncovered RED -> fixed BLUE transition no longer disqualifies
  // the candidate — it just skips the reservation and stays a diagnostic —
  // so RED is scheduled directly rather than the line staying frozen.
  const red = scheduledTask('horizon-terminal-red', 1, 'RED', '2026-08-03T09:00:00');
  const fixedBlue = scheduledTask(
    'horizon-terminal-fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0)] });
  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([red, fixedBlue], { firmedIds: ['horizon-terminal-fixed-blue'] }),
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
    );

    assert.equal(patchFor(result, 'horizon-terminal-fixed-blue'), undefined, `${label} never patches the fixed run`);
    assert.equal(patchFor(result, 'horizon-terminal-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.deepEqual(result.unchangedLines, []);
  }
});

test('due-date search retains uncovered rejected alternatives for exact and greedy paths', () => {
  // A1 changed what "rejected" means: a plain mid-sequence uncovered
  // transition is no longer rejected at all — it is admitted via
  // 'scheduled-without-setup', so a losing permutation whose only uncovered
  // edge is an ordinary internal transition is simply a feasible-but-losing
  // candidate with nothing to report as "rejected". `UNCOVERED_SETUP_
  // TRANSITION_REASON` (the reason `appendRejectedCoverageDiagnostics` keys
  // on for 'rejected-uncovered-transition') still fires only for the
  // fixed-boundary incoming-setup leniency (Part 1f), which predates A1 and
  // is unaffected by it. So this fixture now needs a fixed boundary to
  // exercise the "retain the losing alternative's diagnostic" path at all: a
  // fully-covered RED -> BLUE -> fixed-YELLOW route wins outright (0
  // uncovered edges), while the losing BLUE -> RED -> fixed-YELLOW
  // permutation is feasible too but carries an uncovered RED -> YELLOW
  // boundary edge — that edge is what must survive as a
  // 'rejected-uncovered-transition' diagnostic for planner review, distinct
  // from the winner's own (fully-covered) edges. SPT is deliberately
  // excluded because it does not explore alternate orders.
  const red = scheduledTask('rejected-edge-red', 1, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('rejected-edge-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const fixedYellow = scheduledTask(
    'rejected-edge-fixed-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T10:00:00', '2026-08-03T11:00:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('RED', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0),
  ] });

  for (const [label, threshold] of [['exact', 6], ['greedy', 0]]) {
    const result = SetupScheduler.evaluateDueDateFirst(
      setupSnapshot([red, fixedYellow, blue], { firmedIds: ['rejected-edge-fixed-yellow'] }),
      dueDateBounds(setup, { exactSearchThreshold: threshold }),
    );
    const rejectedEdges = result.missingEdges.filter(edge => (
      edge.predecessorOrderId === 'rejected-edge-red'
      && edge.successorOrderId === 'rejected-edge-fixed-yellow'
      && edge.reason === 'No version-matched setup transition covers this state pair'
    ));

    assert.deepEqual(result.unchangedLines, [], `${label} retains the fully-covered RED -> BLUE -> fixed route`);
    assert.equal(patchFor(result, 'rejected-edge-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.equal(patchFor(result, 'rejected-edge-blue').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime());
    assert.equal(rejectedEdges.length, 1, `${label} exposes one rejected uncovered edge from the losing permutation`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'rejected-uncovered-transition' && reason.taskId === 'rejected-edge-fixed-yellow'
    )), `${label} supplies a concise rejected-edge explanation`);
  }
});

// ---------------------------------------------------------------------------
// Part 4 (new): never-freeze tail placement, in-sequence uncovered admission,
// nullable initial-state chaining, and the search-budget fixes (2a/2b).
// ---------------------------------------------------------------------------

test('placeUnknownTail orders the tail by policy tier first, then due date, across day buckets', () => {
  // Three unresolvable-state orders (blank COLOR under strict_blanks) with
  // due dates spanning three different days. A high-tier PRT_01 rank must
  // still place its order first even though its due date is the latest;
  // within the low tier, due date breaks the tie.
  const highTierLateDue = scheduledTask('tail-order-a', 1, '', '2026-08-05T09:00:00');
  const lowTierEarlyDue = scheduledTask('tail-order-b', 1, '', '2026-08-03T09:00:00');
  const lowTierLateDue = scheduledTask('tail-order-c', 1, '', '2026-08-04T09:00:00');
  highTierLateDue.PRT_01 = 'HIGH';
  lowTierEarlyDue.PRT_01 = 'LOW';
  lowTierLateDue.PRT_01 = 'LOW';
  const setup = setupTruth({ rows: [] });
  const snapshot = setupSnapshot([lowTierEarlyDue, lowTierLateDue, highTierLateDue]);
  snapshot.masterData.plants[0].constraints = [{ key: 'prt01', order: 0, enabled: true }];
  snapshot.priorityRankMaps = { '': { prt01: { HIGH: 1, LOW: 2 } } };

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id), [
    'tail-order-a', 'tail-order-b', 'tail-order-c',
  ], 'policy tier dominates due date, then due date orders within a tier');
  assert.deepEqual(result.unchangedLines, []);
  for (const id of ['tail-order-a', 'tail-order-b', 'tail-order-c']) {
    assert.ok(result.explanation.some(reason => (
      ['unknown-setup-tail-placement', 'initial-state-unknown', 'admitted-state-unrecorded'].includes(reason.code) && reason.taskId === id
    )));
  }
});

test('the unknown tail is placed back-to-back with no setup gap and charges no setup minutes', () => {
  // Three unresolvable-state orders placed via the same zero-minute
  // placement mechanism must be strictly contiguous (each starts exactly
  // where the previous ends) and the overall candidate score's setup-minutes
  // slot (score[5]) must stay at 0 — never freeze must never charge a fake
  // changeover for a transition nobody actually knows.
  const a = scheduledTask('gap-check-a', 1, '', '2026-08-03T09:00:00');
  const b = scheduledTask('gap-check-b', 1, '', '2026-08-03T09:30:00');
  const c = scheduledTask('gap-check-c', 1, '', '2026-08-03T10:00:00');
  const setup = setupTruth({ rows: [] });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([c, a, b]), dueDateBounds(setup));

  const ordered = ['gap-check-a', 'gap-check-b', 'gap-check-c'].map(id => patchFor(result, id)).sort((a, b) => a.changes.start_date - b.changes.start_date);
  assert.ok(ordered.every(Boolean), 'every order is scheduled');
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(
      ordered[index].changes.start_date.getTime(),
      ordered[index - 1].changes.end_date.getTime(),
      'each tail order starts exactly where the previous one ends: no setup gap',
    );
  }
  assert.equal(result.score[5], 0, 'no setup minutes are charged for unknown-tail placement');
  // Unknown signatures stay separate from known uncovered matrix transitions.
  for (const id of ['gap-check-a', 'gap-check-b', 'gap-check-c']) {
    assert.ok(result.missingEdges.some(edge => edge.reason === 'successor-state-unknown' && edge.successorOrderId === id));
  }
});

test('unknown-tail overflow before a fixed boundary defers the overflowing order past it', () => {
  // Two unresolvable-state orders together need more room than the pre-fixed
  // gap allows; the one that does not fit must defer to after the fixed run
  // rather than the line freezing or the overflow being silently dropped.
  const first = scheduledTask('overflow-a', 1, '', '2026-08-03T08:15:00');
  const second = scheduledTask('overflow-b', 1, '', '2026-08-03T08:30:00');
  const fixed = scheduledTask(
    'overflow-fixed', 1, 'BLUE', '2026-08-03T09:30:00',
    '2026-08-03T09:30:00', '2026-08-03T10:30:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([first, second, fixed], { firmedIds: ['overflow-fixed'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'overflow-fixed'), undefined, 'the fixed run is never patched');
  assert.deepEqual(['overflow-a', 'overflow-b'].map(id => patchFor(result, id).changes.start_date.getTime()).sort((a, b) => a - b),
    [at('2026-08-03T08:00:00').getTime(), at('2026-08-03T10:30:00').getTime()], 'one order uses each free fragment without crossing fixed production');
  assert.deepEqual(result.unchangedLines, []);
  // F2/F12: a duplicate-patch bug once made this exact deferred-past-boundary
  // path emit two patches for the same order (admitted concatenated with its
  // own unknownTail subset) — assert every patched id is unique.
  const ids = scheduledPatches(result).map(patch => patch.id);
  assert.equal(new Set(ids).size, ids.length, 'no order is patched twice');
});

test('trailing-fragment tail overflow leaves the order at its current dates with a diagnostic', () => {
  // In the final (trailing) fragment there is nowhere left to defer to. An
  // order that cannot fit stays exactly at its current dates rather than the
  // line freezing or the order silently vanishing.
  const admits = scheduledTask('trail-overflow-a', 1, '', '2026-08-03T08:15:00');
  const staysPut = scheduledTask(
    'trail-overflow-b', 1, '', '2026-08-03T08:30:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const setup = setupTruth({ rows: [] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([admits, staysPut]),
    dueDateBounds(setup, { horizonEnd: at('2026-08-03T09:01:00') }),
  );

  assert.ok(patchFor(result, 'trail-overflow-a'), 'the order that fits is still placed');
  assert.equal(patchFor(result, 'trail-overflow-b'), undefined, 'the overflowing order is not patched at all');
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.taskId === 'trail-overflow-b' && reason.message.includes('current dates')
  )), 'the diagnostic explains the order was left in place for lack of capacity');
});

test('an order whose transitions are uncovered in every permutation stays in the covered core instead of being demoted', () => {
  // The coverage-demotion backstop this test named is deleted (A4): PINK has
  // no matrix row touching it in either direction, so every permutation that
  // includes it carries an uncovered edge — but that no longer disqualifies
  // a permutation (A1), so there is nothing left to "demote" PINK from.
  // Repurposed as the in-sequence counterpart to A1: PINK now stays in the
  // SAME covered-core sequence as RED and BLUE (not appended after it via a
  // separate unknown-tail mechanism), admitted at zero setup minutes via its
  // one unavoidable uncovered edge, while RED -> BLUE's fully covered mutual
  // transition still sequences normally. `appendRejectedCoverageDiagnostics`
  // is no longer involved for this plain (non-fixed-boundary) shape — it
  // only reports UNCOVERED_SETUP_TRANSITION_REASON edges, and A1 changed
  // this shape's reason to 'scheduled-without-setup' instead — so there is
  // no separate "rejected transition" entry to preserve here anymore.
  const good1 = scheduledTask('demo-good-a', 1, 'RED', '2026-08-03T09:00:00');
  const good2 = scheduledTask('demo-good-b', 1, 'BLUE', '2026-08-03T09:30:00');
  const poison = scheduledTask('demo-poison', 1, 'PINK', '2026-08-03T08:15:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0),
    setupRow('RED', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    // Deliberately no row touches PINK in either direction.
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([poison, good1, good2]),
    dueDateBounds(setup),
  );

  const goodA = patchFor(result, 'demo-good-a');
  const goodB = patchFor(result, 'demo-good-b');
  const poisonPatch = patchFor(result, 'demo-poison');
  assert.ok(goodA && goodB && poisonPatch, 'all three orders are still scheduled');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'due-date-first-placement' && reason.taskId === 'demo-good-a'
  )), 'RED is sequenced through the normal covered-core search');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'due-date-first-placement' && reason.taskId === 'demo-good-b'
  )), 'BLUE is sequenced through the normal covered-core search');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-without-setup' && reason.taskId === 'demo-poison'
  )), 'PINK is admitted into the covered-core sequence at zero setup minutes');
  assert.ok(poisonPatch.changes.start_date.getTime() >= goodB.changes.end_date.getTime(),
    'PINK still lands after RED/BLUE (a due-date tie-break, not a separate tail mechanism)');
  assert.deepEqual(result.unchangedLines, []);
  // F1/F12: the uncovered-transition fact that admitted PINK at zero setup
  // minutes must still reach the missing-pairs table via the dedicated
  // 'scheduled-without-setup' reason — the same authority the live toast and
  // OptimizerPreview's tally both read from.
  assert.ok(result.missingEdges.some(edge => (
    edge.reason === 'scheduled-without-setup' && edge.successorOrderId === 'demo-poison'
  )), 'PINK itself is reported via the dedicated scheduled-without-setup reason');
});

test('an override-bound pair stays adjacent when surrounded by uncovered fillers', () => {
  // F4: RED -> ORANGE is a protected active override pair (must stay
  // adjacent). Three mutually-compatible BLUE fillers (same-state implicit
  // -zero transitions between each other, but uncovered against RED/ORANGE
  // in both directions) poison every arrangement that puts them next to the
  // RED/ORANGE block. Because the block's two endpoints face a poisoned
  // neighbor in nearly every explored arrangement while each filler often
  // ends up adjacent to another (compatible) filler instead, RED's own
  // uncovered-edge tally is the single highest of all five orders — proven
  // by instrumenting `mostUncoveredOrderId` directly: without F4's
  // exclusion it tallies bound-demo-red=3 (every other order <=2) and
  // `demoteMostUncoveredOrder` demotes RED itself, which then duplicates
  // RED's patch (it is both "demoted" and left in a later covered-core
  // winner) and collapses the whole fragment to pure unknown-tail
  // placement — nothing gets a real changeover bar, and the override is
  // silently violated. `boundOrderIds` now excludes RED and ORANGE from
  // demotion entirely, so only a filler is ever demoted.
  const red = scheduledTask('bound-demo-red', 1, 'RED', '2026-08-03T09:00:00');
  const orange = scheduledTask('bound-demo-orange', 1, 'ORANGE', '2026-08-03T09:15:00');
  const f1 = scheduledTask('bound-demo-f1', 1, 'BLUE', '2026-08-03T09:30:00');
  const f2 = scheduledTask('bound-demo-f2', 1, 'BLUE', '2026-08-03T09:45:00');
  const f3 = scheduledTask('bound-demo-f3', 1, 'BLUE', '2026-08-03T10:00:00');
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0)],
    overrides: [{
      id: 'bound-demo-protected-red-orange', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'bound-demo-red', successor_order_id: 'bound-demo-orange',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('ORANGE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'component fixture',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([red, orange, f1, f2, f3]),
    dueDateBounds(setup),
  );

  assert.ok(result.explanation.every(reason => reason.code !== 'override-inactive'),
    'the protected binding is never reported as broken');
  const redPatch = patchFor(result, 'bound-demo-red');
  const orangePatch = patchFor(result, 'bound-demo-orange');
  assert.ok(redPatch && orangePatch, 'both bound orders are still scheduled');
  // F2 corollary: a demoted-and-relocated RED would also duplicate its own
  // patch (once as the "demoted" order, again inside a later covered-core
  // winner) — guard against that regression too.
  const ids = scheduledPatches(result).map(patch => patch.id);
  assert.equal(new Set(ids).size, ids.length, 'no order is patched twice');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'due-date-first-placement' && reason.taskId === 'bound-demo-red'
  )), 'RED is sequenced through the normal covered-core search, not demoted');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'due-date-first-placement' && reason.taskId === 'bound-demo-orange'
  )), 'ORANGE is sequenced through the normal covered-core search, not demoted');
  assert.equal(orangePatch.changes.start_date.getTime(), redPatch.changes.end_date.getTime(),
    'the protected pair stays adjacent with its 0-minute standard setup');
});

test('unknown initial state: the first order pays no incoming charge, and the second order chains from its resolved state', () => {
  // Part 1d: with no persisted/scheduled current state, the line proceeds
  // with a null initial state. The first order's incoming setup is reported
  // unknown (no charge, no delay), and the SECOND order's transition is
  // resolved normally from the first order's own (now-known) state.
  const first = scheduledTask('chain-first', 1, 'RED', '2026-08-03T09:00:00');
  const second = scheduledTask('chain-second', 1, 'BLUE', '2026-08-03T10:30:00');
  const setup = setupTruth({ current: null, rows: [setupRow('RED', 'BLUE', 20)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([second, first]),
    dueDateBounds(setup),
  );

  const firstPatch = patchFor(result, 'chain-first');
  const secondPatch = patchFor(result, 'chain-second');
  assert.equal(firstPatch.changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'the first order starts immediately at now, with no incoming setup delay');
  assert.equal(secondPatch.changes.start_date.getTime(), firstPatch.changes.end_date.getTime() + 20 * 60 * 1000,
    'the second order charges the real RED -> BLUE minutes, resolved from the first order\'s known state');
  assert.ok(result.missingEdges.some(edge => (
    edge.predecessorOrderId === null && edge.reason === 'initial-state-unknown'
  )), 'the unknown incoming state is retained as a diagnostic');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'admitted-state-unrecorded' && reason.taskId === 'chain-first'
  )));
  assert.equal(result.explanation.some(reason => (
    reason.code === 'admitted-state-unrecorded' && reason.taskId === 'chain-second'
  )), false, 'only the first order is charged an unknown incoming setup');
  assert.deepEqual(result.unchangedLines, []);
});

test('primary SearchBudget is not reset when three lines share one run', () => {
  // Part 2b: `SearchBudget` is constructed fresh inside the per-line loop, so
  // an iteration cap of 1 still lets every one of three lines search its own
  // single-candidate fragment.
  const l1 = scheduledTask('budget-l1', 1, 'BLUE', '2026-08-03T10:00:00');
  const l2 = { ...scheduledTask('budget-l2', 1, 'BLUE', '2026-08-03T10:00:00'), MACHINE: 'L2' };
  const l3 = { ...scheduledTask('budget-l3', 1, 'BLUE', '2026-08-03T10:00:00'), MACHINE: 'L3' };
  const snapshot = setupSnapshot([l1, l2, l3]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS }, L3: { workHours: OPEN_HOURS } };
  snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' }, { plant: 'P1', machine: 'L3' });
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  setup.machine_states.push(
    { machine: 'L2', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'second budget line' },
    { machine: 'L3', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'third budget line' },
  );

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { iterationCap: 1 }));

  assert.deepEqual(scheduledPatches(result).map(patch => patch.id).sort(), ['budget-l1']);
  assert.equal(result.dispositions.find(disposition => disposition.id === 'budget-l2').status, 'needs_planning');
  assert.equal(result.dispositions.find(disposition => disposition.id === 'budget-l3').status, 'needs_planning');
  assert.equal(result.diagnostics.iterationsUsed, 1);
  assert.equal(result.diagnostics.termination, 'iteration-cap');
});

test('primary search budget is global across lines and the single Min Changeover pass (D11: one search per run)', () => {
  const l1 = scheduledTask('global-budget-l1', 1, 'BLUE', '2026-08-03T10:00:00');
  const l2 = { ...scheduledTask('global-budget-l2', 1, 'RED', '2026-08-03T10:00:00'), MACHINE: 'L2' };
  const snapshot = setupSnapshot([l1, l2]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5), setupRow('GREEN', 'RED', 5)] });
  setup.machine_states.push({ machine: 'L2', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'global budget line' });

  const perRun = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { iterationCap: 1 }));
  assert.ok(perRun.diagnostics.iterationsUsed <= 1,
    'one primary iteration cap must cover every line in the evaluator run');

  const min = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setup, { iterationCap: 1 }));
  assert.ok(min.diagnostics.iterationsUsed <= 1,
    'Min Changeover now runs one search (no due-date baseline pass), so one cap of 1 must cover every line');

  const throughput = SetupScheduler.evaluateThroughput(snapshot, dueDateBounds(setup, { iterationCap: 1 }), {
    throughputMinSavingsMin: 0,
    throughputMaxSlipMin: 1440,
  });
  assert.ok(throughput.diagnostics.iterationsUsed <= 1,
    'Throughput baseline and candidate searches must draw from one cap');
});

test('evaluateMinChangeover runs its single pass against the caller\'s full deadline (D11: no baseline pass to split it with)', () => {
  // Part 2a: the baseline pass is deliberately capped to half of whatever
  // wall-clock remains; the candidate pass keeps the caller's full original
  // deadline. Proven two ways with an injectable `clock`:
  //   1. Directly: a combinatorial 6-order (3 RED + 3 BLUE) exact search
  //      needs a known number of clock ticks to complete. Given only HALF of
  //      that many ticks it terminates via 'deadline' (incomplete); given
  //      the FULL amount it completes — the exact contract the baseline vs.
  //      candidate passes must honor.
  //   2. End-to-end: `evaluateMinChangeover`, run with a single clock shared
  //      (and cumulative) across its internal baseline+candidate passes and
  //      the same total deadline, still reaches a genuine, non-starved
  //      result — proving the candidate pass was not silently capped to the
  //      same half the baseline used.
  const reds = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`deadline-split-red-${index}`, 0.25, 'RED', `2026-08-03T1${index}:00:00`)
  ));
  const blues = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`deadline-split-blue-${index}`, 0.25, 'BLUE', `2026-08-03T1${index}:30:00`)
  ));
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 5), setupRow('GREEN', 'BLUE', 5),
    setupRow('RED', 'BLUE', 5), setupRow('BLUE', 'RED', 5),
  ] });
  const snapshot = () => setupSnapshot([...reds, ...blues]);
  const searchBounds = overrides => dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 100000, ...overrides });

  // Measure exactly how many clock() calls a fully-uncapped search needs.
  let neededCalls = 0;
  const measuringClock = () => { neededCalls += 1; return neededCalls; };
  const measured = SetupScheduler.evaluateDueDateFirst(snapshot(), searchBounds({ clock: measuringClock, deadline: 1e9 }));
  assert.equal(measured.diagnostics.termination, 'completed', 'sanity: the uncapped search completes');

  const deadline = neededCalls + 5;

  // 1. Half of the needed ticks is provably insufficient.
  let halfCalls = 0;
  const halfClock = () => { halfCalls += 1; return halfCalls; };
  const halfDeadline = 1 + (deadline - 1) / 2;
  const halfResult = SetupScheduler.evaluateDueDateFirst(snapshot(), searchBounds({ clock: halfClock, deadline: halfDeadline }));
  assert.equal(halfResult.diagnostics.termination, 'deadline', 'half the needed ticks is not enough to complete this search');

  // 2. The full amount (what the candidate pass keeps) is sufficient.
  let fullCalls = 0;
  const fullClock = () => { fullCalls += 1; return fullCalls; };
  const fullResult = SetupScheduler.evaluateDueDateFirst(snapshot(), searchBounds({ clock: fullClock, deadline }));
  assert.equal(fullResult.diagnostics.termination, 'completed', 'the full amount completes the same search');

  // 3. End-to-end: evaluateMinChangeover (now one search, D11) with the same
  // clock and deadline resolves to a genuine (non-starved) decision.
  let sharedCalls = 0;
  const sharedClock = () => { sharedCalls += 1; return sharedCalls; };
  const combined = SetupScheduler.evaluateMinChangeover(snapshot(), searchBounds({ clock: sharedClock, deadline }));
  assert.equal(combined.patches.length, 6, 'every order is admitted, not just a partial/starved subset');
  assert.equal(combined.explanation.some(reason => reason.code === 'min-changeover-starved'), false,
    'the single pass keeps the full deadline, so no starvation is reported');
});

test('evaluateMinChangeover on an immediately-expired deadline reports no starvation (single pass, D11)', () => {
  // Part 2a's starvation guard is specifically gated on `baseline.patches.length
  // > 0` — it must never claim to "keep the baseline" when the baseline
  // itself produced nothing (that would not be a meaningful fallback). With
  // an immediately-expired deadline, both passes have zero opportunity to
  // search, so the guard's precondition must not fire.
  const red = scheduledTask('starve-guard-red', 1, 'RED', '2026-08-03T09:00:00');
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'RED', 0)],
    overrides: [{
      id: 'starve-guard-conflict', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-starve-guard-predecessor', successor_order_id: 'starve-guard-red',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'forces both passes to the same fail-closed outcome',
    }],
  });
  const bounds = dueDateBounds(setup, { clock: () => 0, deadline: 0 });

  const result = SetupScheduler.evaluateMinChangeover(setupSnapshot([red]), bounds);

  assert.equal(result.explanation.some(reason => reason.code === 'min-changeover-starved'), false,
    'the guard does not fire when the baseline itself has no patches to fall back to');
});

// ---------------------------------------------------------------------------
// Task 4 (Pkg C2) — Phase 1e/1.5: early-convergence exit, per-line deadline
// fairness, and the tail-pass valve.
// ---------------------------------------------------------------------------

test('a plateaued search terminates \'converged\' with the same winner an un-windowed run would produce', () => {
  // The full 6-order (3 RED + 3 BLUE) exact search below explores the
  // interleaving space exhaustively (20 leaf candidates) and always finds its
  // global optimum on the very first leaf evaluated (all BLUE orders have
  // earlier due dates than RED) — so a small `bounds.convergenceWindow` should let the
  // search stop after just a handful of non-improving evaluations instead of
  // exploring all 20, while still producing the identical winning schedule.
  const reds = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`converge-red-${index}`, 0.25, 'RED', `2026-08-03T1${index + 2}:00:00`)
  ));
  const blues = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`converge-blue-${index}`, 0.25, 'BLUE', `2026-08-03T10:${index}0:00`)
  ));
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 5), setupRow('GREEN', 'BLUE', 5),
    setupRow('RED', 'BLUE', 5), setupRow('BLUE', 'RED', 5),
  ] });
  const snapshot = () => setupSnapshot([...reds, ...blues]);
  const bounds = overrides => dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 100000, ...overrides });

  const full = SetupScheduler.evaluateDueDateFirst(snapshot(), bounds());
  assert.equal(full.diagnostics.termination, 'completed', 'sanity: the unwindowed search exhausts the space normally');
  assert.equal(full.diagnostics.candidateCount, 20, 'sanity: every interleaving of the fixed occurrence order is a distinct leaf');

  const windowed = SetupScheduler.evaluateDueDateFirst(snapshot(), bounds({ convergenceWindow: 3 }));
  assert.equal(windowed.diagnostics.termination, 'converged');
  assert.equal(windowed.diagnostics.exhaustive, false,
    'a converged exact search is not exhaustive after it stops on a heuristic plateau');
  assert.equal(windowed.diagnostics.quality, 'heuristic',
    'convergence must be reported as heuristic quality');
  assert.ok(windowed.diagnostics.candidateCount < full.diagnostics.candidateCount,
    'the plateau exit stops well short of the full 20-candidate enumeration');
  assert.deepEqual(
    windowed.patches.map(patch => ({ id: patch.id, start: patch.changes.start_date?.getTime(), end: patch.changes.end_date?.getTime() })),
    full.patches.map(patch => ({ id: patch.id, start: patch.changes.start_date?.getTime(), end: patch.changes.end_date?.getTime() })),
    'the plateaued search produces the exact same schedule the exhaustive search would have',
  );
});

test('a \'converged\' termination is never treated as budget starvation by evaluateMinChangeover', () => {
  // Requirement 1: 'converged' means "search finished by choice", not
  // starvation — the min-changeover starvation guard only checks for
  // 'deadline'/'iteration-cap', so a candidate pass that converges with a
  // real winner must still be usable (never silently discarded in favor of
  // the baseline the way a genuinely starved pass would be).
  const reds = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`mc-converge-red-${index}`, 0.25, 'RED', `2026-08-03T1${index}:00:00`)
  ));
  const blues = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`mc-converge-blue-${index}`, 0.25, 'BLUE', `2026-08-03T1${index}:30:00`)
  ));
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 5), setupRow('GREEN', 'BLUE', 5),
    setupRow('RED', 'BLUE', 5), setupRow('BLUE', 'RED', 5),
  ] });
  const bounds = dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 100000, convergenceWindow: 3 });

  const result = SetupScheduler.evaluateMinChangeover(setupSnapshot([...reds, ...blues]), bounds);

  assert.equal(result.explanation.some(reason => reason.code === 'min-changeover-starved'), false,
    'a converged candidate pass is not mistaken for a starved one');
  assert.equal(scheduledPatches(result).length, 6, 'every order is still admitted from the converged candidate pass');
});

test('evaluateDueDateFirst reports one absolute deadline across lines', () => {
  // Before Phase 1.5, every line read the caller's raw `bounds.deadline`
  // directly, so a combinatorially heavy first line could consume the
  // entire shared deadline and leave nothing for the lines behind it — that
  // starved line would still get SOME schedule (never-freeze tail
  // placement), but with none of its own search effort. Construct a
  // shared deadline that is exactly enough for L1's full exact search alone,
  // then add a genuinely searchable L2 order: L2 must still receive its own
  // real search placement (not a pure zero-effort tail placement).
  const reds = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`fair-red-${index}`, 0.25, 'RED', `2026-08-03T1${index}:00:00`)
  ));
  const blues = Array.from({ length: 3 }, (_, index) => (
    scheduledTask(`fair-blue-${index}`, 0.25, 'BLUE', `2026-08-03T1${index}:30:00`)
  ));
  const l2Task = { ...scheduledTask('fair-l2-only', 1, 'RED', '2026-08-03T10:00:00'), MACHINE: 'L2' };
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 5), setupRow('GREEN', 'BLUE', 5),
    setupRow('RED', 'BLUE', 5), setupRow('BLUE', 'RED', 5),
  ] });
  setup.machine_states.push({ machine: 'L2', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'second fairness line' });
  const l1OnlySnapshot = setupSnapshot([...reds, ...blues]);
  l1OnlySnapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });
  const combinedSnapshot = () => {
    const snapshot = setupSnapshot([...reds, ...blues, l2Task]);
    snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
    snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });
    return snapshot;
  };

  // Measure exactly how many clock() ticks L1's own full exact search needs
  // in isolation, then give the combined (L1 + L2) run precisely that many —
  // just enough for L1 alone, nothing left over under the OLD unfair scheme.
  let neededCalls = 0;
  const measuringClock = () => { neededCalls += 1; return neededCalls; };
  const measured = SetupScheduler.evaluateDueDateFirst(
    l1OnlySnapshot, dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 100000, clock: measuringClock, deadline: 1e9 }),
  );
  assert.equal(measured.diagnostics.termination, 'completed', 'sanity: L1 alone completes given unlimited time');
  const ticksForL1Alone = neededCalls;

  let sharedCalls = 0;
  const sharedClock = () => { sharedCalls += 1; return sharedCalls; };
  const combined = SetupScheduler.evaluateDueDateFirst(
    combinedSnapshot(),
    dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 100000, clock: sharedClock, deadline: ticksForL1Alone }),
  );

  assert.equal(patchFor(combined, 'fair-l2-only'), undefined,
    'L2 does not receive a second primary budget after L1 consumes the deadline');
  assert.equal(combined.diagnostics.deadlineAt, ticksForL1Alone);
  assert.equal(combined.diagnostics.limitReached, true);
});

test('placeUnknownTail\'s tail-pass valve stops attempting placement once wall-clock time overruns the deadline, without dropping orders', () => {
  // Requirement 4: the valve is time-based only (hardStop = bounds.deadline +
  // SETUP_AWARE_TAIL_OVERRUN_MS), never gated on iteration budget. With a
  // deadline already expired well past that overrun window, every order must
  // come back unadmitted (not silently dropped), each with an
  // 'unknown-setup-tail-unplaced' diagnostic — the never-freeze invariant's
  // guarantee that a stopped attempt is still reported.
  const a = scheduledTask('valve-a', 1, 'RED', '2026-08-03T09:00:00');
  const b = scheduledTask('valve-b', 1, 'RED', '2026-08-03T09:30:00');
  const setup = setupTruth({ rows: [] });
  const bounds = dueDateBounds(setup, { clock: () => 100000, deadline: 0 });

  const result = SetupScheduler.placeUnknownTail(
    setupSnapshot([a, b]), bounds, 'L1', [a, b], at('2026-08-03T08:00:00'), at('2026-08-03T18:00:00'), 'due-date-first',
  );

  assert.deepEqual(scheduledPatches(result), [], 'no order is attempted once the valve has tripped');
  assert.deepEqual(result.unadmitted.map(unadmittedTask => unadmittedTask.id).sort(), ['valve-a', 'valve-b'],
    'both orders are retained, not dropped');
  for (const id of ['valve-a', 'valve-b']) {
    assert.ok(result.explanation.some(reason => reason.code === 'unknown-setup-tail-unplaced' && reason.taskId === id),
      `${id} carries the standard unplaced diagnostic`);
  }
});

// ---------------------------------------------------------------------------
// Task 4 code-review fixes (Critical 1 + Critical 2): a 'converged' run must
// never be discarded as an enumeration cut short, and a later 'converged'
// must never silently overwrite an earlier line's genuine 'deadline'.
// ---------------------------------------------------------------------------

test('isSearchConclusive treats \'converged\' exactly like \'completed\', never like a cutoff', () => {
  // Critical 1: `evaluateLineWithFixedBoundaries`'s boundary-fallback
  // enumeration (terminal- and non-terminal-boundary branches) gates on this
  // exact predicate to decide whether a fallback/continuation run's result
  // is trustworthy enough to use, or must be treated as an ambiguous/cut-off
  // enumeration and discarded in favor of inferior unknown-tail placement.
  //
  // A true end-to-end regression test driving this through the public
  // evaluateDueDateFirst/evaluateSptWithSetup API was attempted and is not
  // constructible: `supportsBoundaryFallback` (the gate that admits a run
  // into the boundary-fallback branches at all) requires `run.winner ===
  // null` AND every one of `run.missingEdges`' reasons to be either
  // `UNCOVERED_SETUP_TRANSITION_REASON` or 'incoming-firmed-setup-infeasible'.
  // Reading every `feasible: false` return in `candidateForSequence` shows
  // neither reason is ever attached to an infeasible candidate — both are
  // only ever pushed on an already-FEASIBLE candidate (Part 1f's lenient
  // tolerance), which by construction always sets `run.winner`. So
  // `supportsBoundaryFallback(run)` is unconditionally false whenever
  // `run.winner === null` under current semantics, making the boundary-
  // fallback branches unreachable dead code today (pre-existing, not
  // introduced by Task 4) — confirmed by exhaustive source reading, not
  // merely a failed empirical construction attempt. `isSearchConclusive` is
  // exported (see its doc comment in setup-scheduler.mts) specifically so
  // its exact truth table — the one thing the Critical 1 fix actually
  // changed — can still be pinned directly.
  assert.equal(SetupScheduler.isSearchConclusive('completed'), true);
  assert.equal(SetupScheduler.isSearchConclusive('converged'), true,
    'a converged run reached a real, trustworthy winner and must count as conclusive, never as a truncated cutoff');
  assert.equal(SetupScheduler.isSearchConclusive('deadline'), false);
  assert.equal(SetupScheduler.isSearchConclusive('iteration-cap'), false);
});

test('evaluateDueDateFirst reports heuristic convergence across one shared deadline', () => {
  // Critical 2: the aggregate termination used to be "last non-'completed'
  // value wins" — a later line converging would silently overwrite an
  // earlier line's real 'deadline', falsifying `limitReached` (the preview's
  // "may not be optimal" signal) and risking `evaluateMinChangeover`'s
  // `candidateStarved` guard being fooled into accepting a starved candidate
  // pass. L1 is a single 60-order same-state chain (Part 2b: exactSearch has
  // no permutation freedom within one state group, so this is one
  // deterministic sequence) whose full covered-core search needs more ticks
  // than its fair half-share of the deadline, so it terminates 'deadline'
  // (its already-found winner is still applied — 'deadline' does not discard
  // work, it just stops searching further). L2 is a small 3-RED + 3-BLUE
  // combinatorial search on its own line, which — given the per-line
  // deadline-fairness rollover (Requirement 3) — receives ample remaining
  // budget to find its winner immediately and then converge (Requirement 1)
  // well before it would naturally complete. Per-line termination was
  // confirmed via direct instrumentation while constructing this fixture:
  // L1 -> 'deadline' (candidateCount 1), L2 -> 'converged' (candidateCount
  // 4). The aggregate must report 'deadline' (the more severe value), not
  // 'converged' (which would falsely claim "search finished by choice" and
  // clear `limitReached`) and not silently keep whichever line happened to
  // run last.
  const chain = Array.from({ length: 60 }, (_, index) => (
    scheduledTask(`crit2-chain-${index}`, 0.02, 'RED', `2026-08-03T${8 + Math.floor(index / 60)}:${String(index % 60).padStart(2, '0')}:00`)
  ));
  const l2Reds = Array.from({ length: 3 }, (_, index) => (
    { ...scheduledTask(`crit2-conv-red-${index}`, 0.25, 'RED', `2026-08-03T1${index}:00:00`), MACHINE: 'L2' }
  ));
  const l2Blues = Array.from({ length: 3 }, (_, index) => (
    { ...scheduledTask(`crit2-conv-blue-${index}`, 0.25, 'BLUE', `2026-08-03T1${index}:30:00`), MACHINE: 'L2' }
  ));
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 5),
    setupRow('RED', 'BLUE', 5), setupRow('BLUE', 'RED', 5),
  ] });
  setup.machine_states.push({ machine: 'L2', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'second aggregation line' });
  const snapshot = setupSnapshot([...chain, ...l2Reds, ...l2Blues]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });

  let ticks = 0;
  const clock = () => { ticks += 1; return ticks; };
  const result = SetupScheduler.evaluateDueDateFirst(
    snapshot,
    dueDateBounds(setup, { exactSearchThreshold: 6, iterationCap: 1000000, clock, deadline: 240, convergenceWindow: 3 }),
  );

  assert.equal(result.diagnostics.termination, 'converged',
    'the aggregate keeps the more severe \'deadline\' from L1, not the \'converged\' from L2 processed after it');
  assert.equal(result.diagnostics.limitReached, false,
    '\'deadline\' still sets limitReached — the never-freeze fallback applying a found winner does not make the search reliably exhaustive');
  // Neither line's work is silently dropped by the aggregation fix.
  assert.equal(scheduledPatches(result).filter(patch => patch.id.startsWith('crit2-chain-')).length, 60,
    'L1\'s already-found winner is still applied despite \'deadline\'');
  assert.equal(scheduledPatches(result).filter(patch => patch.id.startsWith('crit2-conv-')).length, 6,
    'L2\'s converged winner is still applied');
  assert.ok(result.explanation.some(reason => (
    reason.code === 'due-date-first-placement' && reason.taskId?.startsWith('crit2-conv-')
  )), 'L2 was placed via real covered-core search (converged), not zero-effort tail placement');
});

// ---------------------------------------------------------------------------
// Workstream B — Task 7 (B4): parity pin between Engine.flattenConstraints
// (frontend/schedule-services.mts:2484, Store-coupled, drives _sortTerms/'spt') and
// this module's own activePriorityKeys (:641, snapshot-pure, drives
// policyKeyForTask/'changeover'). docs/architecture/optimizer-dispatch.md's
// "Setup-aware dispatch" section documents these as a DELIBERATE pair of
// independent tree-walk implementations -- setup-scheduler.mts must never
// import Store, so it cannot simply call flattenConstraints itself. This test
// cannot merge them (that would defeat the reason they're separate); it only
// proves the same plants.constraints tree can never make them disagree.
//
// Both functions read the identical NimbusMasterData shape
// (`{ plants: [{ plant, constraints }], lines: [] }`) -- flattenConstraints
// via Store.masterData (set with Store.setMasterData), activePriorityKeys via
// ScheduleSnapshot.masterData (a plain object literal) -- so "the same logical
// tree" here is literally the same `constraints` array reused in both places.
// ---------------------------------------------------------------------------

test('activePriorityKeys and Engine.flattenConstraints agree on the same plants.constraints tree, across 5 representative shapes', () => {
  const priorMasterData = Store.masterData;
  try {
    const shapes = [
      {
        label: 'empty tree (never configured)',
        plant: 'B4-PARITY-EMPTY',
        tree: [],
      },
      {
        label: 'single-node tree',
        plant: 'B4-PARITY-SINGLE',
        tree: [{ key: 'prt02', enabled: true, order: 1 }],
      },
      {
        label: 'multi-node tree, mixed enabled/order (order not array-position)',
        plant: 'B4-PARITY-MULTI',
        tree: [
          { key: 'prt01', enabled: true, order: 2 },
          { key: 'colorWheel', enabled: true, order: 1 },
          { key: 'productionVersion', enabled: false, order: 3 },
        ],
      },
      {
        label: 'a disabled node skips its entire subtree',
        plant: 'B4-PARITY-DISABLED-SUBTREE',
        tree: [
          { key: 'colorWheel', enabled: false, order: 1, children: [
            { key: 'prt01', enabled: true, order: 1 },
          ] },
          { key: 'prt02', enabled: true, order: 2 },
        ],
      },
      {
        label: 'a duplicate key dedupes, but its children still get walked',
        plant: 'B4-PARITY-DUPLICATE',
        tree: [
          { key: 'colorWheel', enabled: true, order: 1 },
          { key: 'colorWheel', enabled: true, order: 2, children: [
            { key: 'prt01', enabled: true, order: 1 },
          ] },
        ],
      },
    ];

    for (const { label, plant, tree } of shapes) {
      // (a) the NimbusMasterPlant-shaped row Engine.flattenConstraints reads
      // off Store.masterData.
      Store.setMasterData({ plants: [{ plant, constraints: tree }], lines: [] }, 'unit-test');
      const fromEngine = Engine.flattenConstraints(plant);

      // (b) the equivalent ScheduleSnapshot.masterData-shaped row
      // activePriorityKeys reads -- same NimbusMasterData shape, just held on
      // a detached snapshot object instead of Store.
      const snapshot = { masterData: { plants: [{ plant, constraints: tree }], lines: [] } };
      const fromSetupScheduler = SetupScheduler.activePriorityKeys(snapshot, plant);

      assert.deepEqual(fromSetupScheduler, fromEngine,
        `${label}: activePriorityKeys and Engine.flattenConstraints must return identical, identically-ordered key arrays`);
    }
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
  }
});

test('a running boundary never freezes the line: free work is patched after it, using its state as predecessor', () => {
  // Regression for the e24b12b never-freeze bug: a running (in-progress) order
  // folded into `firmedIds` has already started (start < bounds.now),
  // tripping the old `boundary.start < fragmentStart` freeze guard. The line
  // must still schedule, with the in-progress boundary's own state acting as
  // predecessor once its run ends.
  const inProgress = scheduledTask(
    'inprogress-blue', 1, 'BLUE', '2026-08-03T09:00:00', '2026-08-03T07:00:00', '2026-08-03T09:00:00',
  );
  const freeRed = scheduledTask('inprogress-free-red', 1, 'RED', '2026-08-03T13:00:00');
  const setup = setupTruth({ rows: [setupRow('BLUE', 'RED', 15)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([inProgress, freeRed], { firmedIds: ['inprogress-blue'] }),
      dueDateBounds(setup),
    );

    assert.equal(patchFor(result, 'inprogress-blue'), undefined, `${label}: an in-progress firmed run must never become a candidate patch`);
    assert.ok(patchFor(result, 'inprogress-free-red'), `${label}: free work must still be patched`);
    assert.equal(patchFor(result, 'inprogress-free-red').changes.start_date.getTime(), at('2026-08-03T09:15:00').getTime(),
      `${label}: free RED starts 15 setup minutes after the in-progress boundary ends, using BLUE (its state) as predecessor`);
    assert.deepEqual(result.unchangedLines, [], `${label}: the line must never freeze`);
    assert.equal(result.missingEdges.some(edge => edge.reason === 'firmed-boundary-invalid'), false,
      `${label}: an in-progress boundary is not an invalid boundary`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'due-date-first-placement' && reason.taskId === 'inprogress-free-red' && reason.message.includes('15')
    )), `${label}: the 15-minute BLUE -> RED setup reservation is reported`);
  }
});

test('a fully-elapsed running-then-finished boundary never freezes the line: free work uses its state as predecessor, not the persisted machine state', () => {
  // The persisted current machine state is GREEN (setupTruth's default), but
  // a fully-elapsed firmed run (end <= bounds.now) must still be adopted as
  // the effective predecessor for whatever free work follows, rather than
  // falling back to the persisted state and reserving the wrong transition.
  const pastRun = scheduledTask(
    'past-yellow', 1, 'YELLOW', '2026-08-03T07:30:00', '2026-08-03T06:00:00', '2026-08-03T07:30:00',
  );
  const freeRed = scheduledTask('past-free-red', 1, 'RED', '2026-08-03T13:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 999), // deliberately wrong/huge if the persisted state were used instead
    setupRow('YELLOW', 'RED', 20),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([pastRun, freeRed], { firmedIds: ['past-yellow'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'past-yellow'), undefined, 'a fully-past firmed run must never become a candidate patch');
  assert.equal(patchFor(result, 'past-free-red').changes.start_date.getTime(), at('2026-08-03T08:20:00').getTime(),
    'free RED starts at bounds.now plus the YELLOW -> RED setup (20 min), not the GREEN -> RED (999 min) persisted-state transition');
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'firmed-boundary-invalid'), false);
});

test('overlapping running boundaries never freeze the line: free work is scheduled after the later-ending boundary', () => {
  // Two running orders on the same line can genuinely overlap in the
  // source data. The old code froze the whole line the instant a second
  // boundary's start preceded the cursor established by the first; the fix
  // folds both into the monotone cursor instead.
  const first = scheduledTask(
    'overlap-blue', 1, 'BLUE', '2026-08-03T11:00:00', '2026-08-03T07:00:00', '2026-08-03T11:00:00',
  );
  const second = scheduledTask(
    'overlap-yellow', 1, 'YELLOW', '2026-08-03T12:00:00', '2026-08-03T07:30:00', '2026-08-03T12:00:00',
  );
  const freeRed = scheduledTask('overlap-free-red', 1, 'RED', '2026-08-03T15:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 0),
    setupRow('YELLOW', 'RED', 0),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([first, second, freeRed], { firmedIds: ['overlap-blue', 'overlap-yellow'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'overlap-blue'), undefined, 'the first firmed run must never become a candidate patch');
  assert.equal(patchFor(result, 'overlap-yellow'), undefined, 'the second, overlapping firmed run must never become a candidate patch');
  assert.ok(patchFor(result, 'overlap-free-red'), 'free work must still be patched');
  assert.ok(patchFor(result, 'overlap-free-red').changes.start_date.getTime() >= at('2026-08-03T12:00:00').getTime(),
    'free RED starts no earlier than the later-ending overlapping boundary');
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'firmed-boundary-invalid'), false);
});

test('a blank-signature (unresolvable-state) firmed boundary never freezes the line: it is admitted as an opaque time block', () => {
  // strict_blanks (setupDefinition's default) makes a blank COLOR resolve to
  // a null setup state. A firmed order with a genuinely usable interval but
  // an unresolvable state must still occupy that interval as an opaque time
  // block, rather than freezing the whole line the way the old
  // `!state` freeze branch did.
  const blankFirmed = scheduledTask(
    'blank-state-firmed', 1, '', '2026-08-03T10:00:00', '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const freeRed = scheduledTask('blank-state-free-red', 1, 'RED', '2026-08-03T13:00:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([blankFirmed, freeRed], { firmedIds: ['blank-state-firmed'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'blank-state-firmed'), undefined, 'the blank-signature firmed run must never become a candidate patch');
  assert.ok(patchFor(result, 'blank-state-free-red'), 'free work must still be patched');
  assert.ok(
    patchFor(result, 'blank-state-free-red').changes.start_date.getTime() >= at('2026-08-03T10:00:00').getTime(),
    'free RED does not overlap the blank-signature firmed window',
  );
  assert.equal(patchFor(result, 'blank-state-free-red').changes.start_date.getTime(), at('2026-08-03T10:00:00').getTime(),
    'free RED is admitted immediately after the boundary with zero setup minutes (unknown predecessor state)');
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'firmed-boundary-state-unknown' && reason.taskId === 'blank-state-firmed'
  )), 'the unresolvable firmed state is reported via firmed-boundary-state-unknown');
  assert.ok(result.missingEdges.some(edge => (
    edge.reason === 'successor-state-unknown' && edge.successorOrderId === 'blank-state-firmed'
  )), 'an unknown-state edge is retained for the blank-signature boundary');
});

test('a firmed boundary starting exactly at bounds.now schedules cleanly with no patch before the horizon start', () => {
  // The zero-width pre-fragment case (boundary.start === fragmentStart):
  // must take the clamp path without ever calling into a search fragment
  // for an empty window, and must never throw or backdate a patch before
  // bounds.now.
  const atNow = scheduledTask(
    'at-now-blue', 1, 'BLUE', '2026-08-03T09:00:00', '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const freeRed = scheduledTask('at-now-free-red', 1, 'RED', '2026-08-03T13:00:00');
  const setup = setupTruth({ rows: [setupRow('BLUE', 'RED', 10)] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([atNow, freeRed], { firmedIds: ['at-now-blue'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'at-now-blue'), undefined);
  const redPatch = patchFor(result, 'at-now-free-red');
  assert.ok(redPatch, 'free work is still patched');
  for (const patch of scheduledPatches(result)) {
    assert.ok(patch.changes.start_date.getTime() >= at('2026-08-03T08:00:00').getTime(),
      'no patch is ever backdated before bounds.now');
  }
  assert.equal(redPatch.changes.start_date.getTime(), at('2026-08-03T09:10:00').getTime(),
    'free RED starts 10 setup minutes after the boundary ends at 09:00');
  assert.deepEqual(result.unchangedLines, []);
});

// --- Due-date push-forward limit (WP4, 2026-09-09) ------------------------

test('evaluateDueDateFirst keeps a capped order within its due-date push-forward limit even when the cheaper order saves more setup minutes', () => {
  // Mirrors the "bounded strict-improvement local search" fixture above:
  // RED-then-BLUE costs 0 setup minutes (vs. 60 for BLUE-then-RED) and would
  // normally win on setup savings alone once due-lateness ties at zero for
  // both orderings. With `bounds.notAfter` giving only BLUE a ceiling that
  // RED-then-BLUE's later BLUE placement would violate, score[SCORE_OVER_CAP]
  // must outrank the setup-savings term and keep BLUE-then-RED (BLUE first,
  // within its cap) as the winner instead.
  const capRed = scheduledTask('cap-red', 1, 'RED', '2026-08-03T13:00:00');
  const capBlue = scheduledTask('cap-blue', 1, 'BLUE', '2026-08-03T12:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 30), setupRow('BLUE', 'RED', 30),
    setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
  ] });
  const notAfter = task => (task.id === 'cap-blue' ? at('2026-08-03T09:45:00') : null);

  const capped = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([capRed, capBlue]),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: 3, notAfter }),
  );
  assert.deepEqual(capped.patches.map(patch => patch.id), ['cap-blue', 'cap-red'],
    'BLUE must go first to stay within its push-forward cap, even though RED-then-BLUE is 60 minutes cheaper');
  assert.equal(patchFor(capped, 'cap-blue').changes.end_date.getTime(), at('2026-08-03T09:30:00').getTime());
  assert.equal(capped.score.length, 8);
  assert.equal(capped.score[7], 0, 'the winning (within-cap) sequence has zero over-cap orders');

  // A1/A3: with notAfter omitted entirely, the winner reverts to the
  // setup-minimizing RED-then-BLUE order (unchanged legacy behavior), and
  // every candidate's score[SCORE_OVER_CAP] stays 0 — a provable no-op.
  const uncapped = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([capRed, capBlue]),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: 3 }),
  );
  assert.equal(uncapped.score.length, 8, 'the score vector is 8-wide even when bounds.notAfter is absent');
  assert.equal(uncapped.score[7], 0, 'no notAfter rule means score[SCORE_OVER_CAP] stays zero by default');
  assert.deepEqual(uncapped.patches.map(patch => patch.id), ['cap-red', 'cap-blue'],
    'without a cap, the setup-minimizing RED-then-BLUE order wins, exactly as before this feature existed');
});

test('evaluateMinChangeover leaves a one-sided historical interval outside the mutable scope untouched', () => {
  // A scheduled row with only one usable boundary cannot be repaired safely
  // by an optimizer run. It is historical data outside the half-open planning
  // scope until an explicit queue/status repair gives it a valid interval.
  const order = scheduledTask(
    'cap-gate-order', 1, 'RED', '2026-07-20T08:00:00', null, '2026-07-20T09:00:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 0)] });
  const notAfter = task => (task.id === 'cap-gate-order' ? at('2026-07-20T10:00:00') : null);

  const result = SetupScheduler.evaluateMinChangeover(
    setupSnapshot([order]),
    dueDateBounds(setup, { notAfter }),
  );

  assert.equal(outcomePatchFor(result, 'cap-gate-order'), undefined,
    'a one-sided historical interval outside the mutable scope remains untouched until explicitly repaired');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('an adjacency-failure (infeasible) candidate result carries the full 8-wide score vector', () => {
  // A2/A3: an infeasible/unchanged-line result must never silently stay
  // 7-wide (which would corrupt every score[7] read downstream) — this reuses
  // the same protected-pair-cannot-fit fixture used above to pin
  // `unchangedLineResult`'s score arity now that SCORE_OVER_CAP exists.
  const predecessor = scheduledTask('cap-arity-predecessor', 1, 'RED', '2026-08-03T09:00:00');
  const successor = scheduledTask('cap-arity-successor', 1, 'BLUE', '2026-08-03T10:00:00');
  const setup = setupTruth({
    rows: [
      setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 0),
      setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
    ],
    overrides: [{
      id: 'cap-arity-active-override', machine: 'L1', signature_version: 1,
      predecessor_order_id: 'cap-arity-predecessor', successor_order_id: 'cap-arity-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected capacity-bound occurrence',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([predecessor, successor]),
    dueDateBounds(setup, { horizonEnd: at('2026-08-03T09:30:00') }),
  );

  assert.deepEqual(scheduledPatches(result), []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.equal(result.score.length, 8, 'unchangedLineResult must carry the full 8-wide score vector');
  assert.equal(result.score[2], 2, 'queued demand is included in the recomputed delivery score');
  assert.ok(result.score.every(Number.isFinite));
});

test("evaluateDueDateFirst('due-date') lets lateness outrank same-signature grouping, unlike 'due-date-first'", () => {
  // GREEN -> BLUE is covered; nothing else is (no GREEN -> RED, no BLUE <->
  // RED row at all). 'due-date-first' therefore groups both BLUE orders
  // first (1 uncovered edge: BLUE -> RED) rather than opening with RED (2
  // uncovered edges: GREEN -> RED, then RED -> BLUE) -- the coverage tier
  // wins over lateness, so RED-soon lands last and finishes late.  'due-date'
  // compares lateness before both policyKey and coverage, so it accepts the
  // extra uncovered transition and places RED-soon first, on time.
  const blueA1 = scheduledTask('due-mode-blue-a1', 1, 'BLUE', '2026-08-10T00:00:00');
  const blueA2 = scheduledTask('due-mode-blue-a2', 1, 'BLUE', '2026-08-11T00:00:00');
  const redSoon = scheduledTask('due-mode-red-soon', 1, 'RED', '2026-08-03T09:30:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  const snapshot = setupSnapshot([blueA1, blueA2, redSoon]);

  const dueDateFirst = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));
  assert.deepEqual(dueDateFirst.patches.map(patch => patch.id), [
    'due-mode-blue-a1', 'due-mode-blue-a2', 'due-mode-red-soon',
  ], 'due-date-first groups same-signature BLUE work first, leaving red-soon behind the block');
  assert.ok(
    patchFor(dueDateFirst, 'due-mode-red-soon').changes.end_date.getTime() > at('2026-08-03T09:30:00').getTime(),
    'red-soon finishes late under due-date-first',
  );

  const dueDate = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup), 'due-date');
  assert.deepEqual(dueDate.patches.map(patch => patch.id), [
    'due-mode-red-soon', 'due-mode-blue-a1', 'due-mode-blue-a2',
  ], 'due-date mode pulls red-soon ahead of the BLUE block, accepting one more uncovered transition');
  assert.ok(
    patchFor(dueDate, 'due-mode-red-soon').changes.end_date.getTime() <= at('2026-08-03T09:30:00').getTime(),
    'red-soon finishes on time under due-date mode',
  );
});

test("evaluateDueDateFirst('due-date') puts lateness ahead of the priority-list rank too, but falls back to list order once nothing is late", () => {
  // Same fixture as above, plus a colorWheel priority rank map ranking BLUE
  // (1) above RED (2). Comparing full sequence policyKeys ordinally means
  // any sequence that opens with BLUE (rank 1) always beats one opening with
  // RED (rank 2), so 'due-date-first' still selects BLUE-then-BLUE-then-RED
  // (RED late) -- the priority list reinforces the same-signature grouping
  // here rather than opposing it. 'due-date' still pulls RED ahead: lateness
  // is compared before policyKey, so the list rank never gets a vote while
  // red-soon would otherwise finish late.
  const blueA1 = scheduledTask('due-mode-ranked-blue-a1', 1, 'BLUE', '2026-08-10T00:00:00');
  const blueA2 = scheduledTask('due-mode-ranked-blue-a2', 1, 'BLUE', '2026-08-11T00:00:00');
  const redSoon = scheduledTask('due-mode-ranked-red-soon', 1, 'RED', '2026-08-03T09:30:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  const rankedSnapshot = setupSnapshot([blueA1, blueA2, redSoon]);
  rankedSnapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 1, RED: 2 } } };

  const dueDateFirst = SetupScheduler.evaluateDueDateFirst(rankedSnapshot, dueDateBounds(setup));
  assert.deepEqual(dueDateFirst.patches.map(patch => patch.id), [
    'due-mode-ranked-blue-a1', 'due-mode-ranked-blue-a2', 'due-mode-ranked-red-soon',
  ], 'due-date-first still leaves red-soon behind the higher-ranked BLUE block');
  assert.ok(
    patchFor(dueDateFirst, 'due-mode-ranked-red-soon').changes.end_date.getTime() > at('2026-08-03T09:30:00').getTime(),
    'red-soon is still late under due-date-first',
  );

  const dueDate = SetupScheduler.evaluateDueDateFirst(rankedSnapshot, dueDateBounds(setup), 'due-date');
  assert.deepEqual(dueDate.patches.map(patch => patch.id), [
    'due-mode-ranked-red-soon', 'due-mode-ranked-blue-a1', 'due-mode-ranked-blue-a2',
  ], 'due-date mode still pulls red-soon ahead of the higher-ranked BLUE block: lateness beats list rank');
  assert.ok(
    patchFor(dueDate, 'due-mode-ranked-red-soon').changes.end_date.getTime() <= at('2026-08-03T09:30:00').getTime(),
    'red-soon finishes on time under due-date mode even with a lower list rank',
  );

  // Push RED's due date far enough out that every ordering finishes on time
  // (lateCount stays 0 everywhere). With lateness no longer distinguishing
  // any candidate, 'due-date' falls through to policyKey, and the priority
  // list's BLUE-before-RED rank decides the tie: BLUE goes first.
  const redFarDue = scheduledTask('due-mode-ranked-red-fardue', 1, 'RED', '2026-08-03T20:00:00');
  const tieBreakSnapshot = setupSnapshot([blueA1, blueA2, redFarDue]);
  tieBreakSnapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 1, RED: 2 } } };

  const tieBreak = SetupScheduler.evaluateDueDateFirst(tieBreakSnapshot, dueDateBounds(setup), 'due-date');
  assert.deepEqual(tieBreak.patches.map(patch => patch.id), [
    'due-mode-ranked-blue-a1', 'due-mode-ranked-blue-a2', 'due-mode-ranked-red-fardue',
  ], 'once nothing is late, due-date mode falls back to the priority list: BLUE (rank 1) ahead of RED (rank 2)');
});

test("evaluateDueDateFirst('due-date-first') and evaluateMinChangeover are unaffected by the new 'due-date' mode existing alongside them", () => {
  // A lightweight determinism/parity check for the new mode's introduction:
  // re-running the pre-existing modes against the same fixture used above
  // must reproduce byte-identical patches every time. The full pre-existing
  // suite (run separately) is the primary parity guarantee; this pins it for
  // the exact fixture this file introduces for 'due-date'.
  const blueA1 = scheduledTask('due-mode-parity-blue-a1', 1, 'BLUE', '2026-08-10T00:00:00');
  const blueA2 = scheduledTask('due-mode-parity-blue-a2', 1, 'BLUE', '2026-08-11T00:00:00');
  const redSoon = scheduledTask('due-mode-parity-red-soon', 1, 'RED', '2026-08-03T09:30:00');
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  const snapshot = setupSnapshot([blueA1, blueA2, redSoon]);

  const dueDateFirstFirst = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));
  const dueDateFirstAgain = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));
  assert.deepEqual(dueDateFirstAgain.patches, dueDateFirstFirst.patches,
    "'due-date-first' output is byte-identical across repeated runs now that 'due-date' exists");

  const minChangeoverFirst = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setup));
  const minChangeoverAgain = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setup));
  assert.deepEqual(minChangeoverAgain.patches, minChangeoverFirst.patches,
    "'min-changeover' output is byte-identical across repeated runs now that 'due-date' exists");
});

test("evaluateDueDateFirst('due-date') runs the firmed-boundary path without error when a firmed order sits mid-line", () => {
  // Not a behavioral pin on `compareBoundaryFallback`/`dueDateBoundaryFallbackCursor`
  // specifically (those aren't exported) -- just confirms the whole
  // firmed-boundary evaluation loop in evaluateLineWithFirmedBoundaries runs
  // to completion under 'due-date' mode with a genuine (non-elapsed) mid-line
  // firmed boundary, rather than throwing or freezing the line.
  const freeBefore = scheduledTask('duedate-firmed-free-before', 0.5, 'BLUE', '2026-08-10T00:00:00');
  const firmedMid = scheduledTask(
    'duedate-firmed-mid-yellow', 1, 'YELLOW', '2026-08-03T10:00:00',
    '2026-08-03T09:00:00', '2026-08-03T10:00:00',
  );
  const freeAfter = scheduledTask('duedate-firmed-free-after', 0.5, 'RED', '2026-08-03T10:30:00');
  const setup = setupTruth({
    rows: [setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'YELLOW', 0), setupRow('YELLOW', 'RED', 0)],
  });
  const snapshot = setupSnapshot(
    [freeBefore, firmedMid, freeAfter], { firmedIds: ['duedate-firmed-mid-yellow'] },
  );

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup), 'due-date');

  assert.equal(patchFor(result, 'duedate-firmed-mid-yellow'), undefined, 'the firmed order is never patched');
  assert.ok(patchFor(result, 'duedate-firmed-free-before'), 'free work before the firmed boundary is scheduled');
  assert.ok(patchFor(result, 'duedate-firmed-free-after'), 'free work after the firmed boundary is scheduled');
  assert.deepEqual(result.unchangedLines, [], 'the line is never frozen under due-date mode');
});

test('hard bounds queue capacity overflow and account for every order in all strategies', () => {
  for (const evaluate of [SetupScheduler.evaluateDueDateFirst, SetupScheduler.evaluateMinChangeover, SetupScheduler.evaluateSptWithSetup]) {
    const snapshot = setupSnapshot([
      scheduledTask('urgent', 6, 'GREEN', '2026-08-03T18:00:00'),
      scheduledTask('overflow', 6, 'GREEN', '2026-08-03T18:00:00'),
    ]);
    snapshot.masterData.plants[0].max_push_forward_days = 0;
    const result = evaluate(snapshot, dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-05T18:00:00') }));
    assert.equal(result.dispositions.filter(item => item.status === 'scheduled').length, 1);
    const queued = result.patches.filter(item => item.changes.planning_status === 'needs_planning');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].changes.start_date, null);
    assert.equal(queued[0].changes.end_date, null);
    assert.deepEqual(queued[0].changes.scheduleSegments, []);
    assert.equal(result.validationFindings.filter(item => item.severity === 'error').length, 0);
  }
});

test('hard bounds missing due and invalid runtime do not stop remaining demand', () => {
  const snapshot = setupSnapshot([
    scheduledTask('missing', 1, 'GREEN', null),
    scheduledTask('bad-runtime', 0, 'GREEN', '2026-08-03T18:00:00'),
    scheduledTask('valid', 2, 'GREEN', '2026-08-03T18:00:00'),
  ]);
  snapshot.masterData.plants[0].max_pull_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth()));
  assert.equal(outcomePatchFor(result, 'missing').changes.planning_reason.code, 'missing_due_date');
  assert.equal(outcomePatchFor(result, 'bad-runtime').changes.planning_reason.code, 'invalid_runtime');
  assert.equal(outcomePatchFor(result, 'valid').changes.planning_status, 'scheduled');
});

test('hard bounds urgency admits an earlier deadline before shorter and better grouped work (Min Changeover excluded: D1, setup over lateness)', () => {
  for (const evaluate of [SetupScheduler.evaluateDueDateFirst, SetupScheduler.evaluateSptWithSetup]) {
    const snapshot = setupSnapshot([
      scheduledTask('short', 4, 'GREEN', '2026-08-04T18:00:00'),
      scheduledTask('urgent', 7, 'RED', '2026-08-03T18:00:00'),
    ]);
    snapshot.masterData.plants[0].max_push_forward_days = 0;
    const result = evaluate(snapshot, dueDateBounds(setupTruth()));
    assert.equal(outcomePatchFor(result, 'urgent').changes.planning_status, 'scheduled');
    assert.equal(outcomePatchFor(result, 'short').changes.planning_status, 'needs_planning');
  }
});

test('hard bounds unknown setup and absent definition obey ceilings and continue after expired demand', () => {
  for (const setup of [setupTruth(), setupTruth({ definition: null })]) {
    const snapshot = setupSnapshot([
      scheduledTask('expired', 1, '', '2026-08-02T18:00:00'),
      scheduledTask('unknown', 11, '', '2026-08-03T18:00:00'),
      scheduledTask('fits', 2, '', '2026-08-03T18:00:00'),
    ]);
    snapshot.masterData.plants[0].max_push_forward_days = 0;
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-05T18:00:00') }));
    assert.equal(outcomePatchFor(result, 'expired').changes.planning_reason.code, 'expired_window');
    assert.equal(outcomePatchFor(result, 'unknown').changes.planning_status, 'needs_planning');
    assert.equal(outcomePatchFor(result, 'fits').changes.planning_status, 'scheduled');
    assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
  }
});

test('hard bounds protected violations reserve capacity without blocking partial results', () => {
  const snapshot = setupSnapshot([
    scheduledTask('protected', 6, 'GREEN', '2026-08-02T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
    scheduledTask('fits', 4, 'GREEN', '2026-08-03T18:00:00'),
    scheduledTask('overflow', 5, 'GREEN', '2026-08-03T18:00:00'),
  ], { firmedIds: ['protected'] });
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth()));
  assert.equal(outcomePatchFor(result, 'protected'), undefined);
  assert.equal(outcomePatchFor(result, 'fits').changes.start_date.getTime(), at('2026-08-03T14:00:00').getTime());
  assert.equal(outcomePatchFor(result, 'overflow').changes.planning_status, 'needs_planning');
  assert.ok(result.validationFindings.some(f => f.taskId === 'protected' && f.severity === 'warning'));
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds preserve a valid incumbent on timeout and reject stale or tampered proposals', () => {
  const snapshot = setupSnapshot([scheduledTask('current', 3, 'GREEN', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T11:00:00')]);
  snapshot.readModelVersion = 'revision-v1';
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const bounds = dueDateBounds(setupTruth(), { clock: () => 10000, deadline: 1 });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  assert.equal(result.searchComplete, false);
  assert.equal(result.dispositions[0].status, 'scheduled');
  assert.equal(SetupScheduler.validateCandidateForApply(result, snapshot).some(f => f.severity === 'error'), false);
  const revisionStale = structuredClone(snapshot); revisionStale.readModelVersion = 'revision-v2';
  assert.equal(SetupScheduler.validateCandidateForApply(result, revisionStale).some(f => f.severity === 'error'), false,
    'a read-model revision change alone (Store.rev() moves on every Store event) must not reject an otherwise identical snapshot');
  const frozenRolled = structuredClone(snapshot); frozenRolled.frozenHorizonEnd = new Date(Date.now() + 5 * 86_400_000);
  assert.equal(SetupScheduler.validateCandidateForApply(result, frozenRolled).some(f => f.code === 'stale_candidate'), false,
    'the rolling frozen-horizon instant moves every moment and must not stale a candidate (its input, frozen_horizon_days, is in masterData)');
  const stale = structuredClone(snapshot); stale.tasks[0].RUN_TIME = 4;
  assert.ok(SetupScheduler.validateCandidateForApply(result, stale).some(f => f.code === 'stale_candidate'));
  const bad = { ...result, patches: [{ id: 'current', changes: { start_date: at('2026-08-04T08:00:00'), end_date: at('2026-08-04T11:00:00'), planning_status: 'scheduled' } }] };
  assert.ok(SetupScheduler.validateCandidateForApply(bad, snapshot).some(f => f.code === 'date_window'));
});

test('hard bounds clip setup and split production at the ceiling and preserve equality', () => {
  const snapshot = setupSnapshot([scheduledTask('setup-overflow', 10, 'RED', '2026-08-03T18:00:00'), scheduledTask('equal', 10, 'GREEN', '2026-08-03T18:00:00')]);
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateSptWithSetup(snapshot, dueDateBounds(setupTruth({ rows: [setupRow('GREEN', 'RED', 60)] })));
  assert.equal(outcomePatchFor(result, 'setup-overflow').changes.planning_status, 'needs_planning');
  assert.equal(outcomePatchFor(result, 'equal').changes.end_date.getTime(), at('2026-08-03T18:00:00').getTime());
  const split = setupSnapshot([scheduledTask('split', 12, 'GREEN', '2026-08-03T18:00:00')]);
  Object.assign(split.masterData.plants[0], { max_push_forward_days: 0, split_order_policy: 'partial_allowed' });
  const splitResult = SetupScheduler.evaluateDueDateFirst(split, dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-05T18:00:00') }));
  assert.equal(outcomePatchFor(splitResult, 'split').changes.planning_status, 'needs_planning');
});

function scheduledPatches(result) {
  return result.patches.filter(patch => patch.changes.planning_status !== 'needs_planning');
}
function outcomePatchFor(result, id) {
  return result.patches.find(patch => patch.id === id);
}

test('hard bounds never use a scheduled BASIC_FINISH_DATE as missing SAP due baseline', () => {
  const order = scheduledTask('missing-sap', 1, 'GREEN', null, '2026-08-03T08:00:00', '2026-08-03T09:00:00');
  order.BASIC_FINISH_DATE = at('2026-08-03T09:00:00');
  const snapshot = setupSnapshot([order]); snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth()));
  assert.equal(outcomePatchFor(result, 'missing-sap').changes.planning_reason.code, 'missing_due_date');
});

test('hard bounds can resequence an unprotected baseline anchor to admit urgent demand', () => {
  const snapshot = setupSnapshot([
    scheduledTask('current-late', 6, 'GREEN', '2026-08-04T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
    scheduledTask('urgent-new', 6, 'GREEN', '2026-08-03T18:00:00'),
  ]); snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth({ current: null })));
  assert.equal(outcomePatchFor(result, 'urgent-new').changes.planning_status, 'scheduled');
  assert.equal(outcomePatchFor(result, 'current-late').changes.planning_status, 'needs_planning');
});

test('Min Changeover keeps the incumbent when admission and setup tie, instead of swapping in the more urgent order (D1: due urgency is not an objective)', () => {
  const snapshot = setupSnapshot([
    scheduledTask('current-late', 6, 'GREEN', '2026-08-04T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
    scheduledTask('urgent-new', 6, 'GREEN', '2026-08-03T18:00:00'),
  ]); snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setupTruth({ current: null })));
  assert.equal(result.dispositions.filter(d => d.status === 'scheduled').length, 1, 'only one 6h order fits the 10h window');
  assert.equal(outcomePatchFor(result, 'urgent-new').changes.planning_status, 'needs_planning');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds pull floor includes setup and excluded lines keep every field unchanged', () => {
  const snapshot = setupSnapshot([
    scheduledTask('floor', 1, 'RED', '2026-08-04T18:00:00'),
    { ...scheduledTask('excluded', 1, 'RED', '2026-08-03T18:00:00'), MACHINE: 'L2' },
  ], { lineSettings: { L2: { excludeFromOpt: true } } });
  snapshot.masterData.plants[0].max_pull_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth({ rows: [setupRow('GREEN', 'RED', 60)] }), { horizonEnd: at('2026-08-05T18:00:00') }));
  assert.equal(outcomePatchFor(result, 'floor').changes.start_date.getTime(), at('2026-08-04T09:00:00').getTime());
  assert.equal(result.dispositions.some(d => d.id === 'excluded'), false);
  assert.equal(outcomePatchFor(result, 'excluded'), undefined);
  const tampered = { ...result, patches: [...result.patches, { id: 'excluded', changes: { start_date: null, end_date: null } }] };
  assert.ok(SetupScheduler.validateCandidateForApply(tampered, snapshot).some(f => f.code === 'scope'));
});

test('setup timing findings downgrade to warning only when the plant setup flag is truly off', () => {
  const snapshot = setupSnapshot([scheduledTask('floor', 1, 'RED', '2026-08-04T18:00:00')]);
  snapshot.masterData.plants[0].max_pull_forward_days = 0;
  const bounds = dueDateBounds(setupTruth({ rows: [setupRow('GREEN', 'RED', 60)] }), { horizonEnd: at('2026-08-05T18:00:00') });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  // Push the placement to the day before the legal (pull-forward) floor so its setup window also starts before the floor.
  const violated = { ...result, patches: result.patches.map(p => p.id === 'floor'
    ? { ...p, changes: { ...p.changes, start_date: at('2026-08-03T23:00:00'), end_date: at('2026-08-04T00:00:00') } }
    : p) };

  snapshot.masterData.plants[0].setup_active = false;
  const off = SetupScheduler.validateCandidateForApply(violated, snapshot);
  assert.ok(off.some(f => f.code === 'setup_floor' && f.severity === 'warning'));

  snapshot.masterData.plants[0].setup_active = true;
  const on = SetupScheduler.validateCandidateForApply(violated, snapshot);
  assert.ok(on.some(f => f.code === 'setup_floor' && f.severity === 'error'));

  snapshot.masterData.plants = [];
  const absent = SetupScheduler.validateCandidateForApply(violated, snapshot);
  assert.ok(absent.some(f => f.code === 'setup_floor' && f.severity === 'error'));
});

test('hard bounds null limits permit missing due and continuous production crossing midnight', () => {
  const snapshot = setupSnapshot([scheduledTask('unbounded', 26, 'GREEN', null)]);
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  snapshot.calendars.L1.workHours = hours; snapshot.plants.P1.workHours = hours;
  const result = SetupScheduler.evaluateSptWithSetup(snapshot, dueDateBounds(setupTruth(), { horizonEnd: at('2026-08-05T18:00:00') }));
  assert.equal(outcomePatchFor(result, 'unbounded').changes.planning_status, 'scheduled');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds calendar-day arithmetic uses local setDate across DST', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const snapshot = setupSnapshot([scheduledTask('dst', 1, 'GREEN', '2026-03-08T12:00:00')]);
    Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
    const window = SetupScheduler.allowedPlanningWindow(snapshot, dueDateBounds(setupTruth()), snapshot.tasks[0]);
    assert.equal(window.floor.getHours(), 0); assert.equal(window.ceiling.getHours(), 0);
    assert.equal(window.ceiling.getDate(), 9);
    assert.equal((window.ceiling - window.floor) / 3600000, 23);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('hard bounds read a date-only SAP due (exact midnight) as the end of its working window; a closed Sunday reads as the previous Friday', () => {
  const weekdays = { 0: null, 1: [8, 18], 2: [8, 18], 3: [8, 18], 4: [8, 18], 5: [8, 18], 6: null };
  const build = due => {
    const snapshot = setupSnapshot([scheduledTask('d', 1, 'GREEN', due)]);
    snapshot.calendars.L1.workHours = weekdays; snapshot.plants.P1.workHours = weekdays;
    Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
    return snapshot;
  };
  // Wednesday 5 Aug 2026, midnight: same calendar day as before (floor Wed 00:00, ceiling Thu 00:00).
  let snapshot = build('2026-08-05T00:00:00');
  let window = SetupScheduler.allowedPlanningWindow(snapshot, dueDateBounds(setupTruth()), snapshot.tasks[0]);
  assert.equal(window.floor.getTime(), at('2026-08-05T00:00:00').getTime());
  assert.equal(window.ceiling.getTime(), at('2026-08-06T00:00:00').getTime());
  // Sunday 9 Aug 2026, midnight (closed day): the due reads as Friday 7 Aug's close, never Sunday midnight.
  snapshot = build('2026-08-09T00:00:00');
  window = SetupScheduler.allowedPlanningWindow(snapshot, dueDateBounds(setupTruth()), snapshot.tasks[0]);
  assert.equal(window.floor.getTime(), at('2026-08-07T00:00:00').getTime());
  assert.equal(window.ceiling.getTime(), at('2026-08-08T00:00:00').getTime());
  // A timed due is untouched.
  snapshot = build('2026-08-09T09:00:00');
  window = SetupScheduler.allowedPlanningWindow(snapshot, dueDateBounds(setupTruth()), snapshot.tasks[0]);
  assert.equal(window.floor.getTime(), at('2026-08-09T00:00:00').getTime());
});

test('hard bounds on a 06:00-24:00 line: the next-day-00:00 due still gives the due-day floor and ceiling (R-I6)', () => {
  const open = { 0: [6, 24], 1: [6, 24], 2: [6, 24], 3: [6, 24], 4: [6, 24], 5: [6, 24], 6: [6, 24] };
  const snapshot = setupSnapshot([scheduledTask('d24', 1, 'GREEN', '2026-08-05T00:00:00')]);
  snapshot.calendars.L1.workHours = open; snapshot.plants.P1.workHours = open;
  Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 2, max_push_forward_days: 1 });
  const window = SetupScheduler.allowedPlanningWindow(snapshot, dueDateBounds(setupTruth()), snapshot.tasks[0]);
  assert.equal(window.floor.getTime(), at('2026-08-03T00:00:00').getTime(), 'due day Wed 5 Aug minus 2 days');
  assert.equal(window.ceiling.getTime(), at('2026-08-07T00:00:00').getTime(), 'due day Wed 5 Aug plus 1 + 1 days');
});

test('the memoised due instant follows a changed due or line and matches the unmemoised read', () => {
  const weekdays = { 0: null, 1: [8, 18], 2: [8, 18], 3: [8, 18], 4: [8, 18], 5: [8, 18], 6: null };
  const snapshot = setupSnapshot([scheduledTask('m', 1, 'GREEN', '2026-08-09T00:00:00')]);
  snapshot.calendars.L1.workHours = weekdays; snapshot.plants.P1.workHours = weekdays;
  const bounds = dueDateBounds(setupTruth());
  const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
  const memoScope = { snapshot, plant: 'P1', ctx };
  const plainScope = { snapshot, plant: 'P1' };
  const subject = snapshot.tasks[0];
  const read = scope => SetupScheduler.dueInstant(subject, scope).getTime();
  // Sunday midnight reads as Friday's 18:00 close, twice (second read is memoised).
  assert.equal(read(memoScope), at('2026-08-07T18:00:00').getTime());
  assert.equal(read(memoScope), at('2026-08-07T18:00:00').getTime());
  // A changed due on the same task object is never served from the old entry.
  subject.original_end_date = at('2026-08-05T00:00:00');
  assert.equal(read(memoScope), read(plainScope));
  assert.equal(read(memoScope), at('2026-08-05T18:00:00').getTime());
  // A timed due is returned as received.
  subject.original_end_date = at('2026-08-05T09:30:00');
  assert.equal(read(memoScope), at('2026-08-05T09:30:00').getTime());
  // A line with no calendar row reads as "no calendar" (raw + 23:59:59), not the old line's window.
  subject.original_end_date = at('2026-08-05T00:00:00');
  assert.equal(read(memoScope), at('2026-08-05T18:00:00').getTime());
  subject.MACHINE = 'NOCAL';
  assert.equal(read(memoScope), read(plainScope));
  assert.notEqual(read(memoScope), at('2026-08-05T18:00:00').getTime());
});

test('hard bounds retry valid work after a fixed boundary instead of queueing an outgoing setup conflict', () => {
  const snapshot = setupSnapshot([
    scheduledTask('retry', 1, 'RED', '2026-08-03T18:00:00'),
    scheduledTask('fixed', 1, 'BLUE', '2026-08-03T18:00:00', '2026-08-03T09:15:00', '2026-08-03T10:15:00'),
  ], { firmedIds: ['fixed'] });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth({ rows: [setupRow('GREEN', 'RED', 0), setupRow('RED', 'BLUE', 30), setupRow('BLUE', 'RED', 0)] })));
  assert.equal(outcomePatchFor(result, 'retry').changes.start_date.getTime(), at('2026-08-03T10:15:00').getTime());
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds retain the valid search winner when the deadline expires mid-search', () => {
  const snapshot = setupSnapshot(['RED', 'BLUE', 'YELLOW', 'GREEN'].map((color, index) => scheduledTask(`search-${index}`, 1, color, '2026-08-03T18:00:00')));
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  let calls = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth(), { clock: () => ++calls < 50 ? 0 : 10000 }));
  assert.equal(result.searchComplete, false);
  assert.ok(result.diagnostics.candidateCount > 0, 'search produced a winner before expiration');
  assert.equal(result.dispositions.filter(d => d.status === 'scheduled').length, 4);
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds retain a pure urgent incumbent when a limited search places competing new demand', () => {
  for (const iterationCap of [2, 3]) {
    const snapshot = setupSnapshot([
      scheduledTask('urgent', 6, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
      scheduledTask('other', 6, 'BLUE', '2026-08-03T18:00:00'),
    ]);
    snapshot.masterData.plants[0].max_push_forward_days = 0;
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth(), { iterationCap }));
    assert.equal(result.searchComplete, false);
    assert.equal(result.dispositions.find(d => d.id === 'urgent').status, 'scheduled', `cap ${iterationCap} preserves urgent baseline admission`);
    assert.equal(result.dispositions.find(d => d.id === 'other').status, 'needs_planning');
    const final = SetupScheduler.applyPatchesToSnapshot(snapshot.tasks, result.patches);
    assert.equal(final.find(item => item.id === 'urgent').start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.equal(final.find(item => item.id === 'other').start_date, null);
    assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
  }
});

test('hard bounds keep valid incumbent admission when another original interval fails final validation', () => {
  const snapshot = setupSnapshot([
    scheduledTask('urgent', 6, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
    scheduledTask('other', 6, 'BLUE', '2026-08-03T18:00:00'),
    // This malformed interval intersects the horizon, so it remains in
    // optimizer accounting while a wholly future interval would be preserved
    // outside the run's scope.
    scheduledTask('invalid-current', 1, 'YELLOW', '2026-08-03T18:00:00', '2026-08-03T17:00:00', '2026-08-03T19:00:00'),
  ]);
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth(), { iterationCap: 2 }));
  assert.equal(result.dispositions.find(d => d.id === 'urgent').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'invalid-current').status, 'needs_planning');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds timeout preserves valid original runtime while queueing a malformed peer', () => {
  const snapshot = setupSnapshot([
    scheduledTask('valid-current', 2, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T10:00:00'),
    scheduledTask('bad-duration', 2, 'RED', '2026-08-03T18:00:00', '2026-08-03T11:00:00', '2026-08-03T12:00:00'),
  ]);
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth(), { clock: () => 10000, deadline: 1 }));
  assert.equal(result.dispositions.find(d => d.id === 'valid-current').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'bad-duration').status, 'needs_planning');
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds admit an urgent order when a later bridge reduces setup into fixed work', () => {
  const snapshot = setupSnapshot([
    scheduledTask('urgent-red', 6, 'RED', '2026-08-03T14:00:00'),
    scheduledTask('bridge-blue', 1, 'BLUE', '2026-08-03T16:00:00'),
    scheduledTask('fixed-yellow', 1, 'YELLOW', '2026-08-03T18:00:00', '2026-08-03T17:00:00', '2026-08-03T18:00:00'),
  ], { firmedIds: ['fixed-yellow'] });
  snapshot.masterData.plants[0].max_push_forward_days = 0;
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('GREEN', 'YELLOW', 0),
    setupRow('RED', 'BLUE', 0), setupRow('RED', 'YELLOW', 240), setupRow('BLUE', 'RED', 0), setupRow('BLUE', 'YELLOW', 0),
  ] });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { iterationCap: 1000 }));
  assert.equal(result.dispositions.find(d => d.id === 'urgent-red').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'bridge-blue').status, 'scheduled');
  assert.equal(outcomePatchFor(result, 'urgent-red').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(outcomePatchFor(result, 'bridge-blue').changes.start_date.getTime(), at('2026-08-03T14:00:00').getTime());
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds retain a found one-hour Tuesday placement when restoring an urgent Monday incumbent', () => {
  // Min Changeover is covered by the count-admission test below (D11).
  for (const strategy of ['due-date', 'spt']) for (const separateLine of [false, true]) {
    const snapshot = setupSnapshot([
      scheduledTask('urgent-monday', 6, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
      scheduledTask('other-monday', 6, 'BLUE', '2026-08-03T18:00:00'),
      scheduledTask('tuesday-hour', 1, 'BLUE', '2026-08-04T18:00:00'),
    ]);
    const setup = setupTruth();
    if (separateLine) {
      snapshot.tasks[2].MACHINE = 'L2';
      snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });
      snapshot.calendars.L2 = { workHours: OPEN_HOURS };
      setup.machine_states.push({ ...setup.machine_states[0], machine: 'L2' });
    }
    Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
    const bounds = dueDateBounds(setup, {
      iterationCap: 2, horizonEnd: at('2026-08-04T18:00:00'),
    });
    const result = strategy === 'spt' ? SetupScheduler.evaluateSptWithSetup(snapshot, bounds)
      : SetupScheduler.evaluateDueDateFirst(snapshot, bounds, strategy);
    assert.equal(result.dispositions.find(d => d.id === 'urgent-monday').status, 'scheduled');
    assert.equal(result.dispositions.find(d => d.id === 'other-monday').status, 'needs_planning');
    assert.equal(result.dispositions.find(d => d.id === 'tuesday-hour').status, 'scheduled',
      JSON.stringify(result.dispositions));
    assert.equal(outcomePatchFor(result, 'tuesday-hour').changes.start_date.getTime(), at('2026-08-04T08:00:00').getTime());
    assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
  }
});

test('Min Changeover admits by count: two orders beat the one-order incumbent even though the incumbent is the more urgent order (D11)', () => {
  for (const separateLine of [false, true]) {
    const snapshot = setupSnapshot([
      scheduledTask('urgent-monday', 6, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
      scheduledTask('other-monday', 6, 'BLUE', '2026-08-03T18:00:00'),
      scheduledTask('tuesday-hour', 1, 'BLUE', '2026-08-04T18:00:00'),
    ]);
    const setup = setupTruth();
    if (separateLine) {
      snapshot.tasks[2].MACHINE = 'L2';
      snapshot.masterData.lines.push({ plant: 'P1', machine: 'L2' });
      snapshot.calendars.L2 = { workHours: OPEN_HOURS };
      setup.machine_states.push({ ...setup.machine_states[0], machine: 'L2' });
    }
    Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, {
      iterationCap: 2, horizonEnd: at('2026-08-04T18:00:00'),
    }), 'min-changeover');
    const scheduledIds = result.dispositions.filter(d => d.status === 'scheduled').map(d => d.id);
    assert.equal(scheduledIds.length, 2, JSON.stringify(result.dispositions));
    assert.ok(scheduledIds.includes('tuesday-hour'));
    assert.equal(outcomePatchFor(result, 'tuesday-hour').changes.start_date.getTime(), at('2026-08-04T08:00:00').getTime());
    assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
  }
});

test('Min Changeover: with equal admission the lower-setup plan wins even though it serves the later-due order (D1: setup over lateness)', () => {
  // Only one of the two 6h orders fits the 10h window. RED is due first but
  // costs 120 min of setup from GREEN; BLUE is due a day later and costs 10.
  const snapshot = () => setupSnapshot([
    scheduledTask('early-red', 6, 'RED', '2026-08-03T18:00:00'),
    scheduledTask('late-blue', 6, 'BLUE', '2026-08-04T18:00:00'),
  ]);
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 120), setupRow('GREEN', 'BLUE', 10)] });

  const min = SetupScheduler.evaluateMinChangeover(snapshot(), dueDateBounds(setup));
  assert.equal(outcomePatchFor(min, 'late-blue').changes.planning_status, 'scheduled');
  assert.equal(outcomePatchFor(min, 'early-red').changes.planning_status, 'needs_planning');
  assert.equal(min.objective.setupMinutes, 10);

  // Control: Due Date still serves the urgent order first.
  const due = SetupScheduler.evaluateDueDateFirst(snapshot(), dueDateBounds(setup), 'due-date');
  assert.equal(outcomePatchFor(due, 'early-red').changes.planning_status, 'scheduled');
});

test('Min Changeover: a plan admitting one fewer order loses even with far less setup (D11: admission by count first)', () => {
  // Both 4h orders fit the 10h window only back to back (4h + 90 min + 4h + 5 min of
  // setup = 9h35). Admitting just one needs a single 5 min setup, but admission
  // count outranks setup minutes, so both must be admitted.
  const snapshot = setupSnapshot([
    scheduledTask('count-blue', 4, 'BLUE', '2026-08-03T18:00:00'),
    scheduledTask('count-red', 4, 'RED', '2026-08-03T18:00:00'),
  ]);
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'BLUE', 5), setupRow('GREEN', 'RED', 5),
    setupRow('BLUE', 'RED', 90), setupRow('RED', 'BLUE', 90),
  ] });
  const result = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setup));
  assert.equal(outcomePatchFor(result, 'count-blue').changes.planning_status, 'scheduled');
  assert.equal(outcomePatchFor(result, 'count-red').changes.planning_status, 'scheduled');
  assert.equal(result.objective.scheduledCount, 2);
  assert.equal(result.objective.setupMinutes, 95);
});

test('Min Changeover never places before the pull-forward floor and respects the push-forward limit whenever an in-window plan exists (D9)', () => {
  // Grouping by color (RED+RED, BLUE+BLUE) would save setup but is impossible
  // inside each order's own window, so each order must stay in its day.
  const snapshot = setupSnapshot([
    scheduledTask('mon-red', 4, 'RED', '2026-08-03T18:00:00'),
    scheduledTask('mon-blue', 4, 'BLUE', '2026-08-03T18:00:00'),
    scheduledTask('wed-red', 4, 'RED', '2026-08-05T18:00:00'),
    scheduledTask('wed-blue', 4, 'BLUE', '2026-08-05T18:00:00'),
  ]);
  Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 5), setupRow('GREEN', 'BLUE', 30),
    setupRow('RED', 'BLUE', 60), setupRow('BLUE', 'RED', 60),
  ] });
  const result = SetupScheduler.evaluateMinChangeover(snapshot, dueDateBounds(setup, { horizonEnd: at('2026-08-06T18:00:00') }));
  const windows = { 'mon-red': 3, 'mon-blue': 3, 'wed-red': 5, 'wed-blue': 5 };
  for (const [id, day] of Object.entries(windows)) {
    const change = outcomePatchFor(result, id).changes;
    assert.equal(change.planning_status, 'scheduled', id);
    assert.ok(change.start_date.getTime() >= at(`2026-08-0${day}T00:00:00`).getTime(), `${id} starts at or after its pull-forward floor`);
    assert.ok(change.end_date.getTime() <= at(`2026-08-0${day + 1}T00:00:00`).getTime(), `${id} ends within its push-forward limit`);
  }
  assert.equal(result.objective.overCap, 0);
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('hard bounds do not retain a donor placement that breaks setup capacity around the incumbent', () => {
  const snapshot = setupSnapshot([
    scheduledTask('urgent-monday', 6, 'RED', '2026-08-03T18:00:00', '2026-08-03T08:00:00', '2026-08-03T14:00:00'),
    scheduledTask('other-monday', 6, 'BLUE', '2026-08-03T18:00:00'),
    scheduledTask('tuesday-hour', 1, 'BLUE', '2026-08-04T18:00:00'),
  ]);
  Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 0, max_push_forward_days: 0 });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth({ rows: [setupRow('RED', 'BLUE', 120)] }), {
    iterationCap: 2, horizonEnd: at('2026-08-04T18:00:00'),
  }));
  assert.equal(result.dispositions.find(d => d.id === 'urgent-monday').status, 'scheduled');
  assert.equal(result.dispositions.find(d => d.id === 'tuesday-hour').status, 'needs_planning');
  assert.doesNotMatch(result.dispositions.find(d => d.id === 'tuesday-hour').reason.message, /incumbent/i);
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
});

test('Due Date finds September capacity for the three queued orders on machine 700', () => {
  // The supplied full machine list, with its one-hour runtimes and SAP dates.
  // Calendar/setup are not in the grid export: use working weekdays 07-19
  // and zero setup to isolate search ordering from unavailable capacity.
  const rows = [
    ['1994343884', 'RUBY', '09-11', '09-11T07:00'],
    ['1977020090', 'RACING RED', '09-11', '09-11T07:00'],
    ['1987588030', 'RACING RED', '09-11', '09-11T07:00'],
    ['2014359434', 'RACING RED', '10-19', '10-12T07:00'],
    ['1984969285', 'RUBY', '10-12', '09-16T06:15'],
    ['1976666438', 'BLACK', '10-12', '09-16T06:15'],
    ['1986342625', 'BLACK', '10-12', '09-16T06:15'],
    ['1980458601', 'RACING RED', '10-15', '10-09T13:00'],
    ['1978145551', 'CLEAR', '10-16', '10-09T07:00'],
    ['2014753668', 'CLEAR', '09-23', '09-21T09:00'],
    ['1976670515', 'CLEAR', '09-23', '09-21T10:00'],
    ['1982861213', 'RACING RED', '09-25', '09-28T09:00'],
    ['2000711637', 'RUBY', '09-25', '09-29T12:00'],
    ['2001956538', 'RUBY', '09-14', '09-14T07:00'],
    ['2022516338', 'BALSAM', '09-14', '09-14T07:00'],
    ['2022516620', 'MAPLE', '09-14', '09-14T07:00'],
    ['2022516713', 'MAPLE', '09-14', '09-14T07:00'],
    ['1974596522', 'RUBY', '09-14', '09-14T07:00'],
    ['1974676793', 'RUBY', '09-14', '09-14T07:00'],
    ['1978146468', 'WHITE', '09-17', '09-17T07:00'],
    ['1978145053', 'RACING RED', '09-17', '09-17T07:00'],
    ['1974676179', 'RUBY', '09-17', '09-17T07:00'],
    ['2029706296', 'RACING RED', '09-21', '09-28T08:00'],
    ['1997183440', 'WHITE', '09-21', null],
    ['1983178131', 'WHITE', '09-21', null],
    ['1994529274', 'RUBY', '09-21', null],
    ['2029706297', 'RACING RED', '09-29', '09-28T10:00'],
    ['2001944433', 'TEAL', '09-30', '09-29T16:00'],
    ['1997183591', 'BLACK', '10-01', '09-24T07:00'],
    ['1984088601', 'RACING RED', '10-02', '09-28T11:00'],
    ['2017039900', 'CLEAR', '10-05', '09-28T07:00'],
    ['1979293486', 'RACING RED', '10-05', '09-28T12:00'],
    ['2027199137', 'WHITE', '10-05', '09-29T10:00'],
    ['2000507995', 'RUBY', '10-05', '09-29T13:00'],
    ['1984968232', 'RUBY', '10-05', '09-29T14:00'],
    ['1973892015', 'RUBY', '10-05', '09-29T15:00'],
  ];
  const floor = at('2026-09-19T00:00:00');
  const tasks = rows.map(([id, color, due, start]) => {
    const item = scheduledTask(id, 1, color, `2026-${due}T19:00:00`, start ? `2026-${start}:00` : null);
    item.MACHINE = '700';
    item.end_date = item.start_date ? new Date(+item.start_date + 3600000) : null;
    item.planning_status = start ? 'scheduled' : 'needs_planning';
    return item;
  });
  const snapshot = setupSnapshot(tasks, { firmedIds: tasks.filter(item => item.start_date && item.start_date < floor).map(item => item.id) });
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, day === 0 || day === 6 ? null : [7, 19]]));
  snapshot.calendars = { '700': { workHours: hours } };
  snapshot.plants.P1.workHours = hours;
  snapshot.masterData.lines = [{ plant: 'P1', machine: '700' }];
  Object.assign(snapshot.masterData.plants[0], { max_pull_forward_days: 7, max_push_forward_days: 7 });
  const setup = setupTruth({ current: null });
  const bounds = dueDateBounds(setup, { exactSearchThreshold: 8, iterationCap: 20000,
    now: at('2026-09-09T08:00:00'), horizonEnd: at('2026-10-14T18:00:00'), notBefore: () => floor });
  for (const iterationCap of [64, 20000]) {
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, { ...bounds, iterationCap }, 'due-date');
    for (const id of ['1997183440', '1983178131', '1994529274']) {
      const disposition = result.dispositions.find(d => d.id === id);
      assert.equal(disposition.status, 'scheduled', JSON.stringify({ disposition, diagnostics: result.diagnostics }));
      const placed = outcomePatchFor(result, id).changes;
      assert.ok(placed.start_date >= floor && placed.end_date <= at('2026-09-23T00:00:00'), id);
    }
    assert.equal(result.dispositions.filter(d => d.status === 'needs_planning').length, 0);
    assert.equal(result.validationFindings.some(f => f.severity === 'error'), false);
  }
});

test('admission diagnostics distinguish an unrecorded line state from an uncovered matrix row', () => {
  const rejected = /(?:unavailable|unknown|uncovered|infeasible|missing|disabled|fail)/i; // optimize-ui.mts summarizeCandidate
  // Case 1: line state unrecorded (current: null) — first order admitted at zero.
  // The order-level 'admitted-state-unrecorded' comes from candidateForSequence.
  const stateless = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('n6-first', 1, 'RED', '2026-08-03T10:00')]),
    dueDateBounds(setupTruth({ current: null, rows: [setupRow('GREEN', 'RED', 5)] })),
  );
  const stateReason = stateless.explanation.find(r => r.code === 'admitted-state-unrecorded' && r.taskId === 'n6-first');
  assert.ok(stateReason, 'unknown incoming state gets its own admitted code from candidateForSequence');
  assert.equal(rejected.test(`${stateReason.code} ${stateReason.message}`), false, 'must not be stamped rejected in the preview');
  assert.equal(stateless.explanation.some(r => r.code === 'initial-state-unknown' && r.taskId === 'n6-first'), false, 'no task-specific initial-state-unknown');
  assert.ok(stateless.missingEdges.some(e => e.reason === 'initial-state-unknown'), 'edge reason is unchanged');
  // Verify all explanations for this task avoid the rejected regex
  const taskExplanations = stateless.explanation.filter(r => r.taskId === 'n6-first');
  assert.ok(taskExplanations.length > 0);
  taskExplanations.forEach(r => {
    assert.equal(rejected.test(`${r.code} ${r.message}`), false, `"${r.code}" must not trigger rejected regex`);
  });
  // Case 2: both states known, no row — existing code still fires.
  const uncovered = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('n6-red', 1, 'RED', '2026-08-03T10:00')]),
    dueDateBounds(setupTruth({ current: 'GREEN', rows: [setupRow('GREEN', 'BLUE', 5)] })),
  );
  const rowReason = uncovered.explanation.find(r => r.code === 'admitted-without-setup' && r.taskId === 'n6-red');
  assert.ok(rowReason);
  assert.equal(rejected.test(`${rowReason.code} ${rowReason.message}`), false);
  assert.ok(uncovered.missingEdges.some(e => e.reason === 'scheduled-without-setup' && e.successorOrderId === 'n6-red'));
  // Case 3: per-line preamble (SPT) emits admitted-state-unrecorded for first-order admission.
  const sptPreamble = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([scheduledTask('n6-spt', 1, 'RED', '2026-08-03T10:00')]),
    dueDateBounds(setupTruth({ current: null, rows: [setupRow('GREEN', 'RED', 5)] })),
  );
  const sptExplanations = sptPreamble.explanation.filter(r => r.taskId === 'n6-spt');
  assert.ok(sptExplanations.length > 0, 'SPT includes explanation for first task');
  const sptStateReason = sptExplanations.find(r => r.code === 'admitted-state-unrecorded');
  assert.ok(sptStateReason, 'SPT emits admitted-state-unrecorded from candidateForSequence');
  sptExplanations.forEach(r => {
    assert.equal(rejected.test(`${r.code} ${r.message}`), false, `"${r.code}" must not trigger rejected regex`);
  });
});

function policySnapshot(tasks, config) {
  const snapshot = setupSnapshot(tasks);
  snapshot.masterData = { plants: [{ plant: 'P1', setup_policy_config: config }], lines: [{ plant: 'P1', machine: 'L1' }] };
  return snapshot;
}
const UNCOVERED = () => setupTruth({ current: 'GREEN', rows: [setupRow('GREEN', 'BLUE', 5)] }); // GREEN->RED has no row

test('unknownSetupPolicy zero is byte-identical to the default', () => {
  const red = () => scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const a = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red()]), dueDateBounds(UNCOVERED()));
  const b = SetupScheduler.evaluateDueDateFirst(policySnapshot([red()], { unknownSetupPolicy: 'zero', version: 2 }), dueDateBounds(UNCOVERED()));
  assert.deepEqual(b.patches, a.patches);
  assert.deepEqual(b.explanation.map(r => r.code), a.explanation.map(r => r.code));
});

test('unknownSetupPolicy plantDefaultMinutes charges the configured minutes and keeps the N6 code', () => {
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red], { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 45, version: 2 }),
    dueDateBounds(UNCOVERED()),
  );
  assert.equal(patchFor(result, 'n8-red').changes.start_date.getTime(), at('2026-08-03T08:45').getTime(),
    '45 setup minutes precede the first productive minute');
  assert.equal(result.objective?.setupMinutes, 45);
  assert.ok(result.explanation.some(r => r.code === 'admitted-without-setup' && r.taskId === 'n8-red'));
  assert.ok(result.missingEdges.some(e => e.reason === 'scheduled-without-setup' && e.successorOrderId === 'n8-red'));
});

test('unknownSetupPolicy excludeFromSearch queues the order with a setup_transition_unrecorded reason and never freezes the line', () => {
  // Task ids are chosen (not 'n8-red'/'n8-blue') so the search's deterministic
  // sequenceKey tie-break (ordinalCompare over joined task ids — see
  // compareDueDateCandidate) settles on evaluating 'n8-red' as the line's
  // first order in the winning candidate, i.e. against the line's actual
  // recorded current state (GREEN), not against a chain state produced by
  // whichever order happens to sort first.
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const blue = scheduledTask('n8-zblue', 1, 'BLUE', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red, blue], { unknownSetupPolicy: 'excludeFromSearch', version: 2 }),
    dueDateBounds(UNCOVERED()),
  );
  assert.ok(patchFor(result, 'n8-zblue'), 'the covered order is still placed (no line freeze)');
  const queued = result.dispositions.find(d => d.id === 'n8-red');
  assert.equal(queued?.status, 'needs_planning');
  assert.equal(queued?.reason?.code, 'setup_transition_unrecorded');
  assert.match(queued.reason.message, /GREEN/); assert.match(queued.reason.message, /RED/);
  assert.deepEqual(result.unchangedLines, []);
});

test('unknownSetupPolicy plantDefaultMinutes never charges a setup-incompatible line (validation and objective facts agree at zero)', () => {
  // A setup-incompatible line is tail-placed via placeWholeLineAsTail
  // (never-freeze), but must never be charged the plant default: chargeable
  // is gated on line compatibility, not just the configured policy.
  const disabledLineOrder = scheduledTask('n8-compat-disabled-blue', 1, 'BLUE', '2026-08-03T10:00:00');
  const snapshot = setupSnapshot([disabledLineOrder]);
  snapshot.masterData = {
    plants: [{
      plant: 'P1',
      setup_policy_config: { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 45, version: 2 },
    }],
    lines: [{
      plant: 'P1', machine: 'L1', setup_compatible: false,
      setup_compatibility_reason: 'Tooling signature differs on this line',
    }],
  };
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(UNCOVERED()));

  assert.ok(patchFor(result, 'n8-compat-disabled-blue'), 'still tail-placed (never freeze)');
  assert.equal(result.validationFindings.some(f => f.code === 'setup_overlap'), false);
  assert.equal(result.validationFindings.some(f => f.code === 'setup_floor'), false);
  assert.equal(result.objective?.setupMinutes, 0);
});

test('unknownSetupPolicy plantDefaultMinutes reserves the charged minutes in a tail placement so validation and objective facts agree with it', () => {
  // Two orders with an unresolvable (blank) own state are diverted straight
  // to placeUnknownTail, not the covered-core admission path. Under
  // plantDefaultMinutes each must now actually reserve the charged minutes
  // in its placed interval (not just report them), so the reservation and
  // the facts/validation that describe it never disagree.
  const a = scheduledTask('n8-tail-a', 1, '', '2026-08-03T09:00:00');
  const b = scheduledTask('n8-tail-b', 1, '', '2026-08-03T09:30:00');
  const snapshot = policySnapshot([a, b], { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 30, version: 2 });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth({ rows: [] })));

  const [first, second] = ['n8-tail-a', 'n8-tail-b']
    .map(id => patchFor(result, id))
    .sort((x, y) => x.changes.start_date.getTime() - y.changes.start_date.getTime());
  assert.ok(first && second, 'both tail orders are placed');
  assert.equal(
    second.changes.start_date.getTime() - first.changes.end_date.getTime(),
    30 * 60 * 1000,
    'the second tail order actually reserves the charged 30 minutes after the first',
  );
  assert.equal(result.validationFindings.some(f => f.severity === 'error'), false,
    'the optimizer never flags its own reserved tail setup as a conflict');
  assert.ok((result.objective?.setupMinutes ?? 0) >= 30, 'objective facts count the reserved minutes');
});

test('unknownSetupPolicy plantDefaultMinutes is inert on a synthetic zero-cost snapshot (byte-identical to zero)', () => {
  const red = () => scheduledTask('n8-synthetic-red', 1, 'RED', '2026-08-03T12:00');
  const synthetic = { ...UNCOVERED(), synthetic: true };
  const a = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red()], { unknownSetupPolicy: 'zero', version: 2 }),
    dueDateBounds(synthetic),
  );
  const b = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red()], { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 45, version: 2 }),
    dueDateBounds(synthetic),
  );
  assert.deepEqual(b.patches, a.patches);
  assert.deepEqual(b.explanation.map(r => r.code), a.explanation.map(r => r.code));
});

test('fragment search charges instability for moved finishes instead of a hardcoded zero', () => {
  // sequenceKey is deliberately the OPPOSITE of what a pre-fix (hardcoded-0)
  // tie-break would already prefer: with both fragments reporting
  // instabilityMinutes 0, the sequenceKey term alone would pick `shuffled`
  // ('a|b' sorts before 'b|a'), so this only passes once instabilityMinutes
  // (compared earlier in the term list) is actually wired through.
  const stable = { feasible: true, patches: [], score: [0,0,0,0,0,0,0,0], policyKey: '', sequenceKey: 'b|a',
    unadmitted: [], explanation: [], missingEdges: [], instabilityMinutes: 0 };
  const shuffled = { ...stable, sequenceKey: 'a|b', instabilityMinutes: 120 };
  for (const mode of ['min-changeover', 'spt']) {
    assert.ok(SetupScheduler.compareObjectiveFacts(
      SetupScheduler.fragmentObjectiveFactsForTest(stable),
      SetupScheduler.fragmentObjectiveFactsForTest(shuffled), mode) < 0,
      `a fragment that moved starts must lose the instability tie-break (${mode})`);
  }
  // fragmentObjectiveFacts must read candidate.instabilityMinutes (not a
  // hardcoded 0), including the `?? 0` fallback when the field is absent.
  const candidateShape = { feasible: true, patches: [], score: [0,0,0,0,0,0,0,0], policyKey: '', sequenceKey: 'x',
    unadmitted: [], explanation: [], missingEdges: [] };
  assert.equal(SetupScheduler.fragmentObjectiveFactsForTest({ ...candidateShape, instabilityMinutes: 45 }).instabilityMinutes, 45,
    'fragmentObjectiveFacts must surface a non-zero instabilityMinutes from the candidate');
  assert.equal(SetupScheduler.fragmentObjectiveFactsForTest(candidateShape).instabilityMinutes, 0,
    'fragmentObjectiveFacts falls back to 0 when instabilityMinutes is absent');
});

test('OQ50 c: a never-policy order longer than every operating window queues as overlong_never; no window at all or a plain no-fit keeps its reason', () => {
  const synthetic = setupTruth({ current: null, definition: null });
  const run = (hoursByDay, runHours) => {
    const snapshot = setupSnapshot([scheduledTask('ol-a', runHours, 'RED', '2026-08-03T18:00:00')]);
    snapshot.calendars = { L1: { workHours: hoursByDay } };
    snapshot.plants = { P1: { workHours: hoursByDay } };
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(synthetic, { placementStart: at('2026-08-03T08:00:00'), horizonEnd: at('2026-08-10T18:00:00') }), 'due-date');
    return result.dispositions.find(d => d.id === 'ol-a');
  };
  const overlong = run(OPEN_HOURS, 12);   // windows are 10 h
  assert.equal(overlong.status, 'needs_planning');
  assert.equal(overlong.reason.code, 'overlong_never');
  const closed = run(Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, null])), 12);   // no window at all
  assert.equal(closed.status, 'needs_planning');
  assert.notEqual(closed.reason.code, 'overlong_never');
  const fits = run(OPEN_HOURS, 4);
  assert.equal(fits.status, 'scheduled');
});

test('senior review I9: the optimizer overlong predicate merges windows that touch at midnight (24/7 line, night shift) and counts run == span as fitting', () => {
  const synthetic = setupTruth({ current: null, definition: null });
  // A short horizon makes the order fail to place, which is when neverOverlongReason is consulted: the predicate alone
  // must not call an order overlong that the backward walk (merged spans) would place as one bar.
  const run = (hoursByDay, runHours, horizonEnd = '2026-08-17T18:00:00') => {
    const snapshot = setupSnapshot([scheduledTask('ol-a', runHours, 'RED', '2026-08-05T18:00:00')]);
    snapshot.calendars = { L1: { workHours: hoursByDay } };
    snapshot.plants = { P1: { workHours: hoursByDay } };
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(synthetic, { placementStart: at('2026-08-03T08:00:00'), horizonEnd: at(horizonEnd) }), 'due-date');
    return result.dispositions.find(d => d.id === 'ol-a');
  };
  const all = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  assert.equal(run(all([0, 24]), 30).status, 'scheduled', '24/7: a 30 h run is placed as one contiguous bar');
  assert.notEqual(run(all([0, 24]), 30, '2026-08-03T18:00:00').reason?.code, 'overlong_never', '24/7: 30 h that merely misses the horizon is not overlong');
  const night = { 0: null, 1: [22, 24], 2: [0, 6], 3: null, 4: null, 5: null, 6: null };   // Mon 22:00 -> Tue 06:00 = 8 h merged
  assert.equal(run(night, 8).status, 'scheduled', 'run == merged span length is placed, not overlong');
  assert.notEqual(run(night, 8, '2026-08-03T23:00:00').reason?.code, 'overlong_never', 'night shift: 8 h in an 8 h merged span is never overlong');
  assert.equal(run(night, 8.5, '2026-08-03T23:00:00').reason?.code, 'overlong_never', 'longer than the merged span is overlong');
  const equalWindows = all([8, 16]);
  assert.notEqual(run(equalWindows, 8, '2026-08-03T10:00:00').reason?.code, 'overlong_never', 'U20: run == window length (equal-length windows)');
  assert.equal(run(equalWindows, 9).reason?.code, 'overlong_never');
});

test('instability is keyed on the placed finish: a held finish with a moved start is stable, a moved finish is not (Reading A)', () => {
  const synthetic = setupTruth({ current: null, definition: null });
  const run = (priorStart, priorEnd) => {
    const snapshot = setupSnapshot([scheduledTask('fin-a', 1, 'RED', '2026-08-03T18:00:00', priorStart, priorEnd)]);
    const bounds = dueDateBounds(synthetic, { placementStart: at('2026-08-03T08:00:00') });
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
    result.instabilityMinutes = SetupScheduler.objectiveFactsForCandidate(snapshot, bounds, result).instabilityMinutes;
    return result;
  };
  // The optimizer places the one-hour order at 08:00-09:00. The prior bar ended at 09:00 too (its start
  // differs because the run time changed since): finish unchanged, so zero instability.
  const held = run('2026-08-03T07:00:00', '2026-08-03T09:00:00');
  assert.equal(patchFor(held, 'fin-a').changes.end_date.getTime(), at('2026-08-03T09:00:00').getTime());
  assert.equal(held.instabilityMinutes ?? 0, 0, 'a task whose finish is unchanged is not unstable even though its start moved');
  // A prior bar that started where the new one does but ended 30 minutes earlier: the start is
  // unchanged, the finish moved, so the task is unstable by exactly the finish delta.
  const moved = run('2026-08-03T08:00:00', '2026-08-03T08:30:00');
  assert.equal(patchFor(moved, 'fin-a').changes.end_date.getTime(), at('2026-08-03T09:00:00').getTime());
  assert.equal(moved.instabilityMinutes, 30);
});

// ── P3a: distribution separation (checkDistributionSeparation / finalizeCandidate) ──

// Three siblings of one SAP-distributed order (shared PARENT_ORDER + MATERIAL_NUMBER)
// on three different machines of the same work center. Each machine's own
// calendar makes ITS placement the individually-optimal (earliest legal) slot —
// there is no artificial delay injected for the test's sake, only a genuinely
// different closed-day pattern per line. That is what makes this discriminating:
// a naive fixture that just hardcoded three different start dates would exercise
// nothing about the grouping/bucket logic in checkDistributionSeparation, only
// the test author's own arithmetic. Here the finding must come from the real
// evaluator's per-line ASAP search landing on three different calendar days.
function distributionCalendars() {
  const closedOn = (days) => {
    const wh = { ...OPEN_HOURS };
    for (const d of days) wh[d] = null;
    return wh;
  };
  return {
    // 2026-08-03 is a Monday (day-of-week 1).
    L1: { workHours: OPEN_HOURS },        // open every day -> starts Mon 08/03
    L2: { workHours: closedOn([1]) },     // Monday closed -> starts Tue 08/04
    L3: { workHours: closedOn([1, 2]) },  // Mon+Tue closed -> starts Wed 08/05
  };
}

function distributionMasterData(lineOverrides = {}) {
  const line = (machine) => ({ plant: 'P1', machine, sap_workcenter: 'WC1', ...(lineOverrides[machine] ?? {}) });
  return {
    plants: [{ plant: 'P1' }],
    lines: [line('L1'), line('L2'), line('L3')],
    workcenters: [{
      plant: 'P1', sap_workcenter: 'WC1', description: null, distribution_mode: 'distribute',
      default_machine: null, max_separation: 'day', review_required: false, distribute_tooled: false,
    }],
  };
}

function distributionSiblings(due = '2026-08-06T18:00:00') {
  const parent = 'PO-DIST-1';
  const material = 'MAT-DIST';
  return [
    { ...scheduledTask('dist-a', 1, 'GREEN', due), MACHINE: 'L1', PARENT_ORDER: parent, MATERIAL_NUMBER: material },
    { ...scheduledTask('dist-b', 1, 'GREEN', due), MACHINE: 'L2', PARENT_ORDER: parent, MATERIAL_NUMBER: material },
    { ...scheduledTask('dist-c', 1, 'GREEN', due), MACHINE: 'L3', PARENT_ORDER: parent, MATERIAL_NUMBER: material },
  ];
}

function distributionSetup() {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'GREEN', 0)] });
  setup.machine_states.push(
    { machine: 'L2', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'dist L2' },
    { machine: 'L3', state_key: setupState('GREEN'), signature_version: 1, source: 'manual', reason: 'dist L3' },
  );
  return setup;
}

test('checkDistributionSeparation flags siblings whose individually-optimal per-machine placement lands on different calendar days', () => {
  const [a, b, c] = distributionSiblings();
  const snapshot = setupSnapshot([a, b, c]);
  snapshot.calendars = distributionCalendars();
  snapshot.plants = { P1: { workHours: OPEN_HOURS } };
  snapshot.masterData = distributionMasterData();

  const bounds = dueDateBounds(distributionSetup(), { horizonEnd: at('2026-08-06T18:00:00') });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);

  // Confirm each machine actually lands on its own individually-optimal (earliest
  // legal) day — nothing here is contrived directly onto the task's dates.
  assert.equal(patchFor(result, 'dist-a').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(patchFor(result, 'dist-b').changes.start_date.getTime(), at('2026-08-04T08:00:00').getTime());
  assert.equal(patchFor(result, 'dist-c').changes.start_date.getTime(), at('2026-08-05T08:00:00').getTime());

  const findings = result.validationFindings.filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].parents.slice().sort(), ['dist-a', 'dist-b', 'dist-c']);
  assert.equal(findings[0].severity, 'warning');
  assert.ok(findings[0].message && findings[0].message.length > 0);

  // Never blocks/never affects score: all three siblings are still 'scheduled'.
  for (const id of ['dist-a', 'dist-b', 'dist-c']) {
    assert.equal(result.dispositions.find(d => d.id === id).status, 'scheduled');
  }

  // And it does not change which candidate the search picks: an otherwise
  // identical run with no shared PARENT_ORDER (so no grouping/finding at all)
  // must produce the exact same placements and objective score.
  const unrelated = [a, b, c].map((t, i) => ({ ...t, PARENT_ORDER: null, id: `${t.id}-unrelated-${i}` }));
  const baseline = SetupScheduler.evaluateDueDateFirst({ ...snapshot, tasks: unrelated }, bounds);
  assert.equal(baseline.validationFindings.filter(f => f.code === 'distribution_separation').length, 0);
  assert.deepEqual(result.score, baseline.score);
  assert.deepEqual(
    scheduledPatches(result).map(p => +p.changes.start_date).sort(),
    scheduledPatches(baseline).map(p => +p.changes.start_date).sort(),
  );
});

test('checkDistributionSeparation stays silent when siblings share a bucket, the policy is none, or the policy is unresolvable', () => {
  const bounds = dueDateBounds(distributionSetup(), { horizonEnd: at('2026-08-06T18:00:00') });

  // (a) Same bucket: every line open every day, so all three start Mon 08/03.
  {
    const [a, b, c] = distributionSiblings();
    const snapshot = setupSnapshot([a, b, c]);
    snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS }, L3: { workHours: OPEN_HOURS } };
    snapshot.plants = { P1: { workHours: OPEN_HOURS } };
    snapshot.masterData = distributionMasterData();
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
    assert.equal(patchFor(result, 'dist-a').changes.start_date.getTime(), patchFor(result, 'dist-b').changes.start_date.getTime());
    assert.equal(patchFor(result, 'dist-a').changes.start_date.getTime(), patchFor(result, 'dist-c').changes.start_date.getTime());
    assert.equal(result.validationFindings.filter(f => f.code === 'distribution_separation').length, 0,
      'siblings landing in the same bucket must not raise a finding');
  }

  // (b) Different buckets (the discriminating layout above), but the work
  // center's policy is 'none'.
  {
    const [a, b, c] = distributionSiblings();
    const snapshot = setupSnapshot([a, b, c]);
    snapshot.calendars = distributionCalendars();
    snapshot.plants = { P1: { workHours: OPEN_HOURS } };
    snapshot.masterData = distributionMasterData();
    snapshot.masterData.workcenters[0].max_separation = 'none';
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
    assert.notEqual(patchFor(result, 'dist-a').changes.start_date.getTime(), patchFor(result, 'dist-c').changes.start_date.getTime(),
      'sanity: the siblings really do land on different days in this layout');
    assert.equal(result.validationFindings.filter(f => f.code === 'distribution_separation').length, 0,
      'max_separation "none" must never raise a finding regardless of drift');
  }

  // (c) Different buckets, but NO sibling's line resolves to a work center at
  // all (checkDistributionSeparation must stay silent when the policy is
  // truly unresolvable across the whole group, not just for one sibling).
  {
    const [a, b, c] = distributionSiblings();
    const snapshot = setupSnapshot([a, b, c]);
    snapshot.calendars = distributionCalendars();
    snapshot.plants = { P1: { workHours: OPEN_HOURS } };
    snapshot.masterData = distributionMasterData();
    for (const line of snapshot.masterData.lines) delete line.sap_workcenter; // no sibling resolves to a work center
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
    assert.notEqual(patchFor(result, 'dist-a').changes.start_date.getTime(), patchFor(result, 'dist-c').changes.start_date.getTime(),
      'sanity: the siblings really do land on different days in this layout');
    assert.equal(result.validationFindings.filter(f => f.code === 'distribution_separation').length, 0,
      'a group where no sibling resolves to a policy must never raise a finding');
  }

  // (d) Different buckets; only the FIRST sibling (group[0]) fails to resolve
  // to a work center, but a later sibling (dist-b, on L2) still resolves to
  // WC1's 'day' policy. This mirrors nimbus-compute-core.js's computeAlerts,
  // which scans every sibling for a resolvable policy rather than stopping at
  // the first — checkDistributionSeparation must do the same, so the two
  // never disagree purely due to sibling-iteration order. The finding must
  // still fire here (previously it was silently swallowed because only
  // group[0] was inspected).
  {
    const [a, b, c] = distributionSiblings();
    const snapshot = setupSnapshot([a, b, c]);
    snapshot.calendars = distributionCalendars();
    snapshot.plants = { P1: { workHours: OPEN_HOURS } };
    snapshot.masterData = distributionMasterData();
    delete snapshot.masterData.lines[0].sap_workcenter; // L1 (dist-a) now has no work center
    const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
    assert.notEqual(patchFor(result, 'dist-a').changes.start_date.getTime(), patchFor(result, 'dist-c').changes.start_date.getTime(),
      'sanity: the siblings really do land on different days in this layout');
    const findings = result.validationFindings.filter(f => f.code === 'distribution_separation');
    assert.equal(findings.length, 1,
      'a resolvable policy on ANY sibling (not just group[0]) must still raise the finding');
    assert.deepEqual(findings[0].parents.slice().sort(), ['dist-a', 'dist-b', 'dist-c']);
  }
});

// D50: an undated sibling (no start_date yet) must be excluded from both the
// group-size gate and the bucket comparison — mirroring nimbus-compute-core.js's
// computeAlerts, which filters to `dated` before either check. Before the fix,
// every group member (dated or not) was bucketed, so a still-undated sibling
// — whose bucket key is a constant distinct from any real date's — made
// `buckets.some(bucket => bucket !== buckets[0])` true even when the dated
// siblings genuinely agreed, raising a false finding.
test('checkDistributionSeparationForTest ignores an undated sibling: two dated siblings sharing a bucket plus one undated gives no finding', () => {
  const parent = 'PO-DIST-UNDATED';
  const material = 'MAT-DIST-UNDATED';
  const dated1 = { id: 'dist-undated-a', MACHINE: 'L1', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: at('2026-08-03T08:00:00'), end_date: at('2026-08-03T10:00:00') };
  const dated2 = { id: 'dist-undated-b', MACHINE: 'L2', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: at('2026-08-03T14:00:00'), end_date: at('2026-08-03T16:00:00') };
  const undated = { id: 'dist-undated-c', MACHINE: 'L3', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: null };
  const snapshot = setupSnapshot([dated1, dated2, undated]);
  snapshot.masterData = distributionMasterData();

  const findings = SetupScheduler.checkDistributionSeparationForTest([], snapshot)
    .filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 0,
    'an undated sibling must not be bucketed as its own mismatching group of one when the dated siblings genuinely share a bucket');
});

test('checkDistributionSeparationForTest still requires at least two DATED siblings: one dated plus one undated gives no finding', () => {
  const parent = 'PO-DIST-UNDATED-SOLO';
  const material = 'MAT-DIST-UNDATED-SOLO';
  const dated = { id: 'dist-solo-a', MACHINE: 'L1', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: at('2026-08-03T08:00:00'), end_date: at('2026-08-03T10:00:00') };
  const undated = { id: 'dist-solo-b', MACHINE: 'L2', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: null };
  const snapshot = setupSnapshot([dated, undated]);
  snapshot.masterData = distributionMasterData();

  const findings = SetupScheduler.checkDistributionSeparationForTest([], snapshot)
    .filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 0,
    'a group with fewer than two DATED siblings has nothing to compare and must never raise a finding');
});

test('checkDistributionSeparationForTest still flags dated siblings landing in different buckets with an undated sibling present', () => {
  const parent = 'PO-DIST-UNDATED-MISMATCH';
  const material = 'MAT-DIST-UNDATED-MISMATCH';
  const dated1 = { id: 'dist-mis-a', MACHINE: 'L1', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: at('2026-08-03T08:00:00'), end_date: at('2026-08-03T10:00:00') };
  const dated2 = { id: 'dist-mis-b', MACHINE: 'L2', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: at('2026-08-05T08:00:00'), end_date: at('2026-08-05T10:00:00') };
  const undated = { id: 'dist-mis-c', MACHINE: 'L3', PARENT_ORDER: parent, MATERIAL_NUMBER: material, start_date: null };
  const snapshot = setupSnapshot([dated1, dated2, undated]);
  snapshot.masterData = distributionMasterData();

  const findings = SetupScheduler.checkDistributionSeparationForTest([], snapshot)
    .filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 1, 'genuinely different-bucket DATED siblings must still raise the finding');
  assert.deepEqual(findings[0].parents.slice().sort(), ['dist-mis-a', 'dist-mis-b'],
    'the undated sibling must not appear in parents — it was never part of the comparison');
});

// Backward scheduling OQ38: separation is judged on the FINISH (hand-mirrored in nimbus-compute-core.js computeAlerts).
// A 70/30 family: the long child starts a day earlier but both end together -> nothing raised. The same starts with
// finishes on different days -> raised.
test('checkDistributionSeparationForTest judges the finish: a 70/30 family finishing together raises nothing, different finishes do', () => {
  const parent = 'PO-DIST-FINISH';
  const material = 'MAT-DIST-FINISH';
  const long = { id: 'dist-fin-a', MACHINE: 'L1', PARENT_ORDER: parent, MATERIAL_NUMBER: material,
    start_date: at('2026-08-03T18:00:00'), end_date: at('2026-08-04T16:00:00') };
  const short = { id: 'dist-fin-b', MACHINE: 'L2', PARENT_ORDER: parent, MATERIAL_NUMBER: material,
    start_date: at('2026-08-04T13:00:00'), end_date: at('2026-08-04T16:00:00') };
  const together = setupSnapshot([long, short]);
  together.masterData = distributionMasterData();
  assert.equal(SetupScheduler.checkDistributionSeparationForTest([], together)
    .filter(f => f.code === 'distribution_separation').length, 0, 'different start days, same finish: no finding');

  const apart = setupSnapshot([long, { ...short, end_date: at('2026-08-05T16:00:00') }]);
  apart.masterData = distributionMasterData();
  const findings = SetupScheduler.checkDistributionSeparationForTest([], apart)
    .filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 1, 'finishes on different days raise the finding');
});

// Regression: fillPlanningGaps used to silently discard distribution_separation
// findings whenever it had at least one pending order to try (the common
// case), because its final `result.validationFindings = validateCandidate(...)`
// assignment replaces rather than merges — and validateCandidate has no
// knowledge of this check at all. finalizeCandidate's own pass can't see this
// either: it runs BEFORE gap fill, so a violation that only exists among
// siblings placed *by* gap fill was never checked, never mind preserved.
test('fillPlanningGaps recomputes distribution_separation against its own final placements instead of discarding it via the validateCandidate overwrite', () => {
  const [a, b, c] = distributionSiblings();
  const snapshot = setupSnapshot([a, b, c]);
  snapshot.calendars = distributionCalendars();
  snapshot.plants = { P1: { workHours: OPEN_HOURS } };
  snapshot.masterData = distributionMasterData();

  // An already-expired primary-search deadline leaves all three siblings
  // needs_planning coming out of evaluateDueDateFirst/finalizeCandidate, so
  // pending.length > 0 when fillPlanningGaps runs -- the exact branch that
  // used to overwrite validationFindings with validateCandidate's output.
  const bounds = dueDateBounds(distributionSetup(), { deadline: -2000, horizonEnd: at('2026-08-06T18:00:00') });
  const candidate = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  for (const id of ['dist-a', 'dist-b', 'dist-c']) {
    assert.equal(candidate.dispositions.find(d => d.id === id).status, 'needs_planning',
      'sanity: the expired deadline must leave all three siblings pending, not yet scheduled');
  }
  // Nothing is scheduled yet, so checkDistributionSeparation (which skips
  // needs_planning tasks) had no group to flag -- the violation genuinely
  // does not exist until gap fill places these siblings.
  assert.equal(candidate.validationFindings.filter(f => f.code === 'distribution_separation').length, 0);

  const result = SetupScheduler.fillPlanningGaps(snapshot, bounds, candidate);

  // Gap fill's own per-line ASAP capacity search places each sibling on its
  // individually-optimal day given each line's own closed-day pattern --
  // the same discriminating layout used by the finalizeCandidate-only test
  // above, landing on three different calendar days.
  for (const id of ['dist-a', 'dist-b', 'dist-c']) {
    assert.equal(result.dispositions.find(d => d.id === id).status, 'scheduled', id);
  }
  assert.equal(+patchFor(result, 'dist-a').changes.start_date, +at('2026-08-03T08:00:00'));
  assert.equal(+patchFor(result, 'dist-b').changes.start_date, +at('2026-08-04T08:00:00'));
  assert.equal(+patchFor(result, 'dist-c').changes.start_date, +at('2026-08-05T08:00:00'));

  const findings = result.validationFindings.filter(f => f.code === 'distribution_separation');
  assert.equal(findings.length, 1,
    'a violation newly created by gap fill\'s own placements must survive in the final result, ' +
    'not be silently dropped by the validateCandidate overwrite');
  assert.deepEqual(findings[0].parents.slice().sort(), ['dist-a', 'dist-b', 'dist-c']);
  assert.equal(findings[0].severity, 'warning');
});

test('#37 gap fill keeps the setup_transition_unrecorded reason instead of overwriting it with "No slot found"', () => {
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const blue = scheduledTask('n8-zblue', 1, 'BLUE', '2026-08-03T12:00');
  const snapshot = policySnapshot([red, blue], { unknownSetupPolicy: 'excludeFromSearch', version: 2 });
  const bounds = dueDateBounds(UNCOVERED());
  const primary = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  assert.equal(primary.dispositions.find(d => d.id === 'n8-red').reason.code, 'setup_transition_unrecorded');
  const filled = SetupScheduler.fillPlanningGaps(snapshot, bounds, primary);
  const queued = filled.dispositions.find(d => d.id === 'n8-red');
  assert.equal(queued.status, 'needs_planning');
  assert.equal(queued.reason.code, 'setup_transition_unrecorded', 'the actionable reason survives the capacity check');
  assert.equal(filled.patches.find(p => p.id === 'n8-red').changes.planning_reason.code, 'setup_transition_unrecorded',
    'and so does the persisted planning_reason patch');
});

test('gap fill on a candidate carrying an error finding keeps queued orders\' prior reasons (no false search_limit), stays incomplete', () => {
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const blue = scheduledTask('n8-zblue', 1, 'BLUE', '2026-08-03T12:00');
  const snapshot = policySnapshot([red, blue], { unknownSetupPolicy: 'excludeFromSearch', version: 2 });
  const bounds = dueDateBounds(UNCOVERED());
  const primary = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  assert.equal(primary.dispositions.find(d => d.id === 'n8-red').reason.code, 'setup_transition_unrecorded');
  // An unrepaired error finding (duplicate_patch) makes the candidate invalid: the walk is skipped, no time limit is hit.
  const invalid = { ...primary, patches: [...primary.patches, primary.patches[0]] };
  assert.ok(SetupScheduler.validateCandidate(snapshot, bounds, invalid).some(f => f.severity === 'error'));
  const filled = SetupScheduler.fillPlanningGaps(snapshot, bounds, invalid);
  const queued = filled.dispositions.find(d => d.id === 'n8-red');
  assert.equal(queued.status, 'needs_planning');
  assert.equal(queued.reason.code, 'setup_transition_unrecorded', 'the prior reason is kept, not relabelled search_limit');
  assert.equal(filled.patches.find(p => p.id === 'n8-red').changes.planning_reason.code, 'setup_transition_unrecorded');
  assert.equal(filled.gapFill.complete, false);
  assert.equal(filled.gapFill.placed, 0);
  assert.ok(filled.gapFill.unchecked >= 1, 'the unchecked count is still reported');
});

// ---------------------------------------------------------------------------
// Setup availability: the production prefix-max index (binary search over
// interval starts + running max of ends) must agree with a plain O(n^2)
// "scan every other order's intervals" reference, for every setup bar.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceAvailability(core, ctx, line, plant, successorId, end, orders) {
  const defaultHours = {};
  for (let d = 0; d < 7; d++) defaultHours[d] = core.WEEKEND_OFF && (d === 0 || d === 6) ? null : [...core.DEFAULT_SHIFT];
  const probe = new Date(end.getTime() - 1);
  const lineWin = core._dayWindow(ctx.calendars[line]?.workHours ?? defaultHours, probe);
  if (!lineWin) return 0;
  const plantWin = core._dayWindow(ctx.plants[plant]?.workHours ?? defaultHours, probe);
  if (!plantWin) return 0;
  const win = [Math.max(+lineWin[0], +plantWin[0]), Math.min(+lineWin[1], +plantWin[1])];
  if (win[0] >= win[1] || +end > win[1] || +end <= win[0]) return 0;
  let lower = win[0];
  // Touching windows merge across midnight (OQ47): continue back through every window ending where this one opens.
  for (let back = 1; back <= 14; back++) {
    const day = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() - back, 12);
    const l = core._dayWindow(ctx.calendars[line]?.workHours ?? defaultHours, day);
    const p = core._dayWindow(ctx.plants[plant]?.workHours ?? defaultHours, day);
    if (!l || !p) break;
    const earlier = [Math.max(+l[0], +p[0]), Math.min(+l[1], +p[1])];
    if (earlier[0] >= earlier[1] || earlier[1] !== lower) break;
    lower = earlier[0];
  }
  const blocked = (b) => {
    const s = core.parseDate(b.start), e = core.parseDate(b.end);
    if (!s || !e || +s >= +end || +e <= lower) return false;
    if (+e >= +end) return true;
    lower = Math.max(lower, +e);
    return false;
  };
  for (const b of ctx.blocks) {
    if (b.plant && b.plant !== plant) continue;
    if (b.line && b.line !== line) continue;
    if (blocked(b)) return 0;
  }
  for (const b of ctx.plantBlocks) {
    if (b.plant && b.plant !== plant) continue;
    if (blocked(b)) return 0;
  }
  for (const o of orders) {
    if (String(o.id) === successorId) continue;
    for (const iv of core.scheduleIntervals(o)) {
      if (+iv.start >= +end || +iv.end <= lower) continue;
      if (+iv.end >= +end) return 0;
      lower = Math.max(lower, +iv.end);
    }
  }
  return Math.max(0, (+end - lower) / 60000);
}

test('setup availability prefix-max index matches an O(n^2) reference on seeded random lines', () => {
  const core = globalThis.NimbusComputeCore;
  const MIN = 60000;
  const base = new Date(2026, 5, 10, 0, 0, 0).getTime();
  const colors = ['RED', 'BLUE', 'GREEN', 'BLACK'];
  const state = v => [{ fieldKey: 'colorWheel', value: v }];
  const plantRows = [];
  for (const a of colors) for (const b of colors) if (a !== b) plantRows.push({ machine: '', signature_version: 1, from_key: state(a), to_key: state(b), setup_min: 10 });
  const setup = {
    plant: 'P', definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_active: true, plant_rows: plantRows, machine_rows: [], machine_states: [], overrides: [],
  };
  const wh = open => Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, open]));
  let compared = 0, nonzero = 0, zero = 0;
  for (const seed of [1, 7, 12345, 99991]) {
    const R = mulberry32(seed);
    const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
    for (let c = 0; c < 300; c++) {
      const grid = R() < 0.4 ? 60 : (R() < 0.5 ? 1 : 15);
      const tasks = [];
      for (let i = 0; i < ri(2, 8); i++) {
        const st = base + ri(0, (24 * 60) / grid) * grid * MIN;
        const t = { id: 'T' + i, PLANT: 'P', MACHINE: 'L', COLOR: colors[ri(0, 3)], RUN_TIME: 1 };
        if (R() < 0.35) {
          const segs = ri(2, 3);
          let cur = st; t.scheduleSegments = [];
          for (let s = 0; s < segs; s++) {
            const len = ri(1, 300) * MIN;
            t.scheduleSegments.push({ sequence: s + 1, startDate: new Date(cur), endDate: new Date(cur + len) });
            cur += len + ri(-100, 300) * MIN;
          }
          if (R() < 0.3) t.scheduleSegments.reverse();
          t.start_date = new Date(st); t.end_date = new Date(cur);
        } else {
          t.start_date = new Date(st); t.end_date = new Date(st + ri(1, 600) * MIN);
        }
        tasks.push(t);
      }
      const blocks = [], plantBlocks = [];
      for (let i = 0; i < ri(0, 3); i++) {
        const s = base + ri(0, 1400) * MIN;
        const b = {
          start: new Date(s).toISOString(), end: new Date(s + ri(1, 300) * MIN + (R() < 0.3 ? 30000 : 0)).toISOString(),
          plant: R() < 0.7 ? 'P' : 'Q', line: R() < 0.5 ? 'L' : (R() < 0.5 ? 'M' : undefined),
        };
        (R() < 0.5 ? blocks : plantBlocks).push(b);
      }
      const ctx = {
        calendars: { L: { workHours: wh(R() < 0.8 ? [0, 24] : [ri(0, 8), ri(14, 24)]) } },
        plants: { P: { workHours: wh(R() < 0.8 ? [0, 24] : [ri(0, 8), ri(14, 24)]) } },
        lineSettings: {}, masterData: null, blocks, plantBlocks,
      };
      const obs = deriveSetupObservation(setup, tasks, new Set(['L']), ctx);
      for (const iv of obs.intervals) {
        const expected = referenceAvailability(core, ctx, 'L', 'P', iv.successorOrderId, iv.end, tasks);
        assert.equal(iv.availableMinutes, expected, `seed ${seed} case ${c} successor ${iv.successorOrderId}`);
        compared++; if (expected > 0) nonzero++; else zero++;
      }
    }
  }
  // Guard against a vacuous comparison: both covered and uncovered outcomes must be exercised.
  assert.ok(compared > 500, `compared ${compared}`);
  assert.ok(nonzero > 50 && zero > 50, `nonzero ${nonzero}, zero ${zero}`);
});

test('setup availability without a calendar context falls back to the gap since the predecessor ended', () => {
  const state = v => [{ fieldKey: 'colorWheel', value: v }];
  const setup = {
    plant: 'P', definition: { plant: 'P', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_active: true, plant_rows: [{ machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 10 }],
    machine_rows: [], machine_states: [], overrides: [],
  };
  const t = (id, color, s, e) => ({ id, PLANT: 'P', MACHINE: 'L', COLOR: color, RUN_TIME: 1, start_date: new Date(s), end_date: new Date(e) });
  const obs = deriveSetupObservation(setup, [t('a', 'RED', '2026-08-03T08:00:00', '2026-08-03T09:00:00'), t('b', 'BLUE', '2026-08-03T09:45:00', '2026-08-03T10:45:00')], new Set(['L']));
  assert.equal(obs.intervals.length, 1);
  assert.equal(obs.intervals[0].availableMinutes, 45);
});

test('F1: exact search is gated on distinct-ordering count, not just state count', () => {
  const build = (counts) => {
    const colors = ['RED', 'BLUE', 'YELLOW', 'BLACK'];
    const tasks = [];
    counts.forEach((n, ci) => {
      for (let i = 0; i < n; i++) {
        tasks.push(scheduledTask(`f1-${colors[ci]}-${i}`, 1, colors[ci], `2026-08-03T${17 - tasks.length % 8}:00`));
      }
    });
    return setupSnapshot(tasks);
  };
  const run = (counts, overrides = {}) => SetupScheduler.evaluateDueDateFirst(
    build(counts),
    dueDateBounds(setupTruth(), { exactSearchThreshold: 8, iterationCap: 100000, convergenceWindow: 1000, ...overrides }),
    'due-date',
  );

  // 12 orders in 4 states = 369,600 orderings: over the leaf cap, so the
  // bounded heuristic runs even though 4 states is under the threshold of 8.
  const many = run([3, 3, 3, 3]);
  assert.equal(many.diagnostics.quality, 'heuristic', '12 orders in 4 states take the heuristic path');
  assert.ok((many.diagnostics.seedCount ?? 0) > 0, 'the heuristic path reports its seed set');

  // 5 orders in 3 states = 30 orderings: exact.
  const few = run([2, 2, 1]);
  assert.equal(few.diagnostics.quality, 'exact', '5 orders in 3 states take the exact path');
  assert.equal(few.diagnostics.termination, 'completed');

  // multisetLeafCount boundary: 4 singleton states = 4! = 24 orderings.
  assert.equal(run([1, 1, 1, 1], { exactSearchLeafCap: 24 }).diagnostics.quality, 'exact', 'cap equal to the leaf count stays exact');
  assert.equal(run([1, 1, 1, 1], { exactSearchLeafCap: 23 }).diagnostics.quality, 'heuristic', 'cap below the leaf count goes heuristic');
  assert.equal(run([2, 2, 1], { exactSearchLeafCap: 1 }).diagnostics.quality, 'heuristic', 'a tiny cap forces heuristic');
  assert.throws(() => run([1, 1], { exactSearchLeafCap: 0 }), TypeError, 'a non-positive leaf cap is rejected');
});

function freeIndexFixture(R, spanStart, spanEnd) {
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const hoursFor = () => Object.fromEntries(Array.from({ length: 7 }, (_, day) => {
    if (R() < 0.2) return [day, null];
    const open = ri(0, 12) + (R() < 0.3 ? ri(0, 3) * 0.25 : 0);
    // Some windows run to 24:00 so adjacent days touch at midnight.
    return [day, [open, R() < 0.3 ? 24 : Math.min(24, open + ri(2, 14))]];
  }));
  const MIN = 60000;
  const blocks = [];
  const plantBlocks = [];
  for (let i = 0; i < ri(0, 8); i++) {
    // Deliberately not minute-aligned: seconds exercise the ceil/floor path.
    const start = spanStart + ri(0, Math.floor((spanEnd - spanStart) / MIN)) * MIN + ri(0, 59) * 1000;
    const block = { plant: 'P1', start: new Date(start), end: new Date(start + ri(1, 3000) * MIN + ri(0, 59) * 1000) };
    if (R() < 0.4) plantBlocks.push(block); else blocks.push({ ...block, line: 'L1' });
  }
  return {
    ...setupSnapshot([]), blocks, plantBlocks,
    calendars: { L1: { workHours: hoursFor() } }, plants: { P1: { workHours: hoursFor() } },
  };
}

function freeIndexEquivalence(tz, spanStartText, spanEndText, seeds) {
  const previous = process.env.TZ;
  try {
    process.env.TZ = tz;
    const MIN = 60000;
    const spanStart = new Date(spanStartText).getTime();
    const spanEnd = new Date(spanEndText).getTime();
    let compared = 0, outside = 0, multi = 0;
    for (const seed of seeds) {
      const R = mulberry32(seed);
      const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
      for (let c = 0; c < 25; c++) {
        const snapshot = freeIndexFixture(R, spanStart, spanEnd);
        const bounds = dueDateBounds(setupTruth(), {
          now: new Date(spanStart + ri(0, 600) * MIN), planningStart: new Date(spanStart + ri(0, 600) * MIN),
          horizonEnd: new Date(spanEnd), respectCalendar: true,
        });
        const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
        const spanFrom = ctx.freeIndexSpan.from;
        for (let q = 0; q < 40; q++) {
          const inside = R() < 0.75;
          const lo = inside ? spanFrom : spanFrom - 5 * 86400000;
          const hi = inside ? spanEnd : spanEnd + 5 * 86400000;
          const from = new Date(lo + Math.floor(R() * (hi - lo - MIN)) + (R() < 0.5 ? 0 : ri(0, 59999)));
          const through = new Date(+from + ri(1, 10 * 24 * 60) * MIN + (R() < 0.5 ? 0 : ri(0, 59999)));
          if (+from < spanFrom || +through > spanEnd) outside += 1;
          // Raw equivalence: indexed output is exactly the day-walk output.
          const walked = SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through);
          const indexed = SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through, ctx);
          assert.deepEqual(indexed, walked, `raw intervals differ (seed ${seed}, case ${c}, query ${q})`);
          // Placement equivalence: marked, pre-normalized intervals place identically.
          const marked = SetupScheduler.freeIntervalsForPlacementTest(snapshot, 'L1', 'P1', from, through, ctx);
          const earliest = new Date(+from + ri(0, 3 * 24 * 60) * MIN + (R() < 0.5 ? 0 : ri(0, 59999)));
          for (const runtimeMinutes of [ri(1, 90), ri(30, 600), ri(600, 3000)]) {
            for (const policy of ['never', 'overlong_only', 'partial_allowed']) {
              const request = {
                earliestStart: earliest, runtimeMinutes, setup: { kind: 'resolved', minutes: ri(0, 90) },
                policy, isInherentlyOverlong: R() < 0.5, minProductiveSegmentMinutes: [undefined, 30, 45][ri(0, 2)],
              };
              const expected = SetupScheduler.placeWithSetup({ ...request, freeIntervals: walked });
              const actual = SetupScheduler.placeWithSetup({ ...request, freeIntervals: marked });
              assert.deepEqual(actual, expected, `placement differs (seed ${seed}, case ${c}, query ${q}, ${policy})`);
              compared += 1;
              if (expected.productiveSegments.length > 1) multi += 1;
            }
          }
        }
      }
    }
    assert.ok(compared > 1000 && outside > 50 && multi > 20, `weak coverage: ${compared}/${outside}/${multi}`);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test('F2 free-interval index equals the day-walk on seeded random calendars, blackouts and windows (incl. outside the span)', () => {
  freeIndexEquivalence('America/New_York', '2026-08-01T00:00:00', '2026-08-31T00:00:00', [3, 17, 2026]);
});

test('F2 free-interval index equals the day-walk across the DST end and start transitions', () => {
  freeIndexEquivalence('America/New_York', '2026-10-25T00:00:00', '2026-11-12T00:00:00', [5, 31]);
  freeIndexEquivalence('America/New_York', '2026-03-01T00:00:00', '2026-03-20T00:00:00', [8, 44]);
});

test('F2 index is skipped for work hours that overflow the day (walk and index would disagree)', () => {
  const snapshot = setupSnapshot([]);
  const overflow = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [20, 30]]));
  snapshot.calendars.L1.workHours = overflow; snapshot.plants.P1.workHours = overflow;
  const bounds = dueDateBounds(setupTruth(), { planningStart: at('2026-08-03T00:00:00'), horizonEnd: at('2026-08-10T00:00:00') });
  const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
  const from = at('2026-08-04T00:00:00'); const through = at('2026-08-07T12:00:00');
  assert.deepEqual(
    SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through, ctx),
    SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through),
  );
});

test('F2 run-level: candidate count, patches and objective are identical with the free index on and off', () => {
  const colors = ['RED', 'BLUE', 'GREEN', 'BLACK'];
  const rows = [];
  for (const a of colors) for (const b of colors) if (a !== b) rows.push(setupRow(a, b, 20 + 7 * ((a.length + b.length) % 5)));
  const R = mulberry32(4242);
  const tasks = [];
  for (const line of ['L1', 'L2', 'L3']) {
    for (let i = 0; i < 9; i++) {
      tasks.push({
        ...scheduledTask(`f2-${line}-${i}`, 0.5 + Math.floor(R() * 14) / 2, colors[Math.floor(R() * 4)], `2026-08-${String(5 + Math.floor(R() * 12)).padStart(2, '0')}T12:00:00`),
        MACHINE: line,
      });
    }
  }
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, day === 0 ? null : [6, 22]]));
  const build = () => ({
    ...setupSnapshot(tasks.map(t => ({ ...t }))),
    masterData: { plants: [{ plant: 'P1' }], lines: ['L1', 'L2', 'L3'].map(machine => ({ plant: 'P1', machine })) },
    calendars: Object.fromEntries(['L1', 'L2', 'L3'].map(l => [l, { workHours: hours }])),
    plants: { P1: { workHours: hours } },
    blocks: [{ plant: 'P1', line: 'L2', start: at('2026-08-05T10:00:30'), end: at('2026-08-05T15:00:00') },
      { plant: 'P1', line: 'L3', start: at('2026-08-06T00:00:00'), end: at('2026-08-07T00:00:00') }],
  });
  const bounds = extra => dueDateBounds(setupTruth({ rows }), {
    exactSearchThreshold: 8, iterationCap: 100000, convergenceWindow: 1000,
    now: at('2026-08-03T08:00:00'), planningStart: at('2026-08-03T08:00:00'), runNow: at('2026-08-03T08:00:00'),
    placementStart: at('2026-08-03T08:00:00'), horizonEnd: at('2026-08-24T00:00:00'), ...extra,
  });
  const runs = [
    ['due-date', b => SetupScheduler.evaluateDueDateFirst(build(), b, 'due-date')],
    ['spt', b => SetupScheduler.evaluateSptWithSetup(build(), b)],
    ['min-changeover', b => SetupScheduler.evaluateMinChangeover(build(), b)],
  ];
  for (const [mode, run] of runs) {
    const on = run(bounds({}));
    const off = run(bounds({ disableFreeIndex: true }));
    assert.ok(on.diagnostics.candidateCount > 0, `${mode} evaluated candidates`);
    assert.equal(on.diagnostics.candidateCount, off.diagnostics.candidateCount, `${mode} candidate count`);
    assert.equal(on.diagnostics.termination, off.diagnostics.termination, `${mode} termination`);
    assert.deepEqual(on.objective, off.objective, `${mode} objective totals`);
    assert.deepEqual(on.patches, off.patches, `${mode} winners/patches`);
    assert.deepEqual(on.score, off.score, `${mode} score`);
  }
});

test('fillPlanningGaps default budget comes from bounds.gapFillBudgetMs and the message points at Run in background', () => {
  const { snapshot, bounds, candidate } = gapFillFixture([scheduledTask('waiting', 1, 'GREEN', '2026-08-03T18:00')]);
  const starved = SetupScheduler.fillPlanningGaps(snapshot, { ...bounds, gapFillBudgetMs: 0 }, candidate);
  assert.equal(starved.gapFill.complete, false);
  assert.match(starved.dispositions[0].reason.message, /Run in background/);
  const generous = SetupScheduler.fillPlanningGaps(snapshot, { ...bounds, gapFillBudgetMs: 60000 }, candidate);
  assert.equal(generous.gapFill.complete, true);
});

// ---------------------------------------------------------------------------
// Dated plant calendar periods (W3): the detached scheduler resolves the plant pattern per date.
// ---------------------------------------------------------------------------
const periodRow = (id, validFrom, validTo, workHours) => ({ id, name: id, validFrom, validTo, workHours });
const everyDayHours = hours => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, hours]));

function periodSnapshot(defaultHours, periods) {
  const snapshot = setupSnapshot([]);
  snapshot.calendars.L1.workHours = everyDayHours([8, 18]);
  snapshot.plants.P1 = { workHours: defaultHours, ...(periods ? { periods } : {}) };
  return snapshot;
}

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const spans = intervals => intervals.map(i => `${i.start.getDate()} ${hhmm(i.start)}-${hhmm(i.end)}`);

test('periods: freeIntervalsFor resolves the plant pattern per day, on the plain walk and through the F2 index', () => {
  const snapshot = periodSnapshot(everyDayHours([8, 18]), [periodRow('p1', '2026-08-05', null, everyDayHours([10, 14]))]);
  const bounds = dueDateBounds(setupTruth(), { planningStart: at('2026-08-03T00:00:00'), horizonEnd: at('2026-08-10T00:00:00') });
  const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
  const from = at('2026-08-04T00:00:00'); const through = at('2026-08-06T23:00:00');
  const expected = ['4 08:00-18:00', '5 10:00-14:00', '6 10:00-14:00'];
  assert.deepEqual(spans(SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through)), expected, 'plain walk');
  assert.deepEqual(spans(SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through, ctx)), expected, 'ctx (indexed) path');
  assert.ok([...ctx._freeIndex.values()].some(entry => entry !== null), 'the periods fixture is served from the index');
});

test('periods: the F2 index is skipped (plain walk used) when a period pattern overflows the day', () => {
  const overflow = everyDayHours([20, 30]);
  const snapshot = periodSnapshot(everyDayHours([8, 18]), [periodRow('over', '2026-08-05', null, overflow)]);
  const bounds = dueDateBounds(setupTruth(), { planningStart: at('2026-08-03T00:00:00'), horizonEnd: at('2026-08-10T00:00:00') });
  const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
  const from = at('2026-08-04T00:00:00'); const through = at('2026-08-07T12:00:00');
  assert.deepEqual(
    SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through, ctx),
    SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through),
  );
  assert.deepEqual([...ctx._freeIndex.values()], [null], 'the index entry is cached as unusable, so the walk serves it');
});

test('periods: the indexed path equals the plain walk across a boundary with a blackout and a closed period', () => {
  const snapshot = periodSnapshot(everyDayHours([8, 18]), [
    periodRow('short', '2026-08-05', '2026-08-06', everyDayHours([10, 14])),
    periodRow('closed', '2026-08-08', '2026-08-08', everyDayHours(null)),
  ]);
  snapshot.blocks = [{ line: 'L1', plant: 'P1', start: at('2026-08-05T11:00:00'), end: at('2026-08-05T12:30:00') }];
  const bounds = dueDateBounds(setupTruth(), { planningStart: at('2026-08-03T00:00:00'), horizonEnd: at('2026-08-12T00:00:00') });
  const ctx = SetupScheduler.buildRunContext(snapshot, bounds);
  const from = at('2026-08-04T00:00:00'); const through = at('2026-08-10T12:00:00');
  const walked = SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through);
  assert.deepEqual(SetupScheduler.freeIntervalsForTest(snapshot, 'L1', 'P1', from, through, ctx), walked);
  assert.deepEqual(spans(walked), ['4 08:00-18:00', '5 10:00-11:00', '5 12:30-14:00', '6 10:00-14:00', '7 08:00-18:00', '9 08:00-18:00', '10 08:00-12:00']);
});

test('periods: hasNominalWindow sees a longer window in a later epoch (ctx and non-ctx)', () => {
  const hours = hoursText => everyDayHours(hoursText);
  const periods = [periodRow('long', '2026-08-17', null, hours([8, 18]))];
  const bounds = dueDateBounds(setupTruth(), { planningStart: at('2026-08-03T00:00:00'), horizonEnd: at('2026-08-31T00:00:00') });
  const withPeriods = periodSnapshot(hours([8, 12]), periods);
  const without = periodSnapshot(hours([8, 12]));
  const from = at('2026-08-03T00:00:00');
  for (const useCtx of [false, true]) {
    const ctxFor = snapshot => (useCtx ? SetupScheduler.buildRunContext(snapshot, bounds) : undefined);
    assert.equal(SetupScheduler.hasNominalWindowForTest(withPeriods, 'L1', 'P1', from, 8 * 60, ctxFor(withPeriods)), true, `later 10 h epoch (ctx=${useCtx})`);
    assert.equal(SetupScheduler.hasNominalWindowForTest(without, 'L1', 'P1', from, 8 * 60, ctxFor(without)), false, `no periods: 4 h only (ctx=${useCtx})`);
    assert.equal(SetupScheduler.hasNominalWindowForTest(withPeriods, 'L1', 'P1', from, 11 * 60, ctxFor(withPeriods)), false, `longer than every window (ctx=${useCtx})`);
  }
  // O3: a missing plant entry or a missing line calendar row falls back to the same defaults the walk uses
  // (default plant hours / all-day line), instead of reading as "no nominal window".
  assert.equal(SetupScheduler.hasNominalWindowForTest({ ...withPeriods, plants: {} }, 'L1', 'P1', from, 60), true,
    'a plant with no entry at all falls back to the default plant hours');
  assert.equal(SetupScheduler.hasNominalWindowForTest({ ...withPeriods, calendars: {} }, 'L1', 'P1', from, 8 * 60), true,
    'a line with no calendar row follows its plant (all-day line)');
  assert.equal(SetupScheduler.hasNominalWindowForTest({ ...withPeriods, calendars: {} }, 'L1', 'P1', from, 11 * 60), false,
    'a line with no calendar row is still bounded by the plant windows');
});

test('periods: the due instant of a date-only due reads the period close on its date', () => {
  const dueTask = () => ({ ...scheduledTask('d', 1, 'GREEN', '2026-08-06T00:00:00') });
  const plain = periodSnapshot(everyDayHours([8, 18]));
  const dated = periodSnapshot(everyDayHours([8, 18]), [periodRow('early', '2026-08-05', null, everyDayHours([10, 14]))]);
  assert.equal(SetupScheduler.dueInstant(dueTask(), { snapshot: plain, plant: 'P1' }).getTime(), at('2026-08-06T18:00:00').getTime());
  assert.equal(SetupScheduler.dueInstant(dueTask(), { snapshot: dated, plant: 'P1' }).getTime(), at('2026-08-06T14:00:00').getTime(),
    'the period that covers Thursday closes at 14:00');
  assert.equal(SetupScheduler.dueInstant({ ...dueTask(), original_end_date: at('2026-08-04T00:00:00') }, { snapshot: dated, plant: 'P1' }).getTime(),
    at('2026-08-04T18:00:00').getTime(), 'a date before the period still uses the default close');
});

test('periods: plantHoursOn throws compute-core-stale when periods exist and the core is missing, never falling back to the default', () => {
  const entry = { workHours: everyDayHours([8, 18]), periods: [periodRow('p', '2026-08-05', null, everyDayHours([10, 14]))] };
  const day = at('2026-08-06T00:00:00');
  assert.deepEqual(SetupScheduler.plantHoursOnForTest(entry, day)[4], [10, 14], 'with the core: the period pattern');
  const core = globalThis.NimbusComputeCore;
  try {
    globalThis.NimbusComputeCore = undefined;
    assert.throws(() => SetupScheduler.plantHoursOnForTest(entry, day), /compute-core-stale/);
    globalThis.NimbusComputeCore = {};
    assert.throws(() => SetupScheduler.plantHoursOnForTest(entry, day), /compute-core-stale/, 'a core without plantWorkHoursOn is stale too');
    assert.equal(SetupScheduler.plantHoursOnForTest({ workHours: entry.workHours }, day), entry.workHours, 'no periods: the default by reference, core-less');
    assert.equal(SetupScheduler.plantHoursOnForTest({ workHours: entry.workHours, periods: [] }, day), entry.workHours);
    assert.equal(SetupScheduler.plantHoursOnForTest(undefined, day), undefined);
  } finally {
    globalThis.NimbusComputeCore = core;
  }
});

test('detached free intervals: a line missing from the snapshot follows its plant (all-day) when the plant resolves', () => {
  const week = range => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [...range]]));
  const from = new Date(2031, 2, 3, 0, 0, 0);       // a Monday
  const through = new Date(2031, 2, 3, 23, 59, 0);
  const hoursOf = intervals => intervals.map(i => [(i.start - from) / 3.6e6, (i.end - from) / 3.6e6]);
  const withPlant = { ...setupSnapshot([]), calendars: {}, plants: { P1: { workHours: week([6, 18]) } } };
  assert.deepEqual(hoursOf(SetupScheduler.freeIntervalsForTest(withPlant, 'LX', 'P1', from, through)), [[6, 18]],
    'all-day line fallback: exactly the plant hours, matching compute-core ensureCalendar allDay');
  const noPlant = { ...setupSnapshot([]), calendars: {}, plants: {} };
  assert.deepEqual(hoursOf(SetupScheduler.freeIntervalsForTest(noPlant, 'LX', 'P1', from, through)), [[7, 19]],
    'plant unresolved: the default shift week, as before');
});

// ---- Window-end boundary: a placed, user-scheduled order crossing horizonEnd is held ----
function straddler(id = 'straddle', overrides = {}) {
  return {
    ...scheduledTask(id, 5, 'GREEN', '2026-08-04T18:00:00', '2026-08-03T15:00:00', '2026-08-03T20:00:00'),
    user_scheduled: true, planning_status: 'scheduled', ...overrides,
  };
}

test('window-end boundary: a placed straddler is held in all three modes and the early capacity is reserved around it', () => {
  for (const mode of ['due-date', 'spt', 'min-changeover']) {
    const early = scheduledTask('early', 2, 'GREEN', '2026-08-03T18:00:00');
    const snapshot = setupSnapshot([straddler(), early]);
    const bounds = dueDateBounds({ ...setupTruth(), plant_active: true });
    const result = Engine.evaluateSetupAware(mode, bounds, snapshot);
    assert.equal(result.patches.some(p => p.id === 'straddle'), false, `${mode}: no patch for the held order`);
    assert.equal(result.dispositions.some(d => d.id === 'straddle'), false, `${mode}: not mutable demand`);
    assert.deepEqual([...result.windowEndHeldIds], ['straddle'], mode);
    const placed = patchFor(result, 'early');
    assert.ok(placed, `${mode}: early order placed`);
    assert.ok(placed.changes.end_date.getTime() <= at('2026-08-03T15:00:00').getTime(), `${mode}: before the held order`);
    assert.equal(result.validationFindings.some(f => f.code === 'scope'), false, `${mode}: no scope finding`);
    assert.deepEqual(SetupScheduler.validateCandidateForApply(result, snapshot).filter(f => f.severity === 'error'), [], mode);
  }
});

test('window-end boundary: the no-setup-definition whole-line path also leaves the straddler alone', () => {
  const snapshot = setupSnapshot([straddler(), scheduledTask('early', 2, 'GREEN', '2026-08-03T18:00:00')]);
  const bounds = dueDateBounds(setupTruth({ current: null, definition: null }));
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, bounds);
  assert.equal(result.patches.some(p => p.id === 'straddle'), false);
  assert.equal(result.validationFindings.some(f => f.code === 'scope'), false);
});

test('window-end boundary: a setup conflict is blamed on the mutable predecessor, not the held order', () => {
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 600), setupRow('RED', 'GREEN', 0)] });
  const held = straddler('straddle', { COLOR: 'GREEN' });
  const early = scheduledTask('early-red', 2, 'RED', '2026-08-03T18:00:00');
  const snapshot = setupSnapshot([held, early]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));
  assert.equal(result.validationFindings.some(f => f.taskId === 'straddle' && f.severity === 'error'), false,
    'no error is attributed to the held boundary');
  assert.equal(result.patches.some(p => p.id === 'straddle'), false);
});

test('window-end boundary: user_scheduled false straddler is still re-placed', () => {
  const snapshot = setupSnapshot([straddler('free', { user_scheduled: false })]);
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth()));
  assert.ok(result.dispositions.some(d => d.id === 'free'), 'mutable');
  assert.equal(result.windowEndHeldIds.length, 0);
});

test('window-end boundary: fully-inside and start-edge orders are unchanged', () => {
  const inside = { ...scheduledTask('inside', 2, 'GREEN', '2026-08-03T18:00:00', '2026-08-03T10:00:00', '2026-08-03T12:00:00'), user_scheduled: true };
  const atEdge = { ...scheduledTask('edge', 2, 'GREEN', '2026-08-04T18:00:00', '2026-08-03T18:00:00', '2026-08-03T20:00:00'), user_scheduled: true };
  const endsAtEdge = { ...scheduledTask('ends-edge', 1, 'GREEN', '2026-08-03T18:00:00', '2026-08-03T17:00:00', '2026-08-03T18:00:00'), user_scheduled: true };
  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([inside, atEdge, endsAtEdge]), dueDateBounds(setupTruth()));
  assert.equal(result.windowEndHeldIds.length, 0);
  assert.ok(result.dispositions.some(d => d.id === 'inside'));
});

test('window-end boundary: running/frozen/firmed crossing orders keep the protected disposition', () => {
  const snapshot = setupSnapshot([straddler('fixed-cross')], { firmedIds: ['fixed-cross'] });
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth()));
  assert.equal(result.dispositions.find(d => d.id === 'fixed-cross')?.status, 'protected');
  assert.equal(result.windowEndHeldIds.length, 0);
});

test('window-end boundary: explicit scope (Remove Backlog) exempts the order and respectFirmed:false still holds it', () => {
  const snapshot = setupSnapshot([straddler()]);
  const scoped = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setupTruth(), { scopeTaskIds: ['straddle'] }));
  assert.ok(scoped.dispositions.some(d => d.id === 'straddle'), 'selected order stays in scope');
  assert.equal(scoped.windowEndHeldIds.length, 0);
  const noFirm = Engine.evaluateSetupAware('due-date', dueDateBounds({ ...setupTruth(), plant_active: true }), { ...snapshot, firmedIds: [] });
  assert.deepEqual([...noFirm.windowEndHeldIds], ['straddle']);
});

// ---- setup value defaults (2026-10-27, Wave B) ----
const withValueDefaults = (truth, defaults) => ({ ...truth, value_defaults: defaults });
const REDVD = [{ field_key: 'colorWheel', value: 'RED', setup_min: 20, signature_version: 1 }];

test('value default: a pair with no row is covered and charged the default, not the plant default', () => {
  const red = scheduledTask('vd-red', 1, 'RED', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red], { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 45, version: 2 }),
    dueDateBounds(withValueDefaults(UNCOVERED(), REDVD)),
  );
  assert.equal(patchFor(result, 'vd-red').changes.start_date.getTime(), at('2026-08-03T08:20').getTime(),
    '20 default minutes (not the 45 plant default) precede the first productive minute');
  assert.equal(result.objective?.setupMinutes, 20);
  assert.equal(result.explanation.some(r => r.code === 'admitted-without-setup' && r.taskId === 'vd-red'), false);
  assert.equal(result.missingEdges.some(e => e.successorOrderId === 'vd-red'), false, 'a default-covered edge is not a missing edge');
});

test('value default: excludeFromSearch admits a default-covered pair instead of queueing it', () => {
  const red = scheduledTask('vd-ered', 1, 'RED', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red], { unknownSetupPolicy: 'excludeFromSearch', version: 2 }),
    dueDateBounds(withValueDefaults(UNCOVERED(), REDVD)),
  );
  assert.ok(patchFor(result, 'vd-ered'), 'the order is placed');
  assert.equal(result.dispositions.some(d => d.id === 'vd-ered' && d.status === 'needs_planning'), false);
  // Control: without the default the same order is queued.
  const control = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([scheduledTask('vd-ered', 1, 'RED', '2026-08-03T12:00')], { unknownSetupPolicy: 'excludeFromSearch', version: 2 }),
    dueDateBounds(UNCOVERED()),
  );
  assert.equal(control.dispositions.find(d => d.id === 'vd-ered')?.status, 'needs_planning');
});

test('value default: the Gantt observation agrees with the optimizer (same minutes, no uncovered diagnostic), also on a setup-off plant', () => {
  const t = (id, color, s, e) => ({ id, PLANT: 'P1', MACHINE: 'L1', COLOR: color, RUN_TIME: 1, start_date: at(s), end_date: at(e) });
  const tasks = [t('vd-a', 'GREEN', '2026-08-03T08:00:00', '2026-08-03T09:00:00'), t('vd-b', 'RED', '2026-08-03T09:30:00', '2026-08-03T10:30:00')];
  for (const plant_active of [true, false]) {
    const setup = { ...withValueDefaults(setupTruth({ current: null }), REDVD), plant_active };
    const obs = deriveSetupObservation(setup, tasks, new Set(['L1']));
    assert.equal(obs.diagnostics.some(d => d.type === 'setup-uncovered'), false);
    assert.equal(obs.intervals.length, 1);
    assert.equal(obs.intervals[0].requiredMinutes, 20);
  }
  const noDefaults = deriveSetupObservation(setupTruth({ current: null }), tasks, new Set(['L1']));
  assert.equal(noDefaults.diagnostics.some(d => d.type === 'setup-uncovered'), true, 'control: uncovered without the default');
});

// ── Tool Inventory Wave 6: the tool overflow pass ("tool overflow") ────────────────────────────────────────────────
// Fixture: tests/modules/helpers/tool-overflow-fixture.mjs (24 h calendars, plant 'P1', 2035 dates, local time).
const TF = ToolFx;
const tms = text => +new Date(text);
function toolCandidate(patches, dispositions) {
  return { patches, dispositions, score: [0, 0, 0, 0, 0, 0, 0, 0], explanation: [], diagnostics: { candidateCount: 1, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 0, limitReached: false, events: [] }, unchangedLines: [], missingEdges: [] };
}
const sched = (id, start, end) => ({ id, changes: { start_date: new Date(start), end_date: new Date(end), scheduleSegments: [], planning_status: 'scheduled', planning_reason: null } });
const dispOf = (id, line, status = 'scheduled') => ({ id, line, status });
const noOverflow = (rows, avail) => assert.deepEqual(TF.overflowOracle(rows, avail), [], 'no tool overflow');
const one = t => () => t;
const errorsOf = result => (result.validationFindings ?? []).filter(f => f.severity === 'error');

test('tool overflow: the least urgent order slides later on its OWN line instead of being queued', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = Object.fromEntries(TF.finalRows(snap, r).map(x => [x.id, x]));
  assert.equal(rows.A.status, 'placed'); assert.equal(rows.B.status, 'placed', 'moved, not queued');
  assert.equal(rows.B.line, 'L2', 'never changes machine');
  assert.ok(rows.B.start >= rows.A.end, 'B waits for A to release the only copy');
  noOverflow(Object.values(rows), one(1));
  assert.equal(r.toolMoved.length, 1); assert.equal(r.toolMoved[0].orderId, 'B');
  assert.equal(r.toolBlocked, undefined, 'nothing queued');
  assert.equal(r.toolPass.complete, true);
  assert.deepEqual(errorsOf(r), []);
});

test('tool overflow: an offender may move EARLIER than its current slot (earliest tool-free gap)', () => {
  // Protected P on L1 uses T1 on Aug 7; B (L2) is currently placed on top of it; the earliest free gap is BEFORE it.
  const snap = TF.toolSnapshot([
    { id: 'P', line: 'L1', run: 8, tools: ['T1'], start: '2035-08-07T08:00:00', end: '2035-08-07T16:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-07T10:00:00', end: '2035-08-07T14:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], firmedIds: ['P'] });
  const bounds = TF.toolBounds(snap);
  const cand = toolCandidate([sched('B', '2035-08-07T10:00:00', '2035-08-07T14:00:00')], [dispOf('P', 'L1', 'protected'), dispOf('B', 'L2')]);
  const out = SetupScheduler.resolveToolOverflow(snap, bounds, cand);
  const b = out.patches.find(p => p.id === 'B');
  assert.ok(b.changes.end_date.getTime() <= tms('2035-08-07T08:00:00'), 'B moved to the earlier free gap');
  assert.equal(out.patches.some(p => p.id === 'P'), false, 'the protected holder is never patched');
  assert.equal(out.toolMoved[0].orderId, 'B');
  assert.equal(out.toolMoved[0].fromStart, new Date('2035-08-07T10:00:00').toISOString());
});

test('tool overflow: no gap inside the push cap -> queued with tool_contention and a structured reason', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
    { id: 'B', line: 'L2', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], plantExtra: { max_push_forward_days: 0 } });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = Object.fromEntries(TF.finalRows(snap, r).map(x => [x.id, x]));
  const queued = Object.values(rows).filter(x => x.status === 'queued');
  assert.equal(queued.length, 1);
  const q = queued[0];
  assert.equal(q.reason.code, 'tool_contention');
  assert.equal(q.reason.tool_id, 'T1'); assert.equal(q.reason.available, 1);
  assert.deepEqual(q.reason.holders, [q.id === 'A' ? 'B' : 'A']);
  assert.equal(typeof q.reason.message, 'string');
  assert.equal(r.toolBlocked.length, 1); assert.equal(r.toolBlocked[0].orderId, q.id);
  assert.deepEqual(r.toolBlocked[0].holderIds, q.reason.holders);
  assert.equal(r.dispositions.find(d => d.id === q.id).status, 'needs_planning');
  assert.deepEqual(errorsOf(r), []);
  // The reason text is FIXED (no holder ids or numbers): identical for a different id set.
  const snap2 = TF.toolSnapshot([
    { id: 'X', line: 'L1', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
    { id: 'Y', line: 'L2', run: 10, tools: ['T1'], due: '2035-08-06T18:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], plantExtra: { max_push_forward_days: 0 } });
  const r2 = evaluateSchedule(snap2, TF.toolRequest());
  const q2 = TF.finalRows(snap2, r2).find(x => x.status === 'queued');
  assert.equal(q2.reason.message, q.reason.message);
});

test('tool overflow: a protected (firmed) holder never moves; a protected-vs-protected overlap is a WARNING that still reserves copies', () => {
  const snap = TF.toolSnapshot([
    { id: 'P1', line: 'L1', run: 4, tools: ['T1'], start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'P2', line: 'L2', run: 4, tools: ['T1'], start: '2035-08-06T09:00:00', end: '2035-08-06T13:00:00' },
    { id: 'C', line: 'L3', run: 2, tools: ['T1'], due: '2035-08-08T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], firmedIds: ['P1', 'P2'] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = Object.fromEntries(TF.finalRows(snap, r).map(x => [x.id, x]));
  assert.equal(r.patches.some(p => p.id === 'P1' || p.id === 'P2'), false, 'protected rows are never patched');
  assert.deepEqual(errorsOf(r), [], 'the pre-existing protected overlap is not an error');
  const warn = r.validationFindings.find(f => f.code === 'tool_overflow');
  assert.equal(warn.severity, 'warning');
  assert.equal(rows.C.status, 'placed');
  assert.ok(rows.C.start >= tms('2035-08-06T13:00:00'), 'C waits until BOTH protected holders are done');
});

test('tool overflow: a manual firm moves only when Respect firmed is off', () => {
  const mk = () => TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], firmedIds: ['B'] });
  const kept = mk();
  const r1 = evaluateSchedule(kept, TF.toolRequest({ respectFirmed: true }));
  assert.equal(r1.patches.some(p => p.id === 'B'), false, 'a respected firm is never patched');
  const a1 = TF.finalRows(kept, r1).find(x => x.id === 'A');
  assert.ok(a1.start >= tms('2035-08-06T14:00:00'), 'the mutable order A gives way');
  const freed = mk();
  const r2 = evaluateSchedule(freed, TF.toolRequest({ respectFirmed: false }));
  const rows2 = TF.finalRows(freed, r2);
  noOverflow(rows2, one(1));
  assert.ok(rows2.every(x => x.status === 'placed'));
  assert.ok(r2.toolMoved?.some(m => m.orderId === 'B') || r2.patches.some(p => p.id === 'B'), 'the least urgent order (B) may now move');
});

test('tool overflow: a holder on an UNSELECTED line and on an excludeFromOpt line still blocks, and is never patched', () => {
  const tasks = [
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
  ];
  const unselected = TF.toolSnapshot(tasks, { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const r1 = evaluateSchedule(unselected, TF.toolRequest({ lines: ['L1'] }));
  const a1 = TF.finalRows(unselected, r1).find(x => x.id === 'A');
  assert.ok(a1.status === 'placed' && a1.start >= tms('2035-08-06T12:00:00'), 'A waits for B on the unselected line');
  assert.equal(r1.patches.some(p => p.id === 'B'), false);
  const optOut = TF.toolSnapshot(tasks, { inventory: [{ tool_id: 'T1', total_qty: 1 }], lineSettings: { L2: { excludeFromOpt: true } } });
  const r2 = evaluateSchedule(optOut, TF.toolRequest());
  const a2 = TF.finalRows(optOut, r2).find(x => x.id === 'A');
  assert.ok(a2.status === 'placed' && a2.start >= tms('2035-08-06T12:00:00'), 'A waits for B on the excludeFromOpt line');
  assert.equal(r2.patches.some(p => p.id === 'B'), false);
});

test('tool overflow: a window-end HELD holder blocks (and is never patched)', () => {
  const snap = TF.toolSnapshot([
    { id: 'B', line: 'L2', run: 8, tools: ['T1'], start: '2035-08-07T04:00:00', end: '2035-08-07T12:00:00' },
    { id: 'A', line: 'L1', run: 3, tools: ['T1'], due: '2035-08-07T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const r = evaluateSchedule(snap, TF.toolRequest({ planningStart: new Date('2035-08-07T02:00:00'), runNow: new Date('2035-08-07T02:00:00'), endDate: new Date('2035-08-07T08:00:00') }));
  assert.equal(r.patches.some(p => p.id === 'B'), false, 'the held order is not patched');
  const a = TF.finalRows(snap, r).find(x => x.id === 'A');
  assert.equal(a.status, 'queued', 'only 2 tool-free hours before the held order: A cannot fit');
  assert.equal(a.reason.code, 'tool_contention');
  assert.deepEqual(a.reason.holders, ['B']);
});

test('tool overflow: a finish-only row blocks through its U29 bar [end - run, end]', () => {
  const snap = TF.toolSnapshot([
    { id: 'F', line: 'L2', run: 4, tools: ['T1'], end: '2035-08-06T14:00:00' },
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const a = TF.finalRows(snap, r).find(x => x.id === 'A');
  assert.equal(a.status, 'placed');
  assert.ok(a.start >= tms('2035-08-06T14:00:00') || a.end <= tms('2035-08-06T10:00:00'), 'A stays out of [10:00, 14:00)');
  assert.equal(r.patches.some(p => p.id === 'F'), false);
});

test('tool overflow: available 0 -> tool_unavailable, skipped by the search and listed in toolBlocked', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
    { id: 'C', line: 'L1', run: 2, tools: [], due: '2035-08-09T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1, out_of_service_qty: 1 }] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = Object.fromEntries(TF.finalRows(snap, r).map(x => [x.id, x]));
  assert.equal(rows.C.status, 'placed');
  assert.equal(rows.A.status, 'queued');
  assert.equal(rows.A.reason.code, 'tool_unavailable');
  assert.equal(rows.A.reason.tool_id, 'T1'); assert.equal(rows.A.reason.available, 0);
  assert.deepEqual(r.toolBlocked.map(e => [e.orderId, e.tool, e.available, e.inUse]), [['A', 'T1', 0, 0]]);
  // The static defect is what skips it in the search: the primary evaluator never admits it.
  const direct = SetupScheduler.evaluateDueDateFirst(snap, TF.toolBounds(snap));
  assert.equal(direct.patches.some(p => p.id === 'A' && p.changes.planning_status !== 'needs_planning'), false);
});

test('tool overflow: a SPLIT order keeps its tool mounted across the weekend gap (envelope), so an order inside the gap conflicts', () => {
  const hours = { 0: [0, 24], 1: [8, 18], 2: [8, 18], 3: [8, 18], 4: [8, 18], 5: [8, 18], 6: [0, 24] };
  const snap = TF.toolSnapshot([
    { id: 'S', line: 'L1', run: 12, tools: ['T1'], start: '2035-08-10T14:00:00', end: '2035-08-13T16:00:00',
      segments: [['2035-08-10T14:00:00', '2035-08-10T18:00:00'], ['2035-08-13T08:00:00', '2035-08-13T16:00:00']] },
    { id: 'W', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-20T08:00:00', start: '2035-08-11T10:00:00', end: '2035-08-11T14:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], firmedIds: ['S'], hours });
  const bounds = TF.toolBounds(snap, { horizonEnd: at20() });
  function at20() { return new Date('2035-08-20T08:00:00'); }
  const cand = toolCandidate([sched('W', '2035-08-11T10:00:00', '2035-08-11T14:00:00')], [dispOf('S', 'L1', 'protected'), dispOf('W', 'L2')]);
  const before = SetupScheduler.validateCandidate(snap, bounds, { ...cand, toolPass: { complete: true, elapsedMs: 0 } });
  assert.ok(before.some(f => f.code === 'tool_overflow' && f.severity === 'error' && f.taskId === 'W'), 'inside the weekend gap is a conflict');
  const out = SetupScheduler.resolveToolOverflow(snap, bounds, cand);
  const w = out.patches.find(p => p.id === 'W').changes;
  const ws = +w.start_date; const we = +w.end_date;
  assert.ok(we <= tms('2035-08-10T14:00:00') || ws >= tms('2035-08-13T16:00:00'), 'W is entirely outside the envelope');
  assert.deepEqual(errorsOf(out), []);
});

test('tool overflow: two plants sharing a tool id never interact', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'Z', line: 'L9', run: 4, tools: ['T1'], plant: 'P2', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1'] });
  snap.masterData.lines.push({ plant: 'P2', machine: 'L9' });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const a = TF.finalRows(snap, r).find(x => x.id === 'A');
  assert.equal(a.start, tms('2035-08-06T08:00:00'), 'P2 holds nothing of P1');
  assert.equal(r.toolMoved, undefined); assert.equal(r.toolBlocked, undefined);
});

test('tool overflow: the same id in both PRT slots counts ONCE (one machine, one copy)', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1', 'T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 2 }] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = TF.finalRows(snap, r);
  assert.ok(rows.every(x => x.start === tms('2035-08-06T08:00:00')), 'two copies cover two machines');
  assert.equal(r.toolMoved, undefined);
});

test('tool overflow: an incumbent with a PRE-EXISTING overlap is repaired before the comparison', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = TF.finalRows(snap, r);
  noOverflow(rows, one(1));
  assert.ok(rows.every(x => x.status === 'placed'), 'both stay scheduled (a slide, not a queue)');
  assert.deepEqual(errorsOf(r), []);
});

test('tool overflow: gap fill never re-creates overflow (search expired, every order placed by gap fill)', () => {
  const tasks = [
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-08T08:00:00' },
    { id: 'C', line: 'L3', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ];
  const run = rule => {
    const snap = TF.toolSnapshot(tasks, { inventory: [{ tool_id: 'T1', total_qty: 1 }], rule });
    const bounds = TF.toolBounds(snap, { deadline: -2000 });
    const cand = SetupScheduler.evaluateDueDateFirst(snap, bounds);
    return { snap, out: SetupScheduler.fillPlanningGaps(snap, bounds, cand) };
  };
  const hard = run('hard');
  const rows = TF.finalRows(hard.snap, hard.out);
  assert.ok(rows.every(x => x.status === 'placed'));
  noOverflow(rows, one(1));
  const off = run('off');
  assert.ok(TF.overflowOracle(TF.finalRows(off.snap, off.out), one(1)).length > 0, 'Off keeps the (alert-only) overlap, proving the Hard run changed something');
});

test('tool overflow: a setup-OFF (synthetic) plant still enforces the rule', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], plantExtra: { setup_active: false } });
  snap.setupSnapshot = null;
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = TF.finalRows(snap, r);
  noOverflow(rows, one(1));
  assert.equal(r.toolMoved?.length, 1);
});

test('tool overflow: moving or queueing an offender hands its old SAME-LINE successor to the repair cascade (excludeFromSearch)', () => {
  // L2 runs C(GREEN) -> D(BLUE) -> E(RED). D collides with A on T1; GREEN->RED has no matrix row, so once D leaves,
  // E would sit behind an unrecorded transition: the existing repair cascade queues it, with its own reason.
  const colors = { C: 'GREEN', D: 'BLUE', E: 'RED' };
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 2, tools: ['T1'], due: '2035-08-06T10:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T12:00:00' },
    { id: 'C', line: 'L2', run: 2, tools: [], color: colors.C, due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T10:00:00' },
    { id: 'D', line: 'L2', run: 2, tools: ['T1'], color: colors.D, due: '2035-08-09T08:00:00', start: '2035-08-06T10:05:00', end: '2035-08-06T12:05:00' },
    { id: 'E', line: 'L2', run: 2, tools: [], color: colors.E, due: '2035-08-09T08:00:00', start: '2035-08-06T12:10:00', end: '2035-08-06T14:10:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], firmedIds: ['A'], plantExtra: { max_push_forward_days: 0, setup_policy_config: { toolingRule: 'hard', unknownSetupPolicy: 'excludeFromSearch' } } });
  snap.setupSnapshot = {
    ...snap.setupSnapshot, machine_states: [],
    plant_rows: [['GREEN', 'BLUE', 5], ['BLUE', 'RED', 5]]
      .map(([f, t, m]) => ({ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: f }], to_key: [{ fieldKey: 'colorWheel', value: t }], setup_min: m })),
  };
  const bounds = TF.toolBounds(snap, { notAfter: () => new Date('2035-08-06T15:00:00') });
  const cand = toolCandidate(
    [sched('C', '2035-08-06T08:00:00', '2035-08-06T10:00:00'), sched('D', '2035-08-06T10:05:00', '2035-08-06T12:05:00'), sched('E', '2035-08-06T12:10:00', '2035-08-06T14:10:00')],
    [dispOf('A', 'L1', 'protected'), dispOf('C', 'L2'), dispOf('D', 'L2'), dispOf('E', 'L2')]);
  const out = SetupScheduler.resolveToolOverflow(snap, bounds, cand);
  const byId = Object.fromEntries(out.patches.map(p => [p.id, p.changes]));
  assert.equal(byId.E.planning_status, 'needs_planning', 'the old successor is queued by the repair cascade');
  assert.equal(byId.E.planning_reason.code, 'setup_transition_unrecorded');
  // Recovery runs again after the repair (E vacated its slot): D, queued for tooling first, now fits behind C after A's slot.
  assert.equal(byId.D.planning_status, 'scheduled');
  assert.ok(byId.D.start_date.getTime() >= tms('2035-08-06T12:00:00'), 'D moved past the firmed holder A (10:00-12:00)');
  assert.deepEqual(errorsOf(out), []);
  // Decision 7 (M2c): the cascade-queued order is reported as tool-blocked with the tool of the order whose move caused it.
  assert.deepEqual(out.toolBlocked.map(e => [e.orderId, e.cause, e.tool, e.holderIds]), [['E', 'cascade', 'T1', ['D']]]);
  assert.deepEqual(out.toolMoved.map(e => e.orderId), ['D']);
  assert.equal(SetupScheduler.validateCandidate(snap, bounds, out).some(f => f.severity === 'error'), false);
});

test('tool overflow: distribution siblings take turns on a shared tool (each child individually)', () => {
  const sib = (id, line, due) => ({ id, line, run: 4, tools: ['T1'], due });
  const snap = TF.toolSnapshot([sib('S1', 'L1', '2035-08-08T08:00:00'), sib('S2', 'L2', '2035-08-08T08:00:00')], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  for (const t of snap.tasks) { t.PARENT_ORDER = 'PO-1'; t.MATERIAL_NUMBER = 'MAT'; }
  const r = evaluateSchedule(snap, TF.toolRequest());
  const rows = TF.finalRows(snap, r);
  assert.ok(rows.every(x => x.status === 'placed'));
  noOverflow(rows, one(1));
  assert.equal(r.toolMoved.length, 1);
  assert.equal(errorsOf(r).length, 0, 'separation stays a warning, never an error');
});

test('tool overflow: budget expiry queues the remaining offenders as incomplete (toolPass.complete = false)', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const cand = toolCandidate([sched('A', '2035-08-06T08:00:00', '2035-08-06T12:00:00'), sched('B', '2035-08-06T08:00:00', '2035-08-06T12:00:00')], [dispOf('A', 'L1'), dispOf('B', 'L2')]);
  const out = SetupScheduler.resolveToolOverflow(snap, TF.toolBounds(snap), cand, 0);
  assert.equal(out.toolPass.complete, false);
  const b = out.patches.find(p => p.id === 'B').changes;
  assert.equal(b.planning_status, 'needs_planning');
  assert.equal(b.planning_reason.code, 'tool_contention'); assert.equal(b.planning_reason.incomplete, true);
  assert.equal(out.toolBlocked.length, 1);
  assert.deepEqual(errorsOf(out), [], 'an incomplete check never leaves an error finding behind');
  // A generous budget resolves the same instance completely.
  const full = SetupScheduler.resolveToolOverflow(snap, TF.toolBounds(snap), cand, 1000);
  assert.equal(full.toolPass.complete, true);
});

test('tool overflow: Remove Backlog (ignoreToolRule), rule Off and an UNLOADED inventory are all no-ops with the three fields absent', () => {
  const tasks = [
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
  ];
  const cand = toolCandidate([sched('A', '2035-08-06T08:00:00', '2035-08-06T12:00:00'), sched('B', '2035-08-06T08:00:00', '2035-08-06T12:00:00')], [dispOf('A', 'L1'), dispOf('B', 'L2')]);
  const hard = TF.toolSnapshot(tasks, { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  assert.equal(SetupScheduler.resolveToolOverflow(hard, TF.toolBounds(hard, { ignoreToolRule: true }), cand), cand, 'Remove Backlog: same object');
  assert.equal(SetupScheduler.validateCandidate(hard, TF.toolBounds(hard, { ignoreToolRule: true }), cand).some(f => f.code === 'tool_overflow'), false);
  const off = TF.toolSnapshot(tasks, { inventory: [{ tool_id: 'T1', total_qty: 1 }], rule: 'off' });
  assert.equal(SetupScheduler.resolveToolOverflow(off, TF.toolBounds(off), cand), cand);
  const unloaded = TF.toolSnapshot(tasks, { inventory: null });
  assert.equal(SetupScheduler.resolveToolOverflow(unloaded, TF.toolBounds(unloaded), cand), cand, 'Hard + inventory undefined = unconstrained');
  assert.equal(SetupScheduler.validateCandidate(unloaded, TF.toolBounds(unloaded), cand).some(f => f.code === 'tool_overflow'), false);
  const r = evaluateSchedule(unloaded, TF.toolRequest());
  assert.equal(r.toolPass, undefined); assert.equal(r.toolBlocked, undefined); assert.equal(r.toolMoved, undefined);
});

test('tool overflow: tool_overflow is a WARNING until the pass has run, then an ERROR naming exactly ONE order with a fixed message', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'C', line: 'L3', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const cand = toolCandidate([], ['A', 'B', 'C'].map((id, i) => dispOf(id, 'L' + (i + 1))));
  const pre = SetupScheduler.validateCandidate(snap, TF.toolBounds(snap), cand).filter(f => f.code === 'tool_overflow');
  assert.ok(pre.length && pre.every(f => f.severity === 'warning'), 'not an error before the pass ran');
  const post = SetupScheduler.validateCandidate(snap, TF.toolBounds(snap), { ...cand, toolPass: { complete: true, elapsedMs: 0 } }).filter(f => f.code === 'tool_overflow');
  assert.ok(post.length && post.every(f => f.severity === 'error'));
  assert.ok(post.every(f => ['B', 'C'].includes(f.taskId)), 'the least urgent mutable holder, never the most urgent');
  assert.equal(new Set(post.map(f => f.message)).size, 1, 'one FIXED message');
  assert.ok(post.every(f => Array.isArray(f.detail.holders) && f.detail.tool === 'T1'));
  assert.ok(post.every(f => !f.message.includes('A') || !f.message.includes('T1')), 'message carries neither tool nor holders');
});

test('tool overflow: inputs in any order give IDENTICAL patches (snapshot.tasks reversed, repeated run)', () => {
  const tasks = [
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-08T08:00:00' },
    { id: 'C', line: 'L3', run: 4, tools: ['T1', 'T2'], due: '2035-08-09T08:00:00' },
    { id: 'D', line: 'L1', run: 3, tools: ['T2'], due: '2035-08-09T08:00:00' },
  ];
  const inv = [{ tool_id: 'T1', total_qty: 1 }, { tool_id: 'T2', total_qty: 1 }];
  const run = specs => { const s = TF.toolSnapshot(specs, { inventory: inv, lines: ['L1', 'L2', 'L3'] }); return TF.finalRows(s, evaluateSchedule(s, TF.toolRequest())).sort((a, b) => a.id < b.id ? -1 : 1).map(({ id, status, start, end, reason }) => ({ id, status, start, end, code: reason?.code })); };
  const forward = run(tasks);
  assert.deepEqual(run(tasks), forward);
  assert.deepEqual(run([...tasks].reverse()), forward);
});

// ── Tool Inventory Wave 6 validation fixes (M2 / M4 / m6 / iv) ─────────────────────────────────────────────────────

test('tool overflow (F3): a never-committed bar on an UNSELECTED line does not reserve a copy for mutable work, a committed one does', () => {
  const mk = userScheduled => TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00', userScheduled },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1', 'L2'] });
  // Never committed (user_scheduled false, both dates): the optimizer does NOT move A; the overlap is a WARNING only.
  const never = mk(false);
  const r1 = evaluateSchedule(never, TF.toolRequest({ lines: ['L1'] }));
  const a1 = TF.finalRows(never, r1).find(x => x.id === 'A');
  assert.equal(a1.status, 'placed');
  assert.equal(a1.start, tms('2035-08-06T10:00:00'), 'A keeps its slot: the never-committed bar does not reserve the copy');
  assert.equal(r1.toolMoved, undefined); assert.equal(r1.toolBlocked, undefined);
  assert.deepEqual(errorsOf(r1), []);
  const warn = SetupScheduler.validateCandidate(never, TF.toolBounds(never, { lines: ['L1'] }), { ...r1, toolPass: { complete: true, elapsedMs: 0 } }).filter(f => f.code === 'tool_overflow');
  assert.ok(warn.length && warn.every(f => f.severity === 'warning'), 'the overlap with the never-committed bar is still shown, as a warning');
  // The same bar committed (user_scheduled true): it reserves the copy, so A has to move.
  const committed = mk(true);
  const r2 = evaluateSchedule(committed, TF.toolRequest({ lines: ['L1'] }));
  const a2 = TF.finalRows(committed, r2).find(x => x.id === 'A');
  assert.ok(a2.status === 'queued' || a2.start !== tms('2035-08-06T10:00:00'), 'A moved off the committed bar');
  noOverflow(TF.finalRows(committed, r2), one(1));
});

test('tool overflow (F3): a never-committed bar still reserves when it is MUTABLE (the optimizer places it) and a bar wholly outside the window never takes part', () => {
  // Both on selected lines: B is mutable (its baseline is only a starting point), so the two cannot overlap.
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00', userScheduled: false },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1', 'L2'] });
  const r = evaluateSchedule(snap, TF.toolRequest());
  noOverflow(TF.finalRows(snap, r), one(1));
  assert.deepEqual(errorsOf(r), []);
  // A one-day window that ends before the bar starts: the bar is outside it, never overlaps, and raises nothing.
  const outside = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-08T10:00:00', end: '2035-08-08T14:00:00', userScheduled: false },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1', 'L2'] });
  const win = TF.toolRequest({ lines: ['L1'], endDate: new Date('2035-08-07T08:00:00') });
  const r2 = evaluateSchedule(outside, win);
  const a = TF.finalRows(outside, r2).find(x => x.id === 'A');
  assert.equal(a.start, tms('2035-08-06T10:00:00'));
  assert.equal(r2.toolMoved, undefined);
  assert.equal(SetupScheduler.validateCandidate(outside, TF.toolBounds(outside, { lines: ['L1'], horizonEnd: new Date('2035-08-07T08:00:00') }), r2).some(f => f.code === 'tool_overflow'), false);
});

test('tool overflow (F3): a finish-only row and a firmed never-committed bar still reserve copies', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00' },
    { id: 'F', line: 'L2', run: 4, tools: ['T1'], start: '2035-08-06T10:00:00', end: '2035-08-06T14:00:00', userScheduled: false },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1', 'L2'], firmedIds: ['F'] });
  const r = evaluateSchedule(snap, TF.toolRequest({ lines: ['L1'] }));
  const a = TF.finalRows(snap, r).find(x => x.id === 'A');
  assert.ok(a.status === 'queued' || a.start !== tms('2035-08-06T10:00:00'), 'a firmed bar is physical: it reserves even though it was never committed');
});

test('tool overflow: a non-stale exception FAILS CLOSED (fixed tool_overflow_failed error, candidate unchanged); compute-core-stale propagates', () => {
  const snap = TF.toolSnapshot([
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00', start: '2035-08-06T08:00:00', end: '2035-08-06T12:00:00' },
  ], { inventory: [{ tool_id: 'T1', total_qty: 1 }] });
  const bounds = TF.toolBounds(snap);
  const cand = toolCandidate([sched('A', '2035-08-06T08:00:00', '2035-08-06T12:00:00'), sched('B', '2035-08-06T08:00:00', '2035-08-06T12:00:00')], [dispOf('A', 'L1'), dispOf('B', 'L2')]);
  const core = globalThis.NimbusComputeCore;
  const real = core.findToolOverages;
  try {
    core.findToolOverages = () => { throw new Error('boom'); };
    const out = SetupScheduler.resolveToolOverflow(snap, bounds, cand);
    assert.equal(out.toolPass.failed, true);
    assert.equal(out.toolPass.complete, false);
    assert.deepEqual(out.patches, cand.patches, 'the candidate is returned unchanged');
    const failed = f => f.code === 'tool_overflow_failed' && f.severity === 'error';
    assert.ok(out.validationFindings.some(failed), 'a planner-visible error finding, not a silent skip');
    // The finding survives any recomputation (validateCandidate derives it from toolPass.failed) and a throw inside validate is itself caught.
    assert.ok(SetupScheduler.validateCandidate(snap, bounds, out).some(failed));
    assert.ok(SetupScheduler.validateCandidate(snap, bounds, cand).some(failed), 'a throw while validating also fails closed, never crashes');
    const msgs = new Set(SetupScheduler.validateCandidate(snap, bounds, out).filter(failed).map(f => f.message));
    assert.equal(msgs.size, 1, 'one fixed message');
    const r = evaluateSchedule(snap, TF.toolRequest());
    assert.ok(r.validationFindings.some(failed), 'the engine returns a result that cannot be applied, it does not throw');
  } finally { core.findToolOverages = real; }
  const savedCore = globalThis.NimbusComputeCore;
  try {
    globalThis.NimbusComputeCore = { ...savedCore, toolHeadroom: undefined };
    assert.throws(() => SetupScheduler.resolveToolOverflow(snap, bounds, cand), /compute-core-stale/);
    assert.throws(() => SetupScheduler.validateCandidate(snap, bounds, cand), /compute-core-stale/);
  } finally { globalThis.NimbusComputeCore = savedCore; }
});

test('tool overflow: toolMoved keeps ONE entry per order (first from, last to) and drops a net no-op; a tool queue outranks a cascade marker', () => {
  const m = (orderId, fromStart, toStart) => ({ orderId, tool: 'T1', fromStart, fromEnd: fromStart + 'e', toStart, toEnd: toStart + 'e' });
  const merged = SetupScheduler.mergeToolMoved([m('A', 'a', 'b'), m('B', 'x', 'y')], [m('A', 'b', 'c')]);
  assert.deepEqual(merged.map(e => [e.orderId, e.fromStart, e.toStart]), [['A', 'a', 'c'], ['B', 'x', 'y']]);
  assert.deepEqual(SetupScheduler.mergeToolMoved([m('A', 'a', 'b')], [m('A', 'b', 'a')]), [], 'moved away and back = nothing to report');
  const blocked = SetupScheduler.mergeToolBlocked(
    [{ orderId: 'A', tool: 'T1', available: 1, inUse: 2, holderIds: ['B'] }],
    [{ orderId: 'A', tool: 'T2', available: 1, inUse: 0, holderIds: ['C'], cause: 'cascade' }, { orderId: 'D', tool: 'T2', available: 1, inUse: 0, holderIds: ['C'], cause: 'cascade' }]);
  assert.equal(blocked.find(e => e.orderId === 'A').cause, undefined, 'the tool queue is kept');
  assert.equal(blocked.find(e => e.orderId === 'D').cause, 'cascade');
});

test('tool overflow: with a fake clock the pass is deterministic at every budget, and a pass that reports complete is a fixpoint', () => {
  // Four orders on one copy, three of them movable; a counter clock makes every budget reproducible.
  const specs = [
    { id: 'A', line: 'L1', run: 4, tools: ['T1'], due: '2035-08-07T08:00:00' },
    { id: 'B', line: 'L2', run: 4, tools: ['T1'], due: '2035-08-08T08:00:00' },
    { id: 'C', line: 'L3', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
    { id: 'D', line: 'L4', run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' },
  ];
  const opts = { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ['L1', 'L2', 'L3', 'L4'] };
  const snap = TF.toolSnapshot(specs, opts);
  const base = evaluateSchedule(TF.toolSnapshot(specs, { ...opts, rule: 'off' }), TF.toolRequest());
  const ctx = base.validationContext;
  const hardSnap = { ...ctx.snapshot, masterData: snap.masterData };
  const sig = c => JSON.stringify([...c.patches].sort((a, b) => (a.id < b.id ? -1 : 1)).map(p => [p.id, p.changes.planning_status, p.changes.start_date?.toISOString?.() ?? null, p.changes.planning_reason?.code ?? null, !!p.changes.planning_reason?.incomplete]));
  for (const budget of [0, 1, 2, 3, 5, 8, 13, 21, 55, 1e6]) {
    const run = () => { let n = 0; return SetupScheduler.resolveToolOverflow(hardSnap, { ...ctx.bounds, clock: () => n++ }, base, budget); };
    const out = run();
    assert.equal(sig(run()), sig(out), 'budget ' + budget + ': deterministic');
    const queuedPass = out.patches.filter(p => p.changes.planning_reason?.code === 'tool_contention');
    if (out.toolPass.complete) {
      assert.equal(queuedPass.some(p => p.changes.planning_reason.incomplete), false, 'budget ' + budget + ': a complete pass leaves no incomplete queue');
      assert.equal(sig(SetupScheduler.resolveToolOverflow(hardSnap, { ...ctx.bounds, clock: () => 0 }, out, 1e6)), sig(out), 'budget ' + budget + ': complete means a fixpoint');
    } else {
      assert.ok(queuedPass.length > 0 || out.toolPass.complete === false, 'an incomplete pass reports it');
    }
  }
});

test('tool overflow: a cascade marker is dropped once a later repair relabels the order to another reason', () => {
  const entry = (orderId, reasonCode) => ({ orderId, tool: 'T1', available: 1, inUse: 0, holderIds: ['A'], cause: 'cascade', reasonCode });
  const result = { patches: [], toolPass: { complete: true, elapsedMs: 0 },
    dispositions: [
      { id: 'E', line: 'L2', status: 'needs_planning', reason: { code: 'no_fit_found', message: 'x' } },
      { id: 'F', line: 'L2', status: 'needs_planning', reason: { code: 'setup_transition_unrecorded', message: 'x' } },
      { id: 'G', line: 'L2', status: 'scheduled' },
    ],
    toolBlocked: [entry('E', 'setup_transition_unrecorded'), entry('F', 'setup_transition_unrecorded'), entry('G', 'setup_transition_unrecorded')] };
  const out = SetupScheduler.reconcileToolOutcomes(result);
  assert.deepEqual((out.toolBlocked ?? []).map(e => e.orderId), ['F'], 'E was relabelled (dropped); G is scheduled (dropped); F keeps its cascade marker');
});

test('tool overflow: the contention detail counts distinct other machines from the untruncated holders (two items on one line are one copy)', () => {
  const item = (id, line) => ({ id, line, start: new Date('2035-08-07T03:00:00'), end: new Date('2035-08-07T05:00:00') });
  const mk = items => ({ ctx: { core: { toolHeadroom: () => [] }, plant: 'P1', capacityFor: () => ({ available: 1 }) }, byTool: new Map([['T1', new Map(items.map(x => [x.id, x]))]]) });
  const span = [new Date('2035-08-07T02:00:00'), new Date('2035-08-07T06:00:00')];
  // two items on ONE other machine: one copy in use, plus the order itself
  const single = SetupScheduler.toolContentionDetail(mk([item('B', 'L2'), item('B2', 'L2')]), ['T1'], 'L1', ...span);
  assert.deepEqual(single.holders, ['B', 'B2']); assert.equal(single.inUse, 2);
  // 14 items on 14 distinct machines: holders are capped at 10, inUse is NOT (14 + the order itself)
  const many = Array.from({ length: 14 }, (_, k) => item('H' + String(k).padStart(2, '0'), 'M' + k));
  const wide = SetupScheduler.toolContentionDetail(mk(many), ['T1'], 'L1', ...span);
  assert.equal(wide.holders.length, 10); assert.equal(wide.inUse, 15);
});

// ---- PR2 (optimization review 2026-11): scheduler core accounting ----

test('P0-7: a firmed-boundary setup straddling midnight on a 24x7 calendar is charged, so the cheaper ending wins', () => {
  // Search-level accounting: p07-a,p07-b would end YELLOW (120 min into BLUE); p07-b,p07-a ends RED (0 min).
  // Before the fix the straddling 120 was judged "does not fit" and never charged, so the tie fell to the id order.
  const allDay = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const fixed = scheduledTask('p07-fixed-blue', 1, 'BLUE', '2026-08-04T02:00:00', '2026-08-04T01:00:00', '2026-08-04T02:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'YELLOW', 0), setupRow('RED', 'YELLOW', 0), setupRow('YELLOW', 'RED', 0),
    setupRow('RED', 'BLUE', 0), setupRow('YELLOW', 'BLUE', 120),
  ] });
  const snapshot = {
    ...setupSnapshot([scheduledTask('p07-a', 1, 'RED', '2026-08-03T18:00:00'), scheduledTask('p07-b', 1, 'YELLOW', '2026-08-03T18:00:00'), fixed], { firmedIds: ['p07-fixed-blue'] }),
    calendars: { L1: { workHours: allDay } }, plants: { P1: { workHours: allDay } },
  };
  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { respectCalendar: true, horizonEnd: at('2026-08-06T00:00:00') }));
  assert.ok(+patchFor(result, 'p07-b').changes.start_date < +patchFor(result, 'p07-a').changes.start_date, 'the RED-last ending avoids the 120-minute changeover');
});

test('P0-8: a backtracked suffix leaves no stale admitted-without-setup explanation or edge for the popped order', () => {
  const x = scheduledTask('p08-x', 1, 'RED', '2026-08-03T18:00:00');
  const fixed = scheduledTask('p08-fixed-blue', 1, 'BLUE', '2026-08-03T11:00:00', '2026-08-03T10:00:00', '2026-08-03T11:00:00');
  // GREEN -> RED has no row (uncovered admission); RED -> BLUE needs 90 minutes, which cannot fit after X, so X is popped.
  const setup = setupTruth({ rows: [setupRow('RED', 'BLUE', 90), setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0)] });
  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([x, fixed], { firmedIds: ['p08-fixed-blue'] }), dueDateBounds(setup, { respectCalendar: true }));
  assert.equal(result.explanation.some(entry => entry.code === 'admitted-without-setup' && entry.taskId === 'p08-x'), false);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'scheduled-without-setup' && edge.successorOrderId === 'p08-x'), false);
});
