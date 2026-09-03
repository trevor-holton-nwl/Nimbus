// Tests for frontend/insights/services.mjs (Compute, Alerts, Utilization,
// scheduleAlertsForPatches), split from tests/modules/schedule-services.test.mjs
// (Phase P4 of docs/architecture/domain-refactor-plan.md, which split
// schedule-services.mts into 4 domain files: optimization/scheduler-contract.mjs,
// optimization/engine.mjs, calendar/calendar-engine.mjs,
// insights/services.mjs).
//
// Three tests whose titles start with "Alerts" (Alerts.applyFix calling
// Engine.autoReflow for overlap/blackout alerts, and Alerts publishing scoped
// setup observations without invoking Engine) were reassigned here from the
// classifier's default "engine" bucket — Alerts is the module under test in
// each, with Engine as an external collaborator it calls, so they belong
// with Alerts's own test suite rather than Engine's. `Engine.autoReflow still
// calls Engine.autoReflow for overlap alerts (Task 3: B2)` is one of this
// phase's 5 accepted pre-existing baseline test failures.
//
// Alerts/Utilization's compute functions delegate to nimbus-compute-core.js
// via the ambient `globalThis.NimbusComputeCore` global (a real browser loads
// it via a parser-blocking <script> before app-entry.mjs's static imports
// run). Under plain Node ESM (this file) nothing sets that global
// automatically, so we bootstrap it here via createRequire — mirroring
// tests/modules/helpers/load-legacy-app.mjs's identical bootstrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Compute, Alerts, Utilization, scheduleAlertsForPatches } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

// Engine.autoReflow/runAndApply's early-return guards call Toast.show(Util.t(...)) —
// platform/foundation.mjs's Toast/Util reference bare `window`/`document`, same
// split-realm quirk documented in tests/modules/helpers/load-legacy-app.mjs. A
// minimal stub (matching that harness's approach) keeps those guard paths a real
// no-op under plain Node instead of throwing "document/window is not defined".
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

test('Compute.available reflects Worker constructor availability', () => {
  assert.equal(typeof Compute.available(), 'boolean');
});

test('Compute has no underscore-prefixed properties reachable on the export (closure-private by construction)', () => {
  // Reassigned here from the classifier's default "engine" bucket during this
  // phase's split — the classifier's `Compute.` regex missed this test's bare
  // `Object.keys(Compute)` reference (no trailing `.`), but Compute is
  // unambiguously the module under test.
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


test('Alerts dismissal snapshots are detached and restore without scheduling recompute', () => {
  const priorDismissed = Alerts.snapshotDismissed();
  const priorSchedule = Alerts.scheduleRecompute;
  let scheduleCalls = 0;
  Alerts.scheduleRecompute = () => { scheduleCalls++; };
  try {
    Alerts.restoreDismissed(new Set(['dismissed-a', 'dismissed-b']));
    const snapshot = Alerts.snapshotDismissed();
    snapshot.add('mutated-after-snapshot');
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['dismissed-a', 'dismissed-b']),
      'mutating a saved dismissal set must not change Alerts state');

    Alerts.clearDismissed();
    Alerts.restoreDismissed(snapshot);
    snapshot.clear();
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['dismissed-a', 'dismissed-b', 'mutated-after-snapshot']),
      'restore must copy the supplied set so later caller mutations cannot change Alerts state');
    assert.equal(scheduleCalls, 0, 'snapshot/restore APIs must not schedule an alert recompute');
  } finally {
    Alerts.restoreDismissed(priorDismissed);
    Alerts.scheduleRecompute = priorSchedule;
  }
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


test('Store "schedule:hydrated" event triggers Alerts.scheduleRecompute (scheduling/persistence -> insights/services seam)', () => {
  // Regression test for the reverse-dependency seam Task 4 introduced:
  // scheduling/persistence.mjs may not import this module, so Persistence/
  // CalendarSync (5 call sites: load()'s two branches, _loadCache(),
  // _loadDemo()) emit a `{ type: 'schedule:hydrated' }` Store event instead of
  // calling Alerts.scheduleRecompute() directly. This module
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
  Store.setTasks([{ id: 'u1', RUN_TIME: '1', MACHINE: 'L1', plant: '5512' }], 'unit-test');
  const m3 = Utilization.computeMatrix(day, 7);
  assert.notEqual(m3, m1, 'a Store mutation must bump Store.rev() and invalidate the memo');
});


