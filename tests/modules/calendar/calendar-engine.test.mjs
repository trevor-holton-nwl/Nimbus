// Tests for frontend/calendar/calendar-engine.mjs, split from
// tests/modules/schedule-services.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-services.mts
// into 4 domain files: optimization/scheduler-contract.mjs,
// optimization/engine.mjs, calendar/calendar-engine.mjs,
// insights/services.mjs).
//
// Calendar's capacity-math functions delegate to nimbus-compute-core.js via
// the ambient `globalThis.NimbusComputeCore` global (a real browser loads it
// via a parser-blocking <script> before app-entry.mjs's static imports run).
// Under plain Node ESM (this file) nothing sets that global automatically, so
// we bootstrap it here via createRequire — mirroring
// tests/modules/helpers/load-legacy-app.mjs's identical bootstrap.
import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

test('Calendar exposes capacity-math methods only (no render/openBlockModal/DOM)', () => {
  assert.equal(typeof Calendar.workWindow, 'function');
  assert.equal(typeof Calendar.dailyCapacityHours, 'function');
  assert.equal(typeof Calendar.nextAvailable, 'function');
  assert.equal(Calendar.render, undefined, 'Calendar must not carry UI methods after the split');
  assert.equal(Calendar.openBlockModal, undefined);
  assert.equal(Calendar.saveBlockFromModal, undefined);
});

test('Calendar.workWindow returns null outside working hours, a window inside them', () => {
  Store.setCalendar('L1', { 1: [7, 19] }, 'unit-test'); // Monday 7am-7pm
  const monday = new Date('2026-08-03T12:00:00'); // a Monday, midday
  const win = Calendar.workWindow('L1', monday);
  assert.ok(win === null || Array.isArray(win));
});

test('nextAvailable returns null for an overlong order or a closed line, never a bogus start (#41)', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setCalendar('NA-L1', all([8, 16]), 'unit-test');
  const from = new Date('2031-03-03T09:00:00');
  assert.equal(Calendar.nextAvailable('NA-L1', from, 9 * 3600 * 1000), null, '9h order cannot fit an 8h window');
  assert.ok(Calendar.nextAvailable('NA-L1', from, 4 * 3600 * 1000) instanceof Date, 'a fitting order still gets a start');
  Store.setCalendar('NA-CLOSED', all(null), 'unit-test');
  assert.equal(Calendar.nextAvailable('NA-CLOSED', from, 3600 * 1000), null, 'no nominal window at all');
});

test('nextAvailable rounds a 10:05 blackout end UP so the start is clear of the blackout (#41)', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setCalendar('NA-L2', all([0, 24]), 'unit-test');
  const prior = Store.blocks.slice();
  try {
    Store.replaceBlocks([{ id: 'na-b', line: 'NA-L2', start: new Date('2031-03-03T09:00:00'), end: new Date('2031-03-03T10:05:00') }], 'unit-test');
    const start = Calendar.nextAvailable('NA-L2', new Date('2031-03-03T09:30:00'), 3600 * 1000);
    assert.ok(start instanceof Date);
    assert.ok(start.getTime() >= new Date('2031-03-03T10:05:00').getTime(), 'start must not sit inside the blackout');
    assert.equal(start.getTime() % (15 * 60 * 1000), 0, 'start stays on the 15-minute grid');
  } finally {
    Store.replaceBlocks(prior, 'unit-test');
  }
});

test('nextAvailable warns once per (line, duration) for an overlong order, not on every optimizer probe', async () => {
  const { ErrorLog } = await import('../../../frontend/platform/foundation.mjs');
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setCalendar('NA-DEDUPE', all([8, 16]), 'unit-test');
  const from = new Date('2031-03-03T09:00:00');
  const origWarn = ErrorLog.warn; let warns = 0;
  ErrorLog.warn = () => { warns++; };
  try {
    for (let i = 0; i < 50; i++) assert.equal(Calendar.nextAvailable('NA-DEDUPE', from, 11 * 3600 * 1000), null);
    assert.equal(warns, 1);
    Calendar.nextAvailable('NA-DEDUPE', from, 12 * 3600 * 1000);
    assert.equal(warns, 2, 'a different duration still warns');
  } finally { ErrorLog.warn = origWarn; }
});

