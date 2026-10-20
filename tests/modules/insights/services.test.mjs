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
import { Compute, Alerts, Utilization, scheduleAlertsForPatches, loadDistributionSummary } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

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
  assert.deepEqual(keys.sort(), ['alerts', 'available', 'leverageBatch', 'utilization']);
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
    Alerts.restoreDismissed(null);
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(),
      'null restores an empty dismissal set');
    Alerts.restoreDismissed(undefined);
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(),
      'undefined restores an empty dismissal set');
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

test('Alerts.recompute schedules a fresh pass when the worker result is stale', async () => {
  const priorAvailable = Compute.available;
  const priorAlerts = Compute.alerts;
  const priorSchedule = Alerts.scheduleRecompute;
  let queued = 0;
  Store.setSelectedPlant('PLANT-STABLE', 'unit-test');
  Compute.available = () => true;
  Compute.alerts = async () => ({ alerts: [], elapsed: 1 });
  Alerts.scheduleRecompute = () => { queued += 1; };
  try {
    Alerts.recompute();
    Store.emit({ type: 'unit-test:revision', source: 'unit-test' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(queued, 1);
  } finally {
    Compute.available = priorAvailable;
    Compute.alerts = priorAlerts;
    Alerts.scheduleRecompute = priorSchedule;
  }
});


test('Alerts.scheduleRecompute/{,Lines} debounce and eventually call recompute (adaptive delay)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // virtual clock: the debounce is ticked, not slept
  let recomputeCalls = 0;
  const orig = Alerts.recompute;
  Alerts.recompute = (...args) => { recomputeCalls++; return orig.apply(Alerts, args); };
  Alerts.scheduleRecompute();
  t.mock.timers.tick(600); // > _ALERTS_MAX_DEBOUNCE_MS
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

test('gate 33: the auto-fix "order moved" toast reads the FINISH of the moved order, not its start', () => {
  const plant = '5512', line = 'ORDERMOVED-TOAST-LINE', taskId = 'ordermoved-toast-task';
  const priorPlant = Store.selectedPlant, priorAlerts = structuredClone(Store.alerts);
  const priorShow = Toast.show, priorT = Util.t;
  const shown = [];
  Toast.show = () => {};
  Util.t = (key, vars) => { if (key === 'toast.order_moved') shown.push(vars); return priorT.call(Util, key, vars); };
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([{ id: taskId, PLANT: plant, MACHINE: line, RUN_TIME: '2',
    start_date: new Date('2026-08-25T08:00:00'), end_date: new Date('2026-08-25T10:00:00') }], 'unit-test');
  Store.setAlerts([{ id: 'ordermoved-alert', type: 'blackout', taskId }], 'unit-test');
  try {
    Alerts.applyFix('ordermoved-alert');
    assert.equal(shown.length, 1, 'the toast was raised once');
    const moved = Store.tasks[taskId];
    assert.equal(shown[0].date, Util.fmtDT(moved.end_date), 'the date is the finish of the moved order');
    assert.notEqual(shown[0].date, Util.fmtDT(moved.start_date), 'and not its start');
  } finally {
    Toast.show = priorShow; Util.t = priorT;
    Store.setAlerts(priorAlerts, 'unit-test'); Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setTasks([], 'unit-test'); UndoStack._entries.length = 0;
  }
});

test('G-0.25: Alerts.applyFix never moves a row carrying a placement exception (overtime / overlong); it toasts cannot_fix_firmed', () => {
  const plant = '5512', line = 'MARKED-FIX-LINE', taskId = 'marked-fix-task';
  const priorPlant = Store.selectedPlant, priorAlerts = structuredClone(Store.alerts), priorShow = Toast.show;
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg: String(msg), type }); };
  const start = new Date('2026-08-25T08:00:00'), end = new Date('2026-08-25T10:00:00');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([{ id: taskId, PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start, end_date: end, placement_exception: 'overtime' }], 'unit-test');
  Store.setAlerts([{ id: 'marked-fix-alert', type: 'blackout', taskId }], 'unit-test');
  const entries = UndoStack._entries.length;
  try {
    Alerts.applyFix('marked-fix-alert');
    assert.equal(Store.tasks[taskId].start_date.getTime(), start.getTime(), 'the marked bar did not move');
    assert.equal(Store.tasks[taskId].end_date.getTime(), end.getTime());
    assert.equal(UndoStack._entries.length, entries, 'no undo entry: nothing happened');
    assert.deepEqual(toasts.map(t => t.type), ['warn']);
    assert.equal(toasts[0].msg, String(Util.t('toast.cannot_fix_firmed')));
  } finally {
    Toast.show = priorShow;
    Store.setAlerts(priorAlerts, 'unit-test'); Store.setSelectedPlant(priorPlant, 'unit-test'); Store.setTasks([], 'unit-test');
  }
});

