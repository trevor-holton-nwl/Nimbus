"""
NIMBUS 2.0 — plant calendar domain routes: per-plant/per-line working hours
and blackout blocks. Backend-authoritative store for what used to be
localStorage-only frontend state.

P5 relocation: pure move from brain.py (lines 3785-3867 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Request

import db
import master_data as md
from backend.admin_ops.logbuffer import _log_event, _set_admin_log_details
from backend.security import auth
from backend.security.auth import require_admin, require_api_key, require_authenticated

router = APIRouter()


def _calendar_plant_guard(plant: str, allowed_plants: list[str] | None) -> None:
    """Plant-scope choke point for the planner-writable plant-blackouts route --
    same shape as backend/distribution/routes.py's `_distribution_plant_guard`
    and backend/setup/routes.py's `_setup_plant_guard`. Catch order matters:
    `md._assert_plant_allowed` raises `PlantNotAllowed` for an out-of-scope
    plant and plain `ValueError` for a blank one (checked first), so both must
    be caught or a blank plant escapes as an unhandled 500."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/plant-calendar", dependencies=[Depends(require_authenticated)])
def plant_calendar_get(plant: str):
    """Return a plant's full calendar/blackout config for Store hydration:
    { plant, subnetwork, plant_work_hours, line_work_hours:{line:{0..6}},
      machine_blackouts:[{id, machine, start, end, reason}], plant_blackouts:[...],
      plant_periods:[{id, name, valid_from, valid_to, work_hours}],
      calendar_version: opaque fingerprint of the above (same value GET /tasks/horizons carries) }.
    The browser records calendar_version at hydration as the baseline it later compares with the horizons probe."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        cfg = md.load_plant_calendar(plant)
        # Read after the config so a write landing in between makes the next probe differ (a spurious
        # re-fetch is harmless; a missed change is not).
        try:
            cfg["calendar_version"] = db.plant_calendar_version(plant)
        except Exception as exc:  # noqa: BLE001 - this GET never 500s; None means "no baseline", the browser then skips the probe
            _log_event("warn", "calendar", "plant calendar_version unavailable", exc=exc, plant=plant)
            cfg["calendar_version"] = None
        return cfg
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/plant-hours", dependencies=[Depends(require_api_key), Depends(require_admin)])
def plant_calendar_plant_hours_post(request: Request, body: dict = Body(default={})):
    """Set a plant's weekly working hours. Payload: { plant, work_hours:{0..6:[h1,h2]|null} }."""
    try:
        result = md.set_plant_work_hours(
            plant=body.get("plant", ""),
            work_hours=body.get("work_hours") or {},
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(request, plant=body.get("plant", ""), days_configured=len(body.get("work_hours") or {}))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/line-hours", dependencies=[Depends(require_api_key), Depends(require_admin)])
def plant_calendar_line_hours_post(request: Request, body: dict = Body(default={})):
    """Upsert per-line working hours (batched). Payload:
    { plant, lines:[{machine, work_hours:{0..6:[h1,h2]|null}}] }."""
    try:
        result = md.set_line_work_hours(
            plant=body.get("plant", ""),
            lines=body.get("lines", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(request, plant=body.get("plant", ""), line_count=len(body.get("lines", [])))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/line-blackouts", dependencies=[Depends(require_api_key), Depends(require_admin)])
def plant_calendar_line_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of machine blackouts. Payload:
    { plant, upserts:[{id, machine?, start, end, reason?}], deletes?:[id] }.
    machine omitted/null = all machines in this plant."""
    try:
        result = md.save_machine_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, plant=body.get("plant", ""), upsert_count=len(body.get("upserts", [])),
            delete_count=len(body.get("deletes", [])),
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/plant-blackouts",
             dependencies=[Depends(require_api_key), Depends(require_authenticated)])
def plant_calendar_plant_blackouts_post(request: Request, body: dict = Body(default={}),
                                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Delta write of plant-level blackouts. Payload:
    { plant, upserts:[{id, start, end, reason?}], deletes?:[id] }.
    Planner-writable (any signed-in user whose role_plants scope covers the
    plant); line blackouts, hours and periods stay admin-only."""
    if not isinstance(body.get("plant", ""), str):
        raise HTTPException(status_code=400, detail="plant must be a string")
    _calendar_plant_guard(body.get("plant", ""), allowed_plants)
    try:
        result = md.save_plant_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, plant=body.get("plant", ""), upsert_count=len(body.get("upserts", [])),
            delete_count=len(body.get("deletes", [])),
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/plant-periods", dependencies=[Depends(require_api_key), Depends(require_admin)])
def plant_calendar_plant_periods_post(request: Request, body: dict = Body(default={})):
    """Delta write of effective-dated calendar periods. Payload:
    { plant, upserts:[{id, name?, valid_from, valid_to?, work_hours}], deletes?:[id] }.
    A rejected write answers 400 with detail {code, message, ids}."""
    try:
        result = md.save_plant_periods(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, plant=body.get("plant", ""), upsert_count=len(body.get("upserts", [])),
            delete_count=len(body.get("deletes", [])),
        )
        return result
    except md.PlantPeriodError as e:
        raise HTTPException(status_code=400,
                            detail={"code": e.code, "message": str(e), "ids": e.ids}) from e
    except ValueError as e:
        raise HTTPException(status_code=400,
                            detail={"code": "plant_not_mastered", "message": str(e)}) from e
