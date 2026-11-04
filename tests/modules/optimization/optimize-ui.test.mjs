// Tests for frontend/optimization/optimize-ui.mts (OptimizeDialog, OptimizerPreview,
// SandboxAdapter). Split from tests/modules/schedule-workbench.test.mjs (Phase
// P3 of docs/architecture/domain-refactor-plan.md, which split that
// mega-module into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import { enLocale } from '../helpers/en-locale.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { OptimizeDialog, OptimizerPreview, SandboxAdapter } from '../../../frontend/optimization/optimize-ui.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Util, ErrorLog, Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Alerts, Compute, Utilization } from '../../../frontend/insights/services.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { CalendarSync } from '../../../frontend/calendar/calendar-sync.mjs';
import { Engine, SETUP_AWARE_NORMAL_BUDGET_MS } from '../../../frontend/optimization/engine.mjs';
import { runAndApply } from '../helpers/run-and-apply.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { buildOptimizerWorkerResponse } from '../../../frontend/optimization/optimizer-worker.mjs';

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
  const priorLocales = globalThis.window?.__NIMBUS_LOCALES;
  globalThis.window = globalThis.window || {};
  globalThis.window.__NIMBUS_LOCALES = enLocale();
  try {
    assert.equal(typeof OptimizerPreview.gapFillSummary, 'function');
    assert.match(OptimizerPreview.gapFillSummary({ gapFill: { complete: true, placed: 3, unchecked: 0 } }), /Capacity check:.*3 more order/);
    assert.match(OptimizerPreview.gapFillSummary({ gapFill: { complete: false, placed: 1, unchecked: 2 } }), /Capacity check incomplete.*2 still unchecked/);
    assert.equal(OptimizerPreview.gapFillSummary({}), '');
  } finally {
    globalThis.window.__NIMBUS_LOCALES = priorLocales;
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
    dataset: {},
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
  assert.equal(Object.hasOwn(explanation, 'overLatenessCap'), false,
    'the push-forward limit is hard, so the preview no longer carries an over-cap tally');

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

test('computePreview is state-free until present(result, { open: false }) installs it without a render', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const writesBefore = fx.writes.length;
    const result = await OptimizerPreview.computePreview('spt',
      { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00') },
      { tick: async () => {}, shouldStop: () => false, runSeq: 0 });
    assert.equal(OptimizerPreview.active, false, 'compute alone does not activate the preview');
    assert.equal(OptimizerPreview._candidate, null, 'compute alone does not set _candidate');
    assert.equal(OptimizerPreview._snapshot, null);
    assert.ok(result.candidate && result.snapshot.length === 2 && result.runtimeMs >= 0);
    assert.equal(fx.writes.length, writesBefore, 'compute writes nothing to the body');

    OptimizerPreview.present(result, { open: false });
    assert.equal(OptimizerPreview.active, true);
    assert.equal(OptimizerPreview._candidate, result.candidate);
    assert.equal(OptimizerPreview._finalists, result.finalists);
    assert.equal(fx.writes.length, writesBefore, 'open: false installs state without rendering the body');
  } finally {
    fx.restore();
  }
});