test('gate 23 b: the overload auto-fix leaves exactly two undo entries (the optimizer and the fix) and one Ctrl+Z restores the line', () => {
  const plant = '5512', line = 'OVERLOAD-UNDO-LINE';
  const priorPlant = Store.selectedPlant, priorAlerts = structuredClone(Store.alerts);
  const priorRun = Engine.runAndApply, priorShow = Toast.show;
  Toast.show = () => {};
  const day = new Date('2026-08-25T00:00:00');
  const aStart = new Date('2026-08-25T08:00:00'), aEnd = new Date('2026-08-25T12:00:00');
  Store.setSelectedPlant(plant, 'unit-test');
  const priorMasterData = Store.masterData;
  Store.setMasterData({ plants: [{ plant, timezone: 'America/Chicago' }], lines: [{ machine: line, plant }] }, 'unit-test');   // VM6: the fix needs a plant clock
  Store.setTasks([{ id: 'ov-a', PLANT: plant, MACHINE: line, RUN_TIME: '4', start_date: aStart, end_date: aEnd }], 'unit-test');
  Store.setAlerts([{ id: 'ov-alert', type: 'overload', line, time: day }], 'unit-test');
  UndoStack._entries.length = 0;
  // Stand in for the optimizer: it moves the order and pushes its own entry, exactly as Engine.runAndApply does.
  Engine.runAndApply = () => {
    const snap = UndoStack.snapshotTasks(['ov-a']);
    Store.updateTask('ov-a', { start_date: new Date('2026-08-25T14:00:00'), end_date: new Date('2026-08-25T18:00:00') }, 'engine');
    UndoStack.push('Optimization (changeover)', () => UndoStack.restoreTasks(snap), ['ov-a']);
  };
  try {
    Alerts.applyFix('ov-alert');
    assert.equal(UndoStack._entries.length, 2, 'the optimizer entry plus the auto-fix entry');
    assert.match(UndoStack._entries[1].label, /Auto-fix overload/);
    UndoStack.pop();                                         // one Ctrl+Z: the fix's snapshot predates the optimizer
    assert.equal(Store.tasks['ov-a'].end_date.getTime(), aEnd.getTime(), 'the finish is back where it was before the auto-fix');
  } finally {
    Engine.runAndApply = priorRun; Toast.show = priorShow;
    Store.setAlerts(priorAlerts, 'unit-test'); Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setTasks([], 'unit-test'); UndoStack._entries.length = 0;
    Store.setMasterData(priorMasterData, 'unit-test');
  }
});

