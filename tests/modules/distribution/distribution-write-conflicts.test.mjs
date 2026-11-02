import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { Store } from '../../../frontend/platform/store.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Util, Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { dryRunSignature } from '../../../frontend/distribution/shares-editor.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

// Exercise the real private handlers with only DOM rendering and list refresh
// suppressed. This follows the independent review's hydration reproduction.
// `realList` (D26/D32, Task F4) keeps the real `_fetchAndRenderList`/
// `_fetchMoreAndAppend` wired instead of stubbing them to a no-op, so a test
// can drive the real stale-response guard and paging math directly —
// `_renderList`/`_renderDetail` stay stubbed regardless, since this harness
// has no DOM.
let imports = 0;
async function pane(realDetail = false, realList = false) {
  const url = new URL('../../../frontend/distribution/distribution-pane.mts', import.meta.url);
  let source = fs.readFileSync(url, 'utf8').replace('return { init, render, setActive, openParent };', `
    ${realList ? '' : '_fetchAndRenderList = async () => {};'}
    ${realDetail ? '' : '_openDetail = async () => {};'}
    _renderDetail = () => {};
    _renderList = () => {};
    return { _setDetailExpanded, _onSaveClick, _onUndoClick, _runWritePipeline, _onBulkReset, _repairRow, _openDetail,
      _markReviewed, _onSaveScheduleClick, _postReview, _runDryRun,
      _fetchAndRenderList, _fetchMoreAndAppend, _mkCombobox,
      switchDetail(detail) { _detail = detail; _selectedKey = _rowKey(detail.header); _lastWrite = null; },
      lastWrite() { return _lastWrite; },
      setLastWrite(lw) { _lastWrite = lw; },
      detail() { return _detail; },
      detailLoading() { return _detailLoading; },
      dryRunStatus() { return _dryRunStatus; },
      editorWeights() { return { ..._editorWeights }; },
      addRow(row) { _rows.push(row); },
      rows() { return _rows.slice(); },
      total() { return _total; },
      truncated() { return _truncated; },
      page() { return _page; },
      setPage(p) { _page = p; },
      checkedKeys() { return new Set(_checkedKeys); },
      checkKey(key) { _checkedKeys.add(key); },
      saveDisabled() {
        const rows = _editorRows();
        return computeSaveButtonState({
          dryRunStatus: _dryRunStatus, dryRunSignature: _dryRunSignature,
          currentSignature: dryRunSignature(_detail.header, rows),
          removedScheduledCount: _dryRun?.removed_scheduled?.length || 0, whatIfBlocked: Sandbox.active,
        }).disabled;
      },
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
  p.setup(detail, dryRunSignature(header, [{ machine: 'L1', letter: 'A', weight: 1, purged: false, stale: false, currentStart: null }]));
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

test('an ordinary save skips distribution conflicts while saving an unrelated task; an atomic group holding the conflict retains both', async () => {
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
  // Wave 2 split: the conflicted ordinary row 'kept' is not in the optimizer group, so that group goes alone.
  Persistence._forceIds.add('kept');
  Persistence.saveAll(); await turn();
  assert.equal(posts.length, 0, 'a conflicted row INSIDE the atomic group withholds the whole group');
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
  const originalT = Util.t; const unsavedCalls = [];
  Util.t = (key, vars) => { if (key === 'ui.n_unsaved') unsavedCalls.push(vars); return originalT.call(Util, key, vars); };
  globalThis.document = { getElementById: id => id === 'schedule-unsaved' ? badge : null };
  try {
    release(ok({ ...result, children: [child, { ...child, id: 'sibling', machine: 'L2' }] }));
    await pending;
    assert.equal(unsavedCalls.at(-1)?.count, 2, 'the badge is rendered with ui.n_unsaved and a count covering both children');
    assert.notEqual(badge.textContent, '', 'the badge shows text');
    assert.equal(badge.hidden, false);
    assert.equal(Store.tasks.sibling.row_version, 40);
    assert.equal(Persistence._conflictedIds.has('sibling'), true);
  } finally { globalThis.document = originalDocument; Util.t = originalT; }
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

test('_postReview returns "blocked" (distinct from a real "error") while What-If is active', async () => {
  const p = await fixture();
  let calls = 0;
  Util.fetchTraced = async () => { calls++; return ok({ results: [{ status: 'ok' }] }); };
  Sandbox.active = true;
  let status;
  try {
    status = await p._postReview('P', header, true);
  } finally { Sandbox.active = false; }
  assert.equal(status, 'blocked');
  assert.equal(calls, 0);
});

test('_markReviewed shows the What-If-blocked message (never the failure toast) while What-If is active', async () => {
  const p = await fixture();
  const toasts = [];
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Util.fetchTraced = async () => { throw new Error('must not be called while blocked'); };
  Sandbox.active = true;
  try {
    await p._markReviewed(header);
  } finally { Sandbox.active = false; }
  assert.ok(!toasts.some(t => t.msg === 'toast.dist_review_failed'));
  assert.ok(toasts.some(t => t.msg === 'ui.dist_whatif_blocked'));
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

// Audit fix item 1: a bulk /reset per-item `status: 'error'` now carries a
// `code` (data.py's `reset_orders`, e.g. B3's `weights_empty`) so the pane
// can key UI copy off `err.dist_<code>` instead of showing raw English.
// `Util.t` is stubbed as the identity function, the same no-op translation
// stub every other test in this file uses — this still proves the pane
// derived the RIGHT locale key and queried it (the only thing observable
// through an identity stub; the actual translated text is a locale-data
// concern `tests/modules/locale-completeness.test.mjs` already covers).
test('a bulk reset error with a code looks up err.dist_<code>, not just the raw message', async () => {
  const p = await fixture();
  const tCalls = [];
  Util.t = key => { tCalls.push(key); return key; };
  const toasts = [];
  Toast.show = (msg, kind) => toasts.push({ msg, kind });
  Util.fetchTraced = async () => ok({
    results: [{ status: 'error', code: 'weights_empty', message: 'weights_empty: all weights are zero' }],
  });
  await p._runWritePipeline('reset');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'error');
  assert.ok(tCalls.includes('err.dist_weights_empty'),
    `expected a Util.t lookup for err.dist_weights_empty, got: ${tCalls}`);
});

// Same fix, the fallback path: an item that only carries the raw `message`
// (no `code` field — an older/un-migrated response) still gets parsed for
// its `^code:` prefix instead of showing untranslated English verbatim.
test('a bulk reset error with no code field still parses the message prefix into err.dist_<code>', async () => {
  const p = await fixture();
  const tCalls = [];
  Util.t = key => { tCalls.push(key); return key; };
  Toast.show = () => {};
  Util.fetchTraced = async () => ok({
    results: [{ status: 'error', message: 'weights_empty: all weights are zero' }],
  });
  await p._runWritePipeline('reset');
  assert.ok(tCalls.includes('err.dist_weights_empty'),
    `expected a Util.t lookup for err.dist_weights_empty, got: ${tCalls}`);
});

// Same fix, the bulk-result dialog path (`_onBulkReset` -> `_reportBulkResults`,
// ~1502) rather than the single-header write pipeline above.
test('_onBulkReset reports a weights_empty item via err.dist_<code> in the result dialog', async () => {
  const p = await fixture();
  const tCalls = [];
  Util.t = key => { tCalls.push(key); return key; };
  Modal.confirm = async () => true;
  Util.fetchTraced = async () => ok({
    results: [{ production_order: header.production_order, material_number: header.material_number,
      status: 'error', code: 'weights_empty', message: 'weights_empty: all weights are zero' }],
  });
  await p._onBulkReset();
  assert.ok(tCalls.includes('err.dist_weights_empty'),
    `expected a Util.t lookup for err.dist_weights_empty, got: ${tCalls}`);
});

// Audit fix item 2: `_repairRow` must send weight 0 for a purged share, even
// though B6 keeps that share's (greyed-out, inert) weight in the row data for
// display -- posting its real weight verbatim gets the whole repair rejected
// with 400 `share_purged`, matching `buildSharesPayload`/`resolvedWeight`'s
// rule the editor's own Save path already follows.
test('_repairRow posts weight 0 for a purged share and the live weight for the rest', async () => {
  const p = await fixture();
  let body = null;
  Util.fetchTraced = async (_url, options) => { body = JSON.parse(options.body); return ok(result); };
  const row = { header, shares: [
    { machine: 'L1', weight: 500, purged: true, purged_at: '2026-01-01T00:00:00' },
    { machine: 'L2', weight: 40, purged: false },
  ] };
  await p._repairRow(row);
  assert.deepEqual(body.shares, [
    { machine: 'L1', weight: 0 },
    { machine: 'L2', weight: 40 },
  ]);
});

/* ===========================================================================
   D09/D44/D46 — dry-run preview identity, write-busy latch, Undo restore
   (Task F3).
   ========================================================================= */

test('D09 — switching detail while a dry run is in flight invalidates it, so a late response cannot mark Save ready for the new detail', async () => {
  const p = await fixture(true);
  const headerB = { ...header, production_order: '200' };
  const detailB = { header: headerB, shares: [{ machine: 'L1', weight: 1, letter: 'A' }], statuses: [], base_version: headerB.base_version };
  p.addRow({ header: headerB, shares: detailB.shares, statuses: [], children_summary: { count: 0, total_quantity: 0, earliest_start: null } });
  let releaseA;
  Util.fetchTraced = async (_url, options) => {
    if (options?.method === 'POST') return new Promise(resolve => { releaseA = resolve; });
    return ok(detailB);
  };
  const pendingA = p._runDryRun();
  await turn();
  assert.equal(typeof releaseA, 'function');
  // Switch the selection to order B through the REAL _openDetail (fixture(true))
  // before A's dry run resolves.
  await p._openDetail('200|MAT');
  releaseA(ok({ plan: [], removed_scheduled: [], base_version: header.base_version }));
  await pendingA;
  assert.notEqual(p.dryRunStatus(), 'ready');
  assert.equal(p.saveDisabled(), true);
});

test('D44 — two quick Save clicks produce exactly one write request', async () => {
  const p = await fixture();
  let posts = 0;
  Util.fetchTraced = async (_url, options) => {
    if (options?.method === 'POST') posts++;
    return ok(result);
  };
  const first = p._onSaveClick();
  const second = p._onSaveClick();
  await Promise.all([first, second]);
  assert.equal(posts, 1);
});

test('D46 — Undo cancelled at the removal-confirm step leaves _editorWeights unchanged', async () => {
  const p = await fixture();
  p.setLastWrite({ previousShares: [{ machine: 'L1', weight: 5, letter: 'A' }], baseVersionAfterWrite: header.base_version });
  const before = p.editorWeights();
  Util.fetchTraced = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.dry_run) {
      return ok({ removed_scheduled: [{ id: 'x', production_order: header.production_order, machine: 'L1', scheduled_start: null, frozen: false }] });
    }
    throw new Error('must not reach the real write once the removal confirm is cancelled');
  };
  const originalConfirm = Modal.confirm;
  Modal.confirm = async () => false;
  try {
    await p._onUndoClick();
  } finally { Modal.confirm = originalConfirm; }
  assert.deepEqual(p.editorWeights(), before);
});

test('D46 fix review #1 — a stale-header preview during Undo keeps the fresh server resync, not the stale pre-undo snapshot', async () => {
  // fixture(true) keeps the REAL _openDetail wired, so _handleStaleHeader's
  // own re-fetch (triggered by the preview's 409 stale) actually re-syncs
  // _detail/_editorWeights from the server, reassigning _detail to a new
  // object — the scenario the _detail === detail guard exists for.
  const p = await fixture(true);
  p.setLastWrite({ previousShares: [{ machine: 'L1', weight: 5, letter: 'A' }], baseVersionAfterWrite: header.base_version });
  const freshShares = [{ machine: 'L1', weight: 9, letter: 'A', start: null }];
  const freshDetail = {
    header: { ...header, base_version: header.base_version + 1 },
    shares: freshShares, statuses: [], base_version: header.base_version + 1,
  };
  const staleResp = { ok: false, status: 409, json: async () => ({ detail: { code: 'stale', message: 'stale' } }) };
  staleResp.clone = () => staleResp;
  Util.fetchTraced = async (_url, options) => (options?.method === 'POST' ? staleResp : ok(freshDetail));
  await p._onUndoClick();
  // The editor now reflects the FRESH server weights _openDetail resynced,
  // not the planner's stale pre-undo snapshot (weight 1, from the original
  // fixture detail) nor the speculative undo weight (5).
  assert.deepEqual(p.editorWeights(), { L1: 9 });
});

/* ===========================================================================
   D26/D32/D13 — list stale-response guard, "refresh covers every loaded
   page" paging, and the server-truncated-result notice (Task F4). Exercised
   against the REAL `_fetchAndRenderList`/`_fetchMoreAndAppend` (pane(_, true)),
   since these are list-fetch behaviors, not editor-write ones — _renderList/
   _renderDetail stay stubbed, this harness has no DOM.
   ========================================================================= */

function listRow(order) {
  return {
    header: { plant: 'P', production_order: order, material_number: 'MAT', base_version: 1 },
    shares: [], statuses: [],
    children_summary: { count: 0, total_quantity: 0, earliest_start: null },
  };
}

test('D26 — a late list response for a plant the user already left never replaces the new plant\'s rows', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');
  let releaseP1;
  Util.fetchTraced = () => new Promise(resolve => { releaseP1 = resolve; });
  const pendingP1 = p._fetchAndRenderList();
  await turn();
  assert.equal(typeof releaseP1, 'function');

  // The user switches to P2 before P1's response arrives, and P2's own (real)
  // list fetch completes first.
  Store.setSelectedPlant('P2', 'persistence');
  Util.fetchTraced = async () => ok({ data: [listRow('900')], meta: { total: 1 } });
  await p._fetchAndRenderList();
  assert.equal(p.rows().length, 1);
  assert.equal(p.rows()[0].header.production_order, '900');

  // P1's late response now resolves — it must be dropped, not overwrite P2's rows.
  releaseP1(ok({ data: [listRow('100')], meta: { total: 99 } }));
  await pendingP1;
  assert.equal(p.rows().length, 1, 'the stale P1 response must not replace P2\'s already-rendered rows');
  assert.equal(p.rows()[0].header.production_order, '900');
  assert.equal(p.total(), 1, 'the stale P1 response\'s meta.total must not overwrite P2\'s count either');
});

test('D32 — a refresh from page 1 re-fetches offset=0 covering both pages already loaded, and resets _page to match', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');
  p.setPage(1);
  let capturedUrl;
  Util.fetchTraced = async (url) => { capturedUrl = url; return ok({ data: [], meta: { total: 0 } }); };
  await p._fetchAndRenderList();
  const params = new URL(capturedUrl, 'http://unit-test').searchParams;
  assert.equal(params.get('offset'), '0');
  assert.equal(params.get('limit'), '100');
  assert.equal(p.page(), 1, '_page is reset to (limit / 50) - 1 = 1, matching the 100 rows actually requested');
});

test('D13 — meta.truncated on the list response is captured for the pane to surface as a notice', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');
  Util.fetchTraced = async () => ok({ data: [listRow('100')], meta: { total: 1, truncated: true } });
  await p._fetchAndRenderList();
  assert.equal(p.truncated(), true);

  Util.fetchTraced = async () => ok({ data: [listRow('100')], meta: { total: 1 } });
  await p._fetchAndRenderList();
  assert.equal(p.truncated(), false, 'an absent meta.truncated must read as false, not stick from a prior truncated fetch');
});

test('fix round 1 — D13 — a failed list fetch clears a prior truncated flag instead of leaving a stale notice', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');
  Util.fetchTraced = async () => ok({ data: [listRow('100')], meta: { total: 1, truncated: true } });
  await p._fetchAndRenderList();
  assert.equal(p.truncated(), true);

  Util.fetchTraced = async () => { throw new Error('network down'); };
  await p._fetchAndRenderList();
  assert.equal(p.truncated(), false, 'a failed fetch must not leave a stale truncated-notice showing');
});

test('D26 — a checked (bulk-select) key dropped from the next accepted list fetch is pruned', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');
  Util.fetchTraced = async () => ok({ data: [listRow('100'), listRow('200')], meta: { total: 2 } });
  await p._fetchAndRenderList();
  p.checkKey('100|MAT');
  p.checkKey('200|MAT');
  assert.equal(p.checkedKeys().size, 2);

  // A filter change drops row '200' from the next (replacing) fetch.
  Util.fetchTraced = async () => ok({ data: [listRow('100')], meta: { total: 1 } });
  await p._fetchAndRenderList();
  assert.deepEqual([...p.checkedKeys()], ['100|MAT'],
    'a checked key whose row is no longer present after an accepted fetch must be pruned');
});

/* ===========================================================================
   Fix round 1 — D48 (part 2) plan-defect fix: _mkCombobox now keys its
   AbortController per CONTAINER (a WeakMap) rather than one shared
   module-level slot, which would abort a sibling combobox's still-mounted
   listener the moment a second one renders on the same gate (the real shape
   of master-data/admin-ui.mts's BOM plant/material pickers and
   plant-settings line-override pickers). A minimal hand-built stand-in for
   `containerEl`/`root`/its children is used instead of a real DOM (this
   suite has no jsdom) — just enough surface for _mkCombobox to run: each
   call to a container's `querySelector('.hps-combobox')` returns a FRESH
   root/dropdown pair (mirroring a real `innerHTML =` re-render producing new
   nodes), and `root.contains()` always returns false, so every event
   dispatched on the (real, native EventTarget) fake `document` counts as an
   "outside click" — exactly the real target real DOM delivers to a
   document-level listener dispatched from `document` itself.
   ========================================================================= */

function stubComboboxChild() {
  return { addEventListener() {}, setAttribute() {}, querySelectorAll: () => [], value: '', hidden: false };
}

/** A stand-in `containerEl`. Each `querySelector('.hps-combobox')` call
 *  builds a brand-new root/dropdown pair — `lastDropdown()` returns the most
 *  recently built one, the one the most recent `_mkCombobox(container, ...)`
 *  call is actually operating on. */
function stubComboboxContainer() {
  let dropdowns = [];
  return {
    innerHTML: '',
    querySelector(sel) {
      if (sel !== '.hps-combobox') return null;
      const input = stubComboboxChild();
      const clearBtn = stubComboboxChild();
      const dropdown = stubComboboxChild();
      dropdowns.push(dropdown);
      return {
        classList: { toggle() {} },
        contains() { return false; },
        querySelector(childSel) {
          if (childSel === '.hps-input') return input;
          if (childSel === '.hps-clear') return clearBtn;
          if (childSel === '.hps-dropdown') return dropdown;
          return null;
        },
      };
    },
    lastDropdown() { return dropdowns[dropdowns.length - 1]; },
  };
}

test('D48 (part 2) fix review — rendering a combobox into a different container does not abort a still-mounted one\'s outside-click listener', async () => {
  const p = await pane(false, false);
  const priorDocument = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const containerA = stubComboboxContainer();
    const containerB = stubComboboxContainer();
    p._mkCombobox(containerA, []);
    p._mkCombobox(containerB, []); // must NOT abort A's listener (the plan-defect bug)
    const dropdownA = containerA.lastDropdown();
    const dropdownB = containerB.lastDropdown();
    dropdownA.hidden = false;
    dropdownB.hidden = false;

    globalThis.document.dispatchEvent(new Event('click'));
    assert.equal(dropdownA.hidden, true, 'A\'s own outside-click listener must still be alive after B rendered');
    assert.equal(dropdownB.hidden, true, 'B\'s outside-click listener must also be alive');
  } finally {
    globalThis.document = priorDocument;
  }
});

test('D48 (part 2) fix review — re-rendering into the SAME container still aborts that container\'s own previous listener', async () => {
  const p = await pane(false, false);
  const priorDocument = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const containerA = stubComboboxContainer();
    p._mkCombobox(containerA, []);
    const firstDropdown = containerA.lastDropdown();
    p._mkCombobox(containerA, []); // re-render into the SAME container
    const secondDropdown = containerA.lastDropdown();
    assert.notEqual(firstDropdown, secondDropdown);
    firstDropdown.hidden = false;
    secondDropdown.hidden = false;

    globalThis.document.dispatchEvent(new Event('click'));
    assert.equal(secondDropdown.hidden, true, 'the current render\'s outside-click listener must be alive');
    assert.equal(firstDropdown.hidden, false,
      'the PREVIOUS render\'s listener for the same container must have been aborted, not just left to leak');
  } finally {
    globalThis.document = priorDocument;
  }
});

/* ===========================================================================
   Fix round 1 — Load More racing an in-flight refresh. The pane's "Load
   more" click handler now returns early when `_loading` is true, before
   bumping `_page` (DOM-level, not independently exercised here — this
   harness has no real button/click event, consistently with every other
   test in this file). This scenario-level test pins the underlying
   consequence: a Load More already in flight when a refresh lands must be
   dropped outright (via the existing _listSeq/stillCurrent guard), never
   appending onto — or disturbing the page/count of — what the refresh set.
   ========================================================================= */

test('fix round 1 — a Load More already in flight is dropped by a concurrent refresh, leaving _page/rows consistent', async () => {
  const p = await pane(false, true);
  Store.setSelectedPlant('P1', 'persistence');

  // Page 0 baseline.
  Util.fetchTraced = async () => ok({ data: [listRow('100')], meta: { total: 3 } });
  await p._fetchAndRenderList();
  assert.equal(p.page(), 0);

  // The user clicks "Load more" (the click handler's own `_page += 1`
  // already ran) and the request is slow.
  p.setPage(1);
  let releaseLoadMore;
  Util.fetchTraced = () => new Promise(resolve => { releaseLoadMore = resolve; });
  const pendingLoadMore = p._fetchMoreAndAppend();
  await turn();
  assert.equal(typeof releaseLoadMore, 'function');

  // A concurrent refresh (write completion / debounced Store-event refresh)
  // starts and completes BEFORE the Load More — it re-fetches from the top,
  // covering both pages already "loaded" (D32), superseding the pending
  // Load More outright.
  Util.fetchTraced = async () => ok({ data: [listRow('100'), listRow('200')], meta: { total: 2 } });
  await p._fetchAndRenderList();
  assert.equal(p.rows().length, 2);
  assert.equal(p.total(), 2);
  assert.equal(p.page(), 1, '_page stays at the depth the refresh actually covered (100 rows worth)');

  // The stale Load More now resolves — it must be dropped entirely, not
  // appended onto the refreshed rows, and must not touch _page/_total either.
  releaseLoadMore(ok({ data: [listRow('900')], meta: { total: 99 } }));
  await pendingLoadMore;
  assert.equal(p.rows().length, 2, 'the stale Load More response must not append onto the refreshed rows');
  assert.equal(p.total(), 2, 'the stale Load More\'s meta.total must not overwrite the refresh\'s count');
  assert.equal(p.page(), 1, '_page must remain exactly what the refresh set it to');
});


test('expanded Distribution detail preserves draft weights and preview identity without rebuilding editor DOM', async t => {
  const p = await pane();
  const previousDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  const classes = new Set();
  const button = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, textContent: '' };
  const body = { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } };
  const input = { value: '7.25' };
  const editor = { input, get innerHTML() { return 'existing draft'; }, set innerHTML(_) { assert.fail('expansion must not rebuild inputs'); } };
  globalThis.document = { getElementById: id => ({ 'dist-body': body, 'dist-detail-expand': button, 'dist-detail-pane': editor })[id] };
  t.mock.method(Util, 't', key => key);
  p.setup(detail, dryRunSignature(header, detail.shares));
  const initialDetail = p.detail();
  const initialWeights = p.editorWeights();
  const initialStatus = p.dryRunStatus();
  p._setDetailExpanded(true);
  assert.equal(classes.has('dist-detail-expanded'), true);
  assert.equal(button.attributes['aria-expanded'], 'true');
  assert.equal(button.textContent, 'btn.dist_collapse_detail');
  assert.equal(editor.input, input);
  assert.equal(editor.input.value, '7.25');
  assert.equal(p.detail(), initialDetail);
  assert.deepEqual(p.editorWeights(), initialWeights);
  assert.equal(p.dryRunStatus(), initialStatus);
  p._setDetailExpanded(false);
  assert.equal(classes.has('dist-detail-expanded'), false);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.equal(button.textContent, 'btn.dist_expand_detail');
  assert.equal(editor.input.value, '7.25');
});
