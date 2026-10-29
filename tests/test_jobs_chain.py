"""W4a: multi-step chains, the purge step, job templates.

Pure tests drive `backend.jobs.types.chain.run` with an in-memory step store and fake job types registered in the real
registry (so the semantics are tested without a database); pg tests (`@pytest.mark.pg`, `NIMBUS_TEST_DB=1`, local
Postgres only) run chains through the real runner, real advisory locks and the real purge.
"""
from __future__ import annotations

import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone

import pytest
from pydantic import BaseModel, ValidationError

import backend.jobs.data as data
from backend.jobs import registry, runner, templates, window_service, windows
from backend.jobs.context import JobContext
from backend.jobs.registry import REGISTRY, JobOutcome, JobType
from backend.jobs.types import chain, purge

pytest_plugins = ("tests.support.planning_pg",)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "schema.sql")
STEP_MIGRATION = os.path.join(ROOT, "migrations", "2026-11-01-1-job-step-run.sql")
TEMPLATE_MIGRATION = os.path.join(ROOT, "migrations", "2026-11-01-2-job-template.sql")
DESTRUCTIVE = re.compile(r"\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b", re.IGNORECASE)
FIXED_NOW = datetime(2026, 10, 29, 3, 0, tzinfo=timezone.utc)      # 22:00 on Oct 28 in Chicago, 16:00 on Oct 29 in Auckland


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


# ------------------------------------------------------------------------------------------------ DDL pins
def test_step_and_template_ddl_match_migration_and_schema_verbatim():
    assert data.JOB_STEP_DDL.strip() in _read(STEP_MIGRATION) and data.JOB_STEP_DDL.strip() in _read(SCHEMA)
    assert data.JOB_TEMPLATE_DDL.strip() in _read(TEMPLATE_MIGRATION) and data.JOB_TEMPLATE_DDL.strip() in _read(SCHEMA)
    assert data.JOB_COLUMN_DDL.strip() in _read(SCHEMA)


def test_new_migrations_are_create_only_without_destructive_words_or_cascade():
    for path, ddl in ((STEP_MIGRATION, data.JOB_STEP_DDL), (TEMPLATE_MIGRATION, data.JOB_TEMPLATE_DDL)):
        text = _read(path)
        assert not DESTRUCTIVE.search(text) and not DESTRUCTIVE.search(ddl), path
        assert "CASCADE" not in text.upper()
        stmts = [s.strip() for s in re.sub(r"--[^\n]*", "", text).split(";") if s.strip()]
        assert stmts and all(re.match(r"CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS", s, re.I) for s in stmts), path


def test_template_link_and_step_seq_come_from_the_startup_hook_not_a_migration():
    for path in (STEP_MIGRATION, TEMPLATE_MIGRATION):
        text = _read(path)
        for col in ("template_id", "template_version", "step_seq"):
            assert col not in text, (path, col)
    for col in ("template_id", "template_version", "step_seq"):
        assert col in data.JOB_COLUMN_DDL


# ------------------------------------------------------------------------------------------- harness (no DB)
class FakeStore:
    """The step persistence `chain.run` talks to, in memory."""

    def __init__(self, resume=None, prior=None):
        self.rows: dict[int, dict] = {}
        self.resume = resume
        self.prior = prior or []
        self.events: list[tuple] = []

    def run_resume(self, run_id):
        return self.resume

    def list_steps(self, run_id):
        return self.prior

    def insert_step_rows(self, run_id, rows):
        for r in rows:
            self.rows[r["seq"]] = {"status": "pending", "summary": None, "error": None, "error_kind": None,
                                   "action_id": None, **r}

    def start_step(self, run_id, seq):
        self.rows[seq]["status"] = "running"
        self.events.append(("start", seq))

    def finish_step(self, run_id, seq, status, summary=None, error=None, error_kind=None, action_id=None):
        self.rows[seq].update(status=status, summary=summary, error=error, error_kind=error_kind, action_id=action_id)
        self.events.append(("finish", seq, status))

    def statuses(self):
        return [self.rows[s]["status"] for s in sorted(self.rows)]


class P(BaseModel):
    tag: str = ""


class DryP(BaseModel):
    dry: bool = False


@pytest.fixture
def world(monkeypatch):
    """A shared 'database' the fake steps commit into, a fake store, and `reg()` to register fake types."""
    w = type("W", (), {})()
    w.committed: list[str] = []
    w.store = FakeStore()
    monkeypatch.setattr(chain, "_store", w.store)

    def reg(key, fn=None, *, params=P, **kw):
        def default(ctx, p):
            w.committed.append(f"{key}:{getattr(p, 'tag', '')}")
            return JobOutcome("succeeded", {"action_id": f"act-{key}-{len(w.committed)}"})
        monkeypatch.setitem(REGISTRY, key, JobType(key=key, label=key.upper(), params_model=params, run=fn or default,
                                                   idempotent=kw.pop("idempotent", True), **kw))

    def failing(ctx, p):
        return JobOutcome("failed", {"error_kind": "config"}, "boom")

    reg("t.ok")
    reg("t.fail", failing)
    reg("t.warn", lambda ctx, p: JobOutcome("warning", {}))
    reg("t.raise", lambda ctx, p: (_ for _ in ()).throw(RuntimeError("kaput")))
    w.reg = reg
    return w


def run_chain(world, steps, **ctx_kw):
    lines: list[dict] = []
    ctx = JobContext(run_id=1, plant="P1", job_id=7, sink=lambda rows: lines.extend(rows), flush_interval_s=0)
    out = chain.run(ctx, chain.ChainParams.model_validate({"steps": steps}))
    ctx.flush()
    return out, ctx, lines


def S(type_, **kw):
    return {"type": type_, "params": {"tag": kw.pop("tag", "")}, **kw}


