// Tests for frontend/alert-monitor/alert-monitor-overview.mts — the pure data / narrow / HTML half of the Overview band.
// A DST zone, so the spring-forward / fall-back cases below really cross a DST change (Node reads TZ lazily).
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizonDays, overviewData } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';
import { groupAlerts, dayKeyOf } from '../../../frontend/insights/alert-profiles.mjs';

const TODAY = new Date(2026, 9, 20);   // 2026-10-20 local
const at = (off, h = 9) => new Date(2026, 9, 20 + off, h);
const keyFor = (off) => new Date(Date.UTC(2026, 9, 20 + off)).toISOString().slice(0, 10);
let seq = 0;
const alert = (o = {}) => ({ id: `a${++seq}`, sev: 'warn', type: 'overlap', line: 'L1', time: at(0), ...o });
const dueDeps = { dueInstant: (task) => new Date(task.original_end_date), latenessHours: () => 0 };
const base = (o = {}) => ({ tasksById: {}, plantToday: TODAY, horizonMinutes: 14 * 1440, window: null, deps: dueDeps, ...o });

// ---- horizonDays ----------------------------------------------------------------------------

test('horizonDays: window widens, clamps at 60, null window with 1440 minutes gives 1', () => {
  assert.equal(horizonDays(20160, { from: 0, to: 20 }), 21);
  assert.equal(horizonDays(20160, { from: 0, to: 80 }), 60);
  assert.equal(horizonDays(20160, null), 14);
  assert.equal(horizonDays(1440, null), 1);
  assert.equal(horizonDays(0, null), 1);
});

// ---- overviewData ---------------------------------------------------------------------------

test('overviewData: offsets -1/0/13/14/59 land in Overdue / day0 / day13 / Later / Later at N=14', () => {
  const alerts = [-1, 0, 13, 14, 59].map(o => alert({ time: at(o), sev: o === 0 ? 'err' : 'warn' }));
  const d = overviewData(alerts, base());
  assert.equal(d.days.length, 14);
  assert.equal(d.overdue.warn, 1);
  assert.equal(d.days[0].err, 1);
  assert.equal(d.days[13].warn, 1);
  assert.equal(d.later.warn, 2);
  assert.equal(d.total, 5);
  assert.equal(d.undated, 0);
});

test('overviewData: every column has a key from plantToday, zero-count columns included, consecutive across a DST change', () => {
  const d = overviewData([], base());
  assert.deepEqual(d.days.map(x => x.key), Array.from({ length: 14 }, (_, i) => keyFor(i)));
  assert.deepEqual(d.days.map(x => x.offset), Array.from({ length: 14 }, (_, i) => i));
  const dst = overviewData([], base({ plantToday: new Date(2026, 2, 5), horizonMinutes: 20 * 1440 }));
  assert.deepEqual(dst.days.map(x => x.key), Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 2, 5 + i)).toISOString().slice(0, 10)));
  const fall = overviewData([], base({ plantToday: new Date(2026, 9, 29), horizonMinutes: 10 * 1440 }));
  assert.deepEqual(fall.days.map(x => x.key), Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 29 + i)).toISOString().slice(0, 10)));
});

test('overviewData: a line-less alert lands on key none', () => {
  const a = alert({ line: undefined });
  const b = alert({ line: 'L2' });
  const d = overviewData([a, b], base());
  assert.ok(d.lines.some(l => l.line === 'none'));
});

test('overviewData: an undated alert counts toward total and undated only (no day bar, overdue or later)', () => {
  const a = alert({ time: null });
  const d = overviewData([a], base());
  assert.equal(d.total, 1);
  assert.equal(d.undated, 1);
  assert.equal(d.overdue.err + d.overdue.warn, 0);
  assert.equal(d.later.err + d.later.warn, 0);
  assert.ok(d.days.every(x => x.err + x.warn === 0));
});

