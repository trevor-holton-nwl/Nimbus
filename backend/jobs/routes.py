"""NIMBUS jobs routes: scheduled job definitions, schedules, runs and run logs.

HTTP concerns only; persistence is backend/jobs/data.py, execution backend/jobs/runner.py. Writes are
require_api_key + require_admin and plant-scoped; reads are require_authenticated scoped by the user's plants.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, ValidationError

import master_data as md
from backend.jobs import artifacts, data, runner, targets, triggers, window_service, windows
from backend.jobs.context import LEVELS
from backend.jobs.registry import describe_params, get_type, list_types
from backend.security import auth

router = APIRouter()
_BIGINT = 9223372036854775807
_GRACE = timedelta(minutes=1)
_ADMIN = [Depends(auth.require_api_key), Depends(auth.require_admin)]
_STATUSES = ("scheduled", "running", "succeeded", "warning", "failed", "cancelled", "skipped", "missed")
PROPOSAL_ROW_CAP = 200


# ----------------------------------------------------------------------------------------------- request bodies
class TargetIn(BaseModel):
    kind: Literal["explicit", "subnetwork", "all"]
    value: str = Field("", max_length=4000)
    excluded: bool = False
    params_override: dict | None = None


class FanOutIn(BaseModel):
    stagger_s: int = Field(0, ge=0, le=3600)
    max_parallel: int | None = Field(None, ge=1, le=50)
    fail_fast: bool = False


class ScheduleIn(BaseModel):
    kind: str
    time_of_day: str | None = None
    days_of_week: list[int] | None = None
    day_of_month: int | None = None
    cron_expr: str | None = None
    run_at: str | None = None
    valid_from: str | None = None
    valid_until: str | None = None
    paused: bool = False
    misfire_grace_s: int = Field(300, ge=1, le=86400)
    skip_if_running: bool = True
    tz_mode: Literal["plant", "fixed", "utc"] = "plant"
    fixed_timezone: str | None = Field(None, max_length=64)
    options: dict | None = None          # W3b policy: dst_gap, dst_overlap, closed_day, run_window, monthly, catch_up


class SchedulePatch(BaseModel):
    options: dict | None = None
    tz_mode: Literal["plant", "fixed", "utc"] | None = None
    fixed_timezone: str | None = Field(None, max_length=64)
    kind: str | None = None
    time_of_day: str | None = None
    days_of_week: list[int] | None = None
    day_of_month: int | None = None
    cron_expr: str | None = None
    run_at: str | None = None
    valid_from: str | None = None
    valid_until: str | None = None
    paused: bool | None = None
    retired: bool | None = None
    misfire_grace_s: int | None = Field(None, ge=1, le=86400)
    skip_if_running: bool | None = None


class JobCreate(BaseModel):
    plant: str
    job_type: str
    name: str = Field(min_length=1, max_length=120)
    params: dict = Field(default_factory=dict)
    enabled: bool = True
    retry_max: int = Field(0, ge=0, le=5)
    timeout_s: int | None = Field(None, ge=10, le=21600)
    schedules: list[ScheduleIn] = Field(default_factory=list)
    targets: list[TargetIn] = Field(default_factory=list, max_length=500)
    fan_out: FanOutIn | None = None


class JobPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    params: dict | None = None
    enabled: bool | None = None
    archived: bool | None = None
    retry_max: int | None = Field(None, ge=0, le=5)
    timeout_s: int | None = Field(None, ge=10, le=21600)
    targets: list[TargetIn] | None = Field(None, max_length=500)       # [] clears them (single plant again)
    fan_out: FanOutIn | None = None


class PreviewIn(ScheduleIn):
    plant: str
    n: int = Field(5, ge=1, le=20)
    targets: list[TargetIn] = Field(default_factory=list, max_length=500)
    plant_offset: int = Field(0, ge=0, le=100000)
    plant_limit: int = Field(10, ge=1, le=50)


class TargetsPreviewIn(BaseModel):
    """Either `targets` (rows as stored) or the one-row shorthand `kind`/`value` plus `excluded` plant codes."""
    targets: list[TargetIn] | None = Field(None, max_length=500)
    kind: Literal["explicit", "subnetwork", "all"] | None = None
    value: str = Field("", max_length=4000)
    excluded: list[str] = Field(default_factory=list, max_length=500)
    offset: int = Field(0, ge=0, le=100000)
    limit: int = Field(200, ge=1, le=500)


# ------------------------------------------------------------------------------------------------------ helpers
def _check_plant(plant: str, allowed) -> None:
    try:
        md._assert_plant_allowed(plant, allowed)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _expansion_plants(job: dict) -> set[str]:
    """Every plant the job's CURRENT targets name (creator scope ignored: this is who a write would touch)."""
    exp = targets.expand_targets(job, plants=data.load_plant_rows(), require_tz=False, apply_scope=False)
    return {e["plant"] for e in exp["plants"]}


def _assert_write_scope(job: dict, allowed) -> None:
    """A write to a job (run, restart, edit, schedule, batch cancel) is a 403 for a plant-scoped admin when the job's
    current targets include a plant outside their access, naming those plants (unrestricted admins are unaffected)."""
    if allowed is None or not job.get("targets"):
        return
    outside = sorted(_expansion_plants(job) - set(allowed))
    if outside:
        more = f" and {len(outside) - 10} more" if len(outside) > 10 else ""
        raise HTTPException(status_code=403, detail="this job also runs for plants outside your access: "
                                                    f"{', '.join(outside[:10])}{more}")


def _job_or_404(job_id: int, allowed, *, write: bool = False) -> dict:
    """The job. A READ is allowed when its home plant OR any plant it targets is in the caller's scope; a WRITE needs
    the home plant and every targeted plant (`_assert_write_scope`)."""
    job = data.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if write:
        _check_plant(job["plant"], allowed)
        _assert_write_scope(job, allowed)
        return job
    try:
        _check_plant(job["plant"], allowed)
    except HTTPException:
        if allowed is None or not job.get("targets") or not (_expansion_plants(job) & set(allowed)):
            raise
    return job


