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

test('CONFIDENCE_WEIGHTS carries the legacy constants', () => {
  assert.deepEqual({ ...Core.CONFIDENCE_WEIGHTS }, {
    err: 5, warn: 2, tw3: 1.5, tw7: 1.25, alertCap: 50, utilCap: 20, perOverload: 1.5,
  });
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
  assert.equal(Core.alertPoints({ sev: 'err', time: new Date(H0.getTime() - 1) }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err', time: H1 }, H0, H1), 0);
  assert.equal(Core.alertPoints({ sev: 'err', time: H0 }, H0, H1), 7.5);
});

test('countOverloadedLineDays counts rows with capacity > 0 and scheduled > capacity', () => {
  const matrix = { A: { d1: row(10, 8), d2: row(8, 8), d3: row(5, 0) }, B: { d1: row(9, 8) } };
  assert.equal(Core.countOverloadedLineDays(matrix), 2);
  assert.equal(Core.countOverloadedLineDays(null), 0);
});

test('scoreConfidence: empty alerts -> 100', () => {
  const r = Core.scoreConfidence({ alerts: [], horizonStart: H0, horizonMinutes: 14 * 1440 });
  assert.deepEqual({ ...r }, { score: 100, alertPenalty: 0, utilPenalty: 0, rawAlertPoints: 0, overloadedLineDays: 0 });
});

test('scoreConfidence rounds the sum once, then caps alerts at 50', () => {
  // 3 x 2.5 = 7.5 -> round 8 (rounding the sum, not each item: 3 x round(2.5)=9 would differ)
  const r = Core.scoreConfidence({ alerts: [alert('warn', 5), alert('warn', 5), alert('warn', 5)], horizonStart: H0, horizonMinutes: 14 * 1440 });
  assert.equal(r.rawAlertPoints, 7.5);
  assert.equal(r.alertPenalty, 8);
  assert.equal(r.score, 92);
  const many = Array.from({ length: 10 }, () => alert('err', 1)); // 75 raw
  const c = Core.scoreConfidence({ alerts: many, horizonStart: H0, horizonMinutes: 14 * 1440 });
  assert.equal(c.rawAlertPoints, 75);
  assert.equal(c.alertPenalty, 50);
  assert.equal(c.score, 50);
});

test('scoreConfidence caps util at exactly 20 and clamps score at 0', () => {
  const row13 = Array.from({ length: 13 }, (_, i) => [`d${i}`, row(10, 8)]);
  const matrix = { A: Object.fromEntries(row13) }; // 13 x 1.5 = 19.5 -> 20
  const r = Core.scoreConfidence({ alerts: [], matrix, horizonStart: H0, horizonMinutes: 14 * 1440 });
  assert.equal(r.overloadedLineDays, 13);
  assert.equal(r.utilPenalty, 20);
  const m14 = { A: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`d${i}`, row(10, 8)])) }; // 21 -> cap 20
  assert.equal(Core.scoreConfidence({ alerts: [], matrix: m14, horizonStart: H0, horizonMinutes: 1 }).utilPenalty, 20);
  const r2 = Core.scoreConfidence({ alerts: [], overloadedLineDays: 4, horizonStart: H0, horizonMinutes: 1 });
  assert.equal(r2.utilPenalty, 6);
  assert.equal(r2.score, 94);
});

test('scoreConfidence uses horizonMinutes for the horizon end', () => {
  const a = [alert('err', 5)];
  assert.equal(Core.scoreConfidence({ alerts: a, horizonStart: H0, horizonMinutes: 5 * 1440 }).alertPenalty, 0);
  assert.equal(Core.scoreConfidence({ alerts: a, horizonStart: H0, horizonMinutes: 5 * 1440 + 1 }).alertPenalty, 6);
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
