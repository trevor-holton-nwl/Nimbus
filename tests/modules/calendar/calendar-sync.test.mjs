// Tests for frontend/calendar/calendar-sync.mjs, split from
// tests/modules/schedule-data.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// into 3 domain files: scheduling/persistence.mjs, calendar/calendar-sync.mjs,
// security/session.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

test('CalendarSync is exported alongside Persistence with its documented public API', () => {
  assert.equal(typeof CalendarSync.fetchPlantConfig, 'function');
  assert.equal(typeof CalendarSync.savePlantHours, 'function');
  assert.equal(typeof CalendarSync.saveLineBlackoutUpsert, 'function');
  assert.equal(typeof CalendarSync.flushPlant, 'function');
});

test('CalendarSync discards legacy global plant blackout copies instead of fanning them out', () => {
  const priorMasterData = Store.masterData;
  const priorBlocks = Store.plantBlocks;
  const plants = [{ plant: '1006' }, { plant: '5512' }, { plant: '7000' }];
  const start = new Date('2026-08-18T08:00:00');
  const end = new Date('2026-08-18T12:00:00');
  try {
    Store.setMasterData({ plants, lines: [] }, 'test');
    Store.replacePlantBlocks([
      { id: 'legacy', plant: null, start, end, reason: 'old-global' },
      { id: 'legacy::1006', plant: '1006', start, end, reason: 'old-global' },
      { id: 'legacy::5512', plant: '5512', start, end, reason: 'old-global' },
      { id: 'legacy::7000', plant: '7000', start, end, reason: 'old-global' },
      { id: 'real-1006', plant: '1006', start, end, reason: 'plant-local' },
    ], 'test');
    CalendarSync._discardLegacyGlobalPlantBlocks();
    assert.deepEqual(Store.plantBlocks.map(b => b.id), ['real-1006']);
  } finally {
    Store.setMasterData(priorMasterData, 'test-restore');
    Store.replacePlantBlocks(priorBlocks, 'test-restore');
  }
});

test('CalendarSync discards legacy global line blackout copies instead of fanning them out', () => {
  const priorMasterData = Store.masterData;
  const priorBlocks = Store.blocks;
  const plants = [{ plant: '1006' }, { plant: '5512' }, { plant: '7000' }];
  const start = new Date('2026-08-18T08:00:00');
  const end = new Date('2026-08-18T12:00:00');
  try {
    Store.setMasterData({ plants, lines: [] }, 'test');
    Store.replaceBlocks([
      { id: 'legacy-line', plant: null, line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::1006', plant: '1006', line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::5512', plant: '5512', line: null, start, end, reason: 'old-global' },
      { id: 'legacy-line::7000', plant: '7000', line: null, start, end, reason: 'old-global' },
      { id: 'real-line', plant: '1006', line: 'LINE-1', start, end, reason: 'line-local' },
    ], 'test');
    CalendarSync._discardLegacyGlobalLineBlocks();
    assert.deepEqual(Store.blocks.map(b => b.id), ['real-line']);
  } finally {
    Store.setMasterData(priorMasterData, 'test-restore');
    Store.replaceBlocks(priorBlocks, 'test-restore');
  }
});