def _normalize(plant: str, payload: dict, *, check_past: bool = True, need_tz: bool = False,
               tz_mode: str = "plant", fixed_timezone: str | None = None) -> dict:
    """Validate a schedule payload; ScheduleError becomes a 400. The zone the times are read in comes from `tz_mode`:
    `plant` = the home plant's timezone (each target plant's own at arm time), `fixed` = `fixed_timezone`, `utc`.
    `need_tz`: the job type cannot run without a plant timezone (the optimizer) and the schedule is read in the home
    plant's zone, so a schedule for a plant with none is refused up front."""
    if tz_mode == "fixed" and not (fixed_timezone or "").strip():
        raise HTTPException(status_code=400, detail="fixed_timezone is required when tz_mode is 'fixed'")
    if tz_mode == "plant" and need_tz and not data.plant_has_timezone(plant):
        raise HTTPException(status_code=400, detail=f"plant {plant!r} has no timezone; set one in Plants before scheduling this job")
    zone = {"plant": lambda: data.plant_timezone(plant), "fixed": lambda: (fixed_timezone or "").strip(),
            "utc": lambda: "UTC"}[tz_mode]()
    if tz_mode != "plant" and triggers.options_need_plant_time(payload.get("options")):
        raise HTTPException(status_code=400, detail="closed-day and working-day rules follow a plant's calendar: use plant time")
    try:
        s = triggers.validate_schedule({**payload, "timezone": zone})
        if check_past and s["kind"] == "once":
            tz = triggers.get_zone(s["timezone"])
            if s["run_at"].replace(tzinfo=tz) < datetime.now(timezone.utc) - _GRACE:
                raise triggers.ScheduleError("run_at is in the past")
    except triggers.ScheduleError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    s["tz_mode"] = tz_mode
    s["fixed_timezone"] = zone if tz_mode == "fixed" else None
    return s


def _needs_tz(job: dict) -> bool:
    from backend.jobs.registry import REGISTRY
    jt = REGISTRY.get(job["job_type"])
    return bool(jt and jt.needs_plant_timezone)


def _resolve_targets(home: str, rows: list[TargetIn], allowed, jt=None, params: dict | None = None, *,
                     plants: list[dict] | None = None, require_nonempty: bool = True) -> tuple[list[dict], dict]:
    """Normalise incoming target rows and check them at SAVE time: every plant they expand to must be one the acting
    admin may reach (403; an `all` row is stored with the admin's own scope so it is always in scope), an explicit
    plant or a subnetwork must exist (400), the expansion must not be empty (400) and each plant's merged params must
    pass the type's model (400). Returns (rows to store, expansion)."""
    plants = plants if plants is not None else data.load_plant_rows()
    try:
        norm = targets.normalize_targets([r.model_dump() for r in rows])
    except targets.TargetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    known = {p["plant"] for p in plants}
    subs = {s for p in plants for s in p["subnetworks"]}
    for r in norm:
        if r["kind"] == "all":
            r["value"] = targets.all_scope_value(allowed)
        elif not r["excluded"] and r["kind"] == "explicit" and r["value"] not in known:
            raise HTTPException(status_code=400, detail=f"unknown plant {r['value']!r}")
        elif not r["excluded"] and r["kind"] == "subnetwork" and r["value"] not in subs:
            raise HTTPException(status_code=400, detail=f"unknown subnetwork {r['value']!r}")
    exp = targets.expand_targets({"plant": home, "targets": norm}, plants=plants)
    if norm and not exp["plants"] and require_nonempty:
        raise HTTPException(status_code=400, detail="the targets expand to no plants")
    for e in exp["plants"]:
        _check_plant(e["plant"], allowed)
    if jt is not None and norm:
        for e in exp["plants"]:
            if e["params_override"]:
                _validate_params(jt, targets.deep_merge(params or {}, e["params_override"]), plant=e["plant"])
    return norm, exp


def _target_kind(rows: list[dict]) -> str:
    kinds = {r["kind"] for r in rows if not r["excluded"]}
    if not rows or not kinds:
        return "single"
    if len(kinds) > 1:
        return "mixed"
    return {"explicit": "selected", "subnetwork": "subnetwork", "all": "all"}[next(iter(kinds))]


def _timing_fields(model: BaseModel) -> dict:
    return {k: v for k, v in model.model_dump(exclude_unset=True).items()
            if k in ("kind", "time_of_day", "days_of_week", "day_of_month", "cron_expr", "run_at",
                     "valid_from", "valid_until", "options")}


def _flags(model: BaseModel) -> dict:
    return {k: v for k, v in model.model_dump(exclude_unset=True).items()
            if k in ("paused", "retired", "misfire_grace_s", "skip_if_running") and v is not None}


def _arms(schedule: dict, job: dict, plants: list[dict]) -> tuple[list[dict], list[str]]:
    """The arm rows (see scheduler.plan_arms) of one stored schedule of `job`."""
    from backend.jobs import scheduler
    return scheduler.plan_arms({**schedule, "plant": job["plant"], "targets": job.get("targets") or [],
                                "scope_plants": job.get("scope_plants")}, plants)


# A fire time is a pure function of the arm's timing fields, and building a trigger per arm per request is what made
# GET /jobs cost O(jobs x plants). Memoise per (schedule, arm signature) for a short TTL; a schedule edit changes the
# key, so only the clock can make an entry stale (by at most the TTL).
_FIRE_TTL_S = 30.0
_FIRE_CACHE: dict[tuple, tuple[float, object]] = {}
UPCOMING_ARMS_MAX = 100          # arms one schedule contributes to an upcoming list


def _arm_key(sid: int, a: dict, what) -> tuple:
    return (sid, what, a.get("kind"), a.get("cron_expr"), a.get("time_of_day"), tuple(a.get("days_of_week") or ()),
            a.get("day_of_month"), a.get("run_at"), a.get("timezone"), a.get("valid_from"), a.get("valid_until"),
            a.get("arm_plant"), json.dumps(a.get("options"), sort_keys=True, default=str))


def _cal_for(arms: list[dict], plants: list[dict]):
    """The injected calendar view for the arms whose policy reads the plant calendar (None when none does)."""
    need = {a.get("arm_plant") or a["plant"] for a in arms if triggers.policy_of(a).needs_calendar()}
    if not need:
        return None
    memo = getattr(plants, "cal_memo", None)            # per request: each plant's calendar is read once
    zones = {p["plant"]: p["timezone"] for p in plants if p["timezone"]}
    if memo is None:
        return data.load_calendar_view(need, zones)
    missing = [p for p in sorted(need) if p not in memo]
    if missing:
        view = data.load_calendar_view(missing, zones)
        for p in missing:
            memo[p] = view
    views = {id(memo[p]): memo[p] for p in need}
    if len(views) == 1:
        return next(iter(views.values()))
    from backend.jobs.calview import PlantCalendarView
    return PlantCalendarView({p: v.cals[p] for p in need for v in [memo[p]] if p in v.cals},
                             {p: v.zones[p] for p in need for v in [memo[p]] if p in v.zones})


def _fires_of(sid: int, a: dict, what, fn, cal):
    """`fn()` memoised for 30 s, except for a calendar-driven policy: its answer follows the calendar, so it is computed
    fresh (the preview must equal what the scheduler would arm right now)."""
    if cal is not None and triggers.policy_of(a).needs_calendar():
        return fn()
    return _memo(_arm_key(sid, a, what), fn)


def _memo(key: tuple, fn):
    import time
    now = time.monotonic()
    hit = _FIRE_CACHE.get(key)
    if hit and now - hit[0] < _FIRE_TTL_S:
        return hit[1]
    val = fn()
    if len(_FIRE_CACHE) > 20000:
        _FIRE_CACHE.clear()
    _FIRE_CACHE[key] = (now, val)
    return val


