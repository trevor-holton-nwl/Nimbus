// Session preference writes (_flushPrefs via setPref/flushPrefs) and Store.pref
// precedence. Every global/stub is restored in `finally` so neighbouring tests
// are unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.window = globalThis.window || {};
function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }, clear: () => m.clear(), get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
  };
}
globalThis.localStorage = globalThis.localStorage || makeStorage();

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Runs fn with a signed-in cache, a clean Store pref bag, a stubbed Util.fetchTraced and
// a captured Toast; restores everything afterwards.
async function withPrefs({ settings = {}, role = {}, fetchImpl }, fn) {
  const origFetch = Util.fetchTraced, origToast = Toast.show;
  const priorUs = { ...Store.userSettings }, priorRd = { ...Store.roleDefaults };
  const priorSession = globalThis.localStorage.getItem('nimbus.session');
  globalThis.localStorage.setItem('nimbus.session', JSON.stringify({ username: 'u', role: 'planner', settings: { ...settings }, role_settings: role, loggedInAt: Date.now() }));
  for (const k of Object.keys(Store.userSettings)) if (!['alertHorizonMinutes', 'confidenceHorizonMinutes'].includes(k)) delete Store.userSettings[k];
  Store.setUserSettings(settings, 'test');
  Store.setRoleDefaults(role, 'test');
  const calls = [], toasts = [];
  Util.fetchTraced = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return fetchImpl(calls.length, calls[calls.length - 1]); };
  Toast.show = (...a) => { toasts.push(a); };
  try { return await fn({ calls, toasts }); }
  finally {
    Util.fetchTraced = origFetch; Toast.show = origToast;
    for (const k of Object.keys(Store.userSettings)) delete Store.userSettings[k];
    Store.setUserSettings(priorUs, 'test'); Store.setRoleDefaults(priorRd, 'test');
    if (priorSession == null) globalThis.localStorage.removeItem('nimbus.session'); else globalThis.localStorage.setItem('nimbus.session', priorSession);
  }
}
const cachedSettings = () => JSON.parse(globalThis.localStorage.getItem('nimbus.session')).settings;

test('success: flushPrefs adopts the server blob into Store and cache and returns true', () => withPrefs({
  settings: { theme: 'light' },
  fetchImpl: async () => json(200, { settings: { theme: 'dark', timeFormat: '24h' } }),
}, async ({ calls }) => {
  Session.setPref('theme', 'dark');
  assert.equal(Store.pref('theme'), 'dark', 'optimistic');
  assert.equal(await Session.flushPrefs(), true);
  assert.deepEqual(calls[0].body, { settings: { theme: 'dark' } });
  assert.equal(Store.userSettings.timeFormat, '24h');
  assert.deepEqual(cachedSettings(), { theme: 'dark', timeFormat: '24h' });
}));

test('failure: Store, cache and toast revert; flushPrefs returns false', () => withPrefs({
  settings: { theme: 'light' },
  fetchImpl: async () => json(500, { detail: 'boom' }),
}, async ({ toasts }) => {
  const events = [];
  const off = Store.subscribe(e => { if (e.type === 'settings:change') events.push(e.source); });
  Session.setPref('theme', 'dark');
  assert.equal(await Session.flushPrefs(), false);
  off();
  assert.equal(Store.userSettings.theme, 'light');
  assert.equal(cachedSettings().theme, 'light');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0][1], 'error');
  assert.ok(events.includes('settings-pref-revert'), 'revert emits a distinct source so the shell can re-render');
}));

test('failure with no previous value deletes the key (Store and cache), not undefined/null', () => withPrefs({
  settings: {},
  fetchImpl: async () => json(500, {}),
}, async () => {
  Session.setPref('timeFormat', '24h');
  await Session.flushPrefs();
  assert.equal('timeFormat' in Store.userSettings, false);
  assert.equal('timeFormat' in cachedSettings(), false);
}));

test('first writer wins: two edits before a failed save revert to the pre-batch value', () => withPrefs({
  settings: { theme: 'light' },
  fetchImpl: async () => json(500, {}),
}, async ({ calls }) => {
  Session.setPref('theme', 'dark');
  Session.setPref('theme', 'light2');
  await Session.flushPrefs();
  assert.equal(calls.length, 1, 'edits coalesce into one PATCH');
  assert.deepEqual(calls[0].body, { settings: { theme: 'light2' } });
  assert.equal(Store.userSettings.theme, 'light');
}));

test('debounce: setPref calls inside 600 ms coalesce into one PATCH fired by the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withPrefs({ settings: {}, fetchImpl: async () => json(200, { settings: { a: 1 } }) }, async ({ calls }) => {
    Session.setPref('timeFormat', '12h');
    t.mock.timers.tick(500);
    Session.setPref('dateFormat', 'Y-m-d');
    t.mock.timers.tick(599);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    await new Promise(r => process.nextTick(r));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { settings: { timeFormat: '12h', dateFormat: 'Y-m-d' } });
    await Session.flushPrefs();
  });
});

