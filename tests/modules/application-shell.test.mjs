import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, EmptyState, SessionUIAdapter, showLoginScreen, Settings } from '../../frontend/shell/application-shell.mjs';

test('application-shell exposes the documented public API', () => {
  assert.equal(typeof App.goto, 'function');
  assert.equal(typeof App._renderSettingsPane, 'undefined', 'this method relocated to Plant in Task 1 — must not still exist here');
  assert.equal(typeof PlantSelector.init, 'function');
  assert.equal(typeof WelcomeSplash, 'undefined', 'WelcomeSplash was retired outright by the Command Band re-skin — must not still be exported');
  assert.equal(typeof EmptyState.render, 'function');
  assert.equal(typeof SessionUIAdapter.init, 'function');
  assert.equal(typeof showLoginScreen, 'function');
});

test('Settings (per-user settings catalog) is exported with its documented shape', () => {
  assert.ok(Array.isArray(Settings.CATALOG) && Settings.CATALOG.length > 0);
  assert.equal(typeof Settings.DEFAULTS, 'object');
  assert.equal(typeof Settings.isRegion, 'function');
  assert.equal(typeof Settings.byCategory, 'function');
  // DEFAULTS is derived 1:1 from CATALOG (Store.setSettingsDefaultsResolver's contract).
  for (const entry of Settings.CATALOG) {
    assert.ok(Object.prototype.hasOwnProperty.call(Settings.DEFAULTS, entry.key), `DEFAULTS missing key ${entry.key}`);
    assert.deepEqual(Settings.DEFAULTS[entry.key], entry.default);
  }
  assert.ok(Settings.byCategory('workflow').length > 0);
});
