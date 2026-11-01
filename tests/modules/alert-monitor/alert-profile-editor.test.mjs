// Tests for frontend/alert-monitor/alert-profile-editor.mts: the pure helpers (category tri-state, delete
// permission, draft round trip, unique copy names, live day range, live match count) and the modal DOM
// against a stubbed document (inline validation keys, creator/admin Delete gate, create vs update,
// server 409 mapping, set-as-mine read-modify-write, never-firing types hidden).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AlertProfileEditor, categoryCheckState, canDeleteProfile, draftFromProfile, profileFromDraft,
  uniqueCopyName, liveRange, liveMatchCount, blankDraft, tunedCategories, dayPresetOf, dayPresetRange, editorSeams,
} from '../../../frontend/alert-monitor/alert-profile-editor.mjs';
import { OverflowMenu } from '../../../frontend/platform/overflow-menu.mjs';
import { ALERT_CATEGORY_ORDER, DEFAULT_CATEGORY_COLORS, PALETTE } from '../../../frontend/insights/alert-profiles.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { AlertProfileMatches } from '../../../frontend/insights/alert-profile-matches.mjs';
import { AlertApiError } from '../../../frontend/insights/plant-lru.mjs';
import { FIRING_ALERT_TYPES } from '../../../frontend/insights/alert-profiles.mjs';
import { Session } from '../../../frontend/security/session.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Modal, Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};

// ---- pure helpers ----------------------------------------------------------------------------

test('categoryCheckState is all / some / none', () => {
  const cat = ['overlap', 'tool-conflict', 'distribution-separation'];
  assert.equal(categoryCheckState(cat, []), 'none');
  assert.equal(categoryCheckState(cat, ['overlap']), 'some');
  assert.equal(categoryCheckState(cat, new Set(cat)), 'all');
  assert.equal(categoryCheckState(cat, ['late']), 'none');
  assert.equal(categoryCheckState([], ['overlap']), 'none');
});

test('canDeleteProfile: creator (case-insensitive) or admin only', () => {
  const p = { id: 'p1', created_by: 'Pat@Newell.com' };
  assert.equal(canDeleteProfile(p, { username: 'pat@newell.com' }, false), true);
  assert.equal(canDeleteProfile(p, { username: 'sam@newell.com' }, false), false);
  assert.equal(canDeleteProfile(p, { username: 'sam@newell.com' }, true), true);
  assert.equal(canDeleteProfile(p, null, false), false);
  assert.equal(canDeleteProfile({ id: 'x', created_by: null }, { username: 'sam' }, false), false);
});

test('draftFromProfile / profileFromDraft round trip keeps every rule field incl. minLateHours', () => {
  const profile = {
    id: 'p1', plant: 'P1', name: 'Mine', description: 'd', ranking: 'time', created_by: 'me', updated_at: '2026-10-20T10:00:00Z',
    rules: [
      { types: ['overlap', 'late'], dayFrom: -3, dayTo: 14, minSev: 'err', minLateHours: 12 },
      { types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null },
    ],
  };
  const draft = draftFromProfile(profile);
  assert.equal(draft.id, 'p1');
  assert.equal(draft.updated_at, '2026-10-20T10:00:00Z');
  assert.deepEqual(draft.rules[0].types, ['overlap', 'late']);
  assert.equal(draft.rules[1].types.length, FIRING_ALERT_TYPES.length, 'null types = every firing type ticked');
  // The draft is a deep copy: editing it must not touch the cached profile.
  draft.rules[0].types.push('closed');
  assert.deepEqual(profile.rules[0].types, ['overlap', 'late']);
  draft.rules[0].types.pop();

  const back = profileFromDraft(draft);
  // The unrestricted second rule sits beside a narrowing one (any-of matching), so it is kept: dropping it would narrow the profile.
  assert.deepEqual(back.rules, profile.rules);
  assert.equal(back.name, 'Mine');
  assert.equal(profileFromDraft(draft, profile).ranking, 'time');
  assert.equal(back.expected_updated_at, '2026-10-20T10:00:00Z');
});

test('uniqueCopyName appends (copy), then (copy 2), and stays within 60 characters', () => {
  assert.equal(uniqueCopyName('Overlaps', ['Late']), 'Overlaps (copy)');
  assert.equal(uniqueCopyName('Overlaps', ['Overlaps (copy)']), 'Overlaps (copy 2)');
  assert.equal(uniqueCopyName('Overlaps', ['overlaps (COPY)', 'Overlaps (copy 2)']), 'Overlaps (copy 3)');
  const long = uniqueCopyName('x'.repeat(60), []);
  assert.ok(long.length <= 60 && long.endsWith(' (copy)'));
});

test('liveRange: positive, negative and blank offsets step by calendar day', () => {
  const today = new Date(2026, 9, 20);   // Oct 20 2026
  const iso = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  assert.deepEqual(liveRange(0, 7, today, iso), { from: '2026-10-20', to: '2026-10-27' });
  assert.deepEqual(liveRange(-3, 0, today, iso), { from: '2026-10-17', to: '2026-10-20' });
  assert.deepEqual(liveRange(null, 5, today, iso), { from: '…', to: '2026-10-25' });
  assert.deepEqual(liveRange(2, null, today, iso), { from: '2026-10-22', to: '…' });
  assert.equal(liveRange(null, null, today, iso), null);
  // month-end rollover (calendar stepping, not +86400000)
  assert.deepEqual(liveRange(12, 12, today, iso), { from: '2026-11-1', to: '2026-11-1' });
});

test('liveMatchCount counts the alerts the whole draft matches', () => {
  const today = new Date(2026, 9, 20);
  const alert = (id, type, sev, day) => ({ id, type, sev, msg: '', line: '', taskId: null, time: new Date(2026, 9, day, 8) });
  const alerts = [alert('a', 'overlap', 'err', 21), alert('b', 'overlap', 'warn', 21), alert('c', 'late', 'err', 21), alert('d', 'overlap', 'err', 28)];
  const draft = { plant: 'P1', name: 'x', rules: [
    { types: ['overlap'], dayFrom: 0, dayTo: 3, minSev: 'err', minLateHours: null },
    { types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null },
  ] };
  assert.equal(liveMatchCount(draft, alerts, {}, today), 2);
  assert.equal(liveMatchCount({ ...draft, rules: [] }, alerts, {}, today), 0);
});

