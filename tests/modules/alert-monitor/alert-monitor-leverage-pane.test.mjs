// The "Top fixes" panel inside AlertMonitorPane: two-phase paint, gating (inactive / What-If /
// optimizer preview), stale-revision drop, "Show alerts" focus, top-5 + show-more, the minutes entry,
// the admin disclosure, the ⋯ menu, and visibility under the no-match empty state.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AlertMonitorPane } from '../../../frontend/alert-monitor/alert-monitor-pane.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { ALL_ALERTS_PROFILE, ALL_ALERTS_PROFILE_ID } from '../../../frontend/insights/alert-profiles.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Sandbox } from '../../../frontend/optimization/sandbox.mjs';
import { OverflowMenu } from '../../../frontend/platform/overflow-menu.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeEl(id) {
  const handlers = {};
  return {
    id, _html: '', handlers, textContent: '', hidden: false, value: '', checked: false, title: '', disabled: false, dataset: {},
    scrolled: 0,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, addEventListener(type, fn) { handlers[type] = fn; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    scrollIntoView() { this.scrolled++; }, blur() {}, focus() {}, closest() { return null; },
    appendChild() {}, remove() {}, removeEventListener() {}, style: { setProperty() {}, getPropertyValue() { return ''; } }, clientHeight: 600, scrollTop: 0,
  };
}

const prior = {};
let els;
let calls;

const alert = (id, o = {}) => ({ id, sev: 'err', type: 'overlap', msg: '', line: '', time: new Date('2026-10-21T08:00:00'), taskId: `T-${id}`, ...o });
const item = (key, o = {}) => ({
  family: 'calendar-day', key, titleKey: 'leverage.title.calendar-day', titleVars: { n: 1, line: 'L1', day: key },
  alertIds: ['a1'], orderIds: ['T-a1'], lines: ['L1'], points: 10, confidenceBefore: 70, confidenceAfter: 75, method: 'removal',
  outsideConfidenceWindowCount: 0, action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: [] }, ...o,
});
const setupItem = (o = {}) => item('setup-pair:x', {
  family: 'setup-pair', titleKey: 'leverage.title.setup-pair', titleVars: { from: 'a', to: 'b', lines: 1, orders: 1 },
  action: { kind: 'open-setup-matrix', plant: 'P1', pairs: [{ line: 'L1', fromState: [{ fieldKey: 'colorWheel', value: 'A' }], toState: [{ fieldKey: 'colorWheel', value: 'B' }], reason: 'setup-uncovered', successorOrderId: 'T-a1' }] },
  assumedMinutes: 15, minutesSource: 'plantDefault', ...o,
});

const FAKE_INPUT = { plant: 'P1', plantNow: new Date('2026-10-20T08:00:00'), horizonMinutes: 20160, alerts: [], baselineMatrix: {} };
let deps, counts, groupItems, analyzeImpl;

function seed(alerts) {
  Store.setAlerts(alerts, 'test');
  AlertProfileMatches.current = () => ({
    plant: 'P1', profileId: ALL_ALERTS_PROFILE_ID, profile: ALL_ALERTS_PROFILE,
    alertIds: new Set(alerts.map(a => a.id)), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(), acked: new Map(), rev: 1,
  });
}

