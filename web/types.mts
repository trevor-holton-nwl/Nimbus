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
  /** Materialized from material_plants at ingest (docs/scheduling_priority.md
   *  Stage 1) — not yet consulted by the optimizer (Stage 3). No RANKS field
   *  exists or is planned; ranks resolve client-side from per-plant maps. */
  PRT_01?: string;
  PRT_02?: string;
  PRODUCTION_VERSION?: string;
  FORM_SIZE?: string;
  MATERIAL_NUMBER?: string;
  MATERIAL_DESCRIPTION?: string;
  PRODUCTION_ORDER?: string;
  /** Legacy alt of PRODUCTION_ORDER (brain.py aliases PRODUCTION_ORDER -> ORDER in /tasks). */
  ORDER?: string;
  ORDER_Y?: number;
  /** DB column is nullable (brain.py: `notes: str | None = None`) — Table/Inspector's
   *  note editors write `null` (not `''`) to explicitly clear a note. */
  notes?: string | null;
  user_scheduled?: boolean;
  /** Two or more productive child intervals. An absent/empty list means the
   *  parent is a legacy continuous schedule; this is never a manually edited
   *  collection. */
  scheduleSegments?: OrderScheduleSegment[];
  /** Backend-derived diagnostic after a runtime ingest changes a persisted
   *  schedule aggregate; the planner regenerates it from the current parent start. */
  runtime_schedule_mismatch?: boolean;
  /** Open SAP bag — real rows carry additional raw columns not modeled above. */
  [key: string]: unknown;
}

export interface OrderScheduleSegment {
  sequence: number;
  startDate: Date;
  endDate: Date;
}

export type SplitOrderPolicy = 'never' | 'overlong_only' | 'partial_allowed';

/** Plant-scoped Stage 2 policy sidecar.  All modes default off until the
 * separate validation/performance activation gate is satisfied. */
export interface SetupPolicyConfig {
  plant: string;
  dueDateFirstEnabled: boolean;
  minChangeoverEnabled: boolean;
  throughputEnabled: boolean;
  throughputMinSavingsMin: number;
  throughputMaxSlipMin: number;
  version: number;
}

/** Plant-scoped release evidence required before any setup policy may enable. */
export interface SetupReleaseEvidence {
  plant: string;
  stage1Validated: boolean;
  localDbVerified: boolean;
  performanceVerified: boolean;
  browserUatVerified: boolean;
  representativeReplayVerified: boolean;
  nullPredecessorVerified: boolean;
  ownerApproved: boolean;
  ownerEmail: string | null;
  approvedAt: string | null;
  notes: string;
  version: number;
  ready: boolean;
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
  bufferUnit: BufferUnit;
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
  /** A line that cannot safely use the plant's active setup signature must
   * opt out of detached setup-aware evaluation. Omitted preserves the legacy
   * compatible behavior for cached/current snapshots. */
  setup_compatible?: boolean;
  setup_compatibility_reason?: string | null;
}

export interface ConstraintConfig {
  key: string;
  enabled: boolean;
  order?: number;
  /** Stage 3: a field nested under a field is mathematically identical to the
   *  next key in a lexicographic sort (docs/scheduling_priority.md "Sub-sort
   *  model" decision) — Engine.flattenConstraints (Task 4) turns this into the
   *  same flat key list _sortTerms already consumes. Purely additive: cached
   *  `plants` rows with no `children` still parse as leaf nodes, so this is
   *  NOT a SCHEMA_VERSION bump (N17). */
  children?: ConstraintConfig[];
}

/** {line_or_empty: {field_key: {NORMALIZED_VALUE: RANK}}} — matches
 *  brain.PLANT_LISTS' native shape verbatim (GET /priority-rank-maps does no
 *  reshaping, since it's on the optimizer's hot path). Line-first because
 *  Engine._sortTerms' per-task term resolves "this order's line, else
 *  plant-wide" before it knows which field it's looking up. */
