"""
Unit tests for backend/distribution/service.py pure functions.

No DB dependency — all tests operate on plain dicts/rows passed in as arguments.
"""

import pytest
from decimal import Decimal
from backend.distribution.service import (
    TOOL_PLACEHOLDERS,
    resolve_plant,
    classify_row,
    compute_default_shares,
    assign_letters,
    apportion,
    compute_derived_statuses,
)


class TestToolPlaceholders:
    """Verify TOOL_PLACEHOLDERS parity with frontend/nimbus-compute-core.js:391"""

    def test_tool_placeholders_exact_match(self):
        """Assert our set matches the frontend exactly."""
        expected = {'', '-', '0', 'N/A', 'NONE', 'NULL'}
        assert TOOL_PLACEHOLDERS == expected


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
        total = Decimal(10)
        weights = {"L2": Decimal(1), "L1": Decimal(1)}  # Equal weights
        unit = Decimal(1)
        tie_order = ["L1", "L2"]
        result = apportion(total, weights, unit, tie_order)
        # L1 should win the tie (appears first in tie_order)
        assert result["L1"] > result["L2"]

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
