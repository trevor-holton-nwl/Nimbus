// Wave 3 of PV - Machine eligibility: the Gantt drop rule (keep / switch / choose / reject), the production-version
// chooser's capture + re-apply, the multi-drag line lock, and the drag-time row dim. Fake timeline/DataSet, no browser.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
import { Timeline, Interaction } from '../../../frontend/scheduling/gantt.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
    body: { appendChild() {} },
  };
}
const REAL_SERVER_OFFSET_MS = Store.serverOffsetMs;
afterEach(() => { Store.serverOffsetMs = REAL_SERVER_OFFSET_MS; });

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
function enablePlant(plant, routing) {
  const prior = Store.masterData;
  Store.setMasterData({ ...prior, plants: [{ plant, timezone: LOCAL_TZ, routing_runtime_enabled: routing }] }, 'test');
  Store.serverOffsetMs = new Date('2026-08-01T00:00:00').getTime() - Date.now();
  return prior;
}

const T0 = new Date('2026-09-21T08:00:00');
const T1 = new Date('2026-09-21T10:00:00');

/** Stubs every collaborator of a drop; returns the recorders and a restore(). */
function harness({ plant, routing = true, items }) {
  const saved = {
    toast: Toast.show, rebuild: Timeline._scheduleRebuild, recompute: Alerts.scheduleRecompute,
    recomputeLines: Alerts.scheduleRecomputeLines, patchFor: Engine.manualRoutingSchedulePatchFor,
    drop: Runtime.dropDecision, eligible: Runtime.eligible, choose: Modal.choose, items: Timeline._items,
    groups: Timeline._groups, locales: globalThis.window && globalThis.window.__NIMBUS_LOCALES,
  };
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'toast.pv_switched': '{{order}} now uses {{pv}} on {{machine}}.',
    'toast.multi_drag_line_locked': 'multi-drag cannot change line',
    'toast.no_routing_at_workcenter': '{{order}} has no routing at {{machine}}.',
    'toast.commit_failed': 'commit failed',
    'toast.pv_drop_stale': 'stale {{order}}',
    'ui.pv_machine_option': '{{pv}} - {{machine}}',
  } };
  const prior = enablePlant(plant, routing);
  const rec = { toasts: [], rebuilds: 0, patchCalls: [], chooseCalls: [] };
  Toast.show = (msg, type) => { rec.toasts.push({ msg, type }); };
  Timeline._scheduleRebuild = () => { rec.rebuilds++; };
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Timeline._items = { get: (i) => items[i], update: () => {} };
  Timeline._groups = null;
  Engine.manualRoutingSchedulePatchFor = (task, line, finish, opts) => {
    rec.patchCalls.push({ id: task.id, line, finish, opts });
    const pv = opts?.chosenPv;
    return { start_date: new Date(finish.getTime() - 2 * 3600000), end_date: finish, MACHINE: line,
      ...(pv != null ? { PRODUCTION_VERSION: pv, RUN_TIME: 2 } : {}) };
  };
  const restore = () => {
    Toast.show = saved.toast; Timeline._scheduleRebuild = saved.rebuild; Alerts.scheduleRecompute = saved.recompute;
    Alerts.scheduleRecomputeLines = saved.recomputeLines; Engine.manualRoutingSchedulePatchFor = saved.patchFor;
    Runtime.dropDecision = saved.drop; Runtime.eligible = saved.eligible; Modal.choose = saved.choose;
    Timeline._items = saved.items; Timeline._groups = saved.groups;
    globalThis.window.__NIMBUS_LOCALES = saved.locales;
    Selection.clear();
    Store.setTasks([], 'test');
    Store.setMasterData(prior, 'test');
  };
  return { rec, restore };
}

function oneOrder(plant, extra = {}) {
  Store.setTasks([{
    id: 'o1', PRODUCTION_ORDER: 'A-1', ORDER: 'A-1', PLANT: plant, MACHINE: 'L1', MATERIAL_NUMBER: 'MAT',
    PRODUCTION_VERSION: '0001', RUN_TIME: 2, start_date: T0, end_date: T1, ...extra,
  }], 'test');
  Selection.clear();
}

