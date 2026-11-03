// A13: with the worker up, Hierarchy.render never runs the synchronous Utilization.computeMatrix. It reads the
// shared cache, else keeps the last matrix of the same plant and window and repaints when
// computeMatrixAsync resolves.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Hierarchy } from '../../../frontend/scheduling/gantt.mjs';
import { Utilization, Compute } from '../../../frontend/insights/services.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

globalThis.window = globalThis.window || {};   // Util.t reads window.__NIMBUS_LOCALES
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

function fixture(t) {
  const now = new Date('2026-10-19T09:00:00');
  const cell = (s) => ({ scheduled: s, capacity: 16, effectiveCapacity: 16, pct: s / 16 });
  const matrix = { 'L-1': { '2026-10-19': cell(8) } };
  const task = { id: 'a', ORDER: 'a', MACHINE: 'L-1', start_date: new Date('2026-10-19T10:00:00'), end_date: new Date('2026-10-19T12:00:00') };
  const prior = {
    key: Hierarchy._dayKey, vl: Hierarchy._vl, wired: Hierarchy._wired, clock: Util.plantClock,
    compute: Utilization.computeMatrix, computeAsync: Utilization.computeMatrixAsync, entries: Utilization._cacheEntries,
    avail: Compute.available, scoped: Store.tasksForSelectedPlant, lines: Store.linesForSelectedPlant,
    plant: Store._state.selectedPlant, getEl: globalThis.document?.getElementById, pref: Store.pref,
    sched: Hierarchy._scheduleRender, m: Hierarchy._matrix, mk: Hierarchy._matrixKey, mp: Hierarchy._matrixPending,
  };
  const shown = [];
  const calls = { sync: 0, async: 0, schedule: 0 };
  Util.plantClock = () => now;
  Compute.available = () => true;
  Utilization.computeMatrix = () => { calls.sync += 1; return {}; };
  Utilization._cacheEntries = () => [];
  Store.tasksForSelectedPlant = () => [task]; Store.linesForSelectedPlant = () => ['L-1'];
  Store._state.selectedPlant = '5512'; Store.pref = () => [];
  Hierarchy._vl = { update: (items) => shown.push(items), destroy() {} };
  Hierarchy._scheduleRender = () => { calls.schedule += 1; };
  Hierarchy._wired = true; Hierarchy._dayKey = null; Hierarchy._matrix = null; Hierarchy._matrixKey = null; Hierarchy._matrixPending = null;
  const label = { textContent: '', title: '' };
  globalThis.document = globalThis.document ?? {};
  globalThis.document.getElementById = (id) => (id === 'hierarchy' ? { addEventListener() {} } : id === 'hier-day-label' ? label : null);
  t.after(() => {
    Hierarchy._dayKey = prior.key; Hierarchy._vl = prior.vl; Hierarchy._wired = prior.wired; Util.plantClock = prior.clock;
    Utilization.computeMatrix = prior.compute; Utilization.computeMatrixAsync = prior.computeAsync; Utilization._cacheEntries = prior.entries;
    Compute.available = prior.avail; Store.tasksForSelectedPlant = prior.scoped; Store.linesForSelectedPlant = prior.lines;
    Store._state.selectedPlant = prior.plant; if (prior.getEl) globalThis.document.getElementById = prior.getEl; Store.pref = prior.pref;
    Hierarchy._scheduleRender = prior.sched; Hierarchy._matrix = prior.m; Hierarchy._matrixKey = prior.mk; Hierarchy._matrixPending = prior.mp;
  });
  return { now, matrix, shown, calls };
}

test('cache miss with the worker up: render paints a dash chip, computes async once, then repaints with the matrix', async (t) => {
  const { matrix, shown, calls } = fixture(t);
  let resolveIt;
  Utilization.computeMatrixAsync = () => { calls.async += 1; return new Promise((r) => { resolveIt = r; }); };
  Hierarchy.render();
  Hierarchy.render();                                   // a second render while pending must not queue another request
  assert.equal(calls.sync, 0, 'no synchronous matrix compute');
  assert.equal(calls.async, 1, 'one async request for the same plant, window and data revision');
  assert.equal(shown.at(-1)[0].pct, null, 'no matrix yet: dash chip');
  resolveIt(matrix);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.schedule, 1, 'a repaint is scheduled when the matrix lands');
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 50, 'the resolved matrix drives the chip');
  assert.equal(calls.async, 1, 'no further request once the key matches');
  assert.equal(calls.sync, 0);
});

test('a cached entry is used synchronously (no async request, no sync compute)', (t) => {
  const { matrix, shown, calls } = fixture(t);
  Utilization.computeMatrixAsync = () => { calls.async += 1; return new Promise(() => {}); };
  Utilization._cacheEntries = () => [{ plant: '5512', startMs: Util.startOfDay(new Date('2026-10-19T09:00:00')).getTime(), days: 7, dataRev: Store.dataRev(), matrix }];
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 50);
  assert.equal(calls.async + calls.sync, 0);
});

test('a data revision change keeps showing the last matrix of the same plant while the fresh one is computed', async (t) => {
  const { matrix, shown, calls } = fixture(t);
  Utilization.computeMatrixAsync = () => { calls.async += 1; return Promise.resolve(matrix); };
  Hierarchy.render();
  await new Promise((r) => setImmediate(r));
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 50);
  Store.emit({ type: 'tasks:bulk', source: 'unit-test' });          // bumps dataRev
  Utilization.computeMatrixAsync = () => { calls.async += 1; return new Promise(() => {}); };
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, 50, 'stale-but-same-plant matrix beats a blank chip');
  assert.equal(calls.sync, 0);
});

test('a plant switch never shows the previous plant matrix', async (t) => {
  const { matrix, shown, calls } = fixture(t);
  Utilization.computeMatrixAsync = () => Promise.resolve(matrix);
  Hierarchy.render();
  await new Promise((r) => setImmediate(r));
  Store._state.selectedPlant = '1006';
  Utilization.computeMatrixAsync = () => { calls.async += 1; return new Promise(() => {}); };
  Hierarchy.render();
  assert.equal(shown.at(-1)[0].pct, null);
  assert.equal(calls.async, 1);
});

test('a plant switch while the worker runs drops the late result', async (t) => {
  const { matrix, calls } = fixture(t);
  let resolveIt;
  Utilization.computeMatrixAsync = () => new Promise((r) => { resolveIt = r; });
  Hierarchy.render();
  Store._state.selectedPlant = '1006';
  resolveIt(matrix);
  await new Promise((r) => setImmediate(r));
  assert.equal(Hierarchy._matrix, null, 'late matrix for another plant is discarded');
  assert.equal(calls.schedule, 0);
});
