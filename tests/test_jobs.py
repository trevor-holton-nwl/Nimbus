"""Jobs scheduler domain: pure tests (triggers, DST, log caps, registry, outcome mapping, DDL pins) run anywhere;
classes/tests marked @pytest.mark.pg need local Postgres with NIMBUS_TEST_DB=1 and a local PG_HOST."""
import os
import re
import time
from datetime import datetime, timedelta, timezone

import pytest

from backend.jobs import context as jctx
from backend.jobs import registry, triggers
from backend.jobs.context import JobCancelled, JobContext
from backend.jobs.types import noop, optimizer

# Registers the planning_pg fixture (plant/subnet rows) used by the pg tests below.
pytest_plugins = ("tests.support.planning_pg",)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATION = os.path.join(ROOT, "migrations", "2026-10-29-1-job-scheduler.sql")
SCHEMA = os.path.join(ROOT, "schema.sql")
DESTRUCTIVE = re.compile(r"\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b", re.IGNORECASE)
NY = "America/New_York"


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


# ------------------------------------------------------------------------------------------------ DDL pinning
def test_ddl_constant_matches_migration_and_schema_verbatim():
    import backend.jobs.data as data
    for path in (MIGRATION, SCHEMA):
        with open(path, encoding="utf-8") as f:
            text = f.read().replace("\r\n", "\n")
        assert data.JOB_DDL in text, path


def test_migration_text_has_no_destructive_words_or_cascade():
    import backend.jobs.data as data
    with open(MIGRATION, encoding="utf-8") as f:
        text = f.read()
    assert not DESTRUCTIVE.search(text)
    assert not DESTRUCTIVE.search(data.JOB_DDL)
    assert "CASCADE" not in text.upper()


# -------------------------------------------------------------------------------------------- triggers: presets
@pytest.mark.parametrize("row,expr", [
    ({"kind": "daily", "time_of_day": "08:00"}, "0 8 * * *"),
    ({"kind": "weekdays", "time_of_day": "6:05"}, "5 6 * * mon-fri"),
    ({"kind": "weekly", "time_of_day": "08:00", "days_of_week": [4, 0]}, "0 8 * * mon,fri"),
    ({"kind": "hourly", "time_of_day": "00:15"}, "15 * * * *"),
    ({"kind": "monthly", "time_of_day": "23:30", "day_of_month": 1}, "30 23 1 * *"),
    ({"kind": "cron", "cron_expr": "0 8 * * 1-5"}, "0 8 * * mon,tue,wed,thu,fri"),
    ({"kind": "cron", "cron_expr": "*/15 6-18 * * 0,6"}, "*/15 6-18 * * sun,sat"),
    ({"kind": "cron", "cron_expr": "0 8 * * 7"}, "0 8 * * sun"),
])
def test_preset_compiles_to_cron(row, expr):
    assert triggers.validate_schedule({**row, "timezone": "UTC"})["cron_expr"] == expr


@pytest.mark.parametrize("row", [
    {"kind": "daily"}, {"kind": "daily", "time_of_day": "25:00"}, {"kind": "weekly", "time_of_day": "08:00"},
    {"kind": "weekly", "time_of_day": "08:00", "days_of_week": [7]}, {"kind": "monthly", "time_of_day": "08:00"},
    {"kind": "cron", "cron_expr": "* * *"}, {"kind": "cron", "cron_expr": "61 * * * *"},
    {"kind": "once"}, {"kind": "bogus"}, {"kind": "daily", "time_of_day": "08:00", "timezone": "Mars/Base"},
    {"kind": "daily", "time_of_day": "08:00", "valid_from": "2026-12-01T00:00", "valid_until": "2026-11-01T00:00"},
])
def test_bad_schedules_rejected(row):
    with pytest.raises(triggers.ScheduleError):
        triggers.validate_schedule({"timezone": "UTC", **row})


