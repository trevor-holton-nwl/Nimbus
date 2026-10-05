"""
Regression guard for Phase 4's response_model= additions (docs/archive/typescript_migration.md).

FastAPI's response_model serializes the return value THROUGH the Pydantic model —
any dict key the handler returns that isn't declared on the model is silently
dropped (not an error). A typo'd or forgotten field name is invisible to
`npm run typecheck` (that's the frontend) and to a naive "does it 200" test.
This test builds a synthetic dict with the EXACT key set get_tasks's `data.append({...})`
literal produces (brain.py), constructs a TaskDTO from it, and asserts the
round-tripped key set is unchanged — so a field silently dropped by the model
fails this test immediately, without needing a live database.
"""
import os
from contextlib import contextmanager
from datetime import datetime

import pytest
from psycopg import errors as pg_errors

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import brain  # noqa: E402
import backend.routing.resolver as routing_resolver  # noqa: E402
from backend.scheduling import routes as scheduling_routes  # noqa: E402


SAMPLE_TASK_ROW = {
    "id": "abc123",
    "text": "Order abc123",
    "start_date": "2026-08-01T07:00:00",
    "end_date": "2026-08-01T15:00:00",
    "original_start_date": "2026-08-01T07:00:00",
    "original_end_date": "2026-08-01T15:00:00",
    "user_scheduled": False,
    "MACHINE": "Line 1",
    "MATERIAL_DESCRIPTION": "Widget",
    "MATERIAL_NUMBER": "MAT-1",
    "ORDER_QUANTITY_(GMEIN)": 500.0,
    "COLOR": "WHITE",
    "PRT_01": "MOLD-A",
    "PRT_02": "MOLD-B",
    "PRODUCTION_VERSION": "0001",
    "PLANT": "5512",
    "ORDER": "ORD-1",
    "ORDER_Y": 1.0,
    "RUN_TIME": 2.5,
    "FORM_SIZE": "MD",
    "notes": None,
    "ecc_firmed": False,
    "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)": 1000.0,
    "REDUCED_QUANTITY_(GMEIN)": 50.0,
    "ORDER_CATEGORY": "PP01",
    "ORDER_TYPE": "ZP01",
    "BOM_ALTERNATIVE": 1,
    "BOM_USAGE": 1,
    "LABOR_HOURS_(MEINH)": 2.0,
    "MACHINE_HOURS_(MEINH)": 1.5,
    "NO_OF_FTE_(MEINH)": 1.0,
    "PARENT_ORDER": None,
    "DISTRIBUTION_LETTER": None,
    "row_version": 42,
    "schedule_segments": [
        {"sequence": 1, "start_date": "2026-08-01T07:00:00", "end_date": "2026-08-01T15:00:00"},
        {"sequence": 2, "start_date": "2026-08-02T07:00:00", "end_date": "2026-08-02T09:00:00"},
    ],
    "runtime_schedule_mismatch": False,
    "planning_status": "scheduled",
    "planning_reason": None,
    "run_time_source": "routing",
    "run_time_basis": {"production_version": "0001", "hours": 5.9},
}


def test_task_dto_round_trips_every_field_get_tasks_emits():
    dto = brain.TaskDTO(**SAMPLE_TASK_ROW)
    out = dto.model_dump(by_alias=True)
    assert set(out.keys()) == set(SAMPLE_TASK_ROW.keys()), (
        "TaskDTO's declared fields no longer match get_tasks's dict literal — "
        "a field was renamed/dropped on one side only. Diff: "
        f"missing={set(SAMPLE_TASK_ROW) - set(out)}, extra={set(out) - set(SAMPLE_TASK_ROW)}"
    )
    assert out == SAMPLE_TASK_ROW


def test_bulk_update_result_round_trips_db_shape():
    sample = {
        "status": "ok", "updated": 3, "persisted": 3, "failed": 0, "invalid": 0,
        "not_found": 0, "invalid_ids": [], "not_found_ids": [], "stale": [],
        "versions": {"abc123": 43}, "conflicts": [], "error_code": None, "cause": None,
        # ROUTING_RUNTIME_DESIGN.md §8.5: purely additive sparse {id: reason}
        # map, populated only for the routing-eligibility invalid_ids rejection.
        "rejection_reasons": {},
    }
    out = brain.BulkUpdateResult(**sample).model_dump()
    assert out == sample


