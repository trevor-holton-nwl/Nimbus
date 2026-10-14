import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Config, Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Table } from '../../../frontend/scheduling/orders.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { createRequire } from 'node:module';

// Placement derives from the plant clock, which projects through the compute core's zone helper (OQ52).
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
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
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); Persistence._conflictedIds.clear();
  // A placement edit holds the finish on the plant's clock (backward scheduling Task 2.5): the plant needs a zone,
  // a pinned server clock (the fixture is dated 2026-10-01) and a splitting policy so a 12 h run can end at 14:00.
  Store.setMasterData({ plants: [{ plant: 'P', routing_runtime_enabled: true, split_order_policy: 'partial_allowed',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }], lines: [] }, 'test');
  const priorOffset = Store.serverOffsetMs;
  Store.serverOffsetMs = new Date('2026-09-01T00:00:00').getTime() - Date.now();
  t.after(() => { Store.serverOffsetMs = priorOffset; Store._blockedPlants.clear(); });
  Store.setSelectedPlant('P', 'test');
  Persistence._currentLoadedPlant = 'P';
  const server = { id: 'A', PLANT: 'P', MATERIAL_NUMBER: 'MAT', MACHINE: 'M1',
    'ORDER_QUANTITY_(GMEIN)': 60, PRODUCTION_VERSION: null, PRT_01: null, PRT_02: null,
    RUN_TIME: 3, run_time_source: 'manual', row_version: 1, planning_status: 'scheduled',
    original_start_date: '2026-10-01T08:00:00', start_date: '2026-10-01T08:00:00',
    end_date: '2026-10-01T11:00:00', schedule_segments: [] };
  Store.setTasks([Persistence._prepTask(structuredClone(server))], 'persistence');
  t.after(() => { Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); Persistence._conflictedIds.clear(); });
  return server;
}
function mockLoad(t, server) {
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true, json: async () =>
    url.includes('/tasks?') ? { data: [structuredClone(server)], meta: {}, links: [] }
      : url.endsWith('/system-settings') ? {} : { rows: [] } }));
}
function cacheConflict() {
  Store.updateTask('A', { start_date: new Date('2026-10-01T12:00:00'), end_date: new Date('2026-10-01T15:00:00') }, 'table');
  Persistence._dirtyIds.add('A'); Persistence._conflictedIds.add('A');
  Persistence._saveCache();
}

test('refresh retains null PV through a subsequent ordinary save payload', async t => {
  const server = fixture(t);
  let submitted;
  t.mock.method(Util, 'fetchTraced', async (url, options) => ({ ok: true, json: async () => {
    if (url.endsWith('/tasks/refresh')) return { data: [server], missing: [] };
    submitted = JSON.parse(options.body).tasks[0];
    return { status: 'ok', updated: 1, persisted: 1, versions: { A: 2 }, stale: [], invalid_ids: [], not_found_ids: [] };
  } }));
  Persistence._refreshTasks(['A']); await tick();
  assert.equal(Store.tasks.A.PRODUCTION_VERSION, null);
  Store.updateTask('A', { PRT_01: 'TOOL' }, 'table'); Persistence._dirtyIds.add('A');
  Persistence.saveAll(); await tick();
  assert.equal(submitted.PRODUCTION_VERSION, null);
  assert.equal(submitted.PRT_01, 'TOOL');
});

test('refresh updates routing quantity, material and raw validity date before the next grid edit', async t => {
  const server = fixture(t);
  Object.assign(server, { MATERIAL_NUMBER: 'NEW', 'ORDER_QUANTITY_(GMEIN)': 120,
    PRODUCTION_VERSION: '0001', RUN_TIME: 6, run_time_source: 'routing', row_version: 2,
    original_start_date: '2026-11-01T08:00:00', end_date: '2026-10-01T14:00:00' });
  Runtime._rateMapPlant = 'P';
  Runtime._rateMap = { plant: 'P', machines: { M1: 'W1', M2: 'W2' },
    pv: { 'NEW|0001': { key: 'NEW|N|G|01', valid_from: '2026-11-01', valid_to: '2026-11-30' } },
    ops: { 'NEW|N|G|01|W1': { minutes_per_unit: 3 }, 'NEW|N|G|01|W2': { minutes_per_unit: 6 } } };
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({ data: [server], missing: [] }) }));
  Persistence._refreshTasks(['A']); await tick();
  assert.equal(Store.tasks.A['ORDER_QUANTITY_(GMEIN)'], 120);
  assert.equal(Store.tasks.A.MATERIAL_NUMBER, 'NEW');
  assert.equal(Store.tasks.A.BASIC_START_DATE.getMonth(), 10);
  assert.equal(Store.tasks.A.row_version, 2);
  const oldApi = Table._api; t.after(() => { Table._api = oldApi; });
  Table._api = { applyTransaction() {}, refreshCells() {} };
  Store.tasks.A.MACHINE = 'M2';
  Table._onCellChanged({ colDef: { field: 'MACHINE' }, data: Store.tasks.A, newValue: 'M2', oldValue: 'M1', node: {} });
  assert.equal(Store.tasks.A.RUN_TIME, 12);
  assert.equal(Persistence._taskEditSnapshot(Store.tasks.A).RUN_TIME, 12);
  Runtime._rateMap.pv['NEW|0001'].valid_to = '2026-10-31';
  assert.deepEqual(Runtime.resolve(Store.tasks.A), { ok: false, step: 'pv_expired' });
});

