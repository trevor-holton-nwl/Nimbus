"""
NIMBUS 2.0 — Master Data layer (Subnetwork / Plant / Machine).

Safe DDL surface: every dynamic identifier is routed through
psycopg.sql.Identifier; every type literal is validated against a whitelist
before being composed with psycopg.sql.SQL; every value goes through a
parameter placeholder.  The user cannot inject SQL through any of these paths.
"""
import io
import logging
import re
from datetime import datetime, timezone

import pandas as pd
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

# Import the shared pool + SAP-numeric-ID normalizer from the existing db module.
from db import _pool, _str_id

# Child of brain.py's `nimbus.*` structured-logging tree (propagates up), so a
# narrowed-but-unexpected error class here still reaches the operator log.
log = logging.getLogger("nimbus.md")

# ---------------------------------------------------------------------------
# Safety constants
# ---------------------------------------------------------------------------
ALLOWED_TABLES = frozenset({
    'subnetworks', 'plants', 'machine',
    'materials', 'material_plants', 'bom_items',
    'roles', 'role_plants', 'workcenter_mapping',
})

# Tables whose `plant` column is business/scheduling data, subject to
# per-user role_plants scoping (auth.get_allowed_plants). A static allowlist
# rather than a dynamic "plant" in col_names check: the Add-Column DDL
# wizard can add a column literally named `plant` to any table on a whim,
# and a security boundary must not be able to widen itself via an unrelated
# admin action. Deliberately excludes `role_plants` itself — its `plant`
# column means "which plant this role can see", a different concept from
# "which plant this record belongs to".
PLANT_SCOPED_TABLES = frozenset({'plants', 'machine', 'material_plants', 'bom_items', 'workcenter_mapping'})