// ---- DOM -------------------------------------------------------------------------------------

function makeEl(id) {
  const handlers = {};
  return {
    id, _html: '', handlers, textContent: '', hidden: true, value: '', checked: false, disabled: false, dataset: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener(type, fn) { handlers[type] = fn; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    scrollIntoView() {}, blur() {}, focus() {}, closest() { return null; }, contains() { return false; },
    style: {}, scrollTop: 0,
  };
}

/** An event target that answers closest('[data-x]') for its own data attributes, like the real DOM would. */
function tgt(dataset, extra = {}) {
  const el = {
    dataset, value: '', checked: false,
    closest(sel) {
      const m = /^\[data-([a-z-]+)\]$/.exec(sel);
      if (!m) return null;
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in dataset ? el : null;
    },
    ...extra,
  };
  return el;
}

const prior = {};
let els, calls;

const mine = { id: 'p1', plant: 'P1', name: 'Overlaps', description: '', ranking: 'impact', created_by: 'me@newell.com', updated_at: 'T1',
  rules: [{ types: ['overlap'], dayFrom: 0, dayTo: 7, minSev: null, minLateHours: null }] };
const theirs = { ...mine, id: 'p2', name: 'Late orders', created_by: 'other@newell.com', updated_at: 'T2' };

function setUser(username, admin = false) {
  Session.currentUser = () => ({ username });
  Session.isAdmin = () => admin;
}
const fire = (id, type, target) => els[id].handlers[type]({ target, preventDefault() {}, stopPropagation() {} });
const click = (id, dataset) => fire(id, 'click', tgt(dataset));
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  els = {};
  calls = { create: [], update: [], remove: [], toast: [], prefs: [], session: [], closed: [], confirm: [] };
  for (const k of ['doc', 'create', 'update', 'remove', 'cached', 'list', 'cu', 'admin', 'allowed', 'setPref', 'setSession', 'open', 'close', 'confirm', 'toast'])
    prior[k] = undefined;
  prior.doc = globalThis.document;
  prior.create = AlertProfileClient.create; prior.update = AlertProfileClient.update; prior.remove = AlertProfileClient.remove;
  prior.cached = AlertProfileClient.cached; prior.list = AlertProfileClient.list;
  prior.cu = Session.currentUser; prior.admin = Session.isAdmin; prior.allowed = Session.allowedPlants; prior.setPref = Session.setPref;
  prior.setSession = AlertProfileMatches.setSessionProfile;
  prior.open = Modal.open; prior.close = Modal.close; prior.confirm = Modal.confirm; prior.toast = Toast.show;

  globalThis.document = {
    getElementById(id) { return (els[id] ??= makeEl(id)); },
    createElement() { return makeEl('created'); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, activeElement: null,
  };
  const profiles = [mine, theirs];
  AlertProfileClient.cached = () => profiles;
  AlertProfileClient.list = async () => profiles;
  AlertProfileClient.create = async p => { calls.create.push(p); return { ...p, id: 'new1', created_by: 'me@newell.com', updated_at: 'T9' }; };
  AlertProfileClient.update = async (id, p) => { calls.update.push([id, p]); return { ...mine, ...p, id }; };
  AlertProfileClient.remove = async (id, plant) => { calls.remove.push([id, plant]); };
  AlertProfileMatches.setSessionProfile = id => { calls.session.push(id); };
  Session.setPref = (k, v) => { calls.prefs.push([k, v]); };
  Session.allowedPlants = () => null;
  setUser('me@newell.com');
  Modal.open = id => { els[id] ??= makeEl(id); els[id].hidden = false; };
  Modal.close = id => { calls.closed.push(id); if (els[id]) els[id].hidden = true; };
  Modal.confirm = async o => { calls.confirm.push(o); return true; };
  Toast.show = (msg, type) => { calls.toast.push([msg, type]); };
  Store.setSelectedPlant('P1', 'test');
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p2', P7: 'z' } }, 'test');
  Store.setAlerts([], 'test');
  Store.setTasks([], 'test');
});

afterEach(() => {
  AlertProfileEditor.close();
  globalThis.document = prior.doc;
  AlertProfileClient.create = prior.create; AlertProfileClient.update = prior.update; AlertProfileClient.remove = prior.remove;
  AlertProfileClient.cached = prior.cached; AlertProfileClient.list = prior.list;
  Session.currentUser = prior.cu; Session.isAdmin = prior.admin; Session.allowedPlants = prior.allowed; Session.setPref = prior.setPref;
  AlertProfileMatches.setSessionProfile = prior.setSession;
  Modal.open = prior.open; Modal.close = prior.close; Modal.confirm = prior.confirm; Toast.show = prior.toast;
});

test('the Fine-tune tier lists only firing types, per ON group, and the late-hours input for the Late group', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const body = els['ape-body'].innerHTML;
  assert.match(body, /data-ape-type="overlap"/);
  assert.doesNotMatch(body, /data-ape-type="near-capacity"/);
  assert.doesNotMatch(body, /data-ape-type="line_no_calendar"/);
  for (const cat of ALERT_CATEGORY_ORDER) assert.match(body, new RegExp(`data-ape-block="${cat}"`));
  assert.match(body, /ape\.late_hours/);
  assert.doesNotMatch(body, /ape\.min_sev|ape\.sev_warn|ape\.sev_any/);
  assert.equal(els['modal-alert-profile'].hidden, false);
});

test('the groups tier has seven switch rows, each a role=switch with the group name as its label', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const body = els['ape-body'].innerHTML;
  const rows = body.match(/<input type="checkbox" role="switch"[^>]*>/g) ?? [];
  assert.equal(rows.length, 7);
  for (const cat of ALERT_CATEGORY_ORDER) {
    const row = rows.find(r => r.includes(`data-ape-grp-on="${cat}"`));
    assert.ok(row, `${cat} switch`);
    assert.match(row, new RegExp(`aria-label="ape\\.cat_${cat}"`));
    assert.match(row, /aria-checked="true"/);
    assert.match(row, /checked/);
  }
  assert.match(body, /cal-day-toggle-wrap/);
  for (const cat of ALERT_CATEGORY_ORDER) assert.match(body, new RegExp(`id="ape-cnt-${cat}"`));
});

