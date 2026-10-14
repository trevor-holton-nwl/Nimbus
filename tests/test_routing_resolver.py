"""
Pure-function coverage for backend/routing/resolver.py (ROUTING_RUNTIME_DESIGN.md
§5), driven mostly by tests/modules/fixtures/routing_cases.json (§10's own list
of what this file owes: category selection, unit conversion, base-quantity
scaling, sequence/control-key/deleted/header-status filtering, production-
version validity, lot-size warning, every §5.2 failure step and its fallback,
the §5.4 worked examples, and minute rounding).

No database required -- these exercise `resolve_one` and its private helpers
directly over plain dict rows, never `resolve_orders` (the DB-touching
wrapper), so this file runs unconditionally, including when .env points at
the live Azure DB (same convention as tests/test_material_plant_attributes.py).
"""
import datetime as dt
import json
from decimal import Decimal
from pathlib import Path

import pytest

from backend.routing.resolver import (
    _build_ops_map,
    _new_report,
    _pick_operation_hours,
    _round_to_minute,
    _select_operations,
    _to_hours,
    _within_validity,
    check_eligibility,
    resolve_one,
    resolve_orders,
)

FIXTURE_PATH = Path(__file__).parent / "modules" / "fixtures" / "routing_cases.json"


def _load_cases() -> list[dict]:
    with open(FIXTURE_PATH, encoding="utf-8") as f:
        payload = json.load(f)
    return payload["cases"]


def _parse_date(value):
    if value is None:
        return None
    return dt.date.fromisoformat(value)


def _build_pv_lookup(rows: list[dict]) -> dict:
    return {(r["plant"], r["material_id"], r["production_version"]): dict(r, valid_from=_parse_date(r.get("valid_from")), valid_to=_parse_date(r.get("valid_to"))) for r in rows}


def _build_op_lookup(rows: list[dict]) -> dict:
    lookup: dict = {}
    for r in rows:
        key = (r["plant"], r["material_id"], r["task_list_type"], r["routing_group"], r["group_counter"])
        lookup.setdefault(key, []).append(r)
    return lookup


def _build_order(raw: dict) -> dict:
    order = dict(raw)
    order["basic_start_date"] = _parse_date(raw.get("basic_start_date"))
    return order


def _build_rules(raw: dict) -> dict:
    return {
        "control_key_exclude": frozenset(raw.get("control_key_exclude") or []),
        "header_status_include": frozenset(raw.get("header_status_include") or []),
    }


def _reported_step(result: dict) -> str | None:
    """Mirrors resolve_orders' own convention (resolver.py's
    `_resolve_orders_on_conn`): a held result's real step is `detail_step`
    when present (steps 2-8, via `_fallback`), otherwise `reason_code`
    (step 1, `pv_missing`, which skips the fallback chain entirely)."""
    return result.get("detail_step") or result.get("reason_code")


CASES = _load_cases()


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_resolve_one_fixture_case(case):
    order = _build_order(case["order"])
    pv_lookup = _build_pv_lookup(case["production_versions"])
    op_lookup = _build_op_lookup(case["operations"])
    machine_workcenter = dict(case["machine_workcenter"])
    rules = _build_rules(case.get("rules") or {})
    expected = case["expected"]

    result = resolve_one(
        order,
        pv_lookup=pv_lookup,
        op_lookup=op_lookup,
        machine_workcenter=machine_workcenter,
        rules=rules,
    )

    assert result["status"] == expected["status"], f"{case['name']}: status mismatch, got {result}"

    if expected["status"] == "held":
        assert _reported_step(result) == expected["reason_code"], f"{case['name']}: held step mismatch, got {result}"
        assert "run_time" not in result
        return

    # resolved / fallback_sap_order / fallback_legacy all carry run_time +
    # run_time_source; fallback_* also carry the failing step as reason_code.
    if "expected_minutes" in expected:
        expected_run_time = Decimal(expected["expected_minutes"]) / Decimal(60)
    else:
        expected_run_time = Decimal(str(expected["run_time"]))
    # A resolved outcome's run_time is always Decimal (§5.4's own formula);
    # a fallback outcome's run_time is whatever type the order row carried
    # (_fallback passes machine_hours/run_time straight through, unconverted)
    # -- so compare numeric value, not type, for the fallback_* branches.
    assert Decimal(str(result["run_time"])) == expected_run_time, f"{case['name']}: run_time mismatch, got {result['run_time']!r}"
    assert result["run_time_source"] == expected["run_time_source"]

    if expected["status"] != "resolved":
        assert result["reason_code"] == expected["reason_code"], f"{case['name']}: reason_code mismatch, got {result}"

    if "lot_size_warning" in expected:
        assert result.get("lot_size_warning", False) == expected["lot_size_warning"]


