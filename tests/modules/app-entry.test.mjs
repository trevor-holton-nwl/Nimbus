import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootEntry, runCacheBustGuard } from '../../frontend/app-entry.mjs';

function makeStorage(seed = {}) {
  const store = { ...seed };
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
}

test('bootEntry populates the foundation bridge before loading app.js', async () => {
  const fakeWindow = { NIMBUS_BUILD_ID: 'test-build' };
  const calls = [];
  let bridgeAtFirstRequest = null;
  const loadScript = (src) => {
    calls.push(src);
    if (calls.length === 1) bridgeAtFirstRequest = fakeWindow.__NIMBUS_FOUNDATION;
    return Promise.resolve();
  };

  await bootEntry({ window: fakeWindow, loadScript });

  assert.ok(bridgeAtFirstRequest, 'bridge was not populated before app.js was requested');
  assert.equal(typeof bridgeAtFirstRequest.Config, 'object');
  assert.equal(typeof bridgeAtFirstRequest.Toast, 'object');
  assert.deepEqual(
    calls.map(s => s.split('?')[0]),
    ['app.js', 'nimbus-intelligence.js'],
    'app.js must load, then resolve, before nimbus-intelligence.js is requested'
  );
});

test('bootEntry rejects with an actionable message when app.js fails to load', async () => {
  const fakeWindow = {};
  const loadScript = () => Promise.reject(new Error('404'));
  await assert.rejects(
    () => bootEntry({ window: fakeWindow, loadScript }),
    /app\.js/
  );
});

test('bootEntry does not request nimbus-intelligence.js if app.js fails', async () => {
  const fakeWindow = {};
  const calls = [];
  const loadScript = (src) => {
    calls.push(src);
    return src.startsWith('app.js') ? Promise.reject(new Error('boom')) : Promise.resolve();
  };
  await assert.rejects(() => bootEntry({ window: fakeWindow, loadScript }));
  assert.deepEqual(calls.map(s => s.split('?')[0]), ['app.js']);
});

test('bootEntry populates the state bridge too', async () => {
  const fakeWindow = {};
  const calls = [];
  let stateBridgeAtFirstRequest = null;
  const loadScript = (src) => {
    calls.push(src);
    if (calls.length === 1) stateBridgeAtFirstRequest = fakeWindow.__NIMBUS_STATE;
    return Promise.resolve();
  };
  await bootEntry({ window: fakeWindow, loadScript });
  assert.ok(stateBridgeAtFirstRequest, 'state bridge was not populated before app.js was requested');
  assert.equal(typeof stateBridgeAtFirstRequest.Store, 'object');
});

test('bootEntry deletes the foundation/state bridge from window once both scripts have loaded', async () => {
  // app.js destructures everything it needs synchronously at the top of its
  // own IIFE, and nimbus-intelligence.js never reads the bridge at all — so
  // once boot completes, nothing should still expose PerfMonitor/VirtualList
  // (never part of the public NIMBUS namespace pre-migration) or Store/
  // Selection/UndoStack/Sandbox as permanent, enumerable `window` properties.
  const fakeWindow = {};
  await bootEntry({ window: fakeWindow, loadScript: () => Promise.resolve() });
  assert.equal(fakeWindow.__NIMBUS_FOUNDATION, undefined, 'foundation bridge should not remain on window after boot');
  assert.equal(fakeWindow.__NIMBUS_STATE, undefined, 'state bridge should not remain on window after boot');
});

test('bootEntry leaves the bridge in place if a script fails to load (for debugging a broken boot)', async () => {
  const fakeWindow = {};
  const loadScript = () => Promise.reject(new Error('boom'));
  await assert.rejects(() => bootEntry({ window: fakeWindow, loadScript }));
  assert.ok(fakeWindow.__NIMBUS_FOUNDATION, 'bridge should still be present to aid debugging a failed boot');
});

test('runCacheBustGuard redirects on a version mismatch, keyed off NIMBUS_BUILD_ID', () => {
  let replaced = null;
  const fakeWindow = {
    NIMBUS_BUILD_ID: 'build-2',
    sessionStorage: makeStorage({ 'nimbus.app.ver': 'build-1' }),
    location: { pathname: '/app', search: '', replace(url) { replaced = url; } },
  };
  runCacheBustGuard(fakeWindow);
  assert.equal(replaced, '/app?_v=build-2');
  assert.equal(fakeWindow.sessionStorage.getItem('nimbus.app.ver'), 'build-2');
});

test('runCacheBustGuard does not redirect when the stored version already matches', () => {
  let replaced = null;
  const fakeWindow = {
    NIMBUS_BUILD_ID: 'build-2',
    sessionStorage: makeStorage({ 'nimbus.app.ver': 'build-2' }),
    location: { pathname: '/app', search: '', replace(url) { replaced = url; } },
  };
  runCacheBustGuard(fakeWindow);
  assert.equal(replaced, null);
});

test('runCacheBustGuard does not redirect on first visit (no stored version yet)', () => {
  let replaced = null;
  const fakeWindow = {
    NIMBUS_BUILD_ID: 'build-1',
    sessionStorage: makeStorage(),
    location: { pathname: '/app', search: '', replace(url) { replaced = url; } },
  };
  runCacheBustGuard(fakeWindow);
  assert.equal(replaced, '/app?_v=build-1');
  assert.equal(fakeWindow.sessionStorage.getItem('nimbus.app.ver'), 'build-1');
});

test('runCacheBustGuard strips a stale _v query param before appending the new one', () => {
  let replaced = null;
  const fakeWindow = {
    NIMBUS_BUILD_ID: 'build-2',
    sessionStorage: makeStorage({ 'nimbus.app.ver': 'build-1' }),
    location: { pathname: '/app', search: '?foo=bar&_v=build-1', replace(url) { replaced = url; } },
  };
  runCacheBustGuard(fakeWindow);
  assert.equal(replaced, '/app?foo=bar&_v=build-2');
});

test('runCacheBustGuard never throws if sessionStorage/location are unavailable', () => {
  assert.doesNotThrow(() => runCacheBustGuard({}));
  assert.doesNotThrow(() => runCacheBustGuard({ sessionStorage: { getItem() { throw new Error('denied'); } } }));
});
