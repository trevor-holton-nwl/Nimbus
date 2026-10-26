"""Persistence + validation for per-plant shared alert profiles and alert acknowledgements.

No FastAPI imports: routes (Task 3) map ValueError/DuplicateName to HTTP errors.
Datetimes cross this API as naive ISO strings (columns are TIMESTAMP, not TIMESTAMPTZ).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from db import _pool

# Mirrors the AlertType union in frontend/platform/types.mts, minus the types that
# never fire ('near-capacity', 'line_no_calendar').
ALERT_TYPES: frozenset[str] = frozenset({
    "overlap", "overload", "closed", "blackout", "firmed-closed", "firmed-out-of-hours",
    "runtime-schedule-mismatch", "tool-conflict",
    "setup-violated", "setup-uncovered", "initial-state-unknown", "current-state-diverged",
    "override-inactive", "predecessor-state-unknown", "successor-state-unknown",
    "distribution-separation", "runtime-unknown", "pv-lot-size",
    "late", "finish_moved_earlier", "reversal_forward", "plant_no_timezone",
    "placement_exception", "setup_override_orphaned", "pull_floor_crossed",
    "frozen_window_crossed", "run_time_zero", "no_operating_window", "no_anchor",
    "derivation_issue", "queued_now_fits", "needs_planning",
})
RANKINGS: frozenset[str] = frozenset({"impact", "time", "severity", "orders"})
MAX_RULES = 20
MAX_NAME_LEN = 60
DAY_BOUND = 365
_SEVERITIES = (None, "warn", "err")


class DuplicateName(ValueError):
    """A profile with this name already exists for the plant."""


def ensure_alert_profile_tables() -> None:
    """Idempotent bootstrap (mirrors migrations/2026-10-20-2-alert-profiles.sql and schema.sql)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS alert_profile (
                id TEXT PRIMARY KEY, plant TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                rules JSONB NOT NULL DEFAULT '[]'::jsonb,
                ranking TEXT NOT NULL DEFAULT 'impact' CHECK (ranking IN ('impact','time','severity','orders')),
                created_by TEXT, updated_by TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                CONSTRAINT chk_alert_profile_rules CHECK (jsonb_typeof(rules) = 'array'),
                CONSTRAINT uq_alert_profile_plant_name UNIQUE (plant, name))
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_alert_profile_plant ON alert_profile(plant, name)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS alert_ack (
                plant TEXT NOT NULL, alert_id TEXT NOT NULL, acknowledged_by TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '', until TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (plant, alert_id))
        """)
        conn.commit()


# --------------------------------------------------------------------------- validation

def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _day(rule: dict, key: str, idx: int):
    v = rule.get(key)
    if v is None:
        return None
    if not _is_int(v):
        raise ValueError(f"Rule {idx}: {key} must be an integer or null")
    if not -DAY_BOUND <= v <= DAY_BOUND:
        raise ValueError(f"Rule {idx}: {key} must be between -{DAY_BOUND} and {DAY_BOUND}")
    return v


def validate_rules(rules) -> list[dict]:
    """Return the normalised rule list or raise ValueError."""
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")
    if not rules:
        raise ValueError("A profile needs at least one rule")
    if len(rules) > MAX_RULES:
        raise ValueError(f"A profile may have at most {MAX_RULES} rules")
    out = []
    for i, rule in enumerate(rules, 1):
        if not isinstance(rule, dict):
            raise ValueError(f"Rule {i} must be an object")
        types = rule.get("types")
        if types is not None:
            if not isinstance(types, list) or not types:
                raise ValueError(f"Rule {i}: types must be null or a non-empty list")
            for t in types:
                if not isinstance(t, str) or t not in ALERT_TYPES:
                    raise ValueError(f"Rule {i}: Unknown alert type {t!r}")
            types = list(dict.fromkeys(types))
        day_from, day_to = _day(rule, "dayFrom", i), _day(rule, "dayTo", i)
        if day_from is not None and day_to is not None and day_from > day_to:
            raise ValueError(f"Rule {i}: dayFrom must be <= dayTo")
        min_sev = rule.get("minSev")
        if min_sev not in _SEVERITIES:
            raise ValueError(f"Rule {i}: minSev must be null, 'warn' or 'err'")
        late = rule.get("minLateHours")
        if late is not None:
            if isinstance(late, bool) or not isinstance(late, (int, float)) or late != late \
                    or late in (float("inf"), float("-inf")) or late < 0:
                raise ValueError(f"Rule {i}: minLateHours must be null or a number >= 0")
        out.append({"types": types, "dayFrom": day_from, "dayTo": day_to,
                    "minSev": min_sev, "minLateHours": late})
    return out


def validate_ranking(ranking) -> str:
    if ranking not in RANKINGS:
        raise ValueError(f"ranking must be one of {sorted(RANKINGS)}")
    return ranking


def _validate_name(name) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name is required")
    name = name.strip()
    if len(name) > MAX_NAME_LEN:
        raise ValueError(f"name must be at most {MAX_NAME_LEN} characters")
    return name


def _require_plant(plant) -> str:
    if not isinstance(plant, str) or not plant.strip():
        raise ValueError("plant is required")
    return plant


# --------------------------------------------------------------------------- profiles

_PROFILE_COLS = "id, plant, name, description, rules, ranking, created_by, updated_by, created_at, updated_at"


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _profile_row(r) -> dict:
    return {"id": r[0], "plant": r[1], "name": r[2], "description": r[3], "rules": r[4],
            "ranking": r[5], "created_by": r[6], "updated_by": r[7],
            "created_at": _iso(r[8]), "updated_at": _iso(r[9])}


def _audit(cur, table: str, action: str, details: dict, actor) -> None:
    cur.execute(
        "INSERT INTO admin_audit (table_name, action, details, user_email) VALUES (%s, %s, %s, %s)",
        (table, action, Jsonb(details), actor),
    )


def list_alert_profiles(plant: str) -> list[dict]:
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {_PROFILE_COLS} FROM alert_profile WHERE plant = %s ORDER BY lower(name), id", (plant,))
        return [_profile_row(r) for r in cur.fetchall()]


def get_alert_profile(profile_id: str) -> dict | None:
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT {_PROFILE_COLS} FROM alert_profile WHERE id = %s", (profile_id,))
        r = cur.fetchone()
        return _profile_row(r) if r else None


def create_alert_profile(*, plant, name, rules, ranking, description="", actor) -> dict:
    plant = _require_plant(plant)
    name = _validate_name(name)
    rules = validate_rules(rules)
    ranking = validate_ranking(ranking)
    description = (description or "").strip() if isinstance(description, (str, type(None))) else str(description)
    pid = uuid.uuid4().hex
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO alert_profile (id, plant, name, description, rules, ranking, created_by, updated_by)"
                f" VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {_PROFILE_COLS}",
                (pid, plant, name, description, Jsonb(rules), ranking, actor, actor),
            )
            row = _profile_row(cur.fetchone())
            _audit(cur, "alert_profile", "create", {"plant": plant, "id": pid, "name": name}, actor)
            conn.commit()
            return row
    except pg_errors.UniqueViolation as e:
        raise DuplicateName(f"A profile named {name!r} already exists for this plant") from e


def update_alert_profile(profile_id, *, name=None, rules=None, ranking=None, description=None,
                         actor, expected_updated_at: str | None = None) -> dict | None:
    """Patch the supplied fields. Returns None if the profile does not exist; raises
    ValueError('stale') when expected_updated_at no longer matches the row."""
    new_name = _validate_name(name) if name is not None else None
    new_rules = validate_rules(rules) if rules is not None else None
    new_ranking = validate_ranking(ranking) if ranking is not None else None
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(f"SELECT {_PROFILE_COLS} FROM alert_profile WHERE id = %s FOR UPDATE", (profile_id,))
            r = cur.fetchone()
            if not r:
                return None
            current = _profile_row(r)
            if expected_updated_at is not None and current["updated_at"] != expected_updated_at:
                raise ValueError("stale")
            merged = {
                "name": new_name if new_name is not None else current["name"],
                "rules": new_rules if new_rules is not None else current["rules"],
                "ranking": new_ranking if new_ranking is not None else current["ranking"],
                "description": (description or "").strip() if description is not None else current["description"],
            }
            cur.execute(
                "UPDATE alert_profile SET name = %s, description = %s, rules = %s, ranking = %s,"
                " updated_by = %s, updated_at = NOW() WHERE id = %s"
                f" RETURNING {_PROFILE_COLS}",
                (merged["name"], merged["description"], Jsonb(merged["rules"]), merged["ranking"], actor, profile_id),
            )
            row = _profile_row(cur.fetchone())
            _audit(cur, "alert_profile", "update",
                   {"plant": row["plant"], "id": profile_id, "name": row["name"]}, actor)
            conn.commit()
            return row
    except pg_errors.UniqueViolation as e:
        raise DuplicateName(f"A profile named {new_name!r} already exists for this plant") from e


def delete_alert_profile(profile_id, *, actor) -> dict | None:
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM alert_profile WHERE id = %s RETURNING {_PROFILE_COLS}", (profile_id,))
        r = cur.fetchone()
        if not r:
            return None
        row = _profile_row(r)
        _audit(cur, "alert_profile", "delete", {"plant": row["plant"], "id": profile_id, "name": row["name"]}, actor)
        conn.commit()
        return row


# --------------------------------------------------------------------------- acknowledgements

_ACK_COLS = "plant, alert_id, acknowledged_by, reason, until, created_at"

# `until` is a naive plant-local wall-clock end-of-day (the client sends `YYYY-MM-DDT23:59:59`), so expiry is judged
# against the plant's local "now", not the DB session zone (UTC on Azure). The plant's IANA zone comes from
# `plants.timezone` (one value per plant; blank or unset falls back to UTC, the same convention as the SAP views).
# One bind parameter: the plant.
_PLANT_NOW_SQL = ("(NOW() AT TIME ZONE COALESCE("
                  "NULLIF((SELECT MIN(timezone) FROM plants WHERE plant = %s), ''), 'UTC'))")


def _ack_row(r) -> dict:
    return {"plant": r[0], "alert_id": r[1], "acknowledged_by": r[2], "reason": r[3],
            "until": _iso(r[4]), "created_at": _iso(r[5])}


def list_alert_acks(plant: str) -> list[dict]:
    """Active acknowledgements only (no expiry, or expiry in the future)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT {_ACK_COLS} FROM alert_ack WHERE plant = %s AND (until IS NULL OR until > {_PLANT_NOW_SQL})"
            " ORDER BY alert_id", (plant, plant))
        return [_ack_row(r) for r in cur.fetchall()]


