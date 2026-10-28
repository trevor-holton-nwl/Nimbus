// Tool Inventory Wave 6 validation fix: an independent adversarial instance generator for the tool overflow pass (written by the
// Opus validator, kept here for the deterministic regression + oracle tests). Zero-copy tools, a non-zero setup matrix, business
// calendars (non-working time), all three split policies, never-committed baseline bars, finish-only rows, protected / held /
// unselected / other-plant rows. Plain-JSON spec per seed + a snapshot / request builder.
// Produces a plain-JSON spec per seed and builds a ScheduleSnapshot + EvaluationRequest from it.
export const MIN = 60000, HOUR = 60 * MIN;
export const NOW_TXT = '2035-08-06T08:00:00'; // Monday
export const at = t => new Date(t);
export const NOW = +at(NOW_TXT);
export const local = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const ALL_DAY = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, [0, 24]]));
const BUSINESS = { 1: [6, 22], 2: [6, 22], 3: [6, 22], 4: [6, 22], 5: [6, 22] };
const COLORS = ['GREEN', 'BLUE', 'RED'];

export function makeSpec(seed, opts = {}) {
  const r = rng(seed);
  const pick = n => Math.floor(r() * n);
  const chance = p => r() < p;
  const tight = seed % 2 === 1;
  const nLines = 1 + pick(4);
  const lines = Array.from({ length: nLines }, (_, i) => `L${i + 1}`);
  const nTools = 1 + pick(3);
  const tools = Array.from({ length: nTools }, (_, i) => `T${i + 1}`);
  const inventory = [];
  for (const t of tools) {
    if (chance(0.2)) continue; // missing row = 1 copy
    const total = tight ? (chance(0.05) ? 0 : 1 + pick(2)) : [0, 1, 1, 1, 2, 2, 3][pick(7)];
    const oos = total > 0 && chance(0.2) ? 1 : 0;
    inventory.push({ tool_id: chance(0.1) ? ` ${t.toLowerCase()} ` : t, total_qty: total, out_of_service_qty: oos });
  }
  const business = chance(0.55);
  const horizonDays = tight ? (business ? 3 : 1 + pick(2)) : business ? 7 : (chance(0.5) ? 3 : 7);
  const horizonEnd = NOW + horizonDays * 24 * HOUR;
  const hasLX = chance(0.4);
  const hasLE = chance(0.25);
  const useLinesParam = hasLX ? true : chance(0.3);
  const rules = {};
  if (chance(tight ? 0.7 : 0.4)) rules.max_push_forward_days = pick(2);
  if (chance(0.2)) rules.max_pull_forward_days = 1;
  rules.split_order_policy = ['never', 'never', 'overlong_only', 'partial_allowed'][pick(4)];
  const policy = ['zero', 'zero', 'plantDefaultMinutes', 'excludeFromSearch'][pick(4)];
  const setupPolicy = { toolingRule: 'hard', unknownSetupPolicy: policy, ...(policy === 'plantDefaultMinutes' ? { unknownSetupDefaultMinutes: 15 } : {}) };
  const setupMin = chance(0.5) ? 0 : 5 + pick(26);
  const grid = chance(0.5) ? 2 * HOUR : 30 * MIN; // coarse grid => equal-start/end ties
  const toolsFor = () => {
    const k = pick(3); const out = [];
    for (let i = 0; i < k; i++) { const t = tools[pick(tools.length)]; out.push(chance(0.1) ? ` ${t.toLowerCase()}` : t); }
    if (out.length === 1 && chance(0.1)) out.push(out[0]); // PRT_01 == PRT_02
    return out;
  };
  const tasks = [];
  const dueAt = () => NOW + (4 + pick(Math.max(8, horizonDays * 24 - 4))) * HOUR;
  const startAt = (span = Math.max(4, horizonDays * 24 - 8)) => NOW + Math.floor(((1 + pick(span)) * HOUR) / grid) * grid;
  const runH = () => [0.5, 1, 1.5, 2, 3, 4, 6, 8][pick(8)];
  const nMut = tight ? 5 + pick(8) : 2 + pick(9);
  for (let i = 0; i < nMut; i++) {
    const run = runH();
    const t = { id: `O${i}`, line: lines[pick(nLines)], run, tools: toolsFor(), due: dueAt(), color: COLORS[pick(3)], kind: 'mutable' };
    if (chance(0.4)) { const s = startAt(); t.start = s; t.end = s + run * HOUR; t.userScheduled = chance(0.85); }
    tasks.push(t);
  }
  // distribution siblings: same parent + material + tool + due on two lines
  if (nLines >= 2 && chance(0.2)) {
    const due = dueAt(); const tool = tools[pick(tools.length)]; const run = runH();
    for (let k = 0; k < 2; k++) tasks.push({ id: `D${k}`, line: lines[k], run, tools: [tool], due, color: 'GREEN', parent: 'PAR1', material: 'MAT1', kind: 'mutable',
      ...(chance(0.5) ? { start: due - run * HOUR, end: due, userScheduled: true } : {}) });
  }
  const firmed = [];
  for (let i = 0, n = pick(3); i < n; i++) {
    const run = runH(); const s = startAt();
    const t = { id: `F${i}`, line: lines[pick(nLines)], run, tools: toolsFor(), due: s + run * HOUR + 24 * HOUR, color: COLORS[pick(3)], start: s, end: s + run * HOUR, userScheduled: true, kind: 'firmed' };
    // split firmed order across a gap (weekend on business calendars, or an arbitrary 10 h gap)
    if (chance(0.3)) { const gap = 10 * HOUR; t.segments = [[s, s + run * HOUR / 2], [s + run * HOUR / 2 + gap, s + run * HOUR + gap]]; t.end = s + run * HOUR + gap; }
    tasks.push(t); firmed.push(t.id);
  }
  if (chance(0.3)) { // running order
    const run = 4; const s = NOW - 2 * HOUR;
    tasks.push({ id: 'R0', line: lines[pick(nLines)], run, tools: toolsFor(), due: s + 30 * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: true, kind: 'running' });
  }
  let frozenHorizonEnd = null;
  if (chance(0.25)) { // frozen horizon 24 h; one order finishing inside it
    frozenHorizonEnd = NOW + 24 * HOUR;
    const run = 2; const s = NOW + Math.floor((4 + pick(14)) * HOUR / grid) * grid;
    tasks.push({ id: 'Z0', line: lines[pick(nLines)], run, tools: toolsFor(), due: s + 40 * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: true, kind: 'frozen' });
  }
  if (hasLX) for (let i = 0, n = 1 + pick(3); i < n; i++) {
    const run = runH(); const s = startAt();
    tasks.push({ id: `X${i}`, line: 'LX', run, tools: toolsFor(), due: s + run * HOUR + 24 * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: chance(0.6), kind: 'unselected' });
  }
  if (hasLE) for (let i = 0, n = 1 + pick(2); i < n; i++) {
    const run = runH(); const s = startAt();
    tasks.push({ id: `E${i}`, line: 'LE', run, tools: toolsFor(), due: s + run * HOUR + 24 * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: chance(0.6), kind: 'excluded' });
  }
  if (chance(0.25)) { // finish-only row (fresh distributed child): start null, end set
    const run = runH(); const e = startAt() + run * HOUR;
    tasks.push({ id: 'Y0', line: [...lines, ...(hasLX ? ['LX'] : [])][pick(nLines + (hasLX ? 1 : 0))], run, tools: [tools[pick(tools.length)]], due: e, color: 'GREEN', end: e, userScheduled: false, kind: 'finishOnly' });
  }
  if (chance(0.25)) { // never-committed SAP baseline bar out of window (after horizon end) on a selected line
    const run = runH(); const s = horizonEnd + pick(10) * HOUR;
    tasks.push({ id: 'B0', line: lines[pick(nLines)], run, tools: [tools[pick(tools.length)]], due: s + run * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: false, kind: 'baselineOut' });
  }
  if (chance(0.25)) { // window-end crosser (user scheduled)
    const run = 6; const s = horizonEnd - 2 * HOUR;
    tasks.push({ id: 'W0', line: lines[pick(nLines)], run, tools: [tools[pick(tools.length)]], due: s + 30 * HOUR, color: 'GREEN', start: s, end: s + run * HOUR, userScheduled: true, kind: 'crosser' });
  }
  if (chance(0.3)) { // other plant sharing tool ids, overlapping everything
    for (let i = 0; i < 3; i++) tasks.push({ id: `Q${i}`, line: `Q${i}`, plant: 'P2', run: 40, tools: [...tools], due: NOW + 60 * HOUR, color: 'GREEN', start: NOW, end: NOW + 40 * HOUR, userScheduled: true, kind: 'otherPlant' });
  }
  const mode = ['spt', 'changeover', 'duedate'][pick(3)];
  const respectFirmed = chance(0.85);
  return { seed, lines, tools, inventory, business, horizonEnd, hasLX, hasLE, useLinesParam, rules, setupPolicy, setupMin, tasks, firmed, frozenHorizonEnd, mode, respectFirmed, ...opts };
}

