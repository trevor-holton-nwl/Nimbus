// Task 29: the Overview band wired into the Alert Monitor pane — render, collapse pref, click-to-narrow, chip row,
// resets and focus. The mini-DOM never parses innerHTML: clicks use hand-built elements, the band's
// querySelectorAll is overridden for the refocus lookup, and narrowing is asserted through the #am-groups HTML string.
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
import { makeEl } from '../helpers/dom-stub.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const prior = {};
let els;
const calls = { prefs: [] };

const profile = (id, name) => ({ id, plant: 'P1', name, description: '', ranking: 'impact', created_by: null, updated_at: null,
  rules: [{ types: ['overlap'], dayFrom: 0, dayTo: 7, minSev: null, minLateHours: null }] });
const P1 = profile('p1', 'Overlaps'), P2 = profile('p2', 'Late orders');
const alert = (id, o = {}) => ({ id, sev: 'err', type: 'overlap', msg: '', line: 'L1', time: new Date('2026-10-21T08:00:00'), taskId: id, ...o });
const D21 = new Date('2026-10-21T08:00:00'), D23 = new Date('2026-10-23T08:00:00');
const ALERTS = () => [
  alert('a1', { line: 'L1', time: D21 }),
  alert('a2', { line: 'L2', time: D21, sev: 'warn' }),
  alert('a3', { line: 'L1', time: D23, type: 'overload' }),
  alert('a4', { line: 'L2', time: D23, sev: 'warn' }),
];

function fakeMatches(o = {}) {
  return {
    plant: 'P1', profileId: o.profileId ?? ALL_ALERTS_PROFILE_ID, profile: o.profile ?? ALL_ALERTS_PROFILE,
    alertIds: o.alertIds ?? new Set(), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(),
    acked: o.acked ?? new Map(), rev: 1,
  };
}

function seedOv(alerts, { settings = {}, ...m } = {}) {
  Store.setAlerts(alerts, 'test');
  Store.setUserSettings({
    alertProfileByPlant: { P1: 'p1' }, alertsShowAcknowledged: false,
    alertMonitorView: { __all__: { groupBy: 'category' }, p1: { groupBy: 'category' } }, ...settings,
  }, 'test');
  AlertProfileClient.cached = () => [P1, P2];
  AlertProfileMatches.view = () => fakeMatches({ alertIds: new Set(alerts.map(a => a.id)), ...m });
}

beforeEach(() => {
  els = {};
  prior.doc = globalThis.document;
  prior.view = AlertProfileMatches.view;
  prior.setSession = AlertProfileMatches.setSessionProfile;
  prior.cached = AlertProfileClient.cached;
  prior.setPref = Session.setPref;
  prior.clock = Util.plantClock;
  prior.t = Util.t;
  prior.nimbus = globalThis.NIMBUS;
  prior.lines = Store._linesByPlant;
  prior.locales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    activeElement: null,
  };
  globalThis.window.__NIMBUS_LOCALES = { en: {} };
  Util.t = (k, v) => (v ? `${k}|${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}` : k);
  calls.prefs = [];
  AlertProfileMatches.setSessionProfile = () => {};
  Session.setPref = (k, v) => { calls.prefs.push([k, v]); };
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setSelectedPlant('P1', 'test');
  Store.setAlerts([], 'test');
  Store.setTasks([], 'test');
  Store._linesByPlant = { P1: ['L1', 'L2', 'Line A'], P2: [] };
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  globalThis.document = prior.doc;
  AlertProfileMatches.view = prior.view;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  AlertProfileClient.cached = prior.cached;
  Session.setPref = prior.setPref;
  Util.plantClock = prior.clock;
  Util.t = prior.t;
  Store._linesByPlant = prior.lines;
  globalThis.NIMBUS = prior.nimbus;
  globalThis.window.__NIMBUS_LOCALES = prior.locales;
});

const bar = attr => {
  const b = makeEl('', globalThis.document, 'button');
  b.setAttribute('data-am-narrow', attr);
  return b;
};
const click = el => els['alerts-tab'].handlers.click({ target: el });
const clickBar = attr => click(bar(attr));
const clickAm = (action, extra = {}) => els['alerts-tab'].handlers.click({
  target: { closest: sel => (sel === '[data-am-action]' ? { dataset: { amAction: action, ...extra } } : null) },
});
const clickClear = dim => {
  const b = makeEl('', globalThis.document, 'button');
  b.setAttribute('data-am-narrow-clear', dim);
  click(b);
};
/** Make the band "contain" these bars for the refocus lookup (the mini-DOM does not parse innerHTML). */
function bandBars(...attrs) {
  const list = attrs.map(bar);
  globalThis.document.getElementById('am-overview').querySelectorAll = sel => (sel === '[data-am-narrow]' ? list : []);
  return list;
}
const ids = html => ['a1', 'a2', 'a3', 'a4'].filter(id => html.includes(`data-alert-id="${id}"`));
const ariaOf = (html, attr) => new RegExp(`data-am-narrow="${attr}"[^>]*aria-label="([^"]*)"`).exec(html)?.[1];

