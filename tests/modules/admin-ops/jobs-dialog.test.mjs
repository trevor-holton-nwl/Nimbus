// Tests for frontend/admin-ops/jobs-dialog.mts against the dom-stub: the body markup, the admin gate, form
// read-back, inline validation errors, and the create / edit save sequences against a mocked JobsClient.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installDom } from '../helpers/dom-stub.mjs';
import { JobsDialog, bodyHtml, recurFieldsHtml, pickRowsHtml, targetsBodyHtml, tzBlockHtml, readForm } from '../../../frontend/admin-ops/jobs-dialog.mjs';
import { JobsClient } from '../../../frontend/admin-ops/jobs-client.mjs';
import { defaultJobForm, defaultRecurrence } from '../../../frontend/admin-ops/jobs-model.mjs';
import { TYPES, OPT, byKey } from './jobs-types-fixture.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Modal, Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

let dom; let els; let calls; const prior = {};

function add(id, props = {}) {
  const el = dom.doc.createElement('div');
  el.setAttribute('id', id);
  Object.assign(el, props);
  dom.doc.body.appendChild(el);
  els[id] = el;
  return el;
}
/** The live form fields a real body would contain, filled for a valid default job. */
function fillForm(over = {}) {
  const v = { 'jb-name': 'Morning optimize', 'jb-p-mode': 'due_date', 'jb-p-search': 'exhaustive', 'jb-p-apply_mode': 'apply', 'jb-recur': 'daily', 'jb-time': '08:00', 'jb-from': '', 'jb-until': '', ...over };
  for (const [id, value] of Object.entries(v)) (els[id] ?? add(id)).value = value;
  for (const id of ['jb-p-respect_firmed', 'jb-overlap']) (els[id] ?? add(id)).checked = true;
}

function loadEnglish(win) {
  const w = {};
  vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window: w });
  win.__NIMBUS_LOCALES = w.__NIMBUS_LOCALES;
}

beforeEach(() => {
  dom = installDom();
  loadEnglish(dom.win); els = {}; calls = { create: [], update: [], addSch: [], updSch: [], toast: [], closed: [], previews: [], tpreviews: [] };
  for (const id of ['modal-job-edit', 'jb-body', 'jb-foot', 'jb-title', 'jb-close', 'jb-plant-host', 'jb-save']) add(id);
  for (const id of ['name', 'plant', 'result', 'time', 'minute', 'days', 'dom', 'cron', 'runAt', 'validity']) add(`jb-err-${id}`, { hidden: true });
  Object.assign(prior, {
    admin: Session.isAdmin, allowed: Session.allowedPlants, plants: Store.knownPlants, preview: JobsClient.preview, winPreview: JobsClient.windowPreview, create: JobsClient.create,
    targets: JobsClient.targetsPreview, update: JobsClient.update, addSchedule: JobsClient.addSchedule, updateSchedule: JobsClient.updateSchedule, open: Modal.open, close: Modal.close, toast: Toast.show,
  });
  Session.isAdmin = () => true; Session.allowedPlants = () => null; Store.knownPlants = () => ['1008', '2000', '3000'];
  JobsClient.preview = async (...a) => { calls.previews.push(a); return { timezone: 'America/New_York', cronExpr: '0 8 * * *', entries: [{ atUtc: '2026-10-30T12:00:00+00:00', atLocal: '2026-10-30T08:00:00-04:00', dstShifted: false }], plants: [], totalPlants: 1, warnings: [] }; };
  JobsClient.targetsPreview = async (rows, o) => { calls.tpreviews.push([rows, o]); return { plants: [], count: rows.length, skipped: 0, warnings: [] }; };
  JobsClient.windowPreview = async () => ({ start: 'S', end: 'E', label: '2026-10-22 to 2026-11-04', timezone: 'America/Chicago' });
  JobsClient.create = async j => { calls.create.push(j); return { id: 7 }; };
  JobsClient.update = async (id, p) => { calls.update.push([id, p]); return { id }; };
  JobsClient.addSchedule = async (id, s) => { calls.addSch.push([id, s]); return null; };
  JobsClient.updateSchedule = async (id, s) => { calls.updSch.push([id, s]); return null; };
  Modal.open = () => {}; Modal.close = id => calls.closed.push(id); Toast.show = (m, t) => calls.toast.push([m, t]);
});
afterEach(() => {
  JobsDialog.close();
  Session.isAdmin = prior.admin; Session.allowedPlants = prior.allowed; Store.knownPlants = prior.plants;
  Object.assign(JobsClient, { preview: prior.preview, windowPreview: prior.winPreview, create: prior.create, update: prior.update, addSchedule: prior.addSchedule, updateSchedule: prior.updateSchedule });
  Modal.open = prior.open; Modal.close = prior.close; Toast.show = prior.toast;
  dom.restore();
});

