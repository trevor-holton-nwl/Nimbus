/* =============================================================================
   ALERT SLOT MODAL — "◫ Move…" ("Move to an open machine") on a Needs Planning row of the Alert Monitor.

   Recommends a (production version, machine) pair and a finish for a queued order, then places and firms it.
   The static shell (#modal-alert-slot) lives in index.html; this module fills the body (#asl-body) and footer
   (#asl-foot) at runtime and opens/closes it through Modal.open/close (the central focus trap). Modal.confirm
   stacks on top of it (the Override dialog and Engine.confirmOvertimePlacement do the same).

   The picker (2026-10-29): a radiogroup of lean rows (name, micro-bar + free hours, status word, "Best fit" on the
   top fitting row) mirrors the hidden `select#asl-pair`, which stays the source of truth `place()` reads; a filter
   box appears above SLOT_FILTER_ABOVE candidates; one consequence line under the list and a collapsed-by-default
   day preview (strip, finish, numbers) are computed for the SELECTED candidate only. A calm lead replaces the reason
   line for `push_limit_unmet`, the one reason whose next step is another machine.

   Ranking (owner decision): the machine with the MOST FREE HOURS on the chosen day first, fits before
   non-fits. The day defaults to max(due day, plant today) (tomorrow when nothing is left today) and the
   planner can change it. Placing is finish-anchored: the finish is the end of the latest free gap that holds
   the order on the day's working window (else the window end, after a confirm that it may overlap other
   orders; a closed or blacked-out day is never handed to the engine, which refuses it: the dialog walks back
   up to SLOT_LOOKBACK_DAYS, never into the past, to the latest open window and confirms the move), the order
   is then firmed. Save stays explicit (dirty until Save; Undo works).

   The pure exports (ranking, finish walk-back, fingerprint, default day, option text) take their inputs as
   arguments and are Node-testable; the live reads of the classic-script globals (Table pair options, Timeline
   Go To, the signed-in check) go through `slotSeams` so tests need no browser.
   ========================================================================== */

import { Store, UndoStack } from '../platform/store.mjs';
import { Config, Util, Modal, Toast } from '../platform/foundation.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import { Session } from '../security/session.mjs';
import { Runtime, normPv } from '../routing/runtime-client.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Alerts, Utilization } from '../insights/services.mjs';
import { Engine } from '../optimization/engine.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { planningReasonText } from '../scheduling/planning-reason.mjs';
import { raiseToolInventory } from '../optimization/tool-queue-confirm.mjs';
import { fmtNum } from './alert-monitor-model.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

/** Tool Inventory: would placing `task` on `machine` so it ENDS at `finish` take a tool over its copies? Returns the first
 *  tool whose over-capacity cluster involves this order (it holds an unplaced order today, so any such cluster is new), else
 *  null. `orders` (default just `task`) lets a multi-order slot check EVERY order it places, each ending at `finish`; their
 *  plant resolves like order-tooling.mts (own PLANT, its line's plant, else the selected plant). A split order (two or more
 *  segments) occupies its tool for the ENVELOPE of its segments (the compute core's toolOccupancyInterval), so that width is
 *  used instead of the run time. Warn-only: Slot never refuses and never moves anything. Reads the compute core's shared
 *  functions, so it agrees with the Gantt alert. null when the inventory is not loaded or the core is unreachable. */
export function slotToolOverage(args: {
  task: NimbusTask; machine: string; finish: Date; needHours: number | null; plant: string; now?: Date | null;
  tasks?: ReadonlyArray<NimbusTask>; orders?: ReadonlyArray<NimbusTask>;
}): { tool: string; available: number } | null {
  const core = globalThis.NimbusComputeCore;
  const inventory = Store.masterData?.tool_inventory;
  if (!core || inventory === undefined) return null;
  const mine = args.orders?.length ? args.orders : [args.task];
  const mineIds = new Set(mine.map(order => String(order.id)));
  const plantOf = (t: NimbusTask): string => t.PLANT || Store.getPlantForLine(t.MACHINE || 'Unknown') || Store.selectedPlant || '';
  const items: Array<{ id: string; line: string; plant: string; tools: string[]; start: Date; end: Date }> = [];
  for (const other of args.tasks ?? Store.tasksArr) {
    if (mineIds.has(String(other.id)) || plantOf(other) !== args.plant) continue;
    const otherTools = core.taskToolIds(other);
    if (!otherTools.length) continue;
    const iv = core.toolOccupancyInterval(other);
    if (iv) items.push({ id: String(other.id), line: other.MACHINE || 'Unknown', plant: args.plant, tools: otherTools, start: iv.start, end: iv.end });
  }
  let added = false;
  for (const order of mine) {
    const tools = core.taskToolIds(order);
    if (!tools.length) continue;
    const envelope = (order.scheduleSegments?.length ?? 0) >= 2 ? core.toolOccupancyInterval(order) : null;
    const widthMs = envelope ? +envelope.end - +envelope.start
      : (order === args.task ? (args.needHours ?? Util.runHours(order)) : Util.runHours(order)) * Config.MS_HOUR;
    if (!(widthMs > 0)) continue;
    items.push({ id: String(order.id), line: args.machine, plant: args.plant, tools, start: new Date(args.finish.getTime() - widthMs), end: args.finish });
    added = true;
  }
  if (!added) return null;
  const capacity = core.buildToolCapacity({ tool_inventory: inventory });
  const hit = core.findToolOverages({ items, capacityFor: (p: string, tool: string) => core.availableCopies(capacity, p, tool), now: args.now ?? undefined })
    .find(c => mineIds.has(String(c.pusher)) || c.holders.some(h => mineIds.has(String(h.id))));
  return hit ? { tool: hit.tool, available: hit.available } : null;
}

/** How many calendar days a closed target day may walk back to find the latest open working window. */
export const SLOT_LOOKBACK_DAYS = 30;

/** One selectable (production version, machine) pair for the chosen day. */
export interface SlotCandidate {
  /** The option value: `pv|machine` on a routing plant, a bare machine elsewhere. */
  value: string;
  /** The padded production version, or null on a plant without routing (keep the order's own). */
  pv: string | null;
  machine: string;
  /** The pair as the Orders grid names it (`ui.pv_machine_option`, or the machine name). */
  label: string;
  /** Run time this pair needs, in hours; null when it does not resolve or the order has no run time. */
  needHours: number | null;
  /** Why the pair does not resolve (routing step), when it does not. */
  resolveStep?: string;
  /** Free hours that day (effective capacity minus scheduled, setup included); null when unreadable. */
  freeHours: number | null;
  capHours: number | null;
  /** The machine has no capacity that day. */
  closed: boolean;
  /** Open that day, the need is known and fits in the free hours. */
  fits: boolean;
}

/** The reads the ranking and the placement need, injected so the logic is pure. */
export interface SlotDeps {
  pairOptions(task: NimbusTask): Array<{ value: string; label: string }>;
  hoursFor(task: NimbusTask, pv: string | null, machine: string): number | null;
  dayCapacity(machine: string, day: string): { free: number; cap: number; closed: boolean } | null;
  resolveStep?(task: NimbusTask, pv: string | null, machine: string): string | undefined;
  /** The placed bars on `machine` that touch `day` (YYYY-MM-DD), as `[start, end]` pairs; the gap search keeps a
   *  "fitting" slot off them. */
  busyIntervals?(machine: string, day: string): Array<[Date, Date]>;
}

