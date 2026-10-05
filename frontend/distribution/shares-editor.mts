// distribution/shares-editor.mts — pure, DOM-free logic behind the Order
// Distribution shares editor (P2-16, aggregate_to_detail.md §6 "The shares
// editor (decision K)"). Kept as its own module (rather than folded into
// distribution-pane.mts, which stays the DOM/Store-facing shell) because this
// is the most logic-heavy piece of the whole feature: weight math (Only this
// machine / Even / By quantity), merging a dry-run response onto the
// planner's current row state, the Save-button disabled-until-settled state
// machine, the removal-confirm gating, and the Undo-disabled-after-
// base_version-moved check. Every export here is a pure function or a plain
// type — no DOM, no Store, no network, no Util/foundation import — so
// tests/modules/distribution/distribution-pane.test.mjs (extended for P2-16)
// can exercise all of it without any fetch/DOM mocking.
//
// Wire shapes match backend/distribution/data.py's `_materialize_reweight`
// preview and `_read_write_children` committed response. Children carry
// canonical schedule aggregates and editable attributes in lowercase;
// distribution-pane hydrates them through the shared task decoder.

/** One row of a dry run's (or a real write's) `plan` array — verified against
 *  `_materialize_reweight`'s `plan_entries.append({...})` (data.py ~line 2480). */
export interface DryRunPlanEntry {
  machine: string;
  letter: string;
  weight: number;
  effective_pct: number;
  qty_before: number | null;
  qty_after: number | null;
  hours_before: number | null;
  hours_after: number | null;
  outcome: 'unchanged' | 'resized' | 'new' | 'removed';
  scheduled: boolean;
  frozen: boolean;
  below_min_lot: boolean;
}

/** One entry of a dry run's (or a 409 `children_scheduled`'s) removed-child
 *  list — verified against `_materialize_reweight`'s `scheduled_removed`/
 *  `DistributionChildrenScheduled.children` shape. */
export interface RemovedScheduledEntry {
  id: string;
  production_order: string;
  machine: string;
  scheduled_start: string | null;
  frozen: boolean;
}

/** `POST .../shares` or `.../reset` with `dry_run: true` (data.py ~line 2488). */
export interface DryRunResult {
  plan: DryRunPlanEntry[];
  removed_scheduled: RemovedScheduledEntry[];
  base_version: number;
}

/** One child in a REAL write's response — see this file's header note: this
 *  is NOT the `/tasks` TaskDTO shape. */
export interface WriteResultChild {
  id: string;
  production_order: string;
  plant: string;
  material_number: string;
  material_description: string | null;
  machine: string;
  order_quantity: number | null;
  run_time: number | null;
  labor_hours: number | null;
  machine_hours: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  start_date: string | null;
  end_date: string | null;
  basic_start_date: string | null;
  basic_finish_date: string | null;
  notes: string | null;
  planning_status: string | null;
  planning_reason: unknown;
  distribution_letter: string | null;
  parent_production_order: string | null;
  base_version: number;
  schedule_segments: Array<{ sequence: number; start_date: string; end_date: string }>;
  runtime_schedule_mismatch: boolean;
  run_time_source: string | null;
  run_time_basis: Record<string, unknown> | null;
  prt_01: string | null;
  prt_02: string | null;
  production_version: string | null;
  firming_indicator: string | null;
  color: string | null;
  form_size: string | null;
}

/** A real (non-dry-run) `.../shares` or `.../reset` write response
 *  (data.py's `_materialize_reweight` real-write return, ~line 2574). */
export interface WriteResult {
  status: 'ok';
  children: WriteResultChild[];
  removed: string[];
  previous_shares: Array<{ machine: string; letter: string | null; weight: number | null }>;
  versions: Record<string, number>;
  base_version: number;
}

/* ============================================================================
   Weight math — Only this machine / Even / By quantity.

   Weights are RELATIVE (aggregate_to_detail.md §6: "typing never rewrites
   another row"). `null` in the editor's weight map means "not explicitly
   set" and resolves to 1 at payload-build time (an even implicit share among
   every row left blank) — mirroring the exact same null-means-"even"
   convention `backend/distribution/data.py`'s `_clean_weights` already uses
   for the WORK-CENTER POLICY's weights (aggregate_to_detail.md §3.2), even
   though the per-order `_validate_share_payload` itself treats a literal
   `None` weight as 0 (not "even") — this module reproduces the *policy*
   convention client-side by resolving a blank input to 1 before it is ever
   sent, so the wire payload this module builds never actually contains a
   null. A row the planner explicitly zeroes (typed "0") is sent as a real 0
   and is excluded from the resulting distribution, same as today.
   ========================================================================== */

