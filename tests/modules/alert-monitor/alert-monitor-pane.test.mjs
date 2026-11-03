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
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { AlertApiError } from '../../../frontend/insights/plant-lru.mjs';
import { makeEl } from '../helpers/dom-stub.mjs';
import { AlertProfileEditor } from '../../../frontend/alert-monitor/alert-profile-editor.mjs';
import { OverflowMenu } from '../../../frontend/platform/overflow-menu.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  prior.view = AlertProfileMatches.current;
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
    'am.edit_profile': 'Edit', 'am.view_profile': 'View rules',
  } };
  calls.session = []; calls.prefs = [];
  AlertProfileMatches.setSessionProfile = id => { calls.session.push(id); };
  Session.setPref = (k, v) => { calls.prefs.push([k, v]); Store.setUserSettings({ [k]: v }, 'settings-pref'); };   // like the real one: apply, then emit
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1', P9: 'z' } }, 'test');
  Store.setSelectedPlant('P1', 'test');
  Store.setAlerts([], 'test');
  Store.setTasks([], 'test');
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  globalThis.document = prior.doc;
  AlertProfileMatches.current = prior.view;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  AlertProfileClient.cached = prior.cached;
  Session.setPref = prior.setPref;
  Util.plantClock = prior.clock;
  globalThis.NIMBUS = prior.nimbus;
  globalThis.window.__NIMBUS_LOCALES = prior.locales;
});

test('no plant renders the select-a-plant empty state and the summary says only that', () => {
  Store.setSelectedPlant(null, 'test');
  AlertProfileMatches.current = () => ({ ...fakeMatches(), plant: null });
  AlertProfileClient.cached = () => null;
  AlertMonitorPane.render();
  assert.match(els['am-body'].innerHTML, /am\.empty_no_plant/);
  assert.equal(els['am-summary'].innerHTML, '<span>am.empty_no_plant</span>');
  assert.equal(els['am-profile-input'].disabled, true);
  assert.equal(els['am-edit'].hidden, true);
  assert.equal(els['am-make-default'].hidden, true);
});

test('setActive(false) suppresses the render that alerts:change would trigger', async () => {
  useProfiles([P1, P2], fakeMatches({ alertIds: new Set(['a1', 'a2']) }));
  Store.setAlerts([alert('a1')], 'test');
  AlertMonitorPane.render();
  assert.match(els['am-summary'].innerHTML, /1 alert at this plant/);

  AlertMonitorPane.setActive(false);
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(260);
  assert.match(els['am-summary'].innerHTML, /1 alert at this plant/, 'inactive pane must not repaint');

  AlertMonitorPane.setActive(true);
  Store.setAlerts([alert('a1'), alert('a2')], 'test');
  await sleep(260);
  assert.match(els['am-summary'].innerHTML, /2 alerts at this plant/);
});

/* ---------------------------------------------------------------------------
   Task 22 — page header: title, summary line, controls row
   ------------------------------------------------------------------------- */

