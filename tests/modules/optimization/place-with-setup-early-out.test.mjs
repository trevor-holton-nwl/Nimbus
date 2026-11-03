// P1-5: parity of placeWithSetup's split-policy early-out against a frozen
// copy of the pre-change loop (productiveAllocations copied verbatim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as SetupScheduler from '../../../frontend/optimization/setup-scheduler.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const MIN = 60 * 1000;

function mergeRanges(ranges) {
  const ordered = ranges.filter(r => r.lo <= r.hi).sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const merged = [];
  for (const range of ordered) {
    const prior = merged.at(-1);
    if (prior && range.lo <= prior.hi + 1) prior.hi = Math.max(prior.hi, range.hi);
    else merged.push({ ...range });
  }
  return merged;
}
const rangeContains = (ranges, t) => ranges.some(r => t >= r.lo && t <= r.hi);

function frozenAllocations(capacities, totalMinutes, minSeg) {
  const firstCapacity = capacities[0] ?? 0;
  if (firstCapacity < minSeg) return null;
  const states = [[{ lo: minSeg, hi: Math.min(firstCapacity, totalMinutes) }]];
  if (rangeContains(states[0], totalMinutes)) return [totalMinutes];
  for (let index = 1; index < capacities.length; index += 1) {
    const capacity = capacities[index];
    const prior = states[index - 1];
    const next = prior.map(r => ({ ...r }));
    if (capacity >= minSeg) {
      for (const range of prior) next.push({ lo: range.lo + minSeg, hi: Math.min(totalMinutes, range.hi + capacity) });
    }
    const merged = mergeRanges(next);
    states.push(merged);
    if (rangeContains(merged, totalMinutes)) break;
  }
  const finalIndex = states.length - 1;
  if (!rangeContains(states[finalIndex], totalMinutes)) return null;
  const allocations = Array.from({ length: states.length }, () => 0);
  let remaining = totalMinutes;
  for (let index = finalIndex; index > 0; index -= 1) {
    const prior = states[index - 1];
    if (rangeContains(prior, remaining)) continue;
    const capacity = capacities[index];
    let chosen = null;
    for (const range of prior) {
      const lo = Math.max(minSeg, remaining - range.hi);
      const hi = Math.min(capacity, remaining - range.lo);
      if (lo <= hi) { chosen = lo; break; }
    }
    if (chosen === null) return null;
    allocations[index] = chosen;
    remaining -= chosen;
  }
  if (remaining < minSeg || remaining > firstCapacity) return null;
  allocations[0] = remaining;
  return allocations;
}

/** The split branch of the old placeWithSetup, on minute-aligned disjoint intervals. */
function frozenSplit(intervals, setupMinutes, runtimeMinutes, minSeg) {
  for (let first = 0; first < intervals.length; first += 1) {
    const fi = intervals[first];
    const fps = new Date(fi.start.getTime() + setupMinutes * MIN);
    const firstCapacity = Math.floor((fi.end.getTime() - fps.getTime()) / MIN);
    if (firstCapacity < minSeg) continue;
    const slots = [{ start: fps, end: fi.end, minutes: firstCapacity }];
    for (let i = first + 1; i < intervals.length; i += 1) slots.push({ ...intervals[i], minutes: Math.floor((intervals[i].end - intervals[i].start) / MIN) });
    const allocations = frozenAllocations(slots.map(s => s.minutes), runtimeMinutes, minSeg);
    if (!allocations) continue;
    const segs = allocations.flatMap((m, i) => m === 0 ? [] : [{ start: new Date(slots[i].start), end: new Date(slots[i].start.getTime() + m * MIN) }]);
    return { kind: 'placed', segs, start: fi.start };
  }
  return { kind: 'infeasible' };
}

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function run(intervals, setupMinutes, runtime, minSeg) {
  const base = new Date(2026, 7, 3, 0, 0, 0).getTime();
  const free = intervals.map(([s, e]) => ({ start: new Date(base + s * MIN), end: new Date(base + e * MIN) }));
  const actual = SetupScheduler.placeWithSetup({
    freeIntervals: free, earliestStart: new Date(base - 60 * MIN), runtimeMinutes: runtime,
    setup: { kind: 'resolved', minutes: setupMinutes }, policy: 'partial_allowed', minProductiveSegmentMinutes: minSeg,
  });
  const expected = frozenSplit(free, setupMinutes, runtime, minSeg);
  assert.equal(actual.kind, expected.kind, JSON.stringify({ intervals, setupMinutes, runtime, minSeg }));
  if (expected.kind === 'placed') {
    assert.deepEqual(actual.productiveSegments, expected.segs);
    assert.equal(actual.setup ? actual.setup.start.getTime() : null, setupMinutes > 0 ? expected.start.getTime() : null);
  }
}

test('placeWithSetup split policy matches the frozen pre-early-out loop on random intervals', () => {
  const next = rng(20261103);
  let placed = 0;
  for (let n = 0; n < 4000; n += 1) {
    const count = 1 + Math.floor(next() * 12);
    const intervals = [];
    let cursor = Math.floor(next() * 30);
    for (let i = 0; i < count; i += 1) {
      const len = 1 + Math.floor(next() * 240);
      intervals.push([cursor, cursor + len]);
      cursor += len + 1 + Math.floor(next() * 400);
    }
    const setupMinutes = next() < 0.3 ? 0 : Math.floor(next() * 90);
    const runtime0 = 1 + Math.floor(next() * 700);
    const minSeg = next() < 0.5 ? 30 : 1 + Math.floor(next() * 60);
    run(intervals, setupMinutes, Math.max(runtime0, minSeg), minSeg);
    placed += 1;
  }
  assert.equal(placed, 4000);
});

test('placeWithSetup split policy fails fast with ~400 intervals when total capacity is short', () => {
  const base = new Date(2026, 7, 3, 0, 0, 0).getTime();
  const free = Array.from({ length: 400 }, (_, i) => ({ start: new Date(base + i * 100 * MIN), end: new Date(base + (i * 100 + 40) * MIN) }));
  const request = {
    freeIntervals: free, earliestStart: new Date(base - 60 * MIN), runtimeMinutes: 16000,
    setup: { kind: 'resolved', minutes: 5 }, policy: 'partial_allowed', minProductiveSegmentMinutes: 30,
  };
  const started = process.hrtime.bigint();
  for (let n = 0; n < 20; n += 1) assert.equal(SetupScheduler.placeWithSetup(request).kind, 'infeasible');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Old loop: ~200 x 400 productiveAllocations rebuilds (seconds); early-out: one suffix pass per call.
  assert.ok(ms < 300, `took ${ms} ms`);
});
