// optimization/headless-snapshot.mts: build the optimizer's ScheduleSnapshot from the raw JSON bodies the
// backend serves, with no Store, no DOM and no network (the Jobs scheduler's headless path).
//
// The browser reaches the same snapshot by a long route: Persistence._prepTask and Store.setTasks per row,
// CalendarSync._applyConfig for hours and blackouts, Store.applyMasterLinesToSettings for line settings, then
// Engine.snapshotSchedule(plant) clones the result. This file reproduces the PURE parts of each step in the
// same order so the two agree; tests/modules/optimization/headless-snapshot.test.mjs holds them equal. When
// any of those browser steps changes, change the matching function here (each carries a "mirrors" note).
//
// The result is a snapshot of one plant. It does NOT yet carry the display-derived starts of never-placed
// orders: that is the reconcile's job (headless-runtime.mts), exactly as in the browser.
import { Config, Util } from '../platform/foundation.mjs';
import type {
  NimbusTask, NimbusBlock, NimbusPlantBlock, NimbusLineSetting, NimbusMasterData, NimbusMasterPlant, NimbusMasterLine,
  NimbusMasterWorkcenter, NimbusToolInventoryRow, PriorityRankMaps, SetupSnapshot, WorkHours, PlantCalendarEntry,
  PlantPeriod, OrderScheduleSegment,
} from '../platform/types.mjs';
import { resolveTaskPlant } from './setup-scheduler.mjs';
import type { ScheduleSnapshot } from './setup-scheduler.mjs';

/** Wire shape of one dated plant period (snake_case), as `GET /plant-calendar` returns it. */
interface PlantPeriodWire { id: string; name: string; valid_from: string; valid_to: string | null; work_hours: WorkHours }

/** `GET /plant-calendar?plant=` body. */
export interface PlantCalendarWire {
  calendar_version?: string | null;
  plant_periods?: PlantPeriodWire[];
  plant_work_hours?: WorkHours;
  line_work_hours?: Record<string, WorkHours>;
  machine_blackouts?: Array<{ id: string; machine: string | null; start: string; end: string; reason: string }>;
  plant_blackouts?: Array<{ id: string; start: string; end: string; reason: string }>;
}

/** The bundle the job runner gathers for ONE plant: each field is the body of the named endpoint. */
export interface HeadlessWire {
  /** `GET /tasks?plant=`: `data` rows plus `meta` (`frozen_horizon_end`, `server_now`, ...). */
  tasks: { data: Array<Record<string, unknown>>; meta?: { frozen_horizon_end?: string | null; server_now?: string | null } | null };
  /** `GET /plant-calendar?plant=`; null = the fetch failed (the plant keeps the default calendar). */
  calendar: PlantCalendarWire | null;
  /** `GET /setup/{plant}`; null = none. */
  setup: SetupSnapshot | null;
  /** `GET /priority-rank-maps?plant=`. */
  priorityRankMaps: PriorityRankMaps;
  masterData: {
    /** `GET /master-data/plants` (all plants) and `GET /master-data/machine?plant=`. */
    plants: { rows: NimbusMasterPlant[] };
    machine: { rows: NimbusMasterLine[] };
    sap_workcenter?: { rows: NimbusMasterWorkcenter[] } | null;
    /** `GET /master-data/tool_inventory?plant=`; null/absent = not loaded (never "empty"). */
    tool_inventory?: { rows: NimbusToolInventoryRow[] } | null;
  };
  /** `GET /tasks/horizons?plant=`: carries the version tokens the writer compares before apply. */
  horizons?: { calendar_version?: string | null; tool_inventory_version?: string | null; frozen_horizon_end?: string | null } | null;
}

export interface BuildSnapshotOptions {
  plant: string;
  /** The server's current instant: the one clock (Store.serverNow). */
  serverNow: Date;
}

