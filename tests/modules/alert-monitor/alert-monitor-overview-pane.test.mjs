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
  assert.ok(at('am-narrow-chip') < at('am-overview'), 'the narrow chip moved into the sticky header, above the scroll area');
  assert.match(shell, /<div id="am-overview" hidden><\/div>/);
  assert.match(shell, /class="am-narrow-chip" id="am-narrow-chip" hidden/);
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
  Session.setPref = (k, v) => { calls.prefs.push([k, v]); Store.setUserSettings({ ...Store.userSettings, [k]: v }, 'test'); };
  clickAm('ov-toggle');
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorOverview', 'collapsed']);
  const html = els['am-overview'].innerHTML;
  assert.match(html, /class="am-overview is-collapsed"/);
  assert.match(html, /id="am-ov-body" class="am-ov-body" hidden/);
  assert.match(html, /am\.ov_strip\|n=4,o=0/);
  clickAm('ov-toggle');
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorOverview', 'open']);
  assert.doesNotMatch(els['am-overview'].innerHTML, /is-collapsed/, 'reopened right after the click');
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
  seedOv(ALERTS());
  AlertMonitorPane.render();
  AlertMonitorPane.setFocus(['zz-gone'], 'Fix');   // a focus set with nothing left (no-alerts)
  assert.equal(els['am-overview'].hidden, true);
  assert.equal(els['am-overview'].innerHTML, '');
  AlertMonitorPane.clearFocus();
  Store.setSelectedPlant(null, 'test');
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, true);
});

test('a hidden band keeps the narrow; the next non-empty paint restores it', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L2');
  Store.setAlerts([], 'test');
  AlertMonitorPane.render();
  assert.equal(els['am-overview'].hidden, true);
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a2', 'a4']);
});

test('refocus skips bars inside a hidden ancestor', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const body = makeEl('am-ov-body', globalThis.document);
  body.hidden = true;
  const hiddenBar = bar('line:L1');
  body.appendChild(hiddenBar);
  globalThis.document.getElementById('am-overview').querySelectorAll = sel => (sel === '[data-am-narrow]' ? [hiddenBar] : []);
  clickBar('line:L1');
  assert.notEqual(globalThis.document.activeElement, hiddenBar);
});

test('the leverage run (_gatherState) neither recomputes the band nor touches the narrow', async () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L2');
  const html = els['am-overview'].innerHTML;
  const seen = [];
  const prev = AlertMonitorPane._levDeps.buildInput;
  // buildInput runs right after _levRun's _gatherState and before its first _paint: band and chip must still be as before.
  AlertMonitorPane._levDeps.buildInput = st => { seen.push([els['am-overview'].innerHTML, els['am-narrow-chip'].hidden]); return prev(st); };
  try {
    await new Promise(r => setTimeout(r, 40));   // the deferred first leverage run
  } finally { AlertMonitorPane._levDeps.buildInput = prev; }
  assert.ok(seen.length >= 1, 'the leverage run really executed');
  assert.deepEqual(seen[0], [html, false]);
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
  assert.deepEqual(log, ['b']);   // exactly once
});

// ---- Task 30: Confidence panel inputs (score, history sparkline, ghost) ------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lev = (key, o = {}) => ({
  family: 'calendar-day', key, titleKey: 'leverage.title.calendar-day', titleVars: { n: 1, line: 'L1', day: key },
  alertIds: ['a1'], orderIds: ['a1'], lines: ['L1'], points: 10, confidenceBefore: 71, confidenceAfter: 78, method: 'replay',
  outsideConfidenceWindowCount: 0, action: { kind: 'calendar-day', line: 'L1', dayKey: '2026-10-21', fixableAlertIds: [] }, ...o,
});
const confHtml = () => els['am-overview'].innerHTML;
const hist = n => Array.from({ length: n }, (_, i) => ({ ts: 1000 + i, score: 60 + i }));
const levInput = () => ({ plant: 'P1', plantNow: new Date('2026-10-20T08:00:00'), horizonMinutes: 20160, alerts: [], baselineMatrix: {} });
let levPrior = null, adminPrior = null;