/** Split an option value at the FIRST `|`: `pv|machine` gives both (the PV in its padded form), a bare machine
 *  (non-routing plants) gives `pv: null`, meaning "keep the order's own production version". Same rule as
 *  `Table._parsePairValue` (orders.mts), kept here so the dialog needs no Orders-grid edge. */
export function parsePairValue(value: string): { pv: string | null; machine: string } {
  const i = value.indexOf('|');
  return i < 0 ? { pv: null, machine: value } : { pv: normPv(value.slice(0, i)) ?? '', machine: value.slice(i + 1) };
}

const _cmpNullLast = (a: number | null, b: number | null, desc: boolean): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return desc ? b - a : a - b;
};

/** Every eligible pair for `day`, best first: fits before non-fits, then free hours descending (unknown last),
 *  then need ascending (unknown last), then machine and production version ascending. */
export function rankSlotCandidates(task: NimbusTask, day: string, deps: SlotDeps): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  for (const opt of deps.pairOptions(task)) {
    const { pv, machine } = parsePairValue(opt.value);
    const need = deps.hoursFor(task, pv, machine);
    const needHours = typeof need === 'number' && Number.isFinite(need) && need > 0 ? need : null;
    const cap = deps.dayCapacity(machine, day);
    const freeHours = cap ? cap.free : null;
    const closed = !!cap?.closed;
    const step = needHours === null ? deps.resolveStep?.(task, pv, machine) : undefined;
    out.push({
      value: opt.value, pv, machine, label: opt.label, needHours,
      ...(step ? { resolveStep: step } : {}),
      freeHours, capHours: cap ? cap.cap : null, closed,
      fits: !closed && needHours !== null && freeHours !== null && needHours <= freeHours + 1e-9,
    });
  }
  return out.sort((a, b) =>
    (a.fits === b.fits ? 0 : a.fits ? -1 : 1)
    || _cmpNullLast(a.freeHours, b.freeHours, true)
    || _cmpNullLast(a.needHours, b.needHours, false)
    || (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0)
    || ((a.pv ?? '') < (b.pv ?? '') ? -1 : (a.pv ?? '') > (b.pv ?? '') ? 1 : 0));
}

const _dateFromKey = (day: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;   // local midnight built from parts
};

/** The finish for a `need`-hour order on `day` that sits in a REAL gap: inside the day's working window
 *  (`[open, close]`, shortened to start at `now` when `now` falls on that day) the busy intervals are subtracted
 *  and the END of the LATEST free gap that holds `needHours` is returned (`viaGap: true`). Gap length is plain
 *  clock time inside the window, which is working time by construction. When no gap is large enough, or the need
 *  is unknown, the finish is the window close with `viaGap: false` and `gapHours` is the largest gap (the caller
 *  confirms, since the order may then overlap other work). Null when the day has no (remaining) window. The
 *  engine's backward walk avoids blackouts but not other orders, hence this search. Setup time before a busy bar
 *  is not modelled: a gap is measured to the bar's own start. */
export function slotGapFinishFor(
  machine: string, day: string, needHours: number | null | undefined,
  workWindow: (line: string, date: Date) => [Date, Date] | null,
  busyIntervals: ReadonlyArray<readonly [Date, Date]> | (() => ReadonlyArray<readonly [Date, Date]>),
  now?: Date | null,
): { finish: Date; gapHours: number; viaGap: boolean } | null {
  const date = _dateFromKey(day);
  if (!date) return null;
  const win = workWindow(machine, date);
  if (!win) return null;
  let lo = win[0].getTime();
  const hi = win[1].getTime();
  if (now && Util.dayKey(now) === day) lo = Math.max(lo, now.getTime());   // time already gone is not free
  if (hi <= lo) return null;
  // A function is read only now that the day is known to have a window (a closed day costs no scan of the tasks).
  const busy = typeof busyIntervals === 'function' ? busyIntervals() : busyIntervals;
  const clipped = busy
    .map(([s, e]) => [Math.max(lo, s.getTime()), Math.min(hi, e.getTime())] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = lo;
  for (const [s, e] of clipped) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < hi) gaps.push([cursor, hi]);
  const largest = gaps.reduce((best, [s, e]) => Math.max(best, (e - s) / Config.MS_HOUR), 0);
  const need = typeof needHours === 'number' && Number.isFinite(needHours) && needHours > 0 ? needHours : null;
  if (need !== null) {
    for (let i = gaps.length - 1; i >= 0; i--) {
      const [s, e] = gaps[i]!;
      if ((e - s) / Config.MS_HOUR >= need - 1e-9) return { finish: new Date(e), gapHours: (e - s) / Config.MS_HOUR, viaGap: true };
    }
  }
  return { finish: new Date(hi), gapHours: largest, viaGap: false };
}

/** What `slotFinishFor` needs beyond the calendar to keep a slot off other work and out of the past. */
export interface SlotFinishOpts {
  /** The order's run time on this pair; null/absent means unknown (never a fit, finish at the window close). */
  needHours?: number | null;
  /** The placed bars on a machine and day; absent means "nothing else on the machine". */
  busy?: (machine: string, day: string) => Array<[Date, Date]>;
  /** The plant's now: on its own day the window starts here. */
  now?: Date | null;
  /** The earliest day the walk-back may land on (the plant's today): it never goes back into the past. */
  floorDay?: string;
}

export interface SlotFinish {
  finish: Date;
  day: string;
  movedBack: number;
  /** The finish sits at the end of a free gap that holds the need (so the order does not overlap other work). */
  viaGap: boolean;
  /** The largest free gap in that day's window, hours (the gap itself when `viaGap`). */
  gapHours: number;
}

/** The finish to hand the engine for `machine` on `day` (YYYY-MM-DD): the end of the latest free gap that holds
 *  the need on that day, else the END of its working window (see `slotGapFinishFor`). The engine refuses a finish
 *  on a closed day (`finish_cannot_hold`), so a closed day, or one `isClosed` calls fully blacked out, walks back
 *  to the latest open window within SLOT_LOOKBACK_DAYS (`movedBack` counts the days walked; never before
 *  `opts.floorDay`). Null when no window is open in the window of days. `workWindow` is `Calendar.workWindow` (line
 *  hours intersected with the plant's). */
export function slotFinishFor(
  machine: string, day: string, workWindow: (line: string, date: Date) => [Date, Date] | null,
  isClosed?: (machine: string, day: string) => boolean, opts: SlotFinishOpts = {},
): SlotFinish | null {
  const origin = _dateFromKey(day);
  if (!origin) return null;
  const y = origin.getFullYear(), mo = origin.getMonth(), d = origin.getDate();
  const needKnown = typeof opts.needHours === 'number' && opts.needHours > 0;
  for (let back = 0; back <= SLOT_LOOKBACK_DAYS; back++) {
    const date = new Date(y, mo, d - back);   // a DST change cannot skip a day
    const key = Util.dayKey(date);
    if (opts.floorDay && key < opts.floorDay) break;
    if (isClosed?.(machine, key)) continue;
    const busy = needKnown && opts.busy ? () => opts.busy!(machine, key) : [];
    const g = slotGapFinishFor(machine, key, opts.needHours, workWindow, busy, opts.now);
    if (g) return { finish: g.finish, day: key, movedBack: back, viaGap: g.viaGap, gapHours: g.gapHours };
  }
  return null;
}