beforeEach(() => {
  els = {};
  calls = { focusTasks: [], toasts: [], copied: [] };
  prior.doc = globalThis.document;
  prior.view = AlertProfileMatches.current;
  prior.setSession = AlertProfileMatches.setSessionProfile;
  prior.setFocusTaskIds = AlertProfileMatches.setFocusTaskIds;
  prior.cached = AlertProfileClient.cached;
  prior.setPref = Session.setPref;
  prior.clock = Util.plantClock;
  prior.nimbus = globalThis.NIMBUS;
  prior.toast = Toast.show;
  prior.navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async s => { calls.copied.push(s); } } }, configurable: true });
  AlertProfileMatches.setSessionProfile = () => {};
  AlertProfileMatches.setFocusTaskIds = ids => { calls.focusTasks.push(ids ? [...ids].sort() : null); };
  AlertProfileClient.cached = () => [];
  Session.setPref = () => {};
  Toast.show = (m, kind) => { calls.toasts.push([m, kind]); };
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setUserSettings({ alertsShowAcknowledged: false }, 'test');
  Store.setSelectedPlant('P1', 'test');
  Store.setAlerts([], 'test');
  Store.setTasks([], 'test');
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();

  deps = AlertMonitorPane._levDeps;
  prior.deps = { ...deps };
  counts = { group: 0, analyze: 0, replay: [] };
  groupItems = [item('k1')];
  analyzeImpl = async () => groupItems;
  deps.buildInput = () => FAKE_INPUT;
  deps.group = () => { counts.group++; return groupItems.map(i => ({ ...i })); };
  deps.analyze = async (input, runner) => { counts.analyze++; assert.equal(typeof runner, 'function'); return analyzeImpl(); };
  deps.replay = async (input, it, minutes) => { counts.replay.push(minutes); return { ...it, requiresMinutes: false, assumedMinutes: minutes, minutesSource: 'user', method: 'replay', confidenceAfter: 80 }; };
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  Object.assign(AlertMonitorPane._levDeps, prior.deps);
  globalThis.document = prior.doc;
  AlertProfileMatches.current = prior.view;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  AlertProfileMatches.setFocusTaskIds = prior.setFocusTaskIds;
  AlertProfileClient.cached = prior.cached;
  Session.setPref = prior.setPref;
  Util.plantClock = prior.clock;
  Toast.show = prior.toast;
  globalThis.NIMBUS = prior.nimbus;
  Sandbox.active = false;
  if (prior.navigator) Object.defineProperty(globalThis, 'navigator', prior.navigator); else delete globalThis.navigator;
});

const clickLev = (action, key, extra = {}) => els['alerts-tab'].handlers.click({
  target: { closest: sel => (sel === '[data-lev-action]' ? { dataset: { levAction: action, levKey: key, ...extra } } : null) },
});
const clickAm = (action) => els['alerts-tab'].handlers.click({
  target: { closest: sel => (sel === '[data-am-action]' ? { dataset: { amAction: action } } : null) },
});

test('first paint is a skeleton; the rows follow on the next tick and analysis runs once', async () => {
  seed([alert('a1')]);
  AlertMonitorPane.render();
  assert.match(els['am-leverage'].innerHTML, /am\.lev_computing/);
  await sleep(30);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/);
  assert.match(els['am-leverage'].innerHTML, /am\.fix_clears/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /point/i);
  assert.equal(counts.group, 1);
  assert.equal(counts.analyze, 1);
});

test('no alerts for the plant: no panel at all and nothing computed', async () => {
  seed([]);
  AlertMonitorPane.render();
  await sleep(30);
  assert.equal(els['am-leverage'].innerHTML, '');
  assert.equal(counts.group, 0);
});

test('two-phase: counts paint at once, the replay then adds the confidence clause to the setup-pair row', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem()];
  analyzeImpl = async () => [setupItem({ method: 'replay', confidenceAfter: 78 })];
  let phase1 = '';
  const orig = deps.analyze;
  deps.analyze = async (...a) => { phase1 = els['am-leverage'].innerHTML; return orig(...a); };
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(phase1, /am\.fix_clears/, 'phase 1 painted the counts before the replay returned');
  assert.doesNotMatch(phase1, /am\.fix_conf/);
  assert.match(els['am-leverage'].innerHTML, /am\.fix_conf/);
});

test('an inactive pane computes nothing, even when alerts change', async () => {
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  const g = counts.group, a = counts.analyze;
  AlertMonitorPane.setActive(false);
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(520);
  assert.equal(counts.group, g);
  assert.equal(counts.analyze, a);
});

test('alerts:change re-evaluates after the 400 ms debounce, not before', async () => {
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  const a = counts.analyze;
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(200);
  assert.equal(counts.analyze, a, 'still inside the debounce');
  await sleep(450);
  assert.equal(counts.analyze, a + 1);
});

test('while What-If is active the replay analysis is skipped but the rows still paint', async () => {
  Sandbox.active = true;
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/);
  assert.equal(counts.analyze, 0);
});

test('while an optimizer preview is open the replay analysis is skipped', async () => {
  globalThis.NIMBUS = { OptimizerPreview: { active: true } };
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  assert.equal(counts.analyze, 0);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/);
});

