import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Utilization } from '../../../frontend/insights/services.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

const Core = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.NimbusComputeCore = Core;
const date = (clock, day = '2031-01-06') => new Date(`${day}T${clock}:00`);
const hours = (start, end) => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [start, end]]));
const blackout = (id, start, end, plant = 'P1', line = 'L1') => ({ id, start: date(start), end: date(end), plant, line });

beforeEach(t => {
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({}) }));
  Calendar._endRun();
  Store.setTasks([], 'test');
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [
    { machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P2' },
  ] }, 'test');
  Store.replaceCalendars({ L1: { workHours: hours(8, 16) }, L2: { workHours: hours(8, 16) } }, 'test');
  Store.replacePlants({ P1: { workHours: hours(0, 24) }, P2: { workHours: hours(0, 24) } }, 'test');
  for (const line of Object.keys(Store.lineSettings)) delete Store.lineSettings[line];
  Store.setLineSetting('L1', { plant: 'P1', capacityBufferHours: 0 }, 'test');
  Store.setLineSetting('L2', { plant: 'P2', capacityBufferHours: 0 }, 'test');
  Store.replaceBlocks([], 'test');
  Store.replacePlantBlocks([], 'test');
  Store.setSelectedPlant('P1', 'test');
  Utilization._cacheClear();
});
afterEach(() => Calendar._endRun());

for (const cached of [false, true]) {
  for (const [label, plant, line, expected] of [
    ['own line', 'P1', 'L1', '11:00'],
    ['own plant with null line', 'P1', null, '11:00'],
    ['another plant with null line', 'P2', null, '09:00'],
    ['another line', 'P2', 'L2', '09:00'],
  ]) {
    test(`${cached ? 'indexed' : 'uncached'} allocation respects ${label} blackout scope`, () => {
      Store.replaceBlocks([blackout('b', '09:00', '11:00', plant, line)], 'test');
      if (cached) Calendar._beginRun('P1');
      const result = Calendar.allocateRuntime('L1', date('09:00'), 60, 'partial_allowed');
      assert.equal(result.kind, 'allocated');
      assert.equal(+result.start, +date(expected));
      assert.equal(+result.end - +result.start, 60 * 60000);
      assert.deepEqual(result.scheduleSegments, []);
    });
  }
}

test('overlapping line and plant blackouts form one capacity loss and one allocation gap', () => {
  Store.replaceBlocks([blackout('line', '09:00', '11:00'), blackout('duplicate', '09:00', '11:00')], 'test');
  Store.replacePlantBlocks([blackout('plant', '10:00', '12:00')], 'test');
  assert.equal(Calendar.dailyCapacityHours('L1', date('00:00')), 5);
  assert.equal(Calendar.dailyCapacityHours('L1', date('00:00'), Calendar._indexCapacityBlocks()), 5);
  const result = Calendar.allocateRuntime('L1', date('08:00'), 180, 'partial_allowed');
  assert.equal(result.kind, 'allocated');
  assert.deepEqual(result.scheduleSegments.map(s => [+s.startDate, +s.endDate]), [
    [+date('08:00'), +date('09:00')], [+date('12:00'), +date('14:00')],
  ]);
});

test('touching blackout endpoints allow production immediately before and after', () => {
  Store.replaceBlocks([blackout('b', '10:00', '11:00')], 'test');
  assert.equal(Calendar.fitsContinuous('L1', date('09:00'), 60 * 60000), true);
  assert.equal(Calendar.fitsContinuous('L1', date('11:00'), 60 * 60000), true);
  assert.equal(Calendar.fitsContinuous('L1', date('09:01'), 60 * 60000), false);
  assert.equal(Calendar.fitsContinuous('L1', date('10:59'), 60 * 60000), false);
});

test('subminute blackout edges round productive segments inward without losing runtime', () => {
  Store.replaceBlocks([{ ...blackout('b', '09:00', '10:00'), start: new Date(+date('09:00') + 30000), end: new Date(+date('10:00') + 10000) }], 'test');
  const result = Calendar.allocateRuntime('L1', date('08:00'), 120, 'partial_allowed');
  assert.equal(result.kind, 'allocated');
  assert.deepEqual(result.scheduleSegments.map(s => [+s.startDate, +s.endDate]), [
    [+date('08:00'), +date('09:00')], [+date('10:01'), +date('11:01')],
  ]);
  assert.equal(result.scheduleSegments.reduce((sum, s) => sum + (+s.endDate - +s.startDate) / 60000, 0), 120);
});