test('the shell renders an h2 title, no KPI tiles, no category legend and no Manage profiles control', () => {
  useProfiles([P1], fakeMatches());
  AlertMonitorPane.render();
  const shell = els['alerts-tab'].innerHTML;
  assert.match(shell, /<h2 class="am-title">tab\.alerts<\/h2>/);
  assert.doesNotMatch(shell, /kpi-tile|am-kpi|am-cat-legend|am-toolbar/);
  assert.doesNotMatch(shell, /am\.manage_profiles|data-am-action="manage"/);
  assert.match(shell, /data-am-action="page-menu" data-ovf-key="page"/);
  assert.doesNotMatch(shell, /am-group-sel|am-overview|am-focus-chip|summary-conf|data-am-sort/);
  assert.match(shell, /data-am-set-view="inbox"[^>]*>am\.view_inbox</);
  assert.match(shell, /data-am-set-view="matrix"[^>]*>am\.view_matrix</);
  for (const l of ['machine', 'day', 'group']) assert.match(shell, new RegExp(`data-am-set-lens="${l}"[^>]*>am\\.lens_${l}<`));
  assert.match(shell, /id="am-search" data-am-search/);
  assert.match(shell, /id="am-chips"[^>]* hidden/);
  assert.match(shell, /class="am-profile-blk"/);
  assert.match(shell, /am\.profile_label/);
  assert.match(shell, /am-filter-strip" id="am-chips" hidden/);
  for (const l of ['machine', 'day', 'group']) assert.match(shell, new RegExp(`class="seg-btn am-seg-outline" data-am-set-lens="${l}"`));
  for (const v of ['inbox', 'matrix']) assert.doesNotMatch(shell, new RegExp(`class="seg-btn[^"]*am-seg-outline[^"]*" data-am-set-view="${v}"`));
  assert.match(shell, /id="am-body"/);
});

test('the profile picker lists the profiles only (no "+ New profile…" row) and shows "No matches" when a search finds none', () => {
  useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
  AlertMonitorPane.render();
  const input = els['am-profile-input'], dd = els['am-profile-dropdown'];
  input.value = '';
  input.handlers.input();
  assert.match(dd.innerHTML, /data-profile="__all__"[\s\S]*data-profile="p1"[\s\S]*data-profile="p2"/);
  assert.doesNotMatch(dd.innerHTML, /am-opt-new|__new__|am-opt-scroll|new_profile/);
  input.value = 'late';
  input.handlers.input();
  assert.doesNotMatch(dd.innerHTML, /data-profile="p1"/);
  assert.match(dd.innerHTML, /data-profile="p2"/);
  input.value = 'zzz';
  input.handlers.input();
  assert.match(dd.innerHTML, /us.no_matches/);
  assert.doesNotMatch(dd.innerHTML, /data-profile=|am-opt-new/);
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

test('Enter on a search with no matches does nothing; ids that are not options never become the active profile', () => {
  const opened = [];
  const undo = patched(AlertProfileEditor, 'open', o => opened.push(o));
  try {
    useProfiles([P1, P2], fakeMatches({ profileId: 'p1', profile: P1 }));
    AlertMonitorPane.render();
    const input = els['am-profile-input'];
    input.value = 'zzz';
    input.handlers.input();
    input.handlers.keydown({ key: 'Enter', preventDefault() {} });
    const pick = id => els['am-profile-dropdown'].handlers.mousedown({ preventDefault() {}, target: { closest: () => ({ dataset: { profile: id } }) } });
    pick('__new__');
    pick('bogus');
    assert.deepEqual(opened, []);
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
    AlertProfileMatches.current = () => fakeMatches({ profileId: 'p1', profile: mine });
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].hidden, false);
    assert.equal(els['am-edit'].textContent, 'Edit');
    clickAm('edit-profile');
    assert.deepEqual(opened, [{ plant: 'P1', profileId: 'p1' }]);

    const theirs = { ...P1, created_by: 'sam' };
    AlertProfileClient.cached = () => [theirs];
    AlertProfileMatches.current = () => fakeMatches({ profileId: 'p1', profile: theirs });
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].textContent, 'View rules');
    Session.isAdmin = () => true;
    AlertMonitorPane.render();
    assert.equal(els['am-edit'].textContent, 'Edit');
  } finally { undo.forEach(u => u()); }
});

test('the ⋯ page menu holds only New profile… (plain, no Show acknowledged: that is a profile setting); it opens the editor', () => {
  const seen = [];
  const opened = [];
  const undo = [
    patched(OverflowMenu, 'open', (anchor, items, opts) => { seen.push({ anchor, items, opts }); return { close() {} }; }),
    patched(AlertProfileEditor, 'open', o => opened.push(o)),
  ];
  try {
    useProfiles([P1], fakeMatches());
    AlertMonitorPane.render();
    clickAm('page-menu');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].opts, { align: 'end', key: 'page' });
    assert.deepEqual(seen[0].items.map(i => [i.id, i.checked]), [['create-profile', undefined]]);
    assert.equal(seen[0].items[0].disabled, false);
    seen[0].items[0].onSelect(seen[0].items[0]);
    assert.deepEqual(opened, [{ plant: 'P1', fromPicker: true }]);
    assert.deepEqual(calls.prefs, [], 'no acknowledgement pref is written');
  } finally { undo.forEach(u => u()); }
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
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1', P9: 'z' } }, 'test');   // the stub applied the write; start the next part from the old default

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
  assert.match(els['am-body'].innerHTML, /am\.empty_no_match_title/);
  clickAm('switch-all');
  assert.deepEqual(calls.session, [ALL_ALERTS_PROFILE_ID]);
});