test('a result that finishes after the Store moved on is dropped', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem()];
  let first = true;
  analyzeImpl = async () => {
    if (first) { first = false; Store.setTasks([{ id: 'ZZ' }], 'test'); return [setupItem({ method: 'replay', confidenceAfter: 99 })]; }
    return [setupItem()];
  };
  AlertMonitorPane.render();
  await sleep(40);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.fix_conf/, 'the stale replay never reaches the page');
  await sleep(500);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.fix_conf/);
  assert.ok(counts.analyze >= 2, 'a fresh analysis was scheduled for the new revision');
});

test('Show alerts points the Gantt at the same orders (the list is not focused); the outline chip clears it', async () => {
  seed([alert('a1'), alert('a2', { peerId: 'T-a3' })]);
  groupItems = [item('k1', { alertIds: ['a1', 'a2'] })];
  AlertMonitorPane.render();
  await sleep(40);
  clickLev('show-alerts', 'k1');
  assert.deepEqual(calls.focusTasks.at(-1), ['T-a1', 'T-a2', 'T-a3'], 'taskIds and peerIds of the focused alerts');
  assert.equal(els['am-gantt-chip'].hidden, true, 'the chip reads view().focusIds, which this stub does not set');
  clickAm('clear-outline');
  assert.equal(calls.focusTasks.at(-1), null);
});

test('needs-planning: the row button opens the Orders table; Show these (the menu item) outlines exactly its orders on the Gantt', async () => {
  seed([alert('n1', { type: 'needs_planning', sev: 'warn', taskId: 'Q1' }), alert('n2', { type: 'needs_planning', sev: 'warn', taskId: 'Q2' }), alert('a9')]);
  groupItems = [item('needs-planning', {
    family: 'needs-planning', titleKey: 'leverage.title.needs-planning', titleVars: { n: 2, h: 3.5 },
    alertIds: ['n1', 'n2'], orderIds: ['Q1', 'Q2'], confidenceAfter: null, method: 'none', unplacedHours: 3.5,
    action: { kind: 'needs-planning', alertIds: ['n1', 'n2'] },
  })];
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /data-lev-action="open-table"[^>]*data-lev-key="needs-planning"/, 'Open in Orders is the row button (queued orders have no bar)');
  clickLev('show-alerts', 'needs-planning');
  assert.deepEqual(calls.focusTasks.at(-1), ['Q1', 'Q2'], 'only the family\'s own orders, not a9\'s');
  clickAm('clear-outline');
  assert.equal(calls.focusTasks.at(-1), null);
});

test('only the top 5 rows show until "Show 10 more"', async () => {
  seed([alert('a1')]);
  groupItems = Array.from({ length: 8 }, (_, i) => item(`k${i}`));
  AlertMonitorPane.render();
  await sleep(40);
  const cards = () => (els['am-leverage'].innerHTML.match(/class="am-fix"/g) || []).length;
  assert.equal(cards(), 5);
  clickAm('fixes-show-more');
  assert.equal(cards(), 8);
});

test('"Show 10 more" reveals 10 per click and stops at 50 rows', async () => {
  seed([alert('a1')]);
  groupItems = Array.from({ length: 300 }, (_, i) => item(`k${i}`));
  AlertMonitorPane.render();
  await sleep(40);
  const cards = () => (els['am-leverage'].innerHTML.match(/class="am-fix"/g) || []).length;
  assert.equal(cards(), 5);
  clickAm('fixes-show-more');
  assert.equal(cards(), 15);
  clickAm('fixes-show-more');
  assert.equal(cards(), 25);
  for (let i = 0; i < 6; i++) clickAm('fixes-show-more');
  assert.equal(cards(), 50, 'hard cap');
  assert.doesNotMatch(els['am-leverage'].innerHTML, /fixes-show-more/);
});

test('entering minutes replays that one row and shows the confidence clause only afterwards', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  analyzeImpl = async () => groupItems.map(i => ({ ...i }));
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /data-lev-minutes="setup-pair:x"/);
  assert.match(els['am-leverage'].innerHTML, /am\.fix_replay/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.fix_conf/, 'no confidence clause before minutes are entered');
  els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value: '12' } : null) } });
  await sleep(20);
  assert.deepEqual(counts.replay, [12]);
  assert.match(els['am-leverage'].innerHTML, /am\.fix_conf/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /data-lev-minutes/);
});

