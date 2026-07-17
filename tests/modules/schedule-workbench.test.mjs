import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, TimelineNav, DependencyOverlay, Table, Inspector, ContextMenu, Hierarchy, GanttFilter } from '../../web/schedule-workbench.mjs';
import { Store } from '../../web/schedule-state.mjs';

// GanttFilter.isolateLine/restoreAllLines call the module's existing
// _refreshLineBtn/_buildLineDropdown DOM helpers, which reference bare
// `document` — same split-realm/no-DOM situation documented in
// tests/modules/schedule-services.test.mjs and schedule-data.test.mjs. Mirror
// their minimal stub so those calls are a real no-op under plain Node instead
// of throwing "document is not defined".
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

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
