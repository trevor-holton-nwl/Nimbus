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
  const priorMaster = Store.masterData;
  const priorOffset = Store.serverOffsetMs;
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  CommandPalette.close = () => {};
  // Push derives the start from the held finish on the plant's clock: give the plant a zone and pin the clock.
  Store.setMasterData({ ...priorMaster, plants: [{ plant: 'UNDO-P', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] }, 'test');
  Store.serverOffsetMs = new Date(2026, 7, 1).getTime() - Date.now();
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
    Store.setMasterData(priorMaster, 'test');
    Store.serverOffsetMs = priorOffset;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('Push +1 hour moves the finish and re-derives the start; firmed, frozen and running orders stay put (OQ8)', () => {
  const { CommandPalette, UndoStack, Selection } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorEntries = UndoStack._entries.slice();
  const priorNimbus = globalThis.NIMBUS;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorMaster = Store.masterData;
  const priorOffset = Store.serverOffsetMs;
  const priorFrozen = Store.frozenHorizonEnd;
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  CommandPalette.close = () => {};
  Store.setMasterData({ ...priorMaster, plants: [{ plant: 'PUSH-P', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] }, 'test');
  Store.serverOffsetMs = new Date(2026, 7, 3, 6, 0).getTime() - Date.now();   // plant clock: Mon 2026-08-03 06:00
  Store.setFrozenHorizonEnd(new Date(2026, 7, 3, 9, 0), 'test');
  const mk = (id, h1, h2) => ({ id, PLANT: 'PUSH-P', MACHINE: 'PUSH-L', RUN_TIME: h2 - h1,
    user_scheduled: true, start_date: new Date(2026, 7, 3, h1), end_date: new Date(2026, 7, 3, h2) });
  try {
    Store.setTasks([mk('normal', 10, 11), mk('firmed', 12, 13), mk('running', 5, 7), mk('frozen', 8, 9), mk('late', 18, 19)], 'test');
    Store.setSelectedPlant('PUSH-P', 'test');
    Store.setFirmed(['firmed'], true, 'test');
    Selection.set(['normal', 'firmed', 'running', 'frozen', 'late']);
    const cmd = CommandPalette._buildSelectionCommands().find(c => /push/i.test(c.label));
    cmd.run();
    const at = id => [Store.tasks[id].start_date.getHours(), Store.tasks[id].end_date.getHours()];
    assert.deepEqual(at('normal'), [11, 12], 'finish +1 h, start re-derived from the run time');
    assert.deepEqual(at('firmed'), [12, 13], 'a firmed order is skipped');
    assert.deepEqual(at('running'), [5, 7], 'a running order is skipped');
    assert.deepEqual(at('frozen'), [8, 9], 'a frozen order is skipped');
    assert.deepEqual(at('late'), [18, 19], 'a finish past closing cannot be held, so it is skipped rather than leapt');
  } finally {
    Selection.clear();
    UndoStack._entries.length = 0;
    for (const e of priorEntries) UndoStack._entries.push(e);
    Alerts.scheduleRecompute = priorSchedule;
    Store.setMasterData(priorMaster, 'test');
    Store.serverOffsetMs = priorOffset;
    Store.setFrozenHorizonEnd(priorFrozen, 'test');
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

// ---------------------------------------------------------------------------
// Command palette firm / un-firm actions and their undo (H3f). The production
// nimbus-intelligence.js is already loaded above; these drive the real palette
// commands against the real Store/UndoStack and observe the ids and sources.
// ---------------------------------------------------------------------------
async function withPaletteHarness(body) {
  const { CommandPalette, TimeMachine, UndoStack, Toast } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorFirmed = new Set(Store.firmedIds);
  const priorEntries = UndoStack._entries.slice();
  const priorSelection = nimbus.Selection;
  const priorToast = Toast.show;
  const priorSnapshot = TimeMachine.snapshot;
  const priorClose = CommandPalette.close;
  const priorSetFirmed = Store.setFirmed;
  const priorPush = UndoStack.push;
  const priorSchedule = Alerts.scheduleRecompute;
  const setFirmedCalls = [];
  const pushCalls = [];
  Toast.show = () => {};
  CommandPalette.close = () => {};
  TimeMachine.snapshot = () => ({});
  Alerts.scheduleRecompute = () => {};
  Store.setFirmed = function (ids, firmed, source) {
    setFirmedCalls.push({ ids: [].concat(ids).map(String), firmed, source });
    return priorSetFirmed.call(this, ids, firmed, source);
  };
  UndoStack.push = function (label, fn, ids) {
    pushCalls.push({ label, ids: ids ? [...ids].map(String) : undefined });
    return priorPush.call(this, label, fn, ids);
  };
  UndoStack._entries = [];
  try {
    await body({ CommandPalette, UndoStack, setFirmedCalls, pushCalls });
  } finally {
    Store.setFirmed = priorSetFirmed;
    UndoStack.push = priorPush;
    UndoStack._entries = priorEntries;
    Toast.show = priorToast;
    CommandPalette.close = priorClose;
    TimeMachine.snapshot = priorSnapshot;
    Alerts.scheduleRecompute = priorSchedule;
    nimbus.Selection = priorSelection;
    Store.setTasks(priorTasks, 'test');
    Store.firmedIds.clear();
    for (const id of priorFirmed) Store.firmedIds.add(id);
  }
}

const mkTask = id => ({ id, PLANT: 'CMD-P', MACHINE: 'CMD-L', RUN_TIME: 1, start_date: new Date('2031-03-03T08:00:00'), end_date: new Date('2031-03-03T09:00:00') });
const brief = calls => calls.map(c => ({ ids: c.ids, firmed: c.firmed, source: c.source }));

test('palette Firm N orders firms exactly the valid selected ids with cmd-palette source, and undo restores each previous firmed state', async () => {
  await withPaletteHarness(({ CommandPalette, UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('c1'), mkTask('c2'), mkTask('c3'), mkTask('c4')], 'test');
    Store.setFirmed(['c1'], true, 'test');             // c1 already firmed before the action
    setFirmedCalls.length = 0;
    nimbus.Selection = { ids: () => ['c1', 'c2', 'c3', 'ghost'], stats: () => ({ firmedCount: 1 }) };

    const cmd = CommandPalette._buildSelectionCommands().find(c => c.type === 'selection');
    assert.ok(cmd, 'a firm command is offered when not every selected order is firmed');
    cmd.run();

    // Unknown ids (a stale selection) are filtered out before firming and snapshotting.
    assert.deepEqual(brief(setFirmedCalls), [{ ids: ['c1', 'c2', 'c3'], firmed: true, source: 'cmd-palette' }]);
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].label, 'Firm 4 orders', 'label carries the SELECTION count');
    assert.deepEqual(pushCalls[0].ids, ['c1', 'c2', 'c3']);
    assert.ok(['c1', 'c2', 'c3'].every(id => Store.isFirmed(id)));
    assert.equal(Store.isFirmed('c4'), false, 'unselected order untouched');

    setFirmedCalls.length = 0;
    UndoStack.pop();
    assert.equal(Store.isFirmed('c1'), true, 'c1 was firmed before, so it stays firmed after undo');
    assert.equal(Store.isFirmed('c2'), false, 'c2 returns to unfirmed');
    assert.equal(Store.isFirmed('c3'), false, 'c3 returns to unfirmed');
    assert.deepEqual(brief(setFirmedCalls), [
      { ids: ['c1'], firmed: true, source: 'undo' },
      { ids: ['c2', 'c3'], firmed: false, source: 'undo' },
    ]);
  });
});

test('palette Unfirm N orders (all selected firmed) unfirms them and undo re-firms them', async () => {
  await withPaletteHarness(({ CommandPalette, UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('u1'), mkTask('u2')], 'test');
    Store.setFirmed(['u1', 'u2'], true, 'test');
    setFirmedCalls.length = 0;
    nimbus.Selection = { ids: () => ['u1', 'u2'], stats: () => ({ firmedCount: 2 }) };

    CommandPalette._buildSelectionCommands().find(c => c.type === 'selection').run();
    assert.deepEqual(brief(setFirmedCalls), [{ ids: ['u1', 'u2'], firmed: false, source: 'cmd-palette' }]);
    assert.equal(pushCalls[0].label, 'Unfirm 2 orders');
    assert.deepEqual(pushCalls[0].ids, ['u1', 'u2']);
    assert.ok(!Store.isFirmed('u1') && !Store.isFirmed('u2'));

    UndoStack.pop();
    assert.ok(Store.isFirmed('u1') && Store.isFirmed('u2'), 'undo restores the firmed state');
  });
});

test('palette freeze intent asks confirm.firm_all with the count, firms only the not-yet-firmed orders, and one undo restores the prior firmed set', async () => {
  await withPaletteHarness(async ({ UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('f1'), mkTask('f2'), mkTask('f3')], 'test');
    Store.setFirmed(['f2'], true, 'test');
    setFirmedCalls.length = 0;

    const freeze = nimbus.NeedsEngine.resolveIntent('freeze everything').find(r => r.type === 'intent');
    assert.ok(freeze, 'freeze intent resolves');
    const asked = [];
    const priorConfirm = context.window.confirm;
    context.window.confirm = msg => { asked.push(msg); return true; };
    try { freeze.run(); } finally { context.window.confirm = priorConfirm; }
    assert.equal(asked.length, 1, 'Firm All asks before firming');
    assert.match(asked[0], /confirm.firm_all/, 'the prompt is the confirm.firm_all message');
    assert.deepEqual(brief(setFirmedCalls), [{ ids: ['f1', 'f3'], firmed: true, source: 'cmd-palette' }]);
    assert.equal(pushCalls[0].label, 'Firm All (freeze)');
    assert.deepEqual(pushCalls[0].ids, ['f1', 'f3'], 'already-firmed f2 is not part of the undo scope');
    assert.ok(['f1', 'f2', 'f3'].every(id => Store.isFirmed(id)));

    UndoStack.pop();
    assert.equal(Store.isFirmed('f1'), false);
    assert.equal(Store.isFirmed('f3'), false);
    assert.equal(Store.isFirmed('f2'), true, 'f2 was firmed before and is not touched by undo');
  });
});

