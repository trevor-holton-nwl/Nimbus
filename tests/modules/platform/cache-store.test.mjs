// cache-store: two interchangeable backends (IndexedDB, localStorage) behind one interface, per user+plant
// records, a seq marker, fail-open fallbacks. Backends are hand-rolled fakes (tests/modules/helpers/
// cache-backend-fake.mjs); the real IndexedDB backend is also driven through a minimal indexedDB global.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheStore, DEFAULT_BACKEND, MARKER_KEY, LS_RECORD_PREFIX, makeLocalStorageBackend,
} from '../../../frontend/platform/cache-store.mjs';
import { Config } from '../../../frontend/platform/foundation.mjs';
import { makeFakeBackend, installFakeLocalStorage, installFakeIndexedDB } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; delete globalThis.indexedDB; CacheStore._setBackendForTests(); });

const meta = (plant, dirty = true, user = U) => ({ user, plant, dirty });
const marker = () => JSON.parse(lsf.ls.getItem(MARKER_KEY));

// Backend matrix: both must behave identically from the caller's side.
const flavours = {
  idb: () => { const f = makeFakeBackend(); return { opts: { defaultBackend: 'idb', idb: f.backend }, fake: f }; },
  localstorage: () => ({ opts: { defaultBackend: 'localstorage' }, fake: null }),
};

test('DEFAULT_BACKEND is the single switch and is localstorage', () => {
  assert.equal(DEFAULT_BACKEND, 'localstorage');
});

test('Node path: no indexedDB resolves at once on localStorage and writes land synchronously', async () => {
  assert.equal(typeof indexedDB, 'undefined');
  const p = CacheStore.ready(U);
  const r = CacheStore.write(meta('P1'), '{"a":1}'); // no await between ready() and write()
  assert.equal(r.ok, true);
  const raw = lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1');
  assert.ok(raw, 'record is in localStorage immediately');
  assert.equal(JSON.parse(raw).json, '{"a":1}');
  assert.deepEqual({ plant: marker().plant, backend: marker().backend, user: marker().user, dirty: marker().dirty }, { plant: 'P1', backend: 'localstorage', user: U, dirty: true });
  await p;
  assert.equal(CacheStore.stats().mode, 'localstorage');
  assert.equal(CacheStore.stats().backend, 'localstorage');
  assert.equal(LS_RECORD_PREFIX === Config.LS_KEY, false);
  assert.equal(lsf.ls.getItem(Config.LS_KEY), null, 'never touches the legacy key');
});

