// Tests for frontend/alert-monitor/alert-monitor-pane.mts with a stubbed document: empty states, the
// _active gate on subscribers, "View as" vs "Make default", the toggles and the no-timezone banner.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AlertMonitorPane } from '../../../frontend/alert-monitor/alert-monitor-pane.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { ALL_ALERTS_PROFILE, ALL_ALERTS_PROFILE_ID } from '../../../frontend/insights/alert-profiles.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeEl(id) {
  const handlers = {};
  return {
    id, _html: '', writes: 0, handlers, textContent: '', hidden: false, value: '', checked: false, title: '', disabled: false, dataset: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.writes++; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, addEventListener(type, fn) { handlers[type] = fn; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    scrollIntoView() {}, blur() {}, focus() {}, closest() { return null; },
    // VirtualList mounts an inner div into the scroll element (group-by none).
    appendChild() {}, remove() {}, removeEventListener() {}, style: {}, clientHeight: 600, scrollTop: 0,
  };
}

const prior = {};
let els;
const calls = { session: [], prefs: [] };

const profile = (id, name) => ({ id, plant: 'P1', name, description: '', ranking: 'impact', created_by: null, updated_at: null,
  rules: [{ types: ['overlap'], dayFrom: 0, dayTo: 7, minSev: null, minLateHours: null }] });
const P1 = profile('p1', 'Overlaps'), P2 = profile('p2', 'Late orders');
const alert = (id, o = {}) => ({ id, sev: 'err', type: 'overlap', msg: '', line: '', time: new Date('2026-10-21T08:00:00'), taskId: id, ...o });

function fakeMatches(o = {}) {
  const profileId = o.profileId ?? ALL_ALERTS_PROFILE_ID;
  return {
    plant: 'P1', profileId, profile: o.profile ?? ALL_ALERTS_PROFILE,
    alertIds: o.alertIds ?? new Set(), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(),
    acked: o.acked ?? new Map(), rev: 1,
  };
}

function useProfiles(list, matches) {
  AlertProfileClient.cached = () => list;
  AlertProfileMatches.current = () => matches;
}

beforeEach(() => {
  els = {};
  prior.doc = globalThis.document;
  prior.current = AlertProfileMatches.current;
  prior.setSession = AlertProfileMatches.setSessionProfile;
  prior.cached = AlertProfileClient.cached;
  prior.setPref = Session.setPref;
  prior.clock = Util.plantClock;
  prior.nimbus = globalThis.NIMBUS;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    activeElement: null,
  };
  calls.session = []; calls.prefs = [];
  AlertProfileMatches.setSessionProfile = id => { calls.session.push(id); };
  Session.setPref = (k, v) => { calls.prefs.push([k, v]); };
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1', P9: 'z' }, alertsShowAcknowledged: false }, 'test');
  Store.setSelectedPlant('P1', 'test');
  Store.setAlerts([], 'test');
  Store.setTasks([], 'test');
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  globalThis.document = prior.doc;
  AlertProfileMatches.current = prior.current;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  AlertProfileClient.cached = prior.cached;
  Session.setPref = prior.setPref;
  Util.plantClock = prior.clock;
  globalThis.NIMBUS = prior.nimbus;
});

test('no plant renders the select-a-plant empty state and dashes in the KPI strip', () => {
  Store.setSelectedPlant(null, 'test');
  AlertProfileMatches.current = () => ({ ...fakeMatches(), plant: null });
  AlertProfileClient.cached = () => null;
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /am\.empty_no_plant/);
  assert.match(els['am-kpis'].innerHTML, /—/);
  assert.equal(els['am-profile-input'].disabled, true);
});

test('setActive(false) suppresses the render that alerts:change would trigger', async () => {
  useProfiles([P1, P2], fakeMatches({ alertIds: new Set(['a1']) }));
  globalThis.NIMBUS = { Confidence: { _score: 10 } };
  Store.setAlerts([alert('a1')], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-kpis'].innerHTML, /<div class="v">10<\/div>/);

  AlertMonitorPane.setActive(false);
  globalThis.NIMBUS.Confidence._score = 77;
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(260);
  assert.match(els['am-kpis'].innerHTML, /<div class="v">10<\/div>/, 'inactive pane must not repaint');

  AlertMonitorPane.setActive(true);
  Store.setAlerts([alert('a1')], 'test');
  await sleep(260);
  assert.match(els['am-kpis'].innerHTML, /<div class="v">77<\/div>/);
});

test('picking a non-default profile in the combobox sets the session override and never the pref', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  const pick = id => els['am-profile-dropdown'].handlers.mousedown({ preventDefault() {}, target: { closest: () => ({ dataset: { profile: id } }) } });
  pick('p2');
  assert.deepEqual(calls.session, ['p2']);
  assert.deepEqual(calls.prefs, []);
  pick('p1');   // the user's own default: clears the override instead
  assert.deepEqual(calls.session, ['p2', null]);
  assert.deepEqual(calls.prefs, []);
});

