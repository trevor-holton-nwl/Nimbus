// Tool Inventory Wave 6 validation fix: the INDEPENDENT oracle for the adversarial tool-overflow tests (written by the Opus
// validator; it never calls the pass, only the engine for the schedule and `validateCandidate` to confirm a brute-forced slot
// is legal apart from the tool rule). Used by tests/modules/optimization/tool-overflow-oracle.test.mjs.
import * as G from './tool-adversary-gen.mjs';
import * as SS from '../../../frontend/optimization/setup-scheduler.mjs';

const { MIN, HOUR, NOW } = G;
const BUSINESS = { 1: [6, 22], 2: [6, 22], 3: [6, 22], 4: [6, 22], 5: [6, 22] };

export function workingWindows(spec) {
  const out = [];
  const day0 = new Date(NOW); day0.setHours(0, 0, 0, 0);
  for (let d = new Date(day0); +d < spec.horizonEnd + 24 * HOUR; d.setDate(d.getDate() + 1)) {
    const span = spec.business ? BUSINESS[d.getDay()] : [0, 24];
    if (!span) continue;
    const s = +d + span[0] * HOUR; const e = +d + span[1] * HOUR;
    const last = out[out.length - 1];
    if (last && last[1] === s) last[1] = e; else out.push([s, e]);
  }
  return out;
}

/** My own scope model (independent of buildTaskScope). */
export function classify(spec) {
  const selected = new Set(spec.lines);
  const frozenEnd = spec.frozenHorizonEnd;
  const cls = new Map();
  for (const t of spec.tasks) {
    let k;
    if ((t.plant ?? 'P1') !== 'P1') k = 'otherPlant';
    else if (!selected.has(t.line)) k = 'outOfScopeLine';
    else {
      const placed = t.start != null && t.end != null;
      const firmed = spec.firmed.includes(t.id) && spec.respectFirmed;
      const running = placed && t.userScheduled && t.start <= NOW && NOW < t.end;
      const frozen = frozenEnd != null && t.userScheduled && t.end != null && t.end >= NOW && t.end < frozenEnd && !(t.start != null && t.start < NOW);
      const crosser = placed && t.userScheduled && t.start < spec.horizonEnd && spec.horizonEnd < t.end;
      if (t.start == null && t.end != null) k = 'finishOnly';
      else if (!placed) k = 'mutable';
      else if (firmed || running || frozen) k = 'protected';
      else if (crosser) k = 'held';
      else if (t.end > NOW && t.start < spec.horizonEnd) k = 'mutable';
      else k = 'outOfWindow';
    }
    cls.set(t.id, k);
  }
  return cls;
}

const _clsMemo = new WeakMap();
export const clsOf = spec => { let c = _clsMemo.get(spec); if (!c) _clsMemo.set(spec, c = classify(spec)); return c; };
export function finalRows(spec, result) {
  const cls0 = clsOf(spec);
  const byId = new Map(result.patches.map(p => [p.id, p.changes]));
  return spec.tasks.map(t => {
    const c = byId.get(t.id);
    let start = t.start ?? null, end = t.end ?? null, segs = t.segments ?? null, status;
    if (c) {
      if (c.planning_status === 'needs_planning') { start = null; end = null; segs = null; status = 'queued'; }
      else { start = c.start_date ? +new Date(c.start_date) : null; end = c.end_date ? +new Date(c.end_date) : null; segs = (c.scheduleSegments ?? []).length ? c.scheduleSegments.map(s => [+new Date(s.startDate), +new Date(s.endDate)]) : null; status = 'placed'; }
    } else status = start != null && end != null ? 'placed' : (end != null ? 'finishOnly' : 'queued');
    const tools = [...new Set(t.tools.map(G.normTool).filter(Boolean))];
    let occ = null;
    if (status === 'placed') { const pieces = segs ?? [[start, end]]; occ = [Math.min(...pieces.map(p => p[0])), Math.max(...pieces.map(p => p[1]))]; }
    else if (status === 'finishOnly') occ = [end - t.run * HOUR, end];
    // F3 (owner decision): a never-committed, non-mutable, non-firmed bar does not reserve a copy.
    if (process.env.NOF3 !== '1' && t.userScheduled !== true && t.start != null && t.end != null && cls0.get(t.id) !== 'mutable' && cls0.get(t.id) !== 'protected') occ = null;
    if (occ) { if (occ[1] <= NOW) occ = null; else occ = [Math.max(occ[0], NOW), occ[1]]; }
    return { id: t.id, line: t.line, plant: t.plant ?? 'P1', status, start, end, pieces: status === 'placed' ? (segs ?? [[start, end]]) : [], occ, tools, reason: c?.planning_reason ?? null, patched: !!c, changes: c ?? null, spec: t };
  });
}

