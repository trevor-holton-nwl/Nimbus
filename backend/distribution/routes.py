"""
NIMBUS 2.0 — Order Distribution domain routes: SAP aggregate work center <->
NIMBUS per-machine sub-order bridge.

P1: the FIRST route in this brand-new domain --
`PUT /distribution/{plant}/workcenters/{wc}` -- established the guard/
error-handling shape every later route in `backend/distribution/` copies.
Modeled directly on `backend/setup/routes.py` (the `setup_compatible`
precedent aggregate_to_detail.md §4.3 names explicitly):
  - `require_api_key` + `require_admin` dependencies for an admin-gated write.
  - A local `_distribution_plant_guard` that calls `md._assert_plant_allowed`
    and catches `md.PlantNotAllowed` (-> 403) and `ValueError` (-> 400) --
    there is NO global exception handler in this app for THAT choice (403 vs
    400); every route does it itself (see backend/setup/routes.py's
    `_setup_plant_guard`). `brain.py` DOES have a global handler that reshapes
    whatever HTTPException a route raises into the app's `{status, message,
    detail}` envelope -- see the note on `_distribution_conflict` below about
    a bug in that reshaping this session fixed.
  - A per-route `except ValueError: raise HTTPException(400, ...)` pattern
    for the data-layer's own validation errors, via `_distribution_error`.

No `base_version`/optimistic-concurrency (`xmin`) check on `save_workcenter` --
aggregate_to_detail.md doesn't call for one there (that token belongs to the
`order_distribution` header table; see data.py's module docstring).

P2-6/P2-7 added the five read-only routes. P2-8/P2-9 (below) added the three
planner writes (`shares`/`review`/`reset`, `require_api_key + require_authenticated`
+ plant scope, deliberately NOT admin-gated) and two admin writes
(`reapply-defaults`/`resolve`, admin-gated like `save_workcenter`) -- all five
are thin route-level wiring over `backend/distribution/data.py`'s
`reweight_shares`/`review_orders`/`reset_orders`/`reapply_defaults`/`resolve`,
which do the actual validation/materialization/writing.
"""
import csv
import io
from datetime import datetime, time

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response

import master_data as md
import backend.distribution.data as distribution_data
from backend.admin_ops.logbuffer import _log_event, _set_admin_log_details
from backend.csv_util import CSV_BOM, csv_row
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
    if result.get("auto_linked"):
        # The save linked the same-named machine, which changes its routing mapping:
        # recompute the plant like a machine write does (best-effort; the save committed).
        try:
            import backend.routing.resolver as routing_resolver  # deferred: cross-domain
            routing_resolver.resolve_orders(plant)
        except Exception as exc:  # noqa: BLE001
            _log_event("warn", "routing", "Recompute after work-center auto-link failed", plant=plant, error=str(exc))
    return result


# =====================================================================
# P2-6/P2-7 -- read routes (aggregate_to_detail.md §7's API table)
# =====================================================================
#
# Every response here is `Cache-Control: no-store` (§7: "the corporate proxy
# caches by URL") -- set via `_no_store` on the injected `Response`, never
# relying on a default. All five are `require_authenticated` + plant scope
# only, per §7's guard column -- no `require_api_key`/`require_admin` (those
# are reserved for the planner/admin WRITE routes, §11).

def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _parse_iso_date(value: str | None, field: str, *, end_of_day: bool = False) -> datetime | None:
    """`from`/`to` query params -- naive plant-local wall-clock timestamps,
    same convention `basic_start_date` itself is stored under (no further tz
    conversion, matching `_horizon_boundary_core`'s documented convention);
    an explicit offset in the input is simply dropped, not converted.

    D57: a date-only `to=YYYY-MM-DD` means midnight, so orders starting later
    that same day were silently dropped from the filter. `end_of_day=True`
    (used for `to` on the list/aggregate routes only) widens a date-only
    input to that day's last instant; an input that already carries a time
    component is left exactly as given."""
    if value is None or not value.strip():
        return None
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field} must be an ISO date/datetime") from exc
    parsed = parsed.replace(tzinfo=None) if parsed.tzinfo is not None else parsed
    if end_of_day and "T" not in raw and " " not in raw:
        return datetime.combine(parsed.date(), time.max)
    return parsed


