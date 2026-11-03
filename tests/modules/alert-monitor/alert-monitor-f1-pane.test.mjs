// F1 (2026-10-30), pane level: the open row's detail for an alert with and without an order, the Day details action,
// "Open in Orders" for the view, the Top fixes setting, and the catalog / backend allowlist parity.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlertMonitorPane } from '../../../frontend/alert-monitor/alert-monitor-pane.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { ALL_ALERTS_PROFILE, ALL_ALERTS_PROFILE_ID } from '../../../frontend/insights/alert-profiles.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { makeEl } from '../helpers/dom-stub.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const prior = {};
let els, prefs, log;
const D1 = '2026-10-21', D2 = '2026-10-22';
const alert = (id, o = {}) => ({ id, sev: 'err', type: 'overlap', msg: 'overlap text', line: 'M1', time: new Date(`${D1}T08:00:00`), taskId: `T-${id}`, ...o });
const ALERTS = () => [
  alert('a1'), alert('a2', { sev: 'warn', type: 'late', line: 'M2', time: new Date(`${D1}T09:00:00`) }),
  alert('a4', { type: 'overload', line: 'M4', time: new Date(`${D2}T12:00:00`), taskId: undefined, msg: 'M4 is overloaded' }),
];
const task = (id, o = {}) => ({
  id, ORDER: `10${id.slice(-1)}`, MACHINE: 'M1', PLANT: 'P1', MATERIAL_DESCRIPTION: `Material of ${id}`, RUN_TIME: 2,
  start_date: new Date(`${D1}T06:00:00`), end_date: new Date(`${D1}T08:00:00`), ...o,
});
const matches = alerts => ({
  plant: 'P1', profileId: ALL_ALERTS_PROFILE_ID, profile: ALL_ALERTS_PROFILE, alertIds: new Set(alerts.map(a => a.id)),
  taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(), acked: new Map(), rev: 1, focusIds: null,
});

function setup(alerts, tasks) {
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' }, alertMonitorView: null }, 'test');
  Store.setTasks(tasks, 'test');
  Store._linesByPlant = { P1: ['M1', 'M2', 'M4'] };
  Store._masterLinesByPlant = { P1: [{ machine: 'M1', wc_group: 'A' }, { machine: 'M2', wc_group: 'A' }, { machine: 'M4', wc_group: 'B' }] };
  Store.setAlerts(alerts, 'test');
  AlertProfileMatches.current = () => matches(alerts);
}

beforeEach(() => {
  els = {}; prefs = []; log = [];
  prior.doc = globalThis.document; prior.view = AlertProfileMatches.current; prior.cached = AlertProfileClient.cached;
  prior.setPref = Session.setPref; prior.clock = Util.plantClock; prior.nimbus = globalThis.NIMBUS;
  prior.focus = AlertProfileMatches.setFocusTaskIds;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  AlertProfileClient.cached = () => [];
  Session.setPref = (k, v) => { prefs.push([k, v]); Store.setUserSettings({ [k]: v }, 'settings-pref'); };   // like the real one: apply, then emit
  AlertProfileMatches.setFocusTaskIds = () => {};
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setSelectedPlant('P1', 'test');
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  globalThis.document = prior.doc;
  AlertProfileMatches.current = prior.view; AlertProfileMatches.setFocusTaskIds = prior.focus;
  AlertProfileClient.cached = prior.cached; Session.setPref = prior.setPref; Util.plantClock = prior.clock;
  globalThis.NIMBUS = prior.nimbus;
  Store.setTasks([], 'test');
  Store._linesByPlant = {}; Store._masterLinesByPlant = {};
});

const click = map => els['alerts-tab'].handlers.click({ target: { closest: sel => map[sel] ?? null } });
const clickRowh = row => click({ '.am-mx-rowh': { dataset: { amRow: row } } });
const clickAm = action => click({ '[data-am-action]': { dataset: { amAction: action } } });
const side = () => els['am-side'].innerHTML;
const open = id => {
  const r = { dataset: { alertId: id }, getAttribute: () => id, closest: s => (s === '.am-xrow' ? r : null) };
  els['alerts-tab'].handlers.keydown({ key: 'Enter', preventDefault() {}, target: r });
};
const detail = () => side().match(/<div class="am-xdetail"[\s\S]*$/)?.[0] ?? '';

test("a row with its order shows the order's real material, due, planned finish and firming", () => {
  setup(ALERTS(), [task('T-a1')]);
  AlertMonitorPane.render();
  clickRowh('M1');
  open('a1');
  const d = detail();
  assert.match(d, /am\.detail_material<\/b>Material of T-a1/);
  for (const k of ['due', 'finish', 'firming']) assert.match(d, new RegExp(`am\\.detail_${k}`));
  assert.doesNotMatch(d, /am\.detail_machine_day|data-alert-action="cell"/);
});

test('an overload alert with no order reads "Machine · day", counts the orders on that day and offers Day details; no due / finish / firming', () => {
  setup(ALERTS(), [task('T-a1'), task('T-x', { MACHINE: 'M4', start_date: new Date(`${D2}T06:00:00`), end_date: new Date(`${D2}T10:00:00`) })]);
  AlertMonitorPane.render();
  clickRowh('M4');
  open('a4');
  const d = detail();
  assert.match(d, /am\.detail_machine_day<\/b>M4 · /);
  assert.match(d, /am\.detail_orders_on_day<\/b>1</);
  assert.match(d, /data-alert-action="cell"[^>]*data-alert-id="a4"/);
  for (const k of ['material', 'due', 'finish', 'firming']) assert.doesNotMatch(d, new RegExp(`am\\.detail_${k}`));
  assert.doesNotMatch(d, /—/);
});