test('the inline Replay button reads that row\'s box; Enter plus Replay does not double-run', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  analyzeImpl = async () => groupItems.map(i => ({ ...i }));
  AlertMonitorPane.render();
  await sleep(40);
  const box = { dataset: { levMinutes: 'setup-pair:x' }, value: '9' };
  globalThis.document.querySelectorAll = sel => (sel === '[data-lev-minutes]' ? [box] : []);
  clickLev('replay-minutes', 'setup-pair:x');
  clickLev('replay-minutes', 'setup-pair:x');
  await sleep(20);
  assert.deepEqual(counts.replay, [9], 'the second click during the in-flight replay is ignored');
});

test('Enter leaves focus in the minutes box, yet the replay result still paints', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  AlertMonitorPane.render();
  await sleep(40);
  globalThis.document.activeElement = { classList: { contains: c => c === 'am-fix-min-input' } };
  els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value: '12' } : null) } });
  await sleep(20);
  assert.match(els['am-leverage'].innerHTML, /am\.fix_conf/, 'the replayed clause is visible without a blur');
  assert.doesNotMatch(els['am-leverage'].innerHTML, /data-lev-minutes/);
});

test('no minutes replay while What-If is active or an optimizer preview is open', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  AlertMonitorPane.render();
  await sleep(40);
  const enter = () => els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value: '12' } : null) } });
  Sandbox.active = true;
  enter();
  Sandbox.active = false;
  globalThis.NIMBUS = { OptimizerPreview: { active: true } };
  enter();
  await sleep(20);
  assert.deepEqual(counts.replay, []);
});

test('a non-positive or non-numeric minutes entry runs nothing', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  AlertMonitorPane.render();
  await sleep(40);
  for (const value of ['', '0', '-4', 'abc']) {
    els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value } : null) } });
  }
  await sleep(20);
  assert.deepEqual(counts.replay, []);
});

test('a row whose alerts persist after "Fix movable" shows the remaining count', async () => {
  seed([alert('a1', { type: 'blackout' })]);
  groupItems = [item('k1', { action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: ['a1'] } })];
  const { Alerts } = await import('../../../frontend/insights/services.mjs');
  const priorFix = Alerts.applyFix;
  Alerts.applyFix = () => {};
  try {
    AlertMonitorPane.render();
    await sleep(40);
    assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.lev_remaining/);
    clickLev('cal-fix', 'k1');
    Store.setAlerts([alert('a1', { type: 'blackout' })], 'test');   // the fix changed nothing: the alert persists
    await sleep(600);
    assert.match(els['am-leverage'].innerHTML, /am\.lev_remaining/);
  } finally { Alerts.applyFix = priorFix; }
});

test('copy summary puts the row text on the clipboard and says so', async () => {
  seed([alert('a1')]);
  groupItems = [item('k1', { adminOnly: true, family: 'routing-gap', action: { kind: 'routing-gap', step: 'pv_missing', material: 'M1', pv: '', machine: '' }, titleKey: 'leverage.title.routing-gap.pv_missing' })];
  AlertMonitorPane.render();
  await sleep(40);
  clickLev('copy-summary', 'k1');
  await sleep(10);
  assert.equal(calls.copied.length, 1);
  assert.match(calls.copied[0], /leverage\.title\.routing-gap\.pv_missing/);
  assert.ok(calls.toasts.some(([m]) => m === 'am.lev_copied'));
  assert.doesNotMatch(calls.copied[0], /point/i);
  assert.match(calls.copied[0], /am\.copy_orders/);
});

test('the panel also renders under the "nothing matches this profile" empty state', async () => {
  const alerts = [alert('a1')];
  Store.setAlerts(alerts, 'test');
  AlertProfileMatches.current = () => ({
    plant: 'P1', profileId: ALL_ALERTS_PROFILE_ID, profile: ALL_ALERTS_PROFILE,
    alertIds: new Set(), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(), acked: new Map(), rev: 1,
  });
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /class="panel am-fixes"/);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/);
});