def test_task_attribute_updates_are_forwarded_to_the_bulk_db_writer(monkeypatch):
    captured = {}

    def fake_update(items, allowed_plants=None):
        captured["items"] = items
        return {
            "applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
            "not_found": 0, "invalid_ids": [], "not_found_ids": [],
            "stale": [], "versions": {"abc123": 43},
        }

    monkeypatch.setattr(brain.db, "update_task_dates_bulk", fake_update)
    result = brain._apply_task_date_updates([
        brain.TaskDateUpdate(
            id="abc123",
            PRT_01="MOLD-A",
            PRT_02="MOLD-B",
            PRODUCTION_VERSION="0001",
            base_version=42,
        )
    ])

    assert result["persisted"] == 1
    assert captured["items"] == [{
        "id": "abc123",
        "start": None,
        "end": None,
        "PRT_01": "MOLD-A",
        "PRT_02": "MOLD-B",
        "PRODUCTION_VERSION": "0001",
        "base_version": 42,
        "force": False,
    }]


def test_split_schedule_update_is_forwarded_as_an_explicit_aggregate(monkeypatch):
    captured = {}

    def fake_update(items, allowed_plants=None):
        captured["items"] = items
        return {
            "applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
            "not_found": 0, "invalid_ids": [], "not_found_ids": [],
            "stale": [], "versions": {"abc123": 43},
        }

    monkeypatch.setattr(brain.db, "update_task_dates_bulk", fake_update)
    result = brain._apply_task_date_updates([
        brain.TaskDateUpdate(
            id="abc123", RUN_TIME=10,
            schedule_segments=[
                {"sequence": 1, "start_date": "2026-08-01T07:00:00", "end_date": "2026-08-01T15:00:00"},
                {"sequence": 2, "start_date": "2026-08-02T07:00:00", "end_date": "2026-08-02T09:00:00"},
            ],
            base_version=42,
        )
    ])

    assert result["persisted"] == 1
    assert captured["items"] == [{
        "id": "abc123", "start": None, "end": None, "RUN_TIME": 10.0,
        "schedule_segments": [
            {"sequence": 1, "start": brain._to_pydt("2026-08-01T07:00:00"), "end": brain._to_pydt("2026-08-01T15:00:00")},
            {"sequence": 2, "start": brain._to_pydt("2026-08-02T07:00:00"), "end": brain._to_pydt("2026-08-02T09:00:00")},
        ],
        "base_version": 42, "force": False,
    }]


def test_segment_aggregate_rejects_out_of_order_or_overlapping_children():
    def at(value):
        return datetime.fromisoformat(value)

    assert brain.db._validate_schedule_segments([
        {"sequence": 1, "start": at("2026-08-01T07:00:00"), "end": at("2026-08-01T15:00:00")},
        {"sequence": 2, "start": at("2026-08-02T07:00:00"), "end": at("2026-08-02T09:00:00")},
    ], 10) is not None
    assert brain.db._validate_schedule_segments([
        {"sequence": 2, "start": at("2026-08-01T07:00:00"), "end": at("2026-08-01T15:00:00")},
        {"sequence": 1, "start": at("2026-08-02T07:00:00"), "end": at("2026-08-02T09:00:00")},
    ], 10) is None
    assert brain.db._validate_schedule_segments([
        {"sequence": 1, "start": at("2026-08-01T07:00:00"), "end": at("2026-08-01T15:00:00")},
        {"sequence": 2, "start": at("2026-08-01T14:30:00"), "end": at("2026-08-01T16:30:00")},
    ], 10) is None


class _FakeSegmentCursor:
    """Minimal stand-in for a psycopg cursor covering exactly the statements
    update_task_dates_bulk issues for a single-item, segments-only batch: the
    `FOR UPDATE OF o` eff-row SELECT, the B3 review-fix plants floor SELECT,
    and the per-row `UPDATE orders ... RETURNING`. Dispatches on a substring
    of the SQL text, mirroring test_master_data_setup_policy.py's fake-cursor
    approach (no live Postgres needed)."""

    def __init__(self, eff_rows, plant_rows):
        self.eff_rows = eff_rows
        self.plant_rows = plant_rows
        self.executed = []
        self._pending = None

    def execute(self, statement, params=None):
        sql = str(statement)
        self.executed.append((sql, params))
        if "FOR UPDATE OF o" in sql:
            self._pending = ("all", list(self.eff_rows))
        elif "FROM plants WHERE plant = ANY" in sql:
            self._pending = ("all", list(self.plant_rows))
        elif sql.strip().startswith("UPDATE orders SET") and "RETURNING" in sql:
            self._pending = ("one", (params[-1], 999))
        else:
            self._pending = ("all", [])

    def executemany(self, statement, seq):
        self.executed.append((str(statement), list(seq)))

    def fetchall(self):
        kind, value = self._pending
        return value if kind == "all" else [value]

    def fetchone(self):
        kind, value = self._pending
        return value if kind == "one" else (value[0] if value else None)


