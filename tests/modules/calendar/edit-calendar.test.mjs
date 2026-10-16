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
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';
import { createRequire } from 'node:module';

// clampLinesToPlant reads the compute core from the global, exactly as the browser (classic script) provides it.
globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

// EditCalendar caches its Flatpickr instances for the life of the module, so one shared fake factory (selector -> instance)
// serves every test in this file; instances are created by whichever test opens the editor first.
const fakes = {};
globalThis.flatpickr = (selector, cfg) => {
  const inst = {
    cfg,
    element: { value: '' },
    setDate(v) { this.element.value = v; },
    clear() { this.element.value = ''; this.cleared = true; },
    cleared: false,
  };
  fakes[selector] = inst;
  return inst;
};

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
  const toasts = [];
  Toast.show = (...args) => toasts.push(args);
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
    assert.equal(badge.textContent, '18h · ui.cal_to_midnight', '06:00 -> 00:00 is an 18 hour day that runs to midnight');

    EditCalendar.save();
    assert.deepEqual(Store.plants['1006'].workHours[1], [6, 24]);
    assert.equal(persisted.length, 1, 'plant hours persisted exactly once');
    assert.equal(toasts.at(-1)[0], 'toast.calendar_changes_pending');
    assert.equal(toasts.at(-1)[1], 'info');
    Sandbox.active = true;
    EditCalendar.openPlant('1006');
    EditCalendar.save();
    assert.equal(toasts.at(-1)[0], 'toast.calendar_whatif_local');
  } finally {
    Sandbox.active = false;
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

// ---------------------------------------------------------------------------
// Period mode + midnight load direction. One fake DOM, built once: EditCalendar
// binds its "No end date" / name listeners to the first elements it sees.
// ---------------------------------------------------------------------------
const mk = () => {
  const el = {
    value: '', checked: false, hidden: false, textContent: '', attrs: {}, listeners: {}, focused: false,
    classes: new Set(),
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    focus() { this.focused = true; },
  };
  el.classList = { add: c => el.classes.add(c), remove: c => el.classes.delete(c) };
  return el;
};
const pEls = {};
for (const id of ['cal-period-name', 'cal-period-from', 'cal-period-to', 'cal-period-noend', 'cal-period-name-err',
  'cal-period-from-err', 'cal-period-to-err', 'cal-period-overlap-err', 'cal-period-closed-warn',
  'cal-edit-period-fields', 'cal-edit-save-label', 'cal-edit-title', 'cal-edit-line-name', 'cal-edit-plant-name',
  'cal-edit-save-btn', 'cal-edit-close-btn']) {
  pEls[id] = mk();
}
const toggles = Array.from({ length: 7 }, () => ({ checked: false }));
const badges = Array.from({ length: 7 }, () => ({ textContent: '' }));
const modalLog = [];
const modalInner = { classList: { add: c => modalLog.push(['add', c]), remove: c => modalLog.push(['remove', c]) } };
const copyBtn = { style: {} };
const modalEl = {
  hidden: true,
  querySelector: sel => (sel === '.cal-copy-plant-btn' ? copyBtn : sel === '.cal-edit-modal' ? modalInner : null),
};
const periodDoc = {
  getElementById: id => {
    if (id === 'modal-edit-calendar') return modalEl;
    const t = /^cal-edit-toggle-(\d)$/.exec(id); if (t) return toggles[Number(t[1])];
    const b = /^cal-edit-badge-(\d)$/.exec(id); if (b) return badges[Number(b[1])];
    return pEls[id] ?? null;
  },
  querySelectorAll: () => [],
  querySelector: () => null,
};

function withPeriodEnv(fn) {
  const prior = {
    window: globalThis.window, document: globalThis.document, raf: globalThis.requestAnimationFrame,
    nimbus: globalThis.NIMBUS, toast: Toast.show, save: CalendarSync.savePlantPeriods,
  };
  globalThis.window = { __NIMBUS_LOCALES: { en: {} } };
  globalThis.document = periodDoc;
  globalThis.requestAnimationFrame = f => f();
  const persisted = [];
  globalThis.NIMBUS = { Plant: { _persistPlantHours(...a) { persisted.push(a); }, render() { persisted.push(['render']); } }, ProdLines: { render() { persisted.push(['prodlines']); } } };
  const toasts = [];
  Toast.show = (...a) => toasts.push(a);
  const saves = [];
  CalendarSync.savePlantPeriods = async (plant, next) => { saves.push([plant, next]); return { ok: true }; };
  const hadPlant = Object.prototype.hasOwnProperty.call(Store.plants, '1006');
  const priorPlant = Store.plants['1006'];
  Store.plants['1006'] = { workHours: { 0: null, 1: [12, 24], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 17], 6: null } };
  modalLog.length = 0; modalEl.hidden = true;
  for (const id of Object.keys(pEls)) { pEls[id].hidden = false; pEls[id].textContent = ''; pEls[id].attrs = {}; pEls[id].classes.clear(); pEls[id].focused = false; }
  pEls['cal-period-noend'].checked = false;
  Sandbox.active = false;
  return Promise.resolve(fn({ persisted, toasts, saves })).finally(() => {
    Sandbox.active = false;
    if (hadPlant) Store.plants['1006'] = priorPlant; else delete Store.plants['1006'];
    Store.setPlantPeriods('1006', [], 'test');
    Toast.show = prior.toast; CalendarSync.savePlantPeriods = prior.save;
    for (const [k, v] of [['window', prior.window], ['document', prior.document], ['requestAnimationFrame', prior.raf], ['NIMBUS', prior.nimbus]]) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  });
}