test('a failed blackout delete is remembered per plant, replayed before hydration, and filtered meanwhile (#19)', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  globalThis.window = globalThis.window || {};
  const priorFetch = globalThis.fetch, priorLs = globalThis.localStorage, priorToast = Toast.show;
  const store = new Map();
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  let ok = false;
  const posted = [];
  globalThis.fetch = (url, opts) => { posted.push({ url: String(url), body: JSON.parse(opts.body) }); return Promise.resolve({ ok, status: ok ? 200 : 503 }); };
  const toasts = [];
  Toast.show = (msg, type, ms, action) => { toasts.push({ msg, type, action }); };
  try {
    const res = await CalendarSync.saveLineBlackoutDelete('P1', 'blk-1');
    assert.equal(res.ok, false);
    assert.deepEqual(JSON.parse(store.get('nimbus.calendar.pendingDeletes')), { P1: { line: ['blk-1'], plant: [] } });
    // While unconfirmed, the backend list must not resurrect it locally.
    const cfg = { machine_blackouts: [{ id: 'blk-1' }, { id: 'blk-2' }], plant_blackouts: [] };
    assert.deepEqual(CalendarSync._withoutPendingDeletes('P1', cfg).machine_blackouts.map(b => b.id), ['blk-2']);
    // Next load: replay succeeds, pending list clears.
    ok = true; posted.length = 0;
    await CalendarSync._replayPendingDeletes('P1');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { plant: 'P1', deletes: ['blk-1'] });
    assert.equal(store.has('nimbus.calendar.pendingDeletes'), false);
  } finally {
    globalThis.fetch = priorFetch; Toast.show = priorToast;
    if (priorLs === undefined) delete globalThis.localStorage; else globalThis.localStorage = priorLs;
  }
});

test('a failed hours/upsert save toasts honestly with a Retry action instead of promising a sync (#19)', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  globalThis.window = globalThis.window || {};
  const priorFetch = globalThis.fetch, priorToast = Toast.show;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; return Promise.resolve({ ok: false, status: 503 }); };
  const toasts = [];
  Toast.show = (msg, type, ms, action) => { toasts.push({ msg, type, action }); };
  try {
    await CalendarSync.savePlantHours('P1', { 1: [8, 16] });
    assert.equal(toasts.length, 1);
    assert.ok(toasts[0].action && typeof toasts[0].action.run === 'function', 'a Retry action is attached');
    toasts[0].action.run();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(calls, 2, 'Retry re-sends the same write');
  } finally {
    globalThis.fetch = priorFetch; Toast.show = priorToast;
  }
});

