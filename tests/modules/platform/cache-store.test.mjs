// cache-store: localStorage is the only store. Per user+plant records, a seq marker that also lists the plants holding
// unsaved rows, fail-open writes (counted, one notice, retried, never a latch), quarantine of an unparseable record.
// The only double is the Map-backed localStorage in tests/modules/helpers/cache-backend-fake.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX, QUARANTINE_KEY } from '../../../frontend/platform/cache-store.mjs';
import { Config } from '../../../frontend/platform/foundation.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (plant, dirty = true, user = U) => ({ user, plant, dirty });
const marker = () => JSON.parse(lsf.ls.getItem(MARKER_KEY));
const rec = (rows, extra = {}) => JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: `R${i}` })), ...extra });
const stored = plant => { const raw = lsf.ls.getItem(LS_RECORD_PREFIX + `${U}|${plant}`); return raw ? JSON.parse(raw) : null; };
const putStored = (plant, rows, seq, user = U) => lsf.ls.setItem(LS_RECORD_PREFIX + `${user}|${plant}`,
  JSON.stringify({ key: `${user}|${plant}`, user, plant, seq, savedAt: 1, json: rec(rows) }));
const reload = async () => { CacheStore._setBackendForTests(); return CacheStore.ready(U); };

test('Node path: the store is installed inside ready() and writes land synchronously', async () => {
  const p = CacheStore.ready(U);
  const r = CacheStore.write(meta('P1'), '{"a":1}'); // no await between ready() and write()
  assert.equal(r.ok, true);
  const raw = lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1');
  assert.ok(raw, 'record is in localStorage immediately');
  assert.equal(JSON.parse(raw).json, '{"a":1}');
  assert.deepEqual({ plant: marker().plant, user: marker().user, dirty: marker().dirty }, { plant: 'P1', user: U, dirty: true });
  await p;
  assert.equal(CacheStore.stats().mode, 'localstorage');
  assert.equal(CacheStore.stats().pending, 0);
  assert.equal(LS_RECORD_PREFIX === Config.LS_KEY, false);
  assert.equal(lsf.ls.getItem(Config.LS_KEY), null, 'never touches the legacy key');
});

test('round trip survives a reload and exposes peek/rememberedPlant', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[1,2,3]}');
  assert.equal(CacheStore.peek('P1').json, '{"rows":[1,2,3]}');
  assert.equal(CacheStore.rememberedPlant(), 'P1');
  const boot = await reload(); // new page load: module state gone, storage kept
  assert.equal(boot.record.json, '{"rows":[1,2,3]}');
  assert.equal(boot.plant, 'P1');
  assert.deepEqual(boot.notices, []);
  assert.equal(CacheStore.peek().json, '{"rows":[1,2,3]}');
});

test('identical JSON is skipped, changed JSON writes', async () => {
  await CacheStore.ready(U);
  assert.equal(CacheStore.write(meta('P1'), '{"x":1}').skipped, undefined);
  const seq = CacheStore.stats().seq;
  assert.equal(CacheStore.write(meta('P1'), '{"x":1}').skipped, true);
  assert.equal(CacheStore.stats().seq, seq);
  assert.equal(CacheStore.write(meta('P1'), '{"x":2}').skipped, undefined);
  assert.equal(CacheStore.stats().seq, seq + 1);
});

test('records are isolated per user and plant', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('A'), '{"plant":"A"}');
  CacheStore.write(meta('B'), '{"plant":"B"}');
  assert.equal(CacheStore.peek('A').json, '{"plant":"A"}', 'writing plant B left plant A intact');
  CacheStore._setBackendForTests();
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ ...marker(), plant: 'A', seq: 1, dirtyPlants: ['A'] }));
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record.json, '{"plant":"A"}');
  CacheStore._setBackendForTests();
  const other = await CacheStore.ready('bob');   // another user never sees alice's record
  assert.equal(other.record, null);
});

test('halt makes writes no-ops until resume(user); ready() does not lift it', async () => {
  await CacheStore.ready(U);
  CacheStore.halt();
  const r = CacheStore.write(meta('P1'), '{"x":1}');
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'halted' });
  assert.equal(CacheStore.stats().halted, true);
  assert.equal(CacheStore.peek('P1'), null);
  await CacheStore.ready(U); // a late load resolving after sign-out must NOT revive the store
  assert.equal(CacheStore.stats().halted, true);
  assert.equal(CacheStore.write(meta('P1'), '{"x":1}').reason, 'halted');
  CacheStore.resume(U); // the sign-in path
  assert.equal(CacheStore.write(meta('P1'), '{"x":1}').ok, true);
});