/** Mirrors Persistence._segmentsFromRaw. */
function segmentsFromRaw(raw: Record<string, unknown>): OrderScheduleSegment[] {
  const source = Array.isArray(raw.schedule_segments)
    ? raw.schedule_segments
    : (Array.isArray(raw.scheduleSegments) ? raw.scheduleSegments : []);
  const segments = source.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return null;
    const segment = candidate as Record<string, unknown>;
    const start = Util.parseDate(segment.start_date ?? segment.startDate);
    const end = Util.parseDate(segment.end_date ?? segment.endDate);
    const sequence = Number(segment.sequence);
    return start instanceof Date && end instanceof Date && end > start
      ? { sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : index + 1, startDate: start, endDate: end }
      : null;
  }).filter((segment): segment is OrderScheduleSegment => segment !== null)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.sequence - b.sequence);
  return segments.length >= 2 ? segments : [];
}

/** Mirrors Persistence._prepTask. Mutates and returns `raw`. */
export function prepTask(raw: Record<string, unknown>): NimbusTask {
  if (!Object.prototype.hasOwnProperty.call(raw, 'BASIC_START_DATE')) raw.BASIC_START_DATE = raw.original_start_date ?? null;
  if (raw.planning_status === 'needs_planning') {
    raw.start_date = null;
    raw.end_date = null;
    raw.schedule_segments = [];
    raw.scheduleSegments = [];
  }
  raw.scheduleSegments = segmentsFromRaw(raw);
  delete raw.schedule_segments;
  for (const k of Object.keys(raw)) {
    if (k.toLowerCase().includes('date') && typeof raw[k] === 'string') raw[k] = Util.parseDate(raw[k] as string);
  }
  return raw as unknown as NimbusTask;
}

/** Mirrors Store._normalizeDates (the firmedIds side effect is returned by the caller instead). */
export function normalizeTaskDates(task: NimbusTask): void {
  const canonicalSchedule = task.planning_status !== undefined;
  for (const k of ['start_date', 'end_date', 'BASIC_START_DATE', 'BASIC_FINISH_DATE', 'original_start_date', 'original_end_date'] as const) {
    const v = task[k];
    if (v && !(v instanceof Date)) task[k] = Util.parseDate(v);
  }
  if (task.start_date && !canonicalSchedule) task.start_date = Util.snap(task.start_date);
  if (task.end_date && !canonicalSchedule) task.end_date = Util.snap(task.end_date);
  const rawSegments = Array.isArray(task.scheduleSegments) ? task.scheduleSegments : [];
  const segments = rawSegments.map((segment, index) => {
    const startDate = Util.parseDate(segment?.startDate);
    const endDate = Util.parseDate(segment?.endDate);
    return startDate instanceof Date && endDate instanceof Date && endDate > startDate
      ? { sequence: Number(segment?.sequence) || index + 1,
        startDate: canonicalSchedule ? startDate : Util.snap(startDate), endDate: canonicalSchedule ? endDate : Util.snap(endDate) }
      : null;
  }).filter((segment): segment is OrderScheduleSegment => segment !== null)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.sequence - b.sequence);
  task.scheduleSegments = segments.length >= 2
    ? segments.map((segment, index) => ({ ...segment, sequence: index + 1 }))
    : [];
  if (task.scheduleSegments.length >= 2) {
    task.start_date = new Date(task.scheduleSegments[0].startDate);
    task.end_date = new Date(task.scheduleSegments[task.scheduleSegments.length - 1].endDate);
  }
  task.planning_status ??= 'scheduled';
  if (task.planning_status === 'needs_planning') {
    task.start_date = null;
    task.end_date = null;
    task.scheduleSegments = [];
  }
  task.firmed = !!task.firmed;
  if (task.id != null) task.id = String(task.id);
}

function defaultWeek(): WorkHours {
  const week: WorkHours = {};
  for (let d = 0; d < 7; d++) week[d] = Config.WEEKEND_OFF && (d === 0 || d === 6) ? null : [...Config.DEFAULT_SHIFT] as [number, number];
  return week;
}

function allDayWeek(): WorkHours {
  const week: WorkHours = {};
  for (let d = 0; d < 7; d++) week[d] = [0, 24];
  return week;
}