/** Fingerprint of the task fields a slot pick depends on: `Interaction._dropTaskKey` (gantt.mts) plus the
 *  planning reason code, the manual firm, the row version and the order quantity. A mismatch between the
 *  open dialog and the live row aborts the placement. */
export function slotTaskKey(task: NimbusTask): string {
  return JSON.stringify([task.MACHINE, task.PRODUCTION_VERSION, task.RUN_TIME, task.start_date?.getTime() ?? null,
    task.end_date?.getTime() ?? null, task.planning_status ?? null, task.MATERIAL_NUMBER ?? null,
    task.planning_reason?.code ?? null, !!task.firmed, task.row_version ?? null, task['ORDER_QUANTITY_(GMEIN)'] ?? null]);
}

const _DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The day the dialog opens on: the due day, but never before the plant's today (a past due day has no
 *  meaningful capacity, and the engine would place forward from now anyway). `plantToday` is a YYYY-MM-DD key.
 *  When nothing is left today (`nowLeftToday` false: the time has gone or the machines are closed) the floor is
 *  tomorrow, so the dialog never opens on a day it cannot use. */
export function defaultSlotDay(task: NimbusTask, plantToday: string | Date, nowLeftToday = true): string {
  const today = typeof plantToday === 'string' && _DAY_RE.test(plantToday) ? plantToday : Util.dayKey(plantToday);
  const floor = nowLeftToday ? today : _addDays(today, 1);
  const due = Util.dueDisplayDate(task);
  const dueDay = due ? Util.dayKey(due) : '';
  return dueDay && dueDay > floor ? dueDay : floor;
}

const _addDays = (day: string, n: number): string => {
  const d = _dateFromKey(day);
  return d ? Util.dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)) : day;
};

/** The option / suggestion line for a candidate. `null` (no eligible pair) reads `am.slot_none`. */
export function formatSlotOption(
  c: SlotCandidate | null | undefined, tr: (key: string, vars?: Record<string, string | number>) => string = t,
): string {
  if (!c) return tr('am.slot_none');
  if (c.closed) return tr('am.slot_option_closed', { pair: c.label });
  if (c.needHours === null || c.freeHours === null || c.capHours === null) return tr('am.slot_option_unknown', { pair: c.label });
  const vars = { pair: c.label, free: fmtNum(c.freeHours), cap: fmtNum(c.capHours), need: fmtNum(c.needHours) };
  return c.fits ? tr('am.slot_option', vars) : tr('am.slot_option_short', { ...vars, short: fmtNum(c.needHours - c.freeHours) });
}

/* =============================================================================
   THE MACHINE LIST — pure pieces of the "Move to an open machine" picker (lean rows + one preview).
   ========================================================================== */

/** Above this many candidates the list gets a filter box (50+ plants, 70+ machines: a scroll area, never chips). */
export const SLOT_FILTER_ABOVE = 8;

/** The one status word a row carries. */
export type SlotCandidateState = 'fits' | 'short' | 'closed' | 'unknown';

/** Closed beats unknown hours beats fits / short, the same precedence `formatSlotOption` reads. */
export function slotCandidateState(c: SlotCandidate): SlotCandidateState {
  if (c.closed) return 'closed';
  if (c.needHours === null || c.freeHours === null || c.capHours === null) return 'unknown';
  return c.fits ? 'fits' : 'short';
}

/** The candidates whose label or value contains `query` (case-insensitive); an empty query keeps every one, in order. */
export function filterSlotCandidates(cands: ReadonlyArray<SlotCandidate>, query: string): SlotCandidate[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...cands];
  return cands.filter(c => c.label.toLowerCase().includes(q) || c.value.toLowerCase().replace('|', ' ').includes(q));
}

/** The selected machine's day, as hour offsets since the landed day's midnight (0-24), for the preview strip. */
export interface SlotStripModel {
  /** Hours outside the working window (and, on the plant's today, the hours already gone). */
  off: Array<[number, number]>;
  /** Other orders' bars that touch the day. */
  busy: Array<[number, number]>;
  /** This order, `[finish - need, finish]`; null when the need is unknown (nothing to draw). */
  order: [number, number] | null;
}

/** Null when the day has no working window (the strip then degrades to an "unknown" track). Dates are clipped to the
 *  day, so a bar that crosses midnight shows the part inside it, and a 24:00 close is hour 24. */
export function slotStripModel(args: {
  day: string; window: readonly [Date, Date] | null; busy: ReadonlyArray<readonly [Date, Date]>;
  finish: Date | null; needHours: number | null; now?: Date | null;
}): SlotStripModel | null {
  const base = _dateFromKey(args.day);
  if (!base || !args.window) return null;
  const h = (d: Date): number => Math.min(24, Math.max(0, (d.getTime() - base.getTime()) / Config.MS_HOUR));
  const open = h(args.window[0]), close = h(args.window[1]);
  const off: Array<[number, number]> = [];
  if (open > 0) off.push([0, open]);
  if (close < 24) off.push([close, 24]);
  if (args.now && Util.dayKey(args.now) === args.day && h(args.now) > open) off.push([open, h(args.now)]);
  const busy = args.busy.map(([s, e]) => [h(s), h(e)] as [number, number]).filter(([s, e]) => e > s);
  let order: [number, number] | null = null;
  if (args.finish && typeof args.needHours === 'number' && args.needHours > 0) {
    const end = h(args.finish);
    order = [Math.max(0, end - args.needHours), end];
  }
  return { off, busy, order };
}

/** The one "does not fit" test, shared by the consequence line and `place()`'s confirm (and agreeing with `fits` in
 *  `rankSlotCandidates`, which uses the same 1e-9 float slack) so they cannot disagree: the need is unknown, the free
 *  hours are unknown, the need exceeds the free hours, or no free gap holds it (`!fin.viaGap`: the totals can fit while
 *  other orders cut the free time up). */
export function slotIsShort(c: SlotCandidate, fin: Pick<SlotFinish, 'viaGap'>): boolean {
  return c.needHours === null || c.freeHours === null || c.needHours > c.freeHours + 1e-9 || !fin.viaGap;
}

export interface SlotConsequence { key: string; vars: Record<string, string | number>; tone: SlotCandidateState }

/** The one line under the list: what "Move order" will do with the selected machine, so the walk-back, the overlap
 *  and the unknown run time are visible before the confirm, not sprung at it. `fmtDay` renders a YYYY-MM-DD key. */
export function slotConsequence(
  c: SlotCandidate, fin: SlotFinish | null, day: string, fmtDay: (day: string) => string,
): SlotConsequence {
  if (!fin) return { key: 'am.slot_no_window', vars: { machine: c.machine, day: fmtDay(day), days: SLOT_LOOKBACK_DAYS }, tone: 'closed' };
  if (fin.movedBack > 0) return { key: 'am.slot_cons_closed', vars: { machine: c.machine, day: fmtDay(day), moved: fmtDay(fin.day) }, tone: 'closed' };
  if (c.needHours === null) return { key: 'am.slot_cons_unknown', vars: { machine: c.machine }, tone: 'unknown' };
  // The same test place() confirms on (slotIsShort).
  const short = slotIsShort(c, fin);
  return { key: short ? 'am.slot_cons_short' : 'am.slot_cons_fits', vars: { machine: c.machine, when: fmtDay(fin.day) }, tone: short ? 'short' : 'fits' };
}

