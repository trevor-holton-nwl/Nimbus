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
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

import db
from backend.admin_ops.logbuffer import _log_event
from backend.jobs import data, targets, triggers
from backend.jobs.context import JobCancelled, JobContext, cap_text
from backend.jobs.registry import REGISTRY, JobOutcome, unavailable_message
import backend.jobs.types  # noqa: F401 - registers the job types
from backend.jobs.types import chain as chain_type

log = logging.getLogger("nimbus.jobs")

MAX_CONCURRENCY = 2                  # plants run on staggered local times; the API keeps CPU
MAX_PARALLEL_DEFAULT = MAX_CONCURRENCY * 2   # live children of one batch when fan_out.max_parallel is unset
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


class BatchPrepareError(RuntimeError):
    """Inserting the batch's child runs failed; the batch was closed `failed` and nothing ran."""


def _expand(job: dict, require_tz: bool | None = None) -> dict:
    """The job's current expansion. A plant with no timezone is skipped only when the job type cannot run without one
    (or the caller reads the schedule in each plant's zone: `require_tz=True`); `plan_arms` and the run-time expansion
    share `targets.expand_targets`, so they agree on who runs."""
    if require_tz is None:
        jt = REGISTRY.get(job["job_type"])
        require_tz = bool(jt and jt.needs_plant_timezone)
    return targets.expand_targets(job, _now(), plants=data.load_plant_rows(), require_tz=require_tz)


def start_manual_run(job: dict, actor: str | None, trigger: str = "manual",
                     only_plants: set[str] | None = None, resume: dict | None = None) -> int | None:
    """Insert a `scheduled` manual run and execute it on a background thread. Returns the run id, or None when the
    job already has a scheduled|running run (checked and inserted atomically). A job with target rows fans out into a
    batch instead (`trigger` 'manual' or 'restart'); the id returned is its first child run, whose `batch_id` names
    the batch. `only_plants` limits the fan-out to those plants (restart of one run's plant, or of a batch's failed
    plants); the busy check then covers only them. Raises NoTargetPlants when the targets expand to nothing. `resume`
    (`{from_run, from_seq}`, single-plant chain jobs) starts the chain at that step of an earlier run's snapshot."""
    if job.get("targets"):
        return _start_manual_batch(job, actor, trigger, only_plants)
    run_id = data.insert_manual_run_if_idle(job=job, triggered_by=actor, scheduled_for=_now(),
                                            summary={"resume": resume} if resume else None)
    if run_id is None:
        return None
    threading.Thread(target=run_job, kwargs={"job_id": job["id"], "trigger": "manual", "run_id": run_id,
                                             "triggered_by": actor, "skip_if_running": True},
                     name=f"job-run-{run_id}", daemon=True).start()
    return run_id


def _start_manual_batch(job: dict, actor: str | None, trigger: str, only_plants: set[str] | None = None) -> int | None:
    exp = _expand(job)
    if only_plants is not None:
        exp = {**exp, "plants": [e for e in exp["plants"] if e["plant"] in only_plants]}
    if not exp["plants"]:
        raise NoTargetPlants("the job's targets expand to no plants" if only_plants is None
                             else "none of those plants is a target of this job any more")
    when = _now()
    only_one = next(iter(only_plants)) if only_plants is not None and len(only_plants) == 1 else None
    batch_id = data.batch_idle_check_and_insert(job=job, trigger=trigger, triggered_by=actor, scheduled_for=when,
                                                plant=only_one)
    if batch_id is None:
        return None
    children = _prepare_or_fail(job, exp, batch_id=batch_id, trigger=trigger, schedule_id=None, scheduled_for=when,
                                triggered_by=actor)
    if children is None:
        raise BatchPrepareError("could not prepare the batch; see the Admin log")
    _dispatch(job, batch_id, children, trigger=trigger, schedule_id=None, scheduled_for=when, triggered_by=actor,
              skip_if_running=True)
    return children[0]["run_id"]


def _dispatch(job: dict, batch_id: int, children: list[dict], **kw) -> None:
    """Hand a prepared batch to its own dispatcher thread and return at once, so neither a request nor a fire-pool
    worker is held for the stagger or the run time."""
    threading.Thread(target=execute_batch, kwargs={"job": job, "batch_id": batch_id, "children": children, **kw},
                     name=f"job-batch-{batch_id}", daemon=True).start()