for (const [name, mk] of Object.entries(flavours)) {
  test(`[${name}] round trip survives a reload and exposes peek/rememberedPlant`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.write(meta('P1'), '{"rows":[1,2,3]}');
    await CacheStore.settled();
    assert.equal(CacheStore.peek('P1').json, '{"rows":[1,2,3]}');
    assert.equal(CacheStore.rememberedPlant(), 'P1');
    CacheStore._setBackendForTests(opts); // new page load: module state gone, storage kept
    const boot = await CacheStore.ready(U);
    assert.equal(boot.record.json, '{"rows":[1,2,3]}');
    assert.equal(boot.plant, 'P1');
    assert.deepEqual(boot.notices, []);
    assert.equal(CacheStore.peek().json, '{"rows":[1,2,3]}');
  });

  test(`[${name}] identical JSON is skipped, changed JSON writes`, async () => {
    const { opts, fake } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    assert.equal(CacheStore.write(meta('P1'), '{"x":1}').skipped, undefined);
    await CacheStore.settled();
    const seq = CacheStore.stats().seq;
    const again = CacheStore.write(meta('P1'), '{"x":1}');
    assert.equal(again.skipped, true);
    assert.equal(CacheStore.stats().seq, seq);
    if (fake) assert.equal(fake.ctl.putCount, 1);
    assert.equal(CacheStore.write(meta('P1'), '{"x":2}').skipped, undefined);
    assert.equal(CacheStore.stats().seq, seq + 1);
  });

  test(`[${name}] records are isolated per user and plant`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.write(meta('A'), '{"plant":"A"}');
    await CacheStore.settled();
    CacheStore.write(meta('B'), '{"plant":"B"}');
    await CacheStore.settled();
    assert.equal(CacheStore.peek('A').json, '{"plant":"A"}', 'writing plant B left plant A intact');
    CacheStore._setBackendForTests(opts);
    // marker now points at B; A is still in storage and reachable once the marker follows it.
    lsf.ls.setItem(MARKER_KEY, JSON.stringify({ ...marker(), plant: 'A', seq: 1 }));
    const boot = await CacheStore.ready(U);
    assert.equal(boot.record.json, '{"plant":"A"}');
    // another user never sees alice's record
    CacheStore._setBackendForTests(opts);
    const other = await CacheStore.ready('bob');
    assert.equal(other.record, null);
  });

  test(`[${name}] halt makes writes no-ops until ready() again`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.halt();
    const r = CacheStore.write(meta('P1'), '{"x":1}');
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'halted' });
    assert.equal(CacheStore.stats().halted, true);
    assert.equal(CacheStore.peek('P1'), null);
    await CacheStore.ready(U); // new sign-in lifts it
    assert.equal(CacheStore.write(meta('P1'), '{"x":1}').ok, true);
  });

  test(`[${name}] wipe clears records, peek and marker`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.write(meta('A'), '{"a":1}');
    CacheStore.write(meta('B'), '{"b":1}');
    await CacheStore.settled();
    await CacheStore.wipe();
    assert.equal(lsf.ls.getItem(MARKER_KEY), null);
    assert.equal(CacheStore.peek('A'), null);
    CacheStore._setBackendForTests(opts);
    const boot = await CacheStore.ready(U);
    assert.equal(boot.record, null);
    for (const k of [...lsf.map.keys()]) assert.equal(k.startsWith(LS_RECORD_PREFIX), false);
  });

  test(`[${name}] discard removes one plant record and its marker, leaves the others`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.write(meta('A'), '{"a":1}');
    await CacheStore.settled();
    CacheStore.write(meta('B'), '{"b":1}');
    await CacheStore.settled();
    await CacheStore.discard('B');
    assert.equal(lsf.ls.getItem(MARKER_KEY), null);
    assert.equal(CacheStore.peek('B'), null);
    assert.equal(CacheStore.peek('A').json, '{"a":1}');
  });

  test(`[${name}] 'system' actor and empty plant are refused`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready('system');
    assert.equal(CacheStore.write(meta('P1', true, 'system'), '{}').reason, 'system-actor');
    assert.equal(CacheStore.write(meta('', true, U), '{}').reason, 'no-plant');
    assert.equal(lsf.ls.getItem(MARKER_KEY), null);
  });

  test(`[${name}] marker dirty but no record: notice raised and marker cleared`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, backend: name, user: U, dirty: true }));
    const boot = await CacheStore.ready(U);
    assert.equal(boot.record, null);
    assert.deepEqual(boot.notices, ['dirty_no_record']);
    assert.equal(lsf.ls.getItem(MARKER_KEY), null);
  });

  test(`[${name}] record seq lower than marker seq restores the older record and flags it`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    CacheStore.write(meta('P1'), '{"v":1}');
    await CacheStore.settled();
    CacheStore._setBackendForTests(opts);
    lsf.ls.setItem(MARKER_KEY, JSON.stringify({ ...marker(), seq: 99 })); // a newer put was started and never landed
    const boot = await CacheStore.ready(U);
    assert.equal(boot.record.json, '{"v":1}');
    assert.deepEqual(boot.notices, ['older_record']);
    assert.ok(CacheStore.stats().seq >= 99, 'seq stays monotonic');
    assert.deepEqual(CacheStore.takeNotices(), ['older_record']);
    assert.deepEqual(CacheStore.takeNotices(), []);
  });

  test(`[${name}] importLegacy imports once, removes the legacy key, refuses when a record exists`, async () => {
    const { opts } = mk();
    CacheStore._setBackendForTests(opts);
    await CacheStore.ready(U);
    lsf.ls.setItem(Config.LS_KEY, '{"legacy":true}');
    assert.deepEqual(await CacheStore.importLegacy('{"legacy":true}', 'P1', U), { imported: true });
    assert.equal(lsf.ls.getItem(Config.LS_KEY), null);
    assert.equal(CacheStore.peek('P1').json, '{"legacy":true}');
    assert.equal((await CacheStore.importLegacy('{"x":1}', 'P1', U)).reason, 'record-exists');
    assert.equal((await CacheStore.importLegacy('not json', 'P2', U)).reason, 'unparseable');
    assert.equal((await CacheStore.importLegacy('{}', 'P2', 'system')).reason, 'bad-args');
  });
}