ALLOWED_COLUMN_TYPES = frozenset({'TEXT', 'INTEGER', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP'})

# This setting is deliberately a narrow plant-level allowlist rather than an
# arbitrary optimizer option supplied by the browser.
SPLIT_ORDER_POLICIES = frozenset({'never', 'overlong_only', 'partial_allowed'})

COLUMN_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{0,62}$')

# System columns the UI must never see or touch.
SYSTEM_COLUMNS = frozenset({'created_at', 'updated_at'})

# Generated/computed columns per table — must never be written by bulk_apply's
# upsert (Postgres rejects an explicit value for a GENERATED ALWAYS AS column).
# Only relevant if such a column is ever also registered in column_metadata;
# machine_key deliberately never is, but this is cheap insurance against that
# happening by mistake later.
GENERATED_COLUMNS = {'machine': frozenset({'machine_key'})}

# Key columns per table — is_locked in column_metadata, but also enforced here.
_KEY_COLUMNS = {
    'subnetworks':        frozenset({'code'}),
    'plants':             frozenset({'subnetwork', 'plant'}),
    'machine':            frozenset({'subnetwork', 'plant', 'machine'}),
    'materials':          frozenset({'material_id'}),
    'material_plants':    frozenset({'material_id', 'plant'}),
    'bom_items':          frozenset({'material_id', 'plant', 'alternative_bom', 'level', 'item_number', 'component_id'}),
    'roles':              frozenset({'role'}),
    'role_plants':        frozenset({'role', 'plant'}),
    'workcenter_mapping': frozenset({'plant', 'machine'}),
}

# The ONLY material_plants columns POST /master-data/material-plants/attributes
# may ever write. This is a security boundary, not a convenience list: it is
# what keeps that (deliberately non-admin-gated) endpoint away from the
# composite key (material_id, plant), the SAP-owned fields (status_pl,
# default_production_version) and the lot sizes the optimizer consumes.
# Widening it is a deliberate act — see tests/test_material_plant_attributes.py,
# which pins its exact contents.
EDITABLE_MATERIAL_PLANT_ATTRS = frozenset({'prt_01', 'prt_02', 'color', 'default_machine'})

# ---------------------------------------------------------------------------
# Scheduling priority — rankable fields (docs/scheduling_priority.md, Stage 1:
# data plumbing only — no upload UI, no optimizer change yet)
# ---------------------------------------------------------------------------
# The SINGLE source of truth for which material_plants column a rankable
# priority-list field materializes from, which `orders` column it lands on
# (also the column priority-list ranks are matched against), and which
# TaskDTO/DataFrame field name carries it. Anything stored in
# priority_list.source_column is upload provenance/audit metadata ONLY, never
# re-parsed from (N19) — this dict is authoritative, read by
# GET /priority-fields, brain.apply_priority_merge, db.priority_list_coverage
# callers, and the eventual priority-tree UI (Stage 3).
#
# To add a rankable field: one entry here + one `orders` column
# (schema.sql + a migration) + one line in db._stamp_order_attributes'
# hand-written UPDATE + one web/order-field-catalog.mjs entry. No other
# frontend change required — Stage 3's Scheduling Constraints UI renders from
# GET /priority-fields, not a hardcoded list.
#
# `production_version` (mp_column default_production_version) is deliberately
# NOT one of EDITABLE_MATERIAL_PLANT_ATTRS above — it is a SAP-owned field,
# editable only through the generic Material Plant grid (bulk_apply), never
# through the attributes-only endpoint (see that frozenset's comment). The
# other three mp_columns ARE in that allowlist. RANKABLE_FIELDS and
# EDITABLE_MATERIAL_PLANT_ATTRS are separate concerns that happen to overlap
# on three of four entries — do not assume they must always match.
RANKABLE_FIELDS = {
    'colorWheel': {
        'mp_column': 'color', 'orders_column': 'color', 'task_field': 'COLOR',
        'default_label': 'Color Wheel',
    },
    'prt01': {
        'mp_column': 'prt_01', 'orders_column': 'prt_01', 'task_field': 'PRT_01',
        'default_label': 'Prod. Resource Tool (01)',
    },
    'prt02': {
        'mp_column': 'prt_02', 'orders_column': 'prt_02', 'task_field': 'PRT_02',
        'default_label': 'Prod. Resource Tool (02)',
    },
    'productionVersion': {
        'mp_column': 'default_production_version', 'orders_column': 'production_version',
        'task_field': 'PRODUCTION_VERSION', 'default_label': 'Production Version',
    },
}

# Production Version remains in RANKABLE_FIELDS solely so existing persisted
# priority lists, constraints, and setup history can still be read safely.
# New optimization uploads and setup signatures use this narrower registry.
CONFIGURABLE_PRIORITY_FIELDS = {
    key: spec for key, spec in RANKABLE_FIELDS.items()
    if key != "productionVersion"
}

# Columns the Master Data > Material Plant grid joins in from `materials` for
# display/filtering only. Never writable; never physically on material_plants.
_MATERIAL_PLANT_JOINED = ('material_type', 'material_description')

# Hard ceiling on one attributes save — bounds statement count and audit payload.
MAX_ATTRIBUTE_UPDATES = 5000


class PlantNotAllowed(PermissionError):
    """The caller's role_plants scope excludes the requested plant.

    Its own exception class (not ValueError) so brain.py maps it to 403, never
    400. Needed because the plant-scoped Material / Material Plant grids
    resolve their row set THROUGH material_plants.plant rather than through a
    plant column on their own base table (materials has none), so
    PLANT_SCOPED_TABLES — which governs the generic /master-data/{table} path
    and deliberately means "this table's OWN plant column is scoped data" —
    cannot express the check for them.
    """


def _assert_plant_allowed(plant: str, allowed_plants: list[str] | None) -> None:
    """Single choke point for the plant-derived read/write surface below.
    Called FIRST in every function that resolves rows through a plant, before
    any query is composed — so the check can't be forgotten at the route layer
    or bypassed by a future second caller of these functions."""
    if not plant or not plant.strip():
        raise ValueError("plant is required")
    if allowed_plants is not None and plant not in allowed_plants:
        raise PlantNotAllowed(f"Plant {plant!r} is not in your assigned plants")


def _assert_table(table: str):
    if table not in ALLOWED_TABLES:
        raise ValueError(f"Unknown table: {table!r}")


def _assert_col_name(column_name: str):
    if not COLUMN_NAME_RE.match(column_name):
        raise ValueError(
            f"Column name {column_name!r} is invalid. "
            "Must start with a lowercase letter and contain only lowercase letters, digits, and underscores."
        )
    if column_name in SYSTEM_COLUMNS:
        raise ValueError(f"Column {column_name!r} is a system column and cannot be modified.")


def _row_key(table: str, row: dict) -> tuple:
    return tuple(row.get(k) for k in sorted(_KEY_COLUMNS[table]))


def _column_meta(cur, table: str) -> list[dict]:
    """column_metadata JOIN information_schema.columns for `table`, in display
    order, system columns excluded. Extracted verbatim out of list_rows so the
    plant-scoped grids (material_grid / material_plant_grid) get IDENTICAL
    column semantics: a physical column with no column_metadata row stays
    invisible to the API, and vice versa (the JOIN is an INNER JOIN on
    purpose). list_rows's external contract is unchanged by this extraction —
    it's a pure ~15-line lift."""
    cur.execute(
        """
        SELECT cm.column_name, cm.display_label, cm.is_locked, cm.column_order,
               c.data_type, c.is_nullable, c.column_default
        FROM column_metadata cm
        JOIN information_schema.columns c
          ON c.table_name = cm.table_name
         AND c.column_name = cm.column_name
         AND c.table_schema = 'public'
        WHERE cm.table_name = %s
          AND cm.column_name != ALL(%s)
        ORDER BY cm.column_order, cm.column_name
        """,
        (table, list(SYSTEM_COLUMNS)),
    )
    return [
        {
            "column_name":    r[0],
            "display_label":  r[1],
            "is_locked":      r[2],
            "column_order":   r[3],
            "sql_type":       r[4].upper(),
            "is_nullable":    r[5] == "YES",
            "column_default": r[6],
        }
        for r in cur.fetchall()
    ]


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def list_rows(table: str, limit: int | None = None, offset: int | None = None,
              plant: str | None = None, allowed_plants: list[str] | None = None,
              material_id: str | None = None) -> dict:
    """
    Return column metadata + data rows for the given table.

    Optional server-side scoping (all default to current full-catalog behavior):
      - `plant`: filter to rows whose `plant` column matches (only honored when
        the table actually has a `plant` column; ignored otherwise).
      - `allowed_plants`: per-user role_plants scope (auth.get_allowed_plants);
        ANDed in alongside `plant`, but only for tables in PLANT_SCOPED_TABLES —
        it narrows, never widens, the result.
      - `material_id`: filter to rows whose `material_id` column matches (only
        honored when the table actually has one; ignored otherwise). Used by
        the BOM tab, which requires a plant + material pick before browsing
        rather than ever loading the full (potentially huge) bom_items table.
      - `limit`/`offset`: parameterized LIMIT/OFFSET page window.
    When any of these are supplied, `meta.total` carries the full row count for
    the same filter (ignoring limit/offset) so callers can paginate.
    """
    _assert_table(table)

    with _pool.connection() as conn, conn.cursor() as cur:
        # Column metadata in display order, excluding system columns.
        columns = _column_meta(cur, table)

        col_names = [c["column_name"] for c in columns]

        if not col_names:
            return {"columns": [], "rows": [], "meta": {"total": 0}}

        # Optional plant filters — only when the table actually has a plant column.
        # `plant` (explicit caller filter) and `allowed_plants` (per-user
        # role_plants scope, PLANT_SCOPED_TABLES only) AND together; neither
        # widens the other.
        where_parts = []
        where_params: list = []
        if plant and "plant" in col_names:
            where_parts.append(sql.SQL("{col} = %s").format(col=sql.Identifier("plant")))
            where_params.append(plant)
        if material_id and "material_id" in col_names:
            where_parts.append(sql.SQL("{col} = %s").format(col=sql.Identifier("material_id")))
            where_params.append(material_id)
        if allowed_plants is not None and table in PLANT_SCOPED_TABLES and "plant" in col_names:
            where_parts.append(sql.SQL("{col} = ANY(%s)").format(col=sql.Identifier("plant")))
            where_params.append(allowed_plants)
        where_sql = (sql.SQL(" WHERE ") + sql.SQL(" AND ").join(where_parts)) if where_parts else sql.SQL("")

        # Fetch rows with only the visible columns (plant filter + page window).
        select_idents = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
        query = sql.SQL("SELECT {cols} FROM {tbl}").format(
            cols=select_idents,
            tbl=sql.Identifier(table),
        ) + where_sql + sql.SQL(" ORDER BY {order}").format(
            order=sql.SQL(", ").join(sql.Identifier(c) for c in col_names[:list(_KEY_COLUMNS[table]).__len__()]),
        )
        params = list(where_params)
        if limit is not None:
            query += sql.SQL(" LIMIT %s")
            params.append(int(limit))
        if offset:
            query += sql.SQL(" OFFSET %s")
            params.append(int(offset))
        cur.execute(query, params)
        rows = [dict(zip(col_names, r, strict=True)) for r in cur.fetchall()]

        # Total row count for the same (plant) filter. A separate COUNT is only
        # needed when a page window is applied; otherwise `rows` already holds the
        # whole filtered set, so len(rows) is the total (avoids a redundant scan).
        if limit is not None or offset:
            cur.execute(
                sql.SQL("SELECT COUNT(*) FROM {tbl}").format(tbl=sql.Identifier(table)) + where_sql,
                where_params,
            )
            total = int(cur.fetchone()[0])
        else:
            total = len(rows)

        # Plants carry sidecar optimization settings (`constraints`, the
        # split-order allocation policy, and — as of Workstream D2 — the
        # relocated setup-active flag). They are intentionally NOT registered
        # in column_metadata, so none of them appears as an editable grid
        # column — but we attach them to each row dict so the frontend
        # (Settings pane + optimizer) can read them alongside the visible
        # columns. Scope the fetch to the plants on this page so a
        # paged/filtered request never re-scans the whole table.
        if table == 'plants':
            try:
                page_plants = list({r.get('plant') for r in rows if r.get('plant') is not None})
                if page_plants:
                    cur.execute(
                        "SELECT subnetwork, plant, constraints, split_order_policy, max_pull_forward_days, "
                        "setup_active, visibility_horizon_days, horizon_roll_hour_utc, frozen_horizon_days, "
                        "min_productive_segment_minutes "
                        "FROM plants WHERE plant = ANY(%s)",
                        (page_plants,),
                    )
                    cmap = {(r[0], r[1]): (r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]) for r in cur.fetchall()}
                    for row in rows:
                        (constraints, policy, max_pull_forward_days, setup_active,
                         visibility_horizon_days, horizon_roll_hour_utc, frozen_horizon_days,
                         min_productive_segment_minutes) = cmap.get(
                            (row.get('subnetwork'), row.get('plant')),
                            (None, 'never', None, False, None, 19, None, 30)
                        )
                        row['constraints'] = constraints
                        row['split_order_policy'] = policy or 'never'
                        row['max_pull_forward_days'] = max_pull_forward_days
                        row['setup_active'] = bool(setup_active)
                        row['visibility_horizon_days'] = visibility_horizon_days
                        row['horizon_roll_hour_utc'] = horizon_roll_hour_utc if horizon_roll_hour_utc is not None else 19
                        row['frozen_horizon_days'] = frozen_horizon_days
                        row['min_productive_segment_minutes'] = (
                            min_productive_segment_minutes if min_productive_segment_minutes is not None else 30
                        )
            except psycopg.errors.UndefinedColumn:
                pass  # column not migrated yet — leave it absent (expected)
            except Exception:
                # Any other failure is unexpected: degrade (leave constraints
                # absent) but log it rather than swallowing the whole class.
                log.warning("Unexpected error attaching plant constraints",
                            exc_info=True, extra={"category": "master_data"})

        # Roles carry a JSONB `settings` column (per-role default UI prefs +
        # page-visibility toggles under settings.pages). Deliberately NOT
        # registered in column_metadata (same reasoning as plants.constraints
        # above), so we attach the `pages` sub-key to each row here — this is
        # how the Security > Roles tab reads current page-access state.
        if table == 'roles':
            try:
                role_names = list({r.get('role') for r in rows if r.get('role') is not None})
                if role_names:
                    cur.execute(
                        "SELECT role, settings FROM roles WHERE role = ANY(%s)",
                        (role_names,),
                    )
                    smap = {r[0]: (r[1] or {}) for r in cur.fetchall()}
                    for row in rows:
                        settings = smap.get(row.get('role')) or {}
                        row['pages'] = settings.get('pages') if isinstance(settings, dict) else None
            except psycopg.errors.UndefinedColumn:
                pass  # column not migrated yet — leave it absent (expected)
            except Exception:
                log.warning("Unexpected error attaching role page access",
                            exc_info=True, extra={"category": "master_data"})

    return {"columns": columns, "rows": rows, "meta": {"total": total}}


def material_grid(plant: str, limit: int | None = None, offset: int | None = None,
                  allowed_plants: list[str] | None = None) -> dict:
    """Materials that exist AT `plant`, i.e. semi-joined through material_plants.

    A plant with zero material_plants rows yields an EMPTY grid even though the
    global materials catalog is non-empty — that is the defining rule of this
    function, not a degenerate case. Read-only: every column comes back with
    editable=False.

    Columns are column_metadata-driven (not hardcoded), so a column added to
    `materials` via the Add-Column wizard appears here automatically, exactly
    as it does in the Admin grid.

    `materials` is deliberately NOT in PLANT_SCOPED_TABLES (it has no plant
    column of its own), so the per-user role_plants scope can't be enforced by
    the generic list_rows() path here — _assert_plant_allowed is the
    substitute choke point.
    """
    _assert_plant_allowed(plant, allowed_plants)

    with _pool.connection() as conn, conn.cursor() as cur:
        columns = _column_meta(cur, 'materials')
        col_names = [c["column_name"] for c in columns]
        if not col_names:
            return {"columns": [], "rows": [], "meta": {"total": 0, "plant": plant}}
        for c in columns:
            c["source_table"] = "materials"
            c["editable"] = False

        # Explicit key-membership filter, NOT list_rows' positional
        # col_names[:len(keys)] slice (which only works by seed-order luck).
        order_cols = [c for c in col_names if c in _KEY_COLUMNS['materials']] or col_names[:1]

        # EXISTS rather than JOIN: states the semi-join intent, lets the
        # planner stop at the first match, and stays correct if the PK ever
        # changes. The subquery's identifiers are compile-time literals
        # (never user input); the only value is the %s plant parameter.
        where = sql.SQL(
            " WHERE EXISTS (SELECT 1 FROM material_plants mp"
            "               WHERE mp.material_id = m.material_id AND mp.plant = %s)"
        )
        query = (
            sql.SQL("SELECT {cols} FROM materials AS m").format(
                cols=sql.SQL(", ").join(sql.Identifier("m", c) for c in col_names))
            + where
            + sql.SQL(" ORDER BY {order}").format(
                order=sql.SQL(", ").join(sql.Identifier("m", c) for c in order_cols))
        )
        params: list = [plant]
        if limit is not None:
            query += sql.SQL(" LIMIT %s")
            params.append(int(limit))
        if offset:
            query += sql.SQL(" OFFSET %s")
            params.append(int(offset))
        cur.execute(query, params)
        rows = [dict(zip(col_names, r, strict=True)) for r in cur.fetchall()]

        # Same rule as list_rows above — a separate COUNT is only worth a
        # second scan when a page window was applied; otherwise `rows` IS the
        # whole filtered set.
        if limit is not None or offset:
            cur.execute(sql.SQL("SELECT COUNT(*) FROM materials AS m") + where, [plant])
            total = int(cur.fetchone()[0])
        else:
            total = len(rows)

    return {"columns": columns, "rows": rows, "meta": {"total": total, "plant": plant}}


def material_plant_grid(plant: str, limit: int | None = None, offset: int | None = None,
                        allowed_plants: list[str] | None = None) -> dict:
    """material_plants rows for `plant`, plus material_type /
    material_description LEFT JOINed in from `materials` for the UI's filters.

    The joined columns come back in `columns[]` with editable=False and
    source_table='materials' so the grid can render them and refuse to edit
    them. Physical material_plants columns come back with
    editable = (name in EDITABLE_MATERIAL_PLANT_ATTRS) — the same allowlist
    the write endpoint enforces, so the client can never present a cell the
    server would reject.

    LEFT (not INNER) JOIN on purpose: material_plants.material_id has a NOT
    NULL FK to materials, so a match is guaranteed today — but an INNER JOIN
    would SILENTLY DROP material_plants rows if that ever stopped holding (FK
    disabled during a bulk load). Dropping rows from a plant-scoped grid is a
    data-loss-shaped bug; NULL enrichment is not. Same plan cost given the PK
    lookup.
    """
    _assert_plant_allowed(plant, allowed_plants)

    with _pool.connection() as conn, conn.cursor() as cur:
        columns = _column_meta(cur, 'material_plants')
        col_names = [c["column_name"] for c in columns]
        if not col_names:
            return {"columns": [], "rows": [], "meta": {"total": 0, "plant": plant}}
        for c in columns:
            c["source_table"] = "material_plants"
            c["editable"] = c["column_name"] in EDITABLE_MATERIAL_PLANT_ATTRS

        # Joined columns: label/type sourced from materials' OWN column_metadata
        # so an admin's display_label rename propagates here too. Skipped if
        # material_plants ever grows a physical column of the same name (the
        # Add-Column wizard can do that) — the physical column wins.
        mat_meta = {c["column_name"]: c for c in _column_meta(cur, 'materials')}
        next_order = max((c["column_order"] or 0) for c in columns) + 1
        joined: list[dict] = []
        for name in _MATERIAL_PLANT_JOINED:
            if name in col_names or name not in mat_meta:
                continue
            entry = dict(mat_meta[name])
            entry.update({"is_locked": True, "editable": False,
                          "source_table": "materials", "column_order": next_order})
            next_order += 1
            joined.append(entry)
        joined_names = [c["column_name"] for c in joined]

        order_cols = [c for c in col_names
                      if c in _KEY_COLUMNS['material_plants']] or col_names[:1]
        where = sql.SQL(" WHERE {col} = %s").format(col=sql.Identifier("mp", "plant"))
        query = (
            sql.SQL("SELECT {cols} FROM material_plants AS mp"
                    " LEFT JOIN materials AS m ON m.material_id = mp.material_id").format(
                cols=sql.SQL(", ").join(
                    [sql.Identifier("mp", c) for c in col_names]
                    + [sql.Identifier("m", c) for c in joined_names]))
            + where
            + sql.SQL(" ORDER BY {order}").format(
                order=sql.SQL(", ").join(sql.Identifier("mp", c) for c in order_cols))
        )
        params: list = [plant]
        if limit is not None:
            query += sql.SQL(" LIMIT %s")
            params.append(int(limit))
        if offset:
            query += sql.SQL(" OFFSET %s")
            params.append(int(offset))
        cur.execute(query, params)
        all_names = col_names + joined_names
        rows = [dict(zip(all_names, r, strict=True)) for r in cur.fetchall()]

        if limit is not None or offset:
            # No LEFT JOIN in the COUNT: a LEFT JOIN on the PK side cannot
            # change the row count, so joining here would only cost a scan.
            cur.execute(sql.SQL("SELECT COUNT(*) FROM material_plants AS mp") + where, [plant])
            total = int(cur.fetchone()[0])
        else:
            total = len(rows)

    return {"columns": columns + joined, "rows": rows,
            "meta": {"total": total, "plant": plant}}


def set_material_plant_attributes(plant: str, updates: list[dict],
                                  allowed_plants: list[str] | None = None,
                                  user_email: str | None = None) -> dict:
    """Update the four planner-editable material_plants attributes for ONE
    plant (prt_01, prt_02, color, default_machine).

    UPDATE only — never INSERT, never ON CONFLICT. These rows are SAP-owned
    master data; a missing (material_id, plant) pair means the client is
    stale or the material is not at this plant. An upsert would fabricate a
    material_plants row with empty status_pl / zero lot sizes, and — because
    bom_items' two FKs both reference material_plants(material_id, plant)
    (schema.sql) — would silently make that material BOM-eligible at a plant
    it does not belong to. So a missing row is an ERROR, not an insert.

    All rows in one transaction: a grid Save is atomic or it fails. A partial
    save would leave the client's row cache diverged from the DB with no
    indication which cells landed.
    """
    _assert_plant_allowed(plant, allowed_plants)
    if not isinstance(updates, list):
        raise ValueError("updates must be a list")
    if len(updates) > MAX_ATTRIBUTE_UPDATES:
        raise ValueError(
            f"Too many updates in one request ({len(updates)}; max {MAX_ATTRIBUTE_UPDATES}).")

    # ---- Phase 1: normalize + allowlist. No DB work yet, so a rejected
    # request cannot have written anything even in principle.
    normalized: list[tuple[str, dict]] = []
    touched: set[str] = set()
    for i, u in enumerate(updates):
        if not isinstance(u, dict):
            raise ValueError(f"updates[{i}] must be an object")
        if "plant" in u:
            raise ValueError(
                f"updates[{i}] must not include 'plant' — plant is specified once, at the top level")
        mid = _str_id(u.get("material_id"))
        if not mid:
            raise ValueError(f"updates[{i}] requires a material_id")
        attrs = {k: v for k, v in u.items() if k != "material_id"}
        rejected = sorted(set(attrs) - EDITABLE_MATERIAL_PLANT_ATTRS)
        if rejected:
            # HARD 400, never a silent drop. A silently-dropped status_pl or
            # min_lot_size write must not be indistinguishable from a
            # successful save — that is how an allowlist bypass goes unnoticed.
            raise ValueError(
                "These columns are not editable through this endpoint: "
                + ", ".join(rejected)
                + f" (allowed: {', '.join(sorted(EDITABLE_MATERIAL_PLANT_ATTRS))})")
        if not attrs:
            continue  # nothing to write for this row
        touched |= set(attrs)
        normalized.append((mid, attrs))

    if not normalized:
        return {"status": "ok", "plant": plant, "updated": 0, "columns": []}

    with _pool.connection() as conn, conn.cursor() as cur:
        # ---- Phase 2: narrow the STATIC allowlist to what actually exists and
        # is registered. Guarantees the write surface can never exceed the read
        # surface the grid rendered, and turns an un-migrated DB into a clean
        # 400 instead of a psycopg UndefinedColumn 500.
        live = {c["column_name"] for c in _column_meta(cur, 'material_plants')}
        missing_cols = sorted(touched - live)
        if missing_cols:
            raise ValueError(
                "Column(s) not present on material_plants in this database: "
                + ", ".join(missing_cols)
                + " — restart the app to apply pending material_plants migrations"
                  " (see master_data.ensure_material_plant_attributes), or apply the"
                  " relevant file(s) under migrations/ directly.")

        # ---- Phase 3: pre-flight existence in ONE round trip. Makes the
        # not-found error deterministic and complete BEFORE any write, instead
        # of discovering it row-by-row mid-transaction.
        mids = [m for m, _ in normalized]
        cur.execute(
            "SELECT material_id FROM material_plants WHERE plant = %s AND material_id = ANY(%s)",
            (plant, mids),
        )
        present = {r[0] for r in cur.fetchall()}
        unknown = sorted(set(mids) - present)
        if unknown:
            raise ValueError(
                f"{len(unknown)} material(s) have no material_plants row at plant {plant!r}: "
                + ", ".join(unknown[:20]) + ("…" if len(unknown) > 20 else ""))

        # ---- Phase 4: write. Per-row UPDATE because the supplied column set
        # varies per row (PATCH semantics: keys present are written, explicit
        # null clears, absent keys are untouched) — mirrors bulk_apply's
        # per-row shape. No explicit rollback needed: every raise above
        # happens before any write, and _pool.connection()'s context manager
        # rolls back on exception regardless.
        updated = 0
        for mid, attrs in normalized:
            cols = sorted(attrs)
            cur.execute(
                sql.SQL("UPDATE material_plants SET {sets}, updated_at = NOW()"
                        " WHERE material_id = %s AND plant = %s").format(
                    sets=sql.SQL(", ").join(
                        sql.SQL("{} = %s").format(sql.Identifier(c)) for c in cols)),
                [attrs[c] for c in cols] + [mid, plant],
            )
            updated += cur.rowcount

        # Audit. material_ids capped so a large save cannot write a
        # multi-hundred-KB JSONB blob per audit row.
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('material_plants', 'set_attributes', %s, %s)",
            (Jsonb({"plant": plant, "updated": updated,
                    "columns": sorted(touched),
                    "material_ids": mids[:50],
                    "material_id_count": len(mids),
                    "truncated": len(mids) > 50}), user_email),
        )
        conn.commit()

    return {"status": "ok", "plant": plant, "updated": updated, "columns": sorted(touched)}


