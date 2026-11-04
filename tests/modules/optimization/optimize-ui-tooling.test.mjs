// Tool Inventory Wave 5: the Optimize preview's tool UX (pre-commit guard on every apply path, Tool-blocked panel, chip,
// stale banner, background fingerprint, run-time inventory refresh) and the shared confirm helper. Every test passes
// SYNTHETIC `toolBlocked`/`toolMoved`/`toolPass` candidate fields: the optimizer pass that fills them is Wave 6, and with
// the fields absent nothing here may change behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizerPreview, toolFingerprint, ensureToolInventoryForRun } from '../../../frontend/optimization/optimize-ui.mjs';
import { toolQueueSummary, confirmToolQueue } from '../../../frontend/optimization/tool-queue-confirm.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { validateCandidate } from '../../../frontend/optimization/setup-scheduler.mjs';
import { snapshotSchedule } from '../../../frontend/optimization/engine.mjs';
import * as TF from '../helpers/tool-overflow-fixture.mjs';

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
  assert.deepEqual(toolQueueSummary({}, [{ id: 'a' }]), { queued: [], queuedIds: [], moved: 0, cascade: 0 }, 'absent fields read as empty');
  const withCascade = toolQueueSummary({ toolBlocked: [blocked('a'), blocked('c', { cause: 'cascade' })] }, [{ id: 'a' }, { id: 'c' }]);
  assert.equal(withCascade.queued.length, 2, 'a cascade-queued order counts as queued for tooling');
  assert.equal(withCascade.cascade, 1, 'and is reported separately');
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
  assert.equal(header, 'order,line,tool,available,in_use,holders,cause');
  assert.match(row, /^PO1,L1,'=CMD\(\),1,2,PO2 PO3,tool$/);
  assert.match(OptimizerPreview.toolBlockedCsv([{ orderId: '1', tool: 'T1', available: 1, inUse: 0, holderIds: ['2'], cause: 'cascade' }]).split('\n')[1], /,cascade$/);
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

test('confirmToolQueue hides the moved line when nothing moved', async () => {
  const prior = Modal.confirm;
  const seen = [];
  Modal.confirm = async opts => { seen.push(opts); return true; };
  try {
    await confirmToolQueue({ toolBlocked: [blocked('a')] }, [{ id: 'a' }]);
    await confirmToolQueue({ toolBlocked: [blocked('a')], toolMoved: [{ orderId: 'a' }] }, [{ id: 'a' }]);
    assert.equal(seen[0].message, '', 'no "moved: 0" line');
    assert.match(seen[1].message, /opt_tool_confirm_moved|moved for tooling/);
  } finally { Modal.confirm = prior; }
});

test('toolFingerprint: the inventory part is null while the rule is Off (a count change cannot stale an Off plant); Hard keeps it', () => {
  const rows = n => [{ plant: 'P', tool_id: 'A', total_qty: n, out_of_service_qty: 0 }];
  const md = (rule, n) => ({ plants: [plantRow('P', rule)], lines: [], workcenters: [], tool_inventory: rows(n) });
  assert.equal(toolFingerprint(md('off', 1), 'P'), toolFingerprint(md('off', 9), 'P'), 'Off: counts do not matter');
  assert.equal(JSON.parse(toolFingerprint(md('off', 1), 'P')).i, null);
  assert.notEqual(toolFingerprint(md('hard', 1), 'P'), toolFingerprint(md('hard', 9), 'P'), 'Hard: counts matter');
  assert.notEqual(toolFingerprint(md('off', 1), 'P'), toolFingerprint(md('hard', 1), 'P'), 'the rule flip itself changes it');
});

test('open preview: Off plant is NOT staled by an inventory change; Hard is; an Off->Hard flip is', () => {
  const plant = 'TQ-OFFSTALE';
  setMd(plant, 'off', [{ plant, tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }]);
  const f = openPreview(plant, [previewTask('os-a', plant, 1)]);
  try {
    Store.setMasterData({ ...Store.masterData, tool_inventory: [{ plant, tool_id: 'T1', total_qty: 7, out_of_service_qty: 0 }] }, 'unit-test', 'tool_inventory');
    assert.equal(OptimizerPreview.stale, false, 'rule Off: inventory edits are irrelevant');
    setMd(plant, 'hard', [{ plant, tool_id: 'T1', total_qty: 7, out_of_service_qty: 0 }]);
    Store.setMasterData({ ...Store.masterData }, 'unit-test', 'plants');
    assert.equal(OptimizerPreview.stale, true, 'Off -> Hard stales it');
  } finally { f.restore(); }
  setMd(plant, 'hard', [{ plant, tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }]);
  const g = openPreview(plant, [previewTask('os-b', plant, 1)]);
  try {
    Store.setMasterData({ ...Store.masterData, tool_inventory: [{ plant, tool_id: 'T1', total_qty: 3, out_of_service_qty: 0 }] }, 'unit-test', 'tool_inventory');
    assert.equal(OptimizerPreview.stale, true, 'rule Hard: inventory edits stale it');
  } finally { g.restore(); }
});

test('Backlog preview: no tooling chip and a tool change never stales it', () => {
  const plant = 'TQ-BACKLOG';
  setMd(plant, 'hard', [{ plant, tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }]);
  const f = openPreview(plant, [previewTask('bl-a', plant, 1)]);
  const body = mkEl('opt-preview-body');
  els.set('opt-preview-body', body);
  try {
    OptimizerPreview._mode = 'backlog';
    OptimizerPreview._toolFingerprint = null;   // what a backlog run stores: no fingerprint
    OptimizerPreview._render();
    assert.doesNotMatch(body.innerHTML, /opt-pv-chip-tooling/);
    Store.setMasterData({ ...Store.masterData, tool_inventory: [{ plant, tool_id: 'T1', total_qty: 9, out_of_service_qty: 0 }] }, 'unit-test', 'tool_inventory');
    assert.equal(OptimizerPreview.stale, false);
    // Even with a fingerprint left over, the chip is suppressed for backlog.
    OptimizerPreview._toolFingerprint = toolFingerprint(Store.masterData, plant);
    OptimizerPreview._render();
    assert.doesNotMatch(body.innerHTML, /opt-pv-chip-tooling/);
  } finally { els.delete('opt-preview-body'); f.restore(); }
});

test('_commitPatches: Cancel at the confirm resolves false and commits nothing; Confirm resolves true', async () => {
  const plant = 'TQ-BOOL';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('bo-a', plant, 2)]);
  const prior = Modal.confirm;
  let answer = false;
  Modal.confirm = async () => answer;
  try {
    const cand = OptimizerPreview._candidate;
    cand.toolBlocked = [blocked('bo-a')];
    const kept = cand.patches;
    assert.equal(await OptimizerPreview._commitPatches(kept, { ids: [], reason: 'running' }), false);
    assert.equal(OptimizerPreview._applying, false);
    assert.equal(Store.tasks['bo-a'].start_date, null);
    answer = true;
    assert.equal(await OptimizerPreview._commitPatches(kept, { ids: [], reason: 'running' }), true);
    assert.ok(Store.tasks['bo-a'].start_date instanceof Date);
  } finally { Modal.confirm = prior; f.restore(); }
});

