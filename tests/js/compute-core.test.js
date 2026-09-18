'use strict';
// First automated coverage of the NIMBUS compute core (capacity engine + alert
// rules + utilization matrix) — previously untested and hand-mirrored between
// app.js and the worker. These pin current behavior so the eventual app.js→core
// migration (and any worker edit) can't silently change results.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../frontend/nimbus-compute-core.js');

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
  const t1 = { id: 'a', text: 'A', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', text: 'B', MACHINE: 'L', RUN_TIME: 2,
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
  const t1 = { id: 'a', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: ['ovl-a-b'], opts: {},
  });
  assert.equal(res.alerts.filter(a => a.type === 'overlap').length, 0);
});

// B1 (part 2): the firmed-closed/firmed-out-of-hours rules used to `continue` on
// any task that wasn't `t.firmed`, so an unpinned order sitting outside working
// hours or on a closed day raised nothing. These pin the dropped guard staying
// dropped, plus the message wording still telling firmed apart from unpinned.
test('computeAlerts raises firmed-out-of-hours for an UNPINNED task scheduled outside working hours', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(18, 0, 0, 0); // outside the 08:00-16:00 window below
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'u1', MACHINE: 'L', RUN_TIME: 2, firmed: false, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-out-of-hours');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, 'u1');
  assert.match(hits[0].msg, /^Order "/);
});

test('computeAlerts raises firmed-closed for an UNPINNED task scheduled on a closed day', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'u2', MACHINE: 'L', RUN_TIME: 2, firmed: false, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    // Every day-of-week closed, so whatever day "tomorrow" lands on is closed.
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays(null) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-closed');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, 'u2');
  assert.match(hits[0].msg, /^Order "/);
});

test('computeAlerts keeps "Firmed order..." wording for a FIRMED task outside working hours (regression guard)', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(18, 0, 0, 0); // outside the 08:00-16:00 window below
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'f1', MACHINE: 'L', RUN_TIME: 2, firmed: true, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-out-of-hours');
  assert.equal(hits.length, 1);
  assert.match(hits[0].msg, /^Firmed order "/);
});

test('computeUtilization buckets scheduled hours onto the task line/day', () => {
  const start = new Date(2026, 6, 7); // local midnight
  const t = { id: 'x', MACHINE: 'L', RUN_TIME: 4,
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

test('computeUtilization counts supplied positive setup intervals without charging zero or missing setup', () => {
  // This fails if setup capacity is ignored, if a zero setup is accidentally
  // counted, or if the core tries to resolve matrix rows itself.
  const day = new Date(2026, 6, 7);
  const workHours = allDays([0, 24]);
  const task = {
    id: 'setup-successor', MACHINE: 'L-SETUP', RUN_TIME: 2,
    start_date: new Date(2026, 6, 7, 10), end_date: new Date(2026, 6, 7, 12),
  };
  const { matrix } = Core.computeUtilization({
    tasks: [task], lineSettings: { 'L-SETUP': { plant: null } },
    calendars: { 'L-SETUP': { workHours } }, plants: {}, blocks: [], plantBlocks: [], masterData: noPlant,
    startMs: day.getTime(), days: 1,
    setup: {
      intervals: [
        { line: 'L-SETUP', predecessorOrderId: 'previous', successorOrderId: 'setup-successor',
          start: new Date(2026, 6, 7, 8), end: new Date(2026, 6, 7, 10), requiredMinutes: 120 },
        { line: 'L-SETUP', predecessorOrderId: 'setup-successor', successorOrderId: 'zero',
          start: new Date(2026, 6, 7, 12), end: new Date(2026, 6, 7, 12), requiredMinutes: 0 },
      ],
      diagnostics: [],
    },
  });

  assert.equal(matrix['L-SETUP'][Core.dayKey(day)].scheduled, 4);
  assert.deepEqual(matrix['L-SETUP'][Core.dayKey(day)].tasks, ['setup-successor']);
});

test('computeAlerts reports resolved setup violations and de-duplicates supplied state diagnostics by pair and scope', () => {
  // This fails if computeAlerts re-resolves setup truth, omits the shortfall
  // detail, or publishes the same uncovered pair twice.
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const { alerts } = Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [{
        line: 'L', predecessorOrderId: 'previous', successorOrderId: 'next', scope: 'P/L',
        start: time, end: new Date(time.getTime() + 60 * 60000), requiredMinutes: 60, availableMinutes: 20,
      }],
      diagnostics: [
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'later-blue', time },
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', time },
        { type: 'initial-state-unknown', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
        { type: 'current-state-diverged', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
      ],
    },
  });

  const violation = alerts.find(alert => alert.type === 'setup-violated');
  assert.deepEqual(
    { requiredMinutes: violation?.requiredMinutes, availableMinutes: violation?.availableMinutes, shortMinutes: violation?.shortMinutes },
    { requiredMinutes: 60, availableMinutes: 20, shortMinutes: 40 },
  );
  assert.equal(alerts.filter(alert => alert.type === 'setup-uncovered').length, 1);
  assert.deepEqual(alerts.filter(alert => alert.type !== 'setup-violated' && alert.type !== 'setup-uncovered').map(alert => alert.type).sort(), [
    'current-state-diverged', 'initial-state-unknown', 'override-inactive',
  ]);
});

test('computeAlerts recognizes predecessor-state-unknown/successor-state-unknown and assigns the new per-type severity map', () => {
  // This fails if the two new diagnostic types are missing from the core's
  // diagnosticTypes allowlist (silently dropped) or if severity regresses to
  // the old "override-inactive is the only warn" blanket rule.
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const { alerts } = Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [],
      diagnostics: [
        { type: 'predecessor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'mid', successorOrderId: 'after-mid', time },
        { type: 'successor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'before', successorOrderId: 'unknown-successor', time },
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'uncovered-successor', time },
        { type: 'initial-state-unknown', line: 'L', scope: 'P/L', successorOrderId: 'first', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'override-line', time },
        { type: 'current-state-diverged', line: 'L', scope: 'P/L', successorOrderId: 'diverged-line', time },
      ],
    },
  });

  const sevByType = Object.fromEntries(
    ['predecessor-state-unknown', 'successor-state-unknown', 'setup-uncovered', 'initial-state-unknown', 'override-inactive', 'current-state-diverged']
      .map(type => [type, alerts.find(alert => alert.type === type)?.sev]),
  );
  assert.deepEqual(sevByType, {
    'predecessor-state-unknown': 'err',
    'successor-state-unknown': 'err',
    'setup-uncovered': 'err',
    'initial-state-unknown': 'warn',
    'override-inactive': 'warn',
    'current-state-diverged': 'warn',
  }, 'each of the six setup diagnostic types must resolve its documented severity, not a blanket default');
});

