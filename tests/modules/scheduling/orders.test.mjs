// Tests for frontend/scheduling/orders.mts (Table, Inspector, ContextMenu,
// Printer). Split from tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Table, Inspector, ContextMenu, Printer, historyRowView, groupHistoryEvents } from '../../../frontend/scheduling/orders.mjs';
import { makeDocument, makeEl } from '../helpers/dom-stub.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { ORDER_FIELD_CATALOG } from '../../../frontend/scheduling/order-field-catalog.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';

const require = createRequire(import.meta.url);
// Engine.isInProgress/isFrozenHorizon default to Store.plantNow, which projects through the compute core's
// shared zone helper (OQ52); a real page loads the core before any module, so the tests do the same.
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

// A placement edit holds the FINISH and derives the start from the plant's working time (backward scheduling
// Task 2.5), which needs a plant with a time zone and a pinned server clock (these fixtures are dated in 2026-08/09).
// The naive instant is read in this machine's zone, which is also the plant's zone below.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REAL_SERVER_OFFSET_MS = Store.serverOffsetMs;
afterEach(() => { Store.serverOffsetMs = REAL_SERVER_OFFSET_MS; Store._blockedPlants.clear(); });
function pinPlantClock(plants, nowNaive = '2026-08-01T00:00:00') {
  const priorMaster = Store.masterData;
  Store.setMasterData({
    ...priorMaster,
    plants: [...(priorMaster?.plants || []).filter(p => !plants.includes(p.plant)), ...plants.map(plant => ({ plant, timezone: LOCAL_TZ }))],
    lines: priorMaster?.lines || [],
  }, 'unit-test');
  Store.serverOffsetMs = new Date(nowNaive).getTime() - Date.now();
  Store._blockedPlants.clear();
  return () => { Store.setMasterData(priorMaster, 'unit-test'); };
}

test('note edits skip unchanged text and restamp the returned row version', async () => {
  const id = 'note-version-test';
  const priorTimeout = globalThis.setTimeout;
  const priorFetch = Util.fetchTraced;
  const events = [];
  const unsubscribe = Store.subscribe(event => { if (event.id === id) events.push(event); });
  Store.tasks[id] = { id, notes: 'old', row_version: 4, MACHINE: 'L1' };
  let fire;
  try {
    globalThis.setTimeout = callback => { fire = callback; return 1; };
    Util.fetchTraced = async () => ({ ok: true, json: async () => ({ versions: { [id]: 9 } }) });
    Inspector._updateNote(id, 'old');
    assert.equal(fire, undefined, 'unchanged blur does not POST');
    Inspector._updateNote(id, 'new');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'note');
    globalThis.setTimeout = priorTimeout;
    fire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Store.tasks[id].row_version, 9);
  } finally {
    globalThis.setTimeout = priorTimeout;
    Util.fetchTraced = priorFetch;
    delete Store.tasks[id];
    unsubscribe();
  }
});

test('Needs Planning filter retains queued demand within selected machines and excludes scheduled peers', () => {
  const prior = Table._chipFilters;
  try {
    Table._chipFilters = { lines: new Set(['L1']), colors: new Set(), status: 'needs_planning', dateKey: null, poMat: new Set() };
    const queued = { id: 'q', MACHINE: 'L1', planning_status: 'needs_planning', start_date: null, end_date: null };
    assert.equal(Table._taskPassesChipFilters(queued), true);
    assert.equal(Table._taskPassesChipFilters({ ...queued, MACHINE: 'L2' }), false);
    assert.equal(Table._taskPassesChipFilters({ ...queued, planning_status: 'scheduled' }), false);
  } finally { Table._chipFilters = prior; }
});

test('the visibility-horizon row filter reads the SAP start as first received, never the placed start', () => {
  const priorHorizon = Store.visibilityHorizonEnd;
  const priorFilters = Table._chipFilters;
  try {
    Store.setVisibilityHorizonEnd(new Date('2026-10-01T00:00:00'), 'unit-test');
    Table._chipFilters = { lines: new Set(), colors: new Set(), status: null, dateKey: null, poMat: new Set() };
    const base = { id: 'h', MACHINE: 'L1', planning_status: 'scheduled' };
    // placed far beyond the horizon, but SAP starts inside it: still shown
    assert.equal(Table._taskPassesChipFilters({ ...base, start_date: new Date('2026-12-01T08:00:00'),
      BASIC_START_DATE: new Date('2026-09-20T00:00:00') }), true);
    // placed inside the horizon, but SAP's start is beyond it: hidden (the server hides it too)
    assert.equal(Table._taskPassesChipFilters({ ...base, start_date: new Date('2026-09-20T08:00:00'),
      BASIC_START_DATE: new Date('2026-12-01T00:00:00') }), false);
    // no raw copy: the wire original_start_date is the key
    assert.equal(Table._taskPassesChipFilters({ ...base, start_date: new Date('2026-09-20T08:00:00'),
      original_start_date: new Date('2026-12-01T00:00:00') }), false);
  } finally { Store.setVisibilityHorizonEnd(priorHorizon, 'unit-test'); Table._chipFilters = priorFilters; }
});

test('queued demand has no scheduled finish and overdue queue remains in delivery lateness', () => {
  const due = new Date(Date.now() - 48 * 3600000);
  const queued = { id: 'q', planning_status: 'needs_planning', start_date: null, end_date: null, original_end_date: due };
  assert.equal(Util.scheduledEnd(queued), null);
  assert.ok(Util.latenessHours(queued) >= 48);
});

test('Allowed window labels a frozen finish-floor conflict instead of showing a reversed date range', () => {
  const priorMasterData = Store.masterData;
  const priorFrozen = Store.frozenHorizonEnd;
  const due = new Date('2026-09-15T18:00:00');
  const ceiling = new Date('2026-09-16T00:00:00');
  const order = { id: 'expired-window', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1, original_end_date: due };
  try {
    Store.setMasterData({ ...priorMasterData, plants: [{ plant: 'P1', max_pull_forward_days: 0, max_push_forward_days: 0 }] }, 'test');
    // The frozen horizon is a FINISH floor: the start limit shows the pull-forward floor only.
    const edge = new Date('2026-09-19T00:00:00');
    Store.setFrozenHorizonEnd(edge, 'test');
    assert.equal(Table._planningWindowLabel(order),
      `No valid window: finish on/after ${Util.fmtDTReadable(edge)}; complete by ${Util.fmtDTReadable(ceiling)}`);
    // Equality is valid: a window edge equal to the completion limit is not a conflict.
    Store.setFrozenHorizonEnd(ceiling, 'test');
    assert.equal(Table._planningWindowLabel(order),
      `${Util.fmtDTReadable(new Date('2026-09-15T00:00:00'))} — ${Util.fmtDTReadable(ceiling)}`);
    Store.setFrozenHorizonEnd(null, 'test');
    assert.equal(Table._planningWindowLabel(order),
      `${Util.fmtDTReadable(new Date('2026-09-15T00:00:00'))} — ${Util.fmtDTReadable(ceiling)}`);
  } finally {
    Store.setMasterData(priorMasterData, 'test');
    Store.setFrozenHorizonEnd(priorFrozen, 'test');
  }
});

test('Allowed window label reads the task plant frozen edge, not the selected plant', () => {
  const priorMasterData = Store.masterData;
  const priorFrozen = Store.frozenHorizonEnd;
  const order = { id: 'other-plant', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1, original_end_date: new Date('2026-09-15T18:00:00') };
  try {
    // P1 has no frozen window; the selected plant's fallback edge (set below) must not leak into P1's label.
    Store.setMasterData({ ...priorMasterData, plants: [{ plant: 'P1', frozen_horizon_days: 0, max_pull_forward_days: 0, max_push_forward_days: 0 }] }, 'test');
    Store.setFrozenHorizonEnd(new Date('2026-09-19T00:00:00'), 'test');
    assert.equal(Store.frozenHorizonEndFor('P1'), null);
    assert.ok(!/No valid window/.test(Table._planningWindowLabel(order)));
  } finally {
    Store.setMasterData(priorMasterData, 'test');
    Store.setFrozenHorizonEnd(priorFrozen, 'test');
  }
});

// Same split-realm/no-DOM situation documented in
// tests/modules/schedule-services.test.mjs and schedule-data.test.mjs.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById() { return null; },
    addEventListener() {}, removeEventListener() {},
    createElement() {
      return {
        style: {}, hidden: false, id: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, addEventListener() {}, removeEventListener() {},
        querySelector() { return null; },
      };
    },
    querySelector() { return null; },
    body: { appendChild() {} },
  };
}
globalThis.window = globalThis.window || {};

test('Inspector exposes keyboard-equivalent setup detail on the successor, including override and missing states', () => {
  const task = { id: 'detail-successor', PLANT: 'P-SETUP', MACHINE: 'SETUP-L4', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  // The predecessor is read from the schedule, so it must sit earlier on the same machine.
  const predecessorTask = { id: 'detail-predecessor', PLANT: 'P-SETUP', MACHINE: 'SETUP-L4', RUN_TIME: 1,
    start_date: new Date('2026-08-14T06:00:00'), end_date: new Date('2026-08-14T07:00:00') };
  const priorTasks = structuredClone(Store.tasksArr);
  try {
    Store.setTasks([predecessorTask, task], 'unit-test');
    const detail = Inspector._setupDetailForTask(task, {
      intervals: [{ line: 'SETUP-L4', predecessorOrderId: 'detail-predecessor', successorOrderId: 'detail-successor',
        start: new Date('2026-08-14T07:30:00'), end: task.start_date, requiredMinutes: 30, availableMinutes: 15,
        predecessorState: 'COLOR=RED', standardMinutes: 45, source: 'occurrence', overrideStatus: 'active' }],
      diagnostics: [{ type: 'setup-uncovered', line: 'SETUP-L4', successorOrderId: 'detail-successor', message: 'Matrix row missing.' }],
    });
    assert.equal(detail.predecessorOrderId, 'detail-predecessor');
    assert.equal(detail.predecessorState, 'COLOR=RED');
    assert.equal(detail.requiredMinutes, 30);
    assert.equal(detail.effectiveMinutes, 30);
    assert.equal(detail.standardMinutes, 45);
    assert.equal(detail.source, 'occurrence');
    assert.equal(detail.overrideStatus, 'active');
    assert.equal(detail.missingDetail, 'Matrix row missing.');
    assert.equal(detail.shortMinutes, 15);
    assert.match(Inspector._setupCapacityConflictText(detail), /15.*30.*15/,
      'the successor detail must state available, required, and short capacity in text');
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
  }
});

test('Inspector setup detail: an unscheduled order has an unknown predecessor, not "first on machine"', () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const unscheduled = { id: 'detail-unscheduled', PLANT: 'P-SETUP', MACHINE: 'SETUP-L4', RUN_TIME: 1 };
  try {
    Store.setTasks([unscheduled], 'unit-test');
    const detail = Inspector._setupDetailForTask(unscheduled, { intervals: [], diagnostics: [] });
    assert.equal(detail.predecessorOrderId, undefined);
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
  }
});

test('Inspector setup detail: the same machine code in another plant is not a predecessor', () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const task = { id: 'detail-plant-a', PLANT: 'P-A', MACHINE: 'SAME-L1', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
  const otherPlant = { id: 'detail-plant-b', PLANT: 'P-B', MACHINE: 'SAME-L1', RUN_TIME: 1,
    start_date: new Date('2026-08-14T06:00:00'), end_date: new Date('2026-08-14T07:00:00') };
  try {
    Store.setTasks([otherPlant, task], 'unit-test');
    const detail = Inspector._setupDetailForTask(task, { intervals: [], diagnostics: [] });
    assert.equal(detail.predecessorOrderId, null);
  } finally {
    Store.setTasks(priorTasks, 'unit-test');
  }
});

test('Inspector renders derived setup details for orders without setup observations and keeps notes last', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const task = {
    id: 'detail-without-observation', ORDER: '100003', PLANT: 'P-SETUP',
    MACHINE: 'L-SETUP', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00'),
  };
  try {
    const detail = Inspector._setupDetailForTask(task, { intervals: [], diagnostics: [] });
    assert.ok(detail, 'every order should expose a derived setup detail model');
    assert.equal(detail.predecessorOrderId, null);
    assert.equal(detail.requiredMinutes, null);
    assert.equal(detail.missingDetail, null);

    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(task);
    const orderIndex = body.innerHTML.indexOf('ui.insp_order_section');
    const scheduleIndex = body.innerHTML.indexOf('ui.insp_schedule_section');
    const setupIndex = body.innerHTML.indexOf('ui.setup_detail_title');
    const notesIndex = body.innerHTML.indexOf('ui.insp_notes_section');
    assert.ok(orderIndex < scheduleIndex, 'Schedule follows Order');
    assert.ok(scheduleIndex < setupIndex, 'Derived setup follows Schedule');
    assert.ok(setupIndex < notesIndex, 'Notes follows Derived setup and remains last');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
  }
});

test('Inspector does not infer setup values for an order absent from the observation', () => {
  const priorSetup = Store.setupSnapshot;
  const task = {
    id: 'detail-configured-without-observation', ORDER: '100004', PLANT: 'P-SETUP',
    MACHINE: 'L-SETUP', COLOR: 'BLUE', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00'),
  };
  try {
    Store.replaceSetupSnapshot({
      plant: 'P-SETUP',
      definition: { fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1,
        from_key: [{ fieldKey: 'colorWheel', value: 'RED' }],
        to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 30 }],
      machine_rows: [],
      machine_states: [{ machine: 'L-SETUP', signature_version: 1,
        state_key: [{ fieldKey: 'colorWheel', value: 'RED' }], source: 'manual', reason: 'unit-test' }],
      overrides: [],
    }, 'unit-test');
    const detail = Inspector._setupDetailForTask(task, { intervals: [], diagnostics: [] });
    assert.equal(detail.predecessorState, null);
    assert.equal(detail.requiredMinutes, null);
    assert.equal(detail.effectiveMinutes, null);
    assert.equal(detail.standardMinutes, null);
    assert.equal(detail.source, null);
  } finally {
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
  }
});

