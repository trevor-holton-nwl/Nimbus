// B22: plantInstantFromWallClock / plantWallClockFromInstant cache the invalid-zone verdict and the per-(zone, hour)
// offset. The results must be byte-identical to the uncached algorithm, including across DST boundaries, so this file
// carries a reference copy of the ORIGINAL uncached implementation and compares every wall time in the scanned windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const corePath = require.resolve('../../../frontend/nimbus-compute-core.js');
const MS_DAY = 86400000;

function freshCore() {
  delete require.cache[corePath];
  return require(corePath);
}

// ---- reference: the original, uncached algorithm (no offset memo; only the formatter is reused, for speed) -------
const refFmts = new Map();
function refFmt(timezone) {
  if (!refFmts.has(timezone)) {
    refFmts.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
      second: 'numeric', hourCycle: 'h23',
    }));
  }
  return refFmts.get(timezone);
}
function refWallAsUtcMs(timezone, instantMs) {
  try {
    const fmt = refFmt(timezone);
    const values = {};
    for (const part of fmt.formatToParts(new Date(instantMs))) if (part.type !== 'literal') values[part.type] = Number(part.value);
    if (![values.year, values.month, values.day, values.hour, values.minute, values.second].every(Number.isFinite)) return null;
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  } catch { return null; }
}
function refInstantFromWall(timezone, wall) {
  if (!timezone) return new Date(wall);
  const asUtc = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(),
    wall.getMinutes(), wall.getSeconds(), wall.getMilliseconds());
  if (!Number.isFinite(asUtc)) return null;
  const offsetAt = ms => { const w = refWallAsUtcMs(timezone, ms); return w === null ? null : w - Math.floor(ms / 1000) * 1000; };
  const before = offsetAt(asUtc - MS_DAY);
  const after = offsetAt(asUtc + MS_DAY);
  if (before === null || after === null) return null;
  if (before === after) return new Date(asUtc - before);
  const candBefore = asUtc - before, candAfter = asUtc - after;
  const okBefore = offsetAt(candBefore) === before;
  const okAfter = offsetAt(candAfter) === after;
  if (okBefore && okAfter) return new Date(Math.min(candBefore, candAfter));
  if (okBefore) return new Date(candBefore);
  if (okAfter) return new Date(candAfter);
  return new Date(Math.max(candBefore, candAfter));
}
function refWallFromInstant(timezone, instant) {
  if (!timezone) return new Date(instant);
  try {
    const fmt = refFmt(timezone);
    const values = {};
    for (const part of fmt.formatToParts(instant)) if (part.type !== 'literal') values[part.type] = Number(part.value);
    if (![values.year, values.month, values.day, values.hour, values.minute, values.second].every(Number.isFinite)) return null;
    return new Date(values.year, values.month - 1, values.day, values.hour, values.minute, values.second, instant.getMilliseconds());
  } catch { return null; }
}

const same = (a, b) => (a === null || b === null) ? a === b : a.getTime() === b.getTime();

// [zone, first wall day, number of days]: every window straddles a spring-forward and/or fall-back (or none: Kolkata).
const WINDOWS = [
  ['America/New_York', new Date(2026, 2, 6), 5],        // spring forward 2026-03-08
  ['America/New_York', new Date(2026, 9, 31), 4],       // fall back 2026-11-01 (ambiguous 01:00-02:00)
  ['Asia/Kolkata', new Date(2026, 2, 6), 4],            // +05:30, no DST
  ['Australia/Lord_Howe', new Date(2026, 3, 3), 4],     // 30-minute fall back (2026-04-05)
  ['Australia/Lord_Howe', new Date(2026, 9, 2), 4],     // 30-minute spring forward (2026-10-04)
  ['Europe/London', new Date(2026, 2, 28), 3],          // spring forward 2026-03-29
];