class _FakeSegmentPool:
    def __init__(self, cursor):
        self.cursor_value = cursor
        self.last_connection = None

    @contextmanager
    def connection(self):
        conn = _FakeSegmentConnection(self.cursor_value)
        self.last_connection = conn
        yield conn


class _FakeSegmentConnection:
    def __init__(self, cursor):
        self.cursor_value = cursor
        self.committed = False
        self.rolled_back = False

    @contextmanager
    def cursor(self):
        yield self.cursor_value

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def _eff_row(order_id, start, end, run_time, row_version, segment_count, plant, machine,
             planning_status="scheduled", reason_code=None, routing_runtime_enabled=False,
             parent_order=None, run_time_source=None, material_number=None,
             order_quantity=None, basic_start_date=None, production_version=None):
    """One row of update_task_dates_bulk's `FOR UPDATE OF o` eff-lookup SELECT,
    in its current 17-column order (id, eff_start, eff_end, run_time,
    row_version, segment_count, plant, machine, planning_status, reason_code,
    routing_runtime_enabled, parent_order, run_time_source, material_number,
    order_quantity, basic_start_date, production_version -- the last five
    added for ROUTING_RUNTIME_DESIGN.md §8.5's write-time eligibility gate).
    None of these tests exercise the routing-runtime feature itself, so
    routing_runtime_enabled defaults to False/disabled — matching today's
    unconditional pre-routing-runtime behavior — and reason_code defaults to
    None (not held for a routing reason). parent_order defaults to None (not
    a distribution sub-order) so these pre-existing tests, none of which
    exercise the MACHINE-edit lock, are unaffected by that guard. The five
    new §8.5 fields all default to None, inert whenever
    routing_runtime_enabled is False (the gate short-circuits before reading
    any of them)."""
    return (order_id, start, end, run_time, row_version, segment_count, plant, machine,
            planning_status, reason_code, routing_runtime_enabled, parent_order,
            run_time_source, material_number, order_quantity, basic_start_date,
            production_version)


def _segment_batch_item(order_id):
    """One order's schedule_segments aggregate: 40 min then (after a 20-min
    gap, so the pieces stay distinct instead of merging) 20 min — total 60
    min, matching the fake eff row's run_time of 1.0 hour. The 20-minute
    piece is what the hardcoded 30-minute default rejects and a
    plant-configured 15-minute floor accepts."""
    return {
        "id": order_id,
        "schedule_segments": [
            {"sequence": 1, "start": datetime(2026, 8, 17, 8, 0), "end": datetime(2026, 8, 17, 8, 40)},
            {"sequence": 2, "start": datetime(2026, 8, 17, 9, 0), "end": datetime(2026, 8, 17, 9, 20)},
        ],
    }


def test_update_task_dates_bulk_rejects_sub_default_segment_for_a_plant_with_no_override(monkeypatch):
    """B3 review fix (2026-08-21): existing behavior preserved — a plant that
    never configured plants.min_productive_segment_minutes still enforces the
    hardcoded 30-minute floor, so the 20-minute second piece is rejected."""
    eff_rows = [_eff_row("seg-default", None, None, 1.0, 100, 0, "PLANT-A", "L1")]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])  # PLANT-A has no plants-table override
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([_segment_batch_item("seg-default")])

    assert result["invalid_ids"] == ["seg-default"]
    assert result["persisted"] == 0
    assert any("FROM plants WHERE plant = ANY" in sql for sql, _ in cursor.executed), (
        "the plant-floor lookup must actually run, not just coincidentally fall back to 30"
    )
    # No regression: this rejection is NOT the routing-eligibility one, so it
    # must carry no entry in the new rejection_reasons map -- every other
    # invalid_ids cause in this loop stays exactly as it was (plain id, no
    # reason attached).
    assert result.get("rejection_reasons", {}) == {}