# ------------------------------------------------------------------------------------- chain semantics (pure)
def test_a_failed_first_step_stops_the_chain_and_skips_the_rest(world):
    out, _ctx, lines = run_chain(world, [S("t.fail"), S("t.ok", tag="never")])
    assert world.store.statuses() == ["failed", "skipped"]
    assert world.committed == [], "step 2 must not run"
    assert out.status == "failed" and out.error == "step 1 (T.FAIL) failed: boom"
    assert out.summary["failed_step"] == "step 1: T.FAIL" and out.summary["error_kind"] == "config"
    assert world.store.rows[2]["summary"] == {"reason": "an earlier step failed"}
    assert [r["status"] for r in out.summary["steps"]] == ["failed", "skipped"]
    assert any(l["level"] == "warn" and l["step_seq"] == 1 for l in lines)


def test_each_step_commits_by_itself_and_the_next_sees_it(world):
    seen = []

    def second(ctx, p):
        seen.append(list(world.committed))        # step 2 reads what step 1 committed
        world.committed.append("second")
        return JobOutcome("succeeded", {"action_id": "act-2"})

    world.reg("t.second", second)
    out, _ctx, _lines = run_chain(world, [S("t.ok", tag="a"), S("t.second"), S("t.fail")])
    assert seen == [["t.ok:a"]]
    assert world.committed == ["t.ok:a", "second"], "the later failure does not undo the earlier steps"
    assert out.summary["action_ids"] == ["act-t.ok-1", "act-2"]
    assert world.store.rows[1]["action_id"] == "act-t.ok-1" and world.store.rows[2]["action_id"] == "act-2"
    assert out.status == "failed"


def test_continue_on_failure_keeps_going_and_ends_as_a_warning(world):
    out, _ctx, _l = run_chain(world, [S("t.fail", continue_on_failure=True), S("t.ok", tag="b"), S("t.warn")])
    assert world.store.statuses() == ["failed", "succeeded", "warning"]
    assert world.committed == ["t.ok:b"]
    assert out.status == "warning" and "failed_step" not in out.summary


def test_a_raising_step_fails_that_step_and_is_classified_system(world):
    out, _ctx, lines = run_chain(world, [S("t.raise"), S("t.ok")])
    assert world.store.rows[1]["error"] == "RuntimeError: kaput" and world.store.rows[1]["error_kind"] == "system"
    assert out.status == "failed" and any(l["level"] == "error" for l in lines)


def test_run_on_failure_and_always_steps_run_as_cleanup(world):
    out, _ctx, _l = run_chain(world, [S("t.fail"), S("t.ok", tag="cleanup", run_on="failure"),
                                      S("t.ok", tag="always", run_on="always"), S("t.ok", tag="normal")])
    assert world.committed == ["t.ok:cleanup", "t.ok:always"]
    assert world.store.statuses() == ["failed", "succeeded", "succeeded", "skipped"]
    assert out.status == "failed", "a cleanup step does not make the chain succeed"


def test_a_cleanup_step_is_skipped_when_nothing_failed(world):
    out, _ctx, _l = run_chain(world, [S("t.ok", tag="a"), S("t.ok", tag="c", run_on="failure"),
                                      S("t.ok", tag="z", run_on="always")])
    assert world.committed == ["t.ok:a", "t.ok:z"]
    assert world.store.rows[2]["summary"] == {"reason": "no earlier step failed"} and out.status == "succeeded"


def test_a_tolerated_failure_still_triggers_a_run_on_failure_step(world):
    run_chain(world, [S("t.fail", continue_on_failure=True), S("t.ok", tag="c", run_on="failure")])
    assert world.committed == ["t.ok:c"]


def test_cancel_mid_chain_skips_everything_left_including_cleanup(world):
    def cancelling(ctx, p):
        world.committed.append("cancelling")
        ctx.cancel_event.set()                      # the admin pressed Cancel while this step ran
        return JobOutcome("succeeded", {})

    world.reg("t.cancel", cancelling)
    out, ctx, _l = run_chain(world, [S("t.ok", tag="a"), S("t.cancel"), S("t.ok", tag="b"),
                                     S("t.ok", tag="c", run_on="always")])
    assert world.store.statuses() == ["succeeded", "cancelled", "skipped", "skipped"]
    assert world.committed == ["t.ok:a", "cancelling"]
    assert ctx.cancelled and out.status != "failed", "the runner turns this into `cancelled`"
    assert world.store.rows[3]["summary"] == {"reason": "the run was cancelled"}


def test_a_step_that_raises_job_cancelled_is_cancelled_not_failed(world):
    from backend.jobs.context import JobCancelled

    def stop(ctx, p):
        ctx.cancel_event.set()
        raise JobCancelled("run was cancelled")

    world.reg("t.stop", stop)
    out, _c, _l = run_chain(world, [S("t.stop"), S("t.ok")])
    assert world.store.statuses() == ["cancelled", "skipped"] and out.status != "failed"


def test_a_timeout_marks_the_running_step_failed_not_cancelled(world):
    def slow(ctx, p):
        ctx.timed_out = True
        ctx.cancel_event.set()
        ctx.check_cancel()

    world.reg("t.slow", slow)
    out, _c, _l = run_chain(world, [S("t.slow"), S("t.ok")])
    assert world.store.rows[1]["status"] == "failed" and world.store.rows[1]["error"] == "timed out"
    assert world.store.rows[2]["status"] == "skipped"


def test_mixed_dry_run_and_apply_steps_are_refused_when_saving(world):
    world.reg("t.dry", params=DryP, dry_run=("dry", True))
    world.reg("t.apply", params=DryP, dry_run=("dry", True))
    with pytest.raises(ValidationError, match="cannot mix dry-run and apply"):
        chain.ChainParams.model_validate({"steps": [{"type": "t.dry", "params": {"dry": True}},
                                                    {"type": "t.apply", "params": {"dry": False}}]})
    world.reg("t.read", kind="report", mutates=False)
    ok = chain.ChainParams.model_validate({"steps": [{"type": "t.dry", "params": {"dry": True}},
                                                     {"type": "t.apply", "params": {"dry": True}},
                                                     {"type": "t.read", "params": {}}]})
    assert len(ok.steps) == 3, "an all-dry chain (and a read-only step beside it) is fine"
    with pytest.raises(ValidationError):                 # a type with no dry-run mode always applies
        chain.ChainParams.model_validate({"steps": [{"type": "t.dry", "params": {"dry": True}}, {"type": "t.fail"}]})