const optForm = () => defaultJobForm('1008', 'optimizer.plant', null, OPT);
const optBody = (isAdmin = true, mode = 'new') => bodyHtml(optForm(), mode, isAdmin, OPT, TYPES);

test('body markup: every field has a label, defaults are 08:00 / Exhaustive / Apply, plant timezone is read-only text', () => {
  const html = optBody();
  for (const id of ['jb-name', 'jb-jobtype', 'jb-p-mode', 'jb-p-search', 'jb-p-respect_firmed', 'jb-p-apply_mode', 'jb-recur', 'jb-time', 'jb-from', 'jb-until', 'jb-overlap', 'jb-preview', 'jb-tz']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="exhaustive" selected>/);
  assert.match(html, /<option value="apply" selected>/);
  assert.match(html, /id="jb-time"[^>]*value="08:00"/);
  assert.doesNotMatch(html, /<input[^>]*id="jb-tz"/, 'the timezone is not editable');
  assert.doesNotMatch(optBody(true), /id="jb-p-apply_mode"[^>]*disabled/);
  assert.match(optBody(false), /id="jb-p-apply_mode"[^>]*disabled/, 'non-admin cannot change the result');
  assert.match(html, /id="jb-p-apply_mode-hint"/, 'the Apply / Dry run hint is kept');
  assert.match(html, /id="jb-p-search-hint"/, 'the Exhaustive duration note is kept');
});

test('the type select is grouped Optimization | Reports, lists every type, and is locked once a job exists', () => {
  const html = optBody();
  assert.equal([...html.matchAll(/<optgroup label=/g)].length, 2, 'Optimization and Reports');
  for (const t of TYPES) assert.match(html, new RegExp(`<option value="${t.key.replace('.', '\\.')}"`), t.key);
  assert.doesNotMatch(html, /id="jb-jobtype"[^>]*disabled/);
  assert.match(optBody(true, 'edit'), /id="jb-jobtype"[^>]*disabled/);
});

test('a report type renders its own params (window picker, number box, checkboxes) and no Result control', () => {
  const late = byKey('report.late_orders');
  const html = bodyHtml(defaultJobForm('1008', late.key, null, late), 'new', true, late, TYPES);
  assert.match(html, /id="jb-p-horizon-choice"/, 'the window picker');
  assert.match(html, /<option value="next" selected>/, 'default Next 14 days');
  assert.match(html, /id="jb-p-horizon-n"[^>]*value="14"/);
  assert.match(html, /id="jb-p-min_days_late"[^>]*type="number"[^>]*max="365"/);
  assert.doesNotMatch(html, /jb-p-apply_mode|jb-p-search/, 'no optimizer controls on a report');
  const cov = byKey('report.coverage');
  const ch = bodyHtml(defaultJobForm('1008', cov.key, null, cov), 'new', true, cov, TYPES);
  for (const v of ['tools', 'priority_lists', 'setup']) assert.match(ch, new RegExp(`id="jb-p-sections-${v}" checked`));
});

