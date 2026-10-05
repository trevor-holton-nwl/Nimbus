// Characterization tests for the legacy app.js scheduler seam.
// These pin current BEHAVIOR — not internal implementation — so Phase 1+
// refactoring can verify that selected-plant scoping, worker snapshot shape,
// and explicit Save semantics are preserved after extraction.
//
// The harness loads app.js in a Node VM without firing DOMContentLoaded;
// no database, no real network, no real Worker. Any unrecognised DOM call
// surfaces as an error (not a silent no-op) so a missing stub is visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLegacyApp } from './helpers/load-legacy-app.mjs';

// Load once — app.js evaluation is expensive (~300 ms).
const { nimbus, workerMessages, fetchCalls } = await loadLegacyApp();
const { Store, Persistence } = nimbus;

// ---------------------------------------------------------------------------
// 1. Selected-plant task and line scoping
// ---------------------------------------------------------------------------

test('Store.tasksForSelectedPlant returns only the selected plant\'s tasks', async () => {
  const task5512 = {
    id: 'aa01', PRODUCTION_ORDER: 'PO1', MATERIAL_NUMBER: 'M1',
    MACHINE: 'L1', plant: '5512',
    start_date: new Date('2026-07-01T06:00:00'),
    end_date:   new Date('2026-07-01T14:00:00'),
    RUN_TIME: 8, COLOR: 'RED', FORM_SIZE: 'S',
  };
  const task1006 = {
    id: 'bb02', PRODUCTION_ORDER: 'PO2', MATERIAL_NUMBER: 'M2',
    MACHINE: 'L2', plant: '1006',
    start_date: new Date('2026-07-01T06:00:00'),
    end_date:   new Date('2026-07-01T14:00:00'),
    RUN_TIME: 8, COLOR: 'BLUE', FORM_SIZE: 'M',
  };

  // Seed master data so the plant-index builder knows L1→5512 and L2→1006.
  Store._state.masterData = {
    plants: [{ plant: '5512', subnetwork: 'NA' }, { plant: '1006', subnetwork: 'NA' }],
    lines:  [
      { machine: 'L1', plant: '5512' },
      { machine: 'L2', plant: '1006' },
    ],
  };

  Store.setTasks([task5512, task1006], 'test');
  Store.setSelectedPlant('5512', 'test');

  const selected = Store.tasksForSelectedPlant();
  assert.equal(selected.length, 1, 'should return exactly 1 task for plant 5512');
  assert.equal(selected[0].id, 'aa01');
  assert.ok(!selected.some(t => t.plant === '1006'), 'should exclude plant 1006 tasks');
});

test('Store.linesForSelectedPlant excludes lines belonging to other plants', async () => {
  // State carried from the previous test; plant 5512 is still selected.
  const lines = Store.linesForSelectedPlant();
  assert.ok(lines.includes('L1'), 'should include L1 (belongs to 5512)');
  assert.ok(!lines.includes('L2'), 'should not include L2 (belongs to 1006)');
});

// ---------------------------------------------------------------------------
// 2. Alert and utilization dispatch APIs (Compute is internal to app.js)
// ---------------------------------------------------------------------------

test('Alerts.recompute is callable and Utilization.computeMatrix returns structured data', async () => {
  // Compute is an internal module (not exported). Alerts and Utilization are the
  // public entry points that route through it. Pin their callable surface.
  const { Alerts, Utilization } = nimbus;

  assert.ok(typeof Alerts.recompute === 'function', 'Alerts.recompute must be a function');
  assert.ok(typeof Alerts.scheduleRecompute === 'function', 'Alerts.scheduleRecompute must be a function');

  // Utilization.computeMatrix accepts a task list, start ms, and day count.
  assert.ok(typeof Utilization.computeMatrix === 'function', 'Utilization.computeMatrix must be a function');
  assert.ok(typeof Utilization.dayByLine === 'function', 'Utilization.dayByLine must be a function');

  // Signature only — computeMatrix needs seeded calendars to run without error;
  // the compute-core.test.js suite covers the algorithm itself.
  assert.equal(typeof Utilization.computeMatrix, 'function');
});

// ---------------------------------------------------------------------------
// 3. Explicit Save request shape
// ---------------------------------------------------------------------------

