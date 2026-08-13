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