test('Task 6 (B3b): Inspector._setupDetailForTask, called with its default (real) observation, still surfaces missingDetail for a genuine active-plant coverage gap', () => {
  // Every other Inspector setup-detail test above passes a HAND-BUILT
  // { intervals, diagnostics } observation directly, bypassing
  // Timeline._setupObservation/deriveSetupObservation entirely. This test
  // instead relies on _setupDetailForTask's DEFAULT parameter
  // (`= Timeline._setupObservation(Store.tasksForSelectedPlant())`) — the
  // exact call Inspector._render makes with no override — so the real setup
  // snapshot and real tasks in Store drive the whole chain, proving the
  // presentation layer still actually consumes a genuine, non-synthetic
  // coverage-gap diagnostic after Task 5's rewrite.
  const plant = 'B3B-INSPECTOR-PLANT';
  const line = 'B3B-INSPECTOR-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorGetElementById = globalThis.document.getElementById;

  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    // GREEN -> BLUE is covered (the matrix is genuinely non-empty); BLUE ->
    // RED has no row at all -- the same real coverage-gap shape as the
    // Timeline test above, kept independent so this test does not depend on
    // Store state left by another test.
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('GREEN'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [],
  }, 'unit-test');
  const blueTask = { id: 'insp-cov-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
    start_date: new Date('2026-08-21T08:00:00'), end_date: new Date('2026-08-21T09:00:00') };
  const redTask = { id: 'insp-cov-red', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date('2026-08-21T09:00:00'), end_date: new Date('2026-08-21T10:00:00') };
  Store.setTasks([blueTask, redTask], 'unit-test');

  try {
    // No observation argument -- exercises _setupDetailForTask's own default,
    // i.e. the real Store.setupSnapshot / Store.tasksForSelectedPlant() path.
    const detail = Inspector._setupDetailForTask(redTask);
    assert.equal(detail.predecessorOrderId, 'insp-cov-blue', 'the real predecessor is identified, not blanked to null');
    assert.equal(detail.requiredMinutes, null, 'a genuinely uncovered transition has no required-minutes fact to report');
    assert.ok(detail.missingDetail, 'missingDetail must be populated with the real diagnostic message, not silently omitted');
    assert.match(detail.missingDetail, /setup|missing|uncovered|transition/i);

    const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(redTask);
    assert.match(body.innerHTML, /insp-setup-warning/, 'the rendered Inspector card must surface a setup warning, not just the bare "—" placeholder');
    assert.match(body.innerHTML, /ui\.setup_missing/, 'the warning paragraph carries the real missing-setup label, not an empty tag');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Inspector._setupOverrideFor resolves the real predecessor and existing override on a setup-off plant exactly as on a setup-on plant', () => {
  const plant = 'OVR-OFF-PLANT';
  const line = 'OVR-OFF-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorMaster = Store.masterData;

  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [{ machine: '', signature_version: 1, from_key: state('GREEN'), to_key: state('BLUE'), setup_min: 5 }],
    machine_rows: [],
    machine_states: [{ machine: line, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 'unit test' }],
    overrides: [{ status: 'active', machine: line, signature_version: 1, predecessor_order_id: 'ovr-green', successor_order_id: 'ovr-blue', override_min: 9 }],
  }, 'unit-test');
  const greenTask = { id: 'ovr-green', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'GREEN',
    start_date: new Date('2026-08-21T08:00:00'), end_date: new Date('2026-08-21T09:00:00') };
  const blueTask = { id: 'ovr-blue', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'BLUE',
    start_date: new Date('2026-08-21T09:00:00'), end_date: new Date('2026-08-21T10:00:00') };
  Store.setTasks([greenTask, blueTask], 'unit-test');
  const withPlantRow = flag => Store.setMasterData({ ...(priorMaster ?? {}), plants: [{ plant, setup_active: flag }] }, 'unit-test');

  try {
    const results = [];
    for (const flag of [false, true]) {
      withPlantRow(flag);
      const found = Inspector._setupOverrideFor(blueTask);
      assert.equal(found?.predecessorOrderId, 'ovr-green', `real predecessor, not the machine state (setup_active=${flag})`);
      assert.equal(found.existing?.override_min, 9, `existing active override found (setup_active=${flag})`);
      results.push(found.predecessorOrderId);
    }
    assert.deepEqual(results, ['ovr-green', 'ovr-green']);
    withPlantRow(false);
    assert.equal(Inspector._setupDetailForTask(blueTask).requiredMinutes, null, 'display stays empty on a setup-off plant');
  } finally {
    globalThis.NimbusComputeCore = priorCore;
    Store.setMasterData(priorMaster, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Fix 2: Inspector renders no missingDetail for a genuine setup-no-change diagnostic (identical-signature, zero-minute transition)', () => {
  // Regression target: the D4 'setup-no-change' diagnostic never sets
  // .message and has no SETUP_DIAGNOSTIC_PRESENTATION entry, so the old
  // unconditional `diagnostic ? (diagnostic.message || setupDiagnosticLabel(...)) : null`
  // fell through setupDiagnosticLabel's default to 'ui.setup_missing' --
  // rendering a spurious "missing setup data" warning under an otherwise
  // clean, fully-covered, zero-minute no-change transition. Same real
  // end-to-end shape as the "Task 6 (B3b)" test above (default observation
  // param, driving deriveSetupObservation for real), and same diagnostic
  // shape as schedule-services.test.mjs's D4 no-change test (two same-color
  // orders, no matrix rows/overrides at all -> resolves via the
  // 'implicit-zero' branch).
  const plant = 'FIX2-NOCHANGE-PLANT';
  const line = 'FIX2-NOCHANGE-LINE';
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;

  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  Store.replaceSetupSnapshot({
    plant,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  }, 'unit-test');
  const firstTask = { id: 'fix2-nochange-a', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date('2026-08-21T08:00:00'), end_date: new Date('2026-08-21T09:00:00') };
  const secondTask = { id: 'fix2-nochange-b', PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date('2026-08-21T10:00:00'), end_date: new Date('2026-08-21T11:00:00') };
  Store.setTasks([firstTask, secondTask], 'unit-test');

  try {
    // No observation argument -- exercises _setupDetailForTask's own default
    // (the real Store.setupSnapshot / Store.tasksForSelectedPlant() path),
    // proving the actual diagnostic deriveSetupObservation produces for this
    // identical-signature pair is type 'setup-no-change', not something the
    // test hand-picked.
    const observation = Timeline._setupObservation(Store.tasksForSelectedPlant());
    const noChange = observation.diagnostics.find(d => d.successorOrderId === 'fix2-nochange-b');
    assert.equal(noChange?.type, 'setup-no-change', 'this fixture must genuinely produce the no-change diagnostic under test');

    const detail = Inspector._setupDetailForTask(secondTask);
    assert.equal(detail.missingDetail, null, 'a no-change transition must never render a missing-setup-data warning');
    assert.equal(detail.overrideStatus, 'none', 'regression guard for the whole no-change detail-card path, not just missingDetail');
  } finally {
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Inspector formats setup signatures in configured order with readable labels', () => {
  const formatted = Inspector._formatSetupState([
    { fieldKey: 'colorWheel', value: 'Ruby' },
    { fieldKey: 'prt01', value: '7B10' },
    { fieldKey: 'prt02', value: 'T-3' },
  ], { fields: ['colorWheel', 'prt01', 'prt02'] });

  assert.equal(formatted, 'Color: Ruby · PRT01: 7B10 · PRT02: T-3');
});

test('Inspector._isSetupActionTask still identifies the active/earliest-upcoming order on its line (function retained, no longer gates setup controls)', () => {
  // _isSetupActionTask itself is unchanged and still exported, so it is still
  // tested directly here. What changed is that Inspector._render's
  // canWriteSetup no longer calls it — canWriteSetup is now just
  // `!!setupPlant && Inspector._canWriteSetup(setupPlant)`, so setup controls
  // are no longer restricted to the active/earliest-upcoming order. This test
  // intentionally does NOT assert anything about canWriteSetup/button gating.
  const now = new Date('2026-08-17T10:00:00');
  const earlier = { id: 'setup-earlier', MACHINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T08:00:00'), end_date: new Date('2026-08-17T09:00:00') };
  const active = { id: 'setup-active', MACHINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T09:30:00'), end_date: new Date('2026-08-17T10:30:00') };
  const later = { id: 'setup-later', MACHINE: 'SETUP-CURRENT', RUN_TIME: 1,
    start_date: new Date('2026-08-17T11:00:00'), end_date: new Date('2026-08-17T12:00:00') };
  const futureFirst = { id: 'setup-future-first', MACHINE: 'SETUP-FUTURE', RUN_TIME: 1,
    start_date: new Date('2026-08-17T10:15:00'), end_date: new Date('2026-08-17T11:00:00') };
  const futureLater = { id: 'setup-future-later', MACHINE: 'SETUP-FUTURE', RUN_TIME: 1,
    start_date: new Date('2026-08-17T10:30:00'), end_date: new Date('2026-08-17T11:30:00') };
  try {
    Store.setTasks([earlier, active, later, futureLater, futureFirst], 'unit-test');
    assert.equal(Inspector._isSetupActionTask(active, now), true);
    assert.equal(Inspector._isSetupActionTask(later, now), false);
    assert.equal(Inspector._isSetupActionTask(futureFirst, now), true);
    assert.equal(Inspector._isSetupActionTask(futureLater, now), false);
  } finally { Store.setTasks([], 'unit-test'); }
});

test('Inspector derives covered and uncovered exact-pair override values without permitting negative remaining minutes', () => {
  assert.deepEqual(Inspector._setupOverrideValues(20, '-7', ''), { standardMin: 20, remainingMin: 13 });
  assert.deepEqual(Inspector._setupOverrideValues(null, '', '35'), { standardMin: 35, remainingMin: 35 });
  assert.equal(Inspector._setupOverrideValues(20, '-21', ''), null);
  assert.equal(Inspector._setupOverrideValues(null, '', ''), null);
});

test('Inspector shows a plain dash for unavailable setup values and names the missing matrix data only in the explanatory warning', () => {
  // Regression target: missingSetupPlaceholder reverted from a translated
  // 'ui.setup_missing' string back to a plain '—' (Inspector._render no longer
  // calls Util.t for the six per-value placeholders) — only the standalone
  // warning paragraph still names the missing matrix data via setupDiagnosticLabel.
  const priorGetElementById = globalThis.document.getElementById;
  const priorSetupDetail = Inspector._setupDetailForTask;
  const priorTranslate = Util.t;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._setupDetailForTask = () => ({
      predecessorOrderId: null, predecessorState: null, successorOrderId: 'missing-setup-inspector',
      requiredMinutes: null, effectiveMinutes: null, standardMinutes: null, source: 'resolved',
      overrideStatus: null, availableMinutes: null, shortMinutes: null, missingDetail: 'No matching matrix row.',
    });
    Util.t = key => key === 'ui.setup_missing' ? 'Missing setup matrix data' : key;
    Inspector._render({ id: 'missing-setup-inspector', ORDER: '100002', MACHINE: 'L1', RUN_TIME: 1 });
    const setupPanel = body.innerHTML.slice(body.innerHTML.indexOf('ui.setup_detail_title'));
    const dashCount = [...setupPanel.matchAll(/—/g)].length;
    assert.equal(dashCount, 5, 'the five unavailable setup values (state, required, effective, standard, override) render a plain dash; an absent predecessor reads First on machine');
    const missingTextCount = [...setupPanel.matchAll(/Missing setup matrix data/g)].length;
    assert.equal(missingTextCount, 1,
      'only the standalone explanatory warning paragraph names the missing matrix data — the per-value placeholders no longer do');
    assert.match(setupPanel, /No matching matrix row\./, 'the warning still surfaces the diagnostic message text');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Inspector._setupDetailForTask = priorSetupDetail;
    Util.t = priorTranslate;
  }
});
test('Table/Inspector/ContextMenu expose the documented public API', () => {
  assert.equal(typeof Table.init, 'function');
  assert.equal(typeof Inspector.show, 'function');
  assert.equal(typeof Inspector.clear, 'function');
  assert.equal(typeof ContextMenu.open, 'function');
});

test('Orders grid exposes editable priority fields instead of Form Size', () => {
  const columns = Table._priorityColumns();
  assert.deepEqual(columns.map(c => c.field), ['PRT_01', 'PRT_02', 'PRODUCTION_VERSION']);
  const [prt1, prt2, pvColumn] = columns;
  assert.ok(prt1.editable === true && prt2.editable === true, 'PRT fields must be inline-editable');
  // D11: the production version is editable only where it is not chosen together with the machine.
  assert.equal(typeof pvColumn.editable, 'function');
  const priorMaster = _enableRoutingForPlant('P-PV-COLUMN');
  try {
    assert.equal(pvColumn.editable({ data: { PLANT: 'P-PV-COLUMN', MACHINE: 'L1' } }), false, 'read-only on a routing plant');
    assert.equal(pvColumn.editable({ data: { PLANT: 'P-OTHER', MACHINE: 'L1' } }), true, 'free edit elsewhere');
  } finally { Store.setMasterData(priorMaster, 'test'); }
  assert.ok(!columns.some(c => c.field === 'FORM_SIZE'), 'Form Size must be removed from the Orders view');
});

test('Inspector puts editable priority fields in the Order section', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const priorVisibility = structuredClone(Store.orderFieldVisibility);
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Store.setOrderFieldVisibility({
      ...priorVisibility,
      PRT_01: { inspector: true }, PRT_02: { inspector: true }, PRODUCTION_VERSION: { inspector: true },
    }, 'unit-test');
    Inspector._render({
      id: 'inspector-priority-fields', ORDER: '100001', MACHINE: 'L1', RUN_TIME: 1,
      PRT_01: '1J13', PRT_02: '2K24', PRODUCTION_VERSION: '0001',
    });
    const orderSection = body.innerHTML.slice(0, body.innerHTML.indexOf('ui.insp_notes_section'));
    for (const field of ['PRT_01', 'PRT_02', 'PRODUCTION_VERSION']) {
      assert.match(orderSection, new RegExp(`<input type="text" data-field="${field}"`),
        `${field} is an editable input in the Order section`);
    }
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Store.setOrderFieldVisibility(priorVisibility, 'unit-test');
  }
});
test('Task 3: B2 — Table._onCellChanged no longer calls autoReflow (peers stay put even if overlapping)', () => {
  // Task 3 deleted Engine.autoReflow call from Table._onCellChanged.
  // This test calls the real handler (not Store.updateTask) and verifies autoReflow is NOT invoked.
  const line = 'NO-REFLOW-TABLE-LINE';
  const plant = '5512';
  const start1 = new Date('2026-08-25T08:00:00');
  const end1 = new Date('2026-08-25T10:00:00');
  const start2 = new Date('2026-08-25T09:00:00'); // overlaps with task 1
  const end2 = new Date('2026-08-25T11:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;
  const priorTableApi = Table._api;
  // Store.updateTask (called by Table._onCellChanged) unconditionally arms
  // Alerts' debounced recompute timer at the end of its walk. Stubbed to a
  // no-op for the duration of this test — same established pattern as
  // scheduling/gantt.test.mjs's Interaction drag tests — so no setTimeout
  // callback fires after the test has already completed and reaches for the
  // real (unstubbed in this file) NimbusComputeCore global.
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};

  let autoReflowCalls = [];
  Engine.autoReflow = (id) => autoReflowCalls.push(id);
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };

  const restoreClock = pinPlantClock([plant]);
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'table-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'table-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    const peerBefore = Store.tasks['table-peer'].start_date.getTime();
    // Call the real handler with an end_date cell change that creates an overlap (a typed End is the finish)
    Table._onCellChanged({
      colDef: { field: 'end_date' },
      data: Store.tasks['table-anchor'],
      newValue: '2026-08-25 09:00',
      node: { refreshCells: () => {} },
    });
    assert.equal(Store.tasks['table-anchor'].end_date.getTime(), new Date('2026-08-25T09:00:00').getTime(), 'the typed End is held');
    assert.equal(Store.tasks['table-anchor'].start_date.getTime(), new Date('2026-08-25T07:00:00').getTime(), 'the start is derived (2 h run time)');
    const peerAfter = Store.tasks['table-peer'].start_date.getTime();
    // Peer should NOT have moved and autoReflow should NOT have been called
    assert.equal(peerAfter, peerBefore, 'peer must NOT be reflowed after Table cell edit');
    assert.equal(autoReflowCalls.length, 0, 'Engine.autoReflow must NOT be called from Table._onCellChanged (Task 3: B2 deleted this call)');
  } finally {
    restoreClock();
    Engine.autoReflow = priorAutoReflow;
    Table._api = priorTableApi;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
  }
});

test('Task 3: B2 — Inspector._onFieldChange no longer calls autoReflow (peers stay put even if overlapping)', () => {
  // Task 3 deleted Engine.autoReflow call from Inspector._onFieldChange.
  // This test calls the real handler (not Store.updateTask) and verifies autoReflow is NOT invoked.
  const line = 'NO-REFLOW-INSPECTOR-LINE';
  const plant = '5512';
  const start1 = new Date('2026-08-25T08:00:00');
  const end1 = new Date('2026-08-25T10:00:00');
  const start2 = new Date('2026-08-25T09:00:00'); // overlaps with task 1
  const end2 = new Date('2026-08-25T11:00:00');
  const priorPlant = Store.selectedPlant;
  const priorAutoReflow = Engine.autoReflow;
  const priorCurrentId = Inspector._currentId;
  // Store.updateTask (called by Inspector._onFieldChange) unconditionally arms
  // Alerts' debounced recompute timer at the end of its walk. Stubbed to a
  // no-op for the duration of this test — same established pattern as
  // scheduling/gantt.test.mjs's Interaction drag tests — so no setTimeout
  // callback fires after the test has already completed and reaches for the
  // real (unstubbed in this file) NimbusComputeCore global.
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};

  let autoReflowCalls = [];
  Engine.autoReflow = (id) => autoReflowCalls.push(id);

  const restoreClock = pinPlantClock([plant]);
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'inspector-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'inspector-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    Inspector._currentId = 'inspector-anchor';
    const peerBefore = Store.tasks['inspector-peer'].start_date.getTime();
    // Call the real handler with an end_date field change that creates an overlap (a typed End is the finish)
    Inspector._onFieldChange('end_date', '2026-08-25 09:00');
    assert.equal(Store.tasks['inspector-anchor'].end_date.getTime(), new Date('2026-08-25T09:00:00').getTime());
    assert.equal(Store.tasks['inspector-anchor'].start_date.getTime(), new Date('2026-08-25T07:00:00').getTime());
    const peerAfter = Store.tasks['inspector-peer'].start_date.getTime();
    // Peer should NOT have moved and autoReflow should NOT have been called
    assert.equal(peerAfter, peerBefore, 'peer must NOT be reflowed after Inspector field change');
    assert.equal(autoReflowCalls.length, 0, 'Engine.autoReflow must NOT be called from Inspector._onFieldChange (Task 3: B2 deleted this call)');
  } finally {
    restoreClock();
    Engine.autoReflow = priorAutoReflow;
    Inspector._currentId = priorCurrentId;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
  }
});

// --- Distribution (aggregate_to_detail.md §8) — machine lock + markers -----

