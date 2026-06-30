"""
NIMBUS 2.0 — Postgres data layer.

This module is the single home for all Postgres connection management,
schema-aware queries, and Excel-upload ingestion.  brain.py imports the
public API from here; nothing else in the project should hold a connection.

Connection string is hardcoded for the POC, mirroring how INPUT_FILE /
COLOR_FILE are hardcoded in brain.py.  Swap to env vars / Azure managed
identity at the migration step.
"""
import hashlib
import io
import logging
import os
import uuid

from dotenv import load_dotenv
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

load_dotenv()

# Child of brain.py's `nimbus.*` structured-logging tree (propagates up).
log = logging.getLogger("nimbus.db")

# =========================
# CONNECTION
# =========================
PG_HOST = os.getenv("PG_HOST", "localhost")
PG_PORT = int(os.getenv("PG_PORT", "5432"))
PG_DB   = os.getenv("PG_DB",   "nimbus")
PG_USER = os.getenv("PG_USER", "postgres")
PG_PASS = os.getenv("PG_PASS", "")
# Azure Database for PostgreSQL Flexible Server requires TLS — set PG_SSLMODE=require
# in .env when pointing at Azure. Default "prefer" keeps local dev unchanged.
PG_SSLMODE = os.getenv("PG_SSLMODE", "prefer")

# Pool + safety knobs. Defaults are tuned for the stateless read path (every
# request issues a DB query, so the old max_size=5 became a bottleneck under
# concurrency / multiple workers). All env-overridable with sane defaults —
# no secret handling here, just operational tuning.
PG_POOL_MIN = int(os.environ.get("NIMBUS_PG_POOL_MIN", "2"))   # 2 warm conns = no cold-start latency
PG_POOL_MAX = int(os.environ.get("NIMBUS_PG_POOL_MAX", "20"))
PG_POOL_TIMEOUT = float(os.environ.get("NIMBUS_PG_POOL_TIMEOUT", "10"))  # s to wait for a free conn
PG_STATEMENT_TIMEOUT_MS = int(os.environ.get("NIMBUS_PG_STATEMENT_TIMEOUT_MS", "30000"))

# statement_timeout is set as a libpq startup option so it survives the pool's
# per-checkin transaction reset (a `SET` inside a rolled-back tx would be lost).
CONN_STR = (
    f"host={PG_HOST} port={PG_PORT} dbname={PG_DB} "
    f"user={PG_USER} password={PG_PASS} sslmode={PG_SSLMODE} "
    f"options='-c statement_timeout={PG_STATEMENT_TIMEOUT_MS}'"
)

# min_size=2 keeps warm connections ready so the first /tasks load doesn't pay
# connection setup latency. Overridable to 0 via env var if needed at import time.
_pool = ConnectionPool(
    CONN_STR,
    min_size=PG_POOL_MIN,
    max_size=PG_POOL_MAX,
    timeout=PG_POOL_TIMEOUT,
    open=True,
)


# =========================
# HELPERS (lifted from brain.py so brain.py doesn't have to know about them)
# =========================
def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize column names: strip → uppercase → spaces to underscores."""
    df.columns = (
        df.columns.astype(str)
        .str.strip()
        .str.upper()
        .str.replace(" ", "_")
    )
    return df


def _str_id(val) -> str:
    """Normalize a SAP numeric ID — strips Excel float suffix: '1000261702.0' → '1000261702'."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    if s.endswith('.0') and s[:-2].lstrip('-').isdigit():
        return s[:-2]
    return s


def make_id(production_order, material_number) -> str:
    """MD5 of 'PRODUCTION_ORDER|MATERIAL_NUMBER' — deterministic across reloads."""
    key = f"{_str_id(production_order)}|{_str_id(material_number)}"
    return hashlib.md5(key.encode()).hexdigest()


# =========================
# ERROR TRANSLATION
# =========================
# SQLSTATE → stable error_code + HTTP status. brain.py wires this into a
# psycopg.Error exception handler so an uncaught IntegrityError surfaces as a
# clean, actionable client message (constraint name, not a raw 500) without ever
# leaking SQL/paths. master_data.py write funcs let psycopg.Error propagate to
# that handler rather than collapsing it to a generic 500.
_SQLSTATE_ERROR_CODES = {
    "23505": ("db.unique_violation",      409),
    "23503": ("db.fk_violation",          409),
    "23502": ("db.not_null",              400),
    "23514": ("db.check_violation",       400),
    "57014": ("db.lock_timeout",          503),
    "40001": ("db.serialization_failure", 503),
    "40P01": ("db.deadlock",              503),
}


def translate_db_error(exc) -> dict:
    """Translate a psycopg.Error into a stable {error_code, http_status,
    client_message, …diag} dict. Unknown SQLSTATEs fall back to db.error/500.

    client_message is safe to show a user (constraint/column name only, never the
    raw SQL or server paths); the full str(exc)/traceback stays in admin logs."""
    sqlstate = getattr(exc, "sqlstate", None)
    diag = getattr(exc, "diag", None)
    constraint_name = getattr(diag, "constraint_name", None) if diag else None
    table_name      = getattr(diag, "table_name", None) if diag else None
    column_name     = getattr(diag, "column_name", None) if diag else None
    detail          = getattr(diag, "message_detail", None) if diag else None
    hint            = getattr(diag, "message_hint", None) if diag else None

    error_code, http_status = _SQLSTATE_ERROR_CODES.get(sqlstate, ("db.error", 500))

    # Actionable, leak-free client message per error class.
    if sqlstate == "23505":
        client_message = (f"Duplicate value violates constraint {constraint_name}"
                          if constraint_name else "Duplicate value violates a unique constraint")
    elif sqlstate == "23503":
        client_message = (f"Still referenced by rows in {table_name}"
                          if table_name else "Still referenced by related rows")
    elif sqlstate == "23502":
        client_message = (f"Required field missing: {column_name}"
                          if column_name else "A required field is missing")
    elif sqlstate == "23514":
        client_message = (f"Value violates constraint {constraint_name}"
                          if constraint_name else "A value violates a check constraint")
    elif sqlstate in ("57014",):
        client_message = "The database operation timed out — please retry"
    elif sqlstate in ("40001", "40P01"):
        client_message = "The database is busy — please retry"
    else:
        client_message = "A database error occurred"

    return {
        "error_code":      error_code,
        "sqlstate":        sqlstate,
        "constraint_name": constraint_name,
        "table_name":      table_name,
        "column_name":     column_name,
        "detail":          detail,
        "hint":            hint,
        "client_message":  client_message,
        "http_status":     http_status,
    }