@router.get("/distribution/{plant}", dependencies=[Depends(auth.require_authenticated)])
def list_distribution(
        plant: str, response: Response,
        search: str | None = Query(default=None),
        workcenter: str | None = Query(default=None),
        machines: str | None = Query(default=None),
        reviewed: bool | None = Query(default=None),
        status: str | None = Query(default=None),
        bucket: str | None = Query(default=None),
        batch: str | None = Query(default=None),
        from_: str | None = Query(default=None, alias="from"),
        to_: str | None = Query(default=None, alias="to"),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Paged (default 50/page) list of a plant's order_distribution headers,
    each with its shares, derived statuses, and a children summary (§6
    "Data", §7). `bucket` (or its `status` alias -- both accepted, same
    values) takes `all`, one of the three §6 buckets, or an individual
    status code directly, for deep links."""
    _distribution_plant_guard(plant, allowed_plants)
    _no_store(response)
    machine_list = [m.strip() for m in machines.split(",") if m.strip()] if machines else None
    date_from = _parse_iso_date(from_, "from")
    date_to = _parse_iso_date(to_, "to", end_of_day=True)
    return distribution_data.list_headers_for_plant(
        plant, search=search, workcenter=workcenter, machines=machine_list,
        reviewed=reviewed, bucket=(bucket or status), batch=batch,
        date_from=date_from, date_to=date_to, limit=limit, offset=offset,
    )


@router.get("/distribution/{plant}/summary", dependencies=[Depends(auth.require_authenticated)])
def get_distribution_summary(plant: str, response: Response,
                             allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """`{needs_review, changed, problems}` counts over the plant's headers,
    using the SAME bucket definitions the list route's `bucket` filter uses
    (`backend.distribution.data.classify_bucket_membership`) so the two can
    never drift apart (§7)."""
    _distribution_plant_guard(plant, allowed_plants)
    _no_store(response)
    return distribution_data.get_summary(plant)


@router.get("/distribution/{plant}/aggregate", dependencies=[Depends(auth.require_authenticated)])
def get_distribution_aggregate(
        plant: str, response: Response,
        workcenter: str | None = Query(default=None),
        from_: str | None = Query(default=None, alias="from"),
        to_: str | None = Query(default=None, alias="to"),
        format: str | None = Query(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """§10.2 roll-up: one row per header, built from `db._EFF_END_SQL` /
    `db._SCHEDULE_SEGMENTS_LATERAL_SQL` so this can never drift from how the
    Gantt/task read path computes effective start/end (see data.py's
    `get_aggregate` docstring). `?format=csv` exports the same columns, one
    row per header, with `children` flattened into a semicolon-joined
    `production_order|machine|quantity|start|end` summary column --
    aggregate_to_detail.md §10.2 does not pin a CSV shape, so this is the
    chosen default (see backend/distribution/CLAUDE.md)."""
    _distribution_plant_guard(plant, allowed_plants)
    _no_store(response)
    date_from = _parse_iso_date(from_, "from")
    date_to = _parse_iso_date(to_, "to", end_of_day=True)
    rows = distribution_data.get_aggregate(plant, workcenter=workcenter, date_from=date_from, date_to=date_to)
    if format == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        buf.write(CSV_BOM)
        writer.writerow(["production_order", "material_number", "machine", "quantity",
                         "sum_child_quantity", "start", "finish", "child_count",
                         "queued_children", "all_scheduled", "firming_indicator", "reviewed", "children",
                         "due_date"])
        for r in rows:
            children_summary = "; ".join(
                f"{c['production_order']}|{c['machine']}|{c['quantity']}|{c['start'] or ''}|{c['end'] or ''}"
                for c in r["children"]
            )
            writer.writerow(csv_row([r["production_order"], r["material_number"], r["machine"], r["quantity"],
                                     r["sum_child_quantity"], r["start"] or "", r["finish"] or "", r["child_count"],
                                     r["queued_children"], r["all_scheduled"], r["firming_indicator"], r["reviewed"],
                                     children_summary, r.get("due_date") or ""]))
        headers = {"Content-Disposition": f'attachment; filename="distribution-aggregate-{plant}.csv"',
                  "Cache-Control": "no-store"}
        return Response(content=buf.getvalue(), media_type="text/csv", headers=headers)
    return {"data": rows}


@router.get("/distribution/{plant}/unresolved", dependencies=[Depends(auth.require_authenticated)])
def get_distribution_unresolved(plant: str, response: Response,
                                allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Plain orders whose `machine` matches no current `machine` row in the
    plant -- the analogue of `db.missing_master_data_for_plant` (`db.py:2209`)."""
    _distribution_plant_guard(plant, allowed_plants)
    _no_store(response)
    return distribution_data.get_unresolved(plant)


@router.get("/distribution/{plant}/{order}/{material}", dependencies=[Depends(auth.require_authenticated)])
def get_distribution_detail(plant: str, order: str, material: str, response: Response,
                            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """One header's full detail -- header, shares (with `child_id`, current
    child live quantity/hours/start, stale/purged/below-min-lot flags),
    derived statuses, and `base_version` (the header's xmin)."""
    _distribution_plant_guard(plant, allowed_plants)
    _no_store(response)
    result = distribution_data.get_header_detail(plant, order, material)
    if result is None:
        raise HTTPException(status_code=404, detail="Order distribution header not found")
    return result


# =====================================================================
# P2-8/P2-9 -- planner writes (shares/review/reset) + admin writes
# (reapply-defaults/resolve), aggregate_to_detail.md SS5.5-SS5.7 / SS7.
#
# Planner writes: `require_api_key + require_authenticated` + plant scope --
# the setup-write precedent (backend/setup/routes.py's `save_setup_line_state`
# etc.), NOT `require_admin` (SS7: "All three planner writes use the
# identical guard set"). Admin writes add `require_admin` on top, following
# the same `require_api_key + require_authenticated + require_admin` shape
# `save_workcenter` above and every admin route in backend/setup/routes.py use.
# =====================================================================

_MAX_BULK_ORDERS = 500


def _require_base_version(value) -> int:
    """D18: `base_version` must be present and an actual `int` -- `bool` is a
    Python `int` subclass, so `isinstance(value, bool)` is checked first and
    rejected too. Missing/null/boolean all return the same structured 400;
    `reapply-defaults` (an admin bulk sweep, not an edit against a
    client-held header version) never calls this."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise HTTPException(status_code=400, detail={
            "code": "base_version_required",
            "message": "base_version is required and must be an integer",
        })
    return value


def _validate_bulk_orders(orders, *, required: bool = True, max_items: int = _MAX_BULK_ORDERS) -> list[dict] | None:
    """D20 shared validator for the `orders[]` body every bulk distribution
    write (review/reset/reapply-defaults) takes: caps the list at
    `max_items` and checks each item is a dict with string
    `production_order`/`material_number` -- malformed input is rejected here
    with a 400, instead of reaching data.py and surfacing as an unhandled
    500. `required=False` (reapply-defaults only) allows `orders` to be
    omitted/`None` entirely (meaning "sweep every matching header")."""
    if orders is None and not required:
        return None
    if not isinstance(orders, list) or (required and not orders):
        raise HTTPException(status_code=400, detail="orders must be a non-empty list")
    if len(orders) > max_items:
        raise HTTPException(status_code=400, detail={
            "code": "too_many_orders",
            "message": f"orders must not exceed {max_items} items",
        })
    for item in orders:
        if (not isinstance(item, dict)
                or not isinstance(item.get("production_order"), str)
                or not isinstance(item.get("material_number"), str)):
            raise HTTPException(
                status_code=400,
                detail="each order item must include production_order and material_number",
            )
    return orders


def _distribution_conflict(exc) -> HTTPException:
    """Structured 409 body for the two named conflicts SS5.5 defines --
    `stale` (base_version mismatch) and `children_scheduled` (a destructive
    removal without `confirm_remove_scheduled`), mirroring `_distribution_error`'s
    `{code, message}` shape for 400s."""
    if isinstance(exc, distribution_data.DistributionStaleVersion):
        return HTTPException(status_code=409, detail={
            "code": "stale", "message": "This distribution was changed since you loaded it.",
            "base_version": exc.base_version,
        })
    return HTTPException(status_code=409, detail={
        "code": "children_scheduled",
        "message": "Removing these shares would discard scheduled sub-orders.",
        "children": exc.children,
    })


@router.post("/distribution/{plant}/{order}/{material}/shares",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated)])
def save_distribution_shares(plant: str, order: str, material: str, request: Request,
                             body: dict = Body(default={}),
                             allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                             actor: str = Depends(auth.require_authenticated)):
    """Planner re-weight (SS5.5). Body: `{shares:[{machine, weight}],
    base_version, reviewed?, allow_stale?, confirm_remove_scheduled?,
    dry_run?}`. `dry_run: true` runs the identical materialization and
    returns the SS5.5 step 8 preview (`{plan, removed_scheduled,
    base_version}`) without writing; otherwise `{status, children, removed,
    previous_shares, versions, base_version}`."""
    _distribution_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, production_order=order, material_number=material)
    base_version = _require_base_version(body.get("base_version"))
    dry_run = bool(body.get("dry_run"))
    try:
        result = distribution_data.reweight_shares(
            plant, order, material, body.get("shares"), base_version,
            reviewed=body.get("reviewed"), allow_stale=bool(body.get("allow_stale")),
            confirm_remove_scheduled=bool(body.get("confirm_remove_scheduled")),
            dry_run=dry_run, actor=actor,
        )
    except distribution_data.DistributionHeaderNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (distribution_data.DistributionStaleVersion, distribution_data.DistributionChildrenScheduled) as exc:
        raise _distribution_conflict(exc) from exc
    except ValueError as exc:
        raise _distribution_error(exc) from exc
    if not dry_run:
        _set_admin_log_details(request, children=len(result.get("children", [])),
                               removed=len(result.get("removed", [])))
    return result


@router.post("/distribution/{plant}/review",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated)])
def review_distribution_orders(plant: str, request: Request, body: dict = Body(default={}),
                               allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                               actor: str = Depends(auth.require_authenticated)):
    """Bulk review acknowledgement (SS5.5/SS7). Body: `{orders:[{production_order,
    material_number, base_version}], reviewed}` -> per-item results; does NOT
    clear `sap_facts.previous_workcenter` (SS5.7 -- that needs a materializing
    re-weight or reset)."""
    _distribution_plant_guard(plant, allowed_plants)
    orders = _validate_bulk_orders(body.get("orders"))
    reviewed = body.get("reviewed")
    if not isinstance(reviewed, bool):
        # D20: a missing/non-bool `reviewed` used to silently un-review
        # (bool(None) == False) -- require it explicitly instead.
        raise HTTPException(status_code=400, detail={
            "code": "reviewed_required",
            "message": "reviewed is required and must be a boolean",
        })
    for item in orders:
        _require_base_version(item.get("base_version"))
    _set_admin_log_details(request, plant=plant, count=len(orders), reviewed=reviewed)
    result = distribution_data.review_orders(plant, orders, reviewed, actor=actor)
    return result


@router.post("/distribution/{plant}/reset",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated)])
def reset_distribution_orders(plant: str, request: Request, body: dict = Body(default={}),
                              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                              actor: str = Depends(auth.require_authenticated)):
    """Bulk reset-to-work-center-defaults (SS5.2 precedence, `source =
    'default'`). Body: `{orders:[{production_order, material_number,
    base_version}], confirm_remove_scheduled?, dry_run?}` -> per-item
    results, same shape `shares` returns per item (or `dry_run`'s preview
    shape per item)."""
    _distribution_plant_guard(plant, allowed_plants)
    orders = _validate_bulk_orders(body.get("orders"))
    for item in orders:
        _require_base_version(item.get("base_version"))
    _set_admin_log_details(request, plant=plant, count=len(orders))
    result = distribution_data.reset_orders(
        plant, orders, confirm_remove_scheduled=bool(body.get("confirm_remove_scheduled")),
        dry_run=bool(body.get("dry_run")), actor=actor,
    )
    return result


@router.post("/distribution/{plant}/reapply-defaults",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def reapply_distribution_defaults(plant: str, request: Request, body: dict = Body(default={}),
                                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                                  actor: str = Depends(auth.require_authenticated)):
    """Admin bulk sweep (SS7): re-applies SS5.2's default-share precedence to
    every matching `NOT reviewed` header (or an explicit `orders` list),
    bumping `xmin` plant-wide the same way `POST /master-data/resync-order-attributes`
    does. Body: `{workcenter?, orders?, only_unreviewed: true,
    confirm_remove_scheduled?}` -> counts."""
    _distribution_plant_guard(plant, allowed_plants)
    orders = _validate_bulk_orders(body.get("orders"), required=False)
    _set_admin_log_details(request, plant=plant, workcenter=body.get("workcenter"))
    try:
        result = distribution_data.reapply_defaults(
            plant, workcenter=body.get("workcenter"), orders=orders,
            only_unreviewed=body.get("only_unreviewed", True),
            confirm_remove_scheduled=bool(body.get("confirm_remove_scheduled")), actor=actor,
        )
    except ValueError as exc:
        raise _distribution_error(exc) from exc
    _set_admin_log_details(request, **result)
    return result


@router.post("/distribution/{plant}/resolve",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def resolve_distribution_orders(plant: str, request: Request, body: dict = Body(default={}),
                                allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                                actor: str = Depends(auth.require_authenticated)):
    """Admin recovery/backfill sweep (SS5.6). Body: `{scope: 'wc_codes' |
    'machines' | 'repair', workcenter?, dry_run?}` -> `{headers_created,
    children_upserted, single_rewrites, repaired, skipped}`."""
    _distribution_plant_guard(plant, allowed_plants)
    scope = body.get("scope") or "wc_codes"
    _set_admin_log_details(request, plant=plant, scope=scope, workcenter=body.get("workcenter"))
    try:
        result = distribution_data.resolve(
            plant, scope, workcenter=body.get("workcenter"), dry_run=bool(body.get("dry_run")), actor=actor,
        )
    except ValueError as exc:
        raise _distribution_error(exc) from exc
    _set_admin_log_details(request, **result)
    return result