test('wipe clears records, quarantine copy, marker, legacy blob and peek, synchronously', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('A'), '{"a":1}');
  CacheStore.write(meta('B'), '{"b":1}');
  lsf.ls.setItem(QUARANTINE_KEY, '{}');
  lsf.ls.setItem(Config.LS_KEY, '{"legacy":1}');
  lsf.ls.setItem('nimbus.theme', 'dark');
  const p = CacheStore.wipe();
  assert.deepEqual([...lsf.map.keys()], ['nimbus.theme'], 'everything cache-related is gone before the promise settles');
  await p;
  assert.equal(CacheStore.peek('A'), null);
  const boot = await reload();
  assert.equal(boot.record, null);
});

test('discard removes one plant record and its marker, leaves the others', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('A'), '{"a":1}');
  CacheStore.write(meta('B'), '{"b":1}');
  await CacheStore.discard('B');
  assert.deepEqual(marker().dirtyPlants, ['A'], 'B leaves the dirty list');
  assert.equal(marker().plant, 'A', 'the marker follows the remaining dirty plant');
  assert.equal(CacheStore.peek('B'), null);
  assert.equal(CacheStore.peek('A').json, '{"a":1}');
  await CacheStore.discard('A');
  assert.equal(lsf.ls.getItem(MARKER_KEY), null, 'nothing dirty left: the marker goes');
});

test('system actor and empty plant are refused', async () => {
  await CacheStore.ready('system');
  assert.equal(CacheStore.write(meta('P1', true, 'system'), '{}').reason, 'system-actor');
  assert.equal(CacheStore.write(meta('', true, U), '{}').reason, 'no-plant');
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('marker dirty but no record: notice raised and the dirty claim withdrawn (the plant stays remembered)', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, user: U, dirty: true }));   // pre-dirtyPlants marker
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record, null);
  assert.deepEqual(boot.notices, ['dirty_no_record']);
  assert.equal(marker().dirty, false);
  assert.deepEqual(marker().dirtyPlants, []);
  assert.equal(CacheStore.rememberedPlant(), 'P1');
});

test('record seq lower than marker seq restores the older record and flags it', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"v":1}');
  CacheStore._setBackendForTests();
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ ...marker(), seq: 99 })); // a newer put was started and never landed
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record.json, '{"v":1}');
  assert.deepEqual(boot.notices, ['older_record']);
  assert.ok(CacheStore.stats().seq >= 99, 'seq stays monotonic');
  assert.deepEqual(CacheStore.takeNotices(), ['older_record']);
  assert.deepEqual(CacheStore.takeNotices(), []);
});

test('importLegacy imports once, removes the legacy key, refuses when a record exists', async () => {
  await CacheStore.ready(U);
  lsf.ls.setItem(Config.LS_KEY, '{"legacy":true}');
  assert.deepEqual(await CacheStore.importLegacy('{"legacy":true}', 'P1', U), { imported: true });
  assert.equal(lsf.ls.getItem(Config.LS_KEY), null);
  assert.equal(CacheStore.peek('P1').json, '{"legacy":true}');
  assert.equal((await CacheStore.importLegacy('{"x":1}', 'P1', U)).reason, 'record-exists');
  assert.equal((await CacheStore.importLegacy('not json', 'P2', U)).reason, 'unparseable');
  assert.equal((await CacheStore.importLegacy('{}', 'P2', 'system')).reason, 'bad-args');
});

/* ---------- failed writes: counted, one notice, retried, never a latch ---------- */

test('QuotaExceededError: failure result, failed++, one notice, no latch, the next write retries identical JSON', async () => {
  await CacheStore.ready(U);
  lsf.ctl.failNext = 2; // marker write (best effort) and then the record put both hit quota
  const r = CacheStore.write(meta('P1'), '{"v":1}');
  assert.equal(r.ok, false);
  assert.match(r.error, /QuotaExceededError/);
  assert.equal(CacheStore.stats().failed, 1);
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
  assert.equal(stored('P1'), null);
  const r2 = CacheStore.write(meta('P1'), '{"v":1}');   // identical JSON must NOT be skipped after a failure
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, undefined);
  assert.equal(JSON.parse(stored('P1').json).v, 1);
  assert.equal(CacheStore.stats().lastChars, '{"v":1}'.length);
  assert.equal(CacheStore.stats().halted, false);
});

