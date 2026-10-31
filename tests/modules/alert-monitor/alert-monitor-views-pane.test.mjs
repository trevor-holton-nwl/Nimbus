// W6b: the Inbox | Matrix page — view and lens persistence, matrix click wiring, the side list, chips, Inbox facets and
// virtualized list, Show on Gantt ordering, filter lifetime. Stubbed document (tests/modules/helpers/dom-stub.mjs).
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
let els, created, prefs, log;
const D1 = '2026-10-21', D2 = '2026-10-22';
const alert = (id, o = {}) => ({ id, sev: 'err', type: 'overlap', msg: '', line: 'M1', time: new Date(`${D1}T08:00:00`), taskId: `T-${id}`, ...o });
const ALERTS = () => [
  alert('a1'), alert('a2', { sev: 'warn', type: 'late' }),
  alert('a3', { sev: 'warn', type: 'late', line: 'M2', time: new Date(`${D2}T08:00:00`) }),
  alert('a4', { type: 'overload', line: 'M4', time: new Date(`${D2}T08:00:00`) }),
];
const matches = (alerts, o = {}) => ({
  plant: 'P1', profileId: o.profileId ?? ALL_ALERTS_PROFILE_ID, profile: o.profile ?? ALL_ALERTS_PROFILE,
  alertIds: new Set(alerts.map(a => a.id)), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(),
  acked: new Map(), rev: 1, focusIds: o.focusIds ?? null,
});

function setup(alerts, { settings = {}, view = null } = {}) {
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' }, alertsShowAcknowledged: false, alertMonitorView: null, ...settings }, 'test');
  Store._linesByPlant = { P1: ['M1', 'M2', 'M3', 'M4'] };
  Store._masterLinesByPlant = { P1: [
    { machine: 'M1', wc_group: 'A' }, { machine: 'M2', wc_group: 'A' }, { machine: 'M3', wc_group: 'A' }, { machine: 'M4', wc_group: 'B' },
  ] };
  Store.setAlerts(alerts, 'test');
  AlertProfileMatches.view = () => view ?? matches(alerts);
}

beforeEach(() => {
  els = {}; created = []; prefs = []; log = [];
  for (const k of ['doc', 'view', 'setSession', 'cached', 'setPref', 'clock', 'nimbus', 'focusIds']) prior[k] = undefined;
  prior.doc = globalThis.document; prior.view = AlertProfileMatches.view; prior.cached = AlertProfileClient.cached;
  prior.setPref = Session.setPref; prior.clock = Util.plantClock; prior.nimbus = globalThis.NIMBUS;
  prior.focus = AlertProfileMatches.setFocusTaskIds; prior.locales = globalThis.window.__NIMBUS_LOCALES;
  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { const e = makeEl('created'); created.push(e); return e; },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  globalThis.window.__NIMBUS_LOCALES = { en: {
    'am.summary_all': '{{n}} alerts at this plant', 'am.summary_all_one': '1 alert at this plant',
    'am.summary_errors': '{{e}} errors', 'am.summary_errors_one': '1 error',
  } };
  AlertProfileClient.cached = () => [];
  Session.setPref = (k, v) => { prefs.push([k, v]); };
  AlertProfileMatches.setFocusTaskIds = ids => { log.push(['outline', ids ? [...ids].sort() : null]); };
  Util.plantClock = () => new Date('2026-10-20T08:00:00');
  Store.setSelectedPlant('P1', 'test');
  Store.setTasks([], 'test');
  AlertMonitorPane.resetView();
  AlertMonitorPane.init();
});

afterEach(() => {
  AlertMonitorPane.setActive(false);
  globalThis.document = prior.doc;
  AlertProfileMatches.view = prior.view; AlertProfileMatches.setFocusTaskIds = prior.focus;
  AlertProfileClient.cached = prior.cached; Session.setPref = prior.setPref; Util.plantClock = prior.clock;
  globalThis.NIMBUS = prior.nimbus; globalThis.window.__NIMBUS_LOCALES = prior.locales;
  Store._linesByPlant = {}; Store._masterLinesByPlant = {};
});

