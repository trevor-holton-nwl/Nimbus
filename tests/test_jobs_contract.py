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
OPAQUE = {"params", "summary", "data", "params_schema", "defaults", "options"}
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
           "misfire_grace_s": 300, "skip_if_running": True, "tz_mode": "plant", "fixed_timezone": None, "options": None, "last_fire_at": None,
           "created_by": "a", "modified_by": "a",
           "created_at": datetime(2026, 10, 28, 14, tzinfo=UTC), "modified_at": datetime(2026, 10, 28, 14, tzinfo=UTC)}
    return {**row, **kw}


def _run_row(**kw):
    row = {"id": 42, "job_id": 5, "job_name": "Morning optimize", "plant": "1008", "job_type": "optimizer.plant",
           "schedule_id": 11, "status": "warning", "trigger": "schedule", "attempt": 1,
           "scheduled_for": datetime(2026, 10, 29, 12, tzinfo=UTC), "started_at": datetime(2026, 10, 29, 12, 0, 1, tzinfo=UTC),
           "ended_at": datetime(2026, 10, 29, 12, 3, 40, tzinfo=UTC), "triggered_by": None, "summary": {"late": 3},
           "error": None, "log_truncated": False, "cancel_requested": False, "batch_id": None}
    return {**row, **kw}


def _batch_row(**kw):
    row = {"id": 9, "job_id": 5, "job_name": "Morning optimize", "schedule_id": 11,
           "scheduled_for": datetime(2026, 10, 29, 12, tzinfo=UTC), "trigger": "schedule", "triggered_by": "schedule",
           "status": "warning", "counts": {"total": 3, "succeeded": 1, "warning": 1, "skipped": 1},
           "started_at": datetime(2026, 10, 29, 12, tzinfo=UTC), "ended_at": datetime(2026, 10, 29, 12, 5, tzinfo=UTC),
           "summary": {"error_kind": "system"}}
    return {**row, **kw}


def _job_row(**kw):
    row = {"id": 5, "plant": "1008", "job_type": "optimizer.plant", "name": "Morning optimize",
           "params": {"mode": "due_date"}, "enabled": True, "archived": False, "retry_max": 0, "timeout_s": None,
           "created_by": "a", "modified_by": "a", "created_at": datetime(2026, 10, 28, 14, tzinfo=UTC),
           "modified_at": datetime(2026, 10, 28, 14, tzinfo=UTC), "schedules": [_sched_row()], "last_run": _run_row(), "last_batch": _batch_row(),
           "fan_out": {"stagger_s": 30, "max_parallel": 2, "fail_fast": False},
           "targets": [{"kind": "explicit", "value": "1008", "excluded": False, "params_override": {"mode": "spt"}}]}
    return {**row, **kw}


