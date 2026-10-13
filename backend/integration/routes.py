"""
NIMBUS 2.0 — integration domain routes: Excel order/BOM ingest, purge, upload
audit + missing-master-data exception reports, material-plant attribute
edits, the order-attribute resync mechanism, and the SAP sync skeleton's
interface routes (object catalog, field mappings, per-object config, on-demand
sync, run history).

P5 relocation: pure move from brain.py (lines 1987-2163, 3317-3411, and
3556-3723 as verified against the pre-split file), per
docs/architecture/domain-refactor-plan.md §4. Route paths and payload/response
shapes are byte-identical to before, with ONE necessary internal adjustment:
`sap_objects()` used to read the scheduler off the module-level `api.state`
(brain.py's FastAPI instance); since this route now lives outside brain.py
and importing `api` back from brain.py would be circular (brain.py imports
every router), it takes `request: Request` and reads `request.app.state`
instead — the identical object at runtime (FastAPI stores state on the one
app instance the whole process shares), so this is a zero-behavior-change
fix, not a functional change.
"""
import csv
import io
import os
import time
from datetime import datetime

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

import db
import master_data as md
import backend.integration.sap_staging as sap_staging
import backend.integration.sap_sync as sap_sync
import backend.setup.data as setup_data
from backend.admin_ops.logbuffer import _log_event, _set_admin_log_details
from backend.csv_util import CSV_BOM, csv_cell
from backend.security import auth
from backend.security.auth import require_admin, require_api_key

router = APIRouter()