/* =============================================================================
   LIVE READS — the only place this module touches classic-script globals and the live Store.
   Tests replace the members of `slotSeams` / `liveSlotDeps` instead of standing up a browser.
   ========================================================================== */

interface SlotNimbus {
  Table?: { _getPairOptions?(task: NimbusTask): Array<{ value: string; label: string }> };
  Timeline?: { gotoLineDay?(line: string, day: string, onWindowSet?: () => void, anchor?: { taskId?: string; peerId?: string }): void };
}

/** The reads that are not the Store: the `NIMBUS` bridge (absent in Node), the signed-in check and the calendar. */
export const slotSeams = {
  nim: (): SlotNimbus => (globalThis as unknown as { NIMBUS?: SlotNimbus }).NIMBUS ?? {},
  signedIn: (): boolean => !!Session.currentUser(),
  workWindow: (line: string, date: Date): [Date, Date] | null => Calendar.workWindow(line, date),
  /** The plant's now (the naive wall clock `Store.plantNow` returns); null when the plant has no valid timezone. */
  plantNow: (plant: string): Date | null => Store.plantNow(plant),
  /** `day` (YYYY-MM-DD) has no capacity on `machine` at all (closed, or fully blacked out): the nominal working
   *  window of such a day is not usable, so the walk-back skips it. */
  dayClosed: (machine: string, day: string): boolean => {
    const date = _dateFromKey(day);
    return !!date && Calendar.effectiveCapacityHours(machine, date) <= 0;
  },
  /** Whether routing-runtime is on for the order's plant (the same test as `Table._routingEnabledForTask`). */
  routingPlant: (task: NimbusTask): boolean => {
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant || '';
    return !!plant && !!Store.masterData?.plants?.find(p => p.plant === plant)?.routing_runtime_enabled;
  },
};

/** One placement write is allowed for any signed-in user (there is no viewer role; `/tasks/update` needs only a
 *  login) and never in What-If, exactly like Fix and Override. The one seam for a future role check. */
export function canPlaceSlot(): boolean {
  return slotSeams.signedIn() && Sandbox.active !== true;
}

type UtilMatrix = ReturnType<typeof Utilization.computeMatrix>;
/** One 1-day matrix per (plant, data revision, day): every machine on a day shares it, and
 *  `computeMatrix` itself only keeps 6 windows. Bounded; cleared on a plant change. */
const _capMemo = new Map<string, UtilMatrix>();
const _CAP_MEMO_MAX = 24;