export type PriorityRankMaps = Record<string, Record<string, Record<string, number>>>;

/** GET /priority-fields row. */
export interface PriorityFieldMeta {
  field_key: string;
  mp_column: string;
  orders_column: string;
  task_field: string;
  default_label: string;
}

/** One (plant, line, field_key) row's metadata, from list_priority_lists_meta. */
export interface PriorityListRow {
  plant: string;
  line: string;
  field_key: string;
  uploaded_at: string | null;
  uploaded_by: string | null;
  filename: string | null;
  row_count: number;
}

/** GET /priority-lists?plant= response, per field_key. */
export interface PriorityListFieldSummary {
  default_label: string;
  plant_wide: PriorityListRow | null;
  line_overrides: PriorityListRow[];
  coverage: Record<string, { distinct_values: number; ranked_values: number }>;
}
export interface PriorityListsForPlant {
  plant: string;
  fields: Record<string, PriorityListFieldSummary>;
}

/** GET /priority-list/{plant}/{field_key} response. */
export interface PriorityListEntry { value: string; rank: number; }
export interface PriorityListResponse {
  plant: string;
  field_key: string;
  line: string;
  entries: PriorityListEntry[];
  meta: { uploaded_at: string | null; uploaded_by: string | null; filename: string | null; row_count: number };
}

/** Shared shape of both missing-master-data endpoints (batch-scoped and live). */
export interface MissingMasterDataException {
  plant: string | null;
  material_number: string;
  order_count: number;
  reason: 'no_mp_row' | 'no_plant_derived';
}
export interface MissingMasterDataReport {
  unmatched_pairs: number;
  unmatched_orders: number;
  exceptions: MissingMasterDataException[];
}

/** Keyed by composite (subnetwork, plant), not plant alone. */
export interface NimbusMasterPlant {
  subnetwork: string;
  plant: string;
  constraints?: ConstraintConfig[];
  /** Plant-only allocation behavior; missing values intentionally preserve
   *  legacy continuous scheduling. */
  split_order_policy?: SplitOrderPolicy | null;
  setup_policy_config?: SetupPolicyConfig | null;
  setup_release_evidence?: SetupReleaseEvidence | null;
  /** Minutes; schema.sql: NOT NULL DEFAULT 43200. Per-plant override for the
   *  Timeline alert-horizon shading band (falls back to
   *  Store.userSettings.alertHorizonMinutes when absent client-side). */
  alt_flag_horizon?: number;
  /** Minutes; schema.sql: NOT NULL DEFAULT 20160. Confidence-score horizon
   *  (nimbus-intelligence.js's Confidence module — not read by this file). */
  conf_score_horizon?: number;
  /** Human plant name, e.g. "Maryville" (admin-editable via Manage Data Tables; nullable). */
  description?: string | null;
  /** What the plant makes, e.g. "Injection-molded FoodSaver containers". */
  product_focus?: string | null;
  /** IANA zone, e.g. "America/Chicago". May be absent or invalid — all readers
   *  must go through Util.plantNowParts's try/catch, never Intl directly. */
  timezone?: string | null;
}

export interface NimbusMasterData {
  plants: NimbusMasterPlant[];
  lines: NimbusMasterLine[];
}

// ---------------------------------------------------------------------------
// Setup-transition domain contracts (Changeover Matrix Stage 0)
// ---------------------------------------------------------------------------

/** A canonical, ordered setup signature. It is not delimiter-joined because
 * values may themselves contain delimiter characters. */
export type SetupStateKey = ReadonlyArray<{ fieldKey: string; value: string }>;

/** Plant-scoped setup-signature definition as returned by GET /setup/{plant}. */
export interface SetupDefinition {
  plant: string;
  fields: ReadonlyArray<string>;
  signature_version: number;
  strict_blanks: boolean;
  active: boolean;
}