/** The plant's wall clock for a server instant, via the compute core (the same call Store.plantNow makes). */
function plantWallClock(timezone: string | null | undefined, instant: Date): Date | null {
  const tz = typeof timezone === 'string' ? timezone.trim() : '';
  const core = (globalThis as unknown as { NimbusComputeCore?: { plantWallClockFromInstant(tz: string, d: Date): Date | null } }).NimbusComputeCore;
  if (!tz || !core) return null;
  return core.plantWallClockFromInstant(tz, instant);
}

/** Mirrors Store.frozenHorizonEndFor for the selected plant. */
function frozenHorizonEnd(plantRow: NimbusMasterPlant | undefined, serverNow: Date, cachedMeta: Date | null): Date | null {
  if (plantRow && plantRow.frozen_horizon_days !== undefined) {
    const days = plantRow.frozen_horizon_days;
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
    const now = plantWallClock(plantRow.timezone, serverNow);
    if (!now) return null;
    const end = new Date(now.getTime());
    end.setDate(end.getDate() + Math.trunc(days));
    return end;
  }
  return cachedMeta;
}

/** Mirrors Store.applyMasterLinesToSettings plus the lineSettings the load seeds from task PLANT values. */
function buildLineSettings(tasks: NimbusTask[], masterLines: NimbusMasterLine[]): Record<string, NimbusLineSetting> {
  const settings: Record<string, NimbusLineSetting> = {};
  const ensure = (line: string): NimbusLineSetting => (settings[line] ||= {
    plant: null, bufferUnit: 'pct', bufferPct: 0, bufferHours: 0, bottleneck: false, excludeFromOpt: false,
    plGroup: '', sapWorkcenter: null, distributionWeight: null,
  });
  for (const t of tasks) {
    if (!t.MACHINE || !t.PLANT) continue;
    ensure(t.MACHINE).plant = t.PLANT;
  }
  for (const row of masterLines as unknown as Array<Record<string, unknown>>) {
    const line = row.machine as string | undefined;
    if (!line) continue;
    const ls = ensure(line);
    ls.excludeFromOpt = row.excl_optimizer === 'X';
    ls.bottleneck = row.bottleneck === 'X';
    if (row.buffer_type === '%') ls.bufferUnit = 'pct';
    else if (row.buffer_type === 'hrs') ls.bufferUnit = 'hours';
    if (row.buffer_percent != null && row.buffer_percent !== '') ls.bufferPct = parseFloat(String(row.buffer_percent)) || 0;
    if (row.buffer_hours != null && row.buffer_hours !== '') ls.bufferHours = parseFloat(String(row.buffer_hours)) || 0;
    ls.plGroup = (row.wc_group as string) || '';
    ls.plant = (row.plant as string) || null;
    ls.sapWorkcenter = (row.sap_workcenter as string) || null;
    ls.distributionWeight = row.distribution_weight == null ? null : Number(row.distribution_weight);
  }
  return settings;
}

/** Mirrors Persistence._fetchToolInventory's ordering: plain code-unit order on tool_id. */
function sortedToolInventory(rows: NimbusToolInventoryRow[]): NimbusToolInventoryRow[] {
  return rows.slice().sort((a, b) => (a.tool_id < b.tool_id ? -1 : a.tool_id > b.tool_id ? 1 : 0));
}

/** Build the optimizer snapshot of one plant from the wire bundle. Pure: reads `wire`, the compute core and the
 *  Config constants only; never mutates `wire`. */
