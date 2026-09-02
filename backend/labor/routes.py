"""
NIMBUS 2.0 — labor planning domain routes: aggregate (line-group x ISO week)
and line-level (machine x calendar day) available-labor-hours cells.

P5 relocation: pure move from brain.py (lines 3731-3772 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before.
"""
from fastapi import APIRouter, Body, HTTPException, Request

import master_data as md

router = APIRouter()


@router.get("/labor-plan")
def labor_plan_get(plant: str):
    """Return all aggregate labor-plan cells (avail_hours) for the given plant."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    return md.load_labor_plan(plant)


@router.post("/labor-plan")
def labor_plan_post(request: Request, body: dict = Body(default={})):
    """Upsert or delete aggregate labor-plan cells. Payload: { subnetwork, plant, cells:[{wc_group, period, avail_hours}] }"""
    try:
        return md.upsert_labor_plan(
            subnetwork=body.get("subnetwork", ""),
            plant=body.get("plant", ""),
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/labor-plan/line")
def labor_plan_line_get(plant: str, group: str | None = None, from_date: str | None = None, to_date: str | None = None):
    """Return line-level available-hours cells for the given plant, optionally filtered by group and date range."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    return md.load_labor_plan_machine(plant, group=group, from_date=from_date, to_date=to_date)


@router.post("/labor-plan/line")
def labor_plan_line_post(request: Request, body: dict = Body(default={})):
    """Upsert or delete line-level labor cells. Payload: { subnetwork, plant, cells:[{machine, day, avail_hours, source}] }"""
    try:
        return md.upsert_labor_plan_machine(
            subnetwork=body.get("subnetwork", ""),
            plant=body.get("plant", ""),
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
