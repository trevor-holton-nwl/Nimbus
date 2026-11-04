// Store + UndoStack tests, split from tests/modules/schedule-state.test.mjs
// (Phase P4 of docs/architecture/domain-refactor-plan.md, which split
// schedule-state.mts into 3 domain files: platform/store.mjs,
// scheduling/selection.mjs, optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { ErrorLog, Toast } from '../../../frontend/platform/foundation.mjs';
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

test('UndoStack.push caps at MAX (50) entries, oldest evicted', () => {
  UndoStack._entries = [];
  assert.equal(UndoStack.MAX, 50);
  for (let i = 0; i < 12; i++) UndoStack.push(`entry-${i}`, () => {});
  assert.equal(UndoStack._entries.length, 12, 'the old cap of 10 is gone');
  for (let i = 12; i < 60; i++) UndoStack.push(`entry-${i}`, () => {});
  assert.equal(UndoStack._entries.length, 50);
  assert.equal(UndoStack._entries[0].label, 'entry-10');
  assert.equal(UndoStack._entries.at(-1).label, 'entry-59');
  UndoStack._entries = [];
});

test('UndoStack row budget: cost defaults to ids.length (or 1), oldest evicted, newest always kept', () => {
  UndoStack._entries = [];
  const B = UndoStack.MAX_ROWS;
  assert.equal(B, 20000);
  UndoStack.push('noids', () => {});
  assert.equal(UndoStack._entries[0].cost, 1);
  UndoStack.push('three', () => {}, ['a', 'b', 'c']);
  assert.equal(UndoStack._entries[1].cost, 3);
  UndoStack.push('explicit', () => {}, ['a'], { cost: 7 });
  assert.equal(UndoStack._entries[2].cost, 7);
  assert.equal(UndoStack.rowCount(UndoStack._entries), 11);
  UndoStack._entries = [];
  UndoStack.push('old1', () => {}, ['a'], { cost: 9000 });
  UndoStack.push('old2', () => {}, ['a'], { cost: 9000 });
  UndoStack.push('big', () => {}, ['a'], { cost: 5000 });   // 23000 > 20000: oldest goes
  assert.deepEqual(UndoStack._entries.map(e => e.label), ['old2', 'big']);
  UndoStack.push('huge', () => {}, ['a'], { cost: B + 5 });  // alone over budget: everything older goes, newest stays
  assert.deepEqual(UndoStack._entries.map(e => e.label), ['huge']);
  UndoStack._entries = [];
});

test('tasks:bulk clears the undo stack (plant switch / reload / What-If discard)', () => {
  UndoStack._entries = [];
  UndoStack.push('a', () => {}, ['x']);
  Store.setTasks([{ id: 'bulk1' }], 'persistence');
  assert.equal(UndoStack._entries.length, 0);
  UndoStack.push('b', () => {}, ['x']);
  Store.updateTask('bulk1', { RUN_TIME: '3' }, 'unit-test');   // task:update is not a bulk load
  assert.equal(UndoStack._entries.length, 1);
  UndoStack._entries = [];
});

test('restoreTasks drops ids no longer in the Store: no event, no phantom ids', () => {
  Store.setTasks([{ id: 'live1', RUN_TIME: '2' }], 'unit-test');
  const gone = { id: 'gone1', RUN_TIME: '5' };
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'tasks:bulkUpdate') events.push(evt); });
  UndoStack.restoreTasks([gone]);
  assert.equal(events.length, 0, 'nothing left to restore: no emit');
  UndoStack.restoreTasks([gone, { id: 'live1', RUN_TIME: '9' }]);
  off();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].ids.map(String), ['live1']);
  assert.equal(Store.tasks['gone1'], undefined);
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

// ---- Task 6: firm is server state (task.firmed is the single source) -------
test('Store.replaceFirmedIds emits only ids whose membership changed and clears t.firmed on removed ids', () => {
  Store.setTasks([{ id: 'ra', firmed: true }, { id: 'rb', firmed: true }, { id: 'rc' }], 'unit-test');
  assert.deepEqual([...Store.firmedIds].sort(), ['ra', 'rb']);
  const changes = [];
  const off = Store.subscribe(evt => { if (evt.type === 'firmed:change') changes.push(evt); });
  Store.replaceFirmedIds(new Set(['rb', 'rc']), 'unit-test');   // ra removed, rc added, rb unchanged
  off();
  assert.equal(changes.length, 1);
  assert.deepEqual([...changes[0].ids].sort(), ['ra', 'rc'], 'unchanged rb must not be reported');
  assert.equal(Store.tasks.ra.firmed, false, 'removed id loses its firmed mirror');
  assert.equal(Store.tasks.rc.firmed, true);
  assert.equal(Store.tasks.rb.firmed, true);
  assert.deepEqual([...Store.firmedIds].sort(), ['rb', 'rc']);
});

test('Store.replaceFirmedIds with an identical set reports no changed ids', () => {
  Store.setTasks([{ id: 'same', firmed: true }], 'unit-test');
  const changes = [];
  const off = Store.subscribe(evt => { if (evt.type === 'firmed:change') changes.push(evt); });
  Store.replaceFirmedIds(new Set(['same']), 'sandbox');
  off();
  assert.deepEqual(changes.map(e => e.ids), [[]]);
});

