// Tool Inventory Wave 5: the Optimize preview's tool UX (pre-commit guard on every apply path, Tool-blocked panel, chip,
// stale banner, background fingerprint, run-time inventory refresh) and the shared confirm helper. Every test passes
// SYNTHETIC `toolBlocked`/`toolMoved`/`toolPass` candidate fields: the optimizer pass that fills them is Wave 6, and with
// the fields absent nothing here may change behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizerPreview, toolFingerprint, ensureToolInventoryForRun } from '../../../frontend/optimization/optimize-ui.mjs';
import { toolQueueSummary, confirmToolQueue } from '../../../frontend/optimization/tool-queue-confirm.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
const els = new Map();
const mkEl = id => ({
  id, hidden: false, innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {}, focus() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
});
globalThis.document = {
  getElementById(id) { return els.get(id) || null; },
  addEventListener() {}, removeEventListener() {},
  createElement: mkEl, querySelector() { return null; }, querySelectorAll() { return []; },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};

const previewTask = (id, plant, runTime = 1) => ({
  id, PLANT: plant, plant, MACHINE: `${plant}-LINE`, RUN_TIME: runTime, row_version: 1, start_date: null, end_date: null,
});
const plantRow = (plant, rule) => ({ plant, subnetwork: 'S', setup_policy_config: rule ? { toolingRule: rule } : {} });
const setMd = (plant, rule, inventory) => Store.setMasterData(
  { plants: [plantRow(plant, rule)], lines: [], workcenters: [], tool_inventory: inventory }, 'unit-test');

function openPreview(plant, tasks) {
  const prior = {
    raf: globalThis.requestAnimationFrame, nimbus: globalThis.NIMBUS, plant: Store.selectedPlant,
    tasks: structuredClone(Store.tasksArr), recompute: Alerts.scheduleRecompute, lines: Alerts.scheduleRecomputeLines, fetch: globalThis.fetch,
    md: Store.masterData,
  };
  const audits = [];
  globalThis.requestAnimationFrame = cb => { cb(performance.now()); return 1; };
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  globalThis.fetch = (url, init) => { audits.push([String(url), init?.body ? JSON.parse(init.body) : null]); return Promise.resolve({ ok: true }); };
  Store.setTasks(tasks, 'unit-test');
  Store.setSelectedPlant(plant, 'unit-test');
  OptimizerPreview.runWithPreview('spt', {
    plant, respectCalendar: false, now: new Date('2026-08-03T08:00:00'),
    auditDetails: { mode: 'spt', wheelUsed: false, taskCount: tasks.length, scope: 'plant', lines: null, activePriorityFields: [], unrankedPriorityFields: [], splitOrderPolicy: 'never' },
  });
  assert.ok(OptimizerPreview._candidate, 'a detached preview is open');
  return {
    audits,
    restore() {
      OptimizerPreview._clear();
      Alerts.scheduleRecompute = prior.recompute; Alerts.scheduleRecomputeLines = prior.lines;
      Store.setTasks(prior.tasks, 'unit-test'); Store.setSelectedPlant(prior.plant, 'unit-test');
      if (prior.md) Store.setMasterData(prior.md, 'unit-test');
      globalThis.fetch = prior.fetch; globalThis.requestAnimationFrame = prior.raf; globalThis.NIMBUS = prior.nimbus;
    },
  };
}

const blocked = (orderId, extra = {}) => ({ orderId, tool: 'T100', available: 1, inUse: 2, holderIds: ['h1'], ...extra });

