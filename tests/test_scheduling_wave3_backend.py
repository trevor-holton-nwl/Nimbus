"""Wave 3 backend hardening for backend/scheduling (no live Postgres: the data layer is stubbed)."""
import os
from datetime import datetime

import pytest

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

from pydantic import ValidationError  # noqa: E402

try:
    from starlette.testclient import TestClient  # noqa: E402

    import backend.security.auth as auth  # noqa: E402
    import brain  # noqa: E402
except Exception as exc:  # pragma: no cover
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)

import db  # noqa: E402
from backend.admin_ops import diagnostics_state  # noqa: E402
from backend.scheduling import routes  # noqa: E402
from backend.scheduling.models import (  # noqa: E402
    MAX_BATCH, PlanningReason, TaskDateUpdate, TaskNotePayload, TaskRefreshPayload, TasksUpdatePayload,
    TaskVersionRow,
)

PLANT = "ZZTEST_W3_PLANT"


@pytest.fixture
def client():
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "w3.user@example.com"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def _ok_result(persisted=1, **extra):
    return {"persisted": persisted, "failed": 0, "invalid": 0, "not_found": 0, "invalid_ids": [],
            "not_found_ids": [], "stale": [], "versions": {"q": 9}, "conflicts": [], "rejection_reasons": {}, **extra}


# --- S8-3 planning_reason validation ---------------------------------------------------------------
def test_planning_reason_with_non_string_step_is_rejected_by_the_model():
    with pytest.raises(ValidationError):
        TaskDateUpdate(id="q", planning_status="needs_planning",
                       planning_reason={"code": "no_fit_found", "message": "Full", "step": 5})
    with pytest.raises(ValidationError):
        PlanningReason(code="x", message="y" * 1001)


def test_planning_reason_step_5_is_a_422_and_never_reaches_the_data_layer(client, monkeypatch):
    calls = []
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda *a, **k: calls.append(a) or _ok_result())
    body = {"id": "q", "planning_status": "needs_planning",
            "planning_reason": {"code": "no_fit_found", "message": "Full", "step": 5}}
    assert client.post("/task/update", json=body).status_code == 422
    assert client.post("/tasks/update", json={"tasks": [body]}).status_code == 422
    assert calls == []


def test_valid_planning_reason_still_saves_with_its_extra_keys(client, monkeypatch):
    seen = []
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda items, **k: seen.append(items) or _ok_result())
    reason = {"code": "tool_unavailable", "message": "Tool busy", "step": "tooling", "tool_id": "T1", "holders": ["a", "b"]}
    r = client.post("/tasks/update", json={"tasks": [{"id": "q", "planning_status": "needs_planning",
                                                       "planning_reason": reason}]})
    assert r.status_code == 200 and r.json()["persisted"] == 1
    assert seen[0][0]["planning_reason"] == reason        # unset keys are not padded with nulls
    r = client.post("/tasks/update", json={"tasks": [{"id": "q", "planning_status": "needs_planning",
                                                       "planning_reason": {"code": "c", "message": "m"}}]})
    assert seen[1][0]["planning_reason"] == {"code": "c", "message": "m"}


def test_db_layer_rejects_a_non_string_step_for_in_process_callers(monkeypatch):
    """db.update_task_dates_bulk's own check (jobs and other in-process callers skip the pydantic model)."""
    from contextlib import contextmanager

    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def execute(self, sql, params=None): pass
        def fetchall(self):
            return [("a", datetime(2026, 9, 9, 8), datetime(2026, 9, 9, 12), 4, 42, 0, "p", "L1", "scheduled", None, False,
                     None, None, None, None, None, None, None, None, None, None, False, None, None, None)]

    class Connection:
        def cursor(self): return Cursor()
        def rollback(self): pass

    class Pool:
        @contextmanager
        def connection(self): yield Connection()

    monkeypatch.setattr(db, "_pool", Pool())
    monkeypatch.setattr(db, "_min_segment_minutes_by_plant", lambda *a: {})
    for bad in ({"code": "c", "message": "m", "step": 5}, {"code": "c", "message": "m", "step": "s" * 65}):
        res = db.update_task_dates_bulk([{"id": "a", "planning_status": "needs_planning", "planning_reason": bad,
                                          "base_version": 42}])
        assert res["persisted"] == 0 and res["invalid_ids"] == ["a"]


# --- S8-5 /task/note --------------------------------------------------------------------------------
@pytest.mark.parametrize("body", [{"id": 5, "notes": "x"}, {"id": "o", "notes": 7}, {"id": "o", "notes": "x" * 501},
                                  {"notes": "x"}, {"id": "", "notes": "x"}])