@pytest.fixture
def client(monkeypatch):
    jobs = {5: _job_row()}
    dry = {"apply_mode": "propose", "moved": 1,
           "proposal": {"snapshot_version": "v1", "base_versions": {"1008-100": 7},
                        "patches": [{"id": "1008-100", "end_date": "2026-10-30T14:00:00", "base_version": 7}],
                        "findings": [{"severity": "warn", "message": "x"}]}}
    runs = {42: _run_row(), 43: _run_row(id=43, status="running", ended_at=None), 44: _run_row(id=44, summary=dry),
            45: _run_row(id=45, job_id=6, status="running", ended_at=None, summary=None)}
    jobs[6] = _job_row(id=6, params={"apply_mode": "propose"})
    import db
    from backend.jobs import scheduler as jobs_scheduler
    monkeypatch.setattr(db, "get_task_versions", lambda ids: [
        {"id": "1008-100", "end_date": "2026-10-30T10:00:00", "row_version": 7, "MACHINE": "L1",
         "planning_status": "scheduled"}])
    monkeypatch.setattr("backend.scheduling.routes.optimizer_snapshot_version", lambda plant: "v1")
    monkeypatch.setattr(data, "run_health", lambda **kw: {"running": 1, "queued": 0, "failed_24h": 2,
                                                          "failed_config_24h": 1, "failed_system_24h": 0,
                                                          "failed_transient_24h": 1, "failed_batches_24h": 1, "missed_24h": 0,
                                                          "warning_24h": 1, "longer_than_usual": [43]})
    monkeypatch.setattr(data, "next_fire_schedules", lambda **kw: [
        {**_sched_row(), "job_name": "Morning optimize", "plant": "1008"}])
    monkeypatch.setattr(jobs_scheduler, "heartbeat", lambda: {"ok": True, "last_tick_at": "2026-10-29T12:00:00+00:00"})
    monkeypatch.setattr(data, "plant_timezone", lambda plant: "America/New_York")
    monkeypatch.setattr(data, "load_plant_rows", lambda: [
        {"plant": "1008", "subnetworks": ["NA"], "timezone": "America/Chicago"},
        {"plant": "1021", "subnetworks": ["NA"], "timezone": None},
        {"plant": "NOTZ", "subnetworks": ["EU"], "timezone": None}])
    monkeypatch.setattr(data, "maintenance_state", lambda fresh=False: {"enabled": False, "since": None, "by": None})
    monkeypatch.setattr(data, "timeline_run_plants", lambda **kw: ["1008"])
    monkeypatch.setattr(data, "timeline_runs", lambda **kw: [_run_row(created_at=datetime(2026, 10, 29, 12, tzinfo=UTC))])
    monkeypatch.setattr(data, "get_batch", lambda bid: _batch_row() if bid == 9 else None)
    monkeypatch.setattr(data, "batch_runs", lambda bid, allowed, limit=500, offset=0: [_run_row(batch_id=9)] if bid == 9 else [])
    monkeypatch.setattr(data, "list_batches", lambda **kw: {"batches": [_batch_row()], "next_before_id": 8})
    monkeypatch.setattr(data, "set_targets", lambda jid, rows, actor: None)
    monkeypatch.setattr(data, "plant_exists", lambda plant: True)
    monkeypatch.setattr(data, "plant_has_timezone", lambda plant: plant != "NOTZ")
    monkeypatch.setattr(data, "active_runs", lambda jid, plant=None, limit=20: [])
    monkeypatch.setattr(data, "batch_latest_statuses", lambda ids, allowed=None: {b: ["succeeded", "warning", "skipped"] for b in ids})
    monkeypatch.setattr(data, "batch_latest_by_plant", lambda bid: {"1008": "failed", "1021": "succeeded"})
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_schedule", lambda sid: _sched_row() if sid == 11 else None)
    monkeypatch.setattr(data, "list_jobs", lambda **kw: {"jobs": list(jobs.values()), "next_before_id": 4})
    monkeypatch.setattr(data, "list_runs", lambda **kw: {"runs": list(runs.values()), "next_before_id": 41})
    monkeypatch.setattr(data, "get_run", lambda rid: runs.get(rid))
    monkeypatch.setattr(data, "list_log", lambda rid, **kw: [] if kw.get("after_seq") else [
        {"seq": 1, "at": "2026-10-29T12:00:01+00:00", "level": "info", "step": "load", "msg": "loaded 120 orders",
         "duration_ms": 850, "data": {}, "step_seq": None}])
    monkeypatch.setattr(data, "last_success_watermark", lambda jid, before=None, plant=None: None)
    art = {"sections": [{"key": "counts", "title": "Changes", "columns": [{"key": "value", "label": "value", "type": "text"},
                                                                          {"key": "events", "label": "events", "type": "number"}],
                         "rows": [["drag", 3], ["=cmd", 1], ["note", 2]], "row_count": 3, "truncated": False}],
           "summary": {"events": 6}}
    monkeypatch.setattr(data, "get_artifact", lambda rid: (
        {"run_id": rid, "filename": "report-1008-run42.json", "content_type": "application/json", "row_count": 3,
         "size_bytes": 512, "created_at": "2026-10-29T12:03:40+00:00", "artifact": art} if rid == 42 else None))
    monkeypatch.setattr(data, "create_job", lambda **kw: 5)
    monkeypatch.setattr(data, "patch_job", lambda jid, fields, actor, **kw: True)
    monkeypatch.setattr(data, "add_schedule", lambda jid, s, actor: 11)
    monkeypatch.setattr(data, "patch_schedule", lambda sid, norm, flags, actor: True)
    monkeypatch.setattr(runner, "start_manual_run", lambda job, actor, trigger="manual", only_plants=None: 42)
    monkeypatch.setattr(runner, "cancel_run", lambda rid: runs[rid])
    monkeypatch.setattr(runner, "cancel_batch", lambda bid: _batch_row(status="warning"))
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


def test_types_carry_kind_and_param_metadata(client):
    by = {t["key"]: t for t in client.get("/jobs/types").json()["types"]}
    assert by["optimizer.plant"]["kind"] == "action" and by["optimizer.plant"]["mutates"] is True
    assert {k for k, t in by.items() if t["kind"] == "report"} == {
        "report.what_changed", "report.late_orders", "report.missing_master_data", "report.coverage",
        "report.distribution"}
    assert all(t["mutates"] is False for t in by.values() if t["kind"] == "report")
    pm = {p["key"]: p for p in by["report.late_orders"]["params"]}
    assert pm["horizon"]["type"] == "date_window" and pm["horizon"]["widget"] == "date-window"
    assert pm["horizon"]["label_key"] == "jobs.p.report.late_orders.horizon"
    assert pm["min_days_late"]["type"] == "number" and pm["min_days_late"]["max"] == 365
    opt = {p["key"]: p for p in by["optimizer.plant"]["params"]}
    assert opt["search"]["type"] == "enum" and opt["search"]["enum"] == ["normal", "exhaustive"]
    assert opt["respect_firmed"]["type"] == "boolean" and opt["apply_mode"]["default"] == "apply"
    assert {p["type"] for p in by["report.coverage"]["params"]} == {"multi_enum", "integer"}


def test_window_preview_matches_the_resolver(client):
    from datetime import datetime, timezone
    from backend.jobs import windows
    win = windows.last_days(30)
    body = client.post("/jobs/windows/preview", json={"plant": "1008", "window": win}).json()
    _check(body, "window_preview")
    start, end, label = windows.resolve_window(win, "America/New_York", datetime.now(timezone.utc))
    assert body["label"] == label and body["timezone"] == "America/New_York"
    assert body["start"] == start.isoformat(timespec="seconds")
    assert client.post("/jobs/windows/preview", json={"plant": "NOTZ", "window": win}).status_code == 400
    assert client.post("/jobs/windows/preview", json={"plant": "1008", "window": {"mode": "fixed"}}).status_code == 400


