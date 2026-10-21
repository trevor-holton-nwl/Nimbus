// Micro-benchmark for the Alert Monitor's per-paint cost at enterprise scale (final-review I3).
// Skipped unless NIMBUS_BENCH=1:  NIMBUS_BENCH=1 node --test tests/modules/alert-monitor/alert-monitor-bench.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAlerts } from '../../../frontend/insights/alert-profiles.mjs';
import { rowHtml, GROUP_ROW_CAP } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const BENCH = process.env.NIMBUS_BENCH === '1';
const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;
const N_ALERTS = 15000, N_LINES = 70, N_ORDERS = 3000;
const day0 = new Date(2026, 9, 20);

function synth() {
  const out = [];
  for (let i = 0; i < N_ALERTS; i++) {
    const order = i % N_ORDERS;
    out.push({
      id: `a${i}`, sev: i % 3 === 0 ? 'err' : 'warn', type: i % 2 ? 'overlap' : 'late',
      line: `L${String(i % N_LINES).padStart(2, '0')}`, taskId: String(order), peerId: i % 2 ? String((order + 1) % N_ORDERS) : undefined,
      time: new Date(2026, 9, 20 + (i % 14), 8 + (i % 8)), msgVars: {},
    });
  }
  return out;
}

const ms = (f) => { const s = performance.now(); const r = f(); return [performance.now() - s, r]; };

test('bench: groupAlerts + row building at 15,000 alerts across 70 lines', { skip: !BENCH && 'set NIMBUS_BENCH=1 to run' }, () => {
  const alerts = synth();
  const ctx = { tasksById: {}, horizonStart: day0, horizonMinutes: 14 * 1440, plantToday: day0, deps: { dueInstant: () => null, latenessHours: () => 0 } };
  const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

  const [gLine, byLine] = ms(() => groupAlerts(alerts, 'line', ctx));
  const [gNone, byNone] = ms(() => groupAlerts(alerts, 'none', ctx));
  assert.equal(byLine.length, N_LINES);
  assert.equal(byNone.length, 1);
  assert.equal(byNone[0].orderIds.length, N_ORDERS);
  assert.equal(new Set(byNone[0].orderIds).size, N_ORDERS, 'orderIds stay de-duplicated');

  const view = (a, dateText) => ({
    id: a.id, type: a.type, sev: a.sev, taskId: a.taskId, line: a.line, time: a.time, headline: 'Order overlap',
    message: 'Overlaps 4500118 by 2 h', help: '', orderNo: a.taskId, groupBy: 'line', dateText, relText: 'in 1 days', overdue: false,
    anchorTip: 'am.anchor_time: x', whatIf: false, ackLabel: null, diagOpen: false, diagHtml: '',
  });
  const build = (dateOf) => {
    let n = 0;
    for (const g of byLine) for (const a of g.alerts.slice(0, GROUP_ROW_CAP)) n += rowHtml(view(a, dateOf(a.time)), t).length;
    return n;
  };
  const [rowsCached] = ms(() => build(d => fmt.format(d)));
  const [rowsPerCall] = ms(() => build(d => d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })));

  console.log(`[bench] ${N_ALERTS} alerts / ${N_LINES} lines: groupAlerts(line) ${gLine.toFixed(1)} ms, groupAlerts(none) ${gNone.toFixed(1)} ms; `
    + `rows (${N_LINES}x${GROUP_ROW_CAP} = ${N_LINES * GROUP_ROW_CAP}) cached formatter ${rowsCached.toFixed(1)} ms vs per-call toLocaleDateString ${rowsPerCall.toFixed(1)} ms`);
});
