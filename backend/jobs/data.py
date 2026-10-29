"""Job scheduler persistence: DDL bootstrap, definition/schedule/run/log queries, boot sweep, retention sweep.

Blocking psycopg through the shared `db._pool`; callers in async code go through the threadpool. Routes and the
runner import this module; the leaf modules (triggers, context, registry) never do.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timezone

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

import db
import master_data as md
from backend.admin_ops.diagnostics_state import DIAGNOSTICS

log = logging.getLogger("nimbus.jobs")

# Identical text lives in migrations/2026-10-29-1-job-scheduler.sql and the schema.sql mirror block;
# tests/test_jobs.py pins it verbatim in all three places.
JOB_DDL = """
CREATE TABLE IF NOT EXISTS job_definition (
    id            BIGSERIAL PRIMARY KEY,
    plant         TEXT NOT NULL,             -- no FK on purpose (same posture as schedule_event)
    job_type      TEXT NOT NULL,             -- registry key, e.g. optimizer.plant
    name          TEXT NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    archived      BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed job stays for its run history
    retry_max     INTEGER NOT NULL DEFAULT 0 CHECK (retry_max BETWEEN 0 AND 5),
    timeout_s     INTEGER CHECK (timeout_s IS NULL OR timeout_s BETWEEN 10 AND 21600),
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by   TEXT,
    modified_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_definition_plant ON job_definition (plant, id DESC);

CREATE TABLE IF NOT EXISTS job_schedule (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    kind             TEXT NOT NULL CHECK (kind IN ('once','hourly','daily','weekdays','weekly','monthly','cron')),
    cron_expr        TEXT,                   -- compiled 5-field cron (presets and custom); null for once
    time_of_day      TEXT,                   -- HH:MM plant-local, presets only
    days_of_week     SMALLINT[],             -- 0 = Monday .. 6 = Sunday, weekly only
    day_of_month     SMALLINT CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    run_at           TIMESTAMP,              -- naive plant-local, once only
    timezone         TEXT NOT NULL,          -- IANA name copied from the plant when saved
    valid_from       TIMESTAMP,              -- naive plant-local
    valid_until      TIMESTAMP,              -- naive plant-local
    paused           BOOLEAN NOT NULL DEFAULT FALSE,
    retired          BOOLEAN NOT NULL DEFAULT FALSE,   -- a removed or spent schedule
    misfire_grace_s  INTEGER NOT NULL DEFAULT 300 CHECK (misfire_grace_s BETWEEN 1 AND 86400),
    skip_if_running  BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    modified_by      TEXT,
    modified_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_schedule_job ON job_schedule (job_id, id);

CREATE TABLE IF NOT EXISTS job_run (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    schedule_id      BIGINT REFERENCES job_schedule (id),
    plant            TEXT NOT NULL,          -- copied from the definition so history survives edits
    job_type         TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN
                       ('scheduled','running','succeeded','warning','failed','cancelled','skipped')),
    trigger          TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
    attempt          INTEGER NOT NULL DEFAULT 1,
    scheduled_for    TIMESTAMPTZ,
    started_at       TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    triggered_by     TEXT,
    summary          JSONB,                  -- e.g. late, changeovers, moved, applied, dropped
    error            TEXT,
    log_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_run_plant   ON job_run (plant, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_job     ON job_run (job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_run_created ON job_run (created_at);

CREATE TABLE IF NOT EXISTS job_run_log (
    run_id       BIGINT NOT NULL REFERENCES job_run (id),
    seq          INTEGER NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    level        TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
    step         TEXT,
    msg          TEXT NOT NULL,
    duration_ms  INTEGER,
    data         JSONB,
    PRIMARY KEY (run_id, seq)
);
"""

TERMINAL = ("succeeded", "warning", "failed", "cancelled", "skipped")
SWEEP_LOCK_KEY = "nimbus:job-run-sweep"
_DEF_COLS = ("id, plant, job_type, name, params, enabled, archived, retry_max, timeout_s, "
             "created_by, created_at, modified_by, modified_at")
_SCHED_COLS = ("id, job_id, kind, cron_expr, time_of_day, days_of_week, day_of_month, run_at, timezone, "
               "valid_from, valid_until, paused, retired, misfire_grace_s, skip_if_running, "
               "created_by, created_at, modified_by, modified_at")
_RUN_COLS = ("r.id, r.job_id, d.name AS job_name, r.plant, r.job_type, r.schedule_id, r.status, r.trigger, "
             "r.attempt, r.scheduled_for, r.started_at, r.ended_at, r.triggered_by, r.summary, r.error, "
             "r.log_truncated, r.cancel_requested")


def _cur(conn):
    return conn.cursor(row_factory=dict_row)


def _iso(v):
    return v.isoformat() if isinstance(v, (datetime, date)) else v


def ensure_job_tables() -> None:
    """Idempotent bootstrap (mirrors migrations/2026-10-29-1-job-scheduler.sql and schema.sql)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(JOB_DDL)
        conn.commit()


def plant_timezone(plant: str) -> str:
    """The plant's IANA timezone (plants.timezone); UTC when it has none."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT MIN(NULLIF(timezone, '')) FROM plants WHERE plant = %s", (plant,))
        row = cur.fetchone()
    return (row[0] if row and row[0] else "UTC").strip()


def plant_has_timezone(plant: str) -> bool:
    """True when the plant row carries its own timezone (plant_timezone() falls back to UTC for a blank one)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT MIN(NULLIF(timezone, '')) FROM plants WHERE plant = %s", (plant,))
        row = cur.fetchone()
    return bool(row and row[0] and str(row[0]).strip())


def has_active_run(job_id: int) -> bool:
    """A non-terminal (scheduled or running) run exists for the job."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM job_run WHERE job_id = %s AND status IN ('scheduled','running') LIMIT 1", (job_id,))
        return cur.fetchone() is not None


def plant_exists(plant: str) -> bool:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM plants WHERE plant = %s LIMIT 1", (plant,))
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------------------------- wire shapes
def definition_to_wire(r: dict) -> dict:
    return {**{k: r[k] for k in ("id", "plant", "job_type", "name", "params", "enabled", "archived", "retry_max",
                                  "timeout_s", "created_by", "modified_by")},
            "created_at": _iso(r["created_at"]), "modified_at": _iso(r["modified_at"])}


def schedule_to_wire(r: dict) -> dict:
    return {
        "id": r["id"], "job_id": r["job_id"], "kind": r["kind"], "cron_expr": r["cron_expr"],
        "time_of_day": r["time_of_day"], "days_of_week": list(r["days_of_week"]) if r["days_of_week"] is not None else None,
        "day_of_month": r["day_of_month"], "run_at": _iso(r["run_at"]), "timezone": r["timezone"],
        "valid_from": _iso(r["valid_from"]), "valid_until": _iso(r["valid_until"]), "paused": r["paused"],
        "retired": r["retired"], "misfire_grace_s": r["misfire_grace_s"], "skip_if_running": r["skip_if_running"],
        "created_by": r["created_by"], "modified_by": r["modified_by"],
        "created_at": _iso(r["created_at"]), "modified_at": _iso(r["modified_at"]),
    }


def run_to_wire(r: dict) -> dict:
    started, ended = r["started_at"], r["ended_at"]
    return {
        "id": r["id"], "job_id": r["job_id"], "job_name": r.get("job_name"), "plant": r["plant"],
        "job_type": r["job_type"], "schedule_id": r["schedule_id"], "status": r["status"], "trigger": r["trigger"],
        "attempt": r["attempt"], "scheduled_for": _iso(r["scheduled_for"]), "started_at": _iso(started),
        "ended_at": _iso(ended),
        "duration_ms": int((ended - started).total_seconds() * 1000) if started and ended else None,
        "triggered_by": r["triggered_by"], "summary": r["summary"], "error": r["error"],
        "log_truncated": r["log_truncated"], "cancel_requested": r["cancel_requested"],
    }


# ------------------------------------------------------------------------------------------------ definitions
def get_job(job_id: int) -> dict | None:
    """Definition row (raw dict) plus a `schedules` list of raw schedule dicts (retired ones excluded)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_DEF_COLS} FROM job_definition WHERE id = %s", (job_id,))
        d = cur.fetchone()
        if d is None:
            return None
        cur.execute(f"SELECT {_SCHED_COLS} FROM job_schedule WHERE job_id = %s AND NOT retired ORDER BY id", (job_id,))
        d["schedules"] = cur.fetchall()
    return d


def get_schedule(schedule_id: int) -> dict | None:
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_SCHED_COLS} FROM job_schedule WHERE id = %s", (schedule_id,))
        return cur.fetchone()


def _insert_schedule(cur, job_id: int, s: dict, actor: str | None) -> int:
    cur.execute(
        "INSERT INTO job_schedule (job_id, kind, cron_expr, time_of_day, days_of_week, day_of_month, run_at, timezone,"
        " valid_from, valid_until, paused, misfire_grace_s, skip_if_running, created_by, modified_by)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (job_id, s["kind"], s["cron_expr"], s["time_of_day"], s["days_of_week"], s["day_of_month"], s["run_at"],
         s["timezone"], s["valid_from"], s["valid_until"], bool(s.get("paused", False)),
         int(s.get("misfire_grace_s", 300)), bool(s.get("skip_if_running", True)), actor, actor))
    return cur.fetchone()[0]


def create_job(*, plant: str, job_type: str, name: str, params: dict, enabled: bool, retry_max: int,
               timeout_s: int | None, schedules: list[dict], actor: str | None) -> int:
    with db._pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO job_definition (plant, job_type, name, params, enabled, retry_max, timeout_s,"
                " created_by, modified_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (plant, job_type, name, Jsonb(params), enabled, retry_max, timeout_s, actor, actor))
            job_id = cur.fetchone()[0]
            for s in schedules:
                _insert_schedule(cur, job_id, s, actor)
        conn.commit()
    return job_id


_JOB_PATCHABLE = {"name": None, "params": Jsonb, "enabled": None, "archived": None, "retry_max": None,
                  "timeout_s": None}


def patch_job(job_id: int, fields: dict, actor: str | None) -> bool:
    sets, vals = [], []
    for k, v in fields.items():
        if k not in _JOB_PATCHABLE:
            continue
        sets.append(f"{k} = %s")
        vals.append(Jsonb(v) if k == "params" else v)
    if not sets:
        return True
    sets += ["modified_by = %s", "modified_at = clock_timestamp()"]
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE job_definition SET {', '.join(sets)} WHERE id = %s", (*vals, actor, job_id))
        ok = cur.rowcount == 1
        conn.commit()
    return ok


def add_schedule(job_id: int, s: dict, actor: str | None) -> int:
    with db._pool.connection() as conn, conn.cursor() as cur:
        sid = _insert_schedule(cur, job_id, s, actor)
        conn.commit()
    return sid


def patch_schedule(schedule_id: int, s: dict | None, flags: dict, actor: str | None) -> bool:
    """`s` is a fully normalised schedule (replaces the timing columns) or None; `flags` may carry paused,
    retired, misfire_grace_s, skip_if_running."""
    sets, vals = [], []
    if s is not None:
        for k in ("kind", "cron_expr", "time_of_day", "days_of_week", "day_of_month", "run_at", "timezone",
                  "valid_from", "valid_until"):
            sets.append(f"{k} = %s")
            vals.append(s[k])
    for k in ("paused", "retired", "misfire_grace_s", "skip_if_running"):
        if k in flags:
            sets.append(f"{k} = %s")
            vals.append(flags[k])
    if not sets:
        return True
    sets += ["modified_by = %s", "modified_at = clock_timestamp()"]
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE job_schedule SET {', '.join(sets)} WHERE id = %s", (*vals, actor, schedule_id))
        ok = cur.rowcount == 1
        conn.commit()
    return ok


def retire_schedule(schedule_id: int) -> None:
    """A spent one-off schedule: kept for history, never re-armed."""
    patch_schedule(schedule_id, None, {"retired": True}, "system")


def list_jobs(*, allowed_plants, plant, job_type, status, q, include_archived, limit, before_id) -> dict:
    """Newest-first page of definitions with their schedules and last run attached (raw dicts)."""
    sql = f"""
    SELECT d.id FROM job_definition d
      LEFT JOIN LATERAL (SELECT status FROM job_run r WHERE r.job_id = d.id ORDER BY r.id DESC LIMIT 1) lr ON TRUE
     WHERE (%(allowed)s::text[] IS NULL OR d.plant = ANY(%(allowed)s))
       AND (%(plant)s::text IS NULL OR d.plant = %(plant)s)
       AND (%(jt)s::text IS NULL OR d.job_type = %(jt)s)
       AND (%(status)s::text IS NULL OR lr.status = %(status)s)
       AND (%(q)s::text IS NULL OR d.name ILIKE %(q)s)
       AND (%(arch)s OR NOT d.archived)
       AND (%(before)s::bigint IS NULL OR d.id < %(before)s)
     ORDER BY d.id DESC LIMIT %(lim)s"""
    params = {"allowed": allowed_plants, "plant": plant, "jt": job_type, "status": status,
              "q": f"%{q}%" if q else None, "arch": include_archived, "before": before_id, "lim": limit + 1}
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(sql, params)
        ids = [r["id"] for r in cur.fetchall()]
        page = ids[:limit]
        jobs: list[dict] = []
        if page:
            cur.execute(f"SELECT {_DEF_COLS} FROM job_definition WHERE id = ANY(%s) ORDER BY id DESC", (page,))
            jobs = cur.fetchall()
            cur.execute(f"SELECT {_SCHED_COLS} FROM job_schedule WHERE job_id = ANY(%s) AND NOT retired ORDER BY id",
                        (page,))
            by_job: dict[int, list] = {}
            for s in cur.fetchall():
                by_job.setdefault(s["job_id"], []).append(s)
            cur.execute(f"SELECT DISTINCT ON (r.job_id) {_RUN_COLS} FROM job_run r JOIN job_definition d"
                        " ON d.id = r.job_id WHERE r.job_id = ANY(%s) ORDER BY r.job_id, r.id DESC", (page,))
            last = {r["job_id"]: r for r in cur.fetchall()}
            for j in jobs:
                j["schedules"] = by_job.get(j["id"], [])
                j["last_run"] = last.get(j["id"])
    return {"jobs": jobs, "next_before_id": page[-1] if len(ids) > limit and page else None}


def list_active_schedules() -> list[dict]:
    """Every schedule the scheduler should currently be armed with (joined with its job's plant/params)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT s.id, s.job_id, s.kind, s.cron_expr, s.time_of_day, s.days_of_week, s.day_of_month, s.run_at,"
            " s.timezone, s.valid_from, s.valid_until, s.misfire_grace_s, s.modified_at, d.plant, d.job_type"
            "  FROM job_schedule s JOIN job_definition d ON d.id = s.job_id"
            " WHERE NOT s.retired AND NOT s.paused AND d.enabled AND NOT d.archived ORDER BY s.id")
        return cur.fetchall()


def schedule_has_run(schedule_id: int) -> bool:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM job_run WHERE schedule_id = %s LIMIT 1", (schedule_id,))
        return cur.fetchone() is not None


# ------------------------------------------------------------------------------------------------------ runs
def insert_run(*, job_id: int, schedule_id: int | None, plant: str, job_type: str, status: str, trigger: str,
               attempt: int = 1, scheduled_for: datetime | None = None, triggered_by: str | None = None,
               error: str | None = None) -> int:
    ended = status in TERMINAL
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO job_run (job_id, schedule_id, plant, job_type, status, trigger, attempt, scheduled_for,"
            " triggered_by, error, ended_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
            " CASE WHEN %s THEN clock_timestamp() END) RETURNING id",
            (job_id, schedule_id, plant, job_type, status, trigger, attempt, scheduled_for, triggered_by, error, ended))
        rid = cur.fetchone()[0]
        conn.commit()
    return rid


def mark_running(run_id: int) -> None:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = 'running', started_at = clock_timestamp() WHERE id = %s", (run_id,))
        conn.commit()


def finish_run(run_id: int, status: str, summary: dict | None, error: str | None, log_truncated: bool) -> None:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE job_run SET status = %s, summary = %s, error = %s, log_truncated = %s,"
            " ended_at = clock_timestamp() WHERE id = %s AND status IN ('scheduled','running')",
            (status, Jsonb(summary) if summary is not None else None, error, log_truncated, run_id))
        conn.commit()


def mark_cancel_requested(run_id: int) -> dict | None:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET cancel_requested = TRUE WHERE id = %s AND status IN ('scheduled','running')",
                    (run_id,))
        conn.commit()
    return get_run(run_id)


def get_run(run_id: int) -> dict | None:
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_RUN_COLS} FROM job_run r JOIN job_definition d ON d.id = r.job_id WHERE r.id = %s",
                    (run_id,))
        return cur.fetchone()


def list_runs(*, allowed_plants, plant, job_id, status, limit, before_id) -> dict:
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            f"SELECT {_RUN_COLS} FROM job_run r JOIN job_definition d ON d.id = r.job_id"
            " WHERE (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND (%(plant)s::text IS NULL OR r.plant = %(plant)s)"
            "   AND (%(job)s::bigint IS NULL OR r.job_id = %(job)s)"
            "   AND (%(status)s::text IS NULL OR r.status = %(status)s)"
            "   AND (%(before)s::bigint IS NULL OR r.id < %(before)s)"
            " ORDER BY r.id DESC LIMIT %(lim)s",
            {"allowed": allowed_plants, "plant": plant, "job": job_id, "status": status,
             "before": before_id, "lim": limit + 1})
        rows = cur.fetchall()
    page = rows[:limit]
    return {"runs": page, "next_before_id": page[-1]["id"] if len(rows) > limit and page else None}


def write_log_rows(run_id: int, rows: list[dict]) -> None:
    if not rows:
        return
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO job_run_log (run_id, seq, at, level, step, msg, duration_ms, data)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, seq) DO NOTHING",
            [(run_id, r["seq"], r["at"], r["level"], r["step"], r["msg"], r["duration_ms"],
              Jsonb(r["data"]) if r["data"] is not None else None) for r in rows])
        conn.commit()


def list_log(run_id: int, *, after_seq: int, min_level: str, limit: int) -> list[dict]:
    from backend.jobs.context import LEVELS, LEVEL_RANK
    levels = [lv for lv in LEVELS if LEVEL_RANK[lv] >= LEVEL_RANK.get(min_level, 0)]
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT seq, at, level, step, msg, duration_ms, data FROM job_run_log"
            " WHERE run_id = %s AND seq > %s AND level = ANY(%s) ORDER BY seq LIMIT %s",
            (run_id, after_seq, levels, limit))
        rows = cur.fetchall()
    for r in rows:
        r["at"] = _iso(r["at"])
    return rows


# ------------------------------------------------------------------------------------------------- sweeps
def boot_sweep() -> int:
    """Rows still `scheduled`/`running` when the process starts belong to a process that died: mark them failed.
    Single-replica assumption (a second replica would clobber the first one's live runs)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = 'failed', error = 'interrupted by restart',"
                    " ended_at = clock_timestamp() WHERE status IN ('scheduled','running')")
        n = cur.rowcount
        conn.commit()
    return n


def sweep_job_runs(*, retention_days=None, chunk: int = 500, max_chunks: int = 200,
                   statement_timeout_ms: int = 30_000, pause_s: float = 0.1) -> dict:
    """Trim finished runs older than the retention window (log lines first, then the run rows) in chunks of
    `chunk` runs. Never raises. One transaction per chunk, opening with an advisory xact lock; another sweeper
    holding it yields {"locked": True}. Stores its result in DIAGNOSTICS["job_run_last_sweep"]."""
    result = {"deleted_runs": 0, "deleted_log_lines": 0, "chunks": 0, "retention_days": None,
              "locked": False, "error": None}
    try:
        days = md.get_job_run_retention_days() if retention_days is None else max(1, min(60, int(retention_days)))
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
                cur.execute("SELECT id FROM job_run WHERE created_at < now() - make_interval(days => %s)"
                            " AND status NOT IN ('scheduled','running') ORDER BY id LIMIT %s", (days, chunk))
                ids = [r[0] for r in cur.fetchall()]
                if ids:
                    cur.execute("DELETE FROM job_run_log WHERE run_id = ANY(%s)", (ids,))
                    result["deleted_log_lines"] += cur.rowcount
                    cur.execute("DELETE FROM job_run WHERE id = ANY(%s)", (ids,))
                    result["deleted_runs"] += cur.rowcount
                conn.commit()
            result["chunks"] += 1
            if len(ids) < chunk:
                break
            if pause_s and i + 1 < max_chunks:
                time.sleep(pause_s)
    except Exception as exc:  # noqa: BLE001 - the sweep job must never raise
        log.warning("job_run sweep failed: %s", exc)
        result["error"] = str(exc)
    DIAGNOSTICS["job_run_last_sweep"] = {**result, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return result


# Held for the whole run: a SESSION advisory lock on a dedicated pooled connection (pattern: sap_staging.poll_once).
def try_session_lock(conn, key: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (key,))
        got = bool(cur.fetchone()[0])
    conn.commit()
    return got


def release_session_lock(conn, key: str) -> None:
    """Unlock; if that fails the session may still hold it, so close the connection (the pool discards it and the
    server drops the session lock with the session)."""
    try:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(hashtext(%s))", (key,))
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        log.error("could not release job lock %s; closing the connection: %s", key, exc)
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            log.exception("could not close the connection after a failed unlock")