# ---------------------------------------------------------------------------
# Hand-written edge cases the fixture format doesn't cleanly express.
# ---------------------------------------------------------------------------
class TestPickOperationHoursEdgeCases:
    """§11 item... judgment call #2 in resolver.py's module docstring: a
    zero/missing base_quantity must skip that one operation, never raise."""

    def test_zero_base_quantity_skips_without_zero_division_error(self):
        op = {
            "workcenter_category": "0001",
            "std_value_machine": 2.0,
            "std_value_unit_machine": "H",
            "base_quantity": 0,
        }
        hours, skip_reason = _pick_operation_hours(op, 1000)
        assert hours is None
        assert skip_reason == "invalid_base_quantity"

    def test_missing_base_quantity_skips_without_raising(self):
        op = {
            "workcenter_category": "0001",
            "std_value_machine": 2.0,
            "std_value_unit_machine": "H",
            "base_quantity": None,
        }
        hours, skip_reason = _pick_operation_hours(op, 1000)
        assert hours is None
        assert skip_reason == "invalid_base_quantity"

    def test_none_order_quantity_treated_as_zero(self):
        op = {
            "workcenter_category": "0001",
            "std_value_machine": 2.0,
            "std_value_unit_machine": "H",
            "base_quantity": 1000,
        }
        hours, skip_reason = _pick_operation_hours(op, None)
        assert skip_reason is None
        assert hours == Decimal(0)

    def test_category_neither_machine_nor_labor_is_skipped(self):
        op = {"workcenter_category": "9999", "base_quantity": 1000}
        hours, skip_reason = _pick_operation_hours(op, 1000)
        assert hours is None
        assert skip_reason == "other_category"


class TestToHoursEdgeCases:
    def test_none_value_returns_none(self):
        assert _to_hours(None, "H") is None

    def test_unparseable_value_returns_none(self):
        assert _to_hours("not-a-number", "H") is None

    def test_unit_matching_is_case_and_whitespace_insensitive(self):
        assert _to_hours(2, "  min  ") == Decimal(2) / Decimal(60)
        assert _to_hours(2, "hours") == Decimal(2)

    def test_missing_unit_is_not_a_time_unit(self):
        assert _to_hours(2, None) is None
        assert _to_hours(2, "") is None


class TestWithinValidityEdgeCases:
    def test_none_basic_start_date_is_treated_as_within_validity(self):
        assert _within_validity(None, dt.date(2026, 1, 1), dt.date(2026, 12, 31)) is True

    def test_both_bounds_none_is_always_within_validity(self):
        assert _within_validity(dt.date(1900, 1, 1), None, None) is True

    def test_datetime_basic_start_date_is_compared_by_date(self):
        start = dt.datetime(2026, 6, 15, 8, 30)
        assert _within_validity(start, dt.date(2026, 1, 1), dt.date(2026, 12, 31)) is True


class TestSelectOperationsEdgeCases:
    def test_empty_rules_include_every_header_status(self):
        ops = [{"deleted": False, "sequence_category": "0", "sap_workcenter": "WC1", "control_key": "PP01", "header_status": "ANYTHING"}]
        selected = _select_operations(ops, "WC1", {})
        assert selected == ops

    def test_op_at_a_different_workcenter_is_excluded(self):
        ops = [{"deleted": False, "sequence_category": "0", "sap_workcenter": "WC2", "control_key": "PP01", "header_status": "REL"}]
        assert _select_operations(ops, "WC1", {}) == []


class TestRoundToMinute:
    def test_exact_hour_stays_exact(self):
        assert _round_to_minute(Decimal("2")) == Decimal("2")

    def test_rounds_half_up_to_nearest_minute(self):
        # 1.01h * 60 = 60.6 minutes -> rounds up to 61 minutes.
        assert _round_to_minute(Decimal("1.01")) == Decimal(61) / Decimal(60)


