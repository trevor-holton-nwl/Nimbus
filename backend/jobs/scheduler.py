"""Scheduler wiring: the DB is the source of truth, APScheduler holds one in-memory job per active schedule.

`install(scheduler)` (called from the brain.py lifespan before `scheduler.start()`) sweeps stale runs, arms every
active schedule as `job:<schedule_id>` (max_instances=1, coalesce, misfire grace), then keeps APScheduler in step
with the DB through a 60 s reconcile tick (so a schedule saved through the API starts firing within a minute),
plus a daily run-history retention sweep and a +90 s boot sweep.
"""
from __future__ import annotations

import asyncio
import collections
import functools
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from apscheduler.events import EVENT_JOB_MISSED
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger

from backend.admin_ops.logbuffer import _log_event
from backend.jobs import data, runner, targets, triggers

log = logging.getLogger("nimbus.jobs")

JOB_PREFIX = "job:"
RECONCILE_SECONDS = 60
_SIGS: dict[str, tuple] = {}
_WARNED: set[tuple] = set()          # (schedule id, warning) already logged, so a 60 s tick does not repeat it


def _sig(r: dict) -> tuple:
    """What an armed job was built from. `r` is an ARM row (`plan_arms`): `timezone` is the EFFECTIVE zone resolved at
    this reconcile, so a plant timezone edit, or a plant joining or leaving the target set, changes the signature.
    W3b: the policy (`options`) and the plant's calendar version (`_cal_ver`, set only for a calendar-driven policy) are
    part of it, so a calendar edit re-arms the schedule at the next tick without a restart."""
    return (r["modified_at"], r["kind"], r["cron_expr"], r["time_of_day"], tuple(r["days_of_week"] or ()),
            r["day_of_month"], r["run_at"], r["timezone"], r["valid_from"], r["valid_until"], r["misfire_grace_s"],
            r.get("arm_plant"), json.dumps(r.get("options"), sort_keys=True, default=str), r.get("_cal_ver"))


def arm_id(schedule_id: int, plant: str | None) -> str:
    return f"{JOB_PREFIX}{schedule_id}" if plant is None else f"{JOB_PREFIX}{schedule_id}:{plant}"


def plan_arms(r: dict, plants: list[dict]) -> tuple[list[dict], list[str]]:
    """The APScheduler jobs one active schedule needs, plus expansion warnings. Pure (plant rows injected).

    - `plant` mode (default) with target rows: one arm per runnable plant, id `job:<sid>:<plant>`, built in THAT
      plant's timezone; a plant with no valid timezone is not armed (warning).
    - `plant` mode without target rows (a legacy single-plant job): one arm `job:<sid>` in the home plant's CURRENT
      timezone (the stored zone only when the plant has none), so a plant timezone edit re-arms without a restart.
    - `fixed` / `utc`: one arm `job:<sid>` in that zone; the fan-out over the plants happens inside the fire.
    Each arm is the schedule row with `timezone` replaced by the effective zone and `arm_plant` set."""
    mode = r.get("tz_mode") or "plant"
    if mode == "fixed":
        return [{**r, "timezone": r.get("fixed_timezone") or r["timezone"], "arm_plant": None}], []
    if mode == "utc":
        return [{**r, "timezone": "UTC", "arm_plant": None}], []
    by = {p["plant"]: p for p in plants}
    if not r.get("targets"):
        tz, skip = targets._tz_state((by.get(r["plant"]) or {}).get("timezone"))
        return [{**r, "timezone": r["timezone"] if skip else tz, "arm_plant": None}], []
    exp = targets.expand_targets({"plant": r["plant"], "targets": r["targets"], "scope_plants": r.get("scope_plants")},
                                 plants=plants)
    return ([{**r, "timezone": e["timezone"], "arm_plant": e["plant"]} for e in targets.runnable(exp)],
            exp["warnings"])


# Scheduled fires block for the whole run (minutes), so they get their own bounded pool: on the shared anyio
# threadpool, a 50-plant 08:00 would take every worker the UI API needs. Surplus fires queue here, not there.
FIRE_WORKERS = 6
_FIRE_POOL = ThreadPoolExecutor(max_workers=FIRE_WORKERS, thread_name_prefix="job-fire")


async def _fire(schedule_id: int, plant: str | None = None) -> None:
    """APScheduler job body. Offloads the blocking run to the dedicated fire pool; never raises."""
    try:
        fired_at = datetime.now(timezone.utc)           # taken here, not in the pool: a queued fire keeps its fire time
        await asyncio.get_running_loop().run_in_executor(
            _FIRE_POOL, functools.partial(runner.fire_schedule, schedule_id, plant, fired_at=fired_at))
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "scheduled job fire raised", exc=exc, schedule_id=schedule_id)