def test_task_note_bad_payload_is_422(client, monkeypatch, body):
    monkeypatch.setattr(db, "get_order_plant", lambda i: PLANT)
    assert client.post("/task/note", json=body).status_code == 422


def test_task_note_valid_and_null_notes_persist(client, monkeypatch):
    got = []
    monkeypatch.setattr(db, "get_order_plant", lambda i: PLANT)
    monkeypatch.setattr(db, "update_task_note", lambda i, n, **k: got.append((i, n)) or {"status": "ok"})
    assert client.post("/task/note", json={"id": "o", "notes": "x" * 500}).status_code == 200
    assert client.post("/task/note", json={"id": "o", "notes": None}).status_code == 200
    assert [n for _, n in got] == ["x" * 500, None]
    assert TaskNotePayload(id="o").notes is None


# --- S8-6 update_task status / error ----------------------------------------------------------------
def test_update_task_returns_the_real_status_and_error_code(client, monkeypatch):
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda *a, **k: _ok_result())
    r = client.post("/task/update", json={"id": "q", "MACHINE": "L1"})
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["error_code"] is None

    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(db, "update_task_dates_bulk", boom)
    r = client.post("/task/update", json={"id": "q", "MACHINE": "L1"})
    # a rolled-back persist: the helper reports it (HTTP 200, status 'error'); the singular route used to say "ok"
    body = r.json()
    assert r.status_code == 200 and body["status"] == "error" and body["error_code"] == "db.error" and body["cause"]


# --- S8-7 bounds ------------------------------------------------------------------------------------
def test_batch_and_field_bounds():
    TasksUpdatePayload(tasks=[TaskDateUpdate(id="a")] * 3)
    with pytest.raises(ValidationError):
        TasksUpdatePayload.model_validate({"tasks": [{"id": "a"}] * (MAX_BATCH + 1)})
    with pytest.raises(ValidationError):
        TaskRefreshPayload(ids=["a"] * (MAX_BATCH + 1))
    assert len(TaskRefreshPayload(ids=["a"] * MAX_BATCH).ids) == MAX_BATCH
    for field, value in (("base_version", -1), ("base_version", 2**31), ("id", "x" * 129), ("MACHINE", "m" * 129)):
        with pytest.raises(ValidationError):
            TaskDateUpdate(**{"id": "a", field: value} if field != "id" else {"id": value})
    assert TaskDateUpdate(id="a", base_version=2**31 - 1).base_version == 2**31 - 1


def test_bulk_update_rejects_an_oversized_list(client):
    r = client.post("/tasks/bulk_update", json=[{"id": "a"}] * (MAX_BATCH + 1))
    assert r.status_code == 422


def test_refresh_pushes_the_plant_scope_into_the_query_and_stamps_order_y(client, monkeypatch):
    seen = {}

    def fake(ids, allowed_plants=None):
        seen["allowed"] = allowed_plants
        return [{"id": "a", "plant": PLANT, "MACHINE": "L1", "COLOR": " red ", "FORM_SIZE": "MD", "notes": "n",
                 "MATERIAL_DESCRIPTION": "W", "ecc_firmed": True, "schedule_segments": [], "row_version": 3}]
    monkeypatch.setattr(db, "get_task_versions", fake)
    monkeypatch.setattr(routes.plcache, "PLANT_LISTS", {PLANT: {"": {"colorWheel": {"RED": 2}}}})
    r = client.post("/tasks/refresh", json={"ids": ["a", "gone"]})
    assert r.status_code == 200
    body = r.json()
    assert seen["allowed"] == [PLANT]
    assert body["missing"] == ["gone"]
    row = body["data"][0]
    assert row["PLANT"] == PLANT and row["COLOR"] == "RED" and row["ORDER_Y"] == 2
    assert (row["FORM_SIZE"], row["notes"], row["MATERIAL_DESCRIPTION"], row["ecc_firmed"]) == ("MD", "n", "W", True)
    assert "ORDER_Y" in TaskVersionRow.model_fields


def test_refresh_unlisted_colour_gets_the_default_rank(client, monkeypatch):
    monkeypatch.setattr(db, "get_task_versions", lambda ids, allowed_plants=None: [
        {"id": "a", "plant": PLANT, "MACHINE": "L1", "COLOR": None, "schedule_segments": []}])
    monkeypatch.setattr(routes.plcache, "PLANT_LISTS", {})
    row = client.post("/tasks/refresh", json={"ids": ["a"]}).json()["data"][0]
    assert row["ORDER_Y"] == 999999


