/* =============================================================================
   ALERT LEVERAGE — "fix X and these N alerts go away", computed from the alerts
   that exist now (design 2026-10-20, section C). Pure: no Store, no DOM, no fetch.
   Everything arrives through `LeverageInput`; the batch runner (worker or main
   thread) is a parameter of `analyzeLeverage`.

   Two phases on purpose:
   - `groupLeverage` is synchronous and cheap. Every item carries uncapped impact
     points and a REMOVAL delta (the confidence formula with that item's alerts
     taken out), so cards paint at once.
   - `analyzeLeverage` upgrades setup-pair items to a REPLAY: it adds the missing
     matrix row, re-derives the setup observation, recomputes alerts + utilization
     through the runner and scores the real result (D9: reported even when lower,
     because a new setup time can create overload / setup-violated alerts).

   Import hygiene: services.mts imports the optimization engine, which imports a
   loop back into this domain (see frontend/optimization/CLAUDE.md). This module
   therefore imports nothing from services.mts at runtime (type-only) and loads
   `deriveSetupObservation` lazily inside analyzeLeverage.

   Performance: one pass over the alert list builds every family's buckets, setup
   diagnostics are indexed by pairKey once, matrix lookups are keyed by line+day,
   so there is no alerts x tasks loop. Removal scoring is O(1) per item (see _scoreWithout).
   ========================================================================== */

import type { NimbusTask, SetupSnapshot, SetupStateKey, NimbusMasterPlant } from '../platform/types.mjs';
import type { buildPlantSnapshot, LeverageBase, LeverageVariant, LeverageResult } from './services.mjs';
import { impactPoints, alertOrderIds } from './alert-profiles.mjs';

// ---- Contract -----------------------------------------------------------------------------------

export type LeverageFamily = 'setup-pair' | 'calendar-day' | 'routing-gap' | 'tool' | 'machine-state' | 'optimize-window' | 'needs-planning';

export interface LeveragePair {
  line: string;
  predecessorOrderId?: string;
  successorOrderId?: string;
  fromState: SetupStateKey;
  toState: SetupStateKey;
  reason: 'setup-uncovered';
}

export type LeverageAction =
  | { kind: 'open-setup-matrix'; plant: string; pairs: LeveragePair[] }
  | { kind: 'calendar-day'; line: string; dayKey: string; fixableAlertIds: string[] }
  | { kind: 'routing-gap'; step: string; material: string; pv: string; machine: string }
  | { kind: 'tool'; tool: string; alertIds: string[] }
  | { kind: 'machine-state'; line: string }
  | { kind: 'optimize-window'; line: string; startDate: string; endDate: string }
  | { kind: 'needs-planning'; alertIds: string[] };

export interface LeverageItem {
  family: LeverageFamily;
  key: string;
  titleKey: string;
  titleVars: Record<string, string | number>;
  alertIds: string[];
  orderIds: string[];
  lines: string[];
  /** Uncapped impact points of the alerts cleared (the headline metric and the sort key, D12). */
  points: number;
  confidenceBefore: number;
  /** Score after the fix; null for optimize-window and needs-planning (no prediction, D16). */
  confidenceAfter: number | null;
  method: 'replay' | 'removal' | 'none';
  /** Alerts in this item that carry 0 points because they sit outside the confidence window. */
  outsideConfidenceWindowCount: number;
  requiresMinutes?: boolean;
  assumedMinutes?: number | null;
  minutesSource?: 'plantDefault' | 'user' | null;
  capped?: boolean;
  adminOnly?: boolean;
  /** optimize-window only: sum of (effective capacity - scheduled) hours over the window; <= 0 means optimizing cannot help. */
  headroomHours?: number;
  /** needs-planning only: the run-time hours of the queued orders still needing a slot (one decimal). */
  unplacedHours?: number;
  action: LeverageAction;
}