def _parse_until(until):
    if until is None or isinstance(until, datetime):
        return until
    if isinstance(until, str):
        try:
            return datetime.fromisoformat(until)
        except ValueError as e:
            raise ValueError("until must be an ISO datetime or null") from e
    raise ValueError("until must be an ISO datetime or null")


def upsert_alert_ack(*, plant, alert_id, reason="", until=None, actor) -> dict:
    plant = _require_plant(plant)
    if not isinstance(alert_id, str) or not alert_id.strip():
        raise ValueError("alert_id is required")
    until = _parse_until(until)
    reason = reason or ""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"DELETE FROM alert_ack WHERE plant = %s AND until IS NOT NULL AND until <= {_PLANT_NOW_SQL}",
            (plant, plant))
        cur.execute(
            "INSERT INTO alert_ack (plant, alert_id, acknowledged_by, reason, until)"
            " VALUES (%s, %s, %s, %s, %s)"
            " ON CONFLICT (plant, alert_id) DO UPDATE SET acknowledged_by = EXCLUDED.acknowledged_by,"
            " reason = EXCLUDED.reason, until = EXCLUDED.until, created_at = NOW()"
            f" RETURNING {_ACK_COLS}",
            (plant, alert_id, actor, reason, until),
        )
        row = _ack_row(cur.fetchone())
        _audit(cur, "alert_ack", "ack", {"plant": plant, "alert_id": alert_id, "name": alert_id}, actor)
        conn.commit()
        return row


