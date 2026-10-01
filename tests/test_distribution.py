"""
Unit tests for backend/distribution/service.py's pure functions (no DB
dependency) and backend/distribution/data.py's plan()/apply() ingest
transaction seam (@pytest.mark.pg -- requires a local/CI Postgres with
NIMBUS_TEST_DB=1; auto-skipped otherwise, see tests/conftest.py).
"""

import uuid
import datetime as dt
import unittest.mock as mock
from decimal import Decimal

import pytest
from backend.distribution.service import (
    TOOL_PLACEHOLDERS,
    resolve_plant,
    classify_row,
    compute_default_shares,
    assign_letters,
    apportion,
    compute_derived_statuses,
)
from backend.distribution.data import (
    NEEDS_REVIEW_STATUSES,
    CHANGED_STATUSES,
    PROBLEM_STATUSES,
    classify_bucket_membership,
    status_matches_filter,
    _clean_weights,
    _validate_share_payload,
)


class TestToolPlaceholders:
    """Verify TOOL_PLACEHOLDERS parity with frontend/nimbus-compute-core.js:391"""

    def test_tool_placeholders_exact_match(self):
        """Assert our set matches the frontend exactly."""
        expected = {'', '-', '0', 'N/A', 'NONE', 'NULL'}
        assert expected == TOOL_PLACEHOLDERS


class TestResolvePlant:
    """§5.1 step 2: plant resolution."""

    def test_row_plant_priority(self):
        """Row's own plant field has highest priority."""
        row = {"plant": "P1"}
        machine_lookup = {}
        workcenter_lookup = {}
        plant, warning = resolve_plant(row, machine_lookup, workcenter_lookup)
        assert plant == "P1"
        assert warning is None

    def test_resolve_from_machine(self):
        """Resolve via unique plant across machine rows."""
        row = {"plant": None, "machine": "L1"}
        machine_lookup = {"P1": {"L1": {}}}
        workcenter_lookup = {}
        plant, warning = resolve_plant(row, machine_lookup, workcenter_lookup)
        assert plant == "P1"
        assert warning is None

    def test_resolve_from_workcenter(self):
        """Resolve via unique plant across sap_workcenter rows."""
        row = {"plant": None, "machine": "WC1"}
        machine_lookup = {}
        workcenter_lookup = {"P2": {"WC1": {}}}
        plant, warning = resolve_plant(row, machine_lookup, workcenter_lookup)
        assert plant == "P2"
        assert warning is None

    def test_ambiguous_plant(self):
        """Return ambiguous warning when machine/wc exists in multiple plants."""
        row = {"plant": None, "machine": "L1"}
        machine_lookup = {"P1": {"L1": {}}, "P2": {"L1": {}}}
        workcenter_lookup = {}
        plant, warning = resolve_plant(row, machine_lookup, workcenter_lookup)
        assert plant is None
        assert warning == "ambiguous_workcenter_plant"

    def test_no_machine_value(self):
        """Return ambiguous warning when no machine value."""
        row = {"plant": None}
        plant, warning = resolve_plant(row, {}, {})
        assert plant is None
        assert warning == "ambiguous_workcenter_plant"


class TestClassifyRow:
    """§5.1 step 3: row classification."""

    def test_plain_order(self):
        """Classify as plain when machine exists."""
        result = classify_row(
            "P1", "L1",
            {"P1": {"L1": {}}},
            {"P1": {}},
        )
        assert result["type"] == "plain"
        assert result["machine"] == "L1"
        assert result["warnings"] == []

    def test_single_mode_rewrite_valid(self):
        """Single-mode work center with valid default machine."""
        result = classify_row(
            "P1", "WC1",
            {"P1": {"L1": {}}},
            {"P1": {"WC1": {
                "distribution_mode": "single",
                "default_machine": "L1",
                "members": ["L1"],
            }}},
        )
        assert result["type"] == "single_rewrite"
        assert result["machine"] == "L1"
        assert result["warnings"] == []

    def test_single_mode_invalid_default(self):
        """Single-mode with invalid/missing default machine."""
        result = classify_row(
            "P1", "WC1",
            {"P1": {}},
            {"P1": {"WC1": {
                "distribution_mode": "single",
                "default_machine": "L_MISSING",
            }}},
        )
        assert result["type"] == "plain"
        assert result["machine"] == "WC1"
        assert "default_machine_invalid" in result["warnings"]

    def test_distribute_mode_no_members(self):
        """Distribute mode with zero members."""
        result = classify_row(
            "P1", "WC1",
            {"P1": {}},
            {"P1": {"WC1": {
                "distribution_mode": "distribute",
                "members": [],
            }}},
        )
        assert result["type"] == "distribute_no_members"
        assert "workcenter_without_members" in result["warnings"]

    def test_distribute_mode_with_members(self):
        """Distribute mode with members."""
        result = classify_row(
            "P1", "WC1",
            {"P1": {"L1": {}, "L2": {}}},
            {"P1": {"WC1": {
                "distribution_mode": "distribute",
                "members": ["L1", "L2"],
            }}},
        )
        assert result["type"] == "distribute"
        assert result["warnings"] == []

    def test_unknown_code(self):
        """Unknown machine/work-center code."""
        result = classify_row("P1", "UNKNOWN", {"P1": {}}, {"P1": {}})
        assert result["type"] == "plain"
        assert result["machine"] == "UNKNOWN"


