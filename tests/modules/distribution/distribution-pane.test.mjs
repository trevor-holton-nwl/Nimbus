// Tests for frontend/distribution/distribution-pane.mjs (DistributionPane, P2-15).
// Only the pure, DOM-free logic is exercised here — badge severity ordering,
// the filter-state persistence round-trip, empty-state selection, and the
// nav-badge count formatting — per this task's "structure the module so
// filtering/badge-priority/empty-state-selection are pure, testable
// functions" instruction. No live-network / DOM tests: `Util.fetchTraced`
// call sites and DOM rendering are intentionally out of scope here (see the
// module's own header comment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPrimaryBadge,
  formatBadgeCount,
  DEFAULT_DISTRIBUTION_FILTERS,
  toPersistedFilters,
  fromPersistedFilters,
  selectEmptyState,
  filtersAreActive,
  formatSubOrders,
  reviewedCheckboxState,
  STATUS_SEVERITY,
} from '../../../frontend/distribution/distribution-pane.mjs';
// P2-16: the shares editor's pure logic module — weight math, dry-run
// merging, the save-button/undo/removal-confirm state machines. See that
// module's own header comment for why it's kept separate from
// distribution-pane.mjs (the most logic-heavy piece of the whole feature).
import {
  onlyThisMachine,
  evenWeights,
  quantityToWeight,
  resolvedWeight,
  buildSharesPayload,
  weightsSignature,
  dryRunSignature,
  mergeRowsWithDryRun,
  computeTotals,
  computeSaveButtonState,
  needsRemovalConfirm,
  sortRemovedFrozenFirst,
  isUndoDisabled,
  previousSharesToWeightMap,
  undoWeightMap,
  distErrorLocaleKey,
} from '../../../frontend/distribution/shares-editor.mjs';

test('pickPrimaryBadge — severity order picks the most severe status as primary', () => {
  // incomplete outranks everything else in STATUS_SEVERITY.
  assert.equal(pickPrimaryBadge(['needs_review', 'incomplete', 'qty_changed']).code, 'incomplete');
  // qty_changed outranks needs_review.
  assert.equal(pickPrimaryBadge(['needs_review', 'qty_changed']).code, 'qty_changed');
  // wc_changed (a "changed"/warn status) outranks needs_review (info).
  assert.equal(pickPrimaryBadge(['wc_changed', 'needs_review']).code, 'wc_changed');
  // purged is the least severe of the known codes.
  assert.equal(pickPrimaryBadge(['purged', 'needs_review']).code, 'needs_review');
});

test('pickPrimaryBadge — every non-primary status surfaces via extra, none dropped', () => {
  const { code, extra } = pickPrimaryBadge(['needs_review', 'incomplete', 'below_min_lot']);
  assert.equal(code, 'incomplete');
  assert.deepEqual([...extra].sort(), ['below_min_lot', 'needs_review'].sort());
});

test('pickPrimaryBadge — empty/undefined statuses produce a null, non-crashing result', () => {
  assert.deepEqual(pickPrimaryBadge([]), { code: null, tier: 'neutral', extra: [] });
  assert.deepEqual(pickPrimaryBadge(null), { code: null, tier: 'neutral', extra: [] });
  assert.deepEqual(pickPrimaryBadge(undefined), { code: null, tier: 'neutral', extra: [] });
});

test('pickPrimaryBadge — an unrecognized status code still wins the primary slot rather than being dropped', () => {
  const { code, extra } = pickPrimaryBadge(['some_future_status']);
  assert.equal(code, 'some_future_status');
  assert.deepEqual(extra, []);
});

test('pickPrimaryBadge — tier reflects the §6 err/warn/info/neutral grouping', () => {
  assert.equal(pickPrimaryBadge(['incomplete']).tier, 'err');
  assert.equal(pickPrimaryBadge(['wc_changed']).tier, 'warn');
  assert.equal(pickPrimaryBadge(['needs_review']).tier, 'info');
  assert.equal(pickPrimaryBadge(['purged']).tier, 'neutral');
});