test('Make default writes alertProfileByPlant read-modify-write; the badge shows when already default', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p2', profile: P2 }));
  AlertMonitorPane.render();
  assert.equal(els['am-make-default'].hidden, false);
  assert.equal(els['am-is-default'].hidden, true);
  els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === '[data-am-group]' ? null : { dataset: { amAction: 'make-default' } }) } });
  assert.deepEqual(calls.prefs, [['alertProfileByPlant', { P1: 'p2', P9: 'z' }]]);
  assert.deepEqual(calls.session, [null]);

  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertProfileMatches.current = () => fakeMatches({ profileId: 'p1', profile: P1 });
  AlertMonitorPane.render();
  assert.equal(els['am-make-default'].hidden, true);
  assert.equal(els['am-is-default'].hidden, false);
});

test('the Show acknowledged toggle writes alertsShowAcknowledged; the highlight toggle writes its own pref', () => {
  useProfiles([P1], fakeMatches());
  AlertMonitorPane.render();
  const change = el => els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-am-toggle]' ? el : null) } });
  change({ dataset: { amToggle: 'ack' }, checked: true });
  change({ dataset: { amToggle: 'highlight' }, checked: false });
  assert.deepEqual(calls.prefs, [['alertsShowAcknowledged', true], ['alertProfileGanttHighlight', false]]);
});

test('group-by and sort persist per profile id under alertMonitorView', () => {
  useProfiles([P1], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === '[data-am-group]' ? { dataset: { amGroup: 'line' } } : null) } });
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorView', { p1: { groupBy: 'line', sort: 'impact' } }]);
  els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-am-sort]' ? { value: 'time' } : null) } });
  assert.equal(calls.prefs.at(-1)[1].p1.sort, 'time');
});

test('a plant_no_timezone alert pins the banner', () => {
  useProfiles([P1], fakeMatches());
  Store.setAlerts([alert('tz', { type: 'plant_no_timezone', taskId: undefined })], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-banner'].innerHTML, /role="alert"/);
  assert.match(els['am-banner'].innerHTML, /am\.banner_no_timezone/);
  Store.setAlerts([alert('a1')], 'test');
  AlertMonitorPane.render();
  assert.equal(els['am-banner'].innerHTML, '');
});

test('a profile that matches nothing shows the no-match state with a Show all alerts button', () => {
  useProfiles([P1], fakeMatches({ profileId: 'p1', profile: P1, alertIds: new Set() }));
  Store.setAlerts([alert('a1', { type: 'overload' })], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /am\.empty_no_match_title/);
  els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === '[data-am-group]' ? null : { dataset: { amAction: 'switch-all' } }) } });
  assert.deepEqual(calls.session, [ALL_ALERTS_PROFILE_ID]);
});

test('no alerts at all shows the all-clear state; no profiles adds the create-profile prompt', () => {
  useProfiles([], fakeMatches());
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /empty\.no_active_alerts/);
  assert.match(els['am-prompt'].innerHTML, /am\.create_profile_prompt/);
  useProfiles([P1], fakeMatches());
  AlertMonitorPane.render();
  assert.equal(els['am-prompt'].innerHTML, '');
});

/* ---------------------------------------------------------------------------
   Task 12 — grouped alert list, row actions, focus chip, diagnose, open in table
   ------------------------------------------------------------------------- */
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { Modal, Toast } from '../../../frontend/platform/foundation.mjs';

const task = (id, o = {}) => ({
  id, ORDER: `47${id}`, PLANT: 'P1', MACHINE: 'L1', MATERIAL_NUMBER: `M${id}`,
  original_end_date: new Date('2026-10-21T08:00:00'), end_date: new Date('2026-10-22T08:00:00'), ...o,
});

function seed(alerts, { matched, acked, view, showAcked } = {}) {
  Store.setAlerts(alerts, 'test');
  Store.setUserSettings({
    alertProfileByPlant: { P1: 'p1' }, alertsShowAcknowledged: !!showAcked,
    alertMonitorView: view ? { __all__: view } : {},
  }, 'test');
  useProfiles([P1], fakeMatches({ alertIds: new Set(matched ?? alerts.map(a => a.id)), acked }));
}

