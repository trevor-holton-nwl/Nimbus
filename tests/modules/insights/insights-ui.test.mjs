// Tests for frontend/insights/insights-ui.mts (Dashboard, AlertsUIAdapter). Split
// from tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard, AlertsUIAdapter } from '../../../frontend/insights/insights-ui.mjs';
import { Table } from '../../../frontend/scheduling/orders.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

// Same split-realm/no-DOM situation documented in
// tests/modules/optimization/engine.test.mjs and
// tests/modules/scheduling/persistence.test.mjs.
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

test('Dashboard exposes init/render', () => {
  assert.equal(typeof Dashboard.init, 'function');
  assert.equal(typeof Dashboard.render, 'function');
});

test('Dashboard alert summary treats quote-bearing setup alert IDs as data and delegates actions unchanged', () => {
  // Regression target: setup-uncovered IDs embed a JSON state pair. Interpolating
  // that ID into inline JavaScript closes the double-quoted onclick attribute and
  // renders the rest of the handler around the otherwise-correct alert message.
  const alertId = 'setup-uncovered-setup-uncovered|5512/1000TA|[["colorWheel","BLUE SPRUCE"]]->[["colorWheel","O\'RING"]]';
  const alertMessage = 'No changeover time defined for Color BLUE SPRUCE → Color O\'RING on 1000TA. Add a setup rule to the matrix.';
  const list = { innerHTML: '', onclick: null, insertAdjacentHTML() {} };
  const count = { textContent: '' };
  const priorGetElementById = globalThis.document.getElementById;
  const priorMasterData = structuredClone(Store.masterData);
  const priorPlant = Store.selectedPlant;
  const priorAlerts = structuredClone(Store.alerts);
  const priorFocus = AlertsUIAdapter.focus;
  const priorDismiss = Alerts.dismiss;
  let focusedId = null;
  let dismissedId = null;
  let stopped = 0;

  try {
    globalThis.document.getElementById = id => {
      if (id === 'alert-summary-list') return list;
      if (id === 'alert-summary-count') return count;
      return null;
    };
    Store.setMasterData({
      plants: [{ plant: '5512' }],
      lines: [{ plant: '5512', machine: '1000TA' }],
    }, 'unit-test');
    Store.setSelectedPlant('5512', 'unit-test');
    Store.setAlerts([{
      id: alertId, type: 'setup-uncovered', sev: 'err', msg: alertMessage,
      taskId: 'setup-successor', line: '1000TA', time: new Date('2026-08-18T10:00:00'),
    }], 'unit-test');
    AlertsUIAdapter.focus = id => { focusedId = id; };
    Alerts.dismiss = id => { dismissedId = id; };

    Dashboard._renderAlertSummary();

    assert.doesNotMatch(list.innerHTML, /\sonclick=/, 'alert data must never be emitted as inline JavaScript');
    assert.match(list.innerHTML, /data-alert-action="focus"/);
    assert.match(list.innerHTML, /data-alert-action="dismiss"/);
    assert.match(list.innerHTML, /&quot;/, 'JSON quotes must be encoded in the HTML attribute');
    assert.match(list.innerHTML, /&#39;/, 'apostrophes must be encoded in the HTML attribute');
    assert.equal(typeof list.onclick, 'function', 'the summary host owns one delegated click handler');

    list.onclick({
      target: { closest: () => ({ dataset: { alertAction: 'focus', alertId } }) },
      stopPropagation() { stopped++; },
    });
    assert.equal(focusedId, alertId);

    list.onclick({
      target: { closest: () => ({ dataset: { alertAction: 'dismiss', alertId } }) },
      stopPropagation() { stopped++; },
    });
    assert.equal(dismissedId, alertId);
    assert.equal(stopped, 1, 'dismiss stops the row-level focus action');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    AlertsUIAdapter.focus = priorFocus;
    Alerts.dismiss = priorDismiss;
    Store.setAlerts(priorAlerts, 'unit-test');
    Store.setMasterData(priorMasterData, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

// Pulled out of schedule-workbench.test.mjs's combined 'EditCalendar/
// ColorWheelViewer/Printer/SandboxAdapter/AlertsUIAdapter expose their
// documented public API' smoke test, which spanned five modules across four
// different new files.
test('AlertsUIAdapter exposes the documented public API', () => {
  assert.equal(typeof AlertsUIAdapter.toggleDrawer, 'function');
});

test('alert drawer renders quote-bearing IDs as action data and delegates the original value', () => {
  const alertId = 'setup-uncovered|[["colorWheel","O\'RING <RED>"]]->[["colorWheel","RUBY"]]';
  const row = AlertsUIAdapter._renderAlertRow({
    id: alertId, type: 'setup-uncovered', sev: 'err', msg: 'Missing setup rule.',
    taskId: 'setup-successor', line: '1000TA', time: new Date('2026-08-18T10:00:00'),
  });

  assert.doesNotMatch(row, /\sonclick=/, 'drawer actions must not compile alert data as JavaScript');
  assert.match(row, /data-alert-action="focus"/);
  assert.match(row, /data-alert-action="dismiss"/);
  assert.match(row, /&quot;/);
  assert.match(row, /&#39;/);
  assert.match(row, /&lt;RED&gt;/);
  assert.equal(typeof AlertsUIAdapter._handleAction, 'function');

  const priorFocus = AlertsUIAdapter.focus;
  let focusedId = null;
  try {
    AlertsUIAdapter.focus = id => { focusedId = id; };
    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'focus', alertId } }) },
      stopPropagation() {},
    });
    assert.equal(focusedId, alertId);
  } finally {
    AlertsUIAdapter.focus = priorFocus;
  }
});

