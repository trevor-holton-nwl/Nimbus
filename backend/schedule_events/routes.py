"""NIMBUS schedule-event routes: per-order change history (read only).

HTTP concerns only; persistence lives in backend/schedule_events/data.py.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response

import master_data as md
from backend.schedule_events import data
from backend.security import auth

router = APIRouter()


@router.get("/schedule-events/{plant}/order/{order_id}", dependencies=[Depends(auth.require_authenticated)])
def schedule_events_for_order(
    plant: str,
    order_id: str,
    response: Response,
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None, ge=1),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    response.headers["Cache-Control"] = "no-store"
    return data.list_order_events(plant, order_id, limit=limit, before_id=before_id)
