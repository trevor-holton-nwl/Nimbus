"""
NIMBUS 2.0 — Order Distribution domain routes: SAP aggregate work center <->
NIMBUS per-machine sub-order bridge.

P1 (this file): the FIRST route in this brand-new domain --
`PUT /distribution/{plant}/workcenters/{wc}` -- establishing the guard/
error-handling shape every later route in `backend/distribution/` copies.
Modeled directly on `backend/setup/routes.py` (the `setup_compatible`
precedent aggregate_to_detail.md §4.3 names explicitly):
  - `require_api_key` + `require_admin` dependencies for an admin-gated write.
  - A local `_distribution_plant_guard` that calls `md._assert_plant_allowed`
    and catches `md.PlantNotAllowed` (-> 403) and `ValueError` (-> 400) --
    there is NO global exception handler in this app; every route does this
    itself (see backend/setup/routes.py's `_setup_plant_guard`).
  - A per-route `except ValueError: raise HTTPException(400, ...)` pattern
    for the data-layer's own validation errors, via `_distribution_error`.

No `base_version`/optimistic-concurrency (`xmin`) check on this route --
aggregate_to_detail.md doesn't call for one here (that token belongs to the
`order_distribution` header table, P2+); see data.py's module docstring.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Request

import master_data as md
import backend.distribution.data as distribution_data
from backend.admin_ops.logbuffer import _set_admin_log_details
from backend.distribution.models import WorkCenterSaveResult
from backend.security import auth
from backend.security.auth import require_api_key

router = APIRouter()
require_admin = auth.require_admin


def _distribution_plant_guard(plant: str, allowed_plants: list[str] | None) -> None:
    """Shared plant-scope choke point for this domain's routes -- copied
    verbatim from backend/setup/routes.py's `_setup_plant_guard`. Catch order
    matters: `md._assert_plant_allowed` raises `PlantNotAllowed` for an
    out-of-scope plant and plain `ValueError` for a blank/whitespace one
    (checked first, inside `_assert_plant_allowed`, before the scope check
    ever runs) -- both must be caught here, or a blank plant escapes past a
    `PlantNotAllowed`-only catch as an unhandled 500. This exact regression
    class is why `tests/test_rbac_plant_scoping.py` pins both branches for
    this route."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _distribution_error(exc: ValueError) -> HTTPException:
    """Map a data-layer ValueError to a 400. When the message carries one of
    the §3.1 rule codes (data.py raises `"<rule_code>: <detail>"`), surface a
    structured `{"code": ..., "message": ...}` body so the frontend can key
    UI copy off `code` rather than string-matching `detail`; otherwise (a
    plain "plant is required"-style message) fall back to a bare string
    detail, same as backend/setup/routes.py's `_setup_error` does for its own
    non-stale ValueErrors."""
    message = str(exc)
    code, sep, rest = message.partition(":")
    if sep and code.strip().replace("_", "").isalpha():
        return HTTPException(status_code=400, detail={"code": code.strip(), "message": rest.strip()})
    return HTTPException(status_code=400, detail=message)


@router.put("/distribution/{plant}/workcenters/{wc}", response_model=WorkCenterSaveResult,
           dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                    Depends(require_admin)])
def save_workcenter(plant: str, wc: str, request: Request, body: dict = Body(default={}),
                    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                    actor: str = Depends(auth.require_authenticated)):
    """Create-or-replace one plant's SAP work center policy + member weights
    in a single transaction with an admin_audit row (aggregate_to_detail.md
    §4.3/§7). Body: {description, distribution_mode, default_machine,
    max_separation, review_required, distribute_tooled, weights: {machine: weight}}.
    """
    _distribution_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, sap_workcenter=wc)
    try:
        result = distribution_data.save_workcenter(
            plant, wc, body.get("description"), body.get("distribution_mode"),
            body.get("default_machine"), body.get("max_separation"),
            body.get("review_required"), body.get("distribute_tooled"),
            body.get("weights"), actor,
        )
    except ValueError as exc:
        raise _distribution_error(exc) from exc
    return result