test('plant-line hours intersection controls both available capacity and allocation', () => {
  Store.replacePlants({ P1: { workHours: hours(10, 14) } }, 'test');
  assert.equal(Calendar.dailyCapacityHours('L1', date('00:00')), 4);
  const result = Calendar.allocateRuntime('L1', date('08:00'), 240, 'partial_allowed');
  assert.equal(result.kind, 'allocated');
  assert.equal(+result.start, +date('10:00'));
  assert.equal(+result.end, +date('14:00'));
  assert.deepEqual(result.scheduleSegments, []);
});

test('disjoint plant and line hours yield zero capacity and an unavailable allocation', () => {
  Store.replacePlants({ P1: { workHours: hours(18, 22) } }, 'test');
  assert.equal(Calendar.dailyCapacityHours('L1', date('00:00')), 0);
  assert.deepEqual(Calendar.allocateRuntime('L1', date('08:00'), 60, 'partial_allowed'), { kind: 'unavailable' });
});

test('ending a run releases stale calendar and blackout caches before the next run', () => {
  Calendar._beginRun('P1');
  assert.equal(+Calendar.workWindow('L1', date('12:00'))[0], +date('08:00'));
  Calendar._endRun();
  Store.setCalendar('L1', hours(10, 16), 'test');
  Store.replaceBlocks([blackout('b', '10:00', '11:00')], 'test');
  Calendar._beginRun('P1');
  assert.equal(+Calendar.workWindow('L1', date('12:00'))[0], +date('10:00'));
  const result = Calendar.allocateRuntime('L1', date('08:00'), 60, 'partial_allowed');
  assert.equal(+result.start, +date('11:00'));
});

test('a minute-precise full-shift request one minute late starts next day', () => {
  const result = Calendar.allocateRuntime('L1', date('08:01'), 480, 'overlong_only');
  assert.equal(result.kind, 'allocated');
  assert.equal(+result.start, +date('08:00', '2031-01-07'));
  assert.equal(+result.end, +date('16:00', '2031-01-07'));
});

for (const runtime of [0, -1, NaN, Infinity, 'invalid']) {
  test(`invalid runtime ${String(runtime)} yields bounded failure without touching Store`, () => {
    const before = structuredClone({ calendars: Store.calendars, blocks: Store.blocks, plants: Store.plants, tasks: Store.tasksArr });
    assert.deepEqual(Calendar.allocateRuntime('L1', date('08:00'), runtime, 'partial_allowed'), { kind: 'exhausted' });
    assert.deepEqual({ calendars: Store.calendars, blocks: Store.blocks, plants: Store.plants, tasks: Store.tasksArr }, before);
  });
}

test('an allocated split survives Store normalization and contributes only productive utilization', () => {
  Store.replaceBlocks([blackout('maintenance', '09:00', '12:00')], 'test');
  const result = Calendar.allocateRuntime('L1', date('08:00'), 180, 'partial_allowed');
  assert.equal(result.kind, 'allocated');
  Store.setTasks([{ id: 'a', MACHINE: 'L1', PLANT: 'P1', RUN_TIME: 3, start_date: result.start, end_date: result.end, scheduleSegments: result.scheduleSegments }], 'test');
  const matrix = Utilization.computeMatrix(date('00:00'), 1);
  const row = matrix.L1[Core.dayKey(date('00:00'))];
  assert.equal(row.capacity, 5);
  assert.equal(row.scheduled, 3);
  assert.deepEqual(row.tasks.map(task => task.id), ['a']);
  assert.equal(row.tasks[0], Store.tasks.a);
});

test('calendar and blackout edits invalidate memoized utilization through Store revisions', () => {
  const day = date('00:00');
  const first = Utilization.computeMatrix(day, 1);
  Store.setCalendar('L1', hours(8, 12), 'test');
  const shorter = Utilization.computeMatrix(day, 1);
  assert.notEqual(shorter, first);
  assert.equal(shorter.L1[Core.dayKey(day)].capacity, 4);
  Store.replaceBlocks([blackout('b', '09:00', '11:00')], 'test');
  const blocked = Utilization.computeMatrix(day, 1);
  assert.notEqual(blocked, shorter);
  assert.equal(blocked.L1[Core.dayKey(day)].capacity, 2);
});

// ---- Backward allocation (finish-anchored): the same scope/overlap/rounding rules as the forward tests above ----
const bwOpts = (extra = {}) => ({ floor: date('00:00', '2030-12-01'), minSegmentMinutes: 30, plantTz: null, ...extra });
const bwSummary = r => r.kind !== 'placed' ? r.kind
  : `${Util.fmtDTReadable(r.start)} -> ${Util.fmtDTReadable(r.end)}${r.finishMoved ? ` moved:${r.moveReason}` : ''}`;