def test_update_task_dates_bulk_honors_a_plant_configured_productive_segment_floor(monkeypatch):
    """B3 review fix (2026-08-21): the backend mirror of the frontend
    placeWithSetup non-default-floor test — a plant configured with a
    15-minute floor accepts the same 20-minute segment the hardcoded
    30-minute default (proven above) rejects, proving the threading from
    plants.min_productive_segment_minutes through to
    _validate_schedule_segments actually reaches this code path."""
    eff_rows = [_eff_row("seg-override", None, None, 1.0, 100, 0, "PLANT-B", "L1")]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[("PLANT-B", 15)])
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([_segment_batch_item("seg-override")])

    assert result["invalid_ids"] == []
    assert result["persisted"] == 1
    assert result["versions"] == {"seg-override": 999}


class _FakeConflictCursor(_FakeSegmentCursor):
    """Adds the N3 conflict-scan SELECT (dispatched on 'o.machine = ANY(%s)')."""

    def __init__(self, eff_rows, plant_rows, conflict_rows):
        super().__init__(eff_rows, plant_rows)
        self.conflict_rows = conflict_rows

    def execute(self, statement, params=None):
        sql = str(statement)
        if "o.machine = ANY(%s)" in sql:
            self.executed.append((sql, params))
            self._pending = ("all", list(self.conflict_rows))   # same tuple shape _FakeSegmentCursor uses (:187-199)
            return
        super().execute(statement, params)


def test_update_task_dates_bulk_returns_advisory_conflicts_and_still_commits(monkeypatch):
    def t(h):
        return datetime(2026, 8, 17, h, 0)
    eff_rows = [_eff_row("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    conflict_rows = [("L1", "PLANT-A", "mv-a", [], t(8), t(10)), ("L1", "PLANT-A", "mv-b", [], t(9), t(11))]
    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([{"id": "mv-a", "start": t(8), "end": t(10)}])

    assert result["persisted"] == 1
    assert result["conflicts"] == [{"machine": "L1", "plant": "PLANT-A", "order_a": "mv-a",
                                     "order_b": "mv-b", "overlap_minutes": 60}]
    scan_sql, scan_params = next((s, p) for s, p in cursor.executed if "o.machine = ANY(%s)" in s)
    assert "o.plant = ANY(%s)" in scan_sql
    assert scan_params[0] == ["L1"]
    assert scan_params[1] == ["PLANT-A"]
    assert any("RELEASE SAVEPOINT conflict_scan" in s for s, _ in cursor.executed)


def test_update_task_dates_bulk_strict_conflicts_rolls_back_only_with_atomic_optimizer(monkeypatch):
    def t(h):
        return datetime(2026, 8, 17, h, 0)
    eff_rows = [_eff_row("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    conflict_rows = [("L1", "PLANT-A", "mv-a", [], t(8), t(10)), ("L1", "PLANT-A", "mv-b", [], t(9), t(11))]
    item = {"id": "mv-a", "start": t(8), "end": t(10), "base_version": 100}

    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))
    strict = brain.db.update_task_dates_bulk([item], atomic_optimizer=True, strict_conflicts=True)
    assert strict["status"] == "error"
    assert strict["error_code"] == "schedule.conflicts"
    assert strict["persisted"] == 0 and strict["versions"] == {}
    assert len(strict["conflicts"]) == 1

    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))
    manual = brain.db.update_task_dates_bulk([item], strict_conflicts=True)  # no atomic flag → advisory
    assert manual["persisted"] == 1
    assert len(manual["conflicts"]) == 1


class _FakeScanErrorCursor(_FakeSegmentCursor):
    """The N3 conflict-scan SELECT itself raises (malformed segment data, a
    stray SQL error, an unexpected datetime rendering, ...). The scan is an
    advisory diagnostic layered on an otherwise-valid save, so this must
    exercise the non-strict try/except path: log + treat as no conflicts,
    never roll back writes that already succeeded."""

    def execute(self, statement, params=None):
        sql = str(statement)
        if "o.machine = ANY(%s)" in sql:
            self.executed.append((sql, params))
            raise RuntimeError("conflict scan blew up")
        super().execute(statement, params)


