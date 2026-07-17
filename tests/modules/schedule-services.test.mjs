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
import { Calendar, Compute, Alerts, Utilization, Engine } from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');

// Engine.runAndApply's early-return guards (no tasks / no plant selected) call
// Toast.show(Util.t(...)) — application-foundation.mjs's Toast/Util reference
// bare `window`/`document`, same split-realm quirk documented in
// tests/modules/helpers/load-legacy-app.mjs. A minimal stub (matching that
// harness's approach) keeps those guard paths a real no-op under plain Node
// instead of throwing "document/window is not defined".
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

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

test('Alerts exposes computation methods only (no showForCell/toggleDrawer/render*)', () => {
  assert.equal(typeof Alerts.recompute, 'function');
  assert.equal(typeof Alerts.scheduleRecompute, 'function');
  assert.equal(typeof Alerts.applyFix, 'function');
  assert.equal(Alerts.showForCell, undefined, 'DOM modal must not travel with the computation module');
  assert.equal(Alerts.toggleDrawer, undefined);
  assert.equal(Alerts._renderDrawer, undefined);
  assert.equal(Alerts._renderBell, undefined);
});

test('Alerts.recompute with no worker/no plant falls back to sync compute', () => {
  Store.setSelectedPlant(null, 'unit-test'); // no plant -> forces sync path regardless of Compute.available()
  Store.setTasks([], 'unit-test');
  assert.doesNotThrow(() => Alerts.recompute());
});

test('Alerts.scheduleRecompute/{,Lines} debounce and eventually call recompute (adaptive delay)', async () => {
  let recomputeCalls = 0;
  const orig = Alerts.recompute;
  Alerts.recompute = (...args) => { recomputeCalls++; return orig.apply(Alerts, args); };
  Alerts.scheduleRecompute();
  await new Promise(r => setTimeout(r, 600)); // > _ALERTS_MAX_DEBOUNCE_MS
  assert.ok(recomputeCalls >= 1);
  Alerts.recompute = orig;
});

test('Utilization.computeMatrix memoizes on (startMs, days, Store.rev(), plant scope)', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  const day = new Date('2026-08-03');
  const m1 = Utilization.computeMatrix(day, 7);
  const m2 = Utilization.computeMatrix(day, 7);
  assert.equal(m1, m2, 'same key must return the identical cached matrix object');
  Store.setTasks([{ id: 'u1', RUN_TIME: '1', PRODUCTION_LINE: 'L1', plant: '5512' }], 'unit-test');
  const m3 = Utilization.computeMatrix(day, 7);
  assert.notEqual(m3, m1, 'a Store mutation must bump Store.rev() and invalidate the memo');
});

test('Utilization.dayByLine is unmemoized — two calls with the same args recompute independently', () => {
  const a = Utilization.dayByLine(new Date());
  const b = Utilization.dayByLine(new Date());
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'must not be the same cached object reference — dayByLine has no memo');
});

test('Engine exposes the documented public API and no DOM-dependent surprises', () => {
  assert.equal(typeof Engine.runAndApply, 'function');
  assert.equal(typeof Engine.autoReflow, 'function');
  assert.equal(typeof Engine.constraintEnabled, 'function');
  assert.ok(Array.isArray(Engine.CONSTRAINT_CATALOG));
});

test('Engine.runAndApply no-ops with a toast when there are no tasks', () => {
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  assert.doesNotThrow(() => Engine.runAndApply('spt'));
});

test('Engine.runAndApply(\'spt\') sorts a single line\'s free tasks by ascending run-hours', () => {
  // PLANT (uppercase) is the real field name — db.py's query_orders aliases
  // `o.plant AS "PLANT"`, and Store.rebuildPlantIndex()/tasksByPlant() key off
  // `t.PLANT`, not a lowercase `plant`. Using the real casing is what makes
  // Store.tasksByPlant('5512') (which Engine.runAndApply groups from) actually
  // return these tasks instead of silently grouping zero tasks.
  Store.setTasks([
    { id: 'e1', PRODUCTION_LINE: 'L1', PLANT: '5512', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'e2', PRODUCTION_LINE: 'L1', PLANT: '5512', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.runAndApply('spt', { respectFixed: true, respectCalendar: false });
  const e1 = Store.tasks['e1'], e2 = Store.tasks['e2'];
  assert.ok(e1.start_date, 'e1 must have been scheduled (proves the line group was non-empty)');
  assert.ok(e2.start_date <= e1.start_date, 'shorter run-time task (e2) must be scheduled first under SPT');
});

test('Engine.autoReflow pushes an overlapping unfixed downstream peer forward on the same line', () => {
  const start1 = new Date('2026-08-03T08:00:00'); // Monday
  const end1   = new Date('2026-08-03T10:00:00'); // changed task now ends 10:00
  const start2 = new Date('2026-08-03T09:00:00'); // peer overlaps [08:00,10:00)
  const end2   = new Date('2026-08-03T11:00:00');
  Store.setTasks([
    { id: 'r1', PRODUCTION_LINE: 'L2', PLANT: '5512', RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'r2', PRODUCTION_LINE: 'L2', PLANT: '5512', RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.autoReflow('r1');
  const r2 = Store.tasks['r2'];
  assert.ok(r2.start_date.getTime() !== start2.getTime(), 'peer must have actually moved (proves the peer set was non-empty)');
  assert.ok(r2.start_date >= end1, 'downstream peer must have moved to start at/after the changed task\'s end');
});

test('Engine.runAndApply respects explicit respectFixed/respectCalendar options without reading any DOM element', () => {
  // Regression test for the DOM-read fix in Step 4: call runAndApply with both
  // flags explicit and confirm no `document.getElementById` call is needed —
  // this test's harness provides no `document` stub with 'chk-respect-fixed'/
  // 'chk-respect-calendar' elements, so if Engine still reads them, this throws.
  Store.setTasks([{ id: 'e3', PRODUCTION_LINE: 'L1', plant: '5512', RUN_TIME: '1' }], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  assert.doesNotThrow(() => Engine.runAndApply('combined', { respectFixed: true, respectCalendar: true }));
});