test('flush while a put is in flight uses its own transaction and does not wait', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  f.ctl.hold = 1;                                 // first put stays pending
  CacheStore.write(meta('P1'), '{"v":1}');        // in flight, held
  assert.equal(f.heldCount(), 1);
  CacheStore.write(meta('P1'), '{"v":2}');        // queued behind it
  CacheStore.write(meta('P1'), '{"v":3}');        // coalesces over v2
  assert.equal(CacheStore.stats().pending, 2);
  const res = await CacheStore.flush();           // resolves although put #1 is still held
  assert.equal(res.ok, true);
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 3);
  assert.equal(f.ctl.putCount, 2, 'v2 was coalesced away: one held put plus one flush put');
  f.release();                                    // late commit of the older put
  await CacheStore.settled();
  assert.equal(CacheStore.stats().pending, 0);
});

test('rapid writes coalesce behind an in-flight put into the latest value only', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  f.ctl.hold = 1;
  for (let i = 1; i <= 5; i++) CacheStore.write(meta('P1'), `{"v":${i}}`);
  f.release();
  await CacheStore.settled();
  assert.equal(f.ctl.putCount, 2);
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 5);
  assert.equal(marker().seq, 5, 'marker follows every write, not every put');
});

test('IDB open failing falls back to localStorage automatically and says so', async () => {
  const f = makeFakeBackend();
  f.ctl.failOpen = true;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  const boot = await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'fallback');
  assert.equal(CacheStore.stats().backend, 'localstorage');
  assert.deepEqual(boot.notices, ['idb_fallback']);
  CacheStore.write(meta('P1'), '{"x":1}');
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'));
  assert.equal(marker().backend, 'localstorage');
});

test('IDB open that never settles times out (3 s in production, shortened here) and falls back', async () => {
  const f = makeFakeBackend();
  f.ctl.blockOpen = true;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend, openTimeoutMs: 30 });
  const t0 = Date.now();
  await CacheStore.ready(U);
  assert.ok(Date.now() - t0 >= 25, 'waited for the timeout');
  assert.equal(CacheStore.stats().backend, 'localstorage');
  assert.equal(CacheStore.stats().mode, 'fallback');
  assert.equal(CacheStore.write(meta('P1'), '{"x":1}').ok, true);
});

test('marker naming localStorage wins when IDB opens late: record moves to IDB and the stale copy is deleted', async () => {
  // Boot 1: IDB was down, edits went to localStorage.
  const down = makeFakeBackend(); down.ctl.failOpen = true;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: down.backend });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"v":"ls"}');
  // Boot 2: IDB is back, and holds an OLDER record for the same key.
  const up = makeFakeBackend();
  up.data.set('alice|P1', { key: 'alice|P1', user: U, plant: 'P1', seq: 0, savedAt: 1, json: '{"v":"old-idb"}' });
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: up.backend });
  const boot = await CacheStore.ready(U);
  assert.equal(boot.backend, 'idb');
  assert.equal(boot.record.json, '{"v":"ls"}');
  assert.equal(JSON.parse(up.data.get('alice|P1').json).v, 'ls');
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null, 'stale localStorage copy removed');
});

test('a failing get at boot does not throw and yields no record', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 1, backend: 'idb', user: U, dirty: false }));
  f.ctl.failGet = true;
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record, null);
});

test('IDB put abort counts as failed, raises one notice, no latch: the next write retries and succeeds', async () => {
  const f = makeFakeBackend();
  f.ctl.quotaOnPut = 1;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
  assert.equal(f.data.size, 0);
  // Identical JSON must NOT be skipped after a failure: it retries.
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 1);
  assert.equal(CacheStore.stats().lastChars, '{"v":1}'.length);
  // A second failure later notifies again only after a success reset it.
  f.ctl.quotaOnPut = f.ctl.putCount + 1;
  CacheStore.write(meta('P1'), '{"v":2}');
  await CacheStore.settled();
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
});