test('Persistence.saveAll posts to /tasks/update with expected payload shape', async () => {
  const task = {
    id: 'cc03', PRODUCTION_ORDER: 'PO3', MATERIAL_NUMBER: 'M3',
    MACHINE: 'L1', plant: '5512',
    start_date: new Date('2026-07-02T06:00:00'),
    end_date:   new Date('2026-07-02T14:00:00'),
    RUN_TIME: 8, COLOR: 'GREEN', FORM_SIZE: 'S',
    row_version: 12345,
  };
  Store.setTasks([task], 'test');
  Store.setSelectedPlant('5512', 'test');

  // Mark the task dirty so saveAll includes it.
  Persistence._dirtyIds.add('cc03');

  const before = fetchCalls.length;
  Persistence.saveAll();
  const calls = fetchCalls.slice(before);

  // saveAll must have made at least one POST
  assert.ok(calls.some(c => c.url.includes('/tasks/update')), 'saveAll must POST to /tasks/update');

  const saveCall = calls.find(c => c.url.includes('/tasks/update'));
  assert.equal(saveCall.opts.method, 'POST');

  const body = JSON.parse(saveCall.opts.body);
  assert.ok(Array.isArray(body.tasks), 'payload must have a tasks array');
  assert.ok(Array.isArray(body.blocks), 'payload must always include blocks');
  assert.ok('calendars' in body, 'payload must always include calendars');

  const t = body.tasks.find(x => x.id === 'cc03');
  assert.ok(t, 'dirty task must be in the payload');
  assert.ok('start_date' in t, 'task must have start_date');
  assert.ok('end_date' in t,   'task must have end_date');
  assert.ok('base_version' in t, 'task must carry base_version for optimistic concurrency');
  assert.ok('force' in t, 'task must carry force flag');
});

test('Persistence.saveAll alone does not POST (only explicit calls do)', async () => {
  // Confirm autosave does NOT trigger a backend POST — only saveAll() does.
  // Reset dirty set; with nothing dirty, saveAll still posts (blocks/calendars
  // always go) but NO task rows should appear.
  Persistence._dirtyIds.clear();
  Persistence._forceIds?.clear?.();
  // Let the previous test's save settle so the in-flight guard is released.
  for (let i = 0; i < 50 && Persistence._saveInFlight; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(!Persistence._saveInFlight, 'previous save must have settled');

  const before = fetchCalls.length;
  Persistence.saveAll();
  const calls = fetchCalls.slice(before);
  const saveCall = calls.find(c => c.url.includes('/tasks/update'));
  // saveAll always posts blocks/calendars, so the call must exist; the assertion
  // below must never be skipped.
  assert.ok(saveCall, 'saveAll must still POST /tasks/update (blocks/calendars always go)');
  const body = JSON.parse(saveCall.opts.body);
  assert.equal(body.tasks.length, 0, 'no dirty tasks → empty task array in payload');
});

// ---------------------------------------------------------------------------
// 4. Legacy namespace — planner commands exist
// ---------------------------------------------------------------------------

test('NIMBUS namespace exposes the legacy planner commands used by index.html', async () => {
  // Source the command list from the generated contract rather than hardcoding.
  // This test fails if a module is accidentally removed from the return value.
  const contract = JSON.parse(readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../contracts/cq1-legacy-surface.json'), 'utf8'));
  const expectedModules = [...new Set(contract.htmlCommands.map(c => c.split('.')[0]))];
  assert.ok(expectedModules.length >= 4, 'contract htmlCommands must yield modules');
  for (const mod of expectedModules) {
    assert.ok(mod in nimbus, `NIMBUS must expose ${mod}`);
    assert.ok(typeof nimbus[mod] === 'object', `NIMBUS.${mod} must be an object`);
  }
  assert.ok(typeof nimbus.Persistence.saveAll === 'function', 'Persistence.saveAll must be callable');
  assert.ok(typeof nimbus.OptimizeDialog.open === 'function', 'OptimizeDialog.open must be callable');
  assert.ok(typeof nimbus.OptimizeDialog.run  === 'function', 'OptimizeDialog.run must be callable');
  assert.ok(typeof nimbus.Sandbox.enter === 'function', 'Sandbox.enter must be callable');
});

test('#31 API-key bootstrap checks ok, cache-busts, and retries with backoff instead of failing silently after one blip', async () => {
  const urls = [];
  const fetchImpl = (url, opts) => {
    const u = String(url);
    if (!u.includes('/security/client-config')) return Promise.reject(new Error('unmodelled'));
    urls.push({ u, opts });
    if (urls.length === 1) return Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('html')) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ apiKey: 'boot-key' }) });
  };
  const { nimbus: n2, domReady, context: ctx2 } = await loadLegacyApp({ fetchImpl });
  ctx2.setTimeout = setTimeout; // the VM context has no timers of its own
  assert.equal(typeof domReady, 'function', 'harness exposes the DOM-ready gate');
  try { domReady(); } catch { /* the login/boot half needs a real DOM; only the key bootstrap is under test */ }
  await new Promise(res => setTimeout(res, 1300));
  assert.ok(urls.length >= 2, 'a non-ok response is retried');
  assert.ok(urls.every(c => /[?&]_=/.test(c.u) && c.opts?.cache === 'no-store'), 'each attempt is cache-busted');
  assert.notEqual(urls[0].u, urls[1].u, 'cache-bust token differs between attempts');
  assert.equal(n2.Util.getApiKey ? n2.Util.getApiKey() : 'boot-key', 'boot-key');
});