// P0-18: the verdict row printed a hardcoded "Pruned." for every alternate; the per-alternate reason was computed and dropped.
test('P0-18: the plan-comparison verdict row shows each alternate own reason, escaped, and falls back to "Pruned."', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview.showLoading('spt', 'SR');
    OptimizerPreview.runWithPreview('spt', { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00') });
    for (let i = 0; i < 200 && fx.root.classList.contains('opt-pv-loading'); i++) await wait(10);
    const finalists = OptimizerPreview._finalists;
    assert.ok(finalists && finalists.length > 1, 'the fixture produced alternates');
    finalists[1].whyNot = 'Saves 2 changeovers <b>but</b> costs 1 late order.';
    if (finalists[2]) finalists[2].whyNot = null;
    OptimizerPreview._render();
    const html = fx.body.innerHTML;
    assert.ok(html.includes('Saves 2 changeovers &lt;b&gt;but&lt;/b&gt; costs 1 late order.'), 'the alternate own reason, escaped');
    if (finalists[2]) assert.ok(html.includes(`<strong>${Util.t('ui.opt_pv_plan_pruned')}</strong>`), 'no reason: the generic label');
    assert.ok(!html.includes(`<strong>${Util.t('ui.opt_pv_plan_pruned')}</strong></td><td><strong>Saves`), 'the reason replaces the label, it is not appended');
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
    runAndApply('spt', { plant, respectFirmed: true, respectCalendar: false });
    // The Optimize preview's Apply (not the detached engine) stamps these two; do the same so the What-If state changes.
    Store.setLastOptimize(new Date(), 'engine');
    Alerts.clearDismissed();
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
    // P0-20: a header plant switch now ends What-If (see sandbox.test.mjs), so the trial's P2 edits stay on the
    // selected P1 plant's session; promote still flushes every plant the trial touched.
    Store.setLastOptimize(new Date('2026-08-07T12:00:00Z'), 'unit-test');
    Alerts.restoreDismissed(new Set(['after-promote']));
    fixture.elements.get('sb-apply-btn').dispatch('click');

    assert.equal(Sandbox.active, false, 'the real promote button exits What-If mode');
    assert.equal(saveCalls.length, 1, 'promote persists once');
    assert.deepEqual(flushCalls.map(call => call.plant).sort(), ['P1', 'P2'],
      'promote flushes every plant changed during the sandbox, not only the selected one');
    const p1Flush = flushCalls.find(call => call.plant === 'P1');
    assert.deepEqual(p1Flush.removed, { line: ['old-line-p1'], plant: ['old-plant-p1'], periods: [] },
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
    assert.deepEqual(flushCalls[0].removed, { line: ['ub-new'], plant: [], periods: [] },
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
  // A placed order (user_scheduled) whose bar is 09:00-12:00: not started at 08:00. Running protection needs a real placement (I10).
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
    Store.setSelectedPlant('NOTE-P', 'unit-test');
    OptimizeDialog._buildPlantSelect();
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
    Store.setSelectedPlant('NTZ-P', 'unit-test');
    OptimizeDialog._buildPlantSelect();
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

/* ---------------------------------------------------------------------------
   Task 3: Run in background option, background run, finish popup, partial apply
   ------------------------------------------------------------------------- */
const enLocaleSource = readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8');
const enString = key => enLocaleSource.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`))?.[1];

// Single-reveal fixture plus the Task 3 elements, a Modal recorder, a Toast recorder and an UndoStack spy.
function openBackgroundFixture(plant = 'SR', tasks = singleRevealTasks) {
  const base = openSingleRevealFixture(plant, structuredClone(tasks));
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: {
    ...Object.fromEntries(['toast.opt_bg_partial_applied', 'ui.opt_pv_diag_limit_reached_note',
      'ui.opt_pv_diag_limit_reached_note_exhaustive', 'ui.opt_bg_switch_plant', 'toast.opt_bg_no_worker',
      'btn.opt_run_bg_busy', 'btn.run_optimization'].map(key => [key, enString(key)])),
  } };
  const extra = new Map(['btn-optimize', 'modal-opt-background-done', 'opt-bg-done-body', 'opt-bg-apply-btn',
    'opt-bg-view-btn', 'opt-bg-switch-btn', 'opt-chk-background', 'opt-background-label', 'opt-run-btn'].map(id => [id, makeSandboxElement(id)]));
  extra.get('opt-chk-background').checked = false;
  extra.get('opt-chk-background').disabled = false;
  const baseGet = globalThis.document.getElementById;
  globalThis.document.getElementById = id => extra.get(id) || baseGet(id);
  const priorOpen = Modal.open;
  const priorClose = Modal.close;
  const priorShow = Toast.show;
  const priorPush = UndoStack.push;
  const modalCalls = [];
  const toasts = [];
  const undoPushes = [];
  Modal.open = id => { modalCalls.push({ op: 'open', id }); };
  Modal.close = id => { modalCalls.push({ op: 'close', id }); };
  Toast.show = (msg, type) => { toasts.push({ msg: String(msg), type }); };
  UndoStack.push = (label, undo, ids) => { undoPushes.push({ label, ids: [...(ids || [])] }); return priorPush.call(UndoStack, label, undo, ids); };
  return {
    ...base, extra, modalCalls, toasts, undoPushes,
    opts: { plant, respectCalendar: false, now: new Date('2026-08-03T08:00:00') },
    restore() {
      OptimizerPreview._backgroundRun?.controller?.abort();
      OptimizerPreview._backgroundRun = null;
      OptimizerPreview._removeLeaveGuard();
      Modal.open = priorOpen; Modal.close = priorClose; Toast.show = priorShow; UndoStack.push = priorPush;
      globalThis.window.__NIMBUS_LOCALES = priorLocales;
      base.restore();
    },
  };
}

test('Task 3: runInBackground computes with no preview state, flags the toolbar, then opens the finish popup', async () => {
  const fx = openBackgroundFixture();
  try {
    const pending = OptimizerPreview.runInBackground('spt', fx.opts);
    assert.ok(OptimizerPreview._backgroundRun, 'the run is registered synchronously');
    assert.equal(OptimizerPreview.active, false, 'a background compute does not activate the preview');
    assert.equal(OptimizerPreview._candidate, null);
    assert.equal(OptimizerPreview._taskBaseline, null, 'no task baseline is installed by compute');
    assert.ok(fx.extra.get('btn-optimize').classList.contains('is-running'), 'the toolbar button shows the running state');
    await pending;

    assert.ok(OptimizerPreview._backgroundRun.result, 'the result is held on the run');
    assert.equal(OptimizerPreview.active, false, 'the popup alone installs nothing');
    assert.equal(OptimizerPreview._taskBaseline, null, '_taskBaseline stays null after computePreview');
    assert.ok(fx.modalCalls.some(c => c.op === 'open' && c.id === 'modal-opt-background-done'), 'the finish popup opens');
    assert.ok(!fx.extra.get('btn-optimize').classList.contains('is-running'), 'the running state clears at completion');
    assert.notEqual(fx.extra.get('opt-bg-apply-btn').disabled, true);

    const { result } = OptimizerPreview._backgroundRun;
    OptimizerPreview.present(result, { open: false });
    assert.ok(OptimizerPreview._taskBaseline instanceof Map, '_taskBaseline is set after present');
  } finally {
    fx.restore();
  }
});

test('Task 3: backgroundApply skips an order edited while the search ran, applies the rest, and names the skipped id', async () => {
  const fx = openBackgroundFixture();
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const patchFor = id => result.candidate.patches.find(p => p.id === id);
    assert.ok(patchFor('sr-long') && patchFor('sr-short'), 'both orders are proposed');
    Store.updateTask('sr-short', { RUN_TIME: 2 }, 'user');
    const changes = OptimizerPreview._changedSinceBaseline(result);
    assert.deepEqual(changes.changed, ['sr-short']);
    assert.deepEqual(changes.missing, []);
    const shortBefore = Store.tasks['sr-short'].start_date;
    const pushesBefore = fx.undoPushes.length;

    await OptimizerPreview.backgroundApply();

    assert.equal(Store.tasks['sr-short'].start_date, shortBefore, 'the edited order is untouched');
    assert.equal(Store.tasks['sr-long'].start_date.getTime(), patchFor('sr-long').changes.start_date.getTime(),
      'the unedited order matches the candidate');
    assert.equal(fx.undoPushes.length - pushesBefore, 1, 'one Undo entry');
    assert.ok(fx.toasts.some(t => t.msg.includes('sr-short') && t.msg.startsWith('Applied 1 orders; 1 skipped')),
      `the toast names the skipped id, got ${JSON.stringify(fx.toasts)}`);
    assert.equal(OptimizerPreview._backgroundRun, null);
    assert.equal(OptimizerPreview._candidate, null, 'the apply tail clears the installed preview');
  } finally {
    fx.restore();
  }
});

test('Task 3: a result for another plant disables Apply and backgroundApply applies nothing', async () => {
  const fx = openBackgroundFixture();
  try {
    const pending = OptimizerPreview.runInBackground('spt', fx.opts);
    Store.setSelectedPlant('OTHER-PLANT', 'unit-test');
    await pending;
    assert.equal(fx.extra.get('opt-bg-apply-btn').disabled, true, 'Apply is disabled while viewing another plant');
    const before = JSON.stringify(Store.tasksArr.map(t => [t.id, t.start_date]));
    await OptimizerPreview.backgroundApply();
    assert.ok(fx.toasts.some(t => t.msg === Util.t('toast.opt_bg_other_plant', { plant: 'SR' })), 'toasts the switch-plant message');
    assert.equal(JSON.stringify(Store.tasksArr.map(t => [t.id, t.start_date])), before, 'nothing was applied');
    assert.equal(fx.undoPushes.length, 0);
  } finally {
    fx.restore();
  }
});

test('Task 3: cancelBackground aborts the controller; backgroundDismiss drops a finished result', async () => {
  const fx = openBackgroundFixture();
  try {
    const pending = OptimizerPreview.runInBackground('spt', fx.opts);
    const { controller } = OptimizerPreview._backgroundRun;
    OptimizerPreview.cancelBackground();
    assert.equal(controller.signal.aborted, true);
    assert.equal(OptimizerPreview._backgroundRun, null);
    await pending;
    assert.equal(fx.modalCalls.some(c => c.op === 'open'), false, 'a cancelled run never opens the popup');
    assert.ok(fx.toasts.some(t => t.msg === Util.t('toast.opt_bg_cancelled')));

    await OptimizerPreview.runInBackground('spt', fx.opts);
    assert.ok(OptimizerPreview._backgroundRun?.result);
    OptimizerPreview.backgroundDismiss();
    assert.equal(OptimizerPreview._backgroundRun, null);
    assert.ok(fx.toasts.some(t => t.msg === Util.t('toast.opt_discarded')));
  } finally {
    fx.restore();
  }
});

test('Task 3: viewing a background result after local edits keeps "Apply what still fits" enabled and routes to applyPartial', async () => {
  const fx = openBackgroundFixture();
  try {
    const applyBtn = makeSandboxElement('opt-preview-apply-btn');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'opt-preview-apply-btn' ? applyBtn : baseGet(id));
    await OptimizerPreview.runInBackground('spt', fx.opts);
    Store.updateTask('sr-short', { RUN_TIME: 2 }, 'user');
    OptimizerPreview.backgroundView();
    assert.equal(OptimizerPreview.stale, true);
    assert.equal(applyBtn.disabled, false, 'partial apply keeps the button enabled');
    assert.equal(applyBtn.textContent, Util.t('ui.opt_pv_apply_fits'));
    await OptimizerPreview.apply();
    assert.equal(Store.tasks['sr-short'].start_date, null, 'the edited order is skipped');
    assert.ok(Store.tasks['sr-long'].start_date instanceof Date, 'the rest is applied');
    assert.equal(fx.undoPushes.length, 1);
  } finally {
    fx.restore();
  }
});

test('Task 3: a running background run blocks OptimizeDialog.run with a toast and starts nothing', async () => {
  const fx = openBackgroundFixture();
  try {
    fx.extra.get('opt-chk-background').checked = true;
    const stub = { plant: 'SR', mode: 'spt', startedAt: 0, controller: new AbortController(), result: null, error: null };
    OptimizerPreview._backgroundRun = stub;
    const seq = OptimizerPreview._runSeq;
    await OptimizeDialog.run();
    assert.ok(fx.toasts.some(t => t.type === 'warn' && t.msg === Util.t('toast.opt_bg_running', { plant: 'SR' })));
    assert.equal(OptimizerPreview._backgroundRun, stub, 'no new controller replaced the running one');
    assert.equal(OptimizerPreview._runSeq, seq);
  } finally {
    fx.restore();
  }
});

test('Task 3: OptimizeDialog.open resets Run in background to unticked', async () => {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  try {
    globalThis.requestAnimationFrame = () => 1;
    // The date pickers are a browser library; every call on the stub is a no-op.
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    const modal = makeSandboxElement('modal-optimize');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : baseGet(id));
    fx.extra.get('opt-chk-background').checked = true;
    OptimizeDialog.open();
    assert.equal(fx.extra.get('opt-chk-background').checked, false);
  } finally {
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
  }
});

test('W4: the Optimize dialog shows the header plant read-only and closes when the header plant changes', async () => {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  const priorMaster = Store.masterData;
  const priorPlant = Store.selectedPlant;
  try {
    globalThis.requestAnimationFrame = () => 1;
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    Store.setMasterData({ plants: [{ plant: 'SR', description: 'Sample Plant' }, { plant: 'OTHER' }] }, 'unit-test');
    Store.setSelectedPlant('SR', 'unit-test');
    const modal = makeSandboxElement('modal-optimize');
    modal.hidden = true;
    const label = makeSandboxElement('opt-plant-label');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : id === 'opt-plant-label' ? label : baseGet(id));
    OptimizeDialog.open();
    assert.equal(modal.hidden, false, 'the dialog opened');
    assert.equal(label.textContent, 'SR — Sample Plant', 'the label shows the header plant, with its description');
    assert.equal(typeof OptimizeDialog.selectPlant, 'undefined', 'the dialog no longer exposes a plant picker');
    Store.setSelectedPlant('OTHER', 'unit-test');
    assert.equal(modal.hidden, true, 'a header plant change closes an open dialog');
    OptimizeDialog.open();
    assert.equal(label.textContent, 'OTHER', 'reopened, the label follows the new header plant');
  } finally {
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
    Store.setMasterData(priorMaster, 'unit-test');
    if (priorPlant) Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Task 3: the background driver finishes when the evaluator returns a Promise (worker path) and scales the primary deadline', async () => {
  const fx = openBackgroundFixture();
  const OriginalWorker = globalThis.Worker;
  const allPosted = [];
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(message) {
      allPosted.push(message);
      const response = buildOptimizerWorkerResponse(message);
      setTimeout(() => this.onmessage?.({ data: response }), 0);
    }
    terminate() {}
  }
  try {
    globalThis.Worker = FakeWorker;
    const seq = OptimizerPreview._runSeq + 1;
    await OptimizerPreview.runInBackground('spt', { ...fx.opts, searchBudgetMs: 180000, exhaustive: true });
    // Hermetic: a run abandoned by an earlier test may still post through this FakeWorker; only this run's messages count.
    const posted = allPosted.filter(message => String(message.runId).startsWith(`optimizer-preview-${seq}-`));
    const run = OptimizerPreview._backgroundRun;
    assert.ok(run?.result, `the async path produced a result, error: ${run?.error}`);
    assert.ok(posted.length > 1, 'the primary and the alternates all went through the worker');
    assert.ok(posted[0].runId.endsWith('-primary'), 'the primary is first');
    assert.ok(posted[0].deadlineDurationMs > 170000 && posted[0].deadlineDurationMs <= 180000, 'primary carries the Exhaustive budget');
    for (const alt of posted.slice(1)) {
      // Wall-clock under suite load: bounded above by the Normal budget, and an order of magnitude below the primary.
      assert.ok(alt.deadlineDurationMs <= 8000 && alt.deadlineDurationMs > 0, `alternates keep the Normal budget, got ${alt.deadlineDurationMs}`);
      assert.ok(alt.deadlineDurationMs < posted[0].deadlineDurationMs / 10, 'alternates are far smaller than the primary');
      assert.equal(alt.request.exhaustive, false);
    }
    assert.equal(posted[0].request.exhaustive, true);
    assert.equal(OptimizerPreview.active, false, 'still no preview state');
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = OriginalWorker;
    fx.restore();
  }
});

/* P2-1: one worker session per Optimize run, concurrent KPI-only alternates, cancel across N workers */
function sessionFakePool({ holdAlternates = false, holdAll = false } = {}) {
  const log = { workers: [], posted: [], postedAtFirstAltReply: null };
  const factory = () => {
    const worker = {
      onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage(message) {
        log.posted.push(message);
        const isAlt = String(message.runId).includes('-alt-');
        if (holdAll || (holdAlternates && isAlt)) return;
        const response = buildOptimizerWorkerResponse(message);
        setTimeout(() => {
          if (isAlt && log.postedAtFirstAltReply === null) log.postedAtFirstAltReply = log.posted.length;
          this.onmessage?.({ data: response });
        }, 0);
      },
      terminate() { this.terminated = true; },
    };
    log.workers.push(worker);
    return worker;
  };
  return { log, factory };
}
const waitFor = async (check, label) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${label}`);
};
const previewOpts = { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00') };
const finalistFacts = result => (result.finalists ?? []).map(f => ({ label: f.label, mode: f.mode, kpis: f.kpis }));

test('P2-1: a worker-path run uses one session: both alternates are posted before either answers, KPI-only, and every worker is terminated at the end', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const pool = sessionFakePool();
    let ticks = 0;
    const result = await OptimizerPreview.computePreview('spt', previewOpts,
      { tick: async () => { ticks++; }, runSeq: 5, workerFactory: pool.factory, maxWorkers: 2 });
    assert.equal(pool.log.workers.length, 2, 'two workers for three requests (the primary worker is reused for an alternate)');
    assert.equal(pool.log.posted.length, 3);
    assert.equal(pool.log.postedAtFirstAltReply, 3, 'both alternates were already posted when the first alternate answered');
    const [primary, ...alts] = pool.log.posted;
    assert.ok(primary.runId.endsWith('-primary') && primary.kpiOnly === undefined, 'the primary is a full request');
    assert.ok(alts.every(a => a.kpiOnly === true), 'alternates are KPI-only');
    assert.equal(ticks, 1, 'one yield for the concurrent comparison instead of one per alternate');
    assert.ok(pool.log.workers.every(w => w.terminated), 'no worker outlives the run');
    assert.equal(result.finalists?.length, 3);
    assert.ok(result.candidate.validationContext, 'the primary keeps its validation seam');

    // Parity: the main-thread (serial, sync) path yields the same plans and KPI vectors.
    const sync = await OptimizerPreview.computePreview('spt', previewOpts,
      { tick: async () => {}, runSeq: 5, workerFactory: null });
    assert.deepEqual(finalistFacts(result), finalistFacts(sync), 'worker finalists equal the synchronous ones');
    assert.equal(JSON.stringify(result.candidate.patches), JSON.stringify(sync.candidate.patches), 'same primary patches');
    assert.deepEqual(result.postKpis, sync.postKpis);
    assert.deepEqual(result.preKpis, sync.preKpis);
    assert.deepEqual([...result.taskBaseline], [...sync.taskBaseline], 'the baseline built after the post is the same');
  } finally {
    fx.restore();
  }
});

test('P2-1: the synchronous fallback keeps one alternate per tick (serial)', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    let ticks = 0;
    await OptimizerPreview.computePreview('spt', previewOpts, { tick: async () => { ticks++; }, runSeq: 6, workerFactory: null });
    assert.equal(ticks, 2, 'a tick before each of the two alternates');
  } finally {
    fx.restore();
  }
});

