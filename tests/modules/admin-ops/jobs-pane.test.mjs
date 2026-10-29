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
    assert.equal([...view.innerHTML.matchAll(/<optgroup label=/g)].length, 2, 'Optimization and Reports');
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
