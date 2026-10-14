"""
Unit tests for backend/distribution/service.py's pure functions (no DB
dependency) and backend/distribution/data.py's plan()/apply() ingest
transaction seam (@pytest.mark.pg -- requires a local/CI Postgres with
NIMBUS_TEST_DB=1; auto-skipped otherwise, see tests/conftest.py).
"""

import json
import random
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

    def test_name_collision_machine_wins(self):
        """Same value in both lookups (a 1:1 work center): machine-first, plain order."""
        result = classify_row(
            "P1", "X1",
            {"P1": {"X1": {}}},
            {"P1": {"X1": {"distribution_mode": "single", "default_machine": None, "members": ["X1"]}}},
        )
        assert result["type"] == "plain"
        assert result["machine"] == "X1"
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

    def test_all_zero_weights_gives_all_zero_shares(self):
        """D03: every member explicitly weighted 0 (no material-default/tooled
        rule) -> all-zero shares. _plan_core/reset_one_header rely on this to
        detect a work center with no real distribution policy."""
        members = [("L1", Decimal(0)), ("L2", Decimal(0))]
        material_attrs = {}
        workcenter = {}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(0)
        assert shares["L2"] == Decimal(0)

    def test_blank_and_zero_weights_gives_all_zero_shares(self):
        """D03: one NULL (blank) weight alongside one explicit 0 -- NULL
        becomes 0 under the has-any-weight branch (not the even-split
        branch, since 0 is not None) -> still all-zero."""
        members = [("L1", None), ("L2", Decimal(0))]
        material_attrs = {}
        workcenter = {}
        shares, basis = compute_default_shares(material_attrs, workcenter, members)
        assert basis == "workcenter_weights"
        assert shares["L1"] == Decimal(0)
        assert shares["L2"] == Decimal(0)


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

    def test_fine_total_rounded_to_unit_before_split_when_opted_in(self):
        """D53: with `round_total=True` (the labor/machine-hours callers'
        opt-in), a total with more decimal precision than `unit` rounds to
        the unit FIRST -- without that, 2.3333 split three ways in
        0.01-hour units silently overshoots to 2.34."""
        total = Decimal("2.3333")
        weights = {"L1": Decimal(1), "L2": Decimal(1), "L3": Decimal(1)}
        unit = Decimal("0.01")
        result = apportion(total, weights, unit, round_total=True)
        assert sum(result.values()) == Decimal("2.33")

    def test_fine_total_not_rounded_by_default(self):
        """D53: `round_total` defaults to False -- a caller that doesn't opt
        in (quantity, run-time-minutes) still overshoots exactly as it did
        on base 515417a; this function must not change their behavior."""
        total = Decimal("2.3333")
        weights = {"L1": Decimal(1), "L2": Decimal(1), "L3": Decimal(1)}
        unit = Decimal("0.01")
        result = apportion(total, weights, unit)
        assert sum(result.values()) == Decimal("2.34")

    def test_single_child_rounds_half_up_when_opted_in(self):
        """D53: a lone child's total is still rounded to the unit
        (ROUND_HALF_UP) when `round_total=True`."""
        total = Decimal("1.005")
        weights = {"L1": Decimal(1)}
        unit = Decimal("0.01")
        result = apportion(total, weights, unit, round_total=True)
        assert result["L1"] == Decimal("1.01")

    def test_negative_total_apportions_symmetrically(self):
        """D53: a negative total must never raise -- it apportions the
        positive magnitude and negates every result (plan_fn runs outside
        upsert_orders' try, so apportion() can't afford to crash it). Applies
        regardless of `round_total`."""
        total = Decimal(-10)
        weights = {"L1": Decimal(1), "L2": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        assert result["L1"] == Decimal(-5)
        assert result["L2"] == Decimal(-5)
        assert sum(result.values()) == Decimal(-10)

    def test_quantity_lot_size_split_unaffected_by_round_total_gate(self):
        """D53 review finding 1: the QUANTITY path calls apportion() with
        `unit = incremental_lot_size` (a real H6 lot-size rule, out of scope
        for this plan) and never passes `round_total`. A 104-unit order on a
        10-unit lot, split 50/50, must give the EXACT SAME result as on base
        515417a: {"L1": 60, "L2": 50} (sum 110, the pre-existing lot-size
        largest-remainder behavior -- H6 territory, untouched here)."""
        total = Decimal(104)
        weights = {"L1": Decimal(1), "L2": Decimal(1)}
        unit = Decimal(10)
        tie_order = ["L1", "L2"]
        result = apportion(total, weights, unit, tie_order)
        assert result == {"L1": Decimal(60), "L2": Decimal(50)}
        assert sum(result.values()) == Decimal(110)


class TestApportionRoundUpRemainder:
    """H6 / owner rule (2026-09-25 rev. 4): with round_up_remainder=True, no
    lot-size rounding and every non-zero fractional share rounds UP to a
    whole unit -- independently per machine, not a single unit of remainder
    handed to the largest fractional share."""

    def test_evenly_divisible_ignores_lot_size_515_515(self):
        """1,030 split evenly across 2 machines with an incremental lot size
        of 50 must still yield 515 + 515 -- the lot size is completely
        ignored for quantity apportionment now (unit is forced to 1 by the
        caller in data.py, not by apportion() itself, so this test passes
        unit=1 directly to pin apportion()'s own contract)."""
        total = Decimal(1030)
        weights = {"M1": Decimal(1), "M2": Decimal(1)}
        unit = Decimal(1)  # data.py forces this regardless of incremental_lot_size=50
        result = apportion(total, weights, unit, round_up_remainder=True)
        assert result == {"M1": Decimal(515), "M2": Decimal(515)}
        assert sum(result.values()) == total

    def test_fractional_split_rounds_every_share_up_516_516(self):
        """1,031 split evenly across 2 machines: ideal shares are 515.5 each
        -- BOTH must round up to 516 (not one machine getting the extra unit
        via largest-remainder, which would produce 516 + 515). The total
        (1,032) legitimately exceeds the SAP order quantity (1,031) by one
        piece, which the owner's rule explicitly allows."""
        total = Decimal(1031)
        weights = {"M1": Decimal(1), "M2": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total, weights, unit, round_up_remainder=True)
        assert result == {"M1": Decimal(516), "M2": Decimal(516)}
        assert sum(result.values()) == Decimal(1032)  # over by 1, not exact

    def test_unequal_weights_round_up_independently(self):
        """A three-way uneven split where every share is fractional: each
        machine's own share rounds up independently, not just one recipient
        of a pooled remainder."""
        total = Decimal(100)
        weights = {"M1": Decimal(1), "M2": Decimal(1), "M3": Decimal(1)}
        unit = Decimal(1)
        # Ideal shares: 33.333... each -> every one rounds up to 34.
        result = apportion(total, weights, unit, round_up_remainder=True)
        assert result == {"M1": Decimal(34), "M2": Decimal(34), "M3": Decimal(34)}
        assert sum(result.values()) == Decimal(102)  # over by 2 (one per fractional share)

    def test_zero_weight_machine_gets_zero(self):
        """A machine with 0 weight still gets 0 under round_up_remainder,
        same as the default mode."""
        total = Decimal(100)
        weights = {"M1": Decimal(1), "M2": Decimal(0)}
        unit = Decimal(1)
        result = apportion(total, weights, unit, round_up_remainder=True)
        assert result["M2"] == Decimal(0)
        assert result["M1"] == Decimal(100)


class TestApportionOtherSplitsUnaffectedByRoundUpRemainder:
    """Regression: run-time, labor-hours, and machine-hours apportionment
    call apportion() WITHOUT round_up_remainder (its default is False), so
    they must keep their exact existing largest-remainder behavior,
    byte-for-byte, unaffected by the new parameter's existence."""

    def test_default_call_signature_unchanged(self):
        """Calling apportion() with the pre-existing 4 positional/keyword
        args (no round_up_remainder) reproduces the exact same
        largest-remainder result as before this change -- this is the
        run-time/labor-hours/machine-hours call shape in data.py."""
        total = Decimal(1031)
        weights = {"M1": Decimal(1), "M2": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total, weights, unit)
        # Largest-remainder: floor(515.5)=515 each, then 1 unit of remainder
        # goes to whichever machine wins the tie (alphabetical: M1).
        assert sum(result.values()) == total
        assert result["M1"] == Decimal(516)
        assert result["M2"] == Decimal(515)

    def test_run_time_style_minutes_apportionment_exact_sum(self):
        """Run-time minutes apportionment (data.py's unit=Decimal(1) call,
        no round_up_remainder) must still sum EXACTLY to the total -- never
        over, unlike the quantity mode."""
        total_minutes = Decimal(931)  # e.g. 15.516... hours * 60, rounded
        weights = {"M1": Decimal(2), "M2": Decimal(1), "M3": Decimal(1)}
        unit = Decimal(1)
        result = apportion(total_minutes, weights, unit)
        assert sum(result.values()) == total_minutes

    def test_hours_style_apportionment_exact_sum(self):
        """Labor-hours / machine-hours apportionment (data.py's
        _HOURS_APPORTION_UNIT = Decimal('0.01'), no round_up_remainder) must
        still sum EXACTLY to the total."""
        total_hours = Decimal("10.03")
        weights = {"M1": Decimal(1), "M2": Decimal(1), "M3": Decimal(1)}
        unit = Decimal("0.01")
        result = apportion(total_hours, weights, unit)
        assert sum(result.values()) == total_hours

    def test_explicit_round_up_remainder_false_matches_default(self):
        """Passing round_up_remainder=False explicitly must be identical to
        omitting it -- guards against the default value itself having been
        changed by accident."""
        total = Decimal(1031)
        weights = {"M1": Decimal(1), "M2": Decimal(1)}
        unit = Decimal(1)
        tie_order = ["M1", "M2"]
        result_omitted = apportion(total, weights, unit, tie_order)
        result_explicit = apportion(total, weights, unit, tie_order, round_up_remainder=False)
        assert result_omitted == result_explicit



class TestBuildChildRowsQuantityRoundsUp:
    """H6 call site: _build_child_rows (shared by save and the dry-run preview)
    must ignore incremental_lot_size and round each quantity share up, while
    hours/minutes keep their exact-sum split."""

    def test_lot_size_ignored_and_shares_round_up(self):
        import backend.distribution.data as dist_data
        rows, _ids, _z = dist_data._build_child_rows(
            "P1", "1000", "MAT", {"order_quantity": 1031, "run_time": None},
            {"M1": 1, "M2": 1}, {"M1": "A", "M2": "B"}, {"incremental_lot_size": 50},
        )
        qtys = sorted(float(r["order_quantity"]) for r in rows)
        assert qtys == [516.0, 516.0]


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

    def test_qty_changed_requires_non_null_reviewed_quantity(self):
        """D16: a reviewed header whose reviewed_quantity was never stamped
        (NULL) must NOT show qty_changed just because NULL != order_quantity."""
        header = {
            "reviewed": True,
            "order_quantity": Decimal(100),
            "reviewed_quantity": None,
        }
        shares = []
        children = []
        statuses = compute_derived_statuses(header, shares, children, None, {})
        assert "qty_changed" not in statuses

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
                      default_basis, source, sap_facts, xmin::text::bigint, updated_at,
                      reviewed_quantity, reviewed_at
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
        "reviewed_quantity": row[10], "reviewed_at": row[11],
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
class TestDedupeAndFilterConflicts:
    """D04: the duplicate/conflict rule now runs AFTER classification and the
    existing-header load, so it only touches groups actually involved with
    distribution -- a plain duplicate (production_order, material_number)
    pair with no distribution involvement at all must pass straight through
    unfiltered (upsert_orders' own id loop is what suffixes a second copy
    `_1`/`_2`, with one summary warning), while the SAME pair still gets
    caught by the rule once both rows resolve to distribute-mode work
    centers."""
    PLANT = "1006"
    SUB = "WTG"
    ORD, MAT = "ZZTEST_DEDUPE_ORD", "ZZTEST_DEDUPE_MAT"
    M1, M2 = "ZZTEST_DEDUPE_M1", "ZZTEST_DEDUPE_M2"
    WC1, WC2 = "ZZTEST_DEDUPE_WC1", "ZZTEST_DEDUPE_WC2"
    WC1_MEMBER, WC2_MEMBER = "ZZTEST_DEDUPE_WC1_MEM", "ZZTEST_DEDUPE_WC2_MEM"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        self._cleanup(db_)
        yield
        self._cleanup(db_)

    def _cleanup(self, db_):
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                (self.ORD, self.ORD),
            )
            cur.execute(
                "DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                (self.PLANT, self.ORD),
            )
            cur.execute(
                "DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s, %s, %s)",
                (self.PLANT, self.M1, self.M2, self.WC1_MEMBER, self.WC2_MEMBER),
            )
            cur.execute(
                "DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter IN (%s, %s)",
                (self.PLANT, self.WC1, self.WC2),
            )
            conn.commit()

    def _row(self, machine):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": machine, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def test_plain_duplicate_on_non_distributed_plant_passes_through_unfiltered(self, pg):
        """Order 2000 on M1 and M2, both plain machines (no distribution
        involvement at all): both rows must reach rows_out unchanged -- no
        duplicate/conflict warning is raised here; upsert_orders' own id loop
        is what suffixes the second one `_1`."""
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,%s),(%s,%s,%s)",
                (self.SUB, self.PLANT, self.M1, self.SUB, self.PLANT, self.M2),
            )
            conn.commit()

        batch_id = str(uuid.uuid4())
        rows = [self._row(self.M1), self._row(self.M2)]
        rows_out, plan_structure, warnings = distribution_data.plan(rows, batch_id)

        assert len(rows_out) == 2, "both rows must reach rows_out, not just one survivor"
        assert {r["machine"] for r in rows_out} == {self.M1, self.M2}
        assert warnings["duplicate_parent_rows"] == []
        assert warnings["conflicting_parent_rows"] == []
        assert plan_structure["parents"] == {}

    def test_same_rows_on_distribute_work_centers_still_filtered_as_conflict(self, pg):
        """The SAME (production_order, material_number) pair, this time each
        row's machine resolves to a DIFFERENT distribute-mode work center:
        the group is now involved, and the two different machine values make
        it a conflict -- the WHOLE parent is skipped (no row emitted for
        either side) and recorded in conflicting_parent_rows."""
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s,%s,'distribute'),(%s,%s,'distribute')",
                (self.PLANT, self.WC1, self.PLANT, self.WC2),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.WC1_MEMBER, self.WC1, 100,
                 self.SUB, self.PLANT, self.WC2_MEMBER, self.WC2, 100),
            )
            conn.commit()

        batch_id = str(uuid.uuid4())
        rows = [self._row(self.WC1), self._row(self.WC2)]
        rows_out, plan_structure, warnings = distribution_data.plan(rows, batch_id)

        assert rows_out == [], "a conflicting group emits no row for either side"
        assert plan_structure["parents"] == {}
        assert warnings["duplicate_parent_rows"] == []
        assert len(warnings["conflicting_parent_rows"]) == 1
        entry = warnings["conflicting_parent_rows"][0]
        assert entry["production_order"] == self.ORD
        assert entry["material_number"] == self.MAT
        assert entry["values"] == sorted([self.WC1, self.WC2])


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
                "basic_start_date, basic_finish_date, scheduled_start, scheduled_end, notes, run_time,"
                " manual_firmed) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,TRUE)",
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
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT manual_firmed FROM orders WHERE parent_production_order = %s", (self.ORD,))
            assert [r[0] for r in cur.fetchall()] == [True, True], "the slot is carried, so the firm follows it"

        # The old plain id must be gone.
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM orders WHERE id = %s", (self.plain_id,))
            assert cur.fetchone() is None


