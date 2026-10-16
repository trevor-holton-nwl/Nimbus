import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Table, ContextMenu, Printer } from '../../../frontend/scheduling/orders.mjs';
import { GanttFilter, Interaction } from '../../../frontend/scheduling/gantt.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalRaf = globalThis.requestAnimationFrame;
afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.requestAnimationFrame = originalRaf;
});

test('Orders Clear resets quick search, native filters, pasted IDs, chips and shared machines together', t => {
  const input = { value: 'not-found' }, pasted = { value: '123' }, count = { textContent: '1' };
  globalThis.document = { getElementById: id => ({ 'quick-filter': input, 'tbl-flt-pomat-textarea': pasted, 'tbl-flt-pomat-count': count })[id] };
  const calls = [];
  const oldApi = Table._api, oldFilters = Table._chipFilters;
  t.after(() => { Table._api = oldApi; Table._chipFilters = oldFilters; Store.setSelectedLines([], 'test'); });
  Store.setSelectedLines(['L1'], 'test');
  Table._chipFilters = { lines: Store.selectedLines, colors: new Set(['RED']), status: 'needs_planning', dateKey: 'late', poMat: new Set(['123']) };
  Table._api = { setGridOption: (...args) => calls.push(args), isAnyFilterPresent: () => true, setFilterModel: model => calls.push(['native', model]), onFilterChanged() {} };
  for (const key of ['_refreshChipButtons', '_refreshChipDropdowns', '_resetChipSearch']) t.mock.method(Table, key, () => {});
  Table._clearChipFilters();
  assert.equal(input.value, '');
  assert.equal(pasted.value, '');
  assert.equal(count.textContent, '');
  assert.deepEqual(calls, [['quickFilterText', ''], ['native', null]]);
  assert.equal(Store.selectedLines.size, 0);
  assert.equal(Table._chipFilters.lines.size, 0);
  assert.equal(Table._chipFilters.colors.size, 0);
  assert.equal(Table._chipFilters.poMat.size, 0);
  assert.equal(Table._chipFilters.status, null);
  assert.equal(Table._chipFilters.dateKey, null);
});

test('Gantt search finds actual material and parent order identifiers', t => {
  const old = GanttFilter._active;
  t.after(() => { GanttFilter._active = old; });
  const task = { id: 'internal-id', ORDER: '123-A', PARENT_ORDER: '123', MATERIAL_NUMBER: 'M-902', MATERIAL_DESCRIPTION: 'Widget' };
  for (const query of ['m-902', '123-a', '123', 'widget']) {
    GanttFilter._active = { ...old, text: query };
    assert.equal(GanttFilter.matches(task), true, query);
  }
  GanttFilter._active = { ...old, text: 'missing' };
  assert.equal(GanttFilter.matches(task), false);
});

function menuFixture(t) {
  const doc = { activeElement: null };
  const button = action => ({ dataset: { action }, style: {}, disabled: false, hidden: false, focus() { doc.activeElement = this; }, setAttribute() {} });
  const buttons = ['firm', 'unfirm', 'override', 'inspect'].map(button);
  const menu = { hidden: true, style: {}, querySelectorAll: () => buttons, querySelector: selector => buttons.find(b => selector === '[data-action="' + b.dataset.action + '"]'), getBoundingClientRect: () => ({ width: 260, height: 380 }) };
  const origin = { isConnected: true, focus() { doc.activeElement = this; } };
  doc.activeElement = origin;
  doc.getElementById = id => id === 'ctx-menu' ? menu : null;
  globalThis.document = doc;
  globalThis.window = { innerWidth: 200, innerHeight: 160 };
  globalThis.requestAnimationFrame = callback => callback();
  t.mock.method(Store, 'isFirmed', () => false);
  t.after(() => { ContextMenu._targetId = null; ContextMenu._returnFocus = null; });
  return { doc, menu, buttons, origin };
}

