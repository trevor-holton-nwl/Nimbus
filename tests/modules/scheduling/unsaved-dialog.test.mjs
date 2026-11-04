// unsaved-dialog.mts against the dom-stub: rows, the 500 cap, filter, accordion, Show on Gantt, Escape/backdrop close,
// What-If banner, focus return to the badge, badge wiring + _syncUnsaved on the (now) button, and locale parity.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installDom } from '../helpers/dom-stub.mjs';
import { UnsavedDialog, MAX_ROWS } from '../../../frontend/scheduling/unsaved-dialog.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Modal } from '../../../frontend/platform/foundation.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

let dom, badge, mount, priorNimbus;
const rowFor = (id, extra = {}) => ({ id, PLANT: 'P', MATERIAL_NUMBER: `MAT${id}`, MATERIAL_DESCRIPTION: `Desc ${id}`, MACHINE: 'M1',
  'ORDER_QUANTITY_(GMEIN)': 60, PRODUCTION_VERSION: null, PRT_01: null, PRT_02: null,
  RUN_TIME: 3, run_time_source: 'manual', row_version: 1, planning_status: 'scheduled', user_scheduled: true,
  original_start_date: '2026-10-01T08:00:00', start_date: '2026-10-01T08:00:00',
  end_date: '2026-10-01T11:00:00', schedule_segments: [], ...extra });
const keyOf = id => Persistence._baselineKey(Persistence._taskEditSnapshot(Store.tasks[id]));
const text = e => [e.textContent, ...e.children.map(text)].filter(Boolean).join(' ');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function loadEnglish() {
  const w = {};
  vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window: w });
  dom.win.__NIMBUS_LOCALES = w.__NIMBUS_LOCALES;
}
function clearState() {
  for (const k of ['_dirtyIds', '_forceIds', '_conflictedIds', '_firmDirtyIds', '_dirtySource']) Persistence[k].clear();
  Persistence._savedBaseline.clear();
}
/** Loads rows, baselines them, then lets `edit(id)` change the live row; every id ends dirty. */
function seed(ids, { edit = () => {}, baseline = true } = {}) {
  Store.setTasks(ids.map(id => Persistence._prepTask(rowFor(id))), 'persistence');
  for (const id of ids) {
    if (baseline) Persistence._savedBaseline.set(id, { version: 1, key: keyOf(id) });
    edit(id);
    Persistence._dirtyIds.add(id);
  }
}
const trs = () => mount.querySelectorAll('tr.unsaved-row');
const idsShown = () => trs().map(tr => tr.dataset.id);
const btnOf = id => mount.querySelector(`#unsaved-d-${id}`) && trs().find(tr => tr.dataset.id === id).querySelector('button.unsaved-exp');
const detailOf = id => mount.querySelector(`#unsaved-d-${id}`);

beforeEach(() => {
  dom = installDom();
  loadEnglish();
  badge = dom.doc.createElement('button'); badge.id = 'schedule-unsaved'; badge.hidden = true; dom.doc.body.appendChild(badge);
  mount = dom.doc.createElement('div'); mount.id = 'unsaved-modal'; mount.className = 'modal-backdrop'; mount.hidden = true; dom.doc.body.appendChild(mount);
  Store.setMasterData({ plants: [{ plant: 'P', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }], lines: [] }, 'test');
  Store.setSelectedPlant('P', 'test');
  clearState();
  priorNimbus = globalThis.NIMBUS;
  UnsavedDialog._escape = null;
});
afterEach(() => {
  UnsavedDialog.close();
  Sandbox.active = false;
  clearState();
  globalThis.NIMBUS = priorNimbus;
  dom.restore();
});

test('opens with one row per unsaved order: title count, material, chip, machine, before/after, delta', () => {
  seed(['A', 'B'], { edit: id => { if (id === 'A') Store.updateTask('A', { end_date: new Date('2026-10-01T13:00:00'), start_date: new Date('2026-10-01T10:00:00') }, 'table'); else Store.updateTask('B', { MACHINE: 'M2' }, 'table'); } });
  UnsavedDialog.open();
  assert.equal(mount.hidden, false);
  assert.equal(mount.querySelector('#unsaved-title').textContent, 'Unsaved changes: 2');
  assert.deepEqual(idsShown().sort(), ['A', 'B']);
  const a = trs().find(tr => tr.dataset.id === 'A');
  assert.match(text(a), /MATA/); assert.match(text(a), /Desc A/);
  assert.equal(a.querySelector('.unsaved-chip').textContent, 'Moved');
  assert.equal(text(a.querySelector('.unsaved-delta')), '+2h');
  const b = trs().find(tr => tr.dataset.id === 'B');
  assert.equal(b.querySelector('.unsaved-chip').textContent, 'Machine changed');
  assert.match(text(b), /M1/); assert.match(text(b), /M2/);
  assert.match(text(mount), /Quantity and notes changes are not tracked here/);
});