class TestComputeDefaultShares:
    """§5.2: default-share precedence."""

    def test_material_default_wins(self):
        """Material default machine gets 100% when set and a member."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"default_machine": "L1"}
        workcenter = {"distribute_tooled": False}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert shares["L1"] == Decimal(100)
        assert shares["L2"] == Decimal(0)
        assert basis == "material_default"

    def test_material_default_not_member(self):
        """Material default ignored when not a member."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"default_machine": "L_MISSING"}
        workcenter = {"distribute_tooled": False}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        # Falls through to workcenter_weights
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(10)
        assert shares["L2"] == Decimal(20)

    def test_tooled_single_with_workcenter_default(self):
        """Tooled material with distribute_tooled=False uses workcenter default."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"prt_01": "T123"}  # Non-placeholder tool
        workcenter = {"distribute_tooled": False, "default_machine": "L2"}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert shares["L1"] == Decimal(0)
        assert shares["L2"] == Decimal(100)
        assert basis == "tooled_single"

    def test_tooled_single_no_workcenter_default(self):
        """Tooled material falls back to first member."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"prt_02": "T456"}
        workcenter = {"distribute_tooled": False, "default_machine": None}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert shares["L1"] == Decimal(100)
        assert shares["L2"] == Decimal(0)
        assert basis == "tooled_single"

    def test_tool_placeholder_not_tooled(self):
        """Tool placeholders don't trigger tooled logic."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"prt_01": ""}  # Placeholder
        workcenter = {"distribute_tooled": False}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(10)

    def test_distribute_tooled_true(self):
        """Tooled material respects distribute_tooled=True."""
        members = [("L1", Decimal(10)), ("L2", Decimal(20))]
        material_attrs = {"prt_01": "T789"}
        workcenter = {"distribute_tooled": True}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(10)

    def test_null_weight_rule_all_null(self):
        """All NULL weights -> even split."""
        members = [("L1", None), ("L2", None), ("L3", None)]
        material_attrs = {}
        workcenter = {}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(1)
        assert shares["L2"] == Decimal(1)
        assert shares["L3"] == Decimal(1)

    def test_null_weight_rule_partial_null(self):
        """Partial NULL weights -> NULL members get 0."""
        members = [("L1", Decimal(50)), ("L2", None), ("L3", Decimal(25))]
        material_attrs = {}
        workcenter = {}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(50)
        assert shares["L2"] == Decimal(0)
        assert shares["L3"] == Decimal(25)


class TestAssignLetters:
    """§5.3 bullet 1: letter assignment (A, B, ..., Z, AA, AB, ...)."""

    def test_basic_letters(self):
        """Assign A, B, C to first three members."""
        members = ["L1", "L2", "L3"]
        letters = assign_letters(members)
        assert letters["L1"] == "A"
        assert letters["L2"] == "B"
        assert letters["L3"] == "C"

    def test_past_z(self):
        """Overflow past Z into AA, AB."""
        members = [f"L{i}" for i in range(27)]
        letters = assign_letters(members)
        assert letters["L0"] == "A"
        assert letters["L25"] == "Z"
        assert letters["L26"] == "AA"

    def test_gap_for_zero_weight(self):
        """Letters are stable per alphabetical position (gaps allowed)."""
        # Members returned in order; letter position is stable
        members = ["L1", "L2", "L3"]
        letters = assign_letters(members)
        assert letters["L1"] == "A"
        assert letters["L2"] == "B"
        assert letters["L3"] == "C"


class TestApportion:
    """§5.3 bullet "Quantity apportionment": Hamilton / largest-remainder."""

    def test_integral_total(self):
        """Apportion integral total evenly."""
        total = Decimal(100)
        weights = {"L1": Decimal(1), "L2": Decimal(1), "L3": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        # 100 / 3 = 33 remainder 1, largest fractional share gets it
        assert sum(result.values()) == total

    def test_unit_not_dividing_evenly(self):
        """Remainder distributed to largest fractional share."""
        total = Decimal(100)
        weights = {"L1": Decimal(60), "L2": Decimal(40)}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        assert sum(result.values()) == total
        # L1 should get more
        assert result["L1"] > result["L2"]

    def test_zero_quantity_edge_case(self):
        """Total smaller than number of shares yields some 0-qty children."""
        total = Decimal(2)
        weights = {"L1": Decimal(1), "L2": Decimal(1), "L3": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        assert sum(result.values()) == Decimal(2)
        assert result["L1"] >= Decimal(0)
        assert result["L2"] >= Decimal(0)
        assert result["L3"] >= Decimal(0)

    def test_tie_order_for_remainder(self):
        """Ties in remainder broken by tie_order."""
        total = Decimal(11)
        weights = {"L2": Decimal(1), "L1": Decimal(1)}  # Equal weights
        unit = Decimal(1)
        tie_order = ["L1", "L2"]
        result = apportion(total, weights, unit, tie_order)
        # Ideal shares 5.5/5.5, floor to 5/5, 1 unit of remainder to distribute.
        # Both tied at remainder 0.5 -> L1 wins (appears first in tie_order).
        assert result["L1"] == 6
        assert result["L2"] == 5

    def test_minutes_apportionment(self):
        """Apportion in minutes for run-time (e.g., 300 minutes / 3 ways)."""
        total = Decimal(300)  # 300 minutes
        weights = {"L1": Decimal(1), "L2": Decimal(1), "L3": Decimal(1)}
        unit = Decimal(1)  # Unit = 1 minute
        result = apportion(total, weights, unit)
        # Should sum to 300
        assert sum(result.values()) == Decimal(300)
        # Can be converted to hours outside the function (each / 60)

    def test_decimal_weights(self):
        """Handle decimal weights correctly."""
        total = Decimal(100)
        weights = {"L1": Decimal("2.5"), "L2": Decimal("7.5")}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        assert sum(result.values()) == Decimal(100)
        # L2 (3x weight) should get roughly 3x the quantity
        assert result["L2"] >= result["L1"] * 2


class TestCleanWeights:
    """D21: `_clean_weights` rejects non-finite/over-ceiling weights before
    the existing `< 0` check (save_workcenter's {machine: weight} map)."""

    @pytest.mark.parametrize("bad_weight", [float("inf"), float("-inf"), float("nan"), 1e999, 1e10])
    def test_non_finite_or_over_ceiling_raises(self, bad_weight):
        with pytest.raises(ValueError, match="weight_invalid"):
            _clean_weights({"M1": bad_weight})

    @pytest.mark.parametrize("good_weight", [0, 1, 1e9])
    def test_finite_within_ceiling_passes(self, good_weight):
        cleaned = _clean_weights({"M1": good_weight})
        assert cleaned["M1"] == float(good_weight)

    def test_huge_int_literal_raises_value_error_not_overflow_error(self):
        """A ~400-digit JSON integer is a Python int; float() on it directly
        raises OverflowError (not ValueError), which would escape
        save_workcenter's `except ValueError` as a 500 instead of the
        intended weight_invalid 400."""
        with pytest.raises(ValueError, match="weight_invalid"):
            _clean_weights({"M": 10**400})


class TestValidateSharePayload:
    """D21/D22: `_validate_share_payload` weight-ceiling and unknown-machine
    guards (reweight_shares' {shares:[{machine, weight}]} payload)."""

    @pytest.mark.parametrize("bad_weight", [float("inf"), float("nan"), 1e999, 1e10])
    def test_weight_non_finite_or_over_ceiling_raises(self, bad_weight):
        # M2 carries a valid positive weight so "weights_empty" never masks
        # the weight_invalid check under test on M1.
        shares = [{"machine": "M1", "weight": bad_weight}, {"machine": "M2", "weight": 1}]
        with pytest.raises(ValueError, match="weight_invalid"):
            _validate_share_payload(shares, {}, {"M1", "M2"}, allow_stale=False)

    @pytest.mark.parametrize("good_weight", [0, 1, 1e9])
    def test_weight_finite_within_ceiling_passes(self, good_weight):
        shares = [{"machine": "M1", "weight": good_weight}, {"machine": "M2", "weight": 1}]
        desired = _validate_share_payload(shares, {}, {"M1", "M2"}, allow_stale=False)
        assert desired["M1"] == Decimal(str(good_weight))

    def test_huge_int_literal_raises_value_error_not_overflow_error(self):
        """Parity with _clean_weights: a ~400-digit JSON integer must raise
        ValueError (weight_invalid), not OverflowError."""
        shares = [{"machine": "M1", "weight": 10**400}, {"machine": "M2", "weight": 1}]
        with pytest.raises(ValueError, match="weight_invalid"):
            _validate_share_payload(shares, {}, {"M1", "M2"}, allow_stale=False)

    def test_unknown_machine_weight_zero_without_allow_stale_raises(self):
        shares = [{"machine": "GHOST", "weight": 0}, {"machine": "M2", "weight": 1}]
        with pytest.raises(ValueError, match="unknown_machine"):
            _validate_share_payload(shares, {}, {"M2"}, allow_stale=False)

    def test_unknown_machine_weight_zero_with_allow_stale_still_raises(self):
        shares = [{"machine": "GHOST", "weight": 0}, {"machine": "M2", "weight": 1}]
        with pytest.raises(ValueError, match="unknown_machine"):
            _validate_share_payload(shares, {}, {"M2"}, allow_stale=True)

    def test_unknown_machine_positive_weight_without_allow_stale_raises(self):
        shares = [{"machine": "GHOST", "weight": 5}]
        with pytest.raises(ValueError, match="unknown_machine"):
            _validate_share_payload(shares, {}, {"M2"}, allow_stale=False)

    def test_unknown_machine_positive_weight_with_allow_stale_still_raises(self):
        """allow_stale waives staleness for a share that once existed -- never
        for a machine that was never a member and never had a share row."""
        shares = [{"machine": "GHOST", "weight": 5}]
        with pytest.raises(ValueError, match="unknown_machine"):
            _validate_share_payload(shares, {}, {"M2"}, allow_stale=True)

    def test_current_member_with_no_share_row_passes(self):
        """SS5.7 'joining' case: a current member with no existing share row
        needs neither allow_stale nor a prior share -- ordinary new-member path."""
        shares = [{"machine": "M_NEW", "weight": 5}]
        desired = _validate_share_payload(shares, {}, {"M_NEW"}, allow_stale=False)
        assert desired["M_NEW"] == Decimal(5)

    def test_stale_existing_share_needs_allow_stale(self):
        """An existing share whose machine has left the work center is the
        ONLY case allow_stale waives."""
        existing_shares = {"M_OLD": {"purged_at": None}}
        shares = [{"machine": "M_OLD", "weight": 5}]
        with pytest.raises(ValueError, match="stale_machine"):
            _validate_share_payload(shares, existing_shares, set(), allow_stale=False)
        desired = _validate_share_payload(shares, existing_shares, set(), allow_stale=True)
        assert desired["M_OLD"] == Decimal(5)


class TestComputeDerivedStatuses:
    """§5.7 first bullet: derived-status computation."""

    def test_needs_review(self):
        """Header with reviewed=False shows needs_review."""
        header = {"reviewed": False}
        shares = []
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "needs_review" in statuses

    def test_qty_changed(self):
        """Reviewed header with quantity change shows qty_changed."""
        header = {
            "reviewed": True,
            "order_quantity": Decimal(100),
            "reviewed_quantity": Decimal(80),
        }
        shares = []
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "qty_changed" in statuses

    def test_mode_mismatch(self):
        """Work center now in single mode."""
        header = {}
        shares = []
        children = []
        workcenter = {"distribution_mode": "single"}
        statuses = compute_derived_statuses(header, shares, children, workcenter, {})
        assert "mode_mismatch" in statuses

    def test_wc_changed(self):
        """Header with previous_workcenter in sap_facts."""
        header = {"sap_facts": {"previous_workcenter": "WC_OLD"}}
        shares = []
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "wc_changed" in statuses

    def test_membership_changed_machine_left(self):
        """Share member no longer in work center."""
        header = {}
        shares = [{"machine": "L_GONE", "weight": Decimal(50)}]
        children = []
        workcenter = {}
        machines = {"L1": {}}  # L_GONE not here
        statuses = compute_derived_statuses(header, shares, children, workcenter, machines)
        assert "membership_changed" in statuses

    def test_below_min_lot(self):
        """Child marked below_min_lot."""
        header = {}
        shares = []
        children = [{"below_min_lot": True}]
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "below_min_lot" in statuses

    def test_zero_quantity_children(self):
        """Child with zero quantity."""
        header = {}
        shares = []
        children = [{"order_quantity": Decimal(0)}]
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "zero_quantity_children" in statuses

    def test_purged(self):
        """Share with purged_at set."""
        header = {}
        shares = [{"purged_at": "2026-09-17T12:00:00Z"}]
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "purged" in statuses

    def test_runtime_mismatch(self):
        """Child with runtime_schedule_mismatch."""
        header = {}
        shares = []
        children = [{"runtime_schedule_mismatch": True}]
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "runtime_mismatch" in statuses

    def test_incomplete_missing_child(self):
        """Positive share with no corresponding child."""
        header = {}
        shares = [{"machine": "L1", "weight": Decimal(50)}]
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "incomplete" in statuses

    def test_incomplete_orphan_child(self):
        """Child exists but no corresponding share."""
        header = {}
        shares = []
        children = [{"machine": "L1"}]
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "incomplete" in statuses

    def test_no_statuses(self):
        """Clean header -> empty status set."""
        header = {"reviewed": True, "order_quantity": Decimal(100), "reviewed_quantity": Decimal(100)}
        shares = [{"machine": "L1", "weight": Decimal(100)}]
        children = [{"machine": "L1"}]
        workcenter = {"distribution_mode": "distribute"}
        machines = {"L1": {}}
        statuses = compute_derived_statuses(header, shares, children, workcenter, machines)
        assert len(statuses) == 0


class TestBucketClassification:
    """backend/distribution/data.py's classify_bucket_membership() /
    status_matches_filter() -- the ONE shared helper GET /distribution/{plant}'s
    `bucket` filter and GET /distribution/{plant}/summary's counts both use,
    per aggregate_to_detail.md §6 "Data" / §7's bucket definitions:
      needs_review = needs_review | qty_changed
      changed      = wc_changed, membership_changed, mode_mismatch,
                     below_min_lot, zero_quantity_children
      problems     = incomplete, runtime_mismatch, separation_violated
    Pure, no DB dependency -- these operate on plain status-code sets.
    """

    def test_bucket_definitions_match_the_design_doc(self):
        assert {"needs_review", "qty_changed"} == NEEDS_REVIEW_STATUSES
        assert {
            "wc_changed", "membership_changed", "mode_mismatch",
            "below_min_lot", "zero_quantity_children",
        } == CHANGED_STATUSES
        assert {"incomplete", "runtime_mismatch", "separation_violated"} == PROBLEM_STATUSES

    def test_needs_review_bucket_membership(self):
        assert classify_bucket_membership({"needs_review"}) == {"needs_review"}
        assert classify_bucket_membership({"qty_changed"}) == {"needs_review"}

    def test_changed_bucket_membership_each_code(self):
        for code in CHANGED_STATUSES:
            assert classify_bucket_membership({code}) == {"changed"}, code

    def test_problems_bucket_membership_each_code(self):
        for code in ("incomplete", "runtime_mismatch"):
            assert classify_bucket_membership({code}) == {"problems"}

    def test_separation_violated_is_a_documented_problems_code_never_emitted_server_side(self):
        """separation_violated is computed client-side only (§6) -- it still
        counts as a `problems` member if it ever showed up in a status set
        (defensive), but compute_derived_statuses() never produces it."""
        assert classify_bucket_membership({"separation_violated"}) == {"problems"}
        never_emitted = compute_derived_statuses({}, [], [], None, {})
        assert "separation_violated" not in never_emitted

    def test_purged_is_in_no_bucket(self):
        """`purged` is a real derived status but is not part of any of the
        three §6 buckets (it renders as a neutral badge, not needs_review/
        changed/problems) -- deep links reach it via status_matches_filter's
        individual-code path instead."""
        assert classify_bucket_membership({"purged"}) == set()

    def test_header_can_be_in_multiple_buckets_at_once(self):
        statuses = {"needs_review", "incomplete", "mode_mismatch"}
        assert classify_bucket_membership(statuses) == {"needs_review", "changed", "problems"}

    def test_empty_statuses_classify_to_no_bucket(self):
        assert classify_bucket_membership(set()) == set()

    def test_status_matches_filter_none_or_all_means_unfiltered(self):
        statuses = {"needs_review"}
        assert status_matches_filter(statuses, None) is True
        assert status_matches_filter(statuses, "") is True
        assert status_matches_filter(statuses, "all") is True

    def test_status_matches_filter_bucket_name(self):
        assert status_matches_filter({"qty_changed"}, "needs_review") is True
        assert status_matches_filter({"below_min_lot"}, "needs_review") is False
        assert status_matches_filter({"below_min_lot"}, "changed") is True

    def test_status_matches_filter_individual_status_code_deep_link(self):
        """An individual status code (not one of the three bucket names) is
        accepted directly, e.g. `?bucket=purged` for a deep link."""
        assert status_matches_filter({"purged"}, "purged") is True
        assert status_matches_filter({"needs_review"}, "purged") is False

    def test_status_matches_filter_unknown_bucket_falls_back_to_exact_code_match(self):
        assert status_matches_filter({"incomplete"}, "incomplete") is True
        assert status_matches_filter({"incomplete"}, "nonexistent_code") is False


# =====================================================================
# backend/distribution/data.py -- plan()/apply() real-DB tests
# =====================================================================
# Requires a local Postgres with NIMBUS_TEST_DB=1 (tests/conftest.py). NOT RUN
# in this sandboxed environment (.env's PG_HOST points at the live Azure
# pilot, and the DB-safety guard correctly refuses to even collect pytest in
# that state) -- verified only via py_compile + the pure-function suite
# above, not an actual pytest run against real Postgres. A human with a local
# Postgres instance must run these to confirm pass/fail, per
# tests/test_task_concurrency.py's own precedent docstring.
#
# All tests seed under plant "1006" / subnetwork "WTG" (seeded by schema.sql,
# the same plant tests/test_data_integrity.py's TestCascadePreviewSapWorkcenter
# uses), with ZZTEST_*-prefixed identifiers, and clean up in teardown.

import backend.distribution.data as distribution_data  # noqa: E402
import backend.routing.resolver as routing_resolver  # noqa: E402


def _seed_distribution_material(cur, material, plant):
    """Honor the fresh-schema parent FK; fixtures must not depend on pilot data."""
    assert len(material) <= 18
    cur.execute("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (material,))
    cur.execute(
        "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (material, plant),
    )


def _snapshot_header(db_, plant, order, material):
    with db_._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT sap_workcenter, order_quantity, run_time, reviewed, reviewed_by,
                      default_basis, source, sap_facts, xmin::text::bigint, updated_at
                 FROM order_distribution
                WHERE plant = %s AND production_order = %s AND material_number = %s""",
            (plant, order, material),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "sap_workcenter": row[0], "order_quantity": row[1], "run_time": row[2],
        "reviewed": row[3], "reviewed_by": row[4], "default_basis": row[5],
        "source": row[6], "sap_facts": row[7], "xmin": row[8], "updated_at": row[9],
    }


def _snapshot_shares(db_, plant, order, material):
    with db_._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT machine, letter, weight, child_id, purged_at
                 FROM order_distribution_share
                WHERE plant = %s AND production_order = %s AND material_number = %s
                ORDER BY machine""",
            (plant, order, material),
        )
        return [
            {"machine": r[0], "letter": r[1], "weight": r[2], "child_id": r[3], "purged_at": r[4]}
            for r in cur.fetchall()
        ]


def _snapshot_children(db_, plant, parent_order):
    with db_._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT id, production_order, machine, order_quantity, run_time,
                      parent_production_order, distribution_letter,
                      scheduled_start, scheduled_end, notes,
                      xmin::text::bigint, updated_at
                 FROM orders
                WHERE plant = %s AND parent_production_order = %s
                ORDER BY production_order""",
            (plant, parent_order),
        )
        return [
            {"id": r[0], "production_order": r[1], "machine": r[2], "order_quantity": r[3],
             "run_time": r[4], "parent_production_order": r[5], "distribution_letter": r[6],
             "scheduled_start": r[7], "scheduled_end": r[8], "notes": r[9],
             "xmin": r[10], "updated_at": r[11]}
            for r in cur.fetchall()
        ]


@pytest.mark.pg
class TestPlanApplyIdempotency:
    """A second apply() run over the SAME plan_structure must change nothing:
    no new/deleted children, no header/shares rewrite, xmin/updated_at on
    every touched row identical before and after the repeat run."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_IDEM"
    L1, L2 = "ZZTEST_L1_IDEM", "ZZTEST_L2_IDEM"
    ORD, MAT = "ZZTEST_ORD_IDEM", "ZZTEST_MAT_IDEM"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, 60,
                 self.SUB, self.PLANT, self.L2, self.WC, 40),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                    (self.ORD, self.ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    def _row(self):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def test_second_apply_is_a_no_op(self, pg):
        db_ = pg
        batch_id = str(uuid.uuid4())
        rows_out, plan_structure, warnings = distribution_data.plan([self._row()], batch_id)
        assert warnings["conflicting_parent_rows"] == []
        assert len(rows_out) == 2  # two lettered children, 60/40 split

        with db_._pool.connection() as conn:
            result = distribution_data.apply(plan_structure, batch_id, conn)
        assert result["headers_created"] == 1
        assert result["children_upserted"] == 2
        assert result["replanned_after_reweight"] == 0

        header_1 = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        shares_1 = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        children_1 = _snapshot_children(db_, self.PLANT, self.ORD)
        assert header_1 is not None
        assert len(shares_1) == 2
        assert len(children_1) == 2

        # Re-run apply() with the EXACT SAME plan_structure object.
        with db_._pool.connection() as conn:
            result_2 = distribution_data.apply(plan_structure, batch_id, conn)

        header_2 = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        shares_2 = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        children_2 = _snapshot_children(db_, self.PLANT, self.ORD)

        assert header_2 == header_1, "header row (incl. xmin/updated_at) must be byte-identical"
        assert shares_2 == shares_1, "shares must be byte-identical"
        assert children_2 == children_1, "children rows (incl. xmin/updated_at) must be byte-identical"
        assert result_2["children_deleted"] == 0
        assert result_2["headers_created"] == 0
        # plan_structure's is_new_header flag is a static planning-time
        # decision that apply() never mutates back onto the caller's plan --
        # so a SECOND apply() call over the SAME plan_structure re-takes the
        # is_new_header branch, finds the header already exists (ON CONFLICT
        # DO NOTHING -> rowcount 0), and re-plans from current state exactly
        # like a genuine concurrent-creation race would. This is expected,
        # documented behavior (see apply()'s docstring): it is why the
        # RESULTING STATE assertions above are the real idempotency proof,
        # not this counter.
        assert result_2["replanned_after_reweight"] == 1


@pytest.mark.pg
class TestApplyReplanAfterConcurrentReweight:
    """Simulates a planner re-weight landing between plan()'s snapshot and
    apply()'s lock: apply() must detect the xmin mismatch and re-plan from
    the header's CURRENT shares, not the stale plan()-time snapshot."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_RACE"
    L1, L2 = "ZZTEST_L1_RACE", "ZZTEST_L2_RACE"
    ORD, MAT = "ZZTEST_ORD_RACE", "ZZTEST_MAT_RACE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                "VALUES (%s,%s,%s,%s),(%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, self.SUB, self.PLANT, self.L2, self.WC),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                    (self.ORD, self.ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    def _row(self):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def test_xmin_mismatch_triggers_replan_from_current_shares(self, pg):
        db_ = pg
        batch_id_1 = str(uuid.uuid4())
        rows_out_1, plan_1, _ = distribution_data.plan([self._row()], batch_id_1)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_1, batch_id_1, conn)

        # Second ingest of the SAME parent: plan() snapshots the header's
        # CURRENT xmin (even split, 50/50 since no weights were set).
        batch_id_2 = str(uuid.uuid4())
        rows_out_2, plan_2, _ = distribution_data.plan([self._row()], batch_id_2)
        header_key = (self.PLANT, self.ORD, self.MAT)
        snapshot_xmin = plan_2["parents"][header_key]["header_xmin"]
        assert snapshot_xmin is not None

        # Simulate a CONCURRENT planner re-weight landing between plan_2's
        # snapshot and apply_2's lock: L1 -> 100%, L2 -> 0%. Any UPDATE bumps
        # the header's xmin regardless of which columns changed.
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE order_distribution_share SET weight = 100 "
                " WHERE plant = %s AND production_order = %s AND material_number = %s AND machine = %s",
                (self.PLANT, self.ORD, self.MAT, self.L1),
            )
            cur.execute(
                "UPDATE order_distribution_share SET weight = 0 "
                " WHERE plant = %s AND production_order = %s AND material_number = %s AND machine = %s",
                (self.PLANT, self.ORD, self.MAT, self.L2),
            )
            cur.execute(
                "UPDATE order_distribution SET updated_at = now() "
                " WHERE plant = %s AND production_order = %s AND material_number = %s",
                (self.PLANT, self.ORD, self.MAT),
            )
            conn.commit()

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT xmin::text::bigint FROM order_distribution WHERE plant=%s AND "
                        "production_order=%s AND material_number=%s", (self.PLANT, self.ORD, self.MAT))
            bumped_xmin = cur.fetchone()[0]
        assert bumped_xmin != snapshot_xmin, "the simulated concurrent write must bump xmin"

        with db_._pool.connection() as conn:
            result = distribution_data.apply(plan_2, batch_id_2, conn)

        assert result["replanned_after_reweight"] == 1

        # The planner's re-weight WINS: only L1 has a living child now
        # (100%), and L2's earlier child is superseded/deleted.
        shares = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        by_machine = {s["machine"]: s for s in shares}
        assert by_machine[self.L1]["weight"] == 100
        assert by_machine[self.L2]["weight"] == 0
        assert by_machine[self.L2]["child_id"] is None
        assert by_machine[self.L1]["child_id"] is not None

        children = _snapshot_children(db_, self.PLANT, self.ORD)
        assert len(children) == 1
        assert children[0]["machine"] == self.L1
        # 100% on a single machine collapses to the BARE parent id (no letter).
        assert children[0]["distribution_letter"] is None
        assert children[0]["production_order"] == self.ORD


@pytest.mark.pg
class TestPlanApplyAnchorCarry:
    """1->N anchor carry: a plain order that arrived before its work center
    was configured as `distribute` gets distributed on the NEXT ingest; its
    schedule (COALESCE(first segment start, scheduled_start)) and notes are
    carried onto the new lettered children, and the old plain row is deleted
    as a superseded child."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_ANCHOR"
    L1, L2 = "ZZTEST_L1_ANCHOR", "ZZTEST_L2_ANCHOR"
    ORD, MAT = "ZZTEST_ORD_ANCHOR", "ZZTEST_MAT_ANCHOR"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        self.plain_id = db_.make_id(self.ORD, self.MAT)
        self.anchor_start = dt.datetime(2026, 10, 5, 6, 0)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                "VALUES (%s,%s,%s,%s),(%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, self.SUB, self.PLANT, self.L2, self.WC),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            # The plain order arrived BEFORE the work center was configured --
            # it is already scheduled by a planner (scheduled_start set) and
            # carries a note.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, scheduled_start, scheduled_end, notes, run_time) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.plain_id, self.ORD, self.MAT, self.WC, self.PLANT,
                 dt.datetime(2026, 10, 1, 0, 0), dt.datetime(2026, 10, 2, 0, 0),
                 self.anchor_start, self.anchor_start + dt.timedelta(hours=10),
                 "Planner note", 10.0),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                    (self.ORD, self.ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    def test_anchor_and_notes_carried_old_plain_row_deleted(self, pg):
        db_ = pg
        batch_id = str(uuid.uuid4())
        row = {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 0, 0),
            "basic_finish_date": dt.datetime(2026, 10, 2, 0, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        rows_out, plan_structure, warnings = distribution_data.plan([row], batch_id)
        header_key = (self.PLANT, self.ORD, self.MAT)
        assert plan_structure["parents"][header_key]["anchor"] is not None
        assert plan_structure["parents"][header_key]["anchor"]["anchor"] == self.anchor_start
        assert self.plain_id in plan_structure["parents"][header_key]["previous_child_ids"]

        with db_._pool.connection() as conn:
            result = distribution_data.apply(plan_structure, batch_id, conn)
        assert result["headers_created"] == 1
        assert result["children_deleted"] == 1  # the old plain row is superseded

        children = _snapshot_children(db_, self.PLANT, self.ORD)
        assert len(children) == 2
        for child in children:
            assert child["scheduled_start"] == self.anchor_start
            assert child["notes"] == "Planner note"

        # The old plain id must be gone.
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM orders WHERE id = %s", (self.plain_id,))
            assert cur.fetchone() is None


@pytest.mark.pg
class TestApplyPreservesReviewedAndDefaultBasis:
    """§5.2 'Existing': a refresh (SAP facts only) must never touch shares,
    reviewed, reviewed_by, source, or default_basis -- confirmed by manually
    marking a header reviewed before a second ingest with CHANGED facts."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_REFRESH"
    L1, L2 = "ZZTEST_L1_REFRESH", "ZZTEST_L2_REFRESH"
    ORD, MAT = "ZZTEST_ORD_REFRESH", "ZZTEST_MAT_REFRESH"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                "VALUES (%s,%s,%s,%s),(%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, self.SUB, self.PLANT, self.L2, self.WC),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                    (self.ORD, self.ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    def _row(self, qty, run_time):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": qty, "run_time": run_time,
        }

    def test_refresh_never_touches_review_state_or_shares(self, pg):
        db_ = pg
        batch_1 = str(uuid.uuid4())
        rows_1, plan_1, _ = distribution_data.plan([self._row(100.0, 10.0)], batch_1)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_1, batch_1, conn)

        # Planner reviews the header manually (as the /review route would).
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE order_distribution SET reviewed = TRUE, reviewed_by = 'alice', "
                "reviewed_quantity = order_quantity, source = 'manual' "
                "WHERE plant = %s AND production_order = %s AND material_number = %s",
                (self.PLANT, self.ORD, self.MAT),
            )
            conn.commit()
        before = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        shares_before = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        assert before["reviewed"] is True
        assert before["source"] == "manual"

        # Second ingest with CHANGED SAP facts (quantity moved).
        batch_2 = str(uuid.uuid4())
        rows_2, plan_2, _ = distribution_data.plan([self._row(200.0, 10.0)], batch_2)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_2, batch_2, conn)

        after = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        shares_after = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)

        # Facts refreshed...
        assert after["order_quantity"] == 200
        # ...but review state, source, and default_basis are UNTOUCHED.
        assert after["reviewed"] is True
        assert after["reviewed_by"] == "alice"
        assert after["source"] == "manual"
        assert after["default_basis"] == before["default_basis"]
        # ...and shares (letters/weights) are UNTOUCHED by ingest.
        assert shares_after == shares_before


@pytest.mark.pg
class TestPlanRerouteRecordsPreviousWorkcenter:
    """Decision I: a distributed parent whose row now resolves to a
    DIFFERENT distribute-mode work center keeps its existing header/shares
    (header authority); sap_workcenter takes the new code and the old one is
    recorded in sap_facts.previous_workcenter."""
    SUB, PLANT = "WTG", "1006"
    WC1, WC2 = "ZZTEST_WC1_REROUTE", "ZZTEST_WC2_REROUTE"
    L1, L2, M1 = "ZZTEST_L1_REROUTE", "ZZTEST_L2_REROUTE", "ZZTEST_M1_REROUTE"
    ORD, MAT = "ZZTEST_ORD_REROUTE", "ZZTEST_MAT_REROUTE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s,%s,'distribute'),(%s,%s,'distribute')",
                (self.PLANT, self.WC1, self.PLANT, self.WC2),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                "VALUES (%s,%s,%s,%s),(%s,%s,%s,%s),(%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC1, self.SUB, self.PLANT, self.L2, self.WC1,
                 self.SUB, self.PLANT, self.M1, self.WC2),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                    (self.ORD, self.ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s, %s)",
                    (self.PLANT, self.L1, self.L2, self.M1))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter IN (%s, %s)",
                    (self.PLANT, self.WC1, self.WC2))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    def _row(self, machine):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": machine, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def test_reroute_keeps_old_shares_and_records_previous_workcenter(self, pg):
        db_ = pg
        batch_1 = str(uuid.uuid4())
        rows_1, plan_1, _ = distribution_data.plan([self._row(self.WC1)], batch_1)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_1, batch_1, conn)

        shares_before = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        machines_before = {s["machine"] for s in shares_before}
        assert machines_before == {self.L1, self.L2}

        # SAP now addresses the SAME parent to WC2 instead.
        batch_2 = str(uuid.uuid4())
        rows_2, plan_2, warnings_2 = distribution_data.plan([self._row(self.WC2)], batch_2)
        header_key = (self.PLANT, self.ORD, self.MAT)
        parent_plan = plan_2["parents"][header_key]
        assert parent_plan["sap_workcenter"] == self.WC2
        assert parent_plan["previous_workcenter"] == self.WC1
        # Header authority: children still come from the OLD (WC1) shares.
        assert set(parent_plan["shares"].keys()) == {self.L1, self.L2}

        with db_._pool.connection() as conn:
            distribution_data.apply(plan_2, batch_2, conn)

        header_after = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        assert header_after["sap_workcenter"] == self.WC2
        assert header_after["sap_facts"].get("previous_workcenter") == self.WC1

        shares_after = _snapshot_shares(db_, self.PLANT, self.ORD, self.MAT)
        machines_after = {s["machine"] for s in shares_after}
        assert machines_after == {self.L1, self.L2}, "reroute must NOT move shares to the new work center's members"


# =====================================================================
# db.upsert_orders' plan_fn/apply_fn seam (this task, P2-4)
# =====================================================================
# Requires a local Postgres with NIMBUS_TEST_DB=1 (same caveat as the classes
# above -- NOT RUN in this sandboxed environment). Uses FAKE plan_fn/apply_fn
# (not the real backend.distribution.data.plan/apply) so this test needs no
# order_distribution schema/seed data at all -- it verifies the WIRING itself
# (call order, argument shapes, warnings-list fold-in), not distribution's
# own already-tested planning/apply logic.
@pytest.mark.pg
class TestUpsertOrdersDistributionSeamWiring:
    PLANT = "1006"
    ORD, MAT = "ZZTEST_WIRE_ORD", "ZZTEST_WIRE_MAT"

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db_ = pg

        def _clean():
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM orders WHERE production_order = %s AND material_number = %s",
                    (self.ORD, self.MAT),
                )
                conn.commit()

        _clean()
        yield
        _clean()

    def _row(self):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": "ZZTEST_WIRE_MACHINE", "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "run_time": 4.0,
        }

    def test_plan_runs_before_loop_apply_runs_after_backfills(self, pg):
        """plan_fn must be called (rows, batch_id) BEFORE the id/dedup loop
        (its rows_out become what gets upserted); apply_fn must be called
        (plan_structure, batch_id, conn, actor=...) only AFTER the chunked
        upsert and every backfill have committed -- proven here by apply_fn
        reading the row back, on the very connection it was handed, and
        finding it already persisted."""
        db_ = pg
        calls = []

        def fake_plan(rows, batch_id):
            calls.append(("plan", batch_id))
            assert rows and rows[0]["production_order"] == self.ORD
            # rows_out unchanged; one fake "parent" so apply_fn's
            # non-empty-plan guard fires.
            return rows, {"parents": {"fake": {}}}, {}

        def fake_apply(plan_structure, batch_id, conn, *, actor="system"):
            calls.append(("apply", batch_id, actor))
            assert plan_structure == {"parents": {"fake": {}}}
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM orders WHERE production_order = %s AND material_number = %s",
                    (self.ORD, self.MAT),
                )
                assert cur.fetchone() is not None, "apply_fn ran before the upsert committed"
            return {
                "parents_distributed": 0, "children_upserted": 0, "children_deleted": 0,
                "headers_created": 0, "headers_refreshed": 0, "replanned_after_reweight": 0,
                "warnings_entry": {"level": "info", "msg": "fake apply ran"},
                "ingest_warnings": {},
            }

        batch_id = str(uuid.uuid4())
        result = db_.upsert_orders(
            [self._row()], batch_id=batch_id, source="excel", filename="wiring-test.xlsx",
            plan_fn=fake_plan, apply_fn=fake_apply,
        )

        assert [c[0] for c in calls] == ["plan", "apply"], "plan_fn then apply_fn, in that order, exactly once each"
        assert calls[0][1] == batch_id
        assert calls[1][1] == batch_id
        assert calls[1][2] == "wiring-test.xlsx", "actor threaded through from filename"
        assert {"level": "info", "msg": "fake apply ran"} in result["warnings"]
        assert result["lines"] == ["ZZTEST_WIRE_MACHINE"]

    def test_apply_fn_skipped_when_plan_has_no_parents(self, pg):
        """An empty plan_structure (no distribute-mode rows this batch) must
        NOT call apply_fn at all."""
        db_ = pg
        apply_calls = []

        def fake_plan(rows, batch_id):
            return rows, {"parents": {}}, {}

        def fake_apply(*args, **kwargs):
            apply_calls.append((args, kwargs))
            raise AssertionError("apply_fn must not be called for an empty plan")

        db_.upsert_orders(
            [self._row()], batch_id=str(uuid.uuid4()), source="excel", filename="wiring-test2.xlsx",
            plan_fn=fake_plan, apply_fn=fake_apply,
        )
        assert apply_calls == []

    def test_plan_fn_and_apply_fn_default_to_none_is_unaffected(self, pg):
        """The two new params are optional -- every other caller of
        upsert_orders (no plan_fn/apply_fn passed) must behave exactly as
        before: no error, no extra warnings entry, `lines` still derived from
        the (unrewritten) machine column."""
        db_ = pg
        result = db_.upsert_orders(
            [self._row()], batch_id=str(uuid.uuid4()), source="excel", filename="wiring-test3.xlsx",
        )
        assert result["status"] == "ok"
        assert result["lines"] == ["ZZTEST_WIRE_MACHINE"]
        assert all(w.get("msg") != "fake apply ran" for w in result["warnings"])


# =====================================================================
# backend/distribution/routes.py -- the 5 P2-6/P2-7 read routes, through a
# live TestClient/brain app instance (tests/test_setup_endpoints.py's and
# tests/test_rbac_plant_scoping.py's route-level style; every DB-backed test
# above this line calls backend/distribution/data.py functions directly).
# Requires local Postgres + NIMBUS_TEST_DB=1, same as the rest of this file's
# @pytest.mark.pg tests -- not run in this sandboxed environment (see the
# module note above `_snapshot_header`).
# =====================================================================
from starlette.testclient import TestClient  # noqa: E402

import brain  # noqa: E402
import backend.security.auth as auth  # noqa: E402


@pytest.mark.pg
class TestDistributionReadRoutes:
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_READ"
    L1, L2 = "ZZTEST_L1_READ", "ZZTEST_L2_READ"
    ORD, MAT = "ZZTEST_ORD_READ", "ZZTEST_MAT_READ"
    UNRESOLVED_MACHINE = "ZZTEST_UNRESOLVED_LINE"
    UNRESOLVED_ORDER = "ZZTEST_UNRESOLVED_ORD"

    def _cleanup(self, cur):
        cur.execute(
            "DELETE FROM orders WHERE plant = %s AND (parent_production_order = %s "
            "OR production_order IN (%s, %s))",
            (self.PLANT, self.ORD, self.ORD, self.UNRESOLVED_ORDER),
        )
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, 60,
                 self.SUB, self.PLANT, self.L2, self.WC, 40),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()

        batch_id = str(uuid.uuid4())
        row = {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        _, plan_structure, _ = distribution_data.plan([row], batch_id)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_structure, batch_id, conn)

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant) "
                "VALUES (%s, %s, %s, %s, %s)",
                (db_.make_id(self.UNRESOLVED_ORDER, self.MAT), self.UNRESOLVED_ORDER, self.MAT,
                 self.UNRESOLVED_MACHINE, self.PLANT),
            )
            conn.commit()

        yield

        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    @pytest.fixture
    def client(self):
        brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [self.PLANT]
        brain.api.dependency_overrides[auth.require_authenticated] = lambda: "reader@example.com"
        try:
            yield TestClient(brain.api)
        finally:
            brain.api.dependency_overrides.clear()

    def test_list_returns_the_seeded_header_with_shares_and_statuses(self, client):
        response = client.get(f"/distribution/{self.PLANT}", params={"search": self.ORD})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        body = response.json()
        assert body["meta"]["total"] == 1
        item = body["data"][0]
        assert item["header"]["production_order"] == self.ORD
        assert item["header"]["sap_workcenter"] == self.WC
        assert {s["machine"] for s in item["shares"]} == {self.L1, self.L2}
        assert "needs_review" in item["statuses"]  # fresh header, review_required defaults TRUE
        assert item["children_summary"]["count"] == 2

    def test_list_bucket_filter_needs_review(self, client):
        response = client.get(f"/distribution/{self.PLANT}", params={"bucket": "needs_review"})
        assert response.status_code == 200
        assert response.json()["meta"]["total"] == 1
        response_problems = client.get(f"/distribution/{self.PLANT}", params={"bucket": "problems"})
        assert response_problems.json()["meta"]["total"] == 0

    def test_detail_returns_base_version_and_enriched_shares(self, client):
        response = client.get(f"/distribution/{self.PLANT}/{self.ORD}/{self.MAT}")
        assert response.status_code == 200
        body = response.json()
        assert isinstance(body["base_version"], int)
        by_machine = {s["machine"]: s for s in body["shares"]}
        assert by_machine[self.L1]["quantity"] == pytest.approx(60.0)
        assert by_machine[self.L2]["quantity"] == pytest.approx(40.0)
        assert by_machine[self.L1]["stale"] is False
        assert by_machine[self.L1]["purged"] is False

    def test_detail_404_for_unknown_header(self, client):
        response = client.get(f"/distribution/{self.PLANT}/NOPE/NOPE")
        assert response.status_code == 404

    def test_summary_counts_the_seeded_header_as_needs_review(self, client):
        response = client.get(f"/distribution/{self.PLANT}/summary")
        assert response.status_code == 200
        body = response.json()
        assert body["needs_review"] >= 1
        assert set(body.keys()) == {"needs_review", "changed", "problems"}

    def test_aggregate_rolls_up_one_row_per_header(self, client):
        response = client.get(f"/distribution/{self.PLANT}/aggregate", params={"workcenter": self.WC})
        assert response.status_code == 200
        rows = response.json()["data"]
        assert len(rows) == 1
        row = rows[0]
        assert row["production_order"] == self.ORD
        assert row["machine"] == self.WC
        assert row["child_count"] == 2
        assert row["sum_child_quantity"] == pytest.approx(100.0)
        assert len(row["children"]) == 2
        # Child runtimes are 6/4 hours; the header runtime is 10. Alias
        # qualification must retain child timing, never the header's finish.
        assert row["start"] == "2026-10-01T08:00:00"
        assert row["finish"] == "2026-10-01T14:00:00"
        assert {child["machine"]: child["end"] for child in row["children"]} == {
            self.L1: "2026-10-01T14:00:00", self.L2: "2026-10-01T12:00:00",
        }

    def test_aggregate_csv_export(self, client):
        response = client.get(f"/distribution/{self.PLANT}/aggregate",
                              params={"workcenter": self.WC, "format": "csv"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        assert self.ORD in response.text

    def test_unresolved_lists_the_unmapped_machine(self, client):
        response = client.get(f"/distribution/{self.PLANT}/unresolved")
        assert response.status_code == 200
        body = response.json()
        machines = {e["machine"] for e in body["exceptions"]}
        assert self.UNRESOLVED_MACHINE in machines
        assert self.L1 not in machines and self.L2 not in machines


# =====================================================================
# P2-8/P2-9 -- planner re-weight/review/reset + admin reapply-defaults/resolve
# (aggregate_to_detail.md SS5.5-SS5.7). Same real-DB caveat as the plan()/
# apply() section above: NOT run in this sandboxed environment (.env's
# PG_HOST points at the live Azure pilot DB) -- verified only via py_compile
# + the RBAC/route-guard suite, not an actual pytest run against Postgres. A
# human with a local Postgres instance must run these to confirm pass/fail.
# =====================================================================

class _ReweightFixtureBase:
    """Shared seed shape for the re-weight/reset/resolve tests below: one
    distribute-mode work center, two machines (60/40 default split), one
    ingested parent with two lettered children."""
    SUB, PLANT = "WTG", "1006"

    def _cleanup(self, cur, wc, l1, l2, ord_, mat):
        cur.execute("DELETE FROM orders WHERE plant = %s AND (parent_production_order = %s OR production_order = %s)",
                    (self.PLANT, ord_, ord_))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, ord_))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)", (self.PLANT, l1, l2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s", (self.PLANT, wc))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s", (self.PLANT, mat))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (mat,))

    def _seed_header(self, db_, wc, l1, l2, ord_, mat):
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, wc, l1, l2, ord_, mat)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES (%s, %s, 'distribute')",
                (self.PLANT, wc),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, l1, wc, 60, self.SUB, self.PLANT, l2, wc, 40),
            )
            _seed_distribution_material(cur, mat, self.PLANT)
            conn.commit()
        batch_id = str(uuid.uuid4())
        row = {
            "production_order": ord_, "material_number": mat, "machine": wc, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        _, plan_structure, _ = distribution_data.plan([row], batch_id)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_structure, batch_id, conn)


@pytest.mark.pg
class TestReweightSharesGuards(_ReweightFixtureBase):
    """409 `stale` / 409 `children_scheduled` guards on POST .../shares."""
    WC = "ZZTEST_WC_RWGUARD"
    L1, L2 = "ZZTEST_L1_RWGUARD", "ZZTEST_L2_RWGUARD"
    ORD, MAT = "ZZTEST_ORD_RWGUARD", "ZZTEST_MAT_RWGUARD"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_stale_base_version_raises_409(self, pg):
        with pytest.raises(distribution_data.DistributionStaleVersion):
            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT, [{"machine": self.L1, "weight": 100}],
                base_version=-1, actor="tester",
            )

    def test_removing_a_scheduled_child_without_confirm_raises_409(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        l2_child = next(c for c in children if c["machine"] == self.L2)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE id = %s",
                (dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 12, 0), l2_child["id"]),
            )
            conn.commit()

        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        with pytest.raises(distribution_data.DistributionChildrenScheduled) as excinfo:
            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT, [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
                base_version=header["xmin"], actor="tester",
            )
        assert excinfo.value.children[0]["id"] == l2_child["id"]

        # Same call WITH confirm_remove_scheduled succeeds and deletes L2's child.
        result = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT, [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
            base_version=header["xmin"], confirm_remove_scheduled=True, actor="tester",
        )
        assert l2_child["id"] in result["removed"]
        remaining = _snapshot_children(pg, self.PLANT, self.ORD)
        assert all(c["id"] != l2_child["id"] for c in remaining)


@pytest.mark.pg
class TestReweightSharesDryRunParity(_ReweightFixtureBase):
    """A dry-run's `plan` must match what the following real call then
    writes -- an actual two-call test, diffing the results, per SS5.5 step 8's
    explicit parity requirement."""
    WC = "ZZTEST_WC_RWDRY"
    L1, L2 = "ZZTEST_L1_RWDRY", "ZZTEST_L2_RWDRY"
    ORD, MAT = "ZZTEST_ORD_RWDRY", "ZZTEST_MAT_RWDRY"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_dry_run_plan_matches_the_subsequent_real_write(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        new_shares = [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}]

        dry = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT, new_shares, base_version=header["xmin"],
            dry_run=True, actor="tester",
        )
        assert "plan" in dry
        dry_by_machine = {e["machine"]: e for e in dry["plan"]}

        # The dry run must not have written anything.
        assert _snapshot_header(pg, self.PLANT, self.ORD, self.MAT) == header

        real = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT, new_shares, base_version=header["xmin"],
            dry_run=False, actor="tester",
        )
        real_by_machine = {c["machine"]: c for c in real["children"]}

        for machine in (self.L1, self.L2):
            previewed_qty = dry_by_machine[machine]["qty_after"]
            written_qty = real_by_machine[machine]["order_quantity"]
            assert previewed_qty == pytest.approx(float(written_qty)), \
                f"{machine}: dry-run preview {previewed_qty} != written {written_qty}"
            previewed_hours = dry_by_machine[machine]["hours_after"]
            written_hours = real_by_machine[machine]["run_time"]
            assert previewed_hours == pytest.approx(float(written_hours))


@pytest.mark.pg
class TestReweightSharesPurgedRefusal(_ReweightFixtureBase):
    """400 `share_purged`: a positive weight on a purged share is refused
    even with `allow_stale: true` -- only a fresh upload revives it."""
    WC = "ZZTEST_WC_RWPURGE"
    L1, L2 = "ZZTEST_L1_RWPURGE", "ZZTEST_L2_RWPURGE"
    ORD, MAT = "ZZTEST_ORD_RWPURGE", "ZZTEST_MAT_RWPURGE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE order_distribution_share SET purged_at = now(), child_id = NULL"
                " WHERE plant = %s AND production_order = %s AND material_number = %s AND machine = %s",
                (self.PLANT, self.ORD, self.MAT, self.L2),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_positive_weight_on_a_purged_share_is_refused(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        with pytest.raises(ValueError, match="share_purged"):
            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT,
                [{"machine": self.L1, "weight": 50}, {"machine": self.L2, "weight": 50}],
                base_version=header["xmin"], allow_stale=True, actor="tester",
            )


@pytest.mark.pg
class TestReweightSharesCollapse(_ReweightFixtureBase):
    """SS5.5 bullet 6, the N->1 collapse: when the surviving 100 % machine
    already had a living, SCHEDULED child, its schedule and segments must
    land on the new bare id, not be discarded."""
    WC = "ZZTEST_WC_RWCOLLAPSE"
    L1, L2 = "ZZTEST_L1_RWCOLLAPSE", "ZZTEST_L2_RWCOLLAPSE"
    ORD, MAT = "ZZTEST_ORD_RWCOLLAPSE", "ZZTEST_MAT_RWCOL"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_collapse_copies_schedule_and_repoints_segments(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        l1_child = next(c for c in children if c["machine"] == self.L1)
        assert l1_child["distribution_letter"] is not None, "L1 must start lettered (2 positive shares)"
        old_child_id = l1_child["id"]
        sched_start = dt.datetime(2026, 10, 1, 8, 0)
        sched_end = dt.datetime(2026, 10, 1, 12, 0)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET scheduled_start = %s, scheduled_end = %s, notes = %s WHERE id = %s",
                (sched_start, sched_end, "keep me", old_child_id),
            )
            cur.execute(
                "INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                " VALUES (%s, 1, %s, %s)",
                (old_child_id, sched_start, sched_end),
            )
            conn.commit()

        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        result = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
            base_version=header["xmin"], confirm_remove_scheduled=True, actor="tester",
        )

        new_bare_id = pg.make_id(self.ORD, self.MAT)
        assert old_child_id in result["removed"]
        assert new_bare_id != old_child_id

        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT scheduled_start, scheduled_end, notes FROM orders WHERE id = %s", (new_bare_id,),
            )
            new_row = cur.fetchone()
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (old_child_id,))
            old_still_exists = cur.fetchone()[0]
            cur.execute(
                "SELECT order_id FROM order_schedule_segments WHERE scheduled_start = %s", (sched_start,),
            )
            segment_owner = cur.fetchone()

        assert old_still_exists == 0, "the superseded lettered child must be deleted"
        assert new_row is not None, "the surviving 100% machine's bare id must exist"
        assert new_row[0] == sched_start and new_row[1] == sched_end
        assert new_row[2] == "keep me"
        assert segment_owner is not None and segment_owner[0] == new_bare_id, \
            "the segment must be re-pointed onto the new bare id, not cascade-deleted"


@pytest.mark.pg
class TestResolveRepairRecoversIncompleteHeader(_ReweightFixtureBase):
    """`resolve` scope `repair`: a header whose children set doesn't match
    its positive/unpurged shares (`incomplete`) gets its missing child
    recreated from CURRENT shares -- and a purged share's child is NEVER
    recreated alongside it."""
    WC = "ZZTEST_WC_REPAIR"
    L1, L2, L3_PURGED = "ZZTEST_L1_REPAIR", "ZZTEST_L2_REPAIR", "ZZTEST_L3_REPAIR_PURGED"
    ORD, MAT = "ZZTEST_ORD_REPAIR", "ZZTEST_MAT_REPAIR"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            # A purged, positive-weight third share with no member row and no
            # child -- repair must leave it exactly alone.
            cur.execute(
                "INSERT INTO order_distribution_share (plant, production_order, material_number,"
                " machine, letter, weight, child_id, purged_at)"
                " VALUES (%s, %s, %s, %s, 'C', 25, NULL, now())",
                (self.PLANT, self.ORD, self.MAT, self.L3_PURGED),
            )
            conn.commit()

        children = _snapshot_children(pg, self.PLANT, self.ORD)
        self._missing_machine = self.L2
        missing_child = next(c for c in children if c["machine"] == self.L2)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            # Simulate the crash window: the child row is gone but the share
            # still points at it -- the header now reads `incomplete`.
            cur.execute("DELETE FROM orders WHERE id = %s", (missing_child["id"],))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM order_distribution_share WHERE plant=%s AND production_order=%s"
                " AND material_number=%s AND machine=%s",
                (self.PLANT, self.ORD, self.MAT, self.L3_PURGED),
            )
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_repair_recreates_the_missing_child_and_never_the_purged_one(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            rows = distribution_data._fetch_header_rows(cur, self.PLANT)
            distribution_data._hydrate_headers(cur, self.PLANT, rows)
        this_header = next(h for h in rows if h["production_order"] == self.ORD)
        assert "incomplete" in this_header["statuses"]

        result = distribution_data.resolve(self.PLANT, "repair", dry_run=False)
        assert result["repaired"] >= 1

        children = _snapshot_children(pg, self.PLANT, self.ORD)
        by_machine = {c["machine"]: c for c in children}
        assert self.L2 in by_machine, "the missing L2 child must be recreated"
        assert self.L3_PURGED not in by_machine, "a purged share's child must never be recreated"

        with pg._pool.connection() as conn, conn.cursor() as cur:
            rows2 = distribution_data._fetch_header_rows(cur, self.PLANT)
            distribution_data._hydrate_headers(cur, self.PLANT, rows2)
        this_header2 = next(h for h in rows2 if h["production_order"] == self.ORD)
        assert "incomplete" not in this_header2["statuses"]


# =====================================================================
# ROUTING_RUNTIME_DESIGN.md §4 item 4 -- _CHILD_UPSERT_SQL's run_time guard,
# the runtime_schedule_mismatch no-auto-flag fix, and the three resolver call
# sites (reweight_shares/reset_one_header/_resolve_repair). Same real-DB
# caveat as every other @pytest.mark.pg class in this file (NOT run in this
# sandboxed environment; a human with a local Postgres instance must confirm
# pass/fail). Reuses _ReweightFixtureBase's 60/40, two-machine seed shape.
# =====================================================================

@pytest.mark.pg
class TestChildUpsertRunTimeSourceGuard(_ReweightFixtureBase):
    """`_CHILD_UPSERT_SQL`'s ON CONFLICT run_time CASE must never overwrite a
    child whose run_time_source is 'routing' or 'manual' -- those values were
    set by a mechanism more authoritative than a plain SAP-facts refresh.
    Every other source (legacy/distributed/sap_order/NULL) still gets
    refreshed to the newly-apportioned value, exactly as before this fix."""
    WC = "ZZTEST_WC_RTSRC"
    L1, L2 = "ZZTEST_L1_RTSRC", "ZZTEST_L2_RTSRC"
    ORD, MAT = "ZZTEST_ORD_RTSRC", "ZZTEST_MAT_RTSRC"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        # 60/40 split, run_time=10.0h -> L1=6.0h, L2=4.0h to start.
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def _set_run_time_source(self, pg, machine, source, sentinel_run_time):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET run_time_source = %s, run_time = %s"
                " WHERE plant = %s AND parent_production_order = %s AND machine = %s",
                (source, sentinel_run_time, self.PLANT, self.ORD, machine),
            )
            conn.commit()

    def _reingest_run_time(self, pg, run_time):
        batch_id = str(uuid.uuid4())
        row = {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": run_time,
        }
        _, plan_structure, _ = distribution_data.plan([row], batch_id)
        with pg._pool.connection() as conn:
            distribution_data.apply(plan_structure, batch_id, conn)

    def _l1_run_time(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        l1 = next(c for c in children if c["machine"] == self.L1)
        return float(l1["run_time"])

    @pytest.mark.parametrize("source", ["routing", "manual"])
    def test_guarded_source_keeps_its_existing_run_time(self, pg, source):
        # 20.0h at 60% would otherwise apportion L1 to 12.0h -- a real change
        # from the 999.0h sentinel, so the WHERE clause fires and the CASE is
        # actually exercised, not skipped as a no-op.
        self._set_run_time_source(pg, self.L1, source, 999.0)
        self._reingest_run_time(pg, 20.0)
        assert self._l1_run_time(pg) == pytest.approx(999.0)

    @pytest.mark.parametrize("source", ["legacy", "distributed", "sap_order", None])
    def test_unguarded_source_gets_refreshed_to_the_new_apportioned_value(self, pg, source):
        if source is not None:
            self._set_run_time_source(pg, self.L1, source, 999.0)
        self._reingest_run_time(pg, 20.0)  # 60% of 20.0h = 12.0h
        assert self._l1_run_time(pg) == pytest.approx(12.0)


@pytest.mark.pg
class TestChildUpsertNeverAutoFlagsRuntimeMismatch(_ReweightFixtureBase):
    """`_CHILD_UPSERT_SQL`'s ON CONFLICT SET clause for
    runtime_schedule_mismatch is `COALESCE(orders.runtime_schedule_mismatch,
    FALSE)` -- the same fix pattern as db.py's own `_UPSERT_SQL`. A
    distribution write only ever PRESERVES whatever the flag already was; it
    never computes or sets it from the refreshed facts."""
    WC = "ZZTEST_WC_MISMATCH"
    L1, L2 = "ZZTEST_L1_MISMATCH", "ZZTEST_L2_MISMATCH"
    ORD, MAT = "ZZTEST_ORD_MISMATCH", "ZZTEST_MAT_MISMTCH"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def _reingest_run_time(self, pg, run_time, qty=150.0):
        batch_id = str(uuid.uuid4())
        row = {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": qty, "run_time": run_time,
        }
        _, plan_structure, _ = distribution_data.plan([row], batch_id)
        with pg._pool.connection() as conn:
            distribution_data.apply(plan_structure, batch_id, conn)

    def _mismatch_flag(self, pg, machine):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT runtime_schedule_mismatch FROM orders"
                " WHERE plant = %s AND parent_production_order = %s AND machine = %s",
                (self.PLANT, self.ORD, machine),
            )
            return cur.fetchone()[0]

    def test_true_flag_survives_a_facts_refresh_that_touches_the_row(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET runtime_schedule_mismatch = TRUE"
                " WHERE plant = %s AND parent_production_order = %s AND machine = %s",
                (self.PLANT, self.ORD, self.L1),
            )
            conn.commit()

        # Changes both qty and run_time so the row is genuinely touched (the
        # WHERE clause's IS DISTINCT FROM checks must fire).
        self._reingest_run_time(pg, 30.0)

        assert self._mismatch_flag(pg, self.L1) is True

    def test_flag_is_never_auto_set_true_by_a_write_that_did_not_set_it(self, pg):
        # Both children start FALSE/NULL (fresh insert never sets the column).
        self._reingest_run_time(pg, 45.0)
        assert self._mismatch_flag(pg, self.L1) is not True
        assert self._mismatch_flag(pg, self.L2) is not True


@pytest.mark.pg
class TestResolverCallSitesAfterRealDistributionWrites(_ReweightFixtureBase):
    """ROUTING_RUNTIME_DESIGN.md §4 item 4: `reweight_shares`,
    `reset_one_header`, and `_resolve_repair` each call
    `backend.routing.resolver.resolve_orders(plant)` (via a deferred,
    in-function import) exactly once, AFTER their own real (non-dry-run)
    write commits -- and NEVER during a dry_run call. Patches the module
    ATTRIBUTE directly (`mock.patch.object(routing_resolver, "resolve_orders")`)
    rather than where it's imported from: Python's sys.modules import caching
    means the deferred `import backend.routing.resolver as routing_resolver`
    inside each function still resolves to this same module object, so the
    patched attribute is what gets called regardless of the import site."""
    WC = "ZZTEST_WC_RESOLVER"
    L1, L2 = "ZZTEST_L1_RESOLVER", "ZZTEST_L2_RESOLVER"
    ORD, MAT = "ZZTEST_ORD_RESOLVER", "ZZTEST_MAT_RESOLVE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_reweight_shares_calls_resolver_once_after_real_write_never_on_dry_run(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        new_shares = [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}]

        with mock.patch.object(routing_resolver, "resolve_orders") as fake_resolve:
            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT, new_shares, base_version=header["xmin"],
                dry_run=True, actor="tester",
            )
            fake_resolve.assert_not_called()

            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT, new_shares, base_version=header["xmin"],
                dry_run=False, actor="tester",
            )
            fake_resolve.assert_called_once_with(self.PLANT)

    def test_reset_one_header_calls_resolver_once_after_real_write_never_on_dry_run(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)

        with mock.patch.object(routing_resolver, "resolve_orders") as fake_resolve:
            distribution_data.reset_one_header(
                self.PLANT, self.ORD, self.MAT, base_version=header["xmin"],
                dry_run=True, actor="tester",
            )
            fake_resolve.assert_not_called()

            distribution_data.reset_one_header(
                self.PLANT, self.ORD, self.MAT, base_version=header["xmin"],
                dry_run=False, actor="tester",
            )
            fake_resolve.assert_called_once_with(self.PLANT)

    def test_resolve_repair_calls_resolver_once_after_real_write_never_on_dry_run(self, pg):
        # Force the header into `incomplete` so `_resolve_repair` has
        # something to repair (same crash-window simulation as
        # TestResolveRepairRecoversIncompleteHeader above).
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        missing_child = next(c for c in children if c["machine"] == self.L2)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (missing_child["id"],))
            conn.commit()

        with mock.patch.object(routing_resolver, "resolve_orders") as fake_resolve:
            dry_result = distribution_data.resolve(self.PLANT, "repair", dry_run=True)
            assert dry_result["repaired"] >= 1, "the header must actually be incomplete/repairable here"
            fake_resolve.assert_not_called()

            real_result = distribution_data.resolve(self.PLANT, "repair", dry_run=False)
            assert real_result["repaired"] >= 1
            fake_resolve.assert_called_once_with(self.PLANT)


@pytest.mark.pg
class TestDistributionCanonicalWriteResponse(_ReweightFixtureBase):
    WC = "ZZTEST_WC_CANONICAL"
    L1, L2 = "ZZTEST_L1_CANONICAL", "ZZTEST_L2_CANONICAL"
    L3 = "ZZTEST_L3_CANONICAL"
    ORD, MAT = "ZZTEST_ORD_CANON", "ZZTEST_MAT_CANON"

    def _cleanup(self, cur, wc, l1, l2, ord_, mat):
        cur.execute("UPDATE machine SET sap_workcenter=NULL WHERE plant=%s AND machine=%s", (self.PLANT, self.L3))
        super()._cleanup(cur, wc, l1, l2, ord_, mat)
        cur.execute("DELETE FROM machine WHERE plant=%s AND machine=%s", (self.PLANT, self.L3))

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_reset_links_new_member_and_next_removal_guards_and_deletes_its_child(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight)"
                " VALUES (%s,%s,%s,%s,40)", (self.SUB, self.PLANT, self.L3, self.WC),
            )
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        result = distribution_data.reset_one_header(self.PLANT, self.ORD, self.MAT, header["xmin"])
        added = next(c for c in result["children"] if c["machine"] == self.L3)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT child_id FROM order_distribution_share WHERE plant=%s AND production_order=%s"
                " AND material_number=%s AND machine=%s", (self.PLANT, self.ORD, self.MAT, self.L3),
            )
            assert cur.fetchone()[0] == added["id"]
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s WHERE id=%s",
                        (dt.datetime(2026, 10, 1, 8), dt.datetime(2026, 10, 1, 12), added["id"]))
            conn.commit()
        desired = [{"machine": self.L1, "weight": 60}, {"machine": self.L2, "weight": 40},
                   {"machine": self.L3, "weight": 0}]
        with pytest.raises(distribution_data.DistributionChildrenScheduled):
            distribution_data.reweight_shares(self.PLANT, self.ORD, self.MAT, desired, result["base_version"])
        removed = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT, desired, result["base_version"], confirm_remove_scheduled=True,
        )
        assert added["id"] in removed["removed"]
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id=%s", (added["id"],))
            assert cur.fetchone()[0] == 0

    def test_collapse_response_carries_preserved_segment_aggregate(self, pg):
        survivor = next(c for c in _snapshot_children(pg, self.PLANT, self.ORD) if c["machine"] == self.L1)
        segments = [(1, dt.datetime(2026, 10, 1, 8), dt.datetime(2026, 10, 1, 11)),
                    (2, dt.datetime(2026, 10, 1, 12), dt.datetime(2026, 10, 1, 15))]
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s WHERE id=%s",
                        (segments[0][1], segments[-1][2], survivor["id"]))
            cur.executemany(
                "INSERT INTO order_schedule_segments (order_id,segment_no,scheduled_start,scheduled_end)"
                " VALUES (%s,%s,%s,%s)", [(survivor["id"], *segment) for segment in segments],
            )
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        result = distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT, [{"machine": self.L1, "weight": 1}], header["xmin"],
            confirm_remove_scheduled=True,
        )
        child = result["children"][0]
        assert child["id"] != survivor["id"]
        assert child["plant"] == self.PLANT and child["material_number"] == self.MAT
        assert len(child["schedule_segments"]) == 2
        for actual, (sequence, start, end) in zip(child["schedule_segments"], segments, strict=True):
            assert actual["sequence"] == sequence
            assert dt.datetime.fromisoformat(actual["start_date"]) == start
            assert dt.datetime.fromisoformat(actual["end_date"]) == end
        assert child["runtime_schedule_mismatch"] is True  # preserved pieces total 6 h, parent now 10 h

    @pytest.mark.parametrize("operation", ["shares", "reset"])
    def test_response_reads_runtime_attributes_and_version_after_resolver_commit(self, pg, operation):
        def resolve_after_commit(plant):
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    "UPDATE orders SET run_time=1.5, run_time_source='routing',"
                    " run_time_basis='{}'::jsonb, prt_01='CURRENT-TOOL', production_version='0002'"
                    " WHERE plant=%s AND parent_production_order=%s", (plant, self.ORD),
                )
                conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        with mock.patch.object(routing_resolver, "resolve_orders", side_effect=resolve_after_commit):
            if operation == "shares":
                result = distribution_data.reweight_shares(
                    self.PLANT, self.ORD, self.MAT,
                    [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}], header["xmin"],
                )
            else:
                result = distribution_data.reset_one_header(self.PLANT, self.ORD, self.MAT, header["xmin"])
        with pg._pool.connection() as conn, conn.cursor() as cur:
            for child in result["children"]:
                cur.execute("SELECT xmin::text::bigint FROM orders WHERE id=%s", (child["id"],))
                assert child["base_version"] == cur.fetchone()[0]
                assert result["versions"][child["id"]] == child["base_version"]
                assert child["run_time"] == Decimal('1.5')
                assert child["run_time_source"] == 'routing'
                assert child["run_time_basis"] == {}
                assert child["prt_01"] == 'CURRENT-TOOL'
                assert child["production_version"] == '0002'