def _prepare_or_fail(job: dict, expansion: dict, *, batch_id: int, **kw) -> list[dict] | None:
    """`prepare_batch`, or None after closing the batch `failed` (and any child already inserted) when it raises."""
    try:
        return prepare_batch(job, expansion, batch_id=batch_id, **kw)
    except Exception as exc:  # noqa: BLE001
        log.exception("batch %s could not be prepared", batch_id)
        _log_event("error", "jobs", "job batch could not be prepared", exc=exc, batch_id=batch_id)
        try:
            data.fail_batch_children(batch_id, f"batch preparation failed: {exc}")
            data.finish_batch(batch_id, force_status="failed",
                              summary_extra={"error_kind": "system", "error": f"batch preparation failed: {exc}"[:300]})
        except Exception:  # noqa: BLE001
            log.exception("could not close batch %s after a preparation failure", batch_id)
        return None




def cancel_batch(batch_id: int) -> dict | None:
    """Cancel a batch: children not started become `skipped` ('batch cancelled'), running ones are cancelled (the
    dispatcher then rolls the batch up when they end; with none running it is rolled up here)."""
    for rid in data.cancel_batch_pending(batch_id):
        cancel_run(rid)
    return data.finish_batch(batch_id)


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
    child_trigger = trigger if trigger in ("schedule", "catchup") else "manual"
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
    child_trigger = trigger if trigger in ("schedule", "catchup") else "manual"
    fan = job.get("fan_out") or {}
    stagger = max(0, int(fan.get("stagger_s") or 0))
    # Unset = bounded anyway: 50 plants must not mean 50 live threads all queuing on the global semaphore.
    max_parallel = int(fan["max_parallel"]) if fan.get("max_parallel") else MAX_PARALLEL_DEFAULT
    fail_fast = bool(fan.get("fail_fast"))
    stop = threading.Event()
    if fail_fast and any(c["state"] == "failed" for c in children):
        stop.set()
    slots = threading.BoundedSemaphore(max_parallel)
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

    def not_started(c: dict) -> bool:
        """Cancelled or skipped while it waited (a batch cancel): leave the row as it was."""
        try:
            row = data.get_run(c["run_id"])
        except Exception:  # noqa: BLE001
            return False
        return bool(row and row["status"] != "scheduled")

    crashed = False
    try:
        pending = [c for c in children if c["state"] == "pending"]
        launched = 0
        for c in pending:
            if not_started(c):
                continue
            if fail_fast and stop.is_set():
                skip_rest(c)
                continue
            if launched and stagger:
                sleep(stagger)
            slots.acquire()
            if (fail_fast and stop.is_set()) or not_started(c):
                slots.release()
                if not not_started(c):
                    skip_rest(c)
                continue
            th = threading.Thread(target=work, args=(c,), name=f"job-batch-{batch_id}-{c['plant']}", daemon=True)
            th.start()
            threads.append(th)
            launched += 1
    except Exception as exc:  # noqa: BLE001
        crashed = True
        log.exception("batch %s dispatcher crashed", batch_id)
        _log_event("error", "jobs", "job batch dispatcher crashed", exc=exc, batch_id=batch_id)
    finally:
        for th in threads:                     # never roll the batch up while a started child is still running
            th.join()
    if crashed:
        try:                                   # children the crashed dispatcher never launched must not stay queued
            data.fail_batch_children(batch_id, "dispatcher crashed before this plant started")
        except Exception:  # noqa: BLE001
            log.exception("could not close the unstarted children of batch %s", batch_id)
    for attempt in (1, 2):                     # one retry: a transient DB error must not leave the batch `running`
        try:
            data.finish_batch(batch_id)
            break
        except Exception as exc:  # noqa: BLE001
            log.warning("could not finish batch %s (attempt %s): %s", batch_id, attempt, exc)
            if attempt == 1:
                sleep(1)


def _fan_out(job: dict, expansion: dict, *, trigger: str, schedule_id: int | None, triggered_by: str | None,
             skip_if_running: bool, scheduled_for: datetime | None = None) -> int:
    """Batch + every child row (status `scheduled`, so Queued shows at once, `scheduled_for` = this fire time), then
    hand dispatch to the batch's own thread. Returns the batch id immediately: a fire-pool worker is never held for a
    stagger or a run. An expansion with no plant at all closes the batch `warning` with a note (never a green empty
    batch). A catch-up passes the EXPECTED fire time as `scheduled_for`."""
    when = scheduled_for or _now()
    batch_id = data.insert_batch(job_id=job["id"], schedule_id=schedule_id, scheduled_for=when,
                                 trigger="schedule" if trigger == "catchup" else trigger,
                                 triggered_by=triggered_by)
    if not expansion["plants"]:
        data.finish_batch(batch_id, force_status="warning", summary_extra={"note": "the targets expand to no plants"})
        return batch_id
    children = _prepare_or_fail(job, expansion, batch_id=batch_id, trigger=trigger, schedule_id=schedule_id,
                                scheduled_for=when, triggered_by=triggered_by)
    if children is not None:
        _dispatch(job, batch_id, children, trigger=trigger, schedule_id=schedule_id, scheduled_for=when,
                  triggered_by=triggered_by, skip_if_running=skip_if_running)
    return batch_id