def _next_run(job: dict, plants: list[dict] | None = None) -> dict | None:
    """Soonest fire over every schedule and every plant arm (a multi-plant job's next run is its earliest plant's)."""
    if not job["enabled"] or job["archived"]:
        return None
    plants = plants if plants is not None else data.load_plant_rows()
    best = None
    for s in job["schedules"]:
        if s["paused"]:
            continue
        try:
            arms, _ = _arms(s, job, plants)
            cal = _cal_for(arms, plants)
            for a in arms:
                who = a["arm_plant"] or job["plant"]
                fires = _fires_of(s["id"], a, "next", lambda a=a, who=who: triggers.next_fire_times(a, 1, cal=cal, plant=who), cal)
                if fires and (best is None or fires[0] < best[0]):
                    best = (fires[0], s["id"])
        except Exception:  # noqa: BLE001 - a broken row must not break the list
            continue
    if best is None:
        return None
    t, sid = best
    return {"at_utc": t.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "at_local": t.isoformat(timespec="seconds"), "schedule_id": sid}


def _job_wire(job: dict, plants: list[dict] | None = None) -> dict:
    plants = plants if plants is not None else data.load_plant_rows()
    w = data.definition_to_wire(job)
    w["schedules"] = [data.schedule_to_wire(s) for s in job["schedules"]]
    nxt = _next_run(job, plants)
    w["next_run_at"] = nxt["at_utc"] if nxt else None
    w["next_run_local"] = nxt["at_local"] if nxt else None
    exp = targets.expand_targets(job, plants=plants, require_tz=_needs_tz(job))
    w["target_kind"] = _target_kind(job.get("targets") or [])
    w["target_count"] = 1 if exp["single"] else len(targets.runnable(exp))     # a legacy job always runs its home plant
    w["target_skipped"] = 0 if exp["single"] else len(exp["plants"]) - w["target_count"]
    last = job.get("last_run")
    w["last_run"] = data.run_to_wire(last) if last else None
    lb = job.get("last_batch")                      # multi-plant jobs: the newest batch's rollup (live counts)
    w["last_batch"] = ({"id": lb["id"], "status": lb["status"], "counts": lb["counts"] or {},
                        "scheduled_for": data._iso(lb["scheduled_for"])} if lb else None)
    return w


def _validate_params(jt, params: dict, plant: str | None = None) -> dict:
    try:
        return jt.params_model.model_validate(params or {}).model_dump(mode="json")
    except ValidationError as e:
        where = f" for plant {plant}" if plant else ""
        raise HTTPException(status_code=400, detail=f"invalid params{where}: {e.errors(include_url=False)}") from e


# ----------------------------------------------------------------------------------------------------- types
@router.get("/jobs/types", dependencies=[Depends(auth.require_authenticated)])
def job_types(response: Response):
    response.headers["Cache-Control"] = "no-store"
    out = []
    for jt in list_types():
        out.append({"key": jt.key, "label": jt.label, "plant_scoped": jt.plant_scoped,
                    "default_timeout_s": jt.default_timeout_s, "stub": jt.stub,
                    "kind": jt.kind, "mutates": jt.mutates, "params": describe_params(jt),
                    "params_schema": jt.params_model.model_json_schema(),
                    "defaults": jt.params_model().model_dump(mode="json")})
    return {"types": out}


# ----------------------------------------------------------------------------------------------- windows
class WindowPreviewIn(BaseModel):
    plant: str
    window: dict
    job_id: int | None = Field(None, ge=1, le=_BIGINT)
    first_run_lookback_days: int = Field(1, ge=1, le=60)


@router.post("/jobs/windows/preview", dependencies=[Depends(auth.require_authenticated)])
def preview_window(body: WindowPreviewIn, response: Response,
                   allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """What a DateWindow resolves to today in the plant timezone: the same resolver a run uses
    (window_service.resolve_for_plant), so the dialog line cannot disagree with the run."""
    _check_plant(body.plant, allowed_plants)
    if body.job_id is not None:
        _job_or_404(body.job_id, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    try:
        win = windows.DateWindow.model_validate(body.window)
        resolved = window_service.resolve_for_plant(body.plant, win, job_id=body.job_id,
                                                    first_run_lookback_days=body.first_run_lookback_days)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"invalid window: {e.errors(include_url=False)}") from e
    except windows.WindowConfigError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return window_service.public(resolved)


# ------------------------------------------------------------------------------------------------ jobs: read
@router.get("/jobs", dependencies=[Depends(auth.require_authenticated)])
def list_jobs(
    response: Response,
    plant: str | None = Query(None),
    job_type: str | None = Query(None),
    status: str | None = Query(None),
    q: str | None = Query(None, max_length=100),
    include_archived: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None, ge=1, le=_BIGINT),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    if plant:
        _check_plant(plant, allowed_plants)
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400, detail="unknown status")
    response.headers["Cache-Control"] = "no-store"
    page = data.list_jobs(allowed_plants=allowed_plants, plant=plant, job_type=job_type, status=status, q=q,
                          include_archived=include_archived, limit=limit, before_id=before_id)
    plants = data.load_plant_rows()
    return {"jobs": [_job_wire(j, plants) for j in page["jobs"]], "next_before_id": page["next_before_id"]}


