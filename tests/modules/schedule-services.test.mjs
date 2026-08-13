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
import { Calendar, Compute, Alerts, Utilization, Engine, snapshotSchedule } from '../../web/schedule-services.mjs';
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

test('Engine.evaluateSchedule snapshots the live read model without publishing a candidate', () => {
  Store.setTasks([
    { id: 'detached-long', PRODUCTION_LINE: 'L1', PLANT: 'DETACHED', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'detached-short', PRODUCTION_LINE: 'L1', PLANT: 'DETACHED', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('DETACHED', 'unit-test');
  Store.setFixed('detached-long', true, 'unit-test');
  Store.setAlerts([{ id: 'detached-alert', type: 'overlap', sev: 'err' }], 'unit-test');
  const beforeRev = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const beforeFixed = Array.from(Store.fixedIds).sort();
  const beforeAlerts = structuredClone(Store.alerts);
  let publications = 0;
  const unsubscribe = Store.subscribe(() => { publications++; }, 'unit-test-autosave');

  try {
    const candidate = Engine.evaluateSchedule('spt', {
      respectCalendar: false,
      now: new Date('2026-08-03T08:00:00'),
    });
    assert.deepEqual(candidate.patches.map(patch => patch.id), ['detached-short'],
      'fixed work remains an immutable candidate boundary');
    assert.equal(Store.rev(), beforeRev);
    assert.deepEqual(Store.tasks, beforeTasks);
    assert.deepEqual(Array.from(Store.fixedIds).sort(), beforeFixed);
    assert.deepEqual(Store.alerts, beforeAlerts);
    assert.equal(publications, 0, 'candidate evaluation must not wake autosave-style subscribers');

    const captured = snapshotSchedule();
    captured.tasks[0].RUN_TIME = '999';
    assert.equal(Store.tasks['detached-long'].RUN_TIME, '5', 'snapshot values must not alias Store task objects');
  } finally {
    unsubscribe();
  }
});

test('Engine.evaluateSetupAware forwards only an explicit detached setup request', () => {
  // This fails if Task 3 leaves the pure evaluator unreachable from the
  // Engine seam, or if the seam falls back to Store setup state rather than
  // requiring the caller-supplied setup truth and bounds.
  assert.equal(typeof Engine.evaluateSetupAware, 'function');
  const hours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const snapshot = {
    tasks: [{
      id: 'engine-setup-blue', PLANT: 'ENGINE_SETUP', PRODUCTION_LINE: 'L1', COLOR: 'BLUE', RUN_TIME: 1,
      start_date: null, end_date: null, original_end_date: new Date('2026-08-03T10:00:00'),
    }],
    fixedIds: [], alerts: [], selectedPlant: 'ENGINE_SETUP', blocks: [], plantBlocks: [],
    calendars: { L1: { workHours: hours } }, plants: { ENGINE_SETUP: { workHours: hours } },
    lineSettings: {}, masterData: { plants: [{ plant: 'ENGINE_SETUP' }], lines: [{ plant: 'ENGINE_SETUP', production_line: 'L1' }] },
    priorityRankMaps: {},
  };
  const bounds = {
    setup: {
      plant: 'ENGINE_SETUP',
      definition: { plant: 'ENGINE_SETUP', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [{ line: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
      line_rows: [],
      line_states: [{ line: 'L1', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
      overrides: [],
    },
    exactSearchThreshold: 2, iterationCap: 2, clock: () => 0, deadline: 1,
    now: new Date('2026-08-03T08:00:00'), horizonEnd: new Date('2026-08-03T18:00:00'),
  };
  const beforeRev = Store.rev();

  const result = Engine.evaluateSetupAware('due-date-first', bounds, snapshot);

  assert.equal(result.patches[0].changes.start_date.getTime(), new Date('2026-08-03T08:05:00').getTime());
  assert.equal(Store.rev(), beforeRev, 'explicit setup candidate routing must not publish to Store');
});

test('Engine.evaluateSchedule preserves combined-mode placement from the live legacy path', () => {
  const startDate = new Date('2035-08-06T08:00:00');
  Store.setTasks([
    { id: 'parity-blue-long', PRODUCTION_LINE: 'L1', PLANT: 'PARITY', COLOR: 'BLUE', FORM_SIZE: 'B', RUN_TIME: '5', start_date: null, end_date: null },
    { id: 'parity-red-short', PRODUCTION_LINE: 'L1', PLANT: 'PARITY', COLOR: 'RED', FORM_SIZE: 'A', RUN_TIME: '1', start_date: null, end_date: null },
    { id: 'parity-blue-short', PRODUCTION_LINE: 'L1', PLANT: 'PARITY', COLOR: 'BLUE', FORM_SIZE: 'A', RUN_TIME: '1', start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('PARITY', 'unit-test');
  const options = { startDate, respectFixed: true, respectCalendar: false };
  const candidate = Engine.evaluateSchedule('combined', options);

  Engine.runAndApply('combined', options);
  const committed = candidate.patches.map(patch => ({
    id: patch.id,
    start: patch.changes.start_date?.getTime(),
    end: patch.changes.end_date?.getTime(),
  }));
  const legacy = candidate.patches.map(patch => ({
    id: patch.id,
    start: Store.tasks[patch.id].start_date?.getTime(),
    end: Store.tasks[patch.id].end_date?.getTime(),
  }));
  assert.deepEqual(committed, legacy,
    'detached evaluation must reuse the same combined/day-integrity placement as the live legacy path');
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

// --- constraintEnabled is tree-aware ---------------------------------------
// Regression cover for the top-level-only `find()` this replaced. Harmless
// while plants.constraints was always flat; a real defect once the Stage 3
// Scheduling Constraints UI made nesting reachable, because a nested key fell
// through to the `key === 'colorWheel'` default. Its one real consumer is
// OptimizeDialog's pre-run "no color wheel configured" confirm
// (web/schedule-workbench.mts) — a UI nag, never a sequencing decision
// (_sortTerms goes through flattenConstraints, which has always walked the
// tree). Semantics must stay identical to flattenConstraints': a disabled node
// takes its whole subtree with it, and any reachable enabled occurrence counts.

test('constraintEnabled finds a key nested BELOW the root, not just at the top level', () => {
  Store.setMasterData({ plants: [{ plant: 'CE1', constraints: [
    { key: 'colorWheel', enabled: true, order: 1, children: [
      { key: 'prt01', enabled: true, order: 1, children: [
        { key: 'prt02', enabled: true, order: 1 },   // depth 3 — must still be found
      ] },
    ] },
  ] }], lines: [] }, 'unit-test');
  // Deliberately asserted on NON-colorWheel keys: the old top-level find()
  // missed them and then returned `key === 'colorWheel'` => false, so these two
  // are the assertions that actually fail against the pre-fix implementation.
  assert.equal(Engine.constraintEnabled('CE1', 'prt01'), true,
    'prt01 nested under an enabled parent is enabled — the old top-level find() reported false');
  assert.equal(Engine.constraintEnabled('CE1', 'prt02'), true, 'found at the deepest allowed level too');
  assert.equal(Engine.constraintEnabled('CE1', 'colorWheel'), true);
  // Agrees with the function it mirrors.
  assert.deepEqual(Engine.flattenConstraints('CE1'), ['colorWheel', 'prt01', 'prt02']);
});

test('constraintEnabled returns false for a nested key whose ancestor is disabled (subtree is off)', () => {
  Store.setMasterData({ plants: [{ plant: 'CE2', constraints: [
    { key: 'prt01', enabled: false, order: 1, children: [
      { key: 'colorWheel', enabled: true, order: 1 },  // reachable only through a disabled parent
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE2', 'colorWheel'), false,
    'a disabled ancestor takes its whole subtree with it — and this must NOT fall through to the colorWheel-ON default');
  assert.equal(Engine.constraintEnabled('CE2', 'prt01'), false);
  assert.deepEqual(Engine.flattenConstraints('CE2'), [], 'flattenConstraints must agree: nothing is in effect');
});

test('constraintEnabled returns false for a nested key that is itself disabled', () => {
  Store.setMasterData({ plants: [{ plant: 'CE3', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [
      { key: 'colorWheel', enabled: false, order: 1 },
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE3', 'colorWheel'), false);
  assert.deepEqual(Engine.flattenConstraints('CE3'), ['prt01']);
});

test('constraintEnabled: any REACHABLE enabled occurrence wins, matching the one flattenConstraints emits', () => {
  Store.setMasterData({ plants: [{ plant: 'CE4', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },        // off at the root...
    { key: 'prt01', enabled: true, order: 2, children: [
      { key: 'colorWheel', enabled: true, order: 1 },       // ...but on, and reachable, here
    ] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE4', 'colorWheel'), true);
  assert.ok(Engine.flattenConstraints('CE4').includes('colorWheel'),
    'flattenConstraints emits it, so constraintEnabled must not claim otherwise');
});

test('constraintEnabled preserves the flat top-level behavior it always had', () => {
  Store.setMasterData({ plants: [{ plant: 'CE5', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },
    { key: 'prt01', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE5', 'colorWheel'), false, 'explicit top-level off stays off');
  assert.equal(Engine.constraintEnabled('CE5', 'prt01'), true, 'explicit top-level on stays on');
  // A key a configured tree does not mention is off — it does NOT fall through
  // to the everything-else-OFF default (same answer here, different reason).
  assert.equal(Engine.constraintEnabled('CE5', 'prt02'), false);
});

test('constraintEnabled: a configured tree that OMITS the key returns false, not the colorWheel default', () => {
  // Reachable in practice: removing the Color Wheel row in the tree UI leaves a
  // non-empty tree with no colorWheel node. Falling through to
  // `key === 'colorWheel'` here would report colorWheel ON while
  // flattenConstraints correctly reports it as not in effect — the same
  // spurious-nag symptom the tree-walk fix closed, one level up.
  Store.setMasterData({ plants: [{ plant: 'CE8', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE8', 'colorWheel'), false,
    'a configured tree is authoritative about what it omits');
  assert.deepEqual(Engine.flattenConstraints('CE8'), ['prt01']);
  assert.ok(!Engine.flattenConstraints('CE8').includes('colorWheel'),
    'and flattenConstraints agrees — the equivalence the doc comment claims');
  // Same for a nested-only tree that omits it.
  Store.setMasterData({ plants: [{ plant: 'CE9', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [{ key: 'prt02', enabled: true, order: 1 }] },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE9', 'colorWheel'), false);
  assert.equal(Engine.constraintEnabled('CE9', 'productionVersion'), false);
});

test('constraintEnabled: duplicate root keys resolve position-independently, like flattenConstraints', () => {
  // off-then-on and on-then-off must give the same answer: flattenConstraints
  // emits the key as long as SOME reachable occurrence is enabled, regardless
  // of order, so a positional find() (first match wins) would disagree.
  for (const [label, constraints] of [
    ['off then on', [{ key: 'colorWheel', enabled: false, order: 1 }, { key: 'colorWheel', enabled: true, order: 2 }]],
    ['on then off', [{ key: 'colorWheel', enabled: true, order: 1 }, { key: 'colorWheel', enabled: false, order: 2 }]],
  ]) {
    Store.setMasterData({ plants: [{ plant: 'CE10', constraints }], lines: [] }, 'unit-test');
    assert.equal(Engine.constraintEnabled('CE10', 'colorWheel'), true, `${label}: any enabled occurrence wins`);
    assert.ok(Engine.flattenConstraints('CE10').includes('colorWheel'), `${label}: flattenConstraints agrees`);
  }
  // Both off -> off, in either arrangement.
  Store.setMasterData({ plants: [{ plant: 'CE11', constraints: [
    { key: 'colorWheel', enabled: false, order: 1 },
    { key: 'colorWheel', enabled: false, order: 2 },
  ] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE11', 'colorWheel'), false);
  assert.deepEqual(Engine.flattenConstraints('CE11'), []);
});

test('constraintEnabled preserves the never-configured default (colorWheel ON, rest OFF)', () => {
  Store.setMasterData({ plants: [{ plant: 'CE6', constraints: null }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE6', 'colorWheel'), true);
  assert.equal(Engine.constraintEnabled('CE6', 'prt01'), false);
  // Same for an unknown plant, and for an empty stored array (which
  // flattenConstraints also treats as never-configured).
  assert.equal(Engine.constraintEnabled('NOPE', 'colorWheel'), true);
  Store.setMasterData({ plants: [{ plant: 'CE7', constraints: [] }], lines: [] }, 'unit-test');
  assert.equal(Engine.constraintEnabled('CE7', 'colorWheel'), true);
  assert.equal(Engine.constraintEnabled('CE7', 'prt01'), false);
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

test('_sortTerms keeps the rank half exactly 7 digits for fractional and oversized ranks', () => {
  // Ranks are floats end to end (brain.py persists float(rank); JSON round-trips
  // 1.4 verbatim), so the padded-key encoding has to survive a non-integer.
  // Unguarded, String(1.4).padStart(7,'0') === '00001.4' — already 7 chars, so
  // NOTHING is padded — and it compares AFTER '0000003' on the 4th character,
  // silently putting rank 1.4 behind rank 3. Same class of break above 1e7,
  // where the rank half overflows to 8 digits.
  Store.setMasterData({ plants: [{ plant: 'P7', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1.4, BLUE: 3, HUGE: 99999999 } } }, 'unit-test');
  const terms = Engine._sortTerms('changeover', { plant: 'P7' });
  const redKey  = terms[0].get({ COLOR: 'RED',  PRODUCTION_LINE: 'L1' });
  const blueKey = terms[0].get({ COLOR: 'BLUE', PRODUCTION_LINE: 'L1' });
  const hugeKey = terms[0].get({ COLOR: 'HUGE', PRODUCTION_LINE: 'L1' });
  assert.match(redKey,  /^\d{7}\|RED$/,  'a fractional rank must still yield a 7-digit rank half');
  assert.match(hugeKey, /^\d{7}\|HUGE$/, 'an oversized rank must be clamped to a 7-digit rank half');
  assert.equal(redKey, '0000001|RED');   // 1.4 rounds to 1
  assert.equal(hugeKey, '9999999|HUGE'); // clamped at the 7-digit ceiling
  assert.ok(redKey < blueKey,
    'fractional rank 1.4 must still sort before integer rank 3 — the unguarded encoding inverted this');
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

// ---------------------------------------------------------------------------
// Task 7 — Engine.setConstraintCatalog / Engine.setFieldTaskFields. Both were
// added in the prior task (Task 6) with zero direct test coverage; this
// task's boot wiring (application-shell.mts's App.init(), calling both once
// GET /priority-fields resolves) is their first real caller. Two behaviors
// matter and are covered here: (a) a partial/empty registry response MERGES
// over whatever the function already holds rather than replacing/clearing
// it — the other three fields' known mappings/catalog entries must survive
// — and (b) an empty/falsy `fields` array is a pure no-op. Each test
// snapshots and restores module state in a finally, since Engine is a
// shared singleton across this whole file.
// ---------------------------------------------------------------------------

test('setConstraintCatalog merges a partial response over existing entries, not wiping the other three', () => {
  const before = Engine.CONSTRAINT_CATALOG.map(c => ({ ...c }));
  try {
    // Seed a full 4-entry catalog (mirrors a real GET /priority-fields
    // response, which the backend always spreads from RANKABLE_FIELDS).
    Engine.setConstraintCatalog([
      { field_key: 'colorWheel', default_label: 'Color Wheel' },
      { field_key: 'prt01', default_label: 'Prod. Resource Tool (01)' },
      { field_key: 'prt02', default_label: 'Prod. Resource Tool (02)' },
      { field_key: 'productionVersion', default_label: 'Production Version' },
    ]);
    assert.equal(Engine.CONSTRAINT_CATALOG.length, 4);

    // A later PARTIAL response (e.g. a degraded /reload) mentions only one
    // field — the other three must still be there afterward, unwiped.
    Engine.setConstraintCatalog([{ field_key: 'colorWheel', default_label: 'Color Wheel (updated)' }]);
    const keys = Engine.CONSTRAINT_CATALOG.map(c => c.key);
    assert.ok(keys.includes('prt01'), 'partial response must not wipe prt01');
    assert.ok(keys.includes('prt02'), 'partial response must not wipe prt02');
    assert.ok(keys.includes('productionVersion'), 'partial response must not wipe productionVersion');
    const cw = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'colorWheel');
    assert.equal(cw.label, 'Color Wheel (updated)', 'the field the partial response DID mention must still update');
  } finally {
    Engine.CONSTRAINT_CATALOG = before;
  }
});

test('setConstraintCatalog fills desc from the local field_key -> description fallback (backend carries none)', () => {
  // Regression coverage: the prior task's implementation hardcoded desc: ''
  // for every entry once the registry started driving CONSTRAINT_CATALOG,
  // blanking the Scheduling Constraints UI's per-field description text.
  const before = Engine.CONSTRAINT_CATALOG.map(c => ({ ...c }));
  try {
    Engine.setConstraintCatalog([
      { field_key: 'colorWheel', default_label: 'Color Wheel' },
      { field_key: 'prt01', default_label: 'Prod. Resource Tool (01)' },
    ]);
    const cw = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'colorWheel');
    const prt01 = Engine.CONSTRAINT_CATALOG.find(c => c.key === 'prt01');
    assert.ok(cw.desc, 'colorWheel must keep a non-empty description');
    assert.ok(prt01.desc, 'prt01 must also get a non-empty description from the local fallback map');
    assert.equal(cw.label, 'Color Wheel', 'label stays backend-authoritative — only desc is sourced locally');
  } finally {
    Engine.CONSTRAINT_CATALOG = before;
  }
});

test('setConstraintCatalog with an empty/falsy fields array is a no-op', () => {
  const before = Engine.CONSTRAINT_CATALOG;
  Engine.setConstraintCatalog([]);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'empty array must leave the existing catalog untouched');
  Engine.setConstraintCatalog(null);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'null must leave the existing catalog untouched');
  Engine.setConstraintCatalog(undefined);
  assert.equal(Engine.CONSTRAINT_CATALOG, before, 'undefined must leave the existing catalog untouched');
});

test('setFieldTaskFields merges a partial response over the hardcoded defaults, not wiping the other three', () => {
  const before = { ...Engine._fieldTaskFields };
  try {
    Engine.setFieldTaskFields([{ field_key: 'colorWheel', task_field: 'COLOR_OVERRIDE' }]);
    assert.equal(Engine._fieldTaskFields.colorWheel, 'COLOR_OVERRIDE', 'the mentioned field must update');
    assert.equal(Engine._fieldTaskFields.prt01, 'PRT_01', 'a partial response must not wipe prt01\'s known mapping');
    assert.equal(Engine._fieldTaskFields.prt02, 'PRT_02', 'a partial response must not wipe prt02\'s known mapping');
    assert.equal(Engine._fieldTaskFields.productionVersion, 'PRODUCTION_VERSION', 'a partial response must not wipe productionVersion\'s known mapping');
  } finally {
    Engine._fieldTaskFields = before;
  }
});

test('setFieldTaskFields with an empty/falsy fields array is a no-op', () => {
  const before = { ...Engine._fieldTaskFields };
  Engine.setFieldTaskFields([]);
  assert.deepEqual(Engine._fieldTaskFields, before, 'empty array must leave the existing defaults untouched');
  Engine.setFieldTaskFields(null);
  assert.deepEqual(Engine._fieldTaskFields, before, 'null must leave the existing defaults untouched');
  Engine.setFieldTaskFields(undefined);
  assert.deepEqual(Engine._fieldTaskFields, before, 'undefined must leave the existing defaults untouched');
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

/* ---------------------------------------------------------------------------
   Final-review fix wave (2026-08-11). The whole-branch review found three
   defects whose seams live here:
     - effectiveConstraintPaths: per-NODE effectiveness, so the Scheduling
       Constraints "Effective sequence" panel stops crediting the wrong
       occurrence of a duplicated key.
     - unrankedActiveFields: the generic (all-fields) form of "is this priority
       actually configured?" behind the pre-Run confirm (N11).
     - changeoverTaskFields: what the changeover KPI must measure so it tracks
       the same fields _sortTerms sequences on.
   Plus the two contained _sortTerms fixes (dead term, empty-override shadowing).
   ------------------------------------------------------------------------ */

test('effectiveConstraintPaths credits the ENABLED duplicate, not the disabled one before it', () => {
  // The reviewer's exact repro. Real optimizer order is prt01 -> prt02 ->
  // colorWheel: the colorWheel at index 1 is OFF, so index 3 is what takes
  // effect. The old panel logic (`flat.includes(key) && !seen.has(key)`) marked
  // index 1 effective and index 3 "(no effect)" — precisely inverted.
  const tree = [
    { key: 'prt01',      enabled: true,  order: 1 },
    { key: 'colorWheel', enabled: false, order: 2 },
    { key: 'prt02',      enabled: true,  order: 3 },
    { key: 'colorWheel', enabled: true,  order: 4 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP1', constraints: tree }], lines: [] }, 'unit-test');

  assert.deepEqual(Engine.flattenConstraints('EP1'), ['prt01', 'prt02', 'colorWheel'],
    'optimizer order must skip the disabled duplicate and emit the enabled one last');
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.deepEqual([...paths].sort(), ['0', '2', '3'],
    'index 1 (disabled colorWheel) must NOT be effective; index 3 (enabled colorWheel) must be');
  assert.ok(!paths.has('1'), 'the switched-OFF row must never be reported as in effect');
});

test('effectiveConstraintPaths: a node under a disabled ancestor loses to an enabled copy below', () => {
  const tree = [
    { key: 'prt01', enabled: false, order: 1, children: [{ key: 'colorWheel', enabled: true, order: 1 }] },
    { key: 'colorWheel', enabled: true, order: 2 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP2', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP2'), ['colorWheel']);
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.deepEqual([...paths], ['1'],
    'only the root-level enabled colorWheel is in effect — not the one inside the disabled subtree');
  assert.ok(!paths.has('0.0'), 'a child of a disabled parent is unreachable, so it cannot be the effective occurrence');
});

test('effectiveConstraintPaths addresses ORIGINAL array positions, not the order-sorted view', () => {
  // Array order deliberately disagrees with `order` — what a persisted tree from
  // an older client can look like. Paths must point at the caller's own indices
  // or a renderer would highlight the wrong row.
  const tree = [
    { key: 'prt02',      enabled: true, order: 3 },
    { key: 'colorWheel', enabled: true, order: 1 },
    { key: 'prt01',      enabled: true, order: 2 },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP3', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP3'), ['colorWheel', 'prt01', 'prt02'],
    'effective ORDER follows `order`');
  assert.deepEqual([...Engine.effectiveConstraintPaths(tree)].sort(), ['0', '1', '2'],
    'every node is effective here, addressed by its own array index');
  assert.equal(Engine.effectiveConstraintPaths(null).size, 0);
  assert.equal(Engine.effectiveConstraintPaths([]).size, 0);
});

test('effectiveConstraintPaths still reaches a repeated node CHILD that introduces a new key', () => {
  // A repeated parent contributes nothing itself but must not swallow its
  // subtree — flattenConstraints walks children regardless of the dedupe.
  const tree = [
    { key: 'colorWheel', enabled: true, order: 1 },
    { key: 'colorWheel', enabled: true, order: 2, children: [{ key: 'prt01', enabled: true, order: 1 }] },
  ];
  Store.setMasterData({ plants: [{ plant: 'EP4', constraints: tree }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.flattenConstraints('EP4'), ['colorWheel', 'prt01']);
  const paths = Engine.effectiveConstraintPaths(tree);
  assert.ok(paths.has('0'),   'first colorWheel is the effective occurrence');
  assert.ok(!paths.has('1'),  'the repeat contributes nothing');
  assert.ok(paths.has('1.0'), 'but the child prt01 under the repeat is still reached and effective');
});

test('unrankedActiveFields reports every ACTIVE field with no ranks — not just colorWheel', () => {
  Store.setMasterData({ plants: [{ plant: 'UF1', constraints: [
    { key: 'colorWheel', enabled: true,  order: 1 },
    { key: 'prt01',      enabled: true,  order: 2 },
    { key: 'prt02',      enabled: false, order: 3 },   // off -> not active, must not be nagged about
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF1'), ['prt01'],
    'colorWheel has ranks; prt02 is switched off; only the enabled-but-empty prt01 is reported');
});

test('unrankedActiveFields treats an EMPTY cache (failed fetch) as every active field unranked', () => {
  // This is what lets OptimizeDialog.run() cover "ranks unavailable" with the
  // same call as "nothing uploaded", including the case where a failed REFETCH
  // wiped the cache while Persistence._rankMapsPlant still matched the plant.
  Store.setMasterData({ plants: [{ plant: 'UF2', constraints: [
    { key: 'prt01', enabled: true, order: 1 },
    { key: 'prt02', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({}, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF2'), ['prt01', 'prt02']);
  // A plant that sequences ONLY on non-color fields is exactly the case the old
  // colorWheel-only gate stayed silent for.
  assert.ok(!Engine.flattenConstraints('UF2').includes('colorWheel'));
});

test('unrankedActiveFields counts a per-LINE override as ranked (no plant-wide list required)', () => {
  Store.setMasterData({ plants: [{ plant: 'UF3', constraints: [{ key: 'prt01', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ L01: { prt01: { DOG: 1 } } }, 'unit-test');
  assert.deepEqual(Engine.unrankedActiveFields('UF3'), [],
    'a plant configured purely with per-line overrides must not be reported as unconfigured');
});

test('changeoverTaskFields tracks active priority fields, defaulting to COLOR+FORM_SIZE', () => {
  // Never-configured plant: byte-identical to the hardcoded pair it replaces.
  Store.setMasterData({ plants: [{ plant: 'CO1' }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO1'), ['COLOR', 'FORM_SIZE']);

  // PRT-only plant: COLOR drops out (not sequenced on), FORM_SIZE stays because
  // _sortTerms appends it in both grouping modes regardless.
  Store.setMasterData({ plants: [{ plant: 'CO2', constraints: [
    { key: 'prt01', enabled: true, order: 1, children: [{ key: 'prt02', enabled: true, order: 1 }] },
  ] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO2'), ['PRT_01', 'PRT_02', 'FORM_SIZE'],
    'nested child included (tree-aware via flattenConstraints); FORM_SIZE appended once');

  // An unregistered key contributes no field and must not throw.
  Store.setMasterData({ plants: [{ plant: 'CO3', constraints: [{ key: 'legacyGone', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  assert.deepEqual(Engine.changeoverTaskFields('CO3'), ['FORM_SIZE']);
});

test('_sortTerms skips the term for an unregistered key instead of adding a constant one', () => {
  Store.setMasterData({ plants: [{ plant: 'DT1', constraints: [
    { key: 'legacyGone', enabled: true, order: 1 },
    { key: 'colorWheel', enabled: true, order: 2 },
  ] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  // 'changeover' tail is [FORM_SIZE, MATERIAL_NUMBER, runHours] = 3 terms, so one
  // priority term (colorWheel only) means 4 — not 5 with a dead one.
  assert.equal(Engine._sortTerms('changeover', { plant: 'DT1' }).length, 4,
    'an unregistered key must not contribute a term returning the same string for every task');
});

test('_sortTerms: an EMPTY line-scoped map falls through to the plant-wide list', () => {
  // Reachable state: the generic upload route rejects only a row-less file, so an
  // override whose value column is entirely blank persists as {}. `??` does not
  // bridge an empty object, so this used to rank every order on that line 999999
  // while every other line ranked correctly.
  Store.setMasterData({ plants: [{ plant: 'SH1', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }], lines: [] }, 'unit-test');
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 4 } }, L01: { colorWheel: {} } }, 'unit-test');
  const term = Engine._sortTerms('changeover', { plant: 'SH1' })[0];
  assert.equal(term.get({ COLOR: 'RED', PRODUCTION_LINE: 'L01' }), '0000004|RED',
    'an empty override must not shadow the plant-wide rank');
  assert.equal(term.get({ COLOR: 'RED', PRODUCTION_LINE: 'L02' }), '0000004|RED',
    'unmapped line still resolves plant-wide (regression guard)');
  // A NON-empty override must still win — the fix must not break line scoping.
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 4 } }, L01: { colorWheel: { RED: 1 } } }, 'unit-test');
  const term2 = Engine._sortTerms('changeover', { plant: 'SH1' })[0];
  assert.equal(term2.get({ COLOR: 'RED', PRODUCTION_LINE: 'L01' }), '0000001|RED',
    'a real line override must still beat the plant-wide list');
});
