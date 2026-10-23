"""
NIMBUS 2.0 — Postgres data layer.

This module is the single home for all Postgres connection management,
schema-aware queries, and Excel-upload ingestion.  brain.py imports the
public API from here; nothing else in the project should hold a connection.

Connection string is hardcoded for the POC, mirroring how INPUT_FILE /
COLOR_FILE are hardcoded in brain.py.  Swap to env vars / Azure managed
identity at the migration step.
"""
import dataclasses
import functools
import hashlib
import io
import logging
import os
import re
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

import backend.schedule_events.events as sched_events

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


def _like_contains(s: str) -> str:
    """Build an ILIKE "contains" pattern for `s` with its own special
    characters (`\\`, `%`, `_`) escaped, so a user's free-text search can
    never accidentally use ILIKE's wildcard syntax (e.g. a material number
    containing "_" matching more than that literal underscore). Callers
    MUST pair this with `ILIKE %s ESCAPE '\\'` -- the escape character this
    helper's own escaping assumes."""
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


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
# One start and one end for an order, as shared SQL fragments, so every read path agrees (backward
# scheduling, Task 2.2). The server NEVER computes a finish from `start + run_time` (the one exception is the
# distribution collapse carry, backend/distribution/data.py `_collapse_to_survivor`, G-0.28): it only reads what
# was stored, in this order.
#   Finish (_EFF_END_SQL):   the last segment end, else the stored `scheduled_end` (the planner's placed
#                            finish), else the locked SAP finish as received, else `basic_finish_date`.
#                            A never-placed order therefore reads the due date; a placed order's bar width
#                            is whatever was stored, whatever its run time says.
#   Start (_EFF_START_SQL):  NULL for a queued (Needs Planning) order, else the first segment start, else
#                            `scheduled_start`, else `basic_start_date` (the display start until the
#                            browser derives one).
#   SAP start (_SAP_START_RECEIVED_SQL): the key the visibility horizon and the vanish rule read: the SAP
#                            start as first received (locked), never where a planner placed the order.
#   Placed (_PLACED_SQL):    the one definition of "someone placed this order".
# Every fragment is qualified with the `o` alias of `orders` and the `seg` alias of
# `_SCHEDULE_SEGMENTS_LATERAL_SQL`, so every caller must alias its orders table `o` and join the lateral.
# Static SQL, no user input, so it is safe to interpolate.
_EFF_START_SQL = (
    "CASE WHEN o.planning_status = 'needs_planning' THEN NULL "
    "ELSE COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) END"
)
_EFF_END_SQL = "COALESCE(seg.last_end, o.scheduled_end, o.original_finish_received, o.basic_finish_date)"
# A queued order has no window at all (both edges NULL on the wire).
_EFF_END_UNLESS_QUEUED_SQL = f"CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE {_EFF_END_SQL} END"
_SAP_START_RECEIVED_SQL = "COALESCE(o.original_start_received, o.basic_start_date, o.original_finish_received)"
_PLACED_SQL = "(seg.segment_count >= 2 OR o.scheduled_start IS NOT NULL OR o.scheduled_end IS NOT NULL)"

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

MIN_SEGMENT_MINUTES = 30

# Run-time length limits (backward-scheduling OQ28). The DATABASE bound is only a representation
# bound (hours in a year: keeps NaN/Infinity/garbage out of interval arithmetic); the LIMIT an order
# is scheduled with is a flat 336 h (14 days) on every plant (U5: the backward walk looks back ~90
# days, so a plant's visibility horizon no longer buys derivability). A longer order is not an error:
# it waits in Needs Planning.
RUN_TIME_REPRESENTATION_BOUND_HOURS = 8760.0
RUN_TIME_MAX_HOURS = 336.0
RUN_TIME_OVER_CAP_CODE = "run_time_over_cap"


def cap_hours(plant_row=None) -> float:
    """The longest run time (hours) an order may be scheduled with: the flat RUN_TIME_MAX_HOURS (336 h).
    `plant_row` is accepted (and ignored) so every caller keeps one place to change if the owner later
    names a per-plant setting."""
    return RUN_TIME_MAX_HOURS


def _fmt_hours(value) -> str:
    return f"{float(value):,.1f}".rstrip("0").rstrip(".")


def run_time_over_cap_reason(run_time, cap: float) -> dict:
    """The Needs Planning reason for an order whose run time is over the cap (same {code, message}
    shape as every other planning_reason; the extra numbers feed the localised label in the grid)."""
    return {
        "code": RUN_TIME_OVER_CAP_CODE,
        "message": (f"Run time of {_fmt_hours(run_time)} h is longer than the {_fmt_hours(cap)} h limit. "
                    f"Shorten the run time or split the order, then schedule it."),
        "run_time": float(run_time),
        "cap_hours": float(cap),
    }


def _plant_caps(cur, plants) -> dict[str, float]:
    """{plant: cap_hours} for a distinct plant set (flat 336 h; kept as one seam for a future per-plant cap)."""
    clean_plants = sorted({p for p in plants if p})
    if not clean_plants:
        return {}
    return {p: cap_hours() for p in clean_plants}


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


def _machine_match_key(machine) -> str:
    """Case- and whitespace-insensitive comparison key for a machine code."""
    return "".join(str(machine).split()).casefold()


def _known_machine_keys(cur, plant: str) -> dict[str, str]:
    """Machines a MACHINE edit may target on `plant`: the plant's registered
    machines plus any machine already holding orders there (legacy/unregistered
    lines are legitimate move targets), as {`_machine_match_key`: canonical
    spelling}. The canonical spelling is the machine table's when registered,
    else the most common spelling among the plant's orders, so a match on a
    differently-cased/spaced edit stores the real code, never the typo."""
    cur.execute("SELECT machine FROM machine WHERE plant = %s", (plant,))
    out: dict[str, str] = {}
    for (m,) in cur.fetchall():
        if m:
            out.setdefault(_machine_match_key(m), m)
    cur.execute(
        "SELECT machine, COUNT(*) AS n FROM orders WHERE plant = %s AND machine IS NOT NULL"
        " GROUP BY machine ORDER BY n DESC, machine",
        (plant,),
    )
    for m, _n in cur.fetchall():
        if m:
            out.setdefault(_machine_match_key(m), m)
    return out


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
    visibility horizon (C1). It also served the frozen horizon (C2) until
    2026-10-19, when that horizon became a continuously rolling window
    (`compute_frozen_horizon_end` now computes plant-local now + N days itself);
    this daily-roll clock is now used by the visibility horizon only. The caller
    (compute_visibility_horizon_end) owns its own "what does an absent day-count
    mean" convention and calls this only once the horizon is active.

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
    """Plant frozen horizon far edge (workstream C2, 2026-08-20; made rolling
    2026-10-19): the instant through which the optimizer may not place or move
    any order. The frozen window is `[now, this instant)`, and BOTH edges
    advance continuously with the clock, exactly like the alert horizon: the
    result is plant-local now plus `frozen_horizon_days` wall-clock days. An
    order whose own start already falls inside it is treated as implicitly
    pinned rather than moved.

    This no longer uses `_horizon_boundary_core`'s once-a-day anchor-day/
    roll-hour clock (that stays in force for the VISIBILITY horizon only), so
    `horizon_roll_hour_utc` has no effect here; the parameter is kept so the
    signature and every caller are unchanged.

    The result is a naive plant-local wall-clock datetime (same convention as
    `_horizon_boundary_core`: directly comparable to scheduled_start/
    basic_start_date). An unresolvable/missing timezone falls back to treating
    `now_utc` as the local clock (UTC), never raising on bad master data.

    Null convention: BOTH NULL and 0 mean "off" and return None (a 0-day
    frozen window is meaningless and must disable the feature outright).
    """
    if not frozen_horizon_days:
        return None
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    try:
        local_now = now_utc.astimezone(ZoneInfo(timezone_name)) if timezone_name else now_utc
    except (ZoneInfoNotFoundError, ValueError):
        local_now = now_utc
    return local_now.replace(tzinfo=None) + timedelta(days=int(frozen_horizon_days))


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
        {_EFF_START_SQL} AS "BASIC_START_DATE",
        {_EFF_END_UNLESS_QUEUED_SQL} AS "BASIC_FINISH_DATE",
        o.planning_status AS "PLANNING_STATUS",
        o.planning_reason AS "PLANNING_REASON",
        -- The wire "original" dates are the LOCKED SAP values as received; basic_* is the
        -- fallback for a row with no locked copy yet (backward scheduling, Phase 1).
        COALESCE(o.original_start_received,  o.basic_start_date)  AS "ORIGINAL_START_DATE",
        COALESCE(o.original_finish_received, o.basic_finish_date) AS "ORIGINAL_END_DATE",
        {_PLACED_SQL} AS "USER_SCHEDULED",
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
        manual_firmed         AS "FIRMED",
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
        {_SCHEDULE_RUNTIME_MISMATCH_SQL} AS "RUNTIME_SCHEDULE_MISMATCH",
        o.placement_exception AS "PLACEMENT_EXCEPTION"
    FROM orders o
    {_SCHEDULE_SEGMENTS_LATERAL_SQL}
"""


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
    and applied to the SAP start as first received (`_SAP_START_RECEIVED_SQL`,
    backward scheduling OQ27) — gating on start only (OD-C1d) — so a plant with a
    configured horizon never has to rely on the frontend to hide rows that
    were never sent, and a planner's placement never moves an order across it. Unscoped (`plant=None`) calls are not horizon-bounded:
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
    cols, rows, horizon_end, frozen_end = _fetch_orders(plant, line, limit, offset, allowed_plants, dict_rows=False)
    return pd.DataFrame(rows, columns=cols), horizon_end, frozen_end


def query_orders_rows(plant: str | None = None, line: str | None = None,
                      limit: int | None = None, offset: int | None = None,
                      allowed_plants: list[str] | None = None) -> tuple[list[dict], datetime | None, datetime | None]:
    """Pandas-free sibling of `query_orders` for the GET /tasks hot path: the SAME
    SQL, scope, horizon filter and ORDER BY, but rows come back as a list of dicts
    keyed by the `_ORDERS_SELECT` aliases, in SQL order. Empty
    result -> `([], horizon_end, frozen_end)`. Read-only; never touches `orders`."""
    _, rows, horizon_end, frozen_end = _fetch_orders(plant, line, limit, offset, allowed_plants, dict_rows=True)
    return rows, horizon_end, frozen_end


def _fetch_orders(plant, line, limit, offset, allowed_plants, *, dict_rows: bool):
    """Shared body of `query_orders` / `query_orders_rows` -> (cols, rows, horizon_end, frozen_end)."""
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
                         f"{_SAP_START_RECEIVED_SQL} <= %s)")
            params.append(horizon_end)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += '\n    ORDER BY o.machine, COALESCE(seg.first_start, o.scheduled_start, o.scheduled_end, o.basic_start_date)'
        if limit is not None:
            sql += " LIMIT %s"
            params.append(int(limit))
        if offset:
            sql += " OFFSET %s"
            params.append(int(offset))
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    if dict_rows:
        # zip, not a dict_row cursor: the horizon lookup above unpacks tuple rows on this cursor.
        rows = [dict(zip(cols, r, strict=True)) for r in rows]
    return cols, rows, horizon_end, frozen_end


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
                         f"{_SAP_START_RECEIVED_SQL} <= %s)")
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
               {_EFF_START_SQL} AS eff_start,
               {_EFF_END_UNLESS_QUEUED_SQL} AS eff_end,
               o.xmin::text::bigint AS row_version,
               seg.schedule_segments,
               {_SCHEDULE_RUNTIME_MISMATCH_SQL} AS runtime_schedule_mismatch,
               o.plant, o.planning_status, o.planning_reason,
               o.run_time_source, o.run_time_basis,
               o.machine, o.prt_01, o.prt_02, o.production_version, o.run_time,
               o.order_quantity, o.material_number,
               COALESCE(o.original_start_received, o.basic_start_date) AS original_start,
               o.manual_firmed,
               COALESCE(o.original_finish_received, o.basic_finish_date) AS original_end,
               o.placement_exception,
               {_PLACED_SQL} AS user_scheduled
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
            "firmed": bool(r[19]),
            "original_end_date": r[20].strftime("%Y-%m-%dT%H:%M:%S") if r[20] else None,
            "placement_exception": r[21],
            "user_scheduled": bool(r[22]),
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


UPLOAD_AUDIT_SOURCES = ("sap", "excel")


def upload_audit_log(limit: int = 50, source: str | None = None) -> list[dict]:
    """Recent uploads, newest first, for the Admin Cockpit history card.

    `source` filters server-side BEFORE the limit: 'sap' = SAP syncs
    (filename 'sap:sap', see upsert_orders), 'excel' = everything that is not
    a SAP sync. Without it a SAP history card could only filter the newest
    `limit` rows client-side and silently lose older SAP entries."""
    if source is not None and source not in UPLOAD_AUDIT_SOURCES:
        raise ValueError(f"source must be one of {', '.join(UPLOAD_AUDIT_SOURCES)}")
    where = {None: "", "sap": "WHERE filename = 'sap:sap'",
             "excel": "WHERE filename IS DISTINCT FROM 'sap:sap'"}[source]
    sql = f"""
        SELECT batch_id, filename, row_count,
               inserted_count, updated_count, uploaded_at, warnings
        FROM upload_audit
        {where}
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


# How far (hours) before the window the conflict scan's start-indexed lookback reaches: a fixed cap.
_CONFLICT_LOOKBACK_CAP_HOURS = 30 * 24


def _strict_lock_key(plant: str, machine_key: str) -> str:
    """Advisory-lock text for a (plant, `_machine_match_key`) pair."""
    return f"{plant}\x1f{machine_key}"