def test_a_dry_run_chain_reports_dry_run_mode_and_hoists_the_proposal(world):
    world.reg("t.dry", lambda ctx, p: JobOutcome("succeeded", {"proposal": {"patches": [1]}, "proposal_truncated": False}),
              params=DryP, dry_run=("dry", True))
    out, _c, _l = run_chain(world, [{"type": "t.dry", "params": {"dry": True}}])
    assert out.summary["mode"] == "dry_run" and out.summary["apply_mode"] == "propose"
    assert out.summary["proposal"] == {"patches": [1]}
    assert "proposal" not in (world.store.rows[1]["summary"] or {}), "the step row stays small"


def test_chain_validation_rules(world):
    for bad, msg in (([{"type": "nope"}], "unknown job type"), ([{"type": "chain"}], "cannot contain a chain"),
                     ([{"type": "t.ok"}] * 11, "at most 10")):
        with pytest.raises(ValidationError, match=msg):
            chain.ChainParams.model_validate({"steps": bad})
    p = chain.ChainParams.model_validate({"steps": [{"type": "t.ok", "params": {"tag": "x"}}]})
    assert p.steps[0].params == {"tag": "x"} and p.steps[0].run_on == "success" and p.steps[0].continue_on_failure is False


def test_the_chain_timeout_is_the_sum_of_the_steps_and_the_log_cap_scales(world):
    world.reg("t.slowtype", default_timeout_s=100)
    params = chain.ChainParams.model_validate({"steps": [{"type": "t.slowtype"}, {"type": "t.slowtype"}]})
    assert chain.timeout_s(params) == 2 * (100 + chain.STEP_TIMEOUT_MARGIN_S)
    _o, ctx, _l = run_chain(world, [S("t.ok")] * 3)
    assert ctx.max_lines == 6000
    _o, ctx, _l = run_chain(world, [S("t.ok")] * 9)
    assert ctx.max_lines == 8000, "capped"


def test_log_lines_carry_their_step_and_the_runner_lines_after_the_chain_carry_none(world):
    out, ctx, lines = run_chain(world, [S("t.ok"), S("t.warn")])
    assert {l["step_seq"] for l in lines} == {None, 1, 2}, "the opening line belongs to the run, the rest to a step"
    assert lines[0]["step_seq"] is None and ctx.step_seq is None


def test_resume_runs_from_the_original_snapshot_and_marks_earlier_steps_as_done_earlier(world):
    prior = [{"step_type": "t.ok", "params": {"tag": "old1"}, "label": None, "continue_on_failure": False, "run_on": "success"},
             {"step_type": "t.ok", "params": {"tag": "old2"}, "label": "Second", "continue_on_failure": False, "run_on": "success"}]
    world.store.resume, world.store.prior = {"from_run": 9, "from_seq": 2}, prior
    # the job's CURRENT params say something else entirely: the snapshot of run 9 wins
    out, _c, _l = run_chain(world, [S("t.ok", tag="edited-1"), S("t.ok", tag="edited-2"), S("t.ok", tag="edited-3")])
    assert world.committed == ["t.ok:old2"]
    assert world.store.statuses() == ["skipped", "succeeded"]
    assert world.store.rows[1]["summary"] == {"reason": "ran in an earlier run", "ran_in_run": 9}
    assert out.summary["resume"] == {"from_run": 9, "from_seq": 2} and len(out.summary["steps"]) == 1


def test_only_a_reports_window_feeds_the_since_last_success_watermark(world):
    win = {"start": "a", "end": "b", "label": "l", "timezone": "x"}
    world.reg("t.report", lambda ctx, p: JobOutcome("succeeded", {"window": win}), kind="report", mutates=False)
    world.reg("t.mut", lambda ctx, p: JobOutcome("succeeded", {"window": {"start": "x", "end": "y", "label": "z", "timezone": "x"}}))
    out, _c, _l = run_chain(world, [S("t.report"), S("t.mut")])
    assert out.summary["window"] == win


def test_the_last_report_artifact_is_kept(world):
    world.reg("t.report", lambda ctx, p: JobOutcome("succeeded", {}, artifact={"sections": [], "summary": {"n": 1}}),
              kind="report", mutates=False)
    out, _c, _l = run_chain(world, [S("t.report")])
    assert out.artifact == {"sections": [], "summary": {"n": 1}}
    assert world.store.rows[1]["summary"] == {"artifact": True}


# ---------------------------------------------------------------------------------------------- locks (no DB)
def test_chain_lock_names_are_the_sorted_union_of_its_steps(world):
    params = chain.ChainParams.model_validate({"steps": [
        {"type": "optimizer.plant", "params": {}}, {"type": "purge.orders", "params": {}},
        {"type": "optimizer.plant", "params": {"apply_mode": "apply"}}]})
    names = REGISTRY["chain"].lock_names("P1", params)
    assert names == sorted({"jobs:optimizer.plant:P1", "jobs:purge.orders:P1"})
    assert REGISTRY["optimizer.plant"].lock_names("P1", REGISTRY["optimizer.plant"].params_model()) == ["jobs:optimizer.plant:P1"]


def _lock_world(monkeypatch):
    held: set[str] = set()
    monkeypatch.setattr(runner.data, "try_session_lock", lambda conn, key: (False if key in held else held.add(key) or True))
    monkeypatch.setattr(runner.data, "release_session_lock", lambda conn, key: held.discard(key))
    return held


def test_a_multi_key_lock_blocks_a_standalone_job_and_vice_versa(monkeypatch):
    held = _lock_world(monkeypatch)
    chain_p = chain.ChainParams.model_validate({"steps": [{"type": "purge.orders", "params": {}},
                                                          {"type": "optimizer.plant", "params": {}}]})
    chain_keys = REGISTRY["chain"].lock_names("P1", chain_p)
    standalone = REGISTRY["optimizer.plant"].lock_names("P1", REGISTRY["optimizer.plant"].params_model())
    assert runner._try_locks(None, chain_keys) is True
    assert runner._try_locks(None, standalone) is False, "a running chain blocks a standalone optimizer on the plant"
    for k in chain_keys:
        held.discard(k)
    assert runner._try_locks(None, standalone) is True
    assert runner._try_locks(None, chain_keys) is False, "and a standalone optimizer blocks the chain"
    assert held == set(standalone), "a failed attempt releases the locks it had taken (all or none)"


