import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Store } from '../../../frontend/platform/store.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { weightsSignature } from '../../../frontend/distribution/shares-editor.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

// Exercise the real private handlers with only DOM rendering and list refresh
// suppressed. This follows the independent review's hydration reproduction.
let imports = 0;
async function pane(realDetail = false) {
  const url = new URL('../../../frontend/distribution/distribution-pane.mts', import.meta.url);
  let source = fs.readFileSync(url, 'utf8').replace('return { init, render, setActive };', `
    _fetchAndRenderList = async () => {};
    ${realDetail ? '' : '_openDetail = async () => {};'}
    _renderDetail = () => {};
    _renderList = () => {};
    return { _onSaveClick, _runWritePipeline, _onBulkReset, _repairRow, _openDetail,
      _markReviewed, _onSaveScheduleClick, _postReview,
      switchDetail(detail) { _detail = detail; _selectedKey = _rowKey(detail.header); _lastWrite = null; },
      lastWrite() { return _lastWrite; },
      detail() { return _detail; },
      detailLoading() { return _detailLoading; },
      setup(detail, signature) {
        _detail = detail; _selectedKey = _rowKey(detail.header);
        _rows = [detail]; _checkedKeys.clear(); _checkedKeys.add(_rowKey(detail.header));
        _dryRunStatus = 'ready'; _dryRunSignature = signature;
        _dryRun = { removed_scheduled: [] };
      }
    };`);
  source = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText;
  source = source.replace(/from ['"]([^'"]+)['"]/g,
    (_all, spec) => `from '${new URL(spec, url).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source + `\n//# sourceURL=distribution-handler-${imports++}.mjs`).toString('base64')}`)).DistributionPane;
}

const header = { plant: 'P', production_order: '100', material_number: 'MAT', base_version: 40 };
const detail = { header, shares: [{ machine: 'L1', weight: 1, letter: 'A' }] };
const child = { id: 'kept', production_order: '100', parent_production_order: '100',
  material_number: 'MAT', plant: 'P', machine: 'L1', run_time: 2,
  start_date: '2026-10-01T08:00:00', end_date: '2026-10-01T10:00:00',
  scheduled_start: '2026-10-01T08:00:00', scheduled_end: '2026-10-01T10:00:00',
  planning_status: 'scheduled', prt_01: 'SERVER_TOOL', production_version: '0001',
  base_version: 42, schedule_segments: [] };
const result = { status: 'ok', children: [child], removed: [], versions: { kept: 42 },
  base_version: 42, previous_shares: [] };
const ok = body => ({ ok: true, json: async () => body });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(realDetail = false) {
  Store.setTasks([{ id: 'kept', MACHINE: 'L1', PLANT: 'P', plant: 'P', ORDER: '100',
    PARENT_ORDER: '100', MATERIAL_NUMBER: 'MAT', PRT_01: 'SERVER_TOOL', PRODUCTION_VERSION: '0001',
    row_version: 40, RUN_TIME: 2, start_date: new Date(child.start_date), end_date: new Date(child.end_date),
    planning_status: 'scheduled' }], 'persistence');
  Store.setSelectedPlant('P', 'persistence');
  Sandbox.active = false;
  Persistence._dirtyIds.clear(); Persistence._conflictedIds.clear(); Persistence._forceIds.clear();
  Persistence._saveCache = () => {};
  Toast.show = () => {}; Util.t = key => key;
  Engine.reconcileRuntimeSchedules = () => {};
  const debounce = Util.debounce;
  Util.debounce = () => () => {};
  let p;
  try { p = await pane(realDetail); } finally { Util.debounce = debounce; }
  p.setup(detail, weightsSignature([{ machine: 'L1', letter: 'A', weight: 1, purged: false, stale: false, currentStart: null }]));
  return p;
}

for (const action of ['save', 'reset', 'undo', 'bulk', 'repair']) {
  test(`${action} blocks distribution requests when a child has unsaved attributes`, async () => {
    const p = await fixture();
    Store.updateTask('kept', { PRT_01: 'LOCAL_UNSAVED_TOOL', PRODUCTION_VERSION: '0002' }, 'inspector');
    Persistence._dirtyIds.add('kept');
    let calls = 0;
    Util.fetchTraced = async () => { calls++; return ok({ ...result, results: [result] }); };
    if (action === 'save') await p._onSaveClick();
    if (action === 'reset') await p._runWritePipeline('reset');
    if (action === 'undo') await p._runWritePipeline('shares');
    if (action === 'bulk') await p._onBulkReset();
    if (action === 'repair') await p._repairRow(detail);
    assert.equal(calls, 0);
    assert.equal(Store.tasks.kept.PRT_01, 'LOCAL_UNSAVED_TOOL');
    assert.equal(Store.tasks.kept.row_version, 40);
  });
}

for (const scenario of ['attribute edit', 'removed child', 'replacement child']) {
  test(`share response preserves the group and old token after an in-flight ${scenario}`, async () => {
    const p = await fixture();
    let release;
    Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
    const pending = p._onSaveClick();
    await turn();
    Store.updateTask('kept', { PRT_01: 'LOCAL_UNSAVED_TOOL' }, 'inspector');
    if (scenario === 'replacement child') {
      // The server replaces the original child with a new id; retaining only
      // updated children would otherwise erase the local edit on the removed id.
      release(ok({ ...result, children: [{ ...child, id: 'replacement' }], removed: ['kept'] }));
    } else release(ok(scenario === 'removed child' ? { ...result, children: [], removed: ['kept'] } : result));
    await pending;
    assert.equal(Store.tasks.kept.PRT_01, 'LOCAL_UNSAVED_TOOL');
    assert.equal(Store.tasks.kept.row_version, 40);
    assert.equal(Store.tasks.replacement, undefined);
    assert.equal(Persistence._conflictedIds.has('kept'), true);
    let taskPosts = 0;
    Util.fetchTraced = async (_url, options) => {
      if (options?.method === 'POST') taskPosts++;
      return ok({ status: 'ok', persisted: 1, versions: { kept: 43 } });
    };
    Persistence.saveAll(); await turn();
    assert.equal(taskPosts, 0);
    assert.equal(Persistence._dirtyIds.has('kept'), true);
  });
}

test('late share response never hydrates a newly selected plant', async () => {
  const p = await fixture();
  let release;
  Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
  const pending = p._onSaveClick(); await turn();
  Store.setSelectedPlant('OTHER', 'persistence');
  Store.setTasks([{ ...Store.tasks.kept, PLANT: 'OTHER', plant: 'OTHER', PRT_01: 'OTHER_TOOL' }], 'persistence');
  release(ok(result)); await pending;
  assert.equal(Store.tasks.kept.PRT_01, 'OTHER_TOOL');
  assert.equal(Store.tasks.kept.row_version, 40);
});

for (const action of ['save', 'bulk']) test(`${action}: a replaced task collection in the same plant retains edits as unresolved after distribution commits`, async () => {
  const p = await fixture();
  let release;
  Util.fetchTraced = async (_url, options) => JSON.parse(options.body).dry_run
    ? ok({ results: [{ ...header, status: 'ok', removed_scheduled: [] }] })
    : new Promise(resolve => { release = resolve; });
  const pending = action === 'bulk' ? p._onBulkReset() : p._onSaveClick(); await turn();
  Store.setTasks([{ ...Store.tasks.kept, PRT_01: 'REPLACED_LOCAL' }], 'optimizer');
  release(ok(action === 'bulk' ? { results: [{ ...result, ...header }] } : result)); await pending;
  assert.equal(Store.tasks.kept.PRT_01, 'REPLACED_LOCAL');
  assert.equal(Store.tasks.kept.row_version, 40);
  assert.equal(Persistence._conflictedIds.has('kept'), true);
});

for (const action of ['reset', 'undo', 'bulk', 'repair']) {
  test(`${action} retains edited removed child after a real distribution request starts`, async () => {
    const p = await fixture();
    let release;
    Util.fetchTraced = async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.dry_run) return ok(action === 'undo'
        ? { removed_scheduled: [] } : { results: [{ ...header, status: 'ok', removed_scheduled: [] }] });
      return new Promise(resolve => { release = resolve; });
    };
    const pending = action === 'repair' ? p._repairRow(detail)
      : action === 'bulk' ? p._onBulkReset() : p._runWritePipeline(action === 'reset' ? 'reset' : 'shares');
    await turn();
    assert.equal(typeof release, 'function');
    Store.updateTask('kept', { PRODUCTION_VERSION: 'LOCAL_PV' }, 'inspector');
    const replacement = { ...result, ...header, children: [{ ...child, id: 'replacement' }], removed: ['kept'] };
    release(ok(action === 'bulk' || action === 'reset' ? { results: [replacement] } : replacement));
    await pending;
    assert.equal(Store.tasks.kept.PRODUCTION_VERSION, 'LOCAL_PV');
    assert.equal(Store.tasks.kept.row_version, 40);
    assert.equal(Store.tasks.replacement, undefined);
    assert.equal(Persistence._conflictedIds.has('kept'), true);
  });
}

