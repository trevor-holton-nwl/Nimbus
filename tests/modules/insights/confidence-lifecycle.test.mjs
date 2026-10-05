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

test('#25 command-palette Firm/Unfirm/Push/Unschedule push a REAL undo that restores tasks and firmed ids', () => {
  const { CommandPalette, UndoStack, Selection } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorEntries = UndoStack._entries.slice();
  const priorNimbus = globalThis.NIMBUS;
  const priorSchedule = Alerts.scheduleRecompute;
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  CommandPalette.close = () => {};
  const mk = (id, h) => ({ id, PLANT: 'UNDO-P', MACHINE: 'UNDO-L', RUN_TIME: 1,
    start_date: new Date(2026, 7, 3, h), end_date: new Date(2026, 7, 3, h + 1) });
  const run = (labelRe) => {
    const cmd = CommandPalette._buildSelectionCommands().find(c => labelRe.test(c.label));
    assert.ok(cmd, `command ${labelRe} present`);
    cmd.run();
  };
  try {
    Store.setTasks([mk('u1', 8), mk('u2', 10)], 'test');
    Store.setSelectedPlant('UNDO-P', 'test');
    Store.setFirmed(['u2'], true, 'test');
    Selection.set(['u1', 'u2']);
    const depth = () => UndoStack._entries.length;
    const startDepth = depth();

    // Push +1h
    const s1 = Store.tasks.u1.start_date.getTime();
    run(/push/i);
    assert.equal(depth(), startDepth + 1);
    assert.notEqual(Store.tasks.u1.start_date.getTime(), s1, 'push moved the order');
    UndoStack.pop();
    assert.equal(Store.tasks.u1.start_date.getTime(), s1, 'undo restores the original start');

    // Firm (u1 unfirmed, u2 firmed => not all firmed => Firm)
    run(/(^|[._ ])firm_selected|^Firm selected/);
    assert.equal(Store.isFirmed('u1'), true);
    UndoStack.pop();
    assert.equal(Store.isFirmed('u1'), false, 'undo of Firm unfirms u1');
    assert.equal(Store.isFirmed('u2'), true, 'undo of Firm leaves the previously firmed u2 firmed');

    // Unschedule
    run(/unschedule/i);
    assert.equal(Store.tasks.u1.start_date, null);
    UndoStack.pop();
    assert.equal(Store.tasks.u1.start_date.getTime(), s1, 'undo of Unschedule restores dates');
    assert.equal(depth(), startDepth, 'each action pushed exactly one entry, each pop removed it');
  } finally {
    Selection.clear();
    UndoStack._entries.length = 0;
    for (const e of priorEntries) UndoStack._entries.push(e);
    Alerts.scheduleRecompute = priorSchedule;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('#32 Confidence uses the selected plant\'s conf_score_horizon (master data) before the per-user setting', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorMaster = structuredClone(Store.masterData);
  const priorAvailable = Compute.available;
  const priorNimbus = globalThis.NIMBUS;
  const priorConfidence = Confidence.snapshot();
  globalThis.NIMBUS = nimbus;
  Compute.available = () => false;
  const alertIn2Days = [{ id: 'ch-a', type: 'overlap', sev: 'err', line: 'CH-L', taskId: 'ch-1', time: new Date(Date.now() + 2 * 86400000) }];
  const scoreFor = async (horizonMinutes) => {
    Store.setMasterData({ plants: [{ plant: 'CH', conf_score_horizon: horizonMinutes }], lines: [] }, 'test');
    Store.setAlerts(alertIn2Days, 'test');
    Confidence._lastAlertsSrc = null; Confidence._lastRev = null;
    await Confidence._recompute();
    return Confidence.snapshot().score;
  };
  try {
    Confidence._invalidatePending(true);
    Store.setTasks([{ id: 'ch-1', PLANT: 'CH', MACHINE: 'CH-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('CH', 'test');
    const shortHorizon = await scoreFor(60);          // the 2-day alert is OUTSIDE the plant's horizon
    const longHorizon = await scoreFor(20160);        // ...and INSIDE a 14-day one
    assert.ok(shortHorizon > longHorizon,
      `a short plant horizon must exclude the alert (short=${shortHorizon}, long=${longHorizon})`);
  } finally {
    Confidence._invalidatePending(true);
    Confidence.restore(priorConfidence);
    Compute.available = priorAvailable;
    Store.setMasterData(priorMaster ?? { plants: [], lines: [] }, 'test');
    Store.setAlerts(priorAlerts, 'test');
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

// ---- #26 Time Machine: put resolves with the key, in-memory cap, key-cursor prune -----------
// Deterministic: the fake IndexedDB completes its callbacks on the microtask queue (no wall-clock
// timers), and settle() drains that queue by yielding one macrotask turn.
const settle = () => new Promise(resolve => setImmediate(resolve));
function fakeIntelDb() {
  const rows = [];
  let nextId = 1;
  const tx = (mode) => {
    const t = { oncomplete: null, onerror: null };
    const os = {
      put(v) {
        const req = { result: undefined };
        const id = v.id ?? nextId++;
        req.result = id; rows.push({ ...v, id });
        queueMicrotask(() => t.oncomplete && t.oncomplete({}));
        return req;
      },
      count() { const req = { result: rows.length }; queueMicrotask(() => req.onsuccess && req.onsuccess({})); return req; },
      delete(key) { const i = rows.findIndex(r => r.id === key); if (i >= 0) rows.splice(i, 1); },
      index() {
        return {
          openKeyCursor() {
            const sorted = [...rows].sort((a, b) => a.ts - b.ts);
            let i = 0;
            const req = {};
            const emit = () => queueMicrotask(() => req.onsuccess && req.onsuccess({
              target: { result: i < sorted.length ? { primaryKey: sorted[i].id, continue() { i += 1; emit(); } } : null },
            }));
            emit();
            return req;
          },
        };
      },
    };
    t.objectStore = () => os;
    return t;
  };
  return { rows, transaction: (store, mode) => tx(mode) };
}

test('IntelDB.put resolves with the record key, not the transaction event (#26)', async () => {
  const db = nimbus.TimeMachine._IntelDB;
  const prior = db._db;
  const fake = fakeIntelDb();
  db._db = fake;
  try {
    const id = await db.put('snapshots', { ts: 1 });
    assert.equal(id, 1);
    assert.equal(typeof id, 'number');
  } finally { db._db = prior; }
});

test('pruneSnapshots deletes only the oldest rows by key cursor, leaving keepN (#26)', async () => {
  const db = nimbus.TimeMachine._IntelDB;
  const prior = db._db, priorRic = context.window.requestIdleCallback;
  const fake = fakeIntelDb();
  for (let i = 1; i <= 8; i += 1) fake.rows.push({ id: i, ts: i * 10 });
  db._db = fake;
  context.window.requestIdleCallback = fn => fn();
  try {
    db.pruneSnapshots(5);
    await settle();
    assert.deepEqual(fake.rows.map(r => r.id).sort((a, b) => a - b), [4, 5, 6, 7, 8], 'the 3 oldest are gone');
  } finally { db._db = prior; context.window.requestIdleCallback = priorRic; }
});

test('TimeMachine keeps at most 200 snapshots in memory (#26)', async () => {
  const tm = nimbus.TimeMachine;
  const db = tm._IntelDB;
  const prior = db._db, priorSnaps = tm._snapshots, priorRic = context.window.requestIdleCallback;
  db._db = fakeIntelDb();
  context.window.requestIdleCallback = () => {};
  tm._snapshots = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, ts: i, plant: null }));
  try {
    tm.snapshot('overflow');
    await settle();
    assert.equal(tm._snapshots.length, 200);
    assert.equal(tm._snapshots.at(-1).label, 'overflow');
    assert.equal(tm._snapshots[0].id, 2, 'the oldest entry was trimmed');
  } finally { db._db = prior; tm._snapshots = priorSnaps; context.window.requestIdleCallback = priorRic; }
});