export type WeightMap = Record<string, number | null>;

/** "Only this machine" — target gets a weight of 1 (any positive value would
 *  do, since weights are relative), every other row is explicitly zeroed. */
export function onlyThisMachine(machines: readonly string[], target: string): WeightMap {
  const out: WeightMap = {};
  for (const m of machines) out[m] = m === target ? 1 : 0;
  return out;
}

/** "Even" — clears every row's weight back to unset (null), which resolves
 *  to an equal implicit share (1) for every non-purged row at payload-build
 *  time (see `resolvedWeight`). */
export function evenWeights(machines: readonly string[]): WeightMap {
  const out: WeightMap = {};
  for (const m of machines) out[m] = null;
  return out;
}

/** "By quantity" toggle's on-blur conversion (§6: "converted to weights on
 *  blur"). D35: weights are RELATIVE, so a typed target quantity cannot
 *  convert 1:1 (that silently misweighted every row but the one being
 *  typed) — it must be solved for the weight that, alongside the OTHER
 *  rows' current (already-relative) weight total, reproduces the typed
 *  quantity's share of the header's total order quantity `Q`:
 *  `weight = qty * othersWeightSum / (Q - qty)`. `qty === 0` is simply 0 (no
 *  share). `qty >= Q`, or every other row already explicitly zeroed
 *  (`othersWeightSum === 0`, which would otherwise divide by the remaining
 *  weight budget of zero), has no finite relative weight that expresses "all
 *  of it" — the caller maps that case to `onlyThisMachine` instead (the
 *  literal "all of it" state) rather than this function returning `Infinity`.
 *  Non-finite or negative `qty` has no sane weight at all; callers should
 *  not call this for such input (kept as a hard boundary rather than
 *  silently clamping, so a caller bug is loud instead of silently producing
 *  a bad row). */
export function quantityToWeight(qty: number, totalQty: number, othersWeightSum: number): number | 'all' {
  if (!Number.isFinite(qty) || qty < 0) {
    throw new RangeError(`quantityToWeight: qty must be a finite, non-negative number, got ${qty}`);
  }
  if (qty === 0) return 0;
  if (qty >= totalQty || othersWeightSum === 0) return 'all';
  return qty * othersWeightSum / (totalQty - qty);
}

/** A row's weight as it will actually be sent on the wire: a purged row is
 *  ALWAYS 0 regardless of its (inert, greyed-out) input value — the backend
 *  refuses a positive weight on a purged share (400 `share_purged`) — and an
 *  unset (`null`) row resolves to 1 (see the module header's "Even" note). */
export function resolvedWeight(weight: number | null | undefined, purged: boolean): number {
  if (purged) return 0;
  return weight == null ? 1 : weight;
}

export interface WeightRow {
  machine: string;
  weight: number | null;
  purged: boolean;
}

/** Build the `{shares: [{machine, weight}]}` payload's `shares` array from
 *  the editor's current per-row weight state. */
export function buildSharesPayload(rows: readonly WeightRow[]): Array<{ machine: string; weight: number }> {
  return rows.map(r => ({ machine: r.machine, weight: resolvedWeight(r.weight, r.purged) }));
}

/** A stable, order-independent signature of the CURRENT weight inputs, used
 *  to tell whether a completed dry run's response still corresponds to what
 *  the planner has typed (the debounce can settle after a further keystroke
 *  moved the inputs again). */
export function weightsSignature(rows: readonly WeightRow[]): string {
  return buildSharesPayload(rows)
    .map(r => `${r.machine}=${r.weight}`)
    .sort()
    .join('|');
}

/** The identifying fields of a header a dry run is priced against — just
 *  enough of `DistHeader` (which lives in distribution-pane.mts, not this
 *  DOM-free module) for `dryRunSignature` to key on. */
export interface DryRunSignatureHeader {
  production_order: string;
  material_number: string;
  base_version: number;
}