/* ---- single drag: dropDecision wiring ---------------------------------------------------------------------- */

test('single drag onto another line, decision keep: placed with the order\'s own PV, no PV toast', () => {
  const { rec, restore } = harness({ plant: 'P-PVD-KEEP', items: { o1: { start: T0, end: T1, group: 'L2' } } });
  try {
    oneOrder('P-PVD-KEEP');
    Runtime.dropDecision = () => ({ kind: 'keep' });
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(rec.patchCalls.length, 1);
    assert.equal(rec.patchCalls[0].opts.chosenPv, undefined);
    assert.equal(Store.tasks.o1.MACHINE, 'L2');
    assert.equal(rec.toasts.length, 0);
  } finally { restore(); }
});

test('single drag, decision switch: chosenPv is passed through, the PV is written with the move, one toast, one undo step', () => {
  const { rec, restore } = harness({ plant: 'P-PVD-SWITCH', items: { o1: { start: T0, end: T1, group: 'L2' } } });
  const undoBefore = UndoStack._entries.length;
  try {
    oneOrder('P-PVD-SWITCH');
    Runtime.dropDecision = () => ({ kind: 'switch', pv: '0002' });
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(rec.patchCalls[0].opts.chosenPv, '0002');
    assert.equal(Store.tasks.o1.PRODUCTION_VERSION, '0002');
    assert.equal(Store.tasks.o1.MACHINE, 'L2');
    assert.equal(rec.toasts.length, 1);
    assert.match(rec.toasts[0].msg, /A-1 now uses 0002 on L2/);
    assert.equal(UndoStack._entries.length, undoBefore + 1);
  } finally { UndoStack._entries.length = undoBefore; restore(); }
});

test('single drag, decision reject: no-routing toast, spring back, nothing written', () => {
  const { rec, restore } = harness({ plant: 'P-PVD-REJ', items: { o1: { start: T0, end: T1, group: 'L2' } } });
  try {
    oneOrder('P-PVD-REJ');
    Runtime.dropDecision = () => ({ kind: 'reject' });
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(rec.patchCalls.length, 0);
    assert.equal(Store.tasks.o1.MACHINE, 'L1');
    assert.equal(rec.rebuilds, 1);
    assert.equal(rec.toasts.length, 1);
    assert.match(rec.toasts[0].msg, /A-1.*L2/);
  } finally { restore(); }
});

test('single same-line time drag keeps the plain Runtime.eligible guard (an ineligible current pair stays blocked)', () => {
  const { rec, restore } = harness({ plant: 'P-PVD-SAME', items: { o1: { start: T0, end: new Date(T1.getTime() + 3600000), group: 'L1' } } });
  try {
    oneOrder('P-PVD-SAME');
    let dropCalled = false;
    Runtime.dropDecision = () => { dropCalled = true; return { kind: 'keep' }; };
    Runtime.eligible = () => false;
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(dropCalled, false, 'dropDecision must not be consulted for a same-line drag');
    assert.equal(rec.patchCalls.length, 0);
    assert.equal(rec.rebuilds, 1);
    assert.equal(rec.toasts.length, 1);
  } finally { restore(); }
});

/* ---- chooser ---------------------------------------------------------------------------------------------- */

function deferredChoose() {
  const calls = [];
  Modal.choose = (opts) => new Promise(resolve => { calls.push({ opts, resolve }); });
  return calls;
}
const tick = () => new Promise(r => setImmediate(r));