test('blankDraft is all seven groups on in their default colours with no rules', () => {
  const d = blankDraft('P1');
  assert.equal(d.plant, 'P1');
  assert.deepEqual(d.rules, []);
  assert.deepEqual(Object.keys(d.categories), [...ALERT_CATEGORY_ORDER]);
  for (const cat of ALERT_CATEGORY_ORDER) assert.deepEqual(d.categories[cat], { on: true, color: DEFAULT_CATEGORY_COLORS[cat] });
});

test('dayPresetOf / dayPresetRange: Next N is day 0 to N-1, Overdue is before today, the rest is Custom', () => {
  assert.equal(dayPresetOf(null, null), 'any');
  assert.equal(dayPresetOf(null, -1), 'overdue');
  assert.equal(dayPresetOf(0, 2), 'next3');
  assert.equal(dayPresetOf(0, 6), 'next7');
  assert.equal(dayPresetOf(0, 13), 'next14');
  assert.equal(dayPresetOf(1, 6), 'custom');
  assert.equal(dayPresetOf(0, 4), 'custom');
  assert.equal(dayPresetOf(null, 6), 'custom');
  assert.deepEqual(dayPresetRange('any'), { dayFrom: null, dayTo: null });
  assert.deepEqual(dayPresetRange('overdue'), { dayFrom: null, dayTo: -1 });
  assert.deepEqual(dayPresetRange('next3'), { dayFrom: 0, dayTo: 2 });
  assert.deepEqual(dayPresetRange('next7'), { dayFrom: 0, dayTo: 6 });
  assert.deepEqual(dayPresetRange('next14'), { dayFrom: 0, dayTo: 13 });
  assert.equal(dayPresetRange('custom'), null);
  for (const p of ['any', 'overdue', 'next3', 'next7', 'next14']) {
    const r = dayPresetRange(p);
    assert.equal(dayPresetOf(r.dayFrom, r.dayTo), p, `${p} round trips`);
  }
});

test('tunedCategories: ON groups with a real narrowing rule only', () => {
  const rule = o => ({ types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null, ...o });
  const cats = blankDraft('P1').categories;
  assert.deepEqual(tunedCategories({ categories: cats, rules: [] }), []);
  assert.deepEqual(tunedCategories({ categories: cats, rules: [rule()] }), [], 'every type of the group, nothing else: not tuned');
  assert.deepEqual(tunedCategories({ categories: cats, rules: [rule({ dayFrom: 0, dayTo: 2 })] }), ['late']);
  assert.deepEqual(tunedCategories({ categories: cats, rules: [rule({ minSev: 'err' })] }), ['late']);
  assert.deepEqual(tunedCategories({ categories: cats, rules: [rule({ types: ['overlap'] })] }), ['conflicts'], 'a type left unticked');
  const off = { ...cats, late: { on: false, color: 'slate' } };
  assert.deepEqual(tunedCategories({ categories: off, rules: [rule({ dayFrom: 0, dayTo: 2 })] }), [], 'an OFF group is never tuned');
  assert.deepEqual(
    tunedCategories({ categories: cats, rules: [{ types: [...FIRING_ALERT_TYPES], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null }] }),
    [...ALERT_CATEGORY_ORDER], 'a rule over every type narrows every group');
});

test('draftFromProfile deep-copies rules and categories; a stored warn reads as unchecked and saves as null', () => {
  const cats = Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: true, color: 'sky' }]));
  const stored = { id: 'p1', plant: 'P1', name: 'N', description: '', ranking: 'impact', created_by: 'me', updated_at: 'T', categories: cats,
    rules: [{ types: ['late'], dayFrom: 0, dayTo: 6, minSev: 'warn', minLateHours: null }] };
  const d = draftFromProfile(stored);
  assert.equal(d.rules[0].minSev, null);
  assert.notEqual(d.categories, stored.categories);
  assert.notEqual(d.categories.late, stored.categories.late);
  d.categories.late.color = 'amber';
  d.rules[0].types.push('closed');
  assert.equal(stored.categories.late.color, 'sky');
  assert.deepEqual(stored.rules[0].types, ['late']);
  d.rules[0].types.pop();
  assert.equal(profileFromDraft(d).rules[0].minSev, null);
  assert.notEqual(profileFromDraft(d).categories, d.categories);
});

test('two rules that differ only by warn vs none collapse to one on save', () => {
  const stored = { id: 'p1', plant: 'P1', name: 'N', description: '', ranking: 'impact', created_by: 'me', updated_at: 'T',
    rules: [
      { types: ['late'], dayFrom: 0, dayTo: 6, minSev: 'warn', minLateHours: null },
      { types: ['late'], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null },
      { types: ['late'], dayFrom: 0, dayTo: 6, minSev: 'err', minLateHours: null },
    ] };
  const out = profileFromDraft(draftFromProfile(stored)).rules;
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(r => r.minSev), [null, 'err']);
});

test('Save on a blank draft with no name shows only the name error (the groups alone make a valid profile) and does not call the server', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  const body = els['ape-body'].innerHTML;
  assert.match(body, /ape-err[^>]*>[^<]*ape\.err_name_required/);
  assert.doesNotMatch(body, /ape\.err_rule_no_types|ape\.err_no_categories/);
  assert.equal(calls.create.length, 0);
});

test('all seven switches off renders ape.err_no_categories on Save and sends nothing', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Quiet' }));
  for (const cat of ALERT_CATEGORY_ORDER) fire('ape-body', 'change', tgt({ apeGrpOn: cat }, { checked: false }));
  assert.match(els['ape-body'].innerHTML, /ape-grp-off/);
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.match(els['ape-body'].innerHTML, /ape-err[^>]*>[^<]*ape\.err_no_categories/);
  assert.equal(calls.create.length, 0);
});

test('an err_categories_shape error renders under the groups', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const s = AlertProfileEditor._test.state();
  s.errors = { categories: 'ape.err_categories_shape' };
  AlertProfileEditor._test.render();
  assert.match(els['ape-body'].innerHTML, /ape-err[^>]*>[^<]*ape\.err_categories_shape/);
});

const FINE_OPEN = /<details class="ape-tune" data-ape-tune open>/;
const FINE_SHUT = /<details class="ape-tune" data-ape-tune>/;
const toggle = open => els['ape-body'].handlers.toggle({ target: { dataset: { apeTune: '' }, open } });

