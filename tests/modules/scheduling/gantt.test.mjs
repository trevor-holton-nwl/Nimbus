// Tests for frontend/scheduling/gantt.mts (Timeline, TimelineNav, DependencyOverlay,
// Hierarchy, GanttFilter, Interaction). Split from
// tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Timeline, TimelineNav, DependencyOverlay, Hierarchy, GanttFilter, Interaction, navComputeRange, navLayout, navBarStyle, navClampRect, computeTimelineMinBound, tickerShouldPush, lockLeftEdge, bulkTouchesExpandedLine, companionWritesDeferred, alertCellMapFor, alertSig, frameMeterSummary, installFrameMeter, visItemEqual, zoneTickerUpdates } from '../../../frontend/scheduling/gantt.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Util, Toast, PerfMonitor } from '../../../frontend/platform/foundation.mjs';
import { Alerts, Utilization } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';

const require = createRequire(import.meta.url);
// Engine.isInProgress/isFrozenHorizon default to Store.plantNow, which projects through the compute core's
// shared zone helper (OQ52); a real page loads the core before any module, so the tests do the same.
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

// A drop holds the FINISH and derives the start from the plant's working time (backward scheduling Task 2.5), which
// needs a plant with a time zone and a pinned server clock (these fixtures are dated in 2026-08/09, long before the
// real clock). The naive instant is read in this machine's zone, which is also the plant's zone below.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REAL_SERVER_OFFSET_MS = Store.serverOffsetMs;
afterEach(() => { Store.serverOffsetMs = REAL_SERVER_OFFSET_MS; Store._blockedPlants.clear(); });
function pinPlantClock(plants, nowNaive = '2026-08-01T00:00:00') {
  const priorOffset = Store.serverOffsetMs;
  const priorMaster = Store.masterData;
  Store.setMasterData({
    ...priorMaster,
    plants: [...(priorMaster?.plants || []).filter(p => !plants.includes(p.plant)), ...plants.map(plant => ({ plant, timezone: LOCAL_TZ }))],
    lines: priorMaster?.lines || [],
  }, 'unit-test');
  Store.serverOffsetMs = new Date(nowNaive).getTime() - Date.now();
  Store._blockedPlants.clear();
  return () => {
    Store.serverOffsetMs = priorOffset;
    Store.setMasterData(priorMaster, 'unit-test');
    Store._blockedPlants.clear();
  };
}

test('hierarchy escapes stored machine and order labels', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const markup = Hierarchy._renderItem({ name: payload, tasks: [{ id: 'safe', ORDER: payload }], color: '#fff', pct: null, sev: '' });
  assert.ok(markup.includes('&lt;img'));
  assert.ok(!markup.includes(payload));
});

// GanttFilter.isolateLine/restoreAllLines call the module's existing
// _refreshLineBtn/_buildLineDropdown DOM helpers, which reference bare
// `document` — same split-realm/no-DOM situation documented in
// tests/modules/schedule-services.test.mjs and schedule-data.test.mjs.
//
// Interaction needs a richer version of the same stub: a fake #vis-timeline
// container (so install()'s container-gated helpers — _installHoverPreview,
// _installMarquee, _installLabelDblclick, and the alertcell-popup delegate —
// run far enough to register every listener uninstall() is responsible for
// removing, instead of bailing out on `if (!container) return;`) plus
// addEventListener/removeEventListener that COUNT calls by event type, so the
// idempotent-install and uninstall tests below can assert real listener
// counts rather than merely "it didn't throw".
const _docListenerCounts = new Map();
function _docListenerCount(type) { return _docListenerCounts.get(type) || 0; }
function _resetDocListenerCounts() { _docListenerCounts.clear(); }

function _makeVisTimelineContainerStub() {
  return {
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}

const _loadingOverlay = (() => {
  const classes = new Set();
  return {
    hidden: true,
    _classes: classes,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
})();

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById(id) {
      if (id === 'vis-timeline') return _makeVisTimelineContainerStub();
      if (id === 'timeline-loading-overlay') return _loadingOverlay;
      return null;
    },
    addEventListener(type) { _docListenerCounts.set(type, _docListenerCount(type) + 1); },
    removeEventListener(type) { _docListenerCounts.set(type, _docListenerCount(type) - 1); },
    createElement() {
      return {
        style: {}, hidden: false, id: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, addEventListener() {}, removeEventListener() {},
        querySelector() { return null; },
      };
    },
    querySelector() { return null; },
    body: { appendChild() {} },
  };
}
globalThis.window = globalThis.window || {};

test('Timeline exposes the documented navigation API', () => {
  assert.equal(typeof Timeline.init, 'function');
  assert.equal(typeof Timeline.rebuild, 'function');
  assert.equal(typeof Timeline.focus, 'function');
  assert.equal(typeof Timeline.gotoLineDay, 'function');
});

test('Timeline._setVScroll/_getVScroll prefer the internal vis-timeline API and fall back to the DOM query', () => {
  const priorTimeline = Timeline._tl;
  const scrollTops = [];
  let internalTop = 0;
  Timeline._tl = {
    _setScrollTop(top) { scrollTops.push(top); internalTop = top; },
    _getScrollTop() { return internalTop; },
  };
  try {
    Timeline._setVScroll(0);
    Timeline._setVScroll(42);
    assert.deepEqual(scrollTops, [0, 42], 'writes route through the internal API when present');
    assert.equal(Timeline._getVScroll(), 42, 'reads route through the internal API when present');
  } finally {
    Timeline._tl = priorTimeline;
  }
});

test('Timeline._vScrollTop starts at 0 (replaces the old one-shot _initialVerticalScrollPending guard)', () => {
  // A3: "start at the top" is now just the field's initial value, honoured
  // on every rebuild() (re-applied after _fitHeight) rather than a guard
  // that only ever fired once.
  assert.equal(typeof Timeline._vScrollTop, 'number');
});

test('Timeline.saveVScroll records scroll position and sets restore flag when laid out', () => {
  const priorTl = Timeline._tl;
  const priorVisEl = Timeline._visEl;
  const priorVScrollTop = Timeline._vScrollTop;
  const priorRestorePending = Timeline._vScrollRestorePending;
  let scrollPos = 42;
  Timeline._tl = {
    _getScrollTop() { return scrollPos; },
    _setScrollTop() {},
  };
  Timeline._visEl = { clientHeight: 800 };
  Timeline._vScrollTop = 0;
  Timeline._vScrollRestorePending = false;
  try {
    Timeline.saveVScroll();
    assert.equal(Timeline._vScrollTop, 42, 'saveVScroll must record _getScrollTop into _vScrollTop');
    assert.equal(Timeline._vScrollRestorePending, true, 'saveVScroll must set _vScrollRestorePending');
  } finally {
    Timeline._tl = priorTl;
    Timeline._visEl = priorVisEl;
    Timeline._vScrollTop = priorVScrollTop;
    Timeline._vScrollRestorePending = priorRestorePending;
  }
});

test('Timeline.saveVScroll sets flag without capturing when not laid out', () => {
  const priorTl = Timeline._tl;
  const priorVisEl = Timeline._visEl;
  const priorVScrollTop = Timeline._vScrollTop;
  const priorRestorePending = Timeline._vScrollRestorePending;
  Timeline._tl = { _getScrollTop() { throw new Error('should not read scroll'); } };
  Timeline._visEl = { clientHeight: 0 };
  Timeline._vScrollTop = 99;
  Timeline._vScrollRestorePending = false;
  try {
    Timeline.saveVScroll();
    assert.equal(Timeline._vScrollTop, 99, 'saveVScroll must leave _vScrollTop untouched when not laid out');
    assert.equal(Timeline._vScrollRestorePending, true, 'saveVScroll must still set flag even when not laid out');
  } finally {
    Timeline._tl = priorTl;
    Timeline._visEl = priorVisEl;
    Timeline._vScrollTop = priorVScrollTop;
    Timeline._vScrollRestorePending = priorRestorePending;
  }
});

test('Timeline.resetVScroll clears to top and sets flag', () => {
  const priorVScrollTop = Timeline._vScrollTop;
  const priorRestorePending = Timeline._vScrollRestorePending;
  Timeline._vScrollTop = 42;
  Timeline._vScrollRestorePending = false;
  try {
    Timeline.resetVScroll();
    assert.equal(Timeline._vScrollTop, 0, 'resetVScroll must set _vScrollTop to 0');
    assert.equal(Timeline._vScrollRestorePending, true, 'resetVScroll must set _vScrollRestorePending');
  } finally {
    Timeline._vScrollTop = priorVScrollTop;
    Timeline._vScrollRestorePending = priorRestorePending;
  }
});

test('Timeline.scrollToLine navigates by negative offset and sets _vScrollTop', () => {
  const priorTl = Timeline._tl;
  const priorVisibleLines = Timeline._visibleLines;
  const priorVScrollTop = Timeline._vScrollTop;
  const setScrollTops = [];
  Timeline._tl = {
    _setScrollTop(top) { setScrollTops.push(top); },
    _getScrollTop() { return 0; },
  };
  Timeline._visibleLines = () => ['L1', 'L2'];
  const priorQuerySelector = globalThis.document.querySelectorAll;
  globalThis.document.querySelectorAll = () => [
    { getBoundingClientRect: () => ({ height: 30 }) },
    { getBoundingClientRect: () => ({ height: 30 }) },
  ];
  try {
    Timeline._vScrollTop = 0;
    const result = Timeline.scrollToLine('L2');
    assert.equal(result, true, 'scrollToLine must return true for a valid line');
    assert.deepEqual(setScrollTops, [-30], 'scrollToLine must pass a negative offset to _setScrollTop');
    assert.equal(Timeline._vScrollTop, -30, 'scrollToLine must set _vScrollTop to the negative offset');

    // Test invalid line
    setScrollTops.length = 0;
    const resultNone = Timeline.scrollToLine('nope');
    assert.equal(resultNone, false, 'scrollToLine must return false for a non-existent line');
    assert.deepEqual(setScrollTops, [], 'scrollToLine must not call _setScrollTop for invalid line');
  } finally {
    Timeline._tl = priorTl;
    Timeline._visibleLines = priorVisibleLines;
    Timeline._vScrollTop = priorVScrollTop;
    delete globalThis.document.querySelectorAll;
    if (priorQuerySelector) globalThis.document.querySelectorAll = priorQuerySelector;
  }
});

test('Timeline loading mask: show sets hidden=false and clears is-hiding; hide adds is-hiding, then after 180ms sets hidden=true and removes is-hiding', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // virtual clock: no wall-clock sleeps
  const priorLoadingMaskTimer = Timeline._loadingMaskTimer;
  const priorLoadingMaskHideTimer = Timeline._loadingMaskHideTimer;
  _loadingOverlay.hidden = true;
  _loadingOverlay._classes.clear();
  try {
    // Show the mask
    Timeline.showLoadingMask();
    assert.equal(_loadingOverlay.hidden, false, 'showLoadingMask must set hidden=false');
    assert.equal(_loadingOverlay._classes.has('is-hiding'), false, 'showLoadingMask must remove is-hiding class');

    // Hide should add is-hiding immediately
    Timeline.hideLoadingMask();
    assert.equal(_loadingOverlay.hidden, false, 'hideLoadingMask must leave hidden=false initially');
    assert.equal(_loadingOverlay._classes.has('is-hiding'), true, 'hideLoadingMask must add is-hiding immediately');

    // Wait for the 180ms timer
    t.mock.timers.tick(220);
    assert.equal(_loadingOverlay.hidden, true, 'after 180ms, hideLoadingMask must set hidden=true');
    assert.equal(_loadingOverlay._classes.has('is-hiding'), false, 'after 180ms, hideLoadingMask must remove is-hiding');

    // Show again should cancel the hide
    Timeline.showLoadingMask();
    Timeline.hideLoadingMask();
    Timeline.showLoadingMask();
    t.mock.timers.tick(220);
    assert.equal(_loadingOverlay.hidden, false, 'a re-show before hide completes must cancel the hide and keep overlay visible');

    // Final hide and wait to ensure no timer leak
    Timeline.hideLoadingMask();
    t.mock.timers.tick(220);
    if (Timeline._loadingMaskTimer !== null) clearTimeout(Timeline._loadingMaskTimer);
    if (Timeline._loadingMaskHideTimer !== null) clearTimeout(Timeline._loadingMaskHideTimer);
  } finally {
    Timeline._loadingMaskTimer = priorLoadingMaskTimer;
    Timeline._loadingMaskHideTimer = priorLoadingMaskHideTimer;
    _loadingOverlay.hidden = true;
    _loadingOverlay._classes.clear();
  }
});

test('Timeline._itemForTask: className reflects firming status (order-firmed for a manually-firmed task, order-standard otherwise)', () => {
  const id = 'firm-class-1';
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFC1', MATERIAL_NUMBER: 'MFC1', MACHINE: 'L1',
    plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');

  const standardItem = Timeline._itemForTask(Store.tasks[id]);
  assert.match(standardItem.className, /\border-standard\b/, 'a task with no firming reason renders as order-standard');
  assert.doesNotMatch(standardItem.className, /\border-firmed\b/);

  Store.setFirmed([id], true, 'test');
  const firmedItem = Timeline._itemForTask(Store.tasks[id]);
  assert.match(firmedItem.className, /\border-firmed\b/, 'a manually-firmed task renders as order-firmed');
  assert.doesNotMatch(firmedItem.className, /\border-standard\b/);
});

function _gotoHarness(t) {
  const task = {
    id: 'goto-flash-1', MACHINE: 'L-GOTO', RUN_TIME: 14, plant: '5512',
    start_date: new Date('2026-08-12T08:00:00'), end_date: new Date('2026-08-13T10:00:00'),
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-12T08:00:00'), endDate: new Date('2026-08-12T20:00:00') },
      { sequence: 2, startDate: new Date('2026-08-13T08:00:00'), endDate: new Date('2026-08-13T10:00:00') },
    ],
  };
  const other = { ...task, id: 'goto-flash-2', scheduleSegments: undefined };
  const rows = new Map();
  const priorItems = Timeline._items;
  Timeline._items = {
    on() {}, get: id => rows.get(id) || null,
    update(arr) { for (const u of [].concat(arr)) rows.set(u.id, { ...(rows.get(u.id) || {}), ...u }); },
  };
  for (const it of Timeline._itemsForTask(task)) rows.set(it.id, it);
  rows.set('alertcell-L-GOTO-2026-08-12', { id: 'alertcell-L-GOTO-2026-08-12', className: 'alertcell-err' });
  Store._state.tasks[task.id] = task;
  Store._state.tasks[other.id] = other;
  t.after(() => {
    delete Store._state.tasks[task.id]; delete Store._state.tasks[other.id];
    Timeline._gotoTarget = null; Timeline._items = priorItems;
  });
  return { task, other, rows };
}

test('Timeline.markGotoTask: goto-target rides _itemForTask/_itemsForTask for every segment and persists (no expiry)', (t) => {
  const { task, other, rows } = _gotoHarness(t);
  assert.ok(Timeline._itemsForTask(task).every(i => !/goto-target/.test(i.className)));
  Timeline.markGotoTask('goto-flash-1');
  const ids = Timeline.itemIdsForTask('goto-flash-1');
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => /\bgoto-target\b/.test(rows.get(id).className)), 'every live segment gets the class');
  // A rebuild builds items fresh; the target state re-applies the class, however long ago it was set.
  assert.ok(Timeline._itemsForTask(task).every(i => /\bgoto-target\b/.test(i.className)));
  assert.doesNotMatch(Timeline._itemForTask(other).className, /goto-target/, 'other orders never get it');
  assert.ok(Timeline._gotoTarget, 'no timer clears it');

  Timeline.clearGotoTarget();
  assert.equal(Timeline._gotoTarget, null);
  assert.ok(ids.every(id => !/goto-target/.test(rows.get(id).className)), 'clear strips the class');
  assert.doesNotMatch(Timeline._itemForTask(task).className, /goto-target/);
});

test('Timeline.markGotoTask: marking B clears A', (t) => {
  const { task, other, rows } = _gotoHarness(t);
  for (const it of Timeline._itemsForTask(other)) rows.set(it.id, it);
  Timeline.markGotoTask(task.id);
  Timeline.markGotoTask(other.id);
  assert.ok(Timeline.itemIdsForTask(task.id).every(id => !/goto-target/.test(rows.get(id).className)));
  assert.ok(Timeline.itemIdsForTask(other.id).every(id => /goto-target/.test(rows.get(id).className)));
});

test('Timeline.markGotoCell: lands on the alertcell item, replaces a task target, and clears cleanly', (t) => {
  const { task, rows } = _gotoHarness(t);
  const cellId = 'alertcell-L-GOTO-2026-08-12';
  Timeline.markGotoTask(task.id);
  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  assert.match(rows.get(cellId).className, /alertcell-err goto-target/);
  assert.ok(Timeline.itemIdsForTask(task.id).every(id => !/goto-target/.test(rows.get(id).className)), 'task ring dropped');
  assert.deepEqual(Timeline._gotoTarget, { kind: 'cell', itemId: cellId });
  Timeline.clearGotoTarget();
  assert.equal(rows.get(cellId).className, 'alertcell-err');
});

test('Go To marker clears on empty-canvas click and Escape even with an empty selection', (t) => {
  _gotoHarness(t);
  Selection.clear();
  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  Interaction._onClick({ what: 'background', item: null, event: {} });
  assert.equal(Timeline._gotoTarget, null, 'empty-canvas click clears a cell target');

  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  Interaction._onKeyDown({ key: 'Escape', target: null, defaultPrevented: false, preventDefault() {} });
  assert.equal(Timeline._gotoTarget, null, 'Escape clears a cell target');

  // A modified click (shift/ctrl) is a selection gesture, not "moving on".
  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  Interaction._onClick({ what: 'background', item: null, event: { shiftKey: true } });
  assert.ok(Timeline._gotoTarget);
});

test('Go To marker follows the selection: cleared when the target leaves it, kept while it stays', (t) => {
  const { task, other } = _gotoHarness(t);
  const priorTl = Timeline._tl;
  Timeline._tl = { on() {}, setSelection() {} };
  Selection.clear();
  Interaction.install();
  t.after(() => { Interaction.uninstall(); Timeline._tl = priorTl; Selection.clear(); });
  Selection.set([task.id]);
  Timeline.markGotoTask(task.id);
  Selection.set([task.id, other.id]);
  assert.ok(Timeline._gotoTarget, 'target still selected, marker stays');
  Selection.set([other.id]);
  assert.equal(Timeline._gotoTarget, null, 'target left the selection');

  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  Selection.clear();
  assert.ok(Timeline._gotoTarget, 'an empty selection does not clear a cell target');
  Selection.set([task.id]);
  assert.equal(Timeline._gotoTarget, null, 'selecting an order moves on from a cell target');
});

test('G5: the live lock-band scan membership includes running orders, not only the frozen horizon', () => {
  const now = new Date('2026-09-09T10:00:00');
  const running = { id: 'lb-run', user_scheduled: true, start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T12:00:00') };
  const future = { id: 'lb-fut', user_scheduled: true, start_date: new Date('2026-09-09T14:00:00'), end_date: new Date('2026-09-09T16:00:00') };
  const priorEnd = Store.frozenHorizonEnd;
  try {
    Store.setFrozenHorizonEnd(null, 'test');
    assert.equal(Timeline._inLockBand(running, now), true, 'a running order is in the band even with no frozen horizon');
    assert.equal(Timeline._inLockBand(future, now), false);
    // Same order one tick earlier (not yet started) is outside, so the scan's diff repaints it at start.
    assert.equal(Timeline._inLockBand(running, new Date('2026-09-09T07:59:00')), false);
  } finally { Store.setFrozenHorizonEnd(priorEnd, 'test'); }
});

test('Timeline.rebuildSetupForLines batches setup additions, updates, and removals for the affected line only', () => {
  // This fails if setup changes route through full Timeline.rebuild(), if the
  // public line-scoped batch seam is removed, or if a stale setup bar survives.
  const priorItems = Timeline._items;
  const priorSetup = Store.setupSnapshot;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const calls = { add: 0, update: 0, remove: 0 };
  const records = new Map([
    ['setup:old', { id: 'setup:old', kind: 'setup', group: 'SETUP-BATCH-LINE', start: new Date(), end: new Date() }],
    ['setup:other', { id: 'setup:other', kind: 'setup', group: 'OTHER-LINE', start: new Date(), end: new Date() }],
  ]);
  Timeline._items = {
    getIds: () => [...records.keys()],
    get: id => records.get(String(id)),
    add: items => { calls.add++; for (const item of items) records.set(item.id, item); },
    update: items => { calls.update++; for (const item of items) records.set(item.id, item); },
    remove: ids => { calls.remove++; for (const id of ids) records.delete(String(id)); },
  };
  Store.setSelectedPlant('SETUP-BATCH-PLANT', 'unit-test');
  Store.replaceSetupSnapshot(null, 'unit-test');
  Store.setTasks([], 'unit-test');
  try {
    Timeline.rebuildSetupForLines(new Set(['SETUP-BATCH-LINE']));
    assert.equal(calls.remove, 1, 'the affected line is removed in one batch');
    assert.equal(calls.add, 0);
    assert.equal(calls.update, 0);
    assert.ok(records.has('setup:other'), 'unaffected-line setup stays untouched');
  } finally {
    Timeline._items = priorItems;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Timeline.finishSetupDrag clears retained setup-item dimming after a cancelled drag', () => {
  // This fails if a normal DataSet update omits style: vis-data retains the
  // drag opacity, leaving a valid setup bar dimmed after cancellation.
  const line = 'SETUP-CANCEL-LINE';
  const plant = 'SETUP-CANCEL-PLANT';
  const setupId = 'setup:SETUP-CANCEL-LINE:cancel-red:cancel-blue';
  const priorItems = Timeline._items;
  const priorCore = globalThis.NimbusComputeCore;
  const priorSetup = Store.setupSnapshot;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const records = new Map([[setupId, {
    id: setupId, kind: 'setup', group: line,
    start: new Date('2026-08-17T09:00:00'), end: new Date('2026-08-17T09:30:00'),
    className: 'setup-item setup-drag-dim', style: 'opacity:0.18;',
  }]]);
  Timeline._items = {
    getIds: () => [...records.keys()], get: id => records.get(String(id)),
    add(items) { for (const item of items) records.set(item.id, item); },
    update(items) { for (const item of items) records.set(item.id, { ...records.get(item.id), ...item }); },
    remove(ids) { for (const id of ids) records.delete(String(id)); },
  };
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
    machine_rows: [], machine_states: [], overrides: [],
  }, 'unit-test');
  Store.setTasks([
    { id: 'cancel-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED', start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') },
    { id: 'cancel-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE', start_date: new Date('2026-08-17T09:30:00'), end_date: new Date('2026-08-17T10:30:00') },
  ], 'unit-test');
  Timeline._dragSetupLines.add(line);
  try {
    Timeline.finishSetupDrag();
    assert.equal(records.get(setupId).style, '', 'the retained item explicitly clears drag style');
    assert.doesNotMatch(records.get(setupId).className, /setup-drag-dim/);
  } finally {
    Timeline._dragSetupLines.clear();
    Timeline._items = priorItems;
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Timeline renders split schedules as multiple parent-mapped timeline items', () => {
  const task = {
    id: 'timeline-split', MACHINE: 'L-SPLIT', RUN_TIME: 14,
    start_date: new Date('2026-08-12T08:00:00'), end_date: new Date('2026-08-13T10:00:00'),
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-12T08:00:00'), endDate: new Date('2026-08-12T20:00:00') },
      { sequence: 2, startDate: new Date('2026-08-13T08:00:00'), endDate: new Date('2026-08-13T10:00:00') },
    ],
  };

  const items = Timeline._itemsForTask(task);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.parentId === task.id));
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[0].start.getTime(), task.scheduleSegments[0].startDate.getTime());
  assert.equal(items[1].end.getTime(), task.scheduleSegments[1].endDate.getTime());
});

test('Timeline derives exact setup bars before successor processing, including the first split segment', () => {
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'ui.setup_detail_title': 'Derived setup detail', 'ui.minutes_value': '{{n}} min' } };
  try {
  const successor = {
    id: 'setup-successor', MACHINE: 'SETUP-L1', RUN_TIME: 3,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T11:00:00'),
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-14T08:00:00'), endDate: new Date('2026-08-14T09:00:00') },
      { sequence: 2, startDate: new Date('2026-08-14T10:00:00'), endDate: new Date('2026-08-14T12:00:00') },
    ],
  };
  const items = Timeline._setupItemsForObservation([successor], {
    intervals: [{ line: 'SETUP-L1', predecessorOrderId: 'setup-predecessor', successorOrderId: 'setup-successor',
      start: new Date('2026-08-14T07:40:00'), end: new Date('2026-08-14T08:00:00'), requiredMinutes: 20, availableMinutes: 20 }],
    diagnostics: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'setup');
  assert.equal(items[0].start.getTime(), new Date('2026-08-14T07:40:00').getTime());
  assert.equal(items[0].end.getTime(), successor.scheduleSegments[0].startDate.getTime());
  assert.equal(items[0].editable, false);
  assert.match(items[0].title, /20 min/);
  } finally { globalThis.window.__NIMBUS_LOCALES = priorLocales; }
});

