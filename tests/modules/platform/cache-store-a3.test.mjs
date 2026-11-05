// Review A3 fixes in the cache store: cross-tab record ownership (writer id, seq floor), halted tabs never rebuild a marker,
// quarantine rules (whole copy or no removal, per-user key, one toast), dirty plants the user can no longer open, and the
// per-user stored-row count Reset and sign-out use.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore, MARKER_KEY, LS_RECORD_PREFIX, QUARANTINE_KEY, QUARANTINE_CAP_CHARS } from '../../../frontend/platform/cache-store.mjs';
import { installFakeLocalStorage } from '../helpers/cache-backend-fake.mjs';

const U = 'alice';
let lsf;
beforeEach(() => { lsf = installFakeLocalStorage(); CacheStore._setBackendForTests(); });
afterEach(() => { delete globalThis.localStorage; CacheStore._setBackendForTests(); });

const meta = (plant, rows = 1, user = U) => ({ user, plant, dirty: rows > 0, rows });
const rec = rows => JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => ({ id: `R${i}` })) });
const recKey = (plant, user = U) => LS_RECORD_PREFIX + `${user}|${plant}`;
const stored = (plant, user = U) => { const raw = lsf.ls.getItem(recKey(plant, user)); return raw ? JSON.parse(raw) : null; };
/** A record another tab wrote: a different writer id and whatever seq that tab had reached. */
const foreign = (plant, rows, seq, user = U) => lsf.ls.setItem(recKey(plant, user),
  JSON.stringify({ key: `${user}|${plant}`, user, plant, seq, savedAt: 1, json: rec(rows), writer: 'other-tab' }));
const marker = () => JSON.parse(lsf.ls.getItem(MARKER_KEY));

/* ---------------------------------------------------------------- M1 */

test('M1 an empty write never deletes a newer unsaved record another tab wrote, even when its seq is LOWER than ours', async () => {
  await CacheStore.ready(U);
  for (let i = 1; i <= 5; i++) CacheStore.write(meta('P', 1), JSON.stringify({ rows: [{ id: 'a' + i }] }));   // this tab reaches a high seq
  CacheStore.write(meta('P', 0), rec(0));                                                                    // then it has nothing
  assert.equal(stored('P'), null, 'its own record is deleted once empty');
  foreign('P', 2, 1);                                                                                         // tab B: newer in time, lower seq
  assert.equal(CacheStore.write(meta('P', 0), rec(0)).ok, true);
  assert.ok(stored('P'), 'the other tab\'s unsaved record survives this tab\'s empty write');
  assert.equal(stored('P').writer, 'other-tab');
  assert.deepEqual(marker().dirtyPlants, ['P'], 'and its dirty claim stays');
});

test('M1 a stored record carrying our own writer id and an old seq IS ours: an empty write deletes it', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 2), rec(2));
  CacheStore._storageEventForTests({ key: recKey('P'), newValue: null });   // forgets peek, keeps lastSeqWritten
  assert.equal(CacheStore.write(meta('P', 0), rec(0)).ok, true);
  assert.equal(stored('P'), null);
  assert.deepEqual(marker().dirtyPlants, []);
});

test('M1 a record with our seq but another writer (or none) is never ours', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 1), rec(1));
  const seq = stored('P').seq;
  foreign('P', 3, seq);                                        // same seq number, another tab
  CacheStore._storageEventForTests({ key: recKey('P'), newValue: 'x' });
  CacheStore.write(meta('P', 0), rec(0));
  assert.ok(stored('P'), 'same seq, other writer: kept');
  lsf.ls.setItem(recKey('P'), JSON.stringify({ key: 'alice|P', user: U, plant: 'P', seq: 1, savedAt: 1, json: rec(2) }));   // pre-A3 record, no writer
  CacheStore.write(meta('P', 0), rec(0));
  assert.ok(stored('P'), 'a record without a writer id is never deleted by an empty write');
});

test('M1 a write lifts this tab\'s seq above the marker and the stored record, so its record always carries the higher number', async () => {
  await CacheStore.ready(U);
  foreign('P', 1, 40);
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P', seq: 40, user: U, dirty: true, dirtyPlants: ['P'] }));
  CacheStore._storageEventForTests({ key: recKey('P'), newValue: 'x' });
  CacheStore.write(meta('P', 1), rec(1));
  assert.ok(stored('P').seq > 40, `seq ${stored('P').seq} must exceed the other tab's 40`);
  assert.equal(stored('P').writer, CacheStore._tabIdForTests());
  // a plant this tab never wrote: the marker's seq still lifts it
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P', seq: 90, user: U, dirty: true, dirtyPlants: ['P'] }));
  CacheStore.write(meta('Q', 1), rec(1));
  assert.ok(stored('Q').seq > 90);
});

