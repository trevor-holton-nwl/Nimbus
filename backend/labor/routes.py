"""
NIMBUS 2.0 — labor planning domain routes: aggregate (line-group x ISO week)
and line-level (machine x calendar day) available-labor-hours cells.

P5 relocation: pure move from brain.py (lines 3731-3772 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Request

import master_data as md
from backend.security import auth

router = APIRouter()


@router.get("/labor-plan")
def labor_plan_get(plant: str, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Return all aggregate labor-plan cells (avail_hours) for the given plant."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return md.load_labor_plan(plant)


@router.post("/labor-plan", dependencies=[Depends(auth.require_authenticated)])
def labor_plan_post(request: Request, body: dict = Body(default={}), allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Upsert or delete aggregate labor-plan cells. Payload: { subnetwork, plant, cells:[{wc_group, period, avail_hours}] }"""
    plant = body.get("plant", "")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        return md.upsert_labor_plan(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/labor-plan/line")
def labor_plan_line_get(plant: str, group: str | None = None, from_date: str | None = None, to_date: str | None = None, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Return line-level available-hours cells for the given plant, optionally filtered by group and date range."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return md.load_labor_plan_machine(plant, group=group, from_date=from_date, to_date=to_date)


@router.post("/labor-plan/line", dependencies=[Depends(auth.require_authenticated)])
def labor_plan_line_post(request: Request, body: dict = Body(default={}), allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Upsert or delete line-level labor cells. Payload: { subnetwork, plant, cells:[{machine, day, avail_hours, source}] }"""
    plant = body.get("plant", "")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        return md.upsert_labor_plan_machine(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/labor-plan/batch", dependencies=[Depends(auth.require_authenticated)])
def labor_plan_batch_post(
    request: Request, body: dict = Body(default={}),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Save aggregate and line-cell changes in one transaction (also used by Undo)."""
    plant = body.get("plant", "")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
        return md.upsert_labor_plan_batch(
            subnetwork=body.get("subnetwork", ""), plant=plant,
            cells=body.get("cells", []), line_cells=body.get("line_cells", []),
            user_email=request.headers.get("x-user-email"), intent=body.get("intent"),
        )
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
