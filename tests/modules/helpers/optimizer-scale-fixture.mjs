import assert from 'node:assert/strict';

export const MINUTE = 60000;
export const COLORS = ['GREEN', 'RED', 'BLUE', 'YELLOW'];
export const instant = (hour, minute = 0) => new Date(2035, 7, 6, hour, minute);
export const state = value => [{ fieldKey: 'colorWheel', value }];
export const hours = (start = 8, end = 18) => Object.fromEntries(
  Array.from({ length: 7 }, (_, day) => [day, [start, end]]),
);

/** One selected plant, 70 independently scheduled machines. Other plants are
 * metadata only unless the test explicitly adds demand; the UI optimizes one
 * plant at a time. All timestamps are local, matching persisted plant dates.
 * Default demand: 12 queued orders/machine, 30/45/60 minutes, four colors;
 * 9 productive hours + at most 60 setup minutes fit a 10-hour shift. */
export function scaleFixture({ ordersPerLine = 12, plantCount = 1, colors = COLORS, runtime = null } = {}) {
  const plant = 'SCALE-P00';
  const lines = Array.from({ length: 70 }, (_, index) => `${plant}-M${String(index).padStart(2, '0')}`);
  const plants = Array.from({ length: plantCount }, (_, index) => `SCALE-P${String(index).padStart(2, '0')}`);
  const tasks = lines.flatMap(machine => Array.from({ length: ordersPerLine }, (_, index) => ({
    id: `${machine}-O${String(index).padStart(2, '0')}`,
    PLANT: plant, plant, MACHINE: machine, COLOR: colors[index % colors.length],
    RUN_TIME: runtime ?? [0.5, 0.75, 1][index % 3],
    original_end_date: instant(18), original_start_date: instant(8),
    start_date: null, end_date: null, planning_status: 'needs_planning',
    scheduleSegments: [], firmed: false, row_version: `row-${index}`,
  })));
  const setup = {
    plant, plant_active: true,
    definition: { plant, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_rows: COLORS.flatMap(from => COLORS.filter(to => to !== from).map(to => ({
      machine: '', signature_version: 1, from_key: state(from), to_key: state(to), setup_min: 5,
    }))),
    machine_rows: [], overrides: [],
    machine_states: lines.map(machine => ({ machine, state_key: state('GREEN'), signature_version: 1, source: 'manual' })),
  };
  const snapshot = {
    tasks, selectedPlant: plant, firmedIds: [], alerts: [], blocks: [], plantBlocks: [],
    calendars: Object.fromEntries(lines.map(line => [line, { workHours: hours() }])),
    plants: Object.fromEntries(plants.map(owner => [owner, { workHours: hours() }])),
    lineSettings: {}, priorityRankMaps: {}, readModelVersion: 'scale-revision-1', setupSnapshot: setup,
    masterData: {
      plants: plants.map(owner => ({ plant: owner, setup_active: true, split_order_policy: 'never' })),
      lines: plants.flatMap(owner => Array.from({ length: 70 }, (_, index) => ({
        plant: owner, machine: `${owner}-M${String(index).padStart(2, '0')}`,
      }))),
    },
  };
  const bounds = {
    setup, now: instant(8), runNow: instant(7), planningStart: instant(8), horizonEnd: instant(18),
    respectCalendar: true, exactSearchThreshold: 8, iterationCap: 70 * 20000,
    clock: () => 0, deadline: 5000,
  };
  return { plant, lines, snapshot, setup, bounds };
}

export function finalRows(snapshot, result) {
  const changes = new Map(result.patches.map(patch => [patch.id, patch.changes]));
  return snapshot.tasks.map(task => ({ ...task, ...changes.get(task.id) }));
}

/** Deliberately independent of scheduler validation, placement, calendar and
 * patch helpers: count IDs, integrate production and check physical capacity.
 * The caller supplies hand-derived open intervals and transition costs. */
export function assertScalePlan(fixture, result, {
  selectedLines = fixture.lines,
  windows = () => [[instant(8), instant(18)]],
  setupMinutes = (from, to) => from === to ? 0 : 5,
  allowSplit = false,
} = {}) {
  const selected = new Set(selectedLines);
  const scoped = fixture.snapshot.tasks.filter(task => task.PLANT === fixture.plant && selected.has(task.MACHINE));
  const expectedIds = scoped.map(task => task.id).sort();
  assert.deepEqual(result.dispositions.map(row => row.id).sort(), expectedIds, 'exactly one disposition per scoped order');
  assert.equal(new Set(result.patches.map(patch => patch.id)).size, result.patches.length, 'no duplicate patches');
  const dispositionById = new Map(result.dispositions.map(row => [row.id, row]));
  const sourceById = new Map(fixture.snapshot.tasks.map(row => [row.id, row]));
  const protectedIds = new Set(fixture.snapshot.firmedIds);
  for (const patch of result.patches) {
    assert.ok(dispositionById.has(patch.id), 'patch is inside selected plant and machine scope');
    assert.equal(protectedIds.has(patch.id), false, 'protected orders cannot be patched');
    if (patch.changes.planning_status === 'needs_planning') {
      assert.equal(patch.changes.start_date, null);
      assert.equal(patch.changes.end_date, null);
      assert.deepEqual(patch.changes.scheduleSegments, []);
      assert.ok(patch.changes.planning_reason?.code, 'queued work explains why it was not admitted');
    }
  }
  const rows = finalRows(fixture.snapshot, result);
  let runtimeMinutes = 0;
  let scheduledCount = 0;
  let totalSetup = 0;
  for (const machine of selectedLines) {
    const admitted = rows.filter(row => row.PLANT === fixture.plant && row.MACHINE === machine
      && dispositionById.get(row.id)?.status !== 'needs_planning').sort((a, b) => +a.start_date - +b.start_date);
    let end = +fixture.bounds.now;
    let color = 'GREEN';
    for (const row of admitted) {
      const incoming = setupMinutes(color, row.COLOR, machine);
      assert.ok(+row.start_date >= end + incoming * MINUTE, `production/setup overlap on ${row.id}`);
      assert.ok(+row.end_date <= +fixture.bounds.horizonEnd, `horizon overflow on ${row.id}`);
      const segments = row.scheduleSegments?.length
        ? row.scheduleSegments.map(segment => ({ start: segment.startDate, end: segment.endDate }))
        : [{ start: row.start_date, end: row.end_date }];
      if (!allowSplit) assert.equal(segments.length, 1, 'never-split policy');
      let produced = 0;
      let segmentEnd = +row.start_date;
      for (const segment of segments) {
        assert.ok(+segment.start >= segmentEnd && +segment.end > +segment.start, `ordered positive segments on ${row.id}`);
        assert.ok(windows(machine).some(([open, close]) => +segment.start >= +open && +segment.end <= +close), `calendar capacity on ${row.id}`);
        produced += (+segment.end - +segment.start) / MINUTE;
        segmentEnd = +segment.end;
      }
      assert.equal(+segments[0].start, +row.start_date);
      assert.equal(+segments.at(-1).end, +row.end_date);
      assert.equal(produced, sourceById.get(row.id).RUN_TIME * 60, `runtime conservation on ${row.id}`);
      if (incoming) {
        assert.ok(windows(machine).some(([open, close]) => +row.start_date - incoming * MINUTE >= +open && +row.start_date <= +close), `setup occupies working time on ${row.id}`);
      }
      if (protectedIds.has(row.id)) assert.deepEqual(row, sourceById.get(row.id));
      runtimeMinutes += produced;
      scheduledCount += 1;
      totalSetup += incoming;
      end = +row.end_date;
      color = row.COLOR;
    }
  }
  assert.equal(result.objective.scheduledCount, scheduledCount);
  assert.equal(result.objective.productiveRuntimeMinutes, runtimeMinutes);
  assert.equal(result.objective.setupMinutes, totalSetup);
  assert.deepEqual(result.validationFindings.filter(row => row.severity === 'error'), []);
  return { rows, scheduledCount, runtimeMinutes, totalSetup };
}
