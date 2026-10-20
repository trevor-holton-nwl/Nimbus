/*
 * frontend/types.mts — shared domain typedefs for the TypeScript migration.
 *
 * Source material: docs/archive/typescript_migration.md §C (domain data shapes) and
 * §D (string-literal enum inventory), a full read of the frontend done once
 * up front so later phases read findings here instead of re-deriving them.
 * This file has zero runtime code — every export is a `type`/`interface` and
 * erases completely on compile; the emitted frontend/types.mjs is an empty module.
 *
 * ⚠️ NAMING COLLISION, BY DESIGN: frontend/nimbus-compute-core.d.ts already
 * declares GLOBAL AMBIENT interfaces (via `declare global`) named NimbusTask,
 * NimbusBlock, NimbusPlantBlock, NimbusLineSetting, NimbusMasterData —
 * deliberately minimal subsets scoped to the worker/compute-core payload
 * shapes. This file's exports of the SAME names are the full domain
 * supersets and are MODULE-SCOPED, not ambient. A file that references the
 * bare identifier `NimbusTask` without `import type { NimbusTask } from
 * './types.mjs'` silently gets the older 6-field ambient subset instead of
 * this one. Always import explicitly. Do not merge/rename either side to
 * "fix" this — see docs/archive/typescript_migration.md trap T-5.
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
  planning_status?: 'scheduled' | 'needs_planning';
  planning_reason?: { code: string; message: string } | null;
  text?: string;
  MACHINE: string;
  PLANT?: string;
  /** Distinct lowercase field used by Selection.selectedRefs; likely a legacy alias of PLANT. */
  plant: string | null;
  RUN_TIME: number | string | null;
  start_date: Date | null;
  end_date: Date | null;
  original_start_date: Date | null;
  /** SAP due date (Util.sapDueDate reads this). */
  original_end_date: Date | null;
  BASIC_START_DATE: Date | null;
  BASIC_FINISH_DATE: Date | null;
  /** Manual (planner) firm mirror of Store.firmedIds — never derived. See Engine.firmingStatus for the ECC/frozen/manual union. */
  firmed: boolean;
  /** SAP FIRMING_INDICATOR == 'X' (read-only; from the /tasks DTO). */
  ecc_firmed?: boolean;
  /** Opaque Postgres xmin; sent back to the server as `base_version`. */
  row_version: number | null;
  COLOR?: string;
  /** Materialized from material_plants at ingest (docs/scheduling_priority.md
   *  Stage 1) — not yet consulted by the optimizer (Stage 3). No RANKS field
   *  exists or is planned; ranks resolve client-side from per-plant maps. */
  PRT_01?: string;
  PRT_02?: string;
  PRODUCTION_VERSION?: string | null;
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
  /** SAP parent order key for a distributed sub-order; read-only. */
  PARENT_ORDER?: string | null;
  /** Letter index for a distributed sub-order within its parent; read-only. */
  DISTRIBUTION_LETTER?: string | null;
  user_scheduled?: boolean;
  /** Two or more productive child intervals. An absent/empty list means the
   *  parent is a legacy continuous schedule; this is never a manually edited
   *  collection. */
  scheduleSegments?: OrderScheduleSegment[];
  /** Backend-derived diagnostic after a runtime ingest changes a persisted
   *  schedule aggregate; the planner regenerates it from the current parent start. */
  runtime_schedule_mismatch?: boolean;
  /** Why the planner's bar deliberately differs from its run-time width: 'overtime' (non-working time) or
   *  'overlong' (wider than the run time). null/absent = a normal bar; the server skips its width check for a
   *  marked bar. Sent on save (an explicit null clears it). */
  placement_exception?: 'overtime' | 'overlong' | null;
  /** Session-only note from the engine about a derivation it made or refused (never persisted). */
  derivationIssue?: { code: string; from?: Date; to?: Date; detail?: string } | null;
  /** Session-only note: the start the engine moved this row from/to on its own (reconcile) and why. Never persisted. */
  systemMove?: { from: Date; to: Date; reason: string } | null;
  /** Server-computed field describing where an order's RUN_TIME value came from (routing runtime feature). */
  run_time_source?: string | null;
  /** Server-computed metadata sidecar for the RUN_TIME source determination. */
  run_time_basis?: Record<string, unknown> | null;
  /** Open SAP bag — real rows carry additional raw columns not modeled above. */
  [key: string]: unknown;
}

