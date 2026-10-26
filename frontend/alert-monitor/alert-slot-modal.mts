/* =============================================================================
   ALERT SLOT MODAL — "◫ Slot…" on a Needs Planning row of the Alert Monitor.

   Recommends a (production version, machine) pair and a finish for a queued order, then places and firms it.
   The static shell (#modal-alert-slot) lives in index.html; this module fills the body (#asl-body) and footer
   (#asl-foot) at runtime and opens/closes it through Modal.open/close (the central focus trap). Modal.confirm
   stacks on top of it (the Override dialog and Engine.confirmOvertimePlacement do the same).

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
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import { Session } from '../security/session.mjs';
import { Runtime, normPv } from '../routing/runtime-client.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Alerts, Utilization } from '../insights/services.mjs';
import { Engine } from '../optimization/engine.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { planningReasonText } from '../scheduling/planning-reason.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

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

const _MS_H = 3600e3;
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
  const largest = gaps.reduce((best, [s, e]) => Math.max(best, (e - s) / _MS_H), 0);
  const need = typeof needHours === 'number' && Number.isFinite(needHours) && needHours > 0 ? needHours : null;
  if (need !== null) {
    for (let i = gaps.length - 1; i >= 0; i--) {
      const [s, e] = gaps[i]!;
      if ((e - s) / _MS_H >= need - 1e-9) return { finish: new Date(e), gapHours: (e - s) / _MS_H, viaGap: true };
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

/** One decimal, no trailing zero (6 -> "6", 4.25 -> "4.3"). */
const _fmtH = (n: number): string => String(Math.round(n * 10) / 10);

