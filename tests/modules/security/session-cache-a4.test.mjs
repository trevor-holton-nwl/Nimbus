// Review A4: the Session storage listener resumes a halted tab only for the user the page was loaded for (J2), re-stores the
// edits held in memory on resume (J1), and the boot gate names that user.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX } from '../../../frontend/platform/cache-store.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

globalThis.window = globalThis.window || {};
let lsf; let realToast;
beforeEach(() => {
  lsf = installFakeLocalStorage();
  CacheStore._setBackendForTests();
  Session._resetLeavingForTests();
  realToast = Toast.show; Toast.show = () => {};
  lsf.ls.setItem('nimbus.session', JSON.stringify({ username: 'alice', role: 'planner', loggedInAt: Date.now() }));
});
afterEach(() => { Toast.show = realToast; delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (user = 'alice') => ({ user, plant: 'P1', dirty: true, rows: 1 });
const rec = '{"rows":[{"id":"R0"}]}';
const sess = username => ({ key: 'nimbus.session', newValue: JSON.stringify({ username }) });

test('A4 J2 the boot gate names the page user', async () => {
  await Session.sweepOrphanCache();
  assert.equal(CacheStore.pageUser(), 'alice');
});

test('A4 J1 a storage-event resume re-stores the edits held in memory after another tab wiped the records', async () => {
  let saves = 0;
  const off = CacheStore.onResume(() => { saves++; CacheStore.write(meta(), rec); });
  await CacheStore.ready('alice');
  CacheStore.write(meta(), rec);
  Session._storageEventForTests({ key: 'nimbus.session', newValue: null });          // another tab signed out and wiped
  assert.equal(CacheStore.stats().halted, true);
  lsf.ls.removeItem(LS_RECORD_PREFIX + 'alice|P1'); lsf.ls.removeItem(MARKER_KEY);
  CacheStore._storageEventForTests({ key: LS_RECORD_PREFIX + 'alice|P1', newValue: null });
  Session._storageEventForTests(sess('alice'));                                       // alice signs in there again
  assert.equal(CacheStore.stats().halted, false);
  assert.equal(saves, 1);
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), 'the unbacked edits are on disk again');
  off();
});

test('A4 J2 a stale alice tab: bob signing in elsewhere, ready(bob) here, then bob\'s session write never resumes it or files alice\'s edits under bob', async () => {
  await Session.sweepOrphanCache();                                                   // page user = alice
  await CacheStore.ready('alice');
  CacheStore.write(meta(), rec);
  Session._storageEventForTests(sess('bob'));                                         // halted
  assert.equal(CacheStore.stats().halted, true);
  await CacheStore.ready('bob');                                                      // a superseded load re-opens the store for the new actor
  Session._storageEventForTests(sess('bob'));                                         // a later nimbus.session write by bob
  assert.equal(CacheStore.stats().halted, true, 'bob\'s write does not resume the tab');
  assert.equal(CacheStore.write(meta('bob'), rec).reason, 'halted');
  Session._storageEventForTests(sess('alice'));                                       // even alice\'s own write: sign-in required
  assert.equal(CacheStore.stats().halted, true, 'latched until this page signs in');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'bob|P1'), null, 'nothing was ever filed under bob');
  CacheStore.resume('alice');                                                         // the sign-in path
  assert.equal(CacheStore.stats().halted, false);
});

test('A4 J2 resume from a storage event is only for the user the page was loaded for', async () => {
  await Session.sweepOrphanCache();
  await CacheStore.ready('alice');
  Session._storageEventForTests({ key: 'nimbus.session', newValue: null });
  Session._storageEventForTests(sess('bob'));
  assert.equal(CacheStore.stats().halted, true, 'another user does not resume it');
  Session._storageEventForTests(sess('alice'));
  assert.equal(CacheStore.stats().halted, false, 'the captured user does');
});

test('A4 J2 a page whose store was re-opened for bob (not halted) still treats bob\'s session write as "someone else" and halts', async () => {
  await Session.sweepOrphanCache();
  await CacheStore.ready('alice');
  await CacheStore.ready('bob');
  Session._storageEventForTests(sess('bob'));
  assert.equal(CacheStore.stats().halted, true, 'compared with the page user (alice), not CacheStore.user() (bob)');
});