export interface OrderScheduleSegment {
  sequence: number;
  startDate: Date;
  endDate: Date;
}

export type SplitOrderPolicy = 'never' | 'overlong_only' | 'partial_allowed';

export type UnknownSetupPolicy = 'zero' | 'plantDefaultMinutes' | 'excludeFromSearch';

export interface NimbusBlock {
  id: string;
  /** null = all lines in the plant. Internal Store field name kept as `line`
   *  even though the GET/POST /plant-calendar wire field is now `machine` —
   *  this type is used far beyond that one wire boundary (Timeline rendering,
   *  Interaction, ProdLines, generic Store.addBlock callers), so renaming it
   *  would ripple outside this task's scope. CalendarSync translates at the
   *  wire boundary instead (schedule-data.mts _applyConfig / _blockPayload). */
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

/** Effective-dated override of a plant's default weekly hours (inclusive range; validTo null = open-ended).
 *  Store shape (camelCase); the wire shape is {id, name, valid_from, valid_to, work_hours}. */
export interface PlantPeriod {
  id: string;
  name: string;
  validFrom: string;
  validTo: string | null;
  workHours: WorkHours;
}

/** A plants-slice entry: the always-applying default weekly hours plus optional dated periods
 *  (absent key = no periods; an empty list is never stored). */
export interface PlantCalendarEntry {
  workHours: WorkHours;
  periods?: PlantPeriod[];
}

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
  /** Wire/DB alias: sap_workcenter. */
  sapWorkcenter?: string | null;
  /** Wire/DB alias: distribution_weight. */
  distributionWeight?: number | null;
}

