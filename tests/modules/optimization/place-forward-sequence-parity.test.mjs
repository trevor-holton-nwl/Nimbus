// P2-7: placeForwardSequence classifies the zoned `never` path with nextOperatingInstant + hasNominalWindow and
// allocates once. Parity vs a frozen copy of the findContiguousSlot-then-allocateRuntime implementation, over
// randomized calendars (closed days, night windows, 24/7, blackouts), DST-spanning starts, overlong runs, zoned
// and unzoned paths and all three split policies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Config } from '../../../frontend/platform/foundation.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Frozen pre-P2-7 copy of Engine.placeForwardSequence (never path: findContiguousSlot first, then allocateRuntime). */
function oldPlaceForwardSequence(line, items, from, policy, opts = {}) {
  const out = { placed: [], invalidRuntime: [], overlong: [], failure: null };
  let cursor = new Date(from);
  const obstacles = [...(opts.obstacles ?? [])];
  nextItem: for (const item of items) {
    if (opts.stopWhen?.(item, cursor)) break;
    const runtimeMinutes = Math.round(Number(item.task.RUN_TIME) * 60);
    if (!(runtimeMinutes > 0)) { out.invalidRuntime.push(item); continue; }
    const runtimeMs = runtimeMinutes * Config.MS_MIN;
    let candidate = item.notBefore ? new Date(Math.max(item.notBefore.getTime(), cursor.getTime())) : cursor;
    let start; let end; let scheduleSegments;
    for (let attempt = 0; ; attempt++) {
      scheduleSegments = undefined;
      if (policy === 'never') {
        const slot = Calendar.findContiguousSlot(line, candidate, runtimeMs, opts.plantTz ?? null);
        if (slot.kind === 'unavailable' || (!opts.plantTz && !('start' in slot))) {
          out.failure = { item, reason: slot.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
          break nextItem;
        }
        if (slot.kind === 'overlong' && !opts.plantTz) { out.overlong.push(item); continue nextItem; }
        if (opts.plantTz) {
          const allocation = Calendar.allocateRuntime(line, candidate, runtimeMinutes, 'never', opts.plantTz);
          if (allocation.kind !== 'allocated') {
            if (slot.kind === 'overlong') { out.overlong.push(item); continue nextItem; }
            out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
            break nextItem;
          }
          start = allocation.start; end = allocation.end;
        } else {
          start = slot.start; end = new Date(start.getTime() + runtimeMs);
        }
        if (item.task.scheduleSegments?.length && item.task.scheduleSegments.length >= 2) scheduleSegments = [];
      } else {
        const allocation = Calendar.allocateRuntime(line, candidate, runtimeMinutes, policy, opts.plantTz ?? null);
        if (allocation.kind !== 'allocated') {
          out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
          break nextItem;
        }
        start = allocation.start; end = allocation.end; scheduleSegments = allocation.scheduleSegments;
      }
      const hit = obstacles.find(o => start.getTime() < o.end.getTime() && end.getTime() > o.start.getTime());
      if (!hit || attempt >= obstacles.length) break;
      candidate = new Date(hit.end);
    }
    cursor = end;
    out.placed.push({ item, start, end, ...(scheduleSegments !== undefined ? { scheduleSegments } : {}) });
  }
  return out;
}

const norm = (r) => JSON.stringify({
  placed: r.placed.map(p => ({ id: p.item.task.id, s: p.start.getTime(), e: p.end.getTime(),
    seg: p.scheduleSegments?.map(g => [g.sequence, g.startDate.getTime(), g.endDate.getTime()]) ?? null })),
  invalid: r.invalidRuntime.map(i => i.task.id),
  overlong: r.overlong.map(i => i.task.id),
  failure: r.failure ? { id: r.failure.item.task.id, reason: r.failure.reason } : null,
});

function randomCalendar(rand) {
  const kinds = [[0, 24], [8, 16], [6, 22], [22, 24], [0, 6], null, null, [9, 12], [14, 15]];
  return Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, kinds[Math.floor(rand() * kinds.length)]]));
}

function setupLine(line, plant, hours, blocks) {
  Store.replaceBlocks(blocks, 'test'); Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test'); Store.replacePlants({}, 'test');
  Store.setMasterData({ plants: [{ subnetwork: 'SN', plant, timezone: 'America/Chicago', split_order_policy: 'never' }], lines: [{ machine: line, plant }] }, 'test');
  Store.setLineSetting(line, { plant, excludeFromOpt: false }, 'test');
  Store.setCalendar(line, hours, 'test');
}

