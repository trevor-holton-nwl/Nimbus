// Tests for web/schedule-services.mjs — CQ-1 Phase 2.
//
// schedule-services.mjs's Calendar capacity-math functions delegate to
// nimbus-compute-core.js via the ambient `globalThis.NimbusComputeCore`
// global (the SAME mechanism app.js used pre-extraction: nimbus-compute-core.js
// is a UMD module that, in a real browser, is loaded by a parser-blocking
// <script> before app-entry.mjs's static imports run, so window.NimbusComputeCore
// already exists by the time schedule-services.mjs's functions are called).
// Under a plain Node ESM import (this file), nothing sets that global
// automatically, so we bootstrap it here via createRequire — mirroring
// tests/modules/helpers/load-legacy-app.mjs's identical bootstrap for the VM
// harness. This must run before any test() body calls a Calendar function,
// but does NOT need to run before the `import` below is evaluated: importing
// schedule-services.mjs only defines objects/functions at module-eval time,
// it never calls into NimbusComputeCore until a function is invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar, Compute } from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');

test('Calendar exposes capacity-math methods only (no render/openBlockModal/DOM)', () => {
  assert.equal(typeof Calendar.workWindow, 'function');
  assert.equal(typeof Calendar.dailyCapacityHours, 'function');
  assert.equal(typeof Calendar.nextAvailable, 'function');
  assert.equal(Calendar.render, undefined, 'Calendar must not carry UI methods after the split');
  assert.equal(Calendar.openBlockModal, undefined);
  assert.equal(Calendar.saveBlockFromModal, undefined);
});

test('Calendar.workWindow returns null outside working hours, a window inside them', () => {
  Store.setCalendar('L1', { 1: [7, 19] }, 'unit-test'); // Monday 7am-7pm
  const monday = new Date('2026-08-03T12:00:00'); // a Monday, midday
  const win = Calendar.workWindow('L1', monday);
  assert.ok(win === null || Array.isArray(win));
});

test('Compute.available reflects Worker constructor availability', () => {
  assert.equal(typeof Compute.available(), 'boolean');
});

test('Compute has no underscore-prefixed properties reachable on the export (closure-private by construction)', () => {
  const keys = Object.keys(Compute);
  assert.ok(keys.every(k => !k.startsWith('_')), 'Compute must stay fully encapsulated, as before the move');
  assert.deepEqual(keys.sort(), ['alerts', 'available', 'utilization']);
});
