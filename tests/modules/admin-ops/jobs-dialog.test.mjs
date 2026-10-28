// Tests for frontend/admin-ops/jobs-dialog.mts against the dom-stub: the body markup, the admin gate, form
// read-back, inline validation errors, and the create / edit save sequences against a mocked JobsClient.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom } from '../helpers/dom-stub.mjs';
import { JobsDialog, bodyHtml, recurFieldsHtml, copyRowsHtml, readForm } from '../../../frontend/admin-ops/jobs-dialog.mjs';
import { JobsClient } from '../../../frontend/admin-ops/jobs-client.mjs';
import { defaultJobForm, defaultRecurrence } from '../../../frontend/admin-ops/jobs-model.mjs';
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
  const v = { 'jb-name': 'Morning optimize', 'jb-mode': 'due-date', 'jb-search': 'exhaustive', 'jb-result': 'apply', 'jb-recur': 'daily', 'jb-time': '08:00', 'jb-from': '', 'jb-until': '', ...over };
  for (const [id, value] of Object.entries(v)) (els[id] ?? add(id)).value = value;
  for (const id of ['jb-firmed', 'jb-calendar', 'jb-overlap']) (els[id] ?? add(id)).checked = true;
}

beforeEach(() => {
  dom = installDom(); els = {}; calls = { create: [], update: [], addSch: [], updSch: [], toast: [], closed: [] };
  for (const id of ['modal-job-edit', 'jb-body', 'jb-foot', 'jb-title', 'jb-close', 'jb-plant-host', 'jb-save']) add(id);
  for (const id of ['name', 'plant', 'mode', 'search', 'result', 'time', 'minute', 'days', 'dom', 'cron', 'runAt', 'validity']) add(`jb-err-${id}`, { hidden: true });
  Object.assign(prior, {
    admin: Session.isAdmin, allowed: Session.allowedPlants, plants: Store.knownPlants, preview: JobsClient.preview, create: JobsClient.create,
    update: JobsClient.update, addSchedule: JobsClient.addSchedule, updateSchedule: JobsClient.updateSchedule, open: Modal.open, close: Modal.close, toast: Toast.show,
  });
  Session.isAdmin = () => true; Session.allowedPlants = () => null; Store.knownPlants = () => ['1008', '2000', '3000'];
  JobsClient.preview = async () => ({ runs: ['2026-10-30T08:00:00'], dst: false });
  JobsClient.create = async j => { calls.create.push(j); return { id: 7 }; };
  JobsClient.update = async (id, p) => { calls.update.push([id, p]); return { id }; };
  JobsClient.addSchedule = async (id, s) => { calls.addSch.push([id, s]); return null; };
  JobsClient.updateSchedule = async (id, s) => { calls.updSch.push([id, s]); return null; };
  Modal.open = () => {}; Modal.close = id => calls.closed.push(id); Toast.show = (m, t) => calls.toast.push([m, t]);
});
afterEach(() => {
  JobsDialog.close();
  Session.isAdmin = prior.admin; Session.allowedPlants = prior.allowed; Store.knownPlants = prior.plants;
  Object.assign(JobsClient, { preview: prior.preview, create: prior.create, update: prior.update, addSchedule: prior.addSchedule, updateSchedule: prior.updateSchedule });
  Modal.open = prior.open; Modal.close = prior.close; Toast.show = prior.toast;
  dom.restore();
});

test('body markup: every field has a label, defaults are 08:00 / Exhaustive / Apply, plant timezone is read-only text', () => {
  const html = bodyHtml(defaultJobForm('1008'), 'new', true);
  for (const id of ['jb-name', 'jb-mode', 'jb-search', 'jb-result', 'jb-recur', 'jb-time', 'jb-from', 'jb-until', 'jb-overlap', 'jb-preview', 'jb-tz']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="exhaustive" selected>/);
  assert.match(html, /<option value="apply" selected>/);
  assert.match(html, /id="jb-time"[^>]*value="08:00"/);
  assert.doesNotMatch(html, /<input[^>]*id="jb-tz"/, 'the timezone is not editable');
  assert.doesNotMatch(bodyHtml(defaultJobForm('1008'), 'new', true), /id="jb-result"[^>]*disabled/);
  assert.match(bodyHtml(defaultJobForm('1008'), 'new', false), /id="jb-result"[^>]*disabled/, 'non-admin cannot change the result');
});

test('recurrence fields follow the preset and escape their values', () => {
  const r = defaultRecurrence();
  assert.match(recurFieldsHtml({ ...r, preset: 'weekly' }), /id="jb-dow-1" checked/);
  assert.doesNotMatch(recurFieldsHtml({ ...r, preset: 'weekly' }), /id="jb-dow-0" checked/);
  assert.match(recurFieldsHtml({ ...r, preset: 'monthly' }), /id="jb-dom"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'hourly' }), /id="jb-minute"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'once' }), /type="datetime-local"/);
  assert.match(recurFieldsHtml({ ...r, preset: 'cron', cron: '"><script>' }), /value="&quot;&gt;&lt;script&gt;"/);
});

