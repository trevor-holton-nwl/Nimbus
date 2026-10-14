// Tests for frontend/optimization/optimize-ui.mts (OptimizeDialog, OptimizerPreview,
// SandboxAdapter). Split from tests/modules/schedule-workbench.test.mjs (Phase
// P3 of docs/architecture/domain-refactor-plan.md, which split that
// mega-module into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OptimizeDialog, OptimizerPreview, SandboxAdapter } from '../../../frontend/optimization/optimize-ui.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, ErrorLog, Toast } from '../../../frontend/platform/foundation.mjs';
import { Alerts, Compute, Utilization } from '../../../frontend/insights/services.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';

const require = createRequire(import.meta.url);
// engine.mts reads the compute-core global at call time (plantWallClockFromInstant), so Node tests must bootstrap it.
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

test('preview separates scheduled demand, new queue, protected exceptions and incomplete search', () => {
  const candidate = { dispositions: [
    { id: 'a', status: 'scheduled', line: 'L1' },
    { id: 'b', status: 'needs_planning', line: 'L1' },
    { id: 'c', status: 'needs_planning', line: 'L1' },
    { id: 'p', status: 'protected', line: 'L1' },
    { id: 'p2', status: 'protected', line: 'L1' },
  ], validationFindings: [{ severity: 'warning', taskId: 'p', code: 'protected-window', message: 'Existing violation.' },
    { severity: 'warning', taskId: 'p2', code: 'missing_setup', message: 'Missing transition uses zero minutes.' }], searchComplete: false };
  assert.deepEqual(OptimizerPreview.planningSummary(candidate, [{ id: 'c', planning_status: 'needs_planning' }]),
    { scheduled: 1, needsPlanning: 2, newlyQueued: 1, protectedExceptions: 1, incomplete: true });
});

test('preview distinguishes gap completion from the main sequence search', () => {
  assert.equal(typeof OptimizerPreview.gapFillSummary, 'function');
  assert.match(OptimizerPreview.gapFillSummary({ gapFill: { complete: true, placed: 3, unchecked: 0 } }), /Capacity check:.*3 more order/);
  assert.match(OptimizerPreview.gapFillSummary({ gapFill: { complete: false, placed: 1, unchecked: 2 } }), /Capacity check incomplete.*2 still unchecked/);
  assert.equal(OptimizerPreview.gapFillSummary({}), '');
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
    querySelectorAll() { return []; },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
}
globalThis.window = globalThis.window || {};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeSandboxElement(id, value = '') {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    value,
    className: '',
    hidden: false,
    innerHTML: '',
    textContent: '',
    style: {},
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    addEventListener(type, handler) {
      (listeners.get(type) || (listeners.set(type, []), listeners.get(type))).push(handler);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) || []) handler({ type, target: this });
    },
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    focus() {},
  };
}

function makeSandboxDocument() {
  const elements = new Map();
  const sandboxButtons = [makeSandboxElement('sandbox-mode-toggle')];
  sandboxButtons[0].className = 'sandbox-btn';
  sandboxButtons[0].onclick = () => {};
  const banner = makeSandboxElement('sandbox-banner');
  let bannerHtml = '';
  Object.defineProperty(banner, 'innerHTML', {
    get() { return bannerHtml; },
    set(html) {
      bannerHtml = html;
      for (const match of String(html).matchAll(/<(input|button)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const [, tag, id] = match;
        const value = tag === 'input'
          ? (String(html).match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*\\bvalue="([^"]*)"`))?.[1] || '')
          : '';
        elements.set(id, makeSandboxElement(id, value));
      }
    },
  });
  elements.set('sandbox-banner', banner);
  const body = makeSandboxElement('body');
  return {
    elements,
    sandboxButtons,
    body,
    document: {
      getElementById(id) { return elements.get(id) || null; },
      querySelector() { return null; },
      querySelectorAll(selector) { return selector === '.sandbox-btn' ? sandboxButtons : []; },
      createElement(id) { return makeSandboxElement(id); },
      addEventListener() {},
      removeEventListener() {},
      body,
    },
  };
}

function subscribeSandboxAdapter() {
  return Store.subscribe(event => {
    if (event.type === 'sandbox:entered') SandboxAdapter._onEntered();
    else if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
    else if (event.type === 'sandbox:reverted') SandboxAdapter._onReverted();
  }, 'unit-test-sandbox-adapter');
}

function previewTask(id, plant, runTime = 1) {
  return {
    id, PLANT: plant, plant, MACHINE: `${plant}-LINE`, RUN_TIME: runTime,
    row_version: 1, start_date: null, end_date: null,
  };
}

function openTaskBaselinePreview(plant, tasks, { firmedIds = [] } = {}) {
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorFirmedIds = new Set(Store.firmedIds);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
  const priorFetch = globalThis.fetch;
  const auditRequests = [];
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  Alerts.scheduleRecomputeLines = () => {};
  globalThis.fetch = (...args) => {
    auditRequests.push(args);
    return Promise.resolve({ ok: true });
  };
  Store.replaceFirmedIds(new Set(), 'unit-test');
  Store.setTasks(tasks, 'unit-test');
  if (firmedIds.length) Store.setFirmed(firmedIds, true, 'unit-test');
  Store.setSelectedPlant(plant, 'unit-test');
  OptimizerPreview.runWithPreview('spt', {
    plant, respectCalendar: false, now: new Date('2026-08-03T08:00:00'),
    auditDetails: {
      mode: 'spt', wheelUsed: false, taskCount: tasks.length, scope: 'plant', lines: null,
      activePriorityFields: [], unrankedPriorityFields: [], splitOrderPolicy: 'never',
    },
  });
  assert.ok(OptimizerPreview._candidate, 'the task-baseline fixture opens a detached preview');

  return {
    auditRequests,
    restore() {
      OptimizerPreview._clear();
      Alerts.scheduleRecompute = priorScheduleRecompute;
      Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
      Store.setTasks(priorTasks, 'unit-test');
      Store.replaceFirmedIds(priorFirmedIds, 'unit-test');
      Store.setSelectedPlant(priorPlant, 'unit-test');
      globalThis.fetch = priorFetch;
      globalThis.requestAnimationFrame = priorRaf;
      globalThis.NIMBUS = priorNimbus;
    },
  };
}

test('OptimizeDialog/OptimizerPreview expose the documented public API', () => {
  assert.equal(typeof OptimizeDialog.open, 'function');
  assert.equal(typeof OptimizeDialog.run, 'function');
  assert.equal(typeof OptimizerPreview.runWithPreview, 'function');
});

test('Store.lastOptimize is a detached getter and setLastOptimize remains non-emitting', () => {
  const prior = Store.lastOptimize;
  const beforeRevision = Store.rev();
  const date = new Date('2026-08-05T10:00:00Z');
  try {
    Store.setLastOptimize(date, 'unit-test');
    date.setTime(date.getTime() + 30 * 60 * 1000);
    assert.equal(Store.lastOptimize?.getTime(), new Date('2026-08-05T10:00:00Z').getTime(),
      'mutating the setter input must not mutate Store metadata');
    const read = Store.lastOptimize;
    assert.equal(read?.getTime(), new Date('2026-08-05T10:00:00Z').getTime());
    read?.setTime(new Date('2026-08-05T11:00:00Z').getTime());
    assert.equal(Store.lastOptimize?.getTime(), new Date('2026-08-05T10:00:00Z').getTime(),
      'mutating the getter result must not mutate Store metadata');
    Store.setLastOptimize(null, 'unit-test');
    assert.equal(Store.lastOptimize, null, 'null round-trips through the setter/getter');
    assert.equal(Store.rev(), beforeRevision,
      'setLastOptimize must preserve its existing no-event behavior');
  } finally {
    Store.setLastOptimize(prior, 'unit-test');
  }
});

test('combined is no longer an optimizer strategy users can select', () => {
  const { readFileSync } = require('node:fs');
  const types = readFileSync(new URL('../../../frontend/platform/types.mts', import.meta.url), 'utf8');
  const dialogMarkup = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(types, /'combined'/,
    'the public optimizer-mode type must not expose the retired strategy');
  assert.doesNotMatch(dialogMarkup, /data-mode="combined"/,
    'the optimize dialog must not render a combined strategy button');
});

test('the Strategy picker is a <select> with a \'duedate\' option, not the retired pill buttons', () => {
  const { readFileSync } = require('node:fs');
  const dialogMarkup = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');

  assert.match(dialogMarkup, /<option value="duedate"/,
    'the strategy <select> must offer a duedate option');
  assert.doesNotMatch(dialogMarkup, /opt-strategy-pill/,
    'the old .opt-strategy-pill buttons must be fully retired from the dialog markup');
});

