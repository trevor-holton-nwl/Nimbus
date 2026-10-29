// W4a fix wave (frontend): dependent fields inside a step card, the Add step limit, template info in place, the tolerated
// failure hint, step status styles, the live bar tick, focus kept across a repaint, client calls (If-Match, restart confirm).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installDom, makeEl } from '../helpers/dom-stub.mjs';
import { TYPES, byKey } from './jobs-types-fixture.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
const dom = installDom();
const M = await import('../../../frontend/admin-ops/jobs-model.mjs');
const { applyDependentFields, chainHtml, tplInfoHtml, stepCardHtml, resultHint } = await import('../../../frontend/admin-ops/jobs-dialog.mjs');
const { chainStepsHtml, _tickBars } = await import('../../../frontend/admin-ops/jobs-run-detail.mjs');
const { JobsClient } = await import('../../../frontend/admin-ops/jobs-client.mjs');
const { Util } = await import('../../../frontend/platform/foundation.mjs');

const D = { t: (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k), esc: s => String(s) };
const PURGE = byKey('purge.orders'); const OPT = byKey('optimizer.plant'); const REPORT = byKey('report.late_orders'); const CHAIN = byKey('chain');
const step = (meta, over = {}) => ({ ...M.newStep(meta), ...over });
const put = (id, over = {}) => { const el = makeEl(id, dom.doc); Object.assign(el, over); dom.doc.body.appendChild(el); return el; };
const clear = () => { dom.doc.body.children.slice().forEach(c => dom.doc.body.removeChild(c)); };
beforeEach(clear);

test('dependentFields matches the type form and every step card id', () => {
  assert.deepEqual(M.dependentFields('jb-p-filter_by_window'), { kind: 'filter_by_window', windowId: 'jb-p-window' });
  assert.deepEqual(M.dependentFields('jb-s2-p-filter_by_window'), { kind: 'filter_by_window', windowId: 'jb-s2-p-window' });
  assert.deepEqual(M.dependentFields('jb-s1-p-apply_mode'), { kind: 'apply_mode', hintId: 'jb-s1-p-apply_mode-hint' });
  assert.equal(M.dependentFields('jb-s1-p-max_rows'), null);
  assert.equal(M.dependentFields('jb-sx-p-filter_by_window'), null);
});

test('in a step card the filter_by_window checkbox shows its sibling window picker and the apply mode rewrites its own hint', () => {
  const win = put('jb-s1-p-window', { hidden: true });
  const other = put('jb-p-window', { hidden: true });          // the type-level picker (absent in a chain) must stay alone
  const box = put('jb-s1-p-filter_by_window', { checked: true });
  applyDependentFields('jb-s1-p-filter_by_window');
  assert.equal(win.hidden, false); assert.equal(other.hidden, true);
  box.checked = false;
  applyDependentFields('jb-s1-p-filter_by_window');
  assert.equal(win.hidden, true);
  const sel = put('jb-s1-p-apply_mode', { value: 'propose' });
  const hint = put('jb-s1-p-apply_mode-hint');
  applyDependentFields('jb-s1-p-apply_mode');
  assert.equal(hint.textContent, resultHint('propose'));
  sel.value = 'apply';
  applyDependentFields('jb-s1-p-apply_mode');
  assert.equal(hint.textContent, resultHint('apply'));
});

test('Add step is disabled at the step limit with its reason; below it the button is live', () => {
  const full = { ...M.defaultJobForm('1008', 'chain', null, CHAIN), steps: Array.from({ length: 10 }, () => step(REPORT)) };
  const html = chainHtml(full, TYPES, true, [], 'new');
  assert.match(html, /id="jb-addstep"[^>]*disabled/); assert.match(html, /id="jb-addhint">jobs\.step_max_hint/);
  const some = chainHtml({ ...full, steps: full.steps.slice(0, 3) }, TYPES, true, [], 'new');
  assert.doesNotMatch(some, /id="jb-addstep"[^>]*disabled/); assert.match(some, /id="jb-addhint"><\/div>/);
  assert.match(some, /id="jb-steps-live" role="status" aria-live="polite"/, 'a live region announces a moved step');
});