def _retire_once_if_spent(sched: dict, job: dict, plant: str | None) -> None:
    """A `once` schedule is spent when it starts. Armed per plant (each plant's local time), it is spent only when
    every armable plant has fired, so the later plants' fires are not removed by the first one."""
    if sched["kind"] != "once":
        return
    if plant is None or not job.get("targets"):
        data.retire_schedule(sched["id"])
        return
    armable = {e["plant"] for e in targets.runnable(_expand(job, require_tz=True))}   # what plan_arms armed
    if armable <= data.schedule_fired_plants(sched["id"]) | {plant}:
        data.retire_schedule(sched["id"])


ONCE_A_DAY_KINDS = ("daily", "weekdays", "weekly", "monthly")


def _is_overlap_second(sched: dict, job: dict, plant: str | None, at: datetime) -> bool:
    """True when the fire at `at` is the SECOND pass of a repeated hour (`dst_overlap` 'twice'): a deliberate second
    run on the same local date, which the once-a-day dedupe must not drop (the preview lists it as a fire)."""
    try:
        row = arm_row(sched, job, plant)
        if triggers.policy_of(row).dst_overlap != "twice":
            return False
        occ = triggers.fire_at(row, at=at, window_s=max(int(sched["misfire_grace_s"]), 120),
                               cal=calendar_for(row, plant), plant=plant or job["plant"])
        return bool(occ is not None and occ.note == "dst_overlap_second")
    except Exception:  # noqa: BLE001 - classification only; the dedupe then behaves as before
        return False


def _already_ran_today(sched: dict, job: dict, plant: str | None, when: datetime | None = None) -> bool:
    """A timezone edit re-arms a schedule, and the new zone's clock can reach the fire time a second time on the same
    local date. For the once-a-day presets, a fire is dropped when this plant already has a (non-skipped) scheduled run
    from this schedule on today's local date. The edge, accepted: moving the time of day LATER after today's fire has
    run skips today's new fire (tomorrow is unaffected). `hourly` / `cron` fire several times a day and are not
    deduplicated; fixed / UTC fan-outs have no single plant and are not either."""
    if sched["kind"] not in ONCE_A_DAY_KINDS or (job.get("targets") and plant is None):
        return False
    who = plant or job["plant"]
    try:
        if when is not None and _is_overlap_second(sched, job, plant, when):
            return False
        tz = (next((p["timezone"] for p in data.load_plant_rows() if p["plant"] == who), None)
              or sched["timezone"])
        today = (when or _now()).astimezone(triggers.get_zone(tz)).date()   # the FIRE's local date
        if data.schedule_ran_on(sched["id"], who, tz, today):
            _log_event("info", "jobs", "fire skipped: this plant already ran this schedule today (re-armed)",
                       schedule_id=sched["id"], plant=who)
            return True
    except Exception as exc:  # noqa: BLE001 - the dedupe is a guard, never a reason to miss a run
        log.warning("daily dedupe check failed for schedule %s: %s", sched["id"], exc)
    return False


def _maintenance_on() -> bool:
    try:
        return bool(data.maintenance_state()["enabled"])
    except Exception:  # noqa: BLE001 - a settings glitch must not stop or fake a pause
        return False


def _touch(schedule_id: int, plant: str | None = None) -> None:
    """Stamp the catch-up watermark of this schedule's ARM (`plant` = the arm's plant, None = the plant-less arm)."""
    try:
        data.touch_last_fire(schedule_id, plant)
    except Exception as exc:  # noqa: BLE001 - bookkeeping only
        log.warning("could not stamp last_fire_at for schedule %s: %s", schedule_id, exc)