test('OptimizeDialog.selectMode(\'duedate\') updates the strategy <select> and its hint text', () => {
  const priorDocument = globalThis.document;
  const selectEl = makeSandboxElement('opt-strategy-select', 'changeover');
  const hintEl = makeSandboxElement('opt-strategy-hint');
  const runBtn = makeSandboxElement('opt-run-btn');
  const badgeEl = makeSandboxElement('opt-wheel-badge');
  const elements = new Map([
    ['opt-strategy-select', selectEl],
    ['opt-strategy-hint', hintEl],
    ['opt-run-btn', runBtn],
    ['opt-wheel-badge', badgeEl],
  ]);
  globalThis.document = {
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeSandboxElement('created'); },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };

  try {
    OptimizeDialog.selectMode('duedate');
    assert.equal(selectEl.value, 'duedate', 'selecting duedate must set the <select> value to duedate');
    assert.ok(hintEl.textContent && hintEl.textContent.length > 0,
      'selecting duedate must populate a non-empty strategy hint');
  } finally {
    globalThis.document = priorDocument;
    // OptimizeDialog is a module-level singleton -- restore its internal mode
    // to the pre-test default so later tests in this file are unaffected.
    OptimizeDialog.selectMode('changeover');
  }
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
  assert.deepEqual(explanation.missingPairs, [],
    'the compact UI explanation does not retain missing-pair detail');
  assert.equal(explanation.missingPairsTotal, 0,
    'missing-pair detail is derived separately while the candidate is in scope');
  assert.deepEqual(explanation.search, { candidateCount: 23, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 37, limitReached: false });
  assert.equal(Object.hasOwn(explanation, 'tasks'), false, 'the compact explanation never retains a schedule snapshot');
  assert.deepEqual(explanation.overLatenessCap, { orders: 0, lines: 0, days: null },
    'without input.tasks/input.plant supplied, the due-date push-forward cap tally falls back to the no-op shape rather than throwing');

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
    unchangedLines: [], missingEdges: [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', reason: 'scheduled-without-setup' }],
  };
  const setup = {
    plant: '5512', definition: { plant: '5512', fields: ['colorWheel'], strict_blanks: true, signature_version: 1, active: false }, plant_active: false,
    plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
  };
  // Util.t() reads bare `window.__NIMBUS_LOCALES` (no locale files are loaded
  // in this ES-module test realm — see tests/modules/scheduling/persistence.test.mjs's
  // identical pattern) — stub just the key describeMissingPairs's remedy needs
  // so it interpolates real text instead of falling back to the literal key.
  globalThis.window = globalThis.window || {};
  const originalLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { 'ui.setup_missing_remedy_row': 'Add a setup matrix row for this transition' } };
  try {
    const pairs = OptimizerPreview.describeMissingPairs(candidate, [
      { id: 'red-order', PLANT: '5512', MACHINE: 'L-1', COLOR: 'RED' },
      { id: 'blue-order', PLANT: '5512', MACHINE: 'L-1', COLOR: 'BLUE' },
    ], setup);
    assert.deepEqual(pairs, {
      pairs: [{ line: 'L-1', predecessorOrderId: 'red-order', successorOrderId: 'blue-order', fromState: 'RED', toState: 'BLUE', reason: 'scheduled-without-setup', remedy: 'Add a setup matrix row for this transition' }],
      total: 1,
    });
    const csv = OptimizerPreview.missingPairsCsv(pairs.pairs);
    assert.match(csv, /From setup state,To setup state/);
    assert.match(csv, /Reason,Remedy/);
    assert.match(csv, /,RED,BLUE,/);
    // Formula-guarded and RFC-4180 quoted (senior audit): a '=' state must not execute in Excel.
    const hostile = OptimizerPreview.missingPairsCsv([{ ...pairs.pairs[0], fromState: '=HYPERLINK(1)', remedy: 'a, "b"' }]);
    assert.ok(hostile.includes(",'=HYPERLINK(1),"), 'formula prefix is neutralised');
    assert.ok(hostile.endsWith('"a, ""b"""'), 'embedded comma/quote are RFC-4180 quoted');
  } finally {
    globalThis.window.__NIMBUS_LOCALES = originalLocales;
  }
});

const MINIMAL_INPUT = {
  productionBefore: 10, productionAfter: 10, preKpis: { changeovers: 8, span_h: 20, late_count: 4, late_h: 6, peak_util_pct: 92 },
  postKpis: { changeovers: 6, span_h: 18, late_count: 2, late_h: 3, peak_util_pct: 88 },
};