def test_run_artifact_pages_and_csv(client):
    body = client.get("/jobs/runs/42/artifact?offset=0&limit=500").json()
    _check(body, "artifact")
    page = client.get("/jobs/runs/42/artifact?section=counts&offset=1&limit=1").json()["sections"][0]
    assert page["rows"] == [["=cmd", 1]] and page["rows_stored"] == 3 and page["offset"] == 1
    r = client.get("/jobs/runs/42/artifact?section=counts&format=csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and ".csv" in r.headers["content-disposition"]
    assert r.content.startswith(b"\xef\xbb\xbf") and "'=cmd" in r.text, "formula guard applies"
    assert client.get("/jobs/runs/42/artifact?format=csv").status_code == 400
    assert client.get("/jobs/runs/42/artifact?section=nope").status_code == 404
    assert client.get("/jobs/runs/43/artifact").status_code == 404
    assert client.get("/jobs/runs/42/artifact?limit=501").status_code == 422


def test_timeline_shape_range_scope_and_paging(client, monkeypatch):
    from datetime import timedelta
    now = datetime.now(UTC)
    q = f"from={(now - timedelta(hours=1)).isoformat().replace('+00:00', 'Z')}&to={(now + timedelta(days=6)).isoformat().replace('+00:00', 'Z')}"
    body = client.get(f"/jobs/timeline?{q}").json()
    _check(body, "timeline")
    lane = body["lanes"][0]
    assert lane["plant"] == "1008" and lane["timezone"] == "America/Chicago" and lane["upcoming"], "armed schedule shows upcoming"
    assert [e["at_utc"] for e in lane["upcoming"]] == sorted(e["at_utc"] for e in lane["upcoming"])
    assert client.get(f"/jobs/timeline?from={(now).isoformat()}&to={(now + timedelta(days=9)).isoformat()}").status_code == 400
    assert client.get(f"/jobs/timeline?from={(now).isoformat()}&to={(now - timedelta(hours=1)).isoformat()}").status_code == 400
    assert client.get("/jobs/timeline?from=garbage").status_code == 400
    assert client.get("/jobs/timeline?plant_limit=51").status_code == 422
    seen = {}
    monkeypatch.setattr(data, "timeline_run_plants", lambda **kw: [f"P{i:02d}" for i in range(30)])
    monkeypatch.setattr(data, "timeline_runs", lambda **kw: seen.setdefault("plants", kw["plants"]) and [])
    body = client.get("/jobs/timeline").json()
    assert body["total_plants"] == 31, "30 plants with runs plus 1008, which has an armed schedule"
    assert len(body["lanes"]) == 20 and body["plant_limit"] == 20, "default page is the first 20 plants"
    page2 = client.get("/jobs/timeline?plant_offset=20&plant_limit=20").json()
    assert len(page2["lanes"]) >= 10 and page2["lanes"][0]["plant"] != body["lanes"][0]["plant"]
    app_dep = client.app.dependency_overrides
    app_dep[auth.get_allowed_plants_for_request] = lambda: ["1021"]
    assert client.get("/jobs/timeline?plant=1008").status_code == 403, "a scoped user cannot ask for another plant"
    assert client.get("/jobs/timeline?plants=1021,1008").status_code == 403
    scoped = client.get("/jobs/timeline").json()
    assert all(l["plant"] == "1021" or not l["upcoming"] for l in scoped["lanes"]) and seen["plants"] is not None


def test_maintenance_toggle_is_admin_global_and_in_the_summary(client, monkeypatch):
    calls = []
    monkeypatch.setattr(data, "set_maintenance", lambda enabled, actor: calls.append((enabled, actor)) or
                        {"enabled": enabled, "since": "2026-10-29T12:00:00+00:00", "by": actor})
    monkeypatch.setattr(data, "maintenance_state", lambda fresh=False: {"enabled": False, "since": None, "by": None})
    body = client.post("/jobs/maintenance", json={"enabled": True}).json()
    _check(body, "maintenance")
    assert calls == [(True, "admin@example.com")]
    assert client.post("/jobs/maintenance", json={}).status_code == 422
    assert client.get("/jobs/summary").json()["maintenance"] == {"enabled": False, "since": None, "by": None}
    client.app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["1008"]
    assert client.post("/jobs/maintenance", json={"enabled": False}).status_code == 403, "global setting: unrestricted admins only"


def test_schedule_options_round_trip_and_validate(client, monkeypatch):
    sent = {}
    monkeypatch.setattr(data, "add_schedule", lambda jid, s, actor: sent.update(s) or 11)
    opts = {"closed_day": "next_working_day", "run_window": {"start": "06:00", "end": "18:00", "action": "defer"}}
    assert client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "options": opts}).status_code == 200
    assert sent["options"]["closed_day"] == "next_working_day" and sent["options"]["run_window"]["action"] == "defer"
    assert client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "options": {"closed_day": "tomorrow"}}).status_code == 400
    assert client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "options": {"closed_day": "skip"}, "tz_mode": "utc"}).status_code == 400, \
        "a plant calendar rule needs plant time"
    pv = client.post("/jobs/schedules/preview", json={"plant": "1008", "n": 3, **SCHEDULE_BODY, "options": {"dst_gap": "skip"}}).json()
    assert "skipped" in pv and len(pv["entries"]) == 3
    assert client.post("/jobs/schedules/preview", json={"plant": "1008", "n": 3, **SCHEDULE_BODY, "options": {"bogus": 1}}).status_code == 400


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
    _check(client.get("/jobs/runs/42").json(), "run_detail")
    _check(client.post("/jobs/5/run").json(), "run_started")
    _check(client.post("/jobs/runs/43/cancel").json(), "run_wrapped")
    assert client.post("/jobs/runs/42/cancel").status_code == 409, "a finished run cannot be cancelled"


