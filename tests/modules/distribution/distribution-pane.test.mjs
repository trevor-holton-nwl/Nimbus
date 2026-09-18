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