test('empty state and the filter-miss state', () => {
  UnsavedDialog.open();
  assert.equal(trs().length, 0);
  assert.equal(mount.querySelector('.unsaved-empty').hidden, false);
  assert.match(text(mount.querySelector('.unsaved-empty')), /No unsaved changes/);
  UnsavedDialog.close();
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  const q = mount.querySelector('#unsaved-q'); q.value = 'zzz'; q.dispatch('input');
  assert.match(text(mount.querySelector('.unsaved-empty')), /match this filter/);
});

test('caps the list at 500 rows and says how many more', () => {
  const ids = Array.from({ length: MAX_ROWS + 3 }, (_, i) => `O${String(i).padStart(4, '0')}`);
  seed(ids, { baseline: false });   // no baseline: cheap rows, all "No saved reference"
  UnsavedDialog.open();
  assert.equal(trs().length, MAX_ROWS);
  assert.equal(mount.querySelector('#unsaved-title').textContent, `Unsaved changes: ${MAX_ROWS + 3}`);
  const cap = text(mount.querySelector('.unsaved-cap'));
  assert.match(cap, new RegExp(`Showing ${MAX_ROWS} of ${MAX_ROWS + 3}`));
  assert.match(cap, /and 3 more/);
  // A filter that narrows below the cap drops the "more".
  const q = mount.querySelector('#unsaved-q'); q.value = 'O0001'; q.dispatch('input');
  assert.equal(trs().length, 1);
  assert.doesNotMatch(text(mount.querySelector('.unsaved-cap')), /more/);
});

test('filter by order, material and machine', () => {
  seed(['A1', 'B2'], { edit: id => { if (id === 'B2') Store.updateTask('B2', { MACHINE: 'Blow-9' }, 'table'); else Store.updateTask('A1', { RUN_TIME: 4 }, 'table'); } });
  UnsavedDialog.open();
  const q = mount.querySelector('#unsaved-q');
  q.value = 'a1'; q.dispatch('input'); assert.deepEqual(idsShown(), ['A1']);
  q.value = 'matb2'; q.dispatch('input'); assert.deepEqual(idsShown(), ['B2']);
  q.value = 'blow'; q.dispatch('input'); assert.deepEqual(idsShown(), ['B2']);
  q.value = ''; q.dispatch('input'); assert.equal(trs().length, 2);
});

test('the Order column shows PRODUCTION_ORDER, shows a dash when empty, never shows the internal id; Show on Gantt keeps the id', t => {
  seed(['k1', 'k2'], { edit: id => { Store.updateTask(id, { MACHINE: 'M2' }, 'table'); if (id === 'k1') Store.updateTask('k1', { PRODUCTION_ORDER: '1000555' }, 'table'); else Store.updateTask('k2', { PRODUCTION_ORDER: '' }, 'table'); } });
  const go = t.mock.method(Selection, 'set', () => {}); t.mock.method(Timeline, 'gotoLineDay', () => {});
  UnsavedDialog.open();
  const idCell = id => trs().find(tr => tr.dataset.id === id).querySelector('.unsaved-id');
  assert.equal(idCell('k1').textContent, '1000555');
  assert.equal(idCell('k2').textContent, '—');
  assert.equal(btnOf('k2').getAttribute('aria-label'), 'Details for order —');
  assert.equal(btnOf('k1').getAttribute('aria-label'), 'Details for order 1000555');
  const q = mount.querySelector('#unsaved-q');
  q.value = '1000555'; q.dispatch('input'); assert.deepEqual(idsShown(), ['k1']);
  q.value = ''; q.dispatch('input');
  trs().find(tr => tr.dataset.id === 'k1').dispatch('click');
  detailOf('k1').querySelector('button.btn').dispatch('click');
  assert.deepEqual(go.mock.calls[0].arguments[0], ['k1']);
});