@pytest.mark.pg
class TestAnchorCarryThroughRoutingIngestNeverBreaksPlanningCheck:
    """D01 (Review Focus 1): the SAME 1->N anchor carry as
    TestPlanApplyAnchorCarry above, but through the REAL `db.upsert_orders`
    wiring (plan_fn/apply_fn/resolve_fn) on a `routing_runtime_enabled`
    plant. Before the fix, `_carry_anchor_onto_new_child`'s scheduled-anchor
    UPDATE set scheduled_start on a brand-new child while leaving
    planning_status/planning_reason at whatever the routing "hold new
    orders" step upstream had already set (`needs_planning` + a non-NULL
    reason) -- violating `orders_planning_state_check` (schema.sql) and
    failing the whole upload. The fix folds planning_status='scheduled',
    planning_reason=NULL into that same UPDATE.

    A production_version/routing_operation pair is seeded (via the
    material's `default_production_version`) so the resolver's `scheduled`
    outcome is genuinely exercised end-to-end, not just the `needs_planning`
    (pv_missing) hold fallback."""
    SUB, PLANT = "ZZTEST_D01_SUB", "ZZT_D01_PL"
    WC = "ZZTEST_D01_WC"
    L1, L2 = "ZZTEST_D01_L1", "ZZTEST_D01_L2"
    ORD, MAT = "ZZTEST_D01_ORD", "ZZTEST_D01_MAT"
    PV, ROUTING_GROUP = "0001", "ZZD01GRP"
    CUTOVER_SEED_ORD = "ZZTEST_D01_CUTOVER_SEED"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        self.plain_id = db_.make_id(self.ORD, self.MAT)
        self.anchor_start = dt.datetime(2026, 10, 5, 6, 0)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'D01 routing audit test')",
                        (self.SUB,))
            cur.execute(
                "INSERT INTO plants (subnetwork, plant, routing_runtime_enabled) VALUES (%s, %s, TRUE)",
                (self.SUB, self.PLANT),
            )
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
            # Give every child a resolvable production_version via the
            # material's default (ROUTING_RUNTIME_DESIGN.md's own
            # production_version precedence: order's own edit, or the
            # Material Plant default) -- children never carry their own
            # production_version from distribution, so without this the
            # resolver would always hold on pv_missing.
            cur.execute(
                "UPDATE material_plants SET default_production_version = %s "
                "WHERE plant = %s AND material_id = %s",
                (self.PV, self.PLANT, self.MAT),
            )
            cur.execute(
                "INSERT INTO production_version (plant, material_id, production_version, "
                "task_list_type, routing_group, group_counter, valid_from, valid_to, sap_workcenter) "
                "VALUES (%s,%s,%s,'N',%s,'01','2026-01-01','2027-12-31',%s)",
                (self.PLANT, self.MAT, self.PV, self.ROUTING_GROUP, self.WC),
            )
            # One operation at WC, category 0001 (machine), base_quantity 10,
            # 3 std machine hours -- both L1 and L2 map to WC (seeded above).
            cur.execute(
                "INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, "
                "group_counter, sequence_no, activity, sap_workcenter, workcenter_category, "
                "base_quantity, std_value_machine, std_value_unit_machine) "
                "VALUES (%s,%s,'N',%s,'01','000000','0010',%s,'0001',10,3,'H')",
                (self.PLANT, self.MAT, self.ROUTING_GROUP, self.WC),
            )
            # The plain order arrived BEFORE the work center was configured --
            # it is already scheduled by a planner (scheduled_start set,
            # planning_status defaults to 'scheduled').
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
        cur.execute("DELETE FROM orders WHERE plant = %s AND (parent_production_order = %s "
                    "OR production_order IN (%s, %s))",
                    (self.PLANT, self.ORD, self.ORD, self.CUTOVER_SEED_ORD))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                    (self.PLANT, self.ORD))
        cur.execute("DELETE FROM routing_operation WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM production_version WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                    (self.PLANT, self.L1, self.L2))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                    (self.PLANT, self.WC))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))
        cur.execute("DELETE FROM plants WHERE plant = %s AND subnetwork = %s", (self.PLANT, self.SUB))
        cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))

    def _row(self):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 0, 0),
            "basic_finish_date": dt.datetime(2026, 10, 2, 0, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def _children_state(self, db_, cols):
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT {cols} FROM orders WHERE plant = %s AND parent_production_order = %s",
                (self.PLANT, self.ORD),
            )
            return cur.fetchall()

    def test_upload_then_resolve_pins_scheduled_anchor_then_resolved_runtime(self, pg):
        db_ = pg
        batch_id = str(uuid.uuid4())

        # Step 1 -- db.upsert_orders WITHOUT resolve_fn: pins the state
        # right after apply() (the anchor carried, planning_status fixed to
        # 'scheduled') before any routing resolve has run. Must not raise --
        # the pre-fix code violated orders_planning_state_check inside
        # _carry_anchor_onto_new_child's UPDATE and failed the whole upload
        # right here.
        result = db_.upsert_orders(
            [self._row()], batch_id=batch_id, source="excel", filename="d01-anchor-routing-test.xlsx",
            plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
        )
        assert result["status"] == "ok"

        # The old plain row is superseded/deleted.
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM orders WHERE id = %s", (self.plain_id,))
            assert cur.fetchone() is None

        children = _snapshot_children(db_, self.PLANT, self.ORD)
        assert len(children) == 2
        for child in children:
            assert child["scheduled_start"] == self.anchor_start
            assert child["notes"] == "Planner note"

        post_apply_rows = self._children_state(db_, "planning_status, planning_reason, run_time")
        assert len(post_apply_rows) == 2
        for planning_status, planning_reason, run_time in post_apply_rows:
            assert planning_status == "scheduled"
            assert planning_reason is None
            # routing-enabled plant: upsert_orders blanked run_time on these
            # same child-row dicts before insert; the resolver hasn't run yet.
            assert run_time is None

        # Step 2 -- run the resolver explicitly (the resolve_fn seam, called
        # separately here so step 1's intermediate state above is pinned on
        # its own). production_version/routing_operation were seeded, so
        # this resolves successfully rather than holding on pv_missing.
        report = routing_resolver.resolve_orders(self.PLANT)
        assert report["resolved"] == 2

        final_rows = self._children_state(
            db_, "planning_status, planning_reason, scheduled_start, scheduled_end, run_time, run_time_source")
        assert len(final_rows) == 2
        for planning_status, planning_reason, scheduled_start, _scheduled_end, run_time, run_time_source in final_rows:
            assert planning_status == "scheduled"
            assert planning_reason is None
            assert scheduled_start == self.anchor_start  # untouched by the resolve
            assert run_time is not None
            assert run_time_source == "routing"

    def test_same_scenario_on_an_already_cutover_plant_still_resolves_and_loads(self, pg):
        """Review finding 2 (disputed): once the plant already has >= 1
        routing-sourced order (`is_cutover = False` in `resolve_orders`),
        does the carried child still get loaded and resolved? The reviewer
        claimed a carried child ends up `scheduled` with a non-NULL
        SAP-apportioned run_time and NULL run_time_source, which
        `_load_orders`'s cutover-ONLY clause would then skip. Planning
        traced that `upsert_orders` blanks `row['run_time']` on the SAME
        child-row dicts (db.py ~2595-2597) regardless of cutover state, so
        `_load_orders`'s unconditional `run_time IS NULL` clause (not just
        the cutover-only one) picks the child up either way. Settled here
        empirically rather than by re-reading the code: the reviewer's claim
        does NOT hold -- the carried child is loaded and resolved exactly
        like the non-cutover case in the test above."""
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "run_time, run_time_source) VALUES (%s,%s,%s,%s,%s,%s,'routing')",
                (db_.make_id(self.CUTOVER_SEED_ORD, self.MAT), self.CUTOVER_SEED_ORD, self.MAT,
                 self.L1, self.PLANT, 1.0),
            )
            conn.commit()
            cur.execute(
                "SELECT EXISTS(SELECT 1 FROM orders WHERE plant = %s AND run_time_source = 'routing')",
                (self.PLANT,),
            )
            assert cur.fetchone()[0] is True, "seed must actually flip is_cutover to False"

        batch_id = str(uuid.uuid4())
        result = db_.upsert_orders(
            [self._row()], batch_id=batch_id, source="excel", filename="d01-cutover-test.xlsx",
            plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
            resolve_fn=routing_resolver.resolve_orders,
        )
        assert result["status"] == "ok"

        children = _snapshot_children(db_, self.PLANT, self.ORD)
        assert len(children) == 2

        rows = self._children_state(db_, "planning_status, planning_reason, run_time, run_time_source")
        assert len(rows) == 2
        for planning_status, planning_reason, run_time, run_time_source in rows:
            # Loaded and resolved -- NOT skipped -- on an already-cut-over plant.
            assert planning_status == "scheduled"
            assert planning_reason is None
            assert run_time is not None
            assert run_time_source == "routing"


