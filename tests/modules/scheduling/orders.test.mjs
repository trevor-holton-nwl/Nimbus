// Tests for frontend/scheduling/orders.mts (Table, Inspector, ContextMenu,
// Printer). Split from tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Table, Inspector, ContextMenu, Printer } from '../../../frontend/scheduling/orders.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

const require = createRequire(import.meta.url);

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

test('queued demand has no scheduled finish and overdue queue remains in delivery lateness', () => {
  const due = new Date(Date.now() - 48 * 3600000);
  const queued = { id: 'q', planning_status: 'needs_planning', start_date: null, end_date: null, original_end_date: due };
  assert.equal(Util.scheduledEnd(queued), null);
  assert.ok(Util.latenessHours(queued) >= 48);
});

test('Allowed window labels a frozen-floor conflict instead of showing a reversed date range', () => {
  const priorMasterData = Store.masterData;
  const priorFrozen = Store.frozenHorizonEnd;
  const due = new Date('2026-09-15T18:00:00');
  const ceiling = new Date('2026-09-16T00:00:00');
  const order = { id: 'expired-window', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1, original_end_date: due };
  try {
    Store.setMasterData({ ...priorMasterData, plants: [{ plant: 'P1', max_pull_forward_days: 0, max_push_forward_days: 0 }] }, 'test');
    for (const floor of [new Date('2026-09-19T00:00:00'), ceiling]) {
      Store.setFrozenHorizonEnd(floor, 'test');
      assert.equal(Table._planningWindowLabel(order),
        `No valid window: earliest start ${Util.fmtDTReadable(floor)}; complete by ${Util.fmtDTReadable(ceiling)}`);
    }
    Store.setFrozenHorizonEnd(null, 'test');
    assert.equal(Table._planningWindowLabel(order),
      `${Util.fmtDTReadable(new Date('2026-09-15T00:00:00'))} — ${Util.fmtDTReadable(ceiling)}`);
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
  const task = { id: 'detail-successor', MACHINE: 'SETUP-L4', RUN_TIME: 1,
    start_date: new Date('2026-08-14T08:00:00'), end_date: new Date('2026-08-14T09:00:00') };
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
    assert.equal(dashCount, 6, 'the six unavailable setup values (predecessor, state, required, effective, standard, override) render a plain dash');
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
  assert.ok(columns.every(c => c.editable === true), 'priority fields must be inline-editable');
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

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'table-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'table-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    const peerBefore = Store.tasks['table-peer'].start_date.getTime();
    // Call the real handler with a start_date cell change that creates an overlap
    Table._onCellChanged({
      colDef: { field: 'start_date' },
      data: Store.tasks['table-anchor'],
      newValue: '2026-08-25 07:00',
      node: { refreshCells: () => {} },
    });
    const peerAfter = Store.tasks['table-peer'].start_date.getTime();
    // Peer should NOT have moved and autoReflow should NOT have been called
    assert.equal(peerAfter, peerBefore, 'peer must NOT be reflowed after Table cell edit');
    assert.equal(autoReflowCalls.length, 0, 'Engine.autoReflow must NOT be called from Table._onCellChanged (Task 3: B2 deleted this call)');
  } finally {
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

  Store.setSelectedPlant(plant, 'unit-test');
  Store.setTasks([
    { id: 'inspector-anchor', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start1, end_date: end1 },
    { id: 'inspector-peer', PLANT: plant, MACHINE: line, RUN_TIME: '2', start_date: start2, end_date: end2 },
  ], 'unit-test');

  try {
    Inspector._currentId = 'inspector-anchor';
    const peerBefore = Store.tasks['inspector-peer'].start_date.getTime();
    // Call the real handler with a start_date field change that creates an overlap
    Inspector._onFieldChange('start_date', '2026-08-25 07:00');
    const peerAfter = Store.tasks['inspector-peer'].start_date.getTime();
    // Peer should NOT have moved and autoReflow should NOT have been called
    assert.equal(peerAfter, peerBefore, 'peer must NOT be reflowed after Inspector field change');
    assert.equal(autoReflowCalls.length, 0, 'Engine.autoReflow must NOT be called from Inspector._onFieldChange (Task 3: B2 deleted this call)');
  } finally {
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
    'ovr-start': { value: '2026-09-21 08:00' },
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
    'ovr-start': { value: '2026-09-21 08:00' },
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
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, routing_runtime_enabled: true }] }, 'test');
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
  Store.setMasterData({ ...priorMasterData, plants: [{ plant, routing_runtime_enabled: false }] }, 'test');
  let eligibleCalls = 0;
  Runtime.eligible = () => { eligibleCalls++; return false; };
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  Alerts.scheduleRecompute = () => {};

  Store.setTasks([{
    id: 'routing-disabled-cell-edit', PRODUCTION_ORDER: 'A-9102', ORDER: 'A-9102', PLANT: plant,
    MACHINE: 'L1', RUN_TIME: 1, start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T10:00:00'),
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

test('Table._onCellChanged: an eligible PRODUCTION_VERSION edit updates RUN_TIME/run_time_source/run_time_basis locally and re-places the order', () => {
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

  Store.setTasks([{
    id: 'routing-pv-ok', PRODUCTION_ORDER: 'A-9104', ORDER: 'A-9104', PLANT: plant, MACHINE: 'L1',
    PRODUCTION_VERSION: '0001', RUN_TIME: 1, run_time_source: 'sap_order',
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  }], 'test');

  try {
    Table._onCellChanged({
      colDef: { field: 'PRODUCTION_VERSION' },
      data: Store.tasks['routing-pv-ok'],
      newValue: '0002',
      node: { refreshCells: () => {} },
    });
    const task = Store.tasks['routing-pv-ok'];
    assert.equal(task.PRODUCTION_VERSION, '0002');
    assert.equal(task.RUN_TIME, 5.9);
    assert.equal(task.run_time_source, 'routing');
    assert.equal(task.run_time_basis.workcenter, 'MOLD01');
    assert.equal(task.start_date.getTime(), newStart.getTime(), 'the order must be re-placed through Engine.manualSchedulePatchFor');
    assert.notEqual(task.planning_status, 'needs_planning');
  } finally {
    Table._api = priorTableApi;
    Runtime.resolve = priorResolve;
    Engine.manualSchedulePatchFor = priorManualSchedule;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks([], 'test');
    Store.setMasterData(priorMasterData, 'test');
  }
});

test('Table._onCellChanged: an ineligible PRODUCTION_VERSION edit holds the task locally (needs_planning/runtime_unknown) with null dates', () => {
  const priorTableApi = Table._api;
  const priorResolve = Runtime.resolve;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorToastShow = Toast.show;
  const plant = 'P-ROUTING-PV-HELD';
  const priorMasterData = _enableRoutingForPlant(plant);
  Alerts.scheduleRecompute = () => {};
  const toastCalls = [];
  Toast.show = (msg, type) => { toastCalls.push({ msg, type }); };
  Runtime.resolve = () => ({ ok: false, step: 'workcenter_unmapped' });
  Table._api = { applyTransaction: () => {}, refreshCells: () => {} };

  Store.setTasks([{
    id: 'routing-pv-held', PRODUCTION_ORDER: 'A-9105', ORDER: 'A-9105', PLANT: plant, MACHINE: 'L1',
    PRODUCTION_VERSION: '0001', RUN_TIME: 1,
    start_date: new Date('2026-09-20T08:00:00'), end_date: new Date('2026-09-20T09:00:00'),
  }], 'test');

  try {
    Table._onCellChanged({
      colDef: { field: 'PRODUCTION_VERSION' },
      data: Store.tasks['routing-pv-held'],
      newValue: '0003',
      node: { refreshCells: () => {} },
    });
    const task = Store.tasks['routing-pv-held'];
    assert.equal(task.PRODUCTION_VERSION, '0003');
    assert.equal(task.planning_status, 'needs_planning');
    assert.equal(task.planning_reason.code, 'runtime_unknown');
    assert.match(task.planning_reason.message, /workcenter_unmapped/);
    assert.equal(task.start_date, null);
    assert.equal(task.end_date, null);
    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].type, 'warn');
  } finally {
    Table._api = priorTableApi;
    Runtime.resolve = priorResolve;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Toast.show = priorToastShow;
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

test('#34 Inspector destroys the previous start-date Flatpickr on every re-render and on clear (no leak per render)', () => {
  const priorGetElementById = globalThis.document.getElementById;
  const priorFp = Util.fpDatetime;
  const dtInput = { value: '', dataset: { field: 'start_date' } };
  const body = {
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector(sel) { return sel === '[data-field="start_date"]' ? dtInput : null; },
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
    Inspector._fpStart = null;
  }
});
