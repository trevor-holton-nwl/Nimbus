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
import { makeEl } from '../helpers/dom-stub.mjs';
import { AlertProfileEditor } from '../../../frontend/alert-monitor/alert-profile-editor.mjs';
import { OverflowMenu } from '../../../frontend/platform/overflow-menu.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };   // microtasks only: the batch awaits stubs, no timers

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
  AlertProfileMatches.view = () => matches;
}

beforeEach(() => {
  els = {};
  prior.doc = globalThis.document;
  prior.view = AlertProfileMatches.view;
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
  // Only the summary-line sentences are translated (the rest of the page matches on raw keys).
  prior.locales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'am.summary_window': '{{n}} alerts in D{{from}}–{{to}} match {{name}}', 'am.summary_profile': '{{n}} alerts match {{name}}',
    'am.summary_all': '{{n}} alerts at this plant', 'am.summary_all_one': '1 alert at this plant', 'am.summary_errors': '{{e}} errors', 'am.summary_errors_one': '1 error',
    'am.summary_warnings': '{{w}} warnings', 'am.summary_warnings_one': '1 warning',
    'am.summary_orders': '{{o}} orders affected', 'am.summary_orders_one': '1 order affected',
    'am.summary_conf': 'Plant confidence {{score}}',
    'am.edit_profile': 'Edit', 'am.view_profile': 'View rules',
  } };
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
  AlertProfileMatches.view = prior.view;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  AlertProfileClient.cached = prior.cached;
  Session.setPref = prior.setPref;
  Util.plantClock = prior.clock;
  globalThis.NIMBUS = prior.nimbus;
  globalThis.window.__NIMBUS_LOCALES = prior.locales;
});

test('no plant renders the select-a-plant empty state and the summary says only that', () => {
  Store.setSelectedPlant(null, 'test');
  AlertProfileMatches.view = () => ({ ...fakeMatches(), plant: null });
  AlertProfileClient.cached = () => null;
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /am\.empty_no_plant/);
  assert.equal(els['am-summary'].innerHTML, '<span>am.empty_no_plant</span>');
  assert.equal(els['am-profile-input'].disabled, true);
  assert.equal(els['am-edit'].hidden, true);
  assert.equal(els['am-make-default'].hidden, true);
});

test('setActive(false) suppresses the render that alerts:change would trigger', async () => {
  useProfiles([P1, P2], fakeMatches({ alertIds: new Set(['a1']) }));
  globalThis.NIMBUS = { Confidence: { _score: 10 } };
  Store.setAlerts([alert('a1')], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-summary'].innerHTML, /am-summary-num">10</);

  AlertMonitorPane.setActive(false);
  globalThis.NIMBUS.Confidence._score = 77;
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(260);
  assert.match(els['am-summary'].innerHTML, /am-summary-num">10</, 'inactive pane must not repaint');

  AlertMonitorPane.setActive(true);
  Store.setAlerts([alert('a1')], 'test');
  await sleep(260);
  assert.match(els['am-summary'].innerHTML, /am-summary-num">77</);
});

/* ---------------------------------------------------------------------------
   Task 22 — page header: title, summary line, controls row
   ------------------------------------------------------------------------- */
const evt = map => ({ target: { closest: s => map[s] ?? null } });
const fire = (type, map) => els['alerts-tab'].handlers[type](evt(map));

test('the shell renders an h2 title, no KPI tiles, no category legend and no Manage profiles control', () => {
  useProfiles([P1], fakeMatches());
  AlertMonitorPane.render();
  const shell = els['alerts-tab'].innerHTML;
  assert.match(shell, /<h2 class="am-title">tab\.alerts<\/h2>/);
  assert.doesNotMatch(shell, /kpi-tile|am-kpi|am-cat-legend|am-toolbar/);
  assert.doesNotMatch(shell, /am\.manage_profiles|data-am-action="manage"/);
  assert.match(shell, /data-am-action="page-menu" data-ovf-key="page"/);
  assert.match(shell, /<select class="input am-group-sel" id="am-group-sel"/);
  assert.match(shell, /data-am-sort="impact"[^>]*>am\.sort_impact</);
  assert.match(shell, /data-am-sort="time"[^>]*>am\.sort_time</);
});

test('the summary line states the profile window, the counts and the confidence link', () => {
  const rules = [{ types: ['overlap'], dayFrom: 8, dayTo: 30, minSev: null, minLateHours: null }];
  const win = { ...P1, rules };
  AlertProfileClient.cached = () => [win];
  AlertProfileMatches.view = () => fakeMatches({ profileId: 'p1', profile: win, alertIds: new Set(['a1', 'a2']) });
  globalThis.NIMBUS = { Confidence: { _score: 71 } };
  Store.setAlerts([alert('a1', { taskId: '1', peerId: '2' }), alert('a2', { sev: 'warn', taskId: '3' })], 'test');
  AlertMonitorPane.render();
  const html = els['am-summary'].innerHTML;
  assert.match(html, /2 alerts in D8–30 match Overlaps · 1 error · 1 warning · 3 orders affected/);
  assert.match(html, /<button type="button" class="am-summary-conf" data-am-action="summary-conf">Plant confidence <span class="am-summary-num">71<\/span><\/button>/);
  assert.doesNotMatch(html, /points|pts|exact|estimate/i);
});

test('the summary line reads "at this plant" under All alerts, and the focus text replaces the lead in focus mode', () => {
  useProfiles([P1], fakeMatches({ alertIds: new Set(['a1']) }));
  globalThis.NIMBUS = {};
  Store.setAlerts([alert('a1')], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-summary'].innerHTML, /1 alert at this plant · 1 error · 1 order affected/);
  assert.doesNotMatch(els['am-summary'].innerHTML, /am-summary-conf/, 'no score yet, no link');
  AlertMonitorPane.setFocus(['a1'], 'Setup pair');
  assert.match(els['am-summary'].innerHTML, /^<span>am.focus_chip · 1 error/);
});

test('the confidence link opens the breakdown; the old KPI action is gone', () => {
  const log = [];
  useProfiles([P1], fakeMatches());
  globalThis.NIMBUS = { Confidence: { _score: 50, showBreakdown: () => log.push('breakdown') } };
  AlertMonitorPane.render();
  clickAm('summary-conf');
  clickAm('kpi-confidence');
  assert.deepEqual(log, ['breakdown']);
});

test('the profile picker offers "+ New profile…" last, also after filtering and when nothing matches', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  const input = els['am-profile-input'], dd = els['am-profile-dropdown'];
  input.value = '';
  input.handlers.input();
  assert.match(dd.innerHTML, /data-profile="__all__"[\s\S]*data-profile="p1"[\s\S]*data-profile="p2"[\s\S]*class="us-combo-option am-opt-new"[^>]*data-profile="__new__"[^>]*><span>\+ ape\.new_profile…</);
  input.value = 'late';
  input.handlers.input();
  assert.doesNotMatch(dd.innerHTML, /data-profile="p1"/);
  assert.match(dd.innerHTML, /data-profile="p2"[\s\S]*am-opt-new/);
  input.value = 'zzz';
  input.handlers.input();
  assert.match(dd.innerHTML, /us\.no_matches[\s\S]*am-opt-new/);
  assert.doesNotMatch(dd.innerHTML, /data-profile="p[12]"/);
});

test('"+ New profile…" is a pinned footer outside the scrolling option list', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  const input = els['am-profile-input'], dd = els['am-profile-dropdown'];
  for (const q of ['', 'zzz']) {
    input.value = q;
    input.handlers.input();
    const html = dd.innerHTML;
    const cut = html.lastIndexOf('</div><div class="us-combo-option am-opt-new"');
    assert.ok(cut > 0, 'the new-profile row follows the closing of the list region');
    assert.ok(html.startsWith('<div class="am-opt-scroll">'));
    assert.doesNotMatch(html.slice(0, cut), /am-opt-new/, 'and is not inside the scrolling region');
    assert.equal((html.match(/am-opt-new/g) || []).length, 1);
  }
});

test('the viewed option carries the window summary as a second line, and the input as aria-description', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  assert.match(els['am-profile-input'].getAttribute('aria-description'), /Overlap|am\.window|D0/);
  els['am-profile-input'].value = '';
  els['am-profile-input'].handlers.input();
  assert.match(els['am-profile-dropdown'].innerHTML, /data-profile="p1"[^>]*><span class="am-opt-text"><span class="am-opt-name">Overlaps<\/span><span class="am-opt-sub">/);
  assert.doesNotMatch(els['am-profile-dropdown'].innerHTML, /data-profile="p2"[^>]*><span class="am-opt-text"><span class="am-opt-name">Late orders<\/span><span class="am-opt-sub">/);
});

test('ArrowDown then Enter on the New option opens the editor on a blank draft and never sets the view', () => {
  const opened = [];
  const undo = patched(AlertProfileEditor, 'open', o => opened.push(o));
  try {
    useProfiles([P1], fakeMatches({ profileId: 'p1', profile: P1 }));
    AlertMonitorPane.render();
    const input = els['am-profile-input'];
    input.value = 'zzz';
    input.handlers.input();                       // no matches: New is the only option
    const key = k => input.handlers.keydown({ key: k, preventDefault() {} });
    key('ArrowDown');
    key('Enter');
    assert.deepEqual(opened, [{ plant: 'P1', fromPicker: true }]);
    assert.deepEqual(calls.session, []);
    assert.equal(els['am-profile-dropdown'].hidden, true);
  } finally { undo(); }
});

test('clicking the New option opens the editor; _chooseProfile ignores ids that are not options', () => {
  const opened = [];
  const undo = patched(AlertProfileEditor, 'open', o => opened.push(o));
  try {
    useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
    AlertMonitorPane.render();
    const pick = id => els['am-profile-dropdown'].handlers.mousedown({ preventDefault() {}, target: { closest: () => ({ dataset: { profile: id } }) } });
    pick('__new__');
    pick('bogus');
    assert.deepEqual(opened, [{ plant: 'P1', fromPicker: true }]);
    assert.deepEqual(calls.session, []);
  } finally { undo(); }
});

test('Edit is hidden under All alerts; it reads View rules for a non-creator and Edit for the creator or an admin', () => {
  const opened = [];
  const undo = [
    patched(AlertProfileEditor, 'open', o => opened.push(o)),
    patched(Session, 'currentUser', () => ({ username: 'Pat' })),
    patched(Session, 'isAdmin', () => false),
  ];
  try {
    useProfiles([P1], fakeMatches());
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].hidden, true);

    const mine = { ...P1, created_by: 'pat' };
    AlertProfileClient.cached = () => [mine];
    AlertProfileMatches.view = () => fakeMatches({ profileId: 'p1', profile: mine });
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].hidden, false);
    assert.equal(els['am-edit'].textContent, 'Edit');
    clickAm('edit-profile');
    assert.deepEqual(opened, [{ plant: 'P1', profileId: 'p1' }]);

    const theirs = { ...P1, created_by: 'sam' };
    AlertProfileClient.cached = () => [theirs];
    AlertProfileMatches.view = () => fakeMatches({ profileId: 'p1', profile: theirs });
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].textContent, 'View rules');
    Session.isAdmin = () => true;
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].textContent, 'Edit');
  } finally { undo.forEach(u => u()); }
});

