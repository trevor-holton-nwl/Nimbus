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
from datetime import datetime, time as dt_time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
import pandas as pd
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

# Pinned to this file's own directory (repo root) rather than a bare
# load_dotenv()'s upward search — from inside a git worktree (no local .env
# of its own), an unscoped search walks up and silently loads the MAIN
# repo's .env, which may point at the live Azure pilot DB (see CLAUDE.md's
# DB-safety note). tests/conftest.py already pins its own load_dotenv() the
# same way for the same reason; this makes bare `import db` safe too.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

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


def _zero_pad(value, width: int):
    """Left-pad a textual code field with '0' to `width` chars so a spreadsheet's
    numeric coercion (which drops leading zeros) never creates a mismatched key
    (ROUTING_RUNTIME_DESIGN.md §4 item 3, e.g. production_version '1' -> '0001').
    Leaves a falsy value (None/'') alone."""
    return value.zfill(width) if value else value


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

# A parent order owns a complete, ordered segment aggregate.  The lateral
# projection keeps the hot /tasks read path to one query and, importantly,
# resolves the visible parent envelope from the children when they exist.
_SCHEDULE_SEGMENTS_LATERAL_SQL = """
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) AS segment_count,
            MIN(s.scheduled_start) AS first_start,
            MAX(s.scheduled_end) AS last_end,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'sequence', s.segment_no,
                        'start_date', s.scheduled_start,
                        'end_date', s.scheduled_end
                    ) ORDER BY s.segment_no
                ),
                '[]'::jsonb
            ) AS schedule_segments,
            COALESCE(
                SUM(EXTRACT(EPOCH FROM (s.scheduled_end - s.scheduled_start)) / 60.0),
                0
            ) AS productive_minutes
        FROM order_schedule_segments s
        WHERE s.order_id = o.id
    ) seg ON TRUE
"""

_SCHEDULE_RUNTIME_MISMATCH_SQL = """
    (COALESCE(o.runtime_schedule_mismatch, FALSE)
     OR (seg.segment_count >= 2
         AND o.run_time IS NOT NULL
         AND seg.productive_minutes <> ROUND(o.run_time * 60)))
"""

# When an ingest just changed RUN_TIME, retain the pre-existing scheduled end
# while the browser either regenerates the authoritative parent aggregate or
# exposes the mismatch. Outside that narrow state, retain the established
# runtime-derived effective-end behavior for legacy continuous orders.
_EFF_END_WITH_RUNTIME_MISMATCH_SQL = (
    "COALESCE("
    "CASE WHEN COALESCE(o.runtime_schedule_mismatch, FALSE) "
    "THEN o.scheduled_end END, "
    f"{_EFF_END_SQL})"
)

MIN_SEGMENT_MINUTES = 30


def _min_segment_minutes_by_plant(cur, plants) -> dict[str, int]:
    """Batch-resolve plants.min_productive_segment_minutes for a distinct
    plant set (B3 review fix, 2026-08-21) — one query for the whole set
    update_task_dates_bulk needs, not N+1 per item. A NULL value (or a plant
    absent from the result, e.g. an unmigrated column) is not included, so
    callers should read via `.get(plant, MIN_SEGMENT_MINUTES)`; a non-NULL
    value is always returned as-is (the column is NOT NULL at the schema
    level, so NULL here only arises pre-migration)."""
    clean_plants = sorted({p for p in plants if p})
    if not clean_plants:
        return {}
    cur.execute(
        "SELECT plant, min_productive_segment_minutes FROM plants WHERE plant = ANY(%s)",
        (clean_plants,),
    )
    return {row[0]: row[1] for row in cur.fetchall() if row[1] is not None}


def _canonical_nullable_attribute(value):
    """Use the same nullable text representation for snapshots and persisted edits."""
    return (value.strip() or None) if isinstance(value, str) else value