test('P2-1: with one worker the queued alternate is posted with the FULL alternate budget, not what is left of a launch-time deadline', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const posted = [];
    const factory = () => ({
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage(message) {
        posted.push({ message, at: performance.now() });
        const response = buildOptimizerWorkerResponse(message);
        setTimeout(() => this.onmessage?.({ data: response }), message.runId.includes('-alt-') ? 60 : 0);   // each alternate takes 60 ms
      },
      terminate() {},
    });
    await OptimizerPreview.computePreview('spt', previewOpts, { tick: async () => {}, runSeq: 11, workerFactory: factory, maxWorkers: 1 });
    const alts = posted.filter(p => p.message.runId.includes('-alt-'));
    assert.equal(alts.length, 2);
    assert.ok(alts[1].at - alts[0].at >= 50, 'the second alternate really waited behind the first');
    for (const alt of alts) assert.equal(alt.message.deadlineDurationMs, SETUP_AWARE_NORMAL_BUDGET_MS, 'each alternate gets its own budget measured from its post');
  } finally {
    fx.restore();
  }
});

test('P2-1 cancel: Cancel while the alternates run terminates every worker and applies nothing', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const pool = sessionFakePool({ holdAlternates: true });
    const controller = new AbortController();
    const running = OptimizerPreview.computePreview('spt', previewOpts,
      { tick: async () => {}, runSeq: 8, workerFactory: pool.factory, maxWorkers: 2, signal: controller.signal });
    const settled = running.then(() => 'resolved', error => error);
    await waitFor(() => pool.log.posted.filter(m => String(m.runId).includes('-alt-')).length === 2, 'both alternates to be posted');
    assert.ok(pool.log.workers.some(w => !w.terminated), 'workers are alive while the alternates compute');
    controller.abort();
    const outcome = await settled;
    assert.equal(outcome?.name, 'AbortError', 'the run rejects with AbortError, never a result');
    assert.equal(pool.log.workers.length, 2);
    assert.ok(pool.log.workers.every(w => w.terminated), 'all workers are terminated');
    assert.ok(pool.log.workers.every(w => w.onmessage === null), 'no handler is left to deliver a late answer');
    assert.equal(OptimizerPreview._candidate, null, 'nothing was installed');
  } finally {
    fx.restore();
  }
});