test('a non-admin sees admin-only fixes under a collapsed disclosure that toggles and resets with the view', async () => {
  seed([alert('a1')]);
  groupItems = [item('main1'), item('adm1', { adminOnly: true, family: 'routing-gap', action: { kind: 'routing-gap', step: 'pv_missing', material: 'M1', pv: '', machine: '' } })];
  AlertMonitorPane.render();
  await sleep(40);
  const html = () => els['am-leverage'].innerHTML;
  assert.match(html(), /am\.fixes_admin_divider/);
  assert.doesNotMatch(html(), /data-lev-key="adm1"/);
  clickAm('fixes-admin-toggle');
  assert.match(html(), /aria-expanded="true"/);
  assert.match(html(), /data-lev-key="adm1"/);
  AlertMonitorPane.resetView();
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(html(), /aria-expanded="false"/);
  assert.doesNotMatch(html(), /data-lev-key="adm1"/);
});

test('the ⋯ trigger opens the overflow menu with the non-primary actions, dispatching through the card handler', async () => {
  seed([alert('a1')]);
  groupItems = [item('k1')];
  AlertMonitorPane.render();
  await sleep(40);
  const priorOpen = OverflowMenu.open;
  let opened = null;
  OverflowMenu.open = (anchor, items, opts) => { opened = { anchor, items, opts }; return { close() {} }; };
  try {
    const anchor = { dataset: { levMenu: 'k1' } };
    els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === '[data-lev-menu]' ? anchor : null) } });
    assert.ok(opened, 'menu opened');
    assert.equal(opened.anchor, anchor);
    assert.deepEqual(opened.opts, { align: 'end', key: 'k1' });
    const ids = opened.items.map(i => i.id);
    assert.ok(ids.includes('show-alerts') && ids.includes('open-table'));
    assert.ok(ids.includes('goto'), 'Go to is in the menu');
    assert.ok(!ids.includes('diagnose-cell'), 'diagnose is this row\'s primary, so it is not repeated in the menu');
    assert.deepEqual(opened.items.find(i => i.id === 'show-alerts').data, { levAction: 'show-alerts', levKey: 'k1' });
    opened.items.find(i => i.id === 'show-alerts').onSelect();
    assert.ok(calls.focusTasks.at(-1)?.length > 0, 'Show alerts asks the Gantt to outline the orders');
  } finally { OverflowMenu.open = priorOpen; }
});

test('a non-admin\'s menu for an adminOnly row holds the admin deep link; the primary is Copy summary', async () => {
  seed([alert('a1')]);
  groupItems = [item('adm1', { adminOnly: true, family: 'routing-gap', action: { kind: 'routing-gap', step: 'workcenter_unmapped', material: 'M1', pv: '', machine: '' } })];
  AlertMonitorPane.render();
  await sleep(40);
  clickAm('fixes-admin-toggle');
  assert.match(els['am-leverage'].innerHTML, /data-lev-action="copy-summary"/);
  const priorOpen = OverflowMenu.open;
  let opened = null;
  OverflowMenu.open = (anchor, items) => { opened = items; return { close() {} }; };
  try {
    els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === '[data-lev-menu]' ? { dataset: { levMenu: 'adm1' } } : null) } });
    const ids = opened.map(i => i.id);
    assert.ok(ids.includes('rg-workcenters'), 'admin link is in the menu');
    assert.ok(!ids.includes('copy-summary'));
    assert.match(opened.find(i => i.id === 'rg-workcenters').label, /am\.lev_admin_fix/);
  } finally { OverflowMenu.open = priorOpen; }
});

test('Replay during What-If runs nothing', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  AlertMonitorPane.render();
  await sleep(40);
  globalThis.document.querySelectorAll = sel => (sel === '[data-lev-minutes]' ? [{ dataset: { levMinutes: 'setup-pair:x' }, value: '9' }] : []);
  Sandbox.active = true;
  clickLev('replay-minutes', 'setup-pair:x');
  await sleep(20);
  assert.deepEqual(counts.replay, []);
});

