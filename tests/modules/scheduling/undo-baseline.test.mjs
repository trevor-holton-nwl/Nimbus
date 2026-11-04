// Undo-settle baseline recording: Persistence._savedBaseline is taken only from server-sourced moments (a load of a
// row no cached edit touched, a successful save, an applied refresh row) and cleared on every tasks:bulk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const rowFor = (id, extra = {}) => ({ id, PLANT: 'P', MATERIAL_NUMBER: 'MAT', MACHINE: 'M1',
  'ORDER_QUANTITY_(GMEIN)': 60, PRODUCTION_VERSION: null, PRT_01: null, PRT_02: null,
  RUN_TIME: 3, run_time_source: 'manual', row_version: 1, planning_status: 'scheduled', user_scheduled: true,
  original_start_date: '2026-10-01T08:00:00', start_date: '2026-10-01T08:00:00',
  end_date: '2026-10-01T11:00:00', schedule_segments: [], ...extra });

function fixture(t) {
  globalThis.window = {};
  globalThis.document = { getElementById: () => null };
  const cache = new Map();
  globalThis.localStorage = { getItem: k => cache.get(k) ?? null, setItem: (k, v) => cache.set(k, v) };
  for (const method of ['info', 'warn', 'error']) t.mock.method(ErrorLog, method, () => {});
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(CalendarSync, 'fetchPlantConfig', async () => {});
  t.mock.method(Persistence, 'loadPriorityRankMaps', async () => {});
  t.mock.method(Persistence, 'loadSetupSnapshot', async () => null);
  t.mock.method(Runtime, 'load', async () => {});
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource', '_refreshRetry']) Persistence[k].clear();
  Store.setMasterData({ plants: [{ plant: 'P', routing_runtime_enabled: true, split_order_policy: 'partial_allowed',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }], lines: [] }, 'test');
  Store.setSelectedPlant('P', 'test');
  Persistence._currentLoadedPlant = 'P';
  t.after(() => { for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource']) Persistence[k].clear(); Persistence._savedBaseline.clear(); });
}
const keyOf = id => Persistence._baselineKey(Persistence._taskEditSnapshot(Store.tasks[id]));

test('load records a baseline from the server row; a row with a cached edit overlaid gets none', async t => {
  fixture(t);
  Store.setTasks([Persistence._prepTask(rowFor('A')), Persistence._prepTask(rowFor('B'))], 'persistence');
  // A planner moved A and the edit sits in the offline cache.
  Store.updateTask('A', { start_date: new Date('2026-10-01T12:00:00'), end_date: new Date('2026-10-01T15:00:00') }, 'table');
  Persistence._dirtyIds.add('A');
  Persistence._saveCache();
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true, json: async () =>
    url.includes('/tasks?') ? { data: [rowFor('A'), rowFor('B')], meta: {}, links: [] }
      : url.endsWith('/system-settings') ? {} : { rows: [] } }));
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(Store.tasks.A.start_date.getHours(), 12, 'precondition: the cached edit was overlaid');
  assert.equal(Persistence._savedBaseline.has('A'), false, 'an overlaid row is not the server row: unknown');
  const b = Persistence._savedBaseline.get('B');
  assert.equal(b.version, 1);
  assert.equal(b.key, keyOf('B'), 'the clean row carries its server key');
  assert.equal(Persistence._baselineKey({ source: 'drag', FIRMED: true, MACHINE: 'M1' }), '{"MACHINE":"M1"}', 'source and FIRMED are not part of the key');
});

test('a plain reload (discard local edits) baselines every row, including the one with a cached edit', async t => {
  fixture(t);
  Store.setTasks([Persistence._prepTask(rowFor('A'))], 'persistence');
  Store.updateTask('A', { start_date: new Date('2026-10-01T12:00:00'), end_date: new Date('2026-10-01T15:00:00') }, 'table');
  Persistence._dirtyIds.add('A'); Persistence._saveCache();
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true, json: async () =>
    url.includes('/tasks?') ? { data: [rowFor('A')], meta: {}, links: [] } : url.endsWith('/system-settings') ? {} : { rows: [] } }));
  await Persistence.reload(); await tick();
  assert.equal(Store.tasks.A.start_date.getHours(), 8);
  assert.equal(Persistence._savedBaseline.get('A').key, keyOf('A'));
});