test('Fine-tune opens by itself only for a tuned profile; the planner\'s toggle wins afterwards; a rule error forces it open', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  assert.match(els['ape-body'].innerHTML, FINE_SHUT, 'blank: collapsed');
  toggle(true);                                                       // the planner opens it
  fire('ape-body', 'change', tgt({ apeGrpOn: 'setup' }, { checked: false }));   // a structural re-render
  assert.match(els['ape-body'].innerHTML, FINE_OPEN, 'the planner\'s choice survives a re-render');

  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  assert.match(els['ape-body'].innerHTML, FINE_OPEN, 'a tuned profile opens on load');
  toggle(false);                                                      // the planner collapses it
  fire('ape-body', 'change', tgt({ apeGrpOn: 'late' }, { checked: true }));
  assert.match(els['ape-body'].innerHTML, FINE_SHUT, 'and stays collapsed through a re-render');
  fire('ape-body', 'input', tgt({ apeField: 'dayTo', apeRule: '0' }, { value: '999' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.match(els['ape-body'].innerHTML, FINE_OPEN, 'a rules.* validation error on save forces it open');
  assert.match(els['ape-body'].innerHTML, /ape\.err_days_range/);

  click('ape-body', { apeAct: 'select', apeId: 'p2' });               // switching profile re-decides
  assert.match(els['ape-body'].innerHTML, FINE_OPEN);
  const plain = { ...mine, id: 'p3', name: 'Plain', rules: [{ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null }] };
  AlertProfileClient.cached = () => [plain];
  AlertProfileClient.list = async () => [plain];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p3' });
  assert.match(els['ape-body'].innerHTML, FINE_SHUT, 'an untuned legacy profile opens collapsed');
});

test('more than one saved rule opens Fine-tune', () => {
  const two = { ...mine, id: 'p4', name: 'Two', rules: [
    { types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null },
    { types: ['overlap'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null },
  ] };
  AlertProfileClient.cached = () => [two];
  AlertProfileClient.list = async () => [two];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p4' });
  assert.match(els['ape-body'].innerHTML, FINE_OPEN);
});

test('a colour pick patches the draft and the swatch in place: no re-render, no recount; the item marks the current colour', async () => {
  const opened = [];
  const priorOpen = OverflowMenu.open;
  OverflowMenu.open = (anchor, items, opts) => { opened.push({ anchor, items, opts }); return { close() {} }; };
  try {
    AlertProfileEditor.open({ plant: 'P1' });
    const attrs = {};
    const anchor = tgt({ apeAct: 'color', apeCat: 'capacity' }, { setAttribute(k, v) { attrs[k] = v; } });
    let counts = 0;
    const priorCounts = editorSeams.categoryCounts;
    editorSeams.categoryCounts = (...a) => { counts++; return priorCounts(...a); };
    const htmlBefore = els['ape-body'].innerHTML;
    try {
      els['ape-body'].handlers.click({ target: anchor });
      assert.equal(opened.length, 1);
      assert.equal(opened[0].opts.key, 'ape-color-capacity');
      assert.equal(opened[0].opts.align, 'end');
      const items = opened[0].items;
      assert.deepEqual(items.map(i => i.data.apColor), [...PALETTE]);
      assert.ok(items.every(i => i.checked === undefined), 'never a checkbox item');
      const cur = items.filter(i => i.data.current);
      assert.equal(cur.length, 1);
      assert.equal(cur[0].data.apColor, DEFAULT_CATEGORY_COLORS.capacity);
      assert.match(cur[0].label, /✓/);
      assert.ok(items.find(i => i.data.apColor === 'violet').hint, 'violet is already worn by Conflicts: the hint names it');
      assert.equal(items.find(i => i.data.apColor === 'sky').hint, undefined);

      items.find(i => i.data.apColor === 'sky').onSelect({});
      assert.equal(attrs['data-color'], 'sky');
      assert.match(attrs['aria-label'], /ape\.color_for/);
      assert.equal(AlertProfileEditor._test.state().draft.categories.capacity.color, 'sky');
      assert.equal(counts, 0, 'no recount');
      assert.equal(els['ape-body'].innerHTML, htmlBefore, 'no re-render');
    } finally { editorSeams.categoryCounts = priorCounts; }
    click('ape-foot', { apeAct: 'save' });
    fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Colourful' }));
    click('ape-foot', { apeAct: 'save' });
    await flush();
    assert.equal(calls.create[0].categories.capacity.color, 'sky');
  } finally { OverflowMenu.open = priorOpen; }
});

test('the live-recount timer is cleared on close: no recount fires after close(); an open editor does recount', async () => {
  const priorCounts = editorSeams.categoryCounts;
  let counts = 0;
  editorSeams.categoryCounts = (...a) => { counts++; return priorCounts(...a); };
  try {
    AlertProfileEditor.open({ plant: 'P1' });
    AlertProfileEditor._test.state().draft.rules.push({ types: [], dayFrom: null, dayTo: null, minSev: null, minLateHours: null });
    const before = counts;
    fire('ape-body', 'input', tgt({ apeField: 'dayFrom', apeRule: '0' }, { value: '2' }));
    await new Promise(r => setTimeout(r, 250));
    assert.ok(counts > before, 'control: the debounced recount fires while open');
    const mid = counts;
    fire('ape-body', 'input', tgt({ apeField: 'dayTo', apeRule: '0' }, { value: '5' }));
    AlertProfileEditor.close();
    await new Promise(r => setTimeout(r, 250));
    assert.equal(counts, mid, 'close() cancelled the pending recount');
  } finally { editorSeams.categoryCounts = priorCounts; }
});

test('read-only: switches, swatches, selects and inputs are disabled and the palette does not open', () => {
  setUser('sam@newell.com');
  let opened = 0;
  const priorOpen = OverflowMenu.open;
  OverflowMenu.open = () => { opened++; return { close() {} }; };
  try {
    AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
    const body = els['ape-body'].innerHTML;
    for (const re of [/<input[^>]*data-ape-grp-on[^>]*>/g, /<button[^>]*ape-swbtn[^>]*>/g, /<select[^>]*>/g,
      /<input[^>]*data-ape-field="(?:name|dayFrom|dayTo|minLateHours)"[^>]*>/g, /<input[^>]*data-ape-type[^>]*>/g, /<input[^>]*data-ape-field="errOnly"[^>]*>/g]) {
      const found = body.match(re) ?? [];
      assert.ok(found.length > 0, String(re));
      for (const f of found) assert.match(f, /\sdisabled/, f);
    }
    click('ape-body', { apeAct: 'color', apeCat: 'late' });
    assert.equal(opened, 0);
  } finally { OverflowMenu.open = priorOpen; }
});

test('the live counts are one pass per draft change and never on a Name keystroke', async () => {
  let passes = 0;
  const priorCounts = editorSeams.categoryCounts;
  editorSeams.categoryCounts = (...a) => { passes++; return priorCounts(...a); };
  try {
    AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
    await new Promise(r => setTimeout(r, 20));   // let open()'s async profile load settle its own re-render
    const afterOpen = passes;
    assert.ok(afterOpen >= 1);
    for (const v of ['A', 'Ab', 'Abc']) fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: v }));
    assert.equal(passes, afterOpen, 'typing a name recounts nothing');
    for (const v of ['1', '2', '3']) fire('ape-body', 'input', tgt({ apeField: 'dayTo', apeRule: '0' }, { value: v }));
    assert.equal(passes, afterOpen, 'number keystrokes are debounced (120 ms)');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(passes, afterOpen + 1, 'a burst of day edits recounts once');
    fire('ape-body', 'change', tgt({ apeField: 'errOnly', apeRule: '0' }, { checked: true }));
    assert.equal(passes, afterOpen + 2);
  } finally { editorSeams.categoryCounts = priorCounts; }
});