test('repeated failures raise ONE notice; a later success re-arms it', async () => {
  await CacheStore.ready(U);
  lsf.ctl.failNext = 4;
  CacheStore.write(meta('P1'), '{"v":1}');
  CacheStore.write(meta('P1'), '{"v":2}');
  assert.equal(CacheStore.stats().failed, 2);
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
  assert.equal(CacheStore.write(meta('P1'), '{"v":3}').ok, true);
  lsf.ctl.failNext = 2;
  CacheStore.write(meta('P1'), '{"v":4}');
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
});

test('a real character quota fails cleanly then recovers when the payload shrinks', async () => {
  lsf.ctl.quotaChars = 400;
  await CacheStore.ready(U);
  assert.equal(CacheStore.write(meta('P1'), JSON.stringify({ big: 'x'.repeat(2000) })).ok, false);
  assert.equal(CacheStore.stats().failed, 1);
  assert.equal(CacheStore.write(meta('P1'), '{"small":1}').ok, true);
});

test('blocked storage: mode none, writes report not-ready instead of throwing, no latch', async () => {
  delete globalThis.localStorage;
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'none');
  assert.equal(CacheStore.stats().halted, false);
  assert.deepEqual(CacheStore.write(meta('P1'), '{}'), { ok: false, skipped: true, reason: 'not-ready' });
  assert.equal(CacheStore.stats().failed, 0);
  assert.deepEqual(await CacheStore.read('P1'), { ok: true, record: null });
});

/* ------------------------------------------------ reads */

test('read(plant): a record the marker does not name is reachable, and a failed read holds writes for that plant', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 2 }, rec(2));
  CacheStore.write({ ...meta('B', false), rows: 1 }, rec(1, { b: 1 }));   // marker now names B, A stays dirty
  assert.equal(marker().plant, 'B');
  const boot = await reload();
  assert.equal(boot.plant, 'A', 'a boot opens the dirty plant, not the clean one the marker names');
  assert.equal(CacheStore.peek('B'), null);
  const r = await CacheStore.read('B');
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(r.record.json).rows.length, 1, 'B record is read on demand and cached for peek');
  assert.equal(CacheStore.peek('B').json, r.record.json);

  // A plant whose read FAILS: writes are held, nothing is overwritten, the planner is told.
  lsf.ctl.failGet = k => k.endsWith('|C');
  const bad = await CacheStore.read('C');
  assert.equal(bad.ok, false);
  assert.deepEqual(CacheStore.takeNotices().filter(n => n === 'read_failed'), ['read_failed']);
  assert.deepEqual(CacheStore.write(meta('C'), rec(1)), { ok: false, skipped: true, reason: 'read-failed' });
  lsf.ctl.failGet = null;
  assert.equal((await CacheStore.read('C')).ok, true, 'a later good read lifts the hold');
  assert.equal(CacheStore.write(meta('C'), rec(1)).ok, true);
});

test('M4 a boot read ERROR is not "no record": marker kept, no dirty_no_record, writes held; the next load retries', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), rec(3));
  const before = lsf.ls.getItem(MARKER_KEY);
  CacheStore._setBackendForTests();
  lsf.ctl.failGet = k => k.endsWith('|P1');
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record, null);
  assert.deepEqual(boot.notices, ['read_failed'], 'no dirty_no_record');
  assert.equal(lsf.ls.getItem(MARKER_KEY), before, 'the marker survives');
  assert.equal(CacheStore.write(meta('P1', false), rec(0)).reason, 'read-failed');
  lsf.ctl.failGet = null;
  assert.equal(JSON.parse(stored('P1').json).rows.length, 3, 'the stored record is intact');
  // The error was transient: the next page load reads it and the hold is gone (not session-long).
  const again = await reload();
  assert.equal(JSON.parse(again.record.json).rows.length, 3);
  assert.equal(CacheStore.write(meta('P1'), rec(3, { more: 1 })).ok, true);
});