test('toolQueueSummary counts only KEPT patches, once per order', () => {
  const candidate = { toolBlocked: [blocked('a'), blocked('a', { tool: 'T200' }), blocked('b'), blocked('c')], toolMoved: [{ orderId: 'a' }, { orderId: 'z' }] };
  const s = toolQueueSummary(candidate, [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(s.queuedIds, ['a', 'c'], 'b was dropped from the kept set; a is counted once');
  assert.equal(s.moved, 1, 'a moved order outside the kept set is not counted');
  assert.deepEqual(toolQueueSummary({}, [{ id: 'a' }]), { queued: [], queuedIds: [], moved: 0 }, 'absent fields read as empty');
  assert.deepEqual(toolQueueSummary(null, []).queuedIds, []);
});

test('confirmToolQueue: no queued tool order means no dialog; otherwise two lines, first 5 ids escaped, Cancel is false', async () => {
  const prior = Modal.confirm;
  const seen = [];
  Modal.confirm = async opts => { seen.push(opts); return seen.length === 2; };
  try {
    assert.equal(await confirmToolQueue({}, [{ id: 'a' }]), true);
    assert.equal(await confirmToolQueue({ toolBlocked: [blocked('a')] }, [{ id: 'other' }]), true, 'queued order not in the kept set: nothing to confirm');
    assert.equal(seen.length, 0, 'no dialog was shown');
    const ids = ['o1', 'o2', 'o3<b>', 'o4', 'o5', 'o6', 'o7'];
    const cand = { toolBlocked: ids.map(id => blocked(id)), toolMoved: [{ orderId: 'o1' }, { orderId: 'o2' }] };
    const kept = ids.map(id => ({ id }));
    assert.equal(await confirmToolQueue(cand, kept), false, 'Cancel resolves false');
    assert.equal(await confirmToolQueue(cand, kept), true, 'Confirm resolves true');
    const o = seen[0];
    assert.match(o.message, /modal\.opt_tool_confirm_moved|orders moved for tooling/);
    assert.match(o.detail, /o1, o2, o3&lt;b&gt;, o4, o5/, 'first five ids, escaped');
    assert.doesNotMatch(o.detail, /o6/, 'only the first five are listed');
    assert.equal(o.tone, 'warn');
  } finally { Modal.confirm = prior; }
});

test('Apply: Cancel at the tool confirm commits nothing and keeps the preview; Confirm commits once and audits tool counts', async () => {
  const plant = 'TQ-APPLY';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('tq-a', plant, 2), previewTask('tq-b', plant, 1)]);
  const prior = Modal.confirm;
  const asked = [];
  let answer = false;
  Modal.confirm = async opts => { asked.push(opts); return answer; };
  try {
    const cand = OptimizerPreview._candidate;
    assert.ok(cand.patches.some(p => p.id === 'tq-a'));
    cand.toolBlocked = [blocked('tq-a'), blocked('not-in-patches')];
    cand.toolMoved = [{ orderId: 'tq-b', tool: 'T100', fromStart: null, fromEnd: null, toStart: 'x', toEnd: 'y' }];
    const before = Store.tasks['tq-a'].start_date;
    await OptimizerPreview.apply();
    assert.equal(asked.length, 1, 'one confirm');
    assert.match(asked[0].message, /opt_tool_confirm_moved/);
    assert.equal(Store.tasks['tq-a'].start_date, before, 'Cancel changed nothing');
    assert.ok(OptimizerPreview._candidate, 'the preview stays open and untouched');
    assert.equal(OptimizerPreview._applying, false);
    assert.equal(f.audits.filter(a => a[0].endsWith('/audit/log')).length, 0, 'no audit row on Cancel');

    answer = true;
    await OptimizerPreview.apply();
    assert.equal(asked.length, 2);
    assert.ok(Store.tasks['tq-a'].start_date instanceof Date, 'Confirm applied the candidate');
    const audit = f.audits.find(a => a[0].endsWith('/audit/log'));
    assert.equal(audit[1].details.tooling_rule, 'hard');
    assert.equal(audit[1].details.tool_blocked, 1, 'only the kept queued order counts');
    assert.equal(audit[1].details.tool_moved, 1);
  } finally { Modal.confirm = prior; f.restore(); }
});