test('VM6: the overload auto-fix refuses a plant with no valid time zone and runs no optimizer', () => {
  const plant = 'NOTZ-PLANT', line = 'NOTZ-LINE';
  const priorPlant = Store.selectedPlant, priorAlerts = structuredClone(Store.alerts), priorMasterData = Store.masterData;
  const priorRun = Engine.runAndApply, priorShow = Toast.show;
  const shown = [];
  Toast.show = (msg, type) => { shown.push(type); };
  let ran = false;
  Engine.runAndApply = () => { ran = true; };
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setMasterData({ plants: [{ plant }], lines: [{ machine: line, plant }] }, 'unit-test');
  Store.setAlerts([{ id: 'notz-alert', type: 'overload', line, time: new Date('2026-08-25T00:00:00') }], 'unit-test');
  try {
    Alerts.applyFix('notz-alert');
    assert.equal(ran, false);
    assert.ok(shown.includes('error'), 'the Optimize-dialog refusal toast is shown (plantNow adds its own one-time warn)');
  } finally {
    Engine.runAndApply = priorRun; Toast.show = priorShow;
    Store.setAlerts(priorAlerts, 'unit-test'); Store.setSelectedPlant(priorPlant, 'unit-test'); Store.setMasterData(priorMasterData, 'unit-test');
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

test('scheduleAlertsForPatches escalates to a full recompute when a moved task carries a real PRT tool id', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    const patches = [
      { id: 'tooled', changes: { start_date: new Date('2026-08-21T08:00:00') } },
    ];
    const taskById = { tooled: { id: 'tooled', MACHINE: 'L1', PRT_01: 'MOLD-7' } };
    scheduleAlertsForPatches(patches, id => taskById[id]?.MACHINE, id => taskById[id]);
    assert.equal(getFullCalls(), 1,
      'a moved task carrying a non-blank PRT_01/PRT_02 must force a full recompute, since tool-conflict alerts can land on a different line');
    assert.equal(getLinesCalls().length, 0);
  });
});


test('scheduleAlertsForPatches still scopes to lines when no moved task carries a tool', () => {
  withMockedAlertScheduling(({ getFullCalls, getLinesCalls }) => {
    const patches = [
      { id: 'untooled', changes: { start_date: new Date('2026-08-21T08:00:00') } },
    ];
    const taskById = { untooled: { id: 'untooled', MACHINE: 'L1', PRT_01: '-', PRT_02: 'N/A' } };
    scheduleAlertsForPatches(patches, id => taskById[id]?.MACHINE, id => taskById[id]);
    assert.equal(getFullCalls(), 0, 'blank/placeholder tool ids must not force a full recompute');
    assert.equal(getLinesCalls().length, 1);
    assert.deepEqual(new Set(getLinesCalls()[0]), new Set(['L1']));
  });
});

// ---------------------------------------------------------------------------
// effectiveFirmedIdSet -- the single fold the setup-aware branch of
// runAndApply uses to decide which orders are immovable for a run, and the
// bugfix pinned here: respectFirmed must gate ECC-firmed orders exactly like
// it gates manual firms, while the frozen-horizon fold is unconditional.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D26 — loadDistributionSummary request-identity guard (Task F4). A response
// captured under an older plant selection must never clobber a newer one.
// ---------------------------------------------------------------------------

