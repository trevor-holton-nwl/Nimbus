// cache-store T6: halt that only resume() lifts, wipe without a prior ready(), per-user markers, deliberate drop of another
// user's state, and the orphan sweep. Same localStorage fake as cache-store.test.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX } from '../../../frontend/platform/cache-store.mjs';
import { ErrorLog } from '../../../frontend/platform/foundation.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (plant, dirty = true, user = U) => ({ user, plant, dirty });
const putRec = (user, plant, rows, extra = {}) => {
  const key = user + '|' + plant;
  lsf.ls.setItem(LS_RECORD_PREFIX + key, JSON.stringify({
    key, user, plant, seq: 1, savedAt: 1,
    json: JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: i })) }), ...extra,
  }));
};

test('a late ready() after halt never un-halts, for the same user or another; discard, read and importLegacy honour halt', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[1]}');
  CacheStore.halt();
  await CacheStore.ready(U);
  await CacheStore.ready('bob');
  assert.equal(CacheStore.stats().halted, true);
  assert.equal(CacheStore.write(meta('P1', true, 'bob'), '{"rows":[1]}').reason, 'halted');
  assert.deepEqual(await CacheStore.read('P1'), { ok: false, record: null });
  assert.deepEqual(await CacheStore.importLegacy('{"a":1}', 'P1', 'bob'), { imported: false, reason: 'halted' });
  const before = lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1');
  await CacheStore.discard('P1');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), before, 'a halted store deletes nothing on its own');
  CacheStore.resume('bob');
  assert.equal(CacheStore.stats().halted, false);
});

test('wipe() with no ready(): clears marker and every record synchronously (the expiry path before boot)', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 1, user: U, dirty: true }));
  putRec(U, 'P1', 1);
  putRec('bob', 'P2', 1);
  CacheStore._setBackendForTests();       // no ready()
  assert.equal(CacheStore.stats().mode, 'none');
  const p = CacheStore.wipe();
  assert.equal(lsf.ls.getItem(MARKER_KEY), null, 'cleared before the promise settles');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null);
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'bob|P2'), null);
  await p;
});

test('wipe() with the store open clears what it holds and a following ready() starts clean', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[{}]}');
  await CacheStore.wipe();
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
  assert.equal(CacheStore.peek('P1'), null);
  CacheStore._setBackendForTests();
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record, null);
});

test('rememberedPlant ignores a marker written by another user (a second user does not boot into the first user plant)', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[{}]}');
  assert.equal(CacheStore.rememberedPlant(U), 'P1');
  assert.equal(CacheStore.rememberedPlant('bob'), null);
  assert.equal(CacheStore.rememberedDirty('bob'), false);
  assert.equal(CacheStore.rememberedDirty(U), true);
  assert.deepEqual(CacheStore.dirtyPlants('bob'), []);
  CacheStore._setBackendForTests();       // reload as bob: no curUser yet, the caller passes the signed-in user
  assert.equal(CacheStore.rememberedPlant('bob'), null);
  const boot = await CacheStore.ready('bob');
  assert.equal(boot.record, null);
  assert.equal(CacheStore.peek('P1'), null);
});

test('ready(otherUser) drops the previous user peek copies deliberately, with a log line', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"rows":[1]}');
  const warns = []; const realWarn = ErrorLog.warn;
  ErrorLog.warn = (src, msg, ctx) => { warns.push([src, msg, ctx]); };
  try { await CacheStore.ready('bob'); } finally { ErrorLog.warn = realWarn; }
  const w = warns.find(x => /previous user/.test(x[1]));
  assert.ok(w, 'the drop is logged, not silent');
  assert.equal(w[2].peeked, 1);
  assert.equal(CacheStore.peek('P1'), null, 'bob never sees alice copy');
});

test('sweepOrphans: deletes other users records and empty unreferenced ones, never a record holding the signing-in user rows', async () => {
  putRec('bob', 'P1', 3);                 // foreign, has rows -> deleted
  putRec(U, 'P2', 4);                     // own, rows -> kept (recoverable orphan, no marker points at it)
  putRec(U, 'P3', 0);                     // own, zero rows, marker elsewhere -> deleted
  putRec(U, 'P4', 0);                     // own, zero rows, marker points at it -> kept
  putRec(U, 'P5', 0, { legacy: true, json: '{"tasks":[{}]}' }); // legacy blob record -> kept
  putRec(U, 'P6', 0, { json: 'not json' }); // cannot be counted -> kept
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P4', seq: 1, user: U, dirty: false }));
  CacheStore._setBackendForTests();       // gate: no ready(), no load
  const res = await CacheStore.sweepOrphans(U);
  const ls = k => lsf.ls.getItem(LS_RECORD_PREFIX + k);
  assert.equal(ls('bob|P1'), null);
  assert.ok(ls('alice|P2'), 'a row-holding record of the signing-in user survives');
  assert.equal(ls('alice|P3'), null);
  assert.ok(ls('alice|P4')); assert.ok(ls('alice|P5')); assert.ok(ls('alice|P6'));
  assert.equal(res.deleted, 2);
  assert.ok(lsf.ls.getItem(MARKER_KEY), 'own marker stays');
  // a marker of another user is cleared deliberately
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 1, user: 'bob', dirty: true }));
  await CacheStore.sweepOrphans(U);
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});