def test_summary_health_strip(client):
    body = client.get("/jobs/summary?plant=1008").json()
    _check(body, "summary")
    assert body["next_fire"]["job_id"] == 5 and body["scheduler"]["ok"] is True
    assert body["longer_than_usual"] == [43]


def test_run_filters_and_restart(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(data, "list_runs", lambda **kw: seen.update(kw) or {"runs": [], "next_before_id": None})
    assert client.get("/jobs/runs?periodicity=daily&scheduled_by=schedule&status=missed&since_hours=24").status_code == 200
    assert (seen["periodicity"], seen["scheduled_by"], seen["status"]) == ("daily", "schedule", "missed")
    assert seen["since"] is not None
    assert client.get("/jobs/runs?periodicity=yearly").status_code == 400
    _check(client.post("/jobs/runs/42/restart").json(), "run_started")
    monkeypatch.setattr(data, "active_runs", lambda jid, plant=None, limit=20: [{"plant": "1008", "status": "running"}])
    r = client.post("/jobs/runs/42/restart")
    assert r.status_code == 409 and "1008 (running)" in r.json()["detail"], "the 409 names what is running"


def test_proposal_of_a_dry_run(client):
    body = client.get("/jobs/runs/44/proposal").json()
    _check(body, "proposal")
    row = body["rows"][0]
    assert row["delta_hours"] == 4.0 and row["machine"] == "L1" and row["changed_since"] is False
    assert body["board_matches"] is True
    assert client.get("/jobs/runs/42/proposal").status_code == 400, "an applied run has no proposal"


def test_proposal_of_a_running_dry_run_is_pending(client):
    body = client.get("/jobs/runs/45/proposal").json()
    _check(body, "proposal_pending")
    assert body["pending"] is True
    assert client.get("/jobs/runs/43/proposal").status_code == 400, "a running non-dry run has no proposal"
    assert client.post("/jobs/runs/44/approve").status_code in (404, 405), "no approve route exists"


def test_log_page_stops_on_done(client):
    body = client.get("/jobs/runs/42/log?after_seq=0").json()
    _check(body, "log")
    assert body["last_seq"] == 1
    assert body["done"] is True, "warning is terminal, so done tells the client to stop polling"
    running = client.get("/jobs/runs/43/log?after_seq=1").json()
    assert running["done"] is False and running["status"] == "running"


def test_run_now_conflicts_while_a_run_is_active(client, monkeypatch):
    monkeypatch.setattr(data, "active_runs", lambda jid, plant=None, limit=20: [{"plant": "1008", "status": "running"}])
    r = client.post("/jobs/5/run")
    assert r.status_code == 409 and "already" in r.json()["detail"]


def test_optimizer_schedule_for_a_plant_without_timezone_is_refused(client):
    body = {"plant": "NOTZ", "job_type": "optimizer.plant", "name": "n", "params": {}, "schedules": [SCHEDULE_BODY]}
    r = client.post("/jobs", json=body)
    assert r.status_code == 400 and "timezone" in r.json()["detail"]
    assert client.post("/jobs", json={**body, "schedules": []}).status_code == 200, "a job without a schedule is fine"
    assert client.post("/jobs/schedules/preview", json={"plant": "NOTZ", "n": 2, **SCHEDULE_BODY}).status_code == 200


def test_committed_job_types_fixture_matches_the_registry():
    """tests/fixtures/jobs_types.json feeds the frontend form tests; regenerate with scripts/dump_job_types.py."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("dump_job_types", Path(__file__).parent.parent / "scripts" / "dump_job_types.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    committed = json.loads((Path(__file__).parent / "fixtures" / "jobs_types.json").read_text(encoding="utf-8"))
    assert committed == mod.live(), "run: python scripts/dump_job_types.py"


def test_every_param_and_type_label_key_is_translated_or_aliased():
    """The server names `jobs.p.<type>.<param>[.<value>]` and `jobs.type.<key>`; the locale files (or the frontend's
    legacy aliases for the optimizer) must answer every one, in all five locales."""
    import re
    root = Path(__file__).parent.parent / "frontend"
    committed = json.loads((Path(__file__).parent / "fixtures" / "jobs_types.json").read_text(encoding="utf-8"))
    model = (root / "admin-ops" / "jobs-model.mts").read_text(encoding="utf-8")
    aliases = dict(re.findall(r"'(jobs\.[\w.]+)': '(jobs\.\w+)'", model))
    for loc in ("en", "de", "es", "fr", "pt"):
        text = (root / "locales" / f"{loc}.js").read_text(encoding="utf-8")
        have = set(re.findall(r"^\s*'(jobs\.[\w.]+)':", text, re.M))
        for t in committed["types"]:
            keys = [f"jobs.type.{t['key']}"]
            for p in t["params"]:
                keys.append(p["label_key"])
                keys += list((p.get("enum_label_keys") or {}).values())
            missing = [k for k in keys if k not in have and aliases.get(k) not in have]
            assert not missing, f"{loc}: {missing}"


# ------------------------------------------------------------------------------------------------ W3a multi-plant
def test_batches_list_and_detail(client):
    _check(client.get("/jobs/batches?plant=1008&job_id=5&status=warning&limit=10&before_id=20").json(), "batches_list")
    body = client.get("/jobs/batches/9").json()
    _check(body, "batch_detail")
    assert body["runs"][0]["batch_id"] == 9
    assert client.get("/jobs/batches/99").status_code == 404
    assert client.get("/jobs/batches/9?limit=1&offset=1").status_code == 200, "an empty later page is not a 404"


def test_batch_cancel_and_restart_routes(client, monkeypatch):
    assert client.post("/jobs/batches/9/cancel").status_code == 409, "the fixture batch is finished"
    assert client.post("/jobs/batches/99/cancel").status_code == 404
    monkeypatch.setattr(data, "get_batch", lambda bid: _batch_row(status="running") if bid == 9 else None)
    _check(client.post("/jobs/batches/9/cancel").json(), "batch_cancelled")
    _check(client.post("/jobs/batches/9/restart").json(), "run_started")        # re-runs the failed plant only
    monkeypatch.setattr(data, "batch_latest_by_plant", lambda bid: {"1008": "succeeded"})
    assert client.post("/jobs/batches/9/restart").status_code == 400, "nothing failed in the batch"
    assert client.get("/jobs/batches?status=nope").status_code == 400


def test_targets_preview_shape_scope_and_skipped_plants(client):
    body = client.post("/jobs/targets/preview", json={"kind": "subnetwork", "value": "NA"}).json()
    _check(body, "targets_preview")
    assert (body["count"], body["skipped"]) == (1, 1) and body["plants"][1]["warning"] == "plant has no timezone"
    allp = client.post("/jobs/targets/preview", json={"kind": "all", "excluded": ["NOTZ"]}).json()
    assert [p["plant"] for p in allp["plants"]] == ["1008", "1021"]
    page = client.post("/jobs/targets/preview", json={"kind": "all", "offset": 1, "limit": 1}).json()
    assert [p["plant"] for p in page["plants"]] == ["1021"] and page["count"] == 1
    assert client.post("/jobs/targets/preview", json={"kind": "explicit", "value": "NOPE"}).status_code == 400
    assert client.post("/jobs/targets/preview", json={}).status_code == 400
    assert client.post("/jobs/targets/preview", json={"targets": []}).json()["count"] == 0


def test_multi_plant_preview_lists_fires_per_plant_zone(client):
    body = client.post("/jobs/schedules/preview", json={
        "plant": "1008", "n": 2, **SCHEDULE_BODY,
        "targets": [{"kind": "explicit", "value": "1008"}, {"kind": "explicit", "value": "1021"}]}).json()
    _check(body, "preview_multi")
    assert body["total_plants"] == 1 and [p["plant"] for p in body["plants"]] == ["1008"], "1021 has no timezone"
    assert body["warnings"] == ["1021: plant has no timezone"]
    assert body["plants"][0]["timezone"] == "America/Chicago"
    assert body["plants"][0]["entries"][0]["at_local"][-6:] in ("-05:00", "-06:00")
    fixed = client.post("/jobs/schedules/preview", json={
        "plant": "1008", "n": 2, **SCHEDULE_BODY, "tz_mode": "fixed", "fixed_timezone": "Europe/London",
        "targets": [{"kind": "explicit", "value": "1008"}]}).json()
    assert fixed["plants"] == [] and fixed["timezone"] == "Europe/London" and len(fixed["entries"]) == 2
    utc = client.post("/jobs/schedules/preview", json={"plant": "1008", "n": 1, **SCHEDULE_BODY, "tz_mode": "utc"}).json()
    assert utc["timezone"] == "UTC" and utc["entries"][0]["at_local"].endswith("+00:00")
    assert client.post("/jobs/schedules/preview", json={"plant": "1008", **SCHEDULE_BODY, "tz_mode": "fixed"}).status_code == 400


def test_restart_and_run_now_of_a_batch_answer_run_and_batch(client, monkeypatch):
    monkeypatch.setattr(data, "get_run", lambda rid: _run_row(batch_id=9))
    _check(client.post("/jobs/5/run").json(), "batch_run_started")
    monkeypatch.setattr(runner, "start_manual_run", lambda job, actor, trigger="manual": (_ for _ in ()).throw(runner.NoTargetPlants("none")))
    assert client.post("/jobs/5/run").status_code == 400


def test_schedule_tz_mode_round_trips_and_job_targets_validate(client):
    sch = client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "tz_mode": "utc"})
    assert sch.status_code == 200
    assert client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "tz_mode": "fixed"}).status_code == 400
    assert client.post("/jobs/5/schedules", json={**SCHEDULE_BODY, "tz_mode": "fixed", "fixed_timezone": "Mars/Base"}).status_code == 400
    assert client.patch("/jobs/schedules/11", json={"tz_mode": "fixed", "fixed_timezone": "Asia/Tokyo"}).status_code == 200
    base = {"plant": "1008", "job_type": "optimizer.plant", "name": "n", "params": {}}
    ok = client.post("/jobs", json={**base, "targets": [{"kind": "explicit", "value": "1008", "params_override": {"mode": "spt"}}],
                                    "fan_out": {"stagger_s": 5, "max_parallel": 2, "fail_fast": True}})
    assert ok.status_code == 200
    bad_override = client.post("/jobs", json={**base, "targets": [{"kind": "explicit", "value": "1008", "params_override": {"mode": "nope"}}]})
    assert bad_override.status_code == 400 and "1008" in bad_override.json()["detail"]
    assert client.post("/jobs", json={**base, "targets": [{"kind": "explicit", "value": "9999"}]}).status_code == 400
    assert client.post("/jobs", json={**base, "targets": [{"kind": "subnetwork", "value": "XX"}]}).status_code == 400
    assert client.post("/jobs", json={**base, "fan_out": {"stagger_s": -1}}).status_code == 422
    assert client.post("/jobs", json={**base, "targets": [{"kind": "all", "value": "", "excluded": True}]}).status_code == 400


# ------------------------------------------------------------------------------------------------ W4a chains
def _step_row(**kw):
    row = {"seq": 1, "step_type": "optimizer.plant", "label": None, "run_on": "success", "continue_on_failure": False,
           "params": {"mode": "due_date", "search": "exhaustive", "respect_firmed": True, "apply_mode": "apply"},
           "status": "failed", "started_at": datetime(2026, 10, 29, 12, 0, 1, tzinfo=UTC),
           "ended_at": datetime(2026, 10, 29, 12, 3, 40, tzinfo=UTC), "summary": {"applied": 0}, "error": "write refused",
           "error_kind": "transient", "action_id": None}
    return {**row, **kw}


def _tpl_row(**kw):
    row = {"id": 3, "name": "Purge then re-optimize", "description": "Remove old orders, then re-optimize.",
           "steps": [{"type": "purge.orders", "params": {"max_rows": 5000}, "label": None, "continue_on_failure": False,
                      "run_on": "success"}],
           "defaults": {"retry_max": 1}, "version": 2, "created_by": "system",
           "modified_at": datetime(2026, 10, 29, 12, tzinfo=UTC), "archived": False}
    return {**row, **kw}


def test_chain_run_detail_carries_its_step_rows(client, monkeypatch):
    runs = {46: _run_row(id=46, job_type="chain", status="failed")}
    monkeypatch.setattr(data, "get_run", lambda rid: runs.get(rid))
    monkeypatch.setattr(data, "list_steps", lambda rid: [_step_row()])
    body = client.get("/jobs/runs/46").json()
    _check(body, "run_detail")
    assert body["steps"][0]["duration_ms"] == 219000 and body["steps"][0]["error_kind"] == "transient"


def test_log_can_be_filtered_to_one_step(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(data, "list_log", lambda rid, **kw: seen.update(kw) or [])
    assert client.get("/jobs/runs/42/log?step_seq=2").status_code == 200 and seen["step_seq"] == 2
    assert client.get("/jobs/runs/42/log?step_seq=0").status_code == 422


def test_template_routes_round_trip_and_validate_steps(client, monkeypatch):
    monkeypatch.setattr(data, "list_templates", lambda include_archived=False: [_tpl_row()])
    _check(client.get("/jobs/templates").json(), "templates_list")
    made = {}
    monkeypatch.setattr(data, "create_template", lambda **kw: made.update(kw) or 3)
    monkeypatch.setattr(data, "get_template", lambda tid: _tpl_row() if tid == 3 else None)
    step = {"type": "purge.orders", "params": {"max_rows": 100}}
    body = {"name": " Nightly purge ", "steps": [step], "defaults": {"retry_max": 9, "junk": 1}}
    _check(client.post("/jobs/templates", json=body).json(), "template_wrapped")
    assert made["name"] == "Nightly purge" and made["defaults"] == {"retry_max": 5}      # clamped, unknown keys dropped
    assert made["steps"][0]["params"]["max_rows"] == 100 and made["steps"][0]["params"]["window"]["mode"] == "rolling"
    assert client.post("/jobs/templates", json={**body, "steps": []}).status_code == 422
    for bad in ({"type": "nope"}, {"type": "chain"}, {"type": "purge.orders", "params": {"max_rows": 0}},
                {"type": "purge.orders", "params": {"window": {"mode": "rolling", "rolling": {"anchor": "now", "to_offset": -1}}}}):
        r = client.post("/jobs/templates", json={**body, "steps": [bad]})
        assert r.status_code == 400, (bad, r.text)
    assert client.post("/jobs/templates", json={**body, "steps": [{"type": "purge.orders", "params": {"dry_run": True}},
                                                                   {"type": "optimizer.plant", "params": {"apply_mode": "apply"}}]}
                       ).status_code == 400, "a chain cannot mix dry-run and apply steps"
    patched = {}
    monkeypatch.setattr(data, "patch_template", lambda tid, fields, actor, expected_version=None: patched.update(fields) or _tpl_row())
    _check(client.patch("/jobs/templates/3", json={"name": "x", "archived": True}).json(), "template_wrapped")
    assert patched == {"name": "x", "archived": True}


def test_job_created_from_a_template_stores_a_copy_and_the_version(client, monkeypatch):
    monkeypatch.setattr(data, "get_template", lambda tid: _tpl_row() if tid == 3 else _tpl_row(id=4, archived=True))
    made = {}
    monkeypatch.setattr(data, "create_job", lambda **kw: made.update(kw) or 5)
    r = client.post("/jobs", json={"plant": "1008", "job_type": "chain", "name": "n", "template_id": 3})
    assert r.status_code == 200, r.text
    assert made["template_id"] == 3 and made["template_version"] == 2
    assert made["params"]["steps"][0]["type"] == "purge.orders", "no steps sent: the template's copy is stored"
    assert client.post("/jobs", json={"plant": "1008", "job_type": "chain", "name": "n", "template_id": 4}).status_code == 400
    assert client.post("/jobs", json={"plant": "1008", "job_type": "optimizer.plant", "name": "n", "template_id": 3}).status_code == 400
    assert client.post("/jobs", json={"plant": "1008", "job_type": "chain", "name": "n"}).status_code == 400, "a chain needs a step"


def test_template_diff_and_update(client, monkeypatch):
    jobs = {5: _job_row(job_type="chain", template_id=3, template_version=1,
                        params={"steps": [{"type": "purge.orders", "params": {"max_rows": 100}, "label": None,
                                           "continue_on_failure": False, "run_on": "success"}]})}
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_template", lambda tid: _tpl_row())
    monkeypatch.setattr(data, "template_briefs", lambda ids: {3: {"id": 3, "name": "Purge then re-optimize", "version": 2,
                                                                  "archived": False}})
    body = client.get("/jobs/5/template-diff").json()
    _check(body, "template_diff")
    assert body["changed"] and body["diff"][0]["fields"] == ["params.max_rows"]
    monkeypatch.setattr(data, "list_jobs", lambda **kw: {"jobs": list(jobs.values()), "next_before_id": None})
    job = client.get("/jobs?limit=1").json()["jobs"][0]
    assert job["template"] == {"id": 3, "name": "Purge then re-optimize", "version": 1, "current_version": 2,
                               "archived": False, "changed": True, "edited_locally": False}
    saved = {}
    monkeypatch.setattr(data, "patch_job", lambda jid, fields, actor, **kw: saved.update(fields) or True)
    assert client.post("/jobs/5/template/update").status_code == 200
    assert saved["template_version"] == 2 and saved["params"]["steps"][0]["params"]["max_rows"] == 5000
    jobs[5] = _job_row(job_type="chain")
    assert client.get("/jobs/5/template-diff").status_code == 404


def test_restart_from_a_step_needs_confirm_unless_the_step_is_idempotent(client, monkeypatch):
    jobs = {5: _job_row(job_type="chain", targets=[])}
    runs = {50: _run_row(id=50, job_type="chain", status="failed"), 51: _run_row(id=51, job_type="chain", status="succeeded")}
    steps = [_step_row(seq=1, step_type="optimizer.plant", status="succeeded", error=None, error_kind=None),
             _step_row(seq=2, step_type="purge.orders", status="failed"),
             _step_row(seq=3, step_type="optimizer.plant", status="skipped", summary={"reason": "an earlier step failed"})]
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_run", lambda rid: runs.get(rid) or runs[50])
    monkeypatch.setattr(data, "list_steps", lambda rid: steps)
    started = {}
    monkeypatch.setattr(runner, "start_manual_run",
                        lambda job, actor, trigger="manual", only_plants=None, resume=None: started.update(resume=resume) or 52)
    blocked = client.post("/jobs/runs/50/restart-step", json={})
    assert blocked.status_code == 409 and "not safe to repeat" in blocked.json()["detail"] and not started
    ok = client.post("/jobs/runs/50/restart-step", json={"confirm": True})
    assert ok.status_code == 200 and started["resume"] == {"from_run": 50, "from_seq": 2}
    _check(ok.json(), "run_started")
    # restarting at a skipped step that follows an earlier FAILED step needs the confirm too (the failed one will not run)
    assert client.post("/jobs/runs/50/restart-step", json={"from_step": 3}).status_code == 409
    assert client.post("/jobs/runs/50/restart-step", json={"from_step": 3, "confirm": True}).status_code == 200 and started["resume"]["from_seq"] == 3
    assert client.post("/jobs/runs/50/restart-step", json={"from_step": 1}).status_code == 400
    assert client.post("/jobs/runs/51/restart-step", json={}).status_code == 409, "only a failed or cancelled run"
    idem = [_step_row(seq=1, step_type="optimizer.plant", status="failed")]
    monkeypatch.setattr(data, "list_steps", lambda rid: idem)
    assert client.post("/jobs/runs/50/restart-step").status_code == 200, "an idempotent step restarts without confirm"
    jobs[5] = _job_row(job_type="chain")                       # has targets: whole-chain restart only
    assert client.post("/jobs/runs/50/restart-step").status_code == 400


# ------------------------------------------------------------------------------------------- W4a fix wave (routes)
def test_a_dry_run_chain_has_a_proposal_and_a_pending_one(client, monkeypatch):
    dry_chain = {"chain": True, "mode": "dry_run", "apply_mode": "propose",
                 "proposal": {"snapshot_version": "v1", "base_versions": {"1008-100": 7},
                              "patches": [{"id": "1008-100", "end_date": "2026-10-30T14:00:00", "base_version": 7}],
                              "findings": []},
                 "proposal_step": {"seq": 2, "label": "SPT", "type": "optimizer.plant", "earlier_dry_steps": 1}}
    runs = {90: _run_row(id=90, job_type="chain", summary=dry_chain),
            91: _run_row(id=91, job_type="chain", status="running", ended_at=None, summary=None),
            92: _run_row(id=92, job_type="chain", status="running", ended_at=None, summary=None)}
    monkeypatch.setattr(data, "get_run", lambda rid: runs.get(rid))

    def opt(mode):
        return [_step_row(step_type="optimizer.plant", status="running", params={"apply_mode": mode})]

    monkeypatch.setattr(data, "list_steps", lambda rid: opt("propose") if rid == 91 else opt("apply"))
    body = client.get("/jobs/runs/90/proposal").json()
    assert body["pending"] is False and body["total"] == 1 and body["rows"][0]["machine"] == "L1"
    assert body["proposal_step"] == {"seq": 2, "label": "SPT", "type": "optimizer.plant", "earlier_dry_steps": 1}
    assert client.get("/jobs/runs/91/proposal").json()["pending"] is True
    assert client.get("/jobs/runs/92/proposal").status_code == 400, "a running chain whose optimizer step applies"


def test_whole_run_restart_of_a_chain_with_a_non_idempotent_step_needs_confirm(client, monkeypatch):
    steps = [{"type": "purge.orders", "params": {}, "label": None, "continue_on_failure": False, "run_on": "success"}]
    jobs = {5: _job_row(job_type="chain", targets=[], params={"steps": steps})}
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    r = client.post("/jobs/runs/42/restart")
    assert r.status_code == 409 and "not safe to repeat" in r.json()["detail"]
    assert client.post("/jobs/runs/42/restart", json={"confirm": True}).status_code == 200
    jobs[5] = _job_row(job_type="chain", targets=[], params={"steps": [{**steps[0], "type": "optimizer.plant"}]})
    assert client.post("/jobs/runs/42/restart").status_code == 200, "an idempotent chain restarts without it"


def test_template_patch_is_if_match_and_a_job_can_follow_the_new_version(client, monkeypatch):
    def fake_patch(tid, fields, actor, expected_version=None):
        if expected_version == 1:
            raise data.TemplateVersionConflict(2)
        return _tpl_row()

    monkeypatch.setattr(data, "patch_template", fake_patch)
    r = client.patch("/jobs/templates/3", json={"name": "x", "expected_version": 1})
    assert r.status_code == 409 and r.json()["current_version"] == 2 and "version 2" in r.json()["detail"]
    assert client.patch("/jobs/templates/3", json={"name": "x", "expected_version": 2}).status_code == 200
    # PATCH /jobs/{id} with template_version ties the job to the template's CURRENT version (and stores its steps)
    jobs = {5: _job_row(job_type="chain", template_id=3, template_version=1, targets=[],
                        params={"steps": _tpl_row()["steps"]})}
    saved = {}
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_template", lambda tid: _tpl_row())
    monkeypatch.setattr(data, "patch_job", lambda jid, fields, actor, **kw: saved.update(fields) or True)
    monkeypatch.setattr(data, "template_briefs", lambda ids: {3: {"id": 3, "name": "n", "version": 2, "archived": False,
                                                                  "steps": _tpl_row()["steps"]}})
    assert client.patch("/jobs/5", json={"template_version": 3}).status_code == 400, "only the current version"
    assert client.patch("/jobs/5", json={"template_version": 2}).status_code == 200
    assert saved["template_version"] == 2 and saved["template_steps"] == _tpl_row()["steps"]


def test_edited_locally_compares_the_jobs_steps_with_its_own_stored_template_copy(client, monkeypatch):
    own = _tpl_row()["steps"]
    jobs = {5: _job_row(job_type="chain", template_id=3, template_version=2, targets=[], template_steps=own,
                        params={"steps": [{**own[0], "params": {"max_rows": 1}}]})}
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "template_briefs", lambda ids: {3: {"id": 3, "name": "n", "version": 2, "archived": False,
                                                                  "steps": own}})
    monkeypatch.setattr(data, "list_jobs", lambda **kw: {"jobs": list(jobs.values()), "next_before_id": None})
    assert client.get("/jobs?limit=1").json()["jobs"][0]["template"]["edited_locally"] is True
    jobs[5] = {**jobs[5], "params": {"steps": own}}
    assert client.get("/jobs?limit=1").json()["jobs"][0]["template"]["edited_locally"] is False


def test_template_update_reports_plants_whose_override_replaces_the_steps(client, monkeypatch):
    jobs = {5: _job_row(job_type="chain", template_id=3, template_version=1, params={"steps": _tpl_row()["steps"]},
                        targets=[{"kind": "explicit", "value": "1008", "excluded": False,
                                  "params_override": {"steps": _tpl_row()["steps"]}}])}
    monkeypatch.setattr(data, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(data, "get_template", lambda tid: _tpl_row())
    monkeypatch.setattr(data, "patch_job", lambda jid, fields, actor, **kw: True)
    monkeypatch.setattr(data, "template_briefs", lambda ids: {})
    body = client.post("/jobs/5/template/update").json()
    assert body["steps_overridden_plants"] == ["1008"]
