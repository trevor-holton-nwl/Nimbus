import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { App } from '../../../frontend/shell/application-shell.mjs';
import { resetCacheEnv, readRecord } from '../helpers/cache-env.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const oldTasks = Store.tasksArr, oldMaster = Store.masterData, oldPlant = Store.selectedPlant;
  const oldStorage = globalThis.localStorage;
  const oldWindow = globalThis.window;
  const oldFirmHint = App._firmHintShown;
  globalThis.window = {};
  const flags = ['_dirtyIds', '_forceIds', '_firmDirtyIds', '_conflictedIds'];
  const priorFlags = Object.fromEntries(flags.map(key => [key, [...Persistence[key]]]));
  for (const key of flags) Persistence[key].clear();
  const storage = resetCacheEnv().map;
  const oldLoadedPlant = Persistence._currentLoadedPlant;
  Persistence._currentLoadedPlant = 'P0';
  t.mock.method(Toast, 'show', () => {}); // user-facing DOM notification boundary
  const requests = [];
  t.mock.method(Util, 'fetchTraced', (url, opts) => {
    if (String(url).match(/\/distribution\/[^/]+\/summary$/)) {
      return Promise.resolve({ ok: true, json: async () => ({ needs_review: 0, changed: 0, problems: 0 }) });
    }
    assert.match(String(url), /\/tasks\/update$/);
    return new Promise(resolve => requests.push({ url, opts, resolve }));
  });
  const off = Store.subscribe(event => App._trackDirty(event), 'scale-real-dirty-tracker');
  t.after(async () => {
    for (const request of requests) request.resolve({ ok: true, json: async () => ({ versions: {}, persisted: 0, updated: 0 }) });
    await settle();
    off();
    Store.setMasterData(oldMaster, 'test'); Store.setTasks(oldTasks, 'test'); Store.setSelectedPlant(oldPlant, 'test');
    for (const key of flags) { Persistence[key].clear(); for (const id of priorFlags[key]) Persistence[key].add(id); }
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    App._firmHintShown = oldFirmHint;
    Persistence._currentLoadedPlant = oldLoadedPlant;
  });
  Store.setMasterData({ plants: [{ plant: 'P0' }], lines: Array.from({ length: 70 }, (_, i) => ({ plant: 'P0', machine: `M${i}` })) }, 'test');
  const tasks = Array.from({ length: 2100 }, (_, i) => ({
    id: `order-${i}`, PLANT: 'P0', MACHINE: `M${i % 70}`, MATERIAL_NUMBER: `MAT${i}`,
    PRODUCTION_VERSION: '0001', RUN_TIME: 1, row_version: '100', planning_status: 'scheduled',
    start_date: new Date(2026, 9, 13 + Math.floor(i / 560), 8 + Math.floor(i / 70) % 8),
    end_date: new Date(2026, 9, 13 + Math.floor(i / 560), 9 + Math.floor(i / 70) % 8),
  }));
  Store.setTasks(tasks, 'persistence'); Store.setSelectedPlant('P0', 'test');
  async function respond(request, ids, version = '101') {
    request.resolve({ ok: true, json: async () => ({ status: 'ok', updated: ids.length, persisted: ids.length,
      versions: Object.fromEntries(ids.map(id => [id, version])), stale: [] }) });
    await settle();
    assert.equal(Persistence._saveInFlight, false);
  }
  return { tasks, requests, storage, respond };
}

test('bulk edits on 70 machines save exactly 2,100 rows once and preserve 210 newer edits for the next save', async t => {
  const f = fixture(t);
  Store.updateMany(f.tasks.map(task => ({ id: task.id, changes: { PRODUCTION_VERSION: '0002' } })), 'table');
  assert.equal(Persistence._dirtyIds.size, 2100);
  Persistence.saveAll();
  assert.equal(f.requests.length, 1);
  const sent = JSON.parse(f.requests[0].opts.body);
  assert.match(f.requests[0].url, /\/tasks\/update$/);
  assert.equal(sent.atomic_optimizer, false);
  assert.deepEqual(new Set(sent.tasks.map(task => task.id)), new Set(f.tasks.map(task => task.id)));
  assert.equal(sent.tasks.length, 2100);
  assert.ok(sent.tasks.every(task => task.base_version === '100' && task.PRODUCTION_VERSION === '0002'));
  const changedAgain = f.tasks.filter((_, i) => i % 10 === 0);
  Store.updateMany(changedAgain.map(task => ({ id: task.id, changes: { PRODUCTION_VERSION: '0003' } })), 'table');
  await f.respond(f.requests[0], f.tasks.map(task => task.id));
  assert.deepEqual(Persistence._dirtyIds, new Set(changedAgain.map(task => task.id)));
  for (const task of f.tasks) assert.equal(Store.tasks[task.id].row_version, '101');
  // The cache record holds ONLY the dirty rows (the 210 newer edits), never the clean 1,890.
  const cached = readRecord('P0');
  assert.equal(cached.rows.length, 210);
  assert.deepEqual(new Set(cached.rows.map(r => r.id)), Persistence._dirtyIds);
  Persistence.saveAll();
  assert.equal(f.requests.length, 2);
  const retry = JSON.parse(f.requests[1].opts.body).tasks;
  assert.equal(retry.length, 210);
  assert.deepEqual(new Set(retry.map(task => task.id)), new Set(changedAgain.map(task => task.id)));
  assert.ok(retry.every(task => task.base_version === '101' && task.PRODUCTION_VERSION === '0003'));
  await f.respond(f.requests[1], retry.map(task => task.id), '102');
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.equal(Store.tasksArr.length, 2100);
});

test('firming 700 rows sends only their firm flags and a repeated firm selection adds no duplicate save rows', async t => {
  const f = fixture(t);
  const ids = f.tasks.filter((_, i) => i % 3 === 0).map(task => task.id);
  Store.setFirmed(ids, true, 'table');
  Store.setFirmed(ids, true, 'table');
  assert.equal(Persistence._dirtyIds.size, 700);
  assert.equal(Persistence._firmDirtyIds.size, 700);
  assert.equal(Persistence._forceIds.size, 0);
  Persistence.saveAll();
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].opts.body);
  assert.equal(body.atomic_optimizer, false);
  assert.equal(body.tasks.length, 700);
  assert.deepEqual(new Set(body.tasks.map(task => task.id)), new Set(ids));
  assert.ok(body.tasks.every(task => task.FIRMED === true));
  await f.respond(f.requests[0], ids);
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.equal(Persistence._firmDirtyIds.size, 0);
  assert.deepEqual(Store.firmedIds, new Set(ids));
  assert.equal(Store.tasksArr.length, 2100);
});
