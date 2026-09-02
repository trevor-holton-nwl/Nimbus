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
