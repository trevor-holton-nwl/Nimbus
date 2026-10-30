"""NIMBUS schedule-event routes: per-order change history (read only).

HTTP concerns only; persistence lives in backend/schedule_events/data.py.
"""
from datetime import datetime

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
    before_id: int | None = Query(None, ge=1, le=9223372036854775807),
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


@router.get("/schedule-events/{plant}/recent", dependencies=[Depends(auth.require_authenticated)])
def schedule_events_recent(
    plant: str,
    response: Response,
    limit: int = Query(50, ge=1, le=200),
    before_id: int | None = Query(None, ge=1, le=9223372036854775807),
    since: str | None = None,
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if since is not None:
        since = since.strip()
        try:
            datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError as e:
            raise HTTPException(status_code=400, detail="since must be an ISO-8601 timestamp") from e
    response.headers["Cache-Control"] = "no-store"
    return data.list_plant_events(plant, limit=limit, before_id=before_id, since=since)