test('Utilization.dayByLine is unmemoized — two calls with the same args recompute independently', () => {
  const a = Utilization.dayByLine(new Date());
  const b = Utilization.dayByLine(new Date());
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'must not be the same cached object reference — dayByLine has no memo');
});


test('Alerts publishes scoped setup observations without invoking Engine, including Fix It', () => {
  // This fails if alerts bypass the shared setup projection, resolve matrices in
  // the core, or make a setup diagnostic recursively optimize on Fix It.
  const state = value => [{ fieldKey: 'colorWheel', value }];
  Store.setTasks([{
    id: 'uncovered-order', PLANT: 'P-ALERT', MACHINE: 'L-ALERT', COLOR: 'RED', RUN_TIME: 1,
    start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T09:00:00'),
  }], 'unit-test');
  Store.setSelectedPlant('P-ALERT', 'unit-test');
  Store.replaceSetupSnapshot({
    plant: 'P-ALERT',
    definition: { plant: 'P-ALERT', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [],
    machine_states: [{ machine: 'L-ALERT', state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  const originalRun = Engine.runAndApply;
  let engineRuns = 0;
  Engine.runAndApply = (...args) => { engineRuns++; return originalRun.apply(Engine, args); };
  try {
    Alerts._recomputeSync({ lines: new Set(['L-ALERT']) });
    const setupAlert = Store.alerts.find(alert => alert.type === 'setup-uncovered');
    assert.ok(setupAlert, 'the scoped worker/core payload must include the unresolved setup observation');
    Alerts.applyFix(setupAlert.id);
    Alerts._recomputeSync({ lines: new Set(['L-ALERT']) });
    assert.equal(engineRuns, 0, 'setup observation alerts must never invoke Engine, even after explicit Fix It');
  } finally {
    Engine.runAndApply = originalRun;
  }
});


test('Alerts.applyFix still calls Engine.autoReflow for overlap alerts (Task 3: B2)', () => {
  // Task 3: B2 deleted manual-edit autoReflow calls but kept Alerts.applyFix's.
  // This verifies Engine.autoReflow is still called from applyFix for overlap type.
  const line = 'REFLOW-OVERLAP-TEST-LINE';
  const plant = '5512';
  const base = Date.now() + 24 * 60 * 60 * 1000;
  const start1 = new Date(base + 8 * 60 * 60 * 1000);
  const end1 = new Date(base + 10 * 60 * 60 * 1000);
  const start2 = new Date(base + 9 * 60 * 60 * 1000); // overlaps with task 1
  const end2 = new Date(base + 11 * 60 * 60 * 1000);
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;

  let autoReflowCallCount = 0;
  Engine.autoReflow = (id) => {
    autoReflowCallCount++;
    return priorAutoReflow.call(Engine, id);
  };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'overlap-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'overlap-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    // Simulate an overlap alert and apply the fix
    Alerts._recomputeSync();
    const overlapAlert = Store.alerts.find(a => a.type === 'overlap');
    assert.ok(overlapAlert, 'an overlap alert must be present');
    const callCountBefore = autoReflowCallCount;
    Alerts.applyFix(overlapAlert.id);
    assert.ok(autoReflowCallCount > callCountBefore,
      'Engine.autoReflow must be called inside applyFix for overlap alerts (Task 3: B2 kept this call)');
  } finally {
    Engine.autoReflow = priorAutoReflow;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});


test('Alerts.applyFix still calls Engine.autoReflow for blackout alerts (Task 3: B2)', () => {
  // Task 3: B2 deleted manual-edit autoReflow calls but kept Alerts.applyFix's.
  // applyFix handles both 'overlap' and 'blackout' via the same branch (line 1476),
  // calling Engine.autoReflow at line 1515. This test verifies the call path by
  // mocking an alert and confirming autoReflow is invoked for 'blackout' type.
  const line = 'REFLOW-BLACKOUT-TEST-LINE';
  const plant = '5512';
  const taskId = 'blackout-test-task';
  const start = new Date('2026-08-25T08:00:00');
  const end = new Date('2026-08-25T10:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;
  const priorAlerts = structuredClone(Store.alerts);

  let autoReflowCallCount = 0;
  Engine.autoReflow = (id) => {
    autoReflowCallCount++;
    return priorAutoReflow.call(Engine, id);
  };

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: taskId, PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start, end_date: end },
  ], 'unit-test');
  // Manually inject a blackout alert to avoid complex setup
  const fakeAlert = {
    id: 'blackout-test-alert',
    type: 'blackout',
    taskId: taskId,
  };
  Store.setAlerts([fakeAlert], 'unit-test');

  try {
    const callCountBefore = autoReflowCallCount;
    Alerts.applyFix(fakeAlert.id);
    assert.ok(autoReflowCallCount > callCountBefore,
      'Engine.autoReflow must be called inside applyFix for blackout alerts (Task 3: B2 kept this call)');
  } finally {
    Engine.autoReflow = priorAutoReflow;
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// scheduleAlertsForPatches (Phase 3, Pkg E) — shared post-apply alert-recompute
// scoping for optimizer patches. Mocks Alerts.scheduleRecompute/
// scheduleRecomputeLines (same pattern as the debounce test above) to verify
// routing without waiting on the real debounce timer.
// ---------------------------------------------------------------------------

function withMockedAlertScheduling(fn) {
  const priorFull = Alerts.scheduleRecompute;
  const priorLines = Alerts.scheduleRecomputeLines;
  let fullCalls = 0;
  let linesCalls = [];
  Alerts.scheduleRecompute = () => { fullCalls++; };
  Alerts.scheduleRecomputeLines = (lines) => { linesCalls.push(lines); };
  try {
    fn({ getFullCalls: () => fullCalls, getLinesCalls: () => linesCalls });
  } finally {
    Alerts.scheduleRecompute = priorFull;
    Alerts.scheduleRecomputeLines = priorLines;
  }
}


test('scheduleAlertsForPatches falls back to a full recompute for an empty patch list', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    scheduleAlertsForPatches([], () => 'L1');
    assert.equal(getFullCalls(), 1, 'an empty patch list must trigger exactly one full recompute');
    assert.equal(getLinesCalls().length, 0, 'the scoped variant must never be called for an empty patch list');
  });
});


test('scheduleAlertsForPatches falls back to a full recompute when a patch carries a MACHINE change', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    const patches = [
      { id: 'p1', changes: { start_date: new Date('2026-08-21T08:00:00') } },
      { id: 'p2', changes: { MACHINE: 'NEW-LINE' } },
    ];
    scheduleAlertsForPatches(patches, () => 'L1');
    assert.equal(getFullCalls(), 1,
      'a patch whose changes carry a MACHINE field must fall back to a full recompute, never a scoped one');
    assert.equal(getLinesCalls().length, 0);
  });
});


