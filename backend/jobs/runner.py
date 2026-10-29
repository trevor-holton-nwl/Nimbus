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
from backend.jobs import data, targets
from backend.jobs.context import JobCancelled, JobContext, cap_text
from backend.jobs.registry import REGISTRY, JobOutcome
import backend.jobs.types  # noqa: F401 - registers the job types

log = logging.getLogger("nimbus.jobs")

MAX_CONCURRENCY = 2                  # plants run on staggered local times; the API keeps CPU
RETRY_DELAY_S = 30                   # fixed retry policy (backoff is deferred)
CANCEL_POLL_S = 2.0
ERROR_KINDS = ("config", "system", "transient")
KILL_GRACE_S = 10.0                 # after the cancel event, how long a body gets to stop before it is abandoned

_SEM = threading.BoundedSemaphore(MAX_CONCURRENCY)
_RUNNING: dict[int, JobContext] = {}
_RUNNING_LOCK = threading.Lock()


def _mirror(level: str, msg: str, run_id: int, plant: str) -> None:
    _log_event("warn" if level == "warn" else "error", "jobs", msg, run_id=run_id, plant=plant)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------------------------------------ entry points
class NoTargetPlants(ValueError):
    """The job's targets expand to no plant at all (every plant removed or excluded)."""


def _expand(job: dict) -> dict:
    return targets.expand_targets(job, _now(), plants=data.load_plant_rows())


def start_manual_run(job: dict, actor: str | None, trigger: str = "manual") -> int | None:
    """Insert a `scheduled` manual run and execute it on a background thread. Returns the run id, or None when the
    job already has a scheduled|running run (checked and inserted atomically). A job with target rows fans out into a
    batch instead (`trigger` 'manual' or 'restart'); the id returned is its first child run, whose `batch_id` names
    the batch. Raises NoTargetPlants when the targets expand to nothing."""
    if job.get("targets"):
        return _start_manual_batch(job, actor, trigger)
    run_id = data.insert_manual_run_if_idle(job=job, triggered_by=actor, scheduled_for=_now())
    if run_id is None:
        return None
    threading.Thread(target=run_job, kwargs={"job_id": job["id"], "trigger": "manual", "run_id": run_id,
                                             "triggered_by": actor, "skip_if_running": True},
                     name=f"job-run-{run_id}", daemon=True).start()
    return run_id


def _start_manual_batch(job: dict, actor: str | None, trigger: str) -> int | None:
    exp = _expand(job)
    if not exp["plants"]:
        raise NoTargetPlants("the job's targets expand to no plants")
    when = _now()
    batch_id = data.batch_idle_check_and_insert(job=job, trigger=trigger, triggered_by=actor, scheduled_for=when)
    if batch_id is None:
        return None
    children = prepare_batch(job, exp, batch_id=batch_id, trigger=trigger, schedule_id=None, scheduled_for=when,
                             triggered_by=actor)
    threading.Thread(target=execute_batch, kwargs={"job": job, "batch_id": batch_id, "children": children,
                                                   "trigger": trigger, "schedule_id": None, "scheduled_for": when,
                                                   "triggered_by": actor, "skip_if_running": True},
                     name=f"job-batch-{batch_id}", daemon=True).start()
    return children[0]["run_id"]


# ------------------------------------------------------------------------------------------------------ fan-out
def _apply_target(job: dict, plant: str | None, override: dict | None) -> dict:
    """The job as ONE plant's child sees it: that plant, and the job params with the plant's override deep-merged."""
    if plant is None:
        return job
    return {**job, "plant": plant, "params": targets.deep_merge(job["params"] or {}, override)}


