"""Plant-scoped, versioned persistence for observation-only setup data.

This module deliberately owns setup definitions, matrix rows, physical machine
state, and occurrence overrides only.  It never changes an order's schedule.
"""
from __future__ import annotations

from datetime import datetime
import json
from math import isfinite
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from psycopg.types.json import Jsonb

from db import _pool
from master_data import CONFIGURABLE_PRIORITY_FIELDS, RANKABLE_FIELDS


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


def _normalise_fields(fields, *, allowed_fields=RANKABLE_FIELDS) -> list[str]:
    if not isinstance(fields, list) or not fields:
        raise ValueError("At least one registered setup field is required")
    result = []
    for field in fields:
        key = field.get("fieldKey") if isinstance(field, dict) else field
        if not isinstance(key, str) or key not in allowed_fields:
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
    """Canonicalize one setup-attribute value: trimmed and uppercased, so a
    hand-typed "Black" and an ingested "BLACK" resolve to the same JSONB
    state-key value. Booleans return early above (lowercase "true"/"false",
    matching the TS side's String(true)/String(false)) and never reach the
    final line, so they are exempt from the uppercase fold.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().upper()


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


def should_replace_machine_state(existing: dict | None, observed_at: datetime, source: str) -> bool:
    """Keep physical state monotonic in both observed time and source trust."""
    if source not in _STATE_SOURCES:
        raise ValueError(f"Unknown machine-state source: {source!r}")
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
    """VESTIGIAL BUT RETAINED (Workstream D2, 2026-08-20): setup_definition.active
    used to be the "include setup times in optimizer" gate. It no longer is —
    that flag now lives on plants.setup_active (master_data.set_plant_setup_active
    / PUT /plant/{plant}/setup-active), a durable plant-level setting instead of
    one that resets to FALSE on every signature-version bump. This function and
    its column are kept, unread by any gate, because removing them expands the
    change's blast radius for no behavioral benefit."""
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


def _assert_machine_owned(cur, plant: str, machine: str) -> None:
    cur.execute(
        "SELECT 1 FROM machine WHERE plant = %s AND machine = %s LIMIT 1",
        (plant, machine),
    )
    if cur.fetchone() is None:
        raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")


def save_definition(plant, fields, strict_blanks, actor, *, expected_signature_version=None) -> dict:
    """Create or edit a definition without rewriting any old-version keys.

    The force-reset-to-FALSE-on-signature-bump `active` logic below is kept
    verbatim even though `active` is now vestigial (see set_definition_active's
    docstring) — plants.setup_active, not this column, is the real optimizer
    gate as of Workstream D2 (2026-08-20)."""
    plant = _required_text(plant, "Plant")
    actor = _required_text(actor, "Actor")
    field_keys = _normalise_fields(fields, allowed_fields=CONFIGURABLE_PRIORITY_FIELDS)
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


def _insert_matrix_rows(cur, plant: str, machine: str, version: int, rows: list[dict], actor: str) -> None:
    for row in rows:
        source = row["source"]
        if source not in _STATE_SOURCES:
            raise ValueError(f"Unknown matrix source: {source!r}")
        cur.execute(
            """INSERT INTO setup_matrix
               (plant, machine, signature_version, from_key, to_key, setup_min, source,
                source_metadata, source_reference, created_by, updated_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (plant, machine, signature_version, from_key, to_key) DO UPDATE
               SET setup_min = EXCLUDED.setup_min, source = EXCLUDED.source,
                   source_metadata = EXCLUDED.source_metadata, source_reference = EXCLUDED.source_reference,
                   updated_by = EXCLUDED.updated_by, updated_at = NOW()""",
            (plant, machine, version, Jsonb(row["from_key"]), Jsonb(row["to_key"]), row["setup_min"],
             source, Jsonb(row["source_metadata"]), row["source_reference"], actor, actor),
        )


