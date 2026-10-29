"""W3a multi-plant jobs: target expansion, per-plant scheduler arms, fan-out batches and their rollup.

Pure tests (no database): `targets.expand_targets`, `scheduler.plan_arms`, `runner.prepare_batch/execute_batch` against an
in-memory fake `data`. `@pytest.mark.pg` tests (local Postgres, NIMBUS_TEST_DB=1) cover the routes, scope checks,
reconcile re-arming, fixed/UTC fan-out, batch rows, the boot sweep and the retention sweep.
"""
import os
import re
import threading
import time
from datetime import datetime, timezone

import pytest
from pydantic import BaseModel

from backend.jobs import runner, scheduler, targets
from backend.jobs.registry import JobOutcome, JobType

pytest_plugins = ("tests.support.planning_pg",)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATION = os.path.join(ROOT, "migrations", "2026-10-31-1-job-targets.sql")
SCHEMA = os.path.join(ROOT, "schema.sql")
DESTRUCTIVE = re.compile(r"\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b", re.IGNORECASE)

PLANTS = [
    {"plant": "1008", "subnetworks": ["NA"], "timezone": "America/Chicago"},
    {"plant": "1021", "subnetworks": ["NA"], "timezone": "America/New_York"},
    {"plant": "2001", "subnetworks": ["EU"], "timezone": "Europe/London"},
    {"plant": "3001", "subnetworks": ["EU"], "timezone": None},
    {"plant": "4001", "subnetworks": ["APAC"], "timezone": "Not/AZone"},
]


def T(kind, value="", excluded=False, params_override=None):
    return {"kind": kind, "value": value, "excluded": excluded, "params_override": params_override}


def expand(rows, home="1008", plants=PLANTS):
    return targets.expand_targets({"plant": home, "targets": rows}, plants=plants)


def codes(exp):
    return [p["plant"] for p in exp["plants"]]


# ------------------------------------------------------------------------------------------------ DDL pins
def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def test_target_ddl_matches_migration_and_schema_verbatim():
    import backend.jobs.data as data
    for path in (MIGRATION, SCHEMA):
        assert data.JOB_TARGET_DDL.strip() in _read(path), path


def test_target_migration_is_create_only_without_destructive_words_or_cascade():
    text = _read(MIGRATION)
    assert not DESTRUCTIVE.search(text) and "CASCADE" not in text.upper()
    stmts = [s.strip() for s in re.sub(r"--[^\n]*", "", text).split(";") if s.strip()]
    assert stmts and all(re.match(r"CREATE (TABLE|INDEX) IF NOT EXISTS", s, re.I) for s in stmts)


def test_new_columns_come_from_the_startup_hook_and_schema_never_from_a_migration():
    import backend.jobs.data as data
    assert data.JOB_COLUMN_DDL.strip() in _read(SCHEMA)
    mig = _read(MIGRATION)
    for col in ("batch_id", "tz_mode", "fixed_timezone", "fan_out", "scope_plants"):
        assert col not in re.sub(r"--[^\n]*", "", mig)
        assert col in data.JOB_COLUMN_DDL
    assert "CASCADE" not in data.JOB_COLUMN_DDL.upper()


# ----------------------------------------------------------------------------------------------- expansion
def test_a_job_without_targets_is_its_home_plant_only():
    exp = targets.expand_targets({"plant": "1008", "targets": []}, plants=PLANTS)
    assert exp["single"] and codes(exp) == ["1008"] and exp["plants"][0]["skip"] is None


def test_explicit_targets_keep_the_order_they_were_given():
    assert codes(expand([T("explicit", "2001"), T("explicit", "1021"), T("explicit", "2001")])) == ["2001", "1021"]


def test_subnetwork_and_all_expand_sorted_and_new_plants_join_at_fire_time():
    assert codes(expand([T("subnetwork", "NA")])) == ["1008", "1021"]
    assert codes(expand([T("all", "*")])) == ["1008", "1021", "2001", "3001", "4001"]
    grown = PLANTS + [{"plant": "1099", "subnetworks": ["NA"], "timezone": "America/Denver"}]
    assert codes(expand([T("subnetwork", "NA")], plants=grown)) == ["1008", "1021", "1099"]


def test_an_all_row_carrying_a_plant_list_never_grows_beyond_it():
    rows = [T("all", "1008,1021,GONE")]
    assert codes(expand(rows)) == ["1008", "1021"]
    assert codes(expand(rows, plants=PLANTS + [{"plant": "1099", "subnetworks": [], "timezone": "UTC"}])) == ["1008", "1021"]


def test_exclusions_remove_plants_from_the_union_whatever_their_position():
    rows = [T("explicit", "1008", excluded=True), T("all", "*"), T("subnetwork", "EU", excluded=True)]
    assert codes(expand(rows)) == ["1021", "4001"]


def test_a_plant_without_a_valid_timezone_is_listed_skipped_with_a_warning():
    exp = expand([T("subnetwork", "EU"), T("explicit", "4001")])
    by = {p["plant"]: p for p in exp["plants"]}
    assert by["2001"]["skip"] is None and by["2001"]["timezone"] == "Europe/London"
    assert by["3001"]["skip"] == targets.SKIP_NO_TZ and by["4001"]["skip"] == targets.SKIP_BAD_TZ
    assert exp["warnings"] == ["3001: plant has no timezone", "4001: plant timezone is not a valid IANA zone"]
    assert codes({"plants": targets.runnable(exp)}) == ["2001"]


def test_a_deleted_plant_is_listed_skipped_not_dropped():
    exp = expand([T("explicit", "1008"), T("explicit", "9999")])
    assert exp["plants"][1] == {"plant": "9999", "timezone": None, "skip": targets.SKIP_GONE, "params_override": {}}


def test_per_plant_overrides_deep_merge_in_row_order():
    rows = [T("subnetwork", "NA", params_override={"a": {"x": 1, "y": 1}, "mode": "spt"}),
            T("explicit", "1021", params_override={"a": {"y": 2}})]
    by = {p["plant"]: p["params_override"] for p in expand(rows)["plants"]}
    assert by["1008"] == {"a": {"x": 1, "y": 1}, "mode": "spt"}
    assert by["1021"] == {"a": {"x": 1, "y": 2}, "mode": "spt"}


def test_normalize_rejects_bad_rows_and_defaults_all_to_star():
    assert targets.normalize_targets([{"kind": "all"}])[0]["value"] == "*"
    for bad in ({"kind": "region", "value": "x"}, {"kind": "explicit"}, {"kind": "all", "excluded": True},
                {"kind": "explicit", "value": "1", "params_override": "x"}):
        with pytest.raises(targets.TargetError):
            targets.normalize_targets([bad])
    assert targets.all_scope_value(None) == "*" and targets.all_scope_value(["b", "a"]) == "a,b"


@pytest.mark.parametrize("statuses,want", [
    ([], "succeeded"), (["succeeded", "succeeded"], "succeeded"),
    (["succeeded", "warning"], "warning"), (["succeeded", "skipped"], "warning"), (["cancelled"], "warning"),
    (["succeeded", "failed", "warning"], "failed"), (["skipped", "failed"], "failed"),
])
def test_batch_rollup_matrix(statuses, want):
    assert targets.rollup(statuses) == want


def test_counts_include_the_total():
    assert targets.counts_of(["succeeded", "failed", "failed"]) == {"total": 3, "succeeded": 1, "failed": 2}