test('the ⋯ page menu holds the two checkbox items and each writes its own pref', () => {
  const seen = [];
  const undo = patched(OverflowMenu, 'open', (anchor, items, opts) => { seen.push({ anchor, items, opts }); return { close() {} }; });
  try {
    useProfiles([P1], fakeMatches());
    Store.setUserSettings({ alertProfileGanttHighlight: true, alertsShowAcknowledged: false }, 'test');
    AlertMonitorPane.render();
    clickAm('page-menu');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].opts, { align: 'end', key: 'page' });
    assert.deepEqual(seen[0].items.map(i => [i.id, i.checked]), [['highlight', true], ['ack', false]]);
    assert.ok(seen[0].items[0].hint && /alert_gantt_highlight_hint/.test(seen[0].items[0].hint) || seen[0].items[0].hint?.length > 10, 'the highlight item explains the category fills');
    assert.equal(seen[0].items[1].hint, undefined);
    seen[0].items[0].onSelect(false);
    seen[0].items[1].onSelect(true);
    assert.deepEqual(calls.prefs, [['alertProfileGanttHighlight', false], ['alertsShowAcknowledged', true]]);
  } finally { undo(); }
});

test('a repaint ends with OverflowMenu.reconcile()', () => {
  let n = 0;
  const undo = patched(OverflowMenu, 'reconcile', () => { n++; });
  try {
    useProfiles([P1], fakeMatches());
    AlertMonitorPane.render();
    assert.equal(n, 1);
  } finally { undo(); }
});

