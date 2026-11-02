// W7 perf: the lock-band loop resolves the plant clock and the frozen far edge once per pass, with unchanged results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

const PLANT = 'W7P';
const HOUR = 3600e3;
const NOW = new Date(2031, 5, 10, 12, 0, 0);

function synthTasks(frozenEnd) {
  const tasks = [];
  const mk = (id, startMs, endMs, extra = {}) => tasks.push({
    id, PLANT, MACHINE: `L${id % 7}`, user_scheduled: true,
    start_date: new Date(startMs), end_date: new Date(endMs), ...extra,
  });
  const n = NOW.getTime(), f = frozenEnd.getTime();
  let id = 0;
  for (let i = 0; i < 40; i++) {
    mk(id++, n - 60 * HOUR - i * HOUR, n - 50 * HOUR - i * HOUR);        // past, overdue
    mk(id++, n + i * HOUR / 4, n + (i + 1) * HOUR);                       // finishes inside the horizon (frozen)
    mk(id++, n - 2 * HOUR, n + (i + 1) * HOUR);                           // in progress
    mk(id++, f + (i + 1) * HOUR, f + (i + 5) * HOUR);                     // beyond the horizon
    mk(id++, f - 10 * HOUR, f + i * HOUR, { ecc_firmed: true });          // straddles the edge, SAP firm
    mk(id++, n + i * HOUR, n + (i + 2) * HOUR, { ecc_firmed: true });     // frozen and SAP firm
    mk(id++, n + i * HOUR, n + (i + 2) * HOUR, { user_scheduled: false }); // no persisted placement
  }
  // boundaries: finish == now (frozen), finish == frozenEnd (not), start == now (running), finish 1 ms around both
  mk(id++, n - HOUR, n); mk(id++, n - HOUR, n - 1); mk(id++, n - HOUR, n + 1);
  mk(id++, f - HOUR, f); mk(id++, f - HOUR, f - 1); mk(id++, f - HOUR, f + 1);
  mk(id++, n, n + HOUR); mk(id++, n + 1, n + HOUR);
  mk(id++, null, n + HOUR); mk(id++, n, null);
  for (let i = 0; i < 20; i++) tasks.push({ id: `nopl${i}`, PLANT, MACHINE: 'L1', user_scheduled: true, start_date: null, end_date: null });
  return tasks;
}

function withRig(fn) {
  const prior = { plant: Store.selectedPlant, md: Store.masterData, plantNow: Store.plantNow };
  const calls = { n: 0 };
  Store.plantNow = function () { calls.n++; return new Date(NOW.getTime()); };
  Store.setMasterData({ ...(Store.masterData || {}), plants: [{ plant: PLANT, frozen_horizon_days: 3 }] }, 'unit-test');
  Store.setSelectedPlant(PLANT, 'unit-test');
  try { return fn(calls); } finally {
    Store.plantNow = prior.plantNow;
    Store.setMasterData(prior.md, 'unit-test');
    Store.setSelectedPlant(prior.plant, 'unit-test');
  }
}

const oldBand = t => Engine.isFrozenHorizon(t, Timeline._nowFor(t)) || Engine.isInProgress(t, Timeline._nowFor(t));

test('W7: _inLockBand with the per-pass memo returns exactly the per-task result', () => withRig(() => {
  const frozenEnd = Engine.frozenHorizonEnd();
  assert.ok(frozenEnd, 'rig has a frozen window');
  const tasks = synthTasks(frozenEnd);
  assert.ok(tasks.length > 300);
  const expected = tasks.map(oldBand);
  assert.ok(expected.some(Boolean) && expected.some(b => !b));
  Timeline._clockMemo = new Map();
  Timeline._frozenEndMemo = { v: Engine.frozenHorizonEnd() };
  try {
    const got = tasks.map(t => Timeline._inLockBand(t));
    assert.deepEqual(got, expected);
  } finally { Timeline._clockMemo = null; Timeline._frozenEndMemo = null; }
  // outside a pass the un-memoised path still agrees
  assert.deepEqual(tasks.map(t => Timeline._inLockBand(t)), expected);
}));

test('W7: a pass resolves the plant clock and the frozen edge once, not once per task', () => withRig(calls => {
  const tasks = synthTasks(Engine.frozenHorizonEnd());
  calls.n = 0;
  tasks.map(oldBand);
  const oldCalls = calls.n;
  calls.n = 0;
  Timeline._clockMemo = new Map();
  Timeline._frozenEndMemo = { v: Engine.frozenHorizonEnd() };
  try { for (const t of tasks) Timeline._inLockBand(t); } finally { Timeline._clockMemo = null; Timeline._frozenEndMemo = null; }
  assert.ok(calls.n <= 2, `plantNow called ${calls.n} times in one pass`);
  assert.ok(oldCalls > tasks.length, `old path called it ${oldCalls} times`);
}));

test('S1-5: firmed:change writes one batched patch call; a split order falls back to one coalesced rebuild', () => {
  const saved = { p: Timeline._itemPatchFor, w: Timeline._writePatches, m: Timeline.hasMultipleItemsForTask, s: Timeline._scheduleRebuild };
  const writes = []; let rebuilds = 0;
  Timeline._itemPatchFor = id => ({ id });
  Timeline._writePatches = patches => writes.push(patches.map(x => x.id));
  Timeline.hasMultipleItemsForTask = id => id === 'split';
  Timeline._scheduleRebuild = () => { rebuilds++; };
  try {
    Timeline._onStore({ type: 'firmed:change', ids: ['a', 'b', 'c'], source: 'table' });
    assert.deepEqual(writes, [['a', 'b', 'c']]);
    assert.equal(rebuilds, 0);
    writes.length = 0;
    Timeline._onStore({ type: 'firmed:change', ids: ['a', 'split', 'c'], source: 'table' });
    assert.deepEqual(writes, [['a', 'c']]);
    assert.equal(rebuilds, 1);
  } finally {
    Timeline._itemPatchFor = saved.p; Timeline._writePatches = saved.w;
    Timeline.hasMultipleItemsForTask = saved.m; Timeline._scheduleRebuild = saved.s;
  }
});

test('Task 2: a direct rebuild overtakes an already queued coalesced rebuild', () => {
  const savedRaf = Timeline._rebuildRaf, savedCancel = globalThis.cancelAnimationFrame, savedPass = Timeline._rebuildPass;
  const cancelled = []; let passes = 0;
  globalThis.cancelAnimationFrame = id => cancelled.push(id);
  Timeline._rebuildPass = () => { passes++; };
  Timeline._rebuildRaf = 42;
  try {
    Timeline.rebuild();
    assert.deepEqual(cancelled, [42]);
    assert.equal(Timeline._rebuildRaf, null);
    assert.equal(passes, 1);
  } finally {
    Timeline._rebuildRaf = savedRaf; Timeline._rebuildPass = savedPass;
    if (savedCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = savedCancel;
  }
});
