// calendar/calendar-engine.mjs — Calendar (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-services.mts
// (3,544 lines) into 4 domain files). Owns capacity math only (working hours,
// blackout-block availability). All functions operate on a `line` (string) +
// Date objects. The blackout-block-TAB UI (render/openBlockModal/
// saveBlockFromModal/etc.) stayed behind in app.js as `CalendarUI`.
//
// `Engine`/`sourceBlocks`/`sourcePlantBlocks`/`sourceGetPlantForLine`/
// `sourceLineWorkHours`/`sourcePlantWorkHours`/`reportSchedulerDiagnostic`
// (optimization/engine.mjs) are real cross-file imports forming a two-way
// ESM cycle with that module (see optimization/engine.mjs's header comment
// for the full mechanics — this dependency predates this phase, as a
// sibling-top-level-const forward-reference inside the single
// schedule-services.mts file). Every function below that used to call
// `Store.*` directly now calls the matching `source*` accessor instead, so
// Calendar's capacity math keeps answering correctly against a detached
// candidate snapshot when Engine has one installed — this is NOT a new
// coupling, only a new file boundary across an existing one. Safe under the
// same rule as every cycle in this split: every cross-reference is inside a
// method body invoked after both modules finish loading, never at top-level
// evaluation.
//
// `placeWithSetupPure`/`PlaceWithSetupRequest`/`PlacementResult`/
// `RuntimeAllocation` are imported from optimization/engine.mjs (re-exports
// of what that file itself imports from optimization/setup-scheduler.mjs) —
// see optimization/engine.mjs's header comment for why they're routed
// through that existing cycle edge rather than opening a second one directly
// against optimization/setup-scheduler.mjs.
import { Config, Util } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import {
  Engine,
  placeWithSetupPure,
  sourceBlocks,
  sourcePlantBlocks,
  sourceGetPlantForLine,
  sourceLineWorkHours,
  sourcePlantWorkHours,
  reportSchedulerDiagnostic,
} from '../optimization/engine.mjs';
import type { PlaceWithSetupRequest, PlacementResult, RuntimeAllocation } from '../optimization/engine.mjs';
import type { WorkHours, SplitOrderPolicy, OrderScheduleSegment } from '../platform/types.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
// Note: unlike optimization/engine.mts, insights/services.mts, and
// platform/store.mjs, this file does NOT declare its own local `CalendarEntry`
// — Calendar's own code never referenced that type directly in the original
// schedule-services.mts (verified against git history before this split), so
// carrying a duplicate here would be dead code, not parity with those files.
interface BlockRec {
  s: number;
  e: number;
  startDate: Date;
  endDate: Date;
}

interface RunBlocksIndex {
  byLine: Map<string, BlockRec[]>;
  byPlant: Map<string, BlockRec[]>;
}

interface CapRec {
  s: Date;
  e: Date;
  plant: string | null;
}

interface PlantCapRec {
  s: Date;
  e: Date;
}

interface CapacityBlockIndex {
  lineBlocks: Map<string, CapRec[]>;
  globalLine: CapRec[];
  plantBlocks: Map<string, PlantCapRec[]>;
  globalPlant: PlantCapRec[];
}

type BacklogSlot =
  | { kind: 'slot'; start: Date }
  | { kind: 'overlong'; start: Date }
  | { kind: 'unavailable' | 'exhausted' };

/** One schedule piece of a placed order (the same shape the forward allocator returns). */
export type ScheduleSegmentLike = OrderScheduleSegment;

/** Result of a finish-anchored (backward) placement. `placed` carries the new start/end as naive
 * wall-clock Dates; `end` is the finish actually achieved, which differs from the requested finish
 * exactly when `finishMoved` is true. `reached_now` means the walk hit `floor` before placing every
 * minute (the caller reverses forward from now); `overlong` means a contiguous policy and a run
 * time longer than the longest merged window; `unavailable` means no operating window at all
 * inside the lookback (or an unusable run time / timezone). */
export type BackwardResult =
  | { kind: 'placed'; start: Date; end: Date; scheduleSegments: ScheduleSegmentLike[];
      finishMoved: boolean; moveReason?: 'closed_finish' | 'no_slot_at_finish' | 'min_piece' | 'blackout' }
  | { kind: 'reached_now' }
  | { kind: 'overlong' }
  | { kind: 'unavailable' }
  /** No open time inside BACKWARD_MAX_DAYS before the finish; the caller must not reverse from now (VI17). */
  | { kind: 'lookback_exhausted' };

/** Lookup options shared by the backward primitives. `floor` is the earliest minute the walk may use
 * (normally the plant's "now"); `plantTz`, when given, makes all elapsed arithmetic run on plant-zone
 * instants while inputs and results stay naive wall-clock Dates (OQ46). */
export interface BackwardLookupOptions {
  floor?: Date | null;
  plantTz?: string | null;
  lookbackDays?: number;
}

export interface BackwardAllocationOptions extends BackwardLookupOptions {
  floor: Date;
  minSegmentMinutes: number;
  plantTz: string | null;
  /** Minutes of changeover that must sit immediately before the earliest productive piece, inside the same
   *  operating fragment (OQ2 V1). Absent, zero or invalid means none. It only decides where the earliest piece
   *  may start; it never changes the run time or the finish. */
  setupMinutes?: number;
}

interface MsSpan { s: number; e: number }

/** One line's nominal (blackout-free) operating spans over a padded date range, held for a whole run so every order on
 * the line shares the pass (U17). Each span carries its plant-zone instants so a request only converts clipped ends. */
interface NominalEntry {
  lo: Date;
  hi: Date;
  items: Array<{ start: Date; end: Date; s: number; e: number }>;
}
/** Days of padding either side of the first request when a nominal entry is built (the walk caps at 400 days). */
const NOMINAL_PAD_DAYS = 90;

type BackwardFrame =
  | { kind: 'unavailable' }
  | {
    kind: 'ok';
    /** The requested finish (minute-floored) as an instant. */
    finishMs: number;
    /** Free intervals (instants, chronological, touching ones merged), right-clipped at the finish, left-bounded by the floor. */
    spans: MsSpan[];
    /** Longest nominal (blackout-free) merged operating window inside the lookback, in ms. */
    longestMs: number;
    /** Why a finish that is earlier than requested was clamped: the working day itself, or a blackout inside an open window. */
    clampReason: 'closed_finish' | 'blackout';
    /** True when the look-back start (not the caller's floor) bounded the free-interval walk (VI17). */
    boundedByLookback: boolean;
    toWall: (ms: number) => Date | null;
  };

/** Default look-back for a backward walk, measured from the finish (the forward walk's 90-day bound mirrored). */
const BACKWARD_LOOKBACK_DAYS = 90;
/** Hard cap on the days a single _freeIntervalsBackward call walks, whatever floor it is given. */
const BACKWARD_MAX_DAYS = 400;

