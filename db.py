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
from psycopg import sql
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
# Effective finish for an order, as one shared SQL fragment so every read path agrees.
# The Gantt bar's WIDTH must always represent run_time (a 12h order = half a day wide),
# so run_time is the source of truth for duration:
#   1. run-time-derived end (effective start + run_time hours) takes precedence — even
#      over a persisted scheduled_end — so bars, utilization, and alerts all reflect the
#      order's actual run time in elapsed calendar hours. (Most stored scheduled ends
#      hold a flat ~SAP-window duration that does NOT match run_time.) The order's START
#      still comes from scheduled_start (see BASIC_START_DATE below), so the user's
#      placement is preserved — only the width is normalized to run_time;
#   2. else scheduled_end — used only when run_time is unknown (NULL);
#   3. else the raw SAP finish, as a last-resort fallback (no zero-width bar).
# Static SQL, no user input, so it is safe to interpolate.
_EFF_END_SQL = (
    "COALESCE("
    "COALESCE(scheduled_start, basic_start_date) + (run_time * INTERVAL '1 hour'), "
    "scheduled_end, "
    "basic_finish_date)"
)

# Shared projection for the orders read path. Column aliases are the contract the
# frontend/brain.py rely on; user scheduling overrides take precedence over the
# SAP-source dates via COALESCE so callers only ever see one start/end per order.
_ORDERS_SELECT = f"""
    SELECT
        id,
        production_order      AS "PRODUCTION_ORDER",
        material_number       AS "MATERIAL_NUMBER",
        material_description  AS "MATERIAL_DESCRIPTION",
        o.production_line     AS "PRODUCTION_LINE",
        o.plant               AS "PLANT",
        COALESCE(scheduled_start, basic_start_date) AS "BASIC_START_DATE",
        {_EFF_END_SQL} AS "BASIC_FINISH_DATE",
        basic_start_date      AS "ORIGINAL_START_DATE",
        basic_finish_date     AS "ORIGINAL_END_DATE",
        (scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL) AS "USER_SCHEDULED",
        run_time              AS "RUN_TIME",
        color                 AS "COLOR",
        prt_01                AS "PRT_01",
        prt_02                AS "PRT_02",
        production_version    AS "PRODUCTION_VERSION",
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
                 limit: int | None = None, offset: int | None = None,
                 allowed_plants: list[str] | None = None) -> pd.DataFrame:
    """
    Server-side-scoped orders read for the stateless /tasks path.

    The scaling unit is the PLANT: pass `plant=` to bound the result to a single
    plant (~70 lines) so we never materialize the whole order book. `line=`
    narrows further. `limit`/`offset` are a coarse guard rail for unscoped
    tooling queries only — finish-to-start links are coherent only within a
    plant/line scope, never across a blind offset window. `allowed_plants`
    (per-user role_plants scope, resolved by auth.get_allowed_plants) is
    ANDed in alongside any explicit plant/line filter — it only narrows,
    never widens, the result.

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
    if allowed_plants is not None:
        where.append('o.plant = ANY(%s)')
        params.append(allowed_plants)
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


def count_orders(plant: str | None = None, line: str | None = None,
                 allowed_plants: list[str] | None = None) -> int:
    """Row count for a plant/line scope — for pagination totals / tooling."""
    sql = "SELECT COUNT(*) FROM orders o"
    where, params = [], []
    if plant:
        where.append('o.plant = %s')
        params.append(plant)
    if line:
        where.append('o.production_line = %s')
        params.append(line)
    if allowed_plants is not None:
        where.append('o.plant = ANY(%s)')
        params.append(allowed_plants)
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


def backfill_line_keys() -> int:
    """
    Re-derive orders.line_key where it is still NULL, from production_lines.line_key
    for the matching (plant, production_line) pair. Whole-table sibling of the
    batch-scoped backfill in upsert_orders() — call this after production_lines
    change, same trigger as reattribute_null_plant_orders(). Strictly downstream
    of orders.plant: a row still NULL there is skipped here too (see MIGRATION.md
    for the pre-existing plant-ambiguity gap this inherits rather than fixes).
    Idempotent. Returns the number of orders re-attributed.
    """
    sql = """
        UPDATE orders o
           SET line_key = (
               SELECT pl.line_key FROM production_lines pl
                WHERE pl.plant = o.plant AND pl.production_line = o.production_line
           )
         WHERE o.line_key IS NULL AND o.plant IS NOT NULL
           AND (
               SELECT COUNT(*) FROM production_lines pl
                WHERE pl.plant = o.plant AND pl.production_line = o.production_line
           ) = 1
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        n = cur.rowcount
        # Report (don't guess) rows left NULL because (plant, production_line) matches
        # zero or more than one production_lines row.
        cur.execute(
            """
            SELECT o.plant, o.production_line, COUNT(*)
              FROM orders o
             WHERE o.line_key IS NULL AND o.plant IS NOT NULL
               AND (
                   SELECT COUNT(*) FROM production_lines pl
                    WHERE pl.plant = o.plant AND pl.production_line = o.production_line
               ) <> 1
             GROUP BY o.plant, o.production_line
            """
        )
        unresolved = cur.fetchall()
        conn.commit()
    if unresolved:
        total = sum(int(r[2]) for r in unresolved)
        pairs = ", ".join(f"{r[0]}/{r[1]}" for r in unresolved)
        log.warning(
            "backfill_line_keys: %d order(s) left without a line_key — "
            "(plant, line) pair(s) not uniquely resolved in production_lines: %s", total, pairs,
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
    sql = f"""
        SELECT id,
               COALESCE(scheduled_start, basic_start_date)  AS eff_start,
               {_EFF_END_SQL} AS eff_end,
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