test('STATUS_SEVERITY carries every status code compute_derived_statuses can emit, plus separation_violated', () => {
  const expected = [
    'incomplete', 'runtime_mismatch', 'separation_violated',
    'wc_changed', 'membership_changed', 'mode_mismatch', 'qty_changed',
    'below_min_lot', 'zero_quantity_children', 'needs_review', 'purged',
  ];
  assert.deepEqual([...STATUS_SEVERITY], expected);
});

test('formatBadgeCount — hides at zero/negative/missing, caps at 99+', () => {
  assert.equal(formatBadgeCount(0), null);
  assert.equal(formatBadgeCount(-1), null);
  assert.equal(formatBadgeCount(null), null);
  assert.equal(formatBadgeCount(undefined), null);
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(42), '42');
  assert.equal(formatBadgeCount(99), '99');
  assert.equal(formatBadgeCount(100), '99+');
  assert.equal(formatBadgeCount(4321), '99+');
});

test('filter-state persistence round trip — batch is stripped, everything else survives', () => {
  const live = { search: 'ORD-1', workcenter: 'WC-01', bucket: 'changed', from: '2026-09-01', to: '2026-09-30' };
  const persisted = toPersistedFilters(live);
  assert.deepEqual(persisted, live);
  assert.ok(!('batch' in persisted), 'batch must never be part of the persisted shape');

  const restored = fromPersistedFilters(persisted);
  assert.deepEqual(restored, live);
});

test('filter-state persistence round trip — a null/missing pref resolves to the defaults', () => {
  assert.deepEqual(fromPersistedFilters(null), { ...DEFAULT_DISTRIBUTION_FILTERS });
  assert.deepEqual(fromPersistedFilters(undefined), { ...DEFAULT_DISTRIBUTION_FILTERS });
  assert.deepEqual(fromPersistedFilters({}), { ...DEFAULT_DISTRIBUTION_FILTERS });
});

test('filter-state persistence round trip — a partial/stale saved blob merges over the defaults rather than losing fields', () => {
  const restored = fromPersistedFilters({ search: 'abc' });
  assert.deepEqual(restored, { ...DEFAULT_DISTRIBUTION_FILTERS, search: 'abc' });
});

test('filter-state persistence round trip — a batch key smuggled into a saved blob is still dropped on restore', () => {
  // toPersistedFilters is the real guard, but fromPersistedFilters must also
  // never manufacture a `batch` field even if one is present in a legacy/
  // corrupted saved object, since DistributionFilters has no such field.
  const restored = fromPersistedFilters({ search: 'x', batch: 'sneaky' });
  assert.ok(!('batch' in restored));
  assert.equal(restored.search, 'x');
});

test('selectEmptyState — no distribute-mode work center always wins, even with matching orders', () => {
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: false, total: 5, filtersActive: false }), 'no_workcenters');
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: false, total: 0, filtersActive: true }), 'no_workcenters');
});

test('selectEmptyState — a plant with a distribute work center but zero headers at all is "no_orders"', () => {
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: true, total: 0, filtersActive: false }), 'no_orders');
});

test('selectEmptyState — zero headers under an active filter is "no_match", not "no_orders"', () => {
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: true, total: 0, filtersActive: true }), 'no_match');
});

test('selectEmptyState — any matching header means no empty state at all', () => {
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: true, total: 1, filtersActive: true }), null);
  assert.equal(selectEmptyState({ hasDistributeWorkcenter: true, total: 12, filtersActive: false }), null);
});

test('filtersAreActive — default bucket alone counts as active (matches selectEmptyState "no_match" semantics)', () => {
  assert.equal(filtersAreActive({ ...DEFAULT_DISTRIBUTION_FILTERS }, null), true);
});

test('filtersAreActive — bucket "all" with nothing else set is inactive', () => {
  assert.equal(filtersAreActive({ ...DEFAULT_DISTRIBUTION_FILTERS, bucket: 'all' }, null), false);
});

test('filtersAreActive — a batch chip alone makes filters active even at bucket "all"', () => {
  assert.equal(filtersAreActive({ ...DEFAULT_DISTRIBUTION_FILTERS, bucket: 'all' }, 'batch-123'), true);
});

