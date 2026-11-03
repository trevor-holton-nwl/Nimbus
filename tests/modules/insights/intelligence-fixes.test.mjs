// Regression tests for the nimbus-intelligence.js review fixes (command palette, Right Now cards, Time Machine,
// Confidence, Ripple, Patterns). The VM harness runs the production classic script with the boot gate closed; each
// test drives the real object and stubs only the browser edges (listeners, dialogs, IndexedDB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
context.addEventListener = () => {};
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const { Store, Toast, Alerts, Utilization, UndoStack, Sandbox } = nimbus;
const { CommandPalette, NeedsEngine, TimeMachine, Confidence, RipplePreview, Patterns } = nimbus;
const settle = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- command palette -------------------------------------------------------------------------------------------

test('resolveIntent: a keyword must start a word ("shipping" is not "pin", "photo" is not "hot", "blocked" is not "lock")', () => {
  const icons = text => Array.from(NeedsEngine.resolveIntent(text), r => r.icon);   // Array.from: the VM realm's arrays differ from this realm's
  assert.deepEqual(icons('shipping'), [], 'pin inside shipping');
  assert.deepEqual(icons('photo'), [], 'hot inside photo');
  assert.deepEqual(icons('blocked'), [], 'lock inside blocked');
  assert.ok(icons('locked').includes('🔒'), 'an inflection of a keyword still matches');
  assert.ok(icons('please freeze everything').includes('🔒'), 'a keyword mid-sentence still matches');
  assert.ok(icons('what changed').includes('⇄'), 'a multi-word keyword still matches');
});

test('_highlight matches the raw text and escapes each piece (no marks inside an entity)', () => {
  const hl = CommandPalette._highlight;
  assert.equal(hl('A & B', 'a'), '<mark>A</mark> &amp; B');
  assert.equal(hl('Fish & Chips', '&'), 'Fish <mark>&amp;</mark> Chips');
  assert.equal(hl('x<y', 'y'), 'x&lt;<mark>y</mark>');
  // fuzzy path: letters are marked one by one, each escaped on its own
  assert.equal(hl('a&b', 'ab'), '<mark>a</mark>&amp;<mark>b</mark>');
  assert.equal(hl('<b>', ''), '&lt;b&gt;');
});

// A fake panel: querySelector hands back one recording element per selector, so _buildPanel's listeners can be fired.
function fakePanelDom() {
  const els = new Map();
  const mk = () => ({
    value: '', listeners: {}, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute() {}, appendChild() {}, focus() {}, remove() {},
    querySelector(sel) { if (!els.has(sel)) els.set(sel, mk()); return els.get(sel); },
    querySelectorAll() { return []; },
    contains() { return false; },
  });
  return { mk, els };
}

test('Enter inside the input debounce searches what is typed before activating (C9)', () => {
  const priorCreate = context.document.createElement;
  const priorState = { panel: CommandPalette._panel, index: CommandPalette._index, results: CommandPalette._results, last: CommandPalette._lastQuery };
  const { mk } = fakePanelDom();
  const ran = [];
  context.document.createElement = () => mk();
  try {
    CommandPalette._buildPanel();
    const input = CommandPalette._panel.querySelector('#ni-cp-input');
    CommandPalette._index = [{ type: 'action', label: 'Freeze plant', sub: '', run() { ran.push('new'); } }];
    CommandPalette._results = [{ type: 'action', label: 'old', run() { ran.push('old'); } }];
    CommandPalette._lastQuery = 'old';
    input.value = 'freeze';
    input.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(ran, ['new'], 'the typed query ran, not the previous results');
    // Nothing typed since the last search: Enter activates the shown result as before.
    ran.length = 0;
    CommandPalette._results = [{ type: 'action', label: 'shown', run() { ran.push('shown'); } }];
    CommandPalette._lastQuery = 'freeze';
    input.value = ' freeze ';
    input.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(ran, ['shown']);
  } finally {
    context.document.createElement = priorCreate;
    Object.assign(CommandPalette, { _panel: priorState.panel, _index: priorState.index, _results: priorState.results, _lastQuery: priorState.last });
  }
});