@pytest.mark.pg
class TestPlanZeroWeightWorkcenterStaysPlain:
    """D03: a brand-new distribute-mode parent whose work center members are
    ALL weighted 0 (no material-default/tooled override) has no actual
    distribution policy -- it must stay a plain order (no header/children
    created) and surface a `workcenter_without_members` warning tagged
    `reason: zero_weights`, same failure mode as a memberless work center."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_ZEROWEIGHT"
    L1, L2 = "ZZTEST_L1_ZEROWEIGHT", "ZZTEST_L2_ZEROWEIGHT"
    ORD, MAT = "ZZTEST_ORD_ZEROWEIGHT", "ZZT_MAT_ZEROWT"

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
                (self.SUB, self.PLANT, self.L1, self.WC, 0,
                 self.SUB, self.PLANT, self.L2, self.WC, 0),
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

    def test_zero_weights_warning_present_and_row_stays_plain(self, pg):
        batch_id = str(uuid.uuid4())
        rows_out, plan_structure, warnings = distribution_data.plan([self._row()], batch_id)

        header_key = (self.PLANT, self.ORD, self.MAT)
        assert header_key not in plan_structure["parents"]

        zero_weight_entries = [
            w for w in warnings["workcenter_without_members"]
            if w.get("production_order") == self.ORD and w.get("reason") == "zero_weights"
        ]
        assert len(zero_weight_entries) == 1
        assert zero_weight_entries[0]["sap_workcenter"] == self.WC

        assert len(rows_out) == 1
        assert rows_out[0]["plant"] == self.PLANT
        assert rows_out[0]["machine"] == self.WC

    def test_zero_weight_order_survives_the_upload_as_plain(self, pg):
        db_ = pg
        batch_id = str(uuid.uuid4())
        result = db_.upsert_orders(
            [self._row()], batch_id=batch_id, source="excel", filename="zero-weight-test.xlsx",
            plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
        )

        # D04: no parent was planned (apply_fn never runs), but the
        # workcenter_without_members/zero_weights warning raised by plan()
        # must still surface in the upload's audit/warnings list instead of
        # being silently dropped.
        distribution_entries = [w for w in result["warnings"] if w.get("category") == "distribution"]
        assert len(distribution_entries) == 1
        assert distribution_entries[0]["workcenter_without_members"], \
            "the zero_weights entry must ride along on the distribution warnings entry"
        assert distribution_entries[0]["msg"] == "No aggregate orders distributed this batch", \
            "must not read as '0 aggregate order(s) distributed' when nothing was ever planned"

        plain_id = db_.make_id(self.ORD, self.MAT)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT machine, parent_production_order FROM orders WHERE id = %s", (plain_id,),
            )
            row = cur.fetchone()
        assert row is not None, "the order must survive the upload as a plain row"
        assert row[0] == self.WC
        assert row[1] is None, "must never be converted into a distribution child"

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM order_distribution WHERE plant = %s AND production_order = %s "
                "AND material_number = %s",
                (self.PLANT, self.ORD, self.MAT),
            )
            assert cur.fetchone() is None, "no distribution header must be created"

    def test_pre_existing_scheduled_plain_order_survives_with_schedule_intact(self, pg):
        """D03 review finding 4b: the actual harm D03 prevents is a planner's
        already-SCHEDULED plain order (for a work center that's since gone
        zero-weight) getting swept into a brand-new distribution header on
        the next re-ingest -- which would delete this exact row (superseded
        child cleanup) and discard its schedule/notes. Pin that it instead
        survives, untouched, as the SAME plain row."""
        db_ = pg
        plain_id = db_.make_id(self.ORD, self.MAT)
        sched_start = dt.datetime(2026, 10, 3, 9, 0)
        sched_end = dt.datetime(2026, 10, 3, 17, 0)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, scheduled_start, scheduled_end, notes, run_time) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (plain_id, self.ORD, self.MAT, self.WC, self.PLANT,
                 dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 18, 0),
                 sched_start, sched_end, "Planner note", 10.0),
            )
            conn.commit()

        batch_id = str(uuid.uuid4())
        result = db_.upsert_orders(
            [self._row()], batch_id=batch_id, source="excel", filename="zero-weight-refresh-test.xlsx",
            plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
        )
        assert result["status"] == "ok"

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT machine, parent_production_order, scheduled_start, scheduled_end, notes "
                "FROM orders WHERE id = %s",
                (plain_id,),
            )
            row = cur.fetchone()
        assert row is not None, "the already-scheduled plain order must survive the re-ingest"
        assert row[0] == self.WC
        assert row[1] is None, "must never be converted into a distribution child"
        assert row[2] == sched_start, "the planner's schedule must survive untouched"
        assert row[3] == sched_end
        assert row[4] == "Planner note"


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
class TestApplyPolicyReviewedInsertStampsReviewedQuantity:
    """D16: a policy-reviewed insert (sap_workcenter.review_required = FALSE)
    must stamp reviewed_at/reviewed_quantity at INSERT time, the same as a
    manual review does -- otherwise reviewed_quantity stays NULL forever and
    qty_changed can never fire for a header nobody ever manually reviewed."""
    SUB, PLANT = "WTG", "1006"
    WC = "ZZTEST_WC_POLICY_REVIEWED"
    L1, L2 = "ZZTEST_L1_POLICY_REVIEWED", "ZZTEST_L2_POLICY_REVIEWED"
    ORD, MAT = "ZZTEST_ORD_POLICY_REVIEWED", "ZZT_MAT_POLREV"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode, review_required) "
                "VALUES (%s, %s, 'distribute', FALSE)", (self.PLANT, self.WC),
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

    def _row(self, qty):
        return {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": qty, "run_time": 10.0,
        }

    def test_policy_reviewed_insert_stamps_reviewed_quantity_and_qty_changed_fires_on_refresh(self, pg):
        db_ = pg
        batch_1 = str(uuid.uuid4())
        rows_1, plan_1, _ = distribution_data.plan([self._row(100.0)], batch_1)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_1, batch_1, conn)

        after_insert = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        assert after_insert["reviewed"] is True
        assert after_insert["reviewed_quantity"] == 100
        assert after_insert["reviewed_at"] is not None

        # Second ingest with a CHANGED quantity -- a plain refresh (§5.2
        # "Existing") updates order_quantity but must never touch
        # reviewed_quantity.
        batch_2 = str(uuid.uuid4())
        rows_2, plan_2, _ = distribution_data.plan([self._row(200.0)], batch_2)
        with db_._pool.connection() as conn:
            distribution_data.apply(plan_2, batch_2, conn)

        after_refresh = _snapshot_header(db_, self.PLANT, self.ORD, self.MAT)
        assert after_refresh["order_quantity"] == 200
        assert after_refresh["reviewed_quantity"] == 100  # untouched by refresh

        statuses = compute_derived_statuses(
            {"reviewed": after_refresh["reviewed"], "order_quantity": after_refresh["order_quantity"],
             "reviewed_quantity": after_refresh["reviewed_quantity"]},
            [], [], None, {},
        )
        assert "qty_changed" in statuses


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
        assert set(body.keys()) == {"needs_review", "changed", "problems", "truncated"}
        assert body["truncated"] is False

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


class TestLockOneHeaderForUpdateFlag:
    """D56 unit test (no DB): `_lock_one_header`'s new `for_update` flag must
    control whether the generated SQL carries a `FOR UPDATE` clause at all --
    a fake cursor is enough to check the executed SQL text."""

    class _FakeCursor:
        def __init__(self, row=None):
            self.queries = []
            self._row = row

        def execute(self, sql, params=None):
            self.queries.append(sql)

        def fetchone(self):
            return self._row

    def test_for_update_true_default_includes_for_update_clause(self):
        cur = self._FakeCursor(row=None)
        distribution_data._lock_one_header(cur, "1006", "ORD", "MAT")
        assert len(cur.queries) == 1
        assert "FOR UPDATE" in cur.queries[0]

    def test_for_update_false_omits_for_update_clause(self):
        cur = self._FakeCursor(row=None)
        distribution_data._lock_one_header(cur, "1006", "ORD", "MAT", for_update=False)
        assert len(cur.queries) == 1
        assert "FOR UPDATE" not in cur.queries[0]


class TestFetchHeaderRowsOrderByAndSearch:
    """D42 + D59 unit tests (no DB): `_fetch_header_rows` must append a
    stable `production_order ASC, material_number ASC` tiebreaker after its
    stated default sort (paging is OFFSET/LIMIT in SQL since #24, so a stable
    ORDER BY is all that's required), and its `search` predicate must
    escape the user's own ILIKE wildcard characters via `db._like_contains`
    + `ESCAPE '\\'` (D59) rather than embedding the raw term."""

    class _FakeCursor:
        def __init__(self):
            self.queries = []

        def execute(self, sql, params=None):
            self.queries.append((sql, params))

        def fetchall(self):
            return []

    def test_order_by_ends_with_production_order_then_material_number(self):
        cur = self._FakeCursor()
        distribution_data._fetch_header_rows(cur, "1006")
        assert len(cur.queries) == 1
        sql_text = cur.queries[0][0]
        assert ("ORDER BY basic_start_date ASC NULLS LAST, reviewed ASC, "
                "production_order ASC, material_number ASC") in sql_text

    def test_search_predicate_uses_escaped_ilike(self):
        cur = self._FakeCursor()
        distribution_data._fetch_header_rows(cur, "1006", search="a_b")
        sql_text, params = cur.queries[0]
        assert "ILIKE %s ESCAPE '\\'" in sql_text
        assert params[1:3] == ["%a\\_b%", "%a\\_b%"]


@pytest.mark.pg
class TestSqlStatusClassificationParityAndScale:
    """#24 (D13/D14): the review queue classifies in SQL with no candidate cap.
    `service.compute_derived_statuses` stays the oracle: for a fixture covering
    every derived status, each SQL flag must equal the Python result for every
    header; and >5,000 headers must all be counted by the summary."""
    PLANT = "1006"
    SUB = "WTG"
    WC_D, WC_S = "ZZTEST_WC_PAR_D", "ZZTEST_WC_PAR_S"
    M1, M2, MX = "ZZTEST_PAR_M1", "ZZTEST_PAR_M2", "ZZTEST_PAR_MX"
    MAT, MAT_LOT = "ZZTEST_PAR_MAT", "ZZTEST_PAR_MLOT"
    PFX = "ZZTEST_PAR_"
    BULK = "ZZTEST_BULK_"

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE plant = %s AND (production_order LIKE %s OR parent_production_order LIKE %s)",
                    (self.PLANT, "ZZTEST_PAR_%", "ZZTEST_PAR_%"))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND (production_order LIKE %s OR production_order LIKE %s)",
                    (self.PLANT, "ZZTEST_PAR_%", "ZZTEST_BULK_%"))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine = ANY(%s)", (self.PLANT, [self.M1, self.M2, self.MX]))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = ANY(%s)",
                    (self.PLANT, [self.WC_D, self.WC_S]))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = ANY(%s)",
                    (self.PLANT, [self.MAT, self.MAT_LOT]))
        cur.execute("DELETE FROM materials WHERE material_id = ANY(%s)", ([self.MAT, self.MAT_LOT],))

    def _header(self, cur, name, wc=None, *, reviewed=False, qty=100, rq=None, facts=None, mat=None):
        cur.execute(
            "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter, order_quantity,"
            " run_time, basic_start_date, reviewed, reviewed_quantity, sap_facts)"
            " VALUES (%s,%s,%s,%s,%s,1,%s,%s,%s,%s::jsonb)",
            (self.PLANT, self.PFX + name, mat or self.MAT, wc or self.WC_D, qty,
             dt.datetime(2026, 10, 1, 8, 0), reviewed, rq, None if facts is None else json.dumps(facts)),
        )

    def _share(self, cur, name, machine, letter, weight=1, purged=False, mat=None):
        cur.execute(
            "INSERT INTO order_distribution_share (plant, production_order, material_number, machine, letter, weight, purged_at)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (self.PLANT, self.PFX + name, mat or self.MAT, machine, letter, weight,
             dt.datetime(2026, 10, 2) if purged else None),
        )

    def _child(self, cur, name, machine, qty=10, mismatch=False, mat=None, scheduled=False):
        cid = self.PFX + name + "-C" + str(machine)
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, machine, plant, parent_production_order,"
            " order_quantity, runtime_schedule_mismatch, scheduled_start) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (cid, cid, mat or self.MAT, machine, self.PLANT, self.PFX + name, qty, mismatch,
             dt.datetime(2026, 10, 3) if scheduled else None),
        )

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        self.db = db_
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode)"
                        " VALUES (%s,%s,'distribute'),(%s,%s,'single')",
                        (self.PLANT, self.WC_D, self.PLANT, self.WC_S))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES (%s,%s,%s,%s),(%s,%s,%s,%s)",
                        (self.SUB, self.PLANT, self.M1, self.WC_D, self.SUB, self.PLANT, self.M2, self.WC_D))
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            _seed_distribution_material(cur, self.MAT_LOT, self.PLANT)
            cur.execute("UPDATE material_plants SET min_lot_size = 50 WHERE plant = %s AND material_id = %s",
                        (self.PLANT, self.MAT_LOT))

            self._header(cur, "plain_reviewed", reviewed=True, rq=100)
            self._header(cur, "needs_review")
            self._header(cur, "qty_changed", reviewed=True, rq=80)
            self._header(cur, "qty_null_order", reviewed=True, qty=None, rq=5)
            self._header(cur, "qty_null_rq", reviewed=True, rq=None)
            # incomplete: live share, no child
            self._header(cur, "inc_no_child", reviewed=True, rq=100)
            self._share(cur, "inc_no_child", self.M1, "A")
            # incomplete: child, no share
            self._header(cur, "inc_orphan_child", reviewed=True, rq=100)
            self._child(cur, "inc_orphan_child", self.M1)
            # complete pair on both members
            self._header(cur, "complete", reviewed=True, rq=100)
            for m, letter in ((self.M1, "A"), (self.M2, "B")):
                self._share(cur, "complete", m, letter)
                self._child(cur, "complete", m, scheduled=True)
            # zero-weight and purged shares without a child are NOT incomplete
            self._header(cur, "zero_purged_nochild", reviewed=True, rq=100)
            self._share(cur, "zero_purged_nochild", self.M1, "A", weight=0)
            self._share(cur, "zero_purged_nochild", self.M2, "B", weight=1, purged=True)
            # child with a NULL machine
            self._header(cur, "null_machine_child", reviewed=True, rq=100)
            self._child(cur, "null_machine_child", None)
            # mode mismatch (work center now single)
            self._header(cur, "mode", wc=self.WC_S, reviewed=True, rq=100)
            # wc_changed truthy / falsey
            self._header(cur, "wc_prev", reviewed=True, rq=100, facts={"previous_workcenter": "OLD"})
            self._header(cur, "wc_prev_empty", reviewed=True, rq=100, facts={"previous_workcenter": ""})
            self._header(cur, "wc_prev_null", reviewed=True, rq=100, facts={"previous_workcenter": None})
            # membership: member M2 has no share; positive share on a non-member
            self._header(cur, "member_missing_share", reviewed=True, rq=100)
            self._share(cur, "member_missing_share", self.M1, "A")
            self._child(cur, "member_missing_share", self.M1)
            self._header(cur, "share_not_member", reviewed=True, rq=100)
            self._share(cur, "share_not_member", self.MX, "A")
            self._share(cur, "share_not_member", self.M1, "B", weight=0)
            self._share(cur, "share_not_member", self.M2, "C", weight=0)
            self._child(cur, "share_not_member", self.MX)
            # below min lot / zero qty / runtime mismatch / purged
            self._header(cur, "lot", reviewed=True, rq=100, mat=self.MAT_LOT)
            self._share(cur, "lot", self.M1, "A", mat=self.MAT_LOT)
            self._share(cur, "lot", self.M2, "B", mat=self.MAT_LOT)
            self._child(cur, "lot", self.M1, qty=10, mat=self.MAT_LOT)
            self._child(cur, "lot", self.M2, qty=60, mat=self.MAT_LOT)
            self._header(cur, "zero_qty", reviewed=True, rq=100)
            self._share(cur, "zero_qty", self.M1, "A")
            self._share(cur, "zero_qty", self.M2, "B")
            self._child(cur, "zero_qty", self.M1, qty=0)
            self._child(cur, "zero_qty", self.M2, qty=5)
            self._header(cur, "mismatch", reviewed=True, rq=100)
            self._share(cur, "mismatch", self.M1, "A")
            self._share(cur, "mismatch", self.M2, "B")
            self._child(cur, "mismatch", self.M1, mismatch=True)
            self._child(cur, "mismatch", self.M2)
            self._header(cur, "purged", reviewed=True, rq=100)
            self._share(cur, "purged", self.M1, "A")
            self._share(cur, "purged", self.M2, "B", purged=True)
            self._child(cur, "purged", self.M1)
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _python_statuses(self):
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            headers = distribution_data._fetch_header_rows(cur, self.PLANT, search=self.PFX)
            distribution_data._hydrate_headers(cur, self.PLANT, headers)
            return {h["production_order"]: set(h["statuses"]) for h in headers}

    def test_sql_flags_equal_python_classifier_for_every_status(self):
        py = self._python_statuses()
        assert len(py) >= 20
        covered = set().union(*py.values())
        every = set(distribution_data._STATUS_SQL)
        assert covered == every, f"fixture must exercise every status; missing {every - covered}"
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            for code in distribution_data._STATUS_SQL:
                cur.execute(
                    "SELECT order_distribution.production_order"
                    f" FROM {distribution_data._STATUS_FROM}"
                    " WHERE order_distribution.plant = %s AND order_distribution.production_order LIKE %s"
                    f" AND ({distribution_data._STATUS_SQL[code]})",
                    (self.PLANT,) * distribution_data._STATUS_FROM_NPLANT + (self.PLANT, self.PFX + "%"),
                )
                sql_set = {r[0] for r in cur.fetchall()}
                py_set = {po for po, st in py.items() if code in st}
                assert sql_set == py_set, (code, sql_set ^ py_set)

    def test_list_and_summary_match_python_buckets(self):
        py = self._python_statuses()
        for bucket in ("needs_review", "changed", "problems", "purged", "incomplete",
                       "separation_violated", "bogus", "all"):
            out = distribution_data.list_headers_for_plant(self.PLANT, search=self.PFX, bucket=bucket, limit=1000)
            want = {po for po, st in py.items() if status_matches_filter(st, bucket)}
            got = {r["header"]["production_order"] for r in out["data"]}
            assert got == want, bucket
            assert out["meta"]["total"] == len(want) and out["meta"]["truncated"] is False
            for r in out["data"]:  # wire statuses still come from the Python oracle
                assert set(r["statuses"]) == py[r["header"]["production_order"]]
        summ = distribution_data.get_summary(self.PLANT)
        for name in ("needs_review", "changed", "problems"):
            assert summ[name] >= sum(1 for st in py.values() if name in classify_bucket_membership(st))
        assert summ["truncated"] is False

    def test_scheduled_children_and_paging(self):
        out = distribution_data.list_headers_for_plant(self.PLANT, search=self.PFX, limit=3, offset=2)
        assert len(out["data"]) == 3
        assert out["meta"]["scheduled_children"] == 2
        full = distribution_data.list_headers_for_plant(self.PLANT, search=self.PFX, limit=1000)
        assert ([r["header"]["production_order"] for r in full["data"]][2:5]
                == [r["header"]["production_order"] for r in out["data"]])

    def test_summary_counts_past_5000_headers(self):
        before = distribution_data.get_summary(self.PLANT)
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter,"
                " order_quantity, run_time, basic_start_date)"
                " SELECT %s, %s || g, %s, %s, 10, 1, now() FROM generate_series(1, 5100) g",
                (self.PLANT, self.BULK, self.MAT, self.WC_D),
            )
            conn.commit()
        after = distribution_data.get_summary(self.PLANT)
        assert after["needs_review"] - before["needs_review"] == 5100
        assert after["truncated"] is False
        out = distribution_data.list_headers_for_plant(self.PLANT, bucket="needs_review", limit=50, offset=5000)
        assert out["meta"]["total"] >= 5100 and len(out["data"]) == 50
        assert out["meta"]["truncated"] is False


@pytest.mark.pg
class TestSqlStatusRandomizedParityAndPagingStability:
    """Seeded randomized parity between `_STATUS_SQL`/`_STATUS_FROM` and the
    Python oracle `service.compute_derived_statuses`, plus tie-stable paging.
    Every fixture row lives in plant 1006 under a ZZTEST_FZ_ prefix and is
    removed on teardown."""
    PLANT = "1006"
    SUB = "WTG"
    PFX = "ZZTEST_FZ_"
    WCS = ["ZZTEST_WC_FZ0", "ZZTEST_WC_FZ1", "ZZTEST_WC_FZ2"]
    MACHS = [f"ZZTEST_FZ_M{i}" for i in range(1, 7)]
    MATS = ["ZZTEST_FZ_MAT1", "ZZTEST_FZ_MAT2", "ZZTEST_FZ_MAT3"]
    SEEDS = (11, 2026, 90210)
    N_PER_SEED = 260
    FACTS = [None, {}, {"x": 1}, {"previous_workcenter": None}, {"previous_workcenter": ""},
             {"previous_workcenter": "OLD"}, {"previous_workcenter": 0}, {"previous_workcenter": 0.0},
             {"previous_workcenter": False}, {"previous_workcenter": []}, {"previous_workcenter": {}},
             {"previous_workcenter": [0]}, {"previous_workcenter": {"a": 1}},
             {"previous_workcenter": "0"}, {"previous_workcenter": 1}, {"previous_workcenter": True}]
    STARTS = [dt.datetime(2026, 10, 1, 8), dt.datetime(2026, 10, 1, 8), dt.datetime(2026, 10, 2), None]

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE plant = %s AND (id LIKE %s OR parent_production_order LIKE %s)",
                    (self.PLANT, self.PFX + "%", self.PFX + "%"))
        cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order LIKE %s",
                    (self.PLANT, self.PFX + "%"))
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine = ANY(%s)", (self.PLANT, self.MACHS))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = ANY(%s)",
                    (self.PLANT, self.WCS))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = ANY(%s)",
                    (self.PLANT, self.MATS))
        cur.execute("DELETE FROM materials WHERE material_id = ANY(%s)", (self.MATS,))

    @pytest.fixture(autouse=True)
    def _env(self, pg):
        self.db = pg
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _seed(self, seed, n_headers=None):
        """Insert one random fixture set in a single transaction (replacing the
        previous seed's rows); return the number of headers."""
        rnd = random.Random(seed)
        n_headers = n_headers or self.N_PER_SEED
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            members = {}
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES "
                        + ",".join(["(%s,%s,%s)"] * len(self.WCS)),
                        [x for w in self.WCS for x in (self.PLANT, w, rnd.choice(["single", "distribute"]))])
            mach_rows = []
            for m in self.MACHS:
                wc = rnd.choice(self.WCS + [None])
                members.setdefault(wc, []).append(m)
                mach_rows.append((self.SUB, self.PLANT, m, wc))
            cur.executemany("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES (%s,%s,%s,%s)",
                            mach_rows)
            for mat in self.MATS:
                _seed_distribution_material(cur, mat, self.PLANT)
                cur.execute("UPDATE material_plants SET min_lot_size = %s WHERE plant = %s AND material_id = %s",
                            (rnd.choice([0, 0, 20, 50]), self.PLANT, mat))
            hdrs, shares, kids = [], [], []
            n_kid = 0
            for i in range(n_headers):
                po =f"{self.PFX}{seed % 1000:03d}_{i:04d}"
                mat = rnd.choice(self.MATS)
                wc = rnd.choice(self.WCS)
                qty = rnd.choice([None, 0, 100, 100, 250])
                reviewed = rnd.random() < 0.6
                rq = rnd.choice([None, qty, qty, 77])
                facts = rnd.choice(self.FACTS)
                hdrs.append((self.PLANT, po, mat, wc, qty,
                             rnd.choice(self.STARTS), reviewed, rq,
                             None if facts is None else json.dumps(facts)))
                coherent = rnd.random() < 0.6
                ms = list(members.get(wc, [])) if coherent else rnd.sample(self.MACHS, rnd.randrange(0, 4))
                fault = rnd.choice(["none", "none", "drop_child", "extra_child", "purge", "zero", "nonmember",
                                    "dropshare", "qty0", "lot", "mm", "nullm"]) if coherent else None
                ms_sh = ms[1:] if fault == "dropshare" else list(ms)
                nm_purge = False
                if fault == "nonmember":
                    extra = [m for m in self.MACHS if m not in ms]
                    if extra:
                        ms_sh.append(extra[0])
                        nm_purge = rnd.random() < 0.5
                for k, m in enumerate(ms_sh):
                    if coherent:
                        w = 0 if (fault == "zero" and k == 0) else rnd.choice([1, 2.5])
                    else:
                        w = rnd.choice([0, 1, 1, 2.5])
                    purged = ((not coherent and rnd.random() < 0.2) or (fault == "purge" and k == 0)
                              or (fault == "nonmember" and nm_purge and k == len(ms_sh) - 1 and m not in ms))
                    shares.append((self.PLANT, po, mat, m, "ABCDEF"[k], w,
                                   dt.datetime(2026, 1, 1) if purged else None))
                if coherent:
                    km = list(ms_sh)
                    if fault == "drop_child" and km:
                        km = km[1:]
                    if fault == "extra_child":
                        km.append(rnd.choice(self.MACHS))
                    if fault == "nullm":
                        km.append(None)
                else:
                    km = [m for m in ms if rnd.random() < 0.7]
                    if rnd.random() < 0.3:
                        km.append(rnd.choice(self.MACHS + [None]))
                for m in km:
                    n_kid += 1
                    cid = f"{self.PFX}C{n_kid:06d}"
                    if coherent:
                        cq = 0 if fault == "qty0" and rnd.random() < .5 else (1 if fault == "lot" and rnd.random() < .5 else 60)
                        mm = fault == "mm" and rnd.random() < .5
                    else:
                        cq, mm = rnd.choice([None, 0, 5, 10, 60, 100]), rnd.random() < 0.1
                    kids.append((cid, cid, mat, m, self.PLANT, po, cq, mm,
                                 dt.datetime(2026, 10, 3) if rnd.random() < 0.4 else None))
            cur.executemany(
                "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter,"
                " order_quantity, run_time, basic_start_date, reviewed, reviewed_quantity, sap_facts)"
                " VALUES (%s,%s,%s,%s,%s,1,%s,%s,%s,%s::jsonb)", hdrs)
            cur.executemany(
                "INSERT INTO order_distribution_share (plant, production_order, material_number, machine,"
                " letter, weight, purged_at) VALUES (%s,%s,%s,%s,%s,%s,%s)", shares)
            cur.executemany(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " parent_production_order, order_quantity, runtime_schedule_mismatch, scheduled_start)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", kids)
            conn.commit()
        return len(hdrs)

    def test_sql_statuses_equal_python_for_random_fixtures(self):
        total = 0
        seen = set()
        for seed in self.SEEDS:
            n = self._seed(seed)
            with self.db._pool.connection() as conn, conn.cursor() as cur:
                headers = distribution_data._fetch_header_rows(cur, self.PLANT, search=self.PFX)
                distribution_data._hydrate_headers(cur, self.PLANT, headers)
                py = {(h["production_order"], h["material_number"]): set(h["statuses"]) for h in headers}
                assert len(py) == n
                sql = {k: set() for k in py}
                for code, expr in distribution_data._STATUS_SQL.items():
                    cur.execute(
                        "SELECT order_distribution.production_order, order_distribution.material_number"
                        f" FROM {distribution_data._STATUS_FROM}"
                        " WHERE order_distribution.plant = %s AND order_distribution.production_order LIKE %s"
                        f" AND ({expr})",
                        (self.PLANT,) * distribution_data._STATUS_FROM_NPLANT + (self.PLANT, self.PFX + "%"),
                    )
                    for po, mat in cur.fetchall():
                        sql[(po, mat)].add(code)
            bad = {k: (sorted(sql[k]), sorted(py[k])) for k in py if sql[k] != py[k]}
            assert not bad, f"seed {seed}: SQL != Python for {len(bad)} headers, e.g. {dict(list(bad.items())[:3])}"
            for st in py.values():
                seen |= st
            total += n
        assert total == len(self.SEEDS) * self.N_PER_SEED
        assert seen == set(distribution_data._STATUS_SQL), \
            f"random fixtures must exercise every status; missing {set(distribution_data._STATUS_SQL) - seen}"

    def test_paging_with_ties_is_stable_and_complete(self):
        self._seed(self.SEEDS[0], n_headers=45)   # small: every page call hydrates + counts
        for bucket in ("all", "incomplete"):
            full = distribution_data.list_headers_for_plant(self.PLANT, search=self.PFX, bucket=bucket, limit=0)
            keys = [(r["header"]["production_order"], r["header"]["material_number"]) for r in full["data"]]
            assert keys and len(keys) == len(set(keys)) == full["meta"]["total"]
            # many ties on basic_start_date / reviewed: order key must be non-decreasing
            def order_key(r):
                h = r["header"]
                s = h["basic_start_date"]
                return (s is None, s or dt.datetime.min, h["reviewed"], h["production_order"], h["material_number"])
            ok = [order_key(r) for r in full["data"]]
            assert ok == sorted(ok), bucket
            if bucket == "all":
                assert len({k[:3] for k in ok}) < len(ok), "fixture must contain date/reviewed ties"
            for ps in (4, 7, 20):
                cat, off = [], 0
                while True:
                    page = distribution_data.list_headers_for_plant(
                        self.PLANT, search=self.PFX, bucket=bucket, limit=ps, offset=off)
                    pk = [(r["header"]["production_order"], r["header"]["material_number"]) for r in page["data"]]
                    assert page["meta"]["total"] == len(keys)
                    if not pk:
                        break
                    assert len(pk) <= ps
                    cat += pk
                    off += ps
                assert len(cat) == len(set(cat)), (bucket, ps, "duplicate across pages")
                assert cat == keys, (bucket, ps)


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
class TestDryRunSkipsRowLock(_ReweightFixtureBase):
    """D56 database test: a dry run must not take `FOR UPDATE` on the header
    row at all -- it returns promptly even while a SEPARATE connection holds
    `FOR UPDATE` on that same row (the old code took the lock either way and
    only released it when the `with _pool.connection()` block exited)."""
    WC = "ZZTEST_WC_DRYNOLOCK"
    L1, L2 = "ZZTEST_L1_DRYNOLOCK", "ZZTEST_L2_DRYNOLOCK"
    ORD, MAT = "ZZTEST_ORD_DRYNOLOCK", "ZZT_MAT_DRYNOLOCK"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_dry_run_reweight_returns_while_another_connection_holds_for_update(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        holder_conn = pg._pool.getconn()
        try:
            with holder_conn.cursor() as holder_cur:
                holder_cur.execute(
                    "SELECT 1 FROM order_distribution WHERE plant=%s AND production_order=%s"
                    " AND material_number=%s FOR UPDATE",
                    (self.PLANT, self.ORD, self.MAT),
                )
                holder_cur.fetchone()

                # If reweight_shares' dry-run path still took FOR UPDATE, this
                # call would block on holder_conn's open transaction and the
                # test would hang/time out instead of returning.
                result = distribution_data.reweight_shares(
                    self.PLANT, self.ORD, self.MAT,
                    [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}],
                    base_version=header["xmin"], dry_run=True, actor="tester",
                )
                assert "plan" in result

                reset_result = distribution_data.reset_one_header(
                    self.PLANT, self.ORD, self.MAT, header["xmin"], dry_run=True,
                )
                assert "plan" in reset_result
        finally:
            holder_conn.rollback()
            pg._pool.putconn(holder_conn)


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
                "UPDATE orders SET scheduled_start = %s, scheduled_end = %s, notes = %s, manual_firmed = TRUE"
                " WHERE id = %s",
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
                "SELECT scheduled_start, scheduled_end, notes, manual_firmed FROM orders WHERE id = %s",
                (new_bare_id,),
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
        assert new_row[3] is True, "the slot is carried, so the manual firm must follow it"
        assert segment_owner is not None and segment_owner[0] == new_bare_id, \
            "the segment must be re-pointed onto the new bare id, not cascade-deleted"


@pytest.mark.pg
class TestResetOneHeaderRaisesOnZeroWeights(_ReweightFixtureBase):
    """D03: `reset_one_header` must refuse (not silently zero every share)
    when the work center's CURRENT weights are all zero -- `reapply_defaults`
    already counts a ValueError as skipped, so this surfaces as a skip, not
    a crash, for a bulk reapply."""
    WC = "ZZTEST_WC_RESETZERO"
    L1, L2 = "ZZTEST_L1_RESETZERO", "ZZTEST_L2_RESETZERO"
    ORD, MAT = "ZZTEST_ORD_RESETZERO", "ZZT_MAT_RESETZERO"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_reset_raises_weights_empty_when_all_member_weights_zero(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE machine SET distribution_weight = 0 WHERE plant = %s AND machine IN (%s, %s)",
                (self.PLANT, self.L1, self.L2),
            )
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        with pytest.raises(ValueError, match="weights_empty"):
            distribution_data.reset_one_header(self.PLANT, self.ORD, self.MAT, header["xmin"])


@pytest.mark.pg
class TestResetRouteSurfacesErrorCode(_ReweightFixtureBase):
    """Audit fix item 1: a bulk `reset_orders` per-item ValueError (B3's
    `weights_empty: ...`) must carry a structured `code` field through
    `POST /distribution/{plant}/reset`, the same `<code>: <detail>`
    partition rule `routes._distribution_error` uses for the single-item
    `/shares` 400 -- not just a raw English `message` the planner-facing
    frontend would otherwise show untranslated."""
    WC = "ZZTEST_WC_RESETCODE"
    L1, L2 = "ZZTEST_L1_RESETCODE", "ZZTEST_L2_RESETCODE"
    ORD, MAT = "ZZTEST_ORD_RESETCODE", "ZZT_MAT_RESETCODE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE machine SET distribution_weight = 0 WHERE plant = %s AND machine IN (%s, %s)",
                (self.PLANT, self.L1, self.L2),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    @pytest.fixture
    def client(self):
        brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [self.PLANT]
        brain.api.dependency_overrides[auth.require_authenticated] = lambda: "reader@example.com"
        try:
            yield TestClient(brain.api)
        finally:
            brain.api.dependency_overrides.clear()

    def test_reset_on_all_zero_workcenter_returns_item_with_weights_empty_code(self, pg, client):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        response = client.post(
            f"/distribution/{self.PLANT}/reset",
            json={"orders": [{"production_order": self.ORD, "material_number": self.MAT,
                              "base_version": header["xmin"]}]},
        )
        assert response.status_code == 200
        item = response.json()["results"][0]
        assert item["status"] == "error"
        assert item["code"] == "weights_empty"


@pytest.mark.pg
class TestReapplyDefaultsSkipsAlreadyReviewed(_ReweightFixtureBase):
    """D19: the DB-query candidate path already filters to `NOT reviewed`,
    but an explicit `orders` list previously bypassed that filter entirely --
    a reviewed header named explicitly must still be skipped, with its
    shares left untouched."""
    WC = "ZZTEST_WC_REAPPLYREV"
    L1, L2 = "ZZTEST_L1_REAPPLYREV", "ZZTEST_L2_REAPPLYREV"
    ORD, MAT = "ZZTEST_ORD_REAPPLYREV", "ZZT_MAT_REAPPLYREV"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE order_distribution SET reviewed = TRUE, reviewed_by = 'tester',"
                " reviewed_at = now(), reviewed_quantity = order_quantity"
                " WHERE plant = %s AND production_order = %s AND material_number = %s",
                (self.PLANT, self.ORD, self.MAT),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_explicit_orders_list_still_skips_an_already_reviewed_header(self, pg):
        shares_before = _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)

        result = distribution_data.reapply_defaults(
            self.PLANT, orders=[{"production_order": self.ORD, "material_number": self.MAT}],
        )

        assert result["skipped"] == 1
        assert result["headers_processed"] == 0
        shares_after = _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)
        assert shares_after == shares_before

    def test_only_unreviewed_false_still_resets_an_explicit_reviewed_order(self, pg):
        # only_unreviewed=False means "process every matching header
        # regardless of review state" -- an explicit reviewed order must
        # still go through in that mode.
        result = distribution_data.reapply_defaults(
            self.PLANT, orders=[{"production_order": self.ORD, "material_number": self.MAT}],
            only_unreviewed=False,
        )
        assert result["skipped"] == 0
        assert result["headers_processed"] == 1