test('the window picker shows the fields of its choice: fixed dates, N days, custom', async () => {
  const { windowFieldsHtml, windowWidgetHtml } = await import('../../../frontend/admin-ops/jobs-dialog.mjs');
  const { defaultWindowUi } = await import('../../../frontend/admin-ops/jobs-model.mjs');
  assert.match(windowFieldsHtml('w', { ...defaultWindowUi(), choice: 'fixed', from: '2026-10-01', to: '2026-10-31' }), /id="w-from"[^>]*data-jb-wdate[^>]*value="2026-10-01"[\s\S]*id="w-to"/);
  assert.match(windowFieldsHtml('w', { ...defaultWindowUi(), choice: 'older_than', n: 30 }), /id="w-n"[^>]*min="0"[^>]*value="30"/);
  assert.match(windowFieldsHtml('w', { ...defaultWindowUi(), choice: 'last', n: 7 }), /id="w-n"[^>]*min="1"/);
  const custom = windowFieldsHtml('w', { ...defaultWindowUi(), choice: 'custom', anchor: 'last_success', fromOffset: -2, toOffset: 0, unit: 'week' });
  assert.match(custom, /<option value="last_success" selected>/); assert.match(custom, /id="w-foff"[^>]*value="-2"/); assert.match(custom, /<option value="week" selected>/);
  assert.equal(windowFieldsHtml('w', { ...defaultWindowUi(), choice: 'this_week' }), '', 'a preset without a number has no fields');
  assert.match(windowWidgetHtml(byKey('report.late_orders').params[0], defaultWindowUi('next', 14)), /id="jb-p-horizon-line"[^>]*aria-live="polite"/);
});

test('recurrence fields follow the preset and escape their values', () => {
  const r = defaultRecurrence();
  assert.match(recurFieldsHtml({ ...r, preset: 'weekly' }), /id="jb-dow-0" checked/, 'Monday is 0');
  assert.doesNotMatch(recurFieldsHtml({ ...r, preset: 'weekly' }), /id="jb-dow-6" checked/, 'Sunday is 6');
  assert.match(recurFieldsHtml({ ...r, preset: 'monthly' }), /id="jb-dom"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'hourly' }), /id="jb-minute"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'once' }), /type="datetime-local"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'cron', cron: '"><script>' }), /value="&quot;&gt;&lt;script&gt;"/);
});

test('plant picker rows: search narrows, ticks show, role_plants scope respected, the checkbox carries the plant', () => {
  assert.deepEqual([...pickRowsHtml('sel', [], '').matchAll(/data-jb-tp="(\w+)"/g)].map(m => m[1]), ['1008', '2000', '3000']);
  assert.deepEqual([...pickRowsHtml('sel', ['3000'], '30').matchAll(/data-jb-tp="(\w+)" checked/g)].map(m => m[1]), ['3000']);
  assert.match(pickRowsHtml('excl', [], ''), /data-jb-tx="1008"/, 'the exclusion picker uses its own attribute');
  Session.allowedPlants = () => ['1008', '2000'];
  assert.deepEqual([...pickRowsHtml('sel', [], '').matchAll(/data-jb-tp="(\w+)"/g)].map(m => m[1]), ['1008', '2000']);
  Session.allowedPlants = () => null;
  Store.knownPlants = () => Array.from({ length: 300 }, (_, k) => `P${k}`);
  assert.equal((pickRowsHtml('sel', [], '').match(/data-jb-tp=/g) || []).length, 200, 'a long list is capped, never rendered whole');
  assert.match(pickRowsHtml('sel', [], ''), /jobs\.t_more|Showing 200 of 300/);
});

test('the body offers the four target modes, a single plant by default, and no preview or fan-out until a mode needs them', () => {
  const f = defaultJobForm('1008', 'optimizer.plant', OPT.defaults, OPT);
  const html = bodyHtml(f, 'new', true, OPT, TYPES);
  assert.match(html, /id="jb-tmode-single" value="single" checked/);
  for (const m of ['selected', 'all']) assert.match(html, new RegExp(`id="jb-tmode-${m}"`));
  assert.doesNotMatch(html, /id="jb-tmode-subnetwork"/, 'no subnetwork radio while no plant carries one');
  assert.doesNotMatch(html, /jb-tpreview|jb-fo-stagger|jb-tsel-list/);
  assert.match(html, /id="jb-tzmode-plant" value="plant" checked/);
  const sel = targetsBodyHtml({ ...f, targetMode: 'selected', targetPlants: ['2000'] });
  assert.match(sel, /id="jb-tsel-list"/);
  assert.match(sel, /data-jb-tp="2000" checked/);
  assert.match(sel, /id="jb-tpreview"/);
  assert.match(sel, /id="jb-fo-stagger"[^>]*value="0"/);
  assert.match(targetsBodyHtml({ ...f, targetMode: 'all' }), /id="jb-texcl-list"/, 'All offers exclusions');
  assert.doesNotMatch(targetsBodyHtml({ ...f, targetMode: 'all' }), /id="jb-tsel-list"/);
  assert.match(targetsBodyHtml({ ...f, targetMode: 'subnetwork' }), /id="jb-tsub-host"/);
  assert.match(tzBlockHtml({ ...f, tzMode: 'fixed', fixedTz: 'Asia/Tokyo' }), /id="jb-fixedtz-host"/);
  assert.doesNotMatch(tzBlockHtml(f), /jb-fixedtz-host/);
  assert.match(tzBlockHtml({ ...f, targetMode: 'selected' }), /jobs\.tz_each_plant|Each plant/);
});

