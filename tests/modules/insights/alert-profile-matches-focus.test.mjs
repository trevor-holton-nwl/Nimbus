// AlertProfileMatches.setFocusTaskIds — the Gantt follows a focused leverage card instead of the profile.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';
import { AlertProfileClient } from '../../../frontend/insights/alert-profile-client.mjs';
import { AlertAcksClient } from '../../../frontend/insights/alert-acks-client.mjs';
import { AlertProfileMatches as M } from '../../../frontend/insights/alert-profile-matches.mjs';

const rule = types => ({ types, dayFrom: null, dayTo: null, minSev: null, minLateHours: null });
const prof = (id, types) => ({ id, plant: 'P1', name: id, description: '', rules: [rule(types)], ranking: 'impact' });
const alert = (id, type, sev, taskId, extra = {}) => ({ id, type, sev, taskId, time: new Date(2026, 9, 20, 8), ...extra });

beforeEach(t => {
  const profiles = [prof('p1', ['overload'])];
  t.mock.method(AlertProfileClient, 'cached', () => profiles);
  t.mock.method(AlertProfileClient, 'list', async () => profiles);
  t.mock.method(AlertAcksClient, 'cached', () => new Map());
  t.mock.method(AlertAcksClient, 'load', async () => new Map());
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

test('without a focus the profile decides the highlighted orders', () => {
  assert.deepEqual([...M.current().taskIds], ['t1']);
});

test('a focus replaces taskIds / sevByTask / categoryByTask with the focused orders and fans out', () => {
  let fired = 0;
  const off = M.subscribe(() => { fired++; });
  M.setFocusTaskIds(new Set(['t2', 't3']));
  const c = M.current();
  assert.deepEqual([...c.taskIds].sort(), ['t2', 't3']);
  assert.equal(c.sevByTask.get('t2'), 'err');
  assert.equal(c.sevByTask.get('t3'), 'err', 'the overlap names t3 as the peer, so its worst severity is err');
  assert.equal(c.categoryByTask.get('t2'), 'conflicts');
  assert.ok(!c.taskIds.has('t1'), 'the profile match is not highlighted while focused');
  assert.ok(fired >= 1, 'subscribers are told');
  off();
});

test('clearing the focus restores the profile match', () => {
  M.setFocusTaskIds(new Set(['t2']));
  M.setFocusTaskIds(null);
  assert.deepEqual([...M.current().taskIds], ['t1']);
});

test('a plant change drops the focus', () => {
  M.setFocusTaskIds(new Set(['t2']));
  Store.setSelectedPlant('P2', 'test');
  Store.setSelectedPlant('P1', 'test');
  assert.deepEqual([...M.current().taskIds], ['t1']);
});