test('P2-1 cancel: Cancel while the primary runs terminates the primary and the pre-warmed worker', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const pool = sessionFakePool({ holdAll: true });
    const controller = new AbortController();
    const running = OptimizerPreview.computePreview('spt', previewOpts,
      { tick: async () => {}, runSeq: 9, workerFactory: pool.factory, maxWorkers: 2, signal: controller.signal });
    const settled = running.then(() => 'resolved', error => error);
    await waitFor(() => pool.log.posted.length === 1, 'the primary to be posted');
    assert.equal(pool.log.workers.length, 2, 'the second worker boots while the primary searches');
    controller.abort();
    assert.equal((await settled)?.name, 'AbortError');
    assert.ok(pool.log.workers.every(w => w.terminated), 'no leaked worker');
    assert.equal(pool.log.posted.length, 1, 'no alternate was ever posted');
  } finally {
    fx.restore();
  }
});

test('P2-1: a worker answer that fails for one alternate drops only that alternate', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview._clear();
    const pool = sessionFakePool();
    const base = pool.factory;
    pool.factory = () => {
      const worker = base();
      const post = worker.postMessage.bind(worker);
      worker.postMessage = message => {
        if (String(message.runId).endsWith('-alt-0')) { setTimeout(() => worker.onmessage?.({ data: { runId: message.runId, error: 'boom' } }), 0); return; }
        post(message);
      };
      return worker;
    };
    const result = await OptimizerPreview.computePreview('spt', previewOpts,
      { tick: async () => {}, runSeq: 10, workerFactory: pool.factory, maxWorkers: 2 });
    assert.deepEqual((result.finalists ?? []).map(f => f.label), ['A', 'B'], 'Plan B is omitted; labels follow position, so the surviving alternate is B (P4-3, V-U2-08)');
  } finally {
    fx.restore();
  }
});

/* Task 3 fix round 1: live-board partial apply, family drop, Run button, guards */
const boardTasks = () => [
  { id: 'bx-x', PLANT: 'BX', MACHINE: 'BX-L1', RUN_TIME: 3, row_version: 1,
    start_date: new Date('2026-08-03T08:30:00'), end_date: new Date('2026-08-03T11:30:00') },
  { id: 'bx-y', PLANT: 'BX', MACHINE: 'BX-L1', RUN_TIME: 1, row_version: 1, start_date: null, end_date: null },
  { id: 'bx-z', PLANT: 'BX', MACHINE: 'BX-L2', RUN_TIME: 2, row_version: 1, start_date: null, end_date: null },
];
const patchById = (result, id) => result.candidate.patches.find(p => p.id === id);
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

test('Task 3 fix: partial apply validates against the live board, so a proposal onto an edited order is skipped with it', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const x = patchById(result, 'bx-x'); const y = patchById(result, 'bx-y');
    const xLive = { start: Store.tasks['bx-x'].start_date, end: Store.tasks['bx-x'].end_date };
    assert.ok(x && y, 'both orders are proposed');
    assert.ok(overlaps({ start: y.changes.start_date, end: y.changes.end_date }, xLive),
      'precondition: the optimizer puts Y into the slot X occupies now');
    assert.notEqual(+x.changes.start_date, +xLive.start, 'precondition: the optimizer moves X out of that slot');
    Store.updateTask('bx-x', { NOTE: 'edited while searching' }, 'user');   // X stays in its slot live

    await OptimizerPreview.backgroundApply();

    assert.equal(Store.tasks['bx-y'].start_date, null, 'Y is not applied on top of X');
    assert.equal(+Store.tasks['bx-x'].start_date, +xLive.start, 'X keeps its live slot');
    const toast = fx.toasts.find(t => t.msg.startsWith('Applied'));
    assert.ok(toast && toast.msg.includes('bx-x') && toast.msg.includes('bx-y'), `the toast lists X and Y, got ${JSON.stringify(fx.toasts)}`);
  } finally {
    fx.restore();
  }
});

test('Task 3 fix: an unpatched order edited into a kept proposal skips that proposal and applies the rest', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const y = patchById(result, 'bx-y'); const z = patchById(result, 'bx-z');
    assert.ok(y && z, 'precondition: Y and Z are proposed');
    // A new live order the search never saw lands exactly on Y's proposed slot.
    Store.setTasks([...Store.tasksArr, { id: 'bx-new', PLANT: 'BX', MACHINE: 'BX-L1', RUN_TIME: 1, row_version: 1,
      start_date: y.changes.start_date, end_date: y.changes.end_date }], 'unit-test');
    // The baseline now has no entry for it, so only the live-board validation can catch it.
    await OptimizerPreview.backgroundApply();
    assert.equal(Store.tasks['bx-y'].start_date, null, 'Y is skipped');
    assert.ok(Store.tasks['bx-z'].start_date instanceof Date, 'the unrelated order still applies');
    const toast = fx.toasts.find(t => t.msg.startsWith('Applied'));
    assert.ok(toast && toast.msg.includes('bx-y'), `the toast names Y, got ${JSON.stringify(fx.toasts)}`);
  } finally {
    fx.restore();
  }
});

test('Task 3 fix: editing one sub-order of a distributed family skips the whole family', async () => {
  const family = [
    { id: 'fm-1', PLANT: 'FM', MACHINE: 'FM-L1', RUN_TIME: 1, row_version: 1, PARENT_ORDER: 'P-100', MATERIAL_NUMBER: 'M1', start_date: null, end_date: null },
    { id: 'fm-2', PLANT: 'FM', MACHINE: 'FM-L2', RUN_TIME: 1, row_version: 1, PARENT_ORDER: 'P-100', MATERIAL_NUMBER: 'M1', start_date: null, end_date: null },
    { id: 'fm-3', PLANT: 'FM', MACHINE: 'FM-L3', RUN_TIME: 1, row_version: 1, start_date: null, end_date: null },
  ];
  const fx = openBackgroundFixture('FM', family);
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    Store.updateTask('fm-1', { NOTE: 'edited' }, 'user');
    await OptimizerPreview.backgroundApply();
    assert.equal(Store.tasks['fm-1'].start_date, null);
    assert.equal(Store.tasks['fm-2'].start_date, null, 'the sibling is skipped with the edited sub-order');
    assert.ok(Store.tasks['fm-3'].start_date instanceof Date, 'an unrelated order applies');
  } finally {
    fx.restore();
  }
});

test('Task 3 fix: the popup warning counts every plant order that changed, not only proposed ones', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    result.candidate = { ...result.candidate, patches: [] };
    Store.updateTask('bx-x', { NOTE: 'edited' }, 'user');
    assert.deepEqual(OptimizerPreview._changedSinceBaseline(result), { changed: ['bx-x'], missing: [] });
  } finally {
    fx.restore();
  }
});

test('Task 3 fix: the Run button stays disabled while a background run exists, even after the plant badge refreshes', async () => {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  try {
    globalThis.requestAnimationFrame = () => 1;
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    const modal = makeSandboxElement('modal-optimize');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : baseGet(id));
    OptimizerPreview._backgroundRun = { plant: 'SR', mode: 'spt', startedAt: 0, controller: new AbortController(), result: null, error: null };
    OptimizeDialog.open();
    await wait(20);
    assert.equal(fx.extra.get('opt-run-btn').disabled, true);
  } finally {
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
  }
});

test('Task 3 fix: a superseded run settling late keeps the newer run\'s leave guard; cancel ignores a finished run', async () => {
  const fx = openBackgroundFixture();
  const priorWindow = globalThis.window;
  const listeners = new Set();
  globalThis.window = Object.assign(priorWindow, {
    addEventListener: (type, fn) => { if (type === 'beforeunload') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'beforeunload') listeners.delete(fn); },
  });
  try {
    const first = OptimizerPreview.runInBackground('spt', fx.opts);
    OptimizerPreview.cancelBackground();
    const second = OptimizerPreview.runInBackground('spt', fx.opts);
    assert.equal(listeners.size, 1, 'the second run installed a guard');
    await first;
    assert.equal(listeners.size, 1, 'the first run settling late did not remove it');
    await second;
    assert.equal(listeners.size, 0, 'the guard goes once nothing is computing');

    assert.ok(OptimizerPreview._backgroundRun?.result, 'the second run finished');
    OptimizerPreview.cancelBackground();
    assert.ok(OptimizerPreview._backgroundRun?.result, 'cancel does not null a finished run');
    assert.equal(fx.toasts.filter(t => t.msg === Util.t('toast.opt_bg_cancelled')).length, 1,
      'only the first cancel toasted; cancelling a finished run does nothing');
  } finally {
    delete globalThis.window.addEventListener; delete globalThis.window.removeEventListener;
    fx.restore();
  }
});