test('open is a no-op for a non-admin', () => {
  Session.isAdmin = () => false;
  JobsDialog.open({ plant: '1008', types: TYPES });
  assert.equal(JobsDialog._state(), null);
  assert.equal(els['jb-body'].innerHTML, '');
});

test('readForm reads live fields and keeps the recurrence of the previous form for fields not on screen', () => {
  fillForm({ 'jb-name': ' Night run ', 'jb-recur': 'daily', 'jb-time': '22:30' });
  const f = readForm(optForm(), OPT);
  assert.equal(f.name, ' Night run ');
  assert.equal(f.recur.preset, 'daily'); assert.equal(f.recur.time, '22:30');
  assert.deepEqual(f.recur.days, [0, 1, 2, 3, 4], 'weekday boxes are not on screen, so the previous days stay');
  assert.deepEqual(f.params, { mode: 'due_date', search: 'exhaustive', respect_firmed: true, apply_mode: 'apply' });
});

test('readForm reads number boxes, multi-select checkboxes and a window picker into their param shapes', () => {
  const late = byKey('report.late_orders'); const cov = byKey('report.coverage');
  (els['jb-p-min_days_late'] ?? add('jb-p-min_days_late')).value = '2.5';
  (els['jb-p-horizon-choice'] ?? add('jb-p-horizon-choice')).value = 'older_than';
  (els['jb-p-horizon-n'] ?? add('jb-p-horizon-n')).value = '30';
  const f = readForm(defaultJobForm('1008', late.key, null, late), late);
  assert.equal(f.params.min_days_late, 2.5);
  assert.deepEqual(f.params.horizon.rolling, { anchor: 'start_of_day', from_offset: -3650, to_offset: -30, unit: 'day' });
  (els['jb-p-sections-tools'] ?? add('jb-p-sections-tools')).checked = true;
  (els['jb-p-sections-priority_lists'] ?? add('jb-p-sections-priority_lists')).checked = false;
  (els['jb-p-sections-setup'] ?? add('jb-p-sections-setup')).checked = true;
  assert.deepEqual(readForm(defaultJobForm('1008', cov.key, null, cov), cov).params.sections, ['tools', 'setup']);
  els['jb-p-min_days_late'].value = '';
  assert.equal(readForm(defaultJobForm('1008', late.key, null, late), late).params.min_days_late, 0, 'a blank optional box sends the model default, never a null the server refuses (422)');
  (els['jb-p-warn_if_over'] ?? add('jb-p-warn_if_over')).value = '';
  assert.equal(readForm(defaultJobForm('1008', late.key, null, late), late).params.warn_if_over, null, 'an optional param whose default is null clears to null');
  els['jb-p-warn_if_over'].value = '3';
  assert.equal(readForm(defaultJobForm('1008', late.key, null, late), late).params.warn_if_over, 3);
});

test('a report job saves with its window and params as given; validation blocks a bad window and a missing section', async () => {
  const late = byKey('report.late_orders');
  JobsDialog.open({ plant: '1008', types: TYPES, jobType: late.key });
  fillForm({ 'jb-p-horizon-choice': 'last', 'jb-p-horizon-n': '7', 'jb-p-min_days_late': '1' });
  assert.equal(JobsDialog._state().meta.key, 'report.late_orders');
  await JobsDialog.submit();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].job_type, 'report.late_orders');
  assert.deepEqual(calls.create[0].params.horizon.rolling, { anchor: 'start_of_day', from_offset: -7, to_offset: 1, unit: 'day' });
  assert.equal(calls.create[0].params.min_days_late, 1);
  assert.equal('apply_mode' in calls.create[0].params, false, 'a report carries no result mode');
  // a bad window: 0 days for "Last N days"
  calls.create.length = 0;
  els['jb-p-horizon-n'].value = '0';
  await JobsDialog.submit();
  assert.equal(calls.create.length, 0);
  const cov = byKey('report.coverage');
  JobsDialog.open({ plant: '1008', types: TYPES, jobType: cov.key });
  fillForm({});
  for (const v of ['tools', 'priority_lists', 'setup']) (els[`jb-p-sections-${v}`] ?? add(`jb-p-sections-${v}`)).checked = false;
  await JobsDialog.submit();
  assert.equal(calls.create.length, 0, 'at least one section is required');
});

