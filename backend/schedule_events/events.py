"""schedule_event write helper -- a LEAF module (stdlib + psycopg only).

Nothing from the project is imported here, so ``db.py``, the routing resolver,
distribution and the SAP staging module can all import it without a cycle.
The persistence/read/sweep halves live in ``backend/schedule_events/data.py``.

Contract (see backend/schedule_events/CLAUDE.md):
  * ``record(cur, ev, rows)`` runs on the CALLER's cursor, as the last statement
    before that path's own ``conn.commit()``, so the history row commits or
    rolls back with the order write.
  * It is fail-open: the INSERT sits under ``SAVEPOINT sched_ev``; on any
    failure only that savepoint is rolled back, a counter is bumped and a
    warning is logged. The caller's transaction is left untouched.
  * Diffs compare DB-typed before against DB-typed after (never the wire
    payload), so ``Decimal('2.0')`` vs ``2.00`` never produces a phantom change.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable, Iterable, Mapping

log = logging.getLogger("nimbus.schedule_events")

# Tracked order fields. `segments` is a count pair ([n_before, n_after]) and is
# not an orders column, so it is absent from TRACKED_COLS_SQL.
TRACKED_FIELDS: tuple[str, ...] = (
    "machine", "scheduled_end", "scheduled_start", "run_time", "production_version",
    "manual_firmed", "planning_status", "notes", "order_quantity", "basic_finish_date",
    "prt_01", "prt_02", "parent_production_order", "distribution_letter", "segments",
)
TRACKED_COLS_SQL: str = ", ".join(f"o.{c}" for c in TRACKED_FIELDS if c != "segments")

# Sources the planner UI can stamp per task on the wire.
PLANNER_SOURCES: frozenset[str] = frozenset(
    {"drag", "keyboard", "grid", "inspector", "alert_fix", "optimizer", "undo"})
SOURCES: frozenset[str] = PLANNER_SOURCES | frozenset({
    "planner", "note", "distribution", "sap_ingest", "excel_upload", "sap_reset", "routing_hold",
    "routing_recompute", "purge", "sap_vanish", "restore", "admin", "master_data_stamp", "unknown"})
# `modify`/`remove`, not update/delete: the deploy runner's destructive regex scans whole migration files.
OPS: frozenset[str] = frozenset({"create", "modify", "remove"})

_SAVEPOINT = "sched_ev"

_INSERT_SQL = """
INSERT INTO schedule_event (plant, order_id, production_order, material_number, action_id, source, actor, client_id, op, changes)
SELECT u.plant, u.order_id, u.po, u.mat, %(action_id)s::uuid, u.source, %(actor)s, %(client_id)s, u.op, u.changes::jsonb
  FROM unnest(%(plants)s::text[], %(order_ids)s::text[], %(pos)s::text[], %(mats)s::text[],
              %(sources)s::text[], %(ops)s::text[], %(changes)s::text[]) AS u(plant, order_id, po, mat, source, op, changes)
