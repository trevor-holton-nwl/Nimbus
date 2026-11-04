"""Operational HTTP contracts: healthy/degraded states, settings and maintenance.

Use the assembled app and real authorization dependencies. Database and cache
I/O are replaced, so no administrative command ever reaches PostgreSQL.
"""

import re
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock

import psycopg
import pytest
from fastapi.testclient import TestClient

import brain
import db
import master_data as md
from backend.admin_ops import routes
from backend.priority_lists import cache
from backend.security import auth


ADMIN = {"x-user-email": "admin", "x-api-key": "ops-test-key"}


@pytest.fixture
def ops(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "ops-test-key")
    monkeypatch.setattr(auth, "get_user_role", lambda actor: "admin" if actor == "admin" else "planner")
    monkeypatch.setattr(auth, "admin_exists", lambda: True)
    denied_pool = MagicMock(name="unexpected_database_access")
    denied_pool.connection.side_effect = AssertionError("DB access must be explicitly doubled")
    monkeypatch.setattr(db, "_pool", denied_pool)
    monkeypatch.setattr(md, "_pool", denied_pool)
    monkeypatch.setattr(auth, "_pool", denied_pool)
    diagnostics = deepcopy(routes.DIAGNOSTICS)
    logs = list(brain._BACKEND_LOG)
    try:
        yield TestClient(brain.api, raise_server_exceptions=False)
    finally:
        routes.DIAGNOSTICS.clear()
        routes.DIAGNOSTICS.update(diagnostics)
        brain._BACKEND_LOG.clear()
        brain._BACKEND_LOG.extend(logs)


def test_liveness_remains_available_when_database_checks_would_fail(ops, monkeypatch):
    health = MagicMock(side_effect=RuntimeError("database unavailable"))
    monkeypatch.setattr(db, "get_health_stats", health)
    response = ops.get("/livez")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    health.assert_not_called()


@pytest.mark.parametrize("connected,count", [(True, 123), (False, 0)])
def test_health_maps_database_reachability_to_stateless_memory(ops, monkeypatch, connected, count):
    monkeypatch.setattr(db, "get_health_stats", lambda: {"connected": connected, "total_orders": count})
    monkeypatch.setattr(db, "get_pool_stats", lambda: {"pool_size": 4})
    routes.DIAGNOSTICS.update(loaded_at="2026-10-13T00:00:00Z")
    response = ops.get("/health")
    assert response.status_code == 200
    assert response.json()["memory"] == {"stateless": True, "loaded": connected, "task_count": count,
                                         "loaded_at": "2026-10-13T00:00:00Z"}
    assert "color_wheel" not in response.json()


def test_public_health_redacts_internal_errors_without_mutating_cached_stats(ops, monkeypatch):
    health = {"connected": False, "error": "host=private.internal port=5432", "total_orders": 0}
    pool = {"error": "password=private-test-value", "pool_size": 0}
    monkeypatch.setattr(db, "get_health_stats", lambda: health)
    monkeypatch.setattr(db, "get_pool_stats", lambda: pool)
    response = ops.get("/health")
    assert response.status_code == 200
    assert response.json()["db"]["error"] == "unavailable"
    assert response.json()["pool"]["error"] == "unavailable"
    assert "private" not in response.text
    assert health["error"] == "host=private.internal port=5432"
    assert pool["error"] == "password=private-test-value"


@pytest.mark.parametrize("path,function", [("/maintenance/analyze", "run_analyze"),
                                          ("/maintenance/vacuum-analyze", "run_vacuum_analyze")])
@pytest.mark.parametrize("headers,status", [({"x-user-email": "admin"}, 401),
                                            ({"x-user-email": "planner", "x-api-key": "ops-test-key"}, 403)])
def test_maintenance_never_calls_database_without_both_guards(ops, monkeypatch, path, function, headers, status):
    command = MagicMock()
    monkeypatch.setattr(db, function, command)
    response = ops.post(path, headers=headers, json={"table": "orders"})
    assert response.status_code == status
    command.assert_not_called()


@pytest.mark.parametrize("path,function", [("/maintenance/analyze", "run_analyze"),
                                          ("/maintenance/vacuum-analyze", "run_vacuum_analyze")])
