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
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; }
  focus() {} setSelectionRange() {} contains() { return false; }
  get options() { return this.children; }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
}

const host = new El('div'); host.id = 'md-host';
const tabs = ['subnetworks', 'plants', 'machine', 'materials', 'material_plants'].map((t) => { const b = new El('button'); b.dataset.mdTab = t; return b; });
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
Modal.confirm = async () => true;
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