CATCHUP_PER_TICK = 20          # arms handed to catch-up per reconcile: a boot with hundreds of schedules is spread out
_CATCHUP_QUEUE: collections.deque = collections.deque()      # (schedule id, arm plant) waiting for run_catch_up


def _arm_plant(a: dict) -> str:
    return a.get("arm_plant") or a["plant"]


def _calendar_view(want: dict[str, dict], plants: list[dict]):
    """One injected calendar view for every arm whose policy reads the calendar, and stamp each such arm's plant
    calendar version into the arm (`_cal_ver`) for the signature. None when no arm needs a calendar."""
    needing = {jid: a for jid, a in want.items() if triggers.policy_of(a).needs_calendar()}
    if not needing:
        return None
    names = {_arm_plant(a) for a in needing.values()}
    versions = data.calendar_versions(names)
    for a in needing.values():
        a["_cal_ver"] = versions.get(_arm_plant(a))
    zones = {p["plant"]: p["timezone"] for p in plants if p["timezone"]}
    return data.load_calendar_view(names, zones)


def _drain_catchup(limit: int | None = None) -> int:
    """Hand up to `limit` (default CATCHUP_PER_TICK) queued arms to catch-up on the bounded fire pool; never blocks the
    reconcile."""
    limit = CATCHUP_PER_TICK if limit is None else limit
    n = 0
    while _CATCHUP_QUEUE and n < limit:
        sid, plant = _CATCHUP_QUEUE.popleft()
        _FIRE_POOL.submit(runner.run_catch_up, sid, plant)
        n += 1
    return n


def reconcile(scheduler) -> dict:
    """Arm/replace/remove APScheduler jobs so they match the active schedules in the DB. Blocking. A (re)armed
    schedule is queued for catch-up (fires lost to downtime), a bounded number per tick."""
    out = {"added": 0, "removed": 0, "skipped": 0}
    want: dict[str, dict] = {}
    plants = data.load_plant_rows()                        # fresh each time: a timezone edit is seen at once
    for r in data.list_active_schedules():
        arms, warnings = plan_arms(r, plants)
        for w in warnings:
            if (r["id"], w) not in _WARNED:
                _WARNED.add((r["id"], w))
                _log_event("warn", "jobs", "plant is not armed for a multi-plant schedule", schedule_id=r["id"], reason=w)
        if r["kind"] == "once":
            if not any(a["arm_plant"] for a in arms):
                if data.schedule_has_run(r["id"]):
                    continue
            else:                                          # per-plant once: each plant is spent on its own
                fired = data.schedule_fired_plants(r["id"])
                arms = [a for a in arms if a["arm_plant"] not in fired]
        for a in arms:
            want[arm_id(r["id"], a["arm_plant"])] = a
    have = {j.id for j in scheduler.get_jobs() if j.id.startswith(JOB_PREFIX)}
    for jid in have - set(want):
        try:
            scheduler.remove_job(jid)
        except Exception:  # noqa: BLE001 - it may have just finished
            pass
        _SIGS.pop(jid, None)
        out["removed"] += 1
    try:
        cal = _calendar_view(want, plants)                  # a failed calendar read leaves the policy fail-open
    except Exception as exc:  # noqa: BLE001
        _log_event("error", "jobs", "could not read plant calendars for job schedules", exc=exc)
        cal = None
    for jid, r in want.items():
        if jid in have and _SIGS.get(jid) == _sig(r):
            continue
        try:
            who = _arm_plant(r)
            trig = triggers.build_trigger(r, cal=cal, plant=who)
            if not triggers.next_fire_times(r, 1, cal=cal, plant=who):   # an exhausted trigger would be added paused
                out["skipped"] += 1
                _SIGS[jid] = _sig(r)
                if jid in have:
                    scheduler.remove_job(jid)
                continue
            scheduler.add_job(_fire, trig, args=[r["id"], r["arm_plant"]], id=jid, max_instances=1, coalesce=True,
                              misfire_grace_time=int(r["misfire_grace_s"]), replace_existing=True)
            _SIGS[jid] = _sig(r)
            out["added"] += 1
            if r["kind"] != "once" and (r["id"], r["arm_plant"]) not in _CATCHUP_QUEUE:
                _CATCHUP_QUEUE.append((r["id"], r["arm_plant"]))
        except Exception as exc:  # noqa: BLE001 - one bad schedule must not block the others
            _log_event("error", "jobs", "could not arm schedule", exc=exc, schedule_id=r["id"])
    out["catchup"] = _drain_catchup()
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
    parts = jid[len(JOB_PREFIX):].split(":", 1)          # job:<sid> or job:<sid>:<plant>
    try:
        sid = int(parts[0])
    except ValueError:
        return
    plant = parts[1] if len(parts) > 1 else None
    at = getattr(event, "scheduled_run_time", None)
    threading.Thread(target=runner.record_skipped, args=(sid, at, data.MISSED_PREFIX + " fired after its grace time", plant),
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