test('an edit during reset preview prevents the subsequent real mutation', async () => {
  const p = await fixture();
  let release, writes = 0;
  Util.fetchTraced = async (_url, options) => {
    if (!JSON.parse(options.body).dry_run) { writes++; return ok({ results: [result] }); }
    return new Promise(resolve => { release = resolve; });
  };
  const pending = p._runWritePipeline('reset'); await turn();
  Store.updateTask('kept', { PRT_01: 'LOCAL' }, 'inspector');
  Persistence._dirtyIds.add('kept');
  release(ok({ results: [{ status: 'ok', removed_scheduled: [] }] })); await pending;
  assert.equal(writes, 0);
  assert.equal(Store.tasks.kept.PRT_01, 'LOCAL');
});

test('unchanged child receives coherent server attributes and the actual next save uses its new token', async () => {
  const p = await fixture();
  Util.fetchTraced = async () => ok({ ...result, children: [{ ...child, prt_01: 'CANONICAL_TOOL' }] });
  await p._onSaveClick();
  assert.equal(Store.tasks.kept.PRT_01, 'CANONICAL_TOOL');
  assert.equal(Store.tasks.kept.row_version, 42);
  assert.equal(Persistence._conflictedIds.has('kept'), false);
  Store.updateTask('kept', { PRT_01: 'LATER_EDIT' }, 'inspector');
  Persistence._dirtyIds.add('kept');
  let posted;
  Util.fetchTraced = async (_url, options) => {
    posted = JSON.parse(options.body);
    return ok({ status: 'ok', persisted: 1, versions: { kept: 43 } });
  };
  Persistence.saveAll(); await turn();
  assert.equal(posted.tasks[0].PRT_01, 'LATER_EDIT');
  assert.equal(posted.tasks[0].base_version, 42);
  assert.equal(Persistence._dirtyIds.has('kept'), false);
});

