import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootEntry } from '../../web/app-entry.mjs';

test('bootEntry populates the foundation bridge before loading app.js', async () => {
  const fakeWindow = { NIMBUS_BUILD_ID: 'test-build' };
  const calls = [];
  const loadScript = (src) => { calls.push(src); return Promise.resolve(); };

  await bootEntry({ window: fakeWindow, loadScript });

  assert.ok(fakeWindow.__NIMBUS_FOUNDATION, 'bridge was not populated');
  assert.equal(typeof fakeWindow.__NIMBUS_FOUNDATION.Config, 'object');
  assert.equal(typeof fakeWindow.__NIMBUS_FOUNDATION.Toast, 'object');
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
  await bootEntry({ window: fakeWindow, loadScript: () => Promise.resolve() });
  assert.ok(fakeWindow.__NIMBUS_STATE);
  assert.equal(typeof fakeWindow.__NIMBUS_STATE.Store, 'object');
});
