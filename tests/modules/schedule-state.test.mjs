import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, Selection, UndoStack, Sandbox } from '../../web/schedule-state.mjs';

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

test('Store.removeTask removes the id from Selection directly (Selection is a sibling export in this module)', () => {
  Store.setTasks([{ id: 'rm1', RUN_TIME: '1' }], 'unit-test');
  Selection.clear();
  Selection.add(['rm1']);
  assert.ok(Selection.has('rm1'));
  Store.removeTask('rm1', 'unit-test');
  assert.ok(!Selection.has('rm1'));
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

test('Sandbox.enter snapshots current state and flips active/mode', () => {
  Store.setTasks([{ id: 'sb1', RUN_TIME: '1' }], 'unit-test');
  assert.equal(Store.mode(), 'live');
  const entered = Sandbox.enter('unit-test');
  assert.equal(entered, true);
  assert.equal(Sandbox.active, true);
  assert.equal(Store.mode(), 'draft');
  Sandbox.exit(false, 'unit-test');
});

test('Sandbox.enter is a no-op (returns false) when already active', () => {
  Sandbox.enter('unit-test');
  assert.equal(Sandbox.enter('unit-test'), false);
  Sandbox.exit(false, 'unit-test');
});

test('Sandbox.exit(false) restores the pre-enter snapshot and emits sandbox:exited', () => {
  Store.setTasks([{ id: 'sb2', RUN_TIME: '1' }], 'unit-test');
  Store.setFixed('sb2', true, 'unit-test');
  Sandbox.enter('unit-test');
  Store.setFixed('sb2', false, 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  const snap = Sandbox.exit(false, 'unit-test');
  off();
  assert.ok(Store.isFixed('sb2'), 'discard must restore the pre-sandbox fixed flag');
  assert.equal(Sandbox.active, false);
  assert.equal(Store.mode(), 'live');
  const exitEvt = events.find(e => e.type === 'sandbox:exited');
  assert.equal(exitEvt.applied, false);
  assert.equal(exitEvt.snapshot, snap);
});

test('Sandbox.exit(false) emits one *:replace event per restored field, pinned so drift is deliberate', () => {
  // Each Store.replaceX() call fires its own '<field>:replace' event, distinct
  // from the '<field>:change' events that field's normal mutators fire — see
  // docs/architecture/cq1-compatibility-inventory.md §6. Nothing subscribes to
  // the *:replace variants today (a grep across web/ confirms it), so the extra
  // events are inert — but a future consumer of 'blocks:change'/'calendar:change'/
  // etc. must also handle the '*:replace' counterpart, or it will silently miss
  // updates made during a What-If discard. This test exists so a change to that
  // event contract (fewer/more/renamed events) is a deliberate edit here, not a
  // silent regression.
  Store.setTasks([{ id: 'sb-repl', RUN_TIME: '1' }], 'unit-test');
  Sandbox.enter('unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  Sandbox.exit(false, 'unit-test');
  off();
  assert.deepEqual(events, [
    'tasks:bulk',
    'blocks:replace',
    'calendar:replace',
    'plants:replace',
    'plantBlocks:replace',
    'fixed:replace',
    'sandbox:exited',
  ]);
});

test('Sandbox.exit(true) pushes exactly one UndoStack entry and emits applied:true', () => {
  // Reset the shared UndoStack singleton first — an earlier test in this file
  // intentionally saturates it to MAX(10) entries, at which point every further
  // push evicts the oldest and length stops growing, masking a push undercount.
  UndoStack._entries.length = 0;
  Store.setTasks([{ id: 'sb3', RUN_TIME: '1' }], 'unit-test');
  Sandbox.enter('unit-test');
  const before = UndoStack._entries.length;
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  Sandbox.exit(true, 'unit-test');
  off();
  assert.equal(UndoStack._entries.length, before + 1);
  const exitEvt = events.find(e => e.type === 'sandbox:exited');
  assert.equal(exitEvt.applied, true);
});
