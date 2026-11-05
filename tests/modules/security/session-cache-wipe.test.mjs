// T6: sign-out, 12 h expiry and admin Reset wipe the compact autosave cache (marker, records, IndexedDB), a sign-in is the
// only thing that lifts a cache halt, and another tab's sign-out halts this tab's cache writes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX } from '../../../frontend/platform/cache-store.mjs';
import { makeFakeBackend, installFakeLocalStorage, installFakeIndexedDB } from '../helpers/cache-backend-fake.mjs';

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
  delete globalThis.localStorage; delete globalThis.indexedDB;
  globalThis.location = origLoc;
  CacheStore._setBackendForTests();
});

const seedCache = (fi) => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 3, backend: fi ? 'idb' : 'localstorage', user: 'alice', dirty: true }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'alice|P1', JSON.stringify({ key: 'alice|P1', user: 'alice', plant: 'P1', seq: 3, savedAt: 1, json: '{"rows":[{}]}' }));
  lsf.ls.setItem(LS_RECORD_PREFIX + 'bob|P2', JSON.stringify({ key: 'bob|P2', user: 'bob', plant: 'P2', seq: 1, savedAt: 1, json: '{"rows":[{}]}' }));
  lsf.ls.setItem('nimbus.state.v3', '{"tasks":[]}');
  if (fi) fi.records.set('alice|P1', { key: 'alice|P1', user: 'alice', plant: 'P1', seq: 3, savedAt: 1, json: '{"rows":[{}]}' });
};
const cacheKeys = () => [...lsf.map.keys()].filter(k => k === MARKER_KEY || k.startsWith(LS_RECORD_PREFIX) || k === 'nimbus.state.v3');

test('sign-out leaves no marker, no record (any user) and no legacy key, and nothing in IndexedDB', async () => {
  const fi = installFakeIndexedDB();
  seedCache(fi);
  await CacheStore.ready('alice');
  await Session.signOut({ hasPendingWork: () => false, beforeClear: () => {} });
  assert.deepEqual(cacheKeys(), []);
  assert.equal(fi.records.size, 0);
  assert.equal(lsf.ls.getItem('nimbus.session'), null);
  assert.deepEqual(reloads, ['reload']);
});

test('sign-out halts the cache on its own (no beforeClear), lets an in-flight put land first, and clears after it', async () => {
  const f = makeFakeBackend();
  const real = f.backend.put; const gates = [];
  f.backend.put = rec => new Promise(res => gates.push(() => res(real(rec))));
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready('alice');
  CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[{}]}');   // put in flight, uncommitted
  const out = Session.signOut({});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(CacheStore.stats().halted, true);
  assert.deepEqual(reloads, [], 'sign-out is still waiting for the put to settle');
  gates[0]();
  await out;
  assert.equal(f.data.size, 0, 'the put committed, then the clear removed it');
  assert.deepEqual(reloads, ['reload']);
  assert.equal(CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[1]}').reason, 'halted');
});

test('sign-out does not wait past 500 ms for a put that never settles', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready('alice');
  f.ctl.hangPuts = true;
  CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[{}]}');
  const t0 = Date.now();
  await Session.signOut({});
  const dt = Date.now() - t0;
  assert.ok(dt >= 400 && dt < 2500, `waited ${dt} ms`);
  assert.deepEqual(reloads, ['reload']);
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('12 h expiry with no backend open (before boot) clears marker, records and IndexedDB', async () => {
  const fi = installFakeIndexedDB();
  seedCache(fi);
  assert.equal(CacheStore.stats().mode, 'none');
  await Session.clearExpired();
  assert.deepEqual(cacheKeys(), []);
  assert.equal(fi.records.size, 0);
  assert.ok(fi.ctl.dbs.every(d => d.closed));
  assert.equal(lsf.ls.getItem('nimbus.session'), null);
});

test('a ready() racing the expiry wipe waits for it, so a fast sign-in is never wiped afterwards', async () => {
  const fi = installFakeIndexedDB();
  seedCache(fi);
  const wipe = Session.clearExpired();
  await CacheStore.ready('alice');
  await wipe;
  assert.equal(CacheStore.write({ user: 'alice', plant: 'P1', dirty: true }, '{"rows":[{}]}').ok, true);
});

test('admin Reset (clearLocalPlannerData with keepQueuedWork) wipes the cache but keeps queued calendar deletes', async () => {
  const fi = installFakeIndexedDB();
  seedCache(fi);
  lsf.ls.setItem('nimbus.calendar.pendingDeletes', '{"a":1}');
  await CacheStore.ready('alice');
  await Session.clearLocalPlannerData({ keepQueuedWork: true });
  assert.deepEqual(cacheKeys(), []);
  assert.equal(fi.records.size, 0);
  assert.equal(lsf.ls.getItem('nimbus.calendar.pendingDeletes'), '{"a":1}');
});

test('clearLocalPlannerData removes the cache keys synchronously (before its promise settles)', () => {
  seedCache(null);
  const p = Session.clearLocalPlannerData();
  assert.deepEqual(cacheKeys(), []);
  return p;
});

test('only signIn lifts a cache halt; it also sweeps other users\' orphans but keeps the signing-in user\'s rows', async () => {
  seedCache(null);
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
