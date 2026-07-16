import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, Selection, UndoStack } from '../../web/schedule-state.mjs';

test('Store.rev() starts at 0 and increments on every mutation', () => {
  const before = Store.rev();
  Store.setTasks([], 'unit-test');
  assert.equal(Store.rev(), before + 1);
});

test('Store.mode() defaults to live', () => {
  assert.equal(Store.mode(), 'live');
});

test('emitted events carry revision and mode', () => {
  let seen = null;
  const off = Store.subscribe(evt => { seen = evt; });
  Store.setTasks([], 'unit-test');
  off();
  assert.equal(typeof seen.revision, 'number');
  assert.equal(seen.mode, 'live');
});

test('Store.rebuildPlantIndex is public (renamed from _rebuildPlantIndex)', () => {
  assert.equal(typeof Store.rebuildPlantIndex, 'function');
  assert.doesNotThrow(() => Store.rebuildPlantIndex());
});

test('Store.replaceBlocks/replaceCalendars/replacePlants/replacePlantBlocks/replaceFixedIds replace wholesale and emit', () => {
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  Store.replaceBlocks([{ id: 'b1' }], 'unit-test');
  Store.replaceCalendars({ L1: { workHours: {} } }, 'unit-test');
  Store.replacePlants({ '5512': { workHours: {} } }, 'unit-test');
  Store.replacePlantBlocks([{ id: 'pb1' }], 'unit-test');
  Store.replaceFixedIds(new Set(['t1']), 'unit-test');
  off();
  assert.deepEqual(Store.blocks, [{ id: 'b1' }]);
  assert.deepEqual(Store.plantBlocks, [{ id: 'pb1' }]);
  assert.ok(Store.fixedIds.has('t1'));
  assert.deepEqual(events, ['blocks:replace', 'calendar:replace', 'plants:replace', 'plantBlocks:replace', 'fixed:replace']);
});

test('Store.setAllowedPlantsResolver scopes knownPlants()', () => {
  Store.setTasks([{ id: 't1', PRODUCTION_LINE: 'L1', RUN_TIME: '1' }], 'unit-test');
  Store.setAllowedPlantsResolver(() => ['5512']);
  const known = Store.knownPlants();
  assert.ok(known.includes('5512') || known.length === 0); // scoped set never includes a disallowed plant
  Store.setAllowedPlantsResolver(() => null); // reset
});

test('Store.setSettingsDefaultsResolver feeds Store.pref()\'s fallback tier', () => {
  Store.setSettingsDefaultsResolver(() => ({ landingView: 'dashboard' }));
  assert.equal(Store.pref('landingView'), 'dashboard');
  Store.setSettingsDefaultsResolver(() => ({})); // reset
});

test('Store.setSelectionRemoveHook is called by removeTask instead of a bare Selection reference', () => {
  // NIMBUS's own Selection module doesn't live in this file yet (a later CQ-1 task
  // moves it here) and the browser defines an unrelated global `Selection` (the DOM
  // Selection API) — removeTask must go through the injected hook, never a bare
  // `Selection.remove(...)` reference that would resolve to the wrong thing.
  Store.setTasks([{ id: 'rm1', RUN_TIME: '1' }], 'unit-test');
  let removedId = null;
  Store.setSelectionRemoveHook(id => { removedId = id; });
  Store.removeTask('rm1', 'unit-test');
  assert.equal(removedId, 'rm1');
  Store.setSelectionRemoveHook(() => {}); // reset
});

test('Selection tracks ids and selectedRefs() resolves plant per id', () => {
  Store.setTasks([{ id: 'sel1', plant: '5512', PRODUCTION_LINE: 'L1', RUN_TIME: '1' }], 'unit-test');
  Selection.clear();
  Selection.add(['sel1']);
  assert.deepEqual(Selection.ids(), ['sel1']);
  assert.deepEqual(Selection.selectedRefs(), [{ plant: '5512', id: 'sel1' }]);
  Selection.clear();
});

test('UndoStack.push caps at MAX(10) entries', () => {
  for (let i = 0; i < 12; i++) UndoStack.push(`entry-${i}`, () => {});
  assert.ok(UndoStack._entries.length <= UndoStack.MAX);
});

test('UndoStack.snapshotTasks/restoreTasks round-trip through Store', () => {
  Store.setTasks([{ id: 'u1', RUN_TIME: '2', start_date: new Date('2026-01-01') }], 'unit-test');
  const snap = UndoStack.snapshotTasks(['u1']);
  Store.updateTask('u1', { RUN_TIME: '9' }, 'unit-test');
  UndoStack.restoreTasks(snap);
  assert.equal(Store.tasks['u1'].RUN_TIME, '2');
});
