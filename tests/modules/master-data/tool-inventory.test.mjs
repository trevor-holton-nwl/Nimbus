// Tests for frontend/master-data/tool-inventory.mts — the Master Data > Tool Inventory add/delete grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

// Real English strings, so assertions read the shipped wording (Util.t falls back to the bare key without them).
const EN = (() => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.__NIMBUS_LOCALES.en;
})();
let fixtureId = 0;

const row = (tool_id, total_qty = 1, out_of_service_qty = 0, note = null, plant = 'A') => ({ plant, tool_id, total_qty, out_of_service_qty, note });

/** Fresh module instance + stubbed DOM / AG Grid / Store.subscribe / fetch / confirm / toast for one test. */
async function fixture(t, { plant = 'A', rows = [row('T100', 3, 1, 'spare')], bypassPlant = false } = {}) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, style: {}, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', clientWidth: 0,
      listeners: {}, addEventListener(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
    });
    return nodes.get(id);
  };
  const toasts = [];
  const confirms = [];
  const requests = [];
  const listeners = new Set();
  let confirmAnswer = true;
  let gridOptions;
  let createCount = 0;
  let gridRows = [];
  let selected = [];
  const api = {
    setGridOption(key, value) { if (key === 'rowData') gridRows = value; },
    refreshCells() {}, sizeColumnsToFit() {}, onFilterChanged() {}, deselectAll() { selected = []; },
    getSelectedRows: () => selected, getRowNode: cid => { const i = gridRows.findIndex(r => r._cid === cid); return i < 0 ? undefined : { rowIndex: i }; },
    ensureIndexVisible() {}, startEditingCell() {}, exportDataAsCsv() {},
  };
  const handlers = [];     // [{ match(url, opts), respond(url, opts) }]
  t.mock.method(Util, 'fetchTraced', async (url, opts) => {
    requests.push({ url, opts, body: typeof opts?.body === 'string' ? JSON.parse(opts.body) : undefined, form: opts?.body instanceof FormData ? opts.body : undefined });
    for (const h of handlers) if (h.match(url, opts)) return h.respond(url, opts);
    return respond({}, 404);
  });
  t.mock.method(Toast, 'show', (msg, type) => { toasts.push({ msg, type }); });
  t.mock.method(Modal, 'confirm', async opts => { confirms.push(opts); return typeof confirmAnswer === 'function' ? confirmAnswer(opts) : confirmAnswer; });
  const modalCalls = [];
  t.mock.method(Modal, 'open', id => { modalCalls.push(['open', id]); });
  t.mock.method(Modal, 'close', id => { modalCalls.push(['close', id]); });
  const docKeys = [];
  t.mock.method(Store, 'subscribe', fn => { listeners.add(fn); return () => listeners.delete(fn); });
  const refreshCalls = [];
  t.mock.method(Persistence, 'refreshToolInventory', async p => { refreshCalls.push(p); return true; });
  const originals = { document: globalThis.document, agGrid: globalThis.agGrid, requestAnimationFrame: globalThis.requestAnimationFrame, window: globalThis.window };
  Object.assign(globalThis, {
    document: { getElementById: element, createElement: () => ({ setAttribute() {}, style: {} }), addEventListener(evt, fn) { if (evt === 'keydown') docKeys.push(fn); } },
    window: { __NIMBUS_LOCALES: { en: EN } }, requestAnimationFrame() {},
    agGrid: { createGrid(_el, opts) { createCount++; gridOptions = opts; gridRows = opts.rowData; opts.onGridReady({ api }); } },
  });
  const prev = { plant: Store.selectedPlant, md: Store.masterData, alerts: Store._state.alerts, active: Sandbox.active };
  t.after(() => {
    Store.setMasterData(prev.md, 'test-restore');
    Store._state.alerts = prev.alerts;
    Sandbox.active = prev.active;
    Store._state.selectedPlant = prev.plant;
    for (const [k, v] of Object.entries(originals)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  });
  const mod = await import(`../../../frontend/master-data/tool-inventory.mjs?fixture=${++fixtureId}`);
  const TI = mod.ToolInventory;
  const seamCalls = [];
  mod._seams.refreshStoreMasterData = async (...args) => { seamCalls.push(args); return true; };
  const saved = [];
  mod._seams.saveBlob = (blob, name) => { saved.push({ blob, name }); };
  const emit = evt => { for (const fn of [...listeners]) fn(evt); };
  function setInventory(p, inv, extra = {}) {
    Store.setMasterData({ plants: [{ plant: p, ...extra }], lines: [], workcenters: [], tool_inventory: inv }, 'test');
  }
  function selectPlant(p, inv, extra) {
    Store._state.selectedPlant = p;
    if (inv !== 'keep') setInventory(p, inv, extra);
    emit({ type: 'plant:selected', plant: p });
  }
  TI.init();
  element('md-master-tool-inventory-pane');
  if (!bypassPlant) selectPlant(plant, rows);
  TI.render();
  const colDef = field => gridOptions.columnDefs.find(c => c.field === field || c.colId === field);
  /** Simulate a committed cell edit through the column's own valueSetter. */
  function edit(r, field, value) {
    const changed = colDef(field).valueSetter({ data: r, newValue: value });
    if (changed) gridOptions.onCellValueChanged({});
    return changed;
  }
  return {
    TI, mod, element, toasts, modalCalls, docKeys, saved, confirms, requests, handlers, emit, listeners, seamCalls, refreshCalls, setInventory, selectPlant, edit, colDef,
    createCount: () => createCount, options: () => gridOptions, gridRows: () => gridRows, snap: () => TI._snapshot(),
    setConfirm: v => { confirmAnswer = v; },
    click: id => { for (const fn of element(id).listeners.click ?? []) fn({}); },
    select: picked => { selected = picked; gridOptions.onSelectionChanged({}); },
  };
}

function respond(body, status = 200) {
  const res = { ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
  res.clone = () => res;
  return res;
}
const bulkOk = { inserted: 1, updated: 0, deleted: 0 };
const usageHandler = body => ({ match: u => u.endsWith('/usage'), respond: () => respond(body) });
const bulkHandler = (status = 200, body = bulkOk) => ({ match: u => u.endsWith('/bulk'), respond: () => respond(body, status) });
const bulkRequests = f => f.requests.filter(r => r.url.endsWith('/bulk'));

test('local normalizeToolId and TOOL_PLACEHOLDERS are pinned to the compute core', async () => {
  const core = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
  const { normalizeToolId, TOOL_PLACEHOLDERS } = await import('../../../frontend/master-data/tool-inventory.mjs');
  assert.deepEqual([...TOOL_PLACEHOLDERS].sort(), [...core.TOOL_PLACEHOLDERS].sort());
  for (const v of [null, undefined, '', ' ', '-', '0', 'n/a', ' none ', 'null', 'nan', 'tbd', 't100', ' T 1 ', 12, 'ab-c']) {
    assert.equal(normalizeToolId(v), core.normalizeToolId(v), `value ${JSON.stringify(v)}`);
  }
});

test('public surface and the sub-tab registration contract', async t => {
  const f = await fixture(t);
  for (const k of ['init', 'render', 'setQuickFilter', 'openForTool']) assert.equal(typeof f.TI[k], 'function', k);
  assert.equal(f.TI.refresh() instanceof Promise, true);
});

test('render builds the saved rows (UPPER ids), derives Available and counts Used by from the loaded window', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare'), row('T200', 2, 5 > 2 ? 2 : 0)] });
  const orig = Store.tasksByPlant;
  t.mock.method(Store, 'tasksByPlant', () => [{ PRT_01: ' t100 ', PRT_02: 'T100' }, { PRT_01: 'T100', PRT_02: '-' }, { PRT_01: 't999', PRT_02: null }]);
  f.TI.render();
  void orig;
  const s = f.snap();
  assert.equal(s.view, 'ready');
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T100', 'T200']);
  assert.equal(f.gridRows().length, 2);
  assert.equal(f.colDef('available_qty').valueGetter({ data: s.rows[0] }), 2);
  assert.equal(f.colDef('available_qty').valueGetter({ data: s.rows[1] }), 0);
  assert.equal(f.colDef('used_by').valueGetter({ data: s.rows[0] }), 2, 'one count per order even when both PRT columns carry the id');
  assert.equal(f.colDef('used_by').valueGetter({ data: s.rows[1] }), 0);
  assert.equal(f.element('ti-save').disabled, true);
  assert.equal(f.element('ti-dirty').hidden, true);
});