def _lock_machines_for_strict_save(cur, items: list[dict], ids: list[str]) -> None:
    """Strict optimizer saves: serialise on every (plant, machine) the batch will
    touch -- the rows' current machines plus any MACHINE edit target -- using
    transaction-scoped advisory locks taken in sorted order, BEFORE the row
    FOR UPDATE locks, so two concurrent strict saves can neither both pass the
    overlap scan against pre-commit snapshots nor deadlock each other. The lock
    key uses the canonical `_machine_match_key` (case/whitespace-insensitive),
    never the raw spelling, so 'M1' and 'm1' share one lock. Scope: this only
    serialises strict saves against OTHER strict saves; a non-strict (manual)
    save takes no advisory lock, so a strict save's overlap scan is not
    protected from a concurrent manual save of the same machine."""
    cur.execute("SELECT id, plant, machine FROM orders WHERE id = ANY(%s)", (ids,))
    rows = cur.fetchall()
    plant_by_id = {r[0]: r[1] for r in rows}
    keys = {(r[1], _machine_match_key(r[2])) for r in rows if r[1] and r[2]}
    for it in items:
        target = _canonical_nullable_attribute(it.get("MACHINE")) if "MACHINE" in it else None
        plant = plant_by_id.get(it.get("id"))
        if target and plant:
            keys.add((plant, _machine_match_key(target)))
    for plant, machine_key in sorted(keys):
        cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (_strict_lock_key(plant, machine_key),))


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
    # A long order can start well before `lo` and still run into the window, so the start-indexed
    # lookback is widened by the fixed 30-day cap (OQ27 e) -- no longer sized from the machines' run
    # times, because a bar's drawn span is its stored finish, not start + run time -- and the
    # true-overlap test stays on the effective END (the shared stored-finish fragment). Only PLACED
    # neighbours are scanned: a never-placed order has no server-side placement (its "window" is the whole
    # SAP window), so it cannot conflict here; the client overlap alert covers display overlaps. Bounded by the
    # same indexable eff-start range (idx_orders_machine_eff_start): nothing starting more than the cap
    # before `lo` can matter, so the scan never reads a machine's whole history.
    wide_lo = lo - timedelta(hours=_CONFLICT_LOOKBACK_CAP_HOURS)
    cur.execute(
        f"""
        SELECT o.machine, o.plant, o.id,
               COALESCE(seg.schedule_segments, '[]'::jsonb) AS segments,
               COALESCE(o.scheduled_start,
                        CASE WHEN o.scheduled_end IS NOT NULL
                             THEN o.scheduled_end - make_interval(secs => COALESCE(o.run_time, 0) * 3600) END,
                        o.basic_start_date) AS eff_start,
               {_EFF_END_SQL} AS eff_end
        FROM orders o
        {_SCHEDULE_SEGMENTS_LATERAL_SQL}
        WHERE o.machine = ANY(%s)
          AND o.plant = ANY(%s)
          AND o.planning_status <> 'needs_planning'
          AND {_PLACED_SQL}
          AND (COALESCE(o.scheduled_start, o.basic_start_date) BETWEEN %s AND %s
               -- a finish-only placement (a distribution carry: stored end, no stored start) matches on its
               -- stored end too (U2); its start is derived as end - run time for the overlap test
               OR o.scheduled_end BETWEEN %s AND %s)
          AND {_EFF_END_SQL} > %s
        """,
        (machines, plants, wide_lo, hi, lo, hi + timedelta(hours=_CONFLICT_LOOKBACK_CAP_HOURS), lo),
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


# Width tolerance of the continuous-bar check, in seconds (the stored bar and its run time are both whole
# minutes; a minute of slack absorbs a browser rounding the finish up to its minute).
WIDTH_TOLERANCE_SECONDS = 60
PLACEMENT_EXCEPTIONS = ("overtime", "overlong")


def _elapsed_seconds_readings(start: datetime, end: datetime, plant_tz: str | None) -> list[float]:
    """Every real duration two NAIVE plant-local edges can mean. With a zone, each edge is read as the instant
    it names there; inside the repeated fall-back hour a naive wall time names two instants (fold 0 and 1), so
    the readings are returned for every fold pair and the caller accepts a bar that fits under any of them
    (VI2). Outside that hour all readings are equal. No zone: the plain wall-clock difference."""
    zone = None
    if plant_tz:
        try:
            zone = ZoneInfo(plant_tz)
        except (ZoneInfoNotFoundError, ValueError):
            zone = None
    if zone is None:
        return [(end - start).total_seconds()]
    out: list[float] = []
    for fs in (0, 1):
        for fe in (0, 1):
            s = start.replace(tzinfo=zone, fold=fs).astimezone(timezone.utc)
            e = end.replace(tzinfo=zone, fold=fe).astimezone(timezone.utc)
            out.append((e - s).total_seconds())
    return sorted(set(out))


def _validate_continuous_width(start: datetime, end: datetime, run_time, placement_exception: str | None,
                               plant_tz: str | None) -> bool | None:
    """Does a continuous (non-segmented) bar's elapsed width equal its run time, within
    WIDTH_TOLERANCE_SECONDS? Returns None when the check does not apply (the bar carries a
    placement exception, or its run time is unknown: nothing to compare), else True / False.
    The server never derives an edge from the other; it only judges the pair it was sent."""
    if placement_exception is not None or run_time is None or float(run_time) <= 0:
        return None   # (a zero run time has no width to compare; its bar must still be non-empty)
    target = float(run_time) * 3600.0
    return any(abs(v - target) <= WIDTH_TOLERANCE_SECONDS for v in _elapsed_seconds_readings(start, end, plant_tz))


_ORDER_ATTR_COLUMNS = {
    "PRT_01": "prt_01",
    "PRT_02": "prt_02",
    "PRODUCTION_VERSION": "production_version",
    "MACHINE": "machine",
}
_ORDER_UPDATE_BATCH = 500   # rows per UPDATE ... FROM (VALUES ...) statement


def _order_update_shape(row: dict) -> tuple[tuple, tuple, list]:
    """One row's SET list as (literal SET fragments, parameterised columns,
    parameter values). Rows with the same first two members share one batched
    statement; a column a row did not set is never in its shape, so it is
    never touched (and an unedited column never changes)."""
    lits: list[str] = []
    pars: list[tuple] = []     # (column, cast, expression over the VALUES column {v})
    vals: list = []
    if row["planning_status"] is not None:
        pars.append(("planning_status", "text", "{v}"))
        vals.append(row["planning_status"])
        pars.append(("planning_reason", "jsonb", "{v}"))
        vals.append(Jsonb(row["planning_reason"]) if row["planning_reason"] else None)
    if row["queued"]:
        # A queued order has no bar, so it has no marker for one either.
        lits.extend(["scheduled_start = NULL", "scheduled_end = NULL", "placement_exception = NULL"])
    elif row["has_exception"]:
        pars.append(("placement_exception", "text", "{v}"))   # a None value clears the marker
        vals.append(row["placement_exception"])
    if row["start"] is not None and not row["queued"]:
        pars.append(("scheduled_start", "timestamp", "{v}"))
        vals.append(row["start"])
    if row["end"] is not None and not row["queued"]:
        pars.append(("scheduled_end", "timestamp", "{v}"))
        vals.append(row["end"])
    # D20 (refined): the `order_sap_sent` side-table values are deliberately NOT cleared here. They are
    # overwritten only by the next Send to SAP; clearing them on a planner edit let
    # SAP's echo of the OLD send wipe the planner's newer edit.
    if row["has_runtime"]:
        pars.append(("run_time", "numeric", "{v}"))
        vals.append(row["run_time"])
    if row["has_firmed"]:
        pars.append(("manual_firmed", "boolean", "{v}"))
        vals.append(row["firmed"])
    if row["manual_runtime_release"]:
        lits.append("run_time_source = 'manual'")
    if row["resolved_runtime"] is not None:
        lits.append("run_time_source = 'routing'")
        pars.append(("run_time_basis", "jsonb", "{v}"))
        vals.append(Jsonb(row["resolved_runtime"]["basis"]))
    if row.get("force_mismatch") or row.get("stale_runtime"):
        # An untrusted start (trust_start=False, backward scheduling OQ59): the stored bar's start is a
        # guess, so the row is flagged for the browser to re-derive it. Takes precedence over any clearing.
        lits.append("runtime_schedule_mismatch = TRUE")
    elif row["clear_runtime_mismatch"]:
        lits.append("runtime_schedule_mismatch = FALSE")
    for field, column in _ORDER_ATTR_COLUMNS.items():
        if field in row["attrs"]:
            pars.append((column, "text", "NULLIF({v}, '')"))
            vals.append(row["attrs"][field])
    # A child replacement still must touch the parent row so xmin remains the
    # aggregate's one optimistic-lock token.
    lits.append("updated_at = NOW()")
    return tuple(lits), tuple(pars), vals


def _apply_order_updates_batched(cur, update_rows: list[dict], versions: dict, after_out: dict | None = None) -> None:
    """P6: persist `update_rows` (already validated, stale-checked and
    FOR UPDATE-locked by the caller) with one `UPDATE ... FROM (VALUES ...)`
    per distinct SET-shape instead of one UPDATE per row. Per-row
    `RETURNING xmin` goes into `versions`; segment replacement for rows that
    carry segments is one DELETE + one executemany. Any error propagates (the
    caller rolls the whole transaction back, exactly as the per-row loop did).
    `after_out` (schedule_event history): when a dict is passed it receives, per id, the DB-typed AFTER
    image of the tracked columns from the same RETURNING (plus the segment count)."""
    groups: dict[tuple, list[tuple]] = {}
    for row in update_rows:
        lits, pars, vals = _order_update_shape(row)
        groups.setdefault((lits, pars), []).append((row["id"], vals))
    for (lits, pars), members in groups.items():
        for i in range(0, len(members), _ORDER_UPDATE_BATCH):
            chunk = members[i:i + _ORDER_UPDATE_BATCH]
            set_sql = ", ".join(
                list(lits)
                + [f"{col} = {expr.format(v='v.c' + str(n))}" for n, (col, _cast, expr) in enumerate(pars)]
            )
            row_ph = "(" + ", ".join(["%s::text"] + [f"%s::{cast}" for _col, cast, _expr in pars]) + ")"
            col_names = ", ".join(["id"] + [f"c{n}" for n in range(len(pars))])
            params: list = []
            for rid, vals in chunk:
                params.append(rid)
                params.extend(vals)
            cur.execute(
                f"UPDATE orders o SET {set_sql} FROM (VALUES {', '.join([row_ph] * len(chunk))}) AS v({col_names})"
                " WHERE o.id = v.id RETURNING o.id, o.xmin::text::bigint AS new_version"
                + (", o.machine, o.scheduled_start, o.scheduled_end, o.run_time, o.production_version,"
                   " o.manual_firmed, o.planning_status, o.planning_reason->>'code', o.prt_01, o.prt_02"
                   if after_out is not None else ""),
                params,
            )
            for rrow in cur.fetchall():
                versions[rrow[0]] = int(rrow[1])
                if after_out is not None:
                    after_out[rrow[0]] = {
                        "machine": rrow[2], "scheduled_start": rrow[3], "scheduled_end": rrow[4],
                        "run_time": rrow[5], "production_version": rrow[6], "manual_firmed": rrow[7],
                        "planning_status": _event_status(rrow[8], rrow[9]), "prt_01": rrow[10], "prt_02": rrow[11],
                    }
    seg_rows = [row for row in update_rows if row["segments"] is not None]
    if seg_rows:
        cur.execute("DELETE FROM order_schedule_segments WHERE order_id = ANY(%s)", ([r["id"] for r in seg_rows],))
        inserts = [(r["id"], seg["sequence"], seg["start"], seg["end"]) for r in seg_rows for seg in r["segments"]]
        if inserts:
            cur.executemany(
                "INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                " VALUES (%s, %s, %s, %s)",
                inserts,
            )
    if after_out is not None:
        for r in update_rows:
            if r["id"] in after_out and r["segments"] is not None:
                after_out[r["id"]]["segments"] = len(r["segments"])


def _event_status(status, reason_code) -> str | None:
    """schedule_event encoding of planning_status: 'needs_planning:<reason code>' when a code exists."""
    if status == "needs_planning" and reason_code:
        return f"needs_planning:{reason_code}"
    return status


def update_task_dates_bulk(items: list[dict], allowed_plants: list[str] | None = None,
                           *, atomic_optimizer: bool = False,
                           strict_conflicts: bool = False,
                           actor: str | None = None, client_id: str | None = None,
                           ev: "sched_events.EventCtx | None" = None) -> dict:
    """
    Persist parent schedule aggregates and allowlisted order attributes in one
    transaction.  A schedule_segments field is an all-or-nothing replacement
    of that parent's child set; its parent row's xmin is the only concurrency
    token.  Child rows are never addressed independently.

    Save contract (backward scheduling, Task 2.3): a non-segment, non-queued save must
    carry BOTH edges (a single edge is rejected, `single_edge`: the server never completes
    one edge from the stored other), and a continuous bar's elapsed plant-zone width must
    equal its run time within `WIDTH_TOLERANCE_SECONDS` (`width_mismatch`) unless it carries
    a `placement_exception`. Inverted ranges are rejected. Unknown ids are reported, not
    written.

    Untrusted start (backward scheduling OQ59, Task 2.7): an item may carry `trust_start: False` (the
    `/tasks/bulk_update` route forwards the request field). The sent `end` is stored as the placed finish
    exactly as for any save, but the sent `start` is only a guess: the continuous-width validator is skipped
    for that item and `runtime_schedule_mismatch` is forced TRUE (this takes precedence over the validator's
    clearing), so the browser re-derives the start from the finish on its next load. Both edges (or
    segments) are still required and an inverted range is still rejected. The ids saved this way come back
    in `start_derived` ({id: True}).

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
    `invalid_ids`, no separate reason field). An accepted candidate's run_time
    and basis are resolved and written inside this same transaction (no
    post-commit plant-wide resolve).

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
    neighbour's effective START (index-servable) widened by a fixed 30-day
    lookback and filtered on effective END (the stored finish), so a long
    order that began before the window and runs into it is found; an order
    drawn over more than the cap can still be missed, so
    `conflicts == []` is not absolute proof of no overlap. In strict mode the
    save first takes per-(plant, machine) advisory locks in sorted order.

    Returns {applied, persisted, failed, invalid, not_found, invalid_ids,
    not_found_ids, stale, versions, rejection_reasons, start_derived}. invalid_ids / not_found_ids
    carry the actual ids (not just counts) so the client can stop retrying
    terminally-rejected rows while still keeping genuinely-unpersisted rows dirty
    for a retry. `rejection_reasons` is a purely additive, sparse {id: reason}
    map -- populated ONLY for the routing-eligibility rejection below
    (ROUTING_RUNTIME_DESIGN.md §8.5), `machine_unknown`, `run_time_over_cap`,
    `single_edge` and `width_mismatch`; every other rejection in this function's
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
                "stale": [], "versions": {}, "conflicts": [], "rejection_reasons": {}, "start_derived": {}}

    # Deferred import (never module-level -- avoids a backend.routing <->
    # db.py import cycle, matching this codebase's established convention;
    # see backend/distribution/data.py, backend/integration/sap_sync.py).
    # Resolve candidate runtime inside this transaction so its schedule,
    # provenance and returned optimistic-lock token describe the same write.
    import backend.routing.resolver as routing_resolver

    ids = [it["id"] for it in items if it.get("id")]
    with _pool.connection() as conn, conn.cursor() as cur:
        if strict_conflicts and atomic_optimizer:
            _lock_machines_for_strict_save(cur, items, ids)
        cur.execute(
            f"""
            SELECT o.id,
                   {_EFF_START_SQL} AS eff_start,
                   {_EFF_END_UNLESS_QUEUED_SQL} AS eff_end,
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
                   COALESCE(o.original_start_received, o.basic_start_date) AS original_start,
                   o.production_version,
                   o.placement_exception,
                   p.timezone,
                   o.scheduled_start,
                   o.scheduled_end,
                   o.manual_firmed,
                   o.prt_01,
                   o.prt_02,
                   o.production_order
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
                # uses the row's own current values for them. The start is the SAP
                # start as first received (locked, OQ26), so an echo that moved
                # basic_start_date never changes a production version's validity.
                "run_time_source": r[12],
                "material_number": r[13],
                "order_quantity": r[14],
                "original_start": r[15],
                "production_version": r[16],
                "placement_exception": r[17],
                "timezone": r[18],
                # The RAW stored columns (never the effective edges, which fall back to the SAP window):
                # "unmoved" below means equal to what a planner stored.
                "stored_start": r[19],
                "stored_end": r[20],
                "manual_firmed": r[21], "prt_01": r[22], "prt_02": r[23], "production_order": r[24],
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
        known_machines_by_plant: dict[str, dict[str, str]] = {}
        eligibility_cache: dict = {}   # per-call plant lookups for check_eligibility (P7)
        plant_caps: dict[str, float] = {}   # per-call run-time cap by plant (OQ28), loaded lazily
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
            has_firmed = it.get("FIRMED") is not None
            has_planning = "planning_status" in it
            has_exception = "placement_exception" in it
            exception_value = it.get("placement_exception")
            planning_status = it.get("planning_status")
            planning_reason = it.get("planning_reason")
            queued = planning_status == "needs_planning"
            if (not tid or tid in seen_ids or
                    (start is None and end is None and not attrs and not has_segments and not has_runtime and not has_firmed and not has_planning
                     and not has_exception)):
                invalid_ids.append(tid)
                continue
            if has_exception and exception_value is not None and exception_value not in PLACEMENT_EXCEPTIONS:
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
            # Compared padding-insensitively: "0001" against a stored "1" is the same version, not an edit.
            if ("PRODUCTION_VERSION" in attrs
                    and _norm_pv(attrs["PRODUCTION_VERSION"]) == _norm_pv(
                        _canonical_nullable_attribute(current["production_version"]))):
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
            # Server-side MACHINE validation: the target must be a machine this
            # plant knows (registered, or already holding orders there); anything
            # else is a typo/forged value that would strand the order on a ghost
            # line. Rejected per item inside the normal 200 envelope, with
            # rejection_reasons[id] = "machine_unknown".
            if attrs.get("MACHINE") and current["plant"]:
                if current["plant"] not in known_machines_by_plant:
                    known_machines_by_plant[current["plant"]] = _known_machine_keys(cur, current["plant"])
                canonical_machine = known_machines_by_plant[current["plant"]].get(_machine_match_key(attrs["MACHINE"]))
                if canonical_machine is None:
                    rejection_reasons[tid] = "machine_unknown"
                    invalid_ids.append(tid)
                    continue
                # Store the canonical spelling (also feeds the eligibility check below).
                attrs["MACHINE"] = canonical_machine
            # Routing runtime (ROUTING_RUNTIME_DESIGN.md §5.5/§8.2/§8.5): a client
            # RUN_TIME is only honored on a disabled plant (today's unconditional
            # behavior, preserved exactly) or to release an order currently held
            # for a routing reason. Otherwise it's rejected as a whole-item
            # validation failure, same as any other single-aspect edit conflict
            # below (e.g. the queued-order date check just past this).
            manual_runtime_release = False
            resolved_runtime = None

            # Routing runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.5): a
            # MACHINE or PRODUCTION_VERSION edit on an order of a routing-enabled
            # plant must re-check §5.2 steps 1-8 for the CANDIDATE combination
            # before the edit is accepted -- otherwise the order could land on a
            # machine/version its routing can't resolve. Only gated when the
            # plant's switch is on. PV-Machine rule (D9): ANY changed MACHINE or
            # PRODUCTION_VERSION is gated whatever the run-time source (manual,
            # sap_order, legacy, routing, unknown): the pair is checked, the run
            # time resets to the routing value and the row is written
            # run_time_source='routing' (a hand-timed order that is moved loses its
            # manual run time; the browser sends the routing-derived RUN_TIME).
            # Material, quantity, and start
            # date are never edited by this endpoint, so they always come
            # from the row's own current values; machine/production version
            # come from the candidate edit when present, else the row's
            # current value. Read within THIS SAME open transaction/
            # connection -- never a second connection mid-write.
            if (("MACHINE" in attrs or "PRODUCTION_VERSION" in attrs)
                    and current["routing_runtime_enabled"]):
                candidate_machine = attrs.get("MACHINE", current["machine"])
                candidate_pv = attrs.get("PRODUCTION_VERSION", current["production_version"])
                eligibility = routing_resolver.check_eligibility(
                    current["plant"], current["material_number"], candidate_pv,
                    candidate_machine, current["order_quantity"], current["original_start"],
                    conn=conn, cache=eligibility_cache,
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
                # runtime_pending: an upload's placeholder hold that a failed
                # post-upload resolve can leave behind; keying a run time
                # releases it exactly like a resolver-set runtime_unknown.
                if not (current["planning_status"] == "needs_planning"
                        and current["reason_code"] in ("runtime_unknown", "runtime_pending")):
                    invalid_ids.append(tid)
                    continue
                manual_runtime_release = True

            # Both edges or segments, always (backward scheduling OQ50): a save never completes one
            # edge from the stored other (the server cannot know which edge the planner meant to hold).
            # A single-edge write to a non-segment, non-queued row is rejected; the edges the browser
            # sends are the edges stored.
            new_start, new_end = start, end
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
            # Run-time cap (OQ28): a new or changed run time longer than the plant's cap is rejected
            # for this id alone (200 envelope, rejection_reasons[id]); nothing is written for it. An
            # unchanged over-cap value (has_runtime was cleared above) never blocks an unrelated save.
            if has_runtime and requested_runtime is not None:
                if current["plant"] not in plant_caps:
                    plant_caps.update(_plant_caps(cur, [current["plant"]]))
                cap_for_plant = plant_caps.get(current["plant"], RUN_TIME_MAX_HOURS)
                if float(requested_runtime) > cap_for_plant:
                    rejection_reasons[tid] = RUN_TIME_OVER_CAP_CODE
                    invalid_ids.append(tid)
                    continue
            segment_rows: list[dict] | None = None
            width_passed = False   # True only when the continuous-width check ran and held

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

            # (a save carrying a non-empty aggregate may omit an edge: the aggregate supplies both)
            if (not queued and not segment_rows and not (has_segments and it.get("schedule_segments"))
                    and (start is None) != (end is None)):
                rejection_reasons[tid] = "single_edge"
                invalid_ids.append(tid)
                continue

            # VI2 gap: a bar whose wall edges coincide (01:30 first reading to 01:30 second) is a real hour,
            # but chk_orders_sched_range (scheduled_end > scheduled_start on naive columns) cannot store it,
            # so the wall-clock rule stays here and the width check below is what became fold-tolerant.
            if new_start is not None and new_end is not None and new_end <= new_start:
                invalid_ids.append(tid)
                continue

            if (not queued and (start is not None or end is not None or has_segments)
                    and (new_start is None or new_end is None)):
                invalid_ids.append(tid)
                continue
            if (not queued and has_planning and not has_segments and start is None and end is None
                    and current["stored_start"] is None and current["stored_end"] is None
                    and current["segment_count"] < 2):
                # A status-only save to 'scheduled' (no edges sent) writes no edges, so the row must already hold a
                # stored placement. A queued row and a never-placed row (both stored edges NULL, no segments) have
                # none: the SAP window the read path falls back to is not a placement and is never stamped from here.
                # Rejected as `single_edge` (the planner must save both edges together; no new wire reason).
                rejection_reasons[tid] = "single_edge"
                invalid_ids.append(tid)
                continue

            # Continuous (non-segment) bar: its elapsed width must equal its run time, unless the planner
            # marked the placement as a deliberate exception or the run time is unknown. The server only
            # judges the pair of edges it was sent. A marker sent with this save wins over the stored one
            # (an explicit null clears it, so the check applies again). Segments (>= 2 pieces) are judged
            # by _validate_schedule_segments above; an item that must not trust its sent start
            # (`trust_start: False`, Task 2.7) bypasses this gate and has the flag forced instead.
            # A save that does not move the bar (both sent edges equal the stored RAW placement, run time
            # unchanged) is not judged: the browser resends the full snapshot on an attribute-only edit, and a
            # stale bar the engine could not re-derive must stay savable. The flag is then left untouched
            # (width_passed stays False). A never-placed order has NULL stored edges, so it is always judged.
            # D12 (VM15): changing or clearing the marker is a move; the width gate must see it
            marker_changed = has_exception and exception_value != current["placement_exception"]
            unmoved = (new_start is not None and new_end is not None
                       and current["stored_start"] is not None and current["stored_end"] is not None
                       and new_start == current["stored_start"] and new_end == current["stored_end"]
                       and not runtime_changed and not marker_changed)
            # An untrusted start (OQ59): the pair of edges is stored but not judged; the flag is forced below.
            trusted = it.get("trust_start", True) is not False
            if (trusted and not queued and not segment_rows and new_start is not None and new_end is not None
                    and not unmoved):
                effective_exception = exception_value if has_exception else current["placement_exception"]
                width_ok = _validate_continuous_width(
                    new_start, new_end, requested_runtime, effective_exception, current["timezone"])
                if width_ok is False:
                    rejection_reasons[tid] = "width_mismatch"
                    invalid_ids.append(tid)
                    continue
                width_passed = width_ok is True

            row_planning_status = planning_status if has_planning else (
                "scheduled" if start is not None or end is not None or has_segments else None)
            row_planning_reason = planning_reason if queued else None
            if manual_runtime_release and not queued:
                # Releasing a routing hold with a keyed-in value re-enters the
                # order at 'scheduled' with the reason cleared, in the same
                # write as the run_time itself (§5.5/§8.2).
                row_planning_status = "scheduled"
                row_planning_reason = None

            # The start is a guess only when this save really writes a bar (a queued row has none, and a
            # status-only/attribute-only save writes no edges).
            force_mismatch = (not trusted and not queued
                              and (start is not None or end is not None or bool(segment_rows)))
            update_rows.append({
                "id": tid,
                "event_source": it.get("source") if it.get("source") in sched_events.PLANNER_SOURCES else None,
                "force_mismatch": force_mismatch,
                # D13 (VM2): a run time changed with no edges leaves the stored bar wrong; flag it so the browser re-derives
                "stale_runtime": (runtime_changed and not queued and start is None and end is None
                                  and not segment_rows and current["stored_start"] is not None
                                  and current["stored_end"] is not None),
                "start": new_start if has_segments else start,
                "end": new_end if has_segments else end,
                "attrs": attrs,
                "queued": queued,
                "planning_status": row_planning_status,
                "planning_reason": row_planning_reason,
                "run_time": requested_runtime,
                "has_runtime": has_runtime,
                "has_firmed": has_firmed,
                "firmed": bool(it["FIRMED"]) if has_firmed else None,
                "manual_runtime_release": manual_runtime_release,
                "resolved_runtime": resolved_runtime,
                "segments": segment_rows,
                # The stale flag clears only when the stored bar was actually checked against the run time:
                # a validated segment aggregate, or a continuous bar whose width check ran and held. A bar
                # with a placement exception (or no known run time) leaves the flag untouched.
                "clear_runtime_mismatch": (queued or bool(segment_rows) or width_passed) and not force_mismatch,
                "has_exception": has_exception and not queued,
                "placement_exception": exception_value,
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
                    "rejection_reasons": rejection_reasons, "start_derived": {}}

        if update_rows:
            try:
                after_out: dict | None = {} if ev is not None else None
                _apply_order_updates_batched(cur, update_rows, versions, after_out)
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
                            "rejection_reasons": rejection_reasons, "start_derived": {}}
                if ev is not None and after_out:
                    ev_rows = []
                    src_by_id = {r["id"]: r["event_source"] for r in update_rows}
                    for oid, aft in after_out.items():
                        cur_row = eff[oid]
                        before = {
                            "machine": cur_row["machine"], "scheduled_start": cur_row["stored_start"],
                            "scheduled_end": cur_row["stored_end"], "run_time": cur_row["run_time"],
                            "production_version": cur_row["production_version"],
                            "manual_firmed": cur_row["manual_firmed"],
                            "planning_status": _event_status(cur_row["planning_status"], cur_row["reason_code"]),
                            "prt_01": cur_row["prt_01"], "prt_02": cur_row["prt_02"],
                            "segments": cur_row["segment_count"],
                        }
                        aft = dict(aft)
                        aft.setdefault("segments", cur_row["segment_count"])
                        changes = sched_events.diff_tracked(before, aft)
                        if changes:
                            ev_rows.append(sched_events.EventRow(
                                plant=cur_row["plant"], order_id=oid,
                                production_order=cur_row["production_order"],
                                material_number=cur_row["material_number"],
                                op="modify", changes=changes, source=src_by_id.get(oid)))
                    sched_events.record(cur, ev, ev_rows)
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
            "rejection_reasons": rejection_reasons,
            # the ids whose untrusted start was stored (and flagged) -- only those that actually persisted
            "start_derived": {r["id"]: True for r in update_rows if r["force_mismatch"] and r["id"] in versions}}


def get_order_plant(task_id: str) -> str | None:
    """Return a single order's plant, or None if the row doesn't exist.
    Standalone lookup for routes that need a plant-scoping check before a
    write that itself has no per-row prefetch (e.g. /task/note)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM orders WHERE id = %s", (task_id,))
        row = cur.fetchone()
    return row[0] if row else None


def update_task_note(task_id: str, notes, *, ev: "sched_events.EventCtx | None" = None) -> dict:
    """Persist a user-written note for an order. Pass None to clear.

    RETURNING the post-write xmin (B1 fix, 2026-09-01): this UPDATE bumps
    orders.xmin like any other, so without surfacing the new version here the
    client's cached row_version goes stale and its next real scheduling save
    spuriously lands in `stale` — same versions-map shape as
    update_task_dates_bulk so the frontend can re-stamp uniformly.
    """
    # Self-join (PG16-safe, no RETURNING OLD): `b` reads the pre-write notes for the history diff.
    sql = ("UPDATE orders o SET notes = %s, updated_at = NOW() FROM orders b WHERE o.id = %s AND b.id = o.id "
           "RETURNING o.id, o.xmin::text::bigint AS new_version, b.notes, o.plant, o.production_order, o.material_number")
    with _pool.connection() as conn, conn.cursor() as cur:
        new_notes = notes or None
        cur.execute(sql, (new_notes, task_id))
        row = cur.fetchone()
        updated = cur.rowcount
        if ev is not None and row:
            changes = sched_events.diff_tracked({"notes": row[2]}, {"notes": new_notes})
            if changes:
                sched_events.record(cur, ev, [sched_events.EventRow(
                    plant=row[3], order_id=row[0], production_order=row[4], material_number=row[5],
                    op="modify", changes=changes)])
        conn.commit()
    versions = {row[0]: int(row[1])} if row else {}
    return {"status": "ok", "updated": updated, "versions": versions}


# Purge selector: plant-scoped, on the order's effective end date (scheduled_end, then the
# locked SAP finish, then basic_finish_date; segments are not joined here, as before). Shared verbatim between preview_purge_orders
# and purge_orders_by_date so the two can never describe different row sets —
# that divergence (a client-side preview count disagreeing with the real DELETE)
# was the original defect this pair of functions replaces. Measured against the
# only real dataset available (2026-09-08, plant 1085, 1842 orders): this
# predicate, _EFF_END_SQL, and the full /tasks read-path expression all agreed
# exactly, so the predicate itself is intentionally left unchanged — only the
# scoping is new. See docs/architecture (purge hardening) for the measurement.
_PURGE_WHERE_SQL = ("plant = %(plant)s AND COALESCE(scheduled_end, original_finish_received, basic_finish_date)"
                    " BETWEEN %(start)s AND %(end)s")


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
    stored start or finish (a planner-set schedule the ingest upsert never restores on
    re-upload — see schema.sql's orders comment), which is the number that
    matters most for an honest confirmation prompt."""
    where, params = _purge_scope_sql_params(plant, start, end, machines)
    sql = (f"SELECT COUNT(*), COUNT(*) FILTER (WHERE scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL)"
           f" FROM orders WHERE {where}")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        total, planner_overridden = cur.fetchone()
    return {"status": "ok", "plant": plant, "total": int(total),
            "planner_overridden": int(planner_overridden)}


_PURGE_RETURNING = ("id, plant, production_order, material_number, machine, scheduled_start, scheduled_end,"
                    " planning_status, planning_reason, manual_firmed")
_PURGE_RETURNING_COLS = tuple(c.strip() for c in _PURGE_RETURNING.split(","))


def _purge_deleted_rows(cur) -> list[dict]:
    """Rows of the last `DELETE ... RETURNING {_PURGE_RETURNING}` as dicts (bounded last-state snapshot)."""
    return [dict(zip(_PURGE_RETURNING_COLS, r, strict=True)) for r in cur.fetchall()]


def _purge_event_rows(plant: str, deleted_rows: list[dict], segs_by_id: dict | None = None) -> list:
    """One `remove` EventRow per purged order: a bounded last-state snapshot (machine, scheduled_*,
    planning_status as `needs_planning:<code>`, manual_firmed, and `segments` when the archive counted them)."""
    out = []
    for r in deleted_rows:
        snap = {k: r.get(k) for k in ("machine", "scheduled_start", "scheduled_end", "manual_firmed")}
        status = r.get("planning_status")
        reason = r.get("planning_reason")
        code = reason.get("code") if isinstance(reason, dict) else None
        snap["planning_status"] = f"{status}:{code}" if status == "needs_planning" and code else status
        if segs_by_id is not None:
            snap["segments"] = len(segs_by_id.get(r["id"], []))
        out.append(sched_events.EventRow(
            plant=r.get("plant") or plant, order_id=r["id"], production_order=r.get("production_order"),
            material_number=r.get("material_number"), op="remove",
            changes=sched_events.snapshot_changes(snap, op="remove")))
    return out


def _purge_order_ids_on_cursor(cur, plant: str, ids: list[str], *, action: str,
                               user_email: str | None, extra_details: dict | None = None,
                               deleted_rows: list[dict] | None = None, ev=None,
                               segs_by_id: dict | None = None) -> dict:
    """Shared tail of every order purge. `ids` were already deleted by the
    caller (DELETE ... RETURNING id) on `cur`'s transaction: retire the
    distribution shares that pointed at them, delete headers left with no live
    share, and write the admin_audit row. The caller owns commit/rollback.
    """
    deleted = len(ids)
    shares_purged = 0
    headers_deleted = 0
    if ids:
        # Scope by `plant =` so this at least narrows via
        # idx_ods_machine(plant, machine) -- child_id itself has no index.
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

    audit_details = {"plant": plant, "deleted": deleted, "order_ids": ids[:200],
                     "order_id_count": len(ids), "truncated": len(ids) > 200,
                     "shares_purged": shares_purged, "headers_deleted": headers_deleted,
                     **(extra_details or {})}
    cur.execute(
        "INSERT INTO admin_audit (table_name, action, details, user_email)"
        " VALUES ('orders', %s, %s, %s)",
        (action, Jsonb(audit_details), user_email),
    )
    if ev is not None and deleted_rows:
        sched_events.record(cur, ev, _purge_event_rows(plant, deleted_rows, segs_by_id))
    return {"deleted": deleted, "shares_purged": shares_purged, "headers_deleted": headers_deleted}


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
    `letter`/`weight` are left alone -- D02 (owner decision): an upload of the
    parent, Reset, and reapply-defaults revive a purged share; Repair and
    re-weight never do (`backend/distribution/data.py::_write_reweight_shares`).
    A header left with no remaining live share (every share now weight-0 or
    purged) is then deleted outright -- shares cascade (schema.sql ~187-188)
    -- so a later re-upload of the same parent creates a fresh header instead
    of resurrecting a dead one. `shares_purged`/`headers_deleted` are always
    present in the admin_audit JSON (0 when nothing was touched), but are
    added to the RETURN value only when nonzero, keeping the return shape
    unchanged for every caller that never touches distribution.
    """
    where, params = _purge_scope_sql_params(plant, start, end, machines)
    sql = f"DELETE FROM orders WHERE {where} RETURNING {_PURGE_RETURNING}"
    ev = sched_events.EventCtx(source="purge", actor=user_email, action_id=sched_events.new_action_id())
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            cur.execute(sql, params)
            deleted_rows = _purge_deleted_rows(cur)
            ids = [r["id"] for r in deleted_rows]
            core = _purge_order_ids_on_cursor(
                cur, plant, ids, action="purge_by_date_range", user_email=user_email,
                deleted_rows=deleted_rows, ev=ev,
                extra_details={
                    "machines": list(machines or []),
                    "start": start.isoformat() if hasattr(start, "isoformat") else str(start),
                    "end": end.isoformat() if hasattr(end, "isoformat") else str(end),
                },
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    result = {"status": "ok", "deleted": core["deleted"], "plant": plant, "machines": list(machines or [])}
    if core["shares_purged"]:
        result["shares_purged"] = core["shares_purged"]
        result["headers_deleted"] = core["headers_deleted"]
    return result


def purge_orders_by_ids(plant: str, ids: list[str], *, user_email: str | None = None,
                        reason: str = "sap_snapshot_vanish", archive_batch_id: str | None = None,
                        extra_details: dict | None = None, conn=None,
                        event_source: str = "purge", ev=None) -> dict:
    """DELETE the given orders in one plant through the shared purge core
    (share retirement, orphan-header cleanup, admin_audit row with
    action=`reason`). Rows are locked FOR UPDATE first. When `archive_batch_id`
    is given, each order row, its schedule segments and its distribution shares
    are copied into `sap_stage_vanished_order` before the delete (30-day
    archive, restorable via `restore_vanished_order`).

    Pass `conn` to run inside the caller's transaction (nothing is committed
    here); otherwise a pool connection is opened, committed and closed.
    """
    ids = sorted({str(i) for i in (ids or [])})
    empty = {"status": "ok", "deleted": 0, "archived": 0, "shares_purged": 0, "headers_deleted": 0}
    if not ids:
        return empty

    def _run(c):
        with c.cursor() as cur:
            cur.execute(
                "SELECT id FROM orders WHERE plant = %s AND id = ANY(%s) ORDER BY id FOR UPDATE",
                (plant, ids),
            )
            locked = [r[0] for r in cur.fetchall()]
            if not locked:
                return empty
            archived = 0
            segs: dict | None = None
            if archive_batch_id is not None:
                cur.execute("SELECT row_to_json(o) FROM orders o WHERE o.id = ANY(%s) ORDER BY o.id", (locked,))
                rows = {r[0]["id"]: r[0] for r in cur.fetchall()}
                cur.execute(
                    "SELECT order_id, row_to_json(s) FROM order_schedule_segments s"
                    " WHERE order_id = ANY(%s)", (locked,))
                segs: dict = {}
                for oid, js in cur.fetchall():
                    segs.setdefault(oid, []).append(js)
                cur.execute(
                    "SELECT child_id, row_to_json(d) FROM order_distribution_share d"
                    " WHERE child_id = ANY(%s)", (locked,))
                shs: dict = {}
                for cid, js in cur.fetchall():
                    shs.setdefault(cid, []).append(js)
                for oid in locked:
                    cur.execute(
                        "INSERT INTO sap_stage_vanished_order"
                        " (batch_id, plant, order_id, order_row, segments, shares, deleted_by)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (archive_batch_id, plant, oid, Jsonb(rows.get(oid, {})),
                         Jsonb(segs.get(oid, [])), Jsonb(shs.get(oid, [])), user_email),
                    )
                    archived += 1
            cur.execute(f"DELETE FROM orders WHERE plant = %s AND id = ANY(%s) RETURNING {_PURGE_RETURNING}",
                        (plant, locked))
            deleted_rows = _purge_deleted_rows(cur)
            deleted_ids = [r["id"] for r in deleted_rows]
            details = {"archive_batch_id": archive_batch_id, **(extra_details or {})}
            run_ev = ev or sched_events.EventCtx(
                source=event_source, actor=user_email, action_id=sched_events.as_action_id(archive_batch_id))
            core = _purge_order_ids_on_cursor(
                cur, plant, deleted_ids, action=reason, user_email=user_email, extra_details=details,
                deleted_rows=deleted_rows, ev=run_ev, segs_by_id=segs)
            return {"status": "ok", "deleted": core["deleted"], "archived": archived,
                    "shares_purged": core["shares_purged"], "headers_deleted": core["headers_deleted"]}

    if conn is not None:
        return _run(conn)
    with _pool.connection() as c:
        try:
            out = _run(c)
            c.commit()
            return out
        except Exception:
            c.rollback()
            raise


def _restore_columns(cur, table: str, json_rows: list) -> list[str]:
    """Columns of `table` (information_schema) that appear as keys in the archived JSON rows --
    the explicit column list for a restore, so schema drift since the archive cannot break it."""
    keys: set = set()
    for r in json_rows:
        keys.update(r.keys())
    cur.execute("SELECT column_name FROM information_schema.columns"
                " WHERE table_schema = current_schema() AND table_name = %s ORDER BY ordinal_position", (table,))
    return [r[0] for r in cur.fetchall() if r[0] in keys]


def restore_vanished_order(archive_id: int, *, user_email: str | None = None) -> dict:
    """Restore one archived (vanish-deleted) order and its schedule segments.

    Raises KeyError when the archive row is missing or already restored, and
    ValueError("order_exists") when the order id is already live again (nothing is
    written and the archive row stays restorable).
    Distribution shares are NOT restored: a re-upload of the parent revives
    purged shares (D02, see `purge_orders_by_date`).
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            cur.execute(
                "SELECT plant, order_id, order_row, segments FROM sap_stage_vanished_order"
                " WHERE id = %s AND restored_at IS NULL FOR UPDATE", (archive_id,))
            row = cur.fetchone()
            if not row:
                raise KeyError(f"archive row {archive_id} not found or already restored")
            plant, order_id, order_row, segments = row
            # Explicit column lists (archived JSON keys that still exist as columns) so a column
            # added or dropped since the archive was written cannot break the restore.
            order_cols = _restore_columns(cur, "orders", [order_row] if isinstance(order_row, dict) else [])
            cur.execute(
                sql.SQL("INSERT INTO orders ({c}) SELECT {c} FROM json_populate_record(NULL::orders, %s::json)"
                         " ON CONFLICT (id) DO NOTHING").format(
                    c=sql.SQL(", ").join(sql.Identifier(x) for x in order_cols)),
                (Jsonb(order_row),))
            restored = cur.rowcount > 0
            if not restored:
                # A4: the id is live again; burning the archive row would make the
                # archived schedule unrestorable while the live order has none.
                raise ValueError("order_exists")
            if segments:
                seg_cols = _restore_columns(cur, "order_schedule_segments",
                                            [s for s in segments if isinstance(s, dict)])
                if seg_cols:
                    cur.execute(
                        sql.SQL("INSERT INTO order_schedule_segments ({c}) SELECT {c}"
                                 " FROM json_populate_recordset(NULL::order_schedule_segments, %s::json)"
                                 " ON CONFLICT DO NOTHING").format(
                            c=sql.SQL(", ").join(sql.Identifier(x) for x in seg_cols)),
                        (Jsonb(segments),))
            cur.execute(
                "UPDATE sap_stage_vanished_order SET restored_at = now(), restored_by = %s WHERE id = %s",
                (user_email, archive_id))
            cur.execute(
                "INSERT INTO admin_audit (table_name, action, details, user_email)"
                " VALUES ('orders', 'sap_vanish_restore', %s, %s)",
                (Jsonb({"plant": plant, "order_id": order_id, "archive_id": archive_id,
                        "restored": restored}), user_email))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"status": "ok", "order_id": order_id, "restored": restored}


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
                    -- a planner placement is either stored edge (U10): a finish-only row counts too
                    COUNT(*) FILTER (WHERE scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL) AS user_overrides
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
                    MAX(COALESCE(scheduled_end, original_finish_received, basic_finish_date)) AS max_date
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