def cascade_preview(table: str, deletes: list[dict]) -> dict:
    """Return how many child rows would cascade-delete if these rows are removed.

    The result dict carries every child-table key that can ever appear (seeded to 0)
    so the delete-confirmation UI always has a stable shape to render.
    """
    _assert_table(table)
    # Seed all child-table keys so a missing branch reads as 0, not "absent".
    result = {"plants": 0, "machine": 0, "material_plants": 0, "bom_items": 0}
    if not deletes:
        return result

    with _pool.connection() as conn, conn.cursor() as cur:
        if table == "subnetworks":
            codes = [d.get("code") for d in deletes if d.get("code")]
            if codes:
                cur.execute(
                    "SELECT COUNT(*) FROM plants WHERE subnetwork = ANY(%s)", (codes,)
                )
                result["plants"] = int(cur.fetchone()[0])
                cur.execute(
                    "SELECT COUNT(*) FROM machine WHERE subnetwork = ANY(%s)", (codes,)
                )
                result["machine"] = int(cur.fetchone()[0])

        elif table == "plants":
            # Each delete dict should have {subnetwork, plant}
            plines = 0
            for d in deletes:
                if d.get("subnetwork") and d.get("plant"):
                    cur.execute(
                        "SELECT COUNT(*) FROM machine WHERE subnetwork = %s AND plant = %s",
                        (d["subnetwork"], d["plant"]),
                    )
                    plines += int(cur.fetchone()[0])
            result["machine"] = plines

        elif table == "materials":
            # material_plants FK: material_id REFERENCES materials(material_id) ON DELETE CASCADE.
            material_ids = [d.get("material_id") for d in deletes if d.get("material_id")]
            if material_ids:
                cur.execute(
                    "SELECT COUNT(*) FROM material_plants WHERE material_id = ANY(%s)",
                    (material_ids,),
                )
                result["material_plants"] = int(cur.fetchone()[0])

        elif table == "material_plants":
            # bom_items FKs (material_id, plant) and (component_id, plant) are both
            # ON DELETE RESTRICT, not CASCADE — a dependent row here blocks the
            # delete rather than disappearing with it, so surface the count either way.
            bom_count = 0
            for d in deletes:
                if d.get("material_id") and d.get("plant"):
                    cur.execute(
                        "SELECT COUNT(*) FROM bom_items"
                        " WHERE (material_id = %s AND plant = %s) OR (component_id = %s AND plant = %s)",
                        (d["material_id"], d["plant"], d["material_id"], d["plant"]),
                    )
                    bom_count += int(cur.fetchone()[0])
            result["bom_items"] = bom_count

    return result


# ---------------------------------------------------------------------------
# Write — bulk upsert + delete
# ---------------------------------------------------------------------------
def bulk_apply(table: str, ops: dict, user_email: str | None = None) -> dict:
    """
    ops = {
        'upserts': [{col: val, ...}, ...],
        'deletes': [{key_col: val, ...}, ...],
    }
    All in one transaction.  Returns counts.
    """
    _assert_table(table)
    upserts = ops.get("upserts", [])
    deletes = ops.get("deletes", [])
    keys = sorted(_KEY_COLUMNS[table])

    inserted = updated = deleted = 0

    with _pool.connection() as conn, conn.cursor() as cur:
        # Columns bulk_apply is allowed to WRITE — same boundary list_rows already
        # enforces on READ (column_metadata JOIN information_schema.columns). Some
        # tables' row dicts carry extra sidecar fields attached by list_rows for a
        # different consumer (plants.constraints for the Settings pane/optimizer,
        # roles.pages for the Security tab) — deliberately excluded from
        # column_metadata so they never render as an editable grid column. The
        # generic Master Data grid round-trips a row's cached shape wholesale on
        # save (edit one cell, re-POST the whole cached row), so without this
        # filter those sidecar fields ride along into the INSERT: `constraints`
        # is a raw Python list with no Jsonb() wrapper (psycopg can't adapt it —
        # unmapped sqlstate, surfaces as a generic 500), and `pages` isn't a real
        # `roles` column at all (42703 undefined column, same generic 500).
        allowed_cols = {m["column_name"] for m in _column_meta(cur, table)} if upserts else set()

        # --- Deletes first so upserts don't conflict with to-be-deleted rows ---
        for d in deletes:
            where = sql.SQL(" AND ").join(
                sql.SQL("{} = {}").format(sql.Identifier(k), sql.Placeholder())
                for k in keys
            )
            vals = [d[k] for k in keys]
            try:
                cur.execute(
                    sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(table), where),
                    vals,
                )
            except psycopg.errors.ForeignKeyViolation as exc:
                conn.rollback()
                raise ValueError(f"Cannot apply change to {table!r}: it is referenced by or references other rows.") from exc
            deleted += cur.rowcount

        # --- Upserts ---
        for row in upserts:
            # Only pass columns actually registered as editable for this table
            # (guards against stale clients AND against list_rows' sidecar fields).
            col_names = [c for c in row if c in allowed_cols
                         and c not in GENERATED_COLUMNS.get(table, frozenset())]
            if not col_names:
                continue
            col_sql     = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
            placeholders = sql.SQL(", ").join(sql.Placeholder() * len(col_names))
            update_set  = sql.SQL(", ").join(
                sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
                for c in col_names if c not in keys
            )
            conflict_cols = sql.SQL(", ").join(sql.Identifier(k) for k in keys)
            q = sql.SQL(
                "INSERT INTO {tbl} ({cols}) VALUES ({vals})"
                " ON CONFLICT ({conflict}) DO UPDATE SET {upd}, updated_at = NOW()"
                " RETURNING (xmax = 0)"
            ).format(
                tbl=sql.Identifier(table),
                cols=col_sql,
                vals=placeholders,
                conflict=conflict_cols,
                upd=update_set,
            )
            # If all columns are keys (e.g. a minimal insert with no non-key cols),
            # the UPDATE SET clause would be empty — use DO NOTHING instead.
            non_key_cols = [c for c in col_names if c not in keys]
            if not non_key_cols:
                q = sql.SQL(
                    "INSERT INTO {tbl} ({cols}) VALUES ({vals})"
                    " ON CONFLICT ({conflict}) DO NOTHING"
                    " RETURNING TRUE"
                ).format(
                    tbl=sql.Identifier(table),
                    cols=col_sql,
                    vals=placeholders,
                    conflict=conflict_cols,
                )
            try:
                cur.execute(q, [row[c] for c in col_names])
            except psycopg.errors.ForeignKeyViolation as exc:
                conn.rollback()
                raise ValueError(f"Cannot apply change to {table!r}: it is referenced by or references other rows.") from exc
            row_result = cur.fetchone()
            if row_result and row_result[0]:
                inserted += 1
            else:
                updated += 1

        # Audit
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES (%s, %s, %s, %s)",
            (
                table,
                "bulk_apply",
                Jsonb({"inserted": inserted, "updated": updated, "deleted": deleted}),
                user_email,
            ),
        )
        conn.commit()

    return {"inserted": inserted, "updated": updated, "deleted": deleted}