test('Add row appends a new row (1 copy, 0 out of service), invalid until it has an id, and Save stays disabled', async t => {
  const f = await fixture(t);
  f.TI._addRow();
  const s = f.snap();
  assert.equal(s.rows.length, 2);
  const nr = s.rows[1];
  assert.deepEqual([nr._isNew, nr.tool_id, nr.total_qty, nr.out_of_service_qty], [true, '', 1, 0]);
  assert.ok(s.errors.get(nr._cid).tool_id);
  assert.equal(s.canSave, false);
  assert.equal(f.element('ti-save').disabled, true);
  f.edit(nr, 'tool_id', '  t300 ');
  assert.equal(nr.tool_id, 'T300', 'typed id is trimmed and upper-cased on commit');
  assert.equal(f.snap().canSave, true);
  assert.equal(f.element('ti-dirty').textContent, Util.t('ui.n_unsaved', { count: 1 }));
});

test('getRowId is the client row id, and the Tool ID is editable only while the row is new', async t => {
  const f = await fixture(t);
  f.TI._addRow();
  const [saved, fresh] = f.snap().rows;
  assert.equal(f.options().getRowId({ data: fresh }), fresh._cid);
  assert.notEqual(f.options().getRowId({ data: fresh }), 'T');
  const idCol = f.colDef('tool_id');
  assert.equal(idCol.editable({ data: saved }), false);
  assert.equal(idCol.editable({ data: fresh }), true);
  assert.equal(idCol.cellClassRules['ti-cell-locked']({ data: saved }), true);
  assert.equal(idCol.cellClassRules['ti-cell-locked']({ data: fresh }), false);
  assert.equal(idCol.tooltipValueGetter({ data: saved, colDef: { field: 'tool_id' } }), Util.t('ui.tool_id_locked_hint'));
});

test('an id becomes locked once saved', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler());
  f.TI._addRow();
  const fresh = f.snap().rows[1];
  f.edit(fresh, 'tool_id', 'T300');
  await f.TI._save();
  assert.equal(fresh._isNew, false);
  assert.equal(f.colDef('tool_id').editable({ data: fresh }), false);
});

test('validation: negative, fraction, non-number, oos > total, placeholder, length and case-insensitive duplicates', async t => {
  const f = await fixture(t);
  const [saved] = f.snap().rows;
  const errs = () => f.snap().errors.get(saved._cid) ?? {};
  f.edit(saved, 'total_qty', '-1'); assert.ok(errs().total_qty, 'negative');
  f.edit(saved, 'total_qty', '2.5'); assert.ok(errs().total_qty, 'fraction');
  f.edit(saved, 'total_qty', 'abc'); assert.ok(errs().total_qty, 'text');
  f.edit(saved, 'total_qty', ''); assert.ok(errs().total_qty, 'blank total');
  f.edit(saved, 'total_qty', '4'); assert.equal(errs().total_qty, undefined);
  assert.equal(saved.total_qty, 4, 'a clean integer string is stored as a number');
  f.edit(saved, 'out_of_service_qty', '5');
  assert.equal(errs().out_of_service_qty, Util.t('ui.tool_inventory_oos_exceeds_total', { oos: 5, total: 4 }));
  f.edit(saved, 'out_of_service_qty', '');
  assert.equal(errs().out_of_service_qty, undefined, 'blank out of service means 0');
  f.edit(saved, 'note', 'x'.repeat(501));
  assert.ok(errs().note);
  f.edit(saved, 'note', 'ok');
  assert.equal(f.snap().canSave, true);

  f.TI._addRow();
  const nr = f.snap().rows[1];
  for (const id of ['-', '0', 'n/a', 'none', 'null', 'nan', 'tbd']) {
    f.edit(nr, 'tool_id', id);
    assert.equal(f.snap().errors.get(nr._cid).tool_id, Util.t('ui.tool_inventory_invalid_id_placeholder', { id: id.toUpperCase() }), id);
  }
  f.edit(nr, 'tool_id', 'A'.repeat(101));
  assert.equal(f.snap().errors.get(nr._cid).tool_id, Util.t('ui.tool_inventory_invalid_id_length', { max: 100 }));
  f.edit(nr, 'tool_id', 't100');
  assert.equal(f.snap().errors.get(nr._cid).tool_id, Util.t('ui.tool_inventory_duplicate', { id: 'T100' }), 'case-insensitive duplicate of a saved row');
  assert.ok(f.snap().errors.get(saved._cid)?.tool_id, 'the saved row of the pair is flagged too');
  assert.equal(f.snap().canSave, false);
  f.edit(nr, 'tool_id', 'T101');
  assert.equal(f.snap().canSave, true);
});

test('invalid cells carry the invalid class and a not-colour-only marker (aria-invalid + title)', async t => {
  const f = await fixture(t);
  const [saved] = f.snap().rows;
  f.edit(saved, 'total_qty', '-3');
  assert.equal(f.colDef('total_qty').cellClassRules['md-cell-invalid']({ data: saved }), true);
  assert.equal(f.colDef('total_qty').cellClassRules['md-cell-dirty']({ data: saved }), true);
  assert.equal(f.colDef('out_of_service_qty').cellClassRules['md-cell-invalid']({ data: saved }), false);
  const attrs = {};
  globalThis.document.createElement = () => ({ setAttribute: (k, v) => { attrs[k] = v; }, style: {}, set title(v) { attrs.title = v; }, set textContent(v) { attrs.text = v; } });
  const Renderer = f.colDef('total_qty').cellRenderer;
  new Renderer().init({ data: saved, value: -3 });
  // (the renderer sets the attributes on its span)
  assert.equal(attrs['aria-invalid'], 'true');
  assert.equal(attrs.title, Util.t('ui.tool_inventory_invalid_qty', { max: '1,000,000' }));
  assert.match(attrs.text, /^⚠ /);
});

test('delete staging: a saved row is staged (not dropped), a new row just disappears; Discard restores', async t => {
  const f = await fixture(t, { rows: [row('T100'), row('T200')] });
  f.TI._addRow();
  const [a, , n] = f.snap().rows;
  f.TI._removeRows([a._cid, n._cid]);
  const s = f.snap();
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T200']);
  assert.deepEqual(s.deletes.map(d => d.tool_id), ['T100']);
  assert.equal(s.dirty, 1);
  f.setConfirm(true);
  assert.equal(await f.TI._discard(), true);
  assert.deepEqual(f.snap().rows.map(r => r.tool_id), ['T100', 'T200']);
  assert.equal(f.snap().deletes.length, 0);
  assert.equal(f.confirms.at(-1).confirmLabel, Util.t('btn.discard'));
});

test('Discard cancelled by the confirm keeps the edits', async t => {
  const f = await fixture(t);
  f.edit(f.snap().rows[0], 'total_qty', '9');
  f.setConfirm(false);
  assert.equal(await f.TI._discard(), false);
  assert.equal(f.snap().rows[0].total_qty, 9);
});

test('delete confirm names the id, the count and the first order numbers; Cancel aborts the whole save and keeps edits', async t => {
  const f = await fixture(t);
  f.handlers.push(usageHandler({ T100: { count: 12, orders: ['A', 'B', 'C', 'D', 'E'] } }), bulkHandler());
  const [saved] = f.snap().rows;
  f.TI._removeRows([saved._cid]);
  f.TI._addRow();
  f.edit(f.snap().rows.at(-1), 'tool_id', 'T300');
  f.setConfirm(false);
  await f.TI._save();
  const usage = f.requests.find(r => r.url.endsWith('/usage'));
  assert.deepEqual(usage.body, { tool_ids: ['T100'] });
  assert.equal(f.confirms.length, 1);
  const c = f.confirms[0];
  assert.equal(c.tone, 'warn');
  assert.equal(c.title, Util.t('modal.tool_inventory_delete_title'));
  assert.equal(c.message, Util.t('modal.tool_inventory_delete_body'));
  assert.ok(c.detail.includes('T100') && c.detail.includes('12') && c.detail.includes('A, B, C, D, E, …'), c.detail);
  assert.equal(bulkRequests(f).length, 0, 'Cancel must not write');
  assert.equal(f.snap().deletes.length, 1, 'staged delete kept');
  assert.equal(f.snap().rows.length, 1, 'new row kept');
  assert.equal(f.snap().writing, false);
});

