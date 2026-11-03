"""
NIMBUS Alert Monitor routes: plant-shared alert profiles and alert acknowledgements.

HTTP concerns only; persistence and rule validation live in backend/alert_profiles/data.py.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

import master_data as md
from backend.alert_profiles import data
from backend.security import auth

router = APIRouter()


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


def _is_admin(actor: str) -> bool:
    return auth.get_user_role(actor) == "admin"


def _is_owner_or_admin(actor: str, owner) -> bool:
    if owner and actor.lower() == str(owner).lower():
        return True
    return _is_admin(actor)


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
            categories=body.get("categories"), gantt_colors=body.get("gantt_colors", True),
            show_acknowledged=body.get("show_acknowledged", False),
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
    # A null name/description/rules/ranking/flag means "not supplied"; only `categories: null` is meaningful (revert).
    fields = {k: body[k] for k in ("name", "description", "rules", "ranking", "categories", "gantt_colors",
                                   "show_acknowledged") if k in body and (k == "categories" or body[k] is not None)}
    if not fields:
        raise HTTPException(status_code=400, detail="No updatable fields supplied")
    expected = body.get("expected_updated_at")
    if not isinstance(expected, str) or not expected.strip():
        raise HTTPException(status_code=400, detail="expected_updated_at is required")
    _load_profile_for_write(profile_id, actor, allowed_plants)
    try:
        row = data.update_alert_profile(profile_id, actor=actor, expected_updated_at=expected, **fields)
    except data.DuplicateName as e:
        raise HTTPException(status_code=409, detail="name_taken") from e
    except data.StaleProfile as e:
        raise HTTPException(status_code=409, detail="stale") from e
    except ValueError as e:
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
    """Acknowledge one alert. Changing someone else's active ack is owner-or-admin only (403)."""
    plant = body.get("plant")
    _check_plant(plant, allowed_plants)
    try:
        alert_id = data.validate_alert_id(body.get("alert_id"))
        reason = data.validate_reason(body.get("reason"))
        return data.upsert_alert_ack(plant=plant, alert_id=alert_id, reason=reason, until=body.get("until"),
                                     actor=actor, is_admin=_is_admin(actor))
    except data.AckNotOwner as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/alert-acks/bulk")
def alert_acks_bulk(
    body: dict = Body(default={}),
    actor: str = Depends(auth.require_authenticated),
    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
):
    """Acknowledge up to 500 alerts of one plant with one reason/until, in one transaction. 403 (nothing written)
    when any of them is already acknowledged by someone else and the caller is not an admin."""
    plant = body.get("plant")
    _check_plant(plant, allowed_plants)
    try:
        alert_ids = data.validate_alert_ids(body.get("alert_ids"))
        reason = data.validate_reason(body.get("reason"))
        acks = data.upsert_alert_acks(plant=plant, alert_ids=alert_ids, reason=reason, until=body.get("until"),
                                      actor=actor, is_admin=_is_admin(actor))
    except data.AckNotOwner as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
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
    """{deleted: false} when there is no active ack; 403 when it is someone else's and the caller is not an admin."""
    _check_plant(plant, allowed_plants)
    try:
        return {"deleted": data.delete_alert_ack(plant, alert_id, actor=actor, is_admin=_is_admin(actor))}
    except data.AckNotOwner as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