@pytest.mark.pg
class TestReviewOrdersLockOrderAvoidsDeadlock(_ReweightFixtureBase):
    """D20 (Review Focus 4): two concurrent `review_orders` calls targeting
    the SAME two headers in OPPOSITE request order must never deadlock --
    both calls now lock every targeted header up front in ONE statement,
    ordered `plant, production_order, material_number` (the same key order
    `apply()` uses), instead of one `_lock_one_header` call per item in
    request order (which could grab the two headers in opposite order on
    each side and deadlock)."""
    WC_X = "ZZTEST_WC_RODLOCKX"
    L1_X, L2_X = "ZZTEST_L1_RODLOCKX", "ZZTEST_L2_RODLOCKX"
    ORD_X, MAT_X = "ZZTEST_ORD_RODLOCKX", "ZZT_MAT_RODLOCKX"
    WC_Y = "ZZTEST_WC_RODLOCKY"
    L1_Y, L2_Y = "ZZTEST_L1_RODLOCKY", "ZZTEST_L2_RODLOCKY"
    ORD_Y, MAT_Y = "ZZTEST_ORD_RODLOCKY", "ZZT_MAT_RODLOCKY"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC_X, self.L1_X, self.L2_X, self.ORD_X, self.MAT_X)
        self._seed_header(pg, self.WC_Y, self.L1_Y, self.L2_Y, self.ORD_Y, self.MAT_Y)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC_X, self.L1_X, self.L2_X, self.ORD_X, self.MAT_X)
            self._cleanup(cur, self.WC_Y, self.L1_Y, self.L2_Y, self.ORD_Y, self.MAT_Y)
            conn.commit()

    def test_opposite_order_concurrent_reviews_never_deadlock(self, pg):
        import threading

        items_forward = [
            {"production_order": self.ORD_X, "material_number": self.MAT_X, "base_version": None},
            {"production_order": self.ORD_Y, "material_number": self.MAT_Y, "base_version": None},
        ]
        items_reverse = [
            {"production_order": self.ORD_Y, "material_number": self.MAT_Y, "base_version": None},
            {"production_order": self.ORD_X, "material_number": self.MAT_X, "base_version": None},
        ]
        barrier = threading.Barrier(2)
        outcomes = {}
        errors = {}

        def _run(name, items):
            try:
                barrier.wait(timeout=10)
                outcomes[name] = distribution_data.review_orders(
                    self.PLANT, items, reviewed=True, actor=name,
                )
            except Exception as exc:  # noqa: BLE001 -- surfaced via errors dict below
                errors[name] = exc

        t1 = threading.Thread(target=_run, args=("forward", items_forward))
        t2 = threading.Thread(target=_run, args=("reverse", items_reverse))
        t1.start()
        t2.start()
        t1.join(timeout=20)
        t2.join(timeout=20)

        assert not t1.is_alive() and not t2.is_alive(), "a call hung -- possible deadlock/timeout"
        assert not errors, f"review_orders raised: {errors}"
        assert "forward" in outcomes and "reverse" in outcomes
        for name in ("forward", "reverse"):
            statuses = {r["production_order"]: r["status"] for r in outcomes[name]["results"]}
            assert statuses[self.ORD_X] == "ok"
            assert statuses[self.ORD_Y] == "ok"


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


def _count_admin_audit(db_, action: str, plant: str) -> int:
    with db_._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM admin_audit"
            " WHERE table_name = 'order_distribution' AND action = %s AND details->>'plant' = %s",
            (action, plant),
        )
        return cur.fetchone()[0]