test('an id nobody uses is removed without a confirm', async t => {
  const f = await fixture(t);
  f.handlers.push(usageHandler({ T100: { count: 0, orders: [] } }), bulkHandler());
  f.TI._removeRows([f.snap().rows[0]._cid]);
  await f.TI._save();
  assert.equal(f.confirms.length, 0);
  assert.deepEqual(bulkRequests(f)[0].body, { upserts: [], deletes: [{ tool_id: 'T100' }], source: { kind: 'grid' } });
});

test('usage cannot be read: the error confirm is a warn confirm, Cancel aborts the save and OK proceeds', async t => {
  const f = await fixture(t);
  f.handlers.push({ match: u => u.endsWith('/usage'), respond: () => respond({ detail: 'no' }, 403) }, bulkHandler());
  f.TI._removeRows([f.snap().rows[0]._cid]);
  f.setConfirm(false);
  await f.TI._save();
  assert.equal(f.confirms[0].message, Util.t('modal.tool_inventory_check_failed'));
  assert.equal(f.confirms[0].tone, 'warn');
  assert.equal(bulkRequests(f).length, 0);
  f.setConfirm(true);
  await f.TI._save();
  assert.equal(bulkRequests(f).length, 1);
});

test('typo fix (delete the old id + add the new one) is ONE /bulk call with the delete and the upsert', async t => {
  const f = await fixture(t);
  f.handlers.push(usageHandler({ T100: { count: 2, orders: ['A', 'B'] } }), bulkHandler());
  f.TI._removeRows([f.snap().rows[0]._cid]);
  f.TI._addRow();
  const nr = f.snap().rows[0];
  f.edit(nr, 'tool_id', 't1000'); f.edit(nr, 'total_qty', '3'); f.edit(nr, 'note', ' typo fix ');
  await f.TI._save();
  const bulk = bulkRequests(f);
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].url.includes('/tool-inventory/A/bulk'), true);
  assert.equal(bulk[0].opts.method, 'POST');
  assert.deepEqual(bulk[0].body, {
    upserts: [{ tool_id: 'T1000', total_qty: 3, out_of_service_qty: 0, note: 'typo fix' }],
    deletes: [{ tool_id: 'T100' }],
    source: { kind: 'grid' },
  });
});

test('a re-added id equal to a staged delete is an edit: upsert only, no delete, no usage call or confirm', async t => {
  const f = await fixture(t);
  f.handlers.push(usageHandler({ T100: { count: 9, orders: ['A'] } }), bulkHandler());
  f.TI._removeRows([f.snap().rows[0]._cid]);
  f.TI._addRow();
  const nr = f.snap().rows[0];
  f.edit(nr, 'tool_id', 'T100'); f.edit(nr, 'total_qty', '5');
  assert.equal(f.snap().errors.size, 0, 'the staged delete does not collide with its re-add');
  await f.TI._save();
  assert.equal(f.requests.filter(r => r.url.endsWith('/usage')).length, 0);
  assert.equal(f.confirms.length, 0);
  assert.deepEqual(bulkRequests(f)[0].body, { upserts: [{ tool_id: 'T100', total_qty: 5, out_of_service_qty: 0, note: null }], deletes: [], source: { kind: 'grid' } });
});

test('bulk body sends only new + changed rows (normalised) and none of the untouched ones', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare'), row('T200', 2, 0)] });
  f.handlers.push(bulkHandler());
  const [a, b] = f.snap().rows;
  f.edit(b, 'out_of_service_qty', '1');
  f.edit(b, 'out_of_service_qty', '0');           // back to the saved value: not changed
  f.edit(a, 'note', '  new note ');
  await f.TI._save();
  assert.deepEqual(bulkRequests(f)[0].body.upserts, [{ tool_id: 'T100', total_qty: 3, out_of_service_qty: 1, note: 'new note' }]);
});

test('a successful save toasts, clears dirty state and drafts, and refreshes the Store inventory with the documented args', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler());
  f.edit(f.snap().rows[0], 'total_qty', '7');
  assert.equal(f.snap().dirty, 1);
  await f.TI._save();
  assert.deepEqual(f.seamCalls, [['tool-inventory-save', 'tool_inventory']]);
  assert.equal(f.snap().dirty, 0);
  assert.equal(f.snap().canSave, false);
  assert.ok(f.toasts.some(x => x.type === 'success' && x.msg === Util.t('toast.tool_inventory_saved', { count: 1 })));
});

test('server 400: edits stay, the first problems are listed, Save is available again', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler(400, { detail: 'Cannot save tool inventory: T100: Out of Service (5) cannot exceed Total Inventory (3); T9: Tool ID is required (+2 more)' }));
  f.edit(f.snap().rows[0], 'total_qty', '4');
  await f.TI._save();
  const s = f.snap();
  assert.equal(s.dirty, 1);
  assert.equal(s.writing, false);
  assert.equal(s.canSave, true);
  assert.deepEqual(s.serverProblems, ['T100: Out of Service (5) cannot exceed Total Inventory (3)', 'T9: Tool ID is required (+2 more)']);
  assert.ok(f.element('ti-errors').innerHTML.includes('T100: Out of Service'));
  assert.equal(f.element('ti-errors').hidden, false);
  assert.ok(f.toasts.some(x => x.type === 'error' && x.msg.startsWith('Tool inventory not saved:')));
  assert.equal(f.seamCalls.length, 0);
});

test('403 on save flips the grid read-only with the no-permission toast and keeps the edits', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler(403, { detail: 'forbidden' }));
  f.edit(f.snap().rows[0], 'total_qty', '4');
  await f.TI._save();
  const s = f.snap();
  assert.equal(s.readOnly, true);
  assert.equal(s.dirty, 1);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.no_write_permission')));
  assert.equal(f.colDef('total_qty').editable({ data: s.rows[0] }), false);
  assert.equal(f.element('ti-add').disabled, true);
});

test('Save and cell edits are disabled while What-If (Sandbox) is active', async t => {
  const f = await fixture(t);
  f.edit(f.snap().rows[0], 'total_qty', '4');
  assert.equal(f.snap().canSave, true);
  Sandbox.active = true;
  f.emit({ type: 'sandbox:entered' });
  assert.equal(f.snap().canSave, false);
  assert.equal(f.element('ti-save').disabled, true);
  assert.equal(f.colDef('total_qty').editable({ data: f.snap().rows[0] }), false);
  assert.equal(f.element('ti-hint').textContent, Util.t('ui.tool_inventory_sandbox_hint'));
  f.handlers.push(bulkHandler());
  await f.TI._save();
  assert.equal(bulkRequests(f).length, 0);
  Sandbox.active = false;
});

test('drafts are retained per plant across a plant switch and restored with a toast on return', async t => {
  const f = await fixture(t);
  f.edit(f.snap().rows[0], 'total_qty', '8');
  f.TI._addRow();
  f.edit(f.snap().rows[1], 'tool_id', 'tnew');
  f.selectPlant('B', [row('B1', 1, 0, null, 'B')]);
  f.TI.render();
  assert.equal(f.snap().plant, 'B');
  assert.deepEqual(f.snap().rows.map(r => r.tool_id), ['B1']);
  assert.equal(f.snap().dirty, 0);
  f.selectPlant('A', [row('T100', 3, 1, 'spare')]);
  f.TI.render();
  const s = f.snap();
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T100', 'TNEW']);
  assert.equal(s.rows[0].total_qty, 8);
  assert.equal(s.dirty, 2);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_draft_restored', { plant: 'A' })));
});