test('a minutes entry made while a replay is in flight is ignored, not remembered', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  analyzeImpl = async () => groupItems.map(i => ({ ...i }));
  AlertMonitorPane.render();
  await sleep(40);
  const box = { dataset: { levMinutes: 'setup-pair:x' }, value: '9' };
  globalThis.document.querySelectorAll = sel => (sel === '[data-lev-minutes]' ? [box] : []);
  clickLev('replay-minutes', 'setup-pair:x');
  box.value = '7';
  clickLev('replay-minutes', 'setup-pair:x');
  await sleep(20);
  Store.setAlerts([alert('a1'), alert('a2')], 'test');   // a fresh analysis re-applies what was remembered
  await sleep(600);
  assert.deepEqual(counts.replay, [9, 9], 'only the first entry was recorded');
});

test('keyboard focus follows the admin disclosure and "Show 10 more" across their repaint', async () => {
  seed([alert('a1')]);
  const adm = item('adm1', { adminOnly: true, family: 'routing-gap', action: { kind: 'routing-gap', step: 'pv_missing', material: 'M1', pv: '', machine: '' } });
  groupItems = [...Array.from({ length: 8 }, (_, i) => item(`k${i}`)), adm];
  AlertMonitorPane.render();
  await sleep(40);
  let focused = null;
  const el = name => ({ name, dataset: {}, classList: { contains: () => false }, focus() { focused = name; } });
  globalThis.document.querySelector = sel => (sel === '[data-am-action="fixes-admin-toggle"]' ? el('toggle')
    : sel === '[data-am-action="fixes-show-more"]' ? (/fixes-show-more/.test(els['am-leverage'].innerHTML) ? el('more') : null) : null);
  clickAm('fixes-admin-toggle');
  assert.equal(focused, 'toggle');
  // 8 main rows: one click reveals the rest and removes the button, so focus goes to the first new row's primary button
  const newRow = { dataset: { levAction: 'diagnose-cell', levKey: 'k5' }, classList: { contains: c => c === 'btn-primary' }, focus() { focused = 'row-k5'; } };
  const other = { dataset: { levAction: 'show-alerts', levKey: 'k5' }, classList: { contains: () => false }, focus() { focused = 'wrong'; } };
  globalThis.document.querySelectorAll = sel => (sel === '[data-lev-action]' ? [other, newRow] : []);
  clickAm('fixes-show-more');
  assert.doesNotMatch(els['am-leverage'].innerHTML, /fixes-show-more/);
  assert.equal(focused, 'row-k5');
});

test('when "Show 10 more" survives the repaint, focus goes back to it', async () => {
  seed([alert('a1')]);
  groupItems = Array.from({ length: 30 }, (_, i) => item(`k${i}`));
  AlertMonitorPane.render();
  await sleep(40);
  let focused = null;
  globalThis.document.querySelector = sel => (sel === '[data-am-action="fixes-show-more"]' ? { focus() { focused = 'more'; } } : null);
  clickAm('fixes-show-more');
  assert.equal(focused, 'more');
});

// Dedicated leverage worker (workload relief B): the pane aborts the run it started.
function pendingAnalyze() {
  const seen = { signals: [] };
  deps.analyze = async (input, runner, items, opts) => {
    counts.analyze++;
    seen.signals.push(opts?.signal);
    return new Promise((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      seen.release = () => resolve(items);
    });
  };
  return seen;
}

test('leaving the tab aborts the in-flight leverage run and keeps the phase-1 cards', async () => {
  seed([alert('a1')]);
  const seen = pendingAnalyze();
  AlertMonitorPane.render();
  await sleep(40);
  assert.equal(seen.signals.length, 1);
  assert.equal(seen.signals[0].aborted, false);
  AlertMonitorPane.setActive(false);
  assert.equal(seen.signals[0].aborted, true);
  await sleep(10);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/, 'removal-only cards stay');
});

test('a plan move (Store.rev) aborts the in-flight run, then a fresh run starts after the debounce', async () => {
  seed([alert('a1')]);
  const seen = pendingAnalyze();
  AlertMonitorPane.render();
  await sleep(40);
  Store.setTasks([{ id: 'ZZ' }], 'test');
  assert.equal(seen.signals[0].aborted, true);
  await sleep(520);
  assert.equal(seen.signals.length, 2, 'the debounce re-ran the analysis');
  assert.equal(seen.signals[1].aborted, false);
});

test('a plant change aborts the in-flight run', async () => {
  seed([alert('a1')]);
  const seen = pendingAnalyze();
  AlertMonitorPane.render();
  await sleep(40);
  AlertMonitorPane.resetView();
  assert.equal(seen.signals[0].aborted, true);
});