test('Task 3 fix: a partial apply that throws before committing clears the installed preview', async () => {
  const fx = openBackgroundFixture();
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const priorCommit = OptimizerPreview._commitPatches;
    OptimizerPreview._commitPatches = async () => { throw new Error('boom'); };
    try {
      await OptimizerPreview.backgroundApply();
    } finally {
      OptimizerPreview._commitPatches = priorCommit;
    }
    assert.equal(OptimizerPreview.active, false, 'a failed apply leaves no active preview behind');
    assert.equal(OptimizerPreview._candidate, null);
  } finally {
    fx.restore();
  }
});

/* Task 3 fix round 2: baseline-diff collision rule */
test('Task 3 fix: a kept patch placed before an untouched order whose incoming setup it creates is skipped; U is untouched', async () => {
  const plant = 'SU';
  const line = 'SU-L1';
  const priorMaster = structuredClone(Store.masterData);
  const priorSetup = Store.setupSnapshot;
  const priorCalendar = Store.calendars[line];
  const fx = openBackgroundFixture(plant, [
    { id: 'su-k', PLANT: plant, MACHINE: line, COLOR: 'BLUE', RUN_TIME: 1, row_version: 1, start_date: null, end_date: null },
    { id: 'su-z', PLANT: plant, MACHINE: 'SU-L2', RUN_TIME: 1, row_version: 1, start_date: null, end_date: null },
  ]);
  try {
    Store.setMasterData({ plants: [{ plant }], lines: [{ plant, machine: line }, { plant, machine: 'SU-L2' }] }, 'unit-test');
    Store.setCalendar(line, { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, 'unit-test');
    Store.replaceSetupSnapshot({
      plant,
      definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_active: true,
      plant_rows: [{ machine: '', signature_version: 1,
        from_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }],
        to_key: [{ fieldKey: 'colorWheel', value: 'RED' }], setup_min: 60 }],
      machine_rows: [], machine_states: [], overrides: [],
    }, 'unit-test');
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const k = patchById(result, 'su-k');
    assert.ok(k && k.changes.start_date, 'precondition: K is proposed with dates');
    // A new live order U (never seen by the search) starts exactly where K ends: BLUE then RED needs 60 min of setup
    // that now collides with K's production.
    const uStart = k.changes.end_date;
    const uEnd = new Date(+uStart + 3600000);
    Store.setTasks([...Store.tasksArr, { id: 'su-u', PLANT: plant, MACHINE: line, COLOR: 'RED', RUN_TIME: 1, row_version: 1,
      start_date: uStart, end_date: uEnd }], 'unit-test');
    await OptimizerPreview.backgroundApply();
    assert.equal(Store.tasks['su-k'].start_date, null, 'K is skipped');
    assert.equal(+Store.tasks['su-u'].start_date, +uStart, 'U is untouched');
    assert.ok(Store.tasks['su-z'].start_date instanceof Date, 'the unrelated order still applies');
    const toast = fx.toasts.find(t => t.msg.startsWith('Applied'));
    assert.ok(toast && toast.msg.includes('su-k'), `the toast names K, got ${JSON.stringify(fx.toasts)}`);
  } finally {
    Store.replaceSetupSnapshot(priorSetup, 'unit-test');
    Store.setMasterData(priorMaster, 'unit-test');
    if (priorCalendar) Store.setCalendar(line, priorCalendar.workHours, 'unit-test');
    fx.restore();
  }
});

test('Task 3 fix: a pre-existing live overlap between two unpatched orders does not block a partial apply', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const when = h => new Date(`2026-08-10T${String(h).padStart(2, '0')}:00:00`);
    Store.setTasks([...Store.tasksArr,
      { id: 'bx-p1', PLANT: 'BX', MACHINE: 'BX-L3', RUN_TIME: 3, row_version: 1, start_date: when(8), end_date: when(11) },
      { id: 'bx-p2', PLANT: 'BX', MACHINE: 'BX-L3', RUN_TIME: 3, row_version: 1, start_date: when(9), end_date: when(12) },
    ], 'unit-test');
    await OptimizerPreview.backgroundApply();
    assert.ok(Store.tasks['bx-y'].start_date instanceof Date, 'unrelated kept patch Y applies');
    assert.ok(Store.tasks['bx-z'].start_date instanceof Date, 'unrelated kept patch Z applies');
    assert.equal(+Store.tasks['bx-p1'].start_date, +when(8), 'the overlapping pair is untouched');
  } finally {
    fx.restore();
  }
});

test('Task 3 fix: the popup warning counts orders added to the plant since the search ran', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    Store.setTasks([...Store.tasksArr, { id: 'bx-late', PLANT: 'BX', MACHINE: 'BX-L1', RUN_TIME: 1, row_version: 1, start_date: null, end_date: null }], 'unit-test');
    assert.deepEqual(OptimizerPreview._changedSinceBaseline(result), { changed: ['bx-late'], missing: [] });
  } finally {
    fx.restore();
  }
});

/* Final fix wave */
test('Final wave F1: a result finished on another plant offers Switch-to-plant; after the switch loads, Apply enables', async () => {
  const fx = openBackgroundFixture();
  const priorConfirm = Persistence.confirmPlantSwitch;
  try {
    Persistence.confirmPlantSwitch = async () => true;
    const pending = OptimizerPreview.runInBackground('spt', fx.opts);
    Store.setSelectedPlant('OTHER-PLANT', 'unit-test');
    await pending;
    const switchBtn = fx.extra.get('opt-bg-switch-btn');
    assert.equal(switchBtn.hidden, false, 'the Switch to plant button is shown');
    assert.equal(switchBtn.textContent, Util.t('ui.opt_bg_switch_plant', { plant: 'SR' }));
    assert.equal(fx.extra.get('opt-bg-apply-btn').disabled, true);

    await OptimizerPreview.backgroundSwitchPlant();
    assert.equal(Store.selectedPlant, 'SR');
    assert.equal(fx.extra.get('opt-bg-apply-btn').disabled, true, 'Apply waits for the plant orders to load');
    assert.ok(OptimizerPreview._backgroundRun?.result, 'the result survives the switch');

    // The plant's orders arrive, equal to the baseline rows.
    Store.setTasks(structuredClone(Store.tasksArr), 'unit-test');
    const { result } = OptimizerPreview._backgroundRun;
    assert.deepEqual(OptimizerPreview._changedSinceBaseline(result), { changed: [], missing: [] });
    assert.notEqual(fx.extra.get('opt-bg-apply-btn').disabled, true, 'Apply is enabled once the plant loaded');
    assert.equal(switchBtn.hidden, true);
  } finally {
    Persistence.confirmPlantSwitch = priorConfirm;
    fx.restore();
  }
});

test('Final wave F1: only the X button dismisses the finish popup (the backdrop opts out of the shell backdrop-close)', () => {
  const html = readFileSync(new URL('../../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="modal-backdrop" id="modal-opt-background-done" data-no-backdrop-close hidden>/);
  const shell = readFileSync(new URL('../../../frontend/shell/application-shell.mts', import.meta.url), 'utf8');
  assert.match(shell, /!b\.hasAttribute\('data-no-backdrop-close'\)/);
});

test('Final wave F2: a kept proposal onto an untouched order that already overlapped another live order is skipped', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const y = patchById(result, 'bx-y');
    assert.ok(y?.changes.start_date, 'precondition: Y is proposed with dates');
    const xLive = { start: Store.tasks['bx-x'].start_date, end: Store.tasks['bx-x'].end_date };
    assert.ok(overlaps({ start: y.changes.start_date, end: y.changes.end_date }, xLive), 'precondition: Y lands on X');
    // V overlaps X live (a pre-existing defect on U = X) but not Y's proposed slot. V has a due date, so it is more
    // urgent than X and the live overlap is reported against X, the very key the new Y-vs-X overlap will carry.
    const v = { start: new Date(+y.changes.end_date + 3600000), end: new Date(+xLive.end + 3600000) };
    assert.ok(v.start < xLive.end && !overlaps(v, { start: y.changes.start_date, end: y.changes.end_date }), 'precondition: V overlaps X only');
    Store.setTasks([...Store.tasksArr, { id: 'bx-v', PLANT: 'BX', MACHINE: 'BX-L1', RUN_TIME: 2, row_version: 1,
      original_end_date: new Date('2026-08-04T00:00:00'), start_date: v.start, end_date: v.end }], 'unit-test');
    Store.updateTask('bx-x', { NOTE: 'edited while searching' }, 'user');
    await OptimizerPreview.backgroundApply();
    assert.equal(Store.tasks['bx-y'].start_date, null, 'Y is skipped');
    assert.equal(+Store.tasks['bx-x'].start_date, +xLive.start, 'X untouched');
    assert.equal(+Store.tasks['bx-v'].start_date, +v.start, 'V untouched');
    const toast = fx.toasts.find(t => t.msg.startsWith('Applied'));
    assert.ok(toast && toast.msg.includes('bx-y'), `the toast lists Y, got ${JSON.stringify(fx.toasts)}`);
  } finally {
    fx.restore();
  }
});

