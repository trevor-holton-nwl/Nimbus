import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../web/calendar/calendar-engine.mjs';
import { Engine } from '../../web/optimization/engine.mjs';
import { Store } from '../../web/platform/store.mjs';

const require = createRequire(import.meta.url);
const Core = require('../../web/nimbus-compute-core.js');
globalThis.NimbusComputeCore = Core;
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

test('scheduleIntervals returns only the productive pieces of a split order', () => {
  const task = {
    id: 'split-1',
    start_date: new Date('2026-08-12T08:00:00Z'),
    end_date: new Date('2026-08-13T10:00:00Z'),
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-12T08:00:00Z'), endDate: new Date('2026-08-12T20:00:00Z') },
      { sequence: 2, startDate: new Date('2026-08-13T08:00:00Z'), endDate: new Date('2026-08-13T10:00:00Z') },
    ],
  };

  const intervals = Core.scheduleIntervals(task);

  assert.deepEqual(intervals.map(interval => [interval.start.toISOString(), interval.end.toISOString()]), [
    ['2026-08-12T08:00:00.000Z', '2026-08-12T20:00:00.000Z'],
    ['2026-08-13T08:00:00.000Z', '2026-08-13T10:00:00.000Z'],
  ]);
});

test('split pieces aggregate their actual durations in overload alerts', () => {
  const first = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  first.setHours(15, 0, 0, 0);
  const firstEnd = new Date(first); firstEnd.setHours(16, 0, 0, 0);
  const second = new Date(first); second.setDate(second.getDate() + 1); second.setHours(7, 30, 0, 0);
  const secondEnd = new Date(second); secondEnd.setHours(16, 0, 0, 0);
  const split = {
    id: 'split-overload-hours', MACHINE: 'SFN11', RUN_TIME: 9.5,
    start_date: first, end_date: secondEnd,
    scheduleSegments: [
      { sequence: 1, startDate: first, endDate: firstEnd },
      { sequence: 2, startDate: second, endDate: secondEnd },
    ],
  };
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [7.5, 16]]));

  const alerts = Core.computeAlerts({
    tasks: [split], lineSettings: { SFN11: { plant: null } }, calendars: { SFN11: { workHours } },
    plants: {}, blocks: [], plantBlocks: [], masterData: { lines: [] }, dismissed: [], opts: {},
  }).alerts;

  assert.deepEqual(alerts.filter(alert => alert.type === 'overload'), []);
});

test('split pieces consume capacity without making the parent gap overlap another order', () => {
  const first = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  first.setHours(8, 0, 0, 0);
  const firstEnd = new Date(first); firstEnd.setHours(20, 0, 0, 0);
  const second = new Date(first); second.setDate(second.getDate() + 1); second.setHours(8, 0, 0, 0);
  const secondEnd = new Date(second); secondEnd.setHours(10, 0, 0, 0);
  const inGap = new Date(first); inGap.setHours(21, 0, 0, 0);
  const gapEnd = new Date(inGap.getTime() + 60 * 60 * 1000);
  const split = {
    id: 'split-capacity', MACHINE: 'L', RUN_TIME: 14,
    start_date: first, end_date: secondEnd,
    scheduleSegments: [
      { sequence: 1, startDate: first, endDate: firstEnd },
      { sequence: 2, startDate: second, endDate: secondEnd },
    ],
  };
  const gapOrder = { id: 'gap-order', MACHINE: 'L', RUN_TIME: 1, start_date: inGap, end_date: gapEnd };
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const base = {
    lineSettings: { L: { plant: null } }, calendars: { L: { workHours } }, plants: {},
    blocks: [], plantBlocks: [], masterData: { lines: [] },
  };

  const { matrix } = Core.computeUtilization({
    ...base, tasks: [split], startMs: new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime(), days: 2,
  });
  const alerts = Core.computeAlerts({ ...base, tasks: [split, gapOrder], dismissed: [], opts: {} }).alerts;

  assert.equal(matrix.L[Core.dayKey(first)].scheduled, 12);
  assert.equal(matrix.L[Core.dayKey(second)].scheduled, 2);
  assert.equal(alerts.filter(alert => alert.type === 'overlap').length, 0);
});