test('an OFF group still shows the count it would match, and the header sums only the ON groups', () => {
  const alert = (id, type) => ({ id, type, sev: 'err', msg: '', line: '', taskId: null, time: new Date() });
  Store.setAlerts([alert('a', 'late'), alert('b', 'late'), alert('c', 'overlap')], 'test');
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'change', tgt({ apeGrpOn: 'late' }, { checked: false }));
  const html = els['ape-body'].innerHTML;
  assert.match(html, /id="ape-cnt-late">2</);
  assert.match(html, /id="ape-cnt-conflicts">1</);
  assert.match(html, /id="ape-matches">ape\.live_matches/);
  assert.equal(AlertProfileEditor._test.state().counts.late, 2);
});

test('Fine-tune edits: a preset sets the window, Custom reveals the numbers, Errors only maps to err/null, the last type of a group cannot be unticked', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const s = () => AlertProfileEditor._test.state();
  const lateRule = () => s().draft.rules.find(r => r.types.includes('late'));
  const idx = () => String(s().draft.rules.indexOf(lateRule()));
  fire('ape-body', 'change', tgt({ apeField: 'dayPreset', apeRule: idx() }, { value: 'next7' }));
  assert.equal(lateRule().dayFrom, 0); assert.equal(lateRule().dayTo, 6);
  assert.doesNotMatch(els['ape-body'].innerHTML, /data-ape-field="dayFrom"/);
  fire('ape-body', 'change', tgt({ apeField: 'dayPreset', apeRule: idx() }, { value: 'custom' }));
  assert.match(els['ape-body'].innerHTML, /data-ape-field="dayFrom"/);
  assert.equal(lateRule().dayTo, 6, 'Custom keeps the numbers');
  fire('ape-body', 'change', tgt({ apeField: 'dayPreset', apeRule: idx() }, { value: 'overdue' }));
  assert.equal(lateRule().dayFrom, null); assert.equal(lateRule().dayTo, -1);
  fire('ape-body', 'change', tgt({ apeField: 'errOnly', apeRule: idx() }, { checked: true }));
  assert.equal(lateRule().minSev, 'err');
  fire('ape-body', 'change', tgt({ apeField: 'errOnly', apeRule: idx() }, { checked: false }));
  assert.equal(lateRule().minSev, null);
  // Conflicts: untick two of three types, then the last ticked one is refused.
  const cr = () => s().draft.rules.find(r => r.types.includes('overlap'));
  const ci = () => String(s().draft.rules.indexOf(cr()));
  fire('ape-body', 'change', tgt({ apeType: 'tool-conflict', apeRule: ci(), apeCat: 'conflicts' }, { checked: false }));
  fire('ape-body', 'change', tgt({ apeType: 'distribution-separation', apeRule: ci(), apeCat: 'conflicts' }, { checked: false }));
  assert.deepEqual(cr().types, ['overlap']);
  fire('ape-body', 'change', tgt({ apeType: 'overlap', apeRule: ci(), apeCat: 'conflicts' }, { checked: false }));
  assert.deepEqual(cr().types, ['overlap'], 'the last type stays ticked');
  assert.match(els['ape-body'].innerHTML, /<input[^>]*data-ape-type="overlap"[^>]*disabled/);
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Tuned' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  const sent = calls.create[0];
  assert.deepEqual(sent.rules.map(r => r.types), [['overlap'], ['late']]);
  assert.equal(sent.rules[1].dayTo, -1);
});

test('a no-op rule beside a narrowing rule of the same group is kept on the wire and shown with the matches-everything note', async () => {
  const both = { ...mine, id: 'p6', name: 'Both', rules: [
    { types: ['late'], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null },
    { types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null },
  ] };
  assert.deepEqual(profileFromDraft(draftFromProfile(both)).rules, both.rules, 'both rules round-trip unchanged');
  AlertProfileClient.cached = () => [both];
  AlertProfileClient.list = async () => [both];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p6' });
  assert.match(els['ape-body'].innerHTML, /ape\.rule_matches_all/);
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.update[0][1].rules, both.rules);
});

test('Add rule beside a narrowing rule shows the matches-everything note at once', () => {
  const one = { ...mine, id: 'p7', name: 'One', rules: [{ types: ['late'], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null }] };
  AlertProfileClient.cached = () => [one];
  AlertProfileClient.list = async () => [one];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p7' });
  assert.doesNotMatch(els['ape-body'].innerHTML, /ape\.rule_matches_all/);
  click('ape-body', { apeAct: 'add-rule', apeCat: 'late' });
  assert.match(els['ape-body'].innerHTML, /ape\.rule_matches_all/);
  assert.match(els['ape-body'].innerHTML, /data-ape-act="rm-rule"/);
});