def get_upload_audit_warnings(batch_id: str) -> list[dict] | None:
    """Return one batch's raw `warnings` list (as persisted by upsert_orders),
    or None if the batch doesn't exist. Backs GET /upload/{batch_id}/
    missing-master-data — the caller filters for category=='missing_master_data'."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT warnings FROM upload_audit WHERE batch_id = %s", (batch_id,))
        row = cur.fetchone()
    if row is None:
        return None
    return row[0] or []


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
            f"""
            SELECT id,
                   COALESCE(scheduled_start, basic_start_date)  AS eff_start,
                   {_EFF_END_SQL} AS eff_end,
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


def correct_due_date_baselines(corrections: list[dict]) -> dict:
    """
    One-time-per-order backfill of the due-date baseline (`basic_finish_date`),
    computed client-side by Persistence._snapToWorkingHours's due-date-baseline
    phase in app.js. Not a general task-date write path — every row is
    re-validated server-side, via a single VALUES-join UPDATE, before it is
    written:

      1. `xmin` must still equal `base_version` — the row version the client
         had cached when it computed `basic_finish_date`. Any write to the row
         since then (a concurrent SAP re-upload, a normal scheduling save, or
         another tab's correction) bumps xmin regardless of which columns
         changed, so this fails safely whenever the row moved on since the
         client read it — including, but not limited to, a re-upload that
         rewrote basic_start_date/basic_finish_date out from under a stale
         correction. Deliberately NOT a basic_start_date value comparison: the
         client-observed value round-trips through JS Date/JSON.stringify,
         which re-labels a naive local timestamp as UTC — comparing that
         directly against Postgres's naive (TIMESTAMP WITHOUT TIME ZONE)
         basic_start_date would be off by the client's UTC offset and would
         never match for any non-UTC user.
      2. `basic_finish_date` must still be in a known raw/uncorrected shape
         (NULL, == basic_start_date, == basic_start_date + run_time hours, or
         == basic_start_date + 1 hour — the last being the shape left behind
         by the pre-2026-07-06 ingest-hygiene bug, see below) — i.e. nobody
         already corrected (or re-uploaded a genuine value for) this row
         since the client read it.

    Either check failing makes the write a safe no-op for that row (not an
    error) — the id is simply absent from `versions`.

    Each item: {id, basic_finish_date, base_version} (id: str,
    basic_finish_date: datetime, base_version: int — the row's xmin as of the
    client's last load/save of it). Callers are expected to chunk large
    batches themselves (the frontend relay does, at 500 rows/request — see
    Persistence._relayDueDateCorrections in app.js); this function does not
    chunk internally, so a single call is still bounded by Postgres's
    bound-parameter ceiling (3 params/row here).

    Returns {applied, persisted, skipped, not_matched, versions}. `skipped`
    counts malformed input rows (missing id/basic_finish_date/base_version)
    rejected before the SQL runs; `not_matched` counts well-formed rows that
    reached the UPDATE but failed its WHERE clause (stale version, or already
    corrected) — surfaced as a distinct count so a systemic 0%-match condition
    (e.g. a version-pinning bug) is visible in logs rather than
    indistinguishable from a healthy "nothing left to correct" steady state.
    `versions` carries the post-write xmin per corrected id (same
    `xmin::text::bigint` shape as update_task_dates_bulk) so the caller can
    re-stamp the frontend's cached row_version — otherwise every corrected
    order would false-conflict on its next unrelated scheduling save this
    session.
    """
    versions: dict[str, int] = {}
    if not corrections:
        return {"applied": 0, "persisted": 0, "skipped": 0, "not_matched": 0, "versions": {}}

    rows = []
    skipped = 0
    for c in corrections:
        cid = c.get("id")
        new_finish = c.get("basic_finish_date")
        base_version = c.get("base_version")
        if not cid or new_finish is None or base_version is None:
            skipped += 1
            continue
        rows.append((cid, new_finish, base_version))

    if not rows:
        return {"applied": 0, "persisted": 0, "skipped": skipped, "not_matched": 0, "versions": {}}

    applied = persisted = 0
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            # Explicit casts on the VALUES columns (same reasoning as
            # update_task_dates_bulk): an all-NULL column would otherwise be of
            # unknown type. RETURNING o.xmin gives each row's post-write
            # version, using the identical xmin::text::bigint expression as
            # the /tasks read path and update_task_dates_bulk.
            placeholders = ", ".join(["(%s::text, %s::timestamp, %s::bigint)"] * len(rows))
            params = [v for row in rows for v in row]
            sql = f"""
                UPDATE orders o
                SET basic_finish_date = v.new_finish,
                    updated_at        = NOW()
                FROM (VALUES {placeholders}) AS v(id, new_finish, base_version)
                WHERE o.id = v.id
                  AND o.xmin::text::bigint = v.base_version
                  AND (
                        o.basic_finish_date IS NULL
                     OR o.basic_finish_date = o.basic_start_date
                     OR o.basic_finish_date = o.basic_start_date
                          + (COALESCE(o.run_time, 0) * INTERVAL '1 hour')
                     -- Legacy pre-2026-07-06 ingest-hygiene bug shape: the OLD
                     -- upload-hygiene "bad" branch hardcoded basic_finish_date
                     -- = basic_start_date + 1 hour for any row with a
                     -- missing/invalid BASIC_FINISH_DATE. Kept permanently
                     -- (not a one-off migration) since old backups/re-imports
                     -- could still carry this shape even though new uploads
                     -- never will after the ingest-hygiene fix. Unlike the
                     -- run_time-based shape above, this one is unconditional
                     -- on run_time, so it can theoretically also match (and
                     -- allow overwriting) a genuine SAP-set due date that
                     -- happens to land exactly 1 hour after start — accepted,
                     -- same heuristic-ambiguity class already taken on above.
                     OR o.basic_finish_date = o.basic_start_date + INTERVAL '1 hour'
                  )
                RETURNING o.id, o.xmin::text::bigint AS new_version
            """
            cur.execute(sql, params)
            for rid, rver in cur.fetchall():
                versions[rid] = int(rver)
            conn.commit()
            persisted = applied = len(versions)
        except Exception:
            conn.rollback()
            raise
    not_matched = len(rows) - len(versions)
    return {"applied": applied, "persisted": persisted, "skipped": skipped,
            "not_matched": not_matched, "versions": versions}


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
        run_time, color, prt_01, prt_02, production_version,
        order_quantity, form_size, firming_indicator, upload_batch_id, updated_at
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
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
        -- line_key has no EXCLUDED counterpart (it's derived, never uploaded), so unlike
        -- plant it never gets a "trust the new explicit value" branch — just reset to
        -- NULL on either input actually changing, else keep. The post-upsert backfill
        -- below re-derives it. Plant-changed check is NULL-safe (EXCLUDED.plant IS NOT
        -- NULL guard) so a plain re-upload with no WERKS/PLANT column doesn't null it.
        line_key              = CASE
            WHEN EXCLUDED.production_line IS DISTINCT FROM orders.production_line THEN NULL
            WHEN EXCLUDED.plant IS NOT NULL AND EXCLUDED.plant IS DISTINCT FROM orders.plant THEN NULL
            ELSE orders.line_key
        END,
        basic_start_date      = EXCLUDED.basic_start_date,
        basic_finish_date     = EXCLUDED.basic_finish_date,
        run_time              = EXCLUDED.run_time,
        color                 = EXCLUDED.color,
        -- prt_01/prt_02/production_version: written from the uploaded row like color
        -- (NULL today — no upload source carries them yet), then overwritten for
        -- matched materials by the post-upsert db._stamp_order_attributes call, which
        -- always runs last and wins (mirrors the existing color/SAP precedence, R5 in
        -- docs/scheduling_priority.md).
        prt_01                = EXCLUDED.prt_01,
        prt_02                = EXCLUDED.prt_02,
        production_version    = EXCLUDED.production_version,
        order_quantity        = EXCLUDED.order_quantity,
        form_size             = EXCLUDED.form_size,
        firming_indicator     = EXCLUDED.firming_indicator,
        upload_batch_id       = EXCLUDED.upload_batch_id,
        updated_at            = NOW()
    RETURNING (xmax = 0) AS inserted
"""
# Deliberately NOT in the UPDATE SET: scheduled_start, scheduled_end.
# That's the whole point — user drag/drop edits survive a re-upload.


# Build the per-row tuple in the exact _UPSERT_SQL column order. The SQL VALUES
# clause expects: id, production_order, material_number, material_description,
# production_line, plant, basic_start_date, basic_finish_date, run_time, color,
# prt_01, prt_02, production_version, order_quantity, form_size, firming_indicator,
# upload_batch_id.
_UPSERT_ROW_COLS = (
    "production_order", "material_number", "material_description",
    "production_line", "plant", "basic_start_date", "basic_finish_date",
    "run_time", "color", "prt_01", "prt_02", "production_version",
    "order_quantity", "form_size", "firming_indicator",
)


def _stamp_order_attributes(conn, *, batch_id: str | None = None, plant: str | None = None) -> dict:
    """Seam 2 (docs/scheduling_priority.md): the ONE place attribute provenance
    lives for color/prt_01/prt_02/production_version. One UPDATE orders ... FROM
    material_plants keyed (plant, material_number = material_id), scoped either
    to a single ingest batch (batch_id — called post-upsert from upsert_orders)
    or to a whole plant (plant — called from POST /master-data/resync-order-attributes).

    Must run AFTER orders.plant is derived, since it reads the derived value —
    callers scoped by batch_id must call this after the plant/line_key backfill,
    not before. Runs LAST and wins over anything sap_field_map ever maps to
    orders.color (R5): sap_sync shares this same upsert_orders path. When PRT_02
    moves from a single TEXT value to a production-version-keyed table, this
    query is the only thing that changes.

    Does not commit — the caller controls the transaction boundary.

    Returns the missing-master-data exception summary (never used to block
    anything — see docs/scheduling_priority.md's "Unmatched MP rows" decision):
        {"unmatched_pairs": int, "unmatched_orders": int, "exceptions": [
            {"plant": str|None, "material_number": str, "order_count": int,
             "reason": "no_mp_row" | "no_plant_derived"},
            ...
        ]}
    "no_plant_derived" means the order has no plant at all (an ambiguous
    multi-plant line code left it NULL — a different, pre-existing problem,
    N9) and can only occur in the batch_id scope; a plant-scoped resync only
    ever sees "no_mp_row" by construction.
    """
    if batch_id is None and plant is None:
        raise ValueError("_stamp_order_attributes requires batch_id or plant")

    with conn.cursor() as cur:
        if batch_id is not None:
            cur.execute(
                """
                UPDATE orders o
                   SET color              = mp.color,
                       prt_01             = mp.prt_01,
                       prt_02             = mp.prt_02,
                       production_version = mp.default_production_version,
                       updated_at         = NOW()
                  FROM material_plants mp
                 WHERE mp.plant = o.plant
                   AND mp.material_id = o.material_number
                   AND o.upload_batch_id = %s
                """,
                (batch_id,),
            )
            cur.execute(
                """
                SELECT o.plant, o.material_number, COUNT(*),
                       CASE WHEN o.plant IS NULL THEN 'no_plant_derived' ELSE 'no_mp_row' END
                  FROM orders o
                  LEFT JOIN material_plants mp
                    ON mp.plant = o.plant AND mp.material_id = o.material_number
                 WHERE o.upload_batch_id = %s
                   AND mp.material_id IS NULL
                 GROUP BY o.plant, o.material_number
                """,
                (batch_id,),
            )
        else:
            cur.execute(
                """
                UPDATE orders o
                   SET color              = mp.color,
                       prt_01             = mp.prt_01,
                       prt_02             = mp.prt_02,
                       production_version = mp.default_production_version,
                       updated_at         = NOW()
                  FROM material_plants mp
                 WHERE mp.plant = o.plant
                   AND mp.material_id = o.material_number
                   AND o.plant = %s
                """,
                (plant,),
            )
            cur.execute(
                """
                SELECT o.plant, o.material_number, COUNT(*), 'no_mp_row'
                  FROM orders o
                  LEFT JOIN material_plants mp
                    ON mp.plant = o.plant AND mp.material_id = o.material_number
                 WHERE o.plant = %s
                   AND mp.material_id IS NULL
                 GROUP BY o.plant, o.material_number
                """,
                (plant,),
            )
        rows = cur.fetchall()

    exceptions = [
        {"plant": r[0], "material_number": r[1], "order_count": r[2], "reason": r[3]}
        for r in rows
    ]
    return {
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(e["order_count"] for e in exceptions),
        "exceptions": exceptions,
    }


def resync_order_attributes(plant: str) -> dict:
    """Public entry point for POST /master-data/resync-order-attributes — the
    real mechanism the ingest-time stamp is convenience for (R3). Opens its
    own connection/commit so brain.py never has to reach into the private
    connection pool directly, matching every other db.py public function."""
    with _pool.connection() as conn:
        result = _stamp_order_attributes(conn, plant=plant)
        conn.commit()
    return result


def missing_master_data_for_plant(plant: str) -> dict:
    """Live, READ-ONLY version of _stamp_order_attributes' plant-scoped
    exception query — no UPDATE. Backs GET /master-data/{plant}/missing-master-data,
    the Optimization tab's report panel (docs/scheduling_priority.md Stage 2
    Decision 3): unlike the batch-scoped GET /upload/{batch_id}/missing-master-data,
    this reflects CURRENT state regardless of when the plant was last uploaded
    to or resynced. Same response shape as the batch-scoped report so the
    frontend renders both with one function."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.plant, o.material_number, COUNT(*), 'no_mp_row'
              FROM orders o
              LEFT JOIN material_plants mp
                ON mp.plant = o.plant AND mp.material_id = o.material_number
             WHERE o.plant = %s
               AND mp.material_id IS NULL
             GROUP BY o.plant, o.material_number
            """,
            (plant,),
        )
        rows = cur.fetchall()
    exceptions = [
        {"plant": r[0], "material_number": r[1], "order_count": r[2], "reason": r[3]}
        for r in rows
    ]
    return {
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(e["order_count"] for e in exceptions),
        "exceptions": exceptions,
    }


def upsert_orders(rows: list[dict], *, batch_id: str | None = None, source: str = "excel",
                  filename: str | None = None, raw_row_count: int | None = None,
                  warnings: list[dict] | None = None) -> dict:
    """Shared orders upsert for both the Excel and SAP ingest paths.

    `rows` is a list of dicts keyed by orders columns (production_order,
    material_number, material_description, production_line, plant,
    basic_start_date, basic_finish_date, run_time, color, order_quantity,
    form_size, firming_indicator). The id is computed via make_id() when absent,
    and a cumulative-count suffix dedups colliding ids (ORDER|MATERIAL not
    unique). Then a chunked, idempotent ON CONFLICT upsert persists the rows,
    plant is backfilled from the line→plant master-data mapping for rows that
    didn't carry one, ambiguous (multi-plant) line codes are surfaced as a
    warning, and an upload_audit row is written.

    The scheduled_start/scheduled_end/notes non-overwrite lives in _UPSERT_SQL
    (unchanged) — user drag/drop edits survive a re-ingest.

    Returns: {status:"ok", batch_id, inserted, updated, failed, warnings}.
    """
    if batch_id is None:
        batch_id = str(uuid.uuid4())
    # filename defaults to f"sap:{source}" when source != "excel" (the SAP path
    # has no real filename); the Excel adapter always passes one explicitly.
    if filename is None and source != "excel":
        filename = f"sap:{source}"
    if raw_row_count is None:
        raw_row_count = len(rows)
    warnings = list(warnings) if warnings is not None else []

    def _write_failed_audit(filename_v, row_count_v, error_msg):
        """Leave a trail for a failed upsert. There is no dedicated `status`
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

    # ---------- IDs + dedup (mirrors brain.py:131-150) ----------
    # Compute id via make_id() when absent, then apply the cumcount-suffix dedup
    # so colliding ids within this batch get a stable "_<n>" suffix.
    id_counts: dict[str, int] = {}
    n_suffixed = 0
    for row in rows:
        rid = row.get("id")
        if not rid:
            rid = make_id(row.get("production_order", ""), row.get("material_number", ""))
        seen = id_counts.get(rid, 0)
        id_counts[rid] = seen + 1
        if seen > 0:
            rid = f"{rid}_{seen}"
            n_suffixed += 1
        row["id"] = rid
    if n_suffixed:
        warnings.append({
            "level": "warn",
            "msg": f"{n_suffixed} duplicate IDs suffixed (ORDER|MATERIAL not unique)",
        })

    # ---------- Build row tuples in _UPSERT_SQL column order ----------
    tuples = []
    for row in rows:
        tuples.append((
            row["id"],
            *(row.get(col) for col in _UPSERT_ROW_COLS),
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
            for i in range(0, len(tuples), _UPSERT_CHUNK):
                chunk = tuples[i:i + _UPSERT_CHUNK]
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
            # Same idea for line_key, scoped to this batch, strictly downstream of the
            # plant backfill just above (a row still NULL there stays NULL here too).
            cur.execute(
                """
                UPDATE orders o
                   SET line_key = (
                       SELECT pl.line_key FROM production_lines pl
                        WHERE pl.plant = o.plant AND pl.production_line = o.production_line
                   )
                 WHERE o.upload_batch_id = %s AND o.line_key IS NULL AND o.plant IS NOT NULL
                   AND (
                       SELECT COUNT(*) FROM production_lines pl
                        WHERE pl.plant = o.plant AND pl.production_line = o.production_line
                   ) = 1
                """,
                (batch_id,),
            )
            conn.commit()
            # Seam 2 — materialize color/prt_01/prt_02/production_version from
            # material_plants (docs/scheduling_priority.md). Strictly downstream of
            # the plant backfill above: it reads o.plant, which must already be
            # derived. The upload ALWAYS succeeds regardless of how much is
            # unmatched (N5/N6/N7) — unmatched pairs become an exception report,
            # never a block.
            attr_result = _stamp_order_attributes(conn, batch_id=batch_id)
            conn.commit()
            missing_master_data = attr_result["exceptions"]
            if attr_result["unmatched_pairs"]:
                warnings.append({
                    "level": "info",
                    "category": "missing_master_data",
                    "msg": (f"{attr_result['unmatched_orders']} order(s) across "
                            f"{attr_result['unmatched_pairs']} material/plant pair(s) have no "
                            f"matching material_plants row — color/PRT/production-version "
                            f"sequencing is unavailable for them until master data is added "
                            f"and this plant is resynced. See GET /upload/{batch_id}/"
                            f"missing-master-data for the full list."),
                    "exceptions": missing_master_data,
                })
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

    return {
        "status": "ok",
        "batch_id": batch_id,
        "inserted": inserted,
        "updated": updated,
        "failed": 0,
        "warnings": warnings,
        # Summary only (never blocking — N5/N6/N7). Full per-material detail is the
        # same list persisted into upload_audit.warnings above, served in full by
        # GET /upload/{batch_id}/missing-master-data.
        "missing_master_data": {
            "unmatched_pairs": attr_result["unmatched_pairs"],
            "unmatched_orders": attr_result["unmatched_orders"],
        },
    }


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

    # RUN_TIME must be parsed BEFORE the "bad" (missing/corrupt finish) branch
    # below so that branch can resolve to start + RUN_TIME hours instead of a
    # hardcoded bump. A hardcoded +1h produced a THIRD, undetected raw shape
    # whenever RUN_TIME != 1 — one that app.js's due-date-baseline correction
    # heuristic (which only recognizes "== start" or "== start + RUN_TIME
    # hours") never matched, permanently misclassifying those orders as
    # already-correct.
    df["RUN_TIME"] = pd.to_numeric(
        df["RUN_TIME"] if "RUN_TIME" in df.columns else pd.Series(1.0, index=df.index),
        errors="coerce",
    ).fillna(1.0)

    bad = df["BASIC_FINISH_DATE"] <= df["BASIC_START_DATE"]
    df.loc[bad, "BASIC_FINISH_DATE"] = (
        df.loc[bad, "BASIC_START_DATE"]
        + pd.to_timedelta(df.loc[bad, "RUN_TIME"], unit="h")
    )

    bad_start = df["BASIC_START_DATE"].isna()
    if bad_start.any():
        warnings.append({
            "level": "error",
            "msg": f"{int(bad_start.sum())} row(s) dropped — unparseable BASIC_START_DATE",
        })
    df = df.dropna(subset=["BASIC_START_DATE"]).reset_index(drop=True)

    # A genuinely date-only (but not "bad") finish — SAP supplied a real
    # calendar date with no time-of-day — is likewise re-derived from
    # RUN_TIME rather than trusted as a bare midnight, mirroring app.js's
    # date-only-start handling (Persistence._snapToWorkingHours).
    mask_notime = df["BASIC_FINISH_DATE"].dt.hour == 0
    df.loc[mask_notime, "BASIC_FINISH_DATE"] = (
        df.loc[mask_notime, "BASIC_START_DATE"]
        + pd.to_timedelta(df.loc[mask_notime, "RUN_TIME"], unit="h")
    )

    qcol = "ORDER_QUANTITY_(GMEIN)"
    if qcol in df.columns:
        df[qcol] = pd.to_numeric(df[qcol], errors="coerce")

    # ---------- Build per-row dicts (keyed by orders columns) ----------
    # The id + cumcount dedup, chunked upsert, plant backfill, ambiguous-plant
    # warning, and upload_audit insert now live in upsert_orders() so the SAP
    # path can share them. Here we only translate the cleaned DataFrame into the
    # list[dict] shape upsert_orders consumes.
    def _v(row, col):
        if col not in df.columns:
            return None
        val = row.get(col)
        return None if pd.isna(val) else val

    def _ts(val):
        return val.to_pydatetime() if pd.notna(val) else None

    rows = []
    for _, r in df.iterrows():
        rows.append({
            "production_order": _str_id(r.get("PRODUCTION_ORDER", "")),
            "material_number": _str_id(r.get("MATERIAL_NUMBER", "")),
            "material_description": _v(r, "MATERIAL_DESCRIPTION"),
            "production_line": _v(r, "PRODUCTION_LINE"),
            "plant": _v(r, "PLANT"),
            "basic_start_date": _ts(r["BASIC_START_DATE"]),
            "basic_finish_date": _ts(r["BASIC_FINISH_DATE"]),
            "run_time": float(r["RUN_TIME"]) if pd.notna(r["RUN_TIME"]) else None,
            "color": _v(r, "COLOR"),
            "order_quantity": float(r[qcol]) if (qcol in df.columns and pd.notna(r.get(qcol))) else None,
            "form_size": _v(r, "FORM_SIZE"),
            "firming_indicator": _v(r, "FIRMING_INDICATOR"),
        })

    result = upsert_orders(
        rows,
        batch_id=batch_id,
        source="excel",
        filename=filename,
        raw_row_count=raw_row_count,
        warnings=warnings,
    )
    if result.get("status") != "ok":
        # upsert_orders already wrote a failed-audit trail and re-raised on a
        # persist failure; this branch covers any defensive non-ok return.
        return result

    lines = sorted({str(v) for v in df["PRODUCTION_LINE"].dropna().unique()}) \
        if "PRODUCTION_LINE" in df.columns else []

    # Preserve the historical return shape exactly: include raw_row_count + lines
    # alongside the upsert_orders result (which carries status/batch_id/
    # inserted/updated/warnings/failed).
    return {
        "status": "ok",
        "batch_id": result["batch_id"],
        "raw_row_count": raw_row_count,
        "inserted": result["inserted"],
        "updated": result["updated"],
        "lines": lines,
        "warnings": result["warnings"],
    }


# =========================
# COLOR WHEELS
# =========================
# Durable per-plant color wheels (table: color_wheel). Replaces the ephemeral
# COLOR_WHEEL_DIR/color_wheel_<SAFE>.xlsx + _meta.json files. brain.py owns the
# xlsx parsing and the in-memory GLOBAL_CW/PLANT_CWS cache; this module owns
# persistence only. `entries` is a {COLOR: ORDER_Y} map — colors upper/stripped,
# ranks native floats or None (a blank/NaN rank is stored as JSON null and read
# back as last-priority 999999 by apply_color_merge / get_color_wheel).
def ensure_color_wheel_table() -> None:
    """Idempotent: create the color_wheel table if missing (mirrors schema.sql /
    migrations/2026-07-07-color-wheel-table.sql). Lets the app self-bootstrap even
    before the migration is applied, matching the other ensure_* startup hooks."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS color_wheel (
                plant_key   TEXT PRIMARY KEY,
                plant_label TEXT NOT NULL,
                entries     JSONB NOT NULL,
                filename    TEXT,
                row_count   INTEGER NOT NULL DEFAULT 0,
                uploaded_by TEXT,
                uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        conn.commit()


def upsert_color_wheel(plant_key: str, plant_label: str, entries: dict,
                       filename: str | None = None, row_count: int = 0,
                       uploaded_by: str | None = None) -> dict:
    """Insert or replace a plant's color wheel. Returns {"inserted": bool} —
    True on a first upload, False when an existing wheel was replaced."""
    sql = """
        INSERT INTO color_wheel (
            plant_key, plant_label, entries, filename, row_count, uploaded_by, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (plant_key) DO UPDATE SET
            plant_label = EXCLUDED.plant_label,
            entries     = EXCLUDED.entries,
            filename    = EXCLUDED.filename,
            row_count   = EXCLUDED.row_count,
            uploaded_by = EXCLUDED.uploaded_by,
            updated_at  = NOW()
        RETURNING (xmax = 0) AS inserted
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (plant_key, plant_label, Jsonb(entries),
                          filename, int(row_count), uploaded_by))
        inserted = bool(cur.fetchone()[0])
        conn.commit()
    return {"inserted": inserted}


def delete_color_wheel(plant_key: str) -> dict | None:
    """Delete a plant's color wheel. Returns {"filename": ...} for the deleted
    row, or None if there was nothing to delete."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM color_wheel WHERE plant_key = %s RETURNING filename",
                    (plant_key,))
        row = cur.fetchone()
        conn.commit()
    return None if row is None else {"filename": row[0]}


def get_color_wheel_row(plant_key: str) -> dict | None:
    """Return one plant's color-wheel row (entries JSONB auto-decoded to a dict)
    or None if the plant has no wheel."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT plant_key, plant_label, entries, filename, row_count,"
            " uploaded_by, uploaded_at"
            " FROM color_wheel WHERE plant_key = %s",
            (plant_key,))
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "plant_key": row[0], "plant_label": row[1], "entries": row[2] or {},
        "filename": row[3], "row_count": row[4],
        "uploaded_by": row[5], "uploaded_at": row[6],
    }


def load_all_color_wheels() -> dict:
    """Return {plant_key: {COLOR: ORDER_Y}} for every stored wheel — used to
    rebuild the PLANT_CWS cache at startup and on /reload."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant_key, entries FROM color_wheel")
        return {r[0]: (r[1] or {}) for r in cur.fetchall()}


def list_color_wheels_meta(limit: int | None = None,
                           offset: int | None = None) -> tuple[dict, int]:
    """Return ({plant_label: {uploaded_at, uploaded_by, filename, row_count}}, total)
    for the /color-wheels listing. Ordered by plant_label for a deterministic
    paged slice; total is the full count regardless of paging."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM color_wheel")
        total = cur.fetchone()[0]
        q = ("SELECT plant_label, uploaded_at, uploaded_by, filename, row_count"
             " FROM color_wheel ORDER BY plant_label")
        params: list = []
        if limit is not None:
            q += " LIMIT %s"
            params.append(int(limit))
        if offset:
            q += " OFFSET %s"
            params.append(int(offset))
        cur.execute(q, params)
        out: dict = {}
        for label, uploaded_at, uploaded_by, filename, row_count in cur.fetchall():
            out[label] = {
                "uploaded_at": uploaded_at.isoformat() if uploaded_at else None,
                "uploaded_by": uploaded_by,
                "filename": filename,
                "row_count": row_count,
            }
    return out, total


