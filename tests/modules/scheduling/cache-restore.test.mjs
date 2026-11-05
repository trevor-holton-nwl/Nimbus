// T3 + T4: the compact cache record written through CacheStore and restored in Persistence.load().
// Covers: 5000-row round trip, "already saved" silence, whole-group refusal (moved version, missing row, unmatched),
// the deferred (partial load) case, foreign-plant record kept, deliberate discard, the never-write guards, seq mismatch,
// the flush path, baselines + the Unsaved dialog before/after, the Apply-time context warning and Firm restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { CacheStore, LS_RECORD_PREFIX, MARKER_KEY } from '../../../frontend/platform/cache-store.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { applySchedulePatches } from '../../../frontend/optimization/engine.mjs';
import { App } from '../../../frontend/shell/application-shell.mjs';
import { UnsavedDialog } from '../../../frontend/scheduling/unsaved-dialog.mjs';
import { makeFakeBackend } from '../helpers/cache-backend-fake.mjs';
import { resetCacheEnv, readRecord, simulateReload, CACHE_USER } from '../helpers/cache-env.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const pad = n => String(n).padStart(2, '0');
// day 1 = 2026-10-01; real calendar arithmetic so 5000 rows never produce an impossible date (a naive local timestamp).
const stamp = (day, hour) => { const d = new Date(2026, 9, day, hour); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`; };
// Distinct, non-overlapping rows: 8 per day, one hour each.
const serverRow = (i, extra = {}) => ({ id: `R${i}`, PLANT: 'P', MATERIAL_NUMBER: `MAT${i}`, MACHINE: `M${i % 5}`,
  'ORDER_QUANTITY_(GMEIN)': 60, PRODUCTION_VERSION: null, PRT_01: null, PRT_02: null, RUN_TIME: 1, run_time_source: 'manual',
  row_version: 1, planning_status: 'scheduled', planning_reason: null, placement_exception: null, user_scheduled: true,
  original_start_date: stamp(1 + Math.floor(i / 8), 8 + (i % 8)), start_date: stamp(1 + Math.floor(i / 8), 8 + (i % 8)),
  end_date: stamp(1 + Math.floor(i / 8), 9 + (i % 8)), schedule_segments: [], ...extra });
const shiftDay = (id, days = 10) => {
  const t = Store.tasks[id];
  return { id, changes: { start_date: new Date(t.start_date.getTime() + days * 86400000), end_date: new Date(t.end_date.getTime() + days * 86400000) } };
};

/** Board of `n` server rows loaded for plant P, with App's dirty tracker wired like the real shell. */
function fixture(t, n = 6) {
  globalThis.window = {};
  globalThis.document = { getElementById: () => null };
  const lsf = resetCacheEnv();
  const toasts = [];
  for (const method of ['info', 'warn', 'error']) t.mock.method(ErrorLog, method, () => {});
  t.mock.method(Toast, 'show', (msg, type) => { toasts.push({ msg, type }); });
  t.mock.method(CalendarSync, 'fetchPlantConfig', async () => {});
  t.mock.method(Persistence, 'loadPriorityRankMaps', async () => {});
  t.mock.method(Persistence, 'loadSetupSnapshot', async () => null);
  t.mock.method(Runtime, 'load', async () => {});
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource', '_refreshRetry']) Persistence[k].clear();
  Persistence._savedBaseline.clear();
  Persistence._cacheWritesHalted = false; Persistence._cacheHoldPlant = null; Persistence._applyContext = null;
  Store.setMasterData({ plants: [{ plant: 'P', routing_runtime_enabled: true, split_order_policy: 'partial_allowed',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }], lines: [] }, 'test');
  const priorOffset = Store.serverOffsetMs;
  Store.serverOffsetMs = new Date('2026-09-01T00:00:00').getTime() - Date.now();
  const off = Store.subscribe(evt => App._trackDirty(evt), 'cache-restore-test-dirty-tracker');
  t.after(() => {
    off(); Store.serverOffsetMs = priorOffset; Store._blockedPlants.clear();
    for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource']) Persistence[k].clear();
    Persistence._savedBaseline.clear(); Persistence._cacheHoldPlant = null; Persistence._applyContext = null;
    Persistence._calendarVersion = {}; Persistence._toolInventoryBaseline = {};
    Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  });
  Store.setSelectedPlant('P', 'test');
  const server = Array.from({ length: n }, (_, i) => serverRow(i));
  Store.setTasks(server.map(r => Persistence._prepTask(structuredClone(r))), 'persistence');
  Persistence._currentLoadedPlant = 'P';
  return { server, toasts, lsf };
}
function mockServer(t, rows) {
  t.mock.method(Util, 'fetchTraced', async url => ({ ok: true, json: async () =>
    url.includes('/tasks?') ? { data: structuredClone(rows), meta: {}, links: [] }
      : url.endsWith('/system-settings') ? {} : { rows: [] } }));
}
/** The page is closed and reopened: memory is empty, the cache record (localStorage) survives; then load P. */
async function reopen(t, rows, plant = 'P') {
  await simulateReload();
  for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource']) Persistence[k].clear();
  Persistence._savedBaseline.clear();
  Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  mockServer(t, rows);
  await Persistence.load({ plant }); await tick();
}
const notRestored = toasts => toasts.filter(x => x.msg === 'toast.cache_not_restored');

test('5000 unsaved Apply rows round trip: restored whole, dirty + force-dirty, source back, every row baselined', async t => {
  const f = fixture(t, 5000);
  const ids = f.server.map(r => r.id);
  Store.updateMany(ids.map(id => shiftDay(id)), 'engine');
  assert.equal(Persistence._forceIds.size, 5000, 'precondition: the real dirty tracker marked the Apply');
  assert.equal(Persistence._dirtySource.get('R0'), 'optimizer');
  Persistence._saveCache();
  const rec = readRecord('P');
  assert.equal(rec.rows.length, 5000);
  assert.equal(rec.optimizerIds.length, 5000);
  assert.ok(JSON.stringify(rec).length < 4_000_000, 'compact: dirty rows only, projected fields');
  const moved = Store.tasks.R7.start_date.getTime();
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.size, 5000);
  assert.equal(Persistence._forceIds.size, 5000, 'the batch is restored as one atomic group');
  assert.equal(Persistence._dirtySource.get('R42'), 'optimizer', 'the per-row source is restored');
  assert.equal(Store.tasks.R7.start_date.getTime(), moved, 'the Apply values are on the board, not the server values');
  assert.equal(Persistence._savedBaseline.size, 5000, 'every row (restored ones included) has a server baseline');
  assert.deepEqual(notRestored(f.toasts), []);
  // Unsaved dialog: before = the server row, after = the restored Apply.
  const { rows } = UnsavedDialog.compute();
  assert.equal(rows.length, 5000);
  const r7 = rows.find(r => r.id === 'R7');
  assert.equal(r7.hasBaseline, true);
  assert.equal(r7.source, 'optimizer');
  const start = r7.fields.find(x => x.key === 'start');
  assert.equal(start.before.getTime(), new Date(stamp(1, 15)).getTime(), 'before is the saved (server) start');
  assert.equal(start.after.getTime(), moved);
});

test('already saved: every row moved on and the server holds the cached values, so nothing is restored and nothing is said', async t => {
  const f = fixture(t, 6);
  Store.updateMany(['R0', 'R1', 'R2'].map(id => shiftDay(id)), 'engine');   // the batch
  Store.updateMany([shiftDay('R4', 3)], 'table');                            // a manual edit
  Persistence._saveCache();
  // The save landed before the crash: the server rows carry the edited values at a newer version.
  const saved = f.server.map(r => {
    if (!['R0', 'R1', 'R2', 'R4'].includes(r.id)) return r;
    const live = Store.tasks[r.id];
    return { ...r, row_version: 2, start_date: Util.toLocalSeconds(live.start_date), end_date: Util.toLocalSeconds(live.end_date) };
  });
  await reopen(t, saved);
  assert.equal(Persistence._dirtyIds.size, 0, 'treated as saved');
  assert.deepEqual(notRestored(f.toasts), [], 'silent: no false "not restored" toast');
  assert.equal(Store.tasks.R0.row_version, 2);
});

test('refuse: one stale member discards the WHOLE optimizer group (rows stay at server values), one toast, record rewritten clean', async t => {
  const f = fixture(t, 6);
  Store.updateMany(['R0', 'R1', 'R2'].map(id => shiftDay(id)), 'engine');
  Store.updateMany([shiftDay('R4', 3)], 'table');
  Persistence._saveCache();
  const server = f.server.map(r => (r.id === 'R1' ? { ...r, row_version: 2, PRT_01: 'ELSEWHERE' } : r));   // someone else changed R1
  const manualMoved = Store.tasks.R4.start_date.getTime();
  await reopen(t, server);
  for (const id of ['R0', 'R1', 'R2']) {
    assert.equal(Persistence._dirtyIds.has(id), false, `${id} not dirty`);
    assert.equal(Store.tasks[id].start_date.getDate(), Number(f.server.find(r => r.id === id).start_date.slice(8, 10)), `${id} at server value`);
  }
  assert.equal(Persistence._forceIds.size, 0);
  assert.equal(notRestored(f.toasts).length, 1, 'exactly one toast for the group');
  assert.equal(Persistence._dirtyIds.has('R4'), true, 'the independent manual edit is still restored');
  assert.equal(Store.tasks.R4.start_date.getTime(), manualMoved);
  assert.deepEqual(readRecord('P').rows.map(r => r.id), ['R4'], 'the dropped group is gone from the rewritten record');
});

test('refuse: a missing order, or a cached row without a version, also refuses the whole group', async t => {
  const f = fixture(t, 6);
  Store.updateMany(['R0', 'R1', 'R2'].map(id => shiftDay(id)), 'engine');
  Persistence._saveCache();
  await reopen(t, f.server.filter(r => r.id !== 'R2'));
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.equal(notRestored(f.toasts).length, 1);

  const g = fixture(t, 6);
  g.server.forEach(r => { r.row_version = null; });
  Store.setTasks(g.server.map(r => Persistence._prepTask(structuredClone(r))), 'persistence');
  Store.updateMany(['R0', 'R1'].map(id => shiftDay(id)), 'engine');
  Persistence._saveCache();
  await reopen(t, g.server);
  assert.equal(Persistence._dirtyIds.size, 0, 'null row_version cannot prove the server row is unchanged');
  assert.equal(notRestored(g.toasts).length, 1);
});

test('a server row that failed to prepare defers the restore: nothing discarded, the record is untouched and writes are held', async t => {
  const f = fixture(t, 6);
  Store.updateMany(['R0', 'R1', 'R2'].map(id => shiftDay(id)), 'engine');
  Persistence._saveCache();
  const before = CacheStore.peek('P').json;
  const orig = Persistence._prepTask;
  t.mock.method(Persistence, '_prepTask', raw => { if (raw.id === 'R2') throw new Error('bad row'); return orig.call(Persistence, raw); });
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.size, 0, 'the batch is not applied on a partial board');
  assert.deepEqual(notRestored(f.toasts), [], 'and it is not announced as discarded either');
  assert.equal(Persistence._cacheHoldPlant, 'P');
  Persistence._saveCache();
  assert.equal(CacheStore.peek('P').json, before, 'writes are held: the record survives for the next good load');
});

test('manual rows: per-row rules. A row whose version moved is skipped with a toast, an attribute-only edit is reported, a date move restores', async t => {
  const f = fixture(t, 6);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Store.updateMany([shiftDay('R1', 2)], 'table');
  Store.updateMany([{ id: 'R2', changes: { PRT_01: 'TOOL' } }], 'table');
  Persistence._saveCache();
  const server = f.server.map(r => (r.id === 'R1' ? { ...r, row_version: 5 } : r));
  await reopen(t, server);
  assert.equal(Persistence._dirtyIds.has('R0'), true, 'date move restored');
  assert.equal(Persistence._dirtyIds.has('R1'), false, 'version moved: server wins');
  assert.equal(Persistence._dirtyIds.has('R2'), false, 'attribute-only edits are not restorable (unchanged rule)...');
  assert.equal(notRestored(f.toasts).length, 1, '...but they are reported, never silently dropped');
});

test('a foreign-plant record is kept: loading plant P never reads, rewrites or deletes plant Q\'s unsaved record', async t => {
  const f = fixture(t, 4);
  f.server.forEach(r => { r.PLANT = 'Q'; });
  Store.setTasks(f.server.map(r => Persistence._prepTask(structuredClone(r))), 'persistence');
  Persistence._currentLoadedPlant = 'Q';
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  const qKey = `${LS_RECORD_PREFIX}${CACHE_USER}|Q`;
  const qBefore = f.lsf.map.get(qKey);
  assert.ok(qBefore);
  await reopen(t, Array.from({ length: 3 }, (_, i) => serverRow(i)), 'P');
  assert.equal(Persistence._dirtyIds.size, 0, 'plant P shows plant P server values only');
  assert.equal(f.lsf.map.get(qKey), qBefore, 'Q\'s record is byte-for-byte untouched');
});

test('a deliberate discard clears the record: nothing is resurrected next boot, and the null plant stops later writes', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  assert.ok(CacheStore.peek('P'));
  Persistence.discardUnsavedForPlantSwitch();
  assert.equal(CacheStore.peek('P'), null, 'the outgoing plant\'s record is discarded explicitly');
  Persistence._saveCache();   // an autosave tick after the discard, before the next load
  assert.equal(CacheStore.peek('P'), null, 'a null loaded plant never writes, so the discarded edits are not re-recorded');
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.size, 0);
  assert.deepEqual(notRestored(f.toasts), []);
});

test('never writes: no plant loaded, What-If active, the system actor, halted', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  const key = `${LS_RECORD_PREFIX}${CACHE_USER}|P`;
  const records = () => [...f.lsf.map.keys()].filter(k => k.startsWith(LS_RECORD_PREFIX));
  Persistence._currentLoadedPlant = null;     // empty board / failed boot load
  Persistence._saveCache();
  assert.deepEqual(records(), [], 'null plant');
  Persistence._currentLoadedPlant = 'P';
  Sandbox.active = true;
  try { Persistence._saveCache(); } finally { Sandbox.active = false; }
  assert.deepEqual(records(), [], 'What-If');
  Util.setActorResolver(() => undefined);
  Persistence._saveCache();
  assert.deepEqual(records(), [], 'system actor');
  Util.setActorResolver(() => CACHE_USER);
  Persistence._saveCache();
  assert.deepEqual(records(), [key], 'positive control: with a plant, an actor and no What-If it writes');
  Persistence.haltCacheWrites();
  Persistence._dirtyIds.add('R1');
  f.lsf.map.delete(key);
  Persistence._saveCache();
  assert.deepEqual(records(), [], 'halted');
});

test('the record plant tag is the LOADED plant, also after the boot load (Store.selectedPlant still null)', async t => {
  const f = fixture(t, 4);
  Store.setSelectedPlant(null, 'test');
  assert.equal(Store.selectedPlant, null);
  await simulateReload();
  Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  mockServer(t, f.server);
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(Persistence._currentLoadedPlant, 'P');
  const rec = readRecord('P');
  assert.ok(rec, 'the load wrote its record');
  assert.equal(rec.plant, 'P', 'tagged with the loaded plant, not the null selection');
  assert.equal(CacheStore.rememberedPlant(), 'P', 'so the next boot scopes to it');
});

test('seq mismatch: a record older than the marker is restored and one toast says it may be missing recent changes', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  const key = `${LS_RECORD_PREFIX}${CACHE_USER}|P`;
  const old = f.lsf.map.get(key);
  Store.updateMany([shiftDay('R1', 2)], 'table');
  Persistence._saveCache();                       // marker seq now ahead of the stored record below
  f.lsf.map.set(key, old);                        // the newer put never landed: the older record survived
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.has('R0'), true, 'the older record is still restored');
  assert.equal(f.toasts.filter(x => x.msg === 'toast.cache_older_record').length, 1);
});

test('a marker that says dirty with no record toasts once and clears the marker', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  f.lsf.map.delete(`${LS_RECORD_PREFIX}${CACHE_USER}|P`);
  await reopen(t, f.server);
  assert.equal(f.toasts.filter(x => x.msg === 'toast.cache_dirty_no_record').length, 1);
  assert.equal(Persistence._dirtyIds.size, 0);
});

test('flush path: flushCache starts the queued put in its own transaction while an earlier put is still in flight', async t => {
  const fake = makeFakeBackend({ name: 'idb' });
  const f = fixture(t, 4);
  resetCacheEnv({ backend: { idb: fake.backend } });
  await CacheStore.ready(CACHE_USER);
  fake.ctl.hold = 1;                                  // the first put stays in flight
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  assert.equal(fake.ctl.puts.length, 1);
  Store.updateMany([shiftDay('R1', 2)], 'table');
  Persistence._saveCache();                           // queued behind the in-flight put
  assert.equal(fake.ctl.puts.length, 1, 'precondition: the second write is only queued');
  Persistence.flushCache();                           // visibilitychange -> hidden
  await tick();
  assert.equal(fake.ctl.puts.length, 2, 'flush created its own put at once instead of waiting');
  fake.release();
  await CacheStore.settled();
  assert.ok(f.toasts.every(x => x.msg !== 'toast.cache_put_failed'));
  CacheStore._setBackendForTests();
});

test('Apply captures the context fingerprints at Apply time; a restored Apply warns only when that context has since changed', async t => {
  const f = fixture(t, 4);
  Persistence._calendarVersion.P = 'cal-v1';
  Persistence._toolInventoryBaseline.P = 'tool-v1';
  applySchedulePatches([shiftDay('R0'), shiftDay('R1')]);          // real engine entry point: writes the record at once
  let rec = readRecord('P');
  assert.deepEqual(rec.applyContext.calendar, 'cal-v1');
  assert.deepEqual(rec.applyContext.tools, 'tool-v1');
  assert.equal(rec.optimizerIds.length, 2);
  Persistence._calendarVersion.P = 'cal-v2';                        // a remote change after the Apply...
  Store.updateMany([shiftDay('R3', 2)], 'table');
  Persistence._saveCache();                                         // ...must not be absorbed into the record
  rec = readRecord('P');
  assert.equal(rec.applyContext.calendar, 'cal-v1', 'the first unsaved Apply\'s context is kept');

  // Same context on reopen: no warning.
  t.mock.method(CalendarSync, 'fetchPlantConfig', async () => { Persistence._calendarVersion.P = 'cal-v1'; Persistence._toolInventoryBaseline.P = 'tool-v1'; });
  await reopen(t, f.server);
  assert.equal(Persistence._forceIds.size, 2, 'the Apply is restored');
  assert.equal(f.toasts.filter(x => x.msg === 'toast.cache_context_changed').length, 0);

  // The calendar moved on while the app was closed: restore anyway, and warn once.
  await simulateReload();
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  CalendarSync.fetchPlantConfig.mock.restore();
  t.mock.method(CalendarSync, 'fetchPlantConfig', async () => { Persistence._calendarVersion.P = 'cal-v9'; });
  mockServer(t, f.server);
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(Persistence._forceIds.size, 2, 'restored anyway');
  assert.equal(f.toasts.filter(x => x.msg === 'toast.cache_context_changed').length, 1);
});

test('an unsaved Firm/Unfirm survives a crash: re-applied after setTasks, firm-dirty, firmed on the board', async t => {
  const f = fixture(t, 4);
  Store.setFirmed(['R0'], true, 'table');
  assert.equal(Persistence._firmDirtyIds.has('R0'), true);
  Persistence._saveCache();
  assert.deepEqual(readRecord('P').firmDirtyIds, ['R0']);
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.has('R0'), true);
  assert.equal(Persistence._firmDirtyIds.has('R0'), true);
  assert.equal(Store.isFirmed('R0'), true);
  assert.equal(Store.tasks.R0.firmed, true);
  assert.equal(Persistence._taskEditSnapshot(Store.tasks.R0).FIRMED, true, 'so the next Save sends the firm');
  assert.deepEqual(notRestored(f.toasts), []);
});

test('the restored baseline lets an undo back to the saved state settle a restored manual row', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.has('R0'), true);
  const base = Persistence._savedBaseline.get('R0');
  assert.equal(base.version, 1);
  // Put the row back exactly where the server has it, then settle: the baseline proves it equals the saved state.
  Store.updateMany([shiftDay('R0', -2)], 'undo');
  Persistence.settleRestored(['R0']);
  assert.equal(Persistence._dirtyIds.has('R0'), false);
});

test('storageInventory is synchronous, built from the store stats, never reports a latch', async t => {
  fixture(t, 3);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  const inv = Persistence.storageInventory();
  assert.equal(inv.autosaveDisabled, false);
  assert.equal(inv.failed, 0);
  assert.equal(inv.pending, 0);
  assert.ok(['fallback', 'localstorage', 'idb'].includes(inv.mode));
  assert.ok(inv.lastBytes > 0);
  assert.ok(inv.lastSavedAt > 0);
  assert.equal(typeof inv.then, 'undefined', 'not a promise');
  assert.ok(MARKER_KEY.startsWith('nimbus.cache'));
});