test('a task edited while the tool confirm is open aborts the commit (no stale apply)', async () => {
  const plant = 'TQ-DRIFT';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('dr-a', plant, 2)]);
  const prior = { confirm: Modal.confirm, show: Toast.show };
  const toasts = [];
  Toast.show = (m, k) => { toasts.push([m, k]); };
  Modal.confirm = async () => { Store.updateTask('dr-a', { RUN_TIME: 5 }, 'table'); return true; };   // the planner edits behind the dialog
  try {
    const cand = OptimizerPreview._candidate;
    cand.toolBlocked = [blocked('dr-a')];
    assert.equal(await OptimizerPreview._commitPatches(cand.patches, { ids: [], reason: 'running' }, structuredClone(Store.tasksArr)), false);
    assert.equal(Store.tasks['dr-a'].start_date, null, 'nothing was applied');
    assert.equal(OptimizerPreview._applying, false, 'the flag is restored');
    assert.equal(OptimizerPreview.stale, true, 'the preview is marked stale');
    assert.ok(toasts.some(([m]) => /opt_preview_task_stale|stale|changed/i.test(String(m))));
  } finally { Modal.confirm = prior.confirm; Toast.show = prior.show; f.restore(); }
});

test('_showPreviewAfterCancel leaves a visible (foreground) preview untouched; a hidden one (background) is opened and rendered', () => {
  const plant = 'TQ-SHOW';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('sh-a', plant, 1)]);
  const body = mkEl('opt-preview-body');
  const modal = mkEl('modal-opt-preview');
  els.set('opt-preview-body', body); els.set('modal-opt-preview', modal);
  const prior = Modal.open;
  const opened = [];
  Modal.open = id => { opened.push(id); };
  try {
    body.innerHTML = 'SENTINEL';
    modal.hidden = false;
    OptimizerPreview._showPreviewAfterCancel();
    assert.equal(body.innerHTML, 'SENTINEL', 'not rebuilt: open details and scroll position survive');
    assert.deepEqual(opened, []);
    modal.hidden = true;
    OptimizerPreview._showPreviewAfterCancel();
    assert.deepEqual(opened, ['modal-opt-preview']);
    assert.notEqual(body.innerHTML, 'SENTINEL', 'rendered once opened');
  } finally { Modal.open = prior; els.delete('opt-preview-body'); els.delete('modal-opt-preview'); f.restore(); }
});

