import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../../../frontend/scheduling/orders.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });

// Fixture: a Table with every filter family active, a stub grid and the Orders filter DOM.
function fixture(t, { withTextarea = true, withApi = true } = {}) {
  const els = {
    'quick-filter': { value: 'not-found' },
    'tbl-flt-pomat-textarea': { value: 'OLD1' },
    'tbl-flt-pomat-count': { textContent: '1' },
  };
  if (!withTextarea) delete els['tbl-flt-pomat-textarea'];
  globalThis.document = { getElementById: id => els[id] ?? null };
  globalThis.window = { __NIMBUS_LOCALES: { en: { 'ui.pomat_count': '{{count}} IDs' } } };
  const calls = [];
  const oldApi = Table._api, oldFilters = Table._chipFilters;
  t.after(() => { Table._api = oldApi; Table._chipFilters = oldFilters; Store.setSelectedLines([], 'test'); });
  Store.setSelectedLines(['L1'], 'test');
  Table._chipFilters = { lines: Store.selectedLines, colors: new Set(['RED']), status: 'needs_planning', dateKey: 'late', poMat: new Set(['OLD1']), poMatMatcher: null };
  Table._api = withApi ? {
    setGridOption: (...a) => calls.push(a),
    isAnyFilterPresent: () => true,
    setFilterModel: m => calls.push(['native', m]),
    onFilterChanged: () => calls.push(['changed']),
  } : null;
  for (const key of ['_refreshChipButtons', '_refreshChipDropdowns', '_resetChipSearch']) t.mock.method(Table, key, () => {});
  return { els, calls };
}

test('filterToOrders clears every other filter then applies the order list', t => {
  const { els, calls } = fixture(t);
  assert.equal(Table.filterToOrders(['A-1', ' B-2 ', 'A-1', '', '  ', 'C-3']), true);
  assert.equal(els['quick-filter'].value, '');
  assert.ok(calls.some(c => c[0] === 'quickFilterText' && c[1] === ''));
  assert.ok(calls.some(c => c[0] === 'native' && c[1] === null));
  assert.equal(Store.selectedLines.size, 0);
  assert.equal(Table._chipFilters.colors.size, 0);
  assert.equal(Table._chipFilters.status, null);
  assert.equal(Table._chipFilters.dateKey, null);
  assert.deepEqual([...Table._chipFilters.poMat].sort(), ['A-1', 'B-2', 'C-3']);
  assert.equal(typeof Table._chipFilters.poMatMatcher, 'object');
  assert.notEqual(Table._chipFilters.poMatMatcher, null);
  assert.equal(els['tbl-flt-pomat-textarea'].value, 'A-1\nB-2\nC-3');
  assert.equal(els['tbl-flt-pomat-count'].textContent, '3 IDs');
  assert.equal(calls.at(-1)[0], 'changed');
});

test('filterToOrders replaces an earlier PO/Material list rather than adding to it', t => {
  fixture(t);
  assert.equal(Table.filterToOrders(['X-9']), true);
  assert.deepEqual([...Table._chipFilters.poMat], ['X-9']);
});

for (const [name, opts, arg] of [
  ['the PO/Material box is missing', { withTextarea: false }, ['A-1']],
  ['the grid is not ready', { withApi: false }, ['A-1']],
  ['the list is empty', {}, []],
  ['only blanks are given', {}, ['', '   ', null, undefined]],
  ['only wildcard tokens are given', {}, ['*', '**']],
  ['the argument is not an array', {}, undefined],
]) {
  test(`filterToOrders returns false and changes nothing when ${name}`, t => {
    const { els, calls } = fixture(t, opts);
    assert.equal(Table.filterToOrders(arg), false);
    assert.deepEqual(calls, []);
    assert.equal(els['quick-filter'].value, 'not-found');
    if (els['tbl-flt-pomat-textarea']) assert.equal(els['tbl-flt-pomat-textarea'].value, 'OLD1');
    assert.deepEqual([...Store.selectedLines], ['L1']);
    assert.deepEqual([...Table._chipFilters.colors], ['RED']);
    assert.equal(Table._chipFilters.status, 'needs_planning');
    assert.equal(Table._chipFilters.dateKey, 'late');
    assert.deepEqual([...Table._chipFilters.poMat], ['OLD1']);
  });
}
