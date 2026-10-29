"""W3b against a real (throwaway) Postgres: options round trip, maintenance mode, catch-up end to end, the fire-time
policy re-check on the real calendar, calendar-version re-arm, the timeline route, and the schema pins.

Needs NIMBUS_TEST_DB=1 and a local database (see tests/conftest.py); everything else is in test_jobs_policy.py."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from tests.test_jobs import _mk_job, api, jobs_pg  # noqa: F401 - fixtures

pytest_plugins = ("tests.support.planning_pg",)
ROOT = Path(__file__).resolve().parent.parent
CLOSED_WEEK = {str(d): None for d in range(7)}


def _runs(api, job_id, **q):
    return api.get("/jobs/runs", params={"job_id": job_id, "limit": 100, **q}).json()["runs"]


def _sql(db, sql, *args):
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, args)
        out = cur.fetchall() if cur.description else None
        conn.commit()
    return out


def _utc_time_of_day(minutes_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%H:%M")


# ------------------------------------------------------------------------------------------------- options
@pytest.mark.pg
def test_options_round_trip_and_legacy_schedules_stay_null(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant, schedules=[
        {"kind": "daily", "time_of_day": "08:00"},
        {"kind": "daily", "time_of_day": "09:00", "options": {"closed_day": "skip", "catch_up": {"enabled": False, "grace_s": 600}}}])
    legacy, opt = j["schedules"]
    assert legacy["options"] is None and legacy["last_fire_at"] is None
    assert opt["options"]["closed_day"] == "skip" and opt["options"]["catch_up"] == {"enabled": False, "grace_s": 600}
    assert api.patch(f"/jobs/schedules/{opt['id']}", json={"time_of_day": "09:30"}).json()["options"]["closed_day"] == "skip", \
        "a timing edit keeps the policy"
    assert api.patch(f"/jobs/schedules/{opt['id']}", json={"options": None}).json()["options"] is None
    r = api.patch(f"/jobs/schedules/{legacy['id']}", json={"options": {"run_window": {"start": "6:00", "end": "18:00", "action": "defer"}}})
    assert r.json()["options"]["run_window"] == {"start": "06:00", "end": "18:00", "action": "defer"}
    assert api.patch(f"/jobs/schedules/{legacy['id']}", json={"options": {"closed_day": "nope"}}).status_code == 400
    pv = api.post("/jobs/schedules/preview", json={"plant": jobs_pg.plant, "kind": "daily", "time_of_day": "02:30", "n": 2,
                                                   "options": {"dst_gap": "skip"}}).json()
    assert len(pv["entries"]) == 2 and "skipped" in pv


# ------------------------------------------------------------------------------------------- maintenance mode
@pytest.mark.pg
def test_maintenance_mode_skips_scheduled_fires_visibly_but_not_manual_runs(api, jobs_pg):
    from backend.jobs import data, runner
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    try:
        st = api.post("/jobs/maintenance", json={"enabled": True}).json()
        assert st["enabled"] is True and st["by"] == "admin@example.com"
        assert api.get("/jobs/summary").json()["maintenance"]["enabled"] is True
        assert runner.fire_schedule(sid) is None
        run = _runs(api, j["id"])[0]
        assert run["status"] == "skipped" and run["error"] == "maintenance mode" and run["trigger"] == "schedule"
        assert run["summary"]["skipped_reason"] == "maintenance"
        assert api.get("/jobs/runs", params={"job_id": j["id"], "status": "missed"}).json()["runs"] == [], "Skipped, not Missed"
        assert data.get_schedule(sid)["last_fire_at"] is not None
        manual = api.post(f"/jobs/{j['id']}/run").json()["run"]
        from tests.test_jobs import _wait
        assert _wait(api, manual["id"])["status"] == "succeeded", "manual Run now still works"
    finally:
        api.post("/jobs/maintenance", json={"enabled": False})
    assert api.get("/jobs/summary").json()["maintenance"]["enabled"] is False
    rid = runner.fire_schedule(sid)
    assert rid and api.get(f"/jobs/runs/{rid}").json()["run"]["trigger"] == "schedule"


# ------------------------------------------------------------------------------------------------- catch-up
def _age_schedule(db, sid, days=2):
    _sql(db, "UPDATE job_schedule SET modified_at = clock_timestamp() - make_interval(days => %s), last_fire_at = NULL WHERE id = %s",
         days, sid)


@pytest.mark.pg
def test_catch_up_fires_the_latest_miss_once_and_counts_the_older_ones(api, jobs_pg):
    from backend.jobs import data, runner
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(20)}])
    sid = j["schedules"][0]["id"]
    _age_schedule(jobs_pg.db, sid)
    res = runner.run_catch_up(sid)
    assert res == {"fired": True, "missed": 1}
    runs = _runs(api, j["id"])
    caught = [r for r in runs if r["trigger"] == "catchup"]
    missed = [r for r in runs if r["status"] == "skipped"]
    assert len(caught) == 1 and caught[0]["status"] in ("succeeded", "scheduled", "running")
    expected = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=20)
    assert abs((datetime.fromisoformat(caught[0]["scheduled_for"]) - expected).total_seconds()) <= 60 or \
        abs((datetime.fromisoformat(caught[0]["scheduled_for"]) - expected + timedelta(days=1)).total_seconds()) <= 60, \
        "scheduled_for is the EXPECTED fire time"
    assert len(missed) == 1 and re.fullmatch(r"missed: process was down \(1 fire\)", missed[0]["error"])
    assert api.get("/jobs/runs", params={"job_id": j["id"], "status": "missed"}).json()["runs"], "the Missed tile sees downtime"
    again = runner.run_catch_up(sid)
    assert again is None, "never double-fires: the baseline moved past the caught-up fire"
    assert len([r for r in _runs(api, j["id"]) if r["trigger"] == "catchup"]) == 1


@pytest.mark.pg
def test_catch_up_beyond_grace_only_records_one_missed_run_and_skips_paused_retired_disabled(api, jobs_pg):
    from backend.jobs import runner
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(180)}])
    sid = j["schedules"][0]["id"]
    _age_schedule(jobs_pg.db, sid, 3)
    res = runner.run_catch_up(sid)
    assert res["fired"] is False and res["missed"] == 3
    runs = _runs(api, j["id"])
    assert [r["status"] for r in runs] == ["skipped"] and "process was down (3 fires)" in runs[0]["error"]
    assert not [r for r in runs if r["trigger"] == "catchup"]
    for patch in ({"paused": True}, {"retired": True}):
        k = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(20)}])
        ks = k["schedules"][0]["id"]
        _age_schedule(jobs_pg.db, ks)
        api.patch(f"/jobs/schedules/{ks}", json=patch)
        _age_schedule(jobs_pg.db, ks)
        assert runner.run_catch_up(ks) is None and _runs(api, k["id"]) == []
    d = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(20)}])
    api.patch(f"/jobs/{d['id']}", json={"enabled": False})
    _age_schedule(jobs_pg.db, d["schedules"][0]["id"])
    assert runner.run_catch_up(d["schedules"][0]["id"]) is None and _runs(api, d["id"]) == []


@pytest.mark.pg
def test_catch_up_is_skipped_when_a_run_already_covers_the_fire_and_never_for_once(api, jobs_pg):
    from backend.jobs import data, runner
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(20)}])
    sid = j["schedules"][0]["id"]
    expected = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=20)
    data.insert_run(job_id=j["id"], schedule_id=sid, plant=jobs_pg.plant, job_type="noop", status="succeeded",
                    trigger="schedule", scheduled_for=expected + timedelta(seconds=3))
    _age_schedule(jobs_pg.db, sid)
    runner.run_catch_up(sid)
    assert not [r for r in _runs(api, j["id"]) if r["trigger"] == "catchup"], "the late normal fire already counts"
    once = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "once", "run_at": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M"),
                                                   "tz_mode": "utc"}])
    assert runner.run_catch_up(once["schedules"][0]["id"]) is None


@pytest.mark.pg
def test_reconcile_queues_catch_up_for_new_arms_in_bounded_batches(api, jobs_pg, monkeypatch):
    from apscheduler.schedulers.background import BackgroundScheduler
    from backend.jobs import scheduler as js
    seen = []
    monkeypatch.setattr(js.runner, "run_catch_up", lambda sid, plant=None: seen.append(sid))
    monkeypatch.setattr(js, "CATCHUP_PER_TICK", 2)
    js._CATCHUP_QUEUE.clear()
    jobs = [_mk_job(api, jobs_pg.plant, name=f"c{i}", schedules=[{"kind": "daily", "time_of_day": "08:00"}]) for i in range(5)]
    sch = BackgroundScheduler()
    sch.start(paused=True)
    js._SIGS.clear()
    out = js.reconcile(sch)
    assert out["added"] >= 5 and out["catchup"] == 2 and len(js._CATCHUP_QUEUE) >= 3, "boot work is bounded per tick"
    import time
    time.sleep(0.3)
    assert len(seen) == 2
    assert js._drain_catchup(100) >= 3
    js._CATCHUP_QUEUE.clear()
    sch.shutdown(wait=False)
    assert jobs


# --------------------------------------------------------------- fire-time policy re-check on the real calendar
@pytest.fixture
def chicago(jobs_pg):
    db = jobs_pg.db
    old = _sql(db, "SELECT subnetwork, timezone, work_hours FROM plants WHERE plant = %s", jobs_pg.plant)
    _sql(db, "UPDATE plants SET timezone = 'America/Chicago' WHERE plant = %s", jobs_pg.plant)
    yield jobs_pg
    for sub, tz, wh in old:
        with db._pool.connection() as conn, conn.cursor() as cur:
            from psycopg.types.json import Jsonb
            cur.execute("UPDATE plants SET timezone = %s, work_hours = %s WHERE plant = %s AND subnetwork = %s",
                        (tz, Jsonb(wh) if wh is not None else None, jobs_pg.plant, sub))
            conn.commit()


@pytest.mark.pg
def test_fire_time_recheck_records_a_skipped_run_when_the_window_or_calendar_now_rejects(api, chicago):
    from psycopg.types.json import Jsonb
    from backend.jobs import runner
    local = datetime.now(ZoneInfo("America/Chicago"))
    hh = lambda d: f"{(local + timedelta(hours=d)).hour:02d}:00"  # noqa: E731
    t_of_day = (local - timedelta(minutes=30)).strftime("%H:%M")
    w = _mk_job(api, chicago.plant, schedules=[{"kind": "daily", "time_of_day": t_of_day,
                                                "options": {"run_window": {"start": hh(2), "end": hh(3), "action": "skip"}}}])
    assert runner.fire_schedule(w["schedules"][0]["id"]) is None
    run = _runs(api, w["id"])[0]
    assert run["status"] == "skipped" and run["error"] == "outside run window" and run["summary"]["skipped_reason"] == "policy"
    # the real calendar: every day closed -> 'closed day'
    _sql(chicago.db, "UPDATE plants SET work_hours = %s WHERE plant = %s", Jsonb(CLOSED_WEEK), chicago.plant)
    c = _mk_job(api, chicago.plant, schedules=[{"kind": "daily", "time_of_day": t_of_day, "options": {"closed_day": "skip"}}])
    assert runner.fire_schedule(c["schedules"][0]["id"]) is None
    assert _runs(api, c["id"])[0]["error"] == "closed day"
    pv = api.post("/jobs/schedules/preview", json={"plant": chicago.plant, "kind": "daily", "time_of_day": "08:00", "n": 2,
                                                   "options": {"closed_day": "skip"}}).json()
    assert pv["entries"] == [] and pv["skipped"] and pv["skipped"][0]["reason"] == "closed_day", "the preview follows the real calendar"
    nxt = api.post("/jobs/schedules/preview", json={"plant": chicago.plant, "kind": "daily", "time_of_day": "08:00", "n": 2,
                                                    "options": {"closed_day": "run"}}).json()
    assert len(nxt["entries"]) == 2
    # a normal plant calendar again (default week; today may be a weekend, so open every day): the same fire stands
    week = {str(d): [0, 24] for d in range(7)}
    _sql(chicago.db, "UPDATE plants SET work_hours = %s WHERE plant = %s", Jsonb(week), chicago.plant)
    at = (local - timedelta(minutes=30)).replace(second=0, microsecond=0)
    sched, job = runner.data.get_schedule(c["schedules"][0]["id"]), runner.data.get_job(c["id"])
    assert runner._recheck(sched, job, None, at) is None
    _sql(chicago.db, "UPDATE plants SET work_hours = %s WHERE plant = %s", Jsonb(CLOSED_WEEK), chicago.plant)
    assert runner._recheck(sched, job, None, at) == "closed day"


@pytest.mark.pg
def test_a_calendar_edit_rearms_the_schedule_without_a_restart(api, chicago):
    from psycopg.types.json import Jsonb
    from apscheduler.schedulers.background import BackgroundScheduler
    from backend.jobs import scheduler as js
    j = _mk_job(api, chicago.plant, schedules=[{"kind": "daily", "time_of_day": "08:00", "options": {"closed_day": "skip"}}])
    legacy = _mk_job(api, chicago.plant, name="plain", schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sch = BackgroundScheduler()
    sch.start(paused=True)
    js._SIGS.clear()
    js._CATCHUP_QUEUE.clear()
    js.reconcile(sch)
    assert js.reconcile(sch)["added"] == 0, "idempotent while the calendar is unchanged"
    week = {str(d): None if d in (0, 6) else [9, 17] for d in range(7)}
    _sql(chicago.db, "UPDATE plants SET work_hours = %s WHERE plant = %s", Jsonb(week), chicago.plant)
    out = js.reconcile(sch)
    assert out["added"] == 1, "only the calendar-driven schedule re-arms; the plain one is untouched"
    assert js.reconcile(sch)["added"] == 0
    js._CATCHUP_QUEUE.clear()
    sch.shutdown(wait=False)
    assert legacy and j


# ---------------------------------------------------------------------------------------------------- timeline
@pytest.mark.pg
def test_timeline_lists_runs_and_upcoming_per_plant_lane_with_scope_and_paging(api, jobs_pg):
    import brain
    from backend.jobs import data
    from backend.security import auth
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "hourly", "time_of_day": "00:15"}])
    data.insert_run(job_id=j["id"], schedule_id=None, plant=jobs_pg.plant, job_type="noop", status="succeeded",
                    trigger="manual", scheduled_for=datetime.now(timezone.utc) - timedelta(hours=2))
    now = datetime.now(timezone.utc)
    q = {"plant": jobs_pg.plant, "from": (now - timedelta(hours=6)).isoformat(), "to": (now + timedelta(hours=6)).isoformat()}
    body = api.get("/jobs/timeline", params=q).json()
    lane = body["lanes"][0]
    assert lane["plant"] == jobs_pg.plant and lane["runs"] and 5 <= len(lane["upcoming"]) <= 7, "hourly: ~6 fires ahead"
    assert all(u["at_utc"] > body["now_utc"] for u in lane["upcoming"])
    assert api.get("/jobs/timeline", params={**q, "to": (now + timedelta(days=10)).isoformat()}).status_code == 400
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [jobs_pg.other]
    try:
        assert api.get("/jobs/timeline", params=q).status_code == 403
        scoped = api.get("/jobs/timeline", params={k: v for k, v in q.items() if k != "plant"}).json()
        assert jobs_pg.plant not in [l["plant"] for l in scoped["lanes"]]
    finally:
        brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None


# ----------------------------------------------------------------------------------------------- schema pins
def _read(p) -> str:
    return (ROOT / p).read_text(encoding="utf-8").replace("\r\n", "\n")


def test_w3b_columns_come_from_the_hook_and_schema_never_from_a_migration():
    import backend.jobs.data as data
    assert data.JOB_COLUMN_DDL.strip() in _read("schema.sql")
    assert data.JOB_TRIGGER_DDL.strip() in _read("schema.sql")
    for col in ("options", "last_fire_at"):
        assert f"ADD COLUMN IF NOT EXISTS {col} " in data.JOB_COLUMN_DDL
        for mig in (ROOT / "migrations").glob("*job*.sql"):
            assert col not in re.sub(r"--[^\n]*", "", mig.read_text(encoding="utf-8")), mig.name
    assert "CASCADE" not in (data.JOB_COLUMN_DDL + data.JOB_TRIGGER_DDL).upper()


@pytest.mark.pg
def test_ensure_job_tables_is_idempotent_and_allows_the_catchup_trigger(jobs_pg):
    import backend.jobs.data as data
    data.ensure_job_tables()
    data.ensure_job_tables()
    cols = {r[0] for r in _sql(jobs_pg.db, "SELECT column_name FROM information_schema.columns WHERE table_name = 'job_schedule'")}
    assert {"options", "last_fire_at"} <= cols
    (defn,) = _sql(jobs_pg.db, "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'job_run_trigger_check'")[0]
    assert "catchup" in defn and "retry" in defn