test('Group by is a select, Machine by default; a change writes only groupBy', () => {
  useProfiles([P1], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  assert.equal(els['am-group-sel'].value, 'line');
  assert.match(els['alerts-tab'].innerHTML, /<option value="line">am\.group_line<\/option><option value="day">/);
  fire('change', { '[data-am-group-sel]': { value: 'day' } });
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorView', { p1: { groupBy: 'day' } }]);
  fire('change', { '[data-am-group-sel]': { value: 'nonsense' } });
  assert.equal(calls.prefs.length, 1);
});

test('the Sort by switch writes only sort, impact or time', () => {
  useProfiles([P1], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  fire('click', { '[data-am-sort]': { dataset: { amSort: 'time' } } });
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorView', { p1: { sort: 'time' } }]);
  fire('click', { '[data-am-sort]': { dataset: { amSort: 'impact' } } });
  assert.deepEqual(calls.prefs.at(-1), ['alertMonitorView', { p1: { sort: 'impact' } }]);
  fire('click', { '[data-am-sort]': { dataset: { amSort: 'severity' } } });
  assert.equal(calls.prefs.length, 2);
});

test('the controls reflect a stored view; a stored severity sort reads as impact, a time-ranked profile defaults to Date', () => {
  const timed = { ...P1, ranking: 'time' };
  AlertProfileClient.cached = () => [timed];
  AlertProfileMatches.view = () => fakeMatches({ profileId: 'p1', profile: timed });
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' }, alertMonitorView: {} }, 'test');
  const active = [];
  globalThis.document.querySelectorAll = s => (s === '[data-am-sort]'
    ? ['impact', 'time'].map(id => ({ dataset: { amSort: id }, classList: { toggle: (c, on) => on && active.push(id) }, setAttribute() {} })) : []);
  AlertMonitorPane.render();
  assert.deepEqual([...new Set(active)], ['time']);
  active.length = 0;
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' }, alertMonitorView: { p1: { sort: 'severity' } } }, 'test');
  AlertMonitorPane.render();
  assert.deepEqual([...new Set(active)], ['impact']);
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

test('Set as default writes alertProfileByPlant read-modify-write; "Your default" shows when already default (also for All alerts)', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p2', profile: P2 }));
  AlertMonitorPane.render();
  assert.equal(els['am-make-default'].hidden, false);
  assert.equal(els['am-is-default'].hidden, true);
  clickAm('make-default');
  assert.deepEqual(calls.prefs, [['alertProfileByPlant', { P1: 'p2', P9: 'z' }]]);
  assert.deepEqual(calls.session, [null]);

  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  assert.equal(els['am-make-default'].hidden, true);
  assert.equal(els['am-is-default'].hidden, false);

  // All alerts is allowed as a default too (as in v1): it is not the user's default here, so the button shows.
  useProfiles([P1, P2], fakeMatches());
  AlertMonitorPane.render();
  assert.equal(els['am-make-default'].hidden, false);
  clickAm('make-default');
  assert.deepEqual(calls.prefs.at(-1), ['alertProfileByPlant', { P1: '__all__', P9: 'z' }]);
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
  clickAm('switch-all');
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
    // The page defaults to Machine grouping; the list tests below are about the category cards, so they store that.
    alertMonitorView: { __all__: view ?? { groupBy: 'category' } },
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

test('a group head carries counts and the ⋯ menu but no totals or column captions; a row is one line with no number columns', () => {
  Store.setTasks([task('1'), task('2'), task('3', { end_date: new Date('2026-10-21T07:00:00') })], 'test');
  seed([
    alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }),
    alert('a2', { type: 'tool-conflict', taskId: '2', peerId: '3' }),
  ]);
  AlertMonitorPane.render();
  const html = els['am-groups'].innerHTML;
  assert.match(html, /badge badge-err">2</);
  assert.match(html, /class="btn sm am-group-move" data-am-action="group-move" data-group-key="conflicts"[^>]*>am\.group_fix_n</);
  assert.match(html, /class="icon-btn sm am-group-menu" data-group-key="conflicts" data-ovf-key="conflicts"/);
  assert.doesNotMatch(html, /am-tot|am-gtots|am-cols|am-imp|am-num|am-meta|am\.col_|points/);
  assert.equal((html.match(/class="am-when/g) ?? []).length, 2, 'one when line per row');
});

test('a row shows [line ·] [order ·] message, the day with its relative time, and goes red once overdue', () => {
  // The plant's lines come from its tasks' MACHINE (alerts on other lines are not shown).
  Store.setTasks([task('1', { MACHINE: 'L3', original_end_date: new Date('2026-10-17T08:00:00') }), task('2', { MACHINE: 'L4' })], 'test');
  seed([
    alert('a1', { type: 'late', taskId: '1', line: 'L3' }),
    alert('a2', { type: 'late', taskId: '2', line: 'L4' }),
    alert('tz', { type: 'plant_no_timezone', taskId: undefined, line: '', time: new Date('2026-10-23T08:00:00') }),
  ]);
  AlertMonitorPane.render();
  const html = els['am-groups'].innerHTML;
  const row = id => html.match(new RegExp(`<div class="am-rowwrap" role="listitem" data-alert-id="${id}">[\\s\\S]*?(?=<div class="am-rowwrap"|</div></section>|$)`))[0];
  assert.match(row('a2'), /<span class="am-pfx">L4 · 472 ·<\/span>/);
  assert.match(row('a2'), /class="am-when" title="am\.anchor_due: [^"]*">[^<]*· am\.rel_in_days</);
  assert.match(row('a1'), /class="am-when am-when-overdue"[^>]*>[^<]*· am\.rel_overdue_days</);
  assert.doesNotMatch(row('tz'), /am-pfx/, 'no prefix and no separator when nothing remains');
  assert.doesNotMatch(row('tz'), /am-when-overdue/);
});

test('under Machine grouping the row prefix drops the line; under Order grouping it drops the order number', () => {
  Store.setTasks([task('1', { MACHINE: 'L3' })], 'test');
  seed([alert('a1', { type: 'late', taskId: '1', line: 'L3' })], { view: { groupBy: 'line' } });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /<span class="am-pfx">471 ·<\/span>/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /<span class="am-pfx">L3/);
  seed([alert('a1', { type: 'late', taskId: '1', line: 'L3' })], { view: { groupBy: 'order' } });
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /<span class="am-pfx">L3 ·<\/span>/);
});

test('the headline and the help sentence ride in the row tooltip; no ⓘ icon', () => {
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { ...priorLocales.en, 'alert.help.late': 'The order finishes after its due date.' } };
  Store.setTasks([task('1')], 'test');
  seed([alert('a1', { type: 'late', taskId: '1' })]);
  AlertMonitorPane.render();
  assert.match(els['am-groups'].innerHTML, /<div class="am-row am-row-err" title="[^"]*— The order finishes after its due date\.">/);
  assert.doesNotMatch(els['am-groups'].innerHTML, /ⓘ|am-help/);
});

test('nothing the page renders says points, pts, exact or estimate', () => {
  Store.setTasks([task('1'), task('2')], 'test');
  seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('a2', { type: 'closed', taskId: '2' }), alert('a3', { type: 'overload', taskId: undefined, line: 'L1' })]);
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-groups'].innerHTML + els['am-summary'].innerHTML, /points|pts|exact|estimate/i);
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

test('row actions mirror the drawer (focus, fix, override) and a stray "dismiss" is not an action here', () => {
  const log = [];
  globalThis.NIMBUS = {
    AlertsUIAdapter: { focus: id => log.push(['focus', id]) },
    Table: { _openOverrideModalForId: id => log.push(['override', id]) },
  };
  const undo = [
    patched(Alerts, 'applyFix', id => log.push(['fix', id])),
    patched(Alerts, 'dismiss', id => log.push(['dismiss', id])),
    patched(Alerts, 'dismissAll', id => log.push(['dismissAll', id])),
  ];
  try {
    seed([alert('a1', { type: 'overlap' })]);
    AlertMonitorPane.render();
    clickAlert('focus', 'a1');
    clickAlert('fix', 'a1');
    clickAlert('override', 'a1', { taskId: 'T9' });
    clickAlert('dismiss', 'a1');
    assert.deepEqual(log, [['focus', 'a1'], ['fix', 'a1'], ['override', 'T9']]);
  } finally { undo.forEach(u => u()); }
});

test('there is no Dismiss anywhere on the page: no row or group button, no menu item, no group-dismiss action', () => {
  const seen = [];
  const log = [];
  const undo = [
    patched(OverflowMenu, 'open', (anchor, items) => { seen.push(items); return { close() {} }; }),
    patched(Alerts, 'dismiss', id => log.push(['dismiss', id])),
    patched(Alerts, 'dismissAll', ids => log.push(['dismissAll', ids])),
    patched(Modal, 'confirm', async () => { log.push('confirm'); return true; }),
  ];
  try {
    Store.setTasks([task('1'), task('2')], 'test');
    seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2', line: 'L1' }), alert('a2', { type: 'closed', taskId: '2', line: 'L1' })]);
    AlertMonitorPane.render();
    assert.doesNotMatch(els['am-groups'].innerHTML, /dismiss|am\.group_dismiss|btn\.dismiss/i);
    clickAlert('dismiss', 'a1');
    clickAm('group-dismiss', { groupKey: 'conflicts' });
    clickMenu('.am-row-menu', { alertId: 'a1' });
    clickMenu('.am-group-menu', { groupKey: 'conflicts' });
    assert.equal(seen.length, 2);
    for (const items of seen) assert.ok(items.every(i => !/dismiss/i.test(`${i.id} ${i.label} ${JSON.stringify(i.data)}`)));
    assert.deepEqual(log, []);
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
  assert.match(html, /<dt>ui\.insp_due_date<\/dt><dd[^>]*>10\/21\/2026 08:00 AM</);
  assert.match(html, /<dt>ui\.insp_planned_finish<\/dt><dd[^>]*>10\/22\/2026 08:00 AM</);
  assert.match(html, /<dt>ui\.late<\/dt><dd[^>]*>24 h</);
  assert.match(html, /<dt>ui\.insp_run_time<\/dt><dd[^>]*>6\.5 h · Routing · PV 1</);
  // The diagnostic names the firm reasons (Engine.firmStatusText), not the old planner-or-SAP flag.
  assert.match(html, /<dt>ui\.insp_firming<\/dt><dd[^>]*>ui\.firm_status_line</);
  assert.match(html, /<dt>am\.diag_setup<\/dt><dd[^>]*>colorWheel RED → colorWheel BLUE</);
  assert.match(html, /<dt>am\.diag_reason<\/dt><dd[^>]*>X · held for runtime · resolve</);
  clickAlert('diagnose', 'o1');
  assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-diag"/);
});

/* ---------------------------------------------------------------------------
   Task 24 — ⋯ menus, group "Move N orders", bulk acknowledge, the group-by none list
   ------------------------------------------------------------------------- */
import { AlertAckModal } from '../../../frontend/alert-monitor/alert-ack-modal.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { VirtualList } from '../../../frontend/platform/foundation.mjs';
import { ROW_H, DIAG_H } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const clickMenu = (selector, dataset) => els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === selector ? { dataset } : null) } });
const section = key => els['am-groups'].innerHTML.match(new RegExp(`<section class="am-group panel" data-group-key="${key}">[\\s\\S]*?</section>`))[0];

/** Click a ⋯ trigger through the delegated handler and return what OverflowMenu.open was called with. */
function openMenu(selector, dataset) {
  const seen = [];
  const undo = patched(OverflowMenu, 'open', (anchor, items, opts) => { seen.push({ anchor, items, opts }); return { close() {} }; });
  try { clickMenu(selector, dataset); } finally { undo(); }
  return seen;
}

test('the row ⋯ menu lists Go to, Fix, Diagnose, Acknowledge with the buttons\' data attributes, keyed by the alert id', () => {
  Store.setTasks([task('1')], 'test');
  seed([alert('a1', { type: 'overlap', taskId: '1', line: 'L1' })]);
  AlertMonitorPane.render();
  const [m] = openMenu('.am-row-menu', { alertId: 'a1' });
  assert.deepEqual(m.opts, { align: 'end', key: 'a1' });
  assert.deepEqual(m.items.map(i => [i.id, i.label, !!i.disabled]), [
    ['focus', 'btn.go_to', false], ['fix', 'btn.fix_it', false], ['diagnose', 'am.diagnose', false], ['ack', 'am.ack', false],
  ]);
  assert.ok(m.items.every(i => i.data.alertAction === i.id && i.data.alertId === 'a1' && i.data.taskId === '1'));
});

test('the row ⋯ menu offers Override for the closed family and Remove acknowledgement on an acknowledged row', () => {
  const acked = new Map([['c1', { alert_id: 'c1', acknowledged_by: 'pat', until: null }]]);
  Store.setTasks([task('1')], 'test');
  seed([alert('c1', { type: 'closed', taskId: '1', line: 'L1' })], { acked, showAcked: true });
  AlertMonitorPane.render();
  const [m] = openMenu('.am-row-menu', { alertId: 'c1' });
  assert.deepEqual(m.items.map(i => i.id), ['focus', 'override', 'diagnose', 'unack']);
  assert.deepEqual(m.items.find(i => i.id === 'unack').label, 'am.unack');
});

test('menu items dispatch through the same handler as the buttons: focus, fix, override, diagnose, ack, unack', async () => {
  const log = [];
  globalThis.NIMBUS = {
    AlertsUIAdapter: { focus: id => log.push(['focus', id]) },
    Table: { _openOverrideModalForId: id => log.push(['override', id]) },
  };
  const undo = [
    patched(Alerts, 'applyFix', id => log.push(['fix', id])),
    patched(AlertAckModal, 'open', o => log.push(['ack', o.plant, o.alertId])),
    patched(AlertAcksClient, 'unacknowledge', async (plant, id) => { log.push(['unack', plant, id]); }),
  ];
  try {
    Store.setTasks([task('1'), task('2')], 'test');
    const acked = new Map([['c1', { alert_id: 'c1', acknowledged_by: 'pat', until: null }]]);
    seed([alert('a1', { type: 'late', taskId: '1', line: 'L1' }), alert('o1', { type: 'overlap', taskId: '2', line: 'L1' }),
      alert('c1', { type: 'closed', taskId: '2', line: 'L1' })], { acked, showAcked: true });
    AlertMonitorPane.render();
    const pick = (id, action) => openMenu('.am-row-menu', { alertId: id })[0].items.find(i => i.id === action).onSelect({});
    pick('o1', 'focus');
    pick('o1', 'fix');
    pick('c1', 'override');
    pick('a1', 'ack');
    pick('c1', 'unack');
    await sleep(0);
    assert.deepEqual(log, [['focus', 'o1'], ['fix', 'o1'], ['override', '2'], ['ack', 'P1', 'a1'], ['unack', 'P1', 'c1']]);
    assert.doesNotMatch(els['am-groups'].innerHTML, /class="am-diag"/);
    pick('a1', 'diagnose');
    assert.match(els['am-groups'].innerHTML, /class="am-diag"/);
  } finally { undo.forEach(u => u()); }
});

test('after Diagnose the ⋯ trigger the repaint replaced gets focus back (found by its data-ovf-key)', () => {
  const focused = [];
  Store.setTasks([task('1')], 'test');
  seed([alert('a1', { type: 'late', taskId: '1', line: 'L1' })]);
  AlertMonitorPane.render();
  globalThis.document.querySelectorAll = sel => (sel === '[data-ovf-key]'
    ? [{ getAttribute: () => 'a1', focus: () => focused.push('a1') }, { getAttribute: () => 'other', focus: () => focused.push('other') }] : []);
  openMenu('.am-row-menu', { alertId: 'a1' })[0].items.find(i => i.id === 'diagnose').onSelect({});
  assert.deepEqual(focused, ['a1']);
});

test('under What-If the ⋯ menu disables Fix and Override with the hint, and the handler blocks them anyway', () => {
  const log = [];
  globalThis.NIMBUS = { Table: { _openOverrideModalForId: id => log.push(['override', id]) } };
  const undo = patched(Alerts, 'applyFix', id => log.push(['fix', id]));
  Sandbox.active = true;
  try {
    Store.setTasks([task('1'), task('2')], 'test');
    seed([alert('o1', { type: 'overlap', taskId: '1', line: 'L1' }), alert('c1', { type: 'closed', taskId: '2', line: 'L1' })]);
    AlertMonitorPane.render();
    for (const [id, action] of [['o1', 'fix'], ['c1', 'override']]) {
      const item = openMenu('.am-row-menu', { alertId: id })[0].items.find(i => i.id === action);
      assert.equal(item.disabled, true);
      assert.equal(item.hint, 'am.whatif_blocked');
      item.onSelect({});
    }
    assert.deepEqual(log, []);
    const ack = openMenu('.am-row-menu', { alertId: 'o1' })[0].items.find(i => i.id === 'ack');
    assert.equal(!!ack.disabled, false, 'acknowledging is server state: it stays available');
  } finally { Sandbox.active = false; undo(); }
});

test('the group ⋯ menu lists Go to, Move N orders, Open these N orders, Acknowledge N… (N = the group\'s un-acknowledged alerts)', () => {
  const acked = new Map([['a3', { alert_id: 'a3', acknowledged_by: 'pat', until: null }]]);
  Store.setTasks([task('1'), task('2'), task('3')], 'test');
  seed([
    alert('a1', { type: 'overlap', taskId: '1', peerId: '2', line: 'L1' }),
    alert('a2', { type: 'overlap', taskId: '2', peerId: '3', line: 'L1' }),
    alert('a3', { type: 'tool-conflict', taskId: '3', peerId: '1', line: 'L1' }),
    alert('o1', { type: 'overload', taskId: undefined, line: 'L1' }),
  ], { acked, showAcked: true });
  AlertMonitorPane.render();
  const [m] = openMenu('.am-group-menu', { groupKey: 'conflicts' });
  assert.deepEqual(m.opts, { align: 'end', key: 'conflicts' });
  assert.deepEqual(m.items.map(i => i.id), ['goto', 'move', 'open-table', 'ack']);
  assert.deepEqual(m.items.map(i => i.label), ['btn.go_to', 'am.group_fix_n', 'am.open_in_table', 'am.group_ack_n']);
  assert.equal(m.items[0].data.alertAction, 'focus');
  assert.equal(m.items[1].data.groupKey, 'conflicts');
  // overload is not movable: its group offers no Move
  const [cap] = openMenu('.am-group-menu', { groupKey: 'capacity' });
  assert.ok(!cap.items.some(i => i.id === 'move'));
  assert.match(section('conflicts'), /am-group-move[^>]*>am\.group_fix_n</);
  assert.doesNotMatch(section('capacity'), /group-move/);
});

test('group menu → Go to focuses the first alert with a Go to; Open these N orders fills the table filter', () => {
  const log = [];
  globalThis.NIMBUS = {
    AlertsUIAdapter: { focus: id => log.push(['focus', id]) },
    Table: { _onPoMatApply: () => log.push(['apply', els['tbl-flt-pomat-textarea'].value]) },
    App: { goto: tab => log.push(['goto', tab]), gotoGanttSub: sub => log.push(['sub', sub]) },
  };
  Store.setTasks([task('1'), task('2')], 'test');
  seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2', line: 'L1' })]);
  AlertMonitorPane.render();
  const items = openMenu('.am-group-menu', { groupKey: 'conflicts' })[0].items;
  items.find(i => i.id === 'goto').onSelect({});
  items.find(i => i.id === 'open-table').onSelect({});
  assert.deepEqual(log, [['focus', 'a1'], ['apply', '471\n472'], ['goto', 'gantt'], ['sub', 'orders']]);
});

test('Open in table falls back to a toast when the table filter is unavailable', () => {
  const toasts = [];
  const undo = patched(Toast, 'show', (m, k) => toasts.push([m, k]));
  globalThis.NIMBUS = {};
  try {
    Store.setTasks([task('1')], 'test');
    seed([alert('a1', { type: 'late', taskId: '1', line: 'L1' })]);
    AlertMonitorPane.render();
    openMenu('.am-group-menu', { groupKey: 'exceptions' })[0].items.find(i => i.id === 'open-table').onSelect({});
    assert.deepEqual(toasts, [['am.table_unavailable', 'warn']]);
  } finally { undo(); }
});

/** Seven movable alerts in one group (ids sort a1..a7 under the Date ranking, which breaks equal times by id). */
function seedBatch() {
  Store.setTasks([], 'test');
  seed([
    alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }),
    alert('a2', { type: 'overlap', taskId: '3', peerId: '1' }),        // its peer (1) moves first: skipped
    alert('a3', { type: 'tool-conflict', taskId: '2', peerId: '4' }),
    alert('a4', { type: 'overlap', taskId: '5', peerId: '6' }),        // applyFix refuses (firmed): not counted
    alert('a5', { type: 'overlap', taskId: '4', peerId: '9' }),
    alert('a6', { type: 'overlap', taskId: '7', peerId: '8' }),        // leaves Store.alerts while a1 is fixed: skipped
    alert('a7', { type: 'overlap', taskId: '1', peerId: '8' }),        // the same order as a1: skipped
  ], { view: { groupBy: 'category', sort: 'time' } });
}

