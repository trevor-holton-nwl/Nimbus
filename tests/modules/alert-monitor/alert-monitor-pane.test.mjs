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