def test_a_failed_multi_lock_attempt_releases_what_it_took(monkeypatch):
    held = _lock_world(monkeypatch)
    held.add("b")
    assert runner._try_locks(None, ["a", "b", "c"]) is False
    assert held == {"b"}


def test_the_slots_of_a_chain_are_the_unique_slots_of_its_steps(monkeypatch):
    sem = threading.BoundedSemaphore(1)
    monkeypatch.setitem(REGISTRY, "t.slotted", JobType(key="t.slotted", label="s", params_model=P, run=lambda c, p: JobOutcome(),
                                                       slot=lambda: sem))
    params = chain.ChainParams.model_validate({"steps": [{"type": "t.slotted"}, {"type": "t.slotted"}, {"type": "purge.orders"}]})
    assert REGISTRY["chain"].slot_list(params) == [sem]


# ------------------------------------------------------------------------------------------------- purge (pure)
@pytest.fixture
def purge_world(monkeypatch):
    w = type("W", (), {})()
    w.calls, w.tz, w.total = [], "America/Chicago", 3
    monkeypatch.setattr(data, "plant_has_timezone", lambda p: True)
    monkeypatch.setattr(data, "plant_timezone", lambda p: w.tz)
    monkeypatch.setattr(data, "last_success_watermark", lambda *a, **k: None)
    orig = window_service.resolve_for_plant
    monkeypatch.setattr(purge.window_service, "resolve_for_plant", lambda plant, win, **kw: orig(plant, win, now=FIXED_NOW, **kw))
    monkeypatch.setattr(purge.db, "preview_purge_orders", lambda plant, s, e, m=None: (
        w.calls.append(("preview", s, e, m)) or {"total": w.total, "planner_overridden": 1}))

    def fake_purge(plant, s, e, m=None, *, user_email=None, max_rows=None, action_id=None):
        w.calls.append(("purge", s, e, user_email, max_rows, action_id))
        return {"status": "ok", "deleted": w.total}

    monkeypatch.setattr(purge.db, "purge_orders_by_date", fake_purge)
    import backend.setup.data as setup_data
    monkeypatch.setattr(setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kw: w.calls.append(("capture", kw["actor"], kw["plants"])) or [])
    w.run = lambda **params: purge.run(JobContext(run_id=1, plant="P1", job_id=7, sink=lambda r: None),
                                       purge.PurgeParams.model_validate(params))
    return w


def test_a_rolling_window_resolves_in_the_plant_timezone(purge_world):
    purge_world.run(dry_run=True, window=windows.older_than_days(30))
    (_k, start, end, _m) = purge_world.calls[0]
    # 22:00 on Oct 28 in Chicago: the plant's day 30 days back is Sep 28, so the inclusive end is Sep 27 23:59:59.999999
    assert end == datetime(2026, 9, 27, 23, 59, 59, 999999)
    assert start < datetime(2017, 1, 1), "older-than reaches back ten years (the open start)"
    purge_world.calls.clear()
    purge_world.tz = "Pacific/Auckland"            # the same instant is already Oct 29 there
    purge_world.run(dry_run=True, window=windows.older_than_days(30))
    assert purge_world.calls[0][2] == datetime(2026, 9, 28, 23, 59, 59, 999999)


def test_the_min_age_floor_rejects_a_too_young_window_when_saving(monkeypatch):
    for young in (windows.older_than_days(3), windows.last_days(30), windows.this_month(), windows.next_days(5)):
        with pytest.raises(ValidationError, match="minimum age"):
            purge.PurgeParams.model_validate({"window": young})
    purge.PurgeParams.model_validate({"window": windows.older_than_days(7)})
    with pytest.raises(ValidationError, match="last successful"):
        purge.PurgeParams.model_validate({"window": windows.since_last_success()})
    monkeypatch.setenv("NIMBUS_JOBS_PURGE_MIN_AGE_DAYS", "14")
    with pytest.raises(ValidationError, match="14-day"):
        purge.PurgeParams.model_validate({"window": windows.older_than_days(10)})
    monkeypatch.setenv("NIMBUS_JOBS_PURGE_MIN_AGE_DAYS", "0")
    assert purge.min_age_days() == 1, "the floor can never reach zero"


def test_the_min_age_floor_is_checked_again_against_the_resolved_dates(purge_world):
    fixed = lambda to: {"mode": "fixed", "fixed": {"from": "2026-01-01", "to": to}}      # noqa: E731
    out = purge_world.run(window=fixed("2026-10-25"), dry_run=True)       # plant today is Oct 28: newest allowed day is Oct 21
    assert out.status == "failed" and out.summary["error_kind"] == "config" and out.summary["failed_step"] == "guard"
    assert "at least 7 days old" in out.error and purge_world.calls == [], "nothing is even previewed"
    assert purge_world.run(window=fixed("2026-10-21"), dry_run=True).status == "succeeded"


def test_the_max_rows_guard_fails_before_anything_is_deleted(purge_world):
    purge_world.total = 50
    out = purge_world.run(max_rows=10, window=windows.older_than_days(30))
    assert out.status == "failed" and out.summary["failed_step"] == "guard" and out.summary["matched"] == 50
    assert "nothing was deleted" in out.error
    assert [c[0] for c in purge_world.calls] == ["preview"], "no setup capture, no delete"


def test_a_dry_run_only_previews(purge_world):
    out = purge_world.run(dry_run=True, window=windows.older_than_days(30))
    assert out.status == "succeeded" and out.summary["dry_run"] is True and out.summary["matched"] == 3
    assert out.summary["deleted"] == 0 and [c[0] for c in purge_world.calls] == ["preview"]


def test_a_real_purge_captures_setup_then_deletes_as_the_job_with_its_own_action_id(purge_world):
    out = purge_world.run(max_rows=10, window=windows.older_than_days(30), machines=[" L1 ", ""])
    kinds = [c[0] for c in purge_world.calls]
    assert kinds == ["preview", "capture", "purge"], "the capture is adjacent to the delete, after the guard"
    assert purge_world.calls[0][3] == ["L1"]
    _k, _s, _e, user, max_rows, action_id = purge_world.calls[2]
    assert user == "job:7" and max_rows == 10 and action_id and out.summary["action_id"] == action_id
    assert out.status == "succeeded" and out.summary["deleted"] == 3 and out.summary["window"]["timezone"] == "America/Chicago"