def arm_row(sched: dict, job: dict, plant: str | None) -> dict:
    """The schedule row as ONE arm reads it: `timezone` is the effective zone (the plant's CURRENT one in `plant` mode,
    else the fixed zone / UTC) and `arm_plant` names the arm's plant. Same resolution `scheduler.plan_arms` uses."""
    mode = sched.get("tz_mode") or "plant"
    if mode == "fixed":
        tz = sched.get("fixed_timezone") or sched["timezone"]
    elif mode == "utc":
        tz = "UTC"
    else:
        who = plant or job["plant"]
        tz = next((p["timezone"] for p in data.load_plant_rows() if p["plant"] == who and p["timezone"]), None) or sched["timezone"]
    return {**sched, "timezone": tz, "plant": job["plant"], "arm_plant": plant}


def calendar_for(row: dict, plant: str | None):
    """The injected calendar view for a row's policy (None when the policy does not read the calendar)."""
    pol = triggers.policy_of(row)
    if not pol.needs_calendar():
        return None
    who = plant or row.get("arm_plant") or row["plant"]
    return data.load_calendar_view([who], {who: row["timezone"]})


def _recheck(sched: dict, job: dict, plant: str | None, now: datetime) -> str | None:
    """Fire-time re-evaluation of the policy against CURRENT calendar data (the calendar may have changed since the arm
    was built). Returns the rejection reason, or None. Fail open: an error here never silences a schedule."""
    try:
        row = arm_row(sched, job, plant)
        if not triggers.policy_of(row).needs_recheck() or sched["kind"] == "once":
            return None
        return triggers.recheck(row, at=now, window_s=max(int(sched["misfire_grace_s"]), 120),
                                cal=calendar_for(row, plant), plant=plant or job["plant"])
    except Exception as exc:  # noqa: BLE001
        log.warning("policy re-check failed for schedule %s: %s", sched["id"], exc)
        return None


def _blocked_now(sched: dict, job: dict, plant: str | None) -> str | None:
    """Catch-up only: the reason the CURRENT time is outside the run window / on a closed day, else None. Fail open."""
    try:
        row = arm_row(sched, job, plant)
        if not triggers.policy_of(row).needs_recheck():
            return None
        return triggers.blocked_now(row, now=_now(), cal=calendar_for(row, plant), plant=plant or job["plant"])
    except Exception as exc:  # noqa: BLE001
        log.warning("catch-up window check failed for schedule %s: %s", sched["id"], exc)
        return None


def _record_policy_skip(sched: dict, job: dict, plant: str | None, when: datetime, reason: str, step: str) -> None:
    """One visible skipped run per plant this fire would have run (a fixed / UTC fan-out names every runnable plant)."""
    arm = plant
    plants = [plant] if plant else None
    if plants is None and job.get("targets"):
        plants = [e["plant"] for e in targets.runnable(_expand(job))] or None
    for p in plants or [job["plant"]]:
        record_skipped(sched["id"], when, reason, p, summary={"skipped_reason": step}, touch=False)
    _touch(sched["id"], arm)


