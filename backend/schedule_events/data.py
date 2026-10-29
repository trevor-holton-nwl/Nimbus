"""schedule_event persistence: DDL bootstrap, retention sweep, per-order read.

The write helper (`record`) lives in the leaf module ``events.py``; this module
imports ``db`` / ``master_data`` and is imported only by routes, brain.py and tests.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import db
import master_data as md
from backend.admin_ops.diagnostics_state import DIAGNOSTICS
from backend.schedule_events import events

log = logging.getLogger("nimbus.schedule_events")

# Mirror the history write-failure counter into DIAGNOSTICS (events.py is a leaf and cannot import it).
DIAGNOSTICS.setdefault("schedule_event_write_failures", 0)
events.set_failure_hook(lambda total: DIAGNOSTICS.__setitem__("schedule_event_write_failures", int(total)))
DIAGNOSTICS.setdefault("schedule_event_rows_skipped", 0)
events.set_skip_hook(lambda total: DIAGNOSTICS.__setitem__("schedule_event_rows_skipped", int(total)))

# Identical text lives in migrations/2026-10-23-1-schedule-event.sql and the schema.sql mirror block;
# tests/test_schedule_events.py pins the CREATE TABLE statement verbatim in all three places.
SCHEDULE_EVENT_DDL = """
CREATE TABLE IF NOT EXISTS schedule_event (
    id               BIGSERIAL PRIMARY KEY,
    plant            TEXT NOT NULL,
    order_id         TEXT NOT NULL,          -- orders.id (MD5 of production_order|material); no FK on purpose
    production_order TEXT,
    material_number  TEXT,
    action_id        UUID NOT NULL,          -- one per save / ingest batch / optimizer run / sweep action
    source           TEXT NOT NULL,          -- drag|keyboard|grid|inspector|alert_fix|optimizer|undo|planner|note|
                                             -- distribution|sap_ingest|excel_upload|sap_reset|routing_hold|
                                             -- routing_recompute|purge|sap_vanish|restore|admin|master_data_stamp|unknown
    actor            TEXT,
    client_id        TEXT,                   -- reserved for the future change feed
    op               TEXT NOT NULL CHECK (op IN ('create','modify','remove')),
    changes          JSONB NOT NULL,         -- {"field": [before, after]} - only changed tracked fields
    at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000,
        autovacuum_analyze_scale_factor = 0.05);
CREATE INDEX IF NOT EXISTS idx_schedule_event_order ON schedule_event (plant, order_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_event_at    ON schedule_event (at);
"""

# Plant-level listing (report.what_changed). Run by the startup hook and mirrored in schema.sql; kept OUT of the
# pinned SCHEDULE_EVENT_DDL and the migration file (an index on an existing table goes through the hook, not a migration).
SCHEDULE_EVENT_PLANT_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_schedule_event_plant ON schedule_event (plant, id DESC);
"""

SWEEP_LOCK_KEY = "nimbus:schedule-event-sweep"
_SWEEP_SQL = ("DELETE FROM schedule_event WHERE id IN ("
              " SELECT id FROM schedule_event WHERE at < now() - make_interval(days => %s)"
              " ORDER BY at LIMIT %s)")  # the (at) index bounds the subquery even when nothing qualifies


def ensure_schedule_event_table() -> None:
    """Idempotent bootstrap (mirrors migrations/2026-10-23-1-schedule-event.sql and schema.sql)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(SCHEDULE_EVENT_DDL)
        cur.execute(SCHEDULE_EVENT_PLANT_INDEX_DDL)
        conn.commit()


def sweep_schedule_events(*, retention_days=None, chunk: int = 10_000, max_chunks: int = 500,
                          statement_timeout_ms: int = 30_000, pause_s: float = 0.1) -> dict:
    """Trim rows older than the retention window in `chunk`-sized batches. Never raises.

    One transaction per chunk, each starting with ``pg_try_advisory_xact_lock`` (transaction-scoped, so it can
    never leak through the connection pool); another sweeper holding it yields ``{"locked": True}``.
    Returns ``{deleted, chunks, retention_days, locked, error}`` and stores it in
    ``DIAGNOSTICS["schedule_event_last_sweep"]``.
    """
    result = {"deleted": 0, "chunks": 0, "retention_days": None, "locked": False, "error": None}
    try:
        if retention_days is None:
            days = md.get_schedule_event_retention_days()
        else:
            days = max(1, min(60, int(retention_days)))
        result["retention_days"] = days
        chunk = max(1, int(chunk))
        timeout_ms = max(1, int(statement_timeout_ms))
        for i in range(max(1, int(max_chunks))):
            with db._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s))", (SWEEP_LOCK_KEY,))
                if not cur.fetchone()[0]:
                    conn.rollback()
                    result["locked"] = True
                    break
                cur.execute(f"SET LOCAL statement_timeout = {timeout_ms}")
                cur.execute(_SWEEP_SQL, (days, chunk))
                n = cur.rowcount
                conn.commit()
            result["deleted"] += n
            result["chunks"] += 1
            if n < chunk:
                break
            if pause_s and i + 1 < max_chunks:
                time.sleep(pause_s)
    except Exception as exc:  # noqa: BLE001 - the sweep job must never raise
        log.warning("schedule_event sweep failed: %s", exc)
        result["error"] = str(exc)
    DIAGNOSTICS["schedule_event_last_sweep"] = {
        **result, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return result


_LIST_SQL = """
SELECT e.id, e.at, e.actor, u.first_name, u.last_name, e.source, e.op, e.action_id, e.client_id, e.changes
  FROM schedule_event e
  LEFT JOIN user_security u ON lower(u.username) = lower(e.actor)
 WHERE e.plant = %s AND e.order_id = %s AND (%s::bigint IS NULL OR e.id < %s)
 ORDER BY e.id DESC LIMIT %s
"""


def _row_to_wire(r) -> dict:
    id_, at, actor, first, last, source, op, action_id, client_id, changes = r
    name = " ".join(p.strip() for p in (first, last) if p and p.strip()) or None
    return {
        "id": id_,
        "at": at.isoformat() if at is not None else None,
        "actor": actor,
        "actor_name": name,
        "source": source,
        "op": op,
        "action_id": str(action_id),
        "client_id": client_id,
        "changes": changes if isinstance(changes, dict) else {},
    }


def list_order_events(plant: str, order_id: str, *, limit: int = 50, before_id: int | None = None) -> dict:
    """Newest-first history for one order, paged by the `id` cursor (fetches limit+1 to compute the next cursor)."""
    limit = max(1, min(200, int(limit)))
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(_LIST_SQL, (plant, order_id, before_id, before_id, limit + 1))
        rows = cur.fetchall()
    page = [_row_to_wire(r) for r in rows[:limit]]
    return {
        "plant": plant,
        "order_id": order_id,
        "events": page,
        "next_before_id": page[-1]["id"] if len(rows) > limit and page else None,
    }
