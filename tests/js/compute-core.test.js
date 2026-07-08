'use strict';
// First automated coverage of the NIMBUS compute core (capacity engine + alert
// rules + utilization matrix) — previously untested and hand-mirrored between
// app.js and the worker. These pin current behavior so the eventual app.js→core
// migration (and any worker edit) can't silently change results.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../nimbus-compute-core.js');

const allDays = (window) => {
  const wh = {};
  for (let i = 0; i < 7; i++) wh[i] = window ? [...window] : null;
  return wh;
};
const noPlant = { lines: [] };

test('_dayWindow keeps fractional working hours (08:30, not floored to 08:00)', () => {
  // Regression guard for R3: setHours() truncates its hour arg, so 8.5 must be
  // split into 08:30, not collapsed to 08:00.
  const [s, e] = Core._dayWindow(allDays([8.5, 16.5]), new Date(2026, 6, 7, 12));
  assert.equal(s.getHours(), 8);
  assert.equal(s.getMinutes(), 30);
  assert.equal(e.getHours(), 16);
  assert.equal(e.getMinutes(), 30);
});

test('_dayWindow returns null on a closed (null) day', () => {
  assert.equal(Core._dayWindow(allDays(null), new Date(2026, 6, 7, 12)), null);
});

test('effectiveFromCapacity applies pct and hours buffers, else passthrough', () => {
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'pct', bufferPct: 20 } }), 8);
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'hours', bufferHours: 3 } }), 7);
  assert.equal(Core.effectiveFromCapacity('L', 10, {}), 10);            // no line settings
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: {} }), 10);     // settings, no buffer
});

test('dailyCapacityHours = working-window hours minus blackout overlap', () => {
  const calendars = { L: { workHours: allDays([8, 16]) } };   // 8h window
  const lineSettings = { L: { plant: null } };                // no plant → line window only
  const blocks = [{ line: 'L', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }]; // 2h out
  const cap = Core.dailyCapacityHours(
    'L', new Date(2026, 6, 7, 12), calendars, {}, lineSettings, noPlant, blocks, [], null,
  );
  assert.equal(cap, 6);
});

test('dailyCapacityHours is 0 on a closed day-of-week', () => {
  const calendars = { L: { workHours: allDays(null) } };
  const cap = Core.dailyCapacityHours(
    'L', new Date(2026, 6, 7, 12), calendars, {}, { L: { plant: null } }, noPlant, [], [], null,
  );
  assert.equal(cap, 0);
});

test('computeAlerts flags exactly one overlap for two overlapping orders on a line', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const t1 = { id: 'a', text: 'A', PRODUCTION_LINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', text: 'B', PRODUCTION_LINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const overlaps = res.alerts.filter(a => a.type === 'overlap');
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].line, 'L');
});

test('computeAlerts honours the dismissed set', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = { id: 'a', PRODUCTION_LINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', PRODUCTION_LINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: ['ovl-a-b'], opts: {},
  });
  assert.equal(res.alerts.filter(a => a.type === 'overlap').length, 0);
});

test('computeUtilization buckets scheduled hours onto the task line/day', () => {
  const start = new Date(2026, 6, 7); // local midnight
  const t = { id: 'x', PRODUCTION_LINE: 'L', RUN_TIME: 4,
    start_date: new Date(2026, 6, 7, 9), end_date: new Date(2026, 6, 7, 13) };
  const { matrix } = Core.computeUtilization({
    tasks: [t], lineSettings: { L: { plant: null } },
    calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    blocks: [], plantBlocks: [], masterData: noPlant,
    startMs: start.getTime(), days: 3,
  });
  assert.ok(matrix.L, 'line L present in matrix');
  const key = Core.dayKey(start);
  assert.ok(matrix.L[key].scheduled > 0, 'scheduled hours bucketed onto the day');
  assert.ok(matrix.L[key].tasks.includes('x'));
});

// ── Reconciliation guards: brought the core UP to app.js's behavior so app.js can
// delegate to it. These pin the differences vs the old (drifted) worker copy. ──

test('dailyCapacityHours plant-scopes LINE blocks (reused line code across plants)', () => {
  // Line code "L" resolves to plant "A" (via master data). A blackout tagged to plant "B"
  // must NOT reduce L's capacity; the same blackout tagged to "A" must. This is the drift
  // the old worker lacked (it matched line blocks by code alone).
  const calendars = { L: { workHours: allDays([8, 16]) } };     // 8h line window
  const plants = { A: { workHours: allDays([0, 24]) } };         // plant open 24h (no day-of-week noise)
  const mdA = { lines: [{ production_line: 'L', plant: 'A' }] };
  const date = new Date(2026, 6, 7, 12);
  const otherPlant = [{ line: 'L', plant: 'B', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }];
  const samePlant  = [{ line: 'L', plant: 'A', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }];

  // non-idx path
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, otherPlant, [], null), 8);
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, samePlant,  [], null), 6);
  // idx path (the one computeAlerts/computeUtilization use)
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, otherPlant, [],
    Core._indexCapacityBlocks(otherPlant, [])), 8);
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, samePlant, [],
    Core._indexCapacityBlocks(samePlant, [])), 6);
});

test('computeUtilization honours an explicit lines set (app.js plant-scoped line set)', () => {
  const { matrix } = Core.computeUtilization({
    tasks: [], lineSettings: {}, calendars: {}, plants: {}, blocks: [], plantBlocks: [],
    masterData: noPlant, startMs: new Date(2026, 6, 7).getTime(), days: 1, lines: ['X', 'Y'],
  });
  assert.deepEqual(Object.keys(matrix).sort(), ['X', 'Y']);
});

test('getPlantForLine: lineSettings override wins over master data', () => {
  const md = { lines: [{ production_line: 'L', plant: 'A' }] };
  assert.equal(Core.getPlantForLine('L', { L: { plant: 'OVERRIDE' } }, md), 'OVERRIDE');
  assert.equal(Core.getPlantForLine('L', {}, md), 'A');
  assert.equal(Core.getPlantForLine('L', {}, noPlant), null);
});