/** D09 — a dry run is priced for a specific HEADER (order/material/
 *  base_version) as well as a specific set of weight inputs; `weightsSignature`
 *  alone can't tell two different orders' previews apart (nor the same order
 *  before/after a `base_version`-moving write), so a dry run settled for one
 *  header/base_version could otherwise be mistaken for "ready" against a
 *  different one the planner has since switched to or written. Composed as
 *  `production_order|material_number|base_version#<weightsSignature>` so it
 *  changes on every axis that actually invalidates a previously-settled
 *  preview. */
export function dryRunSignature(header: DryRunSignatureHeader, rows: readonly WeightRow[]): string {
  return `${header.production_order}|${header.material_number}|${header.base_version}#${weightsSignature(rows)}`;
}

/* ============================================================================
   Row view — merging static row facts with a dry run's per-machine plan.
   ========================================================================== */

export interface EditorRowBase {
  machine: string;
  letter: string | null;
  weight: number | null;
  purged: boolean;
  /** A share whose machine is not a current work-center member, or no
   *  longer exists (aggregate_to_detail.md §5.7's "stale" share). */
  stale: boolean;
  /** The LIVE child's current effective start, if any (detail route's
   *  `shares[].start`) — the editor's read-only "Current start" column. */
  currentStart: string | null;
}

export interface EditorRowView extends EditorRowBase {
  effectivePct: number | null;
  qtyAfter: number | null;
  hoursAfter: number | null;
  outcome: DryRunPlanEntry['outcome'] | null;
  scheduled: boolean;
  frozen: boolean;
  belowMinLot: boolean;
}

/** Zip the editor's static per-row facts (letter, current weight input,
 *  purged/stale, current start) with the matching per-machine entry from the
 *  last dry run, if any — a row with no matching entry yet (dry run still
 *  pending, or failed) renders with every derived field null/false rather
 *  than throwing. Pure — never mutates `rows`. */
export function mergeRowsWithDryRun(
  rows: readonly EditorRowBase[],
  dryRun: DryRunResult | null,
): EditorRowView[] {
  const byMachine = new Map((dryRun?.plan || []).map(p => [p.machine, p]));
  return rows.map(row => {
    const p = byMachine.get(row.machine);
    return {
      ...row,
      effectivePct: p ? p.effective_pct : null,
      qtyAfter: p ? p.qty_after : null,
      hoursAfter: p ? p.hours_after : null,
      outcome: p ? p.outcome : null,
      scheduled: p ? p.scheduled : false,
      frozen: p ? p.frozen : false,
      belowMinLot: p ? p.below_min_lot : false,
    };
  });
}

export interface TotalsRow {
  weight: number;
  effectivePct: number;
  qtyAfter: number;
  hoursAfter: number;
  /** `qtyAfter` minus the header's `order_quantity` -- null until a dry run
   *  has settled (every row's `qtyAfter` is still null before then) or when
   *  no `order_quantity` was supplied. Positive means the split's summed
   *  quantity exceeds SAP's order quantity, which the owner's round-up-only
   *  quantity rule (decision H) explicitly allows. Display only, never a
   *  save-blocking error. */
  qtyDeltaVsSap: number | null;
}

/** The editor's TOTAL row — sums every numeric column across the CURRENT row
 *  view set (labor-planning.mts's `lp-total-row` shape, per §6). */
export function computeTotals(rows: readonly EditorRowView[], orderQuantity?: number | null): TotalsRow {
  const totals: TotalsRow = { weight: 0, effectivePct: 0, qtyAfter: 0, hoursAfter: 0, qtyDeltaVsSap: null };
  let dryRunSettled = false;
  for (const r of rows) {
    totals.weight += r.weight == null ? 0 : r.weight;
    totals.effectivePct += r.effectivePct || 0;
    totals.qtyAfter += r.qtyAfter || 0;
    totals.hoursAfter += r.hoursAfter || 0;
    if (r.qtyAfter != null) dryRunSettled = true;
  }
  if (dryRunSettled && typeof orderQuantity === 'number' && Number.isFinite(orderQuantity)) {
    totals.qtyDeltaVsSap = Math.round((totals.qtyAfter - orderQuantity) * 1000) / 1000;
  }
  return totals;
}