test('Day details opens the existing cell briefing for that machine and day', () => {
  setup(ALERTS(), []);
  globalThis.NIMBUS = { AlertsUIAdapter: { showForCell: (line, day) => log.push(['cell', line, day]) } };
  AlertMonitorPane.render();
  click({ '[data-alert-action]': { dataset: { alertAction: 'cell', alertId: 'a4' } } });
  assert.deepEqual(log, [['cell', 'M4', D2]]);
});

test('several orders in view: Open in Orders appears, selects every order number and switches to the Orders sub-tab; one order: no such button', () => {
  setup(ALERTS(), [task('T-a1', { ORDER: '1001' }), task('T-a2', { ORDER: '1002', MACHINE: 'M2' })]);
  els['tbl-flt-pomat-textarea'] = makeEl('ta');
  globalThis.NIMBUS = {
    Table: { _onPoMatApply: () => log.push(['apply', els['tbl-flt-pomat-textarea'].value]) },
    App: { goto: t => log.push(['goto', t]), gotoGanttSub: t => log.push(['sub', t]) },
  };
  AlertMonitorPane.render();
  clickRowh('wc:A');
  assert.match(side(), /data-am-action="open-orders"[^>]*>am\.open_in_orders</);
  clickAm('open-orders');
  assert.deepEqual(log, [['apply', '1001\n1002'], ['goto', 'gantt'], ['sub', 'orders']]);
  clickRowh('wc:A');   // toggle off
  clickRowh('M2');
  assert.doesNotMatch(side(), /open-orders/, 'one placed order: Show on Gantt only');
  assert.match(side(), /data-am-action="show-gantt"/);
});

test('Open in Orders uses Table.filterToOrders when the table has it: no private textarea, then the Orders sub-tab', () => {
  setup(ALERTS(), [task('T-a1', { ORDER: '1001' }), task('T-a2', { ORDER: '1002', MACHINE: 'M2' })]);
  els['tbl-flt-pomat-textarea'] = makeEl('ta');
  globalThis.NIMBUS = {
    Table: {
      filterToOrders: orders => { log.push(['filter', orders]); return true; },
      _onPoMatApply: () => log.push(['apply']),
    },
    App: { goto: t => log.push(['goto', t]), gotoGanttSub: t => log.push(['sub', t]) },
  };
  AlertMonitorPane.render();
  clickRowh('wc:A');
  clickAm('open-orders');
  assert.deepEqual(log, [['filter', ['1001', '1002']], ['goto', 'gantt'], ['sub', 'orders']]);
  assert.equal(els['tbl-flt-pomat-textarea'].value, '', 'the old private-DOM path is not used');
});

test('Open in Orders: filterToOrders returning false toasts am.table_unavailable and stays on the page', () => {
  setup(ALERTS(), [task('T-a1', { ORDER: '1001' }), task('T-a2', { ORDER: '1002', MACHINE: 'M2' })]);
  const toasts = [];
  const priorToast = Toast.show;
  Toast.show = (msg, type) => { toasts.push([msg, type]); };
  globalThis.NIMBUS = {
    Table: { filterToOrders: orders => { log.push(['filter', orders]); return false; } },
    App: { goto: t => log.push(['goto', t]), gotoGanttSub: t => log.push(['sub', t]) },
  };
  try {
    AlertMonitorPane.render();
    clickRowh('wc:A');
    clickAm('open-orders');
  } finally { Toast.show = priorToast; }
  assert.deepEqual(log, [['filter', ['1001', '1002']]]);
  assert.deepEqual(toasts, [['am.table_unavailable', 'warn']]);
});

test('the Top fixes toggle writes alertMonitorFixes and flips it back', () => {
  setup(ALERTS(), []);
  AlertMonitorPane.render();
  clickAm('fixes-toggle');
  assert.deepEqual(prefs.at(-1), ['alertMonitorFixes', 'collapsed']);
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' }, alertMonitorView: null, alertMonitorFixes: 'collapsed' }, 'test');
  clickAm('fixes-toggle');
  assert.deepEqual(prefs.at(-1), ['alertMonitorFixes', 'open']);
});

test('alertMonitorFixes is in Settings.CATALOG (open by default) and in the backend allowlist', () => {
  const shell = readFileSync(join(ROOT, 'frontend', 'shell', 'application-shell.mts'), 'utf8');
  assert.match(shell, /key: 'alertMonitorFixes',\s+category: 'workflow', type: 'enum',\s+default: 'open', tier: 'user'/);
  assert.match(readFileSync(join(ROOT, 'backend', 'security', 'auth.py'), 'utf8'), /"alertMonitorFixes"/);
});

test('alertMonitorSideWidth is in Settings.CATALOG (number, default null) and in the backend allowlist', () => {
  const shell = readFileSync(join(ROOT, 'frontend', 'shell', 'application-shell.mts'), 'utf8');
  assert.match(shell, /key: 'alertMonitorSideWidth',\s+category: 'workflow', type: 'number',\s+default: null,\s+tier: 'user'/);
  assert.match(readFileSync(join(ROOT, 'backend', 'security', 'auth.py'), 'utf8'), /"alertMonitorSideWidth"/);
});