test('step action buttons have a 32 px hit class and the template line sits in its own block', () => {
  const card = stepCardHtml(step(PURGE), 0, 2, TYPES, true);
  assert.equal((card.match(/class="icon-btn job-step-act"/g) || []).length, 3);
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.job-step-btns \.icon-btn\.job-step-act \{ width: 32px; height: 32px; \}/);
  const html = chainHtml({ ...M.defaultJobForm('1008', 'chain', null, CHAIN), steps: [step(OPT)], templateId: 3, templateVersion: 2 }, TYPES, true, [{ id: 3, name: 'Nightly', archived: false, steps: [], defaults: {}, version: 2 }], 'new');
  assert.match(html, /<div id="jb-tplinfo"><div class="ape-hint job-tpl-tied">jobs\.tpl_tied/);
  assert.match(html, /id="jb-tplname"/);
});

test('tplInfoHtml names the template, its defaults, the ignored retry and the edited-locally flag', () => {
  const tpls = [{ id: 3, name: 'Nightly', archived: false, steps: [], defaults: {}, version: 2 }];
  assert.equal(tplInfoHtml({ templateId: null, templateVersion: null, tplDefaults: null }, tpls), '');
  const h = tplInfoHtml({ templateId: 3, templateVersion: 2, tplDefaults: { retryMax: 2, timeoutS: 1800, retryIgnored: false } }, tpls, true);
  assert.match(h, /jobs\.tpl_tied/); assert.match(h, /jobs\.tpl_edited_locally/); assert.match(h, /jobs\.tpl_defaults_retry/); assert.match(h, /jobs\.tpl_defaults_limit/);
  assert.match(tplInfoHtml({ templateId: 3, templateVersion: 2, tplDefaults: { retryMax: null, timeoutS: null, retryIgnored: true } }, tpls), /jobs\.tpl_retry_ignored/);
});

test('templateDefaults ignores a retry for a chain with a step that is not safe to repeat', () => {
  const safe = { steps: [{ type: 'optimizer.plant' }], defaults: { retry_max: 2, timeout_s: 900 } };
  assert.deepEqual(M.templateDefaults(safe, TYPES, D), { retryMax: 2, timeoutS: 900, retryIgnored: false });
  const unsafe = { steps: [{ type: 'purge.orders' }, { type: 'optimizer.plant' }], defaults: { retry_max: 2 } };
  assert.deepEqual(M.templateDefaults(unsafe, TYPES, D), { retryMax: null, timeoutS: null, retryIgnored: true });
  assert.deepEqual(M.templateDefaults({ steps: [], defaults: {} }, TYPES, D), { retryMax: null, timeoutS: null, retryIgnored: false });
  const f = { ...M.defaultJobForm('1008', 'chain', null, CHAIN), name: 'n', plant: '1008', steps: [step(OPT)], templateId: 3, tplDefaults: { retryMax: 2, timeoutS: 900 } };
  const job = M.buildJobPayload(f).job;
  assert.equal(job.retry_max, 2); assert.equal(job.timeout_s, 900);
  assert.equal(M.buildJobPayload({ ...f, tplDefaults: null }).job.retry_max, undefined);
});

test('stepIsCustomised: a default step is dropped without asking, an edited one asks', () => {
  assert.equal(M.stepIsCustomised(step(PURGE), PURGE), false);
  assert.equal(M.stepIsCustomised(step(PURGE, { params: { ...step(PURGE).params, max_rows: 10 } }), PURGE), true);
  assert.equal(M.stepIsCustomised(step(PURGE, { label: 'Old' }), PURGE), true);
  assert.equal(M.stepIsCustomised(step(PURGE, { continueOnFailure: true }), PURGE), true);
});

test('a warning chain run caused by a tolerated failed step shows a failed-step hint; other statuses do not', () => {
  const warn = { status: 'warning', summary: { step_counts: { failed: 1, succeeded: 2 } } };
  assert.equal(M.toleratedFailures(warn), 1);
  assert.match(M.runStatusHtml(warn, D), /job-warn-failed/);
  assert.equal(M.toleratedFailures({ status: 'warning', summary: { step_counts: { failed: 0 } } }), 0);
  assert.doesNotMatch(M.runStatusHtml({ status: 'failed', summary: { step_counts: { failed: 1 } } }, D), /job-warn-failed/);
  assert.doesNotMatch(M.runStatusHtml({ status: 'warning', summary: null }, D), /job-warn-failed/);
});

