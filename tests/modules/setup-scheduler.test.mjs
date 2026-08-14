import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateSchedule } from '../../web/setup-scheduler.mjs';
import * as SetupScheduler from '../../web/setup-scheduler.mjs';
import { ErrorLog } from '../../web/application-foundation.mjs';
import { Store } from '../../web/schedule-state.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');

function task(id, runHours) {
  return {
    id,
    PLANT: 'P1',
    plant: 'P1',
    PRODUCTION_LINE: 'L1',
    RUN_TIME: runHours,
    start_date: null,
    end_date: null,
    original_start_date: null,
    original_end_date: null,
    BASIC_START_DATE: null,
    BASIC_FINISH_DATE: null,
    fixed: false,
    row_version: null,
  };
}

function legacySnapshot(tasks) {
  return {
    tasks,
    fixedIds: [],
    alerts: [],
    selectedPlant: 'P1',
    blocks: [],
    plantBlocks: [],
    calendars: {},
    plants: {},
    lineSettings: {},
    masterData: { plants: [{ plant: 'P1' }], lines: [{ plant: 'P1', production_line: 'L1' }] },
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

function setupRow(from, to, minutes, line = '') {
  return { line, signature_version: 1, from_key: setupState(from), to_key: setupState(to), setup_min: minutes };
}

function setupTruth({ current = 'GREEN', rows = [], overrides = [], definition = setupDefinition() } = {}) {
  return {
    plant: 'P1', definition,
    plant_rows: rows,
    line_rows: [],
    line_states: current === null ? [] : [{
      line: 'L1', state_key: setupState(current), signature_version: 1,
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

function setupSnapshot(tasks, { fixedIds = [], lineSettings = {} } = {}) {
  return {
    ...legacySnapshot(tasks),
    fixedIds,
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
  return result.patches.find(patch => patch.id === id);
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
  assert.ok(result.explanation.some(reason => reason.code === 'min-changeover-due-safe'));
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
  Store.setFixed('live', true, 'unit-test');
  Store.setAlerts([{ id: 'existing-alert', type: 'overlap', sev: 'err' }], 'unit-test');

  const beforeRevision = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const beforeFixedIds = Array.from(Store.fixedIds).sort();
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

    assert.deepEqual(result.patches.map(patch => patch.id), ['short', 'long'],
      'the detached result retains legacy SPT productive-runtime ordering');
    assert.equal(result.patches[0].changes.start_date.getTime(), new Date('2026-08-03T08:00:00').getTime());
    assert.equal(Store.rev(), beforeRevision, 'candidate evaluation must not publish Store mutations');
    assert.deepEqual(Store.tasks, beforeTasks, 'candidate patches must not enter live task state');
    assert.deepEqual(Array.from(Store.fixedIds).sort(), beforeFixedIds, 'candidate evaluation must not alter fixed boundaries');
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
    assert.equal(result.diagnostics.events?.[0]?.code, 'calendar.next-available-exhausted',
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
        { line: '', signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 20 },
        { line: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 10 },
      ],
      line_rows: [],
      line_states: [{
        line: 'L1', state_key: state('GREEN'), signature_version: 1,
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

  assert.deepEqual(result.patches.map(patch => patch.id), ['due-first-early', 'due-first-later']);
  assert.equal(result.patches[0].changes.start_date.getTime(), at('2026-08-03T08:20:00').getTime());
  assert.equal(result.patches[1].changes.start_date.getTime(), at('2026-08-03T09:30:00').getTime());
});

test('evaluateDueDateFirst reports an uncovered line but still optimizes an unaffected covered line', () => {
  // This fails if a missing non-diagonal setup edge is silently discarded, or
  // if one infeasible line blocks an otherwise covered line from its detached
  // candidate result.
  const uncovered = scheduledTask('uncovered-red', 1, 'RED', '2026-08-03T10:00:00');
  const covered = {
    ...scheduledTask('covered-blue', 1, 'BLUE', '2026-08-03T10:00:00'),
    PRODUCTION_LINE: 'L2',
  };
  const snapshot = setupSnapshot([uncovered, covered]);
  snapshot.calendars = {
    L1: { workHours: OPEN_HOURS },
    L2: { workHours: OPEN_HOURS },
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 10)] });
  setup.line_states.push({
    line: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'second line current state',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(result.patches.map(patch => patch.id), ['covered-blue']);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.deepEqual(result.missingEdges, [{
    line: 'L1', predecessorOrderId: null, successorOrderId: 'uncovered-red',
    reason: 'No version-matched setup transition covers this state pair',
  }]);
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
    setupSnapshot([before, fixed, after], { fixedIds: ['fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'fixed-blue'), undefined, 'a fixed production run must never become a candidate patch');
  assert.equal(patchFor(result, 'free-before').changes.start_date.getTime(), at('2026-08-03T08:10:00').getTime());
  assert.equal(patchFor(result, 'free-before').changes.end_date.getTime(), at('2026-08-03T09:10:00').getTime());
  assert.equal(patchFor(result, 'free-after').changes.start_date.getTime(), at('2026-08-03T11:10:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('evaluateDueDateFirst preserves a fixed production run when its incoming setup cannot fit', () => {
  // This fails if the optimizer moves/patches fixed production to make room,
  // or quietly shortens an impossible incoming setup instead of leaving the
  // line unchanged with a structured boundary reason.
  const before = scheduledTask('too-late-before', 1, 'RED', '2026-08-03T09:00:00');
  const fixed = scheduledTask(
    'fixed-blue-tight', 1, 'BLUE', '2026-08-03T10:30:00', '2026-08-03T09:30:00', '2026-08-03T10:30:00',
  );
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 10),
    setupRow('RED', 'BLUE', 30),
  ] });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([before, fixed], { fixedIds: ['fixed-blue-tight'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.missingEdges.some(edge => (
    edge.successorOrderId === 'fixed-blue-tight' && edge.reason === 'incoming-fixed-setup-infeasible'
  )));
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
    setupSnapshot([firstFixed, freeMiddle, secondFixed], { fixedIds: ['first-fixed-blue', 'second-fixed-yellow'] }),
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
      id: 'override-1', line: 'L1', signature_version: 1,
      predecessor_order_id: 'override-red', successor_order_id: 'override-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 20, remaining_min: 4, status: 'active', reason: 'crew already changed tooling',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red, blue]), dueDateBounds(setup));

  assert.deepEqual(result.patches.map(patch => patch.id), ['override-red', 'override-blue']);
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
      id: 'stale-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-red', successor_order_id: 'bound-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 20, remaining_min: 4, status: 'active', reason: 'stale binding fixture',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red, blue]), dueDateBounds(setup));

  assert.deepEqual(result.patches, []);
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

  const serial = result => result.patches.map(patch => [
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
  assert.deepEqual(expired.unchangedLines, ['L1']);
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
  assert.ok(lowCapClockCalls <= 5,
    'the fixed clock observes only the bounded path, not ten recursive occurrence visits');

  const enoughCap = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot(manyRed),
    dueDateBounds(setup, { exactSearchThreshold: 1, iterationCap: manyRed.length }),
  );

  assert.equal(enoughCap.diagnostics.termination, 'completed');
  assert.equal(enoughCap.diagnostics.candidateCount, 1);
  assert.equal(enoughCap.patches.length, manyRed.length,
    'a caller that supplies enough explicit search work still receives the useful deterministic candidate');
});

test('evaluateDueDateFirst applies its caller iteration cap across every line in one candidate run', () => {
  // This fails if each line silently receives a fresh iteration budget and a
  // plant-wide run can exceed the explicit bound selected from Stage 0 data.
  const firstLine = scheduledTask('global-cap-l1', 1, 'BLUE', '2026-08-03T10:00:00');
  const secondLine = {
    ...scheduledTask('global-cap-l2', 1, 'BLUE', '2026-08-03T10:00:00'),
    PRODUCTION_LINE: 'L2',
  };
  const snapshot = setupSnapshot([firstLine, secondLine]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  setup.line_states.push({
    line: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'second global-cap line',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup, { iterationCap: 1 }));

  assert.deepEqual(result.patches.map(patch => patch.id), ['global-cap-l1']);
  assert.deepEqual(result.unchangedLines, ['L2']);
  assert.equal(result.diagnostics.candidateCount, 1);
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
  assert.deepEqual(result.patches.map(patch => patch.id), ['greedy-a', 'greedy-b']);
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

  assert.deepEqual(result.patches.map(patch => patch.id), ['spt-short-blue', 'spt-long-red']);
  assert.equal(patchFor(result, 'spt-short-blue').changes.start_date.getTime(), at('2026-08-03T08:20:00').getTime());
  assert.equal(patchFor(result, 'spt-long-red').changes.start_date.getTime(), at('2026-08-03T09:30:00').getTime());
});

test('evaluateSptWithSetup leaves a line unchanged when its pure SPT sequence has a missing edge', () => {
  // This fails if a missing transition makes the implementation quietly pick a
  // different non-SPT ordering just to obtain matrix coverage.
  const longRed = scheduledTask('spt-missing-long-red', 2, 'RED', null);
  const shortBlue = scheduledTask('spt-missing-short-blue', 1, 'BLUE', null);
  const setup = setupTruth({ rows: [setupRow('GREEN', 'RED', 5)] });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([longRed, shortBlue]),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.missingEdges.some(edge => edge.successorOrderId === 'spt-missing-short-blue'));
});

test('evaluateDueDateFirst excludes a line with an incomplete setup state before searching other lines', () => {
  // This fails if a strict-blank order is grouped as a usable state, or if its
  // incompatible line consumes search budget / blocks a fully known line.
  const incomplete = scheduledTask('incomplete-state', 1, '', '2026-08-03T10:00:00');
  const known = {
    ...scheduledTask('known-state', 1, 'BLUE', '2026-08-03T10:00:00'),
    PRODUCTION_LINE: 'L2',
  };
  const snapshot = setupSnapshot([incomplete, known]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 5)] });
  setup.line_states.push({
    line: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'known second line state',
  });

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.deepEqual(result.patches.map(patch => patch.id), ['known-state']);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.equal(result.diagnostics.candidateCount, 1);
  assert.ok(result.explanation.some(reason => reason.line === 'L1' && reason.code === 'setup-incompatible'));
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
    setupSnapshot([longer, fixed, shorter], { fixedIds: ['spt-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), ['spt-fixed-short-red', 'spt-fixed-long-yellow']);
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
    setupSnapshot([long, fixed, medium, short], { fixedIds: ['spt-pre-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), [
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
    id: 'override-before-fixed', line: 'L1', signature_version: 1,
    predecessor_order_id: 'override-before-fixed-red', successor_order_id: 'override-fixed-blue',
    predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected pre-fixed adjacency',
  }] });

  const beforeResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([beforeFixed, fixedBlue], { fixedIds: ['override-fixed-blue'] }),
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
    id: 'override-after-fixed', line: 'L1', signature_version: 1,
    predecessor_order_id: 'override-fixed-blue-again', successor_order_id: 'override-after-fixed-red',
    predecessor_state_key: setupState('BLUE'), successor_state_key: setupState('RED'),
    standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected post-fixed adjacency',
  }] });

  const afterResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([afterFixed, fixedBlueAgain], { fixedIds: ['override-fixed-blue-again'] }),
    dueDateBounds(afterSetup),
  );

  assert.equal(patchFor(afterResult, 'override-after-fixed-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.deepEqual(afterResult.unchangedLines, []);
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
      id: 'override-fixed-to-fixed', line: 'L1', signature_version: 1,
      predecessor_order_id: 'override-fixed-red', successor_order_id: 'override-fixed-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 10, remaining_min: 10, status: 'active', reason: 'protected fixed adjacency',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([fixedBlue, fixedRed], { fixedIds: ['override-fixed-red', 'override-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'fixed-incoming-setup' && reason.taskId === 'override-fixed-blue' && reason.message.includes('10')
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
    setupSnapshot([yellow, fixed, red], { fixedIds: ['admitted-fixed-blue'] }),
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
    setupSnapshot([fixed], { fixedIds: ['zero-fixed-blue'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.missingEdges.some(edge => edge.reason === 'incoming-fixed-setup-infeasible'), false);
});

test('setup-aware evaluators exclude signature-incompatible line state without blocking other candidates', () => {
  // This fails if a stale line-state version is reported as ordinary missing
  // initial truth or allowed to mix with the active matrix signature.
  const blue = scheduledTask(
    'signature-incompatible-blue', 1, 'BLUE', '2026-08-03T10:00:00',
    '2026-08-03T08:00:00', '2026-08-03T09:00:00',
  );
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  setup.line_states[0].signature_version = 2;

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([blue]), dueDateBounds(setup));

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.missingEdges.some(edge => edge.reason === 'signature-incompatible'));
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
      id: 'same-state-active-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'same-state-predecessor', successor_order_id: 'same-state-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected same-state occurrence',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), ['same-state-predecessor', 'same-state-successor']);
  assert.deepEqual(result.unchangedLines, []);

  const greedyResult = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup, { exactSearchThreshold: 0 }),
  );
  assert.equal(greedyResult.diagnostics.method, 'due-date-first-greedy');
  assert.deepEqual(greedyResult.patches.map(patch => patch.id), ['same-state-predecessor', 'same-state-successor']);
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
      id: 'capacity-pair-active-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'capacity-pair-predecessor', successor_order_id: 'capacity-pair-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected capacity-bound occurrence',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([predecessor, successor]),
    dueDateBounds(setup, { horizonEnd: at('2026-08-03T09:30:00') }),
  );

  assert.deepEqual(result.patches, []);
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
      id: 'cross-boundary-active-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'cross-boundary-pair-predecessor', successor_order_id: 'cross-boundary-pair-successor',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected across due partition',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([successor, fixed, predecessor], { fixedIds: ['cross-boundary-fixed-yellow'] }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), [
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
  assert.deepEqual(result.patches, []);
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
      id: 'initial-to-fixed-override', line: 'L1', signature_version: 1,
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
      setupSnapshot([freeRed, fixedBlue], { fixedIds: ['initial-override-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(result.patches.map(patch => patch.id), ['initial-override-free-red'], `${label} moves free work after fixed`);
    assert.equal(patchFor(result, 'initial-override-free-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
    assert.deepEqual(result.unchangedLines, []);
    assert.equal(result.missingEdges.some(edge => edge.reason === 'override-inactive'), false);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'fixed-incoming-setup'
      && reason.taskId === 'initial-override-fixed-blue'
      && reason.message.includes('10')
    )), `${label} resolves the incoming fixed setup from the protected override`);
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
      id: 'invalid-null-later', line: 'L1', signature_version: 1,
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
      id: 'invalid-null-state', line: 'L1', signature_version: 1,
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
        setupSnapshot([firstFixed, laterFixed], { fixedIds: ['invalid-null-first-blue', 'invalid-null-later-yellow'] }),
        laterSetup,
      ],
      [
        'stale initial state',
        setupSnapshot([staleStateFixed], { fixedIds: ['invalid-null-state-blue'] }),
        staleStateSetup,
      ],
    ]) {
      const result = evaluate(snapshot, dueDateBounds(setup));
      assert.deepEqual(result.patches, [], `${label} ${caseLabel} makes no mutable candidate`);
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
        id: 'initial-free-override', line: 'L1', signature_version: 1,
        predecessor_order_id: null, successor_order_id: 'initial-free-red',
        predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'line is staged for red',
      },
      {
        id: 'initial-free-component-override', line: 'L1', signature_version: 1,
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
      setupSnapshot([yellow, fixed, blue, red], { fixedIds: ['initial-free-fixed-yellow'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(result.patches.map(patch => patch.id), [
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
        id: 'initial-free-tight-override', line: 'L1', signature_version: 1,
        predecessor_order_id: null, successor_order_id: 'initial-free-tight-red',
        predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'line is staged for red',
      },
      {
        id: 'initial-free-tight-component', line: 'L1', signature_version: 1,
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
      setupSnapshot([blue, fixed, red], { fixedIds: ['initial-free-tight-fixed-yellow'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(result.patches, [], `${label} does not emit a partial protected component`);
    assert.deepEqual(result.unchangedLines, ['L1']);
  }
});

test('setup-aware evaluators discard all line patches when trailing capacity leaves work unadmitted', () => {
  // This fails if the final fragment emits a new patch for one order while a
  // later old schedule remains in place and overlaps it. It also proves that
  // a pre-fixed patch cannot escape after terminal capacity rejection.
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

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(
      setupSnapshot([oldOverlap, fixed, firstTrailing, before], { fixedIds: ['terminal-fixed-blue'] }),
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T11:30:00') }),
    );

    assert.deepEqual(result.patches, [], `${label} must not publish a trailing partial candidate`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    if (label === 'Due-date-first') {
      assert.ok(result.explanation.some(reason => reason.code === 'trailing-fragment-unadmitted'));
    }
  }
});

test('setup-aware evaluators exclude an explicitly incompatible snapshot line without blocking a compatible line', () => {
  // This fails if setup_compatible=false is ignored, read from live state, or
  // allowed to consume detached candidate work before the compatible L2 line.
  const incompatible = scheduledTask('compatibility-disabled-blue', 1, 'BLUE', '2026-08-03T10:00:00');
  const compatible = {
    ...scheduledTask('compatibility-enabled-blue', 1, 'BLUE', '2026-08-03T10:00:00'),
    PRODUCTION_LINE: 'L2',
  };
  const snapshot = setupSnapshot([incompatible, compatible]);
  snapshot.calendars = { L1: { workHours: OPEN_HOURS }, L2: { workHours: OPEN_HOURS } };
  snapshot.masterData = {
    plants: [{ plant: 'P1' }],
    lines: [
      {
        plant: 'P1', production_line: 'L1', setup_compatible: false,
        setup_compatibility_reason: 'Tooling signature differs on this line',
      },
      { plant: 'P1', production_line: 'L2' },
    ],
  };
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 0)] });
  setup.line_states.push({
    line: 'L2', state_key: setupState('GREEN'), signature_version: 1,
    source: 'manual', reason: 'compatible second-line state',
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(snapshot, dueDateBounds(setup));

    assert.deepEqual(result.patches.map(patch => patch.id), ['compatibility-enabled-blue'], `${label} still evaluates L2`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => (
      edge.line === 'L1' && edge.reason === 'setup-compatibility-disabled'
    )));
    assert.ok(result.explanation.some(reason => (
      reason.line === 'L1'
      && reason.code === 'setup-incompatible'
      && reason.message.includes('Tooling signature differs on this line')
    )));
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
      id: 'missing-successor-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'missing-successor-predecessor-red', successor_order_id: 'deleted-successor-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'the successor was removed from this line',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([unrelated, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), [
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
  // This fails if the early initial-state guard exits before surfacing an
  // active override whose successor was deleted from the immutable line
  // snapshot. The line remains unchanged, but the binding cannot disappear.
  const remaining = scheduledTask('missing-successor-no-state-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({
    current: null,
    overrides: [{
      id: 'missing-successor-no-state-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'missing-successor-no-state-red', successor_order_id: 'deleted-successor-no-state-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'the successor was removed from this line',
    }],
  });

  const result = SetupScheduler.evaluateDueDateFirst(setupSnapshot([remaining]), dueDateBounds(setup));

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, ['L1']);
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
      id: 'spt-pair-active-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'spt-pair-long-red', successor_order_id: 'spt-pair-short-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected SPT occurrence',
    }],
  });

  const result = SetupScheduler.evaluateSptWithSetup(
    setupSnapshot([successor, predecessor]),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches.map(patch => patch.id), ['spt-pair-long-red', 'spt-pair-short-blue']);
  assert.deepEqual(result.unchangedLines, []);
});

test('setup-aware evaluators defer an uncovered pre-fixed free transition to a covered fixed outgoing state', () => {
  // This fails if a free RED due before fixed BLUE is tried only against the
  // initial GREEN state. GREEN -> RED is deliberately uncovered, while
  // GREEN -> BLUE and BLUE -> RED are covered; preserving the fixed run and
  // evaluating RED after it is the only fully-covered sequence.
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
      setupSnapshot([red, fixedBlue], { fixedIds: ['covered-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.equal(patchFor(result, 'covered-fallback-fixed-blue'), undefined, `${label} never patches the fixed run`);
    assert.equal(patchFor(result, 'covered-fallback-red').changes.start_date.getTime(), at('2026-08-03T10:00:00').getTime(),
      `${label} evaluates the deferred RED order from fixed BLUE's outgoing state`);
    assert.deepEqual(result.unchangedLines, []);
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
      setupSnapshot([later, completedAnchor]),
      dueDateBounds(setup, { now: at('2026-08-03T11:00:00') }),
    );

    assert.equal(patchFor(result, 'unknown-state-horizon-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime(),
      `${label} honors caller now after retaining an old physical anchor`);
  }
});

test('setup-aware evaluators remain unchanged when unknown initial state has no usable scheduled anchor', () => {
  // This fails if the preservation path invents a starting state from an
  // unscheduled order. Without a valid interval and complete state there is
  // no safe physical predecessor for later setup-aware scheduling.
  const onlyUnscheduled = scheduledTask('unknown-state-no-anchor-red', 1, 'RED', '2026-08-03T10:00:00');
  const setup = setupTruth({ current: null, rows: [setupRow('GREEN', 'RED', 0)] });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([onlyUnscheduled]), dueDateBounds(setup));

    assert.deepEqual(result.patches, [], `${label} does not invent an initial state`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => edge.reason === 'initial-state-unknown'));
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
      id: 'unknown-state-stale-predecessor', line: 'L1', signature_version: 1,
      predecessor_order_id: 'deleted-predecessor-green', successor_order_id: 'unknown-state-stale-successor-red',
      predecessor_state_key: setupState('GREEN'), successor_state_key: setupState('RED'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'predecessor removed before planning',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([successor, anchor]), dueDateBounds(setup));

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

    assert.deepEqual(result.patches, [], `${label} must not bypass the true first scheduled order`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => (
      edge.successorOrderId === 'unknown-state-unusable-first'
      && edge.reason === 'initial-state-unknown'
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
      id: 'unknown-no-anchor-stale-predecessor', line: 'L1', signature_version: 1,
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

    assert.deepEqual(result.patches, [], `${label} cannot schedule without a physical anchor`);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'deleted-no-anchor-predecessor'
      && edge.successorOrderId === 'unknown-no-anchor-stale-successor-red'
      && edge.reason === 'override-inactive'
    )), `${label} retains the stale predecessor diagnostic without an anchor`);
  }
});

test('setup-aware evaluators defer a covered pre-fixed order when its outgoing fixed transition is uncovered', () => {
  // Production change caught: removing the outgoing-boundary fallback leaves
  // a fully covered BLUE -> RED route undiscovered after RED -> fixed BLUE is
  // rejected. The excluded uncovered edge remains a candidate diagnostic.
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
      setupSnapshot([red, fixedBlue], { fixedIds: ['outgoing-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );
    const redPatch = patchFor(result, 'outgoing-fallback-red');

    assert.equal(patchFor(result, 'outgoing-fallback-fixed-blue'), undefined, `${label} never patches fixed BLUE`);
    assert.ok(redPatch, `${label} finds the fully covered post-fixed fallback`);
    assert.equal(redPatch.changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime(),
      `${label} moves RED to the covered BLUE outgoing state`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'outgoing-fallback-red'
      && edge.successorOrderId === 'outgoing-fallback-fixed-blue'
      && edge.reason === 'No version-matched setup transition covers this state pair'
    )), `${label} retains the rejected uncovered edge as a diagnostic`);
  }
});

test('setup-aware evaluators defer a covered pre-fixed order when its setup cannot fit before fixed work', () => {
  // Production change caught: accepting any covered RED -> BLUE edge ignores
  // whether its required 30-minute setup actually fits before fixed BLUE.
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
      setupSnapshot([red, fixedBlue], { fixedIds: ['capacity-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );
    const redPatch = patchFor(result, 'capacity-fallback-red');

    assert.equal(patchFor(result, 'capacity-fallback-fixed-blue'), undefined, `${label} preserves fixed BLUE`);
    assert.ok(redPatch, `${label} finds the post-fixed capacity fallback`);
    assert.equal(redPatch.changes.start_date.getTime(), at('2026-08-03T10:15:00').getTime(),
      `${label} moves RED after BLUE when the pre-fixed setup cannot fit`);
    assert.deepEqual(result.unchangedLines, []);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'capacity-fallback-red'
      && edge.successorOrderId === 'capacity-fallback-fixed-blue'
      && edge.reason === 'incoming-fixed-setup-infeasible'
    )), `${label} retains the rejected short incoming setup diagnostic`);
  }
});

test('setup-aware evaluators retain a feasible pre-fixed prefix when only the trailing suffix conflicts with fixed setup', () => {
  // Production change caught: a fallback that always empties the whole
  // fragment discards A even though A -> fixed BLUE is covered. Only trailing
  // B belongs after BLUE; no active pair may be split by this behavior.
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
      setupSnapshot([b, fixedBlue, a], { fixedIds: ['suffix-fallback-fixed-blue'] }),
      dueDateBounds(setup),
    );

    assert.equal(patchFor(result, 'suffix-fallback-a-yellow').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
      `${label} preserves the feasible pre-fixed prefix`);
    assert.equal(patchFor(result, 'suffix-fallback-b-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime(),
      `${label} defers only the problematic suffix`);
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
      id: 'anchor-target-stale-override', line: 'L1', signature_version: 1,
      predecessor_order_id: 'anchor-target-later-red', successor_order_id: 'anchor-target-blue',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('BLUE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'later work cannot precede the preserved anchor',
    }],
  });

  for (const [label, evaluate] of [
    ['Due-date-first', SetupScheduler.evaluateDueDateFirst],
    ['SPT', SetupScheduler.evaluateSptWithSetup],
  ]) {
    const result = evaluate(setupSnapshot([laterRed, anchor]), dueDateBounds(setup));

    assert.equal(patchFor(result, 'anchor-target-blue'), undefined, `${label} preserves BLUE as the physical anchor`);
    assert.equal(patchFor(result, 'anchor-target-later-red').changes.start_date.getTime(), at('2026-08-03T09:00:00').getTime(),
      `${label} still schedules covered BLUE -> RED work safely`);
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
      id: 'early-exit-stale-fixed', line: 'L1', signature_version: 1,
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
      setupSnapshot([fixedRed, anchor], { fixedIds: ['early-exit-fixed-red'] }),
      dueDateBounds(setup),
    );

    assert.deepEqual(result.patches, [], `${label} retains the failed fixed boundary`);
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
      reason.code === 'initial-state-unknown' && reason.taskId === 'early-exit-anchor-blue'
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
    lines: [{ plant: 'P1', production_line: 'L1' }],
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
    lines: [{ plant: 'P1', production_line: 'L1' }],
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
      setupSnapshot([red, fixedBlue], { fixedIds: ['bounded-horizon-fixed-blue'] }),
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
    );

    assert.deepEqual(result.patches, [], `${label} does not emit work beyond the caller horizon`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => (
      edge.successorOrderId === 'bounded-horizon-red' && edge.reason === 'trailing-fragment-unadmitted'
    )), `${label} reports the bounded terminal admission failure`);
  }
});

