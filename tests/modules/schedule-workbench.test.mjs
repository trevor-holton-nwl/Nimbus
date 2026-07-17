import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter, Dashboard, Interaction, OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, AlertsUIAdapter } from '../../web/schedule-workbench.mjs';
import { Store, Selection } from '../../web/schedule-state.mjs';

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

test('Timeline exposes the documented navigation API', () => {
  assert.equal(typeof Timeline.init, 'function');
  assert.equal(typeof Timeline.rebuild, 'function');
  assert.equal(typeof Timeline.focus, 'function');
  assert.equal(typeof Timeline.gotoLineDay, 'function');
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

test('Dashboard exposes init/render', () => {
  assert.equal(typeof Dashboard.init, 'function');
  assert.equal(typeof Dashboard.render, 'function');
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

test('EditCalendar/ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their documented public API', () => {
  assert.equal(typeof EditCalendar.open, 'function');
  assert.equal(typeof ColorWheelViewer.open, 'function');
  assert.equal(typeof Printer.open, 'function');
  assert.equal(typeof SandboxAdapter.init, 'function');
  assert.equal(typeof AlertsUIAdapter.toggleDrawer, 'function');
});