test('localStorage QuotaExceededError: failure result, failed++, no latch, a later write succeeds', async () => {
  CacheStore._setBackendForTests({ defaultBackend: 'localstorage' });
  await CacheStore.ready(U);
  lsf.ctl.failNext = 2; // marker write (best effort) and then the record put both hit quota
  const r = CacheStore.write(meta('P1'), '{"v":1}');
  assert.equal(r.ok, false);
  assert.match(r.error, /QuotaExceededError/);
  assert.equal(CacheStore.stats().failed, 1);
  assert.deepEqual(CacheStore.takeNotices(), ['put_failed']);
  const r2 = CacheStore.write(meta('P1'), '{"v":1}');
  assert.equal(r2.ok, true);
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'));
});

test('localStorage backend over a real character quota fails cleanly then recovers when the payload shrinks', async () => {
  lsf.ctl.quotaChars = 400;
  CacheStore._setBackendForTests({ defaultBackend: 'localstorage' });
  await CacheStore.ready(U);
  assert.equal(CacheStore.write(meta('P1'), JSON.stringify({ big: 'x'.repeat(2000) })).ok, false);
  assert.equal(CacheStore.stats().failed, 1);
  assert.equal(CacheStore.write(meta('P1'), '{"small":1}').ok, true);
});

test('a put that never commits is abandoned by the watchdog, so later writes still go through', async () => {
  const f = makeFakeBackend();
  f.ctl.hangPuts = true;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend, putTimeoutMs: 30 });
  await CacheStore.ready(U);
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
  f.ctl.hangPuts = false;
  CacheStore.write(meta('P1'), '{"v":2}');
  await CacheStore.settled();
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 2);
});

test('both backends missing yields mode none and writes report not-ready instead of throwing', async () => {
  delete globalThis.localStorage;
  const f = makeFakeBackend(); f.ctl.failOpen = true;
  CacheStore._setBackendForTests({ defaultBackend: 'idb', idb: f.backend });
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'none');
  assert.equal(CacheStore.write(meta('P1'), '{}').ok, false);
});

/* ---------- the real IndexedDB backend, driven through a minimal indexedDB global ---------- */

test('real IDB backend: round trip, wipe is store.clear on the open connection', async () => {
  const idb = installFakeIndexedDB();
  CacheStore._setBackendForTests({ defaultBackend: 'idb' });
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'idb');
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(JSON.parse(idb.records.get('alice|P1').json).v, 1);
  assert.equal(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), null, 'idb mode does not touch the localStorage store');
  CacheStore._setBackendForTests({ defaultBackend: 'idb' });
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record.json, '{"v":1}');
  const opens = idb.ctl.opens;
  await CacheStore.wipe();
  assert.equal(idb.records.size, 0);
  assert.equal(idb.ctl.opens, opens, 'no reopen or deleteDatabase for wipe');
});

test('real IDB backend: tx abort is a failed put (quota), not a latch', async () => {
  const idb = installFakeIndexedDB();
  CacheStore._setBackendForTests({ defaultBackend: 'idb' });
  await CacheStore.ready(U);
  idb.ctl.abortPuts = true;
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
  idb.ctl.abortPuts = false;
  CacheStore.write(meta('P1'), '{"v":2}');
  await CacheStore.settled();
  assert.equal(JSON.parse(idb.records.get('alice|P1').json).v, 2);
});

test('real IDB backend: versionchange and close do not null the handle forever (lazy reopen)', async () => {
  const idb = installFakeIndexedDB();
  CacheStore._setBackendForTests({ defaultBackend: 'idb' });
  await CacheStore.ready(U);
  idb.versionChange();
  CacheStore.write(meta('P1'), '{"v":1}');
  await CacheStore.settled();
  assert.equal(idb.ctl.opens, 2, 'reopened after versionchange');
  assert.equal(CacheStore.stats().failed, 0);
  idb.dropConnections();
  CacheStore.write(meta('P1'), '{"v":2}');
  await CacheStore.settled();
  assert.equal(idb.ctl.opens, 3, 'reopened after close');
  assert.equal(JSON.parse(idb.records.get('alice|P1').json).v, 2);
});

test('real IDB backend: blocked, error and hung opens all fall back to localStorage', async () => {
  for (const m of ['blocked', 'error', 'hang']) {
    const idb = installFakeIndexedDB();
    idb.ctl.mode = m;
    CacheStore._setBackendForTests({ defaultBackend: 'idb', openTimeoutMs: 40 });
    await CacheStore.ready(U);
    assert.equal(CacheStore.stats().backend, 'localstorage', m);
    assert.equal(CacheStore.stats().mode, 'fallback', m);
    assert.equal(CacheStore.write(meta('P1'), `{"m":"${m}"}`).ok, true, m);
    delete globalThis.indexedDB;
  }
});

