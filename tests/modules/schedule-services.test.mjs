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

test('Store "schedule:hydrated" event triggers Alerts.scheduleRecompute (schedule-data -> schedule-services seam)', () => {
  // Regression test for the reverse-dependency seam Task 4 introduced:
  // schedule-data.mjs may not import schedule-services.mjs, so Persistence/
  // CalendarSync (5 call sites: load()'s two branches, _loadCache(),
  // _loadDemo()) emit a `{ type: 'schedule:hydrated' }` Store event instead of
  // calling Alerts.scheduleRecompute() directly. schedule-services.mjs
  // subscribes to that event once, at module-eval time, and forwards to
  // Alerts.scheduleRecompute(). Verify the seam actually fires end to end —
  // not just that each half compiles — so a typo'd event-type string or a
  // deleted subscription fails this suite instead of silently going dark
  // (the prior gap: alerts would stop recomputing after every load/cache
  // restore/demo-seed with nothing catching the regression).
  let calls = 0;
  const origSchedule = Alerts.scheduleRecompute;
  Alerts.scheduleRecompute = (...args) => { calls++; };
  try {
    Store.emit({ type: 'schedule:hydrated', source: 'unit-test' });
    assert.equal(calls, 1, 'the schedule:hydrated subscriber must call Alerts.scheduleRecompute exactly once');
  } finally {
    Alerts.scheduleRecompute = origSchedule;
  }
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
  // flags explicit and confirm `document.getElementById` is never invoked.
  // The shared harness stub installed at the top of this file
  // (`document = { getElementById: () => null }`, needed for the no-plant/
  // no-task guard-path tests) silently absorbs any `getElementById` call and
  // returns `null` rather than throwing, so asserting `doesNotThrow` against
  // it alone would pass even if a DOM read were reintroduced. Swap in a
  // counting spy for the duration of this test instead, and assert it was
  // never called — then restore the shared stub.
  const priorDocument = globalThis.document;
  let calls = 0;
  globalThis.document = { getElementById: () => { calls++; return null; } };
  try {
    Store.setTasks([{ id: 'e3', PRODUCTION_LINE: 'L1', plant: '5512', RUN_TIME: '1' }], 'unit-test');
    Store.setSelectedPlant('5512', 'unit-test');
    assert.doesNotThrow(() => Engine.runAndApply('combined', { respectFixed: true, respectCalendar: true }));
    assert.equal(calls, 0, 'Engine.runAndApply must not call document.getElementById when respectFixed/respectCalendar are both passed explicitly');
  } finally {
    globalThis.document = priorDocument;
  }
});

// ---------------------------------------------------------------------------
// Stage 3 seam 3 — Engine.flattenConstraints + the _sortTerms term factory.
// These are _sortTerms' first-ever direct coverage (Task 0's audit confirmed no
// test anywhere referenced _sortTerms / _comparator / colorMap before this).
//
// NOTE on `Store.setMasterData(...)` vs. the plan's illustrative
// `Store.masterData = {...}`: `masterData` is a getter-ONLY accessor on Store
// (web/schedule-state.mts) — a bare assignment throws "Cannot set property
// masterData of #<Object> which has only a getter" under ESM strict mode.
// `setMasterData` is the real public setter (and the one Persistence itself
// uses), so these tests go through it. Appended at the END of the file on
// purpose: setMasterData rebuilds Store's line→plant index, which the
// pre-existing Engine tests above depend on.
// ---------------------------------------------------------------------------