/* ------------------------------------------------ F4: a corrupt record is quarantined, not a session-long hold */

test('F4 an unparseable record is quarantined (whole, per user+plant), noticed once and reads as no record', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, user: U, dirty: true, dirtyPlants: ['P1'] }));
  const garbage = '{"key":"alice|P1","json":' + 'z'.repeat(150 * 1024);
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P1', garbage);
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record, null);
  assert.equal(boot.notices.includes('corrupt_record'), true);
  assert.equal(boot.notices.includes('read_failed'), false, 'corrupt is not a read error');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null, 'removed from the record keys');
  const q = JSON.parse(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|P1`));
  assert.equal(q.key, 'alice|P1');
  assert.equal(q.raw, garbage, 'the copy is the whole record, never a truncation (A3 m4: oversize records are left in place instead)');
  assert.equal(q.chars, garbage.length);
  // The plant is NOT held for the session: the very next write lands.
  const w = CacheStore.write(meta('P1'), rec(2));
  assert.equal(w.ok, true);
  assert.equal(w.skipped, undefined);
  assert.equal(JSON.parse(stored('P1').json).rows.length, 2);
});

test('F4 read(plant) quarantines a corrupt record too, and a wrapper without json is corrupt', async () => {
  await CacheStore.ready(U);
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P2', '{"key":"alice|P2","user":"alice"}');
  const r = await CacheStore.read('P2');
  assert.deepEqual(r, { ok: true, record: null });
  assert.deepEqual(CacheStore.takeNotices(), ['corrupt_record']);
  assert.ok(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|P2`));
  assert.equal(CacheStore.write(meta('P2'), rec(1)).ok, true);
});

/* ------------------------------------------------ F1: a clean write never hides another plant's unsaved record */

test('F1 marker ping-pong: a clean write for plant B leaves plant A dirty in the marker, and a boot still opens A', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 2 }, rec(2));
  CacheStore.write({ ...meta('B', false), rows: 0 }, rec(0));              // zero-row clean write
  assert.deepEqual(marker().dirtyPlants, ['A']);
  assert.equal(marker().dirty, true, 'dirty stays true while any plant is dirty');
  assert.equal(CacheStore.rememberedPlant(), 'A');
  assert.equal(CacheStore.rememberedDirty(), true);
  CacheStore.write({ ...meta('B', false), rows: 1 }, rec(1, { b: 1 }));    // clean flag with a row (identical-skip path next)
  CacheStore.write({ ...meta('B', false), rows: 1 }, rec(1, { b: 1 }));
  assert.deepEqual(marker().dirtyPlants, ['A']);
  const boot = await reload();
  assert.equal(boot.plant, 'A');
  assert.equal(JSON.parse(boot.record.json).rows.length, 2, 'A unsaved record is what the boot restores');
  assert.deepEqual(boot.notices, [], 'A is the only dirty plant: nothing else to announce');
});

test('F1 two plants dirty: both stay listed, the boot opens the marker plant and announces the other', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  CacheStore.write({ ...meta('B'), rows: 1 }, rec(1, { b: 1 }));
  assert.deepEqual([...marker().dirtyPlants].sort(), ['A', 'B']);
  const boot = await reload();
  assert.equal(boot.plant, 'B');
  assert.deepEqual(boot.notices, ['other_dirty_plants']);
  assert.deepEqual([...CacheStore.dirtyPlants()].sort(), ['A', 'B']);
  await CacheStore.read('A');                                              // the load of plant A reads its record first
  CacheStore.write({ ...meta('A', false), rows: 0 }, rec(0));              // A saved: leaves the list, record deleted
  assert.deepEqual(marker().dirtyPlants, ['B']);
  assert.equal(stored('A'), null);
});

test('F1 two tabs: a tab that never held rows writes plant B clean; plant A record and dirty claim survive', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 2 }, rec(2));                      // tab 1
  CacheStore._setBackendForTests();                                         // tab 2: its own fresh module state
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('B', false), rows: 0 }, rec(0));
  assert.equal(JSON.parse(stored('A').json).rows.length, 2);
  assert.deepEqual(marker().dirtyPlants, ['A']);
  assert.equal(CacheStore.rememberedPlant(), 'A');
});