export interface LeverageInput {
  plant: string;
  plantNow: Date;
  horizonMinutes: number;
  /** The plant-wide alert list the cards are built from (dismissed already excluded), never the profile-filtered one (D10). */
  alerts: readonly NimbusAlert[];
  /** The pre-dismiss list the score is computed over (`Alerts.scoringAlerts()`, plant lines, with the queued-order
   *  alerts). Dismissed alerts keep counting toward the score, so "before" equals the badge. Default: `alerts`. */
  scoringAlerts?: readonly NimbusAlert[];
  /** Machines of the plant being scored (the badge's count; default 5, the core's default). */
  machines?: number;
  /** Live Store tasks keyed by id (the snapshot's tasks drop PRODUCTION_VERSION). */
  tasksById: Record<string, NimbusTask>;
  /** The selected plant's live tasks (`Store.tasksByPlant(plant)`), the rows the replay's setup derivation reads.
   *  Optional: absent, the replay falls back to every task in `tasksById`. */
  setupTasks?: readonly NimbusTask[];
  lines: ReadonlySet<string>;
  setupSnapshot: SetupSnapshot | null;
  masterPlant: NimbusMasterPlant | null;
  /** buildPlantSnapshot(plant); `setup.diagnostics` is the baseline observation the setup groups are read from. */
  snapshotBase: ReturnType<typeof buildPlantSnapshot>;
  /** Utilization matrix over [startOfDay(plantNow), +ceil(horizonMinutes/1440) days); rows are {scheduled, effectiveCapacity} in hours. */
  baselineMatrix: NimbusUtilizationMatrix;
  /** Max setup-pair replays per analysis (default 20). */
  replayCap?: number;
}

export type LeverageRunner = (base: LeverageBase, variants: LeverageVariant[], opts?: { signal?: AbortSignal }) => Promise<LeverageResult[]>;

export const DEFAULT_REPLAY_CAP = 20;
const MAX_WINDOW_DAYS = 14;
const MAX_ACTION_PAIRS = 12;
const DAY_MS = 86400000;

const OPTIMIZE_TYPES = new Set(['overlap', 'late', 'overload', 'setup-violated']);
const CALENDAR_TYPES = new Set(['closed', 'blackout', 'firmed-closed']);
const MACHINE_STATE_TYPES = new Set(['initial-state-unknown', 'current-state-diverged']);
const ROUTING_UPLOAD_STEPS = new Set(['no_routing', 'pv_not_found', 'pv_expired', 'no_operation_at_workcenter', 'pv_workcenter_mismatch']);

const SETUP_FIELD_LABELS: Record<string, string> = { colorWheel: 'Color', prt01: 'PRT01', prt02: 'PRT02', productionVersion: 'Production Version' };

const _core = () => globalThis.NimbusComputeCore!;

// ---- Pair keys ----------------------------------------------------------------------------------

function _toState(raw: unknown): SetupStateKey | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ fieldKey: string; value: string }> = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return null;
    out.push({ fieldKey: entry[0], value: entry[1] });
  }
  return out;
}

/** Splits a setup pairKey (`<from-json>-><to-json>`) into its two states; null when either half is `unknown` or malformed. */
export function parsePairKey(pairKey: string): { from: SetupStateKey; to: SetupStateKey } | null {
  // A value may itself contain ']->', so try every occurrence until both halves parse as states.
  let split = pairKey.indexOf(']->');
  while (split >= 0) {
    try {
      const from = _toState(JSON.parse(pairKey.slice(0, split + 1)));
      const to = _toState(JSON.parse(pairKey.slice(split + 3)));
      if (from && to) return { from, to };
    } catch { /* not the boundary; try the next occurrence */ }
    split = pairKey.indexOf(']->', split + 1);
  }
  return null;
}

function formatState(state: SetupStateKey): string {
  return state.map(({ fieldKey, value }) => `${SETUP_FIELD_LABELS[fieldKey] || fieldKey} ${value}`).join(', ');
}

/** The snapshot plus one plant-default row for the pair. Shallow on purpose: the matrix is O(states^2) and
 *  deriveSetupObservation only reads it, so a structuredClone per pair would be wasted work. */
export function hypotheticalSetupSnapshot(
  snapshot: SetupSnapshot, pair: { from: SetupStateKey; to: SetupStateKey }, minutes: number,
): SetupSnapshot {
  return {
    ...snapshot,
    plant_rows: [...snapshot.plant_rows, {
      machine: '', signature_version: snapshot.definition!.signature_version,
      from_key: pair.from, to_key: pair.to, setup_min: minutes,
    }],
  };
}

// ---- Shared scoring context ---------------------------------------------------------------------

interface Ctx {
  input: LeverageInput;
  pointsById: Map<string, number>;
  before: number;
  /** Unrounded sum of the points of every scored alert (the core's rawAlertPoints). */
  rawAll: number;
  machines: number | undefined;
}

