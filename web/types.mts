/*
 * web/types.mts — shared domain typedefs for the TypeScript migration.
 *
 * Source material: docs/typescript_migration.md §C (domain data shapes) and
 * §D (string-literal enum inventory), a full read of the frontend done once
 * up front so later phases read findings here instead of re-deriving them.
 * This file has zero runtime code — every export is a `type`/`interface` and
 * erases completely on compile; the emitted web/types.mjs is an empty module.
 *
 * ⚠️ NAMING COLLISION, BY DESIGN: web/nimbus-compute-core.d.ts already
 * declares GLOBAL AMBIENT interfaces (via `declare global`) named NimbusTask,
 * NimbusBlock, NimbusPlantBlock, NimbusLineSetting, NimbusMasterData —
 * deliberately minimal subsets scoped to the worker/compute-core payload
 * shapes. This file's exports of the SAME names are the full domain
 * supersets and are MODULE-SCOPED, not ambient. A file that references the
 * bare identifier `NimbusTask` without `import type { NimbusTask } from
 * './types.mjs'` silently gets the older 6-field ambient subset instead of
 * this one. Always import explicitly. Do not merge/rename either side to
 * "fix" this — see docs/typescript_migration.md trap T-5.
 */

// ---------------------------------------------------------------------------
// §C — Domain data shapes
// ---------------------------------------------------------------------------

/**
 * A scheduled production order. There is no single task constructor —
 * Persistence._prepTask (schedule-data.mjs) and Store._normalizeDates
 * (schedule-state.mjs) are the two authorities that coerce/default these
 * fields from the raw /tasks response. Open SAP bag: real rows carry
 * additional columns beyond this list (e.g. "ORDER_QUANTITY_(GMEIN)"),
 * hence the index signature.
 */
export interface NimbusTask {
  id: string;
  text?: string;
  PRODUCTION_LINE: string;
  PLANT?: string;
  /** Distinct lowercase field used by Selection.selectedRefs; likely a legacy alias of PLANT. */
  plant: string | null;
  RUN_TIME: number | string;
  start_date: Date | null;
  end_date: Date | null;
  original_start_date: Date | null;
  /** SAP due date (Util.sapDueDate reads this). */
  original_end_date: Date | null;
  BASIC_START_DATE: Date | null;
  BASIC_FINISH_DATE: Date | null;
  fixed: boolean;
  /** SAP firmed→fixed mapping is currently commented out/disabled. */
  firmed?: boolean;
  /** Opaque Postgres xmin; sent back to the server as `base_version`. */
  row_version: number | null;
  COLOR?: string;
  FORM_SIZE?: string;
  MATERIAL_NUMBER?: string;
  MATERIAL_DESCRIPTION?: string;
  PRODUCTION_ORDER?: string;
  /** Legacy alt of PRODUCTION_ORDER (brain.py aliases PRODUCTION_ORDER -> ORDER in /tasks). */
  ORDER?: string;
  ORDER_Y?: number;
  notes?: string;
  user_scheduled?: boolean;
  /** Open SAP bag — real rows carry additional raw columns not modeled above. */
  [key: string]: unknown;
}

export interface NimbusBlock {
  id: string;
  /** null = all lines in the plant. */
  line: string | null;
  /** null = legacy global block. */
  plant: string | null;
  /** Re-parsed via Util.parseDate on every read — NOT guaranteed a Date, unlike task dates. */
  start: Date | string;
  end: Date | string;
  reason: string;
}

export interface NimbusPlantBlock {
  id: string;
  plant: string | null;
  start: Date | string;
  end: Date | string;
  reason: string;
}

/** Day-of-week (0=Sun..6=Sat) -> [startHour, endHour] fractional-hour tuple, or null if closed. */
export type WorkHours = Record<number, [number, number] | null>;

export interface NimbusLineSetting {
  plant: string | null;
  /** Wire/DB alias: buffer_type ('%'|'hrs'). */
  bufferUnit: 'pct' | 'hours';
  bufferPct: number;
  bufferHours: number;
  bottleneck: boolean;
  /** Wire/DB alias: excl_optimizer. */
  excludeFromOpt: boolean;
  plGroup: string;
}

export interface NimbusMasterLine {
  production_line: string;
  plant: string;
  pl_group?: string;
}

export interface ConstraintConfig {
  key: string;
  enabled: boolean;
  order?: number;
}

/** Keyed by composite (subnetwork, plant), not plant alone. */
export interface NimbusMasterPlant {
  subnetwork: string;
  plant: string;
  constraints?: ConstraintConfig[];
}

export interface NimbusMasterData {
  plants: NimbusMasterPlant[];
  lines: NimbusMasterLine[];
}

// ---------------------------------------------------------------------------
// §D — String-literal enum inventory
// ---------------------------------------------------------------------------

export type OptimizerMode = 'spt' | 'changeover' | 'combined';

export type AlertType =
  | 'overlap' | 'overload' | 'near-capacity' | 'closed'
  | 'blackout' | 'fixed-closed' | 'fixed-out-of-hours';

export type AlertSev = 'err' | 'warn';

/** NOT the same set as AlertSev — 'ok' is a valid utilization bucket but never a valid alert sev. */
export type UtilSevBucket = 'err' | 'warn' | 'ok';

export type BufferUnit = 'pct' | 'hours';

export type TopLevelTab = 'home' | 'gantt' | 'masterdata' | 'labor' | 'admin';

export type GanttSubTab = 'timeline' | 'orders';

export type MasterSubTab = 'lines' | 'plant';

export type LaborSubTab = 'aggregate' | 'line-plan' | 'capacity' | 'exceptions' | 'inputs';

export type StoreMode = 'live' | 'draft';

/** Only 'colorWheel' is wired today; 'tooling' is reserved/commented in Engine.CONSTRAINT_CATALOG. */
export type ConstraintKey = 'colorWheel';

export type StoreEventType =
  | 'tasks:bulk' | 'task:update' | 'task:remove' | 'tasks:bulkUpdate'
  | 'fixed:change' | 'calendar:change' | 'blocks:change' | 'plantBlocks:change'
  | 'lineSettings:change' | 'plant:selected' | 'alerts:change' | 'settings:change'
  | 'master-data-changed' | 'undo:pushed' | 'sandbox:entered' | 'sandbox:exited'
  | 'sandbox:reverted' | 'schedule:hydrated' | 'session:changed'
  /** Wholesale *:replace variants, e.g. 'tasks:replace'. */
  | `${string}:replace`;

export type SelectionEmitKind = 'clear' | 'set' | 'add' | 'remove' | 'toggle';

export type WorkerRequestType = 'ALERTS' | 'UTILIZATION';

export type WorkerResponseType = 'ALERTS' | 'UTILIZATION' | 'ERROR';