test('Changed by shows the session user in the detail, and is omitted without one', t => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  const m = t.mock.method(UnsavedDialog, 'userLabel', () => 'Pat Jones');
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  assert.match(text(detailOf('A')), /Changed by Pat Jones/);
  UnsavedDialog.close();
  m.mock.mockImplementation(() => '');
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  assert.doesNotMatch(text(detailOf('A')), /Changed by/);
});

test('sort select re-orders the rows', () => {
  seed(['B', 'A'], { edit: id => Store.updateTask(id, { MACHINE: id === 'A' ? 'M9' : 'M2' }, 'table') });
  UnsavedDialog.open();
  const s = mount.querySelector('#unsaved-sort');
  s.value = 'order'; s.dispatch('change'); assert.deepEqual(idsShown(), ['A', 'B']);
  s.value = 'machine'; s.dispatch('change'); assert.deepEqual(idsShown(), ['B', 'A']);
});

test('accordion: one row open at a time, aria-expanded/aria-controls follow, a second click closes', () => {
  seed(['A', 'B'], { edit: id => Store.updateTask(id, { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  const row = id => trs().find(tr => tr.dataset.id === id);
  assert.equal(btnOf('A').getAttribute('aria-controls'), 'unsaved-d-A');
  assert.equal(btnOf('A').getAttribute('aria-expanded'), 'false');
  assert.equal(detailOf('A').hidden, true);
  row('A').dispatch('click');
  assert.equal(btnOf('A').getAttribute('aria-expanded'), 'true'); assert.equal(detailOf('A').hidden, false);
  assert.match(text(detailOf('A')), /Machine/);
  row('B').dispatch('click');
  assert.equal(btnOf('A').getAttribute('aria-expanded'), 'false'); assert.equal(detailOf('A').hidden, true);
  assert.equal(btnOf('B').getAttribute('aria-expanded'), 'true'); assert.equal(detailOf('B').hidden, false);
  assert.equal(mount.querySelectorAll('tr.unsaved-detail').filter(d => !d.hidden).length, 1);
  row('B').dispatch('click');
  assert.equal(detailOf('B').hidden, true);
});

test('detail: every changed field Before -> After, source, engine move note, stale/no-reference notes', () => {
  seed(['A', 'C'], { edit: id => { if (id !== 'A') return;
    Store.updateTask('A', { MACHINE: 'M2', RUN_TIME: 4, systemMove: { from: new Date('2026-10-01T08:00:00'), to: new Date('2026-10-02T08:00:00'), reason: 'run_time_changed' } }, 'table');
    Persistence._dirtySource.set('A', 'drag');
  } });
  Persistence._savedBaseline.delete('C');   // C has no baseline entry
  UnsavedDialog.open();
  trs().find(tr => tr.dataset.id === 'A').dispatch('click');
  const d = text(detailOf('A'));
  assert.match(d, /Machine/); assert.match(d, /Run time/); assert.match(d, /M1/); assert.match(d, /M2/);
  assert.match(d, /Drag/);
  assert.match(d, /NIMBUS moved this order from/);
  trs().find(tr => tr.dataset.id === 'C').dispatch('click');
  assert.match(text(detailOf('C')), /No saved reference for this order/);
});

test('a stale mark (baseline equals current) is listed as No visible change with the stale note', () => {
  seed(['A']);
  UnsavedDialog.open();
  assert.equal(trs()[0].querySelector('.unsaved-chip').textContent, 'No visible change');
  trs()[0].dispatch('click');
  assert.match(text(detailOf('A')), /saved mark is stale/);
});

test('Show on Gantt closes, selects and centres the order on its machine and start day', t => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  const goto = [], sel = [];
  t.mock.method(Timeline, 'gotoLineDay', (...a) => goto.push(a));
  t.mock.method(Selection, 'set', ids => sel.push(ids));
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  detailOf('A').querySelector('button.btn').dispatch('click');
  assert.equal(mount.hidden, true);
  assert.deepEqual(sel, [['A']]);
  assert.equal(goto.length, 1);
  assert.equal(goto[0][0], 'M2');
  assert.equal(goto[0][1], Util.dayKey(Store.tasks.A.start_date));
  assert.deepEqual(goto[0][3], { taskId: 'A' });
});

test('Show on Gantt for an order with no dates selects it, switches to the Gantt tab and opens the Orders sub-tab', t => {
  seed(['A'], { edit: () => Store.updateTask('A', { start_date: null, end_date: null, planning_status: 'needs_planning' }, 'table') });
  const sel = [], subs = [], goto = [];
  t.mock.method(Timeline, 'gotoLineDay', (...a) => goto.push(a));
  t.mock.method(Selection, 'set', ids => sel.push(ids));
  globalThis.NIMBUS = { App: { goto: tab => subs.push(`tab:${tab}`), gotoGanttSub: s => subs.push(s) } };
  UnsavedDialog.open();
  assert.equal(trs()[0].querySelector('.unsaved-chip').textContent, 'Needs planning');
  trs()[0].dispatch('click');
  detailOf('A').querySelector('button.btn').dispatch('click');
  assert.deepEqual(sel, [['A']]); assert.deepEqual(subs, ['tab:gantt', 'orders']); assert.equal(goto.length, 0);
});

test('Escape closes, and only while open; a backdrop press closes but a press inside does not', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  dom.doc.dispatch('keydown', { key: 'Tab' });
  assert.equal(mount.hidden, false);
  dom.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(mount.hidden, true);
  assert.equal(UnsavedDialog._escape, null, 'the document listener is removed on close');
  UnsavedDialog.open();
  mount.querySelector('.modal').dispatch('click');
  assert.equal(mount.hidden, false, 'a click inside the dialog stays open');
  mount.dispatch('click');
  assert.equal(mount.hidden, true);
});

test('focus returns to the badge on close', async () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  badge.focus();
  UnsavedDialog.open();
  await tick();
  assert.notEqual(dom.doc.activeElement, badge);
  UnsavedDialog.close();
  assert.equal(dom.doc.activeElement, badge);
});

test('What-If banner shows only while the sandbox is active', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  assert.equal(mount.querySelector('.unsaved-banner').hidden, true);
  UnsavedDialog.close();
  Sandbox.active = true;
  UnsavedDialog.open();
  assert.equal(mount.querySelector('.unsaved-banner').hidden, false);
  assert.match(text(mount.querySelector('.unsaved-banner')), /What-If mode/);
});

