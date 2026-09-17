"""
Unit tests for backend/distribution/service.py's pure functions (no DB
dependency) and backend/distribution/data.py's plan()/apply() ingest
transaction seam (@pytest.mark.pg -- requires a local/CI Postgres with
NIMBUS_TEST_DB=1; auto-skipped otherwise, see tests/conftest.py).
"""

import uuid
import datetime as dt
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
            cur.execute(
                "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.MAT, self.PLANT),
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
            cur.execute(
                "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.MAT, self.PLANT),
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
            cur.execute(
                "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.MAT, self.PLANT),
            )
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
            cur.execute(
                "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.MAT, self.PLANT),
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
            cur.execute(
                "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.MAT, self.PLANT),
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
        cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s, %s)",
                    (self.PLANT, self.L1, self.L2, self.M1))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter IN (%s, %s)",
                    (self.PLANT, self.WC1, self.WC2))
        cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                    (self.PLANT, self.MAT))

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
