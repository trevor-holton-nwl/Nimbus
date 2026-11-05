// Wave 2 (save and load safety) tests for frontend/scheduling/persistence.mjs:
// S7-1/2/3/4/5/7/8/9, S10-1/2/4/6/7, S7-14. Same split-realm-free, DOM-less environment as persistence.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Config, Toast } from '../../../frontend/platform/foundation.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { CacheStore } from '../../../frontend/platform/cache-store.mjs';
import { makeFakeBackend } from '../helpers/cache-backend-fake.mjs';
import { resetCacheEnv, readRecord, CACHE_USER } from '../helpers/cache-env.mjs';

globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    body: { insertBefore() {} },
  };
}
function makeStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
  };
}
globalThis.localStorage = globalThis.localStorage || makeStorage();

const tick = () => new Promise(res => setTimeout(res, 0));
const d = s => new Date(s);
const row = (id, extra = {}) => ({ id, MACHINE: 'L1', RUN_TIME: 1, row_version: 5, user_scheduled: true,
  start_date: d('2026-09-09T08:00:00'), end_date: d('2026-09-09T09:00:00'), ...extra });

function resetFlags() {
  for (const k of ['_dirtyIds', '_forceIds', '_firmDirtyIds', '_conflictedIds', '_dirtySource', '_refreshRetry']) Persistence[k].clear();
}

function capture() {
  const toasts = [];
  const orig = Toast.show;
  Toast.show = (msg, type, ms) => { toasts.push({ msg, type, ms }); };
  return { toasts, restore: () => { Toast.show = orig; } };
}

// ---- S7-3 / S10-6 ----------------------------------------------------------------------------------------------

/** Seed the store with a cache record for `plant` holding the given dirty rows (projected like the real writer). */
function seedRecord(plant, rows, extra = {}) {
  resetCacheEnv();
  void CacheStore.ready(CACHE_USER);   // Node: the synchronous localStorage backend is installed inside this call
  const rec = { v: 1, user: CACHE_USER, plant, seq: 0, schemaVersion: Config.SCHEMA_VERSION, buildId: null, savedAt: 0, complete: true,
    optimizerIds: [], firmDirtyIds: [], rows, context: {}, ...extra };
  CacheStore.write({ user: CACHE_USER, plant, dirty: rows.length > 0 }, JSON.stringify(rec));
}

test('S7-3: a cache record is per plant: plant B never reads plant A\'s record, and A\'s own record is still there', () => {
  seedRecord('PA', [{ id: 'pa-1', row_version: 1, start_date: '2026-09-10T08:00:00', end_date: '2026-09-10T09:00:00' }]);
  assert.equal(Persistence._readCacheRecord('PB').record, null, 'plant B must not see plant A rows');
  assert.equal(Persistence._readCacheRecord('PA').record.rows[0].id, 'pa-1');
  assert.ok(CacheStore.peek('PA'), 'reading for B did not delete or move A\'s record');
});

test('S10-6: _readCacheRecord rejects a record of another user, schema or shape and flags an unreadable one that held rows', () => {
  seedRecord('PA', [{ id: 'x', row_version: 1 }], { schemaVersion: Config.SCHEMA_VERSION - 1 });
  assert.deepEqual(Persistence._readCacheRecord('PA'), { record: null, unreadable: true }, 'old schema with rows is reported');
  seedRecord('PA', [], { schemaVersion: Config.SCHEMA_VERSION - 1 });
  assert.deepEqual(Persistence._readCacheRecord('PA'), { record: null, unreadable: false }, 'old schema with no rows is silent');
  resetCacheEnv();
  void CacheStore.ready(CACHE_USER);
  CacheStore.write({ user: CACHE_USER, plant: 'PA', dirty: true }, '{not json');
  assert.deepEqual(Persistence._readCacheRecord('PA'), { record: null, unreadable: true });
  assert.deepEqual(Persistence._readCacheRecord('PZ'), { record: null, unreadable: false }, 'no record is not an error');
});

