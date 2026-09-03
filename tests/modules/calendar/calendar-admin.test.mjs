// Tests for frontend/calendar/calendar-admin.mjs.
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI } from '../../../frontend/calendar/calendar-admin.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Modal, Util } from '../../../frontend/platform/foundation.mjs';
import { setActiveTabResolvers } from '../../../frontend/shell/tab-resolvers.mjs';

test('CalendarUI exposes its documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
});

test('CalendarUI refreshes the visible calendar pane after replacement events', () => {
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
  };
  const lineSelect = { value: 'all', onchange: null };
  const priorWindow = globalThis.window;
  globalThis.document = {
    getElementById(id) {
      if (id === 'cal-hours-body') return body;
      if (id === 'cal-line-select') return lineSelect;
      return null;
    },
  };
  globalThis.window = globalThis.window || {};
  setActiveTabResolvers({ currentTab: () => 'masterdata', currentMasterSub: () => 'plant' });

  try {
    Store.setTasks([{ id: 'calendar-admin-task', PLANT: 'CAL-ADMIN', MACHINE: 'CAL-LINE', RUN_TIME: 1 }], 'unit-test');
    Store.setSelectedPlant('CAL-ADMIN', 'unit-test');
    Store.replaceCalendars({ 'CAL-LINE': { workHours: { 0: [8, 16] } } }, 'unit-test');
    assert.match(body.innerHTML, /08:00/);

    Store.replaceCalendars({ 'CAL-LINE': { workHours: { 0: [9, 17] } } }, 'unit-test');
    assert.match(body.innerHTML, /09:00/, 'the visible pane rerenders after the replacement change event');
  } finally {
    globalThis.document = priorDocument;
    globalThis.window = priorWindow;
    setActiveTabResolvers({ currentTab: () => null, currentMasterSub: () => null });
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('CalendarUI escapes line identifiers in rendered HTML contexts', () => {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const priorLineFilter = CalendarUI._lineFilter;
  const priorBlockFilter = CalendarUI._blockFilter;
  const priorFpStart = CalendarUI._fpBlkStart;
  const priorFpEnd = CalendarUI._fpBlkEnd;
  const maliciousLine = 'L" data-x="owned"><img src=x onerror=alert(1)>';
  const body = { innerHTML: '', querySelectorAll() { return []; } };
  const lineSelect = { value: 'all', onchange: null };
  const blockSelect = { value: 'all', onchange: null };
  const blocksList = { innerHTML: '', onclick: null };
  const modalLineSelect = { innerHTML: '' };
  const modalReason = { value: '' };
  const priorFpDatetime = Util.fpDatetime;
  const priorModalOpen = Modal.open;
  globalThis.document = {
    getElementById(id) {
      return {
        'cal-hours-body': body,
        'cal-line-select': lineSelect,
        'cal-blocks-list': blocksList,
        'cal-block-filter': blockSelect,
        'blk-line': modalLineSelect,
        'blk-reason': modalReason,
      }[id] || null;
    },
  };
  globalThis.window = globalThis.window || {};
  Util.fpDatetime = () => ({ setDate() {} });
  Modal.open = () => {};
  setActiveTabResolvers({ currentTab: () => 'masterdata', currentMasterSub: () => 'plant' });

  try {
    Store.setTasks([{ id: 'calendar-xss-task', PLANT: 'CAL-XSS', MACHINE: maliciousLine, RUN_TIME: 1 }], 'unit-test');
    Store.setSelectedPlant('CAL-XSS', 'unit-test');
    Store.replaceCalendars({ [maliciousLine]: { workHours: { 0: [8, 16] } } }, 'unit-test');
    CalendarUI.render();
    CalendarUI.openBlockModal();

    assert.doesNotMatch(body.innerHTML, /<img/i, 'task line data never becomes executable markup in the hours pane');
    assert.doesNotMatch(blocksList.innerHTML, /<img/i, 'task line data never becomes executable markup in the block filter');
    assert.doesNotMatch(modalLineSelect.innerHTML, /<img/i, 'task line data never becomes executable markup in the blackout modal');
    assert.match(body.innerHTML, /&lt;img/i, 'the hours pane retains the escaped line text');
    assert.match(modalLineSelect.innerHTML, /&lt;img/i, 'the blackout modal retains the escaped line text');
    assert.ok(body.innerHTML.includes(`data-line="${Util.escapeHtml(maliciousLine)}"`));
  } finally {
    Util.fpDatetime = priorFpDatetime;
    Modal.open = priorModalOpen;
    globalThis.document = priorDocument;
    globalThis.window = priorWindow;
    setActiveTabResolvers({ currentTab: () => null, currentMasterSub: () => null });
    CalendarUI._lineFilter = priorLineFilter;
    CalendarUI._blockFilter = priorBlockFilter;
    CalendarUI._fpBlkStart = priorFpStart;
    CalendarUI._fpBlkEnd = priorFpEnd;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('CalendarUI replaces its delegated block handler instead of stacking listeners', () => {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorBlockFilter = CalendarUI._blockFilter;
  const list = { innerHTML: '', onclick: null };
  const blockSelect = { value: 'all', onchange: null };
  globalThis.window = globalThis.window || {};
  globalThis.document = {
    getElementById(id) {
      if (id === 'cal-blocks-list') return list;
      if (id === 'cal-block-filter') return blockSelect;
      return null;
    },
  };

  try {
    CalendarUI._blockFilter = 'all';
    CalendarUI._renderBlocks();
    const firstHandler = list.onclick;
    CalendarUI._renderBlocks();
    assert.equal(typeof list.onclick, 'function');
    assert.notEqual(list.onclick, firstHandler, 'the persistent list has one replacement handler, not an added listener');
  } finally {
    globalThis.document = priorDocument;
    globalThis.window = priorWindow;
    CalendarUI._blockFilter = priorBlockFilter;
  }
});