/** Util.t that keeps the {{n}} count visible ("key|n=3"), so toast and confirm counts can be asserted. */
const nT = () => patched(Util, 't', (k, v) => (v && v.n !== undefined ? `${k}|n=${v.n}` : k));

function stubFix(fixes, { refuse = [], alsoGone = {} } = {}) {
  return patched(Alerts, 'applyFix', (id, opts) => {
    fixes.push([id, opts]);
    if (refuse.includes(id)) return;
    const gone = new Set([id, ...(alsoGone[id] ?? [])]);
    Store.setAlerts(Store.alerts.filter(a => !gone.has(a.id)), 'test');
  });
}

test('Move N orders confirms above five, then fixes sequentially and quietly, skipping stale alerts, and toasts once', async () => {
  const fixes = [], toasts = [], focused = [];
  const undo = [
    stubFix(fixes, { refuse: ['a4'], alsoGone: { a1: ['a6'] } }),
    patched(Toast, 'show', (m, k) => toasts.push([m, k])),
    patched(Modal, 'confirm', async o => { toasts.push(['confirm', o.title, o.message]); return true; }),
    nT(),
  ];
  try {
    seedBatch();
    AlertMonitorPane.render();
    globalThis.document.querySelectorAll = sel => (sel === '[data-am-action="toggle-group"]'
      ? [{ dataset: { groupKey: 'other' }, focus: () => focused.push('other') }, { dataset: { groupKey: 'conflicts' }, focus: () => focused.push('conflicts') }] : []);
    clickAm('group-move', { groupKey: 'conflicts' });
    await sleep(5);
    assert.deepEqual(toasts[0], ['confirm', 'am.group_fix_n|n=6', 'am.group_fix_confirm|n=6']);   // six distinct orders (7 alerts)
    assert.deepEqual(fixes.map(([id]) => id), ['a1', 'a3', 'a4', 'a5']);
    assert.ok(fixes.every(([, opts]) => opts.quiet === true && typeof opts.onBlocked === 'function'), 'quiet, with the batch blocked-counter');
    assert.deepEqual(toasts.slice(1), [['am.group_fix_done|n=3', 'success']], 'one summary toast naming the 3 distinct orders moved (orders 1, 2, 4)');
    assert.deepEqual(focused, ['conflicts'], 'focus returns to the group head');
  } finally { undo.forEach(u => u()); }
});

