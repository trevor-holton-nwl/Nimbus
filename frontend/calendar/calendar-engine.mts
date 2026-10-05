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
import type { WorkHours, SplitOrderPolicy } from '../platform/types.mjs';

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
  _runCache: null as { ww: Map<string, [Date, Date] | null> } | null,
  // Pre-parsed blackout blocks scoped to the plant being optimized.
  // { byLine: Map<line|'__any__', BlockRec[]>, byPlant: Map<plant|'__any__', BlockRec[]> }
  // where BlockRec = { s: ms, e: ms, startDate: Date, endDate: Date }.
  _runBlocks: null as RunBlocksIndex | null,

  /** Install per-run caches. Called once at the top of Engine.runAndApply. */
  _beginRun(plant: string | null): void {
    Calendar._runCache  = { ww: new Map() };
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
  hasNominalWindow(line: string, from: Date, durationMs: number): boolean {
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    for (let day = 0; day < 90; day++) {
      const win = Calendar.workWindow(line, cur);
      if (win && win[1].getTime() - win[0].getTime() >= durationMs) return true;
      cur.setDate(cur.getDate() + 1);
    }
    return false;
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
      const end = new Date(cur.getTime() + durationMs);
      if (end > win[1]) {
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
  findContiguousSlot(line: string, from: Date, durationMs: number): BacklogSlot {
    const operatingStart = Calendar.nextOperatingInstant(line, from);
    if (!operatingStart) return { kind: 'unavailable' };
    if (!Calendar.hasNominalWindow(line, from, durationMs)) return { kind: 'overlong', start: operatingStart };
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
                  policy: SplitOrderPolicy = 'never'): RuntimeAllocation {
    const totalMinutes = Math.round(Number(runtimeMinutes));
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return { kind: 'exhausted' };
    const durationMs = totalMinutes * Config.MS_MIN;
    const from = Calendar._ceilMinute(new Date(earliestStart));
    const normalizedPolicy: SplitOrderPolicy =
      policy === 'overlong_only' || policy === 'partial_allowed' ? policy : 'never';

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
      && !Calendar.hasNominalWindow(line, request.earliestStart, durationMs);
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
