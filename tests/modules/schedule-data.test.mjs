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
    row_version: '5',
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
