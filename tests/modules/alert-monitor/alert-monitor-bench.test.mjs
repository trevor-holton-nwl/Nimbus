// Micro-benchmark for the Alert Monitor's per-paint cost at enterprise scale (final-review I3).
// Skipped unless NIMBUS_BENCH=1:  NIMBUS_BENCH=1 node --test tests/modules/alert-monitor/alert-monitor-bench.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { groupAlerts } from '../../../frontend/insights/alert-profiles.mjs';
import { legacyRowHtml, GROUP_ROW_CAP } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { emptyFilter, filterAlerts } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { matrixModel, matrixHtml } from '../../../frontend/alert-monitor/alert-monitor-matrix.mjs';
import { overviewData, applyNarrow } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';

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
    for (const g of byLine) for (const a of g.alerts.slice(0, GROUP_ROW_CAP)) n += legacyRowHtml(view(a, dateOf(a.time)), t).length;
    return n;
  };
  const [rowsCached] = ms(() => build(d => fmt.format(d)));
  const [rowsPerCall] = ms(() => build(d => d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })));

  console.log(`[bench] ${N_ALERTS} alerts / ${N_LINES} lines: groupAlerts(line) ${gLine.toFixed(1)} ms, groupAlerts(none) ${gNone.toFixed(1)} ms; `
    + `rows (${N_LINES}x${GROUP_ROW_CAP} = ${N_LINES * GROUP_ROW_CAP}) cached formatter ${rowsCached.toFixed(1)} ms vs per-call toLocaleDateString ${rowsPerCall.toFixed(1)} ms`);
});

test('bench: overviewData + applyNarrow at 15,000 alerts across 70 lines (the real Util.dueInstant path)', { skip: !BENCH && 'set NIMBUS_BENCH=1 to run' }, () => {
  const alerts = synth();
  // Production wiring: no `deps` (anchorTime resolves NIMBUS.Util.dueInstant -> sapDueDate -> NimbusComputeCore.dueDateInstant
  // -> Util._dueWindowForLine over the calendar resolver). Every due is a date-only midnight, one in seven lands on a closed Sunday.
  const prevCore = globalThis.NimbusComputeCore, prevNimbus = globalThis.NIMBUS;
  globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
  globalThis.NIMBUS = { Util };
  const hours = { 0: null, 1: [6, 22], 2: [6, 22], 3: [6, 22], 4: [6, 22], 5: [6, 22], 6: null };
  Util.setDueCalendarResolver(() => ({ lineHours: hours, plantHours: hours, plant: 'P1', rev: 1 }));
  try {
    const tasksById = {};
    for (let i = 0; i < N_ORDERS; i++) tasksById[String(i)] = { id: String(i), MACHINE: `L${String(i % N_LINES).padStart(2, '0')}`, original_end_date: new Date(2026, 9, 20 + (i % 20)) };
    const d = { tasksById, plantToday: day0, horizonMinutes: 14 * 1440, window: { from: 0, to: 13 } };

    const [tData, data] = ms(() => overviewData(alerts, d));
    assert.equal(data.total, N_ALERTS);
    assert.equal(data.lines.length, N_LINES);
    const binned = data.days.reduce((n, b) => n + b.err + b.warn, 0) + data.overdue.err + data.overdue.warn + data.later.err + data.later.warn + data.undated;
    assert.equal(binned, N_ALERTS, 'every alert lands in exactly one day bucket (or is undated)');
    const [tNarrow, shown] = ms(() => applyNarrow(alerts, { day: data.days[3].key, line: 'L03', category: 'conflicts' }, d));
    assert.ok(shown.length < N_ALERTS);
    const [tDay] = ms(() => applyNarrow(alerts, { day: 'overdue' }, d));

    console.log(`[bench] ${N_ALERTS} alerts / ${N_LINES} lines, real Util.dueInstant: overviewData ${tData.toFixed(1)} ms, applyNarrow(day+line+category) ${tNarrow.toFixed(1)} ms, applyNarrow(day only) ${tDay.toFixed(1)} ms`);
  } finally {
    Util.setDueCalendarResolver(null);
    globalThis.NimbusComputeCore = prevCore;
    globalThis.NIMBUS = prevNimbus;
  }
});

test('bench: matrixModel + matrixHtml + filterAlerts at 15,000 alerts across 70 machines (W6a)', { skip: !BENCH && 'set NIMBUS_BENCH=1 to run' }, () => {
  const alerts = synth();
  const machines = Array.from({ length: N_LINES }, (_, i) => ({ id: `L${String(i).padStart(2, '0')}`, name: `Machine ${i}`, wc_group: `WC${i % 7}` }));
  const labels = { day: k => k, category: c => c, ungrouped: 'Ungrouped', noMachine: 'No machine', machinesCount: n => `${n} machines` };
  const ctx = { plantToday: day0, horizonDays: 7, machines, labels, pinned: new Set(['L03']) };
  const tr = (k, v) => k;
  const out = {};
  for (const lens of ['machine', 'day', 'group']) {
    const [tModel, model] = ms(() => matrixModel(alerts, lens, ctx));
    const [tHtml, html] = ms(() => matrixHtml(model, emptyFilter(), tr));
    out[lens] = [tModel, tHtml, html.length];
    assert.equal(model.total, N_ALERTS);
  }
  const f = emptyFilter(); f.wcGroups.add('WC1'); f.days.add('overdue'); f.days.add('later'); f.q = 'l0';
  const [tFilter, shown] = ms(() => filterAlerts(alerts, f, { ...ctx, tagOf: a => a.type }));
  assert.ok(shown.length > 0 && shown.length < N_ALERTS);
  const [tEmpty] = ms(() => filterAlerts(alerts, emptyFilter(), ctx));
  console.log(`[bench] ${N_ALERTS} alerts / ${N_LINES} machines: `
    + Object.entries(out).map(([l, [a, b, len]]) => `matrixModel(${l}) ${a.toFixed(1)} ms + matrixHtml ${b.toFixed(1)} ms (${len} chars)`).join(', ')
    + `; filterAlerts(wc+days+q) ${tFilter.toFixed(1)} ms, filterAlerts(empty) ${tEmpty.toFixed(2)} ms`);
});