test('Timeline omits zero setup but renders a leading-edge marker for missing setup detail', () => {
  const successor = { id: 'missing-successor', MACHINE: 'SETUP-L2', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  const zero = Timeline._setupItemsForObservation([successor], {
    intervals: [{ line: 'SETUP-L2', successorOrderId: 'missing-successor', start: new Date('2026-08-14T08:00:00'), end: new Date('2026-08-14T08:00:00'), requiredMinutes: 0, availableMinutes: 0 }], diagnostics: [],
  });
  assert.deepEqual(zero, []);
  const missing = Timeline._setupItemsForObservation([successor], {
    intervals: [], diagnostics: [{ type: 'setup-uncovered', line: 'SETUP-L2', successorOrderId: 'missing-successor', time: successor.start_date }],
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].kind, 'setup');
  assert.match(missing[0].className, /setup-missing/);
  assert.match(missing[0].content, /ui\.setup_missing/);
  assert.match(missing[0].content, /setup-missing-marker/);
  assert.equal(missing[0].end.getTime(), successor.start_date.getTime());
});

test('Timeline gives each setup diagnostic type a distinct marker label and className', () => {
  // Regression target: SETUP_DIAGNOSTIC_PRESENTATION must actually vary the
  // rendered label/className per diagnostic type instead of every type falling
  // back to the same 'ui.setup_missing' text — and the three "state unknown"
  // types (initial/predecessor/successor) must carry the shared
  // 'setup-unrecorded' class the other three types do not.
  const successors = [
    { id: 'diag-initial', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') },
    { id: 'diag-predecessor', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T09:00:00'), end_date: new Date('2026-08-14T10:00:00') },
    { id: 'diag-successor', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T10:00:00'), end_date: new Date('2026-08-14T11:00:00') },
    { id: 'diag-uncovered', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T11:00:00'), end_date: new Date('2026-08-14T12:00:00') },
    { id: 'diag-diverged', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T12:00:00'), end_date: new Date('2026-08-14T13:00:00') },
    { id: 'diag-override', MACHINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T13:00:00'), end_date: new Date('2026-08-14T14:00:00') },
  ];
  const items = Timeline._setupItemsForObservation(successors, {
    intervals: [],
    diagnostics: [
      { type: 'initial-state-unknown', line: 'SETUP-DIAG', successorOrderId: 'diag-initial', time: successors[0].start_date },
      { type: 'predecessor-state-unknown', line: 'SETUP-DIAG', successorOrderId: 'diag-predecessor', predecessorOrderId: 'mid', time: successors[1].start_date },
      { type: 'successor-state-unknown', line: 'SETUP-DIAG', successorOrderId: 'diag-successor', time: successors[2].start_date },
      { type: 'setup-uncovered', line: 'SETUP-DIAG', successorOrderId: 'diag-uncovered', time: successors[3].start_date },
      { type: 'current-state-diverged', line: 'SETUP-DIAG', successorOrderId: 'diag-diverged', time: successors[4].start_date },
      { type: 'override-inactive', line: 'SETUP-DIAG', successorOrderId: 'diag-override', time: successors[5].start_date },
    ],
  });
  assert.equal(items.length, 6);
  const byId = new Map(items.map(item => [item.setup.successorOrderId, item]));

  const unrecordedIds = ['diag-initial', 'diag-predecessor', 'diag-successor'];
  const otherIds = ['diag-uncovered', 'diag-diverged', 'diag-override'];
  for (const id of unrecordedIds) {
    assert.match(byId.get(id).className, /\bsetup-unrecorded\b/, `${id} must carry the shared unrecorded-state class`);
  }
  for (const id of otherIds) {
    assert.doesNotMatch(byId.get(id).className, /\bsetup-unrecorded\b/, `${id} must NOT carry the unrecorded-state class`);
  }

  // Every type's aria-label (embedded in the marker content) must be distinct —
  // no two diagnostic types collapse onto the same presentation text.
  const labels = [...successors.map(s => byId.get(s.id))].map(item => {
    const match = /aria-label="([^"]*)"/.exec(item.content);
    return match ? match[1] : null;
  });
  assert.equal(new Set(labels).size, labels.length, 'each diagnostic type must render a distinct label');
  assert.ok(labels.every(Boolean), 'every marker must carry a non-empty aria-label');
});

// ---------------------------------------------------------------------------
// Workstream B — Task 6 (B3b, 2026-08-21): every setup-missing test above
// feeds Timeline._setupItemsForObservation a HAND-BUILT diagnostics array —
// a synthetic assertion that would pass even if deriveSetupObservation itself
// were broken. This test instead drives the full, real presentation pipeline
// end to end: a genuine Store.setupSnapshot (active, with a matrix that
// covers one transition but genuinely lacks a row for another — the same
// non-synthetic coverage-gap shape as the Task 6 schedule-services.test.mjs
// fixture, kept independent of it here since this file's tests must not
// depend on another test file's run) feeding the REAL
// Timeline._setupObservation -> Timeline._setupItemsForObservation chain, to
// prove the presentation layer still actually consumes a genuine
// deriveSetupObservation() diagnostic after Task 5's rewrite -- not just that
// a hand-built diagnostic object renders correctly in isolation.
// ---------------------------------------------------------------------------

test('Task 6 (B3b): Timeline renders a real setup-missing marker end-to-end from a genuine Store.setupSnapshot coverage gap (not a hand-built diagnostics fixture)', () => {
  const plant = 'B3B-TIMELINE-PLANT';
  const line = 'B3B-TIMELINE-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;

  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    // Covers GREEN -> BLUE (the matrix is genuinely non-empty) but has no row
    // for BLUE -> RED -- a real coverage gap, not Task 5's synthetic stand-in.
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  const blueTask = { id: 'tl-cov-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
    start_date: new Date('2026-08-21T08:00:00'), end_date: new Date('2026-08-21T09:00:00') };
  const redTask = { id: 'tl-cov-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date('2026-08-21T09:00:00'), end_date: new Date('2026-08-21T10:00:00') };
  Store.setTasks([blueTask, redTask], 'unit-test');

  try {
    // The real derivation, not a fixture -- exactly what Timeline.rebuild()
    // and Timeline.rebuildSetupForLines() call internally.
    const observation = Timeline._setupObservation([blueTask, redTask]);
    const uncovered = observation.diagnostics.find(d => d.successorOrderId === 'tl-cov-red');
    assert.ok(uncovered, 'deriveSetupObservation must genuinely report the BLUE -> RED gap, not just an empty diagnostics list');
    assert.equal(uncovered.type, 'setup-uncovered');

    const items = Timeline._setupItemsForObservation([blueTask, redTask], observation);
    const missingItem = items.find(item => item.id === 'setup-missing:B3B-TIMELINE-LINE:tl-cov-red');
    assert.ok(missingItem, 'the setup-missing item must actually be rendered for the affected order -- not silently omitted');
    assert.match(missingItem.className, /\bsetup-missing\b/);
    assert.match(missingItem.content, /setup-missing-marker/, 'the "!" marker glyph must be present, not blanked');
    assert.match(missingItem.content, /aria-label="[^"]+"/, 'the marker must carry a non-empty accessible label, not a bare placeholder');

    // The genuinely covered GREEN -> BLUE transition must NOT also render a
    // missing marker -- proving this isn't a blanket fallback that marks
    // every order, only the one with an actual gap.
    const blueMissingItem = items.find(item => item.id === 'setup-missing:B3B-TIMELINE-LINE:tl-cov-blue');
    assert.equal(blueMissingItem, undefined, 'the covered transition must never render a setup-missing marker of its own');
  } finally {
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Timeline._setupObservation is empty (no setup bars or markers) when the plant has setup_active off, and unchanged when on or unknown', () => {
  const plant = 'SETUP-OFF-PLANT';
  const line = 'SETUP-OFF-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorMaster = Store.masterData;

  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  const blueTask = { id: 'off-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
    start_date: new Date('2026-08-21T08:00:00'), end_date: new Date('2026-08-21T09:00:00') };
  const redTask = { id: 'off-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date('2026-08-21T09:00:00'), end_date: new Date('2026-08-21T10:00:00') };
  Store.setTasks([blueTask, redTask], 'unit-test');
  const withPlantRow = flag => Store.setMasterData({ ...(priorMaster ?? {}), plants: [{ plant, setup_active: flag }] }, 'unit-test');

  try {
    withPlantRow(false);
    const off = Timeline._setupObservation([blueTask, redTask]);
    assert.deepEqual(off, { intervals: [], diagnostics: [] });
    assert.deepEqual(Timeline._setupItemsForObservation([blueTask, redTask], off), []);

    withPlantRow(true);
    const on = Timeline._setupObservation([blueTask, redTask]);
    assert.ok(on.diagnostics.some(d => d.successorOrderId === 'off-red'), 'setup-on plant still derives the gap');
    assert.ok(Timeline._setupItemsForObservation([blueTask, redTask], on).some(item => item.className.includes('setup-missing')));

    Store.setMasterData({ ...(priorMaster ?? {}), plants: [] }, 'unit-test');
    assert.ok(Timeline._setupObservation([blueTask, redTask]).diagnostics.length > 0, 'a plant with no master row behaves as active');
  } finally {
    globalThis.NimbusComputeCore = priorCore;
    Store.setMasterData(priorMaster, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('missing setup marker is pinned to the center of a narrow setup bar', () => {
  // Regression target: vis-timeline could reflow the warning marker to an
  // edge of a narrow bar, where it looked misplaced or overflowed. Centring
  // moved from the marker itself (absolute + translate(-50%,-50%)) to a flex
  // rule on its containing `.vis-item-content`, so the marker no longer needs
  // (or has) explicit positioning of its own.
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.vis-item\.setup-item\.setup-missing\s*\{[^}]*overflow:\s*hidden/s,
    'the setup-missing bar itself still clips overflow');
  assert.match(css, /\.vis-item\.setup-item\.setup-missing \.vis-item-content\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*\}/s,
    'the setup-missing item content must flex-center its children');
  assert.match(css, /\.setup-missing-marker\s*\{[^}]*position:\s*static[^}]*transform:\s*none/s,
    'the marker itself must no longer carry its own absolute/translate centring');
  const locale = readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8');
  assert.match(locale, /'ui\.setup_missing':\s*'Missing setup matrix data'/);
});

test('Timeline preserves the full required setup duration when capacity conflicts', () => {
  const successor = { id: 'conflict-successor', MACHINE: 'SETUP-L3', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  const [item] = Timeline._setupItemsForObservation([successor], {
    intervals: [{ line: 'SETUP-L3', successorOrderId: 'conflict-successor', start: new Date('2026-08-14T07:20:00'), end: successor.start_date,
      requiredMinutes: 40, availableMinutes: 10 }], diagnostics: [],
  });
  assert.equal(item.end.getTime() - item.start.getTime(), 40 * 60 * 1000);
  assert.match(item.className, /setup-conflict/);
});

test('setup timeline items never resolve to a business order across interaction guards', () => {
  const setupItem = { id: 'setup:SETUP-L1:successor', kind: 'setup', group: 'SETUP-L1', start: new Date(), end: new Date(), editable: false };
  const priorItems = Timeline._items;
  try {
    Timeline._items = { get: id => String(id) === setupItem.id ? setupItem : null };
    assert.equal(Timeline.businessOrderIdForItem(setupItem.id), null);
    assert.equal(Interaction._businessOrderIdForItem(setupItem.id), null);
  } finally { Timeline._items = priorItems; }
});

test('setup items are ignored by click, double-click, drag, ghost, selection, focus, dependency, hover, marquee, and context dispatch', () => {
  const setupId = 'setup:SETUP-L1:successor';
  const setupItem = { id: setupId, kind: 'setup', group: 'SETUP-L1', start: new Date('2026-08-14T07:30:00'), end: new Date('2026-08-14T08:00:00'), editable: false };
  const order = { id: 'guard-order', MACHINE: 'SETUP-L1', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  const priorItems = Timeline._items;
  const priorTl = Timeline._tl;
  try {
    Store.setTasks([order], 'unit-test');
    Selection.clear();
    Timeline._items = { get: id => String(id) === setupId ? setupItem : null };
    Timeline._tl = { focus() { throw new Error('setup must not focus'); } };
    Interaction._onClick({ what: 'item', item: setupId, event: {} });
    Interaction._onDoubleClick({ what: 'item', item: setupId });
    Interaction._onDataSetUpdate({ items: [setupId] });
    Interaction._onTimeChange({ id: setupId, time: new Date() });
    assert.deepEqual(Selection.ids(), []);
    assert.equal(Interaction._ghostDragId, null);
    assert.equal(Timeline.businessOrderIdForItem(setupId), null, 'shared semantic dispatch gates hover, marquee, context, focus, and dependency routes');
  } finally {
    Timeline._items = priorItems;
    Timeline._tl = priorTl;
    Store.setTasks([], 'unit-test');
    Selection.clear();
  }
});
test('alert-cell foreground dispatch treats setup items as non-business items', () => {
  const setupId = 'setup:SETUP-L5:successor';
  const priorItems = Timeline._items;
  try {
    Timeline._items = { get: id => String(id) === setupId
      ? { id: setupId, kind: 'setup', group: 'SETUP-L5', start: new Date(), end: new Date(), editable: false }
      : null };
    assert.equal(Interaction._isBusinessTimelineItem(setupId), false);
  } finally { Timeline._items = priorItems; }
});

test('delegated alert-cell click opens a real alert cell but leaves setup items inert', () => {
  const priorItems = Timeline._items;
  const priorNimbus = globalThis.NIMBUS;
  const opened = [];
  const setupId = 'setup:SETUP-L6:successor';
  const alertId = 'alertcell-SETUP-L6-2026-08-14';
  try {
    globalThis.NIMBUS = { AlertsUIAdapter: { showForCell(line, day) { opened.push([line, day]); } } };
    Timeline._items = { get: id => {
      if (String(id) === setupId) return { id: setupId, kind: 'setup', group: 'SETUP-L6', start: new Date(), end: new Date(), editable: false };
      if (String(id) === alertId) return { id: alertId, group: 'SETUP-L6', start: new Date(), end: new Date(), className: 'alertcell-err', editable: false };
      return null;
    } };
    const time = new Date('2026-08-14T08:00:00');
    Interaction._onAlertCellClick({ item: alertId, group: 'SETUP-L6', time });
    Interaction._onAlertCellClick({ item: setupId, group: 'SETUP-L6', time });
    assert.deepEqual(opened, [['SETUP-L6', '2026-08-14']]);
  } finally {
    Timeline._items = priorItems;
    globalThis.NIMBUS = priorNimbus;
  }
});

test('TimelineNav exposes init/render', () => {
  assert.equal(typeof TimelineNav.init, 'function');
  assert.equal(typeof TimelineNav.render, 'function');
});

// Helper for local-time test inputs: month is 0-based (0=January)
const L = (y, m, d, h = 0, mi = 0) => new Date(y, m, d, h, mi).getTime();

test('navComputeRange: no data → today-1d … today+14d, all local midnights', () => {
  const now = L(2026, 8, 8, 10, 30); // Sep 8 2026 10:30 local
  const windowStart = L(2026, 8, 10);
  const windowEnd = L(2026, 8, 17);
  const result = navComputeRange({
    dataMinMs: null,
    dataMaxMs: null,
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    nowMs: now,
    horizonEndMs: null,
  });

  assert.equal(result.startMs, L(2026, 8, 7), 'startMs should be Sep 7 (today-1d, ceiled to midnight)');
  assert.equal(result.endMs, L(2026, 8, 22), 'endMs should be Sep 22 (today+14d, ceiled to next midnight)');
  assert.equal(result.dayStarts.length, 15, 'should have 15 day entries');
  assert.equal(result.dayStarts[0], result.startMs, 'first dayStart should equal startMs');

  for (const dayStart of result.dayStarts) {
    const d = new Date(dayStart);
    assert.equal(d.getHours(), 0, `dayStart ${dayStart} must have hour 0`);
    assert.equal(d.getMinutes(), 0, `dayStart ${dayStart} must have minute 0`);
  }
});

test('navComputeRange: data widens both edges', () => {
  const now = L(2026, 8, 8, 10, 30); // Sep 8 2026 10:30 local
  const windowStart = L(2026, 8, 10);
  const windowEnd = L(2026, 8, 17);
  const dataMinMs = L(2026, 8, 1, 12); // Aug 1 12:00
  const dataMaxMs = L(2026, 9, 10, 15); // Oct 10 15:00

  const result = navComputeRange({
    dataMinMs,
    dataMaxMs,
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    nowMs: now,
    horizonEndMs: null,
  });

  assert.equal(result.startMs, L(2026, 7, 31), 'startMs should be Aug 31 (dataMin ceiled to prev midnight, then -1d)');
  assert.equal(result.endMs, L(2026, 9, 11), 'endMs should be Oct 11 00:00 (dataMax ceiled to next midnight)');
});

test('navComputeRange: horizon caps the right edge but never below the window end', () => {
  const now = L(2026, 8, 8, 10, 30); // Sep 8 2026 10:30 local
  const horizonEndMs = L(2026, 8, 15); // Sep 15

  // First case: window end is before horizon — result should be horizon
  const result1 = navComputeRange({
    dataMinMs: null,
    dataMaxMs: null,
    windowStartMs: L(2026, 8, 10),
    windowEndMs: L(2026, 8, 17),
    nowMs: now,
    horizonEndMs,
  });
  assert.equal(result1.endMs, L(2026, 8, 17), 'endMs should be window end (Sep 17) because horizon (Sep 15) would be below window end');

  // Second case: window end is after horizon — result should be capped at horizon
  const result2 = navComputeRange({
    dataMinMs: null,
    dataMaxMs: null,
    windowStartMs: L(2026, 8, 10),
    windowEndMs: L(2026, 8, 12),
    nowMs: now,
    horizonEndMs,
  });
  assert.equal(result2.endMs, L(2026, 8, 15), 'endMs should be horizon (Sep 15) when horizon > window end');
});

test('computeTimelineMinBound: oldest order in the past → local midnight of that day', () => {
  const nowMs = L(2026, 3, 15) + 10 * 3600 * 1000; // Apr 15 2026 10:00 local
  const dataMinMs = L(2026, 3, 1, 6); // Apr 1 2026 06:00 local (two weeks before "today")
  const result = computeTimelineMinBound({ dataMinMs, nowMs });
  assert.equal(result, L(2026, 3, 1), 'should be local midnight of the oldest order\'s day');
});

test('computeTimelineMinBound: no orders, or oldest order in the future → today\'s local midnight', () => {
  const nowMs = L(2026, 3, 15) + 10 * 3600 * 1000; // Apr 15 2026 10:00 local
  const todayMidnight = L(2026, 3, 15);

  const noData = computeTimelineMinBound({ dataMinMs: null, nowMs });
  assert.equal(noData, todayMidnight, 'no orders on the plant → today\'s local midnight');

  const futureData = computeTimelineMinBound({ dataMinMs: L(2026, 3, 20), nowMs });
  assert.equal(futureData, todayMidnight, 'oldest order in the future → today\'s local midnight (today always reachable)');
});

test('computeTimelineMinBound: maxMs at or before the computed bound → null (never invert min/max)', () => {
  const nowMs = L(2026, 3, 15) + 10 * 3600 * 1000; // Apr 15 2026 10:00 local
  const dataMinMs = L(2026, 3, 1, 6); // computed bound would be Apr 1 local midnight
  const result = computeTimelineMinBound({ dataMinMs, nowMs, maxMs: L(2026, 2, 25) });
  assert.equal(result, null, 'maxMs earlier than the computed bound must return null');
});

test('tickerShouldPush: pushes only when "now" moved >= minPx at the current scale', () => {
  const t0 = 1_000_000_000_000;
  const base = { nowMs: t0 + 1000, lastPushedMs: t0, windowMs: 259_200_000, centerPx: 1400 };
  assert.equal(tickerShouldPush(base), false, '3-day window, 1s elapsed: sub-pixel, skip');
  assert.equal(tickerShouldPush({ ...base, windowMs: 900_000 }), true, '15-min window, 1s: >= 0.5px');
  assert.equal(tickerShouldPush({ ...base, nowMs: t0 + 300_000, windowMs: 3_600_000 }), true, 'zoom-in after 300s of no push');
  assert.equal(tickerShouldPush({ ...base, lastPushedMs: 0 }), true, 'never pushed');
  assert.equal(tickerShouldPush({ ...base, centerPx: 0 }), true, 'unusable scale falls back to push');
  assert.equal(tickerShouldPush({ ...base, nowMs: t0 - 1000 }), true, 'clock stepped back');
  assert.equal(tickerShouldPush({ ...base, minPx: 0 }), true, 'minPx override honored');
});

test('navLayout: rows while they fit, histogram beyond 30 lines', () => {
  const result10 = navLayout(10);
  assert.deepEqual(result10, { mode: 'rows', stripH: 42, bodyH: 30, rowH: 3 },
    'navLayout(10) should return rows mode with 3px per row');

  const result30 = navLayout(30);
  assert.deepEqual(result30, { mode: 'rows', stripH: 72, bodyH: 60, rowH: 2 },
    'navLayout(30) should return rows mode with 2px per row');

  const result31 = navLayout(31);
  assert.equal(result31.mode, 'histogram', 'navLayout(31) should switch to histogram mode');
  assert.equal(result31.stripH, 42, 'histogram stripH should be 42');
  assert.equal(result31.rowH, 0, 'histogram rowH should be 0');

  const result0 = navLayout(0);
  assert.equal(result0.mode, 'rows', 'navLayout(0) should return rows mode');
  assert.equal(result0.stripH, 42, 'navLayout(0) stripH should be 42');
  assert.equal(result0.rowH, 0, 'navLayout(0) rowH should be 0');
});

// ---------------------------------------------------------------------------
// Alert Monitor Task 17: profile-match fill (category) + severity ring.
// ---------------------------------------------------------------------------
function _pmHarness(t, { highlight = true, showAcked = false } = {}) {
  const m = AlertProfileMatches.current();
  const prior = { cat: m.categoryByTask, sev: m.sevByTask, ids: m.taskIds, acked: m.acked };
  const priorSettings = Store._state.userSettings;
  const priorAlerts = Store._state.alerts;
  const mk = (id) => ({ id, PRODUCTION_ORDER: id, MATERIAL_NUMBER: 'M', MACHINE: 'L-PM', plant: '5512',
    start_date: new Date('2026-07-01T08:00:00'), end_date: new Date('2026-07-01T12:00:00'), RUN_TIME: 4 });
  Store.setTasks([mk('pm-a'), mk('pm-b'), mk('pm-c')], 'test');
  m.categoryByTask = new Map([['pm-a', 'capacity'], ['pm-b', 'setup']]);
  m.sevByTask = new Map([['pm-a', 'err'], ['pm-b', 'warn']]);
  m.taskIds = new Set(['pm-a', 'pm-b']);
  m.acked = new Map();
  Store._state.userSettings = { ...(priorSettings || {}), alertProfileGanttHighlight: highlight, alertsShowAcknowledged: showAcked };
  Store._state.alerts = [];
  t.after(() => {
    m.categoryByTask = prior.cat; m.sevByTask = prior.sev; m.taskIds = prior.ids; m.acked = prior.acked;
    Store._state.userSettings = priorSettings; Store._state.alerts = priorAlerts;
    Store.setTasks([], 'test');
  });
  return m;
}

test('Timeline._itemForTask: alert-focus reads view().focusIds (the viewed profile); fills keep reading current()', (t) => {
  _pmHarness(t);
  const priorView = AlertProfileMatches.view;
  t.after(() => { AlertProfileMatches.view = priorView; });
  AlertProfileMatches.view = () => ({ ...priorView.call(AlertProfileMatches), focusIds: new Set(['pm-c']) });
  assert.match(Timeline._itemForTask(Store.tasks['pm-c']).className, /\balert-focus\b/);
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-c']).className, /profile-match/, 'no fill: outside the current() profile');
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-a']).className, /alert-focus/);
});

test('Timeline._itemForTask: a profile-matched order gets profile-match + category + severity classes', (t) => {
  _pmHarness(t);
  const a = Timeline._itemForTask(Store.tasks['pm-a']).className;
  assert.match(a, /\bprofile-match\b/);
  assert.match(a, /\bprofile-match-capacity\b/);
  assert.match(a, /\bprofile-match-err\b/);
  const b = Timeline._itemForTask(Store.tasks['pm-b']).className;
  assert.match(b, /\bprofile-match-setup\b/);
  assert.match(b, /\bprofile-match-warn\b/);
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-c']).className, /profile-match/, 'unmatched order is untouched');
});

test('Timeline._itemForTask: nothing when the highlight pref is off', (t) => {
  _pmHarness(t, { highlight: false });
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-a']).className, /profile-match/);
});

test('Timeline._itemForTask: a fully acknowledged order is not highlighted unless alertsShowAcknowledged', (t) => {
  const m = _pmHarness(t);
  Store._state.alerts = [{ id: 'al-1', taskId: 'pm-a', type: 'overload', sev: 'err' }, { id: 'al-2', taskId: 'pm-b', type: 'setup-conflict', sev: 'warn' }];
  m.acked = new Map([['al-1', { alertId: 'al-1' }]]);
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-a']).className, /profile-match/, 'every alert acked: hidden');
  assert.match(Timeline._itemForTask(Store.tasks['pm-b']).className, /profile-match-setup/, 'an unacked alert keeps it');
  Store._state.userSettings = { ...Store._state.userSettings, alertsShowAcknowledged: true };
  assert.match(Timeline._itemForTask(Store.tasks['pm-a']).className, /profile-match-capacity/, 'show-acknowledged restores it');
});

test('Timeline._applyProfileMatchClasses: updates only changed items, inside _suppressEvents, and strips on unmatch', (t) => {
  const m = _pmHarness(t);
  const priorItems = Timeline._items;
  const priorPlantState = Store._state.selectedPlant;
  const priorScoped = Store.tasksForSelectedPlant;
  Store._state.selectedPlant = '5512';   // no emit: the plant index keys on master-data lines this fixture lacks
  Store.tasksForSelectedPlant = () => ['pm-a', 'pm-b', 'pm-c'].map(id => Store.tasks[id]);
  const rows = new Map();
  for (const id of ['pm-a', 'pm-b', 'pm-c']) rows.set(id, { id, className: 'order-standard' });
  rows.get('pm-b').className = 'order-standard profile-match profile-match-setup profile-match-warn';   // already correct
  const calls = [];
  Timeline._items = {
    get: id => rows.get(id) || null,
    update(arr) { calls.push({ suppressed: Timeline._suppressEvents, ids: [].concat(arr).map(u => u.id) }); for (const u of [].concat(arr)) rows.set(u.id, { ...rows.get(u.id), ...u }); },
  };
  t.after(() => { Timeline._items = priorItems; Store._state.selectedPlant = priorPlantState; Store.tasksForSelectedPlant = priorScoped; });
  Timeline._applyProfileMatchClasses();
  assert.equal(calls.length, 1, 'one batched update');
  assert.deepEqual(calls[0].ids, ['pm-a'], 'only the changed item is written');
  assert.equal(calls[0].suppressed, true, 'written inside _suppressEvents');
  assert.equal(Timeline._suppressEvents, false, 'flag restored');
  assert.match(rows.get('pm-a').className, /order-standard profile-match profile-match-capacity profile-match-err/);
  m.categoryByTask = new Map(); m.sevByTask = new Map();
  Timeline._applyProfileMatchClasses();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].ids.sort(), ['pm-a', 'pm-b']);
  assert.equal(rows.get('pm-a').className, 'order-standard');
  Timeline._applyProfileMatchClasses();
  assert.equal(calls.length, 2, 'no-op when nothing changed');
});

test('Timeline._itemForTask: alert-focus follows focusIds, with or without the highlight pref; no alert means no outline', (t) => {
  const m = _pmHarness(t, { highlight: false });
  const priorFocus = m.focusIds;
  t.after(() => { m.focusIds = priorFocus; });
  m.focusIds = null;
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-a']).className, /alert-focus|conflict-order/);
  Store._state.alerts = [{ id: 'al-1', taskId: 'pm-c', type: 'overload', sev: 'err' }];
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-c']).className, /alert-focus|conflict-order/, 'an alerted order is no longer outlined');
  m.focusIds = new Set(['pm-c']);
  assert.match(Timeline._itemForTask(Store.tasks['pm-c']).className, /\balert-focus\b/, 'focus outlines even with the highlight pref off');
  assert.doesNotMatch(Timeline._itemForTask(Store.tasks['pm-a']).className, /alert-focus/);
});

test('Timeline._applyProfileMatchClasses: adds and clears alert-focus alongside the profile classes', (t) => {
  const m = _pmHarness(t);
  const priorFocus = m.focusIds;
  const priorItems = Timeline._items;
  const priorPlantState = Store._state.selectedPlant;
  const priorScoped = Store.tasksForSelectedPlant;
  Store._state.selectedPlant = '5512';
  Store.tasksForSelectedPlant = () => ['pm-a', 'pm-b', 'pm-c'].map(id => Store.tasks[id]);
  const rows = new Map();
  for (const id of ['pm-a', 'pm-b', 'pm-c']) rows.set(id, { id, className: 'order-standard' });
  rows.get('pm-a').className = 'order-standard profile-match profile-match-capacity profile-match-err';
  rows.get('pm-b').className = 'order-standard profile-match profile-match-setup profile-match-warn';
  Timeline._items = {
    get: id => rows.get(id) || null,
    update(arr) { for (const u of [].concat(arr)) rows.set(u.id, { ...rows.get(u.id), ...u }); },
  };
  t.after(() => { m.focusIds = priorFocus; Timeline._items = priorItems; Store._state.selectedPlant = priorPlantState; Store.tasksForSelectedPlant = priorScoped; });
  m.focusIds = new Set(['pm-c', 'pm-a']);
  Timeline._applyProfileMatchClasses();
  assert.match(rows.get('pm-c').className, /\balert-focus\b/, 'an unmatched order is early-continued only when it has neither');
  assert.match(rows.get('pm-a').className, /profile-match-capacity.*alert-focus|alert-focus.*profile-match-capacity/);
  assert.doesNotMatch(rows.get('pm-b').className, /alert-focus/);
  m.focusIds = null;
  Timeline._applyProfileMatchClasses();
  assert.doesNotMatch(rows.get('pm-c').className, /alert-focus/, 'cleared');
  assert.doesNotMatch(rows.get('pm-a').className, /alert-focus/);
  assert.match(rows.get('pm-a').className, /profile-match-capacity/, 'the fill stays');
});

test('Timeline._profileMatchClasses: D8 under the built-in profile, error orders get the ring only, warnings nothing', (t) => {
  const m = _pmHarness(t);
  const prior = { profile: m.profile };
  t.after(() => { m.profile = prior.profile; });
  m.categoryByTask = new Map();
  m.sevByTask = new Map([['pm-a', 'err'], ['pm-b', 'warn']]);
  m.profile = { ...m.profile, builtIn: true };
  assert.deepEqual(Timeline._profileMatchClasses('pm-a'), ['profile-match', 'profile-match-err']);
  assert.deepEqual(Timeline._profileMatchClasses('pm-b'), []);
  m.profile = { ...m.profile, builtIn: false };
  assert.deepEqual(Timeline._profileMatchClasses('pm-a'), [], 'a custom profile with no category stays plain');
});

test('Timeline._profileMatchClasses: D8 ring follows the acknowledgement rule', (t) => {
  const m = _pmHarness(t);
  const prior = { profile: m.profile };
  t.after(() => { m.profile = prior.profile; });
  m.categoryByTask = new Map();
  m.sevByTask = new Map([['pm-a', 'err']]);
  m.profile = { ...m.profile, builtIn: true };
  Store._state.alerts = [{ id: 'al-1', taskId: 'pm-a', type: 'overload', sev: 'err' }];
  m.acked = new Map([['al-1', { alertId: 'al-1' }]]);
  assert.deepEqual(Timeline._profileMatchClasses('pm-a'), [], 'every alert acked: no ring');
  Store._state.userSettings = { ...Store._state.userSettings, alertsShowAcknowledged: true };
  assert.deepEqual(Timeline._profileMatchClasses('pm-a'), ['profile-match', 'profile-match-err'], 'show-acknowledged restores the ring');
});

test('navBarStyle: profile-match sits between focus and firmed', () => {
  assert.equal(navBarStyle('order-standard profile-match profile-match-setup'), 'profile');
  assert.equal(navBarStyle('order-firmed profile-match'), 'profile');
  assert.equal(navBarStyle('order-standard profile-match alert-focus'), 'focus');
  assert.equal(navBarStyle('order-standard profile-match dimmed'), 'dimmed');
});

test('navBarStyle precedence: dimmed > focus > profile > firmed > standard', () => {
  assert.equal(
    navBarStyle('order-firmed alert-focus dimmed'),
    'dimmed',
    'dimmed takes highest precedence'
  );
  assert.equal(
    navBarStyle('order-standard alert-focus'),
    'focus',
    'focus takes precedence over standard'
  );
  assert.equal(
    navBarStyle('order-firmed split-order-segment'),
    'firmed',
    'firmed is recognized and returned'
  );
  assert.equal(
    navBarStyle('order-standard'),
    'standard',
    'standard is returned when alone'
  );
  assert.equal(
    navBarStyle(undefined),
    'standard',
    'undefined defaults to standard'
  );
});

test('navClampRect never inverts and clamps off-range windows to an edge', () => {
  assert.deepEqual(
    navClampRect(-50, -10, 800),
    { x1: 0, x2: 0 },
    'both x off left edge clamp to left edge (x1=x2=0)'
  );
  assert.deepEqual(
    navClampRect(900, 950, 800),
    { x1: 800, x2: 800 },
    'both x off right edge clamp to right edge'
  );
  assert.deepEqual(
    navClampRect(-20, 100, 800),
    { x1: 0, x2: 100 },
    'x1 off left edge clamps to 0, x2 stays'
  );
  assert.deepEqual(
    navClampRect(300, 200, 800),
    { x1: 200, x2: 300 },
    'inverted x1>x2 swaps them (x1=200, x2=300)'
  );
});

test('DependencyOverlay.highlightChain reads Store dependencies without throwing when empty', () => {
  Store.setTasks([], 'unit-test');
  assert.doesNotThrow(() => DependencyOverlay.highlightChain('nonexistent'));
});
test('Hierarchy exposes init/render', () => {
  assert.equal(typeof Hierarchy.init, 'function');
  assert.equal(typeof Hierarchy.render, 'function');
});

test('GanttFilter.selectedLines/isolateLine/restoreAllLines/activeFilter are the public replacement for the old private surface', () => {
  assert.equal(typeof GanttFilter.selectedLines, 'function');
  assert.equal(typeof GanttFilter.isolateLine, 'function');
  assert.equal(typeof GanttFilter.restoreAllLines, 'function');
  assert.equal(typeof GanttFilter.activeFilter, 'function');
  GanttFilter.isolateLine('L1');
  assert.ok(GanttFilter.selectedLines().has('L1'));
  GanttFilter.restoreAllLines();
  assert.equal(GanttFilter.selectedLines().size, 0);
});

test('GanttFilter applies dimming to every visual piece of a split order', () => {
  const task = {
    id: 'filter-split', PLANT: 'P-SPLIT', MACHINE: 'L-SPLIT', text: 'matched nowhere', RUN_TIME: 14,
    start_date: new Date('2026-08-12T08:00:00'), end_date: new Date('2026-08-13T10:00:00'),
    scheduleSegments: [
      { sequence: 1, startDate: new Date('2026-08-12T08:00:00'), endDate: new Date('2026-08-12T20:00:00') },
      { sequence: 2, startDate: new Date('2026-08-13T08:00:00'), endDate: new Date('2026-08-13T10:00:00') },
    ],
  };
  const firstId = 'order-segment:filter-split:1';
  const secondId = 'order-segment:filter-split:2';
  const items = new Map([[firstId, { id: firstId, className: 'task' }], [secondId, { id: secondId, className: 'task' }]]);
  const updates = [];
  const oldItems = Timeline._items;
  const oldIds = Timeline._itemIdsByTask;
  const oldActive = GanttFilter._active;
  const oldPlant = Store.selectedPlant;
  try {
    Store.setTasks([task], 'unit-test');
    Store.setSelectedPlant('P-SPLIT', 'unit-test');
    Timeline._itemIdsByTask = { 'filter-split': [firstId, secondId] };
    Timeline._items = {
      get(id) { return items.get(id); },
      update(next) { updates.push(...next); },
    };
    GanttFilter._active = { text: 'does not match' };

    GanttFilter._doApply();

    assert.deepEqual(updates.map(update => update.id), [firstId, secondId]);
    assert.ok(updates.every(update => update.className === 'task dimmed'));
  } finally {
    Timeline._items = oldItems;
    Timeline._itemIdsByTask = oldIds;
    GanttFilter._active = oldActive;
    Store.setTasks([], 'unit-test');
    Store.setSelectedPlant(oldPlant, 'unit-test');
  }
});
test('Interaction exposes install/uninstall', () => {
  assert.equal(typeof Interaction.install, 'function');
  assert.equal(typeof Interaction.uninstall, 'function');
});

test('Interaction.install is idempotent — a second call does not double-attach document listeners', () => {
  _resetDocListenerCounts();
  Timeline._tl = { on() {} };
  Timeline._items = { on() {} };
  try {
    Interaction.install();
    // install() itself attaches 3 unconditional document listeners
    // (mousemove for edge-scroll tracking, mouseleave for tooltip hiding,
    // keydown for _onKeyDown); _installHoverPreview() attaches a SEPARATE
    // document keydown (dismiss-on-any-key) once its #vis-timeline container
    // stub resolves truthy — 2 distinct keydown listeners in total.
    const afterFirst = {
      keydown:    _docListenerCount('keydown'),
      mousemove:  _docListenerCount('mousemove'),
      mouseleave: _docListenerCount('mouseleave'),
    };
    assert.equal(afterFirst.keydown, 2, 'install() should register exactly 2 distinct keydown listeners');
    assert.equal(afterFirst.mousemove, 1);
    assert.equal(afterFirst.mouseleave, 1);

    Interaction.install(); // second call — Interaction._installed guard must make this a no-op
    assert.equal(_docListenerCount('keydown'), afterFirst.keydown,
      'a second install() call must not double-attach keydown listeners');
    assert.equal(_docListenerCount('mousemove'), afterFirst.mousemove,
      'a second install() call must not double-attach the mousemove listener');
    assert.equal(_docListenerCount('mouseleave'), afterFirst.mouseleave,
      'a second install() call must not double-attach the mouseleave listener');
  } finally {
    Interaction.uninstall();
    Timeline._tl = undefined;
    Timeline._items = undefined;
  }
});

test('Interaction.uninstall removes every document-level listener install() attached', () => {
  _resetDocListenerCounts();
  Timeline._tl = { on() {} };
  Timeline._items = { on() {} };
  try {
    Interaction.install();
    assert.ok(_docListenerCount('keydown') > 0, 'sanity check: install() must have attached a keydown listener');
    assert.ok(_docListenerCount('mousemove') > 0, 'sanity check: install() must have attached a mousemove listener');
    assert.ok(_docListenerCount('mouseleave') > 0, 'sanity check: install() must have attached a mouseleave listener');

    Interaction.uninstall();
    assert.equal(_docListenerCount('keydown'), 0, 'uninstall() must remove BOTH keydown listeners (_onKeyDownBound and _hoverDismissBound)');
    assert.equal(_docListenerCount('mousemove'), 0, 'uninstall() must remove the edge-scroll-tracking mousemove listener');
    assert.equal(_docListenerCount('mouseleave'), 0, 'uninstall() must remove the tooltip-hide mouseleave listener');

    // uninstall() is itself idempotent (guarded by _installed) — calling it
    // again with nothing installed must not further decrement the counts.
    Interaction.uninstall();
    assert.equal(_docListenerCount('keydown'), 0);
  } finally {
    Timeline._tl = undefined;
    Timeline._items = undefined;
  }
});

// The single most safety-critical behavior in this module: what actually
// happens when a vis-timeline DataSet 'update' event reports a changed
// start/end/group for a FIRMED task. Writing this test uncovered that the
// module's own header comment ("Firmed orders are reverted in the DataSet and
// never reach the Store") does not match the real code — see the corrected
// comment above `_onDataSetUpdate`. These tests pin the REAL current behavior.
//
// Backward scheduling Task 2.5 (OQ1): a drop anchors on the FINISH. The right edge sets the finish, the start is
// derived from the run time, and a change of the left edge alone is not a move at all (it is reverted with a toast).

function _stubGanttSideEffects() {
  const prior = {
    recompute: Alerts.scheduleRecompute, recomputeLines: Alerts.scheduleRecomputeLines,
    rebuild: Timeline._scheduleRebuild, toast: Toast.show, items: Timeline._items,
  };
  const calls = { rebuilds: 0, toasts: [] };
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._scheduleRebuild = () => { calls.rebuilds++; };
  Toast.show = (msg, type) => { calls.toasts.push({ msg, type }); };
  calls.restore = () => {
    Alerts.scheduleRecompute = prior.recompute; Alerts.scheduleRecomputeLines = prior.recomputeLines;
    Timeline._scheduleRebuild = prior.rebuild; Toast.show = prior.toast; Timeline._items = prior.items;
    Selection.clear();
    Store.setTasks([], 'test');
  };
  return calls;
}

test('Interaction._onDataSetUpdate: a firmed order\'s unchanged-edges echo is swallowed (nothing is committed)', () => {
  const id = 'fx-echo-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX1', MATERIAL_NUMBER: 'MFX1', MACHINE: 'L1',
    PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start, end, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime());
    assert.equal(fx.rebuilds, 0, 'an echo is ignored, not reverted');
    assert.equal(fx.toasts.length, 0);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: an end-only change is a real move — the finish is held and the start follows (OQ1)', () => {
  const id = 'fx-endonly-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const draggedEnd = new Date('2026-08-05T14:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX1B', MATERIAL_NUMBER: 'MFX1B', MACHINE: 'L1',
    PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();
  // The right edge was dragged: start unchanged, end two hours later.
  Timeline._items = { get: (i) => (i === id ? { start, end: draggedEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].end_date.getTime(), draggedEnd.getTime(), 'the dragged right edge IS the finish');
    assert.equal(Store.tasks[id].start_date.getTime(), new Date('2026-08-05T10:00:00').getTime(),
      'the start is re-derived from the 4 h run time, not left where it was');
    assert.equal(fx.rebuilds, 0);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: a left-edge-only change is reverted with toast.left_edge_locked and commits nothing', () => {
  const id = 'fx-leftedge-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start: new Date('2026-08-05T06:00:00'), end, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime());
    assert.equal(fx.rebuilds, 1, 'the bar springs back');
    assert.deepEqual(fx.toasts.map(t => t.type), ['warn']);
    assert.match(fx.toasts[0].msg, /left_edge_locked/);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: a drop whose finish cannot be held reverts with toast.finish_cannot_hold and commits nothing (OQ13 b)', () => {
  const id = 'fx-cannot-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Selection.clear();
  // Dropped so it ends at 06:00, before the 07:00 opening: nothing 4 h long can end there on that day.
  Timeline._items = { get: (i) => (i === id
    ? { start: new Date('2026-08-05T02:00:00'), end: new Date('2026-08-05T06:00:00'), group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime());
    assert.equal(fx.rebuilds, 1);
    assert.equal(fx.toasts.length, 1, 'one toast, no second "could not commit" on top of it');
    assert.match(fx.toasts[0].msg, /finish_cannot_hold/);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: a genuine drag on a firmed task commits today — firmed-order protection only suppresses no-op echoes, not real drags', () => {
  const id = 'fx-real-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const draggedStart = new Date('2026-08-05T09:00:00');
  const draggedEnd   = new Date('2026-08-05T13:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX2', MATERIAL_NUMBER: 'MFX2', MACHINE: 'L1',
    PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();

  Timeline._items = { get: (i) => (i === id ? { start: draggedStart, end: draggedEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(
      Store.tasks[id].start_date.getTime(), draggedStart.getTime(),
      'current behavior: a genuine drag on a firmed task commits to the Store — it is NOT reverted (see the corrected header comment above _onDataSetUpdate)'
    );
    assert.equal(Store.tasks[id].end_date.getTime(), draggedEnd.getTime());
  } finally { fx.restore(); restoreClock(); }
});

test('OQ63: a firmed order dropped outside working hours asks to confirm; confirming stores the overtime marker, declining reverts', async () => {
  const id = 'fx-overtime-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorConfirm = Engine.confirmOvertimePlacement;
  let asked = 0;
  let answer = false;
  Engine.confirmOvertimePlacement = async () => { asked++; return answer; };
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();
  const late = { start: new Date('2026-08-05T18:00:00'), end: new Date('2026-08-05T22:00:00'), group: 'L1' };   // closes at 19:00
  Timeline._items = { get: (i) => (i === id ? late : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(asked, 1, 'the planner is asked');
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime(), 'nothing is committed while the question is open');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime(), 'declined: nothing committed');
    assert.equal(fx.rebuilds, 1, 'declined: the bar springs back');
    assert.ok(!Store.tasks[id].placement_exception);

    answer = true;
    Interaction._onDataSetUpdate({ items: [id] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(asked, 2);
    assert.equal(Store.tasks[id].end_date.getTime(), late.end.getTime());
    assert.equal(Store.tasks[id].start_date.getTime(), late.start.getTime(), 'raw placement: finish minus run time');
    assert.equal(Store.tasks[id].placement_exception, 'overtime');
    assert.equal(fx.toasts.length, 0, 'no refusal toast on either path');
  } finally { Engine.confirmOvertimePlacement = priorConfirm; fx.restore(); restoreClock(); }
});

// ---------------------------------------------------------------------------
// Workstream B1 (2026-08-21), rewritten for Task 2.5 (OQ17 b): a drag through manualSchedulePatchFor, which
// translates an order that already has >=2 scheduleSegments rigidly by the DRAGGED PIECE's same-edge delta.
// ---------------------------------------------------------------------------

test('Interaction._onDataSetUpdate: dragging one segment of an already-split (>=2 segments) order moves EVERY segment by that piece\'s same-edge delta (OQ17 b)', () => {
  const fx = _stubGanttSideEffects();
  const id = 'split-drag-1';
  const line = 'SPLIT-DRAG-LINE';
  const seg1Start = new Date('2026-08-20T08:00:00');
  const seg1End   = new Date('2026-08-20T16:00:00');
  const seg2Start = new Date('2026-08-21T08:00:00');
  const seg2End   = new Date('2026-08-21T16:00:00');
  const seg3Start = new Date('2026-08-24T08:00:00');
  const seg3End   = new Date('2026-08-24T16:00:00');
  const originalSegments = [
    { sequence: 1, startDate: seg1Start, endDate: seg1End },
    { sequence: 2, startDate: seg2Start, endDate: seg2End },
    { sequence: 3, startDate: seg3Start, endDate: seg3End },
  ];
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PSPLIT1', MATERIAL_NUMBER: 'MSPLIT1', MACHINE: line,
    plant: '5512', RUN_TIME: 24,
    start_date: seg1Start, end_date: seg3End,
    scheduleSegments: originalSegments,
  }], 'test');
  Selection.clear();

  // The user drags segment 3's own bar two days later: its end moves by +2 days, so EVERY piece moves by +2 days
  // (not by the distance from the dragged piece to the first piece's start, which was the old start-anchored rule).
  const draggedSegmentItemId = Timeline._segmentItemId(id, 3);
  const droppedSeg3Start = new Date('2026-08-26T08:00:00');
  const droppedSeg3End   = new Date('2026-08-26T16:00:00');
  Timeline._items = {
    get: (i) => (i === draggedSegmentItemId
      ? { start: droppedSeg3Start, end: droppedSeg3End, group: line, parentId: id }
      : undefined),
  };
  try {
    Interaction._onDataSetUpdate({ items: [draggedSegmentItemId] });

    const updated = Store.tasks[id];
    assert.equal(updated.scheduleSegments.length, 3,
      'the order is NOT collapsed to a single continuous block just because a segment was dragged');
    const deltaMs = Util.snap(droppedSeg3End).getTime() - seg3End.getTime();
    assert.equal(deltaMs, 2 * 24 * 3600 * 1000, 'sanity: the dragged piece\'s end moved by two days');
    for (let i = 0; i < 3; i++) {
      const original = originalSegments[i];
      const shifted = updated.scheduleSegments[i];
      assert.equal(shifted.startDate.getTime(), original.startDate.getTime() + deltaMs, `segment ${i + 1} start shifted by the same-edge delta`);
      assert.equal(shifted.endDate.getTime(), original.endDate.getTime() + deltaMs, `segment ${i + 1} end shifted by the same-edge delta`);
    }
    assert.equal(updated.start_date.getTime(), updated.scheduleSegments[0].startDate.getTime(), 'parent start mirrors the first segment');
    assert.equal(updated.end_date.getTime(), updated.scheduleSegments[2].endDate.getTime(), 'parent end mirrors the last segment');
    assert.equal(updated.MACHINE, line);
  } finally { fx.restore(); }
});

test('Interaction._onDataSetUpdate: dragging piece 1 of a split order whose shifted finish fits one window commits ONE bar ending at the shifted finish (2026-10-28, R3)', () => {
  const id = 'split-rejoin-1';
  const line = 'SPLIT-REJOIN-LINE';
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const seg1 = { sequence: 1, startDate: new Date('2026-08-04T17:00:00'), endDate: new Date('2026-08-04T19:00:00') };
  const seg2 = { sequence: 2, startDate: new Date('2026-08-05T07:00:00'), endDate: new Date('2026-08-05T09:00:00') };
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PSPLITR1', MATERIAL_NUMBER: 'MSPLITR1', MACHINE: line, PLANT: '5512', RUN_TIME: 4,
    start_date: seg1.startDate, end_date: seg2.endDate, scheduleSegments: [seg1, seg2],
  }], 'test');
  Selection.clear();
  // Piece 1's end moves +29 h (to Thu 00:00), so the order's finish moves by the same delta: Wed 09:00 -> Thu 14:00,
  // where the whole 4 h run fits Thursday's open window. The bar ends at that finish, not at the dropped piece.
  const draggedId = Timeline._segmentItemId(id, 1);
  Timeline._items = { get: (i) => (i === draggedId
    ? { start: new Date('2026-08-05T22:00:00'), end: new Date('2026-08-06T00:00:00'), group: line, parentId: id }
    : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [draggedId] });
    const updated = Store.tasks[id];
    assert.deepEqual(updated.scheduleSegments, []);
    assert.equal(updated.end_date.getTime(), new Date('2026-08-06T14:00:00').getTime());
    assert.equal(updated.start_date.getTime(), new Date('2026-08-06T10:00:00').getTime());
    assert.equal(updated.MACHINE, line);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: a multi-select drag shifts a COMPANION\'s existing >=2 scheduleSegments by the GROUP delta too (whole-branch review fix)', () => {
  // The companion loop routes every companion through the same manualSchedulePatchFor the dragged item uses,
  // so a companion that is itself already split moves its pieces with the group instead of leaving them stale.
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const line = 'MULTI-DRAG-LINE';
  const anchorId = 'multi-anchor';
  const companionId = 'multi-companion';

  const anchorStart = new Date('2026-08-24T08:00:00');
  const anchorEnd   = new Date('2026-08-24T12:00:00'); // RUN_TIME 4h

  const seg1Start = new Date('2026-09-01T08:00:00');
  const seg1End   = new Date('2026-09-01T16:00:00');
  const seg2Start = new Date('2026-09-02T08:00:00');
  const seg2End   = new Date('2026-09-02T16:00:00');
  const seg3Start = new Date('2026-09-03T08:00:00');
  const seg3End   = new Date('2026-09-03T16:00:00');
  const companionOriginalSegments = [
    { sequence: 1, startDate: seg1Start, endDate: seg1End },
    { sequence: 2, startDate: seg2Start, endDate: seg2End },
    { sequence: 3, startDate: seg3Start, endDate: seg3End },
  ];

  Store.setTasks([
    {
      id: anchorId, PRODUCTION_ORDER: 'PANCHOR', MATERIAL_NUMBER: 'MANCHOR', MACHINE: line,
      PLANT: '5512', RUN_TIME: 4, start_date: anchorStart, end_date: anchorEnd,
    },
    {
      id: companionId, PRODUCTION_ORDER: 'PCOMP', MATERIAL_NUMBER: 'MCOMP', MACHINE: line,
      PLANT: '5512', RUN_TIME: 24, start_date: seg1Start, end_date: seg3End,
      scheduleSegments: companionOriginalSegments,
    },
  ], 'test');
  Selection.set([anchorId, companionId]);

  // The anchor (dragged item) is dropped two days later; the companion is NOT dragged directly -- it moves by
  // the same finish delta.
  const droppedAnchorStart = new Date('2026-08-26T08:00:00');
  const droppedAnchorEnd   = new Date('2026-08-26T12:00:00');
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: droppedAnchorStart, end: droppedAnchorEnd, group: line } : undefined),
    update: () => {},
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });

    const updatedAnchor = Store.tasks[anchorId];
    assert.equal(updatedAnchor.end_date.getTime(), Util.snap(droppedAnchorEnd).getTime(), 'the dragged anchor holds the dropped finish');
    assert.equal(updatedAnchor.start_date.getTime(), Util.snap(droppedAnchorStart).getTime());

    const updatedCompanion = Store.tasks[companionId];
    assert.equal(updatedCompanion.scheduleSegments.length, 3,
      'the companion is NOT collapsed to a single continuous block just because it was dragged as part of a group');

    const deltaMs = Util.snap(droppedAnchorEnd).getTime() - anchorEnd.getTime();
    assert.notEqual(deltaMs, 0, 'sanity: the group drag must have actually moved');

    for (let i = 0; i < 3; i++) {
      const original = companionOriginalSegments[i];
      const shifted = updatedCompanion.scheduleSegments[i];
      assert.equal(shifted.startDate.getTime(), original.startDate.getTime() + deltaMs,
        `companion segment ${i + 1} start shifted by exactly the GROUP drag delta, not left stale`);
      assert.equal(shifted.endDate.getTime(), original.endDate.getTime() + deltaMs,
        `companion segment ${i + 1} end shifted by exactly the GROUP drag delta, not left stale`);
    }
    assert.equal(updatedCompanion.start_date.getTime(), updatedCompanion.scheduleSegments[0].startDate.getTime());
    assert.equal(updatedCompanion.end_date.getTime(), updatedCompanion.scheduleSegments[2].endDate.getTime());
    assert.equal(updatedCompanion.MACHINE, line);
  } finally { fx.restore(); restoreClock(); }
});

test('Interaction._onDataSetUpdate: a multi-select drag with a failing companion patch commits NOTHING — the dragged item is not partially committed (final-review fix 1)', () => {
  // Regression target: the dragged item's Store mutation must wait until every companion patch has validated.
  // A companion with RUN_TIME 0 makes manualSchedulePatchFor return null, so the whole drag reverts.
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(performance.now()); return 1; };

  const line = 'MULTI-DRAG-FAIL-LINE';
  const anchorId = 'multi-anchor-fail';
  const companionId = 'multi-companion-fail';

  const anchorStart = new Date('2026-08-24T08:00:00');
  const anchorEnd   = new Date('2026-08-24T12:00:00'); // RUN_TIME 4h
  const companionStart = new Date('2026-08-24T08:00:00');
  const companionEnd   = new Date('2026-08-24T12:00:00');

  Store.setTasks([
    {
      id: anchorId, PRODUCTION_ORDER: 'PANCHORF', MATERIAL_NUMBER: 'MANCHORF', MACHINE: line,
      PLANT: '5512', RUN_TIME: 4, start_date: anchorStart, end_date: anchorEnd,
    },
    {
      // RUN_TIME: 0 -> Util.runHours returns 0 -> manualSchedulePatchFor refuses for this companion.
      id: companionId, PRODUCTION_ORDER: 'PCOMPF', MATERIAL_NUMBER: 'MCOMPF', MACHINE: line,
      PLANT: '5512', RUN_TIME: 0, start_date: companionStart, end_date: companionEnd,
    },
  ], 'test');
  Selection.set([anchorId, companionId]);

  const droppedAnchorStart = new Date('2026-08-26T08:00:00');
  const droppedAnchorEnd   = new Date('2026-08-26T12:00:00');

  let timelineItemUpdateCalled = false;
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: droppedAnchorStart, end: droppedAnchorEnd, group: line } : undefined),
    update: () => { timelineItemUpdateCalled = true; },
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });

    const stillAnchor = Store.tasks[anchorId];
    assert.equal(stillAnchor.start_date.getTime(), anchorStart.getTime(),
      'the dragged anchor must NOT be partially committed when a companion patch fails validation');
    assert.equal(stillAnchor.end_date.getTime(), anchorEnd.getTime());
    assert.equal(stillAnchor.MACHINE, line);

    const stillCompanion = Store.tasks[companionId];
    assert.equal(stillCompanion.start_date.getTime(), companionStart.getTime(), 'the companion must also be completely unchanged');
    assert.equal(stillCompanion.end_date.getTime(), companionEnd.getTime());

    assert.equal(timelineItemUpdateCalled, false,
      'no Timeline._items.update call should happen for any companion when the batch fails validation');
  } finally {
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore(); restoreClock();
  }
});