// ---- S7-7 ------------------------------------------------------------------------------------------------------

test('S7-7: a failed /tasks load with no cache shows an empty board and a persistent notice (no demo orders), and starts the reconnect watcher', async () => {
  const origFetch = globalThis.fetch, origStart = Persistence._reconnect.start;
  const priorLoaded = Persistence._currentLoadedPlant, priorAttempted = Persistence._lastAttemptedPlant;
  const cap = capture();
  let reconnect = 0;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500, clone() { return this; }, json: async () => ({}), text: async () => '' });
  Persistence._reconnect.start = () => { reconnect++; };
  globalThis.localStorage.removeItem(Config.LS_KEY);
  try {
    Store.setTasks([row('stale-left-over')], 'unit-test');
    await Persistence.load({ force: true, plant: 'PZ' });
    assert.equal(Store.tasksArr.length, 0, 'no invented orders');
    assert.equal(Persistence._lastLoad.source, null);
    assert.equal(reconnect, 1);
    const notice = cap.toasts.find(t => t.type === 'error');
    assert.ok(notice, 'an unreachable notice is shown');
    assert.ok(notice.ms >= 60_000, 'and it is not the 1.5 s default');
    assert.equal(typeof Persistence._loadDemo, 'undefined', 'the demo loader is gone');
  } finally {
    globalThis.fetch = origFetch; Persistence._reconnect.start = origStart; cap.restore();
    Persistence._currentLoadedPlant = priorLoaded; Persistence._lastAttemptedPlant = priorAttempted;
    resetFlags(); Store.setTasks([], 'unit-test');
  }
});

test('S7-3: a failed load for plant B with only plant A cached shows the empty/reconnect state, not A\'s orders', async () => {
  const origFetch = globalThis.fetch, origStart = Persistence._reconnect.start;
  const cap = capture();
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, clone() { return this; }, json: async () => ({}), text: async () => '' });
  Persistence._reconnect.start = () => {};
  seedRecord('PA', [{ id: 'pa-only', row_version: 1, start_date: '2026-09-10T08:00:00', end_date: '2026-09-10T09:00:00' }]);
  const before = CacheStore.peek('PA').json;
  try {
    Store.setTasks([], 'unit-test');
    await Persistence.load({ force: true, plant: 'PB' });
    assert.equal(Store.tasks['pa-only'], undefined);
    assert.ok(cap.toasts.some(t => t.type === 'error'));
    assert.equal(CacheStore.peek('PA').json, before, 'the failed load left plant A\'s record untouched');
  } finally {
    globalThis.fetch = origFetch; Persistence._reconnect.start = origStart; cap.restore();
    resetFlags(); Store.setTasks([], 'unit-test');
  }
});

// ---- S7-5 ------------------------------------------------------------------------------------------------------