def test_a_race_past_the_guard_is_refused_inside_the_delete(purge_world, monkeypatch):
    def over(*a, **k):
        raise purge.db.PurgeLimitExceeded("11 orders match, more than the limit of 10")

    monkeypatch.setattr(purge.db, "purge_orders_by_date", over)
    out = purge_world.run(max_rows=10, window=windows.older_than_days(30))
    assert out.status == "failed" and out.summary["error_kind"] == "transient" and "nothing was deleted" in out.error


def test_a_plant_without_a_timezone_fails_the_purge_as_a_config_error(purge_world, monkeypatch):
    monkeypatch.setattr(data, "plant_has_timezone", lambda p: False)
    out = purge_world.run(dry_run=True)
    assert out.status == "failed" and out.summary["error_kind"] == "config" and "timezone" in out.error


def test_purge_is_a_mutating_non_idempotent_step_with_a_dry_run_mode_and_two_locks():
    jt = REGISTRY["purge.orders"]
    assert jt.mutates and not jt.idempotent and jt.dry_run == ("dry_run", True) and jt.needs_plant_timezone
    assert jt.lock_names("P1", jt.params_model()) == ["jobs:optimizer.plant:P1", "jobs:purge.orders:P1"]
    assert jt.is_dry_run(jt.params_model(dry_run=True)) is True and jt.is_dry_run(jt.params_model()) is False


# --------------------------------------------------------------------------------------------- templates (pure)
def test_builtin_templates_are_valid_chains():
    names = [t["name"] for t in templates.BUILTIN_TEMPLATES]
    assert names == ["Purge then re-optimize", "Optimize then report"]
    for t in templates.BUILTIN_TEMPLATES:
        steps = chain.normalize_steps(t["steps"])
        assert len(steps) == 2 and all("window" in s["params"] or s["type"] != "purge.orders" for s in steps)


def test_step_diff_names_what_changed():
    a = chain.normalize_steps([{"type": "purge.orders", "params": {"max_rows": 100}},
                               {"type": "optimizer.plant", "params": {}}, {"type": "report.late_orders", "params": {}}])
    b = chain.normalize_steps([{"type": "purge.orders", "params": {"max_rows": 5000}, "continue_on_failure": True},
                               {"type": "optimizer.plant", "params": {}}])
    diff = templates.diff_steps(a, b)
    assert [d["change"] for d in diff] == ["changed", "same", "removed"]
    assert sorted(diff[0]["fields"]) == ["continue_on_failure", "params.max_rows"]
    assert [d["change"] for d in templates.diff_steps(b, a)] == ["changed", "same", "added"]


# ================================================================================================= pg tests
@pytest.fixture
def chain_pg(planning_pg, monkeypatch):
    monkeypatch.setenv("NIMBUS_JOBS_STUBS", "1")
    data.ensure_job_tables()
    db = planning_pg.db
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE plants SET timezone = 'America/Chicago' WHERE plant = ANY(%s)", ([planning_pg.plant, planning_pg.other],))
        conn.commit()
    planning_pg.jobs, planning_pg.tpl_names = [], []
    yield planning_pg
    plants = [planning_pg.plant, planning_pg.other]
    with db._pool.connection() as conn, conn.cursor() as cur:
        runs = "SELECT id FROM job_run WHERE plant = ANY(%s)"
        cur.execute(f"DELETE FROM job_step_run WHERE run_id IN ({runs})", (plants,))
        cur.execute(f"DELETE FROM job_run_artifact WHERE run_id IN ({runs})", (plants,))
        cur.execute(f"DELETE FROM job_run_log WHERE run_id IN ({runs})", (plants,))
        cur.execute("DELETE FROM job_run WHERE plant = ANY(%s)", (plants,))
        cur.execute("DELETE FROM job_schedule WHERE job_id IN (SELECT id FROM job_definition WHERE plant = ANY(%s))", (plants,))
        cur.execute("DELETE FROM job_definition WHERE plant = ANY(%s)", (plants,))
        cur.execute("DELETE FROM job_template WHERE name = ANY(%s)", (planning_pg.tpl_names,))
        cur.execute("DELETE FROM admin_audit WHERE user_email LIKE 'job:%%' AND details ->> 'plant' = ANY(%s)", (plants,))
        conn.commit()


def make_chain(ctx, steps, plant=None, **kw):
    jid = data.create_job(plant=plant or ctx.plant, job_type="chain", name="chain", params={"steps": steps}, enabled=True,
                          retry_max=0, timeout_s=None, schedules=[], actor="t@example.com", **kw)
    ctx.jobs.append(jid)
    return jid


def noop(outcome="succeeded", **kw):
    return {"type": "noop", "params": {"steps": 1, "sleep_s": kw.pop("sleep_s", 0), "outcome": outcome}, **kw}


def wait_run(run_id, t=30):
    end = time.time() + t
    while time.time() < end:
        r = data.get_run(run_id)
        if r["status"] not in ("scheduled", "running"):
            return r
        time.sleep(0.1)
    raise AssertionError(data.get_run(run_id))


@pytest.mark.pg
def test_a_chain_runs_its_steps_in_order_with_step_rows_and_step_tagged_logs(chain_pg):
    jid = make_chain(chain_pg, [noop(), noop("warning"), noop()])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    steps = data.list_steps(rid)
    assert run["status"] == "warning" and [s["status"] for s in steps] == ["succeeded", "warning", "succeeded"]
    assert [s["seq"] for s in steps] == [1, 2, 3] and all(s["started_at"] and s["ended_at"] for s in steps)
    assert [r["status"] for r in run["summary"]["steps"]] == ["succeeded", "warning", "succeeded"]
    assert run["summary"]["mode"] == "apply" and run["summary"]["chain"] is True
    lines = data.list_log(rid, after_seq=0, min_level="debug", limit=2000)
    assert {l["step_seq"] for l in lines} >= {1, 2, 3}
    only2 = data.list_log(rid, after_seq=0, min_level="debug", limit=2000, step_seq=2)
    assert only2 and {l["step_seq"] for l in only2} == {2}