test('M1 importLegacy raises the seq floor and stamps the writer', async () => {
  await CacheStore.ready(U);
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'Z', seq: 70, user: U, dirty: true, dirtyPlants: ['Z'] }));
  assert.equal((await CacheStore.importLegacy(rec(1), 'P', U, { converted: true, dirty: true })).imported, true);
  assert.ok(stored('P').seq > 70);
  assert.equal(stored('P').writer, CacheStore._tabIdForTests());
});

/* ---------------------------------------------------------------- m1 */

test('m1 a halted tab ignores marker storage events (it never rebuilds a marker from records that are still there)', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 2), rec(2));
  CacheStore.halt();
  lsf.ls.removeItem(MARKER_KEY);
  CacheStore._storageEventForTests({ key: MARKER_KEY, newValue: null });
  assert.equal(lsf.ls.getItem(MARKER_KEY), null);
});

test('m1 wipe and discard remove the record keys BEFORE the marker', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('P', 1), rec(1));
  const order = [];
  const realRemove = lsf.ls.removeItem;
  lsf.ls.removeItem = k => { order.push(k); return realRemove(k); };
  await CacheStore.discard('P');
  assert.ok(order.indexOf(recKey('P')) >= 0);
  const markerAt = order.indexOf(MARKER_KEY);
  if (markerAt >= 0) assert.ok(order.indexOf(recKey('P')) < markerAt, 'discard: record first');
  CacheStore.write(meta('P', 1), rec(1)); CacheStore.write(meta('Q', 1), rec(1));
  order.length = 0;
  await CacheStore.wipe();
  assert.ok(order.indexOf(MARKER_KEY) > order.indexOf(recKey('P')) && order.indexOf(MARKER_KEY) > order.indexOf(recKey('Q')), 'wipe: marker last');
});

/* ---------------------------------------------------------------- m4 */