def test_maintenance_returns_table_and_timing_from_database(ops, monkeypatch, path, function):
    command = MagicMock(return_value={"table": "orders", "duration_ms": 12.5})
    monkeypatch.setattr(db, function, command)
    response = ops.post(path, headers=ADMIN, json={"table": "orders"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "table": "orders", "duration_ms": 12.5}
    command.assert_called_once_with("orders")


@pytest.mark.parametrize("table", [None, ""])
def test_vacuum_empty_table_targets_all_but_analyze_requires_a_table(ops, monkeypatch, table):
    vacuum = MagicMock(return_value={"table": None})
    analyze = MagicMock()
    monkeypatch.setattr(db, "run_vacuum_analyze", vacuum)
    monkeypatch.setattr(db, "run_analyze", analyze)
    response = ops.post("/maintenance/vacuum-analyze", headers=ADMIN, json={"table": table})
    assert response.json() == {"ok": True, "table": None}
    vacuum.assert_called_once_with(None)
    response = ops.post("/maintenance/analyze", headers=ADMIN, json={"table": table})
    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "table is required"}
    analyze.assert_not_called()


@pytest.mark.parametrize("path,function", [("/maintenance/analyze", "run_analyze"),
                                          ("/maintenance/vacuum-analyze", "run_vacuum_analyze")])
@pytest.mark.parametrize("error,code", [(ValueError("Unknown table: untrusted"), "db.error"),
                                       (psycopg.errors.DeadlockDetected("deadlock detected"), "db.deadlock"),
                                       (psycopg.errors.QueryCanceled("statement canceled"), "db.lock_timeout")])
def test_maintenance_failure_has_stable_error_code_and_correlated_error_event(ops, monkeypatch, path, function, error, code):
    monkeypatch.setattr(db, function, MagicMock(side_effect=error))
    response = ops.post(path, headers={**ADMIN, "x-request-id": "maintenance-error"}, json={"table": "orders"})
    assert response.status_code == 200
    assert response.json() == {"ok": False, "status": "error", "error_code": code, "error": str(error)}
    entries = [entry for entry in brain._BACKEND_LOG if entry.get("rid") == "maintenance-error"
               and entry.get("category") == "maintenance" and entry.get("level") == "error"]
    assert len(entries) == 1
    assert entries[0]["error_code"] == code
    assert entries[0]["error_type"] == type(error).__name__
    assert entries[0]["ctx"]["table"] == "orders"


def test_system_settings_reads_public_unwrapped_blob(ops, monkeypatch):
    blob = {"orderFields": {"PLANT": {"grid": True, "inspector": False}}, "custom": {"enabled": True}}
    monkeypatch.setattr(md, "get_system_settings", lambda: blob)
    response = ops.get("/system-settings")
    assert response.status_code == 200
    assert response.json() == blob


def test_system_settings_write_forwards_patch_and_actor_and_returns_full_result(ops, monkeypatch):
    patch = {"orderFields": {"PLANT": {"grid": True}}}
    merged = {**patch, "other": "preserved"}
    write = MagicMock(return_value=merged)
    monkeypatch.setattr(md, "upsert_system_settings", write)
    response = ops.post("/system-settings", headers=ADMIN, json=patch)
    assert response.status_code == 200
    assert response.json() == merged
    write.assert_called_once_with(patch, user_email="admin")


@pytest.mark.parametrize("headers,status", [({"x-user-email": "admin"}, 401),
                                            ({"x-user-email": "planner", "x-api-key": "ops-test-key"}, 403)])
def test_system_settings_write_requires_both_guards(ops, monkeypatch, headers, status):
    write = MagicMock()
    monkeypatch.setattr(md, "upsert_system_settings", write)
    response = ops.post("/system-settings", headers=headers, json={})
    assert response.status_code == status
    write.assert_not_called()


def test_system_settings_validation_error_is_400(ops, monkeypatch):
    monkeypatch.setattr(md, "upsert_system_settings", MagicMock(side_effect=ValueError("Invalid settings patch")))
    response = ops.post("/system-settings", headers=ADMIN, json={})
    assert response.status_code == 400
    assert response.json() == {"status": "error", "message": "Invalid settings patch", "detail": "Invalid settings patch"}


@pytest.mark.parametrize("value,ok", [(14, True), (1, True), (60, True), (0, False), (61, False), (-3, False),
                                      ("14", False), (14.5, False), (True, False), (None, False)])
def test_system_settings_schedule_event_retention_is_validated(ops, monkeypatch, value, ok):
    write = MagicMock(return_value={"schedule_event_retention_days": value})
    monkeypatch.setattr(md, "upsert_system_settings", write)
    response = ops.post("/system-settings", headers=ADMIN, json={"schedule_event_retention_days": value})
    assert response.status_code == (200 if ok else 400)
    assert write.called is ok