def test_update_task_dates_bulk_advisory_scan_failure_does_not_block_a_valid_save(monkeypatch):
    def t(h):
        return datetime(2026, 8, 17, h, 0)
    eff_rows = [_eff_row("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    cursor = _FakeScanErrorCursor(eff_rows, plant_rows=[])
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([{"id": "mv-a", "start": t(8), "end": t(10)}])

    assert result["persisted"] == 1
    assert result["conflicts"] == []
    assert result.get("status") != "error"
    statements = [s for s, _ in cursor.executed]
    assert any("SAVEPOINT conflict_scan" in s and "RELEASE" not in s and "ROLLBACK" not in s
               for s in statements)
    assert any("ROLLBACK TO SAVEPOINT conflict_scan" in s for s in statements)
    assert not any("RELEASE SAVEPOINT" in s for s in statements)


def test_update_task_dates_bulk_strict_conflicts_scan_failure_propagates_and_rolls_back(monkeypatch):
    """Under strict mode the scan is expected to gate the commit, so a scan
    failure must propagate (never silently swallowed into 'no conflicts') and
    the whole transaction must roll back — never a COMMIT on a transaction the
    failed scan may have left aborted."""
    def t(h):
        return datetime(2026, 8, 17, h, 0)
    eff_rows = [_eff_row("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    cursor = _FakeScanErrorCursor(eff_rows, plant_rows=[])
    pool = _FakeSegmentPool(cursor)
    monkeypatch.setattr(brain.db, "_pool", pool)

    with pytest.raises(RuntimeError, match="conflict scan blew up"):
        brain.db.update_task_dates_bulk(
            [{"id": "mv-a", "start": t(8), "end": t(10), "base_version": 100}],
            atomic_optimizer=True, strict_conflicts=True,
        )

    assert pool.last_connection.rolled_back is True


# ---------------------------------------------------------------------------
# ROUTING_RUNTIME_DESIGN.md §8.5 -- update_task_dates_bulk's write-time
# eligibility gate + post-commit re-resolve trigger. These mock
# backend.routing.resolver.check_eligibility/resolve_orders directly (rather
# than faking the production_version/routing_operation/machine/routing_rules
# tables) -- resolve_one/check_eligibility's own step logic is already
# exhaustively covered by tests/test_routing_resolver.py; this file's job is
# only to prove update_task_dates_bulk wires the gate and the trigger
# correctly (right args, right id rejected, right plants re-resolved, right
# connection reused).
# ---------------------------------------------------------------------------
def _routing_eff_row(order_id, plant="PLANT-R", machine="M1", **overrides):
    kwargs = dict(
        start=None, end=None, run_time=2.0, row_version=100, segment_count=0,
        plant=plant, machine=machine, routing_runtime_enabled=True,
        run_time_source="routing", material_number="MAT1", order_quantity=1000,
        basic_start_date=datetime(2026, 6, 1), production_version="0001",
    )
    kwargs.update(overrides)
    return _eff_row(order_id, kwargs.pop("start"), kwargs.pop("end"), kwargs.pop("run_time"),
                     kwargs.pop("row_version"), kwargs.pop("segment_count"), kwargs.pop("plant"),
                     kwargs.pop("machine"), **kwargs)


@pytest.mark.parametrize("row", [
    _routing_eff_row("unchanged-child", routing_runtime_enabled=False, parent_order="PARENT"),
    _routing_eff_row("unchanged-routing"),
])
def test_full_browser_save_payload_accepts_unchanged_machine_and_runtime(monkeypatch, row):
    cursor = _FakeSegmentCursor([row], plant_rows=[])
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))
    monkeypatch.setattr(routing_resolver, "check_eligibility",
                        lambda *a, **k: pytest.fail("unchanged machine/version must not recheck eligibility"))
    monkeypatch.setattr(routing_resolver, "resolve_orders",
                        lambda *a, **k: pytest.fail("unchanged machine/version must not trigger resolve"))
    payload = brain.TaskDateUpdate.model_validate({
        "id": row[0], "start_date": "2026-06-02T08:00:00", "end_date": "2026-06-02T10:00:00",
        "planning_status": "scheduled", "planning_reason": None,
        "PRT_01": None, "PRT_02": None, "PRODUCTION_VERSION": "0001",
        "RUN_TIME": 2.0, "MACHINE": "M1", "schedule_segments": [],
        "base_version": 100, "force": False,
    })

    result = brain._apply_task_date_updates([payload])

    assert result["invalid_ids"] == []
    assert result["persisted"] == 1
    assert result["versions"] == {row[0]: 999}


def test_update_task_dates_bulk_rejects_an_ineligible_machine_change(monkeypatch):
    eff_rows = [_routing_eff_row("r-bad")]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])
    pool = _FakeSegmentPool(cursor)
    monkeypatch.setattr(brain.db, "_pool", pool)

    captured = {}

    def fake_check_eligibility(plant, material_number, production_version, machine,
                               order_quantity, basic_start_date, *, conn=None):
        captured["args"] = (plant, material_number, production_version, machine,
                            order_quantity, basic_start_date)
        captured["conn"] = conn
        return {"ok": False, "step": "no_operation_at_workcenter"}

    monkeypatch.setattr(routing_resolver, "check_eligibility", fake_check_eligibility)
    monkeypatch.setattr(routing_resolver, "resolve_orders",
                        lambda plant: pytest.fail("resolve_orders must not run for a rejected item"))

    result = brain.db.update_task_dates_bulk([{"id": "r-bad", "MACHINE": "M2"}])

    assert result["invalid_ids"] == ["r-bad"]
    assert result["persisted"] == 0
    assert captured["args"] == ("PLANT-R", "MAT1", "0001", "M2", 1000, datetime(2026, 6, 1))
    # The eligibility check must read within THIS function's own open
    # connection -- never a second, independently-opened one.
    assert captured["conn"] is pool.last_connection
    # Code-review fix: this specific rejection must carry WHY it was rejected
    # (§8.5) -- the fake check_eligibility above returns step
    # 'no_operation_at_workcenter', and that exact step must show up keyed by
    # this id in the new, purely-additive rejection_reasons map.
    assert result["rejection_reasons"] == {"r-bad": "no_operation_at_workcenter"}