test('Store.setTasks rebuilds firmedIds from server task.firmed so a stale local id disappears', () => {
  Store.setTasks([{ id: 'srv1', firmed: true }, { id: 'srv2' }], 'unit-test');
  Store.firmedIds.add('stale-local');            // e.g. a browser-only firm from an old cache
  Store.setTasks([{ id: 'srv1', firmed: true }, { id: 'srv2', firmed: false }, { id: 'srv3', firmed: true }], 'persistence');
  assert.deepEqual([...Store.firmedIds].sort(), ['srv1', 'srv3']);
  assert.ok(!Store.isFirmed('stale-local'));
});

test('G1: undo (restoreTasks) never changes a manual firm; firm moves only via setFirmed/replaceFirmedIds', () => {
  Store.setTasks([{ id: 'uf1', RUN_TIME: 1, firmed: false }], 'unit-test');
  const snap = UndoStack.snapshotTasks(['uf1']);        // drag-undo snapshot taken while unfirmed
  Store.setFirmed(['uf1'], true, 'table');              // planner firms afterwards
  UndoStack.restoreTasks(snap);                         // Ctrl+Z of the earlier drag
  assert.equal(Store.tasks.uf1.firmed, true, 'undo must not silently unfirm');
  assert.ok(Store.firmedIds.has('uf1'));
  // The reverse: a snapshot taken while firmed must not re-firm an order unfirmed since.
  Store.setTasks([{ id: 'uf2', RUN_TIME: 1, firmed: true }], 'unit-test');
  const snap2 = UndoStack.snapshotTasks(['uf2']);
  Store.setFirmed(['uf2'], false, 'table');
  UndoStack.restoreTasks(snap2);
  assert.equal(Store.tasks.uf2.firmed, false);
  assert.ok(!Store.firmedIds.has('uf2'));
});

test('VI8: a time-machine write never marks a row as placed', () => {
  Store.setTasks([{ id: 'vi8', MACHINE: 'L1', user_scheduled: false }], 'unit-test');
  Store.updateMany([{ id: 'vi8', changes: { start_date: new Date('2026-09-01T06:00:00'), end_date: new Date('2026-09-01T10:00:00') } }], 'time-machine');
  assert.equal(Store.tasks.vi8.user_scheduled, false);
  Store.setTasks([], 'unit-test');
});

// ---- Effective-dated plant calendar periods ----------------------------------------------------------------------
globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const _per = (id, validFrom, validTo, workHours = {}) => ({ id, name: id, validFrom, validTo, workHours });

test('Store.getPlantPeriods defaults to []', () => {
  Store.replacePlants({ PP1: { workHours: {} } }, 'unit-test');
  assert.deepEqual(Store.getPlantPeriods('PP1'), []);
  assert.deepEqual(Store.getPlantPeriods('NOPE'), []);
});

test('Store.setPlantPeriods sorts by validFrom, deletes the key when empty and emits calendar:change with the source', () => {
  Store.replacePlants({ PP1: { workHours: {} } }, 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => events.push(evt));
  const input = [_per('b', '2027-01-01', null), _per('a', '2026-10-01', '2026-12-31')];
  Store.setPlantPeriods('PP1', input, 'plant-periods');
  assert.deepEqual(Store.getPlantPeriods('PP1').map(p => p.id), ['a', 'b']);
  assert.deepEqual(input.map(p => p.id), ['b', 'a'], "the caller's array is not mutated");
  const ev = events.find(e => e.type === 'calendar:change');
  assert.equal(ev.source, 'plant-periods');
  assert.equal(ev.plant, 'PP1');
  Store.setPlantPeriods('PP1', [], 'plant-periods');
  off();
  assert.equal('periods' in Store.plants.PP1, false);
  assert.deepEqual(Store.getPlantPeriods('PP1'), []);
});

test('Store.setPlantPeriods seeds a default plant entry when the plant is unknown', () => {
  Store.replacePlants({}, 'unit-test');
  Store.setPlantPeriods('NEWP', [_per('a', '2026-10-01', null)], 'plant-periods');
  assert.ok(Store.plants.NEWP.workHours);
  assert.equal(Store.getPlantPeriods('NEWP').length, 1);
});

test('Store has no clamp: plant hours are never copied into machine calendars (2026-10-19)', () => {
  assert.equal(Store.clampLinesToPlant, undefined);
});

test('Store.ensureCalendar seeds an inherited line: all-day once its plant resolves, the default shift before', () => {
  const priorCalendars = Store.calendars;
  const priorMasterData = structuredClone(Store.masterData);
  try {
    Store.replaceCalendars({}, 'unit-test');
    Store.setMasterData({ plants: [{ plant: 'PI' }], lines: [{ machine: 'KNOWN', plant: 'PI' }] }, 'unit-test');
    Store.ensureCalendar('KNOWN');
    Store.ensureCalendar('ORPHAN');
    assert.equal(Store.calendars.KNOWN.inherited, true);
    assert.deepEqual(Store.calendars.KNOWN.workHours[1], [0, 24]);
    assert.equal(Store.calendars.ORPHAN.inherited, true);
    assert.deepEqual(Store.calendars.ORPHAN.workHours[1], [7, 19]);
    // The plant resolves later: rebuildPlantIndex switches the seed to all-day.
    Store.setMasterData({ plants: [{ plant: 'PI' }], lines: [{ machine: 'KNOWN', plant: 'PI' }, { machine: 'ORPHAN', plant: 'PI' }] }, 'unit-test');
    Store.rebuildPlantIndex();
    assert.deepEqual(Store.calendars.ORPHAN.workHours[1], [0, 24]);
  } finally {
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
  }
});

