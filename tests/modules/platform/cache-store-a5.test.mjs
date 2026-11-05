// Review A5 fixes in the cache store: 'system' never latches sign-in-required (K1), a foreign user's records never reach a page
// named for someone else, halted or not (K2), a truncated-and-removed record says its edits are gone (k4), and valid JSON in an
// unexpected shape is never truncated or removed (k5).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX, QUARANTINE_CAP_CHARS } from '../../../frontend/platform/cache-store.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

const X = 'alice';
const Y = 'bob';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (plant, rows = 1, user = X) => ({ user, plant, dirty: rows > 0, rows });
const rec = (rows, tag = 'R') => JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: `${tag}${i}` })) });
const recKey = (plant, user = X) => LS_RECORD_PREFIX + `${user}|${plant}`;
const seedUser = (user, plant, rows, tag) => {
  lsf.ls.setItem(recKey(plant, user), JSON.stringify({ key: `${user}|${plant}`, user, plant, seq: 5, savedAt: 1, json: rec(rows, tag), writer: 'other-tab' }));
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant, seq: 5, user, dirty: true, dirtyPlants: [plant] }));
};

/* ---------------------------------------------------------------- K1 */

test('A5 K1 a halted stale tab that loads as "system" is not latched: X signing back in resumes it and re-stores once', async () => {
  CacheStore.setPageUser(X);
  await CacheStore.ready(X);
  let saves = 0;
  const off = CacheStore.onResume(() => { saves++; CacheStore.write(meta('P', 2), rec(2)); });
  CacheStore.write(meta('P', 2), rec(2));
  CacheStore.halt();                                                    // X signed out in another tab
  lsf.ls.removeItem(recKey('P')); lsf.ls.removeItem(MARKER_KEY);
  await CacheStore.ready('system');                                     // the stale tab's load runs while nobody is signed in
  assert.equal(CacheStore.resumeSameUser(X), true, 'not latched by system');
  assert.equal(CacheStore.stats().halted, false);
  assert.equal(saves, 1);
  assert.ok(lsf.ls.getItem(recKey('P')), 'edits stored again');
  off();
});

test('A5 K1 the same holds when the page was never named (first user captured) and when system comes first', async () => {
  await CacheStore.ready('system');                                     // boot before login: system owns nothing
  assert.equal(CacheStore.capturedUser(), null);
  await CacheStore.ready(X);
  CacheStore.halt();
  await CacheStore.ready('system');
  assert.equal(CacheStore.resumeSameUser(X), true);
});

/* ---------------------------------------------------------------- K2 */

test('A5 K2 ready(Y) on a page named for X returns no record and X\'s later resume writes nothing containing Y\'s rows', async () => {
  seedUser(Y, 'P', 2, 'Y');
  CacheStore.setPageUser(X);
  await CacheStore.ready(X);
  CacheStore.write(meta('P', 1), rec(1, 'X'));
  const boot = await CacheStore.ready(Y);                               // not halted: a superseded load for the other actor
  assert.equal(boot.record, null);
  assert.equal(boot.plant, null);
  assert.equal(CacheStore.peek('P'), null, 'peek shows nothing of Y');
  assert.deepEqual(await CacheStore.read('P'), { ok: true, record: null });
  assert.equal(CacheStore.rememberedPlant(Y), null);
  assert.deepEqual(CacheStore.dirtyPlants(Y), []);
  assert.equal(CacheStore.rememberedDirty(Y), false);
  assert.deepEqual(CacheStore.dirtyFromStorage(Y), []);
  assert.equal(CacheStore.rememberedPlant(), null, 'the marker is Y\'s: invisible to a page named for X');
  CacheStore.halt();
  assert.equal(CacheStore.resumeSameUser(X), false, 'latched: X must sign in on this page');
  CacheStore.resume(X);                                                 // the sign-in path
  assert.doesNotMatch(lsf.ls.getItem(recKey('P', X)) ?? '', /Y0|Y1/, 'no Y row ever filed under X');
});