test('Final wave M2: the limit note key follows the run mode (preview and popup)', async () => {
  assert.equal(OptimizerPreview._limitNoteKey(false), 'ui.opt_pv_diag_limit_reached_note');
  assert.equal(OptimizerPreview._limitNoteKey(true), 'ui.opt_pv_diag_limit_reached_note_exhaustive');
  const fx = openBackgroundFixture();
  try {
    assert.match(Util.t('ui.opt_pv_diag_limit_reached_note'), /Run in background/);
    assert.doesNotMatch(Util.t('ui.opt_pv_diag_limit_reached_note_exhaustive'), /tick|choose/i);
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const run = OptimizerPreview._backgroundRun;
    run.result.candidate.diagnostics.limitReached = true;
    run.result.opts = { ...run.result.opts, exhaustive: true };
    OptimizerPreview._renderBackgroundDone();
    assert.match(fx.extra.get('opt-bg-done-body').innerHTML, /even on a background run/);
    run.result.opts = { ...run.result.opts, exhaustive: false };
    OptimizerPreview._renderBackgroundDone();
    assert.match(fx.extra.get('opt-bg-done-body').innerHTML, /tick Run in background/);
  } finally {
    fx.restore();
  }
});

test('Final wave M6: Exhaustive without Worker support toasts and starts nothing', async () => {
  const fx = openBackgroundFixture();
  const OriginalWorker = globalThis.Worker;
  try {
    delete globalThis.Worker;
    await OptimizerPreview.runInBackground('spt', { ...fx.opts, searchBudgetMs: 180000, exhaustive: true });
    assert.equal(OptimizerPreview._backgroundRun, null);
    assert.ok(fx.toasts.some(t => t.msg === Util.t('toast.opt_bg_no_worker')), `got ${JSON.stringify(fx.toasts)}`);
  } finally {
    if (OriginalWorker !== undefined) globalThis.Worker = OriginalWorker;
    fx.restore();
  }
});

test('Final wave M8: the Run button is restored when the background run finishes while the dialog is open', async () => {
  const fx = openBackgroundFixture();
  const runBtn = fx.extra.get('opt-run-btn');
  try {
    OptimizerPreview._backgroundRun = { plant: 'SR', mode: 'spt', startedAt: 0, controller: new AbortController(), result: null, error: null };
    OptimizerPreview._syncToolbarRunning();
    assert.equal(runBtn.disabled, true, 'disabled while computing');
    assert.equal(runBtn.textContent, Util.t('btn.opt_run_bg_busy'));
    OptimizerPreview._backgroundRun.result = {};   // finished
    OptimizerPreview._syncToolbarRunning();
    assert.match(runBtn.innerHTML, new RegExp(Util.t('btn.run_optimization')));
  } finally {
    OptimizerPreview._backgroundRun = null;
    fx.restore();
  }
});

test('Run in background: ticked run() goes to runInBackground with exhaustive:true; unticked takes the foreground path', async () => {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  const priorBg = OptimizerPreview.runInBackground;
  const priorFg = OptimizerPreview.runWithPreview;
  const priorLoading = OptimizerPreview.showLoading;
  const priorRankPlant = Persistence._rankMapsPlant;
  const priorPlantNow = Store.plantNow;
  const priorHydration = CalendarSync._hydration.SR;
  try {
    CalendarSync._setHydration('SR', 'hydrated');   // Gap C: an unhydrated calendar asks before a run
    Store.plantNow = () => new Date('2026-08-03T08:00:00');
    globalThis.requestAnimationFrame = fn => { fn(); return 1; };
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    const modal = makeSandboxElement('modal-optimize');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : baseGet(id));
    const bgCalls = [];
    const fgCalls = [];
    OptimizerPreview.runInBackground = async (mode, opts) => { bgCalls.push({ mode, opts }); };
    OptimizerPreview.runWithPreview = async (mode, opts) => { fgCalls.push({ mode, opts }); };
    OptimizerPreview.showLoading = () => {};
    OptimizeDialog.open();
    OptimizeDialog.selectMode('spt');
    Persistence._rankMapsPlant = 'SR';
    const chk = fx.extra.get('opt-chk-background');

    chk.checked = true;
    await OptimizeDialog.run();
    assert.equal(bgCalls.length, 1, `ticked run goes to the background, toasts ${JSON.stringify(fx.toasts)}`);
    assert.equal(bgCalls[0].opts.exhaustive, true);
    assert.equal(fgCalls.length, 0);

    chk.checked = false;
    await OptimizeDialog.run();
    await wait(20);
    assert.equal(bgCalls.length, 1, 'unticked run does not go to the background');
    assert.equal(fgCalls.length, 1, 'unticked run takes the foreground preview path');
    assert.equal(fgCalls[0].opts.exhaustive, false);
  } finally {
    OptimizerPreview.runInBackground = priorBg;
    OptimizerPreview.runWithPreview = priorFg;
    OptimizerPreview.showLoading = priorLoading;
    Persistence._rankMapsPlant = priorRankPlant;
    Store.plantNow = priorPlantNow;
    if (priorHydration) CalendarSync._hydration.SR = priorHydration; else delete CalendarSync._hydration.SR;
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
  }
});

// Gap C (2026-10-23): Optimize asks before running against a plant calendar that never hydrated.
async function withCalendarGate(state, answer, fn) {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  const priorBg = OptimizerPreview.runInBackground;
  const priorFg = OptimizerPreview.runWithPreview;
  const priorLoading = OptimizerPreview.showLoading;
  const priorRankPlant = Persistence._rankMapsPlant;
  const priorPlantNow = Store.plantNow;
  const priorConfirm = Modal.confirm;
  const priorHydration = CalendarSync._hydration.SR;
  try {
    Store.plantNow = () => new Date('2026-08-03T08:00:00');
    globalThis.requestAnimationFrame = f => { f(); return 1; };
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    const modal = makeSandboxElement('modal-optimize');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : baseGet(id));
    const calls = { bg: 0, fg: 0, confirms: [] };
    OptimizerPreview.runInBackground = async () => { calls.bg++; };
    OptimizerPreview.runWithPreview = async () => { calls.fg++; };
    OptimizerPreview.showLoading = () => {};
    Modal.confirm = async (opts) => { calls.confirms.push(opts); return answer; };
    if (state) CalendarSync._setHydration('SR', state); else delete CalendarSync._hydration.SR;
    OptimizeDialog.open();
    OptimizeDialog.selectMode('spt');
    Persistence._rankMapsPlant = 'SR';
    await fn(calls, fx.extra.get('opt-chk-background'));
  } finally {
    OptimizerPreview.runInBackground = priorBg;
    OptimizerPreview.runWithPreview = priorFg;
    OptimizerPreview.showLoading = priorLoading;
    Persistence._rankMapsPlant = priorRankPlant;
    Store.plantNow = priorPlantNow;
    Modal.confirm = priorConfirm;
    if (priorHydration) CalendarSync._hydration.SR = priorHydration; else delete CalendarSync._hydration.SR;
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
  }
}

test('Gap C: an unhydrated plant calendar asks first; Cancel starts neither the foreground nor the background run', () =>
  withCalendarGate('failed', false, async (calls, chk) => {
    chk.checked = true;
    await OptimizeDialog.run();
    chk.checked = false;
    await OptimizeDialog.run();
    await wait(20);
    assert.equal(calls.confirms.length, 2, 'asked once per run attempt, in both paths');
    assert.equal(calls.confirms[0].title, Util.t('modal.opt_calendar_not_loaded_title'));
    assert.equal(calls.confirms[0].tone, 'warn');
    assert.equal(calls.bg + calls.fg, 0, 'declining runs nothing');
  }));

// P0-13: run() hides the dialog before its pre-run confirms; a Cancel must bring it back with its state, not leave
// the planner with nothing (and the next open() reseeding scope/lines/window).
test('P0-13: cancelling the calendar confirm re-shows the Optimize dialog instead of discarding it', () =>
  withCalendarGate('failed', false, async (calls, chk) => {
    const modal = globalThis.document.getElementById('modal-optimize');
    const inner = makeSandboxElement('opt-modal-inner');
    modal.querySelector = sel => (sel === '.opt-modal' ? inner : null);
    OptimizeDialog.open();
    assert.equal(modal.hidden, false);
    chk.checked = false;
    await OptimizeDialog.run();
    await wait(20);
    assert.equal(calls.confirms.length, 1);
    assert.equal(modal.hidden, false, 'Cancel leaves the dialog open');
    assert.equal(inner.classList.contains('visible'), true, 'and visible (not faded out)');
    assert.equal(calls.bg + calls.fg, 0);
  }));