test('Store.setCalendar makes a line an override; inheritPlantHours and effectiveLineHours read the plant', () => {
  const priorCalendars = Store.calendars;
  const priorMasterData = structuredClone(Store.masterData);
  try {
    Store.replaceCalendars({}, 'unit-test');
    Store.setMasterData({ plants: [{ plant: 'PI' }], lines: [{ machine: 'LI', plant: 'PI' }] }, 'unit-test');
    Store.replacePlants({ PI: { workHours: { 1: [8, 16], 6: null } } }, 'unit-test');
    Store.ensureCalendar('LI');
    assert.deepEqual(Store.effectiveLineHours('LI')[1], [8, 16], 'an inherited line shows the plant week');
    Store.setCalendar('LI', { 1: [6, 18] }, 'unit-test');
    assert.equal(Store.calendars.LI.inherited, false);
    assert.deepEqual(Store.effectiveLineHours('LI'), { 1: [6, 18] });
    let emitted = 0;
    const off = Store.subscribe(evt => { if (evt.type === 'calendar:change') emitted += 1; });
    Store.inheritPlantHours('LI');
    assert.equal(emitted, 0, 'no emit without a source');
    Store.inheritPlantHours('LI', 'unit-test');
    off();
    assert.equal(emitted, 1);
    assert.equal(Store.calendars.LI.inherited, true);
    assert.deepEqual(Store.calendars.LI.workHours[1], [0, 24]);
    assert.deepEqual(Store.effectiveLineHours('LI')[1], [8, 16]);
  } finally {
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.replacePlants({}, 'unit-test');
  }
});

test('Store.updatePlantBlock replaces the block in place, keeps id/plant, and emits plantBlocks:change', () => {
  const prior = Store.plantBlocks.slice();
  const mk = () => [
    { id: 'pb1', plant: 'P1', start: '2026-12-24T00:00:00', end: '2026-12-26T00:00:00', reason: 'Holiday' },
    { id: 'pb2', plant: 'P1', start: '2026-12-30T00:00:00', end: '2026-12-31T00:00:00', reason: 'Audit' },
    { id: 'pb3', plant: 'P2', start: '2026-12-24T00:00:00', end: '2026-12-26T00:00:00', reason: 'Holiday' },
  ];
  Store.replacePlantBlocks(mk(), 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'plantBlocks:change') events.push(evt); });
  try {
    const before = Store.plantBlocks[0];
    const ok = Store.updatePlantBlock('pb1', 'P1', { start: '2026-12-24T08:15:00', end: '2026-12-27T00:00:00', reason: 'Shutdown' }, 'unit-test');
    assert.equal(ok, true);
    assert.equal(events.length, 1);
    const after = Store.plantBlocks[0];
    assert.notStrictEqual(after, before, 'a new object, not an in-place mutation');
    assert.equal(before.reason, 'Holiday');
    assert.equal(after.id, 'pb1');
    assert.equal(after.plant, 'P1');
    assert.equal(after.reason, 'Shutdown');
    assert.equal(after.start, '2026-12-24T08:15:00');
    assert.equal(Store.plantBlocks.length, 3);
  } finally {
    off();
    Store.replacePlantBlocks(prior, 'unit-test');
  }
});

test('Store.updatePlantBlock returns false for a missing block or a wrong plant, without emitting', () => {
  const prior = Store.plantBlocks.slice();
  Store.replacePlantBlocks([{ id: 'pb1', plant: 'P1', start: '2026-12-24T00:00:00', end: '2026-12-26T00:00:00', reason: 'Holiday' }], 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'plantBlocks:change') events.push(evt); });
  try {
    const patch = { start: '2026-12-24T00:00:00', end: '2026-12-27T00:00:00', reason: 'X' };
    assert.equal(Store.updatePlantBlock('nope', 'P1', patch, 'unit-test'), false);
    assert.equal(Store.updatePlantBlock('pb1', 'P2', patch, 'unit-test'), false);
    assert.equal(events.length, 0);
    assert.equal(Store.plantBlocks[0].reason, 'Holiday');
  } finally {
    off();
    Store.replacePlantBlocks(prior, 'unit-test');
  }
});

test('Store.updatePlantBlock refuses an edit that duplicates another block of the same plant', () => {
  const prior = Store.plantBlocks.slice();
  Store.replacePlantBlocks([
    { id: 'pb1', plant: 'P1', start: '2026-12-24T00:00:00', end: '2026-12-26T00:00:00', reason: 'Holiday' },
    { id: 'pb2', plant: 'P1', start: '2026-12-30T00:00:00', end: '2026-12-31T00:00:00', reason: 'Audit' },
  ], 'unit-test');
  try {
    assert.equal(Store.updatePlantBlock('pb2', 'P1',
      { start: '2026-12-24T00:00:00', end: '2026-12-26T00:00:00', reason: 'Holiday' }, 'unit-test'), false);
    assert.equal(Store.plantBlocks[1].reason, 'Audit');
    // Saving a block over itself (unchanged values) is not a duplicate.
    assert.equal(Store.updatePlantBlock('pb2', 'P1',
      { start: '2026-12-30T00:00:00', end: '2026-12-31T00:00:00', reason: 'Audit' }, 'unit-test'), true);
  } finally {
    Store.replacePlantBlocks(prior, 'unit-test');
  }
});