@pytest.mark.pg
def test_a_failed_step_stops_the_chain_end_to_end(chain_pg):
    jid = make_chain(chain_pg, [noop(), noop("failed"), noop()])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] == "failed" and [s["status"] for s in data.list_steps(rid)] == ["succeeded", "failed", "skipped"]
    assert run["summary"]["failed_step"] == "step 2: No-op (test)" and run["summary"]["error_kind"] == "system"
    assert "step 2" in run["error"]
    errors = data.list_log(rid, after_seq=0, min_level="error", limit=100)
    assert errors, "a failed chain always leaves an error line for the Errors view"


@pytest.mark.pg
def test_continue_on_failure_and_run_on_cleanup_end_to_end(chain_pg):
    jid = make_chain(chain_pg, [noop("failed", continue_on_failure=True), noop(),
                                {**noop(), "run_on": "failure"}])
    rid = runner.run_job(job_id=jid, trigger="manual")
    assert [s["status"] for s in data.list_steps(rid)] == ["failed", "succeeded", "succeeded"]
    assert data.get_run(rid)["status"] == "warning"


@pytest.mark.pg
def test_restart_from_a_failed_step_uses_the_failed_runs_snapshot(chain_pg):
    jid = make_chain(chain_pg, [noop(), noop("failed"), noop()])
    first = runner.run_job(job_id=jid, trigger="manual")
    assert data.get_run(first)["status"] == "failed"
    # an admin edits the job meanwhile: step 2 now succeeds and there is a fourth step. The restart must not see that.
    data.patch_job(jid, {"params": {"steps": [noop(), noop(), noop(), noop()]}}, "t@example.com")
    job = data.get_job(jid)
    new_id = runner.start_manual_run(job, "t@example.com", "restart", resume={"from_run": first, "from_seq": 2})
    assert new_id
    run = wait_run(new_id)
    steps = data.list_steps(new_id)
    assert len(steps) == 3, "the snapshot has three steps, not the edited four"
    assert steps[0]["status"] == "skipped" and steps[0]["summary"]["ran_in_run"] == first
    assert [s["status"] for s in steps[1:]] == ["failed", "skipped"], "step 2 of the snapshot still fails"
    assert run["status"] == "failed" and data.run_resume(new_id) == {"from_run": first, "from_seq": 2}


@pytest.mark.pg
def test_cancel_mid_chain_skips_the_rest(chain_pg):
    jid = make_chain(chain_pg, [noop(), noop(sleep_s=30), noop(), {**noop(), "run_on": "always"}])
    job = data.get_job(jid)
    rid = runner.start_manual_run(job, "t@example.com")
    end = time.time() + 20
    while time.time() < end and not [s for s in data.list_steps(rid) if s["status"] == "running"]:
        time.sleep(0.1)
    runner.cancel_run(rid)
    run = wait_run(rid)
    assert run["status"] == "cancelled"
    assert [s["status"] for s in data.list_steps(rid)] == ["succeeded", "cancelled", "skipped", "skipped"]


@pytest.mark.pg
def test_a_running_chain_blocks_a_standalone_job_with_the_same_lock_and_vice_versa(chain_pg):
    jid = make_chain(chain_pg, [noop(sleep_s=3)])
    solo = data.create_job(plant=chain_pg.plant, job_type="noop", name="solo", params={"steps": 1, "sleep_s": 0}, enabled=True,
                           retry_max=0, timeout_s=None, schedules=[], actor="t@example.com")
    chain_pg.jobs.append(solo)
    rid = runner.start_manual_run(data.get_job(jid), "t@example.com")
    end = time.time() + 20
    while time.time() < end and data.get_run(rid)["status"] != "running":
        time.sleep(0.05)
    blocked = runner.run_job(job_id=solo, trigger="manual")
    assert data.get_run(blocked)["status"] == "skipped" and "still running" in data.get_run(blocked)["error"]
    assert wait_run(rid)["status"] == "succeeded"
    # and the other way round: a standalone job holding the lock makes the chain skip
    with chain_pg.db._pool.connection() as conn:
        assert data.try_session_lock(conn, f"jobs:noop:{chain_pg.plant}")
        try:
            skipped = runner.run_job(job_id=jid, trigger="manual")
            assert data.get_run(skipped)["status"] == "skipped"
            assert data.list_steps(skipped) == [], "a skipped chain never created step rows"
        finally:
            data.release_session_lock(conn, f"jobs:noop:{chain_pg.plant}")


@pytest.mark.pg
def test_a_chain_is_not_retried_when_a_step_is_not_safe_to_repeat(chain_pg, monkeypatch):
    monkeypatch.setattr(runner, "RETRY_DELAY_S", 0)
    monkeypatch.setitem(REGISTRY, "noop", __import__("dataclasses").replace(REGISTRY["noop"], idempotent=False))
    jid = make_chain(chain_pg, [noop("failed")])
    data.patch_job(jid, {"retry_max": 2}, "t@example.com")
    runner.run_job(job_id=jid, trigger="manual")
    with chain_pg.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM job_run WHERE job_id = %s", (jid,))
        assert cur.fetchone()[0] == 1
    monkeypatch.setitem(REGISTRY, "noop", __import__("dataclasses").replace(REGISTRY["noop"], idempotent=True))
    runner.run_job(job_id=jid, trigger="manual")
    with chain_pg.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM job_run WHERE job_id = %s", (jid,))
        assert cur.fetchone()[0] == 1 + 3, "idempotent steps retry (attempt 1 plus 2 retries)"