export function buildScheduleSnapshot(wire: HeadlessWire, { plant, serverNow }: BuildSnapshotOptions): ScheduleSnapshot {
  // Rows are keyed by id exactly like Store._state.tasks, so duplicate ids collapse and integer-like ids list
  // in ascending numeric order, as Store.tasksArr does.
  const byId: Record<string, NimbusTask> = {};
  const firmed: string[] = [];
  for (const raw of wire.tasks.data) {
    const id = raw?.id;
    if (id == null || String(id).trim() === '' || String(id).startsWith('PL_')) continue;
    const task = prepTask(structuredClone(raw));
    normalizeTaskDates(task);
    byId[String(task.id)] = task;
  }
  const allTasks = Object.values(byId);
  for (const task of allTasks) if (task.firmed) firmed.push(String(task.id));

  const masterLines = wire.masterData.machine.rows;
  const lineSettings = buildLineSettings(allTasks, masterLines);
  const masterData: NimbusMasterData = {
    plants: wire.masterData.plants.rows,
    lines: masterLines,
    workcenters: wire.masterData.sap_workcenter?.rows ?? [],
    tool_inventory: wire.masterData.tool_inventory ? sortedToolInventory(wire.masterData.tool_inventory.rows) : undefined,
  };
  const scope = { lineSettings, masterData };
  const tasks = allTasks.filter(task => resolveTaskPlant(task, scope) === plant);
  const scopedLines = new Set(tasks.map(task => String(task.MACHINE ?? '')).filter(Boolean));

  // Mirrors Store.getPlantForLine's fallback chain: a seeded calendar is all-day once the line's plant resolves.
  const linePlant = (line: string): string | null => lineSettings[line]?.plant
    ?? masterLines.find(row => row.machine === line)?.plant
    ?? allTasks.find(t => t.MACHINE === line && t.PLANT)?.PLANT ?? null;
  const cfg = wire.calendar ?? {};
  const lineRows = cfg.line_work_hours ?? {};
  const calendars: Record<string, { workHours: WorkHours; inherited?: boolean }> = {};
  for (const line of scopedLines) {
    calendars[line] = line in lineRows
      ? { workHours: lineRows[line], inherited: false }
      : { workHours: linePlant(line) ? allDayWeek() : defaultWeek(), inherited: true };
  }

  // Mirrors CalendarSync._applyConfig: the plant entry exists only when the server sent hours or periods.
  const plants: Record<string, PlantCalendarEntry> = {};
  if (cfg.plant_work_hours || (cfg.plant_periods !== undefined && cfg.plant_periods.length)) {
    const entry: PlantCalendarEntry = { workHours: cfg.plant_work_hours ?? defaultWeek() };
    if (cfg.plant_periods?.length) {
      entry.periods = cfg.plant_periods.map((w): PlantPeriod => ({
        id: w.id, name: w.name, validFrom: w.valid_from, validTo: w.valid_to ?? null, workHours: w.work_hours,
      })).sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    }
    plants[plant] = entry;
  }
  const blocks: NimbusBlock[] = (cfg.machine_blackouts ?? []).map(b => ({
    id: b.id, line: b.machine || null, plant, start: Util.parseDate(b.start), end: Util.parseDate(b.end), reason: b.reason || '',
  } as NimbusBlock));
  const plantBlocks: NimbusPlantBlock[] = (cfg.plant_blackouts ?? []).map(b => ({
    id: b.id, plant, start: Util.parseDate(b.start), end: Util.parseDate(b.end), reason: b.reason || '',
  } as NimbusPlantBlock));

  const metaFrozen = wire.tasks.meta?.frozen_horizon_end ?? null;
  const plantRow = masterData.plants.find(row => row.plant === plant);
  return {
    tasks,
    firmedIds: firmed,
    selectedPlant: plant,
    blocks: blocks.filter(block => !block.plant || block.plant === plant),
    plantBlocks: plantBlocks.filter(block => !block.plant || block.plant === plant),
    calendars,
    plants,
    lineSettings,
    masterData,
    priorityRankMaps: wire.priorityRankMaps ?? {},
    setupSnapshot: wire.setup ?? null,
    frozenHorizonEnd: frozenHorizonEnd(plantRow, serverNow, metaFrozen ? new Date(metaFrozen) : null),
    // Diagnostics only (the stale-apply check ignores it); a headless snapshot has no Store revision.
    readModelVersion: '0',
  };
}