def test_next_n_in_plant_timezone_and_matches_trigger():
    s = triggers.validate_schedule({"kind": "daily", "time_of_day": "08:00", "timezone": NY})
    now = utc(2026, 10, 28, 15, 0)                       # 11:00 EDT, so the next 08:00 is tomorrow
    fires = triggers.next_fire_times(s, 3, now=now)
    assert [f.isoformat() for f in fires] == ["2026-10-29T08:00:00-04:00", "2026-10-30T08:00:00-04:00",
                                              "2026-10-31T08:00:00-04:00"]
    trig = triggers.build_trigger(s)
    assert trig.get_next_fire_time(None, now) == fires[0]           # the preview IS the trigger
    assert trig.get_next_fire_time(fires[0], fires[0]) == fires[1]
    assert [e["at_utc"] for e in triggers.preview(s, 1, now=now)] == ["2026-10-29T12:00:00+00:00"]


def test_weekly_and_validity_window():
    s = triggers.validate_schedule({"kind": "weekly", "time_of_day": "08:00", "days_of_week": [0],
                                    "timezone": "UTC", "valid_from": "2026-11-10T00:00",
                                    "valid_until": "2026-11-25T00:00"})
    fires = triggers.next_fire_times(s, 10, now=utc(2026, 10, 28))
    assert [f.strftime("%Y-%m-%d") for f in fires] == ["2026-11-16", "2026-11-23"]    # Mondays inside the window


def test_once_trigger():
    s = triggers.validate_schedule({"kind": "once", "run_at": "2026-11-02T09:30", "timezone": NY})
    fires = triggers.next_fire_times(s, 5, now=utc(2026, 10, 28))
    assert [f.isoformat() for f in fires] == ["2026-11-02T09:30:00-05:00"]


def test_dst_spring_forward_0230_fires_once_after_the_gap():
    s = triggers.validate_schedule({"kind": "daily", "time_of_day": "02:30", "timezone": NY})
    got = triggers.preview(s, 3, now=utc(2027, 3, 13, 12, 0))
    assert got[0]["at_utc"] == "2027-03-14T07:30:00+00:00"          # 02:30 does not exist; 03:30 EDT
    assert got[0]["at_local"] == "2027-03-14T03:30:00-04:00" and got[0]["dst_shifted"] is True
    assert got[1]["at_local"] == "2027-03-15T02:30:00-04:00" and got[1]["dst_shifted"] is False
    assert len({g["at_utc"][:10] for g in got}) == 3                # exactly one fire per day


def test_dst_fall_back_0130_fires_once():
    s = triggers.validate_schedule({"kind": "daily", "time_of_day": "01:30", "timezone": NY})
    got = triggers.preview(s, 4, now=utc(2026, 10, 31, 12, 0))
    assert [g["at_utc"] for g in got] == ["2026-11-01T05:30:00+00:00", "2026-11-02T06:30:00+00:00",
                                          "2026-11-03T06:30:00+00:00", "2026-11-04T06:30:00+00:00"]


# ------------------------------------------------------------------------------------------------ log context
def _ctx(**kw):
    rows, mirrored = [], []
    c = JobContext(run_id=1, plant="P", job_id=1, sink=rows.extend,
                   mirror=lambda *a: mirrored.append(a), flush_interval_s=0, **kw)
    return c, rows, mirrored


def test_log_caps_message_and_data():
    c, rows, _ = _ctx()
    c.log("info", "x" * 5000, big={"k": "y" * 20000}, small={"a": 1})
    c.flush()
    assert len(rows[0]["msg"].encode()) <= jctx.MSG_MAX_BYTES and rows[0]["msg"].endswith("[truncated]")
    assert rows[0]["data"]["_truncated"] is True
    c.log("info", "ok", small={"a": 1})
    assert rows[1]["data"] == {"small": {"a": 1}}


def test_log_line_cap_writes_marker_and_flags_truncated():
    c, rows, _ = _ctx()
    for i in range(jctx.MAX_LINES + 50):
        c.log("info", f"line {i}")
    c.flush()
    assert len(rows) == jctx.MAX_LINES and c.truncated
    assert [r["seq"] for r in rows] == list(range(1, jctx.MAX_LINES + 1))
    assert rows[-1]["level"] == "warn" and "truncated" in rows[-1]["msg"]