test('the live "Resolves today to" line comes from the preview route, with a stale-response guard', async () => {
  const late = byKey('report.late_orders');
  const seen = []; let release;
  JobsClient.windowPreview = async (plant, w, o) => { seen.push([plant, w, o]); return new Promise(res => { release = () => res({ start: 'S', end: 'E', label: '2026-10-22 to 2026-11-04', timezone: 'America/Chicago' }); }); };
  const line = add('jb-p-horizon-line');
  (els['jb-p-horizon-choice'] ?? add('jb-p-horizon-choice')).value = 'next';
  (els['jb-p-horizon-n'] ?? add('jb-p-horizon-n')).value = '14';
  JobsDialog.open({ plant: '1008', types: TYPES, jobType: late.key });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], '1008');
  assert.deepEqual(seen[0][1].rolling, { anchor: 'start_of_day', from_offset: 0, to_offset: 14, unit: 'day' });
  JobsDialog.close();                       // the dialog closed while the request was in flight: its answer is dropped
  release(); await new Promise(r => setTimeout(r, 0));
  assert.equal(line.textContent, '');
});

test('the line shows what the server resolved, in the plant time wording', async () => {
  const late = byKey('report.late_orders');
  const line = add('jb-p-horizon-line');
  (els['jb-p-horizon-choice'] ?? add('jb-p-horizon-choice')).value = 'next';
  JobsDialog.open({ plant: '1008', types: TYPES, jobType: late.key });
  await new Promise(r => setTimeout(r, 0));
  assert.match(line.textContent, /Resolves today to 2026-10-22 to 2026-11-04 \(America\/Chicago, plant time\)/);
  assert.equal(line.classList.contains('ape-err'), false);
});

test('a preview error (plant without a timezone) shows on the line as an error', async () => {
  const late = byKey('report.late_orders');
  JobsClient.windowPreview = async () => { throw new Error("plant '9' has no timezone"); };
  const line = add('jb-p-horizon-line');
  (els['jb-p-horizon-choice'] ?? add('jb-p-horizon-choice')).value = 'next';
  JobsDialog.open({ plant: '1008', types: TYPES, jobType: late.key });
  await new Promise(r => setTimeout(r, 0));
  assert.match(line.textContent, /no timezone/);
  assert.equal(line.classList.contains('ape-err'), true);
});

test('submit with an empty name shows the inline error and sends nothing', async () => {
  JobsDialog.open({ plant: '1008', types: TYPES });
  fillForm({ 'jb-name': '   ' });
  await JobsDialog.submit();
  assert.equal(els['jb-err-name'].hidden, false);
  assert.ok(els['jb-err-name'].textContent.length > 0);
  assert.equal(calls.create.length, 0);
});

test('submit creates the job with its preset schedule inline, toasts, closes and calls onSaved', async () => {
  let saved = 0;
  JobsDialog.open({ plant: '1008', types: TYPES, onSaved: () => { saved++; } });
  fillForm();
  await JobsDialog.submit();
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0], {
    name: 'Morning optimize', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'due_date', search: 'exhaustive', respect_firmed: true, apply_mode: 'apply' }, targets: [], fan_out: null,
    schedules: [{ kind: 'daily', time_of_day: '08:00', valid_from: null, valid_until: null, skip_if_running: true, tz_mode: 'plant', fixed_timezone: null }],
  });
  assert.equal(calls.addSch.length, 0, 'the schedule rides inside the create call');
  assert.deepEqual(calls.toast.at(-1)[1], 'success');
  assert.deepEqual(calls.closed, ['modal-job-edit']);
  assert.equal(saved, 1);
});