const click = map => els['alerts-tab'].handlers.click({ target: { closest: sel => map[sel] ?? null } });
const clickCell = (row, col) => click({ '[data-am-cell]': { dataset: { amCell: `${row}|${col}`, amRow: row, amCol: col } } });
const clickRowh = row => click({ '.am-mx-rowh': { dataset: { amRow: row } } });
const clickColh = col => click({ '.am-mx-colh': { dataset: { amCol: col } } });
const clickAm = (action) => click({ '[data-am-action]': { dataset: { amAction: action } } });
const clickFacet = v => click({ '[data-am-facet]': { dataset: { amFacet: v } } });
const side = () => els['am-side'].innerHTML;
const ids = html => [...html.matchAll(/class="am-xrow[^"]*"[^>]*data-alert-id="([^"]+)"/g)].map(m => m[1]).sort();
const INBOX = { alertMonitorView: { '*': { view: 'inbox' } } };

test('the view and lens buttons write alertMonitorView["*"] read-modify-write, keeping other keys', () => {
  setup(ALERTS(), { settings: { alertMonitorView: { '*': { view: 'matrix' }, p1: { groupBy: 'day' } } } });
  AlertMonitorPane.render();
  click({ '[data-am-set-view]': { dataset: { amSetView: 'inbox' } } });
  assert.deepEqual(prefs.at(-1), ['alertMonitorView', { '*': { view: 'inbox' }, p1: { groupBy: 'day' } }]);
  click({ '[data-am-set-lens]': { dataset: { amSetLens: 'group' } } });
  assert.deepEqual(prefs.at(-1)[1]['*'], { view: 'matrix', lens: 'group' });
});

test('Matrix is the default view; the lens decides the chart; the static controls are never re-rendered', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  assert.match(els['am-body'].innerHTML, /id="am-mx"/);
  assert.match(els['am-mx'].innerHTML, /am-mx-table/);
  assert.match(els['am-mx'].innerHTML, /am\.mx_corner_machine/);
  const shellWrites = els['alerts-tab'].writes;
  AlertMonitorPane.render();
  assert.equal(els['alerts-tab'].writes, shellWrites, 'the shell (search box, segmented controls, chips) is built once');
  setup(ALERTS(), { settings: { alertMonitorView: { '*': { lens: 'day' } } } });
  AlertMonitorPane.render();
  assert.match(els['am-mx'].innerHTML, /am\.mx_corner_day/);
});

test('a cell click sets the filter, shows the side list, and clicking it again clears it', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  assert.equal(els['am-side'].hidden, true, 'no filter, no side list');
  clickCell('M1', D1);
  assert.equal(els['am-side'].hidden, false);
  assert.deepEqual(ids(side()), ['a1', 'a2']);
  assert.match(side(), /am\.in_view/);
  assert.match(els['am-chips'].innerHTML, /data-am-chip="machines:M1"/);
  assert.match(els['am-chips'].innerHTML, new RegExp(`data-am-chip="days:${D1}"`));
  assert.match(els['am-summary'].innerHTML, /summary_showing/);
  clickCell('M1', D1);
  assert.equal(els['am-side'].hidden, true);
  assert.equal(els['am-chips'].hidden, true);
});

test('row, column and group roll-up headers set their own dimensions; another click replaces them', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  clickRowh('M2');
  assert.deepEqual(ids(side()), ['a3']);
  clickColh(D2);                                     // AND with the machine
  assert.deepEqual(ids(side()), ['a3']);
  clickRowh('M4');                                   // replaces the machine, keeps the day
  assert.deepEqual(ids(side()), ['a4']);
  clickColh(D2);                                     // the current day again: clears just the day
  assert.deepEqual(ids(side()), ['a4']);
  assert.doesNotMatch(els['am-chips'].innerHTML, /data-am-chip="days:/);
  clickAm('clear-filter');
  clickRowh('wc:A');
  assert.deepEqual(ids(side()), ['a1', 'a2', 'a3']);
  assert.match(els['am-chips'].innerHTML, /data-am-chip="wcGroups:A"/);
});

test('the group caret collapses a work-center group (per lens) and the quiet fold shows the machines with no alerts', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  assert.match(els['am-mx'].innerHTML, /data-am-row="M1"/);
  assert.doesNotMatch(els['am-mx'].innerHTML, /data-am-row="M3"/, 'M3 has no alerts: folded');
  assert.match(els['am-mx'].innerHTML, /data-am-quiet="A"/);
  click({ '[data-am-quiet]': { dataset: { amQuiet: 'A' } } });
  assert.match(els['am-mx'].innerHTML, /data-am-row="M3"/);
  click({ '.am-mx-caret': { dataset: { amGroup: 'A' } } });
  assert.doesNotMatch(els['am-mx'].innerHTML, /data-am-row="M1"/);
  click({ '.am-mx-caret': { dataset: { amGroup: 'A' } } });
  assert.match(els['am-mx'].innerHTML, /data-am-row="M1"/);
});