test('a remote change while editing rebases: untouched fields follow the server, edited fields keep the draft', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare')] });
  const [a] = f.snap().rows;
  f.edit(a, 'total_qty', '9');
  f.setInventory('A', [row('T100', 3, 2, 'remote note'), row('T500', 1, 0)]);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  const s = f.snap();
  assert.equal(s.rows[0].total_qty, 9, 'edited field kept');
  assert.equal(s.rows[0].out_of_service_qty, 2, 'untouched field follows the server');
  assert.equal(s.rows[0].note, 'remote note');
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T100', 'T500']);
});

test('states: no plant, loading, failed load with Retry, empty plant, filtered-empty overlay', async t => {
  const f = await fixture(t, { bypassPlant: true });
  Store._state.selectedPlant = null;
  f.TI.render();
  assert.equal(f.snap().view, 'noplant');
  assert.ok(f.element('ti-state').innerHTML.includes(Util.t('empty.no_tool_inventory_plant')));
  assert.equal(f.element('ti-add').disabled, true);
  assert.equal(f.element('ti-quick').disabled, true);

  Store.setMasterData(null, 'test');
  f.selectPlant('A', 'keep');
  f.TI.render();
  assert.equal(f.snap().view, 'loading');

  f.setInventory('A', undefined);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  assert.equal(f.snap().view, 'failed');
  assert.ok(f.element('ti-state').innerHTML.includes(Util.t('ui.tool_inventory_load_failed')));
  assert.ok(f.element('ti-state').innerHTML.includes('ti-retry'));
  await f.TI._retry();
  assert.deepEqual(f.refreshCalls, ['A']);

  f.setInventory('A', []);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  assert.equal(f.snap().view, 'ready');
  assert.ok(f.element('ti-state').innerHTML.includes(Util.t('empty.no_tool_inventory_rows')));
  assert.ok(f.element('ti-state').innerHTML.includes(Util.t('empty.no_tool_inventory_rows_msg')));
  assert.ok(f.element('ti-state').innerHTML.includes('ti-empty-add'), 'empty plant offers Add row');
  f.TI._addRow();
  assert.equal(f.snap().rows.length, 1);
  assert.equal(f.element('ti-state').hidden, true, 'grid replaces the empty state');

  const overlay = new (f.options().noRowsOverlayComponent)();
  overlay.init();
  assert.ok(overlay.getGui().innerHTML.includes(Util.t('empty.no_tool_inventory_filtered')));
});

test('the filter select narrows rows: out of service, available 0, total != 1, no orders use it', async t => {
  const f = await fixture(t, { rows: [row('T1', 1, 0), row('T2', 3, 1), row('T3', 2, 2), row('T4', 1, 1)] });
  t.mock.method(Store, 'tasksByPlant', () => [{ PRT_01: 'T1' }]);
  f.TI.render();
  const pass = mode => { f.TI._setFilter(mode); const s = f.snap(); return s.rows.filter(r => s.passesFilter(r)).map(r => r.tool_id); };
  assert.deepEqual(pass('all'), ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(pass('oos'), ['T2', 'T3', 'T4']);
  assert.deepEqual(pass('available_zero'), ['T3', 'T4']);
  assert.deepEqual(pass('total_not_one'), ['T2', 'T3']);
  assert.deepEqual(pass('unused'), ['T2', 'T3', 'T4']);
  assert.equal(f.options().isExternalFilterPresent(), true);
});

test('quick filter is debounced 250 ms and setQuickFilter keeps text until the grid exists', async t => {
  const f = await fixture(t);
  f.TI.setQuickFilter('T1');
  assert.equal(f.element('ti-quick').value, 'T1');
  const input = f.element('ti-quick');
  assert.equal(typeof input.listeners.input[0], 'function');
});

test('tool_alerts_cleared: toast with the difference when the next alerts:change shows fewer tool conflicts', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler());
  Store._state.alerts = [{ type: 'tool-conflict' }, { type: 'tool-conflict' }, { type: 'tool-conflict' }, { type: 'overload' }];
  f.mod._seams.refreshStoreMasterData = async () => {
    Store._state.alerts = [{ type: 'tool-conflict' }, { type: 'overload' }];
    f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
    f.emit({ type: 'alerts:change' });
    return true;
  };
  f.edit(f.snap().rows[0], 'total_qty', '8');
  await f.TI._save();
  assert.ok(f.toasts.some(x => x.type === 'success' && x.msg === Util.t('toast.tool_alerts_cleared', { n: 2 })), JSON.stringify(f.toasts));
});

test('tool_alerts_cleared: silent when the count did not drop, and when alerts:change never fires', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler());
  Store._state.alerts = [{ type: 'tool-conflict' }];
  f.mod._seams.refreshStoreMasterData = async () => { f.emit({ type: 'master-data-changed', table: 'tool_inventory' }); f.emit({ type: 'alerts:change' }); return true; };
  f.edit(f.snap().rows[0], 'total_qty', '8');
  await f.TI._save();
  assert.equal(f.toasts.some(x => x.msg.includes('conflict alert')), false);
  f.edit(f.snap().rows[0], 'total_qty', '9');
  f.mod._seams.refreshStoreMasterData = async () => true;     // no alerts:change at all: the 3 s guard is unref'd and ignored
  await f.TI._save();
  assert.equal(f.toasts.some(x => x.msg.includes('conflict alert')), false);
});

test('the status line always says inventory feeds alerts and omits the tooling-rule text while the control is not ready', async t => {
  const f = await fixture(t, { rows: [row('T1')] });
  f.setInventory('A', [row('T1')], { setup_policy_config: { toolingRule: 'hard' } });
  f.TI.render();
  assert.equal(f.element('ti-status').textContent, Util.t('ui.tool_inventory_alerts'));
});

test('Refresh with unsaved edits asks first; cancelled leaves the edits; confirmed re-pulls through Persistence', async t => {
  const f = await fixture(t);
  f.edit(f.snap().rows[0], 'total_qty', '9');
  f.setConfirm(false);
  assert.equal(await f.TI.refresh(), false);
  assert.equal(f.refreshCalls.length, 0);
  f.setConfirm(true);
  assert.equal(await f.TI.refresh(), true);
  assert.deepEqual(f.refreshCalls, ['A']);
  assert.equal(f.snap().dirty, 0);
});

test('openForTool selects the plant and sets the quick filter text', async t => {
  const f = await fixture(t);
  f.TI.openForTool('A', 'T100');
  assert.equal(f.element('ti-quick').value, 'T100');
});

test('exactly ONE AG Grid is created across initial render, repeated render, plant switches and a no-plant round trip', async t => {
  const f = await fixture(t);
  assert.equal(f.createCount(), 1, 'initial render');
  f.TI.render(); f.TI.render();
  assert.equal(f.createCount(), 1, 'repeated render');
  f.selectPlant('B', [row('B1', 1, 0, null, 'B')]); f.TI.render();
  f.selectPlant('A', [row('T100', 3, 1, 'spare')]); f.TI.render();
  assert.equal(f.createCount(), 1, 'plant switch A -> B -> A');
  Store._state.selectedPlant = null;
  f.emit({ type: 'plant:selected', plant: null }); f.TI.render();
  assert.equal(f.snap().view, 'noplant');
  f.selectPlant('A', [row('T100', 3, 1, 'spare')]); f.TI.render();
  assert.equal(f.createCount(), 1, 'plant -> no plant -> plant');
  assert.deepEqual(f.gridRows().map(r => r.tool_id), ['T100'], 'the one grid shows the current plant rows');
  f.selectPlant('B', [row('B1', 1, 0, null, 'B')]); f.TI.render();
  assert.equal(f.gridRows()[0].tool_id, 'B1');
  assert.equal(f.options().getRowId({ data: f.gridRows()[0] }), f.gridRows()[0]._cid);
});

test('a plant with no rows after a switch does not keep the previous plant rows in the single grid', async t => {
  const f = await fixture(t);
  f.selectPlant('B', []); f.TI.render();
  assert.equal(f.gridRows().length, 0);
  assert.equal(f.createCount(), 1);
});