test('Raise inventory from the preview: confirm first (Cancel keeps the preview), then close it, navigate and toast', async () => {
  const plant = 'TQ-RAISE';
  setMd(plant, 'hard', []);
  const f = openPreview(plant, [previewTask('ra-a', plant, 1)]);
  const prior = { confirm: Modal.confirm, close: Modal.close, show: Toast.show };
  const asked = [], closed = [], toasts = [], nav = [];
  let answer = false;
  Modal.confirm = async o => { asked.push(o); return answer; };
  Modal.close = id => { closed.push(id); };
  Toast.show = (m, k) => { toasts.push([String(m), k]); };
  try {
    globalThis.NIMBUS = { App: { goto: s => nav.push(['goto', s]), gotoMasterSub: s => nav.push(['sub', s]) } };
    await OptimizerPreview._raiseInventory('T1');
    assert.equal(asked.length, 1);
    assert.match(asked[0].message, /opt_tool_raise_discard|discards this plan/);
    assert.deepEqual(nav, [], 'Cancel: no navigation');
    assert.ok(OptimizerPreview._candidate, 'Cancel keeps the preview');
    answer = true;
    await OptimizerPreview._raiseInventory('T1');
    assert.equal(OptimizerPreview._candidate, null, 'the preview was cleared');
    assert.ok(closed.includes('modal-opt-preview'));
    assert.deepEqual(nav.map(n => n[1]), ['masterdata', 'tool-inventory']);
    assert.ok(toasts.some(([m]) => /opt_tool_raise_closed|Preview closed/.test(m)));
    // No preview open: no confirm, no "preview closed" toast.
    asked.length = 0; toasts.length = 0; nav.length = 0;
    await OptimizerPreview._raiseInventory('T1');
    assert.equal(asked.length, 0);
    assert.equal(toasts.length, 0);
    assert.equal(nav.length, 2);
  } finally {
    Modal.confirm = prior.confirm; Modal.close = prior.close; Toast.show = prior.show; f.restore();
  }
});