def test_update_task_dates_bulk_accepts_an_eligible_machine_change_in_one_transaction(monkeypatch):
    eff_rows = [_routing_eff_row("r-good")]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])
    pool = _FakeSegmentPool(cursor)
    monkeypatch.setattr(brain.db, "_pool", pool)

    monkeypatch.setattr(routing_resolver, "check_eligibility",
                        lambda *a, **k: {"ok": True, "hours": 3.0, "basis": {}})
    resolved_plants = []
    monkeypatch.setattr(routing_resolver, "resolve_orders", resolved_plants.append)

    result = brain.db.update_task_dates_bulk([{"id": "r-good", "MACHINE": "M2", "base_version": 100}])

    assert result["invalid_ids"] == []
    assert result["persisted"] == 1
    assert resolved_plants == []  # runtime/basis are written with the original schedule/version
    # The connection passed to check_eligibility must be the SAME connection
    # this function's own write transaction used -- proven by the fact the
    # (mocked) call above never needed a second pooled connection to succeed;
    # pool.last_connection is the one and only connection this whole call opened.
    assert pool.last_connection.committed is True


def test_update_task_dates_bulk_never_gates_a_disabled_plant(monkeypatch):
    eff_rows = [_routing_eff_row("r-disabled", routing_runtime_enabled=False)]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    monkeypatch.setattr(routing_resolver, "check_eligibility",
                        lambda *a, **k: pytest.fail("check_eligibility must not run on a disabled plant"))
    monkeypatch.setattr(routing_resolver, "resolve_orders",
                        lambda plant: pytest.fail("resolve_orders must not run on a disabled plant"))

    result = brain.db.update_task_dates_bulk([{"id": "r-disabled", "MACHINE": "M2"}])

    assert result["invalid_ids"] == []
    assert result["persisted"] == 1


def test_update_task_dates_bulk_never_gates_a_non_routing_sourced_order(monkeypatch):
    eff_rows = [_routing_eff_row("r-manual", run_time_source="manual", run_time=5.0)]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    monkeypatch.setattr(routing_resolver, "check_eligibility",
                        lambda *a, **k: pytest.fail("check_eligibility must not run for a manual run_time_source"))
    monkeypatch.setattr(routing_resolver, "resolve_orders", lambda plant: None)

    result = brain.db.update_task_dates_bulk([{"id": "r-manual", "MACHINE": "M2"}])

    assert result["invalid_ids"] == []
    assert result["persisted"] == 1


def test_openapi_schema_includes_new_components():
    schema = brain.api.openapi()
    names = set(schema.get("components", {}).get("schemas", {}).keys())
    for expected in ("TasksResponse", "TaskDTO", "LinkDTO", "TaskUpdateResult",
                     "BulkUpdateResult", "TasksRefreshResponse", "BaselineCorrectResult"):
        assert expected in names, f"{expected} missing from OpenAPI components.schemas"


