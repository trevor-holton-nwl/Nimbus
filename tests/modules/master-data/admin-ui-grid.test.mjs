// Behavioural tests for the Master Data grid IIFE (frontend/master-data/admin-ui.mjs):
// paging/search races, staged deletes, dirty-grid plant switch. A tiny fake DOM plus a
// controllable fetch drive the REAL module (ported from the senior-audit md_probe harness),
// so these assert behaviour, not source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this._cls = new Set(); this._html = '';
    this.textContent = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.isConnected = true; this.parent = null;
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c),
      toggle: (c, f) => { (f ?? !self._cls.has(c)) ? self._cls.add(c) : self._cls.delete(c); },
      contains: (c) => self._cls.has(c),
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  get lastElementChild() { return this.children[this.children.length - 1]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setAttribute() {} getAttribute() { return null; } remove() {}
  // _mkCombobox builds its DOM from an innerHTML string and then queries it; the fake DOM does not
  // parse HTML, so a container holding combobox markup answers with cached stub nodes that carry
  // the same marker (their listeners stay inspectable, e.g. the combobox's clear button).
  querySelector(sel) {
    if (!this._html.includes('hps-')) return null;
    this._stubs ||= {};
    if (!this._stubs[sel]) { this._stubs[sel] = new El('stub'); this._stubs[sel]._html = 'hps-'; }
    return this._stubs[sel];
  }
  querySelectorAll() { return []; } closest() { return null; }
  focus() {} setSelectionRange() {} contains() { return false; }
  get options() { return this.children; }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
}

const host = new El('div'); host.id = 'md-host';
const tabs = ['subnetworks', 'plants', 'machine', 'materials', 'material_plants', 'production_version', 'routing_operation', 'bom_items', 'tool_inventory'].map((t) => { const b = new El('button'); b.dataset.mdTab = t; return b; });
const findNode = (pred) => { let f = null; host.walk((n) => { if (pred(n)) f = n; }); return f; };
globalThis.document = {
  getElementById: (id) => (id === 'md-host' ? host : null),
  querySelector: (sel) => (sel === '#md-host .btn-primary.sm' ? findNode((n) => n._cls.has('btn-primary'))
    : sel === '#md-host .md-search' ? findNode((n) => n._cls.has('md-search')) : null),
  querySelectorAll: (sel) => (sel === '.md-tab' ? tabs : []),
  createElement: (tag) => new El(tag),
  addEventListener() {}, body: new El('body'),
};
globalThis.window = globalThis.window || {};
globalThis.CSS = { escape: (s) => s };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const pending = [];
globalThis.fetch = (url, init) => new Promise((resolve) => {
  pending.push({ url: String(url), init, done: false,
    resolve: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => body, clone() { return this; }, text: async () => '' }) });
});
const fire = (p, body, ok) => { p.done = true; p.resolve(body, ok); };
const open = (sub) => pending.filter((p) => !p.done && p.url.includes(sub));
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const { MasterData } = await import('../../../frontend/master-data/admin-ui.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');
const { Modal, Toast } = await import('../../../frontend/platform/foundation.mjs');
const { Runtime } = await import('../../../frontend/routing/runtime-client.mjs');
const confirmCalls = [];
Modal.confirm = async (opts) => { confirmCalls.push(opts); return true; };
const toasts = [];
Toast.show = (m, t) => toasts.push(`${m}|${t}`);

const cols = [{ column_name: 'material_id', display_label: 'Material', is_locked: true }, { column_name: 'plant', display_label: 'Plant', is_locked: true }, { column_name: 'descr', display_label: 'Desc', is_locked: false }];
const mrows = (prefix, from, n, plant = 'A') => Array.from({ length: n }, (_, i) => ({ material_id: `${prefix}${from + i}`, plant, descr: 'd' }));
const page = (rows, total) => ({ columns: cols, rows, meta: { total } });
const tbodyKeys = () => { const keys = []; host.walk((n) => { if (n.tag === 'tr' && n.dataset.rowKey) keys.push(n.dataset.rowKey); }); return keys; };
const findBtn = (...txts) => findNode((n) => n.tag === 'button' && txts.includes(n.textContent));
const saveBtn = () => findBtn('btn.save', 'Save');
const loadMoreBtn = () => findBtn('btn.load_more', 'Load more');
const searchBox = () => findNode((n) => n._cls.has('md-search'));
const clickTab = (t) => tabs.find((b) => b.dataset.mdTab === t).onclick();
const typeSearch = (v) => { const b = searchBox(); b.value = v; b.oninput(); };
const cellFor = (key) => findNode((n) => n._cls.has('md-cell') && n.dataset.rowKey === key);
const lastOpen = (sub) => open(sub).slice(-1)[0];

async function openMaterials(rows, total) {
  clickTab('materials'); await tick();
  fire(lastOpen('/master-data/materials'), page(rows, total)); await tick();
}

