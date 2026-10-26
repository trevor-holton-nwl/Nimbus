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
    taskId?: string;
    /** The other order in a pairwise alert (overlap, tool-conflict). Prefer this over parsing `id`. */
    peerId?: string;
    /** Setup diagnostics only: the from->to state pair and the plant/line scope (null when absent). */
    pairKey?: string | null;
    scope?: string | null;
    line: string;
    time: Date;
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

  interface NimbusMasterData {
    lines?: NimbusMasterDataLine[];
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
    err: number; warn: number; tw3: number; tw7: number; alertCap: number; utilCap: number; perOverload: number;
  }

  interface NimbusConfidenceInput {
    alerts: Array<Pick<NimbusAlert, 'sev'> & { time?: Date | null }>;
    /** Utilization matrix; used to count overloaded line-days when `overloadedLineDays` is not given. */
    matrix?: NimbusUtilizationMatrix | null;
    overloadedLineDays?: number;
    horizonStart: Date;
    horizonMinutes: number;
  }

  interface NimbusConfidenceResult {
    score: number;
    alertPenalty: number;
    utilPenalty: number;
    /** Unrounded, uncapped sum of alert points. */
    rawAlertPoints: number;
    overloadedLineDays: number;
  }

  interface NimbusComputeCoreApi {
    // constants
    CONFIDENCE_WEIGHTS: Readonly<NimbusConfidenceWeights>;
    MS_DAY: number;
    MS_HOUR: number;
    OVERLOAD_THRESHOLD: number;
    WARN_THRESHOLD: number;
    SHOW_NEAR_CAPACITY_ALERTS: boolean;
    DEFAULT_SHIFT: [number, number];
    WEEKEND_OFF: boolean;

    // date/time helpers
    parseDate(v: unknown): Date | null;
    dayKey(d: unknown): string;
    startOfDay(d: unknown): Date | null;
    separationBucketKey(d: unknown, scope: 'none' | 'hour' | 'day' | 'week'): string | null;
    runHours(task: NimbusTask): number;
    scheduleIntervals(task: NimbusTask): Array<{ sequence: number; start: Date; end: Date }>;
    setupIntervals(setup?: NimbusSetupObservation): NimbusSetupInterval[];
    mergedOverlapHours(win: [Date | number, Date | number] | null, intervals: Array<{ s: Date | number; e: Date | number }>): number;
    fmtDTReadable(d: unknown): string;
    toLocalSeconds(d: unknown): string;
    toLocalInput(d: unknown): string;

    // calendar engine
    getPlantForLine(line: string, lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData): string | null;
    ensureCalendar(line: string, calendars: Record<string, NimbusCalendarEntry>, allDay?: boolean): void;
    ensurePlant(name: string | null, plants: Record<string, NimbusPlantCalendarEntry>): void;
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

    // confidence scoring (shared by the badge and the Alert Monitor)
    /** Days-out multiplier: <=3 days 1.5, <=7 days 1.25, else 1.0. */
    timeWeight(time: Date | null | undefined, horizonStart: Date): number;
    /** Uncapped impact points of one alert; 0 outside [horizonStart, horizonEnd) or without a time. */
    alertPoints(alert: { sev: string; time?: Date | null }, horizonStart: Date, horizonEnd: Date): number;
    countOverloadedLineDays(matrix: NimbusUtilizationMatrix | null | undefined): number;
    scoreConfidence(input: NimbusConfidenceInput): NimbusConfidenceResult;
  }

  var NimbusComputeCore: NimbusComputeCoreApi | undefined;
}
