// Shared fixtures for the Order Rules test matrix (tests/modules/optimization/order-rules-matrix.test.mjs).
//
// The pure builders below are COPIES of the helpers at the top of
// tests/modules/setup-scheduler.test.mjs (that file stays untouched on purpose:
// moving them would be a 6k-line diff). Keep both in sync only if a snapshot
// shape changes. All dates the matrix uses are in 2035 and local time, with the
// plant row carrying the process' own IANA zone so plant-zone and local-zone
// reads agree.

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function at(text) {
  return new Date(text);
}

export function interval(start, end) {
  return { start: at(start), end: at(end) };
}

export function task(id, runHours) {
  return {
    id,
    PLANT: 'P1',
    plant: 'P1',
    MACHINE: 'L1',
    RUN_TIME: runHours,
    start_date: null,
    end_date: null,
    original_start_date: null,
    original_end_date: null,
    BASIC_START_DATE: null,
    BASIC_FINISH_DATE: null,
    firmed: false,
    row_version: null,
  };
}

export function legacySnapshot(tasks) {
  return {
    tasks,
    firmedIds: [],
    alerts: [],
    selectedPlant: 'P1',
    blocks: [],
    plantBlocks: [],
    calendars: {},
    plants: {},
    lineSettings: {},
    masterData: { plants: [{ plant: 'P1' }], lines: [{ plant: 'P1', machine: 'L1' }] },
    priorityRankMaps: {},
  };
}

export const OPEN_HOURS = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [8, 18]]));

export function setupState(value) {
  return [{ fieldKey: 'colorWheel', value }];
}

export function setupDefinition() {
  return {
    plant: 'P1', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true,
  };
}

export function setupRow(from, to, minutes, machine = '') {
  return { machine, signature_version: 1, from_key: setupState(from), to_key: setupState(to), setup_min: minutes };
}

export function setupTruth({ current = 'GREEN', rows = [], overrides = [], definition = setupDefinition() } = {}) {
  return {
    plant: 'P1', definition,
    plant_rows: rows,
    machine_rows: [],
    machine_states: current === null ? [] : [{
      machine: 'L1', state_key: setupState(current), signature_version: 1,
      source: 'manual', reason: 'unit-test current state',
    }],
    overrides,
  };
}

export function scheduledTask(id, runHours, color, due, start = null, end = null) {
  return {
    ...task(id, runHours), COLOR: color,
    original_end_date: due ? at(due) : null,
    start_date: start ? at(start) : null,
    end_date: end ? at(end) : null,
  };
}

export function setupSnapshot(tasks, { firmedIds = [], lineSettings = {} } = {}) {
  return {
    ...legacySnapshot(tasks),
    firmedIds,
    calendars: { L1: { workHours: OPEN_HOURS } },
    plants: { P1: { workHours: OPEN_HOURS } },
    lineSettings,
  };
}

export function dueDateBounds(setup, overrides = {}) {
  return {
    setup,
    exactSearchThreshold: 6,
    iterationCap: 64,
    clock: () => 0,
    deadline: 1,
    now: at('2026-08-03T08:00:00'),
    horizonEnd: at('2026-08-03T18:00:00'),
    ...overrides,
  };
}

export function policySnapshot(tasks, config) {
  const snapshot = setupSnapshot(tasks);
  snapshot.masterData = { plants: [{ plant: 'P1', setup_policy_config: config }], lines: [{ plant: 'P1', machine: 'L1' }] };
  return snapshot;
}

/** A setup-aware snapshot whose plant row carries the five Order Rules values.
 * `rules` keys use the plant-row column names so a case table reads like the
 * Settings panel: max_pull_forward_days, max_push_forward_days,
 * min_productive_segment_minutes, split_order_policy, setup_policy_config.
 * `calendars` replaces the per-line calendar map ({} = no line calendar row);
 * `plantHours` replaces the plant default-hours row. */
export function rulesSnapshot(tasks, rules = {}, { firmedIds = [], calendars, plantHours, lineSettings = {} } = {}) {
  const snapshot = setupSnapshot(tasks, { firmedIds, lineSettings });
  if (calendars !== undefined) snapshot.calendars = calendars;
  if (plantHours !== undefined) snapshot.plants = { P1: { workHours: plantHours } };
  snapshot.masterData = {
    plants: [{ plant: 'P1', timezone: LOCAL_TZ, ...rules }],
    lines: [{ plant: 'P1', machine: 'L1' }],
  };
  return snapshot;
}

