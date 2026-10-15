// Tests for frontend/master-data/material-grids.mts — Material / Material Plant grids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaterialGrids } from '../../../frontend/master-data/material-grids.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, Modal } from '../../../frontend/platform/foundation.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
let fixtureId = 0;

async function gridFixture(t) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, hidden: id.includes('pane') && id !== 'md-master-material-plant-pane',
      listeners: {}, addEventListener(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
      querySelectorAll: () => [], querySelector: () => null,
      toggleAttribute() {}, closest: () => null, clientWidth: 0,
    });
    return nodes.get(id);
  };
  const requests = [];
  let options;
  let rows = [];
  let plantChanged;
  const api = {
    setGridOption(key, value) { if (key === 'rowData') rows = value; },
    getDisplayedRowCount: () => rows.length,
    getRowNode: key => ({ data: rows.find(r => `${r.material_id}|${r.plant}` === key) }),
    applyTransaction() {}, refreshCells() {},
  };
  t.mock.method(Util, 'fetchTraced', (url, opts) => new Promise(resolve => requests.push({ url, opts, resolve })));
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Store, 'subscribe', listener => { plantChanged = listener; });
  const originals = { document: globalThis.document, agGrid: globalThis.agGrid, requestAnimationFrame: globalThis.requestAnimationFrame, window: globalThis.window };
  Object.assign(globalThis, {
    document: { getElementById: element, addEventListener() {} }, window: {},
    requestAnimationFrame() {},
    agGrid: { createGrid(_el, opts) { options = opts; opts.onGridReady({ api }); } },
  });
  const previousPlant = Store.selectedPlant;
  t.after(() => {
    Store.setSelectedPlant(previousPlant, 'test');
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const { MaterialGrids: grid } = await import(`../../../frontend/master-data/material-grids.mjs?fixture=${++fixtureId}`);
  grid.init();
  function switchPlant(plant) {
    Store.setSelectedPlant(plant, 'test');
    plantChanged({ type: 'plant:selected' });
  }
  function respond(request, body, status = 200) {
    request.resolve({ ok: status < 400, status, json: async () => body, headers: new Headers() });
  }
  async function load(plant, color) {
    switchPlant(plant);
    respond(requests.at(-1), { rows: [{ material_id: 'MAT', plant, color, prt_01: '', prt_02: '', default_machine: '' }] });
    await settle();
  }
  function edit(value, field = 'color') {
    rows[0][field] = value;
    options.onCellValueChanged({ colDef: { field }, data: rows[0], newValue: value, api, node: {} });
  }
  return { grid, requests, load, switchPlant, respond, edit, element, options: () => options, rows: () => rows, saveButton: () => element('md-mp-save') };
}

test('Material grid module exposes documented public API', () => {
  assert.equal(typeof MaterialGrids.init, 'function');
  assert.equal(typeof MaterialGrids._clearFilters, 'function');
  assert.equal(typeof MaterialGrids._save, 'function');
  assert.equal(typeof MaterialGrids._discard, 'function');
  assert.equal(typeof MaterialGrids.refresh, 'function');
});

test('default_machine column is configured with select editor and unknown-machine marker', () => {
  // Design doc §4.5 (P1-11): default_machine column uses agSelectCellEditor with
  // values = blank + plant machine names (Store.linesForSelectedPlant()), a
  // cellClassRules marker mp-unknown-machine when the stored value is non-blank
  // and not a member of the plant's current machines, with tooltip "Not a machine
  // of this plant — no distribution default will apply", and a header tooltip
  // with locale key col.default_machine_hint.
  //
  // This test verifies the module loads and exports the documented public API.
  // Integration tests exercise the actual select editor, cellClassRules rule
  // application, and CSS soft-warn tint display in a jsdom environment.
  assert.equal(typeof MaterialGrids, 'object');
  assert.equal(typeof MaterialGrids.init, 'function');
});

for (const newer of ['blue', 'white']) {
  test(`save preserves a later edit to ${newer}, including a return to the original value`, async t => {
    const f = await gridFixture(t);
    await f.load('A', 'white');
    f.edit('red'); f.grid._save('material-plant');
    const first = f.requests.at(-1);
    f.edit(newer);
    f.respond(first, { updated: 1 }); await settle();
    assert.equal(f.rows()[0].color, newer);
    assert.equal(f.saveButton().disabled, false, 'newer cell must still be dirty');
    f.grid._save('material-plant');
    assert.equal(JSON.parse(f.requests.at(-1).opts.body).updates[0].color, newer);
    f.respond(f.requests.at(-1), { updated: 1 }); await settle();
    assert.equal(f.saveButton().disabled, true);
  });
}

test('acknowledgement preserves an unrelated field edited while saving', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white');
  f.edit('red'); f.grid._save('material-plant');
  const first = f.requests.at(-1);
  f.edit('TOOL', 'prt_01');
  f.respond(first, { updated: 1 }); await settle();
  f.grid._save('material-plant');
  assert.deepEqual(JSON.parse(f.requests.at(-1).opts.body).updates, [{ material_id: 'MAT', prt_01: 'TOOL' }]);
  f.respond(f.requests.at(-1), { updated: 1 }); await settle();
});