test('Store.setMasterData forwards an optional table on master-data-changed and omits it otherwise', () => {
  const priorMasterData = structuredClone(Store.masterData);
  const seen = [];
  const off = Store.subscribe(evt => { if (evt.type === 'master-data-changed') seen.push(evt); });
  try {
    Store.setMasterData({ plants: [], lines: [] }, 'unit-test', 'plants');
    Store.setMasterData({ plants: [], lines: [] }, 'unit-test');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].table, 'plants');
    assert.equal(seen[0].source, 'unit-test');
    assert.equal('table' in seen[1], false, 'boot/Refresh callers pass no table');
  } finally {
    off();
    Store.setMasterData(priorMasterData, 'unit-test');
  }
});

test('Store.dataRev() bumps before listeners run and is not bumped by events that cannot change utilization', () => {
  const seenInside = [];
  const off = Store.subscribe(evt => { seenInside.push([evt.type, Store.dataRev()]); });
  try {
    const before = Store.dataRev();
    Store.emit({ type: 'calendar:change' });
    assert.equal(Store.dataRev(), before + 1);
    assert.deepEqual(seenInside.at(-1), ['calendar:change', before + 1], 'a subscriber sees the new value inside the same emit');
    const rev = Store.rev();
    for (const type of ['alerts:change', 'lines:selected', 'distribution:summary', 'undo:pushed', 'settings:change']) {
      Store.emit({ type });
      assert.equal(Store.dataRev(), before + 1, `${type} leaves dataRev alone`);
      assert.equal(Store.rev(), rev + (['alerts:change', 'lines:selected', 'distribution:summary', 'undo:pushed', 'settings:change'].indexOf(type) + 1), `${type} still bumps rev()`);
    }
    Store.emit({ type: 'a-new-event-nobody-listed' });
    assert.equal(Store.dataRev(), before + 2, 'an unlisted event bumps dataRev (exclusion list)');
  } finally { off(); }
});

test('a throwing subscriber logs one store entry with its label and later subscribers still run', () => {
  const before = ErrorLog.entries().length;
  let ran = false;
  const bad = () => { throw new Error('boom'); };
  const offBad = Store.subscribe(bad, 'unit-bad-listener');
  const offGood = Store.subscribe(() => { ran = true; }, 'unit-good-listener');
  try {
    Store.setTasks([], 'unit-test');
  } finally { offBad(); offGood(); }
  assert.equal(ran, true);
  const added = ErrorLog.entries().slice(before).filter(e => e.scope === 'store' && /listener error/.test(e.msg));
  assert.equal(added.length, 1);
  assert.equal(added[0].level, 'error');
  assert.equal(added[0].msg, 'listener error: boom');
  assert.equal(added[0].ctx.listener, 'unit-bad-listener');
  assert.equal(added[0].ctx.event, 'tasks:bulk');
  assert.equal(added[0].ctx.source, 'unit-test');
  assert.equal(added[0].errorCode, 'store.listener');
});

test('platform state provider snapshot rides on error entries', () => {
  ErrorLog.error('unit', 'probe');
  const e = ErrorLog.entries().at(-1);
  const p = e.ctx?.state?.platform;
  assert.ok(p, 'platform state attached');
  assert.equal(p.mode, 'live');
  assert.equal(p.rev, Store.rev());
  assert.equal(typeof p.selectedLines, 'number');
  assert.equal(typeof p.lastEvent.type, 'string');
});

test('tasks:saved is excluded from dataRev(): a save must not evict the utilization cache', () => {
  const before = Store.dataRev();
  const rev = Store.rev();
  Store.emit({ type: 'tasks:saved', ids: ['x'], source: 'persistence' });
  assert.equal(Store.dataRev(), before, 'dataRev unchanged');
  assert.equal(Store.rev(), rev + 1, 'rev() still bumps');
});

