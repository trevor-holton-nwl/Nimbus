// Wave 1 fixes in frontend/scheduling/orders.mts: pure helpers behind the machine editor's initial highlight,
// the setup-override 422 message, the grid's plant test and the Inspector subscriber's re-render filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Table, initialActiveIndex, formatApiDetail, inSelectedPlantFor, inspectorShouldRerender,
} from '../../../frontend/scheduling/orders.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

test('initialActiveIndex preselects the current value, else 0', () => {
  const opts = [{ value: 'M1' }, { value: 'M2' }, { value: 'M3' }];
  assert.equal(initialActiveIndex(opts, 'M3'), 2);
  assert.equal(initialActiveIndex(opts, 'M9'), 0);
  assert.equal(initialActiveIndex(opts, ''), 0);
  assert.equal(initialActiveIndex(opts, null), 0);
  assert.equal(initialActiveIndex([], 'M1'), 0);
  const pairs = [{ value: '0001|M1' }, { value: '0002|M2' }];
  assert.equal(initialActiveIndex(pairs, '0002|M2'), 1);
});

test('formatApiDetail renders strings, 422 arrays and falls back', () => {
  assert.equal(formatApiDetail('Plant locked', 'HTTP 409'), 'Plant locked');
  assert.equal(
    formatApiDetail([{ msg: 'field required', loc: ['body', 'reason'] }, { msg: 'bad number' }], 'HTTP 422'),
    'field required; bad number');
  assert.equal(formatApiDetail(undefined, 'HTTP 500'), 'HTTP 500');
  assert.equal(formatApiDetail([], 'HTTP 422'), 'HTTP 422');
  assert.ok(!formatApiDetail([{ msg: 'x' }], 'f').includes('[object Object]'));
});

test('inSelectedPlantFor prefers the task PLANT, then the line plant', () => {
  const lineMap = m => ({ M1: 'P1', M2: 'P2' })[m];
  assert.equal(inSelectedPlantFor({ PLANT: 'P1', MACHINE: 'M2' }, 'P1', lineMap), true);
  assert.equal(inSelectedPlantFor({ MACHINE: 'M1' }, 'P1', lineMap), true);
  assert.equal(inSelectedPlantFor({ MACHINE: 'Unmapped', PLANT: 'P1' }, 'P1', lineMap), true);
  assert.equal(inSelectedPlantFor({ MACHINE: 'M2' }, 'P1', lineMap), false);
  assert.equal(inSelectedPlantFor({ MACHINE: 'M1' }, null, lineMap), false);
});

test('Table._inSelectedPlant reads Store.selectedPlant', () => {
  const prior = Store.selectedPlant;
  try {
    Store.setSelectedPlant('ZZ9', 'unit-test');
    assert.equal(Table._inSelectedPlant({ PLANT: 'ZZ9', MACHINE: 'nope' }), true);
    assert.equal(Table._inSelectedPlant({ PLANT: 'AA1', MACHINE: 'nope' }), false);
  } finally { Store.setSelectedPlant(prior, 'unit-test'); }
});

test('inspectorShouldRerender: note saves and unrelated bulk events do not re-render', () => {
  const open = 'abc';
  assert.equal(inspectorShouldRerender({ type: 'task:update', id: 'abc', source: 'note' }, open, false), false);
  assert.equal(inspectorShouldRerender({ type: 'task:update', id: 'abc', source: 'table' }, open, false), true);
  assert.equal(inspectorShouldRerender({ type: 'task:update', id: 'zzz' }, open, false), false);
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulkUpdate', ids: ['x', 'y'] }, open, false), false);
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulkUpdate', ids: ['x', 'abc'] }, open, false), true);
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulkUpdate' }, open, false), false);
  assert.equal(inspectorShouldRerender({ type: 'firmed:change', ids: ['y'] }, open, false), false);
  assert.equal(inspectorShouldRerender({ type: 'firmed:change', ids: ['abc'] }, open, false), true);
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulk' }, open, false), true);
  assert.equal(inspectorShouldRerender({ type: 'setup-snapshot:replace' }, open, false), true);
  assert.equal(inspectorShouldRerender({ type: 'alerts:change' }, open, false), false);
});

test('inspectorShouldRerender: never while the notes field is focused or nothing is open', () => {
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulk' }, 'abc', true), false);
  assert.equal(inspectorShouldRerender({ type: 'task:update', id: 'abc' }, 'abc', true), false);
  assert.equal(inspectorShouldRerender({ type: 'tasks:bulk' }, null, false), false);
});