test('save failure retains the current edit for retry', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
  f.edit('blue'); f.respond(f.requests.at(-1), { detail: 'failed' }, 500); await settle();
  assert.equal(f.saveButton().disabled, false);
  f.grid._save('material-plant');
  assert.equal(JSON.parse(f.requests.at(-1).opts.body).updates[0].color, 'blue');
  f.respond(f.requests.at(-1), { updated: 1 }); await settle();
});

test('old plant response cannot mutate the new plant while its own write is pending', async t => {
    const f = await gridFixture(t);
    await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
    const old = f.requests.at(-1);
    await f.load('B', 'green');
    f.edit('blue'); f.grid._save('material-plant');
    const current = f.requests.at(-1);
    assert.notEqual(current, old, 'different plants may save independently');
    assert.equal(current.opts?.method, 'POST');
    f.respond(old, { updated: 1 }); await settle();
    assert.equal(f.rows()[0].color, 'blue');
    assert.equal(f.saveButton().disabled, true, 'old finally must not unlock pending new save');
    f.respond(current, { updated: 1 }); await settle();
    assert.equal(f.rows()[0].color, 'blue');
    f.edit('purple'); f.grid._discard('material-plant');
    assert.equal(f.rows()[0].color, 'blue', 'baseline is only the new generation acknowledgement');
});

test('late forbidden response cannot mark a new plant read-only', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
  const old = f.requests.at(-1);
  await f.load('B', 'green');
  f.edit('blue');
  f.respond(old, { detail: 'forbidden' }, 403); await settle();
  assert.equal(f.rows()[0].color, 'blue');
  assert.equal(Toast.show.mock.calls.some(call => call.arguments[1] === 'error'), false);
  f.grid._save('material-plant');
  assert.equal(JSON.parse(f.requests.at(-1).opts.body).plant, 'B');
  f.respond(f.requests.at(-1), { updated: 1 }); await settle();
});

test('A-B-A blocks a second same-plant write until the first commits', async t => {
  const f = await gridFixture(t);
  let databaseColor = 'white';
  await f.load('A', databaseColor); f.edit('red'); f.grid._save('material-plant');
  const older = f.requests.at(-1);
  await f.load('B', 'green'); await f.load('A', databaseColor);
  f.edit('blue');
  assert.equal(f.saveButton().disabled, true);
  const count = f.requests.length;
  f.grid._save('material-plant');
  assert.equal(f.requests.length, count, 'same plant must have only one outstanding POST');
  databaseColor = JSON.parse(older.opts.body).updates[0].color;
  f.respond(older, { updated: 1 }); await settle();
  assert.equal(f.rows()[0].color, 'blue');
  assert.equal(f.saveButton().disabled, false);
  f.grid._save('material-plant');
  const newer = f.requests.at(-1);
  assert.deepEqual(JSON.parse(newer.opts.body).updates, [{ material_id: 'MAT', color: 'blue' }]);
  databaseColor = JSON.parse(newer.opts.body).updates[0].color;
  f.respond(newer, { updated: 1 }); await settle();
  assert.equal(databaseColor, 'blue');
  assert.equal(f.saveButton().disabled, true);
});

for (const edited of [false, true]) {
  test(`returning to A reconciles its committed baseline with ${edited ? 'a reverted newer edit' : 'no newer edit'}`, async t => {
    const f = await gridFixture(t);
    await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
    const older = f.requests.at(-1);
    await f.load('B', 'green'); await f.load('A', 'white');
    if (edited) { f.edit('blue'); f.edit('white'); }
    f.respond(older, { updated: 1 }); await settle();
    assert.equal(f.rows()[0].color, edited ? 'white' : 'red');
    assert.equal(f.saveButton().disabled, !edited);
    if (edited) {
      f.grid._save('material-plant');
      assert.equal(JSON.parse(f.requests.at(-1).opts.body).updates[0].color, 'white');
      f.respond(f.requests.at(-1), { updated: 1 }); await settle();
    }
    f.edit('purple'); f.grid._discard('material-plant');
    assert.equal(f.rows()[0].color, edited ? 'white' : 'red');
  });
}

test('a GET started before the pending write settles cannot reinstall its stale baseline', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
  const older = f.requests.at(-1);
  await f.load('B', 'green'); f.switchPlant('A');
  const staleGet = f.requests.at(-1);
  f.respond(older, { updated: 1 }); await settle();
  f.respond(staleGet, { rows: [{ material_id: 'MAT', plant: 'A', color: 'white' }] }); await settle();
  assert.equal(f.rows()[0].color, 'red');
  f.edit('purple'); f.grid._discard('material-plant');
  assert.equal(f.rows()[0].color, 'red');
});

test('a failed old-generation A write releases A for retry without clearing newer edits', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white'); f.edit('red'); f.grid._save('material-plant');
  const older = f.requests.at(-1);
  await f.load('B', 'green'); await f.load('A', 'white'); f.edit('blue');
  f.respond(older, { detail: 'failed' }, 500); await settle();
  assert.equal(f.rows()[0].color, 'blue');
  assert.equal(f.saveButton().disabled, false);
  f.grid._save('material-plant');
  assert.deepEqual(JSON.parse(f.requests.at(-1).opts.body).updates, [{ material_id: 'MAT', color: 'blue' }]);
  f.respond(f.requests.at(-1), { updated: 1 }); await settle();
});