test('a plant change aborts the old run AND starts the new plant\'s run', async () => {
  seed([alert('a1')]);
  const seen = pendingAnalyze();
  AlertMonitorPane.render();
  await sleep(40);
  AlertMonitorPane.resetView();
  assert.equal(seen.signals[0].aborted, true);
  AlertMonitorPane.render();
  await sleep(520);
  assert.ok(seen.signals.length >= 2, 'a fresh run started after the reset');
  assert.equal(seen.signals.at(-1).aborted, false);
});

test('alerts:change aborts the in-flight run', async () => {
  seed([alert('a1')]);
  const seen = pendingAnalyze();
  AlertMonitorPane.render();
  await sleep(40);
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  assert.equal(seen.signals[0].aborted, true);
});

test('a leverage timeout keeps the phase-1 removal-only cards and is not painted as a replay', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem()];
  deps.analyze = async () => { counts.analyze++; throw new DOMException('leverage batch timed out', 'TimeoutError'); };
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /class="am-fix"/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.fix_conf/);
  assert.equal(counts.analyze, 1, 'no retry loop after a timeout');
});

test('tool card "Open tool inventory" goes to Master Data > Tool Inventory, then filters the grid to the tool on the selected plant', async () => {
  const { ToolInventory } = await import('../../../frontend/master-data/tool-inventory.mjs');
  const seen = [];
  const priorOpen = ToolInventory.openForTool;
  ToolInventory.openForTool = (plant, tool) => seen.push(`open:${plant}:${tool}`);
  globalThis.NIMBUS = { App: { goto: t => seen.push(`goto:${t}`), gotoMasterSub: s => seen.push(`sub:${s}`) } };
  try {
    seed([alert('a1', { type: 'tool-conflict' })]);
    groupItems = [item('tool:T100', { family: 'tool', titleKey: 'leverage.title.tool', action: { kind: 'tool', tool: 'T100', alertIds: ['a1'] } })];
    AlertMonitorPane.render();
    await sleep(40);
    clickLev('tool-inventory', 'tool:T100');
    await sleep(10);
    assert.deepEqual(seen, ['goto:masterdata', 'sub:tool-inventory', 'open:P1:T100']);
    seen.length = 0;
    groupItems = [item('k1')];
    AlertMonitorPane.render();
    await sleep(40);
    clickLev('tool-inventory', 'k1');                  // not a tool card: nothing happens
    await sleep(10);
    assert.deepEqual(seen, []);
  } finally {
    ToolInventory.openForTool = priorOpen;
  }
});

const typeSearch = q => els['alerts-tab'].handlers.input({ target: { closest: sel => (sel === '[data-am-search]' ? { value: q } : null) } });

test('W6b: a filter scopes the listed fixes to the view (with the in-view clause) and rewinds "Show 10 more"', async () => {
  seed([alert('a1'), alert('a2', { type: 'late', sev: 'warn' })]);
  groupItems = Array.from({ length: 8 }, (_, i) => item(`k${i}`, { alertIds: i < 6 ? ['a1'] : ['a2'] }));
  AlertMonitorPane.render();
  await sleep(40);
  const cards = () => (els['am-leverage'].innerHTML.match(/class="am-fix"/g) || []).length;
  assert.equal(cards(), 5);
  clickAm('fixes-show-more');
  assert.equal(cards(), 8);
  typeSearch('overlap');                       // a1 only (its tag is "alert.tag.overlap")
  assert.equal(cards(), 5, 'the page rewinds to the first five; six fixes touch the view');
  assert.match(els['am-leverage'].innerHTML, /am\.lev_in_view/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /data-lev-key="k7"/);
});

test('W6b: no fix touches the view: the scoped empty state, not the plant-wide one', async () => {
  seed([alert('a1'), alert('a2', { type: 'late', sev: 'warn' })]);
  groupItems = [item('k1', { alertIds: ['a1'] })];
  AlertMonitorPane.render();
  await sleep(40);
  typeSearch('late');                          // a2 only
  assert.match(els['am-leverage'].innerHTML, /am\.lev_none_in_view/);
  typeSearch('');
  assert.match(els['am-leverage'].innerHTML, /data-lev-key="k1"/);
});