/** B6: exported so setup-scheduler.mts's freeIntervalsFor can fall back to the
 * same default work hours as the alerts path (optimization/engine.mjs's
 * setupDefaultWorkHours) and the detached-candidate path
 * (sourceLineWorkHours/sourcePlantWorkHours in optimization/engine.mjs),
 * instead of returning [] and silently placing nothing for a whole
 * plant/line missing a calendar. */
export function candidateDefaultWorkHours(): WorkHours {
  const workHours: WorkHours = {};
  for (let day = 0; day < 7; day++) {
    workHours[day] = Config.WEEKEND_OFF && (day === 0 || day === 6)
      ? null
      : [Config.DEFAULT_SHIFT[0], Config.DEFAULT_SHIFT[1]];
  }
  return workHours;
}

/** Senior review I9 (OQ47): the ONE definition of a contiguous operating span. Appends `span` (chronological) to
 * `out`, merging it into the tail when it touches or overlaps it, and returns the resulting tail. The backward
 * walk, the forward `hasNominalWindow` and the optimizer's overlong predicate all measure spans through this, so
 * a 24/7 line or a night shift crossing midnight is one span on every path. */
export function pushMergedSpan(out: Array<{ s: number; e: number }>, span: { s: number; e: number }): { s: number; e: number } {
  const prior = out[out.length - 1];
  if (prior && span.s <= prior.e) {
    if (span.e > prior.e) prior.e = span.e;
    return prior;
  }
  const fresh = { s: span.s, e: span.e };
  out.push(fresh);
  return fresh;
}

/** True when some merged contiguous span of the chronological `windows` (ms pairs, null = closed day) is at least
 * `durationMs` long (equal counts). Stops at the first span that is long enough. */
export function fitsMergedSpan(windows: Iterable<{ s: number; e: number } | null>, durationMs: number): boolean {
  const merged: Array<{ s: number; e: number }> = [];
  for (const win of windows) {
    if (!win || !(win.e > win.s)) continue;
    const tail = pushMergedSpan(merged, win);
    if (tail.e - tail.s >= durationMs) return true;
  }
  return false;
}

/* =============================================================================
   CALENDAR — capacity math only (working hours, blackout-block availability).
   All functions operate on a `line` (string) + Date objects. The blackout-
   block-TAB UI (render/openBlockModal/saveBlockFromModal/etc.) stayed behind
   in app.js as `CalendarUI` — see CalendarUI there for the UI half.
   ========================================================================== */
/** (line|durationMs) pairs already warned about by Calendar.nextAvailable (bounded). */
const _noWindowWarned = new Set<string>();

