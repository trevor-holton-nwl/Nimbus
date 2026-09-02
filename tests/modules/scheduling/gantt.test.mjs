// Tests for frontend/scheduling/gantt.mts (Timeline, TimelineNav, DependencyOverlay,
// Hierarchy, GanttFilter, Interaction). Split from
// tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Timeline, TimelineNav, DependencyOverlay, Hierarchy, GanttFilter, Interaction } from '../../../frontend/scheduling/gantt.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';

const require = createRequire(import.meta.url);

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

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById(id) { return id === 'vis-timeline' ? _makeVisTimelineContainerStub() : null; },
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
// comment above `_onDataSetUpdate` in schedule-workbench.mjs. These two tests
// pin the REAL current behavior (a "verbatim move" task must not change
// logic), not the aspirational behavior the stale comment described.

test('Interaction._onDataSetUpdate: the firmed-task noActualChange guard checks only start+group (not end) — a same-start/same-group echo with a changed end is still swallowed', () => {
  const id = 'fx-echo-1';
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  // Same start and same group as the Store, but a DIFFERENT end — the
  // firmed-order noActualChange guard (schedule-workbench.mjs _onDataSetUpdate)
  // deliberately compares only start+group, not end, so this must still be
  // treated as a no-op by that guard specifically. A same-start/same-end/
  // same-group scenario would be caught just as well by the generic `moved`
  // check further down (start+end+line) regardless of whether the firmed-only
  // guard exists at all, which is why that shape doesn't actually characterize
  // this guard (confirmed by mutation: disabling the guard while keeping that
  // shape still passed). This shape — start+group unchanged, end changed —
  // only stays a no-op because of the firmed-specific guard; if the guard is
  // removed or broken, this scenario falls through to the generic `moved`
  // check, which DOES see the changed end and commits it, failing this test.
  const differentEnd = new Date('2026-07-01T14:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX1', MATERIAL_NUMBER: 'MFX1', MACHINE: 'L1',
    plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();

  Timeline._items = { get: (i) => (i === id ? { start, end: differentEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime(), 'the firmed-task guard must treat a same-start/same-group echo as a no-op even when end differs');
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime(), 'the firmed-task guard must not let the changed end leak into the Store');
  } finally {
    Timeline._items = undefined;
  }
});

test('Interaction._onDataSetUpdate: a genuine drag on a firmed task commits today — firmed-order protection only suppresses no-op echoes, not real drags', () => {
  const id = 'fx-real-1';
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  const draggedStart = new Date('2026-07-01T09:00:00');
  const draggedEnd   = new Date('2026-07-01T13:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX2', MATERIAL_NUMBER: 'MFX2', MACHINE: 'L1',
    plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFirmed([id], true, 'test');
  Selection.clear();

  Timeline._items = { get: (i) => (i === id ? { start: draggedStart, end: draggedEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(
      Store.tasks[id].start_date.getTime(), draggedStart.getTime(),
      'current behavior: a genuine drag on a firmed task commits to the Store — it is NOT reverted (see the corrected header comment in schedule-workbench.mjs)'
    );
    assert.equal(Store.tasks[id].end_date.getTime(), draggedEnd.getTime());
  } finally {
    Timeline._items = undefined;
  }
});

// ---------------------------------------------------------------------------
// Workstream B1 (2026-08-21) — one policy-independent, segment-shift-aware
// manual commit path. Before this task, a Timeline drag on an order that
// already had >=2 scheduleSegments routed through
// Interaction._dragRequiresRegeneration/_regenerateDragPatch, a SEPARATE
// branch in _onDataSetUpdate that has been deleted; every drag now goes
// through the same two branches (multi-select / single-item), both of which
// call the rewritten Engine.manualSchedulePatchFor.
// ---------------------------------------------------------------------------

test('Interaction._onDataSetUpdate: dragging one segment of an already-split (>=2 segments) order shifts EVERY segment by the drag delta instead of collapsing it (OD-B1a)', () => {
  // Engine.autoReflow (called by the single-item drag branch) unconditionally
  // arms Alerts' debounced recompute timer at the end of its walk. Stubbed to
  // a no-op for the duration of this test -- same established pattern as the
  // OptimizerPreview tests below -- so no setTimeout callback fires after the
  // test has already completed and reached for the real (unstubbed in this
  // file) NimbusComputeCore global.
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};

  const id = 'split-drag-1';
  const line = 'SPLIT-DRAG-LINE';
  const seg1Start = new Date('2026-08-20T08:00:00');
  const seg1End   = new Date('2026-08-20T16:00:00');
  const seg2Start = new Date('2026-08-21T08:00:00');
  const seg2End   = new Date('2026-08-21T16:00:00');
  const seg3Start = new Date('2026-08-22T08:00:00');
  const seg3End   = new Date('2026-08-22T16:00:00');
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

  // Simulate the user dragging segment 3's own bar forward by two days —
  // the real vis-timeline item id for that bar is the segment sub-item id
  // Timeline._itemsForTask already produces for a >=2-segment task.
  const draggedSegmentItemId = Timeline._segmentItemId(id, 3);
  const droppedSeg3Start = new Date('2026-08-24T08:00:00');
  const droppedSeg3End   = new Date('2026-08-24T16:00:00');

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

    // OD-B1a's resolved contract (same semantics the deleted regeneration
    // branch already used at :6614-6616): the dropped position becomes the
    // new FIRST-segment start, so the delta is measured against the task's
    // ORIGINAL parent start_date (segment 1's original start) — not against
    // the dragged segment's own prior position.
    const deltaMs = Util.snap(droppedSeg3Start).getTime() - seg1Start.getTime();
    assert.notEqual(deltaMs, 0, 'sanity: the drag must have actually requested a different start');

    for (let i = 0; i < 3; i++) {
      const original = originalSegments[i];
      const shifted = updated.scheduleSegments[i];
      assert.equal(shifted.startDate.getTime(), original.startDate.getTime() + deltaMs,
        `segment ${i + 1} start shifted by exactly the drag delta`);
      assert.equal(shifted.endDate.getTime(), original.endDate.getTime() + deltaMs,
        `segment ${i + 1} end shifted by exactly the drag delta`);
      assert.equal(shifted.endDate.getTime() - shifted.startDate.getTime(),
        original.endDate.getTime() - original.startDate.getTime(),
        `segment ${i + 1} duration is unchanged`);
    }
    assert.equal(updated.start_date.getTime(), updated.scheduleSegments[0].startDate.getTime(),
      'parent start_date mirrors the shifted first segment');
    assert.equal(updated.end_date.getTime(), updated.scheduleSegments[2].endDate.getTime(),
      'parent end_date mirrors the shifted last segment');
    assert.equal(updated.MACHINE, line);
  } finally {
    Timeline._items = undefined;
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
  }
});

test('Interaction._onDataSetUpdate: a multi-select drag shifts a COMPANION\'s existing >=2 scheduleSegments by the GROUP delta too (whole-branch review fix)', () => {
  // Before this fix, the multi-select branch's companion loop built a plain
  // {start_date, end_date, MACHINE} object directly -- never consulting
  // manualSchedulePatchFor -- so a companion that was itself already split
  // into >=2 scheduleSegments had its PARENT boundaries moved while its
  // CHILD segments stayed stale at their old absolute positions. The
  // companion loop now routes every companion through the same
  // manualSchedulePatchFor the dragged item uses, so this is a real
  // regression check on the same shift contract Step 6 already pins for
  // the dragged item, applied to a companion instead.
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};

  const line = 'MULTI-DRAG-LINE';
  const anchorId = 'multi-anchor';
  const companionId = 'multi-companion';

  const anchorStart = new Date('2026-08-20T08:00:00');
  const anchorEnd   = new Date('2026-08-20T12:00:00'); // RUN_TIME 4h

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
      plant: '5512', RUN_TIME: 4, start_date: anchorStart, end_date: anchorEnd,
    },
    {
      id: companionId, PRODUCTION_ORDER: 'PCOMP', MATERIAL_NUMBER: 'MCOMP', MACHINE: line,
      plant: '5512', RUN_TIME: 24, start_date: seg1Start, end_date: seg3End,
      scheduleSegments: companionOriginalSegments,
    },
  ], 'test');
  Selection.set([anchorId, companionId]);

  // The anchor (dragged item) is dropped two days later; the companion is
  // NOT dragged directly -- it must move by the same group delta.
  const droppedAnchorStart = new Date('2026-08-22T08:00:00');
  const droppedAnchorEnd   = new Date('2026-08-22T12:00:00');

  Timeline._items = {
    get: (i) => (i === anchorId ? { start: droppedAnchorStart, end: droppedAnchorEnd, group: line } : undefined),
    update: () => {},
  };

  try {
    Interaction._onDataSetUpdate({ items: [anchorId] });

    const updatedAnchor = Store.tasks[anchorId];
    assert.equal(updatedAnchor.start_date.getTime(), Util.snap(droppedAnchorStart).getTime(),
      'the dragged anchor commits at the dropped position');

    const updatedCompanion = Store.tasks[companionId];
    assert.equal(updatedCompanion.scheduleSegments.length, 3,
      'the companion is NOT collapsed to a single continuous block just because it was dragged as part of a group');

    const deltaMs = Util.snap(droppedAnchorStart).getTime() - anchorStart.getTime();
    assert.notEqual(deltaMs, 0, 'sanity: the group drag must have actually moved');

    for (let i = 0; i < 3; i++) {
      const original = companionOriginalSegments[i];
      const shifted = updatedCompanion.scheduleSegments[i];
      assert.equal(shifted.startDate.getTime(), original.startDate.getTime() + deltaMs,
        `companion segment ${i + 1} start shifted by exactly the GROUP drag delta, not left stale`);
      assert.equal(shifted.endDate.getTime(), original.endDate.getTime() + deltaMs,
        `companion segment ${i + 1} end shifted by exactly the GROUP drag delta, not left stale`);
      assert.equal(shifted.endDate.getTime() - shifted.startDate.getTime(),
        original.endDate.getTime() - original.startDate.getTime(),
        `companion segment ${i + 1} duration is unchanged`);
    }
    assert.equal(updatedCompanion.start_date.getTime(), updatedCompanion.scheduleSegments[0].startDate.getTime(),
      'companion parent start_date mirrors its own shifted first segment');
    assert.equal(updatedCompanion.end_date.getTime(), updatedCompanion.scheduleSegments[2].endDate.getTime(),
      'companion parent end_date mirrors its own shifted last segment');
    assert.equal(updatedCompanion.MACHINE, line);
  } finally {
    Timeline._items = undefined;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
  }
});