# =========================
# QUERIES — read
# =========================
# Shared projection for the orders read path. Column aliases are the contract the
# frontend/brain.py rely on; user scheduling overrides take precedence over the
# SAP-source dates via COALESCE so callers only ever see one start/end per order.
_ORDERS_SELECT = """
    SELECT
        id,
        production_order      AS "PRODUCTION_ORDER",
        material_number       AS "MATERIAL_NUMBER",
        material_description  AS "MATERIAL_DESCRIPTION",
        o.production_line     AS "PRODUCTION_LINE",
        o.plant               AS "PLANT",
        COALESCE(scheduled_start, basic_start_date) AS "BASIC_START_DATE",
        COALESCE(scheduled_end,   basic_finish_date) AS "BASIC_FINISH_DATE",
        basic_start_date      AS "ORIGINAL_START_DATE",
        basic_finish_date     AS "ORIGINAL_END_DATE",
        (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL) AS "USER_SCHEDULED",
        run_time              AS "RUN_TIME",
        color                 AS "COLOR",
        order_quantity        AS "ORDER_QUANTITY_(GMEIN)",
        form_size             AS "FORM_SIZE",
        notes                 AS "NOTES",
        firming_indicator     AS "FIRMING_INDICATOR",
        -- Optimistic-concurrency token. xmin is the txid that last wrote the row;
        -- it changes on every UPDATE, gives exact integer equality (no timestamp
        -- precision/tz fragility), and needs no schema column. Cast via text because
        -- xmin's native type (xid) has no direct bigint cast.
        o.xmin::text::bigint  AS "ROW_VERSION"
    FROM orders o
"""


def load_orders_df() -> pd.DataFrame:
    """
    Return ALL orders as a DataFrame. Used by diagnostics/admin paths only —
    the hot /tasks read path uses query_orders() with server-side scoping.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(_ORDERS_SELECT)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def query_orders(plant: str | None = None, line: str | None = None,
                 limit: int | None = None, offset: int | None = None) -> pd.DataFrame:
    """
    Server-side-scoped orders read for the stateless /tasks path.

    The scaling unit is the PLANT: pass `plant=` to bound the result to a single
    plant (~70 lines) so we never materialize the whole order book. `line=`
    narrows further. `limit`/`offset` are a coarse guard rail for unscoped
    tooling queries only — finish-to-start links are coherent only within a
    plant/line scope, never across a blind offset window.

    All filter values are bound as parameters (no string interpolation).
    Rows are ordered by (production_line, effective start) so brain.py's
    per-line link builder sees each line contiguously.
    """
    sql = _ORDERS_SELECT
    where, params = [], []
    if plant:
        where.append('o.plant = %s')
        params.append(plant)
    if line:
        where.append('o.production_line = %s')
        params.append(line)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += '\n    ORDER BY o.production_line, COALESCE(scheduled_start, basic_start_date)'
    if limit is not None:
        sql += " LIMIT %s"
        params.append(int(limit))
    if offset:
        sql += " OFFSET %s"
        params.append(int(offset))
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def count_orders(plant: str | None = None, line: str | None = None) -> int:
    """Row count for a plant/line scope — for pagination totals / tooling."""
    sql = "SELECT COUNT(*) FROM orders o"
    where, params = [], []
    if plant:
        where.append('o.plant = %s')
        params.append(plant)
    if line:
        where.append('o.production_line = %s')
        params.append(line)
    if where:
        sql += " WHERE " + " AND ".join(where)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return int(row[0]) if row else 0


def distinct_order_colors() -> list[str]:
    """
    Distinct non-NULL color values across the orders table. Used by the
    diagnostics color-coverage panel instead of a full-table load — only the
    color column is read, so the DB does the de-dup and no DataFrame is built.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT color FROM orders WHERE color IS NOT NULL")
        rows = cur.fetchall()
    return [r[0] for r in rows]