def get_schedule_event_stats() -> dict:
    """Row count and oldest/newest `at` of schedule_event; nulls when the table is missing or unreachable."""
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*), min(at), max(at) FROM schedule_event")
            n, lo, hi = cur.fetchone()
        return {"rows": int(n), "oldest_at": lo.isoformat() if lo else None,
                "newest_at": hi.isoformat() if hi else None}
    except Exception:
        return {"rows": None, "oldest_at": None, "newest_at": None}


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
            conn.execute(sql.SQL("VACUUM ANALYZE {}").format(sql.Identifier(t)))
            results[t] = "ok"
    return {"results": results}


def run_analyze(table: str) -> dict:
    """ANALYZE one table to refresh query planner statistics. Safe, non-locking."""
    allowed = _get_maint_table_allowlist()
    if table not in allowed:
        raise ValueError(f"Unknown table: {table}")
    with psycopg.connect(CONN_STR, autocommit=True) as conn:
        conn.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(table)))
    return {"table": table, "status": "ok"}


# =========================
# INGESTION
# =========================
def _norm_pv(value) -> str | None:
    """Padding-insensitive production-version form ('1' == '0001' == ' 0001 '):
    zero-padding is only applied on routing-enabled plants, so switching routing
    on must not turn a stored '1' into an "SAP changed it". Blank stays ''."""
    if value is None:
        return None
    s = str(value).strip().upper()
    return s.zfill(4) if s else s


def _norm_pv_sql(expr: str) -> str:
    """SQL twin of _norm_pv for the skip-unchanged / PV-wins comparisons."""
    return (f"(CASE WHEN COALESCE({expr}, '') = '' THEN {expr} "
            f"WHEN length(btrim({expr})) >= 4 THEN upper(btrim({expr})) "
            f"ELSE lpad(upper(btrim({expr})), 4, '0') END)")