export const Calendar = {
  /* ---------- Per-run caches (installed by Engine.runAndApply) ----------- */
  // workWindow memoization, keyed by `${line}|${startOfDayMs}`. Values are
  // `null` (closed day) or the same [Date, Date] tuple returned to every
  // caller during one run — callers must NOT mutate window endpoints.
  _runCache: null as { ww: Map<string, [Date, Date] | null>; nominal: Map<string, NominalEntry> } | null,
  // Pre-parsed blackout blocks scoped to the plant being optimized.
  // { byLine: Map<line|'__any__', BlockRec[]>, byPlant: Map<plant|'__any__', BlockRec[]> }
  // where BlockRec = { s: ms, e: ms, startDate: Date, endDate: Date }.
  _runBlocks: null as RunBlocksIndex | null,

  /** Install per-run caches. Called once at the top of Engine.runAndApply. */
  _beginRun(plant: string | null): void {
    Calendar._runCache  = { ww: new Map(), nominal: new Map() };
    Calendar._runBlocks = Calendar._indexBlocks(plant);
  },
  /** Tear down per-run caches. Called in a finally{} so it always runs. */
  _endRun(): void {
    Calendar._runCache  = null;
    Calendar._runBlocks = null;
  },
  /** Parse every blackout block once and bucket by line / plant for O(1) lookup. */
  _indexBlocks(plant: string | null): RunBlocksIndex {
    const byLine = new Map<string, BlockRec[]>();
    for (const b of sourceBlocks()) {
      // A block applies only within its own plant (line:null = all lines in that
      // plant). Un-stamped legacy blocks (no b.plant) fall back to global behavior.
      if (b.plant && plant && b.plant !== plant) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      const key = b.line || '__any__';
      let arr = byLine.get(key);
      if (!arr) { arr = []; byLine.set(key, arr); }
      arr.push({ s: s.getTime(), e: e.getTime(), startDate: s, endDate: e });
    }
    const byPlant = new Map<string, BlockRec[]>();
    for (const b of sourcePlantBlocks()) {
      if (b.plant && plant && b.plant !== plant) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      const key = b.plant || '__any__';
      let arr = byPlant.get(key);
      if (!arr) { arr = []; byPlant.set(key, arr); }
      arr.push({ s: s.getTime(), e: e.getTime(), startDate: s, endDate: e });
    }
    return { byLine, byPlant };
  },

  /** Returns [startDate, endDate] for a workHours map + date, or null if closed.
   *  Delegates to the shared compute core (single source of truth; handles the
   *  fractional-hour split so 08:30 isn't floored to 08:00). */
  _dayWindow(workHours: WorkHours, date: Date): [Date, Date] | null {
    return globalThis.NimbusComputeCore!._dayWindow(workHours, date);
  },

  /** Returns [startDate, endDate] for a line+day, intersected with plant hours.
   *  Returns null if either the line or plant is closed that day, or the
   *  intersection is empty. */
  workWindow(line: string, date: Date): [Date, Date] | null {
    const rc = Calendar._runCache;
    let key = '';
    if (rc) {
      const d = new Date(date); d.setHours(0, 0, 0, 0);
      key = line + '|' + d.getTime();
      if (rc.ww.has(key)) return rc.ww.get(key)!;
    }

    const lineWin = Calendar._dayWindow(sourceLineWorkHours(line), date);
    if (!lineWin) {
      if (rc) rc.ww.set(key, null);
      return null;
    }

    const plant = sourceGetPlantForLine(line);
    let result: [Date, Date];
    if (plant) {
      const plantWin = Calendar._dayWindow(sourcePlantWorkHours(plant), date);
      if (!plantWin) {
        if (rc) rc.ww.set(key, null);
        return null;
      }
      const s = new Date(Math.max(lineWin[0].getTime(), plantWin[0].getTime()));
      const e = new Date(Math.min(lineWin[1].getTime(), plantWin[1].getTime()));
      if (s >= e) {
        if (rc) rc.ww.set(key, null);
        return null;
      }
      result = [s, e];
    } else {
      result = lineWin;
    }

    if (rc) rc.ww.set(key, result);
    return result;
  },

  /** Total working hours in a day for a given line, after blackouts. Does not apply buffer.
   *  Uses interval union so overlapping (or accidentally duplicated) blackout
   *  blocks can never double-count and drive capacity negative. */
  /** Pre-parse + bucket all blackout blocks ONCE so a tight (line × day) loop can
   *  reuse the parsed Date objects instead of re-parsing every block per cell.
   *  Pass the returned index as the 3rd arg of dailyCapacityHours. Cheap to build
   *  (one parse pass over Store.blocks/plantBlocks); build it once per matrix call.
   *  Distinct from _indexBlocks(plant), which builds the Engine-run _runBlocks cache. */
  // Delegates to NimbusComputeCore (same pattern as _dayWindow/
  // effectiveFromCapacity below) instead of duplicating the bucketing math —
  // Core's own _indexCapacityBlocks(blocks, plantBlocks) returns the exact
  // same {lineBlocks, globalLine, plantBlocks, globalPlant} shape.
  _indexCapacityBlocks(): CapacityBlockIndex {
    return globalThis.NimbusComputeCore!._indexCapacityBlocks(Store.blocks, Store.plantBlocks) as CapacityBlockIndex;
  },

  // Delegates to NimbusComputeCore.dailyCapacityHours (same pattern as
  // _dayWindow/effectiveFromCapacity) instead of duplicating the union-
  // interval math a second time via Util.mergedOverlapHours — Core's version
  // takes its inputs as explicit params rather than reading Store directly,
  // so they're threaded through here. Deliberately reads Store.blocks/
  // Store.plantBlocks/Store.lineSettings/Store.masterData directly (not the
  // sourceBlocks()/sourcePlantBlocks()/sourceGetPlantForLine() candidate-
  // snapshot-aware accessors most other functions in this file use) — this
  // preserves this function's pre-existing behavior exactly; whether it
  // should also read through those accessors is a separate, un-investigated
  // question, not something this dedup pass changes.
  dailyCapacityHours(line: string, date: Date, idx?: CapacityBlockIndex): number {
    return globalThis.NimbusComputeCore!.dailyCapacityHours(
      line, date,
      Store.calendars as any, Store.plants as any, Store.lineSettings as any, Store.masterData as any,
      Store.blocks, Store.plantBlocks, idx,
    );
  },

  /** Maximum schedulable hours after deducting the capacity buffer.
   *  Nothing should be scheduled past this value (= total − buffer). */
  /** Apply a line's capacity buffer to an already-computed full-capacity value.
   *  The single source of truth for the buffer formula — callers that have already
   *  computed dailyCapacityHours (matrix cells, the alert overload loop) call this
   *  instead of effectiveCapacityHours so the full-capacity scan is not repeated.
   *  Delegates to the shared compute core. */
  effectiveFromCapacity(line: string, full: number): number {
    return globalThis.NimbusComputeCore!.effectiveFromCapacity(line, full, Store.lineSettings as any);
  },

  effectiveCapacityHours(line: string, date: Date): number {
    return Calendar.effectiveFromCapacity(line, Calendar.dailyCapacityHours(line, date));
  },

  /** Advances `from` forward until a contiguous block of `durationMs` is
   *  available on `line`. Returns the starting Date (snapped), or `null` when no
   *  slot exists: the line has no working window at all, the order is longer than
   *  the longest single working window (this helper never splits), or nothing fits
   *  within 90 days. Callers must handle null (it is never a "valid" start). */
  nextAvailable(line: string, from: Date, durationMs: number): Date | null {
    const step = Config.STEP_MS;
    const snapUp = (d: Date): Date => new Date(Math.ceil(d.getTime() / step) * step);
    let cur = Util.snap(new Date(from));
    const MAX_DAYS = 90;                   // explicit time bound from `from`
    const MAX_ITERS = MAX_DAYS * 24;       // and a hard cap on loop trips
    const limitMs = cur.getTime() + MAX_DAYS * Config.MS_DAY;
    // Nominal-window short-circuit: working windows repeat weekly, so probing seven
    // consecutive days gives the longest window this line can ever offer. No window,
    // or an order longer than every window, can never fit.
    let longestWindowMs = 0;
    for (let i = 0; i < 7; i++) {
      const probe = new Date(cur); probe.setDate(probe.getDate() + i);
      const w = Calendar.workWindow(line, probe);
      if (w) longestWindowMs = Math.max(longestWindowMs, w[1].getTime() - w[0].getTime());
    }
    if (longestWindowMs <= 0 || durationMs > longestWindowMs) {
      // The optimizer hot loop re-asks the same (line, duration) thousands of times; warn once.
      const warnKey = `${line}|${durationMs}`;
      if (!_noWindowWarned.has(warnKey)) {
        if (_noWindowWarned.size >= 500) _noWindowWarned.clear();
        _noWindowWarned.add(warnKey);
        reportSchedulerDiagnostic(
          'warn',
          'calendar',
          'calendar.next-available-no-window',
          `nextAvailable: no working window on line ${line} can hold ${durationMs}ms (longest nominal window ${longestWindowMs}ms)`,
        );
      }
      return null;
    }
    let iter = 0;

    while (iter++ < MAX_ITERS && cur.getTime() <= limitMs) {
      const win = Calendar.workWindow(line, cur);
      if (!win) {
        // jump to start of next day
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      if (cur >= win[1]) {
        // out of today's window — jump to tomorrow 00:00
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      const candidateEnd = new Date(cur.getTime() + durationMs);
      // Check that the whole range [cur, candidateEnd] fits in the window
      // and doesn't overlap any blackout block.
      if (candidateEnd > win[1]) {
        // Won't fit in today's window — jump to tomorrow
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      const conflict = Calendar._overlapsBlock(line, cur, candidateEnd);
      if (conflict) {
        // Round the blackout END UP to the grid: a nearest-snap of 10:05 lands on 10:00,
        // back inside the blackout, and the loop would never advance.
        cur = snapUp(new Date(conflict.end));
        continue;
      }
      return cur;
    }
    // Loop exhausted: no feasible slot found within 90 days. Log for diagnostics.
    const plant = sourceGetPlantForLine(line);
    reportSchedulerDiagnostic(
      'error',
      'calendar',
      'calendar.next-available-exhausted',
      `nextAvailable exhausted ${MAX_DAYS}-day bound (${MAX_ITERS} iterations) for line ${line} (plant ${plant}) seeking ${durationMs}ms slot from ${Util.fmtDTReadable(from)}`,
    );
    return null;
  },

  /** The contiguous twin of `nextAvailable`: the latest interval of `durationMs` that ends at or before
   *  `finish`, lies wholly inside one merged operating interval (touching windows merge across midnight,
   *  OQ47) and clears every blackout, bounded on the left by `opts.floor` and the look-back
   *  (`opts.lookbackDays`, default 90, measured back from the finish). Returns `{start, end}` as naive
   *  wall-clock Dates, or `null` when the line has no window, the duration is longer than the longest
   *  merged window, or nothing fits between the floor and the finish. Pure: no Store writes, no
   *  diagnostics. Never applies the minimum-piece rule and never snaps to the drag grid (a second snap
   *  would break start + run time = finish). */
  latestAvailable(line: string, finish: Date, durationMs: number, opts: BackwardLookupOptions = {}): { start: Date; end: Date } | null {
    const runMs = Math.round(Number(durationMs) / Config.MS_MIN) * Config.MS_MIN;
    if (!Number.isFinite(runMs) || runMs <= 0) return null;
    const frame = Calendar._backwardFrame(line, finish, opts);
    if (frame.kind !== 'ok' || runMs > frame.longestMs) return null;
    for (let i = frame.spans.length - 1; i >= 0; i--) {
      const span = frame.spans[i];
      if (span.e - span.s < runMs) continue;
      const start = frame.toWall(span.e - runMs), end = frame.toWall(span.e);
      return start && end ? { start, end } : null;
    }
    return null;
  },

  /** True when a proposed range is entirely inside one effective operating
   * interval and clear of both line and plant blackout blocks. */
  fitsContinuous(line: string, start: Date, durationMs: number): boolean {
    const win = Calendar.workWindow(line, start);
    const end = new Date(start.getTime() + durationMs);
    return !!win && start >= win[0] && end <= win[1] && !Calendar._overlapsBlock(line, start, end);
  },

  /** Find the first minute at or after `from` that is operating time. This is
   * intentionally weaker than `nextAvailable`: it is only used by the
   * documented continuous-bar exception for inherently overlong orders. */
  nextOperatingInstant(line: string, from: Date): Date | null {
    const startMs = from.getTime();
    const roundedMs = startMs % Config.MS_MIN ? startMs + Config.MS_MIN - (startMs % Config.MS_MIN) : startMs;
    let cur = new Date(roundedMs);
    const limit = new Date(cur);
    limit.setDate(limit.getDate() + 90);
    while (cur < limit) {
      const win = Calendar.workWindow(line, cur);
      if (!win || cur >= win[1]) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      const blackout = Calendar._overlapsBlock(line, cur, new Date(cur.getTime() + Config.MS_MIN));
      if (blackout) {
        const blackoutEnd = blackout.end.getTime();
        const nextMinute = blackoutEnd % Config.MS_MIN
          ? blackoutEnd + Config.MS_MIN - (blackoutEnd % Config.MS_MIN)
          : blackoutEnd;
        cur = new Date(nextMinute);
        continue;
      }
      return cur;
    }
    return null;
  },

  /** Is there any nominal (hours-only) plant/line intersection in the next
   * 90 calendar days large enough for this runtime? Dated blackouts are
   * intentionally ignored: they can exhaust normal placement, but do not make
   * a fundamentally fittable order "inherently overlong". */
  hasNominalWindow(line: string, from: Date, durationMs: number, plantTz: string | null = null): boolean {
    const first = new Date(from);
    first.setHours(0, 0, 0, 0);
    const core = globalThis.NimbusComputeCore!;
    // Windows that touch at midnight merge into one contiguous span (senior review I9, OQ47), the backward walk's rule.
    const windows = function* (): Generator<{ s: number; e: number } | null> {
      const cur = new Date(first);
      for (let day = 0; day < 90; day++) {
        const win = Calendar.workWindow(line, cur);
        if (!win) yield null;
        else if (plantTz) {
          // VM17: judge the window by real elapsed plant-zone time (a spring-forward day is one hour shorter).
          const a = core.plantInstantFromWallClock(plantTz, win[0]);
          const b = core.plantInstantFromWallClock(plantTz, win[1]);
          yield a && b && Number.isFinite(a.getTime()) && Number.isFinite(b.getTime()) ? { s: a.getTime(), e: b.getTime() } : null;
        } else yield { s: win[0].getTime(), e: win[1].getTime() };
        cur.setDate(cur.getDate() + 1);
      }
    };
    return fitsMergedSpan(windows(), durationMs);
  },

  /** Backlog must preserve minute-level candidates: the established
   * `nextAvailable` helper snaps to the application's coarser drag grid, which
   * could turn an 08:01 request into 08:00 and incorrectly fit it before shift
   * close. Keep that legacy behavior intact and use this exact-minute variant
   * only for the new heuristic. */
  _nextContiguousMinuteSlot(line: string, from: Date, durationMs: number): Date | null {
    const ceilMinute = (date: Date): Date => {
      const ms = date.getTime();
      const remainder = ms % Config.MS_MIN;
      return new Date(remainder ? ms + Config.MS_MIN - remainder : ms);
    };
    let cur = ceilMinute(new Date(from));
    const limit = new Date(cur);
    limit.setDate(limit.getDate() + 90);
    while (cur < limit) {
      const win = Calendar.workWindow(line, cur);
      if (!win || cur >= win[1]) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      // Senior review I9 (OQ47): windows that touch at midnight are one contiguous span, so the bar may run on
      // through the following days' windows for as long as each one opens exactly where the last one closed.
      let spanEnd = win[1];
      if (cur.getTime() + durationMs > spanEnd.getTime()) {
        const probe = new Date(cur);
        for (let hop = 0; hop < 90 && cur.getTime() + durationMs > spanEnd.getTime(); hop++) {
          probe.setDate(probe.getDate() + 1);
          probe.setHours(0, 0, 0, 0);
          const nextWin = Calendar.workWindow(line, probe);
          if (!nextWin || nextWin[0].getTime() !== spanEnd.getTime()) break;
          spanEnd = nextWin[1];
        }
      }
      const end = new Date(cur.getTime() + durationMs);
      if (end > spanEnd) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      const blackout = Calendar._overlapsBlock(line, cur, end);
      if (blackout) {
        cur = ceilMinute(new Date(blackout.end));
        continue;
      }
      return cur;
    }
    return null;
  },

  /** Backlog-specific placement contract. Unlike legacy `nextAvailable`, its
   * fallback is never accepted as a real ordinary slot. */
  findContiguousSlot(line: string, from: Date, durationMs: number, plantTz: string | null = null): BacklogSlot {
    const operatingStart = Calendar.nextOperatingInstant(line, from);
    if (!operatingStart) return { kind: 'unavailable' };
    if (!Calendar.hasNominalWindow(line, from, durationMs, plantTz)) return { kind: 'overlong', start: operatingStart };
    const start = Calendar._nextContiguousMinuteSlot(line, from, durationMs);
    return start ? { kind: 'slot', start } : { kind: 'exhausted' };
  },

  _ceilMinute(date: Date): Date {
    const ms = date.getTime();
    const remainder = ms % Config.MS_MIN;
    return new Date(remainder ? ms + Config.MS_MIN - remainder : ms);
  },

  _floorMinute(date: Date): Date {
    return new Date(date.getTime() - (date.getTime() % Config.MS_MIN));
  },

  /** All blackout intervals applicable to one concrete parent range, merged so
   * overlapping line/plant blocks never create a false productive gap. */
  _blockingIntervals(line: string, start: Date, end: Date): Array<{ start: Date; end: Date }> {
    const intervals: Array<{ start: Date; end: Date }> = [];
    const add = (s: Date, e: Date): void => {
      if (s < end && e > start) {
        intervals.push({
          start: new Date(Math.max(s.getTime(), start.getTime())),
          end: new Date(Math.min(e.getTime(), end.getTime())),
        });
      }
    };
    const cached = Calendar._runBlocks;
    if (cached) {
      for (const block of cached.byLine.get(line) || []) add(block.startDate, block.endDate);
      for (const block of cached.byLine.get('__any__') || []) add(block.startDate, block.endDate);
      const plant = sourceGetPlantForLine(line);
      if (plant) for (const block of cached.byPlant.get(plant) || []) add(block.startDate, block.endDate);
      for (const block of cached.byPlant.get('__any__') || []) add(block.startDate, block.endDate);
    } else {
      const plant = sourceGetPlantForLine(line);
      for (const block of sourceBlocks()) {
        if (block.plant && block.plant !== plant) continue;
        if (block.line && block.line !== line) continue;
        const s = Util.parseDate(block.start), e = Util.parseDate(block.end);
        if (s && e) add(s, e);
      }
      for (const block of sourcePlantBlocks()) {
        if (block.plant && block.plant !== plant) continue;
        const s = Util.parseDate(block.start), e = Util.parseDate(block.end);
        if (s && e) add(s, e);
      }
    }
    intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged: Array<{ start: Date; end: Date }> = [];
    for (const interval of intervals) {
      const prior = merged[merged.length - 1];
      if (prior && interval.start <= prior.end) {
        if (interval.end > prior.end) prior.end = interval.end;
      } else {
        merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
      }
    }
    return merged;
  },

  /** Enumerate effective operating fragments without mutating task or calendar
   * state. The 90-day cap is shared with the existing slot search. */
  _freeIntervals(line: string, from: Date): Array<{ start: Date; end: Date }> {
    const earliest = Calendar._ceilMinute(new Date(from));
    const day = new Date(earliest); day.setHours(0, 0, 0, 0);
    const out: Array<{ start: Date; end: Date }> = [];
    for (let offset = 0; offset < 90; offset++) {
      const date = new Date(day); date.setDate(day.getDate() + offset);
      const win = Calendar.workWindow(line, date);
      if (!win) continue;
      let cursor = Calendar._ceilMinute(new Date(Math.max(win[0].getTime(), earliest.getTime())));
      const windowEnd = Calendar._floorMinute(win[1]);
      if (cursor >= windowEnd) continue;
      for (const block of Calendar._blockingIntervals(line, cursor, windowEnd)) {
        const freeEnd = Calendar._floorMinute(block.start);
        if (freeEnd > cursor) out.push({ start: new Date(cursor), end: freeEnd });
        const next = Calendar._ceilMinute(block.end);
        if (next > cursor) cursor = next;
        if (cursor >= windowEnd) break;
      }
      if (cursor < windowEnd) out.push({ start: new Date(cursor), end: new Date(windowEnd) });
    }
    return out;
  },

  /** Operating fragments of `line` inside [lo, hi] as naive wall-clock Dates, chronological, with
   * touching fragments merged across midnight (OQ47). `withBlackouts` subtracts line and plant blackouts
   * (a blackout START rounds DOWN to the minute so the finish clears it, the END rounds up: the same
   * symmetric rounding as _freeIntervals); without it the spans are the nominal hours only. Days are
   * visited by calendar date (never minus 24 h). */
  _operatingSpansBackward(line: string, hi: Date, lo: Date, withBlackouts: boolean): Array<{ start: Date; end: Date }> {
    const hiMin = Calendar._floorMinute(hi);
    const loMin = Calendar._ceilMinute(lo);
    if (!(hiMin > loMin)) return [];
    const core = globalThis.NimbusComputeCore!;
    const loDay = new Date(loMin.getFullYear(), loMin.getMonth(), loMin.getDate());
    const chunks: Array<Array<{ start: Date; end: Date }>> = [];
    let day = new Date(hiMin.getFullYear(), hiMin.getMonth(), hiMin.getDate());
    for (let guard = 0; guard <= BACKWARD_MAX_DAYS + 3 && day >= loDay; guard++, day = core.prevCalendarDay(day)) {
      const win = Calendar.workWindow(line, day);
      if (!win) continue;
      let cursor = Calendar._ceilMinute(new Date(Math.max(win[0].getTime(), loMin.getTime())));
      const windowEnd = new Date(Math.min(Calendar._floorMinute(win[1]).getTime(), hiMin.getTime()));
      if (cursor >= windowEnd) continue;
      const dayOut: Array<{ start: Date; end: Date }> = [];
      if (withBlackouts) {
        for (const block of Calendar._blockingIntervals(line, cursor, windowEnd)) {
          const freeEnd = Calendar._floorMinute(block.start);
          if (freeEnd > cursor) dayOut.push({ start: new Date(cursor), end: freeEnd });
          const next = Calendar._ceilMinute(block.end);
          if (next > cursor) cursor = next;
          if (cursor >= windowEnd) break;
        }
      }
      if (cursor < windowEnd) dayOut.push({ start: new Date(cursor), end: windowEnd });
      if (dayOut.length) chunks.push(dayOut);
    }
    const out: Array<{ start: Date; end: Date }> = [];
    for (let i = chunks.length - 1; i >= 0; i--) {
      for (const span of chunks[i]) {
        const prior = out[out.length - 1];
        if (prior && prior.end.getTime() === span.start.getTime()) prior.end = span.end;
        else out.push({ start: new Date(span.start), end: new Date(span.end) });
      }
    }
    return out;
  },

  /** The backward twin of `_freeIntervals`: effective operating fragments, chronological, right-clipped at
   * `finish` (floored to the minute) and left-bounded by `floor`, with touching fragments merged across
   * midnight (OQ47). Naive wall-clock in, naive wall-clock out. The walk never goes more than 400 days
   * before the finish, whatever floor is passed. */
  _freeIntervalsBackward(line: string, finish: Date, floor: Date): Array<{ start: Date; end: Date }> {
    const hi = Calendar._floorMinute(finish);
    const cap = new Date(hi.getFullYear(), hi.getMonth(), hi.getDate() - BACKWARD_MAX_DAYS);
    const lo = floor.getTime() > cap.getTime() ? floor : cap;
    return Calendar._operatingSpansBackward(line, hi, lo, true);
  },

  /** Shared set-up of the backward primitives: the free intervals and the nominal-window facts, converted
   * to plant-zone instants when `opts.plantTz` is given (OQ46) so elapsed arithmetic is exact across a
   * DST change. `unavailable` when the line has no operating window inside the look-back before the
   * finish, or the zone / finish is unusable. */
  _backwardFrame(line: string, finish: Date, opts: BackwardLookupOptions): BackwardFrame {
    const core = globalThis.NimbusComputeCore!;
    const tz = opts.plantTz || null;
    const finishWall = Calendar._floorMinute(finish);
    if (!Number.isFinite(finishWall.getTime())) return { kind: 'unavailable' };
    const days = Number.isFinite(opts.lookbackDays) ? Math.max(0, Math.floor(opts.lookbackDays as number)) : BACKWARD_LOOKBACK_DAYS;
    const y = finishWall.getFullYear(), m = finishWall.getMonth(), d = finishWall.getDate();
    const lookbackStart = new Date(y, m, d - Math.min(days, BACKWARD_MAX_DAYS), finishWall.getHours(), finishWall.getMinutes());

    let failed = false;
    const toMs = (wall: Date): number => {
      const inst = tz ? core.plantInstantFromWallClock(tz, wall) : wall;
      if (!inst || !Number.isFinite(inst.getTime())) { failed = true; return NaN; }
      return inst.getTime();
    };
    const toSpans = (list: Array<{ start: Date; end: Date }>): MsSpan[] => {
      const out: MsSpan[] = [];
      for (const item of list) {
        pushMergedSpan(out, { s: toMs(item.start), e: toMs(item.end) });
      }
      return out;
    };

    // Nominal windows: blackouts ignored (a blackout never makes an order "inherently overlong"), and the
    // right edge pushed two calendar days past the finish so the window that holds the finish is measured whole.
    const nominalHi = new Date(y, m, d + 2);
    const rc = Calendar._runCache;
    let nominalAvailable: boolean;
    let nominal: MsSpan[];
    if (rc) {
      // Inside a run (_beginRun) the nominal pass is memoised per line: one padded walk serves every order on it.
      const key = line + '|' + (tz || '');
      let entry = rc.nominal.get(key);
      if (!entry || entry.lo > lookbackStart || entry.hi < nominalHi) {
        const lo = new Date(y, m, d - Math.min(days, BACKWARD_MAX_DAYS) - NOMINAL_PAD_DAYS, finishWall.getHours(), finishWall.getMinutes());
        const hi = new Date(y, m, d + 2 + NOMINAL_PAD_DAYS);
        const items = Calendar._operatingSpansBackward(line, hi, lo, false)
          .map(span => ({ start: span.start, end: span.end, s: toMs(span.start), e: toMs(span.end) }));
        entry = { lo, hi, items };
        if (!failed) rc.nominal.set(key, entry);
      }
      const wall: Array<{ start: Date; end: Date }> = [];
      nominal = [];
      for (const item of entry.items) {
        if (item.end <= lookbackStart || item.start >= nominalHi) continue;
        const clipStart = item.start < lookbackStart, clipEnd = item.end > nominalHi;
        const start = clipStart ? lookbackStart : item.start, end = clipEnd ? nominalHi : item.end;
        if (!(start < end)) continue;
        wall.push({ start, end });
        pushMergedSpan(nominal, { s: clipStart ? toMs(start) : item.s, e: clipEnd ? toMs(end) : item.e });
      }
      nominalAvailable = wall.some(span => span.start < finishWall);
    } else {
      const nominalWall = Calendar._operatingSpansBackward(line, nominalHi, lookbackStart, false);
      nominalAvailable = nominalWall.some(span => span.start < finishWall);
      nominal = nominalAvailable ? toSpans(nominalWall) : [];
    }
    if (!nominalAvailable) return { kind: 'unavailable' };
    const longestMs = nominal.reduce((max, span) => Math.max(max, span.e - span.s), 0);

    const bound = opts.floor && opts.floor.getTime() > lookbackStart.getTime() ? opts.floor : lookbackStart;
    const boundedByLookback = bound === lookbackStart;
    const spans = toSpans(Calendar._freeIntervalsBackward(line, finishWall, bound));
    const finishMs = toMs(finishWall);
    if (failed || !Number.isFinite(finishMs)) return { kind: 'unavailable' };

    // Why a finish that cannot be honoured as given moves: it is held by the working day itself (closed day,
    // at or before the window open, after the close) or by a blackout inside an open window.
    // Judged on the minute just BEFORE the finish (U18): at 00:00 on an open 24 h day the cause is the previous
    // day's window, not "closed at the finish".
    const before = new Date(finishWall.getTime() - Config.MS_MIN);
    const win = Calendar.workWindow(line, new Date(before.getFullYear(), before.getMonth(), before.getDate()));
    const clampReason: 'closed_finish' | 'blackout' =
      win && before >= win[0] && before < win[1] ? 'blackout' : 'closed_finish';
    return {
      kind: 'ok', finishMs, spans, longestMs, clampReason, boundedByLookback,
      toWall: ms => core.plantWallClockFromInstant(tz, new Date(ms)),
    };
  },

  _hasNominalOperatingWindow(line: string, from: Date): boolean {
    const day = new Date(from); day.setHours(0, 0, 0, 0);
    for (let offset = 0; offset < 90; offset++) {
      const date = new Date(day); date.setDate(day.getDate() + offset);
      const win = Calendar.workWindow(line, date);
      if (win && win[1] > win[0]) return true;
    }
    return false;
  },

  /** Allocate canonical runtime minutes under the selected plant policy. This
   * is deliberately task-store pure: callers receive a complete parent patch
   * or a bounded failure and decide when to mutate/preview/persist it. */
  allocateRuntime(line: string, earliestStart: Date, runtimeMinutes: number,
                  policy: SplitOrderPolicy = 'never', plantTz: string | null = null): RuntimeAllocation {
    const totalMinutes = Math.round(Number(runtimeMinutes));
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return { kind: 'exhausted' };
    const durationMs = totalMinutes * Config.MS_MIN;
    const from = Calendar._ceilMinute(new Date(earliestStart));
    const normalizedPolicy: SplitOrderPolicy =
      policy === 'overlong_only' || policy === 'partial_allowed' ? policy : 'never';
    // With a plant zone (the reversal's forward leg, OQ46) all elapsed arithmetic runs on plant-zone instants
    // like the backward walk, so a bar crossing the plant's DST change is the same length in both directions.
    if (plantTz) return Calendar._allocateForwardInPlantZone(line, from, totalMinutes, normalizedPolicy, plantTz);

    if (normalizedPolicy === 'never') {
      const slot = Calendar.findContiguousSlot(line, from, durationMs);
      if (!('start' in slot)) return { kind: slot.kind };
      return {
        kind: 'allocated', start: slot.start,
        end: new Date(slot.start.getTime() + durationMs), scheduleSegments: [],
      };
    }

    const inherentlyOverlong = !Calendar.hasNominalWindow(line, from, durationMs);
    if (normalizedPolicy === 'overlong_only' && !inherentlyOverlong) {
      const start = Calendar._nextContiguousMinuteSlot(line, from, durationMs);
      return start
        ? { kind: 'allocated', start, end: new Date(start.getTime() + durationMs), scheduleSegments: [] }
        : { kind: 'exhausted' };
    }
    if (!Calendar._hasNominalOperatingWindow(line, from)) return { kind: 'unavailable' };

    const minSegmentMinutes = Engine.minProductiveSegmentMinutesFor(sourceGetPlantForLine(line));
    const pieces: Array<{ start: Date; end: Date }> = [];
    let remaining = totalMinutes;
    for (const free of Calendar._freeIntervals(line, from)) {
      const capacity = Math.floor((free.end.getTime() - free.start.getTime()) / Config.MS_MIN);
      if (capacity <= 0) continue;
      let take = Math.min(remaining, capacity);
      if (remaining > take && remaining - take < minSegmentMinutes) {
        take = remaining - minSegmentMinutes;
      }
      // A partial piece must never be smaller than the plant's configured (or
      // default 30-minute) floor. Skip a tiny fragment and continue the
      // bounded search for a usable one.
      if (take < minSegmentMinutes
          && !(pieces.length === 0 && remaining === totalMinutes
               && totalMinutes < minSegmentMinutes && take === totalMinutes)) {
        continue;
      }
      const end = new Date(free.start.getTime() + take * Config.MS_MIN);
      pieces.push({ start: new Date(free.start), end });
      remaining -= take;
      if (remaining === 0) break;
    }
    if (remaining !== 0 || !pieces.length) return { kind: 'exhausted' };

    const merged: Array<{ start: Date; end: Date }> = [];
    for (const piece of pieces) {
      const prior = merged[merged.length - 1];
      if (prior && prior.end.getTime() === piece.start.getTime()) prior.end = piece.end;
      else merged.push({ start: new Date(piece.start), end: new Date(piece.end) });
    }
    const start = merged[0].start;
    const end = merged[merged.length - 1].end;
    return {
      kind: 'allocated', start, end,
      scheduleSegments: merged.length >= 2
        ? merged.map((piece, index) => ({ sequence: index + 1, startDate: piece.start, endDate: piece.end }))
        : [],
    };
  },

  /** The plant-zone twin of the forward allocator (U16): the same free intervals and policy rules as
   * `allocateRuntime`, but run time is measured in elapsed plant-zone time (touching intervals merge across midnight,
   * OQ47, like the backward walk) and results come back as naive wall-clock Dates. */
  _allocateForwardInPlantZone(line: string, from: Date, totalMinutes: number, policy: SplitOrderPolicy,
                              plantTz: string): RuntimeAllocation {
    const core = globalThis.NimbusComputeCore!;
    let failed = false;
    const toMs = (wall: Date): number => {
      const inst = core.plantInstantFromWallClock(plantTz, wall);
      if (!inst || !Number.isFinite(inst.getTime())) { failed = true; return NaN; }
      return inst.getTime();
    };
    const toWall = (ms: number): Date | null => core.plantWallClockFromInstant(plantTz, new Date(ms));
    const spans: MsSpan[] = [];
    for (const free of Calendar._freeIntervals(line, from)) {
      const span = { s: toMs(free.start), e: toMs(free.end) };
      const prior = spans[spans.length - 1];
      if (prior && span.s <= prior.e) { if (span.e > prior.e) prior.e = span.e; } else spans.push(span);
    }
    if (failed) return { kind: 'unavailable' };
    if (!spans.length) return { kind: 'unavailable' };
    const runMs = totalMinutes * Config.MS_MIN;
    const done = (pieces: MsSpan[]): RuntimeAllocation => {
      const walls = pieces.map(piece => ({ start: toWall(piece.s), end: toWall(piece.e) }));
      if (walls.some(piece => !piece.start || !piece.end)) return { kind: 'unavailable' };
      const out = walls as Array<{ start: Date; end: Date }>;
      return {
        kind: 'allocated', start: out[0].start, end: out[out.length - 1].end,
        scheduleSegments: out.length >= 2
          ? out.map((piece, index) => ({ sequence: index + 1, startDate: piece.start, endDate: piece.end }))
          : [],
      };
    };
    const contiguous = policy === 'never'
      || (policy === 'overlong_only' && Calendar.hasNominalWindow(line, from, runMs, plantTz));
    if (contiguous) {
      const hit = spans.find(span => span.e - span.s >= runMs);
      return hit ? done([{ s: hit.s, e: hit.s + runMs }]) : { kind: 'exhausted' };
    }
    const minSegmentMinutes = Engine.minProductiveSegmentMinutesFor(sourceGetPlantForLine(line));
    const pieces: MsSpan[] = [];
    let remaining = totalMinutes;
    for (const free of spans) {
      const capacity = Math.floor((free.e - free.s) / Config.MS_MIN);
      if (capacity <= 0) continue;
      let take = Math.min(remaining, capacity);
      if (remaining > take && remaining - take < minSegmentMinutes) take = remaining - minSegmentMinutes;
      if (take < minSegmentMinutes
          && !(pieces.length === 0 && remaining === totalMinutes
               && totalMinutes < minSegmentMinutes && take === totalMinutes)) {
        continue;
      }
      pieces.push({ s: free.s, e: free.s + take * Config.MS_MIN });
      remaining -= take;
      if (remaining === 0) break;
    }
    if (remaining !== 0 || !pieces.length) return { kind: 'exhausted' };
    const merged: MsSpan[] = [];
    for (const piece of pieces) {
      const prior = merged[merged.length - 1];
      if (prior && prior.e === piece.s) prior.e = piece.e;
      else merged.push({ ...piece });
    }
    return done(merged);
  },

  /** Finish-anchored allocation: place `runtimeMinutes` of production so it ENDS at `finish`, walking
   * backward through the line's operating time. Pure (no Store writes, no diagnostics); the forward helpers
   * are untouched. A finish that cannot be honoured as given moves to the latest operating instant before
   * it and reports `finishMoved` with the reason: `closed_finish` (after close, on a closed day, at a
   * window's opening minute), `blackout` (inside one), `no_slot_at_finish` (a contiguous policy found no
   * merged window of the run time ending there, OQ13) or `min_piece` (the piece that would end at the
   * finish is below the minimum, OQ55). When several apply, the last one reached names the move.
   * `never` / `overlong_only` take the latest merged free interval of at least the run time; run time
   * above the longest merged nominal window is `overlong` (OQ50). `partial_allowed` fills fragments from
   * the latest backward, each piece anchored at its fragment's end, mirroring the forward minimum-piece
   * rule. Reaching `opts.floor` with minutes left is `reached_now` (the caller reverses forward); no
   * operating window at all inside the look-back is `unavailable`. Touching intervals merge across
   * midnight (OQ47). With `opts.plantTz` the elapsed arithmetic runs on plant-zone instants and results
   * are returned as naive wall-clock Dates (OQ46). */
  allocateRuntimeBackward(line: string, finish: Date, runtimeMinutes: number,
                          policy: SplitOrderPolicy, opts: BackwardAllocationOptions): BackwardResult {
    const first = Calendar._allocateRuntimeBackwardOnce(line, finish, runtimeMinutes, policy, opts);
    if (first !== 'retry') return first;
    // VI17: the 90-day look-back, not the plant's now, stopped the walk (a long shutdown before a far due date).
    // Look back the full BACKWARD_MAX_DAYS once; if that still finds nothing the order has no legal finish in
    // range and the caller reports it rather than reversing from now (OQ13/OQ55).
    const second = Calendar._allocateRuntimeBackwardOnce(line, finish, runtimeMinutes, policy,
      { ...opts, lookbackDays: BACKWARD_MAX_DAYS });
    return second === 'retry' ? { kind: 'lookback_exhausted' } : second;
  },

  /** One backward attempt; `'retry'` means the walk ran out at the look-back start rather than at the floor. */
  _allocateRuntimeBackwardOnce(line: string, finish: Date, runtimeMinutes: number,
                               policy: SplitOrderPolicy, opts: BackwardAllocationOptions): BackwardResult | 'retry' {
    const totalMinutes = Math.round(Number(runtimeMinutes));
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return { kind: 'unavailable' };
    const frame = Calendar._backwardFrame(line, finish, opts);
    if (frame.kind !== 'ok') return { kind: 'unavailable' };
    const splitting = policy === 'partial_allowed';
    const runMs = totalMinutes * Config.MS_MIN;
    if (!splitting && runMs > frame.longestMs) return { kind: 'overlong' };
    const { spans, finishMs } = frame;
    if (!spans.length) return frame.boundedByLookback ? 'retry' : { kind: 'reached_now' };
    const setupMs = Number.isFinite(opts.setupMinutes) && (opts.setupMinutes as number) > 0
      ? Math.round(opts.setupMinutes as number) * Config.MS_MIN : 0;
    const latestEnd = spans[spans.length - 1].e;   // the finish clamped to operating time

    const picked: MsSpan[] = [];   // latest first
    let moveReason: 'closed_finish' | 'no_slot_at_finish' | 'min_piece' | 'blackout' | undefined;
    if (!splitting) {
      for (let i = spans.length - 1; i >= 0; i--) {
        // OQ2 V1: the one window must hold the changeover right before the productive start as well.
        if (spans[i].e - spans[i].s >= runMs + setupMs) { picked.push({ s: spans[i].e - runMs, e: spans[i].e }); break; }
      }
      if (!picked.length) return frame.boundedByLookback ? 'retry' : { kind: 'reached_now' };
      if (picked[0].e !== latestEnd) moveReason = 'no_slot_at_finish';
    } else {
      const minSegment = Number.isFinite(opts.minSegmentMinutes) ? Math.max(0, Math.round(opts.minSegmentMinutes)) : 0;
      let remaining = totalMinutes;
      for (let i = spans.length - 1; i >= 0 && remaining > 0; i--) {
        const capacity = Math.floor((spans[i].e - spans[i].s) / Config.MS_MIN);
        if (capacity <= 0) continue;
        let take = Math.min(remaining, capacity);
        // OQ2 V1: the earliest piece also needs the changeover before it in this same fragment. When the
        // fragment cannot hold both, it is clipped to leave room for the changeover and the walk continues back.
        if (setupMs && take === remaining && take * Config.MS_MIN + setupMs > capacity * Config.MS_MIN) {
          take = capacity - Math.ceil(setupMs / Config.MS_MIN);
          if (take <= 0) continue;
        }
        // Leave at least a minimum piece for the fragments still to come.
        if (remaining > take && remaining - take < minSegment) take = remaining - minSegment;
        // A partial piece is never below the minimum (a whole order shorter than it is the one exception);
        // skip the fragment and keep walking back.
        if (take <= 0 || (take < minSegment
            && !(picked.length === 0 && remaining === totalMinutes && totalMinutes < minSegment && take === totalMinutes))) {
          continue;
        }
        picked.push({ s: spans[i].e - take * Config.MS_MIN, e: spans[i].e });
        remaining -= take;
      }
      if (remaining !== 0) return frame.boundedByLookback ? 'retry' : { kind: 'reached_now' };
      if (picked[0].e !== latestEnd) moveReason = 'min_piece';
    }
    if (!moveReason && latestEnd < finishMs) moveReason = frame.clampReason;

    const merged: MsSpan[] = [];
    for (let i = picked.length - 1; i >= 0; i--) {
      const prior = merged[merged.length - 1];
      if (prior && prior.e === picked[i].s) prior.e = picked[i].e;
      else merged.push({ s: picked[i].s, e: picked[i].e });
    }
    const walls = merged.map(piece => ({ start: frame.toWall(piece.s), end: frame.toWall(piece.e) }));
    if (walls.some(piece => !piece.start || !piece.end)) return { kind: 'unavailable' };
    const pieces = walls as Array<{ start: Date; end: Date }>;
    return {
      kind: 'placed',
      start: pieces[0].start,
      end: pieces[pieces.length - 1].end,
      scheduleSegments: pieces.length >= 2
        ? pieces.map((piece, index) => ({ sequence: index + 1, startDate: piece.start, endDate: piece.end }))
        : [],
      finishMoved: moveReason !== undefined,
      ...(moveReason ? { moveReason } : {}),
    };
  },

  /** Adapter for the pure setup-placement primitive. It gathers the same
   * effective operating fragments the existing allocator uses, including
   * line/plant hours and blackouts, but never reads setup state or mutates a
   * task. Setup-aware Engine activation remains intentionally deferred. */
  placeWithSetup(
    line: string,
    request: Omit<PlaceWithSetupRequest, 'freeIntervals' | 'isInherentlyOverlong'>,
  ): PlacementResult {
    const runtimeMinutes = Math.round(Number(request.runtimeMinutes));
    const durationMs = runtimeMinutes * Config.MS_MIN;
    const isInherentlyOverlong = Number.isFinite(runtimeMinutes) && runtimeMinutes > 0
      && !Calendar.hasNominalWindow(line, request.earliestStart, durationMs, null);
    return placeWithSetupPure({
      ...request,
      freeIntervals: Calendar._freeIntervals(line, request.earliestStart),
      isInherentlyOverlong,
    });
  },

  /** Find the first blackout block overlapping [start,end) on `line`, else null. */
  _overlapsBlock(line: string, start: Date, end: Date): { start: Date; end: Date } | null {
    const rb = Calendar._runBlocks;
    if (rb) {
      const startMs = start.getTime ? start.getTime() : +start;
      const endMs   = end.getTime   ? end.getTime()   : +end;
      const scanLine = rb.byLine.get(line);
      if (scanLine) {
        for (const b of scanLine) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const scanLineAny = rb.byLine.get('__any__');
      if (scanLineAny) {
        for (const b of scanLineAny) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const plant = sourceGetPlantForLine(line);
      const scanPlant = plant ? rb.byPlant.get(plant) : null;
      if (scanPlant) {
        for (const b of scanPlant) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const scanPlantAny = rb.byPlant.get('__any__');
      if (scanPlantAny) {
        for (const b of scanPlantAny) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      return null;
    }

    const plant = sourceGetPlantForLine(line);
    for (const b of sourceBlocks()) {
      if (b.plant && b.plant !== plant) continue;
      if (b.line && b.line !== line) continue;
      const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
      if (!bs || !be) continue;
      if (start < be && end > bs) return { start: bs, end: be };
    }
    for (const b of sourcePlantBlocks()) {
      if (b.plant && b.plant !== plant) continue;
      const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
      if (!bs || !be) continue;
      if (start < be && end > bs) return { start: bs, end: be };
    }
    return null;
  },
};
