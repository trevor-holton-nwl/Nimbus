// Sandbox tests, split from tests/modules/schedule-state.test.mjs (Phase P4
// of docs/architecture/domain-refactor-plan.md, which split schedule-state.mts
// into 3 domain files: platform/store.mjs, scheduling/selection.mjs,
// optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Modal, Toast } from '../../../frontend/platform/foundation.mjs';
import { SandboxAdapter } from '../../../frontend/optimization/optimize-ui.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

const _per = (id) => ({ id, name: id, validFrom: '2026-10-01', validTo: null, workHours: { 1: [6, 14] } });

test('Sandbox discard restores plant periods added during What-If', () => {
  const prior = structuredClone(Store.plants);
  try {
    Store.replacePlants({ SBP: { workHours: { 1: [8, 16] }, periods: [_per('keep')] } }, 'unit-test');
    Sandbox.enter('unit-test');
    Store.setPlantPeriods('SBP', [_per('keep'), _per('added')], 'plant-periods');
    assert.equal(Store.getPlantPeriods('SBP').length, 2);
    Sandbox.exit(false, 'unit-test');
    assert.deepEqual(Store.getPlantPeriods('SBP').map(p => p.id), ['keep']);
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    Store.replacePlants(prior, 'unit-test');
  }
});

test('_collectAffectedPlants flags a plant whose only change is its periods', () => {
  const prior = structuredClone(Store.plants);
  try {
    Store.replacePlants({ SBP: { workHours: { 1: [8, 16] } }, OTHER: { workHours: { 1: [8, 16] } } }, 'unit-test');
    Sandbox.enter('unit-test');
    Store.setPlantPeriods('SBP', [_per('added')], 'plant-periods');
    const snap = Sandbox._snapshot;
    assert.deepEqual([...SandboxAdapter._collectAffectedPlants(snap)], ['SBP']);
    Sandbox.exit(false, 'unit-test');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    Store.replacePlants(prior, 'unit-test');
  }
});