@pytest.mark.pg
class TestResolveWcCodesWritesAdminAudit(_ReweightFixtureBase):
    """D55: `resolve` scope `wc_codes` previously wrote no `admin_audit` row
    at all -- a real (non-dry-run) call must now write exactly one, in the
    SAME transaction as the `plan()`/`apply()` writes it triggers."""
    WC = "ZZTEST_WC_RESOLVEAUDIT"
    L1, L2 = "ZZTEST_L1_RESOLVEAUDIT", "ZZTEST_L2_RESOLVEAUDIT"
    ORD, MAT = "ZZTEST_ORD_RESOLVEAUDIT", "ZZT_MAT_RSVAUD"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.plain_id = pg.make_id(self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, 60, self.SUB, self.PLANT, self.L2, self.WC, 40),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            # A plain order that arrived BEFORE the work center was
            # configured -- its `machine` is the WC CODE itself, not yet a
            # distribution header.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, run_time, order_quantity) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.plain_id, self.ORD, self.MAT, self.WC, self.PLANT,
                 dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 18, 0), 10.0, 100.0),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_resolve_wc_codes_writes_exactly_one_audit_row(self, pg):
        before = _count_admin_audit(pg, "resolve_wc_codes", self.PLANT)

        result = distribution_data.resolve(self.PLANT, "wc_codes", dry_run=False, actor="tester")
        assert result["headers_created"] >= 1

        after = _count_admin_audit(pg, "resolve_wc_codes", self.PLANT)
        assert after == before + 1

        # A dry run must write no audit row at all (it returns before the
        # insert, same as it writes no header/children).
        distribution_data.resolve(self.PLANT, "wc_codes", dry_run=True, actor="tester")
        assert _count_admin_audit(pg, "resolve_wc_codes", self.PLANT) == after


@pytest.mark.pg
class TestResolveMachinesWritesAdminAudit(_ReweightFixtureBase):
    """D55: `resolve` scope `machines` previously wrote no `admin_audit` row
    either -- a real call must now write exactly one."""
    WC = "ZZTEST_WC_RESOLVEMACHAUDIT"
    L1, L2 = "ZZTEST_L1_RESOLVEMACHAUDIT", "ZZTEST_L2_RESOLVEMACHAUDIT"
    ORD, MAT = "ZZTEST_ORD_RESOLVEMACHAUDIT", "ZZT_MAT_RSVMACH"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.plain_id = pg.make_id(self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight) "
                "VALUES (%s,%s,%s,%s,%s),(%s,%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L1, self.WC, 60, self.SUB, self.PLANT, self.L2, self.WC, 40),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            # A plain order already correctly sitting on a CURRENT member
            # machine, with no order_distribution header yet.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, run_time, order_quantity) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.plain_id, self.ORD, self.MAT, self.L1, self.PLANT,
                 dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 18, 0), 10.0, 100.0),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_resolve_machines_writes_exactly_one_audit_row(self, pg):
        before = _count_admin_audit(pg, "resolve_machines", self.PLANT)

        result = distribution_data.resolve(
            self.PLANT, "machines", workcenter=self.WC, dry_run=False, actor="tester",
        )
        assert result["headers_created"] >= 1

        after = _count_admin_audit(pg, "resolve_machines", self.PLANT)
        assert after == before + 1


@pytest.mark.pg
class TestOneToOneWorkcenterRules(_ReweightFixtureBase):
    """A work center whose code equals a machine name (a 1:1 work center) is
    valid only when that machine is explicitly linked to it
    (machine.sap_workcenter = code); an aggregate may not be named after one
    of its own members; `resolve` wc_codes never picks orders already on a
    real machine."""
    WC = "ZZTEST_WC_ONE2ONE"           # also the name of the 1:1 machine
    L2 = "ZZTEST_L2_ONE2ONE"
    OTHER = "ZZTEST_WC_ONE2ONE_OTH"
    ORD, MAT = "ZZTEST_ORD_ONE2ONE", "ZZT_MAT_ONE2ONE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.plain_id = pg.make_id(self.ORD, self.MAT)
        self._wipe(pg)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            # Unconfigured work center (single + NULL default is reachable since
            # the 2026-09-18 CHECK drop) and a same-named machine, NOT linked yet.
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES (%s, %s, 'single')",
                (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES (%s, %s, 'single')",
                (self.PLANT, self.OTHER),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,%s)",
                (self.SUB, self.PLANT, self.WC),
            )
            _seed_distribution_material(cur, self.MAT, self.PLANT)
            conn.commit()
        yield
        self._wipe(pg)

    def _wipe(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.WC, self.L2, self.ORD, self.MAT)
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.OTHER))
            cur.execute(
                "DELETE FROM admin_audit WHERE table_name = 'sap_workcenter' AND action = 'save_workcenter'"
                " AND details->>'sap_workcenter' IN (%s, %s)", (self.WC, self.OTHER),
            )
            conn.commit()

    def _link(self, pg, machine, wc):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE machine SET sap_workcenter = %s WHERE plant = %s AND machine = %s",
                        (wc, self.PLANT, machine))
            conn.commit()

    def _save(self, mode="single", default=None):
        return distribution_data.save_workcenter(
            self.PLANT, self.WC, None, mode, default, "none", True, False, None, user_email="tester")

    def test_linked_one_to_one_saves_single_with_null_default(self, pg):
        self._link(pg, self.WC, self.WC)
        result = self._save()
        assert result["distribution_mode"] == "single"
        assert result["default_machine"] is None

    def test_unlinked_same_named_machine_is_shadowed(self, pg):
        with pytest.raises(ValueError, match="wc_code_shadowed_by_machine") as ei:
            self._save()
        assert "set that machine's SAP work center" in str(ei.value)

    def test_same_named_machine_linked_elsewhere_is_shadowed(self, pg):
        self._link(pg, self.WC, self.OTHER)
        with pytest.raises(ValueError, match="wc_code_shadowed_by_machine") as ei:
            self._save()
        assert self.OTHER in str(ei.value)

    def test_linked_same_named_machine_plus_second_member_is_refused(self, pg):
        self._link(pg, self.WC, self.WC)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES (%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.L2, self.WC),
            )
            conn.commit()
        with pytest.raises(ValueError, match="wc_code_is_member_of_aggregate"):
            self._save()
        with pytest.raises(ValueError, match="wc_code_is_member_of_aggregate"):
            self._save(mode="distribute")

    def test_resolve_wc_codes_ignores_plain_order_on_a_real_machine(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, run_time, order_quantity) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.plain_id, self.ORD, self.MAT, self.WC, self.PLANT,
                 dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 18, 0), 10.0, 100.0),
            )
            conn.commit()
        result = distribution_data.resolve(self.PLANT, "wc_codes", dry_run=True, actor="tester")
        assert result == {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0,
                          "repaired": 0, "skipped": 0}