test('summarizeCandidate tallies unrecorded-state and uncovered-row admissions separately', () => {
  const candidate = {
    patches: [{ id: 'a', changes: {} }, { id: 'b', changes: {} }], explanation: [], unchangedLines: [],
    diagnostics: { candidateCount: 1, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] },
    missingEdges: [
      { line: 'L1', predecessorOrderId: null, successorOrderId: 'a', reason: 'initial-state-unknown' },
      { line: 'L1', predecessorOrderId: 'a', successorOrderId: 'b', reason: 'scheduled-without-setup' },
      { line: 'L2', predecessorOrderId: 'x', successorOrderId: 'zzz-not-patched', reason: 'scheduled-without-setup' },
    ],
  };
  const explanation = OptimizerPreview.summarizeCandidate(candidate, MINIMAL_INPUT);
  assert.deepEqual(explanation.scheduledWithoutSetup, { orders: 1, lines: 1 });
  assert.deepEqual(explanation.scheduledStateUnrecorded, { orders: 1, lines: 1 });
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

test('Task 1: a local edit to an unpatched preview-plant task blocks Apply and audit', () => {
  const plant = 'TASK-BASELINE-LOCAL';
  const untouchedId = 'task-baseline-firmed';
  const candidateTaskId = 'task-baseline-free';
  const fixture = openTaskBaselinePreview(plant, [
    previewTask(untouchedId, plant, 5),
    previewTask(candidateTaskId, plant, 1),
  ], { firmedIds: [untouchedId] });
  const engineApplyEvents = [];
  const unsubscribe = Store.subscribe(event => {
    if (event.type === 'tasks:bulkUpdate' && event.source === 'engine') engineApplyEvents.push(event);
  }, 'task-1-stale-local-apply-contract');
  try {
    assert.equal(OptimizerPreview._candidate.patches.some(patch => patch.id === untouchedId), false,
      'the edited task is deliberately outside the candidate patch set');
    assert.equal(OptimizerPreview._candidate.patches.some(patch => patch.id === candidateTaskId), true,
      'the candidate contains a real schedule patch whose application can be observed');
    const scheduleBeforeApply = {
      start_date: Store.tasks[candidateTaskId].start_date,
      end_date: Store.tasks[candidateTaskId].end_date,
    };

    Store.updateTask(untouchedId, {
      start_date: new Date('2026-08-04T09:00:00'),
      end_date: new Date('2026-08-04T14:00:00'),
    }, 'manual-drag');

    assert.equal(OptimizerPreview.stale, true, 'a local schedule edit immediately stales the preview');
    assert.equal(OptimizerPreview.canApply(), false, 'the changed baseline cannot apply');
    OptimizerPreview.apply();
    assert.ok(OptimizerPreview._candidate, 'blocked Apply leaves the candidate available for discard or rerun');
    assert.deepEqual({
      start_date: Store.tasks[candidateTaskId].start_date,
      end_date: Store.tasks[candidateTaskId].end_date,
    }, scheduleBeforeApply, 'blocked Apply leaves the candidate-patched task schedule unchanged');
    assert.equal(engineApplyEvents.length, 0, 'blocked Apply emits no engine task mutation');
    assert.equal(fixture.auditRequests.length, 0, 'blocked Apply never emits the optimization audit event');
  } finally {
    unsubscribe();
    fixture.restore();
  }
});

test('Task 1: server task refresh events invalidate row-version and full-reload mismatches', () => {
  const plant = 'TASK-BASELINE-REFRESH';
  let fixture = openTaskBaselinePreview(plant, [previewTask('task-refresh', plant)]);
  try {
    Store.tasks['task-refresh'].row_version = 2;
    Store.emit({ type: 'tasks:bulkUpdate', ids: ['task-refresh'], source: 'refresh' });
    assert.equal(OptimizerPreview.stale, true, 'a refresh row-version change stales the preview');
    assert.equal(OptimizerPreview.canApply(), false);
  } finally {
    fixture.restore();
  }

  fixture = openTaskBaselinePreview(plant, [previewTask('task-reload', plant)]);
  try {
    Store.setTasks([{ ...previewTask('task-reload', plant), row_version: 2 }], 'backend');
    assert.equal(OptimizerPreview.stale, true, 'a tasks:bulk reload mismatch stales the preview');
    assert.equal(OptimizerPreview.canApply(), false);
  } finally {
    fixture.restore();
  }
});

test('Group 26: an engine re-derivation of the preview plant stales the open preview with its own banner; another plant does not', () => {
  const plant = 'TASK-PREVIEW-RECONCILE';
  const fixture = openTaskBaselinePreview(plant, [previewTask('task-rec', plant)]);
  try {
    Store.emit({ type: 'tasks:bulkUpdate', ids: ['task-not-in-preview'], source: 'engine-runtime-reconcile' });
    assert.equal(OptimizerPreview.stale, false, 'a reconcile of rows outside the preview plant is not a reason to stale it');
    // No field of the previewed row changes: the field-level baseline comparison alone would not catch this.
    Store.emit({ type: 'tasks:bulkUpdate', ids: ['task-rec'], source: 'engine-runtime-reconcile' });
    assert.equal(OptimizerPreview.stale, true, 'the reconcile marks the preview stale');
    assert.equal(OptimizerPreview.canApply(), false, 'Apply is disabled');
    assert.equal(OptimizerPreview._staleMessageKey, 'ui.preview_stale');
    assert.equal(OptimizerPreview._staleMessage(), Util.t('ui.preview_stale'), 'the banner carries the new key');
  } finally {
    fixture.restore();
  }
});

test('Task 1: edits in an unrelated plant do not stale the active preview', () => {
  const previewPlant = 'TASK-BASELINE-A';
  const otherPlant = 'TASK-BASELINE-B';
  const fixture = openTaskBaselinePreview(previewPlant, [
    previewTask('task-preview-plant', previewPlant),
    previewTask('task-other-plant', otherPlant),
  ]);
  try {
    Store.updateTask('task-other-plant', {
      start_date: new Date('2026-08-05T08:00:00'),
      end_date: new Date('2026-08-05T09:00:00'),
    }, 'manual-drag');

    assert.equal(OptimizerPreview.stale, false, 'another plant cannot invalidate this comparison');
    assert.equal(OptimizerPreview.canApply(), true, 'the unchanged preview-plant baseline remains applicable');
  } finally {
    fixture.restore();
  }
});

test('Task 1: removing a preview-plant task blocks Apply', () => {
  const plant = 'TASK-BASELINE-REMOVE';
  const remainingTaskId = 'task-remains';
  const fixture = openTaskBaselinePreview(plant, [
    previewTask('task-remove', plant),
    previewTask(remainingTaskId, plant),
  ]);
  const engineApplyEvents = [];
  const unsubscribe = Store.subscribe(event => {
    if (event.type === 'tasks:bulkUpdate' && event.source === 'engine') engineApplyEvents.push(event);
  }, 'task-1-stale-removal-apply-contract');
  try {
    assert.equal(OptimizerPreview._candidate.patches.some(patch => patch.id === remainingTaskId), true,
      'the candidate contains a surviving task patch whose application can be observed');
    const scheduleBeforeApply = {
      start_date: Store.tasks[remainingTaskId].start_date,
      end_date: Store.tasks[remainingTaskId].end_date,
    };

    Store.removeTask('task-remove', 'server-delete');

    assert.equal(OptimizerPreview.stale, true, 'removing a baseline task immediately stales the preview');
    assert.equal(OptimizerPreview.canApply(), false, 'a removed task cannot be silently recreated or bypassed');
    OptimizerPreview.apply();
    assert.deepEqual({
      start_date: Store.tasks[remainingTaskId].start_date,
      end_date: Store.tasks[remainingTaskId].end_date,
    }, scheduleBeforeApply, 'blocked Apply leaves the surviving candidate-patched task schedule unchanged');
    assert.equal(engineApplyEvents.length, 0, 'blocked Apply emits no engine task mutation');
    assert.equal(fixture.auditRequests.length, 0, 'a removal mismatch blocks the audit event too');
  } finally {
    unsubscribe();
    fixture.restore();
  }
});

test('Task 1: an unchanged baseline applies once with the engine force-save source', () => {
  const plant = 'TASK-BASELINE-APPLY';
  const fixture = openTaskBaselinePreview(plant, [
    previewTask('task-apply-long', plant, 5),
    previewTask('task-apply-short', plant, 1),
  ]);
  const applyEvents = [];
  const unsubscribe = Store.subscribe(event => {
    if (event.type === 'tasks:bulkUpdate') applyEvents.push(event);
  }, 'task-1-force-save-contract');
  try {
    assert.equal(OptimizerPreview.canApply(), true, 'an unchanged baseline is explicitly validated');

    OptimizerPreview.apply();

    assert.equal(applyEvents.length, 1, 'Apply publishes exactly one bulk task mutation');
    assert.equal(applyEvents[0].source, 'engine', 'the mutation retains the force-save source contract');
    assert.equal(fixture.auditRequests.length, 1, 'a validated Apply emits exactly one audit event');
    assert.equal(OptimizerPreview._candidate, null, 'a successful Apply clears the detached candidate');
  } finally {
    unsubscribe();
    fixture.restore();
  }
});

test('apply survives a Store revision bump from a non-schedule event (alerts recompute)', () => {
  // Regression target: OptimizerPreview.apply() runs the candidate through
  // validateCandidateForApply(candidate, snapshotSchedule(plant)), and
  // snapshotSchedule stamps readModelVersion: String(Store.rev()). Store.rev()
  // increments on every Store event -- including non-schedule ones like
  // alerts:change -- so a stale revision comparison must not block Apply when
  // no scheduling data actually changed.
  const plant = 'TASK-BASELINE-REV-BUMP';
  const fixture = openTaskBaselinePreview(plant, [
    previewTask('task-rev-bump-long', plant, 5),
    previewTask('task-rev-bump-short', plant, 1),
  ]);
  const candidate = OptimizerPreview._candidate;
  const applyEvents = [];
  const unsubscribe = Store.subscribe(event => {
    if (event.type === 'tasks:bulkUpdate') applyEvents.push(event);
  }, 'task-1-revision-bump-apply-contract');
  try {
    const revBefore = Store.rev();

    Store.setAlerts([], 'alerts');

    assert.ok(Store.rev() > revBefore, 'a Store event bumps the revision counter even for non-schedule state');
    assert.equal(OptimizerPreview.canApply(), true,
      'a revision-only change from an unrelated Store event must not block Apply');

    OptimizerPreview.apply();

    assert.equal(
      (candidate.validationFindings ?? []).some(finding => finding.code === 'stale_candidate'),
      false,
      'Apply must not attach a stale_candidate finding for a revision bump with no schedule change');
    assert.equal(applyEvents.length, 1, 'Apply publishes exactly one bulk task mutation');
    assert.equal(applyEvents[0].source, 'engine', 'the mutation retains the force-save source contract');
    assert.equal(fixture.auditRequests.length, 1, 'a validated Apply emits exactly one audit event');
    assert.equal(OptimizerPreview._candidate, null, 'a successful Apply clears the detached candidate');
  } finally {
    unsubscribe();
    fixture.restore();
  }
});

test('OptimizerPreview keeps trial patches detached until Apply, then commits them once', () => {
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorTimelineItems = Timeline._items;
  const priorPlant = Store.selectedPlant;
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorScheduleRecomputeLines = Alerts.scheduleRecomputeLines;
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
  Alerts.scheduleRecomputeLines = () => {};
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
    Alerts.scheduleRecomputeLines = priorScheduleRecomputeLines;
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
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
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

// Single-reveal fixture: a fake #modal-opt-preview / #opt-preview-body that counts
// every body rewrite and records _finalists at each one, plus a sync rAF.
function openSingleRevealFixture(plant, tasks) {
  const priorRaf = globalThis.requestAnimationFrame;
  const priorNimbus = globalThis.NIMBUS;
  const priorDocument = globalThis.document;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorScheduleRecompute = Alerts.scheduleRecompute;
  const priorObserver = globalThis.MutationObserver;
  const priorGuard = OptimizerPreview._abandonGuardInstalled;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  OptimizerPreview._abandonGuardInstalled = false;
  const root = makeSandboxElement('modal-opt-preview');
  root.hidden = true;
  const body = makeSandboxElement('opt-preview-body');
  const writes = [];
  let html = '';
  Object.defineProperty(body, 'innerHTML', {
    get() { return html; },
    set(value) { html = value; writes.push({ html: value, finalists: OptimizerPreview._finalists }); },
  });
  const elements = new Map([['modal-opt-preview', root], ['opt-preview-body', body]]);
  globalThis.document = {
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return makeSandboxElement('created'); },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  globalThis.requestAnimationFrame = callback => { callback(performance.now()); return 1; };
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  Store.setTasks(tasks, 'unit-test');
  Store.setSelectedPlant(plant, 'unit-test');
  return {
    root, body, writes,
    restore() {
      OptimizerPreview._clear();
      Alerts.scheduleRecompute = priorScheduleRecompute;
      Store.setTasks(priorTasks, 'unit-test');
      Store.setSelectedPlant(priorPlant, 'unit-test');
      globalThis.document = priorDocument;
      globalThis.requestAnimationFrame = priorRaf;
      globalThis.NIMBUS = priorNimbus;
      globalThis.MutationObserver = priorObserver;
      OptimizerPreview._abandonGuardInstalled = priorGuard;
    },
  };
}

const singleRevealTasks = [
  { id: 'sr-long', PLANT: 'SR', MACHINE: 'L1', RUN_TIME: 5, start_date: null, end_date: null },
  { id: 'sr-short', PLANT: 'SR', MACHINE: 'L1', RUN_TIME: 1, start_date: null, end_date: null },
];

test('single reveal: spinner only until alternates finish, then the body is rendered once with _finalists set', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview.showLoading('spt', 'SR');
    assert.ok(fx.root.classList.contains('opt-pv-loading'), 'showLoading hides the card (spinner only)');
    assert.equal(fx.writes.length, 1, 'showLoading writes the body once');
    OptimizerPreview.runWithPreview('spt', { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00') });

    assert.equal(fx.writes.length, 1, 'runWithPreview must not rewrite the loading body a second time');
    assert.ok(fx.root.classList.contains('opt-pv-loading'), 'card stays hidden while alternates compute');
    assert.equal(OptimizerPreview._finalists, null);

    for (let i = 0; i < 200 && fx.root.classList.contains('opt-pv-loading'); i++) await wait(10);

    assert.ok(!fx.root.classList.contains('opt-pv-loading'), 'card is revealed once everything is done');
    assert.equal(fx.writes.length, 2, 'exactly one results render after the spinner, none for the comparison');
    assert.ok(Array.isArray(fx.writes[1].finalists) && fx.writes[1].finalists.length > 1,
      '_finalists is already populated at the first results render');
    assert.match(fx.writes[1].html, /opt-pv-plan-table/, 'the first render already contains the plan comparison table');
    await wait(50);
    assert.equal(fx.writes.length, 2, 'nothing re-renders the body afterwards');
  } finally {
    fx.restore();
  }
});

test('single reveal: discarding while alternates compute clears the loading class and never renders', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview.showLoading('spt', 'SR');
    OptimizerPreview.runWithPreview('spt', { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00') });
    OptimizerPreview.discard();

    assert.ok(!fx.root.classList.contains('opt-pv-loading'), 'discard clears the loading state');
    await wait(100);
    assert.equal(fx.writes.length, 1, 'the superseded run never renders into the closed preview');
    assert.equal(OptimizerPreview._finalists, null);
  } finally {
    fx.restore();
  }
});

test('single reveal: an evaluation error clears the loading class and shows the error card', () => {
  const fx = openSingleRevealFixture('SR-FAIL', [
    { id: 'sr-fail', PLANT: 'SR-FAIL', MACHINE: 'F1', RUN_TIME: 1, start_date: new Date(), end_date: new Date() },
  ]);
  const priorSave = ErrorLog._scheduleSave;
  const priorShip = ErrorLog._scheduleShip;
  const priorEntries = ErrorLog.entries();
  ErrorLog._scheduleSave = () => {};
  ErrorLog._scheduleShip = () => {};
  try {
    OptimizerPreview.showLoading('backlog', 'SR-FAIL');
    assert.ok(fx.root.classList.contains('opt-pv-loading'));
    OptimizerPreview.runWithPreview('backlog', { plant: 'SR-FAIL', respectCalendar: true });

    assert.ok(!fx.root.classList.contains('opt-pv-loading'), 'error path reveals the card so the message is visible');
    assert.match(fx.body.innerHTML, /candidate|opt_pv_failed|failed|Unknown error|\w/, 'an error body is written');
    assert.equal(OptimizerPreview._previewDiagnostics?.[0]?.code, 'candidate-evaluation-failed');
  } finally {
    ErrorLog._entries = priorEntries;
    ErrorLog._scheduleSave = priorSave;
    ErrorLog._scheduleShip = priorShip;
    fx.restore();
  }
});

test('SandboxAdapter restores optimizer side effects on What-If discard before alert recompute', () => {
  const plant = 'WHAT-IF-DISCARD';
  const baselineLastOptimize = new Date('2026-08-01T10:00:00Z');
  const baselineDismissed = new Set(['what-if-alert-a', 'what-if-alert-b']);
  const baselineConfidence = { score: 82, history: [{ ts: 1, score: 82 }] };
  const baselineTasks = [
    { id: 'what-if-long', PLANT: plant, MACHINE: 'WHAT-IF-LINE', RUN_TIME: 5, start_date: null, end_date: null },
    { id: 'what-if-short', PLANT: plant, MACHINE: 'WHAT-IF-LINE', RUN_TIME: 1, start_date: null, end_date: null },
  ];
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorLastOptimize = Store.lastOptimize;
  const priorDismissed = Alerts.snapshotDismissed();
  const priorSchedule = Alerts.scheduleRecompute;
  const priorEntries = UndoStack._entries.slice();
  const confidence = {
    score: baselineConfidence.score,
    history: baselineConfidence.history.map(item => ({ ...item })),
    restoreCalls: 0,
    snapshot() {
      return { score: this.score, history: this.history.map(item => ({ ...item })) };
    },
    restore(snapshot) {
      this.restoreCalls++;
      this.score = snapshot.score;
      this.history = snapshot.history.map(item => ({ ...item }));
    },
  };
  const recomputeObservations = [];
  globalThis.NIMBUS = { Confidence: confidence };
  Alerts.scheduleRecompute = () => {
    recomputeObservations.push({
      lastOptimize: Store.lastOptimize?.getTime() ?? null,
      dismissed: new Set(Alerts.snapshotDismissed()),
      confidence: { score: confidence.score, history: confidence.history.map(item => ({ ...item })) },
    });
  };
  const unsubscribeAdapter = Store.subscribe(event => {
    if (event.type === 'sandbox:entered') SandboxAdapter._onEntered();
    else if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
    else if (event.type === 'sandbox:reverted') SandboxAdapter._onReverted();
  }, 'unit-test-sandbox-adapter');

  try {
    Store.setTasks(baselineTasks, 'unit-test');
    const beforeTasks = structuredClone(Store.tasksArr);
    Store.setSelectedPlant(plant, 'unit-test');
    Store.setLastOptimize(baselineLastOptimize, 'unit-test');
    Alerts.restoreDismissed(baselineDismissed);
    Sandbox.enter('unit-test');

    confidence.score = 41;
    confidence.history.push({ ts: 2, score: 41 });
    Engine.runAndApply('spt', { plant, respectFirmed: true, respectCalendar: false });
    assert.notDeepEqual(Store.tasksArr, beforeTasks,
      'the optimizer run must change the What-If schedule before discard restores it');
    assert.notEqual(Store.lastOptimize?.getTime(), baselineLastOptimize.getTime(),
      'the optimizer run must change last-optimize metadata before discard');
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(),
      'the optimizer run clears dismissals in the What-If state');

    // Ignore the optimizer's own pending debounce request; discard replaces it
    // with the one post-restore request whose inputs are asserted below.
    recomputeObservations.length = 0;
    Sandbox.exit(false, 'unit-test');

    assert.deepEqual(Store.tasksArr, beforeTasks, 'discard restores the pre-optimizer task state');
    assert.equal(Store.lastOptimize?.getTime(), baselineLastOptimize.getTime(),
      'discard restores last-optimize metadata');
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), baselineDismissed,
      'discard restores alert dismissal IDs');
    assert.deepEqual({ score: confidence.score, history: confidence.history }, baselineConfidence,
      'discard restores Confidence state');
    assert.equal(confidence.restoreCalls, 1, 'discard restores Confidence exactly once');
    assert.equal(recomputeObservations.length, 1, 'discard schedules exactly one adapter alert recompute');
    assert.equal(recomputeObservations[0].lastOptimize, baselineLastOptimize.getTime(),
      'alert recompute sees restored last-optimize metadata');
    assert.deepEqual(recomputeObservations[0].dismissed, baselineDismissed,
      'alert recompute sees the restored dismissal set');
    assert.deepEqual(recomputeObservations[0].confidence, baselineConfidence,
      'alert recompute runs after Confidence restoration');
    assert.equal(SandboxAdapter._confSnapshot, null, 'discard clears the Confidence snapshot');
    assert.equal(SandboxAdapter._lastOptimizeSnapshot, null, 'discard clears the last-optimize snapshot');
    assert.equal(SandboxAdapter._dismissedSnapshot, null, 'discard clears the dismissal snapshot');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Alerts.scheduleRecompute = priorSchedule;
    Alerts.restoreDismissed(priorDismissed);
    Store.setLastOptimize(priorLastOptimize, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    UndoStack._entries.length = 0;
    UndoStack._entries.push(...priorEntries);
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter retains promoted side effects and clears snapshots on promote and revert', () => {
  const baselineLastOptimize = new Date('2026-08-03T10:00:00Z');
  const promotedLastOptimize = new Date('2026-08-04T10:00:00Z');
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorLastOptimize = Store.lastOptimize;
  const priorDismissed = Alerts.snapshotDismissed();
  const priorSchedule = Alerts.scheduleRecompute;
  const priorEntries = UndoStack._entries.slice();
  const confidence = {
    score: 77,
    history: [{ ts: 3, score: 77 }],
    snapshot() { return { score: this.score, history: this.history.map(item => ({ ...item })) }; },
    restore(snapshot) { this.score = snapshot.score; this.history = snapshot.history.map(item => ({ ...item })); },
  };
  let recomputeCalls = 0;
  globalThis.NIMBUS = {
    Confidence: confidence,
    Persistence: { saveAll() {} },
  };
  Alerts.scheduleRecompute = () => { recomputeCalls++; };
  const unsubscribeAdapter = Store.subscribe(event => {
    if (event.type === 'sandbox:entered') SandboxAdapter._onEntered();
    else if (event.type === 'sandbox:exited') SandboxAdapter._onExited(event);
    else if (event.type === 'sandbox:reverted') SandboxAdapter._onReverted();
  }, 'unit-test-sandbox-adapter');

  try {
    Store.setTasks([{ id: 'what-if-promote', PLANT: 'WHAT-IF-PROMOTE', MACHINE: 'PROMOTE-LINE', RUN_TIME: 1 }], 'unit-test');
    Store.setSelectedPlant(null, 'unit-test');
    Store.setLastOptimize(baselineLastOptimize, 'unit-test');
    Alerts.restoreDismissed(new Set(['before-promote']));
    Sandbox.enter('unit-test');

    Store.setLastOptimize(promotedLastOptimize, 'unit-test');
    Alerts.restoreDismissed(new Set(['after-promote']));
    confidence.score = 63;
    Sandbox.exit(true, 'unit-test');

    assert.equal(Store.lastOptimize?.getTime(), promotedLastOptimize.getTime(),
      'promote retains the trial last-optimize metadata');
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['after-promote']),
      'promote retains trial alert dismissals');
    assert.equal(confidence.score, 63, 'promote retains trial Confidence state');
    assert.equal(SandboxAdapter._confSnapshot, null, 'promote clears the Confidence snapshot');
    assert.equal(SandboxAdapter._lastOptimizeSnapshot, null, 'promote clears the last-optimize snapshot');
    assert.equal(SandboxAdapter._dismissedSnapshot, null, 'promote clears the dismissal snapshot');

    // A promoted scenario's later undo emits the revert event. It should clear
    // any stale adapter snapshot but must not roll side effects back to the
    // pre-sandbox baseline that was intentionally promoted away.
    SandboxAdapter._confSnapshot = { score: 1, history: [] };
    SandboxAdapter._lastOptimizeSnapshot = baselineLastOptimize;
    SandboxAdapter._dismissedSnapshot = new Set(['before-promote']);
    UndoStack.pop();
    assert.equal(Store.lastOptimize?.getTime(), promotedLastOptimize.getTime(),
      'revert does not restore pre-promote metadata');
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['after-promote']),
      'revert does not restore pre-promote dismissals');
    assert.equal(confidence.score, 63, 'revert does not restore pre-promote Confidence');
    assert.equal(SandboxAdapter._confSnapshot, null, 'revert clears the Confidence snapshot');
    assert.equal(SandboxAdapter._lastOptimizeSnapshot, null, 'revert clears the last-optimize snapshot');
    assert.equal(SandboxAdapter._dismissedSnapshot, null, 'revert clears the dismissal snapshot');
    assert.equal(recomputeCalls, 2, 'promote and later revert each retain their post-teardown alert recompute');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Alerts.scheduleRecompute = priorSchedule;
    Alerts.restoreDismissed(priorDismissed);
    Store.setLastOptimize(priorLastOptimize, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    UndoStack._entries.length = 0;
    UndoStack._entries.push(...priorEntries);
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter restores null and non-null last-optimize baselines on discard', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorLastOptimize = Store.lastOptimize;
  const priorDismissed = Alerts.snapshotDismissed();
  const priorSchedule = Alerts.scheduleRecompute;
  const restoreObservations = [];
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => restoreObservations.push(Store.lastOptimize?.getTime() ?? null);
  const unsubscribeAdapter = subscribeSandboxAdapter();

  try {
    for (const baseline of [null, new Date('2026-08-06T10:00:00Z')]) {
      Store.setSelectedPlant(null, 'unit-test');
      Store.setLastOptimize(baseline, 'unit-test');
      Alerts.restoreDismissed(new Set(['baseline-dismissal']));
      Sandbox.enter('unit-test');
      Store.setLastOptimize(new Date('2026-08-06T11:00:00Z'), 'unit-test');
      Alerts.restoreDismissed(new Set(['trial-dismissal']));
      Sandbox.exit(false, 'unit-test');

      assert.equal(Store.lastOptimize?.getTime() ?? null, baseline?.getTime() ?? null,
        'discard restores both null and non-null metadata baselines');
      assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['baseline-dismissal']),
        'discard restores the dismissal baseline for each metadata case');
    }
    assert.deepEqual(restoreObservations, [null, new Date('2026-08-06T10:00:00Z').getTime()],
      'each discard recomputes only after the matching metadata baseline is restored');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Alerts.scheduleRecompute = priorSchedule;
    Alerts.restoreDismissed(priorDismissed);
    Store.setLastOptimize(priorLastOptimize, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter cancels pending Confidence debounce before What-If discard', async () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSchedule = Alerts.scheduleRecompute;
  const baseline = { score: 91, history: [{ ts: 1, score: 91 }] };
  let timer = null;
  let cancelCalls = 0;
  const confidence = {
    score: baseline.score,
    history: baseline.history.map(item => ({ ...item })),
    snapshot() { return { score: this.score, history: this.history.map(item => ({ ...item })) }; },
    restore(snapshot) {
      this.score = snapshot.score;
      this.history = snapshot.history.map(item => ({ ...item }));
    },
    _recomputeDebounced() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        this.score = 12;
        this.history.push({ ts: 2, score: 12 });
      }, 400);
    },
    _invalidatePending() {
      cancelCalls++;
      clearTimeout(timer);
      timer = null;
    },
    _cancelRecomputeDebounced() {
      this._invalidatePending();
    },
  };
  globalThis.NIMBUS = { Confidence: confidence };
  Alerts.scheduleRecompute = () => {};
  const unsubscribeAdapter = subscribeSandboxAdapter();

  try {
    Store.setTasks([{ id: 'confidence-discard', PLANT: 'CONFIDENCE', MACHINE: 'CONF-LINE', RUN_TIME: 1 }], 'unit-test');
    Sandbox.enter('unit-test');
    cancelCalls = 0;
    confidence.score = 34;
    confidence.history.push({ ts: 2, score: 34 });
    confidence._recomputeDebounced();
    Sandbox.exit(false, 'unit-test');

    await wait(450);
    assert.equal(cancelCalls, 1, 'discard cancels the already-armed Confidence debounce');
    assert.deepEqual({ score: confidence.score, history: confidence.history }, baseline,
      'a delayed Confidence recompute cannot overwrite the restored discard snapshot');
  } finally {
    clearTimeout(timer);
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Alerts.scheduleRecompute = priorSchedule;
    Store.setTasks(priorTasks, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter refreshes post-promote worker alerts after the trial revision changes', async () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorAlerts = structuredClone(Store.alerts);
  const priorAvailable = Compute.available;
  const priorAlertsCompute = Compute.alerts;
  const priorFlushPlant = CalendarSync.flushPlant;
  const priorToast = Toast.show;
  const priorEntries = UndoStack._entries.slice();
  const priorTimer = Alerts._timer;
  const priorPendingFull = Alerts._pendingFull;
  const priorPendingLines = new Set(Alerts._pendingLines);
  const requests = [];
  const unsubscribeAdapter = subscribeSandboxAdapter();
  if (Alerts._timer) clearTimeout(Alerts._timer);
  Alerts._timer = null;
  Alerts._pendingFull = false;
  Alerts._pendingLines = new Set();
  Compute.available = () => true;
  Compute.alerts = () => new Promise(resolve => requests.push(resolve));
  CalendarSync.flushPlant = () => {};
  Toast.show = () => {};
  globalThis.NIMBUS = { Persistence: { saveAll() {} } };

  try {
    Store.setTasks([{ id: 'worker-promote', PLANT: 'WORKER-PROMOTE', MACHINE: 'WP-LINE', RUN_TIME: 1 }], 'unit-test');
    Store.setSelectedPlant('WORKER-PROMOTE', 'unit-test');
    Store.setAlerts([], 'unit-test');
    Sandbox.enter('unit-test');
    Alerts.recompute();
    assert.equal(requests.length, 1, 'the trial creates the first worker alert request');

    const revisionBeforePromote = Store.rev();
    Sandbox.exit(true, 'unit-test');
    assert.ok(Store.rev() > revisionBeforePromote, 'promotion changes the Store revision');

    requests[0]({ alerts: [{ id: 'stale-worker-alert', taskId: 'worker-promote' }], elapsed: 1 });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(Store.alerts, [], 'the invalidated pre-promote worker result is discarded');

    await wait(120);
    assert.equal(requests.length, 2, 'promotion schedules a replacement full worker request');
    requests[1]({ alerts: [{ id: 'fresh-worker-alert', taskId: 'worker-promote' }], elapsed: 1 });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(Store.alerts.map(alert => alert.id), ['fresh-worker-alert'],
      'the post-promote worker result is applied');
  } finally {
    if (Alerts._timer) clearTimeout(Alerts._timer);
    Alerts._timer = priorTimer;
    Alerts._pendingFull = priorPendingFull;
    Alerts._pendingLines = priorPendingLines;
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Compute.available = priorAvailable;
    Compute.alerts = priorAlertsCompute;
    CalendarSync.flushPlant = priorFlushPlant;
    Toast.show = priorToast;
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    UndoStack._entries.length = 0;
    UndoStack._entries.push(...priorEntries);
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter.init wires real buttons and promotes every affected plant', () => {
  const priorDocument = globalThis.document;
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorBlocks = structuredClone(Store.blocks);
  const priorCalendars = structuredClone(Store.calendars);
  const priorPlants = structuredClone(Store.plants);
  const priorPlantBlocks = structuredClone(Store.plantBlocks);
  const priorMasterData = structuredClone(Store.masterData);
  const priorLastOptimize = Store.lastOptimize;
  const priorDismissed = Alerts.snapshotDismissed();
  const priorAlerts = structuredClone(Store.alerts);
  const priorSchedule = Alerts.scheduleRecompute;
  const priorFlushPlant = CalendarSync.flushPlant;
  const priorToast = Toast.show;
  const priorEntries = UndoStack._entries.slice();
  const fixture = makeSandboxDocument();
  const saveCalls = [];
  const scheduleCalls = [];
  const flushCalls = [];
  const toastCalls = [];
  const confidence = {
    score: 80,
    history: [{ ts: 1, score: 80 }],
    snapshot() { return { score: this.score, history: this.history.map(item => ({ ...item })) }; },
    restore(snapshot) { this.score = snapshot.score; this.history = snapshot.history.map(item => ({ ...item })); },
  };
  globalThis.document = fixture.document;
  globalThis.NIMBUS = {
    Confidence: confidence,
    Persistence: { saveAll() { saveCalls.push(true); } },
  };
  Alerts.scheduleRecompute = () => scheduleCalls.push(true);
  CalendarSync.flushPlant = (plant, removed) => flushCalls.push({ plant, removed });
  Toast.show = (...args) => toastCalls.push(args);

  try {
    Store.setMasterData({
      plants: [{ plant: 'P1' }, { plant: 'P2' }],
      lines: [{ machine: 'L1', plant: 'P1' }, { machine: 'L2', plant: 'P2' }],
    }, 'unit-test');
    Store.setTasks([
      { id: 'adapter-task-1', PLANT: 'P1', MACHINE: 'L1', RUN_TIME: 1 },
      { id: 'adapter-task-2', PLANT: 'P2', MACHINE: 'L2', RUN_TIME: 1 },
    ], 'unit-test');
    Store.replacePlants({
      P1: { workHours: { 0: [8, 16] } },
      P2: { workHours: { 0: [8, 16] } },
    }, 'unit-test');
    Store.replaceCalendars({
      L1: { workHours: { 0: [8, 16] } },
      L2: { workHours: { 0: [8, 16] } },
    }, 'unit-test');
    Store.replaceBlocks([
      { id: 'old-line-p1', plant: 'P1', line: 'L1', start: '2026-08-01T00:00:00Z', end: '2026-08-01T01:00:00Z' },
      { id: 'old-line-p2', plant: 'P2', line: 'L2', start: '2026-08-01T00:00:00Z', end: '2026-08-01T01:00:00Z' },
    ], 'unit-test');
    Store.replacePlantBlocks([
      { id: 'old-plant-p1', plant: 'P1', start: '2026-08-02T00:00:00Z', end: '2026-08-02T01:00:00Z' },
      { id: 'old-plant-p2', plant: 'P2', start: '2026-08-02T00:00:00Z', end: '2026-08-02T01:00:00Z' },
    ], 'unit-test');
    Store.setSelectedPlant('P1', 'unit-test');
    Store.setLastOptimize(new Date('2026-08-07T10:00:00Z'), 'unit-test');
    Alerts.restoreDismissed(new Set(['before-discard']));

    SandboxAdapter.init();
    SandboxAdapter.enter();
    assert.equal(fixture.sandboxButtons[0].onclick, null,
      'enter clears the existing sandbox toggle handler while What-If is active');
    Store.setLastOptimize(new Date('2026-08-07T11:00:00Z'), 'unit-test');
    Alerts.restoreDismissed(new Set());
    fixture.elements.get('sb-discard-btn').dispatch('click');
    assert.equal(Sandbox.active, false, 'the real discard button exits What-If mode');
    assert.equal(typeof fixture.sandboxButtons[0].onclick, 'function',
      'discard restores the existing sandbox toggle handler');
    assert.equal(fixture.elements.get('sandbox-banner').hidden, true, 'discard tears down the banner');
    assert.equal(fixture.body.classList.contains('sandbox-mode'), false, 'discard tears down body mode');
    assert.equal(Store.lastOptimize?.getTime(), new Date('2026-08-07T10:00:00Z').getTime());
    assert.deepEqual(new Set(Alerts.snapshotDismissed()), new Set(['before-discard']));
    assert.equal(saveCalls.length, 0, 'discard does not persist');
    assert.equal(flushCalls.length, 0, 'discard does not flush calendar state');

    scheduleCalls.length = 0;
    Store.setSelectedPlant('P1', 'unit-test');
    SandboxAdapter.enter();
    Store.removeBlock('old-line-p1', 'unit-test');
    Store.removePlantBlock('old-plant-p1', 'unit-test');
    Store.setPlantWorkHours('P1', 0, [9, 17], 'unit-test');
    Store.setCalendar('L1', { 0: [9, 17] }, 'unit-test');
    Store.addBlock({ id: 'new-line-p1', plant: 'P1', line: 'L1', start: '2026-08-03T00:00:00Z', end: '2026-08-03T01:00:00Z' }, 'unit-test');
    Store.addPlantBlock({ id: 'new-plant-p1', plant: 'P1', start: '2026-08-04T00:00:00Z', end: '2026-08-04T01:00:00Z' }, 'unit-test');
    Store.setPlantWorkHours('P2', 0, [10, 18], 'unit-test');
    Store.setCalendar('L2', { 0: [10, 18] }, 'unit-test');
    Store.addBlock({ id: 'new-line-p2', plant: 'P2', line: 'L2', start: '2026-08-05T00:00:00Z', end: '2026-08-05T01:00:00Z' }, 'unit-test');
    Store.addPlantBlock({ id: 'new-plant-p2', plant: 'P2', start: '2026-08-06T00:00:00Z', end: '2026-08-06T01:00:00Z' }, 'unit-test');
    Store.setSelectedPlant('P2', 'unit-test');
    Store.setLastOptimize(new Date('2026-08-07T12:00:00Z'), 'unit-test');
    Alerts.restoreDismissed(new Set(['after-promote']));
    fixture.elements.get('sb-apply-btn').dispatch('click');

    assert.equal(Sandbox.active, false, 'the real promote button exits What-If mode');
    assert.equal(saveCalls.length, 1, 'promote persists once');
    assert.deepEqual(flushCalls.map(call => call.plant).sort(), ['P1', 'P2'],
      'promote flushes every plant changed during the sandbox, even after selection switches');
    const p1Flush = flushCalls.find(call => call.plant === 'P1');
    assert.deepEqual(p1Flush.removed, { line: ['old-line-p1'], plant: ['old-plant-p1'] },
      'promote flushes the exact line and plant blackout IDs deleted in the sandbox');
    assert.ok(!Store.blocks.some(block => block.id === 'old-line-p1'),
      'a promoted line blackout deletion must not be recreated locally');
    assert.ok(!Store.plantBlocks.some(block => block.id === 'old-plant-p1'),
      'a promoted plant blackout deletion must not be recreated locally');
    assert.equal(scheduleCalls.length, 1, 'promote schedules one post-teardown alert recompute');
    assert.equal(fixture.elements.get('sandbox-banner').hidden, true, 'promote tears down the banner');
    assert.equal(fixture.body.classList.contains('sandbox-mode'), false, 'promote tears down body mode');
    assert.equal(SandboxAdapter._sideEffectSnapshotActive, false, 'promote clears the side-effect snapshot');
    assert.ok(toastCalls.some(args => args[0] === 'toast.scenario_applied'), 'promote uses the existing success toast');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    SandboxAdapter._clearSideEffectSnapshot?.();
    Alerts.scheduleRecompute = priorSchedule;
    CalendarSync.flushPlant = priorFlushPlant;
    Toast.show = priorToast;
    Alerts.restoreDismissed(priorDismissed);
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceBlocks(priorBlocks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.replacePlants(priorPlants, 'unit-test');
    Store.replacePlantBlocks(priorPlantBlocks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setLastOptimize(priorLastOptimize, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    UndoStack._entries.length = 0;
    UndoStack._entries.push(...priorEntries);
    globalThis.NIMBUS = priorNimbus;
    globalThis.document = priorDocument;
  }
});

test('SandboxAdapter promotes calendar edits for explicit task plants without line master data', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const priorMasterData = structuredClone(Store.masterData);
  const priorFlushPlant = CalendarSync.flushPlant;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorToast = Toast.show;
  const flushCalls = [];
  globalThis.NIMBUS = { Persistence: { saveAll() {} } };
  CalendarSync.flushPlant = (plant, removed) => flushCalls.push({ plant, removed });
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};

  try {
    Store.setMasterData({ plants: [{ plant: 'UNMAPPED-PLANT' }], lines: [] }, 'unit-test');
    Store.setTasks([
      { id: 'unmapped-task-plant', PLANT: 'UNMAPPED-PLANT', MACHINE: 'UNMAPPED-LINE', RUN_TIME: 1 },
    ], 'unit-test');
    Store.replaceCalendars({ 'UNMAPPED-LINE': { workHours: { 0: [8, 16] } } }, 'unit-test');
    Sandbox.enter('unit-test');
    Store.setCalendar('UNMAPPED-LINE', { 0: [9, 17] }, 'unit-test');
    Sandbox.exit(true, 'unit-test');

    assert.deepEqual(flushCalls.map(call => call.plant), ['UNMAPPED-PLANT'],
      'an explicit task PLANT is the fallback owner for an unmapped calendar line');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    SandboxAdapter._clearSideEffectSnapshot?.();
    CalendarSync.flushPlant = priorFlushPlant;
    Alerts.scheduleRecompute = priorSchedule;
    Toast.show = priorToast;
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('SandboxAdapter promotes changed line hours after the only task owner disappears', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorCalendars = structuredClone(Store.calendars);
  const priorMasterData = structuredClone(Store.masterData);
  const priorPost = CalendarSync._post;
  const priorSavePlantHours = CalendarSync.savePlantHours;
  const priorSchedule = Alerts.scheduleRecompute;
  const priorToast = Toast.show;
  const lineHourCalls = [];
  const unsubscribeAdapter = subscribeSandboxAdapter();
  globalThis.NIMBUS = { Persistence: { saveAll() {} } };
  CalendarSync.savePlantHours = () => Promise.resolve({ ok: true });
  CalendarSync._post = (path, body, label) => {
    lineHourCalls.push({ path, body, label });
    return Promise.resolve({ ok: true });
  };
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};

  try {
    Store.setMasterData({ plants: [{ plant: 'OWNER-DISAPPEARS' }], lines: [] }, 'unit-test');
    Store.setTasks([
      { id: 'owner-task', PLANT: 'OWNER-DISAPPEARS', MACHINE: 'OWNERLESS-LINE', RUN_TIME: 1 },
    ], 'unit-test');
    Store.replaceCalendars({ 'OWNERLESS-LINE': { workHours: { 0: [8, 16] } } }, 'unit-test');

    Sandbox.enter('unit-test');
    Store.setCalendar('OWNERLESS-LINE', { 0: [9, 17] }, 'unit-test');
    Store.removeTask('owner-task', 'unit-test');
    Sandbox.exit(true, 'unit-test');

    const promoted = lineHourCalls.find(call => call.path === '/plant-calendar/line-hours');
    assert.ok(promoted, 'promotion still sends line hours for the changed calendar line');
    assert.deepEqual(promoted.body.lines.map(line => line.machine), ['OWNERLESS-LINE'],
      'promotion uses the captured pre-sandbox line owner when current task lookup is empty');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    CalendarSync._post = priorPost;
    CalendarSync.savePlantHours = priorSavePlantHours;
    Alerts.scheduleRecompute = priorSchedule;
    Toast.show = priorToast;
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
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

test('#26 What-If discard restores the dirty/force sets captured at entry (App._trackDirty clears them on tasks:bulk)', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorDoc = globalThis.document;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSchedule = Alerts.scheduleRecompute;
  const priorToast = Toast.show;
  const priorDirty = new Set(Persistence._dirtyIds);
  const priorForce = new Set(Persistence._forceIds);
  const fixture = makeSandboxDocument();
  globalThis.document = fixture.document;
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};
  // Mirrors App._trackDirty's `tasks:bulk` branch (the real subscriber lives in application-shell).
  const offTrack = Store.subscribe(evt => {
    if (evt.type === 'tasks:bulk') { Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); }
  }, 'unit-test-track-dirty');
  const offAdapter = subscribeSandboxAdapter();
  try {
    Store.setTasks([{ id: 'wd-1', PLANT: 'WD', MACHINE: 'WD-L', RUN_TIME: 1 }], 'unit-test');
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    Persistence._dirtyIds.add('pre-dirty');
    Persistence._forceIds.add('pre-force');
    Sandbox.enter('unit-test');
    Persistence._dirtyIds.add('trial-dirty');
    Sandbox.exit(false, 'unit-test');
    assert.deepEqual([...Persistence._dirtyIds], ['pre-dirty'], 'pre-What-If unsaved edits survive discard; trial ids do not');
    assert.deepEqual([...Persistence._forceIds], ['pre-force']);
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    offAdapter(); offTrack();
    SandboxAdapter._clearSideEffectSnapshot();
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
    for (const id of priorDirty) Persistence._dirtyIds.add(id);
    for (const id of priorForce) Persistence._forceIds.add(id);
    Alerts.scheduleRecompute = priorSchedule;
    Toast.show = priorToast;
    Store.setTasks(priorTasks, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
    globalThis.document = priorDoc;
  }
});

test('#27 undo of an APPLIED What-If restores calendar slices and re-syncs the backend for the touched plant', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorDoc = globalThis.document;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorBlocks = structuredClone(Store.blocks);
  const priorPlantBlocks = structuredClone(Store.plantBlocks);
  const priorCalendars = structuredClone(Store.calendars);
  const priorPlants = structuredClone(Store.plants);
  const priorMasterData = structuredClone(Store.masterData);
  const priorSchedule = Alerts.scheduleRecompute;
  const priorFlush = CalendarSync.flushPlant;
  const priorToast = Toast.show;
  const priorEntries = UndoStack._entries.slice();
  const fixture = makeSandboxDocument();
  const flushCalls = [];
  globalThis.document = fixture.document;
  globalThis.NIMBUS = { Persistence: { saveAll() {} } };
  Alerts.scheduleRecompute = () => {};
  Toast.show = () => {};
  CalendarSync.flushPlant = (plant, removed) => flushCalls.push({ plant, removed });
  const offAdapter = subscribeSandboxAdapter();
  try {
    Store.setMasterData({ plants: [{ plant: 'UP' }], lines: [{ machine: 'UL', plant: 'UP' }] }, 'unit-test');
    Store.setTasks([{ id: 'ua-1', PLANT: 'UP', MACHINE: 'UL', RUN_TIME: 1 }], 'unit-test');
    Store.replaceCalendars({ UL: { workHours: { 0: [8, 16] } } }, 'unit-test');
    Store.replacePlants({ UP: { workHours: { 0: [8, 16] } } }, 'unit-test');
    Store.replaceBlocks([{ id: 'ub-old', plant: 'UP', line: 'UL', start: '2026-08-01T00:00:00Z', end: '2026-08-01T01:00:00Z' }], 'unit-test');
    Store.replacePlantBlocks([], 'unit-test');
    UndoStack._entries.length = 0;

    Sandbox.enter('unit-test');
    Store.removeBlock('ub-old', 'unit-test');
    Store.addBlock({ id: 'ub-new', plant: 'UP', line: 'UL', start: '2026-08-03T00:00:00Z', end: '2026-08-03T01:00:00Z' }, 'unit-test');
    Store.setCalendar('UL', { 0: [9, 17] }, 'unit-test');
    Sandbox.exit(true, 'unit-test');
    flushCalls.length = 0; // the promote flush is not under test

    UndoStack.pop();
    assert.deepEqual(Store.blocks.map(b => b.id), ['ub-old'], 'undo restores the pre-What-If blackouts');
    assert.deepEqual(Store.calendars.UL.workHours[0], [8, 16], 'undo restores the pre-What-If line hours');
    assert.equal(flushCalls.length, 1, 'the promoted calendar state had been POSTed, so undo re-syncs the plant');
    assert.equal(flushCalls[0].plant, 'UP');
    assert.deepEqual(flushCalls[0].removed, { line: ['ub-new'], plant: [] },
      'blackouts that exist only in the promoted state are explicitly deleted server-side');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    offAdapter();
    SandboxAdapter._clearSideEffectSnapshot();
    CalendarSync.flushPlant = priorFlush;
    Alerts.scheduleRecompute = priorSchedule;
    Toast.show = priorToast;
    Store.setTasks(priorTasks, 'unit-test');
    Store.replaceBlocks(priorBlocks, 'unit-test');
    Store.replaceCalendars(priorCalendars, 'unit-test');
    Store.replacePlants(priorPlants, 'unit-test');
    Store.replacePlantBlocks(priorPlantBlocks, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    UndoStack._entries.length = 0;
    for (const e of priorEntries) UndoStack._entries.push(e);
    globalThis.NIMBUS = priorNimbus;
    globalThis.document = priorDoc;
  }
});

test('G4: What-If discard snapshots and restores Persistence._firmDirtyIds (trial firm marks vanish, pre-enter marks stay)', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorFirmDirty = new Set(Persistence._firmDirtyIds);
  const priorSchedule = Alerts.scheduleRecompute;
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  const unsubscribeAdapter = subscribeSandboxAdapter();
  try {
    Store.setTasks([{ id: 'fd-kept', PLANT: 'FD', MACHINE: 'FD-L', RUN_TIME: 1 }, { id: 'fd-trial', PLANT: 'FD', MACHINE: 'FD-L', RUN_TIME: 1 }], 'unit-test');
    Persistence._firmDirtyIds.clear();
    Persistence._firmDirtyIds.add('fd-kept');
    Sandbox.enter('unit-test');
    Persistence._firmDirtyIds.add('fd-trial');          // a firm mark made inside the trial
    Persistence._firmDirtyIds.delete('fd-kept');
    Sandbox.exit(false, 'unit-test');
    assert.deepEqual([...Persistence._firmDirtyIds], ['fd-kept'], 'discard restores the pre-enter firm-dirty set exactly');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Persistence._firmDirtyIds.clear();
    for (const id of priorFirmDirty) Persistence._firmDirtyIds.add(id);
    Alerts.scheduleRecompute = priorSchedule;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
  }
});

test('G6: preview Apply drops candidate patches for orders that are running at apply time and toasts the count', () => {
  const plant = 'APPLY-RUNNING';
  const runningId = 'apply-running-1';
  const freeId = 'apply-free-1';
  const fixture = openTaskBaselinePreview(plant, [previewTask(runningId, plant, 5), previewTask(freeId, plant, 1)]);
  const priorIsInProgress = Engine.isInProgress;
  const priorShow = Toast.show;
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg: String(msg), type }); };
  try {
    const patched = OptimizerPreview._candidate.patches.map(p => p.id);
    assert.ok(patched.includes(runningId) && patched.includes(freeId), 'both orders are in the candidate');
    // The order started running between preview and Apply: the live row now carries running dates.
    Engine.isInProgress = (task, now) => (task.id === runningId ? true : priorIsInProgress.call(Engine, task, now));
    const runningBefore = { start: Store.tasks[runningId].start_date, end: Store.tasks[runningId].end_date };
    OptimizerPreview.apply();
    assert.deepEqual({ start: Store.tasks[runningId].start_date, end: Store.tasks[runningId].end_date }, runningBefore,
      'a running order is not moved by Apply');
    assert.ok(Store.tasks[freeId].start_date instanceof Date, 'the other order still gets its candidate dates');
    assert.ok(toasts.some(t => t.type === 'warn' && /opt_apply_running_skipped|running/i.test(t.msg)),
      'the planner is told how many running orders were skipped');
  } finally {
    Engine.isInProgress = priorIsInProgress;
    Toast.show = priorShow;
    fixture.restore();
  }
});