@pytest.mark.pg
def test_templates_seed_version_and_keep_their_names_unique(chain_pg):
    names = {t["name"] for t in data.list_templates()}
    assert {"Purge then re-optimize", "Optimize then report"} <= names
    data.seed_builtin_templates()
    assert [t["name"] for t in data.list_templates()].count("Purge then re-optimize") == 1, "seeding is once by name"
    step = chain.normalize_steps([{"type": "report.late_orders", "params": {}}])
    name = f"zz chain test {chain_pg.plant}"
    chain_pg.tpl_names.append(name)
    tid = data.create_template(name=name, description=None, steps=step, defaults={}, actor="t@example.com")
    assert data.get_template(tid)["version"] == 1
    data.patch_template(tid, {"name": name + " (renamed)"}, "t")
    chain_pg.tpl_names.append(name + " (renamed)")
    assert data.get_template(tid)["version"] == 1, "a rename does not make jobs out of date"
    data.patch_template(tid, {"steps": chain.normalize_steps([{"type": "report.coverage", "params": {}}])}, "t")
    assert data.get_template(tid)["version"] == 2
    with pytest.raises(data.TemplateNameTaken):
        data.create_template(name=name.upper() + " (RENAMED)", description=None, steps=step, defaults={}, actor="t")
    data.patch_template(tid, {"archived": True}, "t")
    assert tid not in {t["id"] for t in data.list_templates()} and tid in {t["id"] for t in data.list_templates(True)}
    again = data.create_template(name=name + " (renamed)", description=None, steps=step, defaults={}, actor="t")
    assert again != tid, "an archived name can be reused"


@pytest.mark.pg
def test_a_job_keeps_its_copy_and_sees_a_template_change_only_as_a_version_difference(chain_pg):
    name = f"zz chain copy {chain_pg.plant}"
    chain_pg.tpl_names.append(name)
    steps = chain.normalize_steps([{"type": "report.late_orders", "params": {}}])
    tid = data.create_template(name=name, description=None, steps=steps, defaults={}, actor="t")
    jid = make_chain(chain_pg, steps, template_id=tid, template_version=1)
    data.patch_template(tid, {"steps": chain.normalize_steps([{"type": "report.coverage", "params": {}}])}, "t")
    job = data.get_job(jid)
    assert job["params"]["steps"][0]["type"] == "report.late_orders", "the job still holds ITS copy"
    assert job["template_id"] == tid and job["template_version"] == 1
    assert data.template_briefs([tid])[tid]["version"] == 2
    assert data.definition_to_wire(job)["template_version"] == 1


@pytest.mark.pg
def test_a_report_step_in_a_chain_stores_the_chains_artifact(chain_pg):
    jid = make_chain(chain_pg, [noop(), {"type": "report.coverage", "params": {}}])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] in ("succeeded", "warning"), run["error"]
    assert data.get_artifact(rid) is not None and run["summary"]["artifact"]["row_counts"] is not None
    assert data.list_steps(rid)[1]["summary"]["artifact"] is True


def _order(ctx, tag, finish, machine=None):
    oid = ctx.db.make_id(f"ZZPO{tag}", "ZZMAT")
    with ctx.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                    " basic_finish_date, scheduled_start, scheduled_end) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (oid, f"ZZPO{tag}", "ZZMAT", machine or ctx.machine, ctx.plant, finish - timedelta(hours=4), finish,
                     finish - timedelta(hours=4), finish))
        conn.commit()
    return oid


def _live_orders(ctx):
    with ctx.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM orders WHERE plant = %s AND material_number = 'ZZMAT'", (ctx.plant,))
        return {r[0] for r in cur.fetchall()}


@pytest.fixture
def old_orders(chain_pg):
    ctx = chain_pg
    now = datetime.now()
    ctx.old = [_order(ctx, "OLD1", now - timedelta(days=200)), _order(ctx, "OLD2", now - timedelta(days=100))]
    ctx.young = _order(ctx, "YNG", now - timedelta(days=2))
    ctx.future = _order(ctx, "FUT", now + timedelta(days=5))
    yield ctx
    with ctx.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM orders WHERE plant = %s AND material_number = 'ZZMAT'", (ctx.plant,))
        conn.commit()


@pytest.mark.pg
def test_a_real_purge_step_removes_only_old_orders_and_records_history(old_orders):
    ctx = old_orders
    step = {"type": "purge.orders", "params": {"window": windows.older_than_days(30), "max_rows": 10}}
    jid = make_chain(ctx, [step])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] == "succeeded", run["error"]
    assert _live_orders(ctx) == {ctx.young, ctx.future}
    st = data.list_steps(rid)[0]
    assert st["summary"]["deleted"] == 2 and st["action_id"] and st["summary"]["window"]["timezone"] == "America/Chicago"
    with ctx.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*), min(actor), min(source) FROM schedule_event WHERE plant = %s AND action_id::text = %s",
                    (ctx.plant, st["action_id"]))
        n, actor, source = cur.fetchone()
    assert n == 2 and actor == f"job:{jid}" and source == "purge"


@pytest.mark.pg
def test_the_purge_max_rows_guard_deletes_nothing_end_to_end(old_orders):
    ctx = old_orders
    jid = make_chain(ctx, [{"type": "purge.orders", "params": {"window": windows.older_than_days(30), "max_rows": 1}},
                           noop()])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] == "failed" and run["summary"]["error_kind"] == "config"
    assert _live_orders(ctx) == {*ctx.old, ctx.young, ctx.future}, "refused before deleting"
    assert [s["status"] for s in data.list_steps(rid)] == ["failed", "skipped"]


@pytest.mark.pg
def test_the_delete_itself_rolls_back_when_it_matches_more_than_max_rows(old_orders):
    ctx = old_orders
    end = datetime.now() - timedelta(days=30)
    with pytest.raises(ctx.db.PurgeLimitExceeded):
        ctx.db.purge_orders_by_date(ctx.plant, datetime(2000, 1, 1), end, None, user_email=ctx.actor, max_rows=1)
    assert _live_orders(ctx) == {*ctx.old, ctx.young, ctx.future}
    res = ctx.db.purge_orders_by_date(ctx.plant, datetime(2000, 1, 1), end, None, user_email=ctx.actor, max_rows=2)
    assert res["deleted"] == 2 and _live_orders(ctx) == {ctx.young, ctx.future}