test('Apply with no toolBlocked: no confirm, behaviour unchanged (commit stays synchronous)', () => {
  const plant = 'TQ-NONE';
  setMd(plant, 'off', undefined);
  const f = openPreview(plant, [previewTask('tn-a', plant, 2)]);
  const prior = Modal.confirm;
  let asked = 0;
  Modal.confirm = async () => { asked++; return true; };
  try {
    OptimizerPreview.apply();                      // deliberately not awaited
    assert.equal(asked, 0);
    assert.ok(Store.tasks['tn-a'].start_date instanceof Date, 'applied synchronously, as before');
    const audit = f.audits.find(a => a[0].endsWith('/audit/log'));
    assert.equal(audit[1].details.tool_blocked, 0);
    assert.equal(audit[1].details.tooling_rule, 'off');
  } finally { Modal.confirm = prior; f.restore(); }
});

test('Apply what still fits (applyPartial) and Apply without preview (backgroundApply) go through the same guard', async () => {
  const plant = 'TQ-PARTIAL';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('tp-a', plant, 2), previewTask('tp-b', plant, 1)]);
  const prior = Modal.confirm;
  const asked = [];
  let answer = false;
  Modal.confirm = async opts => { asked.push(opts); return answer; };
  try {
    const cand = OptimizerPreview._candidate;
    cand.toolBlocked = [blocked('tp-a'), blocked('tp-b')];
    const result = () => ({
      runSeq: 1, mode: 'spt', plant, opts: {}, snapshot: OptimizerPreview._snapshot, taskBaseline: OptimizerPreview._taskBaseline,
      candidate: cand, finalists: null, preKpis: OptimizerPreview._preKpis, postKpis: OptimizerPreview._postKpis,
      explanation: OptimizerPreview._explanation, previewDiagnostics: [], splitOrderPolicy: 'never', backlogResult: null, backlogAudit: null,
      auditDetails: null, syntheticSetup: false, startedAt: 0, runtimeMs: 0, toolFingerprint: OptimizerPreview._toolFingerprint,
    });
    const snapshotBefore = Store.tasks['tp-a'].start_date;
    await OptimizerPreview.applyPartial(result());
    assert.equal(asked.length, 1, 'applyPartial asked');
    assert.equal(Store.tasks['tp-a'].start_date, snapshotBefore, 'Cancel applied nothing');

    OptimizerPreview._backgroundRun = { plant, mode: 'spt', startedAt: 0, controller: null, result: result(), error: null };
    await OptimizerPreview.backgroundApply();
    assert.equal(asked.length, 2, 'backgroundApply asked through _commitPatches');
    assert.equal(Store.tasks['tp-a'].start_date, snapshotBefore, 'Cancel applied nothing');
    assert.ok(OptimizerPreview._candidate, 'the result is left open for review after a cancelled background apply');
    assert.match(asked[1].detail, /tp-a, tp-b/, 'ids of the kept patches');

    answer = true;
    OptimizerPreview._backgroundRun = { plant, mode: 'spt', startedAt: 0, controller: null, result: result(), error: null };
    await OptimizerPreview.backgroundApply();
    assert.ok(Store.tasks['tp-a'].start_date instanceof Date, 'Confirm applies');
  } finally { Modal.confirm = prior; OptimizerPreview._backgroundRun = null; f.restore(); }
});

test('preview panel: Tool-blocked section with escaped ids, chip, moved summary and incomplete note; absent fields render none', () => {
  const plant = 'TQ-PANEL';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('<i>x', plant, 1)]);
  const body = mkEl('opt-preview-body');
  els.set('opt-preview-body', body);
  try {
    OptimizerPreview._render();
    assert.doesNotMatch(body.innerHTML, /data-opt-tool-section/, 'nothing without toolBlocked');
    assert.match(body.innerHTML, /opt-pv-chip-tooling/, 'chip while the rule is Hard');
    assert.doesNotMatch(body.innerHTML, /ui\.opt_tool_incomplete/);
    const cand = OptimizerPreview._candidate;
    cand.toolBlocked = [blocked('<i>x', { tool: 'T<1>', holderIds: ['h<1>', 'h2'] })];
    cand.toolMoved = [{ orderId: 'm1' }, { orderId: 'm2' }];
    cand.toolPass = { complete: false, elapsedMs: 5 };
    OptimizerPreview._render();
    assert.match(body.innerHTML, /data-opt-tool-section/);
    assert.match(body.innerHTML, /data-opt-tool-raise="T&lt;1&gt;"/, 'tool id escaped in the attribute');
    assert.doesNotMatch(body.innerHTML, /<i>x|T<1>|h<1>/, 'no raw ids reach the markup');
    assert.match(body.innerHTML, /ui\.opt_tool_moved_summary|2 moved for tooling/);
    assert.match(body.innerHTML, /ui\.opt_tool_incomplete|Tool check incomplete/);
    // Rule Off: no chip.
    setMd(plant, 'off', []);
    OptimizerPreview._toolFingerprint = toolFingerprint(Store.masterData, plant);
    OptimizerPreview._render();
    assert.doesNotMatch(body.innerHTML, /opt-pv-chip-tooling/);
  } finally { els.delete('opt-preview-body'); f.restore(); }
});

