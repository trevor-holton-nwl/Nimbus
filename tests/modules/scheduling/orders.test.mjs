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
import { Util } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';

const require = createRequire(import.meta.url);

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

// Pulled out of schedule-workbench.test.mjs's combined 'EditCalendar/
// ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their
// documented public API' smoke test, which spanned five modules across four
// different new files.
test('Printer exposes the documented public API', () => {
  assert.equal(typeof Printer.open, 'function');
});
