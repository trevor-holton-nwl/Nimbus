// Review A4 fixes in the cache store: a halted tab keeps its local view honest (J1), the page's in-memory edits can never be filed
// under another user (J2), the failure/blocked state is not cumulative or confused with "not opened yet" (n5, n6).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX } from '../../../frontend/platform/cache-store.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (plant, rows = 1, user = U) => ({ user, plant, dirty: rows > 0, rows });
const rec = rows => JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: `R${i}` })) });
const recKey = (plant, user = U) => LS_RECORD_PREFIX + `${user}|${plant}`;

/* ---------------------------------------------------------------- J1 */

test('A4 J1 a halted tab still drops its peek when another tab removes or rewrites a record, but never rebuilds a marker', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 2), rec(2));
  assert.ok(CacheStore.peek('P'));
  CacheStore.halt();
  lsf.ls.removeItem(recKey('P')); lsf.ls.removeItem(MARKER_KEY);              // another tab's sign-out wipe
  CacheStore._storageEventForTests({ key: recKey('P'), newValue: null });
  assert.equal(CacheStore.peek('P'), null, 'peek cleared although halted');
  CacheStore._storageEventForTests({ key: MARKER_KEY, newValue: null });
  assert.equal(lsf.ls.getItem(MARKER_KEY), null, 'a halted tab never rebuilds the marker');
  CacheStore.write(meta('P', 1), rec(1));                                       // refused (halted)
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('A4 J1 resume clears peek and fires the resume hook exactly once, so the edits held here are re-stored', async () => {
  await CacheStore.ready(U);
  let saves = 0;
  const off = CacheStore.onResume(() => { saves++; CacheStore.write(meta('P', 2), rec(2)); });
  CacheStore.write(meta('P', 2), rec(2));
  CacheStore.halt();
  lsf.ls.removeItem(recKey('P')); lsf.ls.removeItem(MARKER_KEY);
  CacheStore._storageEventForTests({ key: recKey('P'), newValue: null });
  CacheStore.resume(U);
  assert.equal(saves, 1, 'one save per resume');
  assert.ok(lsf.ls.getItem(recKey('P')), 'the edits are on disk again (identical json is not skipped as "already stored")');
  assert.equal(JSON.parse(lsf.ls.getItem(MARKER_KEY)).dirtyPlants[0], 'P');
  CacheStore.resume(U);                                                         // not halted: nothing to do
  assert.equal(saves, 1);
  off();
  CacheStore.halt(); CacheStore.resume(U);
  assert.equal(saves, 1, 'an unsubscribed hook is not called');
});

test('A4 J1 even without a record event, resume drops every stale peek (a missed event cannot hide unbacked edits)', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 1), rec(1));
  CacheStore.halt();
  lsf.ls.removeItem(recKey('P'));                                               // no storage event was delivered
  CacheStore.resume(U);
  assert.equal(CacheStore.peek('P'), null);
  assert.equal(CacheStore.write(meta('P', 1), rec(1)).skipped, undefined, 'the next identical write really puts');
  assert.ok(lsf.ls.getItem(recKey('P')));
});

/* ---------------------------------------------------------------- J2 */

test('A4 J2 a page named for alice never writes under bob, halted or not, even after ready(bob)', async () => {
  CacheStore.setPageUser(U);
  await CacheStore.ready(U);
  assert.equal(CacheStore.write(meta('P', 1), rec(1)).ok, true);
  await CacheStore.ready('bob');                                                // a superseded load re-opens the store for the new actor
  assert.equal(CacheStore.write(meta('P', 1, 'bob'), rec(1)).reason, 'wrong-user');
  assert.equal(lsf.ls.getItem(recKey('P', 'bob')), null);
  assert.equal(lsf.ls.getItem(recKey('P')) !== null, true, 'alice\'s own record is untouched');
});

test('A4 J2 ready(otherUser) while halted sets a sign-in-required latch only resume() lifts; resumeSameUser is refused', async () => {
  CacheStore.setPageUser(U);
  await CacheStore.ready(U);
  CacheStore.halt();
  assert.equal(CacheStore.resumeSameUser(U), true, 'no latch yet: the same user may resume');
  CacheStore.halt();
  await CacheStore.ready('bob');
  assert.equal(CacheStore.resumeSameUser(U), false, 'latched');
  assert.equal(CacheStore.resumeSameUser('bob'), false, 'and never for another user');
  assert.equal(CacheStore.stats().halted, true);
  CacheStore.resume(U);                                                         // the sign-in path
  assert.equal(CacheStore.stats().halted, false);
  CacheStore.halt();
  assert.equal(CacheStore.resumeSameUser(U), true, 'the latch was lifted by the sign-in');
});

test('A4 J2 resumeSameUser needs the captured user (page user, else the first user the store opened for)', async () => {
  await CacheStore.ready(U);                                                    // no page user named: first ready() is the capture
  CacheStore.halt();
  assert.equal(CacheStore.resumeSameUser('bob'), false);
  assert.equal(CacheStore.resumeSameUser(U), true);
  CacheStore._setBackendForTests();
  CacheStore.halt();
  assert.equal(CacheStore.resumeSameUser(U), false, 'no captured user at all: never resumes');
});

/* ---------------------------------------------------------------- n5, n6 */

test('A4 n5 degraded follows the records whose LAST put failed: a later success clears it', async () => {
  await CacheStore.ready(U);
  lsf.ctl.quotaChars = 0;
  CacheStore.write(meta('P', 1), rec(1));
  assert.equal(CacheStore.stats().failedKeys, 1);
  lsf.ctl.quotaChars = Infinity;
  CacheStore.write(meta('P', 2), rec(2));
  assert.equal(CacheStore.stats().failedKeys, 0, 'the retry landed');
  assert.equal(CacheStore.stats().failed, 1, 'the cumulative count stays as history');
});

test('A4 n6 stats().blocked is true only when localStorage is really unavailable, not for a store that was never opened', async () => {
  assert.equal(CacheStore.stats().mode, 'none');
  assert.equal(CacheStore.stats().blocked, false, 'not opened yet is not blocked');
  delete globalThis.localStorage;
  assert.equal(CacheStore.stats().blocked, true);
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'none');
  assert.equal(CacheStore.stats().blocked, true);
});
