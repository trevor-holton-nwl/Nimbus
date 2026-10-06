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

// ---- Task 7: sign-out clears shared-PC planner data -----------------------
import { Modal, Util } from '../../../frontend/platform/foundation.mjs';

function seedPlannerData() {
  const ls = globalThis.localStorage;
  ls.setItem('nimbus.session', JSON.stringify({ username: 'trevor', role: 'admin' }));
  ls.setItem('nimbus.state.v3', '{}');
  ls.setItem('nimbus.state.v3.quarantine.1', '{}');
  ls.setItem('nimbus.recentCmds', '[]');
  ls.setItem('nimbus.patterns.v1', '{}');
  ls.setItem('nimbus.calendar.pendingDeletes', '{}');
  ls.setItem('nimbus.theme', 'dark');
  ls.setItem('nimbus.locale', 'de');
  globalThis.sessionStorage = globalThis.sessionStorage || makeStorage();
  globalThis.sessionStorage.setItem('x', '1');
}

function withSignOutStubs(confirmResult, fn) {
  const origConfirm = Modal.confirm;
  const origLoc = globalThis.location;
  const calls = { order: [], confirms: 0 };
  Modal.confirm = async () => { calls.confirms++; calls.order.push('confirm'); return confirmResult; };
  globalThis.location = { reload: () => calls.order.push('reload') };
  return fn(calls).finally(() => { Modal.confirm = origConfirm; globalThis.location = origLoc; });
}

test('signOut with nothing pending clears planner data, keeps theme/locale, reloads without confirming', async () => {
  seedPlannerData();
  await withSignOutStubs(true, async (calls) => {
    await Session.signOut({ hasPendingWork: () => false, beforeClear: () => calls.order.push('before') });
    assert.equal(calls.confirms, 0);
    assert.deepEqual(calls.order, ['before', 'reload']);
  });
  const ls = globalThis.localStorage;
  for (const k of ['nimbus.session', 'nimbus.state.v3', 'nimbus.state.v3.quarantine.1', 'nimbus.recentCmds', 'nimbus.patterns.v1', 'nimbus.calendar.pendingDeletes']) {
    assert.equal(ls.getItem(k), null, k + ' must be cleared');
  }
  assert.equal(globalThis.sessionStorage.getItem('x'), null);
  assert.equal(ls.getItem('nimbus.theme'), 'dark');
  assert.equal(ls.getItem('nimbus.locale'), 'de');
});

test('signOut with pending work confirms first; Cancel aborts and clears nothing', async () => {
  seedPlannerData();
  await withSignOutStubs(false, async (calls) => {
    const out = await Session.signOut({ hasPendingWork: () => true, beforeClear: () => calls.order.push('before') });
    assert.equal(out, false);
    assert.deepEqual(calls.order, ['confirm']);
  });
  assert.notEqual(globalThis.localStorage.getItem('nimbus.state.v3'), null);
  assert.notEqual(globalThis.localStorage.getItem('nimbus.session'), null);
});

test('signOut with pending work: reload happens only after the confirm resolves', async () => {
  seedPlannerData();
  await withSignOutStubs(true, async (calls) => {
    await Session.signOut({ hasPendingWork: () => true, beforeClear: () => calls.order.push('before') });
    assert.deepEqual(calls.order, ['confirm', 'before', 'reload']);
  });
  assert.equal(globalThis.localStorage.getItem('nimbus.state.v3'), null);
});

test('clearLocalPlannerData is exported and keeps theme/locale', () => {
  seedPlannerData();
  Session.clearLocalPlannerData();
  assert.equal(globalThis.localStorage.getItem('nimbus.state.v3.quarantine.1'), null);
  assert.equal(globalThis.localStorage.getItem('nimbus.theme'), 'dark');
});

test('clearLocalPlannerData({keepQueuedWork}) keeps pendingDeletes but clears the rest; default clears it', () => {
  seedPlannerData();
  Session.clearLocalPlannerData({ keepQueuedWork: true });
  assert.notEqual(globalThis.localStorage.getItem('nimbus.calendar.pendingDeletes'), null);
  assert.equal(globalThis.localStorage.getItem('nimbus.recentCmds'), null);
  assert.equal(globalThis.localStorage.getItem('nimbus.state.v3'), null);
  Session.clearLocalPlannerData();
  assert.equal(globalThis.localStorage.getItem('nimbus.calendar.pendingDeletes'), null);
});

test('signOut still reloads when the session:changed emit throws', async () => {
  seedPlannerData();
  const origEmit = Store.emit;
  Store.emit = () => { throw new Error('boom'); };
  try {
    await withSignOutStubs(true, async (calls) => {
      await assert.rejects(Session.signOut({ hasPendingWork: () => false }));
      assert.deepEqual(calls.order, ['reload']);
    });
  } finally { Store.emit = origEmit; }
});
