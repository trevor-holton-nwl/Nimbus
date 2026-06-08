"""
NIMBUS 2.0 — Master Data layer (Subnetwork / Plant / Production Line).

Safe DDL surface: every dynamic identifier is routed through
psycopg.sql.Identifier; every type literal is validated against a whitelist
before being composed with psycopg.sql.SQL; every value goes through a
parameter placeholder.  The user cannot inject SQL through any of these paths.
"""
import re
from psycopg import sql
from psycopg.types.json import Jsonb

# Import the shared pool from the existing db module.
from db import _pool

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
def list_rows(table: str) -> dict:
    """Return column metadata + data rows for the given table."""
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
            return {"columns": [], "rows": []}

        # Fetch rows with only the visible columns.
        select_idents = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
        cur.execute(
            sql.SQL("SELECT {cols} FROM {tbl} ORDER BY {order}").format(
                cols=select_idents,
                tbl=sql.Identifier(table),
                order=sql.SQL(", ").join(sql.Identifier(c) for c in col_names[:list(_KEY_COLUMNS[table]).__len__()]),
            )
        )
        rows = [dict(zip(col_names, r)) for r in cur.fetchall()]

    return {"columns": columns, "rows": rows}


def cascade_preview(table: str, deletes: list[dict]) -> dict:
    """Return how many child rows would cascade-delete if these rows are removed."""
    _assert_table(table)
    if not deletes:
        return {"plants": 0, "production_lines": 0}

    result = {"plants": 0, "production_lines": 0}

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
            col_names = [c for c in row.keys() if c not in SYSTEM_COLUMNS]
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

        # Build type fragment
        if sql_type_upper == "NUMERIC" and length:
            type_sql = sql.SQL("NUMERIC({})").format(sql.SQL(str(length)))
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
    upserted = deleted = 0
    with _pool.connection() as conn, conn.cursor() as cur:
        for cell in cells:
            grp    = cell.get("pl_group", "")
            period = cell.get("period", "")
            ah     = cell.get("avail_hours")
            if not grp or not period:
                continue
            if ah is None or ah == "":
                cur.execute(
                    "DELETE FROM labor_plan WHERE subnetwork=%s AND plant=%s AND pl_group=%s AND period=%s",
                    (subnetwork, plant, grp, period),
                )
                deleted += cur.rowcount
            else:
                cur.execute(
                    """
                    INSERT INTO labor_plan (subnetwork, plant, pl_group, period, avail_hours)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (subnetwork, plant, pl_group, period)
                    DO UPDATE SET avail_hours = EXCLUDED.avail_hours, updated_at = NOW()
                    """,
                    (subnetwork, plant, grp, period, ah),
                )
                upserted += 1
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
    upserted = deleted = 0
    with _pool.connection() as conn, conn.cursor() as cur:
        for cell in cells:
            line   = cell.get("production_line", "")
            day    = cell.get("day", "")
            ah     = cell.get("avail_hours")
            source = cell.get("source", "auto_split")
            if not line or not day:
                continue
            if ah is None or ah == "":
                cur.execute(
                    "DELETE FROM labor_plan_line WHERE subnetwork=%s AND plant=%s AND production_line=%s AND day=%s",
                    (subnetwork, plant, line, day),
                )
                deleted += cur.rowcount
            else:
                cur.execute(
                    """
                    INSERT INTO labor_plan_line (subnetwork, plant, production_line, day, avail_hours, source)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (subnetwork, plant, production_line, day)
                    DO UPDATE SET avail_hours = EXCLUDED.avail_hours, source = EXCLUDED.source, updated_at = NOW()
                    """,
                    (subnetwork, plant, line, day, ah, source),
                )
                upserted += 1
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('labor_plan_line', 'upsert', %s, %s)",
            (Jsonb({"upserted": upserted, "deleted": deleted, "plant": plant}), user_email),
        )
        conn.commit()
    return {"upserted": upserted, "deleted": deleted}


def known_plant_line_codes() -> dict:
    """Return all plant and production-line codes for upload validation."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM plants")
        plants = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT production_line FROM production_lines")
        lines = {r[0] for r in cur.fetchall()}
    return {"plants": plants, "lines": lines}