test('Task 3: B2 — Interaction._onDataSetUpdate no longer calls autoReflow (peers stay put even if overlapping)', () => {
  // Task 3 deleted Engine.autoReflow call from Interaction._onDataSetUpdate (single-item drag branch).
  // This test calls the real handler (not Store.updateTask) and verifies autoReflow is NOT invoked.
  // Pattern from schedule-workbench.test.mjs ~line 869.
  const line = 'NO-REFLOW-TIMELINE-LINE';
  const plant = '5512';
  const start1 = new Date('2026-08-25T08:00:00');
  const end1 = new Date('2026-08-25T10:00:00');
  const start2 = new Date('2026-08-25T09:00:00'); // overlaps with task 1
  const end2 = new Date('2026-08-25T11:00:00');
  const draggedStart = new Date('2026-08-25T07:00:00'); // creates overlap when moved
  const draggedEnd = new Date('2026-08-25T09:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;
  const priorScheduleRecompute = Alerts.scheduleRecompute;

  let autoReflowCalls = [];
  Engine.autoReflow = (id) => autoReflowCalls.push(id);
  Alerts.scheduleRecompute = () => {}; // stub to avoid setTimeout
  const restoreClock = pinPlantClock([plant]);

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'timeline-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'timeline-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');
  Selection.clear();

  Timeline._items = {
    get: (i) => (i === 'timeline-anchor' ? { start: draggedStart, end: draggedEnd, group: line } : undefined),
  };
  try {
    const peerBefore = Store.tasks['timeline-peer'].start_date.getTime();
    // Call the real handler — this is the single-item drag that used to call autoReflow
    Interaction._onDataSetUpdate({ items: ['timeline-anchor'] });
    const peerAfter = Store.tasks['timeline-peer'].start_date.getTime();
    // Peer should NOT have moved and autoReflow should NOT have been called
    assert.equal(peerAfter, peerBefore, 'peer must NOT be reflowed after Timeline drag');
    assert.equal(autoReflowCalls.length, 0, 'Engine.autoReflow must NOT be called from Interaction._onDataSetUpdate (Task 3: B2 deleted this call)');
  } finally {
    restoreClock();
    Engine.autoReflow = priorAutoReflow;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Timeline._items = undefined;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// --- Distribution (aggregate_to_detail.md §8) — machine lock + markers -----

test('Interaction._onDataSetUpdate rejects a cross-machine drag of a sub-order (PARENT_ORDER set): the item springs back via Timeline._scheduleRebuild and the distribution-lock toast fires, no Store write', () => {
  const priorToastShow = Toast.show;
  const priorRaf = globalThis.requestAnimationFrame;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  // Real en.js interpolation, so this test also pins the toast copy itself.
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.dist_machine_locked': '{{order}} runs on {{machine}} because of its distribution. Adjust shares to move it.' } };
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  globalThis.requestAnimationFrame = callback => { callback(performance.now()); return 1; };
  let scheduleRebuildCalled = false;
  Timeline._scheduleRebuild = () => { scheduleRebuildCalled = true; };

  const id = 'dist-drag-locked';
  const line = 'DIST-DRAG-L1';
  const otherLine = 'DIST-DRAG-L2';
  const start = new Date('2026-09-21T08:00:00');
  const end = new Date('2026-09-21T10:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'A-9101', ORDER: 'A-9101', PARENT_ORDER: '9101', DISTRIBUTION_LETTER: 'A',
    MACHINE: line, RUN_TIME: 2, start_date: start, end_date: end,
  }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start, end, group: otherLine } : undefined) };

  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].MACHINE, line, 'the sub-order must stay on its original machine');
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
    assert.equal(scheduleRebuildCalled, true, 'the existing spring-back mechanism must be invoked to revert the visual position');
    assert.equal(toastCalls.length, 1, 'the distribution-lock toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9101/);
    assert.match(toastCalls[0].msg, new RegExp(line));
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Toast.show = priorToastShow;
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
  }
});

test('Interaction._onDataSetUpdate allows a time-only drag of a sub-order on the SAME machine — the machine lock never blocks a time change', () => {
  const priorToastShow = Toast.show;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  Toast.show = () => {};
  Alerts.scheduleRecompute = () => {};

  const restoreClock = pinPlantClock(['P-DIST-TIME']);
  const id = 'dist-drag-timeonly';
  const line = 'DIST-DRAG-TIME-L1';
  const start = new Date('2026-09-21T08:00:00');
  const end = new Date('2026-09-21T10:00:00');
  const newStart = new Date('2026-09-21T09:00:00');
  const newEnd = new Date('2026-09-21T11:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'A-9106', ORDER: 'A-9106', PARENT_ORDER: '9106', DISTRIBUTION_LETTER: 'A', PLANT: 'P-DIST-TIME',
    MACHINE: line, RUN_TIME: 2, start_date: start, end_date: end,
  }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start: newStart, end: newEnd, group: line } : undefined) };

  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].MACHINE, line);
    assert.equal(Store.tasks[id].end_date.getTime(), newEnd.getTime(), 'time-only drags remain unrestricted for sub-orders');
    assert.equal(Store.tasks[id].start_date.getTime(), newStart.getTime());
  } finally {
    restoreClock();
    Timeline._items = undefined;
    Toast.show = priorToastShow;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks([], 'test');
  }
});

test('Interaction._onDataSetUpdate: a multi-drag whose DRAGGED item is a locked sub-order reverts the whole selection atomically', () => {
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorToastShow = Toast.show;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._scheduleRebuild = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  const line = 'DIST-MULTI-L1';
  const otherLine = 'DIST-MULTI-L2';
  const anchorId = 'dist-multi-anchor';
  const companionId = 'dist-multi-companion';
  const anchorStart = new Date('2026-09-21T08:00:00');
  const anchorEnd = new Date('2026-09-21T10:00:00');
  const companionStart = new Date('2026-09-21T09:00:00');
  const companionEnd = new Date('2026-09-21T11:00:00');

  Store.setTasks([
    { id: anchorId, PRODUCTION_ORDER: 'A-9102', ORDER: 'A-9102', PARENT_ORDER: '9102', DISTRIBUTION_LETTER: 'A', MACHINE: line, RUN_TIME: 2, start_date: anchorStart, end_date: anchorEnd },
    { id: companionId, PRODUCTION_ORDER: 'PCOMP9102', MACHINE: line, RUN_TIME: 2, start_date: companionStart, end_date: companionEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  let itemsUpdateCalled = false;
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: anchorStart, end: anchorEnd, group: otherLine } : undefined),
    update: () => { itemsUpdateCalled = true; },
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });
    assert.equal(Store.tasks[anchorId].MACHINE, line, 'locked dragged item must stay on its machine');
    assert.equal(Store.tasks[companionId].MACHINE, line, 'the free companion must NOT be moved either — atomic revert');
    assert.equal(Store.tasks[companionId].start_date.getTime(), companionStart.getTime());
    assert.equal(itemsUpdateCalled, false, 'no companion Timeline item mirror update should happen when the batch is rejected');
    assert.equal(toastCalls.length, 1);
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
    Toast.show = priorToastShow;
  }
});