def test_warn_and_error_are_mirrored_info_is_not():
    c, _, mirrored = _ctx()
    c.log("info", "a")
    c.log("warn", "b")
    c.log("error", "c")
    assert [m[0] for m in mirrored] == ["warn", "error"]


def test_step_logs_duration_and_error():
    c, rows, _ = _ctx()
    with c.step("load"):
        pass
    with pytest.raises(RuntimeError):
        with c.step("boom"):
            raise RuntimeError("bad")
    c.flush()
    done = [r for r in rows if r["step"] == "load" and r["level"] == "info"][0]
    assert done["duration_ms"] is not None
    assert [r["level"] for r in rows if r["step"] == "boom"] == ["debug", "error"]


def test_cancel_raises_in_sleep_and_check():
    c, _, _ = _ctx()
    c.cancel_event.set()
    with pytest.raises(JobCancelled):
        c.sleep(5)
    with pytest.raises(JobCancelled):
        c.check_cancel()


# ------------------------------------------------------------------------------- registry / types / outcomes
def test_stub_type_hidden_unless_enabled(monkeypatch):
    monkeypatch.delenv("NIMBUS_JOBS_STUBS", raising=False)
    assert registry.get_type("noop") is None and "noop" not in [t.key for t in registry.list_types()]
    assert registry.get_type("optimizer.plant") is not None
    monkeypatch.setenv("NIMBUS_JOBS_STUBS", "1")
    assert registry.get_type("noop") is not None


def test_noop_runs_and_honours_cancel():
    c, rows, _ = _ctx()
    out = noop.run(c, noop.NoopParams(steps=2, sleep_s=0))
    assert out.status == "succeeded" and out.summary == {"steps": 2}
    c2, _, _ = _ctx()
    c2.cancel_event.set()
    with pytest.raises(JobCancelled):
        noop.run(c2, noop.NoopParams(steps=2, sleep_s=1))


def test_optimizer_params_defaults_and_timeout():
    p = optimizer.OptimizerParams()
    assert (p.mode, p.search, p.respect_firmed, p.apply_mode) == ("due_date", "exhaustive", True, "apply")
    assert optimizer.OPTIMIZER.timeout_for(p) == 600
    assert optimizer.OPTIMIZER.timeout_for(optimizer.OptimizerParams(search="normal")) == 120
    with pytest.raises(Exception):
        optimizer.OptimizerParams(mode="remove_backlog")


def test_optimizer_unwired_runner_fails_clearly_then_fake_runner_maps_outcomes():
    c, _, _ = _ctx()
    optimizer.set_runner(None)
    with pytest.raises(NotImplementedError):
        optimizer.run(c, optimizer.OptimizerParams())
    try:
        optimizer.set_runner(lambda ctx, plant, p: {"applied": 12, "dropped": 0, "late": 3})
        assert optimizer.run(c, optimizer.OptimizerParams()).status == "succeeded"
        optimizer.set_runner(lambda ctx, plant, p: {"applied": 10, "dropped": 2})
        out = optimizer.run(c, optimizer.OptimizerParams())
        assert out.status == "warning" and out.summary["dropped"] == 2
        optimizer.set_runner(lambda ctx, plant, p: {"status": "failed", "error": "tool blocked"})
        out = optimizer.run(c, optimizer.OptimizerParams())
        assert out.status == "failed" and out.error == "tool blocked"
    finally:
        optimizer.set_runner(None)


def test_resolve_status_transitions():
    from backend.jobs import runner

    class T:
        def __init__(self, alive=False):
            self._a = alive

        def is_alive(self):
            return self._a

    c, _, _ = _ctx()
    res = runner._resolve
    assert res({"outcome": registry.JobOutcome("warning", {"a": 1})}, c, T(), 60) == ("warning", {"a": 1}, None)
    assert res({"error": "X: y"}, c, T(), 60) == ("failed", None, "X: y")
    assert res({"cancelled": "c"}, c, T(), 60) == ("cancelled", None, None)
    assert res({}, c, T(alive=True), 60)[0] == "failed"
    c.timed_out = True
    assert res({"cancelled": "c"}, c, T(), 60) == ("failed", None, "timed out after 60s")