/** Hours the (possibly overlapping) busy intervals cover inside [loMs, hiMs]: clipped, merged, never double-counted. */
function _busyHoursWithin(busy: ReadonlyArray<readonly [Date, Date]>, loMs: number, hiMs: number): number {
  const clipped = busy
    .map(([s, e]) => [Math.max(loMs, s.getTime()), Math.min(hiMs, e.getTime())] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, cursor = loMs;
  for (const [s, e] of clipped) {
    const from = Math.max(cursor, s);
    if (e > from) { total += e - from; cursor = e; }
  }
  return total / Config.MS_HOUR;
}

/** The live reads behind the ranking. */
export const liveSlotDeps: SlotDeps = {
  /** The Orders grid's own pair list (`Table._getPairOptions`: eligible (PV, machine) pairs on a routing plant,
   *  the plant's lines elsewhere); without the bridge, the plant's lines. */
  pairOptions(task) {
    const options = slotSeams.nim().Table?._getPairOptions?.(task)
      ?? Store.linesForSelectedPlant().map(l => ({ value: l, label: l }));
    // On a routing plant the grid prepends the order's CURRENT pair when it is not eligible (so its select shows the
    // truth). A slot must never offer or suggest a pair the gate rejects: keep a `pv|machine` option only when it resolves.
    return options.filter(o => {
      if (!o.value.includes('|')) return true;
      const { pv, machine } = parsePairValue(o.value);
      return Runtime.resolve({ ...task, PRODUCTION_VERSION: pv ?? '' }, machine).ok;
    });
  },
  /** On a routing plant (a `pv|machine` option) the run time that pair resolves to, else the order's own. */
  hoursFor(task, pv, machine) {
    if (pv === null) { const h = Util.runHours(task); return h > 0 ? h : null; }
    const r = Runtime.resolve({ ...task, PRODUCTION_VERSION: pv }, machine);
    return r.ok ? r.hours : null;
  },
  resolveStep(task, pv, machine) {
    if (pv === null) return undefined;
    const r = Runtime.resolve({ ...task, PRODUCTION_VERSION: pv }, machine);
    return r.ok ? undefined : r.step;
  },
  /** Free and total hours of `machine` on `day` (YYYY-MM-DD): the utilization matrix cell, in which `scheduled`
   *  already includes the derived setup time. */
  dayCapacity(machine, day) {
    const start = new Date(`${day}T00:00:00`);
    if (isNaN(start.getTime())) return null;
    const key = `${Store.selectedPlant ?? ''}|${Store.dataRev()}|${day}`;
    let matrix = _capMemo.get(key);
    if (!matrix) {
      if (_capMemo.size >= _CAP_MEMO_MAX) _capMemo.clear();
      matrix = Utilization.computeMatrix(start, 1);
      _capMemo.set(key, matrix);
    }
    const row = matrix[machine]?.[day];
    if (!row) return null;
    let free = Math.max(0, row.effectiveCapacity - row.scheduled);
    let cap = row.effectiveCapacity;
    let closed = row.capacity <= 0;
    // On the plant's today only the time still ahead counts. The cell's `scheduled` covers the WHOLE day (setup
    // included), so the part already behind now comes out of it before it is held against what is left: the capacity
    // shrinks by the working window before now (goneH) and the free hours are that remainder minus the work still
    // ahead (an idle morning is not work done, so it never eats into the afternoon). An exhausted day is closed.
    const plant = Store.selectedPlant ?? '';
    const now = plant ? slotSeams.plantNow(plant) : null;
    if (now && Util.dayKey(now) === day && !closed) {
      const win = slotSeams.workWindow(machine, start);
      if (win) {
        const nowMs = Math.min(now.getTime(), win[1].getTime());
        const goneH = Math.max(0, nowMs - win[0].getTime()) / Config.MS_HOUR;
        cap = Math.max(0, cap - goneH);
        const passedH = _busyHoursWithin(liveSlotDeps.busyIntervals?.(machine, day) ?? [], win[0].getTime(), nowMs);
        free = Math.max(0, cap - Math.max(0, row.scheduled - passedH));
        closed = cap <= 0;
      }
    }
    return { free, cap, closed };
  },
  /** The placed bars of `machine` that touch `day`: split orders by piece (`Util.scheduleIntervals`), a plain bar
   *  by its start and end; a row without both dates (a queued order) is not busy. */
  busyIntervals(machine, day) {
    const dayStart = _dateFromKey(day);
    if (!dayStart) return [];
    const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
    const out: Array<[Date, Date]> = [];
    for (const row of Store.tasksForSelectedPlant()) {
      if (row.MACHINE !== machine) continue;
      const start = Util.parseDate(row.start_date), end = Util.parseDate(row.end_date);
      if (!start || !end) continue;
      const pieces = Util.scheduleIntervals(row);
      const spans: Array<[Date, Date]> = pieces.length ? pieces.map(p => [p.start, p.end]) : [[start, end]];
      for (const [s, e] of spans) if (s < dayEnd && e > dayStart) out.push([s, e]);
    }
    return out;
  },
};

const _todayKey = (plant: string): string => Util.dayKey(Util.plantToday(plant));

/** The day a slot for `task` starts from: `defaultSlotDay`, moved to tomorrow when the due day is already past and
 *  every eligible machine is closed or used up today (an unreadable capacity does not count as used up). Only asks
 *  when the default would be today, so a future due day costs nothing extra. */
function _defaultDay(task: NimbusTask, plant: string): string {
  const today = _todayKey(plant);
  if (defaultSlotDay(task, today) !== today) return defaultSlotDay(task, today);
  const options = liveSlotDeps.pairOptions(task);
  const nowLeft = options.length === 0 || options.some(o => {
    const cap = liveSlotDeps.dayCapacity(parsePairValue(o.value).machine, today);
    return !cap || !cap.closed;
  });
  return defaultSlotDay(task, today, nowLeft);
}

/* =============================================================================
   THE DIALOG
   ========================================================================== */

interface SlotState {
  plant: string;
  taskId: string;
  /** `slotTaskKey` of the row when the dialog opened. */
  taskKey: string;
  day: string;
  candidates: SlotCandidate[];
  /** The pair the planner chose by hand (survives a day change while still listed); null = follow the ranking. */
  picked: string | null;
  busy: boolean;
  /** The filter box text (only shown above SLOT_FILTER_ABOVE candidates). */
  filter: string;
  /** The day preview disclosure; collapsed on every open, never persisted. */
  previewOpen: boolean;
}
interface PickerLike { setDate(d: string, fire?: boolean): void; destroy(): void; altInput?: HTMLInputElement }

let _s: SlotState | null = null;
let _fp: PickerLike | null = null;

function _el<E extends HTMLElement = HTMLElement>(id: string): E | null {
  return document.getElementById(id) as E | null;
}

function _destroyPicker(): void {
  if (_fp) { try { _fp.destroy(); } catch { /* already gone */ } _fp = null; }
}

function _orderLabel(task: NimbusTask): string {
  return Util.orderNumber(task, String(task.id));
}

/** "Raise inventory" next to a tool-queued order's reason: the same deep link as the Optimize preview. */
function _raiseHtml(task: NimbusTask): string {
  const reason = task.planning_reason;
  const tool = typeof reason?.tool_id === 'string' ? reason.tool_id : '';
  if (!tool || !String(reason?.code ?? '').startsWith('tool_')) return '';
  return `<button type="button" class="btn btn-ghost sm" data-asl-raise="${esc(tool)}">${esc(t('ui.opt_tool_raise'))}</button>`;
}

/** The calm lead for the one reason whose next step is another machine: no window in the push/pull range. */
function _leadHtml(task: NimbusTask): string {
  if (task.planning_reason?.code !== 'push_limit_unmet') return '';
  return `<div class="asl-lead" id="asl-lead"><span class="asl-lead-ico" aria-hidden="true">◫</span>`
    + `<div class="asl-lead-title">${esc(t('am.slot_lead_push'))}</div>`
    + `<div class="asl-lead-sub">${esc(t('am.slot_lead_push_sub'))}</div></div>`;
}

function _bodyHtml(task: NimbusTask): string {
  const lead = _leadHtml(task);
  const nowFits = !!Store.alertsByTask().get(String(task.id))?.some(a => a.type === 'queued_now_fits');
  const reason = lead ? '' : planningReasonText(task.planning_reason, t, { nowFits });
  const filterLabel = esc(t('am.slot_filter'));
  return lead
    + `<div class="form-row"><label>${esc(t('ui.insp_order'))}</label>`
    + `<div class="readonly" id="asl-order">${esc(_orderLabel(task))} · ${esc(task.MACHINE || '—')}</div></div>`
    + (reason ? `<div class="form-row"><div class="hint" id="asl-reason">${esc(reason)}</div>${_raiseHtml(task)}</div>` : '')
    + `<div class="form-row"><label for="asl-day">${esc(t('am.slot_day'))}</label>`
    + `<input type="text" id="asl-day" autocomplete="off"></div>`
    + `<div class="asl-cands">`
    + `<div class="asl-cands-head"><span class="asl-label" id="asl-cands-label">${esc(t('am.slot_pair'))}</span><span class="asl-count" id="asl-count"></span></div>`
    + `<input type="search" class="input asl-filter" id="asl-filter" autocomplete="off" placeholder="${filterLabel}" aria-label="${filterLabel}" hidden>`
    + `<div class="asl-list" id="asl-list" role="radiogroup" aria-labelledby="asl-cands-label"></div>`
    // The select stays the source of truth place() reads; the radio rows mirror it (visually hidden, never in the tab order).
    + `<select id="asl-pair" class="asl-sr" aria-hidden="true" tabindex="-1"></select>`
    + `<p class="asl-consequence" id="asl-consequence" aria-live="polite"></p>`
    + `<button type="button" class="asl-preview-toggle" id="asl-preview-toggle" aria-expanded="false" aria-controls="asl-preview" data-asl-act="preview">${esc(t('am.slot_preview_show'))}</button>`
    + `<section class="asl-preview" id="asl-preview" hidden></section>`
    + `</div>`
    + `<div class="hint">${esc(t('am.slot_hint'))}</div>`;
}

function _footHtml(s: SlotState): string {
  const blocked = !canPlaceSlot();
  const disabled = blocked || s.candidates.length === 0;
  return `<button type="button" class="btn btn-ghost" data-asl-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" id="asl-place" data-asl-act="place"`
    + `${disabled ? ' disabled aria-disabled="true"' : ''}${blocked ? ` title="${esc(t('am.whatif_blocked'))}"` : ''}>${esc(t('am.slot_place'))}</button>`;
}

/** The planner's own pick when still listed, else the best-ranked. */
function _chosen(s: SlotState): string {
  return s.picked && s.candidates.some(c => c.value === s.picked) ? s.picked : s.candidates[0]?.value ?? '';
}

/** What the select says now (the truth), else the ranking's pick. */
function _currentValue(s: SlotState): string {
  return _el<HTMLSelectElement>('asl-pair')?.value || _chosen(s);
}

function _setText(id: string, text: string): void {
  const el = _el(id);
  if (el) el.textContent = text;
}

/** A YYYY-MM-DD key in the user's date format. */
function _fmtDay(day: string): string {
  const d = _dateFromKey(day);
  return d ? Util._fmtDatePref(d) : day;
}

/** The finish `place()` will hand the engine for this candidate on the dialog's day (gap search, walk-back, floor). */
function _finishFor(s: SlotState, c: SlotCandidate): SlotFinish | null {
  return slotFinishFor(c.machine, s.day, slotSeams.workWindow, slotSeams.dayClosed, {
    needHours: c.needHours, busy: (m, d) => liveSlotDeps.busyIntervals?.(m, d) ?? [],
    now: slotSeams.plantNow(s.plant), floorDay: _todayKey(s.plant),
  });
}

const _GLYPH: Record<SlotCandidateState, string> = { fits: '✓', short: '△', closed: '—', unknown: '?' };
const _pct = (h: number): string => `${(h / 24 * 100).toFixed(2)}%`;

/** The 56 px micro-bar: in use (neutral), then this order (accent, hatched when it does not fit). */
function _microHtml(c: SlotCandidate, state: SlotCandidateState): string {
  if (state === 'closed' || state === 'unknown') return `<span class="asl-micro is-${state}" aria-hidden="true"></span>`;
  const cap = c.capHours ?? 0, free = c.freeHours ?? 0, need = c.needHours ?? 0;
  const used = cap > 0 ? Math.max(0, cap - free) / cap * 100 : 0;
  const mine = cap > 0 ? Math.min(100 - used, (state === 'fits' ? need : free) / cap * 100) : 0;
  return `<span class="asl-micro" aria-hidden="true"><i class="used" style="width:${used.toFixed(1)}%"></i>`
    + `<i class="me${state === 'short' ? ' short' : ''}" style="width:${mine.toFixed(1)}%"></i></span>`;
}

function _rowHtml(c: SlotCandidate, checked: boolean, best: boolean, hidden: boolean): string {
  const state = slotCandidateState(c);
  const free = state === 'fits' || state === 'short'
    ? `<b>${esc(t('am.slot_free_h', { free: fmtNum(c.freeHours ?? 0) }))}</b><small>${esc(t('am.slot_free_of', { cap: fmtNum(c.capHours ?? 0) }))}</small>`
    : '';
  return `<label class="asl-cand${best ? ' is-best' : ''}" data-state="${state}" data-value="${esc(c.value)}"${hidden ? ' hidden' : ''}>`
    + `<input class="asl-sr" type="radio" name="asl-cand" value="${esc(c.value)}"${checked ? ' checked data-autofocus' : ''}>`
    + `<span class="asl-radio" aria-hidden="true"></span>`
    + `<span class="asl-name">${esc(c.label)}${best ? `<span class="asl-best">${esc(t('am.slot_best'))}</span>` : ''}</span>`
    + `<span class="asl-free">${_microHtml(c, state)}<span class="asl-free-txt">${free}</span></span>`
    + `<span class="asl-status"><span class="asl-glyph" aria-hidden="true">${_GLYPH[state]}</span>${esc(t(`am.slot_st_${state}`))}</span>`
    + `</label>`;
}

/** The radio rows (every candidate; the filter hides, never drops, so the checked row survives a filter), the count. */
function _renderList(s: SlotState, chosen: string): void {
  const list = _el('asl-list');
  if (!list) return;
  const visible = new Set(filterSlotCandidates(s.candidates, s.filter).map(c => c.value));
  let bestDone = false;
  list.innerHTML = s.candidates.map(c => {
    const best = !bestDone && c.fits;
    if (best) bestDone = true;
    return _rowHtml(c, c.value === chosen, best, !visible.has(c.value));
  }).join('');
  const n = visible.size, total = s.candidates.length;
  _setText('asl-count', n === total ? (total === 1 ? t('am.slot_count_one') : t('am.slot_count', { n: total })) : t('am.slot_showing', { n, total }));
}

/** "Finishes Thu 30 Oct · 24:00": a close at next-day midnight reads 24:00, never the next day's 00:00. */
function _finishLabel(fin: SlotFinish): string {
  const landed = _dateFromKey(fin.day);
  if (!landed) return '';
  const nextMidnight = new Date(landed.getFullYear(), landed.getMonth(), landed.getDate() + 1).getTime();
  const time = fin.finish.getTime() === nextMidnight ? '24:00' : Util._fmtTimePref(fin.finish);
  return t('am.slot_finish', { when: Util._fmtDatePref(landed), time });
}

/** The preview card for the selected machine: name, finish, the day strip with an hour ruler, the numbers, a legend. */
function _previewHtml(s: SlotState, c: SlotCandidate, fin: SlotFinish | null, tone: SlotCandidateState): string {
  const landed = fin ? _dateFromKey(fin.day) : null;
  const model = fin && landed ? slotStripModel({
    day: fin.day, window: slotSeams.workWindow(c.machine, landed), busy: liveSlotDeps.busyIntervals?.(c.machine, fin.day) ?? [],
    finish: fin.finish, needHours: c.needHours, now: slotSeams.plantNow(s.plant),
  }) : null;
  const blk = (cls: string, [a, b]: [number, number]): string => `<i class="blk ${cls}" style="left:${_pct(a)};width:${_pct(b - a)}"></i>`;
  const strip = model
    ? `<div class="asl-strip" aria-hidden="true">${model.off.map(x => blk('off', x)).join('')}${model.busy.map(x => blk('busy', x)).join('')}`
      + `${model.order ? blk(`me${tone === 'short' ? ' short' : ''}`, model.order) : ''}</div>`
    : '<div class="asl-strip is-unknown" aria-hidden="true"></div>';
  const ticks = `<div class="asl-ticks" aria-hidden="true">${[0, 6, 12, 18, 24].map(h => `<span style="left:${_pct(h)}">${h}</span>`).join('')}</div>`;
  const finish = fin ? _finishLabel(fin) : '';
  return `<div class="asl-preview-top"><span class="asl-preview-name">${esc(c.label)}</span>`
    + (finish ? `<span class="asl-preview-finish">${esc(finish)}</span>` : '') + '</div>'
    + strip + ticks
    + `<p class="asl-preview-nums">${esc(formatSlotOption(c))}</p>`
    + `<div class="asl-legend"><span><i class="o"></i>${esc(t('am.slot_legend_other'))}</span>`
    + `<span><i class="t"></i>${esc(t('am.slot_legend_this'))}</span>`
    + `<span><i class="n"></i>${esc(t('am.slot_legend_closed'))}</span></div>`;
}

/** The consequence line and, when open, the preview card for the selected candidate (computed for that one machine only). */
function _renderSelection(s: SlotState): void {
  const cand = s.candidates.find(c => c.value === _currentValue(s));
  if (!cand) return;
  const fin = _finishFor(s, cand);
  const cons = slotConsequence(cand, fin, s.day, _fmtDay);
  const p = _el('asl-consequence');
  if (p) { p.textContent = t(cons.key, cons.vars); p.dataset.tone = cons.tone; }
  const toggle = _el<HTMLButtonElement>('asl-preview-toggle');
  if (toggle) {
    toggle.hidden = false;
    toggle.setAttribute('aria-expanded', s.previewOpen ? 'true' : 'false');
    toggle.textContent = t(s.previewOpen ? 'am.slot_preview_hide' : 'am.slot_preview_show');
  }
  const preview = _el('asl-preview');
  if (preview) {
    preview.hidden = !s.previewOpen;
    preview.innerHTML = s.previewOpen ? _previewHtml(s, cand, fin, cons.tone) : '';
  }
}

/** Select `value` everywhere: the select (truth), `picked`, the radio rows, and the consequence / preview. */
function _select(value: string, focus = false): void {
  const s = _s;
  const sel = _el<HTMLSelectElement>('asl-pair');
  if (!s || !sel) return;
  sel.value = value;
  s.picked = value;
  const radios = _el('asl-list')?.querySelectorAll?.<HTMLInputElement>('input[name="asl-cand"]');
  for (const r of Array.from(radios ?? [])) {
    r.checked = r.value === value;
    if (focus && r.checked) r.focus();
  }
  _renderSelection(s);
}

/** Fill the pair list from `_s.candidates`: the planner's own pick when still listed, else the best-ranked. */
function _renderPairs(): void {
  const s = _s;
  const sel = _el<HTMLSelectElement>('asl-pair');
  if (!s || !sel) return;
  const filter = _el<HTMLInputElement>('asl-filter');
  const toggle = _el('asl-preview-toggle');
  const preview = _el('asl-preview');
  if (!s.candidates.length) {
    sel.innerHTML = `<option value="">${esc(t('am.slot_none'))}</option>`;
    sel.value = '';
    sel.disabled = true;
    const list = _el('asl-list');
    if (list) list.innerHTML = `<div class="asl-empty"><b>${esc(t('am.slot_empty', { day: _fmtDay(s.day) }))}</b>${esc(t('am.slot_empty_sub'))}</div>`;
    if (filter) filter.hidden = true;
    _setText('asl-count', '');
    _setText('asl-consequence', '');
    if (toggle) toggle.hidden = true;
    if (preview) { preview.hidden = true; preview.innerHTML = ''; }
    return;
  }
  const chosen = _chosen(s);
  sel.innerHTML = s.candidates.map(c =>
    `<option value="${esc(c.value)}"${c.value === chosen ? ' selected' : ''}>${esc(formatSlotOption(c))}</option>`).join('');
  sel.value = chosen;
  sel.disabled = false;
  if (filter) {
    filter.hidden = s.candidates.length <= SLOT_FILTER_ABOVE;
    if (filter.hidden) { s.filter = ''; filter.value = ''; }
  }
  _renderList(s, chosen);
  _renderSelection(s);
}

/** Arrow keys walk the VISIBLE rows (wrapping), Home / End jump; the native radio walk is replaced so a filtered-out
 *  row is never landed on and the select stays in step. */
function _onListKey(e: KeyboardEvent): void {
  const s = _s;
  if (!s || !s.candidates.length) return;
  const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  const visible = filterSlotCandidates(s.candidates, s.filter);
  if (!visible.length) return;
  let next: string | undefined;
  if (e.key === 'Home') next = visible[0]!.value;
  else if (e.key === 'End') next = visible[visible.length - 1]!.value;
  else if (e.key in step) {
    const cur = visible.findIndex(c => c.value === _currentValue(s));
    // The chosen row may be filtered out (cur < 0): Down lands on the first visible row, Up on the last.
    const dir = step[e.key]!;
    next = visible[cur < 0 ? (dir > 0 ? 0 : visible.length - 1) : (cur + dir + visible.length) % visible.length]!.value;
  }
  if (next === undefined) return;
  e.preventDefault();
  _select(next, true);
}

function _onFilterInput(value: string): void {
  const s = _s;
  if (!s) return;
  s.filter = value ?? '';
  _renderList(s, _currentValue(s));
}

function _focusChecked(): void {
  _el('asl-list')?.querySelector?.<HTMLInputElement>('input[name="asl-cand"]:checked')?.focus?.();
}

function _initPicker(day: string, plant: string): void {
  const input = _el<HTMLInputElement>('asl-day');
  if (!input) return;
  input.value = day;
  _destroyPicker();
  try {
    if (typeof flatpickr !== 'undefined') {
      _fp = flatpickr(input, {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(), altInputClass: 'input',
        defaultDate: day, minDate: _todayKey(plant),   // the plant's today, not the browser's
        onChange: () => AlertSlotModal.rerank(),
      }) as unknown as PickerLike;
      _fp.altInput?.setAttribute?.('aria-label', t('am.slot_day'));
    }
  } catch { _fp = null; }   // plain text input: rerank still insists on YYYY-MM-DD
}

function _wire(): void {
  const shell = _el('modal-alert-slot') as (HTMLElement & { _aslWired?: boolean }) | null;
  if (!shell || shell._aslWired) return;
  shell._aslWired = true;
  // The body is re-rendered on every open, so everything inside it is delegated from the body itself.
  _el('asl-body')?.addEventListener('click', e => {
    const target = e.target as HTMLElement | null;
    const tool = target?.closest?.<HTMLElement>('[data-asl-raise]')?.dataset.aslRaise;
    if (tool && _s) { const plant = _s.plant; AlertSlotModal.close(); raiseToolInventory(plant, tool); return; }
    if (target?.closest?.<HTMLElement>('[data-asl-act="preview"]') && _s) {
      _s.previewOpen = !_s.previewOpen;
      _renderSelection(_s);
    }
  });
  _el('asl-body')?.addEventListener('change', e => {
    const target = e.target as (HTMLElement & { value?: string; name?: string }) | null;
    if (!target || !_s) return;
    if (target.id === 'asl-pair' || target.name === 'asl-cand') _select(target.value ?? '');
    else if (target.id === 'asl-day') AlertSlotModal.rerank();
  });
  _el('asl-body')?.addEventListener('input', e => {
    const target = e.target as (HTMLElement & { value?: string }) | null;
    if (target?.id === 'asl-filter') _onFilterInput(target.value ?? '');
  });
  _el('asl-body')?.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as (HTMLElement & { value?: string; name?: string }) | null;
    if (target?.id === 'asl-filter') {
      // Escape clears a non-empty filter first; only an empty one lets the shell close the dialog.
      if (e.key === 'Escape' && _s?.filter) { e.preventDefault(); e.stopPropagation(); target.value = ''; _onFilterInput(''); }
      return;
    }
    if (target?.name === 'asl-cand') _onListKey(e);
  });
  _el('asl-foot')?.addEventListener('click', e => {
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-asl-act]')?.dataset.aslAct;
    if (act === 'cancel') AlertSlotModal.close();
    else if (act === 'place') void AlertSlotModal.place();
  });
  _el('asl-close')?.addEventListener('click', () => AlertSlotModal.close());
  shell.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) AlertSlotModal.close();
  });
}

