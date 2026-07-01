"""
NIMBUS 2.0 — Master Data layer (Subnetwork / Plant / Production Line).

Safe DDL surface: every dynamic identifier is routed through
psycopg.sql.Identifier; every type literal is validated against a whitelist
before being composed with psycopg.sql.SQL; every value goes through a
parameter placeholder.  The user cannot inject SQL through any of these paths.
"""
import logging
import re
from datetime import datetime, timezone

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

# Import the shared pool from the existing db module.
from db import _pool

# Child of brain.py's `nimbus.*` structured-logging tree (propagates up), so a
# narrowed-but-unexpected error class here still reaches the operator log.
log = logging.getLogger("nimbus.md")

# ---------------------------------------------------------------------------
# Safety constants
# ---------------------------------------------------------------------------
ALLOWED_TABLES = frozenset({
    'subnetworks', 'plants', 'production_lines',
    'materials', 'material_plants',
})

ALLOWED_COLUMN_TYPES = frozenset({'TEXT', 'INTEGER', 'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP'})

COLUMN_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{0,62}$')

# System columns the UI must never see or touch.
SYSTEM_COLUMNS = frozenset({'created_at', 'updated_at'})

# Key columns per table — is_locked in column_metadata, but also enforced here.
_KEY_COLUMNS = {
    'subnetworks':      frozenset({'code'}),
    'plants':           frozenset({'subnetwork', 'plant'}),
    'production_lines': frozenset({'subnetwork', 'plant', 'production_line'}),
    'materials':        frozenset({'material_id'}),
    'material_plants':  frozenset({'material_id', 'plant'}),
}


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


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------
def list_rows(table: str, limit: int | None = None, offset: int | None = None,
              plant: str | None = None) -> dict:
    """
    Return column metadata + data rows for the given table.

    Optional server-side scoping (all default to current full-catalog behavior):
      - `plant`: filter to rows whose `plant` column matches (only honored when
        the table actually has a `plant` column; ignored otherwise).
      - `limit`/`offset`: parameterized LIMIT/OFFSET page window.
    When any of these are supplied, `meta.total` carries the full row count for
    the same filter (ignoring limit/offset) so callers can paginate.
    """
    _assert_table(table)

    with _pool.connection() as conn, conn.cursor() as cur:
        # Column metadata in display order, excluding system columns.
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
        columns = [
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

        col_names = [c["column_name"] for c in columns]

        if not col_names:
            return {"columns": [], "rows": [], "meta": {"total": 0}}

        # Optional plant filter — only when the table actually has a plant column.
        where_sql = sql.SQL("")
        where_params: list = []
        if plant and "plant" in col_names:
            where_sql = sql.SQL(" WHERE {col} = %s").format(col=sql.Identifier("plant"))
            where_params = [plant]

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

        # Plants carry a JSONB `constraints` column (per-plant switchable
        # constraint config). It is intentionally NOT registered in
        # column_metadata, so it never appears as an editable grid column — but
        # we attach it to each row dict so the frontend (Settings pane +
        # optimizer) can read it alongside the visible columns. Scope the fetch
        # to the plants on this page so a paged/filtered request never re-scans
        # the whole table.
        if table == 'plants':
            try:
                page_plants = list({r.get('plant') for r in rows if r.get('plant') is not None})
                if page_plants:
                    cur.execute(
                        "SELECT subnetwork, plant, constraints FROM plants WHERE plant = ANY(%s)",
                        (page_plants,),
                    )
                    cmap = {(r[0], r[1]): r[2] for r in cur.fetchall()}
                    for row in rows:
                        row['constraints'] = cmap.get((row.get('subnetwork'), row.get('plant')))
            except psycopg.errors.UndefinedColumn:
                pass  # column not migrated yet — leave it absent (expected)
            except Exception:
                # Any other failure is unexpected: degrade (leave constraints
                # absent) but log it rather than swallowing the whole class.
                log.warning("Unexpected error attaching plant constraints",
                            exc_info=True, extra={"category": "master_data"})

    return {"columns": columns, "rows": rows, "meta": {"total": total}}


def cascade_preview(table: str, deletes: list[dict]) -> dict:
    """Return how many child rows would cascade-delete if these rows are removed.

    The result dict carries every child-table key that can ever appear (seeded to 0)
    so the delete-confirmation UI always has a stable shape to render.
    """
    _assert_table(table)
    # Seed all child-table keys so a missing branch reads as 0, not "absent".
    result = {"plants": 0, "production_lines": 0, "material_plants": 0}
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
                    "SELECT COUNT(*) FROM production_lines WHERE subnetwork = ANY(%s)", (codes,)
                )
                result["production_lines"] = int(cur.fetchone()[0])

        elif table == "plants":
            # Each delete dict should have {subnetwork, plant}
            plines = 0
            for d in deletes:
                if d.get("subnetwork") and d.get("plant"):
                    cur.execute(
                        "SELECT COUNT(*) FROM production_lines WHERE subnetwork = %s AND plant = %s",
                        (d["subnetwork"], d["plant"]),
                    )
                    plines += int(cur.fetchone()[0])
            result["production_lines"] = plines

        elif table == "materials":
            # material_plants FK: material_id REFERENCES materials(material_id) ON DELETE CASCADE.
            material_ids = [d.get("material_id") for d in deletes if d.get("material_id")]
            if material_ids:
                cur.execute(
                    "SELECT COUNT(*) FROM material_plants WHERE material_id = ANY(%s)",
                    (material_ids,),
                )
                result["material_plants"] = int(cur.fetchone()[0])

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
        # --- Deletes first so upserts don't conflict with to-be-deleted rows ---
        for d in deletes:
            where = sql.SQL(" AND ").join(
                sql.SQL("{} = {}").format(sql.Identifier(k), sql.Placeholder())
                for k in keys
            )
            vals = [d[k] for k in keys]
            cur.execute(
                sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(table), where),
                vals,
            )
            deleted += cur.rowcount

        # --- Upserts ---
        for row in upserts:
            # Only pass columns that actually exist in the table (guard against stale client)
            col_names = [c for c in row if c not in SYSTEM_COLUMNS]
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
            cur.execute(q, [row[c] for c in col_names])
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


