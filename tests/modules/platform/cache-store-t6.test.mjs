// cache-store T6: halt that only resume() lifts, flush-aware settled(), wipe without a prior ready(), per-user markers,
// deliberate drop of another user's state, and the orphan sweep. Same fakes as cache-store.test.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheStore, MARKER_KEY, LS_RECORD_PREFIX, makeLocalStorageBackend, makeIdbBackend,
} from '../../../frontend/platform/cache-store.mjs';
import { ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { makeFakeBackend, installFakeLocalStorage, installFakeIndexedDB } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; delete globalThis.indexedDB; CacheStore._setBackendForTests(); });

const meta = (plant, dirty = true, user = U) => ({ user, plant, dirty });
const putRec = (user, plant, rows, extra = {}) => {
  const key = user + '|' + plant;
  lsf.ls.setItem(LS_RECORD_PREFIX + key, JSON.stringify({
    key, user, plant, seq: 1, savedAt: 1,
    json: JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: i })) }), ...extra,
  }));
};
const idbRec = (user, plant) => ({ key: user + '|' + plant, user, plant, seq: 1, savedAt: 1, json: '{"rows":[{}]}' });
const tick = () => new Promise(r => setTimeout(r, 0));

test('a late ready() after halt never un-halts, for the same user or another; discard, flush, read and importLegacy honour halt', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[1]}');
  CacheStore.halt();
  await CacheStore.ready(U);
  await CacheStore.ready('bob');
  assert.equal(CacheStore.stats().halted, true);
  assert.equal(CacheStore.write(meta('P1', true, 'bob'), '{"rows":[1]}').reason, 'halted');
  assert.deepEqual(await CacheStore.flush(), { ok: false, skipped: true, reason: 'halted' });
  assert.deepEqual(await CacheStore.read('P1'), { ok: false, record: null });
  assert.deepEqual(await CacheStore.importLegacy('{"a":1}', 'P1', 'bob'), { imported: false, reason: 'halted' });
  const before = lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1');
  await CacheStore.discard('P1');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), before, 'a halted store deletes nothing on its own');
  CacheStore.resume('bob');
  assert.equal(CacheStore.stats().halted, false);
});

test('settled() waits for flush() puts, not only the queue', async () => {
  const f = makeFakeBackend();
  const real = f.backend.put; const gates = [];
  f.backend.put = rec => new Promise(res => gates.push(() => res(real(rec))));
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[1]}');     // put 1 in flight
  CacheStore.write(meta('P1'), '{"rows":[1,2]}');   // queued behind it
  const fl = CacheStore.flush();                    // starts its own put 2
  assert.equal(gates.length, 2);
  let done = false; void CacheStore.settled().then(() => { done = true; });
  gates[0](); await tick(); await tick();
  assert.equal(done, false, 'the flush put is still open');
  gates[1](); await fl; await CacheStore.settled(); await tick();
  assert.equal(done, true);
  assert.equal(JSON.parse(f.data.get('alice|P1').json).rows.length, 2);
});

test('wipe() with no ready(): opens IndexedDB, clears the store, closes, never deletes the database', async () => {
  const fi = installFakeIndexedDB();
  fi.records.set('alice|P1', idbRec(U, 'P1'));
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 1, backend: 'idb', user: U, dirty: true }));
  putRec(U, 'P1', 1);
  CacheStore._setBackendForTests();       // no ready(): the expiry path before boot
  assert.equal(CacheStore.stats().mode, 'none');
  await CacheStore.wipe();
  assert.equal(fi.records.size, 0);
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null);
  assert.ok(fi.ctl.dbs.length >= 1 && fi.ctl.dbs.every(d => d.closed), 'the wipe connection is closed');
  assert.equal(globalThis.indexedDB.deleteDatabase, undefined, 'the fake has no deleteDatabase, so the store never called it');
});

test('wipe() is bounded by the open timeout and fails open when IndexedDB hangs', async () => {
  const fi = installFakeIndexedDB(); fi.ctl.mode = 'hang';
  CacheStore._setBackendForTests({ openTimeoutMs: 40 });
  putRec(U, 'P1', 1);
  const t0 = Date.now();
  await CacheStore.wipe();
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null, 'the synchronous part ran regardless');
});

