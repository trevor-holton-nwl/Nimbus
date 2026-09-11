"""
NIMBUS 2.0 — master-data domain routes: the audit log, schema export, admin
universal table browser, the nine ALLOWED_TABLES CRUD/DDL family, per-plant
policy settings, and role page-access.

P5 relocation: pure move from brain.py (lines 2839-3291, minus the
system-settings pair which is interleaved in that range but belongs to
admin-ops — see backend/admin_ops/routes.py), per
docs/architecture/domain-refactor-plan.md §4. Route paths and payload/response
shapes are byte-identical to before. The four literal-path routes
(`_audit`, `_schema-export`, `_material-grid`, `_material-plant-grid`) are
kept, in this file, BEFORE the generic `GET /master-data/{table}` route
below them — FastAPI/Starlette matches routes in registration order, not by
specificity, so a route declared after `{table}` would be permanently
shadowed (see the comment on that route below, preserved from brain.py).
`admin_tables.py` (now backend/master_data/browser.py) backs the admin table
browser; the shared data-layer functions themselves stay in root db.py/
master_data.py (deferred split, see docs/MIGRATION.md).
"""
import json
from contextlib import suppress
from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import db
import master_data as md
from backend.admin_ops.logbuffer import _current_rid, _log_event, _set_admin_log_details
from backend.master_data import browser as admin_tables
from backend.master_data.models import (
    AddColumnResult,
    AdminTableRowsResult,
    AdminTablesListResult,
    AuditLogResult,
    BulkApplyResult,
    CascadePreviewResult,
    GridResult,
    PlantConstraintsResult,
    PlantFrozenHorizonDaysResult,
    PlantMaxPullForwardDaysResult,
    PlantUnknownSetupPolicyResult,
    PlantMaxPushForwardDaysResult,
    PlantMinProductiveSegmentMinutesResult,
    PlantSplitOrderPolicyResult,
    RolePageAccessResult,
    SchemaExportResult,
    StatusOkResult,
)
from backend.priority_lists.audit_log import _cw_append_audit, _cw_audit_path
from backend.security import auth
from backend.security.auth import require_admin, require_api_key

router = APIRouter()


# =========================
# AUDIT LOG ENDPOINTS
# =========================