test('alert drawer delegates fix and override actions without compiling IDs into handlers', () => {
  const alertId = 'overlap|[["colorWheel","O\'RING"]]';
  const taskId = 'task-"quoted"';
  const fixRow = AlertsUIAdapter._renderAlertRow({
    id: alertId, type: 'overlap', sev: 'err', msg: 'Overlap.', taskId, line: '1000TA', time: new Date(),
  });
  const overrideRow = AlertsUIAdapter._renderAlertRow({
    id: 'closed-alert', type: 'closed', sev: 'warn', msg: 'Closed.', taskId, line: '1000TA', time: new Date(),
  });
  assert.doesNotMatch(fixRow, /\sonclick=/);
  assert.doesNotMatch(overrideRow, /\sonclick=/);
  assert.match(fixRow, /data-alert-action="fix"/);
  assert.match(overrideRow, /data-alert-action="override"/);

  const priorApplyFix = Alerts.applyFix;
  const priorToggleDrawer = AlertsUIAdapter.toggleDrawer;
  const priorOpenOverride = Table._openOverrideModalForId;
  let fixedId = null;
  let drawerToggles = 0;
  let overrideTaskId = null;
  try {
    Alerts.applyFix = id => { fixedId = id; };
    AlertsUIAdapter.toggleDrawer = () => { drawerToggles++; };
    Table._openOverrideModalForId = id => { overrideTaskId = id; };

    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'fix', alertId } }) },
      stopPropagation() {},
    });
    AlertsUIAdapter._handleAction({
      target: { closest: () => ({ dataset: { alertAction: 'override', taskId } }) },
      stopPropagation() {},
    });

    assert.equal(fixedId, alertId);
    assert.equal(drawerToggles, 1);
    assert.equal(overrideTaskId, taskId);
  } finally {
    Alerts.applyFix = priorApplyFix;
    AlertsUIAdapter.toggleDrawer = priorToggleDrawer;
    Table._openOverrideModalForId = priorOpenOverride;
  }
});

