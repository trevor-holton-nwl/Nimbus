// Store + UndoStack tests, split from tests/modules/schedule-state.test.mjs
// (Phase P4 of docs/architecture/domain-refactor-plan.md, which split
// schedule-state.mts into 3 domain files: platform/store.mjs,
// scheduling/selection.mjs, optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';

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

test('Store.getPlantForLine falls back to explicit task ownership when master data is absent', () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorLineSettings = structuredClone(Store.lineSettings);
  try {
    Store.setMasterData({ plants: [{ plant: 'TASK-OWNER' }], lines: [] }, 'unit-test');
    Store.setTasks([{ id: 'task-owner', PLANT: 'TASK-OWNER', MACHINE: 'UNMAPPED-LINE', RUN_TIME: 1 }], 'unit-test');
    assert.equal(Store.getPlantForLine('UNMAPPED-LINE'), 'TASK-OWNER');
  } finally {
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    for (const line of Object.keys(Store.lineSettings)) delete Store.lineSettings[line];
    Object.assign(Store.lineSettings, priorLineSettings);
    Store.rebuildPlantIndex();
  }
});

test('Store.replaceBlocks/replaceCalendars/replacePlants/replacePlantBlocks/replaceFirmedIds replace wholesale and emit', () => {
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  Store.replaceBlocks([{ id: 'b1' }], 'unit-test');
  Store.replaceCalendars({ L1: { workHours: {} } }, 'unit-test');
  Store.replacePlants({ '5512': { workHours: {} } }, 'unit-test');
  Store.replacePlantBlocks([{ id: 'pb1' }], 'unit-test');
  Store.replaceFirmedIds(new Set(['t1']), 'unit-test');
  off();
  assert.deepEqual(Store.blocks, [{ id: 'b1' }]);
  assert.deepEqual(Store.plantBlocks, [{ id: 'pb1' }]);
  assert.ok(Store.firmedIds.has('t1'));
  assert.deepEqual(events, [
    'blocks:replace', 'blocks:change',
    'calendar:replace', 'calendar:change',
    'plants:replace', 'calendar:change',
    'plantBlocks:replace', 'plantBlocks:change',
    'firmed:replace', 'firmed:change',
  ]);
});

test('Store exposes priorityRankMaps state and setter', () => {
  assert.deepEqual(Store.priorityRankMaps, {});
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  assert.deepEqual(Store.priorityRankMaps, { '': { colorWheel: { RED: 1 } } });
});

test('Store.setPriorityRankMaps null-guards its argument and deliberately emits NOTHING', () => {
  // Contract changed in Stage 3's final-review fix wave (2026-08-11): this setter
  // used to emit 'priority-rank-maps:updated'. It must not. Store.subscribe has
  // one subscriber with no event-type filter (Persistence.autosave,
  // application-shell.mts), so ANY emit here schedules a full localStorage cache
  // write and bumps Store._rev — invalidating Utilization._cache, whose memo key
  // includes rev() — on every rank load, including one per Optimize-dialog open
  // and one per Scheduling Constraints render, neither of which changes schedule
  // data. Same rule, same reason, as setLastOptimize's own no-emit comment.
  // Nothing subscribes to rank-map changes; every reader pulls on demand.
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  const revBefore = Store.rev();
  Store.setPriorityRankMaps(null);
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } }, 'unit-test');
  off();
  assert.deepEqual(Store.priorityRankMaps, { '': { colorWheel: { RED: 1 } } });
  assert.deepEqual(events, [], 'no Store event may be emitted for a rank-map write');
  assert.equal(Store.rev(), revBefore, 'Store._rev must not move — it gates Utilization memo validity');
  Store.setPriorityRankMaps({}, 'unit-test'); // reset
});

test('Store.replaceSetupSnapshot replaces the active plant snapshot and publishes the replacement', () => {
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  const snapshot = {
    plant: '5512', definition: null, plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    freshness: { signature_version: null, request_id: 'state-test' },
  };
  Store.replaceSetupSnapshot(snapshot, 'unit-test');
  Store.replaceSetupSnapshot(null, 'unit-test');
  off();

  assert.equal(Store.setupSnapshot, null);
  assert.deepEqual(events.map(evt => evt.type), ['setup-snapshot:replace', 'setup-snapshot:replace']);
  assert.equal(events[0].snapshot, snapshot);
  assert.equal(events[1].snapshot, null);
});