test('formatSubOrders — a single bare 100% child (no letters) renders as the count', () => {
  assert.equal(formatSubOrders([{ machine: 'M1', letter: null, weight: 100, child_id: 'c1' }]), '1');
});

test('formatSubOrders — a distributed header renders "count · letters"', () => {
  const shares = [
    { machine: 'M1', letter: 'A', weight: 40, child_id: 'c1' },
    { machine: 'M2', letter: 'B', weight: 35, child_id: 'c2' },
    { machine: 'M3', letter: 'C', weight: 25, child_id: 'c3' },
  ];
  assert.equal(formatSubOrders(shares), '3 · A B C');
});

test('formatSubOrders — zero-weight and purged shares are excluded from the count', () => {
  const shares = [
    { machine: 'M1', letter: 'A', weight: 100, child_id: 'c1' },
    { machine: 'M2', letter: 'B', weight: 0, child_id: null },
    { machine: 'M3', letter: 'C', weight: 50, child_id: 'c3', purged_at: '2026-09-01' },
  ];
  assert.equal(formatSubOrders(shares), '1');
});

test('formatSubOrders — empty/missing shares never throw', () => {
  assert.equal(formatSubOrders([]), '1');
  assert.equal(formatSubOrders(null), '1');
  assert.equal(formatSubOrders(undefined), '1');
});

test('reviewedCheckboxState — unreviewed is unchecked', () => {
  assert.equal(reviewedCheckboxState({ reviewed: false }, ['needs_review']), 'unchecked');
});

test('reviewedCheckboxState — reviewed with no drift is checked', () => {
  assert.equal(reviewedCheckboxState({ reviewed: true }, []), 'checked');
});

test('reviewedCheckboxState — reviewed but qty_changed is indeterminate, regardless of the reviewed flag', () => {
  assert.equal(reviewedCheckboxState({ reviewed: true }, ['qty_changed']), 'indeterminate');
  assert.equal(reviewedCheckboxState({ reviewed: false }, ['qty_changed']), 'indeterminate');
});

/* ============================================================================
   P2-16 — shares-editor.mjs pure logic
   ========================================================================== */

test('onlyThisMachine — target gets weight 1, every other machine is explicitly zeroed', () => {
  const out = onlyThisMachine(['M1', 'M2', 'M3'], 'M2');
  assert.deepEqual(out, { M1: 0, M2: 1, M3: 0 });
});

test('evenWeights — clears every row to null (resolves to an equal implicit share later)', () => {
  assert.deepEqual(evenWeights(['M1', 'M2']), { M1: null, M2: null });
});

test('quantityToWeight — q===0 always gives weight 0, regardless of Q/othersWeightSum', () => {
  assert.equal(quantityToWeight(0, 1000, 2), 0);
});

test('quantityToWeight — q >= Q, or othersWeightSum===0, gives "all" (maps to Only-this-machine, not a division by zero)', () => {
  assert.equal(quantityToWeight(1000, 1000, 2), 'all');
  assert.equal(quantityToWeight(1200, 1000, 2), 'all');
  assert.equal(quantityToWeight(300, 1000, 0), 'all');
});

test('quantityToWeight — otherwise, solves for the relative weight that reproduces the typed quantity\'s share of Q', () => {
  // 300 of 1,000 with two other rows at weight 1 each (sum 2) => ~0.857,
  // which alongside that sum of 2 is 0.857/2.857 ≈ 30% — matching 300/1000.
  const w = quantityToWeight(300, 1000, 2);
  assert.ok(Math.abs(w - 300 * 2 / 700) < 1e-9, `expected ≈${300 * 2 / 700}, got ${w}`);
  assert.ok(Math.abs(w - 0.857142857) < 1e-6);
});

test('quantityToWeight — refuses negative/non-finite qty rather than silently producing a bad weight', () => {
  assert.throws(() => quantityToWeight(-1, 1000, 2), RangeError);
  assert.throws(() => quantityToWeight(NaN, 1000, 2), RangeError);
  assert.throws(() => quantityToWeight(Infinity, 1000, 2), RangeError);
});

