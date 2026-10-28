"""Scheduler wiring: the DB is the source of truth, APScheduler holds one in-memory job per active schedule.

`install(scheduler)` (called from the brain.py lifespan before `scheduler.start()`) sweeps stale runs, arms every
active schedule as `job:<schedule_id>` (max_instances=1, coalesce, misfire grace), then keeps APScheduler in step
with the DB through a 60 s reconcile tick (so a schedule saved through the API starts firing within a minute),
plus a daily run-history retention sweep and a +90 s boot sweep.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from apscheduler.events import EVENT_JOB_MISSED
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger

from backend.admin_ops.logbuffer import _log_event
from backend.jobs import data, runner, triggers

log = logging.getLogger("nimbus.jobs")

JOB_PREFIX = "job:"
RECONCILE_SECONDS = 60
_SIGS: dict[str, tuple] = {}


def _sig(r: dict) -> tuple:
    return (r["modified_at"], r["kind"], r["cron_expr"], r["time_of_day"], tuple(r["days_of_week"] or ()),
            r["day_of_month"], r["run_at"], r["timezone"], r["valid_from"], r["valid_until"], r["misfire_grace_s"])


async def _fire(schedule_id: int) -> None:
    """APScheduler job body. Offloads the blocking run to the threadpool; never raises."""
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(runner.fire_schedule, schedule_id)
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "scheduled job fire raised", exc=exc, schedule_id=schedule_id)


def reconcile(scheduler) -> dict:
    """Arm/replace/remove APScheduler jobs so they match the active schedules in the DB. Blocking."""
    out = {"added": 0, "removed": 0, "skipped": 0}
    want: dict[str, dict] = {}
    for r in data.list_active_schedules():
        if r["kind"] == "once" and data.schedule_has_run(r["id"]):
            continue
        want[f"{JOB_PREFIX}{r['id']}"] = r
    have = {j.id for j in scheduler.get_jobs() if j.id.startswith(JOB_PREFIX)}
    for jid in have - set(want):
        try:
            scheduler.remove_job(jid)
        except Exception:  # noqa: BLE001 - it may have just finished
            pass
        _SIGS.pop(jid, None)
        out["removed"] += 1
    for jid, r in want.items():
        if jid in have and _SIGS.get(jid) == _sig(r):
            continue
        try:
            trig = triggers.build_trigger(r)
            if not triggers.next_fire_times(r, 1):          # an exhausted trigger would be added paused
                out["skipped"] += 1
                _SIGS[jid] = _sig(r)
                if jid in have:
                    scheduler.remove_job(jid)
                continue
            scheduler.add_job(_fire, trig, args=[r["id"]], id=jid, max_instances=1, coalesce=True,
                              misfire_grace_time=int(r["misfire_grace_s"]), replace_existing=True)
            _SIGS[jid] = _sig(r)
            out["added"] += 1
        except Exception as exc:  # noqa: BLE001 - one bad schedule must not block the others
            _log_event("error", "jobs", "could not arm schedule", exc=exc, schedule_id=r["id"])
    return out


async def _reconcile_tick(scheduler) -> None:
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(reconcile, scheduler)
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "job reconcile raised", exc=exc)


async def _run_sweep() -> None:
    from fastapi.concurrency import run_in_threadpool
    try:
        result = await run_in_threadpool(data.sweep_job_runs)
        _log_event("warn" if result.get("error") else "info", "jobs", "job run sweep finished", **result)
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "job run sweep raised", exc=exc)


def _on_missed(event) -> None:
    jid = str(getattr(event, "job_id", ""))
    if not jid.startswith(JOB_PREFIX):
        return
    try:
        sid = int(jid[len(JOB_PREFIX):])
    except ValueError:
        return
    at = getattr(event, "scheduled_run_time", None)
    threading.Thread(target=runner.record_skipped, args=(sid, at, "missed: fired after its grace time"),
                     name=f"job-missed-{sid}", daemon=True).start()


def install(scheduler) -> None:
    """Wire the jobs domain into an (unstarted) AsyncIOScheduler."""
    swept = data.boot_sweep()
    if swept:
        _log_event("warn", "jobs", "marked interrupted job runs failed on boot", count=swept)
    try:
        res = reconcile(scheduler)
        _log_event("info", "jobs", "job schedules armed", **res)
    except Exception as exc:  # noqa: BLE001 - the 60 s tick retries
        _log_event("error", "jobs", "initial job reconcile failed", exc=exc)
    scheduler.add_listener(_on_missed, EVENT_JOB_MISSED)
    scheduler.add_job(_reconcile_tick, IntervalTrigger(seconds=RECONCILE_SECONDS), args=[scheduler],
                      id="nimbus:jobs-reconcile", max_instances=1, coalesce=True, replace_existing=True)
    scheduler.add_job(_run_sweep, IntervalTrigger(hours=24), id="nimbus:job-run-sweep", max_instances=1,
                      coalesce=True, replace_existing=True)
    scheduler.add_job(_run_sweep, DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=90)),
                      id="nimbus:job-run-sweep:boot", max_instances=1, coalesce=True, replace_existing=True)
