// Wave 2 (save and load safety) tests for frontend/scheduling/persistence.mjs:
// S7-1/2/3/4/5/7/8/9, S10-1/2/4/6/7, S7-14. Same split-realm-free, DOM-less environment as persistence.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence, cacheTiers } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Config, Toast } from '../../../frontend/platform/foundation.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';

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

test('S7-3: _loadCache(plant) rejects a cache written for another plant and accepts its own', () => {
  globalThis.localStorage.setItem(Config.LS_KEY, JSON.stringify({
    _schemaVersion: Config.SCHEMA_VERSION, selectedPlant: 'PA',
    tasks: [{ id: 'pa-1', MACHINE: 'L1', PLANT: 'PA', RUN_TIME: 1 }],
  }));
  const cap = capture();
  try {
    Store.setTasks([], 'unit-test');
    assert.equal(Persistence._loadCache('PB'), false, 'plant B must not show plant A orders');
    assert.equal(Store.tasks['pa-1'], undefined);
    assert.ok(globalThis.localStorage.getItem(Config.LS_KEY), 'the other plant\'s cache is kept, not deleted');
    assert.equal(Persistence._loadCache('PA'), true);
    assert.ok(Store.tasks['pa-1']);
  } finally {
    cap.restore(); resetFlags(); Store.setTasks([], 'unit-test');
    globalThis.localStorage.removeItem(Config.LS_KEY);
  }
});

test('S10-6: _cacheMatchesPlant accepts untagged caches and no requested plant, rejects a different tag', () => {
  assert.equal(Persistence._cacheMatchesPlant({ selectedPlant: 'PA' }, 'PA'), true);
  assert.equal(Persistence._cacheMatchesPlant({ selectedPlant: 'PA' }, 'PB'), false);
  assert.equal(Persistence._cacheMatchesPlant({ selectedPlant: null }, 'PB'), true);
  assert.equal(Persistence._cacheMatchesPlant({ selectedPlant: 'PA' }, undefined), true);
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
  globalThis.localStorage.setItem(Config.LS_KEY, JSON.stringify({
    _schemaVersion: Config.SCHEMA_VERSION, selectedPlant: 'PA',
    tasks: [{ id: 'pa-only', MACHINE: 'L1', PLANT: 'PA', RUN_TIME: 1 }],
  }));
  try {
    Store.setTasks([], 'unit-test');
    await Persistence.load({ force: true, plant: 'PB' });
    assert.equal(Store.tasks['pa-only'], undefined);
    assert.ok(cap.toasts.some(t => t.type === 'error'));
  } finally {
    globalThis.fetch = origFetch; Persistence._reconnect.start = origStart; cap.restore();
    globalThis.localStorage.removeItem(Config.LS_KEY); resetFlags(); Store.setTasks([], 'unit-test');
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

test('S7-9: quota tiers never evict dirty tasks; clean tasks are trimmed first', () => {
  const tasks = Array.from({ length: 3000 }, (_, i) => ({ id: `t${i}` }));
  const dirty = ['t0', 't5', 't17'];   // oldest ids: a plain slice(-N) would drop them
  const tiers = cacheTiers({ _schemaVersion: 7, _buildId: 'b', _savedAt: 'x', _optimizerDirtyIds: [], _dirtyIds: dirty,
    tasks, blocks: [], calendars: {}, plants: {}, plantBlocks: [], lineSettings: {}, selectedPlant: 'PA', userSettings: {} });
  assert.equal(tiers.length, 4);
  for (const tier of tiers) for (const id of dirty) assert.ok(tier.tasks.some(t => t.id === id), `${id} kept in every tier`);
  assert.equal(tiers[1].tasks.length, 2000);
  assert.equal(tiers[2].tasks.length, 500);
  assert.equal(tiers[3].tasks.length, 3, 'the last tier is exactly the dirty tasks');
  assert.deepEqual(tiers[3]._dirtyIds, dirty);
  assert.equal(tiers[3].selectedPlant, 'PA');
});

test('S7-9: a snapshot with optimizer-dirty ids is written whole (single tier)', () => {
  const snap = { _schemaVersion: 7, _optimizerDirtyIds: ['a'], _dirtyIds: ['a'], tasks: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(cacheTiers(snap).length, 1);
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
