// W4a: the chain builder. Model (steps, validation, payload, timeline maths, diff lines), the dialog markup and save
// sequence, the run-detail step timeline, and the client's chain / template calls against the contract fixture.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { installDom } from '../helpers/dom-stub.mjs';
import { TYPES, byKey } from './jobs-types-fixture.mjs';
import * as M from '../../../frontend/admin-ops/jobs-model.mjs';
import { JobsClient, normType, normJob } from '../../../frontend/admin-ops/jobs-client.mjs';
import { JobsDialog, bodyHtml, stepCardHtml, stepListHtml, chainHtml, paramsBlockHtml } from '../../../frontend/admin-ops/jobs-dialog.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Modal, Toast, Util } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const D = { t: k => k, esc: s => String(s) };
const PURGE = byKey('purge.orders'); const OPT = byKey('optimizer.plant'); const REPORT = byKey('report.late_orders'); const CHAIN = byKey('chain');
const step = (meta, over = {}) => ({ ...M.newStep(meta), ...over });
const RAW = JSON.parse(readFileSync(new URL('../../fixtures/jobs_contract.json', import.meta.url), 'utf8'));
const resolveRef = v => (typeof v === 'string' && v.startsWith('$') ? resolveRef(RAW[v.slice(1)]) : Array.isArray(v) ? v.map(resolveRef) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRef(x)])) : v);
const FIX = Object.fromEntries(Object.keys(RAW).map(k => [k, resolveRef(RAW[k])]));
installDom();   // the markup tests read the locale keys themselves (no locale loaded)

// --------------------------------------------------------------------------------------------------- the served contract
test('the served types carry the step-type contract', () => {
  assert.deepEqual([OPT.idempotent, OPT.dryRun, OPT.estimateS], [true, { param: 'apply_mode', value: 'propose' }, 180]);
  assert.deepEqual([PURGE.idempotent, PURGE.dryRun, PURGE.mutates], [false, { param: 'dry_run', value: true }, true]);
  assert.deepEqual([CHAIN.composite, CHAIN.lockKeys], [true, []]);
  assert.deepEqual(PURGE.lockKeys, ['jobs:optimizer.plant:{plant}', 'jobs:purge.orders:{plant}']);
  assert.equal(REPORT.mutates, false);
});

test('typeGroups puts chains in their own group and keeps them out of the others', () => {
  const g = M.typeGroups(TYPES);
  assert.deepEqual(g.map(x => x.kind), ['action', 'data', 'sap', 'report', 'chain']);
  assert.deepEqual(g[0].types.map(x => x.key), ['optimizer.plant', 'optimizer.backlog']);
  assert.deepEqual(g[1].types.map(x => x.key), ['purge.orders', 'routing.recompute', 'attributes.resync']);
  assert.deepEqual(g[2].types.map(x => x.key), ['sap.apply_batch', 'sap.send']);
  assert.deepEqual(g[4].types.map(x => x.key), ['chain']);
  assert.ok(!g[0].types.some(x => x.composite));
  assert.deepEqual(M.stepTypes(TYPES).map(x => x.key).includes('chain'), false);
});

// ------------------------------------------------------------------------------------------------------ steps
test('a new step starts from the type defaults; the wire shape round-trips', () => {
  const s = step(PURGE, { label: ' Old ', continueOnFailure: true, runOn: 'always' });
  assert.equal(s.params.max_rows, 5000);
  const wire = M.stepToWire(s);
  assert.deepEqual([wire.type, wire.label, wire.continue_on_failure, wire.run_on], ['purge.orders', 'Old', true, 'always']);
  const back = M.stepFromWire(wire);
  assert.deepEqual([back.type, back.label, back.continueOnFailure, back.runOn], ['purge.orders', 'Old', true, 'always']);
  assert.equal(M.stepToWire(step(OPT)).label, null, 'a blank name is sent as null');
  assert.equal(M.stepFromWire({ type: 'x', run_on: 'nope' }).runOn, 'success');
});

test('moveStep and removeStep keep the order and never go out of range', () => {
  const a = [1, 2, 3];
  assert.deepEqual(M.moveStep(a, 0, 1), [2, 1, 3]);
  assert.deepEqual(M.moveStep(a, 2, -1), [1, 3, 2]);
  assert.equal(M.moveStep(a, 0, -1), a);
  assert.equal(M.moveStep(a, 2, 1), a);
  assert.deepEqual(M.removeStep(a, 1), [1, 3]);
});

