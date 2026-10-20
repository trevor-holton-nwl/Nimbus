// Tests for frontend/alert-monitor/alert-profile-editor.mts: the pure helpers (category tri-state, delete
// permission, draft round trip, unique copy names, live day range, live match count) and the modal DOM
// against a stubbed document (inline validation keys, creator/admin Delete gate, create vs update,
// server 409 mapping, set-as-mine read-modify-write, never-firing types hidden).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AlertProfileEditor, categoryCheckState, canDeleteProfile, draftFromProfile, profileFromDraft,
  uniqueCopyName, liveRange, liveMatchCount,
} from '../../../frontend/alert-monitor/alert-profile-editor.mjs';
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
  assert.deepEqual(back.rules, profile.rules);
  assert.equal(back.name, 'Mine');
  assert.equal(back.ranking, 'time');
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

test('picker lists only firing types, grouped, with a category checkbox each', () => {
  AlertProfileEditor.open({ plant: 'P1' });
  const body = els['ape-body'].innerHTML;
  assert.match(body, /data-ape-type="overlap"/);
  assert.doesNotMatch(body, /data-ape-type="near-capacity"/);
  assert.doesNotMatch(body, /data-ape-type="line_no_calendar"/);
  for (const cat of ['capacity', 'conflicts', 'calendar', 'setup', 'exceptions']) assert.match(body, new RegExp(`data-ape-cat="${cat}"`));
  assert.match(body, /type="number" min="-365" max="365" step="1"/);
  assert.match(body, /ape\.late_hours/);
  assert.match(body, /value="orders"/);
  assert.equal(els['modal-alert-profile'].hidden, false);
});

test('Save on an empty draft renders the validation keys under the fields and does not call the server', async () => {
  AlertProfileEditor.open({ plant: 'P1' });
  click('ape-foot', { apeAct: 'save' });
  await flush();
  const body = els['ape-body'].innerHTML;
  assert.match(body, /ape-err[^>]*>[^<]*ape\.err_name_required/);
  assert.match(body, /ape\.err_rule_no_types/);
  assert.equal(calls.create.length, 0);
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
  fire('ape-body', 'change', tgt({ apeType: 'late', apeRule: '0' }, { checked: true }));
  click('ape-foot', { apeAct: 'save' });
  await flush();
  assert.equal(calls.create.length, 1);
  const sent = calls.create[0];
  assert.equal(sent.plant, 'P1');
  assert.equal(sent.name, 'Fresh one');
  assert.deepEqual(sent.rules, [{ types: ['late'], dayFrom: null, dayTo: null, minSev: null, minLateHours: null }]);
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
  fire('ape-body', 'change', tgt({ apeType: 'late', apeRule: '0' }, { checked: true }));
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
  fire('ape-body', 'change', tgt({ apeType: 'late', apeRule: '0' }, { checked: true }));
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