def _canonical_runtime_minutes(value) -> int | None:
    """Return the scheduling runtime in integral minutes, or None when absent.

    Decimal is deliberate: a binary float must not turn a 30-minute segment
    into 29.999999 minutes at the database boundary.
    """
    if value is None:
        return None
    try:
        minutes = (Decimal(str(value)) * Decimal("60")).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
        return int(minutes)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _validate_schedule_segments(
    segments: list[dict], runtime_value, min_segment_minutes: int = MIN_SEGMENT_MINUTES,
) -> tuple[list[dict], object, object] | None:
    """Validate and normalize a caller-supplied parent aggregate.

    The caller supplies only values (never child row identities).  We rebuild
    segment numbers from their ordered boundaries, which prevents a stale or
    malicious client from addressing a child independently of its parent.

    `min_segment_minutes` (B3 review fix, 2026-08-21) is the productive-
    segment floor to enforce below — defaults to the module-level
    MIN_SEGMENT_MINUTES for a caller with no plant context, but
    update_task_dates_bulk passes the specific plant's configured
    plants.min_productive_segment_minutes (resolved via
    _min_segment_minutes_by_plant) so a plant that configures a lower floor
    isn't rejected against the hardcoded default.
    """
    runtime_minutes = _canonical_runtime_minutes(runtime_value)
    if runtime_minutes is None or runtime_minutes <= 0:
        return None

    clean: list[dict] = []
    for expected_sequence, raw in enumerate(segments, start=1):
        if not isinstance(raw, dict):
            return None
        # A full aggregate is ordered at the wire boundary too.  We do not
        # silently re-order a caller's pieces: that would turn an out-of-order
        # or stale aggregate into a different schedule than the planner sent.
        sequence = raw.get("sequence")
        if (not isinstance(sequence, int) or isinstance(sequence, bool)
                or sequence != expected_sequence):
            return None
        start, end = raw.get("start"), raw.get("end")
        if start is None or end is None or end <= start:
            return None
        if any((getattr(start, "second", 0), getattr(start, "microsecond", 0),
                getattr(end, "second", 0), getattr(end, "microsecond", 0))):
            return None
        minutes = int((end - start).total_seconds() // 60)
        if minutes <= 0 or (end - start).total_seconds() != minutes * 60:
            return None
        if clean and start < clean[-1]["end"]:
            return None
        # Adjacent productive pieces have no meaningful interruption.  Collapse
        # them before persistence, so the aggregate stays in the compatible
        # one-parent shape whenever allocation is actually continuous.
        if clean and start == clean[-1]["end"]:
            clean[-1]["end"] = end
            clean[-1]["minutes"] += minutes
        else:
            clean.append({"start": start, "end": end, "minutes": minutes})

    total_minutes = sum(item["minutes"] for item in clean)
    if total_minutes != runtime_minutes:
        return None

    # One productive interval is deliberately stored as the legacy continuous
    # parent shape.  It is exempt from the plant's configured (or default
    # 30-minute) child minimum because a genuinely short order has no
    # "partial" segment to protect.
    if len(clean) == 1:
        only = clean[0]
        return [], only["start"], only["end"]

    if len(clean) >= 2 and any(item["minutes"] < min_segment_minutes for item in clean):
        return None

    normalized = [
        {"sequence": index, "start": item["start"], "end": item["end"]}
        for index, item in enumerate(clean, start=1)
    ]
    if not normalized:
        return [], None, None
    return normalized, normalized[0]["start"], normalized[-1]["end"]


# ---------------------------------------------------------------------------
# Workstream C1 (2026-08-20) — plant visibility horizon.
#
# How far into the future a planner can see on the Gantt/Orders tab, enforced
# server-side (docs/multi_change_spec_08.20.26.md, section C1) so the horizon
# bounds the /tasks payload itself, not just what the frontend chooses to
# render. compute_visibility_horizon_end is the single, pure, testable piece
# of clock math; the frontend deliberately carries no copy of it (Step 2) —
# GET /tasks sends the already-computed instant down in `meta`.
# ---------------------------------------------------------------------------
def _horizon_boundary_core(now_utc: datetime, timezone_name: str | None,
                            horizon_roll_hour_utc: int, days: int) -> datetime:
    """The one anchor-day/roll-hour clock implementation shared by the plant
    visibility horizon (C1) and the plant frozen horizon (C2, 2026-08-20) —
    see the controller ruling in that workstream's task brief: reuse this
    exact math, parameterized by day-count, rather than inventing a second
    clock. Callers (compute_visibility_horizon_end / compute_frozen_horizon_end)
    own their own "what does an absent/zero day-count mean" convention and
    call this only once they've already decided the horizon is active.

    anchor_day is "today" in the plant's timezone, advanced one calendar day
    once `now_utc`'s UTC hour reaches `horizon_roll_hour_utc` — a deliberate
    once-daily roll, not a minute-by-minute creep (OD-C1c: the plant-local
    clock and the UTC roll clock are allowed to disagree). The result is a
    naive datetime: scheduled_start/basic_start_date are already treated as
    plant-local wall-clock values with no further tz conversion elsewhere in
    this codebase (same convention as setup_data._plant_local_capture), so
    this value is directly comparable to those columns with no conversion.

    An unresolvable/missing timezone falls back to treating `now_utc` itself
    as the local clock (UTC), same fallback setup_data.py already uses for
    plant-local captures — never raises on bad master data.
    """
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    try:
        local_now = now_utc.astimezone(ZoneInfo(timezone_name)) if timezone_name else now_utc
    except ZoneInfoNotFoundError:
        local_now = now_utc
    anchor_day = local_now.date()
    if now_utc.astimezone(timezone.utc).hour >= int(horizon_roll_hour_utc):
        anchor_day += timedelta(days=1)
    horizon_date = anchor_day + timedelta(days=int(days))
    return datetime.combine(horizon_date, dt_time.min)


def compute_visibility_horizon_end(now_utc: datetime, timezone_name: str | None,
                                    horizon_roll_hour_utc: int,
                                    visibility_horizon_days: int | None) -> datetime | None:
    """Return the plant-local-midnight instant beyond which orders are hidden,
    or None when the horizon is unlimited (visibility_horizon_days is None).
    See `_horizon_boundary_core` for the shared clock math.
    """
    if visibility_horizon_days is None:
        return None
    return _horizon_boundary_core(now_utc, timezone_name, horizon_roll_hour_utc, visibility_horizon_days)


def compute_frozen_horizon_end(now_utc: datetime, timezone_name: str | None,
                                horizon_roll_hour_utc: int,
                                frozen_horizon_days: int | None) -> datetime | None:
    """Workstream C2 (2026-08-20) — the plant-local-midnight instant through
    which the optimizer may not place or move any order (the "frozen
    window" is [now, this instant)); an order whose own start already falls
    inside it is treated as implicitly pinned rather than moved.

    Reuses the EXACT SAME anchor-day/roll-hour clock as
    compute_visibility_horizon_end (`_horizon_boundary_core`) — one clock
    implementation, not two. The only difference is the null convention:
    unlike visibility_horizon_days (NULL alone means unlimited),
    frozen_horizon_days treats BOTH NULL and 0 as "off" (per this
    workstream's controller ruling and docs/multi_change_spec_08.20.26.md's
    C2 section) — a 0-day frozen window is meaningless and must disable the
    feature outright rather than resolve to some same-instant boundary.
    """
    if not frozen_horizon_days:
        return None
    return _horizon_boundary_core(now_utc, timezone_name, horizon_roll_hour_utc, frozen_horizon_days)


def _horizon_bounds_for_plant(cur, plant: str) -> tuple[datetime | None, datetime | None]:
    """Look up one plant's C1 + C2 horizon config on the caller's own cursor
    (so query_orders/count_orders spend no extra pool checkout) and resolve
    both to concrete bounds. Returns `(visibility_horizon_end, frozen_horizon_end)`
    — either may be None (unknown plant, or that horizon is off)."""
    cur.execute(
        "SELECT visibility_horizon_days, horizon_roll_hour_utc, timezone, frozen_horizon_days "
        "FROM plants WHERE plant = %s LIMIT 1",
        (plant,),
    )
    row = cur.fetchone()
    if row is None:
        return None, None
    visibility_horizon_days, horizon_roll_hour_utc, timezone_name, frozen_horizon_days = row
    now_utc = datetime.now(timezone.utc)
    visibility_end = compute_visibility_horizon_end(
        now_utc, timezone_name, horizon_roll_hour_utc, visibility_horizon_days,
    )
    frozen_end = compute_frozen_horizon_end(
        now_utc, timezone_name, horizon_roll_hour_utc, frozen_horizon_days,
    )
    return visibility_end, frozen_end


def plant_horizons(plant: str) -> dict:
    """Meta-only horizon probe for one plant (GET /tasks/horizons) — the same
    resolved instants GET /tasks ships in `meta`, without the task payload.
    Exists so the Gantt can refresh its frozen/visibility-horizon bands on tab
    re-entry without a full /tasks reload (which has no unsaved-edit guard).
    Reuses the exact compute_* clock as _horizon_bounds_for_plant; unknown
    plant -> every value None."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT visibility_horizon_days, horizon_roll_hour_utc, timezone, "
            "frozen_horizon_days, alt_flag_horizon "
            "FROM plants WHERE plant = %s LIMIT 1",
            (plant,),
        )
        row = cur.fetchone()
    if row is None:
        return {"visibility_horizon_end": None, "frozen_horizon_end": None, "alert_horizon_minutes": None}
    visibility_horizon_days, horizon_roll_hour_utc, timezone_name, frozen_horizon_days, alt_flag_horizon = row
    now_utc = datetime.now(timezone.utc)
    return {
        "visibility_horizon_end": compute_visibility_horizon_end(now_utc, timezone_name, horizon_roll_hour_utc, visibility_horizon_days),
        "frozen_horizon_end": compute_frozen_horizon_end(now_utc, timezone_name, horizon_roll_hour_utc, frozen_horizon_days),
        "alert_horizon_minutes": int(alt_flag_horizon) if alt_flag_horizon is not None else None,
    }


# Shared projection for the orders read path. Column aliases are the contract the
# frontend/brain.py rely on; user scheduling overrides take precedence over the
# SAP-source dates via COALESCE so callers only ever see one start/end per order.
_ORDERS_SELECT = f"""
    SELECT
        id,
        production_order      AS "PRODUCTION_ORDER",
        material_number       AS "MATERIAL_NUMBER",
        material_description  AS "MATERIAL_DESCRIPTION",
        o.machine              AS "MACHINE",
        o.plant                AS "PLANT",
        CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.first_start, scheduled_start, basic_start_date) END AS "BASIC_START_DATE",
        CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.last_end, {_EFF_END_WITH_RUNTIME_MISMATCH_SQL}) END AS "BASIC_FINISH_DATE",
        o.planning_status AS "PLANNING_STATUS",
        o.planning_reason AS "PLANNING_REASON",
        basic_start_date      AS "ORIGINAL_START_DATE",
        basic_finish_date     AS "ORIGINAL_END_DATE",
        (seg.segment_count >= 2 OR scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL) AS "USER_SCHEDULED",
        run_time              AS "RUN_TIME",
        -- Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.2/§13): server-computed
        -- provenance for run_time. Deliberately snake_case, unmatched to this
        -- SELECT's SAP-style uppercase alias convention, because the DTO wire
        -- key is exactly run_time_source/run_time_basis (no aliasing) per the
        -- design's own DTO contract.
        o.run_time_source     AS run_time_source,
        o.run_time_basis      AS run_time_basis,
        color                 AS "COLOR",
        prt_01                AS "PRT_01",
        prt_02                AS "PRT_02",
        production_version    AS "PRODUCTION_VERSION",
        order_quantity        AS "ORDER_QUANTITY_(GMEIN)",
        form_size             AS "FORM_SIZE",
        notes                 AS "NOTES",
        firming_indicator     AS "FIRMING_INDICATOR",
        planned_order_initial_quantity AS "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)",
        reduced_quantity                AS "REDUCED_QUANTITY_(GMEIN)",
        order_category                  AS "ORDER_CATEGORY",
        order_type                      AS "ORDER_TYPE",
        bom_alternative                 AS "BOM_ALTERNATIVE",
        bom_usage                       AS "BOM_USAGE",
        labor_hours                     AS "LABOR_HOURS_(MEINH)",
        machine_hours                   AS "MACHINE_HOURS_(MEINH)",
        no_of_fte                       AS "NO_OF_FTE_(MEINH)",
        parent_production_order         AS "PARENT_ORDER",
        distribution_letter             AS "DISTRIBUTION_LETTER",
        -- Optimistic-concurrency token. xmin is the txid that last wrote the row;
        -- it changes on every UPDATE, gives exact integer equality (no timestamp
        -- precision/tz fragility), and needs no schema column. Cast via text because
        -- xmin's native type (xid) has no direct bigint cast.
        o.xmin::text::bigint  AS "ROW_VERSION",
        seg.schedule_segments AS "SCHEDULE_SEGMENTS",
        {_SCHEDULE_RUNTIME_MISMATCH_SQL} AS "RUNTIME_SCHEDULE_MISMATCH"
    FROM orders o
    {_SCHEDULE_SEGMENTS_LATERAL_SQL}
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
                 allowed_plants: list[str] | None = None) -> tuple[pd.DataFrame, datetime | None, datetime | None]:
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
    Rows are ordered by (machine, effective start) so brain.py's
    per-line link builder sees each line contiguously.

    C1 (2026-08-20): when `plant` is a single plant, the plant's visibility
    horizon (plants.visibility_horizon_days/horizon_roll_hour_utc) is resolved
    and applied to the SAME three-way coalesce the endpoint reports as
    BASIC_START_DATE — gating on start only (OD-C1d) — so a plant with a
    configured horizon never has to rely on the frontend to hide rows that
    were never sent. Unscoped (`plant=None`) calls are not horizon-bounded:
    the horizon is a per-plant setting and every real caller of this path
    already scopes by plant (the frontend always does; unscoped pulls are the
    documented coarse tooling guard rail, a different use case).

    Returns `(df, visibility_horizon_end, frozen_horizon_end)` — the resolved
    bounds (either may be None) are handed back alongside the rows so a
    caller that also needs to REPORT them (brain.py's GET /tasks
    `meta.visibility_horizon_end` / `meta.frozen_horizon_end`) doesn't have to
    pay for extra round-trips re-resolving the exact same plant config from
    scratch. C2 (2026-08-20): frozen_horizon_end is resolved here purely for
    that reporting purpose — unlike the visibility bound, it does NOT gate
    this query's WHERE clause; the frozen window constrains the client-side
    optimizer's placement, not which rows /tasks returns.
    """
    sql = _ORDERS_SELECT
    where, params = [], []
    if plant:
        where.append('o.plant = %s')
        params.append(plant)
    if line:
        where.append('o.machine = %s')
        params.append(line)
    if allowed_plants is not None:
        where.append('o.plant = ANY(%s)')
        params.append(allowed_plants)
    with _pool.connection() as conn, conn.cursor() as cur:
        horizon_end, frozen_end = _horizon_bounds_for_plant(cur, plant) if plant else (None, None)
        if horizon_end is not None:
            where.append("(o.planning_status = 'needs_planning' OR "
                         "COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) <= %s)")
            params.append(horizon_end)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += '\n    ORDER BY o.machine, COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date)'
        if limit is not None:
            sql += " LIMIT %s"
            params.append(int(limit))
        if offset:
            sql += " OFFSET %s"
            params.append(int(offset))
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols), horizon_end, frozen_end


def count_orders(plant: str | None = None, line: str | None = None,
                 allowed_plants: list[str] | None = None) -> int:
    """Row count for a plant/line scope — for pagination totals / tooling.

    Mirrors query_orders' WHERE construction exactly, including the C1
    visibility-horizon bound (see that function's docstring) — this is the
    "separate, duplicated WHERE builder" the C1 spec calls out
    (docs/multi_change_spec_08.20.26.md OD-C1b): historically it counted
    `orders` alone with no order_schedule_segments LATERAL, so a horizon bound
    referencing seg.first_start would have silently disagreed with
    query_orders' filtered set. It now joins the same LATERAL (harmless for a
    plain COUNT(*) — the subquery's aggregate always returns exactly one row
    per order, so the join stays one-to-one) so meta.total never lies about
    what a horizon-bounded, paged /tasks call actually returns.
    """
    sql = f"SELECT COUNT(*) FROM orders o {_SCHEDULE_SEGMENTS_LATERAL_SQL}"
    where, params = [], []
    if plant:
        where.append('o.plant = %s')
        params.append(plant)
    if line:
        where.append('o.machine = %s')
        params.append(line)
    if allowed_plants is not None:
        where.append('o.plant = ANY(%s)')
        params.append(allowed_plants)
    with _pool.connection() as conn, conn.cursor() as cur:
        horizon_end, _frozen_end = _horizon_bounds_for_plant(cur, plant) if plant else (None, None)
        if horizon_end is not None:
            where.append("(o.planning_status = 'needs_planning' OR "
                         "COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) <= %s)")
            params.append(horizon_end)
        if where:
            sql += " WHERE " + " AND ".join(where)
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
    Re-derive orders.plant where it is still NULL, from the machine->plant master-data
    mapping. Call this after machine table changes so orders uploaded BEFORE their
    machine existed in master data become plant-attributed and stop being invisible to
    the plant-scoped read path. The old LEFT-JOIN read path self-healed automatically
    on every request; a materialized plant does not, so this is the explicit hook.
    Idempotent: only NULL-plant rows whose machine now exists are touched. Returns the
    number of orders re-attributed.

    A machine code shared across plants CANNOT be attributed correctly from the code
    alone, so such rows are left NULL (and logged) rather than silently assigned to
    the lexically-lowest plant. The authoritative fix is an explicit plant column on
    upload + a plant-aware make_id (see MIGRATION.md).
    """
    sql = """
        UPDATE orders o
           SET plant = (
               SELECT MIN(m.plant) FROM machine m
                WHERE m.machine = o.machine
           )
         WHERE o.plant IS NULL
           AND (
               SELECT COUNT(DISTINCT m.plant) FROM machine m
                WHERE m.machine = o.machine
           ) = 1
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        n = cur.rowcount
        # Report (don't guess) machines that map to >1 plant and so stay unattributed.
        cur.execute(
            """
            SELECT o.machine, COUNT(*)
              FROM orders o
             WHERE o.plant IS NULL
               AND (
                   SELECT COUNT(DISTINCT m.plant) FROM machine m
                    WHERE m.machine = o.machine
               ) > 1
             GROUP BY o.machine
            """
        )
        ambiguous = cur.fetchall()
        conn.commit()
    if ambiguous:
        total = sum(int(r[1]) for r in ambiguous)
        machines = ", ".join(str(r[0]) for r in ambiguous)
        log.warning(
            "reattribute_null_plant_orders: %d order(s) left unattributed — "
            "machine code(s) shared across multiple plants: %s", total, machines,
        )
    return n


def backfill_machine_keys() -> int:
    """
    Re-derive orders.machine_key where it is still NULL, from machine.machine_key
    for the matching (plant, machine) pair. Whole-table sibling of the
    batch-scoped backfill in upsert_orders() — call this after machine table
    changes, same trigger as reattribute_null_plant_orders(). Strictly downstream
    of orders.plant: a row still NULL there is skipped here too (see MIGRATION.md
    for the pre-existing plant-ambiguity gap this inherits rather than fixes).
    Idempotent. Returns the number of orders re-attributed.
    """
    sql = """
        UPDATE orders o
           SET machine_key = (
               SELECT m.machine_key FROM machine m
                WHERE m.plant = o.plant AND m.machine = o.machine
           )
         WHERE o.machine_key IS NULL AND o.plant IS NOT NULL
           AND (
               SELECT COUNT(*) FROM machine m
                WHERE m.plant = o.plant AND m.machine = o.machine
           ) = 1
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql)
        n = cur.rowcount
        # Report (don't guess) rows left NULL because (plant, machine) matches
        # zero or more than one machine row.
        cur.execute(
            """
            SELECT o.plant, o.machine, COUNT(*)
              FROM orders o
             WHERE o.machine_key IS NULL AND o.plant IS NOT NULL
               AND (
                   SELECT COUNT(*) FROM machine m
                    WHERE m.plant = o.plant AND m.machine = o.machine
               ) <> 1
             GROUP BY o.plant, o.machine
            """
        )
        unresolved = cur.fetchall()
        conn.commit()
    if unresolved:
        total = sum(int(r[2]) for r in unresolved)
        pairs = ", ".join(f"{r[0]}/{r[1]}" for r in unresolved)
        log.warning(
            "backfill_machine_keys: %d order(s) left without a machine_key — "
            "(plant, machine) pair(s) not uniquely resolved in machine: %s", total, pairs,
        )
    return n