def test_longer_than_usual_needs_history_and_a_floor():
    from backend.jobs import data
    assert not data.longer_than_usual(10_000, [60, 60])                       # fewer than 3 finished runs
    assert not data.longer_than_usual(250, [60, 60, 60])                      # 2x median = 120 s, floor 300 s wins
    assert data.longer_than_usual(301, [60, 60, 60])
    assert not data.longer_than_usual(1000, [600, 500, 550, 700])             # median 575 -> 1150 s
    assert data.longer_than_usual(1200, [600, 500, 550, 700])


def test_failed_runs_carry_error_kind_step_and_steps():
    from backend.jobs import runner
    c, _, _ = _ctx()
    assert runner._describe_failure("succeeded", {"a": 1}, c) == {"a": 1}
    assert runner._describe_failure("failed", None, c) == {"error_kind": "system"}
    try:
        with c.step("load"):
            raise ValueError("boom")
    except ValueError:
        pass
    out = runner._describe_failure("failed", None, c)
    assert out["failed_step"] == "load" and out["error_kind"] == "system" and out["steps"][0]["step"] == "load"
    kept = runner._describe_failure("failed", {"error_kind": "config", "failed_step": "gather", "steps": [{"step": "x", "duration_ms": 1}]}, c)
    assert (kept["error_kind"], kept["failed_step"], len(kept["steps"])) == ("config", "gather", 1)


def test_scheduler_heartbeat_goes_stale():
    from datetime import datetime, timedelta, timezone
    from backend.jobs import scheduler
    t = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
    scheduler.record_tick(t)
    assert scheduler.heartbeat(t + timedelta(seconds=60))["ok"] is True
    assert scheduler.heartbeat(t + timedelta(seconds=200))["ok"] is False
    assert scheduler.heartbeat(t)["last_tick_at"] == "2026-10-29T12:00:00+00:00"


def test_optimizer_defaults_to_apply():
    from backend.jobs.types.optimizer import OptimizerParams
    assert OptimizerParams().apply_mode == "apply"


def test_retention_getter_clamps(monkeypatch):
    import master_data as md
    for stored, want in [(None, 14), (30, 30), (0, 1), (500, 60), ("7", 7), ("junk", 14), (True, 14)]:
        monkeypatch.setattr(md, "get_system_settings", lambda s=stored: {"job_run_retention_days": s})
        assert md.get_job_run_retention_days() == want


# ============================================================================================== pg tests
@pytest.fixture
def jobs_pg(planning_pg, monkeypatch):
    import backend.jobs.data as data
    monkeypatch.setenv("NIMBUS_JOBS_STUBS", "1")
    data.ensure_job_tables()
    db = planning_pg.db
    yield planning_pg
    with db._pool.connection() as conn, conn.cursor() as cur:
        plants = [planning_pg.plant, planning_pg.other]
        cur.execute("DELETE FROM job_run_log WHERE run_id IN (SELECT id FROM job_run WHERE plant = ANY(%s))", (plants,))
        cur.execute("DELETE FROM job_run WHERE plant = ANY(%s)", (plants,))
        cur.execute("DELETE FROM job_schedule WHERE job_id IN (SELECT id FROM job_definition WHERE plant = ANY(%s))",
                    (plants,))
        cur.execute("DELETE FROM job_definition WHERE plant = ANY(%s)", (plants,))
        conn.commit()


@pytest.fixture
def api(jobs_pg, client):
    """TestClient with the auth dependencies overridden (admin acting as a fixed email, all plants)."""
    import brain
    from backend.security import auth
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_admin] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    yield client
    brain.api.dependency_overrides.clear()


