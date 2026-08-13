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
  const blue = scheduledTask('signature-incompatible-blue', 1, 'BLUE', '2026-08-03T10:00:00');
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
