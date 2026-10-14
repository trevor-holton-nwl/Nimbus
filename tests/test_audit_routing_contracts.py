"""Regression contracts for routing edits, final versions and task refresh."""
from datetime import datetime
import json
from pathlib import Path

import pytest

import db
from backend.routing import resolver
from tests.test_task_response_models import _FakeSegmentCursor, _FakeSegmentPool, _routing_eff_row


def test_rate_map_keeps_material_in_operation_identity():
    operations = {}
    versions = {}
    for material, minutes in [("MAT-A", 1), ("MAT-B", 3)]:
        versions[("P", material, "0001")] = {
            "task_list_type": "N", "routing_group": "GROUP", "group_counter": "01",
        }
        operations[("P", material, "N", "GROUP", "01")] = [{
            "sap_workcenter": "WC", "workcenter_category": "0001", "base_quantity": 1,
            "std_value_machine": minutes, "std_value_unit_machine": "MIN",
        }]
    pv_map = resolver._build_pv_map(versions)
    contract = json.loads((Path(__file__).parent / "modules/fixtures/routing_material_map.json").read_text())
    assert pv_map == contract["pv"]
    for entries in [operations, dict(reversed(list(operations.items())))]:
        ops_map = resolver._build_ops_map(entries, {})
        assert ops_map == contract["ops"]
        assert len(ops_map) == 2
        assert ops_map[pv_map["MAT-A|0001"]["key"] + "|WC"]["minutes_per_unit"] == 1
        assert ops_map[pv_map["MAT-B|0001"]["key"] + "|WC"]["minutes_per_unit"] == 3


def test_pv_edit_uses_authoritative_runtime_in_same_write(monkeypatch):
    cursor = _FakeSegmentCursor([_routing_eff_row("pv", run_time=3)], [])
    pool = _FakeSegmentPool(cursor)
    monkeypatch.setattr(db, "_pool", pool)
    monkeypatch.setattr(resolver, "check_eligibility", lambda *args, **kwargs: {
        "ok": True, "hours": 9, "basis": {"production_version": "0002", "machine": "M1"},
    })
    monkeypatch.setattr(resolver, "resolve_orders", lambda *args, **kwargs: pytest.fail(
        "A schedule edit must not invalidate its returned version with a second transaction"))
    result = db.update_task_dates_bulk([{
        "id": "pv", "PRODUCTION_VERSION": "0002", "MACHINE": "M1", "RUN_TIME": 9,
        "base_version": 100, "start": datetime(2026, 9, 30, 8), "end": datetime(2026, 9, 30, 17),
        "schedule_segments": [], "planning_status": "scheduled", "planning_reason": None,
    }])
    assert result["invalid_ids"] == []
    assert result["persisted"] == 1
    writes = [(query, params) for query, params in cursor.executed if query.startswith("UPDATE orders o SET")]
    assert len(writes) == 1
    assert "run_time_source = 'routing'" in writes[0][0]
    assert "run_time_basis = v.c" in writes[0][0]
    assert 9 in writes[0][1]
    assert result["versions"] == {"pv": 999}


def test_manual_runtime_without_candidate_change_remains_forbidden(monkeypatch):
    cursor = _FakeSegmentCursor([_routing_eff_row("manual", run_time=3)], [])
    monkeypatch.setattr(db, "_pool", _FakeSegmentPool(cursor))
    result = db.update_task_dates_bulk([{"id": "manual", "RUN_TIME": 9, "base_version": 100}])
    assert result["persisted"] == 0
    assert result["invalid_ids"] == ["manual"]


def test_refresh_returns_all_writable_attributes_with_version(monkeypatch):
    class Cursor:
        def execute(self, sql, params):
            assert "o.machine" in sql and "o.prt_01" in sql and "o.run_time" in sql
            # The wire due date is the locked SAP value, not the (overwritable) basic_* dates.
            assert "COALESCE(o.original_finish_received, o.basic_finish_date)" in sql
            assert "COALESCE(o.original_start_received, o.basic_start_date)" in sql

        def fetchall(self):
            return [("row", None, None, 12, [], False, "P", "needs_planning",
                     {"code": "runtime_unknown", "message": "pending"}, "routing", {"machine": "M2"},
                     "M2", "TOOL2", None, "0002", 6, 120, "MAT", datetime(2026, 10, 1, 8), True,
                     datetime(2026, 10, 30, 16), "overtime")]

    monkeypatch.setattr(db, "_pool", _FakeSegmentPool(Cursor()))
    row = db.get_task_versions(["row"])[0]
    assert row["placement_exception"] == "overtime"
    assert {field: row[field] for field in ["MACHINE", "PRT_01", "PRT_02", "PRODUCTION_VERSION", "RUN_TIME"]} == {
        "MACHINE": "M2", "PRT_01": "TOOL2", "PRT_02": None, "PRODUCTION_VERSION": "0002", "RUN_TIME": 6,
    }
    assert row["row_version"] == 12
    assert row["ORDER_QUANTITY_(GMEIN)"] == 120
    assert row["MATERIAL_NUMBER"] == "MAT"
    assert row["original_start_date"] == "2026-10-01T08:00:00"
    assert row["original_end_date"] == "2026-10-30T16:00:00"
    assert row["firmed"] is True


def test_distribution_child_read_serves_the_locked_original_dates(monkeypatch):
    """The child read feeds the Distribution pane's original_* columns: it must emit the locked SAP value
    (falling back to basic_*) under the existing basic_* keys, not the raw overwritable dates."""
    import backend.distribution.data as distribution_data

    seen = {}

    class Cursor:
        description = []

        def execute(self, sql, params):
            seen["sql"] = sql

        def fetchall(self):
            return []

    assert distribution_data._read_write_children(Cursor(), ["c1"]) == []
    assert "COALESCE(o.original_start_received, o.basic_start_date) AS basic_start_date" in seen["sql"]
    assert "COALESCE(o.original_finish_received, o.basic_finish_date) AS basic_finish_date" in seen["sql"]