# -------------------------------------------------------------------------------------------- scheduler arms
def sched_row(**kw):
    row = {"id": 7, "job_id": 1, "kind": "daily", "cron_expr": "0 8 * * *", "time_of_day": "08:00", "days_of_week": None,
           "day_of_month": None, "run_at": None, "timezone": "America/Chicago", "valid_from": None, "valid_until": None,
           "misfire_grace_s": 300, "modified_at": datetime(2026, 10, 29, tzinfo=timezone.utc), "tz_mode": "plant",
           "fixed_timezone": None, "plant": "1008", "job_type": "noop", "targets": []}
    return {**row, **kw}


def test_plant_mode_arms_one_job_per_runnable_plant_in_that_plants_zone():
    arms, warnings = scheduler.plan_arms(sched_row(targets=[T("subnetwork", "EU"), T("explicit", "1021")]), PLANTS)
    assert [(scheduler.arm_id(7, a["arm_plant"]), a["timezone"]) for a in arms] == [
        ("job:7:2001", "Europe/London"), ("job:7:1021", "America/New_York")]
    assert warnings == ["3001: plant has no timezone"]


def test_a_legacy_single_plant_schedule_keeps_its_id_and_follows_the_plants_current_zone():
    (arm,), _ = scheduler.plan_arms(sched_row(timezone="America/Chicago"), PLANTS)
    assert scheduler.arm_id(7, arm["arm_plant"]) == "job:7" and arm["timezone"] == "America/Chicago"
    moved = [{**p, "timezone": "Asia/Tokyo"} if p["plant"] == "1008" else p for p in PLANTS]
    (arm2,), _ = scheduler.plan_arms(sched_row(timezone="America/Chicago"), moved)
    assert arm2["timezone"] == "Asia/Tokyo" and scheduler._sig(arm) != scheduler._sig(arm2)
    (arm3,), _ = scheduler.plan_arms(sched_row(plant="3001", timezone="America/Chicago"), PLANTS)
    assert arm3["timezone"] == "America/Chicago", "a plant with no zone keeps the stored one"


def test_fixed_and_utc_modes_are_one_job_that_fans_out_inside_the_fire():
    rows = [T("all", "*")]
    (fixed,), _ = scheduler.plan_arms(sched_row(tz_mode="fixed", fixed_timezone="Asia/Tokyo", targets=rows), PLANTS)
    assert scheduler.arm_id(7, fixed["arm_plant"]) == "job:7" and fixed["timezone"] == "Asia/Tokyo"
    (utc,), _ = scheduler.plan_arms(sched_row(tz_mode="utc", targets=rows), PLANTS)
    assert scheduler.arm_id(7, utc["arm_plant"]) == "job:7" and utc["timezone"] == "UTC"


def test_signature_changes_when_a_plant_joins_leaves_or_changes_zone():
    base = sched_row(targets=[T("subnetwork", "NA")])
    arms = lambda plants: {a["arm_plant"]: scheduler._sig(a) for a in scheduler.plan_arms(base, plants)[0]}  # noqa: E731
    before = arms(PLANTS)
    joined = arms(PLANTS + [{"plant": "1099", "subnetworks": ["NA"], "timezone": "UTC"}])
    assert set(joined) == set(before) | {"1099"} and all(joined[p] == before[p] for p in before)
    retz = arms([{**p, "timezone": "Asia/Tokyo"} if p["plant"] == "1021" else p for p in PLANTS])
    assert retz["1008"] == before["1008"] and retz["1021"] != before["1021"]
    left = arms([p for p in PLANTS if p["plant"] != "1021"])
    assert set(left) == {"1008"}


# ------------------------------------------------------------------------------------- fan-out, fake data
class _P(BaseModel):
    mode: str = "a"
    n: int = 1


class FanData:
    """In-memory run and batch rows: just the `data` calls prepare_batch / execute_batch make."""
    def __init__(self):
        self.runs, self.batches, self.lock = {}, {}, threading.Lock()

    def insert_run(self, **kw):
        with self.lock:
            rid = len(self.runs) + 1
            self.runs[rid] = {"id": rid, **kw, "status": kw["status"]}
            return rid

    def finish_run(self, run_id, status, summary, error, truncated):
        with self.lock:
            r = self.runs[run_id]
            if r["status"] in ("scheduled", "running"):
                r.update(status=status, summary=summary, error=error)

    def get_run(self, run_id):
        return self.runs.get(run_id)

    def write_log_rows(self, run_id, rows):
        pass

    def finish_batch(self, batch_id, **kw):
        sts = [r["status"] for r in self.runs.values() if r.get("batch_id") == batch_id]
        self.batches[batch_id] = {"status": targets.rollup(sts), "counts": targets.counts_of(sts)}
        return self.batches[batch_id]


@pytest.fixture
def fan(monkeypatch):
    f = FanData()
    for name in ("insert_run", "finish_run", "get_run", "write_log_rows", "finish_batch"):
        monkeypatch.setattr(runner.data, name, getattr(f, name))
    monkeypatch.setitem(runner.REGISTRY, "t", JobType(key="t", label="t", params_model=_P,
                                                      run=lambda ctx, p: JobOutcome("succeeded")))
    return f


def job(**kw):
    return {"id": 1, "plant": "1008", "job_type": "t", "params": {}, "fan_out": None, **kw}


def exp_of(*plants, overrides=None, skip=None):
    overrides, skip = overrides or {}, skip or {}
    return {"plants": [{"plant": p, "timezone": "UTC", "skip": skip.get(p), "params_override": overrides.get(p, {})}
                       for p in plants], "warnings": [], "single": False}


def fake_child(f, outcomes=None, delay=0.0, trace=None):
    """A run_child that marks the pre-inserted row with the plant's scripted outcome."""
    outcomes = outcomes or {}
    live = {"now": 0, "max": 0}

    def run_child(**kw):
        with f.lock:
            live["now"] += 1
            live["max"] = max(live["max"], live["now"])
        if trace is not None:
            trace.append(("start", kw["plant"]))
        time.sleep(delay)
        f.runs[kw["run_id"]]["status"] = outcomes.get(kw["plant"], "succeeded")
        f.runs[kw["run_id"]]["batch_override"] = kw["override"]
        with f.lock:
            live["now"] -= 1
        return kw["run_id"]
    run_child.live = live
    return run_child


def go(f, j, exp, run_child, sleeps=None):
    children = runner.prepare_batch(j, exp, batch_id=5, trigger="schedule", schedule_id=3,
                                    scheduled_for=datetime(2026, 10, 29, tzinfo=timezone.utc), triggered_by="schedule")
    runner.execute_batch(job=j, batch_id=5, children=children, trigger="schedule", schedule_id=3,
                         scheduled_for=None, triggered_by="schedule", skip_if_running=True, run_child=run_child,
                         sleep=(sleeps.append if sleeps is not None else (lambda s: None)))
    return children


def test_children_are_inserted_under_the_batch_before_any_starts(fan):
    seen = {}

    def child(**kw):
        seen.setdefault("rows", {r["plant"]: r["status"] for r in fan.runs.values()})   # as the FIRST child starts
        fan.runs[kw["run_id"]]["status"] = "succeeded"
        return kw["run_id"]

    go(fan, job(), exp_of("1008", "1021", "3001", skip={"3001": targets.SKIP_NO_TZ}), child)
    assert seen["rows"] == {"1008": "scheduled", "1021": "scheduled", "3001": "skipped"}
    skipped = next(r for r in fan.runs.values() if r["plant"] == "3001")
    assert skipped["error"] == "plant has no timezone" and skipped["summary"]["error_kind"] == "config"
    assert all(r["batch_id"] == 5 and r["trigger"] == "schedule" and r["schedule_id"] == 3 for r in fan.runs.values())