# --- S8-8 diagnostics / meta ------------------------------------------------------------------------
def test_warnings_are_bounded_to_the_newest_50(monkeypatch):
    monkeypatch.setattr(diagnostics_state, "_log_event", lambda *a, **k: None)
    saved = list(diagnostics_state.DIAGNOSTICS["warnings"])
    diagnostics_state.DIAGNOSTICS["warnings"].clear()
    try:
        for i in range(120):
            diagnostics_state._warn("warn", f"m{i}")
        w = diagnostics_state.DIAGNOSTICS["warnings"]
        assert len(w) == 50 and w[0]["msg"] == "m70" and w[-1]["msg"] == "m119"
    finally:
        diagnostics_state.DIAGNOSTICS["warnings"][:] = saved


def test_tasks_meta_is_an_allow_list(monkeypatch):
    monkeypatch.setitem(diagnostics_state.DIAGNOSTICS, "schedule_event_last_sweep", {"deleted": 1})
    monkeypatch.setitem(diagnostics_state.DIAGNOSTICS, "job_run_last_sweep", {"deleted": 1})
    row = {"id": "a", "MACHINE": "L1", "PLANT": "P", "COLOR": "RED", "PRT_01": None, "PRT_02": None,
           "PRODUCTION_VERSION": None, "BASIC_START_DATE": datetime(2026, 9, 9, 8),
           "BASIC_FINISH_DATE": datetime(2026, 9, 9, 12), "MATERIAL_DESCRIPTION": "W", "ROW_VERSION": 1}
    monkeypatch.setattr(db, "query_orders_rows", lambda **k: ([row], None, None))
    body = routes.build_tasks_payload("P", None, None, None, None)
    meta = body["meta"]
    assert "schedule_event_last_sweep" not in meta and "job_run_last_sweep" not in meta
    for key in ("color_merge_misses", "missed_colors", "pre_color_merge_count", "color_merge_ms", "server_now",
                "visibility_horizon_end", "frozen_horizon_end", "total", "rendered", "emitted_task_count"):
        assert key in meta, key


# --- S8-1 _fast_pydt equivalence ---------------------------------------------------------------------
@pytest.mark.parametrize("value", ["2026-09-09T08:00:00", "2026-09-09T08:00:00Z", "2026-09-09T08:00:00+05:30",
                                   "2026-09-09T08:00:00-04:00", "2026-09-09T08:00:00.123", "2026-09-09 08:00:00",
                                   "2026-09-09", "09/09/2026 08:00"])
def test_fast_pydt_matches_to_pydt_and_is_naive(value):
    fast, slow = routes._fast_pydt(value), routes._to_pydt(value)
    assert fast == slow and fast.tzinfo is None


def test_apply_updates_stores_naive_digits_for_z_offset_and_naive_strings(monkeypatch):
    seen = []
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda items, **k: seen.append(items) or _ok_result(persisted=3))
    routes._apply_task_date_updates([
        TaskDateUpdate(id="z", start_date="2026-09-09T08:00:00Z", end_date="2026-09-09T12:00:00Z"),
        TaskDateUpdate(id="o", start_date="2026-09-09T08:00:00+05:00", end_date="2026-09-09T12:00:00+05:00"),
        TaskDateUpdate(id="n", start_date="2026-09-09T08:00:00", end_date="2026-09-09T12:00:00"),
    ])
    for it in seen[0]:
        assert it["start"] == datetime(2026, 9, 9, 8) and it["end"] == datetime(2026, 9, 9, 12)
        assert it["start"].tzinfo is None and it["end"].tzinfo is None


# --- S8-9 shared bulk shaping ------------------------------------------------------------------------
def test_tasks_update_and_bulk_update_return_identical_shapes(client, monkeypatch):
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda *a, **k: _ok_result())
    a = client.post("/tasks/update", json={"tasks": [{"id": "q", "MACHINE": "L1"}]}).json()
    b = client.post("/tasks/bulk_update", json=[{"id": "q", "MACHINE": "L1"}]).json()
    assert a == b and a["status"] == "ok" and a["updated"] == 1 and a["error_code"] is None

    def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(db, "update_task_dates_bulk", boom)
    a = client.post("/tasks/update", json={"tasks": [{"id": "q", "MACHINE": "L1"}]}).json()
    b = client.post("/tasks/bulk_update", json=[{"id": "q", "MACHINE": "L1"}]).json()
    assert a == b and a["status"] == "error" and a["error_code"] == "db.error"