function keyEvent(key, target) {
  return { key, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('context menu stays within small viewport and keyboard skips hidden actions, wraps and restores focus', t => {
  const { doc, menu, buttons, origin } = menuFixture(t);
  ContextMenu.open(-200, 500, 'task');
  assert.equal(menu.style.left, '6px');
  assert.equal(menu.style.top, '6px');
  assert.equal(menu.style.maxHeight, '148px');
  assert.equal(doc.activeElement, buttons[0]);
  ContextMenu._onKeyDown(keyEvent('ArrowDown'));
  assert.equal(doc.activeElement, buttons[2]);
  ContextMenu._onKeyDown(keyEvent('End'));
  assert.equal(doc.activeElement, buttons[3]);
  ContextMenu._onKeyDown(keyEvent('ArrowDown'));
  assert.equal(doc.activeElement, buttons[0]);
  ContextMenu._onKeyDown(keyEvent('ArrowUp'));
  assert.equal(doc.activeElement, buttons[3]);
  ContextMenu._onKeyDown(keyEvent('Home'));
  assert.equal(doc.activeElement, buttons[0]);
  const escape = keyEvent('Escape');
  ContextMenu._onKeyDown(escape);
  assert.equal(menu.hidden, true);
  assert.equal(doc.activeElement, origin);
  assert.equal(escape.stopped, true);
});

test('Shift+F10 and Menu open Gantt selected order actions without changing selection', t => {
  const prior = Selection.ids();
  t.after(() => Selection.set(prior));
  Selection.set(['order']);
  const calls = [];
  t.mock.method(ContextMenu, 'openFromKeyboard', id => calls.push(id));
  const target = { closest: selector => selector === '#vis-timeline' ? {} : null };
  for (const [key, shiftKey] of [['F10', true], ['ContextMenu', false]]) {
    const event = { ...keyEvent(key, target), shiftKey };
    Interaction._onKeyDown(event);
    assert.equal(event.prevented, true);
  }
  assert.deepEqual(calls, ['order', 'order']);
  assert.deepEqual(Selection.ids(), ['order']);
});

test('print scopes preserve all-loaded default and distinguish selected plant from exact displayed Orders rows', t => {
  const previous = Store.tasksArr, priorPlant = Store.selectedPlant, api = Table._api;
  t.after(() => { Store.setTasks(previous, 'test'); Store.setSelectedPlant(priorPlant, 'test'); Table._api = api; });
  Store.setTasks([{ id: 'a', PLANT: 'P1' }, { id: 'b', PLANT: 'P1' }, { id: 'c', PLANT: 'P2' }], 'test');
  Store.setSelectedPlant('P1', 'test');
  Table._api = { getDisplayedRowCount: () => 1, getDisplayedRowAtIndex: () => ({ data: Store.tasks.b }) };
  assert.deepEqual(Printer._scopeRows('all').map(task => task.id), ['a', 'b', 'c']);
  assert.deepEqual(Printer._scopeRows('plant').map(task => task.id), ['a', 'b']);
  assert.deepEqual(Printer._scopeRows('filtered').map(task => task.id), ['b']);
  Table._api = null;
  assert.deepEqual(Printer._scopeRows('filtered'), []);
});


test('quick search alone exposes Clear without incorrectly labeling it as a native column filter', t => {
  t.mock.method(Util, 't', key => key);
  const clear = { hidden: true }, hint = { textContent: '' }, input = { value: '123' };
  globalThis.document = { getElementById: id => ({ 'tbl-flt-clear': clear, 'tbl-flt-hint': hint, 'quick-filter': input })[id] || null };
  const api = Table._api, filters = Table._chipFilters, plant = Store.selectedPlant;
  t.after(() => { Table._api = api; Table._chipFilters = filters; Store.setSelectedPlant(plant, 'test'); });
  Store.setSelectedPlant('P1', 'test');
  Table._chipFilters = { lines: new Set(), colors: new Set(), status: null, dateKey: null, poMat: new Set() };
  Table._api = { getFilterModel: () => ({}), getDisplayedRowCount: () => 3, isAnyFilterPresent: () => true };
  Table._refreshChipButtons();
  assert.equal(clear.hidden, false);
  assert.equal(hint.textContent.includes('ui.column_filters_active'), false);
  input.value = '';
  Table._refreshChipButtons();
  assert.equal(clear.hidden, true);
  Table._api.getFilterModel = () => ({ MATERIAL_NUMBER: { filter: 'M' } });
  Table._refreshChipButtons();
  assert.equal(clear.hidden, false);
  assert.equal(hint.textContent.includes('ui.column_filters_active'), true);
});