test('toolBlockedCsv goes through the CSV-injection-safe cell helper', () => {
  const csv = OptimizerPreview.toolBlockedCsv([{ orderId: '1', tool: '=CMD()', available: 1, inUse: 2, holderIds: ['2', '3'] }], id => `PO${id}`, new Map([['1', 'L1']]));
  const [header, row] = csv.split('\n');
  assert.equal(header, 'order,line,tool,available,in_use,holders');
  assert.match(row, /^PO1,L1,'=CMD\(\),1,2,PO2 PO3$/);
});

test('an open preview goes stale (tooling banner) on master-data-changed for tool_inventory or plants, not for other tables or plants', () => {
  const plant = 'TQ-STALE';
  setMd(plant, 'hard', [{ plant, tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }]);
  const f = openPreview(plant, [previewTask('ts-a', plant, 1)]);
  try {
    assert.equal(OptimizerPreview.stale, false);
    Store.setMasterData({ ...Store.masterData, lines: [{ plant, line: 'x' }] }, 'unit-test', 'lines');
    assert.equal(OptimizerPreview.stale, false, 'an unrelated table does not stale it');
    Store.setMasterData({ ...Store.masterData, tool_inventory: [{ plant: 'OTHER', tool_id: 'T9', total_qty: 1, out_of_service_qty: 0 }, ...Store.masterData.tool_inventory] }, 'unit-test', 'tool_inventory');
    assert.equal(OptimizerPreview.stale, false, 'another plant\'s inventory row does not stale it');
    Store.setMasterData({ ...Store.masterData, tool_inventory: [{ plant, tool_id: 'T1', total_qty: 3, out_of_service_qty: 0 }] }, 'unit-test', 'tool_inventory');
    assert.equal(OptimizerPreview.stale, true);
    assert.equal(OptimizerPreview._staleMessageKey, 'ui.opt_stale_banner_tooling');
    assert.equal(OptimizerPreview.canApply(), false);
    assert.equal(OptimizerPreview._canApplyPartial(), false, 'no apply-what-fits after a tool change');
  } finally { f.restore(); }
  // A tooling rule flip (plants table) stales it too.
  setMd(plant, 'off', []);
  const g = openPreview(plant, [previewTask('ts-b', plant, 1)]);
  try {
    setMd(plant, 'hard', []);
    Store.setMasterData({ ...Store.masterData }, 'unit-test', 'plants');
    assert.equal(OptimizerPreview.stale, true);
    assert.equal(OptimizerPreview._staleMessageKey, 'ui.opt_stale_banner_tooling');
  } finally { g.restore(); }
});

test('toolFingerprint ignores row order, separates unloaded from empty, and includes the rule', () => {
  const a = { plants: [plantRow('P', 'hard')], lines: [], workcenters: [], tool_inventory: [{ plant: 'P', tool_id: 'B', total_qty: 1, out_of_service_qty: 0 }, { plant: 'P', tool_id: 'A', total_qty: 2, out_of_service_qty: 1 }] };
  const b = { ...a, tool_inventory: [...a.tool_inventory].reverse() };
  assert.equal(toolFingerprint(a, 'P'), toolFingerprint(b, 'P'));
  assert.notEqual(toolFingerprint({ ...a, tool_inventory: undefined }, 'P'), toolFingerprint({ ...a, tool_inventory: [] }, 'P'));
  assert.notEqual(toolFingerprint(a, 'P'), toolFingerprint({ ...a, plants: [plantRow('P', 'off')] }, 'P'));
});

test('background result: a tool-fact change since the run disables Apply without preview and stales the viewed result', async () => {
  const plant = 'TQ-BG';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('bg-a', plant, 1)]);
  const priorShow = Toast.show;
  Toast.show = () => {};
  try {
    const result = { plant, toolFingerprint: OptimizerPreview._toolFingerprint };
    assert.equal(OptimizerPreview._toolFactsChanged(result), false);
    setMd(plant, 'hard', [{ plant, tool_id: 'T1', total_qty: 4, out_of_service_qty: 0 }]);
    assert.equal(OptimizerPreview._toolFactsChanged(result), true);
    assert.equal(OptimizerPreview._toolFactsChanged({ plant }), false, 'a result without a fingerprint is never judged');
    // backgroundApply refuses and keeps the run.
    const run = { plant, mode: 'spt', startedAt: 0, controller: null, result: { ...result, candidate: OptimizerPreview._candidate, taskBaseline: OptimizerPreview._taskBaseline }, error: null };
    OptimizerPreview._backgroundRun = run;
    await OptimizerPreview.backgroundApply();
    assert.equal(OptimizerPreview._backgroundRun, run, 'the background run is kept');
  } finally { Toast.show = priorShow; OptimizerPreview._backgroundRun = null; f.restore(); }
});