test('palette freeze declined at the confirm firms nothing and pushes no undo entry', async () => {
  await withPaletteHarness(async ({ UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('d1'), mkTask('d2')], 'test');
    setFirmedCalls.length = 0;
    const priorConfirm = context.window.confirm;
    context.window.confirm = () => false;
    try { nimbus.NeedsEngine.resolveIntent('freeze').find(r => r.type === 'intent').run(); }
    finally { context.window.confirm = priorConfirm; }
    assert.equal(setFirmedCalls.length, 0);
    assert.equal(pushCalls.length, 0);
    assert.ok(!Store.isFirmed('d1') && !Store.isFirmed('d2'));
  });
});

test('palette freeze with nothing left to firm pushes no undo entry and does not call setFirmed', async () => {
  await withPaletteHarness(async ({ UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('n1')], 'test');
    Store.setFirmed(['n1'], true, 'test');
    setFirmedCalls.length = 0;
    const priorConfirm = context.window.confirm;
    let asked = 0;
    context.window.confirm = () => { asked++; return true; };
    try { nimbus.NeedsEngine.resolveIntent('freeze').find(r => r.type === 'intent').run(); }
    finally { context.window.confirm = priorConfirm; }
    assert.equal(asked, 0, 'nothing to firm, so nothing to confirm');
    assert.equal(setFirmedCalls.length, 0);
    assert.equal(pushCalls.length, 0);
    assert.equal(UndoStack._entries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Time Machine history cap (TM_MAX_SNAPSHOTS = 200) at each of its three call
// sites: the init() load limit, the in-memory trim, and the IndexedDB prune.
// IntelDB is reachable via the TimeMachine._IntelDB test hook; stubbing its
// methods lets us observe the cap each call site actually passes.
// ---------------------------------------------------------------------------
async function withTimeMachineHarness(body) {
  const { TimeMachine } = nimbus;
  const db = TimeMachine._IntelDB;
  const prior = { put: db.put, getNewest: db.getNewest, pruneSnapshots: db.pruneSnapshots, snaps: TimeMachine._snapshots, subscribe: Store.subscribe };
  const log = { getNewest: [], prune: [], put: [] };
  db.put = snap => { log.put.push(snap); return Promise.resolve(log.put.length); };
  db.pruneSnapshots = (...args) => { log.prune.push(args); };
  Store.subscribe = () => () => {};   // init() must not leave live auto-snapshot subscriptions behind
  try {
    await body({ TimeMachine, db, log });
  } finally {
    Object.assign(db, { put: prior.put, getNewest: prior.getNewest, pruneSnapshots: prior.pruneSnapshots });
    Store.subscribe = prior.subscribe;
    TimeMachine._snapshots = prior.snaps;
  }
}

test('TimeMachine.init loads at most 200 newest snapshots, oldest-first', async () => {
  await withTimeMachineHarness(async ({ TimeMachine, db, log }) => {
    db.getNewest = (store, index, n) => {
      log.getNewest.push([store, index, n]);
      return Promise.resolve([{ ts: 30 }, { ts: 10 }, { ts: 20 }]);
    };
    TimeMachine.init();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(log.getNewest, [['snapshots', 'ts', 200]], 'loads from the snapshots store by ts with a 200 cap');
    assert.deepEqual(TimeMachine._snapshots.map(s => s.ts), [10, 20, 30], 'sorted oldest-first');
  });
});

test('TimeMachine.snapshot prunes IndexedDB to 200 and trims the in-memory history to the 200 newest', async () => {
  await withTimeMachineHarness(async ({ TimeMachine, log }) => {
    TimeMachine._snapshots = Array.from({ length: 200 }, (_, i) => ({ ts: i, label: `old${i}` }));
    const snap = TimeMachine.snapshot('newest');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(log.put.length, 1);
    assert.deepEqual(log.prune, [[200]], 'IntelDB.pruneSnapshots is called with the 200 cap');
    assert.equal(TimeMachine._snapshots.length, 200, 'history stays capped at 200');
    assert.equal(TimeMachine._snapshots[199], snap, 'newest is kept');
    assert.equal(TimeMachine._snapshots[0].label, 'old1', 'the single oldest entry is the one dropped');

    // Below the cap nothing is dropped.
    TimeMachine._snapshots = Array.from({ length: 199 }, (_, i) => ({ ts: i, label: `old${i}` }));
    TimeMachine.snapshot('another');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(TimeMachine._snapshots.length, 200);
    assert.equal(TimeMachine._snapshots[0].label, 'old0');
  });
});

test('gate 15: TimeMachine.restore brings back each row\'s finish, flags it stale and hands the ids to Engine.reconcileRestored (OQ21)', () => {
  const { TimeMachine, UndoStack, Toast } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorEntries = UndoStack._entries.slice();
  const priorSnaps = TimeMachine._snapshots;
  const priorNimbus = globalThis.NIMBUS;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorToast = Toast.show;
  const Engine = nimbus.Engine;
  const priorReconcile = Engine.reconcileRestored;
  const reconciled = [];
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};
  Engine.reconcileRestored = ids => { reconciled.push([...ids].map(String)); };
  try {
    Store.setSelectedPlant('TM-P', 'test');
    Store.setTasks([{ id: 'tm1', PLANT: 'TM-P', MACHINE: 'TM-L', RUN_TIME: 2, runtime_schedule_mismatch: false,
      start_date: new Date('2031-03-04T08:00:00'), end_date: new Date('2031-03-04T10:00:00') }], 'test');
    TimeMachine._snapshots = [{ id: 1, ts: 4242, label: 'before', plant: 'TM-P', tasks: [
      { id: 'tm1', start_date: '2031-03-03T06:00:00', end_date: '2031-03-03T08:00:00' },
      { id: 'gone', start_date: '2031-03-03T06:00:00', end_date: '2031-03-03T08:00:00' }] }];
    TimeMachine.restore(4242);
    const t = Store.tasks.tm1;
    assert.equal(t.end_date.getTime(), new Date('2031-03-03T08:00:00').getTime(), 'the snapshot finish is restored');
    assert.equal(t.runtime_schedule_mismatch, true, 'the restored start is a placeholder: the row is flagged stale');
    assert.deepEqual(reconciled, [['tm1']], 'only rows that still exist are re-derived, through Engine.reconcileRestored');
    assert.equal(UndoStack._entries.at(-1).label, 'Before Time Machine restore', 'the restore is itself undoable');
  } finally {
    Engine.reconcileRestored = priorReconcile;
    TimeMachine._snapshots = priorSnaps;
    UndoStack._entries = priorEntries;
    Toast.show = priorToast;
    Alerts.scheduleRecompute = priorSchedule;
    globalThis.NIMBUS = priorNimbus;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

// ---- Senior review I13 (one clock): intelligence panels read the plant's "today", like the Dashboard ----------------
test('I13: the Confidence and peak-briefing matrix requests start on the plant clock, not the viewer clock', async () => {
  const { NeedsEngine, Util } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAvailable = Compute.available;
  const priorUtilization = Compute.utilization;
  const priorNimbus = globalThis.NIMBUS;
  const starts = [];
  globalThis.NIMBUS = nimbus;
  // The plant is a day ahead of the viewer: its wall clock reads Thu 15 Oct 00:30 whatever the machine's clock says.
  Util.setPlantClockResolver(plant => (plant === 'I13-P' ? new Date(2026, 9, 15, 0, 30) : null));
  Compute.available = () => true;
  Compute.utilization = (startMs) => { starts.push(startMs); return Promise.resolve({ matrix: {} }); };
  try {
    Confidence._invalidatePending(true);
    Store.setTasks([{ id: 'i13-1', PLANT: 'I13-P', MACHINE: 'I13-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('I13-P', 'test');
    nimbus.Utilization._cacheClear();
    await Confidence._recompute();
    NeedsEngine._readState();   // sync computeMatrix on the plant clock: no worker post of its own any more
    const plantToday = new Date(2026, 9, 15).getTime();
    assert.ok(starts.length >= 1, 'Confidence asked the worker for a matrix');
    for (const startMs of starts) assert.equal(startMs, plantToday, 'the matrix window starts on the plant\'s today');
  } finally {
    Confidence._invalidatePending(true);
    Util.setPlantClockResolver((plant, line) => Store.plantNow(plant || (line ? Store.getPlantForLine(line) : null)));
    nimbus.Utilization._cacheClear();
    Compute.available = priorAvailable;
    Compute.utilization = priorUtilization;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

// ---- Senior review U31: Time Machine restore keeps a row's earlier unsaved edit dirty ------------------------------
test('U31: Time Machine restore hands the pre-restore dirty set to the reconcile (a null-start snapshot row keeps its dirty id)', () => {
  const { TimeMachine, UndoStack } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorNimbus = globalThis.NIMBUS;
  const priorSnapshots = TimeMachine._snapshots;
  const priorProbe = UndoStack.dirtyProbe;
  const priorReconcile = nimbus.Engine.reconcileRestored;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorEntries = UndoStack._entries.slice();
  const seen = [];
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  UndoStack.dirtyProbe = id => id === 'tm-dirty';           // only this row carried unsaved edits before the restore
  nimbus.Engine.reconcileRestored = (ids, wasDirty) => { seen.push({ ids: [...ids], wasDirty }); };
  try {
    Store.setTasks([{ id: 'tm-dirty', PLANT: 'TM-P', MACHINE: 'TM-L', RUN_TIME: 3 }, { id: 'tm-clean', PLANT: 'TM-P', MACHINE: 'TM-L', RUN_TIME: 2 }], 'test');
    Store.setSelectedPlant('TM-P', 'test');
    TimeMachine._snapshots = [{ ts: 4242, label: 'snap', plant: 'TM-P', tasks: [{ id: 'tm-dirty', start_date: null, end_date: null }, { id: 'tm-clean', start_date: null, end_date: null }] }];
    TimeMachine.restore(4242);
    assert.equal(seen.length, 1, 'the restore reconciles once');
    assert.equal(typeof seen[0].wasDirty?.has, 'function', 'the second argument is the wasDirty set');
    assert.ok(seen[0].wasDirty.has('tm-dirty'), 'the row that was dirty before the restore is in the set');
    assert.ok(!seen[0].wasDirty.has('tm-clean'), 'a row that was clean is not');
  } finally {
    TimeMachine._snapshots = priorSnapshots;
    UndoStack.dirtyProbe = priorProbe;
    nimbus.Engine.reconcileRestored = priorReconcile;
    Alerts.scheduleRecompute = priorSchedule;
    UndoStack._entries.length = 0;
    for (const e of priorEntries) UndoStack._entries.push(e);
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

// ---- Senior review U34: Push +1 h says how many stayed put and labels its undo with the moved count ----------------
test('U34: Push +1 hour reports moved and skipped counts and the undo label carries the moved count', () => {
  const { CommandPalette, UndoStack, Selection, Toast } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorEntries = UndoStack._entries.slice();
  const priorNimbus = globalThis.NIMBUS;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorMaster = Store.masterData;
  const priorOffset = Store.serverOffsetMs;
  const priorShow = Toast.show;
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  const loc = nimbus.Util.locale();
  const shown = [];
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  CommandPalette.close = () => {};
  Toast.show = (msg, type) => { shown.push({ msg, type }); };
  globalThis.window.__NIMBUS_LOCALES = { [loc]: {
    'toast.pushed_orders': 'Pushed {{count}} orders +1h',
    'toast.pushed_orders_skipped': 'Pushed {{count}} orders +1h; {{skipped}} stayed in place',
    'undo.push_orders_1h': 'Push {{count}} orders +1h',
  } };
  Store.setMasterData({ ...priorMaster, plants: [{ plant: 'P34-P', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] }, 'test');
  Store.serverOffsetMs = new Date(2026, 7, 3, 6, 0).getTime() - Date.now();
  const mk = (id, h1, h2) => ({ id, PLANT: 'P34-P', MACHINE: 'P34-L', RUN_TIME: h2 - h1,
    user_scheduled: true, start_date: new Date(2026, 7, 3, h1), end_date: new Date(2026, 7, 3, h2) });
  try {
    Store.setTasks([mk('mv', 10, 11), mk('fz1', 12, 13), mk('fz2', 14, 15), mk('fz3', 16, 17)], 'test');
    Store.setSelectedPlant('P34-P', 'test');
    Store.setFirmed(['fz1', 'fz2', 'fz3'], true, 'test');
    Selection.set(['mv', 'fz1', 'fz2', 'fz3']);
    const depth = UndoStack._entries.length;
    CommandPalette._buildSelectionCommands().find(c => /push/i.test(c.label)).run();
    assert.equal(shown.length, 1);
    assert.equal(shown[0].msg, 'Pushed 1 orders +1h; 3 stayed in place', 'one moved, the three firmed ones are counted as skipped');
    assert.equal(UndoStack._entries.length, depth + 1);
    assert.equal(UndoStack._entries.at(-1).label, 'Push 1 orders +1h', 'the undo label uses the moved count, not the 4 selected');
    // Nothing skipped: the plain toast.
    shown.length = 0;
    Selection.set(['mv']);
    CommandPalette._buildSelectionCommands().find(c => /push/i.test(c.label)).run();
    assert.equal(shown[0].msg, 'Pushed 1 orders +1h');
  } finally {
    Selection.clear();
    Toast.show = priorShow;
    UndoStack._entries.length = 0;
    for (const e of priorEntries) UndoStack._entries.push(e);
    Alerts.scheduleRecompute = priorSchedule;
    Store.setMasterData(priorMaster, 'test');
    Store.serverOffsetMs = priorOffset;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    globalThis.NIMBUS = priorNimbus;
  }
});