def fire_schedule(schedule_id: int, plant: str | None = None, catchup_for: datetime | None = None,
                  fired_at: datetime | None = None) -> int | None:
    """APScheduler fired schedule `schedule_id`. Blocking. `plant` is set for a per-plant (`plant` time zone mode)
    arm of a multi-plant job: only that plant runs, as its own batch of one. Returns the run id (single plant) or the
    batch id (a fan-out). `catchup_for` is the EXPECTED fire time of a catch-up (trigger 'catchup', scheduled_for = it).
    `fired_at` is when the scheduler fired it (the fire pool may start it much later, so the policy re-check and
    `scheduled_for` use this, not the dequeue time).

    Order: retired / paused / archived / disabled -> nothing; maintenance mode -> a skipped run 'maintenance mode';
    the policy re-checked against current calendar data -> a skipped run with the reason ('closed day', 'outside run
    window') when it now rejects this fire; else the run."""
    sched = data.get_schedule(schedule_id)
    if sched is None or sched["retired"] or sched["paused"]:
        return None
    job = data.get_job(sched["job_id"])
    if job is None or job["archived"] or not job["enabled"]:
        return None
    trigger = "catchup" if catchup_for else "schedule"
    when = catchup_for or fired_at or _now()
    if not catchup_for and _already_ran_today(sched, job, plant, when):
        return None
    if _maintenance_on():
        _record_policy_skip(sched, job, plant, when, "maintenance mode", "maintenance")
        return None
    if not catchup_for:
        reason = _recheck(sched, job, plant, when)
    else:                                  # a catch-up runs NOW: the run window and closed-day rule apply to this instant
        reason = _blocked_now(sched, job, plant)
    if reason:
        _record_policy_skip(sched, job, plant, when, reason, "policy")
        return None
    if not catchup_for:                    # a catch-up is recorded by its own run row (scheduled_for = the expected fire)
        _touch(schedule_id, plant)
    if job.get("targets"):
        # An arm for one plant reads the schedule in that plant's own zone, so that plant needs one; a fixed / UTC fan-out
        # needs a zone only when the job type does (the same rule `plan_arms` used to arm it).
        exp = _expand(job, require_tz=True if plant is not None else None)
        if plant is not None:
            exp = {**exp, "plants": [e for e in exp["plants"] if e["plant"] == plant and not e["skip"]]}
            if not exp["plants"]:
                return None                      # the plant left the target set (or lost its timezone) since arming
        _retire_once_if_spent(sched, job, plant)
        return _fan_out(job, exp, trigger=trigger, schedule_id=schedule_id, triggered_by="schedule",
                        skip_if_running=sched["skip_if_running"], scheduled_for=catchup_for)
    if not data.plant_exists(job["plant"]):
        # The plant was removed from master data: leave a visible skipped run and stop firing this job.
        data.insert_run(job_id=job["id"], schedule_id=schedule_id, plant=job["plant"], job_type=job["job_type"],
                        status="skipped", trigger="schedule", scheduled_for=_now(), triggered_by="schedule",
                        error=f"plant {job['plant']} no longer exists; job disabled")
        data.patch_job(job["id"], {"enabled": False}, "schedule")
        _log_event("warn", "jobs", "job disabled: its plant no longer exists", job_id=job["id"], plant=job["plant"])
        return None
    _retire_once_if_spent(sched, job, None)        # spent once it starts; never re-armed
    return run_job(job_id=job["id"], trigger=trigger, schedule_id=schedule_id, scheduled_for=when,
                   triggered_by="schedule", skip_if_running=sched["skip_if_running"])


def run_catch_up(schedule_id: int, plant: str | None = None, now: datetime | None = None) -> dict | None:
    """Catch-up for ONE arm of a schedule (called when the arm is newly armed: boot, a new or edited schedule). Fires
    the most recent expected fire ONCE as trigger 'catchup' when it is within the grace and has no run, and records the
    older misses as ONE skipped run 'missed: process was down (N fires)' (the Missed tile). Never a once / paused /
    retired / disabled schedule, never outside validity (the occurrence stream ends there), never a fire that already
    has a run. Returns {fired, missed} or None. Never raises."""
    try:
        now = now or _now()
        sched = data.get_schedule(schedule_id)
        if sched is None or sched["retired"] or sched["paused"] or sched["kind"] == "once":
            return None
        job = data.get_job(sched["job_id"])
        if job is None or job["archived"] or not job["enabled"]:
            return None
        row = arm_row(sched, job, plant)
        runs_plant = plant or (None if job.get("targets") else job["plant"])
        base = data.schedule_baseline(schedule_id, runs_plant, arm=plant)
        if base is None:                                 # no reliable baseline (first boot, a plant that just joined):
            _touch(schedule_id, plant)                   # start counting from now, never a 'process was down' storm
            return None
        plan = triggers.plan_catch_up(row, baseline=base, now=now, cal=calendar_for(row, plant), plant=plant or job["plant"])
        if plan is None:
            return None
        fire, missed, last = plan.fire, plan.missed, plan.missed_last
        if fire is not None and (data.run_since(schedule_id, runs_plant, fire.utc - timedelta(seconds=60))
                                 or (fire.note != "dst_overlap_second"
                                     and _ran_that_day(sched, job, plant, row["timezone"], fire.at))):
            fire = None                                  # already covered (a late normal fire, a re-armed duplicate)
        if missed and last is not None:
            n = f"{missed}+" if plan.capped else str(missed)
            record_skipped(schedule_id, last, f"{data.MISSED_PREFIX} process was down ({n} fire{'s' if missed != 1 else ''})",
                           plant, summary={"skipped_reason": "downtime", "missed": missed}, touch=False)
        if fire is not None:
            # Order: the downtime summary above does not move the watermark, and the fire's own run row (scheduled_for =
            # the expected time) is what records it, so a crash between the two re-plans the fire instead of losing it.
            fire_schedule(schedule_id, plant, catchup_for=fire.utc)
        else:
            _touch(schedule_id, plant)
        _log_event("info", "jobs", "schedule caught up after downtime", schedule_id=schedule_id, plant=plant,
                   fired=fire is not None, missed=missed)
        return {"fired": fire is not None, "missed": missed}
    except Exception as exc:  # noqa: BLE001
        log.warning("catch-up failed for schedule %s: %s", schedule_id, exc)
        return None