const clickAlert = (action, id, extra = {}) => els['alerts-tab'].handlers.click({
  target: { closest: sel => (sel === '[data-alert-action]' ? { dataset: { alertAction: action, alertId: id, ...extra } } : null) },
});
const clickAm = (action, extra = {}) => els['alerts-tab'].handlers.click({
  target: { closest: sel => (sel === '[data-am-action]' ? { dataset: { amAction: action, ...extra } } : null) },
});

function patched(obj, key, fn) {
  const prev = obj[key];
  obj[key] = fn;
  return () => { obj[key] = prev; };
}

test('alerts render as category cards, and the stale empty state is cleared (and restored)', () => {
  seed([alert('a1', { type: 'overload' }), alert('a2', { type: 'overlap', peerId: 'z' })], { matched: ['a1', 'a2'] });
  Store.setAlerts([], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /empty-state/);

  seed([alert('a1', { type: 'overload' }), alert('a2', { type: 'overlap', peerId: 'z' })]);
  AlertMonitorPane.render();
  const html = els['am-groups'].innerHTML;
  assert.doesNotMatch(html, /empty-state/);
  assert.match(html, /class="am-group panel" data-group-key="capacity"/);
  assert.match(html, /data-group-key="conflicts"/);
  assert.match(html, /ape\.cat_capacity/);

  Store.setAlerts([], 'test');
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-groups'].innerHTML, /am-group/);
  assert.match(els['am-groups'].innerHTML, /empty-state/);
});

test('every matched alert acknowledged shows the turn-on-Show-acknowledged hint; the toggle reveals the rows with a badge', () => {
  const acked = new Map([['a1', { plant: 'P1', alert_id: 'a1', acknowledged_by: 'Ana', reason: 'ok', until: '2026-11-01T00:00:00Z', created_at: null }]]);
  seed([alert('a1')], { acked });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /am\.empty_all_acked/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="a1"/);

  seed([alert('a1')], { acked, showAcked: true });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /data-alert-id="a1"/);
  assert.match(els['am-groups'].innerHTML, /am-ack-badge[^>]*>am\.ack_by</);
});

test('group head sums: points, orders (taskId ∪ peerId) and late hours; rows carry the impact columns', () => {
  Store.setTasks([task('1'), task('2'), task('3', { end_date: new Date('2026-10-21T07:00:00') })], 'test');
  seed([
    alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }),
    alert('a2', { type: 'tool-conflict', taskId: '2', peerId: '3' }),
  ]);
  AlertMonitorPane.render();
  const html = els['am-groups'].innerHTML;
  assert.match(html, /am-tot-v">15<\/span><span class="am-tot-k">am\.col_points/);
  assert.match(html, /am-tot-v">3<\/span><span class="am-tot-k">am\.col_orders/);
  // Order 1 and 2 finish a day after their 08:00 due; order 3 is on time: 24 + 24 late hours.
  assert.match(html, /am-tot-v">48<\/span><span class="am-tot-k">am\.col_late/);
  assert.match(html, /<span class="am-num">7\.5<\/span><span class="am-num">2<\/span><span class="am-num">24<\/span>/);
});

test('an alert outside the confidence window renders "outside" instead of points', () => {
  seed([alert('a1', { time: new Date('2027-03-01T08:00:00') })]);
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /am-num-out[^>]*>am\.points_outside</);
});

test('rows beyond the cap sit behind "Show all N"; clicking it renders the rest', () => {
  const many = Array.from({ length: 45 }, (_, i) => alert(`m${String(i).padStart(2, '0')}`, { type: 'overload', taskId: undefined, line: '' }));
  seed(many);
  AlertMonitorPane.render();
  const count = () => (els['am-groups'].innerHTML.match(/class="am-rowwrap"/g) ?? []).length;
  assert.equal(count(), 40);
  assert.match(els['am-groups'].innerHTML, /data-am-action="show-all"[^>]*>am\.show_all_n</);
  clickAm('show-all', { groupKey: 'capacity' });
  assert.equal(count(), 45);
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-am-action="show-all"/);
});

test('group-by none mounts a single VirtualList instead of per-group row markup', () => {
  const created = [];
  globalThis.document.createElement = () => { const e = makeEl('inner'); created.push(e); return e; };
  seed([alert('a1'), alert('a2', { type: 'overload' }), alert('a3', { type: 'late' })],
    { view: { groupBy: 'none', sort: 'impact' } });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /id="am-vl"/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-rowwrap"/);
  assert.equal(created.length, 1);
  assert.equal((created[0].innerHTML.match(/class="am-rowwrap"/g) ?? []).length, 3);
  AlertMonitorPane.render();   // a repaint reuses the same list
  assert.equal(created.length, 1);
});

