// Tests for frontend/insights/insights-ui.mts (Dashboard, AlertsUIAdapter). Split
// from tests/modules/schedule-workbench.test.mjs (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that mega-module
// into 6 domain files) to mirror the new file layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard, AlertsUIAdapter } from '../../../frontend/insights/insights-ui.mjs';
import { Table, Inspector } from '../../../frontend/scheduling/orders.mjs';
import { Timeline } from '../../../frontend/scheduling/gantt.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Alerts, Utilization } from '../../../frontend/insights/services.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { createRequire } from 'node:module';

// Utilization / Util delegate to the UMD compute core through this ambient global (a real browser loads it first).
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

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

test('heatmap foreground meets AA across both theme ramps, including warning orange', () => {
  const themes = [
    ['#f4f7fa', '#1f5fbf', '#93610a', '#f39c12', '#b02a20', '#1c2b3a'],
    ['#16212f', '#5a9bf0', '#d09010', '#e0a018', '#d94a3a', '#e8edf3'],
  ];
  for (const colors of themes) {
    for (let pair = 0; pair < 4; pair++) {
      for (let step = 0; step <= 100; step++) {
        const bg = Dashboard._lerpHex(colors[pair], colors[pair + 1], step / 100);
        const fg = Dashboard._heatForeground(bg, colors[5], '#ffffff');
        const a = Dashboard._relLuminance(bg), b = Dashboard._relLuminance(fg);
        assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${fg} on ${bg}`);
      }
    }
  }
});

test('heatmap ramp: 100% is solid err, 25% is the info stop, 0 is idle', () => {
  const prior = { doc: globalThis.document, cs: globalThis.getComputedStyle, vis: Dashboard._visibleLines };
  const tokens = { '--bg-subtle': '#eeeeee', '--info': '#1f5fbf', '--warn': '#93610a', '--warn-vivid': '#f39c12', '--err': '#b02a20' };
  const panel = { innerHTML: '', querySelectorAll: () => [] };
  try {
    globalThis.document = { ...prior.doc, body: {}, getElementById: id => id === 'util-heatmap-panel' ? panel : null };
    globalThis.getComputedStyle = () => ({ getPropertyValue: n => tokens[n] || '' });
    Dashboard._visibleLines = () => ['L1'];
    const mk = pct => ({ L1: { '2020-01-01': { pct, capacity: 8, scheduled: 8 * pct } } });
    const bgOf = pct => { Dashboard._renderHeatmap(mk(pct)); return /class="hm-cell"[^>]*style="background:(#[0-9a-f]{6})/.exec(panel.innerHTML)[1]; };
    assert.equal(bgOf(1.0), '#b02a20');
    assert.equal(bgOf(1.4), '#b02a20');
    assert.equal(bgOf(0.25), '#1f5fbf');
    assert.equal(bgOf(0.5), '#93610a');
    assert.equal(bgOf(0.75), '#f39c12');
    assert.equal(bgOf(0), '#eeeeee');
  } finally { globalThis.document = prior.doc; globalThis.getComputedStyle = prior.cs; Dashboard._visibleLines = prior.vis; }
});

test('heatmap reads tokens from the themed body', () => {
  const prior = globalThis.getComputedStyle;
  const priorDoc = globalThis.document;
  try {
    globalThis.document = { body: {}, documentElement: {} };
    globalThis.getComputedStyle = el => ({ getPropertyValue: () => el === globalThis.document.body ? '#16212f' : '#f4f7fa' });
    assert.equal(Dashboard._cssVar('--bg-subtle', '#ffffff'), '#16212f');
  } finally { globalThis.getComputedStyle = prior; globalThis.document = priorDoc; }
});

test('bell and drawer share plant-scoped horizons using the plant clock; footer remains singular', () => {
  const prior = { doc: globalThis.document, plant: Store.selectedPlant, alerts: Store.alerts, master: Store.masterData,
    clock: Util.plantClock, vl: AlertsUIAdapter._drawerVL, vlPlant: AlertsUIAdapter._drawerVLPlant,
    dismissed: new Set(Alerts._dismissed), translate: Util.t };
  const badge = { style: {}, textContent: '' }, bell = { style: {} }, footer = { hidden: true, textContent: '' };
  const body = { innerHTML: '', insertAdjacentHTML() { throw new Error('footer must live outside virtual rows'); } };
  let rows = [];
  try {
    globalThis.document = { ...prior.doc, getElementById: id => ({ 'alert-badge': badge, 'alert-bell': bell,
      'alert-drawer-body': body, 'alert-drawer-footer': footer })[id] || null };
    Store.setMasterData({ plants: [{ plant: 'AUDIT-P', alt_flag_horizon: 60 }],
      lines: [{ plant: 'AUDIT-P', machine: 'AUDIT-L' }, { plant: 'OTHER-P', machine: 'OTHER-L' }] }, 'test');
    Store.setSelectedPlant('AUDIT-P', 'test');
    Util.plantClock = () => new Date('2020-01-01T08:00:00');
    Util.t = (key, vars) => key === 'alert.horizon_hidden_duration' ? vars.duration : prior.translate(key, vars);
    Store.setAlerts([
      { id: 'visible', line: 'AUDIT-L', sev: 'warn', time: new Date('2020-01-01T08:30:00') },
      { id: 'hidden', line: 'AUDIT-L', sev: 'err', time: new Date('2020-01-01T10:00:00') },
      { id: 'other', line: 'OTHER-L', sev: 'err', time: new Date('2020-01-01T08:30:00') },
      { id: 'other-hidden', line: 'OTHER-L', sev: 'err', time: new Date('2020-01-01T10:00:00') },
    ], 'test');
    AlertsUIAdapter._drawerVL = { update(next) { rows = next; }, destroy() {} };
    AlertsUIAdapter.renderBell();
    assert.equal(badge.textContent, '1');
    assert.equal(bell.style.color, 'var(--warn-text)');
    AlertsUIAdapter.renderDrawer(); AlertsUIAdapter.renderDrawer();
    assert.deepEqual(rows.map(a => a.id), ['visible']);
    assert.equal(footer.hidden, false);
    assert.equal(footer.textContent, '1h', 'a 60-minute horizon must not be described as one day');
    Store.masterData.plants[0].alt_flag_horizon = 90;
    AlertsUIAdapter.renderDrawer();
    assert.equal(footer.textContent, '1h 30m', 'minute precision is retained');
    assert.equal(AlertsUIAdapter._visibleAlerts().hiddenCount, 1);
    AlertsUIAdapter.dismissVisible();
    assert.deepEqual(Store.alerts.map(a => a.id), ['hidden', 'other', 'other-hidden']);
    assert.ok(!Alerts._dismissed.has('other'), 'dismiss all respects the displayed plant and window');
    AlertsUIAdapter.renderDrawer();
    assert.equal(footer.hidden, false, 'all-hidden state still explains the horizon');
  } finally {
    globalThis.document = prior.doc; Util.plantClock = prior.clock;
    Util.t = prior.translate;
    AlertsUIAdapter._drawerVL = prior.vl; AlertsUIAdapter._drawerVLPlant = prior.vlPlant;
    Alerts.restoreDismissed(prior.dismissed);
    Store.setMasterData(prior.master, 'test'); Store.setSelectedPlant(prior.plant, 'test'); Store.setAlerts(prior.alerts, 'test');
  }
});

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

test('AlertsUIAdapter.focus: Go To selects via Selection, marks the target, and closes the drawer only if open', () => {
  const prior = {
    gotoLineDay: Timeline.gotoLineDay, markTask: Timeline.markGotoTask, markCell: Timeline.markGotoCell, tl: Timeline._tl,
    show: Inspector.show, toggle: AlertsUIAdapter.toggleDrawer, doc: globalThis.document,
    alerts: Store._state.alerts, ids: Selection.ids(),
  };
  const calls = [];
  let drawerOpen = true;
  try {
    Timeline.gotoLineDay = (line, day, cb) => { calls.push('goto'); cb(); };
    Timeline.markGotoTask = id => calls.push(`task:${id}`);
    Timeline.markGotoCell = (line, day) => calls.push(`cell:${line}:${day}`);
    Timeline._tl = {};
    Inspector.show = t => calls.push(`inspector:${t.id}`);
    AlertsUIAdapter.toggleDrawer = () => { calls.push('toggle'); drawerOpen = !drawerOpen; };
    globalThis.document = { getElementById: () => ({ classList: { contains: () => drawerOpen } }) };
    Store._state.tasks.T1 = { id: 'T1', start_date: new Date('2026-08-12T08:00:00'), end_date: new Date('2026-08-12T10:00:00') };
    Store._state.tasks.T2 = { id: 'T2', start_date: null, end_date: null };
    Store._state.alerts = [{ id: 'a1', taskId: 'T1', line: 'L1', time: new Date('2026-08-12T08:00:00') }];
    Selection.clear();

    AlertsUIAdapter.focus('a1');
    assert.deepEqual(Selection.ids(), ['T1'], 'target is selected through Selection');
    assert.ok(!calls.includes('inspector:T1'), 'Inspector is driven by the Selection listener, not called directly');
    assert.deepEqual(calls.filter(c => c !== 'goto'), ['task:T1', 'toggle']);

    // Already the sole selection: Selection.set no-ops, so Inspector.show is called explicitly.
    calls.length = 0; drawerOpen = false;
    AlertsUIAdapter.focus('a1');
    assert.ok(calls.includes('inspector:T1'));
    assert.ok(!calls.includes('toggle'), 'closed drawer is not toggled (would reopen it)');

    // Pairwise alert (tool-conflict / overlap) with a peer in the store: both orders are selected.
    calls.length = 0; Selection.clear();
    Store._state.tasks.T3 = { id: 'T3', start_date: new Date('2026-08-12T09:00:00'), end_date: new Date('2026-08-12T11:00:00') };
    Store._state.alerts = [{ id: 'ap', type: 'tool-conflict', taskId: 'T1', peerId: 'T3', line: 'L1', time: new Date('2026-08-12T08:00:00') }];
    AlertsUIAdapter.focus('ap');
    assert.deepEqual([...Selection.ids()].sort(), ['T1', 'T3']);
    // A peer that is not in the store is ignored (only the alert's own order is selected).
    calls.length = 0; Selection.clear();
    Store._state.alerts = [{ id: 'aq', type: 'overlap', taskId: 'T1', peerId: 'GONE', line: 'L1', time: new Date('2026-08-12T08:00:00') }];
    AlertsUIAdapter.focus('aq');
    assert.deepEqual(Selection.ids(), ['T1']);
    delete Store._state.tasks.T3;

    // Line/day alert (no taskId): rings the day cell, never selects.
    calls.length = 0; Selection.clear();
    Store._state.alerts = [{ id: 'a2', type: 'overload', line: 'L1', time: new Date('2026-08-12T08:00:00') }];
    AlertsUIAdapter.focus('a2');
    assert.ok(calls.includes('cell:L1:2026-08-12'));
    assert.ok(!calls.some(c => c.startsWith('task:')));
    assert.deepEqual(Selection.ids(), []);

    // Undated order (not drawn): falls back to the day cell.
    calls.length = 0;
    Store._state.alerts = [{ id: 'a3', taskId: 'T2', line: 'L1', time: new Date('2026-08-12T08:00:00') }];
    AlertsUIAdapter.focus('a3');
    assert.ok(calls.includes('cell:L1:2026-08-12'));
    assert.deepEqual(Selection.ids(), []);
  } finally {
    Timeline.gotoLineDay = prior.gotoLineDay; Timeline.markGotoTask = prior.markTask; Timeline.markGotoCell = prior.markCell; Timeline._tl = prior.tl;
    Inspector.show = prior.show; AlertsUIAdapter.toggleDrawer = prior.toggle; globalThis.document = prior.doc;
    Store._state.alerts = prior.alerts; delete Store._state.tasks.T1; delete Store._state.tasks.T2; Selection.set(prior.ids);
  }
});

test('drawer and Alert Monitor rows agree on Fix / Override / calendar glyph for every firing alert type', async () => {
  const { rowHtml } = await import('../../../frontend/alert-monitor/alert-monitor-model.mjs');
  const { FIRING_ALERT_TYPES } = await import('../../../frontend/insights/alert-profiles.mjs');
  const t = k => k;
  for (const type of FIRING_ALERT_TYPES) {
    for (const taskId of ['T1', undefined]) {
      const a = { id: `x-${type}`, type, sev: 'err', msg: 'm', taskId, line: 'L1', time: new Date('2026-10-21T08:00:00') };
      const drawer = AlertsUIAdapter._renderAlertRow(a);
      const mon = rowHtml({
        id: a.id, type, sev: 'err', taskId, line: 'L1', time: a.time, headline: 'h', message: 'm', help: '', orderNo: '',
        dateText: '', relText: '', anchorTip: '', points: 1, orders: 1, lateH: 0, whatIf: false, ackLabel: null, diagOpen: false, diagHtml: '',
      }, t);
      assert.equal(/data-alert-action="fix"/.test(mon), /data-alert-action="fix"/.test(drawer), `fix ${type}`);
      assert.equal(/data-alert-action="override"/.test(mon), /data-alert-action="override"/.test(drawer), `override ${type}/${taskId}`);
      assert.equal(mon.includes('⊘'), drawer.includes('⊘'), `calendar glyph ${type}`);
    }
  }
});

test('showForCell files a planning alert under Other and does not throw', () => {
  const prior = { doc: globalThis.document, alerts: Store.alerts };
  let html = '';
  const dlg = {
    className: '', open: false,
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    showModal() {}, close() {}, addEventListener() {}, querySelectorAll() { return []; },
  };
  try {
    globalThis.document = { ...prior.doc, createElement: () => dlg, body: { appendChild() {} } };
    const time = new Date(2026, 9, 21, 9);
    Store._state.alerts = [
      { id: 'queued-now-fits-q1', sev: 'warn', type: 'queued_now_fits', line: 'L1', time, msg: 'Order q1 now fits' },
      { id: 'needs-planning-q2', sev: 'warn', type: 'needs_planning', line: 'L1', time, msg: 'Order q2 has no slot yet' },
    ];
    assert.doesNotThrow(() => AlertsUIAdapter.showForCell('L1', Util.dayKey(time)));
    assert.match(html, /data-cat="exceptions"/, 'both planning alerts file under Other');
    assert.doesNotMatch(html, /data-cat="planning"/, 'the briefing has no fifth section');
    assert.match(html, /Order q1 now fits/);
    assert.match(html, /Order q2 has no slot yet/);
    assert.match(html, /\(2\)/, 'one Other section holding both alerts');
  } finally {
    globalThis.document = prior.doc; Store._state.alerts = prior.alerts;
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

test('alert drawer hides the Fix button on a tool conflict with zero available copies, keeps it otherwise', () => {
  const base = { id: 'toolc-p|T1', type: 'tool-conflict', sev: 'err', msgKey: 'alert.tool_conflict_zero', msgVars: { tool: 'T1' }, taskId: 'p', line: 'L1', time: new Date() };
  assert.doesNotMatch(AlertsUIAdapter._renderAlertRow({ ...base, available: 0 }), /data-alert-action="fix"/);
  assert.match(AlertsUIAdapter._renderAlertRow({ ...base, available: 2 }), /data-alert-action="fix"/);
  assert.match(AlertsUIAdapter._renderAlertRow({ ...base, available: undefined }), /data-alert-action="fix"/);
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


test('Orders Today counts every order that overlaps today on the plant clock (a bar crossing midnight counts on both days)', () => {
  const priorOffset = Store.serverOffsetMs;
  const priorSelected = Store.selectedPlant;
  Store.setMasterData({ plants: [{ plant: 'P-TODAY', timezone: 'UTC' }], lines: [{ machine: 'L-TODAY', plant: 'P-TODAY' }] }, 'unit-test');
  Store.setSelectedPlant('P-TODAY', 'unit-test');
  Store.setServerNow('2026-10-15T14:00:00Z');   // plant today = 2026-10-15
  const mk = (id, start, end) => ({ id, PLANT: 'P-TODAY', MACHINE: 'L-TODAY', RUN_TIME: 1, start_date: start, end_date: end });
  const tasks = [
    mk('crosses', new Date(2026, 9, 14, 22), new Date(2026, 9, 15, 6)),     // Wed 22:00 -> Thu 06:00: overlaps Thursday
    mk('ends-at-midnight', new Date(2026, 9, 14, 20), new Date(2026, 9, 15, 0)),   // ends exactly at Thursday 00:00: not Thursday
    mk('inside', new Date(2026, 9, 15, 9), new Date(2026, 9, 15, 11)),
    mk('tomorrow', new Date(2026, 9, 16, 9), new Date(2026, 9, 16, 11)),
  ];
  try {
    Store.setTasks(tasks, 'unit-test');
    Dashboard._renderKPIs(undefined, tasks);
    assert.equal(Dashboard._lastSituation.todayCount, 2, 'crosses + inside');
  } finally {
    Store.serverOffsetMs = priorOffset;
    Store.setSelectedPlant(priorSelected, 'unit-test');
    Store.setTasks([], 'unit-test');
  }
});

test('U28: the alert-card headline is the localized alert.type.<type> row, and only a missing row falls back to the title-cased type', () => {
  const prior = globalThis.window.__NIMBUS_LOCALES;
  const loc = Util.locale();
  try {
    globalThis.window.__NIMBUS_LOCALES = { [loc]: { 'alert.type.pull_floor_crossed': 'Starts before earliest allowed', 'alert.type.late': 'Verspätet' } };
    assert.equal(AlertsUIAdapter.headlineFor('pull_floor_crossed'), 'Starts before earliest allowed');
    assert.equal(AlertsUIAdapter.headlineFor('late'), 'Verspätet', 'the locale row wins over the type name');
    assert.equal(AlertsUIAdapter.headlineFor('no_operating_window'), 'No Operating Window', 'no row: title-case fallback');
    assert.equal(AlertsUIAdapter.headlineFor('near-capacity'), 'Near Capacity');
  } finally {
    globalThis.window.__NIMBUS_LOCALES = prior;
  }
});

test('U30: the derive-paused banner is a status region and stacks below the concurrency banner when both are up', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../../frontend/', import.meta.url);
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(html, /<div id="derive-paused-banner"[^>]*role="status"/);
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  assert.match(css, /\.concurrency-off #derive-paused-banner\s*\{\s*top:\s*calc\(var\(--chrome-h\) \+ 34px\)/);
  assert.match(css, /\.concurrency-off\.derive-paused \.tab-panel[^{]*\{\s*margin-top:\s*68px/);
});

// ── W6: Machine Status card day stepper ─────────────────────────────────────
function lsFixture() {
  const now = new Date('2026-10-19T09:00:00');
  const keys = Dashboard._lsDayKeys(now);
  const cell = (s, c) => ({ scheduled: s, capacity: c, effectiveCapacity: c, pct: s / c });
  const matrix = { 'L-1': {}, 'L-2': {} };
  keys.forEach((k, i) => { matrix['L-1'][k] = cell(2 + i, 16); matrix['L-2'][k] = cell(i === 1 ? 20 : 4, 16); });
  return { now, keys, matrix };
}

test('W6: day keys are 7 plant days from today and the active key clamps into them', () => {
  const { keys } = lsFixture();
  assert.equal(keys.length, 7);
  assert.deepEqual(keys.slice(0, 2), ['2026-10-19', '2026-10-20']);
  const prior = Dashboard._lsDayKey;
  try {
    Dashboard._lsDayKey = null;            assert.equal(Dashboard._lsActiveKey(keys), keys[0]);
    Dashboard._lsDayKey = '2026-10-01';    assert.equal(Dashboard._lsActiveKey(keys), keys[0]);   // midnight rolled past it
    Dashboard._lsDayKey = '2027-01-01';    assert.equal(Dashboard._lsActiveKey(keys), keys[6]);
    Dashboard._lsDayKey = keys[3];         assert.equal(Dashboard._lsActiveKey(keys), keys[3]);
  } finally { Dashboard._lsDayKey = prior; }
});

test('W6: card rows for day N equal the heatmap matrix column for that day; Next CO is a dash off today', () => {
  const { now, keys, matrix } = lsFixture();
  const lines = ['L-1', 'L-2'], byLine = { 'L-1': [], 'L-2': [] };
  for (let i = 0; i < 7; i++) {
    const rows = Dashboard._lsRowData(lines, byLine, matrix, keys[i], i === 0, now);
    rows.forEach(r => {
      const u = matrix[r.line][keys[i]];
      assert.equal(r.sched, u.scheduled.toFixed(2));
      assert.equal(r.effCap, u.effectiveCapacity.toFixed(2));
      assert.equal(r.pct, Math.round(u.pct * 100));
      assert.equal(r.isOver, u.scheduled > u.effectiveCapacity);
      if (i > 0) assert.equal(r.nxtCO, '—');
    });
  }
  assert.equal(Dashboard._lsRowData(lines, byLine, matrix, keys[1], false, now)[1].isOver, true);
});

test('W6: stepping moves the day key, clamps at both ends, and re-renders only the card', () => {
  const { now, keys, matrix } = lsFixture();
  const prior = { key: Dashboard._lsDayKey, clock: Util.plantClock, plant: Store.selectedPlant, compute: Utilization.computeMatrix,
    render: Dashboard._renderLineStatus, sync: Dashboard._syncLineStatusHeight, full: Dashboard.render };
  const seen = []; let full = 0;
  try {
    Util.plantClock = () => now;
    Utilization.computeMatrix = () => matrix;   // the shared-cache hit the stepper reads
    Dashboard._renderLineStatus = m => { seen.push([Dashboard._lsDayKey, m]); };
    Dashboard._syncLineStatusHeight = () => {};
    Dashboard.render = () => { full++; };
    Dashboard._lsDayKey = null;
    Dashboard._lsStep(-1);                       // already at today: stays
    assert.equal(Dashboard._lsDayKey, keys[0]);
    Dashboard._lsStep(1); Dashboard._lsStep(1);
    assert.equal(Dashboard._lsDayKey, keys[2]);
    for (let i = 0; i < 10; i++) Dashboard._lsStep(1);
    assert.equal(Dashboard._lsDayKey, keys[6]);  // clamped at the last day
    Dashboard._lsStep(-1);
    assert.equal(Dashboard._lsDayKey, keys[5]);
    assert.ok(seen.every(([, m]) => m === matrix), 'card reads the cached 7-day matrix');
    assert.equal(full, 0, 'stepping never triggers a full dashboard render');
  } finally {
    Dashboard._lsDayKey = prior.key; Util.plantClock = prior.clock; Utilization.computeMatrix = prior.compute;
    Dashboard._renderLineStatus = prior.render; Dashboard._syncLineStatusHeight = prior.sync; Dashboard.render = prior.full;
  }
});

test('W6: day control labels, aria and disabled ends', () => {
  const { keys } = lsFixture();
  const mk = () => ({ textContent: '', title: '', disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const label = mk(), prev = mk(), next = mk();
  const priorDoc = globalThis.document, priorKey = Dashboard._lsDayKey, priorT = Util.t;
  try {
    globalThis.document = { ...priorDoc, getElementById: id => ({ 'ls-day-label': label, 'ls-day-prev': prev, 'ls-day-next': next })[id] || null };
    Util.t = k => k;
    Dashboard._renderLsDayControl(keys, keys[0]);
    assert.equal(label.textContent, 'ui.today'); assert.equal(prev.disabled, true); assert.equal(next.disabled, false);
    Dashboard._renderLsDayControl(keys, keys[1]);
    assert.equal(label.textContent, 'ui.tomorrow'); assert.equal(prev.disabled, false);
    assert.equal(prev.attrs['aria-label'], 'ui.ls_day_prev'); assert.equal(next.attrs['aria-label'], 'ui.ls_day_next');
    Dashboard._renderLsDayControl(keys, keys[6]);
    assert.equal(next.disabled, true);
    assert.match(label.textContent, /\d/);       // short weekday + numeric date
  } finally { globalThis.document = priorDoc; Dashboard._lsDayKey = priorKey; Util.t = priorT; }
});

test('W6: plant:selected resets the Machine Status day to today', () => {
  const prior = { sub: Store.subscribe, key: Dashboard._lsDayKey, st: globalThis.setTimeout, si: globalThis.setInterval, win: globalThis.window,
    drop: Dashboard._refreshLineDropdown, btns: Dashboard._refreshFilterBtns, render: Dashboard.render };
  let handler = null;
  try {
    Store.subscribe = fn => { handler = fn; return () => {}; };
    globalThis.setTimeout = () => 0; globalThis.setInterval = () => 0;
    globalThis.window = { ...prior.win, addEventListener() {} };
    Dashboard._refreshLineDropdown = () => {}; Dashboard._refreshFilterBtns = () => {}; Dashboard.render = () => {};
    Dashboard.init();
    assert.ok(handler, 'init subscribes to the Store');
    Dashboard._lsDayKey = '2026-10-23';
    handler({ type: 'plant:selected' });
    assert.equal(Dashboard._lsDayKey, null);
  } finally {
    Store.subscribe = prior.sub; Dashboard._lsDayKey = prior.key; globalThis.setTimeout = prior.st; globalThis.setInterval = prior.si;
    globalThis.window = prior.win; Dashboard._refreshLineDropdown = prior.drop; Dashboard._refreshFilterBtns = prior.btns; Dashboard.render = prior.render;
  }
});

// ---- Alert Monitor (Task 15): the bell, drawer and Dashboard summary follow the profile and acknowledgements ----
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';

const T15_NOW = new Date('2020-01-01T08:00:00');
const t15 = (id, o = {}) => ({ id, line: 'T15-L', sev: 'warn', type: 'overlap', taskId: id, time: new Date('2020-01-01T09:00:00'), ...o });

function withProfileFixture(fn, { alerts, matches, showAcked = false } = {}) {
  const prior = { doc: globalThis.document, plant: Store.selectedPlant, alerts: Store.alerts, master: Store.masterData,
    clock: Util.plantClock, vl: AlertsUIAdapter._drawerVL, vlPlant: AlertsUIAdapter._drawerVLPlant,
    current: AlertProfileMatches.current, settings: Store.userSettings, override: AlertsUIAdapter._profileOverride };
  const badge = { style: {}, textContent: '' }, bell = { style: {} }, footer = { hidden: true, textContent: '', innerHTML: '' };
  const body = { innerHTML: '' };
  const summaryList = { innerHTML: '', insertAdjacentHTML() {} }, summaryCount = { textContent: '' };
  const state = { rows: [] };
  try {
    globalThis.document = { ...prior.doc, getElementById: id => ({ 'alert-badge': badge, 'alert-bell': bell, 'alert-drawer-body': body,
      'alert-drawer-footer': footer, 'alert-summary-list': summaryList, 'alert-summary-count': summaryCount,
      'alert-drawer': { classList: { contains: c => c === 'open' } } })[id] || null };   // the drawer is open in these fixtures
    Store.setMasterData({ plants: [{ plant: 'T15-P' }], lines: [{ plant: 'T15-P', machine: 'T15-L' }] }, 'test');
    Store.setSelectedPlant('T15-P', 'test');
    Store.setUserSettings({ ...(prior.settings ?? {}), alertsShowAcknowledged: showAcked }, 'test');
    Util.plantClock = () => T15_NOW;
    Store.setAlerts(alerts, 'test');
    AlertsUIAdapter._profileOverride = false;
    AlertsUIAdapter._drawerVL = { update(next) { state.rows = next; }, destroy() {} };
    AlertProfileMatches.current = () => matches;
    fn({ badge, bell, footer, body, summaryList, summaryCount, state });
  } finally {
    globalThis.document = prior.doc; Util.plantClock = prior.clock; AlertProfileMatches.current = prior.current;
    AlertsUIAdapter._drawerVL = prior.vl; AlertsUIAdapter._drawerVLPlant = prior.vlPlant; AlertsUIAdapter._profileOverride = prior.override;
    Store.setUserSettings(prior.settings, 'test');
    Store.setMasterData(prior.master, 'test'); Store.setSelectedPlant(prior.plant, 'test'); Store.setAlerts(prior.alerts, 'test');
  }
}

const fakeSet = (profileId, ids, acked = new Map(), name = 'Overlaps') => ({
  plant: 'T15-P', profileId, profile: { id: profileId, name }, alertIds: new Set(ids), taskIds: new Set(), sevByTask: new Map(),
  categoryByTask: new Map(), acked, rev: 1,
});
const footerClick = action => ({ target: { closest: () => ({ dataset: { alertAction: action } }) } });

test('T15: a profile hides non-matching alerts from bell, drawer and Dashboard summary; footer counts them', () => {
  withProfileFixture(({ badge, footer, state, summaryCount }) => {
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1']);
    assert.equal(AlertsUIAdapter._visibleAlerts().profileHidden, 2);
    AlertsUIAdapter.renderBell();
    assert.equal(badge.textContent, '1', 'bell count follows the profile');
    AlertsUIAdapter.renderDrawer();
    assert.deepEqual(state.rows.map(a => a.id), ['a1']);
    assert.equal(footer.hidden, false);
    assert.match(footer.innerHTML, /data-alert-action="profile-show-all"/);
    assert.match(footer.innerHTML, new RegExp(Util.t('alert.profile_hidden', { n: 2, name: 'Overlaps' })));
    Dashboard._renderAlertSummary();
    assert.equal(summaryCount.textContent, Util.t('alert.summary_counts', { errors: 0, warnings: 1, count: 1 }), 'summary parity with the bell');
  }, { alerts: [t15('a1'), t15('a2'), t15('a3')], matches: fakeSet('p1', ['a1']) });
});

test('T15: the All alerts profile leaves the list unchanged and shows no profile footer', () => {
  withProfileFixture(({ footer }) => {
    const v = AlertsUIAdapter._visibleAlerts();
    assert.deepEqual(v.alerts.map(a => a.id), ['a1', 'a2']);
    assert.equal(v.profileHidden, 0);
    AlertsUIAdapter.renderDrawer();
    assert.equal(footer.hidden, true);
  }, { alerts: [t15('a1'), t15('a2')], matches: fakeSet('__all__', ['a1', 'a2'], new Map(), 'All') });
});

test('T15: the override restores every alert, shows the back link, and resets on plant:selected', () => {
  withProfileFixture(({ footer, state }) => {
    AlertsUIAdapter._handleFooterAction(footerClick('profile-show-all'));
    assert.equal(AlertsUIAdapter._profileOverride, true);
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1', 'a2']);
    assert.deepEqual(state.rows.map(a => a.id), ['a1', 'a2'], 'the click re-renders the drawer');
    assert.equal(footer.hidden, false);
    assert.match(footer.innerHTML, /data-alert-action="profile-back"/);
    assert.ok(!/profile-show-all/.test(footer.innerHTML));
    AlertsUIAdapter._handleFooterAction(footerClick('profile-back'));
    assert.equal(AlertsUIAdapter._profileOverride, false);
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1']);
    AlertsUIAdapter._profileOverride = true;
    Store.setSelectedPlant('T15-OTHER', 'test');
    assert.equal(AlertsUIAdapter._profileOverride, false, 'a plant change clears the session override');
    Store.setSelectedPlant('T15-P', 'test');
  }, { alerts: [t15('a1'), t15('a2')], matches: fakeSet('p1', ['a1']) });
});

test('T15: acknowledged alerts are hidden unless the pref is on; shown rows carry the ack badge; bell follows', () => {
  const acked = new Map([['a2', { alert_id: 'a2', acknowledged_by: 'pat', until: '2020-01-08T23:59:59' }],
    ['a3', { alert_id: 'a3', acknowledged_by: 'sam', until: null }]]);
  const alerts = [t15('a1'), t15('a2'), t15('a3')];
  withProfileFixture(({ badge }) => {
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1']);
    AlertsUIAdapter.renderBell();
    assert.equal(badge.textContent, '1');
  }, { alerts, matches: fakeSet('__all__', ['a1', 'a2', 'a3'], acked, 'All') });
  withProfileFixture(({ badge }) => {
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1', 'a2', 'a3']);
    AlertsUIAdapter.renderBell();
    assert.equal(badge.textContent, '3');
    assert.ok(AlertsUIAdapter._renderAlertRow(alerts[1]).includes(Util.t('am.ack_by', { who: 'pat', until: '2020-01-08' })));
    assert.ok(AlertsUIAdapter._renderAlertRow(alerts[2]).includes(Util.t('am.ack_by_noend', { who: 'sam' })));
    assert.ok(!AlertsUIAdapter._renderAlertRow(alerts[0]).includes('am-ack-badge'));
  }, { alerts, matches: fakeSet('__all__', ['a1', 'a2', 'a3'], acked, 'All'), showAcked: true });
});

test('T15: the Gantt conflict ids and Store.alertsByTask stay plant-wide (profile and acks do not filter them)', () => {
  const acked = new Map([['a2', { alert_id: 'a2', acknowledged_by: 'pat', until: null }]]);
  withProfileFixture(() => {
    assert.deepEqual(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id), ['a1']);
    assert.deepEqual([...Timeline._conflictIds()].sort(), ['a1', 'a2', 'a3']);
    assert.deepEqual([...Store.alertsByTask().keys()].sort(), ['a1', 'a2', 'a3']);
  }, { alerts: [t15('a1'), t15('a2'), t15('a3')], matches: fakeSet('p1', ['a1'], acked) });
});


test('_renderFollowers repaints the drawer only while it is open (bell and summary always)', () => {
  const prior = { doc: globalThis.document, bell: AlertsUIAdapter.renderBell, drawer: AlertsUIAdapter.renderDrawer, sum: Dashboard._renderAlertSummary };
  const log = [];
  let open = false;
  try {
    globalThis.document = { ...prior.doc, getElementById: id => (id === 'alert-drawer' ? { classList: { contains: c => c === 'open' && open } } : null) };
    AlertsUIAdapter.renderBell = () => log.push('bell');
    AlertsUIAdapter.renderDrawer = () => log.push('drawer');
    Dashboard._renderAlertSummary = () => log.push('summary');
    AlertsUIAdapter._renderFollowers();
    assert.deepEqual(log, ['bell', 'summary'], 'closed drawer is not rebuilt');
    open = true; log.length = 0;
    AlertsUIAdapter._renderFollowers();
    assert.deepEqual(log, ['bell', 'drawer', 'summary']);
  } finally {
    globalThis.document = prior.doc; AlertsUIAdapter.renderBell = prior.bell; AlertsUIAdapter.renderDrawer = prior.drawer; Dashboard._renderAlertSummary = prior.sum;
  }
});

// ---- Workload relief: Dashboard computes the full-plant matrix once and filters rows after --------------------------
test('Dashboard.render: toggling the line filter or an alert refresh never recomputes the 7-day matrix', () => {
  const prior = {
    doc: globalThis.document, nimbus: globalThis.NIMBUS, plant: Store.selectedPlant, tasks: structuredClone(Store.tasksArr),
    filter: Dashboard._filterLines, core: globalThis.NimbusComputeCore.computeUtilization,
    parts: ['_renderEmptyState', '_renderKPIs', '_renderHeatmap', '_renderLineStatus', '_renderAlertSummary', '_renderFirmedList',
      '_renderLatenessHeatmap', '_syncLineStatusHeight'].map(k => [k, Dashboard[k]]),
  };
  const seen = { heat: [], kpi: [] };
  let computes = 0;
  try {
    globalThis.document = { ...prior.doc, getElementById: id => (id === 'home-tab' ? { classList: { contains: () => true } } : null) };
    globalThis.NIMBUS = { AlertsUIAdapter: { renderBell() {} } };
    for (const [k] of prior.parts) Dashboard[k] = () => {};
    Dashboard._renderHeatmap = m => { seen.heat.push(Dashboard._visibleLines(m)); };
    Dashboard._renderKPIs = (m, tasks) => { seen.kpi.push([m, tasks.length]); };
    globalThis.NimbusComputeCore.computeUtilization = (...a) => { computes++; return prior.core(...a); };
    Store.setMasterData({ plants: [{ plant: 'DF-P' }], lines: [{ plant: 'DF-P', machine: 'DF-L1' }, { plant: 'DF-P', machine: 'DF-L2' }] }, 'unit-test');
    const d = (h) => new Date(2026, 9, 19, h);
    Store.setTasks([
      { id: 'df1', PLANT: 'DF-P', MACHINE: 'DF-L1', RUN_TIME: 2, start_date: d(8), end_date: d(10) },
      { id: 'df2', PLANT: 'DF-P', MACHINE: 'DF-L2', RUN_TIME: 2, start_date: d(8), end_date: d(10) },
    ], 'unit-test');
    Store.setSelectedPlant('DF-P', 'unit-test');
    Dashboard._filterLines = new Set();
    Dashboard.render();
    assert.equal(computes, 1);
    assert.deepEqual(seen.heat.at(-1).sort(), ['DF-L1', 'DF-L2']);
    Dashboard._filterLines = new Set(['DF-L1']);   // a filter toggle
    Dashboard.render();
    Store.emit({ type: 'alerts:change' });
    Dashboard.render();
    Store.emit({ type: 'lines:selected', lines: [] });
    Dashboard.render();
    assert.equal(computes, 1, 'the full-plant matrix is computed once; filter toggles and alert refreshes reuse it');
    assert.deepEqual(seen.heat.at(-1), ['DF-L1'], 'rows are narrowed to the filter after the fact');
    assert.equal(seen.kpi.at(-1)[1], 1, 'order counts still follow the filter');
    assert.equal(seen.kpi.at(-1)[0], seen.kpi[0][0], 'the very same cached matrix object');
  } finally {
    for (const [k, fn] of prior.parts) Dashboard[k] = fn;
    globalThis.NimbusComputeCore.computeUtilization = prior.core;
    Dashboard._filterLines = prior.filter;
    globalThis.document = prior.doc; globalThis.NIMBUS = prior.nimbus;
    Store.setTasks(prior.tasks, 'unit-test'); Store.setSelectedPlant(prior.plant, 'unit-test');
  }
});

test('Dashboard firmed list: Unfirm only for a planner-only firm, a reason on every row, the FINISH shown', t => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const priorOffset = Store.serverOffsetMs, priorEnd = Store.frozenHorizonEnd;
  const priorTasks = Store.tasksArr.map(x => ({ ...x })), priorFirmed = new Set(Store.firmedIds);
  const priorDoc = globalThis.document, priorFiltered = Dashboard._filteredTasks;
  const list = { innerHTML: '', querySelectorAll: () => [] };
  t.after(() => {
    Store.serverOffsetMs = priorOffset; Store.setFrozenHorizonEnd(priorEnd, 'test'); Store._blockedPlants.clear();
    Store.setTasks(priorTasks, 'test'); Store.firmedIds.clear(); for (const id of priorFirmed) Store.firmedIds.add(id);
    globalThis.document = priorDoc; Dashboard._filteredTasks = priorFiltered;
  });
  Store.setMasterData({ plants: [{ plant: 'DB', timezone: tz }], lines: [] }, 'test');
  Store._blockedPlants.clear();
  Store.serverOffsetMs = new Date('2026-10-27T08:00:00').getTime() - Date.now();
  Store.setFrozenHorizonEnd(new Date('2026-10-30T08:00:00'), 'test');
  const mk = (id, s, e) => ({ id, ORDER: id, PLANT: 'DB', MACHINE: 'DB-L1', RUN_TIME: 1, user_scheduled: true, start_date: new Date(s), end_date: new Date(e) });
  Store.setTasks([mk('planner', '2026-11-05T08:00:00', '2026-11-05T09:00:00'), mk('frozen', '2026-10-28T08:00:00', '2026-10-28T09:00:00')], 'test');
  Store.firmedIds.clear(); Store.setFirmed(['planner'], true, 'test');
  Dashboard._filteredTasks = () => Store.tasksArr;
  globalThis.document = { getElementById: id => (id === 'firmed-list' ? list : null) };
  Dashboard._renderFirmedList();
  const rows = list.innerHTML.split('class="firmed-row"').slice(1);
  assert.equal(rows.length, 2);
  const planner = rows.find(r => r.includes('planner')), frozen = rows.find(r => r.includes('frozen'));
  assert.match(planner, /data-order-id="planner"/, 'planner-only firm keeps Unfirm');
  assert.doesNotMatch(frozen, /data-order-id/, 'a frozen order has no Unfirm');
  assert.match(frozen, /class="reason">[^<]+</, 'and shows its reason');
  assert.ok(frozen.includes(Util.fmtDTShort(new Date('2026-10-28T09:00:00'))), 'the finish, not the start, is shown');
});

// ---- i18n sweep (Dashboard): wording comes from the locale files, never hardcoded English ----
import { readFileSync as _readLocale } from 'node:fs';
import _vm from 'node:vm';

function withRealLocales(lang, fn) {
  const win = {};
  for (const l of ['en', lang]) {
    _vm.runInNewContext(_readLocale(new URL(`../../../frontend/locales/${l}.js`, import.meta.url), 'utf8'), { window: win });
  }
  const prior = globalThis.window.__NIMBUS_LOCALES;
  const priorLocale = Util.locale();
  globalThis.window.__NIMBUS_LOCALES = win.__NIMBUS_LOCALES;
  Util.setLocale(lang);
  try { return fn(); } finally { globalThis.window.__NIMBUS_LOCALES = prior; Util.setLocale(priorLocale); }
}

test('Dashboard._fmtNextCO and _tileTooltip follow the viewer language', () => {
  const now = new Date('2026-10-27T08:00:00');
  const at = ms => new Date(now.getTime() + ms);
  withRealLocales('de', () => {
    assert.equal(Dashboard._fmtNextCO(at(-1000), now), 'jetzt');
    assert.equal(Dashboard._fmtNextCO(at(5 * 60000), now), '+5 Min');
    assert.equal(Dashboard._fmtNextCO(at(3 * 3600000), now), '+3h');
    assert.equal(Dashboard._fmtNextCO(at(48 * 3600000), now), '+2 T');
    assert.equal(Dashboard._tileTooltip('orders-today'), 'Offene Aufträge gefiltert auf heute');
    assert.match(Dashboard._tileTooltip('alerts-today'), /Konflikten/);
  });
  withRealLocales('en', () => {
    assert.equal(Dashboard._fmtNextCO(at(5 * 60000), now), '+5m');
    assert.equal(Dashboard._fmtNextCO(null, now), '—');
  });
});

test('Dashboard._tp picks the singular key for 1 and shows the Unknown machine key in the viewer language', () => {
  withRealLocales('fr', () => {
    assert.equal(Dashboard._tp('ui.verdict_warnings', 1), '1 avertissement');
    assert.equal(Dashboard._tp('ui.verdict_warnings', 3), '3 avertissements');
    assert.equal(Dashboard._lineLabel('Unknown'), 'Inconnue');
    assert.equal(Dashboard._lineLabel('L1'), 'L1');
  });
});

test('Dashboard weekday and date labels use Util.locale()', () => {
  const dt = new Date('2026-10-27T12:00:00');
  withRealLocales('de', () => {
    assert.equal(Dashboard._dowShort(dt), new Intl.DateTimeFormat('de', { weekday: 'short' }).format(dt));
    assert.equal(Dashboard._dateNumeric(dt), new Intl.DateTimeFormat('de', { month: 'numeric', day: 'numeric' }).format(dt));
  });
test('tool-conflict alerts (also zero-copy ones) offer "Open tool inventory" in the drawer and the cell briefing; other alerts do not', async () => {
  const base = { id: 'toolc-p|T1', type: 'tool-conflict', sev: 'err', msgKey: 'alert.tool_conflict', msgVars: { tool: 'T1' }, taskId: 'p', line: 'L1', time: new Date(2026, 9, 21, 9) };
  for (const available of [2, 0, undefined]) {
    const row = AlertsUIAdapter._renderAlertRow({ ...base, tool: 'T1', available });
    assert.match(row, /data-alert-action="tool-inventory" data-alert-id="toolc-p\|T1"/, `drawer, available=${available}`);
    assert.match(row, /ui\.alert_open_tool_inventory/);
  }
  assert.doesNotMatch(AlertsUIAdapter._renderAlertRow({ ...base, msgVars: {}, tool: undefined }), /tool-inventory/, 'no tool id, no link');
  assert.doesNotMatch(AlertsUIAdapter._renderAlertRow({ id: 'o', type: 'overlap', sev: 'err', msg: 'x', taskId: 'p', line: 'L1', time: new Date() }), /tool-inventory/);

  // The cell briefing card carries the same action and dispatches it.
  const prior = { doc: globalThis.document, alerts: Store.alerts, nimbus: globalThis.NIMBUS, open: AlertsUIAdapter.openToolInventory };
  let html = '';
  let onClick = null;
  let closed = 0;
  const dlg = {
    className: '', open: false,
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    showModal() {}, close() { closed++; }, addEventListener(evt, fn) { if (evt === 'click') onClick = fn; }, querySelectorAll() { return []; },
  };
  try {
    globalThis.document = { ...prior.doc, createElement: () => dlg, body: { appendChild() {} } };
    Store._state.alerts = [{ ...base, tool: 'T1', available: 0 }];
    AlertsUIAdapter.showForCell('L1', Util.dayKey(base.time));
    assert.match(html, /data-act="tool-inventory" data-id="toolc-p\|T1"/);
    let opened = null;
    AlertsUIAdapter.openToolInventory = id => { opened = id; };
    onClick({ target: { closest: () => ({ dataset: { act: 'tool-inventory', id: 'toolc-p|T1' } }) } });
    assert.equal(opened, 'toolc-p|T1');
    assert.equal(closed, 1, 'the briefing closes first');
  } finally {
    globalThis.document = prior.doc; Store._state.alerts = prior.alerts; AlertsUIAdapter.openToolInventory = prior.open;
  }
});

test('openToolInventory navigates Master Data > Tool Inventory then filters the grid to the alert tool on the alert plant', async () => {
  const { ToolInventory } = await import('../../../frontend/master-data/tool-inventory.mjs');
  const prior = { alerts: Store.alerts, nimbus: globalThis.NIMBUS, open: ToolInventory.openForTool, plant: Store.selectedPlant };
  const calls = [];
  try {
    Store._state.selectedPlant = 'P9';
    globalThis.NIMBUS = { App: { goto: t => calls.push(`goto:${t}`), gotoMasterSub: s => calls.push(`sub:${s}`) } };
    ToolInventory.openForTool = (plant, tool) => calls.push(`open:${plant}:${tool}`);
    Store._state.alerts = [
      { id: 'tc1', type: 'tool-conflict', sev: 'err', msg: 'm', tool: 'T100', available: 0, plant: 'P2', line: 'L1', time: new Date() },
      { id: 'tc2', type: 'tool-conflict', sev: 'err', msg: 'm', msgVars: { tool: 'T7' }, line: 'L1', time: new Date() },
      { id: 'ov', type: 'overlap', sev: 'err', msg: 'm', line: 'L1', time: new Date() },
    ];
    AlertsUIAdapter.openToolInventory('tc1');
    await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, ['goto:masterdata', 'sub:tool-inventory', 'open:P2:T100'], 'zero-copy alert, alert plant wins');
    calls.length = 0;
    AlertsUIAdapter.openToolInventory('tc2');
    await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, ['goto:masterdata', 'sub:tool-inventory', 'open:P9:T7'], 'msgVars.tool and the selected plant are the fallbacks');
    calls.length = 0;
    AlertsUIAdapter.openToolInventory('ov');
    AlertsUIAdapter.openToolInventory('missing');
    await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, [], 'not a tool alert: nothing happens');
    // The drawer's delegated handler routes the action.
    AlertsUIAdapter._handleAction({ target: { closest: () => ({ dataset: { alertAction: 'tool-inventory', alertId: 'tc1' } }) }, stopPropagation() {} });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, ['goto:masterdata', 'sub:tool-inventory', 'open:P2:T100']);
  } finally {
    ToolInventory.openForTool = prior.open; Store._state.alerts = prior.alerts; Store._state.selectedPlant = prior.plant;
    if (prior.nimbus === undefined) delete globalThis.NIMBUS; else globalThis.NIMBUS = prior.nimbus;
  }
});