def _ran_that_day(sched: dict, job: dict, plant: str | None, tz: str, at: datetime) -> bool:
    """Once-a-day presets: a non-skipped scheduled run already exists for this plant on the expected fire's local date."""
    if sched["kind"] not in ONCE_A_DAY_KINDS:
        return False
    try:
        return data.schedule_ran_on(sched["id"], plant or job["plant"], tz, at.astimezone(triggers.get_zone(tz)).date())
    except Exception:  # noqa: BLE001
        return False


def record_skipped(schedule_id: int, scheduled_for: datetime | None, reason: str, plant: str | None = None,
                   summary: dict | None = None, touch: bool = True) -> int | None:
    """A fire that never ran (APScheduler misfire past its grace time, maintenance mode, a policy re-check, downtime)
    still leaves a visible `skipped` run (for the per-plant arm's `plant` when there is one, else the job's home
    plant), and stamps the schedule's `last_fire_at`."""
    try:
        sched = data.get_schedule(schedule_id)
        job = data.get_job(sched["job_id"]) if sched else None
        if sched is None or job is None:
            return None
        _retire_once_if_spent(sched, job, plant)
        rid = data.insert_run(job_id=job["id"], schedule_id=schedule_id, plant=plant or job["plant"],
                              job_type=job["job_type"], status="skipped", trigger="schedule",
                              scheduled_for=scheduled_for, triggered_by="schedule", error=reason, summary=summary)
        if touch:
            _touch(schedule_id, plant)
        return rid
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
    if not jt.available:                       # hard guard for a scaffolded type (never runs, even if a row exists)
        return jt, None, unavailable_message(jt)
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


def _not_startable(job: dict, trigger: str) -> str | None:
    """Why a run must not start now: the job was archived, or (for a scheduled run) disabled, after it was queued. A
    manual run of a disabled job is the admin's explicit choice and still starts. Maintenance mode skips scheduled and
    catch-up runs ('maintenance mode') but never a manual one."""
    if job["archived"]:
        return "not started: the job was archived"
    if not job["enabled"] and trigger in ("schedule", "catchup"):
        return "not started: the job was disabled"
    if trigger in ("schedule", "catchup") and _maintenance_on():
        return "maintenance mode"
    return None


def run_job(*, job_id: int, trigger: str, schedule_id: int | None = None, scheduled_for: datetime | None = None,
            triggered_by: str | None = None, run_id: int | None = None, skip_if_running: bool = True,
            plant: str | None = None, override: dict | None = None, batch_id: int | None = None) -> int | None:
    """Execute one job (plus fixed-policy retries). Returns the id of the last run row. Never raises. A fan-out child
    passes its `plant` and per-plant `override` (re-applied to the freshly read job on every retry) and `batch_id`."""
    try:
        job = data.get_job(job_id)
        if job is None:
            return None
        if run_id is not None:
            row = data.get_run(run_id)
            if row and row["status"] != "scheduled":      # skipped or cancelled while it waited (a batch cancel)
                return run_id
        reason = _not_startable(job, trigger)
        if reason:                                         # re-checked at the moment the child starts, not at fire time
            if run_id is not None:
                data.finish_run(run_id, "skipped", {"error_kind": "config", "failed_step": "recheck"}, reason, False)
            return run_id
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
            if _not_retryable(run_id):
                log.info("job %s not retried: a configuration refusal or a restarted run", job_id)
                return run_id
            if jt.composite and not chain_type.all_idempotent(params):
                # A retry re-runs the WHOLE chain: only safe when every step may run twice.
                log.info("job %s not retried: its chain has a step that is not safe to repeat", job_id)
                return run_id
            time.sleep(RETRY_DELAY_S)
            # The job may have been edited, disabled or archived while we waited: every attempt reads it afresh.
            job = data.get_job(job_id)
            if job is None or job["archived"] or not job["enabled"]:
                log.info("job %s retry cancelled: it was archived, disabled or removed", job_id)
                return run_id
            job = _apply_target(job, plant, override)
            jt, params, err = _prepare(job)
            if jt is not None and params is not None and jt.composite and not chain_type.all_idempotent(params):
                log.info("job %s not retried: the edited chain has a step that is not safe to repeat", job_id)
                return run_id                             # the retry would run the CURRENT steps, not the failed ones
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