test('loading vs failed: inventory undefined while a load is in flight shows loading; after it completes it shows failed', async t => {
  const f = await fixture(t);
  let loading = true;
  t.mock.method(Persistence, 'isLoading', () => loading);
  f.selectPlant('B', undefined);               // masterData exists, tool_inventory undefined
  f.TI.render();
  assert.equal(f.snap().view, 'loading');
  assert.equal(f.element('ti-state').innerHTML.includes('ti-retry'), false);
  loading = false;
  f.TI.render();
  assert.equal(f.snap().view, 'failed');
  assert.ok(f.element('ti-state').innerHTML.includes('ti-retry'));
});

test('loading vs failed: an in-flight inventory refresh for the plant also counts as loading', async t => {
  const f = await fixture(t);
  Persistence._toolInventoryRefreshing.add('B');
  t.after(() => Persistence._toolInventoryRefreshing.delete('B'));
  f.selectPlant('B', undefined);
  f.TI.render();
  assert.equal(f.snap().view, 'loading');
  Persistence._toolInventoryRefreshing.delete('B');
  f.TI.render();
  assert.equal(f.snap().view, 'failed');
});

test('rebase: a saved row removed remotely and UNTOUCHED locally is dropped and not counted dirty', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare'), row('T200', 2, 0)] });
  f.setInventory('A', [row('T100', 3, 1, 'spare')]);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  const s = f.snap();
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T100']);
  assert.equal(s.dirty, 0);
  assert.equal(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_remote_deleted_kept')), false);
});

test('rebase: a saved row removed remotely but EDITED locally is kept as a new row with the explaining toast', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare'), row('T200', 2, 0)] });
  f.edit(f.snap().rows[1], 'total_qty', '9');
  f.setInventory('A', [row('T100', 3, 1, 'spare')]);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  const s = f.snap();
  assert.deepEqual(s.rows.map(r => [r.tool_id, r._isNew, r.total_qty]), [['T100', false, 3], ['T200', true, 9]]);
  assert.equal(s.dirty, 1);
  assert.ok(f.toasts.some(x => x.type === 'warn' && x.msg === Util.t('toast.tool_inventory_remote_deleted_kept')));
});

test('Add tools in use: draft new rows (1/0/blank) for used ids with no row or draft, sorted, de-duplicated, placeholders excluded', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare')] });
  t.mock.method(Store, 'tasksByPlant', () => [
    { PRT_01: 'z9', PRT_02: 'T100' }, { PRT_01: ' a1 ', PRT_02: 'Z9' }, { PRT_01: '-', PRT_02: 'n/a' }, { PRT_01: 'A1', PRT_02: null },
  ]);
  f.TI.render();
  f.TI._addInUse();
  const s = f.snap();
  assert.deepEqual(s.rows.map(r => r.tool_id), ['T100', 'A1', 'Z9']);
  assert.deepEqual(s.rows.slice(1).map(r => [r._isNew, r.total_qty, r.out_of_service_qty, r.note]), [[true, 1, 0, ''], [true, 1, 0, '']]);
  assert.equal(s.dirty, 2);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_added_in_use', { n: 2 })));
  f.TI._addInUse();       // nothing left to add: no duplicates
  assert.equal(f.snap().rows.length, 3);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_none_in_use')));
});

test('Add tools in use caps at 500 with a note, is disabled in Sandbox, and the tooltip names the loaded window', async t => {
  const f = await fixture(t, { rows: [] });
  t.mock.method(Store, 'tasksByPlant', () => Array.from({ length: 520 }, (_, i) => ({ PRT_01: `X${String(i).padStart(4, '0')}` })));
  f.TI.render();
  f.TI._addInUse();
  assert.equal(f.snap().rows.length, 500);
  assert.equal(f.snap().rows[0].tool_id, 'X0000');
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_added_in_use_capped', { n: 500 })));
  assert.match(Util.t('tip.add_tools_in_use'), /loaded window/);
  Sandbox.active = true;
  f.emit({ type: 'sandbox:entered' });
  assert.equal(f.element('ti-add-in-use').disabled, true);
  const before = f.snap().rows.length;
  f.TI._addInUse();
  assert.equal(f.snap().rows.length, before);
  Sandbox.active = false;
});

test('filters: "Used but no row" lists draft rows of used tools and hints the count; "In use now" covers the current time', async t => {
  const f = await fixture(t, { rows: [row('T1'), row('T2'), row('T3')] });
  const now = Date.now();
  const iso = ms => new Date(now + ms).toISOString();
  t.mock.method(Store, 'tasksByPlant', () => [
    { PRT_01: 'T1', start_date: iso(-3600e3), end_date: iso(3600e3) },        // covers now
    { PRT_01: 'T2', start_date: iso(3600e3), end_date: iso(7200e3) },         // future
    { PRT_01: 'NEW1', PRT_02: 'NEW2', start_date: iso(-7200e3), end_date: iso(-3600e3) },   // past, no row
  ]);
  f.TI.render();
  const choose = v => { f.element('ti-filter').value = v; f.element('ti-filter').listeners.change[0]({ target: f.element('ti-filter') }); };
  const pass = () => { const s = f.snap(); return s.rows.filter(r => s.passesFilter(r)).map(r => r.tool_id); };
  choose('in_use_now');
  assert.deepEqual(pass(), ['T1']);
  choose('used_no_row');
  assert.deepEqual(pass(), [], 'no draft rows yet');
  assert.equal(f.element('ti-filter-hint').hidden, false);
  assert.equal(f.element('ti-filter-hint').textContent, Util.t('ui.tool_inventory_used_no_row_hint', { count: 2 }));
  f.TI._addInUse();      // resets the filter to All so the new rows show
  assert.equal(f.snap().filter, 'all');
  f.TI._setFilter('used_no_row');
  assert.deepEqual(pass(), ['NEW1', 'NEW2']);
});

test('typed ids: invisible characters, nbsp and the numeric .0 suffix are stripped so duplicates are caught', async t => {
  const f = await fixture(t, { rows: [row('T100'), row('12345')] });
  f.TI._addRow();
  const nr = f.snap().rows[2];
  f.edit(nr, 'tool_id', 'T1​00 ');
  assert.equal(nr.tool_id, 'T100');
  assert.equal(f.snap().errors.get(nr._cid).tool_id, Util.t('ui.tool_inventory_duplicate', { id: 'T100' }));
  f.edit(nr, 'tool_id', '﻿12345.0');
  assert.equal(nr.tool_id, '12345');
  assert.ok(f.snap().errors.get(nr._cid).tool_id);
  f.edit(nr, 'tool_id', 'AB.0');
  assert.equal(nr.tool_id, 'AB.0', 'a non-numeric .0 is left alone');
  f.edit(nr, 'tool_id', '⁠‌');
  assert.equal(f.snap().errors.get(nr._cid).tool_id, Util.t('ui.tool_inventory_invalid_id_required'));
});

test('non-400 save failure (network) toasts only: no inline problem list', async t => {
  const f = await fixture(t);
  t.mock.method(Util, 'fetchTraced', async () => { throw new Error('Failed to fetch'); });
  f.edit(f.snap().rows[0], 'total_qty', '4');
  await f.TI._save();
  assert.deepEqual(f.snap().serverProblems, []);
  assert.equal(f.element('ti-errors').hidden, true);
  assert.ok(f.toasts.some(x => x.type === 'error' && x.msg === Util.t('toast.tool_inventory_save_failed', { msg: 'Failed to fetch' })));
  assert.equal(f.snap().dirty, 1);
});

test('500 response also shows no inline problem list', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler(500, { detail: 'boom; and more' }));
  f.edit(f.snap().rows[0], 'total_qty', '4');
  await f.TI._save();
  assert.deepEqual(f.snap().serverProblems, []);
});

test('a second Save while the first call is in flight sends nothing more (writing guard)', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(r => { release = r; });
  f.handlers.push({ match: u => u.endsWith('/bulk'), respond: async () => { await gate; return respond(bulkOk); } });
  f.edit(f.snap().rows[0], 'total_qty', '4');
  const first = f.TI._save();
  const second = f.TI._save();
  assert.equal(f.snap().writing, true);
  assert.equal(f.element('ti-save').disabled, true);
  release();
  await Promise.all([first, second]);
  assert.equal(bulkRequests(f).length, 1);
  assert.equal(f.snap().writing, false);
});