Store.setSelectedPlant('A', 't');
MasterData.render();
fire(open('/master-data/subnetworks')[0], { columns: [{ column_name: 'code', display_label: 'c', is_locked: true }], rows: [], meta: {} });
await tick();

test('S1: a late response for an older search never overwrites the newer one', async () => {
  await openMaterials(mrows('M', 1, 200), 500);
  typeSearch('A'); await tick(400);
  typeSearch('AB'); await tick(400);
  const reqs = open('/master-data/materials');
  fire(reqs[1], page(mrows('AB', 1, 3), 3)); await tick();
  fire(reqs[0], page(mrows('A', 1, 50), 50)); await tick();
  assert.deepEqual(tbodyKeys(), ['AB1', 'AB2', 'AB3']);
});

test('S2: a stale Load more after a new search never mixes the two queries (senior audit)', async () => {
  await openMaterials(mrows('M', 1, 200), 500);
  const staleLoadMore = loadMoreBtn();
  assert.ok(staleLoadMore, 'Load more is offered while more pages exist');
  typeSearch('ZZ'); await tick(400);
  staleLoadMore.onclick(); await tick();
  for (const r of open('/master-data/materials')) {
    fire(r, r.url.includes('offset') ? page(mrows('ZZ', 201, 5), 205) : page(mrows('ZZ', 1, 200), 205));
  }
  await tick();
  const keys = tbodyKeys();
  assert.equal(keys.some((k) => k.startsWith('M')), false, 'no row from the previous query');
  assert.equal(keys.length, 200, 'only the new search page, no stale append');
});

test('R1: staged deletes survive a search that drops the row from the page and are sent on Save', async () => {
  await openMaterials(mrows('M', 1, 5), 5);
  const delBtn = findNode((n) => n._cls.has('md-del-btn') && n.parent?.parent?.dataset?.rowKey === 'M2')
    || (() => { let b = null; host.walk((n) => { if (n.tag === 'tr' && n.dataset.rowKey === 'M2') n.walk((c) => { if (c._cls.has('md-del-btn')) b = c; }); }); return b; })();
  await delBtn.onclick(); await tick();
  typeSearch('M4'); await tick(400);
  fire(lastOpen('/master-data/materials'), page(mrows('M', 4, 1), 1)); await tick();
  assert.deepEqual(tbodyKeys(), ['M4']);
  saveBtn().onclick(); await tick();
  const bulk = open('/master-data/materials/bulk')[0];
  assert.ok(bulk, 'bulk save issued');
  const body = JSON.parse(bulk.init.body);
  assert.deepEqual(body.deletes.map((d) => d.material_id), ['M2'], 'the staged delete is still sent');
  fire(bulk, { inserted: 0, updated: 0, deleted: 1, warnings: [] }); await tick();
});

test('S4: a global plant switch keeps a dirty grid and its edits (no re-render drops them)', async () => {
  Store.setSelectedPlant('A', 't');
  clickTab('material_plants'); await tick();
  fire(lastOpen('/master-data/material_plants'), page(mrows('P', 1, 3, 'A'), 3)); await tick();
  const cell = cellFor('P1|A');
  cell.textContent = 'EDITED'; cell.oninput(); await tick();
  assert.equal(saveBtn().disabled, false, 'dirty before the switch');
  toasts.length = 0;
  const before = open('/master-data/material_plants').length;
  Store.setSelectedPlant('B', 't'); await tick();
  assert.equal(open('/master-data/material_plants').length, before, 'no re-fetch for the dirty grid');
  assert.equal(saveBtn().disabled, false, 'edits kept after the switch');
  assert.ok(toasts.some((t) => t.endsWith('|warn')), 'user is told about the unsaved edits');
  Store.setSelectedPlant('A', 't');
});

test('S5: a failed Load more keeps the grid, toolbar and Save, and toasts the error', async () => {
  Store.setSelectedPlant('A', 't');
  await openMaterials(mrows('M', 1, 200), 500);
  const c = cellFor('M1'); c.textContent = 'x'; c.oninput();
  toasts.length = 0;
  loadMoreBtn().onclick(); await tick();
  fire(lastOpen('/master-data/materials'), {}, false); await tick();
  assert.ok(saveBtn(), 'toolbar/Save still rendered');
  assert.equal(tbodyKeys().length, 200, 'cached page still shown');
  assert.ok(toasts.some((t) => t.endsWith('|error')), 'error toast shown');
});

test('S6: a pending debounced search is dropped when the tab switches', async () => {
  await openMaterials(mrows('M', 1, 5), 5);
  typeSearch('Q');
  clickTab('machine'); await tick();
  await tick(450);
  assert.equal(open('/master-data/materials').filter((r) => r.url.includes('search=Q')).length, 0,
    'no materials search fired after leaving the tab');
});