test('a setup interval before a split successor occupies capacity and reports a fixed-boundary shortfall', () => {
  const first = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  first.setHours(8, 0, 0, 0);
  const predecessorEnd = new Date(first); predecessorEnd.setHours(9, 0, 0, 0);
  const successorStart = new Date(first); successorStart.setHours(10, 0, 0, 0);
  const successorFirstEnd = new Date(first); successorFirstEnd.setHours(12, 0, 0, 0);
  const second = new Date(first); second.setDate(second.getDate() + 1); second.setHours(8, 0, 0, 0);
  const successorEnd = new Date(second); successorEnd.setHours(10, 0, 0, 0);
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const base = {
    lineSettings: { L: { plant: null } }, calendars: { L: { workHours } }, plants: {},
    blocks: [], plantBlocks: [], masterData: { lines: [] },
    setup: {
      intervals: [{
        line: 'L', scope: 'P/L', predecessorOrderId: 'fixed-predecessor', successorOrderId: 'split-successor',
        start: new Date(successorStart.getTime() - 90 * 60000), end: successorStart, requiredMinutes: 90, availableMinutes: 60,
      }], diagnostics: [],
    },
  };
  const predecessor = { id: 'fixed-predecessor', firmed: true, MACHINE: 'L', RUN_TIME: 1, start_date: first, end_date: predecessorEnd };
  const successor = {
    id: 'split-successor', MACHINE: 'L', RUN_TIME: 4, start_date: successorStart, end_date: successorEnd,
    scheduleSegments: [
      { sequence: 1, startDate: successorStart, endDate: successorFirstEnd },
      { sequence: 2, startDate: second, endDate: successorEnd },
    ],
  };
  const { matrix } = Core.computeUtilization({ ...base, tasks: [predecessor, successor], startMs: first.getTime(), days: 2 });
  const alerts = Core.computeAlerts({ ...base, tasks: [predecessor, successor], dismissed: [], opts: {} }).alerts;

  assert.equal(matrix.L[Core.dayKey(first)].scheduled, 4.5);
  assert.equal(matrix.L[Core.dayKey(second)].scheduled, 2);
  assert.deepEqual(alerts.filter(alert => alert.type === 'setup-violated').map(alert => alert.shortMinutes), [30]);
});

test('partial_allowed allocates a 14-hour order into today plus tomorrow', () => {
  const plant = 'P-SPLIT';
  const line = 'L-SPLIT';
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 20]]));
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'partial_allowed' }],
    lines: [{ machine: line, plant }],
  }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, workHours, 'test');
  for (const day of Object.keys(workHours).map(Number)) Store.setPlantWorkHours(plant, day, workHours[day], 'test');

  Calendar._beginRun(plant);
  try {
    const allocation = Calendar.allocateRuntime(line, new Date('2026-08-12T08:00:00'), 14 * 60, 'partial_allowed');
    assert.equal(allocation.kind, 'allocated');
    assert.deepEqual(allocation.scheduleSegments.map(segment => [segment.startDate.getHours(), segment.endDate.getHours()]), [
      [8, 20], [8, 10],
    ]);
    assert.equal(allocation.scheduleSegments.length, 2);
  } finally {
    Calendar._endRun();
  }
});

test('overlong_only keeps ordinary orders whole and adjusts a short split tail to 30 minutes', () => {
  const plant = 'P-POLICY-SPLIT';
  const line = 'L-POLICY-SPLIT';
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 10]]));
  const day = new Date('2026-08-12T08:00:00');
  const blackoutStart = new Date('2026-08-12T08:45:00');
  const blackoutEnd = new Date('2026-08-12T10:00:00');
  Store.replaceBlocks([{ id: 'tail-block', plant, line, start: blackoutStart, end: blackoutEnd, reason: 'test' }], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'overlong_only' }],
    lines: [{ machine: line, plant }],
  }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, workHours, 'test');
  for (const number of Object.keys(workHours).map(Number)) Store.setPlantWorkHours(plant, number, workHours[number], 'test');

  Calendar._beginRun(plant);
  try {
    const ordinary = Calendar.allocateRuntime(line, new Date('2026-08-12T08:30:00'), 60, 'overlong_only');
    assert.equal(ordinary.kind, 'allocated');
    assert.deepEqual(ordinary.scheduleSegments, [], 'a normally fittable order waits for one whole interval');
    assert.equal(ordinary.start.getDate(), 13);

    const split = Calendar.allocateRuntime(line, day, 70, 'partial_allowed');
    assert.equal(split.kind, 'allocated');
    assert.deepEqual(split.scheduleSegments.map(segment => (
      (segment.endDate.getTime() - segment.startDate.getTime()) / (60 * 1000)
    )), [40, 30]);
  } finally {
    Calendar._endRun();
  }
});