def reattribute_null_plant_orders() -> int:
    """
    Re-derive orders.plant where it is still NULL, from the line->plant master-data
    mapping. Call this after production_lines change so orders uploaded BEFORE their
    line existed in master data become plant-attributed and stop being invisible to
    the plant-scoped read path. The old LEFT-JOIN read path self-healed automatically
    on every request; a materialized plant does not, so this is the explicit hook.
    Idempotent: only NULL-plant rows whose line now exists are touched. Returns the
    number of orders re-attributed.

    A line code shared across plants CANNOT be attributed correctly from the code
    alone, so such rows are left NULL (and logged) rather than silently assigned to
    the lexically-lowest plant. The authoritative fix is an explicit plant column on
    upload + a plant-aware make_id (see MIGRATION.md).
    """
    sql = """
        UPDATE orders o
           SET plant = (
               SELECT MIN(pl.plant) FROM production_lines pl
                WHERE pl.production_line = o.production_line
           )
         WHERE o.plant IS NULL
           AND (
               SELECT COUNT(DISTINCT pl.plant) FROM production_lines pl
                WHERE pl.production_line = o.production_line
           ) = 1
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        n = cur.rowcount
        # Report (don't guess) lines that map to >1 plant and so stay unattributed.
        cur.execute(
            """
            SELECT o.production_line, COUNT(*)
              FROM orders o
             WHERE o.plant IS NULL
               AND (
                   SELECT COUNT(DISTINCT pl.plant) FROM production_lines pl
                    WHERE pl.production_line = o.production_line
               ) > 1
             GROUP BY o.production_line
            """
        )
        ambiguous = cur.fetchall()
        conn.commit()
    if ambiguous:
        total = sum(int(r[1]) for r in ambiguous)
        lines = ", ".join(str(r[0]) for r in ambiguous)
        log.warning(
            "reattribute_null_plant_orders: %d order(s) left unattributed — "
            "line code(s) shared across multiple plants: %s", total, lines,
        )
    return n


def get_task_versions(ids: list[str]) -> list[dict]:
    """
    Lean refetch for optimistic-concurrency conflict reconciliation: current effective
    dates + xmin row version for specific order ids only. No color-merge / link
    machinery — the client uses this to overwrite the stale copies a concurrent edit
    changed underneath it.
    """
    if not ids:
        return []
    sql = """
        SELECT id,
               COALESCE(scheduled_start, basic_start_date)  AS eff_start,
               COALESCE(scheduled_end,   basic_finish_date) AS eff_end,
               xmin::text::bigint                           AS row_version
        FROM orders WHERE id = ANY(%s)
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (ids,))
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "start_date": r[1].strftime("%Y-%m-%dT%H:%M:%S") if r[1] else None,
            "end_date":   r[2].strftime("%Y-%m-%dT%H:%M:%S") if r[2] else None,
            "row_version": int(r[3]) if r[3] is not None else None,
        }
        for r in rows
    ]


def upload_audit_log(limit: int = 50) -> list[dict]:
    """Recent uploads, newest first, for the Admin Cockpit history card."""
    sql = """
        SELECT batch_id, filename, row_count,
               inserted_count, updated_count, uploaded_at, warnings
        FROM upload_audit
        ORDER BY uploaded_at DESC
        LIMIT %s
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()
    return [
        {
            "batch_id": str(r[0]),
            "filename": r[1],
            "row_count": r[2],
            "inserted": r[3],
            "updated": r[4],
            "uploaded_at": r[5].isoformat() if r[5] else None,
            "warnings": r[6] or [],
        }
        for r in rows
    ]


# =========================
# QUERIES — write
# =========================
def update_task_dates(task_id: str, start_date=None, end_date=None) -> dict:
    """
    Persist a manual drag/drop or override edit by writing to
    scheduled_start / scheduled_end.  Never touches the SAP-source columns
    so the next upload doesn't have to think about user edits.
    """
    if start_date is None and end_date is None:
        return {"status": "ok", "updated": 0}
    sets, params = [], []
    if start_date is not None:
        sets.append("scheduled_start = %s")
        params.append(start_date)
    if end_date is not None:
        sets.append("scheduled_end = %s")
        params.append(end_date)
    sets.append("updated_at = NOW()")
    params.append(task_id)
    sql = f"UPDATE orders SET {', '.join(sets)} WHERE id = %s"
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        updated = cur.rowcount
        conn.commit()
    return {"status": "ok", "updated": updated}


def update_task_dates_bulk(items: list[dict]) -> dict:
    """
    Persist a batch of start/end edits in a SINGLE transaction (one commit),
    replacing the old commit-per-row path. Each item: {id, start, end} where
    start/end are datetime|None.

    Inverted ranges are rejected by validating each edit against the row's
    *effective* current dates (so updating only start still checks against the
    existing end). Unknown ids are reported, not written.

    Optimistic concurrency: each item may carry `base_version` (the xmin the client
    last saw) and `force`. Under the FOR UPDATE lock we read each row's current xmin;
    if `base_version` is provided, doesn't match, and `force` is falsy, the edit is
    rejected and the id is reported in `stale` (no write). Forced edits and edits with
    no base_version write unconditionally (backward-compatible). Persisted rows return
    their NEW xmin in `versions` so the client can re-stamp without a self-conflict on
    its next edit.

    Returns {applied, persisted, failed, invalid, not_found, invalid_ids,
    not_found_ids, stale, versions}. invalid_ids / not_found_ids carry the actual ids
    (not just counts) so the client can stop retrying terminally-rejected rows while
    still keeping genuinely-unpersisted rows dirty for a retry.
    """
    applied = persisted = failed = 0
    stale: list[str] = []
    invalid_ids: list[str] = []
    not_found_ids: list[str] = []
    versions: dict[str, int] = {}
    if not items:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": 0,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {}}

    ids = [it["id"] for it in items if it.get("id")]
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id,
                   COALESCE(scheduled_start, basic_start_date)  AS eff_start,
                   COALESCE(scheduled_end,   basic_finish_date) AS eff_end,
                   xmin::text::bigint                           AS row_version
            FROM orders WHERE id = ANY(%s)
            FOR UPDATE
            """,
            (ids,),
        )
        eff = {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}

        update_rows = []
        for it in items:
            tid = it.get("id")
            start, end = it.get("start"), it.get("end")
            if not tid or (start is None and end is None):
                invalid_ids.append(tid)
                continue
            if tid not in eff:
                not_found_ids.append(tid)
                continue
            cur_start, cur_end, cur_ver = eff[tid]
            new_start = start if start is not None else cur_start
            new_end   = end   if end   is not None else cur_end
            if new_start is not None and new_end is not None and new_end <= new_start:
                invalid_ids.append(tid)
                continue
            base_version = it.get("base_version")
            if not it.get("force") and base_version is not None and base_version != cur_ver:
                stale.append(tid)   # someone else wrote since the client's read
                continue
            update_rows.append((start, end, tid))

        if update_rows:
            try:
                # Single statement: COALESCE keeps the unedited field; explicit casts on the
                # VALUES columns are required because an all-NULL column would otherwise be
                # of unknown type. RETURNING o.xmin gives each row's post-write version, using
                # the identical xmin::text::bigint expression as the /tasks read path.
                placeholders = ", ".join(["(%s::timestamp, %s::timestamp, %s::text)"] * len(update_rows))
                params = [v for row in update_rows for v in row]
                sql = f"""
                    UPDATE orders o
                    SET scheduled_start = COALESCE(v.s, o.scheduled_start),
                        scheduled_end   = COALESCE(v.e, o.scheduled_end),
                        updated_at      = NOW()
                    FROM (VALUES {placeholders}) AS v(s, e, id)
                    WHERE o.id = v.id
                    RETURNING o.id, o.xmin::text::bigint AS new_version
                """
                cur.execute(sql, params)
                for rid, rver in cur.fetchall():
                    versions[rid] = int(rver)
                conn.commit()
                persisted = applied = len(versions)
            except Exception:
                conn.rollback()
                failed = len(update_rows)
                raise
    return {"applied": applied, "persisted": persisted, "failed": failed,
            "invalid": len(invalid_ids), "not_found": len(not_found_ids),
            "invalid_ids": invalid_ids, "not_found_ids": not_found_ids,
            "stale": stale, "versions": versions}


