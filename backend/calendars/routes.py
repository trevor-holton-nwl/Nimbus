"""
NIMBUS 2.0 — plant calendar domain routes: per-plant/per-line working hours
and blackout blocks. Backend-authoritative store for what used to be
localStorage-only frontend state.

P5 relocation: pure move from brain.py (lines 3785-3867 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Request

import master_data as md
from backend.admin_ops.logbuffer import _set_admin_log_details
from backend.security.auth import require_admin, require_authenticated

router = APIRouter()


@router.get("/plant-calendar", dependencies=[Depends(require_authenticated)])
def plant_calendar_get(plant: str):
    """Return a plant's full calendar/blackout config for Store hydration:
    { plant, subnetwork, plant_work_hours, line_work_hours:{line:{0..6}},
      machine_blackouts:[{id, machine, start, end, reason}], plant_blackouts:[...] }."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        return md.load_plant_calendar(plant)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/plant-calendar/plant-hours", dependencies=[Depends(require_admin)])
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


@router.post("/plant-calendar/line-hours", dependencies=[Depends(require_admin)])
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


@router.post("/plant-calendar/line-blackouts", dependencies=[Depends(require_admin)])
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


@router.post("/plant-calendar/plant-blackouts", dependencies=[Depends(require_admin)])
def plant_calendar_plant_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of plant-level blackouts. Payload:
    { plant, upserts:[{id, start, end, reason?}], deletes?:[id] }."""
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