# ---------------------------------------------------------------------------
# DDL — add / drop / rename-label
# ---------------------------------------------------------------------------
def add_column(
    table: str,
    column_name: str,
    sql_type: str,
    length: str | None,
    nullable: bool,
    default,
    display_label: str,
    user_email: str | None = None,
) -> dict:
    _assert_table(table)
    _assert_col_name(column_name)

    sql_type_upper = sql_type.upper()
    if sql_type_upper not in ALLOWED_COLUMN_TYPES:
        raise ValueError(f"Column type {sql_type!r} is not allowed.")

    # Check column doesn't already exist
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.columns"
            " WHERE table_schema='public' AND table_name=%s AND column_name=%s",
            (table, column_name),
        )
        if cur.fetchone():
            raise ValueError(f"Column {column_name!r} already exists in {table}.")

        # Build type fragment. NUMERIC carries a request-supplied precision[,scale].
        # sql.SQL() is a trusted-literal wrapper, NOT an escaper, so the raw value must
        # never be composed in. Validate it as precision[,scale] and rebuild the
        # fragment from parsed integers via sql.Literal (which renders bare numeric
        # tokens) — closing the DDL-injection sink.
        if sql_type_upper == "NUMERIC" and length:
            m = re.fullmatch(r"\s*(\d{1,4})\s*(?:,\s*(\d{1,4})\s*)?", str(length))
            if not m:
                raise ValueError(
                    f"Invalid NUMERIC precision/scale: {length!r} (expected e.g. '10' or '10,2')."
                )
            precision = int(m.group(1))
            scale = int(m.group(2)) if m.group(2) is not None else None
            if not (1 <= precision <= 1000):
                raise ValueError("NUMERIC precision must be between 1 and 1000.")
            if scale is not None and not (0 <= scale <= precision):
                raise ValueError("NUMERIC scale must be between 0 and precision.")
            if scale is None:
                type_sql = sql.SQL("NUMERIC({})").format(sql.Literal(precision))
            else:
                type_sql = sql.SQL("NUMERIC({},{})").format(
                    sql.Literal(precision), sql.Literal(scale)
                )
        else:
            type_sql = sql.SQL(sql_type_upper)

        # NOT NULL requires a DEFAULT
        if not nullable and default is None:
            raise ValueError("A NOT NULL column requires a DEFAULT value.")

        # Build ALTER TABLE
        col_def_parts = [type_sql]
        if not nullable:
            col_def_parts.append(sql.SQL("NOT NULL DEFAULT {}").format(sql.Literal(default)))
        elif default is not None:
            col_def_parts.append(sql.SQL("DEFAULT {}").format(sql.Literal(default)))

        alter = sql.SQL("ALTER TABLE {} ADD COLUMN {} {}").format(
            sql.Identifier(table),
            sql.Identifier(column_name),
            sql.SQL(" ").join(col_def_parts),
        )
        cur.execute(alter)

        # Determine next column_order
        cur.execute(
            "SELECT COALESCE(MAX(column_order), 0) + 1 FROM column_metadata WHERE table_name = %s",
            (table,),
        )
        next_order = cur.fetchone()[0]

        cur.execute(
            "INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)"
            " VALUES (%s, %s, %s, FALSE, %s)",
            (table, column_name, display_label or column_name, next_order),
        )

        cur.execute(
            "INSERT INTO admin_audit (table_name, action, column_name, details, user_email)"
            " VALUES (%s, 'add_column', %s, %s, %s)",
            (table, column_name, Jsonb({"sql_type": sql_type_upper, "nullable": nullable, "default": default}), user_email),
        )
        conn.commit()

    return {"status": "ok", "column_name": column_name}


def drop_column(table: str, column_name: str, user_email: str | None = None) -> dict:
    """Drop a user-defined column (ALTER TABLE ... DROP COLUMN). Key and system columns are protected."""
    _assert_table(table)
    _assert_col_name(column_name)

    if column_name in SYSTEM_COLUMNS:
        raise ValueError(f"{column_name!r} is a system column.")

    with _pool.connection() as conn, conn.cursor() as cur:
        # Check locked
        cur.execute(
            "SELECT is_locked FROM column_metadata WHERE table_name=%s AND column_name=%s",
            (table, column_name),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Column {column_name!r} not found in {table}.")
        if row[0]:
            raise ValueError(f"Column {column_name!r} is a key column and cannot be dropped.")

        cur.execute(
            sql.SQL("ALTER TABLE {} DROP COLUMN {}").format(
                sql.Identifier(table), sql.Identifier(column_name)
            )
        )
        cur.execute(
            "DELETE FROM column_metadata WHERE table_name=%s AND column_name=%s",
            (table, column_name),
        )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, column_name, user_email)"
            " VALUES (%s, 'drop_column', %s, %s)",
            (table, column_name, user_email),
        )
        conn.commit()

    return {"status": "ok"}


def rename_label(table: str, column_name: str, new_label: str, user_email: str | None = None) -> dict:
    """Update the display_label for a column in column_metadata (does not rename the DB column)."""
    _assert_table(table)

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE column_metadata SET display_label=%s"
            " WHERE table_name=%s AND column_name=%s",
            (new_label, table, column_name),
        )
        if cur.rowcount == 0:
            raise ValueError(f"Column {column_name!r} not found in {table}.")

        cur.execute(
            "INSERT INTO admin_audit (table_name, action, column_name, details, user_email)"
            " VALUES (%s, 'rename_label', %s, %s, %s)",
            (table, column_name, Jsonb({"new_label": new_label}), user_email),
        )
        conn.commit()

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Per-plant switchable constraints (colorWheel now; tooling/others later)
# ---------------------------------------------------------------------------
def ensure_plant_constraints_column() -> None:
    """Idempotent: add plants.constraints JSONB — per-plant ordered constraint
    config [{key, enabled, order}, ...]. Deliberately kept out of
    column_metadata so it never shows as an editable Master Data grid column."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS constraints JSONB")
        conn.commit()


def ensure_plant_split_order_policy_column() -> None:
    """Idempotent plant-only allocation policy. It stays out of the generic
    Master Data grid and is changed only through the validated settings route."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE plants ADD COLUMN IF NOT EXISTS split_order_policy "
            "TEXT NOT NULL DEFAULT 'never'"
        )
        conn.commit()


def ensure_plant_max_pull_forward_days_column() -> None:
    """Idempotent nullable plant scheduling guardrail, kept out of the grid."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS max_pull_forward_days INTEGER")
        conn.commit()


def ensure_plant_min_productive_segment_minutes_column() -> None:
    """Idempotent B3 (2026-08-21) column: the plant-configurable productive-
    segment floor both Calendar.allocateRuntime (frontend, non-setup-aware)
    and placeWithSetup (frontend, setup-aware) enforce. NOT NULL DEFAULT 30
    preserves the prior fixed system-wide 30-minute behavior for every plant
    that never opts into an override. Redeploy-safe counterpart to
    schema.sql's ALTER TABLE block, same dual-provisioning pattern as
    split_order_policy/max_pull_forward_days above. Kept out of the grid,
    same as its siblings."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE plants ADD COLUMN IF NOT EXISTS min_productive_segment_minutes "
            "INTEGER NOT NULL DEFAULT 30"
        )
        conn.commit()


def ensure_plant_visibility_horizon_columns() -> None:
    """Idempotent Workstream C1 (2026-08-20) columns: how far into the future a
    planner can see on the Gantt/Orders tab. Redeploy-safe counterpart to
    schema.sql's ALTER TABLE block, following split_order_policy/
    max_pull_forward_days' dual-provisioning precedent (this repo's
    schema.sql-vs-boot-hook hazard — see workstream A's completion notes) so a
    normal boot against a pre-existing DB provisions these columns too, not
    just a fresh schema.sql apply. Kept out of the grid, same as its siblings."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS visibility_horizon_days INTEGER")
        cur.execute(
            "ALTER TABLE plants ADD COLUMN IF NOT EXISTS horizon_roll_hour_utc "
            "INTEGER NOT NULL DEFAULT 19"
        )
        conn.commit()


def ensure_plant_frozen_horizon_column() -> None:
    """Idempotent Workstream C2 (2026-08-20) column: the near-term window
    inside which the optimizer may not place or move any order. Nullable,
    NO default, and — unlike visibility_horizon_days — NULL/0 both mean
    "off" (validated in set_plant_frozen_horizon_days; this column itself
    stays a plain INTEGER, same shape as max_pull_forward_days). Redeploy-safe
    counterpart to schema.sql's ALTER TABLE block, same dual-provisioning
    pattern as visibility_horizon_days/max_pull_forward_days above. Kept out
    of the grid, same as its siblings."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS frozen_horizon_days INTEGER")
        conn.commit()


def ensure_plant_setup_active_column() -> None:
    """Idempotent plant-level "include setup times in optimizer" flag
    (Workstream D2, 2026-08-20) — relocated off the per-signature-version
    setup_definition.active. Kept out of the grid, same as its siblings
    above; changed only through PUT /plant/{plant}/setup-active."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS setup_active BOOLEAN NOT NULL DEFAULT FALSE")
        conn.commit()


def ensure_material_plant_attributes() -> None:
    """Idempotent: add material_plants.prt_01/prt_02/color/default_machine +
    their column_metadata rows. Mirrors migrations/2026-08-07-material-plant-attributes.sql
    and migrations/2026-08-10-material-plant-default-workcenter.sql (keep column
    names/types in sync with those files and with schema.sql's drift block) so
    a fresh dev DB — or a container pointed at a DB that missed a migration —
    still renders and can save the Material Plant grid's four editable
    columns."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_01 TEXT")
        cur.execute("ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS prt_02 TEXT")
        cur.execute("ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS color TEXT")
        cur.execute("ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS default_machine TEXT")
        cur.execute(
            """
            INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)
            VALUES
                ('material_plants', 'prt_01', 'Prod. Resource Tool (01)', FALSE, 8),
                ('material_plants', 'prt_02', 'Prod. Resource Tool (02)', FALSE, 9),
                ('material_plants', 'color',  'Color',                    FALSE, 10),
                ('material_plants', 'default_machine', 'Default Machine', FALSE, 11)
            ON CONFLICT (table_name, column_name) DO NOTHING
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_material_plants_plant_material"
            " ON material_plants(plant, material_id)"
        )
        conn.commit()


def _normalize_constraint_tree(nodes: list, depth: int = 1) -> list[dict]:
    """Recursive normalize+validate for the priority tree (Stage 3). Depth
    cap of 3 mirrors the UI's own cap (docs/scheduling_priority.md: with 4
    registered fields the effective sequence saturates at 4 keys regardless
    of nesting depth, so a deeper tree is never meaningful, not just
    disallowed for its own sake)."""
    if depth > 3:
        raise ValueError("constraint tree depth exceeds 3 (Stage 3 cap)")
    clean: list[dict] = []
    for c in nodes:
        if not isinstance(c, dict) or "key" not in c:
            raise ValueError("each constraint requires a 'key'")
        node = {
            "key":     str(c["key"]),
            "enabled": bool(c.get("enabled", False)),
            "order":   int(c.get("order", 0)),
        }
        children = c.get("children")
        if children:
            if not isinstance(children, list):
                raise ValueError("'children' must be a list")
            node["children"] = _normalize_constraint_tree(children, depth + 1)
        clean.append(node)
    return clean


def set_plant_constraints(subnetwork: str, plant: str, constraints: list,
                          user_email: str | None = None) -> dict:
    """Persist a plant's ordered constraint config. Each entry is normalized to
    {key:str, enabled:bool, order:int}, recursively preserving a 'children'
    list (the Stage 3 priority tree, sub-sorting one field under another),
    capped at depth 3. The plant row must already exist."""
    if not plant:
        raise ValueError("plant is required")
    if not isinstance(constraints, list):
        raise ValueError("constraints must be a list")

    clean = _normalize_constraint_tree(constraints)

    params: list = [Jsonb(clean), plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET constraints = %s, updated_at = NOW() WHERE {where}",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_constraints', %s, %s)",
            (Jsonb({"plant": plant, "constraints": clean}), user_email),
        )
        conn.commit()

    return {"status": "ok", "plant": plant, "constraints": clean}


def set_setup_line_compatibility(plant: str, machine: str, compatible: bool, reason: str | None,
                                 user_email: str | None = None) -> dict:
    """Persist the setup-only machine opt-out without touching excl_optimizer.

    This deliberately has its own narrow write path: generic machine
    bulk writes cannot enforce the required incompatibility reason and would
    make it too easy to conflate this setup signature exception with the
    existing global optimizer exclusion flag.
    """
    if not isinstance(compatible, bool):
        raise ValueError("setup_compatible must be boolean")
    plant = str(plant or "").strip()
    machine = str(machine or "").strip()
    reason = str(reason or "").strip() or None
    if not plant or not machine:
        raise ValueError("plant and machine are required")
    if not compatible and not reason:
        raise ValueError("Setup compatibility reason is required when incompatible")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE machine
                   SET setup_compatible = %s, setup_compatibility_reason = %s
                 WHERE plant = %s AND machine = %s""",
            (compatible, None if compatible else reason, plant, machine),
        )
        if cur.rowcount != 1:
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email) VALUES (%s, %s, %s, %s)",
            ("machine", "set_setup_compatibility",
             Jsonb({"plant": plant, "machine": machine, "setup_compatible": compatible,
                    "setup_compatibility_reason": None if compatible else reason}), user_email),
        )
        conn.commit()
    return {"plant": plant, "machine": machine, "setup_compatible": compatible,
            "setup_compatibility_reason": None if compatible else reason}


