/*
 * Hand-written ambient declaration for nimbus-compute-core.js.
 *
 * nimbus-compute-core.js is a UMD module (Node `module.exports` / Web Worker `self` /
 * browser `window`) and is deliberately NOT compiled by tsc — see
 * docs/archive/typescript_migration.md's Phase 0 write-up for why (its three-way export branch
 * can't be faithfully reproduced by tsc's own `--module umd` emit, and the compute logic
 * inside is safety-critical and pinned byte-for-byte by tests/js/compute-core.test.js).
 *
 * This file exists purely so other TypeScript sources that reference the global
 * `NimbusComputeCore` (as `nimbus-worker.ts` does today, and as future converted modules
 * like schedule-services.mts will) get real type-checking against its actual shape.
 * Keep this in sync with the `return {...}` object at the bottom of nimbus-compute-core.js —
 * there is no automated check tying the two together.
 *
 * Everything below is declared inside `declare global` (rather than as ordinary module
 * exports) so it's usable from plain global-script sources like nimbus-worker.ts without
 * an `import` — adding an import there would reclassify it as a module and change its
 * compiled output shape (see docs/archive/typescript_migration.md's nimbus-worker.ts trap).
 */

export {};

declare global {
  interface NimbusAlert {
    id: string;
    sev: 'err' | 'warn';
    type: 'overlap' | 'overload' | 'near-capacity' | 'closed' | 'blackout' | 'firmed-closed' | 'firmed-out-of-hours' | 'runtime-schedule-mismatch'
      | 'tool-conflict'
      | 'setup-violated' | 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged' | 'override-inactive'
      | 'predecessor-state-unknown' | 'successor-state-unknown'
      | 'runtime-unknown' | 'pv-lot-size' | 'distribution-separation'
      | 'late' | 'finish_moved_earlier' | 'reversal_forward' | 'plant_no_timezone' | 'line_no_calendar'
      | 'placement_exception' | 'setup_override_orphaned' | 'pull_floor_crossed' | 'frozen_window_crossed'
      | 'run_time_zero' | 'no_operating_window' | 'no_anchor' | 'derivation_issue' | 'queued_now_fits' | 'needs_planning';
    msg: string;
    /** Optional localized form; the drawer prefers Util.t(msgKey, msgVars) when present. */
    msgKey?: string;
    msgVars?: Record<string, string | number>;
    /** Dates embedded in `msg` / `msgVars` in the core's fixed default format: `text` is that default text, `ms` the instant.
     *  Util.alertMessage swaps `text` for the viewer's date/time format. Absent when the alert embeds no date. */
    msgDates?: { text: string; ms: number }[];
    taskId?: string;
    /** The other order in a pairwise alert (overlap, tool-conflict). Prefer this over parsing `id`. */
    peerId?: string;
    /** Every other order in a count-aware tool-conflict (earliest first); `peerId` is peerIds[0]. Read via alertOrderIds(). */
    peerIds?: string[];
    /** tool-conflict only: the (upper-cased) tool id, copies available, machines in use, and whether an inventory row exists. */
    tool?: string;
    available?: number;
    inUse?: number;
    hasRow?: boolean;
    /** Setup diagnostics only: the from->to state pair and the plant/line scope (null when absent). */
    pairKey?: string | null;
    scope?: string | null;
    line: string;
    time: Date;
    /** late and needs_planning only: the order's due instant. Confidence scores these by `due`, not `time`. */
    due?: Date;
    requiredMinutes?: number;
    availableMinutes?: number;
    shortMinutes?: number;
  }

  interface NimbusTask {
    id: string;
    text?: string;
    MACHINE?: string;
    RUN_TIME?: number | string | null;
    PLANT?: string;
    start_date?: Date | null;
    end_date?: Date | null;
    /** The SAP finish as received (the due date); a date-only one arrives as an exact-midnight Date. */
    original_end_date?: Date | null;
    /** Server marker: the order was placed outside the normal rules. */
    placement_exception?: 'overtime' | 'overlong' | null;
    /** Session-only note the schedule engine leaves on a task; the core renders it as an alert. */
    derivationIssue?: { code: string; from?: Date; to?: Date; detail?: string } | null;
    firmed?: boolean; // manual firm mirror
    runtime_schedule_mismatch?: boolean;
    planning_status?: string;
    /** {code, step, message} per ROUTING_RUNTIME_DESIGN.md §4 item 2; message is
     *  already i18n'd server-side. */
    planning_reason?: { code?: string; step?: string | null; message?: string } | null;
    /** §5.2/§8.6: carries lot_size_warning (bool) among other resolver-written fields. */
    run_time_basis?: { lot_size_warning?: boolean } | null;
    PRT_01?: string;
    PRT_02?: string;
    PRODUCTION_ORDER?: string;
    ORDER?: string;
    scheduleSegments?: Array<{
      sequence: number;
      startDate?: Date | null;
      endDate?: Date | null;
      start_date?: Date | null;
      end_date?: Date | null;
    }>;
  }

  interface NimbusBlock {
    start: unknown;
    end: unknown;
    line?: string | null;
    plant?: string | null;
    reason?: string;
  }

  interface NimbusPlantBlock {
    start: unknown;
    end: unknown;
    plant?: string | null;
    reason?: string;
  }

  type NimbusWorkHours = Record<number, [number, number] | null>;

  interface NimbusCalendarEntry {
    workHours: NimbusWorkHours;
    /** Line calendars only: no machine row, follows the plant (hours are all-day when the plant resolves). */
    inherited?: boolean;
  }

  /** Effective-dated override of a plant's default weekly hours (inclusive range, validTo null = open-ended). */
  interface NimbusPlantPeriod {
    id: string;
    name: string;
    validFrom: string;
    validTo: string | null;
    workHours: NimbusWorkHours;
  }

  interface NimbusPlantCalendarEntry extends NimbusCalendarEntry {
    periods?: NimbusPlantPeriod[];
  }

  type NimbusPeriodValidation =
    | { ok: true }
    | { ok: false; code: 'period_dates_invalid' | 'period_overlap' | 'period_invalid'; ids: string[] };

  interface NimbusLineSetting {
    plant?: string;
    bufferUnit?: 'pct' | 'hours';
    bufferPct?: number;
    bufferHours?: number;
  }

  interface NimbusMasterDataLine {
    machine: string;
    plant: string;
  }

  interface NimbusToolInventoryRowLike {
    plant: string;
    tool_id: string;
    total_qty?: number;
    out_of_service_qty?: number;
    /** Compact worker projection: copies available (used instead of total/oos when present). */
    available?: number;
    hasRow?: boolean;
  }

  interface NimbusMasterData {
    plants?: Array<{ plant: string; setup_active?: boolean }>;
    lines?: NimbusMasterDataLine[];
    workcenters?: unknown[];
    /** Per-plant tool copies; undefined = not loaded (every tool counts as one copy). */
    tool_inventory?: NimbusToolInventoryRowLike[];
  }

  interface NimbusUtilizationRow {
    date: Date;
    scheduled: number;
    capacity: number;
    effectiveCapacity: number;
    tasks: string[];
    pct?: number;
  }

  interface NimbusUtilizationMatrix {
    [line: string]: {
      [dayKey: string]: NimbusUtilizationRow;
    };
  }

  /** Pre-resolved, plant/line-scoped setup observation. Compute code consumes
   * these facts only; raw setup rows deliberately never cross this boundary. */
  interface NimbusSetupInterval {
    line: string;
    scope?: string;
    predecessorOrderId?: string | null;
    successorOrderId?: string;
    start: Date;
    end: Date;
    requiredMinutes: number;
    availableMinutes?: number;
  }

  interface NimbusSetupDiagnostic {
    type: 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged' | 'override-inactive'
      | 'predecessor-state-unknown' | 'successor-state-unknown' | 'setup-no-change';
    line: string;
    scope?: string;
    pairKey?: string;
    predecessorOrderId?: string | null;
    successorOrderId?: string;
    time?: Date;
    message?: string;
    // D4: populated only by 'setup-no-change' (identical-signature, covered,
    // zero-minute transition) — mirrors SetupComputeDiagnostic in
    // frontend/schedule-services.mts, kept in sync deliberately.
    predecessorState?: unknown;
    successorState?: unknown;
    requiredMinutes?: number;
    effectiveMinutes?: number;
    standardMinutes?: number;
    source?: string;
  }

  interface NimbusSetupObservation {
    intervals: NimbusSetupInterval[];
    diagnostics: NimbusSetupDiagnostic[];
  }

  interface ComputeAlertsPayload {
    tasks: NimbusTask[];
    blocks: NimbusBlock[];
    plantBlocks: NimbusPlantBlock[];
    calendars: Record<string, NimbusCalendarEntry>;
    plants: Record<string, NimbusPlantCalendarEntry>;
    lineSettings: Record<string, NimbusLineSetting>;
    masterData: NimbusMasterData;
    dismissed: string[];
    opts?: { lines?: string[] | null };
    setup?: NimbusSetupObservation;
    /** Per-plant wall-clock "now" (naive Date in the plant zone, from Store.plantNow), keyed by plant.
     *  The active-order horizon reads it instead of the worker's own clock; a plant with no entry
     *  falls back to the clock of the thread running the core. */
    now?: Record<string, Date>;
    /** Plants the clock refused (no valid timezone, from Store._blockedPlants): one plant_no_timezone alert each. */
    blockedPlants?: string[];
  }

  interface ComputeUtilizationPayload {
    tasks: NimbusTask[];
    lineSettings: Record<string, NimbusLineSetting>;
    calendars: Record<string, NimbusCalendarEntry>;
    plants: Record<string, NimbusPlantCalendarEntry>;
    blocks: NimbusBlock[];
    plantBlocks: NimbusPlantBlock[];
    masterData: NimbusMasterData;
    startMs: number;
    days: number;
    lines?: string[];
    setup?: NimbusSetupObservation;
  }

  interface NimbusConfidenceWeights {
    err: number; warn: number; tw3: number; tw7: number; perMachine: number;
  }

  interface NimbusConfidenceInput {
    alerts: Array<Pick<NimbusAlert, 'sev'> & { time?: Date | null; due?: Date | null }>;
    horizonStart: Date;
    horizonMinutes: number;
    /** Active machines of the plant being scored (min 1); defaults to 5 when absent. */
    machines?: number;
  }

  interface NimbusConfidenceResult {
    score: number;
    /** 100 - score; errPenalty + warnPenalty === penalty exactly. */
    penalty: number;
    errPenalty: number;
    warnPenalty: number;
    /** Unrounded sum of alert points (no caps). */
    rawAlertPoints: number;
    rawErrPoints: number;
    rawWarnPoints: number;
    machines: number;
  }

  interface NimbusToolItem {
    id: string | number;
    line: string;
    plant?: string | null;
    tools?: string[];
    tool?: string;
    start: Date | number;
    end: Date | number;
  }

  interface NimbusToolCluster {
    plant: string;
    tool: string;
    at: Date;
    available: number;
    hasRow: boolean;
    inUse: number;
    pusher: string;
    pusherLine: string;
    holders: Array<{ id: string; line: string; start: Date; end: Date }>;
  }

  interface NimbusToolIndex {
    groups: Map<string, unknown>;
    capacityFor?: (plant: string, tool: string) => { available: number; hasRow: boolean };
  }

  interface NimbusComputeCoreApi {
    // constants
    CONFIDENCE_WEIGHTS: Readonly<NimbusConfidenceWeights>;
    OVERLOAD_THRESHOLD: number;
    OVERLOAD_TOLERANCE_H: number;
    WARN_THRESHOLD: number;
    isOverloaded(scheduledH: number, effCapH: number, capH?: number): boolean;
    SHOW_NEAR_CAPACITY_ALERTS: boolean;
    DEFAULT_SHIFT: [number, number];
    WEEKEND_OFF: boolean;

    // tool inventory
    TOOL_PLACEHOLDERS: ReadonlySet<string>;
    normalizeToolId(v: unknown): string | null;
    taskToolIds(task: NimbusTask): string[];
    taskToolPlant(task: NimbusTask, plantOf?: (line: string) => string | null): string | null;
    toolOccupancyInterval(task: NimbusTask): { start: Date; end: Date } | null;
    buildToolCapacity(masterData?: NimbusMasterData | null): Map<string, { available: number; hasRow: boolean }>;
    availableCopies(capacity: Map<string, { available: number; hasRow: boolean }> | null | undefined, plant: string | null | undefined, tool: string): { available: number; hasRow: boolean };
    findToolOverages(args: { items: NimbusToolItem[]; capacityFor: (plant: string, tool: string) => { available: number; hasRow: boolean }; now?: Date | number }): NimbusToolCluster[];
    toolConflictAlertId(cluster: Pick<NimbusToolCluster, 'tool' | 'pusher' | 'holders'>, used?: Set<string>): string;
    buildToolIndex(args: { items: NimbusToolItem[]; capacityFor: (plant: string, tool: string) => { available: number; hasRow: boolean }; now?: Date | number }): NimbusToolIndex;
    /**
     * Mutate a buildToolIndex result in place when ONE order's interval changes (no rebuild): removes `oldInterval`
     * (matched by id + line + start + end per tool) and inserts `newInterval`; null = only remove / only insert.
     * Intervals are `{plant, line, tools | tool, start, end}`; pass already-clipped times (the index keeps no `now`). Returns the index.
     */
    toolIndexUpdate(index: NimbusToolIndex, id: string | number, oldInterval: Omit<NimbusToolItem, 'id'> | null, newInterval: Omit<NimbusToolItem, 'id'> | null): NimbusToolIndex;
    toolHeadroom(index: NimbusToolIndex, plant: string, tools: string[], from: Date | number, to: Date | number, excludeLine?: string | null): Array<{ start: Date; end: Date }>;

    // date/time helpers
    parseDate(v: unknown): Date | null;
    dayKey(d: unknown): string;
    startOfDay(d: unknown): Date | null;
    separationBucketKey(d: unknown, scope: 'none' | 'hour' | 'day' | 'week'): string | null;
    scheduleIntervals(task: NimbusTask): Array<{ sequence: number; start: Date; end: Date }>;
    fmtDTReadable(d: unknown): string;
    toLocalSeconds(d: unknown): string;

    // calendar engine
    getPlantForLine(line: string, lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData): string | null;
    /** Weekly hours in force on a date key ('YYYY-MM-DD'): the earliest-starting period covering it, else the default (same reference). */
    activeWorkHours(defaultWorkHours: NimbusWorkHours, periods: NimbusPlantPeriod[] | undefined | null, dateKey: string): NimbusWorkHours;
    /** The plant's weekly hours on a calendar date (period-aware); an undefined entry gives undefined. */
    plantWorkHoursOn(plantEntry: NimbusPlantCalendarEntry | undefined, date: unknown): NimbusWorkHours | undefined;
    /** Sorted day keys D with fromKey < D <= toKey where the active pattern can change. */
    periodBoundaryKeys(periods: NimbusPlantPeriod[] | undefined | null, fromKey: string, toKey: string): string[];
    /** Server-rule validation: inclusive overlap, null validTo open-ended, duplicate/missing id invalid. */
    validatePlantPeriods(periods: NimbusPlantPeriod[] | undefined | null): NimbusPeriodValidation;
    /** Per weekday: null only if the default and every period are closed; else [min start, max end]. */
    unionWeeklyHours(defaultWorkHours: NimbusWorkHours, periods: NimbusPlantPeriod[] | undefined | null): NimbusWorkHours;
    _dayWindow(workHours: NimbusWorkHours, date: unknown): [Date, Date] | null;
    _nextCalendarDay(d: Date): Date;
    /** Previous local calendar midnight (calendar-date arithmetic, never minus 24 h): the backward twin of `_nextCalendarDay`. */
    prevCalendarDay(d: Date): Date;
    /** Project an absolute instant into the naive wall-clock Date convention of the plant zone.
     *  No timezone returns a copy of the instant; an invalid zone returns null. */
    plantWallClockFromInstant(timezone: string | null | undefined, instant: Date): Date | null;
    /** Inverse of `plantWallClockFromInstant`: read a naive wall-clock Date as plant-zone wall time and
     *  return the absolute instant (gap resolves after it, fall-back hour to the earlier occurrence).
     *  No timezone returns a copy of the Date; an invalid zone returns null. */
    plantInstantFromWallClock(timezone: string | null | undefined, wall: Date): Date | null;
    workWindow(
      line: string, date: unknown,
      calendars: Record<string, NimbusCalendarEntry>, plants: Record<string, NimbusPlantCalendarEntry>,
      lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData
    ): [Date, Date] | null;
    /** A date-only SAP finish arrives as an exact-midnight Date; read it as the end of that date's
     *  working window. Timed values pass through; a closed date resolves to the previous open
     *  date's close (30-day look-back), no window at all gives raw + 23:59:59. */
    dueDateInstant(raw: Date, dayWindowFor: (date: Date) => { open: Date; close: Date } | null): Date;
    /** THE day-attribution rule: minutes of an order's work per calendar day (key = dayKey). A split order is
     *  exact by piece; a single bar spreads its run time over the days it spans in proportion to each day's
     *  working-window overlap (no working overlap at all falls back to wall-clock overlap); a start with no
     *  finish puts everything on the start day. The matrix, the overload alert and the cell briefing share it. */
    workingMinutesByDay(task: NimbusTask, dayWindowFor: ((date: Date) => { open: Date; close: Date } | null) | null | undefined): Record<string, number>;
    _indexCapacityBlocks(blocks: NimbusBlock[], plantBlocks: NimbusPlantBlock[]): unknown;
    dailyCapacityHours(
      line: string, date: unknown,
      calendars: Record<string, NimbusCalendarEntry>, plants: Record<string, NimbusPlantCalendarEntry>,
      lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData,
      blocks: NimbusBlock[], plantBlocks: NimbusPlantBlock[], idx?: unknown
    ): number;
    effectiveFromCapacity(line: string, full: number, lineSettings: Record<string, NimbusLineSetting>): number;

    // top-level compute
    computeAlerts(payload: ComputeAlertsPayload): { alerts: NimbusAlert[]; elapsed: number };
    computeUtilization(payload: ComputeUtilizationPayload): { matrix: NimbusUtilizationMatrix };
    /** One alerts pass per variant on a shared base, each with that variant's hypothetical setup observation
     *  (the leverage what-if replay). Returns alerts only; calendars/plants are shallow-copied per call. */
    computeLeverageBatch(
      base: ComputeAlertsPayload & { startMs?: number; days?: number; lines?: string[] },
      variants: ReadonlyArray<{ key: string; setup: NimbusSetupObservation }>
    ): Array<{ key: string; alerts: NimbusAlert[] }>;

    // confidence scoring (shared by the badge and the Alert Monitor)
    /** Days-out multiplier: <=3 days 1.5, <=7 days 1.25, else 1.0. */
    timeWeight(time: Date | null | undefined, horizonStart: Date): number;
    /** Uncapped impact points of one alert; 0 outside [horizonStart, horizonEnd) or without a time. */
    alertPoints(alert: { sev: string; time?: Date | null; due?: Date | null }, horizonStart: Date, horizonEnd: Date): number;
    confidenceFromRaw(raw: number, machines?: number): number;
    scoreConfidence(input: NimbusConfidenceInput): NimbusConfidenceResult;
  }

  var NimbusComputeCore: NimbusComputeCoreApi | undefined;
}