test('loadDistributionSummary drops a response that lands after the user switched plants', async () => {
  const priorFetch = Util.fetchTraced;
  const priorMasterData = Store.masterData;
  const priorPlant = Store.selectedPlant;
  const priorSandboxActive = Sandbox.active;
  try {
    // Sandbox.active = true blocks the reactive 'plant:selected' subscriber
    // (services.mts's own `distribution-loader` subscription) from firing a
    // real, unstubbed fetch while we get into position — it would otherwise
    // run here with Util.fetchTraced still unstubbed.
    Sandbox.active = true;
    Store.setSelectedPlant('DIST-A', 'unit-test');
    Store.setMasterData({ plants: [], lines: [] }, 'unit-test'); // non-null, so the function under test doesn't early-return

    let releaseA;
    let fetchCalls = 0;
    Util.fetchTraced = () => {
      fetchCalls++;
      // Call 1 is this test's own explicit call, for plant A (deferred, under
      // our control below). Call 2+ is the reactive 'plant:selected'
      // subscriber's OWN loadDistributionSummary(), fired the moment plant B
      // is selected below — left permanently pending so it cannot write
      // Store.distributionSummary either, keeping this test's only
      // observable write the one under test (plant A's late response).
      if (fetchCalls === 1) return new Promise(resolve => { releaseA = resolve; });
      return new Promise(() => {});
    };

    Sandbox.active = false; // re-enable: our explicit call below must take the real guard path
    const pending = loadDistributionSummary();
    await new Promise(resolve => setImmediate(resolve)); // let the fetch call happen
    assert.equal(typeof releaseA, 'function');

    Store.setSelectedPlant('DIST-B', 'unit-test'); // reactively fires a second, permanently-pending load for B
    assert.equal(Store.distributionSummary, null, 'switching plants resets the summary synchronously');

    releaseA({ ok: true, json: async () => ({ needs_review: 99, changed: 99, problems: 99 }) });
    await pending;
    assert.equal(Store.distributionSummary, null,
      'plant A\'s late response must never overwrite the summary once the user has switched to plant B');
  } finally {
    Sandbox.active = true; // block the reactive subscriber again while unwinding, same reason as setup
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Util.fetchTraced = priorFetch;
    Sandbox.active = priorSandboxActive;
  }
});

test('fix round 1 — a stale in-flight request must not overwrite the null a later early-return call sets (seq bumped before the guard)', async () => {
  // Pins the fix: `const seq = ++_summarySeq` now runs BEFORE the
  // no-plant/What-If/no-masterData early return, not after it, so a call
  // that itself takes the early-return path still supersedes an OLDER
  // call's in-flight request.
  const priorFetch = Util.fetchTraced;
  const priorMasterData = Store.masterData;
  const priorPlant = Store.selectedPlant;
  const priorSandboxActive = Sandbox.active;
  try {
    Sandbox.active = true; // keep the reactive 'plant:selected' subscriber quiet while getting into position
    Store.setSelectedPlant('DIST-SEQ', 'unit-test');
    Store.setMasterData({ plants: [], lines: [] }, 'unit-test');
    Sandbox.active = false;

    let release;
    Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
    const pending = loadDistributionSummary(); // call 1: real request, deferred
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');

    // Call 2, same plant, no Store event: takes the early-return path
    // (What-If now active) without ever calling fetchTraced again.
    Sandbox.active = true;
    await loadDistributionSummary();
    assert.equal(Store.distributionSummary, null);

    // Call 1's request now resolves — it must be dropped, not overwrite the
    // null call 2 just set.
    release({ ok: true, json: async () => ({ needs_review: 7, changed: 7, problems: 7 }) });
    await pending;
    assert.equal(Store.distributionSummary, null,
      'a stale in-flight request must not overwrite the summary a later early-returning call already nulled');
  } finally {
    Sandbox.active = true;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Util.fetchTraced = priorFetch;
    Sandbox.active = priorSandboxActive;
  }
});