@pytest.mark.pg
def test_tasks_endpoint_response_validates_live(client):
    """Live smoke test: hit GET /tasks against whatever plant/line data exists
    (or an empty result — both are valid TasksResponse shapes) and confirm
    response_model didn't reject/mangle a real row. Skips automatically when
    Postgres isn't reachable (see tests/conftest.py)."""
    r = client.get("/tasks", params={"limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert "data" in body and "links" in body and "meta" in body
    if body["data"]:
        row = body["data"][0]
        assert "id" in row and "start_date" in row and "row_version" in row


def test_bulk_update_alias_strips_a_caller_supplied_force_flag(monkeypatch):
    """N2: the flat-list alias is the one route where an external caller could
    send force:true and overwrite another planner's edit. It must reach the db
    layer as force=False regardless of the payload."""
    captured = {}

    def fake_update(items, allowed_plants=None):
        captured["items"] = items
        return {"applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {"abc123": 43}}

    monkeypatch.setattr(brain.db, "update_task_dates_bulk", fake_update)
    result = scheduling_routes.bulk_update(
        [brain.TaskDateUpdate(id="abc123", start_date="2026-08-01T07:00:00",
                              end_date="2026-08-01T15:00:00", base_version=42, force=True)],
        allowed_plants=None,
    )

    assert result["persisted"] == 1
    assert captured["items"][0]["force"] is False


def test_detect_interval_conflicts_reports_strict_overlaps_only():
    """N3: same-instant touching is not a conflict (SAP midnight snaps are
    intentional), segments of one order never conflict with each other, pairs
    on different machines never conflict, and only pairs involving a touched
    order are reported."""
    def t(h, m=0):
        return datetime(2026, 8, 17, h, m)
    intervals = [
        ("L1", "a", t(8), t(10)),
        ("L1", "b", t(9), t(11)),          # overlaps a by 60 min
        ("L1", "c", t(11), t(12)),         # touches b, no conflict
        ("L1", "d", t(8, 30), t(9)),       # segment 1 of d
        ("L1", "d", t(9, 30), t(9, 45)),   # segment 2 of d
        ("L2", "e", t(8), t(10)),          # other machine
        ("L1", "f", t(13), t(14)), ("L1", "g", t(13, 30), t(14)),  # untouched pair
    ]
    out = brain.db._detect_interval_conflicts(intervals, touched={"a", "d"})
    keyed = {(c["order_a"], c["order_b"]): c for c in out}
    assert ("a", "b") in keyed and keyed[("a", "b")]["overlap_minutes"] == 60
    assert keyed[("a", "b")]["machine"] == "L1"
    assert ("a", "d") in keyed and keyed[("a", "d")]["overlap_minutes"] == 45  # 30 + 15
    assert ("b", "d") in keyed
    assert ("b", "c") not in keyed
    assert ("f", "g") not in keyed
    assert all("e" not in k for k in keyed)


def test_apply_task_date_updates_logs_a_forced_non_atomic_write(monkeypatch):
    """Every force=True write NOT under atomic_optimizer leaves an auditable
    warn line in the _BACKEND_LOG ring buffer."""
    events = []
    monkeypatch.setattr(scheduling_routes, "_log_event",
                        lambda level, category, msg, **ctx: events.append((level, category, msg, ctx)))
    monkeypatch.setattr(brain.db, "update_task_dates_bulk",
                        lambda items, allowed_plants=None: {
                            "applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
                            "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                            "stale": [], "versions": {"abc123": 43}})

    scheduling_routes._apply_task_date_updates([
        brain.TaskDateUpdate(id="abc123", start_date="2026-08-01T07:00:00",
                             end_date="2026-08-01T15:00:00", base_version=42, force=True),
    ])

    forced = [e for e in events if e[3].get("event") == "forced_write"]
    assert len(forced) == 1
    assert forced[0][0] == "warn"
    assert forced[0][3]["count"] == 1
    assert forced[0][3]["ids"] == ["abc123"]


def test_parent_order_and_distribution_letter_are_read_only():
    """PARENT_ORDER and DISTRIBUTION_LETTER must never be included in
    TaskDateUpdate (the write model). They exist on TaskDTO (read model) as
    read-only fields and are excluded from _taskEditSnapshot, ensuring they
    cannot be edited through any save path."""
    # Verify TaskDTO accepts them
    read_task = brain.TaskDTO(**SAMPLE_TASK_ROW)
    assert read_task.PARENT_ORDER is None
    assert read_task.DISTRIBUTION_LETTER is None

    # Verify TaskDateUpdate does NOT have these fields
    update_model_fields = set(brain.TaskDateUpdate.model_fields.keys())
    assert "PARENT_ORDER" not in update_model_fields, (
        "PARENT_ORDER must never be in TaskDateUpdate (write model) — it is read-only"
    )
    assert "DISTRIBUTION_LETTER" not in update_model_fields, (
        "DISTRIBUTION_LETTER must never be in TaskDateUpdate (write model) — it is read-only"
    )


# ---------------------------------------------------------------------------
# H8: RUN_TIME must be finite and bounded, at both the model layer and the
# database layer (the DB constraint is the backstop for Excel/SAP ingest,
# which writes run_time through db.py's bulk upsert — a path this pydantic
# model never sees).
# ---------------------------------------------------------------------------
from math import inf, nan  # noqa: E402

from pydantic import ValidationError  # noqa: E402


@pytest.mark.parametrize("value", [nan, inf, -inf, -1, 168, 200])
def test_task_date_update_run_time_rejects_non_finite_or_out_of_range_values(value):
    """A crafted RUN_TIME of NaN reaches SQL interval arithmetic in db.py and
    crashes reads/saves for the whole plant (H8). The model-level validator
    must reject it — and every other non-finite or out-of-bounds value —
    before it ever reaches a route or the database. Upper bound is exclusive
    (168 itself is rejected), matching the DB CHECK constraint."""
    with pytest.raises(ValidationError):
        brain.TaskDateUpdate(id="abc123", RUN_TIME=value)


@pytest.mark.parametrize("value", [0, 0.5, 40.25, 167.99, None])
def test_task_date_update_run_time_accepts_finite_in_range_values(value):
    """Sanity check on the other side of the boundary: legitimate values
    (including the None default meaning "unchanged") must not be rejected."""
    update = brain.TaskDateUpdate(id="abc123", RUN_TIME=value)
    assert value == update.RUN_TIME


@pytest.mark.pg
class TestOrdersRunTimeBoundsConstraint:
    """Proves — against real local Postgres, not a mock — that
    chk_orders_run_time_bounds (migrations/2026-09-25-orders-run-time-bounds.sql)
    rejects NaN and +/-Infinity, not just out-of-range finite values. This
    relies on Postgres's documented float/numeric total ordering (NaN sorts
    greater than every other value including Infinity, so `NaN >= 0` is true
    but `NaN < 168` is false) — standard, documented behavior, but never
    exercised by this codebase's migrations before, so it is proved here
    rather than assumed."""

    ORD, MAT = "ZZTEST_ORD_H8_RUNTIME", "ZZTEST_MAT_H8_RUNTIME"

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db_ = pg
        oid = db_.make_id(self.ORD, self.MAT)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            conn.commit()

    def _insert_run_time(self, pg, run_time_sql: str):
        """Inserts a fresh test row with run_time set via a raw SQL literal
        (so we can express 'NaN'::float8 / 'Infinity'::float8, which psycopg
        cannot bind as ordinary Python float parameters into a NUMERIC
        column the same way). Returns None on success, or the raised
        exception on failure (constraint violations roll back the txn)."""
        db_ = pg
        oid = db_.make_id(self.ORD, self.MAT)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            conn.commit()
            try:
                cur.execute(
                    f"""
                    INSERT INTO orders (id, production_order, material_number, run_time)
                    VALUES (%s, %s, %s, {run_time_sql})
                    """,
                    (oid, self.ORD, self.MAT),
                )
                conn.commit()
                return None
            except Exception as exc:
                conn.rollback()
                return exc

    @pytest.mark.parametrize("run_time_sql", [
        "'NaN'::float8",
        "'Infinity'::float8",
        "'-Infinity'::float8",
    ])
    def test_constraint_rejects_nan_and_infinite_run_time(self, pg, run_time_sql):
        exc = self._insert_run_time(pg, run_time_sql)
        assert exc is not None, (
            f"INSERT with run_time = {run_time_sql} should have been rejected "
            "by chk_orders_run_time_bounds but succeeded"
        )
        assert isinstance(exc, pg_errors.CheckViolation), (
            f"expected a CheckViolation (IntegrityError) for {run_time_sql}, got "
            f"{type(exc).__name__}: {exc}"
        )
        assert "chk_orders_run_time_bounds" in str(exc)

    @pytest.mark.parametrize("run_time_sql", ["200", "-1", "168"])
    def test_constraint_rejects_out_of_range_finite_run_time(self, pg, run_time_sql):
        exc = self._insert_run_time(pg, run_time_sql)
        assert exc is not None
        assert isinstance(exc, pg_errors.CheckViolation)

    def test_constraint_accepts_in_range_run_time(self, pg):
        exc = self._insert_run_time(pg, "40.5")
        assert exc is None