test('the "need:" and "!" intent prefixes are case-insensitive (NEW3)', () => {
  const prior = { index: CommandPalette._index, results: CommandPalette._results };
  CommandPalette._index = [];
  try {
    CommandPalette._search('NEED: freeze');
    assert.ok(CommandPalette._results.some(r => r.type === 'intent' && r.icon === '🔒'));
    CommandPalette._search('Need:optimize');
    assert.ok(CommandPalette._results.some(r => r.icon === '⚙'));
  } finally { Object.assign(CommandPalette, { _index: prior.index, _results: prior.results }); }
});

test('init: Ctrl/Cmd+K opens with Caps Lock on; a single edit, a removal and a firm change drop the index (C10)', () => {
  const priorCreate = context.document.createElement, priorAdd = context.document.addEventListener;
  const priorSub = Store.subscribe, priorOpen = CommandPalette.open, priorPlant = Store.selectedPlant;
  const { mk } = fakePanelDom();
  const keydown = [], storeHandlers = [];
  let opened = 0;
  context.document.createElement = () => mk();
  context.document.addEventListener = (type, fn) => { if (type === 'keydown') keydown.push(fn); };
  Store.subscribe = fn => { storeHandlers.push(fn); return () => {}; };
  CommandPalette.open = () => { opened++; };
  const priorState = { panel: CommandPalette._panel, index: CommandPalette._index };
  try {
    Store.setSelectedPlant('K-P', 'test');
    CommandPalette.init();
    keydown.at(-1)({ ctrlKey: true, metaKey: false, key: 'K', preventDefault() {} });
    keydown.at(-1)({ ctrlKey: false, metaKey: true, key: 'k', preventDefault() {} });
    assert.equal(opened, 2, 'both K and k open the palette');
    keydown.at(-1)({ ctrlKey: true, key: 'j', preventDefault() {} });
    assert.equal(opened, 2, 'another key does not');
    for (const type of ['task:update', 'task:remove', 'firmed:change', 'tasks:bulk']) {
      CommandPalette._index = [{ type: 'order' }];
      storeHandlers[0]({ type });
      assert.equal(CommandPalette._index, null, `${type} drops the index`);
    }
    CommandPalette._index = [{ type: 'order' }];
    storeHandlers[0]({ type: 'alerts:change' });
    assert.ok(CommandPalette._index, 'an unrelated event keeps it');
  } finally {
    context.document.createElement = priorCreate; context.document.addEventListener = priorAdd;
    Store.subscribe = priorSub; CommandPalette.open = priorOpen;
    Object.assign(CommandPalette, { _panel: priorState.panel, _index: priorState.index });
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('"Jump to first conflict" is one path: it focuses the first error alert, order-less ones included (C12)', () => {
  const priorAlerts = structuredClone(Store.alerts);
  const priorAdapter = nimbus.AlertsUIAdapter.focus, priorShow = Toast.show, priorClose = CommandPalette.close;
  const focused = [], toasts = [];
  nimbus.AlertsUIAdapter.focus = id => focused.push(id);
  Toast.show = msg => toasts.push(msg);
  CommandPalette.close = () => {};
  try {
    Store.setAlerts([
      { id: 'w1', sev: 'warn', time: 1 },
      { id: 'late', sev: 'err', time: 50 },
      { id: 'ovl', sev: 'err', time: 10 },   // an overload alert: no taskId
    ], 'test');
    const intent = NeedsEngine.resolveIntent('conflict').find(r => r.type === 'intent');
    intent.run();
    assert.deepEqual(focused, ['ovl'], 'the intent focuses the earliest error alert');
    // The index action row used to scroll to a taskId only: it now focuses the alert like the others.
    CommandPalette._index = null;
    CommandPalette._buildIndex();
    const action = CommandPalette._index.find(i => i.type === 'action' && i.run && /conflict/i.test(i.label));
    assert.ok(action);
    action.run();
    assert.deepEqual(focused, ['ovl', 'ovl']);
    Store.setAlerts([{ id: 'w1', sev: 'warn', time: 1 }], 'test');
    action.run();
    assert.equal(focused.length, 2, 'nothing to jump to: no focus');
    assert.equal(toasts.length, 1, 'the clean toast is shown instead');
  } finally {
    nimbus.AlertsUIAdapter.focus = priorAdapter; Toast.show = priorShow; CommandPalette.close = priorClose;
    CommandPalette._index = null;
    Store.setAlerts(priorAlerts, 'test');
  }
});

test('the overloaded-line card goes to the overloaded day through the shared line + day navigation (C21a)', () => {
  const priorGoto = nimbus.Timeline.gotoLineDay, priorApp = nimbus.App.gotoGanttTimeline, priorClose = CommandPalette.close;
  const calls = [];
  nimbus.Timeline.gotoLineDay = (line, day) => calls.push([line, day]);
  nimbus.App.gotoGanttTimeline = () => calls.push(['gantt']);
  CommandPalette.close = () => {};
  try {
    NeedsEngine._buildBank();
    const need = NeedsEngine._buildBank().find(n => n.id === 'overload-inspect');
    need.run({ overloadedLine: 'L7', overloadedDay: '2026-11-09' });
    assert.deepEqual(calls, [['gantt'], ['L7', '2026-11-09']]);
  } finally { nimbus.Timeline.gotoLineDay = priorGoto; nimbus.App.gotoGanttTimeline = priorApp; CommandPalette.close = priorClose; }
});

// --- Right Now state ---------------------------------------------------------------------------------------------

function withPlant(plant, tasks, body) {
  const priorTasks = structuredClone(Store.tasksArr), priorPlant = Store.selectedPlant;
  const priorBlocks = Store.blocks.slice(), priorPlantBlocks = Store.plantBlocks.slice();
  Store.setTasks(tasks, 'test');
  Store.setSelectedPlant(plant, 'test');
  try { return body(); } finally {
    Store.replaceBlocks(priorBlocks, 'test'); Store.replacePlantBlocks(priorPlantBlocks, 'test');
    Store.setTasks(priorTasks, 'test'); Store.setSelectedPlant(priorPlant, 'test');
  }
}

test('_readState: a day filled exactly to capacity is not overloaded; the overloaded day is reported (C7)', () => {
  const prior = Utilization.computeMatrix;
  try {
    withPlant('RN-P', [], () => {
      Utilization.computeMatrix = () => ({ L1: { '2026-11-03': { scheduled: 24.04, effectiveCapacity: 24 } } });
      let s = NeedsEngine._readState();
      assert.equal(s.maxUtil, 0, '24.04 h on 24 h is inside the 0.05 h tolerance');
      assert.equal(s.overloadedLine, null);
      Utilization.computeMatrix = () => ({
        L1: { '2026-11-03': { scheduled: 24.04, effectiveCapacity: 24 } },
        L2: { '2026-11-05': { scheduled: 10, effectiveCapacity: 8 }, '2026-11-06': { scheduled: 9, effectiveCapacity: 8 } },
      });
      s = NeedsEngine._readState();
      assert.equal(s.overloadedLine, 'L2');
      assert.equal(s.overloadedDay, '2026-11-05');
      assert.ok(s.maxUtil > 1.2);
    });
  } finally { Utilization.computeMatrix = prior; }
});

test('_readState: a fully buffered day (full capacity > 0, effective 0) is an overload need; a closed day is not (B4)', () => {
  const prior = Utilization.computeMatrix;
  try {
    withPlant('RN-P', [], () => {
      Utilization.computeMatrix = () => ({ L1: { '2026-11-03': { scheduled: 3, effectiveCapacity: 0, capacity: 0 } } });
      let s = NeedsEngine._readState();
      assert.equal(s.overloadedLine, null, 'capacity 0 is a closed day, not a buffered one');
      Utilization.computeMatrix = () => ({ L1: { '2026-11-03': { scheduled: 3, effectiveCapacity: 0, capacity: 8 } } });
      s = NeedsEngine._readState();
      assert.equal(s.overloadedLine, 'L1');
      assert.equal(s.overloadedDay, '2026-11-03');
      assert.ok(Number.isFinite(s.maxUtil) && s.maxUtil >= 1, 'a finite ratio, never Infinity');
    });
  } finally { Utilization.computeMatrix = prior; }
});

test('_readState: an order with a finish and no stored start is not "unscheduled" (C6)', () => {
  const day = Date.now();
  withPlant('RN-P', [
    { id: 'fin', PLANT: 'RN-P', MACHINE: 'L1', end_date: new Date(day + 3600000) },
    { id: 'none', PLANT: 'RN-P', MACHINE: 'L1' },
    { id: 'full', PLANT: 'RN-P', MACHINE: 'L1', start_date: new Date(day), end_date: new Date(day + 3600000) },
  ], () => {
    assert.equal(NeedsEngine._readState().unscheduledCount, 1);
  });
});

test('_readState: blackout risk is per line / plant, counts one in progress, and uses the plant clock (C5)', () => {
  const now = nimbus.Util.plantClock('RN-P').getTime();
  const H = 3600000;
  const order = (id, line) => ({ id, PLANT: 'RN-P', MACHINE: line, start_date: new Date(now + 1 * H), end_date: new Date(now + 3 * H) });
  withPlant('RN-P', [order('a', 'L1'), order('b', 'L2')], () => {
    const risk = () => NeedsEngine._readState().blackoutRisk;
    const lineBlock = (line, s, e, plant = 'RN-P') => ({ id: `${line}${s}`, line, plant, start: new Date(now + s * H), end: new Date(now + e * H), reason: 'x' });
    Store.replaceBlocks([lineBlock('L2', 0.5, 4)], 'test');
    assert.equal(risk(), 1, 'a blackout on L2 puts only the L2 order at risk');
    Store.replaceBlocks([lineBlock('L1', -1, 2)], 'test');
    assert.equal(risk(), 1, 'a blackout already in progress (started an hour ago) still counts');
    Store.replaceBlocks([lineBlock('L1', -3, -1)], 'test');
    assert.equal(risk(), 0, 'one that has ended does not');
    Store.replaceBlocks([lineBlock('L1', 1, 2, 'OTHER-P')], 'test');
    assert.equal(risk(), 0, 'another plant\'s blackout does not');
    Store.replaceBlocks([], 'test');
    Store.replacePlantBlocks([{ id: 'pb', plant: 'RN-P', start: new Date(now + 2 * H), end: new Date(now + 5 * H), reason: 'x' }], 'test');
    assert.equal(risk(), 2, 'a plant blackout covers every line');
    Store.replacePlantBlocks([{ id: 'pb2', plant: 'RN-P', start: new Date(now + 60 * H), end: new Date(now + 70 * H), reason: 'x' }], 'test');
    assert.equal(risk(), 0, 'beyond the 48 h window');
  });
});

// --- Time Machine ------------------------------------------------------------------------------------------------

function withTmDb(body) {
  const db = TimeMachine._IntelDB;
  const prior = { put: db.put, getNewest: db.getNewest, prune: db.pruneSnapshots, snaps: TimeMachine._snapshots, sub: Store.subscribe };
  db.put = () => Promise.resolve(1);
  db.pruneSnapshots = () => {};
  Store.subscribe = () => () => {};
  return Promise.resolve(body(db)).finally(() => {
    Object.assign(db, { put: prior.put, getNewest: prior.getNewest, pruneSnapshots: prior.prune });
    Store.subscribe = prior.sub; TimeMachine._snapshots = prior.snaps;
  });
}

test('the auto-snapshot is dropped when a What-If session is active at fire time (C3)', async () => {
  await withTmDb(async db => {
    db.getNewest = () => Promise.resolve([]);
    const handlers = [];
    Store.subscribe = fn => { handlers.push(fn); return () => {}; };
    const priorSnapshot = TimeMachine.snapshot, priorAuto = TimeMachine._snapshotAuto;
    const taken = [];
    TimeMachine.snapshot = label => { taken.push(label); return {}; };
    try {
      TimeMachine.init();
      TimeMachine._snapshotAuto('while idle');
      Sandbox.active = true;   // entered inside the debounce window
      await wait(1150);
      assert.deepEqual(taken, [], 'no snapshot of the sandbox\'s trial schedule');
      Sandbox.active = false;
      TimeMachine._snapshotAuto('after exit');
      await wait(1150);
      assert.deepEqual(taken, ['after exit']);
    } finally { Sandbox.active = false; TimeMachine.snapshot = priorSnapshot; TimeMachine._snapshotAuto = priorAuto; }
  });
});

test('history load merges with snapshots taken meanwhile and never rejects unhandled (C30)', async () => {
  await withTmDb(async db => {
    let release;
    db.getNewest = () => new Promise(res => { release = res; });
    TimeMachine._snapshots = [];
    TimeMachine.init();
    TimeMachine._snapshots.push({ ts: 50, id: 9, label: 'early' });
    release([{ ts: 10, id: 1 }, { ts: 20, id: 2 }]);
    await settle();
    assert.deepEqual(TimeMachine._snapshots.map(s => s.ts), [10, 20, 50]);

    db.getNewest = () => Promise.reject(new Error('idb gone'));
    TimeMachine._snapshots = [{ ts: 5 }];
    TimeMachine.init();
    await settle();
    assert.deepEqual(TimeMachine._snapshots.map(s => s.ts), [5], 'a failed load keeps what is in memory');
  });
});

test('snapshot rows come from the shared encoder: ms or null dates, machine and production version', async () => {
  await withTmDb(async () => {
    const priorPlant = Store.selectedPlant;
    withPlant('SN-P', [
      { id: 's1', PLANT: 'SN-P', MACHINE: 'M1', PRODUCTION_VERSION: '0002', RUN_TIME: 2, start_date: new Date('2026-09-30T13:00:00'), end_date: new Date('2026-09-30T15:00:00') },
      { id: 's2', PLANT: 'SN-P', MACHINE: 'M2' },
    ], () => {
      const snap = TimeMachine.snapshot('x');
      const byId = Object.fromEntries(Array.from(snap.tasks, r => [r.id, r]));
      assert.equal(byId.s1.start_date, Store.tasks.s1.start_date.getTime());
      assert.equal(byId.s1.end_date, Store.tasks.s1.end_date.getTime());
      assert.equal(typeof byId.s1.end_date, 'number');
      assert.equal(byId.s1.PRODUCTION_VERSION, '0002');
      assert.equal(byId.s2.start_date, null);
      assert.equal(byId.s2.end_date, null);
    });
    assert.equal(Store.selectedPlant, priorPlant);
  });
});

test('IntelDB.put rejects when the transaction aborts; the idle prune survives a closed database (C19)', async () => {
  const db = TimeMachine._IntelDB;
  const prior = db._db, priorRic = context.window.requestIdleCallback;
  try {
    let tx;
    db._db = { transaction() { tx = { objectStore: () => ({ put: () => ({}) }) }; return tx; } };
    const p = db.put('snapshots', { ts: 1 });
    tx.onabort();
    await assert.rejects(p);
    db._db = { transaction() { throw new Error('closed'); } };
    context.window.requestIdleCallback = fn => fn();
    assert.doesNotThrow(() => db.pruneSnapshots(5));
  } finally { db._db = prior; context.window.requestIdleCallback = priorRic; }
});

// Restore puts the MACHINE back (C13). The routing fixture mirrors tests/modules/routing/machine-edit-contract.test.mjs.
const REAL_OFFSET = Store.serverOffsetMs;
function seedRoutingPlant() {
  Store.setMasterData({ plants: [{ plant: 'RP', routing_runtime_enabled: true, split_order_policy: 'partial_allowed', timezone: LOCAL_TZ }], lines: [], materials: [] }, 'test');
  Store.serverOffsetMs = new Date('2026-09-01T00:00:00').getTime() - Date.now();
  Store._blockedPlants.clear();
  Store.setTasks([{ id: 'mv', PLANT: 'RP', MATERIAL_NUMBER: 'MAT', PRODUCTION_ORDER: 'PO-1', PRODUCTION_VERSION: '0001', MACHINE: 'M1',
    'ORDER_QUANTITY_(GMEIN)': 60, RUN_TIME: 3, run_time_source: 'routing', planning_status: 'scheduled',
    start_date: new Date('2026-09-30T13:00:00'), end_date: new Date('2026-09-30T16:00:00') }], 'test');
  Runtime._rateMapPlant = 'RP';
  Runtime._rateMap = { plant: 'RP', generated_at: '', machines: { M1: 'WC1', M2: 'WC2', M3: 'WC1' },
    pv: { 'MAT|0001': { key: 'MAT|N|G|01', valid_from: null, valid_to: null, workcenter: 'WC1' },
          'MAT|0002': { key: 'MAT|N|G|02', valid_from: null, valid_to: null, workcenter: 'WC2' } },
    ops: { 'MAT|N|G|01|WC1': { minutes_per_unit: 3 }, 'MAT|N|G|02|WC2': { minutes_per_unit: 6 } } };
  Store.setSelectedPlant('RP', 'test');
}
const snapRow = over => ({ id: 'mv', PLANT: 'RP', start_date: new Date('2026-09-30T13:00:00').getTime(), end_date: new Date('2026-09-30T16:00:00').getTime(),
  MACHINE: 'M1', PRODUCTION_VERSION: '0001', PRODUCTION_ORDER: 'PO-1', text: '', COLOR: '', FORM_SIZE: '', FIRMED: false, scheduleSegments: null, ...over });

async function restoreWith(plant, rows) {
  const stubs = { show: Toast.show, recompute: Alerts.scheduleRecompute, snaps: TimeMachine._snapshots, entries: UndoStack._entries.slice() };
  const toasts = [];
  const priorT = context.t;
  context.t = (key, vars) => `${key} ${JSON.stringify(vars || {})}`;   // no locale in the harness: keep the key and its variables
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Alerts.scheduleRecompute = () => {};
  TimeMachine._snapshots = [{ ts: 777, plant, label: 'snap', tasks: rows }];
  try { TimeMachine.restore(777); } finally {
    context.t = priorT;
    Toast.show = stubs.show; Alerts.scheduleRecompute = stubs.recompute; TimeMachine._snapshots = stubs.snaps; UndoStack._entries = stubs.entries;
  }
  return toasts;
}

test('Time Machine restore on a routing plant puts the (production version, machine) pair back (C13)', async () => {
  try {
    seedRoutingPlant();
    const toasts = await restoreWith('RP', [snapRow({ MACHINE: 'M2', PRODUCTION_VERSION: '0002' })]);
    const task = Store.tasks.mv;
    assert.equal(task.MACHINE, 'M2');
    assert.equal(task.PRODUCTION_VERSION, '0002', 'the version comes back with the machine');
    assert.equal(task.RUN_TIME, 6, 'the run time follows the restored pair');
    assert.equal(task.end_date.getTime(), new Date('2026-09-30T16:00:00').getTime(), 'the snapshot finish is held');
    assert.ok(!toasts.some(t => t.kind === 'warn'), 'nothing was skipped');
  } finally { Store.serverOffsetMs = REAL_OFFSET; Store.setTasks([], 'test'); }
});

test('Time Machine restore skips and lists an order whose snapshot pair no longer resolves (routing plant, C13)', async () => {
  try {
    seedRoutingPlant();
    // 0001 covers work center WC1 only: M2 (WC2) is no longer eligible for it.
    const toasts = await restoreWith('RP', [snapRow({ MACHINE: 'M2', PRODUCTION_VERSION: '0001' })]);
    const task = Store.tasks.mv;
    assert.equal(task.MACHINE, 'M1', 'the order stays where it is');
    assert.equal(task.RUN_TIME, 3);
    const warn = toasts.find(t => t.kind === 'warn');
    assert.ok(warn, 'a warning toast');
    assert.match(warn.msg, /PO-1/, 'the toast lists the order');
  } finally { Store.serverOffsetMs = REAL_OFFSET; Store.setTasks([], 'test'); }
});

test('Time Machine restore on a non-routing plant writes MACHINE directly and skips a machine that is gone (C13)', async () => {
  const priorPlant = Store.selectedPlant;
  try {
    Store.setMasterData({ plants: [{ plant: 'NP', routing_runtime_enabled: false, split_order_policy: 'partial_allowed', timezone: LOCAL_TZ }],
      lines: [{ machine: 'A', plant: 'NP' }, { machine: 'B', plant: 'NP' }], materials: [] }, 'test');
    Store.serverOffsetMs = new Date('2026-09-01T00:00:00').getTime() - Date.now();
    Store._blockedPlants.clear();
    Store.setTasks([
      { id: 'x', PLANT: 'NP', PRODUCTION_ORDER: 'PO-X', MACHINE: 'B', RUN_TIME: 3, planning_status: 'scheduled',
        start_date: new Date('2026-09-30T13:00:00'), end_date: new Date('2026-09-30T16:00:00') },
      { id: 'y', PLANT: 'NP', PRODUCTION_ORDER: 'PO-Y', MACHINE: 'B', RUN_TIME: 3, planning_status: 'scheduled',
        start_date: new Date('2026-10-01T13:00:00'), end_date: new Date('2026-10-01T16:00:00') },
    ], 'test');
    Store.setSelectedPlant('NP', 'test');
    const toasts = await restoreWith('NP', [
      snapRow({ id: 'x', PLANT: 'NP', MACHINE: 'A', PRODUCTION_VERSION: '' }),
      snapRow({ id: 'y', PLANT: 'NP', MACHINE: 'GONE', PRODUCTION_VERSION: '' }),
    ]);
    assert.equal(Store.tasks.x.MACHINE, 'A', 'moved back to the snapshot machine');
    assert.equal(Store.tasks.y.MACHINE, 'B', 'a machine that no longer exists is not written');
    assert.match(toasts.find(t => t.kind === 'warn').msg, /PO-Y/);
    assert.ok(!/PO-X/.test(toasts.find(t => t.kind === 'warn').msg));
  } finally { Store.serverOffsetMs = REAL_OFFSET; Store.setTasks([], 'test'); Store.setSelectedPlant(priorPlant, 'test'); }
});

// --- Confidence ----------------------------------------------------------------------------------------------------

test('the score-delta chip does not flash for the first score of a plant (C16)', () => {
  const prior = { score: Confidence._score, history: Confidence._history, badge: Confidence._badge };
  const priorCreate = context.document.createElement;
  const flashes = [];
  context.document.createElement = () => ({ className: '', textContent: '', style: {}, remove() {} });
  Confidence._badge = { appendChild: el => flashes.push(el.textContent) };
  try {
    Confidence._history = []; Confidence._score = 100;
    Confidence._apply(40);
    assert.deepEqual(flashes, [], 'first score: no "-60" chip');
    Confidence._apply(80);
    assert.deepEqual(flashes, ['+40'], 'a later swing still flashes');
  } finally {
    context.document.createElement = priorCreate;
    Confidence._score = prior.score; Confidence._history = prior.history; Confidence._badge = prior.badge;
  }
});

test('a second badge click while the breakdown loads, or while it is open, opens no second dialog (C17)', async () => {
  const priorCreate = context.document.createElement, priorQuery = context.document.querySelector;
  const priorMatrix = Utilization.computeMatrixAsync, priorCss = context.getComputedStyle, priorNimbus = globalThis.NIMBUS;
  let dialogs = 0, open = null, release;
  const dlg = { className: '', innerHTML: '', handlers: {}, showModal() {}, close() {}, remove() {}, addEventListener() {}, querySelector() { return null; } };
  context.document.createElement = tag => { if (tag === 'dialog') { dialogs++; open = dlg; return dlg; } return priorCreate.call(context.document, tag); };
  context.document.querySelector = sel => (/ni-breakdown-dlg/.test(sel) ? open : null);
  Utilization.computeMatrixAsync = () => new Promise(res => { release = res; });
  context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.NIMBUS = nimbus;
  try {
    const first = Confidence.showBreakdown();
    const second = Confidence.showBreakdown();   // while the matrix is in flight
    release({});
    await Promise.all([first, second]);
    assert.equal(dialogs, 1, 'one dialog for two clicks');
    await Confidence.showBreakdown();   // while it is open
    assert.equal(dialogs, 1);
    open = null;                         // closed
    const third = Confidence.showBreakdown();
    release({});
    await third;
    assert.equal(dialogs, 2, 'and it opens again after it was closed');
  } finally {
    context.document.createElement = priorCreate; context.document.querySelector = priorQuery;
    Utilization.computeMatrixAsync = priorMatrix; context.getComputedStyle = priorCss; globalThis.NIMBUS = priorNimbus;
  }
});

test('the confidence chart sizes its buffer to the painted rect times the pixel ratio (C15)', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, p) => (p === 'setTransform' ? (...a) => calls.push(a) : () => {}), set: () => true });
  const canvas = {
    width: 760, height: 240, style: {}, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 120 }),
    addEventListener() {}, closest: () => null,
  };
  const priorDpr = context.devicePixelRatio, priorCss = context.getComputedStyle, priorCreate = context.document.createElement;
  context.devicePixelRatio = 2;
  context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  context.document.createElement = () => ({ style: {} });
  context.document.body.appendChild = el => el;
  try {
    Confidence._drawChart(canvas, [{ ts: 1, score: 90 }, { ts: 2, score: 60 }]);
    assert.equal(canvas.width, 1000, '500 css px x dpr 2');
    assert.equal(canvas.height, 240, '120 css px x dpr 2: the buffer keeps the painted aspect ratio');
    assert.deepEqual(calls[0], [2, 0, 0, 2, 0, 0]);
  } finally { context.devicePixelRatio = priorDpr; context.getComputedStyle = priorCss; context.document.createElement = priorCreate; }
});

