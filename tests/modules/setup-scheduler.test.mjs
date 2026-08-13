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
    dueDateBounds(setupTruth({ rows: allEdges }), { iterationCap: 1 }),
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