test('#28 Alerts.applyFix fixes an SAP-firmed order, but refuses manually-firmed and running orders (effective firmed set)', () => {
  const plant = '5512';
  const line = 'FIRMFIX-LINE';
  const start = new Date('2026-08-25T08:00:00');
  const end = new Date('2026-08-25T10:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorFirmed = new Set(Store.firmedIds);
  const runStart = new Date(Date.now() - 3600_000);
  const runEnd = new Date(Date.now() + 3600_000);
  let priorMasterData;
  try {
    Store.setSelectedPlant(plant, 'unit-test');
    // A plant needs a valid zone to have a clock (OQ52); the running order is judged against it.
    priorMasterData = Store.masterData;
    Store.setMasterData({ lines: [], ...Store.masterData, plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] }, 'unit-test');
    Store.setTasks([
      { id: 'ff-ecc', PLANT: plant, MACHINE: line, RUN_TIME: '2', user_scheduled: true, start_date: start, end_date: end, ecc_firmed: true },
      { id: 'ff-man', PLANT: plant, MACHINE: line, RUN_TIME: '2', user_scheduled: true, start_date: start, end_date: end },
      { id: 'ff-run', PLANT: plant, MACHINE: line, RUN_TIME: '2', user_scheduled: true, start_date: runStart, end_date: runEnd },
    ], 'unit-test');
    Store.setFirmed(['ff-man'], true, 'unit-test');
    // SAP firm is display-only: the fix goes ahead and moves the order.
    const sapAlert = { id: 'ff-alert-ff-ecc', type: 'blackout', taskId: 'ff-ecc' };
    Store.setAlerts([sapAlert], 'unit-test');
    Alerts.applyFix(sapAlert.id);
    assert.equal(Store.alerts.length, 0, 'an SAP-firmed order IS fixed (not refused): the alert is dismissed');
    for (const id of ['ff-man', 'ff-run']) {
      const t0 = Store.tasks[id].start_date.getTime();
      const alert = { id: `ff-alert-${id}`, type: 'blackout', taskId: id };
      Store.setAlerts([alert], 'unit-test');
      Alerts.applyFix(alert.id);
      assert.equal(Store.tasks[id].start_date.getTime(), t0, `${id} must not be moved by a one-click fix`);
      assert.equal(Store.alerts.length, 1, `${id}: the alert is not dismissed when the fix is refused`);
    }
  } finally {
    Store.setFirmed(['ff-man'], false, 'unit-test');
    for (const id of priorFirmed) Store.setFirmed([id], true, 'unit-test');
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    if (priorMasterData !== undefined) Store.setMasterData(priorMasterData, 'unit-test');
  }
});


test('Utilization.minutesByDay (the cell-briefing rule): a 14 h order spanning Wed 22:00 - Fri 00:00 (14-16 Oct 2026) puts all 14 h on Thursday, the only day with working time, and that 10 h window is overloaded', () => {
  const line = 'L-BRIEF';
  const priorCalendar = Store.calendars[line];
  const wh = {}; for (let i = 0; i < 7; i++) wh[i] = [8, 18];
  Store.calendars[line] = { workHours: wh };
  try {
    const task = { id: 'brief', MACHINE: line, RUN_TIME: 14, start_date: new Date(2026, 9, 14, 22), end_date: new Date(2026, 9, 16, 0) };
    const byDay = Utilization.minutesByDay(task, line);
    // The rule is intentional: the bar is attributed in proportion to each day's WORKING overlap, and Wed 22:00 and
    // Fri 00:00 are both outside the 08:00-18:00 window, so Thursday takes the whole run time.
    assert.deepEqual(byDay, { '2026-10-15': 840 });
    // Thursday's calendar window is 08:00-18:00 = 600 minutes, so the attributed 840 is 140% of that day's capacity:
    // the matrix flags it as overload instead of spreading it onto Wed/Fri.
    const capacityMin = (18 - 8) * 60;
    assert.equal(capacityMin, 600);
    assert.ok(byDay['2026-10-15'] > capacityMin, 'the attributed minutes exceed the 600-minute window');
    assert.equal(Math.round(byDay['2026-10-15'] / capacityMin * 100), 140);
  } finally { if (priorCalendar) Store.calendars[line] = priorCalendar; else delete Store.calendars[line]; }
});