def prepare_batch(job: dict, expansion: dict, *, batch_id: int, trigger: str, schedule_id: int | None,
                  scheduled_for: datetime | None, triggered_by: str | None) -> list[dict]:
    """Insert one child run per expanded plant under the batch BEFORE any of them starts, so the batch shows its full
    size at once. A skipped plant (no timezone, removed) becomes a `skipped` run (`error_kind` config); a child whose
    merged params fail the type's model becomes a `failed` run (config) without touching its siblings. Returns
    `[{plant, run_id, override, state}]` in expansion order; only `state == 'pending'` children will run."""
    child_trigger = "schedule" if trigger == "schedule" else "manual"
    base = dict(job_id=job["id"], schedule_id=schedule_id, job_type=job["job_type"], trigger=child_trigger,
                scheduled_for=scheduled_for, triggered_by=triggered_by, batch_id=batch_id)
    out = []
    for e in expansion["plants"]:
        plant, override = e["plant"], e.get("params_override") or {}
        if e.get("skip"):
            rid = data.insert_run(plant=plant, status="skipped", error=e["skip"],
                                  summary={"error_kind": "config", "failed_step": "targets"}, **base)
            out.append({"plant": plant, "run_id": rid, "override": override, "state": "skipped"})
            continue
        _jt, _params, err = _prepare(_apply_target(job, plant, override))
        if err:
            rid = data.insert_run(plant=plant, status="failed", error=err,
                                  summary={"error_kind": "config", "failed_step": "validate"}, **base)
            _log_failure_line(rid, err, "validate")
            out.append({"plant": plant, "run_id": rid, "override": override, "state": "failed"})
            continue
        rid = data.insert_run(plant=plant, status="scheduled", **base)
        out.append({"plant": plant, "run_id": rid, "override": override, "state": "pending"})
    return out