test('an unsaved id that is no longer in the Store is not listed and is noted', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  Persistence._dirtyIds.add('GONE');
  UnsavedDialog.open();
  assert.deepEqual(idsShown(), ['A']);
  assert.equal(mount.querySelector('.unsaved-skipped').hidden, false);
});

test('init wires the badge once; _syncUnsaved still drives the button badge', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.init(); UnsavedDialog.init();
  assert.equal(badge.listeners.click.length, 1);
  Persistence._syncUnsaved();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '1 unsaved');
  badge.dispatch('click');
  assert.equal(mount.hidden, false);
  UnsavedDialog.close();
  Persistence._dirtyIds.clear(); Persistence._syncUnsaved();
  assert.equal(badge.hidden, true);
});

test('Modal sees the dialog as open while shown', () => {
  UnsavedDialog.open();
  assert.equal(Modal.anyOpen(), true);
  UnsavedDialog.close();
  assert.equal(Modal.anyOpen(), false);
});

// ---- locale parity: every unsaved.* key exists in all five locales with the same {{placeholders}} ----
test('unsaved.* keys exist in en, de, es, fr and pt with matching placeholders', () => {
  const load = l => { const w = {}; vm.runInNewContext(readFileSync(new URL(`../../../frontend/locales/${l}.js`, import.meta.url), 'utf8'), { window: w }); return w.__NIMBUS_LOCALES[l]; };
  const en = load('en');
  const keys = Object.keys(en).filter(k => k.startsWith('unsaved.'));
  assert.ok(keys.length > 50);
  const ph = s => (String(s).match(/\{\{\w+\}\}/g) || []).sort().join();
  for (const l of ['de', 'es', 'fr', 'pt']) {
    const d = load(l);
    for (const k of keys) {
      assert.ok(typeof d[k] === 'string' && d[k].length, `${l} is missing ${k}`);
      assert.equal(ph(d[k]), ph(en[k]), `${l} ${k} placeholders differ`);
    }
  }
  // Every key the dialog source asks for resolves.
  const src = readFileSync(new URL('../../../frontend/scheduling/unsaved-dialog.mts', import.meta.url), 'utf8');
  for (const m of src.matchAll(/'unsaved\.(\w+)'/g)) assert.ok(en[`unsaved.${m[1]}`], `unsaved.${m[1]} is used but not defined`);
});