test('Move N orders: a declined confirmation moves nothing; five or fewer need no confirmation', async () => {
  const fixes = [], toasts = [];
  let ask = false, confirms = 0;
  const undo = [
    stubFix(fixes),
    patched(Toast, 'show', (m, k) => toasts.push([m, k])),
    patched(Modal, 'confirm', async () => { confirms++; return ask; }),
    nT(),
  ];
  try {
    seedBatch();
    AlertMonitorPane.render();
    clickAm('group-move', { groupKey: 'conflicts' });
    await sleep(5);
    assert.deepEqual([confirms, fixes, toasts], [1, [], []]);

    Store.setAlerts(Store.alerts.slice(0, 5), 'test');   // five alerts left: a1..a5
    AlertMonitorPane.render();
    clickAm('group-move', { groupKey: 'conflicts' });
    await sleep(5);
    assert.equal(confirms, 1, 'no confirmation at five');
    assert.deepEqual(fixes.map(([id]) => id), ['a1', 'a3', 'a4', 'a5']);
    assert.ok(fixes.every(([, opts]) => opts.quiet === true && typeof opts.onBlocked === 'function'), 'quiet, with the batch blocked-counter');
    assert.deepEqual(toasts, [['am.group_fix_done|n=4', 'success']]);
  } finally { undo.forEach(u => u()); }
});

