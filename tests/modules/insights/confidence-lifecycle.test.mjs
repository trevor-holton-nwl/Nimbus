// Regression tests for the classic-script Confidence module's What-If
// lifecycle. The VM harness runs the production nimbus-intelligence.js so the
// real debounce, Store subscriptions, and awaited Compute request are covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const { nimbus, context } = await loadLegacyApp();

// Keep the intelligence boot gate closed. We exercise the production
// Confidence object directly so unrelated command-palette/IndexedDB UI setup
// cannot mask the lifecycle behavior under test.
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const Confidence = nimbus.Confidence;
// Compute is intentionally not part of app.js's public compatibility return,
// but the classic intelligence layer reads it through the boot bridge.
const Compute = context.window.__NIMBUS_SERVICES.Compute;
const { Store, Sandbox, Alerts, SandboxAdapter } = nimbus;
nimbus.Compute = Compute;
Confidence.init();

test('an in-flight production Confidence request cannot overwrite a discarded baseline', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAvailable = Compute.available;
  const priorUtilization = Compute.utilization;
  const priorNimbus = globalThis.NIMBUS;
  const request = {};
  request.promise = new Promise(resolve => { request.resolve = resolve; });
  globalThis.NIMBUS = nimbus;

  try {
    Confidence._invalidatePending(true);
    Confidence.restore({ score: 88, history: [{ ts: 1, score: 88 }] });
    Store.setTasks([{ id: 'confidence-pending', PLANT: 'CONF-P', MACHINE: 'CONF-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('CONF-P', 'test');
    Compute.available = () => true;
    Compute.utilization = () => request.promise;

    const baseline = Confidence.snapshot();
    const pending = Confidence._recompute();
    await Promise.resolve();
    assert.ok(request.resolve, 'the production Confidence path must await utilization');

    Sandbox.enter('test');
    Sandbox.exit(false, 'test');
    request.resolve({ matrix: {} });
    await pending;

    assert.deepEqual(Confidence.snapshot(), baseline,
      'a worker result that resolves after discard must not change score or history');
  } finally {
    Confidence._invalidatePending(true);
    if (Sandbox.active) Sandbox.exit(false, 'test');
    Compute.available = priorAvailable;
    Compute.utilization = priorUtilization;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('real discard alert refresh does not re-arm Confidence after restoring its baseline', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorNimbus = globalThis.NIMBUS;
  const priorToast = nimbus.Toast.show;
  const priorTimer = Alerts._timer;
  const priorPendingFull = Alerts._pendingFull;
  const priorPendingLines = new Set(Alerts._pendingLines);
  const priorStartupPending = Confidence._startupPending;
  globalThis.NIMBUS = nimbus;
  nimbus.Toast.show = () => {};
  if (Alerts._timer) clearTimeout(Alerts._timer);
  Alerts._timer = null;
  Alerts._pendingFull = false;
  Alerts._pendingLines = new Set();

  const unsubscribeAdapter = Store.subscribe(event => {
    if (event.type === 'sandbox:entered') SandboxAdapter._onEntered();
    else if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
    else if (event.type === 'sandbox:reverted') SandboxAdapter._onReverted();
  }, 'confidence-lifecycle-test');

  try {
    Confidence._invalidatePending(true);
    // This test starts from an already-established live baseline. The early
    // discard regression below separately covers the still-pending bootstrap.
    Confidence._startupPending = false;
    Confidence.restore({ score: 86, history: [{ ts: 1, score: 86 }] });
    Store.setTasks([], 'test');
    Store.setSelectedPlant(null, 'test');
    const baseline = Confidence.snapshot();

    Sandbox.enter('test');
    Confidence.restore({ score: 17, history: [{ ts: 1, score: 86 }, { ts: 2, score: 17 }] });
    Sandbox.exit(false, 'test');

    await wait(750); // beyond the alert debounce and Confidence debounce/startup windows
    assert.deepEqual(Confidence.snapshot(), baseline,
      'the real post-discard alert refresh must not append a Confidence history sample');
  } finally {
    unsubscribeAdapter();
    Confidence._invalidatePending(true);
    if (Alerts._timer) clearTimeout(Alerts._timer);
    Alerts._timer = priorTimer;
    Alerts._pendingFull = priorPendingFull;
    Alerts._pendingLines = priorPendingLines;
    if (Sandbox.active) Sandbox.exit(false, 'test');
    Confidence._startupPending = priorStartupPending;
    nimbus.Toast.show = priorToast;
    Store.setAlerts(priorAlerts, 'test');
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('an early What-If discard re-arms the pending Confidence bootstrap', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorNimbus = globalThis.NIMBUS;
  const priorToast = nimbus.Toast.show;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorStartupPending = Confidence._startupPending;
  const priorLastAlerts = Confidence._lastAlertsSrc;
  const priorLastRev = Confidence._lastRev;
  const priorConfidence = Confidence.snapshot();
  const unsubscribeAdapter = Store.subscribe(event => {
    if (event.type === 'sandbox:entered') SandboxAdapter._onEntered();
    else if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
  }, 'confidence-early-bootstrap-test');
  globalThis.NIMBUS = nimbus;
  nimbus.Toast.show = () => {};
  Alerts.scheduleRecompute = () => {};

  try {
    Confidence._invalidatePending(true);
    Confidence._startupPending = true;
    Confidence.restore({ score: 91, history: [{ ts: 1, score: 91 }] });
    Store.setTasks([], 'test');
    Store.setSelectedPlant(null, 'test');
    Confidence._lastAlertsSrc = null;
    Confidence._lastRev = null;
    Confidence._scheduleStartupRecompute();

    Sandbox.enter('test');
    Sandbox.exit(false, 'test');

    await wait(700); // beyond the re-armed 600 ms bootstrap delay
    const after = Confidence.snapshot();
    assert.equal(after.score, 100, 'the restored live state receives its initial Confidence score');
    assert.equal(after.history.length, 2,
      'early discard does not leave the live badge permanently at its pre-bootstrap baseline');
    assert.equal(Confidence._startupPending, false, 'the re-armed bootstrap marks itself complete');
  } finally {
    unsubscribeAdapter();
    Confidence._invalidatePending(true);
    Confidence._startupPending = priorStartupPending;
    Confidence._lastAlertsSrc = priorLastAlerts;
    Confidence._lastRev = priorLastRev;
    Confidence.restore(priorConfidence);
    if (Sandbox.active) Sandbox.exit(false, 'test');
    nimbus.Toast.show = priorToast;
    Alerts.scheduleRecompute = priorSchedule;
    Store.setAlerts(priorAlerts, 'test');
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});
