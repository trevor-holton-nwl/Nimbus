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

test('the production Confidence path scores from alerts alone: it never requests a utilization matrix', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAvailable = Compute.available;
  const priorUtilization = Compute.utilization;
  const priorNimbus = globalThis.NIMBUS;
  let utilizationCalls = 0;
  globalThis.NIMBUS = nimbus;

  try {
    Confidence._invalidatePending(true);
    Confidence.restore({ score: 88, history: [{ ts: 1, score: 88 }] });
    Store.setTasks([{ id: 'confidence-pending', PLANT: 'CONF-P', MACHINE: 'CONF-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('CONF-P', 'test');
    Compute.available = () => true;
    Compute.utilization = () => { utilizationCalls++; return new Promise(() => {}); };
    Confidence._lastAlertsSrc = null; Confidence._lastRev = null;
    await Confidence._recompute();
    assert.equal(utilizationCalls, 0, 'an overloaded day is an overload alert already: no matrix is needed for the score');
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
    Store.setTasks([mk('normal', 10, 11), mk('firmed', 12, 13), mk('running', 5, 7), mk('frozen', 7, 8), mk('late', 18, 19)], 'test');
    Store.setSelectedPlant('PUSH-P', 'test');
    Store.setFirmed(['firmed'], true, 'test');
    Selection.set(['normal', 'firmed', 'running', 'frozen', 'late']);
    const cmd = CommandPalette._buildSelectionCommands().find(c => /push/i.test(c.label));
    cmd.run();
    const at = id => [Store.tasks[id].start_date.getHours(), Store.tasks[id].end_date.getHours()];
    assert.deepEqual(at('normal'), [11, 12], 'finish +1 h, start re-derived from the run time');
    assert.deepEqual(at('firmed'), [12, 13], 'a firmed order is skipped');
    assert.deepEqual(at('running'), [5, 7], 'a running order is skipped');
    assert.deepEqual(at('frozen'), [7, 8], 'a frozen order (finish inside [now, 09:00)) is skipped');
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
    Alerts._allAlerts = null;   // score the Store list directly (a recompute would otherwise have filled the pre-dismiss list)
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
  // Two stores like the real database: `snapshots` (autoIncrement id, full records) and `snapshot_meta` (keyed by id)
  // with its `ts` and compound `plant_ts` indexes. Callbacks fire on the microtask queue.
  const rows = [];   // snapshots
  const meta = [];   // snapshot_meta
  let nextId = 1;
  const inRange = (r, range) => !range || (r.plant === range.lower[0] && r.ts >= range.lower[1] && r.ts <= range.upper[1]);
  const tx = () => {
    const t = { oncomplete: null, onerror: null };
    t.objectStore = name => {
      const list = name === 'snapshots' ? rows : meta;
      return {
        put(v) {
          const req = { result: undefined };
          const id = v.id ?? nextId++;
          req.result = id;
          const i = list.findIndex(r => r.id === id);
          if (i >= 0) list[i] = { ...v, id }; else list.push({ ...v, id });
          queueMicrotask(() => { req.onsuccess && req.onsuccess({}); queueMicrotask(() => t.oncomplete && t.oncomplete({})); });
          return req;
        },
        get(key) { const req = { result: list.find(r => r.id === key) }; queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req })); return req; },
        count() { const req = { result: list.length }; queueMicrotask(() => req.onsuccess && req.onsuccess({})); return req; },
        delete(key) { const i = list.findIndex(r => r.id === key); if (i >= 0) list.splice(i, 1); },
        index() {
          return {
            count(range) { const req = { result: list.filter(r => inRange(r, range)).length }; queueMicrotask(() => req.onsuccess && req.onsuccess({})); return req; },
            openKeyCursor(range) {
              const sorted = list.filter(r => inRange(r, range)).sort((a, b) => a.ts - b.ts);
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
    };
    return t;
  };
  return { rows, meta, transaction: () => tx() };
}
// The VM realm has no IDBKeyRange: the fake reads `lower`/`upper` back from this stand-in.
context.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };

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
  for (let i = 1; i <= 8; i += 1) { fake.rows.push({ id: i, ts: i * 10, plant: 'A' }); fake.meta.push({ id: i, ts: i * 10, plant: 'A' }); }
  db._db = fake;
  context.window.requestIdleCallback = fn => fn();
  try {
    db.pruneSnapshots(5);
    await settle();
    assert.deepEqual(fake.rows.map(r => r.id).sort((a, b) => a - b), [4, 5, 6, 7, 8], 'the 3 oldest are gone');
    assert.deepEqual(fake.meta.map(r => r.id).sort((a, b) => a - b), [4, 5, 6, 7, 8], 'their metadata rows go with them');
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
  // Freeze All is scoped to the SELECTED plant (universal firm, C-2), so the fixtures' plant is selected.
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant('CMD-P', 'test');
  // The harness has no locale files: the undo labels are translated now (keys), so give it the English texts it asserts on.
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { [nimbus.Util.locale()]: {
    'undo.firm_orders': 'Firm {{count}} orders', 'undo.firm_orders_one': 'Firm {{count}} order',
    'undo.unfirm_orders': 'Unfirm {{count}} orders', 'undo.unfirm_orders_one': 'Unfirm {{count}} order',
    'undo.firm_all_freeze': 'Firm All (freeze)',
  } };
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
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setSelectedPlant(priorPlant, 'test');
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
    nimbus.Selection = { ids: () => ['c1', 'c2', 'c3', 'ghost'] };

    const cmd = CommandPalette._buildSelectionCommands().find(c => c.type === 'selection');
    assert.ok(cmd, 'a firm command is offered when any selected order can still be firmed');
    cmd.run();

    // Universal firm (C10): the command goes through Engine.firmPlan/applyFirm, so c1 (already planner-firmed,
    // an Unfirm candidate) and the unknown id are not part of the Firm write or the undo scope.
    assert.deepEqual(brief(setFirmedCalls), [{ ids: ['c2', 'c3'], firmed: true, source: 'cmd-palette' }]);
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].label, 'Firm 2 orders', 'label carries the count of orders actually firmed');
    assert.deepEqual(pushCalls[0].ids, ['c2', 'c3']);
    assert.ok(['c1', 'c2', 'c3'].every(id => Store.isFirmed(id)));
    assert.equal(Store.isFirmed('c4'), false, 'unselected order untouched');

    setFirmedCalls.length = 0;
    UndoStack.pop();
    assert.equal(Store.isFirmed('c1'), true, 'c1 was firmed before, so it stays firmed after undo');
    assert.equal(Store.isFirmed('c2'), false, 'c2 returns to unfirmed');
    assert.equal(Store.isFirmed('c3'), false, 'c3 returns to unfirmed');
    assert.deepEqual(brief(setFirmedCalls), [
      { ids: ['c2', 'c3'], firmed: false, source: 'undo' },
    ]);
  });
});