test('serialized: a slow earlier response cannot overwrite a newer optimistic value; PATCHes never overlap', () => {
  let release1; const gate = new Promise(r => { release1 = r; });
  return withPrefs({
    settings: { theme: 'light' },
    fetchImpl: async n => {
      if (n === 1) { await gate; return json(200, { settings: { theme: 'dark' } }); }
      return json(200, { settings: { theme: 'light' } });
    },
  }, async ({ calls }) => {
    Session.setPref('theme', 'dark');
    const first = Session.flushPrefs();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 1);
    Session.setPref('theme', 'light');                 // newer edit while PATCH 1 is in flight
    const second = Session.flushPrefs();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 1, 'the second PATCH waits for the first');
    release1();
    await first;
    assert.equal(Store.userSettings.theme, 'light', 'stale response did not roll the newer value back');
    assert.equal(await second, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { settings: { theme: 'light' } });
  });
});

test('failed first batch: a newer batch on the same key keeps its optimistic value and reverts to the ORIGINAL value if it fails too', () => {
  let release1; const gate = new Promise(r => { release1 = r; });
  return withPrefs({
    settings: { theme: 'light' },
    fetchImpl: async n => { if (n === 1) { await gate; } return json(500, {}); },
  }, async () => {
    Session.setPref('theme', 'dark');
    const first = Session.flushPrefs();
    await new Promise(r => setImmediate(r));
    Session.setPref('theme', 'dark2');
    const second = Session.flushPrefs();
    release1();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(Store.userSettings.theme, 'light');
    assert.equal(cachedSettings().theme, 'light');
  });
});

test('flushPrefs with nothing pending resolves true; a failure already in flight makes it false', () => {
  let release; const gate = new Promise(r => { release = r; });
  return withPrefs({ settings: {}, fetchImpl: async () => { await gate; return json(500, {}); } }, async () => {
    assert.equal(await Session.flushPrefs(), true);
    Session.setPref('timeFormat', '24h');
    const a = Session.flushPrefs();
    await new Promise(r => setImmediate(r));
    const b = Session.flushPrefs();                   // nothing new pending, but waits for the in-flight one
    release();
    assert.equal(await a, false);
    assert.equal(await b, false);
  });
});

test('a key the server deleted (null PATCH) disappears from Store on adoption', () => withPrefs({
  settings: { gridLayout: { a: 1 }, theme: 'dark' },
  fetchImpl: async () => json(200, { settings: { theme: 'dark' } }),
}, async () => {
  Session.setPref('gridLayout', null);
  await Session.flushPrefs();
  assert.equal('gridLayout' in Store.userSettings, false);
  assert.equal(Store.userSettings.theme, 'dark');
  assert.equal(typeof Store.userSettings.confidenceHorizonMinutes, 'number', 'runtime-only horizon fields survive a replace');
}));

test('Store.pref precedence: user > role > default; 0, false and empty string count as set, null falls through', () => {
  const priorUs = { ...Store.userSettings }, priorRd = { ...Store.roleDefaults };
  const priorResolver = Store._settingsDefaultsResolver;
  try {
    Store.setSettingsDefaultsResolver(() => ({ firstDayOfWeek: 0, k: 'def', defaultPlant: null }));
    Store.setRoleDefaults({ k: 'role', defaultPlant: '1006' }, 't');
    assert.equal(Store.pref('k'), 'role');
    Store.setUserSettings({ k: 'user' }, 't');
    assert.equal(Store.pref('k'), 'user');
    Store.setUserSettings({ k: null }, 't');
    assert.equal(Store.pref('k'), 'role', 'null falls through to the role default');
    Store.setUserSettings({ firstDayOfWeek: 1 }, 't');
    assert.equal(Store.pref('firstDayOfWeek'), 1);
    Store.setUserSettings({ firstDayOfWeek: 0 }, 't');
    assert.equal(Store.pref('firstDayOfWeek'), 0, '0 is a real value');
    Store.setUserSettings({ defaultPlant: '' }, 't');
    assert.equal(Store.pref('defaultPlant'), '', "'' is the explicit user clear that overrides a role default");
    for (const k of ['firstDayOfWeek', 'k', 'defaultPlant']) delete Store.userSettings[k];
    assert.equal(Store.pref('firstDayOfWeek'), 0, 'default firstDayOfWeek is 0 (Sunday)');
    assert.equal(Store.pref('nope'), undefined);
  } finally {
    for (const k of Object.keys(Store.userSettings)) delete Store.userSettings[k];
    Store.setUserSettings(priorUs, 't'); Store.setRoleDefaults(priorRd, 't');
    if (priorResolver) Store.setSettingsDefaultsResolver(priorResolver);
  }
});