test('decision choose: the chooser lists the covering PVs; the pick re-applies the drop from the CAPTURED values even though the vis item was reset', async () => {
  const items = { o1: { start: T0, end: T1, group: 'L2' } };
  const { rec, restore } = harness({ plant: 'P-PVD-CHOOSE', items });
  try {
    oneOrder('P-PVD-CHOOSE');
    Runtime.dropDecision = () => ({ kind: 'choose', pvs: ['0002', '0003'] });
    const calls = deferredChoose();
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts.options, [{ value: '0002', label: '0002 - L2' }, { value: '0003', label: '0003 - L2' }]);
    assert.equal(rec.patchCalls.length, 0, 'nothing is placed before the pick');
    // A rebuild while the modal is open resets the vis item back onto the old row.
    items.o1 = { start: T0, end: T1, group: 'L1' };
    calls[0].resolve('0003');
    await tick();
    assert.equal(rec.patchCalls.length, 1);
    assert.equal(rec.patchCalls[0].line, 'L2', 'the captured target line, not the reset vis item');
    assert.equal(rec.patchCalls[0].finish.getTime(), T1.getTime());
    assert.equal(rec.patchCalls[0].opts.chosenPv, '0003');
    assert.equal(Store.tasks.o1.MACHINE, 'L2');
    assert.equal(Store.tasks.o1.PRODUCTION_VERSION, '0003');
  } finally { restore(); }
});

test('decision choose, cancel: the bar springs back (rebuild) and nothing is written', async () => {
  const { rec, restore } = harness({ plant: 'P-PVD-CANCEL', items: { o1: { start: T0, end: T1, group: 'L2' } } });
  try {
    oneOrder('P-PVD-CANCEL');
    Runtime.dropDecision = () => ({ kind: 'choose', pvs: ['0002', '0003'] });
    const calls = deferredChoose();
    Interaction._onDataSetUpdate({ items: ['o1'] });
    calls[0].resolve(null);
    await tick();
    assert.equal(rec.patchCalls.length, 0);
    assert.equal(rec.rebuilds, 1);
    assert.equal(Store.tasks.o1.MACHINE, 'L1');
  } finally { restore(); }
});

test('decision choose, the task changed while the chooser was open: abort with a toast and rebuild', async () => {
  const { rec, restore } = harness({ plant: 'P-PVD-STALE', items: { o1: { start: T0, end: T1, group: 'L2' } } });
  try {
    oneOrder('P-PVD-STALE');
    Runtime.dropDecision = () => ({ kind: 'choose', pvs: ['0002', '0003'] });
    const calls = deferredChoose();
    Interaction._onDataSetUpdate({ items: ['o1'] });
    Store.updateTask('o1', { RUN_TIME: 9 }, 'test');
    calls[0].resolve('0002');
    await tick();
    assert.equal(rec.patchCalls.length, 0);
    assert.equal(rec.rebuilds, 1);
    assert.equal(rec.toasts.length, 1);
    assert.match(rec.toasts[0].msg, /^stale A-1/);
    assert.equal(Store.tasks.o1.MACHINE, 'L1');
  } finally { restore(); }
});

test('chooser pick -> overtime confirm -> vis item reset mid-modal: the commit still applies from the capture', async () => {
  const items = { o1: { start: T0, end: T1, group: 'L2' } };
  const { rec, restore } = harness({ plant: 'P-PVD-OT', items });
  const savedConfirm = Engine.confirmOvertimePlacement;
  try {
    oneOrder('P-PVD-OT');
    Runtime.dropDecision = () => ({ kind: 'choose', pvs: ['0002', '0003'] });
    const calls = deferredChoose();
    let confirmResolve;
    Engine.confirmOvertimePlacement = () => new Promise(r => { confirmResolve = r; });
    const inner = Engine.manualRoutingSchedulePatchFor;
    Engine.manualRoutingSchedulePatchFor = (task, line, finish, opts) => {
      if (!opts?.confirmedOvertime) { Engine.lastManualRefusal = 'needs_overtime_confirm'; rec.patchCalls.push({ refused: true }); return null; }
      return inner(task, line, finish, opts);
    };
    Interaction._onDataSetUpdate({ items: ['o1'] });
    calls[0].resolve('0003');
    await tick();
    assert.equal(rec.patchCalls.length, 1, 'first attempt refused pending overtime confirmation');
    items.o1 = { start: T0, end: T1, group: 'L1' };   // a rebuild resets the vis item while the confirm modal is open
    confirmResolve(true);
    await tick();
    assert.equal(rec.patchCalls.length, 2);
    assert.equal(rec.patchCalls[1].line, 'L2', 'captured target line, not the reset vis item');
    assert.equal(rec.patchCalls[1].opts.chosenPv, '0003');
    assert.equal(rec.patchCalls[1].opts.confirmedOvertime, true);
    assert.equal(Store.tasks.o1.MACHINE, 'L2');
    assert.equal(Store.tasks.o1.PRODUCTION_VERSION, '0003');
  } finally { Engine.confirmOvertimePlacement = savedConfirm; Engine.lastManualRefusal = null; restore(); }
});