def _mk_job(api, plant, **kw):
    body = {"plant": plant, "job_type": "noop", "name": "t", "params": {"steps": 2, "sleep_s": 0}, **kw}
    r = api.post("/jobs", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _wait(api, run_id, done=("succeeded", "warning", "failed", "cancelled", "skipped"), t=15):
    end = time.time() + t
    while time.time() < end:
        run = api.get(f"/jobs/runs/{run_id}").json()["run"]
        if run["status"] in done:
            return run
        time.sleep(0.1)
    raise AssertionError(f"run {run_id} did not finish: {run}")


@pytest.mark.pg
def test_create_list_preview_upcoming(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    assert j["schedules"][0]["cron_expr"] == "0 8 * * *" and j["schedules"][0]["timezone"] == "UTC"
    assert j["next_run_at"] and j["last_run"] is None
    lst = api.get("/jobs", params={"plant": jobs_pg.plant}).json()
    assert [x["id"] for x in lst["jobs"]] == [j["id"]]
    up = api.get(f"/jobs/{j['id']}/upcoming", params={"n": 3}).json()["entries"]
    assert len(up) == 3 and up[0]["at_utc"] == j["next_run_at"]
    pv = api.post("/jobs/schedules/preview", json={"plant": jobs_pg.plant, "kind": "weekdays",
                                                   "time_of_day": "09:15", "n": 4}).json()
    assert pv["cron_expr"] == "15 9 * * mon-fri" and len(pv["entries"]) == 4
    assert api.get("/jobs/upcoming", params={"plant": jobs_pg.plant, "n": 2}).json()["entries"]
    assert api.get("/jobs/types").json()["types"]


@pytest.mark.pg
def test_validation_errors(api, jobs_pg):
    base = {"plant": jobs_pg.plant, "job_type": "noop", "name": "t"}
    assert api.post("/jobs", json={**base, "job_type": "nope"}).status_code == 400
    assert api.post("/jobs", json={**base, "plant": "ZZ_NO_SUCH"}).status_code == 400
    assert api.post("/jobs", json={**base, "params": {"steps": 9999}}).status_code == 400
    assert api.post("/jobs", json={**base, "schedules": [{"kind": "daily"}]}).status_code == 400
    past = (datetime.now() - timedelta(days=1)).isoformat(timespec="minutes")
    assert api.post("/jobs", json={**base, "schedules": [{"kind": "once", "run_at": past}]}).status_code == 400
    assert api.get("/jobs/runs/999999999").status_code == 404


@pytest.mark.pg
def test_patch_job_and_schedule(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    p = api.patch(f"/jobs/{j['id']}", json={"name": "renamed", "enabled": False}).json()
    assert p["name"] == "renamed" and p["enabled"] is False and p["next_run_at"] is None
    s = api.patch(f"/jobs/schedules/{sid}", json={"time_of_day": "09:30"}).json()
    assert s["cron_expr"] == "30 9 * * *"
    s = api.patch(f"/jobs/schedules/{sid}", json={"kind": "weekly", "days_of_week": [1], "time_of_day": "07:00"}).json()
    assert s["cron_expr"] == "0 7 * * tue"
    s = api.patch(f"/jobs/schedules/{sid}", json={"paused": True}).json()
    assert s["paused"] is True
    new = api.post(f"/jobs/{j['id']}/schedules", json={"kind": "hourly", "time_of_day": "00:10"}).json()
    assert new["cron_expr"] == "10 * * * *"
    assert api.patch(f"/jobs/{j['id']}", json={"archived": True}).json()["archived"] is True
    assert api.get("/jobs", params={"plant": jobs_pg.plant}).json()["jobs"] == []
    assert len(api.get("/jobs", params={"plant": jobs_pg.plant, "include_archived": True}).json()["jobs"]) == 1


@pytest.mark.pg
def test_run_now_lifecycle_and_log_api(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant)
    run = api.post(f"/jobs/{j['id']}/run").json()["run"]
    assert run["trigger"] == "manual" and run["triggered_by"] == "admin@example.com"
    fin = _wait(api, run["id"])
    assert fin["status"] == "succeeded" and fin["summary"] == {"steps": 2} and fin["duration_ms"] is not None
    log = api.get(f"/jobs/runs/{run['id']}/log").json()
    assert log["done"] is True and log["lines"][0]["seq"] == 1 and log["last_seq"] == log["lines"][-1]["seq"]
    assert [l["seq"] for l in log["lines"]] == sorted(l["seq"] for l in log["lines"])
    nxt = api.get(f"/jobs/runs/{run['id']}/log", params={"after_seq": log["last_seq"]}).json()
    assert nxt["lines"] == []
    info = api.get(f"/jobs/runs/{run['id']}/log", params={"level": "info"}).json()["lines"]
    assert info and all(l["level"] != "debug" for l in info)
    listed = api.get("/jobs/runs", params={"plant": jobs_pg.plant}).json()
    assert [r["id"] for r in listed["runs"]] == [run["id"]]
    assert api.get("/jobs", params={"plant": jobs_pg.plant, "status": "succeeded"}).json()["jobs"]
    assert api.get("/jobs/runs", params={"status": "bogus"}).status_code == 400
    assert api.get(f"/jobs/runs/{run['id']}/log", params={"level": "x"}).status_code == 400


@pytest.mark.pg
def test_failed_and_warning_outcomes(api, jobs_pg):
    jf = _mk_job(api, jobs_pg.plant, params={"steps": 1, "sleep_s": 0, "outcome": "failed"})
    jw = _mk_job(api, jobs_pg.plant, params={"steps": 1, "sleep_s": 0, "outcome": "warning"})
    rf = _wait(api, api.post(f"/jobs/{jf['id']}/run").json()["run"]["id"])
    rw = _wait(api, api.post(f"/jobs/{jw['id']}/run").json()["run"]["id"])
    assert rf["status"] == "failed" and rf["error"] == "noop was told to fail"
    assert rw["status"] == "warning"


@pytest.mark.pg
def test_cancel_running_run(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant, params={"steps": 40, "sleep_s": 1})
    run = api.post(f"/jobs/{j['id']}/run").json()["run"]
    _wait(api, run["id"], done=("running",))
    assert api.post(f"/jobs/runs/{run['id']}/cancel").status_code == 200
    assert _wait(api, run["id"])["status"] == "cancelled"
    assert api.post(f"/jobs/runs/{run['id']}/cancel").status_code == 409


@pytest.mark.pg
def test_overlap_records_a_skipped_run(api, jobs_pg):
    import backend.jobs.data as data
    db = jobs_pg.db
    j = _mk_job(api, jobs_pg.plant)
    key = f"jobs:noop:{jobs_pg.plant}"
    with db._pool.connection() as conn:                       # another session holds the type+plant lock
        assert data.try_session_lock(conn, key)
        try:
            run = api.post(f"/jobs/{j['id']}/run").json()["run"]
            fin = _wait(api, run["id"])
        finally:
            data.release_session_lock(conn, key)
    assert fin["status"] == "skipped" and "still running" in fin["error"]


@pytest.mark.pg
def test_hard_timeout_fails_the_run(api, jobs_pg, monkeypatch):
    from backend.jobs import runner
    monkeypatch.setattr(runner, "KILL_GRACE_S", 3.0)
    j = _mk_job(api, jobs_pg.plant, params={"steps": 50, "sleep_s": 1}, timeout_s=10)
    run = api.post(f"/jobs/{j['id']}/run").json()["run"]
    fin = _wait(api, run["id"], t=30)
    assert fin["status"] == "failed" and fin["error"] == "timed out after 10s"


@pytest.mark.pg
def test_boot_sweep_marks_stale_runs_failed(api, jobs_pg):
    import backend.jobs.data as data
    j = _mk_job(api, jobs_pg.plant)
    rid = data.insert_run(job_id=j["id"], schedule_id=None, plant=jobs_pg.plant, job_type="noop",
                          status="scheduled", trigger="manual")
    data.mark_running(rid)
    assert data.boot_sweep() >= 1
    run = api.get(f"/jobs/runs/{rid}").json()["run"]
    assert run["status"] == "failed" and run["error"] == "interrupted by restart" and run["ended_at"]
    assert run["summary"]["error_kind"] == "system"


@pytest.mark.pg
def test_summary_counts_filters_and_restart(api, jobs_pg):
    import backend.jobs.data as data
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    mk = lambda **kw: data.insert_run(job_id=j["id"], plant=jobs_pg.plant, job_type="noop", trigger="schedule", **kw)  # noqa: E731
    mk(schedule_id=sid, status="failed", error="boom")
    mk(schedule_id=sid, status="skipped", error="missed: fired after its grace time")
    mk(schedule_id=None, status="skipped", error="previous run still running")
    live = mk(schedule_id=None, status="scheduled")
    s = api.get("/jobs/summary", params={"plant": jobs_pg.plant}).json()
    assert (s["failed_24h"], s["missed_24h"], s["queued"], s["running"]) == (1, 1, 1, 0)
    assert s["next_fire"]["job_id"] == j["id"] and "ok" in s["scheduler"]
    missed = api.get("/jobs/runs", params={"plant": jobs_pg.plant, "status": "missed"}).json()["runs"]
    assert [r["error"][:7] for r in missed] == ["missed:"]
    daily = api.get("/jobs/runs", params={"plant": jobs_pg.plant, "periodicity": "daily"}).json()["runs"]
    assert len(daily) == 2 and all(r["schedule_id"] == sid for r in daily)
    assert len(api.get("/jobs/runs", params={"plant": jobs_pg.plant, "periodicity": "manual"}).json()["runs"]) == 2
    assert api.post(f"/jobs/runs/{live}/restart").status_code == 409, "a run is still queued"
    data.finish_run(live, "failed", None, "x", False)
    r = api.post(f"/jobs/runs/{live}/restart")
    assert r.status_code == 200 and r.json()["run"]["trigger"] == "manual"
    _wait(api, r.json()["run"]["id"])


@pytest.mark.pg
def test_misfire_recorded_as_skipped_and_once_is_retired(api, jobs_pg):
    import backend.jobs.data as data
    from backend.jobs import runner
    run_at = (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes")
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "once", "run_at": run_at}])
    sid = j["schedules"][0]["id"]
    rid = runner.record_skipped(sid, datetime.now(timezone.utc), "missed: fired after its grace time")
    run = api.get(f"/jobs/runs/{rid}").json()["run"]
    assert run["status"] == "skipped" and run["trigger"] == "schedule" and run["schedule_id"] == sid
    assert data.get_schedule(sid)["retired"] is True
    assert api.get(f"/jobs/{j['id']}/upcoming").json()["entries"] == []


@pytest.mark.pg
def test_fire_schedule_runs_and_retires_once(api, jobs_pg):
    import backend.jobs.data as data
    from backend.jobs import runner
    run_at = (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes")
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "once", "run_at": run_at}])
    sid = j["schedules"][0]["id"]
    rid = runner.fire_schedule(sid)
    assert _wait(api, rid)["status"] == "succeeded"
    assert data.get_schedule(sid)["retired"] is True
    assert api.get(f"/jobs/runs/{rid}").json()["run"]["trigger"] == "schedule"
    assert runner.fire_schedule(sid) is None                  # spent: never fires twice


