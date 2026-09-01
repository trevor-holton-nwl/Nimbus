// Sandbox tests, split from tests/modules/schedule-state.test.mjs (Phase P4
// of docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// into 3 domain files: platform/store.mjs, scheduling/selection.mjs,
// optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, UndoStack } from '../../../web/platform/store.mjs';
import { Sandbox } from '../../../web/optimization/sandbox.mjs';

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
  Store.setFirmed('sb2', true, 'unit-test');
  Sandbox.enter('unit-test');
  Store.setFirmed('sb2', false, 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  const snap = Sandbox.exit(false, 'unit-test');
  off();
  assert.ok(Store.isFirmed('sb2'), 'discard must restore the pre-sandbox firmed flag');
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
    'firmed:replace',
    'sandbox:exited',
  ]);
});

test('Sandbox.exit(true) pushes exactly one UndoStack entry and emits applied:true', () => {
  // Reset the shared UndoStack singleton first — an earlier test in this suite
  // (tests/modules/platform/store.test.mjs) intentionally saturates it to
  // MAX(10) entries, at which point every further push evicts the oldest and
  // length stops growing, masking a push undercount. Node's test runner runs
  // each file in its own process, so this reset is only needed against
  // pushes made earlier in THIS file.
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