function _buildCtx(input: LeverageInput): Ctx {
  const core = _core();
  const pointsById = new Map<string, number>();
  for (const a of input.alerts) pointsById.set(a.id, impactPoints(a, input.plantNow, input.horizonMinutes));
  const full = core.scoreConfidence({
    alerts: (input.scoringAlerts ?? input.alerts) as NimbusAlert[],
    horizonStart: input.plantNow, horizonMinutes: input.horizonMinutes, machines: input.machines,
  });
  return { input, pointsById, before: full.score, rawAll: full.rawAlertPoints, machines: input.machines };
}

/** The confidence score with `removedPoints` of alert points taken out: the core's curve over the reduced raw total
 *  (`confidenceFromRaw`, the same function scoreConfidence uses), O(1) per item instead of re-scoring the whole alert
 *  list. Points are base x {1, 1.25, 1.5}, i.e. exact binary quarters, so subtracting is as exact as re-summing
 *  (tests pin equality with scoreConfidence on the reduced set). */
function _scoreWithout(ctx: Ctx, removedPoints: number): number {
  return _core().confidenceFromRaw(Math.max(0, ctx.rawAll - removedPoints), ctx.machines);
}

// ---- Buckets ------------------------------------------------------------------------------------

interface Bucket {
  alerts: NimbusAlert[];
  orders: Set<string>;
  lines: Set<string>;
}
const _bucket = (): Bucket => ({ alerts: [], orders: new Set(), lines: new Set() });
function _push(b: Bucket, alert: NimbusAlert, orderIds: Iterable<string | undefined | null>): void {
  b.alerts.push(alert);
  if (alert.line) b.lines.add(alert.line);
  for (const id of orderIds) if (id != null && id !== '') b.orders.add(String(id));
}
function _bucketFor<K>(map: Map<K, Bucket>, key: K): Bucket {
  let b = map.get(key);
  if (!b) map.set(key, b = _bucket());
  return b;
}
const _alertOrders = (a: NimbusAlert): string[] => alertOrderIds(a);

function _finish(
  ctx: Ctx, family: LeverageFamily, key: string, titleKey: string, titleVars: Record<string, string | number>,
  b: Bucket, action: LeverageAction, extra: Partial<LeverageItem> = {},
): LeverageItem {
  let points = 0;
  let outside = 0;
  for (const a of b.alerts) {
    const p = ctx.pointsById.get(a.id) ?? 0;
    points += p;
    if (p === 0) outside++;
  }
  const noScore = family === 'optimize-window' || family === 'needs-planning';
  return {
    family, key, titleKey, titleVars,
    alertIds: b.alerts.map(a => a.id), orderIds: [...b.orders], lines: [...b.lines],
    points,
    confidenceBefore: ctx.before,
    confidenceAfter: noScore ? null : _scoreWithout(ctx, points),
    method: noScore ? 'none' : 'removal',
    outsideConfidenceWindowCount: outside,
    ...extra,
    action,
  };
}

/** Order ids on one line+day from the baseline matrix row (ids or resolved task objects). */
function _rowOrders(matrix: NimbusUtilizationMatrix, line: string, day: string): string[] {
  const tasks = (matrix?.[line]?.[day] as { tasks?: unknown[] } | undefined)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: string[] = [];
  for (const t of tasks) {
    const id = typeof t === 'string' ? t : (t as { id?: string } | null)?.id;
    if (id != null) out.push(String(id));
  }
  return out;
}

// ---- Families -----------------------------------------------------------------------------------