/* ============================================================================
   Save-button state machine (§6 "Save flow": disabled until a dry run for
   the CURRENT inputs has returned).
   ========================================================================== */

export type DryRunStatus = 'idle' | 'pending' | 'ready' | 'error';

export interface SaveButtonState {
  disabled: boolean;
  removedCount: number;
  labelKey: 'ui.dist_save_plain' | 'ui.dist_save_removes';
}

export interface SaveButtonInput {
  dryRunStatus: DryRunStatus;
  /** The weights signature the last COMPLETED dry run was computed for, or
   *  null if none has completed yet. */
  dryRunSignature: string | null;
  /** The signature of the CURRENT (possibly newer than the last dry run)
   *  weight inputs. */
  currentSignature: string;
  removedScheduledCount: number;
  /** `Sandbox.active` — What-If guard (§6 "What-If"), a hard disable
   *  regardless of dry-run state. */
  whatIfBlocked: boolean;
}

/** Save is enabled only once a dry run has completed AND its signature still
 *  matches the CURRENT inputs (a dry run that settled for an now-stale set
 *  of weights must not enable Save for a different, unpriced set). */
export function computeSaveButtonState(input: SaveButtonInput): SaveButtonState {
  const settled = input.dryRunStatus === 'ready' && input.dryRunSignature === input.currentSignature;
  return {
    disabled: input.whatIfBlocked || !settled,
    removedCount: input.removedScheduledCount,
    labelKey: input.removedScheduledCount > 0 ? 'ui.dist_save_removes' : 'ui.dist_save_plain',
  };
}

/* ============================================================================
   Removal-confirm gating (§6 "Save flow": removals first show
   Modal.confirm, frozen ones listed first).
   ========================================================================== */

export function needsRemovalConfirm(removed: readonly { frozen: boolean }[]): boolean {
  return removed.length > 0;
}

/** Frozen removals first, stable otherwise (Array.prototype.sort is a stable
 *  sort in every engine this app targets). */
export function sortRemovedFrozenFirst<T extends { frozen: boolean }>(removed: readonly T[]): T[] {
  return [...removed].sort((a, b) => Number(b.frozen) - Number(a.frozen));
}

/* ============================================================================
   Undo — "re-posts the previous_shares the last write response returned...
   disabled once the header's base_version has moved" (§6).
   ========================================================================== */

/** True when there is nothing to undo yet, OR the header's current
 *  `base_version` no longer matches the version the last write produced —
 *  meaning a further write (by this planner or someone else) has happened
 *  since, so blindly re-posting the captured `previous_shares` could clobber
 *  that newer edit. */
export function isUndoDisabled(lastWriteBaseVersion: number | null, currentBaseVersion: number | null): boolean {
  if (lastWriteBaseVersion == null || currentBaseVersion == null) return true;
  return currentBaseVersion !== lastWriteBaseVersion;
}

/** Convert a captured `previous_shares` snapshot back into a weight map an
 *  Undo write can send as its `shares` payload. */
export function previousSharesToWeightMap(
  previousShares: readonly { machine: string; weight: number | null }[],
): WeightMap {
  const out: WeightMap = {};
  for (const s of previousShares) out[s.machine] = s.weight;
  return out;
}

/** D46 — Undo's weight map, built against the CURRENT row set rather than
 *  blindly reposting `previousShares` (`previousSharesToWeightMap`'s job):
 *  a machine the last write ADDED has no entry in `previousShares` at all
 *  (it didn't exist before that write), so naively looking it up would fall
 *  through to the editor's current (post-write) weight instead of being
 *  undone — this gives it an explicit 0 (the undo state "this machine wasn't
 *  part of the distribution") for any machine `previousShares` doesn't
 *  mention. */
export function undoWeightMap(
  previousShares: readonly { machine: string; weight: number | null }[],
  currentMachines: readonly string[],
): WeightMap {
  const prev = new Map(previousShares.map(s => [s.machine, s.weight]));
  const out: WeightMap = {};
  for (const m of currentMachines) out[m] = prev.has(m) ? prev.get(m)! : 0;
  return out;
}

/* ============================================================================
   Error mapping (§6 "Errors": code -> err.dist_<code>, fallback to message).
   ========================================================================== */

export function distErrorLocaleKey(code: string | null | undefined): string | null {
  return code ? `err.dist_${code}` : null;
}