/** The live row if it still matches what the dialog opened on; else the stale toast, close, and null. */
function _freshTask(s: SlotState): NimbusTask | null {
  const live = Store.tasks[s.taskId];
  if (live && slotTaskKey(live) === s.taskKey) return live;
  Toast.show(t('am.slot_stale', { order: live ? _orderLabel(live) : s.taskId }), 'warn');
  AlertSlotModal.close();
  return null;
}

/** Say why the engine refused (it already toasted `finish_cannot_hold` unless asked to be quiet, which place() does). */
function _explainRefusal(task: NimbusTask, pv: string | null, machine: string): void {
  const order = _orderLabel(task);
  const reason = Engine.lastManualRefusal;
  if (reason === 'finish_cannot_hold') Toast.show(t('toast.finish_cannot_hold', { order, machine }), 'warn', 5000);
  else if (!reason && slotSeams.routingPlant(task)) {
    // A null return with no recorded refusal on a routing plant means the pair (or bare machine) did not resolve.
    // An empty production version is "no pair" (the machine-only wording), like a bare machine.
    if (pv) Toast.show(t('toast.pv_machine_ineligible', { order, pv, machine }), 'warn', 4000);
    else Toast.show(t('toast.no_routing_at_workcenter', { order, machine }), 'warn', 4000);
  } else Toast.show(t('toast.manual_refusal_generic'), 'error');
}

