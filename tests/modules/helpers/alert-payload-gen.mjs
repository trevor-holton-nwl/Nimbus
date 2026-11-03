// Seeded random computeAlerts payloads: every alert rule fires somewhere across a few hundred seeds. Deterministic for a
// given (seed, nowMs). Shared by the alert i18n parity test and the compute-core rule tests.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const HOUR = 3600000;

export function genPayload(seed, nowMs) {
  const r = rng(seed);
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const lines = ['L1', 'L2', 'L3', 'L4', 'L5'];
  const plantOfLine = { L1: 'P1', L2: 'P1', L3: 'P2', L4: 'P2', L5: null };
  const masterData = {
    lines: lines.filter(l => plantOfLine[l]).map(l => ({ machine: l, plant: plantOfLine[l], sap_workcenter: l === 'L1' || l === 'L2' ? 'WC1' : (l === 'L3' ? 'WC2' : undefined) })),
    workcenters: [{ sap_workcenter: 'WC1', max_separation: pick(['hour', 'day', 'week', 'none']) }, { sap_workcenter: 'WC2', max_separation: 'day' }],
    plants: [{ plant: 'P1', setup_active: r() < 0.8, max_push_forward_days: r() < 0.5 ? ri(0, 5) : null }, { plant: 'P2', setup_active: true, max_push_forward_days: 2 }],
    tool_inventory: [{ plant: 'P1', tool_id: 'T1', total_qty: ri(0, 3), out_of_service_qty: 0 }, { plant: 'P2', tool_id: 't2', total_qty: 1, out_of_service_qty: 0 }],
  };
  const wh = () => { const o = {}; for (let d = 0; d < 7; d++) o[d] = r() < 0.2 ? null : [ri(0, 8) + (r() < 0.3 ? 0.5 : 0), ri(14, 24)]; return o; };
  const calendars = {};
  for (const l of lines) if (r() < 0.7) calendars[l] = { workHours: wh() };
  const plants = { P1: { workHours: wh(), periods: r() < 0.3 ? [{ id: 'a', validFrom: '2020-01-01', validTo: null, workHours: wh() }] : undefined }, P2: { workHours: wh() } };
  const lineSettings = {};
  for (const l of lines) if (r() < 0.4) lineSettings[l] = { plant: r() < 0.3 ? plantOfLine[l] || undefined : undefined, bufferUnit: pick(['pct', 'hours', 'none']), bufferPct: ri(0, 100), bufferHours: ri(0, 10) };
  const day0 = new Date(nowMs); day0.setHours(0, 0, 0, 0);
  const at = (days, h) => new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + days, 0, Math.round(h * 60));
  const blocks = [], plantBlocks = [];
  for (let i = 0; i < ri(0, 5); i++) {
    const d = ri(-2, 6), h = ri(0, 20);
    blocks.push({ line: r() < 0.7 ? pick(lines) : null, plant: r() < 0.5 ? pick(['P1', 'P2']) : undefined, start: at(d, h), end: at(d, h + ri(1, 30)), reason: r() < 0.5 ? 'maint' : undefined });
  }
  for (let i = 0; i < ri(0, 3); i++) {
    const d = ri(-2, 6), h = ri(0, 20);
    plantBlocks.push({ plant: r() < 0.7 ? pick(['P1', 'P2']) : null, start: at(d, h), end: at(d, h + ri(1, 30)), reason: r() < 0.5 ? 'holiday' : undefined });
  }
  const tasks = [];
  const nT = ri(3, 28);
  for (let i = 0; i < nT; i++) {
    const line = r() < 0.05 ? undefined : pick(lines);
    const run = ri(1, 30);
    const startH = ri(-60, 24 * 7 * 1), dur = run + ri(0, 6);
    const t = { id: 't' + i, MACHINE: line, RUN_TIME: run, ORDER: r() < 0.9 ? 'O' + i : '', PLANT: r() < 0.6 ? (plantOfLine[line] || undefined) : undefined };
    const shape = r();
    if (shape < 0.75) { t.start_date = new Date(nowMs + startH * HOUR); t.end_date = new Date(+t.start_date + dur * HOUR); }
    else if (shape < 0.85) { t.end_date = new Date(nowMs + startH * HOUR); t.start_date = null; }
    else if (shape < 0.92) { t.start_date = new Date(nowMs + startH * HOUR); t.end_date = null; }
    else { t.start_date = null; t.end_date = null; }
    if (r() < 0.15 && t.start_date && t.end_date) {
      const a = +t.start_date, b = +t.end_date, m = Math.floor((a + b) / 2);
      t.scheduleSegments = [{ startDate: new Date(a), endDate: new Date(m - HOUR / 2), sequence: 1 }, { startDate: new Date(m + HOUR / 2), endDate: new Date(b), sequence: 2 }];
    }
    if (r() < 0.35) t.PRT_01 = pick(['T1', 't2', ' t1 ', 'N/A', '']);
    if (r() < 0.2) t.PRT_02 = pick(['T1', 't2', '-']);
    if (r() < 0.2) { t.PARENT_ORDER = pick(['PA', 'PB']); t.MATERIAL_NUMBER = 'M1'; }
    if (r() < 0.2) t.firmed = true;
    if (r() < 0.1) t.planning_status = 'needs_planning';
    if (r() < 0.1) t.runtime_schedule_mismatch = true;
    if (r() < 0.1) t.original_end_date = new Date(nowMs + ri(-48, 100) * HOUR); else if (r() < 0.1) t.original_end_date = at(ri(-2, 5), 0);
    if (r() < 0.15) t.derivationIssue = { code: pick(['finish_moved_earlier', 'reversal_forward', 'no_anchor', 'no_operating_window', 'run_time_zero', 'setup_override_orphaned', 'pull_floor_crossed', 'frozen_window_crossed', 'plant_no_timezone', 'weird_code']), detail: pick(['run_time_grew', 'due_date_past', 'cutover', 'x']), from: new Date(nowMs), to: new Date(nowMs + 5 * HOUR) };
    if (r() < 0.1) t.placement_exception = pick(['overtime', 'overlong', 'bogus']);
    if (r() < 0.08) { t.planning_status = 'needs_planning'; t.planning_reason = { code: 'runtime_unknown', message: r() < 0.5 ? 'custom msg' : undefined, step: 'pv' }; }
    if (r() < 0.08) t.run_time_basis = { lot_size_warning: true };
    tasks.push(t);
  }
  const setup = { intervals: [], diagnostics: [] };
  for (let i = 0; i < ri(0, 4); i++) {
    const t = pick(tasks);
    setup.intervals.push({ line: pick(lines), start: new Date(nowMs + ri(0, 60) * HOUR), end: new Date(nowMs + ri(61, 90) * HOUR), requiredMinutes: ri(10, 200), availableMinutes: ri(0, 150), successorOrderId: t.id, predecessorOrderId: r() < 0.5 ? pick(tasks).id : undefined, pairKey: 'unknown->[["colorWheel","X"]]' });
  }
  const pairKeys = [undefined, 'unknown->[["colorWheel","X"]]', '[["colorWheel","A"],["prt01","B"]]->[["colorWheel","C"]]', 'garbage'];
  for (let i = 0; i < ri(0, 6); i++) {
    setup.diagnostics.push({ type: pick(['setup-uncovered', 'initial-state-unknown', 'current-state-diverged', 'override-inactive', 'predecessor-state-unknown', 'successor-state-unknown', 'bogus']), line: pick(lines), successorOrderId: pick(tasks).id, predecessorOrderId: pick(tasks).id, pairKey: pick(pairKeys), scope: r() < 0.5 ? 'S' : undefined, time: r() < 0.5 ? new Date(nowMs + ri(0, 90) * HOUR) : undefined, message: r() < 0.2 ? 'preset message' : undefined });
  }
  const opts = r() < 0.3 ? { lines: [pick(lines), pick(lines)] } : {};
  const now = r() < 0.5 ? { P1: new Date(nowMs + ri(-30, 30) * HOUR), P2: new Date(nowMs) } : undefined;
  const blockedPlants = r() < 0.2 ? ['P1'] : [];
  const dismissed = r() < 0.2 ? ['late-t1', 'ovl-t0-t1'] : [];
  return { tasks, blocks, plantBlocks, calendars, plants, lineSettings, masterData, dismissed, opts, setup: r() < 0.9 ? setup : undefined, now, blockedPlants };
}