function _setupPairItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const { input } = ctx;
  const byPair = new Map<string, Bucket>();
  for (const a of alerts) {
    if (a.type !== 'setup-uncovered' || !a.pairKey || !parsePairKey(a.pairKey)) continue;
    _push(_bucketFor(byPair, a.pairKey), a, [a.taskId]);
  }
  if (!byPair.size) return [];

  const diagsByPair = new Map<string, Array<{ line: string; predecessorOrderId?: string | null; successorOrderId?: string }>>();
  for (const d of (input.snapshotBase?.setup?.diagnostics ?? []) as Array<{ type: string; line: string; pairKey?: string; predecessorOrderId?: string | null; successorOrderId?: string }>) {
    if (d.type !== 'setup-uncovered' || !d.pairKey || !byPair.has(d.pairKey)) continue;
    let list = diagsByPair.get(d.pairKey);
    if (!list) diagsByPair.set(d.pairKey, list = []);
    list.push(d);
  }

  const cfg = input.masterPlant?.setup_policy_config;
  const rawDef = Number(cfg?.unknownSetupDefaultMinutes);
  const usePlantDefault = cfg?.unknownSetupPolicy === 'plantDefaultMinutes' && Number.isFinite(rawDef) && rawDef > 0;
  // Matrix rows only match integer minutes (setup-domain validMinutes); round up so setup time is never under-charged.
  const defMin = Math.ceil(rawDef);

  const items: LeverageItem[] = [];
  for (const [pairKey, b] of byPair) {
    const parsed = parsePairKey(pairKey)!;
    const alertLines = new Set(b.alerts.map(a => a.line));
    const pairs: LeveragePair[] = [];
    for (const d of diagsByPair.get(pairKey) ?? []) {
      if (!alertLines.has(d.line)) continue;
      if (d.successorOrderId != null) b.orders.add(String(d.successorOrderId));
      b.lines.add(d.line);
      if (pairs.length < MAX_ACTION_PAIRS) {
        const pair: LeveragePair = { line: d.line, fromState: parsed.from, toState: parsed.to, reason: 'setup-uncovered' };
        if (d.predecessorOrderId != null) pair.predecessorOrderId = String(d.predecessorOrderId);
        if (d.successorOrderId != null) pair.successorOrderId = String(d.successorOrderId);
        pairs.push(pair);
      }
    }
    if (!pairs.length) {
      // No baseline diagnostics (e.g. synthetic input): fall back to what the alerts themselves say.
      for (const a of b.alerts) {
        if (pairs.length >= MAX_ACTION_PAIRS) break;
        const pair: LeveragePair = { line: a.line, fromState: parsed.from, toState: parsed.to, reason: 'setup-uncovered' };
        if (a.taskId) pair.successorOrderId = a.taskId;
        pairs.push(pair);
      }
    }
    const extra: Partial<LeverageItem> = usePlantDefault
      ? { assumedMinutes: defMin, minutesSource: 'plantDefault' }
      : { requiresMinutes: true, assumedMinutes: null, minutesSource: null };
    items.push(_finish(ctx, 'setup-pair', `setup-pair:${pairKey}`, 'leverage.title.setup-pair',
      { from: formatState(parsed.from), to: formatState(parsed.to), lines: b.lines.size, orders: b.orders.size },
      b, { kind: 'open-setup-matrix', plant: input.plant, pairs }, extra));
  }
  return items;
}

