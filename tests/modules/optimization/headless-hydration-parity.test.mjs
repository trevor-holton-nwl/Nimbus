// P3-5h: the headless runner re-implements two browser seams: Persistence._prepTask (wire row -> NimbusTask) and
// Persistence._taskEditSnapshot (task -> the /tasks/update item). Both copies must agree with the browser for every
// row shape the server can send, or a job would hydrate or write a row differently from the Optimize dialog.
import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Persistence } = await import('../helpers/browser-store-hydrate.mjs');
const { prepTask } = await import('../../../frontend/optimization/headless-snapshot.mjs');
const { patchesToUpdateItems } = await import('../../../frontend/optimization/headless-writer.mjs');
const { applyPatchesToSnapshot } = await import('../../../frontend/optimization/setup-scheduler.mjs');

const seg = (n, s, e) => ({ sequence: n, start_date: s, end_date: e });
const ROWS = {
  placed: { id: 1, PLANT: 'P', MACHINE: 'L1', RUN_TIME: 4, user_scheduled: true, planning_status: 'scheduled', start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T12:00:00', original_start_date: '2026-08-01T00:00:00', original_end_date: '2026-08-05T00:00:00', schedule_segments: [] },
  splitSnake: { id: 2, PLANT: 'P', MACHINE: 'L1', RUN_TIME: 6, user_scheduled: true, planning_status: 'scheduled', start_date: '2026-08-03T08:00:00', end_date: '2026-08-04T10:00:00', schedule_segments: [seg(2, '2026-08-04T08:00:00', '2026-08-04T10:00:00'), seg(1, '2026-08-03T08:00:00', '2026-08-03T12:00:00')] },
  splitCamel: { id: 3, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', start_date: '2026-08-03T08:00:00', end_date: '2026-08-04T10:00:00', scheduleSegments: [{ sequence: 1, startDate: '2026-08-03T08:00:00', endDate: '2026-08-03T12:00:00' }, { sequence: 2, startDate: '2026-08-04T08:00:00', endDate: '2026-08-04T10:00:00' }] },
  oneSegmentDropped: { id: 4, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T12:00:00', schedule_segments: [seg(1, '2026-08-03T08:00:00', '2026-08-03T12:00:00')] },
  badSegments: { id: 5, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', schedule_segments: [null, 7, seg(1, 'garbage', '2026-08-03T12:00:00'), seg(2, '2026-08-04T12:00:00', '2026-08-04T08:00:00'), seg(3, '2026-08-05T08:00:00', '2026-08-05T10:00:00'), { sequence: 'x', startDate: '2026-08-06T08:00:00', endDate: '2026-08-06T09:00:00' }] },
  queued: { id: 6, PLANT: 'P', MACHINE: 'L1', planning_status: 'needs_planning', planning_reason: { code: 'no_fit_found', message: 'm' }, start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T12:00:00', schedule_segments: [seg(1, '2026-08-03T08:00:00', '2026-08-03T12:00:00'), seg(2, '2026-08-04T08:00:00', '2026-08-04T10:00:00')] },
  neverPlaced: { id: 7, PLANT: 'P', MACHINE: 'L1', RUN_TIME: 3, user_scheduled: false, start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T11:00:00', original_end_date: '2026-08-04T00:00:00' },
  hasBasicStart: { id: 8, PLANT: 'P', MACHINE: 'L1', BASIC_START_DATE: '2026-07-30T00:00:00', original_start_date: '2026-08-01T00:00:00' },
  nullsAndOddKeys: { id: 9, PLANT: 'P', MACHINE: null, start_date: null, end_date: null, ECC_FIRM_DATE: '2026-08-02T00:00:00', note_date_text: 'not a date', SomeDateField: '2026-08-02T03:04:05' },
  dstGap: { id: 10, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', start_date: '2026-03-08T01:30:00', end_date: '2026-03-08T03:30:00' },
  dstOverlap: { id: 11, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', start_date: '2026-11-01T00:30:00', end_date: '2026-11-01T01:45:00' },
  zonedStrings: { id: 12, PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', start_date: '2026-08-03T08:00:00Z', end_date: '2026-08-03T12:00:00.000+00:00' },
};

const canon = (task) => JSON.parse(JSON.stringify(task, (_k, v) => (v instanceof Date ? { __date: Number.isFinite(v.getTime()) ? v.getTime() : 'invalid' } : v)));

test('prepTask equals Persistence._prepTask for every wire row shape', () => {
  for (const [name, raw] of Object.entries(ROWS)) {
    const browser = Persistence._prepTask(structuredClone(raw));
    const headless = prepTask(structuredClone(raw));
    assert.deepEqual(canon(headless), canon(browser), name);
    assert.deepEqual(Object.keys(headless).sort(), Object.keys(browser).sort(), `${name}: same keys`);
  }
});

test('prepTask and Persistence._prepTask both mutate and return their input (callers rely on it)', () => {
  const a = structuredClone(ROWS.placed); const b = structuredClone(ROWS.placed);
  assert.equal(prepTask(a), a);
  assert.equal(Persistence._prepTask(b), b);
});

// ---- the write side: patchesToUpdateItems vs Persistence._taskEditSnapshot ----
const SHARED = ['planning_status', 'planning_reason', 'placement_exception', 'start_date', 'end_date', 'schedule_segments'];
const at = (s) => new Date(s);

test('patchesToUpdateItems carries the same placement fields as Persistence._taskEditSnapshot', () => {
  Persistence._firmDirtyIds.clear();
  Persistence._dirtySource.clear();
  const tasks = [
    { ...ROWS.placed, id: '1', row_version: 3 },
    { ...ROWS.splitSnake, id: '2', row_version: 4 },
    { ...ROWS.neverPlaced, id: '7', row_version: 5 },
    { ...ROWS.queued, id: '6', row_version: 6 },
    { id: '13', PLANT: 'P', MACHINE: 'L1', planning_status: 'scheduled', user_scheduled: true, placement_exception: 'overtime', start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T12:00:00', row_version: 7 },
  ].map(raw => prepTask(structuredClone(raw)));
  const patches = [
    { id: '1', changes: { start_date: at('2026-08-05T08:00:00'), end_date: at('2026-08-05T12:00:00') } },
    { id: '2', changes: { start_date: at('2026-08-05T08:00:00'), end_date: at('2026-08-06T10:00:00'), scheduleSegments: [{ sequence: 1, startDate: at('2026-08-05T08:00:00'), endDate: at('2026-08-05T12:00:00') }, { sequence: 2, startDate: at('2026-08-06T08:00:00'), endDate: at('2026-08-06T10:00:00') }] } },
    { id: '7', changes: { start_date: at('2026-08-05T08:00:00'), end_date: at('2026-08-05T11:00:00') } },     // placement of a never-placed row
    { id: '6', changes: { start_date: at('2026-08-07T08:00:00'), end_date: at('2026-08-07T12:00:00'), planning_status: 'scheduled', planning_reason: null } },
    { id: '13', changes: { start_date: at('2026-08-08T08:00:00'), end_date: at('2026-08-08T12:00:00') } },
  ];
  const items = patchesToUpdateItems(tasks, patches);
  const after = new Map(applyPatchesToSnapshot(tasks, patches).map(t => [String(t.id), t]));
  assert.equal(items.length, patches.length);
  for (const item of items) {
    const task = after.get(item.id);
    // The browser applies a placement through Store._markPlaced, which flags the row user_scheduled before the save snapshot.
    const patch = patches.find(p => p.id === item.id);
    if (patch.changes.start_date && patch.changes.end_date) task.user_scheduled = true;
    const browser = Persistence._taskEditSnapshot(task);
    // The writer mirrors only the placement block of the browser payload; attribute fields (PRT, MACHINE, ...) are not written.
    // The compared set differs by design only for `displayOnly` rows, which both sides reduce to the same (empty) placement block.
    for (const key of SHARED) {
      assert.equal(key in item, key in browser, `${item.id}: presence of ${key}`);
      if (key in item) assert.deepEqual(item[key], browser[key], `${item.id}: ${key}`);
    }
    assert.equal(item.source, 'optimizer');
    assert.equal(item.force, false);
    assert.equal(item.base_version, tasks.find(t => String(t.id) === item.id).row_version);
  }
});

test('a patch that only moves a never-placed row without both edges stays display-only on both sides', () => {
  const task = prepTask(structuredClone({ ...ROWS.neverPlaced, id: '7', row_version: 5 }));
  const patches = [{ id: '7', changes: { MACHINE: 'L2' } }];
  const [item] = patchesToUpdateItems([task], patches);
  const moved = applyPatchesToSnapshot([task], patches).find(t => String(t.id) === '7');
  const browser = Persistence._taskEditSnapshot(moved);
  for (const key of SHARED) assert.equal(key in item, key in browser, key);
  assert.equal('start_date' in item, false);
});