def _not_retryable(run_id: int) -> bool:
    """A failure a retry cannot fix: the job or its inputs are wrong (`error_kind` config: a guard refused, bad
    window), or the run was a restart from a step (a retry would re-run the whole CURRENT chain, not the failed steps).
    Only `system` / `transient` failures are retried."""
    try:
        row = data.get_run(run_id)
        if row and (row["summary"] or {}).get("error_kind") == "config":
            return True
        return bool(data.run_resume(run_id))
    except Exception as exc:  # noqa: BLE001 - fall back to the old behaviour (retry)
        log.warning("retry check failed for run %s: %s", run_id, exc)
        return False


def _attempt_params(run_id: int, jt, params):
    """The params this attempt will actually RUN. Ordinary: the job's. A chain restarted from a step runs the failed
    run's SNAPSHOT from the restart point, so its locks, slots, timeout and idempotency come from those steps."""
    if not jt.composite:
        return params
    try:
        resume = data.run_resume(run_id)
        if not resume:
            return params
        seq = int(resume["from_seq"])
        return chain_type.snapshot_params([r for r in data.list_steps(int(resume["from_run"])) if r["seq"] >= seq])
    except Exception as exc:  # noqa: BLE001
        log.warning("could not read the restart snapshot of run %s: %s", run_id, exc)
        return params


def _execute(run_id: int, job: dict, jt, params, skip_if_running: bool) -> str:
    """Run one attempt on an existing run row; returns its final status."""
    params = _attempt_params(run_id, jt, params)
    timeout = int(job["timeout_s"] or jt.timeout_for(params))
    lock_keys = jt.lock_names(job["plant"], params)      # one key for an ordinary type; a chain: the union of its steps'
    # LOCK ORDER (slot-gated types, the optimizer; a chain takes its steps' slots): the slots BEFORE the global
    # semaphore. Holders of the semaphore never wait on a slot they do not already hold, so there is no cycle, and a run
    # queued for a slot does not sit on one of the two global places. It stays `scheduled` (Queued) while it waits.
    held: list = []
    try:
        for slot in jt.slot_list(params):
            if not _acquire_slot(slot, run_id):
                data.finish_run(run_id, "cancelled", None, "cancelled before start", False)
                return "cancelled"
            held.append(slot)
        return _execute_gated(run_id, job, jt, params, skip_if_running, timeout, lock_keys, bool(held))
    finally:
        for slot in reversed(held):
            slot.release()


def _acquire_slot(slot, run_id: int) -> bool:
    """Wait for a type's slot, polling the DB cancel flag every ~2 s (the run has no context yet). False = cancelled."""
    next_poll = time.monotonic() + CANCEL_POLL_S
    while not slot.acquire(timeout=0.5):
        if time.monotonic() >= next_poll:
            next_poll = time.monotonic() + CANCEL_POLL_S
            row = data.get_run(run_id)
            if row and row["cancel_requested"]:
                return False
    return True


def _try_locks(conn, keys: list[str]) -> bool:
    """Take every lock (already sorted) on this session, all or none: a failure releases the ones taken so far."""
    held: list[str] = []
    try:
        for k in keys:
            if data.try_session_lock(conn, k):
                held.append(k)
                continue
            for h in reversed(held):
                data.release_session_lock(conn, h)
            return False
    except BaseException:                       # a DB error midway must not leave the first keys held on the pooled connection
        for h in reversed(held):
            try:
                data.release_session_lock(conn, h)
            except Exception:  # noqa: BLE001
                pass
        raise
    return True


def _execute_gated(run_id: int, job: dict, jt, params, skip_if_running: bool, timeout: int, lock_keys: list[str],
                   slot_held: bool) -> str:
    _SEM.acquire()
    try:
        with db._pool.connection() as conn:
            got = _try_locks(conn, lock_keys)
            try:
                if not got and skip_if_running:
                    data.finish_run(run_id, "skipped", None, "previous run still running", False)
                    return "skipped"
                if not got:                                   # queue behind the running one, within the timeout
                    t_end = time.monotonic() + timeout
                    while not got and time.monotonic() < t_end:
                        time.sleep(2.0)
                        got = _try_locks(conn, lock_keys)
                    if not got:
                        data.finish_run(run_id, "skipped", None, "previous run still running", False)
                        return "skipped"
                run = data.get_run(run_id)
                if run and run["cancel_requested"]:
                    data.finish_run(run_id, "cancelled", None, "cancelled before start", False)
                    return "cancelled"
                return _run_body(run_id, job, jt, params, timeout, slot_held)
            finally:
                if got:
                    for k in reversed(lock_keys):
                        data.release_session_lock(conn, k)
    finally:
        _SEM.release()