test('I13: the worker prewarm starts the matrix on the plant clock and writes the cache key computeMatrix reads', async () => {
  const priorPlant = Store.selectedPlant;
  const priorAvailable = Compute.available;
  const priorUtilization = Compute.utilization;
  const priorCache = Utilization._cache;
  let askedStart = null;
  Util.setPlantClockResolver(plant => (plant === 'PW-P' ? new Date(2026, 9, 15, 0, 30) : null));   // plant a day ahead of the viewer
  Compute.available = () => true;
  Compute.utilization = (startMs) => { askedStart = startMs; return Promise.resolve({ matrix: {} }); };
  try {
    Store.setSelectedPlant('PW-P', 'unit-test');
    Utilization._cache = null;
    // A debounced alert recompute left by an earlier test can bump the store revision while the prewarm is in flight,
    // and the prewarm (correctly) drops a stale reply: retry until one lands.
    for (let attempt = 0; attempt < 5 && !Utilization._cache; attempt++) {
      Utilization._prewarm();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const plantToday = new Date(2026, 9, 15).getTime();
    assert.equal(askedStart, plantToday, 'the prewarm asks for the plant\'s today, not the viewer\'s');
    assert.match(Utilization._cache?.key ?? '', new RegExp(String.raw`^${plantToday}\|7\|\d+\|PW-P$`),
      'the cache key carries the plant-today start, so a Dashboard computeMatrix(plantClock) call hits it');
  } finally {
    Util.setPlantClockResolver((plant, line) => Store.plantNow(plant || (line ? Store.getPlantForLine(line) : null)));
    Compute.available = priorAvailable;
    Compute.utilization = priorUtilization;
    Utilization._cache = priorCache;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// Golden pin for the worker payload Compute assembles (_snap). Captured against the pre-refactor
// code: the plant-scoped fields, the priority-field strip and the derived setup must not drift.
test('Compute payload (_snap) is plant-scoped and strips PRODUCTION_VERSION', async () => {
  const sent = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class {
    postMessage(m) { sent.push(structuredClone(m)); }
  };
  const { Compute: C } = await import('../../../frontend/insights/services.mjs?snapgolden=1');
  try {
    Store.setMasterData({ plants: [{ plant: 'GP' }, { plant: 'OP' }], lines: [
      { plant: 'GP', line: 'GL1' }, { plant: 'OP', line: 'OL1' }] }, 'unit-test');
    Store.setTasks([
      { id: 'g1', MACHINE: 'GL1', PLANT: 'GP', PRODUCTION_VERSION: 'PV1', PRT_01: 'T1', RUN_TIME: 1 },
      { id: 'o1', MACHINE: 'OL1', PLANT: 'OP', PRODUCTION_VERSION: 'PV2', RUN_TIME: 1 },
    ], 'unit-test');
    Store.replaceBlocks([{ id: 'b1', plant: 'GP', line: 'GL1' }, { id: 'b2', plant: 'OP', line: 'OL1' }], 'unit-test');
    Store.replacePlantBlocks([{ id: 'pb1', plant: 'GP' }, { id: 'pb2', plant: 'OP' }], 'unit-test');
    Store.replaceCalendars({ GL1: { workHours: { 1: [6, 14] } }, OL1: { workHours: { 1: [0, 24] } } }, 'unit-test');
    Store.replacePlants({ GP: { workHours: { 1: [6, 14] } }, OP: { workHours: { 1: [0, 24] } } }, 'unit-test');
    Store.setSelectedPlant('GP', 'unit-test');
    void C.utilization(0, 7);
    const p = sent[0].payload;
    assert.deepEqual(p.tasks.map(t => t.id), ['g1']);
    assert.equal('PRODUCTION_VERSION' in p.tasks[0], false);
    assert.equal(p.tasks[0].PRT_01, 'T1');
    assert.deepEqual(p.blocks.map(b => b.id), ['b1']);
    assert.deepEqual(p.plantBlocks.map(b => b.id), ['pb1']);
    assert.deepEqual(Object.keys(p.calendars), ['GL1']);
    assert.deepEqual(Object.keys(p.plants), ['GP']);
    assert.deepEqual(Object.keys(p).sort(),
      ['blocks', 'calendars', 'days', 'lineSettings', 'masterData', 'plantBlocks', 'plants', 'setup', 'startMs', 'tasks']);
    assert.deepEqual(p.setup, { intervals: [], diagnostics: [] });
  } finally {
    if (prior) Object.defineProperty(globalThis, 'Worker', prior); else delete globalThis.Worker;
    Store.setSelectedPlant(null, 'unit-test');
    Store.setTasks([], 'unit-test');
  }
});