// --- Ripple preview ------------------------------------------------------------------------------------------------

test('a queued ripple draw is cancelled by Alt key-up, and leaving a bar forgets it (C14)', async () => {
  const priorAdd = context.document.addEventListener, priorGet = context.document.getElementById, priorCreate = context.document.createElement;
  const doc = {}, gantt = { listeners: {}, classList: { add() {}, remove() {} }, addEventListener(t, fn) { this.listeners[t] = fn; } };
  context.document.addEventListener = (type, fn) => { doc[type] = fn; };
  context.document.getElementById = id => (id === 'vis-timeline' ? gantt : null);
  const priorShow = RipplePreview._show;
  const drawn = [];
  const bar = id => ({ target: { closest: () => ({ getAttribute: () => id }) } });
  try {
    RipplePreview.init();
    RipplePreview._show = id => drawn.push(id);
    doc.keydown({ altKey: true });
    gantt.listeners.mouseover(bar('t1'));
    doc.keyup({ altKey: false });   // inside the 80 ms debounce
    await wait(150);
    assert.deepEqual(drawn, [], 'nothing drawn after Alt was released');

    doc.keydown({ altKey: true });
    gantt.listeners.mouseover(bar('t1'));
    assert.equal(RipplePreview._lastId, 't1');
    gantt.listeners.mouseover({ target: { closest: () => null } });
    assert.equal(RipplePreview._lastId, null, 'leaving every bar resets the remembered id');
    await wait(150);
    assert.deepEqual(drawn, [], 'and cancels the queued draw');
    gantt.listeners.mouseover(bar('t1'));
    await wait(150);
    assert.deepEqual(drawn, ['t1'], 'coming back to the same bar draws again');
    doc.keyup({ altKey: false });
  } finally {
    RipplePreview._show = priorShow; RipplePreview._active = false;
    context.document.addEventListener = priorAdd; context.document.getElementById = priorGet; context.document.createElement = priorCreate;
  }
});