def get_setup_line_compatibility(plant: str, machine: str) -> dict:
    """Return one machine's setup-only compatibility, never a plant-wide machine list."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT setup_compatible, setup_compatibility_reason FROM machine WHERE plant = %s AND machine = %s", (plant, machine))
        row = cur.fetchone()
    if row is None:
        raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
    return {"plant": plant, "machine": machine, "setup_compatible": bool(row[0]), "setup_compatibility_reason": row[1]}


def set_plant_split_order_policy(subnetwork: str, plant: str, policy: str,
                                 user_email: str | None = None) -> dict:
    """Persist the plant's allocation policy after a strict server-side
    allowlist check. No caller can submit arbitrary optimizer configuration."""
    if not plant:
        raise ValueError("plant is required")
    clean = str(policy or '').strip().lower()
    if clean not in SPLIT_ORDER_POLICIES:
        raise ValueError("split_order_policy must be never, overlong_only, or partial_allowed")

    params: list = [clean, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET split_order_policy = %s, updated_at = NOW() WHERE {where}",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_split_order_policy', %s, %s)",
            (Jsonb({"plant": plant, "split_order_policy": clean}), user_email),
        )
        conn.commit()

    return {"status": "ok", "plant": plant, "split_order_policy": clean}


def set_plant_max_pull_forward_days(subnetwork: str, plant: str, value: int | None,
                                    user_email: str | None = None) -> dict:
    """Persist a nullable whole-calendar-day pull-forward limit for one plant."""
    if not plant:
        raise ValueError("plant is required")
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
        raise ValueError("max_pull_forward_days must be a non-negative integer or null")

    params: list = [value, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET max_pull_forward_days = %s, updated_at = NOW() WHERE {where}", params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_max_pull_forward_days', %s, %s)",
            (Jsonb({"plant": plant, "max_pull_forward_days": value}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "max_pull_forward_days": value}


def set_plant_min_productive_segment_minutes(subnetwork: str, plant: str, value: int,
                                             user_email: str | None = None) -> dict:
    """Persist the plant's B3 productive-segment floor (minutes). Unlike
    max_pull_forward_days/frozen_horizon_days this is NOT nullable — the
    column is NOT NULL DEFAULT 30, so every plant always has a well-defined
    floor even before an admin ever visits the Scheduling Rules panel; a
    caller wanting to reset to the system default passes 30 explicitly."""
    if not plant:
        raise ValueError("plant is required")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("min_productive_segment_minutes must be a positive integer")

    params: list = [value, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET min_productive_segment_minutes = %s, updated_at = NOW() WHERE {where}", params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_min_productive_segment_minutes', %s, %s)",
            (Jsonb({"plant": plant, "min_productive_segment_minutes": value}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "min_productive_segment_minutes": value}


def set_plant_visibility_horizon(subnetwork: str, plant: str, visibility_horizon_days: int | None,
                                 horizon_roll_hour_utc: int, user_email: str | None = None) -> dict:
    """Persist the plant's C1 visibility-horizon setting: a nullable
    whole-calendar-day window (NULL = unlimited) plus the UTC hour at which
    that window rolls forward a day. Both fields are saved together — they
    describe one setting, not two independent ones."""
    if not plant:
        raise ValueError("plant is required")
    if visibility_horizon_days is not None and (
        isinstance(visibility_horizon_days, bool) or not isinstance(visibility_horizon_days, int)
        or visibility_horizon_days < 0
    ):
        raise ValueError("visibility_horizon_days must be a non-negative integer or null")
    if (isinstance(horizon_roll_hour_utc, bool) or not isinstance(horizon_roll_hour_utc, int)
            or horizon_roll_hour_utc < 0 or horizon_roll_hour_utc > 23):
        raise ValueError("horizon_roll_hour_utc must be an integer between 0 and 23")

    params: list = [visibility_horizon_days, horizon_roll_hour_utc, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET visibility_horizon_days = %s, horizon_roll_hour_utc = %s, "
            f"updated_at = NOW() WHERE {where}",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_visibility_horizon', %s, %s)",
            (Jsonb({"plant": plant, "visibility_horizon_days": visibility_horizon_days,
                    "horizon_roll_hour_utc": horizon_roll_hour_utc}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "visibility_horizon_days": visibility_horizon_days,
            "horizon_roll_hour_utc": horizon_roll_hour_utc}


def set_plant_frozen_horizon_days(subnetwork: str, plant: str, value: int | None,
                                  user_email: str | None = None) -> dict:
    """Persist a nullable whole-calendar-day frozen-horizon window for one
    plant (Workstream C2, 2026-08-20). NULL or 0 both mean "off" — the
    optimizer-facing consumer (db.compute_frozen_horizon_end) already treats
    them identically, but this setter itself just validates non-negative-or-
    null the same shape as set_plant_max_pull_forward_days; it does not
    normalize 0 to NULL, so an admin who explicitly types 0 sees 0 persist."""
    if not plant:
        raise ValueError("plant is required")
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
        raise ValueError("frozen_horizon_days must be a non-negative integer or null")

    params: list = [value, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET frozen_horizon_days = %s, updated_at = NOW() WHERE {where}", params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_frozen_horizon_days', %s, %s)",
            (Jsonb({"plant": plant, "frozen_horizon_days": value}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "frozen_horizon_days": value}


def set_plant_setup_active(plant: str, active: bool, subnetwork: str | None = None,
                           user_email: str | None = None) -> dict:
    """Persist the plant-level "include setup times in optimizer" flag on
    plants.setup_active (Workstream D2, 2026-08-20).

    This is now the SOLE gate the optimizer/frontend read for setup-aware
    scheduling. It replaces (but does not remove) setup_definition.active,
    which is per-signature-version and force-reset to FALSE on every
    signature bump — a poor fit for a durable plant-level switch. Validated
    the same way set_setup_line_compatibility validates setup_compatible:
    a real bool or a rejection, no truthy-string coercion. Deliberately
    independent of machine.setup_compatible (a separate, per-machine
    concept) and of the setupSnapshot.plant identity check the frontend also
    consults — all three gates must stay separately inspectable."""
    if not isinstance(active, bool):
        raise ValueError("active must be boolean")
    plant = str(plant or "").strip()
    if not plant:
        raise ValueError("plant is required")
    subnetwork = str(subnetwork or "").strip()

    params: list = [active, plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET setup_active = %s, updated_at = NOW() WHERE {where}",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_setup_active', %s, %s)",
            (Jsonb({"plant": plant, "setup_active": active}), user_email),
        )
        conn.commit()

    return {"status": "ok", "plant": plant, "setup_active": active}


def get_plant_setup_active(plant: str) -> bool:
    """Read-only fetch of one plant's setup_active flag for GET /setup/{plant}
    to attach as `plant_active` — never raises for a plant that (unexpectedly)
    has no plants row, since this is a snapshot-embed read, not a write."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT setup_active FROM plants WHERE plant = %s LIMIT 1", (plant,))
        row = cur.fetchone()
    return bool(row[0]) if row else False


# Top-level pages a role's access can be toggled for. Must mirror the frontend
# TopLevelTab union (web/types.mts) and Session.DEFAULT_PAGE_ACCESS
# (web/schedule-data.mts) — keep the three in sync.
PAGE_ACCESS_KEYS = ('home', 'gantt', 'labor', 'masterdata', 'admin')


def set_role_page_access(role: str, pages: dict, user_email: str | None = None) -> dict:
    """Persist a role's per-page UI-visibility toggles into roles.settings.pages
    (JSONB, shallow-merged — untouched keys are preserved). Deliberately kept
    out of column_metadata, same as plants.constraints, so it never shows as
    an editable Master Data grid column. This is UI-visibility gating only
    (no endpoint-level enforcement), matching today's Admin Cockpit tab check.

    The 'admin' role can never have its own 'admin' page toggled off — a
    server-side backstop for the Roles tab's client-side self-lockout guard,
    so no path (bug, direct API call) can lock every admin out of Security."""
    if not role:
        raise ValueError("role is required")
    if not isinstance(pages, dict):
        raise ValueError("pages must be an object")
    clean = {k: bool(pages[k]) for k in PAGE_ACCESS_KEYS if k in pages}
    if not clean:
        raise ValueError("pages must include at least one known page key")
    if role == "admin" and clean.get("admin") is False:
        raise ValueError("The admin role cannot have Admin Cockpit access disabled")

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT settings FROM roles WHERE role = %s FOR UPDATE", (role,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Role {role!r} not found")
        settings = dict(row[0] or {})
        merged_pages = dict(settings.get("pages") or {})
        merged_pages.update(clean)
        settings["pages"] = merged_pages
        cur.execute(
            "UPDATE roles SET settings = %s, updated_at = NOW() WHERE role = %s",
            (Jsonb(settings), role),
        )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('roles', 'set_page_access', %s, %s)",
            (Jsonb({"role": role, "pages": merged_pages}), user_email),
        )
        conn.commit()

    return {"status": "ok", "role": role, "pages": merged_pages}


# ---------------------------------------------------------------------------
# System-wide settings (global, not per-user/per-plant) — currently just which
# optional Orders fields show by default in the AG Grid / Inspector panel.
# ---------------------------------------------------------------------------
def ensure_system_settings_table() -> None:
    """Idempotent: create the system_settings singleton table + seed row.
    Mirrors auth.ensure_user_settings_table()'s startup-bootstrap pattern but
    for a single global row (id always 1) instead of one row per user."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS system_settings (
                id         INTEGER PRIMARY KEY DEFAULT 1,
                settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                CONSTRAINT chk_system_settings_singleton CHECK (id = 1)
            )
        """)
        cur.execute(
            "INSERT INTO system_settings (id, settings) VALUES (1, '{}'::jsonb)"
            " ON CONFLICT (id) DO NOTHING"
        )
        conn.commit()


def get_system_settings() -> dict:
    """Return the global settings blob (e.g. {"orderFields": {...}}) directly —
    no wrapper envelope. Never raises; returns {} if the row is missing."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT settings FROM system_settings WHERE id = 1")
        row = cur.fetchone()
        return dict(row[0]) if row and row[0] else {}


def upsert_system_settings(patch: dict, user_email: str | None = None) -> dict:
    """Shallow-merge `patch`'s top-level keys into the global settings blob
    (e.g. patch={"orderFields": {...}} replaces just the 'orderFields' key,
    leaving any future sibling keys untouched — same merge idiom as
    set_role_page_access above) and audit-log the change. Returns the full
    post-merge settings blob, same unwrapped shape as get_system_settings()."""
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT settings FROM system_settings WHERE id = 1 FOR UPDATE")
        row = cur.fetchone()
        settings = dict(row[0]) if row and row[0] else {}
        settings.update(patch)
        cur.execute(
            "UPDATE system_settings SET settings = %s, updated_at = NOW() WHERE id = 1",
            (Jsonb(settings),),
        )
        if cur.rowcount == 0:
            # The table exists (bootstrapped at startup) but the singleton row
            # is somehow missing — self-heal rather than silently no-op.
            cur.execute(
                "INSERT INTO system_settings (id, settings) VALUES (1, %s)",
                (Jsonb(settings),),
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('system_settings', 'update', %s, %s)",
            (Jsonb(patch), user_email),
        )
        conn.commit()

    return settings


def list_audit(limit: int = 100) -> list[dict]:
    """Return the most recent N admin_audit entries for the Master Data tab."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, table_name, action, column_name, details, user_email, occurred_at"
            " FROM admin_audit ORDER BY occurred_at DESC LIMIT %s",
            (limit,),
        )
        return [
            {
                "id":          r[0],
                "table_name":  r[1],
                "action":      r[2],
                "column_name": r[3],
                "details":     r[4],
                "user_email":  r[5],
                "occurred_at": r[6].isoformat() if r[6] else None,
            }
            for r in cur.fetchall()
        ]