class TestRateMapParity:
    """§8.1 parity smoke check: `build_rate_map`'s `ops[...].minutes_per_unit`
    (via `_build_ops_map`), fed back through the client's own documented
    formula (`minutes_per_unit * order_quantity / 60`, rounded to the
    nearest minute per §5.4), must reproduce EXACTLY what `resolve_one`
    computes as `run_time` for a real order at that routing key/work
    center -- the parity claim `_build_ops_map`'s own docstring makes.
    Covers every `status: resolved` case in the shared fixture file."""

    _RESOLVED_CASES = [c for c in CASES if c["expected"]["status"] == "resolved"]

    @pytest.mark.parametrize("case", _RESOLVED_CASES, ids=[c["name"] for c in _RESOLVED_CASES])
    def test_ops_map_minutes_per_unit_reproduces_resolve_one_run_time(self, case):
        order = _build_order(case["order"])
        pv_lookup = _build_pv_lookup(case["production_versions"])
        op_lookup = _build_op_lookup(case["operations"])
        machine_workcenter = dict(case["machine_workcenter"])
        rules = _build_rules(case.get("rules") or {})

        actual = resolve_one(order, pv_lookup=pv_lookup, op_lookup=op_lookup,
                             machine_workcenter=machine_workcenter, rules=rules)
        assert actual["status"] == "resolved", f"{case['name']}: expected a resolved outcome, got {actual}"

        pv_row = pv_lookup[(order["plant"], order["material_number"], order["production_version"])]
        workcenter = machine_workcenter[order["machine"]]
        routing_key = (f"{order['material_number']}|{pv_row['task_list_type']}|"
                       f"{pv_row['routing_group']}|{pv_row['group_counter']}|{workcenter}")

        ops_map = _build_ops_map(op_lookup, rules)
        assert routing_key in ops_map, f"{case['name']}: ops map is missing key {routing_key!r}"

        minutes_per_unit = Decimal(str(ops_map[routing_key]["minutes_per_unit"]))
        quantity = Decimal(str(order["order_quantity"]))
        # The client's own documented formula (§8.1): hours = minutes_per_unit
        # * order_quantity / 60, rounded to the nearest minute (§5.4).
        computed_run_time = _round_to_minute(minutes_per_unit * quantity / Decimal(60))

        assert computed_run_time == Decimal(str(actual["run_time"])), (
            f"{case['name']}: rate-map parity mismatch -- ops map gives "
            f"{computed_run_time}, resolve_one gave {actual['run_time']}"
        )


# ---------------------------------------------------------------------------
# §8.5 check_eligibility -- the same fixture cases, driven through a fake
# conn/cursor standing in for the four plant-reference-data SELECTs
# check_eligibility's loaders issue (_load_pv_lookup/_load_op_lookup/
# _load_machine_workcenter/_load_rules), dispatched by a substring of the
# SQL text -- same fake-cursor convention as
# tests/test_task_response_models.py's _FakeSegmentCursor.
# ---------------------------------------------------------------------------
class _FakeEligibilityCursor:
    _PV_COLS = ["plant", "material_id", "production_version", "valid_from", "valid_to",
                "task_list_type", "routing_group", "group_counter", "sap_workcenter",
                "lot_size_from", "lot_size_to"]
    _OP_COLS = ["plant", "material_id", "task_list_type", "routing_group", "group_counter",
                "sequence_no", "activity", "sap_workcenter", "workcenter_category", "base_quantity",
                "control_key", "header_status", "deleted", "sequence_category",
                "activity_type_machine", "std_value_machine", "std_value_unit_machine",
                "activity_type_labor", "std_value_labor", "std_value_unit_labor"]

    def __init__(self, case):
        self.case = case
        self._pending = None
        self._pending_cols = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        if "FROM production_version" in sql:
            rows = []
            for r in self.case["production_versions"]:
                row = tuple(
                    _parse_date(r.get(c)) if c in ("valid_from", "valid_to") else r.get(c)
                    for c in self._PV_COLS
                )
                rows.append(row)
            self._pending, self._pending_cols = rows, self._PV_COLS
        elif "FROM routing_operation" in sql:
            rows = [tuple(r.get(c) for c in self._OP_COLS) for r in self.case["operations"]]
            self._pending, self._pending_cols = rows, self._OP_COLS
        elif "FROM machine WHERE" in sql:
            self._pending, self._pending_cols = list(self.case["machine_workcenter"].items()), None
        elif "FROM routing_rules" in sql:
            rules = self.case.get("rules") or {}
            rows = [("control_key", code, "exclude") for code in rules.get("control_key_exclude") or []]
            rows += [("header_status", code, "include") for code in rules.get("header_status_include") or []]
            self._pending, self._pending_cols = rows, None
        else:
            raise AssertionError(f"unexpected SQL in _FakeEligibilityCursor: {sql!r}")

    @property
    def description(self):
        if self._pending_cols is None:
            return None
        return [(c,) for c in self._pending_cols]

    def fetchall(self):
        return self._pending


