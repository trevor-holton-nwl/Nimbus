// Parity tests for the confidence formula exposed on NimbusComputeCore
// (the single source for Confidence._recompute / showBreakdown and the Alert Monitor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../../../frontend/nimbus-compute-core.js');

const DAY = 86400000;
const H0 = new Date(2026, 9, 20, 8, 0, 0);
const H1 = new Date(H0.getTime() + 14 * DAY);
const at = days => new Date(H0.getTime() + days * DAY);
const alert = (sev, days) => ({ sev, time: at(days) });
const row = (scheduled, effectiveCapacity) => ({ scheduled, effectiveCapacity });

test('CONFIDENCE_WEIGHTS: points, time weights and the per-machine curve scale (no caps)', () => {
  assert.deepEqual({ ...Core.CONFIDENCE_WEIGHTS }, { err: 5, warn: 2, tw3: 1.5, tw7: 1.25, perMachine: 20 });
});

test('timeWeight bands: <=3d 1.5, <=7d 1.25, else 1.0 (boundaries inclusive)', () => {
  assert.equal(Core.timeWeight(at(3), H0), 1.5);
  assert.equal(Core.timeWeight(new Date(at(3).getTime() + 1), H0), 1.25);
  assert.equal(Core.timeWeight(at(7), H0), 1.25);
  assert.equal(Core.timeWeight(new Date(at(7).getTime() + 1), H0), 1.0);
  assert.equal(Core.timeWeight(at(10), H0), 1.0);
});