test('resolvedWeight — a purged row is ALWAYS 0 regardless of its (inert) input value', () => {
  assert.equal(resolvedWeight(5, true), 0);
  assert.equal(resolvedWeight(null, true), 0);
});

test('resolvedWeight — an unset (null) row resolves to 1 (the "Even"/blank-row convention)', () => {
  assert.equal(resolvedWeight(null, false), 1);
  assert.equal(resolvedWeight(undefined, false), 1);
});

test('resolvedWeight — an explicit weight (including 0) is sent as-is when not purged', () => {
  assert.equal(resolvedWeight(0, false), 0);
  assert.equal(resolvedWeight(7, false), 7);
});

test('buildSharesPayload — By-quantity conversion end to end: typed quantities become the wire shares payload', () => {
  const rows = [
    { machine: 'M1', weight: quantityToWeight(300, 1000, 1), purged: false },
    { machine: 'M2', weight: quantityToWeight(700, 1000, 1), purged: false },
  ];
  const payload = buildSharesPayload(rows);
  assert.equal(payload[0].machine, 'M1');
  assert.ok(Math.abs(payload[0].weight - (300 / 700)) < 1e-9);
  assert.equal(payload[1].machine, 'M2');
  assert.ok(Math.abs(payload[1].weight - (700 / 300)) < 1e-9);
});

test('buildSharesPayload — Only-this-machine end to end', () => {
  const weights = onlyThisMachine(['M1', 'M2', 'M3'], 'M3');
  const rows = ['M1', 'M2', 'M3'].map(machine => ({ machine, weight: weights[machine], purged: false }));
  assert.deepEqual(buildSharesPayload(rows), [
    { machine: 'M1', weight: 0 },
    { machine: 'M2', weight: 0 },
    { machine: 'M3', weight: 1 },
  ]);
});

test('weightsSignature — order-independent and stable for identical weight maps', () => {
  const a = [{ machine: 'M2', weight: 5, purged: false }, { machine: 'M1', weight: null, purged: false }];
  const b = [{ machine: 'M1', weight: null, purged: false }, { machine: 'M2', weight: 5, purged: false }];
  assert.equal(weightsSignature(a), weightsSignature(b));
});

test('weightsSignature — a changed weight produces a different signature', () => {
  const a = [{ machine: 'M1', weight: 1, purged: false }];
  const b = [{ machine: 'M1', weight: 2, purged: false }];
  assert.notEqual(weightsSignature(a), weightsSignature(b));
});

/* --- Dry-run preview identity (D09) --------------------------------------- */

test('dryRunSignature — differs per order and per material even with identical weights', () => {
  const rows = [{ machine: 'M1', weight: 1, purged: false }];
  const headerA = { production_order: '100', material_number: 'MAT', base_version: 1 };
  const headerB = { production_order: '200', material_number: 'MAT', base_version: 1 };
  const headerC = { production_order: '100', material_number: 'OTHER', base_version: 1 };
  assert.notEqual(dryRunSignature(headerA, rows), dryRunSignature(headerB, rows));
  assert.notEqual(dryRunSignature(headerA, rows), dryRunSignature(headerC, rows));
});

test('dryRunSignature — differs per base_version, so a write that moves the header invalidates a prior settled preview', () => {
  const rows = [{ machine: 'M1', weight: 1, purged: false }];
  const header = { production_order: '100', material_number: 'MAT', base_version: 1 };
  const headerAfterWrite = { ...header, base_version: 2 };
  assert.notEqual(dryRunSignature(header, rows), dryRunSignature(headerAfterWrite, rows));
});

test('dryRunSignature — identical header and weights produce the same signature', () => {
  const rows = [{ machine: 'M2', weight: 5, purged: false }, { machine: 'M1', weight: null, purged: false }];
  const header = { production_order: '100', material_number: 'MAT', base_version: 1 };
  assert.equal(dryRunSignature(header, rows), dryRunSignature({ ...header }, [...rows]));
});