@pytest.mark.pg
def test_a_dry_run_purge_chain_reports_what_it_would_remove(old_orders):
    ctx = old_orders
    jid = make_chain(ctx, [{"type": "purge.orders", "params": {"window": windows.older_than_days(30), "dry_run": True}}])
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] == "succeeded" and run["summary"]["mode"] == "dry_run"
    assert data.list_steps(rid)[0]["summary"]["matched"] == 2 and _live_orders(ctx) == {*ctx.old, ctx.young, ctx.future}


@pytest.mark.pg
def test_purge_then_optimize_template_chain_validates_and_the_purge_runs_first(old_orders, monkeypatch):
    """The built-in template as stored runs: purge applies first; the optimizer step is faked (no Node here)."""
    ctx = old_orders
    tpl = next(t for t in data.list_templates() if t["name"] == "Purge then re-optimize")
    steps = [dict(s) for s in tpl["steps"]]
    calls = []
    from backend.jobs.types import optimizer
    monkeypatch.setattr(optimizer, "_runner", lambda c, plant, p: calls.append((plant, sorted(_live_orders(ctx)))) or
                        {"late": 0, "moved": 0, "applied": 0})
    monkeypatch.setitem(REGISTRY, "optimizer.plant", __import__("dataclasses").replace(REGISTRY["optimizer.plant"], slot=None))
    jid = make_chain(ctx, steps)
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert run["status"] == "succeeded", run["error"]
    assert calls and set(calls[0][1]) == {ctx.young, ctx.future}, "step 2 saw step 1's committed purge"


@pytest.mark.pg
def test_the_retention_sweep_and_boot_sweep_handle_step_rows(chain_pg):
    jid = make_chain(chain_pg, [noop(), noop()])
    rid = runner.run_job(job_id=jid, trigger="manual")
    with chain_pg.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET created_at = now() - interval '40 days' WHERE id = %s", (rid,))
        conn.commit()
    res = data.sweep_job_runs(retention_days=14, pause_s=0)
    assert res["error"] is None and res["deleted_steps"] >= 2 and data.list_steps(rid) == []
    # a run caught by a restart: running step -> failed (system), pending -> skipped
    stuck = data.insert_run(job_id=jid, schedule_id=None, plant=chain_pg.plant, job_type="chain", status="scheduled", trigger="manual")
    data.mark_running(stuck)
    data.insert_step_rows(stuck, [{"seq": 1, "step_type": "noop", "params": {}}, {"seq": 2, "step_type": "noop", "params": {}}])
    data.start_step(stuck, 1)
    data.boot_sweep()
    assert [(s["status"], s["error_kind"]) for s in data.list_steps(stuck)] == [("failed", "system"), ("skipped", None)]


@pytest.mark.pg
def test_a_timed_out_chain_closes_its_open_steps_and_derives_the_step_bar(chain_pg):
    jid = make_chain(chain_pg, [noop(sleep_s=30), noop()], )
    data.patch_job(jid, {"timeout_s": 10}, "t")
    t0 = time.time()
    rid = runner.run_job(job_id=jid, trigger="manual")
    run = data.get_run(rid)
    assert time.time() - t0 < 40 and run["status"] == "failed" and "timed out" in run["error"]
    assert [s["status"] for s in data.list_steps(rid)] == ["failed", "skipped"]
    assert [r["status"] for r in run["summary"]["steps"]] == ["failed", "skipped"]


@pytest.fixture
def capi(chain_pg, client):
    import brain
    from backend.security import auth
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_admin] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    yield client
    brain.api.dependency_overrides.clear()


@pytest.mark.pg
def test_templates_end_to_end_over_http_create_from_template_diff_update_and_restart_from_step(capi, chain_pg):
    name = f"zz http tpl {chain_pg.plant}"
    chain_pg.tpl_names.append(name)
    steps = [{"type": "noop", "params": {"steps": 1, "sleep_s": 0, "outcome": "succeeded"}},
             {"type": "noop", "params": {"steps": 1, "sleep_s": 0, "outcome": "failed"}}]
    tpl = capi.post("/jobs/templates", json={"name": name, "steps": steps}).json()["template"]
    assert tpl["version"] == 1 and capi.post("/jobs/templates", json={"name": name.upper(), "steps": steps}).status_code == 409
    assert name in [x["name"] for x in capi.get("/jobs/templates").json()["templates"]]
    r = capi.post("/jobs", json={"plant": chain_pg.plant, "job_type": "chain", "name": "from tpl", "template_id": tpl["id"]})
    assert r.status_code == 200, r.text
    job = r.json()
    chain_pg.jobs.append(job["id"])
    assert job["template"] == {"id": tpl["id"], "name": name, "version": 1, "current_version": 1, "archived": False, "changed": False}
    # the template moves on: the job keeps its copy and says so; the diff names the change; Update applies it
    new_steps = [steps[0], {"type": "noop", "params": {"steps": 1, "sleep_s": 0, "outcome": "succeeded"}}]
    assert capi.patch(f"/jobs/templates/{tpl['id']}", json={"steps": new_steps}).json()["template"]["version"] == 2
    d = capi.get(f"/jobs/{job['id']}/template-diff").json()
    assert d["changed"] and [x["change"] for x in d["diff"]] == ["same", "changed"] and d["diff"][1]["fields"] == ["params.outcome"]
    # run the (old, failing) copy, then restart from the failed step: the noop type is idempotent so no confirm is needed
    run = capi.post(f"/jobs/{job['id']}/run").json()["run"]
    assert wait_run(run["id"])["status"] == "failed"
    detail = capi.get(f"/jobs/runs/{run['id']}").json()
    assert [s["status"] for s in detail["steps"]] == ["succeeded", "failed"]
    again = capi.post(f"/jobs/runs/{run['id']}/restart-step", json={})
    assert again.status_code == 200, again.text
    assert wait_run(again.json()["run"]["id"])["status"] == "failed", "the snapshot's step 2 still fails"
    assert capi.patch(f"/jobs/{job['id']}", json={"name": "from tpl"}).status_code == 200
    updated = capi.post(f"/jobs/{job['id']}/template/update").json()
    assert updated["template"]["changed"] is False
    run2 = capi.post(f"/jobs/{job['id']}/run").json()["run"]
    assert wait_run(run2["id"])["status"] == "succeeded", "after the update the job runs the template's new steps"