@pytest.mark.pg
class TestPurgeRetiresShareAndResetRevives(_ReweightFixtureBase):
    """B6/D02 (owner decision): a purge of a finished sub-order's date
    window retires its distribution share (`purged_at` stamped, `child_id`
    cleared) instead of leaving it dangling. Repair leaves it purged; an
    explicit Reset is the one path that brings it back; a header left with
    no live share anywhere is deleted outright so a later re-upload starts
    fresh."""
    WC = "ZZTEST_WC_PURGEREVIVE"
    L1, L2 = "ZZTEST_L1_PURGEREVIVE", "ZZTEST_L2_PURGEREVIVE"
    ORD, MAT = "ZZTEST_ORD_PURGEREVIVE", "ZZT_MAT_PURGEREV"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def _schedule(self, pg, child_id, start, end):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE id = %s",
                (start, end, child_id),
            )
            conn.commit()

    def test_purge_retires_one_share_repair_leaves_it_reset_revives_it(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        l1_child = next(c for c in children if c["machine"] == self.L1)
        l2_child = next(c for c in children if c["machine"] == self.L2)

        # Only L1 falls inside the purge window; L2 is scheduled well
        # outside it and must survive untouched.
        self._schedule(pg, l1_child["id"], dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 12, 0))
        self._schedule(pg, l2_child["id"], dt.datetime(2026, 11, 5, 8, 0), dt.datetime(2026, 11, 5, 12, 0))

        result = pg.purge_orders_by_date(
            self.PLANT, dt.datetime(2026, 10, 1, 0, 0), dt.datetime(2026, 10, 1, 23, 59),
            machines=[self.L1], user_email="tester@example.com",
        )
        assert result["deleted"] == 1
        assert result["shares_purged"] == 1
        assert result.get("headers_deleted", 0) == 0

        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT details FROM admin_audit
                    WHERE table_name = 'orders' AND action = 'purge_by_date_range'
                    ORDER BY id DESC LIMIT 1""",
            )
            audit_details = cur.fetchone()[0]
        assert audit_details["shares_purged"] == 1
        assert audit_details["headers_deleted"] == 0

        shares = {s["machine"]: s for s in _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)}
        assert shares[self.L1]["purged_at"] is not None
        assert shares[self.L1]["child_id"] is None
        assert shares[self.L2]["purged_at"] is None, "L2's share must be untouched by L1's purge"

        with pg._pool.connection() as conn, conn.cursor() as cur:
            rows = distribution_data._fetch_header_rows(cur, self.PLANT)
            distribution_data._hydrate_headers(cur, self.PLANT, rows)
        this_header = next(h for h in rows if h["production_order"] == self.ORD)
        assert "purged" in this_header["statuses"]
        assert "incomplete" not in this_header["statuses"], \
            "a purged share with no child is consistent, not incomplete"

        # Repair must leave the purged share exactly alone.
        distribution_data.resolve(self.PLANT, "repair", dry_run=False)
        after_repair = _snapshot_children(pg, self.PLANT, self.ORD)
        assert all(c["machine"] != self.L1 for c in after_repair), \
            "repair must never recreate a purged share's child"

        # Reset revives it: a fresh default weight lands on L1 and clears
        # its purge mark; L2 keeps its own default weight too.
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reset_one_header(self.PLANT, self.ORD, self.MAT, header["xmin"])

        shares_after_reset = {
            s["machine"]: s for s in _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)
        }
        assert shares_after_reset[self.L1]["purged_at"] is None
        assert shares_after_reset[self.L1]["weight"] > 0
        assert shares_after_reset[self.L2]["weight"] > 0

        children_after_reset = {c["machine"]: c for c in _snapshot_children(pg, self.PLANT, self.ORD)}
        assert self.L1 in children_after_reset, "Reset must recreate L1's child"
        assert self.L2 in children_after_reset

        # D02 pinned: the fixture's 60/40 default split lands exactly, and
        # B (never purged) keeps its original child -- it is not recreated.
        assert float(children_after_reset[self.L1]["order_quantity"]) == 60
        assert float(children_after_reset[self.L2]["order_quantity"]) == 40
        assert children_after_reset[self.L2]["id"] == l2_child["id"], \
            "L2's child must be kept, not recreated, by L1's revival"

        # Review Focus 3: a later upload of the SAME parent (after the
        # purge-then-reset cycle above) must be a no-op -- through the real
        # plan()/apply() ingest path the other upload tests use, not another
        # reset_one_header call -- same sub-order ids, same quantities, and
        # no share left purged.
        reupload_batch_id = str(uuid.uuid4())
        reupload_row = {
            "production_order": self.ORD, "material_number": self.MAT, "machine": self.WC,
            "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        _, reupload_plan, _ = distribution_data.plan([reupload_row], reupload_batch_id)
        with pg._pool.connection() as conn:
            distribution_data.apply(reupload_plan, reupload_batch_id, conn)

        children_after_reupload = {c["machine"]: c for c in _snapshot_children(pg, self.PLANT, self.ORD)}
        assert children_after_reupload[self.L1]["id"] == children_after_reset[self.L1]["id"], \
            "a same-parent re-upload must not recreate L1's revived child"
        assert children_after_reupload[self.L2]["id"] == l2_child["id"], \
            "a same-parent re-upload must not recreate L2's never-purged child"
        assert float(children_after_reupload[self.L1]["order_quantity"]) == 60
        assert float(children_after_reupload[self.L2]["order_quantity"]) == 40

        shares_after_reupload = {
            s["machine"]: s for s in _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)
        }
        assert shares_after_reupload[self.L1]["purged_at"] is None, \
            "the re-upload must not re-purge L1's just-revived share"
        assert shares_after_reupload[self.L2]["purged_at"] is None

    def test_fully_purged_header_is_deleted_and_reupload_creates_fresh_header(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        l1_child = next(c for c in children if c["machine"] == self.L1)
        l2_child = next(c for c in children if c["machine"] == self.L2)

        # Both children fall inside the same purge window this time.
        self._schedule(pg, l1_child["id"], dt.datetime(2026, 10, 1, 8, 0), dt.datetime(2026, 10, 1, 12, 0))
        self._schedule(pg, l2_child["id"], dt.datetime(2026, 10, 1, 9, 0), dt.datetime(2026, 10, 1, 13, 0))

        result = pg.purge_orders_by_date(
            self.PLANT, dt.datetime(2026, 10, 1, 0, 0), dt.datetime(2026, 10, 1, 23, 59),
        )
        assert result["deleted"] == 2
        assert result["shares_purged"] == 2
        assert result["headers_deleted"] == 1

        assert _snapshot_header(pg, self.PLANT, self.ORD, self.MAT) is None, \
            "a header with no remaining live share must be deleted"
        assert _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT) == [], \
            "shares must cascade-delete with their header"

        # A later upload of the same parent must create a fresh header, not
        # resurrect the dead one.
        batch_id = str(uuid.uuid4())
        row = {
            "production_order": self.ORD, "material_number": self.MAT, "machine": self.WC,
            "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        _, plan_structure, _ = distribution_data.plan([row], batch_id)
        with pg._pool.connection() as conn:
            distribution_data.apply(plan_structure, batch_id, conn)

        fresh_header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        assert fresh_header is not None
        fresh_shares = _snapshot_shares(pg, self.PLANT, self.ORD, self.MAT)
        assert fresh_shares, "the fresh header must have its own shares"
        assert all(s["purged_at"] is None for s in fresh_shares)


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
        # from the 99.0h sentinel, so the WHERE clause fires and the CASE is
        # actually exercised, not skipped as a no-op.
        self._set_run_time_source(pg, self.L1, source, 99.0)
        self._reingest_run_time(pg, 20.0)
        assert self._l1_run_time(pg) == pytest.approx(99.0)

    @pytest.mark.parametrize("source", ["legacy", "distributed", "sap_order", None])
    def test_unguarded_source_gets_refreshed_to_the_new_apportioned_value(self, pg, source):
        if source is not None:
            self._set_run_time_source(pg, self.L1, source, 99.0)
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

    def test_flag_is_never_auto_set_true_for_an_unscheduled_child(self, pg):
        # Both children start FALSE/NULL and unscheduled: a run-time change has no bar to re-fit.
        self._reingest_run_time(pg, 45.0)
        assert self._mismatch_flag(pg, self.L1) is not True
        assert self._mismatch_flag(pg, self.L2) is not True

    def _schedule(self, pg, machine, source=None):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET scheduled_start=%s, scheduled_end=%s, run_time_source=%s"
                " WHERE plant=%s AND parent_production_order=%s AND machine=%s",
                (dt.datetime(2026, 10, 2, 8), dt.datetime(2026, 10, 2, 12), source,
                 self.PLANT, self.ORD, machine))
            conn.commit()

    def test_h10_scheduled_child_with_changed_run_time_is_flagged(self, pg):
        self._schedule(pg, self.L1)
        self._reingest_run_time(pg, 30.0)
        assert self._mismatch_flag(pg, self.L1) is True
        assert self._mismatch_flag(pg, self.L2) is not True  # unscheduled sibling untouched

    def test_h10_scheduled_child_with_same_run_time_is_not_flagged(self, pg):
        self._schedule(pg, self.L1)
        self._reingest_run_time(pg, 10.0, qty=150.0)  # quantity changes, run time per share does not
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT run_time FROM orders WHERE plant=%s AND parent_production_order=%s AND machine=%s",
                        (self.PLANT, self.ORD, self.L1))
            before = cur.fetchone()[0]
        self._reingest_run_time(pg, 10.0, qty=150.0)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT run_time FROM orders WHERE plant=%s AND parent_production_order=%s AND machine=%s",
                        (self.PLANT, self.ORD, self.L1))
            assert cur.fetchone()[0] == before
        assert self._mismatch_flag(pg, self.L1) is not True

    def test_h10_manual_run_time_kept_is_not_flagged(self, pg):
        self._schedule(pg, self.L1, source="manual")
        self._reingest_run_time(pg, 30.0)
        assert self._mismatch_flag(pg, self.L1) is not True


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


# =====================================================================
# Consolidated fixes 2026-10-05, Bundle 2: parent-link integrity (D30/D07/D06/D43)
# =====================================================================

@pytest.mark.pg
class TestBundle2ParentLinkIntegrity(_ReweightFixtureBase):
    WC = "ZZTEST_WC_B2"
    L1, L2 = "ZZTEST_L1_B2", "ZZTEST_L2_B2"
    ORD, MAT = "ZZTEST_ORD_B2", "ZZTEST_MAT_B2"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def _parent_row(self, **kw):
        row = {
            "production_order": self.ORD, "material_number": self.MAT,
            "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }
        row.update(kw)
        return row

    def _upload(self, pg, rows):
        return pg.upsert_orders(
            rows, batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx",
            plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
        )

    # ---- D30 ----
    def test_d30_sub_order_id_row_is_skipped_with_warning(self, pg):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        sub = next(c for c in children if c["distribution_letter"])
        stray = self._parent_row(production_order=sub["production_order"], machine="ZZTEST_OTHER_M",
                                 order_quantity=7777.0)
        rows_out, _plan, warnings = distribution_data.plan([stray], str(uuid.uuid4()))
        assert rows_out == []
        assert [w["production_order"] for w in warnings["sub_order_id_rows"]] == [sub["production_order"]]

        # End to end through the generic upsert: untouched machine/quantity, warning surfaced.
        res = self._upload(pg, [stray, self._parent_row()])
        after = next(c for c in _snapshot_children(pg, self.PLANT, self.ORD) if c["id"] == sub["id"])
        assert after["machine"] == sub["machine"] and after["order_quantity"] == sub["order_quantity"]
        entry = next(w for w in res["warnings"] if w.get("category") == "distribution")
        assert entry["level"] == "warn" and entry["sub_order_id_rows"]
        assert sub["production_order"] in entry["msg"]

    # ---- D07 ----
    def test_d07_ordinary_upload_overwrites_stale_parent_link_with_null(self, pg):
        # Header purged/removed: the surviving bare sub-order must stop being machine-locked
        # once SAP re-sends it as an ordinary order (plain overwrite, not coalesce).
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD))
            conn.commit()
        bare_id = pg.make_id(self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO orders (id, production_order, material_number, machine, plant,"
                        " parent_production_order, distribution_letter) VALUES (%s,%s,%s,%s,%s,%s,NULL)"
                        " ON CONFLICT (id) DO UPDATE SET parent_production_order=EXCLUDED.parent_production_order,"
                        " distribution_letter=NULL",
                        (bare_id, self.ORD, self.MAT, self.L1, self.PLANT, self.ORD))
            conn.commit()
        self._upload(pg, [self._parent_row(machine=self.L1)])
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT parent_production_order, distribution_letter FROM orders WHERE id=%s", (bare_id,))
            assert cur.fetchone() == (None, None)

    def test_d07_planned_children_carry_link_through_the_generic_upsert(self, pg):
        # Crash window: children chunks committed, apply() never ran. The children must
        # still carry their parent link + letter so read paths find them.
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE parent_production_order=%s", (self.ORD,))
            cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD))
            conn.commit()
        pg.upsert_orders([self._parent_row()], batch_id=str(uuid.uuid4()), source="excel",
                         filename="f.xlsx", plan_fn=distribution_data.plan, apply_fn=None)
        kids = _snapshot_children(pg, self.PLANT, self.ORD)
        assert len(kids) == 2 and all(k["distribution_letter"] for k in kids)

    # ---- D06 ----
    def test_d06_collapse_during_upload_leaves_no_orphan_sub_orders(self, pg):
        # Real race: upload plan()s against the 60/40 header, a planner then REALLY
        # collapses to L1 only (children deleted, bare id created, header xmin bumped),
        # then the upload's normal chunks re-insert the plan-time A-/B- sub-orders and
        # apply() runs. Pre-fix those two stayed forever (2,000 pieces for a 1,000 order).
        rows_out, plan_struct, ingest_w = distribution_data.plan([self._parent_row()], str(uuid.uuid4()))
        assert len(rows_out) == 2
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}], header["xmin"])
        assert [c["distribution_letter"] for c in _snapshot_children(pg, self.PLANT, self.ORD)] == [None]

        res = pg.upsert_orders(
            [self._parent_row()], batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx",
            plan_fn=lambda rows, b: (rows_out, plan_struct, ingest_w), apply_fn=distribution_data.apply)
        assert res["status"] == "ok"
        kids = _snapshot_children(pg, self.PLANT, self.ORD)
        assert [(k["production_order"], k["distribution_letter"]) for k in kids] == [(self.ORD, None)]
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM orders WHERE material_number=%s AND production_order LIKE %s",
                        (self.MAT, "%" + self.ORD))
            assert cur.fetchone()[0] == 1

    def test_d06_scheduled_plan_time_orphan_is_left_in_place(self, pg):
        # Scheduled-removal safeguard: a plan-time-only order a planner already scheduled
        # is never silently deleted by the supersede sweep.
        rows_out, plan_struct, ingest_w = distribution_data.plan([self._parent_row()], str(uuid.uuid4()))
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}], header["xmin"])
        pg.upsert_orders(
            [self._parent_row()], batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx",
            plan_fn=lambda rows, b: (rows_out, plan_struct, ingest_w), apply_fn=None)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s WHERE material_number=%s"
                        " AND production_order = %s", (dt.datetime(2026, 10, 2, 8), dt.datetime(2026, 10, 2, 12),
                                                       self.MAT, "A-" + self.ORD))
            conn.commit()
        with pg._pool.connection() as conn:
            distribution_data.apply(plan_struct, str(uuid.uuid4()), conn)
        left = sorted(k["production_order"] for k in _snapshot_children(pg, self.PLANT, self.ORD))
        assert left == ["A-" + self.ORD, self.ORD]

    # ---- D43 ----
    def test_d43_hours_sum_ignores_orphans_carrying_the_parent_link(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET labor_hours = 50 WHERE parent_production_order=%s", (self.ORD,))
            # Orphan: carries the parent link but no share points at it.
            cur.execute("INSERT INTO orders (id, production_order, material_number, machine, plant,"
                        " parent_production_order, distribution_letter, labor_hours, machine_hours)"
                        " VALUES (%s,%s,%s,%s,%s,%s,'Z',50,10)",
                        (pg.make_id("Z-" + self.ORD, self.MAT), "Z-" + self.ORD, self.MAT, self.L1,
                         self.PLANT, self.ORD))
            conn.commit()
            header = distribution_data._lock_one_header(cur, self.PLANT, self.ORD, self.MAT, for_update=False)
            facts = distribution_data._parent_facts_from_header(cur, self.PLANT, self.ORD, self.MAT, header)
        assert facts["labor_hours"] == Decimal(100)          # 2 real children x 50; orphan's 50 excluded
        assert facts["machine_hours"] in (None, Decimal(0))  # orphan's 10 excluded


class TestBundle3FetchChildrenLock:
    """D17 (no DB): the real-write child read takes `FOR UPDATE OF o` in id
    order; the dry-run preview read stays lock-free (D56)."""

    class _Cur:
        def __init__(self):
            self.queries = []

        def execute(self, sql, params=None):
            self.queries.append(sql)

        def fetchall(self):
            return []

    def test_lock_true_orders_by_id_and_locks_orders_rows(self):
        cur = self._Cur()
        distribution_data._fetch_children_by_machine(cur, "1006", "ORD", "MAT", lock=True)
        assert "ORDER BY o.id" in cur.queries[0]
        assert "FOR UPDATE OF o" in cur.queries[0]

    def test_default_is_lock_free(self):
        cur = self._Cur()
        distribution_data._fetch_children_by_machine(cur, "1006", "ORD", "MAT")
        assert "FOR UPDATE" not in cur.queries[0]


@pytest.mark.pg
class TestBundle3RewriteSafety(_ReweightFixtureBase):
    WC = "ZZTEST_WC_B3"
    L1, L2 = "ZZTEST_L1_B3", "ZZTEST_L2_B3"
    ORD, MAT = "ZZTEST_ORD_B3", "ZZTEST_MAT_B3"
    ORD2 = "ZZTEST_ORD_B3X"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            cur.execute("DELETE FROM orders WHERE plant=%s AND (parent_production_order=%s OR production_order=%s)",
                        (self.PLANT, self.ORD2, self.ORD2))
            cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD2))
            conn.commit()

    def _row(self, order, qty=100.0):
        return {
            "production_order": order, "material_number": self.MAT, "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0),
            "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": qty, "run_time": 10.0,
        }

    # ---- D17 ----
    def test_d17_real_reweight_captures_setup_states_dry_run_does_not(self, pg):
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        shares = [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}]
        with mock.patch.object(distribution_data.setup_data,
                               "capture_setup_states_before_schedule_mutation") as cap:
            distribution_data.reweight_shares(self.PLANT, self.ORD, self.MAT, shares, header["xmin"],
                                              dry_run=True)
            assert cap.call_count == 0
            distribution_data.reweight_shares(self.PLANT, self.ORD, self.MAT, shares, header["xmin"])
            assert cap.call_count == 1 and cap.call_args.kwargs["plants"] == [self.PLANT]

    # ---- D01 ----
    def test_d01_one_failing_parent_does_not_fail_the_rest(self, pg):
        batch_id = str(uuid.uuid4())
        _, plan_struct, _ = distribution_data.plan(
            [self._row(self.ORD, 200.0), self._row(self.ORD2)], batch_id)
        real = distribution_data._apply_children

        def flaky(cur, parent):
            if parent["production_order"] == self.ORD2:
                raise RuntimeError("boom")
            return real(cur, parent)

        with mock.patch.object(distribution_data, "_apply_children", side_effect=flaky),                 pg._pool.connection() as conn:
            res = distribution_data.apply(plan_struct, batch_id, conn)
        assert res["parents_distributed"] == 1
        entry = res["warnings_entry"]
        assert entry["level"] == "warn"
        assert [f["production_order"] for f in entry["failed_parents"]] == [self.ORD2]
        assert self.ORD2 in entry["msg"]
        assert sum(c["order_quantity"] for c in _snapshot_children(pg, self.PLANT, self.ORD)) == Decimal(200)
        assert _snapshot_header(pg, self.PLANT, self.ORD2, self.MAT) is None  # rolled back, not half-written

    # ---- D11 ----
    def test_d11_reweight_stamps_tooling_and_production_version(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE material_plants SET prt_01='T1', prt_02='T2', default_production_version='PV9'"
                        " WHERE plant=%s AND material_id=%s", (self.PLANT, self.MAT))
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 50}, {"machine": self.L2, "weight": 50}], header["xmin"])
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT prt_01, prt_02, production_version FROM orders WHERE plant=%s"
                        " AND parent_production_order=%s", (self.PLANT, self.ORD))
            rows = cur.fetchall()
        assert rows and all(r == ("T1", "T2", "PV9") for r in rows)

    @pytest.mark.parametrize("source,expect_runtime", [("manual", 77), (None, 10)])
    def test_d11_collapse_copies_tooling_and_only_manual_run_time(self, pg, source, expect_runtime):
        children = _snapshot_children(pg, self.PLANT, self.ORD)
        old = next(c for c in children if c["machine"] == self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET prt_01='OLD1', prt_02='OLD2', production_version='OLDPV',"
                        " run_time=77, run_time_source=%s, run_time_basis=%s::jsonb WHERE id=%s",
                        (source, '{"k": 1}' if source else None, old["id"]))
            # No material_plants row: isolates the collapse copy from the batch stamp (which wins when a row exists).
            cur.execute("DELETE FROM material_plants WHERE plant=%s AND material_id=%s", (self.PLANT, self.MAT))
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}], header["xmin"],
            confirm_remove_scheduled=True)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT prt_01, prt_02, production_version, run_time, run_time_source FROM orders WHERE id=%s",
                        (pg.make_id(self.ORD, self.MAT),))
            prt1, prt2, pv, rt, rts = cur.fetchone()
        assert (prt1, prt2, pv) == ("OLD1", "OLD2", "OLDPV")
        assert float(rt) == expect_runtime
        assert rts == source


def test_letter_sort_key_orders_aa_after_z():
    from backend.distribution.service import _index_to_letter, letter_sort_key
    letters = [_index_to_letter(i) for i in (27, 0, 26, 1, 25)]   # AB, A, AA, B, Z
    assert sorted(letters, key=letter_sort_key) == ["A", "B", "Z", "AA", "AB"]
    assert sorted(letters)[:3] == ["A", "AA", "AB"]               # the old, wrong order


@pytest.mark.pg
class TestIngestFlagsScheduledChildRuntimeChange(_ReweightFixtureBase):
    """H10/D33 (review round): the mismatch flag must fire on a REAL ingest, where
    db._UPSERT_SQL writes the child rows before distribution's own child upsert."""
    WC = "ZZTEST_WC_H10"
    L1, L2 = "ZZTEST_L1_H10", "ZZTEST_L2_H10"
    ORD, MAT = "ZZTEST_ORD_H10", "ZZTEST_MAT_H10"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    def test_scheduled_child_flagged_unscheduled_child_not(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s, runtime_schedule_mismatch=FALSE"
                        " WHERE plant=%s AND parent_production_order=%s",
                        (dt.datetime(2026, 10, 2, 8), dt.datetime(2026, 10, 2, 12), self.PLANT, self.ORD))
            cur.execute("UPDATE orders SET scheduled_start=NULL, scheduled_end=NULL"
                        " WHERE plant=%s AND parent_production_order=%s AND machine=%s",
                        (self.PLANT, self.ORD, self.L2))
            conn.commit()
        row = {"production_order": self.ORD, "material_number": self.MAT, "machine": self.WC, "plant": self.PLANT,
               "basic_start_date": dt.datetime(2026, 10, 1, 8), "basic_finish_date": dt.datetime(2026, 10, 1, 18),
               "order_quantity": 100.0, "run_time": 30.0}
        pg.upsert_orders([row], plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
                         resolve_fn=routing_resolver.resolve_orders)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT machine, runtime_schedule_mismatch FROM orders"
                        " WHERE plant=%s AND parent_production_order=%s", (self.PLANT, self.ORD))
            flags = dict(cur.fetchall())
        assert flags[self.L1] is True
        assert flags[self.L2] is False


