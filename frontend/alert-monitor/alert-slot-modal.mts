/* =============================================================================
   ALERT SLOT MODAL — "◫ Slot…" on a Needs Planning row of the Alert Monitor.

   Recommends a (production version, machine) pair and a finish for a queued order, then places and firms it.
   The static shell (#modal-alert-slot) lives in index.html; this module fills the body (#asl-body) and footer
   (#asl-foot) at runtime and opens/closes it through Modal.open/close (the central focus trap). Modal.confirm
   stacks on top of it (the Override dialog and Engine.confirmOvertimePlacement do the same).

   Ranking (owner decision): the machine with the MOST FREE HOURS on the chosen day first, fits before
   non-fits. The day defaults to max(due day, plant today) and the planner can change it. Placing is
   finish-anchored: the finish is the end of the day's working window (a closed day is never handed to the
   engine, which refuses it: the dialog walks back up to SLOT_LOOKBACK_DAYS to the latest open window and
   confirms the move), the order is then firmed. Save stays explicit (dirty until Save; Undo works).

   The pure exports (ranking, finish walk-back, fingerprint, default day, option text) take their inputs as
   arguments and are Node-testable; the live reads of the classic-script globals (Table pair options, Timeline
   Go To, the signed-in check) go through `slotSeams` so tests need no browser.
   ========================================================================== */

import { Util } from '../platform/foundation.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import { normPv } from '../routing/runtime-client.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);

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

/** The three reads the ranking needs, injected so the ranking is pure. */
export interface SlotDeps {
  pairOptions(task: NimbusTask): Array<{ value: string; label: string }>;
  hoursFor(task: NimbusTask, pv: string | null, machine: string): number | null;
  dayCapacity(machine: string, day: string): { free: number; cap: number; closed: boolean } | null;
  resolveStep?(task: NimbusTask, pv: string | null, machine: string): string | undefined;
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

/** The finish to hand the engine for `machine` on `day` (YYYY-MM-DD): the END of that day's working window. The
 *  engine refuses a finish on a closed day (`finish_cannot_hold`), so a closed day walks back to the latest open
 *  window within SLOT_LOOKBACK_DAYS (`movedBack` counts the days walked). Null when no window is open in the
 *  window of days. `workWindow` is `Calendar.workWindow` (line hours intersected with the plant's). */
export function slotFinishFor(
  machine: string, day: string, workWindow: (line: string, date: Date) => [Date, Date] | null,
): { finish: Date; day: string; movedBack: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  for (let back = 0; back <= SLOT_LOOKBACK_DAYS; back++) {
    const date = new Date(y, mo, d - back);   // local midnight built from parts, so a DST change cannot skip a day
    const win = workWindow(machine, date);
    if (win && win[1].getTime() > win[0].getTime()) return { finish: win[1], day: Util.dayKey(date), movedBack: back };
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
 *  meaningful capacity, and the engine would place forward from now anyway). `plantToday` is a YYYY-MM-DD key. */
export function defaultSlotDay(task: NimbusTask, plantToday: string | Date): string {
  const today = typeof plantToday === 'string' && _DAY_RE.test(plantToday) ? plantToday : Util.dayKey(plantToday);
  const due = Util.dueDisplayDate(task);
  const dueDay = due ? Util.dayKey(due) : '';
  return dueDay && dueDay > today ? dueDay : today;
}

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