def _sql_literal(value) -> str:
    """Single-quoted SQL string literal with embedded quotes doubled."""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def _column_ddl_type(data_type: str, char_len: int | None,
                      num_precision: int | None, num_scale: int | None) -> str:
    """Map information_schema.columns' reported type back to the DDL keyword
    add_column() would have accepted (VARCHAR(n) / NUMERIC(p,s) need their
    size folded back in; the rest are 1:1 with ALLOWED_COLUMN_TYPES)."""
    dt = data_type.lower()
    if dt == "character varying":
        return f"VARCHAR({char_len})" if char_len else "VARCHAR"
    if dt == "numeric" and num_precision is not None:
        return f"NUMERIC({num_precision},{num_scale})" if num_scale is not None else f"NUMERIC({num_precision})"
    if dt == "timestamp without time zone":
        return "TIMESTAMP"
    return dt.upper()


def export_schema_sql() -> str:
    """
    Dump every column currently registered (via column_metadata) on every
    ALLOWED_TABLES table as idempotent SQL: ALTER TABLE ... ADD COLUMN IF NOT
    EXISTS + column_metadata INSERT ... ON CONFLICT DO NOTHING. Every
    statement is safe to re-run regardless of what's already present, so this
    is a "current truth" snapshot, not a diff — paste the whole thing into
    schema.sql / a migrations/*.sql file and nothing already-correct changes.

    This is the recovery path for columns added through the Manage Data
    Tables "Add Column" wizard (add_column, above), which mutates whichever
    DB is live (local or Azure) directly with no other record in git. Hit
    GET /master-data/_schema-export against whichever environment you want
    to check, and fold anything new into schema.sql.
    """
    blocks = []
    with _pool.connection() as conn, conn.cursor() as cur:
        for table in sorted(ALLOWED_TABLES):
            cur.execute(
                """
                SELECT cm.column_name, cm.display_label, cm.is_locked, cm.column_order,
                       c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale
                FROM column_metadata cm
                JOIN information_schema.columns c
                  ON c.table_name = cm.table_name
                 AND c.column_name = cm.column_name
                 AND c.table_schema = 'public'
                WHERE cm.table_name = %s
                ORDER BY cm.column_order, cm.column_name
                """,
                (table,),
            )
            rows = cur.fetchall()
            if not rows:
                continue

            lines = [f"-- {table}"]
            for column_name, _label, _locked, _order, data_type, char_len, num_prec, num_scale in rows:
                ddl_type = _column_ddl_type(data_type, char_len, num_prec, num_scale)
                lines.append(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column_name} {ddl_type};")

            values = ",\n    ".join(
                "({}, {}, {}, {}, {})".format(
                    _sql_literal(table), _sql_literal(column_name),
                    _sql_literal(display_label), "TRUE" if is_locked else "FALSE", column_order,
                )
                for column_name, display_label, is_locked, column_order, *_ in rows
            )
            lines.append(
                "INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES\n"
                f"    {values}\n"
                "ON CONFLICT (table_name, column_name) DO NOTHING;"
            )
            blocks.append("\n".join(lines))

    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Labor Planning — available labor hours by line group × ISO week (aggregate)
#                  and by production line × calendar day (line-level)
# ---------------------------------------------------------------------------

def ensure_labor_plan_table() -> None:
    """Idempotent: create/migrate labor_plan table (headcount → avail_hours)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS labor_plan (
                subnetwork  TEXT    NOT NULL,
                plant       TEXT    NOT NULL,
                wc_group    TEXT    NOT NULL,
                period      TEXT    NOT NULL,
                avail_hours NUMERIC,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, wc_group, period),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_labor_plan_plant ON labor_plan(plant)")
        # Migrate from old headcount column if it still exists
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='labor_plan' AND column_name='headcount'"
        )
        if cur.fetchone():
            cur.execute("ALTER TABLE labor_plan ADD COLUMN IF NOT EXISTS avail_hours NUMERIC")
            cur.execute("UPDATE labor_plan SET avail_hours = headcount WHERE avail_hours IS NULL AND headcount IS NOT NULL")
            cur.execute("ALTER TABLE labor_plan DROP COLUMN IF EXISTS headcount")
        conn.commit()


def ensure_labor_plan_machine_table() -> None:
    """Idempotent: create labor_plan_machine table."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS labor_plan_machine (
                subnetwork      TEXT    NOT NULL,
                plant           TEXT    NOT NULL,
                machine         TEXT    NOT NULL,
                day             TEXT    NOT NULL,
                avail_hours     NUMERIC,
                source          TEXT    NOT NULL DEFAULT 'auto_split',
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, machine, day)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_lpl_plant ON labor_plan_machine(plant)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_lpl_plant_line ON labor_plan_machine(plant, machine)")
        conn.commit()


def load_labor_plan(plant: str) -> dict:
    """Return all aggregate labor-plan cells (avail_hours) for the given plant."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT wc_group, period, avail_hours FROM labor_plan WHERE plant = %s ORDER BY wc_group, period",
            (plant,),
        )
        rows = [{"wc_group": r[0], "period": r[1], "avail_hours": float(r[2]) if r[2] is not None else None}
                for r in cur.fetchall()]
    return {"rows": rows}


def upsert_labor_plan(subnetwork: str, plant: str, cells: list, user_email: str | None = None) -> dict:
    """Upsert or delete aggregate labor-plan cells. A null/empty avail_hours deletes the cell."""
    if not subnetwork or not plant:
        raise ValueError("subnetwork and plant are required")
    valid = [c for c in cells if c.get("wc_group") and c.get("period")]
    to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
    to_upsert = [c for c in valid if c not in to_delete]
    with _pool.connection() as conn, conn.cursor() as cur:
        deleted = 0
        if to_delete:
            cur.execute(
                "DELETE FROM labor_plan WHERE subnetwork=%s AND plant=%s"
                " AND (wc_group, period) IN (SELECT unnest(%s::text[]), unnest(%s::text[]))",
                (subnetwork, plant,
                 [c["wc_group"] for c in to_delete],
                 [c["period"] for c in to_delete]),
            )
            deleted = cur.rowcount
        upserted = 0
        if to_upsert:
            cur.executemany(
                "INSERT INTO labor_plan (subnetwork, plant, wc_group, period, avail_hours)"
                " VALUES (%s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, wc_group, period)"
                " DO UPDATE SET avail_hours = EXCLUDED.avail_hours, updated_at = NOW()",
                [(subnetwork, plant, c["wc_group"], c["period"], c["avail_hours"])
                 for c in to_upsert],
            )
            upserted = len(to_upsert)
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('labor_plan', 'upsert', %s, %s)",
            (Jsonb({"upserted": upserted, "deleted": deleted, "plant": plant}), user_email),
        )
        conn.commit()
    return {"upserted": upserted, "deleted": deleted}


def load_labor_plan_machine(plant: str, group: str | None = None,
                         from_date: str | None = None, to_date: str | None = None) -> dict:
    """Return line-level labor plan cells, optionally filtered by wc_group and date range."""
    with _pool.connection() as conn, conn.cursor() as cur:
        conditions = ["lpl.plant = %s"]
        params: list = [plant]
        if group:
            conditions.append("pl.wc_group = %s")
            params.append(group)
        if from_date:
            conditions.append("lpl.day >= %s")
            params.append(from_date)
        if to_date:
            conditions.append("lpl.day <= %s")
            params.append(to_date)
        where = " AND ".join(conditions)
        cur.execute(
            f"""
            SELECT lpl.machine, lpl.day, lpl.avail_hours, lpl.source
            FROM labor_plan_machine lpl
            LEFT JOIN machine pl
              ON pl.machine = lpl.machine AND pl.plant = lpl.plant
            WHERE {where}
            ORDER BY lpl.machine, lpl.day
            """,
            params,
        )
        rows = [
            {"machine": r[0], "day": r[1],
             "avail_hours": float(r[2]) if r[2] is not None else None, "source": r[3]}
            for r in cur.fetchall()
        ]
    return {"rows": rows}


def upsert_labor_plan_machine(subnetwork: str, plant: str, cells: list, user_email: str | None = None) -> dict:
    """Upsert or delete line-level labor cells."""
    if not subnetwork or not plant:
        raise ValueError("subnetwork and plant are required")
    valid = [c for c in cells if c.get("machine") and c.get("day")]
    to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
    to_upsert = [c for c in valid if c not in to_delete]
    with _pool.connection() as conn, conn.cursor() as cur:
        deleted = 0
        if to_delete:
            cur.execute(
                "DELETE FROM labor_plan_machine WHERE subnetwork=%s AND plant=%s"
                " AND (machine, day) IN (SELECT unnest(%s::text[]), unnest(%s::text[]))",
                (subnetwork, plant,
                 [c["machine"] for c in to_delete],
                 [c["day"] for c in to_delete]),
            )
            deleted = cur.rowcount
        upserted = 0
        if to_upsert:
            cur.executemany(
                "INSERT INTO labor_plan_machine"
                " (subnetwork, plant, machine, day, avail_hours, source)"
                " VALUES (%s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, machine, day)"
                " DO UPDATE SET avail_hours = EXCLUDED.avail_hours,"
                " source = EXCLUDED.source, updated_at = NOW()",
                [(subnetwork, plant, c["machine"], c["day"],
                  c["avail_hours"], c.get("source", "auto_split"))
                 for c in to_upsert],
            )
            upserted = len(to_upsert)
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('labor_plan_machine', 'upsert', %s, %s)",
            (Jsonb({"upserted": upserted, "deleted": deleted, "plant": plant}), user_email),
        )
        conn.commit()
    return {"upserted": upserted, "deleted": deleted}


# ---------------------------------------------------------------------------
# Plant / line calendars (working hours) + blackout blocks
#   Working hours: plants.work_hours JSONB (plant-level) + machine_calendar table
#   (line-level). Blackouts: machine_blackout / plant_blackout tables.
#   Writes are DELTA-based (explicit upserts + explicit deletes), never
#   prune-by-omission. machine_blackout.machine NULL = "all lines in this
#   plant". Working-hours shape mirrors the frontend Store: {"0".."6": [h1,h2]|null}
#   (0=Sun..6=Sat; null=closed; fractional hours ok).
# ---------------------------------------------------------------------------

def ensure_work_hours_columns() -> None:
    """Idempotent: add plants.work_hours JSONB (plant-level weekly hours). Kept
    out of column_metadata (like plants.constraints) so it never renders as an
    editable Master Data grid column. Line-level hours live in the machine_calendar
    table (below), NOT on machine, so order-derived lines that lag master
    data still persist."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS work_hours JSONB")
        conn.commit()


