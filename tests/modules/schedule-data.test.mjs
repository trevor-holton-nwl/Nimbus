// Tests for web/schedule-data.mjs — CQ-1 Phase 2 Task 4.
//
// Persistence/CalendarSync reach ErrorLog/Toast (application-foundation.mjs), which
// reference bare `document`/`window` — same split-realm-free, DOM-less environment as
// tests/modules/schedule-services.test.mjs. Minimal stubs keep those paths a real no-op
// instead of throwing "document/window is not defined".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Persistence, CalendarSync, Session } from '../../web/schedule-data.mjs';
import { Store } from '../../web/schedule-state.mjs';
import { Config } from '../../web/application-foundation.mjs';

globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    body: { insertBefore() {} },
  };
}

// Minimal in-memory localStorage — Persistence.load()/saveAll()/_saveCache() read and
// write it directly (no DI seam for storage), and plain Node has no global localStorage.
function makeStorage() {
  const store = new Map();
  return {
    getItem:    k => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear:      () => { store.clear(); },
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
  };
}
globalThis.localStorage = globalThis.localStorage || makeStorage();

test('Persistence.setCalendarService is settable and Persistence works with a stub before it is wired', () => {
  assert.equal(typeof Persistence.setCalendarService, 'function');
  // A snap-affecting path should not throw even with no calendar service wired yet —
  // it should just skip snapping, not crash the load.
  const tasks = [{
    id: 'nosvc1', PRODUCTION_LINE: 'L9', RUN_TIME: '1',
    start_date: new Date('2026-08-03T00:00:00'),
    end_date:   new Date('2026-08-03T01:00:00'),
  }];
  assert.doesNotThrow(() => Persistence._snapToWorkingHours(tasks, '5512'));
});