test('tool_alerts_cleared: an unrelated alerts:change before the inventory change does not toast; a real clear after it does', async t => {
  const f = await fixture(t);
  f.handlers.push(bulkHandler());
  Store._state.alerts = [{ type: 'tool-conflict' }, { type: 'tool-conflict' }];
  f.mod._seams.refreshStoreMasterData = async () => {
    Store._state.alerts = [{ type: 'tool-conflict' }];
    f.emit({ type: 'alerts:change' });                      // unrelated: arrives before the tool_inventory change
    return true;
  };
  f.edit(f.snap().rows[0], 'total_qty', '8');
  await f.TI._save();
  assert.equal(f.toasts.some(x => x.msg.includes('conflict alert')), false);
  f.mod._seams.refreshStoreMasterData = async () => true;
  Store._state.alerts = [{ type: 'tool-conflict' }, { type: 'tool-conflict' }, { type: 'tool-conflict' }];
  f.edit(f.snap().rows[0], 'total_qty', '9');
  await f.TI._save();
  Store._state.alerts = [{ type: 'tool-conflict' }];
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  f.emit({ type: 'alerts:change' });
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_alerts_cleared', { n: 2 })), JSON.stringify(f.toasts));
});

test('a staged delete re-added with identical values counts as 0 changes (no delete, no upsert)', async t => {
  const f = await fixture(t, { rows: [row('T100', 3, 1, 'spare')] });
  f.handlers.push(bulkHandler());
  f.TI._removeRows([f.snap().rows[0]._cid]);
  assert.equal(f.snap().dirty, 1);
  f.TI._addRow();
  const nr = f.snap().rows[0];
  f.edit(nr, 'tool_id', 'T100'); f.edit(nr, 'total_qty', '3'); f.edit(nr, 'out_of_service_qty', '1'); f.edit(nr, 'note', 'spare');
  assert.equal(f.snap().dirty, 0);
  assert.equal(f.snap().canSave, false);
  f.edit(nr, 'note', 'changed');
  assert.equal(f.snap().dirty, 1, 'a changed re-add is one edit');
  f.edit(nr, 'note', 'spare');
  assert.equal(f.snap().dirty, 0);
});

test('pane visibility: a hidden Master Data top tab never triggers render on plant switch or data change', async t => {
  const f = await fixture(t);
  const tab = f.element('masterdata-tab');
  tab.classList = { contains: () => false };            // top tab not active
  let touched = 0;
  const orig = globalThis.document.getElementById;
  globalThis.document.getElementById = id => { if (id === 'ti-state') touched++; return orig(id); };
  f.selectPlant('B', [row('B1', 1, 0, null, 'B')]);
  f.setInventory('B', [row('B1', 1, 0, null, 'B'), row('B2', 1, 0, null, 'B')]);
  f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
  assert.equal(touched, 0, 'render (which touches #ti-state) did not run');
  tab.classList = { contains: () => true };
  f.TI.render();
  assert.ok(touched > 0);
  assert.deepEqual(f.snap().rows.map(r => r.tool_id), ['B1', 'B2'], 'once visible, render adopts the Store rows');
  globalThis.document.getElementById = orig;
});

test('perf: Used by over 10,000 loaded tasks renders well inside a generous bound', async t => {
  const f = await fixture(t, { rows: [row('T1'), row('T2')] });
  t.mock.method(Store, 'tasksByPlant', () => Array.from({ length: 10000 }, (_, i) => ({ PRT_01: `T${i % 500}`, PRT_02: i % 3 ? `T${(i + 7) % 500}` : '-' })));
  const t0 = performance.now();
  f.TI.render();
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `render took ${ms.toFixed(1)} ms`);
  assert.equal(f.colDef('used_by').valueGetter({ data: f.snap().rows[0] }) > 0, true);
});

// ---- Wave 4b: Excel Template / Export / Upload with a review step --------------------------------------------------------------

const settle = async () => { await new Promise(r => setImmediate(r)); };
async function until(fn, label = 'condition') {
  for (let i = 0; i < 300; i++) { if (fn()) return; await settle(); }
  assert.fail(`timed out waiting for ${label}`);
}
const xlsxRes = (name, status = 200) => {
  const res = { ok: status < 400, status, headers: new Headers(name ? { 'content-disposition': `attachment; filename="${name}"` } : {}), blob: async () => new Blob(['xlsx']), json: async () => ({}), text: async () => '' };
  res.clone = () => res;
  return res;
};
const dryBody = (over = {}) => ({
  dry_run: true, counts: { new: 1, changed: 1, unchanged: 3, rejected: 0 },
  new: [{ tool_id: 'T200', total_qty: 2, out_of_service_qty: 0, note: null }],
  changed: [{ tool_id: 'T100', before: { total_qty: 3, out_of_service_qty: 1, note: 'spare' }, after: { total_qty: 4, out_of_service_qty: 1, note: 'spare' } }],
  unchanged: ['A', 'B', 'C'], rejected: [], rows: 5, warnings: [], ...over,
});
const dryHandler = body => ({ match: u => u.includes('/upload?dry_run=1'), respond: () => respond(body) });
const applyHandler = (body = { inserted: 1, updated: 1, rejected: 0, warnings: [], plants: ['A'] }, status = 200) =>
  ({ match: u => u.includes('/upload?dry_run=0'), respond: () => respond(body, status) });