test('Persistence.ensureToolInventoryCurrent: unchanged version is fresh without a re-read; a moved version re-reads; no baseline or a slow probe proceeds unfresh', async () => {
  const plant = 'TQ-ENSURE';
  const prior = { refresh: Persistence.refreshToolInventory, read: Persistence._readToolInventoryVersion, base: { ...Persistence._toolInventoryBaseline } };
  let refreshes = 0, version = 'v1', hang = false;
  Persistence.refreshToolInventory = async () => { refreshes++; return true; };
  Persistence._readToolInventoryVersion = () => (hang ? new Promise(() => {}) : Promise.resolve(version));
  try {
    Persistence._toolInventoryBaseline[plant] = 'v1';
    assert.deepEqual(await Persistence.ensureToolInventoryCurrent(plant), { fresh: true });
    assert.equal(refreshes, 0);
    version = 'v2';
    assert.deepEqual(await Persistence.ensureToolInventoryCurrent(plant), { fresh: true });
    assert.equal(refreshes, 1);
    delete Persistence._toolInventoryBaseline[plant];
    assert.deepEqual(await Persistence.ensureToolInventoryCurrent(plant), { fresh: false }, 'nothing to compare with');
    Persistence._toolInventoryBaseline[plant] = 'v1'; hang = true;
    const t0 = Date.now();
    assert.deepEqual(await Persistence.ensureToolInventoryCurrent(plant, { timeoutMs: 30 }), { fresh: false }, 'timeout: proceed with the held rows');
    assert.ok(Date.now() - t0 < 1000, 'bounded by the short timeout');
    assert.deepEqual(await Persistence.ensureToolInventoryCurrent(null), { fresh: false });
  } finally {
    Persistence.refreshToolInventory = prior.refresh; Persistence._readToolInventoryVersion = prior.read; Persistence._toolInventoryBaseline = prior.base;
  }
});

// ── Tool Inventory Wave 6: _pruneAgainstLive with tool_overflow findings ─────────────────────────────────────────────
// A tool_overflow ERROR names exactly ONE order, and only an order of the KEPT set can be named (the validated
// dispositions are the kept patches'), so `dropWithFamily` always resolves it; the message is fixed, the holders live in
// `detail`, so the code|taskId|message key stays stable across passes. Dropping a patch reverts that order to its LIVE
// position, which can collide with the next kept patch: the loop re-validates up to min(8, kept patches) passes, so a chain of
// up to 7 sequential drops resolves and a longer one is refused (null) rather than half-applied.
const T0 = new Date('2035-08-06T10:00:00');
const hrs = n => new Date(+T0 + n * 3600 * 1000);
function pruneFixture(live, kept, { plant = 'P1' } = {}) {
  const ids = Object.keys(live);
  const specs = ids.map((id, i) => ({ id, line: 'L' + (i + 1), run: 4, tools: ['T1'], due: '2035-08-09T08:00:00' }));
  const snap = TF.toolSnapshot(specs.map(s => ({ ...s, start: undefined })), { inventory: [{ tool_id: 'T1', total_qty: 1 }], lines: ids.map((_, i) => 'L' + (i + 1)) });
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMd = Store.masterData;
  const priorPlant = Store.selectedPlant;
  Store.setMasterData(structuredClone(snap.masterData), 'unit-test');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks(snap.tasks.map(t => ({ ...t, start_date: hrs(live[t.id][0]), end_date: hrs(live[t.id][1]), planning_status: 'scheduled', user_scheduled: true })), 'unit-test');
  const patches = Object.entries(kept).map(([id, [a, b]]) => ({ id, changes: { start_date: hrs(a), end_date: hrs(b), scheduleSegments: [], planning_status: 'scheduled', planning_reason: null } }));
  const candidate = {
    patches, dispositions: ids.map((id, i) => ({ id, line: 'L' + (i + 1), status: 'scheduled' })),
    score: [], explanation: [], diagnostics: { candidateCount: 1 }, unchangedLines: [], missingEdges: [],
    toolPass: { complete: true, elapsedMs: 0 },
    validationContext: { snapshot: snap, bounds: TF.toolBounds(snap, { respectCalendar: false }) },
  };
  return {
    snap, candidate,
    prune: dropIds => OptimizerPreview._pruneAgainstLive({ plant, candidate, snapshot: snap.tasks, shouldDrop: id => dropIds.includes(id) }),
    restore() { Store.setTasks(priorTasks, 'unit-test'); if (priorMd) Store.setMasterData(priorMd, 'unit-test'); if (priorPlant) Store.setSelectedPlant(priorPlant, 'unit-test'); },
  };
}