def get_task_versions(ids: list[str]) -> list[dict]:
    """
    Refetch the writable aggregate and authoritative runtime inputs with its xmin
    version in one read. No color-merge / link machinery is needed for reconciliation.

    Also selects o.plant so callers can apply server-side plant scoping. The
    `plant` key is for that filtering only; callers expose it as `PLANT` only
    after authorization, using the same snapshot as the runtime inputs.
    """
    if not ids:
        return []
    sql = f"""
        SELECT o.id,
               CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) END AS eff_start,
               CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.last_end, {_EFF_END_WITH_RUNTIME_MISMATCH_SQL}) END AS eff_end,
               o.xmin::text::bigint AS row_version,
               seg.schedule_segments,
               {_SCHEDULE_RUNTIME_MISMATCH_SQL} AS runtime_schedule_mismatch,
               o.plant, o.planning_status, o.planning_reason,
               o.run_time_source, o.run_time_basis,
               o.machine, o.prt_01, o.prt_02, o.production_version, o.run_time,
               o.order_quantity, o.material_number, o.basic_start_date
        FROM orders o
        {_SCHEDULE_SEGMENTS_LATERAL_SQL}
        WHERE o.id = ANY(%s)
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
            "schedule_segments": r[4] or [],
            "runtime_schedule_mismatch": bool(r[5]),
            "plant": r[6],
            "planning_status": r[7],
            "planning_reason": r[8],
            "run_time_source": r[9],
            "run_time_basis": r[10],
            "MACHINE": r[11],
            "PRT_01": r[12],
            "PRT_02": r[13],
            "PRODUCTION_VERSION": r[14],
            "RUN_TIME": r[15],
            "ORDER_QUANTITY_(GMEIN)": r[16],
            "MATERIAL_NUMBER": r[17],
            "original_start_date": r[18].strftime("%Y-%m-%dT%H:%M:%S") if r[18] else None,
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
    sets.extend(["planning_status = 'scheduled'", "planning_reason = NULL", "updated_at = NOW()"])
    params.append(task_id)
    sql = f"UPDATE orders SET {', '.join(sets)} WHERE id = %s"
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        updated = cur.rowcount
        conn.commit()
    return {"status": "ok", "updated": updated}


def _detect_interval_conflicts(intervals: list[tuple], touched: set[str]) -> list[dict]:
    """Pairwise strict overlaps (`start < other_end`, never `<=`) between orders on
    the same machine. `intervals` are (machine, order_id, start, end); an order with
    child segments contributes one tuple per segment. Same-order pairs are skipped;
    overlap minutes are summed per (machine, pair). Only pairs where at least one
    order is in `touched` (ids this save wrote) are reported, so pre-existing
    overlaps between untouched orders don't show up as consequences of this save.
    """
    by_machine: dict[str, list[tuple]] = {}
    for machine, oid, start, end in intervals:
        if not machine or start is None or end is None or end <= start:
            continue
        by_machine.setdefault(machine, []).append((start, end, oid))
    totals: dict[tuple, float] = {}
    for machine, rows in by_machine.items():
        rows.sort(key=lambda r: (r[0], r[1], r[2]))
        active: list[tuple] = []          # (end, oid) still open at the current start
        for start, end, oid in rows:
            active = [(e, o) for e, o in active if e > start]
            for e, o in active:
                if o == oid:
                    continue
                overlap = (min(e, end) - start).total_seconds() / 60.0
                if overlap <= 0:
                    continue
                a, b = sorted((o, oid))
                if a not in touched and b not in touched:
                    continue
                totals[(machine, a, b)] = totals.get((machine, a, b), 0.0) + overlap
            active.append((end, oid))
    return [{"machine": m, "order_a": a, "order_b": b, "overlap_minutes": round(v, 1)}
            for (m, a, b), v in sorted(totals.items())]


def _scan_conflicts_for_rows(cur, update_rows: list[dict], eff: dict) -> list[dict]:
    """Runs inside the still-open save transaction so the scan sees this batch's
    own UPDATEs. Window bounds come from the rows that actually moved.

    Machine names are per-plant (`machine_state` is keyed `(plant, machine)`), so at 50+ plants a shared machine name like
    'LINE1' must never let this scan pair an order in one plant against an
    order of the same machine name in a different plant — that would report a
    phantom conflict, leak an out-of-scope order id into the caller's 200
    body, and (in strict mode) roll back a perfectly legitimate save. The SQL
    filters both `o.machine` (leading, so idx_orders_machine_eff_start still
    serves it) and `o.plant`; grouping is further keyed by an internal
    plant-qualified machine token so two different plants that both touch a
    same-named machine in one batch still can't be pooled together by
    `_detect_interval_conflicts` (which only groups by its `machine` key).
    """
    moved = [r for r in update_rows if r["moved"] and not r["queued"] and r["machine"]]
    if not moved:
        return []
    machines = sorted({r["machine"] for r in moved})
    plants = sorted({eff[r["id"]]["plant"] for r in moved})
    starts = [s for s in (r["start"] or eff[r["id"]]["start"] for r in moved) if s is not None]
    ends = [e for e in (r["end"] or eff[r["id"]]["end"] for r in moved) if e is not None]
    if not starts or not ends:
        return []
    lo = min(starts) - timedelta(days=1)
    hi = max(ends) + timedelta(days=1)
    cur.execute(
        f"""
        SELECT o.machine, o.plant, o.id,
               COALESCE(seg.schedule_segments, '[]'::jsonb) AS segments,
               COALESCE(o.scheduled_start, o.basic_start_date) AS eff_start,
               {_EFF_END_SQL} AS eff_end
        FROM orders o
        {_SCHEDULE_SEGMENTS_LATERAL_SQL}
        WHERE o.machine = ANY(%s)
          AND o.plant = ANY(%s)
          AND o.planning_status <> 'needs_planning'
          AND COALESCE(o.scheduled_start, o.basic_start_date) BETWEEN %s AND %s
        """,
        (machines, plants, lo, hi),
    )
    # Plant-qualified key so _detect_interval_conflicts (grouped by its
    # `machine` field only) never pools two different plants' same-named
    # machine together; split back apart below before returning.
    intervals: list[tuple] = []
    for machine, plant, oid, segments, eff_start, eff_end in cur.fetchall():
        key = f"{plant}\x1f{machine}"
        if segments:
            for seg in segments:
                intervals.append((key, oid,
                                  datetime.fromisoformat(str(seg["start_date"])),
                                  datetime.fromisoformat(str(seg["end_date"]))))
        else:
            intervals.append((key, oid, eff_start, eff_end))
    raw = _detect_interval_conflicts(intervals, touched={r["id"] for r in moved})
    conflicts = []
    for c in raw:
        plant, machine = c["machine"].split("\x1f", 1)
        conflicts.append({"machine": machine, "plant": plant,
                          "order_a": c["order_a"], "order_b": c["order_b"],
                          "overlap_minutes": c["overlap_minutes"]})
    return conflicts


def update_task_dates_bulk(items: list[dict], allowed_plants: list[str] | None = None,
                           *, atomic_optimizer: bool = False,
                           strict_conflicts: bool = False) -> dict:
    """
    Persist parent schedule aggregates and allowlisted order attributes in one
    transaction.  A schedule_segments field is an all-or-nothing replacement
    of that parent's child set; its parent row's xmin is the only concurrency
    token.  Child rows are never addressed independently.

    Inverted ranges are rejected by validating each edit against the row's
    *effective* current dates (so updating only start still checks against the
    existing end). Unknown ids are reported, not written.

    A MACHINE edit is rejected as invalid whenever the row's PARENT_ORDER
    (parent_production_order) is set — a distribution child order may only move
    via its distribution share, never a direct machine change. This mirrors the
    frontend's client-side guard but is enforced here too since that guard is
    not authoritative.

    Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.5): a MACHINE or
    PRODUCTION_VERSION edit on an order whose run_time is routing-sourced (or
    still unknown) on a routing-runtime-enabled plant is re-checked against
    `backend.routing.resolver.check_eligibility` for the candidate combination
    before being accepted — an ineligible candidate is rejected the same way
    as any other single-aspect edit conflict in this function (folded into
    `invalid_ids`, no separate reason field). After a batch with at least one
    accepted MACHINE/PRODUCTION_VERSION edit on such a plant commits,
    `backend.routing.resolver.resolve_orders(plant)` is called for each
    affected plant (its own separate, self-committing connection, never this
    function's own transaction) so the order's run_time reflects the new
    combination immediately rather than waiting for the next plant-wide
    recompute.

    `allowed_plants` (None for an unrestricted/admin caller) scopes writes to
    the caller's assigned plants: a row whose plant falls outside the set is
    treated identically to a nonexistent id (folded into not_found_ids) so a
    caller can't distinguish "not found" from "not yours" via the response.

    Optimistic concurrency: each item may carry `base_version` (the xmin the client
    last saw) and `force`. Under the FOR UPDATE lock we read each row's current xmin;
    if `base_version` is provided, doesn't match, and `force` is falsy, the edit is
    rejected and the id is reported in `stale` (no write). Forced edits and edits with
    no base_version write unconditionally (backward-compatible). Persisted rows return
    their NEW xmin in `versions` so the client can re-stamp without a self-conflict on
    its next edit.

    Schedule conflicts (N3, 2026-09): before commit, every machine touched by a
    date/segment write is scanned for same-machine strict overlaps within
    [min new start - 1 day, max new end + 1 day] (start-indexed via
    idx_orders_machine_eff_start; queued rows excluded). Pairs involving at least
    one written id are returned in `conflicts` — advisory by default (commit and
    report). The advisory scan runs under its own SAVEPOINT: on any failure
    (Python-side or a server-side error that aborts the transaction) it is rolled
    back to that savepoint so the batch's own writes are unaffected and the
    following commit is a real commit, not a COMMIT-on-aborted-transaction silent
    rollback. `strict_conflicts=True` is honored only together with
    `atomic_optimizer`: a non-empty scan rolls the whole batch back and returns
    status 'error' / error_code 'schedule.conflicts'; a scan failure under strict
    mode propagates instead of being swallowed. The window is bounded on the
    neighbour's effective START (index-servable), so an order that began more
    than a day before the window and runs into it is not scanned;
    `conflicts == []` is not proof of no overlap.

    Returns {applied, persisted, failed, invalid, not_found, invalid_ids,
    not_found_ids, stale, versions, rejection_reasons}. invalid_ids / not_found_ids
    carry the actual ids (not just counts) so the client can stop retrying
    terminally-rejected rows while still keeping genuinely-unpersisted rows dirty
    for a retry. `rejection_reasons` is a purely additive, sparse {id: reason}
    map -- populated ONLY for the routing-eligibility rejection below
    (ROUTING_RUNTIME_DESIGN.md §8.5); every other rejection in this function's
    validation loop keeps its existing plain-id-only invalid_ids/not_found_ids
    behavior unchanged, so an id absent from this map carries no reason.
    """
    applied = persisted = failed = 0
    stale: list[str] = []
    invalid_ids: list[str] = []
    not_found_ids: list[str] = []
    versions: dict[str, int] = {}
    conflicts: list[dict] = []
    rejection_reasons: dict[str, str] = {}
    if not items:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": 0,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {}, "conflicts": [], "rejection_reasons": {}}

    # Deferred import (never module-level -- avoids a backend.routing <->
    # db.py import cycle, matching this codebase's established convention;
    # see backend/distribution/data.py, backend/integration/sap_sync.py).
    # Resolve candidate runtime inside this transaction so its schedule,
    # provenance and returned optimistic-lock token describe the same write.
    import backend.routing.resolver as routing_resolver

    ids = [it["id"] for it in items if it.get("id")]
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT o.id,
                   CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) END AS eff_start,
                   CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE COALESCE(seg.last_end, {_EFF_END_SQL}) END AS eff_end,
                   o.run_time,
                   o.xmin::text::bigint AS row_version,
                   seg.segment_count,
                   o.plant,
                   o.machine,
                   o.planning_status,
                   o.planning_reason->>'code' AS reason_code,
                   p.routing_runtime_enabled,
                   o.parent_production_order,
                   o.run_time_source,
                   o.material_number,
                   o.order_quantity,
                   o.basic_start_date,
                   o.production_version
            FROM orders o
            {_SCHEDULE_SEGMENTS_LATERAL_SQL}
            LEFT JOIN plants p ON p.plant = o.plant
            WHERE o.id = ANY(%s)
            ORDER BY o.id
            FOR UPDATE OF o
            """,
            (ids,),
        )
        eff = {
            r[0]: {
                "start": r[1], "end": r[2], "run_time": r[3],
                "row_version": r[4], "segment_count": int(r[5] or 0), "plant": r[6],
                "machine": r[7], "planning_status": r[8], "reason_code": r[9],
                # Missing plants row (shouldn't happen) reads as disabled, matching
                # today's unconditional behavior rather than gating on nothing.
                "routing_runtime_enabled": bool(r[10]),
                "parent_order": r[11],
                # ROUTING_RUNTIME_DESIGN.md §8.5's eligibility gate reads these
                # five straight from the row -- material/quantity/start date are
                # never edited by this endpoint, so the CANDIDATE check always
                # uses the row's own current values for them.
                "run_time_source": r[12],
                "material_number": r[13],
                "order_quantity": r[14],
                "basic_start_date": r[15],
                "production_version": r[16],
            }
            for r in cur.fetchall()
        }
        # B3 review fix (2026-08-21): _validate_schedule_segments's productive-
        # segment floor must honor each plant's plants.min_productive_segment_minutes,
        # not the hardcoded module default — resolved once for the whole
        # distinct plant set in this batch, not N+1 per item.
        min_segment_minutes_by_plant = _min_segment_minutes_by_plant(
            cur, (row["plant"] for row in eff.values()),
        )

        update_rows: list[dict] = []
        seen_ids: set[str] = set()
        for it in items:
            tid = it.get("id")
            start, end = it.get("start"), it.get("end")
            attrs = {
                field: _canonical_nullable_attribute(it[field])
                for field in ("PRT_01", "PRT_02", "PRODUCTION_VERSION", "MACHINE")
                if field in it
            }
            has_segments = "schedule_segments" in it
            has_runtime = "RUN_TIME" in it
            has_planning = "planning_status" in it
            planning_status = it.get("planning_status")
            planning_reason = it.get("planning_reason")
            queued = planning_status == "needs_planning"
            if (not tid or tid in seen_ids or
                    (start is None and end is None and not attrs and not has_segments and not has_runtime and not has_planning)):
                invalid_ids.append(tid)
                continue
            seen_ids.add(tid)
            if tid not in eff:
                not_found_ids.append(tid)
                continue
            current = eff[tid]
            if allowed_plants is not None and current["plant"] not in allowed_plants:
                not_found_ids.append(tid)   # out-of-scope looks identical to nonexistent
                continue
            # A stale runtime/attribute snapshot is a concurrency conflict,
            # not an invalid attempt to override authoritative runtime.
            base_version = it.get("base_version")
            if atomic_optimizer and base_version is None:
                invalid_ids.append(tid)
                continue
            if (atomic_optimizer or not it.get("force")) and base_version is not None and base_version != current["row_version"]:
                stale.append(tid)
                continue
            # The browser's save snapshot includes these fields on every edit.
            # Only changed values are edits for the child-machine lock and the
            # routing eligibility/runtime gates below.
            if "MACHINE" in attrs and attrs["MACHINE"] == _canonical_nullable_attribute(current["machine"]):
                attrs.pop("MACHINE", None)
            if ("PRODUCTION_VERSION" in attrs
                    and attrs["PRODUCTION_VERSION"] == _canonical_nullable_attribute(current["production_version"])):
                attrs.pop("PRODUCTION_VERSION", None)
            if has_runtime and (_canonical_runtime_minutes(it.get("RUN_TIME"))
                                == _canonical_runtime_minutes(current["run_time"])):
                has_runtime = False
            # Sub-order machine lock (decision C, aggregate_to_detail.md §8): a
            # distribution child order (PARENT_ORDER set) may only move via its
            # distribution share, never a direct MACHINE edit. The client already
            # guards this (orders.mts's Table._rejectDistMachineMove and
            # gantt.mts's Interaction._rejectDistMachineMove) but that guard isn't
            # authoritative — a client bug, a different client, or a direct API
            # call could bypass it, so it's enforced here too as a whole-item
            # rejection, same as any other single-aspect edit conflict in this loop.
            if "MACHINE" in attrs and current["parent_order"] is not None:
                invalid_ids.append(tid)
                continue
            # Routing runtime (ROUTING_RUNTIME_DESIGN.md §5.5/§8.2/§8.5): a client
            # RUN_TIME is only honored on a disabled plant (today's unconditional
            # behavior, preserved exactly) or to release an order currently held
            # for a routing reason. Otherwise it's rejected as a whole-item
            # validation failure, same as any other single-aspect edit conflict
            # below (e.g. the queued-order date check just past this).
            manual_runtime_release = False
            resolved_runtime = None

            # Routing runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.5): a
            # MACHINE or PRODUCTION_VERSION edit on an order whose run_time is
            # routing-derived (or not yet known at all) must re-check §5.2
            # steps 1-8 for the CANDIDATE combination before the edit is
            # accepted -- otherwise the order could land on a machine/version
            # its routing can't resolve, silently keeping a stale run_time
            # until the next plant-wide recompute. Only gated when the
            # plant's switch is on. Explicit PV changes opt into routing;
            # machine-only moves preserve manual/distributed/SAP runtimes.
            # Material, quantity, and start
            # date are never edited by this endpoint, so they always come
            # from the row's own current values; machine/production version
            # come from the candidate edit when present, else the row's
            # current value. Read within THIS SAME open transaction/
            # connection -- never a second connection mid-write.
            if (("MACHINE" in attrs or "PRODUCTION_VERSION" in attrs)
                    and current["routing_runtime_enabled"]
                    and ("PRODUCTION_VERSION" in attrs
                         or current["run_time_source"] == "routing" or current["run_time"] is None)):
                candidate_machine = attrs.get("MACHINE", current["machine"])
                candidate_pv = attrs.get("PRODUCTION_VERSION", current["production_version"])
                eligibility = routing_resolver.check_eligibility(
                    current["plant"], current["material_number"], candidate_pv,
                    candidate_machine, current["order_quantity"], current["basic_start_date"],
                    conn=conn,
                )
                if not eligibility["ok"]:
                    # Whole-item rejection, same as every other single-aspect
                    # rejection in this loop (manual_runtime_release above,
                    # the sub-order MACHINE lock above that, the queued/
                    # inverted-range checks below) -- invalid_ids itself
                    # stays a plain id list, unchanged, for all of them.
                    # This ONE rejection additionally records its specific
                    # failure step into the sparse, purely-additive
                    # `rejection_reasons` map (§8.5) -- the client-side
                    # `Runtime.eligible` guard already blocks most of these
                    # before they ever reach here, so when one DOES land
                    # here (stale/disabled client cache, or a save that
                    # bypassed the guarded UI paths), the caller can tell
                    # WHY this particular id was rejected instead of lumping
                    # it in with every unrelated invalid_ids cause above/
                    # below. `eligibility["step"]` reuses resolve_one's own
                    # failure-step vocabulary (pv_missing/pv_not_found/
                    # pv_expired/workcenter_unmapped/no_machine/no_routing/
                    # no_operation_at_workcenter/zero_runtime) rather than
                    # collapsing every cause to one hardcoded string.
                    rejection_reasons[tid] = eligibility.get("step") or "no_operation_at_workcenter"
                    invalid_ids.append(tid)
                    continue
                # Resolve and persist the candidate in THIS transaction. The
                # client preview is not a manual override, nor authoritative.
                resolved_runtime = eligibility
                if ("RUN_TIME" in it and _canonical_runtime_minutes(it["RUN_TIME"])
                        != _canonical_runtime_minutes(eligibility["hours"])):
                    # The client scheduled against an obsolete rate map. Do not
                    # acknowledge its preview with a version for a different
                    # duration; use guarded conflict recovery and reload rates.
                    stale.append(tid)
                    rejection_reasons[tid] = "runtime_preview_changed"
                    continue
                has_runtime = True

            if has_runtime and current["routing_runtime_enabled"] and resolved_runtime is None:
                if not (current["planning_status"] == "needs_planning"
                        and current["reason_code"] == "runtime_unknown"):
                    invalid_ids.append(tid)
                    continue
                manual_runtime_release = True

            cur_start, cur_end = current["start"], current["end"]
            new_start = start if start is not None else cur_start
            new_end   = end   if end   is not None else cur_end
            if has_planning and (planning_status not in ("scheduled", "needs_planning") or
                    (queued and (not isinstance(planning_reason, dict) or
                                 not isinstance(planning_reason.get("code"), str) or
                                 not isinstance(planning_reason.get("message"), str))) or
                    (planning_status == "scheduled" and planning_reason is not None)):
                invalid_ids.append(tid)
                continue
            if queued and (start is not None or end is not None or it.get("schedule_segments")):
                invalid_ids.append(tid)
                continue
            current_runtime_minutes = _canonical_runtime_minutes(current["run_time"])
            requested_runtime = (resolved_runtime["hours"] if resolved_runtime is not None
                                 else it.get("RUN_TIME") if has_runtime else current["run_time"])
            requested_runtime_minutes = _canonical_runtime_minutes(requested_runtime)
            runtime_changed = has_runtime and requested_runtime_minutes != current_runtime_minutes
            segment_rows: list[dict] | None = None

            if queued:
                new_start = new_end = None
                segment_rows = []
            elif has_segments:
                raw_segments = it.get("schedule_segments")
                if not isinstance(raw_segments, list):
                    invalid_ids.append(tid)
                    continue
                if raw_segments:
                    validated = _validate_schedule_segments(
                        raw_segments, requested_runtime,
                        min_segment_minutes_by_plant.get(current["plant"], MIN_SEGMENT_MINUTES),
                    )
                    if validated is None:
                        invalid_ids.append(tid)
                        continue
                    segment_rows, segment_start, segment_end = validated
                    # A supplied parent boundary must agree with the child
                    # aggregate; silently accepting a conflict would make the
                    # API return a different schedule than the caller saved.
                    if ((start is not None and start != segment_start) or
                            (end is not None and end != segment_end)):
                        invalid_ids.append(tid)
                        continue
                    new_start, new_end = segment_start, segment_end
                else:
                    # [] explicitly removes obsolete children.  Preserve the
                    # caller's supplied parent envelope (or current envelope)
                    # and make the delete part of this same parent write.
                    segment_rows = []
            elif current["segment_count"] >= 2 and (start is not None or end is not None or runtime_changed):
                # A direct parent move/runtime change would orphan the visible
                # child schedule.  The browser must send the regenerated full
                # aggregate; ingest remains the sole exception and surfaces a
                # runtime mismatch instead of mutating planner timing.
                invalid_ids.append(tid)
                continue

            if new_start is not None and new_end is not None and new_end <= new_start:
                invalid_ids.append(tid)
                continue

            if (not queued and (has_planning or start is not None or end is not None or has_segments)
                    and (new_start is None or new_end is None)):
                invalid_ids.append(tid)
                continue

            row_planning_status = planning_status if has_planning else (
                "scheduled" if start is not None or end is not None or has_segments else None)
            row_planning_reason = planning_reason if queued else None
            if manual_runtime_release and not queued:
                # Releasing a routing hold with a keyed-in value re-enters the
                # order at 'scheduled' with the reason cleared, in the same
                # write as the run_time itself (§5.5/§8.2).
                row_planning_status = "scheduled"
                row_planning_reason = None

            update_rows.append({
                "id": tid,
                "start": new_start if has_segments else start,
                "end": new_end if has_segments else end,
                "attrs": attrs,
                "queued": queued,
                "planning_status": row_planning_status,
                "planning_reason": row_planning_reason,
                "run_time": requested_runtime,
                "has_runtime": has_runtime,
                "manual_runtime_release": manual_runtime_release,
                "resolved_runtime": resolved_runtime,
                "segments": segment_rows,
                "clear_runtime_mismatch": has_segments or start is not None or end is not None,
                # The conflict scan below (_scan_conflicts_for_rows) filters by
                # this value to find overlaps on the machine the order actually
                # ends up on — use the NEW machine when this edit moves it,
                # not the stale pre-write one.
                "machine": attrs.get("MACHINE", current["machine"]),
                "moved": has_segments or start is not None or end is not None or has_planning or "MACHINE" in attrs,
            })

        if atomic_optimizer and (invalid_ids or not_found_ids or stale):
            conn.rollback()
            return {"applied": 0, "persisted": 0, "failed": len(items),
                    "invalid": len(invalid_ids), "not_found": len(not_found_ids),
                    "invalid_ids": invalid_ids, "not_found_ids": not_found_ids,
                    "stale": stale, "versions": {}, "conflicts": [],
                    "rejection_reasons": rejection_reasons}

        if update_rows:
            try:
                for row in update_rows:
                    sets: list[str] = []
                    params: list = []
                    if row["planning_status"] is not None:
                        sets.extend(["planning_status = %s", "planning_reason = %s"])
                        params.extend([row["planning_status"], Jsonb(row["planning_reason"]) if row["planning_reason"] else None])
                    if row["queued"]:
                        sets.extend(["scheduled_start = NULL", "scheduled_end = NULL"])
                    if row["start"] is not None and not row["queued"]:
                        sets.append("scheduled_start = %s")
                        params.append(row["start"])
                    if row["end"] is not None and not row["queued"]:
                        sets.append("scheduled_end = %s")
                        params.append(row["end"])
                    if row["has_runtime"]:
                        sets.append("run_time = %s")
                        params.append(row["run_time"])
                    if row["manual_runtime_release"]:
                        sets.append("run_time_source = 'manual'")
                    if row["resolved_runtime"] is not None:
                        sets.extend(["run_time_source = 'routing'", "run_time_basis = %s"])
                        params.append(Jsonb(row["resolved_runtime"]["basis"]))
                    if row["clear_runtime_mismatch"]:
                        sets.append("runtime_schedule_mismatch = FALSE")
                    attr_columns = {
                        "PRT_01": "prt_01",
                        "PRT_02": "prt_02",
                        "PRODUCTION_VERSION": "production_version",
                        "MACHINE": "machine",
                    }
                    for field, column in attr_columns.items():
                        if field in row["attrs"]:
                            sets.append(f"{column} = NULLIF(%s, '')")
                            params.append(row["attrs"][field])
                    # A child replacement still must touch the parent row so
                    # xmin remains the aggregate's one optimistic-lock token.
                    sets.append("updated_at = NOW()")
                    params.append(row["id"])
                    cur.execute(
                        f"UPDATE orders SET {', '.join(sets)} WHERE id = %s "
                        "RETURNING id, xmin::text::bigint AS new_version",
                        params,
                    )
                    rid, rver = cur.fetchone()
                    versions[rid] = int(rver)

                    if row["segments"] is not None:
                        cur.execute("DELETE FROM order_schedule_segments WHERE order_id = %s", (row["id"],))
                        if row["segments"]:
                            cur.executemany(
                                """
                                INSERT INTO order_schedule_segments
                                    (order_id, segment_no, scheduled_start, scheduled_end)
                                VALUES (%s, %s, %s, %s)
                                """,
                                [
                                    (row["id"], segment["sequence"], segment["start"], segment["end"])
                                    for segment in row["segments"]
                                ],
                            )
                cur.execute("SAVEPOINT conflict_scan")
                try:
                    conflicts = _scan_conflicts_for_rows(cur, update_rows, eff)
                    cur.execute("RELEASE SAVEPOINT conflict_scan")
                except Exception:
                    # The conflict scan is an advisory diagnostic layered on top of
                    # an otherwise-valid save. In strict mode the caller explicitly
                    # asked the scan to gate the commit, so there we let it
                    # propagate to the outer handler (which rolls back the whole
                    # transaction and reports status: error) instead of silently
                    # treating a broken scan as "no conflicts found".
                    if strict_conflicts and atomic_optimizer:
                        raise
                    # Advisory: a server-side failure (deadlock, statement timeout,
                    # a malformed segment object driving a bad query) leaves the
                    # transaction aborted, and Postgres executes a COMMIT on an
                    # aborted transaction as a silent ROLLBACK — which would discard
                    # this batch's writes while still reporting persisted/versions
                    # as if they landed. Roll back only the scan's own statements
                    # via the savepoint so the batch's UPDATEs survive and the
                    # conn.commit() below is a real commit.
                    cur.execute("ROLLBACK TO SAVEPOINT conflict_scan")
                    log.warning("Schedule-conflict scan failed; committing without "
                                "conflicts (advisory only, save proceeds)",
                                exc_info=True, extra={"category": "scheduling"})
                    conflicts = []
                if strict_conflicts and atomic_optimizer and conflicts:
                    conn.rollback()
                    return {"applied": 0, "persisted": 0, "failed": len(update_rows),
                            "invalid": len(invalid_ids), "not_found": len(not_found_ids),
                            "invalid_ids": invalid_ids, "not_found_ids": not_found_ids,
                            "stale": stale, "versions": {}, "conflicts": conflicts,
                            "status": "error", "error_code": "schedule.conflicts",
                            "cause": f"{len(conflicts)} schedule conflict(s) on the written machines (strict mode)",
                            "rejection_reasons": rejection_reasons}
                conn.commit()
                persisted = applied = len(versions)
            except Exception:
                conn.rollback()
                failed = len(update_rows)
                raise

    # Candidate runtime/basis were persisted with the schedule above. A second
    # plant-wide resolve here would invalidate the versions we are returning.

    return {"applied": applied, "persisted": persisted, "failed": failed,
            "invalid": len(invalid_ids), "not_found": len(not_found_ids),
            "invalid_ids": invalid_ids, "not_found_ids": not_found_ids,
            "stale": stale, "versions": versions, "conflicts": conflicts,
            "rejection_reasons": rejection_reasons}