test('due-date fallback retains a covered non-policy component before fixed work', () => {
  // This fails when fixed-boundary fallback considers only suffixes of the
  // policy/due base order: RED then BLUE is invalid, but BLUE can legally run
  // before fixed YELLOW and RED can run immediately after it. Deferring both
  // creates avoidable lateness, so the detached due-date evaluator must test
  // the feasible retained component candidate through its normal search.
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
    setupSnapshot([red, fixedYellow, blue], { fixedIds: ['fallback-choice-fixed-yellow'] }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'fallback-choice-fixed-yellow'), undefined, 'fixed YELLOW stays immutable');
  assert.equal(patchFor(result, 'fallback-choice-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'covered BLUE stays in the pre-fixed fragment');
  assert.equal(patchFor(result, 'fallback-choice-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime(),
    'only the invalid RED suffix moves past fixed YELLOW');
  assert.deepEqual(result.unchangedLines, []);
  assert.ok(result.missingEdges.some(edge => (
    edge.predecessorOrderId === 'fallback-choice-red'
    && edge.successorOrderId === 'fallback-choice-fixed-yellow'
    && edge.reason === 'No version-matched setup transition covers this state pair'
  )), 'the rejected uncovered RED -> fixed YELLOW edge remains visible');
  const rejectedReasons = result.explanation.filter(reason => (
    reason.code === 'rejected-uncovered-transition' && reason.taskId === 'fallback-choice-fixed-yellow'
  ));
  assert.equal(rejectedReasons.length, 1, 'the rejected fallback edge has one concise planner explanation');
});

test('due-date final-boundary fallback compares complete candidates before local admission', () => {
  // The two safe fallback paths retain different amounts of work before the
  // fixed run. BLUE alone leaves less pre-fixed work than protected RED ->
  // ORANGE, but BLUE is the higher policy tier and must win once each route is
  // evaluated through its deferred continuation. A local patches.length sort
  // incorrectly selects RED -> ORANGE before fixed work.
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
      id: 'complete-fallback-protected-red-orange', line: 'L1', signature_version: 1,
      predecessor_order_id: 'complete-fallback-red', successor_order_id: 'complete-fallback-orange',
      predecessor_state_key: setupState('RED'), successor_state_key: setupState('ORANGE'),
      standard_min: 0, remaining_min: 0, status: 'active', reason: 'component fixture',
    }],
  });
  const snapshot = setupSnapshot([red, fixed, orange, blue], { fixedIds: ['complete-fallback-fixed-yellow'] });
  snapshot.priorityRankMaps = { '': { colorWheel: { BLUE: 1, RED: 2, ORANGE: 2 } } };

  const result = SetupScheduler.evaluateDueDateFirst(snapshot, dueDateBounds(setup));

  assert.equal(patchFor(result, 'complete-fallback-fixed-yellow'), undefined, 'fixed YELLOW remains immutable');
  assert.deepEqual(result.patches.map(patch => patch.id), [
    'complete-fallback-blue', 'complete-fallback-red', 'complete-fallback-orange',
  ]);
  assert.equal(patchFor(result, 'complete-fallback-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'the higher-priority complete route keeps BLUE before fixed work');
  assert.equal(patchFor(result, 'complete-fallback-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.equal(patchFor(result, 'complete-fallback-orange').changes.start_date.getTime(), at('2026-08-03T11:30:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('due-date final-boundary fallback considers non-contiguous component deferrals', () => {
  // This fails when the fallback considers only singleton and suffix
  // deferrals. Only BLUE can reach fixed YELLOW, while RED and ORANGE must
  // wait together after it; retaining BLUE avoids one otherwise late order.
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
    setupSnapshot([red, fixedYellow, blue, orange], { fixedIds: ['non-contiguous-fallback-fixed-yellow'] }),
    dueDateBounds(setup, { iterationCap: 512 }),
  );

  assert.equal(patchFor(result, 'non-contiguous-fallback-fixed-yellow'), undefined, 'fixed YELLOW remains immutable');
  assert.equal(patchFor(result, 'non-contiguous-fallback-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime(),
    'BLUE remains before fixed YELLOW while the non-contiguous RED/ORANGE pair defers');
  assert.equal(patchFor(result, 'non-contiguous-fallback-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.equal(patchFor(result, 'non-contiguous-fallback-orange').changes.start_date.getTime(), at('2026-08-03T11:30:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
});

test('due-date earlier fixed-boundary fallback fails closed when multiple local routes are feasible', () => {
  // Each one-order prefix can enter the first fixed YELLOW run, but later
  // fixed boundaries make it unsafe to rank those local prefixes without a
  // full branching planner. The detached evaluator must preserve the line
  // rather than promote admitted work above the documented full objective.
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
      fixedIds: ['ambiguous-earlier-fixed-yellow', 'ambiguous-earlier-fixed-purple'],
    }),
    dueDateBounds(setup),
  );

  assert.deepEqual(result.patches, []);
  assert.deepEqual(result.unchangedLines, ['L1']);
  assert.ok(result.explanation.some(reason => (
    reason.code === 'fixed-boundary-fallback-ambiguous'
    && reason.taskId === 'ambiguous-earlier-fixed-yellow'
  )), 'the planner explains why it did not choose between local fallback routes');
});

test('due-date earlier fixed-boundary fallback proceeds when exactly one local route is feasible', () => {
  // The same two-boundary shape is safe when only BLUE can enter first fixed
  // YELLOW. RED is then evaluated normally between YELLOW and PURPLE.
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
      fixedIds: ['unique-earlier-fixed-yellow', 'unique-earlier-fixed-purple'],
    }),
    dueDateBounds(setup),
  );

  assert.equal(patchFor(result, 'unique-earlier-fixed-yellow'), undefined);
  assert.equal(patchFor(result, 'unique-earlier-fixed-purple'), undefined);
  assert.equal(patchFor(result, 'unique-earlier-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
  assert.equal(patchFor(result, 'unique-earlier-red').changes.start_date.getTime(), at('2026-08-03T11:00:00').getTime());
  assert.deepEqual(result.unchangedLines, []);
  assert.equal(result.explanation.some(reason => reason.code === 'fixed-boundary-fallback-ambiguous'), false);
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
        id: 'post-horizon-chain-free-pair', line: 'L1', signature_version: 1,
        predecessor_order_id: 'post-horizon-chain-blue', successor_order_id: 'post-horizon-chain-red',
        predecessor_state_key: setupState('BLUE'), successor_state_key: setupState('RED'),
        standard_min: 0, remaining_min: 0, status: 'active', reason: 'protected free component fixture',
      }],
    },
  ];

  for (const fixture of cases) {
    const override = {
      id: `post-horizon-${fixture.label}`, line: 'L1', signature_version: 1,
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
        setupSnapshot(fixture.tasks, { fixedIds: [fixture.tasks.at(-1).id] }),
        dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
      );

      assert.deepEqual(result.patches, [], `${mode} preserves ${fixture.label}`);
      assert.deepEqual(result.unchangedLines, ['L1']);
      assert.ok(result.missingEdges.some(edge => (
        edge.predecessorOrderId === fixture.predecessorOrderId
        && edge.successorOrderId === fixture.successorOrderId
        && edge.reason === 'protected-fixed-boundary-outside-horizon'
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
        id: `post-horizon-stale-${fixture.label}`, line: 'L1', signature_version: 1,
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
        setupSnapshot(fixture.tasks, { fixedIds: [fixture.fixedId] }),
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
        && edge.reason === 'protected-fixed-boundary-outside-horizon'
      )), false, `${mode} does not protect a stale ${fixture.label} binding`);
    }
  }
});