# The material default PV fill used by `_stamp_order_attributes`: padded to the 4-char master form on a
# routing-enabled plant (same expression as the upload padding), left as stored elsewhere. Without this a
# stamped default lands as '1' and never matches the padded `production_version` row.
_DEFAULT_PV_FILL_SQL = (
    "(CASE WHEN EXISTS (SELECT 1 FROM plants pl WHERE pl.plant = o.plant AND pl.routing_runtime_enabled = TRUE) "
    f"THEN {_norm_pv_sql('mp.default_production_version')} ELSE mp.default_production_version END)"
)


def _naive_dt(value):
    """Normalise an incoming date to a naive datetime (the shape the DB returns and
    change detection compares against): ISO strings (the SAP-sync path), pandas
    Timestamps and tz-aware values all collapse to a naive wall-clock datetime.
    None and anything unparseable stay None / unchanged respectively."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.replace(tzinfo=None)
    return value


def _frame_zone(name: str | None):
    """IANA name -> ZoneInfo, or None when blank/unknown (no conversion)."""
    if not name:
        return None
    try:
        return ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def finish_echoes(incoming_finish_plant_local: datetime | None, incoming_date_only: bool,
                  sent_finish_plant_local: datetime | None, sap_tz: str | None,
                  plant_tz: str | None) -> bool:
    """True when SAP's incoming finish is the finish NIMBUS last sent, judged in the SAP frame.

    The one echo rule (backward-scheduling Task 1.2); `sap_changed_fields` and the locked
    `original_*_received` columns both use it, and `backend/integration/sap_staging.py` re-exports it.
    Both finishes are naive plant-local values; the SAP frame is `sap_tz`.
      - date_only (SAP sent no time, which the staging parser keeps at plant-local midnight WITHOUT zone
        conversion): the incoming date already IS the SAP date, so compare it with the SAP-frame calendar
        date of the sent value (19:00 Chicago = 00:00 UTC the next day, so a date-only echo of that send
        carries the next day's date).
      - timed: convert both to the SAP frame and compare to the minute.
    An unknown or blank `sap_tz` (the Excel path has no SAP zone of its own) means the SAP frame is the
    plant's frame; an unknown `plant_tz` means no conversion (both values are read as the same frame).
    A missing incoming or sent finish never echoes.
    """
    inc, sent = _naive_dt(incoming_finish_plant_local), _naive_dt(sent_finish_plant_local)
    if not isinstance(inc, datetime) or not isinstance(sent, datetime):
        return False
    plant_zone = _frame_zone(plant_tz)
    sap_zone = _frame_zone(sap_tz) or plant_zone

    def to_sap(v: datetime) -> datetime:
        if plant_zone is None or sap_zone is None:
            return v
        return v.replace(tzinfo=plant_zone).astimezone(sap_zone).replace(tzinfo=None)

    sent_sap = to_sap(sent)
    if incoming_date_only:
        return inc.date() == sent_sap.date()
    return (to_sap(inc).replace(second=0, microsecond=0)
            == sent_sap.replace(second=0, microsecond=0))


def _row_finish_echo(before: dict, row: dict, sap_tz: str | None, *,
                     finish_key: str = "basic_finish_date") -> bool:
    """True when `row`'s finish is an echo of the finish NIMBUS last sent for `before`'s order.

    The one row-level echo decision (`sap_changed_fields`, `_patch_locked_originals` and the distribution
    writers all call it): `before["sap_sent_finish"]` is the remembered sent finish (no sent row = never an
    echo), `row[finish_key]` the SAP finish just received (an ingest row carries it as
    `sap_basic_finish_date`; `sap_changed_fields`' `incoming` dict as `basic_finish_date`), and
    `row["_finish_date_only"]` says SAP sent no time (the staging parser sets it). A row with no such flag
    (the Excel path cannot tell a date-only cell from an exact midnight) is date only when the finish is at
    exactly 00:00:00. `sap_tz=None` means the SAP frame is the plant's frame (`before["tz"]`)."""
    sent_f = before.get("sap_sent_finish") if before else None
    if sent_f is None:
        return False
    in_f = row.get(finish_key)
    date_only = row.get("_finish_date_only")
    if date_only is None:
        n = _naive_dt(in_f)
        date_only = isinstance(n, datetime) and n.time() == dt_time.min
    return finish_echoes(in_f, bool(date_only), sent_f, sap_tz, before.get("tz"))


def sap_changed_fields(before: dict, incoming: dict, current_machine_wc: str | None, *,
                       sap_tz: str | None = None) -> set[str]:
    """Which SAP-owned fields did this upload change vs SAP's previous upload?

    Pure (no DB). `before` is the stored orders row (SAP baselines
    `sap_basic_finish_date`/`sap_workcenter`/`sap_production_version`, plus
    `order_quantity`, `production_version`, `scheduled_end`); `incoming` is the
    parsed upload row. A field counts as changed only when its baseline is non-NULL,
    the incoming value differs from it, and the incoming value is not an echo of
    NIMBUS's own current value (SAP sending back what a planner set). An incoming
    None means "column/cell not sent or unparseable" and is never a change for that
    field; an incoming "" (blank cell present) is a real value. `dates` is judged
    on the finish alone: a start-only change is never "dates" (the placement keeps).
    Returns a subset
    of {"dates", "workcenter", "quantity", "production_version"}.

    Quantity (A3): judged on the TOTAL (`planned_order_initial_quantity`) when the
    incoming row carries it, else on `order_quantity`; a partial conversion that only
    shrinks the open quantity is not a change.

    Echo suppression (D20): when `before["sap_sent_finish"]` is set and the
    incoming finish is an echo of it (`finish_echoes`, judged in the SAP frame:
    `sap_tz` is the SAP system zone, `before["tz"]` the plant zone; a date-only
    finish compares the SAP-frame date of the sent value, a timed one compares
    to the minute), "dates" is not reported; the
    version is likewise not a change when `sap_sent_version` is unset or equals
    the incoming version. A different version than was sent still reports
    "production_version" (dates stay suppressed by the matching finish).
    `incoming["_finish_date_only"]` says SAP sent no time (the staging parser
    sets it); when absent, a finish at exactly 00:00:00 is treated as date only
    (the Excel path cannot tell the two apart). `sap_tz=None` means the SAP frame
    is the plant's frame.
    The sent values are NOT cleared by a planner edit (D20 refinement); only the
    next Send to SAP overwrites them, so an old echo cannot wipe a newer planner edit
    unless the planner's edit happens to produce the very finish that was sent.
    """
    changed: set[str] = set()

    # dates: the FINISH decides (backward scheduling OQ25 c, Task 2.7). A start-only SAP change keeps the
    # placement, because the planner's placed finish is the anchor and the start is derived from it; the
    # finish changing (baseline non-NULL and differing) counts unless it echoes NIMBUS's own placed finish.
    # The incoming start is not read here on purpose: it never decides, and may not even be sent.
    base_f = before.get("sap_basic_finish_date")
    in_f = incoming.get("basic_finish_date")
    sched_e = before.get("scheduled_end")
    dates_differ = base_f is not None and in_f is not None and in_f != base_f
    dates_echo = sched_e is not None and in_f == sched_e

    # D20 echo suppression: NIMBUS remembers the finish/version it last sent to
    # SAP (side table order_sap_sent, joined into the before-image). SAP echoing that finish back is not an SAP change
    # even when SAP back-scheduled the start; the new SAP baselines are still
    # written by the upsert. Only a finish, version or work center that differs
    # from what was sent re-plans the order.
    sent_v = before.get("sap_sent_version")
    finish_echo = _row_finish_echo(before, incoming, sap_tz)
    in_pv_raw = incoming.get("sap_production_version")
    # An incoming version of None means "column not sent": it cannot contradict.
    version_echo = finish_echo and (sent_v is None or in_pv_raw is None
                                    or _norm_pv(in_pv_raw) == _norm_pv(sent_v))

    if dates_differ and not dates_echo and not finish_echo:
        changed.add("dates")

    base_wc = before.get("sap_workcenter")
    in_wc = incoming.get("sap_workcenter")
    if (base_wc is not None and in_wc is not None and in_wc != base_wc
            and in_wc != current_machine_wc and in_wc != before.get("machine")):
        changed.add("workcenter")

    def _q(v):
        return None if v is None else Decimal(str(v)).quantize(Decimal("0.001"))
    # A3: when the incoming row carries the TOTAL (SAP planned orders: gsmng as
    # planned_order_initial_quantity), judge the change on the total -- a partial
    # conversion shrinks only the OPEN quantity and must not unschedule the order.
    # Rows without a total (Excel) keep the order_quantity comparison.
    in_total = _q(incoming.get("planned_order_initial_quantity"))
    if in_total is not None:
        base_q = _q(before.get("planned_order_initial_quantity"))
        in_q = in_total
    else:
        base_q = _q(before.get("order_quantity"))
        in_q = _q(incoming.get("order_quantity"))
    if base_q is not None and in_q is not None and in_q != base_q:
        changed.add("quantity")

    # production version: child sub-orders carry none of their own.
    base_pv = before.get("sap_production_version")
    if (base_pv is not None and incoming.get("sap_production_version") is not None
            and not incoming.get("parent_production_order") and not version_echo):
        in_pv = _norm_pv(incoming["sap_production_version"])
        cur_pv = _norm_pv(before.get("production_version") or "")
        if in_pv != _norm_pv(base_pv) and in_pv != cur_pv:
            changed.add("production_version")

    return changed


# Routing-enabled plant test for the row being upserted (the plant may be omitted
# from the file, hence the COALESCE against the stored plant).
_ROUTING_PLANT_SQL = """EXISTS (
            SELECT 1 FROM plants rp
             WHERE rp.plant = COALESCE(EXCLUDED.plant, orders.plant)
               AND rp.routing_runtime_enabled = TRUE)"""

# H7 (SAP wins on the WORK CENTER, not the exact machine): an ordinary order
# keeps the planner's machine (1) whenever what SAP sent in the work center /
# machine field is the same as SAP sent last time (the machine follows SAP only
# when that field CHANGED -- a benign write such as a description change must
# not revert a planner's move, name feeds included), or (2) whenever that
# machine belongs to the work center SAP just sent; otherwise (new work center,
# or SAP sent a different machine name) the incoming machine wins. Children
# (parent link set) always take the incoming machine. The plant / machine_key
# CASEs below compare against this SAME resolved expression, never against the
# raw EXCLUDED.machine.
_RESOLVED_MACHINE_SQL = """CASE
            WHEN EXCLUDED.parent_production_order IS NULL
             AND orders.machine IS NOT NULL
             AND orders.sap_workcenter IS NOT NULL
             AND orders.sap_workcenter IS NOT DISTINCT FROM EXCLUDED.sap_workcenter
             AND EXISTS (SELECT 1 FROM machine km
                          WHERE km.plant = COALESCE(EXCLUDED.plant, orders.plant)
                            AND km.machine = orders.machine)
            THEN orders.machine
            WHEN EXCLUDED.parent_production_order IS NULL
             AND EXISTS (SELECT 1 FROM machine m
                          WHERE m.plant = COALESCE(EXCLUDED.plant, orders.plant)
                            AND m.machine = orders.machine
                            AND m.sap_workcenter = EXCLUDED.sap_workcenter)
            THEN orders.machine ELSE EXCLUDED.machine END"""

# "SAP sent something different" (D15/P12): every SAP-owned column the upload
# carries EXCEPT the ones re-stamped from master data (color, prt_01/prt_02,
# production_version), upload_batch_id, updated_at and machine. SAP's dates are
# compared against the stored SAP baseline (never basic_*, which a planner move
# can change). A NULL incoming baseline value means "not sent"
# and a NULL stored baseline means "unknown": neither is a difference here.
_SAP_DIFFERS_SQL = f"""(
           orders.production_order IS DISTINCT FROM EXCLUDED.production_order
        OR orders.material_number IS DISTINCT FROM EXCLUDED.material_number
        OR orders.material_description IS DISTINCT FROM EXCLUDED.material_description
        OR orders.order_quantity IS DISTINCT FROM EXCLUDED.order_quantity
        OR orders.form_size IS DISTINCT FROM EXCLUDED.form_size
        OR orders.firming_indicator IS DISTINCT FROM EXCLUDED.firming_indicator
        OR orders.planned_order_initial_quantity IS DISTINCT FROM EXCLUDED.planned_order_initial_quantity
        OR orders.reduced_quantity IS DISTINCT FROM EXCLUDED.reduced_quantity
        OR orders.order_category IS DISTINCT FROM EXCLUDED.order_category
        OR orders.order_type IS DISTINCT FROM EXCLUDED.order_type
        OR orders.bom_alternative IS DISTINCT FROM EXCLUDED.bom_alternative
        OR orders.bom_usage IS DISTINCT FROM EXCLUDED.bom_usage
        OR orders.labor_hours IS DISTINCT FROM EXCLUDED.labor_hours
        OR orders.machine_hours IS DISTINCT FROM EXCLUDED.machine_hours
        OR orders.no_of_fte IS DISTINCT FROM EXCLUDED.no_of_fte
        OR orders.parent_production_order IS DISTINCT FROM EXCLUDED.parent_production_order
        OR orders.distribution_letter IS DISTINCT FROM EXCLUDED.distribution_letter
        OR (EXCLUDED.plant IS NOT NULL AND EXCLUDED.plant IS DISTINCT FROM orders.plant)
        OR (NOT {_ROUTING_PLANT_SQL}
            AND EXCLUDED.run_time IS DISTINCT FROM orders.run_time)
        OR (orders.sap_basic_start_date IS NOT NULL AND EXCLUDED.sap_basic_start_date IS NOT NULL
            AND orders.sap_basic_start_date IS DISTINCT FROM EXCLUDED.sap_basic_start_date)
        OR (orders.sap_basic_finish_date IS NOT NULL AND EXCLUDED.sap_basic_finish_date IS NOT NULL
            AND orders.sap_basic_finish_date IS DISTINCT FROM EXCLUDED.sap_basic_finish_date)
        OR (orders.sap_workcenter IS NOT NULL AND EXCLUDED.sap_workcenter IS NOT NULL
            AND orders.sap_workcenter IS DISTINCT FROM EXCLUDED.sap_workcenter)
        OR (orders.sap_production_version IS NOT NULL AND EXCLUDED.sap_production_version IS NOT NULL
            AND {_norm_pv_sql('orders.sap_production_version')}
                IS DISTINCT FROM {_norm_pv_sql('EXCLUDED.sap_production_version')})
    )"""

# A row whose SAP baseline is still unknown (NULL, e.g. the first upload after
# the baseline columns shipped) is written once so the baseline gets recorded,
# but that is NOT "SAP changed it" (no reset, manual run time kept).
_SAP_BASELINE_FILL_SQL = """(
           (orders.sap_basic_start_date IS NULL AND EXCLUDED.sap_basic_start_date IS NOT NULL)
        OR (orders.sap_basic_finish_date IS NULL AND EXCLUDED.sap_basic_finish_date IS NOT NULL)
        OR (orders.sap_workcenter IS NULL AND EXCLUDED.sap_workcenter IS NOT NULL)
        OR (orders.sap_production_version IS NULL AND EXCLUDED.sap_production_version IS NOT NULL)
    )"""

# Routing-plant run time as an upload would leave it: SAP's value is nulled
# before the write, so the stored value is kept until the post-upload resolve
# re-derives it (a 'manual' source is dropped separately, see run_time_source).
_RUN_TIME_AFTER_UPLOAD_SQL = f"""(CASE
            WHEN NOT {_ROUTING_PLANT_SQL} THEN EXCLUDED.run_time
            ELSE COALESCE(EXCLUDED.run_time, orders.run_time)
        END)"""

_UPSERT_SQL = f"""
    INSERT INTO orders (
        id, production_order, material_number, material_description,
        machine, plant, basic_start_date, basic_finish_date,
        run_time, color, prt_01, prt_02, production_version,
        order_quantity, form_size, firming_indicator,
        planned_order_initial_quantity, reduced_quantity, order_category, order_type,
        bom_alternative, bom_usage, labor_hours, machine_hours, no_of_fte,
        parent_production_order, distribution_letter,
        sap_workcenter, sap_production_version, sap_basic_start_date, sap_basic_finish_date,
        upload_batch_id, original_start_received, original_finish_received, updated_at
    )
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
    ON CONFLICT (id) DO UPDATE SET
        production_order      = EXCLUDED.production_order,
        material_number       = EXCLUDED.material_number,
        material_description  = EXCLUDED.material_description,
        machine                = {_RESOLVED_MACHINE_SQL},
        -- Plant: an explicitly uploaded plant always wins; otherwise, if the MACHINE
        -- changed on this re-upload, reset to NULL so the post-upsert derivation
        -- re-resolves it from the NEW machine (matches the old join's self-healing);
        -- otherwise keep the existing (already-derived) plant.
        plant                 = CASE
            WHEN EXCLUDED.plant IS NOT NULL THEN EXCLUDED.plant
            WHEN ({_RESOLVED_MACHINE_SQL}) IS DISTINCT FROM orders.machine THEN NULL
            ELSE orders.plant
        END,
        -- machine_key has no EXCLUDED counterpart (it's derived, never uploaded), so unlike
        -- plant it never gets a "trust the new explicit value" branch — just reset to
        -- NULL on either input actually changing, else keep. The post-upsert backfill
        -- below re-derives it. Plant-changed check is NULL-safe (EXCLUDED.plant IS NOT
        -- NULL guard) so a plain re-upload with no WERKS/PLANT column doesn't null it.
        machine_key            = CASE
            WHEN ({_RESOLVED_MACHINE_SQL}) IS DISTINCT FROM orders.machine THEN NULL
            WHEN EXCLUDED.plant IS NOT NULL AND EXCLUDED.plant IS DISTINCT FROM orders.plant THEN NULL
            ELSE orders.machine_key
        END,
        -- The start is optional (backward scheduling Task 2.7): an incoming NULL means "not sent" and
        -- never erases a stored start (the finish below is required, so it is always written).
        basic_start_date      = COALESCE(EXCLUDED.basic_start_date, orders.basic_start_date),
        basic_finish_date     = EXCLUDED.basic_finish_date,
        -- SAP baselines: the last SAP-sent values, written ONLY here (and by
        -- distribution's child upsert). An incoming NULL means "not sent" and
        -- never erases a stored baseline.
        sap_workcenter        = COALESCE(EXCLUDED.sap_workcenter, orders.sap_workcenter),
        sap_production_version = COALESCE(EXCLUDED.sap_production_version, orders.sap_production_version),
        sap_basic_start_date  = COALESCE(EXCLUDED.sap_basic_start_date, orders.sap_basic_start_date),
        sap_basic_finish_date = COALESCE(EXCLUDED.sap_basic_finish_date, orders.sap_basic_finish_date),
        -- Locked "as SAP first sent it" dates (never moved by a planner or a drag).
        -- The row tuple already carries the STORED values on an echo of NIMBUS's own sent finish and the
        -- incoming SAP dates otherwise (upsert_orders decides, one rule: finish_echoes), so this SET never
        -- reads EXCLUDED.basic_*: a NULL (not decided) keeps what is stored.
        original_start_received  = COALESCE(EXCLUDED.original_start_received, orders.original_start_received),
        original_finish_received = COALESCE(EXCLUDED.original_finish_received, orders.original_finish_received),
        -- Ingest itself no longer flags this on every re-upload regardless of
        -- whether the value moved (ROUTING_RUNTIME_DESIGN.md §4 item 6) — plain
        -- carry-forward. Only the resolver (backend/routing/resolver.py) is
        -- allowed to set this flag now, and only when the number it writes
        -- actually differs from what's stored.
        runtime_schedule_mismatch = CASE
            -- Any PLACED order (a stored start, a stored finish, or segments: the _PLACED_SQL
            -- meaning, written here against the `orders` table name) whose effective run time
            -- actually moves is flagged: its stored bar no longer matches its run time, and the
            -- browser, not the server, re-derives the start from the held finish (backward
            -- scheduling OQ34). This was children-only (H10/D33: the ingest writes children
            -- through THIS statement before distribution's own child upsert runs, whose identical
            -- CASE would then see no change); the general rule subsumes that case.
            WHEN {_RUN_TIME_AFTER_UPLOAD_SQL} IS DISTINCT FROM orders.run_time
                 AND (orders.scheduled_start IS NOT NULL
                      OR orders.scheduled_end IS NOT NULL
                      OR EXISTS (SELECT 1 FROM order_schedule_segments g WHERE g.order_id = orders.id))
            THEN TRUE
            ELSE COALESCE(orders.runtime_schedule_mismatch, FALSE) END,
        -- Routing plants: upsert_orders nulls the file's run_time before this
        -- write, so EXCLUDED.run_time is NULL and COALESCE keeps the stored
        -- value until the post-upload resolve re-derives it. A planner-keyed
        -- ('manual') run time lasts until SAP next updates the order: this
        -- statement only runs for a row whose SAP data actually differs (see
        -- the WHERE below), and then run_time_source drops back to NULL so the
        -- resolver recalculates it from the incoming production version. A row
        -- written only to record the SAP baseline keeps its manual run time.
        -- The arms apply ONLY to routing-enabled plants; a disabled plant (even
        -- one holding a leftover 'manual' row) takes the file's value as before.
        run_time              = {_RUN_TIME_AFTER_UPLOAD_SQL},
        run_time_source       = CASE
            WHEN orders.run_time_source = 'manual'
             AND {_ROUTING_PLANT_SQL}
             AND {_SAP_DIFFERS_SQL}
            THEN NULL
            ELSE orders.run_time_source END,
        color                 = EXCLUDED.color,
        -- prt_01/prt_02/production_version: written from the uploaded row like color
        -- (NULL today — no upload source carries them yet), then overwritten for
        -- matched materials by the post-upsert db._stamp_order_attributes call, which
        -- always runs last and wins (mirrors the existing color/SAP precedence, R5 in
        -- docs/scheduling_priority.md).
        prt_01                = EXCLUDED.prt_01,
        prt_02                = EXCLUDED.prt_02,
        -- Production version: the planner's choice survives unless SAP's OWN
        -- production version changed since SAP's previous upload (then SAP wins;
        -- a blank SAP value becomes NULL and the material default fills it in
        -- _stamp_order_attributes). Distribution children carry none of their
        -- own. A blank stored version takes whatever SAP sent.
        production_version    = CASE
            WHEN EXCLUDED.parent_production_order IS NULL
             AND orders.sap_production_version IS NOT NULL
             AND EXCLUDED.sap_production_version IS NOT NULL
             AND {_norm_pv_sql('EXCLUDED.sap_production_version')}
                 IS DISTINCT FROM {_norm_pv_sql('orders.sap_production_version')}
            THEN NULLIF(EXCLUDED.production_version, '')
            ELSE COALESCE(NULLIF(orders.production_version, ''), NULLIF(EXCLUDED.production_version, ''))
        END,
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
        -- Parent link + letter: plain overwrite (NOT coalesce). Distribution's
        -- planned child rows carry them; every ordinary row sends NULL, so an
        -- order whose header was purged is no longer machine-locked forever.
        parent_production_order         = EXCLUDED.parent_production_order,
        distribution_letter             = EXCLUDED.distribution_letter,
        upload_batch_id       = EXCLUDED.upload_batch_id,
        updated_at            = NOW()
    -- Skip unchanged rows (D15/P12): an upload that sends nothing different from
    -- what SAP sent last time writes nothing (xmin, slot, firm, manual run time
    -- all untouched) and RETURNs no row.
    WHERE {_SAP_DIFFERS_SQL} OR {_SAP_BASELINE_FILL_SQL}
    RETURNING id, (xmax = 0) AS inserted
"""
# Deliberately NOT in the UPDATE SET: scheduled_start, scheduled_end.
# That's the whole point — user drag/drop edits survive a re-upload (unless the
# locked reset in upsert_orders decides SAP changed the order).

# A1: columns only the Excel upload carries. A SAP planned-order row never has
# them (they arrive NULL), so the SAP-sourced statement keeps the stored value
# (COALESCE in the SET) and only counts a NON-NULL differing incoming value as
# "SAP changed it" (no blanking, no xmin churn on every Excel-loaded order).
# The Excel statement (`_UPSERT_SQL`) keeps its exact semantics.
_EXCEL_ONLY_COLS = ("material_description", "form_size", "order_category", "order_type",
                    "labor_hours", "machine_hours", "no_of_fte")


def _sap_source_sql(text: str) -> str:
    for c in _EXCEL_ONLY_COLS:
        text = text.replace(
            f"orders.{c} IS DISTINCT FROM EXCLUDED.{c}",
            f"(EXCLUDED.{c} IS NOT NULL AND orders.{c} IS DISTINCT FROM EXCLUDED.{c})")
        text = re.sub(rf"(?m)^(\s+){c}(\s*)= EXCLUDED\.{c},$",
                      rf"\g<1>{c}\g<2>= COALESCE(EXCLUDED.{c}, orders.{c}),", text)
    return text


_SAP_DIFFERS_SQL_SAP = _sap_source_sql(_SAP_DIFFERS_SQL)
_UPSERT_SQL_SAP = _sap_source_sql(_UPSERT_SQL)


# Build the per-row tuple in the exact _UPSERT_SQL column order. The SQL VALUES
# clause expects: id, production_order, material_number, material_description,
# machine, plant, basic_start_date, basic_finish_date, run_time, color,
# prt_01, prt_02, production_version, order_quantity, form_size, firming_indicator,
# planned_order_initial_quantity, reduced_quantity, order_category, order_type,
# bom_alternative, bom_usage, labor_hours, machine_hours, no_of_fte,
# parent_production_order, distribution_letter, sap_workcenter,
# sap_production_version, sap_basic_start_date, sap_basic_finish_date, upload_batch_id,
# original_start_received, original_finish_received (the last two are patched per chunk).
_UPSERT_ROW_COLS = (
    "production_order", "material_number", "material_description",
    "machine", "plant", "basic_start_date", "basic_finish_date",
    "run_time", "color", "prt_01", "prt_02", "production_version",
    "order_quantity", "form_size", "firming_indicator",
    "planned_order_initial_quantity", "reduced_quantity", "order_category", "order_type",
    "bom_alternative", "bom_usage", "labor_hours", "machine_hours", "no_of_fte",
    "parent_production_order", "distribution_letter",
    "sap_workcenter", "sap_production_version", "sap_basic_start_date", "sap_basic_finish_date",
)


_STAMP_PV_SQL = f"COALESCE(NULLIF(o.production_version, ''), {_DEFAULT_PV_FILL_SQL})"


def _stamp_run(cur, scope_sql: str, params: tuple, ev, skip_event_ids=None) -> int:
    """The Seam 2 UPDATE for one scope. Only rows whose color / PRT / production version would actually
    change are written (IS DISTINCT FROM guard: an unchanged row keeps its xmin and writes no history).
    With `ev`, the changed rows' tracked before/after (self-join `b` = the pre-update image, PG16-safe) go to
    schedule_event as `master_data_stamp` modify rows. `skip_event_ids` (orders that received a `create` row in
    this same batch) are still stamped but get no event row: the defaults are master-data derived, and the
    `create` row already records the order."""
    cur.execute(
        f"""
        UPDATE orders o
           SET color              = mp.color,
               prt_01             = mp.prt_01,
               prt_02             = mp.prt_02,
               production_version = {_STAMP_PV_SQL},
               updated_at         = NOW()
          FROM material_plants mp, orders b
         WHERE mp.plant = o.plant
           AND mp.material_id = o.material_number
           AND b.id = o.id
           AND {scope_sql}
           AND (o.color IS DISTINCT FROM mp.color
                OR o.prt_01 IS DISTINCT FROM mp.prt_01
                OR o.prt_02 IS DISTINCT FROM mp.prt_02
                OR o.production_version IS DISTINCT FROM {_STAMP_PV_SQL})
        RETURNING o.id, o.plant, o.production_order, o.material_number,
                  b.prt_01, b.prt_02, b.production_version,
                  o.prt_01, o.prt_02, o.production_version
        """,
        params,
    )
    if ev is None:
        return 0
    returned = cur.fetchall()
    rows = []
    skip = set(skip_event_ids or ())
    for r in returned:
        if r[0] in skip:
            continue
        changes = sched_events.diff_tracked(
            {"prt_01": r[4], "prt_02": r[5], "production_version": r[6]},
            {"prt_01": r[7], "prt_02": r[8], "production_version": r[9]})
        if changes:
            rows.append(sched_events.EventRow(
                plant=r[1] or "", order_id=r[0], production_order=r[2], material_number=r[3],
                op="modify", changes=changes, source="master_data_stamp"))
    return sched_events.record(cur, ev, rows)


def _stamp_order_attributes(conn, *, batch_id: str | None = None, plant: str | None = None,
                            ids: list[str] | None = None,
                            report_ids: list[str] | None = None, ev=None, skip_event_ids=None) -> dict:
    """Seam 2 (docs/scheduling_priority.md): the ONE place attribute provenance
    lives for color/prt_01/prt_02/production_version. One UPDATE orders ... FROM
    material_plants keyed (plant, material_number = material_id), scoped either
    to a list of order ids (ids — called post-upsert from upsert_orders with the
    rows the upload actually wrote), to a single ingest batch (batch_id), or to
    a whole plant (plant — called from POST /master-data/resync-order-attributes).
    With `ids`, the missing-master-data exception report covers `report_ids`
    (default: `ids`) so an upload whose rows were all skipped as unchanged still
    reports every incoming row.

    Must run AFTER orders.plant is derived, since it reads the derived value —
    callers scoped by batch_id must call this after the plant/machine_key backfill,
    not before. Runs LAST and wins over anything sap_field_map ever maps to
    orders.color (R5): sap_sync shares this same upsert_orders path. When PRT_02
    moves from a single TEXT value to a production-version-keyed table, this
    query is the only thing that changes.

    Does not commit — the caller controls the transaction boundary. `ev` (a schedule_event EventCtx, default
    None = record nothing) logs each row whose PRT / production version really changed as a
    `master_data_stamp` modify row.

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
    if batch_id is None and plant is None and ids is None:
        raise ValueError("_stamp_order_attributes requires ids, batch_id or plant")

    with conn.cursor() as cur:
        if ids is not None:
            ids = sorted(set(ids))
            if ids:
                _stamp_run(cur, "o.id = ANY(%s)", (ids,), ev, skip_event_ids)
            report = sorted(set(report_ids)) if report_ids is not None else ids
            cur.execute(
                """
                SELECT o.plant, o.material_number, COUNT(*),
                       CASE WHEN o.plant IS NULL THEN 'no_plant_derived' ELSE 'no_mp_row' END
                  FROM orders o
                  LEFT JOIN material_plants mp
                    ON mp.plant = o.plant AND mp.material_id = o.material_number
                 WHERE o.id = ANY(%s)
                   AND mp.material_id IS NULL
                 GROUP BY o.plant, o.material_number
                """,
                (report,),
            )
        elif batch_id is not None:
            _stamp_run(cur, "o.upload_batch_id = %s", (batch_id,), ev)
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
            _stamp_run(cur, "o.plant = %s", (plant,), ev)
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


def resync_order_attributes(plant: str, *, actor: str | None = None) -> dict:
    """Public entry point for POST /master-data/resync-order-attributes — the
    real mechanism the ingest-time stamp is convenience for (R3). Opens its
    own connection/commit so brain.py never has to reach into the private
    connection pool directly, matching every other db.py public function."""
    ev = sched_events.EventCtx(source="master_data_stamp", actor=actor or "system",
                               action_id=sched_events.new_action_id())
    with _pool.connection() as conn:
        result = _stamp_order_attributes(conn, plant=plant, ev=ev)
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
        # PV - Machine (routing-enabled plants only): a production version whose header work center is
        # blank offers no machine (`pv_workcenter_missing`), and one whose header work center has no
        # non-deleted routing operation in the PV's own routing offers no run time
        # (`pv_workcenter_no_operation`). One row per (material, PV) with the orders currently carrying
        # that PV, so the panel counts and displays them like a missing material-plant row.
        cur.execute("SELECT routing_runtime_enabled FROM plants WHERE plant = %s", (plant,))
        plant_row = cur.fetchone()
        pv_rows: list = []
        if plant_row is not None and plant_row[0]:
            cur.execute(
                """
                SELECT plant, material_number, production_version, reason, COUNT(*)
                  FROM (
                        SELECT o.plant, o.material_number, o.production_version,
                               CASE WHEN COALESCE(btrim(pv.sap_workcenter), '') = ''
                                    THEN 'pv_workcenter_missing'
                                    ELSE 'pv_workcenter_no_operation' END AS reason
                          FROM orders o
                          JOIN production_version pv
                            ON pv.plant = o.plant
                           AND pv.material_id = o.material_number
                           AND pv.production_version = o.production_version
                         WHERE o.plant = %s
                           AND (COALESCE(btrim(pv.sap_workcenter), '') = ''
                                OR NOT EXISTS (
                                    SELECT 1 FROM routing_operation ro
                                     WHERE ro.plant = pv.plant
                                       AND ro.material_id = pv.material_id
                                       AND ro.task_list_type = pv.task_list_type
                                       AND ro.routing_group = pv.routing_group
                                       AND ro.group_counter = pv.group_counter
                                       AND ro.sap_workcenter = pv.sap_workcenter
                                       AND NOT ro.deleted))
                       ) x
                 GROUP BY plant, material_number, production_version, reason
                 ORDER BY material_number, production_version
                """,
                (plant,),
            )
            pv_rows = cur.fetchall()
    exceptions = [
        {"plant": r[0], "material_number": r[1], "order_count": r[2], "reason": r[3]}
        for r in rows
    ] + [
        {"plant": r[0], "material_number": r[1], "production_version": r[2], "reason": r[3],
         "order_count": r[4]}
        for r in pv_rows
    ]
    return {
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(e["order_count"] for e in exceptions),
        "exceptions": exceptions,
    }


# Rows per upsert transaction (module-level so tests can shrink it to exercise
# chunk boundaries).
_UPSERT_CHUNK = 500

# Step (a) of the per-chunk reset: ONE statement that row-locks, ORDER BY id,
# every row the chunk may write (its own ids) plus, for any distribution child
# among them, every sibling (same plant + parent order + material) that a
# reset may have to reach -- and reads the "before" image the SAP-change
# detection and the running-order check need, plus each row's current
# machine's work center. Locking a superset up front is what keeps this
# ordering identical to /tasks saves and distribution (id order, all before any
# write), so the three can never hold a pair of rows in opposite order.
_CHUNK_READ_COLS = (
    "id", "plant", "parent_production_order", "material_number", "manual_firmed", "machine",
    "sap_basic_start_date", "sap_basic_finish_date", "sap_workcenter", "order_quantity",
    "sap_production_version", "production_version", "scheduled_start", "scheduled_end",
    "basic_start_date", "basic_finish_date", "run_time", "planning_status",
    "machine_wc", "first_start", "last_end", "tz", "sap_sent_finish", "sap_sent_version",
    "planned_order_initial_quantity", "original_start_received", "original_finish_received",
    "original_finish_date_only",
    # schedule_event BEFORE image (tracked fields not read above)
    "prt_01", "prt_02", "distribution_letter", "notes", "segment_count", "planning_code",
)
_CHUNK_READ_SQL = f"""
    SELECT o.id, o.plant, o.parent_production_order, o.material_number, o.manual_firmed, o.machine,
           o.sap_basic_start_date, o.sap_basic_finish_date, o.sap_workcenter, o.order_quantity,
           o.sap_production_version, o.production_version, o.scheduled_start, o.scheduled_end,
           o.basic_start_date, o.basic_finish_date, o.run_time, o.planning_status,
           (SELECT MIN(m.sap_workcenter) FROM machine m
             WHERE m.plant = o.plant AND m.machine = o.machine) AS machine_wc,
           seg.first_start, seg.last_end,
           (SELECT MIN(p.timezone) FROM plants p WHERE p.plant = o.plant) AS tz,
           ss.sent_finish AS sap_sent_finish, ss.sent_version AS sap_sent_version,
           o.planned_order_initial_quantity, o.original_start_received, o.original_finish_received,
           o.original_finish_date_only,
           o.prt_01, o.prt_02, o.distribution_letter, o.notes, seg.segment_count,
           o.planning_reason->>'code'
      FROM orders o
      LEFT JOIN order_sap_sent ss ON ss.order_id = o.id
      {_SCHEDULE_SEGMENTS_LATERAL_SQL}
     WHERE o.id IN (
             -- the chunk's own rows (primary-key lookup) ...
             SELECT i.id FROM orders i WHERE i.id = ANY(%(ids)s)
             UNION
             -- ... plus every sibling of a distribution child among them, found through
             -- the (plant, parent, material) index instead of walking the whole table
             SELECT s.id FROM orders x
               JOIN orders s ON s.plant = x.plant
                            AND s.parent_production_order = x.parent_production_order
                            AND s.material_number = x.material_number
              WHERE x.id = ANY(%(ids)s) AND x.parent_production_order IS NOT NULL)
     ORDER BY o.id
       FOR UPDATE OF o
"""


# ---- schedule_event (per-order change history) helpers for the ingest path ----
_EV_RESET_FIELDS = frozenset({"scheduled_start", "scheduled_end", "manual_firmed", "segments", "planning_status"})


def _ev_status(status, code):
    """planning_status as the history stores it: a held order carries its reason code."""
    return f"needs_planning:{code}" if status == "needs_planning" and code else status


def _ev_tracked(rec: dict) -> dict:
    """Tracked-field view (DB-typed values) of a chunk-read `before` dict or an `_EV_READBACK_SQL` row."""
    out = {k: rec.get(k) for k in sched_events.TRACKED_FIELDS if k not in ("segments", "planning_status")}
    out["planning_status"] = _ev_status(rec.get("planning_status"), rec.get("planning_code"))
    out["segments"] = int(rec.get("segments", rec.get("segment_count")) or 0)
    return out


# Master-data-derived fields: the chunk read-back sees them BEFORE the stamp (uploads never carry PRT, and the
# upsert blanks them), so a chunk-level diff would record phantom [x, null] changes. They are recorded ONCE,
# as a net change, by `_record_ingest_attr_net` after the stamp has run.
_EV_NET_FIELDS = ("prt_01", "prt_02", "production_version")


def _ev_ingest_tracked(rec: dict) -> dict:
    """`_ev_tracked` minus the master-data-derived `_EV_NET_FIELDS` (the ingest/sap_reset diff basis)."""
    out = _ev_tracked(rec)
    for k in _EV_NET_FIELDS:
        out.pop(k, None)
    return out


# plant falls back to the same single-plant machine derivation _backfill_and_stamp applies, so a create
# row for an Excel row that arrived without a PLANT column is not dropped for want of a plant.
_EV_READBACK_SQL = f"""
    SELECT o.id,
           COALESCE(o.plant, (SELECT MIN(m.plant) FROM machine m
                               WHERE m.machine = o.machine
                                 AND (SELECT COUNT(DISTINCT m2.plant) FROM machine m2
                                       WHERE m2.machine = o.machine) = 1)) AS plant,
           o.production_order, o.material_number, {sched_events.TRACKED_COLS_SQL},
           o.planning_reason->>'code' AS planning_code, seg.segment_count AS segments
      FROM orders o
      {_SCHEDULE_SEGMENTS_LATERAL_SQL}
     WHERE o.id = ANY(%s)
"""


def _record_ingest_events(cur, ev, *, before: dict, inserted_ids, written_existing, reset_ids) -> int:
    """One read-back over the chunk's locked rows, then ONE schedule_event INSERT. inserted -> create;
    written/reset existing -> modify (a reset order is ONE row, source 'sap_reset', spanning the pre-upsert
    before to the post-reset after). Fail-open: the read-back runs under its own savepoint."""
    if ev is None:
        return 0
    ids = list(dict.fromkeys([*inserted_ids, *written_existing, *reset_ids]))
    if not ids:
        return 0
    created, reset = set(inserted_ids), set(reset_ids)
    rows: list = []
    try:
        cur.execute("SAVEPOINT sched_ev_rb")
        cur.execute(_EV_READBACK_SQL, (ids,))
        cols = [d.name for d in cur.description]
        after = {r[0]: dict(zip(cols, r, strict=True)) for r in cur.fetchall()}
        for rid in ids:
            a = after.get(rid)
            if a is None:
                continue
            if rid in created:
                op, src = "create", None
                changes = sched_events.snapshot_changes(_ev_tracked(a), op="create")
            else:
                b = before.get(rid)
                if b is None:
                    continue
                changes = sched_events.diff_tracked(_ev_ingest_tracked(b), _ev_ingest_tracked(a)) or {}
                # 'sap_reset' only when a planner placement was really taken back (slot, firm, segments, status);
                # an unplaced order whose quantity changed is a plain ingest change.
                op = "modify"
                src = "sap_reset" if rid in reset and set(changes) & _EV_RESET_FIELDS else None
            rows.append(sched_events.EventRow(
                plant=a["plant"] or "", order_id=rid, production_order=a["production_order"],
                material_number=a["material_number"], op=op, changes=changes, source=src))
        cur.execute("RELEASE SAVEPOINT sched_ev_rb")
    except Exception as exc:  # noqa: BLE001 - history is derived; never fail the ingest
        log.warning("schedule_event read-back failed (action_id=%s): %s", ev.action_id, exc)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sched_ev_rb")
            cur.execute("RELEASE SAVEPOINT sched_ev_rb")
        except Exception:  # noqa: BLE001
            pass
        return 0
    return sched_events.record(cur, ev, rows)


def _record_ingest_attr_net(cur, ev, *, pre_attrs: dict, written_ids) -> int:
    """The single writer of PRT / production-version history during ingest. After the batch's stamp has run,
    read the three master-data-derived fields for every id in `pre_attrs` (their value BEFORE the upload wrote
    anything) and record ONE `modify` row per order with the NET change (a PRT the upsert blanked and the stamp
    restored is no change). Orders the upload actually wrote carry the ingest source; orders it only filled
    from master data are `master_data_stamp`. Inserted orders have no pre-image (their `create` row stands).
    Runs in its own savepoint and transaction, after the stamp: fail-open, same batch action_id."""
    if ev is None or not pre_attrs:
        return 0
    written = set(written_ids)
    rows: list = []
    try:
        cur.execute("SAVEPOINT sched_ev_net")
        cur.execute("SELECT id, plant, production_order, material_number, prt_01, prt_02, production_version"
                    " FROM orders WHERE id = ANY(%s)", (sorted(pre_attrs),))
        for r in cur.fetchall():
            changes = sched_events.diff_tracked(
                pre_attrs[r[0]], {"prt_01": r[4], "prt_02": r[5], "production_version": r[6]})
            if changes:
                rows.append(sched_events.EventRow(
                    plant=r[1] or "", order_id=r[0], production_order=r[2], material_number=r[3], op="modify",
                    changes=changes, source=None if r[0] in written else "master_data_stamp"))
        cur.execute("RELEASE SAVEPOINT sched_ev_net")
    except Exception as exc:  # noqa: BLE001 - history is derived; never fail the ingest
        log.warning("schedule_event attribute net pass failed (action_id=%s): %s", ev.action_id, exc)
        try:
            cur.execute("ROLLBACK TO SAVEPOINT sched_ev_net")
            cur.execute("RELEASE SAVEPOINT sched_ev_net")
        except Exception:  # noqa: BLE001
            pass
        return 0
    return sched_events.record(cur, ev, rows)


def _duplicate_id_sort_key(row: dict) -> tuple:
    """Order key for rows sharing one ORDER|MATERIAL id: (start, quantity, raw machine). A row with no
    usable start orders by its finish instead (the shared end rule, in Python: last segment end, stored
    end, locked SAP finish, then the SAP finish as sent), so a missing start never ties it with every
    other startless row. Rows with a start sort exactly as before, so no id is permuted."""
    start, qty = row.get("basic_start_date"), row.get("order_quantity")
    when = start
    if when is None:
        when = (row.get("last_end") or row.get("scheduled_end") or row.get("original_finish_received")
                or row.get("basic_finish_date"))
    return (start is None, when if when is not None else datetime.min,
            qty is None, float(qty) if qty is not None else 0.0,
            str(row.get("sap_workcenter") or row.get("machine") or ""))


def _plant_local_now(tz_name: str | None) -> datetime:
    """Naive plant-local wall-clock now (orders' timestamps are plant-local and
    naive); an unknown/missing timezone falls back to UTC like the horizon math."""
    now_utc = datetime.now(timezone.utc)
    try:
        local = now_utc.astimezone(ZoneInfo(tz_name)) if tz_name else now_utc
    except (ZoneInfoNotFoundError, ValueError):
        local = now_utc
    return local.replace(tzinfo=None)


def _order_is_running(b: dict, now: datetime) -> bool:
    """Running = stored start <= now < stored end. Only STORED edges count: the first/last segment, else
    `scheduled_start`/`scheduled_end` (backward scheduling, Task 2.2). Both must exist; a never-placed order
    is never running even when its SAP window covers now, and an order in Needs Planning has no window at
    all. The SAP dates and `start + run_time` are never consulted."""
    if b.get("planning_status") == "needs_planning":
        return False
    start = b.get("first_start") or b.get("scheduled_start")
    end = b.get("last_end") or b.get("scheduled_end")
    return start is not None and end is not None and start <= now < end


# A stored attribute is NULL (or blank, for the production version) while its
# material_plants master value is not -- the "unchanged re-upload still fills it" test.
_MASTER_FILL_PREDICATE_SQL = """
       (o.color IS NULL AND mp.color IS NOT NULL)
    OR (o.prt_01 IS NULL AND mp.prt_01 IS NOT NULL)
    OR (o.prt_02 IS NULL AND mp.prt_02 IS NOT NULL)
    OR (COALESCE(o.production_version, '') = '' AND COALESCE(mp.default_production_version, '') <> '')"""
_MASTER_FILL_CANDIDATES_SQL = """
    SELECT o.id FROM orders o
      JOIN material_plants mp ON mp.plant = o.plant AND mp.material_id = o.material_number
     WHERE o.id = ANY(%s) AND (""" + _MASTER_FILL_PREDICATE_SQL + """)"""


def _backfill_and_stamp(cur, conn, ids: list[str], *, report_ids: list[str] | None = None,
                        heal_ids: list[str] | None = None, ev=None, skip_event_ids=None) -> dict:
    """Post-upsert steps scoped to `ids` (the orders an upload actually wrote):
    lock them in id order, derive a missing plant from the machine, derive
    machine_key, then stamp color/PRT/production version from material_plants
    (Seam 2). Returns _stamp_order_attributes' missing-master-data summary, which
    covers `report_ids` (default `ids`). `heal_ids` are rows the upload did NOT
    write (skipped as unchanged) that are checked for a NULL plant/machine_key:
    they are locked with the rest, but only written (and stamped) when the
    backfill can actually fill them -- the result's `healed_ids` lists those.
    Shares the caller's transaction and commits it at the end."""
    ids = sorted(set(ids))
    # Rows among the incoming ids that SAP sent nothing new for (skipped as unchanged)
    # but whose color / PRT / production version is still NULL while master data now
    # has a value: filled below. Found by an unlocked read BEFORE the lock so every
    # row this function writes is locked by the one id-ordered statement.
    fill_ids: list[str] = []
    if report_ids:
        cur.execute(_MASTER_FILL_CANDIDATES_SQL, (sorted(set(report_ids)),))
        fill_ids = [r[0] for r in cur.fetchall()]
    scope = sorted(set(ids) | set(heal_ids or []) | set(fill_ids))
    healed: set[str] = set()
    if scope:
        # Lock first (id order) so these multi-row UPDATEs can never deadlock a
        # concurrent save/distribution writer locking the same rows in id order.
        cur.execute("SELECT id FROM orders WHERE id = ANY(%s) ORDER BY id FOR UPDATE", (scope,))
        # Materialize plant for rows this upload didn't carry one for, deriving it from
        # the machine->plant master-data mapping. Only derive when the machine maps to
        # EXACTLY ONE plant; a machine code shared across plants is left NULL (and
        # warned) rather than silently mis-attributed to the lowest plant code.
        cur.execute(
            """
            UPDATE orders o
               SET plant = (
                   SELECT MIN(m.plant) FROM machine m
                    WHERE m.machine = o.machine
               )
             WHERE o.id = ANY(%s) AND o.plant IS NULL
               AND (
                   SELECT COUNT(DISTINCT m.plant) FROM machine m
                    WHERE m.machine = o.machine
               ) = 1
            RETURNING o.id
            """,
            (scope,),
        )
        healed.update(r[0] for r in cur.fetchall())
        # Same idea for machine_key, strictly downstream of the plant backfill
        # just above (a row still NULL there stays NULL here too).
        cur.execute(
            """
            UPDATE orders o
               SET machine_key = (
                   SELECT m.machine_key FROM machine m
                    WHERE m.plant = o.plant AND m.machine = o.machine
               )
             WHERE o.id = ANY(%s) AND o.machine_key IS NULL AND o.plant IS NOT NULL
               AND (
                   SELECT COUNT(*) FROM machine m
                    WHERE m.plant = o.plant AND m.machine = o.machine
               ) = 1
            RETURNING o.id
            """,
            (scope,),
        )
        healed.update(r[0] for r in cur.fetchall())
        # The filled rows join the healed set: the Seam 2 stamp below then writes
        # exactly those rows (the candidate query already proved each has something
        # to fill), so truly unchanged rows keep their xmin.
        healed.update(fill_ids)
    healed -= set(ids)
    # Seam 2 -- strictly downstream of the plant backfill above (it reads o.plant).
    # The upload ALWAYS succeeds regardless of how much is unmatched (N5/N6/N7).
    result = _stamp_order_attributes(conn, ids=sorted(set(ids) | healed), report_ids=report_ids, ev=ev,
                                       skip_event_ids=skip_event_ids)
    result["healed_ids"] = sorted(healed)
    conn.commit()
    return result


def _locked_originals(b: dict | None, row: dict, sap_tz: str | None) -> tuple:
    """(original_start_received, original_finish_received, original_finish_date_only) to write for one
    incoming row.

    `b` is the stored before-image (None = brand-new row), `row` the ingest row (`basic_*` are SAP's dates as
    received, `sap_basic_finish_date` the finish judged for the echo). On an echo of the finish NIMBUS last
    sent, BOTH locked columns keep their STORED values (a start-only SAP change whose finish echoes must not
    refresh `original_start_received`); a column with no stored value yet takes the incoming one, so a first
    write still populates it. Not an echo (never-sent order, or a genuine finish change): both carry the
    incoming SAP start / finish. Only the finish decides (OQ31). Shared by the order upsert and the
    distribution child writer.

    The third value says whether the locked finish arrived as a date with no time (D10, VI12): on an echo the
    stored flag stands (None = nothing stored to keep); otherwise it is the staging parser's
    `_finish_date_only` when the row carries it, else True when the finish sits at exact midnight (the
    Excel path, where a date-only cell is midnight)."""
    in_s, in_f = row.get("basic_start_date"), row.get("basic_finish_date")
    # the finish SAP actually sent (`sap_basic_finish_date`), judged exactly as sap_changed_fields does
    if b and _row_finish_echo(b, row, sap_tz, finish_key="sap_basic_finish_date"):
        orig_s = b.get("original_start_received") if b.get("original_start_received") is not None else in_s
        orig_f = b.get("original_finish_received") if b.get("original_finish_received") is not None else in_f
        return orig_s, orig_f, b.get("original_finish_date_only")
    flag = row.get("_finish_date_only")
    if flag is None:
        flag = isinstance(in_f, datetime) and in_f.time() == dt_time.min
    return in_s, in_f, bool(flag)


def _patch_locked_originals(chunk: list[tuple], before: dict, row_by_id: dict,
                            sap_tz: str | None) -> tuple[list[tuple], list[tuple]]:
    """Fill the trailing (original_start_received, original_finish_received) of each upsert tuple from
    `_locked_originals`. The upsert SETs `COALESCE(EXCLUDED.original_*, orders.original_*)`, never from
    `EXCLUDED.basic_*`. Returns (chunk, flag_pairs): `flag_pairs` are the (order id, original_finish_date_only)
    values the caller writes after the upsert, only where they differ from what is stored, so an unchanged
    row keeps its xmin."""
    out: list[tuple] = []
    pairs: list[tuple] = []
    for t in chunk:
        row = row_by_id.get(t[0])
        if row is None:
            out.append(t)
            continue
        b = before.get(t[0])
        if b is not None and b.get("sap_sent_finish") is None and b.get("parent_production_order"):
            # U11: a distribution child with no sent row of its own (a re-weight / collapse replaced the one that
            # had it) inherits the family's echo decision: when any live member's sent finish matches the
            # incoming finish, this child keeps its locked originals as well.
            fam_sent = max((m["sap_sent_finish"] for m in before.values()
                            if m.get("sap_sent_finish") is not None
                            and m.get("plant") == b.get("plant")
                            and m.get("parent_production_order") == b.get("parent_production_order")
                            and m.get("material_number") == b.get("material_number")
                            and _row_finish_echo(m, row, sap_tz, finish_key="sap_basic_finish_date")),
                           default=None)
            if fam_sent is not None:
                b = {**b, "sap_sent_finish": fam_sent}
        orig_s, orig_f, flag = _locked_originals(b, row, sap_tz)
        out.append((*t[:-2], orig_s, orig_f))
        stored = bool(b.get("original_finish_date_only")) if b is not None else False
        if flag is not None and bool(flag) != stored:
            pairs.append((t[0], bool(flag)))
    return out, pairs


def cap_requeue_decision(placed: bool, prior_run_time, run_time, *, prior_known: bool = True) -> bool:
    """Should an order whose run time is over the cap be (re)queued? (ruling R-I5)
    Yes when it holds no placement, or when its resolved run time changed versus the stored one. A placed
    order whose over-cap run time is UNCHANGED (a planner released it) keeps its slot and firm flags.
    `prior_known=False` (no before-image for the row) reads as unchanged."""
    if not placed:
        return True
    if not prior_known:
        return False
    return _canonical_runtime_minutes(prior_run_time) != _canonical_runtime_minutes(run_time)


def _apply_run_time_cap(cur, conn, ids: list[str], protect_ids: list[str] | None = None, *,
                        prior_run_times: dict | None = None, commit: bool = True, ev=None) -> dict:
    """The ingest side of the run-time cap (OQ28), over the orders an upload just wrote.

    An order whose stored run time is over its plant's `cap_hours` is queued exactly like a routing
    hold (planning_status 'needs_planning', reason {code 'run_time_over_cap', message}, both dates
    NULL, firm cleared, segments deleted -- the shape `orders_planning_state_check` requires, written
    by the resolver's `_write_holds`). The symmetric release: a queued order whose reason is
    'run_time_over_cap' and whose run time is now within the cap goes back to 'scheduled' (never
    touches any other queued reason). A RUNNING order (and any id in `protect_ids`) keeps its slot:
    the SAP-truth rule that a running order is never un-scheduled by an upload. A PLACED order whose
    over-cap run time did not change versus `prior_run_times[id]` (the stored value before this write)
    also keeps its slot and firm flags (R-I5); an id absent from `prior_run_times` reads as unchanged.
    Commits when it wrote anything unless `commit=False` (a caller inside its own transaction, e.g. the
    distribution planner). Returns {queued, released, running_kept}."""
    out = {"queued": 0, "released": 0, "running_kept": 0}
    ids = sorted(set(ids or ()))
    if not ids:
        return out
    cur.execute(
        "SELECT o.id, o.run_time, o.planning_status, o.planning_reason->>'code', o.plant, p.timezone,"
        " NULL, o.scheduled_start, o.scheduled_end, o.basic_start_date,"
        " o.basic_finish_date, seg.first_start, seg.last_end"
        " FROM orders o LEFT JOIN plants p ON p.plant = o.plant " + _SCHEDULE_SEGMENTS_LATERAL_SQL +
        " WHERE o.id = ANY(%s) AND o.run_time IS NOT NULL ORDER BY o.id",
        (ids,),
    )
    protect = set(protect_ids or ())
    to_queue: list[tuple] = []
    to_release: list[str] = []
    for (oid, run_time, status, reason_code, plant, tz, horizon, sched_start, sched_end,
         basic_start, basic_finish, first_start, last_end) in cur.fetchall():
        cap = cap_hours()
        if float(run_time) > cap:
            if status == "needs_planning" and reason_code not in (None, RUN_TIME_OVER_CAP_CODE, "runtime_pending"):
                continue   # another subsystem's hold keeps its own reason
            b = {"planning_status": status, "first_start": first_start, "last_end": last_end,
                 "scheduled_start": sched_start, "scheduled_end": sched_end, "basic_start_date": basic_start,
                 "basic_finish_date": basic_finish, "run_time": run_time}
            # Only an order that really holds a slot can be "running" (`_order_is_running` reads stored edges
            # only), so a never-scheduled order whose SAP window covers now has no slot to protect.
            if oid in protect or _order_is_running(b, _plant_local_now(tz)):
                out["running_kept"] += 1
                continue
            placed = ((sched_start is not None or sched_end is not None or first_start is not None)
                      and status != "needs_planning")
            if not cap_requeue_decision(placed, (prior_run_times or {}).get(oid), run_time,
                                        prior_known=oid in (prior_run_times or {})):
                continue   # a placed order whose over-cap run time did not change keeps its slot and firm
            to_queue.append((oid, Jsonb(run_time_over_cap_reason(run_time, cap))))
        elif status == "needs_planning" and reason_code == RUN_TIME_OVER_CAP_CODE:
            to_release.append(oid)
    if to_queue:
        # Deferred import: backend.routing.resolver imports db (never the reverse at module scope).
        import backend.routing.resolver as routing_resolver
        routing_resolver._write_holds(cur, to_queue, ev=ev)
        out["queued"] = len(to_queue)
    if to_release:
        cur.execute(
            "UPDATE orders SET planning_status = 'scheduled', planning_reason = NULL, updated_at = NOW()"
            " WHERE id = ANY(%s) AND planning_status = 'needs_planning'"
            " AND planning_reason->>'code' = %s"
            " RETURNING id, plant, production_order, material_number",
            (to_release, RUN_TIME_OVER_CAP_CODE),
        )
        released_rows = cur.fetchall()
        out["released"] = len(to_release)
        if ev is not None and released_rows:
            # the WHERE above proves the prior state: queued for exactly this reason
            sched_events.record(cur, ev, [
                sched_events.EventRow(
                    plant=r[1] or "", order_id=r[0], production_order=r[2], material_number=r[3], op="modify",
                    changes={"planning_status": [f"needs_planning:{RUN_TIME_OVER_CAP_CODE}", "scheduled"]},
                    source="routing_hold")
                for r in released_rows])
    if (to_queue or to_release) and commit:
        conn.commit()
    return out


def upsert_orders(rows: list[dict], *, batch_id: str | None = None, source: str = "excel",
                  filename: str | None = None, raw_row_count: int | None = None,
                  warnings: list[dict] | None = None,
                  plan_fn: Callable | None = None, apply_fn: Callable | None = None,
                  resolve_fn: Callable | None = None, sap_tz: str | None = None,
                  actor: str | None = None) -> dict:
    """Shared orders upsert for both the Excel and SAP ingest paths.

    `sap_tz` is the SAP system zone the finish echo rule (`finish_echoes`) judges in; the SAP staging
    apply passes it. None (the Excel path, which has no SAP zone of its own) means the plant's own zone.
    The echo rule also decides the locked `original_start_received` / `original_finish_received` columns:
    the per-row tuple carries the STORED values for both on an echo, the incoming dates otherwise, and the
    upsert only ever writes them as COALESCE(EXCLUDED.original_*, orders.original_*).

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

    `source="sap"` runs `_UPSERT_SQL_SAP`, a source-scoped variant: the Excel-only
    columns (`_EXCEL_ONLY_COLS`: description, form size, order category/type,
    labor/machine hours, FTE) are kept when the SAP row does not carry them
    (COALESCE in the SET; only a non-NULL differing value counts as a SAP change).
    The Excel path (`_UPSERT_SQL`) keeps its overwrite semantics unchanged.

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
        it is called as `resolve_fn(plant, conn=conn, batch_id=..., ids=...,
        protect_ids=...)` (`protect_ids` = SAP-changed orders kept in place because
        they are running; the resolver never holds them) —
        matching `backend.routing.resolver.resolve_orders`'s signature, reusing
        the connection already open at that point (`ids` = every order this
        upload wrote, since unchanged rows are skipped and keep their old batch
        tag) — once per
        distinct plant among this batch's rows, AFTER `apply_fn` has run and
        BEFORE the `upload_audit` INSERT. Each call's report dict is folded
        into `warnings` as `{"level": "info", "category": "routing_resolve",
        "plant": ..., **resolve_result}`.
    db.py never imports `backend.*` at module scope (every router imports
    `db`, not the reverse — a top-level import here would be circular since
    both `backend/distribution/data.py` and `backend/routing/resolver.py`
    import `db`); callers pass these functions in instead.

    SAP-is-truth re-upload rules: a row SAP sent nothing different for is skipped
    (`unchanged`); the planner's machine is kept while it belongs to the work
    center SAP sent; and for orders SAP actually changed (dates, work center,
    quantity, production version -- see `sap_changed_fields`) the slot and the
    manual firm are reset, per chunk, under id-ordered row locks taken before
    any write. Running orders keep their slot (warning `sap_changed_running`).

    Returns: {status:"ok", batch_id, inserted, updated, unchanged, failed, warnings, lines}.
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
    # Dates arrive as naive datetimes from Excel but as ISO strings from the SAP-sync
    # path; normalise first so change detection never compares str with datetime.
    unparseable_dates = 0
    for row in rows:
        for date_col in ("basic_start_date", "basic_finish_date", "sap_basic_finish_date"):
            if date_col in row:
                original = row[date_col]
                row[date_col] = _naive_dt(original)
                if row[date_col] is None and original is not None and str(original).strip() not in ("", "NaT"):
                    unparseable_dates += 1     # treated as "not sent" for change detection
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
    # Compute id via make_id() when absent. ORDER|MATERIAL is not unique, so a
    # colliding group is sorted by (start, quantity, raw machine) BEFORE the
    # "_<n>" suffixes are handed out: the same file in a different row order
    # then maps the same row to the same id (a plain row-order cumcount would
    # shuffle ids between rows, silently swapping their planner state). Suffixed
    # rows are flagged so they are never judged by the SAP-change detection.
    base_ids = [row.get("id") or make_id(row.get("production_order", ""), row.get("material_number", ""))
                for row in rows]
    group_members: dict[str, list[int]] = {}
    for i, rid in enumerate(base_ids):
        group_members.setdefault(rid, []).append(i)

    def _dup_sort_key(i: int):
        return _duplicate_id_sort_key(rows[i])

    n_suffixed = 0
    for rid, idxs in group_members.items():
        ordered = sorted(idxs, key=_dup_sort_key) if len(idxs) > 1 else idxs
        for pos, i in enumerate(ordered):
            if pos == 0:
                rows[i]["id"] = rid
            else:
                rows[i]["id"] = f"{rid}_{pos}"
                rows[i]["_skip_change_detection"] = True
                n_suffixed += 1
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
    # Disabled plants have ingest unchanged. SAP's own production version
    # (`sap_production_version`: None = column not sent, "" = blank cell) is
    # normalised the same way, so the baseline stored and the one compared on
    # the next upload never disagree.
    for row in rows:
        raw_pv = row["sap_production_version"] if "sap_production_version" in row else row.get("production_version")
        sap_pv = None if raw_pv is None else str(raw_pv).strip()
        if row.get("plant") in routing_enabled_plants:
            pv = row.get("production_version")
            if pv:
                row["production_version"] = _zero_pad(str(pv).strip().upper(), 4)
            if sap_pv:
                sap_pv = _zero_pad(sap_pv.upper(), 4)
        row["sap_production_version"] = sap_pv
        # SAP's own dates, written to the baseline columns by the upsert only
        # (never by a drag). A caller that knows the finish SAP
        # actually sent (the Excel ingest: None = not sent) passes it as
        # `sap_basic_finish_date`; otherwise the row's finish is SAP's.
        row["sap_basic_start_date"] = row.get("basic_start_date")
        if "sap_basic_finish_date" not in row:
            row["sap_basic_finish_date"] = row.get("basic_finish_date")

    # ---------- Build row tuples in _UPSERT_SQL column order ----------
    tuples = []
    # The trailing two slots are the locked original_start_received / original_finish_received: they
    # depend on the stored originals and the sent finish, which are only known once a chunk's
    # before-image is read, so `_patch_locked_originals` fills them per chunk right before the execute.
    for row in rows:
        tuples.append((
            row["id"],
            *(row.get(col) for col in _UPSERT_ROW_COLS),
            batch_id,
            None, None,
        ))
    row_by_id = {row["id"]: row for row in rows}
    all_ids = [row["id"] for row in rows]

    # ---------- Upsert + locked reset + audit ----------
    # Chunked: each chunk is ONE transaction that (a) locks every row it may
    # touch, ORDER BY id, in a single statement BEFORE any write (the same
    # ordering /tasks saves and distribution use, so no two writers can hold a
    # pair in opposite order), (b) upserts, (c-f) resets slot + firm for orders
    # SAP actually changed. Each chunk is idempotent, so a mid-upload failure
    # leaves a consistent partial state the user can recover from by re-uploading.
    inserted = 0
    updated = 0
    # Ids that were genuinely fresh inserts this batch (RETURNING's xmax=0
    # signal) — used below (ROUTING_RUNTIME_DESIGN.md §4 item 5) to hold new
    # orders on an enabled plant instead of letting them look normal while a
    # run_time_source-'routing' resolve is still pending.
    inserted_ids: list[str] = []
    touched: set[str] = set()      # ids this upload actually wrote (upsert or reset)
    # A distribution child's own quantity is its SHARE of the parent, which a planner's
    # re-weight changes (and a stale plan can put back): it is never SAP changing the
    # order. Children are judged on the PARENT's quantity instead -- SAP's new parent
    # quantity vs the one the distribution header stored at SAP's previous upload.
    parent_quantity_changed: set[tuple] = set()
    parent_quantity_judged: set[tuple] = set()   # headers with both quantities known
    for pkey, pplan in (distribution_plan.get("parents") or {}).items():
        old_q = ((pplan.get("existing_header") or {}).get("order_quantity"))
        new_q = (pplan.get("parent_facts") or {}).get("order_quantity")
        # A3 / D15: judge the TOTAL when both the stored header and this row know it, so a partial
        # conversion (reduced quantity up, total unchanged) does not unschedule an aggregate's children.
        old_total = (((pplan.get("existing_header") or {}).get("sap_facts") or {})
                     .get("planned_order_initial_quantity"))
        new_total = (pplan.get("parent_facts") or {}).get("planned_order_initial_quantity")
        if old_total is not None and new_total is not None:
            old_q, new_q = old_total, new_total
        if old_q is not None and new_q is not None:
            parent_quantity_judged.add(tuple(pkey))
            if Decimal(str(old_q)).quantize(Decimal("0.001")) != Decimal(str(new_q)).quantize(Decimal("0.001")):
                parent_quantity_changed.add(tuple(pkey))
    # schedule_event: one action per upload (the batch id), actor = the caller, else the filename, else 'system'
    actor_eff = actor or filename or "system"
    ev_ctx = sched_events.EventCtx(source="sap_ingest" if source == "sap" else "excel_upload",
                                   actor=actor_eff, action_id=sched_events.as_action_id(batch_id))
    sap_changed_n = 0
    unfirmed_n = 0
    running_changed_ids: list[str] = []
    prior_run_times: dict[str, object] = {}   # stored run_time before this upload (R-I5: cap re-queue judges change)
    # PRT / production version before the upload touched them, for every existing order in the batch (no
    # pre-image for inserted ids); `_record_ingest_attr_net` diffs them against the post-stamp values.
    pre_attrs: dict[str, dict] = {}
    written_all: set[str] = set()
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            for i in range(0, len(tuples), _UPSERT_CHUNK):
                chunk = tuples[i:i + _UPSERT_CHUNK]
                chunk_ids = [t[0] for t in chunk]
                # (a) lock first (rows to be written + every sibling of a distribution child)
                cur.execute(_CHUNK_READ_SQL, {"ids": chunk_ids})
                before = {rec[0]: dict(zip(_CHUNK_READ_COLS, rec, strict=True)) for rec in cur.fetchall()}
                prior_run_times.update({rid: b["run_time"] for rid, b in before.items()})
                for rid in chunk_ids:
                    b = before.get(rid)
                    if b is not None:
                        pre_attrs.setdefault(rid, {k: b.get(k) for k in _EV_NET_FIELDS})
                # (a') the locked original_*_received per row, from the stored originals + the sent finish
                chunk, flag_pairs = _patch_locked_originals(chunk, before, row_by_id, sap_tz)
                # (b) upsert (rows SAP did not change return nothing)
                cur.executemany(_UPSERT_SQL_SAP if source == "sap" else _UPSERT_SQL,
                                chunk, returning=True)
                written_existing: list[str] = []
                chunk_inserted: list[str] = []
                reset_returned: list[str] = []
                while True:
                    rec = cur.fetchone()
                    if rec is not None:
                        row_id, was_inserted = rec[0], rec[1]
                        touched.add(row_id)
                        if was_inserted:
                            inserted += 1
                            inserted_ids.append(row_id)
                            chunk_inserted.append(row_id)
                        else:
                            updated += 1
                            written_existing.append(row_id)
                    if not cur.nextset():
                        break
                if flag_pairs:
                    # D10 (VI12): whether the locked finish arrived as a date with no time; only differing values
                    cur.executemany("UPDATE orders SET original_finish_date_only = %s WHERE id = %s",
                                    [(flag, oid) for oid, flag in flag_pairs])
                # (c) which written orders did SAP actually change?
                changed: set[str] = set()
                for rid in written_existing:
                    b, r = before.get(rid), row_by_id.get(rid)
                    if b is None or r is None or r.get("_skip_change_detection"):
                        continue
                    incoming = {
                        "basic_start_date": r.get("basic_start_date"),
                        # the finish SAP sent, never NIMBUS's start+RUN_TIME derivation
                        "basic_finish_date": r.get("sap_basic_finish_date"),
                        "sap_workcenter": r.get("sap_workcenter"),
                        "order_quantity": r.get("order_quantity"),
                        # the TOTAL (A3 / D15): a partial conversion shrinks only the open quantity
                        "planned_order_initial_quantity": r.get("planned_order_initial_quantity"),
                        "sap_production_version": r.get("sap_production_version"),
                        "parent_production_order": r.get("parent_production_order"),
                        # SAP sent no time on the finish (staging parser); None = infer from midnight
                        "_finish_date_only": r.get("_finish_date_only"),
                    }
                    pkey = (b["plant"], b["parent_production_order"], b["material_number"])
                    # Judged on the parent's quantity when the header knows it; a child with no
                    # usable header quantity falls back to its own quantity comparison.
                    is_child = bool(b["parent_production_order"]) and pkey in parent_quantity_judged
                    if is_child:
                        incoming["order_quantity"] = None
                    fields = sap_changed_fields(b, incoming, b["machine_wc"], sap_tz=sap_tz)
                    if is_child and pkey in parent_quantity_changed:
                        fields.add("quantity")
                    if fields:
                        changed.add(rid)
                if changed:
                    # (d) a changed distribution child takes every sibling (same plant,
                    # parent order and material) with it -- only rows locked in (a).
                    sibling_key = {rid: (b["plant"], b["parent_production_order"], b["material_number"])
                                   for rid, b in before.items() if b["parent_production_order"]}
                    changed_keys = {sibling_key[rid] for rid in changed if rid in sibling_key}
                    candidates = set(changed)
                    if changed_keys:
                        candidates |= {rid for rid, k in sibling_key.items() if k in changed_keys}
                    # (e) protection: a RUNNING order keeps its slot and firm (the new SAP
                    # baseline is already written); frozen-horizon orders ARE reset.
                    reset_ids: list[str] = []
                    for rid in sorted(candidates):
                        if _order_is_running(before[rid], _plant_local_now(before[rid]["tz"])):
                            # Running implies stored edges (`_order_is_running`), i.e. a slot that was kept.
                            running_changed_ids.append(rid)
                        else:
                            reset_ids.append(rid)
                    # (f) slot + firm back to SAP's dates
                    if reset_ids:
                        cur.execute("DELETE FROM order_schedule_segments WHERE order_id = ANY(%(ids)s)",
                                    {"ids": reset_ids})
                        cur.execute(
                            "UPDATE orders SET manual_firmed = FALSE, scheduled_start = NULL,"
                            " scheduled_end = NULL, planning_status = 'scheduled', planning_reason = NULL,"
                            " runtime_schedule_mismatch = FALSE, placement_exception = NULL,"
                            " updated_at = NOW()"
                            " WHERE id = ANY(%(ids)s) RETURNING id",
                            {"ids": reset_ids},
                        )
                        reset_returned = [rec[0] for rec in cur.fetchall()]
                        touched.update(reset_returned)
                        sap_changed_n += len(reset_returned)
                        unfirmed_n += sum(1 for rid in reset_returned if before[rid]["manual_firmed"])
                written_all.update(written_existing)
                written_all.update(reset_returned)
                # schedule_event: last statement before the chunk commit (same locked rows, same transaction)
                _record_ingest_events(cur, ev_ctx, before=before, inserted_ids=chunk_inserted,
                                      written_existing=written_existing, reset_ids=reset_returned)
                conn.commit()

            # Post-upload steps are scoped to the ids this upload wrote (never to
            # the batch tag: rows skipped as unchanged keep their old batch id).
            touched_ids = sorted(touched)
            # Unchanged (skipped) rows used to be healed by the batch-scoped backfill;
            # keep that: any incoming row still missing plant/machine_key is checked too.
            cur.execute("SELECT id FROM orders WHERE id = ANY(%s) AND (plant IS NULL OR machine_key IS NULL)",
                        (all_ids,))
            heal_ids = [r[0] for r in cur.fetchall()]
            # ev=None: the stamp records nothing during ingest; `_record_ingest_attr_net` below is the one writer
            attr_result = _backfill_and_stamp(cur, conn, touched_ids, report_ids=all_ids, heal_ids=heal_ids)
            _record_ingest_attr_net(cur, ev_ctx, pre_attrs=pre_attrs, written_ids=written_all)
            conn.commit()
            touched.update(attr_result["healed_ids"])
            touched_ids = sorted(touched)
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
                 WHERE o.id = ANY(%s) AND o.plant IS NULL
                   AND (
                       SELECT COUNT(DISTINCT m.plant) FROM machine m
                        WHERE m.machine = o.machine
                   ) > 1
                 GROUP BY o.machine
                """,
                (touched_ids,),
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
            # Plants backfilled from the machine just above (an upload with no
            # PLANT column carried none when routing_enabled_plants was
            # computed at the top): join them in so their new orders are held
            # and their batch is resolved. Their file run_time was already
            # written, which is fine -- the batch resolve below re-derives
            # every non-manual row of the batch.
            resolve_plants = {r["plant"] for r in rows if r.get("plant")}
            if any(not r.get("plant") for r in rows):
                cur.execute(
                    """
                    SELECT DISTINCT o.plant FROM orders o
                      JOIN plants p ON p.plant = o.plant
                     WHERE o.id = ANY(%s) AND p.routing_runtime_enabled = TRUE
                    """,
                    (touched_ids,),
                )
                backfilled_enabled = {r[0] for r in cur.fetchall()}
                routing_enabled_plants |= backfilled_enabled
                resolve_plants |= backfilled_enabled
            if inserted_ids and routing_enabled_plants:
                # No history row: every id here was inserted this batch and already has its `create` row, so the
                # runtime_pending placeholder is transient (the resolver's outcome row, same action id, follows).
                cur.execute(
                    """
                    UPDATE orders o
                       SET planning_status = 'needs_planning',
                           planning_reason = '{"code":"runtime_pending","message":"Runtime pending resolution."}'::jsonb
                     WHERE o.id = ANY(%s) AND o.plant = ANY(%s)
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
                # apply() judges the distribution header's echo in the SAP frame the chunks used (the Excel path
                # has none: its apply_fn call stays exactly as before)
                apply_res = apply_fn(distribution_plan, batch_id, conn, actor=actor_eff,
                                     **({"sap_tz": sap_tz} if sap_tz else {}))
                # Same insertion style as the missing_master_data entry above —
                # one dict, `level`/`msg` are the two fields the cockpit's
                # warning list actually reads.
                warnings.append(apply_res["warnings_entry"])
                # Children apply() wrote itself (outside the generic upsert above)
                # get the same machine_key / material-attribute stamp.
                apply_touched = sorted(set(apply_res.get("touched_ids") or []) - touched)
                if apply_touched:
                    touched.update(apply_touched)
                    touched_ids = sorted(touched)
                    _backfill_and_stamp(cur, conn, apply_touched)
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
            # ---------- Run-time cap (OQ28): over-cap orders wait in Needs Planning ----------
            # After the last write (plant fully resolved, distribution children written) and before
            # the routing resolve (which owns run time on routing plants and applies the same cap).
            over_cap_result = _apply_run_time_cap(cur, conn, touched_ids, running_changed_ids,
                                                  prior_run_times=prior_run_times,
                                                  ev=dataclasses.replace(ev_ctx, source="routing_hold"))
            if over_cap_result["queued"] or over_cap_result["released"] or over_cap_result["running_kept"]:
                parts = []
                if over_cap_result["queued"]:
                    parts.append(f"{over_cap_result['queued']} order(s) with a run time over the length limit "
                                 f"were put in Needs Planning")
                if over_cap_result["released"]:
                    parts.append(f"{over_cap_result['released']} order(s) now within the limit were released "
                                 f"from Needs Planning")
                if over_cap_result["running_kept"]:
                    parts.append(f"{over_cap_result['running_kept']} running order(s) over the limit were left "
                                 f"on the schedule")
                warnings.append({
                    "level": "warn" if over_cap_result["queued"] or over_cap_result["running_kept"] else "info",
                    "category": RUN_TIME_OVER_CAP_CODE, **over_cap_result,
                    "msg": "; ".join(parts) + ".",
                })
            # ---------- Routing runtime: resolve() seam (ROUTING_RUNTIME_DESIGN.md §4 item 4) ----------
            # Runs after Order Distribution's plan/apply step (so each sub-order
            # resolves at its own machine/quantity), after the SAP-change reset
            # above (so the resolver sees the order's final state) and after the
            # new-order hold UPDATE above (so the resolver overwrites that
            # placeholder with the real outcome), once per distinct plant in this
            # batch, reusing the already-open `conn` (resolve_fn commits nothing
            # on it itself — matches `resolve_orders`'s conn-reuse contract).
            # `ids` = every order this upload wrote, so a re-derive reaches them
            # even though the batch tag is no longer stamped on unchanged rows.
            # A no-op for any plant resolve_fn/the caller never wires in.
            if resolve_fn is not None:
                # A resolver failure must not fail the upload: the rows are
                # already committed (never fold ingest into one transaction --
                # Code_Review_09_25 §10). Contain it in a savepoint, report a
                # warning, and leave the plant for a /recompute.
                for resolve_plant in sorted(resolve_plants):
                    cur.execute("SAVEPOINT routing_resolve")
                    try:
                        resolve_result = resolve_fn(resolve_plant, conn=conn, batch_id=batch_id, ids=touched_ids,
                                                    protect_ids=running_changed_ids)
                        cur.execute("RELEASE SAVEPOINT routing_resolve")
                    except Exception as exc:
                        cur.execute("ROLLBACK TO SAVEPOINT routing_resolve")
                        log.warning("Post-upload routing resolve failed for plant %s: %s",
                                    resolve_plant, exc, extra={"category": "upload"})
                        warnings.append({
                            "level": "warn",
                            "category": "routing_resolve",
                            "status": "failed",
                            "plant": resolve_plant,
                            "msg": (f"Routing run times could not be calculated for plant "
                                    f"{resolve_plant} ({exc}). The orders were saved; run "
                                    f"Recompute for this plant to retry."),
                        })
                        continue
                    warnings.append({
                        "level": "info",
                        "category": "routing_resolve",
                        "plant": resolve_plant,
                        **resolve_result,
                    })
                    if resolve_result.get("running_kept"):
                        warnings.append({
                            "level": "warn", "category": "routing_running_kept", "plant": resolve_plant,
                            "count": resolve_result["running_kept"],
                            "msg": (f"{resolve_result['running_kept']} order(s) in plant {resolve_plant} are "
                                    f"running right now: their run time could not be recalculated from "
                                    f"routing while running, so their run time, slot and firm were kept."),
                        })
            if unparseable_dates:
                warnings.append({
                    "level": "warn", "category": "unparseable_dates", "count": unparseable_dates,
                    "msg": (f"{unparseable_dates} date value(s) could not be read and were treated as "
                            f"not sent (they cannot count as an SAP date change)."),
                })
            unchanged = len(tuples) - inserted - updated
            warnings.append({
                "level": "info", "category": "upload_counts",
                "inserted": inserted, "updated": updated, "unchanged": unchanged,
                "msg": (f"{inserted} new, {updated} changed by SAP, {unchanged} unchanged "
                        f"(skipped, nothing rewritten)."),
            })
            if sap_changed_n:
                warnings.append({
                    "level": "info", "category": "sap_changed", "count": sap_changed_n,
                    "msg": (f"SAP changed {sap_changed_n} order(s) (dates, work center, quantity or "
                            f"production version): their slot was reset to SAP's dates."),
                })
            if unfirmed_n:
                warnings.append({
                    "level": "info", "category": "unfirmed", "count": unfirmed_n,
                    "msg": f"{unfirmed_n} manually firmed order(s) were un-firmed because SAP changed them.",
                })
            if running_changed_ids:
                warnings.append({
                    "level": "warn", "category": "sap_changed_running", "count": len(running_changed_ids),
                    "order_ids": running_changed_ids[:200],
                    "msg": (f"SAP changed {len(running_changed_ids)} order(s) that are running right now: "
                            f"their slot and firm were kept. Review them against SAP."),
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
        "unchanged": unchanged,
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


def _count_dropped_order_rows(counter: str, n: int) -> None:
    """Bump a process-level load-diagnostics counter for rows the order date
    rules dropped (or, for `unreadable_start_date`, loaded without a start).
    Best-effort: the Admin Cockpit counter never breaks an ingest."""
    try:
        from backend.admin_ops.diagnostics_state import DIAGNOSTICS
        DIAGNOSTICS[counter] = int(DIAGNOSTICS.get(counter, 0)) + int(n)
    except Exception:
        log.warning("Could not update diagnostics counter %s", counter, extra={"category": "upload"})


def _dropped_rows_label(df, mask) -> str:
    """` (order A, B, +N more)` naming the dropped rows when the frame carries
    PRODUCTION_ORDER values; empty string when it carries none."""
    if "PRODUCTION_ORDER" not in df.columns:
        return ""
    names = [str(v).strip() for v in df.loc[mask, "PRODUCTION_ORDER"].tolist()
             if pd.notna(v) and str(v).strip()]
    if not names:
        return ""
    shown = ", ".join(names[:5])
    return f" (order {shown}{f', +{len(names) - 5} more' if len(names) > 5 else ''})"


def _parse_finish_dates(col):
    """Parse the finish column; a blank or unreadable value becomes NaT.

    A finish is now rejected when it parses to NaT instead of being quietly
    filled, so a text column mixing date formats (pandas infers ONE format from
    the first value and NaTs the rest) must not lose rows to that inference: the
    values the first pass missed get a second, per-value parse."""
    out = pd.to_datetime(col, errors="coerce")
    missed = out.isna() & col.notna()
    if missed.any():
        retry = pd.to_datetime(col[missed], errors="coerce", format="mixed")
        out = out.copy()
        out.loc[missed] = retry.astype(out.dtype)
    return out


def _date_hygiene_df(df, warnings: list):
    """Order date rules shared by the Excel ingest and the SAP staging path.

    Expects BASIC_FINISH_DATE (required) and an optional BASIC_START_DATE and RUN_TIME column. The
    finish is stored exactly as received: a date-only (exact midnight) finish is kept, and a finish
    earlier than the start on the SAME calendar date is kept; neither is rewritten. The start is
    optional (backward scheduling OQ24/OQ25): a blank or missing start leaves the row with no start, an
    unreadable one does too with one `warn` warning, and a row with no start is never dropped for it (the
    browser derives its start from the finish). Returns the frame with: BASIC_START_DATE (NaT when none) and
    BASIC_FINISH_DATE parsed; `_SAP_FINISH_DATE` = the finish as sent (equal to BASIC_FINISH_DATE for every
    surviving row); RUN_TIME numeric with 1.0 default and `_RUN_TIME_DEFAULTED` flagged. Dropped with one
    `error` warning each (naming the rows when PRODUCTION_ORDER is present), index reset: rows with a blank
    or unparseable finish, and rows whose finish date is earlier than their start date.
    """
    if "BASIC_START_DATE" not in df.columns:
        df["BASIC_START_DATE"] = pd.NaT
    raw_start = df["BASIC_START_DATE"].copy()
    df["BASIC_START_DATE"] = pd.to_datetime(df["BASIC_START_DATE"], errors="coerce")
    if "BASIC_FINISH_DATE" not in df.columns:
        df["BASIC_FINISH_DATE"] = pd.NaT
    df["BASIC_FINISH_DATE"] = _parse_finish_dates(df["BASIC_FINISH_DATE"])
    # The finish SAP actually SENT, kept for the SAP baseline and the SAP-change
    # detection. Nothing derives or rewrites the finish any more, so this always
    # equals BASIC_FINISH_DATE for a surviving row.
    df["_SAP_FINISH_DATE"] = df["BASIC_FINISH_DATE"]

    # D54: capture whether RUN_TIME was genuinely absent/unparseable BEFORE the
    # fillna(1.0) default overwrites that absence — as a column (not a boolean
    # mask) because the dropna().reset_index(drop=True) below would misalign a
    # mask built against the pre-dropna index.
    _rt = pd.to_numeric(
        df["RUN_TIME"] if "RUN_TIME" in df.columns else pd.Series(float("nan"), index=df.index),
        errors="coerce",
    )
    df["_RUN_TIME_DEFAULTED"] = _rt.isna()
    df["RUN_TIME"] = _rt.fillna(1.0)

    # The start is optional: a value that was there but could not be read keeps its row (with no start) and
    # warns; a blank cell is just absent. Nothing is dropped, so nothing is counted as dropped.
    unreadable_start = (df["BASIC_START_DATE"].isna() & raw_start.notna()
                        & (raw_start.astype(str).str.strip() != ""))
    if unreadable_start.any():
        _count_dropped_order_rows("unreadable_start_date", int(unreadable_start.sum()))
        warnings.append({
            "level": "warn",
            "msg": (f"{int(unreadable_start.sum())} row(s) loaded with no start — BASIC_START_DATE is not a "
                    f"readable date{_dropped_rows_label(df, unreadable_start)}"),
        })

    # The finish is required and stored as received (owner rule): blank or
    # unparseable is rejected, never filled with the start or a derived value.
    no_finish = df["BASIC_FINISH_DATE"].isna()
    if no_finish.any():
        warnings.append({
            "level": "error",
            "msg": (f"{int(no_finish.sum())} row(s) dropped — blank or unparseable BASIC_FINISH_DATE"
                    f"{_dropped_rows_label(df, no_finish)}"),
        })
        _count_dropped_order_rows("dropped_no_finish_date", int(no_finish.sum()))
    df = df.loc[~no_finish].reset_index(drop=True)

    # A finish on an earlier CALENDAR DATE than the start is a corrupt row; a
    # finish earlier on the same date (or at exact midnight) is kept as received.
    # A row with no start has nothing to be earlier than (NaT compares False).
    before_start = df["BASIC_FINISH_DATE"].dt.normalize() < df["BASIC_START_DATE"].dt.normalize()
    if before_start.any():
        warnings.append({
            "level": "error",
            "msg": (f"{int(before_start.sum())} row(s) dropped — BASIC_FINISH_DATE is earlier than "
                    f"BASIC_START_DATE{_dropped_rows_label(df, before_start)}"),
        })
        _count_dropped_order_rows("dropped_no_finish_date", int(before_start.sum()))
    df = df.loc[~before_start].reset_index(drop=True)

    return df


def apply_order_date_hygiene_rows(rows: list[dict], warnings: list) -> list[dict]:
    """Row-dict twin of the Excel date hygiene, for the SAP staging path.

    Reads `production_order` (optional, only to name dropped rows),
    `basic_start_date`, `basic_finish_date`, `run_time` from each row dict and
    returns the surviving rows (a blank or unparseable finish, or a finish on an
    earlier date than the start, drops the row; a missing or unreadable start keeps it
    with `basic_start_date = None`; same warnings as the Excel path), each updated in
    place with the parsed `basic_start_date` / `basic_finish_date` (stored as received) /
    `run_time` plus `sap_basic_finish_date` and `_run_time_was_defaulted`.
    Other keys pass through untouched.
    """
    if not rows:
        return []
    df = pd.DataFrame({
        "_i": range(len(rows)),
        "PRODUCTION_ORDER": [r.get("production_order") for r in rows],
        "BASIC_START_DATE": [r.get("basic_start_date") for r in rows],
        "BASIC_FINISH_DATE": [r.get("basic_finish_date") for r in rows],
        "RUN_TIME": [r.get("run_time") for r in rows],
    })
    df = _date_hygiene_df(df, warnings)

    def _ts(val):
        return val.to_pydatetime() if pd.notna(val) else None

    out: list[dict] = []
    for _, h in df.iterrows():
        row = rows[int(h["_i"])]
        row["basic_start_date"] = _ts(h["BASIC_START_DATE"])
        row["basic_finish_date"] = _ts(h["BASIC_FINISH_DATE"])
        row["sap_basic_finish_date"] = _ts(h["_SAP_FINISH_DATE"])
        row["run_time"] = float(h["RUN_TIME"]) if pd.notna(h["RUN_TIME"]) else None
        row["_run_time_was_defaulted"] = bool(h["_RUN_TIME_DEFAULTED"])
        out.append(row)
    return out


def ingest_orders_from_excel(file_bytes: bytes, filename: str, diag: dict | None = None, *,
                             actor: str | None = None) -> dict:
    """
    Parse an uploaded sequence_testing-shaped xlsx, normalize/clean,
    upsert into orders, and write an upload_audit row.

    Returns: {status, batch_id, raw_row_count, inserted, updated, warnings}.

    `diag` (optional, caller-owned dict) is filled in as the ingest advances
    with `stage` and `rows` so a failure can be reported with where it died.
    No row contents are ever put in it.
    """
    diag = diag if diag is not None else {}
    diag["stage"] = "read_excel"
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
    diag["rows"] = raw_row_count
    diag["stage"] = "clean"
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

    # The finish is the one required date (backward scheduling OQ24/OQ25); the start is optional.
    required = {"PRODUCTION_ORDER", "MATERIAL_NUMBER", "BASIC_FINISH_DATE"}
    missing = required - set(df.columns)
    if missing:
        msg = f"Uploaded file is missing required columns: {sorted(missing)}"
        _write_failed_audit(filename, raw_row_count, msg)
        return {"status": "error",
                "message": msg,
                "raw_row_count": raw_row_count, "inserted": 0, "updated": 0,
                "warnings": [], "batch_id": batch_id}

    # 9 SAP COOIS extract fields — upload-sourced (unlike prt_01/prt_02/
    # production_version, which are NULL from upload and backfilled by
    # db._stamp_order_attributes). Numeric/integer columns coerced upfront
    # like qcol below so downstream _num/_int just check pd.notna.
    _SAP_NUMERIC_COLS = (
        "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)", "REDUCED_QUANTITY_(GMEIN)",
        "LABOR_HOURS_(MEINH)", "MACHINE_HOURS_(MEINH)", "NO_OF_FTE_(MEINH)",
    )
    _SAP_INTEGER_COLS = ("BOM_ALTERNATIVE", "BOM_USAGE")
    for col in _SAP_NUMERIC_COLS + _SAP_INTEGER_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Manual Excel upload only: Machine Hours (MEINH) wins over RUN_TIME when
    # present and > 0 (0 is treated as blank, matching resolver._fallback). Done
    # before date hygiene so _RUN_TIME_DEFAULTED follows the chosen value (the
    # finish itself is stored as received and never derived). Routing-on plants are unaffected because
    # upsert_orders nulls run_time for them; SAP staging never passes through
    # this function. Owner decision 2026-10-13.
    _mh_col = "MACHINE_HOURS_(MEINH)"
    if _mh_col in df.columns:
        _mh_mask = df[_mh_col].notna() & (df[_mh_col] > 0)
        if "RUN_TIME" not in df.columns:
            df["RUN_TIME"] = pd.Series(float("nan"), index=df.index, dtype="float64")
        df.loc[_mh_mask, "RUN_TIME"] = df.loc[_mh_mask, _mh_col]
        _mh_n = int(_mh_mask.sum())
        if _mh_n > 0:
            warnings.append({
                "level": "info",
                "msg": f"{_mh_n} row(s): run time taken from Machine Hours (MEINH)",
            })

    # A run time outside the database's representation bound (negative, 8,760 h or more, or not a
    # finite number) would fail the whole upsert chunk at the CHECK constraint. Reject that ROW, by
    # its spreadsheet row number, instead; everything else (including a run time over the 336 h cap,
    # which only queues the order) goes on to the upsert. Done before date hygiene resets the index,
    # so the row number is still the file's (the header is row 1).
    if "RUN_TIME" in df.columns:
        _rt_num = pd.to_numeric(df["RUN_TIME"], errors="coerce")
        _rt_bad = _rt_num.notna() & ~((_rt_num >= 0) & (_rt_num < RUN_TIME_REPRESENTATION_BOUND_HOURS))
        # U12: a routing-enabled plant ignores the file's RUN_TIME (upsert_orders nulls it; the resolver prices
        # the order), so a junk value there must not drop the row: it loads and the resolver prices it.
        if _rt_bad.any() and "PLANT" in df.columns:
            _bad_plants = sorted({_str_id(p) for p in df.loc[_rt_bad, "PLANT"].dropna().unique() if _str_id(p)})
            if _bad_plants:
                with _pool.connection() as _conn, _conn.cursor() as _cur:
                    _cur.execute("SELECT plant FROM plants WHERE plant = ANY(%s) AND routing_runtime_enabled = TRUE",
                                 (_bad_plants,))
                    _routing_plants = {r[0] for r in _cur.fetchall()}
                if _routing_plants:
                    _on_routing = df["PLANT"].map(lambda v: _str_id(v) in _routing_plants if pd.notna(v) else False)
                    _rt_bad = _rt_bad & ~_on_routing
        if _rt_bad.any():
            _bad_rows = df.index[_rt_bad].tolist()
            for _i in _bad_rows[:25]:
                _who = (_str_id(df.at[_i, "PRODUCTION_ORDER"]) if "PRODUCTION_ORDER" in df.columns else "")
                warnings.append({
                    "level": "error",
                    "msg": (f"Row {int(_i) + 2}{f' (order {_who})' if _who else ''} not loaded — run time "
                            f"{_rt_num.at[_i]:g} h is not between 0 and "
                            f"{RUN_TIME_REPRESENTATION_BOUND_HOURS:,.0f} hours."),
                })
            if len(_bad_rows) > 25:
                warnings.append({
                    "level": "error",
                    "msg": f"{len(_bad_rows) - 25} more row(s) not loaded — run time outside 0 to "
                           f"{RUN_TIME_REPRESENTATION_BOUND_HOURS:,.0f} hours.",
                })
            df = df.loc[~_rt_bad]

    diag["stage"] = "date_hygiene"
    df = _date_hygiene_df(df, warnings)

    qcol = "ORDER_QUANTITY_(GMEIN)"
    if qcol in df.columns:
        df[qcol] = pd.to_numeric(df[qcol], errors="coerce")
    diag["stage"] = "build_rows"

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
            "machine": _str_id(_v(r, "MACHINE")) or None,
            "plant": _str_id(_v(r, "PLANT")) or None,
            "basic_start_date": _ts(r["BASIC_START_DATE"]),
            "basic_finish_date": _ts(r["BASIC_FINISH_DATE"]),
            "sap_basic_finish_date": _ts(r["_SAP_FINISH_DATE"]),
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
            # SAP's own production version, for change detection: None when the
            # file has no such column ("not sent"), "" for a blank cell (SAP says
            # "no version" -> the material default applies).
            "sap_production_version": (
                None if "PRODUCTION_VERSION" not in df.columns
                else (str(_v(r, "PRODUCTION_VERSION")).strip().upper()
                      if _v(r, "PRODUCTION_VERSION") is not None else "")
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

    diag["stage"] = "upsert_orders"
    result = upsert_orders(
        rows,
        batch_id=batch_id,
        source="excel",
        filename=filename,
        raw_row_count=raw_row_count,
        warnings=warnings,
        plan_fn=distribution_data.plan,
        apply_fn=distribution_data.apply,
        resolve_fn=functools.partial(routing_resolver.resolve_orders, actor=actor or filename or "system"),
        actor=actor,
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
        "unchanged": result.get("unchanged", 0),
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


def distinct_order_values(plant: str, column: str) -> list[str]:
    """Every distinct non-blank value of `orders.<column>` at this plant,
    upper-cased and trimmed (the same normalization priority_list_coverage and
    the rank lookup use), alphabetical. Feeds the prefilled priority-list
    template download. `column` must come from the rankable-field registry
    (orders_column), never from the client — it is only quoted as an
    identifier here, not validated."""
    q = sql.SQL("""
        SELECT DISTINCT UPPER(TRIM(o.{col}))
          FROM orders o
         WHERE o.plant = %s
           AND o.{col} IS NOT NULL AND o.{col} <> ''
         ORDER BY 1
    """).format(col=sql.Identifier(column))
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(q, (plant,))
        return [r[0] for r in cur.fetchall() if r[0]]