@router.get("/audit/log", response_model=AuditLogResult, dependencies=[Depends(require_admin)])
def get_audit_log(limit: int = 200):
    """Return the most recent N audit log entries, newest first."""
    log = []
    try:
        with open(_cw_audit_path(), encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                with suppress(json.JSONDecodeError):
                    log.append(json.loads(line))
    except FileNotFoundError:
        pass
    return {"entries": list(reversed(log[-limit:]))}


@router.post("/audit/log", response_model=StatusOkResult, dependencies=[Depends(auth.require_authenticated)])
def append_audit_log(entry: dict, request: Request):
    """Frontend-triggered audit entry (e.g. optimization_run events)."""
    entry.setdefault("ts", datetime.utcnow().isoformat() + "Z")
    entry.setdefault("user", request.headers.get("X-User", "system"))
    _cw_append_audit(entry)
    return {"status": "ok"}


@router.post("/audit/log/clear", response_model=StatusOkResult, dependencies=[Depends(require_api_key), Depends(require_admin)])
def clear_audit_log():
    """Wipe the full audit log."""
    try:
        open(_cw_audit_path(), 'w', encoding='utf-8').close()
        return {"status": "ok"}
    except Exception as e:
        _log_event("error", "audit", "Could not clear audit log", exc=e)
        raise HTTPException(status_code=500,
                            detail=f"Could not clear audit log — ref: {_current_rid()}") from e


# =============================================================================
# MASTER DATA — Subnetwork / Plant / Production Line management
# =============================================================================

# NOTE: these literal-path routes MUST be registered before the generic
# GET /master-data/{table} below — FastAPI/Starlette matches routes in
# registration order, not by specificity, so a route declared after {table}
# is permanently shadowed (a request for it just gets captured as table="...",
# then 404s inside md_list/_assert_table). A former sibling, _audit, was once
# registered after {table} and was completely unreachable in production as a
# result before being moved ahead of it; _audit itself was later removed
# entirely (2026-09, confirmed zero frontend callers) but the ordering hazard
# it surfaced still applies to every route below.
# (POST /master-data/material-plants/attributes lives in backend/integration/
# routes.py and is NOT at this risk — it's a two-segment path and the default
# `str` path converter behind {table} excludes "/", so it can never be
# captured by {table} regardless of registration order. Only single-segment
# literals need to precede it.)
@router.get("/master-data/_schema-export", response_model=SchemaExportResult,
           dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_schema_export():
    """
    Read-only: dump every column currently registered (via column_metadata)
    on the Manage Data Tables tables as idempotent SQL (ALTER TABLE ... ADD
    COLUMN IF NOT EXISTS + column_metadata INSERT ... ON CONFLICT DO NOTHING).
    This is the recovery path for columns added through the "Add Column"
    wizard (md.add_column), which mutates the live DB directly with no other
    record in git — hit this against whichever DB is live (local or Azure) to
    get copy-pasteable text to fold back into schema.sql / a migrations file.
    """
    return {"sql": md.export_schema_sql()}


# ---------------------------------------------------------------------------
# Admin universal table browser (Workstream E). Deliberately separate from
# /master-data/* — read-only, catalog-driven (backend/master_data/browser.py),
# and NOT gated by master_data.ALLOWED_TABLES. Every table in `public` is
# discoverable here, including ones ALLOWED_TABLES will never register.
#
# OD-E2 (documented data-exposure decision): unlike every other admin/master-
# data route, these three do NOT call _assert_plant_allowed / scope by
# role_plants. A catalog-wide browser is cross-plant by nature — there is no
# single-plant version of "list every table" — so plant-scoping is
# deliberately skipped; access is gated on admin role (require_admin) plus
# the require_api_key shared-secret (added 2026-09-02's require_api_key
# sweep), same posture as GET /diagnostics/db and GET /master-data/_schema-
# export. All three are pure reads: browser.py never builds an
# INSERT/UPDATE/DELETE or DDL statement (OD-E3).
# ---------------------------------------------------------------------------
def _admin_tables_query_filters(request: Request) -> dict[str, list[str]]:
    """Filter transport: a repeated query parameter per column, e.g.
    ?material_id=A&material_id=B&plant=5512 — multi-value via repetition,
    paste-splitting is the frontend's job before it builds the query
    string. Every query param other than limit/offset is treated as a
    candidate filter column; admin_tables validates each one against the
    table's real columns (fresh per request) before it ever reaches SQL, so
    an unrecognized param name 400s rather than silently no-op'ing."""
    reserved = {"limit", "offset"}
    filters: dict[str, list[str]] = {}
    for key in request.query_params:
        if key in reserved:
            continue
        values = request.query_params.getlist(key)
        if values:
            filters[key] = values
    return filters


@router.get("/admin/tables", response_model=AdminTablesListResult,
           dependencies=[Depends(require_api_key), Depends(require_admin)])
def admin_list_tables():
    """Catalog listing of every table in the `public` schema, discovered
    fresh on this request (see admin_tables.list_tables — no process-level
    cache, unlike db._get_maint_table_allowlist). Response:
        { "tables": [ { table, approx_row_count, internal,
                         pk_columns: [str], fk_columns: [{column, ref_table, ref_column}] }, ... ] }
    `internal` is a flag, not a filter — schema_migrations/admin_audit/
    column_metadata/sap_sync_*/sap_field_map still appear, just marked."""
    return {"tables": admin_tables.list_tables()}


@router.get("/admin/tables/{table}", response_model=AdminTableRowsResult,
           dependencies=[Depends(require_api_key), Depends(require_admin)])
def admin_table_rows(table: str, request: Request,
                      limit: int = Query(default=100, ge=1, le=1000),
                      offset: int = Query(default=0, ge=0)):
    """Paginated rows for one table, PK/FK-aware, filterable by any real
    column of that table (see _admin_tables_query_filters for transport).
    Response:
        { "columns": [ { name, sql_type, is_nullable, ordinal_position,
                          is_pk, is_fk, ref_table, ref_column } ],
          "rows": [ {col: value, ...}, ... ],
          "meta": { "total": int, "limit": int, "offset": int } }
    `meta.total` is the full filtered count ignoring limit/offset, mirroring
    GET /tasks' paging contract. A filter value with no matching row is not
    an error — it simply contributes nothing to `rows`."""
    filters = _admin_tables_query_filters(request)
    try:
        return admin_tables.fetch_rows(table, limit=limit, offset=offset, filters=filters)
    except admin_tables.UnknownTable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except admin_tables.UnknownColumn as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/admin/tables/{table}/export.csv", dependencies=[Depends(require_api_key), Depends(require_admin)])
def admin_table_export_csv(table: str, request: Request, offset: int = Query(default=0, ge=0)):
    """Streaming CSV export of `table` (same filter transport as
    GET /admin/tables/{table}), soft-capped at admin_tables.EXPORT_ROW_CAP
    (~250k) rows. Table/filter validation happens up front, BEFORE the
    StreamingResponse is constructed, so a bad table/column name comes back
    as a normal 404/400 rather than a truncated-looking CSV body.

    If the cap is hit, the CSV stream itself carries the truncation signal
    (a response header can't work here — this is a real stream, so whether
    the cap will be hit isn't known until the body is already underway):
    the last line is `# NIMBUS_TRUNCATED,resume_offset=<N>,rows_written=<N>`.
    A client must treat any line starting with that prefix as a marker, not
    a data row, and may resume via ?offset=<resume_offset>. No trailing
    marker at all means the export was not truncated."""
    filters = _admin_tables_query_filters(request)
    try:
        admin_tables.validate_table_and_filters(table, filters)
    except admin_tables.UnknownTable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except admin_tables.UnknownColumn as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StreamingResponse(
        admin_tables.stream_csv_rows(table, filters=filters, offset=offset),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
    )


@router.get("/master-data/_material-grid", response_model=GridResult)
def md_material_grid(
        plant: str = Query(..., min_length=1,
            description="Required. Materials are returned only if they have a "
                        "material_plants row at this plant."),
        limit: int | None = Query(default=None, ge=1, le=100000),
        offset: int | None = Query(default=None, ge=0),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Plant-scoped Material grid (Master Data tab). Read-only.

    `plant` is REQUIRED on purpose: an optional plant would make omitting it
    the bypass around the role_plants scope enforced inside md.material_grid
    (materials has no plant column of its own, so it isn't in
    PLANT_SCOPED_TABLES and can't be scoped by the generic /master-data/{table}
    path). A plant with zero material_plants rows returns an empty grid — that
    is the rule, not an error. Not admin-gated, same as GET /master-data/{table}.
    """
    try:
        return md.material_grid(plant, limit=limit, offset=offset, allowed_plants=allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/master-data/_material-plant-grid", response_model=GridResult)
def md_material_plant_grid(
        plant: str = Query(..., min_length=1,
            description="Required. Returns material_plants rows for this plant, "
                        "with material_type/material_description joined in from materials."),
        limit: int | None = Query(default=None, ge=1, le=100000),
        offset: int | None = Query(default=None, ge=0),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Plant-scoped Material Plant grid (Master Data tab). Read-only except
    prt_01/prt_02/color/default_machine, which come back with
    columns[].editable=True and are written through
    POST /master-data/material-plants/attributes."""
    try:
        return md.material_plant_grid(plant, limit=limit, offset=offset, allowed_plants=allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/master-data/{table}", response_model=GridResult, dependencies=[Depends(auth.require_authenticated)])
def md_list(table: str,
            limit: int | None = Query(default=None, ge=1, le=100000,
                description="Max rows to return. Omit for the full table."),
            offset: int | None = Query(default=None, ge=0,
                description="Rows to skip before returning (for paging)."),
            plant: str | None = Query(default=None,
                description="Filter to one plant (only honored for tables with a plant column)."),
            material_id: str | None = Query(default=None,
                description="Filter to one material (only honored for tables with a material_id column)."),
            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """List rows for a master-data table (subnetworks | plants | machine | ...).

    Optional ?limit=/?offset=/?plant=/?material_id= scope the result server-side;
    all default to the full-catalog behavior. When supplied, meta.total carries
    the full filtered row count for paging. bom_items in particular relies on
    ?plant=+?material_id= to never load its full (potentially huge) table.

    Per-user plant scope (role_plants) is enforced for tables in
    md.PLANT_SCOPED_TABLES: an explicit ?plant= outside the caller's allowed
    set 403s; otherwise the row set is silently bounded to the allowed set.

    require_authenticated (not require_admin): any known user, not just an
    admin, can read master data — this route previously required zero
    identity at all, so an anonymous request resolved to allowed_plants=None
    (unrestricted) and could enumerate every plant's rows. Frontend callers
    now all route through Util.fetchTraced (2026-09 fetch migration), which
    auto-attaches the identity header this depends on."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    if (allowed_plants is not None and table in md.PLANT_SCOPED_TABLES
            and plant is not None and plant not in allowed_plants):
        raise HTTPException(status_code=403, detail=f"Plant {plant!r} is not in your assigned plants")
    return md.list_rows(table, limit=limit, offset=offset, plant=plant,
                         allowed_plants=allowed_plants, material_id=material_id)


@router.post("/master-data/{table}/cascade-preview", response_model=CascadePreviewResult, dependencies=[Depends(require_admin)])
def md_cascade_preview(table: str, body: dict = Body(default={})):
    """Preview cascading deletes before committing. Payload: { deletes: key[] }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    return md.cascade_preview(table, body.get("deletes", []))


@router.post("/master-data/{table}/bulk", response_model=BulkApplyResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_bulk(table: str, request: Request, body: dict = Body(default={})):
    """Apply upserts and deletes in one transaction. Payload: { upserts: row[], deletes: key[] }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        result = md.bulk_apply(
            table,
            ops={"upserts": body.get("upserts", []), "deletes": body.get("deletes", [])},
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, upsert_count=len(body.get("upserts", [])), delete_count=len(body.get("deletes", [])),
            inserted=result.get("inserted", 0), updated=result.get("updated", 0),
            deleted=result.get("deleted", 0),
        )
        # Adding/editing production lines may let orders uploaded before the line
        # existed resolve their materialized plant. Re-derive NULL-plant orders so they
        # stop being invisible to the plant-scoped read path (best-effort, non-fatal).
        if table == "machine":
            try:
                n = db.reattribute_null_plant_orders()
                if n:
                    _log_event("info", "db", "Re-attributed orders to plant after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "Plant re-attribution after line change failed", error=str(e))
            try:
                n = db.backfill_machine_keys()
                if n:
                    _log_event("info", "db", "Backfilled order machine_key after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "machine_key backfill after line change failed", error=str(e))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/{table}/columns", response_model=AddColumnResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_add_column(table: str, request: Request, body: dict = Body(default={})):
    """Add a new user-defined column to a master-data table. Payload: { column_name, sql_type, length?, nullable?, default?, display_label? }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.add_column(
            table=table,
            column_name=body.get("column_name", ""),
            sql_type=body.get("sql_type", ""),
            length=body.get("length"),
            nullable=body.get("nullable", True),
            default=body.get("default"),
            display_label=body.get("display_label", body.get("column_name", "")),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/master-data/{table}/columns/{column}", response_model=StatusOkResult,
              dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_drop_column(table: str, column: str, request: Request):
    """Drop a user-defined column from a master-data table (system columns are protected)."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.drop_column(table, column, user_email=request.headers.get("x-user-email"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.patch("/master-data/{table}/columns/{column}", response_model=StatusOkResult,
             dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_rename_label(table: str, column: str, request: Request, body: dict = Body(default={})):
    """Update the display_label of an existing column. Payload: { display_label: str }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.rename_label(
            table, column,
            new_label=body.get("display_label", ""),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/constraints", response_model=PlantConstraintsResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_constraints(plant: str, request: Request, body: dict = Body(default={})):
    """Persist a plant's switchable-constraint config (ordered list).

    Payload: { subnetwork?, constraints: [{ key, enabled, order }, ...] }
    Only 'colorWheel' is consumed today; the ordered list is the first step
    toward a general per-plant constraint registry (tooling, etc.)."""
    try:
        return md.set_plant_constraints(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            constraints=body.get("constraints", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/split-order-policy", response_model=PlantSplitOrderPolicyResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_split_order_policy(plant: str, request: Request, body: dict = Body(default={})):
    """Persist one validated plant-level split-order allocation policy.

    Payload: { subnetwork?, split_order_policy: never|overlong_only|partial_allowed }.
    This is intentionally separate from the nested priority constraint tree.
    """
    try:
        return md.set_plant_split_order_policy(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            policy=body.get("split_order_policy", ""),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/max-pull-forward-days", response_model=PlantMaxPullForwardDaysResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_max_pull_forward_days(plant: str, request: Request, body: dict = Body(default={})):
    """Persist a nullable, non-negative whole-calendar-day scheduling floor."""
    try:
        return md.set_plant_max_pull_forward_days(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            value=body.get("max_pull_forward_days"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/max-push-forward-days", response_model=PlantMaxPushForwardDaysResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_max_push_forward_days(plant: str, request: Request, body: dict = Body(default={})):
    """Persist a nullable, non-negative whole-calendar-day lateness ceiling."""
    try:
        return md.set_plant_max_push_forward_days(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            value=body.get("max_push_forward_days"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/min-productive-segment-minutes", response_model=PlantMinProductiveSegmentMinutesResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_min_productive_segment_minutes(plant: str, request: Request, body: dict = Body(default={})):
    """Persist the B3 plant productive-segment floor: a required positive
    integer minute count (the column is NOT NULL DEFAULT 30 — pass 30 to
    reset to the system default rather than omitting the field)."""
    try:
        return md.set_plant_min_productive_segment_minutes(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            value=body.get("min_productive_segment_minutes"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/frozen-horizon-days", response_model=PlantFrozenHorizonDaysResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_frozen_horizon_days(plant: str, request: Request, body: dict = Body(default={})):
    """Persist the C2 plant frozen-horizon setting: a nullable whole-calendar-day
    window (NULL or 0 = off, unlike C1's visibility_horizon_days) inside which
    the optimizer may not place or move any order."""
    try:
        return md.set_plant_frozen_horizon_days(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            value=body.get("frozen_horizon_days"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/plants/{plant}/unknown-setup-policy", response_model=PlantUnknownSetupPolicyResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_unknown_setup_policy(plant: str, request: Request, body: dict = Body(default={})):
    """N8: per-plant treatment of orders whose setup transition has no data —
    zero | plantDefaultMinutes | excludeFromSearch — stored in the
    plants.setup_policy_config JSONB sidecar (never freezes a line)."""
    try:
        return md.set_plant_unknown_setup_policy(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            policy=body.get("unknown_setup_policy", ""),
            default_minutes=body.get("unknown_setup_default_minutes", 0),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/master-data/roles/{role}/page-access", response_model=RolePageAccessResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_role_page_access(role: str, request: Request, body: dict = Body(default={})):
    """Persist a role's per-page UI-visibility toggles (Dashboard/Scheduling
    Board/Labor Plan/Master Data/Admin Cockpit).

    Payload: { pages: { home?, gantt?, labor?, masterdata?, admin?: bool } }
    UI-visibility gating only — no endpoint-level enforcement, same as the
    existing Admin Cockpit tab check this generalizes."""
    try:
        return md.set_role_page_access(
            role=role,
            pages=body.get("pages", {}),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