test('gate 24: preview Apply drops a candidate whose derived bar has started by the PLANT clock at Apply time (no isInProgress stub; viewer clock elsewhere)', () => {
  const plant = 'APPLY-DERIVED';
  const derivedId = 'apply-derived-1';
  const freeId = 'apply-derived-free';
  const priorMaster = Store.masterData;
  const priorOffset = Store.serverOffsetMs;
  const priorShow = Toast.show;
  const toasts = [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The plant clock reads Mon 2026-08-03 08:00 (the bar is a week out) when the preview opens; the viewer's own clock is the real today.
  Store.setMasterData({ ...priorMaster, plants: [{ plant, timezone: tz }], lines: [] }, 'unit-test');
  Store._blockedPlants.clear();
  Store.serverOffsetMs = new Date('2026-08-03T08:00:00').getTime() - Date.now();
  // The reconcile derived this order's bar to 09:00-12:00: not started at 08:00.
  const derived = { ...previewTask(derivedId, plant, 3), user_scheduled: true, start_date: new Date('2026-08-10T09:00:00'), end_date: new Date('2026-08-10T12:00:00') };
  const fixture = openTaskBaselinePreview(plant, [derived, previewTask(freeId, plant, 1)]);
  try {
    assert.ok(OptimizerPreview._candidate.patches.some(p => p.id === derivedId), 'the preview carries a patch for the order');
    assert.equal(Engine.isInProgress(Store.tasks[derivedId]), false, 'sanity: not running when the preview opened');
    // The preview sat open and the PLANT clock advanced to 10:00: the bar is now running.
    Store.serverOffsetMs = new Date('2026-08-10T10:00:00').getTime() - Date.now();
    assert.equal(Engine.isInProgress(Store.tasks[derivedId]), true, 'sanity: the plant clock (not the viewer clock) says it is running');
    Toast.show = (msg, type) => { toasts.push({ msg: String(msg), type }); };
    OptimizerPreview.apply();
    assert.equal(Store.tasks[derivedId].start_date.getTime(), new Date('2026-08-10T09:00:00').getTime(), 'the running order keeps its derived start');
    assert.equal(Store.tasks[derivedId].end_date.getTime(), new Date('2026-08-10T12:00:00').getTime());
    assert.ok(toasts.some(t => t.type === 'warn' && t.msg === String(Util.t('toast.opt_apply_running_skipped', { count: 1 }))),
      'counted in toast.opt_apply_running_skipped');
  } finally {
    Toast.show = priorShow;
    fixture.restore();
    Store.serverOffsetMs = priorOffset;
    Store._blockedPlants.clear();
    Store.setMasterData(priorMaster, 'unit-test');
  }
});

test('OQ56 a: the Remove Backlog dialog names how many orders are backlog only because their run time grew', async () => {
  const priorDocument = globalThis.document;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const hintEl = makeSandboxElement('opt-strategy-hint');
  const elements = new Map([
    ['opt-strategy-select', makeSandboxElement('opt-strategy-select', 'changeover')],
    ['opt-strategy-hint', hintEl],
    ['opt-run-btn', makeSandboxElement('opt-run-btn')],
    ['opt-wheel-badge', makeSandboxElement('opt-wheel-badge')],
  ]);
  globalThis.document = {
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return makeSandboxElement('created'); },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  try {
    const mk = (id, issue) => ({ id, PLANT: 'NOTE-P', MACHINE: 'NOTE-L', RUN_TIME: 2,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T10:00:00'), derivationIssue: issue });
    Store.setTasks([
      mk('n1', { code: 'reversal_forward', detail: 'run_time_grew' }),
      mk('n2', { code: 'reversal_forward', detail: 'run_time_grew' }),
      mk('n3', { code: 'reversal_forward', detail: 'due_date_past' }),   // late for another reason: not counted
      mk('n4', null),
    ], 'unit-test');
    await OptimizeDialog.selectPlant('NOTE-P');
    OptimizeDialog.selectMode('backlog');
    assert.ok(hintEl.textContent.includes(Util.t('ui.opt_backlog_runtime_grew', { count: 2 })),
      `the hint carries the run-time-grew count (2), got: ${hintEl.textContent}`);
    OptimizeDialog.selectMode('changeover');
    assert.ok(!hintEl.textContent.includes(Util.t('ui.opt_backlog_runtime_grew', { count: 2 })), 'other strategies show no backlog note');
  } finally {
    globalThis.document = priorDocument;
    OptimizeDialog.selectMode('changeover');
    Store.setTasks(priorTasks, 'unit-test');
    if (priorPlant) Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('senior review U21: the Optimize dialog refuses to run on a plant with no valid timezone, with a localized message', async () => {
  const priorTasks = structuredClone(Store.tasksArr);
  const priorPlant = Store.selectedPlant;
  const priorMaster = Store.masterData;
  const priorShow = Toast.show;
  const toasts = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  try {
    Store.setMasterData({ plants: [{ plant: 'NTZ-P', split_order_policy: 'never' }], lines: [{ machine: 'NTZ-L', plant: 'NTZ-P' }] }, 'unit-test');
    Store._blockedPlants.clear();
    Store.setTasks([{ id: 'z1', PLANT: 'NTZ-P', MACHINE: 'NTZ-L', RUN_TIME: 2,
      start_date: new Date('2026-08-03T08:00:00'), end_date: new Date('2026-08-03T10:00:00') }], 'unit-test');
    await OptimizeDialog.selectPlant('NTZ-P');
    const seqBefore = OptimizerPreview._runSeq;
    await OptimizeDialog.run();
    assert.equal(OptimizerPreview._runSeq, seqBefore, 'no optimizer run was started');
    assert.ok(toasts.some(t => t.type === 'error' && t.msg === Util.t('toast.optimize_plant_no_timezone', { plant: 'NTZ-P' })),
      `the refusal is the localized toast, got ${JSON.stringify(toasts)}`);
  } finally {
    Toast.show = priorShow;
    Store._blockedPlants.clear();
    Store.setMasterData(priorMaster, 'unit-test');
    Store.setTasks(priorTasks, 'unit-test');
    if (priorPlant) Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});