test('localStorage backend exposes the shared interface directly', async () => {
  const b = makeLocalStorageBackend();
  await b.open();
  assert.deepEqual(b.put({ key: 'k', user: 'u', plant: 'p', seq: 1, savedAt: 0, json: '{}' }), { ok: true });
  assert.equal((await b.get('k')).json, '{}');
  await b.del('k');
  assert.equal(await b.get('k'), null);
});

/* ---------- localStorage default, IndexedDB as the automatic fallback ---------- */

test('localStorage is the default: no options, an IDB present but untouched, mode localstorage, record in localStorage', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ idb: f.backend });
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'localstorage');
  assert.equal(CacheStore.stats().backend, 'localstorage');
  assert.equal(CacheStore.write(meta('P1'), '{"v":1}').ok, true);
  assert.ok(lsf.ls.getItem(LS_RECORD_PREFIX + 'alice|P1'), 'written synchronously');
  assert.equal(marker().backend, 'localstorage');
  assert.equal(f.ctl.putCount, 0, 'IndexedDB is not touched while localStorage works');
  CacheStore._setBackendForTests({ idb: f.backend }); // reload
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record.json, '{"v":1}');
  assert.equal(boot.backend, 'localstorage');
});

test('localStorage quota failure falls back to IndexedDB without losing the write, and later writes stay there', async () => {
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ idb: f.backend });
  await CacheStore.ready(U);
  lsf.ctl.failNext = 2; // marker write and record put both hit quota
  const r = CacheStore.write(meta('P1'), '{"v":1}');
  assert.equal(r.ok, true);
  await CacheStore.settled();
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 1, 'the write landed in IDB');
  assert.equal(CacheStore.stats().mode, 'fallback');
  assert.equal(CacheStore.stats().backend, 'idb');
  assert.equal(CacheStore.stats().failed, 0);
  assert.deepEqual(CacheStore.takeNotices(), ['idb_fallback']);
  CacheStore.write(meta('P1'), '{"v":2}');
  await CacheStore.settled();
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 2);
  assert.equal(marker().backend, 'idb', 'marker names the store that holds the record');
  // Reload: boot reads the record from IDB through the marker.
  CacheStore._setBackendForTests({ idb: f.backend });
  const boot = await CacheStore.ready(U);
  assert.equal(boot.record.json, '{"v":2}');
});

test('localStorage quota failure with IDB also failing reports a failed put, no latch', async () => {
  const f = makeFakeBackend(); f.ctl.quotaOnPut = 1;
  CacheStore._setBackendForTests({ idb: f.backend });
  await CacheStore.ready(U);
  lsf.ctl.quotaChars = 100;
  assert.equal(CacheStore.write(meta('P1'), JSON.stringify({ big: 'x'.repeat(500) })).ok, true);
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
  assert.equal(CacheStore.stats().backend, 'localstorage');
  assert.equal(CacheStore.write(meta('P1'), '{"s":1}').ok, true);
  await CacheStore.settled();
  assert.equal(CacheStore.stats().failed, 1);
});

test('localStorage blocked at open falls back to IndexedDB; both blocked leaves mode none with no latch', async () => {
  delete globalThis.localStorage;
  const f = makeFakeBackend();
  CacheStore._setBackendForTests({ idb: f.backend });
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'fallback');
  assert.equal(CacheStore.stats().backend, 'idb');
  assert.equal(CacheStore.write(meta('P1'), '{"v":1}').ok, true);
  await CacheStore.settled();
  assert.equal(JSON.parse(f.data.get('alice|P1').json).v, 1);

  const down = makeFakeBackend(); down.ctl.failOpen = true;
  CacheStore._setBackendForTests({ idb: down.backend });
  await CacheStore.ready(U);
  assert.equal(CacheStore.stats().mode, 'none');
  assert.equal(CacheStore.stats().halted, false);
  assert.equal(CacheStore.write(meta('P1'), '{}').ok, false);
  assert.equal(CacheStore.stats().failed, 0);
});