test('shell order: the band sits between the prompt and the leverage panel, the narrow chip between the focus chip and the groups', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const shell = els['alerts-tab'].innerHTML;
  const at = id => shell.indexOf(`id="${id}"`);
  assert.ok(at('am-prompt') < at('am-overview') && at('am-overview') < at('am-leverage'));
  assert.ok(at('am-focus-chip') < at('am-narrow-chip') && at('am-narrow-chip') < at('am-groups'));
  assert.match(shell, /<div id="am-overview" hidden><\/div>/);
  assert.match(shell, /class="am-focus-chip am-narrow-chip" id="am-narrow-chip" hidden/);
});

test('the band renders over the listed alerts with day / line / category narrow attributes and is shown', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const html = els['am-overview'].innerHTML;
  assert.equal(els['am-overview'].hidden, false);
  assert.match(html, /<section class="am-overview"/);
  assert.match(html, /data-am-narrow="day:2026-10-21"/);
  assert.match(html, /data-am-narrow="line:L1"/);
  assert.match(html, /data-am-narrow="category:conflicts"/);
  assert.match(html, /aria-expanded="true"/, 'open by default');
  assert.equal(els['am-narrow-chip'].hidden, true);
});

test('_fmtTick output appears on the tick columns', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.match(els['am-overview'].innerHTML, /<span class="am-ov-tick">Oct 27<\/span>/);
});

test('clicking a day bar narrows the list to that day, the chip counts it, the summary is unchanged; re-click clears', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const summary = els['am-summary'].innerHTML;
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a2', 'a3', 'a4']);
  clickBar('day:2026-10-23');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a3', 'a4']);
  assert.match(els['am-narrow-chip'].innerHTML, /am\.ov_showing\|n=2,total=4/);
  assert.match(els['am-narrow-chip'].innerHTML, /data-am-narrow-clear="day"/);
  assert.equal(els['am-narrow-chip'].hidden, false);
  assert.equal(els['am-summary'].innerHTML, summary);
  assert.match(els['am-overview'].innerHTML, /aria-pressed="true"/);
  clickBar('day:2026-10-23');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.equal(els['am-narrow-chip'].innerHTML, '');
});

test('two dimensions AND, and the other bars keep their unnarrowed counts', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const before = ariaOf(els['am-overview'].innerHTML, 'day:2026-10-23');
  const lineBefore = ariaOf(els['am-overview'].innerHTML, 'line:L2');
  assert.match(before, /e=1,w=1/);
  clickBar('day:2026-10-21');
  clickBar('line:L1');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1']);
  assert.match(els['am-narrow-chip'].innerHTML, /am\.ov_showing\|n=1,total=4/);
  assert.match(els['am-narrow-chip'].innerHTML, /data-am-narrow-clear="day"[\s\S]*data-am-narrow-clear="line"/);
  const html = els['am-overview'].innerHTML;
  assert.equal(ariaOf(html, 'day:2026-10-23'), before, 'a bar of the other day still shows its full count');
  assert.equal(ariaOf(html, 'line:L2'), lineBefore);
  clickClear('day');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a3']);
  clickAm('clear-narrow');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(els['am-narrow-chip'].hidden, true);
});

test('the chip x and "clear-narrow" reset dimensions; a category narrow works', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('category:capacity');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a3']);
  assert.match(els['am-narrow-chip'].innerHTML, /ape\.cat_capacity/);
  clickClear('category');
  assert.equal(ids(els['am-groups'].innerHTML).length, 4);
});

test('ov-toggle persists alertMonitorOverview and the band repaints collapsed; default is open', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-overview'].innerHTML, /is-collapsed/);
  clickAm('ov-toggle');
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorOverview', 'collapsed']);
  seedOv(ALERTS(), { settings: { alertMonitorOverview: 'collapsed' } });
  AlertMonitorPane.render();
  const html = els['am-overview'].innerHTML;
  assert.match(html, /class="am-overview is-collapsed"/);
  assert.match(html, /id="am-ov-body" class="am-ov-body" hidden/);
  assert.match(html, /am\.ov_strip\|n=4,o=0/);
  clickAm('ov-toggle');
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorOverview', 'open']);
});

test('a profile change resets the narrow but keeps folded groups; a plant change resets it too', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickAm('toggle-group', { groupKey: 'conflicts' });
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="a1"/);
  clickBar('line:L2');
  assert.deepEqual(ids(els['am-groups'].innerHTML), [], 'a2 and a4 sit in the folded conflicts group');
  assert.match(els['am-narrow-chip'].innerHTML, /am\.ov_showing/);
  AlertProfileMatches.view = () => fakeMatches({ profileId: 'p1', profile: P1, alertIds: new Set(['a1', 'a2', 'a3', 'a4']) });
  AlertMonitorPane.render();
  assert.equal(els['am-narrow-chip'].hidden, true, 'profile change cleared the narrow');
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="a1"/, 'the folded conflicts group stayed folded');
  clickBar('line:L2');
  assert.equal(els['am-narrow-chip'].hidden, false);
  Store.setSelectedPlant('P2', 'test');
  Store.setSelectedPlant('P1', 'test');
  assert.equal(els['am-narrow-chip'].hidden, true, 'plant change cleared the narrow');
});