test('a successful save records the sent state at the new row_version; the next tasks:bulk clears it', async t => {
  fixture(t);
  Store.setTasks([Persistence._prepTask(rowFor('A'))], 'persistence');
  Store.updateTask('A', { PRT_01: 'TOOL' }, 'table'); Persistence._dirtyIds.add('A');
  const sentKey = keyOf('A');
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () =>
    ({ status: 'ok', updated: 1, persisted: 1, versions: { A: 2 }, stale: [], invalid_ids: [], not_found_ids: [] }) }));
  Persistence.saveAll(); await tick(); await tick();
  assert.equal(Persistence._dirtyIds.has('A'), false);
  assert.deepEqual(Persistence._savedBaseline.get('A'), { version: 2, key: sentKey });
  Store.setTasks([Persistence._prepTask(rowFor('A'))], 'persistence');
  assert.equal(Persistence._savedBaseline.size, 0, 'tasks:bulk clears the baseline');
});

test('an applied /tasks/refresh row records the server row at its version', async t => {
  fixture(t);
  Store.setTasks([Persistence._prepTask(rowFor('A'))], 'persistence');
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () =>
    ({ data: [rowFor('A', { row_version: 7, PRT_01: 'NEWTOOL' })], missing: [] }) }));
  Persistence._refreshTasks(['A']); await tick();
  assert.equal(Store.tasks.A.row_version, 7);
  assert.deepEqual(Persistence._savedBaseline.get('A'), { version: 7, key: keyOf('A') });
  assert.match(Persistence._savedBaseline.get('A').key, /NEWTOOL/);
});

test('settleRestored un-dirties only a row that equals its baseline at the same version', t => {
  fixture(t);
  Store.setTasks([Persistence._prepTask(rowFor('A')), Persistence._prepTask(rowFor('B'))], 'persistence');
  for (const id of ['A', 'B']) Persistence._recordBaseline(id, 1, keyOf(id));
  Store.updateTask('B', { PRT_01: 'X' }, 'table');
  Persistence._dirtyIds.add('A'); Persistence._dirtyIds.add('B'); Persistence._dirtySource.set('A', 'drag');
  Persistence.settleRestored(['A', 'B']);
  assert.equal(Persistence._dirtyIds.has('A'), false);
  assert.equal(Persistence._dirtySource.has('A'), false);
  assert.equal(Persistence._dirtyIds.has('B'), true);
});

test('load keeps its original order: a row from an older server (no planning_status) is overlaid BEFORE it is normalized, so the overlaid cached dates are still snapped', async t => {
  fixture(t);
  const old = id => rowFor(id, { planning_status: undefined });
  Store.setTasks([Persistence._prepTask(old('A'))], 'persistence');
  Store.updateTask('A', { start_date: new Date('2026-10-01T12:07:00'), end_date: new Date('2026-10-01T15:07:00') }, 'table');
  Store.tasks.A.planning_status = undefined;
  Persistence._dirtyIds.add('A'); Persistence._saveCache();
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true, json: async () =>
    url.includes('/tasks?') ? { data: [old('A')], meta: {}, links: [] } : url.endsWith('/system-settings') ? {} : { rows: [] } }));
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(Store.tasks.A.start_date.getHours(), 12, 'precondition: the cached edit was overlaid');
  assert.equal(Store.tasks.A.start_date.getMinutes() % 15, 0, 'setTasks snapped the overlaid dates, as before the baseline change');
  assert.equal(Store.tasks.A.planning_status, 'scheduled');
});