test('Move N orders reads "1 order moved" at exactly one, and reports nothing moved when every fix is refused', async () => {
  const fixes = [], toasts = [];
  const undo = [stubFix(fixes, { refuse: ['b1', 'b2'] }), patched(Toast, 'show', (m, k) => toasts.push([m, k])), nT()];
  try {
    Store.setTasks([], 'test');
    seed([alert('b1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('b2', { type: 'overlap', taskId: '3', peerId: '1' })]);
    AlertMonitorPane.render();
    clickAm('group-move', { groupKey: 'conflicts' });
    await flush();
    assert.deepEqual(toasts, [['am.group_fix_done|n=0', 'warn']]);
    toasts.length = 0;
    undo[0]();
    undo[0] = stubFix(fixes);
    clickAm('group-move', { groupKey: 'conflicts' });
    await flush();
    assert.deepEqual(toasts, [['am.group_fix_done_one|n=1', 'success']], 'the second alert names an order the first one moved');
  } finally { undo.forEach(u => u()); }
});

test('"Move N orders" counts distinct orders: two alerts on one order do not make two', () => {
  Store.setTasks([], 'test');
  seed([alert('d1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('d2', { type: 'tool-conflict', taskId: '1', peerId: '3' })]);
  AlertMonitorPane.render();
  assert.doesNotMatch(section('conflicts'), /group-move/, 'one order: no batch button');
  const move = openMenu('.am-group-menu', { groupKey: 'conflicts' })[0].items.find(i => i.id === 'move');
  assert.ok(move, 'the menu still offers it for a single order');
});

test('a throw mid-batch is reported once; what moved is still summarised, the page repaints and focus returns to the head', async () => {
  const toasts = [], focused = [];
  let n = 0;
  const undo = [
    patched(Alerts, 'applyFix', id => {
      if (++n === 2) throw new Error('calendar blew up');
      Store.setAlerts(Store.alerts.filter(a => a.id !== id), 'test');
    }),
    patched(Toast, 'show', (m, k) => toasts.push([m, k])),
    nT(),
  ];
  try {
    Store.setTasks([], 'test');
    seed([alert('e1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('e2', { type: 'overlap', taskId: '3', peerId: '4' }),
      alert('e3', { type: 'overlap', taskId: '5', peerId: '6' })]);
    AlertMonitorPane.render();
    globalThis.document.querySelectorAll = sel => (sel === '[data-am-action="toggle-group"]'
      ? [{ dataset: { groupKey: 'conflicts' }, focus: () => focused.push('conflicts') }] : []);
    clickAm('group-move', { groupKey: 'conflicts' });
    await flush();
    assert.deepEqual(toasts, [['calendar blew up', 'error'], ['am.group_fix_done_one|n=1', 'success']]);
    assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-id="e1"/, 'repainted without the moved alert');
    assert.deepEqual(focused, ['conflicts']);
  } finally { undo.forEach(u => u()); }
});

/** A document whose ⋯ triggers are the given ids (focus calls are logged), plus the group head. */
function focusDoc(ids, log) {
  globalThis.document.querySelectorAll = sel => {
    if (sel === '[data-ovf-key]') return ids.map(id => ({ getAttribute: () => id, focus: () => log.push(id) }));
    if (sel === '[data-am-action="toggle-group"]') return [{ dataset: { groupKey: 'conflicts' }, focus: () => log.push('head') }];
    return [];
  };
}

test('after Fix from the ⋯ menu the row is gone: focus goes to the next row\'s trigger', async () => {
  const log = [];
  const undo = patched(Alerts, 'applyFix', id => { Store.setAlerts(Store.alerts.filter(a => a.id !== id), 'test'); });
  try {
    Store.setTasks([], 'test');
    seed([alert('f1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('f2', { type: 'overlap', taskId: '3', peerId: '4' })], { view: { groupBy: 'category', sort: 'time' } });
    AlertMonitorPane.render();
    focusDoc(['f2'], log);   // f1's trigger no longer exists after the repaint
    openMenu('.am-row-menu', { alertId: 'f1' })[0].items.find(i => i.id === 'fix').onSelect({});
    await flush();
    assert.deepEqual(log, ['f2']);
    log.length = 0;
    focusDoc([], log);       // the whole group emptied: fall back to the head
    openMenu('.am-row-menu', { alertId: 'f2' })[0].items.find(i => i.id === 'fix').onSelect({});
    await flush();
    assert.deepEqual(log, ['head']);
  } finally { undo(); }
});

test('after Remove acknowledgement the row\'s trigger gets focus back once the refetch has repainted', async () => {
  const log = [];
  const undo = patched(AlertAcksClient, 'unacknowledge', async () => {});
  try {
    Store.setTasks([], 'test');
    const acked = new Map([['g1', { alert_id: 'g1', acknowledged_by: 'pat', until: null }]]);
    seed([alert('g1', { type: 'overlap', taskId: '1', peerId: '2' })], { acked, showAcked: true });
    AlertMonitorPane.render();
    focusDoc(['g1'], log);
    openMenu('.am-row-menu', { alertId: 'g1' })[0].items.find(i => i.id === 'unack').onSelect({});
    assert.deepEqual(log, [], 'not before the request settles');
    await sleep(0);
    assert.deepEqual(log, ['g1']);
  } finally { undo(); }
});

test('Override and Acknowledge make the live trigger the focus owner BEFORE the modal opens (the modal then returns focus to it)', () => {
  const log = [];
  globalThis.NIMBUS = { Table: { _openOverrideModalForId: () => log.push('override-open') } };
  const undo = patched(AlertAckModal, 'open', () => log.push('ack-open'));
  try {
    Store.setTasks([task('1')], 'test');
    seed([alert('h1', { type: 'closed', taskId: '1' })]);
    AlertMonitorPane.render();
    focusDoc(['h1'], log);
    openMenu('.am-row-menu', { alertId: 'h1' })[0].items.find(i => i.id === 'override').onSelect({});
    openMenu('.am-row-menu', { alertId: 'h1' })[0].items.find(i => i.id === 'ack').onSelect({});
    assert.deepEqual(log, ['h1', 'override-open', 'h1', 'ack-open']);
  } finally { undo(); }
});

test('Move N orders is blocked under What-If (aria-disabled markup and handler) and overload is never moved', () => {
  const fixes = [];
  const undo = stubFix(fixes);
  try {
    seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('a2', { type: 'overlap', taskId: '3', peerId: '4' }),
      alert('o1', { type: 'overload', taskId: undefined }), alert('o2', { type: 'overload', taskId: undefined })]);
    Sandbox.active = true;
    AlertMonitorPane.render();
    assert.match(els['am-groups'].innerHTML, /class="btn sm am-group-move"[^>]*aria-disabled="true" title="am\.whatif_blocked"/);
    clickAm('group-move', { groupKey: 'conflicts' });
    assert.deepEqual(fixes, []);
    Sandbox.active = false;
    AlertMonitorPane.render();
    assert.doesNotMatch(els['am-groups'].innerHTML, /aria-disabled="true" title="am\.whatif_blocked"/);
    assert.doesNotMatch(section('capacity'), /group-move/, 'two overloads: not movable');
    clickAm('group-move', { groupKey: 'capacity' });
    assert.deepEqual(fixes, []);
  } finally { Sandbox.active = false; undo(); }
});

test('Acknowledge N… opens the ack modal in bulk mode with every un-acknowledged id of the whole group, past the row cap', () => {
  const opened = [];
  const undo = patched(AlertAckModal, 'open', o => opened.push(o));
  try {
    const many = Array.from({ length: 45 }, (_, i) => alert(`m${String(i).padStart(2, '0')}`, { type: 'overload', taskId: undefined }));
    const acked = new Map([['m00', { alert_id: 'm00', acknowledged_by: 'pat', until: null }], ['m01', { alert_id: 'm01', acknowledged_by: 'pat', until: null }]]);
    seed(many, { acked, showAcked: true });
    AlertMonitorPane.render();
    assert.equal((els['am-groups'].innerHTML.match(/class="am-rowwrap"/g) ?? []).length, 40, 'only 40 rows are rendered');
    const item = openMenu('.am-group-menu', { groupKey: 'capacity' })[0].items.find(i => i.id === 'ack');
    item.onSelect({});
    assert.equal(opened.length, 1);
    assert.equal(opened[0].plant, 'P1');
    assert.equal(opened[0].alertIds.length, 43);
    assert.ok(!opened[0].alertIds.includes('m00') && !opened[0].alertIds.includes('m01'));
    assert.ok(opened[0].alertIds.includes('m44'), 'an alert behind "Show all" is included');
    assert.equal(openMenu('.am-group-menu', { groupKey: 'capacity' })[0].items.find(i => i.id === 'ack').label, 'am.group_ack_n');
  } finally { undo(); }
});

test('group-by none uses ROW_H = 44 for the list and adds DIAG_H under an open diagnose', () => {
  const rowHs = [];
  const orig = VirtualList.prototype.update;
  VirtualList.prototype.update = function (items) { rowHs.push(items.map(a => this._getRowH(a))); return orig.call(this, items); };
  try {
    Store.setTasks([task('1')], 'test');
    seed([alert('a1', { type: 'late', taskId: '1' }), alert('a2', { type: 'overload', taskId: undefined })], { view: { groupBy: 'none', sort: 'time' } });
    globalThis.document.createElement = () => makeEl('inner');
    AlertMonitorPane.render();
    assert.equal(ROW_H, 44);
    assert.deepEqual(rowHs.at(-1), [44, 44]);
    clickAlert('diagnose', 'a1');
    assert.deepEqual(rowHs.at(-1), [44 + DIAG_H, 44]);
  } finally { VirtualList.prototype.update = orig; }
});

test('the diagnose panel opens with the alert type\'s help sentence as its first full-width line', () => {
  const priorLocales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.window.__NIMBUS_LOCALES = { en: { ...priorLocales.en, 'alert.help.late': 'The order finishes after its due date.' } };
  Store.setTasks([task('1')], 'test');
  seed([alert('a1', { type: 'late', taskId: '1' })]);
  AlertMonitorPane.render();
  clickAlert('diagnose', 'a1');
  assert.match(els['am-groups'].innerHTML, /<div class="am-diag"><p class="am-diag-help"[^>]*>The order finishes after its due date\.<\/p><dl class="am-diag-grid">/);
});

test('row Acknowledge and Remove acknowledgement live in the ⋯ menu; the row has no Acknowledge button', async () => {
  const log = [];
  const undo = [
    patched(AlertAckModal, 'open', o => log.push(['open', o.plant, o.alertId])),
    patched(AlertAcksClient, 'unacknowledge', async (plant, id) => { log.push(['unack', plant, id]); }),
  ];
  try {
    const acked = new Map([['a2', { alert_id: 'a2', acknowledged_by: 'pat', until: null }]]);
    seed([alert('a1'), alert('a2')], { acked, showAcked: true });
    AlertMonitorPane.render();
    assert.doesNotMatch(els['am-groups'].innerHTML, /data-alert-action="(ack|unack)"/);
    clickAlert('ack', 'a1');
    clickAlert('unack', 'a2');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(log, [['open', 'P1', 'a1'], ['unack', 'P1', 'a2']]);
  } finally { undo.forEach(u => u()); }
});

/* ---------------------------------------------------------------------------
   Slot (needs_planning): row button + ⋯ menu open the dialog; Diagnose shows the suggested slot
   ------------------------------------------------------------------------- */
import { AlertSlotModal } from '../../../frontend/alert-monitor/alert-slot-modal.mjs';

const npTask = id => task(id, { planning_status: 'needs_planning' });
const cand = (o = {}) => ({ label: '1001|L1', closed: false, needHours: 2, freeHours: 5, capHours: 8, fits: true, ...o });

test('Slot from the row button opens the dialog with the plant, the order and the alert id', () => {
  const opened = [];
  const undo = patched(AlertSlotModal, 'open', o => opened.push(o));
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    assert.match(els['am-groups'].innerHTML, /data-alert-action="slot" data-alert-id="n1"/);
    clickAlert('slot', 'n1', { taskId: '7' });
    assert.deepEqual(opened, [{ plant: 'P1', taskId: '7', alertId: 'n1' }]);
  } finally { undo(); }
});

test('Slot from the ⋯ menu refocuses the live trigger BEFORE the dialog opens, and opens with the same values', () => {
  const log = [];
  const undo = patched(AlertSlotModal, 'open', o => log.push(['open', o.plant, o.taskId, o.alertId]));
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    focusDoc(['n1'], log);
    const item = openMenu('.am-row-menu', { alertId: 'n1' })[0].items.find(i => i.id === 'slot');
    assert.ok(item, 'the menu offers Slot');
    assert.equal(item.data.alertAction, 'slot');
    item.onSelect({});
    assert.deepEqual(log, ['n1', ['open', 'P1', '7', 'n1']]);
  } finally { undo(); }
});

test('Slot is a no-op in What-If (button and menu), with the menu item disabled and hinted', () => {
  const opened = [];
  const undo = patched(AlertSlotModal, 'open', o => opened.push(o));
  Sandbox.active = true;
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    clickAlert('slot', 'n1', { taskId: '7' });
    const item = openMenu('.am-row-menu', { alertId: 'n1' })[0].items.find(i => i.id === 'slot');
    assert.equal(item.disabled, true);
    assert.equal(item.hint, 'am.whatif_blocked');
    item.onSelect({});
    assert.deepEqual(opened, []);
  } finally { Sandbox.active = false; undo(); }
});

test('Diagnose on a needs_planning row shows the suggested slot from suggest(), synchronously', () => {
  const asked = [];
  const undoDay = patched(AlertSlotModal, 'suggestedDay', () => '2026-10-28');
  const undoBase = patched(AlertSlotModal, 'suggest', (tk, plant) => { asked.push([tk.id, plant]); return cand(); });
  const undo = () => { undoBase(); undoDay(); };
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    assert.deepEqual(asked, [], 'a closed panel never asks for a suggestion');
    clickAlert('diagnose', 'n1');
    assert.match(els['am-groups'].innerHTML, /<dt>am\.slot_suggested<\/dt><dd[^>]*>am\.slot_suggested_on<\/dd>/);
    assert.deepEqual(asked[0], ['7', 'P1']);
  } finally { undo(); }
});

test('Diagnose names the day the suggestion is for: the default day, then the option text', () => {
  const undoSuggest = patched(AlertSlotModal, 'suggest', () => cand());
  const undoDay = patched(AlertSlotModal, 'suggestedDay', (tk, plant) => { assert.deepEqual([tk.id, plant], ['7', 'P1']); return '2026-10-28'; });
  const priorT = Util.t;
  Util.t = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    clickAlert('diagnose', 'n1');
    const html = els['am-groups'].innerHTML;
    const m = /<dt>am\.slot_suggested<\/dt><dd[^>]*>am\.slot_suggested_on(\{.*?\})<\/dd>/.exec(html.replace(/&quot;/g, '"'));
    assert.ok(m, 'the suggested line uses am.slot_suggested_on');
    const vars = JSON.parse(m[1]);
    assert.match(vars.day, /28/, 'the day label names the 28th');
    assert.match(vars.option, /^am\.slot_option/, 'the option text is formatSlotOption output');
  } finally { Util.t = priorT; undoDay(); undoSuggest(); }
});

test('Diagnose with no eligible pair shows the none text without a day prefix', () => {
  const undoSuggest = patched(AlertSlotModal, 'suggest', () => null);
  const undoDay = patched(AlertSlotModal, 'suggestedDay', () => { throw new Error('no day for no suggestion'); });
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    clickAlert('diagnose', 'n1');
    assert.match(els['am-groups'].innerHTML, /<dt>am\.slot_suggested<\/dt><dd[^>]*>am\.slot_none<\/dd>/);
  } finally { undoDay(); undoSuggest(); }
});

test('Diagnose shows the "no eligible machine" line when suggest() finds nothing', () => {
  const undo = patched(AlertSlotModal, 'suggest', () => null);
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
    clickAlert('diagnose', 'n1');
    assert.match(els['am-groups'].innerHTML, /<dt>am\.slot_suggested<\/dt><dd[^>]*>am\.slot_none<\/dd>/);
  } finally { undo(); }
});

