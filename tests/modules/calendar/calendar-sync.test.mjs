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