test('prune: a planner edit that lands on a kept order\'s tool slot drops THAT kept order (one tool_overflow, fixed message)', () => {
  // Live: A, B, C all on T1 at 0-4h (pre-existing overlap). Candidate keeps A, moves B to 4-8h and C to 8-12h.
  const fx = pruneFixture({ A: [0, 4], B: [0, 4], C: [0, 4], Y: [40, 44] }, { B: [4, 8], C: [8, 12], Y: [44, 48] });
  try {
    assert.ok(fx.prune([]), 'the candidate applies as computed');
    assert.deepEqual(fx.prune([]).dropped, []);
    // The planner drags C (live) onto B's new slot: the live board now has C on top of kept B.
    Store.updateTask('C', { start_date: hrs(5), end_date: hrs(9) }, 'user');
    const pruned = fx.prune(['C']);
    assert.ok(pruned, 'resolved, not refused');
    assert.deepEqual(pruned.kept.map(p => p.id), ['Y'], 'B (the only KEPT holder in the cluster) is dropped, and C was skipped by the caller; Y is untouched');
    assert.deepEqual([...pruned.dropped].sort(), ['B', 'C']);
  } finally { fx.restore(); }
});

test('prune: the tool_overflow finding names one kept order with a fixed message and the holders in detail', () => {
  const fx = pruneFixture({ A: [0, 4], B: [0, 4] }, { B: [4, 8] });
  try {
    Store.updateTask('A', { start_date: hrs(5), end_date: hrs(9) }, 'user');
    const findings = validateCandidate(snapshotSchedule('P1'), fx.candidate.validationContext.bounds, { ...fx.candidate, dispositions: fx.candidate.dispositions.filter(d => d.id === 'B') })
      .filter(f => f.code === 'tool_overflow' && f.severity === 'error');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].taskId, 'B');
    assert.equal(findings[0].detail.tool, 'T1');
    assert.deepEqual(findings[0].detail.holders, ['A']);
    assert.doesNotMatch(findings[0].message, /A|T1/, 'no holder ids or tool names in the message');
  } finally { fx.restore(); }
});

test('prune: pass cap min(8, kept) with a chain of live collisions (chains of 2, 3 and 4 sequential drops resolve; 8 are refused)', () => {
  // Dropping a patch reverts that order to its live slot, which sits on the NEXT kept patch.
  const live2 = { A: [4, 8], O2: [8, 12], O3: [12, 16], Y: [40, 44] };
  const fx2 = pruneFixture(live2, { O2: [4, 8], O3: [8, 12], Y: [44, 48] });       // O2 kept at A's live slot; dropping O2 puts it on O3's kept slot
  try {
    const r = fx2.prune([]);
    assert.ok(r, 'two sequential drops resolve inside the cap');
    assert.deepEqual(r.kept.map(p => p.id), ['Y'], 'O2 collides with live A, falls back onto kept O3, which then falls back too');
    assert.deepEqual([...r.dropped].sort(), ['O2', 'O3']);
  } finally { fx2.restore(); }
  // A chain of n sequential drops: A is live at 4-8; order k (2..n+1) is live at 4k..4k+4 and kept at the previous order's live slot.
  const chain = n => {
    const live = { A: [4, 8], Y: [100, 104] }; const kept = { Y: [104, 108] };
    for (let k = 2; k <= n + 1; k++) { live['O' + k] = [4 * k, 4 * k + 4]; kept['O' + k] = [4 * (k - 1), 4 * k]; }
    return pruneFixture(live, kept);
  };
  for (const n of [3, 4, 7]) {
    const fx = chain(n);
    try {
      const r = fx.prune([]);
      assert.ok(r, 'a chain of ' + n + ' sequential drops resolves under the raised cap');
      assert.deepEqual(r.kept.map(p => p.id), ['Y']);
      assert.equal(r.dropped.length, n);
    } finally { fx.restore(); }
  }
  const fx8 = chain(8);
  try {
    assert.equal(fx8.prune([]), null, 'a chain longer than the cap (8 sequential drops, 9 kept) is refused, never half-applied');
  } finally { fx8.restore(); }
});

