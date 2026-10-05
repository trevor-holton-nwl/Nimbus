// Tests for frontend/security/session.mjs, split from
// tests/modules/schedule-data.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// into 3 domain files: scheduling/persistence.mjs, calendar/calendar-sync.mjs,
// security/session.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {} }),
    body: { insertBefore() {} },
  };
}

// Minimal in-memory localStorage — Session reads/writes it directly (no DI
// seam for storage), and plain Node has no global localStorage.
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

test('#30 Session.signIn keeps the HTTP status and readable text so the login screen can tell throttling/outage from bad credentials', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ detail: [{ loc: ['body'], msg: 'rate limited' }] }) });
    await assert.rejects(Session.signIn('trevor', 'pw'), e => e.status === 429 && e.message === 'rate limited');
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('html')) });
    await assert.rejects(Session.signIn('trevor', 'pw'), e => e.status === 503);
  } finally {
    globalThis.fetch = origFetch;
  }
});
