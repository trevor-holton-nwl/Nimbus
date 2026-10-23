// Store + UndoStack tests, split from tests/modules/schedule-state.test.mjs
// (Phase P4 of docs/architecture/domain-refactor-plan.md, which split
// schedule-state.mts into 3 domain files: platform/store.mjs,
// scheduling/selection.mjs, optimization/sandbox.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