def test_stagger_sleeps_between_child_starts_but_not_before_the_first(fan):
    sleeps = []
    go(fan, job(fan_out={"stagger_s": 30}), exp_of("1008", "1021", "2001"), fake_child(fan), sleeps)
    assert sleeps == [30, 30]


def test_max_parallel_caps_live_children(fan):
    child = fake_child(fan, delay=0.05)
    go(fan, job(fan_out={"max_parallel": 2}), exp_of(*[str(1000 + i) for i in range(8)]), child)
    assert child.live["max"] == 2
    assert all(r["status"] == "succeeded" for r in fan.runs.values())
    unbounded = fake_child(fan, delay=0.05)
    fan.runs.clear()
    go(fan, job(), exp_of(*[str(1000 + i) for i in range(8)]), unbounded)
    assert unbounded.live["max"] > 2


def test_a_bad_per_plant_override_fails_only_that_child_as_config(fan):
    child = fake_child(fan)
    children = go(fan, job(), exp_of("1008", "1021", "2001", overrides={"1021": {"n": "not a number"}}), child)
    by = {r["plant"]: r for r in fan.runs.values()}
    assert by["1021"]["status"] == "failed" and by["1021"]["summary"]["error_kind"] == "config"
    assert "invalid job parameters" in by["1021"]["error"]
    assert by["1008"]["status"] == "succeeded" and by["2001"]["status"] == "succeeded"
    assert [c["state"] for c in children] == ["pending", "failed", "pending"]
    assert fan.batches[5]["status"] == "failed" and fan.batches[5]["counts"] == {"total": 3, "succeeded": 2, "failed": 1}


def test_valid_overrides_reach_the_child_merged_over_the_job_params(fan):
    child = fake_child(fan)
    go(fan, job(params={"mode": "base", "n": 2}), exp_of("1008", "1021", overrides={"1021": {"mode": "spt"}}), child)
    ov = {r["plant"]: r["batch_override"] for r in fan.runs.values()}
    assert ov == {"1008": {}, "1021": {"mode": "spt"}}
    assert runner._apply_target(job(params={"mode": "base", "n": 2}), "1021", {"mode": "spt"})["params"] == {"mode": "spt", "n": 2}


def test_fail_fast_stops_launching_and_records_the_rest_skipped(fan):
    child = fake_child(fan, outcomes={"1021": "failed"})
    go(fan, job(fan_out={"max_parallel": 1, "fail_fast": True}), exp_of("1008", "1021", "2001", "3001"), child)
    st = {r["plant"]: r["status"] for r in fan.runs.values()}
    assert st == {"1008": "succeeded", "1021": "failed", "2001": "skipped", "3001": "skipped"}
    assert fan.runs[3]["error"] == "stopped: an earlier plant failed"
    assert fan.batches[5]["status"] == "failed"


def test_without_fail_fast_a_failure_does_not_stop_the_siblings(fan):
    child = fake_child(fan, outcomes={"1008": "failed"})
    go(fan, job(fan_out={"max_parallel": 1}), exp_of("1008", "1021", "2001"), child)
    assert [r["status"] for r in fan.runs.values()] == ["failed", "succeeded", "succeeded"]


def test_a_config_failure_at_prepare_time_counts_for_fail_fast(fan):
    child = fake_child(fan)
    go(fan, job(fan_out={"fail_fast": True}), exp_of("1008", "1021", overrides={"1008": {"n": "x"}}), child)
    st = {r["plant"]: r["status"] for r in fan.runs.values()}
    assert st == {"1008": "failed", "1021": "skipped"}


def test_a_child_that_raises_is_failed_and_the_batch_still_finishes(fan):
    def child(**kw):
        if kw["plant"] == "1021":
            raise RuntimeError("boom")
        fan.runs[kw["run_id"]]["status"] = "succeeded"
        return kw["run_id"]

    go(fan, job(), exp_of("1008", "1021"), child)
    assert {r["plant"]: r["status"] for r in fan.runs.values()} == {"1008": "succeeded", "1021": "failed"}
    assert fan.batches[5]["status"] == "failed"


def test_the_batch_rolls_up_warning_when_a_child_warns_or_is_skipped(fan):
    go(fan, job(), exp_of("1008", "1021"), fake_child(fan, outcomes={"1021": "warning"}))
    assert fan.batches[5]["status"] == "warning"
    fan.runs.clear()
    go(fan, job(), exp_of("1008", "3001", skip={"3001": targets.SKIP_NO_TZ}), fake_child(fan))
    assert fan.batches[5]["status"] == "warning" and fan.batches[5]["counts"]["skipped"] == 1


def _noop_needs_tz(monkeypatch, on: bool) -> None:
    import dataclasses
    from backend.jobs import registry
    monkeypatch.setitem(registry.REGISTRY, "noop",
                        dataclasses.replace(registry.REGISTRY["noop"], needs_plant_timezone=on))


# ============================================================================================== pg tests
@pytest.fixture
def mp_pg(planning_pg, monkeypatch):
    """planning_pg with two plants that have timezones, a third plant WITHOUT one, and a clean job slate after."""
    import backend.jobs.data as data
    monkeypatch.setenv("NIMBUS_JOBS_STUBS", "1")
    _noop_needs_tz(monkeypatch, True)          # a no-timezone plant is skipped only for types that need a zone
    data.ensure_job_tables()
    db = planning_pg.db
    third = planning_pg.plant + "_C"
    planning_pg.third = third
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO plants(subnetwork, plant) VALUES (%s, %s)", (planning_pg.subnet, third))
        cur.execute("UPDATE plants SET timezone = 'America/Chicago' WHERE plant = %s", (planning_pg.plant,))
        cur.execute("UPDATE plants SET timezone = 'Europe/London' WHERE plant = %s", (planning_pg.other,))
        conn.commit()
    yield planning_pg
    plants = [planning_pg.plant, planning_pg.other, third]
    with db._pool.connection() as conn, conn.cursor() as cur:
        ids = "SELECT id FROM job_definition WHERE plant = ANY(%s)"
        cur.execute(f"DELETE FROM job_run_log WHERE run_id IN (SELECT id FROM job_run WHERE job_id IN ({ids}))", (plants,))
        cur.execute(f"DELETE FROM job_run WHERE job_id IN ({ids})", (plants,))
        cur.execute(f"DELETE FROM job_batch WHERE job_id IN ({ids})", (plants,))
        cur.execute(f"DELETE FROM job_target WHERE job_id IN ({ids})", (plants,))
        cur.execute(f"DELETE FROM job_schedule WHERE job_id IN ({ids})", (plants,))
        cur.execute("DELETE FROM job_definition WHERE plant = ANY(%s)", (plants,))
        conn.commit()


@pytest.fixture
def mapi(mp_pg, client):
    import brain
    from backend.security import auth
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_admin] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    yield client
    brain.api.dependency_overrides.clear()


def mk(api, plant, **kw):
    body = {"plant": plant, "job_type": "noop", "name": "t", "params": {"steps": 1, "sleep_s": 0}, **kw}
    r = api.post("/jobs", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def wait_batch(api, bid, t=20):
    end = time.time() + t
    while time.time() < end:
        b = api.get(f"/jobs/batches/{bid}").json()
        if b["batch"]["status"] != "running":
            return b
        time.sleep(0.1)
    raise AssertionError(b)


@pytest.mark.pg
def test_a_job_with_targets_round_trips_and_a_job_without_targets_is_unchanged(mapi, mp_pg):
    plain = mk(mapi, mp_pg.plant)
    assert plain["targets"] == [] and plain["target_kind"] == "single" and plain["target_count"] == 1
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.other, "params_override": {"steps": 2}},
                                       {"kind": "explicit", "value": mp_pg.third}],
           fan_out={"stagger_s": 0, "max_parallel": 2, "fail_fast": True})
    assert j["target_kind"] == "selected" and j["target_count"] == 1 and j["target_skipped"] == 1
    assert j["fan_out"] == {"stagger_s": 0, "max_parallel": 2, "fail_fast": True}
    assert j["targets"][0]["params_override"] == {"steps": 2}
    back = mapi.patch(f"/jobs/{j['id']}", json={"targets": []}).json()
    assert back["targets"] == [] and back["target_kind"] == "single"
    assert mapi.patch(f"/jobs/{j['id']}", json={"name": "renamed"}).json()["fan_out"]["max_parallel"] == 2


