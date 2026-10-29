import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window ??= {};
globalThis.document ??= { getElementById: () => null };

const plant = 'PLANNER-DAY';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (day, hour) => new Date(`2035-08-${day}T${hour}:00`);
const shift = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
const task = (id, machine, runtime, due) => ({
  id, PLANT: plant, MACHINE: machine, RUN_TIME: runtime,
  original_end_date: when('06', due), start_date: null, end_date: null,
  planning_status: 'needs_planning', scheduleSegments: [], user_scheduled: false,
});

function startDay(tasks) {
  const prior = {
    masterData: Store.masterData, selectedPlant: Store.selectedPlant,
    tasks: structuredClone(Store.tasksArr), calendars: structuredClone(Store.calendars),
    plants: structuredClone(Store.plants), blocks: structuredClone(Store.blocks),
    setup: Store.setupSnapshot, firmed: new Set(Store.firmedIds),
    frozen: Store.frozenHorizonEnd, offset: Store.serverOffsetMs,
  };
  Store.serverOffsetMs = +when('06', '07:00') - Date.now();
  Store.setMasterData({
    plants: [{ plant, timezone: tz, split_order_policy: 'never' }],
    lines: [{ plant, machine: 'LINE-A' }, { plant, machine: 'LINE-B' }],
  }, 'day-test');
  Store.setSelectedPlant(plant, 'day-test');
  Store.replaceCalendars({ 'LINE-A': { workHours: shift }, 'LINE-B': { workHours: shift } }, 'day-test');
  Store.replacePlants({ [plant]: { workHours: shift } }, 'day-test');
  Store.replaceBlocks([], 'day-test');
  Store.replaceSetupSnapshot(null, 'day-test');
  Store.replaceFirmedIds(new Set(), 'day-test');
  Store.setFrozenHorizonEnd(null, 'day-test');
  Store.setTasks(tasks, 'day-test');
  return () => {
    Store.setTasks(prior.tasks, 'day-test');
    Store.replaceFirmedIds(prior.firmed, 'day-test');
    Store.replaceBlocks(prior.blocks, 'day-test');
    Store.replaceCalendars(prior.calendars, 'day-test');
    Store.replacePlants(prior.plants, 'day-test');
    Store.replaceSetupSnapshot(prior.setup, 'day-test');
    Store.setFrozenHorizonEnd(prior.frozen, 'day-test');
    Store.setMasterData(prior.masterData, 'day-test');
    Store.setSelectedPlant(prior.selectedPlant, 'day-test');
    Store.serverOffsetMs = prior.offset;
  };
}

function optimize(mode) {
  Engine.runAndApply(mode, {
    plant, respectFirmed: true, respectCalendar: true,
    runNow: when('06', '08:00'), startDate: when('06', '08:00'), endDate: when('07', '18:00'),
  });
}

function scheduleIsUsable(ids, blocks = []) {
  const rows = ids.map(id => Store.tasks[id]);
  for (const row of rows) {
    assert.equal(row.planning_status, 'scheduled', `${row.id} remains on the schedule`);
    assert.ok(row.start_date && row.end_date, `${row.id} has both edges`);
    assert.equal((+row.end_date - +row.start_date) / 3600000, Number(row.RUN_TIME), `${row.id} retains its runtime`);
    assert.ok(+row.start_date >= +when('06', '08:00') && +row.end_date <= +when('07', '18:00'));
    for (const [from, to, machine] of blocks) {
      if (row.MACHINE === machine) assert.ok(+row.end_date <= +from || +row.start_date >= +to,
        `${row.id} does not run during maintenance`);
    }
  }
  for (const [index, left] of rows.entries()) for (const right of rows.slice(index + 1)) {
    if (left.MACHINE === right.MACHINE) assert.ok(+left.end_date <= +right.start_date || +right.end_date <= +left.start_date,
      `${left.id} and ${right.id} do not overlap on ${left.MACHINE}`);
  }
}

test('planner day: optimize the morning queue, commit one placement, admit a rush order, then absorb downtime', () => {
  const restore = startDay([
    task('standard-a', 'LINE-A', 2, '16:00'),
    task('standard-b', 'LINE-A', 1, '16:00'),
    task('other-line', 'LINE-B', 2, '16:00'),
  ]);
  try {
    optimize('spt');
    scheduleIsUsable(['standard-a', 'standard-b', 'other-line']);
    const otherLine = [+Store.tasks['other-line'].start_date, +Store.tasks['other-line'].end_date];

    const manual = Engine.manualSchedulePatchFor(Store.tasks['standard-a'], 'LINE-A', when('06', '15:00'));
    assert.ok(manual, 'the planner can set a specific finish');
    Store.updateTask('standard-a', manual, 'day-test');
    assert.equal(+Store.tasks['standard-a'].end_date, +when('06', '15:00'));
    assert.deepEqual(Engine.applyFirm(['standard-a'], true, 'day-test'), { changed: ['standard-a'], skipped: [] });

    Store.setTasks([...Store.tasksArr, task('rush', 'LINE-A', 1, '11:00')], 'day-test');
    optimize('duedate');
    scheduleIsUsable(['standard-a', 'standard-b', 'other-line', 'rush']);
    assert.equal(+Store.tasks['standard-a'].end_date, +when('06', '15:00'), 'the planner commitment survives');
    assert.ok(+Store.tasks.rush.end_date <= +when('06', '11:00'), 'the rush order meets its due time');

    const maintenance = [when('06', '09:00'), when('06', '10:00'), 'LINE-A'];
    Store.replaceBlocks([{ id: 'maintenance', plant, line: 'LINE-A', start: maintenance[0], end: maintenance[1] }], 'day-test');
    optimize('duedate');
    scheduleIsUsable(['standard-a', 'standard-b', 'other-line', 'rush'], [maintenance]);
    assert.equal(+Store.tasks['standard-a'].end_date, +when('06', '15:00'));
    assert.ok(+Store.tasks.rush.end_date <= +when('06', '11:00'), 'the rush order still meets its due time after downtime');
    assert.deepEqual([+Store.tasks['other-line'].start_date, +Store.tasks['other-line'].end_date], otherLine,
      'maintenance on one line leaves the independent line alone');
  } finally { restore(); }
});

test('planner day: batch-push an unfirmed order, protect its neighbor, then reoptimize the revised board', () => {
  const restore = startDay([
    task('one', 'LINE-A', 1, '16:00'),
    task('two', 'LINE-A', 1, '16:00'),
    task('three', 'LINE-B', 1, '16:00'),
  ]);
  try {
    optimize('spt');
    scheduleIsUsable(['one', 'two', 'three']);
    const protectedBefore = [+Store.tasks.one.start_date, +Store.tasks.one.end_date];
    assert.deepEqual(Engine.applyFirm(['one'], true, 'day-test'), { changed: ['one'], skipped: [] });
    const originalTwoFinish = +Store.tasks.two.end_date;
    const patches = Engine.pushFinishPatches([Store.tasks.one, Store.tasks.two], 3600000);
    assert.deepEqual(patches.map(p => p.id), ['two'], 'the batch action skips the committed order');
    Store.updateMany(patches, 'day-test');
    assert.equal(+Store.tasks.two.end_date, originalTwoFinish + 3600000);
    assert.deepEqual([+Store.tasks.one.start_date, +Store.tasks.one.end_date], protectedBefore);

    optimize('spt');
    scheduleIsUsable(['one', 'two', 'three']);
    assert.deepEqual([+Store.tasks.one.start_date, +Store.tasks.one.end_date], protectedBefore,
      'reoptimization still honors the planner firm');
  } finally { restore(); }
});