test('setFocus clears the narrow and the band then counts the focus set; clearFocus clears it too', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L1');
  AlertMonitorPane.setFocus(['a2', 'a4'], 'Fix');
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a2', 'a4']);
  assert.match(els['am-overview'].innerHTML, /data-am-narrow="line:L2"/);
  assert.doesNotMatch(els['am-overview'].innerHTML, /data-am-narrow="line:L1"/, 'the band counts the focus set only');
  clickBar('line:L2');
  AlertMonitorPane.clearFocus();
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.equal(ids(els['am-groups'].innerHTML).length, 4);
});

test('a narrow whose value vanished is pruned silently on the next paint', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L2');
  assert.equal(els['am-narrow-chip'].hidden, false);
  Store.setAlerts(ALERTS().filter(a => a.line !== 'L2'), 'test');
  seedOv(ALERTS().filter(a => a.line !== 'L2'));
  AlertMonitorPane.render();
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a3']);
});

test('leverage HTML is identical with and without a narrow', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const lev = els['am-leverage'].innerHTML;
  clickBar('day:2026-10-23');
  assert.equal(els['am-leverage'].innerHTML, lev);
});

test('a narrow matching nothing writes am.ov_narrow_empty, empties the groups and tears down the list; Clear is in the chip', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L1');
  clickBar('day:2026-10-23');
  clickBar('category:conflicts');   // L1 on the 23rd is the overload (capacity): nothing left
  assert.match(els['am-groups'].innerHTML, /<div class="empty-state">am\.ov_narrow_empty<\/div>/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id/);
  assert.match(els['am-narrow-chip'].innerHTML, /data-am-action="clear-narrow"/);
  clickAm('clear-narrow');
  assert.equal(ids(els['am-groups'].innerHTML).length, 4);
});

test('group-by none: an emptying narrow tears the VirtualList down', () => {
  seedOv(ALERTS(), { settings: { alertMonitorView: { __all__: { groupBy: 'none' } } } });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /id="am-vl"/);
  clickBar('line:L1');
  clickBar('day:2026-10-23');
  clickBar('category:conflicts');
  assert.doesNotMatch(els['am-groups'].innerHTML, /am-vl/);
  assert.match(els['am-groups'].innerHTML, /am\.ov_narrow_empty/);
});

test('the band is hidden under every empty state', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, false);
  Store.setAlerts([], 'test');
  AlertMonitorPane.render();   // no alerts at the plant
  assert.equal(els['am-overview'].hidden, true);
  assert.equal(els['am-overview'].innerHTML, '');
  seedOv(ALERTS(), { alertIds: new Set(), profileId: 'p1', profile: P1 });   // profile matches nothing
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, true);
  seedOv(ALERTS(), { acked: new Map(ALERTS().map(a => [a.id, {}])) });       // everything acknowledged
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, true);
  Store.setSelectedPlant(null, 'test');
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, true);
});

test('the leverage run (_gatherState) neither recomputes the band nor touches the narrow', async () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L2');
  const html = els['am-overview'].innerHTML;
  await new Promise(r => setTimeout(r, 40));   // the deferred first leverage run
  assert.equal(els['am-overview'].innerHTML, html);
  assert.equal(els['am-narrow-chip'].hidden, false, 'the narrow survived');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a2', 'a4']);
});

test('a narrowed group counts and acts on the narrowed alerts only ("Move N orders")', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.ok(els['am-groups'].innerHTML.includes('am.group_fix_n|n=3'));   // conflicts: a1, a2, a4
  clickBar('line:L2');
  assert.ok(els['am-groups'].innerHTML.includes('am.group_fix_n|n=2'));   // a2, a4 only
  assert.ok(!els['am-groups'].innerHTML.includes('am.group_fix_n|n=3'));
});

test('focus returns to the new bar carrying the same data-am-narrow (attribute match; a line name with a space works)', () => {
  seedOv(ALERTS().map((a, i) => (i === 0 ? { ...a, line: 'Line A' } : a)));
  AlertMonitorPane.render();
  const fresh = bandBars('day:2026-10-21', 'line:Line A', 'category:conflicts');
  clickBar('line:Line A');
  assert.equal(globalThis.document.activeElement, fresh[1]);
  const x = bandBars('day:2026-10-23');
  clickBar('day:2026-10-23');
  assert.equal(globalThis.document.activeElement, x[0]);
});

test('ov-conf opens the confidence breakdown like the summary link does', () => {
  const log = [];
  globalThis.NIMBUS = { Confidence: { _score: 50, showBreakdown: () => log.push('b') } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickAm('ov-conf');
  assert.deepEqual(log, ['b']);
});