@pytest.mark.pg
def test_reconcile_arms_replaces_and_removes(api, jobs_pg):
    from apscheduler.schedulers.background import BackgroundScheduler
    from backend.jobs import scheduler as js
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00",
                                                "misfire_grace_s": 120}])
    sid = j["schedules"][0]["id"]
    # Started (paused) so add_job(replace_existing) really replaces: on an unstarted scheduler APScheduler
    # appends a duplicate pending entry and remove_job only drops the first. Paused = nothing ever fires.
    sch = BackgroundScheduler()
    sch.start(paused=True)
    js._SIGS.clear()
    js.reconcile(sch)
    job = sch.get_job(f"job:{sid}")
    assert job is not None and job.max_instances == 1 and job.coalesce and job.misfire_grace_time == 120
    assert js.reconcile(sch)["added"] == 0                    # idempotent
    api.patch(f"/jobs/schedules/{sid}", json={"time_of_day": "09:00"})
    assert js.reconcile(sch)["added"] == 1                    # replaced on change
    api.patch(f"/jobs/schedules/{sid}", json={"paused": True})
    assert js.reconcile(sch)["removed"] == 1 and sch.get_job(f"job:{sid}") is None
    api.patch(f"/jobs/schedules/{sid}", json={"paused": False})
    api.patch(f"/jobs/{j['id']}", json={"enabled": False})
    js.reconcile(sch)
    assert sch.get_job(f"job:{sid}") is None
    sch.shutdown(wait=False)