def ensure_machine_calendar_table() -> None:
    """Idempotent: per-line working hours (work_hours JSONB). No FK to
    machine (mirrors labor_plan_machine) so a calendar may be authored
    before its line master row exists; only the plants FK is enforced."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS machine_calendar (
                subnetwork      TEXT NOT NULL,
                plant           TEXT NOT NULL,
                machine         TEXT NOT NULL,
                work_hours      JSONB,
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, machine),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_machine_calendar_plant ON machine_calendar(plant)")
        conn.commit()


def ensure_machine_blackout_table() -> None:
    """Idempotent: per-plant line blackout blocks. machine NULL = all
    lines in the plant. block_id is client-supplied (Util.uid 'blk'). No FK to
    machine (a block may precede its line row); plants FK cascades."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS machine_blackout (
                subnetwork      TEXT      NOT NULL,
                plant           TEXT      NOT NULL,
                machine         TEXT,          -- NULL = all lines in this plant
                block_id        TEXT      NOT NULL,   -- client-supplied (Util.uid 'blk')
                start_ts        TIMESTAMP NOT NULL,
                end_ts          TIMESTAMP NOT NULL,
                reason          TEXT,
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, block_id),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT chk_machine_blackout_range CHECK (end_ts > start_ts)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_machine_blackout_plant ON machine_blackout(plant)")
        conn.commit()


def ensure_machine_key_columns() -> None:
    """Idempotent: add the generated machine_key identity column ({subnetwork}_
    {plant}_{machine}) to the three machine-scoped tables that are
    startup-hook-authoritative for prod (labor_plan_machine/machine_calendar/
    machine_blackout are NOT re-provisioned by schema.sql on redeploy — see
    DEPLOYMENT.md). machine/orders are NOT handled here: they have
    no ensure_* hook and rely on schema.sql / a dated migrations/*.sql apply
    instead.

    Per-table (not a uniform loop): index name AND uniqueness both vary,
    mirroring schema.sql exactly — machine_calendar's is UNIQUE (one calendar
    row per machine); labor_plan_machine's and machine_blackout's are plain
    indexes (many day rows share a machine; many blackout blocks — or NULL,
    "all machines" — share a machine_key)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        # (table, index name, unique)
        specs = (
            ("labor_plan_machine", "idx_lpl_machine_key", False),
            ("machine_calendar", "uq_machine_calendar_machine_key", True),
            ("machine_blackout", "idx_machine_blackout_machine_key", False),
        )
        for table, index_name, unique in specs:
            cur.execute(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS machine_key TEXT "
                f"GENERATED ALWAYS AS (subnetwork || '_' || plant || '_' || machine) STORED"
            )
            index_kw = "UNIQUE INDEX" if unique else "INDEX"
            cur.execute(f"CREATE {index_kw} IF NOT EXISTS {index_name} ON {table}(machine_key)")
        conn.commit()


def ensure_plant_blackout_table() -> None:
    """Idempotent: per-plant plant-level blackout blocks. block_id client-supplied
    (Util.uid 'pblk'). Cross-plant-global blocks are not persisted (per-plant model)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS plant_blackout (
                subnetwork  TEXT      NOT NULL,
                plant       TEXT      NOT NULL,
                block_id    TEXT      NOT NULL,   -- client-supplied (Util.uid 'pblk')
                start_ts    TIMESTAMP NOT NULL,
                end_ts      TIMESTAMP NOT NULL,
                reason      TEXT,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, block_id),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT chk_plant_blackout_range CHECK (end_ts > start_ts)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_plant_blackout_plant ON plant_blackout(plant)")
        conn.commit()


def ensure_unique_plant() -> None:
    """Idempotent: enforce that a plant code is globally unique across subnetworks
    — an invariant the app already assumes (getPlantForLine, /tasks?plant=,
    plant-only constraint updates). If duplicates already exist, skip with a
    warning (do not fail startup); in that case _resolve_subnetwork's ambiguity
    ValueError is the correct fail-loud behavior."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM plants GROUP BY plant HAVING COUNT(*) > 1")
        dupes = [r[0] for r in cur.fetchall()]
        if dupes:
            # Surface LOUDLY: with a duplicate plant code, _resolve_subnetwork raises
            # ambiguity ValueError -> every calendar/blackout POST for that plant 400s,
            # silently disabling calendar persistence for it. Operators must see this.
            # (F10 — full fix is sending subnetwork on the write path; see MIGRATION.md.)
            log.warning(
                "Skipping UNIQUE(plant): duplicate plant codes across subnetworks %s "
                "— calendar/blackout persistence is DISABLED for these plants until the "
                "catalog is deduped or the write path is made subnetwork-aware.",
                sorted(dupes),
            )
            try:
                cur.execute(
                    "INSERT INTO admin_audit (table_name, action, details, user_email)"
                    " VALUES ('plants', 'unique_plant_skipped', %s, %s)",
                    (Jsonb({"duplicate_plants": sorted(dupes),
                            "impact": "calendar persistence disabled for these plants"}), None),
                )
                conn.commit()
            except psycopg.Error:
                pass  # audit is best-effort; never fail startup on it
            return
        cur.execute("SELECT 1 FROM pg_constraint WHERE conname = 'uq_plants_plant'")
        if not cur.fetchone():
            cur.execute("ALTER TABLE plants ADD CONSTRAINT uq_plants_plant UNIQUE (plant)")
        conn.commit()


# ----- helpers -------------------------------------------------------------

def _resolve_subnetwork(cur, plant: str) -> str:
    """Resolve a plant's subnetwork server-side (the frontend keys by plant only).
    Unknown plant or ambiguous (>1 subnetwork) -> ValueError. Ambiguity is
    unreachable once ensure_unique_plant's UNIQUE(plant) holds. This is the SOLE
    owner of subnetwork resolution for the calendar/blackout endpoints."""
    if not plant:
        raise ValueError("plant is required")
    cur.execute("SELECT DISTINCT subnetwork FROM plants WHERE plant = %s", (plant,))
    rows = [r[0] for r in cur.fetchall()]
    if not rows:
        raise ValueError(f"Plant {plant!r} is not in Master Data")
    if len(rows) > 1:
        raise ValueError(f"Plant {plant!r} exists under multiple subnetworks {sorted(rows)}; cannot resolve")
    return rows[0]


def _clean_work_hours(work_hours) -> dict:
    """Validate/normalize a {0..6: [start,end]|null} weekly working-hours map.
    Keys become strings '0'..'6'; each value is null (closed) or [start,end]
    floats with 0 <= start < end <= 24."""
    if not isinstance(work_hours, dict):
        raise ValueError("work_hours must be an object keyed 0..6")
    clean: dict = {}
    for k, v in work_hours.items():
        try:
            day = int(k)
        except (TypeError, ValueError):
            raise ValueError(f"work_hours key {k!r} is not a day 0..6") from None
        if not (0 <= day <= 6):
            raise ValueError(f"work_hours day out of range: {k!r}")
        if v is None:
            clean[str(day)] = None
            continue
        if (not isinstance(v, (list, tuple)) or len(v) != 2
                or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)):
            raise ValueError(f"work_hours[{day}] must be [start, end] numbers or null")
        s, e = float(v[0]), float(v[1])
        if not (0 <= s < e <= 24):
            raise ValueError(f"work_hours[{day}] range invalid: {v!r} (need 0 <= start < end <= 24)")
        clean[str(day)] = [s, e]
    return clean


def _iso_utc(dt):
    """Serialize a stored UTC-naive datetime back to an ISO string with a 'Z'
    suffix so the frontend's new Date(...) parses it as UTC. Intentionally
    DIFFERENT from the orders read path (bare strftime, no Z) — do not unify."""
    return dt.isoformat() + "Z" if dt is not None else None


def _parse_ts(v):
    """Parse a JS ISO timestamp ('...Z' or offset) into a UTC-naive datetime for
    the naive TIMESTAMP columns. Returns None if unparseable/empty."""
    if not v:
        return None
    if isinstance(v, datetime):
        dt = v
    elif isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


# ----- working hours -------------------------------------------------------

def set_plant_work_hours(plant: str, work_hours, user_email: str | None = None) -> dict:
    """Persist a plant's weekly working hours to plants.work_hours (JSONB).
    Empty/None work_hours clears it (SET NULL). The plant row must exist."""
    clean = _clean_work_hours(work_hours) if work_hours else None
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        cur.execute(
            "UPDATE plants SET work_hours = %s, updated_at = NOW()"
            " WHERE plant = %s AND subnetwork = %s",
            (Jsonb(clean) if clean is not None else None, plant, subnet),
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_work_hours', %s, %s)",
            (Jsonb({"plant": plant, "subnetwork": subnet, "work_hours": clean}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "work_hours": clean}


def set_line_work_hours(plant: str, lines: list, user_email: str | None = None) -> dict:
    """Upsert per-line working hours into machine_calendar. `lines` is
    [{machine, work_hours}]. Null/empty work_hours clears that line's
    hours (SET NULL). No machine dependency — order-derived lines
    persist. Idempotent per line via ON CONFLICT."""
    if not isinstance(lines, list):
        raise ValueError("lines must be a list")
    prepared = []
    for item in lines:
        code = (item or {}).get("machine")
        if not code:
            continue
        wh = item.get("work_hours")
        clean = _clean_work_hours(wh) if wh else None
        prepared.append((code, clean))
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        if prepared:
            cur.executemany(
                "INSERT INTO machine_calendar (subnetwork, plant, machine, work_hours)"
                " VALUES (%s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, machine)"
                " DO UPDATE SET work_hours = EXCLUDED.work_hours, updated_at = NOW()",
                [(subnet, plant, code, Jsonb(clean) if clean is not None else None)
                 for code, clean in prepared],
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('machine_calendar', 'upsert', %s, %s)",
            (Jsonb({"plant": plant, "subnetwork": subnet, "lines": len(prepared)}), user_email),
        )
        conn.commit()
    return {"upserted": len(prepared)}


# ----- blackouts (delta: explicit upserts + explicit deletes) --------------

def _prepare_blackouts(upserts: list, *, with_line: bool) -> list:
    """Validate/normalize blackout upserts into executemany tuples. Rejects
    missing id/start/end and inverted ranges (end <= start)."""
    out = []
    for b in (upserts or []):
        bid = b.get("id")
        s = _parse_ts(b.get("start"))
        e = _parse_ts(b.get("end"))
        if not bid or s is None or e is None:
            raise ValueError(f"blackout {bid!r} is missing id/start/end")
        if e <= s:
            raise ValueError(f"blackout {bid!r} has an inverted range (end <= start)")
        if with_line:
            out.append((b.get("machine") or None, bid, s, e, b.get("reason")))
        else:
            out.append((bid, s, e, b.get("reason")))
    return out


def save_machine_blackouts(plant: str, upserts: list, deletes: list | None = None,
                        user_email: str | None = None) -> dict:
    """Delta write of machine blackouts: upsert the given blocks and delete the given
    ids. NEVER prunes by omission. machine NULL = all machines in the plant."""
    prepared = _prepare_blackouts(upserts, with_line=True)
    del_ids = [d for d in (deletes or []) if d]
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        deleted = 0
        if del_ids:
            cur.execute(
                "DELETE FROM machine_blackout WHERE subnetwork = %s AND plant = %s"
                " AND block_id = ANY(%s)",
                (subnet, plant, del_ids),
            )
            deleted = cur.rowcount
        if prepared:
            cur.executemany(
                "INSERT INTO machine_blackout"
                " (subnetwork, plant, machine, block_id, start_ts, end_ts, reason)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, block_id) DO UPDATE SET"
                " machine = EXCLUDED.machine, start_ts = EXCLUDED.start_ts,"
                " end_ts = EXCLUDED.end_ts, reason = EXCLUDED.reason, updated_at = NOW()",
                [(subnet, plant, line, bid, s, e, reason)
                 for (line, bid, s, e, reason) in prepared],
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('machine_blackout', 'save', %s, %s)",
            (Jsonb({"plant": plant, "subnetwork": subnet,
                    "upserted": len(prepared), "deleted": deleted}), user_email),
        )
        conn.commit()
    return {"upserted": len(prepared), "deleted": deleted}


def save_plant_blackouts(plant: str, upserts: list, deletes: list | None = None,
                         user_email: str | None = None) -> dict:
    """Delta write of plant-level blackouts (upsert + explicit delete)."""
    prepared = _prepare_blackouts(upserts, with_line=False)
    del_ids = [d for d in (deletes or []) if d]
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        deleted = 0
        if del_ids:
            cur.execute(
                "DELETE FROM plant_blackout WHERE subnetwork = %s AND plant = %s"
                " AND block_id = ANY(%s)",
                (subnet, plant, del_ids),
            )
            deleted = cur.rowcount
        if prepared:
            cur.executemany(
                "INSERT INTO plant_blackout"
                " (subnetwork, plant, block_id, start_ts, end_ts, reason)"
                " VALUES (%s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, block_id) DO UPDATE SET"
                " start_ts = EXCLUDED.start_ts, end_ts = EXCLUDED.end_ts,"
                " reason = EXCLUDED.reason, updated_at = NOW()",
                [(subnet, plant, bid, s, e, reason)
                 for (bid, s, e, reason) in prepared],
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plant_blackout', 'save', %s, %s)",
            (Jsonb({"plant": plant, "subnetwork": subnet,
                    "upserted": len(prepared), "deleted": deleted}), user_email),
        )
        conn.commit()
    return {"upserted": len(prepared), "deleted": deleted}


# ----- loaders (hydration) -------------------------------------------------

def load_machine_blackouts(plant: str) -> list:
    """Return a plant's machine blackouts. machine NULL surfaces as machine=None
    ('all machines in this plant'). Own connection (transaction isolation). Returns []
    if the table doesn't exist yet (pre-migration/restored DB) so the consolidated
    GET honors its 'never 500s' contract for the blackout slices too. (F6)"""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT block_id, machine, start_ts, end_ts, reason"
                " FROM machine_blackout WHERE plant = %s"
                " ORDER BY machine NULLS FIRST, start_ts",
                (plant,),
            )
            return [
                {"id": r[0], "machine": r[1], "start": _iso_utc(r[2]),
                 "end": _iso_utc(r[3]), "reason": r[4]}
                for r in cur.fetchall()
            ]
    except psycopg.errors.UndefinedTable:
        return []


def load_plant_blackouts(plant: str) -> list:
    """Return a plant's plant-level blackouts. Own connection. Returns [] if the table
    is absent (pre-migration/restored DB) — see load_machine_blackouts. (F6)"""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT block_id, start_ts, end_ts, reason"
                " FROM plant_blackout WHERE plant = %s ORDER BY start_ts",
                (plant,),
            )
            return [
                {"id": r[0], "start": _iso_utc(r[1]), "end": _iso_utc(r[2]), "reason": r[3]}
                for r in cur.fetchall()
            ]
    except psycopg.errors.UndefinedTable:
        return []


def load_plant_calendar(plant: str) -> dict:
    """Consolidated per-plant hydration payload: plant work hours, all line work
    hours, line blackouts, plant blackouts. Transaction-safe: probes for the
    work_hours columns via information_schema up front, so a pre-migration DB
    degrades to empty rather than throwing UndefinedColumn (which would poison the
    read transaction -> InFailedSqlTransaction -> 500). Never 500s on unknown plant."""
    if not plant:
        raise ValueError("plant is required")
    subnet = None
    plant_wh = None
    line_wh: dict = {}
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            subnet = _resolve_subnetwork(cur, plant)
        except ValueError:
            subnet = None  # unknown/ambiguous -> plant-only reads; never hard-fail the GET
        cur.execute(
            "SELECT table_name FROM information_schema.columns"
            " WHERE table_schema='public' AND column_name='work_hours'"
            " AND table_name IN ('plants','machine_calendar')"
        )
        wh_tables = {r[0] for r in cur.fetchall()}
        if 'plants' in wh_tables:
            if subnet:
                cur.execute("SELECT work_hours FROM plants WHERE plant=%s AND subnetwork=%s", (plant, subnet))
            else:
                cur.execute("SELECT work_hours FROM plants WHERE plant=%s LIMIT 1", (plant,))
            row = cur.fetchone()
            plant_wh = row[0] if row else None
        if 'machine_calendar' in wh_tables:
            cur.execute(
                "SELECT machine, work_hours FROM machine_calendar"
                " WHERE plant=%s AND work_hours IS NOT NULL",
                (plant,),
            )
            line_wh = {r[0]: r[1] for r in cur.fetchall()}
    return {
        "plant": plant,
        "subnetwork": subnet,
        "plant_work_hours": plant_wh,
        "line_work_hours": line_wh,
        "machine_blackouts": load_machine_blackouts(plant),
        "plant_blackouts": load_plant_blackouts(plant),
    }


def known_plant_line_codes() -> dict:
    """Return all plant and production-line codes for upload validation."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM plants")
        plants = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT machine FROM machine")
        lines = {r[0] for r in cur.fetchall()}
    return {"plants": plants, "lines": lines}


