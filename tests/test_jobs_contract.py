"""Response-shape contract for the /jobs routes the Admin > Jobs frontend client calls (no database).

A FastAPI TestClient drives backend.jobs.routes with the data layer monkeypatched to in-memory rows and the auth
dependencies overridden. Every response is compared, key for key at every nesting level, with the bodies in
tests/fixtures/jobs_contract.json; tests/modules/admin-ops/jobs-client.test.mjs feeds those same fixtures through the
frontend client and asserts it reads only keys that exist. Together they fail when a route key is renamed on either
side. Free-form objects (params, summary, log data) are opaque.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.jobs import data, routes, runner
from backend.security import auth

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "jobs_contract.json").read_text(encoding="utf-8"))
OPAQUE = {"params", "summary", "data", "params_schema", "defaults"}
UTC = timezone.utc


def _resolve(v):
    if isinstance(v, str) and v.startswith("$"):
        return _resolve(FIXTURE[v[1:]])
    if isinstance(v, dict):
        return {k: _resolve(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_resolve(x) for x in v]
    return v


def _diff(actual, expected, path="$"):
    """Key-set differences between two JSON bodies (list items compared against the first expected item)."""
    out = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        if set(actual) != set(expected):
            out.append(f"{path}: keys +{sorted(set(actual) - set(expected))} -{sorted(set(expected) - set(actual))}")
        for k in set(actual) & set(expected):
            if k not in OPAQUE:
                out += _diff(actual[k], expected[k], f"{path}.{k}")
    elif isinstance(expected, list) and isinstance(actual, list):
        if expected and actual:
            for i, item in enumerate(actual):
                out += _diff(item, expected[0], f"{path}[{i}]")
    elif isinstance(expected, dict) != isinstance(actual, dict) and expected is not None and actual is not None:
        out.append(f"{path}: type {type(actual).__name__} vs {type(expected).__name__}")
    return out


def _check(body, name):
    assert _diff(body, _resolve(FIXTURE[name])) == [], name


# ---------------------------------------------------------------------------------------------- raw data rows
def _sched_row(**kw):
    row = {"id": 11, "job_id": 5, "kind": "weekly", "cron_expr": "0 8 * * mon,wed,fri", "time_of_day": "08:00",
           "days_of_week": [0, 2, 4], "day_of_month": None, "run_at": None, "timezone": "America/New_York",
           "valid_from": datetime(2026, 11, 1), "valid_until": None, "paused": False, "retired": False,
           "misfire_grace_s": 300, "skip_if_running": True, "created_by": "a", "modified_by": "a",
           "created_at": datetime(2026, 10, 28, 14, tzinfo=UTC), "modified_at": datetime(2026, 10, 28, 14, tzinfo=UTC)}
    return {**row, **kw}


def _run_row(**kw):
    row = {"id": 42, "job_id": 5, "job_name": "Morning optimize", "plant": "1008", "job_type": "optimizer.plant",
           "schedule_id": 11, "status": "warning", "trigger": "schedule", "attempt": 1,
           "scheduled_for": datetime(2026, 10, 29, 12, tzinfo=UTC), "started_at": datetime(2026, 10, 29, 12, 0, 1, tzinfo=UTC),
           "ended_at": datetime(2026, 10, 29, 12, 3, 40, tzinfo=UTC), "triggered_by": None, "summary": {"late": 3},
           "error": None, "log_truncated": False, "cancel_requested": False}
    return {**row, **kw}


def _job_row(**kw):
    row = {"id": 5, "plant": "1008", "job_type": "optimizer.plant", "name": "Morning optimize",
           "params": {"mode": "due_date"}, "enabled": True, "archived": False, "retry_max": 0, "timeout_s": None,
           "created_by": "a", "modified_by": "a", "created_at": datetime(2026, 10, 28, 14, tzinfo=UTC),
           "modified_at": datetime(2026, 10, 28, 14, tzinfo=UTC), "schedules": [_sched_row()], "last_run": _run_row()}
    return {**row, **kw}


@pytest.fixture
def client(monkeypatch):
    jobs = {5: _job_row()}
    runs = {42: _run_row(), 43: _run_row(id=43, status="running", ended_at=None)}
    monkeypatch.setattr(data, "plant_timezone", lambda plant: "America/New_York")
    monkeypatch.setattr(data, "plant_exists", lambda plant: True)
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_schedule", lambda sid: _sched_row() if sid == 11 else None)
    monkeypatch.setattr(data, "list_jobs", lambda **kw: {"jobs": list(jobs.values()), "next_before_id": 4})
    monkeypatch.setattr(data, "list_runs", lambda **kw: {"runs": list(runs.values()), "next_before_id": 41})
    monkeypatch.setattr(data, "get_run", lambda rid: runs.get(rid))
    monkeypatch.setattr(data, "list_log", lambda rid, **kw: [] if kw.get("after_seq") else [
        {"seq": 1, "at": "2026-10-29T12:00:01+00:00", "level": "info", "step": "load", "msg": "loaded 120 orders",
         "duration_ms": 850, "data": {}}])
    monkeypatch.setattr(data, "create_job", lambda **kw: 5)
    monkeypatch.setattr(data, "patch_job", lambda jid, fields, actor: True)
    monkeypatch.setattr(data, "add_schedule", lambda jid, s, actor: 11)
    monkeypatch.setattr(data, "patch_schedule", lambda sid, norm, flags, actor: True)
    monkeypatch.setattr(runner, "start_manual_run", lambda job, actor: 42)
    monkeypatch.setattr(runner, "cancel_run", lambda rid: runs[rid])
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[auth.require_authenticated] = lambda: "admin@example.com"
    app.dependency_overrides[auth.require_admin] = lambda: "admin@example.com"
    app.dependency_overrides[auth.require_api_key] = lambda: None
    app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    return TestClient(app)


SCHEDULE_BODY = {"kind": "weekly", "time_of_day": "08:00", "days_of_week": [0, 2, 4]}


def test_types(client):
    body = client.get("/jobs/types").json()
    _check(body, "types")
    opt = next(t for t in body["types"] if t["key"] == "optimizer.plant")
    assert set(opt["defaults"]) == {"mode", "search", "respect_firmed", "apply_mode"}, "param names the Jobs dialog sends"
    assert opt["defaults"]["search"] == "exhaustive"
    props = set(opt["params_schema"]["properties"])
    assert props == {"mode", "search", "respect_firmed", "apply_mode"}
    assert set(opt["params_schema"]["properties"]["mode"]["enum"]) == {"due_date", "min_changeover", "spt"}


def test_jobs_list_is_a_cursor_envelope(client):
    body = client.get("/jobs?plant=1008&limit=50&before_id=9&job_type=optimizer.plant&status=warning&q=x").json()
    assert set(body) == {"jobs", "next_before_id"}
    _check(body, "jobs_list")


def test_job_writes_return_a_job(client):
    _check(client.post("/jobs", json={"plant": "1008", "job_type": "optimizer.plant", "name": "n",
                                       "params": {"mode": "due_date", "search": "exhaustive", "respect_firmed": True,
                                                  "apply_mode": "apply"},
                                       "schedules": [{**SCHEDULE_BODY, "valid_from": None, "valid_until": None,
                                                      "skip_if_running": True}]}).json(), "job")
    _check(client.patch("/jobs/5", json={"archived": True}).json(), "job")
    assert client.patch("/jobs/5", json={"enabled": False}).status_code == 200


def test_schedule_writes_return_a_schedule(client):
    _check(client.post("/jobs/5/schedules", json=SCHEDULE_BODY).json(), "schedule")
    _check(client.patch("/jobs/schedules/11", json={"time_of_day": "09:00"}).json(), "schedule")
    assert client.patch("/jobs/schedules/11", json={"retired": True}).status_code == 200


def test_preview_and_upcoming(client):
    body = client.post("/jobs/schedules/preview", json={"plant": "1008", "n": 3, **SCHEDULE_BODY}).json()
    _check(body, "preview")
    assert len(body["entries"]) == 3
    up = client.get("/jobs/5/upcoming?n=2").json()
    _check(up, "upcoming_job")
    allj = client.get("/jobs/upcoming?plant=1008&n=4").json()
    _check(allj, "upcoming_all")
    assert len(allj["entries"]) == 4


def test_runs(client):
    _check(client.get("/jobs/runs?plant=1008&job_id=5&status=warning&limit=50&before_id=100").json(), "runs_list")
    _check(client.get("/jobs/runs/42").json(), "run_wrapped")
    _check(client.post("/jobs/5/run").json(), "run_wrapped")
    _check(client.post("/jobs/runs/43/cancel").json(), "run_wrapped")
    assert client.post("/jobs/runs/42/cancel").status_code == 409, "a finished run cannot be cancelled"


def test_log_page_stops_on_done(client):
    body = client.get("/jobs/runs/42/log?after_seq=0").json()
    _check(body, "log")
    assert body["last_seq"] == 1
    assert body["done"] is True, "warning is terminal, so done tells the client to stop polling"
    running = client.get("/jobs/runs/43/log?after_seq=1").json()
    assert running["done"] is False and running["status"] == "running"