def replace_plant_matrix(plant, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        cur.execute("DELETE FROM setup_matrix WHERE plant = %s AND machine = '' AND signature_version = %s",
                    (plant, signature_version))
        _insert_matrix_rows(cur, plant, "", signature_version, normalized, actor)
        conn.commit()
    return {"plant": plant, "machine": "", "signature_version": signature_version, "rows": len(normalized)}


def upsert_machine_matrix_rows(plant, machine, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        _insert_matrix_rows(cur, plant, machine, signature_version, normalized, actor)
        conn.commit()
    return {"plant": plant, "machine": machine, "signature_version": signature_version, "rows": len(normalized)}


def delete_machine_matrix_rows(plant, machine, rows, signature_version, actor) -> dict:
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        deleted = 0
        for row in normalized:
            cur.execute(
                """DELETE FROM setup_matrix WHERE plant = %s AND machine = %s AND signature_version = %s
                   AND from_key = %s AND to_key = %s""",
                (plant, machine, signature_version, Jsonb(row["from_key"]), Jsonb(row["to_key"])),
            )
            deleted += cur.rowcount
        conn.commit()
    return {"plant": plant, "machine": machine, "signature_version": signature_version, "deleted": deleted}


def delete_plant_matrix_rows(plant, rows, signature_version, actor) -> dict:
    """Delete specified plant-wide rows only; sparse machine inheritance is untouched."""
    plant = _required_text(plant, "Plant")
    _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, signature_version, lock=True)
        normalized = validate_matrix_rows(definition["fields"], rows, strict_blanks=definition["strict_blanks"])
        deleted = 0
        for row in normalized:
            cur.execute(
                """DELETE FROM setup_matrix WHERE plant = %s AND machine = '' AND signature_version = %s
                   AND from_key = %s AND to_key = %s""",
                (plant, signature_version, Jsonb(row["from_key"]), Jsonb(row["to_key"])),
            )
            deleted += cur.rowcount
        conn.commit()
    return {"plant": plant, "machine": "", "signature_version": signature_version, "deleted": deleted}


def _set_machine_state_cur(cur, plant: str, machine: str, state_key: list[dict[str, str]], signature_version: int,
                        observed_at: datetime, source: str, reason: str | None, actor: str,
                        physical_mold_id: str | None = None) -> bool:
    cur.execute("SELECT observed_at, source FROM machine_setup_state WHERE plant = %s AND machine = %s FOR UPDATE",
                (plant, machine))
    existing = cur.fetchone()
    if existing and not should_replace_machine_state({"observed_at": existing[0], "source": existing[1]}, observed_at, source):
        return False
    cur.execute(
        """INSERT INTO machine_setup_state
           (plant, machine, state_key, signature_version, physical_mold_id, observed_at, source, reason,
            created_by, updated_by)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (plant, machine) DO UPDATE
           SET state_key = EXCLUDED.state_key, signature_version = EXCLUDED.signature_version,
               physical_mold_id = EXCLUDED.physical_mold_id, observed_at = EXCLUDED.observed_at,
               source = EXCLUDED.source, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by,
               updated_at = NOW()""",
        (plant, machine, Jsonb(state_key), signature_version, physical_mold_id, observed_at, source, reason, actor, actor),
    )
    return True


def set_machine_state(plant, machine, values, signature_version, observed_at, source, reason, actor,
                   physical_mold_id=None) -> dict:
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    if source not in _STATE_SOURCES:
        raise ValueError(f"Unknown machine-state source: {source!r}")
    if source == "manual":
        reason = _required_text(reason, "Manual machine-state reason")
    if not isinstance(observed_at, datetime):
        raise ValueError("observed_at must be a datetime")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        state_key = canonical_state_key(definition["fields"], values)
        if definition["strict_blanks"] and any(not item["value"] for item in state_key):
            raise ValueError("Blank setup-state values are not allowed by this definition")
        accepted = _set_machine_state_cur(cur, plant, machine, state_key, signature_version, observed_at,
                                       source, reason, actor, physical_mold_id)
        conn.commit()
    return {"plant": plant, "machine": machine, "accepted": accepted, "state_key": state_key,
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


def derive_machine_state_before_replacement(plant, machine, *, captured_at: datetime | None = None,
                                         actor: str = "system", reason: str = "schedule replacement") -> dict:
    """Capture the last already-completed planned order before its source can disappear."""
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _definition(cur, plant, lock=True)
        if definition is None:
            conn.commit()
            return {"plant": plant, "machine": machine, "accepted": False, "reason": "no_definition"}
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
                WHERE o.plant = %s AND o.machine = %s
                  AND COALESCE(seg.last_end,
                        COALESCE(o.scheduled_start, o.basic_start_date)
                          + (o.run_time * INTERVAL '1 hour'),
                        o.scheduled_end, o.basic_finish_date) <= %s
                ORDER BY completed_at DESC, o.id DESC LIMIT 1""",
            (plant, machine, captured_local),
        )
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return {"plant": plant, "machine": machine, "accepted": False, "reason": "no_completed_order"}
        values = derived_order_state_values(definition["fields"], row[1], row[2], row[3], row[4])
        state_key = canonical_state_key(definition["fields"], values)
        if definition["strict_blanks"] and any(not item["value"] for item in state_key):
            conn.commit()
            return {"plant": plant, "machine": machine, "accepted": False, "reason": "incomplete_state"}
        accepted = _set_machine_state_cur(
            cur, plant, machine, state_key, definition["signature_version"], row[5], "derived",
            f"Derived immediately before {reason} from planned order {row[0]}", actor,
        )
        conn.commit()
    return {"plant": plant, "machine": machine, "accepted": accepted, "order_id": row[0],
            "captured_at": captured_local, "completed_at": row[5], "state_key": state_key,
            "signature_version": definition["signature_version"]}


def capture_setup_states_before_schedule_mutation(*, actor: str = "system", reason: str,
                                                   plants: list[str] | None = None) -> list[dict]:
    """Capture each existing setup-defined machine immediately before a schedule mutation.

    ``plants``, when provided, scopes the scan to just those plants (avoiding an
    all-plants/all-machines sequential scan when only a subset is being mutated).
    ``None`` preserves the original unscoped, all-plants behavior byte-for-byte.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        query = """SELECT DISTINCT o.plant, p.timezone, o.machine FROM orders o
                 JOIN setup_definition d ON d.plant = o.plant
                 JOIN machine m ON m.plant = o.plant AND m.machine = o.machine
                 LEFT JOIN plants p ON p.plant = o.plant
                WHERE o.plant IS NOT NULL AND o.machine IS NOT NULL"""
        params: list = []
        if plants is not None:
            query += " AND o.plant = ANY(%s)"
            params.append(plants)
        cur.execute(query, params)
        pairs = cur.fetchall()
    captures: dict[str, datetime] = {}
    results = []
    for plant, timezone_name, machine in pairs:
        if plant not in captures:
            try:
                captures[plant] = (datetime.now(ZoneInfo(timezone_name)).replace(tzinfo=None)
                                   if timezone_name else datetime.now())
            except ZoneInfoNotFoundError:
                captures[plant] = datetime.now()
        results.append(derive_machine_state_before_replacement(
            plant, machine, captured_at=captures[plant], actor=actor, reason=reason
        ))
    return results


def upsert_occurrence_override(plant, machine, predecessor_order_id, successor_order_id, predecessor_values,
                               successor_values, standard_min, remaining_min, signature_version, reason, actor) -> dict:
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override reason")
    # ``None`` is the meaningful initial-state predecessor.  The API layer
    # rejects an omitted key separately; once the key is present, preserve its
    # explicit JSON null all the way through the parameterized INSERT.
    predecessor_order_id = _optional_text(predecessor_order_id, "Predecessor order id")
    successor_order_id = _required_text(successor_order_id, "Successor order id")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        predecessor_key = canonical_state_key(definition["fields"], predecessor_values)
        successor_key = canonical_state_key(definition["fields"], successor_values)
        if definition["strict_blanks"] and any(not item["value"] for item in predecessor_key + successor_key):
            raise ValueError("Blank setup-state values are not allowed by this definition")
        standard = validate_override_minutes(standard_min)
        remaining = validate_override_minutes(remaining_min)
        cur.execute(
            """UPDATE setup_occurrence_override SET status = 'replaced', updated_by = %s, updated_at = NOW()
                 WHERE plant = %s AND machine = %s AND signature_version = %s
                   AND predecessor_order_id IS NOT DISTINCT FROM %s AND successor_order_id = %s
                   AND predecessor_state_key = %s AND successor_state_key = %s AND status = 'active'""",
            (actor, plant, machine, signature_version, predecessor_order_id, successor_order_id,
             Jsonb(predecessor_key), Jsonb(successor_key)),
        )
        cur.execute(
            """INSERT INTO setup_occurrence_override
               (plant, machine, signature_version, predecessor_order_id, successor_order_id,
                predecessor_state_key, successor_state_key, standard_min, remaining_min, status,
                reason, created_by, updated_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s, %s, %s)
               RETURNING id""",
            (plant, machine, signature_version, predecessor_order_id, successor_order_id,
             Jsonb(predecessor_key), Jsonb(successor_key), standard, remaining, reason, actor, actor),
        )
        override_id = int(cur.fetchone()[0])
        conn.commit()
    return {"id": override_id, "plant": plant, "machine": machine, "signature_version": signature_version,
            "standard_min": standard, "remaining_min": remaining, "status": "active"}


def update_occurrence_override(plant, machine, override_id, standard_min, remaining_min,
                               signature_version, reason, actor) -> dict:
    """Update the identified active override without changing its bound adjacency."""
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override reason")
    if isinstance(override_id, bool) or not isinstance(override_id, int) or override_id <= 0:
        raise ValueError("A positive override id is required")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        cur.execute(
            """SELECT signature_version, status FROM setup_occurrence_override
                 WHERE id = %s AND plant = %s AND machine = %s FOR UPDATE""",
            (override_id, plant, machine),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Setup override does not belong to this plant and machine")
        if int(existing[0]) != definition["signature_version"]:
            raise ValueError("Setup override signature version is stale")
        if existing[1] != "active":
            raise ValueError("Setup override is not active")
        standard = validate_override_minutes(standard_min)
        remaining = validate_override_minutes(remaining_min)
        cur.execute(
            """UPDATE setup_occurrence_override
                 SET standard_min = %s, remaining_min = %s, reason = %s, updated_by = %s, updated_at = NOW()
                 WHERE id = %s AND plant = %s AND machine = %s AND status = 'active'""",
            (standard, remaining, reason, actor, override_id, plant, machine),
        )
        conn.commit()
    return {"id": override_id, "plant": plant, "machine": machine, "signature_version": signature_version,
            "standard_min": standard, "remaining_min": remaining, "status": existing[1]}


def clear_occurrence_override(plant, machine, override_id, signature_version, actor, reason) -> dict:
    plant = _required_text(plant, "Plant")
    machine = _required_text(machine, "Machine")
    actor = _required_text(actor, "Actor")
    reason = _required_text(reason, "Occurrence override clear reason")
    if isinstance(override_id, bool) or not isinstance(override_id, int) or override_id <= 0:
        raise ValueError("A positive override id is required")
    with _pool.connection() as conn, conn.cursor() as cur:
        _assert_machine_owned(cur, plant, machine)
        definition = _require_definition(cur, plant, signature_version, lock=True)
        cur.execute(
            """SELECT signature_version FROM setup_occurrence_override
                 WHERE id = %s AND plant = %s AND machine = %s FOR UPDATE""",
            (override_id, plant, machine),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Setup override does not belong to this plant and machine")
        if int(existing[0]) != definition["signature_version"]:
            raise ValueError("Setup override signature version is stale")
        cur.execute(
            """UPDATE setup_occurrence_override
                 SET status = 'cleared', reason = %s, updated_by = %s, updated_at = NOW()
                 WHERE id = %s AND plant = %s AND machine = %s AND status = 'active'""",
            (reason, actor, override_id, plant, machine),
        )
        cleared = cur.rowcount == 1
        conn.commit()
    return {"id": override_id, "plant": plant, "machine": machine, "cleared": cleared,
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
    """Return exactly one plant's versioned setup truth; no cross-plant rows leak.

    machine_rows/machine_states/overrides are scoped to the plant's LIVE
    machine roster (registered in master data for this plant, or already
    appearing on a loaded order for this plant) -- not every machine code
    that has ever recorded a setup-matrix row for this plant. This bounds
    the payload to the plant's actual current machine count (the Production
    Scale Roadmap's "70+ machines per plant" target) instead of an unbounded
    historical superset that can accumulate renamed/decommissioned/typo'd
    machine codes over time -- see Code_Review_09_01.md P1-9. plant_rows
    (machine = '') are the single plant-default fallback tier and are never
    machine-scoped -- every machine on the plant inherits from them.

    A machine that is neither registered nor yet on a loaded order (e.g. a
    brand-new machine added to master data and immediately assigned a task
    within the same session, before the next snapshot refetch) resolves to
    setup-domain.mts's existing 'uncovered' fallback rather than a wrong
    non-zero value -- the same honest fallback a genuinely unconfigured
    machine already gets today.
    """
    plant = _required_text(plant, "Plant")
    with _pool.connection() as conn, conn.cursor() as cur:
        # One repeatable-read transaction prevents a definition edit from
        # interleaving with its version-filtered dependent rows mid-snapshot.
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        definition = _definition(cur, plant)
        if definition is None:
            return {"plant": plant, "definition": None, "plant_rows": [], "machine_rows": [],
                    "machine_states": [], "overrides": []}
        version = definition["signature_version"]
        cur.execute(
            """SELECT machine FROM machine WHERE plant = %s
               UNION
               SELECT DISTINCT machine FROM orders WHERE plant = %s AND machine IS NOT NULL""",
            (plant, plant),
        )
        live_machines = [r[0] for r in cur.fetchall()]
        cur.execute(
            """SELECT machine, signature_version, from_key, to_key, setup_min, source, source_metadata,
                      source_reference, created_by, created_at, updated_by, updated_at
                 FROM setup_matrix
                WHERE plant = %s AND signature_version = %s AND (machine = '' OR machine = ANY(%s))
                ORDER BY machine, from_key, to_key""",
            (plant, version, live_machines),
        )
        matrix = [
            {"machine": r[0], "signature_version": int(r[1]), "from_key": r[2], "to_key": r[3],
             "setup_min": int(r[4]), "source": r[5], "source_metadata": r[6], "source_reference": r[7],
             "created_by": r[8], "created_at": _iso(r[9]), "updated_by": r[10], "updated_at": _iso(r[11])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT machine, state_key, signature_version, physical_mold_id, observed_at, source, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM machine_setup_state
                WHERE plant = %s AND signature_version = %s AND machine = ANY(%s)
                ORDER BY machine""", (plant, version, live_machines)
        )
        states = [
            {"machine": r[0], "state_key": r[1], "signature_version": int(r[2]), "physical_mold_id": r[3],
             "observed_at": _iso(r[4]), "source": r[5], "reason": r[6], "created_by": r[7],
             "created_at": _iso(r[8]), "updated_by": r[9], "updated_at": _iso(r[10])}
            for r in cur.fetchall()
        ]
        cur.execute(
            """SELECT id, machine, signature_version, predecessor_order_id, successor_order_id,
                      predecessor_state_key, successor_state_key, standard_min, remaining_min, status, reason,
                      created_by, created_at, updated_by, updated_at
                 FROM setup_occurrence_override
                WHERE plant = %s AND signature_version = %s AND status IN ('active', 'inactive')
                  AND machine = ANY(%s)
                ORDER BY id""",
            (plant, version, live_machines),
        )
        overrides = [
            {"id": int(r[0]), "machine": r[1], "signature_version": int(r[2]),
             "predecessor_order_id": r[3], "successor_order_id": r[4],
             "predecessor_state_key": r[5], "successor_state_key": r[6], "standard_min": int(r[7]),
             "remaining_min": int(r[8]), "status": r[9], "reason": r[10], "created_by": r[11],
             "created_at": _iso(r[12]), "updated_by": r[13], "updated_at": _iso(r[14])}
            for r in cur.fetchall()
        ]
    definition = {**definition, "plant": plant}
    return {"plant": plant, "definition": definition,
            "plant_rows": [row for row in matrix if row["machine"] == ""],
            "machine_rows": [row for row in matrix if row["machine"] != ""],
            "machine_states": states, "overrides": overrides}


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


def _coverage_row(rows: list[dict], machine: str, version: int, from_key: list[dict[str, str]],
                  to_key: list[dict[str, str]]) -> dict | None:
    """Resolve machine scope before plant scope, mirroring the domain contract."""
    for scope in (machine, ""):
        for row in rows:
            if (row.get("machine", "") == scope and row.get("signature_version") == version
                    and row.get("from_key") == from_key and row.get("to_key") == to_key):
                return row
    return None


def _coverage_pair(definition: dict, rows: list[dict], machine: str, from_key, to_key) -> dict | None:
    from_state = _coverage_state(definition, from_key)
    to_state = _coverage_state(definition, to_key)
    if from_state is None or to_state is None:
        return None
    row = _coverage_row(rows, machine, definition["signature_version"], from_state, to_state)
    scope = "machine" if row and row.get("machine") else "plant"
    covered = row is not None or from_state == to_state
    return {
        "machine": machine,
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


def build_setup_coverage(definition: dict, plant_rows: list[dict], machine_rows: list[dict],
                         observed_transitions: list[dict], reachable_states: dict[str, list]) -> dict:
    """Build deduplicated observed/reachable coverage without mutating inputs.

    `observed_transitions` supplies actual schedule adjacencies. `reachable_states`
    supplies the valid state universe per machine; its Cartesian product is the
    prospective search surface. Explicit matrix rows win at machine scope, then
    plant scope, then a complete diagonal is implicitly covered at zero.
    """
    if not isinstance(definition, dict) or not isinstance(definition.get("signature_version"), int):
        raise ValueError("A versioned setup definition is required")
    rows = [*plant_rows, *machine_rows]

    def unique(items):
        seen: set[tuple[str, str, str]] = set()
        result: list[dict] = []
        for item in items:
            machine = item.get("machine")
            if not isinstance(machine, str) or not machine:
                continue
            pair = _coverage_pair(definition, rows, machine, item.get("from_key"), item.get("to_key"))
            if pair is None:
                continue
            key = (machine, _state_token(pair["from_key"]), _state_token(pair["to_key"]))
            if key not in seen:
                seen.add(key)
                result.append(pair)
        return result

    observed = unique(observed_transitions)
    reachable_candidates: list[dict] = []
    for machine in sorted(reachable_states):
        valid: dict[str, list[dict[str, str]]] = {}
        for state in reachable_states[machine]:
            canonical = _coverage_state(definition, state)
            if canonical is not None:
                valid.setdefault(_state_token(canonical), canonical)
        for from_state in valid.values():
            for to_state in valid.values():
                reachable_candidates.append({"machine": machine, "from_key": from_state, "to_key": to_state})
    reachable = unique(reachable_candidates)
    return {"observed": _coverage_summary(observed), "reachable": _coverage_summary(reachable)}


def page_missing_pairs(rows: list[dict], *, machine: str | None = None, offset: int = 0, limit: int = 100) -> dict:
    """Return a bounded, stable page of missing pairs for UI and CSV callers."""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    filtered = [row for row in rows if machine is None or row.get("machine") == machine]
    return {"rows": filtered[offset:offset + limit],
            "meta": {"total": len(filtered), "offset": offset, "limit": limit}}


def page_matrix_rows(plant: str, machine: str, signature_version: int, *, from_key: list | None = None,
                     offset: int = 0, limit: int = 100) -> dict:
    """Return one bounded, from-state-scoped page of effective matrix rows.

    Scoped by machine (plant-default rows plus this one machine's overrides) so a
    List view never has to load every machine's recorded rows for the whole
    plant, unlike get_setup_snapshot. When from_key is supplied the SQL WHERE
    filters on it directly (JSONB equality on the canonical, deterministically
    ordered key), so the common "rows starting from one state" case is a
    narrow, indexed lookup rather than a fetch-then-filter.
    """
    plant = _required_text(plant, "Plant")
    machine = machine or ""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    with _pool.connection() as conn, conn.cursor() as cur:
        definition = _require_definition(cur, plant, signature_version, lock=False)
        where = ["plant = %s", "signature_version = %s", "machine IN ('', %s)"]
        params: list = [plant, signature_version, machine]
        if from_key is not None:
            # from_key arrives already decomposed into the canonical [{fieldKey,
            # value}] shape (brain.py just json.loads'd a query string), but its
            # values are raw caller input — a hand-typed "Black" must still match
            # a stored, already-folded "BLACK" key, so route it through the same
            # canonicalization every write path uses before the JSONB equality
            # comparison, instead of comparing byte-wise against stored keys.
            canonical_from_key = canonical_state_key(definition["fields"], from_key)
            where.append("from_key = %s")
            params.append(Jsonb(canonical_from_key))
        clause = " AND ".join(where)
        cur.execute(
            f"SELECT machine, from_key, to_key, setup_min, source FROM setup_matrix "
            f"WHERE {clause} ORDER BY from_key, to_key, machine DESC",
            params,
        )
        raw = cur.fetchall()
    # Merge machine-over-plant inheritance in Python — the raw set is already
    # bounded to one machine's scope (plus plant-default) by the SQL above, so
    # this mirrors the client's effectiveRows() at a scale the query already
    # narrowed, not a second unbounded fetch.
    plant_by_key: dict[str, dict] = {}
    machine_by_key: dict[str, dict] = {}
    for r in raw:
        key = f"{json.dumps(r[1], sort_keys=True)} {json.dumps(r[2], sort_keys=True)}"
        entry = {"from_key": r[1], "to_key": r[2], "setup_min": int(r[3]), "source": r[4]}
        if r[0] == "":
            plant_by_key[key] = entry
        else:
            machine_by_key[key] = entry
    merged: dict[str, dict] = {}
    for key, entry in plant_by_key.items():
        merged[key] = {**entry, "inherited": not machine, "plant_value": entry["setup_min"]}
    for key, entry in machine_by_key.items():
        plant_value = plant_by_key.get(key, {}).get("setup_min")
        merged[key] = {**entry, "inherited": False, "plant_value": plant_value}
    rows = list(merged.values())
    total = len(rows)
    return {"plant": plant, "machine": machine, "signature_version": signature_version,
            "rows": rows[offset:offset + limit],
            "meta": {"total": total, "offset": offset, "limit": limit}}


_COVERAGE_PAGE_LIMIT = 500
_COVERAGE_SCAN_SIZE = 500


def _load_setup_coverage(cur, plant: str) -> dict:
    """Load only the current definition and linear order-state inputs needed by coverage."""
    plant = _required_text(plant, "Plant")
    definition = _definition(cur, plant)
    if definition is None:
        return {"plant": plant, "definition": None, "states": [], "observed": []}
    definition = {**definition, "plant": plant}
    # Every selected identifier comes from the server-owned field registry,
    # never from an HTTP parameter. Values and plant scope remain bound.
    columns = [RANKABLE_FIELDS[field]["orders_column"] for field in definition["fields"]]
    select_attributes = ", ".join(columns)
    cur.execute(
        f"""SELECT machine, COALESCE(scheduled_start, basic_start_date),
                   {select_attributes}
              FROM orders
             WHERE plant = %s AND machine IS NOT NULL
             ORDER BY machine, COALESCE(scheduled_start, basic_start_date), id""",
        (plant,),
    )
    by_machine: dict[str, list[list[dict[str, str]]]] = {}
    for row in cur.fetchall():
        machine = row[0]
        if not machine:
            continue
        values = {field: row[index + 2] for index, field in enumerate(definition["fields"])}
        state = _coverage_state(definition, values)
        if state is not None:
            by_machine.setdefault(machine, []).append(state)

    state_rows: list[dict] = []
    observed_rows: list[dict] = []
    pair_order = 0
    for machine_order, machine in enumerate(sorted(by_machine)):
        scheduled_states = by_machine[machine]
        unique_states: dict[str, list[dict[str, str]]] = {}
        for state in scheduled_states:
            unique_states.setdefault(_state_token(state), state)
        for state_order, state in enumerate(unique_states.values()):
            state_rows.append({"machine": machine, "state_key": state,
                               "machine_order": machine_order, "state_order": state_order})

        seen_pairs: set[tuple[str, str]] = set()
        for index in range(1, len(scheduled_states)):
            from_key = scheduled_states[index - 1]
            to_key = scheduled_states[index]
            token = (_state_token(from_key), _state_token(to_key))
            if token in seen_pairs:
                continue
            seen_pairs.add(token)
            observed_rows.append({"machine": machine, "from_key": from_key, "to_key": to_key,
                                  "pair_order": pair_order})
            pair_order += 1
    return {"plant": plant, "definition": definition, "states": state_rows, "observed": observed_rows}


def _coverage_counts(cur, context: dict) -> dict[str, dict[str, dict[str, int]]]:
    cached = context.get("_coverage_counts")
    if isinstance(cached, dict):
        return cached
    definition = context.get("definition")
    counts: dict[str, dict[str, dict[str, int]]] = {"observed": {}, "reachable": {}}
    if definition is None:
        context["_coverage_counts"] = counts
        return counts

    states_by_machine: dict[str, int] = {}
    for row in context["states"]:
        states_by_machine[row["machine"]] = states_by_machine.get(row["machine"], 0) + 1
    observed_by_machine: dict[str, int] = {}
    for row in context["observed"]:
        observed_by_machine[row["machine"]] = observed_by_machine.get(row["machine"], 0) + 1
    for machine, total in observed_by_machine.items():
        counts["observed"][machine] = {"total": total, "covered": 0}
    for machine, state_count in states_by_machine.items():
        counts["reachable"][machine] = {"total": state_count * state_count, "covered": 0}

    cur.execute(
        """/* setup coverage summary */
        WITH state_input AS (
            SELECT machine, state_key
              FROM jsonb_to_recordset(%s::jsonb)
                   AS state(machine text, state_key jsonb, machine_order integer, state_order integer)
        ),
        observed_input AS (
            SELECT machine, from_key, to_key
              FROM jsonb_to_recordset(%s::jsonb)
                   AS pair(machine text, from_key jsonb, to_key jsonb, pair_order integer)
        ),
        effective_rows AS (
            SELECT DISTINCT target.machine, matrix.from_key, matrix.to_key
              FROM (SELECT DISTINCT machine FROM state_input) AS target
              JOIN setup_matrix AS matrix
                ON matrix.plant = %s
               AND matrix.signature_version = %s
               AND matrix.machine IN ('', target.machine)
             WHERE EXISTS (
                       SELECT 1 FROM state_input AS source_state
                        WHERE source_state.machine = target.machine
                          AND source_state.state_key = matrix.from_key
                   )
               AND EXISTS (
                       SELECT 1 FROM state_input AS target_state
                        WHERE target_state.machine = target.machine
                          AND target_state.state_key = matrix.to_key
                   )
               AND (
                   matrix.machine = target.machine
                   OR NOT EXISTS (
                       SELECT 1 FROM setup_matrix AS override
                        WHERE override.plant = matrix.plant
                          AND override.signature_version = matrix.signature_version
                          AND override.machine = target.machine
                          AND override.from_key = matrix.from_key
                          AND override.to_key = matrix.to_key
                   )
               )
        ),
        reachable_counts AS (
            SELECT machine, COUNT(*)::bigint AS state_count
              FROM state_input GROUP BY machine
        )
        SELECT 'observed', pair.machine,
               COUNT(*) FILTER (
                   WHERE pair.from_key = pair.to_key
                      OR EXISTS (
                          SELECT 1 FROM effective_rows AS effective
                           WHERE effective.machine = pair.machine
                             AND effective.from_key = pair.from_key
                             AND effective.to_key = pair.to_key
                      )
               )::bigint AS covered
          FROM observed_input AS pair
         GROUP BY pair.machine
        UNION ALL
        SELECT 'reachable', reachable.machine,
               (reachable.state_count + COUNT(effective.from_key) FILTER (
                   WHERE effective.from_key <> effective.to_key
               ))::bigint AS covered
          FROM reachable_counts AS reachable
          LEFT JOIN effective_rows AS effective ON effective.machine = reachable.machine
         GROUP BY reachable.machine, reachable.state_count""",
        (Jsonb(context["states"]), Jsonb(context["observed"]),
         context["plant"], definition["signature_version"]),
    )
    for kind, machine, covered in cur.fetchall():
        if kind in counts and machine in counts[kind]:
            counts[kind][machine]["covered"] = int(covered)
    context["_coverage_counts"] = counts
    return counts


def _summarize_setup_coverage(cur, context: dict) -> dict:
    """Return wire-compatible totals without constructing reachable state pairs."""
    counts = _coverage_counts(cur, context)

    def summary(kind: str) -> dict:
        total = sum(item["total"] for item in counts[kind].values())
        covered = sum(item["covered"] for item in counts[kind].values())
        return {"total_pairs": total, "covered_pairs": covered, "missing_pairs": total - covered}

    return {"plant": context["plant"], "definition": context.get("definition"),
            "observed": summary("observed"), "reachable": summary("reachable")}


def _validate_coverage_page(offset: int, limit: int) -> None:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _COVERAGE_PAGE_LIMIT:
        raise ValueError(f"limit must be between 1 and {_COVERAGE_PAGE_LIMIT}")


def _coverage_page_row(machine, from_key, to_key) -> dict:
    return {"machine": machine, "scope": "plant", "from_key": from_key, "to_key": to_key,
            "covered": False, "implicit_zero": False}


def _states_by_machine(context: dict) -> dict[str, list[list[dict[str, str]]]]:
    grouped: dict[str, list[dict]] = {}
    for row in context["states"]:
        grouped.setdefault(row["machine"], []).append(row)
    return {
        machine: [row["state_key"] for row in sorted(rows, key=lambda row: row["state_order"])]
        for machine, rows in sorted(grouped.items(), key=lambda item: min(row["machine_order"] for row in item[1]))
    }


def _page_reachable_missing_pairs(cur, context: dict, *, machine: str | None,
                                  offset: int, limit: int) -> list[dict]:
    """Scan bounded row-major ordinal windows; never form the state Cartesian product in SQL."""
    states_by_machine = _states_by_machine(context)
    selected = [machine] if machine is not None and machine in states_by_machine else (
        [] if machine is not None else list(states_by_machine)
    )
    remaining_skip = offset
    result: list[dict] = []
    definition = context["definition"]
    scan_size = min(_COVERAGE_SCAN_SIZE, max(limit, 64))
    counts = _coverage_counts(cur, context)["reachable"]
    for current_machine in selected:
        machine_missing = counts[current_machine]["total"] - counts[current_machine]["covered"]
        if remaining_skip >= machine_missing:
            remaining_skip -= machine_missing
            continue
        states = states_by_machine[current_machine]
        state_count = len(states)
        ordinal = 0
        pair_total = state_count * state_count
        while ordinal < pair_total and len(result) < limit:
            window_end = min(pair_total, ordinal + scan_size)
            candidates = [
                {"machine": current_machine, "pair_ordinal": pair_ordinal,
                 "from_key": states[pair_ordinal // state_count],
                 "to_key": states[pair_ordinal % state_count]}
                for pair_ordinal in range(ordinal, window_end)
                if pair_ordinal // state_count != pair_ordinal % state_count
            ]
            if candidates:
                cur.execute(
                    """/* setup reachable missing ordinal window */
                    WITH candidate_input AS (
                        SELECT machine, pair_ordinal, from_key, to_key
                          FROM jsonb_to_recordset(%s::jsonb)
                               AS pair(machine text, pair_ordinal bigint, from_key jsonb, to_key jsonb)
                    )
                    SELECT candidate.machine, candidate.from_key, candidate.to_key
                      FROM candidate_input AS candidate
                     WHERE NOT EXISTS (
                               SELECT 1 FROM setup_matrix AS matrix
                                WHERE matrix.plant = %s AND matrix.signature_version = %s
                                  AND matrix.machine = candidate.machine
                                  AND matrix.from_key = candidate.from_key
                                  AND matrix.to_key = candidate.to_key
                           )
                       AND NOT EXISTS (
                               SELECT 1 FROM setup_matrix AS matrix
                                WHERE matrix.plant = %s AND matrix.signature_version = %s
                                  AND matrix.machine = ''
                                  AND matrix.from_key = candidate.from_key
                                  AND matrix.to_key = candidate.to_key
                           )
                     ORDER BY candidate.pair_ordinal
                     LIMIT %s""",
                    (Jsonb(candidates), context["plant"], definition["signature_version"],
                     context["plant"], definition["signature_version"], len(candidates)),
                )
                for row in cur.fetchall():
                    if remaining_skip:
                        remaining_skip -= 1
                        continue
                    result.append(_coverage_page_row(row[0], row[1], row[2]))
                    if len(result) == limit:
                        break
            ordinal = window_end
    return result


def _page_setup_missing_pairs(cur, context: dict, kind: str, *, machine: str | None = None,
                              offset: int = 0, limit: int = 100) -> dict:
    """Generate one stable, capped missing-pair page from one coverage cursor."""
    if kind not in {"observed", "reachable"}:
        raise ValueError("kind must be observed or reachable")
    _validate_coverage_page(offset, limit)
    definition = context.get("definition")
    if definition is None:
        return {"rows": [], "meta": {"total": 0, "offset": offset, "limit": limit}}

    counts = _coverage_counts(cur, context)[kind]
    selected = [counts[machine]] if machine in counts else [] if machine is not None else list(counts.values())
    total = sum(item["total"] - item["covered"] for item in selected)
    if total == 0 or offset >= total:
        return {"rows": [], "meta": {"total": total, "offset": offset, "limit": limit}}

    if kind == "reachable":
        rows = _page_reachable_missing_pairs(cur, context, machine=machine, offset=offset,
                                              limit=limit)
        return {"rows": rows, "meta": {"total": total, "offset": offset, "limit": limit}}

    if kind == "observed":
        comment = "setup observed missing page"
        source = """observed_input AS (
                SELECT machine, from_key, to_key, pair_order
                  FROM jsonb_to_recordset(%s::jsonb)
                       AS pair(machine text, from_key jsonb, to_key jsonb, pair_order integer)
            )"""
        select = """SELECT pair.machine, pair.from_key, pair.to_key
              FROM observed_input AS pair
             WHERE (%s::text IS NULL OR pair.machine = %s)
               AND pair.from_key <> pair.to_key
               AND NOT EXISTS (
                       SELECT 1 FROM setup_matrix AS matrix
                        WHERE matrix.plant = %s AND matrix.signature_version = %s
                          AND matrix.machine = pair.machine
                          AND matrix.from_key = pair.from_key AND matrix.to_key = pair.to_key
                   )
               AND NOT EXISTS (
                       SELECT 1 FROM setup_matrix AS matrix
                        WHERE matrix.plant = %s AND matrix.signature_version = %s
                          AND matrix.machine = ''
                          AND matrix.from_key = pair.from_key AND matrix.to_key = pair.to_key
                   )
             ORDER BY pair.pair_order
             LIMIT %s OFFSET %s"""
        params = (Jsonb(context["observed"]), machine, machine,
                  context["plant"], definition["signature_version"],
                  context["plant"], definition["signature_version"], limit, offset)
    cur.execute(f"/* {comment} */ WITH {source} {select}", params)
    rows = [_coverage_page_row(row[0], row[1], row[2]) for row in cur.fetchall()]
    return {"rows": rows, "meta": {"total": total, "offset": offset, "limit": limit}}


def _coverage_transaction(plant: str, callback):
    plant = _required_text(plant, "Plant")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return callback(cur, plant)


def _coverage_bundle(cur, plant: str, *, machine: str | None, offset: int, limit: int,
                     page_kinds: tuple[str, ...]) -> dict:
    _validate_coverage_page(offset, limit)
    context = _load_setup_coverage(cur, plant)
    summary = _summarize_setup_coverage(cur, context)
    result = {"plant": summary["plant"], "definition": summary["definition"],
              "observed": dict(summary["observed"]), "reachable": dict(summary["reachable"])}
    for kind in page_kinds:
        result[kind]["missing_page"] = _page_setup_missing_pairs(
            cur, context, kind, machine=machine, offset=offset, limit=limit,
        )
    return result


def get_setup_coverage_page(plant: str, *, machine: str | None = None,
                            offset: int = 0, limit: int = 100) -> dict:
    """Read coverage totals and both requested pages from one repeatable-read cursor."""
    _validate_coverage_page(offset, limit)
    return _coverage_transaction(
        plant,
        lambda cur, current_plant: _coverage_bundle(
            cur, current_plant, machine=machine, offset=offset, limit=limit,
            page_kinds=("observed", "reachable"),
        ),
    )


def get_setup_missing_pairs_page(plant: str, kind: str, *, machine: str | None = None,
                                 offset: int = 0, limit: int = 100) -> dict:
    """Read one bounded missing-pair page and its total from one repeatable-read cursor."""
    if kind not in {"observed", "reachable"}:
        raise ValueError("kind must be observed or reachable")
    _validate_coverage_page(offset, limit)
    result = _coverage_transaction(
        plant,
        lambda cur, current_plant: _coverage_bundle(
            cur, current_plant, machine=machine, offset=offset, limit=limit,
            page_kinds=(kind,),
        ),
    )
    return {"plant": result["plant"], "definition": result["definition"], "page": result[kind]["missing_page"]}


def get_setup_coverage(plant: str) -> dict:
    """Compatibility wrapper returning bounded coverage totals without the optimizer snapshot."""
    return _coverage_transaction(
        plant,
        lambda cur, current_plant: _summarize_setup_coverage(
            cur, _load_setup_coverage(cur, current_plant),
        ),
    )