# =========================
# PRIORITY LISTS (docs/scheduling_priority.md — Stage 1: data plumbing only)
# =========================
# Generalizes color_wheel to any field in master_data.RANKABLE_FIELDS. One row
# per (plant, line, field_key); line = '' means plant-wide, a specific
# production_line overrides the plant-wide list for that line only (mirrors
# line_calendar / line_blackout's line: null convention). `entries` is a
# {NORMALIZED_VALUE: RANK} map, the same shape color_wheel already used for
# {COLOR: ORDER_Y}. This module owns persistence only — brain.py owns the
# upload parsing and the PLANT_LISTS in-memory cache, same split as
# color_wheel above. Deliberately mirrors that block's function shapes
# one-for-one so a caller familiar with color_wheel needs nothing new.
def ensure_priority_list_table() -> None:
    """Idempotent: create the priority_list table if missing (mirrors schema.sql /
    migrations/2026-08-11-priority-lists.sql). Lets the app self-bootstrap even
    before the migration is applied, matching the other ensure_* startup hooks."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS priority_list (
                plant         TEXT NOT NULL,
                line          TEXT NOT NULL DEFAULT '',
                field_key     TEXT NOT NULL,
                entries       JSONB NOT NULL,
                source_column TEXT NOT NULL,
                value_column  TEXT,
                rank_column   TEXT,
                filename      TEXT,
                row_count     INTEGER NOT NULL DEFAULT 0,
                uploaded_by   TEXT,
                uploaded_at   TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (plant, line, field_key)
            )
        """)
        conn.commit()