test('undoing a promoted scenario re-syncs periods that exist only in the promoted state (removed.periods)', () => {
  const prior = structuredClone(Store.plants);
  const priorFlush = CalendarSync.flushPlant, priorToast = Toast.show, priorSchedule = Alerts.scheduleRecompute;
  const priorNimbus = globalThis.NIMBUS;
  const calls = [];
  CalendarSync.flushPlant = (plant, removed) => calls.push({ plant, removed });
  Toast.show = () => {};
  Alerts.scheduleRecompute = () => {};
  globalThis.NIMBUS = {};
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = {};
  try {
    Store.replacePlants({ SBP: { workHours: { 1: [8, 16] } } }, 'unit-test');   // restored (pre-promote) state: no periods
    const promoted = { tasks: [], blocks: [], plantBlocks: [], calendars: {}, firmedIds: [],
      plants: { SBP: { workHours: { 1: [8, 16] }, periods: [_per('p-new')] } } };
    SandboxAdapter._onReverted({ type: 'sandbox:reverted', promoted });
    assert.deepEqual(calls.map(c => c.plant), ['SBP']);
    assert.deepEqual(calls[0].removed, { line: [], plant: [], periods: ['p-new'] });
  } finally {
    CalendarSync.flushPlant = priorFlush; Toast.show = priorToast; Alerts.scheduleRecompute = priorSchedule;
    if (priorNimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = priorNimbus;
    if (!hadWindow) delete globalThis.window;
    Store.replacePlants(prior, 'unit-test');
  }
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

test('Sandbox.exit(false) emits replace events plus change compatibility events for every restored field', () => {
  // Each Store.replaceX() call fires its own '<field>:replace' event followed
  // by the established '<field>:change' compatibility event. Consumers must
  // docs/architecture/cq1-compatibility-inventory.md §6. Nothing subscribes to
  // the *:replace variant is paired with the normal compatibility event so
  // events are inert — but a future consumer of 'blocks:change'/'calendar:change'/
  // etc. must also handle the '*:replace' counterpart, or it will silently miss
  // updates made during a What-If discard. This test exists so a change to that
  // event contract (fewer/more/renamed events) is a deliberate edit here, not a
  // silent regression. The compatibility event is the live refresh channel;
  // the replace event records the wholesale operation for consumers that need
  // to distinguish it from an incremental mutation.
  Store.setTasks([{ id: 'sb-repl', RUN_TIME: '1' }], 'unit-test');
  Sandbox.enter('unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt.type));
  Sandbox.exit(false, 'unit-test');
  off();
  assert.deepEqual(events, [
    'tasks:bulk',
    'blocks:replace', 'blocks:change',
    'calendar:replace', 'calendar:change',
    'plants:replace', 'calendar:change',
    'plantBlocks:replace', 'plantBlocks:change',
    'firmed:replace', 'firmed:change',
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

test('applied-scenario undo carries task ids and asks before reverting later calendar edits', async () => {
  UndoStack._entries.length = 0;
  Store.setTasks([{ id: 'sb4', RUN_TIME: '1' }], 'unit-test');
  Sandbox.enter('unit-test');
  Sandbox.exit(true, 'unit-test');
  const entry = UndoStack._entries.at(-1);
  assert.deepEqual(entry.ids, ['sb4']);

  // Calendar edit made after applying -> confirm; cancel aborts and keeps the entry.
  Store.replacePlants({ ...Store.plants, ZZ: { hours: [6, 18] } }, 'unit-test');
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = {};
  const origConfirm = Modal.confirm;
  let asked = 0;
  Modal.confirm = async () => { asked++; return false; };
  try {
    const events = [];
    const off = Store.subscribe(evt => events.push(evt));
    assert.equal(await entry.undoFn(), false);
    off();
    assert.equal(asked, 1);
    assert.equal(events.some(e => e.type === 'sandbox:reverted'), false);
    assert.ok(Store.plants.ZZ);
  } finally { Modal.confirm = origConfirm; if (!hadWindow) delete globalThis.window; }
});

test('applied-scenario undo restores tasks through the dirty path with the live row_version (senior audit #2)', async () => {
  UndoStack._entries.length = 0;
  const dirty = new Set();
  // mirror of App._trackDirty
  const off = Store.subscribe((evt) => {
    if (['refresh', 'note', 'distribution'].includes(evt.source)) return;
    if (evt.type === 'task:update') dirty.add(String(evt.id));
    if (evt.type === 'tasks:bulkUpdate') evt.ids.forEach((i) => dirty.add(String(i)));
    if (evt.type === 'tasks:bulk') dirty.clear();
  });
  try {
    const d0 = new Date('2026-10-06T08:00:00'), d1 = new Date('2026-10-06T10:00:00'), d2 = new Date('2026-10-07T08:00:00');
    Store.setTasks([{ id: 'wu1', MACHINE: 'L1', PLANT: 'P', start_date: d0, end_date: d1, RUN_TIME: '2', row_version: 5 }], 't');
    Sandbox.enter('t');
    Store.updateTask('wu1', { start_date: d2, end_date: new Date(d2.getTime() + 7200e3) }, 'sandbox-edit');
    Sandbox.exit(true, 't');
    // server accepted the promoted save -> new version, clean
    dirty.clear();
    Store.updateTask('wu1', { row_version: 6 }, 'refresh');
    dirty.clear();
    const entry = UndoStack._entries.at(-1);
    assert.notEqual(await entry.undoFn(), false);
    const t = Store.tasks.wu1;
    assert.equal(t.start_date.toISOString(), d0.toISOString(), 'schedule reverted locally');
    assert.equal(t.row_version, 6, 'live row_version kept so the revert save is not a conflict');
    assert.ok(dirty.has('wu1'), 'reverted task must be dirty so the next save pushes the revert');
  } finally { off(); }
});