test('chainMode: dry-run, apply, report-only, and mixed (read-only steps do not count)', () => {
  const dryOpt = step(OPT, { params: { ...OPT.defaults, apply_mode: 'propose' } });
  const dryPurge = step(PURGE, { params: { ...PURGE.defaults, dry_run: true } });
  assert.equal(M.chainMode([dryOpt, dryPurge, step(REPORT)], TYPES), 'dry_run');
  assert.equal(M.chainMode([step(OPT), step(PURGE)], TYPES), 'apply');
  assert.equal(M.chainMode([step(REPORT)], TYPES), 'report');
  assert.equal(M.chainMode([dryOpt, step(PURGE)], TYPES), 'mixed');
});

test('validateChain: empty, too many, unknown type, mixed, purge window too young or "since last success"', () => {
  assert.equal(M.validateChain([], TYPES).steps, 'jobs.err_chain_empty');
  assert.equal(M.validateChain(Array.from({ length: 11 }, () => step(REPORT)), TYPES).steps, 'jobs.err_chain_max');
  assert.deepEqual(M.validateChain([{ ...step(REPORT), type: 'nope' }], TYPES).stepParams, { 0: { _type: 'jobs.err_chain_type' } });
  assert.deepEqual(M.validateChain([step(OPT), step(PURGE)], TYPES), {}, 'the defaults are a valid apply chain');
  const mixed = M.validateChain([step(OPT, { params: { ...OPT.defaults, apply_mode: 'propose' } }), step(PURGE)], TYPES);
  assert.equal(mixed.steps, 'jobs.err_chain_mixed');
  const young = (w) => M.validateChain([step(PURGE, { params: { ...PURGE.defaults, window: w } })], TYPES).stepParams?.[0]?.window;
  assert.equal(young({ mode: 'rolling', rolling: { anchor: 'start_of_day', from_offset: -3650, to_offset: -3, unit: 'day' } }), 'jobs.err_purge_young');
  assert.equal(young({ mode: 'rolling', rolling: { anchor: 'start_of_day', from_offset: -3650, to_offset: -7, unit: 'day' } }), undefined);
  assert.equal(young({ mode: 'rolling', rolling: { anchor: 'last_success', from_offset: 0, to_offset: 0, unit: 'day' } }), 'jobs.err_purge_since');
  assert.equal(young({ mode: 'rolling', rolling: { anchor: 'start_of_month', from_offset: 0, to_offset: 1, unit: 'month' } }), 'jobs.err_purge_young');
  assert.equal(M.purgeWindowError({ mode: 'fixed', fixed: { from: '2026-01-01', to: '2026-02-01' } }, 7), '', 'a fixed window is the server\'s to check');
  const bad = M.validateChain([step(PURGE, { params: { ...PURGE.defaults, max_rows: 0 } })], TYPES);
  assert.equal(bad.stepParams[0].max_rows, 'jobs.err_param_range');
});

test('a chain form validates its steps, not the generic params, and needs no Result', () => {
  const f = { ...M.defaultJobForm('1008', 'chain', null, CHAIN), name: 'Nightly', steps: [step(PURGE), step(OPT)] };
  assert.deepEqual(f.params, {});
  assert.deepEqual(M.validateJobForm(f, { isAdmin: true, plants: null, meta: CHAIN, types: TYPES }), {});
  const none = M.validateJobForm({ ...f, steps: [] }, { isAdmin: true, plants: null, meta: CHAIN, types: TYPES });
  assert.equal(none.steps, 'jobs.err_chain_empty');
});

test('buildJobPayload sends a chain as {steps}, with the template id; jobToForm reads it back', () => {
  const f = { ...M.defaultJobForm('1008', 'chain', null, CHAIN), name: 'Nightly', steps: [step(PURGE), step(OPT, { continueOnFailure: true })], templateId: 3, templateVersion: 2 };
  const { job } = M.buildJobPayload(f);
  assert.deepEqual(Object.keys(job.params), ['steps']);
  assert.equal(job.params.steps.length, 2);
  assert.equal(job.params.steps[1].continue_on_failure, true);
  assert.equal(job.template_id, 3);
  assert.equal('template_id' in M.buildJobPayload({ ...f, templateId: null }).job, false);
  const back = M.jobToForm({ name: 'Nightly', plant: '1008', job_type: 'chain', params: job.params, templateId: 3, templateVersion: 2 }, CHAIN);
  assert.deepEqual(back.steps.map(s => [s.type, s.continueOnFailure]), [['purge.orders', false], ['optimizer.plant', true]]);
  assert.deepEqual([back.templateId, back.templateVersion, back.params], [3, 2, {}]);
});