@pytest.mark.pg
def test_save_time_scope_check_403s_for_plants_outside_the_admins_scope(mapi, mp_pg):
    import brain
    from backend.security import auth
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.plant]
    own = {"plant": mp_pg.plant, "job_type": "noop", "name": "t"}
    r = mapi.post("/jobs", json={**own, "targets": [{"kind": "explicit", "value": mp_pg.other}]})
    assert r.status_code == 403
    r = mapi.post("/jobs", json={**own, "targets": [{"kind": "subnetwork", "value": mp_pg.subnet}]})
    assert r.status_code == 403, "the subnetwork holds plants the admin cannot reach"
    ok = mapi.post("/jobs", json={**own, "targets": [{"kind": "all"}]})
    assert ok.status_code == 200
    assert ok.json()["targets"][0]["value"] == mp_pg.plant, "an 'all' row stores the admin's own scope"
    assert ok.json()["target_count"] == 1
    job_id = ok.json()["id"]
    assert mapi.patch(f"/jobs/{job_id}", json={"targets": [{"kind": "explicit", "value": mp_pg.other}]}).status_code == 403
    pv = mapi.post("/jobs/targets/preview", json={"kind": "all"}).json()
    assert [p["plant"] for p in pv["plants"]] == [mp_pg.plant]
    assert mapi.post("/jobs/targets/preview", json={"kind": "explicit", "value": mp_pg.other}).status_code == 403


@pytest.mark.pg
def test_a_scoped_admin_all_target_never_grows_into_foreign_plants_at_fire_time(mapi, mp_pg):
    import brain
    from backend.security import auth
    import backend.jobs.data as data
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.plant, mp_pg.other]
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "all"}])
    exp = targets.expand_targets(data.get_job(j["id"]), plants=data.load_plant_rows())
    assert sorted(codes(exp)) == sorted([mp_pg.plant, mp_pg.other]), "not the other plants the database holds"


@pytest.mark.pg
def test_target_validation_errors(mapi, mp_pg):
    base = {"plant": mp_pg.plant, "job_type": "noop", "name": "t"}
    assert mapi.post("/jobs", json={**base, "targets": [{"kind": "explicit", "value": "NOPE"}]}).status_code == 400
    assert mapi.post("/jobs", json={**base, "targets": [{"kind": "subnetwork", "value": "NOPE"}]}).status_code == 400
    only_excluded = [{"kind": "explicit", "value": mp_pg.plant, "excluded": True}]
    assert mapi.post("/jobs", json={**base, "targets": only_excluded}).status_code == 400
    bad = mapi.post("/jobs", json={**base, "targets": [{"kind": "explicit", "value": mp_pg.plant,
                                                         "params_override": {"steps": "many"}}]})
    assert bad.status_code == 400 and mp_pg.plant in bad.json()["detail"]


@pytest.mark.pg
def test_targets_preview_reports_skipped_plants_and_pages(mapi, mp_pg):
    body = mapi.post("/jobs/targets/preview", json={"kind": "subnetwork", "value": mp_pg.subnet}).json()
    assert body["count"] == 2 and body["skipped"] == 1
    skipped = [p for p in body["plants"] if p["warning"]]
    assert [p["plant"] for p in skipped] == [mp_pg.third] and skipped[0]["warning"] == "plant has no timezone"
    page = mapi.post("/jobs/targets/preview", json={"kind": "subnetwork", "value": mp_pg.subnet,
                                                    "offset": 1, "limit": 1}).json()
    assert len(page["plants"]) == 1 and page["count"] == 2
    excl = mapi.post("/jobs/targets/preview", json={"kind": "subnetwork", "value": mp_pg.subnet,
                                                    "excluded": [mp_pg.other, mp_pg.third]}).json()
    assert [p["plant"] for p in excl["plants"]] == [mp_pg.plant]


@pytest.mark.pg
def test_run_now_fans_out_into_a_batch_with_one_child_per_plant(mapi, mp_pg):
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant},
                                       {"kind": "explicit", "value": mp_pg.other},
                                       {"kind": "explicit", "value": mp_pg.third}])
    r = mapi.post(f"/jobs/{j['id']}/run")
    assert r.status_code == 200
    bid = r.json()["batch"]["id"]
    assert r.json()["run"]["batch_id"] == bid
    done = wait_batch(mapi, bid)
    assert done["batch"]["status"] == "warning", "the no-timezone plant is a skipped child"
    assert done["batch"]["counts"] == {"total": 3, "succeeded": 2, "skipped": 1}
    assert done["batch"]["ended_at"] and done["batch"]["trigger"] == "manual"
    by = {x["plant"]: x for x in done["runs"]}
    assert by[mp_pg.third]["status"] == "skipped" and by[mp_pg.third]["summary"]["error_kind"] == "config"
    assert by[mp_pg.third]["error"] == "plant has no timezone"
    assert by[mp_pg.plant]["status"] == by[mp_pg.other]["status"] == "succeeded"
    runs = mapi.get("/jobs/runs", params={"job_id": j["id"]}).json()["runs"]
    assert len(runs) == 3 and all(x["batch_id"] == bid for x in runs), "child runs still list as runs"
    listed = mapi.get("/jobs/batches", params={"job_id": j["id"]}).json()["batches"]
    assert [b["id"] for b in listed] == [bid]
    assert mapi.get("/jobs/batches", params={"plant": mp_pg.other}).json()["batches"][0]["id"] == bid
    again = mapi.post(f"/jobs/{j['id']}/run")
    assert again.status_code == 200, "the first batch is finished, so the job is idle again"
    wait_batch(mapi, again.json()["batch"]["id"])
    restart = mapi.post(f"/jobs/runs/{runs[0]['id']}/restart")
    assert restart.status_code == 200 and restart.json()["batch"]["trigger"] == "restart"
    wait_batch(mapi, restart.json()["batch"]["id"])


@pytest.mark.pg
def test_a_second_run_now_while_a_batch_runs_is_a_409(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", status="running",
                    trigger="manual", batch_id=bid)
    assert mapi.post(f"/jobs/{j['id']}/run").status_code == 409


@pytest.mark.pg
def test_batches_are_scoped_to_the_callers_plants(mapi, mp_pg):
    import brain
    from backend.security import auth
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    bid = mapi.post(f"/jobs/{j['id']}/run").json()["batch"]["id"]
    wait_batch(mapi, bid)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.other]
    seen = mapi.get(f"/jobs/batches/{bid}").json()
    assert [x["plant"] for x in seen["runs"]] == [mp_pg.other] and seen["batch"]["counts"] == {"total": 1, "succeeded": 1}
    assert [b["id"] for b in mapi.get("/jobs/batches").json()["batches"]] == [bid]
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.third]
    assert mapi.get(f"/jobs/batches/{bid}").status_code == 404
    assert mapi.get("/jobs/batches").json()["batches"] == []
    assert mapi.get("/jobs/batches", params={"plant": mp_pg.plant}).status_code == 403