class _FakeEligibilityConnection:
    def __init__(self, case):
        self.case = case

    def cursor(self):
        return _FakeEligibilityCursor(self.case)


# A deliberate mix: a resolved case, and one failing case per distinct §5.2
# step -- including two (pv_not_found, workcenter_unmapped) that resolve_one
# itself would rescue via the order-file/legacy fallback chain. check_eligibility
# has NO fallback chain of its own (a hypothetical candidate has no order-file
# machine-hours value or existing run_time to fall back to), so for every one
# of these it must report {"ok": False, "step": <the same step resolve_one's
# fixture case names as its own reason_code>} -- proving the two callers never
# drift on what "eligible" means.
_ELIGIBILITY_CASE_NAMES = [
    "category_0001_uses_machine_value",
    "sequence_filtering_excludes_non_standard_sequence",
    "pv_missing_holds_regardless_of_available_fallback_data",
    "pv_not_found_falls_to_sap_order_fallback",
    "pv_expired_before_valid_from_falls_to_sap_order_fallback",
    "workcenter_unmapped_falls_to_sap_order_fallback",
    "no_routing_no_fallback_data_holds",
    "zero_runtime_falls_to_sap_order_fallback",
]
_ELIGIBILITY_CASES = {c["name"]: c for c in CASES if c["name"] in _ELIGIBILITY_CASE_NAMES}
assert set(_ELIGIBILITY_CASES) == set(_ELIGIBILITY_CASE_NAMES), "a named fixture case was renamed/removed"


@pytest.mark.parametrize("name", _ELIGIBILITY_CASE_NAMES)
def test_check_eligibility_matches_resolve_one_step_vocabulary(name):
    case = _ELIGIBILITY_CASES[name]
    order = case["order"]
    conn = _FakeEligibilityConnection(case)

    result = check_eligibility(
        order["plant"], order["material_number"], order["production_version"],
        order["machine"], order["order_quantity"], _parse_date(order.get("basic_start_date")),
        conn=conn,
    )

    expected = case["expected"]
    if expected["status"] == "resolved":
        assert result["ok"] is True
        assert result["hours"] == pytest.approx(expected["run_time"])
        assert result["basis"]["production_version"] == order["production_version"]
    else:
        assert result == {"ok": False, "step": expected["reason_code"]}, (
            f"{name}: check_eligibility must report the same step resolve_one "
            f"failed/fell back on, got {result}"
        )


def test_check_eligibility_reuses_the_caller_supplied_conn_without_opening_a_new_one():
    """§8.5: given a conn, check_eligibility must read within THAT connection
    -- never open its own pooled connection mid-write. Passing a bare fake
    object with only a `.cursor()` method (no `_pool`-style connection
    machinery at all) proves no second connection is opened."""
    case = _ELIGIBILITY_CASES["category_0001_uses_machine_value"]
    order = case["order"]
    conn = _FakeEligibilityConnection(case)

    result = check_eligibility(
        order["plant"], order["material_number"], order["production_version"],
        order["machine"], order["order_quantity"], _parse_date(order.get("basic_start_date")),
        conn=conn,
    )
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# resolve_orders' plants.routing_runtime_enabled gate -- the bug this task
# fixes. No live Postgres is reachable in this environment (see
# tests/test_orders_routing_ingest.py's module docstring for why), so this
# mirrors that file's own convention: a fake cursor/connection that dispatches
# on a stable substring of each statement instead of executing real SQL.
# ---------------------------------------------------------------------------
class _FakeResolverCursor:
    """Handles only what these gate tests need: the new
    `routing_runtime_enabled` gate query, the is_cutover EXISTS check, and
    `_load_orders`' SELECT (kept empty in every test below, so there's never
    a need to also fake pv/op/machine/rules data or the write-side
    UPDATE ... FROM (VALUES ...) statements -- a disabled plant must never
    reach any of those, and an enabled plant with zero in-scope orders
    returns before reaching them either, per `_resolve_orders_on_conn`'s own
    `if not orders: return report` short-circuit)."""

    def __init__(self, *, routing_enabled, orders=()):
        self.routing_enabled = routing_enabled
        self.orders = list(orders)
        self.executed: list[tuple[str, object]] = []
        self._one = None
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement, params=None):
        stmt = str(statement)
        self.executed.append((stmt, params))
        if "SELECT routing_runtime_enabled FROM plants" in stmt:
            self._one = None if self.routing_enabled is None else (self.routing_enabled,)
            self._rows = []
        elif "SELECT EXISTS(SELECT 1 FROM orders" in stmt:
            # No order in this plant has run_time_source = 'routing' yet ->
            # is_cutover = True, same as every real (never-adopted) plant
            # today -- this is exactly the condition that made the original
            # bug dangerous.
            self._one = (False,)
            self._rows = []
        else:
            # _load_orders' own SELECT (the only other query reached in
            # these tests, since `orders` stays empty throughout).
            self._one = None
            self._rows = self.orders

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._rows

    @property
    def description(self):
        return [("id",)]