def set_plant_constraints(subnetwork: str, plant: str, constraints: list,
                          user_email: str | None = None) -> dict:
    """Persist a plant's ordered constraint config. Each entry is normalized to
    {key:str, enabled:bool, order:int}. The plant row must already exist."""
    if not plant:
        raise ValueError("plant is required")
    if not isinstance(constraints, list):
        raise ValueError("constraints must be a list")

    clean: list[dict] = []
    for c in constraints:
        if not isinstance(c, dict) or "key" not in c:
            raise ValueError("each constraint requires a 'key'")
        clean.append({
            "key":     str(c["key"]),
            "enabled": bool(c.get("enabled", False)),
            "order":   int(c.get("order", 0)),
        })

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
                pl_group    TEXT    NOT NULL,
                period      TEXT    NOT NULL,
                avail_hours NUMERIC,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, pl_group, period),
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


def ensure_labor_plan_line_table() -> None:
    """Idempotent: create labor_plan_line table."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS labor_plan_line (
                subnetwork      TEXT    NOT NULL,
                plant           TEXT    NOT NULL,
                production_line TEXT    NOT NULL,
                day             TEXT    NOT NULL,
                avail_hours     NUMERIC,
                source          TEXT    NOT NULL DEFAULT 'auto_split',
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, production_line, day)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_lpl_plant ON labor_plan_line(plant)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_lpl_plant_line ON labor_plan_line(plant, production_line)")
        conn.commit()


def load_labor_plan(plant: str) -> dict:
    """Return all aggregate labor-plan cells (avail_hours) for the given plant."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pl_group, period, avail_hours FROM labor_plan WHERE plant = %s ORDER BY pl_group, period",
            (plant,),
        )
        rows = [{"pl_group": r[0], "period": r[1], "avail_hours": float(r[2]) if r[2] is not None else None}
                for r in cur.fetchall()]
    return {"rows": rows}