test('an ordinary save skips distribution conflicts while saving an unrelated task; atomic save retains both', async () => {
  const p = await fixture();
  let release;
  Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
  const pending = p._onSaveClick(); await turn();
  Store.updateTask('kept', { PRT_01: 'LOCAL' }, 'inspector');
  release(ok(result)); await pending;
  Store.tasks.unrelated = { ...Store.tasks.kept, id: 'unrelated', ORDER: '200', PARENT_ORDER: null };
  Store.rebuildPlantIndex();
  Persistence._dirtyIds.add('unrelated'); Persistence._forceIds.add('unrelated');
  let posts = [];
  Util.fetchTraced = async (_url, options) => {
    posts.push(JSON.parse(options.body));
    return ok({ status: 'ok', persisted: 1, versions: { unrelated: 41 } });
  };
  Persistence.saveAll(); await turn();
  assert.equal(posts.length, 0);
  assert.equal(Persistence._dirtyIds.has('unrelated'), true);
  Persistence._forceIds.clear();
  Persistence.saveAll(); await turn();
  assert.deepEqual(posts[0].tasks.map(task => task.id), ['unrelated']);
  assert.equal(Store.tasks.kept.PRT_01, 'LOCAL');
  assert.equal(Store.tasks.kept.row_version, 40);
  assert.equal(Persistence._dirtyIds.has('kept'), true);
});

test('a retained distribution group updates the visible unsaved count for all its children', async () => {
  const p = await fixture();
  Store.tasks.sibling = { ...Store.tasks.kept, id: 'sibling', MACHINE: 'L2' };
  Store.rebuildPlantIndex();
  let release;
  Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
  const pending = p._onSaveClick(); await turn();
  Store.updateTask('kept', { PRT_01: 'LOCAL' }, 'inspector');
  const badge = { hidden: true, textContent: '' };
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: id => id === 'schedule-unsaved' ? badge : null };
  try {
    release(ok({ ...result, children: [child, { ...child, id: 'sibling', machine: 'L2' }] }));
    await pending;
    assert.equal(badge.textContent, '2 unsaved');
    assert.equal(badge.hidden, false);
    assert.equal(Store.tasks.sibling.row_version, 40);
    assert.equal(Persistence._conflictedIds.has('sibling'), true);
  } finally { globalThis.document = originalDocument; }
});

test('a completed write for another detail applies its Store snapshot without attaching Undo to the selected order', async () => {
  const p = await fixture();
  let release;
  Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
  const pending = p._onSaveClick(); await turn();
  p.switchDetail({ header: { ...header, production_order: '200' }, shares: [] });
  release(ok({ ...result, previous_shares: [{ machine: 'L1', weight: 2, letter: 'A' }] }));
  await pending;
  assert.equal(Store.tasks.kept.row_version, 42);
  assert.equal(p.lastWrite(), null);
});