@pytest.mark.pg
def test_plant_filter_on_the_jobs_list_matches_any_targeted_plant(mapi, mp_pg):
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    other_only = mk(mapi, mp_pg.plant)
    ids = [x["id"] for x in mapi.get("/jobs", params={"plant": mp_pg.other}).json()["jobs"]]
    assert j["id"] in ids and other_only["id"] not in ids
    all_job = mk(mapi, mp_pg.plant, targets=[{"kind": "all"}])
    sub = mk(mapi, mp_pg.plant, targets=[{"kind": "subnetwork", "value": mp_pg.subnet},
                                         {"kind": "explicit", "value": mp_pg.other, "excluded": True}])
    ids = [x["id"] for x in mapi.get("/jobs", params={"plant": mp_pg.other}).json()["jobs"]]
    assert all_job["id"] in ids and sub["id"] not in ids, "an excluded plant is not 'targeted'"


def _scheduler():
    from apscheduler.schedulers.background import BackgroundScheduler
    sch = BackgroundScheduler()
    sch.start(paused=True)           # paused: nothing fires, add_job(replace_existing) really replaces
    return sch


@pytest.mark.pg
def test_reconcile_arms_one_job_per_plant_and_rearms_on_a_timezone_or_target_change(mapi, mp_pg):
    import backend.jobs.data as data
    from backend.jobs import scheduler as js
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other},
                                       {"kind": "explicit", "value": mp_pg.third}],
           schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    a, b = f"job:{sid}:{mp_pg.plant}", f"job:{sid}:{mp_pg.other}"
    sch = _scheduler()
    try:
        js._SIGS.clear()
        res = js.reconcile(sch)
        ids = {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")}
        assert ids == {a, b}, "the plant with no timezone is not armed"
        assert str(sch.get_job(a).trigger.timezone) == "America/Chicago"
        assert str(sch.get_job(b).trigger.timezone) == "Europe/London"
        assert js.reconcile(sch)["added"] == 0, "idempotent"
        with data.db._pool.connection() as conn, conn.cursor() as cur:       # a plant timezone edit
            cur.execute("UPDATE plants SET timezone = 'Asia/Tokyo' WHERE plant = %s", (mp_pg.other,))
            conn.commit()
        assert js.reconcile(sch)["added"] == 1
        assert str(sch.get_job(b).trigger.timezone) == "Asia/Tokyo" and str(sch.get_job(a).trigger.timezone) == "America/Chicago"
        with data.db._pool.connection() as conn, conn.cursor() as cur:       # the no-timezone plant gains one
            cur.execute("UPDATE plants SET timezone = 'UTC' WHERE plant = %s", (mp_pg.third,))
            conn.commit()
        js.reconcile(sch)
        assert {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")} == {a, b, f"job:{sid}:{mp_pg.third}"}
        mapi.patch(f"/jobs/{j['id']}", json={"targets": [{"kind": "explicit", "value": mp_pg.plant}]})   # a plant leaves
        assert js.reconcile(sch)["removed"] == 2
        assert {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")} == {a}
        mapi.patch(f"/jobs/{j['id']}", json={"targets": []})                  # back to a legacy single-plant job
        js.reconcile(sch)
        assert {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")} == {f"job:{sid}"}, "old id format replaced"
    finally:
        sch.shutdown(wait=False)


@pytest.mark.pg
def test_a_legacy_single_plant_schedule_rearms_when_its_plant_timezone_changes(mapi, mp_pg):
    import backend.jobs.data as data
    from backend.jobs import scheduler as js
    j = mk(mapi, mp_pg.plant, schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    sch = _scheduler()
    try:
        js._SIGS.clear()
        js.reconcile(sch)
        assert sch.get_job(f"job:{sid}") is not None and str(sch.get_job(f"job:{sid}").trigger.timezone) == "America/Chicago"
        with data.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE plants SET timezone = 'Asia/Tokyo' WHERE plant = %s", (mp_pg.plant,))
            conn.commit()
        assert js.reconcile(sch)["added"] == 1
        assert str(sch.get_job(f"job:{sid}").trigger.timezone) == "Asia/Tokyo"
    finally:
        sch.shutdown(wait=False)


@pytest.mark.pg
@pytest.mark.parametrize("mode,fixed", [("fixed", "Asia/Tokyo"), ("utc", None)])
def test_fixed_and_utc_modes_keep_one_job_and_fan_out_inside_the_fire(mapi, mp_pg, mode, fixed):
    import backend.jobs.data as data
    from backend.jobs import scheduler as js, runner as rn
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other},
                                       {"kind": "explicit", "value": mp_pg.third}],
           schedules=[{"kind": "daily", "time_of_day": "08:00", "tz_mode": mode, "fixed_timezone": fixed}])
    s = j["schedules"][0]
    assert s["tz_mode"] == mode and s["fixed_timezone"] == fixed
    sch = _scheduler()
    try:
        js._SIGS.clear()
        js.reconcile(sch)
        armed = [x for x in sch.get_jobs() if x.id.startswith(f"job:{s['id']}")]
        assert [x.id for x in armed] == [f"job:{s['id']}"]
        assert str(armed[0].trigger.timezone) == (fixed or "UTC")
    finally:
        sch.shutdown(wait=False)
    bid = rn.fire_schedule(s["id"])                        # D4: returns at once, the batch runs on its own dispatcher
    b = wait_batch(mapi, bid)
    assert b["batch"]["trigger"] == "schedule" and b["batch"]["status"] == "warning"
    assert {x["plant"]: x["status"] for x in b["runs"]} == {mp_pg.plant: "succeeded", mp_pg.other: "succeeded",
                                                              mp_pg.third: "skipped"}
    assert all(x["trigger"] == "schedule" and x["schedule_id"] == s["id"] for x in b["runs"])


@pytest.mark.pg
def test_a_plant_mode_arm_fires_only_its_own_plant_as_a_batch_of_one(mapi, mp_pg):
    import backend.jobs.runner as rn
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}],
           schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    bid = rn.fire_schedule(sid, mp_pg.other)
    b = wait_batch(mapi, bid)
    assert [x["plant"] for x in b["runs"]] == [mp_pg.other] and b["batch"]["status"] == "succeeded"
    assert rn.fire_schedule(sid, mp_pg.third) is None, "not a target: nothing fires"


@pytest.mark.pg
def test_a_once_schedule_per_plant_is_spent_only_when_every_plant_has_fired(mapi, mp_pg):
    import backend.jobs.data as data
    import backend.jobs.runner as rn
    from backend.jobs import scheduler as js
    from datetime import datetime, timedelta
    run_at = (datetime.now() + timedelta(days=1)).isoformat(timespec="minutes")
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}],
           schedules=[{"kind": "once", "run_at": run_at}])
    sid = j["schedules"][0]["id"]
    sch = _scheduler()
    try:
        js._SIGS.clear()
        js.reconcile(sch)
        assert {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")} == {f"job:{sid}:{mp_pg.plant}", f"job:{sid}:{mp_pg.other}"}
        rn.fire_schedule(sid, mp_pg.plant)
        assert data.get_schedule(sid)["retired"] is False, "the other plant's later fire must survive"
        js.reconcile(sch)
        assert {x.id for x in sch.get_jobs() if x.id.startswith(f"job:{sid}")} == {f"job:{sid}:{mp_pg.other}"}
        rn.fire_schedule(sid, mp_pg.other)
        assert data.get_schedule(sid)["retired"] is True
    finally:
        sch.shutdown(wait=False)


@pytest.mark.pg
def test_boot_sweep_fails_a_running_batch_with_the_interrupted_rule(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="schedule", triggered_by="schedule")
    r1 = data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", status="scheduled",
                         trigger="schedule", batch_id=bid)
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.other, job_type="noop", status="succeeded",
                    trigger="schedule", batch_id=bid)
    data.mark_running(r1)
    assert data.boot_sweep() >= 1
    b = mapi.get(f"/jobs/batches/{bid}").json()["batch"]
    assert b["status"] == "failed" and b["ended_at"] and b["summary"]["error"] == "interrupted by restart"
    assert b["counts"] == {"total": 2, "failed": 1, "succeeded": 1}