test('setup-aware evaluators retain a fixed order at horizonEnd as the terminal incoming boundary', () => {
  // This fails when `start >= horizonEnd` removes a fixed order whose incoming
  // setup still belongs to the candidate horizon. A -> fixed BLUE is missing,
  // so A must not be emitted merely because BLUE processing continues later.
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
      setupSnapshot([red, fixedBlue], { fixedIds: ['horizon-terminal-fixed-blue'] }),
      dueDateBounds(setup, { horizonEnd: at('2026-08-03T10:00:00') }),
    );

    assert.deepEqual(result.patches, [], `${label} does not schedule RED through the terminal boundary`);
    assert.deepEqual(result.unchangedLines, ['L1']);
    assert.ok(result.missingEdges.some(edge => (
      edge.predecessorOrderId === 'horizon-terminal-red'
      && edge.successorOrderId === 'horizon-terminal-fixed-blue'
      && edge.reason === 'No version-matched setup transition covers this state pair'
    )), `${label} reports RED -> fixed BLUE as uncovered`);
  }
});

test('due-date search retains uncovered rejected alternatives for exact and greedy paths', () => {
  // This fails when a successful B -> A route discards the observed failed
  // A -> B alternative. The result must remain feasible while preserving one
  // deduplicated explanation and edge for planner review; SPT is deliberately
  // excluded because it does not explore alternate orders.
  const red = scheduledTask('rejected-edge-red', 1, 'RED', '2026-08-03T08:30:00');
  const blue = scheduledTask('rejected-edge-blue', 1, 'BLUE', '2026-08-03T09:00:00');
  const setup = setupTruth({ rows: [
    setupRow('GREEN', 'RED', 0), setupRow('GREEN', 'BLUE', 0), setupRow('BLUE', 'RED', 0),
  ] });

  for (const [label, threshold] of [['exact', 6], ['greedy', 0]]) {
    const result = SetupScheduler.evaluateDueDateFirst(
      setupSnapshot([red, blue]),
      dueDateBounds(setup, { exactSearchThreshold: threshold }),
    );
    const rejectedEdges = result.missingEdges.filter(edge => (
      edge.predecessorOrderId === 'rejected-edge-red'
      && edge.successorOrderId === 'rejected-edge-blue'
      && edge.reason === 'No version-matched setup transition covers this state pair'
    ));

    assert.deepEqual(result.unchangedLines, [], `${label} retains the covered B -> A route`);
    assert.equal(patchFor(result, 'rejected-edge-blue').changes.start_date.getTime(), at('2026-08-03T08:00:00').getTime());
    assert.equal(rejectedEdges.length, 1, `${label} exposes one rejected uncovered edge`);
    assert.ok(result.explanation.some(reason => (
      reason.code === 'rejected-uncovered-transition' && reason.taskId === 'rejected-edge-blue'
    )), `${label} supplies a concise rejected-edge explanation`);
  }
});