test('a detail refresh started after a write cannot restore its order after another detail is selected', async () => {
  const p = await fixture(true);
  let releaseDetail;
  Util.fetchTraced = async (_url, options) => options?.method === 'POST' ? ok(result)
    : new Promise(resolve => { releaseDetail = resolve; });
  const pending = p._onSaveClick(); await turn();
  assert.equal(typeof releaseDetail, 'function');
  const next = { header: { ...header, production_order: '200' }, shares: [] };
  p.switchDetail(next);
  releaseDetail(ok(detail)); await pending;
  assert.equal(p.detail().header.production_order, '200');
  assert.equal(p.lastWrite(), null);
});

test('a discarded detail response clears its spinner when task collection changed without a newer detail request', async () => {
  const p = await fixture(true);
  let release;
  Util.fetchTraced = () => new Promise(resolve => { release = resolve; });
  const pending = p._openDetail('100|MAT'); await turn();
  Store.setTasks([{ ...Store.tasks.kept }], 'persistence');
  assert.equal(p.detailLoading(), true);
  release(ok(detail)); await pending;
  assert.equal(p.detailLoading(), false);
});

/* ===========================================================================
   D05/D45 — What-If (Sandbox.active) gaps on _postReview/_markReviewed and
   review-status handling (Review Focus 5).
   ========================================================================= */

test('_markReviewed makes no request while What-If is active', async () => {
  const p = await fixture();
  let calls = 0;
  Util.fetchTraced = async () => { calls++; return ok({ results: [{ status: 'ok' }] }); };
  Sandbox.active = true;
  try {
    await p._markReviewed(header);
  } finally { Sandbox.active = false; }
  assert.equal(calls, 0);
});

test('_onSaveScheduleClick (banner "Save schedule") makes no Persistence.saveAll call while What-If is active', async () => {
  const p = await fixture();
  const originalSaveAll = Persistence.saveAll;
  let calls = 0;
  Persistence.saveAll = () => { calls++; };
  Sandbox.active = true;
  try {
    p._onSaveScheduleClick();
  } finally { Sandbox.active = false; Persistence.saveAll = originalSaveAll; }
  assert.equal(calls, 0);
});

test('the runtime_mismatch badge action (routed through the same gated _onSaveScheduleClick handler) makes no Persistence.saveAll call while What-If is active', async () => {
  const p = await fixture();
  const originalSaveAll = Persistence.saveAll;
  let calls = 0;
  Persistence.saveAll = () => { calls++; };
  Sandbox.active = true;
  try {
    // distribution-pane.mts's list click handler dispatches the
    // `runtime_mismatch` badge directly to _onSaveScheduleClick() (D05) —
    // exercising the shared handler here covers that call site too.
    p._onSaveScheduleClick();
  } finally { Sandbox.active = false; Persistence.saveAll = originalSaveAll; }
  assert.equal(calls, 0);
});

test('What-If switched on between a reset preview request and its response blocks the follow-up write and leaves Save disabled', async () => {
  const p = await fixture();
  let release, writeCalls = 0;
  Util.fetchTraced = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.dry_run) return new Promise(resolve => { release = resolve; });
    writeCalls++;
    return ok({ results: [result] });
  };
  const pending = p._runWritePipeline('reset');
  await turn();
  assert.equal(typeof release, 'function');
  Sandbox.active = true;
  try {
    release(ok({ results: [{ ...header, status: 'ok', removed_scheduled: [] }] }));
    await pending;
  } finally { Sandbox.active = false; }
  assert.equal(writeCalls, 0);
});

test('_markReviewed shows no success toast when the backend reports a stale header, and refetches the list', async () => {
  const p = await fixture();
  const toasts = [];
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Util.fetchTraced = async () => ok({ results: [{ status: 'stale' }] });
  await p._markReviewed(header);
  assert.ok(!toasts.some(t => t.msg === 'toast.dist_reviewed'));
  assert.ok(toasts.some(t => t.msg === 'toast.dist_stale_refetched'));
});

test('_markReviewed shows the generic failure toast (never success) when the backend reports not_found', async () => {
  const p = await fixture();
  const toasts = [];
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Util.fetchTraced = async () => ok({ results: [{ status: 'not_found' }] });
  await p._markReviewed(header);
  assert.ok(!toasts.some(t => t.msg === 'toast.dist_reviewed'));
  assert.ok(toasts.some(t => t.msg === 'toast.dist_review_failed'));
});

test('_markReviewed shows the generic failure toast (never success) on an HTTP error', async () => {
  const p = await fixture();
  const toasts = [];
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Util.fetchTraced = async () => ({ ok: false, status: 500 });
  await p._markReviewed(header);
  assert.ok(!toasts.some(t => t.msg === 'toast.dist_reviewed'));
  assert.ok(toasts.some(t => t.msg === 'toast.dist_review_failed'));
});