test('Store.activeLineHoursOn: inherited line, period vs default, override intersection, no plant', () => {
  const priorCalendars = Store.calendars;
  const priorMasterData = structuredClone(Store.masterData);
  const week = (r) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, r ? [...r] : null]));
  try {
    Store.replaceCalendars({}, 'unit-test');
    Store.setMasterData({ plants: [{ plant: 'PA' }], lines: [{ machine: 'LA', plant: 'PA' }, { machine: 'LB', plant: 'PA' }] }, 'unit-test');
    Store.replacePlants({ PA: { workHours: week([7, 19]) } }, 'unit-test');
    Store.ensureCalendar('LA');
    const mon = new Date(2026, 9, 26, 12);                       // inside the period below
    const before = new Date(2026, 9, 1, 12);
    let r = Store.activeLineHoursOn('LA', mon);
    assert.equal(r.source, 'default');
    assert.equal(r.period, null);
    assert.deepEqual(r.workHours[1], [7, 19]);

    Store.setPlantPeriods('PA', [{ id: 'p1', name: '24x4', validFrom: '2026-10-20', validTo: null, workHours: week([0, 24]) }], 'unit-test');
    r = Store.activeLineHoursOn('LA', mon);
    assert.equal(r.source, 'period');
    assert.equal(r.period.name, '24x4');
    assert.deepEqual(r.workHours[1], [0, 24], 'an inherited line shows the period pattern, not the default week');
    assert.equal(Store.activeLineHoursOn('LA', before).source, 'default', 'before the period starts the default week applies');
    assert.deepEqual(Store.effectiveLineHours('LA')[1], [7, 19], 'the editor view is unchanged');

    Store.setCalendar('LB', week([6, 20]), 'unit-test');
    r = Store.activeLineHoursOn('LB', mon);
    assert.equal(r.source, 'period');
    assert.deepEqual(r.workHours[1], [6, 20], 'override inside the period keeps its own hours');
    Store.setCalendar('LB', week([8, 17]), 'unit-test');
    Store.replacePlants({ PA: { workHours: week([9, 15]) } }, 'unit-test');
    assert.deepEqual(Store.activeLineHoursOn('LB', mon).workHours[1], [9, 15], 'override is capped by the plant default week');
    Store.setPlantPeriods('PA', [{ id: 'p2', name: 'Closed', validFrom: '2026-10-20', validTo: null, workHours: week(null) }], 'unit-test');
    assert.equal(Store.activeLineHoursOn('LB', mon).workHours[1], null, 'a closed period closes the override too');

    const none = Store.activeLineHoursOn('NOPLANT', mon);
    assert.equal(none.source, 'none');
    assert.equal(none.period, null);
    assert.ok(none.workHours[1], 'no plant: the default shift week');
  } finally {
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.replacePlants({}, 'unit-test');
  }
});

test('Store.setAlerts changedIds marks a task whose alert-type set changed, not only one gaining or losing all alerts', () => {
  const priorAlerts = Store.alerts;
  const mk = (id, type, taskId) => ({ id, type, taskId, sev: 'warn', line: 'L', msg: 'x', time: new Date() });
  const seen = [];
  const off = Store.subscribe(evt => { if (evt.type === 'alerts:change') seen.push(evt.changedIds); });
  try {
    Store.setAlerts([mk('a1', 'late', 't1'), mk('a2', 'late', 't2')], 'unit-test');
    seen.length = 0;
    Store.setAlerts([mk('a1', 'late', 't1'), mk('n1', 'queued_now_fits', 't1'), mk('a2', 'late', 't2')], 'unit-test');
    assert.deepEqual(seen.at(-1), ['t1'], 'a task that already had an alert and gained another type is marked');
    Store.setAlerts([mk('a1', 'late', 't1'), mk('n1', 'queued_now_fits', 't1'), mk('a2', 'late', 't2')], 'unit-test');
    assert.deepEqual(seen.at(-1), [], 'an identical set marks nothing (empty array, not unscoped)');
    Store.setAlerts([mk('a1', 'late', 't1'), mk('a2', 'late', 't2'), mk('a3', 'late', 't3')], 'unit-test');
    assert.deepEqual([...seen.at(-1)].sort(), ['t1', 't3'], 'a lost type and a brand-new task are both marked');
  } finally { off(); Store.setAlerts(priorAlerts, 'unit-test'); }
});

// ---------------------------------------------------------------------------------------------------------------
// Redo (Stage 3): rows-only, opt-in; captured pre-undo rows are restored exactly.
// ---------------------------------------------------------------------------------------------------------------
function redoFx(n = 3) {
  globalThis.window ??= {};   // Util.t reads window.__NIMBUS_LOCALES (popRedo toasts outside the try/catch pop has)
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ id: `rd${i}`, RUN_TIME: '2', row_version: 5, start_date: new Date('2026-01-01T08:00:00Z'), end_date: new Date('2026-01-01T10:00:00Z') });
  Store.setTasks(rows, 'unit-test');
  UndoStack._entries = []; UndoStack._redo = [];
  const ids = rows.map(r => r.id);
  // The edit + its entry, built like the Gantt/grid/Apply call sites do.
  const edit = (label, patch, opts = { redo: true }, only = ids) => {
    const snap = UndoStack.snapshotTasks(only);
    Store.updateMany(only.map(id => ({ id, changes: patch })), 'interaction');
    UndoStack.push(label, () => UndoStack.restoreTasks(snap), only, opts ?? undefined);
  };
  return { ids, edit };
}

test('Redo restores the exact pre-undo rows; undo, redo, undo cycles', () => {
  const { edit } = redoFx();
  edit('E1', { RUN_TIME: '9' });
  assert.equal(UndoStack.pop()?.label, 'E1');
  assert.equal(Store.tasks.rd1.RUN_TIME, '2');
  assert.equal(UndoStack._redo.length, 1);
  assert.equal(UndoStack._entries.length, 0);
  assert.equal(UndoStack.popRedo()?.label, 'E1');
  assert.equal(Store.tasks.rd1.RUN_TIME, '9');
  assert.equal(Store.tasks.rd3.RUN_TIME, '9');
  assert.equal(UndoStack._redo.length, 0);
  assert.equal(UndoStack._entries.length, 1, 'the original entry is back on the undo stack');
  UndoStack.pop();
  assert.equal(Store.tasks.rd1.RUN_TIME, '2', 'a further undo returns to the pre-edit values');
  assert.equal(UndoStack._redo.length, 1);
});