const DRY_RUN_FIXTURE = {
  plan: [
    { machine: 'M1', letter: 'A', weight: 1, effective_pct: 60, qty_before: 50, qty_after: 60,
      hours_before: 5, hours_after: 6, outcome: 'resized', scheduled: true, frozen: false, below_min_lot: false },
    { machine: 'M2', letter: 'B', weight: 0, effective_pct: 0, qty_before: 50, qty_after: null,
      hours_before: 5, hours_after: null, outcome: 'removed', scheduled: true, frozen: true, below_min_lot: false },
    { machine: 'M3', letter: 'C', weight: 1, effective_pct: 40, qty_before: null, qty_after: 40,
      hours_before: null, hours_after: 4, outcome: 'new', scheduled: false, frozen: false, below_min_lot: true },
  ],
  removed_scheduled: [
    { id: 'child-2', production_order: 'B-1000', machine: 'M2', scheduled_start: '2026-09-20T08:00:00', frozen: true },
  ],
  base_version: 42,
};

test('mergeRowsWithDryRun — outcome derivation zips each row with its matching dry-run plan entry', () => {
  const rows = [
    { machine: 'M1', letter: 'A', weight: 1, purged: false, stale: false, currentStart: '2026-09-18T06:00:00' },
    { machine: 'M2', letter: 'B', weight: 0, purged: false, stale: false, currentStart: '2026-09-18T06:00:00' },
    { machine: 'M3', letter: 'C', weight: 1, purged: false, stale: false, currentStart: null },
  ];
  const view = mergeRowsWithDryRun(rows, DRY_RUN_FIXTURE);
  assert.equal(view[0].outcome, 'resized');
  assert.equal(view[0].effectivePct, 60);
  assert.equal(view[0].qtyAfter, 60);
  assert.equal(view[1].outcome, 'removed');
  assert.equal(view[1].frozen, true);
  assert.equal(view[2].outcome, 'new');
  assert.equal(view[2].belowMinLot, true);
});

test('mergeRowsWithDryRun — a row with no matching plan entry (dry run pending/failed) renders null/false, not a crash', () => {
  const rows = [{ machine: 'M9', letter: 'Z', weight: null, purged: false, stale: false, currentStart: null }];
  const view = mergeRowsWithDryRun(rows, null);
  assert.deepEqual(view[0], {
    machine: 'M9', letter: 'Z', weight: null, purged: false, stale: false, currentStart: null,
    effectivePct: null, qtyAfter: null, hoursAfter: null, outcome: null, scheduled: false, frozen: false, belowMinLot: false,
  });
});

test('computeTotals — sums every numeric column across the current row view', () => {
  const rows = [
    { machine: 'M1', letter: 'A', weight: 1, purged: false, stale: false, currentStart: null },
    { machine: 'M2', letter: 'B', weight: 0, purged: false, stale: false, currentStart: null },
    { machine: 'M3', letter: 'C', weight: 1, purged: false, stale: false, currentStart: null },
  ];
  const view = mergeRowsWithDryRun(rows, DRY_RUN_FIXTURE);
  const totals = computeTotals(view);
  assert.equal(totals.weight, 2);
  assert.equal(totals.effectivePct, 100);
  assert.equal(totals.qtyAfter, 100);
  assert.equal(totals.hoursAfter, 10);
});

/* --- Save-button disabled-until-dry-run-settles state machine ----------- */

test('computeSaveButtonState — disabled while the dry run is pending/idle/error', () => {
  for (const dryRunStatus of ['idle', 'pending', 'error']) {
    const state = computeSaveButtonState({
      dryRunStatus, dryRunSignature: 'sig-a', currentSignature: 'sig-a',
      removedScheduledCount: 0, whatIfBlocked: false,
    });
    assert.equal(state.disabled, true, `expected disabled for status ${dryRunStatus}`);
  }
});

test('computeSaveButtonState — enabled once ready AND the dry-run signature matches the current inputs', () => {
  const state = computeSaveButtonState({
    dryRunStatus: 'ready', dryRunSignature: 'sig-a', currentSignature: 'sig-a',
    removedScheduledCount: 0, whatIfBlocked: false,
  });
  assert.equal(state.disabled, false);
  assert.equal(state.labelKey, 'ui.dist_save_plain');
});

