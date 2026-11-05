// T6: sign-out, 12 h expiry and admin Reset wipe the compact autosave cache (marker, records, quarantine copy), a sign-in is the
// only thing that lifts a cache halt, and another tab's sign-out halts this tab's cache writes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX, QUARANTINE_KEY } from '../../../frontend/platform/cache-store.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

globalThis.window = globalThis.window || {};
let lsf;
let reloads;
const origLoc = globalThis.location;
beforeEach(() => {
  lsf = installFakeLocalStorage();
  CacheStore._setBackendForTests();
  reloads = [];
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