test('Interaction._onDataSetUpdate: a multi-select drag with a failing companion patch commits NOTHING — the dragged item is not partially committed (final-review fix 1)', () => {
  // Regression target: before this fix, Store.updateTask(id, draggedPatch, ...)
  // ran BEFORE the companion loop validated every companion's
  // manualSchedulePatchFor call. A companion with a non-finite/<=0
  // Util.runHours (e.g. RUN_TIME: 0, a real NIMBUS data-quality pattern)
  // makes manualSchedulePatchFor return null, which set companionFailed and
  // broke out -- but the dragged item's Store mutation from earlier was never
  // rolled back and had no UndoStack entry. The fix defers ALL Store/Timeline
  // mutation in this branch until both the dragged item's patch AND every
  // companion's patch have validated successfully.
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorRaf = globalThis.requestAnimationFrame;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  // The failure path calls Timeline._scheduleRebuild(), which schedules via
  // requestAnimationFrame -- not defined in this Node test environment.
  globalThis.requestAnimationFrame = callback => { callback(performance.now()); return 1; };

  const line = 'MULTI-DRAG-FAIL-LINE';
  const anchorId = 'multi-anchor-fail';
  const companionId = 'multi-companion-fail';

  const anchorStart = new Date('2026-08-20T08:00:00');
  const anchorEnd   = new Date('2026-08-20T12:00:00'); // RUN_TIME 4h
  const companionStart = new Date('2026-08-20T08:00:00');
  const companionEnd   = new Date('2026-08-20T12:00:00');

  Store.setTasks([
    {
      id: anchorId, PRODUCTION_ORDER: 'PANCHORF', MATERIAL_NUMBER: 'MANCHORF', MACHINE: line,
      plant: '5512', RUN_TIME: 4, start_date: anchorStart, end_date: anchorEnd,
    },
    {
      // RUN_TIME: 0 -> Util.runHours returns 0 -> manualSchedulePatchFor
      // computes runtimeMinutes <= 0 and returns null for this companion.
      id: companionId, PRODUCTION_ORDER: 'PCOMPF', MATERIAL_NUMBER: 'MCOMPF', MACHINE: line,
      plant: '5512', RUN_TIME: 0, start_date: companionStart, end_date: companionEnd,
    },
  ], 'test');
  Selection.set([anchorId, companionId]);

  const droppedAnchorStart = new Date('2026-08-22T08:00:00');
  const droppedAnchorEnd   = new Date('2026-08-22T12:00:00');

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
    assert.equal(stillAnchor.MACHINE, line, 'the anchor MACHINE must be unchanged (it was already on this line, but must not be re-stamped mid-failure)');

    const stillCompanion = Store.tasks[companionId];
    assert.equal(stillCompanion.start_date.getTime(), companionStart.getTime(),
      'the companion must also be completely unchanged');
    assert.equal(stillCompanion.end_date.getTime(), companionEnd.getTime());

    assert.equal(timelineItemUpdateCalled, false,
      'no Timeline._items.update call should happen for any companion when the batch fails validation');
  } finally {
    Timeline._items = undefined;
    Selection.clear();
    Store.setTasks([], 'test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
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
    Engine.autoReflow = priorAutoReflow;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Timeline._items = undefined;
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});