def execute_batch(*, job: dict, batch_id: int, children: list[dict], trigger: str, schedule_id: int | None,
                  scheduled_for: datetime | None, triggered_by: str | None, skip_if_running: bool,
                  run_child=None, sleep=time.sleep) -> None:
    """Run the pending children honouring the job's `fan_out`: `stagger_s` between child STARTS, `max_parallel` live
    children at once (on top of the global MAX_CONCURRENCY semaphore), `fail_fast` stops launching after a failure
    (the rest are recorded `skipped`). Blocks until every child is terminal, then rolls the batch up. Never raises.
    `run_child` and `sleep` are injectable for tests."""
    run_child = run_child or run_job
    child_trigger = "schedule" if trigger == "schedule" else "manual"
    fan = job.get("fan_out") or {}
    stagger = max(0, int(fan.get("stagger_s") or 0))
    max_parallel = int(fan["max_parallel"]) if fan.get("max_parallel") else None
    fail_fast = bool(fan.get("fail_fast"))
    stop = threading.Event()
    if fail_fast and any(c["state"] == "failed" for c in children):
        stop.set()
    slots = threading.BoundedSemaphore(max_parallel) if max_parallel else None
    threads: list[threading.Thread] = []

    def work(c: dict) -> None:
        try:
            rid = run_child(job_id=job["id"], trigger=child_trigger, schedule_id=schedule_id,
                            scheduled_for=scheduled_for, triggered_by=triggered_by, run_id=c["run_id"],
                            skip_if_running=skip_if_running, plant=c["plant"], override=c["override"],
                            batch_id=batch_id)
            row = data.get_run(rid) if rid else None
            if row is None or row["status"] == "failed":
                stop.set()
        except Exception as exc:  # noqa: BLE001 - one child must not take the batch down
            log.exception("batch %s child %s crashed", batch_id, c["plant"])
            stop.set()
            try:
                data.finish_run(c["run_id"], "failed", {"error_kind": "system"}, f"runner error: {exc}", False)
            except Exception:  # noqa: BLE001
                pass
        finally:
            if slots:
                slots.release()

    def skip_rest(c: dict) -> None:
        data.finish_run(c["run_id"], "skipped", {"error_kind": "config", "failed_step": "fail_fast"},
                        "stopped: an earlier plant failed", False)

    try:
        pending = [c for c in children if c["state"] == "pending"]
        launched = 0
        for c in pending:
            if fail_fast and stop.is_set():
                skip_rest(c)
                continue
            if launched and stagger:
                sleep(stagger)
            if slots:
                slots.acquire()
            if fail_fast and stop.is_set():
                if slots:
                    slots.release()
                skip_rest(c)
                continue
            th = threading.Thread(target=work, args=(c,), name=f"job-batch-{batch_id}-{c['plant']}", daemon=True)
            th.start()
            threads.append(th)
            launched += 1
        for th in threads:
            th.join()
    except Exception as exc:  # noqa: BLE001
        log.exception("batch %s dispatcher crashed", batch_id)
        _log_event("error", "jobs", "job batch dispatcher crashed", exc=exc, batch_id=batch_id)
    try:
        data.finish_batch(batch_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not finish batch %s: %s", batch_id, exc)


def _fan_out(job: dict, expansion: dict, *, trigger: str, schedule_id: int | None, triggered_by: str | None,
             skip_if_running: bool) -> int:
    """Batch + children + dispatch, blocking (the scheduled path runs on a fire-pool thread). Returns the batch id."""
    when = _now()
    batch_id = data.insert_batch(job_id=job["id"], schedule_id=schedule_id, scheduled_for=when, trigger=trigger,
                                 triggered_by=triggered_by)
    children = prepare_batch(job, expansion, batch_id=batch_id, trigger=trigger, schedule_id=schedule_id,
                             scheduled_for=when, triggered_by=triggered_by)
    execute_batch(job=job, batch_id=batch_id, children=children, trigger=trigger, schedule_id=schedule_id,
                  scheduled_for=when, triggered_by=triggered_by, skip_if_running=skip_if_running)
    return batch_id


def _retire_once_if_spent(sched: dict, job: dict, plant: str | None) -> None:
    """A `once` schedule is spent when it starts. Armed per plant (each plant's local time), it is spent only when
    every armable plant has fired, so the later plants' fires are not removed by the first one."""
    if sched["kind"] != "once":
        return
    if plant is None or not job.get("targets"):
        data.retire_schedule(sched["id"])
        return
    armable = {e["plant"] for e in targets.runnable(_expand(job))}
    if armable <= data.schedule_fired_plants(sched["id"]) | {plant}:
        data.retire_schedule(sched["id"])


def fire_schedule(schedule_id: int, plant: str | None = None) -> int | None:
    """APScheduler fired schedule `schedule_id`. Blocking. `plant` is set for a per-plant (`plant` time zone mode)
    arm of a multi-plant job: only that plant runs, as its own batch of one. Returns the run id (single plant) or the
    batch id (a fan-out)."""
    sched = data.get_schedule(schedule_id)
    if sched is None or sched["retired"] or sched["paused"]:
        return None
    job = data.get_job(sched["job_id"])
    if job is None or job["archived"] or not job["enabled"]:
        return None
    if job.get("targets"):
        exp = _expand(job)
        if plant is not None:
            exp = {**exp, "plants": [e for e in exp["plants"] if e["plant"] == plant and not e["skip"]]}
            if not exp["plants"]:
                return None                      # the plant left the target set (or lost its timezone) since arming
        _retire_once_if_spent(sched, job, plant)
        return _fan_out(job, exp, trigger="schedule", schedule_id=schedule_id, triggered_by="schedule",
                        skip_if_running=sched["skip_if_running"])
    if not data.plant_exists(job["plant"]):
        # The plant was removed from master data: leave a visible skipped run and stop firing this job.
        data.insert_run(job_id=job["id"], schedule_id=schedule_id, plant=job["plant"], job_type=job["job_type"],
                        status="skipped", trigger="schedule", scheduled_for=_now(), triggered_by="schedule",
                        error=f"plant {job['plant']} no longer exists; job disabled")
        data.patch_job(job["id"], {"enabled": False}, "schedule")
        _log_event("warn", "jobs", "job disabled: its plant no longer exists", job_id=job["id"], plant=job["plant"])
        return None
    _retire_once_if_spent(sched, job, None)        # spent once it starts; never re-armed
    return run_job(job_id=job["id"], trigger="schedule", schedule_id=schedule_id, scheduled_for=_now(),
                   triggered_by="schedule", skip_if_running=sched["skip_if_running"])


def record_skipped(schedule_id: int, scheduled_for: datetime | None, reason: str, plant: str | None = None) -> int | None:
    """A fire that never ran (APScheduler misfire past its grace time) still leaves a visible `skipped` run (for the
    per-plant arm's `plant` when there is one, else the job's home plant)."""
    try:
        sched = data.get_schedule(schedule_id)
        job = data.get_job(sched["job_id"]) if sched else None
        if sched is None or job is None:
            return None
        _retire_once_if_spent(sched, job, plant)
        return data.insert_run(job_id=job["id"], schedule_id=schedule_id, plant=plant or job["plant"],
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
    """Shutdown: wake every body and kill any live child process (it would otherwise outlive this process)."""
    with _RUNNING_LOCK:
        for ctx in _RUNNING.values():
            ctx.cancel_event.set()
    try:
        from backend.jobs.types import optimizer_runner
        optimizer_runner.kill_children()
    except Exception as exc:  # noqa: BLE001 - shutdown must finish
        log.warning("could not kill optimizer children on shutdown: %s", exc)


# ------------------------------------------------------------------------------------------------------ core
def _prepare(job: dict):
    """(job type, validated params, error) for one attempt."""
    jt = REGISTRY.get(job["job_type"])
    if jt is None:
        return None, None, f"unknown job type {job['job_type']!r}"
    try:
        return jt, jt.params_model.model_validate(job["params"] or {}), None
    except ValidationError as e:
        return jt, None, f"invalid job parameters: {e.errors(include_url=False)[:3]}"


def _log_failure_line(run_id: int, msg: str, step: str) -> None:
    """A failure that happens before a JobContext exists still gets an error line, so the Errors view has it."""
    try:
        data.write_log_rows(run_id, [{"seq": 1, "at": _now(), "level": "error", "step": step, "msg": cap_text(msg),
                                      "duration_ms": None, "data": None}])
    except Exception as exc:  # noqa: BLE001
        log.warning("could not log failure line for run %s: %s", run_id, exc)


def run_job(*, job_id: int, trigger: str, schedule_id: int | None = None, scheduled_for: datetime | None = None,
            triggered_by: str | None = None, run_id: int | None = None, skip_if_running: bool = True,
            plant: str | None = None, override: dict | None = None, batch_id: int | None = None) -> int | None:
    """Execute one job (plus fixed-policy retries). Returns the id of the last run row. Never raises. A fan-out child
    passes its `plant` and per-plant `override` (re-applied to the freshly read job on every retry) and `batch_id`."""
    try:
        job = data.get_job(job_id)
        if job is None:
            return None
        job = _apply_target(job, plant, override)
        jt, params, err = _prepare(job)
        attempt = 1
        while True:
            if run_id is None:
                run_id = data.insert_run(job_id=job_id, schedule_id=schedule_id, plant=job["plant"],
                                         job_type=job["job_type"], status="scheduled", trigger=trigger,
                                         attempt=attempt, scheduled_for=scheduled_for, triggered_by=triggered_by,
                                         batch_id=batch_id)
            if err:                                       # an unknown type or bad params: the job needs fixing
                _log_failure_line(run_id, err, "validate")
                data.finish_run(run_id, "failed", {"error_kind": "config", "failed_step": "validate"}, err, False)
                return run_id
            status = _execute(run_id, job, jt, params, skip_if_running)
            if status != "failed" or attempt > int(job["retry_max"] or 0):
                return run_id
            time.sleep(RETRY_DELAY_S)
            # The job may have been edited, disabled or archived while we waited: every attempt reads it afresh.
            job = data.get_job(job_id)
            if job is None or job["archived"] or not job["enabled"]:
                log.info("job %s retry cancelled: it was archived, disabled or removed", job_id)
                return run_id
            job = _apply_target(job, plant, override)
            jt, params, err = _prepare(job)
            attempt += 1
            trigger, run_id = "retry", None
    except Exception as exc:  # noqa: BLE001 - nothing may escape a worker thread
        log.exception("job %s crashed outside the run body", job_id)
        _log_event("error", "jobs", "job runner crashed", exc=exc, job_id=job_id)
        if run_id is not None:
            try:
                data.finish_run(run_id, "failed", {"error_kind": "system"}, f"runner error: {exc}", False)
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
    ctx.defer_clock = bool(getattr(jt, "defer_clock", False))
    with _RUNNING_LOCK:
        _RUNNING[run_id] = ctx
    # A deferred-clock body (the optimizer) may block on a shared slot: until begin_work() the run counts as Queued
    # and its elapsed time / duration start from begin_work(), not from here.
    data.mark_running(run_id, waiting_for="slot" if ctx.defer_clock else None)
    if ctx.defer_clock:
        ctx.on_work_start = lambda: data.mark_work_started(run_id)
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
    # A deferred clock stays off while the body waits for its resource (cancel still works); it starts at begin_work().
    deadline = None if ctx.defer_clock else time.monotonic() + timeout
    next_poll = time.monotonic() + CANCEL_POLL_S
    try:
        while th.is_alive():
            th.join(0.25)
            now = time.monotonic()
            if deadline is None and ctx.work_started.is_set():
                deadline = now + timeout
            if th.is_alive() and deadline is not None and now >= deadline and not ctx.cancelled:
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
        summary = _describe_failure(status, summary, ctx)
        summary = _store_artifact(run_id, ctx, holder, status, summary)
        if status == "failed" and error and not ctx.error_lines:
            ctx.log("error", error, step=(summary or {}).get("failed_step"))     # every failure leaves an error line
        ctx.log("info" if status in ("succeeded", "cancelled") else "warn", f"run finished: {status}"
                + (f" ({error})" if error else ""))
        ctx.flush()
        data.finish_run(run_id, status, summary, error, ctx.truncated)
        return status
    finally:
        with _RUNNING_LOCK:
            _RUNNING.pop(run_id, None)


def _store_artifact(run_id: int, ctx: JobContext, holder: dict, status: str, summary: dict | None) -> dict | None:
    """A report body's artifact is stored BEFORE the run is finished (so a viewer that sees the run done always finds
    it). A save failure never fails the run: the summary says so (`artifact_error`) and an error line is logged."""
    art = getattr(holder.get("outcome"), "artifact", None)
    if not art or status not in ("succeeded", "warning"):
        return summary
    out = dict(summary or {})
    try:
        info = data.save_artifact(run_id, art, filename=f"report-{ctx.plant}-run{run_id}.json")
        out["artifact"] = info
        out["row_counts"] = info["row_counts"]                 # counts BEFORE the size cap (what the report found)
        if info.get("error"):
            out["artifact_error"] = info["error"]
        if info["truncated"]:
            ctx.log("warn", f"report artifact exceeded the size cap and was truncated ({info['size_bytes']} bytes kept)")
    except Exception as exc:  # noqa: BLE001
        log.warning("could not store the artifact for run %s: %s", run_id, exc)
        ctx.log("error", f"could not store the report artifact: {exc}")
        out["artifact_error"] = str(exc)[:200]
    return out


def _describe_failure(status: str, summary: dict | None, ctx: JobContext) -> dict | None:
    """A failed run always carries `error_kind` (config = fix the job or its inputs, system = fix the platform:
    timeout, crash, interrupted; transient = the board changed under the run, run again), `failed_step` (the step an exception escaped from, else the last step that logged
    an error) and `steps` (the timings the body reported, else those `ctx.step` recorded)."""
    if status != "failed":
        return summary
    out = dict(summary or {})
    if out.get("error_kind") not in ERROR_KINDS:
        out["error_kind"] = "system"
    if not out.get("failed_step"):
        step = ctx.failed_step or ctx.last_error_step
        if step:
            out["failed_step"] = step
    if not out.get("steps") and ctx.step_timings:
        out["steps"] = list(ctx.step_timings)
    return out


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
