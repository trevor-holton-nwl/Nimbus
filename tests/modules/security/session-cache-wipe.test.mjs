// T6: sign-out, 12 h expiry and admin Reset wipe the compact autosave cache (marker, records, quarantine copy), a sign-in is the
// only thing that lifts a cache halt, and another tab's sign-out halts this tab's cache writes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX, QUARANTINE_KEY } from '../../../frontend/platform/cache-store.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

globalThis.window = globalThis.window || {};
let lsf;
let reloads;
const origLoc = globalThis.location;
beforeEach(() => {
  lsf = installFakeLocalStorage();
  CacheStore._setBackendForTests();
  reloads = [];
  Session._resetLeavingForTests();
  globalThis.location = { reload: () => reloads.push('reload') };
  globalThis.sessionStorage = { clear() {}, getItem: () => null, setItem() {}, removeItem() {} };
  lsf.ls.setItem('nimbus.session', JSON.stringify({ username: 'alice', role: 'planner', loggedInAt: Date.now() }));
});
afterEach(() => {
  delete globalThis.localStorage;
  globalThis.location = origLoc;
  CacheStore._setBackendForTests();
});

const seedCache = () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 3, user: 'alice', dirty: true, dirtyPlants: ['P1'] }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P1', JSON.stringify({ key: 'alice|P1', user: 'alice', plant: 'P1', seq: 3, savedAt: 1, json: '{"rows":[{}]}' }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'bob|P2', JSON.stringify({ key: 'bob|P2', user: 'bob', plant: 'P2', seq: 1, savedAt: 1, json: '{"rows":[{}]}' }));
  lsf.ls.setItem('nimbus.state.v3', '{"tasks":[]}');
};
const cacheKeys = () => [...lsf.map.keys()].filter(k => k.startsWith('nimbus.cache.') || k === 'nimbus.state.v3');

test('sign-out leaves no marker, no record (any user), no quarantine copy and no legacy key', async () => {
  seedCache();
  lsf.ls.setItem(QUARANTINE_KEY, '{"raw":"x"}');
  await CacheStore.ready('alice');
  await Session.signOut({ hasPendingWork: () => false, beforeClear: () => {} });
  assert.deepEqual(cacheKeys(), []);
  assert.equal(lsf.ls.getItem('nimbus.session'), null);
  assert.deepEqual(reloads, ['reload']);
});

test('sign-out halts the cache on its own (no beforeClear) and clears; a later write is refused', async () => {
  await CacheStore.ready('alice');
  CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[{}]}');
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), 'the write landed synchronously, so there is nothing in flight to wait for');
  await Session.signOut({});
  assert.equal(CacheStore.stats().halted, true);
  assert.deepEqual(cacheKeys(), []);
  assert.deepEqual(reloads, ['reload']);
  assert.equal(CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[1]}').reason, 'halted');
});

test('12 h expiry with no store open (before boot) clears marker and records', async () => {
  seedCache();
  assert.equal(CacheStore.stats().mode, 'none');
  await Session.clearExpired();
  assert.deepEqual(cacheKeys(), []);
  assert.equal(lsf.ls.getItem('nimbus.session'), null);
});

test('a ready() right behind the expiry wipe is not wiped afterwards (the wipe is synchronous)', async () => {
  seedCache();
  const wipe = Session.clearExpired();
  await CacheStore.ready('alice');
  await wipe;
  assert.equal(CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[{}]}').ok, true);
});

test('admin Reset (clearLocalPlannerData with keepQueuedWork) wipes the cache but keeps queued calendar deletes', async () => {
  seedCache();
  lsf.ls.setItem('nimbus.calendar.pendingDeletes', '{"a":1}');
  await CacheStore.ready('alice');
  await Session.clearLocalPlannerData({ keepQueuedWork: true });
  assert.deepEqual(cacheKeys(), []);
  assert.equal(lsf.ls.getItem('nimbus.calendar.pendingDeletes'), '{"a":1}');
});

test('clearLocalPlannerData removes the cache keys synchronously (before its promise settles)', () => {
  seedCache();
  const p = Session.clearLocalPlannerData();
  assert.deepEqual(cacheKeys(), []);
  return p;
});

test('only signIn lifts a cache halt; it also sweeps other users\' orphans but keeps the signing-in user\'s rows', async () => {
  seedCache();
  await CacheStore.ready('alice');
  CacheStore.halt();
  await CacheStore.ready('alice');
  assert.equal(CacheStore.stats().halted, true);
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ username: 'alice', role: 'planner', allowed_plants: null, settings: {}, role_settings: {} }) });
  try { await Session.signIn('alice', 'pw'); } finally { globalThis.fetch = origFetch; }
  assert.equal(CacheStore.stats().halted, false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'bob|P2'), null, 'another user\'s record is swept at the gate');
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), 'the signing-in user\'s record with rows survives');
});