test('chainSummaryText and stepTitle name the steps; diffLines reads the diff in words', () => {
  const steps = [step(PURGE), step(OPT), step(REPORT), step(REPORT)];
  assert.match(M.chainSummaryText(steps, TYPES, D), /^jobs\.chain_steps/);
  assert.match(M.chainSummaryText(steps, TYPES, D), / \.\.\.$/);
  assert.equal(M.chainSummaryText([], TYPES, D), '');
  assert.equal(M.stepTitle({ type: 'purge.orders', label: 'Mine' }, TYPES, D), 'Mine');
  assert.equal(M.stepTitle({ type: 'purge.orders' }, TYPES, D), PURGE.label);
  const lines = M.diffLines(FIX.template_diff.diff.concat([{ seq: 2, change: 'added', job: null, template: { type: 'optimizer.plant' }, fields: [] }]), TYPES,
    { t: (k, v) => `${k}|${v?.n}|${v?.fields ?? ''}` });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^jobs\.diff_changed\|1\|/);
  assert.match(lines[1], /^jobs\.diff_added\|2/);
});

// ---------------------------------------------------------------------------------------------- run timeline maths
test('stepWaterfall: bars on one axis, a running step reaches now, an unstarted step has none', () => {
  const steps = [
    { seq: 1, status: 'succeeded', startedAt: '2026-10-29T12:00:00Z', endedAt: '2026-10-29T12:01:00Z' },
    { seq: 2, status: 'running', startedAt: '2026-10-29T12:01:00Z', endedAt: null },
    { seq: 3, status: 'pending', startedAt: null, endedAt: null },
  ];
  const bars = M.stepWaterfall(steps, Date.parse('2026-10-29T12:03:00Z'));
  assert.equal(bars.length, 2);
  assert.deepEqual([bars[0].leftPct, bars[0].widthPct], [0, 33.3]);
  assert.deepEqual([bars[1].leftPct, bars[1].widthPct], [33.3, 66.7]);
  assert.deepEqual(M.stepWaterfall([], 0), []);
  assert.ok(M.stepWaterfall([{ seq: 1, status: 'succeeded', startedAt: '2026-10-29T12:00:00Z', endedAt: '2026-10-29T12:00:00Z' }], 0)[0].widthPct >= 1.5, 'never invisible');
});

test('restartStepOf picks the failed step, else the first step that never ran; never for a finished run', () => {
  const rows = [{ seq: 1, status: 'succeeded', summary: null }, { seq: 2, status: 'failed', summary: null }, { seq: 3, status: 'skipped', summary: { reason: 'x' } }];
  assert.equal(M.restartStepOf({ status: 'failed' }, rows).seq, 2);
  assert.equal(M.restartStepOf({ status: 'succeeded' }, rows), null);
  assert.equal(M.restartStepOf({ status: 'cancelled' }, [rows[0], { seq: 2, status: 'skipped', summary: { ran_in_run: 5 } }, rows[2]]).seq, 3, 'a step done in an earlier run is not a start');
  assert.equal(M.ranInRun({ summary: { ran_in_run: 9 } }), 9);
  assert.deepEqual(M.stepFacts({ summary: { deleted: 3, applied: 0, text: 'x' } }).map(f => [f.key, f.value]), [['applied', 0], ['deleted', 3]]);
});

test('filterLog narrows to one chain step', () => {
  const lines = [{ seq: 1, level: 'info', msg: 'a', step_seq: null }, { seq: 2, level: 'info', msg: 'b', step_seq: 1 }, { seq: 3, level: 'info', msg: 'c', step_seq: 2 }];
  assert.deepEqual(M.filterLog(lines, { stepSeq: 2 }).map(l => l.seq), [3]);
  assert.equal(M.filterLog(lines, {}).length, 3);
});