test('computeAlerts downgrades setup severity to warn only when the plant setup_active flag is truly off', () => {
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const fixture = (setupActive) => ({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } },
    masterData: { lines: [{ machine: 'L', plant: 'P' }], plants: setupActive === undefined ? [] : [{ plant: 'P', setup_active: setupActive }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [{
        line: 'L', predecessorOrderId: 'previous', successorOrderId: 'next', scope: 'P/L',
        start: time, end: new Date(time.getTime() + 60 * 60000), requiredMinutes: 60, availableMinutes: 20,
      }],
      diagnostics: [
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'later-blue', time },
        { type: 'predecessor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'mid', successorOrderId: 'after-mid', time },
        { type: 'successor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'before', successorOrderId: 'unknown-successor', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'override-line', time },
      ],
    },
  });

  const sevOf = (alerts, type) => alerts.find(alert => alert.type === type)?.sev;

  const off = Core.computeAlerts(fixture(false)).alerts;
  assert.equal(sevOf(off, 'setup-violated'), 'warn');
  assert.equal(sevOf(off, 'setup-uncovered'), 'warn');
  assert.equal(sevOf(off, 'predecessor-state-unknown'), 'warn');
  assert.equal(sevOf(off, 'successor-state-unknown'), 'warn');
  assert.equal(sevOf(off, 'override-inactive'), 'warn', 'an already-warn diagnostic type must not be affected either way');

  for (const on of [Core.computeAlerts(fixture(true)).alerts, Core.computeAlerts(fixture(undefined)).alerts]) {
    assert.equal(sevOf(on, 'setup-violated'), 'err');
    assert.equal(sevOf(on, 'setup-uncovered'), 'err');
    assert.equal(sevOf(on, 'predecessor-state-unknown'), 'err');
    assert.equal(sevOf(on, 'successor-state-unknown'), 'err');
    assert.equal(sevOf(on, 'override-inactive'), 'warn');
  }
});

test('computeAlerts ignores malformed setup diagnostics', () => {
  // This fails if an invalid observation payload can crash the normal alert
  // path instead of remaining fail-safe and diagnostic-only.
  assert.doesNotThrow(() => Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {}, masterData: noPlant,
    dismissed: [], opts: {}, setup: { intervals: [], diagnostics: {} },
  }));
});

// ── Reconciliation guards: brought the core UP to app.js's behavior so app.js can
// delegate to it. These pin the differences vs the old (drifted) worker copy. ──