test('re-upserting a blackout id clears it from the pending-delete set (no stale replayed delete)', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  globalThis.window = globalThis.window || {};
  const priorToast = Toast.show; Toast.show = () => {};
  const priorFetch = globalThis.fetch, priorLs = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
  try {
    CalendarSync._trackPendingDeletes('P1', 'line', ['blk-1'], true);
    CalendarSync._trackPendingDeletes('P1', 'plant', ['pb-1'], true);
    await CalendarSync.saveLineBlackoutUpsert({ id: 'blk-1', plant: 'P1', line: 'L1', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
    await CalendarSync.savePlantBlackoutUpsert({ id: 'pb-1', plant: 'P1', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
    assert.equal(store.has('nimbus.calendar.pendingDeletes'), false);
  } finally {
    globalThis.fetch = priorFetch; Toast.show = priorToast;
    if (priorLs === undefined) delete globalThis.localStorage; else globalThis.localStorage = priorLs;
  }
});

function calSyncEnv(Toast) {
  globalThis.window = globalThis.window || {};
  const prior = { fetch: globalThis.fetch, ls: globalThis.localStorage, toast: Toast.show };
  const store = new Map();
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const toasts = [];
  Toast.show = (msg, type, ms, action) => { toasts.push({ msg, type, action }); };
  return {
    store, toasts,
    restore() {
      globalThis.fetch = prior.fetch; Toast.show = prior.toast;
      if (prior.ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = prior.ls;
    },
  };
}

test('Retry rebuilds the body from CURRENT state, not the stale captured body (senior audit)', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  const env = calSyncEnv(Toast);
  const priorPlants = Store.plants;
  const posted = [];
  globalThis.fetch = (url, opts) => { posted.push(JSON.parse(opts.body)); return Promise.resolve({ ok: false, status: 503 }); };
  try {
    Store.replacePlants({ ...Store.plants, PR: { workHours: { 1: [8, 16] } } }, 'test');
    await CalendarSync.savePlantHours('PR', Store.plants.PR.workHours);
    Store.replacePlants({ ...Store.plants, PR: { workHours: { 1: [6, 14] } } }, 'test'); // edited after the failure
    env.toasts[0].action.run();
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(posted.at(-1).work_hours, { 1: [6, 14] }, 'Retry sends the current hours');

    // A blackout deleted since the failed upsert must not be resurrected by Retry.
    posted.length = 0; env.toasts.length = 0;
    Store.replaceBlocks([], 'test');
    await CalendarSync.saveLineBlackoutUpsert({ id: 'gone-1', plant: 'PR', line: 'L1', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
    env.toasts[0].action.run();
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(posted.at(-1), { plant: 'PR', deletes: ['gone-1'] }, 'a block removed since is re-sent as a delete, never an upsert');
  } finally {
    env.restore(); Store.replacePlants(priorPlants, 'test-restore'); Store.replaceBlocks([], 'test-restore');
  }
});

test('pending-delete replay: 404 counts as done, a permanent 403/409 drops the ids with a warning, 5xx stays pending', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  const env = calSyncEnv(Toast);
  let status = 404;
  globalThis.fetch = () => Promise.resolve({ ok: status < 400, status });
  const key = 'nimbus.calendar.pendingDeletes';
  try {
    CalendarSync._trackPendingDeletes('P1', 'line', ['b1'], true);
    await CalendarSync._replayPendingDeletes('P1');
    assert.equal(env.store.has(key), false, '404 = already deleted');

    status = 503; CalendarSync._trackPendingDeletes('P1', 'line', ['b2'], true);
    await CalendarSync._replayPendingDeletes('P1');
    assert.equal(env.store.has(key), true, 'transient failure stays pending');
    assert.equal(env.toasts.length, 0);

    status = 403;
    await CalendarSync._replayPendingDeletes('P1');
    assert.equal(env.store.has(key), false, 'permanent rejection is dropped, not hidden forever');
    assert.equal(env.toasts.filter(t => t.type === 'warn').length, 1, 'exactly one warning');
    await CalendarSync._replayPendingDeletes('P1');
    assert.equal(env.toasts.length, 1, 'nothing left to warn about on the next replay');
  } finally { env.restore(); }
});

test('fetchPlantConfig replays pending deletes BEFORE applying the config and filters unconfirmed ids; a confirmed delete clears pending', async () => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  const env = calSyncEnv(Toast);
  const priorBlocks = Store.blocks.slice(), priorMasterData = Store.masterData;
  const calls = [];
  let replayOk = false;
  const cfg = { machine_blackouts: [
    { id: 'blk-1', machine: 'L1', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', reason: '' },
    { id: 'blk-2', machine: 'L1', start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z', reason: '' },
  ], plant_blackouts: [] };
  globalThis.fetch = (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${String(url).split('?')[0]}`);
    if (opts.method === 'POST') return Promise.resolve({ ok: replayOk, status: replayOk ? 200 : 503 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cfg) });
  };
  try {
    Store.setMasterData({ plants: [{ plant: 'P1' }], lines: [{ plant: 'P1', machine: 'L1' }] }, 'test');
    // A confirmed delete clears the pending set.
    replayOk = true;
    await CalendarSync.saveLineBlackoutDelete('P1', 'blk-1');
    assert.equal(env.store.has('nimbus.calendar.pendingDeletes'), false, 'confirmed delete leaves nothing pending');

    // An unconfirmed one is replayed first, and filtered from the applied config while unconfirmed.
    replayOk = false; calls.length = 0;
    await CalendarSync.saveLineBlackoutDelete('P1', 'blk-1');
    calls.length = 0;
    await CalendarSync.fetchPlantConfig('P1');
    assert.match(calls[0], /^GET /);
    assert.match(calls[1], /^POST .*line-blackouts/, 'replay is wired between GET and apply');
    assert.deepEqual(Store.blocks.filter(b => b.plant === 'P1').map(b => b.id), ['blk-2'], 'unconfirmed delete stays hidden locally');

    replayOk = true;
    await CalendarSync.fetchPlantConfig('P1');
    assert.equal(env.store.has('nimbus.calendar.pendingDeletes'), false, 'replay success clears pending');
  } finally {
    env.restore(); Store.replaceBlocks(priorBlocks, 'test-restore'); Store.setMasterData(priorMasterData, 'test-restore');
  }
});
