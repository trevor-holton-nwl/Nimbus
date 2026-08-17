"""Plant-scoped, versioned persistence for observation-only setup data.

This module deliberately owns setup definitions, matrix rows, physical line
state, and occurrence overrides only.  It never changes an order's schedule.
"""
from __future__ import annotations

from datetime import datetime
import json
from math import isfinite
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from psycopg.types.json import Jsonb

from db import _pool
from master_data import RANKABLE_FIELDS


MAX_SETUP_MINUTES = 10_080
_STATE_SOURCES = {"manual", "derived", "actual"}
_SOURCE_TRUST = {"derived": 1, "manual": 2, "actual": 3}


def _required_text(value, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    return value.strip()


def _optional_text(value, label: str) -> str | None:
    """Normalize an optional persisted identifier without turning null into an empty id."""
    if value is None:
        return None
    return _required_text(value, label)


def _normalise_fields(fields) -> list[str]:
    if not isinstance(fields, list) or not fields:
        raise ValueError("At least one registered setup field is required")
    result = []
    for field in fields:
        key = field.get("fieldKey") if isinstance(field, dict) else field
        if not isinstance(key, str) or key not in RANKABLE_FIELDS:
            raise ValueError(f"Unknown setup field: {key!r}")
        if key in result:
            raise ValueError(f"Duplicate setup field: {key}")
        result.append(key)
    return result


def _values_by_field(fields: list[str], values) -> dict[str, object]:
    if isinstance(values, dict):
        return values
    if isinstance(values, list):
        result = {}
        for entry in values:
            if not isinstance(entry, dict) or "fieldKey" not in entry:
                raise ValueError("State key entries require fieldKey and value")
            field_key = entry["fieldKey"]
            if field_key in result:
                raise ValueError(f"Duplicate state field: {field_key}")
            result[field_key] = entry.get("value")
        return result
    raise ValueError("State values must be an object or canonical key array")


def _normalise_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def derived_order_state_values(fields, color, prt01, prt02, production_version) -> dict[str, object]:
    """Return only the last order's attributes used by this setup definition.

    The pre-upload replacement snapshot reads all registered order attributes in
    one query, but a plant's setup signature can deliberately use a subset.
    Supplying the full row to ``canonical_state_key`` would correctly be
    rejected as an ambiguous state authored against another definition.
    """
    values = {
        "colorWheel": color,
        "prt01": prt01,
        "prt02": prt02,
        "productionVersion": production_version,
    }
    return {field: values[field] for field in _normalise_fields(fields)}


def canonical_state_key(fields, values) -> list[dict[str, str]]:
    """Return an unambiguous ordered JSON state key for a definition signature."""
    field_keys = _normalise_fields(fields)
    values_by_field = _values_by_field(field_keys, values)
    unknown = set(values_by_field) - set(field_keys)
    if unknown:
        raise ValueError(f"State has fields outside the setup definition: {sorted(unknown)}")
    missing = [field for field in field_keys if field not in values_by_field]
    if missing:
        raise ValueError(f"State is missing setup fields: {missing}")
    return [{"fieldKey": field, "value": _normalise_value(values_by_field[field])} for field in field_keys]


def validate_setup_minutes(value) -> int:
    """Validate a finite, whole-minute setup-matrix standard (maximum seven days)."""
    minutes = _validate_nonnegative_integer(value, "Setup minutes")
    if minutes > MAX_SETUP_MINUTES:
        raise ValueError(f"Setup minutes must be between 0 and {MAX_SETUP_MINUTES}")
    return minutes


def validate_override_minutes(value) -> int:
    """Validate a finite, whole-minute physical override without a seven-day cap."""
    return _validate_nonnegative_integer(value, "Override minutes")


def _validate_nonnegative_integer(value, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite integer")
    if isinstance(value, float):
        if not isfinite(value) or not value.is_integer():
            raise ValueError(f"{label} must be a finite integer")
        value = int(value)
    elif isinstance(value, str):
        if not value.strip().isdigit():
            raise ValueError(f"{label} must be a finite integer")
        value = int(value.strip())
    elif not isinstance(value, int):
        raise ValueError(f"{label} must be a finite integer")
    if value < 0:
        raise ValueError(f"{label} must be nonnegative")
    return value


def validate_signature_version(current_version, supplied_version) -> int:
    if isinstance(supplied_version, bool) or not isinstance(supplied_version, int):
        raise ValueError("A signature version is required")
    if supplied_version != current_version:
        raise ValueError("Setup signature version is stale")
    return supplied_version


def validate_matrix_rows(fields, rows, *, strict_blanks: bool = True) -> list[dict]:
    """Canonicalize a long-form import and reject duplicate transitions."""
    field_keys = _normalise_fields(fields)
    if not isinstance(rows, list):
        raise ValueError("Matrix rows must be a list")
    normalized = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each matrix row must be an object")
        from_values = row.get("from", row.get("from_key"))
        to_values = row.get("to", row.get("to_key"))
        from_key = canonical_state_key(field_keys, from_values)
        to_key = canonical_state_key(field_keys, to_values)
        if strict_blanks and any(not item["value"] for item in from_key + to_key):
            raise ValueError("Blank setup-state values are not allowed by this definition")
        transition = (repr(from_key), repr(to_key))
        if transition in seen:
            raise ValueError("Duplicate canonical setup-matrix transition")
        seen.add(transition)
        normalized.append({
            "from_key": from_key,
            "to_key": to_key,
            "setup_min": validate_setup_minutes(row.get("setup_min")),
            "source": row.get("source", "manual"),
            "source_metadata": row.get("source_metadata") or {},
            "source_reference": row.get("source_reference"),
        })
    return normalized


def last_completed_order(rows: list[dict], captured_at: datetime) -> dict | None:
    """Choose only the latest order complete at the exact capture instant."""
    eligible = [row for row in rows if row.get("completed_at") and row["completed_at"] <= captured_at]
    return max(eligible, key=lambda row: row["completed_at"], default=None)


def should_replace_line_state(existing: dict | None, observed_at: datetime, source: str) -> bool:
    """Keep physical state monotonic in both observed time and source trust."""
    if source not in _STATE_SOURCES:
        raise ValueError(f"Unknown line-state source: {source!r}")
    if not existing:
        return True
    prior_source = existing.get("source")
    prior_time = existing.get("observed_at")
    if prior_source not in _STATE_SOURCES or not isinstance(prior_time, datetime):
        return True
    if observed_at < prior_time:
        return False
    return _SOURCE_TRUST[source] >= _SOURCE_TRUST[prior_source]


def _definition(cur, plant: str, *, lock: bool = False) -> dict | None:
    cur.execute(
        "SELECT fields, signature_version, strict_blanks, active FROM setup_definition WHERE plant = %s"
        + (" FOR UPDATE" if lock else ""),
        (plant,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {"fields": row[0], "signature_version": int(row[1]), "strict_blanks": bool(row[2]), "active": bool(row[3])}


def _require_definition(cur, plant: str, signature_version: int, *, lock: bool = False) -> dict:
    definition = _definition(cur, plant, lock=lock)
    if definition is None:
        raise ValueError(f"No setup definition exists for plant {plant}")
    validate_signature_version(definition["signature_version"], signature_version)
    return definition


def set_definition_active(plant: str, active: bool, actor: str, *, expected_signature_version: int) -> dict:
    """Toggle whether the setup-aware optimizer paths are live for this plant."""
    plant = _required_text(plant, "Plant")
    actor = _required_text(actor, "Actor")
    if not isinstance(active, bool):
        raise ValueError("active must be boolean")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, expected_signature_version, lock=True)
        cur.execute(
            "UPDATE setup_definition SET active = %s, updated_by = %s, updated_at = NOW() WHERE plant = %s",
            (active, actor, plant),
        )
        conn.commit()
    return {"plant": plant, "fields": definition["fields"], "signature_version": definition["signature_version"],
            "strict_blanks": definition["strict_blanks"], "active": active}


def _assert_line_owned(cur, plant: str, line: str) -> None:
    cur.execute(
        "SELECT 1 FROM production_lines WHERE plant = %s AND production_line = %s LIMIT 1",
        (plant, line),
    )
    if cur.fetchone() is None:
        raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")


def save_definition(plant, fields, strict_blanks, actor, *, expected_signature_version=None) -> dict:
    """Create or edit a definition without rewriting any old-version keys."""
    plant = _required_text(plant, "Plant")
    actor = _required_text(actor, "Actor")
    field_keys = _normalise_fields(fields)
    if not isinstance(strict_blanks, bool):
        raise ValueError("strict_blanks must be boolean")
    with _pool.connection() as conn, conn.cursor() as cur:
        current = _definition(cur, plant, lock=True)
        if current is None:
            if expected_signature_version is not None:
                raise ValueError("No setup definition exists for the expected signature version")
            version = 1
            active = False
            cur.execute(
                """INSERT INTO setup_definition
                   (plant, fields, signature_version, strict_blanks, active, created_by, updated_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (plant, Jsonb(field_keys), version, strict_blanks, active, actor, actor),
            )
        else:
            if expected_signature_version is None:
                raise ValueError("An expected signature version is required")
            validate_signature_version(current["signature_version"], expected_signature_version)
        if current is not None and current["fields"] == field_keys and current["strict_blanks"] == strict_blanks:
            version = current["signature_version"]
            active = current["active"]
        elif current is not None:
            version = current["signature_version"] + 1
            active = False
            cur.execute(
                """UPDATE setup_definition
                   SET fields = %s, signature_version = %s, strict_blanks = %s,
                       active = FALSE, updated_by = %s, updated_at = NOW()
                   WHERE plant = %s""",
                (Jsonb(field_keys), version, strict_blanks, actor, plant),
            )
        conn.commit()
    return {"plant": plant, "fields": field_keys, "signature_version": version,
            "strict_blanks": strict_blanks, "active": active}


def _insert_matrix_rows(cur, plant: str, line: str, version: int, rows: list[dict], actor: str) -> None:
    for row in rows:
        source = row["source"]
        if source not in _STATE_SOURCES:
            raise ValueError(f"Unknown matrix source: {source!r}")
        cur.execute(
            """INSERT INTO setup_matrix
               (plant, line, signature_version, from_key, to_key, setup_min, source,
                source_metadata, source_reference, created_by, updated_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (plant, line, signature_version, from_key, to_key) DO UPDATE
               SET setup_min = EXCLUDED.setup_min, source = EXCLUDED.source,
                   source_metadata = EXCLUDED.source_metadata, source_reference = EXCLUDED.source_reference,
                   updated_by = EXCLUDED.updated_by, updated_at = NOW()""",
            (plant, line, version, Jsonb(row["from_key"]), Jsonb(row["to_key"]), row["setup_min"],
             source, Jsonb(row["source_metadata"]), row["source_reference"], actor, actor),
        )


def replace_plant_matrix(plant, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        cur.execute("DELETE FROM setup_matrix WHERE plant = %s AND line = '' AND signature_version = %s",
                    (plant, signature_version))
        _insert_matrix_rows(cur, plant, "", signature_version, normalized, actor)
        conn.commit()
    return {"plant": plant, "line": "", "signature_version": signature_version, "rows": len(normalized)}


def upsert_line_matrix_rows(plant, line, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        _insert_matrix_rows(cur, plant, line, signature_version, normalized, actor)
        conn.commit()
    return {"plant": plant, "line": line, "signature_version": signature_version, "rows": len(normalized)}


def delete_line_matrix_rows(plant, line, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        deleted = 0
        for row in normalized:
            cur.execute(
                """DELETE FROM setup_matrix WHERE plant = %s AND line = %s AND signature_version = %s
                   AND from_key = %s AND to_key = %s""",
                (plant, line, signature_version, Jsonb(row["from_key"]), Jsonb(row["to_key"])),
            )
            deleted += cur.rowcount
        conn.commit()
    return {"plant": plant, "line": line, "signature_version": signature_version, "deleted": deleted}


def delete_plant_matrix_rows(plant, rows, signature_version, actor) -> dict:
    """Delete specified plant-wide rows only; sparse line inheritance is untouched."""
    plant = _required_text(plant, "Plant")
    _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        deleted = 0
        for row in normalized:
            cur.execute(
                """DELETE FROM setup_matrix WHERE plant = %s AND line = '' AND signature_version = %s
                   AND from_key = %s AND to_key = %s""",
                (plant, signature_version, Jsonb(row["from_key"]), Jsonb(row["to_key"])),
            )
            deleted += cur.rowcount
        conn.commit()
    return {"plant": plant, "line": "", "signature_version": signature_version, "deleted": deleted}


def _set_line_state_cur(cur, plant: str, line: str, state_key: list[dict[str, str]], signature_version: int,
                        observed_at: datetime, source: str, reason: str | None, actor: str,
                        physical_mold_id: str | None = None) -> bool:
    cur.execute("SELECT observed_at, source FROM line_setup_state WHERE plant = %s AND line = %s FOR UPDATE",
                (plant, line))
    existing = cur.fetchone()
    if existing and not should_replace_line_state({"observed_at": existing[0], "source": existing[1]}, observed_at, source):
        return False
    cur.execute(
        """INSERT INTO line_setup_state
           (plant, line, state_key, signature_version, physical_mold_id, observed_at, source, reason,
            created_by, updated_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (plant, line) DO UPDATE
           SET state_key = EXCLUDED.state_key, signature_version = EXCLUDED.signature_version,
               physical_mold_id = EXCLUDED.physical_mold_id, observed_at = EXCLUDED.observed_at,
               source = EXCLUDED.source, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by,
               updated_at = NOW()""",
        (plant, line, Jsonb(state_key), signature_version, physical_mold_id, observed_at, source, reason, actor, actor),
    )
    return True


def set_line_state(plant, line, values, signature_version, observed_at, source, reason, actor,
                   physical_mold_id=None) -> dict:
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    if source not in _STATE_SOURCES:
        raise ValueError(f"Unknown line-state source: {source!r}")
    if source == "manual":
        reason = _required_text(reason, "Manual line-state reason")
    if not isinstance(observed_at, datetime):
        raise ValueError("observed_at must be a datetime")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        state_key = canonical_state_key(definition["fields"], values)
        if definition["strict_blanks"] and any(not item["value"] for item in state_key):
            raise ValueError("Blank setup-state values are not allowed by this definition")
        accepted = _set_line_state_cur(cur, plant, line, state_key, signature_version, observed_at,
                                       source, reason, actor, physical_mold_id)
        conn.commit()
    return {"plant": plant, "line": line, "accepted": accepted, "state_key": state_key,
            "signature_version": signature_version}


def _plant_local_capture(cur, plant: str, captured_at: datetime | None) -> datetime:
    if captured_at is None:
        cur.execute("SELECT timezone FROM plants WHERE plant = %s LIMIT 1", (plant,))
        row = cur.fetchone()
        try:
            return datetime.now(ZoneInfo(row[0])) .replace(tzinfo=None) if row and row[0] else datetime.now()
        except ZoneInfoNotFoundError:
            return datetime.now()
    if captured_at.tzinfo is None:
        return captured_at
    cur.execute("SELECT timezone FROM plants WHERE plant = %s LIMIT 1", (plant,))
    row = cur.fetchone()
    try:
        return captured_at.astimezone(ZoneInfo(row[0])).replace(tzinfo=None) if row and row[0] else captured_at.replace(tzinfo=None)
    except ZoneInfoNotFoundError:
        return captured_at.replace(tzinfo=None)


def derive_line_state_before_replacement(plant, line, *, captured_at: datetime | None = None,
                                         actor: str = "system", reason: str = "schedule replacement") -> dict:
    """Capture the last already-completed planned order before its source can disappear."""
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _definition(cur, plant, lock=True)
        if definition is None:
            conn.commit()
            return {"plant": plant, "line": line, "accepted": False, "reason": "no_definition"}
        captured_local = _plant_local_capture(cur, plant, captured_at)
        cur.execute(
            """SELECT o.id, o.color, o.prt_01, o.prt_02, o.production_version,
                      COALESCE(seg.last_end,
                        COALESCE(o.scheduled_start, o.basic_start_date)
                          + (o.run_time * INTERVAL '1 hour'),
                        o.scheduled_end, o.basic_finish_date) AS completed_at
                 FROM orders o
                 LEFT JOIN LATERAL (
                    SELECT MAX(scheduled_end) AS last_end FROM order_schedule_segments
                    WHERE order_id = o.id
                 ) seg ON TRUE
                WHERE o.plant = %s AND o.production_line = %s
                  AND COALESCE(seg.last_end,
                        COALESCE(o.scheduled_start, o.basic_start_date)
                          + (o.run_time * INTERVAL '1 hour'),
                        o.scheduled_end, o.basic_finish_date) <= %s
                ORDER BY completed_at DESC, o.id DESC LIMIT 1""",
            (plant, line, captured_local),
        )
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return {"plant": plant, "line": line, "accepted": False, "reason": "no_completed_order"}
        values = derived_order_state_values(definition["fields"], row[1], row[2], row[3], row[4])
        state_key = canonical_state_key(definition["fields"], values)
        if definition["strict_blanks"] and any(not item["value"] for item in state_key):
            conn.commit()
            return {"plant": plant, "line": line, "accepted": False, "reason": "incomplete_state"}
        accepted = _set_line_state_cur(
            cur, plant, line, state_key, definition["signature_version"], row[5], "derived",
            f"Derived immediately before {reason} from planned order {row[0]}", actor,
        )
        conn.commit()
    return {"plant": plant, "line": line, "accepted": accepted, "order_id": row[0],
            "captured_at": captured_local, "completed_at": row[5], "state_key": state_key,
            "signature_version": definition["signature_version"]}


def capture_setup_states_before_schedule_mutation(*, actor: str = "system", reason: str) -> list[dict]:
    """Capture each existing setup-defined line immediately before a schedule mutation."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT DISTINCT o.plant, p.timezone, o.production_line FROM orders o
                 JOIN setup_definition d ON d.plant = o.plant
                 JOIN production_lines pl ON pl.plant = o.plant AND pl.production_line = o.production_line
                 LEFT JOIN plants p ON p.plant = o.plant
                WHERE o.plant IS NOT NULL AND o.production_line IS NOT NULL"""
        )
        pairs = cur.fetchall()
    captures: dict[str, datetime] = {}
    results = []
    for plant, timezone_name, line in pairs:
        if plant not in captures:
            try:
                captures[plant] = (datetime.now(ZoneInfo(timezone_name)).replace(tzinfo=None)
                                   if timezone_name else datetime.now())
            except ZoneInfoNotFoundError:
                captures[plant] = datetime.now()
        results.append(derive_line_state_before_replacement(
            plant, line, captured_at=captures[plant], actor=actor, reason=reason
        ))
    return results


def upsert_occurrence_override(plant, line, predecessor_order_id, successor_order_id, predecessor_values,
                               successor_values, standard_min, remaining_min, signature_version, reason, actor) -> dict:
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override reason")
    # ``None`` is the meaningful initial-state predecessor.  The API layer
    # rejects an omitted key separately; once the key is present, preserve its
    # explicit JSON null all the way through the parameterized INSERT.
    predecessor_order_id = _optional_text(predecessor_order_id, "Predecessor order id")
    successor_order_id = _required_text(successor_order_id, "Successor order id")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        predecessor_key = canonical_state_key(definition["fields"], predecessor_values)
        successor_key = canonical_state_key(definition["fields"], successor_values)
        if definition["strict_blanks"] and any(not item["value"] for item in predecessor_key + successor_key):
            raise ValueError("Blank setup-state values are not allowed by this definition")
        standard = validate_override_minutes(standard_min)
        remaining = validate_override_minutes(remaining_min)
        cur.execute(
            """UPDATE setup_occurrence_override SET status = 'replaced', updated_by = %s, updated_at = NOW()
                 WHERE plant = %s AND line = %s AND signature_version = %s
                   AND predecessor_order_id IS NOT DISTINCT FROM %s AND successor_order_id = %s
                   AND predecessor_state_key = %s AND successor_state_key = %s AND status = 'active'""",
            (actor, plant, line, signature_version, predecessor_order_id, successor_order_id,
             Jsonb(predecessor_key), Jsonb(successor_key)),
        )
        cur.execute(
            """INSERT INTO setup_occurrence_override
               (plant, line, signature_version, predecessor_order_id, successor_order_id,
                predecessor_state_key, successor_state_key, standard_min, remaining_min, status,
                reason, created_by, updated_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s, %s, %s)
               RETURNING id""",
            (plant, line, signature_version, predecessor_order_id, successor_order_id,
             Jsonb(predecessor_key), Jsonb(successor_key), standard, remaining, reason, actor, actor),
        )
        override_id = int(cur.fetchone()[0])
        conn.commit()
    return {"id": override_id, "plant": plant, "line": line, "signature_version": signature_version,
            "standard_min": standard, "remaining_min": remaining, "status": "active"}


def update_occurrence_override(plant, line, override_id, standard_min, remaining_min,
                               signature_version, reason, actor) -> dict:
    """Update the identified active override without changing its bound adjacency."""
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override reason")
    if isinstance(override_id, bool) or not isinstance(override_id, int) or override_id <= 0:
        raise ValueError("A positive override id is required")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        cur.execute(
            """SELECT signature_version, status FROM setup_occurrence_override
                 WHERE id = %s AND plant = %s AND line = %s FOR UPDATE""",
            (override_id, plant, line),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Setup override does not belong to this plant and line")
        if int(existing[0]) != definition["signature_version"]:
            raise ValueError("Setup override signature version is stale")
        if existing[1] != "active":
            raise ValueError("Setup override is not active")
        standard = validate_override_minutes(standard_min)
        remaining = validate_override_minutes(remaining_min)
        cur.execute(
            """UPDATE setup_occurrence_override
                 SET standard_min = %s, remaining_min = %s, reason = %s, updated_by = %s, updated_at = NOW()
                 WHERE id = %s AND plant = %s AND line = %s AND status = 'active'""",
            (standard, remaining, reason, actor, override_id, plant, line),
        )
        conn.commit()
    return {"id": override_id, "plant": plant, "line": line, "signature_version": signature_version,
            "standard_min": standard, "remaining_min": remaining, "status": existing[1]}


def clear_occurrence_override(plant, line, override_id, signature_version, actor, reason) -> dict:
    plant = _required_text(plant, "Plant")
    line = _required_text(line, "Line")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override clear reason")
    if isinstance(override_id, bool) or not isinstance(override_id, int) or override_id <= 0:
        raise ValueError("A positive override id is required")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_line_owned(cur, plant, line)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        cur.execute(
            """SELECT signature_version FROM setup_occurrence_override
                 WHERE id = %s AND plant = %s AND line = %s FOR UPDATE""",
            (override_id, plant, line),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Setup override does not belong to this plant and line")
        if int(existing[0]) != definition["signature_version"]:
            raise ValueError("Setup override signature version is stale")
        cur.execute(
            """UPDATE setup_occurrence_override
                 SET status = 'cleared', reason = %s, updated_by = %s, updated_at = NOW()
                 WHERE id = %s AND plant = %s AND line = %s AND status = 'active'""",
            (reason, actor, override_id, plant, line),
        )
        cleared = cur.rowcount == 1
        conn.commit()
    return {"id": override_id, "plant": plant, "line": line, "cleared": cleared,
            "signature_version": signature_version}


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def current_signature_version(plant: str) -> int | None:
    """Return the current signature version for a plant, or None if no definition exists.

    Lightweight lookup: single-row query only, no matrix/state/override data.
    Used by clients that need the version to scope subsequent bounded fetches.
    """
    plant = _required_text(plant, "Plant")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _definition(cur, plant, lock=False)
        return definition["signature_version"] if definition else None


def get_setup_snapshot(plant: str) -> dict:
    """Return exactly one plant's versioned setup truth; no cross-plant rows leak."""
    plant = _required_text(plant, "Plant")
    with _pool.connection() as conn, conn.cursor() as cur:
        # One repeatable-read transaction prevents a definition edit from
        # interleaving with its version-filtered dependent rows mid-snapshot.
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        definition = _definition(cur, plant)
        if definition is None:
            return {"plant": plant, "definition": None, "plant_rows": [], "line_rows": [],
                    "line_states": [], "overrides": []}
        version = definition["signature_version"]
        cur.execute(
            """SELECT line, signature_version, from_key, to_key, setup_min, source, source_metadata,
                      source_reference, created_by, created_at, updated_by, updated_at
                 FROM setup_matrix WHERE plant = %s AND signature_version = %s ORDER BY line, from_key, to_key""",
            (plant, version),
        )
        matrix = [
            {"line": r[0], "signature_version": int(r[1]), "from_key": r[2], "to_key": r[3],
             "setup_min": int(r[4]), "source": r[5], "source_metadata": r[6], "source_reference": r[7],
             "created_by": r[8], "created_at": _iso(r[9]), "updated_by": r[10], "updated_at": _iso(r[11])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT line, state_key, signature_version, physical_mold_id, observed_at, source, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM line_setup_state WHERE plant = %s AND signature_version = %s ORDER BY line""", (plant, version)
        )
        states = [
            {"line": r[0], "state_key": r[1], "signature_version": int(r[2]), "physical_mold_id": r[3],
             "observed_at": _iso(r[4]), "source": r[5], "reason": r[6], "created_by": r[7],
             "created_at": _iso(r[8]), "updated_by": r[9], "updated_at": _iso(r[10])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT id, line, signature_version, predecessor_order_id, successor_order_id,
                      predecessor_state_key, successor_state_key, standard_min, remaining_min, status, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM setup_occurrence_override
                WHERE plant = %s AND signature_version = %s AND status IN ('active', 'inactive') ORDER BY id""",
            (plant, version),
        )
        overrides = [
            {"id": int(r[0]), "line": r[1], "signature_version": int(r[2]),
             "predecessor_order_id": r[3], "successor_order_id": r[4],
             "predecessor_state_key": r[5], "successor_state_key": r[6], "standard_min": int(r[7]),
             "remaining_min": int(r[8]), "status": r[9], "reason": r[10], "created_by": r[11],
             "created_at": _iso(r[12]), "updated_by": r[13], "updated_at": _iso(r[14])}
            for r in cur.fetchall()
        ]
    definition = {**definition, "plant": plant}
    return {"plant": plant, "definition": definition,
            "plant_rows": [row for row in matrix if row["line"] == ""],
            "line_rows": [row for row in matrix if row["line"] != ""],
            "line_states": states, "overrides": overrides}


# ---------------------------------------------------------------------------
# Stage 0 shadow coverage.  These functions are intentionally pure: callers
# supply their observed adjacency/state samples and receive diagnostics only.
# They never write schedules, setup rows, or caches.

def _coverage_state(definition: dict, value) -> list[dict[str, str]] | None:
    """Return a complete canonical state suitable for coverage, else None."""
    try:
        state = canonical_state_key(definition["fields"], value)
    except (KeyError, ValueError, TypeError):
        return None
    if definition.get("strict_blanks", True) and any(not item["value"] for item in state):
        return None
    return state


def _state_token(state: list[dict[str, str]]) -> str:
    return json.dumps(state, sort_keys=True, separators=(",", ":"))


def _coverage_row(rows: list[dict], line: str, version: int, from_key: list[dict[str, str]],
                  to_key: list[dict[str, str]]) -> dict | None:
    """Resolve line scope before plant scope, mirroring the domain contract."""
    for scope in (line, ""):
        for row in rows:
            if (row.get("line", "") == scope and row.get("signature_version") == version
                    and row.get("from_key") == from_key and row.get("to_key") == to_key):
                return row
    return None


def _coverage_pair(definition: dict, rows: list[dict], line: str, from_key, to_key) -> dict | None:
    from_state = _coverage_state(definition, from_key)
    to_state = _coverage_state(definition, to_key)
    if from_state is None or to_state is None:
        return None
    row = _coverage_row(rows, line, definition["signature_version"], from_state, to_state)
    scope = "line" if row and row.get("line") else "plant"
    covered = row is not None or from_state == to_state
    return {
        "line": line,
        "scope": scope,
        "from_key": from_state,
        "to_key": to_state,
        "covered": covered,
        "implicit_zero": row is None and from_state == to_state,
    }


def _coverage_summary(pairs: list[dict]) -> dict:
    missing = [pair for pair in pairs if not pair["covered"]]
    return {"total_pairs": len(pairs), "covered_pairs": len(pairs) - len(missing),
            "missing_pairs": len(missing), "missing": missing}


def build_setup_coverage(definition: dict, plant_rows: list[dict], line_rows: list[dict],
                         observed_transitions: list[dict], reachable_states: dict[str, list]) -> dict:
    """Build deduplicated observed/reachable coverage without mutating inputs.

    `observed_transitions` supplies actual schedule adjacencies. `reachable_states`
    supplies the valid state universe per line; its Cartesian product is the
    prospective search surface. Explicit matrix rows win at line scope, then
    plant scope, then a complete diagonal is implicitly covered at zero.
    """
    if not isinstance(definition, dict) or not isinstance(definition.get("signature_version"), int):
        raise ValueError("A versioned setup definition is required")
    rows = [*plant_rows, *line_rows]

    def unique(items):
        seen: set[tuple[str, str, str]] = set()
        result: list[dict] = []
        for item in items:
            line = item.get("line")
            if not isinstance(line, str) or not line:
                continue
            pair = _coverage_pair(definition, rows, line, item.get("from_key"), item.get("to_key"))
            if pair is None:
                continue
            key = (line, _state_token(pair["from_key"]), _state_token(pair["to_key"]))
            if key not in seen:
                seen.add(key)
                result.append(pair)
        return result

    observed = unique(observed_transitions)
    reachable_candidates: list[dict] = []
    for line in sorted(reachable_states):
        valid: dict[str, list[dict[str, str]]] = {}
        for state in reachable_states[line]:
            canonical = _coverage_state(definition, state)
            if canonical is not None:
                valid.setdefault(_state_token(canonical), canonical)
        for from_state in valid.values():
            for to_state in valid.values():
                reachable_candidates.append({"line": line, "from_key": from_state, "to_key": to_state})
    reachable = unique(reachable_candidates)
    return {"observed": _coverage_summary(observed), "reachable": _coverage_summary(reachable)}


def page_missing_pairs(rows: list[dict], *, line: str | None = None, offset: int = 0, limit: int = 100) -> dict:
    """Return a bounded, stable page of missing pairs for UI and CSV callers."""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    filtered = [row for row in rows if line is None or row.get("line") == line]
    return {"rows": filtered[offset:offset + limit],
            "meta": {"total": len(filtered), "offset": offset, "limit": limit}}


def page_matrix_rows(plant: str, line: str, signature_version: int, *, from_key: list | None = None,
                     offset: int = 0, limit: int = 100) -> dict:
    """Return one bounded, from-state-scoped page of effective matrix rows.

    Scoped by line (plant-default rows plus this one line's overrides) so a
    List view never has to load every line's recorded rows for the whole
    plant, unlike get_setup_snapshot. When from_key is supplied the SQL WHERE
    filters on it directly (JSONB equality on the canonical, deterministically
    ordered key), so the common "rows starting from one state" case is a
    narrow, indexed lookup rather than a fetch-then-filter.
    """
    plant = _required_text(plant, "Plant")
    line = line or ""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    with _pool.connection() as conn, conn.cursor() as cur:
        _require_definition(cur, plant, signature_version, lock=False)
        where = ["plant = %s", "signature_version = %s", "line IN ('', %s)"]
        params: list = [plant, signature_version, line]
        if from_key is not None:
            where.append("from_key = %s")
            params.append(Jsonb(from_key))
        clause = " AND ".join(where)
        cur.execute(
            f"SELECT line, from_key, to_key, setup_min, source FROM setup_matrix "
            f"WHERE {clause} ORDER BY from_key, to_key, line DESC",
            params,
        )
        raw = cur.fetchall()
    # Merge line-over-plant inheritance in Python — the raw set is already
    # bounded to one line's scope (plus plant-default) by the SQL above, so
    # this mirrors the client's effectiveRows() at a scale the query already
    # narrowed, not a second unbounded fetch.
    plant_by_key: dict[str, dict] = {}
    line_by_key: dict[str, dict] = {}
    for r in raw:
        key = f"{json.dumps(r[1], sort_keys=True)} {json.dumps(r[2], sort_keys=True)}"
        entry = {"from_key": r[1], "to_key": r[2], "setup_min": int(r[3]), "source": r[4]}
        if r[0] == "":
            plant_by_key[key] = entry
        else:
            line_by_key[key] = entry
    merged: dict[str, dict] = {}
    for key, entry in plant_by_key.items():
        merged[key] = {**entry, "inherited": not line, "plant_value": entry["setup_min"]}
    for key, entry in line_by_key.items():
        plant_value = plant_by_key.get(key, {}).get("setup_min")
        merged[key] = {**entry, "inherited": False, "plant_value": plant_value}
    rows = list(merged.values())
    total = len(rows)
    return {"plant": plant, "line": line, "signature_version": signature_version,
            "rows": rows[offset:offset + limit],
            "meta": {"total": total, "offset": offset, "limit": limit}}


def get_setup_coverage(plant: str) -> dict:
    """Measure one plant's current schedule transitions without mutating it."""
    snapshot = get_setup_snapshot(plant)
    definition = snapshot["definition"]
    if definition is None:
        return {"plant": plant, "definition": None,
                "observed": _coverage_summary([]), "reachable": _coverage_summary([])}
    # Every selected column is chosen from the registered, server-owned field
    # catalog, never from an HTTP parameter.
    columns = [RANKABLE_FIELDS[field]["orders_column"] for field in definition["fields"]]
    select_attributes = ", ".join(columns)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"""SELECT production_line, COALESCE(scheduled_start, basic_start_date),
                       {select_attributes}
                  FROM orders
                 WHERE plant = %s AND production_line IS NOT NULL
                 ORDER BY production_line, COALESCE(scheduled_start, basic_start_date), id""",
            (plant,),
        )
        by_line: dict[str, list[list[dict[str, str]]]] = {}
        for row in cur.fetchall():
            line = row[0]
            if not line:
                continue
            values = {field: row[index + 2] for index, field in enumerate(definition["fields"])}
            state = _coverage_state(definition, values)
            if state is not None:
                by_line.setdefault(line, []).append(state)
    transitions: list[dict] = []
    for line, states in by_line.items():
        transitions.extend({"line": line, "from_key": states[index - 1], "to_key": states[index]}
                           for index in range(1, len(states)))
    result = build_setup_coverage(definition, snapshot["plant_rows"], snapshot["line_rows"], transitions, by_line)
    return {"plant": plant, "definition": definition, **result}
