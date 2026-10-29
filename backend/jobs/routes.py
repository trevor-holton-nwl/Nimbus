"""NIMBUS jobs routes: scheduled job definitions, schedules, runs and run logs.

HTTP concerns only; persistence is backend/jobs/data.py, execution backend/jobs/runner.py. Writes are
require_api_key + require_admin and plant-scoped; reads are require_authenticated scoped by the user's plants.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, ValidationError

import master_data as md
from backend.jobs import data, runner, triggers
from backend.jobs.context import LEVELS
from backend.jobs.registry import get_type, list_types
from backend.security import auth

router = APIRouter()
_BIGINT = 9223372036854775807
_GRACE = timedelta(minutes=1)
_ADMIN = [Depends(auth.require_api_key), Depends(auth.require_admin)]
_STATUSES = ("scheduled", "running", "succeeded", "warning", "failed", "cancelled", "skipped", "missed")
PROPOSAL_ROW_CAP = 200


# ----------------------------------------------------------------------------------------------- request bodies
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


class SchedulePatch(BaseModel):
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


class JobPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    params: dict | None = None
    enabled: bool | None = None
    archived: bool | None = None
    retry_max: int | None = Field(None, ge=0, le=5)
    timeout_s: int | None = Field(None, ge=10, le=21600)


class PreviewIn(ScheduleIn):
    plant: str
    n: int = Field(5, ge=1, le=20)


# ------------------------------------------------------------------------------------------------------ helpers
def _check_plant(plant: str, allowed) -> None:
    try:
        md._assert_plant_allowed(plant, allowed)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _job_or_404(job_id: int, allowed) -> dict:
    job = data.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    _check_plant(job["plant"], allowed)
    return job


def _normalize(plant: str, payload: dict, *, check_past: bool = True, need_tz: bool = False) -> dict:
    """Validate a schedule payload against the plant timezone; ScheduleError becomes a 400. `need_tz`: the job type
    cannot run without a plant timezone (the optimizer), so a schedule for such a plant is refused up front."""
    if need_tz and not data.plant_has_timezone(plant):
        raise HTTPException(status_code=400, detail=f"plant {plant!r} has no timezone; set one in Plants before scheduling this job")
    try:
        s = triggers.validate_schedule({**payload, "timezone": data.plant_timezone(plant)})
        if check_past and s["kind"] == "once":
            tz = triggers.get_zone(s["timezone"])
            if s["run_at"].replace(tzinfo=tz) < datetime.now(timezone.utc) - _GRACE:
                raise triggers.ScheduleError("run_at is in the past")
    except triggers.ScheduleError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return s



def _needs_tz(job: dict) -> bool:
    from backend.jobs.registry import REGISTRY
    jt = REGISTRY.get(job["job_type"])
    return bool(jt and jt.needs_plant_timezone)


def _timing_fields(model: BaseModel) -> dict:
    return {k: v for k, v in model.model_dump(exclude_unset=True).items()
            if k in ("kind", "time_of_day", "days_of_week", "day_of_month", "cron_expr", "run_at",
                     "valid_from", "valid_until")}


def _flags(model: BaseModel) -> dict:
    return {k: v for k, v in model.model_dump(exclude_unset=True).items()
            if k in ("paused", "retired", "misfire_grace_s", "skip_if_running") and v is not None}


def _next_run(job: dict) -> dict | None:
    if not job["enabled"] or job["archived"]:
        return None
    best = None
    for s in job["schedules"]:
        if s["paused"]:
            continue
        try:
            fires = triggers.next_fire_times(s, 1)
        except Exception:  # noqa: BLE001 - a broken row must not break the list
            continue
        if fires and (best is None or fires[0] < best[0]):
            best = (fires[0], s["id"])
    if best is None:
        return None
    t, sid = best
    return {"at_utc": t.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "at_local": t.isoformat(timespec="seconds"), "schedule_id": sid}


def _job_wire(job: dict) -> dict:
    w = data.definition_to_wire(job)
    w["schedules"] = [data.schedule_to_wire(s) for s in job["schedules"]]
    nxt = _next_run(job)
    w["next_run_at"] = nxt["at_utc"] if nxt else None
    w["next_run_local"] = nxt["at_local"] if nxt else None
    last = job.get("last_run")
    w["last_run"] = data.run_to_wire(last) if last else None
    return w


def _validate_params(jt, params: dict) -> dict:
    try:
        return jt.params_model.model_validate(params or {}).model_dump(mode="json")
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=f"invalid params: {e.errors(include_url=False)}") from e


# ----------------------------------------------------------------------------------------------------- types
@router.get("/jobs/types", dependencies=[Depends(auth.require_authenticated)])
def job_types(response: Response):
    response.headers["Cache-Control"] = "no-store"
    out = []
    for jt in list_types():
        out.append({"key": jt.key, "label": jt.label, "plant_scoped": jt.plant_scoped,
                    "default_timeout_s": jt.default_timeout_s, "stub": jt.stub,
                    "params_schema": jt.params_model.model_json_schema(),
                    "defaults": jt.params_model().model_dump(mode="json")})
    return {"types": out}


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
    return {"jobs": [_job_wire(j) for j in page["jobs"]], "next_before_id": page["next_before_id"]}


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
            "scheduler": scheduler.heartbeat()}


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
    for s in data.next_fire_schedules(allowed_plants=allowed_plants, plant=plant):
        try:
            fires = triggers.preview(s, n)
        except Exception:  # noqa: BLE001 - a broken row must not break the strip
            continue
        entries += [{**e, "job_id": s["job_id"], "job_name": s["job_name"], "plant": s["plant"],
                     "schedule_id": s["id"], "timezone": s["timezone"]} for e in fires]
    entries.sort(key=lambda e: e["at_utc"])
    return entries


def _job_upcoming(job: dict, n: int) -> list[dict]:
    out = []
    if not job["enabled"] or job["archived"]:
        return out
    for s in job["schedules"]:
        if s["paused"]:
            continue
        for e in triggers.preview(s, n):
            out.append({**e, "job_id": job["id"], "job_name": job["name"], "plant": job["plant"],
                        "schedule_id": s["id"], "timezone": s["timezone"]})
    out.sort(key=lambda e: e["at_utc"])
    return out[:n]


@router.get("/jobs/{job_id}/upcoming", dependencies=[Depends(auth.require_authenticated)])
def upcoming_for_job(job_id: int, response: Response, n: int = Query(5, ge=1, le=50),
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants)
    response.headers["Cache-Control"] = "no-store"
    return {"job_id": job_id, "entries": _job_upcoming(job, n)}


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
    schedules = [{**_normalize(body.plant, _timing_fields(s), need_tz=jt.needs_plant_timezone), "paused": s.paused,
                  "misfire_grace_s": s.misfire_grace_s, "skip_if_running": s.skip_if_running}
                 for s in body.schedules]
    job_id = data.create_job(plant=body.plant, job_type=body.job_type, name=body.name.strip(), params=params,
                             enabled=body.enabled, retry_max=body.retry_max, timeout_s=body.timeout_s,
                             schedules=schedules, actor=actor)
    return _job_wire(data.get_job(job_id))


@router.patch("/jobs/{job_id}", dependencies=_ADMIN)
def patch_job(job_id: int, body: JobPatch, actor: str | None = Depends(auth.require_admin),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants)
    fields = body.model_dump(exclude_unset=True)
    if fields.get("params") is not None:
        jt = get_type(job["job_type"]) or _registered(job["job_type"])
        # Merge over the stored params: a partial PATCH must not reset an omitted key (an old dry run's
        # apply_mode) to the model default.
        fields["params"] = _validate_params(jt, {**(job["params"] or {}), **fields["params"]})
    elif "params" in fields:
        fields.pop("params")
    for k in ("name", "enabled", "archived", "retry_max"):
        if k in fields and fields[k] is None:
            fields.pop(k)
    data.patch_job(job_id, fields, actor)
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
    job = _job_or_404(job_id, allowed_plants)
    s = {**_normalize(job["plant"], _timing_fields(body), need_tz=_needs_tz(job)), "paused": body.paused,
         "misfire_grace_s": body.misfire_grace_s, "skip_if_running": body.skip_if_running}
    sid = data.add_schedule(job_id, s, actor)
    return data.schedule_to_wire(data.get_schedule(sid))


@router.patch("/jobs/schedules/{schedule_id}", dependencies=_ADMIN)
def patch_schedule(schedule_id: int, body: SchedulePatch, actor: str | None = Depends(auth.require_admin),
                   allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    cur = data.get_schedule(schedule_id)
    if cur is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    job = _job_or_404(cur["job_id"], allowed_plants)
    timing = _timing_fields(body)
    normalized = None
    if timing:
        merged = {k: cur[k] for k in ("kind", "time_of_day", "days_of_week", "day_of_month", "cron_expr", "run_at",
                                      "valid_from", "valid_until")}
        if "kind" in timing and timing["kind"] != cur["kind"]:
            merged = {"kind": timing["kind"]}          # a kind change starts clean; stale fields never leak
        merged.update(timing)
        normalized = _normalize(job["plant"], merged, check_past="run_at" in timing or "kind" in timing,
                                need_tz=_needs_tz(job))
    data.patch_schedule(schedule_id, normalized, _flags(body), actor)
    return data.schedule_to_wire(data.get_schedule(schedule_id))


@router.post("/jobs/schedules/preview", dependencies=[Depends(auth.require_authenticated)])
def preview_schedule(body: PreviewIn, response: Response,
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Next-N fire times for an unsaved schedule, from the same trigger the scheduler arms."""
    _check_plant(body.plant, allowed_plants)
    s = _normalize(body.plant, _timing_fields(body), check_past=False)
    response.headers["Cache-Control"] = "no-store"
    return {"timezone": s["timezone"], "cron_expr": s["cron_expr"], "entries": triggers.preview(s, body.n)}