def upsert_labor_plan(subnetwork: str, plant: str, cells: list, user_email: str | None = None) -> dict:
    """Upsert or delete aggregate labor-plan cells. A null/empty avail_hours deletes the cell."""
    if not subnetwork or not plant:
        raise ValueError("subnetwork and plant are required")
    valid = [c for c in cells if c.get("pl_group") and c.get("period")]
    to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
    to_upsert = [c for c in valid if c not in to_delete]
    with _pool.connection() as conn, conn.cursor() as cur:
        deleted = 0
        if to_delete:
            cur.execute(
                "DELETE FROM labor_plan WHERE subnetwork=%s AND plant=%s"
                " AND (pl_group, period) IN (SELECT unnest(%s::text[]), unnest(%s::text[]))",
                (subnetwork, plant,
                 [c["pl_group"] for c in to_delete],
                 [c["period"] for c in to_delete]),
            )
            deleted = cur.rowcount
        upserted = 0
        if to_upsert:
            cur.executemany(
                "INSERT INTO labor_plan (subnetwork, plant, pl_group, period, avail_hours)"
                " VALUES (%s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, pl_group, period)"
                " DO UPDATE SET avail_hours = EXCLUDED.avail_hours, updated_at = NOW()",
                [(subnetwork, plant, c["pl_group"], c["period"], c["avail_hours"])
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


def load_labor_plan_line(plant: str, group: str | None = None,
                         from_date: str | None = None, to_date: str | None = None) -> dict:
    """Return line-level labor plan cells, optionally filtered by pl_group and date range."""
    with _pool.connection() as conn, conn.cursor() as cur:
        conditions = ["lpl.plant = %s"]
        params: list = [plant]
        if group:
            conditions.append("pl.pl_group = %s")
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
            SELECT lpl.production_line, lpl.day, lpl.avail_hours, lpl.source
            FROM labor_plan_line lpl
            LEFT JOIN production_lines pl
              ON pl.production_line = lpl.production_line AND pl.plant = lpl.plant
            WHERE {where}
            ORDER BY lpl.production_line, lpl.day
            """,
            params,
        )
        rows = [
            {"production_line": r[0], "day": r[1],
             "avail_hours": float(r[2]) if r[2] is not None else None, "source": r[3]}
            for r in cur.fetchall()
        ]
    return {"rows": rows}


def upsert_labor_plan_line(subnetwork: str, plant: str, cells: list, user_email: str | None = None) -> dict:
    """Upsert or delete line-level labor cells."""
    if not subnetwork or not plant:
        raise ValueError("subnetwork and plant are required")
    valid = [c for c in cells if c.get("production_line") and c.get("day")]
    to_delete = [c for c in valid if c.get("avail_hours") is None or c.get("avail_hours") == ""]
    to_upsert = [c for c in valid if c not in to_delete]
    with _pool.connection() as conn, conn.cursor() as cur:
        deleted = 0
        if to_delete:
            cur.execute(
                "DELETE FROM labor_plan_line WHERE subnetwork=%s AND plant=%s"
                " AND (production_line, day) IN (SELECT unnest(%s::text[]), unnest(%s::text[]))",
                (subnetwork, plant,
                 [c["production_line"] for c in to_delete],
                 [c["day"] for c in to_delete]),
            )
            deleted = cur.rowcount
        upserted = 0
        if to_upsert:
            cur.executemany(
                "INSERT INTO labor_plan_line"
                " (subnetwork, plant, production_line, day, avail_hours, source)"
                " VALUES (%s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, production_line, day)"
                " DO UPDATE SET avail_hours = EXCLUDED.avail_hours,"
                " source = EXCLUDED.source, updated_at = NOW()",
                [(subnetwork, plant, c["production_line"], c["day"],
                  c["avail_hours"], c.get("source", "auto_split"))
                 for c in to_upsert],
            )
            upserted = len(to_upsert)
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('labor_plan_line', 'upsert', %s, %s)",
            (Jsonb({"upserted": upserted, "deleted": deleted, "plant": plant}), user_email),
        )
        conn.commit()
    return {"upserted": upserted, "deleted": deleted}


# ---------------------------------------------------------------------------
# Plant / line calendars (working hours) + blackout blocks
#   Working hours: plants.work_hours JSONB (plant-level) + line_calendar table
#   (line-level). Blackouts: line_blackout / plant_blackout tables.
#   Writes are DELTA-based (explicit upserts + explicit deletes), never
#   prune-by-omission. line_blackout.production_line NULL = "all lines in this
#   plant". Working-hours shape mirrors the frontend Store: {"0".."6": [h1,h2]|null}
#   (0=Sun..6=Sat; null=closed; fractional hours ok).
# ---------------------------------------------------------------------------

def ensure_work_hours_columns() -> None:
    """Idempotent: add plants.work_hours JSONB (plant-level weekly hours). Kept
    out of column_metadata (like plants.constraints) so it never renders as an
    editable Master Data grid column. Line-level hours live in the line_calendar
    table (below), NOT on production_lines, so order-derived lines that lag master
    data still persist."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE plants ADD COLUMN IF NOT EXISTS work_hours JSONB")
        conn.commit()


def ensure_line_calendar_table() -> None:
    """Idempotent: per-line working hours (work_hours JSONB). No FK to
    production_lines (mirrors labor_plan_line) so a calendar may be authored
    before its line master row exists; only the plants FK is enforced."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS line_calendar (
                subnetwork      TEXT NOT NULL,
                plant           TEXT NOT NULL,
                production_line TEXT NOT NULL,
                work_hours      JSONB,
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, production_line),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_line_calendar_plant ON line_calendar(plant)")
        conn.commit()


def ensure_line_blackout_table() -> None:
    """Idempotent: per-plant line blackout blocks. production_line NULL = all
    lines in the plant. block_id is client-supplied (Util.uid 'blk'). No FK to
    production_lines (a block may precede its line row); plants FK cascades."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS line_blackout (
                subnetwork      TEXT      NOT NULL,
                plant           TEXT      NOT NULL,
                production_line TEXT,                 -- NULL = all lines in this plant
                block_id        TEXT      NOT NULL,   -- client-supplied (Util.uid 'blk')
                start_ts        TIMESTAMP NOT NULL,
                end_ts          TIMESTAMP NOT NULL,
                reason          TEXT,
                created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subnetwork, plant, block_id),
                FOREIGN KEY (subnetwork, plant) REFERENCES plants(subnetwork, plant)
                    ON DELETE CASCADE ON UPDATE CASCADE,
                CONSTRAINT chk_line_blackout_range CHECK (end_ts > start_ts)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_line_blackout_plant ON line_blackout(plant)")
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
        if cur.fetchone():
            log.warning("Skipping UNIQUE(plant): duplicate plant codes exist across subnetworks")
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
            raise ValueError(f"work_hours key {k!r} is not a day 0..6")
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
    """Upsert per-line working hours into line_calendar. `lines` is
    [{production_line, work_hours}]. Null/empty work_hours clears that line's
    hours (SET NULL). No production_lines dependency — order-derived lines
    persist. Idempotent per line via ON CONFLICT."""
    if not isinstance(lines, list):
        raise ValueError("lines must be a list")
    prepared = []
    for item in lines:
        code = (item or {}).get("production_line")
        if not code:
            continue
        wh = item.get("work_hours")
        clean = _clean_work_hours(wh) if wh else None
        prepared.append((code, clean))
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        if prepared:
            cur.executemany(
                "INSERT INTO line_calendar (subnetwork, plant, production_line, work_hours)"
                " VALUES (%s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, production_line)"
                " DO UPDATE SET work_hours = EXCLUDED.work_hours, updated_at = NOW()",
                [(subnet, plant, code, Jsonb(clean) if clean is not None else None)
                 for code, clean in prepared],
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('line_calendar', 'upsert', %s, %s)",
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
            out.append((b.get("line") or None, bid, s, e, b.get("reason")))
        else:
            out.append((bid, s, e, b.get("reason")))
    return out


def save_line_blackouts(plant: str, upserts: list, deletes: list | None = None,
                        user_email: str | None = None) -> dict:
    """Delta write of line blackouts: upsert the given blocks and delete the given
    ids. NEVER prunes by omission. production_line NULL = all lines in the plant."""
    prepared = _prepare_blackouts(upserts, with_line=True)
    del_ids = [d for d in (deletes or []) if d]
    with _pool.connection() as conn, conn.cursor() as cur:
        subnet = _resolve_subnetwork(cur, plant)
        deleted = 0
        if del_ids:
            cur.execute(
                "DELETE FROM line_blackout WHERE subnetwork = %s AND plant = %s"
                " AND block_id = ANY(%s)",
                (subnet, plant, del_ids),
            )
            deleted = cur.rowcount
        if prepared:
            cur.executemany(
                "INSERT INTO line_blackout"
                " (subnetwork, plant, production_line, block_id, start_ts, end_ts, reason)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (subnetwork, plant, block_id) DO UPDATE SET"
                " production_line = EXCLUDED.production_line, start_ts = EXCLUDED.start_ts,"
                " end_ts = EXCLUDED.end_ts, reason = EXCLUDED.reason, updated_at = NOW()",
                [(subnet, plant, line, bid, s, e, reason)
                 for (line, bid, s, e, reason) in prepared],
            )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('line_blackout', 'save', %s, %s)",
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

def load_line_blackouts(plant: str) -> list:
    """Return a plant's line blackouts. production_line NULL surfaces as line=None
    ('all lines in this plant'). Own connection (transaction isolation)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT block_id, production_line, start_ts, end_ts, reason"
            " FROM line_blackout WHERE plant = %s"
            " ORDER BY production_line NULLS FIRST, start_ts",
            (plant,),
        )
        return [
            {"id": r[0], "line": r[1], "start": _iso_utc(r[2]),
             "end": _iso_utc(r[3]), "reason": r[4]}
            for r in cur.fetchall()
        ]


def load_plant_blackouts(plant: str) -> list:
    """Return a plant's plant-level blackouts. Own connection."""
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
            " AND table_name IN ('plants','line_calendar')"
        )
        wh_tables = {r[0] for r in cur.fetchall()}
        if 'plants' in wh_tables:
            if subnet:
                cur.execute("SELECT work_hours FROM plants WHERE plant=%s AND subnetwork=%s", (plant, subnet))
            else:
                cur.execute("SELECT work_hours FROM plants WHERE plant=%s LIMIT 1", (plant,))
            row = cur.fetchone()
            plant_wh = row[0] if row else None
        if 'line_calendar' in wh_tables:
            cur.execute(
                "SELECT production_line, work_hours FROM line_calendar"
                " WHERE plant=%s AND work_hours IS NOT NULL",
                (plant,),
            )
            line_wh = {r[0]: r[1] for r in cur.fetchall()}
    return {
        "plant": plant,
        "subnetwork": subnet,
        "plant_work_hours": plant_wh,
        "line_work_hours": line_wh,
        "line_blackouts": load_line_blackouts(plant),
        "plant_blackouts": load_plant_blackouts(plant),
    }


def known_plant_line_codes() -> dict:
    """Return all plant and production-line codes for upload validation."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM plants")
        plants = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT production_line FROM production_lines")
        lines = {r[0] for r in cur.fetchall()}
    return {"plants": plants, "lines": lines}
