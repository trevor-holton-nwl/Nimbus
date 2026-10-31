"""
NIMBUS Alert Monitor routes: plant-shared alert profiles and alert acknowledgements.

HTTP concerns only; persistence and rule validation live in backend/alert_profiles/data.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

import master_data as md
from backend.alert_profiles import data
from backend.security import auth

router = APIRouter()

MAX_REASON_LEN = 200


def _check_plant(plant, allowed_plants) -> None:
    """400 on a missing plant, 403 when it is outside the caller's scope."""
    if not plant or not isinstance(plant, str):
        raise HTTPException(status_code=400, detail="plant is required")
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _is_owner_or_admin(actor: str, owner) -> bool:
    if owner and actor.lower() == str(owner).lower():
        return True
    return auth.get_user_role(actor) == "admin"


def _load_profile_for_write(profile_id: str, actor: str, allowed_plants) -> dict:
    """Fetch the stored row, enforce its plant scope and creator-or-admin edit rights."""
    row = data.get_alert_profile(profile_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Alert profile not found")
    _check_plant(row["plant"], allowed_plants)
    if not _is_owner_or_admin(actor, row["created_by"]):
        raise HTTPException(status_code=403, detail="Only the creator or an admin can change this profile")
    return row


# --------------------------------------------------------------------------- profiles

@router.get("/alert-profiles")
def alert_profiles_list(plant: str = "", allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    _check_plant(plant, allowed_plants)
    return {"plant": plant, "profiles": data.list_alert_profiles(plant)}


@router.post("/alert-profiles", status_code=201)
def alert_profiles_create(
    body: dict = Body(default={}),
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    plant = body.get("plant")
    _check_plant(plant, allowed_plants)
    try:
        return data.create_alert_profile(
            plant=plant, name=body.get("name"), rules=body.get("rules"),
            ranking=body.get("ranking", "impact"), description=body.get("description", ""), actor=actor,
            categories=body.get("categories"),
        )
    except data.DuplicateName as e:
        raise HTTPException(status_code=409, detail="name_taken") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/alert-profiles/{profile_id}")
def alert_profiles_update(
    profile_id: str,
    body: dict = Body(default={}),
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    fields = {k: body[k] for k in ("name", "description", "rules", "ranking", "categories") if k in body}
    if not fields:
        raise HTTPException(status_code=400, detail="No updatable fields supplied")
    _load_profile_for_write(profile_id, actor, allowed_plants)
    try:
        row = data.update_alert_profile(profile_id, actor=actor,
                                        expected_updated_at=body.get("expected_updated_at"), **fields)
    except data.DuplicateName as e:
        raise HTTPException(status_code=409, detail="name_taken") from e
    except ValueError as e:
        if str(e) == "stale":
            raise HTTPException(status_code=409, detail="stale") from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="Alert profile not found")
    return row


@router.delete("/alert-profiles/{profile_id}")
def alert_profiles_delete(
    profile_id: str,
    plant: str = "",
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    # `plant` is accepted for symmetry with the other routes; scope is checked on the stored row.
    _load_profile_for_write(profile_id, actor, allowed_plants)
    if data.delete_alert_profile(profile_id, actor=actor) is None:
        raise HTTPException(status_code=404, detail="Alert profile not found")
    return {"deleted": True, "id": profile_id}


# --------------------------------------------------------------------------- acknowledgements

@router.get("/alert-acks")
def alert_acks_list(plant: str = "", allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    _check_plant(plant, allowed_plants)
    return {"plant": plant, "acks": data.list_alert_acks(plant)}


@router.post("/alert-acks")
def alert_acks_upsert(
    body: dict = Body(default={}),
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    plant = body.get("plant")
    _check_plant(plant, allowed_plants)
    alert_id = body.get("alert_id")
    if not isinstance(alert_id, str) or not alert_id.strip():
        raise HTTPException(status_code=400, detail="alert_id is required")
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise HTTPException(status_code=400, detail="reason is required")
    reason = reason.strip()
    if len(reason) > MAX_REASON_LEN:
        raise HTTPException(status_code=400, detail=f"reason must be at most {MAX_REASON_LEN} characters")
    try:
        return data.upsert_alert_ack(plant=plant, alert_id=alert_id, reason=reason,
                                     until=body.get("until"), actor=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


MAX_BULK_ACK_IDS = 500


@router.post("/alert-acks/bulk")
def alert_acks_bulk(
    body: dict = Body(default={}),
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Acknowledge up to 500 alerts of one plant with one reason/until, in one transaction."""
    plant = body.get("plant")
    _check_plant(plant, allowed_plants)
    alert_ids = body.get("alert_ids")
    if not isinstance(alert_ids, list) or not alert_ids:
        raise HTTPException(status_code=400, detail="alert_ids must be a non-empty list")
    if len(alert_ids) > MAX_BULK_ACK_IDS:
        raise HTTPException(status_code=400, detail=f"alert_ids must have at most {MAX_BULK_ACK_IDS} entries")
    if any(not isinstance(a, str) or not a.strip() for a in alert_ids):
        raise HTTPException(status_code=400, detail="alert_ids must be non-empty strings")
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise HTTPException(status_code=400, detail="reason is required")
    reason = reason.strip()
    if len(reason) > MAX_REASON_LEN:
        raise HTTPException(status_code=400, detail=f"reason must be at most {MAX_REASON_LEN} characters")
    try:
        acks = data.upsert_alert_acks(plant=plant, alert_ids=alert_ids, reason=reason,
                                      until=body.get("until"), actor=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"acks": acks, "count": len(acks)}


@router.delete("/alert-acks/{plant}/{alert_id}")
def alert_acks_delete(
    plant: str,
    alert_id: str,
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    _check_plant(plant, allowed_plants)
    ack = next((a for a in data.list_alert_acks(plant) if a["alert_id"] == alert_id), None)
    if ack is None:
        return {"deleted": False}
    if not _is_owner_or_admin(actor, ack["acknowledged_by"]):
        raise HTTPException(status_code=403, detail="Only the acknowledger or an admin can remove this acknowledgement")
    return {"deleted": data.delete_alert_ack(plant, alert_id, actor=actor)}