def known_line_codes_for_plant(plant: str) -> set[str]:
    """Return production-line codes for ONE plant — for validating an uploaded
    priority-list file's optional Line column against that specific plant
    (N4), unlike known_plant_line_codes()'s whole-catalog sets used by /upload."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT machine FROM machine WHERE plant = %s", (plant,))
        return {r[0] for r in cur.fetchall()}


def known_material_plant_pairs() -> set[tuple[str, str]]:
    """Return every (material_id, plant) pair currently in material_plants, for
    validating a BOM upload — both the parent material and the component of
    every bom_items row must already exist at that plant (bom_items' two FKs
    both reference material_plants(material_id, plant))."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT material_id, plant FROM material_plants")
        return {(r[0], r[1]) for r in cur.fetchall()}


# Required SAP/export headers, after clean()-style STRIP→UPPER→spaces-to-
# underscores normalization ("Item Number" -> "ITEM_NUMBER"). Add aliases in
# the row loop below if a real SAP export uses different headers, mirroring
# how db.ingest_orders_from_excel handles ORDER/WERKS variants.
_BOM_REQUIRED = {"MATERIAL", "PLANT", "ALTERNATIVE_BOM", "LEVEL", "ITEM_NUMBER", "COMPONENT"}


def ingest_bom_from_excel(file_bytes: bytes, filename: str, user_email: str | None = None) -> dict:
    """
    Parse an uploaded BOM export (.xlsx) and upsert into bom_items.

    Both (material_id, plant) and (component_id, plant) must already exist in
    material_plants — bom_items' two FKs both reference material_plants
    (material_id, plant), and a component is always sourced from the same
    plant as its parent material. Rows that reference an unknown pair (or are
    missing a key field) are rejected individually rather than failing the
    whole upload, mirroring db.ingest_orders_from_excel's warnings-not-hard-
    fail style — reused here via bulk_apply so the ON CONFLICT upsert,
    admin_audit logging, and FK-violation handling stay in one place.

    Returns: {status, raw_row_count, inserted, updated, rejected, warnings}.
    """
    try:
        df = pd.read_excel(io.BytesIO(file_bytes))
    except Exception as e:
        return {"status": "error", "message": f"Could not parse xlsx: {e}",
                "raw_row_count": 0, "inserted": 0, "updated": 0, "rejected": 0, "warnings": []}

    df.columns = df.columns.astype(str).str.strip().str.upper().str.replace(" ", "_")
    raw_row_count = len(df)

    missing = _BOM_REQUIRED - set(df.columns)
    if missing:
        return {"status": "error",
                "message": f"Uploaded file is missing required columns: {sorted(missing)}",
                "raw_row_count": raw_row_count, "inserted": 0, "updated": 0, "rejected": 0, "warnings": []}

    for date_col in ("VALID_FROM", "VALID_TO", "CHANGED_ON"):
        if date_col in df.columns:
            df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    for num_col in ("BASE_QUANTITY", "COMPONENT_QUANTITY", "LEVEL"):
        if num_col in df.columns:
            df[num_col] = pd.to_numeric(df[num_col], errors="coerce")

    known_pairs = known_material_plant_pairs()
    warnings: list[dict] = []
    valid_rows: list[dict] = []
    rejected = 0

    def _num(v):
        return None if pd.isna(v) else float(v)

    def _date(v):
        return v.date().isoformat() if pd.notna(v) else None

    for _, r in df.iterrows():
        material_id = _str_id(r.get("MATERIAL"))
        plant = _str_id(r.get("PLANT"))
        component_id = _str_id(r.get("COMPONENT"))
        alternative_bom = _str_id(r.get("ALTERNATIVE_BOM"))
        item_number = _str_id(r.get("ITEM_NUMBER"))
        level = r.get("LEVEL")

        if not material_id or not plant or not component_id or not alternative_bom \
                or not item_number or pd.isna(level):
            rejected += 1
            continue
        if (material_id, plant) not in known_pairs:
            rejected += 1
            warnings.append({"level": "error",
                              "msg": f"Row rejected: material {material_id!r} not found at plant {plant!r} in material_plants"})
            continue
        if (component_id, plant) not in known_pairs:
            rejected += 1
            warnings.append({"level": "error",
                              "msg": f"Row rejected: component {component_id!r} not found at plant {plant!r} in material_plants"})
            continue

        valid_rows.append({
            "material_id": material_id,
            "plant": plant,
            "alternative_bom": alternative_bom,
            "level": int(level),
            "item_number": item_number,
            "component_id": component_id,
            "base_quantity": _num(r.get("BASE_QUANTITY")),
            "item_category": _str_id(r.get("ITEM_CATEGORY")),
            "assembly": _str_id(r.get("ASSEMBLY")),
            "component_quantity": _num(r.get("COMPONENT_QUANTITY")),
            "base_unit_of_measure": _str_id(r.get("BASE_UNIT_OF_MEASURE")),
            "valid_from": _date(r.get("VALID_FROM")),
            "valid_to": _date(r.get("VALID_TO")),
            "changed_on": _date(r.get("CHANGED_ON")),
            "change_number": _str_id(r.get("CHANGE_NUMBER")),
        })

    result = bulk_apply("bom_items", {"upserts": valid_rows, "deletes": []}, user_email=user_email)
    return {
        "status": "ok",
        "raw_row_count": raw_row_count,
        "inserted": result["inserted"],
        "updated": result["updated"],
        "rejected": rejected,
        # Cap: a bad file could otherwise produce thousands of near-identical
        # rejection entries and bloat the response.
        "warnings": warnings[:200],
    }


def plants_for_line(line: str) -> list[str]:
    """Distinct plants a machine code currently appears under. May
    return more than one — a line code is not guaranteed unique across
    plants (composite PK on machine). Used by /tasks' per-user
    plant-scope check for ?line=-only requests: a shared line code should
    count as allowed if ANY of its plants is in the caller's allowed set."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT plant FROM machine WHERE machine = %s", (line,))
        return [r[0] for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Roles / Role-Plant mappings — self-bootstrapped generic-CRUD tables.
#   Both are registered in ALLOWED_TABLES, so the generic Master Data grid
#   (list_rows/bulk_apply) reads and writes them directly; that read path
#   INNER JOINs column_metadata, so each table's rows must be seeded here too
#   or the grid comes back empty. role_plants FKs roles(role), so
#   ensure_roles_table() must run before ensure_role_plants_table() at
#   startup (see brain.py lifespan()).
# ---------------------------------------------------------------------------
def ensure_roles_table() -> None:
    """Idempotent: create the roles table + seed its column_metadata rows."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS roles (
                role        TEXT PRIMARY KEY,
                description TEXT NOT NULL DEFAULT '',
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.executemany(
            "INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)"
            " VALUES (%s, %s, %s, %s, %s) ON CONFLICT (table_name, column_name) DO NOTHING",
            [
                ("roles", "role", "Role", True, 1),
                ("roles", "description", "Description", False, 2),
            ],
        )
        conn.commit()


def ensure_role_plants_table() -> None:
    """Idempotent: create the role_plants table (role -> plant assignments)
    + seed its column_metadata rows. FKs roles(role) ON DELETE CASCADE, so
    roles must already exist — call ensure_roles_table() first."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS role_plants (
                role        TEXT NOT NULL REFERENCES roles(role) ON DELETE CASCADE ON UPDATE CASCADE,
                plant       TEXT NOT NULL,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (role, plant)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_role_plants_plant ON role_plants(plant)")
        cur.executemany(
            "INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order)"
            " VALUES (%s, %s, %s, %s, %s) ON CONFLICT (table_name, column_name) DO NOTHING",
            [
                ("role_plants", "role", "Role", True, 1),
                ("role_plants", "plant", "Plant", True, 2),
            ],
        )
        conn.commit()
