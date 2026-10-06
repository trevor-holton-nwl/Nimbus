"""
NIMBUS 2.0 -- Routing / Production Version domain routes.

P1 (data foundation) slice of ROUTING_RUNTIME_DESIGN.md shipped the two
Excel upload endpoints only (§6). P2 (this pass) adds `resolver.py`'s real
§5 logic, `POST /routing/{plant}/recompute` (§6's own route table), and the
recompute hook after each upload -- via a DEFERRED import
(`import backend.routing.resolver as routing_resolver` inside each function,
never at module scope), matching the existing `backend.distribution.data`
deferred-import convention (see db.py's `upsert_orders`/`sap_sync.py`).
The generic-grid hook (after `POST /master-data/{table}/bulk` and
`POST /master-data/{table}/delete-filtered`) lives in
`backend/master_data/routes.py` instead, extending that file's existing
post-write `machine` block -- see that file for the other half of §6.4.

Modeled on `backend/integration/routes.py`'s `/upload`/`/bom/upload`
(`async def`, `UploadFile = File(...)`, a size cap, the blocking parse/write
offloaded to a worker thread via `run_in_threadpool` so it doesn't block the
event loop) -- the closest existing precedent for "receive an .xlsx, upsert
master data, report {inserted, updated, rejected, warnings}".
"""
import os

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from psycopg import sql
from psycopg.types.json import Jsonb

import db
import master_data as md
import backend.routing.ingest as ingest
from backend.admin_ops.logbuffer import _log_event, _set_admin_log_details
from backend.routing.models import RoutingUploadResult
from backend.security import auth
from backend.security.auth import require_admin, require_api_key

router = APIRouter()


def _recompute_after_write(plants: list[str]) -> None:
    """§6.4's recompute hook, upload-route half: after a committed write to
    `production_version`/`routing_operation` touches one or more plants,
    resolve each of them. DEFERRED import -- resolver.py is a sibling
    module in this same package, but the deferred-import convention this
    task was told to match (`backend.distribution.data`'s) is about NEVER
    importing a heavier, potentially-cyclic module at module scope; applied
    here for consistency even though there's no actual cycle risk between
    routes.py and resolver.py in this one domain. Best-effort per plant --
    one plant's recompute failing must never mask (or roll back) the
    upload write that already committed, mirroring the `machine`/
    `sap_workcenter` post-write blocks in backend/master_data/routes.py."""
    import backend.routing.resolver as routing_resolver
    for plant in sorted({p for p in plants if p}):
        try:
            routing_resolver.resolve_orders(plant)
        except Exception as e:
            _log_event("warn", "routing", "Recompute after routing upload failed", plant=plant, error=str(e))

# Same cap/env-var shape as backend/integration/routes.py's upload routes.
NIMBUS_MAX_UPLOAD_BYTES = int(os.environ.get("NIMBUS_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))


def _rejected_count(warnings: list[dict]) -> int:
    return sum(1 for w in warnings if w.get("level") == "reject")


def _do_upload_production_versions(file_bytes: bytes, user_email: str | None) -> dict:
    """Blocking parse + `md.bulk_apply` write -- run in a worker thread by
    the route below. §6.2: production_version is a plain upsert-by-key."""
    ops, warnings = ingest.parse_production_versions_upload(file_bytes)
    rejected = _rejected_count(warnings)
    result = md.bulk_apply("production_version", ops, user_email=user_email)
    _recompute_after_write([row.get("plant") for row in ops.get("upserts", [])])
    if len(warnings) > 200:
        warnings = warnings[:200]
    return {
        "inserted": result.get("inserted", 0),
        "updated": result.get("updated", 0),
        "rejected": rejected,
        "warnings": warnings,
    }


def _do_upload_operations(file_bytes: bytes, user_email: str | None) -> dict:
    """Blocking parse + scoped-replace write -- run in a worker thread by the
    route below. §6.2: every (plant, material_id, task_list_type,
    routing_group, group_counter) key present in the file has its existing
    `routing_operation` rows deleted and replaced by that key's rows from
    the file, ALL in one transaction, serialized per plant via
    `pg_advisory_xact_lock(hashtext(plant))` so two concurrent uploads to
    the same plant's operations can't interleave (§6.2's own wording)."""
    groups, warnings = ingest.parse_routing_operations_upload(file_bytes)
    rejected = _rejected_count(warnings)
    if len(warnings) > 200:
        warnings = warnings[:200]
    if not groups:
        return {"inserted": 0, "updated": 0, "rejected": rejected, "warnings": warnings}

    # Every row this parse produced shares the same header-driven column
    # set (one worksheet, one header row) -- safe to read it off any row.
    col_names = list(next(iter(groups.values()))[0].keys())
    col_sql = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
    placeholders = sql.SQL(", ").join(sql.Placeholder() * len(col_names))
    insert_q = sql.SQL("INSERT INTO routing_operation ({cols}) VALUES ({vals})").format(
        cols=col_sql, vals=placeholders)

    plants = sorted({key[0] for key in groups})
    inserted = 0
    with db._pool.connection() as conn, conn.cursor() as cur:
        # Advisory locks are held for the lifetime of this transaction
        # (xact-scoped) and released automatically on commit/rollback.
        for plant in plants:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (plant,))
        for key, rows in groups.items():
            plant, material_id, task_list_type, routing_group, group_counter = key
            cur.execute(
                "DELETE FROM routing_operation WHERE plant = %s AND material_id = %s"
                " AND task_list_type = %s AND routing_group = %s AND group_counter = %s",
                (plant, material_id, task_list_type, routing_group, group_counter),
            )
            values_list = [[row.get(c) for c in col_names] for row in rows]
            cur.executemany(insert_q, values_list)
            inserted += len(rows)
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('routing_operation', 'upload_scoped_replace', %s, %s)",
            (Jsonb({"plants": plants, "routing_keys": len(groups), "rows_written": inserted}), user_email),
        )
        conn.commit()

    _recompute_after_write(plants)
    return {"inserted": inserted, "updated": 0, "rejected": rejected, "warnings": warnings}