"""


@dataclass(frozen=True)
class EventCtx:
    source: str
    actor: str | None
    action_id: str
    client_id: str | None = None


@dataclass(frozen=True)
class EventRow:
    plant: str
    order_id: str
    production_order: str | None
    material_number: str | None
    op: str
    changes: dict = field(default_factory=dict)
    source: str | None = None


# --------------------------------------------------------------------------- failure counter

_write_failures = 0
_failure_hook: Callable[[int], None] | None = None


def write_failures() -> int:
    """Process-lifetime count of swallowed history-write failures."""
    return _write_failures


def set_failure_hook(hook: Callable[[int], None] | None) -> None:
    """data.py injects a callback (receives the running total) so DIAGNOSTICS can mirror the counter
    without this leaf module importing anything from the project."""
    global _failure_hook
    _failure_hook = hook


_rows_skipped = 0
_skip_hook: Callable[[int], None] | None = None


def rows_skipped() -> int:
    """Process-lifetime count of rows with real changes dropped for a missing plant or order id."""
    return _rows_skipped


def set_skip_hook(hook: Callable[[int], None] | None) -> None:
    """Same injection as `set_failure_hook`, for the skipped-row counter."""
    global _skip_hook
    _skip_hook = hook


# --------------------------------------------------------------------------- ids and scalars

def new_action_id() -> str:
    return str(uuid.uuid4())


def as_action_id(value: Any) -> str:
    """A valid UUID text is kept (lets ingest reuse its batch_id). Any other non-empty value maps to a
    deterministic uuid5 of its text, so two paths deriving an action id from the same batch id (ingest and
    its in-ingest resolver) agree; None / empty gets a fresh id."""
    if value is not None and str(value) != "":
        try:
            return str(uuid.UUID(str(value)))
        except (ValueError, AttributeError, TypeError):
            return str(uuid.uuid5(uuid.NAMESPACE_URL, str(value)))
    return new_action_id()


def _ev_scalar(v: Any) -> Any:
    """JSON-safe form of one DB value. None/bool/int/str pass; Decimal -> int when integral else float;
    datetime -> isoformat(timespec='seconds') exactly as stored (naive stays naive); date -> isoformat();
    NaN/inf -> None; anything else -> str."""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, Decimal):
        if not v.is_finite():
            return None
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, datetime):
        return v.isoformat(timespec="seconds")
    if isinstance(v, date):
        return v.isoformat()
    return str(v)


def _norm_obj(obj: Any) -> Any:
    if isinstance(obj, Mapping):
        return {str(k): _norm_obj(x) for k, x in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_norm_obj(x) for x in obj]
    out = _ev_scalar(obj)
    return out.replace("\x00", "") if isinstance(out, str) else out


def dumps(obj: Any) -> str:
    """json.dumps through _ev_scalar (Decimal/datetime/NaN-safe; NUL bytes stripped, jsonb rejects them)."""
    return json.dumps(_norm_obj(obj), separators=(",", ":"), allow_nan=False)


def _cmp_value(v: Any) -> Any:
    out = _ev_scalar(v)
    if isinstance(out, str):
        out = out.strip()
        return None if out == "" else out
    return out


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    return a == b


# --------------------------------------------------------------------------- diffs

def diff_tracked(before: Mapping[str, Any] | None, after: Mapping[str, Any]) -> dict | None:
    """``{field: [before, after]}`` for the keys present in `after` whose DB-typed value really changed;
    None when nothing changed. None == '' ; Decimal('1.000') == 1 ; strings compare stripped."""
    before = before or {}
    changes: dict[str, list] = {}
    for key, new in after.items():
        b, a = _cmp_value(before.get(key)), _cmp_value(new)
        if not _same(b, a):
            changes[key] = [b, a]
    return changes or None


def _is_default_value(key: str, v: Any) -> bool:
    """The column default a freshly created order carries (scheduled, not firmed, no segments)."""
    if key == "planning_status":
        return v == "scheduled"
    if key == "manual_firmed":
        return v is False
    if key == "segments":
        return not isinstance(v, bool) and v == 0
    return False


def snapshot_changes(row: Mapping[str, Any], *, op: str) -> dict:
    """create -> ``{k: [None, v]}``; remove -> ``{k: [v, None]}``, for the non-null tracked keys of `row`.
    A create row also skips the default values (planning_status 'scheduled', manual_firmed False,
    segments 0); a remove row keeps them (it is the order's last known state)."""
    if op not in ("create", "remove"):
        raise ValueError("snapshot_changes op must be 'create' or 'remove'")
    out: dict[str, list] = {}
    for key in TRACKED_FIELDS:
        if key not in row:
            continue
        v = _cmp_value(row[key])
        if v is None:
            continue
        if op == "create" and _is_default_value(key, v):
            continue            # a new order's defaults say nothing; saves ~70 B per create row
        out[key] = [None, v] if op == "create" else [v, None]
    return out


def row_from_record(after: Mapping[str, Any], *, op: str, before: Mapping[str, Any] | None = None,
                    source: str | None = None) -> EventRow:
    """Build an EventRow from a read-back order record. `order_id` comes from ``order_id`` or ``id``.
    create/remove snapshot `after`; modify diffs `before` against `after` (empty changes -> dropped by record())."""
    if op == "modify":
        changes = diff_tracked(before, after) or {}
    else:
        changes = snapshot_changes(after, op=op)
    order_id = after.get("order_id", after.get("id"))
    return EventRow(
        plant=str(after.get("plant") or ""), order_id=str(order_id) if order_id is not None else "",
        production_order=after.get("production_order"), material_number=after.get("material_number"),
        op=op, changes=changes, source=source)


# --------------------------------------------------------------------------- the write

def _clean(v: Any) -> Any:
    return v.replace("\x00", "") if isinstance(v, str) else v


def _count_failure() -> None:
    global _write_failures
    _write_failures += 1
    hook = _failure_hook
    if hook is not None:
        try:
            hook(_write_failures)
        except Exception:  # noqa: BLE001 - the counter mirror must never break the caller
            pass


def _count_skipped(n: int) -> None:
    global _rows_skipped
    _rows_skipped += n
    log.debug("schedule_event: %d row(s) dropped for a missing plant or order id", n)
    hook = _skip_hook
    if hook is not None:
        try:
            hook(_rows_skipped)
        except Exception:  # noqa: BLE001
            pass


def record(cur, ev: EventCtx | None, rows: Iterable[EventRow]) -> int:
    """Insert one schedule_event row per EventRow that has changes, via ONE unnest INSERT, and return the count.

    Returns 0 immediately for ``ev is None`` (callers that pass no context record nothing) or when no row
    survives the empty-changes filter. An unknown source is coerced to 'unknown'.

    Fail-open: the INSERT runs under ``SAVEPOINT sched_ev``. On ANY exception only that savepoint is rolled
    back, the module counter is incremented, a warning carrying the action_id is logged, and 0 is returned.
    The caller's transaction (its order writes and its later ``commit()``) is untouched.
    """
    if ev is None:
        return 0
    with_changes = [r for r in rows if r is not None and r.changes]
    kept = [r for r in with_changes if r.order_id and r.plant]
    if len(kept) != len(with_changes):
        _count_skipped(len(with_changes) - len(kept))
    if not kept:
        return 0
    action_id = as_action_id(ev.action_id)
    started = False
    try:
        kept = [r for r in kept if r.op in OPS]
        if not kept:
            return 0
        default_src = ev.source if ev.source in SOURCES else "unknown"
        params = {
            "action_id": action_id,
            "actor": _clean(ev.actor),
            "client_id": _clean(ev.client_id),
            "plants": [_clean(r.plant) for r in kept],
            "order_ids": [_clean(r.order_id) for r in kept],
            "pos": [_clean(r.production_order) for r in kept],
            "mats": [_clean(r.material_number) for r in kept],
            "sources": [r.source if r.source in SOURCES else default_src for r in kept],
            "ops": [r.op for r in kept],
            "changes": [dumps(r.changes) for r in kept],
        }
        cur.execute(f"SAVEPOINT {_SAVEPOINT}")
        started = True
        cur.execute(_INSERT_SQL, params)
        cur.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")
        return len(kept)
    except Exception as exc:  # noqa: BLE001 - fail-open by design (D2)
        _count_failure()
        log.warning("schedule_event write failed (action_id=%s): %s", action_id, exc)
        if started:
            try:
                cur.execute(f"ROLLBACK TO SAVEPOINT {_SAVEPOINT}")
                cur.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")
            except Exception as exc2:  # noqa: BLE001
                log.warning("schedule_event savepoint rollback failed (action_id=%s): %s", action_id, exc2)
        return 0