test('copy rows: source plant excluded, filter narrows, role_plants scope respected', () => {
  const job = { id: 1, name: 'J', plant: '1008' };
  assert.deepEqual([...copyRowsHtml(job, new Set(), '').matchAll(/data-jb-plant="(\w+)"/g)].map(m => m[1]), ['2000', '3000']);
  assert.deepEqual([...copyRowsHtml(job, new Set(['3000']), '30').matchAll(/data-jb-plant="(\w+)" checked/g)].map(m => m[1]), ['3000']);
  Session.allowedPlants = () => ['1008', '2000'];
  assert.deepEqual([...copyRowsHtml(job, new Set(), '').matchAll(/data-jb-plant="(\w+)"/g)].map(m => m[1]), ['2000']);
});

test('open is a no-op for a non-admin', () => {
  Session.isAdmin = () => false;
  JobsDialog.open({ plant: '1008' });
  assert.equal(JobsDialog._state(), null);
  assert.equal(els['jb-body'].innerHTML, '');
});

test('readForm reads live fields and keeps the recurrence of the previous form for fields not on screen', () => {
  fillForm({ 'jb-name': ' Night run ', 'jb-recur': 'daily', 'jb-time': '22:30' });
  const f = readForm(defaultJobForm('1008'));
  assert.equal(f.name, ' Night run ');
  assert.equal(f.recur.preset, 'daily'); assert.equal(f.recur.time, '22:30');
  assert.deepEqual(f.recur.days, [1, 2, 3, 4, 5], 'weekday boxes are not on screen, so the previous days stay');
  assert.equal(f.respectFirmed, true);
});

test('submit with an empty name shows the inline error and sends nothing', async () => {
  JobsDialog.open({ plant: '1008' });
  fillForm({ 'jb-name': '   ' });
  await JobsDialog.submit();
  assert.equal(els['jb-err-name'].hidden, false);
  assert.ok(els['jb-err-name'].textContent.length > 0);
  assert.equal(calls.create.length, 0);
});

test('submit creates the job then its schedule (plant-local cron), toasts, closes and calls onSaved', async () => {
  let saved = 0;
  JobsDialog.open({ plant: '1008', onSaved: () => { saved++; } });
  fillForm();
  await JobsDialog.submit();
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0], {
    name: 'Morning optimize', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'due-date', search: 'exhaustive', respect_firmed: true, respect_calendar: true, apply_mode: 'apply' },
  });
  assert.equal(calls.addSch.length, 1);
  assert.equal(calls.addSch[0][0], 7);
  assert.equal(calls.addSch[0][1].cron_expr, '0 8 * * *');
  assert.deepEqual(calls.toast.at(-1)[1], 'ok');
  assert.deepEqual(calls.closed, ['modal-job-edit']);
  assert.equal(saved, 1);
});

test('submit on an existing job patches the job and its schedule (no create)', async () => {
  const job = { id: 3, name: 'Old', plant: '1008', job_type: 'optimizer.plant', params: {}, enabled: true, schedule: { id: 9, kind: 'cron', cron_expr: '0 6 * * *', valid_from: null, valid_until: null, skip_if_running: true } };
  JobsDialog.open({ job });
  fillForm({ 'jb-name': 'Renamed', 'jb-time': '07:15' });
  await JobsDialog.submit();
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update[0][0], 3);
  assert.equal(calls.update[0][1].name, 'Renamed');
  assert.deepEqual([calls.updSch[0][0], calls.updSch[0][1].cron_expr], [9, '15 7 * * *']);
  assert.equal(calls.addSch.length, 0);
});

test('a server failure keeps the dialog open and toasts the error', async () => {
  JobsClient.create = async () => { throw new Error('plant is read-only'); };
  JobsDialog.open({ plant: '1008' });
  fillForm();
  await JobsDialog.submit();
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.toast.at(-1)[1], 'err');
  assert.match(calls.toast.at(-1)[0], /plant is read-only|jobs\.toast_save_failed/);
  assert.equal(JobsDialog._state().busy, false);
});

test('duplicate seeds a new job: name cleared, saves as create', async () => {
  const job = { id: 3, name: 'Source', plant: '1008', job_type: 'optimizer.plant', params: { search: 'normal' }, enabled: true, schedule: null };
  JobsDialog.open({ job, duplicate: true });
  assert.equal(JobsDialog._state().mode, 'new');
  assert.equal(JobsDialog._state().form.name, '');
  assert.equal(JobsDialog._state().form.search, 'normal');
  fillForm({ 'jb-name': 'Copy', 'jb-search': 'normal' });
  await JobsDialog.submit();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.update.length, 0);
});

test('copy to plants creates one job + schedule per ticked plant and reports partial failures', async () => {
  const job = { id: 3, name: 'Source', plant: '1008', job_type: 'optimizer.plant', params: { search: 'normal' }, enabled: true, schedule: { id: 9, kind: 'cron', cron_expr: '0 8 * * *', skip_if_running: true } };
  let n = 0;
  JobsClient.create = async j => { calls.create.push(j); if (j.plant === '3000') throw new Error('nope'); return { id: 100 + n++ }; };
  JobsDialog.openCopy(job);
  JobsDialog._state().targets = new Set(['2000', '3000']);
  await JobsDialog.submit();
  assert.deepEqual(calls.create.map(c => c.plant), ['2000', '3000']);
  assert.equal(calls.addSch.length, 1, 'no schedule for the plant whose job failed');
  assert.equal(calls.addSch[0][1].cron_expr, '0 8 * * *');
  assert.equal(calls.toast.at(-1)[1], 'warn');
  assert.deepEqual([...JobsDialog._state().targets], ['3000'], 'the failed plant stays ticked for a retry');
  assert.equal(calls.closed.length, 0);
});