/** The option / suggestion line for a candidate. `null` (no eligible pair) reads `am.slot_none`. */
export function formatSlotOption(
  c: SlotCandidate | null | undefined, tr: (key: string, vars?: Record<string, string | number>) => string = t,
): string {
  if (!c) return tr('am.slot_none');
  if (c.closed) return tr('am.slot_option_closed', { pair: c.label });
  if (c.needHours === null || c.freeHours === null || c.capHours === null) return tr('am.slot_option_unknown', { pair: c.label });
  const vars = { pair: c.label, free: _fmtH(c.freeHours), cap: _fmtH(c.capHours), need: _fmtH(c.needHours) };
  return c.fits ? tr('am.slot_option', vars) : tr('am.slot_option_short', { ...vars, short: _fmtH(c.needHours - c.freeHours) });
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
/** One 1-day matrix per (plant, data revision, day): suggestions for many orders due the same day share it, and
 *  `computeMatrix` itself only keeps 6 windows. Bounded; cleared on a plant change. */
const _capMemo = new Map<string, UtilMatrix>();
const _CAP_MEMO_MAX = 24;

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
    // On the plant's today the hours already gone are not free: shorten the capacity by the part of the working
    // window before now, cap the free hours by what is left, and call an exhausted day closed.
    const plant = Store.selectedPlant ?? '';
    const now = plant ? slotSeams.plantNow(plant) : null;
    if (now && Util.dayKey(now) === day && !closed) {
      const win = slotSeams.workWindow(machine, start);
      if (win) {
        const goneH = Math.max(0, Math.min(now.getTime(), win[1].getTime()) - win[0].getTime()) / _MS_H;
        cap = Math.max(0, cap - goneH);
        free = Math.min(free, cap);
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

/** Memo of `suggest`: `${taskId}|${Store.dataRev()}` -> top candidate (or null). Cleared on `plant:selected`. */
const _suggestMemo = new Map<string, SlotCandidate | null>();
const _SUGGEST_MEMO_MAX = 1000;

/* =============================================================================
   THE DIALOG
   ========================================================================== */

interface SlotState {
  plant: string;
  taskId: string;
  alertId: string | undefined;
  /** `slotTaskKey` of the row when the dialog opened. */
  taskKey: string;
  day: string;
  candidates: SlotCandidate[];
  /** The pair the planner chose by hand (survives a day change while still listed); null = follow the ranking. */
  picked: string | null;
  busy: boolean;
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

function _bodyHtml(task: NimbusTask): string {
  const nowFits = !!Store.alertsByTask().get(String(task.id))?.some(a => a.type === 'queued_now_fits');
  const reason = planningReasonText(task.planning_reason, t, { nowFits });
  return `<div class="form-row"><label>${esc(t('ui.insp_order'))}</label>`
    + `<div class="readonly" id="asl-order">${esc(_orderLabel(task))} · ${esc(task.MACHINE || '—')}</div></div>`
    + (reason ? `<div class="form-row"><div class="hint" id="asl-reason">${esc(reason)}</div></div>` : '')
    + `<div class="form-row"><label for="asl-day">${esc(t('am.slot_day'))}</label>`
    + `<input type="text" id="asl-day" autocomplete="off"></div>`
    + `<div class="form-row"><label for="asl-pair">${esc(t('am.slot_pair'))}</label>`
    + `<select id="asl-pair" data-autofocus></select></div>`
    + `<div class="hint">${esc(t('am.slot_hint'))}</div>`;
}

function _footHtml(s: SlotState): string {
  const blocked = !canPlaceSlot();
  const disabled = blocked || s.candidates.length === 0;
  return `<button type="button" class="btn btn-ghost" data-asl-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" id="asl-place" data-asl-act="place"`
    + `${disabled ? ' disabled aria-disabled="true"' : ''}${blocked ? ` title="${esc(t('am.whatif_blocked'))}"` : ''}>${esc(t('am.slot_place'))}</button>`;
}

/** Fill the pair list from `_s.candidates`: the planner's own pick when still listed, else the best-ranked. */
function _renderPairs(): void {
  const s = _s;
  const sel = _el<HTMLSelectElement>('asl-pair');
  if (!s || !sel) return;
  if (!s.candidates.length) {
    sel.innerHTML = `<option value="">${esc(t('am.slot_none'))}</option>`;
    sel.value = '';
    sel.disabled = true;
    return;
  }
  const chosen = s.picked && s.candidates.some(c => c.value === s.picked) ? s.picked : s.candidates[0]!.value;
  sel.innerHTML = s.candidates.map(c =>
    `<option value="${esc(c.value)}"${c.value === chosen ? ' selected' : ''}>${esc(formatSlotOption(c))}</option>`).join('');
  sel.value = chosen;
  sel.disabled = false;
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
  _el('asl-body')?.addEventListener('change', e => {
    const target = e.target as (HTMLElement & { value?: string }) | null;
    if (target?.id === 'asl-pair' && _s) _s.picked = target.value ?? null;
    else if (target?.id === 'asl-day') AlertSlotModal.rerank();
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
  open(opts: { plant: string; taskId: string; alertId?: string }): void {
    const task = opts.plant && opts.taskId ? Store.tasks[opts.taskId] : undefined;
    if (!task) return;
    const day = _defaultDay(task, opts.plant);
    const s: SlotState = {
      plant: opts.plant, taskId: String(opts.taskId), alertId: opts.alertId, taskKey: slotTaskKey(task), day,
      candidates: rankSlotCandidates(task, day, liveSlotDeps), picked: null, busy: false,
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
    _el('asl-pair')?.focus();
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
    const fin = slotFinishFor(machine, s.day, slotSeams.workWindow, slotSeams.dayClosed, {
      needHours: cand.needHours, busy: (m, d) => liveSlotDeps.busyIntervals?.(m, d) ?? [],
      now: slotSeams.plantNow(s.plant), floorDay: _todayKey(s.plant),
    });
    if (!fin) { Toast.show(t('am.slot_no_window', { machine, day: s.day, days: SLOT_LOOKBACK_DAYS }), 'warn'); return; }
    s.busy = true;
    try {
      // "Fits" must mean a real gap: the totals can fit while the free time is cut up by other orders (not viaGap).
      const short = cand.needHours === null || cand.freeHours === null || cand.needHours > cand.freeHours || !fin.viaGap;
      if (fin.movedBack > 0 || short) {
        const ok = await Modal.confirm({
          tone: 'warn', title: t('am.slot_confirm_title'),
          message: fin.movedBack > 0
            ? t('am.slot_confirm_closed', { order: _orderLabel(first), machine, day: s.day, moved: fin.day })
            : t('am.slot_confirm_short', { order: _orderLabel(first), machine, day: s.day }),
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
      if (!wasFirmed) Store.setFirmed([id], true, 'alerts');
      UndoStack.push(t('am.slot_undo', { order: _orderLabel(cur) }), () => {
        UndoStack.restoreTasks(snap);   // strips `firmed` on purpose, so the firm is undone here, as its own write
        if (!wasFirmed) Store.setFirmed([id], false, 'undo');
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

  /** The top-ranked candidate for the order's default day (`null` when no pair is eligible). Synchronous and
   *  memoised per `${taskId}|${Store.dataRev()}`; the pane's Diagnose panel shows it with `formatSlotOption`. */
  suggest(task: NimbusTask, plant: string): SlotCandidate | null {
    const key = `${task.id}|${Store.dataRev()}`;
    if (_suggestMemo.has(key)) return _suggestMemo.get(key) ?? null;
    const top = rankSlotCandidates(task, _defaultDay(task, plant), liveSlotDeps)[0] ?? null;
    if (_suggestMemo.size >= _SUGGEST_MEMO_MAX) _suggestMemo.clear();
    _suggestMemo.set(key, top);
    return top;
  },

  /** The day `suggest` ranked for (the dialog's default day): the pane's Diagnose line names it. */
  suggestedDay(task: NimbusTask, plant: string): string {
    return _defaultDay(task, plant);
  },
};

// A plant change leaves the slot being composed meaningless, and every memo here is plant-scoped.
Store.subscribe(evt => {
  if (evt.type !== 'plant:selected') return;
  _suggestMemo.clear();
  _capMemo.clear();
  if (_s && _s.plant !== (evt.plant as string | null)) AlertSlotModal.close();
}, 'alert-slot-modal');
