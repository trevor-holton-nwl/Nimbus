// W6b additions to the pure matrix layer: pinned machines are never folded, clearDims (toggle-off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixModel, clearDims, cellFilter } from '../../../frontend/alert-monitor/alert-monitor-matrix.mjs';
import { emptyFilter } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const labels = { day: k => `d:${k}`, category: c => `cat:${c}`, ungrouped: 'Ungrouped', noMachine: 'No machine', machinesCount: n => `${n} machines` };
const machines = [{ id: 'M1', wc_group: 'A' }, { id: 'M2', wc_group: 'A' }, { id: 'M3', wc_group: 'A' }];
const ctx = (o = {}) => ({ plantToday: new Date(2026, 9, 30), horizonDays: 3, machines, labels, ...o });
const alerts = [{ id: 'a1', sev: 'err', type: 'overlap', line: 'M1', time: new Date(2026, 9, 30, 9) }];

test('a pinned zero-alert machine stays a row, first, and is not folded into quiet', () => {
  const m = matrixModel(alerts, 'machine', ctx({ pinned: new Set(['M3']) }));
  const g = m.groups.find(x => x.key === 'A');
  assert.equal(g.rows[0].head.key, 'M3');
  assert.equal(g.rows[0].head.total, 0);
  assert.ok(!g.quiet.some(r => r.head.key === 'M3'));
  assert.ok(g.quiet.some(r => r.head.key === 'M2'));
});

test('clearDims empties exactly the dimensions the part names', () => {
  const f = { ...emptyFilter(), machines: new Set(['M1']), days: new Set(['2026-10-30']), categories: new Set(['late']), q: 'x' };
  const g = clearDims(f, cellFilter('machine', 'M1', '2026-10-30'));
  assert.equal(g.machines.size, 0);
  assert.equal(g.days.size, 0);
  assert.equal(g.categories.size, 1);
  assert.equal(g.q, 'x');
  assert.equal(f.machines.size, 1, 'the input is not mutated');
});