for (const cached of [false, true]) {
  for (const [label, plant, line, moved] of [
    ['own line', 'P1', 'L1', true],
    ['own plant with null line', 'P1', null, true],
    ['another plant with null line', 'P2', null, false],
    ['another line', 'P2', 'L2', false],
  ]) {
    test(`${cached ? 'indexed' : 'uncached'} backward allocation respects ${label} blackout scope`, () => {
      Store.replaceBlocks([blackout('b', '11:00', '13:00', plant, line)], 'test');
      if (cached) Calendar._beginRun('P1');
      const result = Calendar.allocateRuntimeBackward('L1', date('12:00'), 60, 'partial_allowed', bwOpts());
      assert.equal(result.kind, 'placed');
      assert.equal(+result.end, +date(moved ? '11:00' : '12:00'));
      assert.equal(+result.start, +date(moved ? '10:00' : '11:00'));
      assert.equal(result.finishMoved, moved);
      assert.equal(result.moveReason, moved ? 'blackout' : undefined);
      assert.deepEqual(result.scheduleSegments, []);
    });
  }
}

test('overlapping line and plant blackouts form one gap for backward allocation too', () => {
  Store.replaceBlocks([blackout('line', '09:00', '11:00'), blackout('duplicate', '09:00', '11:00')], 'test');
  Store.replacePlantBlocks([blackout('plant', '10:00', '12:00')], 'test');
  const result = Calendar.allocateRuntimeBackward('L1', date('14:00'), 180, 'partial_allowed', bwOpts());
  assert.equal(result.kind, 'placed');
  assert.deepEqual(result.scheduleSegments.map(s => [+s.startDate, +s.endDate]), [
    [+date('08:00'), +date('09:00')], [+date('12:00'), +date('14:00')],
  ]);
  assert.equal(+result.start, +date('08:00'));
  assert.equal(+result.end, +date('14:00'));
  assert.equal(result.finishMoved, false);
});

test('backward allocation rounds subminute blackout edges inward without losing runtime', () => {
  Store.replaceBlocks([{ ...blackout('b', '09:00', '10:00'), start: new Date(+date('09:00') + 30000), end: new Date(+date('10:00') + 10000) }], 'test');
  const result = Calendar.allocateRuntimeBackward('L1', date('12:00'), 120, 'partial_allowed', bwOpts({ minSegmentMinutes: 1 }));
  assert.equal(result.kind, 'placed');
  assert.deepEqual(result.scheduleSegments.map(s => [+s.startDate, +s.endDate]), [
    [+date('08:59'), +date('09:00')], [+date('10:01'), +date('12:00')],
  ]);
  assert.equal(result.scheduleSegments.reduce((sum, s) => sum + (+s.endDate - +s.startDate) / 60000, 0), 120);
});

test('touching blackout endpoints: a finish at the blackout start is valid, a finish at its end moves to the start', () => {
  Store.replaceBlocks([blackout('b', '10:00', '11:00')], 'test');
  assert.equal(bwSummary(Calendar.allocateRuntimeBackward('L1', date('10:00'), 60, 'never', bwOpts())), `${Util.fmtDTReadable(date('09:00'))} -> ${Util.fmtDTReadable(date('10:00'))}`);
  assert.equal(bwSummary(Calendar.allocateRuntimeBackward('L1', date('11:00'), 60, 'never', bwOpts())), `${Util.fmtDTReadable(date('09:00'))} -> ${Util.fmtDTReadable(date('10:00'))} moved:blackout`);
});

test('plant-line hours intersection controls backward allocation, and disjoint hours are unavailable', () => {
  Store.replacePlants({ P1: { workHours: hours(10, 14) } }, 'test');
  const result = Calendar.allocateRuntimeBackward('L1', date('16:00'), 240, 'partial_allowed', bwOpts());
  assert.equal(result.kind, 'placed');
  assert.equal(+result.start, +date('10:00'));
  assert.equal(+result.end, +date('14:00'));
  assert.equal(result.moveReason, 'closed_finish');
  Store.replacePlants({ P1: { workHours: hours(18, 22) } }, 'test');
  assert.deepEqual(Calendar.allocateRuntimeBackward('L1', date('16:00'), 60, 'partial_allowed', bwOpts()), { kind: 'unavailable' });
});

test('a minute-precise full-shift request one minute early ends the previous day (backward mirror of the forward boundary test)', () => {
  const result = Calendar.allocateRuntimeBackward('L1', date('15:59'), 480, 'overlong_only', bwOpts());
  assert.equal(result.kind, 'placed');
  assert.equal(+result.start, +date('08:00', '2031-01-05'));
  assert.equal(+result.end, +date('16:00', '2031-01-05'));
  assert.equal(result.moveReason, 'no_slot_at_finish');
});
