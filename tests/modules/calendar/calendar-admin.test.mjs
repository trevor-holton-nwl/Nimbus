// Tests for frontend/calendar/calendar-admin.mjs.
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI } from '../../../frontend/calendar/calendar-admin.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
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