def _run_body(run_id: int, job: dict, jt, params, timeout: int, slot_held: bool = False) -> str:
    def sink(rows):
        try:
            data.write_log_rows(run_id, rows)
        except Exception as exc:  # noqa: BLE001 - losing log lines must not fail the run
            log.warning("job_run_log write failed for run %s: %s", run_id, exc)

    ctx = JobContext(run_id=run_id, plant=job["plant"], job_id=job["id"], sink=sink, mirror=_mirror)
    ctx.defer_clock = bool(getattr(jt, "defer_clock", False))
    ctx.slot_held = slot_held                    # the runner already holds the type's slot: the body must not take it
    with _RUNNING_LOCK:
        _RUNNING[run_id] = ctx
    # A deferred-clock body that still has to wait for a shared slot itself (no runner-held slot) counts as Queued
    # until begin_work(); its elapsed time / duration start from begin_work(), not from here.
    data.mark_running(run_id, waiting_for="slot" if ctx.defer_clock and not slot_held else None)
    if ctx.defer_clock:
        ctx.on_work_start = lambda: data.mark_work_started(run_id)
    if slot_held:
        ctx.begin_work()
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
    deadline = None if ctx.defer_clock and not ctx.work_started.is_set() else time.monotonic() + timeout
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
        if jt.composite:
            summary = _close_chain_steps(run_id, status, summary, error)
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


def _close_chain_steps(run_id: int, status: str, summary: dict | None, error: str | None) -> dict | None:
    """Safety net for a chain whose body did not finish its own bookkeeping (a timeout, an abandoned body): open step rows
    take the run's outcome, and a failed or cancelled run with no `steps` gets them derived from the step rows (so the
    run's step bar and the timeline agree). Never raises."""
    try:
        data.close_open_steps(run_id, status, error)
        if status in ("failed", "cancelled") and not (summary or {}).get("steps"):
            rows = data.list_steps(run_id)
            summary = {**(summary or {}), "chain": True,
                       "steps": [{"seq": r["seq"], "step": r["label"] or r["step_type"], "type": r["step_type"],
                                  "status": r["status"],
                                  "duration_ms": data.step_to_wire(r)["duration_ms"]} for r in rows]}
    except Exception as exc:  # noqa: BLE001
        log.warning("could not close the steps of chain run %s: %s", run_id, exc)
    return summary


def _store_artifact(run_id: int, ctx: JobContext, holder: dict, status: str, summary: dict | None) -> dict | None:
    """A report body's artifact is stored BEFORE the run is finished (so a viewer that sees the run done always finds
    it). A save failure never fails the run: the summary says so (`artifact_error`) and an error line is logged."""
    art = getattr(holder.get("outcome"), "artifact", None)
    # A chain keeps the artifact of its last successful report even when it failed or was cancelled afterwards.
    keep = status in ("succeeded", "warning") or bool((summary or {}).get("chain") and status in ("failed", "cancelled"))
    if not art or not keep:
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
        # The body's own outcome (a chain's step list, action ids, step counts, failed step) survives a timeout once it
        # has stopped; an abandoned body has none.
        out = holder.get("outcome") if not th.is_alive() else None
        summary = dict(out.summary) if out is not None and out.summary else None
        if summary is not None:
            summary["error_kind"] = "system"
        return "failed", summary, f"timed out after {timeout}s"
    if th.is_alive():                                           # abandoned body (cancel ignored)
        return "failed", None, "run did not stop after cancel"
    if "cancelled" in holder:
        return "cancelled", None, None
    if "error" in holder:
        return "failed", None, holder["error"]
    out: JobOutcome = holder.get("outcome") or JobOutcome("succeeded")
    if ctx.cancelled and out.status != "failed":
        if (out.summary or {}).get("chain") and not out.summary.get("cancelled"):
            pass                       # a chain whose steps all committed before the cancel arrived: not `cancelled`
        else:
            return "cancelled", out.summary or None, None
    status = out.status if out.status in ("succeeded", "warning", "failed") else "succeeded"
    return status, out.summary or None, out.error