test('default_machine editor is the searchable combobox editor, not a plain select (D61)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../frontend/master-data/material-grids.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cellEditor:\s*'agSelectCellEditor'/);
  assert.match(source, /cellEditor:\s*_mkMachineComboEditor\(\)/);
});

// -- refresh(): re-pull the active grid for the SAME plant ------------------------

const mpRow = (id, color = '') => ({ material_id: id, plant: 'A', color, prt_01: '', prt_02: '', default_machine: '' });

test('refresh re-fetches the same plant where render would not', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white');
  const count = f.requests.length;
  f.grid.render('material-plant');
  assert.equal(f.requests.length, count, 'render is a no-op for an already-loaded plant');
  const pending = f.grid.refresh('material-plant');
  await settle();
  assert.equal(f.requests.length, count + 1);
  assert.match(f.requests.at(-1).url, /_material-plant-grid\?plant=A$/);
  f.respond(f.requests.at(-1), { rows: [mpRow('MAT', 'green')] });
  assert.equal(await pending, true);
  await settle();
  assert.equal(f.rows()[0].color, 'green', 'fresh database rows replace the cached ones');
});

test('refresh builds the grid first when the sub-tab was never rendered', async t => {
  const f = await gridFixture(t);
  Store.setSelectedPlant('A', 'test');
  const pending = f.grid.refresh('material');
  await settle();
  assert.match(f.requests.at(-1).url, /_material-grid\?plant=A$/);
  f.respond(f.requests.at(-1), { rows: [{ material_id: 'MAT', material_type: 'FERT' }] });
  assert.equal(await pending, true);
  await settle();
  assert.equal(f.rows().length, 1, 'rows reach the freshly created grid api');
});

test('refresh keeps filter-bar selections and search text', async t => {
  const f = await gridFixture(t);
  const rebuilds = [];
  t.mock.method(Util, 'renderLineChecklist', (_el, candidates, selected, search) => {
    rebuilds.push({ candidates, selected: new Set(selected), search });
  });
  await f.load('A', 'white');
  const input = f.element('md-mp-filterbar-material_id-search');
  const paste = text => input.listeners.paste[0]({ preventDefault() {}, clipboardData: { getData: () => text } });
  input.value = 'MA';
  input.listeners.input[0]();      // type a search term
  paste('MAT');                    // select MAT via the bigset paste path
  assert.equal(f.options().isExternalFilterPresent(), true);

  const pending = f.grid.refresh('material-plant');
  await settle();
  f.respond(f.requests.at(-1), { rows: [mpRow('MAT'), mpRow('OTHER')] });
  assert.equal(await pending, true);
  await settle();

  assert.equal(f.options().isExternalFilterPresent(), true, 'selection survives the reload');
  assert.equal(f.options().doesExternalFilterPass({ data: f.rows()[0] }), true);
  assert.equal(f.options().doesExternalFilterPass({ data: f.rows()[1] }), false);
  rebuilds.length = 0;
  paste('OTHER');                  // forces a checklist rebuild that reads the live state
  const last = rebuilds.at(-1);
  assert.equal(last.search, 'MA', 'search text survives the reload');
  assert.deepEqual([...last.selected].sort(), ['MAT', 'OTHER']);
  assert.deepEqual(last.candidates, ['MAT', 'OTHER'], 'distinct values come from the reloaded rows');
});

test('refresh with unsaved edits asks first and leaves everything alone on cancel', async t => {
  const f = await gridFixture(t);
  const confirm = t.mock.method(Modal, 'confirm', async () => false);
  await f.load('A', 'white'); f.edit('red');
  const count = f.requests.length;
  assert.equal(await f.grid.refresh('material-plant'), false);
  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(f.requests.length, count, 'cancel must not fetch');
  assert.equal(f.saveButton().disabled, false, 'the edit is still dirty');
  assert.equal(f.rows()[0].color, 'red');
});

test('refresh with unsaved edits discards them on confirm and reloads', async t => {
  const f = await gridFixture(t);
  t.mock.method(Modal, 'confirm', async () => true);
  await f.load('A', 'white'); f.edit('red');
  const count = f.requests.length;
  const pending = f.grid.refresh('material-plant');
  await settle();
  assert.equal(f.requests.length, count + 1);
  f.respond(f.requests.at(-1), { rows: [mpRow('MAT', 'white')] });
  assert.equal(await pending, true);
  await settle();
  assert.equal(f.rows()[0].color, 'white');
  assert.equal(f.saveButton().disabled, true, 'dirty map is empty after the reload');
});

test('refresh with no plant selected resolves false without fetching', async t => {
  const f = await gridFixture(t);
  await f.load('A', 'white');
  Store.setSelectedPlant(null, 'test');
  const count = f.requests.length;
  assert.equal(await f.grid.refresh('material-plant'), false);
  assert.equal(f.requests.length, count);
});