// P0-14: no stuck spinner on early returns or exceptions.
test('P0-14: an exception in the pre-run steps restores the Run button, drops the spinner and logs', () =>
  withCalendarGate('failed', false, async (calls, chk) => {
    const runBtn = globalThis.document.getElementById('opt-run-btn');
    runBtn.innerHTML = 'RUN';
    runBtn.disabled = false;
    runBtn.dataset.busy = 'running';
    Modal.confirm = async () => { throw new Error('confirm exploded'); };
    const priorHide = OptimizerPreview.hideLoading;
    const priorErr = ErrorLog.error;
    let hides = 0;
    const logged = [];
    OptimizerPreview.hideLoading = () => { hides++; };
    ErrorLog.error = (...a) => { logged.push(a); };
    try {
      chk.checked = false;
      await OptimizeDialog.run();   // must resolve, not reject
      assert.match(runBtn.innerHTML, new RegExp(Util.t('btn.run_optimization')), 'the Run button is restored to its ready label');
      assert.equal(runBtn.dataset.busy, undefined, 'and no longer flagged busy');
      assert.equal(runBtn.disabled, false);
      assert.ok(hides >= 1, 'the spinner is taken down');
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][1]), /Optimize run failed/);
      assert.equal(calls.fg + calls.bg, 0);
    } finally {
      OptimizerPreview.hideLoading = priorHide;
      ErrorLog.error = priorErr;
    }
  }));

test('P0-14: runWithPreview with an empty Store takes the spinner down without aborting the previous run or bumping the token', () => {
  const fx = openBackgroundFixture();
  const priorTasks = structuredClone(Store.tasksArr);
  const priorHide = OptimizerPreview.hideLoading;
  const priorToast = Toast.show;
  try {
    Store.setTasks([], 'unit-test');
    let hides = 0;
    OptimizerPreview.hideLoading = () => { hides++; };
    Toast.show = () => {};
    let aborted = false;
    OptimizerPreview._workerAbortController = { abort() { aborted = true; } };
    const seq = OptimizerPreview._runSeq;
    OptimizerPreview.runWithPreview('spt', { plant: 'SR' });
    assert.equal(hides, 1, 'the spinner is dropped');
    assert.equal(aborted, false, 'the previous run is left alone');
    assert.equal(OptimizerPreview._runSeq, seq, 'the run token is not bumped');
  } finally {
    OptimizerPreview.hideLoading = priorHide;
    Toast.show = priorToast;
    OptimizerPreview._workerAbortController = null;
    Store.setTasks(priorTasks, 'unit-test');
    fx.restore();
  }
});

// P0-15: a window that ends before it starts names its real reason; it is not an empty plan or "no validation metadata".
test('P0-15: a reversed window shows the invalid-horizon reason in the failure card and never installs a plan', async () => {
  const fx = openSingleRevealFixture('SR', singleRevealTasks);
  try {
    OptimizerPreview.showLoading('spt', 'SR');
    OptimizerPreview.runWithPreview('spt', { plant: 'SR', respectCalendar: false, now: new Date('2026-08-03T08:00:00'),
      startDate: new Date('2026-08-03T08:00:00'), endDate: new Date('2026-08-01T08:00:00') });
    for (let i = 0; i < 200 && fx.root.classList.contains('opt-pv-loading'); i++) await wait(10);
    assert.ok(!fx.root.classList.contains('opt-pv-loading'));
    assert.match(fx.body.innerHTML, /horizon must end after/);
    assert.equal(OptimizerPreview._previewDiagnostics?.[0]?.code, 'candidate-evaluation-failed');
  } finally {
    fx.restore();
  }
});

test('P0-15: Run refuses a From at or after To before closing the dialog', () =>
  withCalendarGate('hydrated', true, async (calls) => {
    const modal = globalThis.document.getElementById('modal-optimize');
    const pickers = {};
    globalThis.flatpickr = (sel) => (pickers[sel] = { selectedDates: [], set() {}, setDate() {}, destroy() {} });
    OptimizeDialog.setTimeMode(false);
    OptimizeDialog.setTimeMode(true);   // rebuilds the pickers through the stub above
    const toasts = [];
    const priorToast = Toast.show;
    Toast.show = (msg) => { toasts.push(String(msg)); };
    try {
      pickers['#opt-from-cal'].selectedDates = [new Date('2026-09-10T08:00:00')];
      OptimizeDialog.commitFrom();
      pickers['#opt-to-cal'].selectedDates = [new Date('2026-09-01T08:00:00')];
      OptimizeDialog.commitTo();
      await OptimizeDialog.run();
      await wait(20);
      assert.equal(calls.fg + calls.bg, 0, 'nothing runs');
      assert.equal(modal.hidden, false, 'the dialog stays open');
      assert.ok(toasts.some(t => /After the From|after the From|opt_window_invalid/i.test(t)), 'the planner is told why: ' + JSON.stringify(toasts));
    } finally {
      Toast.show = priorToast;
      OptimizeDialog.setTimeMode(false);
    }
  }));

// P0-19: Remove Backlog forces Respect calendar on for its own run; that must not overwrite the planner's saved choice.
test('P0-19: Remove Backlog restores the planner Respect-calendar choice when another strategy is picked, and never saves the forced value', () =>
  withCalendarGate('hydrated', true, async (calls) => {
    const cal = makeSandboxElement('opt-chk-calendar');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'opt-chk-calendar' ? cal : baseGet(id));
    const priorSet = Session.setPref;
    const saved = [];
    Session.setPref = (key, value) => { saved.push({ key, value }); };
    try {
      OptimizeDialog.open();
      cal.checked = false;
      OptimizeDialog.selectMode('backlog');
      assert.equal(cal.checked, true, 'Backlog forces calendar on for its run');
      assert.equal(cal.disabled, true);
      await OptimizeDialog.run();
      await wait(20);
      const persisted = saved.find(entry => entry.key === 'optimizerDefaults');
      assert.equal(persisted.value.respectCalendar, false, 'the saved value is the planner choice, not the forced one');
      OptimizeDialog.selectMode('spt');
      assert.equal(cal.checked, false, 'leaving Backlog restores the planner choice');
      assert.equal(cal.disabled, false);
      // A choice made while on another strategy is kept across a Backlog round trip.
      cal.checked = true;
      OptimizeDialog.selectMode('backlog');
      OptimizeDialog.selectMode('duedate');
      assert.equal(cal.checked, true);
    } finally {
      Session.setPref = priorSet;
      globalThis.document.getElementById = baseGet;
    }
  }));

// P0-19: a quick close() then open() must not be hidden by the first close's 230 ms fade timer.
test('P0-19: a close() fade timer does not hide a dialog that was reopened inside the fade', async () => {
  const fx = openBackgroundFixture();
  const priorRaf = globalThis.requestAnimationFrame;
  const priorMaster = Store.masterData;
  try {
    globalThis.requestAnimationFrame = () => 1;
    globalThis.flatpickr = () => new Proxy({ selectedDates: [] }, { get: (target, key) => (key in target ? target[key] : () => {}) });
    const modal = makeSandboxElement('modal-optimize');
    const baseGet = globalThis.document.getElementById;
    globalThis.document.getElementById = id => (id === 'modal-optimize' ? modal : baseGet(id));
    OptimizeDialog.open();
    OptimizeDialog.close();          // schedules the 230 ms hide
    OptimizeDialog.open();           // reopened inside the fade
    await wait(300);
    assert.equal(modal.hidden, false, 'the stale fade timer must not hide the reopened dialog');
  } finally {
    delete globalThis.flatpickr;
    globalThis.requestAnimationFrame = priorRaf;
    fx.restore();
  }
});

test('Gap C: a pending calendar also asks, and "Run anyway" proceeds in both the background and foreground paths', () =>
  withCalendarGate('pending', true, async (calls, chk) => {
    chk.checked = true;
    await OptimizeDialog.run();
    chk.checked = false;
    await OptimizeDialog.run();
    await wait(20);
    assert.equal(calls.confirms.length, 2);
    assert.equal(calls.bg, 1);
    assert.equal(calls.fg, 1);
  }));

