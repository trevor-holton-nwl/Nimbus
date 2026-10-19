"""
Response DTOs for backend/master_data/routes.py -- added 2026-09
(Code_Review_09_01.md §16 / "response_model= typing gaps") so this router
stops emitting `unknown` into frontend/types/api-generated.d.mts, mirroring
the pattern backend/scheduling/models.py already established.

Every shape below was verified against the actual master_data.py/db.py
return statement it models (direct read, not inferred from the docstring
alone, though several docstrings do state the shape verbatim -- e.g.
admin_list_tables/admin_table_rows). The handful of routes whose rows are
genuinely per-table dynamic (GET /master-data/{table}, the material grids,
the admin table browser) use a permissive `GridResult`-style envelope
(`model_config = {"extra": "allow"}`, `rows`/`columns` typed as
`list[dict[str, Any]]`) rather than a fully-closed schema -- these grids
render an admin-chosen, column_metadata-driven column set that varies per
table and per Add-Column-wizard use, so a closed schema would either be
wrong the moment a column is added, or would have to be rewritten to match
this file's own dynamic-DDL nature. The routes with a fixed, code-guaranteed
key set (cascade_preview, bulk_apply, the plant-policy setters, etc.) get
fully-typed models instead, since those really are constant across calls.
"""
from typing import Any

from pydantic import BaseModel, ConfigDict


class StatusOkResult(BaseModel):
    """Shared shape for drop_column/rename_label/append_audit_log/clear_audit_log
    -- every write that has nothing else useful to report but success."""
    status: str


class AddColumnResult(BaseModel):
    status: str
    column_name: str


class AuditLogEntry(BaseModel):
    """One backend/priority_lists/audit_log.py JSONL entry (GET /audit/log).
    Free-form beyond what's guaranteed (frontend-authored via POST /audit/log,
    e.g. optimization_run events) -- extra="allow" lets whatever fields a
    given entry carries pass through untyped."""
    model_config = ConfigDict(extra="allow")


class AuditLogResult(BaseModel):
    entries: list[AuditLogEntry]


class SchemaExportResult(BaseModel):
    sql: str


class AdminTableFkColumn(BaseModel):
    column: str
    ref_table: str
    ref_column: str


class AdminTableInfo(BaseModel):
    """One entry of GET /admin/tables' "tables" list -- shape per admin_list_tables's
    own docstring, verified against admin_tables.list_tables()."""
    model_config = ConfigDict(extra="allow")
    table: str
    approx_row_count: int | None = None
    internal: bool
    pk_columns: list[str] = []
    fk_columns: list[AdminTableFkColumn] = []


class AdminTablesListResult(BaseModel):
    tables: list[AdminTableInfo]


class AdminTableColumnInfo(BaseModel):
    """One entry of GET /admin/tables/{table}'s "columns" list -- shape per
    admin_table_rows's own docstring."""
    model_config = ConfigDict(extra="allow")
    name: str
    sql_type: str | None = None
    is_nullable: bool | None = None
    ordinal_position: int | None = None
    is_pk: bool | None = None
    is_fk: bool | None = None
    ref_table: str | None = None
    ref_column: str | None = None


class AdminTableRowsMeta(BaseModel):
    total: int
    limit: int
    offset: int


class AdminTableRowsResult(BaseModel):
    """GET /admin/tables/{table} -- rows are genuinely per-table dynamic
    ({col: value} for whatever `table` turned out to be), so left as
    dict[str, Any] rather than a closed schema."""
    columns: list[AdminTableColumnInfo]
    rows: list[dict[str, Any]]
    meta: AdminTableRowsMeta


class GridResult(BaseModel):
    """Shared shape for GET /master-data/{table}, GET /master-data/_material-grid,
    and GET /master-data/_material-plant-grid (master_data.list_rows/
    material_grid/material_plant_grid) -- all three return the same
    {columns, rows, meta} envelope over a column_metadata-driven, per-table-
    dynamic column set (Add-Column-wizard-extensible), so `columns`/`rows`
    stay loosely typed rather than a closed per-table schema. `meta` carries
    at least `total`; material_grid/material_plant_grid also add `plant`
    (extra="allow" covers that without a second model)."""
    model_config = ConfigDict(extra="allow")
    columns: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    meta: dict[str, Any]


class CascadePreviewResult(BaseModel):
    """master_data.cascade_preview()'s shape -- always seeds all six keys to
    0 so the delete-confirmation UI has a stable shape to render, per its own
    docstring; verified by direct read of the seed dict.

    `headers` counts order_distribution rows referencing a sap_workcenter
    (added alongside the sap_workcenter cascade-preview branch) -- this model
    is closed (no extra="allow"), so a key the function returns but that
    isn't declared here would be silently dropped by response_model
    serialization rather than raising."""
    plants: int
    machine: int
    material_plants: int
    bom_items: int
    role_plants: int
    headers: int = 0


class BulkWriteWarning(BaseModel):
    """One informational (non-blocking) finding from a table-specific
    post-write check -- currently only the `sap_workcenter` branch in
    routes.py's `md_bulk` (aggregate_to_detail.md §3.1/§4.1). Same
    `{level, msg}` shape the diagnostics pipeline's warnings already use
    (backend/admin_ops/logbuffer.py, diagnostics_state.py), reused here so
    the frontend's existing `.admin-bwarn-list` renderer (copied from
    AdminCockpit._warningList) needs no new shape to understand."""
    level: str = "warn"
    msg: str


class DeleteFilteredResult(BaseModel):
    """master_data.delete_filtered()'s shape (POST /master-data/{table}/
    delete-filtered, ROUTING_RUNTIME_DESIGN.md §6.3) -- a filtered mass
    delete, count-checked against the client's `expected_count` before
    anything is deleted."""
    deleted: int


class AutoLinkedMachine(BaseModel):
    """A machine bulk_apply auto-linked to the SAP work center sharing its ID."""
    plant: str
    machine: str


class BulkApplyResult(BaseModel):
    """master_data.bulk_apply()'s shape (POST /master-data/{table}/bulk),
    plus an optional `warnings` list a table-specific post-write hook can
    attach (routes.py `md_bulk`) -- informational only, never a reason the
    write itself failed (the write already committed by the time these run)."""
    inserted: int
    updated: int
    deleted: int
    warnings: list[BulkWriteWarning] = []
    linked: list[AutoLinkedMachine] = []


class PlantConstraintsResult(BaseModel):
    """master_data.set_plant_constraints()'s shape. `constraints` is the
    normalized Stage-3 priority tree (recursive {key, enabled, order,
    children?} nodes) -- left as list[dict[str, Any]] rather than a
    recursive Pydantic model, since routes.py itself treats it as an opaque
    JSON blob it never inspects."""
    status: str
    plant: str
    constraints: list[dict[str, Any]]


class PlantSplitOrderPolicyResult(BaseModel):
    status: str
    plant: str
    split_order_policy: str


class PlantMaxPullForwardDaysResult(BaseModel):
    status: str
    plant: str
    max_pull_forward_days: int | None = None


class PlantMaxPushForwardDaysResult(BaseModel):
    status: str
    plant: str
    max_push_forward_days: int | None = None


class PlantMinProductiveSegmentMinutesResult(BaseModel):
    status: str
    plant: str
    min_productive_segment_minutes: int


class PlantFrozenHorizonDaysResult(BaseModel):
    status: str
    plant: str
    frozen_horizon_days: int | None = None


class PlantUnknownSetupPolicyResult(BaseModel):
    status: str
    plant: str
    setup_policy_config: dict


class RolePageAccessResult(BaseModel):
    status: str
    role: str
    pages: dict[str, bool]