def test_apply_chunk_size_bounds_total_savepoints():
    f = distribution_data._apply_chunk_size
    assert f(0) == 50 and f(10) == 50 and f(2500) == 50
    for n in (2501, 10_000, 100_000):
        assert -(-n // f(n)) <= 50   # <= 50 chunk savepoints per apply()


@pytest.mark.pg
class TestUploadMessageCountsPlannedChildren(_ReweightFixtureBase):
    """Senior audit #3: an unchanged re-upload writes no child rows, so the
    summary read 'distributed into 0 sub-order(s)'."""
    WC, L1, L2 = "ZZTEST_WC_UPMSG", "ZZTEST_L1_UPMSG", "ZZTEST_L2_UPMSG"
    ORD, MAT = "ZZTEST_ORD_UPMSG", "ZZT_MAT_UPMSG"

    def test_summary_reports_planned_children_even_when_none_written(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        try:
            row = {"production_order": self.ORD, "material_number": self.MAT, "machine": self.WC,
                   "plant": self.PLANT, "basic_start_date": dt.datetime(2026, 10, 1, 8),
                   "basic_finish_date": dt.datetime(2026, 10, 1, 18), "order_quantity": 100.0, "run_time": 10.0}
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE plant=%s AND parent_production_order=%s", (self.PLANT, self.ORD))
                cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s", (self.PLANT, self.ORD))
                conn.commit()
            res = pg.upsert_orders([row], plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
                                   resolve_fn=routing_resolver.resolve_orders)
            msgs = [w.get("msg", "") for w in res["warnings"] if w.get("category") == "distribution"]
            assert any("distributed into 2 sub-order(s)" in m for m in msgs), msgs
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
                conn.commit()


def _wait_for_lock_wait(db_, timeout=10.0):
    """Deterministically wait until some backend of this DB is blocked on a
    heavyweight lock (pg_stat_activity), instead of sleeping."""
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_stat_activity WHERE datname = current_database()"
                        " AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' LIMIT 1")
            if cur.fetchone():
                return True
        time.sleep(0.05)
    return False


@pytest.mark.pg
class TestApplyAndRepairLockOrderNeverDeadlocks(_ReweightFixtureBase):
    """Senior audit #1/#2: apply() upserted children in letter order while a
    /tasks save locks in id order (deadlock), and _resolve_repair held every
    header lock across its loop in basic_start_date order (deadlock vs apply
    and vs saves)."""
    MAT = "ZZT_MAT_LOCKORD"
    WC, L1, L2 = "ZZTEST_WC_LOCKORD", "ZZTEST_L1_LOCKORD", "ZZTEST_L2_LOCKORD"

    def _children(self, pg, order):
        return _snapshot_children(pg, self.PLANT, order)

    def _row(self, order, qty=100.0):
        return {"production_order": order, "material_number": self.MAT, "machine": self.WC,
                "plant": self.PLANT, "basic_start_date": dt.datetime(2026, 10, 1, 8),
                "basic_finish_date": dt.datetime(2026, 10, 1, 18), "order_quantity": qty, "run_time": 10.0}

    def test_apply_vs_task_save_has_no_deadlock(self, pg):
        import threading
        order = next(o for o in (f"ZZLKA{i}" for i in range(500))
                     if pg.make_id("A-" + o, self.MAT) > pg.make_id("B-" + o, self.MAT))
        self._seed_header(pg, self.WC, self.L1, self.L2, order, self.MAT)
        try:
            ch = self._children(pg, order)
            ids = sorted(c["id"] for c in ch)
            vers = {c["id"]: c["xmin"] for c in ch}
            bid = str(uuid.uuid4())
            _, ps, _ = distribution_data.plan([self._row(order, 200.0)], bid)
            real = distribution_data._apply_children
            paused, release = threading.Event(), threading.Event()

            def stepped(cur, parent):
                rows = parent["child_rows"]
                if len(rows) < 2:
                    return real(cur, parent)
                n = real(cur, dict(parent, child_rows=rows[:1]))
                paused.set()
                release.wait(30)
                return n + real(cur, dict(parent, child_rows=rows[1:]))

            res = {}

            def do_apply():
                try:
                    with pg._pool.connection() as conn:
                        res["apply"] = distribution_data.apply(ps, bid, conn)
                except Exception as exc:  # noqa: BLE001
                    res["apply"] = exc

            def do_save():
                t0 = dt.datetime(2026, 10, 2, 8)
                try:
                    res["save"] = pg.update_task_dates_bulk(
                        [{"id": i, "start": t0, "end": t0 + dt.timedelta(hours=3), "base_version": vers[i]}
                         for i in ids])
                except Exception as exc:  # noqa: BLE001
                    res["save"] = exc

            with mock.patch.object(distribution_data, "_apply_children", stepped):
                ta = threading.Thread(target=do_apply, daemon=True)
                ta.start()
                assert paused.wait(20)
                ts = threading.Thread(target=do_save, daemon=True)
                ts.start()
                _wait_for_lock_wait(pg, 3.0)
                release.set()
                ta.join(40)
                ts.join(40)
            assert not ta.is_alive() and not ts.is_alive()
            for name in ("apply", "save"):
                assert not isinstance(res[name], Exception), f"{name} raised {res[name]!r}"
            assert not res["apply"].get("ingest_warnings", {}).get("failed_parents"), res["apply"]
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                self._cleanup(cur, self.WC, self.L1, self.L2, order, self.MAT)
                conn.commit()

    @pytest.mark.parametrize("mode", ["apply", "save"])
    def test_repair_vs_apply_or_save_has_no_deadlock(self, pg, mode):
        import threading
        oa, ob = next((f"ZZLKRA{i}", f"ZZLKRB{i}") for i in range(500)
                      if pg.make_id(f"A-ZZLKRA{i}", self.MAT) < pg.make_id(f"A-ZZLKRB{i}", self.MAT))
        self._seed_header(pg, self.WC, self.L1, self.L2, oa, self.MAT)
        batch = str(uuid.uuid4())
        _, ps2, _ = distribution_data.plan([self._row(ob)], batch)
        with pg._pool.connection() as conn:
            distribution_data.apply(ps2, batch, conn)
        try:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("UPDATE order_distribution SET basic_start_date = basic_start_date - interval '2 days'"
                            " WHERE plant=%s AND production_order=%s", (self.PLANT, ob))
                for o in (oa, ob):
                    cid = next(c["id"] for c in self._children(pg, o) if c["machine"] == self.L2)
                    cur.execute("DELETE FROM orders WHERE id=%s", (cid,))
                conn.commit()
            real = distribution_data._repair_one_header
            seen, first_done, release = [], threading.Event(), threading.Event()

            def stepped(cur, plant, order, material, header):
                r = real(cur, plant, order, material, header)
                seen.append(order)
                if len(seen) == 1:
                    first_done.set()
                    release.wait(30)
                return r

            res = {}

            def run(name, fn):
                try:
                    res[name] = fn()
                except Exception as exc:  # noqa: BLE001
                    res[name] = exc

            with mock.patch.object(distribution_data, "_repair_one_header", stepped):
                tr = threading.Thread(target=run, daemon=True, args=(
                    "repair", lambda: distribution_data.resolve(self.PLANT, "repair")))
                tr.start()
                assert first_done.wait(30)
                assert seen[0] == ob, "repair must visit the chronologically-first header first"
                if mode == "apply":
                    b2 = str(uuid.uuid4())
                    _, ps, _ = distribution_data.plan([self._row(oa), self._row(ob)], b2)

                    def other():
                        with pg._pool.connection() as conn:
                            return distribution_data.apply(ps, b2, conn)
                else:
                    kids = [c for o in (oa, ob) for c in self._children(pg, o)]
                    t0 = dt.datetime(2026, 10, 2, 8)
                    items = [{"id": c["id"], "start": t0, "end": t0 + dt.timedelta(hours=3),
                              "base_version": c["xmin"]} for c in sorted(kids, key=lambda c: c["id"])]

                    def other():
                        return pg.update_task_dates_bulk(items)
                to = threading.Thread(target=run, args=("other", other), daemon=True)
                to.start()
                _wait_for_lock_wait(pg, 3.0)
                release.set()
                tr.join(40)
                to.join(40)
            assert not tr.is_alive() and not to.is_alive()
            for name in ("repair", "other"):
                assert not isinstance(res[name], Exception), f"{name} raised {res[name]!r}"
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE plant=%s AND (parent_production_order=%s OR production_order=%s)",
                            (self.PLANT, ob, ob))
                cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s", (self.PLANT, ob))
                self._cleanup(cur, self.WC, self.L1, self.L2, oa, self.MAT)
                conn.commit()



@pytest.mark.pg
class TestSapTruthDistributionReupload(_ReweightFixtureBase):
    """SAP-is-truth re-upload on distributed orders: an unchanged upload leaves
    every child untouched; a SAP change on one child resets ALL children of
    that parent+material (and only them) under the ordered row lock."""
    WC, L1, L2 = "ZZTEST_WC_STR", "ZZTEST_L1_STR", "ZZTEST_L2_STR"
    ORD, MAT, MAT2 = "ZZTEST_ORD_STR", "ZZT_MAT_STR", "ZZT_MAT2_STR"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            _seed_distribution_material(cur, self.MAT2, self.PLANT)
            conn.commit()
        self.base = (dt.datetime.now() + dt.timedelta(days=40)).replace(hour=8, minute=0, second=0, microsecond=0)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s", (self.PLANT, self.MAT2))
            cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT2,))
            conn.commit()

    def _parent(self, mat, **kw):
        row = {"production_order": self.ORD, "material_number": mat, "machine": self.WC, "plant": self.PLANT,
               "basic_start_date": self.base, "basic_finish_date": self.base + dt.timedelta(hours=10),
               "order_quantity": 100.0, "run_time": 10.0}
        row.update(kw)
        return row

    def _upload(self, pg, rows, **kw):
        return pg.upsert_orders(rows, batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx",
                                plan_fn=distribution_data.plan, apply_fn=distribution_data.apply, **kw)

    def _state(self, pg, mat):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT id, scheduled_start, manual_firmed, xmin::text::bigint FROM orders"
                        " WHERE plant=%s AND parent_production_order=%s AND material_number=%s ORDER BY id",
                        (self.PLANT, self.ORD, mat))
            return cur.fetchall()

    def _place_and_firm(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s, manual_firmed=TRUE"
                        " WHERE plant=%s AND parent_production_order=%s",
                        (self.base + dt.timedelta(days=2), self.base + dt.timedelta(days=2, hours=4),
                         self.PLANT, self.ORD))
            conn.commit()

    def test_unchanged_reupload_keeps_child_xmin(self, pg):
        self._upload(pg, [self._parent(self.MAT)])
        self._place_and_firm(pg)
        before = self._state(pg, self.MAT)
        assert len(before) == 2
        res = self._upload(pg, [self._parent(self.MAT)])
        assert self._state(pg, self.MAT) == before
        assert res["updated"] == 0 and res["unchanged"] == 2

    def test_child_change_resets_all_siblings_only(self, pg):
        def rows():
            return [self._parent(self.MAT), self._parent(self.MAT2)]
        self._upload(pg, rows())
        self._place_and_firm(pg)
        mat_before, mat2_before = self._state(pg, self.MAT), self._state(pg, self.MAT2)
        assert len(mat_before) == 2 and len(mat2_before) == 2
        # SAP "changed" ONE child of MAT only (its stored baseline differs from what arrives).
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET sap_basic_start_date = sap_basic_start_date - interval '1 day'"
                        " WHERE id = %s", (mat_before[-1][0],))
            conn.commit()
        mat2_before = self._state(pg, self.MAT2)
        with mock.patch.object(pg, "_UPSERT_CHUNK", 1):
            res = self._upload(pg, rows())
        for _id, sched, firmed, _xmin in self._state(pg, self.MAT):
            assert sched is None and firmed is False
        assert self._state(pg, self.MAT2) == mat2_before, "a second material on the same order is untouched"
        assert next(w for w in res["warnings"] if w.get("category") == "sap_changed")["count"] == 2

    def test_planner_reweight_during_stale_plan_upload_is_not_an_sap_change(self, pg):
        # The plan is computed, a planner re-weights and firms, then the upload runs on the
        # stale plan: the children's own share quantities differ from the re-weighted ones,
        # but SAP changed nothing about the PARENT, so no slot/firm reset.
        self._upload(pg, [self._parent(self.MAT)])
        stale_rows, stale_plan, stale_warnings = distribution_data.plan([self._parent(self.MAT)], "stale-batch")
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 70}, {"machine": self.L2, "weight": 30}],
            base_version=header["xmin"], actor="tester")
        self._place_and_firm(pg)
        res = pg.upsert_orders([self._parent(self.MAT)], batch_id=str(uuid.uuid4()), source="excel",
                               filename="f.xlsx", plan_fn=lambda rows, batch: (stale_rows, stale_plan, stale_warnings),
                               apply_fn=distribution_data.apply)
        assert not [w for w in res["warnings"] if w.get("category") in ("sap_changed", "unfirmed")], res["warnings"]
        for _id, sched, firmed, _xmin in self._state(pg, self.MAT):
            assert sched is not None and firmed is True

    def _originals(self, pg, mat):
        """(header original_finish_received, {child id: (original_start_received, original_finish_received,
        sap_basic_start_date, sap_basic_finish_date)})."""
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT original_finish_received FROM order_distribution"
                        " WHERE plant=%s AND production_order=%s AND material_number=%s",
                        (self.PLANT, self.ORD, mat))
            header = cur.fetchone()[0]
            cur.execute("SELECT id, original_start_received, original_finish_received, sap_basic_start_date,"
                        " sap_basic_finish_date FROM orders WHERE plant=%s AND parent_production_order=%s"
                        " AND material_number=%s ORDER BY id", (self.PLANT, self.ORD, mat))
            return header, {r[0]: tuple(r[1:]) for r in cur.fetchall()}

    def _mark_sent(self, pg, mat, sent_finish):
        """What a Send to SAP leaves behind: one order_sap_sent row per member child carrying the roll-up end."""
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO order_sap_sent (order_id, plant, sent_finish)"
                        " SELECT id, plant, %s FROM orders WHERE plant=%s AND parent_production_order=%s"
                        " AND material_number=%s ON CONFLICT (order_id) DO UPDATE SET sent_finish = EXCLUDED.sent_finish",
                        (sent_finish, self.PLANT, self.ORD, mat))
            conn.commit()

    def test_reweight_then_unchanged_dateonly_upload_resets_no_sibling(self, pg):
        """A date-only SAP finish (Fri 23 Oct) that NIMBUS already sent back is an echo. A planner re-weight
        must not make the next unchanged upload look like an SAP change (no sibling slot reset), must not
        move the locked originals on the header or the children, and must not stamp an SAP baseline on a
        child it creates."""
        fri = dt.datetime(2026, 10, 23)                       # date only: SAP sent no time
        start = dt.datetime(2026, 10, 21, 8, 0)
        rows = [self._parent(self.MAT, basic_start_date=start, basic_finish_date=fri)]
        self._upload(pg, rows)
        header_before, kids_before = self._originals(pg, self.MAT)
        assert header_before == fri and len(kids_before) == 2
        assert all(k[1] == fri for k in kids_before.values())
        self._mark_sent(pg, self.MAT, fri + dt.timedelta(hours=14))   # NIMBUS's roll-up end, same calendar day
        self._place_and_firm(pg)
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 50}, {"machine": self.L2, "weight": 50}],
            base_version=header["xmin"], actor="tester")
        # the re-weight itself writes no SAP baseline and no original
        assert self._originals(pg, self.MAT) == (header_before, kids_before)
        res = self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=fri)])
        assert not [w for w in res["warnings"] if w.get("category") in ("sap_changed", "unfirmed")], res["warnings"]
        for _id, sched, firmed, _xmin in self._state(pg, self.MAT):
            assert sched is not None and firmed is True, "an echoed upload must not reset any sibling"
        assert self._originals(pg, self.MAT) == (header_before, kids_before)

    def test_reweight_adding_a_member_leaves_the_new_child_without_sap_baseline(self, pg):
        """A child created by a planner re-weight inherits the header's originals but carries no SAP baseline
        of its own (the next upload fills it); the existing children's baselines are not rewritten."""
        fri = dt.datetime(2026, 10, 23)
        start = dt.datetime(2026, 10, 21, 8, 0)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=fri)])
        L3 = "ZZTEST_L3_STR"
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM machine WHERE plant=%s AND machine=%s", (self.PLANT, L3))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight)"
                        " VALUES (%s,%s,%s,%s,0)", (self.SUB, self.PLANT, L3, self.WC))
            conn.commit()
        try:
            header_before, kids_before = self._originals(pg, self.MAT)
            header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
            distribution_data.reweight_shares(
                self.PLANT, self.ORD, self.MAT,
                [{"machine": self.L1, "weight": 40}, {"machine": self.L2, "weight": 40}, {"machine": L3, "weight": 20}],
                base_version=header["xmin"], actor="tester")
            header_after, kids_after = self._originals(pg, self.MAT)
            assert header_after == header_before
            assert len(kids_after) == 3
            for cid, vals in kids_after.items():
                if cid in kids_before:
                    assert vals == kids_before[cid]
                else:
                    assert vals[0] == start and vals[1] == fri, "the new child inherits the locked originals"
                    assert vals[2] is None and vals[3] is None, "and carries no SAP baseline yet"
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM machine WHERE plant=%s AND machine=%s", (self.PLANT, L3))
                conn.commit()

    def test_reweight_never_rewrites_a_childs_dates_or_baseline(self, pg):
        """A planner re-weight leaves every child's basic_finish_date, SAP baselines and locked originals
        exactly as they are, even when the stored values differ from what the header would recompute."""
        fri = dt.datetime(2026, 10, 23)
        start = dt.datetime(2026, 10, 21, 8, 0)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=fri)])
        moved = dt.datetime(2026, 10, 27, 12, 0)     # what a client baseline-correct would leave behind
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET basic_finish_date = %s WHERE plant=%s AND parent_production_order=%s",
                        (moved, self.PLANT, self.ORD))
            conn.commit()
        header = _snapshot_header(pg, self.PLANT, self.ORD, self.MAT)
        distribution_data.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 50}, {"machine": self.L2, "weight": 50}],
            base_version=header["xmin"], actor="tester")
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT basic_start_date, basic_finish_date, sap_basic_start_date, sap_basic_finish_date,"
                        " original_start_received, original_finish_received FROM orders"
                        " WHERE plant=%s AND parent_production_order=%s", (self.PLANT, self.ORD))
            rows = cur.fetchall()
        assert len(rows) == 2
        for r in rows:
            assert r == (start, moved, start, fri, start, fri)

    def test_header_original_finish_follows_the_echo_rule(self, pg):
        """The header's locked due date: set by the first ingest, kept when the next upload echoes the roll-up
        finish NIMBUS sent (judged on ANY member child's sent row), replaced by a genuine SAP change."""
        fri = dt.datetime(2026, 10, 23)
        start = dt.datetime(2026, 10, 21, 8, 0)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=fri)])
        assert self._originals(pg, self.MAT)[0] == fri
        # no sent row on any member: a different finish is a genuine change
        mon = dt.datetime(2026, 10, 26)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=mon)])
        assert self._originals(pg, self.MAT)[0] == mon
        # NIMBUS sent Wed 28 Oct; SAP echoes that date back (date only): the locked due date stays
        self._mark_sent(pg, self.MAT, dt.datetime(2026, 10, 28, 14, 0))
        wed = dt.datetime(2026, 10, 28)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=wed)])
        header_orig, kids = self._originals(pg, self.MAT)
        assert header_orig == mon and all(k[1] == mon for k in kids.values())
        # a finish that is neither the old one nor the sent one is SAP's own change
        thu = dt.datetime(2026, 10, 29)
        self._upload(pg, [self._parent(self.MAT, basic_start_date=start, basic_finish_date=thu)])
        header_orig, kids = self._originals(pg, self.MAT)
        assert header_orig == thu and all(k[1] == thu for k in kids.values())

    def test_resolve_machines_header_due_comes_from_the_plain_orders_locked_original(self, pg):
        """`resolve` scope `machines`: the new header's due date is the plain order's locked original finish,
        never a client-rewritten basic_finish_date."""
        fri = dt.datetime(2026, 10, 23)
        moved = dt.datetime(2026, 10, 27, 12, 0)
        oid = pg.make_id(self.ORD, self.MAT)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            # start from a plain order: drop the family the fixture ingested
            cur.execute("DELETE FROM orders WHERE plant=%s AND (parent_production_order=%s OR id=%s)",
                        (self.PLANT, self.ORD, oid))
            cur.execute("DELETE FROM order_distribution WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, original_start_received, original_finish_received, order_quantity, run_time)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,100,10)",
                (oid, self.ORD, self.MAT, self.L1, self.PLANT, dt.datetime(2026, 10, 21, 8), moved,
                 dt.datetime(2026, 10, 21, 8), fri))
            conn.commit()
        res = distribution_data.resolve(self.PLANT, "machines", workcenter=self.WC, actor="tester")
        assert res["headers_created"] == 1
        assert self._originals(pg, self.MAT)[0] == fri
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT basic_finish_date FROM order_distribution WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD))
            assert cur.fetchone()[0] == fri

    def test_parent_quantity_change_resets_all_children(self, pg):
        self._upload(pg, [self._parent(self.MAT)])
        self._place_and_firm(pg)
        res = self._upload(pg, [self._parent(self.MAT, order_quantity=120.0)])
        for _id, sched, firmed, _xmin in self._state(pg, self.MAT):
            assert sched is None and firmed is False
        assert next(w for w in res["warnings"] if w.get("category") == "sap_changed")["count"] == 2

    def test_child_without_header_quantity_falls_back_to_its_own_quantity(self, pg):
        self._upload(pg, [self._parent(self.MAT)])
        self._place_and_firm(pg)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE order_distribution SET order_quantity = NULL WHERE plant=%s AND production_order=%s",
                        (self.PLANT, self.ORD))
            conn.commit()
        self._upload(pg, [self._parent(self.MAT, order_quantity=120.0)])
        for _id, sched, firmed, _xmin in self._state(pg, self.MAT):
            assert sched is None and firmed is False

    def test_ingest_vs_save_vs_apply_lock_order_never_deadlocks(self, pg):
        """Stepped: a writer that locks in id order (what a /tasks save does) holds the
        EARLIER child and pauses while the ingest chunk is blocked on it, then takes the
        LATER child. That only works when the chunk lock is id-ordered: a chunk that locked
        the later child first would hold it while waiting for the earlier one, and the
        two would deadlock (PostgreSQL aborts one of them with DeadlockDetected)."""
        import threading
        self._upload(pg, [self._parent(self.MAT)])
        self._place_and_firm(pg)
        kids = self._state(pg, self.MAT)
        ids = sorted(k[0] for k in kids)
        first, last = ids[0], ids[-1]
        assert first < last
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET sap_basic_start_date = sap_basic_start_date - interval '1 day'"
                        " WHERE id = ANY(%s)", (ids,))
            conn.commit()
        res = {}

        def run(name, fn):
            try:
                res[name] = fn()
            except Exception as exc:  # noqa: BLE001
                res[name] = exc

        holder = pg._pool.connection()
        hconn = holder.__enter__()
        hcur = hconn.cursor()
        hcur.execute("SELECT id FROM orders WHERE id = %s FOR UPDATE", (first,))
        try:
            with mock.patch.object(pg, "_UPSERT_CHUNK", 1):
                ti = threading.Thread(target=run, daemon=True, args=(
                    "ingest", lambda: self._upload(pg, [self._parent(self.MAT)])))
                ti.start()
                assert _wait_for_lock_wait(pg, 10.0), "ingest never blocked on the held earlier row"
                try:
                    # the save-like writer's second lock: must not collide with the ingest
                    hcur.execute("SELECT id FROM orders WHERE id = %s FOR UPDATE", (last,))
                    res["holder"] = "ok"
                except Exception as exc:  # noqa: BLE001
                    res["holder"] = exc
                hconn.rollback()
                ti.join(40)
        finally:
            hconn.rollback()
            holder.__exit__(None, None, None)
        assert not ti.is_alive()
        for name in ("holder", "ingest"):
            assert not isinstance(res[name], Exception), f"{name} raised {res[name]!r}"
        assert res["ingest"]["unchanged"] == 0