def correct_due_date_baselines(corrections: list[dict], allowed_plants: list[str] | None = None) -> dict:
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

    `allowed_plants` (None for an unrestricted/admin caller) scopes the UPDATE
    to the caller's assigned plants via the WHERE clause. This function has no
    per-row prefetch to piggyback a plant check on (unlike update_task_dates_bulk)
    — an out-of-scope row simply fails to match the WHERE clause and lands in
    the existing `not_matched` count, with no separate response field needed.
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
            # allowed_plants is referenced twice in the WHERE clause below
            # (once for the NULL/unrestricted check, once for the ANY() match) —
            # this function uses positional %s placeholders throughout, so the
            # same value is bound twice rather than switching to named params.
            params.extend([allowed_plants, allowed_plants])
            sql = f"""
                UPDATE orders o
                SET basic_finish_date = v.new_finish,
                    updated_at        = NOW()
                FROM (VALUES {placeholders}) AS v(id, new_finish, base_version)
                WHERE o.id = v.id
                  AND o.xmin::text::bigint = v.base_version
                  AND (%s::text[] IS NULL OR o.plant = ANY(%s::text[]))
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


def get_order_plant(task_id: str) -> str | None:
    """Return a single order's plant, or None if the row doesn't exist.
    Standalone lookup for routes that need a plant-scoping check before a
    write that itself has no per-row prefetch (e.g. /task/note)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM orders WHERE id = %s", (task_id,))
        row = cur.fetchone()
    return row[0] if row else None


