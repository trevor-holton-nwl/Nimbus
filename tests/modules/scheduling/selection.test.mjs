// Selection tests, split from tests/modules/schedule-state.test.mjs (Phase P4
// of docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// into 3 domain files: platform/store.mjs, scheduling/selection.mjs,
// optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';

test('Selection tracks ids and selectedRefs() resolves plant per id', () => {
  Store.setTasks([{ id: 'sel1', plant: '5512', MACHINE: 'L1', RUN_TIME: '1' }], 'unit-test');
  Selection.clear();
  Selection.add(['sel1']);
  assert.deepEqual(Selection.ids(), ['sel1']);
  assert.deepEqual(Selection.selectedRefs(), [{ plant: '5512', id: 'sel1' }]);
  Selection.clear();
});

test('selectRange without a predicate selects the whole span; with one it drops rejected orders but keeps anchor and target', () => {
  const d = h => new Date(2026, 0, 1, h);
  Store.setTasks([
    { id: 'r1', plant: '5512', MACHINE: 'L1', RUN_TIME: '1', start_date: d(1), end_date: d(2) },
    { id: 'r2', plant: '5512', MACHINE: 'L1', RUN_TIME: '1', start_date: d(3), end_date: d(4) },
    { id: 'r3', plant: '5512', MACHINE: 'L1', RUN_TIME: '1', start_date: d(5), end_date: d(6) },
    { id: 'r4', plant: '5512', MACHINE: 'L1', RUN_TIME: '1', start_date: d(7), end_date: d(8) },
  ], 'unit-test');
  Selection.set(['r1']);
  Selection.selectRange('r4');
  assert.deepEqual(Selection.ids().sort(), ['r1', 'r2', 'r3', 'r4']);
  assert.equal(Selection._anchor, 'r1');

  Selection.set(['r1']);
  Selection.selectRange('r4', t => String(t.id) !== 'r2' && String(t.id) !== 'r4');
  assert.deepEqual(Selection.ids().sort(), ['r1', 'r3', 'r4']);   // r2 dimmed out; the clicked target stays
  Selection.clear();
});