class _FakeResolverConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class TestResolveOrdersRoutingRuntimeGate:
    """Restates the bug as an assertion: a plant whose
    `routing_runtime_enabled` switch is off (every real plant today) must be
    a clean no-op for `resolve_orders` -- no read past the gate, no write, no
    hold/rewrite of any scheduled order. Before this gate existed,
    `_resolve_orders_on_conn` computed `is_cutover = True` for every disabled
    plant (no order there has `run_time_source = 'routing'` yet), and
    `_load_orders`' cutover clause pulled in every currently-scheduled order
    in the plant, which `resolve_one` then mostly held on `pv_missing` --
    clearing `scheduled_start`/`scheduled_end` for the whole book on an
    ordinary order upload."""

    def test_disabled_plant_is_a_clean_noop(self):
        cursor = _FakeResolverCursor(routing_enabled=False)
        conn = _FakeResolverConnection(cursor)

        report = resolve_orders("D1", conn=conn)

        assert report == _new_report(is_cutover=False)
        assert len(cursor.executed) == 1, (
            "must return immediately after the gate check -- no is_cutover "
            "EXISTS query, no _load_orders, no write"
        )
        stmt, params = cursor.executed[0]
        assert "routing_runtime_enabled" in stmt
        assert params == ("D1",)

    def test_plant_missing_from_plants_table_is_also_a_clean_noop(self):
        """A plant with no row in `plants` at all reads as disabled -- same
        posture as db.py's own LEFT JOIN read ("Missing plants row (shouldn't
        happen) reads as disabled")."""
        cursor = _FakeResolverCursor(routing_enabled=None)
        conn = _FakeResolverConnection(cursor)

        report = resolve_orders("GHOST", conn=conn)

        assert report == _new_report(is_cutover=False)
        assert len(cursor.executed) == 1

    def test_enabled_plant_still_resolves_normally(self):
        """No regression: an enabled plant still proceeds past the gate to
        the is_cutover check and `_load_orders`, exactly as before this gate
        was added (zero in-scope orders here just keeps the fake cursor
        simple -- see the class docstring)."""
        cursor = _FakeResolverCursor(routing_enabled=True, orders=[])
        conn = _FakeResolverConnection(cursor)

        report = resolve_orders("E1", conn=conn)

        assert len(cursor.executed) == 3, (
            "gate query + is_cutover EXISTS + _load_orders -- proceeds past "
            "the gate instead of no-op'ing"
        )
        assert "routing_runtime_enabled" in cursor.executed[0][0]
        assert "EXISTS" in cursor.executed[1][0]
        assert "FROM orders" in cursor.executed[2][0]
        assert report == _new_report(is_cutover=True)