test('overviewData: inWindow for {0,7} and {-2,3}; today', () => {
  const w1 = overviewData([], base({ window: { from: 0, to: 7 } }));
  assert.deepEqual(w1.days.map(x => x.inWindow).slice(0, 10), [true, true, true, true, true, true, true, true, false, false]);
  assert.equal(w1.overdue.inWindow, false);
  const w2 = overviewData([], base({ window: { from: -2, to: 3 } }));
  assert.equal(w2.overdue.inWindow, true);
  assert.equal(w2.days[3].inWindow, true);
  assert.equal(w2.days[4].inWindow, false);
  assert.equal(w2.days[0].isToday, true);
  assert.equal(w2.days[1].isToday, false);
});

test('overviewData: err/warn split, overload flag, line sort, category order with zeros', () => {
  const alerts = [
    alert({ line: 'B', sev: 'err', type: 'overload' }),
    alert({ line: 'B', sev: 'warn' }),
    alert({ line: 'A', sev: 'warn' }),
    alert({ line: 'C', sev: 'warn' }),
    alert({ line: 'C', sev: 'err', type: 'blackout' }),
    alert({ line: 'D', sev: 'warn', type: 'setup-violated' }),
  ];
  const d = overviewData(alerts, base());
  assert.deepEqual(d.lines.map(l => l.line), ['B', 'C', 'A', 'D']);
  assert.equal(d.lines[0].err, 1);
  assert.equal(d.lines[0].warn, 1);
  assert.equal(d.lines[0].overload, true);
  assert.equal(d.lines[1].overload, false);
  assert.deepEqual(d.days[0], { ...d.days[0], err: 2, warn: 4 });
  assert.deepEqual(d.categories.map(c => c.cat), ['capacity', 'conflicts', 'calendar', 'setup', 'planning', 'late', 'exceptions']);
  assert.deepEqual(d.categories.map(c => c.count), [1, 3, 1, 1, 0, 0, 0]);
  assert.equal(d.maxDay, 6);
});

test('overviewData: the D15 anchor (task due in 5 days, alert time today) puts the alert on day 5', () => {
  const a = alert({ taskId: 'T1', time: at(0) });
  const tasksById = { T1: { original_end_date: at(5, 12).toISOString() } };
  const d = overviewData([a], base({ tasksById }));
  assert.equal(d.days[5].warn, 1);
  assert.equal(d.days[0].warn, 0);
});

test('overviewData: a day key equals the groupAlerts day key', () => {
  const a = alert({ taskId: 'T1', time: at(0) });
  const tasksById = { T1: { original_end_date: at(3, 23).toISOString() } };
  const d = overviewData([a], base({ tasksById }));
  const g = groupAlerts([a], 'day', { tasksById, horizonStart: TODAY, horizonMinutes: 14 * 1440, plantToday: TODAY, deps: dueDeps });
  const bar = d.days.find(x => x.warn === 1);
  assert.equal(bar.key, g[0].key);
  assert.equal(dayKeyOf(at(3, 23)), bar.key);
});

// ---- narrow ---------------------------------------------------------------------------------

test('the per-call due memo: one dueInstant call per task, same bins as the unmemoised anchor, an unresolvable due falls back to the alert time', () => {
  const calls = new Map();
  const deps = { dueInstant: task => { calls.set(task.id, (calls.get(task.id) ?? 0) + 1); return task.id === 'bad' ? null : new Date(task.original_end_date); }, latenessHours: () => 0 };
  const tasksById = { t1: { id: 't1', original_end_date: at(3) }, bad: { id: 'bad', original_end_date: at(9) } };
  const alerts = [
    alert({ taskId: 't1', time: at(0) }), alert({ taskId: 't1', time: at(1) }), alert({ taskId: 't1', time: at(2) }),
    alert({ taskId: 'bad', time: at(1) }), alert({ taskId: 'bad', time: at(5) }),
  ];
  const d = base({ tasksById, deps });
  const data = overviewData(alerts, d);
  assert.equal(calls.get('t1'), 1);
  assert.equal(calls.get('bad'), 1);
  assert.equal(data.days[3].warn, 3, 'the three t1 alerts sit on their due day');
  assert.equal(data.days[1].warn, 1);
  assert.equal(data.days[5].warn, 1, 'a due that does not resolve anchors on the alert time');
  calls.clear();
});
