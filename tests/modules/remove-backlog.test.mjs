import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar, Engine } from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');
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
    PRODUCTION_LINE: line,
    RUN_TIME: String(hours),
    start_date: at(start),
    end_date: new Date(+at(start) + hours * HOUR),
    BASIC_START_DATE: at('2000-01-01T00:00'),
    BASIC_FINISH_DATE: at('2000-01-01T01:00'),
    fixed: false,
    ...extra,
  };
}

function seed({ tasks = [], hours = allDays(8, 16), lineName = line, splitOrderPolicy = 'never' } = {}) {
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.replaceFixedIds(new Set(), 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: splitOrderPolicy }],
    lines: [{ production_line: lineName, plant }],
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

test('Engine uses RUN_TIME and moves a fixed order without clearing its fixed state', () => {
  const fixed = task('fixed-past', '2026-08-12T06:00', 3, { fixed: true });
  seed({ tasks: [fixed] });
  const result = Engine.removeBacklog(opts());
  const change = patch(result, 'fixed-past').changes;
  assert.equal(+change.end_date - +change.start_date, 3 * HOUR);
  assert.ok(Store.fixedIds.has('fixed-past'));
  assert.equal(result.diagnostics.fixedMoved, 1);
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
      { ...task('other', '2026-08-12T06:00', 1), id: 'other', PRODUCTION_LINE: otherLine },
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

test('Engine rejects a missing plant timezone and never mutates schedule', () => {
  seed({ tasks: [task('past', '2026-08-12T06:00', 1)] });
  Store.setMasterData({ plants: [{ subnetwork: 'SN', plant }], lines: [{ production_line: line, plant }] }, 'test');
  assert.throws(() => Engine.removeBacklog(opts()), /timezone/i);
});