class TestWriteChunkingAndPendingHold:
    def test_outcome_and_hold_writes_chunk_at_5000_rows_per_statement(self):
        from backend.routing import resolver as r

        class Cur:
            def __init__(self):
                self.calls = []

            def execute(self, query, params):
                self.calls.append((query, params))

        cur = Cur()
        r._write_outcomes(cur, [(f"o{i}", 1, "routing", "{}", False, False) for i in range(12001)])
        assert [len(p) // 6 for _, p in cur.calls] == [5000, 5000, 2001]
        cur = Cur()
        r._write_holds(cur, [(f"o{i}", "{}") for i in range(10001)])
        assert [len(p) // 2 for q, p in cur.calls if q.startswith(("UPDATE", "WITH"))] == [5000, 5000, 1]
        cur = Cur()
        r._write_outcomes(cur, [])
        r._write_holds(cur, [])
        assert cur.calls == []

    def test_runtime_pending_counts_as_a_routing_hold(self):
        from backend.routing.resolver import _is_routing_hold

        assert _is_routing_hold({"code": "runtime_pending", "message": "x"})
        assert not _is_routing_hold({"code": "something_else"})


def test_check_eligibility_cache_loads_plant_lookups_once_per_call_scope():
    """Plan Part 2 #23 (P7): a caller-owned cache memoises the four per-plant
    lookups, so N edits on one plant cost one load, not N."""
    case = _ELIGIBILITY_CASES["category_0001_uses_machine_value"]
    order = case["order"]
    conn = _FakeEligibilityConnection(case)
    opened = []
    real_cursor = conn.cursor
    conn.cursor = lambda: (opened.append(1), real_cursor())[1]
    cache: dict = {}
    args = (order["plant"], order["material_number"], order["production_version"],
            order["machine"], order["order_quantity"], _parse_date(order.get("basic_start_date")))
    first = check_eligibility(*args, conn=conn, cache=cache)
    second = check_eligibility(*args, conn=conn, cache=cache)
    assert first == second and first["ok"] is True
    assert len(opened) == 1
    check_eligibility(*args, conn=conn)          # no cache -> loads again
    assert len(opened) == 2


# ---------------------------------------------------------------------------
# Run-time cap (OQ28): a recomputed run time over the plant's cap is queued with reason
# run_time_over_cap through the same hold writer routing holds use; a run time within the cap
# releases a previous over-cap hold. Driven through _resolve_orders_on_conn with the loaders and
# writers stubbed (no database), like the gate tests above.
# ---------------------------------------------------------------------------
class _CapCursor:
    def __init__(self, horizon_days):
        self.horizon_days = horizon_days
        self._one = None

    def execute(self, statement, params=None):
        stmt = str(statement)
        if "SELECT routing_runtime_enabled FROM plants" in stmt:
            self._one = (True,)
        elif "SELECT EXISTS(SELECT 1 FROM orders" in stmt:
            self._one = (True,)
        elif "SELECT visibility_horizon_days FROM plants" in stmt:
            self._one = (self.horizon_days,)
        else:
            self._one = None

    def fetchone(self):
        return self._one

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _CapConn:
    def __init__(self, horizon_days=None):
        self.cursor_obj = _CapCursor(horizon_days)

    def cursor(self):
        return self.cursor_obj


def _run_cap_resolve(monkeypatch, orders, results, horizon_days=None):
    from backend.routing import resolver as r

    writes: list = []
    holds: list = []
    monkeypatch.setattr(r, "_load_orders", lambda *a, **k: orders)
    for loader in ("_load_pv_lookup", "_load_op_lookup", "_load_machine_workcenter", "_load_rules"):
        monkeypatch.setattr(r, loader, lambda *a, **k: {})
    monkeypatch.setattr(r, "resolve_one", lambda order, **k: results[order["id"]])
    monkeypatch.setattr(r, "_running_ids", lambda *a, **k: set())
    monkeypatch.setattr(r, "_write_outcomes", lambda cur, rows: writes.extend(rows))
    monkeypatch.setattr(r, "_write_holds", lambda cur, rows: holds.extend(rows))
    report = r._resolve_orders_on_conn("P1", _CapConn(horizon_days))
    return report, writes, holds


def _resolved(hours):
    return {"status": "resolved", "run_time": hours, "run_time_source": "routing",
            "run_time_basis": {"unit": "h"}}


class TestRunTimeCap:
    ORDER = {"id": "o1", "planning_status": "scheduled", "planning_reason": None,
             "scheduled_start": None, "scheduled_end": None, "run_time_source": "routing"}

    def test_recomputed_run_time_over_the_cap_is_held_with_the_over_cap_reason(self, monkeypatch):
        report, writes, holds = _run_cap_resolve(monkeypatch, [dict(self.ORDER)], {"o1": _resolved(400.0)})
        assert report["over_cap"] == 1
        assert [h[0] for h in holds] == ["o1"]
        reason = holds[0][1].obj
        assert reason["code"] == "run_time_over_cap" and "400" in reason["message"] and reason["cap_hours"] == 336.0
        # The computed run time is still stored (the order keeps its number), but never releases a hold.
        assert len(writes) == 1 and writes[0][1] == 400.0 and writes[0][4] is False

    def test_run_time_within_the_cap_is_written_and_not_held(self, monkeypatch):
        report, writes, holds = _run_cap_resolve(monkeypatch, [dict(self.ORDER)], {"o1": _resolved(336.0)})
        assert holds == [] and "over_cap" not in report and len(writes) == 1

    def test_plant_visibility_horizon_lowers_the_cap(self, monkeypatch):
        _, _, holds = _run_cap_resolve(monkeypatch, [dict(self.ORDER)], {"o1": _resolved(200.0)}, horizon_days=5)
        assert holds and holds[0][1].obj["cap_hours"] == 120.0

    def test_run_time_past_the_representation_bound_is_held_without_writing_the_number(self, monkeypatch):
        _, writes, holds = _run_cap_resolve(monkeypatch, [dict(self.ORDER)], {"o1": _resolved(9000.0)})
        assert writes == [] and len(holds) == 1

    def test_an_over_cap_hold_is_released_when_the_run_time_comes_back_within_the_cap(self, monkeypatch):
        held = dict(self.ORDER, planning_status="needs_planning",
                    planning_reason={"code": "run_time_over_cap", "message": "x"})
        _, writes, holds = _run_cap_resolve(monkeypatch, [held], {"o1": _resolved(100.0)})
        assert holds == [] and len(writes) == 1 and writes[0][4] is True    # release_hold

    def test_another_subsystems_hold_is_not_overwritten(self, monkeypatch):
        held = dict(self.ORDER, planning_status="needs_planning",
                    planning_reason={"code": "planner_unscheduled", "message": "x"})
        report, _, holds = _run_cap_resolve(monkeypatch, [held], {"o1": _resolved(400.0)})
        assert holds == [] and "over_cap" not in report


# ---------------------------------------------------------------------------
# Backward scheduling OQ26: production-version validity is judged on the SAP start as FIRST received (the
# locked `original_start_received`), never on `basic_start_date`, which an echo of NIMBUS's own send can move.
# ---------------------------------------------------------------------------
class TestValidityIsJudgedOnTheLockedSapStart:
    PV = {("P", "M", "0001"): {"valid_from": dt.date(2026, 1, 1), "valid_to": dt.date(2026, 12, 31)}}

    def _step(self, **dates):
        from backend.routing.resolver import _resolve_steps
        order = {"plant": "P", "material_number": "M", "production_version": "0001", **dates}   # no machine
        result = _resolve_steps(order, pv_lookup=self.PV, op_lookup={}, machine_workcenter={}, rules={})
        return result["step"]

    def test_an_echo_that_moves_basic_start_date_does_not_change_validity(self):
        inside, outside = dt.datetime(2026, 6, 1, 8), dt.datetime(2027, 3, 1, 8)
        assert self._step(original_start_received=inside, basic_start_date=outside) == "no_machine"   # still valid
        assert self._step(original_start_received=outside, basic_start_date=inside) == "pv_expired"

    def test_a_row_without_the_locked_start_falls_back_to_basic_start_date(self):
        assert self._step(basic_start_date=dt.datetime(2026, 6, 1, 8)) == "no_machine"
        assert self._step(basic_start_date=dt.datetime(2027, 3, 1, 8)) == "pv_expired"

    def test_check_eligibility_judges_the_start_it_is_given_as_the_locked_start(self):
        case = _ELIGIBILITY_CASES["pv_expired_before_valid_from_falls_to_sap_order_fallback"]
        order = case["order"]
        pv = case["production_versions"][0]
        inside = _parse_date(pv["valid_from"]) + dt.timedelta(days=1)
        result = check_eligibility(order["plant"], order["material_number"], order["production_version"],
                                   order["machine"], order["order_quantity"], inside,
                                   conn=_FakeEligibilityConnection(case))
        assert result.get("step") != "pv_expired"

    def test_the_order_loaders_select_the_locked_start(self):
        from backend.routing.resolver import _load_orders

        class Cur:
            def __init__(self): self.sql = []
            description = [("id",)]
            def execute(self, sql, params=None): self.sql.append(sql)
            def fetchall(self): return []

        for kwargs in ({"full": True}, {}):
            cur = Cur()
            _load_orders(cur, "P", False, **kwargs)
            assert "original_start_received" in cur.sql[0]