// ── Scenario specs ─────────────────────────────────────────────────────────
// A scenario is plain JSON (strings and numbers only) so the same spec can be
// built in the test process (direct evaluators, Engine.evaluateSchedule, the
// worker) and rebuilt inside a spawnSync child (live runAndApply).

export const DEFAULT_SETUP_ROWS = [
  ['GREEN', 'GREEN', 0], ['GREEN', 'BLUE', 5], ['BLUE', 'GREEN', 5], ['BLUE', 'BLUE', 0], ['RED', 'RED', 0],
];

/** Fill a scenario spec with the matrix defaults: Monday 2035-08-06 08:00 now,
 * a two-week horizon, 08:00-18:00 every day on the plant and the line, no
 * blackouts, current line state GREEN, and the DEFAULT_SETUP_ROWS matrix
 * (GREEN<->BLUE 5 minutes; anything touching RED across states is uncovered).
 * `lineHours: null` means "no line calendar row" (the line falls back to the
 * plant's hours); `tasks` entries are { id, run, color, due, start?, end? }. */
export function normalizeScenario(spec) {
  return {
    now: '2035-08-06T08:00:00',
    horizonEnd: '2035-08-20T18:00:00',
    current: 'GREEN',
    rows: DEFAULT_SETUP_ROWS,
    rules: {},
    lineHours: OPEN_HOURS,
    plantHours: OPEN_HOURS,
    blocks: [],
    firmed: [],
    ...spec,
  };
}

export function scenarioSetupTruth(spec) {
  const s = normalizeScenario(spec);
  return setupTruth({ current: s.current, rows: s.rows.map(([from, to, minutes]) => setupRow(from, to, minutes)) });
}

export function scenarioSnapshot(spec) {
  const s = normalizeScenario(spec);
  const tasks = s.tasks.map(t => scheduledTask(t.id, t.run, t.color, t.due, t.start ?? null, t.end ?? null));
  const snapshot = rulesSnapshot(tasks, s.rules, {
    firmedIds: s.firmed,
    plantHours: s.plantHours,
    calendars: s.lineHours === null ? {} : { L1: { workHours: s.lineHours } },
  });
  snapshot.blocks = s.blocks.map(([start, end], index) => ({ id: `blackout-${index}`, line: 'L1', start: at(start), end: at(end) }));
  snapshot.setupSnapshot = { ...scenarioSetupTruth(s), plant_active: true };
  snapshot.frozenHorizonEnd = null;
  applyToolVariant(snapshot, s.tool);
  return snapshot;
}

/** The sixth setting, the tooling rule column. `tool` is undefined (no inventory, rule absent: today's snapshot), 'off'
 * (inventory loaded, rule Off), 'hard' (rule Hard, inventory loaded with 3 copies of T1: a single machine can never
 * exceed them, so the pass must be transparent) or 'hard-unloaded' (rule Hard, inventory NOT loaded: unconstrained).
 * Every task carries T1 in PRT_01 in every variant. */
export function applyToolVariant(snapshot, tool) {
  if (!tool) return snapshot;
  for (const t of snapshot.tasks) t.PRT_01 = 'T1';
  const plant = snapshot.masterData.plants[0];
  plant.setup_policy_config = { ...(plant.setup_policy_config ?? {}), toolingRule: tool === 'off' ? 'off' : 'hard' };
  snapshot.masterData.tool_inventory = tool === 'hard-unloaded' ? undefined
    : [{ plant: 'P1', tool_id: 'T1', total_qty: 3, out_of_service_qty: 0, note: null }];
  return snapshot;
}

/** Bounds for the direct evaluators: deterministic clock, never-expiring
 * deadline, small exact-search threshold and iteration cap. */
export function scenarioBounds(spec) {
  const s = normalizeScenario(spec);
  return dueDateBounds(scenarioSetupTruth(s), {
    now: at(s.now), placementStart: at(s.now), horizonEnd: at(s.horizonEnd),
  });
}