# Maximum upload file size: 50 MB by default, overridable via NIMBUS_MAX_UPLOAD_BYTES env var.
NIMBUS_MAX_UPLOAD_BYTES = int(os.environ.get("NIMBUS_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))


@router.post("/upload", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_orders(request: Request, file: UploadFile = File(...)):
    """
    Receive an xlsx file (sequence_testing-shaped) and upsert into the orders
    table. Stateless: there is no in-memory frame to refresh — the next /tasks
    call reads the new rows straight from Postgres. The blocking parse/upsert is
    offloaded to a worker thread so it doesn't block the event loop.
    """
    t0 = time.perf_counter()
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    # Diagnostic context for the failure / slow-upload log lines. Filename, size,
    # timing, stage and counts only; never row contents.
    diag: dict = {"stage": "plant_peek"}
    dctx = {"filename": file.filename or "upload.xlsx", "size_bytes": len(raw)}

    def _diag_ctx() -> dict:
        out = dict(dctx, elapsed_ms=int((time.perf_counter() - t0) * 1000), stage=diag.get("stage"))
        if "rows" in diag:
            out["rows"] = diag["rows"]
        return out

    # Stage 0 observation seam: capture only already-completed planned work
    # before ingest can replace its source rows.  This never changes orders,
    # dates, capacity, alerts, or optimizer behavior. Scoped to the plants this
    # file actually touches (a read-only peek at the PLANT/WERKS column, done
    # before the real parse) so a single-plant upload doesn't scan every
    # plant/machine in the system; falls back to an unscoped capture (plants=None)
    # when the file's plant can't be determined up front — same as before this change.
    try:
        upload_plants = await run_in_threadpool(db.extract_upload_plants, raw)
        if upload_plants:
            dctx["plants"] = ",".join(sorted(str(p) for p in upload_plants))[:200]
        diag["stage"] = "setup_capture"
        await run_in_threadpool(
            setup_data.capture_setup_states_before_schedule_mutation,
            actor=request.headers.get("x-user-email") or "system", reason="Excel upload replacement",
            plants=upload_plants,
        )
        result = await run_in_threadpool(db.ingest_orders_from_excel, raw,
                                         file.filename or "upload.xlsx", diag)
    except Exception as e:
        _log_event("error", "upload", "Orders upload failed", exc=e, **_diag_ctx())
        _set_admin_log_details(request, **_diag_ctx())
        raise
    if result.get("status") != "ok":
        # Bad file / missing columns is a client error.
        _log_event("warn", "upload", "Orders upload rejected",
                   reason=str(result.get("message", ""))[:300], **_diag_ctx())
        raise HTTPException(status_code=400, detail=result.get("message", "Upload failed"))

    _log_event("info", "upload", "Orders uploaded and ingested",
               filename=file.filename, inserted=result.get("inserted", 0),
               updated=result.get("updated", 0), unchanged=result.get("unchanged", 0),
               raw=result.get("raw_row_count", 0), size_bytes=len(raw),
               elapsed_ms=int((time.perf_counter() - t0) * 1000),
               **({"plants": dctx["plants"]} if "plants" in dctx else {}))
    if time.perf_counter() - t0 > 5:
        _log_event("warn", "upload", "Slow orders upload", **_diag_ctx())
    _set_admin_log_details(
        request, filename=file.filename or "upload.xlsx",
        rows_received=result.get("raw_row_count", 0), inserted=result.get("inserted", 0),
        updated=result.get("updated", 0), unchanged=result.get("unchanged", 0),
        warning_count=len([w for w in (result.get("warnings") or []) if w.get("category") != "upload_counts"]),
    )
    # Soft-warn on production lines not yet in master data (lines come from the
    # ingest result now, not a global frame). Never let this blow up the response.
    try:
        known = await run_in_threadpool(md.known_plant_line_codes)
        if known["lines"]:
            for ul in sorted(set(result.get("lines", [])) - set(known["lines"])):
                result.setdefault("warnings", []).append(
                    {"level": "warn", "msg": f"Unknown production line: {ul} — add it in Admin Cockpit > Manage Data Tables"}
                )
    except Exception as e:
        # Soft-warn enrichment is best-effort; never fail the upload over it — but
        # log so a broken master-data lookup doesn't silently skip the warnings.
        _log_event("warn", "upload", "Unknown-line validation skipped",
                   exc=e, filename=file.filename)
    return result


@router.post("/bom/upload", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_bom(request: Request, file: UploadFile = File(...)):
    """
    Receive a BOM export (.xlsx) and upsert into bom_items — the bulk-load path
    for Bill of Materials data (expected at real scale, tens of thousands of
    rows+), mirroring /upload for orders. Every row's (material, plant) and
    (component, plant) must already exist in material_plants; rows that don't
    are rejected individually (reported in `warnings`/`rejected`) rather than
    failing the whole file. The blocking parse/upsert is offloaded to a worker
    thread so it doesn't block the event loop.
    """
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    result = await run_in_threadpool(md.ingest_bom_from_excel, raw,
                                     file.filename or "bom_upload.xlsx",
                                     request.headers.get("x-user-email"))
    if result.get("status") != "ok":
        raise HTTPException(status_code=400, detail=result.get("message", "Upload failed"))
    _log_event("info", "upload", "BOM uploaded and ingested",
               filename=file.filename, inserted=result.get("inserted", 0),
               updated=result.get("updated", 0), rejected=result.get("rejected", 0),
               raw=result.get("raw_row_count", 0))
    return result


def _parse_purge_scope(body: dict) -> tuple[str, "datetime", "datetime", list[str]]:
    """Shared validation for /purge/preview and /purge, so the two routes can
    never validate (and therefore scope) their date range differently. Returns
    (plant, start, end, machines). Raises HTTPException on any invalid input."""
    plant = (body.get("plant") or "").strip()
    if not plant:
        raise HTTPException(status_code=400, detail="plant is required")

    try:
        start = datetime.fromisoformat(str(body["start_date"]).replace("Z", ""))
        end   = datetime.fromisoformat(str(body["end_date"]).replace("Z", ""))
    except (KeyError, ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid date range: {e}") from e
    if start > end:
        raise HTTPException(status_code=400, detail="start_date must be on or before end_date")

    machines_raw = body.get("machines") or []
    if not isinstance(machines_raw, list):
        raise HTTPException(status_code=400, detail="machines must be a list")
    machines = [str(m).strip() for m in machines_raw if str(m).strip()]

    return plant, start, end, machines


def _assert_purge_plant_allowed(plant: str, allowed_plants: list[str] | None) -> None:
    """Same choke point as /master-data/resync-order-attributes: require_admin
    alone proves the caller is an admin, not that this plant is inside their
    role_plants scope. A purge is a DELETE, strictly more destructive than that
    route's UPDATE, so the same guard applies here for at least as strong a
    reason."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/purge/preview", dependencies=[Depends(require_admin)])
def purge_preview(body: dict = Body(default={}),
                   allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Read-only dry run for POST /purge, sharing its validation
    (_parse_purge_scope) and plant-scope guard so the previewed count can never
    describe a different row set than the real delete. Deliberately a separate
    route rather than a `dry_run` flag on /purge: brain.py's
    _ADMIN_WRITE_OPERATIONS maps by route path, so a flag would file every
    preview under the same orders.purge audit operation as a real delete.
    Not registered in _ADMIN_WRITE_OPERATIONS and carries no require_api_key —
    it changes nothing and is safe to call freely as the admin edits the form.

    Payload: { plant: str, start_date: ISO, end_date: ISO, machines?: string[] }
    Response: { status, plant, total, planner_overridden }
    """
    plant, start, end, machines = _parse_purge_scope(body)
    _assert_purge_plant_allowed(plant, allowed_plants)
    return db.preview_purge_orders(plant, start, end, machines or None)


@router.post("/purge", dependencies=[Depends(require_api_key), Depends(require_admin)])
def purge_orders(request: Request, body: dict = Body(default={}),
                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    payload: { plant: str, start_date: ISO, end_date: ISO, machines?: string[] }
    Deletes one plant's orders where effective end date falls in the range
    (both inclusive). Stateless: no in-memory frame to refresh afterward.
    (Sync handler → runs in the threadpool, so the blocking DELETE doesn't
    stall the event loop.)

    Plant-scoped and role_plants-checked (_assert_purge_plant_allowed) — a
    plant-restricted admin must not be able to delete another plant's orders,
    the same reasoning /master-data/resync-order-attributes already applies to
    its strictly less destructive UPDATE.
    """
    plant, start, end, machines = _parse_purge_scope(body)
    _set_admin_log_details(request, plant=plant, machines=",".join(machines),
                            start=str(start), end=str(end))
    _assert_purge_plant_allowed(plant, allowed_plants)

    # This must remain adjacent to the DELETE below: a derived state may only
    # observe the prior schedule while it still exists. Scoped to this plant
    # only (plants=[plant]) — unlike the prior unscoped call, matching how
    # /upload already scopes its own capture.
    setup_data.capture_setup_states_before_schedule_mutation(
        actor=request.headers.get("x-user-email") or "system", reason="order purge",
        plants=[plant],
    )
    result = db.purge_orders_by_date(plant, start, end, machines or None,
                                      user_email=request.headers.get("x-user-email"))
    _set_admin_log_details(request, deleted=result.get("deleted", 0))
    _log_event("info", "purge", "Orders purged by date range",
               plant=plant, deleted=result.get("deleted", 0), start=str(start), end=str(end))
    return result


@router.get("/upload/audit", dependencies=[Depends(require_admin)])
def get_upload_audit(limit: int = 50, source: str | None = Query(default=None)):
    """Recent uploads, newest first, for the Admin Cockpit history card.
    `?source=sap` (SAP syncs only) / `?source=excel` filter server-side so the
    limit applies to the filtered set."""
    try:
        return {"audit": db.upload_audit_log(limit, source)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/upload/{batch_id}/missing-master-data", dependencies=[Depends(require_admin)])
def get_missing_master_data(batch_id: str, format: str | None = Query(default=None)):
    """
    The missing-master-data exception report for one upload batch
    (docs/scheduling_priority.md "Unmatched MP rows" decision: uploads never
    block — this is what makes the resulting gap actionable). Reads the
    category=='missing_master_data' entries db._stamp_order_attributes wrote
    into that batch's upload_audit.warnings. ?format=csv returns a
    downloadable CSV instead of JSON, for handing to whoever owns collecting
    the missing material_plants rows.

    Response (JSON): {batch_id, unmatched_pairs, unmatched_orders,
    exceptions: [{plant, material_number, order_count, reason}, ...]}
    reason is 'no_mp_row' (material absent from material_plants at that
    plant) or 'no_plant_derived' (the order has no plant at all — an
    ambiguous multi-plant line code, a different pre-existing problem, N9).
    """
    warnings = db.get_upload_audit_warnings(batch_id)
    if warnings is None:
        raise HTTPException(status_code=404, detail=f"No upload found for batch {batch_id!r}")

    exceptions: list[dict] = []
    for w in warnings:
        if isinstance(w, dict) and w.get("category") == "missing_master_data":
            exceptions.extend(w.get("exceptions") or [])

    if format == "csv":
        buf = io.StringIO()
        buf.write(CSV_BOM)
        writer = csv.DictWriter(buf, fieldnames=["plant", "material_number", "order_count", "reason"])
        writer.writeheader()
        for e in exceptions:
            writer.writerow({k: csv_cell(e.get(k)) for k in ["plant", "material_number", "order_count", "reason"]})
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="missing-master-data-{batch_id}.csv"'},
        )

    return {
        "batch_id": batch_id,
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(int(e.get("order_count") or 0) for e in exceptions),
        "exceptions": exceptions,
    }


@router.get("/master-data/{plant}/missing-master-data", dependencies=[Depends(require_admin)])
def get_live_missing_master_data(
        plant: str, format: str | None = Query(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Live (not batch-scoped) missing-master-data report for one plant's
    Optimization tab (docs/superpowers/plans/archive/2026-08-11-priority-lists-stage-2.md
    Decision 3). Same JSON/CSV shape as GET /upload/{batch_id}/missing-master-data
    so the frontend shares one renderer."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    result = db.missing_master_data_for_plant(plant)
    if format == "csv":
        buf = io.StringIO()
        buf.write(CSV_BOM)
        writer = csv.DictWriter(buf, fieldnames=["plant", "material_number", "order_count", "reason"])
        writer.writeheader()
        for e in result["exceptions"]:
            writer.writerow({k: csv_cell(e.get(k)) for k in ["plant", "material_number", "order_count", "reason"]})
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="missing-master-data-{plant}.csv"'},
        )
    return {"plant": plant, **result}


@router.post("/upload/audit/clear", dependencies=[Depends(require_api_key), Depends(require_admin)])
def clear_upload_audit():
    """Delete all upload history records."""
    return db.clear_upload_audit()


@router.post("/master-data/material-plants/attributes",
             dependencies=[Depends(require_api_key), Depends(auth.require_authenticated)])
def md_set_material_plant_attributes(request: Request, body: dict = Body(default={}),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Update the planner-editable material_plants attributes (prt_01, prt_02,
    color, default_machine) for one plant. Deliberately NOT admin-gated —
    this is the Master Data tab's Material Plant grid save, and planners (not
    just admins) are its users. The write surface is a hard server-side
    allowlist (md.EDITABLE_MATERIAL_PLANT_ATTRS); keys, status_pl,
    default_production_version and the lot sizes are unreachable from here
    regardless of what the client sends. Rows must already exist — this never
    inserts.

    Payload: { plant: str, updates: [{ material_id, prt_01?, prt_02?, color?, default_machine? }] }
    """
    plant = (body.get("plant") or "").strip()
    rows = body.get("updates") or []
    # Set BEFORE the call so the rejected/failure paths carry the target too —
    # this route has no path params, so _admin_route_details' path-param
    # harvest can't supply it on its own.
    _set_admin_log_details(request, plant=plant, row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        result = md.set_material_plant_attributes(
            plant=plant, updates=rows, allowed_plants=allowed_plants,
            user_email=request.headers.get("x-user-email"))
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _set_admin_log_details(request, updated=result.get("updated", 0),
                           columns=",".join(result.get("columns", [])))
    return result


@router.post("/master-data/resync-order-attributes", dependencies=[Depends(require_api_key), Depends(require_admin)])
def resync_order_attributes(
        request: Request, body: dict = Body(default={}),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Re-stamp one plant's orders.{color,prt_01,prt_02,production_version} from
    material_plants NOW, via seam 2 (db._stamp_order_attributes). This is the
    REAL mechanism — the batch-scoped ingest-time stamp is convenience only
    (R3 in docs/scheduling_priority.md, the inverse-ledger-trap risk). Call
    this after adding/fixing material_plants rows for a plant so its orders
    pick up the new values without waiting for a re-upload.

    WARNING: this bumps orders.xmin for every matched row, which IS the
    optimistic-concurrency base_version (db.py ROW_VERSION). Any planner's
    unsaved edit to an affected order is discarded on their next save
    (last-writer-loses reconciliation, R2) — run this at a quiet moment, not
    mid-shift. Admin-gated AND role_plants-scoped (_assert_plant_allowed below)
    for exactly that reason.

    Payload: { plant: str }
    Response: { status, plant, unmatched_pairs, unmatched_orders, exceptions }
    (same exception shape as GET /upload/{batch_id}/missing-master-data — a
    resync has no batch_id, so its unmatched pairs are returned here directly
    rather than persisted to upload_audit.)
    """
    plant = (body.get("plant") or "").strip()
    if not plant:
        raise HTTPException(status_code=400, detail="plant is required")

    # require_admin alone is NOT enough here: it proves the caller is an admin,
    # not that this plant is inside their role_plants scope. This route runs a
    # real UPDATE orders, which bumps orders.xmin (= base_version) and so
    # discards every planner's unsaved edit on the affected rows — a
    # plant-restricted admin must not be able to do that to a plant they aren't
    # assigned, whether from the Stage 2 "Resync Now" button or by hand-crafting
    # the request. `plant` arrives in the JSON body here (not a path param), so
    # the check runs after the body is unpacked, but is otherwise the same
    # choke point every other plant-scoped route in this family uses.
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # Note: this writes orders.* columns only — it never touches priority_list,
    # so no PLANT_LISTS cache refresh is needed (unlike the /color-wheel/*
    # upload path, which writes priority_list rows directly).
    result = db.resync_order_attributes(plant)
    _set_admin_log_details(request, plant=plant,
                           unmatched_pairs=result["unmatched_pairs"],
                           unmatched_orders=result["unmatched_orders"])
    _log_event("info", "master_data", "Order attributes resynced from material_plants",
               plant=plant, unmatched_pairs=result["unmatched_pairs"],
               unmatched_orders=result["unmatched_orders"])
    return {
        "status": "ok",
        "plant": plant,
        "unmatched_pairs": result["unmatched_pairs"],
        "unmatched_orders": result["unmatched_orders"],
        "exceptions": result["exceptions"],
    }


# =============================================================================
# SAP INTERFACE — object catalog, field mappings, per-object config, on-demand
#                 sync, and run history. Reads are UNGATED; writes are gated by
#                 the shared-secret guard. Connectors are STUBS in this skeleton
#                 (no live SAP calls), and the scheduler is disabled by default.
# =============================================================================

# Source-param keys that may hold credentials/secrets. NEVER returned by the
# config GET (only has_secret:bool) and NEVER fed to _log_event.
_SAP_SECRET_KEYS = frozenset({
    "password", "passwd", "secret", "client_secret", "token", "api_key",
    "apikey", "sap_password", "rfc_password", "passwd_hash", "auth_token",
    "private_key", "credential", "credentials",
})


def _sap_strip_secrets(params: dict | None) -> dict:
    """Return source_params with any secret-bearing keys removed (case-insensitive)."""
    if not isinstance(params, dict):
        return {}
    return {k: v for k, v in params.items() if k.lower() not in _SAP_SECRET_KEYS}


def _sap_has_secret(params: dict | None) -> bool:
    if not isinstance(params, dict):
        return False
    return any(k.lower() in _SAP_SECRET_KEYS for k in params)


@router.get("/sap/interface/objects", dependencies=[Depends(require_admin)])
def sap_objects(request: Request):
    """List the SAP-syncable objects with their config + last/next run summary."""
    objects = []
    for object_key, meta in sap_sync.SAP_OBJECTS.items():
        cfg = sap_sync.get_config(object_key)
        runs = sap_sync.list_runs(object_key=object_key, limit=1)
        last_run = runs[0] if runs else None
        job = None
        # Read off request.app.state (NOT a module-level `api` — this route no
        # longer lives in brain.py, so it reaches the shared FastAPI instance
        # through the request instead of importing brain, which would be
        # circular). Same object lifespan sets app.state.sap_scheduler on.
        sched = getattr(request.app.state, "sap_scheduler", None)
        if sched is not None:
            job = sched.get_job("sap:" + object_key)
        next_run = job.next_run_time.isoformat() if (job and job.next_run_time) else None
        objects.append({
            "object_key":    object_key,
            "label":         meta.get("label"),
            "kind":          meta.get("kind"),
            "enabled":       cfg.get("enabled", False),
            "transport":     cfg.get("transport"),
            "schedule_cron": cfg.get("schedule_cron"),
            "apply_mode":    cfg.get("apply_mode", "manual"),
            "last_run":      last_run,
            "next_run":      next_run,
        })
    return {"objects": objects}


@router.get("/sap/interface/mappings/{object}", dependencies=[Depends(require_admin)])
def sap_get_mappings(object: str):
    """Return the field-map rows (including inactive) for one SAP object."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    return {"object_key": object, "mappings": sap_sync.load_field_map(object)}


@router.post("/sap/interface/mappings/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_set_mappings(object: str, request: Request, body: dict = Body(default={})):
    """Replace the field map for one SAP object. Payload: { mappings: [...] }"""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    try:
        result = sap_sync.replace_field_map(object, body.get("mappings", []),
                                             user_email=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _log_event("info", "sap_sync", "SAP field map replaced",
               object_key=object, actor=actor,
               mappings=len(body.get("mappings", []) or []))
    return result


@router.get("/sap/interface/config/{object}", dependencies=[Depends(require_admin)])
def sap_get_config(object: str):
    """Return one SAP object's config. Secret source_params keys are stripped —
    only non-secret keys are returned, plus has_secret:bool."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    cfg = sap_sync.get_config(object)
    params = cfg.get("source_params") or {}
    return {
        "object_key":    object,
        "enabled":       cfg.get("enabled", False),
        "transport":     cfg.get("transport"),
        "schedule_cron": cfg.get("schedule_cron"),
        "apply_mode":    cfg.get("apply_mode", "manual"),
        "source_params": _sap_strip_secrets(params),
        "has_secret":    _sap_has_secret(params),
    }


@router.post("/sap/interface/config/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_set_config(object: str, request: Request, body: dict = Body(default={})):
    """Update one SAP object's config. Payload: { enabled?, transport?, schedule_cron?,
    source_params? }. source_params is MERGED into the stored params (omitted keys are
    never wiped). transport and cron are validated."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    fields: dict = {}
    if "enabled" in body:
        fields["enabled"] = bool(body["enabled"])
    if "transport" in body:
        transport = body["transport"]
        if transport not in ("file_drop", "odata", "rfc"):
            raise HTTPException(status_code=400, detail=f"Unknown transport: {transport!r}")
        fields["transport"] = transport
    if "apply_mode" in body:
        apply_mode = body["apply_mode"]
        if apply_mode not in ("manual", "auto"):
            raise HTTPException(status_code=400, detail=f"Unknown apply_mode: {apply_mode!r}")
        fields["apply_mode"] = apply_mode
    if "schedule_cron" in body:
        cron = body["schedule_cron"]
        if cron not in (None, ""):
            # Validate the cron expression without keeping a live trigger around.
            try:
                from apscheduler.triggers.cron import CronTrigger
                CronTrigger.from_crontab(str(cron))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid cron: {e}") from e
        fields["schedule_cron"] = cron
    if "source_params" in body:
        incoming = body["source_params"]
        if not isinstance(incoming, dict):
            raise HTTPException(status_code=400, detail="source_params must be an object")
        # MERGE: start from stored params so omitted keys (incl. secrets) survive.
        current = sap_sync.get_config(object).get("source_params") or {}
        merged = dict(current)
        merged.update(incoming)
        fields["source_params"] = merged
    try:
        result = sap_sync.set_config(object, **fields)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Log only NON-SECRET, NON-VALUE config metadata — never source_params values.
    _log_event("info", "sap_sync", "SAP object config updated",
               object_key=object, actor=actor,
               changed=sorted(k for k in fields if k != "source_params"),
               source_params_changed=("source_params" in fields))
    # Re-shape through the same secret-stripping the GET uses — the response must
    # never echo stored source_params secrets (set_config returns the raw config).
    cfg_params = result.get("source_params") or {}
    return {
        "object_key":    object,
        "enabled":       result.get("enabled", False),
        "transport":     result.get("transport"),
        "schedule_cron": result.get("schedule_cron"),
        "apply_mode":    result.get("apply_mode", "manual"),
        "source_params": _sap_strip_secrets(cfg_params),
        "has_secret":    _sap_has_secret(cfg_params),
    }


@router.post("/sap/interface/test-connection", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_test_connection(request: Request, body: dict = Body(default={})):
    """Test connectivity for a transport + source_params combo. Payload: { transport,
    source_params }. Connectors are stubs in this skeleton, so this returns the
    stub's {ok:false, detail:...} unless a real transport is configured."""
    transport = body.get("transport")
    params = body.get("source_params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="source_params must be an object")
    try:
        result = sap_sync.test_connection(transport, params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Never log source_params values (may carry secrets).
    _log_event("info", "sap_sync", "SAP test-connection invoked",
               actor=request.headers.get("x-user-email"),
               transport=transport, ok=result.get("ok"))
    return result


@router.post("/sap/interface/sync/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_sync_now(object: str, request: Request, body: dict = Body(default={})):
    """Run a sync for one SAP object on demand. Payload: { dry_run? }. Offloaded to
    the threadpool (the sync is blocking + does DB I/O)."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    dry_run = bool(body.get("dry_run", False))
    _log_event("info", "sap_sync", "Manual SAP sync requested",
               object_key=object, actor=actor, dry_run=dry_run)
    result = await run_in_threadpool(
        sap_sync.sync_object, object, user_email=actor, dry_run=dry_run)
    return result


@router.get("/sap/interface/runs", dependencies=[Depends(require_admin)])
def sap_runs(object: str | None = Query(default=None),
             limit: int = Query(default=50, ge=1, le=500)):
    """Return recent SAP sync runs, newest first, optionally scoped to one object."""
    if object is not None and object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    return {"runs": sap_sync.list_runs(object_key=object, limit=limit)}


# =============================================================================
# SAP STAGING — batches landed by Mulesoft (or the test upload) in the sap_stage_*
#               tables: list / inspect / validate / apply / discard, the on-demand
#               poll, the Excel/CSV test upload, and the 30-day vanished-order archive.
#               Design of record: docs/SAP_STAGING_DESIGN.md. Every route is admin-only
#               (D14); writes also need the API key. Plant scope: a restricted admin only
#               sees and acts on batches of their own plants (the batch's plant is read
#               first, so an unknown id is 404 and an out-of-scope one is 403).
#               Error mapping for apply/discard/validate: KeyError -> 404,
#               BatchSuperseded -> 409 {error: "superseded", ...}, BatchNotApplicable ->
#               409 {error: <code or "not_applicable">, ...} (the structured detail
#               reaches the client unchanged through brain's HTTPException handler).
# =============================================================================
def _assert_stage_plant_allowed(plant: str, allowed_plants: list[str] | None) -> None:
    """Same guard as the purge routes (`_assert_purge_plant_allowed`): require_admin proves the
    caller is an admin, not that this plant is inside their role_plants scope."""
    _assert_purge_plant_allowed(plant, allowed_plants)


def _stage_actor(request: Request) -> str:
    return request.headers.get("x-user-email") or "system"


def _stage_batch_or_404(batch_id: str, allowed_plants: list[str] | None) -> dict:
    """The batch header (404 when unknown), after the plant-scope check."""
    batch = sap_staging.get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}")
    _assert_stage_plant_allowed(batch["plant"], allowed_plants)
    return batch


def _stage_conflict(exc: "sap_staging.BatchNotApplicable") -> HTTPException:
    detail = dict(exc.detail)
    code = "superseded" if isinstance(exc, sap_staging.BatchSuperseded) else detail.get("code", "not_applicable")
    detail.pop("error", None)
    return HTTPException(status_code=409, detail={"error": code, **detail})


def _csv_response(rows: list[dict], filename: str) -> Response:
    """Rows -> a BOM-prefixed, formula-guarded CSV download (columns = first-seen key order)."""
    fields: list[str] = []
    for r in rows:
        for k in r:
            if k not in fields:
                fields.append(k)
    buf = io.StringIO()
    buf.write(CSV_BOM)
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()
    for r in rows:
        writer.writerow({k: csv_cell(r.get(k)) for k in fields})
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/sap/staging/batches", dependencies=[Depends(require_admin)])
def sap_stage_batches(object: str | None = Query(default=None), plant: str | None = Query(default=None),
                      status: str | None = Query(default=None), limit: int = Query(default=50, ge=1, le=500),
                      allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Batch headers, newest first, scoped to the caller's plants. Response: {batches: [header...]}."""
    return {"batches": sap_staging.list_batches(object_key=object, plant=plant, status=status, limit=limit,
                                                allowed_plants=allowed_plants)}


@router.get("/sap/staging/batches/{batch_id}", dependencies=[Depends(require_admin)])
def sap_stage_batch(batch_id: str, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """One batch: header + `row_counts` (by row_status) + `actual_rows` + warnings."""
    return _stage_batch_or_404(batch_id, allowed_plants)


@router.get("/sap/staging/batches/{batch_id}/rejected", dependencies=[Depends(require_admin)])
def sap_stage_rejected(batch_id: str, format: str | None = Query(default=None),
                       limit: int = Query(default=1000, ge=1, le=10000),
                       allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Rejected staging rows with `reject_reason`. JSON {rows: [...]} or `?format=csv`."""
    _stage_batch_or_404(batch_id, allowed_plants)
    try:
        rows = sap_staging.rejected_rows(batch_id, limit=limit)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}") from e
    if format == "csv":
        # The raw code stays machine-readable; a human-readable column follows it.
        with_text = []
        for r in rows:
            out = {}
            for k, v in r.items():
                out[k] = v
                if k == "reject_reason":
                    out["reject_reason_text"] = sap_staging.reject_reason_text(v)
            with_text.append(out)
        return _csv_response(with_text, f"sap-staging-rejected-{batch_id}.csv")
    return {"rows": rows}


@router.get("/sap/staging/batches/{batch_id}/deletions", dependencies=[Depends(require_admin)])
def sap_stage_deletions(batch_id: str, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """The orders a planned-order batch would delete on apply. Response: {orders: [...]}."""
    _stage_batch_or_404(batch_id, allowed_plants)
    try:
        return {"orders": sap_staging.held_deletions(batch_id)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}") from e


@router.post("/sap/staging/batches/{batch_id}/validate",
             dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_validate(batch_id: str, request: Request,
                             allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Re-run validation on a ready / validated / held batch. Response: validate_batch's result."""
    batch = await run_in_threadpool(_stage_batch_or_404, batch_id, allowed_plants)
    try:
        result = await run_in_threadpool(sap_staging.validate_batch, batch_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}") from e
    except sap_staging.BatchNotApplicable as e:
        raise _stage_conflict(e) from e
    _log_event("info", "sap_staging", "Staging batch validated", batch_id=batch_id, plant=batch["plant"],
               object_key=batch["object_key"], actor=_stage_actor(request), outcome=result.get("status"))
    return result


@router.post("/sap/staging/batches/{batch_id}/apply",
             dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_apply(batch_id: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Apply a validated batch (or a held one with `confirm_held: true`) to the live tables.
    Payload: { confirm_held?: bool }. 409 when superseded or not applicable."""
    batch = await run_in_threadpool(_stage_batch_or_404, batch_id, allowed_plants)
    actor = _stage_actor(request)
    confirm_held = bool((body or {}).get("confirm_held"))
    _log_event("info", "sap_staging", "Staging batch apply requested", batch_id=batch_id, plant=batch["plant"],
               object_key=batch["object_key"], actor=actor, confirm_held=confirm_held)
    try:
        return await run_in_threadpool(sap_staging.apply_batch, batch_id, actor=actor, confirm_held=confirm_held)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}") from e
    except sap_staging.BatchNotApplicable as e:
        raise _stage_conflict(e) from e


@router.post("/sap/staging/batches/{batch_id}/discard",
             dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_discard(batch_id: str, request: Request,
                            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Discard an un-applied batch. Response: {batch_id, status: "discarded"}."""
    batch = await run_in_threadpool(_stage_batch_or_404, batch_id, allowed_plants)
    actor = _stage_actor(request)
    try:
        result = await run_in_threadpool(sap_staging.discard_batch, batch_id, actor=actor)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=f"Unknown staging batch: {batch_id!r}") from e
    except sap_staging.BatchNotApplicable as e:
        raise _stage_conflict(e) from e
    _log_event("info", "sap_staging", "Staging batch discarded", batch_id=batch_id, plant=batch["plant"],
               object_key=batch["object_key"], actor=actor)
    return result


@router.post("/sap/staging/poll", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_poll(request: Request):
    """Run one staging poll now (the Interface tab's Refresh). Blocks until the pass finishes.
    Response: {processed, applied, held, skipped, errors}."""
    actor = _stage_actor(request)
    result = await run_in_threadpool(sap_staging.poll_once, actor=actor)
    _log_event("info", "sap_staging", "Manual staging poll", actor=actor,
               processed=len(result.get("processed") or []), applied=len(result.get("applied") or []),
               held=len(result.get("held") or []), errors=len(result.get("errors") or []))
    return result


@router.post("/sap/staging/upload/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_upload(object: str, request: Request, file: UploadFile = File(...), plant: str = Form(...),
                           allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Excel/CSV with SAP column headers -> a `source='upload'` staging batch (validated, never applied).
    Multipart: `file` + form field `plant`."""
    if object not in sap_sync.SAP_OBJECTS or sap_sync.SAP_OBJECTS[object].get("kind") != "staging":
        raise HTTPException(status_code=404, detail=f"Unknown staging object: {object!r}")
    plant = (plant or "").strip()
    _assert_stage_plant_allowed(plant, allowed_plants)
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    actor = _stage_actor(request)
    try:
        result = await run_in_threadpool(sap_staging.stage_rows_from_upload, object, plant, raw,
                                         file.filename or "upload.xlsx", actor=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _log_event("info", "sap_staging", "Staging upload received", object_key=object, plant=plant,
               filename=file.filename, actor=actor, rows_staged=result.get("rows_staged", 0),
               rows_skipped=result.get("rows_skipped", 0), outcome=result.get("status"))
    return result


@router.get("/sap/staging/archive/{plant}", dependencies=[Depends(require_admin)])
def sap_stage_archive(plant: str, limit: int = Query(default=200, ge=1, le=1000),
                      allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Vanish-deleted orders of the last 30 days. Response: {orders: [...]}."""
    _assert_stage_plant_allowed(plant, allowed_plants)
    return {"orders": sap_staging.list_archived(plant, limit=limit)}


@router.post("/sap/staging/archive/{archive_id}/restore",
             dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_restore(archive_id: int, request: Request,
                            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Restore one archived order (with its schedule). 404 when missing or already restored."""
    actor = _stage_actor(request)
    plant = await run_in_threadpool(sap_staging.archived_plant, archive_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Unknown archived order: {archive_id!r}")
    _assert_stage_plant_allowed(plant, allowed_plants)
    try:
        result = await run_in_threadpool(sap_staging.restore_archived, archive_id, actor=actor)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e.args[0]) if e.args else "Archived order not found") from e
    except ValueError as e:
        if str(e) == "order_exists":
            raise HTTPException(status_code=409, detail={"error": "order_exists"}) from e
        raise
    _log_event("info", "sap_staging", "Archived order restored", archive_id=archive_id, plant=plant, actor=actor)
    return result


# -- Send to SAP (outbound) ---------------------------------------------------
@router.post("/sap/staging/send/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_stage_send(plant: str, request: Request,
                         allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Queue the plant's scheduled orders for Mulesoft (retires any still-ready earlier queue).
    Response: {send_batch_id, queued, skipped_no_end, firmed, rolled_up_groups}."""
    _assert_stage_plant_allowed(plant, allowed_plants)
    actor = _stage_actor(request)
    _set_admin_log_details(request, plant=plant)
    try:
        result = await run_in_threadpool(sap_staging.queue_send_to_sap, plant, actor=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _log_event("info", "sap_staging", "Send to SAP queued", plant=plant, actor=actor,
               send_batch_id=result.get("send_batch_id"), queued=result.get("queued"),
               skipped_no_end=result.get("skipped_no_end"), firmed=result.get("firmed"))
    return result


@router.get("/sap/staging/send/{plant}/status", dependencies=[Depends(require_admin)])
def sap_stage_send_status(plant: str, allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Outbound tiles. Response: {ready, sent, error, last_queued_at, last_sent_at}."""
    _assert_stage_plant_allowed(plant, allowed_plants)
    return sap_staging.outbound_status(plant)


@router.get("/sap/staging/send/{plant}/rows", dependencies=[Depends(require_admin)])
def sap_stage_send_rows(plant: str, status: str | None = Query(default=None),
                        format: str | None = Query(default=None),
                        limit: int = Query(default=1000, ge=1, le=10000),
                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Outbound rows (newest first). JSON {rows: [...]} or `?format=csv`; `status` = ready|sent|error."""
    _assert_stage_plant_allowed(plant, allowed_plants)
    if status is not None and status not in ("ready", "sent", "error"):
        raise HTTPException(status_code=400, detail=f"Unknown status: {status!r}")
    rows = sap_staging.outbound_rows(plant, status=status, limit=limit)
    if format == "csv":
        return _csv_response(rows, f"sap-send-{plant}{'-' + status if status else ''}.csv")
    return {"rows": rows}