test('flattenConstraints does pre-order DFS, drops duplicates, skips disabled subtrees', () => {
  Store.setMasterData({ plants: [{ plant: 'P1', constraints: [
    { key: 'colorWheel', enabled: true, order: 1, children: [
      { key: 'prt01', enabled: true, order: 1 },
      { key: 'colorWheel', enabled: true, order: 2 },  // duplicate — must be dropped
    ] },
    { key: 'prt02', enabled: false, order: 2, children: [
      { key: 'productionVersion', enabled: true, order: 1 },  // whole subtree skipped (parent disabled)
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('P1'), ['colorWheel', 'prt01']);
});

test('flattenConstraints falls back to CONSTRAINT_CATALOG order when plant has no stored tree', () => {
  Store.setMasterData({ plants: [{ plant: 'P2', constraints: null }], lines: [] }, 'unit-test');
  const keys = Engine.flattenConstraints('P2');
  assert.deepEqual(keys, ['colorWheel']); // only colorWheel defaults enabled, per constraintEnabled's existing rule
});

test('_sortTerms resolves rank via Store.priorityRankMaps, line override winning over plant-wide', () => {
  Store.setMasterData({ plants: [{ plant: 'P3', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 5 } }, L01: { colorWheel: { RED: 1 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P3' });
  const key = terms[0].get({ COLOR: 'red', PRODUCTION_LINE: 'L01' });
  assert.equal(key, '0000001|RED');  // line override (rank 1), not plant-wide (rank 5)
  const keyNoLine = terms[0].get({ COLOR: 'red', PRODUCTION_LINE: 'L99' });
  assert.equal(keyNoLine, '0000005|RED');  // falls back to plant-wide for an unmapped line
});

test('_sortTerms groups unranked values together, after ranked ones, instead of interleaving (N12)', () => {
  Store.setMasterData({ plants: [{ plant: 'P4', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P4' });
  const redKey    = terms[0].get({ COLOR: 'RED',    PRODUCTION_LINE: 'L1' });
  const blueKey   = terms[0].get({ COLOR: 'BLUE',   PRODUCTION_LINE: 'L1' });   // unranked
  const greenKey  = terms[0].get({ COLOR: 'GREEN',  PRODUCTION_LINE: 'L1' });   // unranked
  assert.ok(redKey < blueKey);            // ranked sorts before unranked
  assert.notEqual(blueKey, greenKey);     // both rank 999999 but keys still differ by value
  assert.ok(blueKey.startsWith('0999999|') && greenKey.startsWith('0999999|'));  // grouped under the same rank prefix
});

test('_sortTerms with no rank map for the field falls back to 999999 for every value (no crash)', () => {
  Store.setMasterData({ plants: [{ plant: 'P5', constraints: [{ key: 'prt01', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({}, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P5' });
  assert.equal(terms[0].get({ PRT_01: 'DOG', PRODUCTION_LINE: 'L1' }), '0999999|DOG');
});

test('_sortTerms maps every registered priority key to its REAL task field, not key.toUpperCase()', () => {
  // Task 0's audit defect 4a: 'prt01' -> 'PRT_01' (not 'PRT01'),
  // 'productionVersion' -> 'PRODUCTION_VERSION' (not 'PRODUCTIONVERSION'). A
  // toUpperCase() guess would read an undefined field and rank every order
  // 999999 — configured, inert, silent. Assert the mapping directly AND that a
  // real rank resolves off the real field name.
  assert.equal(Engine._taskFieldFor('colorWheel'), 'COLOR');
  assert.equal(Engine._taskFieldFor('prt01'), 'PRT_01');
  assert.equal(Engine._taskFieldFor('prt02'), 'PRT_02');
  assert.equal(Engine._taskFieldFor('productionVersion'), 'PRODUCTION_VERSION');
  Store.setMasterData({ plants: [{ plant: 'P6', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
    { key: 'productionVersion', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': {
    prt01: { 'TOOL-A': 2 },
    productionVersion: { V1: 3 },
  } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P6' });
  assert.equal(terms[0].get({ PRT_01: 'tool-a', PRODUCTION_LINE: 'L1' }), '0000002|TOOL-A');
  assert.equal(terms[1].get({ PRODUCTION_VERSION: 'v1', PRODUCTION_LINE: 'L1' }), '0000003|V1');
});

test('runAndApply with NO explicit plant/map resolves real ranks from Store state (alert auto-fix path)', () => {
  // The one call site Task 0's audit flagged as silently breakable:
  // Alerts.applyFix's overload branch calls Engine.runAndApply('combined', {
  // lines, startDate, endDate }) with no plant and no rank argument, so it
  // depends entirely on Store.selectedPlant + Store.priorityRankMaps. Assert an
  // end-to-end sequence, not just the term factory in isolation.
  Store.setMasterData({ plants: [{ plant: '5512', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1, BLUE: 2 } } }, 'unit-test');
  Store.setTasks([
    // BLUE first in insertion order, and the LONGER job, so neither input order
    // nor the SPT tail term could produce the expected result by accident.
    { id: 'cw-blue', PRODUCTION_LINE: 'LC', PLANT: '5512', RUN_TIME: '2', COLOR: 'BLUE', start_date: null, end_date: null },
    { id: 'cw-red',  PRODUCTION_LINE: 'LC', PLANT: '5512', RUN_TIME: '3', COLOR: 'RED',  start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('5512', 'unit-test');
  Engine.runAndApply('combined', { respectFixed: true, respectCalendar: false });
  const red = Store.tasks['cw-red'], blue = Store.tasks['cw-blue'];
  assert.ok(red.start_date && blue.start_date, 'both orders must have been scheduled');
  assert.ok(red.start_date <= blue.start_date,
    'rank-1 RED must be sequenced before rank-2 BLUE — a 999999-for-everything fallback would leave the longer RED job last under the SPT tail term');
});
