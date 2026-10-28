// Tests for frontend/labor/labor-planning.mjs.
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaborPlanning } from '../../../frontend/labor/labor-planning.mjs';

test('LaborPlanning exposes its documented public API', () => {
  assert.equal(typeof LaborPlanning.init, 'function');
  assert.equal(typeof LaborPlanning.render, 'function');
  assert.equal(typeof LaborPlanning.onGroupToggle, 'function');
  assert.equal(typeof LaborPlanning.clearGroupFilter, 'function');
  assert.equal(typeof LaborPlanning.prevHorizon, 'function');
  assert.equal(typeof LaborPlanning.nextHorizon, 'function');
  assert.equal(typeof LaborPlanning.setSpan, 'function');
});

test('Labor attribute selectors are CSS-escaped, never hand-escaped with &quot; (#47)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../frontend/labor/labor-planning.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /&quot;'\)\}/, 'a name containing a quote must not be turned into &quot; inside a selector');
  assert.match(source, /_cssEsc\(grp\)/);
});

test('Aggregate grid writes the RAW week key into data-period, even where CSS.escape escapes a leading digit (senior audit #1)', async () => {
  // Spec-correct CSS.escape: a leading digit becomes `\3X ` (what browsers do).
  const BS = String.fromCharCode(92);
  const specEscape = (s) => String(s).replace(/^[0-9]/, (d) => BS + '3' + d + ' ').replace(/["\\]/g, (c) => BS + c);
  const saved = { window: globalThis.window, CSS: globalThis.CSS, document: globalThis.document, fetch: globalThis.fetch, flatpickr: globalThis.flatpickr };
  globalThis.window ||= {};
  globalThis.flatpickr = () => ({ setDate() {} });
  globalThis.CSS = { escape: specEscape };
  let html = '';
  const grid = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const noop = () => {};
  globalThis.document = { getElementById: (id) => (id === 'labor-grid' ? grid : null), addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rows: [] }) });
  try {
    const { Store } = await import('../../../frontend/platform/store.mjs');
    Store.setMasterData({ plants: [{ plant: 'P1', subnetwork: 'S' }], lines: [{ plant: 'P1', machine: 'L1', wc_group: 'G1' }] });
    Store.setSelectedPlant('P1');
    await LaborPlanning.render();
    const periods = [...html.matchAll(/data-period="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(periods.length > 0, 'the aggregate grid rendered cells');
    for (const p of periods) {
      assert.match(p, /^\d{4}-W\d{2}$/, `data-period must be the raw ISO week key, got ${JSON.stringify(p)}`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

test('group 8 (labor downstream): the KPI strip reads the proportionally re-bucketed utilization hours, so a bar crossing midnight no longer piles on its start day', async () => {
  const saved = { window: globalThis.window, CSS: globalThis.CSS, document: globalThis.document, fetch: globalThis.fetch, flatpickr: globalThis.flatpickr,
    NimbusComputeCore: globalThis.NimbusComputeCore };
  // Utilization delegates to the UMD compute core through this ambient global (a real browser loads it first).
  globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || (await import('node:module')).createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
  globalThis.window ||= {};
  globalThis.flatpickr = () => ({ setDate() {} });
  globalThis.CSS = { escape: (s) => String(s) };
  const html = { grid: '', kpi: '' };
  const grid = {
    set innerHTML(v) { html.grid = v; }, get innerHTML() { return html.grid; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const kpi = { set innerHTML(v) { html.kpi = v; }, get innerHTML() { return html.kpi; } };
  const noop = () => {};
  globalThis.document = {
    getElementById: (id) => (id === 'labor-grid' ? grid : id === 'labor-kpi-strip' ? kpi : null),
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rows: [] }) });
  const { Store } = await import('../../../frontend/platform/store.mjs');
  const priorMaster = Store.masterData;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const line = 'LB-G8-L1';
  const wh = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [8, 18]]));   // a 10 h (600 min) working day
  const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (dayOffset, hour) => { const d = new Date(monday); d.setDate(d.getDate() + dayOffset); d.setHours(hour, 0, 0, 0); return d; };
  const strip = () => ({
    required: Number((html.kpi.match(/labor.kpi_required<\/span>\s*<span class="lp-kpi-val">(\d+)h/) || [])[1]),
    shortfalls: Number((html.kpi.match(/labor.kpi_shortfalls<\/span>\s*<span class="lp-kpi-val">(\d+)</) || [])[1]),
  });
  try {
    Store.setMasterData({ plants: [{ plant: 'LB-G8', subnetwork: 'S' }], lines: [{ plant: 'LB-G8', machine: line, wc_group: 'G1' }] }, 'unit-test');
    Store.setCalendar(line, wh, 'unit-test');
    Store.setSelectedPlant('LB-G8', 'unit-test');
    const task = (id, run, s, e) => ({ id, PLANT: 'LB-G8', MACHINE: line, RUN_TIME: run, start_date: s, end_date: e });

    // 12 h from Wed 17:00 to Thu 13:00: 2 h on Wednesday and 10 h on Thursday (each inside its 10 h window): no shortfall.
    Store.setTasks([task('g8-a', 12, at(2, 17), at(3, 13))], 'unit-test');
    await LaborPlanning.render();
    assert.deepEqual(strip(), { required: 12, shortfalls: 0 }, 'the 12 h are split 2 h / 10 h across the two days, not 12 h on the start day');

    // 14 h from Wed 22:00 to Fri 00:00: only Thursday has working time, so Thursday carries all 14 h against a 10 h window.
    Store.setTasks([task('g8-b', 14, at(2, 22), at(4, 0))], 'unit-test');
    await LaborPlanning.render();
    assert.deepEqual(strip(), { required: 14, shortfalls: 1 }, 'one line-day cell (Thursday) is short');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setMasterData(priorMaster, 'unit-test');
    delete Store.calendars[line];
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

// ---- Workload relief: Labor reads the utilization matrix off the main thread -------------------------------------
async function laborAsyncHarness() {
  const saved = { window: globalThis.window, CSS: globalThis.CSS, document: globalThis.document, fetch: globalThis.fetch, flatpickr: globalThis.flatpickr,
    NimbusComputeCore: globalThis.NimbusComputeCore };
  globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || (await import('node:module')).createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
  globalThis.window ||= {};
  globalThis.flatpickr = () => ({ setDate() {} });
  globalThis.CSS = { escape: (s) => String(s) };
  const html = { grid: '', kpi: '' };
  const grid = {
    set innerHTML(v) { html.grid = v; }, get innerHTML() { return html.grid; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const kpi = { set innerHTML(v) { html.kpi = v; }, get innerHTML() { return html.kpi; } };
  const noop = () => {};
  globalThis.document = {
    getElementById: (id) => (id === 'labor-grid' ? grid : id === 'labor-kpi-strip' ? kpi : null),
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rows: [] }) });
  const { Store } = await import('../../../frontend/platform/store.mjs');
  const { Util } = await import('../../../frontend/platform/foundation.mjs');
  const { Compute, Utilization } = await import('../../../frontend/insights/services.mjs');
  const prior = { master: Store.masterData, plant: Store.selectedPlant, tasks: structuredClone(Store.tasksArr),
    available: Compute.available, utilization: Compute.utilization };
  Store.setMasterData({ plants: [{ plant: 'LB-AS', subnetwork: 'S' }], lines: [{ plant: 'LB-AS', machine: 'LB-AS-L1', wc_group: 'G1' }] }, 'unit-test');
  Store.setTasks([], 'unit-test');
  Store.setSelectedPlant('LB-AS', 'unit-test');
  Utilization._cacheClear();
  const calls = [];
  Compute.available = () => true;
  return {
    html, Store, Util, Compute, calls,
    stub(handler) { Compute.utilization = (...a) => { calls.push(a); return handler(...a); }; },
    async waitForCall() { for (let i = 0; i < 200 && !calls.length; i++) await new Promise((r) => setImmediate(r)); assert.ok(calls.length, 'Labor asked the worker for a matrix'); },
    restore() {
      Compute.available = prior.available; Compute.utilization = prior.utilization;
      Utilization._cacheClear();
      Store.setTasks(prior.tasks, 'unit-test'); Store.setSelectedPlant(prior.plant, 'unit-test'); Store.setMasterData(prior.master, 'unit-test');
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    },
  };
}

test('Labor render shows the loading text while the matrix is computed off-thread, then paints', async () => {
  const h = await laborAsyncHarness();
  let release;
  h.stub(() => new Promise((resolve) => { release = () => resolve({ matrix: {} }); }));
  try {
    const p = LaborPlanning.render();
    await h.waitForCall();
    assert.ok(h.html.grid.includes(h.Util.t('labor.loading')), 'the loading placeholder is up while the worker runs');
    release();
    await p;
    assert.ok(!h.html.grid.includes(h.Util.t('labor.loading')), 'the grid replaced the placeholder');
    assert.ok(h.html.kpi.length > 0, 'the KPI strip painted');
  } finally { h.restore(); }
});

test('Labor render discards a stale pass: a plant switch while the matrix computes never paints the old plant', async () => {
  const h = await laborAsyncHarness();
  let release;
  h.stub(() => new Promise((resolve) => { release = () => resolve({ matrix: {} }); }));
  try {
    const first = LaborPlanning.render();
    await h.waitForCall();
    h.Store.setSelectedPlant(null, 'unit-test');
    await LaborPlanning.render();   // the no-plant render bumps the generation
    const emptyGrid = h.html.grid;
    assert.ok(emptyGrid.includes(h.Util.t('ui.select_plant_labor')));
    release();
    await first;
    assert.equal(h.html.grid, emptyGrid, 'the superseded render left the grid alone');
  } finally { h.restore(); }
});

test('Labor render falls back to the synchronous matrix when the worker rejects', async () => {
  const h = await laborAsyncHarness();
  h.stub(() => Promise.reject(new Error('worker error')));
  try {
    await LaborPlanning.render();
    assert.ok(h.calls.length >= 1);
    assert.ok(!h.html.grid.includes(h.Util.t('labor.loading')));
    assert.ok(h.html.kpi.length > 0, 'the KPI strip still painted from the synchronous compute');
  } finally { h.restore(); }
});