test('Redo keeps the LIVE row_version and the exact captured values (no re-derivation)', () => {
  const { edit } = redoFx(1);
  edit('E1', { RUN_TIME: '9', start_date: new Date('2026-01-02T08:00:00Z') });
  UndoStack.pop();
  Store.tasks.rd1.row_version = 8;   // a pulled-in version while undone
  UndoStack.popRedo();
  assert.equal(Store.tasks.rd1.row_version, 8);
  assert.equal(Store.tasks.rd1.start_date.toISOString(), '2026-01-02T08:00:00.000Z', 'the captured start is written as-is');
});

test('{exact:true} sets no runtime_schedule_mismatch, runs no afterRestore, still runs afterSettle and strips firmed', () => {
  const { ids } = redoFx(1);
  const calls = [];
  const prior = [UndoStack.afterRestore, UndoStack.afterSettle, UndoStack.willRederive];
  UndoStack.afterRestore = () => calls.push('restore'); UndoStack.afterSettle = () => calls.push('settle'); UndoStack.willRederive = () => true;
  try {
    const snap = UndoStack.snapshotTasks(ids).map(s => ({ ...s, RUN_TIME: '7', firmed: true }));
    UndoStack.restoreTasks(snap, { exact: true });
    assert.deepEqual(calls, ['settle']);
    assert.equal(Store.tasks.rd1.RUN_TIME, '7');
    assert.notEqual(Store.tasks.rd1.runtime_schedule_mismatch, true);
    assert.equal(Store.tasks.rd1.firmed, false, 'firmed is never restored');
    calls.length = 0;
    UndoStack.restoreTasks(snap);   // the default (undo) mode still flags and re-derives
    assert.deepEqual(calls, ['restore', 'settle']);
    assert.equal(Store.tasks.rd1.runtime_schedule_mismatch, true);
  } finally { [UndoStack.afterRestore, UndoStack.afterSettle, UndoStack.willRederive] = prior; }
});

test('a new push clears the redo stack', () => {
  const { edit } = redoFx();
  edit('E1', { RUN_TIME: '9' });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1);
  UndoStack.push('other', () => {});
  assert.equal(UndoStack._redo.length, 0);
});

test('only entries pushed with {redo:true} become redoable', () => {
  const { edit } = redoFx();
  edit('plain', { RUN_TIME: '9' }, null);
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 0);
  assert.equal(UndoStack.popRedo(), null);
});

test('invalidate prunes redo entries too', () => {
  const { edit } = redoFx(3);
  edit('E1', { RUN_TIME: '9' }, { redo: true }, ['rd1']);
  edit('E2', { RUN_TIME: '9' }, { redo: true }, ['rd2']);
  UndoStack.pop(); UndoStack.pop();
  assert.equal(UndoStack._redo.length, 2);
  UndoStack.invalidate(['rd1']);
  assert.deepEqual(UndoStack._redo.map(e => e.label), ['E2']);
});

test('tasks:bulk clears the redo stack', () => {
  const { edit } = redoFx();
  edit('E1', { RUN_TIME: '9' });
  UndoStack.pop();
  Store.setTasks([{ id: 'other' }], 'persistence');
  assert.equal(UndoStack._redo.length, 0);
});

test('popping a non-redoable entry clears redo only when it succeeds; an aborted (false) one does not', () => {
  const { edit } = redoFx();
  edit('E2', { RUN_TIME: '8' });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1);
  UndoStack._entries.push({ label: 'nr-abort', undoFn: () => false, at: 0, ids: [] });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1, 'aborted: redo kept');
  assert.equal(UndoStack._entries.length, 1, 'aborted: entry kept');
  UndoStack._entries.length = 0;
  UndoStack._entries.push({ label: 'nr-ok', undoFn: () => {}, at: 0, ids: [] });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 0, 'a successful non-redoable undo clears redo');
});

test('silent re-push on Redo emits no undo:pushed; a normal push does', () => {
  const { edit } = redoFx();
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'undo:pushed') events.push(evt.label); });
  try {
    edit('E1', { RUN_TIME: '9' });
    assert.deepEqual(events, ['E1']);
    UndoStack.pop();
    UndoStack.popRedo();
    assert.deepEqual(events, ['E1'], 'Redo re-pushed the entry silently');
    assert.equal(UndoStack._entries.length, 1);
  } finally { off(); }
});

test('the row budget is shared by the undo and redo stacks: older redo entries first, then oldest undo; the protected entry stays', () => {
  const { edit } = redoFx(1);
  const B = UndoStack.MAX_ROWS;
  UndoStack._entries = []; UndoStack._redo = [];
  UndoStack.push('old', () => {}, ['rd1'], { cost: B - 10 });
  edit('redoable', { RUN_TIME: '9' }, { redo: true });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1);
  assert.ok(UndoStack.rowCount(UndoStack._entries, UndoStack._redo) <= B);
  // A big redo entry arrives: the older undo entry goes, the redo entry stays.
  const huge = { label: 'huge', at: Date.now(), cost: B - 5, ids: ['rd1'], redoSnap: [], undoFn: () => {} };
  UndoStack._redo.push(huge);
  UndoStack._trimShared(huge);
  assert.ok(UndoStack._redo.some(e => e.label === 'huge'), 'the protected redo entry always stays');
  assert.ok(!UndoStack._redo.some(e => e.label === 'redoable'), 'the older redo entry went first');
  assert.equal(UndoStack._entries.length, 0, 'then the oldest undo entry');
  assert.ok(UndoStack.rowCount(UndoStack._entries, UndoStack._redo) <= B);
});