test('S7: an edit survives a search that drops its row from the page', async () => {
  await openMaterials(mrows('M', 1, 5), 5);
  const c = cellFor('M1'); c.textContent = 'ED'; c.oninput();
  typeSearch('M4'); await tick(400);
  fire(lastOpen('/master-data/materials'), page(mrows('M', 4, 1), 1)); await tick();
  assert.equal(saveBtn().disabled, false);
  saveBtn().onclick(); await tick();
  const bulk = lastOpen('/master-data/materials/bulk');
  const body = JSON.parse(bulk.init.body);
  assert.equal(body.upserts.some((u) => u.material_id === 'M1'), true);
  fire(bulk, { inserted: 0, updated: 1, deleted: 0, warnings: [] }); await tick();
});

async function saveOneEdit() {
  Store.setSelectedPlant('A', 't');
  await openMaterials(mrows('M', 1, 3), 3);
  const c = cellFor('M1'); c.textContent = 'ED'; c.oninput();
  saveBtn().onclick(); await tick();
  const mark = pending.length;
  fire(lastOpen('/master-data/materials/bulk'), { inserted: 0, updated: 1, deleted: 0, warnings: [] });
  const reload = () => pending.slice(mark).find((p) => !p.done && p.url.includes('/master-data/materials?'));
  for (let i = 0; i < 50 && !reload(); i++) await tick(10);
  fire(reload(), page(mrows('M', 1, 3), 3)); // the post-save reload
  await tick(60);
}

test('post-save master-data refresh is dropped when the plant changed while it was in flight', async () => {
  Store.setMasterData({ plants: [{ plant: 'KEEP' }], lines: [{ plant: 'A', machine: 'L1' }] }, 't');
  await saveOneEdit();
  const plantsReq = lastOpen('/master-data/plants'), machineReq = lastOpen('/master-data/machine?plant=A');
  assert.ok(plantsReq && machineReq, 'refresh fetches issued');
  Store.setSelectedPlant('B', 't');
  fire(plantsReq, { rows: [{ plant: 'STALE' }] }); fire(machineReq, { rows: [{ plant: 'A', machine: 'STALE-L' }] }); await tick();
  assert.deepEqual(Store.masterData.plants.map((p) => p.plant), ['KEEP'], 'stale refresh must not overwrite master data');
  Store.setSelectedPlant('A', 't');
});

test('post-save refresh keeps the existing lines when the machine fetch fails', async () => {
  Store.setMasterData({ plants: [{ plant: 'KEEP' }], lines: [{ plant: 'A', machine: 'L1' }] }, 't');
  await saveOneEdit();
  for (const r of open('/master-data/plants')) fire(r, { rows: [{ plant: 'KEEP' }] }); // may be served from fetchTraced's GET cache
  fire(lastOpen('/master-data/machine?plant=A'), {}, false); await tick();
  assert.deepEqual(Store.masterData.lines.map((l) => l.machine), ['L1'], 'lines not blanked by a failed machine fetch');
});

// ---- Non-gating scope filters: scoped tabs always render their grid ----------------------------
const pvCols = [{ column_name: 'plant', display_label: 'Plant', is_locked: true }, { column_name: 'material_id', display_label: 'Material', is_locked: true }, { column_name: 'production_version', display_label: 'Version', is_locked: true }, { column_name: 'descr', display_label: 'Desc', is_locked: false }];
const gridPage = (columns, rows) => ({ columns, rows, meta: { total: rows.length } });
const fetchesSince = (mark, sub) => pending.slice(mark).filter((p) => p.url.includes(sub));
const thLabels = () => { const out = []; host.walk((n) => { if (n.tag === 'th' && n._cls.has('md-th')) out.push(n.children[0].textContent); }); return out; };
const filterBar = () => findNode((n) => n._cls.has('md-scope-filter-bar'));
// The combobox hosts of the filter bar (plant first, material second on bom_items).
const barHosts = () => { const hosts = []; filterBar()?.walk((n) => { if (n._cls.has('md-scope-field-host')) hosts.push(n); }); return hosts; };
const clearCombo = (comboHost) => comboHost.querySelector('.hps-combobox').querySelector('.hps-clear').listeners.click[0]();