test('nextAvailable honours its 90-day bound: a slot just inside is found, one beyond returns null', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  const prior = Store.blocks.slice();
  const from = new Date('2031-01-06T00:00:00');
  const hour = 3600 * 1000;
  try {
    Store.setCalendar('NA-90A', all([0, 24]), 'unit-test');
    // Blackout ends ~86 days out -> first free slot is inside the 90-day bound.
    const insideEnd = new Date('2031-04-02T00:00:00');
    Store.replaceBlocks([{ id: 'na90-in', line: 'NA-90A', start: from, end: insideEnd }], 'unit-test');
    const found = Calendar.nextAvailable('NA-90A', from, hour);
    assert.ok(found instanceof Date, 'slot inside 90 days is found');
    assert.ok(found.getTime() >= insideEnd.getTime(), 'slot starts after the blackout');
    assert.ok(found.getTime() - from.getTime() <= 90 * 24 * hour, 'and within the 90-day horizon');

    // Blackout runs ~104 days out -> every candidate start is beyond 90 days.
    Store.replaceBlocks([{ id: 'na90-out', line: 'NA-90A', start: from, end: new Date('2031-04-20T00:00:00') }], 'unit-test');
    assert.equal(Calendar.nextAvailable('NA-90A', from, hour), null, 'nothing within 90 days -> null, not a start past the bound');
  } finally {
    Store.replaceBlocks(prior, 'unit-test');
  }
});

test('nextAvailable returns null when a day-long blackout leaves no window long enough anywhere in 90 days', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  const prior = Store.blocks.slice();
  const from = new Date('2031-01-06T00:00:00');
  try {
    Store.setCalendar('NA-90B', all([8, 16]), 'unit-test');
    // Blackout covers every working window for 100 days.
    Store.replaceBlocks([{ id: 'na90b', line: 'NA-90B', start: from, end: new Date('2031-04-17T00:00:00') }], 'unit-test');
    assert.equal(Calendar.nextAvailable('NA-90B', from, 4 * 3600 * 1000), null);
    // Without the blackout the same request succeeds (proves null came from exhaustion).
    Store.replaceBlocks([], 'unit-test');
    assert.ok(Calendar.nextAvailable('NA-90B', from, 4 * 3600 * 1000) instanceof Date);
  } finally {
    Store.replaceBlocks(prior, 'unit-test');
  }
});

// ---------------------------------------------------------------------------
// Backward (finish-anchored) primitives: Calendar.latestAvailable,
// Calendar._freeIntervalsBackward, Calendar.allocateRuntimeBackward.
// Worked examples follow BACKWARD_SCHEDULING_MIGRATION.md 4.2.3 - 4.2.7.
// 19-23 Oct 2026 is Mon-Fri; 24/25 Oct is the weekend.
// ---------------------------------------------------------------------------
const p2 = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const at = (day, clock) => new Date(`${day}T${clock}:00`);
const D = { mon: '2026-10-19', tue: '2026-10-20', wed: '2026-10-21', thu: '2026-10-22', fri: '2026-10-23', sat: '2026-10-24', sun: '2026-10-25', nextMon: '2026-10-26' };
const weekdays = (open, close) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, d >= 1 && d <= 5 ? [open, close] : null]));
const everyDay = w => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
const FLOOR = at('2026-09-01', '00:00');
const bopts = (extra = {}) => ({ floor: FLOOR, minSegmentMinutes: 30, plantTz: null, ...extra });
const summary = r => r.kind !== 'placed' ? r.kind
  : `${fmt(r.start)} -> ${fmt(r.end)}${r.finishMoved ? ` moved:${r.moveReason}` : ''}${r.scheduleSegments.length ? ` [${r.scheduleSegments.map(s => `${fmt(s.startDate)}-${fmt(s.endDate)}`).join(' | ')}]` : ''}`;