@router.get("/jobs/summary", dependencies=[Depends(auth.require_authenticated)])
def jobs_summary(
    response: Response,
    plant: str | None = Query(None),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Health strip: live run counts, 24 h outcomes, the next fire, the scheduler heartbeat and the ids of runs
    that are taking longer than the job's usual."""
    from backend.jobs import scheduler
    if plant:
        _check_plant(plant, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    health = data.run_health(allowed_plants=allowed_plants, plant=plant)
    entries = _upcoming_entries(allowed_plants, plant, 1)
    nxt = entries[0] if entries else None
    return {**health,
            "next_fire": ({k: nxt[k] for k in ("at_utc", "at_local", "job_id", "job_name", "plant")} if nxt else None),
            "scheduler": scheduler.heartbeat(), "maintenance": data.maintenance_state()}


class MaintenanceIn(BaseModel):
    enabled: bool


@router.post("/jobs/maintenance", dependencies=_ADMIN)
def set_maintenance(body: MaintenanceIn, actor: str | None = Depends(auth.require_admin),
                    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Maintenance mode (system setting `jobs_paused`): while on, every scheduled and catch-up fire is recorded as a
    skipped run 'maintenance mode' (counted Skipped, not Missed); a manual Run now still works. It is global, so only a
    plant-unrestricted admin may flip it."""
    if allowed_plants is not None:
        raise HTTPException(status_code=403, detail="Maintenance mode is global; it needs an admin with access to every plant")
    return data.set_maintenance(body.enabled, actor)


@router.get("/jobs/upcoming", dependencies=[Depends(auth.require_authenticated)])
def upcoming_all(
    response: Response,
    plant: str | None = Query(None),
    n: int = Query(10, ge=1, le=50),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Next `n` fire times across the visible jobs, soonest first."""
    if plant:
        _check_plant(plant, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    return {"entries": _upcoming_entries(allowed_plants, plant, n)[:n]}


def _upcoming_entries(allowed_plants, plant, n: int) -> list[dict]:
    """Next `n` fires per armed schedule over every visible enabled job (one light query, no run history), soonest
    first. Each schedule contributes at most `n`, so the first `n` overall are always present."""
    entries = []
    plants = data.load_plant_rows()
    for s in data.next_fire_schedules(allowed_plants=allowed_plants, plant=plant):
        entries += _schedule_entries(s, {"id": s["job_id"], "name": s["job_name"], "plant": s["plant"],
                                         "targets": s.get("targets") or [], "scope_plants": s.get("scope_plants")},
                                     plants, n, allowed_plants, only_plant=plant)
    entries.sort(key=lambda e: e["at_utc"])
    return entries


def _schedule_entries(s: dict, job: dict, plants: list[dict], n: int, allowed_plants,
                      only_plant: str | None = None) -> list[dict]:
    """Next `n` fires of one schedule for EACH of its plant arms (a scoped viewer only sees arms in their plants;
    `only_plant` keeps just that plant's arm, a TARGETED plant and not the job's home plant); `plant` and `timezone`
    name the arm, `at_local` is in that plant's zone. At most UPCOMING_ARMS_MAX arms per schedule."""
    try:
        arms, _ = _arms(s, job, plants)
    except Exception:  # noqa: BLE001 - a broken row must not break the strip
        return []
    out = []
    try:
        cal = _cal_for(arms, plants)
    except Exception:  # noqa: BLE001 - fail open, like the scheduler
        cal = None
    for a in arms:
        arm_plant = a["arm_plant"] or job["plant"]
        job_level = a["arm_plant"] is None and bool(job.get("targets"))   # a fixed / UTC fan-out: one arm, many plants
        if not job_level and allowed_plants is not None and arm_plant not in allowed_plants:
            continue
        if not job_level and only_plant is not None and arm_plant != only_plant:
            continue
        if len(out) >= UPCOMING_ARMS_MAX * n:
            break
        try:
            fires = _fires_of(s["id"], a, ("preview", n), lambda a=a, p=arm_plant: triggers.preview(a, n, cal=cal, plant=p), cal)
        except Exception:  # noqa: BLE001
            continue
        out += [{**e, "job_id": job["id"], "job_name": job["name"], "plant": arm_plant,
                 "schedule_id": s["id"], "timezone": a["timezone"]} for e in fires]
    return out


TIMELINE_MAX_DAYS = 8
TIMELINE_UPCOMING_PER_ARM = 100
TIMELINE_UPCOMING_PER_LANE = 300


def _parse_instant(v: str | None, default: datetime, name: str) -> datetime:
    if not v:
        return default
    try:
        t = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (ValueError, OverflowError) as e:           # a year-1 / year-9999 value overflows the UTC conversion
        raise HTTPException(status_code=400, detail=f"{name} is not an ISO date-time") from e


@router.get("/jobs/timeline", dependencies=[Depends(auth.require_authenticated)])
def jobs_timeline(
    response: Response,
    plant: str | None = Query(None),
    plants: str | None = Query(None, max_length=2000, description="comma-separated plant codes"),
    start: str | None = Query(None, alias="from"),
    end: str | None = Query(None, alias="to"),
    limit: int = Query(500, ge=1, le=2000),
    plant_offset: int = Query(0, ge=0, le=100000),
    plant_limit: int = Query(20, ge=1, le=50),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Runs in [from, to) plus UPCOMING fires from the same occurrence stream the scheduler arms, grouped into one lane
    per plant (a plant filter always yields its lane; otherwise only plants with a run or a fire in range). The range is
    at most 8 days (default: 12 h either side of now). Lanes are paged by plant (`plant_offset`/`plant_limit`, default the
    first 20); a scoped caller only ever sees their plants. Times are UTC (`*_utc`) with each lane's IANA zone and its
    own `now_local`; `limit` caps run rows over the page (`truncated`)."""
    now = datetime.now(timezone.utc)
    t0 = _parse_instant(start, now - timedelta(hours=12), "from")
    t1 = _parse_instant(end, now + timedelta(hours=12), "to")
    if t1 <= t0:
        raise HTTPException(status_code=400, detail="'to' must be after 'from'")
    if t1 - t0 > timedelta(days=TIMELINE_MAX_DAYS):
        raise HTTPException(status_code=400, detail=f"the range is at most {TIMELINE_MAX_DAYS} days")
    asked = [p.strip() for p in (plants or "").split(",") if p.strip()]
    if plant:
        asked = [plant] + [p for p in asked if p != plant]
    for p in asked:
        _check_plant(p, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    plant_rows = data.load_plant_rows()
    zones = {p["plant"]: p["timezone"] for p in plant_rows}
    schedules = data.next_fire_schedules(allowed_plants=allowed_plants, plant=None)
    # Armed arms (per schedule): which plants have upcoming fires, and the arms to expand for the page's lanes.
    arm_sets: list[tuple[dict, dict, list[dict]]] = []
    for s in schedules:
        job = {"id": s["job_id"], "name": s["job_name"], "plant": s["plant"], "targets": s.get("targets") or [],
               "scope_plants": s.get("scope_plants")}
        try:
            arms, _w = _arms(s, job, plant_rows)
        except Exception:  # noqa: BLE001 - a broken row must not break the page
            continue
        arm_sets.append((s, job, arms))

    def arm_lanes(job: dict, a: dict) -> list[str]:
        if a["arm_plant"] is not None or not job.get("targets"):
            return [a["arm_plant"] or job["plant"]]
        exp = targets.expand_targets(job, plants=plant_rows, require_tz=False)        # fixed / UTC fan-out
        return [e["plant"] for e in targets.runnable(exp)][:200]

    def visible(p: str) -> bool:
        return allowed_plants is None or p in allowed_plants

    if asked:
        lane_plants = sorted(set(asked))
    else:
        have = set(data.timeline_run_plants(allowed_plants=allowed_plants, start=t0, end=t1))
        if t1 > now:
            for _s, job, arms in arm_sets:
                for a in arms:
                    have.update(p for p in arm_lanes(job, a) if visible(p))
        lane_plants = sorted(have)
    total = len(lane_plants)
    page = lane_plants[plant_offset:plant_offset + plant_limit]
    lanes = {p: {"plant": p, "timezone": zones.get(p) or "UTC", "now_local": None, "runs": [], "upcoming": []} for p in page}
    for p, lane in lanes.items():
        try:
            lane["now_local"] = now.astimezone(triggers.get_zone(lane["timezone"])).isoformat(timespec="seconds")
        except triggers.ScheduleError:
            lane["timezone"] = "UTC"
            lane["now_local"] = now.isoformat(timespec="seconds")
    rows = data.timeline_runs(allowed_plants=allowed_plants, plants=page, start=t0, end=t1, limit=limit) if page else []
    truncated = len(rows) > limit
    upcoming_truncated = False
    for r in rows[:limit]:
        started = r["started_at"] or r["scheduled_for"] or r["created_at"]
        lanes[r["plant"]]["runs"].append({
            "id": r["id"], "job_id": r["job_id"], "job_name": r["job_name"], "job_type": r["job_type"],
            "status": r["status"], "trigger": r["trigger"], "batch_id": r["batch_id"], "error": r["error"],
            "scheduled_for": data._iso(r["scheduled_for"]), "start_utc": data._iso(started),
            "end_utc": data._iso(r["ended_at"])})
    if t1 > now and page:
        after = max(t0, now)
        in_page = set(page)
        for s, job, arms in arm_sets:
            try:
                cal = _cal_for(arms, plant_rows)
            except Exception:  # noqa: BLE001
                cal = None
            for a in arms:
                targets_in_page = [p for p in arm_lanes(job, a) if p in in_page and visible(p)]
                if not targets_in_page:
                    continue
                try:
                    fires = triggers.fires_between(a, start=after, end=t1, cap=TIMELINE_UPCOMING_PER_ARM, cal=cal,
                                                   plant=a["arm_plant"] or job["plant"])
                except Exception:  # noqa: BLE001
                    continue
                if len(fires) >= TIMELINE_UPCOMING_PER_ARM:
                    upcoming_truncated = True            # the arm has more fires in range than the per-arm cap
                for p in targets_in_page:
                    lane = lanes[p]
                    for o in fires:
                        if len(lane["upcoming"]) >= TIMELINE_UPCOMING_PER_LANE:
                            upcoming_truncated = True
                            break
                        w = triggers.occ_wire(o)
                        lane["upcoming"].append({
                            "at_utc": w["at_utc"], "at_local": o.at.astimezone(triggers.get_zone(lane["timezone"])).isoformat(timespec="seconds"),
                            "job_id": job["id"], "job_name": job["name"], "schedule_id": s["id"],
                            "dst_shifted": w["dst_shifted"], "policy_note": w["policy_note"]})
        for lane in lanes.values():
            lane["upcoming"].sort(key=lambda e: e["at_utc"])
    return {"from": t0.isoformat(timespec="seconds"), "to": t1.isoformat(timespec="seconds"),
            "now_utc": now.isoformat(timespec="seconds"), "lanes": [lanes[p] for p in page],
            "total_plants": total, "plant_offset": plant_offset, "plant_limit": plant_limit, "truncated": truncated,
            "upcoming_truncated": upcoming_truncated}


UPCOMING_JOB_MAX = 200


def _job_upcoming(job: dict, n: int, allowed_plants=None) -> list[dict]:
    """`n` fires per plant arm (the soonest `UPCOMING_JOB_MAX` overall); a single-plant job still returns `n`."""
    out = []
    if not job["enabled"] or job["archived"]:
        return out
    plants = data.load_plant_rows()
    for s in job["schedules"]:
        if s["paused"]:
            continue
        out += _schedule_entries(s, job, plants, n, allowed_plants)
    out.sort(key=lambda e: e["at_utc"])
    return out[:n] if not job.get("targets") else out[:UPCOMING_JOB_MAX]


@router.get("/jobs/{job_id}/upcoming", dependencies=[Depends(auth.require_authenticated)])
def upcoming_for_job(job_id: int, response: Response, n: int = Query(5, ge=1, le=50),
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    return {"job_id": job_id, "entries": _job_upcoming(job, n, allowed_plants)}


# ---------------------------------------------------------------------------------------------- jobs: write
@router.post("/jobs", dependencies=_ADMIN)
def create_job(body: JobCreate, actor: str | None = Depends(auth.require_admin),
               allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    _check_plant(body.plant, allowed_plants)
    jt = get_type(body.job_type)
    if jt is None:
        raise HTTPException(status_code=400, detail=f"unknown job type {body.job_type!r}")
    if not data.plant_exists(body.plant):
        raise HTTPException(status_code=400, detail=f"unknown plant {body.plant!r}")
    params = _validate_params(jt, body.params)
    rows, _exp = _resolve_targets(body.plant, body.targets, allowed_plants, jt, params)
    schedules = [{**_normalize(body.plant, _timing_fields(s), need_tz=jt.needs_plant_timezone and not rows,
                               tz_mode=s.tz_mode, fixed_timezone=s.fixed_timezone),
                  "paused": s.paused, "misfire_grace_s": s.misfire_grace_s, "skip_if_running": s.skip_if_running}
                 for s in body.schedules]
    job_id = data.create_job(plant=body.plant, job_type=body.job_type, name=body.name.strip(), params=params,
                             enabled=body.enabled, retry_max=body.retry_max, timeout_s=body.timeout_s,
                             schedules=schedules, actor=actor, targets=rows,
                             fan_out=body.fan_out.model_dump() if body.fan_out else None,
                             scope_plants=allowed_plants)
    return _job_wire(data.get_job(job_id))


@router.patch("/jobs/{job_id}", dependencies=_ADMIN)
def patch_job(job_id: int, body: JobPatch, actor: str | None = Depends(auth.require_admin),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants, write=True)
    fields = body.model_dump(exclude_unset=True)
    params_changed = False
    if fields.get("params") is not None:
        jt = get_type(job["job_type"]) or _registered(job["job_type"])
        # Merge over the stored params: a partial PATCH must not reset an omitted key (an old dry run's
        # apply_mode) to the model default.
        fields["params"] = _validate_params(jt, {**(job["params"] or {}), **fields["params"]})
        params_changed = True
    elif "params" in fields:
        fields.pop("params")
    for k in ("name", "enabled", "archived", "retry_max"):
        if k in fields and fields[k] is None:
            fields.pop(k)
    new_targets = None
    if fields.get("targets") is not None:
        jt = get_type(job["job_type"]) or _registered(job["job_type"])
        merged_params = fields.get("params") or job["params"] or {}
        new_targets, _exp = _resolve_targets(job["plant"], body.targets or [], allowed_plants, jt, merged_params)
    elif params_changed and job.get("targets"):
        # New params must still validate for every plant that carries a per-plant override (stored rows are kept).
        jt = get_type(job["job_type"]) or _registered(job["job_type"])
        exp = targets.expand_targets(job, plants=data.load_plant_rows(), require_tz=False, apply_scope=False)
        for e in exp["plants"]:
            if e["params_override"]:
                _validate_params(jt, targets.deep_merge(fields["params"], e["params_override"]), plant=e["plant"])
    fields.pop("targets", None)
    if fields.get("fan_out") is not None:
        fields["fan_out"] = body.fan_out.model_dump()
    # One transaction for the definition and its targets; a scoped admin's save refreshes the job's creator scope.
    data.patch_job(job_id, fields, actor, targets=new_targets, scope_plants=allowed_plants,
                   set_scope=allowed_plants is not None)
    return _job_wire(data.get_job(job_id))


def _registered(key: str):
    from backend.jobs.registry import REGISTRY
    jt = REGISTRY.get(key)
    if jt is None:
        raise HTTPException(status_code=400, detail=f"unknown job type {key!r}")
    return jt


@router.post("/jobs/{job_id}/schedules", dependencies=_ADMIN)
def add_schedule(job_id: int, body: ScheduleIn, actor: str | None = Depends(auth.require_admin),
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants, write=True)
    s = {**_normalize(job["plant"], _timing_fields(body), need_tz=_needs_tz(job) and not job["targets"],
                      tz_mode=body.tz_mode, fixed_timezone=body.fixed_timezone),
         "paused": body.paused, "misfire_grace_s": body.misfire_grace_s, "skip_if_running": body.skip_if_running}
    sid = data.add_schedule(job_id, s, actor)
    return data.schedule_to_wire(data.get_schedule(sid))


@router.patch("/jobs/schedules/{schedule_id}", dependencies=_ADMIN)
def patch_schedule(schedule_id: int, body: SchedulePatch, actor: str | None = Depends(auth.require_admin),
                   allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    cur = data.get_schedule(schedule_id)
    if cur is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    job = _job_or_404(cur["job_id"], allowed_plants, write=True)
    timing = _timing_fields(body)
    tz_set = {"tz_mode", "fixed_timezone"} & body.model_fields_set
    normalized = None
    flags = _flags(body)
    if timing or tz_set:
        merged = {k: cur[k] for k in ("kind", "time_of_day", "days_of_week", "day_of_month", "cron_expr", "run_at",
                                      "valid_from", "valid_until", "options")}
        if "kind" in timing and timing["kind"] != cur["kind"]:
            merged = {"kind": timing["kind"]}          # a kind change starts clean; stale fields never leak
        merged.update(timing)
        mode = body.tz_mode or cur["tz_mode"]
        fixed = body.fixed_timezone if "fixed_timezone" in body.model_fields_set else cur["fixed_timezone"]
        normalized = _normalize(job["plant"], merged, check_past="run_at" in timing or "kind" in timing,
                                need_tz=_needs_tz(job) and not job["targets"], tz_mode=mode, fixed_timezone=fixed)
        flags = {**flags, "tz_mode": normalized["tz_mode"], "fixed_timezone": normalized["fixed_timezone"]}
    data.patch_schedule(schedule_id, normalized, flags, actor)
    return data.schedule_to_wire(data.get_schedule(schedule_id))


@router.post("/jobs/schedules/preview", dependencies=[Depends(auth.require_authenticated)])
def preview_schedule(body: PreviewIn, response: Response,
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Next-N fire times for an unsaved schedule, from the same trigger the scheduler arms. With target rows in
    `plant` time zone mode the answer is per plant (`plants`, paged by `plant_offset`/`plant_limit`, each with its own
    zone and local times); otherwise `entries` is the one list (fixed / UTC / single plant) and `plants` is empty.
    `total_plants` counts the plants the targets run (1 for a single-plant job); `warnings` names skipped plants."""
    from backend.jobs import scheduler
    _check_plant(body.plant, allowed_plants)
    plants = data.load_plant_rows()
    rows, exp = _resolve_targets(body.plant, body.targets, allowed_plants, plants=plants, require_nonempty=False)
    s = _normalize(body.plant, _timing_fields(body), check_past=False, tz_mode=body.tz_mode,
                   fixed_timezone=body.fixed_timezone)
    response.headers["Cache-Control"] = "no-store"
    arms, _ = scheduler.plan_arms({**s, "id": 0, "plant": body.plant, "targets": rows}, plants)
    out = {"timezone": s["timezone"], "cron_expr": s["cron_expr"], "entries": [], "skipped": [], "plants": [],
           "total_plants": 1 if exp["single"] else len(targets.runnable(exp)), "warnings": exp["warnings"] if rows else []}

    def full(a: dict) -> tuple[list[dict], list[dict]]:
        who = a["arm_plant"] or body.plant
        return triggers.preview_full(a, body.n, cal=_cal_for([a], plants), plant=who)   # the scheduler's own stream

    if rows and body.tz_mode == "plant":
        out["total_plants"] = len(arms)
        for a in arms[body.plant_offset:body.plant_offset + body.plant_limit]:
            entries, skipped = full(a)
            out["plants"].append({"plant": a["arm_plant"], "timezone": a["timezone"], "entries": entries, "skipped": skipped})
    else:
        out["entries"], out["skipped"] = full(arms[0])
        out["timezone"] = arms[0]["timezone"]
    return out


@router.post("/jobs/targets/preview", dependencies=[Depends(auth.require_authenticated)])
def preview_targets(body: TargetsPreviewIn, response: Response,
                    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """What a target selection runs for today, in the order it would run: `{plants:[{plant, timezone, warning?}],
    count (plants that run), skipped, warnings}`; `plants` is paged by `offset`/`limit` (max 500). The same expansion
    and scope check as saving (a plant outside the caller's scope is a 403), so the dialog line cannot disagree."""
    if body.targets is not None:
        rows_in = body.targets
    elif body.kind:
        rows_in = [TargetIn(kind=body.kind, value=body.value)] + [TargetIn(kind="explicit", value=c, excluded=True)
                                                                   for c in body.excluded]
    else:
        raise HTTPException(status_code=400, detail="targets or kind is required")
    response.headers["Cache-Control"] = "no-store"
    if not rows_in:
        return {"plants": [], "count": 0, "skipped": 0, "warnings": []}
    _rows, exp = _resolve_targets("", rows_in, allowed_plants, require_nonempty=False)
    run = targets.runnable(exp)
    page = exp["plants"][body.offset:body.offset + body.limit]
    return {"plants": [{"plant": e["plant"], "timezone": e["timezone"], "warning": e["skip"]} for e in page],
            "count": len(run), "skipped": len(exp["plants"]) - len(run), "warnings": exp["warnings"]}


@router.post("/jobs/{job_id}/run", dependencies=_ADMIN)
def run_now(job_id: int, actor: str | None = Depends(auth.require_admin),
            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants, write=True)
    if job["archived"]:
        raise HTTPException(status_code=409, detail="Job is archived")
    _409_if_busy(job_id)
    return _start(job, actor, "manual")


def _409_if_busy(job_id: int, plant: str | None = None) -> None:
    """409 naming what is in the way (`plant` = a per-plant restart checks only that plant)."""
    busy = data.active_runs(job_id, plant)
    if busy:
        names = ", ".join(f"{b['plant']} ({b['status']})" for b in busy[:8]) + (", ..." if len(busy) > 8 else "")
        raise HTTPException(status_code=409, detail=f"A run of this job is already scheduled or running: {names}")


def _start(job: dict, actor: str | None, trigger: str, only_plants: set[str] | None = None) -> dict:
    """Run a job now (a fan-out when it has targets). `{run, batch}`: `run` is the single run, or the first child of
    the batch; `batch` is null for a single-plant job."""
    try:
        run_id = (runner.start_manual_run(job, actor, trigger, only_plants) if (trigger != "manual" or only_plants)
                  else runner.start_manual_run(job, actor))
    except runner.NoTargetPlants as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except runner.BatchPrepareError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    if run_id is None:
        raise HTTPException(status_code=409, detail="A run of this job is already scheduled or running")
    run = data.get_run(run_id)
    batch = data.get_batch(run["batch_id"]) if run.get("batch_id") else None
    return {"run": data.run_to_wire(run), "batch": data.batch_to_wire(batch) if batch else None}


# ------------------------------------------------------------------------------------------------------ batches
@router.get("/jobs/batches", dependencies=[Depends(auth.require_authenticated)])
def list_batches(
    response: Response,
    plant: str | None = Query(None),
    job_id: int | None = Query(None, ge=1, le=_BIGINT),
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None, ge=1, le=_BIGINT),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Fan-out batches, newest first (cursor `before_id`). A plant-scoped caller only gets batches that contain a run
    for one of their plants, with counts and status over those plants."""
    if plant:
        _check_plant(plant, allowed_plants)
    if status and status not in ("running", "succeeded", "warning", "failed"):
        raise HTTPException(status_code=400, detail="unknown status")
    response.headers["Cache-Control"] = "no-store"
    page = data.list_batches(allowed_plants=allowed_plants, plant=plant, job_id=job_id, status=status, limit=limit,
                             before_id=before_id)
    batches = data.scope_batches(page["batches"], allowed_plants)
    return {"batches": [data.batch_to_wire(b) for b in batches], "next_before_id": page["next_before_id"]}


@router.get("/jobs/batches/{batch_id}", dependencies=[Depends(auth.require_authenticated)])
def get_batch(batch_id: int, response: Response,
              limit: int = Query(data.BATCH_RUNS_DEFAULT, ge=1, le=500), offset: int = Query(0, ge=0, le=1_000_000),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """One batch and a page of its child runs (the caller's plants only; 404 when none of them is theirs). The batch's
    `counts` cover ALL its plants (live), whatever page the runs are on; `has_more` says another page exists."""
    b = data.get_batch(batch_id)
    runs = data.batch_runs(batch_id, allowed_plants, limit + 1, offset) if b else []
    if b is None or (not runs and offset == 0):
        raise HTTPException(status_code=404, detail="Batch not found")
    response.headers["Cache-Control"] = "no-store"
    b = data.scope_batches([b], allowed_plants)[0]
    return {"batch": data.batch_to_wire(b), "runs": [data.run_to_wire(r) for r in runs[:limit]],
            "has_more": len(runs) > limit, "offset": offset, "limit": limit}


def _batch_for_write(batch_id: int, allowed) -> tuple[dict, dict]:
    b = data.get_batch(batch_id)
    if b is None or not data.batch_runs(batch_id, allowed, 1):
        raise HTTPException(status_code=404, detail="Batch not found")
    return b, _job_or_404(b["job_id"], allowed, write=True)


@router.post("/jobs/batches/{batch_id}/cancel", dependencies=_ADMIN)
def cancel_batch(batch_id: int, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Cancel a live batch: running children are cancelled, children not started become skipped ('batch cancelled')."""
    b, _job = _batch_for_write(batch_id, allowed_plants)
    if b["status"] != "running":
        raise HTTPException(status_code=409, detail=f"Batch is already {b['status']}")
    fresh = runner.cancel_batch(batch_id) or b
    return {"batch": data.batch_to_wire(data.scope_batches([fresh], allowed_plants)[0])}


@router.post("/jobs/batches/{batch_id}/restart", dependencies=_ADMIN)
def restart_batch(batch_id: int, actor: str | None = Depends(auth.require_admin),
                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Re-run only the plants of this batch whose final run failed, was skipped or was cancelled, as a new batch."""
    b, job = _batch_for_write(batch_id, allowed_plants)
    if job["archived"]:
        raise HTTPException(status_code=409, detail="Job is archived")
    redo = {p for p, s in data.batch_latest_by_plant(batch_id).items() if s in ("failed", "skipped", "cancelled")}
    if not redo:
        raise HTTPException(status_code=400, detail="every plant in this batch already succeeded")
    _409_if_busy(job["id"])
    return _start(job, actor, "restart", redo)


# --------------------------------------------------------------------------------------------------- runs
@router.get("/jobs/runs", dependencies=[Depends(auth.require_authenticated)])
def list_runs(
    response: Response,
    plant: str | None = Query(None),
    job_id: int | None = Query(None, ge=1, le=_BIGINT),
    job_type: str | None = Query(None, max_length=100),
    status: str | None = Query(None),
    periodicity: str | None = Query(None),
    scheduled_by: str | None = Query(None, max_length=200),
    since_hours: int | None = Query(None, ge=1, le=168),
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None, ge=1, le=_BIGINT),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    if plant:
        _check_plant(plant, allowed_plants)
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400, detail="unknown status")
    if periodicity and periodicity not in data.PERIODICITIES:
        raise HTTPException(status_code=400, detail="unknown periodicity")
    response.headers["Cache-Control"] = "no-store"
    since = datetime.now(timezone.utc) - timedelta(hours=since_hours) if since_hours else None
    page = data.list_runs(allowed_plants=allowed_plants, plant=plant, job_id=job_id, status=status, limit=limit,
                          before_id=before_id, periodicity=periodicity, scheduled_by=scheduled_by, since=since,
                          job_type=job_type)
    return {"runs": [data.run_to_wire(r) for r in page["runs"]], "next_before_id": page["next_before_id"]}


def _run_or_404(run_id: int, allowed) -> dict:
    run = data.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    _check_plant(run["plant"], allowed)
    return run


@router.get("/jobs/runs/{run_id}", dependencies=[Depends(auth.require_authenticated)])
def get_run(run_id: int, response: Response,
            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    run = _run_or_404(run_id, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    return {"run": data.run_to_wire(run)}


def _hours_between(a: str | None, b: str | None) -> float | None:
    try:
        return round((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600, 2)
    except (TypeError, ValueError):
        return None


@router.get("/jobs/runs/{run_id}/proposal", dependencies=[Depends(auth.require_authenticated)])
def run_proposal(run_id: int, response: Response,
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """A dry run's stored proposal joined to the live orders: current machine, finish now vs proposed finish, delta
    and status. Read-only; a dry run is never applied, so there is nothing to approve or discard."""
    import db
    run = _run_or_404(run_id, allowed_plants)
    summ = run["summary"] or {}
    response.headers["Cache-Control"] = "no-store"
    if run["job_type"] == "optimizer.plant" and run["status"] in ("scheduled", "running") and not summ.get("apply_mode"):
        # No summary yet: the job's current params say whether this run is a dry run.
        job = data.get_job(run["job_id"])
        if job and (job["params"] or {}).get("apply_mode") == "propose":
            return {"run_id": run_id, "plant": run["plant"], "pending": True, "total": 0, "shown": 0, "rows": [],
                    "findings": [], "board_matches": None, "truncated": False}
    if run["job_type"] != "optimizer.plant" or summ.get("apply_mode") != "propose":
        raise HTTPException(status_code=400, detail="Only a dry run has a proposal")
    prop = summ.get("proposal")
    if not isinstance(prop, dict):
        return {"run_id": run_id, "plant": run["plant"], "total": int(summ.get("moved") or 0), "shown": 0, "rows": [],
                "findings": [], "board_matches": None, "truncated": True, "pending": False}
    patches = [p for p in (prop.get("patches") or []) if isinstance(p, dict) and p.get("id") is not None]
    # Biggest stored moves first (`delta_hours` is written at run time), then read live rows for the page only.
    patches.sort(key=lambda p: -abs(p.get("delta_hours") or 0))
    page = patches[:PROPOSAL_ROW_CAP]
    live = {t["id"]: t for t in db.get_task_versions([str(p["id"]) for p in page])}
    rows = []
    for p in page:
        t = live.get(str(p["id"]))
        before, after = (t or {}).get("end_date"), p.get("end_date")
        rows.append({"id": str(p["id"]), "machine": (t or {}).get("MACHINE"), "finish_before": before,
                     "finish_after": after, "delta_hours": _hours_between(before, after),
                     "status": (t or {}).get("planning_status"),
                     "changed_since": t is None or t.get("row_version") != p.get("base_version")})
    rows.sort(key=lambda r: (r["changed_since"], -abs(r["delta_hours"] or 0)))      # changed-since rows last
    return {"run_id": run_id, "plant": run["plant"], "total": len(patches), "shown": len(rows), "rows": rows,
            "findings": prop.get("findings") or [], "board_matches": _board_matches(run_id, run["plant"], prop),
            "truncated": False, "pending": False}


_MATCH_TTL_S = 60.0
_MATCH_CACHE: dict[int, tuple[float, bool | None]] = {}


def _board_matches(run_id: int, plant: str, prop: dict) -> bool | None:
    """Does the board's snapshot token still equal the one the dry run saw? Cached per run for a minute: the token
    rebuilds four version reads and the proposal is re-polled."""
    import time
    if not prop.get("snapshot_version"):
        return None
    hit = _MATCH_CACHE.get(run_id)
    if hit and time.monotonic() - hit[0] < _MATCH_TTL_S:
        return hit[1]
    try:
        from backend.scheduling import routes as sched
        matches = sched.optimizer_snapshot_version(plant) == prop["snapshot_version"]
    except Exception:  # noqa: BLE001 - a version read failure is "unknown", not an error page
        return None
    if len(_MATCH_CACHE) > 200:
        _MATCH_CACHE.clear()
    _MATCH_CACHE[run_id] = (time.monotonic(), matches)
    return matches


@router.get("/jobs/runs/{run_id}/log", dependencies=[Depends(auth.require_authenticated)])
def run_log(
    run_id: int,
    response: Response,
    after_seq: int = Query(0, ge=0, le=1_000_000),
    level: str = Query("debug"),
    limit: int = Query(500, ge=1, le=2000),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    if level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {', '.join(LEVELS)}")
    run = _run_or_404(run_id, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    lines = data.list_log(run_id, after_seq=after_seq, min_level=level, limit=limit)
    # Re-read the run AFTER the lines so `done` can never be true while unseen lines still exist.
    fresh = data.get_run(run_id) or run
    return {"run_id": run_id, "status": fresh["status"], "log_truncated": fresh["log_truncated"],
            "done": fresh["status"] in data.TERMINAL, "lines": lines,
            "last_seq": lines[-1]["seq"] if lines else after_seq}


@router.get("/jobs/runs/{run_id}/artifact", dependencies=[Depends(auth.require_authenticated)])
def run_artifact(
    run_id: int,
    response: Response,
    section: str | None = Query(None, max_length=100),
    format: str = Query("json", pattern="^(json|csv)$"),
    offset: int = Query(0, ge=0, le=10_000_000),
    limit: int = Query(artifacts.PAGE_MAX, ge=1, le=artifacts.PAGE_MAX),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """A report run's stored result. JSON: every section (or the one named by `section`) with `rows` cut to one page
    (`offset`/`limit`, max 500), so a large artifact never ships in a single response. `format=csv` needs `section`
    and returns that section's stored rows as text/csv."""
    run = _run_or_404(run_id, allowed_plants)
    art = data.get_artifact(run_id)
    if art is None:
        raise HTTPException(status_code=404, detail="This run has no artifact")
    body = art["artifact"]
    secs = body.get("sections") or []
    if section is not None:
        secs = [s for s in secs if s.get("key") == section]
        if not secs:
            raise HTTPException(status_code=404, detail="Unknown section")
    if format == "csv":
        if section is None:
            raise HTTPException(status_code=400, detail="format=csv needs a section")
        name = f"{run['job_type']}-{section}-run{run_id}.csv".replace("/", "_")
        return Response(content=artifacts.section_csv(secs[0]), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})
    response.headers["Cache-Control"] = "no-store"
    return {"run_id": run_id, "filename": art["filename"], "size_bytes": art["size_bytes"],
            "created_at": art["created_at"], "summary": body.get("summary") or {},
            "truncated": bool((body.get("summary") or {}).get("truncated")),
            "sections": [artifacts.page(s, offset, limit) for s in secs]}


@router.post("/jobs/runs/{run_id}/restart", dependencies=_ADMIN)
def restart_run(run_id: int, actor: str | None = Depends(auth.require_admin),
                allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Run the job again with its current params for THIS run's plant only (a new single run, or a batch of one for a
    multi-plant job); the old run is left as it was. The siblings of its batch are not touched: use
    `POST /jobs/batches/{id}/restart` for the failed ones."""
    run = _run_or_404(run_id, allowed_plants)
    job = _job_or_404(run["job_id"], allowed_plants, write=True)
    if job["archived"]:
        raise HTTPException(status_code=409, detail="Job is archived")
    if job.get("targets"):
        _409_if_busy(job["id"], run["plant"])
        return _start(job, actor, "restart", {run["plant"]})
    _409_if_busy(job["id"])
    return _start(job, actor, "restart")           # atomic check + insert: 409 when a run became active


@router.post("/jobs/runs/{run_id}/cancel", dependencies=_ADMIN)
def cancel_run(run_id: int, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    run = _run_or_404(run_id, allowed_plants)
    if run["status"] not in ("scheduled", "running"):
        raise HTTPException(status_code=409, detail=f"Run is already {run['status']}")
    return {"run": data.run_to_wire(runner.cancel_run(run_id) or run)}