test('a chip ✕ removes one value; the search box is a filter dimension; Clear removes everything', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  clickCell('M1', D1);
  click({ '[data-am-chip]': { dataset: { amChip: `days:${D1}` } } });
  assert.deepEqual(ids(side()), ['a1', 'a2']);
  els['alerts-tab'].handlers.input({ target: { closest: sel => (sel === '[data-am-search]' ? { value: 'overload' } : null) } });
  assert.deepEqual(ids(side()), [], 'M1 has no overload alert');
  assert.match(els['am-chips'].innerHTML, /data-am-chip="q:overload"/);
  clickAm('clear-filter');
  assert.equal(els['am-side'].hidden, true);
  assert.equal(els['am-chips'].hidden, true);
});

test('more than 80 alerts in view: the side list caps at 80 and offers "Open all N in Inbox"', () => {
  const many = Array.from({ length: 90 }, (_, i) => alert(`b${i}`));
  setup(many);
  AlertMonitorPane.render();
  clickRowh('M1');
  assert.equal(ids(side()).length, 80);
  assert.match(side(), /data-am-action="open-inbox"/);
  clickAm('open-inbox');
  assert.deepEqual(prefs.at(-1)[1]['*'], { view: 'inbox' });
});

test('Inbox: facets list groups, days and categories; choosing one group lists its machines; a facet toggles its dimension', () => {
  setup(ALERTS(), { settings: INBOX });
  AlertMonitorPane.render();
  const f = () => els['am-ib-facets'].innerHTML;
  assert.match(f(), /data-am-facet="wcGroups:A"/);
  assert.match(f(), /data-am-facet="wcGroups:B"/);
  assert.match(f(), new RegExp(`data-am-facet="days:${D1}"`));
  assert.match(f(), /data-am-facet="categories:late"/);
  assert.doesNotMatch(f(), /data-am-facet="machines:/, 'machines show only once exactly one group is chosen');
  clickFacet('wcGroups:A');
  assert.match(f(), /data-am-facet="machines:M1"/);
  assert.doesNotMatch(f(), /data-am-facet="machines:M4"/);
  assert.doesNotMatch(f(), /chip/, 'machines are a list, never chips');
  clickFacet('machines:M2');
  assert.match(els['am-ib-bar'].innerHTML, /am\.in_view/);
  clickFacet('wcGroups:B');                          // two groups: the machine facet no longer applies and its choice is dropped
  assert.doesNotMatch(f(), /data-am-facet="machines:/);
  assert.doesNotMatch(els['am-chips'].innerHTML, /machines:/);
});

test('Inbox: one virtualized list of compact rows; Enter opens one detail at a time, and only the open row is taller', () => {
  setup(ALERTS(), { settings: INBOX });
  AlertMonitorPane.render();
  const vl = created.find(e => /am-xwrap/.test(e.innerHTML));
  assert.ok(vl, 'rows render through a VirtualList');
  assert.deepEqual(ids(vl.innerHTML), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(AlertMonitorPane._rowH({ id: 'a1' }), 32);
  const key = id => els['alerts-tab'].handlers.keydown({ key: 'Enter', preventDefault() {}, target: rowEl(id) });
  const rowEl = id => { const r = { dataset: { alertId: id }, getAttribute: () => id, closest: s => (s === '.am-xrow' ? r : null) }; return r; };
  key('a1');
  assert.equal(AlertMonitorPane._rowH({ id: 'a1' }), 118, '32 + the detail block for the 2 lines rendered (no task in the Store: no due / finish / firming)');
  assert.equal(AlertMonitorPane._rowH({ id: 'a2' }), 32);
  assert.match(vl.innerHTML, /am-xdetail/);
  key('a2');
  assert.equal(AlertMonitorPane._rowH({ id: 'a1' }), 32, 'one open row at a time');
  assert.equal(AlertMonitorPane._rowH({ id: 'a2' }), 118);
  key('a2');
  assert.equal(AlertMonitorPane._rowH({ id: 'a2' }), 32, 'Enter again closes it');
});

test('Show on Gantt outlines the orders FIRST, then jumps to the first alert with a line and time', () => {
  setup(ALERTS());
  globalThis.NIMBUS = { AlertsUIAdapter: { focus: id => log.push(['focus', id]) } };
  AlertMonitorPane.render();
  clickRowh('M2');
  clickAm('show-gantt');
  assert.deepEqual(log, [['outline', ['T-a3']], ['focus', 'a3']]);
});

test('the R2 chip reads what the Gantt outlines and Clear drops the request', () => {
  setup(ALERTS(), { view: matches(ALERTS(), { focusIds: new Set(['T-a1', 'T-a2']) }) });
  AlertMonitorPane.render();
  assert.equal(els['am-gantt-chip'].hidden, false);
  assert.match(els['am-gantt-chip'].innerHTML, /am\.gantt_outline/);
  clickAm('clear-outline');
  assert.deepEqual(log.at(-1), ['outline', null]);
});

test('the filter resets on a plant change and survives a profile change', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  clickCell('M1', D1);
  assert.equal(els['am-chips'].hidden, false);
  const prof = { id: 'p2', plant: 'P1', name: 'Other', description: '', ranking: 'impact', rules: [], created_by: null, updated_at: null };
  AlertProfileMatches.view = () => matches(ALERTS(), { profileId: 'p2', profile: prof });
  AlertMonitorPane.render();
  assert.equal(els['am-chips'].hidden, false, 'a profile change keeps the narrowed machines and days');
  Store.setSelectedPlant('P2', 'test');
  AlertProfileMatches.view = () => ({ ...matches(ALERTS()), plant: 'P2' });
  AlertMonitorPane.render();
  assert.equal(els['am-chips'].hidden, true, 'a plant change resets it');
});

test('the global machine filter (Store.selectedLines) narrows the view without being replaced', () => {
  setup(ALERTS(), { settings: INBOX });
  const set = Store.selectedLines;
  set.add('M4');
  try {
    AlertMonitorPane.render();
    assert.equal(Store.selectedLines, set, 'the Set is read, never replaced');
    const vl = created.find(e => /am-xwrap/.test(e.innerHTML));
    assert.deepEqual(ids(vl.innerHTML), ['a4']);
  } finally { set.clear(); }
});

// ---- Fix round 1 ----
import { VirtualList, Toast } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';

test('the matrix scroll box receives --am-mx-head-h (the measured header height) after a paint', () => {
  setup(ALERTS());
  const props = {};
  const box = makeEl('box');
  box.style = { setProperty: (k, v) => { props[k] = v; } };
  els['am-mx'] = makeEl('am-mx');
  els['am-mx'].querySelector = sel => (sel === 'thead tr' ? { offsetHeight: 31 } : sel === '.am-mx-scroll' ? box : null);
  AlertMonitorPane.render();
  assert.equal(props['--am-mx-head-h'], '31px');
});

test('the summary says "N lines selected" while the global line filter is active, and not otherwise', () => {
  setup(ALERTS());
  AlertMonitorPane.render();
  assert.doesNotMatch(els['am-summary'].innerHTML, /lines_selected/);
  const set = Store.selectedLines;
  set.add('M1');
  try {
    AlertMonitorPane.render();
    assert.match(els['am-summary'].innerHTML, /am\.lines_selected_one/);
    set.add('M2');
    AlertMonitorPane.render();
    assert.match(els['am-summary'].innerHTML, /am\.lines_selected(?!_one)/);
    assert.doesNotMatch(els['am-summary'].innerHTML, /<button/, 'read-only: no remove control');
  } finally { set.clear(); }
});

test('Inbox: a filter change scrolls the list to the top and closes a detail whose alert left the view', () => {
  setup(ALERTS(), { settings: INBOX });
  const proto = VirtualList.prototype;
  const prev = proto.scrollToTop;
  let tops = 0;
  proto.scrollToTop = function () { tops++; };
  try {
    AlertMonitorPane.render();
    const rowEl = { dataset: { alertId: 'a1' }, getAttribute: () => 'a1', closest: s => (s === '.am-xrow' ? rowEl : null) };
    els['alerts-tab'].handlers.keydown({ key: 'Enter', preventDefault() {}, target: rowEl });
    assert.equal(AlertMonitorPane._rowH({ id: 'a1' }), 118);
    const before = tops;
    els['alerts-tab'].handlers.input({ target: { closest: sel => (sel === '[data-am-search]' ? { value: 'overload' } : null) } });
    assert.equal(tops, before + 1);
    assert.equal(AlertMonitorPane._rowH({ id: 'a1' }), 32, 'a1 is not in the view any more: its detail is closed');
  } finally { proto.scrollToTop = prev; }
});

test('Move N acts on the alerts in view: quiet sequential fixes, one summary toast', async () => {
  setup(ALERTS());
  const toasts = [];
  const prevFix = Alerts.applyFix, prevToast = Toast.show;
  Alerts.applyFix = async (id, opts) => { log.push(['fix', id, opts?.quiet]); Store.setAlerts(Store.alerts.filter(x => x.id !== id), 'test'); return true; };
  Toast.show = (m) => { toasts.push(m); };
  try {
    AlertMonitorPane.render();
    clickRowh('M1');                                  // a1 (overlap, movable) and a2 (late)
    clickAm('move-view');
    for (let i = 0; i < 25; i++) await Promise.resolve();
    assert.deepEqual(log.filter(x => x[0] === 'fix'), [['fix', 'a1', true]]);
    assert.equal(toasts.length, 1);
  } finally { Alerts.applyFix = prevFix; Toast.show = prevToast; }
});

// ---- the resizable side list ----------------------------------------------------------------------------------

function trackWidth() {
  const calls = [];
  els['am-body'] = makeEl('am-body');
  els['am-body'].style.setProperty = (k, v) => calls.push([k, v]);
  return calls;
}
const lastVar = calls => calls.filter(c => c[0] === '--am-side-w').at(-1)?.[1];

test('the side list handle: in the shell, hidden until a filter shows the list', () => {
  setup(ALERTS(), { settings: { alertMonitorSideWidth: null } });
  trackWidth();
  AlertMonitorPane.render();
  assert.match(els['am-body'].innerHTML, /id="am-side-rh" role="separator" aria-orientation="vertical"/);
  assert.equal(els['am-side-rh'].hidden, true);
  clickCell('M1', D1);
  assert.equal(els['am-side-rh'].hidden, false);
  clickCell('M1', D1);
  assert.equal(els['am-side-rh'].hidden, true);
});

test('the side width comes from alertMonitorSideWidth, clamped, default 660', () => {
  for (const [stored, want] of [[700, '700px'], [5000, '900px'], [undefined, '660px']]) {
    els = {};
    setup(ALERTS(), { settings: { alertMonitorSideWidth: stored ?? null } });
    const calls = trackWidth();
    AlertMonitorPane.render();
    assert.equal(lastVar(calls), want);
    assert.equal(els['am-side-rh'].getAttribute('aria-valuenow'), want.replace('px', ''));
  }
});

test('keyboard: Shift+ArrowLeft widens by 64, Home / End jump, double-click resets to the default', () => {
  setup(ALERTS(), { settings: { alertMonitorSideWidth: null } });
  const calls = trackWidth();
  AlertMonitorPane.render();
  const h = els['am-side-rh'];
  h.handlers.keydown({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
  assert.deepEqual(prefs.at(-1), ['alertMonitorSideWidth', 724]);
  assert.equal(lastVar(calls), '724px');
  h.handlers.keydown({ key: 'Home', preventDefault() {} });
  assert.deepEqual(prefs.at(-1), ['alertMonitorSideWidth', 380]);
  h.handlers.keydown({ key: 'End', preventDefault() {} });
  assert.deepEqual(prefs.at(-1), ['alertMonitorSideWidth', 900]);
  h.handlers.dblclick({});
  assert.deepEqual(prefs.at(-1), ['alertMonitorSideWidth', null]);
  assert.equal(lastVar(calls), '660px');
});

test('drag: live width while moving, exactly one saved write on release', () => {
  setup(ALERTS(), { settings: { alertMonitorSideWidth: null } });
  const calls = trackWidth();
  AlertMonitorPane.render();
  const h = els['am-side-rh'];
  const before = prefs.length;
  h.handlers.pointerdown({ clientX: 1000, pointerId: 1, preventDefault() {} });
  h.handlers.pointermove({ clientX: 900 });
  assert.equal(lastVar(calls), '760px');
  assert.equal(prefs.length, before, 'no write while dragging');
  h.handlers.pointerup({ pointerId: 1 });
  assert.deepEqual(prefs.slice(before), [['alertMonitorSideWidth', 760]]);
});

test('Inbox then Matrix re-applies the stored width', () => {
  setup(ALERTS(), { settings: { alertMonitorSideWidth: 700 } });
  const calls = trackWidth();
  AlertMonitorPane.render();
  click({ '[data-am-set-view]': { dataset: { amSetView: 'inbox' } } });
  setup(ALERTS(), { settings: { alertMonitorSideWidth: 700, alertMonitorView: { '*': { view: 'matrix' } } } });
  calls.length = 0;
  AlertMonitorPane.render();
  assert.equal(lastVar(calls), '700px');
});
