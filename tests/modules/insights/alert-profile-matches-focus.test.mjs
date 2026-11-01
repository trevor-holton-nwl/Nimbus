// AlertProfileMatches.setFocusTaskIds — the "Show on Gantt" focus: fills stay profile-based, focusIds is the outline set.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { AlertProfileMatches as M } from '../../../frontend/insights/alert-profile-matches.mjs';

const rule = types => ({ types, dayFrom: null, dayTo: null, minSev: null, minLateHours: null });
const prof = (id, types) => ({ id, plant: 'P1', name: id, description: '', rules: [rule(types)], ranking: 'impact' });
const alert = (id, type, sev, taskId, extra = {}) => ({ id, type, sev, taskId, time: new Date(2026, 9, 20, 8), ...extra });

let acks, profiles;
beforeEach(t => {
  acks = new Map();
  profiles = [prof('p1', ['overload']), prof('p2', ['overlap'])];
  t.mock.method(AlertProfileClient, 'cached', () => profiles);
  t.mock.method(AlertProfileClient, 'list', async () => profiles);
  t.mock.method(AlertAcksClient, 'cached', () => acks);
  t.mock.method(AlertAcksClient, 'load', async () => acks);
  Store._state.selectedPlant = 'P1';
  Store._state.tasks = { t1: { id: 't1' }, t2: { id: 't2' }, t3: { id: 't3' } };
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' } };
  Store._state.roleDefaults = {};
  Store._state.alerts = [
    alert('a1', 'overload', 'warn', 't1'),
    alert('a2', 'overlap', 'err', 't2', { peerId: 't3' }),
    alert('a3', 'late', 'warn', 't3'),
  ];
  M.init();
  M.setFocusTaskIds(null);
  M.setSessionProfile(null);
});

test('without a focus: focusIds is null and focusTaskIds() is null', () => {
  assert.equal(M.current().focusIds, null);
  assert.equal(M.focusTaskIds(), null);
  assert.deepEqual([...M.current().taskIds], ['t1']);
});

test('orderIds is the union of alertOrderIds over matched alerts (peers included)', () => {
  assert.deepEqual([...M.current().orderIds], ['t1']);
  M.setSessionProfile('p2');
  assert.deepEqual([...M.current().orderIds].sort(), ['t2', 't3']);
});

test('a focus keeps the fills ambient and sets focusIds = focus ∩ orderIds; fans out', () => {
  let fired = 0;
  const off = M.subscribe(() => { fired++; });
  M.setFocusTaskIds(new Set(['t1', 't2']));
  const c = M.current();
  assert.deepEqual([...c.taskIds], ['t1'], 'taskIds unchanged');
  assert.equal(c.sevByTask.get('t1'), 'warn');
  assert.equal(c.categoryByTask.get('t1'), 'capacity');
  assert.deepEqual([...c.focusIds], ['t1'], 't2 is outside the viewed profile: no outline');
  assert.deepEqual([...M.focusTaskIds()], ['t1']);
  assert.ok(fired >= 1);
  off();
});

test('clearing the focus restores null', () => {
  M.setFocusTaskIds(new Set(['t1']));
  M.setFocusTaskIds(null);
  assert.equal(M.current().focusIds, null);
});

test('a plant change drops the focus', () => {
  M.setFocusTaskIds(new Set(['t1']));
  Store.setSelectedPlant('P2', 'test');
  Store.setSelectedPlant('P1', 'test');
  assert.equal(M.current().focusIds, null);
});

test('the focus intersects with the active (session-picked) profile', () => {
  M.setSessionProfile('p2');
  M.setFocusTaskIds(new Set(['t1', 't3']));
  assert.deepEqual([...M.current().focusIds], ['t3'], 'the peer t3 is in the picked profile via alertOrderIds');
});

test('focus works under All alerts (orderIds filled there), fills stay empty', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: '__all__' } };
  M.recompute();
  const c = M.current();
  assert.deepEqual([...c.orderIds].sort(), ['t1', 't2', 't3']);
  assert.equal(c.taskIds.size, 0);
  assert.equal(c.categoryByTask.size, 0);
  M.setFocusTaskIds(new Set(['t3', 'zz']));
  assert.deepEqual([...M.current().focusIds], ['t3']);
});

test('D8: under All alerts sevByTask holds error orders only', () => {
  Store._state.userSettings = { alertProfileByPlant: { P1: '__all__' } };
  M.recompute();
  assert.deepEqual([...M.current().sevByTask.entries()], [['t2', 'err']]);
});

test('acknowledged: an order whose every matched alert is acked is not outlined unless the profile flag show_acknowledged is on', () => {
  acks.set('a1', { alertId: 'a1' });
  M.recompute();
  M.setFocusTaskIds(new Set(['t1']));
  assert.deepEqual([...M.current().focusIds], []);
  profiles[0].show_acknowledged = true;
  M.recompute();
  assert.deepEqual([...M.current().focusIds], ['t1']);
  Store._state.userSettings = { alertProfileByPlant: { P1: 'p1' }, alertsShowAcknowledged: true };
  profiles[0].show_acknowledged = false;
  M.recompute();
  assert.deepEqual([...M.current().focusIds], [], 'the retired user pref no longer reveals them');
});

test('focusTaskIds() follows the active profile: a focus matching only profile B is returned once B is picked', () => {
  M.setFocusTaskIds(new Set(['t2']));
  assert.equal(M.current().focusIds?.size ?? 0, 0, 'the saved profile p1 does not name t2');
  M.setSessionProfile('p2');
  assert.deepEqual([...M.current().focusIds], ['t2']);
  assert.deepEqual([...M.focusTaskIds()], ['t2'], 'the outline follows current()');
});

test('acknowledged: a mixed order (one alert acked, one live) is still outlined', () => {
  Store._state.alerts = [...Store._state.alerts, alert('a4', 'overload', 'warn', 't1')];
  acks.set('a1', { alertId: 'a1' });
  M.recompute();
  M.setFocusTaskIds(new Set(['t1']));
  assert.deepEqual([...M.current().focusIds], ['t1'], 'a4 is unacked, so t1 keeps its outline');
});