test('scheduleAlertsForPatches falls back to a full recompute when a patch id resolves to no line', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    const patches = [
      { id: 'resolvable', changes: { start_date: new Date('2026-08-21T08:00:00') } },
      { id: 'unresolvable', changes: { start_date: new Date('2026-08-21T09:00:00') } },
    ];
    const resolveLine = (id) => (id === 'resolvable' ? 'L1' : undefined);
    scheduleAlertsForPatches(patches, resolveLine);
    assert.equal(getFullCalls(), 1,
      'an id that resolves to no line must fall back to a full recompute rather than trust an incomplete scope');
    assert.equal(getLinesCalls().length, 0);
  });
});


test('scheduleAlertsForPatches scopes to exactly the resolved lines for normal patches', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    const patches = [
      { id: 'a', changes: { start_date: new Date('2026-08-21T08:00:00') } },
      { id: 'b', changes: { start_date: new Date('2026-08-21T09:00:00') } },
      { id: 'c', changes: { start_date: new Date('2026-08-21T10:00:00') } },
    ];
    const lineById = { a: 'L1', b: 'L2', c: 'L1' };
    scheduleAlertsForPatches(patches, (id) => lineById[id]);
    assert.equal(getFullCalls(), 0, 'normal, fully-resolvable patches must never trigger a full recompute');
    assert.equal(getLinesCalls().length, 1, 'exactly one scoped call must be made');
    assert.deepEqual(new Set(getLinesCalls()[0]), new Set(['L1', 'L2']),
      'the scoped lines set must contain exactly the lines the patches resolved to, deduplicated');
  });
});

// ---------------------------------------------------------------------------
// effectiveFirmedIdSet -- the single fold the setup-aware branch of
// runAndApply uses to decide which orders are immovable for a run, and the
// bugfix pinned here: respectFirmed must gate ECC-firmed orders exactly like
// it gates manual firms, while the frozen-horizon fold is unconditional.
// ---------------------------------------------------------------------------

