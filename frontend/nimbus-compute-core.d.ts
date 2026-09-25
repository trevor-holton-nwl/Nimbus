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
      | 'runtime-unknown' | 'pv-lot-size';
    msg: string;
    /** Optional localized form; the drawer prefers Util.t(msgKey, msgVars) when present. */
    msgKey?: string;
    msgVars?: Record<string, string>;
    taskId?: string;
    /** The other order in a pairwise alert (overlap, tool-conflict). Prefer this over parsing `id`. */
    peerId?: string;
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
    RUN_TIME?: number | string;
    start_date?: Date | null;
    end_date?: Date | null;
    firmed?: boolean; // manual firm mirror
    runtime_schedule_mismatch?: boolean;
    planning_status?: string;
    /** {code, step, message} per ROUTING_RUNTIME_DESIGN.md §4 item 2; message is
     *  already i18n'd server-side. */
    planning_reason?: { code?: string; step?: string; message?: string } | null;
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
  }

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
    plants: Record<string, NimbusCalendarEntry>;
    lineSettings: Record<string, NimbusLineSetting>;
    masterData: NimbusMasterData;
    dismissed: string[];
    opts?: { lines?: string[] | null };
    setup?: NimbusSetupObservation;
  }

  interface ComputeUtilizationPayload {
    tasks: NimbusTask[];
    lineSettings: Record<string, NimbusLineSetting>;
    calendars: Record<string, NimbusCalendarEntry>;
    plants: Record<string, NimbusCalendarEntry>;
    blocks: NimbusBlock[];
    plantBlocks: NimbusPlantBlock[];
    masterData: NimbusMasterData;
    startMs: number;
    days: number;
    lines?: string[];
    setup?: NimbusSetupObservation;
  }

  interface NimbusComputeCoreApi {
    // constants
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
    ensureCalendar(line: string, calendars: Record<string, NimbusCalendarEntry>): void;
    ensurePlant(name: string | null, plants: Record<string, NimbusCalendarEntry>): void;
    _dayWindow(workHours: NimbusWorkHours, date: unknown): [Date, Date] | null;
    workWindow(
      line: string, date: unknown,
      calendars: Record<string, NimbusCalendarEntry>, plants: Record<string, NimbusCalendarEntry>,
      lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData
    ): [Date, Date] | null;
    _indexCapacityBlocks(blocks: NimbusBlock[], plantBlocks: NimbusPlantBlock[]): unknown;
    dailyCapacityHours(
      line: string, date: unknown,
      calendars: Record<string, NimbusCalendarEntry>, plants: Record<string, NimbusCalendarEntry>,
      lineSettings: Record<string, NimbusLineSetting>, masterData: NimbusMasterData,
      blocks: NimbusBlock[], plantBlocks: NimbusPlantBlock[], idx?: unknown
    ): number;
    effectiveFromCapacity(line: string, full: number, lineSettings: Record<string, NimbusLineSetting>): number;

    // top-level compute
    computeAlerts(payload: ComputeAlertsPayload): { alerts: NimbusAlert[]; elapsed: number };
    computeUtilization(payload: ComputeUtilizationPayload): { matrix: NimbusUtilizationMatrix };
  }

  var NimbusComputeCore: NimbusComputeCoreApi | undefined;
}
