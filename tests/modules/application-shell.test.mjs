import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, PlantSelector, WelcomeSplash, EmptyState, SessionUIAdapter, showLoginScreen } from '../../web/application-shell.mjs';

test('application-shell exposes the documented public API', () => {
  assert.equal(typeof App.goto, 'function');
  assert.equal(typeof App._renderSettingsPane, 'undefined', 'this method relocated to Plant in Task 1 — must not still exist here');
  assert.equal(typeof PlantSelector.init, 'function');
  assert.equal(typeof WelcomeSplash.init, 'function');
  assert.equal(typeof EmptyState.render, 'function');
  assert.equal(typeof SessionUIAdapter.init, 'function');
  assert.equal(typeof showLoginScreen, 'function');
});