test('S7-5: the overlay restores an unsaved Unschedule (null dates, needs_planning, reason) and reports it as dirty', () => {
  const t = Persistence._prepTask({ id: 'u1', MACHINE: 'L1', RUN_TIME: 2, row_version: 4,
    start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T10:00:00' });
  const restored = Persistence._overlayUserMoves([t], [{ id: 'u1', row_version: 4, planning_status: 'needs_planning',
    planning_reason: { code: 'planner_unscheduled', message: 'Unscheduled by planner' }, start_date: null, end_date: null }]);
  assert.deepEqual(restored, ['u1']);
  assert.equal(t.planning_status, 'needs_planning');
  assert.equal(t.start_date, null);
  assert.equal(t.end_date, null);
  assert.deepEqual(t.scheduleSegments, []);
  assert.equal(t.planning_reason.code, 'planner_unscheduled');
});

test('S7-5: an Unschedule is not restored over a row the server changed since, or one the server already queues', () => {
  const moved = Persistence._prepTask({ id: 'u2', MACHINE: 'L1', RUN_TIME: 2, row_version: 9,
    start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T10:00:00' });
  assert.deepEqual(Persistence._overlayUserMoves([moved], [{ id: 'u2', row_version: 4, planning_status: 'needs_planning' }]), []);
  assert.equal(moved.planning_status ?? 'scheduled', 'scheduled');
  const queued = Persistence._prepTask({ id: 'u3', MACHINE: 'L1', RUN_TIME: 2, row_version: 4, planning_status: 'needs_planning' });
  assert.deepEqual(Persistence._overlayUserMoves([queued], [{ id: 'u3', row_version: 4, planning_status: 'needs_planning' }]), []);
});

test('S7-5: a changed END alone (same start) is a move and is restored', () => {
  const t = Persistence._prepTask({ id: 'e1', MACHINE: 'L1', RUN_TIME: 2, row_version: 4,
    start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T10:00:00' });
  const restored = Persistence._overlayUserMoves([t], [{ id: 'e1', row_version: 4, user_scheduled: true,
    start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T11:00:00', original_start_date: '2026-09-09T08:00:00' }]);
  assert.deepEqual(restored, ['e1']);
  assert.equal(t.end_date.getTime(), d('2026-09-09T11:00:00').getTime());
});

// ---- S10-2 -----------------------------------------------------------------------------------------------------

test('S10-2: _sameAsSent treats a concurrent firm, status, reason or exception change as a real conflict', () => {
  const t = row('s1', { planning_status: 'scheduled', planning_reason: null, placement_exception: null });
  Persistence._firmDirtyIds.add('s1');
  try {
    t.firmed = true;
    const sent = JSON.stringify(Persistence._taskEditSnapshot(t));
    const server = { id: 's1', MACHINE: 'L1', RUN_TIME: 1, start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T09:00:00',
      schedule_segments: [], planning_status: 'scheduled', planning_reason: null, placement_exception: null, firmed: true };
    assert.equal(Persistence._sameAsSent(server, sent), true, 'identical row is silent');
    assert.equal(Persistence._sameAsSent({ ...server, firmed: false }, sent), false, 'another planner unfirmed it');
    assert.equal(Persistence._sameAsSent({ ...server, planning_status: 'needs_planning' }, sent), false);
    assert.equal(Persistence._sameAsSent({ ...server, placement_exception: 'overtime' }, sent), false);
    Persistence._firmDirtyIds.clear();
    const noFirmSent = JSON.stringify(Persistence._taskEditSnapshot(t));
    assert.equal(Persistence._sameAsSent({ ...server, firmed: false }, noFirmSent), true, 'a date-only send says nothing about the firm');
    const withReason = JSON.stringify({ ...JSON.parse(noFirmSent), planning_reason: { code: 'no_fit_found' } });
    assert.equal(Persistence._sameAsSent(server, withReason), false);
  } finally { resetFlags(); }
});

// ---- S7-9 ------------------------------------------------------------------------------------------------------

// ---- S7-9 (rewritten for the compact record: no tiers, no latch) -------------------------------------------------

function seedBoard(nOpt, { plant = 'PA' } = {}) {
  const tasks = [...Array.from({ length: 200 }, (_, i) => row(`c${i}`, { PLANT: plant })),
    ...Array.from({ length: nOpt }, (_, i) => row(`o${i}`, { PLANT: plant }))];
  Store.setTasks(tasks, 'unit-test');
  resetFlags();
  Persistence._currentLoadedPlant = plant;
  for (let i = 0; i < nOpt; i++) { Persistence._dirtyIds.add(`o${i}`); Persistence._forceIds.add(`o${i}`); }
}

test('S7-9: a failed cache put latches nothing: one toast, the next write retries, the inventory never says disabled', async () => {
  const fake = makeFakeBackend({ name: 'idb' });
  fake.ctl.quotaOnPut = 1;   // the first put aborts with a quota error
  const cap = capture();
  const priorPlant = Persistence._currentLoadedPlant;
  try {
    resetCacheEnv({ backend: { defaultBackend: 'idb', idb: fake.backend } });
    await CacheStore.ready(CACHE_USER);
    seedBoard(50);
    Persistence._saveCache();
    await CacheStore.settled();
    assert.equal(CacheStore.stats().failed, 1);
    assert.equal(cap.toasts.filter(t => t.msg.includes('toast.cache_put_failed')).length, 1, 'one "not backed up" toast');
    assert.equal(Persistence.storageInventory().autosaveDisabled, false, 'a failed write never latches autosave off');
    Store.updateTask('o0', { PRT_01: 'X' }, 'table'); Persistence._dirtyIds.add('o0');
    Persistence._saveCache();
    await CacheStore.settled();
    assert.equal(CacheStore.stats().failed, 1, 'no new failure: the retry went through');
    assert.equal(JSON.parse(fake.data.get(`${CACHE_USER}|PA`).json).rows.length, 50, 'the retried write holds all 50 dirty rows');
    assert.equal(cap.toasts.filter(t => t.msg.includes('toast.cache_put_failed')).length, 1, 'still just the one toast');
  } finally {
    cap.restore(); resetFlags(); Store.setTasks([], 'unit-test'); Persistence._currentLoadedPlant = priorPlant;
    CacheStore._setBackendForTests();
  }
});

test('S7-9: 5000 optimizer-dirty rows are one compact record holding only those rows', () => {
  const priorPlant = Persistence._currentLoadedPlant;
  try {
    resetCacheEnv();
    seedBoard(5000);
    Persistence._saveCache();
    const rec = readRecord('PA');
    assert.equal(rec.rows.length, 5000, 'no clean rows in the record');
    assert.equal(rec.optimizerIds.length, 5000);
    assert.equal(Persistence.storageInventory().autosaveDisabled, false);
  } finally {
    resetFlags(); Store.setTasks([], 'unit-test'); Persistence._currentLoadedPlant = priorPlant; CacheStore._setBackendForTests();
  }
});

// ---- S10-1 / S10-4 / S10-7 / S7-14 ------------------------------------------------------------------------------

function saveEnv(rows) {
  const calls = [];
  const origFetch = globalThis.fetch;
  const cap = capture();
  Store.setTasks(rows, 'unit-test');
  resetFlags();
  return {
    calls, cap,
    mock(handler) {
      globalThis.fetch = (url, opts) => {
        const call = { url: String(url), body: opts?.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        return Promise.resolve({ ok: true, json: async () => handler(call) });
      };
    },
    done() { globalThis.fetch = origFetch; cap.restore(); resetFlags(); Store.setTasks([], 'unit-test'); },
  };
}

test('S10-1: optimizer rows go as ONE atomic request and manual rows as a separate non-atomic request, in that order', async () => {
  const env = saveEnv([row('o1'), row('o2'), row('m1')]);
  try {
    for (const id of ['o1', 'o2']) { Persistence._dirtyIds.add(id); Persistence._forceIds.add(id); }
    Persistence._dirtyIds.add('m1');
    env.mock(call => call.body.atomic_optimizer
      ? { versions: { o1: 6, o2: 6 }, persisted: 2, updated: 2, stale: [] }
      : { versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] });
    Persistence.saveAll();
    await tick();
    const saves = env.calls.filter(c => c.url.includes('/tasks/update'));
    assert.equal(saves.length, 2);
    assert.equal(saves[0].body.atomic_optimizer, true);
    assert.deepEqual(saves[0].body.tasks.map(t => t.id).sort(), ['o1', 'o2']);
    assert.ok(saves[0].body.tasks.every(t => t.force === false));
    assert.equal(saves[1].body.atomic_optimizer, false);
    assert.deepEqual(saves[1].body.tasks.map(t => t.id), ['m1']);
    assert.equal(Persistence._dirtyIds.size, 0);
    assert.equal(Store.tasks.m1.row_version, 6);
    assert.equal(env.cap.toasts.filter(t => t.type === 'success').length, 1, 'one success toast for the whole save');
  } finally { env.done(); }
});

test('S10-1: a stale optimizer row leaves its group unsaved but never blocks the manual edit', async () => {
  const env = saveEnv([row('o1'), row('m1')]);
  try {
    Persistence._dirtyIds.add('o1'); Persistence._forceIds.add('o1'); Persistence._dirtyIds.add('m1');
    env.mock(call => call.url.includes('/tasks/refresh') ? { data: [], missing: [] }
      : call.body.atomic_optimizer
        ? { versions: {}, persisted: 0, updated: 1, stale: ['o1'] }
        : { versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] });
    Persistence.saveAll();
    await tick();
    assert.equal(env.calls.filter(c => c.url.includes('/tasks/update')).length, 2, 'the manual request still goes out');
    assert.ok(!Persistence._dirtyIds.has('m1'), 'manual edit saved');
    assert.ok(Persistence._dirtyIds.has('o1') && Persistence._forceIds.has('o1'), 'optimizer edit preserved');
    assert.ok(env.cap.toasts.some(t => t.msg === 'toast.optimizer_unsaved_resolve'));
    assert.ok(!env.cap.toasts.some(t => t.type === 'success'), 'no success toast when a group failed');
  } finally { env.done(); }
});

test('S10-1: a stale MANUAL row takes the normal stale-refresh path while the atomic group is unaffected', async () => {
  const env = saveEnv([row('o1'), row('m1')]);
  try {
    Persistence._dirtyIds.add('o1'); Persistence._forceIds.add('o1'); Persistence._dirtyIds.add('m1');
    env.mock(call => call.url.includes('/tasks/refresh')
      ? { data: [{ id: 'm1', MACHINE: 'L1', RUN_TIME: 1, row_version: 8, planning_status: 'scheduled',
          start_date: '2026-09-09T10:00:00', end_date: '2026-09-09T11:00:00', schedule_segments: [] }], missing: [] }
      : call.body.atomic_optimizer
        ? { versions: { o1: 6 }, persisted: 1, updated: 1, stale: [] }
        : { versions: {}, persisted: 0, updated: 1, stale: ['m1'] });
    Persistence.saveAll();
    await tick(); await tick();
    assert.ok(env.calls.some(c => c.url.includes('/tasks/refresh') && c.body.ids.includes('m1')));
    assert.equal(Store.tasks.m1.row_version, 8, 'manual row adopted the server copy');
    assert.equal(Store.tasks.o1.row_version, 6);
    assert.ok(!Persistence._dirtyIds.has('o1'));
  } finally { env.done(); }
});

test('S10-1: a conflicted optimizer row withholds the atomic group only', async () => {
  const env = saveEnv([row('o1'), row('m1')]);
  try {
    Persistence._dirtyIds.add('o1'); Persistence._forceIds.add('o1'); Persistence._conflictedIds.add('o1');
    Persistence._dirtyIds.add('m1');
    env.mock(() => ({ versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] }));
    Persistence.saveAll();
    await tick();
    const saves = env.calls.filter(c => c.url.includes('/tasks/update'));
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].body.tasks.map(t => t.id), ['m1']);
    assert.ok(Persistence._dirtyIds.has('o1'));
  } finally { env.done(); }
});

test('S10-4: a response-handler bug is reported as such, never as "saved locally"', async () => {
  const env = saveEnv([row('m1')]);
  try {
    Persistence._dirtyIds.add('m1');
    env.mock(() => ({ get versions() { throw new Error('handler boom'); }, persisted: 1, updated: 1 }));
    Persistence.saveAll();
    await tick();
    assert.ok(env.cap.toasts.some(t => t.msg === 'toast.save_handler_error'));
    assert.ok(!env.cap.toasts.some(t => t.msg === 'toast.saved_locally'));
    assert.equal(Persistence._saveInFlight, false, 'the in-flight latch is released');
  } finally { env.done(); }
});

test('S10-7: the save body carries no blocks or calendars', async () => {
  const env = saveEnv([row('m1')]);
  try {
    Persistence._dirtyIds.add('m1');
    env.mock(() => ({ versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] }));
    Persistence.saveAll();
    await tick();
    const body = env.calls.find(c => c.url.includes('/tasks/update')).body;
    assert.ok(!('blocks' in body) && !('calendars' in body));
    assert.ok(Array.isArray(body.tasks));
  } finally { env.done(); }
});

test('S7-14: Save with nothing dirty toasts "Nothing to save", sends nothing, and prunes ids whose order is gone', async () => {
  const env = saveEnv([row('m1')]);
  try {
    Persistence._dirtyIds.add('ghost'); Persistence._forceIds.add('ghost'); Persistence._firmDirtyIds.add('ghost');
    env.mock(() => ({}));
    Persistence.saveAll();
    await tick();
    assert.equal(env.calls.length, 0);
    assert.ok(env.cap.toasts.some(t => t.msg === 'toast.nothing_to_save'));
    assert.equal(Persistence._dirtyIds.size, 0);
    assert.equal(Persistence._forceIds.size, 0);
    assert.equal(Persistence._firmDirtyIds.size, 0);
    assert.equal(Persistence._saveInFlight, false);
    env.cap.toasts.length = 0;
    Persistence.saveAll({ silent: true });
    assert.equal(env.cap.toasts.length, 0, 'programmatic callers stay quiet');
  } finally { env.done(); }
});

// ---- S7-8 ------------------------------------------------------------------------------------------------------

test('S7-8: a save that lands after the board was replaced still stamps the new version on an unchanged row', async () => {
  const env = saveEnv([row('m1', { row_version: 5 })]);
  try {
    Persistence._dirtyIds.add('m1');
    let release;
    globalThis.fetch = () => new Promise(res => { release = () => res({ ok: true, json: async () => ({ versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] }) }); });
    Persistence.saveAll();
    Store.setTasks([row('m1', { row_version: 5 })], 'unit-test');   // reload while the save is out: new generation
    Persistence._dirtyIds.clear();
    release();
    await tick();
    assert.equal(Store.tasks.m1.row_version, 6, 'the row adopted its own write\'s version');
    assert.ok(!env.cap.toasts.some(t => t.type === 'success'), 'toasts stay gated on the generation');
  } finally { env.done(); }
});

test('S7-8: a row whose version already moved on is not overwritten by a late response', async () => {
  const env = saveEnv([row('m1', { row_version: 5 })]);
  try {
    Persistence._dirtyIds.add('m1');
    let release;
    globalThis.fetch = () => new Promise(res => { release = () => res({ ok: true, json: async () => ({ versions: { m1: 6 }, persisted: 1, updated: 1, stale: [] }) }); });
    Persistence.saveAll();
    Store.setTasks([row('m1', { row_version: 9 })], 'unit-test');
    Persistence._dirtyIds.clear();
    release();
    await tick();
    assert.equal(Store.tasks.m1.row_version, 9);
  } finally { env.done(); }
});

// ---- S7-4 ------------------------------------------------------------------------------------------------------

test('S7-4: a rejected id that still matches what was sent is refreshed (bar snaps back) with the reason toast kept', async () => {
  const env = saveEnv([row('r1')]);
  try {
    Persistence._dirtyIds.add('r1');
    env.mock(call => call.url.includes('/tasks/refresh')
      ? { data: [{ id: 'r1', MACHINE: 'L1', RUN_TIME: 1, row_version: 12, planning_status: 'scheduled',
          start_date: '2026-09-09T06:00:00', end_date: '2026-09-09T07:00:00', schedule_segments: [] }], missing: [] }
      : { versions: {}, invalid_ids: ['r1'], rejection_reasons: { r1: 'width_mismatch' }, persisted: 0, updated: 1, stale: [] });
    Persistence.saveAll();
    await tick(); await tick();
    assert.equal(Store.tasks.r1.start_date.getTime(), d('2026-09-09T06:00:00').getTime());
    assert.equal(Store.tasks.r1.row_version, 12);
    assert.equal(Persistence._dirtyIds.size, 0);
    assert.ok(env.cap.toasts.some(t => t.msg === 'toast.partial_db_save_reasons'), 'the partial-save toast names the reason');
  } finally { env.done(); }
});

test('S7-4: a rejected id the planner edited again meanwhile is not refreshed over the newer edit', async () => {
  const env = saveEnv([row('r2')]);
  try {
    Persistence._dirtyIds.add('r2');
    let release;
    globalThis.fetch = (url) => String(url).includes('/tasks/refresh')
      ? Promise.reject(new Error('should not refresh'))
      : new Promise(res => { release = () => res({ ok: true, json: async () => ({ versions: {}, invalid_ids: ['r2'], persisted: 0, updated: 1, stale: [] }) }); });
    Persistence.saveAll();
    Store.updateTask('r2', { end_date: d('2026-09-09T12:00:00') }, 'unit-test');
    release();
    await tick();
    assert.ok(Persistence._dirtyIds.has('r2'), 'the newer edit stays pending');
    assert.equal(Store.tasks.r2.end_date.getTime(), d('2026-09-09T12:00:00').getTime());
  } finally { env.done(); }
});

// ---- S7-2 ------------------------------------------------------------------------------------------------------

test('S7-2: a failed conflict refresh is retried by the next Save for the still-conflicted ids', async () => {
  const env = saveEnv([row('c1')]);
  try {
    Persistence._dirtyIds.add('c1');
    let refreshCalls = 0;
    globalThis.fetch = (url, opts) => {
      if (String(url).includes('/tasks/refresh')) {
        refreshCalls++;
        assert.ok(opts.signal, 'the refresh carries a timeout signal');
        if (refreshCalls === 1) return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
        return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: 'c1', MACHINE: 'L1', RUN_TIME: 1, row_version: 7,
          planning_status: 'scheduled', start_date: '2026-09-09T08:00:00', end_date: '2026-09-09T09:00:00', schedule_segments: [] }], missing: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ versions: {}, stale: ['c1'], persisted: 0, updated: 1 }) });
    };
    Persistence.saveAll();
    await tick(); await tick();
    assert.equal(refreshCalls, 1);
    assert.ok(Persistence._conflictedIds.has('c1'), 'still blocked after the failed refresh');
    Persistence.saveAll();           // the next Save retries the refresh instead of staying wedged
    await tick(); await tick();
    assert.equal(refreshCalls, 2);
    assert.ok(!Persistence._conflictedIds.has('c1'));
    assert.equal(Store.tasks.c1.row_version, 7);
  } finally { env.done(); }
});