test('ensureToolInventoryForRun: Off never fetches; Hard + not loaded fetches then asks; Hard + loaded re-reads only when the version moved', async () => {
  const plant = 'TQ-RUN';
  const prior = { refresh: Persistence.refreshToolInventory, read: Persistence._readToolInventoryVersion, confirm: Modal.confirm, base: { ...Persistence._toolInventoryBaseline }, md: Store.masterData };
  const calls = { refresh: 0, read: 0, confirm: 0 };
  let version = 'v1', loadOnRefresh = false, answer = true;
  Persistence.refreshToolInventory = async p => { calls.refresh++; if (loadOnRefresh) setMd(p, 'hard', []); return loadOnRefresh; };
  Persistence._readToolInventoryVersion = async () => { calls.read++; return version; };
  Modal.confirm = async () => { calls.confirm++; return answer; };
  try {
    setMd(plant, 'off', undefined);
    assert.equal(await ensureToolInventoryForRun(plant), true);
    assert.deepEqual(calls, { refresh: 0, read: 0, confirm: 0 }, 'Off does nothing');

    setMd(plant, 'hard', undefined);
    assert.equal(await ensureToolInventoryForRun(plant), true, 'continue chosen');
    assert.deepEqual(calls, { refresh: 1, read: 0, confirm: 1 }, 'tried once, then asked');
    answer = false;
    assert.equal(await ensureToolInventoryForRun(plant), false, 'Cancel aborts the run');
    loadOnRefresh = true; setMd(plant, 'hard', undefined); calls.confirm = 0;
    assert.equal(await ensureToolInventoryForRun(plant), true);
    assert.equal(calls.confirm, 0, 'the fetch loaded it: no question');

    setMd(plant, 'hard', []);
    Persistence._toolInventoryBaseline[plant] = 'v1';
    calls.refresh = 0;
    await ensureToolInventoryForRun(plant);
    assert.equal(calls.refresh, 0, 'version unchanged: cheap, no re-read');
    version = 'v2';
    await ensureToolInventoryForRun(plant);
    assert.equal(calls.refresh, 1, 'version moved: forced re-read');
  } finally {
    Persistence.refreshToolInventory = prior.refresh; Persistence._readToolInventoryVersion = prior.read; Modal.confirm = prior.confirm;
    Persistence._toolInventoryBaseline = prior.base;
    if (prior.md) Store.setMasterData(prior.md, 'unit-test');
  }
});