@pytest.mark.pg
def test_a_retry_replaces_its_failed_attempt_in_the_batch_counts(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant)
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    kw = dict(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", trigger="manual", batch_id=bid)
    data.insert_run(status="failed", **kw)
    data.insert_run(status="succeeded", attempt=2, **kw)
    assert data.finish_batch(bid)["counts"] == {"total": 1, "succeeded": 1}
    assert data.get_batch(bid)["status"] == "succeeded"


@pytest.mark.pg
def test_the_retention_sweep_removes_old_batches_after_their_runs(mapi, mp_pg):
    import backend.jobs.data as data
    db = mp_pg.db
    j = mk(mapi, mp_pg.plant)
    old = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", status="succeeded",
                    trigger="manual", batch_id=old)
    keep = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", status="succeeded",
                    trigger="manual", batch_id=keep)
    data.finish_batch(old)
    data.finish_batch(keep)
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET created_at = now() - interval '30 days' WHERE batch_id = %s", (old,))
        cur.execute("UPDATE job_batch SET ended_at = now() - interval '30 days' WHERE id = %s", (old,))
        conn.commit()
    res = data.sweep_job_runs(retention_days=7, pause_s=0)
    assert res["error"] is None and res["deleted_batches"] >= 1
    assert data.get_batch(old) is None and data.get_batch(keep) is not None


@pytest.mark.pg
def test_job_wire_lists_next_run_and_upcoming_per_plant(mapi, mp_pg):
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}],
           schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    assert j["next_run_at"] and j["target_count"] == 2
    up = mapi.get(f"/jobs/{j['id']}/upcoming", params={"n": 2}).json()["entries"]
    assert {e["plant"] for e in up} == {mp_pg.plant, mp_pg.other} and len(up) == 4
    tz = {e["plant"]: e["timezone"] for e in up}
    assert tz == {mp_pg.plant: "America/Chicago", mp_pg.other: "Europe/London"}
    assert all("at_local" in e and "at_utc" in e for e in up)
    strip = mapi.get("/jobs/upcoming", params={"plant": mp_pg.plant, "n": 3}).json()["entries"]
    assert len(strip) == 3


# ================================================================================ W3a fix wave (decisions D1-D6)
def test_creator_scope_intersects_the_expansion_and_marks_the_rest_skipped():
    rows = [T("subnetwork", "NA"), T("explicit", "2001")]
    exp = targets.expand_targets({"plant": "1008", "targets": rows, "scope_plants": ["1008", "2001"]}, plants=PLANTS)
    by = {p["plant"]: p["skip"] for p in exp["plants"]}
    assert by == {"1008": None, "1021": targets.SKIP_SCOPE, "2001": None}
    unscoped = targets.expand_targets({"plant": "1008", "targets": rows, "scope_plants": None}, plants=PLANTS)
    assert unscoped["plants"][1]["skip"] is None
    free = targets.expand_targets({"plant": "1008", "targets": rows, "scope_plants": ["1008"]}, plants=PLANTS,
                                  apply_scope=False)
    assert all(p["skip"] is None for p in free["plants"]), "a write's scope check looks at the unfiltered expansion"


def test_a_missing_timezone_skips_only_when_a_zone_is_required():
    rows = [T("explicit", "3001"), T("explicit", "4001")]
    need = targets.expand_targets({"plant": "1008", "targets": rows}, plants=PLANTS, require_tz=True)
    assert [p["skip"] for p in need["plants"]] == [targets.SKIP_NO_TZ, targets.SKIP_BAD_TZ]
    free = targets.expand_targets({"plant": "1008", "targets": rows}, plants=PLANTS, require_tz=False)
    assert [p["skip"] for p in free["plants"]] == [None, None] and not free["warnings"]


def test_plan_arms_skips_scope_dropped_plants_like_the_run_time_expansion():
    sched = {"id": 1, "plant": "1008", "kind": "daily", "cron_expr": "0 8 * * *", "time_of_day": "08:00",
             "days_of_week": None, "day_of_month": None, "run_at": None, "timezone": "America/Chicago",
             "valid_from": None, "valid_until": None, "misfire_grace_s": 300, "modified_at": 1, "tz_mode": "plant",
             "fixed_timezone": None, "targets": [T("subnetwork", "NA")], "scope_plants": ["1008"]}
    arms, _ = scheduler.plan_arms(sched, PLANTS)
    assert [a["arm_plant"] for a in arms] == ["1008"]


def test_an_unset_max_parallel_is_bounded(fan):
    c = fake_child(fan, delay=0.15)
    go(fan, job(), exp_of(*[f"P{i}" for i in range(8)]), c)
    assert c.live["max"] <= runner.MAX_PARALLEL_DEFAULT


def test_a_dispatcher_crash_closes_unlaunched_children_and_still_rolls_the_batch_up(fan, monkeypatch):
    closed, finished = [], []
    monkeypatch.setattr(runner.data, "fail_batch_children", lambda bid, err, status="failed": closed.append((bid, err)))
    monkeypatch.setattr(runner.data, "finish_batch", lambda bid, **kw: finished.append(bid))

    def sleeper(s):
        raise RuntimeError("boom")

    j = job(fan_out={"stagger_s": 5})
    children = runner.prepare_batch(j, exp_of("1008", "1021", "2001"), batch_id=5, trigger="manual", schedule_id=None,
                                    scheduled_for=None, triggered_by="x")
    runner.execute_batch(job=j, batch_id=5, children=children, trigger="manual", schedule_id=None, scheduled_for=None,
                         triggered_by="x", skip_if_running=True, run_child=fake_child(fan), sleep=sleeper)
    assert closed and finished == [5], "unstarted children are closed and the batch is finished, never left running"


def test_finish_batch_is_retried_once(fan, monkeypatch):
    seen = {"n": 0}

    def flaky(bid, **kw):
        seen["n"] += 1
        if seen["n"] == 1:
            raise RuntimeError("db blip")

    monkeypatch.setattr(runner.data, "finish_batch", flaky)
    go(fan, job(), exp_of("1008"), fake_child(fan))
    assert seen["n"] == 2


def test_a_batch_child_skips_when_its_job_was_disabled_or_archived_after_it_queued(fan, monkeypatch):
    jobs = {"enabled": True, "archived": False}
    monkeypatch.setattr(runner.data, "get_job", lambda jid: {"id": jid, "plant": "1008", "job_type": "t", "params": {},
                                                             "retry_max": 0, "timeout_s": None, **jobs})
    rid = fan.insert_run(job_id=1, schedule_id=None, plant="1008", job_type="t", status="scheduled", trigger="schedule",
                         batch_id=5)
    jobs["enabled"] = False
    runner.run_job(job_id=1, trigger="schedule", run_id=rid, plant="1008", batch_id=5)
    assert fan.runs[rid]["status"] == "skipped" and "disabled" in fan.runs[rid]["error"]
    rid2 = fan.insert_run(job_id=1, schedule_id=None, plant="1008", job_type="t", status="scheduled", trigger="manual",
                          batch_id=5)
    jobs["archived"] = True
    runner.run_job(job_id=1, trigger="manual", run_id=rid2, plant="1008", batch_id=5)
    assert fan.runs[rid2]["status"] == "skipped" and "archived" in fan.runs[rid2]["error"]