test('EditCalendar loads a stored end of 24 as 00:00 and the badge says it runs to midnight', () => withPeriodEnv(() => {
  EditCalendar.openPlant('1006');
  assert.equal(fakes['#cal-edit-start-1'].element.value, '12:00');
  assert.equal(fakes['#cal-edit-end-1'].element.value, '00:00', 'the picker cannot hold 24');
  assert.equal(badges[1].textContent, '12h · ui.cal_to_midnight');
  assert.equal(badges[2].textContent, '9h', 'an ordinary day keeps the plain badge');
  assert.equal(pEls['cal-edit-period-fields'].hidden, true, 'plant mode hides the period block');
  assert.equal(copyBtn.style.display, 'none');
}));

test('EditCalendar period mode: shows the period block, seeds from the plant default, saves the payload', () => withPeriodEnv(async ({ persisted, saves, toasts }) => {
  EditCalendar.openPeriod('1006');
  assert.equal(pEls['cal-edit-period-fields'].hidden, false);
  assert.equal(pEls['cal-edit-title'].textContent, 'modal.period_title');
  assert.equal(pEls['cal-edit-line-name'].textContent, 'ui.cal_plant_label');
  assert.equal(pEls['cal-edit-save-label'].textContent, 'btn.save_period');
  assert.equal(copyBtn.style.display, 'none');
  assert.equal(fakes['#cal-edit-end-1'].element.value, '00:00', 'seeded from the plant default week');
  const from = fakes['#cal-period-from'].element.value;
  assert.match(from, /^\d{4}-\d{2}-\d{2}$/, 'Valid from defaults to a day key');
  assert.equal(pEls['cal-period-noend'].checked, false, '"No end date" starts unchecked');
  assert.ok(fakes['#cal-period-to'].element.value > from, 'Valid to is from + 6 days');

  pEls['cal-period-name'].value = '  Peak season ';
  fakes['#cal-period-from'].element.value = '2030-03-01';
  fakes['#cal-period-to'].element.value = '2030-03-07';
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saves.length, 1);
  const [plant, next] = saves[0];
  assert.equal(plant, '1006');
  assert.equal(next.length, 1);
  assert.match(next[0].id, /^pper/);
  assert.deepEqual({ ...next[0], id: undefined }, {
    id: undefined, name: 'Peak season', validFrom: '2030-03-01', validTo: '2030-03-07',
    workHours: { 0: null, 1: [12, 24], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 17], 6: null },
  });
  assert.deepEqual(persisted, [], 'period mode never persists plant hours, clamps lines or re-renders ProdLines');
  assert.deepEqual(toasts.at(-1), ['toast.period_saved', 'success']);
  assert.ok(modalLog.some(e => e[0] === 'remove' && e[1] === 'visible'), 'the modal closed on success');
}));

test('EditCalendar period mode: "No end date" saves a null end and restores the end on untick', () => withPeriodEnv(async ({ saves }) => {
  EditCalendar.openPeriod('1006');
  pEls['cal-period-name'].value = 'Forever';
  fakes['#cal-period-from'].element.value = '2030-03-01';
  fakes['#cal-period-to'].element.value = '2030-03-07';
  pEls['cal-period-noend'].checked = true;
  pEls['cal-period-noend'].listeners.change[0]({ target: pEls['cal-period-noend'] });
  assert.equal(fakes['#cal-period-to'].element.value, '', 'Valid to cleared');
  pEls['cal-period-noend'].checked = false;
  pEls['cal-period-noend'].listeners.change[0]({ target: pEls['cal-period-noend'] });
  assert.equal(fakes['#cal-period-to'].element.value, '2030-03-07', 'previous Valid to restored');
  pEls['cal-period-noend'].checked = true;
  pEls['cal-period-noend'].listeners.change[0]({ target: pEls['cal-period-noend'] });
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saves[0][1][0].validTo, null);
}));

