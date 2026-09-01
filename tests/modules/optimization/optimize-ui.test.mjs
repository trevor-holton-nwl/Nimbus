// Tests for web/optimization/optimize-ui.mts (OptimizeDialog, OptimizerPreview,
// SandboxAdapter). Split from tests/modules/schedule-workbench.test.mjs (Phase
// P3 of docs/architecture/domain-refactor-plan.md, which split that
// mega-module into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizeDialog, OptimizerPreview, SandboxAdapter } from '../../../web/optimization/optimize-ui.mjs';
import { Timeline } from '../../../web/scheduling/gantt.mjs';
import { Store } from '../../../web/platform/store.mjs';
import { Util, ErrorLog } from '../../../web/platform/foundation.mjs';
import { Alerts, Utilization } from '../../../web/insights/services.mjs';
import { Persistence } from '../../../web/scheduling/persistence.mjs';

const require = createRequire(import.meta.url);

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

test('OptimizeDialog/OptimizerPreview expose the documented public API', () => {
  assert.equal(typeof OptimizeDialog.open, 'function');
  assert.equal(typeof OptimizeDialog.run, 'function');
  assert.equal(typeof OptimizerPreview.runWithPreview, 'function');
});

test('combined is no longer an optimizer strategy users can select', () => {
  const { readFileSync } = require('node:fs');
  const types = readFileSync(new URL('../../../web/platform/types.mts', import.meta.url), 'utf8');
  const dialogMarkup = readFileSync(new URL('../../../web/index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(types, /'combined'/,
    'the public optimizer-mode type must not expose the retired strategy');
  assert.doesNotMatch(dialogMarkup, /data-mode="combined"/,
    'the optimize dialog must not render a combined strategy button');
});

test('OptimizerPreview retains only a bounded candidate explanation and drops it on discard', () => {
  // Regression target: retaining raw candidate schedules/reasons would make a
  // long preview unbounded and leave setup explanation data after Discard.
  const candidate = {
    patches: [{ id: 'changed-1', changes: { start_date: new Date('2026-08-14T08:00:00') } }],
    explanation: Array.from({ length: 14 }, (_, index) => ({ code: `reason-${index}`, message: `Reason ${index}`, line: 'L-1' })),
    diagnostics: { candidateCount: 23, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 37, limitReached: false, events: [] },
    unchangedLines: ['L-2', 'L-3'],
    missingEdges: Array.from({ length: 16 }, (_, index) => ({ line: 'L-1', predecessorOrderId: `before-${index}`, successorOrderId: `after-${index}`, reason: 'matrix-missing' })),
  };
  const explanation = OptimizerPreview.summarizeCandidate(candidate, {
    productionBefore: 10, productionAfter: 10, preKpis: { changeovers: 8, span_h: 20, late_count: 4, late_h: 6, peak_util_pct: 92 },
    postKpis: { changeovers: 6, span_h: 18, late_count: 2, late_h: 3, peak_util_pct: 88 },
  });
  assert.equal(explanation.reasons.length, 8, 'the UI explanation caps candidate reasons');
  assert.equal(explanation.missingPairs.length, 12, 'the UI explanation caps missing setup pairs');
  assert.deepEqual(explanation.search, { candidateCount: 23, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 37, limitReached: false });
  assert.equal(Object.hasOwn(explanation, 'tasks'), false, 'the compact explanation never retains a schedule snapshot');

  OptimizerPreview._explanation = explanation;
  OptimizerPreview.active = true;
  OptimizerPreview.discard();
  assert.equal(OptimizerPreview._explanation, null, 'Discard destroys the in-memory explanation');
});

test('OptimizerPreview derives and exports real setup states for bounded missing pairs', () => {
  // Regression target: displaying order IDs in From/To (and exporting no
  // states) prevents a matrix editor from acting on the reported pair.
  const candidate = {
    patches: [], explanation: [], diagnostics: { candidateCount: 1, method: 'spt-detached', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] },
    unchangedLines: [], missingEdges: [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', reason: 'matrix-missing' }],
  };
  const setup = {
    plant: '5512', definition: { plant: '5512', fields: ['colorWheel'], strict_blanks: true, signature_version: 1, active: false }, plant_active: false,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  };
  const pairs = OptimizerPreview.describeMissingPairs(candidate, [
    { id: 'red-order', PLANT: '5512', MACHINE: 'L-1', COLOR: 'RED' },
    { id: 'blue-order', PLANT: '5512', MACHINE: 'L-1', COLOR: 'BLUE' },
  ], setup);
  assert.deepEqual(pairs, [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', fromState: 'colorWheel=RED', toState: 'colorWheel=BLUE', reason: 'matrix-missing' }]);
  const csv = OptimizerPreview.missingPairsCsv(pairs);
  assert.match(csv, /From setup state,To setup state/);
  assert.match(csv, /colorWheel=RED/);
  assert.match(csv, /colorWheel=BLUE/);
});

test('Persistence setup writes stale an open preview without applying or rerunning it', () => {
  // Regression target: a successful matrix/state/override write must require
  // an explicit preview rerun instead of applying or recomputing silently.
  const priorFetch = globalThis.fetch;
  const candidate = { patches: [], explanation: [], diagnostics: { candidateCount: 1, method: 'spt-detached', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] }, unchangedLines: [], missingEdges: [] };
  let requests = 0;
  globalThis.fetch = () => { requests++; return Promise.resolve({ ok: true }); };
  OptimizerPreview._snapshot = [];
  OptimizerPreview._candidate = candidate;
  OptimizerPreview._explanation = OptimizerPreview.summarizeCandidate(candidate, { productionBefore: 1, productionAfter: 1, preKpis: { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0 }, postKpis: { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0 } });
  OptimizerPreview._plant = 'STALE';
  OptimizerPreview.active = true;
  try {
    for (const kind of ['definition', 'matrix', 'state', 'override']) {
      OptimizerPreview.stale = false;
      Persistence.noteSetupWrite('STALE', kind);
      assert.equal(OptimizerPreview.stale, true, `${kind} writes stale an open preview`);
      assert.equal(OptimizerPreview.canApply(), false, 'stale previews cannot apply');
    }
    OptimizerPreview.apply();
    assert.equal(OptimizerPreview._candidate, candidate, 'Apply leaves a stale candidate intact for explicit rerun or discard');
    assert.equal(requests, 0, 'staling and blocked Apply never write an audit row or rerun optimization');
  } finally {
    OptimizerPreview._clear();
    globalThis.fetch = priorFetch;
  }
});

test('OptimizerPreview keeps trial patches detached until Apply, then commits them once', () => {
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorTimelineItems = Timeline._items;
  const priorPlant = Store.selectedPlant;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorFetch = globalThis.fetch;
  const timelineUpdates = [];
  const publications = [];
  const auditRequests = [];
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  Timeline._items = { update(items) { timelineUpdates.push(...items); } };
  Alerts.scheduleRecompute = () => {};
  globalThis.fetch = (...args) => {
    auditRequests.push(args);
    return Promise.resolve({ ok: true });
  };
  Store.setTasks([
    { id: 'preview-long', PLANT: 'PREVIEW', MACHINE: 'L1', RUN_TIME: 5, start_date: null, end_date: null },
    { id: 'preview-short', PLANT: 'PREVIEW', MACHINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null },
  ], 'unit-test');
  Store.setSelectedPlant('PREVIEW', 'unit-test');
  const beforeRevision = Store.rev();
  const beforeTasks = structuredClone(Store.tasks);
  const unsubscribe = Store.subscribe(event => { publications.push(event.type); }, 'unit-test-autosave');

  try {
    const previewOptions = {
      plant: 'PREVIEW', respectCalendar: false, now: new Date('2026-08-03T08:00:00'),
      auditDetails: {
        mode: 'spt', wheelUsed: false, taskCount: 2, scope: 'plant', lines: null,
        activePriorityFields: [], unrankedPriorityFields: [], splitOrderPolicy: 'never',
      },
    };
    OptimizerPreview.runWithPreview('spt', previewOptions);

    assert.ok(OptimizerPreview._candidate, 'the preview retains a detached candidate for Apply');
    assert.equal(Store.rev(), beforeRevision, 'opening a preview must not publish trial schedule state');
    assert.deepEqual(Store.tasks, beforeTasks, 'opening a preview must not alter live task values');
    assert.deepEqual(timelineUpdates, [], 'a detached preview must not issue timeline item updates');
    assert.deepEqual(publications, [], 'autosave-like Store subscribers must stay idle before Apply');
    assert.deepEqual(auditRequests, [], 'a detached candidate must not persist an audit row before Apply');

    OptimizerPreview.discard();

    assert.equal(OptimizerPreview._candidate, null, 'Discard destroys the detached candidate');
    assert.equal(OptimizerPreview._explanation, null, 'Discard destroys the compact explanation with the candidate');
    assert.equal(Store.rev(), beforeRevision, 'Discard must not roll back through Store because Store never changed');
    assert.deepEqual(Store.tasks, beforeTasks, 'Discard leaves the live schedule untouched');
    assert.deepEqual(publications, [], 'Discard must not wake autosave-like subscribers');
    assert.deepEqual(auditRequests, [], 'Discard must not persist an audit row');

    OptimizerPreview.runWithPreview('spt', previewOptions);

    OptimizerPreview.apply();

    assert.ok(Store.tasks['preview-short'].start_date, 'Apply commits the selected candidate patch set');
    assert.equal(OptimizerPreview._explanation, null, 'Apply destroys the explanation after committing its candidate');
    assert.equal(publications.filter(type => type === 'tasks:bulkUpdate').length, 1,
      'Apply performs exactly one schedule task commit');
    assert.equal(auditRequests.length, 1, 'Apply emits the deferred audit row');
    assert.doesNotMatch(JSON.stringify(auditRequests), /explanation/i,
      'the applied optimization audit never persists preview explanation data');
    assert.equal(timelineUpdates.length, 0, 'the evaluator itself never writes Timeline items');
  } finally {
    unsubscribe();
    OptimizerPreview._clear();
    Alerts.scheduleRecompute = priorScheduleRecompute;
    globalThis.fetch = priorFetch;
    Timeline._items = priorTimelineItems;
    Store.setTasks([], 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
  }
});

test('OptimizerPreview computes KPI utilization against detached calendar and plant maps', () => {
  // Removing the preview utilization context would let the production resolver
  // pass Store.calendars/plants to compute core, which fills missing defaults.
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorCore = globalThis.NimbusComputeCore;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const priorPlants = structuredClone(Store.plants);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const scheduledStart = new Date();
  scheduledStart.setHours(8, 0, 0, 0);
  const scheduledEnd = new Date(scheduledStart.getTime() + 60 * 60 * 1000);
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  globalThis.NimbusComputeCore = require('../../../web/nimbus-compute-core.js');
  Alerts.scheduleRecompute = () => {};
  Util.setUtilizationResolver((from, days, tasks, snapshot) =>
    Utilization.computeMatrix(from, days, tasks, snapshot));
  Store.replaceCalendars({}, 'unit-test');
  Store.replacePlants({}, 'unit-test');
  Store.setLineSetting('KPI-DETACHED-LINE', { plant: 'KPI-DETACHED' }, 'unit-test');
  Store.setTasks([{
    id: 'kpi-detached-order', PLANT: 'KPI-DETACHED', MACHINE: 'KPI-DETACHED-LINE', RUN_TIME: 1,
    start_date: scheduledStart, end_date: scheduledEnd,
  }], 'unit-test');
  Store.setSelectedPlant('KPI-DETACHED', 'unit-test');
  const beforeCalendars = structuredClone(Store.calendars);
  const beforePlants = structuredClone(Store.plants);

  try {
    OptimizerPreview.runWithPreview('spt', { plant: 'KPI-DETACHED', respectCalendar: false });

    assert.ok(OptimizerPreview._candidate, 'the preview completes its detached KPI comparison');
    assert.deepEqual(Store.calendars, beforeCalendars,
      'KPI computation must not fill missing line calendars in Store before Apply');
    assert.deepEqual(Store.plants, beforePlants,
      'KPI computation must not fill missing plant calendars in Store before Apply');
  } finally {
    OptimizerPreview._clear();
    Util.setUtilizationResolver(null);
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.replacePlants(priorPlants, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
    globalThis.NimbusComputeCore = priorCore;
  }
});

test('OptimizerPreview keeps evaluation failures out of ErrorLog persistence', () => {
  // Restoring ErrorLog.error() in the preview catch would persist an un-applied
  // backlog candidate failure instead of retaining only ephemeral diagnostics.
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorMasterData = structuredClone(Store.masterData);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const beforeEntries = ErrorLog.entries();
  const priorSave = ErrorLog._scheduleSave;
  const priorShip = ErrorLog._scheduleShip;
  let saveCalls = 0;
  let shipCalls = 0;
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  ErrorLog._scheduleSave = () => { saveCalls++; };
  ErrorLog._scheduleShip = () => { shipCalls++; };
  Store.setMasterData({ plants: [{ plant: 'PREVIEW-FAIL' }], lines: [{ plant: 'PREVIEW-FAIL', machine: 'FAIL-LINE' }] }, 'unit-test');
  Store.setTasks([{ id: 'preview-fail', PLANT: 'PREVIEW-FAIL', MACHINE: 'FAIL-LINE', RUN_TIME: 1, start_date: new Date(), end_date: new Date() }], 'unit-test');
  Store.setSelectedPlant('PREVIEW-FAIL', 'unit-test');

  try {
    OptimizerPreview.runWithPreview('backlog', { plant: 'PREVIEW-FAIL', respectCalendar: true });

    assert.deepEqual(ErrorLog.entries(), beforeEntries,
      'a preview evaluation failure must not enter the persistent error log');
    assert.equal(saveCalls, 0, 'a preview evaluation failure must not schedule IndexedDB persistence');
    assert.equal(shipCalls, 0, 'a preview evaluation failure must not schedule backend error shipping');
    assert.equal(OptimizerPreview._previewDiagnostics?.[0]?.code, 'candidate-evaluation-failed',
      'the failure remains structured in preview-local memory');
  } finally {
    OptimizerPreview._clear();
    ErrorLog._entries = beforeEntries;
    ErrorLog._scheduleSave = priorSave;
    ErrorLog._scheduleShip = priorShip;
    Alerts.scheduleRecompute = priorScheduleRecompute;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.requestAnimationFrame = priorRaf;
    globalThis.NIMBUS = priorNimbus;
  }
});

// Pulled out of schedule-workbench.test.mjs's combined 'EditCalendar/
// ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their
// documented public API' smoke test, which spanned five modules across four
// different new files.
test('SandboxAdapter exposes the documented public API', () => {
  assert.equal(typeof SandboxAdapter.init, 'function');
});
