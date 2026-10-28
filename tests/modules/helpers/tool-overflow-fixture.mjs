// Shared fixtures for the Tool Inventory overflow pass (Wave 6): tests/modules/setup-scheduler.test.mjs ("tool overflow"
// block), tests/modules/optimization/tool-overflow-oracle.test.mjs, the Off/Hard matrix column, the worker round trip and
// the plant-scale test. One plant 'P1', any number of lines, every line open 24 h on every day (so the only
// constraints are the tool rule, the plant windows and the order data), 2035 dates in local time.

export const TOOL_NOW = '2035-08-06T08:00:00';
export const TOOL_HORIZON_END = '2035-08-13T08:00:00';
export const ALL_DAY = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [0, 24]]));
export const at = text => new Date(text);

function setupTruth(lines) {
  return {
    plant: 'P1',
    definition: { plant: 'P1', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
    plant_rows: [], machine_rows: [],
    machine_states: lines.map(machine => ({ machine, state_key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], signature_version: 1, source: 'manual', reason: 'tool test' })),
    overrides: [],
  };
}

/** A task spec: { id, line, run (hours), tools: ['T1', 'T2'] (PRT_01 / PRT_02), due?, start?, end?, plant?, color?, segments?: [[start,end],...] }. */
export function toolTask(spec) {
  const [prt1, prt2] = spec.tools ?? [];
  return {
    id: spec.id, PLANT: spec.plant ?? 'P1', plant: spec.plant ?? 'P1', MACHINE: spec.line, RUN_TIME: spec.run, COLOR: spec.color ?? 'GREEN',
    PRT_01: prt1 ?? null, PRT_02: prt2 ?? null,
    start_date: spec.start ? at(spec.start) : null, end_date: spec.end ? at(spec.end) : null,
    scheduleSegments: (spec.segments ?? []).map(([s, e], i) => ({ sequence: i + 1, startDate: at(s), endDate: at(e) })),
    original_start_date: null, BASIC_START_DATE: null, BASIC_FINISH_DATE: null,
    original_end_date: spec.due ? at(spec.due) : null,
    user_scheduled: spec.start ? (spec.userScheduled ?? true) : false,
    firmed: false, row_version: null,
  };
}

/** inventory: array of {tool_id, total_qty, out_of_service_qty} for P1 (plant added), or null = NOT LOADED (tool_inventory undefined). */
export function toolSnapshot(taskSpecs, { inventory = [], rule = 'hard', lines, firmedIds = [], lineSettings = {}, plantExtra = {}, hours = ALL_DAY, plantRows } = {}) {
  const lineNames = lines ?? [...new Set(taskSpecs.map(t => t.line))].sort();
  const tasks = taskSpecs.map(toolTask);
  const policy = rule === undefined ? {} : { toolingRule: rule };
  return {
    tasks, firmedIds, alerts: [], selectedPlant: 'P1', blocks: [], plantBlocks: [],
    calendars: Object.fromEntries(lineNames.map(l => [l, { workHours: hours }])),
    plants: { P1: { workHours: hours } },
    lineSettings,
    masterData: {
      plants: [{ plant: 'P1', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, setup_policy_config: policy, ...plantExtra }],
      lines: lineNames.map(machine => ({ plant: 'P1', machine })),
      workcenters: [],
      tool_inventory: inventory === null ? undefined : (plantRows ?? inventory).map(row => ({ plant: 'P1', note: null, out_of_service_qty: 0, ...row })),
    },
    priorityRankMaps: {},
    setupSnapshot: { ...setupTruth(lineNames), plant_active: true },
    frozenHorizonEnd: null,
  };
}

export function toolBounds(snapshot, overrides = {}) {
  return {
    setup: snapshot.setupSnapshot,
    exactSearchThreshold: 6, iterationCap: 200, clock: () => 0, deadline: 1,
    now: at(TOOL_NOW), placementStart: at(TOOL_NOW), horizonEnd: at(TOOL_HORIZON_END),
    ...overrides,
  };
}

export function toolRequest(overrides = {}) {
  return {
    mode: 'changeover', plant: 'P1', respectFirmed: true, respectCalendar: true,
    planningStart: at(TOOL_NOW), runNow: at(TOOL_NOW), endDate: at(TOOL_HORIZON_END),
    ...overrides,
  };
}

/** The final row of every order after applying the candidate's patches to the snapshot. */
export function finalRows(snapshot, candidate) {
  const byId = new Map(candidate.patches.map(p => [p.id, p.changes]));
  return snapshot.tasks.map(t => {
    const changes = byId.get(t.id);
    const merged = changes ? { ...t, ...changes } : t;
    const status = merged.planning_status === 'needs_planning' ? 'queued' : (merged.start_date && merged.end_date ? 'placed' : 'queued');
    const segs = merged.scheduleSegments ?? [];
    const pieces = segs.length ? segs.map(s => [+new Date(s.startDate), +new Date(s.endDate)]) : (merged.start_date ? [[+new Date(merged.start_date), +new Date(merged.end_date)]] : []);
    return {
      id: t.id, line: t.MACHINE, status, tools: [t.PRT_01, t.PRT_02].filter(Boolean),
      start: merged.start_date ? +new Date(merged.start_date) : null, end: merged.end_date ? +new Date(merged.end_date) : null,
      pieces, reason: merged.planning_reason ?? null, patched: !!changes,
    };
  });
}

/** Independent overflow check: for every tool and every instant, the number of DISTINCT machines whose order ENVELOPE
 * (first piece start .. last piece end) covers it must not exceed `available(tool)`. Rows of `ignore` (ids) are skipped.
 * Returns [{tool, at, machines}] for every violation. Intervals before `fromMs` are ignored. */
export function overflowOracle(rows, availableFor, { fromMs = +at(TOOL_NOW), skipIds = new Set() } = {}) {
  const byTool = new Map();
  for (const r of rows) {
    if (r.status !== 'placed' || skipIds.has(r.id)) continue;
    const s = Math.max(fromMs, Math.min(...r.pieces.map(p => p[0]))); const e = Math.max(...r.pieces.map(p => p[1]));
    if (e <= s) continue;
    for (const tool of r.tools) { if (!byTool.has(tool)) byTool.set(tool, []); byTool.get(tool).push({ s, e, line: r.line, id: r.id }); }
  }
  const out = [];
  for (const [tool, list] of byTool) {
    const starts = [...new Set(list.map(x => x.s))];
    for (const at0 of starts) {
      const lines = new Set(list.filter(x => x.s <= at0 && at0 < x.e).map(x => x.line));
      if (lines.size > availableFor(tool)) out.push({ tool, at: at0, machines: lines.size });
    }
  }
  return out;
}