test('A5 K2 sweepOrphans and importLegacy do nothing for a user other than the page user', async () => {
  seedUser(Y, 'P', 2, 'Y');
  CacheStore.setPageUser(X);
  await CacheStore.ready(X);
  assert.deepEqual(await CacheStore.sweepOrphans(Y), { deleted: 0, kept: 0 });
  assert.ok(lsf.ls.getItem(recKey('P', Y)), 'Y\'s record untouched');
  assert.equal((await CacheStore.importLegacy('{"a":1}', 'P', Y)).reason, 'wrong-user');
});

test('A5 K2 legitimate flows: a page with no named user may open another (tests, boot), and a fresh sign-in as a new user names it', async () => {
  seedUser(Y, 'P', 2, 'Y');
  await CacheStore.ready(X);                                            // no page user yet
  const boot = await CacheStore.ready(Y);
  assert.equal(boot.record?.user, Y, 'unnamed pages keep reading whoever they open');
  CacheStore.resume(Y);                                                 // sign-in as Y on a page booted for X names Y
  CacheStore.setPageUser(Y);
  assert.equal((await CacheStore.ready(Y)).record?.user, Y);
  assert.equal(CacheStore.peek('P')?.user, Y);
  assert.equal(CacheStore.dirtyFromStorage(Y)[0].rows, 2);
});

/* ---------------------------------------------------------------- k4 */

test('A5 k4 an oversize unparseable record says its edits are gone (corrupt_removed), not "not backed up"', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, user: X, dirty: true, dirtyPlants: ['P1'] }));
  lsf.ls.setItem(recKey('P1'), '{"key":"alice|P1","json":' + 'z'.repeat(QUARANTINE_CAP_CHARS + 10));
  const boot = await CacheStore.ready(X);
  assert.equal(lsf.ls.getItem(recKey('P1')), null);
  assert.equal(boot.notices.includes('corrupt_removed'), true);
  assert.equal(boot.notices.includes('read_failed'), false);
  assert.equal(CacheStore.write(meta('P1', 1), rec(1)).ok, true, 'writes resumed');
});

/* ---------------------------------------------------------------- k5 */

test('A5 k5 an oversize record that is valid JSON in an unexpected shape stays in place, holds that plant, one read_failed notice', async () => {
  const wrongShape = JSON.stringify({ unexpected: 'x'.repeat(QUARANTINE_CAP_CHARS + 10) });
  lsf.ls.setItem(recKey('P1'), wrongShape);
  await CacheStore.ready(X);
  const r1 = await CacheStore.read('P1');
  assert.equal(r1.ok, false);
  const r2 = await CacheStore.read('P1');
  assert.equal(r2.ok, false);
  assert.equal(lsf.ls.getItem(recKey('P1')), wrongShape, 'never removed');
  assert.equal(lsf.ls.getItem(`nimbus.cache.quarantine.${X}|P1`), null, 'nothing truncated into quarantine');
  assert.deepEqual(CacheStore.takeNotices().filter(n => n === 'read_failed'), ['read_failed'], 'one notice');
  assert.equal(CacheStore.write(meta('P1', 1), rec(1)).reason, 'read-failed', 'writes for the plant are held');
  assert.equal(CacheStore.write(meta('P2', 1), rec(1)).ok, true, 'other plants are not');
  assert.equal(lsf.ls.getItem(recKey('P1')), wrongShape);
});

test('A5 k5 an oversize record whose text is not JSON is still truncated and removed', async () => {
  lsf.ls.setItem(recKey('P1'), '{"key": ' + 'q'.repeat(QUARANTINE_CAP_CHARS + 10));
  await CacheStore.ready(X);
  const r = await CacheStore.read('P1');
  assert.equal(r.ok, true);
  assert.equal(lsf.ls.getItem(recKey('P1')), null);
  assert.equal(JSON.parse(lsf.ls.getItem(`nimbus.cache.quarantine.${X}|P1`)).truncated, true);
});