/** Build a ScheduleSnapshot from a spec. `variant`: 'hard' | 'off' | 'absent' (no rule, no inventory) | 'unloaded' (hard, inventory undefined). */
export function buildSnapshot(spec, { variant = 'hard', inventory = spec.inventory, taskOrder = null } = {}) {
  const hours = spec.business ? BUSINESS : ALL_DAY;
  const allLines = [...spec.lines, ...(spec.hasLX ? ['LX'] : []), ...(spec.hasLE ? ['LE'] : [])];
  const p2Lines = [...new Set(spec.tasks.filter(t => t.plant === 'P2').map(t => t.line))];
  let tasks = spec.tasks.map(t => ({
    id: t.id, PLANT: t.plant ?? 'P1', plant: t.plant ?? 'P1', MACHINE: t.line, RUN_TIME: t.run, COLOR: t.color,
    PRT_01: t.tools[0] ?? null, PRT_02: t.tools[1] ?? null,
    start_date: t.start != null ? new Date(t.start) : null, end_date: t.end != null ? new Date(t.end) : null,
    scheduleSegments: (t.segments ?? []).map(([s, e], i) => ({ sequence: i + 1, startDate: new Date(s), endDate: new Date(e) })),
    original_start_date: null, BASIC_START_DATE: null, BASIC_FINISH_DATE: null,
    original_end_date: new Date(t.due), user_scheduled: t.userScheduled ?? false, firmed: false, row_version: null,
    ...(t.parent ? { PARENT_ORDER: t.parent, MATERIAL_NUMBER: t.material } : {}),
  }));
  if (taskOrder) tasks = taskOrder(tasks);
  const policy = variant === 'absent' ? { unknownSetupPolicy: spec.setupPolicy.unknownSetupPolicy, ...(spec.setupPolicy.unknownSetupDefaultMinutes != null ? { unknownSetupDefaultMinutes: 15 } : {}) }
    : { ...spec.setupPolicy, toolingRule: variant === 'off' ? 'off' : 'hard' };
  const rows = [];
  for (const a of ['GREEN', 'BLUE']) for (const b of ['GREEN', 'BLUE']) rows.push({ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: a }], to_key: [{ fieldKey: 'colorWheel', value: b }], setup_min: a === b ? 0 : spec.setupMin });
  rows.push({ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'RED' }], setup_min: 0 });
  const md = {
    plants: [{ plant: 'P1', timezone: TZ, setup_active: true, setup_policy_config: policy, ...spec.rules }, { plant: 'P2', timezone: TZ }],
    lines: [...allLines.map(machine => ({ plant: 'P1', machine })), ...p2Lines.map(machine => ({ plant: 'P2', machine }))],
    workcenters: [],
  };
  if (variant === 'hard' || variant === 'off') md.tool_inventory = inventory.map(row => ({ plant: 'P1', note: null, out_of_service_qty: 0, ...row }));
  if (variant === 'unloaded') md.tool_inventory = undefined;
  return {
    tasks, firmedIds: [...spec.firmed], alerts: [], selectedPlant: 'P1', blocks: [], plantBlocks: [],
    calendars: Object.fromEntries([...allLines, ...p2Lines].map(l => [l, { workHours: hours }])),
    plants: { P1: { workHours: hours }, P2: { workHours: hours } },
    lineSettings: spec.hasLE ? { LE: { excludeFromOpt: true } } : {},
    masterData: md, priorityRankMaps: {},
    setupSnapshot: {
      plant: 'P1', plant_active: true,
      definition: { plant: 'P1', fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: rows, machine_rows: [],
      machine_states: allLines.map(machine => ({ machine, state_key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], signature_version: 1, source: 'manual', reason: 'opus' })),
      overrides: [],
    },
    frozenHorizonEnd: spec.frozenHorizonEnd != null ? new Date(spec.frozenHorizonEnd) : null,
  };
}

export function buildRequest(spec, extra = {}) {
  return {
    mode: spec.mode, plant: 'P1', respectFirmed: spec.respectFirmed, respectCalendar: true,
    planningStart: new Date(NOW), runNow: new Date(NOW), endDate: new Date(spec.horizonEnd),
    ...(spec.useLinesParam ? { lines: [...spec.lines] } : {}),
    ...extra,
  };
}

export const normTool = v => { if (v == null) return null; const s = String(v).trim().toUpperCase(); return ['', '-', '0', 'N/A', 'NONE', 'NULL', 'NAN', 'TBD'].includes(s) ? null : s; };
export function availOf(spec, inventory = spec.inventory) {
  const m = new Map();
  for (const row of inventory) m.set(normTool(row.tool_id), Math.max(0, (row.total_qty ?? 1) - (row.out_of_service_qty ?? 0)));
  return tool => (m.has(tool) ? m.get(tool) : 1);
}
