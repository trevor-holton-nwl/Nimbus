// MaterialGrids.setQuickFilter(which, text) — the public entry the Alert Monitor's routing-gap cards use
// after App.gotoMasterSub('routing-pv'): applies to the grid now when it is ready, else in onGridReady.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';

let fixtureId = 0;

async function fixture(t, { autoReady }) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, style: {}, hidden: false, value: '', listeners: {}, addEventListener(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
      querySelectorAll: () => [], querySelector: () => null, toggleAttribute() {}, closest: () => null, clientWidth: 0,
    });
    return nodes.get(id);
  };
  const gridOptions = [];
  const api = { setGridOption(key, value) { gridOptions.push([key, value]); }, getDisplayedRowCount: () => 0, applyTransaction() {}, refreshCells() {} };
  let captured;
  t.mock.method(Util, 'fetchTraced', () => new Promise(() => {}));
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Store, 'subscribe', () => {});
  const originals = { document: globalThis.document, agGrid: globalThis.agGrid, requestAnimationFrame: globalThis.requestAnimationFrame, window: globalThis.window };
  Object.assign(globalThis, {
    document: { getElementById: element, addEventListener() {} }, window: {}, requestAnimationFrame() {},
    agGrid: { createGrid(_el, opts) { captured = opts; if (autoReady) opts.onGridReady({ api }); } },
  });
  const previousPlant = Store.selectedPlant;
  t.after(() => {
    Store.setSelectedPlant(previousPlant, 'test');
    for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  const { MaterialGrids } = await import(`../../../frontend/master-data/material-grids.mjs?quick=${++fixtureId}`);
  Store.setSelectedPlant('A', 'test');
  return { MaterialGrids, element, gridOptions, ready: () => captured.onGridReady({ api }) };
}

const quickCalls = f => f.gridOptions.filter(([k]) => k === 'quickFilterText');

test('setQuickFilter applies at once when the grid is ready and mirrors the text into the box', async t => {
  const f = await fixture(t, { autoReady: true });
  f.MaterialGrids.render('routing-pv');
  f.MaterialGrids.setQuickFilter('routing-pv', 'MAT-7');
  assert.deepEqual(quickCalls(f), [['quickFilterText', 'MAT-7']]);
  assert.equal(f.element('md-rpv-quick').value, 'MAT-7');
});

test('setQuickFilter defers to onGridReady when the grid is not built yet', async t => {
  const f = await fixture(t, { autoReady: false });
  f.MaterialGrids.render('routing-pv');
  f.MaterialGrids.setQuickFilter('routing-pv', 'MAT-7');
  assert.deepEqual(quickCalls(f), [], 'nothing applied before the grid is ready');
  f.ready();
  assert.deepEqual(quickCalls(f), [['quickFilterText', 'MAT-7']]);
  assert.equal(f.element('md-rpv-quick').value, 'MAT-7');
});

test('setQuickFilter called before the grid exists at all is applied when it is later created', async t => {
  const f = await fixture(t, { autoReady: true });
  f.MaterialGrids.setQuickFilter('routing-pv', 'MAT-9');
  assert.deepEqual(quickCalls(f), []);
  f.MaterialGrids.render('routing-pv');
  assert.deepEqual(quickCalls(f), [['quickFilterText', 'MAT-9']]);
});

test('an unknown grid id is ignored', async t => {
  const f = await fixture(t, { autoReady: true });
  assert.doesNotThrow(() => f.MaterialGrids.setQuickFilter('nope', 'x'));
});
