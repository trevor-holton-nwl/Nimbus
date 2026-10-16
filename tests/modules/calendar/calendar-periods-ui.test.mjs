// Tests for frontend/calendar/calendar-periods-ui.mts (Plant > Calendar periods list, timeline, save/delete).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { CalendarPeriodsUI } from '../../../frontend/calendar/calendar-periods-ui.mjs';
import { EditCalendar } from '../../../frontend/calendar/edit-calendar.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast, Modal } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
// Real English strings, so assertions read like the UI.
{
  const w = {};
  vm.runInNewContext(fs.readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window: w });
  globalThis.window = w;
}

const wh = (a, b) => ({ 0: null, 1: [a, b], 2: [a, b], 3: [a, b], 4: [a, b], 5: [a, b], 6: null });
const per = (id, name, from, to) => ({ id, name, validFrom: from, validTo: to, workHours: wh(6, 14) });

// ---- tiny fake DOM, built once: init() binds listeners to these exact objects ----
const IDS = ['plant-periods-list', 'plant-periods-timeline', 'plant-periods-count', 'plant-add-period-btn', 'plant-tab-calendar', 'cal-edit-save-btn'];
const els = {};
for (const id of IDS) {
  els[id] = {
    id, innerHTML: '', textContent: '', hidden: false, disabled: false, attrs: {}, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
}
globalThis.document = { getElementById: id => els[id] ?? null };
const click = (id, dataset) => els[id].listeners.click.forEach(fn =>
  fn({ target: { closest: () => (dataset ? { dataset } : null) } }));

let toasts, calls, saveResult, savePromiseSeen, priors;

beforeEach(() => {
  priors = {
    toast: Toast.show, confirm: Modal.confirm, save: CalendarSync.savePlantPeriods,
    openPeriod: EditCalendar.openPeriod, close: EditCalendar.close, setErr: EditCalendar.setPeriodError,
  };
  toasts = []; calls = [];
  saveResult = { ok: true };
  savePromiseSeen = null;
  Toast.show = (msg, type) => toasts.push([msg, type]);
  Modal.confirm = async (opts) => { calls.push(['confirm', opts]); return true; };
  CalendarSync.savePlantPeriods = async (plant, next) => {
    calls.push(['save', plant, next]);
    savePromiseSeen = { disabled: els['cal-edit-save-btn'].disabled, busy: els['cal-edit-save-btn'].attrs['aria-busy'] };
    return saveResult;
  };
  EditCalendar.openPeriod = (...a) => calls.push(['openPeriod', ...a]);
  EditCalendar.close = () => calls.push(['close']);
  EditCalendar.setPeriodError = (...a) => calls.push(['setPeriodError', ...a]);
  Store.replacePlants({ P1: { workHours: wh(8, 16) } }, 'test');
  Store.setSelectedPlant('P1', 'test');
  els['plant-tab-calendar'].hidden = true;
  els['cal-edit-save-btn'].disabled = false;
  delete els['cal-edit-save-btn'].attrs['aria-busy'];
});

afterEach(() => {
  Toast.show = priors.toast; Modal.confirm = priors.confirm; CalendarSync.savePlantPeriods = priors.save;
  EditCalendar.openPeriod = priors.openPeriod; EditCalendar.close = priors.close; EditCalendar.setPeriodError = priors.setErr;
  Store.setSelectedPlant(null, 'test');
});

function seed() {
  Store.setPlantPeriods('P1', [
    per('a', 'Always on', '2000-01-01', null),
    per('b', 'Old shutdown', '2001-01-01', '2001-12-31'),
    per('c', 'Far future', '2999-01-01', '2999-02-01'),
  ], 'test');
}

test('render: rows carry the right badge, range, summary and no inline handlers', () => {
  seed();
  CalendarPeriodsUI.render();
  const html = els['plant-periods-list'].innerHTML;
  assert.equal((html.match(/class="period-row/g) || []).length, 3);
  assert.match(html, /line-badge badge-ok">Active</);
  assert.match(html, /line-badge badge-info">Upcoming</);
  assert.match(html, /line-badge badge-muted">Past</);
  assert.equal((html.match(/period-row-past/g) || []).length, 1);
  assert.match(html, /01\/01\/00 → No end date/, 'open-ended range through the date-format pref');
  assert.match(html, /Mon–Fri 06:00–14:00 · Sat–Sun Closed/);
  assert.ok(!/onclick|NIMBUS\./.test(html), 'no inline handler or NIMBUS reference in rendered markup');
  assert.ok(!/onclick|NIMBUS\./.test(els['plant-periods-timeline'].innerHTML));
  assert.equal(els['plant-periods-count'].textContent, '3 periods');
  assert.equal(els['plant-add-period-btn'].disabled, false);
  // Sorted by start date.
  assert.ok(html.indexOf('Always on') < html.indexOf('Old shutdown') && html.indexOf('Old shutdown') < html.indexOf('Far future'));
});

test('render: timeline has one segment per period, an open-ended one, and a today marker', () => {
  seed();
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.equal((tl.match(/class="period-seg /g) || []).length, 3);
  assert.match(tl, /period-seg-active period-seg-open/);
  assert.match(tl, /period-seg-upcoming/);
  assert.match(tl, /period-seg-past/);
  assert.match(tl, /class="period-today"/);
  assert.match(tl, />Today</);
  assert.match(tl, /data-action="edit-period" data-id="a"/);
});

test('render: empty state and no-plant state', () => {
  CalendarPeriodsUI.render();
  assert.match(els['plant-periods-list'].innerHTML, /empty-state">No periods yet/);
  assert.equal(els['plant-periods-count'].textContent, '0 periods');
  Store.setSelectedPlant(null, 'test');
  CalendarPeriodsUI.render();
  assert.match(els['plant-periods-list'].innerHTML, /plant-no-sel/);
  assert.equal(els['plant-add-period-btn'].disabled, true);
  assert.equal(els['plant-periods-count'].textContent, '');
});

test('init wires delegated clicks: edit opens the editor, add opens a new one', () => {
  seed();
  CalendarPeriodsUI.init();
  CalendarPeriodsUI.init(); // idempotent
  assert.equal(els['plant-periods-list'].listeners.click.length, 1);
  click('plant-periods-list', { action: 'edit-period', id: 'b' });
  click('plant-periods-timeline', { action: 'edit-period', id: 'c' });
  click('plant-add-period-btn');
  click('plant-periods-list', undefined); // click on nothing actionable
  assert.deepEqual(calls, [['openPeriod', 'P1', 'b'], ['openPeriod', 'P1', 'c'], ['openPeriod', 'P1', undefined]]);
});

test('delete: confirms, then saves the list without that period', async () => {
  seed();
  CalendarPeriodsUI.init();
  click('plant-periods-list', { action: 'delete-period', id: 'b' });
  await new Promise(r => setTimeout(r, 0));
  const confirm = calls.find(c => c[0] === 'confirm')[1];
  assert.equal(confirm.title, 'Delete period?');
  assert.equal(confirm.tone, 'danger');
  assert.equal(confirm.confirmLabel, 'Delete period');
  assert.match(confirm.message, /Delete Old shutdown \(01\/01\/01 to 12\/31\/01\)\? Those dates go back to the default week\./);
  const save = calls.find(c => c[0] === 'save');
  assert.deepEqual(save[2].map(p => p.id), ['a', 'c']);
  assert.deepEqual(toasts.at(-1), ['Calendar period deleted.', 'success']);
});

test('delete: declining the confirmation sends nothing', async () => {
  seed();
  Modal.confirm = async () => false;
  const out = await CalendarPeriodsUI.remove('b');
  assert.equal(out, false);
  assert.equal(calls.filter(c => c[0] === 'save').length, 0);
  assert.equal(toasts.length, 0);
});

test('delete: a structured refusal toasts an error', async () => {
  seed();
  saveResult = { ok: false, code: 'period_invalid', ids: [] };
  await CalendarPeriodsUI.remove('b');
  assert.equal(toasts.at(-1)[1], 'error');
});

test('save ok: closes the editor, toasts, and disables Save while the call is in flight', async () => {
  seed();
  const ok = await CalendarPeriodsUI.save(per('n', 'New', '2030-01-01', '2030-01-07'));
  assert.equal(ok, true);
  const save = calls.find(c => c[0] === 'save');
  assert.deepEqual(save[2].map(p => p.id), ['a', 'b', 'c', 'n']);
  assert.deepEqual(savePromiseSeen, { disabled: true, busy: 'true' }, 'busy while pending');
  assert.equal(els['cal-edit-save-btn'].disabled, false, 're-enabled after');
  assert.equal(els['cal-edit-save-btn'].attrs['aria-busy'], undefined);
  assert.ok(calls.some(c => c[0] === 'close'));
  assert.deepEqual(toasts.at(-1), ['Calendar period saved.', 'success']);
});

test('save replaces by id and reports What-If as local', async () => {
  seed();
  saveResult = { ok: true, skipped: true };
  await CalendarPeriodsUI.save({ ...per('b', 'Renamed', '2001-01-01', '2001-12-31') });
  const save = calls.find(c => c[0] === 'save');
  assert.equal(save[2].length, 3);
  assert.equal(save[2].find(p => p.id === 'b').name, 'Renamed');
  assert.deepEqual(toasts.at(-1), ['Calendar updated in What-If; promote to save changes.', 'info']);
});

test('save refused for overlap: stays open, names the other period inline, re-enables Save', async () => {
  seed();
  saveResult = { ok: false, status: 400, code: 'period_overlap', ids: ['a', 'n'] };
  const ok = await CalendarPeriodsUI.save(per('n', 'New', '2030-01-01', '2030-01-07'));
  assert.equal(ok, false);
  assert.equal(calls.some(c => c[0] === 'close'), false, 'modal stays open');
  const err = calls.find(c => c[0] === 'setPeriodError');
  assert.equal(err[1], 'overlap');
  assert.match(err[2], /^Overlaps Always on \(01\/01\/00 to No end date\)\. Periods cannot share dates\.$/);
  assert.equal(els['cal-edit-save-btn'].disabled, false);
  assert.equal(toasts.length, 0, 'inline only, no toast');
});

test('save refused: date and generic codes map to their inline fields', async () => {
  seed();
  saveResult = { ok: false, code: 'period_dates_invalid', ids: ['n'] };
  await CalendarPeriodsUI.save(per('n', 'New', '2030-01-01', '2030-01-07'));
  assert.deepEqual(calls.filter(c => c[0] === 'setPeriodError').at(-1).slice(1), ['to', 'The end date must be on or after the start date.']);
  saveResult = { ok: false, code: 'period_hours_invalid' };
  await CalendarPeriodsUI.save(per('n', 'New', '2030-01-01', '2030-01-07'));
  assert.equal(calls.filter(c => c[0] === 'setPeriodError').at(-1)[1], 'overlap');
});

test('save with a transport failure leaves the editor open and adds no second toast (CalendarSync already toasted)', async () => {
  seed();
  saveResult = { ok: false, error: 'network' };
  const ok = await CalendarPeriodsUI.save(per('n', 'New', '2030-01-01', '2030-01-07'));
  assert.equal(ok, false);
  assert.equal(calls.some(c => c[0] === 'close' || c[0] === 'setPeriodError'), false);
  assert.equal(toasts.length, 0);
});

test('a calendar:change while the Calendar tab is showing re-renders; hidden tab is left alone', () => {
  els['plant-periods-list'].innerHTML = 'stale';
  Store.setPlantPeriods('P1', [per('a', 'Always on', '2000-01-01', null)], 'test');
  assert.equal(els['plant-periods-list'].innerHTML, 'stale', 'tab hidden: no render');
  els['plant-tab-calendar'].hidden = false;
  Store.setPlantPeriods('P1', [per('a', 'Always on', '2000-01-01', null), per('c', 'Far future', '2999-01-01', null)], 'test');
  assert.match(els['plant-periods-list'].innerHTML, /Far future/);
});
