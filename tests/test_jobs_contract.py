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
           "misfire_grace_s": 300, "skip_if_running": True, "tz_mode": "plant", "fixed_timezone": None,
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
         "duration_ms": 850, "data": {}}])
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