/* ---- multi-drag line lock ------------------------------------------------------------------------------------ */

for (const routing of [true, false]) {
  test(`multi-drag that moves the dragged item to another row is rejected whole with ONE toast per gesture (${routing ? 'routing' : 'non-routing'} plant); time-only multi-drag still works`, () => {
    const plant = routing ? 'P-PVD-MULTI-R' : 'P-PVD-MULTI-N';
    const items = {
      a: { start: T0, end: T1, group: 'L2' },   // dragged to another row
      b: { start: T0, end: T1, group: 'L2' },   // the companion's own update echoes the same jump
    };
    const { rec, restore } = harness({ plant, routing, items });
    try {
      Store.setTasks([
        { id: 'a', PRODUCTION_ORDER: 'A-1', PLANT: plant, MACHINE: 'L1', RUN_TIME: 2, start_date: T0, end_date: T1 },
        { id: 'b', PRODUCTION_ORDER: 'B-1', PLANT: plant, MACHINE: 'L1', RUN_TIME: 2, start_date: T0, end_date: T1 },
      ], 'test');
      Selection.set(['a', 'b']);
      Interaction._multiLockToast = null;
      Interaction._onDataSetUpdate({ items: ['a', 'b'] });
      assert.equal(Store.tasks.a.MACHINE, 'L1');
      assert.equal(Store.tasks.b.MACHINE, 'L1');
      assert.equal(rec.patchCalls.length, 0);
      assert.equal(rec.toasts.filter(t => /cannot change line/.test(t.msg)).length, 1, 'one toast for the whole gesture');
      assert.ok(rec.rebuilds >= 1);

      // Time-only multi-drag (same row, 1h later) commits.
      Interaction._multiLockToast = null;
      const later = new Date(T1.getTime() + 3600000);
      items.a = { start: new Date(T0.getTime() + 3600000), end: later, group: 'L1' };
      rec.toasts.length = 0;
      Runtime.eligible = () => true;
      Interaction._onDataSetUpdate({ items: ['a'] });
      assert.equal(Store.tasks.a.end_date.getTime(), later.getTime());
      assert.equal(Store.tasks.b.end_date.getTime(), later.getTime(), 'the companion shifted by the same delta');
      assert.equal(Store.tasks.a.MACHINE, 'L1');
      assert.equal(rec.toasts.length, 0);
    } finally { Interaction._multiLockToast = null; restore(); }
  });
}

/* ---- row dim ------------------------------------------------------------------------------------------------- */

function fakeGroups(ids) {
  const live = new Set(ids);
  const calls = [];
  return { calls, getIds: () => [...live], get: (id) => (live.has(String(id)) ? { id } : null), update: (g) => { calls.push(g); } };
}

test('Timeline._groupClassName is never falsy and keeps row-expanded when the row is also dimmed', () => {
  const prior = { expanded: Timeline._expandedLine, depth: Timeline._depthByLine, dim: Timeline._dragIneligibleLines };
  try {
    Timeline._expandedLine = 'L1';
    Timeline._depthByLine = new Map([['L1', 2], ['L2', 1]]);
    Timeline._dragIneligibleLines = null;
    assert.equal(Timeline._groupClassName('L1'), 'row-expanded');
    assert.equal(Timeline._groupClassName('L2'), 'row-flat');
    Timeline._dragIneligibleLines = new Set(['L1', 'L2', 'L3']);
    assert.equal(Timeline._groupClassName('L1'), 'row-expanded row-drag-ineligible');
    assert.equal(Timeline._groupClassName('L2'), 'row-flat row-drag-ineligible');
    for (const l of ['L1', 'L2', 'L3', '']) assert.ok(Timeline._groupClassName(l));
    // a resolved overlap (depth 1) looks flat again even when the row is sticky-expanded
    Timeline._depthByLine = new Map([['L1', 1]]);
    assert.equal(Timeline._groupClassName('L1'), 'row-flat row-drag-ineligible');
  } finally {
    Timeline._expandedLine = prior.expanded; Timeline._depthByLine = prior.depth; Timeline._dragIneligibleLines = prior.dim;
  }
});

