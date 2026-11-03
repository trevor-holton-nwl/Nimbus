// Tests for frontend/alert-monitor/alert-monitor-overview.mts — the pure day-bucket helpers that remain after the Overview band
// was retired: the bucket keys, horizonDayKeys, horizonDays and the per-call due memo. The bucketing rule itself is makeBucketer's
// (alert-monitor-model.mts), exercised here over the same keys.
// A DST zone, so the spring-forward / fall-back cases below really cross a DST change (Node reads TZ lazily).
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizonDays, horizonDayKeys, _memoAnchor, OVERDUE_KEY, LATER_KEY, NONE_KEY } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';
import { makeBucketer } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { groupAlerts, dayKeyOf } from '../../../frontend/insights/alert-profiles.mjs';

const TODAY = new Date(2026, 9, 20);   // 2026-10-20 local
const at = (off, h = 9) => new Date(2026, 9, 20 + off, h);
const keyFor = (off) => new Date(Date.UTC(2026, 9, 20 + off)).toISOString().slice(0, 10);
let seq = 0;
const alert = (o = {}) => ({ id: `a${++seq}`, sev: 'warn', type: 'overlap', line: 'L1', time: at(0), ...o });
const dueDeps = { dueInstant: (task) => new Date(task.original_end_date), latenessHours: () => 0 };

// ---- keys -----------------------------------------------------------------------------------

test('the bucket sentinels: overdue, later and none (NONE_KEY is the insights sentinel)', () => {
  assert.equal(OVERDUE_KEY, 'overdue');
  assert.equal(LATER_KEY, 'later');
  assert.equal(NONE_KEY, 'none');
});

// ---- horizonDays ----------------------------------------------------------------------------

test('horizonDays: window widens, clamps at 60, null window with 1440 minutes gives 1', () => {
  assert.equal(horizonDays(20160, { from: 0, to: 20 }), 21);
  assert.equal(horizonDays(20160, { from: 0, to: 80 }), 60);
  assert.equal(horizonDays(60 * 1440, null), 60);
  assert.equal(horizonDays(90 * 1440, null), 60, 'a horizon past 60 days clamps; the late days land in the later bucket');
  assert.equal(horizonDays(20160, null), 14);
  assert.equal(horizonDays(1440, null), 1);
  assert.equal(horizonDays(0, null), 1);
});

// ---- horizonDayKeys + the bucketer over them -------------------------------------------------

test('horizonDayKeys: consecutive local keys from plantToday, across spring-forward and fall-back', () => {
  assert.deepEqual(horizonDayKeys(TODAY, 14), Array.from({ length: 14 }, (_, i) => keyFor(i)));
  assert.deepEqual(horizonDayKeys(new Date(2026, 2, 5), 20), Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 2, 5 + i)).toISOString().slice(0, 10)));
  assert.deepEqual(horizonDayKeys(new Date(2026, 9, 29), 10), Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 29 + i)).toISOString().slice(0, 10)));
  assert.deepEqual(horizonDayKeys(TODAY, 0), []);
});

test('makeBucketer: offsets -1/0/13/14/59 land in overdue / day0 / day13 / later / later at N=14; no anchor is none', () => {
  const b = makeBucketer({ plantToday: TODAY, horizonDays: 14 });
  const keys = horizonDayKeys(TODAY, 14);
  assert.equal(b(alert({ time: at(-1) })), OVERDUE_KEY);
  assert.equal(b(alert({ time: at(0) })), keys[0]);
  assert.equal(b(alert({ time: at(13, 23) })), keys[13]);
  assert.equal(b(alert({ time: at(14) })), LATER_KEY);
  assert.equal(b(alert({ time: at(59) })), LATER_KEY);
  assert.equal(b(alert({ time: null })), NONE_KEY);
});

test('makeBucketer: a day key equals the groupAlerts day key (the due anchor beats the alert time)', () => {
  const a = alert({ taskId: 'T1', time: at(0) });
  const tasksById = { T1: { original_end_date: at(3, 23).toISOString() } };
  const anchorOf = al => _memoAnchor({ deps: dueDeps })(al, tasksById[al.taskId]);
  const key = makeBucketer({ plantToday: TODAY, horizonDays: 14, anchorOf })(a);
  const g = groupAlerts([a], 'day', { tasksById, horizonStart: TODAY, horizonMinutes: 14 * 1440, plantToday: TODAY, deps: dueDeps });
  assert.equal(key, g[0].key);
  assert.equal(key, dayKeyOf(at(3, 23)));
  assert.equal(key, horizonDayKeys(TODAY, 14)[3]);
});

// ---- _memoAnchor ----------------------------------------------------------------------------

test('the per-call due memo: one dueInstant call per task, same bins as the unmemoised anchor, an unresolvable due falls back to the alert time', () => {
  const calls = new Map();
  const deps = { dueInstant: task => { calls.set(task.id, (calls.get(task.id) ?? 0) + 1); return task.id === 'bad' ? null : new Date(task.original_end_date); }, latenessHours: () => 0 };
  const tasksById = { t1: { id: 't1', original_end_date: at(3) }, bad: { id: 'bad', original_end_date: at(9) } };
  const alerts = [
    alert({ taskId: 't1', time: at(0) }), alert({ taskId: 't1', time: at(1) }), alert({ taskId: 't1', time: at(2) }),
    alert({ taskId: 'bad', time: at(1) }), alert({ taskId: 'bad', time: at(5) }),
  ];
  const anchor = _memoAnchor({ tasksById, plantToday: TODAY, horizonMinutes: 14 * 1440, window: null, deps });
  const bucket = makeBucketer({ plantToday: TODAY, horizonDays: 14, anchorOf: a => anchor(a, tasksById[a.taskId]) });
  const keys = horizonDayKeys(TODAY, 14);
  const count = {};
  for (const a of alerts) { const k = bucket(a); count[k] = (count[k] ?? 0) + 1; }
  assert.equal(calls.get('t1'), 1);
  assert.equal(calls.get('bad'), 1);
  assert.equal(count[keys[3]], 3, 'the three t1 alerts sit on their due day');
  assert.equal(count[keys[1]], 1);
  assert.equal(count[keys[5]], 1, 'a due that does not resolve anchors on the alert time');
});

test('the per-call due memo: no order or no due falls back to the own time; an invalid own time is no anchor', () => {
  const anchor = _memoAnchor({ tasksById: {}, plantToday: TODAY, horizonMinutes: 1440, window: null, deps: dueDeps });
  const own = at(2);
  assert.equal(anchor(alert({ time: own }), undefined), own);
  assert.equal(anchor(alert({ taskId: 'T', time: own }), { original_end_date: null }), own);
  assert.equal(anchor(alert({ time: null }), undefined), null);
  assert.equal(anchor(alert({ time: new Date('x') }), undefined), null);
});