test('alertPoints: base x weight; out-of-horizon and no-time give 0; horizonEnd excluded', () => {
  assert.equal(Core.alertPoints(alert('err', 1), H0, H1), 7.5);
  assert.equal(Core.alertPoints(alert('warn', 5), H0, H1), 2.5);
  assert.equal(Core.alertPoints(alert('warn', 10), H0, H1), 2);
  assert.equal(Core.alertPoints({ sev: 'info', time: at(1) }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err' }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err', time: new Date(H0.getTime() - 1) }, H0, H1), 7.5); // earlier today counts as due now
  assert.equal(Core.alertPoints({ sev: 'err', time: new Date(H0.getTime() - DAY) }, H0, H1), 0);  // an earlier day is history
  assert.equal(Core.alertPoints({ sev: 'err', time: H1 }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err', time: H0 }, H0, H1), 7.5);
});

const FAR = 10; // days out: weight 1.0, so a critical is exactly 5 raw points
const crit = n => Array.from({ length: n }, () => alert('err', FAR));
const score = (alerts, machines) => Core.scoreConfidence({ alerts, horizonStart: H0, horizonMinutes: 14 * 1440, machines }).score;

test('scoreConfidence: empty alerts -> 100, nothing else to attribute', () => {
  const r = Core.scoreConfidence({ alerts: [], horizonStart: H0, horizonMinutes: 14 * 1440 });
  assert.deepEqual({ ...r }, {
    score: 100, penalty: 0, errPenalty: 0, warnPenalty: 0, rawAlertPoints: 0, rawErrPoints: 0, rawWarnPoints: 0, machines: 5,
  });
});

test('curve pins on a 5-machine plant (K = 100): 0/1/10/20/50 criticals -> 100/95/61/37/8', () => {
  assert.deepEqual([0, 1, 10, 20, 50].map(n => score(crit(n), 5)), [100, 95, 61, 37, 8]);
  assert.equal(score(crit(10)), 61); // machines absent defaults to 5
});

test('curve is scaled per machine: the same alerts cost a big plant far less', () => {
  assert.equal(score(crit(10), 70), 96); // exp(-50 / 1400)
  assert.ok(score(crit(10), 70) > score(crit(10), 5));
});

test('score is never negative, always in (0,100], and keeps decreasing as alerts are added', () => {
  let prev = 101;
  for (let n = 0; n <= 40; n++) {
    const sc = score(crit(n), 5);
    assert.ok(sc >= 0 && sc <= 100);
    assert.ok(sc <= prev);                       // rounding can repeat a value for one step...
    if (n >= 3) assert.ok(sc < score(crit(n - 3), 5)); // ...never across three
    prev = sc;
  }
  assert.ok(score(crit(2000), 5) >= 0);
  const raw = Core.scoreConfidence({ alerts: crit(20), horizonStart: H0, horizonMinutes: 14 * 1440, machines: 5 });
  assert.ok(raw.rawAlertPoints > raw.penalty - 1); // no cap: raw keeps growing past the old 50
});

test('an overloaded day is counted once: only alert points feed the score (no utilisation input)', () => {
  const r = Core.scoreConfidence({
    alerts: [alert('err', FAR)], matrix: { A: { d1: row(10, 8) } }, overloadedLineDays: 9, horizonStart: H0, horizonMinutes: 14 * 1440,
  });
  assert.equal(r.score, 95);
  assert.equal('utilPenalty' in r, false);
  assert.equal('overloadedLineDays' in r, false);
});

test('past-due late/queued alerts (with a due) count at weight 1.5; a non-due alert before the horizon start is history', () => {
  const pastDue = { sev: 'warn', time: at(-2), due: at(-2) };
  assert.equal(Core.alertPoints(pastDue, H0, H1), 3);            // 2 x 1.5
  assert.equal(Core.alertPoints({ sev: 'err', time: at(-2) }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err', time: at(-2), due: at(-30) }, H0, H1), 7.5);
});

test("today's overload (dated noon) counts at weight 1.5 after noon; the same alert dated yesterday scores 0", () => {
  const h = new Date(2026, 9, 20, 15, 0, 0);
  const end = new Date(h.getTime() + 14 * DAY);
  const noonToday = { sev: 'err', type: 'overload', time: new Date(2026, 9, 20, 12, 0, 0) };
  const noonYesterday = { sev: 'err', type: 'overload', time: new Date(2026, 9, 19, 12, 0, 0) };
  assert.equal(Core.alertPoints(noonToday, h, end), 7.5);
  assert.equal(Core.alertPoints(noonYesterday, h, end), 0);
  assert.equal(Core.alertPoints({ ...noonToday, time: new Date(2026, 9, 20, 0, 0, 0) }, h, end), 7.5);
  assert.equal(Core.alertPoints({ ...noonToday, time: new Date(2026, 9, 19, 23, 59, 59) }, h, end), 0);
});

test('a late alert whose finish is beyond the horizon but whose due is inside still counts, by its due date', () => {
  const late = { sev: 'warn', time: at(20), due: at(5) };
  assert.equal(Core.alertPoints(late, H0, H1), 2.5);             // 2 x 1.25 (due, not finish)
  assert.equal(Core.alertPoints({ sev: 'warn', time: at(5), due: at(20) }, H0, H1), 0); // due beyond the horizon
});

test('err and warn penalties are shares of the penalty and add up exactly', () => {
  for (const [e, w, m] of [[1, 1, 5], [3, 7, 5], [0, 4, 5], [5, 0, 70], [13, 29, 12], [1, 40, 1]]) {
    const alerts = [...crit(e), ...Array.from({ length: w }, () => alert('warn', FAR))];
    const r = Core.scoreConfidence({ alerts, horizonStart: H0, horizonMinutes: 14 * 1440, machines: m });
    assert.equal(r.errPenalty + r.warnPenalty, 100 - r.score, JSON.stringify([e, w, m]));
    assert.equal(r.penalty, 100 - r.score);
    assert.equal(r.rawErrPoints, 5 * e);
    assert.equal(r.rawWarnPoints, 2 * w);
    if (e === 0) assert.equal(r.errPenalty, 0);
    if (w === 0) assert.equal(r.warnPenalty, 0);
  }
});

test('scoreConfidence uses horizonMinutes for the horizon end', () => {
  const a = [alert('err', 5)];
  assert.equal(Core.scoreConfidence({ alerts: a, horizonStart: H0, horizonMinutes: 5 * 1440 }).score, 100);
  assert.equal(Core.scoreConfidence({ alerts: a, horizonStart: H0, horizonMinutes: 5 * 1440 + 1 }).score, 94); // 6.25 raw
});

test('setup-uncovered alert carries pairKey and scope; others without them get null', () => {
  const time = new Date(Date.now() + DAY);
  const workHours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [0, 24]]));
  const { alerts } = Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }] },
    dismissed: [], opts: {},
    setup: { intervals: [], diagnostics: [
      { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 's', time },
      { type: 'initial-state-unknown', line: 'L', successorOrderId: 'n', time },
    ] },
  });
  const unc = alerts.find(a => a.type === 'setup-uncovered');
  assert.equal(unc.pairKey, 'RED->BLUE');
  assert.equal(unc.scope, 'P/L');
  const init = alerts.find(a => a.type === 'initial-state-unknown');
  assert.equal(init.pairKey, null);
  assert.equal(init.scope, null);
});

test('dueDateInstant is exported', () => {
  assert.equal(typeof Core.dueDateInstant, 'function');
});