test('Interaction._onDataSetUpdate: a multi-drag whose COMPANION is a locked sub-order reverts the whole selection atomically (the dragged item is not partially committed)', () => {
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorToastShow = Toast.show;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._scheduleRebuild = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  const line = 'DIST-MULTI-L3';
  const otherLine = 'DIST-MULTI-L4';
  const anchorId = 'dist-multi-anchor2';
  const companionId = 'dist-multi-companion2';
  const anchorStart = new Date('2026-09-21T08:00:00');
  const anchorEnd = new Date('2026-09-21T10:00:00');
  const companionStart = new Date('2026-09-21T09:00:00');
  const companionEnd = new Date('2026-09-21T11:00:00');

  Store.setTasks([
    { id: anchorId, PRODUCTION_ORDER: 'PANCHOR9103', MACHINE: line, RUN_TIME: 2, start_date: anchorStart, end_date: anchorEnd },
    { id: companionId, PRODUCTION_ORDER: 'B-9103', ORDER: 'B-9103', PARENT_ORDER: '9103', DISTRIBUTION_LETTER: 'B', MACHINE: line, RUN_TIME: 2, start_date: companionStart, end_date: companionEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  let itemsUpdateCalled = false;
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: anchorStart, end: anchorEnd, group: otherLine } : undefined),
    update: () => { itemsUpdateCalled = true; },
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });
    assert.equal(Store.tasks[anchorId].MACHINE, line, 'the dragged anchor must not commit either — atomic revert');
    assert.equal(Store.tasks[companionId].MACHINE, line, 'the locked companion stays on its machine');
    assert.equal(itemsUpdateCalled, false, 'no Timeline item mirror update should happen when the batch is rejected');
    assert.equal(toastCalls.length, 1);
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
    Toast.show = priorToastShow;
  }
});

// --- Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.3) -----------------------
// These tests stub Runtime.eligible directly rather than populating a real
// rate map — Runtime's own formula/parity coverage lives in
// tests/modules/routing/runtime-client.test.mjs; this file only exercises
// the gantt.mts drag-commit call sites that consume it.

function _enableRoutingForPlant(plant) {
  const priorMasterData = Store.masterData;
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, routing_runtime_enabled: true }] }, 'test');
  Store.serverOffsetMs = new Date('2026-08-01T00:00:00').getTime() - Date.now();   // restored by the afterEach hook above
  return priorMasterData;
}

test('Interaction._onDataSetUpdate rejects a single-item drag when Runtime.eligible is false: the item springs back via Timeline._scheduleRebuild and the no-routing toast fires, no Store write', () => {
  const priorToastShow = Toast.show;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorEligible = Runtime.eligible;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.no_routing_at_workcenter': '{{order}} has no routing operation at {{machine}} — move blocked.' } };
  const plant = 'P-ROUTING-DRAG';
  const priorMasterData = _enableRoutingForPlant(plant);
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  let scheduleRebuildCalled = false;
  Timeline._scheduleRebuild = () => { scheduleRebuildCalled = true; };
  let eligibleCalls = [];
  // A line move is judged by the drop rule (D4): no PV covers the target row -> reject.
  const priorDropDecision = Runtime.dropDecision;
  Runtime.dropDecision = (task, machine) => { eligibleCalls.push(machine); return { kind: 'reject' }; };

  const id = 'routing-drag-single';
  const line = 'ROUTING-DRAG-L1';
  const otherLine = 'ROUTING-DRAG-L2';
  const start = new Date('2026-09-21T08:00:00');
  const end = new Date('2026-09-21T10:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'A-9201', ORDER: 'A-9201', PLANT: plant,
    MACHINE: line, RUN_TIME: 2, start_date: start, end_date: end,
  }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start, end, group: otherLine } : undefined) };

  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.deepEqual(eligibleCalls, [otherLine]);
    assert.equal(Store.tasks[id].MACHINE, line, 'the order must stay on its original machine');
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
    assert.equal(scheduleRebuildCalled, true, 'the existing spring-back mechanism must be invoked to revert the visual position');
    assert.equal(toastCalls.length, 1, 'the no-routing toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9201/);
    assert.match(toastCalls[0].msg, new RegExp(otherLine));
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Toast.show = priorToastShow;
    Runtime.eligible = priorEligible;
    Runtime.dropDecision = priorDropDecision;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Interaction._onDataSetUpdate skips the routing eligibility guard on a plant that has not enabled the feature — the drag commits normally', () => {
  const priorEligible = Runtime.eligible;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const plant = 'P-ROUTING-DISABLED-DRAG';
  const priorMasterData = Store.masterData;
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, routing_runtime_enabled: false }] }, 'test');
  Store.serverOffsetMs = new Date('2026-08-01T00:00:00').getTime() - Date.now();   // restored by the afterEach hook
  Alerts.scheduleRecompute = () => {};
  let eligibleCalls = 0;
  Runtime.eligible = () => { eligibleCalls++; return false; };

  const id = 'routing-drag-disabled';
  const line = 'ROUTING-DISABLED-L1';
  const otherLine = 'ROUTING-DISABLED-L2';
  const start = new Date('2026-09-21T08:00:00');
  const end = new Date('2026-09-21T10:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'A-9202', ORDER: 'A-9202', PLANT: plant,
    MACHINE: line, RUN_TIME: 2, start_date: start, end_date: end,
  }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start, end, group: otherLine } : undefined) };

  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(eligibleCalls, 0, 'Runtime.eligible must not be consulted for a plant with the switch off');
    assert.equal(Store.tasks[id].MACHINE, otherLine, 'the move must be accepted normally');
  } finally {
    Timeline._items = undefined;
    Runtime.eligible = priorEligible;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Interaction._onDataSetUpdate: a multi-drag whose DRAGGED item is routing-ineligible reverts the whole selection atomically', () => {
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorToastShow = Toast.show;
  const priorEligible = Runtime.eligible;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.no_routing_at_workcenter': '{{order}} has no routing operation at {{machine}} — move blocked.' } };
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._scheduleRebuild = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  const plant = 'P-ROUTING-MULTI';
  const priorMasterData = _enableRoutingForPlant(plant);
  const line = 'ROUTING-MULTI-L1';
  const anchorId = 'routing-multi-anchor';
  const companionId = 'routing-multi-companion';
  const anchorStart = new Date('2026-09-21T08:00:00');
  const anchorEnd = new Date('2026-09-21T10:00:00');
  const companionStart = new Date('2026-09-21T09:00:00');
  const companionEnd = new Date('2026-09-21T11:00:00');

  Store.setTasks([
    { id: anchorId, PRODUCTION_ORDER: 'A-9203', ORDER: 'A-9203', PLANT: plant, MACHINE: line, RUN_TIME: 2, start_date: anchorStart, end_date: anchorEnd },
    { id: companionId, PRODUCTION_ORDER: 'B-9203', PLANT: plant, MACHINE: line, RUN_TIME: 2, start_date: companionStart, end_date: companionEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  // Only the dragged item (anchorId) is ineligible; the companion never gets asked.
  Runtime.eligible = (task) => task.id !== anchorId;
  let itemsUpdateCalled = false;
  // A time-only multi-drag (D5: a multi-drag never changes line): the dragged bar slides 1h on its own row.
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: new Date(anchorStart.getTime() + 3600000), end: new Date(anchorEnd.getTime() + 3600000), group: line } : undefined),
    update: () => { itemsUpdateCalled = true; },
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });
    assert.equal(Store.tasks[anchorId].MACHINE, line, 'the ineligible dragged item must stay on its machine');
    assert.equal(Store.tasks[companionId].MACHINE, line, 'the companion must NOT be moved either — atomic revert');
    assert.equal(itemsUpdateCalled, false, 'no companion Timeline item mirror update should happen when the batch is rejected');
    assert.equal(toastCalls.length, 1, 'exactly one toast, naming the first (dragged) offender');
    assert.match(toastCalls[0].msg, /A-9203/);
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Runtime.eligible = priorEligible;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
    Toast.show = priorToastShow;
    Store.setMasterData(priorMasterData, 'test');
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
  }
});

test('Interaction._onDataSetUpdate: a multi-drag whose COMPANION is routing-ineligible reverts the whole selection atomically, naming the companion', () => {
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorScheduleRebuild = Timeline._scheduleRebuild;
  const priorToastShow = Toast.show;
  const priorEligible = Runtime.eligible;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.no_routing_at_workcenter': '{{order}} has no routing operation at {{machine}} — move blocked.' } };
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._scheduleRebuild = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };

  const plant = 'P-ROUTING-MULTI-2';
  const priorMasterData = _enableRoutingForPlant(plant);
  const line = 'ROUTING-MULTI-L3';
  const anchorId = 'routing-multi-anchor2';
  const companionId = 'routing-multi-companion2';
  const anchorStart = new Date('2026-09-21T08:00:00');
  const anchorEnd = new Date('2026-09-21T10:00:00');
  const companionStart = new Date('2026-09-21T09:00:00');
  const companionEnd = new Date('2026-09-21T11:00:00');

  Store.setTasks([
    { id: anchorId, PRODUCTION_ORDER: 'A-9204', PLANT: plant, MACHINE: line, RUN_TIME: 2, start_date: anchorStart, end_date: anchorEnd },
    { id: companionId, PRODUCTION_ORDER: 'B-9204', PLANT: plant, MACHINE: line, RUN_TIME: 2, start_date: companionStart, end_date: companionEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  // The dragged anchor is eligible; only the companion is not.
  Runtime.eligible = (task) => task.id !== companionId;
  // A line change now always re-resolves the run time from routing (D9), so the anchor needs a resolvable pair too.
  const priorResolve = Runtime.resolve;
  Runtime.resolve = () => ({ ok: true, hours: 2, basis: { source: 'routing' } });
  let itemsUpdateCalled = false;
  Timeline._items = {
    get: (i) => (i === anchorId ? { start: new Date(anchorStart.getTime() + 3600000), end: new Date(anchorEnd.getTime() + 3600000), group: line } : undefined),
    update: () => { itemsUpdateCalled = true; },
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });
    assert.equal(Store.tasks[anchorId].MACHINE, line, 'the dragged anchor must not commit either — atomic revert');
    assert.equal(Store.tasks[companionId].MACHINE, line, 'the ineligible companion stays on its machine');
    assert.equal(itemsUpdateCalled, false, 'no Timeline item mirror update should happen when the batch is rejected');
    assert.equal(toastCalls.length, 1, 'exactly one toast, naming the companion offender');
    assert.match(toastCalls[0].msg, /B-9204/);
  } finally {
    Timeline._items = undefined;
    Timeline._scheduleRebuild = priorScheduleRebuild;
    Runtime.eligible = priorEligible;
    Runtime.resolve = priorResolve;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
    Toast.show = priorToastShow;
    Store.setMasterData(priorMasterData, 'test');
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
  }
});