def test_a_cancelled_child_is_never_started(fan):
    started = []
    children = runner.prepare_batch(job(), exp_of("1008", "1021"), batch_id=5, trigger="manual", schedule_id=None,
                                    scheduled_for=None, triggered_by="x")
    fan.runs[children[0]["run_id"]]["status"] = "skipped"           # a batch cancel got there first

    def child(**kw):
        started.append(kw["plant"])
        fan.runs[kw["run_id"]]["status"] = "succeeded"
        return kw["run_id"]

    runner.execute_batch(job=job(), batch_id=5, children=children, trigger="manual", schedule_id=None,
                         scheduled_for=None, triggered_by="x", skip_if_running=True, run_child=child,
                         sleep=lambda s: None)
    assert started == ["1021"]


def test_slot_is_taken_before_the_global_semaphore(monkeypatch):
    order = []

    class Rec:
        def __init__(self, name):
            self.name = name

        def acquire(self, *a, **k):
            order.append(("acquire", self.name))
            return True

        def release(self):
            order.append(("release", self.name))

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Pool:
        def connection(self):
            return Conn()

    monkeypatch.setattr(runner, "_SEM", Rec("sem"))
    monkeypatch.setattr(runner, "_run_body", lambda *a, **k: "succeeded")
    monkeypatch.setattr(runner.data, "try_session_lock", lambda conn, key: True)
    monkeypatch.setattr(runner.data, "release_session_lock", lambda conn, key: None)
    monkeypatch.setattr(runner.data, "get_run", lambda rid: {"cancel_requested": False, "status": "scheduled"})
    monkeypatch.setattr(runner.db, "_pool", Pool(), raising=False)
    jt = JobType(key="slotted", label="s", params_model=_P, run=lambda c, p: JobOutcome(), slot=lambda: Rec("slot"))
    runner._execute(1, {"plant": "1008", "timeout_s": 60, "id": 1}, jt, _P(), True)
    assert order == [("acquire", "slot"), ("acquire", "sem"), ("release", "sem"), ("release", "slot")]


@pytest.mark.pg
def test_scoped_admin_writes_403_when_the_jobs_targets_reach_outside_their_plants(mapi, mp_pg):
    import brain
    from backend.security import auth
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}],
           schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.plant]
    for r in (mapi.post(f"/jobs/{j['id']}/run"), mapi.patch(f"/jobs/{j['id']}", json={"name": "x"}),
              mapi.post(f"/jobs/{j['id']}/schedules", json={"kind": "daily", "time_of_day": "09:00"}),
              mapi.patch(f"/jobs/schedules/{sid}", json={"paused": True})):
        assert r.status_code == 403 and mp_pg.other in r.json()["detail"], r.text
    assert mapi.get(f"/jobs/{j['id']}/upcoming").status_code == 200, "a read only needs one plant in scope"


@pytest.mark.pg
def test_a_scoped_creators_scope_is_stored_and_applied_at_fire_time(mapi, mp_pg):
    import brain
    import backend.jobs.data as data
    import backend.jobs.runner as rn
    from backend.security import auth
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.plant]
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}])
    assert data.get_job(j["id"])["scope_plants"] == [mp_pg.plant]
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    assert data.get_job(mk(mapi, mp_pg.plant)["id"])["scope_plants"] is None, "an unrestricted creator has no scope"
    # An unrestricted admin widens the targets; the creator's stored scope still limits who actually runs.
    mapi.patch(f"/jobs/{j['id']}", json={"targets": [{"kind": "subnetwork", "value": mp_pg.subnet}]})
    exp = rn._expand(data.get_job(j["id"]))
    by = {e["plant"]: e["skip"] for e in exp["plants"]}
    assert by[mp_pg.other] == targets.SKIP_SCOPE and by[mp_pg.plant] is None, "the creator could not reach it"
    done = wait_batch(mapi, mapi.post(f"/jobs/{j['id']}/run").json()["batch"]["id"])
    skipped = [x for x in done["runs"] if x["error"] == targets.SKIP_SCOPE]
    assert skipped and skipped[0]["status"] == "skipped"


@pytest.mark.pg
def test_restart_of_a_run_reruns_only_its_plant_and_checks_only_that_plant(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    first = wait_batch(mapi, mapi.post(f"/jobs/{j['id']}/run").json()["batch"]["id"])
    mine = next(x for x in first["runs"] if x["plant"] == mp_pg.plant)
    theirs = next(x for x in first["runs"] if x["plant"] == mp_pg.other)
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.other, job_type="noop", status="running", trigger="manual")
    busy = mapi.post(f"/jobs/{j['id']}/run")
    assert busy.status_code == 409 and mp_pg.other in busy.json()["detail"], "a 409 names what is running"
    r = mapi.post(f"/jobs/runs/{mine['id']}/restart")
    assert r.status_code == 200, "the other plant's run is not in this plant's way"
    done = wait_batch(mapi, r.json()["batch"]["id"])
    assert [x["plant"] for x in done["runs"]] == [mp_pg.plant] and done["batch"]["trigger"] == "restart"
    again = mapi.post(f"/jobs/runs/{theirs['id']}/restart")
    assert again.status_code == 409 and mp_pg.other in again.json()["detail"]


@pytest.mark.pg
def test_restart_batch_reruns_only_failed_skipped_or_cancelled_plants(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other},
                                       {"kind": "explicit", "value": mp_pg.third}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    kw = dict(job_id=j["id"], schedule_id=None, job_type="noop", trigger="manual", batch_id=bid)
    data.insert_run(plant=mp_pg.plant, status="succeeded", **kw)
    data.insert_run(plant=mp_pg.other, status="failed", **kw)
    data.insert_run(plant=mp_pg.third, status="skipped", **kw)
    data.finish_batch(bid)
    r = mapi.post(f"/jobs/batches/{bid}/restart")
    assert r.status_code == 200
    done = wait_batch(mapi, r.json()["batch"]["id"])
    assert sorted(x["plant"] for x in done["runs"]) == sorted([mp_pg.other, mp_pg.third])
    bid2 = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    data.insert_run(plant=mp_pg.plant, status="succeeded", **{**kw, "batch_id": bid2})
    data.finish_batch(bid2)
    assert mapi.post(f"/jobs/batches/{bid2}/restart").status_code == 400


@pytest.mark.pg
def test_batch_cancel_skips_pending_children_and_is_scoped(mapi, mp_pg):
    import brain
    import backend.jobs.data as data
    from backend.security import auth
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    kw = dict(job_id=j["id"], schedule_id=None, job_type="noop", trigger="manual", batch_id=bid)
    data.insert_run(plant=mp_pg.plant, status="scheduled", **kw)
    data.insert_run(plant=mp_pg.other, status="scheduled", **kw)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.plant]
    assert mapi.post(f"/jobs/batches/{bid}/cancel").status_code == 403
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    r = mapi.post(f"/jobs/batches/{bid}/cancel")
    assert r.status_code == 200 and r.json()["batch"]["status"] == "warning"
    runs = mapi.get(f"/jobs/batches/{bid}").json()["runs"]
    assert {x["status"] for x in runs} == {"skipped"} and {x["error"] for x in runs} == {"batch cancelled"}
    assert mapi.post(f"/jobs/batches/{bid}/cancel").status_code == 409