def test_reload_uses_new_cache_and_live_counts(ops, monkeypatch):
    load = MagicMock()
    monkeypatch.setattr(cache, "load_priority_lists", load)
    monkeypatch.setattr(cache, "PLANT_LISTS", {"P1": {}, "P2": {}})
    monkeypatch.setattr(db, "get_health_stats", lambda: {"connected": True, "total_orders": 42, "user_overrides": 3})
    response = ops.post("/reload", headers=ADMIN)
    assert response.status_code == 200
    load.assert_called_once_with()
    snapshot = response.json()["diagnostics"]
    assert snapshot["total_orders"] == 42
    assert snapshot["user_overrides"] == 3
    assert snapshot["db_connected"] is True
    assert datetime.fromisoformat(snapshot["loaded_at"]).tzinfo is not None


def test_reload_failure_redacts_detail_and_preserves_last_success_timestamp(ops, monkeypatch):
    routes.DIAGNOSTICS["loaded_at"] = "last-success"
    monkeypatch.setattr(cache, "load_priority_lists", MagicMock(side_effect=RuntimeError("private-db-connection")))
    response = ops.post("/reload", headers={**ADMIN, "x-request-id": "reload-failure"})
    assert response.status_code == 500
    assert "reload-failure" in response.json()["detail"]
    assert "private-db-connection" not in response.text
    assert routes.DIAGNOSTICS["loaded_at"] == "last-success"
    errors = [entry for entry in brain._BACKEND_LOG if entry.get("category") == "reload"
              and entry.get("rid") == "reload-failure"]
    assert len(errors) == 1
    assert errors[0]["error_type"] == "RuntimeError"


def test_reload_snapshot_tolerates_count_probe_failure(ops, monkeypatch):
    monkeypatch.setattr(cache, "load_priority_lists", MagicMock())
    monkeypatch.setattr(db, "get_health_stats", MagicMock(side_effect=RuntimeError("count probe unavailable")))
    response = ops.post("/reload", headers=ADMIN)
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["diagnostics"]["loaded_at"]


def test_deep_diagnostics_has_no_color_wheel_and_no_plant_stats_without_plant(ops, monkeypatch):
    monkeypatch.setattr(db, "get_db_deep_stats", lambda: {"orders": 42})
    monkeypatch.setattr(db, "get_schedule_event_stats", lambda: {"rows_estimate": None})
    count = MagicMock()
    monkeypatch.setattr(db, "count_orders_in_plant", count)
    response = ops.get("/diagnostics/deep", headers=ADMIN)
    assert response.status_code == 200
    body = response.json()
    assert body["db_stats"]["orders"] == 42
    assert "color_wheel" not in body and "plant_stats" not in body
    assert "color_merge_is_per_request" not in body["pipeline"]
    count.assert_not_called()


def test_deep_diagnostics_plant_param_adds_unfiltered_plant_total(ops, monkeypatch):
    monkeypatch.setattr(db, "get_db_deep_stats", lambda: {"orders": 42})
    monkeypatch.setattr(db, "get_schedule_event_stats", lambda: {"rows_estimate": None})
    count = MagicMock(return_value=1234)
    monkeypatch.setattr(db, "count_orders_in_plant", count)
    response = ops.get("/diagnostics/deep", params={"plant": "1008"}, headers=ADMIN)
    assert response.status_code == 200
    assert response.json()["plant_stats"] == {"plant": "1008", "total": 1234}
    count.assert_called_once_with("1008")


def test_deep_diagnostics_blank_plant_is_400_and_planner_is_refused(ops, monkeypatch):
    count = MagicMock()
    monkeypatch.setattr(db, "count_orders_in_plant", count)
    assert ops.get("/diagnostics/deep", params={"plant": "  "}, headers=ADMIN).status_code == 400
    planner = {"x-user-email": "planner", "x-api-key": "ops-test-key"}
    assert ops.get("/diagnostics/deep", params={"plant": "1008"}, headers=planner).status_code == 403
    count.assert_not_called()


def test_db_diagnostics_assembles_all_sections_including_degraded_section(ops, monkeypatch):
    functions = {"pool": "get_pool_stats", "server": "get_db_server_info", "tables": "get_db_table_stats",
                 "connections": "get_db_connection_activity", "locks": "get_db_lock_waits",
                 "indexes": "get_db_index_usage", "slow_queries": "get_db_slow_queries",
                 "sequences": "get_db_sequence_health"}
    expected = {}
    for section, function in functions.items():
        value = {"error": "extension unavailable"} if section == "slow_queries" else {"section": section}
        expected[section] = value
        monkeypatch.setattr(db, function, MagicMock(return_value=value))
    response = ops.get("/diagnostics/db", headers=ADMIN)
    assert response.status_code == 200
    result = response.json()
    assert datetime.fromisoformat(result.pop("fetched_at")).tzinfo is not None
    assert result == expected
    for function in functions.values():
        getattr(db, function).assert_called_once_with()


SWEEP = "/maintenance/schedule-event-sweep"