def upsert_priority_list(plant: str, field_key: str, entries: dict, *, line: str = "",
                         source_column: str, value_column: str | None = None,
                         rank_column: str | None = None, filename: str | None = None,
                         row_count: int = 0, uploaded_by: str | None = None) -> dict:
    """Insert or replace one (plant, line, field_key) priority list. Returns
    {"inserted": bool} — True on a first upload for that scope, False when an
    existing list was replaced. `line=""` (the default) is plant-wide."""
    q = """
        INSERT INTO priority_list (
            plant, line, field_key, entries, source_column, value_column,
            rank_column, filename, row_count, uploaded_by, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (plant, line, field_key) DO UPDATE SET
            entries       = EXCLUDED.entries,
            source_column = EXCLUDED.source_column,
            value_column  = EXCLUDED.value_column,
            rank_column   = EXCLUDED.rank_column,
            filename      = EXCLUDED.filename,
            row_count     = EXCLUDED.row_count,
            uploaded_by   = EXCLUDED.uploaded_by,
            updated_at    = NOW()
        RETURNING (xmax = 0) AS inserted
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(q, (plant, line, field_key, Jsonb(entries), source_column,
                        value_column, rank_column, filename, int(row_count), uploaded_by))
        inserted = bool(cur.fetchone()[0])
        conn.commit()
    return {"inserted": inserted}


def delete_priority_list(plant: str, field_key: str, line: str = "") -> dict | None:
    """Delete one (plant, line, field_key) priority list. Returns {"filename": ...}
    for the deleted row, or None if there was nothing to delete."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM priority_list WHERE plant = %s AND line = %s AND field_key = %s"
            " RETURNING filename",
            (plant, line, field_key),
        )
        row = cur.fetchone()
        conn.commit()
    return None if row is None else {"filename": row[0]}