// ---- S7-1 ------------------------------------------------------------------------------------------------------

test('S7-1: a superseded load does not start its calendar/rate-map/setup hydration fan-out', async () => {
  const origFetch = globalThis.fetch, origFpc = CalendarSync.fetchPlantConfig;
  const cap = capture();
  const hydrated = [];
  let gate;
  const gated = new Promise(res => { gate = res; });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/tasks?plant=')) return Promise.resolve({ ok: true, json: async () => ({ data: [], meta: {} }) });
    return gated.then(() => ({ ok: false, status: 500, clone() { return this; }, json: async () => ({}), text: async () => '' }));
  };
  CalendarSync.fetchPlantConfig = async (plant) => { hydrated.push(plant); return true; };
  try {
    const a = Persistence.load({ force: true, plant: 'HA' });
    await tick();
    const b = Persistence.load({ force: true, plant: 'HB' });
    gate();
    await Promise.all([a, b]);
    await tick(); await tick();
    assert.ok(!hydrated.includes('HA'), `stale plant HA must not hydrate, saw ${hydrated}`);
    assert.ok(hydrated.includes('HB'));
  } finally {
    globalThis.fetch = origFetch; CalendarSync.fetchPlantConfig = origFpc; cap.restore();
    resetFlags(); Store.setTasks([], 'unit-test');
  }
});