test('all-ON with no rules still saves []; Next 7 days on Late alone saves one narrowed rule', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Plain' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.create[0].rules, []);

  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Late week' }));
  const s = AlertProfileEditor._test.state();
  const i = String(s.draft.rules.findIndex(r => r.types.includes('late')));
  fire('ape-body', 'change', tgt({ apeField: 'dayPreset', apeRule: i }, { value: 'next7' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.create[1].rules, [{ types: ['late'], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null }]);
});

test('the Fine-tuned badge follows live edits; single-type groups render no type row; the disabled last type explains itself; the switch aria-checked tracks the input', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  assert.match(els['ape-body'].innerHTML, /id="ape-badge-late"[^>]* hidden>/);
  const s = AlertProfileEditor._test.state();
  const i = String(s.draft.rules.findIndex(r => r.types.includes('overlap')));
  fire('ape-body', 'change', tgt({ apeField: 'errOnly', apeRule: i }, { checked: true }));
  assert.equal(els['ape-badge-conflicts'].hidden, false, 'badge shows after Errors only');
  fire('ape-body', 'change', tgt({ apeField: 'errOnly', apeRule: i }, { checked: false }));
  assert.equal(els['ape-badge-conflicts'].hidden, true, 'and hides again');
  // Late has one type: no type checkboxes at all.
  assert.doesNotMatch(els['ape-body'].innerHTML, /data-ape-type="late"/);
  // Conflicts reduced to one type: the disabled box carries the explanation.
  fire('ape-body', 'change', tgt({ apeType: 'tool-conflict', apeRule: i, apeCat: 'conflicts' }, { checked: false }));
  fire('ape-body', 'change', tgt({ apeType: 'distribution-separation', apeRule: i, apeCat: 'conflicts' }, { checked: false }));
  assert.match(els['ape-body'].innerHTML, /data-ape-type="overlap"[^>]*disabled[^>]*title="ape\.type_keep_one"/);
  const attrs = {};
  fire('ape-body', 'change', tgt({ apeGrpOn: 'setup' }, { checked: false, setAttribute(k, v) { attrs[k] = v; } }));
  assert.equal(attrs['aria-checked'], 'false');
});

test('the Off line and the inert line name the switched-off groups and rules that only touch them', () => {
  const p = { ...mine, id: 'p5', name: 'Late only', rules: [{ types: ['late'], dayFrom: 0, dayTo: 6, minSev: null, minLateHours: null }] };
  AlertProfileClient.cached = () => [p];
  AlertProfileClient.list = async () => [p];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p5' });
  assert.match(els['ape-body'].innerHTML, /ape\.groups_off/);
  assert.doesNotMatch(els['ape-body'].innerHTML, /ape\.rule_inert/);
  fire('ape-body', 'change', tgt({ apeGrpOn: 'conflicts' }, { checked: true }));
  fire('ape-body', 'change', tgt({ apeGrpOn: 'late' }, { checked: false }));
  assert.match(els['ape-body'].innerHTML, /ape\.rule_inert/, 'the late rule now only touches an OFF group');
});

test('Delete is hidden for a non-creator non-admin and shown for the creator and for an admin', () => {
  setUser('sam@newell.com');
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  assert.doesNotMatch(els['ape-foot'].innerHTML, /data-ape-act="delete"/);
  AlertProfileEditor.close();

  setUser('me@newell.com');
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  assert.match(els['ape-foot'].innerHTML, /data-ape-act="delete"/);
  AlertProfileEditor.close();

  setUser('sam@newell.com', true);
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  assert.match(els['ape-foot'].innerHTML, /data-ape-act="delete"/);
  AlertProfileEditor.close();

  AlertProfileEditor.open({ plant: 'P1' });   // a new draft has nothing to delete
  assert.doesNotMatch(els['ape-foot'].innerHTML, /data-ape-act="delete"/);
});

test('a new draft saves through create with the plant, toasts, and closes', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: '  Fresh one  ' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create.length, 1);
  const sent = calls.create[0];
  assert.equal(sent.plant, 'P1');
  assert.equal(sent.name, 'Fresh one');
  assert.deepEqual(sent.rules, [], 'a blank draft narrows nothing');
  assert.deepEqual(sent.categories, blankDraft('P1').categories, 'all seven groups on in their default colours');
  assert.equal(sent.ranking, 'impact');
  assert.equal(calls.update.length, 0);
  assert.match(calls.toast[0][0], /toast\.alert_profile_saved/);
  assert.deepEqual(calls.closed, ['modal-alert-profile']);
});

test('an existing profile saves through update with expected_updated_at', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Overlaps v2' }));
  fire('ape-body', 'input', tgt({ apeField: 'minLateHours', apeRule: '0' }, { value: '6' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  const [id, patch] = calls.update[0];
  assert.equal(id, 'p1');
  assert.equal(patch.plant, 'P1');
  assert.equal(patch.name, 'Overlaps v2');
  assert.equal(patch.expected_updated_at, 'T1');
  assert.equal(patch.rules[0].minLateHours, 6);
});

test('server 409 name_taken renders ape.err_name_dup under Name; stale renders ape.err_stale; the modal stays open', async () => {
  AlertProfileClient.create = async () => { throw new AlertApiError('dup', 'name_taken', 409); };
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Fresh' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.match(els['ape-body'].innerHTML, /ape-err[^>]*>[^<]*ape\.err_name_dup/);
  assert.equal(calls.closed.length, 0);

  AlertProfileClient.update = async () => { throw new AlertApiError('stale', 'stale', 409); };
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.match(els['ape-body'].innerHTML + els['ape-foot'].innerHTML, /ape\.err_stale/);
  assert.equal(calls.closed.length, 0);
});

test('"Use this profile" writes alertProfileByPlant read-modify-write and clears the session override', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  fire('ape-body', 'change', tgt({ apeField: 'setMine' }, { checked: true }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.prefs, [['alertProfileByPlant', { P1: 'p1', P7: 'z' }]]);
  assert.deepEqual(calls.session, [null]);
});

test('without the toggle no pref is written', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.prefs.length, 0);
});

