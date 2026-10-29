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
    """The process was down for `days`: the schedule's last edit and the last fire its (plant-less) arm saw are that old."""
    _sql(db, "UPDATE job_schedule SET modified_at = clock_timestamp() - make_interval(days => %s),"
             " last_fire_at = clock_timestamp() - make_interval(days => %s), arm_fire_at = NULL WHERE id = %s", days, days, sid)


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


# ------------------------------------------------------------------------------------ W3b fix wave (pg)
@pytest.mark.pg
def test_catch_up_baselines_are_per_arm_so_three_plants_keep_their_own_misses(api, jobs_pg):
    """One arm's fire used to stamp the schedule-wide last_fire_at, so the arms armed after it lost their misses."""
    from backend.jobs import data
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    old = datetime.now(timezone.utc) - timedelta(days=2)
    _sql(jobs_pg.db, "UPDATE job_schedule SET modified_at = %s, last_fire_at = NULL,"
                     " arm_fire_at = jsonb_build_object('P1', %s::text, 'P2', %s::text, 'P3', %s::text) WHERE id = %s",
         old - timedelta(days=1), old.isoformat(), old.isoformat(), old.isoformat(), sid)
    data.touch_last_fire(sid, "P1")                       # plant 1 fires first, as the first arm of the batch
    b1, b2, b3 = (data.schedule_baseline(sid, p, arm=p) for p in ("P1", "P2", "P3"))
    assert b1 > old + timedelta(days=1), "P1's own baseline moved"
    assert abs((b2 - old).total_seconds()) < 2 and abs((b3 - old).total_seconds()) < 2, "P2 and P3 keep their own"


@pytest.mark.pg
def test_no_reliable_baseline_means_no_missed_storm_and_resume_moves_the_floor(api, jobs_pg):
    from backend.jobs import data, runner
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": _utc_time_of_day(20)}])
    sid = j["schedules"][0]["id"]
    _sql(jobs_pg.db, "UPDATE job_schedule SET modified_at = clock_timestamp() - interval '9 days', last_fire_at = NULL,"
                     " arm_fire_at = NULL WHERE id = %s", sid)          # an upgrade: old schedule, no watermark, no runs
    assert data.schedule_baseline(sid, jobs_pg.plant) is None
    assert runner.run_catch_up(sid) is None and _runs(api, j["id"]) == [], "no 'process was down' storm"
    assert data.schedule_baseline(sid, jobs_pg.plant) is not None, "the first boot seeds the watermark"
    # a disabled job re-enabled later: the pause is not process downtime
    _sql(jobs_pg.db, "UPDATE job_schedule SET modified_at = clock_timestamp() - interval '9 days',"
                     " arm_fire_at = jsonb_build_object('*', (clock_timestamp() - interval '9 days')::text) WHERE id = %s", sid)
    api.patch(f"/jobs/{j['id']}", json={"enabled": False})
    api.patch(f"/jobs/{j['id']}", json={"enabled": True})
    base = data.schedule_baseline(sid, jobs_pg.plant)
    assert base > datetime.now(timezone.utc) - timedelta(minutes=2), "re-enable bumped the floor"
    assert runner.run_catch_up(sid) is None and not [r for r in _runs(api, j["id"]) if r["status"] == "skipped"]
    api.patch(f"/jobs/{j['id']}", json={"archived": True})
    _sql(jobs_pg.db, "UPDATE job_schedule SET modified_at = clock_timestamp() - interval '9 days' WHERE id = %s", sid)
    api.patch(f"/jobs/{j['id']}", json={"archived": False})
    assert data.schedule_baseline(sid, jobs_pg.plant) > datetime.now(timezone.utc) - timedelta(minutes=2), "restore too"


@pytest.mark.pg
def test_overlap_twice_second_fire_runs_and_default_once_dedupes_it(api, chicago):
    """Chicago 01:30 on 2026-11-01 happens twice (06:30Z CDT, 07:30Z CST)."""
    from backend.jobs import runner
    first, second = (datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc), datetime(2026, 11, 1, 7, 30, tzinfo=timezone.utc))
    tw = _mk_job(api, chicago.plant, name="twice", schedules=[{"kind": "daily", "time_of_day": "01:30", "options": {"dst_overlap": "twice"}}])
    sid = tw["schedules"][0]["id"]
    assert runner.fire_schedule(sid, fired_at=first)
    assert runner.fire_schedule(sid, fired_at=second), "the second pass is a deliberate fire (the preview lists it)"
    assert len([r for r in _runs(api, tw["id"]) if r["trigger"] == "schedule"]) == 2
    one = _mk_job(api, chicago.plant, name="once", schedules=[{"kind": "daily", "time_of_day": "01:30"}])
    oid = one["schedules"][0]["id"]
    assert runner.fire_schedule(oid, fired_at=first)
    assert runner.fire_schedule(oid, fired_at=second) is None, "default 'once': one run that local date"
    assert len([r for r in _runs(api, one["id"]) if r["trigger"] == "schedule"]) == 1