test('F1 a failed read of plant A does not let a clean write for B hide A record', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 2 }, rec(2));
  CacheStore._setBackendForTests();
  lsf.ctl.failGet = k => k.endsWith('|A');
  const boot = await CacheStore.ready(U);
  assert.equal(boot.notices.includes('read_failed'), true);
  CacheStore.write({ ...meta('B', false), rows: 0 }, rec(0));
  lsf.ctl.failGet = null;
  assert.deepEqual(marker().dirtyPlants, ['A']);
  assert.equal(CacheStore.rememberedPlant(), 'A');
});

test('F1 a zero-row write over a record another tab holds rows in keeps that plant dirty', async () => {
  await CacheStore.ready(U);
  putStored('P2', 4, 50);                           // another tab's unsaved record, never seen by this one
  CacheStore.write({ ...meta('P2', false), rows: 0 }, rec(0));
  assert.ok(stored('P2'), 'refused: this tab never emptied it');
  assert.deepEqual(marker().dirtyPlants, ['P2']);
});

test('M2 an identical-JSON write still moves the marker to its own plant (dirty list stays truthful)', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('A', true), rec(1));
  CacheStore.write(meta('B', true), rec(1, { b: 1 }));
  assert.equal(marker().plant, 'B');
  const r = CacheStore.write(meta('A', true), rec(1));
  assert.equal(r.skipped, true, 'identical JSON is still skipped');
  assert.deepEqual({ plant: marker().plant, dirty: marker().dirty }, { plant: 'A', dirty: true }, 'but the marker follows A');
  CacheStore.write(meta('B', false), rec(1, { b: 1 }));
  assert.deepEqual({ plant: marker().plant, dirty: marker().dirty, plants: marker().dirtyPlants }, { plant: 'B', dirty: true, plants: ['A'] },
    'B clean flag never erases A dirty claim');
});

test('M7b rows:0 deletes the stored record (marker kept)', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('P1'), rows: 2 }, rec(2));
  assert.ok(stored('P1'));
  CacheStore.write({ ...meta('P1', false), rows: 0 }, rec(0));
  assert.equal(stored('P1'), null, 'the empty record is deleted, not written');
  assert.equal(marker().plant, 'P1', 'the marker stays so the plant is remembered');
  assert.equal(marker().dirty, false);
});

/* ------------------------------------------------ F2: storage events invalidate only what they name */

test('F2 another tab changing ONE record invalidates only that record peek', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  CacheStore.write({ ...meta('B'), rows: 1 }, rec(1, { b: 1 }));
  CacheStore._storageEventForTests({ key: LS_RECORD_PREFIX + 'alice|A', newValue: '{}' });
  assert.equal(CacheStore.peek('A'), null, 'the named record is dropped');
  assert.notEqual(CacheStore.peek('B'), null, 'the other plant peek stays');
  const r = CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  assert.equal(r.skipped, undefined, 'identical to its own last write, yet rewritten');
});

test('F2 a marker that vanishes does not drop every peek: the dirty list is recomputed from storage', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  CacheStore.write({ ...meta('B'), rows: 1 }, rec(1, { b: 1 }));
  lsf.ls.removeItem(MARKER_KEY);
  CacheStore._storageEventForTests({ key: MARKER_KEY, newValue: null });
  assert.notEqual(CacheStore.peek('A'), null);
  assert.notEqual(CacheStore.peek('B'), null);
  assert.deepEqual([...marker().dirtyPlants].sort(), ['A', 'B'], 'rebuilt from the stored records');
});

test('F2 another tab marker that lost a plant this tab holds rows for is corrected from storage', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  const clobbered = JSON.stringify({ v: 1, plant: 'B', seq: 5, user: U, dirty: false, dirtyPlants: [] });
  lsf.ls.setItem(MARKER_KEY, clobbered);
  CacheStore._storageEventForTests({ key: MARKER_KEY, newValue: clobbered });
  assert.deepEqual(marker().dirtyPlants, ['A']);
  assert.equal(CacheStore.rememberedPlant(), 'A');
});

test('F2 an ordinary marker bump by another tab leaves every peek alone', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  const bumped = JSON.stringify({ ...marker(), seq: 99 });
  lsf.ls.setItem(MARKER_KEY, bumped);
  CacheStore._storageEventForTests({ key: MARKER_KEY, newValue: bumped });
  assert.notEqual(CacheStore.peek('A'), null);
});