@pytest.mark.pg
def test_retention_sweep_removes_old_runs_and_logs(api, jobs_pg):
    import backend.jobs.data as data
    db = jobs_pg.db
    j = _mk_job(api, jobs_pg.plant)
    old = data.insert_run(job_id=j["id"], schedule_id=None, plant=jobs_pg.plant, job_type="noop",
                          status="succeeded", trigger="manual")
    keep = data.insert_run(job_id=j["id"], schedule_id=None, plant=jobs_pg.plant, job_type="noop",
                           status="succeeded", trigger="manual")
    running = data.insert_run(job_id=j["id"], schedule_id=None, plant=jobs_pg.plant, job_type="noop",
                              status="running", trigger="manual")
    now = datetime.now(timezone.utc)
    data.write_log_rows(old, [{"seq": 1, "at": now, "level": "info", "step": None, "msg": "m",
                               "duration_ms": None, "data": None}])
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET created_at = now() - interval '30 days' WHERE id = ANY(%s)", ([old, running],))
        conn.commit()
    res = data.sweep_job_runs(retention_days=7, pause_s=0)
    assert res["error"] is None and not res["locked"] and res["deleted_log_lines"] >= 1
    assert api.get(f"/jobs/runs/{old}").status_code == 404
    assert api.get(f"/jobs/runs/{keep}").status_code == 200
    assert api.get(f"/jobs/runs/{running}").status_code == 200        # never sweeps a live run