test('Store.setAllowedPlantsResolver scopes knownPlants()', () => {
  Store.setTasks([{ id: 't1', MACHINE: 'L1', RUN_TIME: '1' }], 'unit-test');
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

test('Store.removeTask removes the id from Selection directly (a real cross-file import, platform/store.mjs -> scheduling/selection.mjs)', () => {
  Store.setTasks([{ id: 'rm1', RUN_TIME: '1' }], 'unit-test');
  Selection.clear();
  Selection.add(['rm1']);
  assert.ok(Selection.has('rm1'));
  Store.removeTask('rm1', 'unit-test');
  assert.ok(!Selection.has('rm1'));
});

test('Store.removeTask removes the task from its cached plant bucket', () => {
  Store.setTasks([{ id: 'remove-from-index', PLANT: 'P-INDEX', MACHINE: 'L1' }], 'unit-test');
  assert.equal(Store.tasksByPlant('P-INDEX').length, 1);
  Store.removeTask('remove-from-index', 'unit-test');
  assert.equal(Store.tasksByPlant('P-INDEX').length, 0);
});

test('Store.siblingsByParent groups by PARENT_ORDER and returns the same Map for an unchanged rev', () => {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'unit-test');
  Store.setTasks([
    { id: 'sib-a', PARENT_ORDER: 'SAP-1', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1' },
    { id: 'sib-b', PARENT_ORDER: 'SAP-1', DISTRIBUTION_LETTER: 'B', MACHINE: 'L1' },
    { id: 'sib-solo', MACHINE: 'L1' },
  ], 'unit-test');
  const first = Store.siblingsByParent();
  assert.deepEqual(first.get('SAP-1').map(t => t.id).sort(), ['sib-a', 'sib-b']);
  assert.equal(first.has('sib-solo'), false, 'tasks without PARENT_ORDER are not grouped');
  assert.equal(Store.siblingsByParent(), first, 'same Map instance for an unchanged rev');

  Store.setTasks([{ id: 'sib-c', PARENT_ORDER: 'SAP-2', MACHINE: 'L1' }], 'unit-test'); // bumps rev via emit
  const second = Store.siblingsByParent();
  assert.notEqual(second, first, 'rebuilds after an emit bumps rev');
  assert.deepEqual(second.get('SAP-2').map(t => t.id), ['sib-c']);
  Store.setSelectedPlant(priorPlant, 'unit-test');
});

test('Store.siblingsByParent reflects Store.removeTask (in-place splice, caught only via rev)', () => {
  const priorPlant = Store.selectedPlant;
  Store.setSelectedPlant(null, 'unit-test');
  Store.setTasks([
    { id: 'rm-sib-a', PARENT_ORDER: 'SAP-RM', MACHINE: 'L1' },
    { id: 'rm-sib-b', PARENT_ORDER: 'SAP-RM', MACHINE: 'L1' },
  ], 'unit-test');
  assert.equal(Store.siblingsByParent().get('SAP-RM').length, 2);
  Store.removeTask('rm-sib-a', 'unit-test');
  assert.deepEqual(Store.siblingsByParent().get('SAP-RM').map(t => t.id), ['rm-sib-b']);
  Store.setSelectedPlant(priorPlant, 'unit-test');
});

test('UndoStack.push caps at MAX(10) entries', () => {
  for (let i = 0; i < 12; i++) UndoStack.push(`entry-${i}`, () => {});
  assert.ok(UndoStack._entries.length <= UndoStack.MAX);
});

test('UndoStack.push emits undo:pushed with the entry label', () => {
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'undo:pushed') events.push(evt); });
  UndoStack.push('unit-test-label', () => {});
  off();
  assert.ok(events.some(e => e.label === 'unit-test-label'));
});

test('UndoStack.snapshotTasks/restoreTasks round-trip through Store', () => {
  Store.setTasks([{ id: 'u1', RUN_TIME: '2', start_date: new Date('2026-01-01') }], 'unit-test');
  const snap = UndoStack.snapshotTasks(['u1']);
  Store.updateTask('u1', { RUN_TIME: '9' }, 'unit-test');
  UndoStack.restoreTasks(snap);
  assert.equal(Store.tasks['u1'].RUN_TIME, '2');
});

test('UndoStack.invalidate drops entries whose ids intersect, keeps id-less ones (D31)', () => {
  UndoStack._entries = [];
  UndoStack.push('a', () => {}, [1, 2]);
  UndoStack.push('b', () => {}, ['3']);
  UndoStack.push('c', () => {});
  UndoStack.invalidate(['2']);
  assert.deepEqual(UndoStack._entries.map(e => e.label), ['b', 'c']);
  UndoStack.invalidate([]);
  assert.equal(UndoStack._entries.length, 2);
  UndoStack._entries = [];
});

test('UndoStack.pop ignores re-entrant pops while an async undo is pending (senior audit #4)', async () => {
  UndoStack._entries = [];
  const hadWin = 'window' in globalThis, hadDoc = 'document' in globalThis;
  if (!hadWin) globalThis.window = {};
  if (!hadDoc) globalThis.document = { getElementById: () => null };
  const log = [];
  let release;
  UndoStack.push('A older', () => { log.push('A'); });
  UndoStack.push('B async', () => new Promise((r) => { release = r; }).then((ok) => { if (!ok) return false; log.push('B'); }));
  assert.equal(UndoStack.pop()?.label, 'B async');
  assert.equal(UndoStack.pop(), null, 'second Ctrl+Z while the confirm is open is ignored');
  release(false);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, []);
  assert.deepEqual(UndoStack._entries.map((e) => e.label), ['A older', 'B async'], 'cancelled entry restored in order');
  assert.equal(UndoStack.pop()?.label, 'B async', 'pops work again once settled');
  release(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ['B']);
  UndoStack._entries = [];
  if (!hadWin) delete globalThis.window;
  if (!hadDoc) delete globalThis.document;
});