/** A long-form setup-matrix row. `line === ''` represents the plant default. */
export interface SetupMatrixRow {
  line: string;
  signature_version: number;
  from_key: SetupStateKey;
  to_key: SetupStateKey;
  setup_min: number;
  source?: string;
  source_metadata?: Record<string, unknown>;
  source_reference?: string | null;
}

export interface LineSetupState {
  line: string;
  state_key: SetupStateKey;
  signature_version: number;
  physical_mold_id?: string | null;
  observed_at?: string | null;
  source: 'manual' | 'derived' | 'actual';
  reason: string;
}

/** An exact, remaining-work override for one predecessor/successor occurrence. */
export interface SetupOccurrenceOverride {
  id: string | number;
  line: string;
  signature_version: number;
  predecessor_order_id: string | null;
  successor_order_id: string;
  predecessor_state_key: SetupStateKey;
  successor_state_key: SetupStateKey;
  standard_min: number;
  remaining_min: number;
  status: 'active' | 'inactive' | 'cleared' | 'replaced';
  reason: string;
}

/** One authorized plant's complete setup truth, returned by GET /setup/{plant}.
 * This remains separate from persisted schedule state: it is read-only
 * observation data for the changeover matrix rollout. */
export interface SetupSnapshot {
  plant: string;
  definition: SetupDefinition | null;
  plant_rows: SetupMatrixRow[];
  line_rows: SetupMatrixRow[];
  line_states: LineSetupState[];
  overrides: SetupOccurrenceOverride[];
  freshness?: { signature_version: number | null; request_id: string };
}

export type SetupResolutionSource = 'occurrence' | 'line' | 'plant' | 'implicit-zero' | 'uncovered';

export interface ResolvedSetup {
  covered: boolean;
  requiredMin: number | null;
  effectiveMin: number | null;
  standardMin: number | null;
  source: SetupResolutionSource;
  reason: string;
  signatureVersion: number;
  overrideId?: string;
}

/** Semantic timeline identity. Derived setup occurrences are presentation facts,
 * never business orders or persisted schedule state. */
export type TimelineItemKind = 'order' | 'order-segment' | 'setup' | 'blackout' | 'zone';

/** Pure setup-resolution input; callers supply only the selected plant's snapshot. */
export interface ResolveSetupInput {
  definition: SetupDefinition;
  line: string;
  predecessorState: SetupStateKey | null;
  successorState: SetupStateKey | null;
  predecessorOrderId?: string | null;
  successorOrderId: string;
  plantRows: ReadonlyArray<SetupMatrixRow>;
  lineRows: ReadonlyArray<SetupMatrixRow>;
  overrides: ReadonlyArray<SetupOccurrenceOverride>;
}

// ---------------------------------------------------------------------------
// §D — String-literal enum inventory
// ---------------------------------------------------------------------------

export type OptimizerMode = 'spt' | 'changeover' | 'combined' | 'backlog';

export type AlertType =
  | 'overlap' | 'overload' | 'near-capacity' | 'closed'
  | 'blackout' | 'fixed-closed' | 'fixed-out-of-hours'
  | 'runtime-schedule-mismatch';

export type AlertSev = 'err' | 'warn';

/** NOT the same set as AlertSev — 'ok' is a valid utilization bucket but never a valid alert sev. */
export type UtilSevBucket = 'err' | 'warn' | 'ok';

export type BufferUnit = 'pct' | 'hours';

export type TopLevelTab = 'home' | 'gantt' | 'masterdata' | 'labor' | 'admin';

export type GanttSubTab = 'timeline' | 'orders';

export type MasterSubTab = 'lines' | 'plant' | 'material' | 'material-plant';

export type LaborSubTab = 'aggregate' | 'line-plan' | 'capacity' | 'exceptions' | 'inputs';

export type StoreMode = 'live' | 'draft';

/** Widened in Stage 2 — all four RANKABLE_FIELDS keys exist as upload targets;
 *  since Stage 3's term-factory rewrite all four are also wired into
 *  Engine._sortTerms generically (one ordinal term per enabled key). */