test('the group toggle collapses a card; collapse state resets when the plant changes', () => {
  seed([alert('a1', { type: 'overload' })]);
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /aria-expanded="true"[^>]*data-am-action="toggle-group"/);
  clickAm('toggle-group', { groupKey: 'capacity' });
  assert.match(els['am-groups'].innerHTML, /aria-expanded="false"/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-rowwrap"/);
  Store.setSelectedPlant('P2', 'test');
  AlertMonitorPane.render();
  Store.setSelectedPlant('P1', 'test');
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /aria-expanded="true"/);
});

test('the focus chip bypasses the profile and says how many focused alerts are outside it', () => {
  seed([alert('a1', { type: 'overload' }), alert('a2', { type: 'overlap' })], { matched: ['a1'] });
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="a2"/);
  assert.equal(els['am-focus-chip'].hidden, true);

  AlertMonitorPane.setFocus(['a1', 'a2'], 'Setup pair');
  assert.match(els['am-groups'].innerHTML, /data-alert-id="a2"/, 'a2 is outside the profile but focused');
  assert.equal(els['am-focus-chip'].hidden, false);
  assert.match(els['am-focus-chip'].innerHTML, /am\.focus_chip_outside/);

  AlertMonitorPane.setFocus(['a1'], 'Setup pair');
  assert.match(els['am-focus-chip'].innerHTML, /am\.focus_chip(?!_)/);
  assert.doesNotMatch(els['am-focus-chip'].innerHTML, /outside/);

  clickAm('clear-focus');
  assert.equal(els['am-focus-chip'].hidden, true);
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="a2"/);
});

test('row actions mirror the drawer: focus, fix, override, dismiss', () => {
  const log = [];
  globalThis.NIMBUS = {
    AlertsUIAdapter: { focus: id => log.push(['focus', id]) },
    Table: { _openOverrideModalForId: id => log.push(['override', id]) },
  };
  const undo = [
    patched(Alerts, 'applyFix', id => log.push(['fix', id])),
    patched(Alerts, 'dismiss', id => log.push(['dismiss', id])),
  ];
  try {
    seed([alert('a1', { type: 'overlap' })]);
    AlertMonitorPane.render();
    clickAlert('focus', 'a1');
    clickAlert('fix', 'a1');
    clickAlert('override', 'a1', { taskId: 'T9' });
    clickAlert('dismiss', 'a1');
    assert.deepEqual(log, [['focus', 'a1'], ['fix', 'a1'], ['override', 'T9'], ['dismiss', 'a1']]);
  } finally { undo.forEach(u => u()); }
});

test('What-If disables Fix / Override in the markup and blocks them in the handler', () => {
  const log = [];
  globalThis.NIMBUS = { Table: { _openOverrideModalForId: id => log.push(['override', id]) } };
  const undo = patched(Alerts, 'applyFix', id => log.push(['fix', id]));
  Sandbox.active = true;
  try {
    seed([alert('a1', { type: 'overlap' })]);
    AlertMonitorPane.render();
    assert.match(els['am-groups'].innerHTML, /data-alert-action="fix"[^>]*disabled/);
    clickAlert('fix', 'a1');
    clickAlert('override', 'a1', { taskId: 'T9' });
    assert.deepEqual(log, []);
  } finally { Sandbox.active = false; undo(); }
});

test('Diagnose: a line/day alert opens the cell briefing, an order alert toggles the inline panel', () => {
  const cells = [];
  globalThis.NIMBUS = {
    AlertsUIAdapter: { showForCell: (line, day) => cells.push([line, day]) },
    Inspector: { _formatRuntimeBasis: () => 'Routing · PV 1' },
  };
  Store.setTasks([task('1', { RUN_TIME: 6.5, run_time_source: 'routing', firmed: true, planning_reason: { code: 'X', message: 'held for runtime', step: 'resolve' } })], 'test');
  seed([
    alert('c1', { type: 'overload', taskId: undefined, line: 'L1' }),
    alert('o1', { type: 'setup-violated', taskId: '1', pairKey: '[["colorWheel","RED"]]->[["colorWheel","BLUE"]]' }),
  ]);
  AlertMonitorPane.render();
  clickAlert('diagnose', 'c1');
  assert.deepEqual(cells, [['L1', '2026-10-21']]);

  assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-diag"/);
  clickAlert('diagnose', 'o1');
  const html = els['am-groups'].innerHTML;
  assert.match(html, /class="am-diag"/);
  assert.match(html, /<dt>ui\.insp_due_date<\/dt><dd[^>]*>2026-10-21 08:00</);
  assert.match(html, /<dt>ui\.insp_planned_finish<\/dt><dd[^>]*>2026-10-22 08:00</);
  assert.match(html, /<dt>ui\.late<\/dt><dd[^>]*>24 h</);
  assert.match(html, /<dt>ui\.insp_run_time<\/dt><dd[^>]*>6\.5 h · Routing · PV 1</);
  assert.match(html, /<dt>ui\.insp_firming<\/dt><dd[^>]*>ui\.firmed</);
  assert.match(html, /<dt>am\.diag_setup<\/dt><dd[^>]*>colorWheel RED → colorWheel BLUE</);
  assert.match(html, /<dt>am\.diag_reason<\/dt><dd[^>]*>X · held for runtime · resolve</);
  clickAlert('diagnose', 'o1');
  assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-diag"/);
});