export const AlertSlotModal = {
  /** Open the dialog for one queued order. Re-ranks nothing until the day changes. */
  open(opts: { plant: string; taskId: string; alertId?: string /* accepted for the pane's call, ignored */ }): void {
    const task = opts.plant && opts.taskId ? Store.tasks[opts.taskId] : undefined;
    if (!task) return;
    const day = _defaultDay(task, opts.plant);
    const s: SlotState = {
      plant: opts.plant, taskId: String(opts.taskId), taskKey: slotTaskKey(task), day,
      candidates: rankSlotCandidates(task, day, liveSlotDeps), picked: null, busy: false, filter: '', previewOpen: false,
    };
    _s = s;
    _wire();
    const title = _el('asl-title');
    if (title) title.textContent = t('am.slot_title');
    const body = _el('asl-body');
    if (body) body.innerHTML = _bodyHtml(task);
    const foot = _el('asl-foot');
    if (foot) foot.innerHTML = _footHtml(s);
    _renderPairs();
    _initPicker(day, opts.plant);
    Modal.open('modal-alert-slot');
    _focusChecked();   // the machine list is the decision: focus lands on the suggested row
  },

  /** Re-rank for the day in `#asl-day` (or `day`). A malformed day or one before the plant's today is put back. */
  rerank(day?: string): void {
    const s = _s;
    if (!s) return;
    const input = _el<HTMLInputElement>('asl-day');
    if (day && input) { input.value = day; try { _fp?.setDate(day, false); } catch { /* plain input */ } }
    const next = String(input?.value ?? day ?? '').trim();
    const task = Store.tasks[s.taskId];
    if (!task || !_DAY_RE.test(next) || next < _todayKey(s.plant)) {
      if (input) { input.value = s.day; try { _fp?.setDate(s.day, false); } catch { /* plain input */ } }
      return;
    }
    if (next === s.day && s.candidates.length) return;
    s.day = next;
    s.candidates = rankSlotCandidates(task, next, liveSlotDeps);
    _renderPairs();
  },

  /** Place the chosen pair at the end of the day's working window, firm it, and take the planner there. */
  async place(): Promise<void> {
    const s = _s;
    if (!s || s.busy) return;
    if (!canPlaceSlot()) { Toast.show(t('am.whatif_blocked'), 'warn'); return; }
    const cand = s.candidates.find(c => c.value === _el<HTMLSelectElement>('asl-pair')?.value);
    if (!cand) return;
    const first = _freshTask(s);
    if (!first) return;
    const { pv, machine } = parsePairValue(cand.value);
    const fin = _finishFor(s, cand);
    if (!fin) { Toast.show(t('am.slot_no_window', { machine, day: _fmtDay(s.day), days: SLOT_LOOKBACK_DAYS }), 'warn'); return; }
    s.busy = true;
    try {
      // "Fits" must mean a real gap: the totals can fit while the free time is cut up by other orders (not viaGap).
      const short = slotIsShort(cand, fin);
      // Tool Inventory: warn (never refuse) when the slotted interval would put a tool over its copies.
      const toolOver = slotToolOverage({ task: first, machine, finish: fin.finish, needHours: cand.needHours, plant: s.plant, now: slotSeams.plantNow(s.plant) });
      if (fin.movedBack > 0 || short || toolOver) {
        const base = fin.movedBack > 0
          ? t('am.slot_confirm_closed', { order: _orderLabel(first), machine, day: _fmtDay(s.day), moved: _fmtDay(fin.day) })
          : short
            ? t('am.slot_confirm_short', { order: _orderLabel(first), machine, day: _fmtDay(s.day) })
            : '';
        const toolClause = toolOver ? t('am.slot_confirm_tool', { tool: toolOver.tool, available: toolOver.available }) : '';
        const ok = await Modal.confirm({
          tone: 'warn', title: t('am.slot_confirm_title'),
          message: [base, toolClause].filter(Boolean).join(' '),
          confirmLabel: t('am.slot_confirm_place'),
        });
        if (_s !== s || !ok) return;   // closed meanwhile (a plant change) or cancelled
        if (!canPlaceSlot()) { Toast.show(t('am.whatif_blocked'), 'warn'); return; }   // What-If began during the confirm
      }
      let cur = _freshTask(s);   // the confirm is async: the row may have moved under it
      if (!cur) return;
      const build = (row: NimbusTask, extra: { confirmedOvertime?: boolean }) => (pv
        ? Engine.pairSchedulePatchFor(row, pv, machine, fin.finish, { quiet: true, ...extra })
        : Engine.manualRoutingSchedulePatchFor(row, machine, fin.finish, { quiet: true, ...extra }));
      let patch = build(cur, {});
      // An already-firmed queued order placed outside working time: ask for the overtime approval like the grid
      // (`Table._explainManualRefusal`), then retry once with it. The row can move under the await.
      if ((!patch || !patch.start_date || !patch.end_date) && Engine.lastManualRefusal === 'needs_overtime_confirm') {
        const approved = await Engine.confirmOvertimePlacement(cur);
        if (_s !== s || !approved) return;
        if (!canPlaceSlot()) { Toast.show(t('am.whatif_blocked'), 'warn'); return; }
        const again = _freshTask(s);
        if (!again) return;
        cur = again;
        patch = build(cur, { confirmedOvertime: true });
      }
      if (!patch || !patch.start_date || !patch.end_date) { _explainRefusal(cur, pv, machine); return; }
      const id = s.taskId;
      const wasFirmed = Store.isFirmed(id);
      const snap = UndoStack.snapshotTasks([id]);
      Store.updateTask(id, patch, 'alerts');
      // C9: firm the placed order unless the frozen horizon (or a running state) already protects it:
      // applyFirm skips a locked order, and a redundant planner firm there would be unremovable.
      const firmedHere = !wasFirmed && Engine.applyFirm([id], true, 'alerts').changed.length > 0;
      UndoStack.push(t('am.slot_undo', { order: _orderLabel(cur) }), () => {
        UndoStack.restoreTasks(snap);   // strips `firmed` on purpose, so the firm is undone here, as its own write
        if (firmedHere) Store.setFirmed([id], false, 'undo');
      }, [id]);
      Alerts.scheduleRecompute();
      const placedOn = patch.MACHINE ?? machine;
      // The landing day is the day the bar ENDS on: a 24:00 close is the exclusive next-day midnight, so step back
      // 1 ms (as `dueDisplayDate` does) or the toast and Go To would name the day after.
      const landed = new Date(patch.end_date.getTime() - 1);
      Toast.show(t('am.slot_placed', { order: _orderLabel(cur), machine: placedOn, when: Util._fmtDatePref(landed) }), 'success');
      AlertSlotModal.close();
      // Not AlertsUIAdapter.focus: the alert vanishes on the recompute and carries the old line and day.
      slotSeams.nim().Timeline?.gotoLineDay?.(placedOn, Util.dayKey(landed), undefined, { taskId: id });
    } finally { s.busy = false; }
  },

  close(): void {
    if (!_s) return;
    _s = null;
    _destroyPicker();
    Modal.close('modal-alert-slot');
  },

  /** True while the dialog is open for this plant (a plant switch closes it). */
  isOpenFor(plant: string | null): boolean { return !!_s && _s.plant === plant; },
};

// A plant change leaves the slot being composed meaningless, and the capacity memo is plant-scoped.
Store.subscribe(evt => {
  if (evt.type !== 'plant:selected') return;
  _capMemo.clear();
  if (_s && _s.plant !== (evt.plant as string | null)) AlertSlotModal.close();
}, 'alert-slot-modal');