// ------------------------------------------------------------------------------------------------------ the client
let calls; let reply; const prior = {};
beforeEach(() => {
  calls = []; reply = null; prior.fetch = Util.fetchTraced;
  Util.fetchTraced = async (url, init) => { calls.push({ url: url.replace(/^.*?(\/jobs)/, '$1'), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined }); return { ok: true, status: 200, json: async () => reply }; };
});
afterEach(() => { Util.fetchTraced = prior.fetch; });

test('client: types limits, templates CRUD, template diff / update, restart from a step, run detail', async () => {
  reply = FIX.types;
  const ty = await JobsClient.types();
  assert.equal(ty[0].idempotent, true);
  assert.deepEqual(JobsClient.limits(), { maxSteps: 10, purgeMinAgeDays: 7 });
  reply = FIX.templates_list;
  const list = await JobsClient.templates(true);
  assert.equal(calls.at(-1).url, '/jobs/templates?include_archived=true');
  assert.deepEqual([list[0].id, list[0].version, list[0].steps.length, list[0].archived], [3, 2, 1, false]);
  reply = FIX.template_wrapped;
  assert.equal((await JobsClient.createTemplate({ name: 'n', steps: [] })).name, 'Purge then re-optimize');
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['POST', '/jobs/templates']);
  await JobsClient.updateTemplate(3, { archived: true });
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ['PATCH', '/jobs/templates/3', { archived: true }]);
  reply = FIX.template_diff;
  const d = await JobsClient.templateDiff(5);
  assert.deepEqual([d.changed, d.jobVersion, d.diff[0].change, d.diff[0].fields], [true, 1, 'changed', ['params.max_rows']]);
  reply = { ...FIX.job };
  await JobsClient.updateFromTemplate(5);
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['POST', '/jobs/5/template/update']);
  reply = FIX.run_started;
  await JobsClient.restartFromStep(42, { fromStep: 2, confirm: true });
  assert.deepEqual([calls.at(-1).url, calls.at(-1).body], ['/jobs/runs/42/restart-step', { confirm: true, from_step: 2 }]);
  await JobsClient.restartFromStep(42);
  assert.deepEqual(calls.at(-1).body, { confirm: false });
  reply = FIX.run_detail;
  const rd = await JobsClient.getRunDetail(42);
  assert.deepEqual([rd.run.id, rd.steps[0].status, rd.steps[0].errorKind, rd.steps[0].durationMs, rd.steps[0].runOn], [42, 'failed', 'transient', 219000, 'success']);
});

test('client: a job carries its template reference', () => {
  const j = normJob(FIX.job);
  assert.deepEqual([j.template.name, j.template.version, j.template.currentVersion, j.template.changed], ['Purge then re-optimize', 1, 2, true]);
  assert.equal(normJob({ id: 1, template: null }).template, null);
  assert.equal(normType({ key: 'x', params: [] }).composite, false);
});

// -------------------------------------------------------------------------------------------------- dialog markup
const WITH_TPL = [{ id: 3, name: 'Purge then re-optimize', steps: FIX.template.steps, version: 2, archived: false, defaults: {}, description: null }];