test('no alerts at all shows the all-clear state; no profiles adds the create-profile prompt', () => {
  useProfiles([], fakeMatches());
  AlertMonitorPane.render();
  assert.match(els['am-body'].innerHTML, /empty\.no_active_alerts/);
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

const task = (id, o = {}) => ({
  id, ORDER: `47${id}`, PLANT: 'P1', MACHINE: 'L1', MATERIAL_NUMBER: `M${id}`,
  original_end_date: new Date('2026-10-21T08:00:00'), end_date: new Date('2026-10-22T08:00:00'), ...o,
});

function seed(alerts, { matched, acked, view, showAcked } = {}) {
  Store.setAlerts(alerts, 'test');
  Store.setUserSettings({
    alertProfileByPlant: { P1: 'p1' },
    // The page defaults to Machine grouping; the list tests below are about the category cards, so they store that.
    alertMonitorView: { __all__: view ?? { groupBy: 'category' } },
  }, 'test');
  useProfiles([P1], fakeMatches({ alertIds: new Set(matched ?? alerts.map(a => a.id)), acked,
    profile: showAcked ? { ...ALL_ALERTS_PROFILE, show_acknowledged: true } : undefined }));
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

test('nothing the page renders says points, pts, exact or estimate', () => {
  Store.setTasks([task('1'), task('2')], 'test');
  seed([alert('a1', { type: 'overlap', taskId: '1', peerId: '2' }), alert('a2', { type: 'closed', taskId: '2' }), alert('a3', { type: 'overload', taskId: undefined, line: 'L1' })]);
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-body'].innerHTML + els['am-summary'].innerHTML, /points|pts|exact|estimate/i);
});


/* ---------------------------------------------------------------------------
   Task 24 — ⋯ menus, group "Move N orders", bulk acknowledge, the group-by none list
   ------------------------------------------------------------------------- */
import { AlertAckModal } from '../../../frontend/alert-monitor/alert-ack-modal.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';

const clickMenu = (selector, dataset) => els['alerts-tab'].handlers.click({ target: { closest: sel => (sel === selector ? { dataset } : null) } });

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
    pick('a1', 'diagnose');   // an order alert opens its inline detail (no panel markup in the shell)
  } finally { undo.forEach(u => u()); }
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


/** Seven movable alerts in one group (ids sort a1..a7 under the Date ranking, which breaks equal times by id). */




/** A document whose ⋯ triggers are the given ids (focus calls are logged), plus the group head. */
function focusDoc(ids, log) {
  globalThis.document.querySelectorAll = sel => {
    if (sel === '[data-ovf-key]') return ids.map(id => ({ getAttribute: () => id, focus: () => log.push(id) }));
    if (sel === '[data-am-action="toggle-group"]') return [{ dataset: { groupKey: 'conflicts' }, focus: () => log.push('head') }];
    return [];
  };
}

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

test('Remove acknowledgement refused with a 403 (someone else\'s) toasts the not-owner text, not the raw server message', async () => {
  const toasts = [];
  const undo = [
    patched(AlertAcksClient, 'unacknowledge', async () => { throw new AlertApiError('Forbidden', 'Only the owner', 403); }),
    patched(Toast, 'show', (msg, type) => { toasts.push([msg, type]); }),
  ];
  try {
    Store.setTasks([], 'test');
    const acked = new Map([['g1', { alert_id: 'g1', acknowledged_by: 'pat', until: null }]]);
    seed([alert('g1', { type: 'overlap', taskId: '1', peerId: '2' })], { acked, showAcked: true });
    AlertMonitorPane.render();
    openMenu('.am-row-menu', { alertId: 'g1' })[0].items.find(i => i.id === 'unack').onSelect({});
    await sleep(0);
    assert.deepEqual(toasts, [['am.ack_err_not_owner', 'error']]);
  } finally { undo.forEach(u => u()); }
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
    assert.doesNotMatch(els['am-body'].innerHTML, /data-alert-action="(ack|unack)"/);
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

test('Slot from the row button opens the dialog with the plant, the order and the alert id', () => {
  const opened = [];
  const undo = patched(AlertSlotModal, 'open', o => opened.push(o));
  try {
    Store.setTasks([npTask('7')], 'test');
    seed([alert('n1', { type: 'needs_planning', taskId: '7' })]);
    AlertMonitorPane.render();
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
