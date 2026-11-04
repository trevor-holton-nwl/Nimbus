// Parity: the shared run-params leaf must equal the three per-file implementations it replaced (P3-5a).
process.env.TZ = 'America/New_York';   // DST-observing zone; node reads TZ at first Date use in this process
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarMonths, backlogWindow, budgetFor, RUN_MODES, isRunMode,
  SETUP_AWARE_NORMAL_BUDGET_MS, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS,
} from '../../../frontend/optimization/run-params.mjs';
import { OPTIMIZER_MODES } from '../../../frontend/optimization/optimizer-prefs.mjs';
import * as Engine from '../../../frontend/optimization/engine.mjs';

// ---- verbatim copies of the replaced implementations ----
function oldAddCalendarMonths(date, months) {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, last));
  return result;
}
function oldDialogWindow(tasks, now, scopedLines) {   // optimize-ui _applyBacklogDefaults
  tasks = tasks.filter(t => !scopedLines || scopedLines.has(t.MACHINE));
  const pastStarts = tasks.map(t => t.start_date).filter(d => !!d && d < now);
  const latestEnds = tasks.map(t => t.end_date).filter(d => !!d);
  const computedStart = pastStarts.length ? new Date(Math.min(...pastStarts.map(d => d.getTime()))) : now;
  let computedEnd = latestEnds.length
    ? new Date(Math.min(Math.max(...latestEnds.map(d => d.getTime())), oldAddCalendarMonths(now, 4).getTime()))
    : oldAddCalendarMonths(now, 4);
  if (computedEnd < computedStart) computedEnd = oldAddCalendarMonths(computedStart, 4);
  return { start: computedStart, end: computedEnd };
}
function oldHeadlessWindow(tasks, plantNow, lineSet) {   // headless-cli backlogWindow
  const scoped = tasks.filter(task => !lineSet || lineSet.has(String(task.MACHINE ?? 'Unknown')));
  const past = scoped.map(task => task.start_date).filter(d => !!d && d < plantNow);
  const ends = scoped.map(task => task.end_date).filter(d => !!d);
  const capEnd = oldAddCalendarMonths(plantNow, 4);
  const start = past.length ? new Date(Math.min(...past.map(d => d.getTime()))) : new Date(plantNow);
  let end = ends.length ? new Date(Math.min(Math.max(...ends.map(d => d.getTime())), capEnd.getTime())) : capEnd;
  if (end < start) end = oldAddCalendarMonths(start, 4);
  return { start, end };
}
const same = (a, b) => { assert.equal(a.start.getTime(), b.start.getTime()); assert.equal(a.end.getTime(), b.end.getTime()); };

test('addCalendarMonths matches the old copies at month ends, leap days and DST changes', () => {
  const dates = [
    '2026-01-31T09:00', '2026-03-31T00:00', '2026-05-31T23:59', '2024-02-29T12:00', '2026-10-31T10:00',
    '2026-03-08T01:30', '2026-03-08T03:30', '2026-11-01T00:30', '2026-11-01T05:00', '2026-12-31T00:00',
    '2026-11-03T08:15',
  ].map(s => new Date(s));
  for (const d of dates) for (const m of [-13, -1, 0, 1, 4, 12, 25]) {
    assert.equal(addCalendarMonths(d, m).getTime(), oldAddCalendarMonths(d, m).getTime(), `${d.toISOString()} +${m}`);
  }
  const src = new Date('2026-01-31T09:00'); addCalendarMonths(src, 1);
  assert.equal(src.getTime(), new Date('2026-01-31T09:00').getTime(), 'input is not mutated');
  assert.equal(addCalendarMonths(new Date('2026-01-31T09:00'), 1).getDate(), 28);
});

test('backlogWindow equals the dialog and headless windows across scenarios', () => {
  const d = (s) => new Date(s);
  const now = d('2026-11-03T08:00');
  const T = (MACHINE, s, e) => ({ MACHINE, start_date: s ? d(s) : null, end_date: e ? d(e) : null });
  const scenarios = {
    empty: [],
    nothingPast: [T('L1', '2026-11-05T00:00', '2026-11-06T00:00')],
    pastAndFuture: [T('L1', '2026-10-01T00:00', '2026-10-02T00:00'), T('L2', '2026-09-20T00:00', '2026-12-01T00:00'), T('L1', '2026-11-10T00:00', '2027-06-01T00:00')],
    beyondCap: [T('L1', '2026-10-01T00:00', '2028-01-01T00:00')],
    endBeforeStart: [T('L1', '2026-10-01T00:00', '2026-09-01T00:00')],
    nullDates: [T('L1', null, null), T('L2', '2026-10-10T00:00', null), T('L3', null, '2026-12-12T00:00')],
    startEqualsNow: [T('L1', '2026-11-03T08:00', '2026-11-04T00:00')],
  };
  for (const [name, tasks] of Object.entries(scenarios)) for (const lines of [null, new Set(['L1']), new Set(['L2', 'L3'])]) {
    const got = backlogWindow(tasks, now, lines);
    same(got, oldDialogWindow(tasks, now, lines));
    same(got, oldHeadlessWindow(tasks, now, lines));
    assert.notEqual(got.start, now, `${name}: start is a copy`);
  }
  // DST: a "now" just before spring-forward and fall-back
  for (const nowS of ['2026-03-08T01:00', '2026-11-01T00:30']) {
    const n = d(nowS);
    same(backlogWindow(scenarios.pastAndFuture, n), oldDialogWindow(scenarios.pastAndFuture, n, null));
  }
});

test('a task with no machine belongs to "Unknown" (the documented MACHINE || Unknown key)', () => {
  const now = new Date('2026-11-03T08:00');
  const tasks = [{ MACHINE: '', start_date: new Date('2026-10-01T00:00'), end_date: new Date('2026-10-02T00:00') },
                 { MACHINE: undefined, start_date: new Date('2026-09-01T00:00'), end_date: new Date('2026-09-02T00:00') }];
  assert.equal(backlogWindow(tasks, now, new Set(['Unknown'])).start.getTime(), new Date('2026-09-01T00:00').getTime());
  assert.equal(backlogWindow(tasks, now, new Set(['L1'])).start.getTime(), now.getTime());
});

test('backlogWindow handles very large order lists (no spread)', () => {
  const now = new Date('2026-11-03T08:00');
  const tasks = Array.from({ length: 300000 }, (_, i) => ({ MACHINE: 'L', start_date: new Date(now.getTime() - i * 1000), end_date: new Date(now.getTime() + i * 1000) }));
  assert.equal(backlogWindow(tasks, now).start.getTime(), now.getTime() - 299999 * 1000);
});

test('budgetFor and the budget constants agree with the engine exports; mode list is the four strategies', () => {
  assert.equal(budgetFor(false), Engine.SETUP_AWARE_NORMAL_BUDGET_MS);
  assert.equal(budgetFor(true), Engine.SETUP_AWARE_EXHAUSTIVE_BUDGET_MS);
  assert.equal(SETUP_AWARE_NORMAL_BUDGET_MS, 8000);
  assert.equal(SETUP_AWARE_EXHAUSTIVE_BUDGET_MS, 180000);
  assert.deepEqual([...RUN_MODES], ['spt', 'changeover', 'duedate', 'backlog']);
  assert.deepEqual(OPTIMIZER_MODES.map(m => m.value), [...RUN_MODES]);
  for (const m of RUN_MODES) assert.ok(isRunMode(m));
  for (const m of ['combined', '', null, undefined, 5]) assert.equal(isRunMode(m), false);
});