test('the dialog shows the step builder for a chain and the params form for any other type', () => {
  const f = { ...M.defaultJobForm('1008', 'chain', null, CHAIN), steps: [step(PURGE), step(OPT)] };
  const html = bodyHtml(f, 'new', true, CHAIN, TYPES, WITH_TPL);
  assert.match(html, /id="jb-chain"/); assert.match(html, /id="jb-steps"/); assert.match(html, /id="jb-template"/);
  assert.match(html, /id="jb-s0-type"/); assert.match(html, /id="jb-s1-type"/);
  assert.match(html, /id="jb-s0-p-max_rows"/); assert.match(html, /id="jb-s1-p-mode"/, 'each step has its own namespaced params');
  assert.match(html, /id="jb-s0-p-window"/); assert.match(html, /id="jb-err-s0-p-max_rows"/);
  assert.doesNotMatch(html, /id="jb-p-/, 'no top-level param ids in a chain dialog');
  assert.match(html, /<details class="job-step-adv"><summary>jobs\.step_advanced/, 'on-failure is visible, run-when and name are under Advanced');
  assert.match(html, /id="jb-s0-onfail"/); assert.match(html, /id="jb-s0-runon"/);
  assert.match(html, /data-jb-act="tpl-save"/); assert.doesNotMatch(html, /data-jb-act="tpl-update"/, 'one Save as template button; a tied job is asked which one it means');
  const linked = chainHtml({ ...f, templateId: 3, templateVersion: 2 }, TYPES, true, WITH_TPL, 'edit');
  assert.match(linked, /jobs\.tpl_tied/, 'the dialog says which template the job is tied to'); assert.doesNotMatch(linked, /id="jb-template"/, 'the picker is for a new job only');
  const plain = bodyHtml(M.defaultJobForm('1008', 'optimizer.plant', OPT.defaults, OPT), 'new', true, OPT, TYPES, WITH_TPL);
  assert.match(plain, /id="jb-p-mode"/); assert.doesNotMatch(plain, /id="jb-chain"/);
});

test('step cards: move buttons disable at the ends, the type select lists no chain, an empty list says so', () => {
  const first = stepCardHtml(step(PURGE), 0, 2, TYPES, true);
  assert.match(first, /data-jb-act="step-up"[^>]*disabled/); assert.doesNotMatch(first, /data-jb-act="step-down"[^>]*disabled/);
  const last = stepCardHtml(step(PURGE), 1, 2, TYPES, true);
  assert.match(last, /data-jb-act="step-down"[^>]*disabled/);
  assert.doesNotMatch(first, /value="chain"/);
  assert.match(stepListHtml({ steps: [] }, TYPES, true), /jobs\.steps_none/);
  assert.match(paramsBlockHtml(M.defaultJobForm('1008', 'chain', null, CHAIN), 'new', true, CHAIN, TYPES, []), /job-chain/);
});

test('a purge step shows its window picker, max rows and dry-run box', () => {
  const html = stepCardHtml(step(PURGE), 0, 1, TYPES, true);
  assert.match(html, /id="jb-s0-p-window-choice"/); assert.match(html, /id="jb-s0-p-dry_run"/); assert.match(html, /id="jb-s0-p-machines"|id="jb-s0-p-max_rows"/);
});

// ------------------------------------------------------------------------------------- dialog save sequence
let dom; let els;
function add(id, props = {}) { const el = dom.doc.createElement('div'); el.setAttribute('id', id); Object.assign(el, props); dom.doc.body.appendChild(el); els[id] = el; return el; }
function loadEnglish(win) { const w = {}; vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window: w }); win.__NIMBUS_LOCALES = w.__NIMBUS_LOCALES; }

test('saving a new chain from a template creates a job with its steps and the template id; an invalid chain is refused', async () => {
  dom = installDom(); loadEnglish(dom.win); els = {};
  for (const id of ['modal-job-edit', 'jb-body', 'jb-foot', 'jb-title', 'jb-close', 'jb-plant-host', 'jb-save']) add(id);
  for (const id of ['name', 'plant', 'result', 'time', 'minute', 'days', 'dom', 'cron', 'runAt', 'validity', 'steps']) add(`jb-err-${id}`, { hidden: true });
  const saved = { admin: Session.isAdmin, allowed: Session.allowedPlants, plants: Store.knownPlants, prev: JobsClient.preview, win: JobsClient.windowPreview, create: JobsClient.create,
    tp: JobsClient.targetsPreview, open: Modal.open, close: Modal.close, toast: Toast.show };
  const created = []; const toasts = [];
  try {
    Session.isAdmin = () => true; Session.allowedPlants = () => null; Store.knownPlants = () => ['1008'];
    JobsClient.preview = async () => ({ timezone: 'America/Chicago', cronExpr: null, entries: [], skipped: [], plants: [], totalPlants: 1, warnings: [] });
    JobsClient.windowPreview = async () => ({ start: 'S', end: 'E', label: 'L', timezone: 'America/Chicago' });
    JobsClient.targetsPreview = async () => ({ plants: [], count: 0, skipped: 0, warnings: [] });
    JobsClient.create = async j => { created.push(j); return { id: 9 }; };
    Modal.open = () => {}; Modal.close = () => {}; Toast.show = (m, k) => toasts.push([m, k]);
    JobsDialog.open({ plant: '1008', types: TYPES, templates: WITH_TPL, templateId: 3, jobType: 'chain' });
    const s = JobsDialog._state();
    assert.equal(s.form.steps.length, 1); assert.equal(s.form.templateId, 3);
    (els['jb-name'] ?? add('jb-name')).value = 'Nightly purge';
    (els['jb-recur'] ?? add('jb-recur')).value = 'daily'; (els['jb-time'] ?? add('jb-time')).value = '02:00';
    await JobsDialog.submit();
    assert.equal(created.length, 1, JSON.stringify(toasts));
    assert.deepEqual([created[0].job_type, created[0].template_id, created[0].params.steps.length, created[0].params.steps[0].type], ['chain', 3, 1, 'purge.orders']);
    assert.equal(created[0].schedules.length, 1);
    // an empty chain never reaches the server (a fresh dialog: the first one closed when it saved)
    JobsDialog.open({ plant: '1008', types: TYPES, templates: WITH_TPL, jobType: 'chain' });
    assert.deepEqual(JobsDialog._state().form.steps, []);
    els['jb-name'].value = 'Empty';
    await JobsDialog.submit();
    assert.equal(created.length, 1);
    assert.equal(els['jb-err-steps'].hidden, false); assert.match(els['jb-err-steps'].textContent, /at least one step/i);
  } finally {
    Object.assign(Session, { isAdmin: saved.admin, allowedPlants: saved.allowed }); Store.knownPlants = saved.plants;
    Object.assign(JobsClient, { preview: saved.prev, windowPreview: saved.win, create: saved.create, targetsPreview: saved.tp });
    Modal.open = saved.open; Modal.close = saved.close; Toast.show = saved.toast;
  }
});

