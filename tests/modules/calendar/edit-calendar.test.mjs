// Tests for frontend/calendar/edit-calendar.mts (EditCalendar). Split from
// tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout. This assertion was
// pulled out of that file's combined 'EditCalendar/ColorWheelViewer/Printer/
// SandboxAdapter/AlertsUIAdapter expose their documented public API' smoke
// test, which spanned five modules across four different new files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditCalendar } from '../../../frontend/calendar/edit-calendar.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';

test('EditCalendar exposes the documented public API', () => {
  assert.equal(typeof EditCalendar.open, 'function');
  assert.equal(typeof EditCalendar.openPlant, 'function');
});

test('EditCalendar plant mode saves an end time of 00:00 as 24 (end of day)', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorFlatpickr = globalThis.flatpickr;
  const priorNimbus = globalThis.NIMBUS;
  const priorToastShow = Toast.show;
  const priorSavePlantHours = CalendarSync.savePlantHours;
  const priorSaveLineHours = CalendarSync.saveLineHours;
  const hadPlant = Object.prototype.hasOwnProperty.call(Store.plants, '1006');
  const priorPlantEntry = Store.plants['1006'];

  const fakes = {}; // selector -> fake flatpickr instance
  globalThis.flatpickr = (selector) => {
    const inst = {
      element: { value: '' },
      setDate(v) { this.element.value = v; },
      clear() { this.element.value = ''; this.cleared = true; },
      cleared: false,
    };
    fakes[selector] = inst;
    return inst;
  };
  const badge = { textContent: '' };
  globalThis.window = { __NIMBUS_LOCALES: { en: {} } };
  globalThis.document = {
    getElementById: id => id === 'cal-edit-toggle-1' ? { checked: true }
      : /^cal-edit-toggle-\d$/.test(id) ? { checked: false }
      : id === 'cal-edit-badge-1' ? badge
      : null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const persisted = [];
  globalThis.NIMBUS = { Plant: { _persistPlantHours(...a) { persisted.push(a); }, render() {} } };
  Toast.show = () => {};
  CalendarSync.savePlantHours = () => {};
  CalendarSync.saveLineHours = () => {};
  try {
    Store.plants['1006'] = {
      workHours: { 0: null, 1: [8, 17], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 17], 6: null },
    };
    EditCalendar.openPlant('1006');
    // A disabled day's pickers are cleared so a later toggle-on gets the
    // 08:00/17:00 defaults instead of the last-opened calendar's times.
    assert.equal(fakes['#cal-edit-start-0'].cleared, true);
    assert.equal(fakes['#cal-edit-end-0'].cleared, true);

    // The picker cannot express 24, so end-of-day arrives as '00:00'.
    fakes['#cal-edit-start-1'].element.value = '06:00';
    fakes['#cal-edit-end-1'].element.value = '00:00';
    EditCalendar.onToggle(1, true);
    assert.equal(badge.textContent, '18h', '06:00 -> 00:00 is an 18 hour day');

    EditCalendar.save();
    assert.deepEqual(Store.plants['1006'].workHours[1], [6, 24]);
    assert.equal(persisted.length, 1, 'plant hours persisted exactly once');
  } finally {
    if (hadPlant) Store.plants['1006'] = priorPlantEntry;
    else delete Store.plants['1006'];
    Toast.show = priorToastShow;
    CalendarSync.savePlantHours = priorSavePlantHours;
    CalendarSync.saveLineHours = priorSaveLineHours;
    if (priorNimbus === undefined) delete globalThis.NIMBUS;
    else globalThis.NIMBUS = priorNimbus;
    if (priorFlatpickr === undefined) delete globalThis.flatpickr;
    else globalThis.flatpickr = priorFlatpickr;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});