test('EditCalendar period mode: validation errors stay inline, block the save and keep the modal open', () => withPeriodEnv(async ({ saves }) => {
  Store.setPlantPeriods('1006', [{ id: 'x', name: 'Existing', validFrom: '2030-01-01', validTo: '2030-01-31', workHours: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } }], 'test');
  EditCalendar.openPeriod('1006');
  pEls['cal-period-name'].value = '   ';
  fakes['#cal-period-from'].element.value = '2030-01-31';
  fakes['#cal-period-to'].element.value = '2030-02-05';
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saves.length, 0, 'nothing sent');
  assert.equal(pEls['cal-period-name-err'].hidden, false);
  assert.equal(pEls['cal-period-name-err'].textContent, 'err.period_name_required');
  assert.equal(pEls['cal-period-name'].attrs['aria-invalid'], 'true');
  assert.equal(pEls['cal-period-name'].attrs['aria-describedby'], 'cal-period-name-err');
  assert.ok(pEls['cal-period-name'].classes.has('is-invalid'));
  assert.equal(pEls['cal-period-overlap-err'].hidden, false, 'a shared end day overlaps');
  assert.equal(pEls['cal-period-overlap-err'].textContent, 'err.period_overlap');
  assert.equal(modalLog.some(e => e[0] === 'remove' && e[1] === 'visible'), false, 'modal stays open');
  assert.equal(pEls['cal-period-name'].focused, true, 'focus moves to the first invalid field');

  // Once Save was attempted, fixing a field re-validates live.
  pEls['cal-period-name'].value = 'Fixed';
  pEls['cal-period-name'].listeners.input[0]();
  assert.equal(pEls['cal-period-name-err'].hidden, true);
  assert.equal(pEls['cal-period-name'].attrs['aria-invalid'], undefined);
}));

test('EditCalendar period mode: an end before the start, and an empty end without "No end date", are rejected inline', () => withPeriodEnv(async ({ saves }) => {
  EditCalendar.openPeriod('1006');
  pEls['cal-period-name'].value = 'N';
  fakes['#cal-period-from'].element.value = '2030-03-10';
  fakes['#cal-period-to'].element.value = '2030-03-01';
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pEls['cal-period-to-err'].textContent, 'err.period_to_before_from');
  fakes['#cal-period-to'].element.value = '';
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pEls['cal-period-to-err'].textContent, 'err.period_to_required');
  assert.equal(saves.length, 0);
}));

test('EditCalendar period mode: an all-closed open-ended period saves with a non-blocking warning', () => withPeriodEnv(async ({ saves }) => {
  EditCalendar.openPeriod('1006');
  pEls['cal-period-name'].value = 'Shutdown';
  fakes['#cal-period-from'].element.value = '2030-03-01';
  pEls['cal-period-noend'].checked = true;
  for (const t of toggles) t.checked = false;
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saves.length, 1, 'a warning does not block');
  assert.equal(pEls['cal-period-closed-warn'].textContent, 'warn.period_all_closed_long');
}));

test('EditCalendar open/openPlant after period mode hide the period block again', () => withPeriodEnv(() => {
  EditCalendar.openPeriod('1006');
  assert.equal(pEls['cal-edit-period-fields'].hidden, false);
  EditCalendar.openPlant('1006');
  assert.equal(pEls['cal-edit-period-fields'].hidden, true);
  assert.equal(pEls['cal-edit-title'].textContent, 'modal.edit_calendar');
  assert.equal(pEls['cal-edit-save-label'].textContent, 'btn.save_changes');
}));

test('EditCalendar period mode: the all-closed warning is live (before any Save) and clears when a day is turned on', () => withPeriodEnv(() => {
  EditCalendar.openPeriod('1006');
  const warn = pEls['cal-period-closed-warn'];
  assert.equal(warn.hidden, true, 'default week has open days: no warning');
  pEls['cal-period-noend'].checked = true;
  pEls['cal-period-noend'].listeners.change[0]({ target: pEls['cal-period-noend'] });
  for (let d = 0; d < 7; d++) { toggles[d].checked = false; EditCalendar.onToggle(d, false); }
  assert.equal(warn.hidden, false, 'open-ended and every day closed warns without a Save attempt');
  assert.equal(warn.textContent, 'warn.period_all_closed_long');
  toggles[2].checked = true; EditCalendar.onToggle(2, true);
  assert.equal(warn.hidden, true, 'turning a day on hides it again');
}));

test('EditCalendar period mode: after a failed Save, toggles and time pickers re-validate live', () => withPeriodEnv(async () => {
  Store.setPlantPeriods('1006', [{ id: 'x', name: 'Existing', validFrom: '2030-01-01', validTo: '2030-01-31', workHours: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } }], 'test');
  EditCalendar.openPeriod('1006');
  pEls['cal-period-name'].value = 'N';
  fakes['#cal-period-from'].element.value = '2030-01-15';
  fakes['#cal-period-to'].element.value = '2030-02-05';
  EditCalendar.save();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(pEls['cal-period-overlap-err'].hidden, false, 'overlap shown after the failed Save');
  // The planner fixes the dates by picker; a toggle then re-runs validation and the stale error goes away.
  fakes['#cal-period-from'].element.value = '2030-03-01';
  toggles[3].checked = true; EditCalendar.onToggle(3, true);
  assert.equal(pEls['cal-period-overlap-err'].hidden, true, 'onToggle re-validated');
  // And a time-picker change does too.
  fakes['#cal-period-from'].element.value = '2030-01-20';
  fakes['#cal-edit-start-1'].cfg.onChange();
  assert.equal(pEls['cal-period-overlap-err'].hidden, false, 'time-picker onChange re-validated');
}));