test('the draft has no ranking field; profileFromDraft defaults to impact and passes an existing ranking through', () => {
  const stored = { id: 'p1', plant: 'P1', name: 'Mine', description: '', ranking: 'time', created_by: 'me', updated_at: 'T',
    rules: [{ types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null }] };
  const d = draftFromProfile(stored);
  assert.equal('ranking' in d, false);
  assert.equal(profileFromDraft(d).ranking, 'impact');
  assert.equal(profileFromDraft(d, stored).ranking, 'time');
});

test('the rendered editor body has no ranking label or select', () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  const html = els['ape-body'].innerHTML;
  assert.equal(html.includes('ape.ranking'), false);
  assert.equal(html.includes('data-ape-field="ranking"'), false);
});

test('saving an existing profile keeps its stored ranking', async () => {
  const stored = [{ ...mine, ranking: 'time' }, theirs];
  AlertProfileClient.cached = () => stored;
  AlertProfileClient.list = async () => stored;
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.update[0][1].ranking, 'time');
});

test('fromPicker: a successful create makes the page view the new profile; a plain create does not', async () => {
  AlertProfileEditor.open({ plant: 'P1', fromPicker: true });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Fresh' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.session, ['new1']);

  calls.session.length = 0;
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Fresh two' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.session, []);
});

test('fromPicker: editing the profile the page is viewing re-selects it; editing another does not', async () => {
  const priorView = AlertProfileMatches.current;
  try {
    AlertProfileMatches.current = () => ({ profileId: 'p1' });
    AlertProfileEditor.open({ plant: 'P1', profileId: 'p1', fromPicker: true });
    click('ape-foot', { apeAct: 'save' });
    await flush();
    assert.deepEqual(calls.session, ['p1']);

    calls.session.length = 0;
    AlertProfileMatches.current = () => ({ profileId: 'p2' });
    AlertProfileEditor.open({ plant: 'P1', profileId: 'p1', fromPicker: true });
    click('ape-foot', { apeAct: 'save' });
    await flush();
    assert.deepEqual(calls.session, []);
  } finally { AlertProfileMatches.current = priorView; }
});

test('Delete confirms with the danger tone and then removes the profile', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'delete' });
  await flush();
  assert.equal(calls.confirm[0].tone, 'danger');
  assert.match(calls.confirm[0].title, /ape\.delete_confirm_title/);
  assert.deepEqual(calls.remove, [['p1', 'P1']]);
  assert.deepEqual(calls.closed, ['modal-alert-profile']);
});

test('a non-409 save failure shows the real error, never the stale-edit text', async () => {
  AlertProfileClient.create = async () => { throw new Error(''); };
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Fresh' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.toast.at(-1)[0], 'ape.err_save_failed');
  assert.doesNotMatch(els['ape-body'].innerHTML + els['ape-foot'].innerHTML, /ape\.err_stale/);
  assert.equal(calls.closed.length, 0);

  AlertProfileClient.remove = async () => { throw new Error(''); };
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'delete' });
  await flush();
  assert.equal(calls.toast.at(-1)[0], 'ape.err_save_failed');
});

test('switching, New, Duplicate and Copy confirm first when edits are unsaved; a clean form switches silently', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'select', apeId: 'p2' });
  assert.equal(calls.confirm.length, 0, 'no edits: no prompt');
  assert.match(els['ape-body'].innerHTML, /value="Late orders"/);

  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Edited name' }));
  Modal.confirm = async o => { calls.confirm.push(o); return false; };   // the planner says no
  click('ape-body', { apeAct: 'select', apeId: 'p1' });
  click('ape-body', { apeAct: 'new' });
  click('ape-body', { apeAct: 'dup', apeId: 'p1' });
  click('ape-body', { apeAct: 'copy', apeId: 'p1' });
  await flush();
  assert.equal(calls.confirm.length, 4, 'one confirm per action');
  assert.match(calls.confirm[0].title, /ape\.discard_title/);
  assert.match(calls.confirm[0].message, /ape\.discard_confirm/);
  assert.equal(calls.confirm[0].tone, 'warn');
  assert.doesNotMatch(els['ape-body'].innerHTML, /data-ape-copy-plant/, 'declined: still on the edited form');
  assert.match(els['ape-body'].innerHTML, /value="Edited name"/, 'the edits survive a declined discard');

  Modal.confirm = async o => { calls.confirm.push(o); return true; };   // now yes
  click('ape-body', { apeAct: 'select', apeId: 'p1' });
  await flush();
  assert.match(els['ape-body'].innerHTML, /value="Overlaps"/);
  assert.doesNotMatch(els['ape-body'].innerHTML, /Edited name/);
  click('ape-body', { apeAct: 'new' });   // clean again after the switch
  assert.equal(calls.confirm.length, 5, 'a clean form after the discard does not ask again');
});

const withCats = (p, mut = {}) => {
  const categories = Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: c === 'late' || c === 'conflicts', color: c === 'late' ? 'sky' : 'sand' }]));
  return { ...p, categories: { ...categories, ...mut } };
};

test('Duplicate, Save and Copy to plants all carry the full categories map', async () => {
  const src = withCats(mine);
  AlertProfileClient.cached = () => [src, theirs];
  AlertProfileClient.list = async () => [src, theirs];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'dup', apeId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.create[0].categories, src.categories, 'Duplicate');

  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.deepEqual(calls.update[0][1].categories, src.categories, 'Save (update)');

  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [] }, 'test');
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'copy', apeId: 'p1' });
  fire('ape-body', 'change', tgt({ apeCopyPlant: 'P2' }, { checked: true }));
  click('ape-body', { apeAct: 'copy-go' });
  await flush(); await flush();
  const copy = calls.create.find(c => c.plant === 'P2');
  assert.deepEqual(copy.categories, src.categories, 'Copy to plants');
  assert.notEqual(copy.categories, src.categories, 'a copy, not the cached object');
});