@pytest.mark.parametrize("headers,status", [({"x-user-email": "admin"}, 401),
                                            ({"x-user-email": "planner", "x-api-key": "ops-test-key"}, 403)])
def test_schedule_event_sweep_route_requires_both_guards(ops, monkeypatch, headers, status):
    sweep = MagicMock()
    monkeypatch.setattr(routes.schedule_events_data, "sweep_schedule_events", sweep)
    assert ops.post(SWEEP, headers=headers, json={}).status_code == status
    sweep.assert_not_called()


@pytest.mark.parametrize("days", [0, 61, "7", True, 1.5])
def test_schedule_event_sweep_route_rejects_bad_retention_days(ops, monkeypatch, days):
    sweep = MagicMock()
    monkeypatch.setattr(routes.schedule_events_data, "sweep_schedule_events", sweep)
    assert ops.post(SWEEP, headers=ADMIN, json={"retention_days": days}).status_code == 400
    sweep.assert_not_called()


@pytest.mark.parametrize("body,expected", [({}, None), ({"retention_days": 7}, 7)])
def test_schedule_event_sweep_route_forwards_override(ops, monkeypatch, body, expected):
    canned = {"deleted": 3, "chunks": 1, "retention_days": expected or 14, "locked": False, "error": None}
    sweep = MagicMock(return_value=canned)
    monkeypatch.setattr(routes.schedule_events_data, "sweep_schedule_events", sweep)
    response = ops.post(SWEEP, headers=ADMIN, json=body)
    assert response.status_code == 200
    assert response.json() == {"ok": True, **canned}
    sweep.assert_called_once_with(retention_days=expected)


def test_version_returns_build_id_from_index_html_without_auth(ops, monkeypatch):
    html = (Path(__file__).resolve().parents[1] / "frontend" / "index.html").read_text(encoding="utf-8")
    expected = re.search(r"NIMBUS_BUILD_ID = '([^']*)'", html).group(1)
    monkeypatch.setattr(routes, "_build_id_cache", routes._UNREAD)
    response = ops.get("/version")
    assert response.status_code == 200
    assert response.json() == {"build_id": expected}
    assert response.headers["cache-control"] == "no-store"


def test_version_is_null_when_index_html_is_unreadable(ops, monkeypatch, tmp_path):
    monkeypatch.setenv("NIMBUS_STATIC_DIR", str(tmp_path))
    monkeypatch.setattr(routes, "_build_id_cache", routes._UNREAD)
    response = ops.get("/version")
    assert response.status_code == 200
    assert response.json() == {"build_id": None}


def test_diagnostics_deep_includes_schedule_event_block(ops, monkeypatch):
    monkeypatch.setattr(db, "get_db_deep_stats", lambda: {"total": 0, "by_line": {}})
    monkeypatch.setattr(db, "get_schedule_event_stats",
                        lambda: {"rows_estimate": 5, "oldest_at": "2026-10-01T00:00:00+00:00", "newest_at": "2026-10-23T00:00:00+00:00"})
    routes.DIAGNOSTICS["schedule_event_last_sweep"] = {"deleted": 2}
    routes.DIAGNOSTICS["schedule_event_write_failures"] = 4
    response = ops.get("/diagnostics/deep", headers=ADMIN)
    assert response.status_code == 200
    block = response.json()["db_stats"]["schedule_event"]
    assert block == {"rows_estimate": 5, "oldest_at": "2026-10-01T00:00:00+00:00", "newest_at": "2026-10-23T00:00:00+00:00",
                     "last_sweep": {"deleted": 2}, "write_failures": 4}


def test_table_stats_empty_table_never_needs_vacuum(monkeypatch):
    """An empty table (no live, no dead rows) reports dead_pct 0 and no vacuum; a table with dead rows still flags."""
    from datetime import datetime, timezone
    now = datetime(2026, 10, 30, tzinfo=timezone.utc)

    def row(name, live, dead, pct):
        return (name, live, dead, pct, None, now, None, now, "8 kB", 0)

    cur = MagicMock()
    cur.fetchall.return_value = [row("empty_t", 0, 0, 100.0), row("tiny_t", 0, 3, 100.0), row("busy_t", 70, 30, 30.0)]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    pool = MagicMock()
    pool.connection.return_value.__enter__.return_value = conn
    monkeypatch.setattr(db, "_pool", pool)
    out = {r["table"]: r for r in db.get_db_table_stats()}
    assert out["empty_t"]["dead_pct"] == 0.0 and out["empty_t"]["needs_vacuum"] is False
    assert out["busy_t"]["needs_vacuum"] is True
    assert out["tiny_t"]["needs_vacuum"] is True   # dead rows exist and the share is over 20%