test('Timeline._itemForTask adds dist-child for any sub-order and the letter·count pill only for a lettered child', () => {
  const priorPlant = Store.selectedPlant;
  const plant = 'P-DIST-BAR';
  Store.setSelectedPlant(plant, 'test');
  Store.setTasks([
    { id: 'bar-a', PLANT: plant, PRODUCTION_ORDER: 'A-9103', ORDER: 'A-9103', PARENT_ORDER: '9103', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1', start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'bar-b', PLANT: plant, PRODUCTION_ORDER: 'B-9103', ORDER: 'B-9103', PARENT_ORDER: '9103', DISTRIBUTION_LETTER: 'B', MACHINE: 'L2', start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'bar-bare', PLANT: plant, PRODUCTION_ORDER: 'C-9104', ORDER: 'C-9104', PARENT_ORDER: '9104', DISTRIBUTION_LETTER: null, MACHINE: 'L3', start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
  ], 'test');
  try {
    const letteredItem = Timeline._itemForTask(Store.tasks['bar-a']);
    assert.match(letteredItem.className, /\bdist-child\b/);
    assert.match(letteredItem.content, /class="split-order-part dist-part"/);
    assert.match(letteredItem.content, new RegExp('A·2'), 'pill must read A·2 for two living siblings');

    const bareItem = Timeline._itemForTask(Store.tasks['bar-bare']);
    assert.match(bareItem.className, /\bdist-child\b/, 'the bare 100% child still gets the inset-keyline class');
    assert.doesNotMatch(bareItem.content, /dist-part/, 'a bare child has no letter, so no pill is rendered');
  } finally {
    Store.setTasks([], 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('Interaction._applyDistSiblingHighlight adds .dist-sibling to items sharing PARENT_ORDER with the current selection, and clears it once selection moves away', () => {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'test');
  const line = 'DIST-SIB-L';
  Store.setTasks([
    { id: 'sib-a', PARENT_ORDER: '9105', DISTRIBUTION_LETTER: 'A', MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'sib-b', PARENT_ORDER: '9105', DISTRIBUTION_LETTER: 'B', MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'sib-other', PARENT_ORDER: null, MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
  ], 'test');

  const classNames = { 'sib-a': 'order-standard', 'sib-b': 'order-standard', 'sib-other': 'order-standard' };
  Timeline._items = {
    get: (i) => (classNames[i] != null ? { className: classNames[i] } : undefined),
    update: (updates) => {
      const arr = Array.isArray(updates) ? updates : [updates];
      arr.forEach(u => { classNames[u.id] = u.className; });
    },
  };

  try {
    Interaction._applyDistSiblingHighlight(['sib-a']);
    assert.match(classNames['sib-b'], /\bdist-sibling\b/, 'sib-b shares PARENT_ORDER with the selected sib-a');
    assert.doesNotMatch(classNames['sib-a'], /dist-sibling/, 'the selected item itself is not marked as its own sibling');
    assert.doesNotMatch(classNames['sib-other'], /dist-sibling/);

    Interaction._applyDistSiblingHighlight(['sib-other']);
    assert.doesNotMatch(classNames['sib-b'], /dist-sibling/, 'the highlight must clear once selection moves away');
  } finally {
    Timeline._items = undefined;
    Store.setTasks([], 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('D51: a rebuild that strips .dist-sibling (fresh className, stale tracked ids) is corrected by resetting and re-applying the highlight', () => {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'test');
  const line = 'DIST-SIB-REBUILD-L';
  Store.setTasks([
    { id: 'rb-sib-a', PARENT_ORDER: '9106', DISTRIBUTION_LETTER: 'A', MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'rb-sib-b', PARENT_ORDER: '9106', DISTRIBUTION_LETTER: 'B', MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
  ], 'test');

  const classNames = { 'rb-sib-a': 'order-standard', 'rb-sib-b': 'order-standard' };
  Timeline._items = {
    get: (i) => (classNames[i] != null ? { className: classNames[i] } : undefined),
    update: (updates) => {
      const arr = Array.isArray(updates) ? updates : [updates];
      arr.forEach(u => { classNames[u.id] = u.className; });
    },
  };

  try {
    Interaction._applyDistSiblingHighlight(['rb-sib-a']);
    assert.match(classNames['rb-sib-b'], /\bdist-sibling\b/, 'highlight applied before the simulated rebuild');

    // Simulate rebuild()'s diff-flush: it rewrites every item's className from
    // scratch via _itemForTask (no highlight awareness), stripping the class,
    // while Interaction._distSiblingItemIds still (wrongly, pre-D51) names
    // the now-stale item id.
    classNames['rb-sib-b'] = 'order-standard';

    // The D51 fix: rebuild()'s selection re-sync resets the tracked set and
    // re-applies the highlight from the resynced selection (`keep`).
    Interaction._distSiblingItemIds = new Set();
    Interaction._applyDistSiblingHighlight(['rb-sib-a']);

    assert.match(classNames['rb-sib-b'], /\bdist-sibling\b/, 'the highlight must be restored after the rebuild strip');
  } finally {
    Timeline._items = undefined;
    Store.setTasks([], 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('D51: Timeline._itemPatchFor restores .dist-sibling for an id the highlight set still tracks (single-item patch path, e.g. a drag commit)', () => {
  const priorPlant = Store.selectedPlant;
  const priorDistSiblingIds = Interaction._distSiblingItemIds;
  Store.setSelectedPlant(null, 'test');
  const line = 'DIST-SIB-PATCH-L';
  Store.setTasks([
    { id: 'patch-sib-a', PARENT_ORDER: '9107', DISTRIBUTION_LETTER: 'A', MACHINE: line, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
  ], 'test');
  try {
    // _itemForTask itself has no highlight awareness (matches the rebuild test above).
    const fresh = Timeline._itemForTask(Store.tasks['patch-sib-a']);
    assert.doesNotMatch(fresh.className, /dist-sibling/);

    Interaction._distSiblingItemIds = new Set(['patch-sib-a']);
    const patch = Timeline._itemPatchFor('patch-sib-a');
    assert.match(patch.className, /\bdist-sibling\b/, '_itemPatchFor must restore the tracked highlight');

    Interaction._distSiblingItemIds = new Set();
    const unhighlighted = Timeline._itemPatchFor('patch-sib-a');
    assert.doesNotMatch(unhighlighted.className, /dist-sibling/, 'only ids still in the tracked set get the class appended');
  } finally {
    Interaction._distSiblingItemIds = priorDistSiblingIds;
    Store.setTasks([], 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('#33 Timeline._itemForTask re-applies the active Gantt filter dimming so a rebuild cannot silently un-dim bars', () => {
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  Store.setTasks([
    { id: 'dim-red',  PRODUCTION_ORDER: 'D1', MATERIAL_NUMBER: 'M1', MACHINE: 'L1', plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED',  FORM_SIZE: 'S' },
    { id: 'dim-blue', PRODUCTION_ORDER: 'D2', MATERIAL_NUMBER: 'M2', MACHINE: 'L1', plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'BLUE', FORM_SIZE: 'S' },
  ], 'test');
  try {
    assert.doesNotMatch(Timeline._itemForTask(Store.tasks['dim-blue']).className, /\bdimmed\b/, 'no filter active: nothing dimmed');
    GanttFilter._selectedColors.add('RED');
    assert.doesNotMatch(Timeline._itemForTask(Store.tasks['dim-red']).className, /\bdimmed\b/, 'matching task stays undimmed');
    assert.match(Timeline._itemForTask(Store.tasks['dim-blue']).className, /\bdimmed\b/, 'non-matching task is dimmed by the builder itself');
  } finally {
    GanttFilter._selectedColors.clear();
  }
});

// ---------------------------------------------------------------------------
// Task 8 (SAP-is-truth firming): Delete / Unschedule is one saved action —
// the order goes to Needs Planning (SAP's dates stay on the row for
// reference) and is refused on manual-firmed, frozen and running orders.
// ---------------------------------------------------------------------------
function _unscheduleFixture(extra = []) {
  // A plant needs a valid zone to have a clock (OQ52): the running order below is judged against it.
  Store.setMasterData({ lines: [], ...Store.masterData, plants: [{ plant: '5512', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }] }, 'test');
  const farStart = new Date('2035-03-01T08:00:00');
  const farEnd   = new Date('2035-03-01T12:00:00');
  const mk = (id, over = {}) => ({
    id, PRODUCTION_ORDER: id, MATERIAL_NUMBER: 'M', MACHINE: 'L1', plant: '5512', PLANT: '5512',
    user_scheduled: true, start_date: farStart, end_date: farEnd, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
    original_start_date: new Date('2035-02-27T08:00:00'), original_end_date: new Date('2035-02-27T12:00:00'),
    ...over,
  });
  Store.setTasks([mk('un-ok'), mk('un-manual'), mk('un-frozen'), mk('un-running', {
    user_scheduled: true, start_date: new Date(Date.now() - 3600_000), end_date: new Date(Date.now() + 3600_000),
  }), mk('un-split', { scheduleSegments: [
    { sequence: 1, startDate: farStart, endDate: farEnd }, { sequence: 2, startDate: new Date('2035-03-02T08:00:00'), endDate: new Date('2035-03-02T12:00:00') },
  ] }), ...extra], 'test');
  Store.setFirmed(['un-manual'], true, 'test');
}

function _stubUnscheduleSideEffects() {
  const priors = { toast: Toast.show, recompute: Alerts.scheduleRecompute, frozen: Engine.isFrozenHorizon };
  const calls = { toasts: [], recomputes: 0 };
  Toast.show = (msg, type) => { calls.toasts.push({ msg, type }); };
  Alerts.scheduleRecompute = () => { calls.recomputes += 1; };
  Engine.isFrozenHorizon = (t) => t.id === 'un-frozen';
  return { calls, restore() {
    Toast.show = priors.toast; Alerts.scheduleRecompute = priors.recompute; Engine.isFrozenHorizon = priors.frozen;
  } };
}

test('Interaction._unscheduleSelected sends an eligible order to Needs Planning with the planner_unscheduled reason', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    Selection.clear();
    Selection.set(['un-ok']);
    Interaction._unscheduleSelected();
    const t = Store.tasks['un-ok'];
    assert.equal(t.start_date, null);
    assert.equal(t.end_date, null);
    assert.equal(t.planning_status, 'needs_planning');
    assert.deepEqual(t.planning_reason, { code: 'planner_unscheduled', message: 'Unscheduled by planner' });
    assert.deepEqual(t.scheduleSegments, []);
    assert.equal(t.original_end_date.getTime(), new Date('2035-02-27T12:00:00').getTime(), "SAP's dates stay on the row");
    assert.equal(stub.calls.recomputes, 1, 'Alerts.scheduleRecompute must be called');
  } finally { stub.restore(); Selection.clear(); }
});

test('Interaction._unscheduleSelected refuses manual-firmed, frozen and running orders', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    for (const id of ['un-manual', 'un-frozen', 'un-running']) {
      const before = Store.tasks[id].start_date;
      Selection.clear();
      Selection.set([id]);
      Interaction._unscheduleSelected();
      assert.equal(Store.tasks[id].start_date, before, `${id} must keep its slot`);
      assert.notEqual(Store.tasks[id].planning_status, 'needs_planning', `${id} must not be sent to Needs Planning`);
    }
    assert.equal(stub.calls.toasts.length, 3);
    assert.ok(stub.calls.toasts.every(c => c.type === 'warn'));
  } finally { stub.restore(); Selection.clear(); }
});

test('Interaction._unscheduleSelected keeps refusing split orders and leaves them intact', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    Selection.clear();
    Selection.set(['un-split']);
    Interaction._unscheduleSelected();
    assert.ok(Store.tasks['un-split'].start_date, 'split order keeps its dates');
    assert.equal(Store.tasks['un-split'].scheduleSegments.length, 2);
    assert.equal(stub.calls.toasts.at(-1).type, 'warn');
  } finally { stub.restore(); Selection.clear(); }
});

test('Interaction._unscheduleSelected is undoable: undo restores dates and scheduled status', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    const start = Store.tasks['un-ok'].start_date.getTime();
    Selection.clear();
    Selection.set(['un-ok']);
    Interaction._unscheduleSelected();
    assert.equal(Store.tasks['un-ok'].planning_status, 'needs_planning');
    UndoStack.pop();
    const t = Store.tasks['un-ok'];
    assert.equal(t.start_date.getTime(), start);
    assert.notEqual(t.planning_status, 'needs_planning');
    assert.equal(t.planning_reason ?? null, null);
  } finally { stub.restore(); Selection.clear(); }
});

test('Interaction._unscheduleSelected mixed selection unschedules only the eligible orders and recomputes alerts', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    Selection.clear();
    Selection.set(['un-ok', 'un-manual', 'un-running']);
    Interaction._unscheduleSelected();
    assert.equal(Store.tasks['un-ok'].planning_status, 'needs_planning');
    assert.ok(Store.tasks['un-manual'].start_date);
    assert.ok(Store.tasks['un-running'].start_date);
    assert.equal(stub.calls.recomputes, 1);
  } finally { stub.restore(); Selection.clear(); }
});

test('Interaction.unscheduleIds (the palette entry point) applies the same guard and patch for an explicit id list', () => {
  _unscheduleFixture();
  const stub = _stubUnscheduleSideEffects();
  try {
    Selection.clear();
    Interaction.unscheduleIds(['un-ok', 'un-manual', 'un-frozen', 'un-running', 'un-split']);
    assert.equal(Store.tasks['un-ok'].planning_status, 'needs_planning');
    for (const id of ['un-manual', 'un-frozen', 'un-running', 'un-split']) {
      assert.ok(Store.tasks[id].start_date, `${id} keeps its slot`);
    }
    assert.equal(stub.calls.recomputes, 1);
  } finally { stub.restore(); }
});

test('lockLeftEdge (OQ1): a drag that changes only the start puts the stored start back; every other drag is accepted as is', () => {
  const stored = { id: 'o1', group: 'L1', start: new Date('2026-08-05T08:00:00'), end: new Date('2026-08-05T12:00:00') };
  const left = { ...stored, start: new Date('2026-08-05T06:00:00') };
  assert.equal(lockLeftEdge(left, stored).start.getTime(), stored.start.getTime(), 'left handle: snapped back');
  assert.equal(lockLeftEdge(left, stored).end.getTime(), stored.end.getTime());
  const right = { ...stored, end: new Date('2026-08-05T14:00:00') };
  assert.equal(lockLeftEdge(right, stored), right, 'right handle: accepted');
  const whole = { ...stored, start: new Date('2026-08-05T09:00:00'), end: new Date('2026-08-05T13:00:00') };
  assert.equal(lockLeftEdge(whole, stored), whole, 'whole-bar move: accepted');
  const vertical = { ...stored, group: 'L2' };
  assert.equal(lockLeftEdge(vertical, stored), vertical, 'line change: accepted');
  assert.equal(lockLeftEdge(left, null), left, 'no stored item: nothing to compare with');
});

test('Timeline._nowFor judges an order against its own plant clock; the viewer clock only when the plant has no zone (Task 2.4 carry-in)', () => {
  const restoreClock = pinPlantClock(['TZ-GANTT-NOW'], '2026-08-05T10:00:00');
  try {
    const plantNow = Timeline._nowFor({ PLANT: 'TZ-GANTT-NOW' });
    assert.ok(Math.abs(plantNow.getTime() - new Date('2026-08-05T10:00:00').getTime()) < 5000, 'the pinned plant clock, not the real one');
    const viewer = Timeline._nowFor({ PLANT: 'NOT-IN-MASTER-DATA' });
    assert.ok(Math.abs(viewer.getTime() - Date.now()) < 5000, 'no zone known: the viewer clock');
    // The lock band follows the plant clock: running at 10:00 plant time even though the real clock is far later.
    const running = { id: 'lb', PLANT: 'TZ-GANTT-NOW', user_scheduled: true, start_date: new Date('2026-08-05T09:00:00'), end_date: new Date('2026-08-05T11:00:00') };
    assert.equal(Timeline._inLockBand(running), true);
    assert.equal(Timeline._inLockBand({ ...running, id: 'lb2', start_date: new Date('2026-08-05T06:00:00'), end_date: new Date('2026-08-05T08:00:00') }), false);
  } finally { restoreClock(); }
});

test('U26: inside a rebuild/scan pass Store.plantNow is read once per plant, not once per order', () => {
  const restoreClock = pinPlantClock(['TZ-GANTT-MEMO'], '2026-08-05T10:00:00');
  const realPlantNow = Store.plantNow;
  let calls = 0;
  Store.plantNow = function (plant) { calls++; return realPlantNow.call(this, plant); };
  try {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, PLANT: 'TZ-GANTT-MEMO', MACHINE: 'L1', text: `m${i}`,
      user_scheduled: true, start_date: new Date('2026-08-05T09:00:00'), end_date: new Date('2026-08-05T11:00:00') }));
    for (const t of tasks) Timeline._inLockBand(t);
    assert.equal(calls, 50, 'sanity: outside a pass every order reads the clock');
    calls = 0;
    Timeline._clockMemo = new Map();
    try {
      for (const t of tasks) Timeline._inLockBand(t);
      for (const t of tasks) Timeline._itemForTask(t);
    } finally { Timeline._clockMemo = null; }
    assert.equal(calls, 1, 'one clock read for the whole pass');
  } finally { Store.plantNow = realPlantNow; restoreClock(); }
});

test('Interaction._onDataSetUpdate: an echo (or a vetoed left-edge drag) on a bar whose derived start is off the 15-minute grid is ignored, with no left-edge toast', () => {
  const id = 'fx-offgrid-1';
  const start = new Date('2026-08-05T08:10:00');   // derived starts are often off the grid
  const end   = new Date('2026-08-05T12:00:00');
  const fx = _stubGanttSideEffects();
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 3.8333 }], 'test');
  Store.updateTask(id, { start_date: start }, 'test');   // a derived start lands off the grid; setTasks would snap it
  assert.equal(Store.tasks[id].start_date.getTime(), start.getTime(), 'sanity: the fixture really is off the grid');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start, end, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(fx.toasts.length, 0);
    assert.equal(fx.rebuilds, 0);
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime());
  } finally { fx.restore(); }
});

// ---------------------------------------------------------------------------
// Backward scheduling Task 3.4 (A.3 #18, gate group 3): resize edges and the keyboard path.
// ---------------------------------------------------------------------------

test('a right-edge resize is a finish move and pushes exactly one undo entry (A.3 #18)', () => {
  const id = 'fx-resize-undo-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Selection.clear();
  UndoStack._entries = [];
  const before = 0;
  Timeline._items = { get: (i) => (i === id ? { start, end: new Date('2026-08-05T14:00:00'), group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].end_date.getTime(), new Date('2026-08-05T14:00:00').getTime());
    assert.equal(UndoStack._entries.length, before + 1);
  } finally { fx.restore(); restoreClock(); }
});

test('G4 / gate 30: the multi-drag ghost preview takes the FINISH delta, so a right-edge resize moves the ghosts of the companions by the delta the commit applies', () => {
  const anchorId = 'ghost-anchor', companionId = 'ghost-companion';
  const aStart = new Date('2026-08-05T08:00:00'), aEnd = new Date('2026-08-05T12:00:00');
  const cStart = new Date('2026-08-06T08:00:00'), cEnd = new Date('2026-08-06T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorItems = Timeline._items, priorTl = Timeline._tl;
  Store.setTasks([
    { id: anchorId, MACHINE: 'L1', PLANT: '5512', RUN_TIME: 4, start_date: aStart, end_date: aEnd },
    { id: companionId, MACHINE: 'L2', PLANT: '5512', RUN_TIME: 4, start_date: cStart, end_date: cEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  const updates = [];
  const priorRaf = globalThis.requestAnimationFrame, priorCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;      // the edge-scroll loop is not under test
  globalThis.cancelAnimationFrame = () => {};
  Timeline._items = {
    get: (i) => (i === companionId ? { id: i, className: '' } : undefined),
    update: (list) => updates.push(...list),
  };
  try {
    // Resize: vis keeps the start (props.time is the start) and moves the end 2 h later on its live item data.
    Timeline._tl = { itemSet: { items: { [anchorId]: { data: { start: aStart, end: new Date('2026-08-05T14:00:00') } } } } };
    Interaction._onTimeChange({ id: anchorId, time: aStart, group: 'L1' });
    assert.equal(updates.length, 1, 'the companion gets a ghost');
    assert.equal(updates[0].start.getTime(), cStart.getTime() + 2 * 3600000, 'ghost start shifted by the finish delta');
    assert.equal(updates[0].end.getTime(), cEnd.getTime() + 2 * 3600000);
    // Body drag: both edges move together, the same delta on either basis.
    updates.length = 0;
    Timeline._tl = { itemSet: { items: { [anchorId]: { data: { start: new Date('2026-08-05T09:00:00'), end: new Date('2026-08-05T13:00:00') } } } } };
    Interaction._onTimeChange({ id: anchorId, time: new Date('2026-08-05T09:00:00'), group: 'L1' });
    assert.equal(updates[0].start.getTime(), cStart.getTime() + 3600000);
  } finally {
    Interaction._clearGhosts();
    globalThis.requestAnimationFrame = priorRaf; globalThis.cancelAnimationFrame = priorCaf;
    Timeline._items = priorItems; Timeline._tl = priorTl;
    fx.restore(); restoreClock(); Selection.clear();
  }
});

test('U27: a companion ghost takes the width the drop derives (backward walk), not the stored width shifted', () => {
  const anchorId = 'ghost-u27-anchor', companionId = 'ghost-u27-companion';
  const aStart = new Date('2026-08-05T08:00:00'), aEnd = new Date('2026-08-05T12:00:00');
  const cStart = new Date('2026-08-06T08:00:00'), cEnd = new Date('2026-08-06T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorItems = Timeline._items, priorTl = Timeline._tl, priorPatch = Engine.manualRoutingSchedulePatchFor;
  Store.setTasks([
    { id: anchorId, MACHINE: 'L1', PLANT: '5512', RUN_TIME: 4, start_date: aStart, end_date: aEnd },
    { id: companionId, MACHINE: 'L1', PLANT: '5512', RUN_TIME: 4, start_date: cStart, end_date: cEnd },
  ], 'test');
  Selection.set([anchorId, companionId]);
  const updates = [], calls = [];
  const priorRaf = globalThis.requestAnimationFrame, priorCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  Timeline._items = { get: i => (i === companionId ? { id: i, className: '' } : undefined), update: list => updates.push(...list) };
  // The drop's derivation across a closed day: the 4 h run starts the evening before and ends at the translated finish.
  const derivedStart = new Date('2026-08-07T22:00:00'), derivedEnd = new Date('2026-08-10T02:00:00');
  Engine.manualRoutingSchedulePatchFor = (task, line, finish, opts) => { calls.push({ id: task.id, line, finish, opts }); return { start_date: derivedStart, end_date: derivedEnd }; };
  try {
    Timeline._tl = { itemSet: { items: { [anchorId]: { data: { start: aStart, end: new Date('2026-08-05T14:00:00') } } } } };
    Interaction._onTimeChange({ id: anchorId, time: aStart, group: 'L1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, companionId);
    assert.equal(calls[0].finish.getTime(), cEnd.getTime() + 2 * 3600000, 'the translated finish, as the drop computes it');
    assert.equal(calls[0].opts.quiet, true, 'a 60 fps preview never toasts a refusal');
    assert.equal(updates[0].start.getTime(), derivedStart.getTime());
    assert.equal(updates[0].end.getTime(), derivedEnd.getTime(), 'ghost width equals the dropped bar width');
    // No derivation (null): the translated stored edges are the fallback.
    updates.length = 0;
    Engine.manualRoutingSchedulePatchFor = () => null;
    Interaction._onTimeChange({ id: anchorId, time: aStart, group: 'L1' });
    assert.equal(updates[0].start.getTime(), cStart.getTime() + 2 * 3600000);
  } finally {
    Engine.manualRoutingSchedulePatchFor = priorPatch;
    Interaction._clearGhosts();
    globalThis.requestAnimationFrame = priorRaf; globalThis.cancelAnimationFrame = priorCaf;
    Timeline._items = priorItems; Timeline._tl = priorTl;
    fx.restore(); restoreClock(); Selection.clear();
  }
});

test('a resize that derives the bar it already was creates no undo entry, no Store write, and springs back (A.3 #18)', () => {
  const id = 'fx-resize-noop-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorPatch = Engine.manualRoutingSchedulePatchFor;
  const priorUpdate = Store.updateTask;
  const writes = [];
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Selection.clear();
  UndoStack._entries = [];
  const before = 0;
  Timeline._items = { get: (i) => (i === id ? { start, end: new Date('2026-08-05T14:00:00'), group: 'L1' } : undefined) };
  // The engine answers with the very bar the order already is (the dragged finish resolves back onto it).
  Engine.manualRoutingSchedulePatchFor = () => ({ start_date: start, end_date: end, MACHINE: 'L1', scheduleSegments: [] });
  Store.updateTask = (...args) => { writes.push(args); return priorUpdate.apply(Store, args); };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(UndoStack._entries.length, before, 'no undo entry');
    assert.equal(writes.length, 0, 'nothing written, so nothing dirtied');
    assert.equal(fx.rebuilds, 1, 'the bar springs back to where it was');
    assert.equal(fx.toasts.length, 0, 'not an error');
  } finally {
    Engine.manualRoutingSchedulePatchFor = priorPatch;
    Store.updateTask = priorUpdate;
    fx.restore(); restoreClock();
  }
});

test('G3: the Gantt keyboard handler selects but writes no dates; date edits stay on the finish-anchored grid/Inspector path', () => {
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorPatch = Engine.manualRoutingSchedulePatchFor;
  const priorUpdate = Store.updateTask;
  const priorUpdateMany = Store.updateMany;
  const calls = [];
  Store.setTasks([
    { id: 'kb-a', MACHINE: 'L1', PLANT: '5512', start_date: new Date('2026-08-05T08:00:00'), end_date: new Date('2026-08-05T12:00:00'), RUN_TIME: 4 },
    { id: 'kb-b', MACHINE: 'L1', PLANT: '5512', start_date: new Date('2026-08-05T13:00:00'), end_date: new Date('2026-08-05T15:00:00'), RUN_TIME: 2 },
  ], 'test');
  Selection.set(['kb-a']);
  Engine.manualRoutingSchedulePatchFor = (...a) => { calls.push('patch'); return priorPatch.apply(Engine, a); };
  Store.updateTask = (...a) => { calls.push('update'); return priorUpdate.apply(Store, a); };
  Store.updateMany = (...a) => { calls.push('updateMany'); return priorUpdateMany.apply(Store, a); };
  try {
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
      Interaction._onKeyDown({ key, target: { tagName: 'DIV' }, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {} });
    }
    assert.deepEqual(calls, [], 'arrows move the selection only');
    assert.equal(Store.tasks['kb-a'].end_date.getTime(), new Date('2026-08-05T12:00:00').getTime());
    assert.equal(Store.tasks['kb-b'].end_date.getTime(), new Date('2026-08-05T15:00:00').getTime());
  } finally {
    Engine.manualRoutingSchedulePatchFor = priorPatch;
    Store.updateTask = priorUpdate; Store.updateMany = priorUpdateMany;
    fx.restore(); restoreClock();
  }
});

test('a drag asks the engine for the FINISH (third argument is the dropped right edge), the same call the grid and Inspector make', () => {
  const id = 'fx-drag-finish-1';
  const start = new Date('2026-08-05T08:00:00');
  const end   = new Date('2026-08-05T12:00:00');
  const restoreClock = pinPlantClock(['5512']);
  const fx = _stubGanttSideEffects();
  const priorPatch = Engine.manualRoutingSchedulePatchFor;
  const seen = [];
  Store.setTasks([{ id, MACHINE: 'L1', PLANT: '5512', start_date: start, end_date: end, RUN_TIME: 4 }], 'test');
  Selection.clear();
  Timeline._items = { get: (i) => (i === id ? { start: new Date('2026-08-05T10:00:00'), end: new Date('2026-08-05T14:00:00'), group: 'L1' } : undefined) };
  Engine.manualRoutingSchedulePatchFor = (task, line, finish, opts) => { seen.push(finish); return priorPatch.call(Engine, task, line, finish, opts); };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].getTime(), new Date('2026-08-05T14:00:00').getTime());
  } finally {
    Engine.manualRoutingSchedulePatchFor = priorPatch;
    fx.restore(); restoreClock();
  }
});

/* ---- W5: non-working-time shading ---- */
const NW_PLANT = 'NW-PLANT';
function nwWithPlant(fn) {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(NW_PLANT, 'unit-test');
  Store.ensurePlant(NW_PLANT);
  // Mon-Fri 06:00-18:00, weekend closed.
  for (let d = 0; d < 7; d++) Store.setPlantWorkHours(NW_PLANT, d, (d === 0 || d === 6) ? null : [6, 18], 'unit-test');
  const prior = { range: Timeline._nwRange, ids: Timeline._nwIds, items: Timeline._items, tl: Timeline._tl };
  try { return fn(); } finally {
    Timeline._nwRange = prior.range; Timeline._nwIds = prior.ids; Timeline._items = prior.items; Timeline._tl = prior.tl;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
}
function nwFakeItems() {
  const records = new Map();
  const calls = { add: [], update: [], remove: [] };
  return {
    records, calls,
    getIds: () => [...records.keys()],
    get: id => records.get(String(id)) ?? null,
    add: items => { calls.add.push(items.map(i => i.id)); for (const i of items) records.set(i.id, i); },
    update: items => { calls.update.push(items.map(i => i.id)); for (const i of items) records.set(i.id, i); },
    remove: ids => { calls.remove.push([...ids]); for (const id of ids) records.delete(String(id)); },
  };
}
const NW_DAY = 24 * 3600 * 1000;

test('Timeline._nonWorkingDesired: ungrouped zone background items, class nonworking, ids by local day key of the span start', () => nwWithPlant(() => {
  const from = new Date(2026, 7, 3).getTime(); // Mon 2026-08-03
  const items = Timeline._nonWorkingDesired({ fromMs: from, toMs: from + 8 * NW_DAY });
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal('group' in it, false, 'no group (ungrouped BackgroundGroup item)');
    assert.equal(it.kind, 'zone');
    assert.equal(it.type, 'background');
    assert.equal(it.className, 'nonworking');
    assert.equal(it.editable, false);
    const midnight = it.start.getHours() === 0 && it.start.getMinutes() === 0;
    assert.equal(it.id, `nonworking-${Util.dayKey(it.start)}${midnight ? '' : '-t'}`);
  }
  assert.equal(new Set(items.map(i => i.id)).size, items.length, 'ids are unique');
  const weekend = items.find(i => i.start.getTime() === new Date(2026, 7, 7, 18).getTime());
  assert.equal(weekend.id, 'nonworking-2026-08-07-t');
  assert.equal(weekend.end.getTime(), new Date(2026, 7, 10, 6).getTime(), 'Fri evening merges through the weekend to Monday 06:00');
}));

test('Timeline._nonWorkingDesired: a range past 90 days is coarse (closed days only)', () => nwWithPlant(() => {
  const from = new Date(2026, 7, 3).getTime();
  const items = Timeline._nonWorkingDesired({ fromMs: from, toMs: from + 100 * NW_DAY });
  assert.ok(items.length > 0);
  for (const it of items) assert.equal(it.start.getHours(), 0, 'only whole-day spans in coarse mode');
}));

test('Timeline._syncNonWorking: a pan inside the hysteresis band makes no writes', () => nwWithPlant(() => {
  const fake = nwFakeItems(); Timeline._items = fake;
  const ws = new Date(2026, 7, 10).getTime();
  let win = { start: new Date(ws), end: new Date(ws + 2 * NW_DAY) };
  Timeline._tl = { getWindow: () => win };
  Timeline._nwRange = null; Timeline._nwIds = new Set();
  Timeline._syncNonWorking(true);
  assert.ok(fake.records.size > 0);
  const w0 = fake.calls.add.length + fake.calls.update.length + fake.calls.remove.length;
  win = { start: new Date(ws + 1 * NW_DAY), end: new Date(ws + 3 * NW_DAY) }; // margin is 7d: well inside
  Timeline._syncNonWorking(false);
  assert.equal(fake.calls.add.length + fake.calls.update.length + fake.calls.remove.length, w0, 'no writes');
}));

test('Timeline._syncNonWorking: a pan past the band adds/removes edge items only and keeps interior ids', () => nwWithPlant(() => {
  const fake = nwFakeItems(); Timeline._items = fake;
  const ws = new Date(2026, 7, 10).getTime();
  let win = { start: new Date(ws), end: new Date(ws + 2 * NW_DAY) };
  Timeline._tl = { getWindow: () => win };
  Timeline._nwRange = null; Timeline._nwIds = new Set();
  Timeline._syncNonWorking(true);
  const before = new Set(fake.records.keys());
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  win = { start: new Date(ws + 5 * NW_DAY), end: new Date(ws + 7 * NW_DAY) }; // outside the hysteresis band
  Timeline._syncNonWorking(false);
  const addedIds = fake.calls.add.flat(), removedIds = fake.calls.remove.flat();
  assert.ok(addedIds.length > 0 && removedIds.length > 0, 'edges moved');
  const interior = [...before].filter(id => !removedIds.includes(id));
  assert.ok(interior.length > 0, 'interior ids survive');
  for (const id of interior) assert.ok(fake.records.has(id));
  assert.ok(fake.calls.update.flat().length <= 2, 'only the cover-edge spans are rewritten, not every interior item');
  assert.deepEqual([...Timeline._nwIds].sort(), [...fake.records.keys()].sort(), '_nwIds tracks exactly the live nonworking items');
}));

test('Timeline._rebuildPass keeps the nonworking items _syncNonWorking added (no delete-then-re-add)', () => nwWithPlant(() => {
  const fake = nwFakeItems(); Timeline._items = fake;
  const groups = { ids: [], getIds() { return this.ids; }, add() {}, update() {}, remove() {} };
  const priorGroups = Timeline._groups, priorRender = Timeline._renderEmptyOverlay, priorFit = Timeline._fitHeight, priorRefresh = Timeline._refreshViewNow;
  const priorTasks = structuredClone(Store.tasksArr);
  const ws = new Date(2026, 7, 10).getTime();
  const win = { start: new Date(ws), end: new Date(ws + 2 * NW_DAY) };
  Timeline._tl = { getWindow: () => win, setSelection() {}, setWindow() {}, setOptions() {}, redraw() {}, addCustomTime() {}, removeCustomTime() {}, setCustomTime() {}, setCustomTimeMarker() {} };
  Timeline._groups = groups; Timeline._renderEmptyOverlay = () => {}; Timeline._fitHeight = () => {}; Timeline._refreshViewNow = () => {};
  Timeline._nwRange = null; Timeline._nwIds = new Set();
  Store.setTasks([], 'unit-test');
  const priorRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  const priorNimbus = globalThis.NIMBUS;
  globalThis.NIMBUS = priorNimbus ?? {};
  try {
    Timeline._syncNonWorking(true);
    const nwBefore = [...fake.records.keys()].filter(id => id.startsWith('nonworking-'));
    assert.ok(nwBefore.length > 0);
    fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
    Timeline._rebuildPass();
    const removed = fake.calls.remove.flat();
    for (const id of nwBefore) assert.ok(!removed.includes(id), `${id} not removed by the rebuild diff`);
    assert.deepEqual([...fake.records.keys()].filter(id => id.startsWith('nonworking-')).sort(), [...nwBefore].sort());
    assert.deepEqual([...Timeline._nwIds].sort(), [...nwBefore].sort());
  } finally {
    globalThis.requestAnimationFrame = priorRaf;
    if (priorNimbus === undefined) delete globalThis.NIMBUS;
    Timeline._groups = priorGroups; Timeline._renderEmptyOverlay = priorRender; Timeline._fitHeight = priorFit; Timeline._refreshViewNow = priorRefresh;
    Store.setTasks(priorTasks, 'unit-test');
  }
}));

test('the DataView filter still passes background items (the type === background exemption is intact)', () => {
  const src = readFileSync(new URL('../../../frontend/scheduling/gantt.mts', import.meta.url), 'utf8');
  assert.match(src, /filter:\s*\(item: TimelineVisItem\) => \{\s*if \(item\.type === 'background'\) return true;/);
});

test('TimelineNav items subscription: a remove event whose oldData is all zone items does not repaint; a non-zone remove does', () => {
  const priorItems = Timeline._items, priorAttached = TimelineNav._itemsSubAttached, priorSched = TimelineNav._scheduleFrame, priorDirty = TimelineNav._dirty;
  let cb = null, frames = 0;
  Timeline._items = { on: (_ev, fn) => { cb = fn; }, get: () => null };
  TimelineNav._itemsSubAttached = false;
  TimelineNav._scheduleFrame = () => { frames++; };
  try {
    TimelineNav._wireItemsSubscription();
    cb('remove', { items: ['nonworking-2026-08-08'], oldData: [{ id: 'nonworking-2026-08-08', kind: 'zone' }] });
    assert.equal(frames, 0, 'zone-only remove skipped');
    cb('remove', { items: ['a', 'b'], oldData: [{ id: 'a', kind: 'zone' }, { id: 'b', kind: 'order' }] });
    assert.equal(frames, 1, 'a mixed remove repaints');
    cb('remove', { items: ['c'] });
    assert.equal(frames, 2, 'no oldData falls back to repainting');
  } finally {
    Timeline._items = priorItems; TimelineNav._itemsSubAttached = priorAttached; TimelineNav._scheduleFrame = priorSched; TimelineNav._dirty = priorDirty;
  }
});

test('Timeline._syncNonWorking: zooming in from a coarse (>90d) range rebuilds fine shading even inside the position band', () => nwWithPlant(() => {
  const fake = nwFakeItems(); Timeline._items = fake;
  const ws = new Date(2026, 7, 3).getTime();
  let win = { start: new Date(ws), end: new Date(ws + 60 * NW_DAY) }; // 60d window -> 180d range: coarse
  Timeline._tl = { getWindow: () => win };
  Timeline._nwRange = null; Timeline._nwIds = new Set();
  Timeline._syncNonWorking(true);
  const partial = () => [...fake.records.values()].filter(i => i.start.getHours() !== 0);
  assert.equal(partial().length, 0, 'coarse: whole-day spans only');
  win = { start: new Date(ws + 40 * NW_DAY), end: new Date(ws + 42 * NW_DAY) }; // inside the band, now fine
  Timeline._syncNonWorking(false);
  assert.ok(partial().length > 0, 'off-shift hours appear after the zoom-in');
  assert.ok(Timeline._nwRange.toMs - Timeline._nwRange.fromMs <= 90 * NW_DAY);
}));
/* ---- Expandable rows fix wave (blockers, heal ladder, lane bookkeeping) ---- */

// Runs fn with a stubbed vis surface around Timeline._rebuildPass: fake item/group DataSets that record every
// write, two overlapping orders on one line, and the DOM-only collaborators stubbed out.
function laneRebuildHarness(fn) {
  return nwWithPlant(() => {
    const fake = nwFakeItems(); Timeline._items = fake;
    const gcalls = { add: [], update: [], remove: [] };
    const gids = new Set();
    const groups = {
      getIds: () => [...gids],
      add: gs => { gcalls.add.push(gs); for (const g of gs) gids.add(String(g.id)); },
      update: gs => { gcalls.update.push(gs); },
      remove: ids => { gcalls.remove.push([ids].flat()); for (const id of [ids].flat()) gids.delete(String(id)); },
    };
    const prior = {
      groups: Timeline._groups, render: Timeline._renderEmptyOverlay, fit: Timeline._fitHeight, refresh: Timeline._refreshViewNow,
      label: Timeline._groupLabel, expanded: Timeline._expandedLine, laneIds: Timeline._laneIds, heal: Timeline._healCount,
      toast: Timeline._healToastShown, sched: Timeline._scheduleRebuild, raf: globalThis.requestAnimationFrame, nimbus: globalThis.NIMBUS,
      tasks: structuredClone(Store.tasksArr), labelKeys: Timeline._labelKeys,
    };
    const win = { start: new Date(2026, 7, 10), end: new Date(2026, 7, 12) };
    Timeline._tl = { getWindow: () => win, setSelection() {}, setWindow() {}, setOptions() {}, redraw() {}, addCustomTime() {}, removeCustomTime() {}, setCustomTime() {}, setCustomTimeMarker() {} };
    Timeline._groups = groups; Timeline._renderEmptyOverlay = () => {}; Timeline._fitHeight = () => {}; Timeline._refreshViewNow = () => true;
    Timeline._groupLabel = (line, _c, depth, expanded) => ({ el: {}, key: `${line}|${depth}|${expanded}` });
    Timeline._laneIds = new Set(); Timeline._labelKeys = new Map(); Timeline._healCount = 0; Timeline._healToastShown = false;
    Timeline._nwRange = null; Timeline._nwIds = new Set(); Timeline._expandedLine = null;
    globalThis.requestAnimationFrame = () => 0;
    globalThis.NIMBUS = prior.nimbus ?? {};
    const at = (h, m = 0) => new Date(2026, 7, 10, h, m);
    Store.setTasks([
      { id: 'lane-a', PRODUCTION_ORDER: 'LA', MATERIAL_NUMBER: 'M', MACHINE: 'L-A', PLANT: NW_PLANT, plant: NW_PLANT, start_date: at(7), end_date: at(11), RUN_TIME: 4, COLOR: 'RED' },
      { id: 'lane-b', PRODUCTION_ORDER: 'LB', MATERIAL_NUMBER: 'M', MACHINE: 'L-A', PLANT: NW_PLANT, plant: NW_PLANT, start_date: at(9), end_date: at(13), RUN_TIME: 4, COLOR: 'RED' },
    ], 'unit-test');
    try { return fn({ fake, groups, gcalls }); } finally {
      globalThis.requestAnimationFrame = prior.raf;
      if (prior.nimbus === undefined) delete globalThis.NIMBUS;
      Timeline._groups = prior.groups; Timeline._renderEmptyOverlay = prior.render; Timeline._fitHeight = prior.fit; Timeline._refreshViewNow = prior.refresh;
      Timeline._groupLabel = prior.label; Timeline._expandedLine = prior.expanded; Timeline._laneIds = prior.laneIds; Timeline._healCount = prior.heal;
      Timeline._healToastShown = prior.toast; Timeline._scheduleRebuild = prior.sched; Timeline._labelKeys = prior.labelKeys;
      Store.setTasks(prior.tasks, 'unit-test');
    }
  });
}

test('Timeline._rebuildPass: a group className is never falsy (vis nulls "" and addClassName(null) throws on the collapse)', () => laneRebuildHarness(({ gcalls }) => {
  Timeline._rebuildPass(); // collapsed: depth 2 but not expanded
  Timeline._expandedLine = 'L-A';
  Timeline._rebuildPass(); // expanded
  Timeline._expandedLine = null;
  Timeline._rebuildPass(); // collapsed again (the toggle that used to throw)
  const classes = [...gcalls.add.flat(), ...gcalls.update.flat()].map(g => g.className);
  assert.ok(classes.length >= 3);
  for (const c of classes) assert.ok(typeof c === 'string' && c.length > 0, `className "${c}" must be a non-empty string`);
  assert.ok(classes.includes('row-expanded') && classes.includes('row-flat'));
}));

test('Timeline lane bookkeeping: _laneIds follows lane writes and laned items are relocated by remove + add on collapse', () => laneRebuildHarness(({ fake }) => {
  Timeline._expandedLine = 'L-A';
  Timeline._rebuildPass();
  const laned = [...fake.records.values()].filter(i => i.subgroup !== undefined).map(i => String(i.id));
  assert.ok(laned.length >= 2, 'both overlapping orders were added with a lane');
  for (const id of laned) assert.ok(Timeline._laneIds.has(id), `${id} tracked in _laneIds`);

  // Collapse: every laned item must be removed + re-added (never updated), and _laneIds empties.
  Timeline._expandedLine = null;
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  const removed = fake.calls.remove.flat(), updated = fake.calls.update.flat();
  for (const id of laned) {
    assert.ok(removed.includes(id), `${id} relocated by remove`);
    assert.ok(!updated.includes(id), `${id} never updated across a subgroup change`);
  }
  assert.equal([...Timeline._laneIds].filter(id => laned.includes(id)).length, 0, '_laneIds cleared for relocated items');
}));

test('Timeline lane bookkeeping: a straggler left in a NON-expanded row with a lane is still relocated', () => laneRebuildHarness(({ fake }) => {
  Timeline._expandedLine = 'L-A';
  Timeline._rebuildPass();
  const id = [...fake.records.values()].find(i => i.subgroup !== undefined).id;
  // vis moved the bar to another row on a drag and left its subgroup behind; the page then collapses.
  fake.records.set(String(id), { ...fake.records.get(String(id)), group: 'L-B' });
  Timeline._expandedLine = null;
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  assert.ok(fake.calls.remove.flat().includes(String(id)), 'straggler removed (then re-added) by the rebuild diff');
  assert.ok(fake.calls.add.flat().includes(String(id)));
  assert.equal(fake.records.get(String(id)).subgroup, undefined);
  assert.ok(!Timeline._laneIds.has(String(id)));
}));

test('Timeline._splitRelocations: an item never stored with a lane does no DataSet read (the scale guard)', () => {
  const prior = { items: Timeline._items, ids: Timeline._laneIds };
  let reads = 0;
  Timeline._items = { get: () => { reads++; return { subgroup: undefined }; } };
  Timeline._laneIds = new Set(['laned']);
  try {
    const out = Timeline._splitRelocations([{ id: 'plain', subgroup: undefined }, { id: 'laned', subgroup: undefined }]);
    assert.equal(reads, 1, 'only the id in _laneIds is compared against the stored item');
    assert.equal(out.update.length, 2);
  } finally { Timeline._items = prior.items; Timeline._laneIds = prior.ids; }
});

test('bulkTouchesExpandedLine: an old or new line equal to the expanded line forces a rebuild; no expanded line never does', () => {
  const old = { a: 'L-1', b: 'L-2', c: 'L-3' }, next = { a: 'L-1', b: 'L-9', c: 'L-2' };
  const o = id => old[id], n = id => next[id];
  assert.equal(bulkTouchesExpandedLine(['a'], null, o, n), false, 'nothing expanded');
  assert.equal(bulkTouchesExpandedLine(['b'], 'L-2', o, n), true, 'left the expanded line');
  assert.equal(bulkTouchesExpandedLine(['c'], 'L-2', o, n), true, 'entered the expanded line');
  assert.equal(bulkTouchesExpandedLine(['a'], 'L-2', o, n), false, 'unrelated lines');
});

test('Timeline._onStore tasks:bulkUpdate: a batch touching the expanded line schedules a rebuild instead of patching', () => laneRebuildHarness(() => {
  const priorActive = Timeline._ganttActive, priorWrite = Timeline._writePatches;
  let scheduled = 0, patched = 0;
  Timeline._ganttActive = () => true;
  Timeline._scheduleRebuild = () => { scheduled++; };
  Timeline._writePatches = () => { patched++; };
  try {
    Timeline._expandedLine = 'L-A';
    Timeline._onStore({ type: 'tasks:bulkUpdate', ids: ['lane-a'], source: 'optimizer' });
    assert.equal(scheduled, 1, 'rebuild scheduled for an id on the expanded line');
    assert.equal(patched, 0);
  } finally { Timeline._ganttActive = priorActive; Timeline._writePatches = priorWrite; }
}));

test('Timeline._reapplySelection: a null _tl is a no-op; a live one re-applies the selected items inside _suppressEvents', () => {
  const prior = { tl: Timeline._tl, items: Timeline._items, fn: Timeline.itemIdsForTask };
  const priorIds = Selection.ids();
  try {
    Timeline._tl = null;
    assert.doesNotThrow(() => Timeline._reapplySelection());
    let seen = null, suppressed = null;
    Timeline._items = { get: id => ({ id }) };
    Timeline._tl = { setSelection: ids => { seen = ids; suppressed = Timeline._suppressEvents; } };
    Selection.set(['sel-1']);
    Timeline.itemIdsForTask = id => [`${id}#a`, `${id}#b`];
    Timeline._reapplySelection();
    assert.deepEqual(seen, ['sel-1#a', 'sel-1#b']);
    assert.equal(suppressed, true);
    assert.equal(Timeline._suppressEvents, false, 'flag restored');
  } finally { Timeline._tl = prior.tl; Timeline._items = prior.items; Timeline.itemIdsForTask = prior.fn; Selection.set(priorIds); }
});

test('companionWritesDeferred: skipped only while a row is expanded', () => {
  assert.equal(companionWritesDeferred(null), false);
  assert.equal(companionWritesDeferred('L-A'), true);
});

test('Timeline heal ladder: a flush throw removes groups then items one at a time, schedules one rebuild, then clears the expanded row, then asks for a reload', () => laneRebuildHarness(({ fake, groups }) => {
  Timeline._expandedLine = 'L-A';
  Timeline._rebuildPass(); // populate items
  assert.ok(fake.records.size > 0);
  const order = [];
  const origGroupsRemove = groups.remove;
  groups.remove = ids => { order.push('groups'); origGroupsRemove(ids); };
  const origRemove = fake.remove;
  fake.remove = ids => { order.push(`item:${[ids].flat().join(',')}`); origRemove(ids); };
  let scheduled = 0;
  Timeline._scheduleRebuild = () => { scheduled++; };
  const toasts = [];
  const priorToast = Toast.show; Toast.show = (m, t) => { toasts.push([m, t]); };
  const origUpdate = groups.update;
  const origAdd = groups.add; groups.update = () => { throw new Error('vis: className'); }; groups.add = () => { throw new Error('vis: className'); };
  try {
    Timeline._rebuildPass();
    assert.equal(Timeline._healCount, 1);
    assert.equal(scheduled, 1, 'exactly one rebuild scheduled');
    assert.equal(order[0], 'groups', 'groups are removed before any item');
    assert.ok(order.length > 1 && order.slice(1).every(s => s.startsWith('item:') && !s.includes(',')), 'items removed one at a time');
    assert.equal(Timeline._expandedLine, 'L-A', 'first failure keeps the expanded row');
    assert.equal(Timeline._laneIds.size, 0);

    Timeline._rebuildPass(); // second consecutive failure
    assert.equal(Timeline._healCount, 2);
    assert.equal(Timeline._expandedLine, null, 'second failure clears the sticky expanded row');
    assert.equal(scheduled, 2);

    Timeline._rebuildPass(); // third: stop retrying, ask for a reload (once)
    Timeline._rebuildPass();
    assert.equal(scheduled, 2, 'no further automatic retry');
    assert.equal(toasts.length, 1, 'the reload toast shows once');
    assert.equal(toasts[0][1], 'error');

    groups.update = origUpdate; groups.add = origAdd; // recovery: a clean pass resets the ladder
    Timeline._rebuildPass();
    assert.equal(Timeline._healCount, 0);
    assert.equal(Timeline._healToastShown, false);
  } finally { Toast.show = priorToast; }
}));

test('Timeline._purgeItemSetGhosts (validator finding 1): removes ItemSet ids absent from _items, tolerates a throwing _removeItem, guards missing vis state', () => laneRebuildHarness(({ fake }) => {
  fake.records.set('live-1', { id: 'live-1' });
  const parent = { removed: [], removeChild(n) { this.removed.push(n); } };
  const dom = { box: { parentNode: parent } };
  const removedViaVis = [];
  const itemSet = {
    items: { 'live-1': { id: 'live-1' }, ghost1: { id: 'ghost1' }, ghost2: { id: 'ghost2', dom } },
    selection: ['ghost2', 'live-1'],
    _removeItem(item) {
      if (item.id === 'ghost2') throw new Error('group.remove: orderSubgroups');
      removedViaVis.push(item.id); delete this.items[item.id];
    },
  };
  Timeline._tl.itemSet = itemSet;
  Timeline._purgeItemSetGhosts();
  assert.deepEqual(Object.keys(itemSet.items), ['live-1'], 'only the live item survives');
  assert.deepEqual(removedViaVis, ['ghost1']);
  assert.deepEqual(itemSet.selection, ['live-1'], 'ghost dropped from the selection');
  assert.equal(parent.removed.length, 1, 'the throwing ghost had its DOM detached');
  // Missing vis private state is a no-op.
  Timeline._tl.itemSet = undefined; Timeline._purgeItemSetGhosts();
  Timeline._tl.itemSet = {}; Timeline._purgeItemSetGhosts();
  // The heal calls the purge.
  Timeline._tl.itemSet = { items: { stale: { id: 'stale' } }, selection: [], _removeItem(i) { delete this.items[i.id]; } };
  Timeline._scheduleRebuild = () => {};
  Timeline._heal('unit', new Error('x'));
  assert.deepEqual(Object.keys(Timeline._tl.itemSet.items), []);
}));

test('Timeline._writePatches (validator finding 2): a vis throw during relocate routes to _heal with the affected scope and clears _laneIds', () => laneRebuildHarness(({ fake }) => {
  Timeline._laneIds.add('lane-a');
  fake.records.set('lane-a', { id: 'lane-a', group: 'L-A', subgroup: 'lane-1' });
  const origRemove = fake.remove;
  fake.remove = () => { throw new Error('vis: orderSubgroups'); };
  const calls = [];
  const origHeal = Timeline._heal;
  Timeline._heal = (stage, err, scope) => { calls.push({ stage, err, scope }); origHeal.call(Timeline, stage, err, scope); };
  Timeline._scheduleRebuild = () => {};
  try {
    assert.doesNotThrow(() => Timeline._writePatches([{ id: 'lane-a', group: 'L-A', subgroup: undefined }]));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stage, 'write-patches');
    assert.deepEqual(calls[0].scope.groupIds, ['L-A']);
    assert.deepEqual(calls[0].scope.itemIds, ['lane-a']);
    assert.equal(Timeline._laneIds.size, 0, 'heal cleared the stale lane bookkeeping');
    assert.equal(Timeline._suppressEvents, false);
  } finally { Timeline._heal = origHeal; fake.remove = origRemove; }
}));

/* ---- Go To centering (scrollToLine vertical, _gotoWindowFor horizontal) and the spotlight ---- */

// 20 rows of 30 px in a 300 px viewport; `rowH` overrides a row's height, `boxes` maps a vis item id to a
// {row, top, height} box (top measured relative to the top of its row). Returns the recorded _setScrollTop writes.
function _scrollRig(t, { rowH = {}, boxes = {} } = {}) {
  const priorTl = Timeline._tl;
  const priorLines = Timeline._visibleLines;
  const priorVScrollTop = Timeline._vScrollTop;
  const priorQSA = globalThis.document.querySelectorAll;
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const tops = [];
  let y = 0;
  const groups = lines.map((l) => {
    const h = rowH[l] ?? 30;
    const top = y; y += h; tops.push(top);
    return { getBoundingClientRect: () => ({ top, height: h }) };
  });
  const writes = [];
  const items = {};
  for (const [id, { row, top, height }] of Object.entries(boxes)) {
    items[id] = { dom: { box: { getBoundingClientRect: () => ({ top: tops[lines.indexOf(row)] + top, height }) } } };
  }
  Timeline._tl = { props: { centerContainer: { height: 300 } }, itemSet: { items }, _setScrollTop(v) { writes.push(v); }, _getScrollTop() { return 0; } };
  Timeline._visibleLines = () => lines;
  globalThis.document.querySelectorAll = () => groups;
  t.after(() => {
    Timeline._tl = priorTl; Timeline._visibleLines = priorLines; Timeline._vScrollTop = priorVScrollTop;
    delete globalThis.document.querySelectorAll;
    if (priorQSA) globalThis.document.querySelectorAll = priorQSA;
  });
  return writes;
}

test('Timeline.scrollToLine centers the row and clamps the top and bottom rows', (t) => {
  const writes = _scrollRig(t);
  assert.equal(Timeline.scrollToLine('L10'), true);
  assert.equal(writes.at(-1), -135, 'L10: row center (285) minus half the viewport');
  assert.equal(Timeline._vScrollTop, -135);
  Timeline.scrollToLine('L1');
  assert.ok(Object.is(writes.at(-1), 0), 'L1 clamps to the top (+0, never -0)');
  Timeline.scrollToLine('L20');
  assert.equal(writes.at(-1), -300, 'L20 clamps to the bottom (content 600 - viewport 300)');
});

test('Timeline.scrollToLine refuses while fewer groups are rendered than visible lines', (t) => {
  const writes = _scrollRig(t);
  globalThis.document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ top: 0, height: 30 }) }];
  assert.equal(Timeline.scrollToLine('L10'), false);
  assert.deepEqual(writes, []);
});

