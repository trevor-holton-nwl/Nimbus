"""Runner and scheduler behaviour that needs no database: `data` is replaced by an in-memory fake."""
import time

import pytest
from pydantic import BaseModel

from backend.jobs import runner, scheduler
from backend.jobs.registry import JobOutcome, JobType


class _P(BaseModel):
    pass


class FakeData:
    def __init__(self):
        self.finished, self.inserted, self.patched = [], [], []
        self.job = {"id": 1, "plant": "P", "job_type": "t", "params": {}, "retry_max": 0, "timeout_s": None,
                    "archived": False, "enabled": True}
        self.gets = []
        self.plant_ok = True

    def get_job(self, job_id):
        self.gets.append(job_id)
        return self.job if isinstance(self.job, dict) else self.job(len(self.gets))

    def get_schedule(self, sid):
        return {"id": sid, "job_id": 1, "retired": False, "paused": False, "kind": "daily", "skip_if_running": True}

    def plant_exists(self, plant):
        return self.plant_ok

    def insert_run(self, **kw):
        self.inserted.append(kw)
        return len(self.inserted)

    def patch_job(self, job_id, fields, actor):
        self.patched.append((job_id, fields, actor))
        return True

    def write_log_rows(self, run_id, rows):
        pass

    def mark_running(self, run_id):
        pass

    def get_run(self, run_id):
        return {"cancel_requested": False}

    def finish_run(self, run_id, status, summary, error, truncated):
        self.finished.append((run_id, status, error))

    def retire_schedule(self, sid):
        pass


@pytest.fixture
def fake(monkeypatch):
    f = FakeData()
    for name in ("get_job", "get_schedule", "plant_exists", "insert_run", "patch_job", "write_log_rows",
                 "mark_running", "get_run", "finish_run", "retire_schedule"):
        monkeypatch.setattr(runner.data, name, getattr(f, name))
    monkeypatch.setattr(runner, "KILL_GRACE_S", 0.5)
    return f


def _job_type(body, **kw):
    return JobType(key="t", label="t", params_model=_P, run=body, **kw)


def _run_body(jt, timeout):
    job = {"id": 1, "plant": "P"}
    return runner._run_body(1, job, jt, _P(), timeout)


def test_a_plain_body_is_held_to_the_timeout(fake):
    def body(ctx, params):
        ctx.sleep(1.5)
        return JobOutcome("succeeded")

    assert _run_body(_job_type(body), 1) == "failed"
    assert fake.finished[-1][2] == "timed out after 1s"


def test_a_deferred_clock_starts_at_begin_work(fake):
    def body(ctx, params):
        ctx.sleep(1.2)              # queued for a shared resource longer than the whole time limit
        ctx.begin_work()
        ctx.sleep(0.4)
        return JobOutcome("succeeded")

    assert _run_body(_job_type(body, defer_clock=True), 1) == "succeeded"


def test_a_deferred_clock_still_times_out_after_work_began(fake):
    def body(ctx, params):
        ctx.begin_work()
        ctx.sleep(5)
        return JobOutcome("succeeded")

    assert _run_body(_job_type(body, defer_clock=True), 1) == "failed"


def test_a_retry_rereads_the_job_and_stops_when_it_was_archived(fake, monkeypatch):
    fake.job = lambda n: {"id": 1, "plant": "P", "job_type": "t", "params": {}, "retry_max": 3, "timeout_s": None,
                          "archived": n >= 2, "enabled": True}
    attempts = []
    monkeypatch.setattr(runner, "RETRY_DELAY_S", 0)
    monkeypatch.setitem(runner.REGISTRY, "t", _job_type(lambda ctx, p: JobOutcome("failed")))
    monkeypatch.setattr(runner, "_execute", lambda *a: attempts.append(1) or "failed")
    runner.run_job(job_id=1, trigger="manual")
    assert len(attempts) == 1 and fake.gets == [1, 1]


def test_a_retry_runs_again_while_the_job_is_still_enabled(fake, monkeypatch):
    fake.job = {"id": 1, "plant": "P", "job_type": "t", "params": {}, "retry_max": 1, "timeout_s": None,
                "archived": False, "enabled": True}
    attempts = []
    monkeypatch.setattr(runner, "RETRY_DELAY_S", 0)
    monkeypatch.setitem(runner.REGISTRY, "t", _job_type(lambda ctx, p: JobOutcome("failed")))
    monkeypatch.setattr(runner, "_execute", lambda *a: attempts.append(1) or "failed")
    runner.run_job(job_id=1, trigger="manual")
    assert len(attempts) == 2


def test_a_fire_for_a_removed_plant_leaves_a_skipped_run_and_disables_the_job(fake, monkeypatch):
    fake.plant_ok = False
    monkeypatch.setattr(runner, "run_job", lambda **kw: pytest.fail("must not run"))
    assert runner.fire_schedule(11) is None
    assert fake.inserted[0]["status"] == "skipped" and "no longer exists" in fake.inserted[0]["error"]
    assert fake.patched == [(1, {"enabled": False}, "schedule")]


class _BrokenScheduler:
    def get_jobs(self):
        raise RuntimeError("boom")

    def add_listener(self, *a, **k):
        raise RuntimeError("no listener")

    def add_job(self, *a, **k):
        raise RuntimeError("no job")


def test_install_never_raises_into_brain(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(scheduler.data, "boot_sweep", boom)
    monkeypatch.setattr(scheduler.data, "list_active_schedules", boom)
    scheduler.install(_BrokenScheduler())          # must return, not raise


def test_scheduled_fires_use_their_own_bounded_pool():
    assert scheduler._FIRE_POOL._max_workers == scheduler.FIRE_WORKERS
    import asyncio
    seen = {}
    orig = runner.fire_schedule

    def probe(sid):
        import threading
        seen["thread"] = threading.current_thread().name
        return None

    runner.fire_schedule = probe
    try:
        asyncio.run(scheduler._fire(1))
    finally:
        runner.fire_schedule = orig
    assert seen["thread"].startswith("job-fire")
    assert time.monotonic() > 0
