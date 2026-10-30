// Tests for frontend/admin-ops/jobs-pane.mts against the dom-stub: the three sub-views stay in the DOM side by
// side, so no control id may repeat across them, and each view's filters must reach its own loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom } from '../helpers/dom-stub.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
const dom = installDom();   // one document for the whole file: the pane wires its listeners once, on the first pane it sees

const { JobsAdmin } = await import('../../../frontend/admin-ops/jobs-pane.mjs');
const { JobsClient } = await import('../../../frontend/admin-ops/jobs-client.mjs');
const { Session } = await import('../../../frontend/security/session.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');

const add = (id, parent = dom.doc.body) => {
  const el = dom.doc.createElement('div');
  el.setAttribute('id', id);
  parent.appendChild(el);
  return el;
};
const idsIn = html => [...String(html).matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const { TYPES } = await import('./jobs-types-fixture.mjs');

test('Jobs, Runs and Upcoming never share a control id, and each plant combobox lands in its own host', async () => {
  const calls = { list: [], runs: [], upcoming: [] };
  Session.isAdmin = () => true; Session.allowedPlants = () => null; Store.knownPlants = () => ['1008', '2000'];
  JobsClient.types = async () => TYPES;
  JobsClient.list = async q => { calls.list.push(q); return { items: [], nextBeforeId: null }; };
  JobsClient.runs = async q => { calls.runs.push(q); return { items: [], nextBeforeId: null }; };
  JobsClient.upcomingAll = async (plant, n) => { calls.upcoming.push([plant, n]); return []; };

  const pane = add('admin-jobs-pane');
  const views = { jobs: add('jobs-view-jobs', pane), runs: add('jobs-view-runs', pane), upcoming: add('jobs-view-upcoming', pane) };
  const hosts = { jobs: add('jobs-plant-host'), runs: add('jobs-runs-plant-host'), up: add('jobs-up-plant-host') };
  add('jobs-table'); add('jobs-runs-list'); add('jobs-upcoming-body');   // the stub does not parse the markup the pane writes

  await JobsAdmin.render();                 // Jobs first, as the cockpit does
  JobsAdmin._setTab('runs');
  JobsAdmin._setTab('upcoming');

  const all = [...Object.values(views).flatMap(v => idsIn(v.innerHTML)), ...Object.values(hosts).flatMap(h => idsIn(h.innerHTML))];
  assert.deepEqual(all.filter((id, i) => all.indexOf(id) !== i), [], 'no id appears twice across the three views');
  for (const [key, id] of [['jobs', 'jobs-plant'], ['runs', 'jobs-runs-plant'], ['up', 'jobs-up-plant']]) {
    assert.match(hosts[key].innerHTML, new RegExp(`id="${id}"`), `${key} combobox is mounted in its own host`);
  }

  // The status filters reach their own loader after the other views have rendered.
  // Every registered type is in both type filters, grouped Optimization | Reports.
  for (const view of [views.jobs, views.runs]) {
    assert.equal([...view.innerHTML.matchAll(/<optgroup label=/g)].length, 5, 'Optimization, Data, SAP, Reports and Chains');
    for (const t of TYPES) assert.match(view.innerHTML, new RegExp(`<option value="${t.key.replace('.', '\\.')}"`), t.key);
  }
  const jobsStatus = add('jobs-status', pane); jobsStatus.value = 'warning';
  jobsStatus.dispatch('change');
  assert.equal(calls.list.at(-1).status, 'warning');
  const runsStatus = add('jobs-runs-status', pane); runsStatus.value = 'failed';
  JobsAdmin._setTab('runs');
  runsStatus.dispatch('change');
  assert.equal(calls.runs.at(-1).status, 'failed');
});

test('the Jobs list has a Targets column (no Copy-to-plants action), and the Runs tab switches to batches that expand to their plant runs', async () => {
  const job = { id: 5, name: 'Multi', plant: '1008', job_type: 'optimizer.plant', params: {}, enabled: true, schedule: null, schedules: [], next_run_at: null, next_run_local: null, last_run: null,
    targets: [], targetKind: 'selected', targetCount: 12, targetSkipped: 2, fanOut: null };
  JobsClient.list = async () => ({ items: [job, { ...job, id: 6, name: 'Solo', targetKind: 'single', targetCount: 1, targetSkipped: 0 }], nextBeforeId: null });
  const batch = { id: 9, jobId: 5, jobName: 'Multi', status: 'warning', trigger: 'schedule', triggeredBy: 'schedule', startedAt: null, endedAt: null, durationMs: 300000, counts: { total: 3, succeeded: 2, skipped: 1 } };
  const asked = [];
  JobsClient.batches = async q => { asked.push(q); return { items: [batch], nextBeforeId: null }; };
  JobsClient.batch = async id => ({ batch, runs: [{ id: 41, job_id: 5, job_name: 'Multi', plant: '1008', job_type: 'optimizer.plant', status: 'failed', trigger: 'schedule', scheduled_for: null, started_at: null,
    ended_at: null, duration_ms: 1000, triggered_by: 'schedule', summary: { error_kind: 'config' }, error: 'boom', log_truncated: false, batchId: id }] });
  JobsAdmin._setTab('jobs');
  await new Promise(r => setTimeout(r, 20));
  const table = dom.doc.getElementById('jobs-table').innerHTML;
  assert.match(table, /jobs\.col_targets|Targets/, 'a Targets column header');
  assert.match(table, /jobs\.targets_n|12 plants/);
  assert.match(table, /jobs\.targets_single|Plant 1008/, 'a single-plant job still reads as its plant');
  assert.match(table, /jobs\.targets_skipped|2 skipped/);
  assert.doesNotMatch(table, /m_copy|data-jobs-act="copy"/);

  JobsAdmin._setTab('runs');
  const pane = dom.doc.getElementById('admin-jobs-pane');
  const view = add('jobs-runs-view', pane); view.value = 'batches';
  view.dispatch('change');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(asked.at(-1).status, '', 'the batches loader got its own filters');
  const list = () => dom.doc.getElementById('jobs-runs-list').innerHTML;
  assert.match(list(), /data-jobs-batch="9"/);
  assert.match(list(), /aria-expanded="false"/);
  assert.match(list(), /jobs\.batch_tile_total|Plants/);
  const toggle = add('jobs-batch-toggle', pane); toggle.setAttribute('data-jobs-batch', '9'); toggle.dataset.jobsBatch = '9';
  toggle.dispatch('click');
  await new Promise(r => setTimeout(r, 20));
  assert.match(list(), /data-run-id="41"/, 'the per-plant run is listed under the batch');
  assert.match(list(), /jobs\.error_kind_config|Fix the job/);
});

test('batch rows offer Cancel while running and Restart failed plants once finished with failures (admin only); a nested button never opens a run', async () => {
  Session.isAdmin = () => true;
  const run = { id: 41, job_id: 5, job_name: 'Multi', plant: '1008', job_type: 'optimizer.plant', status: 'failed', trigger: 'schedule', scheduled_for: null, started_at: null,
    ended_at: null, duration_ms: 1000, triggered_by: 'schedule', summary: { error_kind: 'config', row_counts: { orders: 7, queued: 2 } }, error: 'boom', log_truncated: false, batchId: 9 };
  const running = { id: 20, jobId: 5, jobName: 'Live', status: 'running', trigger: 'schedule', triggeredBy: 'schedule', startedAt: null, endedAt: null, durationMs: null, counts: { total: 4, succeeded: 1, scheduled: 3 } };
  const failed = { id: 19, jobId: 5, jobName: 'Multi', status: 'failed', trigger: 'schedule', triggeredBy: 'schedule', startedAt: null, endedAt: null, durationMs: 1, counts: { total: 3, succeeded: 2, failed: 1 } };
  const okBatch = { ...failed, id: 18, jobName: 'Fine', status: 'succeeded', counts: { total: 3, succeeded: 3 } };
  JobsClient.batches = async () => ({ items: [running, failed, okBatch], nextBeforeId: null });
  JobsClient.batch = async id => ({ batch: failed, runs: [run], hasMore: id === 19 });
  JobsAdmin._setTab('runs');
  const pane = dom.doc.getElementById('admin-jobs-pane');
  const view = add('jobs-runs-view', pane); view.value = 'batches'; view.dispatch('change');
  await new Promise(r => setTimeout(r, 20));
  const list = () => dom.doc.getElementById('jobs-runs-list').innerHTML;
  assert.match(list(), /data-jobs-batch-cancel="20"/, 'a running batch can be cancelled');
  assert.doesNotMatch(list(), /data-jobs-batch-restart="20"/);
  assert.match(list(), /data-jobs-batch-restart="19"/, 'a batch with a failed plant can be restarted');
  assert.doesNotMatch(list(), /data-jobs-batch-restart="18"/, 'nothing to restart when every plant finished');
  assert.doesNotMatch(list(), /data-jobs-batch-cancel="19"/);
  const toggle = add('jobs-batch-toggle2', pane); toggle.setAttribute('data-jobs-batch', '19'); toggle.dataset.jobsBatch = '19';
  toggle.dispatch('click');
  await new Promise(r => setTimeout(r, 20));
  assert.match(list(), /jobs\.col_row_counts/, 'a report run in the batch adds a rows-found column');
  assert.match(list(), /<td class="job-mono">9<\/td>/, 'the sum of the run summary row_counts');
  assert.match(list(), /data-jobs-batch-more="19"/, 'a batch with more plants than one page offers the next page');
  Session.isAdmin = () => false;
  JobsAdmin._setTab('runs');
  view.dispatch('change');
  await new Promise(r => setTimeout(r, 20));
  assert.doesNotMatch(list(), /data-jobs-batch-restart|data-jobs-batch-cancel/, 'read-only users get no batch actions');
  Session.isAdmin = () => true;
});

test('JobsAdmin.showTab switches the inner view like a tab click (deep link target for jobs:<tab> anchors)', async () => {
  JobsClient.types = async () => TYPES;
  JobsClient.list = async () => ({ items: [], nextBeforeId: null });
  JobsClient.runs = async () => ({ items: [], nextBeforeId: null });
  JobsClient.upcomingAll = async () => [];
  const runsView = dom.doc.getElementById('jobs-view-runs');
  await JobsAdmin.render();
  assert.equal(typeof JobsAdmin.showTab, 'function');
  JobsAdmin.showTab('runs');
  assert.equal(runsView.hidden, false, 'showTab("runs") shows the Runs view as a tab click does');
  JobsAdmin.showTab('jobs');
  assert.equal(runsView.hidden, true);
});