test('dimRowsForDrag writes ONE className-only update for the ineligible rows; undimRowsForDrag reverses it', () => {
  const prior = { groups: Timeline._groups, expanded: Timeline._expandedLine, depth: Timeline._depthByLine };
  try {
    const g = fakeGroups(['L1', 'L2', 'L3']);
    Timeline._groups = g;
    Timeline._expandedLine = 'L3';
    Timeline._depthByLine = new Map([['L3', 2]]);
    Timeline.dimRowsForDrag(new Set(['L1']));
    assert.equal(g.calls.length, 1, 'one group update');
    assert.deepEqual(g.calls[0], [
      { id: 'L2', className: 'row-flat row-drag-ineligible' },
      { id: 'L3', className: 'row-expanded row-drag-ineligible' },
    ]);
    for (const patch of g.calls[0]) assert.deepEqual(Object.keys(patch).sort(), ['className', 'id'], 'className only: no content, no subgroup data');
    Timeline.undimRowsForDrag();
    assert.equal(g.calls.length, 2);
    assert.deepEqual(g.calls[1], [{ id: 'L2', className: 'row-flat' }, { id: 'L3', className: 'row-expanded' }]);
    assert.equal(Timeline._dragIneligibleLines, null);
    Timeline.undimRowsForDrag();
    assert.equal(g.calls.length, 2, 'undimming twice writes nothing');
  } finally {
    Timeline._groups = prior.groups; Timeline._expandedLine = prior.expanded; Timeline._depthByLine = prior.depth;
    Timeline._dragIneligibleLines = null; Timeline._dragDimFor = null;
  }
});