test('wipe() with the localStorage backend open also clears a copy left in IndexedDB', async () => {
  const fi = installFakeIndexedDB();
  fi.records.set('alice|P2', idbRec(U, 'P2'));
  CacheStore._setBackendForTests({ defaultBackend: 'localstorage' });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[{}]}');
  await CacheStore.wipe();
  assert.equal(fi.records.size, 0);
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('rememberedPlant ignores a marker written by another user (a second user does not boot into the first user\'s plant)', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[{}]}');
  assert.equal(CacheStore.rememberedPlant(U), 'P1');
  assert.equal(CacheStore.rememberedPlant('bob'), null);
  assert.equal(CacheStore.rememberedDirty('bob'), false);
  assert.equal(CacheStore.rememberedDirty(U), true);
  CacheStore._setBackendForTests();       // reload as bob: no curUser yet, the caller passes the signed-in user
  assert.equal(CacheStore.rememberedPlant('bob'), null);
  const boot = await CacheStore.ready('bob');
  assert.equal(boot.record, null);
  assert.equal(CacheStore.peek('P1'), null);
});

test('ready(otherUser) drops the previous user\'s queued puts and peek copies deliberately, with a log line', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  f.ctl.hold = 1;
  CacheStore.write(meta('P1'), '{"rows":[1]}');   // in flight, held
  CacheStore.write(meta('P1'), '{"rows":[1,2]}'); // queued
  const warns = []; const realWarn = ErrorLog.warn;
  ErrorLog.warn = (src, msg, ctx) => { warns.push([src, msg, ctx]); };
  try { await CacheStore.ready('bob'); } finally { ErrorLog.warn = realWarn; }
  const w = warns.find(x => /previous user/.test(x[1]));
  assert.ok(w, 'the drop is logged, not silent');
  assert.equal(w[2].queued, 1);
  assert.equal(CacheStore.peek('P1'), null, 'bob never sees alice\'s copy');
  f.release();
});

test('sweepOrphans: deletes other users\' records and empty unreferenced ones, never a record holding the signing-in user\'s rows', async () => {
  const fi = installFakeIndexedDB();
  putRec('bob', 'P1', 3);                 // foreign, has rows -> deleted
  putRec(U, 'P2', 4);                     // own, rows -> kept (recoverable orphan, no marker points at it)
  putRec(U, 'P3', 0);                     // own, zero rows, marker elsewhere -> deleted
  putRec(U, 'P4', 0);                     // own, zero rows, marker points at it -> kept
  putRec(U, 'P5', 0, { legacy: true, json: '{"tasks":[{}]}' }); // legacy blob record -> kept
  putRec(U, 'P6', 0, { json: 'not json' }); // cannot be counted -> kept
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P4', seq: 1, backend: 'localstorage', user: U, dirty: false }));
  fi.records.set('bob|P9', idbRec('bob', 'P9'));
  fi.records.set('alice|P7', idbRec(U, 'P7'));
  CacheStore._setBackendForTests();       // gate: no ready(), no load
  const res = await CacheStore.sweepOrphans(U);
  const ls = k => lsf.ls.getItem(LS_RECORD_PREFIX + k);
  assert.equal(ls('bob|P1'), null);
  assert.ok(ls('alice|P2'), 'a row-holding record of the signing-in user survives');
  assert.equal(ls('alice|P3'), null);
  assert.ok(ls('alice|P4')); assert.ok(ls('alice|P5')); assert.ok(ls('alice|P6'));
  assert.equal(fi.records.has('bob|P9'), false);
  assert.equal(fi.records.has('alice|P7'), true);
  assert.equal(res.deleted, 3);
  assert.ok(lsf.ls.getItem(MARKER_KEY), 'own marker stays');
  // a marker of another user is cleared deliberately
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 1, backend: 'localstorage', user: 'bob', dirty: true }));
  await CacheStore.sweepOrphans(U);
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('the IndexedDB backend and the localStorage backend both list their keys', async () => {
  const fi = installFakeIndexedDB();
  CacheStore._setBackendForTests({ defaultBackend: 'idb' });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[{}]}');
  await CacheStore.settled();
  assert.deepEqual([...fi.records.keys()], ['alice|P1']);
  const b = makeIdbBackend(); await b.open();
  assert.deepEqual(await b.keys(), ['alice|P1']);
  b.close();
  putRec(U, 'P2', 1);
  assert.deepEqual(await makeLocalStorageBackend().keys(), ['alice|P2']);
});