@router.post("/routing/upload/production-versions", response_model=RoutingUploadResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_production_versions(request: Request, file: UploadFile = File(...)):
    """.xlsx -> upsert-by-key `production_version` (ROUTING_RUNTIME_DESIGN.md
    §6). Rows referencing a plant/material/work center unknown to NIMBUS are
    rejected individually (reported in `warnings`/`rejected`), never failing
    the whole file -- mirroring `/bom/upload`'s own per-row rejection shape."""
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    try:
        result = await run_in_threadpool(
            _do_upload_production_versions, raw, request.headers.get("x-user-email"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _set_admin_log_details(request, filename=file.filename, **{k: v for k, v in result.items() if k != "warnings"})
    return result


@router.post("/routing/upload/operations", response_model=RoutingUploadResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_operations(request: Request, file: UploadFile = File(...)):
    """.xlsx -> scoped-replace `routing_operation` (ROUTING_RUNTIME_DESIGN.md
    §6/§6.2). Every routing key present in the file has its existing
    operations deleted and replaced by that key's rows; a routing not
    mentioned in the file is left untouched."""
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413,
                            detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    try:
        result = await run_in_threadpool(
            _do_upload_operations, raw, request.headers.get("x-user-email"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _set_admin_log_details(request, filename=file.filename, **{k: v for k, v in result.items() if k != "warnings"})
    return result


@router.post("/routing/{plant}/recompute",
            dependencies=[Depends(require_api_key), Depends(auth.require_authenticated), Depends(require_admin)])
def recompute_plant(plant: str, request: Request,
                    allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """§6/§6.4: run resolver.py's §5 logic over every in-scope order in
    `plant` and return the §5.6 recompute report. Also the hook TARGET
    called (best-effort, deferred-imported) after any bulk save/upload/
    delete that touches production_version/routing_operation/routing_rules/
    machine, or a plants.routing_runtime_enabled flip, for the affected
    plant(s) -- see this file's `_recompute_after_write` and
    backend/master_data/routes.py's `md_bulk`/`md_delete_filtered`.

    Guard shape copied from backend/distribution/routes.py's
    `_distribution_plant_guard`: `md.PlantNotAllowed` -> 403,
    plain `ValueError` (blank/whitespace plant) -> 400.
    """
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    import backend.routing.resolver as routing_resolver
    result = routing_resolver.resolve_orders(plant, full=True)
    _set_admin_log_details(request, plant=plant, **{
        k: v for k, v in result.items() if k not in ("unknown_by_step", "unmapped_workcenters")
    })
    return result


@router.get("/routing/{plant}/rate-map",
            dependencies=[Depends(auth.require_authenticated)])
def get_rate_map(plant: str, response: Response,
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """§8.1/§6's P3 client-side rate-map mirror -- `frontend/routing/
    runtime-client.mts`'s `Runtime.load(plant)` fetches this once per
    selected/enabled plant so local edits (machine/production-version
    changes, drag re-place eligibility) can resolve/estimate without a round
    trip per edit. Read-only, `require_authenticated` + plant scope (no
    `require_api_key`/`require_admin` -- matches every other plant-scoped
    read in this app, e.g. `backend/priority_lists/routes.py`'s
    `GET /priority-rank-maps`). `Cache-Control: no-store`: the corporate
    proxy in front of this app caches by URL, and a stale rate map after a
    routing upload/recompute must never be served.

    `routing_resolver.build_rate_map` is a literal parity port of
    `resolve_one`'s own §5.4 math (see that function's docstring) -- this
    route does no calculation of its own.
    """
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response.headers["Cache-Control"] = "no-store"
    import backend.routing.resolver as routing_resolver
    return routing_resolver.build_rate_map(plant)