@pytest.mark.pg
def test_boot_sweep_skips_unstarted_batch_children_and_the_24h_failures_ignore_them(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="schedule", triggered_by="schedule")
    kw = dict(job_id=j["id"], schedule_id=None, job_type="noop", trigger="schedule", batch_id=bid)
    running = data.insert_run(plant=mp_pg.plant, status="scheduled", **kw)
    data.mark_running(running)
    waiting = data.insert_run(plant=mp_pg.other, status="scheduled", **kw)
    data.boot_sweep()
    assert data.get_run(running)["status"] == "failed" and data.get_run(running)["error"] == "interrupted by restart"
    w = data.get_run(waiting)
    assert w["status"] == "skipped" and w["error"] == "not started: restart interrupted the batch"
    assert w["summary"]["error_kind"] == "system"
    h = data.run_health(allowed_plants=[mp_pg.plant, mp_pg.other], plant=None)
    assert h["failed_24h"] == 1 and h["failed_batches_24h"] == 1


@pytest.mark.pg
def test_last_success_watermark_is_keyed_by_plant(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    kw = dict(job_id=j["id"], schedule_id=None, job_type="noop", trigger="schedule")
    rid = data.insert_run(plant=mp_pg.plant, status="scheduled", **kw)
    data.mark_running(rid)
    data.finish_run(rid, "succeeded", {"window": {"end": "2026-10-28T10:00:00+00:00"}}, None, False)
    assert data.last_success_watermark(j["id"], None, mp_pg.plant) is not None
    assert data.last_success_watermark(j["id"], None, mp_pg.other) is None, "another plant's success must not move it"


@pytest.mark.pg
def test_batch_counts_are_live_and_detail_is_paginated(mapi, mp_pg):
    import backend.jobs.data as data
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}])
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="schedule", triggered_by="schedule")
    kw = dict(job_id=j["id"], schedule_id=None, job_type="noop", trigger="schedule", batch_id=bid)
    data.insert_run(plant=mp_pg.plant, status="succeeded", **kw)
    data.insert_run(plant=mp_pg.other, status="scheduled", **kw)
    body = mapi.get(f"/jobs/batches/{bid}", params={"limit": 1}).json()
    assert body["batch"]["status"] == "running" and body["batch"]["counts"] == {"total": 2, "succeeded": 1, "scheduled": 1}
    assert len(body["runs"]) == 1 and body["has_more"] is True, "counts cover all plants, runs are one page"
    page2 = mapi.get(f"/jobs/batches/{bid}", params={"limit": 1, "offset": 1}).json()
    assert len(page2["runs"]) == 1 and page2["has_more"] is False
    listed = mapi.get("/jobs/batches", params={"job_id": j["id"]}).json()["batches"][0]
    assert listed["counts"]["scheduled"] == 1, "the list carries the live tally too"


@pytest.mark.pg
def test_jobs_list_filters_by_real_expansion_and_carries_last_batch(mapi, mp_pg):
    import backend.jobs.data as data
    import brain
    from backend.security import auth
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "subnetwork", "value": mp_pg.subnet},
                                       {"kind": "explicit", "value": mp_pg.other, "excluded": True}])

    def ids(**q):
        return [x["id"] for x in mapi.get("/jobs", params=q).json()["jobs"]]

    assert j["id"] in ids(plant=mp_pg.plant) and j["id"] not in ids(plant=mp_pg.other), "an excluded plant is no match"
    home_out = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.other}])
    assert home_out["id"] not in ids(plant=mp_pg.plant), "the home plant is not a target here"
    assert home_out["id"] in ids(plant=mp_pg.other)
    bid = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    data.insert_run(job_id=j["id"], schedule_id=None, plant=mp_pg.plant, job_type="noop", status="failed",
                    trigger="manual", batch_id=bid)
    data.finish_batch(bid)
    row = next(x for x in mapi.get("/jobs", params={"plant": mp_pg.plant}).json()["jobs"] if x["id"] == j["id"])
    assert row["last_batch"]["id"] == bid and row["last_batch"]["status"] == "failed"
    assert j["id"] in ids(status="failed"), "the status filter uses the last batch for a multi-plant job"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [mp_pg.other]
    assert home_out["id"] in ids(), "scoped visibility includes jobs that target one of the caller's plants"
    assert j["id"] not in ids()


@pytest.mark.pg
def test_patch_job_revalidates_per_plant_overrides_against_new_params(mapi, mp_pg):
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.other, "params_override": {"steps": 2}}])
    assert mapi.patch(f"/jobs/{j['id']}", json={"params": {"steps": 3}}).status_code == 200
    back = mapi.patch(f"/jobs/{j['id']}", json={"params": {"steps": 3}, "name": "same"}).json()
    assert back["targets"][0]["params_override"] == {"steps": 2}, "the override rows are kept"


@pytest.mark.pg
def test_a_timezone_agnostic_type_runs_a_plant_without_a_timezone(mapi, mp_pg, monkeypatch):
    _noop_needs_tz(monkeypatch, False)
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.third}])
    assert j["target_count"] == 2 and j["target_skipped"] == 0
    done = wait_batch(mapi, mapi.post(f"/jobs/{j['id']}/run").json()["batch"]["id"])
    assert done["batch"]["status"] == "succeeded" and done["batch"]["counts"]["total"] == 2


@pytest.mark.pg
def test_a_fire_returns_at_once_and_the_children_show_queued(mapi, mp_pg):
    import backend.jobs.runner as rn
    j = mk(mapi, mp_pg.plant, params={"steps": 1, "sleep_s": 1},
           targets=[{"kind": "explicit", "value": mp_pg.plant}, {"kind": "explicit", "value": mp_pg.other}],
           schedules=[{"kind": "daily", "time_of_day": "08:00", "tz_mode": "utc"}])
    t0 = time.time()
    bid = rn.fire_schedule(j["schedules"][0]["id"])
    assert time.time() - t0 < 1.0, "no fire worker is held for the run"
    first = mapi.get(f"/jobs/batches/{bid}").json()
    assert first["batch"]["status"] == "running" and len(first["runs"]) == 2
    assert all(x["scheduled_for"] for x in first["runs"])
    wait_batch(mapi, bid)


@pytest.mark.pg
def test_an_empty_expansion_never_makes_a_green_batch(mapi, mp_pg):
    import backend.jobs.data as data
    import backend.jobs.runner as rn
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}])
    bid = rn._fan_out(data.get_job(j["id"]), {"plants": [], "warnings": [], "single": False}, trigger="schedule",
                      schedule_id=None, triggered_by="schedule", skip_if_running=True)
    b = data.get_batch(bid)
    assert b["status"] == "warning" and b["summary"]["note"] and b["ended_at"]
    bid2 = data.insert_batch(job_id=j["id"], schedule_id=None, scheduled_for=None, trigger="manual", triggered_by="x")
    assert data.finish_batch(bid2)["status"] == "warning", "a batch with no children is never succeeded"


@pytest.mark.pg
def test_a_re_armed_once_a_day_fire_does_not_run_the_same_plant_twice_on_a_local_date(mapi, mp_pg):
    import backend.jobs.runner as rn
    j = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}],
           schedules=[{"kind": "daily", "time_of_day": "08:00"}])
    sid = j["schedules"][0]["id"]
    wait_batch(mapi, rn.fire_schedule(sid, mp_pg.plant))
    assert rn.fire_schedule(sid, mp_pg.plant) is None, "already ran today (a timezone edit re-armed the fire)"
    hourly = mk(mapi, mp_pg.plant, targets=[{"kind": "explicit", "value": mp_pg.plant}], schedules=[{"kind": "hourly", "time_of_day": "00:15"}])
    hid = hourly["schedules"][0]["id"]
    wait_batch(mapi, rn.fire_schedule(hid, mp_pg.plant))
    assert rn.fire_schedule(hid, mp_pg.plant), "hourly fires are not deduplicated"
