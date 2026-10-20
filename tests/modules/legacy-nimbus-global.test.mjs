// app.js declares `const NIMBUS` (script-scope lexical binding, not a window
// property). ES modules such as the Alert Monitor pane read `globalThis.NIMBUS`,
// so app.js must assign it explicitly after building the namespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacyApp } from './helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();

test('app.js exposes the NIMBUS namespace on globalThis', () => {
  assert.ok(context.NIMBUS, 'globalThis.NIMBUS must be defined');
  assert.equal(context.NIMBUS, nimbus);
  assert.equal(typeof context.NIMBUS.App, 'object');
});