// -------------------------------------------------------------------------------------------- run detail timeline
test('the run detail lists each step with its status, bar, counts, error, history link, log button and the restart button', async () => {
  installDom();
  const { chainStepsHtml } = await import('../../../frontend/admin-ops/jobs-run-detail.mjs');
  const run = { id: 9, job_id: 1, job_name: 'Nightly', plant: '1008', job_type: 'chain', status: 'failed' };
  const rows = [
    { seq: 1, stepType: 'purge.orders', label: null, runOn: 'success', status: 'succeeded', startedAt: '2026-10-29T12:00:00Z', endedAt: '2026-10-29T12:00:10Z', durationMs: 10000, summary: { deleted: 12, matched: 12 }, error: null, errorKind: null, actionId: 'a-1' },
    { seq: 2, stepType: 'optimizer.plant', label: 'Re-optimize', runOn: 'success', status: 'failed', startedAt: '2026-10-29T12:00:10Z', endedAt: '2026-10-29T12:03:10Z', durationMs: 180000, summary: null, error: 'write refused', errorKind: 'transient', actionId: null },
    { seq: 3, stepType: 'report.late_orders', label: null, runOn: 'always', status: 'skipped', startedAt: null, endedAt: null, durationMs: null, summary: { reason: 'x' }, error: null, errorKind: null, actionId: null },
  ];
  const html = chainStepsHtml(run, rows, TYPES, Date.now(), true);
  assert.equal((html.match(/class="job-step-row job-step-\w+/g) || []).length, 3);
  assert.match(html, /Re-optimize/); assert.match(html, /write refused/); assert.match(html, /jobs\.error_kind_transient/);
  assert.match(html, /job-step-bar job-step-bar-failed/);
  assert.match(html, /kpi-tile[^>]*><span class="k">jobs\.tile_deleted<\/span><span class="v">12</);
  assert.match(html, /data-jr-act="history" data-jr-action="a-1"/);
  assert.equal((html.match(/data-jr-act="step-log"/g) || []).length, 2, 'a step that never ran has no log');
  assert.match(html, /data-jr-act="restart-step" data-jr-step="2"/);
  assert.doesNotMatch(chainStepsHtml(run, rows, TYPES, Date.now(), false), /restart-step/, 'read-only viewers cannot restart');
  assert.doesNotMatch(chainStepsHtml({ ...run, status: 'succeeded' }, rows, TYPES, Date.now(), true), /restart-step/);
  assert.match(chainStepsHtml(run, [{ ...rows[2], summary: { ran_in_run: 5 } }], TYPES, Date.now(), true), /jobs\.step_done_earlier/);
  assert.equal(chainStepsHtml(run, [], TYPES, 0, true), '');
});
