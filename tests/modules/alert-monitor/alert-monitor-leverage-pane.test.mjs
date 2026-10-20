// The "High-leverage fixes" panel inside AlertMonitorPane: two-phase paint, gating (inactive / What-If /
// optimizer preview), stale-revision drop, "Show alerts" focus, top-5 + show-all, the minutes entry.
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
    appendChild() {}, remove() {}, removeEventListener() {}, style: {}, clientHeight: 600, scrollTop: 0,
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
  prior.current = AlertProfileMatches.current;
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
  AlertProfileMatches.current = prior.current;
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

test('first paint is a skeleton; the cards follow on the next tick and analysis runs once', async () => {
  seed([alert('a1')]);
  AlertMonitorPane.render();
  assert.match(els['am-leverage'].innerHTML, /am\.lev_computing/);
  await sleep(30);
  assert.match(els['am-leverage'].innerHTML, /class="am-lev-card/);
  assert.match(els['am-leverage'].innerHTML, /am\.lev_points/);
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

test('two-phase: removal numbers paint at once, the replay then updates the setup-pair card', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem()];
  analyzeImpl = async () => [setupItem({ method: 'replay', confidenceAfter: 78 })];
  let sawEstimate = false;
  const orig = deps.analyze;
  deps.analyze = async (...a) => { sawEstimate = /am\.lev_method_estimate/.test(els['am-leverage'].innerHTML); return orig(...a); };
  AlertMonitorPane.render();
  await sleep(40);
  assert.ok(sawEstimate, 'phase 1 painted the estimate before the replay returned');
  assert.match(els['am-leverage'].innerHTML, /am\.lev_method_exact/);
  assert.match(els['am-leverage'].innerHTML, />\+8</, '70 -> 78');
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

test('while What-If is active the replay analysis is skipped but the cards still paint', async () => {
  Sandbox.active = true;
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /class="am-lev-card/);
  assert.equal(counts.analyze, 0);
});

test('while an optimizer preview is open the replay analysis is skipped', async () => {
  globalThis.NIMBUS = { OptimizerPreview: { active: true } };
  seed([alert('a1')]);
  AlertMonitorPane.render();
  await sleep(40);
  assert.equal(counts.analyze, 0);
  assert.match(els['am-leverage'].innerHTML, /class="am-lev-card/);
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
  // The test's Util.t returns bare keys, so look for the rendered delta (99 - 70 = +29) instead of the vars.
  assert.doesNotMatch(els['am-leverage'].innerHTML, />\+29</, 'the stale replay never reaches the page');
  await sleep(500);
  assert.doesNotMatch(els['am-leverage'].innerHTML, />\+29</);
  assert.ok(counts.analyze >= 2, 'a fresh analysis was scheduled for the new revision');
});

test('Show alerts focuses the list, points the Gantt at the same orders, and scrolls to the groups', async () => {
  seed([alert('a1'), alert('a2', { peerId: 'T-a3' })]);
  groupItems = [item('k1', { alertIds: ['a1', 'a2'] })];
  AlertMonitorPane.render();
  await sleep(40);
  clickLev('show-alerts', 'k1');
  assert.equal(els['am-focus-chip'].hidden, false);
  assert.deepEqual(calls.focusTasks.at(-1), ['T-a1', 'T-a2', 'T-a3'], 'taskIds and peerIds of the focused alerts');
  assert.ok(els['am-groups'].scrolled > 0);
  clickAm('clear-focus');
  assert.equal(calls.focusTasks.at(-1), null);
  assert.equal(els['am-focus-chip'].hidden, true);
});

test('only the top 5 cards show until "show all fixes"', async () => {
  seed([alert('a1')]);
  groupItems = Array.from({ length: 8 }, (_, i) => item(`k${i}`));
  AlertMonitorPane.render();
  await sleep(40);
  const cards = () => (els['am-leverage'].innerHTML.match(/class="am-lev-card/g) || []).length;
  assert.equal(cards(), 5);
  clickAm('lev-show-more');
  assert.equal(cards(), 8);
});

test('entering minutes replays that one card and shows the exact score only afterwards', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  analyzeImpl = async () => groupItems.map(i => ({ ...i }));
  AlertMonitorPane.render();
  await sleep(40);
  assert.match(els['am-leverage'].innerHTML, /am\.lev_needs_minutes/);
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.lev_score/, 'no prediction before minutes are entered');
  els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value: '12' } : null) } });
  await sleep(20);
  assert.deepEqual(counts.replay, [12]);
  assert.match(els['am-leverage'].innerHTML, />\+10</, '70 -> 80');
  assert.match(els['am-leverage'].innerHTML, /am\.lev_method_exact/);
});

test('Enter leaves focus in the minutes box, yet the replay result still paints', async () => {
  seed([alert('a1')]);
  groupItems = [setupItem({ requiresMinutes: true, assumedMinutes: null, minutesSource: null })];
  AlertMonitorPane.render();
  await sleep(40);
  globalThis.document.activeElement = { classList: { contains: c => c === 'am-lev-min-input' } };
  els['alerts-tab'].handlers.change({ target: { closest: sel => (sel === '[data-lev-minutes]' ? { dataset: { levMinutes: 'setup-pair:x' }, value: '12' } : null) } });
  await sleep(20);
  assert.match(els['am-leverage'].innerHTML, />\+10</, 'the exact score is visible without a blur');
  assert.doesNotMatch(els['am-leverage'].innerHTML, /am\.lev_needs_minutes/);
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

test('a card whose alerts persist after "Fix movable" shows the remaining count', async () => {
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

test('copy summary puts the card text on the clipboard and says so', async () => {
  seed([alert('a1')]);
  groupItems = [item('k1', { adminOnly: true, family: 'routing-gap', action: { kind: 'routing-gap', step: 'pv_missing', material: 'M1', pv: '', machine: '' }, titleKey: 'leverage.title.routing-gap.pv_missing' })];
  AlertMonitorPane.render();
  await sleep(40);
  clickLev('copy-summary', 'k1');
  await sleep(10);
  assert.equal(calls.copied.length, 1);
  assert.match(calls.copied[0], /leverage\.title\.routing-gap\.pv_missing/);
  assert.ok(calls.toasts.some(([m]) => m === 'am.lev_copied'));
});
