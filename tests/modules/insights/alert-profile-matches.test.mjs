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
  assert.equal(c.categoryByTask.get('t2'), 'exceptions');
  assert.equal(c.categoryByTask.get('t3'), 'capacity');    // err tie: capacity > conflicts
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

test('session override beats the pref and clears on plant change', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  profiles = [prof('p1', ['overload']), prof('p2', ['late'])];
  M.recompute();
  assert.equal(M.current().profileId, 'p1');
  M.setSessionProfile('p2');
  assert.equal(M.current().profileId, 'p2');
  assert.deepEqual([...M.current().taskIds], ['t2']);
  M.setSessionProfile('__all__');
  assert.equal(M.current().profileId, '__all__');
  M.setSessionProfile('p2');
  Store.emit({ type: 'plant:selected', plant: 'P1' });
  assert.equal(M.current().profileId, 'p1');
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