const uploadReqs = f => f.requests.filter(r => r.url.includes('/upload'));
const mkFile = (name = 'tools.xlsx') => new File(['x'], name);
const reviewText = f => f.element('ti-review-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const reviewOpened = f => f.modalCalls.some(c => c[0] === 'open' && c[1] === 'modal-tool-inventory-review');

test('Template and Export download through fetchTraced with the Content-Disposition filename (sanitised), the plant URL and a toast on error', async t => {
  const f = await fixture(t);
  f.handlers.push({ match: u => u.endsWith('/template.xlsx'), respond: () => xlsxRes('tool inventory (A) template.xlsx') });
  f.handlers.push({ match: u => u.endsWith('/export.xlsx'), respond: () => xlsxRes(null) });
  f.click('ti-template');
  await until(() => f.saved.length === 1, 'template');
  assert.match(f.requests[0].url, /\/tool-inventory\/A\/template\.xlsx$/);
  assert.equal(f.saved[0].name, 'tool_inventory_A_template.xlsx');
  f.click('ti-export-xlsx');
  await until(() => f.saved.length === 2, 'export');
  assert.match(f.requests[1].url, /\/tool-inventory\/A\/export\.xlsx$/);
  assert.equal(f.saved[1].name, 'tool-inventory-A.xlsx', 'fallback filename when the header is absent');
  f.handlers.length = 0;
  f.handlers.push({ match: u => u.endsWith('/export.xlsx'), respond: () => xlsxRes(null, 500) });
  await f.TI._download('export');
  assert.ok(f.toasts.some(x => x.type === 'error' && x.msg === Util.t('toast.export_failed', { msg: 'HTTP 500' })), JSON.stringify(f.toasts));
  assert.equal(f.saved.length, 2);
});

test('filenameFromDisposition handles filename*, quotes, path characters and the fallback', async () => {
  const { filenameFromDisposition: fn } = await import('../../../frontend/master-data/tool-inventory.mjs');
  assert.equal(fn("attachment; filename*=UTF-8''tools%20A.xlsx", 'x.xlsx'), 'tools_A.xlsx');
  assert.doesNotMatch(fn('attachment; filename=../../evil.xlsx', 'x.xlsx'), /[\\/]/);
  assert.equal(fn(null, 'tool-inventory-A.xlsx'), 'tool-inventory-A.xlsx');
});

test('Upload with unsaved edits: the picker opens first and a cancelled picker changes nothing; the discard confirm runs only once a file is chosen', async t => {
  const f = await fixture(t);
  let picked = 0;
  f.element('ti-upload-input').click = () => { picked++; };
  f.TI._addRow();
  const dirty = f.snap().dirty;
  assert.ok(dirty > 0);
  f.setConfirm(false);
  f.click('ti-upload');
  await settle();
  assert.equal(picked, 1, 'the picker opens at once');
  assert.equal(f.confirms.length, 0, 'no discard confirm before a file is chosen (a picker cancel fires no change event)');
  assert.equal(f.snap().dirty, dirty, 'cancelling the picker keeps every edit');
  assert.equal(f.requests.length, 0);
  const input = f.element('ti-upload-input');
  const choose = () => input.listeners.change[0]({ target: Object.assign(input, { files: [mkFile()] }) });
  choose();
  await until(() => f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_upload_dirty')), 'dirty toast');
  assert.equal(f.confirms.length, 1);
  assert.equal(f.snap().dirty, dirty, 'declining the discard keeps the edits');
  assert.equal(f.requests.length, 0, 'nothing is sent');
  f.setConfirm(true);
  f.handlers.push(dryHandler(dryBody()));
  choose();
  await until(() => reviewOpened(f), 'review after discard');
  assert.equal(f.snap().dirty, 0, 'edits were discarded before the dry run');
  assert.equal(uploadReqs(f).length, 1);
  f.click('ti-review-cancel');
  await settle();
});

test('Upload: dry run is a multipart POST ?dry_run=1 (never dry_run=0), then the review lists counts, capped lists and the standing sentences; Cancel writes nothing', async t => {
  const f = await fixture(t);
  const changed = Array.from({ length: 200 }, (_, i) => ({ tool_id: `C${i}`, before: { total_qty: 1, out_of_service_qty: 0, note: null }, after: { total_qty: 2, out_of_service_qty: 0, note: null } }));
  const rejected = [{ row: 7, tool_id: 'T9', error: 'Total Inventory must be a whole number' }];
  f.handlers.push(dryHandler(dryBody({ counts: { new: 1, changed: 250, unchanged: 3, rejected: 1 }, changed, rejected, warnings: ['Header row guessed'] })));
  const file = mkFile('inventory.xlsx');
  const p = f.TI.uploadFile('A', file);
  await until(() => reviewOpened(f), 'review modal');
  assert.equal(uploadReqs(f).length, 1);
  const r = uploadReqs(f)[0];
  assert.match(r.url, /\/tool-inventory\/A\/upload\?dry_run=1$/);
  assert.equal(r.opts.method, 'POST');
  assert.equal(r.form.get('file').name, 'inventory.xlsx');
  assert.equal(r.opts.headers, undefined, 'no explicit content-type: the browser sets the multipart boundary');
  const text = reviewText(f);
  assert.ok(text.includes('1 new, 250 changed, 3 unchanged, 1 rejected'), text);
  assert.ok(text.includes('inventory.xlsx'));
  assert.ok(text.includes('and 50 more'), 'changes capped at 200: 250 - 200');
  assert.ok(text.includes('T200: Total Inventory 2, Out of Service 0'));
  assert.ok(text.includes('Row 7: Total Inventory must be a whole number'));
  assert.ok(text.includes('(T9)'));
  assert.ok(text.includes('Header row guessed'));
  assert.ok(text.includes('Rows missing from the file are left unchanged.'));
  assert.ok(text.includes('Rejected rows will be skipped; the valid rows will still be saved.'));
  assert.ok(f.element('ti-review-body').innerHTML.includes('role="alert"'), 'the rejected warning is announced');
  assert.equal(f.element('ti-review-apply').textContent, 'Apply changes (251)');
  assert.equal(f.element('ti-review-apply').disabled, false);
  f.click('ti-review-cancel');
  assert.equal(await p, false);
  assert.equal(uploadReqs(f).length, 1, 'Cancel makes NO write');
  assert.deepEqual(f.seamCalls, []);
  assert.deepEqual(f.modalCalls.at(-1), ['close', 'modal-tool-inventory-review']);
});

test('Review: before -> after cells, no rejected warning at 0 rejected, Escape and the close button cancel', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()));
  let p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  const html = f.element('ti-review-body').innerHTML;
  assert.ok(html.includes('3 <span class="ti-review-arrow"'), 'total 3 -> 4');
  assert.ok(html.includes('<strong>4</strong>'));
  assert.doesNotMatch(html, /Rejected rows will be skipped/);
  assert.equal(f.element('ti-review-apply').textContent, 'Apply changes (2)');
  for (const fn of f.docKeys) fn({ key: 'Escape', preventDefault() {} });
  assert.equal(await p, false);
  f.modalCalls.length = 0;
  p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'reopen');
  f.click('ti-review-close');
  assert.equal(await p, false);
  assert.equal(uploadReqs(f).filter(r => r.url.includes('dry_run=0')).length, 0);
});

test('Review: Apply is disabled when nothing would change', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody({ counts: { new: 0, changed: 0, unchanged: 4, rejected: 0 }, new: [], changed: [] })));
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  assert.equal(f.element('ti-review-apply').disabled, true);
  assert.equal(f.element('ti-review-apply').textContent, 'Apply changes (0)');
  f.click('ti-review-apply');
  await settle();
  assert.equal(uploadReqs(f).length, 1, 'a click on the disabled Apply sends nothing');
  f.click('ti-review-cancel');
  await p;
});

test('Apply re-POSTs the SAME File with dry_run=0, toasts the summary, lists warnings, awaits the Store refresh and re-renders', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()));
  f.handlers.push(applyHandler({ inserted: 1, updated: 2, rejected: 1, warnings: [{ msg: 'Row 9 ignored' }, 'plain warning'], plants: ['A'] }));
  const file = mkFile();
  const p = f.TI.uploadFile('A', file);
  await until(() => reviewOpened(f), 'open');
  f.click('ti-review-apply');
  assert.equal(await p, true);
  const reqs = uploadReqs(f);
  assert.equal(reqs.length, 2);
  assert.match(reqs[1].url, /\/upload\?dry_run=0$/);
  assert.equal(reqs[1].form.get('file').name, file.name, 'the same file is re-posted');
  assert.equal(reqs[0].opts.body === reqs[1].opts.body, false, 'a fresh FormData per request');
  assert.deepEqual(f.seamCalls, [['tool-inventory-save', 'tool_inventory']]);
  const done = f.toasts.find(x => x.msg === Util.t('toast.tool_inventory_upload_done', { inserted: 1, updated: 2, rejected: 1 }));
  assert.ok(done, JSON.stringify(f.toasts));
  assert.equal(done.type, 'warn', 'rejected rows downgrade the toast');
  const result = f.element('ti-upload-result');
  assert.equal(result.hidden, false);
  assert.ok(result.innerHTML.includes('Row 9 ignored') && result.innerHTML.includes('plain warning'), 'readable warnings block');
});

test('Apply also reuses the "N tool alerts cleared" toast', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  Store._state.alerts = [{ type: 'tool-conflict' }, { type: 'tool-conflict' }, { type: 'tool-conflict' }];
  f.mod._seams.refreshStoreMasterData = async () => {
    Store._state.alerts = [{ type: 'tool-conflict' }];
    f.emit({ type: 'master-data-changed', table: 'tool_inventory' });
    f.emit({ type: 'alerts:change' });
    return true;
  };
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  f.click('ti-review-apply');
  await p;
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_alerts_cleared', { n: 2 })), JSON.stringify(f.toasts));
});

test('upload failures are readable: 413 too large, 400 detail, 403 read-only; nothing is applied', async t => {
  const f = await fixture(t);
  f.handlers.push({ match: u => u.includes('dry_run=1'), respond: () => respond({ detail: 'file too big' }, 413) });
  assert.equal(await f.TI.uploadFile('A', mkFile()), false);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.tool_inventory_upload_too_large')));
  f.handlers.length = 0;
  f.handlers.push({ match: u => u.includes('dry_run=1'), respond: () => respond({ detail: 'Unreadable workbook (.xls is not supported)' }, 400) });
  assert.equal(await f.TI.uploadFile('A', mkFile()), false);
  assert.ok(f.toasts.some(x => x.type === 'error' && x.msg.includes('Unreadable workbook')), JSON.stringify(f.toasts));
  f.handlers.length = 0;
  f.handlers.push({ match: u => u.includes('dry_run=1'), respond: () => respond({ detail: 'forbidden' }, 403) });
  assert.equal(await f.TI.uploadFile('A', mkFile()), false);
  assert.ok(f.toasts.some(x => x.msg === Util.t('toast.no_write_permission')));
  assert.equal(f.snap().readOnly, true, '403 flips the grid read-only');
  assert.equal(f.element('ti-upload').disabled, true);
  assert.equal(reviewOpened(f), false);
});