test('A4 n1 an oversize unparseable record is told once (read_failed), copied capped, then REMOVED so writes resume (the old "left in place, held forever" rule is gone on purpose)', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, user: U, dirty: true, dirtyPlants: ['P1'] }));
  const garbage = '{"key":"alice|P1","json":' + 'z'.repeat(QUARANTINE_CAP_CHARS + 10);
  lsf.ls.setItem(recKey('P1'), garbage);
  const boot = await CacheStore.ready(U);
  assert.equal(lsf.ls.getItem(recKey('P1')), null, 'the record is removed');
  assert.equal(boot.notices.includes('read_failed'), true, 'the user is told');
  assert.equal(boot.notices.includes('corrupt_record'), false);
  assert.equal(boot.notices.includes('dirty_no_record'), false, 'no second notice for the same key');
  const q = JSON.parse(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|P1`));
  assert.equal(q.raw.length, QUARANTINE_CAP_CHARS, 'the copy is capped');
  assert.equal(q.truncated, true);
  assert.equal(CacheStore.write(meta('P1', 1), rec(1)).ok, true, 'writes for that plant resume');
  // a later boot reads no error
  CacheStore._setBackendForTests();
  assert.equal((await CacheStore.ready(U)).notices.includes('read_failed'), false);
});

test('m4 when the quarantine copy cannot be stored the record stays and is held', async () => {
  await CacheStore.ready(U);
  lsf.ls.setItem(recKey('P2'), '{"key":"alice|P2","user":"alice"}');
  lsf.ctl.quotaChars = 0;                               // every further setItem throws QuotaExceededError
  const r = await CacheStore.read('P2');
  assert.equal(r.ok, false);
  assert.ok(lsf.ls.getItem(recKey('P2')), 'not removed without a copy');
  assert.deepEqual(CacheStore.takeNotices(), ['read_failed']);
});

test('m4 the quarantine copy is per user+plant, whole, and a second corrupt record does not overwrite the first', async () => {
  await CacheStore.ready(U);
  lsf.ls.setItem(recKey('A'), '{"key":"alice|A","bad":');
  lsf.ls.setItem(recKey('B'), '{"key":"alice|B","bad":');
  await CacheStore.read('A'); await CacheStore.read('B');
  const qa = JSON.parse(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|A`)); const qb = JSON.parse(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|B`));
  assert.equal(qa.raw, '{"key":"alice|A","bad":');
  assert.equal(qb.raw, '{"key":"alice|B","bad":');
});

test('m4 the orphan sweep deletes another user\'s quarantine copy (new per-user key and the old single slot), keeps ours', async () => {
  lsf.ls.setItem(`${QUARANTINE_KEY}.bob|P`, '{"raw":"x"}');
  lsf.ls.setItem(`${QUARANTINE_KEY}.alice|P`, '{"raw":"y"}');
  lsf.ls.setItem(QUARANTINE_KEY, JSON.stringify({ key: 'bob|P', raw: 'z' }));
  await CacheStore.sweepOrphans(U);
  assert.equal(lsf.ls.getItem(`${QUARANTINE_KEY}.bob|P`), null);
  assert.equal(lsf.ls.getItem(QUARANTINE_KEY), null, 'the old single slot of another user');
  assert.ok(lsf.ls.getItem(`${QUARANTINE_KEY}.alice|P`));
  lsf.ls.setItem(QUARANTINE_KEY, JSON.stringify({ key: 'alice|P', raw: 'z' }));
  await CacheStore.sweepOrphans(U);
  assert.ok(lsf.ls.getItem(QUARANTINE_KEY), 'our own old slot stays');
});

test('m4 a corrupt dirty record at boot raises corrupt_record only, not dirty_no_record as well, and its dirty claim is withdrawn', async () => {
  lsf.ls.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: 'P1', seq: 4, user: U, dirty: true, dirtyPlants: ['P1'] }));
  lsf.ls.setItem(recKey('P1'), '{"broken":');
  const boot = await CacheStore.ready(U);
  assert.deepEqual(boot.notices, ['corrupt_record']);
  assert.deepEqual(marker().dirtyPlants, []);
});

/* ---------------------------------------------------------------- m5 */

test('m5 a dirty plant the user can no longer open is neither remembered nor announced, but its record stays', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('GONE', 2), rec(2));
  CacheStore.write(meta('OK', 1), rec(1));
  CacheStore.setPlantScope(() => ['OK']);
  assert.deepEqual(CacheStore.dirtyPlants(), ['OK']);
  assert.equal(CacheStore.rememberedPlant(), 'OK', 'never boots straight into a plant the user cannot open');
  assert.equal(CacheStore.rememberedDirty(), true);
  const boot = await (async () => { CacheStore._setBackendForTests(); CacheStore.setPlantScope(() => ['OK']); return CacheStore.ready(U); })();
  assert.equal(boot.plant, 'OK');
  assert.equal(boot.notices.includes('other_dirty_plants'), false, 'the unopenable plant is not announced every boot');
  assert.ok(stored('GONE'), 'never auto-deleted');
  assert.ok(CacheStore.dirtyFromStorage(U).some(d => d.plant === 'GONE'), 'still counted for Reset and sign-out');
  CacheStore.setPlantScope(null);
});

test('m5 only unopenable dirty plants: the boot default-plant step is not blocked and no plant is remembered', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('GONE', 1), rec(1));
  CacheStore.setPlantScope(() => ['OK']);
  assert.equal(CacheStore.rememberedDirty(), false);
  assert.equal(CacheStore.rememberedPlant(), null);
  CacheStore.setPlantScope(() => { throw new Error('no session'); });
  assert.equal(CacheStore.rememberedPlant(), 'GONE', 'scope unavailable: nothing is hidden');
  CacheStore.setPlantScope(null);
});

/* ---------------------------------------------------------------- M2 */

test('M2 dirtyFromStorage sums this user\'s stored rows per plant (every record, not other users\')', async () => {
  await CacheStore.ready(U);
  CacheStore.write(meta('A', 3), rec(3));
  CacheStore.write(meta('B', 2), rec(2));
  foreign('C', 5, 1, 'bob');
  assert.deepEqual(CacheStore.dirtyFromStorage(U).sort((a, b) => a.plant.localeCompare(b.plant)), [{ plant: 'A', rows: 3, ids: ['R0', 'R1', 'R2'] }, { plant: 'B', rows: 2, ids: ['R0', 'R1'] }]);
  assert.deepEqual(CacheStore.dirtyFromStorage('system'), []);
});