test('Gap C: a hydrated plant calendar runs without any extra confirmation', () =>
  withCalendarGate('hydrated', false, async (calls, chk) => {
    chk.checked = true;
    await OptimizeDialog.run();
    chk.checked = false;
    await OptimizeDialog.run();
    await wait(20);
    assert.equal(calls.confirms.length, 0);
    assert.equal(calls.bg, 1);
    assert.equal(calls.fg, 1);
  }));

test('Run in background: selectMode(backlog) disables and unchecks the box; other strategies re-enable it', () => {
  const fx = openBackgroundFixture();
  try {
    const chk = fx.extra.get('opt-chk-background');
    const label = fx.extra.get('opt-background-label');
    chk.checked = true;
    OptimizeDialog.selectMode('backlog');
    assert.equal(chk.disabled, true);
    assert.equal(chk.checked, false);
    assert.ok(label.title, 'the disabled box carries a tooltip');
    OptimizeDialog.selectMode('spt');
    assert.equal(chk.disabled, false);
    assert.equal(label.title, '');
  } finally {
    OptimizeDialog.selectMode('changeover');
    fx.restore();
  }
});

test('Background popup: a same-plant result keeps the Switch button hidden and never shows an unfilled placeholder', async () => {
  const fx = openBackgroundFixture();
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    OptimizerPreview._renderBackgroundDone();
    const switchBtn = fx.extra.get('opt-bg-switch-btn');
    assert.equal(switchBtn.hidden, true);
    assert.ok(!String(switchBtn.textContent).includes('{{'), 'no raw {{plant}} placeholder');
    assert.ok(!String(fx.extra.get('opt-bg-done-body').innerHTML).includes('{{'));
  } finally {
    fx.restore();
  }
});

test('O9: Apply drops an order the proposal placed into a running order\'s old slot, instead of committing an overlap', async () => {
  const fx = openBackgroundFixture('BX', boardTasks());
  const priorIsInProgress = Engine.isInProgress;
  try {
    await OptimizerPreview.runInBackground('spt', fx.opts);
    const { result } = OptimizerPreview._backgroundRun;
    const x = patchById(result, 'bx-x'); const y = patchById(result, 'bx-y');
    const xLive = { start: Store.tasks['bx-x'].start_date, end: Store.tasks['bx-x'].end_date };
    assert.ok(overlaps({ start: y.changes.start_date, end: y.changes.end_date }, xLive),
      'precondition: the optimizer puts Y into the slot X occupies now');
    assert.notEqual(+x.changes.start_date, +xLive.start, 'precondition: the optimizer moves X out of that slot');
    OptimizerPreview.present(result, { open: false });
    // X started running while the preview was open: its patch is dropped, but Y still targets X's old slot.
    Engine.isInProgress = (task, now) => (task.id === 'bx-x' ? true : priorIsInProgress.call(Engine, task, now));

    await OptimizerPreview.apply();

    assert.equal(+Store.tasks['bx-x'].start_date, +xLive.start, 'the running order keeps its slot');
    assert.equal(Store.tasks['bx-y'].start_date, null, 'Y is not committed on top of the running order');
    assert.ok(Store.tasks['bx-z'].start_date instanceof Date, 'the unrelated order still applies');
    assert.ok(fx.toasts.some(t => t.type === 'warn' && /opt_apply_running_skipped|running/i.test(t.msg)), 'the running skip is still reported');
    assert.ok(fx.toasts.some(t => t.type === 'warn' && /opt_apply_invalid_dropped|no longer fit/i.test(t.msg)), 'the validation drop is reported separately');
  } finally {
    Engine.isInProgress = priorIsInProgress;
    fx.restore();
  }
});

test('S7-15: What-If discard snapshots and restores Persistence._dirtySource alongside the dirty sets', () => {
  const priorNimbus = globalThis.NIMBUS;
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasksArr);
  const priorSource = new Map(Persistence._dirtySource);
  const priorSchedule = Alerts.scheduleRecompute;
  globalThis.NIMBUS = {};
  Alerts.scheduleRecompute = () => {};
  const unsubscribeAdapter = subscribeSandboxAdapter();
  try {
    Store.setTasks([{ id: 'ds-kept', PLANT: 'DS', MACHINE: 'DS-L', RUN_TIME: 1 }, { id: 'ds-trial', PLANT: 'DS', MACHINE: 'DS-L', RUN_TIME: 1 }], 'unit-test');
    Persistence._dirtySource.clear();
    Persistence._dirtySource.set('ds-kept', 'drag');
    Sandbox.enter('unit-test');
    Persistence._dirtySource.set('ds-trial', 'optimizer');   // a source stamped inside the trial
    Persistence._dirtySource.set('ds-kept', 'keyboard');     // and an overwrite of a pre-enter one
    Sandbox.exit(false, 'unit-test');
    assert.deepEqual([...Persistence._dirtySource], [['ds-kept', 'drag']], 'discard restores the pre-enter source map exactly');
  } finally {
    if (Sandbox.active) Sandbox.exit(false, 'unit-test');
    unsubscribeAdapter();
    SandboxAdapter._clearSideEffectSnapshot?.();
    Persistence._dirtySource.clear();
    for (const [id, src] of priorSource) Persistence._dirtySource.set(id, src);
    Alerts.scheduleRecompute = priorSchedule;
    Store.setTasks(priorTasks, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    globalThis.NIMBUS = priorNimbus;
  }
});

/** Count reads of Store.tasksArr (the baseline compare and the snapshot are its only readers on the Apply path). */
function countTasksArrReads(fn) {
  const desc = Object.getOwnPropertyDescriptor(Store, 'tasksArr');
  let reads = 0;
  Object.defineProperty(Store, 'tasksArr', { configurable: true, get() { reads++; return desc.get.call(Store); } });
  try { fn(); } finally { Object.defineProperty(Store, 'tasksArr', desc); }
  return reads;
}

test('P1-3: apply() compares the task baseline once and takes one live snapshot', () => {
  const plant = 'P13-APPLY';
  const fixture = openTaskBaselinePreview(plant, [previewTask('p13-long', plant, 5), previewTask('p13-short', plant, 1)]);
  try {
    const reads = countTasksArrReads(() => OptimizerPreview.apply());
    assert.equal(OptimizerPreview._candidate, null, 'the Apply went through');
    assert.equal(reads, 2, 'one baseline compare (canApply) plus one snapshotSchedule, not three');
  } finally { fixture.restore(); }
});

test('P1-3: the baseline verdict is memoised on Store.rev() and every task change still stales the preview', () => {
  const plant = 'P13-MEMO';
  const other = 'P13-MEMO-OTHER';
  const mk = () => [previewTask('p13-a', plant), previewTask('p13-b', plant)];
  // unchanged rev: second canApply does not re-read the task set
  let fixture = openTaskBaselinePreview(plant, mk());
  try {
    assert.equal(OptimizerPreview.canApply(), true);
    assert.equal(countTasksArrReads(() => { assert.equal(OptimizerPreview.canApply(), true); }), 0, 'memo hit on an unchanged revision');
  } finally { fixture.restore(); }
  // update
  fixture = openTaskBaselinePreview(plant, mk());
  try {
    assert.equal(OptimizerPreview.canApply(), true);
    Store.updateTask('p13-a', { RUN_TIME: 9 }, 'manual-edit');
    assert.equal(OptimizerPreview.canApply(), false, 'update after a memoised verdict');
    assert.equal(OptimizerPreview.stale, true);
  } finally { fixture.restore(); }
  // add
  fixture = openTaskBaselinePreview(plant, mk());
  try {
    assert.equal(OptimizerPreview.canApply(), true);
    Store.setTasks([...Store.tasksArr, previewTask('p13-new', plant)], 'backend');
    assert.equal(OptimizerPreview.canApply(), false, 'added task after a memoised verdict');
  } finally { fixture.restore(); }
  // remove
  fixture = openTaskBaselinePreview(plant, mk());
  try {
    assert.equal(OptimizerPreview.canApply(), true);
    Store.removeTask('p13-b', 'server-delete');
    assert.equal(OptimizerPreview.canApply(), false, 'removed task after a memoised verdict');
  } finally { fixture.restore(); }
  // plant move out of the preview plant
  fixture = openTaskBaselinePreview(plant, mk());
  try {
    assert.equal(OptimizerPreview.canApply(), true);
    Store.updateTask('p13-b', { PLANT: other, plant: other, MACHINE: other + '-LINE' }, 'manual-edit');
    assert.equal(OptimizerPreview.canApply(), false, 'plant move after a memoised verdict');
  } finally { fixture.restore(); }
});