test('submit on an existing job patches the job and its schedule (no create)', async () => {
  const job = { id: 3, name: 'Old', plant: '1008', job_type: 'optimizer.plant', params: {}, enabled: true, schedule: { id: 9, kind: 'daily', time_of_day: '06:00', cron_expr: '0 6 * * *', valid_from: null, valid_until: null, skip_if_running: true } };
  JobsDialog.open({ job, types: TYPES });
  fillForm({ 'jb-name': 'Renamed', 'jb-time': '07:15' });
  await JobsDialog.submit();
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update[0][0], 3);
  assert.equal(calls.update[0][1].name, 'Renamed');
  assert.deepEqual([calls.updSch[0][0], calls.updSch[0][1].kind, calls.updSch[0][1].time_of_day], [9, 'daily', '07:15']);
  assert.equal(calls.addSch.length, 0);
});

test('a server failure keeps the dialog open and toasts the error', async () => {
  JobsClient.create = async () => { throw new Error('plant is read-only'); };
  JobsDialog.open({ plant: '1008', types: TYPES });
  fillForm();
  await JobsDialog.submit();
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.toast.at(-1)[1], 'error');
  assert.match(calls.toast.at(-1)[0], /plant is read-only|jobs\.toast_save_failed/);
  assert.equal(JobsDialog._state().busy, false);
});

test('duplicate seeds a new job: name cleared, saves as create', async () => {
  const job = { id: 3, name: 'Source', plant: '1008', job_type: 'optimizer.plant', params: { search: 'normal' }, enabled: true, schedule: null };
  JobsDialog.open({ job, duplicate: true, types: TYPES });
  assert.equal(JobsDialog._state().mode, 'new');
  assert.equal(JobsDialog._state().form.name, '');
  assert.equal(JobsDialog._state().form.params.search, 'normal');
  fillForm({ 'jb-name': 'Copy', 'jb-search': 'normal' });
  await JobsDialog.submit();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.update.length, 0);
});

test('create with selected plants sends the target rows, fan-out and the time zone mode; the preview asks for the same targets', async () => {
  JobsDialog.open({ plant: '1008', types: TYPES });
  JobsDialog._state().form = { ...JobsDialog._state().form, targetMode: 'selected', targetPlants: ['2000', '3000'], fanOut: { staggerS: 15, maxParallel: 2, failFast: true }, tzMode: 'utc' };
  fillForm();
  await JobsDialog.submit();
  const c = calls.create[0];
  assert.deepEqual(c.targets.map(r => [r.kind, r.value, r.excluded]), [['explicit', '2000', false], ['explicit', '3000', false]]);
  assert.deepEqual(c.fan_out, { stagger_s: 15, max_parallel: 2, fail_fast: true });
  assert.deepEqual([c.schedules[0].tz_mode, c.schedules[0].fixed_timezone], ['utc', null]);
});

test('a single-plant create sends no targets and no fan-out; edit PATCHes the targets so a multi-plant job can go back to one plant', async () => {
  JobsDialog.open({ plant: '1008', types: TYPES });
  fillForm();
  await JobsDialog.submit();
  assert.deepEqual([calls.create[0].targets, calls.create[0].fan_out], [[], null]);
  const job = { id: 3, name: 'Source', plant: '1008', job_type: 'optimizer.plant', params: { search: 'normal' }, enabled: true,
    targets: [{ kind: 'explicit', value: '2000', excluded: false, params_override: { mode: 'spt' } }], fanOut: { stagger_s: 5 },
    schedule: { id: 9, kind: 'daily', time_of_day: '08:00', skip_if_running: true, tzMode: 'plant' } };
  JobsDialog.open({ job, types: TYPES });
  assert.equal(JobsDialog._state().form.targetMode, 'selected');
  fillForm();
  await JobsDialog.submit();
  assert.deepEqual(calls.update[0][1].targets, [{ kind: 'explicit', value: '2000', excluded: false, params_override: { mode: 'spt' } }], 'a per-plant override survives an edit');
  JobsDialog.open({ job, types: TYPES });          // the save closed the dialog: open it again and move the job back to one plant
  JobsDialog._state().form = { ...JobsDialog._state().form, targetMode: 'single' };
  fillForm();
  await JobsDialog.submit();
  assert.deepEqual([calls.update.at(-1)[1].targets, calls.update.at(-1)[1].fan_out], [[], null]);
});