test('Persistence.saveAll still posts the documented payload shape (base_version/force/blocks/calendars)', () => {
  Store.setTasks([{
    id: 'pd1', PRODUCTION_LINE: 'L1', RUN_TIME: '1',
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
    row_version: '5', PRT_01: 'MOLD-A', PRT_02: 'MOLD-B', PRODUCTION_VERSION: '0001',
  }], 'unit-test');
  Persistence._dirtyIds.add('pd1');

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ versions: {}, stale: [], persisted: 1, updated: 1 }) });
  };
  try {
    Persistence.saveAll();
    const saveCall = calls.find(c => c.url.includes('/tasks/update'));
    assert.ok(saveCall, 'saveAll must POST to /tasks/update');
    assert.equal(saveCall.opts.method, 'POST');
    const body = JSON.parse(saveCall.opts.body);
    assert.ok(Array.isArray(body.tasks), 'payload must have a tasks array');
    assert.ok(Array.isArray(body.blocks), 'payload must always include blocks');
    assert.ok('calendars' in body, 'payload must always include calendars');
    const t = body.tasks.find(x => x.id === 'pd1');
    assert.ok(t, 'dirty task must be in the payload');
    assert.ok('start_date' in t, 'task must have start_date');
    assert.ok('end_date' in t, 'task must have end_date');
    assert.ok('base_version' in t, 'task must carry base_version for optimistic concurrency');
    assert.ok('force' in t, 'task must carry force flag');
    assert.equal(t.PRT_01, 'MOLD-A');
    assert.equal(t.PRT_02, 'MOLD-B');
    assert.equal(t.PRODUCTION_VERSION, '0001');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.saveAll sends the full split aggregate in naive-local form', () => {
  Store.setTasks([{
    id: 'split-save', PRODUCTION_LINE: 'L1', RUN_TIME: '10',
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-04T10:00:00'),
    row_version: '5',
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-03T08:00:00'), endDate: new Date('2026-08-03T16:00:00') },
      { sequence: 2, startDate: new Date('2026-08-04T08:00:00'), endDate: new Date('2026-08-04T10:00:00') },
    ],
  }], 'unit-test');
  Persistence._dirtyIds.add('split-save');

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ versions: {}, stale: [], persisted: 1, updated: 1 }) });
  };
  try {
    Persistence.saveAll();
    const saveCall = calls.find(c => c.url.includes('/tasks/update'));
    const task = JSON.parse(saveCall.opts.body).tasks.find(x => x.id === 'split-save');
    assert.equal(task.RUN_TIME, '10');
    assert.deepEqual(task.schedule_segments, [
      { sequence: 1, start_date: '2026-08-03T08:00:00', end_date: '2026-08-03T16:00:00' },
      { sequence: 2, start_date: '2026-08-04T08:00:00', end_date: '2026-08-04T10:00:00' },
    ]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('saveAll clears terminally-rejected ids (invalid_ids/not_found_ids) so they stop being retried forever', async () => {
  // Regression guard for a latent client↔server contract bug: the backend's
  // /tasks/update forwards invalid_ids/not_found_ids (terminal rejections — inverted
  // range or id-not-in-DB) and saveAll's R7 logic must add them to its `accounted`
  // set and clear them from _dirtyIds. Before the fix the endpoint sent only counts,
  // so these ids never cleared → they re-posted on every save and spammed a
  // "Partial DB save" warning with no way to resolve.
  Store.setTasks([
    { id: 'ok1',       PRODUCTION_LINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
    { id: 'bad-range', PRODUCTION_LINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
    { id: 'gone',      PRODUCTION_LINE: 'L1', RUN_TIME: '1', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'), row_version: '5' },
  ], 'unit-test');
  Persistence._dirtyIds.add('ok1');
  Persistence._dirtyIds.add('bad-range');
  Persistence._dirtyIds.add('gone');

  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      versions: { ok1: '6' }, stale: [],
      invalid_ids: ['bad-range'], not_found_ids: ['gone'],
      persisted: 1, updated: 3,
    }),
  });
  try {
    Persistence.saveAll();
    // Flush the fetch → r.json() → result-handler microtask chain (saveAll returns void).
    await new Promise(res => setTimeout(res, 0));
    assert.ok(!Persistence._dirtyIds.has('ok1'),       'persisted id must clear');
    assert.ok(!Persistence._dirtyIds.has('bad-range'), 'invalid_ids id must clear (terminal — do not retry forever)');
    assert.ok(!Persistence._dirtyIds.has('gone'),      'not_found_ids id must clear (terminal — row not in DB)');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('a load that needs to snap a task to working hours calls the injected calendar service, not a global', () => {
  const calls = [];
  Persistence.setCalendarService({
    beginRun: (plant) => calls.push(['beginRun', plant]),
    endRun: () => calls.push(['endRun']),
    nextAvailable: (line, from, ms) => { calls.push(['nextAvailable', line]); return from; },
    workWindow: (line, date) => { calls.push(['workWindow', line]); return null; },
  });
  const tasks = [{
    id: 'snap1', PRODUCTION_LINE: 'L9', RUN_TIME: '1',
    start_date: new Date('2026-08-03T00:00:00'), // midnight -> triggers the snap path
    end_date:   new Date('2026-08-03T01:00:00'),
  }];
  Persistence._snapToWorkingHours(tasks, '5512');
  assert.ok(calls.some(c => c[0] === 'beginRun'), 'must call the injected beginRun');
  assert.ok(calls.some(c => c[0] === 'nextAvailable'), 'must call the injected nextAvailable');
  assert.ok(calls.some(c => c[0] === 'endRun'), 'must call the injected endRun');
});

test('CalendarSync is exported alongside Persistence with its documented public API', () => {
  assert.equal(typeof CalendarSync.fetchPlantConfig, 'function');
  assert.equal(typeof CalendarSync.savePlantHours, 'function');
  assert.equal(typeof CalendarSync.saveLineBlackoutUpsert, 'function');
  assert.equal(typeof CalendarSync.flushPlant, 'function');
});

test('Persistence.loadPriorityRankMaps returns a real awaitable promise and null-clears the cache', async () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  Persistence._rankMapsPlant = '5512';
  const p = Persistence.loadPriorityRankMaps(null);
  assert.ok(p instanceof Promise, 'must return a real promise, not fire-and-forget');
  await p;
  assert.deepEqual(Store.priorityRankMaps, {});
  assert.equal(Persistence._rankMapsPlant, null);
});

test('Persistence.loadPriorityRankMaps fetches GET /priority-rank-maps?plant= and tracks freshness on success', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ '': { colorWheel: { RED: 1 } } }) });
  };
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.ok(calls.some(u => u.includes('/priority-rank-maps?plant=5512')), 'must GET the plant-scoped endpoint');
    assert.deepEqual(Store.priorityRankMaps, { '': { colorWheel: { RED: 1 } } });
    assert.equal(Persistence._rankMapsPlant, '5512', 'freshness marker must record the plant just fetched');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps does NOT mark a plant fresh on a resolved-but-non-ok response (e.g. a transient 502)', async () => {
  // Regression guard: a resolved response with ok:false (unlike a thrown/rejected
  // fetch) previously still set _rankMapsPlant = plant, which would make Task 6's
  // freshness check (`_rankMapsPlant !== plant`) wrongly trust an empty cache as
  // current — silently ranking every order at the 999999 default with no error.
  Persistence._rankMapsPlant = null;
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.deepEqual(Store.priorityRankMaps, {}, 'a non-ok response must not leave stale data lying around');
    assert.notEqual(Persistence._rankMapsPlant, '5512', 'must NOT claim freshness for a plant whose response was resolved-but-not-ok');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps clears the cache but leaves the freshness marker stale on network failure, so a later check still retries', async () => {
  Persistence._rankMapsPlant = null;
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  try {
    await Persistence.loadPriorityRankMaps('9999');
    assert.deepEqual(Store.priorityRankMaps, {}, 'a failed fetch must not leave stale data lying around');
    assert.notEqual(Persistence._rankMapsPlant, '9999', 'must NOT claim freshness for a plant whose fetch failed');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.loadPriorityRankMaps goes through Util.fetchTraced, so the plant-gate identity header is sent', async () => {
  // GET /priority-rank-maps is plant-gated server-side (brain.py's
  // _assert_plant_allowed). The actor identity that gate reads rides on the
  // x-user-email header Util.fetchTraced attaches — a bare fetch() sends none and
  // 403s for every plant-restricted user. Assert the header actually arrives, which
  // is the only observable difference between the two call styles from here.
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? null });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  try {
    await Persistence.loadPriorityRankMaps('5512');
    assert.equal(seen.length, 1);
    const h = seen[0].headers;
    assert.ok(h && typeof h.get === 'function', 'fetchTraced must pass a real Headers object');
    assert.ok(h.has('x-request-id'), 'x-request-id must be attached (backend log correlation)');
    assert.ok(h.has('x-user-email') || h.has('X-User'),
      'an identity header must be attached or the server-side plant gate rejects the request');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// Stage 3 fix — the rank cache must not survive a plant switch.
//
// The window this closes: load() calls Store.setTasks() and emits the FIRST
// 'schedule:hydrated' (which triggers the alert recompute that renders auto-fix
// buttons) long before loadPriorityRankMaps() runs for the new plant — that call
// sits inside the master-data Promise.all's .finally(). Without an early clear,
// the new plant's orders and alerts are on screen while Store.priorityRankMaps
// still holds the OLD plant's ranks, and Alerts.applyFix's overload branch —
// which cannot await freshness (schedule-services.mjs must not import
// schedule-data.mjs) — would sequence against the wrong plant's priority lists.
// ---------------------------------------------------------------------------

test('Persistence.load drops the previous plant\'s rank maps immediately on a plant switch, before the new fetch resolves', () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1, BLUE: 2 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';

  const origFetch = globalThis.fetch;
  // Nothing ever settles: this pins the assertion to exactly the window between
  // "load started for the new plant" and "the new plant's ranks arrived".
  globalThis.fetch = () => new Promise(() => {});
  try {
    const p = Persistence.load({ plant: 'PLANT_B' });
    if (p && typeof p.catch === 'function') p.catch(() => {});

    assert.deepEqual(Store.priorityRankMaps, {},
      'PLANT_A\'s ranks must be gone the moment a load for PLANT_B starts — otherwise an overload auto-fix in this window sequences PLANT_B\'s orders against PLANT_A\'s priority lists');
    assert.equal(Persistence._rankMapsPlant, null,
      'the freshness marker must read stale so OptimizeDialog.run()\'s guard re-fetches');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence.load does NOT wipe a still-valid cache when reloading the SAME plant', () => {
  // The clear is conditional on an actual change: a force-reload of the current
  // plant must not needlessly discard good ranks and open a fresh unranked window.
  const maps = { '': { colorWheel: { RED: 1 } } };
  Store.setPriorityRankMaps(maps, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';

  const origFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const p = Persistence.load({ plant: 'PLANT_A', force: true });
    if (p && typeof p.catch === 'function') p.catch(() => {});

    assert.deepEqual(Store.priorityRankMaps, maps, 'same-plant reload must keep the cache');
    assert.equal(Persistence._rankMapsPlant, 'PLANT_A', 'same-plant reload must keep the freshness marker');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Persistence._loadCache clears the rank cache — the offline restore hydrates without ever loading rank maps', () => {
  // Same exposure as _loadDemo: this is the backend-failed / boot restore path. It
  // rehydrates whatever plant was last persisted, which need not be the plant the
  // rank cache holds, and it emits schedule:hydrated regardless.
  localStorage.setItem(Config.LS_KEY, JSON.stringify({
    _schemaVersion: Config.SCHEMA_VERSION,
    tasks: [],
  }));
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';
  try {
    assert.equal(Persistence._loadCache(), true, 'a schema-current cache must restore');
    assert.deepEqual(Store.priorityRankMaps, {},
      'ranks cannot be trusted to match a cache-restored board, so they must be dropped');
    assert.equal(Persistence._rankMapsPlant, null);
  } finally {
    localStorage.removeItem(Config.LS_KEY);
  }
});

test('Persistence._loadDemo clears the rank cache — it hydrates and emits schedule:hydrated but never loads rank maps', () => {
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  Persistence._rankMapsPlant = 'PLANT_A';
  Persistence._loadDemo();
  assert.deepEqual(Store.priorityRankMaps, {},
    'demo orders belong to no real plant\'s priority lists, so any retained ranks are categorically wrong for them');
  assert.equal(Persistence._rankMapsPlant, null);
});

test('Session exposes only the pure session/pref API (no DOM-rendering methods)', () => {
  assert.equal(typeof Session.currentUser, 'function');
  assert.equal(typeof Session.actor, 'function');
  assert.equal(typeof Session.isAdmin, 'function');
  assert.equal(typeof Session.allowedPlants, 'function');
  assert.equal(typeof Session.pref, 'function');
  assert.equal(typeof Session.setPref, 'function');
  assert.equal(Session._renderUserButton, undefined);
  assert.equal(Session._renderSettingsPanes, undefined);
  assert.equal(Session.saveProfile, undefined);
});

test('Session.currentUser()/actor()/isAdmin()/allowedPlants() read straight from localStorage', () => {
  const origGetItem = globalThis.localStorage.getItem;
  globalThis.localStorage.getItem = (k) => k === 'nimbus.session'
    ? JSON.stringify({ username: 'trevor', role: 'admin', allowed_plants: ['5512'] })
    : null;
  try {
    assert.deepEqual(Session.currentUser(), { username: 'trevor', role: 'admin', allowed_plants: ['5512'] });
    assert.equal(Session.actor(), 'trevor');
    assert.equal(Session.isAdmin(), true);
    assert.deepEqual(Session.allowedPlants(), ['5512']);
  } finally {
    globalThis.localStorage.getItem = origGetItem;
  }
});

test('Session.signIn emits a session:changed event instead of touching DOM directly', async () => {
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'session:changed') events.push(evt); });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      username: 'trevor', role: 'admin', allowed_plants: null,
      first_name: 'Trevor', last_name: 'Holton', settings: {}, role_settings: {},
    }),
  });
  try {
    const data = await Session.signIn('trevor', 'pw');
    assert.equal(data.username, 'trevor');
  } finally {
    globalThis.fetch = origFetch;
    off();
  }
  assert.ok(events.some(e => e.kind === 'signin'), 'signIn must emit a session:changed/signin event');
});

test('Session.updateCachedUser merges a patch into the cached session blob', () => {
  globalThis.localStorage.setItem('nimbus.session', JSON.stringify({ username: 'trevor', role: 'admin' }));
  const merged = Session.updateCachedUser({ first_name: 'Trevor', last_name: 'Holton' });
  assert.equal(merged.first_name, 'Trevor');
  assert.equal(merged.username, 'trevor', 'existing fields must be preserved, not clobbered');
  const stored = JSON.parse(globalThis.localStorage.getItem('nimbus.session'));
  assert.equal(stored.last_name, 'Holton');
});
