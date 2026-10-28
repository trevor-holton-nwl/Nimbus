// Tool Inventory Wave 6: a property/oracle test for the optimizer's tool overflow pass.
//
// Seeded random SMALL instances (<= 3 selected lines plus one unselected line, <= 6 optimizable orders, <= 2 tools,
// <= 2 copies, a few firmed rows, a few rows on the unselected line) run through the real engine (Engine.evaluateSchedule:
// search + finalize + gap fill) with the rule Hard. An independent brute-force oracle (it never calls the pass, the validator
// or any scheduler helper) then checks, per instance:
//   1. no overflow involving an optimizable order survives (protected-vs-protected overlaps are grandfathered);
//   2. NECESSITY: every order queued with tool_contention really has no legal tool-free slot on its own line given the
//      FINAL placement of every other order (every minute-aligned start in the window is tried);
//   3. the number of placed orders is >= a pure-queue baseline (queue every offender, never re-place);
//   4. the result is identical when run twice and when snapshot.tasks is reversed;
//   5. protected and out-of-scope rows are never patched;
//   6. the number of pass steps is within the mutable-tool-order bound; no error findings; the pass completed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateSchedule } from '../../../frontend/optimization/engine.mjs';
import { resolveToolOverflow } from '../../../frontend/optimization/setup-scheduler.mjs';
import * as TF from '../helpers/tool-overflow-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = +TF.at(TF.TOOL_NOW);
const HORIZON = +TF.at(TF.TOOL_HORIZON_END);
const iso = ms => new Date(ms).toISOString().replace('Z', '');
// Local-time strings for the fixture (it builds Dates from local-time text).
const local = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function instance(seed) {
  const r = rng(seed);
  const pick = n => Math.floor(r() * n);
  const lineCount = 2 + pick(2);
  const lines = Array.from({ length: lineCount }, (_, i) => `L${i + 1}`);
  const tools = ['T1', 'T2'];
  const inventory = [];
  for (const t of tools) { if (r() < 0.8) inventory.push({ tool_id: t, total_qty: 1 + pick(2) }); }
  const toolsFor = () => { const n = pick(3); const out = []; for (let i = 0; i < n; i++) { const t = tools[pick(2)]; if (!out.includes(t)) out.push(t); } return out; };
  const push = r() < 0.5;
  const specs = [];
  const orders = 3 + pick(4);
  for (let i = 0; i < orders; i++) {
    const run = push ? 2 + pick(9) : 1 + pick(6);
    const spec = { id: `O${i}`, line: lines[pick(lines.length)], run, tools: toolsFor(), due: local(NOW + (push ? 6 + pick(30) : 24 + pick(72)) * HOUR + 30 * MIN) };
    if (r() < 0.3) { const start = NOW + (2 + pick(40)) * HOUR; spec.start = local(start); spec.end = local(start + run * HOUR); }
    specs.push(spec);
  }
  const firmed = [];
  for (let i = 0, n = pick(3); i < n; i++) {
    const run = 2 + pick(5); const start = NOW + (2 + pick(60)) * HOUR;
    specs.push({ id: `P${i}`, line: lines[pick(lines.length)], run, tools: toolsFor(), start: local(start), end: local(start + run * HOUR), due: local(start + 48 * HOUR) });
    firmed.push(`P${i}`);
  }
  for (let i = 0, n = pick(3); i < n; i++) {
    const run = 2 + pick(5); const start = NOW + (2 + pick(60)) * HOUR;
    specs.push({ id: `X${i}`, line: 'LX', run, tools: toolsFor(), start: local(start), end: local(start + run * HOUR), due: local(start + 48 * HOUR) });
  }
  // Half of the instances carry a hard push-forward cap (limit 0 days): the due date's day end is a hard ceiling, so
  // some orders genuinely have no tool-free slot and must be queued.
  return { seed, lines, inventory, specs, firmed, push };
}