test('Calendar.placeWithSetup uses effective calendar fragments and keeps setup out of productive segments', () => {
  // This fails if the adapter bypasses Calendar's blackout-aware windows, puts
  // setup alone at shift end, or turns a setup occurrence into a persisted
  // productive child segment.
  const plant = 'P-SETUP-ADAPTER';
  const line = 'L-SETUP-ADAPTER';
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 10]]));
  Store.replaceBlocks([{
    id: 'setup-tail', plant, line,
    start: new Date('2026-08-12T08:45:00'), end: new Date('2026-08-12T10:00:00'), reason: 'test',
  }], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'partial_allowed' }],
    lines: [{ machine: line, plant }],
  }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, workHours, 'test');
  for (const day of Object.keys(workHours).map(Number)) Store.setPlantWorkHours(plant, day, workHours[day], 'test');

  assert.equal(typeof Calendar.placeWithSetup, 'function');
  Calendar._beginRun(plant);
  try {
    const result = Calendar.placeWithSetup(line, {
      earliestStart: new Date('2026-08-12T08:00:00'),
      runtimeMinutes: 40,
      setup: { kind: 'resolved', minutes: 20 },
      policy: 'partial_allowed',
    });
    assert.equal(result.kind, 'placed');
    assert.equal(+result.setup.start, +new Date('2026-08-13T08:00:00'));
    assert.equal(+result.setup.end, +new Date('2026-08-13T08:20:00'));
    assert.deepEqual(result.productiveSegments.map(segment => [segment.start, segment.end]), [[
      new Date('2026-08-13T08:20:00'), new Date('2026-08-13T09:00:00'),
    ]]);
    assert.equal(result.productiveSegments[0].scheduleSegments, undefined,
      'setup placement must not alter the persisted order_schedule_segments child shape');
  } finally {
    Calendar._endRun();
  }
});

test('standard scheduling regenerates a logical parent as one split aggregate', () => {
  const plant = 'P-STRATEGY-SPLIT';
  const line = 'L-STRATEGY-SPLIT';
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 20]]));
  const horizonStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  horizonStart.setHours(8, 0, 0, 0);
  const horizonEnd = new Date(horizonStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.replaceFirmedIds(new Set(), 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'partial_allowed' }],
    lines: [{ machine: line, plant }],
  }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, workHours, 'test');
  for (const day of Object.keys(workHours).map(Number)) Store.setPlantWorkHours(plant, day, workHours[day], 'test');
  Store.setSelectedPlant(plant, 'test');
  Store.setTasks([{
    id: 'strategy-split', plant, PLANT: plant, MACHINE: line, RUN_TIME: 14,
    start_date: new Date(horizonStart.getTime() - 2 * 60 * 60 * 1000),
    end_date: horizonStart,
  }], 'test');

  Engine.runAndApply('spt', {
    plant, lines: [line], startDate: horizonStart, endDate: horizonEnd,
    respectFirmed: true, respectCalendar: true,
  });

  const scheduled = Store.tasks['strategy-split'];
  assert.equal(scheduled.scheduleSegments?.length, 2);
  assert.equal(scheduled.start_date?.getHours(), 8);
  assert.equal(scheduled.end_date?.getHours(), 10);
});

test('a runtime mismatch remains diagnostic until calendar-based reconciliation repairs the parent', () => {
  const plant = 'P-RUNTIME-REPAIR';
  const line = 'L-RUNTIME-REPAIR';
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 20]]));
  const start = new Date('2026-08-12T08:00:00');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test');
  Store.replacePlants({}, 'test');
  Store.setMasterData({
    plants: [{ subnetwork: 'SN', plant, timezone: 'America/New_York', split_order_policy: 'partial_allowed' }],
    lines: [{ machine: line, plant }],
  }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, workHours, 'test');
  for (const day of Object.keys(workHours).map(Number)) Store.setPlantWorkHours(plant, day, workHours[day], 'test');
  Store.setTasks([{
    id: 'runtime-repair', PLANT: plant, MACHINE: line, RUN_TIME: 14,
    start_date: start, end_date: new Date('2026-08-12T20:00:00'), runtime_schedule_mismatch: true,
  }], 'test');

  const before = Core.computeAlerts({
    tasks: Store.tasksArr, calendars: Store.calendars, plants: Store.plants,
    lineSettings: Store.lineSettings, masterData: Store.masterData, blocks: [], plantBlocks: [], dismissed: [], opts: {},
  }).alerts;
  assert.ok(before.some(alert => alert.type === 'runtime-schedule-mismatch'));

  Engine.reconcileRuntimeSchedules(plant);
  const repaired = Store.tasks['runtime-repair'];
  assert.equal(repaired.runtime_schedule_mismatch, false);
  assert.equal(repaired.scheduleSegments?.length, 2);
});

test('a runtime mismatch stays visible even when its prior schedule is already in the past', () => {
  const workHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
  const alerts = Core.computeAlerts({
    tasks: [{
      id: 'historic-runtime-mismatch', MACHINE: 'L-HISTORIC', RUN_TIME: 14,
      start_date: new Date('2020-01-02T08:00:00'), end_date: new Date('2020-01-02T20:00:00'),
      runtime_schedule_mismatch: true,
    }],
    lineSettings: { 'L-HISTORIC': { plant: null } },
    calendars: { 'L-HISTORIC': { workHours } }, plants: {}, blocks: [], plantBlocks: [],
    masterData: { lines: [] }, dismissed: [], opts: {},
  }).alerts;

  assert.ok(alerts.some(alert => alert.type === 'runtime-schedule-mismatch'));
});