test('storage event: another tab removing nimbus.session, clearing storage, or signing in as someone else halts this tab\'s cache writes', async () => {
  const meta = { user: 'alice', plant: 'P1', dirty: true };
  const cases = [
    { key: 'nimbus.session', newValue: null },
    { key: null, newValue: null },
    { key: 'nimbus.session', newValue: JSON.stringify({ username: 'bob' }) },
    { key: 'nimbus.session', newValue: 'not json' },
  ];
  for (const ev of cases) {
    CacheStore._setBackendForTests();
    await CacheStore.ready('alice');
    assert.equal(CacheStore.write(meta, '{"rows":[1]}').ok, true);
    Session._storageEventForTests(ev);
    assert.equal(CacheStore.write(meta, '{"rows":[1,2]}').reason, 'halted', JSON.stringify(ev));
  }
  // the same user refreshing the session blob, or an unrelated key, changes nothing
  CacheStore._setBackendForTests();
  await CacheStore.ready('alice');
  Session._storageEventForTests({ key: 'nimbus.session', newValue: JSON.stringify({ username: 'alice', settings: {} }) });
  Session._storageEventForTests({ key: 'nimbus.theme', newValue: null });
  assert.equal(CacheStore.write(meta, '{"rows":[1]}').ok, true);
});

/* ------------------------------------------------ Review A3: M3 halt recovery, m7 expiry count */

const withToasts = fn => async () => {
  const real = Toast.show; const toasts = [];
  Toast.show = (m, t) => { toasts.push({ m, t }); };
  try { await fn(toasts); } finally { Toast.show = real; }
};

test('M3 a halt caused by another tab is announced once, and the same user signing back in elsewhere lifts it', withToasts(async toasts => {
  const meta = { user: 'alice', plant: 'P1', dirty: true };
  await CacheStore.ready('alice');
  assert.equal(CacheStore.write(meta, '{"rows":[1]}').ok, true);
  Session._storageEventForTests({ key: 'nimbus.session', newValue: null });             // another tab signed out
  assert.equal(CacheStore.stats().halted, true);
  Session._storageEventForTests({ key: null, newValue: null });                          // a second event: no second toast
  assert.equal(toasts.filter(x => x.m === 'toast.cache_halted_other_tab' || /halted|paused|Autosave/i.test(String(x.m))).length, 1, JSON.stringify(toasts));
  Session._storageEventForTests({ key: 'nimbus.session', newValue: JSON.stringify({ username: 'alice', settings: {} }) });   // alice signs in again there
  assert.equal(CacheStore.stats().halted, false, 'same user back: autosave resumes');
  assert.equal(CacheStore.write(meta, '{"rows":[1,2]}').ok, true);
}));

test('M3 another user signing in elsewhere keeps this tab halted; a confirmed sign-out here is never resumed by a session write', withToasts(async () => {
  await CacheStore.ready('alice');
  Session._storageEventForTests({ key: 'nimbus.session', newValue: JSON.stringify({ username: 'bob' }) });
  Session._storageEventForTests({ key: 'nimbus.session', newValue: JSON.stringify({ username: 'bob' }) });
  assert.equal(CacheStore.stats().halted, true);
  CacheStore._setBackendForTests();
  await CacheStore.ready('alice');
  await Session.signOut({});
  assert.equal(CacheStore.stats().halted, true);
  Session._storageEventForTests({ key: 'nimbus.session', newValue: JSON.stringify({ username: 'alice' }) });
  assert.equal(CacheStore.stats().halted, true, 'this page is leaving: the halt stays');
}));

test('M3 a tab that never opened the cache does not toast when the session key vanishes', withToasts(async toasts => {
  Session._storageEventForTests({ key: 'nimbus.session', newValue: null });
  assert.deepEqual(toasts, []);
}));

test('m7 expiredEditCount sums the signed-in user stored unsaved rows across plants, before the wipe removes them', () => {
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P1', JSON.stringify({ key: 'alice|P1', user: 'alice', plant: 'P1', seq: 3, savedAt: 1, json: '{"rows":[{},{}]}' }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P2', JSON.stringify({ key: 'alice|P2', user: 'alice', plant: 'P2', seq: 4, savedAt: 1, json: '{"rows":[{}]}' }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'bob|P2', JSON.stringify({ key: 'bob|P2', user: 'bob', plant: 'P2', seq: 1, savedAt: 1, json: '{"rows":[{},{},{}]}' }));
  assert.equal(Session.expiredEditCount(), 3);
  Session.clearExpired();
  assert.equal(Session.expiredEditCount(), 0, 'nothing left after the wipe (and no session)');
});

test('m1 clearLocalPlannerData removes every record key before the marker', () => {
  seedCache();
  const order = []; const real = lsf.ls.removeItem;
  lsf.ls.removeItem = k => { order.push(k); return real(k); };
  Session.clearLocalPlannerData();
  const m = order.indexOf(MARKER_KEY);
  assert.ok(m >= 0);
  for (const k of order.filter(x => x.startsWith(LS_RECORD_PREFIX))) assert.ok(order.indexOf(k) < m, `${k} before the marker`);
});