function _calendarItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const core = _core();
  const groups = new Map<string, { line: string; day: string; b: Bucket; fixable: string[] }>();
  for (const a of alerts) {
    if (!CALENDAR_TYPES.has(a.type)) continue;
    const day = core.dayKey(a.time);
    if (!day) continue;
    const key = `${a.line}|${day}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { line: a.line, day, b: _bucket(), fixable: [] });
    _push(g.b, a, a.type === 'closed' ? _rowOrders(ctx.input.baselineMatrix, a.line, day) : _alertOrders(a));
    if (a.type === 'blackout') g.fixable.push(a.id);
  }
  return [...groups].map(([key, g]) => _finish(ctx, 'calendar-day', `calendar-day:${key}`, 'leverage.title.calendar-day',
    { n: g.b.alerts.length, line: g.line, day: g.day },
    g.b, { kind: 'calendar-day', line: g.line, dayKey: g.day, fixableAlertIds: g.fixable }));
}

interface RouteKey { step: string; material: string; pv: string; machine: string; key: string; titleKey: string }

function _routeKey(step: string | null | undefined, task: NimbusTask | undefined, alertLine: string): RouteKey {
  const material = String(task?.MATERIAL_NUMBER ?? '');
  const pv = String(task?.PRODUCTION_VERSION ?? '');
  const machine = String(task?.MACHINE ?? alertLine ?? '');
  const t = (suffix: string) => `leverage.title.routing-gap.${suffix}`;
  if (step === 'workcenter_unmapped') return { step, material: '', pv: '', machine, key: `workcenter_unmapped|${machine}`, titleKey: t('workcenter_unmapped') };
  if (step === 'pv_missing') return { step, material, pv: '', machine: '', key: `pv_missing|${material}`, titleKey: t('pv_missing') };
  if (step && ROUTING_UPLOAD_STEPS.has(step)) return { step, material, pv, machine: '', key: `${step}|${material}|${pv}`, titleKey: t('routing_upload') };
  if (step === 'no_machine') return { step, material: '', pv: '', machine: '', key: 'no_machine', titleKey: t('no_machine') };
  return { step: 'unknown', material, pv: '', machine: '', key: `unknown|${material}`, titleKey: t('unknown') };
}

function _routingItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const groups = new Map<string, { rk: RouteKey; b: Bucket }>();
  for (const a of alerts) {
    if (a.type !== 'runtime-unknown' || !a.taskId) continue;
    const task = ctx.input.tasksById[a.taskId];
    const rk = _routeKey(task?.planning_reason?.step, task, a.line);
    let g = groups.get(rk.key);
    if (!g) groups.set(rk.key, g = { rk, b: _bucket() });
    _push(g.b, a, [a.taskId]);
  }
  return [...groups.values()].map(({ rk, b }) => _finish(ctx, 'routing-gap', `routing-gap:${rk.key}`, rk.titleKey,
    { n: b.orders.size, step: rk.step, material: rk.material, pv: rk.pv, machine: rk.machine },
    b, { kind: 'routing-gap', step: rk.step, material: rk.material, pv: rk.pv, machine: rk.machine },
    // Work Centers writes (PUT /distribution/{plant}/workcenters/{wc}) are require_admin, as are Manage Data and
    // routing uploads. Only `no_machine` is a planner fix (set the order's machine).
    { adminOnly: rk.step !== 'no_machine' }));
}

function _toolItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const byTool = new Map<string, Bucket>();
  for (const a of alerts) {
    if (a.type !== 'tool-conflict') continue;
    const tool = a.tool ?? a.msgVars?.tool;
    if (tool == null || tool === '') continue;
    const b = _bucketFor(byTool, String(tool));
    _push(b, a, _alertOrders(a));
    // Lines come from every order the conflict touches (pusher + all holders), not a fixed lineA/lineB pair.
    for (const id of _alertOrders(a)) { const l = ctx.input.tasksById[id]?.MACHINE; if (l) b.lines.add(l); }
  }
  return [...byTool].map(([tool, b]) => _finish(ctx, 'tool', `tool:${tool}`, 'leverage.title.tool',
    { n: b.orders.size, tool }, b, { kind: 'tool', tool, alertIds: b.alerts.map(a => a.id) }));
}

function _machineStateItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const byLine = new Map<string, Bucket>();
  for (const a of alerts) {
    if (!MACHINE_STATE_TYPES.has(a.type)) continue;
    _push(_bucketFor(byLine, a.line), a, [a.taskId]);
  }
  return [...byLine].map(([line, b]) => _finish(ctx, 'machine-state', `machine-state:${line}`, 'leverage.title.machine-state',
    { n: b.alerts.length, line }, b, { kind: 'machine-state', line }));
}

const _dayNum = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const _dayKeyOfNum = (n: number): string => {
  const d = new Date(n * DAY_MS);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

function _optimizeItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const core = _core();
  const matrix = ctx.input.baselineMatrix;
  const perLine = new Map<string, Map<number, NimbusAlert[]>>();
  for (const a of alerts) {
    if (!OPTIMIZE_TYPES.has(a.type)) continue;
    const day = core.dayKey(a.time);
    if (!day) continue;
    let days = perLine.get(a.line);
    if (!days) perLine.set(a.line, days = new Map());
    const n = _dayNum(day);
    const list = days.get(n);
    if (list) list.push(a); else days.set(n, [a]);
  }
  const items: LeverageItem[] = [];
  for (const [line, days] of perLine) {
    const sorted = [...days.keys()].sort((x, y) => x - y);
    let start = sorted[0];
    let prev = start;
    let members: number[] = [];
    const flush = () => {
      if (!members.length) return;
      const from = _dayKeyOfNum(start);
      const to = _dayKeyOfNum(prev);
      const b = _bucket();
      for (const n of members) for (const a of days.get(n)!) {
        _push(b, a, a.type === 'overload' ? [...(a.taskId ? [a.taskId] : []), ..._rowOrders(matrix, line, _dayKeyOfNum(n))] : _alertOrders(a));
      }
      let headroom = 0;
      for (let n = start; n <= prev; n++) {
        const row = matrix?.[line]?.[_dayKeyOfNum(n)];
        if (row) headroom += (Number(row.effectiveCapacity) || 0) - (Number(row.scheduled) || 0);
      }
      items.push(_finish(ctx, 'optimize-window', `optimize-window:${line}|${from}|${to}`, 'leverage.title.optimize-window',
        { line, from, to, n: b.alerts.length }, b,
        { kind: 'optimize-window', line, startDate: from, endDate: to }, { headroomHours: headroom }));
      members = [];
    };
    for (const n of sorted) {
      const contiguous = n - prev <= 1;
      const fits = n - start + 1 <= MAX_WINDOW_DAYS;
      if (members.length && !(contiguous && fits)) { flush(); start = n; }
      members.push(n);
      prev = n;
    }
    flush();
  }
  return items;
}

/** One plant-wide bucket over every `needs_planning` alert (a queued order with no slot). No confidence delta
 *  (`method: 'none'`: slotting adds load, so a removal delta would over-promise). An overdue alert counts as due now:
 *  the alert carries `due`, which the core scores (past due = horizon start). The hours are a 2-line local mirror of `Util.runHours` (this module imports nothing from foundation by design). */
function _needsPlanningItems(ctx: Ctx, alerts: NimbusAlert[]): LeverageItem[] {
  const { input } = ctx;
  const b = _bucket();
  for (const a of alerts) if (a.type === 'needs_planning') _push(b, a, _alertOrders(a));
  if (!b.alerts.length) return [];

  let points = 0;
  let outside = 0;
  for (const a of b.alerts) {
    const p = ctx.pointsById.get(a.id) ?? 0;
    points += p;
    if (p === 0) outside++;
  }

  let hours = 0;
  for (const id of b.orders) hours += Math.max(0, parseFloat(String(input.tasksById[id]?.RUN_TIME)) || 0);
  hours = Math.round(hours * 10) / 10;

  const alertIds = b.alerts.map(a => a.id);
  return [_finish(ctx, 'needs-planning', 'needs-planning', 'leverage.title.needs-planning', { n: alertIds.length, h: hours }, b,
    { kind: 'needs-planning', alertIds }, { points, outsideConfidenceWindowCount: outside, unplacedHours: hours })];
}

// ---- Public: grouping ---------------------------------------------------------------------------

function _sortItems(items: LeverageItem[]): LeverageItem[] {
  return items.sort((a, b) =>
    b.points - a.points || b.orderIds.length - a.orderIds.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Synchronous, bounded grouping of the plant-wide alerts into leverage items (removal deltas), best first. */
export function groupLeverage(input: LeverageInput): LeverageItem[] {
  const ctx = _buildCtx(input);
  const alerts = input.alerts as NimbusAlert[];
  return _sortItems([
    ..._setupPairItems(ctx, alerts),
    ..._calendarItems(ctx, alerts),
    ..._routingItems(ctx, alerts),
    ..._toolItems(ctx, alerts),
    ..._machineStateItems(ctx, alerts),
    ..._optimizeItems(ctx, alerts),
    ..._needsPlanningItems(ctx, alerts),
  ]);
}

// ---- Public: setup-pair replay ------------------------------------------------------------------

function _replayBase(input: LeverageInput): LeverageBase {
  const start = new Date(input.plantNow.getFullYear(), input.plantNow.getMonth(), input.plantNow.getDate());
  const snap = input.snapshotBase;
  return {
    // Never filtered by dismissals: the score counts dismissed alerts, so the replay's "after" must too.
    ...snap, dismissed: [], opts: { lines: null },
    startMs: start.getTime(), days: Math.max(1, Math.ceil(input.horizonMinutes / 1440)), lines: snap.lines ?? undefined,
  } as LeverageBase;
}

async function _variantFor(input: LeverageInput, item: LeverageItem, minutes: number): Promise<LeverageVariant | null> {
  const ss = input.setupSnapshot;
  const pair = parsePairKey(item.key.slice('setup-pair:'.length));
  if (!ss?.definition || !pair) return null;
  // Lazy: services.mts <-> engine.mts is an import loop (frontend/optimization/CLAUDE.md).
  const { deriveSetupObservation } = await import('../optimization/engine.mjs');
  const snap = input.snapshotBase;
  const setup = deriveSetupObservation(
    // The plant's own rows when the caller supplies them (deriveSetupObservation keeps only this plant's rows anyway).
    hypotheticalSetupSnapshot(ss, pair, minutes), input.setupTasks ?? Object.values(input.tasksById), input.lines,
    {
      calendars: snap.calendars, plants: snap.plants, lineSettings: snap.lineSettings, masterData: snap.masterData,
      blocks: snap.blocks, plantBlocks: snap.plantBlocks,
    } as Parameters<typeof deriveSetupObservation>[3],
  );
  return { key: item.key, setup: setup as LeverageVariant['setup'] };
}

function _applyReplay(input: LeverageInput, item: LeverageItem, result: LeverageResult): void {
  // The replayed core run has no queued-order alerts (the frontend Alerts layer adds those), but the "before" score
  // counts them: carry them over so before and after compare like with like.
  const queued = (input.scoringAlerts ?? input.alerts).filter(a => a.type === 'needs_planning' || a.type === 'queued_now_fits');
  item.confidenceAfter = _core().scoreConfidence({
    alerts: [...result.alerts, ...queued], horizonStart: input.plantNow, horizonMinutes: input.horizonMinutes,
    machines: input.machines,
  }).score;
  item.method = 'replay';
}

const _replayable = (item: LeverageItem): boolean =>
  item.family === 'setup-pair' && !item.requiresMinutes && (item.assumedMinutes ?? 0) > 0;

/** `groupLeverage` plus a replay of each setup-pair that has minutes (plant default). One runner batch, capped at
 *  `replayCap` pairs by alert count then orders; the rest keep their removal delta and are flagged `capped`. */
export async function analyzeLeverage(
  input: LeverageInput, runner: LeverageRunner, groups?: readonly LeverageItem[], opts?: { signal?: AbortSignal },
): Promise<LeverageItem[]> {
  // A caller that already ran `groupLeverage(input)` (the Alert Monitor paints those removal numbers first) passes
  // them in so the grouping is not repeated. They are copied, because the replay below mutates its items and the
  // caller's list may be on screen.
  const items = groups ? groups.map(item => ({ ...item })) : groupLeverage(input);
  const eligible = items.filter(_replayable).sort((a, b) =>
    b.alertIds.length - a.alertIds.length || b.orderIds.length - a.orderIds.length || (a.key < b.key ? -1 : 1));
  const cap = Math.max(0, input.replayCap ?? DEFAULT_REPLAY_CAP);
  const chosen = eligible.slice(0, cap);
  for (const item of eligible.slice(cap)) item.capped = true;
  if (!chosen.length) return items;

  const variants: LeverageVariant[] = [];
  const replayed: LeverageItem[] = [];
  for (const item of chosen) {
    const v = await _variantFor(input, item, item.assumedMinutes!);
    if (v) { variants.push(v); replayed.push(item); }
  }
  if (!variants.length) return items;
  const results = await (opts?.signal ? runner(_replayBase(input), variants, { signal: opts.signal }) : runner(_replayBase(input), variants));
  const byKey = new Map(results.map(r => [r.key, r]));
  for (const item of replayed) {
    const r = byKey.get(item.key);
    if (r) _applyReplay(input, item, r);
  }
  return items;
}

/** Replays one setup-pair item with minutes the user typed (the `requiresMinutes` card's input). Returns a new item. */
export async function replayWithMinutes(
  input: LeverageInput, item: LeverageItem, minutes: number, runner: LeverageRunner, opts?: { signal?: AbortSignal },
): Promise<LeverageItem> {
  if (!Number.isFinite(minutes) || minutes <= 0) return { ...item, requiresMinutes: true };
  const used = Math.ceil(minutes);   // integer minutes only (see plant-default rounding above)
  const v = await _variantFor(input, item, used);
  if (!v) return item;
  const [r] = await (opts?.signal ? runner(_replayBase(input), [v], { signal: opts.signal }) : runner(_replayBase(input), [v]));
  if (!r) return item;
  const next: LeverageItem = { ...item, requiresMinutes: false, assumedMinutes: used, minutesSource: 'user' };
  _applyReplay(input, next, r);
  return next;
}