/* P2-4: the Undo entry of an optimizer Apply captures only the kept ids plus their distribution family. */
const OTHERS = 197;
function addUnrelated(plant, count = OTHERS) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ id: `un-${i}`, PLANT: plant, plant, MACHINE: `${plant}-OTHER`, RUN_TIME: 1, row_version: 1,
      start_date: new Date(2026, 7, 10, 8 + (i % 8)), end_date: new Date(2026, 7, 10, 9 + (i % 8)) });
  }
  return rows;
}
const datesOf = task => [task.start_date?.getTime() ?? null, task.end_date?.getTime() ?? null, task.planning_status ?? null];

async function undoScopeRun({ extraFor3 = [], mutate, commit, check }) {
  const plant = 'TQ-UNDO';
  setMd(plant, 'off', undefined);
  const f = openPreview(plant, [previewTask('ud-a', plant, 2), previewTask('ud-b', plant, 1), previewTask('ud-c', plant, 1), ...extraFor3]);
  const priorEntries = UndoStack._entries.slice();
  UndoStack._entries.length = 0;
  const priorUpdate = Store.updateMany;
  const written = [];
  try {
    const cand = OptimizerPreview._candidate;
    const kept = cand.patches.filter(p => ['ud-a', 'ud-b', 'ud-c'].includes(String(p.id)));
    assert.equal(kept.length, 3, 'a 3-patch candidate');
    // Grow the board to 200 orders behind the open preview (_commitPatches does not re-check staleness).
    if (!extraFor3.length) Store.setTasks([...Store.tasksArr, ...addUnrelated(plant)], 'unit-test');
    const pre = new Map(Store.tasksArr.map(t => [String(t.id), datesOf(t)]));
    if (mutate) mutate();
    assert.equal(await commit(kept), true);
    assert.equal(UndoStack._entries.length, 1, 'one Undo entry');
    const entry = UndoStack._entries[0];
    Store.updateMany = (patches, source) => { for (const p of patches) written.push(String(p.id)); return priorUpdate.call(Store, patches, source); };
    UndoStack.pop();
    await check({ entry, written, pre, plant });
  } finally {
    Store.updateMany = priorUpdate;
    UndoStack._entries.length = 0; UndoStack._entries.push(...priorEntries);
    f.restore();
  }
}

test('P2-4: Undo after an optimizer Apply rewrites only the kept rows; the other 197 orders are untouched', async () => {
  await undoScopeRun({ commit: kept => OptimizerPreview._commitPatches(kept, { ids: [], reason: 'running' }), check: r => {
  assert.deepEqual([...r.entry.ids].sort(), ['ud-a', 'ud-b', 'ud-c'], 'the entry names only the kept ids');
  const restored = new Set(r.written);
  for (const id of ['ud-a', 'ud-b', 'ud-c']) assert.ok(restored.has(id), `${id} restored`);
  assert.equal(restored.size, 3, 'no other row is written by Undo (dirty ids limited)');
  for (const id of ['ud-a', 'ud-b', 'ud-c']) assert.deepEqual(datesOf(Store.tasks[id]).slice(0, 2), [null, null], `${id} back to its pre-value`);
  for (let i = 0; i < OTHERS; i++) assert.deepEqual(datesOf(Store.tasks[`un-${i}`]), r.pre.get(`un-${i}`), 'unrelated order equals its pre-value');
  } });
});