def update_task_note(task_id: str, notes) -> dict:
    """Persist a user-written note for an order. Pass None to clear."""
    sql = "UPDATE orders SET notes = %s, updated_at = NOW() WHERE id = %s"
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (notes or None, task_id))
        updated = cur.rowcount
        conn.commit()
    return {"status": "ok", "updated": updated}


def purge_orders_by_date(start, end) -> dict:
    """DELETE rows whose effective end date (scheduled_end, falling back to basic_finish_date) falls in [start, end]."""
    sql = "DELETE FROM orders WHERE COALESCE(scheduled_end, basic_finish_date) BETWEEN %s AND %s"
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (start, end))
        deleted = cur.rowcount
        conn.commit()
    return {"status": "ok", "deleted": deleted}


def clear_upload_audit() -> dict:
    """Delete all rows from upload_audit."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM upload_audit")
        deleted = cur.rowcount
        conn.commit()
    return {"status": "ok", "deleted": deleted}


# =========================
# DIAGNOSTICS / HEALTH
# =========================
def get_health_stats() -> dict:
    """Fast aggregate query for the health-bar endpoint. Single round-trip."""
    import time
    t0 = time.monotonic()
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*)                 AS total_orders,
                    COUNT(scheduled_start)   AS user_overrides
                FROM orders
            """)
            row = cur.fetchone()
            total_orders  = int(row[0]) if row else 0
            user_overrides = int(row[1]) if row else 0

            cur.execute("""
                SELECT filename, uploaded_at
                FROM upload_audit
                ORDER BY uploaded_at DESC
                LIMIT 1
            """)
            audit = cur.fetchone()

        ping_ms = round((time.monotonic() - t0) * 1000)
        return {
            "connected":        True,
            "ping_ms":          ping_ms,
            "total_orders":     total_orders,
            "user_overrides":   user_overrides,
            "last_upload_file": audit[0] if audit else None,
            "last_upload_at":   audit[1].isoformat() if (audit and audit[1]) else None,
        }
    except Exception as e:
        return {
            "connected":        False,
            "ping_ms":          round((time.monotonic() - t0) * 1000),
            "error":            str(e),
            "total_orders":     0,
            "user_overrides":   0,
            "last_upload_file": None,
            "last_upload_at":   None,
        }


def get_db_deep_stats() -> dict:
    """Per-column null analysis, date range, and per-line breakdown."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*)                                                    AS total,
                    COUNT(CASE WHEN basic_start_date  IS NULL THEN 1 END)      AS null_start,
                    COUNT(CASE WHEN basic_finish_date IS NULL THEN 1 END)      AS null_end,
                    COUNT(CASE WHEN color IS NULL OR color = '' THEN 1 END)    AS null_color,
                    COUNT(CASE WHEN production_line IS NULL
                               OR  production_line = '' THEN 1 END)            AS null_line,
                    COUNT(CASE WHEN material_description IS NULL
                               OR  material_description = '' THEN 1 END)       AS null_desc,
                    COUNT(CASE WHEN run_time IS NULL THEN 1 END)               AS null_runtime,
                    MIN(COALESCE(scheduled_start, basic_start_date))           AS min_date,
                    MAX(COALESCE(scheduled_end,   basic_finish_date))          AS max_date
                FROM orders
            """)
            r = cur.fetchone()

            cur.execute("""
                SELECT production_line, COUNT(*) AS cnt
                FROM orders
                GROUP BY production_line
                ORDER BY cnt DESC
            """)
            by_line = {(row[0] or "unknown"): int(row[1]) for row in cur.fetchall()}

        return {
            "total":          int(r[0]) if r else 0,
            "null_start":     int(r[1]) if r else 0,
            "null_end":       int(r[2]) if r else 0,
            "null_color":     int(r[3]) if r else 0,
            "null_line":      int(r[4]) if r else 0,
            "null_desc":      int(r[5]) if r else 0,
            "null_runtime":   int(r[6]) if r else 0,
            "date_range": {
                "min": r[7].isoformat() if (r and r[7]) else None,
                "max": r[8].isoformat() if (r and r[8]) else None,
            },
            "by_line": by_line,
        }
    except Exception as e:
        return {"error": str(e), "total": 0, "by_line": {}}