/** Overflow instants: [{tool, at, lines, ids}] for P1 rows. */
export function overflows(rows, avail, filter = () => true) {
  const out = [];
  const p1 = rows.filter(r => r.plant === 'P1' && r.occ && filter(r));
  const tools = [...new Set(p1.flatMap(r => r.tools))].sort();
  for (const tool of tools) {
    const list = p1.filter(r => r.tools.includes(tool));
    for (const t of [...new Set(list.map(r => r.occ[0]))].sort((a, b) => a - b)) {
      const cov = list.filter(r => r.occ[0] <= t && t < r.occ[1]);
      const lines = new Set(cov.map(r => r.line));
      if (lines.size > avail(tool)) out.push({ tool, at: t, lines: lines.size, ids: cov.map(r => r.id) });
    }
  }
  return out;
}

export const canon = (result) => JSON.stringify({
  patches: [...result.patches].sort((a, b) => (a.id < b.id ? -1 : 1)).map(p => ({ id: p.id, changes: p.changes })),
  dispositions: [...(result.dispositions ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
  score: result.score,
  findings: (result.validationFindings ?? []).map(f => [f.code, f.severity, f.taskId ?? null, f.message]).sort(),
  toolBlocked: result.toolBlocked ?? null, toolMoved: result.toolMoved ?? null, complete: result.toolPass?.complete ?? null,
});

export function shuffle(r, arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Necessity: brute-force a legal tool-free slot for a queued order; legality confirmed by validateCandidate (non-tool errors). */
export function legalSlot(spec, result, rows, order, avail, marginMin) {
  const ctx = result.validationContext;
  if (!ctx) return { found: false, why: 'no-ctx' };
  const run = Math.round(order.spec.run * 60) * MIN;
  const busy = rows.filter(r => r.id !== order.id && r.plant === 'P1' && r.line === order.line && r.status === 'placed').flatMap(r => r.pieces);
  const windows = workingWindows(spec);
  const others = rows.filter(r => r.id !== order.id && r.plant === 'P1' && r.occ && r.line !== order.line);
  if (order.tools.some(t => avail(t) <= 0)) return { found: false, why: 'zero' };
  const baseErr = new Set((result.validationFindings ?? []).filter(f => f.severity === 'error').map(f => f.code + '|' + f.taskId));
  let tries = 0;
  for (let s = NOW; s + run <= spec.horizonEnd; s += 15 * MIN) {
    const e = s + run;
    if (!windows.some(([ws, we]) => s >= ws && e <= we)) continue;
    if (busy.some(([ps, pe]) => ps < e + 0 && s < pe)) continue;
    const lo = s - marginMin * MIN;
    let ok = true;
    for (const tool of order.tools) {
      const cand = others.filter(r => r.tools.includes(tool) && r.occ[0] < e && lo < r.occ[1]);
      const pts = new Set([lo, ...cand.map(r => r.occ[0]).filter(p => p > lo && p < e)]);
      for (const p of pts) { const ls = new Set(cand.filter(r => r.occ[0] <= p && p < r.occ[1]).map(r => r.line)); if (ls.size + 1 > avail(tool)) { ok = false; break; } }
      if (!ok) break;
    }
    if (!ok) continue;
    if (++tries > 40) break;
    const patch = { id: order.id, changes: { start_date: new Date(s), end_date: new Date(e), scheduleSegments: [], planning_status: 'scheduled', planning_reason: null } };
    const cand = { ...result, patches: [...result.patches.filter(p => p.id !== order.id), patch],
      dispositions: (result.dispositions ?? []).map(d => d.id === order.id ? { id: d.id, line: d.line, status: 'scheduled' } : d) };
    const errs = SS.validateCandidate(ctx.snapshot, { ...ctx.bounds, skipToolOverflowFinding: true }, cand)
      .filter(f => f.severity === 'error' && f.code !== 'tool_overflow' && !baseErr.has(f.code + '|' + f.taskId));
    if (!errs.length) return { found: true, start: s, end: e };
  }
  return { found: false };
}

/** Own pure-queue baseline from the Off schedule: queue the least urgent (latest due, id) mutable row of the earliest overflow until none. */
export function pureQueuePlaced(spec, offResult, avail, cls) {
  const rows = finalRows(spec, offResult);
  const queued = new Set();
  for (let guard = 0; guard < 200; guard++) {
    const ov = overflows(rows, avail, r => !queued.has(r.id)).filter(o => o.ids.some(id => cls.get(id) === 'mutable'));
    if (!ov.length) break;
    const ids = ov[0].ids.filter(id => cls.get(id) === 'mutable');
    ids.sort((a, b) => { const ra = rows.find(r => r.id === a).spec.due, rb = rows.find(r => r.id === b).spec.due; return rb - ra || (a < b ? 1 : -1); });
    queued.add(ids[0]);
  }
  return rows.filter(r => cls.get(r.id) === 'mutable' && r.status === 'placed' && !queued.has(r.id)).length;
}