test('G1: production_version with a plant opens in one plant-scoped, unpaged fetch and enables Paste + Upload', async () => {
  const prior = Store.selectedPlant;
  Store.setSelectedPlant('G1P', 't');
  try {
    const mark = pending.length;
    clickTab('production_version'); await tick();
    const reqs = fetchesSince(mark, '/master-data/production_version');
    assert.equal(reqs.length, 1, 'exactly one production_version fetch');
    assert.ok(reqs[0].url.endsWith('/master-data/production_version?plant=G1P'), reqs[0].url);
    assert.doesNotMatch(reqs[0].url, /limit/, 'not paged');
    fire(reqs[0], gridPage(pvCols, [{ plant: 'G1P', material_id: 'M1', production_version: '0001' }])); await tick();
    assert.ok(filterBar(), 'filter bar renders above the grid');
    const paste = findBtn('btn.paste_rows', '⎘ Paste Rows');
    const upload = findBtn('btn.upload_production_version', 'Upload Production Versions');
    assert.ok(paste && upload, 'Paste Rows and Upload are in the toolbar');
    assert.equal(paste.disabled, false);
    assert.equal(upload.disabled, false);
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('G2: routing_operation with no plant shows its columns from a limit=1 fetch, a hint row, and disabled row actions', async () => {
  const prior = Store.selectedPlant;
  Store.setSelectedPlant(null, 't');
  try {
    const mark = pending.length;
    clickTab('routing_operation'); await tick();
    const reqs = fetchesSince(mark, '/master-data/routing_operation');
    assert.equal(reqs.length, 1, 'exactly one fetch');
    assert.match(reqs[0].url, /limit=1(&|$)/);
    assert.doesNotMatch(reqs[0].url, /plant=/, 'no plant to send');
    // The route may return a row even for limit=1 — it must be discarded.
    fire(reqs[0], gridPage(pvCols, [{ plant: 'X', material_id: 'M9', production_version: '0009' }])); await tick();
    assert.deepEqual(thLabels(), ['Plant', 'Material', 'Version', 'Desc'], 'column headers render without a plant');
    assert.deepEqual(tbodyKeys(), [], 'no data rows');
    const empties = []; host.walk((n) => { if (n._cls.has('md-empty')) empties.push(n); });
    assert.equal(empties.length, 1, 'one hint row');
    assert.equal(empties[0].textContent, 'hint.scope_pick_plant');
    for (const [key, english] of [['btn.paste_rows', '⎘ Paste Rows'], ['btn.add_row', '+ Add Row'],
      ['btn.upload_routing_operation', 'Upload Routing Operations'], ['btn.delete_filtered', 'Delete Filtered Rows…']]) {
      const b = findBtn(key, english);
      assert.ok(b, `${key} rendered`);
      assert.equal(b.disabled, true, `${key} disabled`);
      assert.equal(b.title, 'hint.scope_pick_plant', `${key} explains why`);
    }
    assert.equal(searchBox().disabled, false, 'search stays enabled');
    assert.equal(findBtn('btn.add_column', '+ Add Column')?.disabled, false, 'Add Column stays enabled');
    assert.ok(filterBar(), 'the filter bar is how a plant gets chosen');
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('G3: bom_items with a plant and no material is server-paged and sends no material_id', async () => {
  const prior = Store.selectedPlant;
  Store.setSelectedPlant('G3P', 't');
  try {
    const mark = pending.length;
    clickTab('bom_items'); await tick();
    const reqs = fetchesSince(mark, '/master-data/bom_items');
    assert.equal(reqs.length, 1);
    assert.match(reqs[0].url, /plant=G3P/);
    assert.match(reqs[0].url, /limit=200/);
    assert.doesNotMatch(reqs[0].url, /material_id/);
    fire(reqs[0], gridPage(pvCols, [])); await tick();
    // The material picker is populated from the plant's material_plants rows.
    const mats = fetchesSince(mark, '/master-data/material_plants');
    assert.equal(mats.length, 1);
    fire(mats[0], { rows: [{ material_id: 'MB' }, { material_id: 'MA' }] }); await tick();
    assert.equal(barHosts().length, 2, 'plant and material comboboxes');
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('G4: clearing the plant filter on a clean grid drops back to the columns-only view', async () => {
  const prior = Store.selectedPlant;
  Store.setSelectedPlant('G4P', 't');
  try {
    const mark = pending.length;
    clickTab('production_version'); await tick();
    fire(fetchesSince(mark, '/master-data/production_version')[0], gridPage(pvCols, [{ plant: 'G4P', material_id: 'M1', production_version: '0001' }])); await tick();
    assert.equal(tbodyKeys().length, 1);
    const mark2 = pending.length;
    clearCombo(barHosts()[0]); await tick();
    const reqs = fetchesSince(mark2, '/master-data/production_version');
    assert.equal(reqs.length, 1);
    assert.match(reqs[0].url, /limit=1(&|$)/);
    fire(reqs[0], gridPage(pvCols, [])); await tick();
    assert.deepEqual(tbodyKeys(), []);
    assert.equal(findBtn('btn.paste_rows', '⎘ Paste Rows').disabled, true);
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('G5: changing the plant filter with unsaved edits is refused with a warning and nothing reloads', async () => {
  const prior = Store.selectedPlant;
  Store.setSelectedPlant('G5P', 't');
  try {
    const mark = pending.length;
    clickTab('production_version'); await tick();
    fire(fetchesSince(mark, '/master-data/production_version')[0], gridPage(pvCols, [{ plant: 'G5P', material_id: 'M1', production_version: '0001' }])); await tick();
    const c = cellFor('G5P|M1|0001'); c.textContent = 'EDIT'; c.oninput();
    toasts.length = 0;
    const mark2 = pending.length;
    clearCombo(barHosts()[0]); await tick();
    assert.ok(toasts.some((t) => t.endsWith('|warn')), 'user is told about the unsaved edits');
    assert.equal(fetchesSince(mark2, '/master-data/').length, 0, 'no reload');
    assert.equal(saveBtn().disabled, false, 'edits kept');
  } finally { Store.setSelectedPlant(prior, 't'); }
});

// ---- Paste Rows validates routing rows through the server; the routing-operations upload confirms ---
const pvColsGc = [...pvCols.slice(0, 3), { column_name: 'group_counter', display_label: 'Group Counter', is_locked: false }];
const useClipboard = (impl) => Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { readText: impl } }, configurable: true, writable: true });
const postBody = (p) => JSON.parse(p.init.body);
const pasteBtn = () => findBtn('btn.paste_rows', '⎘ Paste Rows');
async function openScoped(tab, plant, columns, rows = []) {
  Store.setSelectedPlant(plant, 't');
  const mark = pending.length;
  clickTab(tab); await tick();
  fire(fetchesSince(mark, `/master-data/${tab}`)[0], gridPage(columns, rows)); await tick();
}

test('P1: pasting production versions posts the rows to /routing/validate and stages only what the server returns', async () => {
  const prior = Store.selectedPlant;
  const savedLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'ui.paste_reject_row': 'Pasted row {{row}}' } };
  try {
    await openScoped('production_version', 'P1P', pvColsGc);
    useClipboard(async () => 'PLANT\tMATERIAL_ID\tPRODUCTION_VERSION\tGROUP_COUNTER\nP1P\tM1\t1\t1\nP1P\tBAD\t2\t1');
    confirmCalls.length = 0;
    const mark = pending.length;
    void pasteBtn().onclick(); await tick();
    const reqs = fetchesSince(mark, '/routing/validate/production_version');
    assert.equal(reqs.length, 1, 'one validate POST');
    assert.equal(reqs[0].init.method, 'POST');
    assert.deepEqual(postBody(reqs[0]).rows[0], { plant: 'P1P', material_id: 'M1', production_version: '1', group_counter: '1' });
    fire(reqs[0], { rows: [{ plant: 'P1P', material_id: 'M1', production_version: '0001', group_counter: '01' }], rejected: 1,
      warnings: [{ level: 'reject', msg: 'unknown_material', row: 2 }] }); await tick();
    assert.equal(confirmCalls.length, 1);
    assert.match(confirmCalls[0].detail, /Pasted row 2: unknown_material/, 'rejects are listed in the confirm');
    assert.deepEqual(tbodyKeys(), ['P1P|M1|0001'], 'only the server-returned row is staged');
    assert.equal(findNode((n) => n.dataset.col === 'group_counter' && n.dataset.rowKey === 'P1P|M1|0001').textContent, '01');
  } finally {
    // Discard the staged row so the next test's plant switch is not refused as "unsaved edits".
    const mark = pending.length;
    findBtn('btn.discard', 'Discard').onclick(); await tick();
    fire(fetchesSince(mark, '/master-data/production_version')[0], gridPage(pvColsGc, [])); await tick();
    globalThis.window.__NIMBUS_LOCALES = savedLocales;
    Store.setSelectedPlant(prior, 't');
  }
});

test('P2: a pasted block without a Plant column takes the filter plant before it is validated', async () => {
  const prior = Store.selectedPlant;
  try {
    await openScoped('production_version', 'P2P', pvColsGc);
    useClipboard(async () => 'MATERIAL_ID\tPRODUCTION_VERSION\nM2\t0001');
    const mark = pending.length;
    void pasteBtn().onclick(); await tick();
    const reqs = fetchesSince(mark, '/routing/validate/production_version');
    assert.equal(reqs.length, 1);
    assert.equal(postBody(reqs[0]).rows[0].plant, 'P2P');
    fire(reqs[0], { rows: [], rejected: 0, warnings: [] }); await tick();
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('P3: header names the grid does not know travel to the server as pasted', async () => {
  const prior = Store.selectedPlant;
  try {
    await openScoped('production_version', 'P3P', pvCols);
    useClipboard(async () => 'PLANT\tMATERIAL_ID\tPRODUCTION_VERSION\tGROUP_COUNTER\nP3P\tM3\t0001\t1');
    const mark = pending.length;
    void pasteBtn().onclick(); await tick();
    const reqs = fetchesSince(mark, '/routing/validate/production_version');
    assert.deepEqual(postBody(reqs[0]).rows[0], { plant: 'P3P', material_id: 'M3', production_version: '0001', GROUP_COUNTER: '1' });
    fire(reqs[0], { rows: [], rejected: 0, warnings: [] }); await tick();
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('P4: a failed validation toasts the backend detail and stages nothing', async () => {
  const prior = Store.selectedPlant;
  const savedLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.paste_validate_failed': 'Could not check the pasted rows: {{msg}}' } };
  try {
    await openScoped('routing_operation', 'P4P', pvCols);
    useClipboard(async () => 'MATERIAL_ID\tPRODUCTION_VERSION\nM4\t0001');
    toasts.length = 0; confirmCalls.length = 0;
    const mark = pending.length;
    void pasteBtn().onclick(); await tick();
    const reqs = fetchesSince(mark, '/routing/validate/routing_operation');
    assert.equal(reqs.length, 1);
    fire(reqs[0], { detail: 'Validate accepts at most 20000 rows' }, false); await tick();
    assert.ok(toasts.some((t) => t.endsWith('|error') && t.includes('20000')), toasts.join(' / '));
    assert.equal(confirmCalls.length, 0);
    assert.deepEqual(tbodyKeys(), []);
  } finally { globalThis.window.__NIMBUS_LOCALES = savedLocales; Store.setSelectedPlant(prior, 't'); }
});

test('P5: when the clipboard cannot be read the paste box opens and its text goes through the same flow', async () => {
  const prior = Store.selectedPlant;
  const realGet = globalThis.document.getElementById;
  const els = Object.fromEntries(['md-paste-modal', 'md-paste-box', 'md-paste-ok-btn', 'md-paste-cancel-btn', 'md-paste-close-btn'].map((id) => [id, new El('div')]));
  els['md-paste-modal'].hidden = true;
  try {
    await openScoped('production_version', 'P5P', pvColsGc);
    globalThis.document.getElementById = (id) => els[id] ?? realGet(id);
    useClipboard(async () => { throw new Error('denied'); });
    let mark = pending.length;
    void pasteBtn().onclick(); await tick();
    assert.equal(els['md-paste-modal'].hidden, false, 'paste box is open');
    assert.equal(fetchesSince(mark, '/routing/validate').length, 0, 'nothing validated yet');
    els['md-paste-box'].value = 'MATERIAL_ID\tPRODUCTION_VERSION\nM5\t0001';
    els['md-paste-ok-btn'].onclick(); await tick();
    assert.equal(els['md-paste-modal'].hidden, true, 'paste box closes on Paste');
    const reqs = fetchesSince(mark, '/routing/validate/production_version');
    assert.equal(reqs.length, 1);
    assert.equal(postBody(reqs[0]).rows[0].plant, 'P5P');
    fire(reqs[0], { rows: [], rejected: 0, warnings: [] }); await tick();
    // Cancel: no request, box closes.
    mark = pending.length;
    void pasteBtn().onclick(); await tick();
    assert.equal(els['md-paste-modal'].hidden, false);
    els['md-paste-box'].value = 'MATERIAL_ID\nX';
    els['md-paste-cancel-btn'].onclick(); await tick();
    assert.equal(els['md-paste-modal'].hidden, true);
    assert.equal(fetchesSince(mark, '/routing/validate').length, 0);
  } finally { globalThis.document.getElementById = realGet; Store.setSelectedPlant(prior, 't'); }
});

test('U1: the routing-operations upload confirms before the picker opens; a file for another plant moves the filter and names the plant', async () => {
  const prior = Store.selectedPlant;
  const realCreate = globalThis.document.createElement, realConfirm = Modal.confirm;
  const savedLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.routing_operation_upload_done': '{{inserted}} inserted, {{updated}} updated, {{rejected}} rejected · {{plants}}' } };
  const inputs = [];
  globalThis.document.createElement = (tag) => { const e = new El(tag); if (tag === 'input') { e.click = () => {}; inputs.push(e); } return e; };
  const pickers = () => inputs.filter((i) => i.type === 'file');
  const realGet = globalThis.document.getElementById, bulkHost = new El('div');
  globalThis.document.getElementById = (id) => (id === 'md-bulk-warnings' ? bulkHost : realGet(id));
  try {
    await openScoped('routing_operation', 'UA', pvCols);
    let inputsAtConfirm = -1, confirmOpts = null;
    Modal.confirm = async (o) => { confirmOpts = o; inputsAtConfirm = pickers().length; return true; };
    const uploadBtn = findBtn('btn.upload_routing_operation', 'Upload Routing Operations');
    await uploadBtn.onclick(); await tick();
    assert.ok(confirmOpts, 'confirm shown');
    assert.equal(confirmOpts.tone, 'warn');
    assert.equal(inputsAtConfirm, 0, 'confirm comes before any file input exists');
    assert.equal(pickers().length, 1, 'picker opens after a yes');
    // A declined confirm never opens the picker.
    Modal.confirm = async () => false;
    await uploadBtn.onclick(); await tick();
    assert.equal(pickers().length, 1, 'declined: no second picker');

    toasts.length = 0;
    pickers()[0].files = [{ name: 'ops.xlsx' }];
    const mark = pending.length;
    const changed = pickers()[0].onchange(); await tick();
    const up = fetchesSince(mark, '/routing/upload/operations');
    assert.equal(up.length, 1);
    fire(up[0], { inserted: 3, updated: 1, rejected: 0, warnings: [{ level: 'warn', msg: 'heads up' }], plants: ['UB'] }); await tick();
    const reload = fetchesSince(mark, '/master-data/routing_operation');
    assert.equal(reload.length, 1, 'one reload');
    assert.match(reload[0].url, /plant=UB/, 'filter follows the file\'s plant');
    fire(reload[0], gridPage(pvCols, [])); await changed; await tick();
    assert.ok(toasts.some((t) => t.includes('3 inserted') && t.includes('UB')), toasts.join(' / '));
    let shown = ''; bulkHost.walk((n) => { shown += n.textContent; });
    assert.match(shown, /heads up/, 'upload warnings render inline after the reload');
  } finally {
    globalThis.document.getElementById = realGet;
    globalThis.document.createElement = realCreate; Modal.confirm = realConfirm; globalThis.window.__NIMBUS_LOCALES = savedLocales;
    Store.setSelectedPlant(prior, 't');
  }
});

// ---- Final-review fixes: Runtime plant guard, orphaned paste, non-reject warnings ---------------------
// Drives the routing-operations upload end to end against a stubbed Runtime.load.
async function uploadOperations(plant, result) {
  const realCreate = globalThis.document.createElement, realConfirm = Modal.confirm, realLoad = Runtime.load;
  const inputs = [], loads = [];
  globalThis.document.createElement = (tag) => { const e = new El(tag); if (tag === 'input') { e.click = () => {}; inputs.push(e); } return e; };
  Runtime.load = async (p) => { loads.push(p); };
  try {
    await openScoped('routing_operation', plant, pvCols);
    Modal.confirm = async () => true;
    await findBtn('btn.upload_routing_operation', 'Upload Routing Operations').onclick(); await tick();
    const picker = inputs.find((i) => i.type === 'file');
    picker.files = [{ name: 'ops.xlsx' }];
    const mark = pending.length;
    const changed = picker.onchange(); await tick();
    fire(fetchesSince(mark, '/routing/upload/operations')[0], result); await tick();
    for (const r of fetchesSince(mark, '/master-data/routing_operation')) fire(r, gridPage(pvCols, []));
    await changed; await tick();
    return loads;
  } finally { globalThis.document.createElement = realCreate; Modal.confirm = realConfirm; Runtime.load = realLoad; }
}

test('F1: an upload only refreshes Runtime for the plant the Gantt shows, and only when the file touched it', async () => {
  const prior = Store.selectedPlant;
  try {
    const other = await uploadOperations('F1A', { inserted: 1, updated: 0, rejected: 0, warnings: [], plants: ['F1B', 'F1C'] });
    assert.deepEqual(other, [], 'a file for other plants leaves the Gantt plant\'s rate map alone');
    const own = await uploadOperations('F1A', { inserted: 1, updated: 0, rejected: 0, warnings: [], plants: ['F1A', 'F1B'] });
    assert.deepEqual(own, ['F1A'], 'a file that touched the Gantt plant reloads it once');
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('F3: a plant switch or a tab switch while the paste is being validated stages nothing and shows no success toast', async () => {
  const prior = Store.selectedPlant;
  try {
    for (const interrupt of ['plant', 'tab']) {
      await openScoped('production_version', `F3${interrupt}`, pvColsGc);
      useClipboard(async () => 'PLANT\tMATERIAL_ID\tPRODUCTION_VERSION\nF3\tM1\t0001');
      confirmCalls.length = 0; toasts.length = 0;
      const mark = pending.length;
      void pasteBtn().onclick(); await tick();
      const reqs = fetchesSince(mark, '/routing/validate/production_version');
      assert.equal(reqs.length, 1);
      if (interrupt === 'plant') clearCombo(barHosts()[0]); else clickTab('machine');
      await tick();
      fire(reqs[0], { rows: [{ plant: 'F3', material_id: 'M1', production_version: '0001' }], rejected: 0, warnings: [] }); await tick();
      assert.equal(confirmCalls.length, 0, `${interrupt}: no confirm for an abandoned grid`);
      assert.equal(toasts.some((t) => t.endsWith('|success')), false, `${interrupt}: no success toast`);
    }
  } finally { Store.setSelectedPlant(prior, 't'); }
});

test('F2: validate warnings that are not rejects (unknown column) reach the confirm detail beside the rejects', async () => {
  const prior = Store.selectedPlant;
  const savedLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'ui.paste_reject_row': 'Pasted row {{row}}', 'ui.paste_warnings_heading': 'Check these before you save:' } };
  try {
    await openScoped('production_version', 'F2P', pvColsGc);
    useClipboard(async () => 'PLANT\tMATERIAL_ID\tPRODUCTION_VERSION\tRUNTIME_X\nF2P\tM1\t1\t5\nF2P\tBAD\t2\t5');
    confirmCalls.length = 0;
    const mark = pending.length;
    void pasteBtn().onclick(); await tick();
    fire(fetchesSince(mark, '/routing/validate/production_version')[0], {
      rows: [{ plant: 'F2P', material_id: 'M1', production_version: '0001' }], rejected: 1,
      warnings: [{ level: 'warn', msg: 'Unknown column(s) ignored: RUNTIME_X <b>' }, { level: 'reject', msg: 'unknown_material', row: 2 }] }); await tick();
    assert.equal(confirmCalls.length, 1);
    const detail = confirmCalls[0].detail;
    assert.match(detail, /Check these before you save:/);
    assert.match(detail, /Unknown column\(s\) ignored: RUNTIME_X &lt;b&gt;/, 'warning shown, escaped');
    assert.match(detail, /Pasted row 2: unknown_material/, 'the reject is still listed');
  } finally {
    const m2 = pending.length;
    findBtn('btn.discard', 'Discard').onclick(); await tick();
    fire(fetchesSince(m2, '/master-data/production_version')[0], gridPage(pvColsGc, [])); await tick();
    globalThis.window.__NIMBUS_LOCALES = savedLocales;
    Store.setSelectedPlant(prior, 't');
  }
});

test('TI1: tool_inventory delete confirm runs before the bulk write: Cancel sends nothing and keeps the staged edit; OK sends one request; a delete + re-add of the same id skips the confirm', async () => {
  const { ToolInventory } = await import('../../../frontend/master-data/tool-inventory.mjs');
  const tiCols = [
    { column_name: 'plant', display_label: 'Plant', is_locked: true }, { column_name: 'tool_id', display_label: 'Tool ID', is_locked: true },
    { column_name: 'total_qty', display_label: 'Total', is_locked: false }, { column_name: 'out_of_service_qty', display_label: 'OOS', is_locked: false },
  ];
  const tiRows = () => [{ plant: 'TIP', tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }];
  const prior = Store.selectedPlant;
  const origConfirm = ToolInventory.confirmRemovals;
  const asked = [];
  let answer = false;
  ToolInventory.confirmRemovals = async (plant, ids) => { asked.push([plant, [...ids]]); return answer; };
  const delBtnFor = (key) => { let b = null; host.walk((n) => { if (n.tag === 'tr' && n.dataset.rowKey === key) n.walk((c) => { if (c._cls.has('md-del-btn')) b = c; }); }); return b; };
  const reload = async (mark) => { fire(fetchesSince(mark, '/master-data/tool_inventory')[0], gridPage(tiCols, tiRows())); await tick(); };
  try {
    await openScoped('tool_inventory', 'TIP', tiCols, tiRows());
    await delBtnFor('TIP|T1').onclick(); await tick();
    // Cancel: no bulk request, the staged delete is still there to retry.
    answer = false;
    const m1 = pending.length;
    saveBtn().onclick(); await tick();
    assert.deepEqual(asked, [['TIP', ['T1']]]);
    assert.equal(fetchesSince(m1, '/master-data/tool_inventory/bulk').length, 0, 'Cancel writes nothing');
    assert.equal(saveBtn().disabled, false, 'the staged delete is kept (Save stays enabled)');
    // OK: exactly one bulk request carrying the delete.
    answer = true;
    const m2 = pending.length;
    saveBtn().onclick(); await tick();
    const bulks = fetchesSince(m2, '/master-data/tool_inventory/bulk');
    assert.equal(bulks.length, 1);
    assert.deepEqual(postBody(bulks[0]).deletes.map((d) => d.tool_id), ['T1']);
    const m3 = pending.length;
    fire(bulks[0], { inserted: 0, updated: 0, deleted: 1, warnings: [] }); await tick();
    await reload(m3);
    // Delete + re-add of the same id in one save: an edit, no confirm.
    asked.length = 0;
    await delBtnFor('TIP|T1').onclick(); await tick();
    findBtn('btn.add_row', '+ Add Row', 'Add row')?.onclick();
    await tick();
    const cell = findNode((n) => n._cls.has('md-cell') && n.dataset.col === 'tool_id' && n.dataset.rowKey === 'TIP|');
    assert.ok(cell, 'the added row has an editable Tool ID cell');
    cell.textContent = 'T1'; cell.oninput();
    const m4 = pending.length;
    saveBtn().onclick(); await tick();
    assert.deepEqual(asked, [], 'no confirm for an id that is back as a row');
    const b2 = fetchesSince(m4, '/master-data/tool_inventory/bulk');
    assert.equal(b2.length, 1);
    assert.deepEqual([...new Set(postBody(b2[0]).upserts.map((r) => r.tool_id))], ['T1'], 'the re-added id is upserted (the grid engine may send the typed row twice: raw dirty copy + stripped added copy)');
    const m5 = pending.length;
    fire(b2[0], { inserted: 0, updated: 1, deleted: 1, warnings: [] }); await tick();
    await reload(m5);
  } finally {
    ToolInventory.confirmRemovals = origConfirm;
    Store.setSelectedPlant(prior, 't');
  }
});