test('cached wall -> instant equals the uncached algorithm for every 10 minutes across DST boundaries (4 zones)', () => {
  const Core = freshCore();
  let compared = 0;
  for (const [zone, start, days] of WINDOWS) {
    for (let min = 0; min < days * 24 * 60; min += 10) {
      const wall = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, min, 0, 0);
      const got = Core.plantInstantFromWallClock(zone, wall);
      const want = refInstantFromWall(zone, wall);
      assert.ok(same(got, want), `${zone} ${wall.toString()}: ${got} vs ${want}`);
      compared++;
    }
  }
  assert.ok(compared > 2000);
  // A second pass is served from the warm cache and must still match.
  for (const [zone, start, days] of WINDOWS) {
    for (let min = 5; min < days * 24 * 60; min += 37) {
      const wall = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, min, 0, 0);
      assert.ok(same(Core.plantInstantFromWallClock(zone, wall), refInstantFromWall(zone, wall)), `${zone} warm ${wall.toString()}`);
    }
  }
});

test('cached instant -> wall equals the uncached algorithm (4 zones, DST windows)', () => {
  const Core = freshCore();
  for (const [zone, start, days] of WINDOWS) {
    for (let min = 0; min < days * 24 * 60; min += 15) {
      const instant = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) + min * 60000 + 123);
      assert.ok(same(Core.plantWallClockFromInstant(zone, instant), refWallFromInstant(zone, instant)), `${zone} ${instant.toISOString()}`);
    }
  }
});

test('the known DST pins hold: spring-forward gap resolves after the gap, fall-back resolves to the earlier occurrence', () => {
  const Core = freshCore();
  const tz = 'America/New_York';
  assert.equal(Core.plantInstantFromWallClock(tz, new Date(2026, 2, 8, 2, 30)).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(Core.plantInstantFromWallClock(tz, new Date(2026, 10, 1, 1, 30)).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(Core.plantInstantFromWallClock('Asia/Kolkata', new Date(2026, 5, 1, 12, 0)).toISOString(), '2026-06-01T06:30:00.000Z');
});

test('an invalid zone is remembered: Intl.DateTimeFormat is constructed once, never per call, and every result is null', () => {
  const Core = freshCore();
  const RealDTF = Intl.DateTimeFormat;
  let constructed = 0;
  Intl.DateTimeFormat = function (...args) { constructed++; return new RealDTF(...args); };
  Intl.DateTimeFormat.prototype = RealDTF.prototype;
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal(Core.plantInstantFromWallClock('Not/AZone', new Date(2026, 5, 1, i % 24, 0)), null);
      assert.equal(Core.plantWallClockFromInstant('Not/AZone', new Date(2026, 5, 1)), null);
    }
    assert.equal(constructed, 1, 'one failed construction, then the sentinel');
    assert.equal(refInstantFromWall('Not/AZone', new Date(2026, 5, 1)), null, 'the reference agrees');
    // No zone at all keeps its pass-through behaviour.
    const w = new Date(2026, 5, 1, 9, 0);
    assert.equal(Core.plantInstantFromWallClock('', w).getTime(), w.getTime());
    assert.equal(Core.plantWallClockFromInstant(null, w).getTime(), w.getTime());
  } finally {
    Intl.DateTimeFormat = RealDTF;
  }
});

test('the per-(zone, hour) offset cache removes most formatter calls without changing results', () => {
  const Core = freshCore();
  const RealDTF = Intl.DateTimeFormat;
  const calls = { cached: 0, reference: 0 };
  let bucket = 'cached';
  refFmts.clear();   // rebuilt under the counting constructor below
  Intl.DateTimeFormat = function (...args) {
    const f = new RealDTF(...args);
    const orig = f.formatToParts.bind(f);
    f.formatToParts = (d) => { calls[bucket]++; return orig(d); };
    return f;
  };
  Intl.DateTimeFormat.prototype = RealDTF.prototype;
  try {
    const walls = [];
    for (let min = 0; min < 5 * 24 * 60; min += 10) walls.push(new Date(2026, 2, 6, 0, min));
    const got = walls.map(w => Core.plantInstantFromWallClock('America/New_York', w));
    bucket = 'reference';
    const want = walls.map(w => refInstantFromWall('America/New_York', w));
    got.forEach((g, i) => assert.ok(same(g, want[i]), walls[i].toString()));
    assert.ok(calls.cached * 4 < calls.reference, `cached ${calls.cached} vs uncached ${calls.reference} formatter calls`);
  } finally {
    Intl.DateTimeFormat = RealDTF;
  }
});