test('_revalidate sees the categories: switching every group off on a stored profile fails validation', async () => {
  const src = withCats(mine);
  AlertProfileClient.cached = () => [src];
  AlertProfileClient.list = async () => [src];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  for (const cat of ['late', 'conflicts']) fire('ape-body', 'change', tgt({ apeGrpOn: cat }, { checked: false }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.match(els['ape-body'].innerHTML, /ape\.err_no_categories/);
  assert.equal(calls.update.length, 0);
  fire('ape-body', 'change', tgt({ apeGrpOn: 'late' }, { checked: true }));   // showErrors is on: the error clears live
  assert.doesNotMatch(els['ape-body'].innerHTML, /ape\.err_no_categories/);
});

test('liveMatchCount passes the categories: an OFF group contributes nothing', () => {
  const today = new Date(2026, 9, 20);
  const alert = (id, type) => ({ id, type, sev: 'err', msg: '', line: '', taskId: null, time: new Date(2026, 9, 21, 8) });
  const alerts = [alert('a', 'late'), alert('b', 'overlap')];
  const categories = blankDraft('P1').categories;
  assert.equal(liveMatchCount({ plant: 'P1', rules: [], categories }, alerts, {}, today), 2);
  categories.late.on = false;
  assert.equal(liveMatchCount({ plant: 'P1', rules: [], categories }, alerts, {}, today), 1);
});

test('Duplicate opens a new unsaved draft named "<name> (copy)"', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'dup', apeId: 'p1' });
  assert.match(els['ape-body'].innerHTML, /value="Overlaps \(copy\)"/);
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].name, 'Overlaps (copy)');
  assert.equal(calls.update.length, 0);
});

test('Copy to plants creates one copy per picked plant (skipping the current) and reports a 409 per plant', async () => {
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }, { plant: 'P3' }, { plant: 'P4' }], lines: [] }, 'test');
  Session.allowedPlants = () => ['P1', 'P2', 'P3'];
  AlertProfileClient.create = async p => {
    calls.create.push(p);
    if (p.plant === 'P3') throw new AlertApiError('dup', 'name_taken', 409);
    return { ...p, id: 'n' + p.plant };
  };
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'copy', apeId: 'p1' });
  const panel = els['ape-body'].innerHTML;
  assert.match(panel, /data-ape-copy-plant="P2"/);
  assert.match(panel, /data-ape-copy-plant="P3"/);
  assert.doesNotMatch(panel, /data-ape-copy-plant="P1"/, 'current plant is skipped');
  assert.doesNotMatch(panel, /data-ape-copy-plant="P4"/, 'a plant outside the user scope is not offered');
  assert.doesNotMatch(panel, /chip/i);

  fire('ape-body', 'change', tgt({ apeCopyPlant: 'P2' }, { checked: true }));
  fire('ape-body', 'change', tgt({ apeCopyPlant: 'P3' }, { checked: true }));
  click('ape-body', { apeAct: 'copy-go' });
  await flush(); await flush();
  assert.deepEqual(calls.create.map(c => c.plant).sort(), ['P2', 'P3']);
  assert.equal(calls.create[0].name, 'Overlaps');
  const toasts = calls.toast.map(t => t[0]).join('|');
  assert.match(toasts, /toast\.alert_profile_saved/);
  assert.match(toasts, /P3/);
  assert.match(toasts, /ape\.err_name_dup/);
});

// ---------------------------------------------------------------------------
// "Colour the Gantt": a plant-shared per-profile flag (gantt_colors), default true.
// ---------------------------------------------------------------------------
test('gantt_colors round trips: absent or true reads as true, false survives draft and wire', () => {
  const base = { id: 'g1', plant: 'P1', name: 'G', description: '', ranking: 'impact', created_by: 'me', updated_at: 'T', rules: [] };
  assert.equal(draftFromProfile(base).gantt_colors, true, 'a legacy row without the field colours the Gantt');
  assert.equal(draftFromProfile({ ...base, gantt_colors: true }).gantt_colors, true);
  const off = draftFromProfile({ ...base, gantt_colors: false });
  assert.equal(off.gantt_colors, false);
  assert.equal(profileFromDraft(off).gantt_colors, false);
  assert.equal(profileFromDraft(draftFromProfile(base)).gantt_colors, true);
  assert.equal(blankDraft('P1').gantt_colors, true);
});

test('the form renders the Colour the Gantt checkbox with its hint, checked by default, disabled when read-only', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const html = els['ape-body'].innerHTML;
  assert.match(html, /<input[^>]*data-ape-field="ganttColors"[^>]*checked[^>]*>/);
  assert.match(html, /ape\.gantt_colors<\/span>/);
  assert.match(html, /<div class="ape-hint">ape\.gantt_colors_hint<\/div>/);
  AlertProfileEditor.close();
  setUser('sam@newell.com');
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  assert.match(els['ape-body'].innerHTML.match(/<input[^>]*data-ape-field="ganttColors"[^>]*>/)[0], /\sdisabled/);
});

test('unticking Colour the Gantt dirties the draft and the update payload carries gantt_colors: false', async () => {
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  const s = () => AlertProfileEditor._test.state();
  assert.equal(s().draft.gantt_colors, true);
  fire('ape-body', 'change', tgt({ apeField: 'ganttColors' }, { checked: false }));
  assert.equal(s().draft.gantt_colors, false);
  assert.notEqual(JSON.stringify(profileFromDraft(s().draft)), s().baseline, 'the unsaved-edits check sees it');
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.update[0][1].gantt_colors, false);
});

test('a new draft creates with gantt_colors: true unless unticked', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Coloured' }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create[0].gantt_colors, true);
  AlertProfileEditor.open({ plant: 'P1' });
  fire('ape-body', 'input', tgt({ apeField: 'name' }, { value: 'Plain bars' }));
  fire('ape-body', 'change', tgt({ apeField: 'ganttColors' }, { checked: false }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create[1].gantt_colors, false);
});

test('Duplicate and Copy to plants carry gantt_colors', async () => {
  const src = { ...withCats(mine), gantt_colors: false };
  AlertProfileClient.cached = () => [src, theirs];
  AlertProfileClient.list = async () => [src, theirs];
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'dup', apeId: 'p1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create[0].gantt_colors, false, 'Duplicate');
  Store.setMasterData({ plants: [{ plant: 'P1' }, { plant: 'P2' }], lines: [] }, 'test');
  AlertProfileEditor.open({ plant: 'P1', profileId: 'p1' });
  click('ape-body', { apeAct: 'copy', apeId: 'p1' });
  fire('ape-body', 'change', tgt({ apeCopyPlant: 'P2' }, { checked: true }));
  click('ape-body', { apeAct: 'copy-go' });
  await flush(); await flush();
  assert.equal(calls.create.find(c => c.plant === 'P2').gantt_colors, false, 'Copy to plants');
});