test('Table._onCellChanged rejects a cross-machine MACHINE edit on a sub-order (PARENT_ORDER set): reverts the cell and shows the distribution-lock toast, no schedule regenerated', () => {
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  // Real en.js interpolation, so this test also pins the toast copy itself.
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.dist_machine_locked': '{{order}} runs on {{machine}} because of its distribution. Adjust shares to move it.' } };
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  let refreshed = false;
  Table._api = { applyTransaction: () => {}, refreshCells: () => { refreshed = true; } };

  Store.setTasks([{
    id: 'dist-child-cell-edit', PRODUCTION_ORDER: 'A-9001', ORDER: 'A-9001',
    PARENT_ORDER: '9001', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1',
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
  }], 'test');

  try {
    // AG Grid's default valueSetter already writes p.newValue onto
    // p.data.MACHINE before onCellValueChanged fires — mirrored here so the
    // handler's revert-from-oldValue logic is exercised the same way.
    const row = Store.tasks['dist-child-cell-edit'];
    row.MACHINE = 'L2';
    Table._onCellChanged({
      colDef: { field: 'MACHINE' },
      data: row,
      newValue: 'L2',
      oldValue: 'L1',
      node: { refreshCells: () => {} },
    });
    assert.equal(Store.tasks['dist-child-cell-edit'].MACHINE, 'L1', 'MACHINE must be reverted to its pre-edit value');
    assert.equal(toastCalls.length, 1, 'the distribution-lock toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9001/);
    assert.match(toastCalls[0].msg, /L1/);
    assert.equal(refreshed, true, 'the grid cell must be refreshed to show the reverted value');
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
  }
});

test('Table._getLineOptions returns only the sub-order\'s current machine (PARENT_ORDER set) — no other line is offered', () => {
  assert.deepEqual(Table._getLineOptions({ MACHINE: 'L7', PARENT_ORDER: '9002' }), ['L7']);
  assert.deepEqual(Table._getLineOptions({ MACHINE: null, PARENT_ORDER: '9002' }), ['Unknown']);
});

// --- D12 (Distribution_Audit_10_01.md): Table._onStore keeps pace with
// removals and newly-added sub-orders instead of only ever updating rows
// already present in the grid. ------------------------------------------

function _stubTableApiForOnStore(overrides = {}) {
  return {
    applyTransaction: () => {},
    getRowNode: () => undefined,
    isAnyFilterPresent: () => false,
    onFilterChanged: () => {},
    getDisplayedRowCount: () => 0,
    ...overrides,
  };
}

test('Table._onStore task:remove applies a grid remove transaction for the removed task and refreshes the empty state', () => {
  const priorTableApi = Table._api;
  const priorRenderEmptyState = Table._renderEmptyState;
  const prev = { id: 'removed-order-1', MACHINE: 'L9' };
  const txns = [];
  let emptyStateCalls = 0;
  Table._api = _stubTableApiForOnStore({ applyTransaction: txn => txns.push(txn) });
  Table._renderEmptyState = () => { emptyStateCalls++; };
  try {
    Table._onStore({ type: 'task:remove', id: 'removed-order-1', prev, source: 'distribution' });
    assert.deepEqual(txns, [{ remove: [prev] }]);
    assert.equal(emptyStateCalls, 1);
  } finally {
    Table._api = priorTableApi;
    Table._renderEmptyState = priorRenderEmptyState;
  }
});

test('Table._onStore task:remove with no evt.prev applies no transaction (nothing to remove)', () => {
  const priorTableApi = Table._api;
  const priorRenderEmptyState = Table._renderEmptyState;
  const txns = [];
  let emptyStateCalls = 0;
  Table._api = _stubTableApiForOnStore({ applyTransaction: txn => txns.push(txn) });
  Table._renderEmptyState = () => { emptyStateCalls++; };
  try {
    Table._onStore({ type: 'task:remove', id: 'never-existed', prev: null, source: 'distribution' });
    assert.deepEqual(txns, []);
    assert.equal(emptyStateCalls, 1);
  } finally {
    Table._api = priorTableApi;
    Table._renderEmptyState = priorRenderEmptyState;
  }
});

test('Table._onStore task:remove for a task not present in the grid (e.g. another plant\'s task) does not throw', () => {
  const priorTableApi = Table._api;
  const priorRenderEmptyState = Table._renderEmptyState;
  Table._api = _stubTableApiForOnStore();
  Table._renderEmptyState = () => {};
  const prev = { id: 'other-plant-task', MACHINE: 'L1', PLANT: 'P-OTHER' };
  try {
    assert.doesNotThrow(() => {
      Table._onStore({ type: 'task:remove', id: 'other-plant-task', prev, source: 'distribution' });
    });
  } finally {
    Table._api = priorTableApi;
    Table._renderEmptyState = priorRenderEmptyState;
  }
});

test('Table._onStore tasks:bulkUpdate adds a row for an id not yet in the grid (a new sub-order) instead of silently dropping it', () => {
  const priorPlant = Store.selectedPlant;
  const priorTableApi = Table._api;
  const priorDropdowns = Table._refreshChipDropdowns;
  const plant = 'P-BULK-ADD';
  const id = 'bulk-new-child';
  Store.setSelectedPlant(plant, 'test');
  // MACHINE deliberately isn't a line master data knows about — rowData's own
  // plant test (t.PLANT || Store.getPlantForLine(t.MACHINE)) must fall back to
  // PLANT so this new child isn't dropped.
  Store.tasks[id] = { id, PLANT: plant, MACHINE: 'NEW-LINE-NOT-IN-MASTER-DATA' };
  let dropdownCalls = 0;
  Table._refreshChipDropdowns = () => { dropdownCalls++; };
  let txn = null;
  Table._api = _stubTableApiForOnStore({ applyTransaction: t => { txn = t; }, getRowNode: () => undefined });
  try {
    Table._onStore({ type: 'tasks:bulkUpdate', ids: [id], source: 'distribution' });
    assert.deepEqual(txn.add, [Store.tasks[id]]);
    assert.deepEqual(txn.update, []);
    assert.equal(dropdownCalls, 1, '_refreshChipDropdowns must run once a row was added');
  } finally {
    Table._api = priorTableApi;
    Table._refreshChipDropdowns = priorDropdowns;
    delete Store.tasks[id];
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('Table._onStore tasks:bulkUpdate updates (not re-adds) a row already present in the grid, and does not refresh the chip dropdowns', () => {
  const priorPlant = Store.selectedPlant;
  const priorTableApi = Table._api;
  const priorDropdowns = Table._refreshChipDropdowns;
  const plant = 'P-BULK-UPDATE';
  const id = 'bulk-existing-row';
  Store.setSelectedPlant(plant, 'test');
  Store.tasks[id] = { id, PLANT: plant, MACHINE: 'L1' };
  let dropdownCalls = 0;
  Table._refreshChipDropdowns = () => { dropdownCalls++; };
  let txn = null;
  Table._api = _stubTableApiForOnStore({ applyTransaction: t => { txn = t; }, getRowNode: () => ({}) });
  try {
    Table._onStore({ type: 'tasks:bulkUpdate', ids: [id], source: 'distribution' });
    assert.deepEqual(txn.update, [Store.tasks[id]]);
    assert.deepEqual(txn.add, []);
    assert.equal(dropdownCalls, 0, '_refreshChipDropdowns must not run when nothing was added');
  } finally {
    Table._api = priorTableApi;
    Table._refreshChipDropdowns = priorDropdowns;
    delete Store.tasks[id];
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

test('Table._onStore tasks:bulkUpdate excludes an id whose task belongs to a different plant', () => {
  const priorPlant = Store.selectedPlant;
  const priorTableApi = Table._api;
  const priorDropdowns = Table._refreshChipDropdowns;
  const id = 'bulk-other-plant';
  Store.setSelectedPlant('P-HERE', 'test');
  Store.tasks[id] = { id, PLANT: 'P-ELSEWHERE', MACHINE: 'SOME-LINE' };
  let dropdownCalls = 0;
  Table._refreshChipDropdowns = () => { dropdownCalls++; };
  let txn = null;
  Table._api = _stubTableApiForOnStore({ applyTransaction: t => { txn = t; }, getRowNode: () => undefined });
  try {
    Table._onStore({ type: 'tasks:bulkUpdate', ids: [id], source: 'distribution' });
    assert.deepEqual(txn.add, []);
    assert.deepEqual(txn.update, []);
    assert.equal(dropdownCalls, 0);
  } finally {
    Table._api = priorTableApi;
    Table._refreshChipDropdowns = priorDropdowns;
    delete Store.tasks[id];
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

// --- D29 (Distribution_Audit_10_01.md): the Override dialog must honor the
// same machine lock as the grid/Inspector/Gantt-drag edit paths for a
// sub-order (PARENT_ORDER set) — see the cross-machine MACHINE edit test
// above (`Table._onCellChanged rejects a cross-machine MACHINE edit...`). ---

test('Table.applyOverride rejects a cross-machine override on a sub-order (PARENT_ORDER set): shows the distribution-lock toast, does not reschedule', () => {
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const priorGetElementById = globalThis.document.getElementById;
  const priorSelectedId = Table._selectedId;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.dist_machine_locked': '{{order}} runs on {{machine}} because of its distribution. Adjust shares to move it.' } };
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  let applyTransactionCalls = 0;
  Table._api = _stubTableApiForOnStore({ applyTransaction: () => { applyTransactionCalls++; } });

  const elements = {
    'ovr-finish': { value: '2026-09-21 10:00' },
    'ovr-line': { value: 'L2' },
    'ovr-firm': { checked: false },
  };
  globalThis.document.getElementById = id => elements[id] || null;

  Store.setTasks([{
    id: 'dist-child-override', PRODUCTION_ORDER: 'A-9201', ORDER: 'A-9201',
    PARENT_ORDER: '9201', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1',
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
  }], 'test');
  Table._selectedId = 'dist-child-override';

  try {
    Table.applyOverride();
    assert.equal(Store.tasks['dist-child-override'].MACHINE, 'L1', 'MACHINE must be untouched');
    assert.equal(applyTransactionCalls, 0, 'no grid transaction must be applied');
    assert.equal(toastCalls.length, 1, 'the distribution-lock toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9201/);
    assert.match(toastCalls[0].msg, /L1/);
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    globalThis.document.getElementById = priorGetElementById;
    Table._selectedId = priorSelectedId;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
  }
});

test('Table.applyOverride does not reject a date/firm-only Override on a sub-order with no MACHINE (the dialog\'s only option is "Unknown")', () => {
  // Fix round 1: the guard compared newLine !== t.MACHINE raw. For a
  // sub-order with MACHINE: null, _getLineOptions(t) offers only 'Unknown'
  // (Table._getLineOptions: `[forTask.MACHINE || 'Unknown']`) — resubmitting
  // that same (only) option must NOT be treated as a machine move. The brief's
  // normalized comparison is newLine !== (t.MACHINE || 'Unknown').
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const priorGetElementById = globalThis.document.getElementById;
  const priorSelectedId = Table._selectedId;
  const priorPatchFor = Engine.manualRoutingSchedulePatchFor;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  Alerts.scheduleRecompute = () => {};
  const newStart = new Date('2026-09-21T08:00:00');
  const newEnd = new Date('2026-09-21T10:00:00');
  Engine.manualRoutingSchedulePatchFor = () => ({ start_date: newStart, end_date: newEnd });
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  let applyTransactionCalls = 0;
  Table._api = _stubTableApiForOnStore({ applyTransaction: () => { applyTransactionCalls++; } });

  const elements = {
    'ovr-finish': { value: '2026-09-21 10:00' },
    'ovr-line': { value: 'Unknown' },
    'ovr-firm': { checked: false },
  };
  globalThis.document.getElementById = id => elements[id] || null;

  Store.setTasks([{
    id: 'dist-child-no-machine', PRODUCTION_ORDER: 'A-9202', ORDER: 'A-9202', PLANT: 'P-DIST-NO-MACHINE',
    PARENT_ORDER: '9202', DISTRIBUTION_LETTER: 'A', MACHINE: null,
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
  }], 'test');
  Table._selectedId = 'dist-child-no-machine';

  try {
    Table.applyOverride();
    assert.equal(toastCalls.some(c => c.type === 'warn'), false, 'no distribution-lock toast must fire for a resubmitted "Unknown" machine');
    assert.equal(applyTransactionCalls, 1, 'the edit must proceed instead of being discarded');
    assert.equal(Store.tasks['dist-child-no-machine'].start_date.getTime(), newStart.getTime());
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    globalThis.document.getElementById = priorGetElementById;
    Table._selectedId = priorSelectedId;
    Engine.manualRoutingSchedulePatchFor = priorPatchFor;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks([], 'test');
  }
});

test('Inspector._render disables the MACHINE select with an explanatory title for a sub-order (PARENT_ORDER set)', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  const task = {
    id: 'dist-inspector-locked', ORDER: 'A-9003', PARENT_ORDER: '9003', DISTRIBUTION_LETTER: 'A',
    PLANT: 'P-DIST', MACHINE: 'L3', RUN_TIME: 1,
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(task);
    const selectIdx = body.innerHTML.indexOf('data-field="MACHINE"');
    assert.ok(selectIdx >= 0, 'the MACHINE select must still render');
    const selectTagStart = body.innerHTML.lastIndexOf('<select', selectIdx);
    const selectTagEnd = body.innerHTML.indexOf('>', selectIdx);
    const selectTag = body.innerHTML.slice(selectTagStart, selectTagEnd);
    assert.match(selectTag, /\bdisabled\b/, 'the select must be disabled, not hidden');
    assert.match(selectTag, /title="[^"]+"/, 'the select must carry an explanatory title');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
  }
});

test('Inspector._render leaves the MACHINE select enabled for a plain (non-distributed) order', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  const task = {
    id: 'plain-inspector-order', ORDER: 'PLAIN-1', PLANT: 'P-DIST', MACHINE: 'L3', RUN_TIME: 1,
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(task);
    const selectIdx = body.innerHTML.indexOf('data-field="MACHINE"');
    const selectTagStart = body.innerHTML.lastIndexOf('<select', selectIdx);
    const selectTagEnd = body.innerHTML.indexOf('>', selectIdx);
    const selectTag = body.innerHTML.slice(selectTagStart, selectTagEnd);
    assert.doesNotMatch(selectTag, /\bdisabled\b/);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
  }
});

test('Table._orderColumnComparator groups a distributed order\'s siblings adjacent by letter instead of scattering by their own PRODUCTION_ORDER text', () => {
  const bare = { PRODUCTION_ORDER: 'ZZZ-OTHER', PARENT_ORDER: null, DISTRIBUTION_LETTER: null };
  const childB = { PRODUCTION_ORDER: 'B-9004', PARENT_ORDER: '9004', DISTRIBUTION_LETTER: 'B' };
  const childA = { PRODUCTION_ORDER: 'A-9004', PARENT_ORDER: '9004', DISTRIBUTION_LETTER: 'A' };
  const unrelated = { PRODUCTION_ORDER: 'AAA-EARLY', PARENT_ORDER: null, DISTRIBUTION_LETTER: null };
  const sorted = [bare, childB, unrelated, childA].sort((a, b) => Table._orderColumnComparator(a, b));
  const siblingIdx = sorted.reduce((acc, t, i) => (t.PARENT_ORDER === '9004' ? [...acc, i] : acc), []);
  assert.deepEqual(siblingIdx, [siblingIdx[0], siblingIdx[0] + 1], 'both siblings must be adjacent in the sort');
  assert.equal(sorted[siblingIdx[0]].DISTRIBUTION_LETTER, 'A');
  assert.equal(sorted[siblingIdx[0] + 1].DISTRIBUTION_LETTER, 'B');
});

test('Table._orderColumnRenderer appends the letter·count pill for a lettered sub-order and leaves a bare (100%) child untouched', () => {
  const priorPlant = Store.selectedPlant;
  const plant = 'P-DIST-GRID';
  Store.setSelectedPlant(plant, 'test');
  Store.setTasks([
    { id: 'grid-a', PLANT: plant, PRODUCTION_ORDER: 'A-9005', PARENT_ORDER: '9005', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1' },
    { id: 'grid-b', PLANT: plant, PRODUCTION_ORDER: 'B-9005', PARENT_ORDER: '9005', DISTRIBUTION_LETTER: 'B', MACHINE: 'L2' },
  ], 'test');
  try {
    const html = Table._orderColumnRenderer({ value: 'A-9005', data: Store.tasks['grid-a'] });
    assert.match(html, /A-9005/);
    assert.match(html, /class="split-order-part dist-part"/);
    assert.match(html, new RegExp('A·2'), 'pill must read A·2 for two living siblings');

    const bareHtml = Table._orderColumnRenderer({ value: 'C-9006', data: { PRODUCTION_ORDER: 'C-9006', PARENT_ORDER: '9006', DISTRIBUTION_LETTER: null } });
    assert.equal(bareHtml, 'C-9006', 'a bare (100%) child has no letter, so no pill is appended');
  } finally {
    Store.setTasks([], 'test');
    Store.setSelectedPlant(priorPlant, 'test');
  }
});

// --- Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.2/§8.3) -----------------
// These tests stub Runtime.eligible/Runtime.resolve directly rather than
// populating a real rate map — Runtime's own formula/parity coverage lives
// in tests/modules/routing/runtime-client.test.mjs; this file only exercises
// the orders.mts call sites that consume it.

function _enableRoutingForPlant(plant) {
  const priorMasterData = Store.masterData;
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, routing_runtime_enabled: true }] }, 'test');
  return priorMasterData;
}

test('Table._onCellChanged rejects a MACHINE edit when Runtime.eligible is false: reverts the cell and toasts, no schedule regenerated', () => {
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const priorEligible = Runtime.eligible;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.no_routing_at_workcenter': '{{order}} has no routing operation at {{machine}} — move blocked.' } };
  const plant = 'P-ROUTING-GRID';
  const priorMasterData = _enableRoutingForPlant(plant);
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  let eligibleCalls = [];
  Runtime.eligible = (task, machine) => { eligibleCalls.push(machine); return false; };
  let refreshed = false;
  Table._api = { applyTransaction: () => {}, refreshCells: () => { refreshed = true; } };

  Store.setTasks([{
    id: 'routing-grid-cell-edit', PRODUCTION_ORDER: 'A-9101', ORDER: 'A-9101', PLANT: plant,
    MACHINE: 'L1', start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
  }], 'test');

  try {
    const row = Store.tasks['routing-grid-cell-edit'];
    row.MACHINE = 'L2';
    Table._onCellChanged({
      colDef: { field: 'MACHINE' },
      data: row,
      newValue: 'L2',
      oldValue: 'L1',
      node: { refreshCells: () => {} },
    });
    assert.deepEqual(eligibleCalls, ['L2']);
    assert.equal(Store.tasks['routing-grid-cell-edit'].MACHINE, 'L1', 'MACHINE must be reverted to its pre-edit value');
    assert.equal(toastCalls.length, 1, 'the routing-ineligible toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9101/);
    assert.match(toastCalls[0].msg, /L2/);
    assert.equal(refreshed, true, 'the grid cell must be refreshed to show the reverted value');
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    Runtime.eligible = priorEligible;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._onCellChanged skips the routing eligibility guard on a plant that has not enabled the feature', () => {
  const priorTableApi = Table._api;
  const priorEligible = Runtime.eligible;
  const plant = 'P-ROUTING-DISABLED';
  const priorMasterData = Store.masterData;
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, routing_runtime_enabled: false }] }, 'test');
  Store.serverOffsetMs = new Date('2026-08-01T00:00:00').getTime() - Date.now();   // restored by the afterEach hook
  let eligibleCalls = 0;
  Runtime.eligible = () => { eligibleCalls++; return false; };
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  Alerts.scheduleRecompute = () => {};

  Store.setTasks([{
    id: 'routing-disabled-cell-edit', PRODUCTION_ORDER: 'A-9102', ORDER: 'A-9102', PLANT: plant,
    MACHINE: 'L1', RUN_TIME: 1, start_date: new Date('2026-09-21T08:00:00'), end_date: new Date('2026-09-21T10:00:00'),
  }], 'test');

  try {
    const row = Store.tasks['routing-disabled-cell-edit'];
    row.MACHINE = 'L2';
    Table._onCellChanged({
      colDef: { field: 'MACHINE' },
      data: row,
      newValue: 'L2',
      oldValue: 'L1',
      node: { refreshCells: () => {} },
    });
    assert.equal(eligibleCalls, 0, 'Runtime.eligible must not be consulted for a plant with the switch off');
    assert.equal(Store.tasks['routing-disabled-cell-edit'].MACHINE, 'L2', 'the move must be accepted normally');
  } finally {
    Table._api = priorTableApi;
    Runtime.eligible = priorEligible;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Inspector._onFieldChange rejects a MACHINE edit when Runtime.eligible is false: re-renders instead of committing, no schedule regenerated', () => {
  const priorToastShow = Toast.show;
  const priorEligible = Runtime.eligible;
  const priorCurrentId = Inspector._currentId;
  const priorGetElementById = globalThis.document.getElementById;
  const plant = 'P-ROUTING-INSPECTOR';
  const priorMasterData = _enableRoutingForPlant(plant);
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  Runtime.eligible = () => false;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;

  Store.setTasks([{
    id: 'routing-inspector-machine', PRODUCTION_ORDER: 'A-9103', ORDER: 'A-9103', PLANT: plant,
    MACHINE: 'L1', RUN_TIME: 1, start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  }], 'test');

  try {
    Inspector._currentId = 'routing-inspector-machine';
    Inspector._onFieldChange('MACHINE', 'L2');
    assert.equal(Store.tasks['routing-inspector-machine'].MACHINE, 'L1', 'MACHINE must not be committed');
    assert.equal(toastCalls.length, 1, 'the routing-ineligible toast must fire exactly once');
    assert.equal(toastCalls[0].type, 'warn');
    assert.ok(body.innerHTML.length > 0, 'Inspector._render must have been called to restore the select');
  } finally {
    Toast.show = priorToastShow;
    Runtime.eligible = priorEligible;
    Inspector._currentId = priorCurrentId;
    globalThis.document.getElementById = priorGetElementById;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

function _pairEditFixture(id, plant) {
  Store.setTasks([{
    id, PRODUCTION_ORDER: 'A-9104', ORDER: 'A-9104', PLANT: plant, MACHINE: 'L1', MATERIAL_NUMBER: 'MAT',
    PRODUCTION_VERSION: '0001', RUN_TIME: 1, run_time_source: 'sap_order',
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  }], 'test');
  return Store.tasks[id];
}

test('Table._onCellChanged: a PV - Machine pair edit writes PV, machine and run time in one patch, re-places the order and is one undo step', () => {
  const priorTableApi = Table._api;
  const priorResolve = Runtime.resolve;
  const priorManualSchedule = Engine.manualSchedulePatchFor;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const plant = 'P-ROUTING-PV-OK';
  const priorMasterData = _enableRoutingForPlant(plant);
  Alerts.scheduleRecompute = () => {};
  const newStart = new Date('2026-09-21T08:00:00');
  const newEnd = new Date('2026-09-21T13:54:00');
  Runtime.resolve = (task) => (task.PRODUCTION_VERSION === '0002'
    ? { ok: true, hours: 5.9, basis: { workcenter: 'MOLD01', routingKey: '1|50001234|01', source: 'routing' } }
    : { ok: false, step: 'pv_not_found' });
  Engine.manualSchedulePatchFor = () => ({ start_date: newStart, end_date: newEnd, scheduleSegments: [] });
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const undoBefore = UndoStack._entries.length;
  const row = _pairEditFixture('routing-pv-ok', plant);

  try {
    row.MACHINE = '0002|L2';   // AG Grid's default setter writes the raw editor value first
    Table._onCellChanged({ colDef: { field: 'MACHINE' }, data: row, newValue: '0002|L2', oldValue: 'L1', node: { refreshCells: () => {} } });
    const task = Store.tasks['routing-pv-ok'];
    assert.equal(task.MACHINE, 'L2', 'the pair string never stays in MACHINE');
    assert.equal(task.PRODUCTION_VERSION, '0002');
    assert.equal(task.RUN_TIME, 5.9);
    assert.equal(task.run_time_source, 'routing');
    assert.equal(task.run_time_basis.workcenter, 'MOLD01');
    assert.equal(task.start_date.getTime(), newStart.getTime(), 'the order must be re-placed through Engine.manualSchedulePatchFor');
    assert.notEqual(task.planning_status, 'needs_planning');
    assert.equal(UndoStack._entries.length, undoBefore + 1, 'one undo step for the whole pair');
  } finally {
    Table._api = priorTableApi;
    Runtime.resolve = priorResolve;
    Engine.manualSchedulePatchFor = priorManualSchedule;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    UndoStack._entries.length = undoBefore;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._onCellChanged: an ineligible PV - Machine pair is rejected whole: row restored, one pair toast, nothing written', () => {
  const priorTableApi = Table._api;
  const priorResolve = Runtime.resolve;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorToastShow = Toast.show;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: { 'toast.pv_machine_ineligible': '{{order}} cannot run on {{machine}} with {{pv}}.' } };
  const plant = 'P-ROUTING-PV-HELD';
  const priorMasterData = _enableRoutingForPlant(plant);
  Alerts.scheduleRecompute = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  Runtime.resolve = () => ({ ok: false, step: 'pv_workcenter_mismatch' });
  let refreshed = false;
  Table._api = { applyTransaction: () => {}, refreshCells: () => { refreshed = true; } };
  const row = _pairEditFixture('routing-pv-held', plant);

  try {
    row.MACHINE = '0003|L2';
    Table._onCellChanged({ colDef: { field: 'MACHINE' }, data: row, newValue: '0003|L2', oldValue: 'L1', node: { refreshCells: () => {} } });
    const task = Store.tasks['routing-pv-held'];
    assert.equal(task.MACHINE, 'L1');
    assert.equal(task.PRODUCTION_VERSION, '0001');
    assert.equal(task.RUN_TIME, 1);
    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].type, 'warn');
    assert.match(toastCalls[0].msg, /A-9104.*L2.*0003/);
    assert.equal(refreshed, true);
  } finally {
    Table._api = priorTableApi;
    Runtime.resolve = priorResolve;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Toast.show = priorToastShow;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._onCellChanged: re-picking the order\'s own pair is a no-op (no write, no undo entry, no toast)', () => {
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const plant = 'P-ROUTING-PV-SAME';
  const priorMasterData = _enableRoutingForPlant(plant);
  const toastCalls = [];
  Toast.show = (msg) => { toastCalls.push(msg); };
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const undoBefore = UndoStack._entries.length;
  const row = _pairEditFixture('routing-pv-same', plant);
  try {
    row.MACHINE = '0001|L1';
    Table._onCellChanged({ colDef: { field: 'MACHINE' }, data: row, newValue: '0001|L1', oldValue: 'L1', node: {} });
    assert.equal(Store.tasks['routing-pv-same'].MACHINE, 'L1');
    assert.equal(UndoStack._entries.length, undoBefore);
    assert.equal(toastCalls.length, 0);
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._parsePairValue splits at the first pipe and treats a bare machine as "keep the PV"', () => {
  assert.deepEqual(Table._parsePairValue('0002|L2'), { pv: '0002', machine: 'L2' });
  assert.deepEqual(Table._parsePairValue('|L2'), { pv: '', machine: 'L2' });
  assert.deepEqual(Table._parsePairValue('0002|L|2'), { pv: '0002', machine: 'L|2' });
  assert.deepEqual(Table._parsePairValue('L2'), { pv: null, machine: 'L2' });
});

test('Table._getPairOptions: routing plants list eligible pairs, prefix a current pair that is not eligible; others get the line list', () => {
  const priorEligiblePairs = Runtime.eligiblePairs;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'ui.pv_machine_option': '{{pv}} - {{machine}}',
    'ui.pv_machine_current_ineligible': '{{pv}} - {{machine}} (current, not eligible)',
  } };
  const plant = 'P-PAIR-OPTIONS';
  const priorMasterData = _enableRoutingForPlant(plant);
  let seenOpts = null;
  Runtime.eligiblePairs = (task, opts) => { seenOpts = opts; return [
    { pv: '0001', machine: 'L1', workcenter: 'WC1' }, { pv: '0002', machine: 'L2', workcenter: 'WC2' }]; };
  try {
    const eligibleCurrent = Table._getPairOptions({ PLANT: plant, MACHINE: 'L1', PRODUCTION_VERSION: '0001' });
    assert.deepEqual(eligibleCurrent, [
      { value: '0001|L1', label: '0001 - L1' }, { value: '0002|L2', label: '0002 - L2' }]);
    assert.deepEqual(seenOpts, { requireOps: true }, 'pairs whose routing has no operation at the work center are not offered');

    const ineligibleCurrent = Table._getPairOptions({ PLANT: plant, MACHINE: 'L9', PRODUCTION_VERSION: '0007' });
    assert.deepEqual(ineligibleCurrent[0], { value: '0007|L9', label: '0007 - L9 (current, not eligible)' });
    assert.equal(ineligibleCurrent.length, 3);

    // A distribution sub-order keeps only its locked machine, exactly like _getLineOptions.
    assert.deepEqual(Table._getPairOptions({ PLANT: plant, MACHINE: 'L7', PARENT_ORDER: '9002' }), [{ value: 'L7', label: 'L7' }]);

    // Non-routing plant: today's line list as {value:l,label:l}.
    Store.setMasterData({ ...priorMasterData, plants: [{ plant: 'P-PLAIN', timezone: LOCAL_TZ }] }, 'test');
    const lineList = Table._getLineOptions({ PLANT: 'P-PLAIN', MACHINE: 'L1' });
    assert.deepEqual(Table._getPairOptions({ PLANT: 'P-PLAIN', MACHINE: 'L1' }), lineList.map(l => ({ value: l, label: l })));
  } finally {
    Runtime.eligiblePairs = priorEligiblePairs;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('F1 S1: _getPairOptions on an order holding the unpadded PV "1" selects 0001|M1 and never prefixes a "current" option', () => {
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'ui.pv_machine_option': '{{pv}} - {{machine}}',
    'ui.pv_machine_current_ineligible': '{{pv}} - {{machine}} (current, not eligible{{step}})',
  } };
  const plant = 'P-PAIR-UNPADDED';
  const priorMasterData = _enableRoutingForPlant(plant);
  const priorMap = Runtime._rateMap, priorMapPlant = Runtime._rateMapPlant;
  Runtime._rateMap = { plant, generated_at: '', machines: { M1: 'WC1', M2: 'WC1' },
    pv: { 'MAT|0001': { key: 'MAT|N|G|01', valid_from: null, valid_to: null, workcenter: 'WC1' } },
    ops: { 'MAT|N|G|01|WC1': { minutes_per_unit: 1 } } };
  Runtime._rateMapPlant = plant;
  try {
    const task = { PLANT: plant, MATERIAL_NUMBER: 'MAT', MACHINE: 'M1', PRODUCTION_VERSION: '1', 'ORDER_QUANTITY_(GMEIN)': 60 };
    const options = Table._getPairOptions(task);
    assert.deepEqual(options.map(o => o.value), ['0001|M1', '0001|M2'], 'no unpadded "1|M1" prefix');
    assert.ok(options.every(o => !/not eligible/.test(o.label)));
    // The failing step is named when the current pair really is out.
    const zero = Table._getPairOptions({ ...task, 'ORDER_QUANTITY_(GMEIN)': 0 });
    assert.equal(zero.length, 1);
    assert.match(zero[0].label, /not eligible: zero_runtime/);
    assert.deepEqual(Table._parsePairValue('1|M2'), { pv: '0001', machine: 'M2' }, 'parse output carries the padded PV');
    assert.deepEqual(Table._parsePairValue('|M2'), { pv: '', machine: 'M2' });
  } finally {
    Runtime._rateMap = priorMap; Runtime._rateMapPlant = priorMapPlant;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('F1 S1: re-picking the pair with "0001" on an order storing "1" is a no-op; an Inspector pick of 0004 writes "0004" and keeps the finish', () => {
  const priorTableApi = Table._api;
  const priorToastShow = Toast.show;
  const priorResolve = Runtime.resolve;
  const priorManualSchedule = Engine.manualSchedulePatchFor;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorCurrentId = Inspector._currentId;
  const priorGetElementById = globalThis.document.getElementById;
  const plant = 'P-PV-UNPADDED-EDIT';
  const priorMasterData = _enableRoutingForPlant(plant);
  const toastCalls = [];
  Toast.show = (msg) => { toastCalls.push(msg); };
  Alerts.scheduleRecompute = () => {};
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const undoBefore = UndoStack._entries.length;
  const row = _pairEditFixture('pv-unpadded', plant);
  row.PRODUCTION_VERSION = '1';
  const finish = row.end_date.getTime();
  try {
    row.MACHINE = '0001|L1';
    Table._onCellChanged({ colDef: { field: 'MACHINE' }, data: row, newValue: '0001|L1', oldValue: 'L1', node: {} });
    assert.equal(Store.tasks['pv-unpadded'].MACHINE, 'L1');
    assert.equal(UndoStack._entries.length, undoBefore, 'same pair: no undo entry');
    assert.equal(toastCalls.length, 0, 'same pair: no toast');
    assert.equal(Store.tasks['pv-unpadded'].PRODUCTION_VERSION, '1', 'same pair: nothing written');

    Runtime.resolve = (task) => (task.PRODUCTION_VERSION === '0004'
      ? { ok: true, hours: 1, basis: { workcenter: 'WC1', source: 'routing' } } : { ok: false, step: 'pv_not_found' });
    Engine.manualSchedulePatchFor = (t) => ({ start_date: t.start_date, end_date: new Date(finish), scheduleSegments: [] });
    globalThis.document.getElementById = () => null;
    Inspector._currentId = 'pv-unpadded';
    Inspector._onFieldChange('PV_MACHINE', '0004|L1');
    const task = Store.tasks['pv-unpadded'];
    assert.equal(task.PRODUCTION_VERSION, '0004');
    assert.equal(task.end_date.getTime(), finish, 'the finish is held');
  } finally {
    Table._api = priorTableApi;
    Toast.show = priorToastShow;
    Runtime.resolve = priorResolve;
    Engine.manualSchedulePatchFor = priorManualSchedule;
    Alerts.scheduleRecompute = priorRecompute;
    Inspector._currentId = priorCurrentId;
    globalThis.document.getElementById = priorGetElementById;
    UndoStack._entries.length = undoBefore;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._SearchableLineEditor filters pair options on their label and returns the pair value', () => {
  const priorDocument = globalThis.document;
  const input = { value: '', addEventListener() {}, focus() {}, select() {} };
  const list = { innerHTML: '', querySelectorAll: () => [] };
  const gui = { className: '', innerHTML: '', querySelector: sel => (sel === '.nse-input' ? input : list) };
  globalThis.document = { ...priorDocument, createElement: () => gui };
  try {
    const row = { PRODUCTION_VERSION: '0001', MACHINE: 'L1' };
    let stopped = 0;
    const editor = new Table._SearchableLineEditor();
    editor.init({
      value: 'L1', data: row, api: { stopEditing: () => { stopped++; } },
      values: [{ value: '0001|L1', label: '0001 - L1' }, { value: '0002|L2', label: '0002 - L2' }],
    });
    assert.equal(editor._filtered.length, 2);
    editor._renderList('0002');
    assert.deepEqual(editor._filtered.map(o => o.value), ['0002|L2'], 'filters on the label text');
    editor._renderList('zzz');
    assert.equal(editor._filtered.length, 0);
    // Nothing chosen and nothing typed that matches: the row's own pair comes back, never a bare machine.
    assert.equal(editor.getValue(), '0001|L1');
    editor._renderList('0002');
    editor._choose(0);
    assert.equal(stopped, 1);
    assert.equal(editor.getValue(), '0002|L2');

    // Plain string options (non-routing plants) behave as before.
    const plain = new Table._SearchableLineEditor();
    plain.init({ value: 'L1', api: { stopEditing() {} }, values: ['L1', 'L2'] });
    plain._renderList('l2');
    assert.deepEqual(plain._filtered, [{ value: 'L2', label: 'L2' }]);
    assert.equal(plain.getValue(), 'L1', 'unchanged selection falls back to the cell value');
    plain._choose(0);
    assert.equal(plain.getValue(), 'L2');
  } finally {
    globalThis.document = priorDocument;
  }
});

test('Inspector: a routing plant renders PV read-only and a PV - Machine select; PV_MACHINE writes the pair in one undo step', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const priorResolve = Runtime.resolve;
  const priorPairs = Runtime.eligiblePairs;
  const priorManualSchedule = Engine.manualSchedulePatchFor;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorCurrentId = Inspector._currentId;
  const plant = 'P-INSP-PAIR';
  const priorMasterData = _enableRoutingForPlant(plant);
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  globalThis.document.getElementById = id => (id === 'inspector-body' ? body : null);
  Alerts.scheduleRecompute = () => {};
  Runtime.eligiblePairs = () => [{ pv: '0001', machine: 'L1', workcenter: 'WC1' }, { pv: '0002', machine: 'L2', workcenter: 'WC2' }];
  Runtime.resolve = (task) => (task.PRODUCTION_VERSION === '0002'
    ? { ok: true, hours: 4, basis: { workcenter: 'WC2', source: 'routing' } } : { ok: false, step: 'pv_not_found' });
  const newEnd = new Date('2026-09-20T10:00:00');
  Engine.manualSchedulePatchFor = () => ({ start_date: new Date('2026-09-20T06:00:00'), end_date: newEnd, scheduleSegments: [] });
  const undoBefore = UndoStack._entries.length;
  const row = _pairEditFixture('insp-pair', plant);
  try {
    Inspector._render(row);
    assert.match(body.innerHTML, /data-field="PV_MACHINE"/);
    assert.doesNotMatch(body.innerHTML, /data-field="PRODUCTION_VERSION"/, 'PV is not an input on a routing plant');
    assert.doesNotMatch(body.innerHTML, /data-field="MACHINE"/);
    Inspector._currentId = 'insp-pair';
    Inspector._onFieldChange('PV_MACHINE', '0002|L2');
    const task = Store.tasks['insp-pair'];
    assert.equal(task.PRODUCTION_VERSION, '0002');
    assert.equal(task.MACHINE, 'L2');
    assert.equal(task.RUN_TIME, 4);
    assert.equal(UndoStack._entries.length, undoBefore + 1);
    UndoStack.pop();
    const restored = Store.tasks['insp-pair'];
    assert.equal(restored.PRODUCTION_VERSION, '0001');
    assert.equal(restored.MACHINE, 'L1');
    assert.equal(restored.RUN_TIME, 1);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Runtime.resolve = priorResolve;
    Runtime.eligiblePairs = priorPairs;
    Engine.manualSchedulePatchFor = priorManualSchedule;
    Alerts.scheduleRecompute = priorRecompute;
    Inspector._currentId = priorCurrentId;
    UndoStack._entries.length = undoBefore;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._runTimeEditable (the grid RUN_TIME column\'s editable fn) is true only while the order is held for an unresolved routing runtime', () => {
  const held = { planning_reason: { code: 'runtime_unknown', message: 'x' } };
  const notHeld = { planning_reason: null };
  const otherHold = { planning_reason: { code: 'no_fit_found', message: 'x' } };
  assert.equal(Table._runTimeEditable({ data: held }), true);
  assert.equal(Table._runTimeEditable({ data: notHeld }), false);
  assert.equal(Table._runTimeEditable({ data: otherHold }), false);
});

test('Inspector._render disables the RUN_TIME input unless the order is held for an unresolved routing runtime', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  const heldTask = {
    id: 'routing-runtime-held', ORDER: 'A-9106', PLANT: 'P-DIST', MACHINE: 'L3', RUN_TIME: 0,
    planning_status: 'needs_planning', planning_reason: { code: 'runtime_unknown', message: 'x' },
    start_date: null, end_date: null,
  };
  const scheduledTask = {
    id: 'routing-runtime-scheduled', ORDER: 'A-9107', PLANT: 'P-DIST', MACHINE: 'L3', RUN_TIME: 2,
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
  };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;

    Inspector._render(heldTask);
    let idx = body.innerHTML.indexOf('data-field="RUN_TIME"');
    let tagStart = body.innerHTML.lastIndexOf('<input', idx);
    let tagEnd = body.innerHTML.indexOf('>', idx);
    assert.doesNotMatch(body.innerHTML.slice(tagStart, tagEnd), /\bdisabled\b/, 'RUN_TIME must be editable while held for runtime_unknown');

    Inspector._render(scheduledTask);
    idx = body.innerHTML.indexOf('data-field="RUN_TIME"');
    tagStart = body.innerHTML.lastIndexOf('<input', idx);
    tagEnd = body.innerHTML.indexOf('>', idx);
    assert.match(body.innerHTML.slice(tagStart, tagEnd), /\bdisabled\b/, 'RUN_TIME must be read-only for a normally-scheduled order');
    assert.match(body.innerHTML.slice(tagStart, tagEnd), /title="[^"]+"/);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
  }
});

// Pulled out of schedule-workbench.test.mjs's combined 'EditCalendar/
// ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their
// documented public API' smoke test, which spanned five modules across four
// different new files.
test('Printer exposes the documented public API', () => {
  assert.equal(typeof Printer.open, 'function');
});

test('Printer.exportCsv quotes RFC-4180 fields and formula-guards text cells', async () => {
  const priorDoc = globalThis.document;
  const priorURL = globalThis.URL.createObjectURL;
  const priorRevoke = globalThis.URL.revokeObjectURL;
  const priorRows = Printer._rows;
  let blob = null;
  globalThis.document = { createElement: () => ({ click() {} }) };
  globalThis.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  try {
    Printer._rows = [{
      MACHINE: '=cmd', ORDER: '1001', MATERIAL_NUMBER: '-5',
      MATERIAL_DESCRIPTION: 'Widget, "big"', start_date: null, end_date: null,
    }];
    Printer.exportCsv();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM for Excel');
    const text = await blob.text();
    const row = text.split('\r\n')[1];
    assert.match(row, /^'=cmd,1001,-5,"Widget, ""big""",,,/);
  } finally {
    globalThis.document = priorDoc;
    globalThis.URL.createObjectURL = priorURL;
    globalThis.URL.revokeObjectURL = priorRevoke;
    Printer._rows = priorRows;
  }
});

test('#34 Inspector destroys the previous finish-date Flatpickr on every re-render and on clear (no leak per render)', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const priorFp = Util.fpDatetime;
  const dtInput = { value: '', dataset: { field: 'end_date' } };
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector(sel) { return sel === '[data-field="end_date"]' ? dtInput : null; },
  };
  const task = {
    id: 'fp-leak-1', ORDER: '100010', PLANT: 'P-FP', MACHINE: 'L-FP', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00'),
  };
  let created = 0, destroyed = 0;
  Util.fpDatetime = () => { created++; return { destroy() { destroyed++; } }; };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(task);
    Inspector._render(task);
    Inspector._render(task);
    assert.equal(created, 3);
    assert.equal(destroyed, 2, 'each re-render destroys the instance built for the replaced input');
    Inspector.clear();
    assert.equal(destroyed, 3, 'clearing the inspector destroys the last picker too');
  } finally {
    Util.fpDatetime = priorFp;
    globalThis.document.getElementById = priorGetElementById;
    Inspector._fpEnd = null;
  }
});

test('#35 Printer.exportCsv writes plant-local wall-clock times, not UTC', async () => {
  const priorDoc = globalThis.document;
  const priorURL = globalThis.URL.createObjectURL;
  const priorRevoke = globalThis.URL.revokeObjectURL;
  const priorRows = Printer._rows;
  let blob = null;
  globalThis.document = { createElement: () => ({ click() {} }) };
  globalThis.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  try {
    // Late-evening local time: its UTC rendering is a different calendar day/hour in any non-UTC zone.
    const start = new Date(2026, 7, 14, 23, 30);
    const end = new Date(2026, 7, 15, 1, 45);
    Printer._rows = [{ MACHINE: 'L1', ORDER: '1', MATERIAL_NUMBER: 'M', MATERIAL_DESCRIPTION: 'd', start_date: start, end_date: end }];
    Printer.exportCsv();
    const row = (await blob.text()).split('\r\n')[1];
    assert.ok(row.includes('08/14/2026 23:30'), `start must be local wall clock: ${row}`);
    assert.ok(row.includes('08/15/2026 01:45'), `end must be local wall clock: ${row}`);
  } finally {
    globalThis.document = priorDoc;
    globalThis.URL.createObjectURL = priorURL;
    globalThis.URL.revokeObjectURL = priorRevoke;
    Printer._rows = priorRows;
  }
});

// ---------------------------------------------------------------------------
// Backward scheduling Task 2.5: the finish is the input, the start is derived.
// ---------------------------------------------------------------------------

function placementFixture(plant, nowNaive = '2026-08-03T06:00:00', plantExtras = {}) {
  const priorMaster = Store.masterData;
  const priorApi = Table._api;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorToast = Toast.show;
  const toasts = [];
  Store.setMasterData({ ...priorMaster, plants: [{ plant, timezone: LOCAL_TZ, split_order_policy: 'never', ...plantExtras }], lines: [] }, 'unit-test');
  Store.serverOffsetMs = new Date(nowNaive).getTime() - Date.now();
  Store._blockedPlants.clear();
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  Alerts.scheduleRecompute = () => {};
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  return {
    toasts,
    edit(field, value, task, oldValue) {
      const data = Store.tasks[task];
      const prior = oldValue !== undefined ? oldValue : data[field];
      data[field] = value;
      Table._onCellChanged({ colDef: { field }, data, oldValue: prior, newValue: value, node: {} });
      return Store.tasks[task];
    },
    restore() {
      Store.setMasterData(priorMaster, 'unit-test');
      Table._api = priorApi; Alerts.scheduleRecompute = priorRecompute; Toast.show = priorToast;
      Store.setTasks([], 'unit-test');
    },
  };
}

test('Planned Start is read-only and Planned Finish takes the typed finish (OQ1, OQ16)', () => {
  const [due, start, end] = Table._scheduleDateColumns();
  assert.equal(due.field, 'original_end_date');
  assert.equal(due.headerName, Util.t('col.due_date'));
  assert.equal(due.editable, false, 'the due date is the SAP finish as received and is never typed');
  assert.equal(start.headerName, Util.t('col.planned_start'));
  assert.equal(end.headerName, Util.t('col.planned_finish'));
  assert.equal(start.field, 'start_date');
  assert.equal(start.editable, false, 'the start is derived, so it cannot be typed');
  assert.equal(start.cellEditor, undefined);
  assert.equal(end.field, 'end_date');
  assert.equal(end.editable, true);
  assert.equal(end.cellEditor, Table._DateTimeEditor, 'the End column has its own date-time editor');
});

test('_runtimeEditAnchor returns the FINISH: the placed end, else the due instant of a releasable hold only (OQ7)', () => {
  const end = new Date('2026-09-30T17:00:00');
  assert.equal(Table._runtimeEditAnchor({ start_date: new Date('2026-09-30T13:00:00'), end_date: end }).getTime(), end.getTime());
  const due = new Date('2026-09-30T16:30:00');
  const held = reason => ({ planning_status: 'needs_planning', planning_reason: { code: reason, message: 'x' },
    start_date: null, end_date: null, original_end_date: due });
  for (const reason of ['runtime_unknown', 'overlong_never', 'run_time_over_cap']) {
    assert.equal(Table._runtimeEditAnchor(held(reason)).getTime(), due.getTime(), reason + ' releases at its due instant');
  }
  assert.equal(Table._runtimeEditAnchor(held('setup_missing')), null, 'an unrelated hold stays queued');
  assert.equal(Table._runtimeEditAnchor({ ...held('runtime_unknown'), original_end_date: null }), null, 'no due date: nothing to anchor on');
});

test('a typed End holds that finish and derives the start; an unreachable End restores the cell and says so once', () => {
  const fx = placementFixture('P-TYPED-END');
  try {
    Store.setTasks([{ id: 'typed', PLANT: 'P-TYPED-END', MACHINE: 'L1', RUN_TIME: 4,
      start_date: new Date('2026-08-05T08:00:00'), end_date: new Date('2026-08-05T12:00:00') }], 'unit-test');
    const ok = fx.edit('end_date', new Date('2026-08-05T16:00:00'), 'typed');
    assert.equal(ok.end_date.getTime(), new Date('2026-08-05T16:00:00').getTime());
    assert.equal(ok.start_date.getTime(), new Date('2026-08-05T12:00:00').getTime());
    // 06:00 is before the 07:00 opening: no 4 h slot ends there on that day.
    const refused = fx.edit('end_date', new Date('2026-08-05T06:00:00'), 'typed');
    assert.equal(refused.end_date.getTime(), new Date('2026-08-05T16:00:00').getTime(), 'the cell is restored');
    assert.equal(fx.toasts.filter(t => /finish_cannot_hold/.test(t.msg)).length, 1);
    assert.equal(fx.toasts.filter(t => t.type === 'error').length, 0, 'no second, generic error toast');
  } finally { fx.restore(); }
});

test('S6: a run-time edit holds the finish; on a RUNNING order it holds the start instead (OQ7, OQ3)', () => {
  const fx = placementFixture('P-RUNTIME-EDIT', '2026-08-03T10:00:00');
  try {
    Store.setTasks([
      { id: 'later', PLANT: 'P-RUNTIME-EDIT', MACHINE: 'L1', RUN_TIME: 4,
        user_scheduled: true, start_date: new Date('2026-08-03T14:00:00'), end_date: new Date('2026-08-03T18:00:00') },
      { id: 'running', PLANT: 'P-RUNTIME-EDIT', MACHINE: 'L2', RUN_TIME: 4,
        user_scheduled: true, start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T12:00:00') },
    ], 'unit-test');
    const later = fx.edit('RUN_TIME', 6, 'later');
    assert.equal(later.end_date.getTime(), new Date('2026-08-03T18:00:00').getTime(), 'the finish is held');
    assert.equal(later.start_date.getTime(), new Date('2026-08-03T12:00:00').getTime(), 'the start moves earlier by the extra 2 h');
    assert.equal(later.run_time_source, 'manual');
    assert.equal(Engine.isInProgress(Store.tasks.running), true, 'sanity: 10:00 is inside 08:00-12:00');
    const running = fx.edit('RUN_TIME', 6, 'running');
    assert.equal(running.start_date.getTime(), new Date('2026-08-03T08:00:00').getTime(), 'a running order keeps its start');
    assert.equal(running.end_date.getTime(), new Date('2026-08-03T14:00:00').getTime(), 'the finish follows the new run time');
  } finally { fx.restore(); }
});

test('F1 (gate 4a, OQ7 a GAP06): RUN_TIME typed on a runtime_unknown hold with a past due date places forward from now, late, with a reversal note; a finish that cannot be held is still refused', () => {
  const fx = placementFixture('P-GAP06', '2026-08-05T10:00:00');   // Wednesday 10:00
  try {
    Store.setTasks([
      { id: 'gap06', PLANT: 'P-GAP06', MACHINE: 'L1', RUN_TIME: null, original_end_date: new Date('2026-08-03T18:00:00'),
        start_date: null, end_date: null, scheduleSegments: [],
        planning_status: 'needs_planning', planning_reason: { code: 'runtime_unknown', message: 'x' } },
    ], 'unit-test');
    const placed = fx.edit('RUN_TIME', 6, 'gap06');
    assert.equal(placed.start_date.getTime(), new Date('2026-08-05T10:00:00').getTime(), 'starts at the plant now');
    assert.equal(placed.end_date.getTime(), new Date('2026-08-05T16:00:00').getTime(), 'now + 6 h, 46 h after the due instant');
    assert.deepEqual(placed.derivationIssue, { code: 'reversal_forward', detail: 'due_date_past' });
    assert.equal(placed.planning_status, 'scheduled', 'the hold is released');
    assert.equal(fx.toasts.filter(t => /finish_cannot_hold/.test(t.msg)).length, 0, 'not refused');
    // Other side: a not-started order whose finish sits on a closed stretch is refused, not reversed.
    Store.setTasks([
      { id: 'closed', PLANT: 'P-GAP06', MACHINE: 'L1', RUN_TIME: 2,
        start_date: new Date('2026-08-07T09:00:00'), end_date: new Date('2026-08-07T11:00:00') },
    ], 'unit-test');
    const before = Store.tasks.closed.end_date.getTime();
    const refused = fx.edit('end_date', new Date('2026-08-08T08:00:00'), 'closed', new Date('2026-08-07T11:00:00'));
    assert.equal(refused.end_date.getTime(), before, 'the cell is restored');
    assert.equal(fx.toasts.filter(t => /finish_cannot_hold/.test(t.msg)).length, 1);
  } finally { fx.restore(); }
});

test('F2 (OQ3): a run-time edit on a RUNNING order started off the 15-minute grid keeps the real start under the never policy', () => {
  const fx = placementFixture('P-RUN-OFFGRID', '2026-08-03T10:12:00');
  try {
    Store.setTasks([
      { id: 'running', PLANT: 'P-RUN-OFFGRID', MACHINE: 'L1', RUN_TIME: 4,
        user_scheduled: true, start_date: new Date('2026-08-03T10:08:00'), end_date: new Date('2026-08-03T14:08:00') },
    ], 'unit-test');
    // The store snaps incoming starts to the grid; a derived start is off-grid, so set the real one directly.
    Store.tasks.running.start_date = new Date('2026-08-03T10:08:00');
    Store.tasks.running.end_date = new Date('2026-08-03T14:08:00');
    assert.equal(Engine.isInProgress(Store.tasks.running), true, 'sanity: 10:12 is inside the bar');
    const running = fx.edit('RUN_TIME', 6, 'running');
    assert.equal(running.start_date.getTime(), new Date('2026-08-03T10:08:00').getTime(), 'the real start is kept, not snapped to 10:15');
    assert.equal(running.end_date.getTime(), new Date('2026-08-03T16:08:00').getTime());
    assert.equal(Engine.isInProgress(Store.tasks.running), true, 'it is still running');
  } finally { fx.restore(); }
});

test('S7: a machine edit on a queued overlong order releases ONE continuous elapsed bar ending at the due instant, marked overlong; a later run-time shrink leaves the bar (OQ50, Review Focus 5)', () => {
  const fx = placementFixture('P-OVERLONG');
  try {
    const due = new Date('2026-08-26T17:00:00');
    Store.setTasks([{ id: 'ovl', PLANT: 'P-OVERLONG', MACHINE: 'L1', RUN_TIME: 20, original_end_date: due,
      start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning',
      planning_reason: { code: 'overlong_never', message: 'x' } }], 'unit-test');
    const released = fx.edit('MACHINE', 'L2', 'ovl', 'L1');
    assert.equal(released.planning_status, 'scheduled');
    assert.equal(released.planning_reason, null);
    assert.equal(released.end_date.getTime(), due.getTime(), 'the bar ends at the due instant');
    assert.equal(released.end_date.getTime() - released.start_date.getTime(), 20 * 3600 * 1000, 'one continuous bar as wide as the run time, calendar ignored');
    assert.deepEqual(released.scheduleSegments, []);
    assert.equal(released.placement_exception, 'overlong');

    const shrunk = fx.edit('RUN_TIME', 5, 'ovl');
    assert.equal(shrunk.RUN_TIME, 5);
    assert.equal(shrunk.end_date.getTime(), due.getTime(), 'the marked bar is left alone');
    assert.equal(shrunk.end_date.getTime() - shrunk.start_date.getTime(), 20 * 3600 * 1000);
    assert.equal(shrunk.placement_exception, 'overlong', 'the marker stays until a planner clears it');
  } finally { fx.restore(); }
});

test('a queued run_time_over_cap order releases through the ordinary finish-anchored path (no marker)', () => {
  const fx = placementFixture('P-OVERCAP');
  try {
    const due = new Date('2026-08-26T17:00:00');
    Store.setTasks([{ id: 'cap', PLANT: 'P-OVERCAP', MACHINE: 'L1', RUN_TIME: 4, original_end_date: due,
      start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning',
      planning_reason: { code: 'run_time_over_cap', message: 'x' } }], 'unit-test');
    const released = fx.edit('MACHINE', 'L2', 'cap', 'L1');
    assert.equal(released.planning_status, 'scheduled');
    assert.equal(released.end_date.getTime(), due.getTime());
    assert.equal(released.start_date.getTime(), new Date('2026-08-26T13:00:00').getTime());
    assert.ok(!released.placement_exception);
  } finally { fx.restore(); }
});

test('OQ63: a firmed order typed outside working hours asks to confirm, then stores the overtime marker; declining restores the cell', async () => {
  const fx = placementFixture('P-OVERTIME-GRID');
  const priorConfirm = Engine.confirmOvertimePlacement;
  let answer = false;
  Engine.confirmOvertimePlacement = async () => answer;
  try {
    Store.setTasks([{ id: 'ot', PLANT: 'P-OVERTIME-GRID', MACHINE: 'L1', RUN_TIME: 4,
      start_date: new Date('2026-08-05T08:00:00'), end_date: new Date('2026-08-05T12:00:00') }], 'unit-test');
    Store.setFirmed(['ot'], true, 'unit-test');
    const late = new Date('2026-08-05T22:00:00');   // closes at 19:00
    let row = fx.edit('end_date', late, 'ot');
    assert.equal(row.end_date.getTime(), new Date('2026-08-05T12:00:00').getTime(), 'the cell is restored while the question is open');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Store.tasks.ot.end_date.getTime(), new Date('2026-08-05T12:00:00').getTime(), 'declined: nothing stored');
    assert.ok(!Store.tasks.ot.placement_exception);

    answer = true;
    fx.edit('end_date', late, 'ot');
    await new Promise(resolve => setImmediate(resolve));
    row = Store.tasks.ot;
    assert.equal(row.end_date.getTime(), late.getTime());
    assert.equal(row.start_date.getTime(), new Date('2026-08-05T18:00:00').getTime(), 'raw placement: finish minus the run time');
    assert.equal(row.placement_exception, 'overtime');
    assert.equal(fx.toasts.filter(t => t.type === 'error' || /finish_cannot_hold/.test(t.msg)).length, 0);
  } finally { Engine.confirmOvertimePlacement = priorConfirm; fx.restore(); }
});

test('Table.applyOverride writes the FINISH from the dialog and derives the start (OQ1)', () => {
  const fx = placementFixture('P-OVERRIDE-FINISH');
  const priorGetElementById = globalThis.document.getElementById;
  const priorSelectedId = Table._selectedId;
  const elements = { 'ovr-finish': { value: '2026-08-26 15:00' }, 'ovr-line': { value: 'L1' }, 'ovr-firm': { checked: false } };
  globalThis.document.getElementById = id => elements[id] || null;
  try {
    Store.setTasks([{ id: 'ovr', PLANT: 'P-OVERRIDE-FINISH', MACHINE: 'L1', RUN_TIME: 2,
      start_date: new Date('2026-08-25T08:00:00'), end_date: new Date('2026-08-25T10:00:00') }], 'unit-test');
    Table._selectedId = 'ovr';
    Table.applyOverride();
    assert.equal(Store.tasks.ovr.end_date.getTime(), new Date('2026-08-26T15:00:00').getTime(), 'the dialog value is the finish');
    assert.equal(Store.tasks.ovr.start_date.getTime(), new Date('2026-08-26T13:00:00').getTime(), 'the start is derived from it');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Table._selectedId = priorSelectedId;
    fx.restore();
  }
});

test('a typed End on an order carrying a marker translates the bar by the delta and keeps its width (grid and Inspector)', () => {
  const fx = placementFixture('P-MARKED-END');
  const priorId = Inspector._currentId;
  const priorRender = Inspector._render;
  try {
    const start = new Date('2026-08-05T08:00:00');
    const end = new Date('2026-08-09T08:00:00');   // 96 h wide, run time 5 h
    Store.setTasks([{ id: 'mk', PLANT: 'P-MARKED-END', MACHINE: 'L1', RUN_TIME: 5, placement_exception: 'overlong',
      start_date: start, end_date: end }], 'unit-test');
    const row = fx.edit('end_date', new Date('2026-08-12T08:00:00'), 'mk');
    assert.equal(row.end_date.getTime(), new Date('2026-08-12T08:00:00').getTime());
    assert.equal(row.start_date.getTime(), new Date('2026-08-08T08:00:00').getTime(), 'start moved by the same 3 days');
    assert.equal(row.end_date.getTime() - row.start_date.getTime(), 96 * 3600 * 1000, 'width kept, not stretched');
    assert.equal(row.placement_exception, 'overlong');

    Inspector._render = () => {};
    Inspector._currentId = 'mk';
    Inspector._onFieldChange('end_date', '2026-08-15 08:00');
    const after = Store.tasks.mk;
    assert.equal(after.end_date.getTime() - after.start_date.getTime(), 96 * 3600 * 1000, 'Inspector path translates too');
    assert.equal(after.end_date.getTime(), new Date('2026-08-15T08:00:00').getTime());
  } finally { Inspector._currentId = priorId; Inspector._render = priorRender; fx.restore(); }
});

test('OQ42: the date-chip Today/Tomorrow presets are the plant\'s days, not the viewer\'s, near midnight', () => {
  const priorGet = globalThis.document.getElementById;
  const priorOffset = Store.serverOffsetMs;
  const priorSelected = Store.selectedPlant;
  const drop = { innerHTML: '' };
  globalThis.document.getElementById = id => id === 'tbl-flt-date-dropdown' ? drop : null;
  Store.setMasterData({ plants: [
    { plant: 'P-EAST', timezone: 'Pacific/Kiritimati' },   // UTC+14
    { plant: 'P-WEST', timezone: 'Etc/GMT+12' },            // UTC-12
  ], lines: [] }, 'unit-test');
  Store.setServerNow('2026-10-15T10:00:00Z', Date.now());
  const presets = () => [...drop.innerHTML.matchAll(/name="tbl-flt-date" value="(\d{4}-\d\d-\d\d)"/g)].map(m => m[1]);
  try {
    Store.setSelectedPlant('P-EAST', 'unit-test');
    Table._buildDateChipDropdown();
    assert.deepEqual(presets(), ['2026-10-16', '2026-10-17'], 'plant clock is Fri 00:00');
    Store.setSelectedPlant('P-WEST', 'unit-test');
    Table._buildDateChipDropdown();
    assert.deepEqual(presets(), ['2026-10-14', '2026-10-15'], 'plant clock is Wed 22:00');
  } finally {
    globalThis.document.getElementById = priorGet;
    Store.serverOffsetMs = priorOffset;
    Store.setSelectedPlant(priorSelected, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Backward scheduling Task 3.4: Due Date and Planned Start are read-only, Planned Finish is the editable date.
// ---------------------------------------------------------------------------

test('the Due Date column shows the due instant (a date-only SAP finish reads as the close of that day), not the raw midnight', () => {
  const [due] = Table._scheduleDateColumns();
  const task = { id: 'due-col', MACHINE: 'L1', original_end_date: new Date('2026-08-04T09:00:00') };
  assert.equal(due.valueGetter({ data: task }).getTime(), Util.dueInstant(task).getTime());
  assert.equal(due.valueGetter({ data: { id: 'x', MACHINE: 'L1' } }), null, 'no SAP finish, no value');
});

test('the Due Date column shows the due DAY for a date-only due on a 24:00-close line, not the exclusive next-day 00:00 (R-I6 display)', async () => {
  const prevCore = globalThis.NimbusComputeCore;
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  const hours = { 0: [6, 24], 1: [6, 24], 2: [6, 24], 3: [6, 24], 4: [6, 24], 5: [6, 24], 6: [6, 24] };
  const early = { 0: [6, 22], 1: [6, 22], 2: [6, 22], 3: [6, 22], 4: [6, 22], 5: [6, 22], 6: [6, 22] };
  let current = hours;
  Util.setDueCalendarResolver(line => (line === 'L24' ? { lineHours: current, plantHours: current, plant: 'P24', rev: current === hours ? 1 : 2 } : null));
  try {
    const [due] = Table._scheduleDateColumns();
    const task = { id: 'due-24', MACHINE: 'L24', original_end_date: new Date(2026, 7, 5) };       // Wed 5 Aug, date-only
    const value = due.valueGetter({ data: task });
    assert.equal(+value, +new Date(2026, 7, 6, 0, 0, 0), 'the grid value (sort/filter) stays the exact instant');
    assert.equal(Util.dueDisplayDate(task).getTime(), new Date(2026, 7, 6, 0, 0, 0).getTime() - 1);
    const text = due.valueFormatter({ value, data: task });
    assert.equal(text, Util.fmtDTReadable(new Date(2026, 7, 5, 23, 59, 59, 999)), 'the cell text is the due day');
    assert.ok(!text.includes('00:00'), 'never "Thu 00:00"');
    // A date-only due closing earlier in the day, and a timed due, are untouched.
    current = early;
    assert.equal(+Util.dueDisplayDate(task), +new Date(2026, 7, 5, 22, 0, 0));
    const timed = { id: 'due-timed', MACHINE: 'L24', original_end_date: new Date(2026, 7, 5, 9, 30) };
    assert.equal(+Util.dueDisplayDate(timed), +new Date(2026, 7, 5, 9, 30));
  } finally { Util.setDueCalendarResolver(null); globalThis.NimbusComputeCore = prevCore; }
});

test('the retired Original Start column is gone from the grid and the field catalog; the wire field stays on the task', () => {
  assert.ok(!ORDER_FIELD_CATALOG.some(f => f.key === 'original_start_date'), 'catalog entry removed');
  assert.ok(!Table._catalogOnlyColumns().some(c => c.field === 'original_start_date'));
  assert.ok(!Table._scheduleDateColumns().some(c => c.field === 'original_start_date'));
  assert.equal(ORDER_FIELD_CATALOG.find(f => f.key === 'original_end_date').i18nGridKey, 'col.due_date');
});

test('G-0.27: an admin visibility choice naming the retired column is ignored, not an error', () => {
  const priorVisibility = structuredClone(Store.orderFieldVisibility);
  const priorApi = Table._api;
  const calls = [];
  try {
    Store.setOrderFieldVisibility({ ...priorVisibility, original_start_date: { grid: false, inspector: false } }, 'unit-test');
    assert.equal(Table._fieldHidden('original_start_date'), false, 'an unknown id is never hidden');
    assert.equal(Table._fieldHidden('no_such_column'), false);
    Table._api = { setColumnsVisible: (ids, visible) => calls.push({ ids, visible }) };
    Table._applyFieldVisibility();
    assert.ok(calls.every(c => !c.ids.includes('original_start_date')), 'the retired id never reaches the grid');
  } finally {
    Table._api = priorApi;
    Store.setOrderFieldVisibility(priorVisibility, 'unit-test');
  }
});

test('G-0.27: a saved layout naming the retired Original Start column loads; the unknown column is dropped', () => {
  const priorApi = Table._api;
  const priorPref = Store.pref;
  let applied = null, filter = null;
  const known = new Set(['PRODUCTION_ORDER', 'end_date']);
  Store.pref = key => key === 'gridLayout' ? {
    columnState: [{ colId: 'PRODUCTION_ORDER' }, { colId: 'original_start_date', hide: true }, { colId: 'end_date', sort: 'asc' }],
    sortModel: null,
    filterModel: { original_start_date: { type: 'equals' }, end_date: { type: 'equals' } },
  } : priorPref.call(Store, key);
  Table._api = {
    getColumn: id => known.has(id) ? { id } : null,
    applyColumnState: arg => { applied = arg; },
    setFilterModel: model => { filter = model; },
  };
  try {
    Table._applySavedLayout();
    assert.deepEqual(applied.state.map(c => c.colId), ['PRODUCTION_ORDER', 'end_date']);
    assert.deepEqual(Object.keys(filter), ['end_date']);
  } finally {
    Table._api = priorApi;
    Store.pref = priorPref;
  }
});

test('the variance badge is planned finish minus the due instant, in hours with one decimal (due Tue 09:00, 6 h, finish Tue 09:00 -> 0.0h)', () => {
  const task = { id: 'var-1', MACHINE: 'L1', RUN_TIME: 6,
    original_end_date: new Date('2026-08-04T09:00:00'),
    start_date: new Date('2026-08-04T03:00:00'), end_date: new Date('2026-08-04T09:00:00') };
  const text = badge => badge.replace(/<[^>]+>/g, '');
  assert.equal(text(Inspector._varianceBadge(task)), '0.0h');
  assert.equal(text(Inspector._varianceBadge({ ...task, end_date: new Date('2026-08-04T11:00:00') })), '+2.0h');
  assert.equal(text(Inspector._varianceBadge({ ...task, end_date: new Date('2026-08-04T07:30:00') })), '-1.5h');
  assert.match(Inspector._varianceBadge({ ...task, end_date: new Date('2026-08-04T11:00:00') }), /insp-var-late/);
  assert.match(Inspector._varianceBadge({ ...task, end_date: new Date('2026-08-04T07:30:00') }), /insp-var-early/);
  assert.equal(text(Inspector._varianceBadge({ ...task, end_date: new Date('2026-08-07T09:00:00') })), '+72.0h', 'hours, never days');
  assert.equal(Inspector._varianceBadge({ ...task, end_date: null }), '', 'unplaced: nothing to compare');
  assert.equal(Inspector._varianceBadge({ ...task, original_end_date: null }), '', 'no due date: nothing to compare');
  assert.match(Inspector._varianceBadge(task), /title="[^"]+"/);
});

test('the Inspector shows Planned Finish as the one editable date; Due Date and Planned Start are read-only text', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  try {
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render({
      id: 'insp-dates', ORDER: '100020', MACHINE: 'L1', RUN_TIME: 6,
      original_end_date: new Date('2026-08-04T09:00:00'),
      start_date: new Date('2026-08-04T03:00:00'), end_date: new Date('2026-08-04T09:00:00'),
    });
    const html = body.innerHTML;
    assert.match(html, /ui\.insp_due_date/);
    assert.match(html, /ui\.insp_planned_start/);
    assert.match(html, /ui\.insp_planned_finish/);
    assert.doesNotMatch(html, /ui\.insp_orig_|ui\.insp_updated_/, 'the old labels are gone');
    assert.doesNotMatch(html, /data-field="start_date"/, 'the start is not an input');
    assert.match(html, /<input type="text" data-field="end_date"/);
    assert.equal((html.match(/data-field="end_date"/g) || []).length, 1);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Inspector._fpEnd = null;
  }
});

test('the Inspector explains a system move from derivationIssue first, then systemMove; nothing when neither exists', () => {
  const from = new Date('2026-08-04T09:00:00'), to = new Date('2026-08-04T07:00:00');
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'ui.insp_system_move': 'moved|{{reason}}',
    'ui.insp_move_reason_finish_moved_earlier': 'REASON-ISSUE',
    'ui.insp_move_reason_run_time_changed': 'REASON-MOVE',
    'ui.insp_move_reason_cutover': 'REASON-CUTOVER',
  } };
  try {
    assert.equal(Inspector._systemMoveLine({ id: 'm0' }), '');
    assert.equal(Inspector._systemMoveLine({ id: 'm0', derivationIssue: { code: 'plant_no_timezone' } }), '', 'a note that is not a move says nothing here');
    const issue = Inspector._systemMoveLine({ id: 'm1', derivationIssue: { code: 'finish_moved_earlier', from, to },
      systemMove: { from: new Date('2026-08-01T00:00:00'), to: new Date('2026-08-02T00:00:00'), reason: 'cutover' } });
    assert.equal(issue, 'moved|REASON-ISSUE', 'the issue wins over the move record');
    const moved = Inspector._systemMoveLine({ id: 'm2', systemMove: { from, to, reason: 'run_time_changed' } });
    assert.equal(moved, 'moved|REASON-MOVE');
  } finally { globalThis.window.__NIMBUS_LOCALES = priorLocales; }
});

test('G3: every keyboard-reachable date edit reaches the same finish-anchored patch as a drag (the third argument is the finish)', () => {
  const fx = placementFixture('P-KEYBOARD');
  const priorPatch = Engine.manualRoutingSchedulePatchFor;
  const calls = [];
  Engine.manualRoutingSchedulePatchFor = (task, line, finish, opts) => {
    calls.push({ line, finish });
    return priorPatch.call(Engine, task, line, finish, opts);
  };
  try {
    Store.setTasks([{ id: 'kb', PLANT: 'P-KEYBOARD', MACHINE: 'L1', RUN_TIME: 4,
      start_date: new Date('2026-08-05T08:00:00'), end_date: new Date('2026-08-05T12:00:00') }], 'unit-test');
    // Grid cell editor (Tab / F2 / Enter reach it from the keyboard).
    fx.edit('end_date', new Date('2026-08-05T16:00:00'), 'kb');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].finish instanceof Date);
    assert.equal(calls[0].finish.getTime(), new Date('2026-08-05T16:00:00').getTime());
    // Inspector Planned Finish input.
    Inspector._currentId = 'kb';
    Inspector._onFieldChange('end_date', '2026-08-05 18:00');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].finish.getTime(), new Date('2026-08-05T18:00:00').getTime());
    assert.equal(Store.tasks.kb.start_date.getTime(), new Date('2026-08-05T14:00:00').getTime(), 'both edges come back from the one derivation');
  } finally {
    Engine.manualRoutingSchedulePatchFor = priorPatch;
    Inspector._currentId = null;
    fx.restore();
  }
});

test('Printer range = overlap: an order that started before the range and ends inside it is listed (OQ43 a)', () => {
  const rows = Printer._rowsInRange([
    { id: 'before', start_date: new Date('2026-08-01T08:00:00'), end_date: new Date('2026-08-01T12:00:00') },
    { id: 'spans-in', start_date: new Date('2026-08-02T22:00:00'), end_date: new Date('2026-08-03T02:00:00') },
    { id: 'inside', start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T12:00:00') },
    { id: 'spans-out', start_date: new Date('2026-08-03T22:00:00'), end_date: new Date('2026-08-04T04:00:00') },
    { id: 'after', start_date: new Date('2026-08-04T08:00:00'), end_date: new Date('2026-08-04T12:00:00') },
    { id: 'queued', start_date: null, end_date: null },
  ], new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
  assert.deepEqual(rows.map(r => r.id), ['spans-in', 'inside', 'spans-out']);
});

test('the override dialog takes its "Line" label from the locale layer, not hardcoded English', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const els = { 'ovr-order': { textContent: '' }, 'ovr-line': { innerHTML: '', value: '' }, 'ovr-firm': { checked: false } };
  const priorFp = Util.fpDatetime;
  const priorOpen = Modal.open;
  const priorFpInst = Table._fpOvrFinish;
  Util.fpDatetime = () => ({ setDate() {}, destroy() {} });
  Modal.open = () => {};
  Table._fpOvrFinish = null;
  globalThis.document.getElementById = id => els[id] || null;
  try {
    Store.setTasks([{ id: 'ovr-copy', ORDER: '9001', MACHINE: 'L1', PLANT: 'P-COPY', RUN_TIME: 1,
      start_date: new Date('2026-08-05T08:00:00'), end_date: new Date('2026-08-05T09:00:00') }], 'unit-test');
    Table._openOverrideModalForId('ovr-copy');
    assert.ok(els['ovr-order'].textContent.includes(Util.t('ui.insp_line')), 'the "Line" label comes from the locale layer');
    assert.doesNotMatch(els['ovr-order'].textContent, /Line:/);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Util.fpDatetime = priorFp; Modal.open = priorOpen; Table._fpOvrFinish = priorFpInst;
    Store.setTasks([], 'unit-test');
  }
});

test('W2: Inspector names the predecessor order from the schedule, with or without a setup definition', () => {
  const plant = 'W2-PRED-PLANT';
  const line = 'W2-PRED-LINE';
  const state = value => [{ fieldKey: 'colorWheel', value }];
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSetup = Store.setupSnapshot;
  const priorGetElementById = globalThis.document.getElementById;
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  const mk = (id, order, startHour, extra = {}) => ({ id, ORDER: order, PLANT: plant, MACHINE: line, RUN_TIME: 1, COLOR: 'RED',
    start_date: new Date(`2026-08-21T${String(startHour).padStart(2, '0')}:00:00`),
    end_date: new Date(`2026-08-21T${String(startHour + 1).padStart(2, '0')}:00:00`), ...extra });
  const first = mk('w2-first', '700001', 8);
  const second = mk('w2-second', '700002', 10);
  const other = { ...mk('w2-other-line', '700003', 9), MACHINE: 'W2-OTHER-LINE' };
  Store.setTasks([first, second, other], 'unit-test');
  const body = { innerHTML: '', querySelectorAll() { return []; }, querySelector() { return null; } };
  try {
    // No setup snapshot at all: the predecessor is still named, the state rows stay empty.
    Store.replaceSetupSnapshot(null, 'unit-test');
    let detail = Inspector._setupDetailForTask(second);
    assert.equal(detail.predecessorOrderId, 'w2-first');
    assert.equal(detail.predecessorState, null);
    globalThis.document.getElementById = id => id === 'inspector-body' ? body : null;
    Inspector._render(second);
    const panel = body.innerHTML.slice(body.innerHTML.indexOf('ui.setup_detail_title'));
    assert.match(panel, />700001</, 'the predecessor renders as its order number, not the raw task id');
    assert.doesNotMatch(panel, /w2-first/);

    // First on machine: no predecessor id, and the first-on-machine label instead of a dash.
    detail = Inspector._setupDetailForTask(first);
    assert.equal(detail.predecessorOrderId, null);
    Inspector._render(first);
    assert.match(body.innerHTML.slice(body.innerHTML.indexOf('ui.setup_detail_title')), /First on machine/);

    // A zero-minute matrix transition yields no setup interval, but the predecessor is still shown.
    Store.replaceSetupSnapshot({
      plant,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true }, plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1, from_key: state('RED'), to_key: state('BLUE'), setup_min: 0 }],
      machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');
    const blue = mk('w2-blue', '700004', 12, { COLOR: 'BLUE' });
    Store.setTasks([first, second, other, blue], 'unit-test');
    detail = Inspector._setupDetailForTask(blue);
    assert.equal(detail.predecessorOrderId, 'w2-second');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('W2: a split order is one span, so it is never its own predecessor', () => {
  const plant = 'W2-SPLIT-PLANT';
  const line = 'W2-SPLIT-LINE';
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  Store.setSelectedPlant(plant, 'unit-test');
  const at = (day, hour) => new Date(`2026-08-${day}T${String(hour).padStart(2, '0')}:00:00`);
  const split = { id: 'w2-split', ORDER: '710001', PLANT: plant, MACHINE: line, RUN_TIME: 2,
    start_date: at(21, 8), end_date: at(22, 10),
    scheduleSegments: [
      { sequence: 1, startDate: at(21, 8), endDate: at(21, 9) },
      { sequence: 2, startDate: at(22, 9), endDate: at(22, 10) },
    ] };
  const after = { id: 'w2-after', ORDER: '710002', PLANT: plant, MACHINE: line, RUN_TIME: 1,
    start_date: at(22, 12), end_date: at(22, 13) };
  Store.setTasks([split, after], 'unit-test');
  try {
    assert.equal(Inspector._setupDetailForTask(split).predecessorOrderId, null);
    assert.equal(Inspector._setupDetailForTask(after).predecessorOrderId, 'w2-split');
  } finally {
    globalThis.NimbusComputeCore = priorCore;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('profile status filter keeps only orders in the active profile match set and re-applies when the producer fires', () => {
  const prior = Table._chipFilters, priorApi = Table._api;
  const priorCurrent = AlertProfileMatches.current;
  try {
    Table._chipFilters = { lines: new Set(), colors: new Set(), status: 'profile', dateKey: null, poMat: new Set() };
    AlertProfileMatches.current = () => ({ taskIds: new Set(['a']) });
    assert.equal(Table._taskPassesChipFilters({ id: 'a', MACHINE: 'L1' }), true);
    assert.equal(Table._taskPassesChipFilters({ id: 'b', MACHINE: 'L1' }), false);
    let calls = 0;
    Table._api = { onFilterChanged: () => { calls += 1; }, getFilterModel: () => ({}), getDisplayedRowCount: () => 0 };
    Table._wireProfileMatches();
    Table._wireProfileMatches();   // idempotent
    AlertProfileMatches.recompute();
    assert.equal(calls, 1, 'one subscription, one re-filter');
    Table._chipFilters.status = 'late';
    AlertProfileMatches.recompute();
    assert.equal(calls, 1, 'no re-filter while another status is active');
  } finally { Table._unwireProfileMatches(); Table._chipFilters = prior; Table._api = priorApi; AlertProfileMatches.current = priorCurrent; }
});

test('profile status option is disabled with its description under All alerts, enabled under a real profile; All alerts drops an active profile filter', () => {
  const prior = Table._chipFilters, priorApi = Table._api, priorCurrent = AlertProfileMatches.current;
  const drop = { innerHTML: '' };
  const priorDoc = globalThis.document;
  globalThis.document = { getElementById: id => (id === 'tbl-flt-status-dropdown' ? drop : null) };
  try {
    Table._chipFilters = { lines: new Set(), colors: new Set(), status: null, dateKey: null, poMat: new Set() };
    AlertProfileMatches.current = () => ({ profileId: '__all__', taskIds: new Set() });
    Table._buildStatusChipDropdown();
    const row = h => h.split('</label>').find(r => r.includes('value="profile"'));
    assert.match(row(drop.innerHTML), /value="profile"[^>]*disabled/);
    assert.match(row(drop.innerHTML), /tbl\.status_profile_desc|Orders carrying an alert/);
    AlertProfileMatches.current = () => ({ profileId: 'p1', taskIds: new Set() });
    Table._buildStatusChipDropdown();
    assert.doesNotMatch(row(drop.innerHTML), /disabled/);
    // active 'profile' filter, then the profile switches to All alerts
    Table._chipFilters.status = 'profile';
    let calls = 0;
    Table._api = { onFilterChanged: () => { calls += 1; }, getFilterModel: () => ({}), getDisplayedRowCount: () => 0 };
    Table._wireProfileMatches();
    AlertProfileMatches.current = () => ({ profileId: '__all__', taskIds: new Set() });
    AlertProfileMatches.recompute();
    assert.equal(Table._chipFilters.status, null);
    assert.equal(calls, 1);
  } finally { Table._unwireProfileMatches(); Table._chipFilters = prior; Table._api = priorApi; AlertProfileMatches.current = priorCurrent; globalThis.document = priorDoc; }
});

test('the status dropdown is rebuilt only when the profile filter flips between disabled and enabled', () => {
  const prior = Table._chipFilters, priorApi = Table._api, priorCurrent = AlertProfileMatches.current, priorBuild = Table._buildStatusChipDropdown;
  let builds = 0;
  try {
    Table._chipFilters = { lines: new Set(), colors: new Set(), status: 'late', dateKey: null, poMat: new Set() };
    Table._api = { onFilterChanged() {}, getFilterModel: () => ({}), getDisplayedRowCount: () => 0 };
    Table._buildStatusChipDropdown = () => { builds += 1; };
    Table._profileOffSeen = null;
    AlertProfileMatches.current = () => ({ profileId: 'p1', taskIds: new Set() });
    Table._wireProfileMatches();
    AlertProfileMatches.recompute();
    assert.equal(builds, 1, 'first fanout builds once');
    AlertProfileMatches.recompute(); AlertProfileMatches.recompute();
    assert.equal(builds, 1, 'nothing flipped: no rebuild on later fanouts');
    AlertProfileMatches.current = () => ({ profileId: '__all__', taskIds: new Set() });
    AlertProfileMatches.recompute();
    assert.equal(builds, 2, 'the disabled state flipped: rebuild');
    AlertProfileMatches.recompute();
    assert.equal(builds, 2);
  } finally {
    Table._unwireProfileMatches(); Table._buildStatusChipDropdown = priorBuild; Table._profileOffSeen = null;
    Table._chipFilters = prior; Table._api = priorApi; AlertProfileMatches.current = priorCurrent;
  }
});

function _overrideFixture(lineValue) {
  const elements = {
    'ovr-finish': { value: '2026-09-21 10:00' },
    'ovr-line': { value: lineValue },
    'ovr-firm': { checked: false },
  };
  const prior = globalThis.document.getElementById;
  globalThis.document.getElementById = id => elements[id] || null;
  return () => { globalThis.document.getElementById = prior; };
}

test('Table.applyOverride with a PV - Machine pair: writes the pair, pushes one undo entry; an ineligible pair is rejected with the pair toast; the PARENT_ORDER lock still rejects', () => {
  const priorTableApi = Table._api;
  const priorEligible = Runtime.eligible;
  const priorPair = Engine.pairSchedulePatchFor;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorToastShow = Toast.show;
  const priorSelectedId = Table._selectedId;
  const priorLocales = globalThis.window && globalThis.window.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'toast.pv_machine_ineligible': '{{order}} cannot run on {{machine}} with {{pv}}.',
    'toast.dist_machine_locked': '{{order}} runs on {{machine}} because of its distribution.',
  } };
  const plant = 'P-ROUTING-OVR-PAIR';
  const priorMasterData = _enableRoutingForPlant(plant);
  Alerts.scheduleRecompute = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const undoBefore = UndoStack._entries.length;
  const newStart = new Date('2026-09-21T08:00:00');
  const newEnd = new Date('2026-09-21T10:00:00');
  Runtime.eligible = (task, machine) => task.PRODUCTION_VERSION === '0002' && machine === 'L2';
  let pairArgs = null;
  Engine.pairSchedulePatchFor = (task, pv, line) => {
    pairArgs = { pv, line };
    return { start_date: newStart, end_date: newEnd, PRODUCTION_VERSION: pv, MACHINE: line, RUN_TIME: 2, run_time_source: 'routing' };
  };
  _pairEditFixture('ovr-pair', plant);
  Table._selectedId = 'ovr-pair';

  try {
    // 1. ineligible pair: toast, nothing written, no undo entry
    let restore = _overrideFixture('0003|L2');
    try { Table.applyOverride(); } finally { restore(); }
    assert.equal(Store.tasks['ovr-pair'].MACHINE, 'L1');
    assert.equal(Store.tasks['ovr-pair'].PRODUCTION_VERSION, '0001');
    assert.equal(pairArgs, null);
    assert.equal(toastCalls.length, 1);
    assert.match(toastCalls[0].msg, /A-9104.*L2.*0003/);
    assert.equal(UndoStack._entries.length, undoBefore);

    // 2. eligible pair: one patch, one undo entry
    toastCalls.length = 0;
    restore = _overrideFixture('0002|L2');
    try { Table.applyOverride(); } finally { restore(); }
    assert.deepEqual(pairArgs, { pv: '0002', line: 'L2' });
    assert.equal(Store.tasks['ovr-pair'].MACHINE, 'L2');
    assert.equal(Store.tasks['ovr-pair'].PRODUCTION_VERSION, '0002');
    assert.equal(UndoStack._entries.length, undoBefore + 1, 'the pair override is one undo step');

    // 3. sub-order lock still wins over a pair
    Store.setTasks([{
      id: 'ovr-child', PRODUCTION_ORDER: 'A-9301', ORDER: 'A-9301', PLANT: plant, PARENT_ORDER: '9301', MACHINE: 'L1',
      PRODUCTION_VERSION: '0002', start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
    }], 'test');
    Table._selectedId = 'ovr-child';
    toastCalls.length = 0;
    pairArgs = null;
    restore = _overrideFixture('0002|L2');
    try { Table.applyOverride(); } finally { restore(); }
    assert.equal(Store.tasks['ovr-child'].MACHINE, 'L1');
    assert.equal(pairArgs, null);
    assert.equal(toastCalls.length, 1);
    assert.match(toastCalls[0].msg, /A-9301/);
  } finally {
    Table._api = priorTableApi;
    Runtime.eligible = priorEligible;
    Engine.pairSchedulePatchFor = priorPair;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Toast.show = priorToastShow;
    Table._selectedId = priorSelectedId;
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
    UndoStack._entries.length = undoBefore;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

// ---- Inspector History (schedule_event) -------------------------------------------------------------
const histT = (key, vars) => {
  const en = { 'ui.history_yes': 'Yes', 'ui.history_no': 'No', 'ui.history_op_create': 'Created', 'ui.history_op_remove': 'Removed',
    'ui.history_carried_from': 'Carried from {{id}}', 'ui.history_field_machine': 'Machine', 'ui.history_field_manual_firmed': 'Firmed',
    'ui.history_field_planning_status': 'Planning status', 'ui.history_field_scheduled_end': 'Planned finish', 'ui.history_source_drag': 'Drag',
    'ui.needs_planning': 'Needs Planning', 'ui.planning_status_scheduled': 'Scheduled', 'ui.history_actor_system': 'System' };
  let out = en[key] ?? key;
  if (vars) out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  return out;
};
const histFmt = d => (d ? `FMT(${d})` : '');

test('historyRowView formats modify, create and remove rows (dates, booleans, nulls, needs_planning code, carried_from)', () => {
  const modify = historyRowView({ id: 2, at: '2026-10-22T10:00:00+00:00', actor: 'pat@x.com', actor_name: 'Pat Planner', source: 'drag', op: 'modify', action_id: 'a1',
    changes: { machine: ['L1', 'L2'], scheduled_end: ['2026-10-22T08:00:00', null], manual_firmed: [false, true],
      planning_status: ['scheduled', 'needs_planning:runtime_unknown'], mystery: [1, 2] } }, histT, histFmt);
  assert.equal(modify.who, 'Pat Planner');
  assert.equal(modify.source, 'Drag');
  assert.equal(modify.when, 'FMT(2026-10-22T10:00:00+00:00)');
  const text = modify.lines.map(l => l.text);
  assert.ok(text.includes('Machine: L1 → L2'));
  assert.ok(text.includes('Planned finish: FMT(2026-10-22T08:00:00) → —'), 'a date is formatted and null is a dash');
  assert.ok(text.includes('Firmed: No → Yes'), 'booleans are localized yes/no');
  assert.ok(text.includes('Planning status: Scheduled → Needs Planning (runtime_unknown)'), 'the reason code rides in parentheses');
  assert.ok(text.includes('mystery: 1 → 2'), 'an unknown field falls back to the raw name');
  const create = historyRowView({ id: 1, at: 'x', actor: null, actor_name: null, source: 'weird_source', op: 'create', action_id: 'a2',
    changes: { machine: [null, 'L1'], carried_from: [null, 'old-id'] } }, histT, histFmt);
  assert.equal(create.who, 'System');
  assert.equal(create.source, 'weird_source', 'an unknown source falls back to the raw string');
  assert.equal(create.lines[0].text, 'Created');
  assert.ok(create.lines.some(l => l.text === 'Machine: L1'));
  assert.ok(create.lines.some(l => l.text === 'Carried from old-id'));
  const remove = historyRowView({ id: 3, at: 'x', actor: 'sap-scheduler', source: 'purge', op: 'remove', action_id: 'a3', changes: { machine: ['L1', null] } }, histT, histFmt);
  assert.equal(remove.who, 'sap-scheduler');
  assert.deepEqual(remove.lines.map(l => l.text), ['Removed', 'Machine: L1']);
  const grouped = groupHistoryEvents([{ action_id: 'g1' }, { action_id: 'g1' }, { action_id: 'g2' }]);
  assert.deepEqual(grouped.map(g => g.length), [2, 1]);
});

function historyHarness(id) {
  const doc = makeDocument();
  const prior = { document: globalThis.document, fetchTraced: Util.fetchTraced, current: Inspector._currentId, task: Store.tasks[id] };
  globalThis.document = doc;
  const root = makeEl('inspector-body', doc);
  doc.body.appendChild(root);
  const mount = () => {
    root.replaceChildren();
    const card = makeEl('', doc); card.className = 'insp-card insp-history'; card.setAttribute('data-history-for', id);
    const body = makeEl('', doc); body.className = 'insp-history-body';
    card.appendChild(body); root.appendChild(card);
    return body;
  };
  Inspector._history.clear(); Inspector._historyInflight.clear(); Inspector._historyError.clear();
  Inspector._currentId = id;
  Store.tasks[id] = { id, MACHINE: 'L1', PLANT: 'P1' };
  const urls = [];
  let events = [];
  let nextBefore = null;
  Util.fetchTraced = async url => { urls.push(String(url)); return { ok: true, json: async () => ({ events, next_before_id: nextBefore }) }; };
  return {
    mount, urls, setEvents(e) { events = e; }, setNextBefore(v) { nextBefore = v; },
    restore() {
      globalThis.document = prior.document; Util.fetchTraced = prior.fetchTraced; Inspector._currentId = prior.current;
      if (prior.task) Store.tasks[id] = prior.task; else delete Store.tasks[id];
      Inspector._history.clear(); Inspector._historyInflight.clear(); Inspector._historyError.clear();
    },
  };
}
const flushHistory = () => new Promise(resolve => setImmediate(resolve));

test('Inspector history renders from cache without a second fetch across two renders; invalidateHistory refetches once', async () => {
  const h = historyHarness('hist-1');
  try {
    h.setEvents([{ id: 5, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    let body = h.mount();
    Inspector._fillHistory('hist-1');
    assert.equal(h.urls.length, 1, 'first render fetches');
    assert.match(h.urls[0], /\/schedule-events\/P1\/order\/hist-1\?limit=20$/);
    assert.equal(body.children.length, 1, 'a loading line is shown meanwhile');
    Inspector._fillHistory('hist-1');
    assert.equal(h.urls.length, 1, 'an in-flight load is deduplicated');
    await flushHistory();
    assert.equal(body.children[0].className, 'insp-history-group');
    body = h.mount();                                   // a second _render rebuilds the card
    Inspector._fillHistory('hist-1');
    assert.equal(h.urls.length, 1, 'cached: no second fetch');
    assert.equal(body.children[0].className, 'insp-history-group', 'cached history renders synchronously');
    Inspector.invalidateHistory(['hist-1']);
    assert.equal(h.urls.length, 2, 'invalidate triggers exactly one refetch');
    await flushHistory();
    assert.equal(h.urls.length, 2);
    Inspector.invalidateHistory(['some-other-order']);
    assert.equal(h.urls.length, 2, 'invalidating an order that is not shown does not fetch');
  } finally { h.restore(); }
});

test('Inspector history: a response for an order no longer shown is not painted; an error is shown and not retried by a re-render', async () => {
  const h = historyHarness('hist-2');
  try {
    h.setEvents([]);
    const body = h.mount();
    Inspector._fillHistory('hist-2');
    Inspector._currentId = 'someone-else';
    await flushHistory();
    assert.equal(body.children[0].textContent, 'ui.insp_history_loading', 'the stale body is left alone');
    Inspector._history.clear(); Inspector._currentId = 'hist-2';
    Util.fetchTraced = async () => ({ ok: false, status: 500 });
    const body2 = h.mount();
    Inspector._fillHistory('hist-2');
    await flushHistory();
    assert.equal(body2.children[0].textContent, 'ui.insp_history_error');
    const before = h.urls.length;
    Inspector._fillHistory('hist-2');
    assert.equal(h.urls.length, before, 're-rendering does not hammer a failing endpoint');
  } finally { h.restore(); }
});

test('Inspector history renders hostile actor/notes as text, never markup', async () => {
  const h = historyHarness('hist-3');
  try {
    const evil = '<script>alert(1)</script>';
    h.setEvents([{ id: 9, at: '2026-10-22T10:00:00+00:00', actor: evil, actor_name: null, source: 'note', op: 'modify', action_id: 'n', client_id: null,
      changes: { notes: [evil, '<img src=x onerror=alert(1)>'] } }]);
    const body = h.mount();
    Inspector._fillHistory('hist-3');
    await flushHistory();
    const group = body.children[0];
    assert.match(group.children[0].textContent, /<script>alert\(1\)<\/script>/, 'the actor shows as literal text');
    assert.match(group.children[1].textContent, /<img src=x onerror=alert\(1\)>/);
    for (const el of [group, ...group.children]) {
      assert.equal(el.tagName, 'DIV');
      assert.equal(el.innerHTML, '', 'no HTML was ever assigned');
    }
  } finally { h.restore(); }
});

// An #inspector-body whose innerHTML setter mounts the real History card (the stub DOM does not parse markup).
function historyRenderBody(doc) {
  let html = ''; let card = null;
  return {
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      const m = /data-history-for="([^"]*)"/.exec(v);
      if (!m) { card = null; return; }
      card = makeEl('', doc); card.className = 'insp-card insp-history'; card.setAttribute('data-history-for', m[1]);
      const hb = makeEl('', doc); hb.className = 'insp-history-body'; card.appendChild(hb);
    },
    querySelectorAll() { return []; },
    querySelector(sel) { return sel === '.insp-history' ? card : null; },
    get card() { return card; },
  };
}

test('Inspector._render twice for one order fetches History once and emits the real data-history-for markup', async () => {
  const h = historyHarness('hist-a');
  try {
    const doc = globalThis.document;
    const rb = historyRenderBody(doc);
    doc.getElementById = id => id === 'inspector-body' ? rb : null;
    h.setEvents([{ id: 5, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    const task = Store.tasks['hist-a'];
    Inspector._render(task);
    Inspector._render(task);
    assert.match(rb.innerHTML, /data-history-for="hist-a"/);
    assert.equal(h.urls.length, 1, 'two renders, one fetch');
    await flushHistory();
    assert.equal(rb.card.querySelector('.insp-history-body').children[0].className, 'insp-history-group', 'the latest card is painted');
  } finally { h.restore(); }
});

test('Inspector history: invalidate while a fetch is pending gives exactly two fetches and a single paint', async () => {
  const h = historyHarness('hist-b');
  const paints = []; const priorRender = Inspector._renderHistory;
  try {
    Inspector._renderHistory = (body, events, more) => { paints.push(events.length); return priorRender.call(Inspector, body, events, more); };
    h.setEvents([{ id: 1, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    h.mount();
    Inspector._fillHistory('hist-b');
    Inspector.invalidateHistory(['hist-b']);
    await flushHistory(); await flushHistory();
    assert.equal(h.urls.length, 2, 'the answer that may predate the save is discarded and re-fetched');
    assert.equal(paints.length, 1, 'only the fresh answer is painted');
  } finally { Inspector._renderHistory = priorRender; h.restore(); }
});

test('Inspector history cache evicts the oldest entry past 200 ids', async () => {
  const h = historyHarness('hist-c0');
  const made = [];
  try {
    Inspector._currentId = 'nobody';                       // nothing is painted; only the cache is exercised
    for (let i = 0; i < 205; i++) {
      const id = `hist-c${i}`; made.push(id);
      Store.tasks[id] = { id, MACHINE: 'L1', PLANT: 'P1' };
      await Inspector._loadHistory(id);
    }
    assert.equal(Inspector._history.size, 200);
    assert.ok(!Inspector._history.has('hist-c0') && !Inspector._history.has('hist-c4'), 'the five oldest are gone');
    assert.ok(Inspector._history.has('hist-c5') && Inspector._history.has('hist-c204'));
  } finally { made.slice(1).forEach(id => delete Store.tasks[id]); h.restore(); }
});

test('Inspector history: a card swapped to another order before the response is not painted', async () => {
  const h = historyHarness('hist-d');
  try {
    h.setEvents([{ id: 1, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    const body = h.mount();
    Inspector._fillHistory('hist-d');
    body.parentNode.setAttribute('data-history-for', 'another-order');
    await flushHistory();
    assert.equal(body.children[0].textContent, 'ui.insp_history_loading', 'the other order\'s card is left alone');
    assert.ok(Inspector._history.has('hist-d'), 'the answer is still cached for its own order');
  } finally { h.restore(); }
});

test('Inspector.clear() before the History response arrives does not throw', async () => {
  const h = historyHarness('hist-e');
  try {
    h.mount();
    Inspector._fillHistory('hist-e');
    Inspector.clear();
    await flushHistory();
    assert.equal(Inspector._currentId, null);
    assert.ok(Inspector._history.has('hist-e'));
  } finally { h.restore(); }
});

test('Inspector.init: tasks:saved refetches the shown order once; tasks:bulk and plant:selected drop every cached history', async () => {
  const h = historyHarness('hist-f');
  const priorUnsub = Inspector._unsubStore;
  try {
    Inspector.init();
    h.setEvents([{ id: 1, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    h.mount();
    Inspector._fillHistory('hist-f');
    await flushHistory();
    assert.equal(h.urls.length, 1);
    Store.emit({ type: 'tasks:saved', ids: ['hist-f'], source: 'persistence' });
    assert.equal(h.urls.length, 2, 'one refetch');
    await flushHistory();
    for (const type of ['tasks:bulk', 'plant:selected']) {
      Inspector._history.set('other', { events: [], more: false, at: Date.now() });
      Inspector._historyError.add('err');
      const epoch = Inspector._historyEpoch;
      Store.emit({ type, source: 'unit-test' });
      assert.equal(Inspector._history.size, 0, `${type} clears the cache`);
      assert.equal(Inspector._historyError.size, 0, `${type} clears recorded errors`);
      assert.equal(Inspector._historyEpoch, epoch + 1, `${type} bumps the generation`);
    }
  } finally { Inspector._unsubStore?.(); Inspector._unsubStore = priorUnsub; h.restore(); }
});

test('Inspector history: a reset during a pending fetch discards its answer and refetches', async () => {
  const h = historyHarness('hist-g');
  try {
    h.mount();
    Inspector._fillHistory('hist-g');
    Inspector.resetHistory();
    await flushHistory(); await flushHistory();
    assert.equal(h.urls.length, 2);
  } finally { h.restore(); }
});

test('Inspector history: an entry older than 60 s is refetched on show; a fresh one is not', async () => {
  const h = historyHarness('hist-h');
  try {
    Inspector._history.set('hist-h', { events: [], more: false, at: Date.now() - 61_000 });
    h.mount();
    Inspector._fillHistory('hist-h');
    assert.equal(h.urls.length, 1, 'stale entry refetched');
    await flushHistory();
    h.mount();
    Inspector._fillHistory('hist-h');
    assert.equal(h.urls.length, 1, 'the fresh entry is served from cache');
  } finally { h.restore(); }
});

test('Inspector history shows a muted "older changes not shown" line when the server has more', async () => {
  const h = historyHarness('hist-i');
  try {
    h.setEvents([{ id: 3, at: '2026-10-22T10:00:00+00:00', actor: 'a@x.com', actor_name: null, source: 'drag', op: 'modify', action_id: 'g', client_id: null, changes: { machine: ['L1', 'L2'] } }]);
    h.setNextBefore(3);
    const body = h.mount();
    Inspector._fillHistory('hist-i');
    await flushHistory();
    const last = body.children[body.children.length - 1];
    assert.equal(last.className, 'insp-history-note insp-history-more');
    assert.equal(last.textContent, 'ui.insp_history_more');
    h.setNextBefore(null);
    Inspector._history.clear();
    const body2 = h.mount();
    Inspector._fillHistory('hist-i');
    await flushHistory();
    assert.ok(!body2.children.some(c => /insp-history-more/.test(c.className)), 'no extra line when the page is complete');
  } finally { h.restore(); }
});

test('Table._planningReasonText: an overlong_never row reads "now fits" only while a queued_now_fits alert exists for it (display only)', () => {
  const task = { id: 'pr-1', planning_status: 'needs_planning', planning_reason: { code: 'overlong_never', message: 'stored' } };
  const priorAlerts = structuredClone(Store.alerts), priorT = Util.t;
  Util.t = (k) => k;
  try {
    Store.setAlerts([], 'unit-test');
    assert.equal(Table._planningReasonText(task), 'planning_reason.overlong_never');
    Store.setAlerts([{ id: 'queued-now-fits-pr-1', type: 'queued_now_fits', sev: 'warn', taskId: 'pr-1', line: 'L', time: new Date() }], 'unit-test');
    assert.equal(Table._planningReasonText(task), 'planning_reason.overlong_released_pending');
    assert.equal(task.planning_reason.code, 'overlong_never', 'the stored reason is untouched');
    assert.equal(Table._planningReasonText({ id: 'x', planning_reason: { code: 'no_fit_found', message: 'stored' } }), 'stored');
    assert.equal(Table._planningReasonText({ id: 'x', planning_reason: null }), '');
  } finally { Util.t = priorT; Store.setAlerts(priorAlerts, 'unit-test'); }
});

test('Tool Inventory fix: a cleared PRT cell is stored as null (trimmed text otherwise), grid and Inspector alike', () => {
  const plant = '5512';
  const priorPlant = Store.selectedPlant;
  const priorTableApi = Table._api;
  const priorRecompute = Alerts.scheduleRecompute;
  const priorRecomputeLines = Alerts.scheduleRecomputeLines;
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([{ id: 'prt-clear', PLANT: plant, MACHINE: 'PRT-LINE', RUN_TIME: '2', PRT_01: 'T1', PRT_02: 'T2' }], 'unit-test');
  try {
    Table._onCellChanged({ colDef: { field: 'PRT_01' }, data: Store.tasks['prt-clear'], newValue: '', node: { refreshCells: () => {} } });
    assert.equal(Store.tasks['prt-clear'].PRT_01, null, 'cleared (empty) is NULL, not an empty string');
    Table._onCellChanged({ colDef: { field: 'PRT_02' }, data: Store.tasks['prt-clear'], newValue: '   ', node: { refreshCells: () => {} } });
    assert.equal(Store.tasks['prt-clear'].PRT_02, null, 'whitespace only is also cleared');
    Table._onCellChanged({ colDef: { field: 'PRT_01' }, data: Store.tasks['prt-clear'], newValue: '  T9  ', node: { refreshCells: () => {} } });
    assert.equal(Store.tasks['prt-clear'].PRT_01, 'T9', 'trimmed on commit');
  } finally {
    Table._api = priorTableApi;
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Alerts.scheduleRecompute = priorRecompute;
    Alerts.scheduleRecomputeLines = priorRecomputeLines;
  }
});