function build(inst, specs = inst.specs) {
  return TF.toolSnapshot(specs, { inventory: inst.inventory, lines: [...inst.lines, 'LX'], firmedIds: inst.firmed, plantExtra: inst.push ? { max_push_forward_days: 0 } : {} });
}
const request = inst => TF.toolRequest({ lines: inst.lines });
const availableOf = inst => tool => { const row = inst.inventory.find(r => r.tool_id === tool); return row ? row.total_qty - (row.out_of_service_qty ?? 0) : 1; };
const canon = (snap, result) => JSON.stringify(
  TF.finalRows(snap, result).sort((a, b) => (a.id < b.id ? -1 : 1)).map(({ id, status, start, end, pieces, reason }) => ({ id, status, start, end, pieces, code: reason?.code, tool: reason?.tool_id })));

function envelope(row) { return row.pieces.length ? [Math.min(...row.pieces.map(p => p[0])), Math.max(...row.pieces.map(p => p[1]))] : null; }

/** Distinct machines using `tool` at instant `t` from every placed row except `skipId`. */
function machinesAt(rows, tool, t, skipId, excludeLine) {
  const lines = new Set();
  for (const row of rows) {
    if (row.id === skipId || row.status !== 'placed' || !row.tools.includes(tool) || row.line === excludeLine) continue;
    const e = envelope(row);
    if (e && e[0] <= t && t < Math.max(e[1], e[0] + 1) && e[1] > NOW) lines.add(row.line);
  }
  return lines.size;
}

function legalSlotExists(inst, rows, order) {
  const run = Math.round(order.run * 60) * MIN;
  // A push cap of 0 days: the placed finish may not pass the midnight that follows the due date's day.
  let limit = HORIZON;
  if (inst.push) { const d = new Date(+TF.at(order.due) - 1); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); limit = Math.min(limit, +d); }
  const avail = availableOf(inst);
  const lineBusy = rows.filter(r => r.id !== order.id && r.status === 'placed' && r.line === order.line).flatMap(r => r.pieces);
  for (let s = NOW; s + run <= limit; s += MIN) {
    const e = s + run;
    if (lineBusy.some(([ps, pe]) => ps < e && s < pe)) continue;
    let ok = true;
    for (const tool of order.tools) {
      // Distinct OTHER machines in use at any instant of [s, e): check at s and at every other holder's start inside.
      const points = new Set([s]);
      for (const row of rows) {
        if (row.id === order.id || row.status !== 'placed' || !row.tools.includes(tool)) continue;
        const env = envelope(row);
        if (env && env[0] > s && env[0] < e) points.add(env[0]);
      }
      for (const p of points) if (machinesAt(rows, tool, p, order.id, order.line) + 1 > avail(tool)) { ok = false; break; }
      if (!ok) break;
    }
    if (ok) return true;
  }
  return false;
}

const INSTANCES = Number(process.env.TOOL_ORACLE_INSTANCES ?? 600);

