import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateSchedule } from '../../web/setup-scheduler.mjs';
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