@pytest.mark.pg
def test_a_pool_delayed_fire_is_rechecked_at_its_fire_time_not_at_dequeue_time(api, jobs_pg):
    from backend.jobs import runner
    t = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=10)
    lo, hi = (t - timedelta(minutes=5)).strftime("%H:%M"), (t + timedelta(minutes=5)).strftime("%H:%M")
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": t.strftime("%H:%M"),
                                                "options": {"run_window": {"start": lo, "end": hi, "action": "skip"}}}])
    sid = j["schedules"][0]["id"]
    assert runner.fire_schedule(sid, fired_at=t), "inside the window when it fired; the pool started it 10 minutes later"
    assert [r["status"] for r in _runs(api, j["id"])] != ["skipped"]


@pytest.mark.pg
def test_catch_up_retests_the_current_time_against_window_and_closed_day(api, jobs_pg):
    from backend.jobs import runner
    now = datetime.now(timezone.utc)
    lo, hi = (now + timedelta(hours=2)).strftime("%H:00"), (now + timedelta(hours=3)).strftime("%H:00")
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00",
                                                "options": {"run_window": {"start": lo, "end": hi, "action": "skip"}}}])
    sid = j["schedules"][0]["id"]
    assert runner.fire_schedule(sid, catchup_for=now - timedelta(minutes=20)) is None
    runs = _runs(api, j["id"])
    assert [r["status"] for r in runs] == ["skipped"] and runs[0]["error"] == "outside run window"
    assert not [r for r in runs if r["trigger"] == "catchup"]


@pytest.mark.pg
def test_system_settings_cannot_write_jobs_keys_and_get_hides_who_paused(api, jobs_pg, monkeypatch):
    import master_data as md
    from backend.jobs import data
    for key in ("jobs_paused", "jobs_paused_at", "jobs_paused_by"):
        r = api.post("/system-settings", json={key: "x"})
        assert r.status_code == 400 and "/jobs/maintenance" in r.text, key
    try:
        api.post("/jobs/maintenance", json={"enabled": True})
        blob = api.get("/system-settings").json()
        assert blob["jobs_paused"] is True and "jobs_paused_by" not in blob, "no admin identity on the unauthenticated read"
        assert api.get("/jobs/summary").json()["maintenance"]["by"] == "admin@example.com"
    finally:
        api.post("/jobs/maintenance", json={"enabled": False})
    for stored, want in (("false", False), ("False", False), ("0", False), ("", False), ("true", True), (True, True), (None, False)):
        monkeypatch.setattr(md, "get_system_settings", lambda s=stored: {"jobs_paused": s})
        assert data.maintenance_state(fresh=True)["enabled"] is want, stored


@pytest.mark.pg
def test_last_success_watermark_and_ran_on_count_catchup_runs(api, jobs_pg):
    from backend.jobs import data
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    at = datetime.now(timezone.utc) - timedelta(minutes=30)
    rid = data.insert_run(job_id=j["id"], schedule_id=sid, plant=jobs_pg.plant, job_type="noop", status="succeeded",
                          trigger="catchup", scheduled_for=at)
    _sql(jobs_pg.db, "UPDATE job_run SET started_at = %s WHERE id = %s", at, rid)
    assert data.last_success_watermark(j["id"], None, jobs_pg.plant) is not None
    assert data.schedule_ran_on(sid, jobs_pg.plant, "UTC", at.date())


@pytest.mark.pg
def test_timeline_reports_upcoming_truncation_and_bad_instants_are_400(api, jobs_pg):
    j = _mk_job(api, jobs_pg.plant, schedules=[{"kind": "hourly", "time_of_day": "00:00"}])
    now = datetime.now(timezone.utc)
    q = {"plant": jobs_pg.plant, "from": now.isoformat(), "to": (now + timedelta(days=7)).isoformat()}
    body = api.get("/jobs/timeline", params=q).json()
    assert body["upcoming_truncated"] is True and len(body["lanes"][0]["upcoming"]) == 100, "168 hourly fires, capped at 100 per arm"
    short = api.get("/jobs/timeline", params={**q, "to": (now + timedelta(hours=6)).isoformat()}).json()
    assert short["upcoming_truncated"] is False
    assert api.get("/jobs/timeline", params={"from": "0001-01-01T00:00:00+14:00"}).status_code == 400
    assert j


def test_trigger_ddl_is_race_safe_and_the_arm_column_is_mirrored():
    import backend.jobs.data as data
    assert "DROP CONSTRAINT IF EXISTS job_run_trigger_check" in data.JOB_TRIGGER_DDL
    assert "EXCEPTION WHEN duplicate_object OR undefined_object" in data.JOB_TRIGGER_DDL
    assert "arm_fire_at JSONB" in data.JOB_COLUMN_DDL and data.JOB_COLUMN_DDL.strip() in _read("schema.sql")