test('P2-4: an unrelated edit made between Apply and Undo is NOT rolled back (accepted behaviour change)', async () => {
  let edited = null;
  await undoScopeRun({
    check: r => {
      assert.ok(!r.written.includes('un-5'), 'Undo did not touch the later edit');
      assert.equal(Store.tasks['un-5'].start_date.getTime(), edited.getTime());
    },
    commit: async kept => {
      const ok = await OptimizerPreview._commitPatches(kept, { ids: [], reason: 'running' });
      edited = new Date(2026, 7, 20, 7);
      Store.updateTask('un-5', { start_date: edited, end_date: new Date(2026, 7, 20, 8) }, 'unit-test');
      return ok;
    },
  });
});

test('P2-4: the distribution family of a kept order is in the Undo pre-image', async () => {
  const plant = 'TQ-UNDO';
  const fam = (id, line) => ({ ...previewTask(id, plant, 1), MACHINE: line, PARENT_ORDER: 'PAR1', MATERIAL_NUMBER: 'MAT1',
    start_date: new Date(2026, 7, 11, 8), end_date: new Date(2026, 7, 11, 9) });
  await undoScopeRun({
    check: r => assert.deepEqual([...r.entry.ids].sort(), ['ud-a', 'ud-b', 'ud-c', 'ud-sib'], 'kept ids plus the unpatched sibling'),
    extraFor3: [fam('ud-sib', `${plant}-FAMLINE`)],
    mutate: () => { Store.updateTask('ud-a', { PARENT_ORDER: 'PAR1', MATERIAL_NUMBER: 'MAT1' }, 'unit-test'); },
    commit: kept => OptimizerPreview._commitPatches(kept, { ids: [], reason: 'running' }),
  });
});

test('P2-4: applyPartial (Apply what still fits) scopes Undo to the surviving kept ids', async () => {
  const plant = 'TQ-UNDO';
  setMd(plant, 'off', undefined);
  const f = openPreview(plant, [previewTask('up-a', plant, 2), previewTask('up-b', plant, 1), previewTask('up-c', plant, 1)]);
  const priorEntries = UndoStack._entries.slice();
  UndoStack._entries.length = 0;
  try {
    const cand = OptimizerPreview._candidate;
    const result = { plant, candidate: cand, snapshot: OptimizerPreview._snapshot, taskBaseline: OptimizerPreview._taskBaseline };
    Store.setTasks([...Store.tasksArr, ...addUnrelated(plant)], 'unit-test');
    Store.updateTask('up-b', { RUN_TIME: 9 }, 'unit-test');   // edited behind the preview: dropped by the partial apply
    await OptimizerPreview.applyPartial(result);
    assert.equal(UndoStack._entries.length, 1);
    const ids = [...UndoStack._entries[0].ids].sort();
    assert.ok(ids.includes('up-a') && ids.includes('up-c') && !ids.includes('up-b'), 'dropped order is not in the pre-image: ' + ids);
    assert.ok(ids.length <= 3 && !ids.some(id => id.startsWith('un-')), 'no unrelated row captured');
  } finally {
    UndoStack._entries.length = 0; UndoStack._entries.push(...priorEntries);
    f.restore();
  }
});

test('P2-4: the Undo stack still holds at most 10 entries', () => {
  const prior = UndoStack._entries.slice();
  UndoStack._entries.length = 0;
  try {
    for (let i = 0; i < 12; i++) UndoStack.push(`e${i}`, () => {}, ['x']);
    assert.equal(UndoStack._entries.length, UndoStack.MAX);
    assert.equal(UndoStack._entries[0].label, 'e2');
  } finally { UndoStack._entries.length = 0; UndoStack._entries.push(...prior); }
});