export type ConstraintKey = 'colorWheel' | 'prt01' | 'prt02' | 'productionVersion';

export type StoreEventType =
  | 'tasks:bulk' | 'task:update' | 'task:remove' | 'tasks:bulkUpdate'
  | 'fixed:change' | 'calendar:change' | 'blocks:change' | 'plantBlocks:change'
  | 'lineSettings:change' | 'plant:selected' | 'lines:selected' | 'alerts:change' | 'settings:change'
  | 'master-data-changed' | 'undo:pushed' | 'sandbox:entered' | 'sandbox:exited'
  | 'sandbox:reverted' | 'schedule:hydrated' | 'session:changed'
  | 'setup-snapshot:replace'
  // NOTE: no 'priority-rank-maps:updated' member. Store.setPriorityRankMaps
  // deliberately does not emit (see its comment in schedule-state.mts), and the
  // late-arriving /priority-fields registry re-render is a direct
  // Plant.onPriorityFieldsLoaded() call rather than a broadcast — precisely so
  // neither path trips Persistence.autosave's unfiltered subscriber.
  /** Wholesale *:replace variants, e.g. 'tasks:replace'. */
  | `${string}:replace`;

export type SelectionEmitKind = 'clear' | 'set' | 'add' | 'remove' | 'toggle';

export type WorkerRequestType = 'ALERTS' | 'UTILIZATION';

export type WorkerResponseType = 'ALERTS' | 'UTILIZATION' | 'ERROR';

// ---------------------------------------------------------------------------
// §F/§G — Client<->server wire encodings and localStorage (de)serialization
// ---------------------------------------------------------------------------

/** Naive local timestamp, NO trailing "Z"/offset — the /tasks read path's and
 *  the task-save path's (Util.toLocalSeconds) wire encoding. Parsed as LOCAL
 *  time by `new Date(...)`. See docs/typescript_migration.md §F. */
export type NaiveLocalTs = string;

/** UTC ISO-8601 timestamp (Date#toISOString(), trailing "Z") — the blackout-
 *  block write encoding (CalendarSync._blockPayload). Same conceptual
 *  "timestamp" as NaiveLocalTs, a DIFFERENT wire format — never conflate the
 *  two (§F). */
export type IsoUtcTs = string;

/** The in-memory Store shape: Dates are real Date objects, fixedIds is a real Set. */
export interface LiveState {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  calendars: Record<string, { workHours: WorkHours }>;
  plants: Record<string, { workHours: WorkHours }>;
  plantBlocks: NimbusPlantBlock[];
  lineSettings: Record<string, NimbusLineSetting>;
  fixedIds: Set<string>;
  selectedPlant: string | null;
  userSettings: Record<string, unknown>;
}

/** The localStorage-serialized shape (Persistence._saveCache / Config.LS_KEY,
 *  gated by Config.SCHEMA_VERSION). JSON.stringify turns every Date into an
 *  ISO string and the fixedIds Set into a string[]. `tasks` is deliberately
 *  NOT NimbusTask[] — its date fields are strings on disk, not Dates (T-6);
 *  re-coerced back into NimbusTask via Persistence._prepTask on read. `tasks`
 *  may also be PARTIAL: _writeCacheWithQuotaGuard writes progressively
 *  smaller tiers (last 2000 / last 500 / none) on QuotaExceededError. See
 *  docs/typescript_migration.md §G. */
export interface StoredState {
  _schemaVersion: number;
  _buildId: string | null;
  _savedAt: string;
  tasks: Array<Record<string, unknown>>;
  blocks: NimbusBlock[];
  calendars: Record<string, { workHours: WorkHours }>;
  fixedIds: string[];
  plants: Record<string, { workHours: WorkHours }>;
  plantBlocks: NimbusPlantBlock[];
  lineSettings: Record<string, NimbusLineSetting>;
  selectedPlant: string | null;
  userSettings: Record<string, unknown>;
}
