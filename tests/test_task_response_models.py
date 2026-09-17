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

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import brain  # noqa: E402


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
    eff_rows = [("seg-default", None, None, 1.0, 100, 0, "PLANT-A", "L1")]
    cursor = _FakeSegmentCursor(eff_rows, plant_rows=[])  # PLANT-A has no plants-table override
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([_segment_batch_item("seg-default")])

    assert result["invalid_ids"] == ["seg-default"]
    assert result["persisted"] == 0
    assert any("FROM plants WHERE plant = ANY" in sql for sql, _ in cursor.executed), (
        "the plant-floor lookup must actually run, not just coincidentally fall back to 30"
    )


def test_update_task_dates_bulk_honors_a_plant_configured_productive_segment_floor(monkeypatch):
    """B3 review fix (2026-08-21): the backend mirror of the frontend
    placeWithSetup non-default-floor test — a plant configured with a
    15-minute floor accepts the same 20-minute segment the hardcoded
    30-minute default (proven above) rejects, proving the threading from
    plants.min_productive_segment_minutes through to
    _validate_schedule_segments actually reaches this code path."""
    eff_rows = [("seg-override", None, None, 1.0, 100, 0, "PLANT-B", "L1")]
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
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
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
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
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
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
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
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    cursor = _FakeScanErrorCursor(eff_rows, plant_rows=[])
    pool = _FakeSegmentPool(cursor)
    monkeypatch.setattr(brain.db, "_pool", pool)

    with pytest.raises(RuntimeError, match="conflict scan blew up"):
        brain.db.update_task_dates_bulk(
            [{"id": "mv-a", "start": t(8), "end": t(10), "base_version": 100}],
            atomic_optimizer=True, strict_conflicts=True,
        )

    assert pool.last_connection.rolled_back is True


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


from backend.scheduling import routes as scheduling_routes


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
    t = lambda h, m=0: datetime(2026, 8, 17, h, m)
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