function dimHarness(plant, routing, taskExtra = {}) {
  const saved = { groups: Timeline._groups, pairs: Runtime.eligiblePairs, hasMap: Runtime.hasMapFor };
  Runtime.hasMapFor = () => true;
  const prior = enablePlant(plant, routing);
  const g = fakeGroups(['L1', 'L2', 'L3']);
  Timeline._groups = g;
  let pairCalls = 0, pairOpts = null;
  Runtime.eligiblePairs = (t, o) => { pairCalls++; pairOpts = o; return [{ pv: '0001', machine: 'L1', workcenter: 'W' }, { pv: '0002', machine: 'L2', workcenter: 'W' }]; };
  Store.setTasks([{ id: 'o1', PRODUCTION_ORDER: 'A-1', PLANT: plant, MACHINE: 'L1', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001', RUN_TIME: 2, start_date: T0, end_date: T1, ...taskExtra }], 'test');
  Selection.clear();
  return {
    g, stats: () => ({ pairCalls, pairOpts }),
    restore: () => {
      Timeline._groups = saved.groups; Runtime.eligiblePairs = saved.pairs; Runtime.hasMapFor = saved.hasMap;
      Timeline._dragIneligibleLines = null; Timeline._dragDimFor = null;
      Selection.clear(); Store.setTasks([], 'test'); Store.setMasterData(prior, 'test');
    },
  };
}

test('onMoving first frame of a single drag on a routing plant dims the rows with no eligible pair, once per drag', () => {
  const h = dimHarness('P-PVD-DIM', true);
  try {
    Timeline.onItemMoving('o1');
    assert.equal(h.g.calls.length, 1);
    assert.deepEqual(h.g.calls[0].map(p => p.id), ['L3']);
    assert.deepEqual(h.stats().pairOpts, { requireOps: true });
    Timeline.onItemMoving('o1');
    Timeline.onItemMoving('o1');
    assert.equal(h.g.calls.length, 1, 'later frames of the same drag do nothing');
    assert.equal(h.stats().pairCalls, 1);
  } finally { h.restore(); }
});

test('onMoving does not dim for a multi-selection, a distribution sub-order or a non-routing plant', () => {
  let h = dimHarness('P-PVD-DIM-N', false);
  try { Timeline.onItemMoving('o1'); assert.equal(h.g.calls.length, 0); } finally { h.restore(); }
  h = dimHarness('P-PVD-DIM-S', true, { PARENT_ORDER: '900' });
  try { Timeline.onItemMoving('o1'); assert.equal(h.g.calls.length, 0); } finally { h.restore(); }
  h = dimHarness('P-PVD-DIM-M', true);
  try {
    Store.setTasks([...Store.tasksArr, { id: 'o2', PRODUCTION_ORDER: 'B-1', PLANT: 'P-PVD-DIM-M', MACHINE: 'L2', start_date: T0, end_date: T1 }], 'test');
    Selection.set(['o1', 'o2']);
    Timeline.onItemMoving('o1');
    assert.equal(h.g.calls.length, 0);
  } finally { h.restore(); }
});

test('onMoving: no loaded rate map for the plant skips the dim; the order own row is never dimmed', () => {
  let h = dimHarness('P-PVD-DIM-NM', true);
  try {
    Runtime.hasMapFor = () => false;
    Timeline.onItemMoving('o1');
    assert.equal(h.g.calls.length, 0, 'an unloaded map would dim every row');
  } finally { h.restore(); }
  h = dimHarness('P-PVD-DIM-OWN', true);
  try {
    Runtime.eligiblePairs = () => [{ pv: '0002', machine: 'L2', workcenter: 'W' }];   // L1 (current) not in the set
    Timeline.onItemMoving('o1');
    assert.deepEqual(h.g.calls[0].map(p => p.id), ['L3'], 'L1 is the order own row and stays lit');
  } finally { h.restore(); }
});

test('the dim is cleared by a drop (top of _onDataSetUpdate, even for an ignored update), a reject, and a plant switch; a rebuild mid-drag keeps it', () => {
  const h = dimHarness('P-PVD-DIM-C', true);
  const saved = { items: Timeline._items, rebuild: Timeline._scheduleRebuild, toast: Toast.show, active: Timeline._ganttActive,
    overlay: Timeline._renderEmptyOverlay, vscroll: Timeline.resetVScroll, drop: Runtime.dropDecision, expanded: Timeline._expandedLine };
  try {
    Timeline._items = { get: () => ({ start: T0, end: T1, group: 'L1' }), update: () => {} };   // no change: ignored
    Timeline.onItemMoving('o1');
    assert.ok(Timeline._dragIneligibleLines);
    // a rebuild composes the dim into the group className (mid-drag rebuild keeps it)
    assert.match(Timeline._groupClassName('L3'), /row-drag-ineligible/);
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(Timeline._dragIneligibleLines, null, 'drop clears the dim');
    assert.equal(Timeline._dragDimFor, null);

    // reject path
    Timeline._scheduleRebuild = () => {}; Toast.show = () => {};
    Runtime.dropDecision = () => ({ kind: 'reject' });
    Timeline._items = { get: () => ({ start: T0, end: T1, group: 'L2' }), update: () => {} };
    Timeline.onItemMoving('o1');
    assert.ok(Timeline._dragIneligibleLines);
    Interaction._onDataSetUpdate({ items: ['o1'] });
    assert.equal(Timeline._dragIneligibleLines, null, 'reject clears the dim');

    // plant switch
    Timeline.onItemMoving('o1');
    assert.ok(Timeline._dragIneligibleLines);
    Timeline._ganttActive = () => false; Timeline._renderEmptyOverlay = () => {}; Timeline.resetVScroll = () => {};
    Timeline._onStore({ type: 'plant:selected', source: 'test' });
    assert.equal(Timeline._dragIneligibleLines, null, 'plant:selected clears the dim');
  } finally {
    Timeline._items = saved.items; Timeline._scheduleRebuild = saved.rebuild; Toast.show = saved.toast;
    Timeline._ganttActive = saved.active; Timeline._renderEmptyOverlay = saved.overlay; Timeline.resetVScroll = saved.vscroll;
    Runtime.dropDecision = saved.drop; Timeline._expandedLine = saved.expanded;
    h.restore();
  }
});
