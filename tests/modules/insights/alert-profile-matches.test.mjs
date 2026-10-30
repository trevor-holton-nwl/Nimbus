import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { AlertProfileMatches as M } from '../../../frontend/insights/alert-profile-matches.mjs';

const rule = (types) => ({ types, dayFrom: null, dayTo: null, minSev: null, minLateHours: null });
const prof = (id, types) => ({ id, plant: 'P1', name: id, description: '', rules: [rule(types)], ranking: 'impact' });
const alert = (id, type, sev, taskId) => ({ id, type, sev, taskId, time: new Date(2026, 9, 20, 8) });

let profiles, acks, listCalls;

beforeEach(t => {
  profiles = [prof('p1', ['overload', 'overlap', 'late'])];
  acks = new Map();
  listCalls = 0;
  t.mock.method(AlertProfileClient, 'cached', () => profiles);
  t.mock.method(AlertProfileClient, 'list', async () => { listCalls++; return profiles; });
  t.mock.method(AlertAcksClient, 'cached', () => acks);
  t.mock.method(AlertAcksClient, 'load', async () => acks);
  Store._state.selectedPlant = 'P1';
  Store._state.tasks = { t1: { id: 't1' }, t2: { id: 't2' }, t3: { id: 't3' } };
  Store._state.userSettings = {};
  Store._state.roleDefaults = {};
  Store._state.alerts = [
    alert('a1', 'overload', 'warn', 't1'),
    alert('a2', 'overlap', 'err', 't1'),
    alert('a3', 'late', 'warn', 't2'),
    alert('a4', 'closed', 'err', null),
    alert('a5', 'overload', 'err', 't3'),
    alert('a6', 'overlap', 'err', 't3'),
  ];
  M.init();
  M.setSessionProfile(null);
});

test('recompute yields worst severity and most severe category per task', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  M.recompute();
  const c = M.current();
  assert.equal(c.plant, 'P1');
  assert.equal(c.profileId, 'p1');
  assert.deepEqual([...c.alertIds].sort(), ['a1', 'a2', 'a3', 'a5', 'a6']);
  assert.deepEqual([...c.taskIds].sort(), ['t1', 't2', 't3']);
  assert.equal(c.sevByTask.get('t1'), 'err');
  assert.equal(c.sevByTask.get('t2'), 'warn');
  assert.equal(c.categoryByTask.get('t1'), 'conflicts');   // err (overlap) beats warn (overload)
  assert.equal(c.categoryByTask.get('t2'), 'late');
  assert.equal(c.categoryByTask.get('t3'), 'capacity');    // err tie: capacity > conflicts
});

test('categoryByTask ranks planning ahead of late at equal severity', () => {
  profiles = [prof('p1', ['late', 'needs_planning'])];
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  Store._state.alerts = [
    alert('a1', 'late', 'warn', 't1'),
    alert('a2', 'needs_planning', 'warn', 't1'),
    alert('a3', 'late', 'warn', 't2'),
    alert('a4', 'needs_planning', 'err', 't3'),
    alert('a5', 'late', 'err', 't3'),
  ];
  M.recompute();
  const c = M.current();
  assert.equal(c.categoryByTask.get('t1'), 'planning', 'warn tie: planning beats late');
  assert.equal(c.categoryByTask.get('t2'), 'late');
  assert.equal(c.categoryByTask.get('t3'), 'planning', 'err tie: planning beats late');
});

test("'__all__' keeps every alert id but highlights nothing", () => {
  M.recompute();
  const c = M.current();
  assert.equal(c.profileId, '__all__');
  assert.equal(c.alertIds.size, 6);
  assert.equal(c.taskIds.size, 0);
  assert.equal(c.sevByTask.size, 0);
  assert.equal(c.categoryByTask.size, 0);
});

test('subscribe fires once per recompute and unsubscribes', () => {
  let n = 0;
  const off = M.subscribe(() => { n++; });
  const rev = M.current().rev;
  M.recompute();
  assert.equal(n, 1);
  assert.equal(M.current().rev, rev + 1);
  off();
  M.recompute();
  assert.equal(n, 1);
});