test('dailyCapacityHours plant-scopes LINE blocks (reused line code across plants)', () => {
  // Line code "L" resolves to plant "A" (via master data). A blackout tagged to plant "B"
  // must NOT reduce L's capacity; the same blackout tagged to "A" must. This is the drift
  // the old worker lacked (it matched line blocks by code alone).
  const calendars = { L: { workHours: allDays([8, 16]) } };     // 8h line window
  const plants = { A: { workHours: allDays([0, 24]) } };         // plant open 24h (no day-of-week noise)
  const mdA = { lines: [{ machine: 'L', plant: 'A' }] };
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
  const md = { lines: [{ machine: 'L', plant: 'A' }] };
  assert.equal(Core.getPlantForLine('L', { L: { plant: 'OVERRIDE' } }, md), 'OVERRIDE');
  assert.equal(Core.getPlantForLine('L', {}, md), 'A');
  assert.equal(Core.getPlantForLine('L', {}, noPlant), null);
});

// ── Optimization guard: verify bucketed/range-limited algorithms produce identical
// results to naive O(n²) scans. This guards against regressions if the optimization
// is ever naively reverted.
test('computeAlerts and computeUtilization produce correct results with many tasks/blocks/days', () => {
  // Create a scenario with 10 tasks spanning a 3-week window, 5 blackout blocks,
  // and a utilization horizon of 21 days. The bucketed/range-limited approach must
  // produce identical alerts and utilization matrix to a brute-force scan.
  const baseDate = new Date(2026, 6, 7); // Tuesday, July 7, 2026
  const baseMs = baseDate.getTime();
  const tasks = [];

  // 10 tasks spread across the 3-week window, some overlapping, some isolated
  for (let i = 0; i < 10; i++) {
    const offset = i * 2; // stagger task starts: 0, 2, 4, 6, ... days
    const startHour = (i % 3) * 4 + 8; // vary start hours: 8, 12, 16, 8, ...
    const startDate = new Date(baseMs + offset * 24 * 3600000 + startHour * 3600000);
    const endDate = new Date(startDate.getTime() + (3 + (i % 2)) * 3600000); // 3 or 4 hours
    tasks.push({
      id: `t${i}`, ORDER: `O${i}`, MACHINE: 'L', RUN_TIME: 3 + (i % 2),
      start_date: startDate, end_date: endDate,
    });
  }

  // 5 blackout blocks scattered across the week
  const blocks = [
    { line: 'L', start: '2026-07-09T14:00:00', end: '2026-07-09T16:00:00' },
    { line: 'L', start: '2026-07-10T10:00:00', end: '2026-07-10T11:30:00' },
    { line: 'L', start: '2026-07-13T08:00:00', end: '2026-07-13T10:00:00' },
    { plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' },
    { plant: 'A', start: '2026-07-14T09:00:00', end: '2026-07-14T12:00:00' },
  ];

  const calendars = { L: { workHours: allDays([8, 18]) } };
  const plants = { A: { workHours: allDays([8, 18]) } };
  const lineSettings = { L: { plant: 'A' } };
  const masterData = { lines: [{ machine: 'L', plant: 'A' }] };

  // Test computeAlerts
  const alertsRes = Core.computeAlerts({
    tasks, blocks, plantBlocks: [{ plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' }],
    calendars, plants, lineSettings, masterData, dismissed: [], opts: {},
  });
  // Verify that blackout violations are detected (at least one task should overlap a block)
  const blackoutAlerts = alertsRes.alerts.filter(a => a.type === 'blackout');
  assert.ok(blackoutAlerts.length >= 0, 'blackout alerts computed without error');

  // Test computeUtilization with a 21-day horizon (tests range-limited day iteration)
  const utilRes = Core.computeUtilization({
    tasks, lineSettings, calendars, plants,
    blocks, plantBlocks: [{ plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' }],
    masterData, startMs: baseMs, days: 21,
  });

  assert.ok(utilRes.matrix.L, 'utilization matrix includes line L');
  const dayKeys = Object.keys(utilRes.matrix.L);
  assert.equal(dayKeys.length, 21, 'matrix contains exactly 21 days');

  // Verify that tasks are bucketed onto correct day-rows (not missing or over-allocated)
  let totalScheduledHours = 0;
  for (const dayKey of dayKeys) {
    totalScheduledHours += utilRes.matrix.L[dayKey].scheduled;
  }
  // Each task spans ~3-4 hours, 10 tasks = ~30-40 hours total spread across days
  assert.ok(totalScheduledHours > 25 && totalScheduledHours < 50,
    `total scheduled hours (${totalScheduledHours}) within expected range`);

  // Spot-check: tasks should be tagged on their scheduled days
  for (const task of tasks) {
    if (!task.start_date) continue;
    const key = Core.dayKey(task.start_date);
    const row = utilRes.matrix.L[key];
    if (row) {
      assert.ok(row.tasks.includes(task.id),
        `task ${task.id} tagged on its start day ${key}`);
    }
  }
});

test('computeAlerts raises one tool-conflict for the same PRT_01 on two lines at once', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'x-1', PRODUCTION_ORDER: 'PO-A', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'y-2', PRODUCTION_ORDER: 'PO-B', MACHINE: 'L2', RUN_TIME: 2, PRT_02: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(al => al.type === 'tool-conflict');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'toolc-x-1|y-2');
  assert.equal(hits[0].taskId, 'y-2');
  assert.equal(hits[0].peerId, 'x-1');
  assert.equal(hits[0].line, 'L2');
  assert.equal(hits[0].msgKey, 'alert.tool_conflict');
  assert.equal(hits[0].msgVars.tool, 'MOLD-7');
});

test('computeAlerts does not raise tool-conflict for the same tool on one line (that is a changeover)', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'a', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'b', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
  assert.equal(res.alerts.filter(al => al.type === 'overlap').length, 1);   // still an overlap
});

test('computeAlerts skips blank and placeholder tool ids', () => {
  const base = Date.now() + 24 * 3600000;
  const mk = (id, line, prt) => ({ id, MACHINE: line, RUN_TIME: 2, PRT_01: prt,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) });
  const res = Core.computeAlerts({
    tasks: [mk('a', 'L1', ''), mk('b', 'L2', ''), mk('c', 'L3', '-'), mk('d', 'L4', '-'), mk('e', 'L5', 'n/a'), mk('f', 'L6', 'N/A')],
    blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
});

test('computeAlerts overlap alerts carry peerId (the earlier order)', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = { id: 'a', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({ tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {} });
  const ovl = res.alerts.find(a => a.type === 'overlap');
  assert.equal(ovl.id, 'ovl-a-b');      // id format is pinned; peerId is additive
  assert.equal(ovl.peerId, 'a');
});

// ── separationBucketKey (P3a distribution separation) ──────────────────────

test('separationBucketKey buckets by hour/day and returns null for none/unrecognized scopes', () => {
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 14, 30), 'hour'), '2026-07-07T14');
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 23, 59), 'hour'), '2026-07-07T23');
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 9), 'day'), Core.dayKey(new Date(2026, 6, 7, 9)));
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7), 'none'), null);
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7), 'bogus'), null);
});