test('every step status has a style and the earlier-run row is quieter', () => {
  const css = readFileSync(new URL('../../../frontend/styles.css', import.meta.url), 'utf8');
  for (const s of ['running', 'succeeded', 'cancelled', 'skipped', 'failed', 'warning']) assert.match(css, new RegExp(`\\.job-step-bar-${s}|\\.job-step-row\\.job-step-${s}`), s);
  assert.match(css, /\.job-step-row\.job-step-earlier/);
  const rows = [{ seq: 1, stepType: 'optimizer.plant', label: null, runOn: 'success', status: 'skipped', startedAt: null, endedAt: null, durationMs: null, summary: { ran_in_run: 7 }, error: null, errorKind: null, actionId: null }];
  assert.match(chainStepsHtml({ id: 9, status: 'failed', job_type: 'chain' }, rows, TYPES, Date.now(), false), /job-step-row job-step-skipped job-step-earlier/);
});

test('Restart from this step is not offered on a plant run of a fan-out (canRestart false) and the running step shows a live duration', () => {
  const t0 = new Date(Date.now() - 5000).toISOString();
  const rows = [{ seq: 1, stepType: 'optimizer.plant', label: null, runOn: 'success', status: 'running', startedAt: t0, endedAt: null, durationMs: null, summary: null, error: null, errorKind: null, actionId: null }];
  const html = chainStepsHtml({ id: 9, status: 'running', job_type: 'chain' }, rows, TYPES, Date.now(), true);
  assert.match(html, /job-step-dur">[0-9]/, 'an open step shows the elapsed time, not a dash');
  assert.doesNotMatch(chainStepsHtml({ id: 9, status: 'failed', job_type: 'chain' }, [{ ...rows[0], status: 'failed' }], TYPES, Date.now(), false), /restart-step/);
});

test('the 1 s tick grows the running bar and its duration, and does nothing while the pane is hidden', () => {
  const t0 = new Date(Date.now() - 3000).toISOString();
  const steps = [{ seq: 1, status: 'succeeded', startedAt: new Date(Date.now() - 6000).toISOString(), endedAt: new Date(Date.now() - 3000).toISOString() },
    { seq: 2, status: 'running', startedAt: t0, endedAt: null }];
  const root = makeEl('jr-steps', dom.doc); dom.doc.body.appendChild(root);
  const mk = (seq, withBar) => { const row = makeEl('', dom.doc, 'li'); row.setAttribute('data-step-seq', seq); const bar = makeEl('', dom.doc, 'span'); bar.className = 'job-step-bar'; const dur = makeEl('', dom.doc, 'span'); dur.className = 'job-step-dur'; row.appendChild(bar); row.appendChild(dur); root.appendChild(row); return { bar, dur }; };
  const a = mk(1); const b = mk(2);
  _tickBars({ steps, visible: () => false }, root);
  assert.equal(b.bar.style.width, undefined, 'hidden pane: untouched');
  _tickBars({ steps, visible: () => true }, root);
  assert.ok(parseFloat(b.bar.style.width) > 1.5, 'the running bar has a width');
  assert.match(b.dur.textContent, /\d/);
  assert.equal(a.dur.textContent, '', 'a finished step keeps the duration the server gave');
});

test('client: updateTemplate sends the If-Match version, restartRun the confirm flag, updateFromTemplate reports overridden plants', async () => {
  const prior = Util.fetchTraced; const calls = [];
  Util.fetchTraced = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => (url.includes('/template/update') ? { id: 5, plant: '1008', job_type: 'chain', name: 'n', params: {}, schedules: [], steps_overridden_plants: ['1021'] }
      : url.includes('/templates/') ? { template: { id: 3, name: 'x', steps: [], defaults: {}, version: 3, archived: false } } : { run: { id: 1, status: 'scheduled' } }) }; };
  try {
    const tpl = await JobsClient.updateTemplate(3, { steps: [], expectedVersion: 2 });
    assert.equal(calls[0].body.expected_version, 2); assert.equal(tpl.version, 3);
    await JobsClient.restartRun(7, { confirm: true });
    assert.deepEqual(calls[1].body, { confirm: true });
    await JobsClient.restartRun(7);
    assert.equal(calls[2].body, undefined);
    const r = await JobsClient.updateFromTemplate(5);
    assert.deepEqual(r.overriddenPlants, ['1021']);
  } finally { Util.fetchTraced = prior; }
});

test('the template ref carries editedLocally', async () => {
  const { normTemplateRef } = await import('../../../frontend/admin-ops/jobs-client.mjs');
  assert.equal(normTemplateRef({ id: 1, name: 'n', version: 1, current_version: 1, archived: false, changed: false, edited_locally: true }).editedLocally, true);
});