test('the index.html badge is a button keeping id and role=status, with a static mount', () => {
  const html = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button[^>]*id="schedule-unsaved"[^>]*aria-haspopup="dialog"[^>]*><span role="status"><\/span><\/button>/);
  assert.doesNotMatch(html, /<button[^>]*id="schedule-unsaved"[^>]*role=/, 'the button keeps its own role');
  assert.match(html, /id="unsaved-modal"/);
});

test('Show on Gantt reveals a machine hidden by the global line filter (adds to the filter)', t => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  t.mock.method(Timeline, 'gotoLineDay', () => {});
  t.mock.method(Selection, 'set', () => {});
  Store.setSelectedLines(['M7'], 'test');
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  detailOf('A').querySelector('button.btn').dispatch('click');
  assert.deepEqual([...Store.selectedLines].sort(), ['M2', 'M7']);
  Store.setSelectedLines([], 'test');
});

test('the Tab trap survives close and reopen (the .modal element is reused, not replaced)', async () => {
  seed(['A', 'B'], { edit: id => Store.updateTask(id, { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open(); await tick();
  const first = mount.querySelector('.modal');
  UnsavedDialog.close();
  UnsavedDialog.open(); await tick();
  assert.equal(mount.querySelector('.modal'), first, 'the same dialog element across opens');
  const dlg = mount.querySelector('.modal');
  const focusables = dlg.querySelectorAll('input, select, button').filter(b => !b.hidden);
  const last = focusables[focusables.length - 1];
  last.focus();
  last.dispatch('keydown', { key: 'Tab' });
  assert.equal(dom.doc.activeElement, focusables[0], 'Tab from the last control wraps to the first');
});

test('reopening resets filter, sort and the open row', () => {
  seed(['A', 'B'], { edit: id => Store.updateTask(id, { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  const q = mount.querySelector('#unsaved-q'); q.value = 'a'; q.dispatch('input');
  trs()[0].dispatch('click');
  UnsavedDialog.close(); UnsavedDialog.open();
  assert.equal(mount.querySelector('#unsaved-q').value, '');
  assert.equal(trs().length, 2);
  assert.equal(mount.querySelectorAll('tr.unsaved-detail').filter(d => !d.hidden).length, 0);
});

test('a row click moves focus to its toggle button, and keys inside the dialog do not reach the document (Gantt) handlers', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  assert.equal(dom.doc.activeElement, btnOf('A'), 'focus stays inside the dialog');
  const seen = [];
  dom.doc.addEventListener('keydown', e => seen.push(e.key));
  for (const key of ['Delete', 'z', 'ArrowRight', 'f']) btnOf('A').dispatch('keydown', { key, ctrlKey: key === 'z' });
  assert.deepEqual(seen, [], 'owned keys are stopped at the dialog');
  btnOf('A').dispatch('keydown', { key: 'Tab' });
  assert.deepEqual(seen, ['Tab'], 'Tab still bubbles (Modal focus trap)');
});

test('Escape is stopped before the Gantt handler would clear the selection', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  UnsavedDialog.open();
  let stopped = false;
  dom.doc.dispatch('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(mount.hidden, true);
});

test('the badge count lives in an inner role=status span when there is one, so the button role survives', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { MACHINE: 'M2' }, 'table') });
  const live = dom.doc.createElement('span'); live.setAttribute('role', 'status'); badge.appendChild(live);
  Persistence._syncUnsaved();
  assert.equal(live.textContent, '1 unsaved');
  assert.equal(badge.hidden, false);
  assert.equal(badge.children.length, 1, 'the span is not wiped');
});

test('hours and Δ units come from the locale', () => {
  seed(['A'], { edit: () => Store.updateTask('A', { RUN_TIME: 4.5, start_date: new Date('2026-10-01T06:30:00') }, 'table') });
  UnsavedDialog.open();
  trs()[0].dispatch('click');
  assert.match(text(detailOf('A')), /3 h/);
  assert.match(text(detailOf('A')), /4\.5 h/);
  assert.equal(text(trs()[0].querySelector('.unsaved-delta')), '-1h 30m');
});
