import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, PriorityListViewer, Printer, SandboxAdapter, AlertsUIAdapter } from '../../web/schedule-workbench.mjs';
import { Store, Selection } from '../../web/schedule-state.mjs';
import { Util, ErrorLog } from '../../web/application-foundation.mjs';
import { Alerts, Utilization } from '../../web/schedule-services.mjs';
import { Persistence } from '../../web/schedule-data.mjs';

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

test('Timeline resets the initial Gantt vertical position once without affecting later navigation', () => {
  const priorTimeline = Timeline._tl;
  const priorPending = Timeline._initialVerticalScrollPending;
  const scrollTops = [];
  Timeline._tl = { _setScrollTop(top) { scrollTops.push(top); } };
  Timeline._initialVerticalScrollPending = true;
  try {
    Timeline._resetInitialVerticalScroll();
    Timeline._resetInitialVerticalScroll();
    assert.deepEqual(scrollTops, [0], 'only the first populated render starts at the top');
  } finally {
    Timeline._tl = priorTimeline;
    Timeline._initialVerticalScrollPending = priorPending;
  }
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
  globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_rows: [{ line: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
    line_rows: [], line_states: [], overrides: [],
  }, 'unit-test');
  Store.setTasks([
    { id: 'cancel-red', PLANT: plant, PRODUCTION_LINE: line, RUN_TIME: 1, COLOR: 'RED', start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') },
    { id: 'cancel-blue', PLANT: plant, PRODUCTION_LINE: line, RUN_TIME: 1, COLOR: 'BLUE', start_date: new Date('2026-08-17T09:30:00'), end_date: new Date('2026-08-17T10:30:00') },
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
    id: 'timeline-split', PRODUCTION_LINE: 'L-SPLIT', RUN_TIME: 14,
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
    id: 'setup-successor', PRODUCTION_LINE: 'SETUP-L1', RUN_TIME: 3,
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
  const successor = { id: 'missing-successor', PRODUCTION_LINE: 'SETUP-L2', RUN_TIME: 1,
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
    { id: 'diag-initial', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') },
    { id: 'diag-predecessor', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T09:00:00'), end_date: new Date('2026-08-14T10:00:00') },
    { id: 'diag-successor', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T10:00:00'), end_date: new Date('2026-08-14T11:00:00') },
    { id: 'diag-uncovered', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T11:00:00'), end_date: new Date('2026-08-14T12:00:00') },
    { id: 'diag-diverged', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T12:00:00'), end_date: new Date('2026-08-14T13:00:00') },
    { id: 'diag-override', PRODUCTION_LINE: 'SETUP-DIAG', RUN_TIME: 1, start_date: new Date('2026-08-14T13:00:00'), end_date: new Date('2026-08-14T14:00:00') },
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

test('missing setup marker is pinned to the center of a narrow setup bar', () => {
  // Regression target: vis-timeline could reflow the warning marker to an
  // edge of a narrow bar, where it looked misplaced or overflowed. Centring
  // moved from the marker itself (absolute + translate(-50%,-50%)) to a flex
  // rule on its containing `.vis-item-content`, so the marker no longer needs
  // (or has) explicit positioning of its own.
  const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.vis-item\.setup-item\.setup-missing\s*\{[^}]*overflow:\s*hidden/s,
    'the setup-missing bar itself still clips overflow');
  assert.match(css, /\.vis-item\.setup-item\.setup-missing \.vis-item-content\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*\}/s,
    'the setup-missing item content must flex-center its children');
  assert.match(css, /\.setup-missing-marker\s*\{[^}]*position:\s*static[^}]*transform:\s*none/s,
    'the marker itself must no longer carry its own absolute/translate centring');
  const locale = readFileSync(new URL('../../web/locales/en.js', import.meta.url), 'utf8');
  assert.match(locale, /'ui\.setup_missing':\s*'Missing setup matrix data'/);
});

test('Timeline preserves the full required setup duration when capacity conflicts', () => {
  const successor = { id: 'conflict-successor', PRODUCTION_LINE: 'SETUP-L3', RUN_TIME: 1,
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
  const order = { id: 'guard-order', PRODUCTION_LINE: 'SETUP-L1', RUN_TIME: 1,
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

test('Inspector exposes keyboard-equivalent setup detail on the successor, including override and missing states', () => {
  const task = { id: 'detail-successor', PRODUCTION_LINE: 'SETUP-L4', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  const detail = Inspector._setupDetailForTask(task, {
    intervals: [{ line: 'SETUP-L4', predecessorOrderId: 'detail-predecessor', successorOrderId: 'detail-successor',
      start: new Date('2026-08-14T07:30:00'), end: task.start_date, requiredMinutes: 30, availableMinutes: 15,
      predecessorState: 'COLOR=RED', standardMinutes: 45, source: 'occurrence', overrideStatus: 'active' }],
    diagnostics: [{ type: 'setup-uncovered', line: 'SETUP-L4', successorOrderId: 'detail-successor', message: 'Matrix row missing.' }],
  });
  assert.equal(detail.predecessorOrderId, 'detail-predecessor');
  assert.equal(detail.predecessorState, 'COLOR=RED');
  assert.equal(detail.requiredMinutes, 30);
  assert.equal(detail.effectiveMinutes, 30);
  assert.equal(detail.standardMinutes, 45);
  assert.equal(detail.source, 'occurrence');
  assert.equal(detail.overrideStatus, 'active');
  assert.equal(detail.missingDetail, 'Matrix row missing.');
  assert.equal(detail.shortMinutes, 15);
  assert.match(Inspector._setupCapacityConflictText(detail), /15.*30.*15/,
    'the successor detail must state available, required, and short capacity in text');
});

test('Inspector renders derived setup details for orders without setup observations and keeps notes last', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const task = {
    id: 'detail-without-observation', ORDER: '100003', PLANT: 'P-SETUP',
    PRODUCTION_LINE: 'L-SETUP', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00'),
  };
  try {
    const detail = Inspector._setupDetailForTask(task, { intervals: [], diagnostics: [] });
    assert.ok(detail, 'every order should expose a derived setup detail model');
    assert.equal(detail.predecessorOrderId, null);
    assert.equal(detail.requiredMinutes, null);
    assert.equal(detail.missingDetail, null);

    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(task);
    const orderIndex = body.innerHTML.indexOf('ui.insp_order_section');
    const scheduleIndex = body.innerHTML.indexOf('ui.insp_schedule_section');
    const setupIndex = body.innerHTML.indexOf('ui.setup_detail_title');
    const notesIndex = body.innerHTML.indexOf('ui.insp_notes_section');
    assert.ok(orderIndex < scheduleIndex, 'Schedule follows Order');
    assert.ok(scheduleIndex < setupIndex, 'Derived setup follows Schedule');
    assert.ok(setupIndex < notesIndex, 'Notes follows Derived setup and remains last');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
  }
});

test('Inspector does not infer setup values for an order absent from the observation', () => {
  const priorSetup = Store.setupSnapshot;
  const task = {
    id: 'detail-configured-without-observation', ORDER: '100004', PLANT: 'P-SETUP',
    PRODUCTION_LINE: 'L-SETUP', COLOR: 'BLUE', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00'),
  };
  try {
    Store.replaceSetupSnapshot({
      plant: 'P-SETUP',
      definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [{ line: '', signature_version: 1,
        from_key: [{ fieldKey: 'colorWheel', value: 'RED' }],
        to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
      line_rows: [],
      line_states: [{ line: 'L-SETUP', signature_version: 1,
        state_key: [{ fieldKey: 'colorWheel', value: 'RED' }], source: 'manual', reason: 'unit-test' }],
      overrides: [],
    }, 'unit-test');
    const detail = Inspector._setupDetailForTask(task, { intervals: [], diagnostics: [] });
    assert.equal(detail.predecessorState, null);
    assert.equal(detail.requiredMinutes, null);
    assert.equal(detail.effectiveMinutes, null);
    assert.equal(detail.standardMinutes, null);
    assert.equal(detail.source, null);
  } finally {
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
  }
});

test('Inspector formats setup signatures in configured order with readable labels', () => {
  const formatted = Inspector._formatSetupState([
    { fieldKey: 'colorWheel', value: 'Ruby' },
    { fieldKey: 'prt01', value: '7B10' },
    { fieldKey: 'prt02', value: 'T-3' },
  ], { fields: ['colorWheel', 'prt01', 'prt02'] });

  assert.equal(formatted, 'Color: Ruby · PRT01: 7B10 · PRT02: T-3');
});

test('Inspector._isSetupActionTask still identifies the active/earliest-upcoming order on its line (function retained, no longer gates setup controls)', () => {
  // _isSetupActionTask itself is unchanged and still exported, so it is still
  // tested directly here. What changed is that Inspector._render's
  // canWriteSetup no longer calls it — canWriteSetup is now just
  // `!!setupPlant && Inspector._canWriteSetup(setupPlant)`, so setup controls
  // are no longer restricted to the active/earliest-upcoming order. This test
  // intentionally does NOT assert anything about canWriteSetup/button gating.
  const now = new Date('2026-08-17T10:00:00');
  const earlier = { id: 'setup-earlier', PRODUCTION_LINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') };
  const active = { id: 'setup-active', PRODUCTION_LINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T09:30:00'), end_date: new Date('2026-08-17T10:30:00') };
  const later = { id: 'setup-later', PRODUCTION_LINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T11:00:00'), end_date: new Date('2026-08-17T12:00:00') };
  const futureFirst = { id: 'setup-future-first', PRODUCTION_LINE: 'SETUP-FUTURE', RUN_TIME: 1,
    start_date: new Date('2026-08-17T10:15:00'), end_date: new Date('2026-08-17T11:00:00') };
  const futureLater = { id: 'setup-future-later', PRODUCTION_LINE: 'SETUP-FUTURE', RUN_TIME: 1,
    start_date: new Date('2026-08-17T10:30:00'), end_date: new Date('2026-08-17T11:30:00') };
  try {
    Store.setTasks([earlier, active, later, futureLater, futureFirst], 'unit-test');
    assert.equal(Inspector._isSetupActionTask(active, now), true);
    assert.equal(Inspector._isSetupActionTask(later, now), false);
    assert.equal(Inspector._isSetupActionTask(futureFirst, now), true);
    assert.equal(Inspector._isSetupActionTask(futureLater, now), false);
  } finally { Store.setTasks([], 'unit-test'); }
});

test('Inspector derives covered and uncovered exact-pair override values without permitting negative remaining minutes', () => {
  assert.deepEqual(Inspector._setupOverrideValues(20, '-7', ''), { standardMin: 20, remainingMin: 13 });
  assert.deepEqual(Inspector._setupOverrideValues(null, '', '35'), { standardMin: 35, remainingMin: 35 });
  assert.equal(Inspector._setupOverrideValues(20, '-21', ''), null);
  assert.equal(Inspector._setupOverrideValues(null, '', ''), null);
});

test('Inspector shows a plain dash for unavailable setup values and names the missing matrix data only in the explanatory warning', () => {
  // Regression target: missingSetupPlaceholder reverted from a translated
  // 'ui.setup_missing' string back to a plain '—' (Inspector._render no longer
  // calls Util.t for the six per-value placeholders) — only the standalone
  // warning paragraph still names the missing matrix data via setupDiagnosticLabel.
  const priorGetElementById = globalThis.document.getElementById;
  const priorSetupDetail = Inspector._setupDetailForTask;
  const priorTranslate = Util.t;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._setupDetailForTask = () => ({
      predecessorOrderId: null, predecessorState: null, successorOrderId: 'missing-setup-inspector',
      requiredMinutes: null, effectiveMinutes: null, standardMinutes: null, source: 'resolved',
      overrideStatus: null, availableMinutes: null, shortMinutes: null, missingDetail: 'No matching matrix row.',
    });
    Util.t = key => key === 'ui.setup_missing' ? 'Missing setup matrix data' : key;
    Inspector._render({ id: 'missing-setup-inspector', ORDER: '100002', PRODUCTION_LINE: 'L1', RUN_TIME: 1 });
    const setupPanel = body.innerHTML.slice(body.innerHTML.indexOf('ui.setup_detail_title'));
    const dashCount = [...setupPanel.matchAll(/—/g)].length;
    assert.equal(dashCount, 6, 'the six unavailable setup values (predecessor, state, required, effective, standard, override) render a plain dash');
    const missingTextCount = [...setupPanel.matchAll(/Missing setup matrix data/g)].length;
    assert.equal(missingTextCount, 1,
      'only the standalone explanatory warning paragraph names the missing matrix data — the per-value placeholders no longer do');
    assert.match(setupPanel, /No matching matrix row\./, 'the warning still surfaces the diagnostic message text');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Inspector._setupDetailForTask = priorSetupDetail;
    Util.t = priorTranslate;
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

test('Table/Inspector/ContextMenu expose the documented public API', () => {
  assert.equal(typeof Table.init, 'function');
  assert.equal(typeof Inspector.show, 'function');
  assert.equal(typeof Inspector.clear, 'function');
  assert.equal(typeof ContextMenu.open, 'function');
});

test('Orders grid exposes editable priority fields instead of Form Size', () => {
  const columns = Table._priorityColumns();
  assert.deepEqual(columns.map(c => c.field), ['PRT_01', 'PRT_02', 'PRODUCTION_VERSION']);
  assert.ok(columns.every(c => c.editable === true), 'priority fields must be inline-editable');
  assert.ok(!columns.some(c => c.field === 'FORM_SIZE'), 'Form Size must be removed from the Orders view');
});

test('Inspector puts editable priority fields in the Order section', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const priorVisibility = structuredClone(Store.orderFieldVisibility);
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Store.setOrderFieldVisibility({
      ...priorVisibility,
      PRT_01: { inspector: true }, PRT_02: { inspector: true }, PRODUCTION_VERSION: { inspector: true },
    }, 'unit-test');
    Inspector._render({
      id: 'inspector-priority-fields', ORDER: '100001', PRODUCTION_LINE: 'L1', RUN_TIME: 1,
      PRT_01: '1J13', PRT_02: '2K24', PRODUCTION_VERSION: '0001',
    });
    const orderSection = body.innerHTML.slice(0, body.innerHTML.indexOf('ui.insp_notes_section'));
    for (const field of ['PRT_01', 'PRT_02', 'PRODUCTION_VERSION']) {
      assert.match(orderSection, new RegExp(`<input type="text" data-field="${field}"`),
        `${field} is an editable input in the Order section`);
    }
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Store.setOrderFieldVisibility(priorVisibility, 'unit-test');
  }
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
    id: 'filter-split', PLANT: 'P-SPLIT', PRODUCTION_LINE: 'L-SPLIT', text: 'matched nowhere', RUN_TIME: 14,
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

test('Dashboard exposes init/render', () => {
  assert.equal(typeof Dashboard.init, 'function');
  assert.equal(typeof Dashboard.render, 'function');
});

test('Dashboard alert summary treats quote-bearing setup alert IDs as data and delegates actions unchanged', () => {
  // Regression target: setup-uncovered IDs embed a JSON state pair. Interpolating
  // that ID into inline JavaScript closes the double-quoted onclick attribute and
  // renders the rest of the handler around the otherwise-correct alert message.
  const alertId = 'setup-uncovered-setup-uncovered|5512/1000TA|[["colorWheel","BLUE SPRUCE"]]->[["colorWheel","O\'RING"]]';
  const alertMessage = 'No changeover time defined for Color BLUE SPRUCE → Color O\'RING on 1000TA. Add a setup rule to the matrix.';
  const list = { innerHTML: '', onclick: null, insertAdjacentHTML() {} };
  const count = { textContent: '' };
  const priorGetElementById = globalThis.document.getElementById;
  const priorMasterData = structuredClone(Store.masterData);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorFocus = AlertsUIAdapter.focus;
  const priorDismiss = Alerts.dismiss;
  let focusedId = null;
  let dismissedId = null;
  let stopped = 0;

  try {
    globalThis.document.getElementById = id => {
      if (id === 'alert-summary-list') return list;
      if (id === 'alert-summary-count') return count;
      return null;
    };
    Store.setMasterData({
      plants: [{ plant: '5512' }],
      lines: [{ plant: '5512', production_line: '1000TA' }],
    }, 'unit-test');
    Store.setSelectedPlant('5512', 'unit-test');
    Store.setAlerts([{
      id: alertId, type: 'setup-uncovered', sev: 'err', msg: alertMessage,
      taskId: 'setup-successor', line: '1000TA', time: new Date('2026-08-18T10:00:00'),
    }], 'unit-test');
    AlertsUIAdapter.focus = id => { focusedId = id; };
    Alerts.dismiss = id => { dismissedId = id; };

    Dashboard._renderAlertSummary();

    assert.doesNotMatch(list.innerHTML, /\sonclick=/, 'alert data must never be emitted as inline JavaScript');
    assert.match(list.innerHTML, /data-alert-action="focus"/);
    assert.match(list.innerHTML, /data-alert-action="dismiss"/);
    assert.match(list.innerHTML, /&quot;/, 'JSON quotes must be encoded in the HTML attribute');
    assert.match(list.innerHTML, /&#39;/, 'apostrophes must be encoded in the HTML attribute');
    assert.equal(typeof list.onclick, 'function', 'the summary host owns one delegated click handler');

    list.onclick({
      target: { closest: () => ({ dataset: { alertAction: 'focus', alertId } }) },
      stopPropagation() { stopped++; },
    });
    assert.equal(focusedId, alertId);

    list.onclick({
      target: { closest: () => ({ dataset: { alertAction: 'dismiss', alertId } }) },
      stopPropagation() { stopped++; },
    });
    assert.equal(dismissedId, alertId);
    assert.equal(stopped, 1, 'dismiss stops the row-level focus action');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    AlertsUIAdapter.focus = priorFocus;
    Alerts.dismiss = priorDismiss;
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Interaction — CQ-1 Phase 3 Task 5. Zero prior test coverage anywhere in the
// codebase before this task; the densest and highest-risk module in the
// migration (drag/keyboard input pipeline for the Gantt).
// ---------------------------------------------------------------------------

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
// start/end/group for a FIXED task. Writing this test uncovered that the
// module's own header comment ("Fixed orders are reverted in the DataSet and
// never reach the Store") does not match the real code — see the corrected
// comment above `_onDataSetUpdate` in schedule-workbench.mjs. These two tests
// pin the REAL current behavior (a "verbatim move" task must not change
// logic), not the aspirational behavior the stale comment described.

test('Interaction._onDataSetUpdate: the fixed-task noActualChange guard checks only start+group (not end) — a same-start/same-group echo with a changed end is still swallowed', () => {
  const id = 'fx-echo-1';
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  // Same start and same group as the Store, but a DIFFERENT end — the
  // fixed-order noActualChange guard (schedule-workbench.mjs _onDataSetUpdate)
  // deliberately compares only start+group, not end, so this must still be
  // treated as a no-op by that guard specifically. A same-start/same-end/
  // same-group scenario would be caught just as well by the generic `moved`
  // check further down (start+end+line) regardless of whether the fixed-only
  // guard exists at all, which is why that shape doesn't actually characterize
  // this guard (confirmed by mutation: disabling the guard while keeping that
  // shape still passed). This shape — start+group unchanged, end changed —
  // only stays a no-op because of the fixed-specific guard; if the guard is
  // removed or broken, this scenario falls through to the generic `moved`
  // check, which DOES see the changed end and commits it, failing this test.
  const differentEnd = new Date('2026-07-01T14:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX1', MATERIAL_NUMBER: 'MFX1', PRODUCTION_LINE: 'L1',
    plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFixed([id], true, 'test');
  Selection.clear();

  Timeline._items = { get: (i) => (i === id ? { start, end: differentEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(Store.tasks[id].start_date.getTime(), start.getTime(), 'the fixed-task guard must treat a same-start/same-group echo as a no-op even when end differs');
    assert.equal(Store.tasks[id].end_date.getTime(), end.getTime(), 'the fixed-task guard must not let the changed end leak into the Store');
  } finally {
    Timeline._items = undefined;
  }
});

test('Interaction._onDataSetUpdate: a genuine drag on a fixed task commits today — fixed-order protection only suppresses no-op echoes, not real drags', () => {
  const id = 'fx-real-1';
  const start = new Date('2026-07-01T08:00:00');
  const end   = new Date('2026-07-01T12:00:00');
  const draggedStart = new Date('2026-07-01T09:00:00');
  const draggedEnd   = new Date('2026-07-01T13:00:00');
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'PFX2', MATERIAL_NUMBER: 'MFX2', PRODUCTION_LINE: 'L1',
    plant: '5512', start_date: start, end_date: end, RUN_TIME: 4, COLOR: 'RED', FORM_SIZE: 'S',
  }], 'test');
  Store.setFixed([id], true, 'test');
  Selection.clear();

  Timeline._items = { get: (i) => (i === id ? { start: draggedStart, end: draggedEnd, group: 'L1' } : undefined) };
  try {
    Interaction._onDataSetUpdate({ items: [id] });
    assert.equal(
      Store.tasks[id].start_date.getTime(), draggedStart.getTime(),
      'current behavior: a genuine drag on a fixed task commits to the Store — it is NOT reverted (see the corrected header comment in schedule-workbench.mjs)'
    );
    assert.equal(Store.tasks[id].end_date.getTime(), draggedEnd.getTime());
  } finally {
    Timeline._items = undefined;
  }
});

test('OptimizeDialog/OptimizerPreview expose the documented public API', () => {
  assert.equal(typeof OptimizeDialog.open, 'function');
  assert.equal(typeof OptimizeDialog.run, 'function');
  assert.equal(typeof OptimizerPreview.runWithPreview, 'function');
});

test('combined is no longer an optimizer strategy users can select', () => {
  const { readFileSync } = require('node:fs');
  const types = readFileSync(new URL('../../web/types.mts', import.meta.url), 'utf8');
  const dialogMarkup = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(types, /'combined'/,
    'the public optimizer-mode type must not expose the retired strategy');
  assert.doesNotMatch(dialogMarkup, /data-mode="combined"/,
    'the optimize dialog must not render a combined strategy button');
});

test('OptimizerPreview retains only a bounded candidate explanation and drops it on discard', () => {
  // Regression target: retaining raw candidate schedules/reasons would make a
  // long preview unbounded and leave setup explanation data after Discard.
  const candidate = {
    patches: [{ id: 'changed-1', changes: { start_date: new Date('2026-08-14T08:00:00') } }],
    explanation: Array.from({ length: 14 }, (_, index) => ({ code: `reason-${index}`, message: `Reason ${index}`, line: 'L-1' })),
    diagnostics: { candidateCount: 23, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 37, limitReached: false, events: [] },
    unchangedLines: ['L-2', 'L-3'],
    missingEdges: Array.from({ length: 16 }, (_, index) => ({ line: 'L-1', predecessorOrderId: `before-${index}`, successorOrderId: `after-${index}`, reason: 'matrix-missing' })),
  };
  const explanation = OptimizerPreview.summarizeCandidate(candidate, {
    productionBefore: 10, productionAfter: 10, preKpis: { changeovers: 8, span_h: 20, late_count: 4, late_h: 6, peak_util_pct: 92 },
    postKpis: { changeovers: 6, span_h: 18, late_count: 2, late_h: 3, peak_util_pct: 88 },
  });
  assert.equal(explanation.reasons.length, 8, 'the UI explanation caps candidate reasons');
  assert.equal(explanation.missingPairs.length, 12, 'the UI explanation caps missing setup pairs');
  assert.deepEqual(explanation.search, { candidateCount: 23, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 37, limitReached: false });
  assert.equal(Object.hasOwn(explanation, 'tasks'), false, 'the compact explanation never retains a schedule snapshot');

  OptimizerPreview._explanation = explanation;
  OptimizerPreview.active = true;
  OptimizerPreview.discard();
  assert.equal(OptimizerPreview._explanation, null, 'Discard destroys the in-memory explanation');
});

test('OptimizerPreview derives and exports real setup states for bounded missing pairs', () => {
  // Regression target: displaying order IDs in From/To (and exporting no
  // states) prevents a matrix editor from acting on the reported pair.
  const candidate = {
    patches: [], explanation: [], diagnostics: { candidateCount: 1, method: 'spt-detached', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] },
    unchangedLines: [], missingEdges: [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', reason: 'matrix-missing' }],
  };
  const setup = {
    plant: '5512', definition: { plant: '5512', fields: ['colorWheel'], strict_blanks: true, signature_version: 1, active: false },
    plant_rows: [], line_rows: [], line_states: [], overrides: [],
  };
  const pairs = OptimizerPreview.describeMissingPairs(candidate, [
    { id: 'red-order', PLANT: '5512', PRODUCTION_LINE: 'L-1', COLOR: 'RED' },
    { id: 'blue-order', PLANT: '5512', PRODUCTION_LINE: 'L-1', COLOR: 'BLUE' },
  ], setup);
  assert.deepEqual(pairs, [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', fromState: 'colorWheel=RED', toState: 'colorWheel=BLUE', reason: 'matrix-missing' }]);
  const csv = OptimizerPreview.missingPairsCsv(pairs);
  assert.match(csv, /From setup state,To setup state/);
  assert.match(csv, /colorWheel=RED/);
  assert.match(csv, /colorWheel=BLUE/);
});

test('Persistence setup writes stale an open preview without applying or rerunning it', () => {
  // Regression target: a successful matrix/state/override write must require
  // an explicit preview rerun instead of applying or recomputing silently.
  const priorFetch = globalThis.fetch;
  const candidate = { patches: [], explanation: [], diagnostics: { candidateCount: 1, method: 'spt-detached', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] }, unchangedLines: [], missingEdges: [] };
  let requests = 0;
  globalThis.fetch = () => { requests++; return Promise.resolve({ ok: true }); };
  OptimizerPreview._snapshot = [];
  OptimizerPreview._candidate = candidate;
  OptimizerPreview._explanation = OptimizerPreview.summarizeCandidate(candidate, { productionBefore: 1, productionAfter: 1, preKpis: { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0 }, postKpis: { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0 } });
  OptimizerPreview._plant = 'STALE';
  OptimizerPreview.active = true;
  try {
    for (const kind of ['definition', 'matrix', 'state', 'override']) {
      OptimizerPreview.stale = false;
      Persistence.noteSetupWrite('STALE', kind);
      assert.equal(OptimizerPreview.stale, true, `${kind} writes stale an open preview`);
      assert.equal(OptimizerPreview.canApply(), false, 'stale previews cannot apply');
    }
    OptimizerPreview.apply();
    assert.equal(OptimizerPreview._candidate, candidate, 'Apply leaves a stale candidate intact for explicit rerun or discard');
    assert.equal(requests, 0, 'staling and blocked Apply never write an audit row or rerun optimization');
  } finally {
    OptimizerPreview._clear();
    globalThis.fetch = priorFetch;
  }
});

test('OptimizerPreview keeps trial patches detached until Apply, then commits them once', () => {
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorTimelineItems = Timeline._items;
  const priorPlant = Store.selectedPlant;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorFetch = globalThis.fetch;
  const timelineUpdates = [];
  const publications = [];
  const auditRequests = [];
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  Timeline._items = { update(items) { timelineUpdates.push(...items); } };
  Alerts.scheduleRecompute = () => {};
  globalThis.fetch = (...args) => {
    auditRequests.push(args);
    return Promise.resolve({ ok: true });
  };
  Store.setTasks([
    { id: 'preview-long', PLANT: 'PREVIEW', PRODUCTION_LINE: 'L1', RUN_TIME: 5, start_date: null, end_date: null },
    { id: 'preview-short', PLANT: 'PREVIEW', PRODUCTION_LINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('PREVIEW', 'unit-test');
  const beforeRevision = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const unsubscribe = Store.subscribe(event => { publications.push(event.type); }, 'unit-test-autosave');

  try {
    const previewOptions = {
      plant: 'PREVIEW', respectCalendar: false, now: new Date('2026-08-03T08:00:00'),
      auditDetails: {
        mode: 'spt', wheelUsed: false, taskCount: 2, scope: 'plant', lines: null,
        activePriorityFields: [], unrankedPriorityFields: [], splitOrderPolicy: 'never',
      },
    };
    OptimizerPreview.runWithPreview('spt', previewOptions);

    assert.ok(OptimizerPreview._candidate, 'the preview retains a detached candidate for Apply');
    assert.equal(Store.rev(), beforeRevision, 'opening a preview must not publish trial schedule state');
    assert.deepEqual(Store.tasks, beforeTasks, 'opening a preview must not alter live task values');
    assert.deepEqual(timelineUpdates, [], 'a detached preview must not issue timeline item updates');
    assert.deepEqual(publications, [], 'autosave-like Store subscribers must stay idle before Apply');
    assert.deepEqual(auditRequests, [], 'a detached candidate must not persist an audit row before Apply');

    OptimizerPreview.discard();

    assert.equal(OptimizerPreview._candidate, null, 'Discard destroys the detached candidate');
    assert.equal(OptimizerPreview._explanation, null, 'Discard destroys the compact explanation with the candidate');
    assert.equal(Store.rev(), beforeRevision, 'Discard must not roll back through Store because Store never changed');
    assert.deepEqual(Store.tasks, beforeTasks, 'Discard leaves the live schedule untouched');
    assert.deepEqual(publications, [], 'Discard must not wake autosave-like subscribers');
    assert.deepEqual(auditRequests, [], 'Discard must not persist an audit row');

    OptimizerPreview.runWithPreview('spt', previewOptions);

    OptimizerPreview.apply();

    assert.ok(Store.tasks['preview-short'].start_date, 'Apply commits the selected candidate patch set');
    assert.equal(OptimizerPreview._explanation, null, 'Apply destroys the explanation after committing its candidate');
    assert.equal(publications.filter(type => type === 'tasks:bulkUpdate').length, 1,
      'Apply performs exactly one schedule task commit');
    assert.equal(auditRequests.length, 1, 'Apply emits the deferred audit row');
    assert.doesNotMatch(JSON.stringify(auditRequests), /explanation/i,
      'the applied optimization audit never persists preview explanation data');
    assert.equal(timelineUpdates.length, 0, 'the evaluator itself never writes Timeline items');
  } finally {
    unsubscribe();
    OptimizerPreview._clear();
    Alerts.scheduleRecompute = priorScheduleRecompute;
    globalThis.fetch = priorFetch;
    Timeline._items = priorTimelineItems;
    Store.setTasks([], 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
  }
});

test('OptimizerPreview computes KPI utilization against detached calendar and plant maps', () => {
  // Removing the preview utilization context would let the production resolver
  // pass Store.calendars/plants to compute core, which fills missing defaults.
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const priorPlants = structuredClone(Store.plants);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const scheduledStart = new Date();
  scheduledStart.setHours(8, 0, 0, 0);
  const scheduledEnd = new Date(scheduledStart.getTime() + 60 * 60 * 1000);
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  globalThis.NimbusComputeCore = require('../../web/nimbus-compute-core.js');
  Alerts.scheduleRecompute = () => {};
  Util.setUtilizationResolver((from, days, tasks, snapshot) =>
    Utilization.computeMatrix(from, days, tasks, snapshot));
  Store.replaceCalendars({}, 'unit-test');
  Store.replacePlants({}, 'unit-test');
  Store.setLineSetting('KPI-DETACHED-LINE', { plant: 'KPI-DETACHED' }, 'unit-test');
  Store.setTasks([{
    id: 'kpi-detached-order', PLANT: 'KPI-DETACHED', PRODUCTION_LINE: 'KPI-DETACHED-LINE', RUN_TIME: 1,
    start_date: scheduledStart, end_date: scheduledEnd,
  }], 'unit-test');
  Store.setSelectedPlant('KPI-DETACHED', 'unit-test');
  const beforeCalendars = structuredClone(Store.calendars);
  const beforePlants = structuredClone(Store.plants);

  try {
    OptimizerPreview.runWithPreview('spt', { plant: 'KPI-DETACHED', respectCalendar: false });

    assert.ok(OptimizerPreview._candidate, 'the preview completes its detached KPI comparison');
    assert.deepEqual(Store.calendars, beforeCalendars,
      'KPI computation must not fill missing line calendars in Store before Apply');
    assert.deepEqual(Store.plants, beforePlants,
      'KPI computation must not fill missing plant calendars in Store before Apply');
  } finally {
    OptimizerPreview._clear();
    Util.setUtilizationResolver(null);
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.replacePlants(priorPlants, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
    globalThis.NimbusComputeCore = priorCore;
  }
});

test('OptimizerPreview keeps evaluation failures out of ErrorLog persistence', () => {
  // Restoring ErrorLog.error() in the preview catch would persist an un-applied
  // backlog candidate failure instead of retaining only ephemeral diagnostics.
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const beforeEntries = ErrorLog.entries();
  const priorSave = ErrorLog._scheduleSave;
  const priorShip = ErrorLog._scheduleShip;
  let saveCalls = 0;
  let shipCalls = 0;
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  ErrorLog._scheduleSave = () => { saveCalls++; };
  ErrorLog._scheduleShip = () => { shipCalls++; };
  Store.setMasterData({ plants: [{ plant: 'PREVIEW-FAIL' }], lines: [{ plant: 'PREVIEW-FAIL', production_line: 'FAIL-LINE' }] }, 'unit-test');
  Store.setTasks([{ id: 'preview-fail', PLANT: 'PREVIEW-FAIL', PRODUCTION_LINE: 'FAIL-LINE', RUN_TIME: 1, start_date: new Date(), end_date: new Date() }], 'unit-test');
  Store.setSelectedPlant('PREVIEW-FAIL', 'unit-test');

  try {
    OptimizerPreview.runWithPreview('backlog', { plant: 'PREVIEW-FAIL', respectCalendar: true });

    assert.deepEqual(ErrorLog.entries(), beforeEntries,
      'a preview evaluation failure must not enter the persistent error log');
    assert.equal(saveCalls, 0, 'a preview evaluation failure must not schedule IndexedDB persistence');
    assert.equal(shipCalls, 0, 'a preview evaluation failure must not schedule backend error shipping');
    assert.equal(OptimizerPreview._previewDiagnostics?.[0]?.code, 'candidate-evaluation-failed',
      'the failure remains structured in preview-local memory');
  } finally {
    OptimizerPreview._clear();
    ErrorLog._entries = beforeEntries;
    ErrorLog._scheduleSave = priorSave;
    ErrorLog._scheduleShip = priorShip;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
  }
});

test('EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their documented public API', () => {
  assert.equal(typeof EditCalendar.open, 'function');
  assert.equal(typeof ColorWheelViewer.open, 'function');
  assert.equal(typeof Printer.open, 'function');
  assert.equal(typeof SandboxAdapter.init, 'function');
  assert.equal(typeof AlertsUIAdapter.toggleDrawer, 'function');
});

test('alert drawer renders quote-bearing IDs as action data and delegates the original value', () => {
  const alertId = 'setup-uncovered|[["colorWheel","O\'RING <RED>"]]->[["colorWheel","RUBY"]]';
  const row = AlertsUIAdapter._renderAlertRow({
    id: alertId, type: 'setup-uncovered', sev: 'err', msg: 'Missing setup rule.',
    taskId: 'setup-successor', line: '1000TA', time: new Date('2026-08-18T10:00:00'),
  });

  assert.doesNotMatch(row, /\sonclick=/, 'drawer actions must not compile alert data as JavaScript');
  assert.match(row, /data-alert-action="focus"/);
  assert.match(row, /data-alert-action="dismiss"/);
  assert.match(row, /&quot;/);
  assert.match(row, /&#39;/);
  assert.match(row, /&lt;RED&gt;/);
  assert.equal(typeof AlertsUIAdapter._handleAction, 'function');

  const priorFocus = AlertsUIAdapter.focus;
  let focusedId = null;
  try {
    AlertsUIAdapter.focus = id => { focusedId = id; };
    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'focus', alertId } }) },
      stopPropagation() {},
    });
    assert.equal(focusedId, alertId);
  } finally {
    AlertsUIAdapter.focus = priorFocus;
  }
});

test('alert drawer delegates fix and override actions without compiling IDs into handlers', () => {
  const alertId = 'overlap|[["colorWheel","O\'RING"]]';
  const taskId = 'task-"quoted"';
  const fixRow = AlertsUIAdapter._renderAlertRow({
    id: alertId, type: 'overlap', sev: 'err', msg: 'Overlap.', taskId, line: '1000TA', time: new Date(),
  });
  const overrideRow = AlertsUIAdapter._renderAlertRow({
    id: 'closed-alert', type: 'closed', sev: 'warn', msg: 'Closed.', taskId, line: '1000TA', time: new Date(),
  });
  assert.doesNotMatch(fixRow, /\sonclick=/);
  assert.doesNotMatch(overrideRow, /\sonclick=/);
  assert.match(fixRow, /data-alert-action="fix"/);
  assert.match(overrideRow, /data-alert-action="override"/);

  const priorApplyFix = Alerts.applyFix;
  const priorToggleDrawer = AlertsUIAdapter.toggleDrawer;
  const priorOpenOverride = Table._openOverrideModalForId;
  let fixedId = null;
  let drawerToggles = 0;
  let overrideTaskId = null;
  try {
    Alerts.applyFix = id => { fixedId = id; };
    AlertsUIAdapter.toggleDrawer = () => { drawerToggles++; };
    Table._openOverrideModalForId = id => { overrideTaskId = id; };

    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'fix', alertId } }) },
      stopPropagation() {},
    });
    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'override', taskId } }) },
      stopPropagation() {},
    });

    assert.equal(fixedId, alertId);
    assert.equal(drawerToggles, 1);
    assert.equal(overrideTaskId, taskId);
  } finally {
    Alerts.applyFix = priorApplyFix;
    AlertsUIAdapter.toggleDrawer = priorToggleDrawer;
    Table._openOverrideModalForId = priorOpenOverride;
  }
});

test('alert drawer host binds the delegated action handler even in its empty state', () => {
  const body = { innerHTML: '', onclick: null };
  const priorGetElementById = globalThis.document.getElementById;
  const priorAlerts = structuredClone(Store.alerts);
  try {
    globalThis.document.getElementById = id => id === 'alert-drawer-body' ? body : null;
    Store.setAlerts([], 'unit-test');

    assert.equal(typeof AlertsUIAdapter._handleAction, 'function');
    AlertsUIAdapter.renderDrawer();

    assert.equal(body.onclick, AlertsUIAdapter._handleAction);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Store.setAlerts(priorAlerts, 'unit-test');
  }
});

test('PriorityListViewer exposes open/close/search', () => {
  assert.equal(typeof PriorityListViewer.open, 'function');
  assert.equal(typeof PriorityListViewer.close, 'function');
  assert.equal(typeof PriorityListViewer.search, 'function');
});