def get_pool_stats() -> dict:
    """Connection pool metrics from psycopg_pool."""
    try:
        stats = _pool.get_stats()
        return {
            "pool_min":           stats.get("pool_min", 0),
            "pool_max":           stats.get("pool_max", 0),
            "pool_size":          stats.get("pool_size", 0),
            "pool_available":     stats.get("pool_available", 0),
            "requests_waiting":   stats.get("requests_waiting", 0),
            "requests_completed": stats.get("requests_completed", 0),
            "requests_errors":    stats.get("requests_errors", 0),
            "returns_bad":        stats.get("returns_bad", 0),
        }
    except Exception as e:
        return {"error": str(e)}


def get_db_server_info() -> dict:
    """PostgreSQL version, uptime, DB size, and max_connections setting."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    version(),
                    pg_postmaster_start_time(),
                    current_database(),
                    pg_size_pretty(pg_database_size(current_database()))
            """)
            row = cur.fetchone()
            cur.execute("SHOW max_connections")
            max_conn = (cur.fetchone() or [None])[0]
        return {
            "version":         row[0] if row else None,
            "started_at":      row[1].isoformat() if (row and row[1]) else None,
            "database":        row[2] if row else None,
            "db_size":         row[3] if row else None,
            "max_connections": max_conn,
        }
    except Exception as e:
        return {"error": str(e)}


def get_db_table_stats() -> list:
    """pg_stat_user_tables: live/dead rows, vacuum freshness, and total size."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    relname,
                    n_live_tup,
                    n_dead_tup,
                    ROUND(
                        CASE WHEN (n_live_tup + n_dead_tup) > 0
                             THEN 100.0 * n_dead_tup / (n_live_tup + n_dead_tup)
                             ELSE 0 END, 1)                       AS dead_pct,
                    last_vacuum,
                    last_autovacuum,
                    last_analyze,
                    last_autoanalyze,
                    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                    n_mod_since_analyze
                FROM pg_stat_user_tables
                ORDER BY n_dead_tup DESC
            """)
            rows = cur.fetchall()
        return [
            {
                "table":             r[0],
                "live_rows":         int(r[1]),
                "dead_rows":         int(r[2]),
                "dead_pct":          float(r[3]),
                "last_vacuum":       r[4].isoformat()     if r[4] else None,
                "last_autovacuum":   r[5].isoformat()     if r[5] else None,
                "last_analyze":      r[6].isoformat()     if r[6] else None,
                "last_autoanalyze":  r[7].isoformat()     if r[7] else None,
                "total_size":        r[8],
                "mods_since_analyze": int(r[9]),
                "needs_vacuum":      float(r[3]) > 20,
                "needs_analyze":     int(r[9]) > max(int(r[1]) * 0.1, 100),
            }
            for r in rows
        ]
    except Exception as e:
        return [{"error": str(e)}]


def get_db_connection_activity() -> dict:
    """pg_stat_activity: connection state counts + non-idle queries."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT state, COUNT(*) AS cnt
                FROM pg_stat_activity
                WHERE datname = current_database()
                GROUP BY state
                ORDER BY cnt DESC
            """)
            by_state = {(r[0] or "unknown"): int(r[1]) for r in cur.fetchall()}

            cur.execute("""
                SELECT
                    pid,
                    state,
                    EXTRACT(EPOCH FROM (NOW() - query_start))::int AS duration_s,
                    LEFT(query, 150)                               AS query_snippet,
                    wait_event_type,
                    wait_event,
                    application_name
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND state NOT IN ('idle')
                  AND query_start IS NOT NULL
                  AND pid <> pg_backend_pid()
                ORDER BY query_start ASC
                LIMIT 15
            """)
            long_running = [
                {
                    "pid":             r[0],
                    "state":           r[1],
                    "duration_s":      r[2],
                    "query":           r[3],
                    "wait_event_type": r[4],
                    "wait_event":      r[5],
                    "application":     r[6],
                }
                for r in cur.fetchall()
            ]

        return {
            "total":        sum(by_state.values()),
            "by_state":     by_state,
            "long_running": long_running,
        }
    except Exception as e:
        return {"error": str(e), "total": 0, "by_state": {}, "long_running": []}


def get_db_lock_waits() -> list:
    """Blocked/blocking lock pairs. Non-empty means live lock contention."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    blocked.pid                                                 AS blocked_pid,
                    LEFT(ba.query, 150)                                         AS blocked_query,
                    blocking.pid                                                AS blocking_pid,
                    LEFT(ka.query, 150)                                         AS blocking_query,
                    blocked.locktype                                            AS lock_type,
                    EXTRACT(EPOCH FROM (NOW() - ba.query_start))::int          AS blocked_for_s
                FROM pg_locks blocked
                JOIN pg_stat_activity ba     ON ba.pid  = blocked.pid
                JOIN pg_locks blocking       ON blocking.pid != blocked.pid
                                            AND blocking.granted = TRUE
                                            AND blocked.relation IS NOT DISTINCT FROM blocking.relation
                JOIN pg_stat_activity ka     ON ka.pid  = blocking.pid
                WHERE NOT blocked.granted
                  AND ba.datname = current_database()
                LIMIT 20
            """)
            rows = cur.fetchall()
        return [
            {
                "blocked_pid":    r[0],
                "blocked_query":  r[1],
                "blocking_pid":   r[2],
                "blocking_query": r[3],
                "lock_type":      r[4],
                "blocked_for_s":  r[5],
            }
            for r in rows
        ]
    except Exception as e:
        return [{"error": str(e)}]