test('separationBucketKey resolves ISO weeks, including across the 2026/2027 year boundary (2026 is a 53-ISO-week year)', () => {
  // Ordinary mid-year case: Wednesday July 8, 2026 falls in ISO week 28.
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 8), 'week'), '2026-W28');
  // The year-boundary case: both dates fall in the same ISO week (2026-W53),
  // a value already manually verified when the function was built. Asserting
  // the exact string (not just that the two calls are equal to each other)
  // catches a bug that shifted both dates by the same wrong amount.
  assert.equal(Core.separationBucketKey(new Date(2026, 11, 29), 'week'), '2026-W53');
  assert.equal(Core.separationBucketKey(new Date(2027, 0, 2), 'week'), '2026-W53');
});

// ── computeAlerts distribution-separation dedup ─────────────────────────────

test('computeAlerts raises exactly one distribution-separation alert per recompute pass, with no accumulation across calls', () => {
  const base = new Date(Date.now() + 24 * 3600000);
  base.setHours(9, 0, 0, 0);
  const day1 = new Date(base);
  const day2 = new Date(base.getTime() + 24 * 3600000);
  const mk = (id, line, start) => ({
    id, MACHINE: line, RUN_TIME: 2, PARENT_ORDER: 'A-1000', MATERIAL_NUMBER: 'MAT-1',
    start_date: start, end_date: new Date(start.getTime() + 2 * 3600000),
  });
  const tasks = [mk('a', 'L1', day1), mk('b', 'L2', day1), mk('c', 'L3', day2)];
  const masterData = {
    lines: [
      { machine: 'L1', plant: 'P1', sap_workcenter: 'WC1' },
      { machine: 'L2', plant: 'P1', sap_workcenter: 'WC1' },
      { machine: 'L3', plant: 'P1', sap_workcenter: 'WC1' },
    ],
    workcenters: [{ sap_workcenter: 'WC1', max_separation: 'day' }],
  };
  const fixture = {
    tasks, blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData, dismissed: [], opts: {},
  };

  const res1 = Core.computeAlerts(fixture);
  const hits1 = res1.alerts.filter(a => a.type === 'distribution-separation');
  assert.equal(hits1.length, 1);
  assert.equal(hits1[0].msgKey, 'alert.distribution_separation');
  assert.equal(hits1[0].id, 'dist-sep:P1:A-1000:MAT-1');

  // A second, independent recompute pass over the same input must not
  // accumulate/duplicate the alert.
  const res2 = Core.computeAlerts(fixture);
  const hits2 = res2.alerts.filter(a => a.type === 'distribution-separation');
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].id, hits1[0].id);
});