test('Timeline.scrollToLine centers the target lane inside an expanded row', (t) => {
  // L5 is expanded to 4 lanes of 30 px (row 120 px); the target bar sits in lane 3 (top 60).
  const writes = _scrollRig(t, { rowH: { L5: 120 }, boxes: { 'task-a': { row: 'L5', top: 60, height: 30 } } });
  Timeline.scrollToLine('L5', { itemIds: ['task-a'] });
  // rowTop 120 + lane 60 + half lane 15 = 195; minus 150
  assert.equal(writes.at(-1), -45);
  Timeline.scrollToLine('L5');
  assert.equal(writes.at(-1), -30, 'without an item the whole row (center 180) is centered');
});

test('Timeline.scrollToLine centers the midpoint of a pairwise alert\'s two rows when both fit', (t) => {
  const writes = _scrollRig(t);
  Timeline.scrollToLine('L10', { peerLine: 'L12' });
  // rows span 270..360 -> midpoint 315 - 150
  assert.equal(writes.at(-1), -165);
  Timeline.scrollToLine('L10', { peerLine: 'L20' });
  assert.equal(writes.at(-1), -135, 'rows too far apart to fit: the alert\'s own row is centered');
});

function _spanHarness(t, defs) {
  for (const d of defs) Store._state.tasks[d.id] = d;
  t.after(() => { for (const d of defs) delete Store._state.tasks[d.id]; });
}

test('Timeline._gotoWindowFor centers the order and keeps all of it in view', (t) => {
  _spanHarness(t, [{ id: 'gw-1', MACHINE: 'L1', start_date: new Date('2026-08-11T12:00:00'), end_date: new Date('2026-08-13T12:00:00') }]);
  const w = Timeline._gotoWindowFor('2026-08-12', ['gw-1']);
  const mid = (w.start + w.end) / 2;
  assert.ok(Math.abs(mid - new Date('2026-08-12T12:00:00').getTime()) <= 60000, 'window midpoint is the order midpoint');
  assert.ok(w.start <= new Date('2026-08-11T12:00:00').getTime() && w.end >= new Date('2026-08-13T12:00:00').getTime());
  assert.equal(w.end - w.start, 3 * 24 * 3600 * 1000, 'a short order keeps the 3-day floor');
});

test('Timeline._gotoWindowFor widens for a long order and spans split segments', (t) => {
  _spanHarness(t, [
    { id: 'gw-2', MACHINE: 'L1', start_date: new Date('2026-08-10T00:00:00'), end_date: new Date('2026-08-16T00:00:00') },
    { id: 'gw-3', MACHINE: 'L1', start_date: new Date('2026-08-12T00:00:00'), end_date: new Date('2026-08-20T00:00:00'),
      scheduleSegments: [
        { sequence: 1, startDate: new Date('2026-08-12T00:00:00'), endDate: new Date('2026-08-12T08:00:00') },
        { sequence: 2, startDate: new Date('2026-08-19T00:00:00'), endDate: new Date('2026-08-20T00:00:00') },
      ] },
  ]);
  const six = Timeline._gotoWindowFor('2026-08-12', ['gw-2']);
  assert.ok(six.end - six.start >= 7.2 * 24 * 3600 * 1000 - 1000, '6-day order gets >= 7.2 days');
  const split = Timeline._gotoWindowFor('2026-08-12', ['gw-3']);
  assert.ok(split.start <= new Date('2026-08-12T00:00:00').getTime() && split.end >= new Date('2026-08-20T00:00:00').getTime(), 'every segment is inside');
});

test('Timeline._gotoWindowFor contains both orders of a pairwise alert and the alert day', (t) => {
  _spanHarness(t, [
    { id: 'gw-a', MACHINE: 'L1', start_date: new Date('2026-08-10T08:00:00'), end_date: new Date('2026-08-10T20:00:00') },
    { id: 'gw-b', MACHINE: 'L2', start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T20:00:00') },
  ]);
  const w = Timeline._gotoWindowFor('2026-08-14', ['gw-a', 'gw-b']);
  assert.ok(w.start <= new Date('2026-08-10T08:00:00').getTime() && w.end >= new Date('2026-08-14T20:00:00').getTime());
  const day = new Date('2026-08-14T00:00:00').getTime();
  assert.ok(w.start <= day && w.end >= day + 24 * 3600 * 1000, 'alert day inside');
});

test('Timeline._gotoWindowFor with no dated order centers the alert day (not the left third)', () => {
  const w = Timeline._gotoWindowFor('2026-08-12');
  assert.equal((w.start + w.end) / 2, new Date('2026-08-12T12:00:00').getTime());
  assert.deepEqual(Timeline._gotoWindowFor('2026-08-12', ['no-such-order']), w);
});

test('Go To spotlight: markGotoTask adds goto-spotlight + goto-row, clearGotoTarget removes them', (t) => {
  const { task } = _gotoHarness(t);
  const mk = () => { const s = new Set(); return { s, classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) } }; };
  const container = mk();
  const groupRow = mk(); const labelRow = mk(); const otherGroup = mk();
  const priorVisEl = Timeline._visEl;
  const priorLines = Timeline._visibleLines;
  Timeline._visibleLines = () => ['L-A', 'L-GOTO'];
  Timeline._visEl = {
    classList: container.classList,
    querySelectorAll(sel) {
      if (sel === '.vis-foreground .vis-group') return [otherGroup, groupRow];
      if (sel === '.vis-labelset .vis-label') return [mk(), labelRow];
      if (sel === '.goto-row') return [otherGroup, groupRow, labelRow].filter(n => n.s.has('goto-row'));
      return [];
    },
  };
  t.after(() => { Timeline.clearGotoTarget(); Timeline._visEl = priorVisEl; Timeline._visibleLines = priorLines; });
  Timeline.markGotoTask(task.id);
  assert.ok(container.s.has('goto-spotlight'));
  assert.ok(groupRow.s.has('goto-row') && labelRow.s.has('goto-row'), 'the target line row and label are tinted');
  assert.ok(!otherGroup.s.has('goto-row'));
  assert.notEqual(Timeline._spotlightTimer, null);
  Timeline.clearGotoTarget();
  assert.ok(!container.s.has('goto-spotlight'));
  assert.ok(!groupRow.s.has('goto-row') && !labelRow.s.has('goto-row'));
  assert.equal(Timeline._spotlightTimer, null);
  Timeline._endSpotlight(); // idempotent
});

test('Go To spotlight is a no-op without a timeline element and held while gotoLineDay is settling', (t) => {
  const { task } = _gotoHarness(t);
  assert.equal(Timeline._visEl, null);
  Timeline.markGotoTask(task.id);   // must not throw
  assert.equal(Timeline._spotlightTimer, null);
  const spy = [];
  const priorSpot = Timeline._spotlight;
  Timeline._spotlight = (l) => spy.push(l);
  Timeline._gotoSettling = true;
  t.after(() => { Timeline._spotlight = priorSpot; Timeline._gotoSettling = false; Timeline.clearGotoTarget(); });
  Timeline.markGotoTask(task.id);
  assert.deepEqual(spy, [], 'held until the final scroll');
  Timeline._gotoSettling = false;
  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  assert.deepEqual(spy, ['L-GOTO']);
});

test('Timeline._gotoWindowFor: an alert early in a day does not drag the window off the order midpoint', (t) => {
  // Order spans Aug 10 08:00 -> Aug 12 02:00; alert day Aug 12 only overlaps its last 2 hours.
  _spanHarness(t, [{ id: 'gw-e', MACHINE: 'L1', start_date: new Date('2026-08-10T08:00:00'), end_date: new Date('2026-08-12T02:00:00') }]);
  const w = Timeline._gotoWindowFor('2026-08-12', ['gw-e']);
  const mid = (new Date('2026-08-10T08:00:00').getTime() + new Date('2026-08-12T02:00:00').getTime()) / 2;
  assert.ok(Math.abs((w.start + w.end) / 2 - mid) <= 60000, 'stays centered on the order midpoint');
  assert.ok(w.end >= new Date('2026-08-12T02:00:00').getTime(), 'the alert-day overlap is inside');
});

test('Go To marks record the Go To generation so a later Go To does not spotlight a stale target', (t) => {
  const { task } = _gotoHarness(t);
  t.after(() => { Timeline._gotoSettling = false; Timeline.clearGotoTarget(); });
  Timeline._gotoSeq += 1;
  Timeline.markGotoTask(task.id);
  assert.equal(Timeline._gotoMarkSeq, Timeline._gotoSeq, 'marking records the generation');
  Timeline._gotoSeq += 1;                       // a newer Go To that marked nothing: finish() must not spotlight
  assert.notEqual(Timeline._gotoMarkSeq, Timeline._gotoSeq);
  Timeline.markGotoCell('L-GOTO', '2026-08-12');
  assert.equal(Timeline._gotoMarkSeq, Timeline._gotoSeq, 'markGotoCell records it too');
});

test('Timeline._rebuildPass restores a Go To\'s target window, not getWindow() (a mid-animation frame)', () => laneRebuildHarness(() => {
  const A = new Date(2026, 7, 10).getTime(), B = new Date(2026, 7, 12).getTime();
  const X = new Date(2026, 9, 26).getTime(), Y = new Date(2026, 9, 28).getTime();
  const writes = [];
  Object.assign(Timeline._tl, {
    getWindow: () => ({ start: new Date(A), end: new Date(B) }),
    setWindow(s, e, o) { writes.push([s.getTime(), e.getTime(), o]); },
  });
  const priorGw = Timeline._gotoWin;
  try {
    Timeline._gotoWin = { start: X, end: Y };
    Timeline._rebuildPass();
    assert.deepEqual(writes, [[X, Y, { animation: false }]], 'the Go To target is restored');
    writes.length = 0;
    Timeline._gotoWin = null;
    Timeline._rebuildPass();
    assert.deepEqual(writes, [[A, B, { animation: false }]], 'without a Go To the live window is restored');
  } finally { Timeline._gotoWin = priorGw; }
}));

function _gotoLineDayRig(t) {
  const prior = {
    tl: Timeline._tl, nimbus: globalThis.NIMBUS, scrollToLine: Timeline.scrollToLine, sync: Timeline._syncViewWindow,
    raf: globalThis.requestAnimationFrame, qsa: globalThis.document.querySelectorAll, seq: Timeline._gotoSeq,
  };
  const rig = { listeners: {}, writes: [], live: null, rafQueue: [], scrolls: 0, order: [] };
  Timeline._tl = {
    on(ev, fn) { rig.listeners[ev] = fn; }, off() {},
    setWindow(s, e, o) { rig.writes.push([s.getTime(), e.getTime(), o]); rig.order.push('setWindow'); },
    getWindow: () => rig.live,
    props: { centerContainer: { height: 300 } },
  };
  globalThis.NIMBUS = { ...(prior.nimbus || {}), App: { ...(prior.nimbus?.App || {}), gotoGanttTimeline: () => {} } };
  Timeline.scrollToLine = () => { rig.scrolls += 1; rig.order.push('scroll'); return true; };
  Timeline._syncViewWindow = () => {};
  globalThis.requestAnimationFrame = cb => { rig.rafQueue.push(cb); return rig.rafQueue.length; };
  globalThis.document.querySelectorAll = () => [];
  rig.flushRaf = () => { for (let i = 0; i < 20 && rig.rafQueue.length; i++) rig.rafQueue.shift()(0); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    Timeline._tl = prior.tl; Timeline.scrollToLine = prior.scrollToLine; Timeline._syncViewWindow = prior.sync;
    if (prior.nimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = prior.nimbus;
    globalThis.requestAnimationFrame = prior.raf;
    delete globalThis.document.querySelectorAll;
    if (prior.qsa) globalThis.document.querySelectorAll = prior.qsa;
    Timeline._gotoSeq = prior.seq + 1; Timeline._gotoSettling = false; Timeline._gotoWin = null; Timeline._gotoTarget = null;
  });
  return rig;
}

test('Timeline.gotoLineDay holds its target window while in flight and the 700 ms fallback re-asserts it when the live window is off', (t) => {
  const rig = _gotoLineDayRig(t);
  const day = '2026-10-27';
  const win = Timeline._gotoWindowFor(day, []);
  rig.live = { start: new Date(win.start + 4 * 3600000), end: new Date(win.end + 4 * 3600000) };   // stuck 4 h off, no rangechanged
  Timeline.gotoLineDay('L-GOTO', day);
  t.mock.timers.tick(250);
  assert.deepEqual(Timeline._gotoWin, win, 'the target is held for _rebuildPass');
  assert.deepEqual(rig.writes[0], [win.start, win.end, { animation: { duration: 300 } }]);
  assert.equal(Timeline._gotoSettling, true);
  t.mock.timers.tick(700);
  assert.equal(rig.writes.length, 2, 'exactly one more write');
  assert.deepEqual(rig.writes[1], [win.start, win.end, { animation: false }], 'the fallback re-asserts the target');
  rig.flushRaf();
  assert.ok(rig.scrolls >= 1, 'the scroll ran');
  assert.ok(rig.order.indexOf('scroll') > rig.order.lastIndexOf('setWindow'), 're-assert precedes the scroll');
  assert.equal(Timeline._gotoWin, null);
  assert.equal(Timeline._gotoSettling, false);
});

test('Timeline.gotoLineDay: when rangechanged fires with the window at the target there is no re-assert write', (t) => {
  const rig = _gotoLineDayRig(t);
  const day = '2026-10-27';
  const win = Timeline._gotoWindowFor(day, []);
  rig.live = { start: new Date(win.start), end: new Date(win.end) };
  Timeline.gotoLineDay('L-GOTO', day);
  t.mock.timers.tick(250);
  t.mock.timers.tick(300);
  rig.listeners.rangechanged({ byUser: false });
  t.mock.timers.tick(700);
  rig.flushRaf();
  assert.ok(rig.writes.every(w => w[2].animation !== false), 'no { animation: false } write');
  assert.equal(rig.writes.length, 1);
  assert.ok(rig.scrolls >= 1);
  assert.equal(Timeline._gotoWin, null);
});

test('Timeline._onStore schedules one coalesced rebuild on master-data-changed only while the Gantt is active', () => {
  const priorRebuild = Timeline._scheduleRebuild, priorActive = Timeline._ganttActive;
  let rebuilds = 0;
  try {
    Timeline._scheduleRebuild = () => { rebuilds++; };
    Timeline._ganttActive = () => true;
    Timeline._onStore({ type: 'master-data-changed', source: 'master-data-save', table: 'plants', revision: 1, mode: 'live' });
    assert.equal(rebuilds, 1, 'plant row saved: frozen band / zones must repaint');
    Timeline._ganttActive = () => false;
    Timeline._onStore({ type: 'master-data-changed', source: 'master-data-save', revision: 2, mode: 'live' });
    assert.equal(rebuilds, 1, 'inactive Gantt: the next goto(gantt) rebuilds anyway');
  } finally { Timeline._scheduleRebuild = priorRebuild; Timeline._ganttActive = priorActive; }
});

test('alertCellMapFor: a needs_planning alert paints no Gantt day cell (no bar to anchor, red cells would read as conflicts)', () => {
  const day = new Date(2026, 9, 28, 9);
  const alerts = [
    { id: 'np-1', type: 'needs_planning', sev: 'err', line: 'L1', time: day },
    { id: 'np-2', type: 'needs_planning', sev: 'warn', line: 'L2', time: day },
    { id: 'ov-1', type: 'overlap', sev: 'err', line: 'L3', time: day },
  ];
  const map = alertCellMapFor(alerts, () => true);
  assert.deepEqual(Object.keys(map), ['L3|2026-10-28'], 'only the overlap paints a cell');
  assert.equal(map['L3|2026-10-28'].hasConflictErr, true);
  const hidden = alertCellMapFor(alerts, line => line !== 'L3');
  assert.deepEqual(Object.keys(hidden), [], 'a hidden line paints nothing');
});

// ---- Gantt pan instrumentation (Timeline.frame / Timeline.pan / _panActive / _bench) ----

function _frameRig(t) {
  const prior = { raf: globalThis.requestAnimationFrame };
  const rig = { rafQueue: [] };
  globalThis.requestAnimationFrame = cb => { rig.rafQueue.push(cb); return rig.rafQueue.length; };
  rig.flushRaf = () => { for (let i = 0; i < 20 && rig.rafQueue.length; i++) rig.rafQueue.shift()(0); };
  rig.fakeCore = () => ({ calls: 0, _origRedraw() { this.calls += 1; }, _redraw() {} });
  PerfMonitor.clear();
  t.after(() => {
    globalThis.requestAnimationFrame = prior.raf;
    Timeline._endPanGesture();
    Timeline._lastPan = null;
    PerfMonitor.clear();
  });
  return rig;
}

test('frameMeterSummary: duration, redraw count and max gap', () => {
  assert.deepEqual(frameMeterSummary(100, 400, [120, 130, 190, 200]), { ms: 300, redraws: 4, maxGapMs: 60 });
  assert.deepEqual(frameMeterSummary(100, 400, []), { ms: 300, redraws: 0, maxGapMs: 0 }, 'no redraws still summarises');
  assert.deepEqual(frameMeterSummary(100, 400, [150]), { ms: 300, redraws: 1, maxGapMs: 0 }, 'one stamp has no gap');
  assert.equal(frameMeterSummary(400, 100, [150, 160]).ms, 0, 'end before start clamps to 0');
});

test('installFrameMeter: a timed _origRedraw records one Timeline.frame sample per call and calls the original once', (t) => {
  const rig = _frameRig(t);
  const core = rig.fakeCore();
  assert.equal(installFrameMeter(core), true);
  core._origRedraw();
  assert.equal(core.calls, 1, 'the original ran once, with this preserved');
  assert.equal(PerfMonitor.stats('Timeline.frame').count, 1);
  core._origRedraw();
  assert.equal(PerfMonitor.stats('Timeline.frame').count, 2);
  assert.equal(core.calls, 2);
});

test('installFrameMeter: a throwing redraw still records its sample and the error propagates', (t) => {
  const rig = _frameRig(t);
  const core = { _origRedraw() { throw new Error('boom'); }, _redraw() {} };
  installFrameMeter(core);
  assert.throws(() => core._origRedraw(), /boom/);
  assert.equal(PerfMonitor.stats('Timeline.frame').count, 1);
  assert.equal(rig.rafQueue.length, 0);
});

test('installFrameMeter: the re-created _redraw coalesces many calls in one frame into one _origRedraw and never runs it synchronously', (t) => {
  const rig = _frameRig(t);
  const core = rig.fakeCore();
  installFrameMeter(core);
  core._redraw(); core._redraw(); core._redraw();
  assert.equal(core.calls, 0, 'never synchronous');
  assert.equal(rig.rafQueue.length, 1, 'exactly one requestAnimationFrame for the burst');
  rig.flushRaf();
  assert.equal(core.calls, 1, 'one redraw for the whole burst');
  assert.equal(PerfMonitor.stats('Timeline.frame').count, 1, 'the throttled redraw goes through the timed function');
  core._redraw();
  assert.equal(rig.rafQueue.length, 1, 'a later call schedules a new frame');
  rig.flushRaf();
  assert.equal(core.calls, 2);
});

test('installFrameMeter: a second install is a no-op (no double wrapping)', (t) => {
  const rig = _frameRig(t);
  const core = rig.fakeCore();
  assert.equal(installFrameMeter(core), true);
  const timed = core._origRedraw, throttle = core._redraw;
  assert.equal(installFrameMeter(core), false);
  assert.equal(core._origRedraw, timed, 'not wrapped again');
  assert.equal(core._redraw, throttle, 'throttle not re-created');
  core._origRedraw();
  assert.equal(PerfMonitor.stats('Timeline.frame').count, 1, 'one sample per call');
});

test('installFrameMeter: missing or non-function _origRedraw/_redraw self-disables without throwing and leaves the object untouched', (t) => {
  _frameRig(t);
  const noop = () => {};
  const cases = {
    missingOrig: { _redraw: noop },
    missingRedraw: { _origRedraw: noop },
    nonFunction: { _origRedraw: 1, _redraw: noop },
    frozen: Object.freeze({ _origRedraw: noop, _redraw: noop }),
  };
  for (const [name, core] of Object.entries(cases)) {
    const before = { ...core };
    assert.equal(installFrameMeter(core), false, name);
    assert.deepEqual({ ...core }, before, `${name}: untouched`);
  }
  assert.equal(installFrameMeter(null), false, 'null core');
  const nonWritable = {};
  Object.defineProperty(nonWritable, '_origRedraw', { value: noop, writable: false, enumerable: true });
  Object.defineProperty(nonWritable, '_redraw', { value: noop, writable: true, enumerable: true });
  assert.equal(installFrameMeter(nonWritable), false, 'non-writable');
  assert.equal(nonWritable._origRedraw, noop);
  assert.equal(nonWritable._redraw, noop, 'no half install');
});

test('pan gesture: a panmove rangechange sets _panActive; a wheel rangechange does not; rangechanged(panend) clears it first and records Timeline.pan', (t) => {
  const rig = _frameRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const core = rig.fakeCore();
  installFrameMeter(core);
  const activeAtRecord = [];
  const realRecord = PerfMonitor.record;
  t.mock.method(PerfMonitor, 'record', (name, ms) => { if (name === 'Timeline.pan') activeAtRecord.push(Timeline._panActive); return realRecord(name, ms); });

  Timeline._onVisRangeChange({ byUser: true, event: { type: 'wheel' } });
  Timeline._onVisRangeChange({ byUser: false, event: { type: 'panmove' } });
  Timeline._onVisRangeChange({ byUser: true });
  assert.equal(Timeline._panActive, false, 'only a user panmove counts');

  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  assert.equal(Timeline._panActive, true);
  core._origRedraw(); core._origRedraw();
  Timeline._onVisRangeChanged({ byUser: true, event: { type: 'panend' } });
  assert.equal(Timeline._panActive, false);
  assert.deepEqual(activeAtRecord, [false], 'the flag is cleared before the mark is recorded');
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 1);
  assert.equal(Timeline._lastPan.redraws, 2, 'the redraws inside the gesture are counted');
  assert.ok(Timeline._lastPan.ms >= 0 && Number.isFinite(Timeline._lastPan.maxGapMs));

  Timeline._onVisRangeChanged({ byUser: true, event: { type: 'panend' } });
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 1, 'a rangechanged with no gesture records nothing');
});