def upsert_alert_acks(*, plant, alert_ids, reason="", until=None, actor) -> list[dict]:
    """Acknowledge many alerts of one plant in a single transaction (one purge, one multi-row upsert, one audit
    row). Duplicate ids collapse and ids are written in sorted order. Returns the active acks for those ids, ordered by alert_id (the
    `list_alert_acks` shape)."""
    plant = _require_plant(plant)
    if not isinstance(alert_ids, (list, tuple)) or not alert_ids:
        raise ValueError("alert_ids must be a non-empty list")
    if any(not isinstance(a, str) or not a.strip() for a in alert_ids):
        raise ValueError("alert_ids must be non-empty strings")
    # Sorted (and de-duplicated) so concurrent overlapping bulk acks take row locks in one global order (no deadlock).
    ids = sorted(set(alert_ids))
    until = _parse_until(until)
    reason = reason or ""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"DELETE FROM alert_ack WHERE plant = %s AND until IS NOT NULL AND until <= {_PLANT_NOW_SQL}",
            (plant, plant))
        cur.execute(
            "INSERT INTO alert_ack (plant, alert_id, acknowledged_by, reason, until)"
            " SELECT %s, x, %s, %s, %s FROM unnest(%s::text[]) AS x"
            " ON CONFLICT (plant, alert_id) DO UPDATE SET acknowledged_by = EXCLUDED.acknowledged_by,"
            " reason = EXCLUDED.reason, until = EXCLUDED.until, created_at = NOW()",
            (plant, actor, reason, until, ids))
        cur.execute(
            f"SELECT {_ACK_COLS} FROM alert_ack WHERE plant = %s AND alert_id = ANY(%s)"
            f" AND (until IS NULL OR until > {_PLANT_NOW_SQL}) ORDER BY alert_id",
            (plant, ids, plant))
        rows = [_ack_row(r) for r in cur.fetchall()]
        _audit(cur, "alert_ack", "ack", {"plant": plant, "count": len(ids), "alert_ids": ids[:50]}, actor)
        conn.commit()
        return rows


def delete_alert_ack(plant, alert_id, *, actor) -> bool:
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM alert_ack WHERE plant = %s AND alert_id = %s", (plant, alert_id))
        removed = cur.rowcount > 0
        if removed:
            _audit(cur, "alert_ack", "unack", {"plant": plant, "alert_id": alert_id, "name": alert_id}, actor)
        conn.commit()
        return removed