test('settings:change recomputes only when a relevant pref changed', () => {
  let n = 0;
  const off = M.subscribe(() => { n++; });
  Store.setUserSettings({ somethingElse: 1 });
  assert.equal(n, 0);
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' } });
  assert.equal(n, 1);
  assert.equal(M.current().profileId, 'p1');
  Store.setUserSettings({ alertProfileByPlant: { P1: 'p1' } });   // same JSON
  assert.equal(n, 1);
  Store.setUserSettings({ alertsShowAcknowledged: true });
  assert.equal(n, 2);
  off();
});

test('the session override changes view() only; current() keeps following the saved default', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  profiles = [prof('p1', ['overload']), prof('p2', ['late'])];
  M.recompute();
  assert.equal(M.current().profileId, 'p1');
  assert.equal(M.view().profileId, 'p1', 'no override: the view is the default');
  assert.deepEqual([...M.view().taskIds].sort(), [...M.current().taskIds].sort());
  M.setSessionProfile('p2');
  assert.equal(M.current().profileId, 'p1', 'Gantt / bell / drawer / orders are unaffected');
  assert.deepEqual([...M.current().taskIds].sort(), ['t1', 't3']);
  assert.equal(M.view().profileId, 'p2');
  assert.deepEqual([...M.view().taskIds], ['t2']);
  assert.equal(M.view().rev, M.current().rev);
  M.setSessionProfile('__all__');
  assert.equal(M.current().profileId, 'p1');
  assert.equal(M.view().profileId, '__all__');
  assert.equal(M.view().taskIds.size, 0);
  assert.equal(M.view().alertIds.size, 6);
  M.setSessionProfile('p2');
  Store.emit({ type: 'plant:selected', plant: 'P1' });
  assert.equal(M.current().profileId, 'p1');
  assert.equal(M.view().profileId, 'p1', 'a plant change clears the override');
});

test('the focus set overrides current() but not view()', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  profiles = [prof('p1', ['overload'])];
  M.recompute();
  M.setFocusTaskIds(['t2']);
  assert.deepEqual([...M.current().taskIds], ['t2']);
  assert.deepEqual([...M.view().taskIds].sort(), ['t1', 't3']);
  M.setFocusTaskIds(null);
});

test('acked map is exposed from AlertAcksClient.cached', () => {
  acks = new Map([['a1', { plant: 'P1', alert_id: 'a1', acknowledged_by: 'x', reason: 'r', until: null, created_at: null }]]);
  M.recompute();
  assert.equal(M.current().acked.get('a1').acknowledged_by, 'x');
});

test('alerts:change recomputes after the debounce', async () => {
  let n = 0;
  const off = M.subscribe(() => { n++; });
  Store.emit({ type: 'alerts:change' });
  Store.emit({ type: 'alerts:change' });
  assert.equal(n, 0);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(n, 1);
  off();
});

test('an uncached plant triggers a profile list fetch', () => {
  profiles = null;
  M.recompute();
  assert.ok(listCalls >= 1);
  assert.equal(M.current().profileId, '__all__');
});

test('a failed profile fetch is not retried on every recompute: 30 s backoff, reset by a plant change', async t => {
  Store.emit({ type: 'plant:selected', plant: 'P1' });   // clears any earlier failure record
  await new Promise(r => setTimeout(r, 5));
  profiles = null;
  t.mock.method(AlertProfileClient, 'list', async () => { listCalls++; throw new Error('403'); });
  const before = listCalls;
  M.recompute();                                         // starts the fetch (it rejects)
  await new Promise(r => setTimeout(r, 5));
  assert.equal(listCalls, before + 1);
  M.recompute(); M.recompute(); M.recompute();           // alerts changing again and again
  await new Promise(r => setTimeout(r, 5));
  assert.equal(listCalls, before + 1, 'no request while backing off');
  Store.emit({ type: 'plant:selected', plant: 'P1' });   // plant change resets the backoff
  await new Promise(r => setTimeout(r, 5));
  assert.equal(listCalls, before + 2, 'retried after the plant change');
  Store.emit({ type: 'plant:selected', plant: 'P1' });   // leave a clean slate for later tests
});