function makeCase(rand, line, plant, n) {
  const hours = randomCalendar(rand);
  // Start near the 2026 Chicago DST changes (8 Mar, 1 Nov) or mid-summer.
  const anchors = [new Date(2026, 2, 6, 20, 0), new Date(2026, 9, 30, 20, 0), new Date(2026, 5, 10, 7, 30)];
  const from = new Date(anchors[Math.floor(rand() * anchors.length)].getTime() + Math.floor(rand() * 600) * 60000);
  const blocks = rand() < 0.4 ? [{ id: 'b', plant, line, start: new Date(from.getTime() + 3 * 3600000), end: new Date(from.getTime() + 30 * 3600000), reason: 'x' }] : [];
  const items = Array.from({ length: n }, (_, i) => {
    const r = rand();
    const hrs = r < 0.04 ? 0 : r < 0.15 ? 20 + rand() * 40 : 0.25 + rand() * 9;   // zero (invalid), overlong, normal
    return { task: { id: `t${i}`, RUN_TIME: String(Math.round(hrs * 60) / 60), MACHINE: line, ...(rand() < 0.2 ? { scheduleSegments: [1, 2] } : {}) },
      ...(rand() < 0.3 ? { notBefore: new Date(from.getTime() + Math.floor(rand() * 72) * 3600000) } : {}) };
  });
  return { hours, from, blocks, items };
}

for (const tz of ['UTC', 'America/Chicago']) {
  test(`P2-7 parity: new placeForwardSequence equals the frozen double-walk under process TZ ${tz}`, () => {
    const prev = process.env.TZ; process.env.TZ = tz;
    try {
      const rand = rng(27);
      const line = 'P27-L'; const plant = 'P27-P';
      const tally = { placed: 0, overlong: 0, failure: 0, invalid: 0, segments: 0 };
      for (let c = 0; c < 60; c++) {
        const k = makeCase(rand, line, plant, 1 + Math.floor(rand() * 8));
        setupLine(line, plant, k.hours, k.blocks);
        for (const policy of ['never', 'never', 'overlong_only', 'partial_allowed']) {
          for (const plantTz of [null, 'America/Chicago', 'Europe/Berlin']) {
            const opts = plantTz ? { plantTz } : {};
            const oldR = oldPlaceForwardSequence(line, k.items, k.from, policy, opts);
            const newR = Engine.placeForwardSequence(line, k.items, k.from, policy, opts);
            assert.equal(norm(newR), norm(oldR), `case ${c} policy ${policy} tz ${plantTz}`);
            tally.placed += newR.placed.length; tally.overlong += newR.overlong.length;
            tally.failure += newR.failure ? 1 : 0; tally.invalid += newR.invalidRuntime.length;
            tally.segments += newR.placed.filter(p => p.scheduleSegments).length;
          }
        }
      }
      // The sweep must actually reach every classification, or the parity claim is vacuous.
      for (const key of ['placed', 'overlong', 'failure', 'invalid', 'segments']) assert.ok(tally[key] > 0, `sweep exercised ${key}`);
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; setupLine('P27-L', 'P27-P', {}, []); }
  });
}

test('P2-7 timing: zoned never path on a large backlog fixture (informational)', { skip: !process.env.P27_BENCH }, () => {
  const line = 'P27-L'; const plant = 'P27-P';
  setupLine(line, plant, Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, d === 0 || d === 6 ? null : [6, 22]])), []);
  const items = Array.from({ length: 600 }, (_, i) => ({ task: { id: `b${i}`, RUN_TIME: String(1 + (i % 7)), MACHINE: line } }));
  const from = new Date(2026, 2, 2, 6, 0);
  const time = (fn) => { const t = []; for (let r = 0; r < 7; r++) { const s = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); } t.sort((a, b) => a - b); return t[3]; };
  const opts = { plantTz: 'America/Chicago' };
  time(() => oldPlaceForwardSequence(line, items, from, 'never', opts)); time(() => Engine.placeForwardSequence(line, items, from, 'never', opts));
  const o = time(() => oldPlaceForwardSequence(line, items, from, 'never', opts));
  const n = time(() => Engine.placeForwardSequence(line, items, from, 'never', opts));
  console.log(`P2-7 bench 600 items: old ${o.toFixed(1)} ms, new ${n.toFixed(1)} ms, ratio ${(o / n).toFixed(2)}x`);
});