def get_db_index_usage() -> list:
    """pg_stat_user_indexes: scan counts, tuple reads, and index sizes."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    relname                                           AS table_name,
                    indexrelname                                      AS index_name,
                    idx_scan                                          AS scans,
                    idx_tup_read                                      AS tuples_read,
                    idx_tup_fetch                                     AS tuples_fetched,
                    pg_size_pretty(pg_relation_size(indexrelid))      AS index_size
                FROM pg_stat_user_indexes
                ORDER BY idx_scan DESC
            """)
            rows = cur.fetchall()
        return [
            {
                "table":          r[0],
                "index":          r[1],
                "scans":          int(r[2]),
                "tuples_read":    int(r[3]),
                "tuples_fetched": int(r[4]),
                "index_size":     r[5],
                "unused":         int(r[2]) == 0,
            }
            for r in rows
        ]
    except Exception as e:
        return [{"error": str(e)}]


def get_db_slow_queries(limit: int = 10) -> dict:
    """Top slow queries via pg_stat_statements; returns available=False if extension absent."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')"
            )
            available = bool(cur.fetchone()[0])
            if not available:
                return {"available": False, "queries": []}

            cur.execute("""
                SELECT
                    LEFT(query, 200)                         AS query,
                    calls,
                    ROUND(total_exec_time::numeric, 1)       AS total_ms,
                    ROUND(mean_exec_time::numeric, 1)        AS mean_ms,
                    ROUND(stddev_exec_time::numeric, 1)      AS stddev_ms,
                    rows
                FROM pg_stat_statements
                WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                ORDER BY mean_exec_time DESC
                LIMIT %s
            """, (limit,))
            rows = cur.fetchall()
        return {
            "available": True,
            "queries": [
                {
                    "query":     r[0],
                    "calls":     int(r[1]),
                    "total_ms":  float(r[2]),
                    "mean_ms":   float(r[3]),
                    "stddev_ms": float(r[4]),
                    "rows":      int(r[5]),
                }
                for r in rows
            ],
        }
    except Exception as e:
        return {"available": False, "error": str(e), "queries": []}


def get_db_sequence_health() -> list:
    """All user sequences with exhaustion risk percentage (pg_sequences, PG 10+)."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    schemaname,
                    sequencename,
                    data_type,
                    last_value,
                    min_value,
                    max_value,
                    increment_by,
                    cycle
                FROM pg_sequences
                WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                ORDER BY schemaname, sequencename
            """)
            rows = cur.fetchall()
        result = []
        for r in rows:
            schema, name, dtype, last, minv, maxv, inc, cycle = r
            last_v  = last if last is not None else (minv or 0)
            minv_n  = minv or 0
            rng     = (maxv - minv_n) if (maxv and maxv != minv_n) else 1
            used_pct = round(100.0 * (last_v - minv_n) / rng, 2) if rng > 0 else 0.0
            status   = "ok" if (cycle or used_pct < 80) else ("warn" if used_pct < 95 else "err")
            result.append({
                "schema":    schema,
                "name":      name,
                "data_type": dtype,
                "last_value": last_v,
                "max_value":  maxv,
                "used_pct":   used_pct,
                "cycles":     cycle,
                "status":     status,
            })
        return result
    except Exception as e:
        return [{"error": str(e)}]


# =========================
# DB MAINTENANCE
# =========================
_MAINT_TABLE_ALLOWLIST: set | None = None


def _get_maint_table_allowlist() -> set:
    """Lazily build an allowlist of real table names to prevent SQL injection in DDL commands."""
    global _MAINT_TABLE_ALLOWLIST
    if _MAINT_TABLE_ALLOWLIST is None:
        with _pool.connection() as conn:
            rows = conn.execute(
                "SELECT relname FROM pg_stat_user_tables"
            ).fetchall()
        _MAINT_TABLE_ALLOWLIST = {r[0] for r in rows}
    return _MAINT_TABLE_ALLOWLIST


def run_vacuum_analyze(table: str | None = None) -> dict:
    """
    VACUUM ANALYZE one table or all known tables.
    Uses a dedicated direct connection (autocommit=True) — VACUUM cannot run inside
    a transaction block, and we must not pollute the pool connection's autocommit state.
    """
    allowed = _get_maint_table_allowlist()
    if table and table not in allowed:
        raise ValueError(f"Unknown table: {table}")
    targets = [table] if table else sorted(allowed)
    results = {}
    with psycopg.connect(CONN_STR, autocommit=True) as conn:
        for t in targets:
            conn.execute(f"VACUUM ANALYZE {t}")
            results[t] = "ok"
    return {"results": results}


def run_analyze(table: str) -> dict:
    """ANALYZE one table to refresh query planner statistics. Safe, non-locking."""
    allowed = _get_maint_table_allowlist()
    if table not in allowed:
        raise ValueError(f"Unknown table: {table}")
    with psycopg.connect(CONN_STR, autocommit=True) as conn:
        conn.execute(f"ANALYZE {table}")
    return {"table": table, "status": "ok"}


# =========================
# INGESTION
# =========================
_UPSERT_SQL = """
    INSERT INTO orders (
        id, production_order, material_number, material_description,
        production_line, plant, basic_start_date, basic_finish_date,
        run_time, color, order_quantity, form_size, firming_indicator, upload_batch_id, updated_at
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
    ON CONFLICT (id) DO UPDATE SET
        production_order      = EXCLUDED.production_order,
        material_number       = EXCLUDED.material_number,
        material_description  = EXCLUDED.material_description,
        production_line       = EXCLUDED.production_line,
        -- Plant: an explicitly uploaded plant always wins; otherwise, if the LINE
        -- changed on this re-upload, reset to NULL so the post-upsert derivation
        -- re-resolves it from the NEW line (matches the old join's self-healing);
        -- otherwise keep the existing (already-derived) plant.
        plant                 = CASE
            WHEN EXCLUDED.plant IS NOT NULL THEN EXCLUDED.plant
            WHEN EXCLUDED.production_line IS DISTINCT FROM orders.production_line THEN NULL
            ELSE orders.plant
        END,
        basic_start_date      = EXCLUDED.basic_start_date,
        basic_finish_date     = EXCLUDED.basic_finish_date,
        run_time              = EXCLUDED.run_time,
        color                 = EXCLUDED.color,
        order_quantity        = EXCLUDED.order_quantity,
        form_size             = EXCLUDED.form_size,
        firming_indicator     = EXCLUDED.firming_indicator,
        upload_batch_id       = EXCLUDED.upload_batch_id,
        updated_at            = NOW()
    RETURNING (xmax = 0) AS inserted
"""
# Deliberately NOT in the UPDATE SET: scheduled_start, scheduled_end.
# That's the whole point — user drag/drop edits survive a re-upload.


def ingest_orders_from_excel(file_bytes: bytes, filename: str) -> dict:
    """
    Parse an uploaded sequence_testing-shaped xlsx, normalize/clean,
    upsert into orders, and write an upload_audit row.

    Returns: {status, batch_id, raw_row_count, inserted, updated, warnings}.
    """
    batch_id = str(uuid.uuid4())
    warnings: list[dict] = []

    def _write_failed_audit(filename_v, row_count_v, error_msg):
        """Leave a trail for a failed upload. There is no dedicated `status`
        column on upload_audit, so the failure is recorded as a 'failed' warning
        entry (read by the Admin Cockpit history card) with inserted/updated=0.
        Best-effort — never let audit-write trouble mask the original failure."""
        try:
            with _pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO upload_audit
                        (batch_id, filename, row_count, inserted_count, updated_count, warnings)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (batch_id, filename_v, row_count_v, 0, 0,
                     Jsonb([{"level": "error", "status": "failed", "msg": error_msg}])),
                )
                conn.commit()
        except Exception:
            log.warning("Failed to write failed-upload audit row", extra={"category": "upload"})

    try:
        df = pd.read_excel(io.BytesIO(file_bytes))
    except Exception as e:
        _write_failed_audit(filename, 0, f"Could not parse xlsx: {e}")
        return {"status": "error", "message": f"Could not parse xlsx: {e}",
                "raw_row_count": 0, "inserted": 0, "updated": 0,
                "warnings": [], "batch_id": batch_id}

    raw_row_count = len(df)
    df = clean(df)

    # SAP exports sometimes use "ORDER" instead of "PRODUCTION_ORDER"
    if "ORDER" in df.columns and "PRODUCTION_ORDER" not in df.columns:
        df = df.rename(columns={"ORDER": "PRODUCTION_ORDER"})
    # SAP plant column is commonly "WERKS"; normalize to PLANT. When neither is
    # present the per-order plant is derived from the line→plant mapping after upsert.
    if "WERKS" in df.columns and "PLANT" not in df.columns:
        df = df.rename(columns={"WERKS": "PLANT"})

    required = {"PRODUCTION_ORDER", "MATERIAL_NUMBER", "BASIC_START_DATE"}
    missing = required - set(df.columns)
    if missing:
        msg = f"Uploaded file is missing required columns: {sorted(missing)}"
        _write_failed_audit(filename, raw_row_count, msg)
        return {"status": "error",
                "message": msg,
                "raw_row_count": raw_row_count, "inserted": 0, "updated": 0,
                "warnings": [], "batch_id": batch_id}

    # ---------- Date hygiene (mirrors brain.py:102-127) ----------
    df["BASIC_START_DATE"] = pd.to_datetime(df["BASIC_START_DATE"], errors="coerce")
    if "BASIC_FINISH_DATE" not in df.columns:
        df["BASIC_FINISH_DATE"] = pd.NaT
    df["BASIC_FINISH_DATE"] = pd.to_datetime(df["BASIC_FINISH_DATE"], errors="coerce")
    df["BASIC_FINISH_DATE"] = df["BASIC_FINISH_DATE"].fillna(df["BASIC_START_DATE"])

    bad = df["BASIC_FINISH_DATE"] <= df["BASIC_START_DATE"]
    df.loc[bad, "BASIC_FINISH_DATE"] = df.loc[bad, "BASIC_START_DATE"] + pd.Timedelta(hours=1)

    bad_start = df["BASIC_START_DATE"].isna()
    if bad_start.any():
        warnings.append({
            "level": "error",
            "msg": f"{int(bad_start.sum())} row(s) dropped — unparseable BASIC_START_DATE",
        })
    df = df.dropna(subset=["BASIC_START_DATE"]).reset_index(drop=True)

    df["RUN_TIME"] = pd.to_numeric(
        df["RUN_TIME"] if "RUN_TIME" in df.columns else pd.Series(1.0, index=df.index),
        errors="coerce",
    ).fillna(1.0)
    mask_notime = df["BASIC_FINISH_DATE"].dt.hour == 0
    df.loc[mask_notime, "BASIC_FINISH_DATE"] = (
        df.loc[mask_notime, "BASIC_START_DATE"]
        + pd.to_timedelta(df.loc[mask_notime, "RUN_TIME"], unit="h")
    )

    qcol = "ORDER_QUANTITY_(GMEIN)"
    if qcol in df.columns:
        df[qcol] = pd.to_numeric(df[qcol], errors="coerce")

    # ---------- IDs + dedup (mirrors brain.py:131-150) ----------
    df["id"] = df.apply(
        lambda r: make_id(r.get("PRODUCTION_ORDER", ""),
                          r.get("MATERIAL_NUMBER", "")),
        axis=1,
    )
    dup_counts = df.groupby("id").cumcount()
    if (dup_counts > 0).any():
        warnings.append({
            "level": "warn",
            "msg": f"{int((dup_counts > 0).sum())} duplicate IDs suffixed (ORDER|MATERIAL not unique)",
        })
        df.loc[dup_counts > 0, "id"] = (
            df.loc[dup_counts > 0, "id"].astype(str)
            + "_"
            + dup_counts[dup_counts > 0].astype(str)
        )

    # ---------- Build row tuples ----------
    def _v(row, col):
        if col not in df.columns:
            return None
        val = row.get(col)
        return None if pd.isna(val) else val

    def _ts(val):
        return val.to_pydatetime() if pd.notna(val) else None

    rows = []
    for _, r in df.iterrows():
        rows.append((
            r["id"],
            _str_id(r.get("PRODUCTION_ORDER", "")),
            _str_id(r.get("MATERIAL_NUMBER", "")),
            _v(r, "MATERIAL_DESCRIPTION"),
            _v(r, "PRODUCTION_LINE"),
            _v(r, "PLANT"),
            _ts(r["BASIC_START_DATE"]),
            _ts(r["BASIC_FINISH_DATE"]),
            float(r["RUN_TIME"]) if pd.notna(r["RUN_TIME"]) else None,
            _v(r, "COLOR"),
            float(r[qcol]) if (qcol in df.columns and pd.notna(r.get(qcol))) else None,
            _v(r, "FORM_SIZE"),
            _v(r, "FIRMING_INDICATOR"),
            batch_id,
        ))

    # ---------- Upsert + audit ----------
    # Chunked executemany(returning=True): commits every 500 rows so a large upload
    # never holds a table lock for the full duration of the transaction. Each chunk
    # is idempotent (ON CONFLICT DO UPDATE), so a mid-upload failure leaves a
    # consistent partial state the user can recover from by re-uploading.
    _UPSERT_CHUNK = 500
    inserted = 0
    updated = 0
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            for i in range(0, len(rows), _UPSERT_CHUNK):
                chunk = rows[i:i + _UPSERT_CHUNK]
                cur.executemany(_UPSERT_SQL, chunk, returning=True)
                while True:
                    rec = cur.fetchone()
                    if rec is not None:
                        if rec[0]:
                            inserted += 1
                        else:
                            updated += 1
                    if not cur.nextset():
                        break
                conn.commit()
            # Materialize plant for rows this upload didn't carry one for, deriving it from
            # the line→plant master-data mapping. Only derive when the line maps to EXACTLY
            # ONE plant; a line code shared across plants is left NULL (and warned) rather
            # than silently mis-attributed to the lowest plant code. Scoped to this batch.
            cur.execute(
                """
                UPDATE orders o
                   SET plant = (
                       SELECT MIN(pl.plant) FROM production_lines pl
                        WHERE pl.production_line = o.production_line
                   )
                 WHERE o.upload_batch_id = %s AND o.plant IS NULL
                   AND (
                       SELECT COUNT(DISTINCT pl.plant) FROM production_lines pl
                        WHERE pl.production_line = o.production_line
                   ) = 1
                """,
                (batch_id,),
            )
            conn.commit()
            # Surface (don't guess) rows left NULL because their line maps to >1 plant.
            cur.execute(
                """
                SELECT o.production_line, COUNT(*)
                  FROM orders o
                 WHERE o.upload_batch_id = %s AND o.plant IS NULL
                   AND (
                       SELECT COUNT(DISTINCT pl.plant) FROM production_lines pl
                        WHERE pl.production_line = o.production_line
                   ) > 1
                 GROUP BY o.production_line
                """,
                (batch_id,),
            )
            ambiguous = cur.fetchall()
            if ambiguous:
                n_amb = sum(int(r[1]) for r in ambiguous)
                lines_amb = ", ".join(str(r[0]) for r in ambiguous)
                warnings.append({
                    "level": "warn",
                    "msg": (f"{n_amb} order(s) left plant-unattributed — line code(s) "
                            f"shared across multiple plants: {lines_amb}. Provide an "
                            f"explicit plant column on upload to resolve."),
                })
            cur.execute(
                """
                INSERT INTO upload_audit
                    (batch_id, filename, row_count, inserted_count, updated_count, warnings)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (batch_id, filename, raw_row_count, inserted, updated, Jsonb(warnings)),
            )
            conn.commit()
    except Exception as e:
        # The transaction is already rolled back by the context manager; leave a
        # failed-upload trail (separate short txn) before letting the error reach
        # the psycopg.Error handler in brain.py for translation.
        _write_failed_audit(filename, raw_row_count, f"Upload persist failed: {e}")
        raise

    lines = sorted({str(v) for v in df["PRODUCTION_LINE"].dropna().unique()}) \
        if "PRODUCTION_LINE" in df.columns else []

    return {
        "status": "ok",
        "batch_id": batch_id,
        "raw_row_count": raw_row_count,
        "inserted": inserted,
        "updated": updated,
        "lines": lines,
        "warnings": warnings,
    }