for (const atomic of [false, true]) test(`explicit reload discards same-version cached conflicts (atomic=${atomic})`, async t => {
  const server = fixture(t); cacheConflict();
  if (atomic) { Persistence._forceIds.add('A'); Persistence._saveCache(); }
  mockLoad(t, server);
  await Persistence.reload(); await tick();
  assert.equal(Store.tasks.A.start_date.getHours(), 8);
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.equal(Persistence._forceIds.size, 0);
  assert.equal(Persistence._conflictedIds.size, 0);
  const cached = JSON.parse(globalThis.localStorage.getItem(Config.LS_KEY));
  assert.deepEqual(cached._dirtyIds, []);
  assert.deepEqual(cached._optimizerDirtyIds, []);
});

test('failed explicit reload retains local tasks, conflicts, dirty flags and cache', async t => {
  fixture(t); cacheConflict();
  const before = globalThis.localStorage.getItem(Config.LS_KEY), live = Store.tasks.A;
  t.mock.method(Util, 'fetchTraced', async () => { throw new Error('offline'); });
  t.mock.method(Persistence._reconnect, 'start', () => {});
  await Persistence.reload();
  assert.equal(Store.tasks.A, live);
  assert.equal(Persistence._conflictedIds.has('A'), true);
  assert.equal(Persistence._dirtyIds.has('A'), true);
  assert.equal(globalThis.localStorage.getItem(Config.LS_KEY), before);
});

test('normal startup load still restores same-version cached edits', async t => {
  const server = fixture(t); cacheConflict(); mockLoad(t, server);
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(Store.tasks.A.start_date.getHours(), 12);
  assert.equal(Persistence._dirtyIds.has('A'), true);
});

test('reload retains an edit made while the authoritative request is pending', async t => {
  const server = fixture(t); cacheConflict();
  let respond;
  t.mock.method(Util, 'fetchTraced', () => new Promise(resolve => { respond = resolve; }));
  const loading = Persistence.reload();
  Store.updateTask('A', { PRT_01: 'NEWER' }, 'table');
  respond({ ok: true, json: async () => ({ data: [server], links: [], meta: {} }) });
  await loading;
  assert.equal(Store.tasks.A.PRT_01, 'NEWER');
  assert.equal(Store.tasks.A.start_date.getHours(), 12);
  assert.equal(Persistence._conflictedIds.has('A'), true);
});

test('an invalid successful response cannot discard local conflicts', async t => {
  fixture(t); cacheConflict();
  t.mock.method(Util, 'fetchTraced', async () => ({ ok: true, json: async () => ({ status: 'error' }) }));
  await Persistence.reload();
  assert.equal(Store.tasks.A.start_date.getHours(), 12);
  assert.equal(Persistence._dirtyIds.has('A'), true);
  assert.equal(Persistence._conflictedIds.has('A'), true);
});

test('successful empty reload clears deleted tasks and cached dirty optimizer state', async t => {
  fixture(t); cacheConflict(); Persistence._forceIds.add('A'); Persistence._saveCache();
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true,
    json: async () => url.includes('/tasks?') ? { data: [], meta: {}, links: [] } : { rows: [] } }));
  await Persistence.reload(); await tick();
  assert.equal(Store.tasksArr.length, 0);
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.equal(Persistence._conflictedIds.size, 0);
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(Config.LS_KEY)).tasks, []);
});

test('raw SAP date survives display-baseline snapping and a cache round trip', t => {
  const server = fixture(t);
  const task = Persistence._prepTask(server);
  assert.equal(task.BASIC_START_DATE.getHours(), 8);
  task.original_start_date = new Date('2026-10-02T09:00:00');
  const decoded = Persistence._prepTask(JSON.parse(JSON.stringify(task)));
  assert.equal(decoded.BASIC_START_DATE.getDate(), 1);
  assert.equal(decoded.original_start_date.getDate(), 2);
});