test('Save is refused with an inline error when Selected plants has none ticked, or Fixed zone has no zone', async () => {
  JobsDialog.open({ plant: '1008', types: TYPES });
  JobsDialog._state().form = { ...JobsDialog._state().form, targetMode: 'selected', targetPlants: [], tzMode: 'fixed', fixedTz: '' };
  add('jb-err-targets', { hidden: true }); add('jb-err-fixedTz', { hidden: true });
  fillForm();
  await JobsDialog.submit();
  assert.equal(calls.create.length, 0);
  assert.equal(els['jb-err-targets'].hidden, false);
  assert.equal(els['jb-err-fixedTz'].hidden, false);
});

test('a new job defaults to APPLY, seeded from the server defaults; Dry run is the alternative', () => {
  JobsDialog.open({ plant: '1008', types: TYPES });
  assert.equal(JobsDialog._state().form.params.apply_mode, 'apply');
  assert.equal(JobsDialog._state().form.jobType, 'optimizer.plant', 'a new job starts as the first action type');
  JobsDialog.open({ plant: '1008', types: TYPES, defaults: { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' } });
  const f = JobsDialog._state().form.params;
  assert.deepEqual([f.mode, f.search, f.respect_firmed, f.apply_mode], ['spt', 'normal', false, 'propose']);
  assert.match(optBody(), /<option value="apply" selected>/);
});

test('Escape / X: a clean form closes at once, a dirty one asks first and stays open on Cancel', async () => {
  const asked = [];
  const confirm = Modal.confirm;
  let answer = false;
  Modal.confirm = async o => { asked.push(o); return answer; };
  try {
    JobsDialog.open({ plant: '1008', types: TYPES });          // nothing edited (the stub renders no fields, so read-back equals the baseline)
    await JobsDialog.requestClose();
    assert.equal(asked.length, 0); assert.deepEqual(calls.closed, ['modal-job-edit']);
    calls.closed.length = 0;
    JobsDialog.open({ plant: '1008', types: TYPES });
    fillForm({ 'jb-name': 'half typed' });
    await JobsDialog.requestClose();
    assert.equal(asked.length, 1); assert.equal(calls.closed.length, 0, 'Cancel keeps the form');
    answer = true;
    await JobsDialog.requestClose();
    assert.deepEqual(calls.closed, ['modal-job-edit']);
  } finally { Modal.confirm = confirm; }
});

test('the Aggregate-window block is hidden while "Limit to a date window" is off and shown when it is on (and not validated while off)', async () => {
  const { paramsHtml } = await import('../../../frontend/admin-ops/jobs-dialog.mjs');
  const { validateParams } = await import('../../../frontend/admin-ops/jobs-model.mjs');
  const dist = byKey('report.distribution');
  const off = defaultJobForm('1008', dist.key, null, dist);
  assert.match(paramsHtml(dist, off, true), /<fieldset class="job-window" id="jb-p-window" hidden>/);
  const on = { ...off, params: { ...off.params, filter_by_window: true } };
  assert.doesNotMatch(paramsHtml(dist, on, true), /id="jb-p-window" hidden/);
  const bad = { ...off.params, window: { mode: 'fixed', fixed: { from: '', to: '' } } };
  assert.deepEqual(validateParams(dist.params, bad), {}, 'hidden window is not validated');
  assert.ok(validateParams(dist.params, { ...bad, filter_by_window: true }).window, 'but is once it is on');
  // a type without that switch keeps its window visible
  const late = byKey('report.late_orders');
  assert.doesNotMatch(paramsHtml(late, defaultJobForm('1008', late.key, null, late), true), /id="jb-p-horizon" hidden/);
});

test('every report type offers the optional warn_if_over param, except what_changed', () => {
  for (const k of ['report.late_orders', 'report.missing_master_data', 'report.coverage', 'report.distribution']) {
    const p = byKey(k).params.find(x => x.key === 'warn_if_over');
    assert.ok(p, k); assert.equal(p.type, 'integer'); assert.equal(p.required, false); assert.equal(p.default, null);
  }
  assert.equal(byKey('report.what_changed').params.some(x => x.key === 'warn_if_over'), false, 'what_changed never warns');
});