test('a redo entry is pruned / invalidated by ids of the ORIGINAL entry too, not only the rows its undo captured', () => {
  const { edit } = redoFx(2);
  const snap = UndoStack.snapshotTasks(['rd1', 'rd2']);
  Store.updateMany([{ id: 'rd1', changes: { RUN_TIME: '9' } }, { id: 'rd2', changes: { RUN_TIME: '9' } }], 'interaction');
  // like the optimizer's family-sibling filter: the entry is tagged with both ids but its undo restores only rd1
  UndoStack.push('opt', () => UndoStack.restoreTasks(snap.filter(s => s.id === 'rd1')), ['rd1', 'rd2'], { redo: true });
  UndoStack.pop();
  assert.deepEqual(UndoStack._redo[0].redoSnap.map(t => t.id), ['rd1'], 'redoSnap stays what the undo captured');
  assert.deepEqual([...UndoStack._redo[0].ids].sort(), ['rd1', 'rd2'], 'ids cover the original entry');
  UndoStack.invalidate(['rd2']);
  assert.equal(UndoStack._redo.length, 0, 'invalidate by the skipped sibling prunes the redo entry');
  edit('E', { RUN_TIME: '5' }, { redo: true });   // fresh state for the prune path
  UndoStack._entries = []; UndoStack._redo = [];
  const snap2 = UndoStack.snapshotTasks(['rd1', 'rd2']);
  UndoStack.push('opt2', () => UndoStack.restoreTasks(snap2.filter(s => s.id === 'rd1')), ['rd1', 'rd2'], { redo: true });
  UndoStack.pop();
  Store.updateTask('rd2', { PRT_01: 'p' }, 'table');
  assert.equal(UndoStack._redo.length, 0, 'a foreign write to the skipped sibling prunes it');
});

test('a calendar change after the undo clears the redo stack (the captured placements may sit on closed time now); an undo-sourced one does not', () => {
  const { edit } = redoFx(2);
  edit('E1', { RUN_TIME: '9' });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1);
  Store.emit({ type: 'calendar:change', line: 'L', source: 'undo' });
  assert.equal(UndoStack._redo.length, 1, 'the undo own write does not count');
  Store.emit({ type: 'calendar:change', line: 'L', source: 'calendar-sync' });
  assert.equal(UndoStack._redo.length, 0);
});

test('a plant-wide Apply undo costs its captured rows once in the redo stack: it does not evict other undo history', () => {
  const { edit } = redoFx(8000);
  UndoStack._entries = []; UndoStack._redo = [];
  UndoStack.push('filler A', () => {}, ['x'], { cost: 5000 });
  UndoStack.push('filler B', () => {}, ['y'], { cost: 5000 });
  edit('big apply', { RUN_TIME: '9' });
  UndoStack.pop();
  assert.equal(UndoStack._redo.length, 1);
  assert.equal(UndoStack._redo[0].cost, 8000, 'the redo entry costs its captured rows (the original is counted when re-pushed)');
  assert.deepEqual(UndoStack._entries.map(e => e.label), ['filler A', 'filler B'], 'the other undo history survives');
});

test('popRedo never evicts the entry it just re-pushed: Ctrl+Z right after Redo still undoes it', () => {
  const { edit } = redoFx(3);
  const prior = UndoStack.MAX_ROWS;
  try {
    edit('E1', { RUN_TIME: '4' }, { redo: true }, ['rd1']);
    edit('E2', { RUN_TIME: '5' }, { redo: true }, ['rd2']);
    edit('E3', { RUN_TIME: '6' }, { redo: true }, ['rd3']);
    UndoStack.pop(); UndoStack.pop(); UndoStack.pop();
    assert.deepEqual(UndoStack._redo.map(e => e.label), ['E3', 'E2', 'E1']);
    UndoStack.MAX_ROWS = 2;   // over budget once the re-pushed original is counted next to the two redo entries left
    assert.equal(UndoStack.popRedo()?.label, 'E1');
    assert.deepEqual(UndoStack._entries.map(e => e.label), ['E1'], 'the re-pushed entry is protected');
    assert.deepEqual(UndoStack._redo.map(e => e.label), ['E2'], 'the OLDEST redo entry went first');
    UndoStack.pop();
    assert.equal(Store.tasks.rd1.RUN_TIME, '2', 'Ctrl+Z right after Redo undoes it');
  } finally { UndoStack.MAX_ROWS = prior; }
});