test('pan gesture: the 300 ms watchdog ends a gesture whose rangechanged never arrives', (t) => {
  _frameRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  t.mock.timers.tick(299);
  assert.equal(Timeline._panActive, true, 'not yet');
  t.mock.timers.tick(1);
  assert.equal(Timeline._panActive, false, 'watchdog cleared the flag');
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 1, 'and recorded the gesture');

  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  t.mock.timers.tick(200);
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  t.mock.timers.tick(200);
  assert.equal(Timeline._panActive, true, 'a further panmove re-arms the watchdog');
  t.mock.timers.tick(100);
  assert.equal(Timeline._panActive, false);
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 2);
});

test('pan gesture: pointerup/pointercancel ends it and double end is harmless', (t) => {
  _frameRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const priorTl = Timeline._tl, priorWired = Timeline._panDocWired, priorAdd = globalThis.document.addEventListener;
  const docHandlers = {}, tlHandlers = {};
  let docAdds = 0;
  globalThis.document.addEventListener = (type, fn) => { docAdds += 1; docHandlers[type] = fn; };
  Timeline._panDocWired = false;
  const fakeTl = () => ({ on(ev, fn) { tlHandlers[ev] = fn; }, off() {}, _origRedraw() {}, _redraw() {} });
  t.after(() => { Timeline._tl = priorTl; Timeline._panDocWired = priorWired; globalThis.document.addEventListener = priorAdd; });

  Timeline._tl = fakeTl();
  Timeline._wirePanTracking();
  Timeline._tl = fakeTl();
  Timeline._wirePanTracking();
  assert.equal(docAdds, 2, 'pointerup and pointercancel are registered once across two wirings');
  assert.equal(typeof docHandlers.pointerup, 'function');
  assert.equal(typeof docHandlers.pointercancel, 'function');

  tlHandlers.rangechange({ byUser: true, event: { type: 'panmove' } });
  assert.equal(Timeline._panActive, true);
  docHandlers.pointerup({ type: 'pointerup' });
  assert.equal(Timeline._panActive, false);
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 1);

  tlHandlers.rangechange({ byUser: true, event: { type: 'panmove' } });
  docHandlers.pointercancel({ type: 'pointercancel' });
  assert.equal(Timeline._panActive, false);
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 2);

  docHandlers.pointerup({ type: 'pointerup' });
  Timeline._endPanGesture();
  tlHandlers.rangechanged({ byUser: true, event: { type: 'panend' } });
  assert.equal(PerfMonitor.stats('Timeline.pan').count, 2, 'ending twice records nothing more');
});

test('Timeline.pan records a duration only (no count recorded as an ms mark)', (t) => {
  const rig = _frameRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const core = rig.fakeCore();
  installFrameMeter(core);
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  core._origRedraw(); core._origRedraw(); core._origRedraw();
  Timeline._onVisRangeChanged({ byUser: true, event: { type: 'panend' } });
  const names = PerfMonitor.all().map(r => r.name).filter(n => n.startsWith('Timeline.pan')).sort();
  assert.deepEqual(names, ['Timeline.pan', 'Timeline.pan.maxGap'], 'only duration marks exist');
  assert.equal(Timeline._lastPan.redraws, 3, 'the count lives on _lastPan, not in PerfMonitor');
  assert.ok(PerfMonitor.stats('Timeline.pan').last < 1000, 'the mark is a duration in ms, not the count');
});

test('Timeline._bench is callable and returns p50/p95/max/items against a fake timeline', async (t) => {
  const rig = _frameRig(t);
  const priorTl = Timeline._tl, priorQsa = globalThis.document.querySelectorAll, priorTable = console.table;
  let win = { start: 1_000_000_000_000, end: 1_000_000_000_000 + 6 * 3600_000 };
  const sets = [];
  const spin = () => { const t0 = performance.now(); while (performance.now() - t0 < 0.5) { /* a measurable frame */ } };
  const tl = {
    body: { domProps: { center: { width: 1000 } } },
    getWindow: () => ({ start: new Date(win.start), end: new Date(win.end) }),
    setWindow(s, e) { win = { start: s.getTime(), end: e.getTime() }; sets.push({ ...win }); this._origRedraw(); },
    on() {}, off() {}, _origRedraw: spin, _redraw() {},
  };
  const original = { ...win };
  installFrameMeter(tl);
  Timeline._tl = tl;
  globalThis.requestAnimationFrame = cb => { cb(0); return 1; };
  globalThis.document.querySelectorAll = () => new Array(7);
  let tabled = null;
  console.table = (x) => { tabled = x; };
  t.after(() => {
    Timeline._tl = priorTl; console.table = priorTable;
    delete globalThis.document.querySelectorAll;
    if (priorQsa) globalThis.document.querySelectorAll = priorQsa;
  });
  const r = await Timeline._bench({ days: 3, steps: 5, stepPx: 40 });
  assert.equal(r.days, 3);
  assert.equal(r.steps, 5);
  assert.equal(r.items, 7);
  assert.ok(r.p50 > 0 && r.p95 >= r.p50 && r.max >= r.p95, `percentiles ordered: ${JSON.stringify(r)}`);
  assert.equal(r.longTasks, 0);
  assert.equal(tabled, r, 'console.table received the result');
  const step = (3 * 86400_000) / 1000 * 40;
  assert.equal(sets[2].start - sets[1].start, step, 'each step shifts by stepPx converted to ms');
  assert.equal(sets[sets.length - 1].start, original.start, 'the original window is restored');
  assert.equal(sets[sets.length - 1].end, original.end);
  assert.equal(Timeline._frameSamples, null, 'the sample sink is released');
  assert.equal(rig.rafQueue.length, 0);
});

// ---- Alerts-change rebuild gate and pan-deferred alerts rebuild ----

const _sigDay = new Date(2026, 9, 28, 9);
const _sigAlert = (over = {}) => ({ id: 'a', type: 'overlap', sev: 'err', line: 'L1', time: _sigDay, ...over });

test('alertSig: hasConflictErr flips the signature (same line/day/sev, a conflict err vs a calendar err)', () => {
  const conflict = [_sigAlert({ type: 'overlap' })];
  const calendar = [_sigAlert({ type: 'closed' })];
  assert.equal(alertCellMapFor(conflict, () => true)['L1|2026-10-28'].hasConflictErr, true);
  assert.equal(alertCellMapFor(calendar, () => true)['L1|2026-10-28'].hasConflictErr, false, 'precondition: the two lists differ only in hasConflictErr');
  assert.notEqual(alertSig(conflict, () => true), alertSig(calendar, () => true));
});

test('alertSig: task ids no longer count (the plant-wide outline is gone); only the painted cells do', () => {
  const plain = [_sigAlert()];
  const withTask = [_sigAlert({ taskId: 't-1' })];
  assert.deepEqual(alertCellMapFor(plain, () => true), alertCellMapFor(withTask, () => true));
  assert.equal(alertSig(plain, () => true), alertSig(withTask, () => true));
  assert.equal(alertSig(withTask, () => true), alertSig([_sigAlert({ taskId: 't-2' })], () => true), 'a different task id is the same signature');
});

test('alertSig: order independent', () => {
  const list = [
    _sigAlert({ id: '1', line: 'L2', taskId: 't-9' }),
    _sigAlert({ id: '2', line: 'L1', sev: 'warn', type: 'late', taskId: 't-3' }),
    _sigAlert({ id: '3', line: 'L3', time: new Date(2026, 9, 29, 9), taskId: 't-5' }),
  ];
  const a = alertSig(list, () => true);
  assert.equal(alertSig([...list].reverse(), () => true), a);
  assert.equal(alertSig([list[1], list[2], list[0]], () => true), a);
});

test('alertSig: a hidden line\'s alerts add nothing, with or without a taskId', () => {
  const visibleOnly = line => line === 'L1';
  const base = [_sigAlert({ line: 'L1' })];
  const withHidden = [...base, _sigAlert({ id: 'h', line: 'L2' })];
  assert.equal(alertSig(withHidden, visibleOnly), alertSig(base, visibleOnly), 'a hidden line paints no cell and carries no task: no change');
  const hiddenWithTask = [...base, _sigAlert({ id: 'h', line: 'L2', taskId: 't-hidden' })];
  assert.equal(alertSig(hiddenWithTask, visibleOnly), alertSig(base, visibleOnly), 'no outline depends on a hidden-line task id any more');
});

// Saves and restores every Timeline field the gate and the deferral touch, and the globals around them.
function gateRig(t, { active = true } = {}) {
  const keys = ['_taskDataDirty', '_lastAlertSig', '_alertsRebuildPending', '_panActive', '_panGesture', '_panWatchdog',
    '_scheduleRebuild', '_ganttActive', '_applyProfileMatchClasses', '_applyTaskPatch'];
  const prior = Object.fromEntries(keys.map(k => [k, Timeline[k]]));
  const priorAlerts = Store.alerts, priorNimbus = globalThis.NIMBUS;
  globalThis.NIMBUS = priorNimbus ?? {};   // the line predicate reads NIMBUS.GanttFilter (absent = no line filter)
  const rig = { scheduled: 0, profile: 0 };
  Timeline._scheduleRebuild = () => { rig.scheduled++; };
  Timeline._ganttActive = () => active;
  Timeline._applyProfileMatchClasses = () => { rig.profile++; };
  Timeline._applyTaskPatch = () => {};
  Timeline._panActive = false; Timeline._panGesture = null; Timeline._panWatchdog = null;
  Timeline._alertsRebuildPending = false;
  t.after(() => {
    if (Timeline._panWatchdog !== null) clearTimeout(Timeline._panWatchdog);
    for (const k of keys) Timeline[k] = prior[k];
    Store.setAlerts(priorAlerts, 'unit-test');
    if (priorNimbus === undefined) delete globalThis.NIMBUS;
  });
  return rig;
}

test('Timeline._onStore alerts:change: skips the rebuild only when nothing is dirty and the signature matches', (t) => {
  const rig = gateRig(t);
  Store.setAlerts([_sigAlert({ taskId: 't-1' })], 'unit-test');
  const sig = alertSig(Store.alerts, () => true);
  const fire = () => { Timeline._onStore({ type: 'alerts:change', source: 'alerts' }); };

  Timeline._taskDataDirty = false; Timeline._lastAlertSig = sig;
  fire();
  assert.equal(rig.scheduled, 0, 'clean + equal signature: skipped');
  assert.equal(rig.profile, 1, 'the profile-match class diff still runs exactly once on the skip path');

  Timeline._taskDataDirty = true; Timeline._lastAlertSig = sig;
  fire();
  assert.equal(rig.scheduled, 1, 'task data changed since the last rebuild: schedules');
  assert.equal(rig.profile, 1, 'the rebuild path does not call the class diff (rebuild repaints classes itself)');

  Timeline._taskDataDirty = false; Timeline._lastAlertSig = sig + 'x';
  fire();
  assert.equal(rig.scheduled, 2, 'signature differs: schedules');

  Timeline._taskDataDirty = false; Timeline._lastAlertSig = null;
  fire();
  assert.equal(rig.scheduled, 3, 'no stored signature: always schedules');
});

test('Timeline._onStore alerts:change: a hidden Gantt neither rebuilds nor runs the class diff', (t) => {
  const rig = gateRig(t, { active: false });
  Store.setAlerts([_sigAlert()], 'unit-test');
  Timeline._taskDataDirty = false; Timeline._lastAlertSig = alertSig(Store.alerts, () => true);
  Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
  assert.equal(rig.scheduled, 0);
  assert.equal(rig.profile, 0);
});

test('Timeline._onStore: task:update, tasks:bulkUpdate, firmed:change, tasks:bulk, setup-snapshot:replace and task:remove each set _taskDataDirty, including when evt.source is \'timeline\'', (t) => {
  gateRig(t, { active: false });
  const events = [
    { type: 'task:update', id: 't-1' },
    { type: 'tasks:bulkUpdate', ids: ['t-1'] },
    { type: 'firmed:change', ids: ['t-1'] },
    { type: 'tasks:bulk' },
    { type: 'setup-snapshot:replace' },
    { type: 'task:remove', id: 't-1' },
  ];
  for (const source of ['optimizer', 'timeline']) {
    for (const evt of events) {
      Timeline._taskDataDirty = false;
      Timeline._onStore({ ...evt, source });
      assert.equal(Timeline._taskDataDirty, true, `${evt.type} from ${source} marks task data dirty`);
    }
  }
  Timeline._taskDataDirty = false;
  Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
  Timeline._onStore({ type: 'lines:selected', source: 'ui' });
  assert.equal(Timeline._taskDataDirty, false, 'events that carry no task data leave it clean');
});

test('Timeline._onStore: a drop (source timeline) followed by an unchanged alert signature still rebuilds', (t) => {
  const rig = gateRig(t);
  Store.setAlerts([_sigAlert({ taskId: 't-1' })], 'unit-test');
  Timeline._taskDataDirty = false; Timeline._lastAlertSig = alertSig(Store.alerts, () => true);
  Timeline._onStore({ type: 'task:update', id: 't-1', source: 'timeline' });
  assert.equal(Timeline._taskDataDirty, true);
  Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
  assert.equal(rig.scheduled, 1, 'the drop left setup bars and stack badges to this rebuild');
});

test('Timeline._rebuildPass: a clean pass clears _taskDataDirty and stores the signature; a pass whose _refreshViewNow returns false stores neither', () => laneRebuildHarness(() => {
  const priorAlerts = Store.alerts, priorDirty = Timeline._taskDataDirty, priorSig = Timeline._lastAlertSig, priorPending = Timeline._alertsRebuildPending;
  try {
    Store.setAlerts([{ id: 'x1', type: 'overlap', sev: 'err', line: 'L-A', time: new Date(2026, 7, 10, 9), taskId: 'lane-a' }], 'unit-test');
    const expected = alertSig(Store.alerts, () => true);

    Timeline._refreshViewNow = () => false;
    Timeline._taskDataDirty = true; Timeline._lastAlertSig = 'old'; Timeline._alertsRebuildPending = true;
    Timeline._rebuildPass();
    assert.equal(Timeline._taskDataDirty, true, 'a non-clean pass leaves the flag set');
    assert.equal(Timeline._lastAlertSig, 'old', 'and the stored signature untouched');
    assert.equal(Timeline._alertsRebuildPending, true, 'and the pending flush');

    Timeline._refreshViewNow = () => true;
    Timeline._rebuildPass();
    assert.equal(Timeline._taskDataDirty, false, 'a clean pass clears the flag');
    assert.equal(Timeline._lastAlertSig, expected, 'stores the signature of the alerts it used');
    assert.equal(Timeline._alertsRebuildPending, false, 'and clears the pending flush (it already covered the alerts)');
  } finally {
    Store.setAlerts(priorAlerts, 'unit-test'); Timeline._taskDataDirty = priorDirty; Timeline._lastAlertSig = priorSig; Timeline._alertsRebuildPending = priorPending;
  }
}));

test('Timeline._onStore alerts:change with an active line filter: the gate signature equals the one a _rebuildPass stores under the same filter', () => laneRebuildHarness(() => {
  const keys = ['_taskDataDirty', '_lastAlertSig', '_alertsRebuildPending', '_panActive', '_ganttActive', '_applyProfileMatchClasses', '_scheduleRebuild'];
  const prior = Object.fromEntries(keys.map(k => [k, Timeline[k]]));
  const priorAlerts = Store.alerts, hadFilter = 'GanttFilter' in globalThis.NIMBUS, priorFilter = globalThis.NIMBUS.GanttFilter;
  const rig = { scheduled: 0, profile: 0 };
  try {
    Timeline._scheduleRebuild = () => { rig.scheduled++; };
    Timeline._ganttActive = () => true;
    Timeline._applyProfileMatchClasses = () => { rig.profile++; };
    Timeline._panActive = false; Timeline._alertsRebuildPending = false;
    // The filter branch of _lineVisiblePredicate: L-A is shown, L-HIDDEN is not.
    globalThis.NIMBUS.GanttFilter = { _selectedLines: new Set(['L-A']) };
    const visible = _sigAlert({ id: 'v', line: 'L-A', taskId: 'lane-a', time: new Date(2026, 7, 10, 9) });
    const hidden = _sigAlert({ id: 'h', line: 'L-HIDDEN', time: new Date(2026, 7, 10, 9) });
    Store.setAlerts([visible, hidden], 'unit-test');
    const unfiltered = alertSig(Store.alerts, () => true);

    Timeline._refreshViewNow = () => true;
    Timeline._taskDataDirty = true; Timeline._lastAlertSig = null;
    Timeline._rebuildPass();
    const stored = Timeline._lastAlertSig;
    assert.equal(Timeline._taskDataDirty, false, 'precondition: the pass was clean');
    assert.ok(stored, 'the pass stored a signature');
    assert.notEqual(stored, unfiltered, 'precondition: the hidden line\'s cell is excluded, so the filtered signature differs from the unfiltered one');

    Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
    assert.equal(rig.scheduled, 0, 'the gate computes the same filtered signature through _onStore: skipped');
    assert.equal(rig.profile, 1);

    // A change confined to the hidden line (no taskId) paints nothing: still skipped. A visible-line change schedules.
    Store.setAlerts([visible, { ...hidden, sev: 'warn' }], 'unit-test');
    Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
    assert.equal(rig.scheduled, 0, 'a hidden-line cell change is invisible to the gate, as to the pass');
    Store.setAlerts([{ ...visible, sev: 'warn' }, hidden], 'unit-test');
    Timeline._onStore({ type: 'alerts:change', source: 'alerts' });
    assert.equal(rig.scheduled, 1, 'a visible-line change schedules the rebuild');
  } finally {
    for (const k of keys) Timeline[k] = prior[k];
    Store.setAlerts(priorAlerts, 'unit-test');
    if (hadFilter) globalThis.NIMBUS.GanttFilter = priorFilter; else delete globalThis.NIMBUS.GanttFilter;
  }
}));

test('Timeline._rebuildPass: a flush that throws (heal path) leaves the dirty flag set and the stored signature untouched', () => laneRebuildHarness(({ fake }) => {
  const priorAlerts = Store.alerts, priorDirty = Timeline._taskDataDirty, priorSig = Timeline._lastAlertSig, priorPending = Timeline._alertsRebuildPending;
  try {
    Store.setAlerts([{ id: 'x1', type: 'overlap', sev: 'err', line: 'L-A', time: new Date(2026, 7, 10, 9), taskId: 'lane-a' }], 'unit-test');
    Timeline._scheduleRebuild = () => {};   // the heal schedules the retry pass
    Timeline._taskDataDirty = true; Timeline._lastAlertSig = 'old'; Timeline._alertsRebuildPending = true;
    const origAdd = fake.add, origUpdate = fake.update;
    fake.add = () => { throw new Error('vis: orderSubgroups'); };
    fake.update = () => { throw new Error('vis: orderSubgroups'); };
    try { Timeline._rebuildPass(); } finally { fake.add = origAdd; fake.update = origUpdate; }
    assert.equal(Timeline._healCount, 1, 'precondition: the heal ran');
    assert.equal(Timeline._taskDataDirty, true);
    assert.equal(Timeline._lastAlertSig, 'old');
    assert.equal(Timeline._alertsRebuildPending, true);
  } finally {
    Store.setAlerts(priorAlerts, 'unit-test'); Timeline._taskDataDirty = priorDirty; Timeline._lastAlertSig = priorSig; Timeline._alertsRebuildPending = priorPending;
  }
}));

test('_scheduleAlertsRebuild: while _panActive it only records pending; ending the pan schedules exactly one rebuild for any number of alerts events', (t) => {
  const rig = gateRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  assert.equal(Timeline._panActive, true);
  for (let i = 0; i < 5; i++) Timeline._scheduleAlertsRebuild();
  assert.equal(rig.scheduled, 0, 'nothing scheduled mid-pan');
  assert.equal(Timeline._alertsRebuildPending, true);

  Timeline._onVisRangeChanged({ byUser: true, event: { type: 'panend' } });
  assert.equal(Timeline._panActive, false);
  assert.equal(Timeline._alertsRebuildPending, false);
  assert.equal(rig.scheduled, 1, 'one rebuild for the whole burst');
  Timeline._endPanGesture();
  assert.equal(rig.scheduled, 1, 'a second end flushes nothing');
});

test('_scheduleAlertsRebuild: every gesture-end path (rangechanged, pointerup, pointercancel) flushes the pending rebuild, even with no gesture record', (t) => {
  const rig = gateRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const priorTl = Timeline._tl, priorWired = Timeline._panDocWired, priorAdd = globalThis.document.addEventListener;
  const docHandlers = {}, tlHandlers = {};
  globalThis.document.addEventListener = (type, fn) => { docHandlers[type] = fn; };
  Timeline._panDocWired = false;
  t.after(() => { Timeline._tl = priorTl; Timeline._panDocWired = priorWired; globalThis.document.addEventListener = priorAdd; });
  Timeline._tl = { on(ev, fn) { tlHandlers[ev] = fn; }, off() {}, _origRedraw() {}, _redraw() {} };
  Timeline._wirePanTracking();

  const endings = {
    rangechanged: () => tlHandlers.rangechanged({ byUser: true, event: { type: 'panend' } }),
    pointerup: () => docHandlers.pointerup({ type: 'pointerup' }),
    pointercancel: () => docHandlers.pointercancel({ type: 'pointercancel' }),
  };
  let expected = 0;
  for (const [name, end] of Object.entries(endings)) {
    tlHandlers.rangechange({ byUser: true, event: { type: 'panmove' } });
    Timeline._scheduleAlertsRebuild();
    assert.equal(rig.scheduled, expected, `${name}: held during the pan`);
    end();
    expected++;
    assert.equal(rig.scheduled, expected, `${name}: flushed on gesture end`);
  }
  // A flag set without a gesture record (the early-return branch of _endPanGesture) still flushes.
  Timeline._panActive = true; Timeline._panGesture = null;
  Timeline._scheduleAlertsRebuild();
  Timeline._endPanGesture();
  assert.equal(rig.scheduled, expected + 1);
});

test('_scheduleAlertsRebuild: a non-user rangechanged mid-pan flushes once, and the next panmove re-sets the flag so later alerts events defer again', (t) => {
  const rig = gateRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  Timeline._scheduleAlertsRebuild();
  assert.equal(rig.scheduled, 0);
  // A rebuild's saved-window restore (or _syncNonWorking) reports a non-user rangechanged while the finger is still down.
  Timeline._onVisRangeChanged({ byUser: false });
  assert.equal(rig.scheduled, 1, 'the deferred rebuild flushed (once)');
  Timeline._scheduleAlertsRebuild();
  assert.equal(rig.scheduled, 2, 'with the flag cleared an alerts event schedules immediately, never lost');
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  Timeline._scheduleAlertsRebuild();
  assert.equal(rig.scheduled, 2, 'the next panmove re-sets the flag: deferred again');
  assert.equal(Timeline._alertsRebuildPending, true);
});

test('_scheduleAlertsRebuild: when no pan is active it schedules immediately', (t) => {
  const rig = gateRig(t);
  Timeline._scheduleAlertsRebuild();
  assert.equal(rig.scheduled, 1);
  assert.equal(Timeline._alertsRebuildPending, false);
});

test('_scheduleRebuild is unchanged: it schedules even while _panActive (the drag and spring-back call sites stay immediate)', (t) => {
  const prior = { raf: globalThis.requestAnimationFrame, rebuildRaf: Timeline._rebuildRaf, panActive: Timeline._panActive, pending: Timeline._alertsRebuildPending, rebuild: Timeline.rebuild };
  const queue = [];
  globalThis.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  Timeline._rebuildRaf = null; Timeline._panActive = true; Timeline._alertsRebuildPending = false;
  let rebuilds = 0; Timeline.rebuild = () => { rebuilds++; };
  t.after(() => {
    globalThis.requestAnimationFrame = prior.raf; Timeline._rebuildRaf = prior.rebuildRaf; Timeline._panActive = prior.panActive;
    Timeline._alertsRebuildPending = prior.pending; Timeline.rebuild = prior.rebuild;
  });
  Timeline._scheduleRebuild();
  assert.equal(queue.length, 1, 'a frame is requested despite the pan');
  assert.equal(Timeline._alertsRebuildPending, false, 'and nothing is deferred');
  queue.shift()(0);
  assert.equal(rebuilds, 1);
});

