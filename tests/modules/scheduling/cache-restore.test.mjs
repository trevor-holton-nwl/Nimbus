// T3 + T4: the compact cache record written through CacheStore and restored in Persistence.load().
// Covers: 5000-row round trip, "already saved" silence, whole-group refusal (moved version, missing row, unmatched),
// the deferred (partial load) case, foreign-plant record kept, deliberate discard, the never-write guards, seq mismatch,
// the flush path, baselines + the Unsaved dialog before/after, the Apply-time context warning and Firm restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, ErrorLog, Modal, Config } from '../../../frontend/platform/foundation.mjs';
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

test('manual rows: per-row rules. A row whose version moved is skipped with a toast, an attribute-only edit and a date move restore', async t => {
  const f = fixture(t, 6);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Store.updateMany([shiftDay('R1', 2)], 'table');
  Store.updateMany([{ id: 'R2', changes: { PRT_01: 'TOOL' } }], 'table');
  Persistence._saveCache();
  const server = f.server.map(r => (r.id === 'R1' ? { ...r, row_version: 5 } : r));
  await reopen(t, server);
  assert.equal(Persistence._dirtyIds.has('R0'), true, 'date move restored');
  assert.equal(Persistence._dirtyIds.has('R1'), false, 'version moved: server wins');
  assert.equal(Persistence._dirtyIds.has('R2'), true, 'an attribute-only edit on an unchanged server row is restored (equal version proves it)');
  assert.equal(Store.tasks.R2.PRT_01, 'TOOL');
  assert.equal(notRestored(f.toasts).length, 1, 'only the version-moved row (R1) is reported; the attribute-only edit is no longer lost');
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
  assert.equal(readRecord('P'), null, 'a clean load stores no empty record');
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  const rec = readRecord('P');
  assert.ok(rec, 'the first unsaved edit writes the record');
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
  resetCacheEnv({ backend: { defaultBackend: 'idb', idb: fake.backend } });
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

/* ------------------------------------------------ adversarial review fixes (2026-11-04) */

const recKey = plant => `${LS_RECORD_PREFIX}${CACHE_USER}|${plant}`;
const placeRow = (id, start, end, extra = {}) => ({ id, changes: { start_date: start, end_date: end, planning_status: 'scheduled', planning_reason: null, user_scheduled: true, ...extra } });

test('B1 a plant record the marker does not name is READ before the restore, and the load never overwrites it', async t => {
  const f = fixture(t, 4);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  assert.ok(f.lsf.map.get(recKey('P')));
  // The planner then visited plant Q (clean): the marker names Q, P's unsaved record is only reachable by reading it.
  CacheStore.write({ user: CACHE_USER, plant: 'Q', dirty: false, rows: 1 }, JSON.stringify({ rows: [{ id: 'x' }] }));
  assert.equal(JSON.parse(f.lsf.map.get(MARKER_KEY)).plant, 'Q');
  await reopen(t, f.server, 'P');
  assert.equal(Persistence._dirtyIds.has('R0'), true, 'P\'s unsaved edit is restored although the marker named Q');
  assert.ok(f.lsf.map.get(recKey('P')), 'and its record still exists');
  assert.equal(readRecord('P').rows.length, 1);
});

test('B1 a record whose read FAILS is not overwritten: writes are held and the planner is told', async t => {
  const fake = makeFakeBackend({ name: 'idb' });
  const f = fixture(t, 4);
  resetCacheEnv({ backend: { defaultBackend: 'idb', idb: fake.backend } });
  await CacheStore.ready(CACHE_USER);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  await CacheStore.settled();
  const stored = JSON.stringify(fake.data.get(`${CACHE_USER}|P`));
  fake.ctl.failGet = true;
  await simulateReload({ backend: { defaultBackend: 'idb', idb: fake.backend } });
  Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  mockServer(t, f.server);
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(f.toasts.some(x => x.msg === 'toast.cache_read_failed'), true, 'the planner is told');
  Store.updateMany([shiftDay('R1', 2)], 'table');
  Persistence._saveCache();
  await CacheStore.settled();
  assert.equal(JSON.stringify(fake.data.get(`${CACHE_USER}|P`)), stored, 'the unread record is untouched');
  CacheStore._setBackendForTests();
});

test('B2 the boot default-plant one-shot is skipped while unsaved work (or a dirty marker) exists', async t => {
  const f = fixture(t, 3);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  assert.equal(Persistence._rememberedDirty(), true, 'the marker says the remembered plant holds unsaved edits');
  const src = (await import('node:fs')).readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const guard = src.indexOf('Persistence._rememberedDirty()');
  const apply = src.indexOf("Store.setSelectedPlant(dp, 'default-plant')");
  assert.ok(guard > 0 && guard < apply, 'the guard runs before the one-shot sets the plant');
  Persistence._dirtyIds.clear(); Persistence._saveCache();
  assert.equal(Persistence._rememberedDirty(), false, 'clean again');
  void f;
});

test('B3 manual rows: a Slot of a Needs Planning order and a placement on a row without a baseline start are restored whole', async t => {
  const f = fixture(t, 6);
  const queued = { planning_status: 'needs_planning', planning_reason: { code: 'no_slot' }, start_date: null, end_date: null,
    original_start_date: null, user_scheduled: false, schedule_segments: [] };
  const noBaseline = { original_start_date: null };
  const server = f.server.map(r => (r.id === 'R0' ? { ...r, ...queued } : r.id === 'R1' ? { ...r, ...noBaseline } : r));
  Store.setTasks(server.map(r => Persistence._prepTask(structuredClone(r))), 'persistence');
  const slot = new Date(2026, 9, 20, 8), slotEnd = new Date(2026, 9, 20, 9);
  Store.updateMany([placeRow('R0', slot, slotEnd)], 'table');
  const r1 = Store.tasks.R1;
  Store.updateMany([placeRow('R1', new Date(r1.start_date.getTime() + 2 * 86400000), new Date(r1.end_date.getTime() + 2 * 86400000))], 'table');
  const movedR1 = Store.tasks.R1.start_date.getTime();
  Persistence._saveCache();
  await reopen(t, server);
  assert.equal(Persistence._dirtyIds.has('R0'), true, 'the Slot survives');
  assert.equal(Store.tasks.R0.planning_status, 'scheduled');
  assert.equal(Store.tasks.R0.start_date.getTime(), slot.getTime());
  assert.equal(Persistence._dirtyIds.has('R1'), true, 'a placement on a row with a null original start survives');
  assert.equal(Store.tasks.R1.start_date.getTime(), movedR1);
  assert.deepEqual(notRestored(f.toasts), []);
});

test('B3 an attribute-only edit whose start equals the SAP start is restored (equal version proves the server row is unchanged)', async t => {
  const f = fixture(t, 4);
  Store.updateMany([{ id: 'R2', changes: { PRT_01: 'TOOL', RUN_TIME: 2 } }], 'table');
  Persistence._saveCache();
  await reopen(t, f.server);
  assert.equal(Persistence._dirtyIds.has('R2'), true);
  assert.equal(Store.tasks.R2.PRT_01, 'TOOL');
  assert.equal(Store.tasks.R2.RUN_TIME, 2);
});

test('M1 a cached PLACEMENT is never "already saved" because a never-placed server row moved version for another reason', async t => {
  const f = fixture(t, 4);
  const server = f.server.map(r => (r.id === 'R0' ? { ...r, user_scheduled: false } : r));
  Store.setTasks(server.map(r => Persistence._prepTask(structuredClone(r))), 'persistence');
  Store.updateMany([placeRow('R0', new Date(Store.tasks.R0.start_date.getTime() + 86400000), new Date(Store.tasks.R0.end_date.getTime() + 86400000))], 'table');
  Persistence._saveCache();
  await reopen(t, server.map(r => (r.id === 'R0' ? { ...r, row_version: 2 } : r)));   // an ingest bumped the version
  assert.equal(Persistence._dirtyIds.has('R0'), false, 'the server row moved: server wins');
  assert.equal(notRestored(f.toasts).length, 1, 'but the planner is told (it was silent before)');
  // Direct: placement vs unplaced is a difference, display-only needs BOTH sides unplaced.
  const t0 = Persistence._prepTask(structuredClone(server[0]));
  const c = { planning_status: 'scheduled', start_date: Util.toLocalSeconds(t0.start_date), end_date: Util.toLocalSeconds(t0.end_date), user_scheduled: true };
  assert.equal(Persistence._serverMatchesCached(t0, c, new Set()), false);
  assert.equal(Persistence._serverMatchesCached(t0, { ...c, user_scheduled: false }, new Set()), true, 'both unplaced: attributes only');
});

test('m4 saved-row comparison: run time within a tolerance and a blank production version equal null are the same value', async t => {
  fixture(t, 2);
  const row = Store.tasks.R0;
  const base = { planning_status: 'scheduled', start_date: Util.toLocalSeconds(row.start_date), end_date: Util.toLocalSeconds(row.end_date), user_scheduled: true };
  assert.equal(Persistence._serverMatchesCached(row, { ...base, RUN_TIME: Number(row.RUN_TIME) + 0.0000001 }, new Set()), true);
  assert.equal(Persistence._serverMatchesCached(row, { ...base, RUN_TIME: Number(row.RUN_TIME) + 1 }, new Set()), false);
  assert.equal(Persistence._serverMatchesCached(row, { ...base, PRODUCTION_VERSION: '' }, new Set()), true, 'blank vs null');
  assert.equal(Persistence._serverMatchesCached(row, { ...base, PRODUCTION_VERSION: '0001' }, new Set()), false);
});

test('M3 a deferred restore tells the planner, keeps its rows in memory, merges them into EVERY write and counts them as pending work', async t => {
  const f = fixture(t, 6);
  Store.updateMany(['R0', 'R1', 'R2'].map(id => shiftDay(id)), 'engine');   // the batch
  Store.updateMany([shiftDay('R4', 3)], 'table');                            // a manual edit
  Persistence._saveCache();
  const orig = Persistence._prepTask;
  t.mock.method(Persistence, '_prepTask', raw => { if (raw.id === 'R2') throw new Error('bad row'); return orig.call(Persistence, raw); });
  await reopen(t, f.server);
  assert.equal(f.toasts.filter(x => x.msg === 'toast.cache_deferred').length, 1, 'one deferred toast');
  assert.equal(Persistence._heldRows.length, 3, 'the batch rows are held');
  assert.equal(Persistence._dirtyIds.has('R4'), true, 'the manual row that matched is restored');
  // Held rows are unsaved work: a plant switch asks, the sign-out guard fires.
  const asked = [];
  t.mock.method(Modal, 'confirm', async o => { asked.push(o); return false; });
  Persistence._dirtyIds.clear();
  assert.equal(Persistence.hasPendingWork(), true);
  assert.equal(await Persistence.confirmPlantSwitch('Z'), false);
  assert.equal(asked.length, 1, 'the discard prompt appeared for held rows alone');
  // An edit made while held is cached TOGETHER with the held rows.
  Store.updateMany([shiftDay('R5', 2)], 'table');
  Persistence._saveCache();
  let rec = readRecord('P');
  assert.deepEqual(rec.rows.map(r => r.id).sort(), ['R0', 'R1', 'R2', 'R5']);
  assert.deepEqual([...rec.optimizerIds].sort(), ['R0', 'R1', 'R2'], 'the held batch stays a batch');
  // A reload in flight does not release the hold: an autosave during it still carries the held rows.
  Persistence._dirtyIds.clear();
  const pending = Persistence.load({ plant: 'P' });
  Persistence._saveCache();
  rec = readRecord('P');
  assert.equal(rec.rows.some(r => r.id === 'R0') && rec.rows.some(r => r.id === 'R2'), true, 'held rows survive an autosave during a reload');
  await pending; await tick();
  // The next GOOD load commits a full board: the batch is restored and the hold ends.
  Persistence._prepTask.mock.restore();
  await reopen(t, f.server);
  assert.equal(Persistence._forceIds.size, 3, 'the batch is restored once every row loads');
  assert.equal(Persistence._heldRows.length, 0);
  assert.equal(Persistence._cacheHoldPlant, null);
});

test('M5 picking the plant that is already displayed is no switch: no discard prompt, nothing deleted', async t => {
  const f = fixture(t, 3);
  Store.setSelectedPlant(null, 'test');
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  let asked = 0;
  t.mock.method(Modal, 'confirm', async () => { asked++; return true; });
  assert.equal(Persistence._currentLoadedPlant, 'P');
  assert.equal(await Persistence.confirmPlantSwitch('P'), true);
  assert.equal(asked, 0);
  assert.ok(f.lsf.map.get(recKey('P')), 'the restored edits are still recorded');
  assert.equal(Persistence._dirtyIds.has('R0'), true);
});

test('M7a the record context carries only its plant: other plants\' lines, calendars, blocks and plant entries stay out (lineSettings stays)', async t => {
  fixture(t, 3);
  Store.lineSettings.OTHER_M = { plant: 'Q', bufferUnit: '%', bufferPct: 0, bufferHours: 0, bottleneck: false, excludeFromOpt: false, plGroup: '' };
  Store.calendars.OTHER_M = { workHours: {} };
  Store.plants.Q = { workHours: {} };
  Store.addBlock({ id: 'blk-q', line: 'OTHER_M', plant: 'Q', start: new Date(2026, 9, 1), end: new Date(2026, 9, 2), reason: 'x' }, 'test');
  Store.addBlock({ id: 'blk-p', line: null, plant: 'P', start: new Date(2026, 9, 1), end: new Date(2026, 9, 2), reason: 'x' }, 'test');
  t.after(() => { delete Store.lineSettings.OTHER_M; delete Store.calendars.OTHER_M; delete Store.plants.Q; Store.blocks.splice(0, Store.blocks.length); });
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  const ctx = readRecord('P').context;
  assert.equal('OTHER_M' in ctx.lineSettings, false);
  assert.equal('OTHER_M' in ctx.calendars, false);
  assert.equal('Q' in ctx.plants, false);
  assert.deepEqual(ctx.blocks.map(b => b.id), ['blk-p']);
  assert.ok(ctx.lineSettings, 'lineSettings is still there (the machine-to-plant sync needs it)');
});

test('M7b nothing unsaved deletes the record instead of storing an empty one, and the plant stays remembered', async t => {
  const f = fixture(t, 3);
  Store.updateMany([shiftDay('R0', 2)], 'table');
  Persistence._saveCache();
  assert.ok(f.lsf.map.get(recKey('P')));
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); Persistence._dirtySource.clear(); Persistence._firmDirtyIds.clear();
  Persistence._saveCache();
  assert.equal(f.lsf.map.get(recKey('P')), undefined, 'no zero-row record');
  assert.equal(CacheStore.rememberedPlant(), 'P', 'marker kept');
  assert.equal(JSON.parse(f.lsf.map.get(MARKER_KEY)).dirty, false);
});

test('M7c legacy migration: the old blob\'s unsaved rows become the new record, the blob is removed, clean and garbage blobs too', async t => {
  const f = fixture(t, 5);
  Store.updateMany(['R0', 'R1'].map(id => shiftDay(id)), 'engine');
  Store.updateMany([shiftDay('R3', 2)], 'table');
  const legacy = {
    _schemaVersion: Config.SCHEMA_VERSION, _buildId: 'old', _savedAt: '2026-11-01T00:00:00Z', selectedPlant: 'P',
    _dirtyIds: ['R0', 'R1', 'R3'], _optimizerDirtyIds: ['R0', 'R1'], lineSettings: {},
    tasks: Store.tasksArr.map(x => JSON.parse(JSON.stringify(x))),
  };
  const moved = Store.tasks.R3.start_date.getTime();
  // Fresh page after the update: no marker, no new records, only the old blob.
  f.lsf.map.clear();
  f.lsf.map.set(Config.LS_KEY, JSON.stringify(legacy));
  assert.equal(f.lsf.map.has(MARKER_KEY), false, 'precondition: a fresh store has no marker');
  await simulateReload();
  assert.equal(CacheStore.rememberedPlant(), 'P', 'first boot falls back to the legacy selectedPlant');
  for (const k of ['_dirtyIds', '_forceIds', '_firmDirtyIds', '_dirtySource']) Persistence[k].clear();
  Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
  mockServer(t, f.server);
  await Persistence.load({ plant: 'P' }); await tick();
  assert.equal(f.lsf.map.has(Config.LS_KEY), false, 'the legacy blob is removed');
  assert.deepEqual([...Persistence._forceIds].sort(), ['R0', 'R1'], 'the old optimizer batch is restored as a batch');
  assert.equal(Persistence._dirtyIds.has('R3'), true);
  assert.equal(Store.tasks.R3.start_date.getTime(), moved);
  assert.equal(JSON.parse(f.lsf.map.get(MARKER_KEY)).dirty, true, 'the converted record is marked dirty');
  assert.deepEqual(readRecord('P').rows.map(r => r.id).sort(), ['R0', 'R1', 'R3']);

  // A clean blob and an unparseable one are removed as well.
  for (const blob of [JSON.stringify({ _schemaVersion: Config.SCHEMA_VERSION, selectedPlant: 'P', _dirtyIds: [], tasks: [] }), 'not json {']) {
    f.lsf.map.clear();
    f.lsf.map.set(Config.LS_KEY, blob);
    await simulateReload();
    Persistence._dirtyIds.clear(); Store.setTasks([], 'test'); Persistence._currentLoadedPlant = null;
    await Persistence.load({ plant: 'P' }); await tick();
    assert.equal(f.lsf.map.has(Config.LS_KEY), false, `removed: ${blob.slice(0, 12)}`);
  }
});

test('m2 / m3 source guards: a note save autosaves the adopted version; the tool deep link asks before switching plant', async () => {
  const fs = await import('node:fs');
  const orders = fs.readFileSync(new URL('../../../frontend/scheduling/orders.mts', import.meta.url), 'utf8');
  const i = orders.indexOf('Persistence.adoptBaselineVersion(id, baseVersion, version);');
  assert.ok(i > 0 && orders.slice(i, i + 400).includes('Persistence._autosave()'), 'm2: the note save writes the cache after adopting the version');
  const ti = fs.readFileSync(new URL('../../../frontend/master-data/tool-inventory.mts', import.meta.url), 'utf8');
  const j = ti.indexOf('openForTool(');
  assert.ok(j > 0 && ti.slice(j, j + 900).includes('Persistence.confirmPlantSwitch(plant)'), 'm3: openForTool confirms the plant switch');
});