@pytest.mark.pg
class TestMutationHolesChildUpsertAndDelete(_ReweightFixtureBase):
    """Mutation-testing holes: D07 (ordinary upload clears a stale child link AND
    letter), D17 (superseded-child delete locks rows before touching overrides)
    and D33 (the IS DISTINCT FROM guard + scheduled-child mismatch flag of
    `_CHILD_UPSERT_SQL`, each arm exercised with ONLY that field changing)."""
    WC = "ZZTEST_WC_MUTHOLE"
    L1, L2 = "ZZTEST_L1_MUTHOLE", "ZZTEST_L2_MUTHOLE"
    ORD, MAT = "ZZTEST_ORD_MUTHOLE", "ZZTEST_MAT_MUTHOLE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self._seed_header(pg, self.WC, self.L1, self.L2, self.ORD, self.MAT)
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM setup_occurrence_override WHERE plant = %s AND machine IN (%s, %s)",
                        (self.PLANT, self.L1, self.L2))
            self._cleanup(cur, self.WC, self.L1, self.L2, self.ORD, self.MAT)
            conn.commit()

    _PARAM_COLS = (
        "id", "production_order", "material_number", "material_description", "machine", "plant",
        "basic_start_date", "basic_finish_date", "run_time", "color", "order_quantity", "form_size",
        "firming_indicator", "planned_order_initial_quantity", "reduced_quantity", "order_category",
        "order_type", "bom_alternative", "bom_usage", "labor_hours", "machine_hours", "no_of_fte",
        "parent_production_order", "distribution_letter",
        "sap_workcenter", "sap_production_version", "sap_basic_start_date", "sap_basic_finish_date",
        "original_start_received", "original_finish_received",
    )

    def _child(self, pg, machine):
        return next(c for c in _snapshot_children(pg, self.PLANT, self.ORD) if c["machine"] == machine)

    def _identical_params(self, cur, child_id):
        cur.execute(f"SELECT {', '.join(self._PARAM_COLS)}, upload_batch_id FROM orders WHERE id = %s",
                    (child_id,))
        row = cur.fetchone()
        params = dict(zip(self._PARAM_COLS, row[:-1], strict=True))
        params["batch_id"] = row[-1]
        return params

    # ---- D07 ---------------------------------------------------------------
    def test_ordinary_upload_clears_stale_parent_link_and_letter(self, pg):
        child = self._child(pg, self.L1)
        assert child["parent_production_order"] == self.ORD and child["distribution_letter"]
        row = {"production_order": child["production_order"], "material_number": self.MAT,
               "machine": self.L1, "plant": self.PLANT,
               "basic_start_date": dt.datetime(2026, 10, 1, 8), "basic_finish_date": dt.datetime(2026, 10, 1, 18),
               "order_quantity": 60.0, "run_time": 6.0}
        res = pg.upsert_orders([row], batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx")
        assert res["status"] == "ok"
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT parent_production_order, distribution_letter FROM orders WHERE id = %s",
                        (child["id"],))
            assert cur.fetchone() == (None, None)

    # ---- D33 ---------------------------------------------------------------
    def test_child_upsert_identical_params_is_a_noop(self, pg):
        child = self._child(pg, self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(distribution_data._CHILD_UPSERT_SQL, self._identical_params(cur, child["id"]))
            assert cur.rowcount == 0
            conn.rollback()

    @pytest.mark.parametrize("field,new_value", [
        ("parent_production_order", "ZZTEST_OTHER_PARENT"),
        ("distribution_letter", "Q"),
    ])
    def test_child_upsert_where_fires_on_link_or_letter_change_alone(self, pg, field, new_value):
        child = self._child(pg, self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            params = self._identical_params(cur, child["id"])
            params[field] = new_value
            cur.execute(distribution_data._CHILD_UPSERT_SQL, params)
            assert cur.rowcount == 1
            cur.execute(f"SELECT {field} FROM orders WHERE id = %s", (child["id"],))
            assert cur.fetchone()[0] == new_value
            conn.rollback()

    def test_child_upsert_where_fires_on_run_time_change_alone_and_flags_scheduled(self, pg):
        child = self._child(pg, self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s, run_time_source=NULL,"
                        " runtime_schedule_mismatch=FALSE WHERE id=%s",
                        (dt.datetime(2026, 10, 2, 8), dt.datetime(2026, 10, 2, 12), child["id"]))
            params = self._identical_params(cur, child["id"])
            params["run_time"] = float(child["run_time"]) + 2.0
            cur.execute(distribution_data._CHILD_UPSERT_SQL, params)
            assert cur.rowcount == 1
            cur.execute("SELECT run_time, runtime_schedule_mismatch FROM orders WHERE id=%s", (child["id"],))
            run_time, flag = cur.fetchone()
            assert float(run_time) == pytest.approx(float(child["run_time"]) + 2.0)
            assert flag is True
            conn.rollback()

    def test_child_upsert_run_time_change_on_unscheduled_child_does_not_flag(self, pg):
        child = self._child(pg, self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=NULL, scheduled_end=NULL, run_time_source=NULL,"
                        " runtime_schedule_mismatch=FALSE WHERE id=%s", (child["id"],))
            params = self._identical_params(cur, child["id"])
            params["run_time"] = float(child["run_time"]) + 2.0
            cur.execute(distribution_data._CHILD_UPSERT_SQL, params)
            assert cur.rowcount == 1
            cur.execute("SELECT runtime_schedule_mismatch FROM orders WHERE id=%s", (child["id"],))
            assert cur.fetchone()[0] is not True
            conn.rollback()

    def test_child_upsert_flags_segment_only_scheduled_child_on_run_time_change(self, pg):
        child = self._child(pg, self.L1)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=NULL, scheduled_end=NULL, run_time_source=NULL,"
                        " runtime_schedule_mismatch=FALSE WHERE id=%s", (child["id"],))
            cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                        " VALUES (%s, 1, %s, %s)",
                        (child["id"], dt.datetime(2026, 10, 2, 8), dt.datetime(2026, 10, 2, 12)))
            params = self._identical_params(cur, child["id"])
            params["run_time"] = float(child["run_time"]) + 2.0
            cur.execute(distribution_data._CHILD_UPSERT_SQL, params)
            assert cur.rowcount == 1
            cur.execute("SELECT scheduled_start, runtime_schedule_mismatch FROM orders WHERE id=%s",
                        (child["id"],))
            start, flag = cur.fetchone()
            assert start is None and flag is True
            conn.rollback()

    # ---- D17 ---------------------------------------------------------------
    def test_delete_superseded_children_locks_rows_before_touching_overrides(self, pg):
        import threading
        import psycopg
        c1, c2 = sorted(c["id"] for c in _snapshot_children(pg, self.PLANT, self.ORD))
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO setup_occurrence_override (plant, machine, signature_version, predecessor_order_id,"
                " successor_order_id, predecessor_state_key, successor_state_key, standard_min, remaining_min)"
                " VALUES (%s, %s, 1, %s, %s, '[]'::jsonb, '[]'::jsonb, 0, 0) RETURNING id",
                (self.PLANT, self.L1, c1, c2))
            override_id = cur.fetchone()[0]
            conn.commit()
        res = {}
        # Competing transaction: updated (so row-locked) one of the ids, still open.
        with pg._pool.connection() as holder, holder.cursor() as hcur:
            hcur.execute("UPDATE orders SET notes = 'held' WHERE id = %s", (c2,))

            def do_delete():
                try:
                    with pg._pool.connection() as conn, conn.cursor() as cur:
                        res["deleted"] = distribution_data._delete_superseded_children(cur, {c1, c2})
                        conn.commit()
                except Exception as exc:  # noqa: BLE001
                    res["deleted"] = exc

            t = threading.Thread(target=do_delete, daemon=True)
            t.start()
            try:
                assert _wait_for_lock_wait(pg, 10.0), "delete never blocked on the held row"
                # Locking happens BEFORE the override move: while the delete is parked on
                # the row lock, the override row must be untouched (not row-locked).
                with pg._pool.connection() as probe, probe.cursor() as pcur:
                    try:
                        pcur.execute("SELECT id FROM setup_occurrence_override WHERE id = %s FOR UPDATE NOWAIT",
                                     (override_id,))
                        assert pcur.fetchone() is not None
                    except psycopg.errors.LockNotAvailable:
                        pytest.fail("override was updated before the orders rows were locked")
                    finally:
                        probe.rollback()
            finally:
                holder.rollback()
                t.join(30)
        assert not t.is_alive()
        assert res["deleted"] == 2
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT status FROM setup_occurrence_override WHERE id = %s", (override_id,))
            assert cur.fetchone()[0] == "replaced"
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = ANY(%s)", ([c1, c2],))
            assert cur.fetchone()[0] == 0

def test_aggregate_csv_is_bom_prefixed_and_formula_guarded(monkeypatch):
    """Exporter wiring (plan Part 1 #8): the aggregate CSV applies csv_row to
    every data row and starts with the UTF-8 BOM. No DB needed -- the roll-up is stubbed."""
    import csv as _csv
    import io as _io
    rows = [{
        "production_order": "=1+1", "material_number": "+MAT", "machine": "-WC", "quantity": 10,
        "sum_child_quantity": 10, "start": "2026-10-01T08:00:00", "finish": None, "child_count": 1,
        "queued_children": 0, "all_scheduled": True, "firming_indicator": "@X", "reviewed": False,
        "children": [{"production_order": "A-1000", "machine": "L1", "quantity": 10, "start": None, "end": None}],
    }]
    monkeypatch.setattr(distribution_data, "get_aggregate", lambda plant, **kw: rows)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "reader@example.com"
    try:
        response = TestClient(brain.api).get("/distribution/ZZPLANT/aggregate", params={"format": "csv"})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    parsed = list(_csv.reader(_io.StringIO(response.content.decode("utf-8-sig"))))
    assert parsed[0][0] == "production_order"
    data = parsed[1]
    assert data[:3] == ["'=1+1", "'+MAT", "'-WC"]
    assert data[10] == "'@X"
    assert data[3] == "10" and data[7] == "1"