@router.post("/jobs/{job_id}/run", dependencies=_ADMIN)
def run_now(job_id: int, actor: str | None = Depends(auth.require_admin),
            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    job = _job_or_404(job_id, allowed_plants)
    if job["archived"]:
        raise HTTPException(status_code=409, detail="Job is archived")
    if data.has_active_run(job_id):
        raise HTTPException(status_code=409, detail="A run of this job is already scheduled or running")
    run_id = runner.start_manual_run(job, actor)
    if run_id is None:
        raise HTTPException(status_code=409, detail="A run of this job is already scheduled or running")
    return {"run": data.run_to_wire(data.get_run(run_id))}


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


@router.post("/jobs/runs/{run_id}/restart", dependencies=_ADMIN)
def restart_run(run_id: int, actor: str | None = Depends(auth.require_admin),
                allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Run the same job again with its current params, as a manual run (the old run is left as it was)."""
    run = _run_or_404(run_id, allowed_plants)
    job = _job_or_404(run["job_id"], allowed_plants)
    if job["archived"]:
        raise HTTPException(status_code=409, detail="Job is archived")
    if data.has_active_run(job["id"]):
        raise HTTPException(status_code=409, detail="A run of this job is already scheduled or running")
    new_id = runner.start_manual_run(job, actor)           # atomic check + insert: None = a run became active
    if new_id is None:
        raise HTTPException(status_code=409, detail="A run of this job is already scheduled or running")
    return {"run": data.run_to_wire(data.get_run(new_id))}


@router.post("/jobs/runs/{run_id}/cancel", dependencies=_ADMIN)
def cancel_run(run_id: int, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    run = _run_or_404(run_id, allowed_plants)
    if run["status"] not in ("scheduled", "running"):
        raise HTTPException(status_code=409, detail=f"Run is already {run['status']}")
    return {"run": data.run_to_wire(runner.cancel_run(run_id) or run)}