test('a non-undo write to a redo entry id prunes it; undo / reconcile / unrelated writes do not', () => {
  const { edit } = redoFx(3);
  edit('E1', { RUN_TIME: '9' }, { redo: true }, ['rd1']);
  edit('E2', { RUN_TIME: '9' }, { redo: true }, ['rd2']);
  UndoStack.pop(); UndoStack.pop();
  assert.equal(UndoStack._redo.length, 2);
  Store.updateTask('rd1', { notes: 'x' }, 'undo');
  Store.updateMany([{ id: 'rd1', changes: { notes: 'y' } }], 'engine-runtime-reconcile');
  Store.updateMany([{ id: 'rd2', changes: { notes: 'y' } }], 'engine-runtime-reconcile-display');
  Store.updateTask('rd3', { notes: 'z' }, 'table');
  assert.equal(UndoStack._redo.length, 2, 'none of those touch a redo entry from a foreign writer');
  Store.updateTask('rd1', { PRT: 'p' }, 'table');
  assert.deepEqual(UndoStack._redo.map(e => e.label), ['E2'], 'task:update prunes');
  Store.updateMany([{ id: 'rd2', changes: { notes: 'q' } }], 'refresh');
  assert.equal(UndoStack._redo.length, 0, 'tasks:bulkUpdate prunes');
});

test('a firm after the undo prunes the redo entry (firmed:change from any source but undo); an undo-sourced firm does not', () => {
  const { edit } = redoFx(2);
  edit('E1', { RUN_TIME: '9' }, { redo: true }, ['rd1']);
  edit('E2', { RUN_TIME: '9' }, { redo: true }, ['rd2']);
  UndoStack.pop(); UndoStack.pop();
  assert.equal(UndoStack._redo.length, 2);
  Store.setFirmed('rd1', true, 'undo');
  assert.equal(UndoStack._redo.length, 2, 'a firm written by an undo does not prune');
  Store.setFirmed('rd2', true, 'interaction');
  assert.deepEqual(UndoStack._redo.map(e => e.label), ['E1'], 'Firm A after the undo prunes the redo entry of A');
  Store.setFirmed(['rd1', 'rd2'], false, 'unit-test');
});

test('Redo skips rows the engine hook calls locked (frozen / running / firmed): not moved, warn toast, entry dropped', () => {
  const { edit } = redoFx(2);
  const toasts = [];
  const priorShow = Toast.show, priorHook = UndoStack.redoBlocked;
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  try {
    edit('E1', { RUN_TIME: '9' });
    UndoStack.pop();
    // rd1 becomes locked after the undo (time passed / a firm that raised no task event): rd2 stays movable.
    UndoStack.redoBlocked = t => t.id === 'rd1';
    const r = UndoStack.popRedo();
    assert.equal(r?.label, 'E1');
    assert.equal(Store.tasks.rd1.RUN_TIME, '2', 'the locked row is not moved');
    assert.equal(Store.tasks.rd2.RUN_TIME, '9', 'the other row is redone');
    assert.ok(toasts.some(([m, t]) => /redo_locked_skipped/.test(m) && t === 'warn'), 'a warn toast names the skip');
    assert.equal(UndoStack._redo.length, 0, 'the entry is dropped');
    // Every row locked: a no-op that moves nothing.
    UndoStack.pop();
    UndoStack.redoBlocked = () => true;
    const events = [];
    const off = Store.subscribe(evt => { if (evt.type === 'tasks:bulkUpdate') events.push(evt); });
    try { UndoStack.popRedo(); } finally { off(); }
    assert.equal(Store.tasks.rd2.RUN_TIME, '2');
    assert.equal(events.length, 0);
  } finally { Toast.show = priorShow; UndoStack.redoBlocked = priorHook; }
});

test('Redo of an entry whose rows were removed from the Store is a safe no-op', () => {
  const { edit } = redoFx(2);
  edit('E1', { RUN_TIME: '9' });
  UndoStack.pop();
  Store.removeTask('rd1', 'unit-test'); Store.removeTask('rd2', 'unit-test');
  const events = [];
  const off = Store.subscribe(evt => { if (evt.type === 'tasks:bulkUpdate') events.push(evt); });
  let r;
  try { r = UndoStack.popRedo(); } finally { off(); }
  assert.equal(r, null);
  assert.equal(events.length, 0);
  assert.equal(UndoStack._entries.length, 0, 'nothing restored, nothing re-pushed');
  assert.equal(UndoStack._redo.length, 0);
});

test('12 undos deep, Redo some, then a new action clears the rest', () => {
  const { edit } = redoFx(1);
  for (let i = 1; i <= 12; i++) edit(`E${i}`, { RUN_TIME: String(100 + i) });
  for (let i = 0; i < 12; i++) UndoStack.pop();
  assert.equal(Store.tasks.rd1.RUN_TIME, '2');
  assert.equal(UndoStack._redo.length, 12);
  for (let i = 1; i <= 5; i++) assert.equal(UndoStack.popRedo()?.label, `E${i}`);
  assert.equal(Store.tasks.rd1.RUN_TIME, '105');
  assert.equal(UndoStack._redo.length, 7);
  edit('new', { RUN_TIME: '55' });
  assert.equal(UndoStack._redo.length, 0);
});

test('Redo is blocked while an async undo is pending (_busy), and an async redoable undo still captures', async () => {
  const { ids } = redoFx(1);
  const snap = UndoStack.snapshotTasks(ids);
  Store.updateTask('rd1', { RUN_TIME: '9' }, 'unit-test');
  let release;
  UndoStack.push('async', () => { UndoStack.restoreTasks(snap); return new Promise(r => { release = r; }); }, ids, { redo: true });
  UndoStack.pop();
  assert.equal(UndoStack.popRedo(), null);
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(UndoStack._redo.length, 1);
  assert.equal(UndoStack.popRedo()?.label, 'async');
  assert.equal(Store.tasks.rd1.RUN_TIME, '9');
});