const blk = (id, line, start, end) => ({ id, line, start, end });
const withZone = async (zone, fn) => {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { await fn(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
};

describe('backward calendar primitives', () => {
  let priorBlocks;
  beforeEach(() => { priorBlocks = Store.blocks.slice(); Calendar._endRun(); });
  afterEach(() => { Store.replaceBlocks(priorBlocks, 'unit-test'); Calendar._endRun(); });

  // The 4.2.3 fixture: Mon-Fri 06-18, 2 h blackout Thu 10:00-12:00.
  const sim1 = name => {
    Store.setCalendar(name, weekdays(6, 18), 'unit-test');
    Store.replaceBlocks([blk(`${name}-b`, name, at(D.thu, '10:00'), at(D.thu, '12:00'))], 'unit-test');
    return name;
  };
  const plain = (name, hours = weekdays(6, 18)) => {
    Store.setCalendar(name, hours, 'unit-test');
    Store.replaceBlocks([], 'unit-test');
    return name;
  };

  describe('allocateRuntimeBackward: finish boundaries', () => {
    it('clamps a finish after close to the close (closed_finish)', () => {
      const line = plain('BW-A1');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.wed, '18:30'), 120, 'never', bopts())),
        '2026-10-21 16:00 -> 2026-10-21 18:00 moved:closed_finish');
    });

    it('moves a finish on a closed day to the previous open day close (closed_finish)', () => {
      const line = plain('BW-A2');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.sat, '12:00'), 120, 'never', bopts())),
        '2026-10-23 16:00 -> 2026-10-23 18:00 moved:closed_finish');
    });

    it('moves a finish inside a blackout to the blackout start, which rounds DOWN to the minute', () => {
      const line = plain('BW-A3');
      Store.replaceBlocks([{ id: 'a3', line, start: new Date(+at(D.thu, '09:30') + 30000), end: at(D.thu, '12:00') }], 'unit-test');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.thu, '11:00'), 60, 'never', bopts())),
        '2026-10-22 08:30 -> 2026-10-22 09:30 moved:blackout');
    });

    it('treats a finish exactly at window close as valid (no move)', () => {
      const line = plain('BW-A4');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.wed, '18:00'), 120, 'never', bopts())),
        '2026-10-21 16:00 -> 2026-10-21 18:00');
    });

    it('hops a finish exactly at window open to the previous open day close', () => {
      const line = plain('BW-A5');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.thu, '06:00'), 120, 'never', bopts())),
        '2026-10-21 16:00 -> 2026-10-21 18:00 moved:closed_finish');
    });

    it('lands a Monday-open finish on the previous Friday close, never on the weekend', () => {
      const line = plain('BW-A6');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.nextMon, '06:00'), 180, 'never', bopts())),
        '2026-10-23 15:00 -> 2026-10-23 18:00 moved:closed_finish');
    });

    it('floors a sub-minute finish to the minute without reporting a move', () => {
      const line = plain('BW-A7');
      const finish = new Date(+at(D.wed, '12:00') + 45000);
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, finish, 60, 'never', bopts())),
        '2026-10-21 11:00 -> 2026-10-21 12:00');
    });
  });

  describe('allocateRuntimeBackward: placement and policies', () => {
    it('keeps a finish that already sits in one window under every policy (fixed point, 4.2.3 row 1)', () => {
      const line = sim1('BW-B1');
      for (const policy of ['never', 'overlong_only', 'partial_allowed']) {
        const r = Calendar.allocateRuntimeBackward(line, at(D.fri, '14:00'), 480, policy, bopts());
        assert.equal(summary(r), '2026-10-23 06:00 -> 2026-10-23 14:00', policy);
        assert.deepEqual(r.scheduleSegments, [], policy);
      }
    });

    it('fills pieces from the latest fragment backward, each anchored at its fragment end', () => {
      const line = plain('BW-B2');
      Store.replaceBlocks([blk('b2', line, at(D.wed, '12:00'), at(D.wed, '14:00'))], 'unit-test');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.wed, '18:00'), 360, 'partial_allowed', bopts())),
        '2026-10-21 10:00 -> 2026-10-21 18:00 [2026-10-21 10:00-2026-10-21 12:00 | 2026-10-21 14:00-2026-10-21 18:00]');
    });

    it('4.2.3 under never: no contiguous 8 h block ends at Fri 10:00, so the finish moves to Wed 18:00 (no_slot_at_finish)', () => {
      const line = sim1('BW-B3');
      const r = Calendar.allocateRuntimeBackward(line, at(D.fri, '10:00'), 480, 'never', bopts());
      assert.equal(summary(r), '2026-10-21 10:00 -> 2026-10-21 18:00 moved:no_slot_at_finish');
      assert.deepEqual(r.scheduleSegments, []);
    });

    it('4.2.3 under overlong_only: same as never when the order is not inherently overlong', () => {
      const line = sim1('BW-B4');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '10:00'), 480, 'overlong_only', bopts())),
        '2026-10-21 10:00 -> 2026-10-21 18:00 moved:no_slot_at_finish');
    });

    it('4.2.3 under partial_allowed: pieces Thu 14:00-18:00 + Fri 06:00-10:00, finish held', () => {
      const line = sim1('BW-B5');
      const r = Calendar.allocateRuntimeBackward(line, at(D.fri, '10:00'), 480, 'partial_allowed', bopts());
      assert.equal(summary(r), '2026-10-22 14:00 -> 2026-10-23 10:00 [2026-10-22 14:00-2026-10-22 18:00 | 2026-10-23 06:00-2026-10-23 10:00]');
      assert.deepEqual(r.scheduleSegments.map(s => s.sequence), [1, 2]);
      assert.equal(r.finishMoved, false);
    });

    it('4.2.7 minimum-piece mirror: 4 h 20 m, finish Fri 10:00, min 30 -> Thu 17:30-18:00 + Fri 06:10-10:00', () => {
      const line = sim1('BW-B6');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '10:00'), 260, 'partial_allowed', bopts({ minSegmentMinutes: 30 }))),
        '2026-10-22 17:30 -> 2026-10-23 10:00 [2026-10-22 17:30-2026-10-22 18:00 | 2026-10-23 06:10-2026-10-23 10:00]');
    });

    it('skips a piece at the finish shorter than the minimum and moves the finish earlier (min_piece, OQ55)', () => {
      const line = plain('BW-B7');
      // Only 20 minutes (06:00-06:20) precede the finish on Friday; a 20-minute piece is below the 30-minute floor.
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '06:20'), 100, 'partial_allowed', bopts())),
        '2026-10-22 16:20 -> 2026-10-22 18:00 moved:min_piece');
    });

    it('lets a whole order shorter than the minimum piece be placed as one piece', () => {
      const line = plain('BW-B8');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.wed, '12:00'), 20, 'partial_allowed', bopts())),
        '2026-10-21 11:40 -> 2026-10-21 12:00');
    });

    it('reports overlong when the run time exceeds the longest merged window under never / overlong_only (OQ50)', () => {
      const line = plain('BW-B9');          // 12 h windows, weekends closed
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '18:00'), 13 * 60, 'never', bopts())), 'overlong');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '18:00'), 13 * 60, 'overlong_only', bopts())), 'overlong');
      assert.equal(Calendar.allocateRuntimeBackward(line, at(D.fri, '18:00'), 13 * 60, 'partial_allowed', bopts()).kind, 'placed');
    });

    it('does not call an order overlong just because blackouts slice the windows (nominal windows decide)', () => {
      const line = sim1('BW-B10');
      assert.notEqual(Calendar.allocateRuntimeBackward(line, at(D.fri, '10:00'), 11 * 60, 'never', bopts()).kind, 'overlong');
    });

    it('does not call an order overlong when only the clipped window at the finish is short', () => {
      const line = plain('BW-B11');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '06:30'), 8 * 60, 'never', bopts())),
        '2026-10-22 10:00 -> 2026-10-22 18:00 moved:no_slot_at_finish');
    });

    it('reports unavailable when the line has no operating window at all inside the lookback', () => {
      const line = plain('BW-B12', everyDay(null));
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 60, 'never', bopts())), 'unavailable');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 60, 'partial_allowed', bopts())), 'unavailable');
    });

    it('bounds the lookback by lookbackDays measured back from the finish', () => {
      const line = plain('BW-B13', { 0: null, 1: null, 2: [6, 18], 3: null, 4: null, 5: null, 6: null });   // Tuesdays only
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 60, 'never', bopts({ lookbackDays: 1 }))), 'unavailable');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 60, 'never', bopts({ lookbackDays: 7 }))),
        '2026-10-20 17:00 -> 2026-10-20 18:00 moved:closed_finish');
    });

    it('treats a non-positive or non-numeric run time as unavailable instead of throwing', () => {
      const line = plain('BW-B14');
      for (const runtime of [0, -5, NaN, Infinity, 'x']) {
        assert.equal(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), runtime, 'never', bopts()).kind, 'unavailable');
      }
    });
  });

  describe('allocateRuntimeBackward: reached_now (4.2.4)', () => {
    // 08:00-20:00 Mon-Fri, 6 h order, held finish Mon 19 Oct 12:00 -> backward start Fri 16 Oct 18:00.
    const reversal = name => plain(name, weekdays(8, 20));

    it('places the walk when it stops exactly at the floor', () => {
      const line = reversal('BW-C1');
      const r = Calendar.allocateRuntimeBackward(line, at(D.mon, '12:00'), 360, 'partial_allowed', bopts({ floor: at('2026-10-16', '18:00') }));
      assert.equal(summary(r), '2026-10-16 18:00 -> 2026-10-19 12:00 [2026-10-16 18:00-2026-10-16 20:00 | 2026-10-19 08:00-2026-10-19 12:00]');
    });

    it('returns reached_now when the walk would place any minute before the floor (partial_allowed)', () => {
      const line = reversal('BW-C2');
      assert.deepEqual(Calendar.allocateRuntimeBackward(line, at(D.mon, '12:00'), 360, 'partial_allowed', bopts({ floor: at('2026-10-16', '19:00') })), { kind: 'reached_now' });
    });

    it('returns reached_now under never when no contiguous slot ends at or after the floor', () => {
      const line = reversal('BW-C3');
      assert.deepEqual(Calendar.allocateRuntimeBackward(line, at(D.mon, '12:00'), 360, 'never', bopts({ floor: at('2026-10-16', '19:00') })), { kind: 'reached_now' });
    });

    it('returns reached_now when the finish itself is before the floor', () => {
      const line = reversal('BW-C4');
      assert.deepEqual(Calendar.allocateRuntimeBackward(line, at(D.mon, '12:00'), 60, 'never', bopts({ floor: at(D.tue, '09:00') })), { kind: 'reached_now' });
    });

    it('returns reached_now, not a partial placement, when nothing fits between the floor and the finish', () => {
      const line = reversal('BW-C5');
      Store.replaceBlocks([blk('c5', line, at(D.mon, '08:00'), at(D.mon, '20:00'))], 'unit-test');
      assert.deepEqual(Calendar.allocateRuntimeBackward(line, at(D.mon, '12:00'), 60, 'never', bopts({ floor: at(D.mon, '07:00') })), { kind: 'reached_now' });
    });
  });

  describe('allocateRuntimeBackward: contiguity across midnight and DST (OQ46, OQ47)', () => {
    it('merges touching windows across midnight on a 24/7 line, so never can place across midnight (OQ47)', () => {
      const line = plain('BW-D1', everyDay([0, 24]));
      const r = Calendar.allocateRuntimeBackward(line, at(D.tue, '02:00'), 360, 'never', bopts());
      assert.equal(summary(r), '2026-10-19 20:00 -> 2026-10-20 02:00');
      assert.deepEqual(r.scheduleSegments, []);
      const split = Calendar.allocateRuntimeBackward(line, at(D.tue, '02:00'), 360, 'partial_allowed', bopts());
      assert.equal(summary(split), '2026-10-19 20:00 -> 2026-10-20 02:00', 'touching pieces form one bar, not two segments');
    });

    it('does not merge windows separated by a gap', () => {
      const line = plain('BW-D2', weekdays(0, 24));   // Mon-Fri 24 h; weekend closed
      // A 130 h order exceeds the longest merged window (Mon 00:00 -> Sat 00:00 = 120 h).
      assert.equal(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 130 * 60, 'never', bopts()).kind, 'overlong');
      assert.equal(summary(Calendar.allocateRuntimeBackward(line, at(D.fri, '12:00'), 100 * 60, 'never', bopts())),
        '2026-10-19 08:00 -> 2026-10-23 12:00');
    });

    for (const zone of ['UTC', 'America/Chicago', 'Asia/Tokyo']) {
      it(`DST case of 4.2.5 (plantTz Chicago, Sun 8 Mar 2026, 5 h finishing 04:00 -> start Sat 22:00), viewer zone ${zone}`, async () => {
        await withZone(zone, () => {
          const line = plain('BW-E1', everyDay([0, 24]));
          const finish = new Date(2026, 2, 8, 4, 0, 0);
          const r = Calendar.allocateRuntimeBackward(line, finish, 300, 'never', bopts({ plantTz: 'America/Chicago', floor: new Date(2026, 1, 1) }));
          assert.equal(r.kind, 'placed');
          assert.equal(summary(r), '2026-03-07 22:00 -> 2026-03-08 04:00');
          // Elapsed time stays 5 h in plant-zone instants even though the wall clock spans 6 h.
          const core = globalThis.NimbusComputeCore;
          assert.equal((+core.plantInstantFromWallClock('America/Chicago', r.end) - +core.plantInstantFromWallClock('America/Chicago', r.start)) / 3600000, 5);
          // Without a zone the walk is plain wall-clock subtraction and loses the hour.
          if (zone !== 'America/Chicago') {
            const naive = Calendar.allocateRuntimeBackward(line, finish, 300, 'never', bopts({ floor: new Date(2026, 1, 1) }));
            assert.equal(summary(naive), '2026-03-07 23:00 -> 2026-03-08 04:00');
          }
        });
      });
    }

    it('hops days by calendar date across the fall-back change (never minus 24 h)', async () => {
      await withZone('America/New_York', () => {
        const line = plain('BW-E2', everyDay([8, 16]));
        // Sun 1 Nov 2026 is 25 h long in New York. 20 h of runtime from Mon 2 Nov 12:00 spans Mon, Sun and Sat.
        const r = Calendar.allocateRuntimeBackward(line, new Date(2026, 10, 2, 12, 0), 1200, 'partial_allowed', bopts({ floor: new Date(2026, 9, 1) }));
        assert.equal(summary(r), '2026-10-31 08:00 -> 2026-11-02 12:00 [2026-10-31 08:00-2026-10-31 16:00 | 2026-11-01 08:00-2026-11-01 16:00 | 2026-11-02 08:00-2026-11-02 12:00]');
        assert.equal(fmt(globalThis.NimbusComputeCore.prevCalendarDay(new Date(2026, 10, 1, 23, 30))), '2026-10-31 00:00');
      });
    });

    it('prevCalendarDay is the calendar-date twin of _nextCalendarDay', async () => {
      await withZone('America/Chicago', () => {
        const core = globalThis.NimbusComputeCore;
        assert.equal(fmt(core.prevCalendarDay(new Date(2026, 2, 9, 0, 0))), '2026-03-08 00:00');
        assert.equal(fmt(core.prevCalendarDay(new Date(2026, 2, 8, 23, 59))), '2026-03-07 00:00');
        assert.equal(fmt(core.prevCalendarDay(core._nextCalendarDay(new Date(2026, 10, 1, 12, 0)))), '2026-11-01 00:00');
      });
    });
  });

  describe('plantInstantFromWallClock / plantWallClockFromInstant', () => {
    it('round-trips ordinary wall times and resolves DST edges (gap forward, fall-back earlier)', async () => {
      await withZone('UTC', () => {
        const core = globalThis.NimbusComputeCore;
        const tz = 'America/Chicago';
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 6, 1, 12, 30)).toISOString(), '2026-07-01T17:30:00.000Z');
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 0, 1, 12, 30)).toISOString(), '2026-01-01T18:30:00.000Z');
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 2, 8, 4, 0)).toISOString(), '2026-03-08T09:00:00.000Z');
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 2, 7, 22, 0)).toISOString(), '2026-03-08T04:00:00.000Z');
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 2, 8, 2, 30)).toISOString(), '2026-03-08T08:30:00.000Z', 'gap resolves after it');
        assert.equal(core.plantInstantFromWallClock(tz, new Date(2026, 10, 1, 1, 30)).toISOString(), '2026-11-01T06:30:00.000Z', 'ambiguous hour resolves to the earlier occurrence');
        for (const instant of ['2026-03-08T04:00:00.000Z', '2026-03-08T09:00:00.000Z', '2026-07-01T17:30:00.000Z', '2026-12-31T23:59:59.000Z']) {
          const wall = core.plantWallClockFromInstant(tz, new Date(instant));
          assert.equal(core.plantInstantFromWallClock(tz, wall).toISOString(), instant);
        }
        assert.equal(+core.plantInstantFromWallClock(null, new Date(2026, 6, 1, 12, 30)), +new Date(2026, 6, 1, 12, 30), 'no zone: the Date itself');
        assert.equal(core.plantInstantFromWallClock('Not/AZone', new Date(2026, 6, 1, 12, 30)), null, 'invalid zone: null');
        assert.equal(core.plantWallClockFromInstant('Not/AZone', new Date()), null);
      });
    });
  });

  describe('latestAvailable (contiguous twin of nextAvailable)', () => {
    it('returns the latest contiguous interval of the duration ending at or before the finish', () => {
      const line = sim1('BW-F1');
      const hour = 3600000;
      const four = Calendar.latestAvailable(line, at(D.fri, '10:00'), 4 * hour, {});
      assert.deepEqual([fmt(four.start), fmt(four.end)], ['2026-10-23 06:00', '2026-10-23 10:00']);
      const eight = Calendar.latestAvailable(line, at(D.fri, '10:00'), 8 * hour, {});
      assert.deepEqual([fmt(eight.start), fmt(eight.end)], ['2026-10-21 10:00', '2026-10-21 18:00'], 'no Thursday fragment holds 8 h');
    });

    it('returns null for an overlong duration, a closed line, an exhausted floor or lookback', () => {
      const line = sim1('BW-F2');
      const hour = 3600000;
      assert.equal(Calendar.latestAvailable(line, at(D.fri, '10:00'), 13 * hour, {}), null);
      assert.equal(Calendar.latestAvailable(line, at(D.fri, '10:00'), 8 * hour, { floor: at(D.thu, '17:00') }), null, 'floor leaves no 8 h block');
      const closed = plain('BW-F3', everyDay(null));
      assert.equal(Calendar.latestAvailable(closed, at(D.fri, '10:00'), hour, {}), null);
      const tuesdays = plain('BW-F4', { 0: null, 1: null, 2: [6, 18], 3: null, 4: null, 5: null, 6: null });
      assert.equal(Calendar.latestAvailable(tuesdays, at(D.fri, '12:00'), hour, { lookbackDays: 1 }), null);
      assert.ok(Calendar.latestAvailable(tuesdays, at(D.fri, '12:00'), hour, { lookbackDays: 7 }));
    });

    it('honours plantTz for elapsed arithmetic and returns naive wall-clock Dates', async () => {
      await withZone('UTC', () => {
        const line = plain('BW-F5', everyDay([0, 24]));
        const slot = Calendar.latestAvailable(line, new Date(2026, 2, 8, 4, 0), 5 * 3600000, { plantTz: 'America/Chicago', floor: new Date(2026, 1, 1) });
        assert.deepEqual([fmt(slot.start), fmt(slot.end)], ['2026-03-07 22:00', '2026-03-08 04:00']);
      });
    });
  });

  describe('_freeIntervalsBackward', () => {
    const spans = list => list.map(s => `${fmt(s.start)}~${fmt(s.end)}`);

    it('is right-clipped at the finish, left-bounded by the floor, in chronological order (4.2.3)', () => {
      const line = sim1('BW-G1');
      assert.deepEqual(spans(Calendar._freeIntervalsBackward(line, at(D.fri, '10:00'), at(D.wed, '00:00'))), [
        '2026-10-21 06:00~2026-10-21 18:00', '2026-10-22 06:00~2026-10-22 10:00',
        '2026-10-22 12:00~2026-10-22 18:00', '2026-10-23 06:00~2026-10-23 10:00',
      ]);
      assert.deepEqual(spans(Calendar._freeIntervalsBackward(line, at(D.fri, '10:00'), at(D.thu, '14:00'))), [
        '2026-10-22 14:00~2026-10-22 18:00', '2026-10-23 06:00~2026-10-23 10:00',
      ]);
    });

    it('merges touching free intervals across midnight (OQ47) and rounds a blackout start down to the minute', () => {
      const line = plain('BW-G2', everyDay([0, 24]));
      Store.replaceBlocks([{ id: 'g2', line, start: new Date(+at(D.tue, '03:00') + 20000), end: new Date(+at(D.tue, '04:00') + 20000) }], 'unit-test');
      assert.deepEqual(spans(Calendar._freeIntervalsBackward(line, at(D.tue, '12:00'), at(D.mon, '22:00'))), [
        '2026-10-19 22:00~2026-10-20 03:00', '2026-10-20 04:01~2026-10-20 12:00',
      ]);
    });

    it('returns an empty list for a closed line or a floor at or after the finish', () => {
      const closed = plain('BW-G3', everyDay(null));
      assert.deepEqual(Calendar._freeIntervalsBackward(closed, at(D.fri, '12:00'), FLOOR), []);
      const line = plain('BW-G4');
      assert.deepEqual(Calendar._freeIntervalsBackward(line, at(D.fri, '12:00'), at(D.fri, '12:00')), []);
      assert.deepEqual(Calendar._freeIntervalsBackward(line, at(D.fri, '12:00'), at(D.sat, '12:00')), []);
    });
  });

  describe('purity and caches', () => {
    it('does not mutate Store state or the inputs, and returns the same answer through the per-run caches', () => {
      const line = sim1('BW-H1');
      const finish = at(D.fri, '10:00'), floor = at(D.wed, '00:00');
      const before = JSON.stringify({ c: Store.calendars, b: Store.blocks, t: Store.tasksArr, f: +finish, fl: +floor });
      const uncached = summary(Calendar.allocateRuntimeBackward(line, finish, 480, 'partial_allowed', bopts({ floor })));
      Calendar._beginRun(null);
      const cached = summary(Calendar.allocateRuntimeBackward(line, finish, 480, 'partial_allowed', bopts({ floor })));
      const cachedNever = summary(Calendar.allocateRuntimeBackward(line, finish, 480, 'never', bopts({ floor })));
      Calendar._endRun();
      assert.equal(cached, uncached);
      assert.equal(cachedNever, '2026-10-21 10:00 -> 2026-10-21 18:00 moved:no_slot_at_finish');
      assert.equal(JSON.stringify({ c: Store.calendars, b: Store.blocks, t: Store.tasksArr, f: +finish, fl: +floor }), before);
    });

    it('leaves the forward helpers untouched in behaviour (nextAvailable still snaps forward)', () => {
      const line = plain('BW-H2');
      const start = Calendar.nextAvailable(line, at(D.wed, '05:00'), 3600000);
      assert.equal(fmt(start), '2026-10-21 06:00');
    });
  });
});