def update_task_note(task_id: str, notes) -> dict:
    """Persist a user-written note for an order. Pass None to clear.

    RETURNING the post-write xmin (B1 fix, 2026-09-01): this UPDATE bumps
    orders.xmin like any other, so without surfacing the new version here the
    client's cached row_version goes stale and its next real scheduling save
    spuriously lands in `stale` — same versions-map shape as
    update_task_dates_bulk so the frontend can re-stamp uniformly.
    """
    sql = ("UPDATE orders SET notes = %s, updated_at = NOW() WHERE id = %s "
           "RETURNING id, xmin::text::bigint AS new_version")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, (notes or None, task_id))
        row = cur.fetchone()
        updated = cur.rowcount
        conn.commit()
    versions = {row[0]: int(row[1])} if row else {}
    return {"status": "ok", "updated": updated, "versions": versions}


# Purge selector: plant-scoped, on the order's effective end date (scheduled_end,
# falling back to basic_finish_date). Shared verbatim between preview_purge_orders
# and purge_orders_by_date so the two can never describe different row sets —
# that divergence (a client-side preview count disagreeing with the real DELETE)
# was the original defect this pair of functions replaces. Measured against the
# only real dataset available (2026-09-08, plant 1085, 1842 orders): this
# predicate, _EFF_END_SQL, and the full /tasks read-path expression all agreed
# exactly, so the predicate itself is intentionally left unchanged — only the
# scoping is new. See docs/architecture (purge hardening) for the measurement.
_PURGE_WHERE_SQL = "plant = %(plant)s AND COALESCE(scheduled_end, basic_finish_date) BETWEEN %(start)s AND %(end)s"


def _purge_scope_sql_params(plant, start, end, machines=None):
    where = _PURGE_WHERE_SQL
    params = {"plant": plant, "start": start, "end": end}
    if machines:
        where += " AND machine = ANY(%(machines)s)"
        params["machines"] = list(machines)
    return where, params


def preview_purge_orders(plant, start, end, machines=None) -> dict:
    """Server-side dry run for a plant-scoped date-range purge. Returns a
    fully-seeded, stable-shape dict (the md.cascade_preview discipline) so the
    caller never has to distinguish "0" from "absent". `total` is the count the
    real DELETE will remove; `planner_overridden` counts orders with a
    scheduled_start (a planner-set schedule the ingest upsert never restores on
    re-upload — see schema.sql's orders comment), which is the number that
    matters most for an honest confirmation prompt."""
    where, params = _purge_scope_sql_params(plant, start, end, machines)
    sql = (f"SELECT COUNT(*), COUNT(scheduled_start) FROM orders WHERE {where}")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        total, planner_overridden = cur.fetchone()
    return {"status": "ok", "plant": plant, "total": int(total),
            "planner_overridden": int(planner_overridden)}