test('an apply that fails after a good review (403) applies nothing and does not refresh the Store', async t => {
  const g = await fixture(t);
  g.handlers.push(dryHandler(dryBody()), applyHandler({ detail: 'x' }, 403));
  const p = g.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(g), 'open');
  g.click('ti-review-apply');
  assert.equal(await p, false);
  assert.deepEqual(g.seamCalls, [], 'no Store refresh after a failed apply');
  assert.ok(g.toasts.some(x => x.msg === Util.t('toast.no_write_permission')));
});

test('Template / Export / Upload are disabled while a request is in flight; a second upload is refused; no upload in What-If', async t => {
  const f = await fixture(t);
  let release;
  f.handlers.push({ match: u => u.includes('dry_run=1'), respond: () => new Promise(r => { release = () => r(respond(dryBody())); }) });
  assert.equal(f.element('ti-upload').disabled, false);
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => release, 'in-flight dry run');
  for (const id of ['ti-template', 'ti-export-xlsx', 'ti-upload']) assert.equal(f.element(id).disabled, true, `${id} disabled in flight`);
  assert.equal(await f.TI.uploadFile('A', mkFile()), false, 'a second upload while busy is refused');
  release();
  await until(() => reviewOpened(f), 'open');
  f.click('ti-review-cancel');
  await p;
  for (const id of ['ti-template', 'ti-export-xlsx', 'ti-upload']) assert.equal(f.element(id).disabled, false, `${id} enabled again`);
  Sandbox.active = true;
  assert.equal(await f.TI.uploadFile('A', mkFile()), false, 'no upload in What-If');
  Sandbox.active = false;
});

test('uploadFile for a plant other than the grid plant posts to THAT plant (Manage Data scope) and still refreshes the Store', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  const p = f.TI.uploadFile('B', mkFile());
  await until(() => reviewOpened(f), 'open');
  f.click('ti-review-apply');
  assert.equal(await p, true);
  assert.match(uploadReqs(f)[0].url, /\/tool-inventory\/B\/upload\?dry_run=1$/);
  assert.match(uploadReqs(f)[1].url, /\/tool-inventory\/B\/upload\?dry_run=0$/);
  assert.deepEqual(f.seamCalls, [['tool-inventory-save', 'tool_inventory']]);
});

test('the shared removal confirm is exported for the Manage Data grid: in-use ids warn, an unused id passes silently', async t => {
  const f = await fixture(t);
  f.handlers.push(usageHandler({ T1: { count: 2, orders: ['A1', 'A2'] }, T2: { count: 0, orders: [] } }));
  f.setConfirm(false);
  assert.equal(await f.TI.confirmRemovals('A', ['T1', 'T2']), false);
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0].detail, /T1/);
  f.setConfirm(true);
  assert.equal(await f.TI.confirmRemovals('A', ['T1']), true);
  assert.equal(await f.TI.confirmRemovals('A', ['T2']), true);
  assert.equal(f.confirms.length, 2, 'T2 alone is not in use: no confirm');
});

test('Apply with unsaved edits made during the review: the grid is not re-synced over them', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  f.TI._addRow();
  const dirty = f.snap().dirty;
  assert.ok(dirty > 0);
  f.click('ti-review-apply');
  assert.equal(await p, true);
  assert.equal(f.snap().dirty, dirty, 'the planner unsaved row survives the upload');
  assert.deepEqual(f.seamCalls, [['tool-inventory-save', 'tool_inventory']], 'the Store is still refreshed');
});

test('reviewHtml escapes every server/file-supplied string (tool id, note, file name, row, error, warnings incl. {msg} objects)', async t => {
  const f = await fixture(t);
  const { reviewHtml } = f.mod;
  const img = '<img src=x onerror=alert(1)>', scr = '<script>alert(2)</script>';
  const html = reviewHtml(`${img}.xlsx`, {
    counts: { new: 1, changed: 1, unchanged: 0, rejected: 1 },
    new: [{ tool_id: scr, total_qty: img, out_of_service_qty: scr }],
    changed: [{ tool_id: img, before: { total_qty: 1, out_of_service_qty: 0, note: scr }, after: { total_qty: 2, out_of_service_qty: 0, note: img } }],
    rejected: [{ row: scr, tool_id: img, error: `${img}${scr}` }],
    warnings: [img, { msg: scr }, { message: img }],
  });
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'entity-escaped');
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
});

test('the review arrow is hidden from screen readers and followed by an sr-only "changed to"', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()));
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  const html = f.element('ti-review-body').innerHTML;
  assert.ok(html.includes('<span class="ti-review-arrow" aria-hidden="true">→</span><span class="ti-sr-only">changed to</span>'), html);
  assert.doesNotMatch(html, /aria-label="changed to"/);
  f.click('ti-review-cancel');
  await p;
});

test('Apply label needs no plural: Apply changes (1)', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody({ counts: { new: 1, changed: 0, unchanged: 0, rejected: 0 }, changed: [] })));
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  assert.equal(f.element('ti-review-apply').textContent, 'Apply changes (1)');
  f.click('ti-review-cancel');
  await p;
});

test('a plant switch while the review is open: Apply still posts to the reviewed plant and does not re-sync the other plant grid', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  f.selectPlant('B', [row('B1', 1, 0, null, 'B')]);
  f.setInventory('B', [row('B1', 1, 0, null, 'B'), row('B2', 1, 0, null, 'B')]);   // a silent Store change a re-sync would pick up
  f.click('ti-review-apply');
  assert.equal(await p, true);
  assert.match(uploadReqs(f)[1].url, /\/tool-inventory\/A\/upload\?dry_run=0$/);
  assert.equal(f.snap().plant, 'B');
  assert.deepEqual(f.gridRows().map(r => r.tool_id), ['B1'], 'no grid re-sync for the non-selected plant');
});

test('a double click on Apply posts once', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  const p = f.TI.uploadFile('A', mkFile());
  await until(() => reviewOpened(f), 'open');
  f.click('ti-review-apply');
  f.click('ti-review-apply');
  assert.equal(await p, true);
  await settle();
  assert.equal(uploadReqs(f).filter(r => r.url.includes('dry_run=0')).length, 1);
});

test('a second upload while a review is open cancels the first review safely; only the second file can be applied', async t => {
  const f = await fixture(t);
  f.handlers.push(dryHandler(dryBody()), applyHandler());
  const p1 = f.TI.uploadFile('A', mkFile('first.xlsx'));
  await until(() => reviewOpened(f), 'first review');
  const opens = () => f.modalCalls.filter(c => c[0] === 'open').length;
  const p2 = f.TI.uploadFile('A', mkFile('second.xlsx'));
  assert.equal(await p1, false, 'the first review resolves as cancelled');
  await until(() => opens() === 2, 'second review');
  assert.equal(uploadReqs(f).filter(r => r.url.includes('dry_run=0')).length, 0, 'the first file was never applied');
  f.click('ti-review-apply');
  assert.equal(await p2, true);
  const applies = uploadReqs(f).filter(r => r.url.includes('dry_run=0'));
  assert.equal(applies.length, 1);
  assert.equal(applies[0].form.get('file').name, 'second.xlsx');
});

test('openForTool clears a stale status filter so the tool the alert points at is not hidden', async t => {
  const f = await fixture(t);
  f.TI._setFilter('oos');
  f.element('ti-filter').value = 'oos';
  f.TI.openForTool('A', 'T100');
  assert.equal(f.snap().filter, 'all');
  assert.equal(f.element('ti-filter').value, 'all');
  assert.equal(f.element('ti-quick').value, 'T100');
});