def get_priority_list(plant: str, field_key: str, line: str = "") -> dict | None:
    """Return one (plant, line, field_key) priority-list row (entries JSONB
    auto-decoded to a dict), or None if it doesn't exist."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT plant, line, field_key, entries, source_column, value_column,"
            " rank_column, filename, row_count, uploaded_by, uploaded_at"
            " FROM priority_list WHERE plant = %s AND line = %s AND field_key = %s",
            (plant, line, field_key),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {
        "plant": row[0], "line": row[1], "field_key": row[2], "entries": row[3] or {},
        "source_column": row[4], "value_column": row[5], "rank_column": row[6],
        "filename": row[7], "row_count": row[8],
        "uploaded_by": row[9], "uploaded_at": row[10],
    }


def load_all_priority_lists() -> dict:
    """Return {plant: {line: {field_key: {VALUE: RANK}}}} for every stored list —
    used to rebuild brain.py's PLANT_LISTS cache at startup, on /reload, and
    after any upload/resync. `line=""` is the plant-wide scope."""
    out: dict = {}
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant, line, field_key, entries FROM priority_list")
        for plant, line, field_key, entries in cur.fetchall():
            out.setdefault(plant, {}).setdefault(line, {})[field_key] = entries or {}
    return out


def list_priority_lists_meta(plant: str | None = None, field_key: str | None = None,
                             limit: int | None = None,
                             offset: int | None = None) -> tuple[list[dict], int]:
    """Return ([{plant, line, field_key, uploaded_at, uploaded_by, filename,
    row_count}, ...], total) for the Optimization tab's list of uploaded
    priority lists, optionally scoped to one plant and/or one field (the
    legacy-compat GET /color-wheels endpoint passes field_key='colorWheel' so
    pagination applies to the already-filtered set, not the whole table).
    Ordered by (plant, field_key, line) for a deterministic paged slice;
    total is the full count regardless of paging."""
    where, params = [], []
    if plant:
        where.append("plant = %s")
        params.append(plant)
    if field_key:
        where.append("field_key = %s")
        params.append(field_key)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM priority_list{where_sql}", params)
        total = cur.fetchone()[0]
        q = (f"SELECT plant, line, field_key, uploaded_at, uploaded_by, filename, row_count"
             f" FROM priority_list{where_sql} ORDER BY plant, field_key, line")
        page_params = list(params)
        if limit is not None:
            q += " LIMIT %s"
            page_params.append(int(limit))
        if offset:
            q += " OFFSET %s"
            page_params.append(int(offset))
        cur.execute(q, page_params)
        out = [
            {
                "plant": r[0], "line": r[1], "field_key": r[2],
                "uploaded_at": r[3].isoformat() if r[3] else None,
                "uploaded_by": r[4], "filename": r[5], "row_count": r[6],
            }
            for r in cur.fetchall()
        ]
    return out, total


def priority_list_coverage(plant: str, fields: dict[str, str]) -> dict:
    """ONE aggregate query per plant (N3: 70 lines x 4 fields must not become up
    to 280 separate lookups) — a UNION ALL of one SELECT per field, returning
    for every production line with orders at this plant how many distinct
    values that field has and how many of those are covered by a rank.

    `fields` is {field_key: source_column} — supplied by the caller
    (master_data.RANKABLE_FIELDS is the single source of truth for that
    mapping, N19; this function stays agnostic of what fields exist to avoid
    db.py importing master_data, which already imports db.py).

    A line's "covered by a rank" set falls back plant-wide when no
    line-specific list exists — COALESCE(line row, plant-wide row) — the same
    resolution Stage 3's client-side rank lookup will use. In Stage 1 no
    upload path exists yet (Stage 2), so every priority_list row today is
    plant-wide (line=''); the per-line breakdown already works correctly for
    that case (every line falls back to the one plant-wide row) and needs no
    change once Stage 2 starts writing line-scoped rows.

    Returns {field_key: {line_or_empty_string: {"distinct_values": int,
    "ranked_values": int}}}. Caller should cache this (R12).
    """
    if not fields:
        return {}
    parts, params = [], []
    for field_key, source_column in fields.items():
        parts.append(sql.SQL("""
            SELECT %s AS field_key,
                   COALESCE(o.production_line, '') AS line,
                   COUNT(DISTINCT UPPER(TRIM(o.{col}))) AS distinct_values,
                   COUNT(DISTINCT UPPER(TRIM(o.{col}))) FILTER (
                       WHERE COALESCE(pl_line.entries, pl_plant.entries, '{{}}'::jsonb)
                             ? UPPER(TRIM(o.{col}))
                   ) AS ranked_values
              FROM orders o
              LEFT JOIN priority_list pl_line
                ON pl_line.plant = o.plant AND pl_line.line = o.production_line
               AND pl_line.field_key = %s
              LEFT JOIN priority_list pl_plant
                ON pl_plant.plant = o.plant AND pl_plant.line = ''
               AND pl_plant.field_key = %s
             WHERE o.plant = %s
               AND o.{col} IS NOT NULL AND o.{col} <> ''
             GROUP BY COALESCE(o.production_line, '')
        """).format(col=sql.Identifier(source_column)))
        params.extend([field_key, field_key, field_key, plant])

    full_q = sql.SQL(" UNION ALL ").join(parts)
    result: dict[str, dict] = {fk: {} for fk in fields}
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(full_q, params)
        for field_key, line, dv, rv in cur.fetchall():
            result[field_key][line] = {"distinct_values": dv, "ranked_values": rv}
    return result