test('group Dismiss asks for confirmation above five alerts and dismisses exactly that group', async () => {
  const dismissed = [];
  let confirms = 0;
  const undo = [
    patched(Alerts, 'dismissAll', ids => dismissed.push([...ids])),
    patched(Modal, 'confirm', async () => { confirms++; return true; }),
  ];
  try {
    const six = Array.from({ length: 6 }, (_, i) => alert(`s${i}`, { type: 'overload', taskId: undefined }));
    seed([...six, alert('o1', { type: 'overlap' })]);
    AlertMonitorPane.render();
    clickAm('group-dismiss', { groupKey: 'capacity' });
    await sleep(5);
    assert.equal(confirms, 1);
    assert.deepEqual(dismissed, [six.map(a => a.id)]);

    clickAm('group-dismiss', { groupKey: 'conflicts' });   // one alert: no confirm
    await sleep(5);
    assert.equal(confirms, 1);
    assert.deepEqual(dismissed.at(-1), ['o1']);
  } finally { undo.forEach(u => u()); }
});

test('Open in table fills the PO/Material filter, applies it and switches to the Orders sub-tab', () => {
  const log = [];
  globalThis.NIMBUS = {
    Table: { _onPoMatApply: () => log.push(['apply', els['tbl-flt-pomat-textarea'].value]) },
    App: { gotoGanttSub: sub => log.push(['sub', sub]) },
  };
  Store.setTasks([task('1'), task('2')], 'test');
  seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2' })]);
  AlertMonitorPane.render();
  clickAm('group-open-table', { groupKey: 'conflicts' });
  assert.deepEqual(log, [['apply', '471\n472'], ['sub', 'orders']]);
});

test('Open in table falls back to a toast when the table filter is unavailable', () => {
  const toasts = [];
  const undo = patched(Toast, 'show', (m, k) => toasts.push([m, k]));
  globalThis.NIMBUS = {};
  try {
    Store.setTasks([task('1')], 'test');
    seed([alert('a1', { type: 'late', taskId: '1' })]);
    AlertMonitorPane.render();
    clickAm('group-open-table', { groupKey: 'exceptions' });
    assert.deepEqual(toasts, [['am.table_unavailable', 'warn']]);
  } finally { undo(); }
});

/* ---------------------------------------------------------------------------
   Task 15 — Acknowledge / Remove acknowledgement row actions
   ------------------------------------------------------------------------- */
import { AlertAckModal } from '../../../frontend/alert-monitor/alert-ack-modal.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';

test('row Acknowledge opens the modal; an acknowledged row offers Remove acknowledgement', async () => {
  const log = [];
  const undo = [
    patched(AlertAckModal, 'open', o => log.push(['open', o.plant, o.alertId])),
    patched(AlertAcksClient, 'unacknowledge', async (plant, id) => { log.push(['unack', plant, id]); }),
  ];
  try {
    const acked = new Map([['a2', { alert_id: 'a2', acknowledged_by: 'pat', until: null }]]);
    seed([alert('a1'), alert('a2')], { acked, showAcked: true });
    AlertMonitorPane.render();
    const html = els['am-groups'].innerHTML;
    assert.match(html, /<button[^>]*data-alert-action="ack"[^>]*data-alert-id="a1"(?![^>]*disabled)/);
    assert.doesNotMatch(html, /data-alert-action="ack"[^>]*data-alert-id="a2"/);
    assert.match(html, /data-alert-action="unack"[^>]*data-alert-id="a2"/);
    clickAlert('ack', 'a1');
    clickAlert('unack', 'a2');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(log, [['open', 'P1', 'a1'], ['unack', 'P1', 'a2']]);
  } finally { undo.forEach(u => u()); }
});