@pytest.mark.pg
def test_rbac_non_admin_cannot_write_and_plant_scoping(jobs_pg, client, monkeypatch):
    import brain
    from backend.security import auth
    j_plant = jobs_pg.plant
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    brain.api.dependency_overrides[auth.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [jobs_pg.other]
    monkeypatch.setattr(auth, "get_user_role", lambda email: "planner")
    monkeypatch.setattr(auth, "admin_exists", lambda: True)
    try:
        body = {"plant": j_plant, "job_type": "noop", "name": "x"}
        assert client.post("/jobs", json=body).status_code == 403               # not admin
        assert client.post("/jobs/1/run").status_code == 403
        assert client.patch("/jobs/1", json={"name": "y"}).status_code == 403
        assert client.post("/jobs/runs/1/cancel").status_code == 403
        # reads: allowed for a non-admin, but only inside their plants
        assert client.get("/jobs", params={"plant": j_plant}).status_code == 403
        assert client.get("/jobs/runs", params={"plant": j_plant}).status_code == 403
        assert client.get("/jobs", params={"plant": jobs_pg.other}).status_code == 200
        assert client.get("/jobs/types").status_code == 200
        # an admin scoped to other plants cannot write into this plant either
        brain.api.dependency_overrides[auth.require_admin] = lambda: "scoped-admin@example.com"
        assert client.post("/jobs", json=body).status_code == 403
        # unauthenticated read
        brain.api.dependency_overrides.pop(auth.require_authenticated)
        assert client.get("/jobs").status_code == 401
    finally:
        brain.api.dependency_overrides.clear()


@pytest.mark.pg
def test_jobs_never_listed_across_foreign_plants(api, jobs_pg):
    from backend.security import auth
    import brain
    j = _mk_job(api, jobs_pg.plant)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [jobs_pg.other]
    assert api.get("/jobs").json()["jobs"] == []
    assert api.get(f"/jobs/{j['id']}/upcoming").status_code == 403
    assert api.get("/jobs/runs").json()["runs"] == []


@pytest.mark.pg
def test_system_settings_validates_job_run_retention(api):
    for bad in (0, 61, "7", True, 1.5):
        assert api.post("/system-settings", json={"job_run_retention_days": bad}).status_code == 400


def test_admin_write_operations_registered():
    import brain
    for path in ("/jobs", "/jobs/{job_id}", "/jobs/{job_id}/schedules", "/jobs/schedules/{schedule_id}",
                 "/jobs/{job_id}/run", "/jobs/runs/{run_id}/cancel", "/jobs/runs/{run_id}/restart"):
        assert path in brain._ADMIN_WRITE_OPERATIONS
    assert {"job_id", "schedule_id", "run_id"} <= brain._ADMIN_TARGET_PARAMS