test('computeSaveButtonState — ready but STALE (a keystroke moved the inputs after the dry run settled) stays disabled', () => {
  const state = computeSaveButtonState({
    dryRunStatus: 'ready', dryRunSignature: 'sig-a', currentSignature: 'sig-b',
    removedScheduledCount: 0, whatIfBlocked: false,
  });
  assert.equal(state.disabled, true);
});

test('computeSaveButtonState — the What-If guard disables Save even when the dry run is ready and matching', () => {
  const state = computeSaveButtonState({
    dryRunStatus: 'ready', dryRunSignature: 'sig-a', currentSignature: 'sig-a',
    removedScheduledCount: 0, whatIfBlocked: true,
  });
  assert.equal(state.disabled, true);
});

test('computeSaveButtonState — label switches to the removal-count variant once the settled preview shows removals', () => {
  const state = computeSaveButtonState({
    dryRunStatus: 'ready', dryRunSignature: 'sig-a', currentSignature: 'sig-a',
    removedScheduledCount: 3, whatIfBlocked: false,
  });
  assert.equal(state.disabled, false);
  assert.equal(state.labelKey, 'ui.dist_save_removes');
  assert.equal(state.removedCount, 3);
});

/* --- Removal-confirm gating ---------------------------------------------- */

test('needsRemovalConfirm — false for an empty removal list, true otherwise', () => {
  assert.equal(needsRemovalConfirm([]), false);
  assert.equal(needsRemovalConfirm([{ frozen: false }]), true);
});

test('sortRemovedFrozenFirst — frozen removals are listed before non-frozen ones', () => {
  const removed = [
    { id: 'a', frozen: false }, { id: 'b', frozen: true }, { id: 'c', frozen: false }, { id: 'd', frozen: true },
  ];
  const sorted = sortRemovedFrozenFirst(removed);
  assert.deepEqual(sorted.map(r => r.id), ['b', 'd', 'a', 'c']);
  // Original array is untouched (pure function).
  assert.deepEqual(removed.map(r => r.id), ['a', 'b', 'c', 'd']);
});

/* --- Undo-disabled-after-base_version-moved ------------------------------ */

test('isUndoDisabled — disabled when there is nothing to undo yet', () => {
  assert.equal(isUndoDisabled(null, 42), true);
});

test('isUndoDisabled — disabled when the current header base_version is unknown', () => {
  assert.equal(isUndoDisabled(42, null), true);
});

test('isUndoDisabled — enabled immediately after our own write (versions match)', () => {
  assert.equal(isUndoDisabled(42, 42), false);
});

test('isUndoDisabled — disabled once the header moved to a NEWER base_version (another write happened after)', () => {
  assert.equal(isUndoDisabled(42, 43), true);
});

test('previousSharesToWeightMap — converts a captured previous_shares snapshot back into a weight map', () => {
  const previousShares = [{ machine: 'M1', letter: 'A', weight: 30 }, { machine: 'M2', letter: 'B', weight: null }];
  assert.deepEqual(previousSharesToWeightMap(previousShares), { M1: 30, M2: null });
});

/* --- Undo weight map (D46) ------------------------------------------------ */

test('undoWeightMap — restores each current machine\'s previous weight, or 0 for one the last write added', () => {
  const previousShares = [{ machine: 'M1', weight: 5 }, { machine: 'M2', weight: null }];
  // M3 has no entry in previousShares — the last write added it — so Undo
  // zeroes it rather than falling through to its current (post-write) weight.
  assert.deepEqual(undoWeightMap(previousShares, ['M1', 'M2', 'M3']), { M1: 5, M2: null, M3: 0 });
});

/* --- Error mapping -------------------------------------------------------- */

test('distErrorLocaleKey — builds the err.dist_<code> key, or null for no code', () => {
  assert.equal(distErrorLocaleKey('share_purged'), 'err.dist_share_purged');
  assert.equal(distErrorLocaleKey(null), null);
  assert.equal(distErrorLocaleKey(undefined), null);
});