test('alert drawer renders tool-conflict alerts with localized text and a fix button', () => {
  const row = AlertsUIAdapter._renderAlertRow({
    id: 'tool-conflict|task-b|task-a', type: 'tool-conflict', sev: 'err',
    msg: 'Tool "PRT_01" is needed by "task-a" on 1000TA and "task-b" on 1000TB at the same time.',
    msgKey: 'alert.tool_conflict',
    msgVars: { tool: 'PRT_01', a: 'task-a', b: 'task-b', lineA: '1000TA', lineB: '1000TB' },
    taskId: 'task-b', peerId: 'task-a', line: '1000TB', time: new Date(),
  });

  // Util.t has no locale dictionary loaded in this unit-test environment, so it
  // falls back to the key itself — this still proves the msgKey path is taken
  // rather than the raw English a.msg fallback string.
  assert.match(row, /alert-msg">alert\.tool_conflict</);
  assert.doesNotMatch(row, /Tool "PRT_01" is needed/);
  assert.match(row, /data-alert-action="fix"/);
});

test('alert drawer host binds the delegated action handler even in its empty state', () => {
  const body = { innerHTML: '', onclick: null };
  const priorGetElementById = globalThis.document.getElementById;
  const priorAlerts = structuredClone(Store.alerts);
  try {
    globalThis.document.getElementById = id => id === 'alert-drawer-body' ? body : null;
    Store.setAlerts([], 'unit-test');

    assert.equal(typeof AlertsUIAdapter._handleAction, 'function');
    AlertsUIAdapter.renderDrawer();

    assert.equal(body.onclick, AlertsUIAdapter._handleAction);
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Store.setAlerts(priorAlerts, 'unit-test');
  }
});

test('Dashboard._ordersTileSubtitle appends the sub-orders note only when the current plant has sub-orders, regardless of distributionSummary', () => {
  const priorPlant = Store.selectedPlant;
  const priorTasks = structuredClone(Store.tasks);
  const priorDistribution = Store.distributionSummary;
  try {
    Store.setSelectedPlant('P-SUBTITLE-TEST', 'unit-test');

    // No sub-orders for this plant (no PARENT_ORDER) — plain total, even
    // though a distribution summary is set (D52: the summary carries no
    // "has sub-orders" field, so its mere presence must not drive this).
    Store.setTasks([
      { id: 'subtitle-solo', PLANT: 'P-SUBTITLE-TEST', MACHINE: 'L1' },
    ], 'unit-test');
    Store._state.distributionSummary = { needs_review: 3, changed: 2, problems: 0 };
    const soloTasks = Store.tasksForSelectedPlant();
    assert.equal(
      Dashboard._ordersTileSubtitle(soloTasks),
      Util.t('kpi.orders_total', { n: soloTasks.length }),
      'no sub-orders note when the plant has no PARENT_ORDER tasks'
    );

    // Plant has at least one sub-order group — note appended.
    Store.setTasks([
      { id: 'subtitle-a', PLANT: 'P-SUBTITLE-TEST', PARENT_ORDER: 'SAP-SUBTITLE', DISTRIBUTION_LETTER: 'A', MACHINE: 'L1' },
      { id: 'subtitle-b', PLANT: 'P-SUBTITLE-TEST', PARENT_ORDER: 'SAP-SUBTITLE', DISTRIBUTION_LETTER: 'B', MACHINE: 'L1' },
    ], 'unit-test');
    Store._state.distributionSummary = null;
    const subTasks = Store.tasksForSelectedPlant();
    assert.equal(
      Dashboard._ordersTileSubtitle(subTasks),
      Util.t('kpi.orders_total', { n: subTasks.length }) + ' · ' + Util.t('kpi.orders_sub_counted'),
      'sub-orders note appended when the plant has a PARENT_ORDER task, even with no distributionSummary'
    );
  } finally {
    Store._state.distributionSummary = priorDistribution;
    Store.setTasks(Object.values(priorTasks), 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
  }
});

test('Dashboard _renderSituation appends distribution segment when needs_review > 0', () => {
  const el = { textContent: '', classList: { toggle() {} } };
  const priorGetElementById = globalThis.document.getElementById;
  const priorDistribution = Store.distributionSummary;
  try {
    globalThis.document.getElementById = id => id === 'wh-situation' ? el : null;

    // Test 1: No distribution review needed
    Store._state.distributionSummary = null;
    Dashboard._renderSituation({ todayCount: 5, attention: 0 });
    assert.doesNotMatch(el.textContent, /distribution/, 'no distribution segment when summary is null');

    // Test 2: Distribution review needed (needs_review = 2)
    Store._state.distributionSummary = { needs_review: 2, changed: 1, problems: 0 };
    Dashboard._renderSituation({ todayCount: 5, attention: 0 });
    assert.match(el.textContent, /distribution/, 'distribution segment appended when needs_review > 0');

    // Test 3: Attention + distribution
    Store._state.distributionSummary = { needs_review: 1, changed: 0, problems: 0 };
    Dashboard._renderSituation({ todayCount: 5, attention: 2 });
    assert.match(el.textContent, /distribution/, 'distribution segment works with attention items');
  } finally {
    globalThis.document.getElementById = priorGetElementById;
    Store._state.distributionSummary = priorDistribution;
  }
});