test('a stuck pan flag cannot defer forever: the 300 ms watchdog flushes the pending alerts rebuild', (t) => {
  const rig = gateRig(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Timeline._onVisRangeChange({ byUser: true, event: { type: 'panmove' } });
  Timeline._scheduleAlertsRebuild();
  t.mock.timers.tick(299);
  assert.equal(rig.scheduled, 0, 'still held inside the watchdog window');
  t.mock.timers.tick(1);
  assert.equal(Timeline._panActive, false);
  assert.equal(rig.scheduled, 1, 'the watchdog end flushed it');
  assert.equal(Timeline._alertsRebuildPending, false);
});

// ---- Settle refresh: _refreshViewNow redraws only when the DataView membership changed ----

function refreshRig(t) {
  const prior = { tl: Timeline._tl, vis: Timeline._visItems, win: Timeline._viewWindow, heal: Timeline._heal };
  const rig = { redraws: 0, heals: [], subscribes: 0, onRefresh: null };
  rig.makeView = () => {
    const handlers = { add: [], remove: [] };
    return {
      handlers,
      refresh() { if (rig.onRefresh) rig.onRefresh(this); },
      on(ev, cb) { rig.subscribes += 1; handlers[ev].push(cb); },
      emit(ev) { for (const cb of handlers[ev]) cb(ev, { items: ['x'] }, null); },
    };
  };
  rig.view = rig.makeView();
  Timeline._tl = {
    getWindow: () => ({ start: new Date(1000), end: new Date(5000) }),
    redraw: () => { rig.redraws += 1; },
  };
  Timeline._visItems = rig.view;
  Timeline._viewWindow = null;
  Timeline._heal = (scope, e) => { rig.heals.push({ scope, e }); };
  PerfMonitor.clear();
  t.after(() => {
    Timeline._tl = prior.tl; Timeline._visItems = prior.vis; Timeline._viewWindow = prior.win; Timeline._heal = prior.heal;
    PerfMonitor.clear();
  });
  return rig;
}

test('_refreshViewNow: no add/remove during refresh means no redraw, returns true, and still updates _viewWindow', (t) => {
  const rig = refreshRig(t);
  assert.equal(Timeline._refreshViewNow(), true);
  assert.equal(rig.redraws, 0);
  assert.deepEqual(Timeline._viewWindow, { start: 1000, end: 5000 });
});

test('_refreshViewNow: an add during refresh triggers exactly one redraw', (t) => {
  const rig = refreshRig(t);
  rig.onRefresh = v => v.emit('add');
  assert.equal(Timeline._refreshViewNow(), true);
  assert.equal(rig.redraws, 1);
});

test('_refreshViewNow: a remove during refresh triggers exactly one redraw', (t) => {
  const rig = refreshRig(t);
  rig.onRefresh = v => v.emit('remove');
  assert.equal(Timeline._refreshViewNow(), true);
  assert.equal(rig.redraws, 1);
});

test('_refreshViewNow: the flag resets per call', (t) => {
  const rig = refreshRig(t);
  rig.onRefresh = v => v.emit('add');
  Timeline._refreshViewNow();
  assert.equal(rig.redraws, 1);
  rig.onRefresh = null;
  Timeline._refreshViewNow();
  assert.equal(rig.redraws, 1, 'the second call saw no event, so no second redraw');
});

test('_refreshViewNow: events fired before the call (an earlier item write) do not count', (t) => {
  const rig = refreshRig(t);
  Timeline._refreshViewNow();            // wires the subscription
  rig.view.emit('add'); rig.view.emit('remove');
  Timeline._refreshViewNow();
  assert.equal(rig.redraws, 0, 'those writes queued their own redraw through vis');
});

test('_refreshViewNow: the flag is read after refresh() returns', (t) => {
  const rig = refreshRig(t);
  let redrawsAtRefreshEnd = null;
  rig.onRefresh = v => { v.emit('add'); redrawsAtRefreshEnd = rig.redraws; };
  Timeline._refreshViewNow();
  assert.equal(redrawsAtRefreshEnd, 0, 'no redraw while refresh() is still running');
  assert.equal(rig.redraws, 1, 'the event fired inside refresh() is seen after it returns');
});

test('_refreshViewNow: a refresh() throw heals, returns false and does not redraw', (t) => {
  const rig = refreshRig(t);
  const boom = new Error('boom');
  rig.onRefresh = v => { v.emit('add'); throw boom; };
  assert.equal(Timeline._refreshViewNow(), false);
  assert.equal(rig.redraws, 0);
  assert.equal(rig.heals.length, 1);
  assert.equal(rig.heals[0].scope, 'refresh-view');
  assert.equal(rig.heals[0].e, boom);
  assert.equal(PerfMonitor.stats('Timeline.refreshView.filter'), null, 'a failed refresh records no mark');
});

test('_refreshViewNow: subscribes once per DataView instance across calls, and again for a replaced instance', (t) => {
  const rig = refreshRig(t);
  Timeline._refreshViewNow(); Timeline._refreshViewNow(); Timeline._refreshViewNow();
  assert.equal(rig.subscribes, 2, 'one add and one remove subscription, not per call');
  assert.equal(rig.view.handlers.add.length, 1);
  assert.equal(rig.view.handlers.remove.length, 1);
  const next = rig.makeView();
  Timeline._visItems = next;
  Timeline._refreshViewNow(); Timeline._refreshViewNow();
  assert.equal(rig.subscribes, 4);
  assert.equal(next.handlers.add.length, 1);
  assert.equal(next.handlers.remove.length, 1);
  assert.equal(rig.view.handlers.add.length, 1, 'the old instance is not re-wired');
});

test('_refreshViewNow: records Timeline.refreshView.filter always and Timeline.refreshView.redraw only when it redrew', (t) => {
  const rig = refreshRig(t);
  Timeline._refreshViewNow();
  assert.equal(PerfMonitor.stats('Timeline.refreshView.filter').count, 1);
  assert.equal(PerfMonitor.stats('Timeline.refreshView.redraw'), null, 'no redraw, no redraw mark');
  rig.onRefresh = v => v.emit('add');
  Timeline._refreshViewNow();
  assert.equal(PerfMonitor.stats('Timeline.refreshView.filter').count, 2);
  assert.equal(PerfMonitor.stats('Timeline.refreshView.redraw').count, 1);
  assert.equal(PerfMonitor.stats('Timeline.refreshView'), null, 'the old combined mark is gone');
});

test('_refreshViewNow: returns true without touching vis when _tl is missing', (t) => {
  const rig = refreshRig(t);
  Timeline._tl = null;
  assert.equal(Timeline._refreshViewNow(), true);
  assert.equal(rig.subscribes, 0);
});

/* ---- Rebuild equality diff (Gantt pan perf, Task 4): visItemEqual skips unchanged DataSet writes ---- */

function eqItem() {
  return {
    id: 'o1', group: 'L-A', kind: 'order', parentId: 'o1', segmentNumber: 1, segmentCount: 2,
    content: '<b>o1</b>', start: new Date(2026, 7, 10, 7), end: new Date(2026, 7, 10, 11),
    className: 'order-item', editable: true, type: undefined, title: 'tip', style: '',
    subgroup: undefined, laneIndex: undefined,
    setup: {
      predecessorOrderId: 'p1', predecessorState: 'RED', successorOrderId: 'o1', requiredMinutes: 30, effectiveMinutes: 30,
      standardMinutes: 30, source: 'matrix', overrideStatus: null, availableMinutes: 45, shortMinutes: null, missingDetail: null,
    },
  };
}

test('visItemEqual: identical clones are equal, including Date objects of the same instant', () => {
  const a = eqItem(), b = eqItem();
  assert.notEqual(a.start, b.start, 'precondition: distinct Date objects');
  assert.equal(visItemEqual(a, b), true);
  const c = structuredClone(eqItem());
  assert.equal(visItemEqual(a, c), true);
  // A non-Date value is coerced with + (a stored ms number equals the desired Date of that instant).
  assert.equal(visItemEqual({ ...a, start: a.start.getTime() }, b), true);
  // NaN on both sides is equal, NaN on one side is not.
  assert.equal(visItemEqual({ ...a, end: new Date(NaN) }, { ...b, end: new Date(NaN) }), true);
  assert.equal(visItemEqual({ ...a, end: new Date(NaN) }, b), false);
});

test('visItemEqual: each compared field difference makes it unequal', () => {
  const plus = d => new Date(d.getTime() + 60000);
  const changes = {
    id: 'o2', group: 'L-B', kind: 'setup', parentId: 'o2', segmentNumber: 2, segmentCount: 3,
    start: plus(eqItem().start), end: plus(eqItem().end), className: 'order-item dimmed', editable: false,
    type: 'background', title: 'other', content: '<b>o2</b>', style: 'opacity:0.18;', laneIndex: 1,
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.equal(visItemEqual(eqItem(), { ...eqItem(), [field]: value }), false, `${field} differs`);
  }
  const setupChanges = {
    predecessorOrderId: 'p2', predecessorState: 'BLUE', successorOrderId: 'o2', requiredMinutes: 31, effectiveMinutes: 29,
    standardMinutes: 28, source: 'override', overrideStatus: 'active', availableMinutes: 46, shortMinutes: 5, missingDetail: 'x',
  };
  for (const [field, value] of Object.entries(setupChanges)) {
    const desired = eqItem(); desired.setup = { ...desired.setup, [field]: value };
    assert.equal(visItemEqual(eqItem(), desired), false, `setup.${field} differs`);
  }
});

test('visItemEqual: undefined and an absent key are the same value; a setup detail on one side only is unequal; null equals undefined', () => {
  const a = eqItem(), b = eqItem();
  delete b.type; delete b.laneIndex; delete b.parentId;
  a.parentId = undefined;
  assert.equal(visItemEqual(a, b), true, 'undefined vs absent');
  assert.equal(visItemEqual(eqItem(), { ...eqItem(), setup: undefined }), false);
  assert.equal(visItemEqual({ ...eqItem(), setup: undefined }, eqItem()), false);
  assert.equal(visItemEqual({ ...eqItem(), setup: null }, { ...eqItem(), setup: undefined }), true, 'null and undefined setup are one value');
  assert.equal(visItemEqual({ ...eqItem(), group: undefined }, { ...eqItem(), group: 'L-A' }), false);
  assert.equal(visItemEqual({ ...eqItem(), style: undefined }, { ...eqItem(), style: '' }), false, 'an unset style is not an empty style');
});

test('visItemEqual: subgroup is compared only when the desired item carries the key', () => {
  const stored = { ...eqItem(), subgroup: 'lane-1' };
  const desiredNoKey = eqItem(); delete desiredNoKey.subgroup;
  assert.equal(visItemEqual(stored, desiredNoKey), true, 'a desired item without the key ignores the stored subgroup');
  assert.equal(visItemEqual(eqItem(), { ...eqItem(), subgroup: undefined }), true, 'present undefined vs stored undefined');
  assert.equal(visItemEqual(stored, { ...eqItem(), subgroup: undefined }), false, 'present undefined vs a stored lane');
  assert.equal(visItemEqual(stored, { ...eqItem(), subgroup: 'lane-2' }), false, 'differing lane ids');
  assert.equal(visItemEqual(stored, { ...eqItem(), subgroup: 'lane-1' }), true);
});

test('visItemEqual: a missing stored item is never equal', () => {
  assert.equal(visItemEqual(null, eqItem()), false);
  assert.equal(visItemEqual(undefined, eqItem()), false);
});

// Ids the pass wrote as an update that are not zone bands (past/alert/frozen zones take a fresh "now" each pass).
const nonZoneUpdates = fake => fake.calls.update.flat().filter(id => fake.records.get(id)?.kind !== 'zone');

test('Timeline._rebuildPass: a second identical pass writes no order or setup item as an update', () => laneRebuildHarness(({ fake }) => {
  Timeline._rebuildPass();
  assert.ok([...fake.records.values()].some(i => i.kind === 'order'), 'precondition: the first pass added orders');
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  assert.deepEqual(nonZoneUpdates(fake), [], 'no order, setup, blackout or gridline item is rewritten');
  assert.deepEqual(fake.calls.add.flat(), []);
  assert.deepEqual(fake.calls.remove.flat().filter(id => !id.startsWith('nonworking-')), []);
}));

test('Timeline._rebuildPass: changing one order\'s end writes only that order', () => laneRebuildHarness(({ fake }) => {
  Timeline._rebuildPass();
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  const tasks = structuredClone(Store.tasksArr);
  const b = tasks.find(t => t.id === 'lane-b');
  b.end_date = new Date(2026, 7, 10, 14);
  Store.setTasks(tasks, 'unit-test');
  Timeline._rebuildPass();
  assert.deepEqual(nonZoneUpdates(fake), ['lane-b'], 'only the order whose end moved is written');
  assert.equal(fake.records.get('lane-b').end.getTime(), new Date(2026, 7, 10, 14).getTime());
}));

test('Timeline._rebuildPass: the lane-relocation check still runs before the equality skip', () => laneRebuildHarness(({ fake }) => {
  Timeline._expandedLine = 'L-A';
  Timeline._rebuildPass();
  const laned = [...fake.records.values()].filter(i => i.subgroup !== undefined).map(i => String(i.id));
  assert.ok(laned.length >= 2, 'precondition: both orders are laned');
  // A second pass with the row still expanded changes nothing: nothing relocated, nothing updated.
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  assert.deepEqual(nonZoneUpdates(fake), []);
  assert.deepEqual(fake.calls.add.flat(), []);
  // Collapse: only the subgroup differs, yet each laned item is removed and re-added, never updated or skipped.
  Timeline._expandedLine = null;
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  for (const id of laned) {
    assert.ok(fake.calls.remove.flat().includes(id), `${id} relocated by remove`);
    assert.ok(fake.calls.add.flat().includes(id), `${id} re-added`);
    assert.ok(!fake.calls.update.flat().includes(id), `${id} never updated across a subgroup change`);
    assert.equal(fake.records.get(id).subgroup, undefined);
  }
  // Expand again: the lane-less stored items now differ only by subgroup and are relocated too.
  Timeline._expandedLine = 'L-A';
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  for (const id of laned) assert.ok(fake.calls.remove.flat().includes(id) && fake.calls.add.flat().includes(id), `${id} relocated into its lane`);
}));

test('Timeline._rebuildPass: a stored className that differs (dist-sibling, dimmed) is written back', () => laneRebuildHarness(({ fake }) => {
  Timeline._rebuildPass();
  const cleanA = fake.records.get('lane-a').className, cleanB = fake.records.get('lane-b').className;
  fake.records.set('lane-a', { ...fake.records.get('lane-a'), className: `${cleanA} dist-sibling` });
  fake.records.set('lane-b', { ...fake.records.get('lane-b'), className: `${cleanB} dimmed` });
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  const priorApply = Interaction._applyDistSiblingHighlight;
  Interaction._applyDistSiblingHighlight = () => {};
  try { Timeline._rebuildPass(); } finally { Interaction._applyDistSiblingHighlight = priorApply; }
  assert.deepEqual(nonZoneUpdates(fake).sort(), ['lane-a', 'lane-b']);
  assert.equal(fake.records.get('lane-a').className, cleanA);
  assert.equal(fake.records.get('lane-b').className, cleanB);
}));

test('Timeline._rebuildPass: _itemIdsByTask is rebuilt on a pass that writes nothing', () => laneRebuildHarness(({ fake }) => {
  Timeline._rebuildPass();
  Timeline._itemIdsByTask = new Map();
  fake.calls.update.length = 0;
  Timeline._rebuildPass();
  assert.deepEqual(nonZoneUpdates(fake), []);
  assert.ok(Timeline.itemIdsForTask('lane-a').length > 0, 'the id map is repopulated from the desired set, not from the writes');
}));

/* ---- Task 5: the three zone washes are single ungrouped background items ---- */
// Pins the plant clock and gives NW_PLANT a master row with the given horizons (null = off), runs fn, restores.
function zoneRig({ hz = null, frozenDays = null } = {}, fn) {
  return laneRebuildHarness(ctx => {
    const restoreClock = pinPlantClock([NW_PLANT]);
    const master = Store.masterData;
    const priorHz = Store.userSettings.alertHorizonMinutes;
    Store.setMasterData({
      ...master,
      plants: master.plants.map(p => p.plant === NW_PLANT ? { ...p, alt_flag_horizon: hz, frozen_horizon_days: frozenDays } : p),
    }, 'unit-test');
    Store.userSettings.alertHorizonMinutes = null;
    const priorIds = [Timeline._pastZoneIds, Timeline._alertHorizonIds, Timeline._frozenHorizonIds];
    try { return fn(ctx); } finally {
      Store.userSettings.alertHorizonMinutes = priorHz;
      [Timeline._pastZoneIds, Timeline._alertHorizonIds, Timeline._frozenHorizonIds] = priorIds;
      restoreClock();
    }
  });
}
const ZONE_IDS = ['past-zone', 'alert-horizon-zone', 'frozen-horizon-zone'];
const zoneItems = fake => [...fake.records.values()].filter(i => i.kind === 'zone' && ZONE_IDS.some(z => String(i.id).startsWith(z)));

test('Timeline._rebuildPass: exactly one past-zone item, ungrouped', () => zoneRig({}, ({ fake }) => {
  Timeline._rebuildPass();
  const past = zoneItems(fake).filter(i => String(i.id).startsWith('past-zone'));
  assert.equal(past.length, 1);
  const item = past[0];
  assert.equal(item.id, 'past-zone');
  assert.equal('group' in item, false, 'ungrouped: the library routes it to its BackgroundGroup');
  assert.equal(item.kind, 'zone');
  assert.equal(item.type, 'background');
  assert.equal(item.className, 'past-zone');
  assert.equal(item.editable, false);
}));

test('Timeline._rebuildPass: alert-horizon-zone and frozen-horizon-zone are single ungrouped items when configured, absent otherwise', () => {
  zoneRig({ hz: 720, frozenDays: 2 }, ({ fake }) => {
    Timeline._rebuildPass();
    for (const id of ['alert-horizon-zone', 'frozen-horizon-zone']) {
      const found = zoneItems(fake).filter(i => String(i.id).startsWith(id));
      assert.equal(found.length, 1, id);
      assert.equal(found[0].id, id);
      assert.equal('group' in found[0], false);
      assert.equal(found[0].className, id);
      assert.equal(found[0].type, 'background');
      assert.equal(found[0].kind, 'zone');
      assert.equal(found[0].editable, false);
    }
    const a = fake.records.get('alert-horizon-zone');
    assert.equal(a.end.getTime() - a.start.getTime(), 720 * 60_000, 'alert band spans the horizon');
    assert.equal(fake.records.get('frozen-horizon-zone').start.getTime(), a.start.getTime(), 'both start at the plant now');
    assert.deepEqual(Timeline._alertHorizonIds, ['alert-horizon-zone']);
    assert.deepEqual(Timeline._frozenHorizonIds, ['frozen-horizon-zone']);
  });
  zoneRig({ hz: null, frozenDays: null }, ({ fake }) => {
    Timeline._rebuildPass();
    assert.deepEqual(zoneItems(fake).map(i => i.id), ['past-zone']);
    assert.deepEqual(Timeline._alertHorizonIds, []);
    assert.deepEqual(Timeline._frozenHorizonIds, []);
  });
});

test('Timeline._rebuildPass: 30 visible lines still produce 3 zone items, not 90', () => zoneRig({ hz: 720, frozenDays: 2 }, ({ fake }) => {
  const at = h => new Date(2026, 7, 10, h);
  const tasks = [];
  for (let i = 0; i < 30; i++) tasks.push({ id: `many-${i}`, PRODUCTION_ORDER: `P${i}`, MATERIAL_NUMBER: 'M', MACHINE: `LINE-${i}`, PLANT: NW_PLANT, plant: NW_PLANT, start_date: at(7), end_date: at(9), RUN_TIME: 2, COLOR: 'RED' });
  Store.setTasks(tasks, 'unit-test');
  assert.equal(Timeline._visibleLines().length, 30, 'precondition: 30 rows');
  Timeline._rebuildPass();
  assert.deepEqual(zoneItems(fake).map(i => i.id).sort(), [...ZONE_IDS].sort());
  assert.ok(![...fake.records.keys()].some(id => /^(past|alert-horizon|frozen-horizon)-zone-/.test(id)), 'no per-line zone ids');
}));

test('Timeline._rebuildPass: no visible rows creates no zone items and leaves the id arrays empty', () => zoneRig({ hz: 720, frozenDays: 2 }, ({ fake }) => {
  Store.setTasks([], 'unit-test');
  assert.deepEqual(Timeline._visibleLines(), [], 'precondition: no rows');
  Timeline._rebuildPass();
  assert.deepEqual(zoneItems(fake), []);
  assert.deepEqual(Timeline._pastZoneIds, []);
  assert.deepEqual(Timeline._alertHorizonIds, []);
  assert.deepEqual(Timeline._frozenHorizonIds, []);
}));

test('Timeline._rebuildPass: the three _*ZoneIds arrays have length 1 after a rebuild and the ticker guard stays truthy', () => zoneRig({ hz: 720, frozenDays: 2 }, () => {
  Timeline._rebuildPass();
  assert.deepEqual(Timeline._pastZoneIds, ['past-zone']);
  assert.deepEqual(Timeline._alertHorizonIds, ['alert-horizon-zone']);
  assert.deepEqual(Timeline._frozenHorizonIds, ['frozen-horizon-zone']);
  assert.ok(Timeline._pastZoneIds.length, 'the ticker guard (and the 30 s lock scan behind it) runs');
}));

test('Timeline._rebuildPass: the first pass after the change removes the old per-line zone ids and adds the three; a second pass leaves them alone', () => zoneRig({ hz: 720, frozenDays: 2 }, ({ fake }) => {
  const legacy = ['past-zone-L-A', 'alert-horizon-zone-L-A', 'frozen-horizon-zone-L-A'];
  for (const id of legacy) fake.records.set(id, { id, group: 'L-A', kind: 'zone', type: 'background', className: id.replace(/-L-A$/, ''), editable: false, start: new Date(2026, 0, 1), end: new Date(2026, 0, 2) });
  Timeline._rebuildPass();
  const removed = fake.calls.remove.flat();
  for (const id of legacy) assert.ok(removed.includes(id), `${id} removed through the normal diff`);
  assert.deepEqual(zoneItems(fake).map(i => i.id).sort(), [...ZONE_IDS].sort());
  fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
  Timeline._rebuildPass();
  assert.deepEqual(fake.calls.add.flat(), []);
  assert.deepEqual(fake.calls.remove.flat().filter(id => !id.startsWith('nonworking-')), []);
}));

test('zoneTickerUpdates: pushes the past id end, the alert-horizon start/end and the frozen start/end for the 3 single ids; skips ids not in the DataSet; omits horizon updates when hz is not a number or frozenEnd is null', () => {
  const now = new Date(2026, 7, 10, 8), frozenEnd = new Date(2026, 7, 12, 8);
  const base = { pastIds: ['past-zone'], alertIds: ['alert-horizon-zone'], frozenIds: ['frozen-horizon-zone'], now, hzMinutes: 90, frozenEnd, has: () => true };
  assert.deepEqual(zoneTickerUpdates(base), [
    { id: 'past-zone', end: now },
    { id: 'alert-horizon-zone', start: now, end: new Date(now.getTime() + 90 * 60_000) },
    { id: 'frozen-horizon-zone', start: now, end: frozenEnd },
  ]);
  assert.deepEqual(zoneTickerUpdates({ ...base, has: id => id !== 'alert-horizon-zone' }).map(u => u.id), ['past-zone', 'frozen-horizon-zone'], 'ids missing from the DataSet are skipped');
  assert.deepEqual(zoneTickerUpdates({ ...base, has: () => false }), []);
  assert.deepEqual(zoneTickerUpdates({ ...base, hzMinutes: null }).map(u => u.id), ['past-zone', 'frozen-horizon-zone']);
  assert.deepEqual(zoneTickerUpdates({ ...base, frozenEnd: null }).map(u => u.id), ['past-zone', 'alert-horizon-zone']);
  assert.deepEqual(zoneTickerUpdates({ ...base, hzMinutes: null, frozenEnd: null }), [{ id: 'past-zone', end: now }]);
});

test('zone CSS: the z-index ladder is ordered gridline < nonworking < blackout < past < alert-horizon < frozen < alert cell, the background container has z-index 1 (not isolation), the past zone is pass-through, and no top/height/position appears in the zone rules', () => {
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = sel => {
    const esc = sel.replace(/[.>\-]/g, m => '\\' + m);
    const m = stripped.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `rule ${sel} exists`);
    return m[1];
  };
  const z = sel => { const m = rule(sel).match(/z-index:\s*(\d+)\s*(?:!important)?\s*;/); assert.ok(m, `${sel} declares a z-index`); return Number(m[1]); };
  const order = ['.vis-item.day-gridline', '.vis-item.nonworking', '.vis-item.blackout', '.vis-item.past-zone', '.vis-item.alert-horizon-zone', '.vis-item.frozen-horizon-zone'].map(z);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `ladder step ${i} (${order.join(' < ')})`);
  for (const c of ['.vis-item.alertcell-err', '.vis-item.alertcell-warn', '.vis-item.alertcell-calendar'].map(z)) assert.ok(c > order[order.length - 1], 'alert cells sit above the frozen band');
  assert.match(rule('.vis-itemset > .vis-background'), /(^|[\s;{])z-index:\s*1\s*;/);
  assert.doesNotMatch(rule('.vis-itemset > .vis-background'), /isolation/, 'isolation lifts the foreground rows above the whole background layer');
  assert.match(rule('.vis-item.past-zone'), /pointer-events:\s*none/, 'the past wash is pass-through like the horizon washes');
  for (const sel of ['.vis-item.past-zone', '.vis-item.alert-horizon-zone', '.vis-item.frozen-horizon-zone', '.vis-item.nonworking', '.vis-item.day-gridline', '.vis-item.blackout', '.vis-item.alertcell-err', '.vis-item.alertcell-warn', '.vis-item.alertcell-calendar']) {
    assert.doesNotMatch(rule(sel), /(^|[\s;{])(top|height|position)\s*:/, `${sel} must not set top/height/position`);
  }
});

test('Timeline.rebuildSetupForLines: a second identical call writes no setup bar update, and a changed setup bar is written', () => {
  const line = 'SETUP-EQ-LINE', plant = 'SETUP-EQ-PLANT';
  const priorItems = Timeline._items, priorCore = globalThis.NimbusComputeCore, priorSetup = Store.setupSnapshot;
  const priorTasks = structuredClone(Store.tasksArr), priorPlant = Store.selectedPlant;
  const fake = nwFakeItems();
  Timeline._items = fake;
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
    machine_rows: [], machine_states: [], overrides: [],
  }, 'unit-test');
  Store.setTasks([
    { id: 'eq-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED', start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') },
    { id: 'eq-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE', start_date: new Date('2026-08-17T09:30:00'), end_date: new Date('2026-08-17T10:30:00') },
  ], 'unit-test');
  try {
    Timeline.rebuildSetupForLines(new Set([line]));
    const setupIds = [...fake.records.values()].filter(i => i.kind === 'setup').map(i => String(i.id));
    assert.ok(setupIds.length >= 1, 'precondition: the first call added a setup bar');
    fake.calls.add.length = fake.calls.update.length = fake.calls.remove.length = 0;
    Timeline.rebuildSetupForLines(new Set([line]));
    assert.deepEqual(fake.calls.update, [], 'an unchanged setup bar is not handed to vis again');
    assert.deepEqual(fake.calls.add, []);
    assert.deepEqual(fake.calls.remove, []);
    // A stored setup bar that no longer matches (drag dimming left behind) is written back.
    const id = setupIds[0];
    fake.records.set(id, { ...fake.records.get(id), className: 'setup-item setup-drag-dim', style: 'opacity:0.18;' });
    Timeline.rebuildSetupForLines(new Set([line]));
    assert.deepEqual(fake.calls.update.flat(), [id]);
    assert.equal(fake.records.get(id).style, '');
    assert.doesNotMatch(fake.records.get(id).className, /setup-drag-dim/);
  } finally {
    Timeline._items = priorItems;
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// ---- i18n sweep (Gantt): axis locale + split-segment tooltip ----
import { ensureAxisLocale, axisLocaleCode, PT_MOMENT_LOCALE } from '../../../frontend/scheduling/gantt-axis-locale.mjs';

test('axisLocaleCode maps the app locale to a supported moment code', () => {
  assert.equal(axisLocaleCode('pt'), 'pt');
  assert.equal(axisLocaleCode('de-DE'), 'de');
  assert.equal(axisLocaleCode('xx'), 'en');
  assert.equal(axisLocaleCode(undefined), 'en');
});

test('ensureAxisLocale defines pt once when the bundled moment lacks it, and falls back to en when vis.moment is missing', () => {
  const defined = [];
  const known = ['en', 'de', 'es', 'fr'];
  const vis = { moment: { locales: () => known, defineLocale: (n, c) => { defined.push([n, c]); known.push(n); } } };
  assert.equal(ensureAxisLocale(vis, 'pt'), 'pt');
  assert.equal(ensureAxisLocale(vis, 'pt'), 'pt');
  assert.equal(defined.length, 1);
  assert.equal(defined[0][1], PT_MOMENT_LOCALE);
  assert.equal(PT_MOMENT_LOCALE.week.dow, 1);
  assert.equal(ensureAxisLocale(vis, 'de'), 'de');
  assert.equal(ensureAxisLocale(vis, 'en'), 'en');
  assert.equal(ensureAxisLocale({}, 'pt'), 'en');
  assert.equal(ensureAxisLocale(undefined, 'de'), 'en');
});

test('split-segment tooltip uses a real newline and the locale key', () => {
  const src = readFileSync(new URL('../../../frontend/scheduling/gantt.mts', import.meta.url), 'utf8');
  assert.ok(src.includes("Util.t('tip.split_segment'"));
  assert.ok(!src.includes('productive\\n'));
});

// ── Machines-pane day stepper ───────────────────────────────────────────────
function hierStepperFixture() {
  const now = new Date('2026-10-19T09:00:00');
  const cell = (s) => ({ scheduled: s, capacity: 16, effectiveCapacity: 16, pct: s / 16 });
  const matrix = { 'L-1': { '2026-10-19': cell(8), '2026-10-20': cell(4), '2026-10-21': cell(0) } };
  const mk = (id, s, e) => ({ id, ORDER: id, MACHINE: 'L-1', start_date: new Date(s), end_date: new Date(e) });
  const tasks = [mk('a', '2026-10-19T10:00:00', '2026-10-19T12:00:00'), mk('b', '2026-10-20T10:00:00', '2026-10-20T12:00:00')];
  return { now, matrix, tasks };
}

test('Hierarchy.step moves the day, clamps at both ends, and scrolls the timeline (Today -> now)', (t) => {
  const { now } = hierStepperFixture();
  const prior = { key: Hierarchy._dayKey, clock: Util.plantClock, render: Hierarchy.render, now: Timeline.gotoNow, day: Timeline.gotoDay };
  const calls = [];
  Util.plantClock = () => now; Hierarchy.render = () => {};
  Timeline.gotoNow = () => calls.push('now'); Timeline.gotoDay = (k) => calls.push(k);
  t.after(() => { Hierarchy._dayKey = prior.key; Util.plantClock = prior.clock; Hierarchy.render = prior.render; Timeline.gotoNow = prior.now; Timeline.gotoDay = prior.day; });
  Hierarchy._dayKey = null;
  Hierarchy.step(-1);
  assert.equal(Hierarchy._dayKey, '2026-10-19');          // already today: stays
  Hierarchy.step(1); Hierarchy.step(1);
  assert.equal(Hierarchy._dayKey, '2026-10-21');
  for (let i = 0; i < 10; i++) Hierarchy.step(1);
  assert.equal(Hierarchy._dayKey, '2026-10-25');          // clamped at today+6
  while (Hierarchy._dayKey !== '2026-10-19') Hierarchy.step(-1);
  assert.deepEqual([calls[0], calls[1], calls[2]], ['now', '2026-10-20', '2026-10-21']);
  assert.equal(calls[calls.length - 1], 'now');
});

test('Hierarchy resets to Today on plant:selected', (t) => {
  const prior = { key: Hierarchy._dayKey, render: Hierarchy.render };
  let renders = 0;
  Hierarchy.render = () => { renders++; };
  t.after(() => { Hierarchy._dayKey = prior.key; Hierarchy.render = prior.render; });
  Hierarchy.init();
  Hierarchy._dayKey = '2026-10-22';
  Store.emit({ type: 'plant:selected', plant: null, source: 'unit-test' });
  assert.equal(Hierarchy._dayKey, null);
  assert.ok(renders >= 1);
});

test('Hierarchy.render shows the chosen day: chip, task count and order list', (t) => {
  const { now, matrix, tasks } = hierStepperFixture();
  const prior = {
    key: Hierarchy._dayKey, vl: Hierarchy._vl, wired: Hierarchy._wired, clock: Util.plantClock, compute: Utilization.computeMatrix,
    scoped: Store.tasksForSelectedPlant, lines: Store.linesForSelectedPlant, plant: Store._state.selectedPlant,
    getEl: globalThis.document.getElementById, pref: Store.pref,
  };
  const shown = [];
  Util.plantClock = () => now;
  Utilization.computeMatrix = (_c, days) => { assert.equal(days, 7); return matrix; };
  Store.tasksForSelectedPlant = () => tasks; Store.linesForSelectedPlant = () => ['L-1'];
  Store._state.selectedPlant = '5512'; Store.pref = () => [];
  Hierarchy._vl = { update: (items) => shown.push(items), destroy() {} };
  const label = { textContent: '', title: '' };
  globalThis.document.getElementById = (id) => (id === 'hierarchy' ? { addEventListener() {} } : id === 'hier-day-label' ? label : null);
  t.after(() => {
    Hierarchy._dayKey = prior.key; Hierarchy._vl = prior.vl; Hierarchy._wired = prior.wired; Util.plantClock = prior.clock;
    Utilization.computeMatrix = prior.compute; Store.tasksForSelectedPlant = prior.scoped; Store.linesForSelectedPlant = prior.lines;
    Store._state.selectedPlant = prior.plant; globalThis.document.getElementById = prior.getEl; Store.pref = prior.pref;
  });
  Hierarchy._wired = true;
  Hierarchy._dayKey = null;
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 50);
  assert.deepEqual(shown.at(-1)[0].tasks.map(x => x.id), ['a']);
  Hierarchy._dayKey = '2026-10-20';
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 25);
  assert.deepEqual(shown.at(-1)[0].tasks.map(x => x.id), ['b']);
  assert.equal(label.title, label.textContent);
  Hierarchy._dayKey = '2026-10-21';
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, null);                 // nothing scheduled that day: dash chip
  assert.equal(shown.at(-1)[0].tasks.length, 0);
});