export interface NimbusMasterLine {
  machine: string;
  plant: string;
  wc_group?: string;
  /** A line that cannot safely use the plant's active setup signature must
   * opt out of detached setup-aware evaluation. Omitted preserves the legacy
   * compatible behavior for cached/current snapshots. */
  setup_compatible?: boolean;
  setup_compatibility_reason?: string | null;
  sap_workcenter?: string;
  distribution_weight?: number | null;
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

/** {machine_or_empty: {field_key: {NORMALIZED_VALUE: RANK}}} — matches
 *  brain.PLANT_LISTS' native shape verbatim (GET /priority-rank-maps does no
 *  reshaping, since it's on the optimizer's hot path). Machine-first because
 *  Engine._sortTerms' per-task term resolves "this order's machine, else
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

/** One (plant, machine, field_key) row's metadata, from list_priority_lists_meta. */
export interface PriorityListRow {
  plant: string;
  machine: string;
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
  machine_overrides: PriorityListRow[];
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
  machine: string;
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
  /** Nullable whole calendar days an order may be scheduled before its due-date day. */
  max_pull_forward_days?: number | null;
  /** Nullable whole calendar days an order may be scheduled after its due-date day. */
  max_push_forward_days?: number | null;
  /** B3 (2026-08-21): plant-configurable override of the productive-segment
   *  floor (schema.sql: NOT NULL DEFAULT 30) that both the non-setup-aware
   *  split allocator (Calendar.allocateRuntime) and the setup-aware
   *  placeWithSetup primitive enforce. Null/unset falls back to
   *  schedule-services.mjs's exported MIN_PRODUCTIVE_SEGMENT_MINUTES default
   *  — see Engine.minProductiveSegmentMinutesFor. */
  min_productive_segment_minutes?: number | null;
  /** Workstream D2 (2026-08-20): the durable, plant-level "include setup times
   *  in optimizer" flag (plants.setup_active) — attached by master_data.py's
   *  list_rows sidecar the same way split_order_policy is, for the Scheduling
   *  Rules panel's checkbox. The optimizer/UI GATE itself reads
   *  SetupSnapshot.plant_active (same underlying column, fetched via
   *  GET /setup/{plant}), not this field — this one is display/edit-source
   *  for the relocated checkbox only. */
  setup_active?: boolean;
  /** schema.sql: NOT NULL DEFAULT FALSE. Per-plant switch for the routing-runtime
   *  feature (ROUTING_RUNTIME_DESIGN.md §3.6) — registered in column_metadata
   *  (2026-09-24 migration) so `list_rows`'s column_metadata-driven base SELECT
   *  for 'plants' already returns it, the same way it returns `setup_active`;
   *  no backend change needed to reach here via GET /master-data/plants ->
   *  Store.setMasterData -> Store.masterData.plants[]. */
  routing_runtime_enabled?: boolean;
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
  /** C1 (2026-08-20): nullable whole calendar days a planner can see into the
   *  future on the Gantt/Orders tab; null = unlimited. Server-enforced (GET
   *  /tasks bounds the payload itself) — this field only backs the
   *  Scheduling Rules panel's editable input, never a client-side filter by
   *  itself (see Store.visibilityHorizonEnd, computed server-side and sent
   *  down per-request instead of duplicating this plus a "now" into a client
   *  copy of the same clock math). */
  visibility_horizon_days?: number | null;
  /** UTC hour (0-23) at which the visibility window rolls forward a day;
   *  schema.sql: NOT NULL DEFAULT 19. */
  horizon_roll_hour_utc?: number;
  /** C2 (2026-08-20): nullable whole calendar days of the plant's frozen
   *  horizon — the near-term window (same anchor-day/roll-hour clock as
   *  visibility_horizon_days above, via db.compute_frozen_horizon_end) the
   *  optimizer may not place or move any order into. UNLIKE
   *  visibility_horizon_days, NULL *and* 0 both mean "off". Server-enforced
   *  at every optimizer placement site — this field only backs the
   *  Scheduling Rules panel's editable input (see Store.frozenHorizonEnd,
   *  computed server-side and sent down per-request instead of duplicating
   *  this plus a "now" into a client copy of the same clock math). */
  frozen_horizon_days?: number | null;
  /** N8 (2026-09): plants.setup_policy_config JSONB sidecar, attached by
   *  master_data.list_rows like split_order_policy. Only the unknown-setup
   *  keys are read client-side; Stage 2 keys ride along untouched. Version 1
   *  rows lack both keys → readers default to 'zero'/0 (today's behavior). */
  setup_policy_config?: {
    unknownSetupPolicy?: UnknownSetupPolicy;
    unknownSetupDefaultMinutes?: number;
    version?: number;
    [key: string]: unknown;
  } | null;
}

export interface NimbusMasterWorkcenter {
  plant: string;
  sap_workcenter: string;
  description?: string | null;
  distribution_mode: 'single' | 'distribute';
  default_machine?: string | null;
  max_separation: 'none' | 'hour' | 'day' | 'week';
  review_required: boolean;
  distribute_tooled: boolean;
}

export interface NimbusMasterData {
  plants: NimbusMasterPlant[];
  lines: NimbusMasterLine[];
  workcenters: NimbusMasterWorkcenter[];
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

/** A long-form setup-matrix row. `machine === ''` represents the plant default. */
export interface SetupMatrixRow {
  machine: string;
  signature_version: number;
  from_key: SetupStateKey;
  to_key: SetupStateKey;
  setup_min: number;
  source?: string;
  source_metadata?: Record<string, unknown>;
  source_reference?: string | null;
}

export interface LineSetupState {
  machine: string;
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
  machine: string;
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
  /** Content hash of the plant-default rows; echoed on a plant-default replace
   *  so the server can refuse a save built from a stale read (409). */
  plant_matrix_token?: string;
  machine_rows: SetupMatrixRow[];
  machine_states: LineSetupState[];
  overrides: SetupOccurrenceOverride[];
  /** Workstream D2 (2026-08-20): the real "include setup times in optimizer"
   *  gate, sourced from plants.setup_active — durable and plant-level, unlike
   *  `definition.active` (per-signature-version, force-reset to FALSE on
   *  every signature bump, now vestigial-but-retained; see setup_data.py).
   *  Deliberately a SEPARATE top-level field rather than an overload of
   *  `definition.active`, so this gate, machine.setup_compatible (per-machine),
   *  and the `plant === plant` snapshot-identity check all stay independently
   *  inspectable — never conflated into one meaning. */
  plant_active: boolean;
  freshness?: { signature_version: number | null; request_id: string };
  /** B3a (2026-08-21): marks a fabricated, zero-cost snapshot that
   *  `Engine._syntheticZeroCostSetupSnapshot` builds so an inactive (or
   *  never-configured) plant's `'changeover'` optimizer run can still route
   *  through `evaluateSetupAware` instead of the retired legacy day-integrity
   *  walk — never a real persisted snapshot, and never assigned onto
   *  `Store.setupSnapshot`. Its `plant_rows`/`machine_rows`/`overrides` are
   *  always empty, so every transition resolves as uncovered-but-admitted
   *  (never-freeze invariant, zero minutes). Consumers that surface "missing
   *  setup data" diagnostics (the live-run toast, the `'setup-uncovered'`
   *  bar/diagnostic) MUST suppress that reporting when this is `true` — the
   *  gaps it reports are an artifact of the synthetic matrix being
   *  intentionally empty, not a real data problem the plant needs to fix. */
  synthetic?: boolean;
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
  machine: string;
  predecessorState: SetupStateKey | null;
  successorState: SetupStateKey | null;
  predecessorOrderId?: string | null;
  successorOrderId: string;
  plantRows: ReadonlyArray<SetupMatrixRow>;
  machineRows: ReadonlyArray<SetupMatrixRow>;
  overrides: ReadonlyArray<SetupOccurrenceOverride>;
  /** Optional caller-owned prebuilt lookup index (Phase 1b, `setup-domain.mts`'s
   *  `buildSetupResolutionIndex`) letting `resolveSetup` replace its three linear
   *  scans with O(1) map lookups. Only consulted when its `signatureVersion`
   *  matches `definition.signature_version`; otherwise `resolveSetup` falls back
   *  to the unindexed scan unchanged. This is a type-only import — `setup-domain.mts`
   *  and this module do not form a runtime circular dependency. */
  index?: import('../setup/setup-domain.mjs').SetupResolutionIndex;
}

// ---------------------------------------------------------------------------
// §D — String-literal enum inventory
// ---------------------------------------------------------------------------

export type OptimizerMode = 'spt' | 'changeover' | 'duedate' | 'backlog';

export type AlertType =
  | 'overlap' | 'overload' | 'near-capacity' | 'closed'
  | 'blackout' | 'firmed-closed' | 'firmed-out-of-hours'
  | 'runtime-schedule-mismatch' | 'tool-conflict'
  | 'setup-violated' | 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged'
  | 'override-inactive' | 'predecessor-state-unknown' | 'successor-state-unknown' | 'distribution-separation'
  | 'runtime-unknown' | 'pv-lot-size'
  | 'late' | 'finish_moved_earlier' | 'reversal_forward' | 'plant_no_timezone' | 'line_no_calendar'
  | 'placement_exception' | 'setup_override_orphaned' | 'pull_floor_crossed' | 'frozen_window_crossed'
  | 'run_time_zero' | 'no_operating_window' | 'no_anchor' | 'derivation_issue';

export type AlertSev = 'err' | 'warn';

/** NOT the same set as AlertSev — 'ok' is a valid utilization bucket but never a valid alert sev. */
export type UtilSevBucket = 'err' | 'warn' | 'ok';

export type BufferUnit = 'pct' | 'hours';

export type TopLevelTab = 'home' | 'gantt' | 'masterdata' | 'labor' | 'admin';

export type GanttSubTab = 'timeline' | 'orders' | 'distribution';

export type MasterSubTab = 'lines' | 'plant' | 'material' | 'material-plant' | 'routing-pv' | 'work-centers';

export type LaborSubTab = 'aggregate' | 'line-plan' | 'capacity' | 'exceptions' | 'inputs';

export type StoreMode = 'live' | 'draft';

/** Configurable optimization and setup-signature fields. Production Version
 * remains readable for legacy persisted data, but is not configurable. */
export type ConstraintKey = 'colorWheel' | 'prt01' | 'prt02';

export type StoreEventType =
  | 'tasks:bulk' | 'task:update' | 'task:remove' | 'tasks:bulkUpdate'
  | 'firmed:change' | 'calendar:change' | 'blocks:change' | 'plantBlocks:change'
  | 'lineSettings:change' | 'plant:selected' | 'lines:selected' | 'alerts:change' | 'settings:change'
  | 'master-data-changed' | 'undo:pushed' | 'sandbox:entered' | 'sandbox:exited'
  | 'sandbox:reverted' | 'schedule:hydrated' | 'schedule:conflicts' | 'session:changed'
  | 'setup-snapshot:replace' | 'distribution:summary' | 'order-field-visibility:changed'
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
 *  time by `new Date(...)`. See docs/archive/typescript_migration.md §F. */
export type NaiveLocalTs = string;

/** UTC ISO-8601 timestamp (Date#toISOString(), trailing "Z") — the blackout-
 *  block write encoding (CalendarSync._blockPayload). Same conceptual
 *  "timestamp" as NaiveLocalTs, a DIFFERENT wire format — never conflate the
 *  two (§F). */
export type IsoUtcTs = string;

/** The in-memory Store shape: Dates are real Date objects, firmedIds is a real Set. */
export interface LiveState {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  calendars: Record<string, { workHours: WorkHours; inherited?: boolean }>;
  plants: Record<string, PlantCalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  lineSettings: Record<string, NimbusLineSetting>;
  firmedIds: Set<string>;
  selectedPlant: string | null;
  userSettings: Record<string, unknown>;
}

/** The localStorage-serialized shape (Persistence._saveCache / Config.LS_KEY,
 *  gated by Config.SCHEMA_VERSION). JSON.stringify turns every Date into an
 *  ISO string and the firmedIds Set into a string[]. `tasks` is deliberately
 *  NOT NimbusTask[] — its date fields are strings on disk, not Dates (T-6);
 *  re-coerced back into NimbusTask via Persistence._prepTask on read. `tasks`
 *  may also be PARTIAL: _writeCacheWithQuotaGuard writes progressively
 *  smaller tiers (last 2000 / last 500 / none) on QuotaExceededError. See
 *  docs/archive/typescript_migration.md §G. */
export interface StoredState {
  /** Dependent optimizer edits must survive offline hydration as one atomic save. */
  _optimizerDirtyIds?: string[];
  /** All locally edited orders must remain visibly unsaved after a reload. */
  _dirtyIds?: string[];
  _schemaVersion: number;
  _buildId: string | null;
  _savedAt: string;
  tasks: Array<Record<string, unknown>>;
  blocks: NimbusBlock[];
  calendars: Record<string, { workHours: WorkHours; inherited?: boolean }>;
  /** Legacy: never written and ignored on read. Manual firm is server state (`task.firmed`);
   *  firms found in an old cache are dropped ("start fresh"). */
  firmedIds?: string[];
  plants: Record<string, PlantCalendarEntry>;
  plantBlocks: NimbusPlantBlock[];
  lineSettings: Record<string, NimbusLineSetting>;
  selectedPlant: string | null;
  userSettings: Record<string, unknown>;
}
