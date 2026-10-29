"""Scheduler wiring: the DB is the source of truth, APScheduler holds one in-memory job per active schedule.

`install(scheduler)` (called from the brain.py lifespan before `scheduler.start()`) sweeps stale runs, arms every
active schedule as `job:<schedule_id>` (max_instances=1, coalesce, misfire grace), then keeps APScheduler in step
with the DB through a 60 s reconcile tick (so a schedule saved through the API starts firing within a minute),
plus a daily run-history retention sweep and a +90 s boot sweep.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
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


# Scheduled fires block for the whole run (minutes), so they get their own bounded pool: on the shared anyio
# threadpool, a 50-plant 08:00 would take every worker the UI API needs. Surplus fires queue here, not there.
FIRE_WORKERS = 6
_FIRE_POOL = ThreadPoolExecutor(max_workers=FIRE_WORKERS, thread_name_prefix="job-fire")


async def _fire(schedule_id: int) -> None:
    """APScheduler job body. Offloads the blocking run to the dedicated fire pool; never raises."""
    try:
        await asyncio.get_running_loop().run_in_executor(_FIRE_POOL, runner.fire_schedule, schedule_id)
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


HEARTBEAT_STALE_S = 180        # three missed 60 s ticks: the scheduler is not ticking
_LAST_TICK: dict[str, datetime | None] = {"at": None}


def record_tick(now: datetime | None = None) -> None:
    _LAST_TICK["at"] = now or datetime.now(timezone.utc)


def heartbeat(now: datetime | None = None) -> dict:
    """{ok, last_tick_at}: in-process only (a restart clears it; the install-time reconcile counts as a tick)."""
    at = _LAST_TICK["at"]
    now = now or datetime.now(timezone.utc)
    ok = at is not None and (now - at).total_seconds() <= HEARTBEAT_STALE_S
    return {"ok": ok, "last_tick_at": at.isoformat(timespec="seconds") if at else None}


async def _reconcile_tick(scheduler) -> None:
    from fastapi.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(reconcile, scheduler)
        record_tick()
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
    """Wire the jobs domain into an (unstarted) AsyncIOScheduler. Never raises: brain.py's scheduler try block
    would otherwise skip `scheduler.start()` and take the SAP and sweep jobs down with it."""
    try:
        _install(scheduler)
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "job scheduler install failed; scheduled jobs are not armed", exc=exc)


def _install(scheduler) -> None:
    try:
        from backend.jobs.types import optimizer, optimizer_runner
        optimizer.set_runner(optimizer_runner.run_optimizer)
    except Exception as exc:  # noqa: BLE001 - an unwired optimizer fails its runs clearly; nothing else is affected
        _log_event("error", "jobs", "optimizer runner could not be wired", exc=exc)
    try:
        swept = data.boot_sweep()
        if swept:
            _log_event("warn", "jobs", "marked interrupted job runs failed on boot", count=swept)
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "job boot sweep failed", exc=exc)
    try:
        res = reconcile(scheduler)
        _log_event("info", "jobs", "job schedules armed", **res)
        record_tick()
    except Exception as exc:  # noqa: BLE001 - the 60 s tick retries
        _log_event("error", "jobs", "initial job reconcile failed", exc=exc)
    scheduler.add_listener(_on_missed, EVENT_JOB_MISSED)
    scheduler.add_job(_reconcile_tick, IntervalTrigger(seconds=RECONCILE_SECONDS), args=[scheduler],
                      id="nimbus:jobs-reconcile", max_instances=1, coalesce=True, replace_existing=True)
    scheduler.add_job(_run_sweep, IntervalTrigger(hours=24), id="nimbus:job-run-sweep", max_instances=1,
                      coalesce=True, replace_existing=True)
    scheduler.add_job(_run_sweep, DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=90)),
                      id="nimbus:job-run-sweep:boot", max_instances=1, coalesce=True, replace_existing=True)
