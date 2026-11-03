// Wave 4 Gantt fixes: plant clock windows, one line-filter predicate, fit-to-visible, minimap rules, bounds cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  Timeline, TimelineNav, Interaction, lineFilterIsActive, lineFilterPredicate, plantViewWindow, plantNowWindow, fitWindowFor,
} from '../../../frontend/scheduling/gantt.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

function withDoc(fn) {
  const prior = globalThis.document;
  globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
}
function withNimbus(sel, fn) {
  const prior = globalThis.NIMBUS;
  globalThis.NIMBUS = { GanttFilter: { _selectedLines: sel } };
  try { return fn(); } finally { if (prior === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = prior; }
}

test('lineFilterPredicate: everything without a filter, only selected lines with one', () => {
  assert.equal(lineFilterIsActive(null), false);
  assert.equal(lineFilterIsActive(new Set()), false);
  assert.equal(lineFilterPredicate(new Set())('M1'), true);
  const p = lineFilterPredicate(new Set(['M1']));
  assert.equal(p('M1'), true);
  assert.equal(p('M2'), false);
});

test('S1-1: _itemPatchFor returns null for an order on a line the filter hides, a patch otherwise', () => {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'test');
  Store.setTasks([
    { id: 'w4-a', MACHINE: 'W4-L1', start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
    { id: 'w4-b', MACHINE: 'W4-L2', start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00') },
  ], 'test');
  try {
    withNimbus(new Set(['W4-L1']), () => {
      assert.ok(Timeline._itemPatchFor('w4-a'));
      assert.equal(Timeline._itemPatchFor('w4-b'), null);
    });
    withNimbus(new Set(), () => assert.ok(Timeline._itemPatchFor('w4-b')));
  } finally { Store.setTasks([], 'test'); Store.setSelectedPlant(priorPlant, 'test'); }
});

test('S2-1: plantViewWindow anchors on local midnight of the given instant; hour/day/week span 1/3/7 days', () => {
  const now = new Date(2026, 8, 21, 15, 30).getTime();
  const mid = new Date(2026, 8, 21).getTime();
  assert.deepEqual(plantViewWindow('hour', now), { startMs: mid, endMs: new Date(2026, 8, 22).getTime() });
  assert.deepEqual(plantViewWindow('day', now), { startMs: mid, endMs: new Date(2026, 8, 24).getTime() });
  assert.deepEqual(plantViewWindow('week', now), { startMs: mid, endMs: new Date(2026, 8, 28).getTime() });
  assert.deepEqual(plantViewWindow('month', now), { startMs: mid, endMs: new Date(2026, 9, 21).getTime() });
  assert.deepEqual(plantNowWindow(now), { startMs: now - 4 * 3600e3, endMs: now + 4 * 3600e3 });
});

test('S2-1: gotoNow and setView centre on the plant clock, not the browser clock', () => {
  const prior = { tl: Timeline._tl, now: Timeline._plantNow };
  const plantInstant = new Date(2031, 2, 5, 10, 0);   // far from the real clock
  const calls = [];
  Timeline._tl = { setWindow: (s, e) => calls.push([s.getTime(), e.getTime()]) };
  Timeline._plantNow = () => new Date(plantInstant.getTime());
  try {
    withDoc(() => {
      Timeline.gotoNow();
      assert.deepEqual(calls[0], [plantInstant.getTime() - 4 * 3600e3, plantInstant.getTime() + 4 * 3600e3]);
      Timeline.setView('day');
      assert.equal(calls[1][0], new Date(2031, 2, 5).getTime());
    });
  } finally { Timeline._tl = prior.tl; Timeline._plantNow = prior.now; }
});

test('S2-6: fitWindowFor spans only the given orders with 5% padding; empty gives null', () => {
  assert.equal(fitWindowFor([], 3600e3), null);
  const w = fitWindowFor([{ startMs: 1000, endMs: 2000 }, { startMs: 5000, endMs: 11000 }], 3600e3);
  assert.deepEqual(w, { startMs: 1000 - 500, endMs: 11000 + 500 });
  const point = fitWindowFor([{ startMs: 100, endMs: 100 }], 7);
  assert.deepEqual(point, { startMs: 93, endMs: 107 });
});

test('S2-6: zoomToFit ignores orders on lines the filter hides', () => {
  const priorPlant = Store.selectedPlant, priorTl = Timeline._tl, origTasks = Store.tasksForSelectedPlant;
  Store.setSelectedPlant('ZPLANT', 'test');
  const d = (h) => new Date(2026, 8, 21, h);
  Store.tasksForSelectedPlant = () => [
    { id: 'z-a', MACHINE: 'Z1', start_date: d(8), end_date: d(10) },
    { id: 'z-b', MACHINE: 'Z2', start_date: new Date(2026, 9, 30), end_date: new Date(2026, 9, 31) },
  ];
  const calls = [];
  Timeline._tl = { setWindow: (s, e) => calls.push([s.getTime(), e.getTime()]) };
  try {
    withDoc(() => withNimbus(new Set(['Z1']), () => Timeline.zoomToFit()));
    assert.ok(calls[0][1] < new Date(2026, 8, 22).getTime(), 'window ends near the visible order, not October');
    withDoc(() => withNimbus(new Set(), () => Timeline.zoomToFit()));
    assert.ok(calls[1][1] > new Date(2026, 9, 1).getTime(), 'no filter: spans both orders');
  } finally { Timeline._tl = priorTl; Store.tasksForSelectedPlant = origTasks; Store.setSelectedPlant(priorPlant, 'test'); }
});

test('S2-5: _applyTimeBounds writes setOptions once, then skips while min/max are unchanged', () => {
  const priorTl = Timeline._tl, priorKey = Timeline._boundsKey, priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'test');
  Store.setTasks([], 'test');
  let n = 0;
  Timeline._tl = { setOptions: () => { n++; } };
  Timeline._boundsKey = '';
  try {
    Timeline._applyTimeBounds();
    Timeline._applyTimeBounds();
    assert.equal(n, 1);
  } finally { Timeline._tl = priorTl; Timeline._boundsKey = priorKey; Store.setSelectedPlant(priorPlant, 'test'); }
});

test('S3-1: minimap alert marks skip needs_planning alerts', () => {
  const priorItems = Timeline._items, priorTl = Timeline._tl, priorVis = Timeline._visibleLines, priorAlerts = Store.alerts, priorTheme = TimelineNav._readTheme;
  TimelineNav._readTheme = () => ({});
  const day = new Date(); day.setDate(day.getDate() + 1);   // inside the minimap's today..today+14d range
  Timeline._tl = null;
  Timeline._visibleLines = () => ['N1'];
  Timeline._items = { get: () => [] };
  try {
    Store.setAlerts([{ id: 'a1', type: 'needs_planning', sev: 'warn', line: 'N1', time: day }], 'test');
    let model = TimelineNav._collect();
    assert.equal(model.alertByDay.size, 0);
    Store.setAlerts([{ id: 'a2', type: 'overload', sev: 'warn', line: 'N1', time: day }], 'test');
    model = TimelineNav._collect();
    assert.equal(model.alertByDay.size, 1);
  } finally { Timeline._items = priorItems; Timeline._tl = priorTl; Timeline._visibleLines = priorVis; Store.setAlerts(priorAlerts, 'test'); TimelineNav._readTheme = priorTheme; }
});

test('S3-2: minimap now is the plant clock', () => {
  const priorItems = Timeline._items, priorTl = Timeline._tl, priorVis = Timeline._visibleLines, priorNow = Timeline._plantNow, priorTheme = TimelineNav._readTheme;
  TimelineNav._readTheme = () => ({});
  const inst = new Date(2033, 0, 10, 12);
  Timeline._tl = null; Timeline._visibleLines = () => []; Timeline._items = { get: () => [] };
  Timeline._plantNow = () => new Date(inst.getTime());
  try { assert.equal(TimelineNav._collect().nowMs, inst.getTime()); }
  finally { Timeline._items = priorItems; Timeline._tl = priorTl; Timeline._visibleLines = priorVis; Timeline._plantNow = priorNow; TimelineNav._readTheme = priorTheme; }
});

test('S3-9: Interaction.install stops retrying after the bounded count', () => {
  const priorTl = Timeline._tl, priorInstalled = Interaction._installed, priorRetries = Interaction._installRetries;
  const priorSet = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = () => { scheduled++; return 0; };
  Timeline._tl = null; Interaction._installed = false; Interaction._installRetries = 0;
  try {
    for (let i = 0; i < 150; i++) Interaction.install();
    assert.ok(Interaction._installRetries > 100, 'calls past the 100th give up');
    assert.ok(scheduled >= 100 && scheduled <= 102, 'about 100 retries are scheduled, then none');
  } finally {
    globalThis.setTimeout = priorSet; Timeline._tl = priorTl; Interaction._installed = priorInstalled; Interaction._installRetries = priorRetries;
  }
});