test('RipplePreview._show draws nothing when Alt is no longer held (C14)', () => {
  const priorCreate = context.document.createElement;
  let created = 0;
  context.document.createElement = () => { created++; return { style: {} }; };
  RipplePreview._active = false;
  try { RipplePreview._show('anything'); assert.equal(created, 0); } finally { context.document.createElement = priorCreate; }
});

// --- Patterns ------------------------------------------------------------------------------------------------------

test('Patterns keep counts per plant under one key, drop the old flat format, and survive a full store (C21c-d)', () => {
  const ls = context.localStorage;
  const priorGet = ls.getItem, priorSet = ls.setItem, priorSub = Store.subscribe, priorPairs = Patterns._pairs;
  const handlers = [];
  const written = {};
  ls.getItem = k => (k in written ? written[k] : null);
  ls.setItem = (k, v) => { written[k] = v; };
  Store.subscribe = fn => { handlers.push(fn); return () => {}; };
  const mkTasks = plant => [
    { id: `${plant}1`, PLANT: plant, MACHINE: 'L1', COLOR: 'Red', start_date: new Date(1000) },
    { id: `${plant}2`, PLANT: plant, MACHINE: 'L1', COLOR: 'Blue', start_date: new Date(2000) },
  ];
  try {
    written['nimbus.patterns.v1'] = JSON.stringify({ 'red→blue': 3 });   // an older build's flat map
    Patterns.init();
    assert.deepEqual({ ...Patterns._pairs }, {}, 'flat legacy counts are dropped');

    withPlant('PA', mkTasks('PA'), () => {
      handlers.at(-1)({ type: 'plant:selected' });
      Patterns._observe('PA2');
      Patterns._observe('PA2');
    });
    const stored = JSON.parse(written['nimbus.patterns.v1']);
    assert.equal(Object.values(stored.PA)[0], 2, 'two observations under plant PA');
    assert.equal(stored.PB, undefined);

    withPlant('PB', mkTasks('PB'), () => {
      handlers.at(-1)({ type: 'plant:selected' });
      assert.deepEqual({ ...Patterns._pairs }, {}, 'another plant starts clean');
      Patterns._observe('PB2');
    });
    assert.equal(Object.values(JSON.parse(written['nimbus.patterns.v1']).PB)[0], 1);
    assert.equal(Object.values(JSON.parse(written['nimbus.patterns.v1']).PA)[0], 2, 'plant PA is untouched');

    ls.setItem = () => { throw new Error('QuotaExceededError'); };
    withPlant('PA', mkTasks('PA'), () => {
      handlers.at(-1)({ type: 'plant:selected' });
      assert.doesNotThrow(() => Patterns._observe('PA2'));
    });
  } finally {
    ls.getItem = priorGet; ls.setItem = priorSet; Store.subscribe = priorSub; Patterns._pairs = priorPairs;
  }
});