test('palette Unfirm N orders (all selected firmed) unfirms them and undo re-firms them', async () => {
  await withPaletteHarness(({ CommandPalette, UndoStack, setFirmedCalls, pushCalls }) => {
    Store.setTasks([mkTask('u1'), mkTask('u2')], 'test');
    Store.setFirmed(['u1', 'u2'], true, 'test');
    setFirmedCalls.length = 0;
    nimbus.Selection = { ids: () => ['u1', 'u2'] };

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
  const prior = { putSnapshot: db.putSnapshot, getNewest: db.getNewest, pruneSnapshots: db.pruneSnapshots, snaps: TimeMachine._snapshots, subscribe: Store.subscribe };
  const log = { getNewest: [], prune: [], put: [] };
  db.putSnapshot = snap => { log.put.push(snap); return Promise.resolve(log.put.length); };
  db.pruneSnapshots = (...args) => { log.prune.push(args); };
  Store.subscribe = () => () => {};   // init() must not leave live auto-snapshot subscriptions behind
  try {
    await body({ TimeMachine, db, log });
  } finally {
    Object.assign(db, { putSnapshot: prior.putSnapshot, getNewest: prior.getNewest, pruneSnapshots: prior.pruneSnapshots });
    Store.subscribe = prior.subscribe;
    TimeMachine._snapshots = prior.snaps;
  }
}

test('TimeMachine.init loads snapshot METADATA (never a body), oldest-first', async () => {
  await withTimeMachineHarness(async ({ TimeMachine, db, log }) => {
    db.getNewest = (store, index, n) => {
      log.getNewest.push([store, index, n]);
      return Promise.resolve([{ ts: 30 }, { ts: 10 }, { ts: 20 }]);
    };
    TimeMachine.init();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(log.getNewest, [['snapshot_meta', 'ts', 10000]], 'loads the small metadata store by ts, not the full-record store');
    assert.deepEqual(TimeMachine._snapshots.map(s => s.ts), [10, 20, 30], 'sorted oldest-first');
  });
});

test('TimeMachine.snapshot prunes IndexedDB to 200 and trims the in-memory history to the 200 newest', async () => {
  await withTimeMachineHarness(async ({ TimeMachine, log }) => {
    TimeMachine._snapshots = Array.from({ length: 200 }, (_, i) => ({ ts: i, label: `old${i}` }));
    const snap = TimeMachine.snapshot('newest');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(log.put.length, 1);
    assert.deepEqual(log.prune, [[200, null]], 'IntelDB.pruneSnapshots is called with the 200 cap for the snapshot plant');
    assert.equal(TimeMachine._snapshots.length, 200, 'history stays capped at 200');
    assert.equal(TimeMachine._snapshots[199].ts, snap.ts, 'newest is kept');
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
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  const reconciled = [];
  globalThis.NIMBUS = nimbus;
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};
  globalThis.window.__NIMBUS_LOCALES = { [nimbus.Util.locale()]: { 'undo.before_time_machine_restore': 'Before Time Machine restore' } };
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
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
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
test('I13: the peak-briefing matrix read starts on the plant clock, not the viewer clock', async () => {
  const { NeedsEngine, Util } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorNimbus = globalThis.NIMBUS;
  globalThis.NIMBUS = nimbus;
  // The plant is a day ahead of the viewer: its wall clock reads Thu 15 Oct 00:30 whatever the machine clock says.
  Util.setPlantClockResolver(plant => (plant === 'I13-P' ? new Date(2026, 9, 15, 0, 30) : null));
  try {
    Confidence._invalidatePending(true);
    Store.setTasks([{ id: 'i13-1', PLANT: 'I13-P', MACHINE: 'I13-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('I13-P', 'test');
    nimbus.Utilization._cacheClear();
    NeedsEngine._readState();   // sync computeMatrix on the plant clock: no worker post of its own any more
    const plantToday = new Date(2026, 9, 15).getTime();
    // NeedsEngine's 7-day read runs on the plant clock and fills the shared cache entry the Dashboard reads
    assert.ok(nimbus.Utilization._cacheEntries().some(e => e.startMs === plantToday && e.days >= 7),
      'a cache entry starting at the plant today exists after NeedsEngine._readState()');
  } finally {
    Confidence._invalidatePending(true);
    Util.setPlantClockResolver((plant, line) => Store.plantNow(plant || (line ? Store.getPlantForLine(line) : null)));
    nimbus.Utilization._cacheClear();
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

// ---- Workload relief 6c: the shared utilization cache must never hold raw worker task ids ------------------------
test('6c: after a worker-filled computeMatrixAsync a later computeMatrix returns rows whose tasks are task objects, not ids', async () => {
  const { Util } = nimbus;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAvailable = Compute.available;
  const priorUtilization = Compute.utilization;
  const priorNimbus = globalThis.NIMBUS;
  globalThis.NIMBUS = nimbus;
  Compute.available = () => true;
  // The worker contract: row.tasks are ids.
  Compute.utilization = (startMs, days) => {
    const rows = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(startMs); d.setDate(d.getDate() + i);
      rows[Util.dayKey(d)] = { date: d, scheduled: 1, capacity: 8, effectiveCapacity: 8, pct: 0.125, tasks: ['6c-1'] };
    }
    return Promise.resolve({ matrix: { '6C-L': rows } });
  };
  try {
    Confidence._invalidatePending(true);
    Store.setTasks([{ id: '6c-1', PLANT: '6C-P', MACHINE: '6C-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('6C-P', 'test');
    nimbus.Utilization._cacheClear();
    await nimbus.Utilization.computeMatrixAsync(Util.plantToday('6C-P'), 14, { syncFallback: false });
    const entry = nimbus.Utilization._cacheEntries().find(e => e.plant === '6C-P');
    assert.ok(entry, 'the worker reply filled the shared cache');
    const today = Util.plantToday('6C-P');
    const rows = nimbus.Utilization.computeMatrix(today, entry.days)['6C-L'];
    for (const row of Object.values(rows)) {
      assert.equal(row.tasks.length, 1);
      assert.equal(typeof row.tasks[0], 'object', 'a task object, not the worker id');
      assert.equal(row.tasks[0].id, '6c-1');
    }
  } finally {
    Confidence._invalidatePending(true);
    nimbus.Utilization._cacheClear();
    Compute.available = priorAvailable;
    Compute.utilization = priorUtilization;
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('palette freeze scope excludes other plants and reports how many orders were skipped as locked', async () => {
  await withPaletteHarness(async ({ setFirmedCalls }) => {
    Store.setTasks([mkTask('s1'), { ...mkTask('other1'), PLANT: 'OTHER-P', MACHINE: 'OTHER-L' }, { ...mkTask('noplant'), PLANT: undefined, MACHINE: 'OTHER-L' }], 'test');
    setFirmedCalls.length = 0;
    const toasts = [];
    const priorShow = nimbus.Toast.show;
    nimbus.Toast.show = (m) => toasts.push(m);
    const priorPlan = nimbus.Engine.firmPlan;
    nimbus.Engine.firmPlan = function (ids) {
      const plan = priorPlan.call(this, ids);
      return { ...plan, locked: ['L1', 'L2'] };
    };
    const priorConfirm = context.window.confirm;
    context.window.confirm = () => true;
    try { nimbus.NeedsEngine.resolveIntent('freeze').find(r => r.type === 'intent').run(); }
    finally { context.window.confirm = priorConfirm; nimbus.Engine.firmPlan = priorPlan; nimbus.Toast.show = priorShow; }
    assert.deepEqual(brief(setFirmedCalls).flatMap(c => c.ids), ['s1'], 'only the selected plant is firmed');
    assert.ok(toasts.some(m => /firm_skipped_locked/.test(m) || /2 skipped/.test(m)), `locked count reported: ${JSON.stringify(toasts)}`);
  });
});

// ---- Confidence curve: dismissed alerts still count -------------------------------------------------------------
test('dismissing an alert hides it from Store.alerts but leaves the Confidence input (and score) unchanged', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorAll = Alerts._allAlerts;
  const priorDismissed = Alerts.snapshotDismissed();
  const priorAvailable = Compute.available;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorNimbus = globalThis.NIMBUS;
  const priorConfidence = Confidence.snapshot();
  globalThis.NIMBUS = nimbus;
  Compute.available = () => false;
  Alerts.scheduleRecompute = () => {};
  const soon = d => new Date(Date.now() + d * 86400000);
  const fresh = [
    { id: 'dm-1', type: 'overlap', sev: 'err', line: 'DM-L', taskId: 'dm-1', time: soon(2) },
    { id: 'dm-2', type: 'overlap', sev: 'err', line: 'DM-L', taskId: 'dm-2', time: soon(3) },
  ];
  try {
    Confidence._invalidatePending(true);
    Alerts.restoreDismissed([]);
    Store.setTasks([{ id: 'dm-1', PLANT: 'DM', MACHINE: 'DM-L', RUN_TIME: 1 }], 'test');
    Store.setSelectedPlant('DM', 'test');
    Alerts._publish(fresh, null);
    const scoreNow = async () => { Confidence._lastAlertsSrc = null; Confidence._lastRev = null; await Confidence._recompute(); return Confidence.snapshot().score; };
    const before = await scoreNow();
    assert.ok(before < 100);
    const listBefore = Alerts.scoringAlerts();

    Alerts.dismiss('dm-1');
    assert.deepEqual(Store.alerts.map(a => a.id), ['dm-2'], 'the bell/drawer list loses the dismissed alert');
    assert.deepEqual(Alerts.scoringAlerts().map(a => a.id), ['dm-1', 'dm-2'], 'the scoring list keeps it');
    assert.equal(Alerts.scoringAlerts(), listBefore);
    assert.equal(await scoreNow(), before, 'Confidence is unchanged by a dismissal');

    // an incremental publish on the same line keeps the dismissal hidden but still scored
    Alerts._publish([fresh[0], fresh[1]], new Set(['DM-L']));
    assert.deepEqual(Store.alerts.map(a => a.id), ['dm-2']);
    assert.equal(await scoreNow(), before);

    Alerts.dismissAll();
    assert.equal(Store.alerts.length, 0);
    assert.equal(await scoreNow(), before, 'Dismiss all leaves the score alone');
  } finally {
    Confidence._invalidatePending(true);
    Confidence.restore(priorConfidence);
    Alerts.restoreDismissed(priorDismissed);
    Alerts._allAlerts = priorAll;
    Alerts.scheduleRecompute = priorSchedule;
    Compute.available = priorAvailable;
    Store.setAlerts(priorAlerts, 'test');
    Store.setTasks(priorTasks, 'test');
    Store.setSelectedPlant(priorPlant, 'test');
    globalThis.NIMBUS = priorNimbus;
  }
});