test('F2 zombie: after a storage event dropped the peek, an empty write still deletes THIS tab own stored record', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('P1'), rows: 2 }, rec(2));
  CacheStore._storageEventForTests({ key: LS_RECORD_PREFIX + 'alice|P1', newValue: '{}' });   // peek gone, record unchanged
  assert.equal(CacheStore.peek('P1'), null);
  assert.ok(stored('P1'));
  CacheStore.write({ ...meta('P1', false), rows: 0 }, rec(0));         // the planner undid everything
  assert.equal(stored('P1'), null, 'no zombie record left to resurrect the undone edit');
  assert.deepEqual(marker().dirtyPlants, []);
});

test('F2 a record another tab rewrote since (newer seq) is NOT deleted by an empty write here', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('P1'), rows: 2 }, rec(2));
  putStored('P1', 5, CacheStore.stats().seq + 10);                      // the other tab newer write
  CacheStore._storageEventForTests({ key: LS_RECORD_PREFIX + 'alice|P1', newValue: '{}' });
  CacheStore.write({ ...meta('P1', false), rows: 0 }, rec(0));
  assert.equal(JSON.parse(stored('P1').json).rows.length, 5);
  assert.deepEqual(marker().dirtyPlants, ['P1'], 'and it stays claimed dirty');
});

/* ------------------------------------------------ legacy */

test('M7c legacy: rememberedPlant falls back to the legacy blob; importLegacy converts, frees the blob on quota and always removes it', async () => {
  const blob = JSON.stringify({ selectedPlant: 'P9', _dirtyIds: ['R1'], tasks: [{ id: 'R1' }] });
  lsf.ls.setItem(Config.LS_KEY, blob);
  CacheStore._setBackendForTests();
  assert.equal(CacheStore.rememberedPlant(), 'P9', 'first boot: no marker yet, the legacy plant is remembered');
  assert.equal(CacheStore.rememberedDirty(), true);
  assert.equal(CacheStore.legacyBlob(), blob);
  await CacheStore.ready(U);
  const r = await CacheStore.importLegacy(rec(1), 'P9', U, { converted: true, dirty: true });
  assert.deepEqual(r, { imported: true });
  assert.equal(lsf.ls.getItem(Config.LS_KEY), null, 'blob removed');
  assert.equal(marker().dirty, true);
  assert.equal(CacheStore.peek('P9').legacy, undefined, 'a converted record is a normal one');

  // The blob itself fills localStorage: the put hits the quota, the blob is freed, the retry lands.
  lsf.ls.removeItem(LS_RECORD_PREFIX + 'alice|P9'); lsf.ls.removeItem(MARKER_KEY);
  CacheStore._setBackendForTests();
  lsf.ctl.quotaChars = 3200;
  lsf.ls.setItem(Config.LS_KEY, 'x'.repeat(3000));
  await CacheStore.ready(U);
  const r2 = await CacheStore.importLegacy(rec(1), 'P9', U, { converted: true, dirty: true });
  assert.equal(r2.imported, true);
  assert.equal(lsf.ls.getItem(Config.LS_KEY), null);
  CacheStore.dropLegacy();   // idempotent
});

test('F3 importLegacy beside an existing marker adds its plant to the dirty list and refuses a plant that has a record', async () => {
  await CacheStore.ready(U);
  CacheStore.write({ ...meta('A'), rows: 1 }, rec(1));
  assert.deepEqual(await CacheStore.importLegacy(rec(2), 'B', U, { converted: true, dirty: true }), { imported: true });
  assert.deepEqual([...marker().dirtyPlants].sort(), ['A', 'B']);
  assert.equal((await CacheStore.importLegacy(rec(2), 'A', U, { converted: true, dirty: true })).reason, 'record-exists');
});

test('the orphan sweep leaves this user quarantine copy alone and a storage-blocked page does not throw', async () => {
  lsf.ls.setItem(`${QUARANTINE_KEY}.alice|P`, '{"raw":"x"}');
  const res = await CacheStore.sweepOrphans(U);
  assert.deepEqual(res, { deleted: 0, kept: 0 });
  assert.ok(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|P`));
  delete globalThis.localStorage;
  assert.deepEqual(await CacheStore.sweepOrphans(U), { deleted: 0, kept: 0 });
});