/** Seed, stub the leverage deps with `items` (both phases return them), render and wait for the run. */
async function withLev(items, { score = 71, admin = true } = {}) {
  levPrior ??= { ...AlertMonitorPane._levDeps };
  adminPrior ??= Session.isAdmin;
  Session.isAdmin = () => admin;
  Object.assign(AlertMonitorPane._levDeps, {
    buildInput: levInput, group: () => items.map(i => ({ ...i })), analyze: async () => items.map(i => ({ ...i })),
  });
  globalThis.NIMBUS = { Confidence: { _score: score } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  await sleep(40);
}
afterEach(() => {
  if (levPrior) { Object.assign(AlertMonitorPane._levDeps, levPrior); levPrior = null; }
  if (adminPrior) { Session.isAdmin = adminPrior; adminPrior = null; }
});

test('confidence: the dial tier follows the score (71 ok, 55 warn, 30 err) and shows the number', () => {
  for (const [score, tier] of [[71, 'ok'], [55, 'warn'], [30, 'err']]) {
    globalThis.NIMBUS = { Confidence: { _score: score } };
    seedOv(ALERTS());
    AlertMonitorPane.render();
    assert.match(confHtml(), new RegExp(`am-ov-conf-val ${tier}"`), `score ${score}`);
    assert.match(confHtml(), new RegExp(`am-ov-conf-n[^>]*>${score}<`));
  }
});

test('confidence: a 2-point history draws the sparkline, 1 point and none do not; no NIMBUS.Confidence does not throw', () => {
  globalThis.NIMBUS = { Confidence: { _score: 71, _history: hist(2) } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.match(confHtml(), /am-ov-spark-line/);
  globalThis.NIMBUS = { Confidence: { _score: 71, _history: hist(1) } };
  AlertMonitorPane.render();
  assert.doesNotMatch(confHtml(), /am-ov-spark/);
  globalThis.NIMBUS = { Confidence: { _score: 71 } };
  AlertMonitorPane.render();
  assert.doesNotMatch(confHtml(), /am-ov-spark/);
  globalThis.NIMBUS = {};
  assert.doesNotThrow(() => AlertMonitorPane.render());
  assert.ok(confHtml().includes('am-ov-where'), 'the band still renders without Confidence');
  assert.doesNotMatch(confHtml(), /am-ov-conf-tick|am-ov-spark/);
});

test('confidence: history is read fresh on every paint', () => {
  const h = hist(1);
  globalThis.NIMBUS = { Confidence: { _score: 71, _history: h } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.doesNotMatch(confHtml(), /am-ov-spark/);
  h.push({ ts: 2000, score: 70 });
  AlertMonitorPane.render();
  assert.match(confHtml(), /am-ov-spark-line/);
});

test('confidence ghost: a replayed 71 to 78 fix renders the after-score and the tick', async () => {
  await withLev([lev('k1')]);
  assert.ok(confHtml().includes('am.ov_conf_after|n=78'));
  assert.match(confHtml(), /am-ov-conf-tick/);
});

test('confidence ghost: none for removal, none when the rounded scores are equal, none while requiresMinutes, none without an after-score', async () => {
  for (const o of [{ method: 'removal' }, { confidenceBefore: 71.2, confidenceAfter: 70.6 }, { requiresMinutes: true }, { confidenceAfter: null }]) {
    await withLev([lev('k1', o)]);
    assert.doesNotMatch(confHtml(), /am-ov-conf-after/, JSON.stringify(o));
    assert.doesNotMatch(confHtml(), /am-ov-conf-tick/, JSON.stringify(o));
  }
});

test('confidence ghost: a lower after-score is shown too, and the ghost is the rounded after-score', async () => {
  await withLev([lev('k1', { confidenceAfter: 64 })]);
  assert.ok(confHtml().includes('am.ov_conf_after|n=64'));
  await withLev([lev('k1', { confidenceAfter: 77.6 })]);
  assert.ok(confHtml().includes('am.ov_conf_after|n=78'));
});

test('confidence ghost: a non-admin skips an adminOnly first item; an admin sees it', async () => {
  const items = [lev('k1', { adminOnly: true, confidenceAfter: 90 }), lev('k2', { confidenceAfter: 75 })];
  await withLev(items, { admin: false });
  assert.ok(confHtml().includes('am.ov_conf_after|n=75'));
  assert.ok(!confHtml().includes('n=90'));
  await withLev(items, { admin: true });
  assert.ok(confHtml().includes('am.ov_conf_after|n=90'));
});

test('confidence ghost: only the first main fix counts', async () => {
  await withLev([lev('k1', { method: 'removal' }), lev('k2', { confidenceAfter: 90 })]);
  assert.doesNotMatch(confHtml(), /am-ov-conf-after/);
});

test('confidence ghost: phase 2 of the leverage run adds the ghost without a manual repaint', async () => {
  levPrior ??= { ...AlertMonitorPane._levDeps };
  Object.assign(AlertMonitorPane._levDeps, {
    buildInput: levInput, group: () => [lev('k1', { method: 'removal', confidenceAfter: null })], analyze: async () => [lev('k1')],
  });
  globalThis.NIMBUS = { Confidence: { _score: 71 } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  assert.doesNotMatch(confHtml(), /am-ov-conf-after/, 'before the leverage run');
  await sleep(40);
  assert.ok(confHtml().includes('am.ov_conf_after|n=78'), 'after phase 2');
});

// ---- rev-3 fix wave (code half) ---------------------------------------------------------------------------------

test('I1: refocus skips a match under an aria-hidden ancestor (the What strip) and lands on the legend row', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const strip = makeEl('strip', globalThis.document);
  strip.setAttribute('aria-hidden', 'true');
  const segment = bar('category:conflicts');
  strip.appendChild(segment);
  const legendRow = bar('category:conflicts');
  globalThis.document.getElementById('am-overview').querySelectorAll = sel => (sel === '[data-am-narrow]' ? [segment, legendRow] : []);
  clickBar('category:conflicts');
  assert.equal(globalThis.document.activeElement, legendRow);
});

test('I2: a persistent #am-narrow-status live region carries "Showing n of total"; empty when the narrow clears', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const shell = els['alerts-tab'].innerHTML;
  assert.match(shell, /<div class="am-sr-only" id="am-narrow-status" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.doesNotMatch(shell, /id="am-narrow-status"[^>]*hidden/);
  assert.equal(els['am-narrow-status'].textContent ?? '', '');
  clickBar('day:2026-10-23');
  assert.equal(els['am-narrow-status'].textContent, 'am.ov_showing|n=2,total=4');
  clickBar('line:L1');
  assert.equal(els['am-narrow-status'].textContent, 'am.ov_showing|n=1,total=4');
  clickAm('clear-narrow');
  assert.equal(els['am-narrow-status'].textContent, '');
  assert.doesNotMatch(els['am-narrow-chip'].innerHTML, /aria-live/);
});

test('I3: every narrow control in the painted band carries aria-pressed (false until selected)', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const ctl = els['am-overview'].innerHTML.match(/<button[^>]*data-am-narrow="[^"]*"[^>]*>/g) || [];
  assert.ok(ctl.length > 6);
  for (const b of ctl) assert.match(b, /aria-pressed="false"/);
  clickBar('line:L1');
  const sel = (els['am-overview'].innerHTML.match(/<button[^>]*data-am-narrow="line:L1"[^>]*>/) || [''])[0];
  assert.match(sel, /aria-pressed="true"/);
});

test('M2: a focus set drops the profile window shading (the focus list ignores the profile)', () => {
  seedOv(ALERTS(), { profileId: 'p1', profile: P1 });
  AlertMonitorPane.render();
  assert.match(els['am-overview'].innerHTML, /class="am-ov-win"/, 'the profile window is shaded');
  AlertMonitorPane.setFocus(['a2', 'a4'], 'Fix');
  assert.doesNotMatch(els['am-overview'].innerHTML, /am-ov-win"/);
  assert.doesNotMatch(els['am-overview'].innerHTML, /am\.ov_window/);
  AlertMonitorPane.clearFocus();
  assert.match(els['am-overview'].innerHTML, /class="am-ov-win"/);
});

test('M5: a repaint that changes the band keeps focus on the same control (and on a toggle action)', () => {
  globalThis.NIMBUS = { Confidence: { _score: 71 } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const was = bar('day:2026-10-23');
  els['am-overview'].appendChild(was);
  globalThis.document.activeElement = was;
  const fresh = bar('day:2026-10-23');
  els['am-overview'].querySelectorAll = sel => (sel === '[data-am-narrow]' ? [fresh] : []);
  globalThis.NIMBUS = { Confidence: { _score: 50 } };
  const before = els['am-overview'].innerHTML;
  AlertMonitorPane.render();
  assert.notEqual(els['am-overview'].innerHTML, before, 'the band really repainted');
  assert.equal(globalThis.document.activeElement, fresh);

  const act = makeEl('', globalThis.document, 'button');
  act.setAttribute('data-am-action', 'ov-lines-more');
  els['am-overview'].appendChild(act);
  globalThis.document.activeElement = act;
  const freshAct = makeEl('', globalThis.document, 'button');
  freshAct.setAttribute('data-am-action', 'ov-lines-more');
  els['am-overview'].querySelectorAll = sel => (sel === '[data-am-action]' ? [freshAct] : []);
  globalThis.NIMBUS = { Confidence: { _score: 30 } };
  AlertMonitorPane.render();
  assert.equal(globalThis.document.activeElement, freshAct);
});

test('M5: focus outside the band is left alone by a band repaint', () => {
  globalThis.NIMBUS = { Confidence: { _score: 71 } };
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const elsewhere = makeEl('x', globalThis.document, 'button');
  globalThis.document.activeElement = elsewhere;
  els['am-overview'].querySelectorAll = () => { throw new Error('must not look for a control to refocus'); };
  globalThis.NIMBUS = { Confidence: { _score: 50 } };
  AlertMonitorPane.render();
  assert.equal(globalThis.document.activeElement, elsewhere);
});

test('M11: a collapsed band with an active narrow keeps the chip row, and its x still removes the narrow', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('day:2026-10-23');
  Store.setUserSettings({ ...Store.userSettings, alertMonitorOverview: 'collapsed' }, 'test');
  AlertMonitorPane.render();
  assert.match(els['am-overview'].innerHTML, /class="am-overview is-collapsed"/);
  assert.equal(els['am-narrow-chip'].hidden, false);
  assert.match(els['am-narrow-chip'].innerHTML, /data-am-narrow-clear="day"/);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a3', 'a4']);
  clickClear('day');
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.equal(ids(els['am-groups'].innerHTML).length, 4);
});

test('M11: What-If paints the band, the narrow still filters, and the band carries no extra disabled state', async () => {
  const { Sandbox } = await import('../../../frontend/optimization/sandbox.mjs');
  Sandbox.active = true;
  try {
    seedOv(ALERTS());
    AlertMonitorPane.render();
    assert.equal(els['am-overview'].hidden, false);
    assert.match(els['am-overview'].innerHTML, /data-am-narrow="day:2026-10-21"/);
    clickBar('line:L1');
    assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a3']);
    assert.doesNotMatch(els['am-overview'].innerHTML, /aria-disabled/);
  } finally { Sandbox.active = false; }
});

test('M11: a day narrow with Group by Day yields exactly one group', () => {
  seedOv(ALERTS(), { settings: { alertMonitorView: { __all__: { groupBy: 'day' }, p1: { groupBy: 'day' } } } });
  AlertMonitorPane.render();
  assert.equal((els['am-groups'].innerHTML.match(/<section class="am-group/g) || []).length, 2, 'two days before the narrow');
  clickBar('day:2026-10-23');
  assert.equal((els['am-groups'].innerHTML.match(/<section class="am-group/g) || []).length, 1);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a3', 'a4']);
});

test('M11: an acknowledgement that empties a selected line prunes the narrow and the whole list returns', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  clickBar('line:L2');
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a2', 'a4']);
  seedOv(ALERTS(), { acked: new Map([['a2', {}], ['a4', {}]]) });
  assert.doesNotThrow(() => AlertMonitorPane.render());
  assert.equal(els['am-narrow-chip'].hidden, true);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a1', 'a3']);
});

test('M11: a profile window ending past day 60 clamps the band to 60 day columns (plus Overdue and Later)', () => {
  const wide = { ...P1, rules: [{ types: ['overlap'], dayFrom: 0, dayTo: 80, minSev: null, minLateHours: null }] };
  seedOv(ALERTS(), { profileId: 'p1', profile: wide });
  AlertMonitorPane.render();
  const html = els['am-overview'].innerHTML;
  assert.equal((html.match(/class="am-ov-col[ "]/g) || []).length, 62);
  assert.match(html, /--cols:62/);
});

test('ghost predicate: a fractional 70.6 to 71.4 fix draws no ghost; 70.6 to 72.4 draws 72', async () => {
  await withLev([lev('k1', { confidenceBefore: 70.6, confidenceAfter: 71.4 })]);
  assert.doesNotMatch(confHtml(), /am-ov-conf-after|am-ov-conf-tick/);
  await withLev([lev('k1', { confidenceBefore: 70.6, confidenceAfter: 72.4 })]);
  assert.ok(confHtml().includes('am.ov_conf_after|n=72'));
  assert.ok(confHtml().includes('am.ov_conf_after_aria|n=72'), 'the after-fix value is in the accessible name');
});

// ---- visible chip, scroll-to-list, clickable What strip ----------------------------------------------------------

test('V1: the narrow chip lives in the sticky header (.am-head), in the controls row, not in the scroll area', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const shell = els['alerts-tab'].innerHTML;
  const at = id => shell.indexOf(`id="${id}"`);
  const scrollAt = shell.indexOf('id="am-scroll"');
  assert.ok(at('am-head') < at('am-narrow-chip') && at('am-narrow-chip') < scrollAt, 'chip is inside the header, before #am-scroll');
  assert.ok(at('am-seg') < at('am-narrow-chip'), 'beside the Group by / Sort by controls');
  assert.match(shell, /<div class="am-narrow-chip" id="am-narrow-chip" hidden><\/div>/);
  assert.equal(shell.indexOf('id="am-narrow-chip"', scrollAt), -1, 'no copy below the band');
});

test('V2: activating a narrow scrolls #am-groups into view (nearest, smooth); clearing does not', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const scrolls = [];
  els['am-groups'].scrollIntoView = opts => scrolls.push(opts);
  clickBar('day:2026-10-23');
  assert.deepEqual(scrolls, [{ block: 'nearest', behavior: 'smooth' }]);
  clickBar('line:L1');
  assert.equal(scrolls.length, 2, 'a second dimension activates and scrolls');
  clickBar('line:L1');   // toggles off: a clear
  assert.equal(scrolls.length, 2, 're-click that clears does not scroll');
  clickClear('day');
  clickAm('clear-narrow');
  assert.equal(scrolls.length, 2, 'chip x / Clear never scroll');
});

test('V3: prefers-reduced-motion scrolls without smooth behaviour', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const prev = globalThis.matchMedia;
  globalThis.matchMedia = q => ({ matches: /reduced-motion/.test(q) });
  try {
    const scrolls = [];
    els['am-groups'].scrollIntoView = opts => scrolls.push(opts);
    clickBar('category:capacity');
    assert.deepEqual(scrolls, [{ block: 'nearest', behavior: 'auto' }]);
  } finally { globalThis.matchMedia = prev; }
});

test('V4: the scroll does not steal focus: the clicked bar keeps it', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const [b] = bandBars('day:2026-10-23');
  els['am-groups'].scrollIntoView = () => {};
  clickBar('day:2026-10-23');
  assert.equal(globalThis.document.activeElement, b);
});

test('V5: What strip segments are real buttons with data-am-narrow, aria-label and aria-pressed; zero categories have none', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  const html = els['am-overview'].innerHTML;
  const strip = html.slice(html.indexOf('am-ov-strip'), html.indexOf('am-ov-catlist'));
  assert.doesNotMatch(strip, /tabindex="-1"/);
  const segs = strip.match(/<button[^>]*>/g) || [];
  assert.ok(segs.length >= 2);
  for (const s of segs) {
    assert.match(s, /type="button"/);
    assert.match(s, /data-am-narrow="category:[a-z]+"/);
    assert.match(s, /aria-pressed="false"/);
    assert.match(s, /aria-label="[^"]+"/);
  }
});

test('V6: a strip segment toggles the category narrow like the legend row, and refocus lands on the strip segment', () => {
  seedOv(ALERTS());
  AlertMonitorPane.render();
  els['am-groups'].scrollIntoView = () => {};
  const seg = bar('category:capacity'); seg.classList.add('am-ov-cat');
  const row = bar('category:capacity');
  globalThis.document.getElementById('am-overview').querySelectorAll = sel => (sel === '[data-am-narrow]' ? [seg, row] : []);
  click(seg);
  assert.deepEqual(ids(els['am-groups'].innerHTML), ['a3']);
  assert.equal(globalThis.document.activeElement, seg);
  click(row);
  assert.equal(ids(els['am-groups'].innerHTML).length, 4, 'the legend row toggles it off');
});