def purge_orders_by_date(plant, start, end, machines=None, *, user_email=None) -> dict:
    """DELETE orders in one plant whose effective end date (scheduled_end,
    falling back to basic_finish_date) falls in [start, end]. Plant-scoped
    (unlike the prior unscoped version) so a plant-restricted admin can never
    reach another plant's rows — the caller is responsible for having already
    authorized `plant` via md._assert_plant_allowed before calling this.

    Writes a durable admin_audit row in the SAME transaction as the delete, so
    an audit record can never exist without the delete it describes (or vice
    versa). The audit's order_ids list is capped at 200 (~7KB of JSONB; see the
    material_ids[:50] capping precedent in master_data.py) — deleted count and
    plant/range are always present in full regardless of that cap.

    `order_distribution_share.child_id` is a SOFT reference (no FK,
    schema.sql ~183) -- a deleted order would otherwise leave its share
    dangling, pointing at an id that no longer exists. In the SAME
    transaction, every share that pointed at a just-deleted id is retired
    (`purged_at` stamped, `child_id` cleared) rather than left dangling; its
    `letter`/`weight` are left alone so an explicit Reset (D02) can revive it
    later (`backend/distribution/data.py::_write_reweight_shares`). A header
    left with no remaining live share (every share now weight-0 or purged) is
    then deleted outright -- shares cascade (schema.sql ~187-188) -- so a
    later re-upload of the same parent creates a fresh header instead of
    resurrecting a dead one. `shares_purged`/`headers_deleted` are added to
    the audit JSON and the return value only when nonzero, keeping the return
    shape unchanged for every caller that never touches distribution.
    """
    where, params = _purge_scope_sql_params(plant, start, end, machines)
    sql = f"DELETE FROM orders WHERE {where} RETURNING id"
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            cur.execute(sql, params)
            ids = [row[0] for row in cur.fetchall()]
            deleted = len(ids)

            shares_purged = 0
            headers_deleted = 0
            if ids:
                # Scope by `plant =` so this at least narrows via
                # idx_ods_machine(plant, machine) -- child_id itself has no
                # index.
                cur.execute(
                    """
                    UPDATE order_distribution_share
                       SET purged_at = now(), child_id = NULL
                     WHERE plant = %(plant)s AND child_id = ANY(%(ids)s)
                     RETURNING production_order, material_number
                    """,
                    {"plant": plant, "ids": ids},
                )
                purged_rows = cur.fetchall()
                shares_purged = len(purged_rows)
                if purged_rows:
                    prods = [row[0] for row in purged_rows]
                    mats = [row[1] for row in purged_rows]
                    cur.execute(
                        """
                        DELETE FROM order_distribution od
                         WHERE plant = %(plant)s
                           AND (production_order, material_number) IN (
                               SELECT unnest(%(prods)s::text[]), unnest(%(mats)s::text[])
                           )
                           AND NOT EXISTS (
                               SELECT 1 FROM order_distribution_share s
                                WHERE s.plant = od.plant
                                  AND s.production_order = od.production_order
                                  AND s.material_number = od.material_number
                                  AND s.weight > 0 AND s.purged_at IS NULL
                           )
                         RETURNING production_order, material_number
                        """,
                        {"plant": plant, "prods": prods, "mats": mats},
                    )
                    headers_deleted = len(cur.fetchall())

            audit_details = {"plant": plant, "machines": list(machines or []),
                    "start": start.isoformat() if hasattr(start, "isoformat") else str(start),
                    "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
                    "deleted": deleted, "order_ids": ids[:200],
                    "order_id_count": len(ids), "truncated": len(ids) > 200}
            if shares_purged:
                audit_details["shares_purged"] = shares_purged
                audit_details["headers_deleted"] = headers_deleted
            cur.execute(
                "INSERT INTO admin_audit (table_name, action, details, user_email)"
                " VALUES ('orders', 'purge_by_date_range', %s, %s)",
                (Jsonb(audit_details), user_email),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    result = {"status": "ok", "deleted": deleted, "plant": plant, "machines": list(machines or [])}
    if shares_purged:
        result["shares_purged"] = shares_purged
        result["headers_deleted"] = headers_deleted
    return result


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
    """Per-column null analysis, date range, and per-machine breakdown.

    NOTE (machine-domain rename): the returned dict keys `null_line`/`by_line`
    stay as-is deliberately — they're consumed by
    frontend/plant-and-administration.mjs (AdminCockpit diagnostics panel), which
    is out of scope for this pass. Only the underlying SQL column reference
    (orders.machine) changed."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*)                                                    AS total,
                    COUNT(CASE WHEN basic_start_date  IS NULL THEN 1 END)      AS null_start,
                    COUNT(CASE WHEN basic_finish_date IS NULL THEN 1 END)      AS null_end,
                    COUNT(CASE WHEN color IS NULL OR color = '' THEN 1 END)    AS null_color,
                    COUNT(CASE WHEN machine IS NULL
                               OR  machine = '' THEN 1 END)            AS null_line,
                    COUNT(CASE WHEN material_description IS NULL
                               OR  material_description = '' THEN 1 END)       AS null_desc,
                    COUNT(CASE WHEN run_time IS NULL THEN 1 END)               AS null_runtime,
                    MIN(COALESCE(scheduled_start, basic_start_date))           AS min_date,
                    MAX(COALESCE(scheduled_end,   basic_finish_date))          AS max_date
                FROM orders
            """)
            r = cur.fetchone()

            cur.execute("""
                SELECT machine, COUNT(*) AS cnt
                FROM orders
                GROUP BY machine
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
        machine, plant, basic_start_date, basic_finish_date,
        run_time, color, prt_01, prt_02, production_version,
        order_quantity, form_size, firming_indicator,
        planned_order_initial_quantity, reduced_quantity, order_category, order_type,
        bom_alternative, bom_usage, labor_hours, machine_hours, no_of_fte,
        upload_batch_id, updated_at
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
    ON CONFLICT (id) DO UPDATE SET
        production_order      = EXCLUDED.production_order,
        material_number       = EXCLUDED.material_number,
        material_description  = EXCLUDED.material_description,
        machine                = EXCLUDED.machine,
        -- Plant: an explicitly uploaded plant always wins; otherwise, if the MACHINE
        -- changed on this re-upload, reset to NULL so the post-upsert derivation
        -- re-resolves it from the NEW machine (matches the old join's self-healing);
        -- otherwise keep the existing (already-derived) plant.
        plant                 = CASE
            WHEN EXCLUDED.plant IS NOT NULL THEN EXCLUDED.plant
            WHEN EXCLUDED.machine IS DISTINCT FROM orders.machine THEN NULL
            ELSE orders.plant
        END,
        -- machine_key has no EXCLUDED counterpart (it's derived, never uploaded), so unlike
        -- plant it never gets a "trust the new explicit value" branch — just reset to
        -- NULL on either input actually changing, else keep. The post-upsert backfill
        -- below re-derives it. Plant-changed check is NULL-safe (EXCLUDED.plant IS NOT
        -- NULL guard) so a plain re-upload with no WERKS/PLANT column doesn't null it.
        machine_key            = CASE
            WHEN EXCLUDED.machine IS DISTINCT FROM orders.machine THEN NULL
            WHEN EXCLUDED.plant IS NOT NULL AND EXCLUDED.plant IS DISTINCT FROM orders.plant THEN NULL
            ELSE orders.machine_key
        END,
        basic_start_date      = EXCLUDED.basic_start_date,
        basic_finish_date     = EXCLUDED.basic_finish_date,
        -- Ingest itself no longer flags this on every re-upload regardless of
        -- whether the value moved (ROUTING_RUNTIME_DESIGN.md §4 item 6) — plain
        -- carry-forward. Only the resolver (backend/routing/resolver.py) is
        -- allowed to set this flag now, and only when the number it writes
        -- actually differs from what's stored.
        runtime_schedule_mismatch = COALESCE(orders.runtime_schedule_mismatch, FALSE),
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
        planned_order_initial_quantity = EXCLUDED.planned_order_initial_quantity,
        reduced_quantity                = EXCLUDED.reduced_quantity,
        order_category                  = EXCLUDED.order_category,
        order_type                      = EXCLUDED.order_type,
        bom_alternative                 = EXCLUDED.bom_alternative,
        bom_usage                       = EXCLUDED.bom_usage,
        labor_hours                     = EXCLUDED.labor_hours,
        machine_hours                   = EXCLUDED.machine_hours,
        no_of_fte                       = EXCLUDED.no_of_fte,
        upload_batch_id       = EXCLUDED.upload_batch_id,
        updated_at            = NOW()
    RETURNING id, (xmax = 0) AS inserted
"""
# Deliberately NOT in the UPDATE SET: scheduled_start, scheduled_end.
# That's the whole point — user drag/drop edits survive a re-upload.


# Build the per-row tuple in the exact _UPSERT_SQL column order. The SQL VALUES
# clause expects: id, production_order, material_number, material_description,
# machine, plant, basic_start_date, basic_finish_date, run_time, color,
# prt_01, prt_02, production_version, order_quantity, form_size, firming_indicator,
# planned_order_initial_quantity, reduced_quantity, order_category, order_type,
# bom_alternative, bom_usage, labor_hours, machine_hours, no_of_fte,
# upload_batch_id.
_UPSERT_ROW_COLS = (
    "production_order", "material_number", "material_description",
    "machine", "plant", "basic_start_date", "basic_finish_date",
    "run_time", "color", "prt_01", "prt_02", "production_version",
    "order_quantity", "form_size", "firming_indicator",
    "planned_order_initial_quantity", "reduced_quantity", "order_category", "order_type",
    "bom_alternative", "bom_usage", "labor_hours", "machine_hours", "no_of_fte",
)


def _stamp_order_attributes(conn, *, batch_id: str | None = None, plant: str | None = None) -> dict:
    """Seam 2 (docs/scheduling_priority.md): the ONE place attribute provenance
    lives for color/prt_01/prt_02/production_version. One UPDATE orders ... FROM
    material_plants keyed (plant, material_number = material_id), scoped either
    to a single ingest batch (batch_id — called post-upsert from upsert_orders)
    or to a whole plant (plant — called from POST /master-data/resync-order-attributes).

    Must run AFTER orders.plant is derived, since it reads the derived value —
    callers scoped by batch_id must call this after the plant/machine_key backfill,
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
                       production_version = COALESCE(NULLIF(o.production_version, ''), mp.default_production_version),
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
                       production_version = COALESCE(NULLIF(o.production_version, ''), mp.default_production_version),
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
                  warnings: list[dict] | None = None,
                  plan_fn: Callable | None = None, apply_fn: Callable | None = None,
                  resolve_fn: Callable | None = None) -> dict:
    """Shared orders upsert for both the Excel and SAP ingest paths.

    `rows` is a list of dicts keyed by orders columns (production_order,
    material_number, material_description, machine, plant,
    basic_start_date, basic_finish_date, run_time, color, order_quantity,
    form_size, firming_indicator). The id is computed via make_id() when absent,
    and a cumulative-count suffix dedups colliding ids (ORDER|MATERIAL not
    unique). Then a chunked, idempotent ON CONFLICT upsert persists the rows,
    plant is backfilled from the machine→plant master-data mapping for rows that
    didn't carry one, ambiguous (multi-plant) machine codes are surfaced as a
    warning, and an upload_audit row is written.

    The scheduled_start/scheduled_end/notes non-overwrite lives in _UPSERT_SQL
    (unchanged) — user drag/drop edits survive a re-ingest.

    `plan_fn`/`apply_fn` are the optional Order Distribution ingest seam
    (aggregate_to_detail.md §5) — both default to None so every caller that
    doesn't pass them (and any future one) is unaffected. When given:
      - `plan_fn` is called as `plan_fn(rows, batch_id)` BEFORE the id/dedup
        loop below, matching `backend.distribution.data.plan`'s
        `(rows, batch_id, conn=None)` signature (no `conn` — it opens its own
        short read-only connection). Its `rows_out` replaces `rows` for the
        rest of this function; its `plan_structure` is held onto for `apply_fn`.
      - `apply_fn` is called as `apply_fn(plan_structure, batch_id, conn,
        actor=...)`, matching `backend.distribution.data.apply`'s
        `(plan, batch_id, conn, *, actor="system")` signature, once every chunk
        and every backfill has committed and only when `plan_structure` has at
        least one parent — reusing the connection already open at that point
        (`apply_fn` commits its own transaction on it; nothing here commits or
        rolls back around that call). Its `warnings_entry` is folded into the
        `warnings` list feeding the `upload_audit` row exactly like the
        `missing_master_data` entry below. When `apply_fn` does NOT run (no
        planned parent this batch) but `plan_fn` still raised a real
        ingest-time warning (any warning list other than `single_rewrites` is
        non-empty), `plan_structure`'s own `warnings_entry` (D04, built from
        zero distribution counters) is folded in instead, so that warning is
        never silently dropped.
      - `resolve_fn` is the optional routing-runtime ingest seam
        (ROUTING_RUNTIME_DESIGN.md §4/§5) — also defaults to None. When given,
        it is called as `resolve_fn(plant, conn=conn)` — matching
        `backend.routing.resolver.resolve_orders`'s `(plant, *, conn=None)`
        signature reusing the connection already open at that point — once per
        distinct plant among this batch's rows, AFTER `apply_fn` has run and
        BEFORE the `upload_audit` INSERT. Each call's report dict is folded
        into `warnings` as `{"level": "info", "category": "routing_resolve",
        "plant": ..., **resolve_result}`.
    db.py never imports `backend.*` at module scope (every router imports
    `db`, not the reverse — a top-level import here would be circular since
    both `backend/distribution/data.py` and `backend/routing/resolver.py`
    import `db`); callers pass these functions in instead.

    Returns: {status:"ok", batch_id, inserted, updated, failed, warnings, lines}.
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

    # ---------- Order Distribution: plan() seam (aggregate_to_detail.md §5) ----------
    # Runs BEFORE the id/dedup loop, on its own short read-only connection
    # (no `conn` passed — plan() opens/closes its own). Replaces `rows` with
    # `rows_out` (distributed aggregate parents replaced by their per-machine
    # children, single-mode work-center codes rewritten to a real machine) so
    # everything below — id/dedup, chunked upsert, backfills — runs unchanged
    # over the resolved rows. `plan_structure` is held onto for `apply_fn` below.
    distribution_plan: dict = {}
    if plan_fn is not None:
        rows, distribution_plan, distribution_ingest_warnings = plan_fn(rows, batch_id)

    # The "Unknown production line" soft-warning (backend/integration/routes.py)
    # must see the RESOLVED machine values — i.e. after plan_fn's single-mode
    # rewrite — never the raw uploaded column, or every resolved work-center
    # code would incorrectly trip that warning. Computed here (post-plan_fn,
    # pre-dedup — dedup only touches `id`, never `machine`) and returned below
    # so callers (e.g. ingest_orders_from_excel) don't need their own copy.
    lines = sorted({str(row["machine"]) for row in rows if row.get("machine")})

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

    # ---------- Routing runtime (ROUTING_RUNTIME_DESIGN.md §4 item 1) ----------
    # For any plant with plants.routing_runtime_enabled = TRUE, the order
    # file's run-time column must never land in orders.run_time — only the
    # resolver (backend/routing/resolver.py, wired in below via `resolve_fn`)
    # is allowed to set it for those plants. Resolved once per batch, over
    # this batch's own distinct plants only (never a whole-table scan). A
    # disabled plant's rows are completely byte-for-byte unaffected.
    batch_plants = sorted({row["plant"] for row in rows if row.get("plant")})
    routing_enabled_plants: set[str] = set()
    if batch_plants:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT plant FROM plants WHERE plant = ANY(%s) AND routing_runtime_enabled = TRUE",
                (batch_plants,),
            )
            routing_enabled_plants = {r[0] for r in cur.fetchall()}
    if routing_enabled_plants:
        for row in rows:
            if row.get("plant") in routing_enabled_plants:
                row["run_time"] = None

    # ---------- Zero-pad production_version (ROUTING_RUNTIME_DESIGN.md §4 item 3) ----------
    # Applies only to plants with routing_runtime_enabled = TRUE — a plain data-
    # hygiene fix against spreadsheet numeric coercion dropping leading zeros.
    # Disabled plants have ingest unchanged.
    for row in rows:
        if row.get("plant") in routing_enabled_plants:
            pv = row.get("production_version")
            if pv:
                row["production_version"] = _zero_pad(str(pv).strip().upper(), 4)

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
    # Ids that were genuinely fresh inserts this batch (RETURNING's xmax=0
    # signal) — used below (ROUTING_RUNTIME_DESIGN.md §4 item 5) to hold new
    # orders on an enabled plant instead of letting them look normal while a
    # run_time_source-'routing' resolve is still pending.
    inserted_ids: list[str] = []
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            for i in range(0, len(tuples), _UPSERT_CHUNK):
                chunk = tuples[i:i + _UPSERT_CHUNK]
                cur.executemany(_UPSERT_SQL, chunk, returning=True)
                while True:
                    rec = cur.fetchone()
                    if rec is not None:
                        row_id, was_inserted = rec[0], rec[1]
                        if was_inserted:
                            inserted += 1
                            inserted_ids.append(row_id)
                        else:
                            updated += 1
                    if not cur.nextset():
                        break
                conn.commit()
            # Materialize plant for rows this upload didn't carry one for, deriving it from
            # the machine→plant master-data mapping. Only derive when the machine maps to
            # EXACTLY ONE plant; a machine code shared across plants is left NULL (and
            # warned) rather than silently mis-attributed to the lowest plant code. Scoped
            # to this batch.
            cur.execute(
                """
                UPDATE orders o
                   SET plant = (
                       SELECT MIN(m.plant) FROM machine m
                        WHERE m.machine = o.machine
                   )
                 WHERE o.upload_batch_id = %s AND o.plant IS NULL
                   AND (
                       SELECT COUNT(DISTINCT m.plant) FROM machine m
                        WHERE m.machine = o.machine
                   ) = 1
                """,
                (batch_id,),
            )
            conn.commit()
            # Same idea for machine_key, scoped to this batch, strictly downstream of the
            # plant backfill just above (a row still NULL there stays NULL here too).
            cur.execute(
                """
                UPDATE orders o
                   SET machine_key = (
                       SELECT m.machine_key FROM machine m
                        WHERE m.plant = o.plant AND m.machine = o.machine
                   )
                 WHERE o.upload_batch_id = %s AND o.machine_key IS NULL AND o.plant IS NOT NULL
                   AND (
                       SELECT COUNT(*) FROM machine m
                        WHERE m.plant = o.plant AND m.machine = o.machine
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
            # Surface (don't guess) rows left NULL because their machine maps to >1 plant.
            cur.execute(
                """
                SELECT o.machine, COUNT(*)
                  FROM orders o
                 WHERE o.upload_batch_id = %s AND o.plant IS NULL
                   AND (
                       SELECT COUNT(DISTINCT m.plant) FROM machine m
                        WHERE m.machine = o.machine
                   ) > 1
                 GROUP BY o.machine
                """,
                (batch_id,),
            )
            ambiguous = cur.fetchall()
            if ambiguous:
                n_amb = sum(int(r[1]) for r in ambiguous)
                machines_amb = ", ".join(str(r[0]) for r in ambiguous)
                warnings.append({
                    "level": "warn",
                    "msg": (f"{n_amb} order(s) left plant-unattributed — machine code(s) "
                            f"shared across multiple plants: {machines_amb}. Provide an "
                            f"explicit plant column on upload to resolve."),
                })
            # ---------- Routing runtime: hold new orders (ROUTING_RUNTIME_DESIGN.md §4 item 5) ----------
            # A new order on an enabled plant arrives already held instead of
            # looking normal while a routing resolve is still pending — the
            # resolve_fn call below (once wired in) overwrites this placeholder
            # with the real outcome. Scoped to genuinely fresh inserts this
            # batch AND plants enabled at the top of this function; never
            # touches a pre-existing order that was merely updated. Runs after
            # `plant` is fully resolved (backfills above) so the plant filter
            # is accurate.
            if inserted_ids and routing_enabled_plants:
                cur.execute(
                    """
                    UPDATE orders
                       SET planning_status = 'needs_planning',
                           planning_reason = '{"code":"runtime_pending","message":"Runtime pending resolution."}'::jsonb
                     WHERE id = ANY(%s) AND plant = ANY(%s)
                    """,
                    (inserted_ids, sorted(routing_enabled_plants)),
                )
                conn.commit()
            # ---------- Order Distribution: apply() seam (aggregate_to_detail.md §5) ----------
            # Runs after the last upsert chunk AND every backfill above has
            # committed, so its counters land in `warnings` before the
            # upload_audit insert just below. Reuses the connection already
            # open on this transaction — apply_fn commits its own transaction
            # on `conn` internally (mirroring every other multi-step writer in
            # backend/distribution/data.py); nothing here commits or rolls
            # back around this call. Only runs when there's at least one
            # planned parent — an empty plan (no distribute-mode rows this
            # batch) is a no-op plan_fn already accounted for.
            if apply_fn is not None and distribution_plan.get("parents"):
                apply_res = apply_fn(distribution_plan, batch_id, conn, actor=filename or "system")
                # Same insertion style as the missing_master_data entry above —
                # one dict, `level`/`msg` are the two fields the cockpit's
                # warning list actually reads.
                warnings.append(apply_res["warnings_entry"])
            elif (distribution_plan.get("warnings_entry")
                  and any(v for k, v in distribution_ingest_warnings.items() if k != "single_rewrites")):
                # D04: no parent was planned this batch (apply_fn never ran,
                # above), but plan_fn still raised a real ingest-time warning
                # (a conflicting/ambiguous row, a zero-weight work center,
                # etc.) — fold plan()'s own zero-counter entry in instead of
                # letting that warning silently vanish. `single_rewrites` is
                # excluded: it's a routine, not-warn-worthy count (a single-
                # mode machine-code rewrite), never by itself a reason to
                # surface this entry.
                warnings.append(distribution_plan["warnings_entry"])
            # ---------- Routing runtime: resolve() seam (ROUTING_RUNTIME_DESIGN.md §4 item 4) ----------
            # Runs after Order Distribution's plan/apply step (so each sub-order
            # resolves at its own machine/quantity) and after the new-order hold
            # UPDATE above (so the resolver overwrites that placeholder with the
            # real outcome), once per distinct plant in this batch, reusing the
            # already-open `conn` (resolve_fn commits nothing on it itself —
            # matches `resolve_orders`'s conn-reuse contract). A no-op for any
            # plant resolve_fn/the caller never wires in.
            if resolve_fn is not None:
                for resolve_plant in sorted({r.get("plant") for r in rows if r.get("plant")}):
                    resolve_result = resolve_fn(resolve_plant, conn=conn)
                    warnings.append({
                        "level": "info",
                        "category": "routing_resolve",
                        "plant": resolve_plant,
                        **resolve_result,
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
        # Resolved machine values (post-plan_fn) — see the "Unknown production
        # line" comment near where `lines` is computed above.
        "lines": lines,
        # Summary only (never blocking — N5/N6/N7). Full per-material detail is the
        # same list persisted into upload_audit.warnings above, served in full by
        # GET /upload/{batch_id}/missing-master-data.
        "missing_master_data": {
            "unmatched_pairs": attr_result["unmatched_pairs"],
            "unmatched_orders": attr_result["unmatched_orders"],
        },
    }


def extract_upload_plants(file_bytes: bytes) -> list[str] | None:
    """Best-effort, read-only peek at an uploaded orders file's PLANT column,
    for scoping the Stage 0 setup-state capture seam (see
    capture_setup_states_before_schedule_mutation) to just the plants an
    upload will actually touch, instead of scanning every plant in the
    system. Mirrors ingest_orders_from_excel's own WERKS->PLANT normalization
    just enough to find the column; does none of that function's date
    hygiene, upsert, or validation work.

    Returns None (meaning "scope unknown, caller should fall back to an
    unscoped/all-plants capture") whenever the file can't be parsed, or has
    neither a PLANT nor WERKS column — the same case ingest_orders_from_excel
    itself handles by deriving plant from machine after upsert.
    """
    try:
        df = pd.read_excel(io.BytesIO(file_bytes))
    except Exception:
        return None
    if "WERKS" in df.columns and "PLANT" not in df.columns:
        df = df.rename(columns={"WERKS": "PLANT"})
    if "PLANT" not in df.columns:
        return None
    plants = sorted({_str_id(p) for p in df["PLANT"].dropna().unique() if _str_id(p)})
    return plants or None


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
    # present the per-order plant is derived from the machine→plant mapping after upsert.
    if "WERKS" in df.columns and "PLANT" not in df.columns:
        df = df.rename(columns={"WERKS": "PLANT"})
    # Machine-domain rename: the SAP-side spreadsheet format still ships the
    # legacy "PRODUCTION_LINE" header (unchanged on that side of the fence), so
    # it stays a permanently valid incoming alias — normalize it to the new
    # internal "MACHINE" header. "MACHINE" itself is equally accepted so a
    # re-exported/updated template works too. If a file somehow carries both,
    # the already-canonical "MACHINE" column wins and PRODUCTION_LINE is left
    # alone (dropped downstream — no column in _UPSERT_ROW_COLS reads it).
    if "PRODUCTION_LINE" in df.columns and "MACHINE" not in df.columns:
        df = df.rename(columns={"PRODUCTION_LINE": "MACHINE"})

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
    # D54: capture whether RUN_TIME was genuinely absent/unparseable BEFORE the
    # fillna(1.0) default overwrites that absence — as a column (not a boolean
    # mask) because the dropna().reset_index(drop=True) a few lines below would
    # misalign a mask built against the pre-dropna index.
    _rt = pd.to_numeric(
        df["RUN_TIME"] if "RUN_TIME" in df.columns else pd.Series(float("nan"), index=df.index),
        errors="coerce",
    )
    df["_RUN_TIME_DEFAULTED"] = _rt.isna()
    df["RUN_TIME"] = _rt.fillna(1.0)

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

    # 9 SAP COOIS extract fields — upload-sourced (unlike prt_01/prt_02/
    # production_version, which are NULL from upload and backfilled by
    # db._stamp_order_attributes). Numeric/integer columns coerced upfront
    # like qcol above so downstream _num/_int just check pd.notna.
    _SAP_NUMERIC_COLS = (
        "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)", "REDUCED_QUANTITY_(GMEIN)",
        "LABOR_HOURS_(MEINH)", "MACHINE_HOURS_(MEINH)", "NO_OF_FTE_(MEINH)",
    )
    _SAP_INTEGER_COLS = ("BOM_ALTERNATIVE", "BOM_USAGE")
    for col in _SAP_NUMERIC_COLS + _SAP_INTEGER_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

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

    def _num(row, col):
        if col not in df.columns:
            return None
        val = row.get(col)
        return None if pd.isna(val) else float(val)

    def _int(row, col):
        if col not in df.columns:
            return None
        val = row.get(col)
        return None if pd.isna(val) else int(val)

    def _ts(val):
        return val.to_pydatetime() if pd.notna(val) else None

    rows = []
    for _, r in df.iterrows():
        rows.append({
            "production_order": _str_id(r.get("PRODUCTION_ORDER", "")),
            "material_number": _str_id(r.get("MATERIAL_NUMBER", "")),
            "material_description": _v(r, "MATERIAL_DESCRIPTION"),
            "machine": _v(r, "MACHINE"),
            "plant": _str_id(_v(r, "PLANT")) or None,
            "basic_start_date": _ts(r["BASIC_START_DATE"]),
            "basic_finish_date": _ts(r["BASIC_FINISH_DATE"]),
            "run_time": float(r["RUN_TIME"]) if pd.notna(r["RUN_TIME"]) else None,
            "_run_time_was_defaulted": bool(r["_RUN_TIME_DEFAULTED"]),
            "color": _v(r, "COLOR"),
            # ROUTING_RUNTIME_DESIGN.md §4 item 2: read PRODUCTION_VERSION into
            # orders.production_version (upper/strip); zero-padded centrally in
            # upsert_orders (§4 item 3) so both this path and the SAP path share
            # one normalization point.
            "production_version": (
                str(_v(r, "PRODUCTION_VERSION")).strip().upper()
                if _v(r, "PRODUCTION_VERSION") is not None else None
            ),
            "order_quantity": float(r[qcol]) if (qcol in df.columns and pd.notna(r.get(qcol))) else None,
            "form_size": _v(r, "FORM_SIZE"),
            "firming_indicator": _v(r, "FIRMING_INDICATOR"),
            "planned_order_initial_quantity": _num(r, "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)"),
            "reduced_quantity": _num(r, "REDUCED_QUANTITY_(GMEIN)"),
            "order_category": _v(r, "ORDER_CATEGORY"),
            "order_type": _v(r, "ORDER_TYPE"),
            "bom_alternative": _int(r, "BOM_ALTERNATIVE"),
            "bom_usage": _int(r, "BOM_USAGE"),
            "labor_hours": _num(r, "LABOR_HOURS_(MEINH)"),
            "machine_hours": _num(r, "MACHINE_HOURS_(MEINH)"),
            "no_of_fte": _num(r, "NO_OF_FTE_(MEINH)"),
        })

    # Local, deferred import — backend/distribution/data.py and
    # backend/routing/resolver.py both import `db` already, so a top-level
    # `import backend.distribution.data`/`import backend.routing.resolver`
    # here would be a circular import (and would violate the "db.py/
    # master_data.py are never imported by, only importers of,
    # backend/<domain>" architecture in backend/CLAUDE.md even where Python
    # would tolerate the cycle at runtime).
    import backend.distribution.data as distribution_data
    import backend.routing.resolver as routing_resolver

    result = upsert_orders(
        rows,
        batch_id=batch_id,
        source="excel",
        filename=filename,
        raw_row_count=raw_row_count,
        warnings=warnings,
        plan_fn=distribution_data.plan,
        apply_fn=distribution_data.apply,
        resolve_fn=routing_resolver.resolve_orders,
    )
    if result.get("status") != "ok":
        # upsert_orders already wrote a failed-audit trail and re-raised on a
        # persist failure; this branch covers any defensive non-ok return.
        return result

    # `lines` now comes from upsert_orders itself — computed from the
    # RESOLVED rows (post plan_fn's single-mode rewrite), not the raw
    # uploaded MACHINE column, so a resolved work-center code no longer trips
    # the "Unknown production line" warning in backend/integration/routes.py.
    lines = result.get("lines", [])

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
# Split-order persistence is a normalized child aggregate. Keep this startup
# hook alongside the other idempotent schema guards so a deployed app cannot
# serve the new /tasks projection before its additive table exists.
def ensure_order_schedule_segments_table() -> None:
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS order_schedule_segments (
                order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                segment_no INTEGER NOT NULL CHECK (segment_no > 0),
                scheduled_start TIMESTAMP NOT NULL,
                scheduled_end TIMESTAMP NOT NULL,
                PRIMARY KEY (order_id, segment_no),
                CHECK (scheduled_end > scheduled_start)
            )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_order_schedule_segments_order_start "
            "ON order_schedule_segments(order_id, scheduled_start)"
        )
        cur.execute(
            "ALTER TABLE orders ADD COLUMN IF NOT EXISTS runtime_schedule_mismatch "
            "BOOLEAN NOT NULL DEFAULT FALSE"
        )
        conn.commit()


# Generalizes color_wheel to any field in master_data.RANKABLE_FIELDS. One row
# per (plant, machine, field_key); machine = '' means plant-wide, a specific
# machine overrides the plant-wide list for that machine only (mirrors
# machine_calendar / machine_blackout's machine: null convention). `entries` is a
# {NORMALIZED_VALUE: RANK} map, the same shape color_wheel already used for
# {COLOR: ORDER_Y}. This module owns persistence only — brain.py owns the
# upload parsing and the PLANT_LISTS in-memory cache, same split as
# color_wheel above. Deliberately mirrors that block's function shapes
# one-for-one so a caller familiar with color_wheel needs nothing new.
#
# NOTE (machine-domain rename): schema.sql renamed this table's `line` column
# to `machine`. The Python-facing parameter name and dict/JSON key in this
# module stay `line` deliberately — brain.py's HTTP API (`?line=` query
# params, `"line"` JSON fields) and the frontend both consume that name today
# and are out of scope for this pass. The SQL below binds the `line` value
# into the real `machine` column (and aliases `machine AS line` on read)
# so the contract is unchanged while the schema column is actually `machine`.
def ensure_priority_list_table() -> None:
    """Idempotent: create the priority_list table if missing (mirrors schema.sql /
    migrations/2026-08-11-priority-lists.sql). Lets the app self-bootstrap even
    before the migration is applied, matching the other ensure_* startup hooks."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS priority_list (
                plant         TEXT NOT NULL,
                machine       TEXT NOT NULL DEFAULT '',
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
                PRIMARY KEY (plant, machine, field_key)
            )
        """)
        conn.commit()


def ensure_order_distribution_tables() -> None:
    """Idempotent: create the order_distribution, order_distribution_share, and
    sap_workcenter tables if missing (mirrors schema.sql / migrations/). Lets the
    app self-bootstrap even before the migration is applied, matching the other
    ensure_* startup hooks. Creates in FK-safe order: sap_workcenter first, then
    order_distribution (which FKs to it), then order_distribution_share (which
    FKs to order_distribution)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        # sap_workcenter: SAP work center policy and membership weights (2026-09-17).
        # Per-plant table; work-center codes aggregate multiple NIMBUS machines.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sap_workcenter (
                plant              TEXT NOT NULL,
                sap_workcenter     TEXT NOT NULL,
                description        TEXT,
                distribution_mode  TEXT NOT NULL DEFAULT 'single'
                                   CHECK (distribution_mode IN ('single','distribute')),
                default_machine    TEXT,
                max_separation     TEXT NOT NULL DEFAULT 'none'
                                   CHECK (max_separation IN ('none','hour','day','week')),
                review_required    BOOLEAN NOT NULL DEFAULT TRUE,
                distribute_tooled  BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (plant, sap_workcenter)
            )
        """)

        # order_distribution: header table for SAP aggregate work center distribution.
        # Transactional tables, never grid-editable. Written solely by backend/distribution/.
        # Header + shares are replaced wholesale in one transaction; header.xmin is the
        # optimistic-concurrency token (base_version on wire, 409 stale on mismatch).
        cur.execute("""
            CREATE TABLE IF NOT EXISTS order_distribution (
                plant              TEXT NOT NULL,
                production_order   TEXT NOT NULL,
                material_number    TEXT NOT NULL,
                sap_workcenter     TEXT NOT NULL,
                order_quantity     NUMERIC,
                run_time           NUMERIC,
                basic_start_date   TIMESTAMP,
                basic_finish_date  TIMESTAMP,
                firming_indicator  TEXT,
                sap_facts          JSONB,
                source             TEXT NOT NULL DEFAULT 'default'
                                   CHECK (source IN ('default','manual')),
                default_basis      TEXT NOT NULL DEFAULT 'workcenter_weights'
                                   CHECK (default_basis IN ('material_default','tooled_single','workcenter_weights')),
                reviewed           BOOLEAN NOT NULL DEFAULT FALSE,
                reviewed_by        TEXT,
                reviewed_at        TIMESTAMPTZ,
                reviewed_quantity  NUMERIC,
                updated_by         TEXT,
                last_batch_id      UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (plant, production_order, material_number),
                FOREIGN KEY (plant, sap_workcenter)
                    REFERENCES sap_workcenter (plant, sap_workcenter) ON UPDATE CASCADE ON DELETE RESTRICT
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_order_distribution_wc
                ON order_distribution(plant, sap_workcenter, reviewed)
        """)

        # order_distribution_share: distribution shares across NIMBUS machines.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS order_distribution_share (
                plant            TEXT NOT NULL,
                production_order TEXT NOT NULL,
                material_number  TEXT NOT NULL,
                machine          TEXT NOT NULL,
                letter           TEXT NOT NULL,
                weight           NUMERIC NOT NULL DEFAULT 0
                                 CHECK (weight >= 0),
                child_id         TEXT,
                purged_at        TIMESTAMPTZ,
                PRIMARY KEY (plant, production_order, material_number, machine),
                UNIQUE (plant, production_order, material_number, letter),
                FOREIGN KEY (plant, production_order, material_number)
                    REFERENCES order_distribution (plant, production_order, material_number)
                    ON DELETE CASCADE
            )
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_ods_machine
                ON order_distribution_share(plant, machine)
        """)

        # column_metadata entries for Admin Cockpit grid visibility.
        cur.execute("""
            INSERT INTO column_metadata (table_name, column_name, display_label, is_locked, column_order) VALUES
                ('sap_workcenter', 'plant',             'Plant',               TRUE,  1),
                ('sap_workcenter', 'sap_workcenter',    'SAP Work Center',     TRUE,  2),
                ('sap_workcenter', 'description',       'Description',         FALSE, 3),
                ('sap_workcenter', 'distribution_mode', 'Distribution Mode',   FALSE, 4),
                ('sap_workcenter', 'default_machine',   'Default Machine',     FALSE, 5),
                ('sap_workcenter', 'max_separation',    'Max Separation',      FALSE, 6),
                ('sap_workcenter', 'review_required',   'Review Required',     FALSE, 7),
                ('sap_workcenter', 'distribute_tooled', 'Distribute Tooled',   FALSE, 8)
            ON CONFLICT (table_name, column_name) DO NOTHING
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
            plant, machine, field_key, entries, source_column, value_column,
            rank_column, filename, row_count, uploaded_by, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (plant, machine, field_key) DO UPDATE SET
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
            "DELETE FROM priority_list WHERE plant = %s AND machine = %s AND field_key = %s"
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
            "SELECT plant, machine AS line, field_key, entries, source_column, value_column,"
            " rank_column, filename, row_count, uploaded_by, uploaded_at"
            " FROM priority_list WHERE plant = %s AND machine = %s AND field_key = %s",
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
        cur.execute("SELECT plant, machine, field_key, entries FROM priority_list")
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
        q = (f"SELECT plant, machine AS line, field_key, uploaded_at, uploaded_by, filename, row_count"
             f" FROM priority_list{where_sql} ORDER BY plant, field_key, machine")
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


# Reserved key in priority_list_coverage()'s per-field map for the true
# plant-wide roll-up. Deliberately NOT '' — '' is already a real, different
# bucket in that map (orders whose machine is NULL/blank), and it is
# also the plant-wide *scope* value in the priority_list table's `machine`
# column, so reusing it here conflated three distinct meanings and made the
# plant-wide coverage ratio silently blank on every plant where every order
# has a machine. Machine codes can never collide with this token.
PLANT_TOTAL_COVERAGE_KEY = "__plant_total__"


def priority_list_coverage(plant: str, fields: dict[str, str]) -> dict:
    """ONE aggregate query per plant (N3: 70 machines x 4 fields must not become up
    to 280 separate lookups) — a UNION ALL of two SELECTs per field, returning
    (a) for every machine with orders at this plant how many distinct
    values that field has and how many of those are covered by a rank, and
    (b) one true plant-wide roll-up row per field under the reserved
    PLANT_TOTAL_COVERAGE_KEY ('__plant_total__') key.

    `fields` is {field_key: source_column} — supplied by the caller
    (master_data.RANKABLE_FIELDS is the single source of truth for that
    mapping, N19; this function stays agnostic of what fields exist to avoid
    db.py importing master_data, which already imports db.py).

    A machine's "covered by a rank" set falls back plant-wide when no
    machine-specific list exists — COALESCE(machine row, plant-wide row) — the
    same resolution Stage 3's client-side rank lookup will use. In Stage 1 no
    upload path exists yet (Stage 2), so every priority_list row today is
    plant-wide (machine=''); the per-machine breakdown already works correctly
    for that case (every machine falls back to the one plant-wide row) and
    needs no change once Stage 2 starts writing machine-scoped rows.

    Why the plant total needs its own query branch rather than being summed
    client-side from the per-machine rows: the per-machine numbers are
    COUNT(DISTINCT ...) *within* a machine, so adding them up double-counts
    every value that appears on more than one machine (with 70 machines per
    plant, that is the common case, not an edge case). The '__plant_total__'
    branch drops the GROUP BY entirely so COUNT(DISTINCT ...) de-duplicates
    across the whole plant. Its `ranked_values` uses the SAME per-row
    COALESCE(machine list, plant list) resolution as the per-machine rows, so
    a value counts as ranked when at least one of its occurrences resolves to
    a rank under the resolution the scheduler will actually use.

    Note the ungrouped branch always returns exactly one row per field, even
    for a plant with no orders at all (0/0) — callers that treat "no coverage
    data" as a reason to hide a ratio should test distinct_values, not key
    presence.

    Returns {field_key: {line_or_empty_string_or___plant_total__:
    {"distinct_values": int, "ranked_values": int}}}. Caller should cache this
    (R12). NOTE: the returned per-machine key is still named/described as
    "line" here because it is the raw machine-code string value, not a
    fieldname — see the machine-domain-rename note above ensure_priority_list_table.
    """
    if not fields:
        return {}
    # Shared FROM/JOIN/WHERE tail — identical for the per-machine and plant-total
    # branches; only the SELECT's `line` expression and the GROUP BY differ.
    body = sql.SQL("""
                   COUNT(DISTINCT UPPER(TRIM(o.{col}))) AS distinct_values,
                   COUNT(DISTINCT UPPER(TRIM(o.{col}))) FILTER (
                       WHERE COALESCE(pl_machine.entries, pl_plant.entries, '{{}}'::jsonb)
                             ? UPPER(TRIM(o.{col}))
                   ) AS ranked_values
              FROM orders o
              LEFT JOIN priority_list pl_machine
                ON pl_machine.plant = o.plant AND pl_machine.machine = o.machine
               AND pl_machine.field_key = %s
              LEFT JOIN priority_list pl_plant
                ON pl_plant.plant = o.plant AND pl_plant.machine = ''
               AND pl_plant.field_key = %s
             WHERE o.plant = %s
               AND o.{col} IS NOT NULL AND o.{col} <> ''
    """)
    parts, params = [], []
    for field_key, source_column in fields.items():
        col = sql.Identifier(source_column)
        parts.append(
            sql.SQL("SELECT %s AS field_key, COALESCE(o.machine, '') AS line,")
            + body.format(col=col)
            + sql.SQL(" GROUP BY COALESCE(o.machine, '')")
        )
        params.extend([field_key, field_key, field_key, plant])
        parts.append(
            sql.SQL("SELECT %s AS field_key, {total_key}::text AS line,").format(
                total_key=sql.Literal(PLANT_TOTAL_COVERAGE_KEY))
            + body.format(col=col)
        )
        params.extend([field_key, field_key, field_key, plant])

    full_q = sql.SQL(" UNION ALL ").join(parts)
    result: dict[str, dict] = {fk: {} for fk in fields}
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(full_q, params)
        for field_key, line, dv, rv in cur.fetchall():
            result[field_key][line] = {"distinct_values": dv, "ranked_values": rv}
    return result
