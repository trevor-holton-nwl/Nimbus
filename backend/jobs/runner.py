"""Run lifecycle: one function executes a job (blocking; callers use a thread or the threadpool).

scheduled -> running -> succeeded | warning | failed | cancelled, plus skipped (overlap, misfire).
Overlap is a skip recorded as a run, via a per-job-type SESSION advisory lock held on a pooled connection for the
whole run. The body runs in an inner thread so a hard timeout can be enforced (cooperatively: the context's cancel
event is set, the body is expected to stop; a body that ignores it is abandoned and the run is marked failed).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from pydantic import ValidationError

import db
from backend.admin_ops.logbuffer import _log_event
from backend.jobs import data
from backend.jobs.context import JobCancelled, JobContext
from backend.jobs.registry import REGISTRY, JobOutcome
import backend.jobs.types  # noqa: F401 - registers the job types

log = logging.getLogger("nimbus.jobs")

MAX_CONCURRENCY = 2                  # plants run on staggered local times; the API keeps CPU
RETRY_DELAY_S = 30                   # fixed retry policy (backoff is deferred)
CANCEL_POLL_S = 2.0
KILL_GRACE_S = 10.0                  # after the cancel event, how long a body gets to stop before it is abandoned

_SEM = threading.BoundedSemaphore(MAX_CONCURRENCY)
_RUNNING: dict[int, JobContext] = {}
_RUNNING_LOCK = threading.Lock()


def _mirror(level: str, msg: str, run_id: int, plant: str) -> None:
    _log_event("warn" if level == "warn" else "error", "jobs", msg, run_id=run_id, plant=plant)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------------------------------------ entry points
def start_manual_run(job: dict, actor: str | None) -> int:
    """Insert a `scheduled` manual run and execute it on a background thread. Returns the run id."""
    run_id = data.insert_run(job_id=job["id"], schedule_id=None, plant=job["plant"], job_type=job["job_type"],
                             status="scheduled", trigger="manual", scheduled_for=_now(), triggered_by=actor)
    threading.Thread(target=run_job, kwargs={"job_id": job["id"], "trigger": "manual", "run_id": run_id,
                                             "triggered_by": actor, "skip_if_running": True},
                     name=f"job-run-{run_id}", daemon=True).start()
    return run_id


def fire_schedule(schedule_id: int) -> int | None:
    """APScheduler fired schedule `schedule_id`. Blocking."""
    sched = data.get_schedule(schedule_id)
    if sched is None or sched["retired"] or sched["paused"]:
        return None
    job = data.get_job(sched["job_id"])
    if job is None or job["archived"] or not job["enabled"]:
        return None
    if sched["kind"] == "once":
        data.retire_schedule(schedule_id)          # spent once it starts; never re-armed
    return run_job(job_id=job["id"], trigger="schedule", schedule_id=schedule_id, scheduled_for=_now(),
                   triggered_by="schedule", skip_if_running=sched["skip_if_running"])


def record_skipped(schedule_id: int, scheduled_for: datetime | None, reason: str) -> int | None:
    """A fire that never ran (APScheduler misfire past its grace time) still leaves a visible `skipped` run."""
    try:
        sched = data.get_schedule(schedule_id)
        job = data.get_job(sched["job_id"]) if sched else None
        if sched is None or job is None:
            return None
        if sched["kind"] == "once":
            data.retire_schedule(schedule_id)
        return data.insert_run(job_id=job["id"], schedule_id=schedule_id, plant=job["plant"],
                               job_type=job["job_type"], status="skipped", trigger="schedule",
                               scheduled_for=scheduled_for, triggered_by="schedule", error=reason)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not record skipped run for schedule %s: %s", schedule_id, exc)
        return None


def cancel_run(run_id: int) -> dict | None:
    """Flag the run and wake its body. Returns the fresh run row (None if unknown)."""
    row = data.mark_cancel_requested(run_id)
    with _RUNNING_LOCK:
        ctx = _RUNNING.get(run_id)
    if ctx is not None:
        ctx.cancel_event.set()
    return row


def cancel_all() -> None:
    with _RUNNING_LOCK:
        for ctx in _RUNNING.values():
            ctx.cancel_event.set()


# ------------------------------------------------------------------------------------------------------ core
def run_job(*, job_id: int, trigger: str, schedule_id: int | None = None, scheduled_for: datetime | None = None,
            triggered_by: str | None = None, run_id: int | None = None, skip_if_running: bool = True) -> int | None:
    """Execute one job (plus fixed-policy retries). Returns the id of the last run row. Never raises."""
    try:
        job = data.get_job(job_id)
        if job is None:
            return None
        jt = REGISTRY.get(job["job_type"])
        err = None
        params = None
        if jt is None:
            err = f"unknown job type {job['job_type']!r}"
        else:
            try:
                params = jt.params_model.model_validate(job["params"] or {})
            except ValidationError as e:
                err = f"invalid job parameters: {e.errors(include_url=False)[:3]}"
        attempt = 1
        while True:
            if run_id is None:
                run_id = data.insert_run(job_id=job_id, schedule_id=schedule_id, plant=job["plant"],
                                         job_type=job["job_type"], status="scheduled", trigger=trigger,
                                         attempt=attempt, scheduled_for=scheduled_for, triggered_by=triggered_by)
            if err:
                data.finish_run(run_id, "failed", None, err, False)
                return run_id
            status = _execute(run_id, job, jt, params, skip_if_running)
            if status != "failed" or attempt > int(job["retry_max"] or 0):
                return run_id
            time.sleep(RETRY_DELAY_S)
            attempt += 1
            trigger, run_id = "retry", None
    except Exception as exc:  # noqa: BLE001 - nothing may escape a worker thread
        log.exception("job %s crashed outside the run body", job_id)
        _log_event("error", "jobs", "job runner crashed", exc=exc, job_id=job_id)
        if run_id is not None:
            try:
                data.finish_run(run_id, "failed", None, f"runner error: {exc}", False)
            except Exception:  # noqa: BLE001
                pass
        return run_id


def _execute(run_id: int, job: dict, jt, params, skip_if_running: bool) -> str:
    """Run one attempt on an existing run row; returns its final status."""
    timeout = int(job["timeout_s"] or jt.timeout_for(params))
    lock_key = jt.lock_name(job["plant"], params)
    _SEM.acquire()
    try:
        with db._pool.connection() as conn:
            got = data.try_session_lock(conn, lock_key)
            try:
                if not got and skip_if_running:
                    data.finish_run(run_id, "skipped", None, "previous run still running", False)
                    return "skipped"
                if not got:                                   # queue behind the running one, within the timeout
                    t_end = time.monotonic() + timeout
                    while not got and time.monotonic() < t_end:
                        time.sleep(2.0)
                        got = data.try_session_lock(conn, lock_key)
                    if not got:
                        data.finish_run(run_id, "skipped", None, "previous run still running", False)
                        return "skipped"
                run = data.get_run(run_id)
                if run and run["cancel_requested"]:
                    data.finish_run(run_id, "cancelled", None, "cancelled before start", False)
                    return "cancelled"
                return _run_body(run_id, job, jt, params, timeout)
            finally:
                if got:
                    data.release_session_lock(conn, lock_key)
    finally:
        _SEM.release()


def _run_body(run_id: int, job: dict, jt, params, timeout: int) -> str:
    def sink(rows):
        try:
            data.write_log_rows(run_id, rows)
        except Exception as exc:  # noqa: BLE001 - losing log lines must not fail the run
            log.warning("job_run_log write failed for run %s: %s", run_id, exc)

    ctx = JobContext(run_id=run_id, plant=job["plant"], job_id=job["id"], sink=sink, mirror=_mirror)
    with _RUNNING_LOCK:
        _RUNNING[run_id] = ctx
    data.mark_running(run_id)
    holder: dict = {}

    def target():
        try:
            holder["outcome"] = jt.run(ctx, params)
        except JobCancelled as e:
            holder["cancelled"] = str(e)
        except BaseException as e:  # noqa: BLE001
            holder["error"] = f"{type(e).__name__}: {e}"
            ctx.log("error", f"run failed: {holder['error']}")

    th = threading.Thread(target=target, name=f"job-body-{run_id}", daemon=True)
    th.start()
    deadline = time.monotonic() + timeout
    next_poll = time.monotonic() + CANCEL_POLL_S
    try:
        while th.is_alive():
            th.join(0.25)
            now = time.monotonic()
            if th.is_alive() and now >= deadline and not ctx.cancelled:
                ctx.timed_out = True
                ctx.cancel_event.set()
                ctx.log("error", f"run exceeded its {timeout}s time limit; cancelling")
                th.join(KILL_GRACE_S)
                break
            if th.is_alive() and now >= next_poll:
                next_poll = now + CANCEL_POLL_S
                row = data.get_run(run_id)
                if row and row["cancel_requested"]:
                    ctx.cancel_event.set()
        status, summary, error = _resolve(holder, ctx, th, timeout)
        ctx.log("info" if status in ("succeeded", "cancelled") else "warn", f"run finished: {status}"
                + (f" ({error})" if error else ""))
        ctx.flush()
        data.finish_run(run_id, status, summary, error, ctx.truncated)
        return status
    finally:
        with _RUNNING_LOCK:
            _RUNNING.pop(run_id, None)


def _resolve(holder: dict, ctx: JobContext, th: threading.Thread, timeout: int) -> tuple[str, dict | None, str | None]:
    if ctx.timed_out:
        return "failed", None, f"timed out after {timeout}s"
    if th.is_alive():                                           # abandoned body (cancel ignored)
        return "failed", None, "run did not stop after cancel"
    if "cancelled" in holder:
        return "cancelled", None, None
    if "error" in holder:
        return "failed", None, holder["error"]
    out: JobOutcome = holder.get("outcome") or JobOutcome("succeeded")
    if ctx.cancelled and out.status != "failed":
        return "cancelled", out.summary or None, None
    status = out.status if out.status in ("succeeded", "warning", "failed") else "succeeded"
    return status, out.summary or None, out.error