test('Diagnose on other order alerts has no suggested-slot line and never asked suggest()', () => {
  const asked = [];
  const undo = patched(AlertSlotModal, 'suggest', tk => { asked.push(tk.id); return cand(); });
  try {
    Store.setTasks([task('1')], 'test');
    seed([alert('a1', { type: 'late', taskId: '1' })]);
    AlertMonitorPane.render();
    clickAlert('diagnose', 'a1');
    assert.match(els['am-groups'].innerHTML, /class="am-diag"/);
    assert.doesNotMatch(els['am-groups'].innerHTML, /am\.slot_suggested/);
    assert.deepEqual(asked, []);
  } finally { undo(); }
});

test('DIAG_H grew to 166 for the extra grid row', () => {
  assert.equal(DIAG_H, 166);
});

test('Move N orders: a fix that resolves false (refused, or cancelled at the tooling confirm) is not counted and the batch continues', async () => {
  const toasts = [], fixes = [];
  const undo = [
    patched(Alerts, 'applyFix', async id => {
      fixes.push(id);
      if (id === 'r1') return false;                       // refused: the alert stays
      Store.setAlerts(Store.alerts.filter(a => a.id !== id), 'test');
      return true;
    }),
    patched(Toast, 'show', (m, k) => toasts.push([m, k])),
    nT(),
  ];
  try {
    Store.setTasks([], 'test');
    seed([alert('r1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('r2', { type: 'overlap', taskId: '3', peerId: '4' }),
      alert('r3', { type: 'overlap', taskId: '5', peerId: '6' })]);
    AlertMonitorPane.render();
    clickAm('group-move', { groupKey: 'conflicts' });
    await flush();
    assert.deepEqual(fixes, ['r1', 'r2', 'r3'], 'the refused first fix did not stop the batch');
    assert.deepEqual(toasts, [['am.group_fix_done|n=2', 'success']], 'only the two applied fixes are counted');
  } finally { undo.forEach(u => u()); }
});

test('Move N orders: refused overload fixes raise ONE summary toast at the batch level, not one per alert', async () => {
  const toasts = [];
  const undo = [
    patched(Alerts, 'applyFix', async (id, opts) => {
      if (id !== 'm3') { opts.onBlocked(); return false; }   // r1, r2 refused (error finding); the quiet fix says nothing itself
      Store.setAlerts(Store.alerts.filter(a => a.id !== id), 'test');
      return true;
    }),
    patched(Toast, 'show', (m, k) => toasts.push([m, k])),
    nT(),
  ];
  try {
    Store.setTasks([], 'test');
    seed([alert('m1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('m2', { type: 'overlap', taskId: '3', peerId: '4' }),
      alert('m3', { type: 'overlap', taskId: '5', peerId: '6' })]);
    AlertMonitorPane.render();
    clickAm('group-move', { groupKey: 'conflicts' });
    await flush();
    assert.deepEqual(toasts, [['am.group_fix_done_one|n=1', 'success'], ['toast.fix_overload_blocked_batch|n=2', 'warn']]);
  } finally { undo.forEach(u => u()); }
});
