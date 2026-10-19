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
import { Toast, Modal, Util } from '../../../frontend/platform/foundation.mjs';

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
const IDS = ['plant-periods-list', 'plant-periods-timeline', 'plant-periods-horizon', 'plant-periods-count', 'plant-add-period-btn', 'plant-tab-calendar', 'cal-edit-save-btn'];
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

test('render: the count reads "1 period" for exactly one period and "N periods" otherwise', () => {
  Store.setPlantPeriods('P1', [per('a', 'Only', '2999-01-01', '2999-02-01')], 'test');
  CalendarPeriodsUI.render();
  assert.equal(els['plant-periods-count'].textContent, '1 period');
  Store.setPlantPeriods('P1', [per('a', 'One', '2999-01-01', '2999-02-01'), per('b', 'Two', '2999-03-01', '2999-04-01')], 'test');
  CalendarPeriodsUI.render();
  assert.equal(els['plant-periods-count'].textContent, '2 periods');
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

// ---- blackout markers on the timeline ----
const atDay = (n, h = 0) => { const d = new Date(); d.setHours(h, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const pblk = (id, plant, s, e, reason = 'Holiday') => ({ id, plant, start: s, end: e, reason });
const seedBlocks = (blocks) => Store.replacePlantBlocks(blocks, 'test');
afterEach(() => { Store.replacePlantBlocks([], 'test-restore'); });

test('blackout marks: only the selected plant\'s blackouts, and no lane at all when there are none', () => {
  Store.replacePlants({ P1: { workHours: wh(8, 16) }, P2: { workHours: wh(8, 16) } }, 'test');
  Store.setSelectedPlant('P1', 'test');
  CalendarPeriodsUI.render();
  assert.doesNotMatch(els['plant-periods-timeline'].innerHTML, /period-blk-lane/);
  assert.doesNotMatch(els['plant-periods-timeline'].innerHTML, /period-legend-blk/);
  seedBlocks([pblk('p1a', 'P1', atDay(10), atDay(11)), pblk('p2a', 'P2', atDay(40), atDay(41))]);
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.equal((tl.match(/class="period-blk"/g) || []).length, 1);
  assert.match(tl, /data-action="edit-blackout" data-id="p1a"/);
  assert.doesNotMatch(tl, /p2a/);
  assert.match(tl, /class="period-legend-blk"/);
  // The lane is a sibling after the track, never inside it.
  const todayAt = tl.indexOf('class="period-today"');
  assert.ok(tl.indexOf('period-blk-lane') > tl.indexOf('</div>', todayAt), 'lane comes after the track closes');
  Store.setSelectedPlant('P2', 'test');
  CalendarPeriodsUI.render();
  assert.match(els['plant-periods-timeline'].innerHTML, /data-id="p2a"/);
  assert.doesNotMatch(els['plant-periods-timeline'].innerHTML, /p1a/);
});

test('blackout marks: reason is escaped in title and aria-label; invalid and out-of-window blocks are skipped', () => {
  seedBlocks([
    pblk('x1', 'P1', atDay(5), atDay(6), '<img src=x onerror=alert(1)> "quoted"'),
    pblk('bad', 'P1', atDay(8), atDay(8)),
    pblk('inv', 'P1', 'not a date', atDay(9)),
    pblk('far', 'P1', atDay(900), atDay(901)),
  ]);
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.equal((tl.match(/class="period-blk"/g) || []).length, 1);
  assert.doesNotMatch(tl, /<img/);
  assert.match(tl, /title="&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; · /);
  assert.match(tl, /aria-label="Blackout: &lt;img/);
  assert.match(tl, /tabindex="-1"/);
});

test('blackout marks: touching blackouts become one cluster button that lists its ids and reasons', () => {
  seedBlocks([pblk('c1', 'P1', atDay(20), atDay(22), 'Alpha'), pblk('c2', 'P1', atDay(22), atDay(24), 'Beta')]);
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.equal((tl.match(/class="period-blk"/g) || []).length, 1);
  assert.match(tl, /data-ids="\[&quot;c1&quot;,&quot;c2&quot;\]"/);
  assert.match(tl, /title="2 blackouts, [^"]*\nAlpha; Beta"/);
  assert.doesNotMatch(tl, /data-id="c1"/);
});

test('blackout marks: an end at exclusive midnight does not paint the following day', () => {
  seedBlocks([pblk('m1', 'P1', atDay(30), atDay(31)), pblk('m2', 'P1', atDay(32), atDay(33))]);
  CalendarPeriodsUI.render();
  // Days 30 and 32 with the 31st free between them: two marks, not one cluster.
  assert.equal((els['plant-periods-timeline'].innerHTML.match(/class="period-blk"/g) || []).length, 2);
});

test('blackout marks: more than 60 clusters shows "+N more" in the legend', () => {
  const blocks = [];
  for (let i = 0; i < 64; i++) blocks.push(pblk('t' + i, 'P1', atDay(i * 4 + 1), atDay(i * 4 + 2), 'R' + i));
  seedBlocks(blocks);
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.equal((tl.match(/class="period-blk"/g) || []).length, 60);
  assert.match(tl, /\+4 more — see list/);
});

test('the legend carries the default-week caption and lives outside the today row', () => {
  CalendarPeriodsUI.render();
  const tl = els['plant-periods-timeline'].innerHTML;
  assert.match(tl, /<div class="period-legend"><span>Default week outside periods<\/span><\/div>/);
  assert.doesNotMatch(tl, /period-track-cap/);
});

test('clicking a blackout marker never opens the period modal', () => {
  seedBlocks([pblk('p1a', 'P1', atDay(10), atDay(11))]);
  CalendarPeriodsUI.init();
  calls.length = 0;
  click('plant-periods-timeline', { action: 'edit-blackout', id: 'p1a' });
  click('plant-periods-timeline', { action: 'edit-blackout', ids: '["a","b"]' });
  assert.deepEqual(calls.filter(c => c[0] === 'openPeriod'), []);
});

test('horizon caption: "next 12 months" by default, "through <month year>" when a period pushes the axis out', () => {
  CalendarPeriodsUI.render();
  assert.equal(els['plant-periods-horizon'].textContent, 'next 12 months');
  Store.setPlantPeriods('P1', [per('f', 'Far future', Util.dayKey(atDay(500)), null)], 'test');
  CalendarPeriodsUI.render();
  assert.match(els['plant-periods-horizon'].textContent, /^through [A-Za-z]{3,} \d{4}$/);
  Store.setSelectedPlant(null, 'test');
  CalendarPeriodsUI.render();
  assert.equal(els['plant-periods-horizon'].textContent, '');
});