test('tool overflow oracle: ' + INSTANCES + ' seeded random instances satisfy every property', () => {
  let queuedByTool = 0; let moved = 0; let withTools = 0;
  const only = process.env.TOOL_ORACLE_SEED ? Number(process.env.TOOL_ORACLE_SEED) : null;
  for (let seed = only ?? 1; seed <= (only ?? INSTANCES); seed++) {
    const inst = instance(seed);
    const tag = `seed ${seed}`;
    const snap = build(inst);
    const result = evaluateSchedule(snap, request(inst));
    const rows = TF.finalRows(snap, result);
    if (only) {
      console.log(JSON.stringify({ inventory: inst.inventory, push: inst.push, firmed: inst.firmed }));
      for (const s of inst.specs) console.log(s.id, s.line, 'run', s.run, 'tools', s.tools, 'due', s.due, s.start ?? '');
      for (const row of rows) console.log(row.id, row.line, row.status, row.start && iso(row.start), row.end && iso(row.end), row.reason?.code, row.reason?.holders);
      console.log(JSON.stringify(result.toolMoved), JSON.stringify(result.toolBlocked));
    }
    const protectedIds = new Set([...inst.firmed, ...inst.specs.filter(s => s.line === 'LX').map(s => s.id)]);
    const mutableIds = new Set(inst.specs.filter(s => !protectedIds.has(s.id)).map(s => s.id));

    // (5) protected / out-of-scope rows are never patched.
    for (const patch of result.patches) assert.ok(!protectedIds.has(patch.id), `${tag}: protected row ${patch.id} was patched`);
    // (6) no error findings, the pass completed, steps within the bound.
    assert.deepEqual((result.validationFindings ?? []).filter(f => f.severity === 'error'), [], `${tag}: error findings survived`);
    assert.equal(result.toolPass?.complete, true, `${tag}: pass incomplete`);
    const toolOrders = inst.specs.filter(s => mutableIds.has(s.id) && s.tools.length).length;
    assert.ok((result.toolMoved?.length ?? 0) + (result.toolBlocked?.length ?? 0) <= toolOrders, `${tag}: more steps than mutable tool orders`);
    withTools += toolOrders ? 1 : 0;

    // (1) no overflow instant that an optimizable order covers.
    const avail = availableOf(inst);
    const placed = rows.filter(r => r.status === 'placed');
    for (const row of placed) {
      const e = envelope(row);
      for (const tool of row.tools) {
        const starts = new Set([Math.max(NOW, e[0])]);
        for (const other of placed) { const oe = envelope(other); if (other.tools.includes(tool) && oe[0] > e[0] && oe[0] < e[1]) starts.add(oe[0]); }
        for (const t of starts) {
          if (e[1] <= NOW) continue;
          const lines = new Set(placed.filter(o => o.tools.includes(tool) && envelope(o)[0] <= t && t < envelope(o)[1]).map(o => o.line));
          if (lines.size > avail(tool)) {
            const covering = placed.filter(o => o.tools.includes(tool) && envelope(o)[0] <= t && t < envelope(o)[1]);
            assert.ok(!covering.some(o => mutableIds.has(o.id)), `${tag}: tool ${tool} overflow at ${iso(t)} with an optimizable holder (${covering.map(o => o.id)})`);
          }
        }
      }
    }

    // (2) necessity of every tool_contention queue.
    for (const row of rows.filter(r => r.status === 'queued' && r.reason?.code === 'tool_contention')) {
      queuedByTool++;
      assert.ok(mutableIds.has(row.id), `${tag}: a protected row was queued`);
      const order = inst.specs.find(s => s.id === row.id);
      assert.equal(legalSlotExists(inst, rows, order), false, `${tag}: ${row.id} was queued for tools but a legal tool-free slot exists on ${order.line}`);
    }
    moved += result.toolMoved?.length ?? 0;

    // (3) placed count >= pure-queue baseline (the Off schedule with every offender queued and none re-placed).
    const offSnap = TF.toolSnapshot(inst.specs, { inventory: inst.inventory, lines: [...inst.lines, 'LX'], firmedIds: inst.firmed, rule: 'off', plantExtra: inst.push ? { max_push_forward_days: 0 } : {} });
    const off = evaluateSchedule(offSnap, request(inst));
    const ctx = off.validationContext;
    const hardSnap = { ...ctx.snapshot, masterData: snap.masterData };
    const pure = resolveToolOverflow(hardSnap, ctx.bounds, off, 0);
    const placedCount = c => c.dispositions.filter(d => d.status === 'scheduled').length;
    assert.ok(placedCount(result) >= placedCount(pure), `${tag}: placed ${placedCount(result)} < pure-queue ${placedCount(pure)}`);

    // (4) determinism: a second run and a reversed task list give identical results.
    assert.equal(canon(build(inst), evaluateSchedule(build(inst), request(inst))), canon(snap, result), `${tag}: second run differs`);
    const reversedSpecs = [...inst.specs].reverse();
    const rev = build(inst, reversedSpecs);
    assert.equal(canon(rev, evaluateSchedule(rev, request(inst))), canon(snap, result), `${tag}: reversed snapshot.tasks differs`);
  }
  // The generator must actually exercise the pass, or the test proves nothing.
  assert.ok(withTools > INSTANCES / 2, 'most instances carry tools');
  assert.ok(moved > 0, 'some instance moved an order');
  assert.ok(queuedByTool > 0, 'some instance queued an order for tools');
  console.log(`tool overflow oracle: ${INSTANCES} instances, ${moved} moves, ${queuedByTool} tool queues`);
});
