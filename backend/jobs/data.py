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

# Identical text lives in migrations/2026-10-30-1-job-artifacts.sql and the schema.sql mirror block (pinned verbatim
# by tests/test_jobs.py). A separate constant so the W1 DDL pin above stays untouched.
JOB_ARTIFACT_DDL = """
CREATE TABLE IF NOT EXISTS job_run_artifact (
    run_id        BIGINT PRIMARY KEY REFERENCES job_run (id),
    content_type  TEXT NOT NULL DEFAULT 'application/json',
    filename      TEXT,
    body          TEXT NOT NULL,             -- JSON text: {sections:[{key,title,columns,rows}], summary}
    row_count     INTEGER NOT NULL DEFAULT 0,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
"""

# Read-path indexes for GET /jobs/summary (the run_health counts), run by the startup hook and mirrored in
# schema.sql. They stay out of JOB_DDL and the migration file, which tests pin verbatim.
JOB_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_job_run_ended  ON job_run (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_run_active ON job_run (status) WHERE status IN ('scheduled','running');
"""

MISSED_PREFIX = "missed:"          # record_skipped's reason for a fire that missed its grace time
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
        cur.execute(JOB_ARTIFACT_DDL)
        cur.execute(JOB_INDEX_DDL)
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
      LEFT JOIN LATERAL (SELECT status, error FROM job_run r WHERE r.job_id = d.id ORDER BY r.id DESC LIMIT 1) lr ON TRUE
     WHERE (%(allowed)s::text[] IS NULL OR d.plant = ANY(%(allowed)s))
       AND (%(plant)s::text IS NULL OR d.plant = %(plant)s)
       AND (%(jt)s::text IS NULL OR d.job_type = %(jt)s)
       AND (%(status)s::text IS NULL OR lr.status = %(status)s
            OR (%(status)s = 'missed' AND lr.status = 'skipped' AND lr.error LIKE %(missed)s))
       AND (%(q)s::text IS NULL OR d.name ILIKE %(q)s)
       AND (%(arch)s OR NOT d.archived)
       AND (%(before)s::bigint IS NULL OR d.id < %(before)s)
     ORDER BY d.id DESC LIMIT %(lim)s"""
    params = {"allowed": allowed_plants, "plant": plant, "jt": job_type, "status": status,
              "missed": MISSED_PREFIX + "%", "q": f"%{q}%" if q else None, "arch": include_archived, "before": before_id, "lim": limit + 1}
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


def next_fire_schedules(*, allowed_plants, plant) -> list[dict]:
    """Armed schedules of enabled, non-archived jobs in the visible plants, with the job's name and plant: all the
    next-fire summary needs (no runs, no params). Scoped by plant in SQL, not by a page of the newest jobs."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT s.id, s.job_id, s.kind, s.cron_expr, s.time_of_day, s.days_of_week, s.day_of_month, s.run_at,"
            " s.timezone, s.valid_from, s.valid_until, s.misfire_grace_s, d.name AS job_name, d.plant"
            "  FROM job_schedule s JOIN job_definition d ON d.id = s.job_id"
            " WHERE NOT s.retired AND NOT s.paused AND d.enabled AND NOT d.archived"
            "   AND (%(allowed)s::text[] IS NULL OR d.plant = ANY(%(allowed)s))"
            "   AND (%(plant)s::text IS NULL OR d.plant = %(plant)s) ORDER BY s.id",
            {"allowed": allowed_plants, "plant": plant})
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
    clear_health_cache()
    return rid


def insert_manual_run_if_idle(*, job: dict, triggered_by: str | None, scheduled_for: datetime) -> int | None:
    """A `scheduled` manual run, unless the job already has a scheduled|running one. The check and the insert share
    one transaction under a per-job advisory xact lock, so two clicks cannot both pass. None = already active."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"jobs:manual:{job['id']}",))
        cur.execute(
            "INSERT INTO job_run (job_id, plant, job_type, status, trigger, scheduled_for, triggered_by)"
            " SELECT %s, %s, %s, 'scheduled', 'manual', %s, %s"
            "  WHERE NOT EXISTS (SELECT 1 FROM job_run WHERE job_id = %s AND status IN ('scheduled','running'))"
            " RETURNING id",
            (job["id"], job["plant"], job["job_type"], scheduled_for, triggered_by, job["id"]))
        row = cur.fetchone()
        conn.commit()
    clear_health_cache()
    return row[0] if row else None


def mark_running(run_id: int, *, waiting_for: str | None = None) -> None:
    """`waiting_for='slot'` marks a run blocked on a shared resource: it still counts as Queued in the summary and
    its clock restarts in `mark_work_started`."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = 'running', started_at = clock_timestamp(),"
                    " summary = CASE WHEN %s::text IS NULL THEN summary"
                    "   ELSE COALESCE(summary, '{}'::jsonb) || jsonb_build_object('waiting_for', %s::text) END"
                    " WHERE id = %s", (waiting_for, waiting_for, run_id))
        conn.commit()
    clear_health_cache()


def mark_work_started(run_id: int) -> None:
    """The body now holds its resource: elapsed time and duration measure from here, not from mark_running."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET started_at = clock_timestamp(),"
                    " summary = NULLIF(COALESCE(summary, '{}'::jsonb) - 'waiting_for', '{}'::jsonb)"
                    " WHERE id = %s AND status = 'running'", (run_id,))
        conn.commit()
    clear_health_cache()


def finish_run(run_id: int, status: str, summary: dict | None, error: str | None, log_truncated: bool) -> None:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE job_run SET status = %s, summary = %s, error = %s, log_truncated = %s,"
            " ended_at = clock_timestamp() WHERE id = %s AND status IN ('scheduled','running')",
            (status, Jsonb(summary) if summary is not None else None, error, log_truncated, run_id))
        conn.commit()
    clear_health_cache()


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


PERIODICITIES = ("once", "hourly", "daily", "weekdays", "weekly", "monthly", "cron", "manual")


def list_runs(*, allowed_plants, plant, job_id, status, limit, before_id, periodicity=None, scheduled_by=None,
              since=None, job_type=None) -> dict:
    """`status='missed'` is a synthetic filter: skipped runs recorded for a misfire. `periodicity` is the schedule
    kind (or `manual` for runs with no schedule); `scheduled_by` is `triggered_by` ('schedule' or an admin email)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            f"SELECT {_RUN_COLS} FROM job_run r JOIN job_definition d ON d.id = r.job_id"
            " LEFT JOIN job_schedule s ON s.id = r.schedule_id"
            " WHERE (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND (%(plant)s::text IS NULL OR r.plant = %(plant)s)"
            "   AND (%(job)s::bigint IS NULL OR r.job_id = %(job)s)"
            "   AND (%(jt)s::text IS NULL OR r.job_type = %(jt)s)"
            "   AND (%(status)s::text IS NULL OR r.status = %(status)s"
            "        OR (%(status)s = 'missed' AND r.status = 'skipped' AND r.error LIKE %(missed)s))"
            "   AND (%(period)s::text IS NULL OR COALESCE(s.kind, 'manual') = %(period)s)"
            "   AND (%(by)s::text IS NULL OR r.triggered_by = %(by)s)"
            "   AND (%(since)s::timestamptz IS NULL OR COALESCE(r.ended_at, r.created_at) >= %(since)s)"
            "   AND (%(before)s::bigint IS NULL OR r.id < %(before)s)"
            " ORDER BY r.id DESC LIMIT %(lim)s",
            {"allowed": allowed_plants, "plant": plant, "job": job_id, "jt": job_type, "status": status,
             "missed": MISSED_PREFIX + "%", "period": periodicity, "by": scheduled_by, "since": since, "before": before_id, "lim": limit + 1})
        rows = cur.fetchall()
    page = rows[:limit]
    return {"runs": page, "next_before_id": page[-1]["id"] if len(rows) > limit and page else None}


LONGER_MIN_RUNS = 3
LONGER_FLOOR_S = 300
LONGER_FACTOR = 2.0


def longer_than_usual(elapsed_s: float, history_s: list[float]) -> bool:
    """Pure: a running run is 'longer than usual' once it exceeds max(2x the median of the job's last finished
    runs, 5 min) and at least LONGER_MIN_RUNS finished runs exist."""
    if len(history_s) < LONGER_MIN_RUNS:
        return False
    s = sorted(history_s)
    n = len(s)
    median = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return elapsed_s > max(LONGER_FACTOR * median, LONGER_FLOOR_S)


HEALTH_CACHE_TTL_S = 5.0
_HEALTH_CACHE: dict[tuple, tuple[float, dict]] = {}


def clear_health_cache() -> None:
    """Every in-process run write drops the summary cache, so only a write by another process can be 5 s stale."""
    _HEALTH_CACHE.clear()


def run_health(*, allowed_plants, plant, hours: int = 24) -> dict:
    """Counts behind GET /jobs/summary: live runs, 24 h outcomes and the ids of runs running longer than usual.
    A run blocked on a shared slot (`summary.waiting_for`) counts as queued, not running. Cached for a few seconds
    per plant scope (the strip is polled by every open admin tab)."""
    key = (tuple(allowed_plants) if allowed_plants is not None else None, plant, hours)
    hit = _HEALTH_CACHE.get(key)
    if hit and time.monotonic() - hit[0] < HEALTH_CACHE_TTL_S:
        return dict(hit[1])
    out = _run_health(allowed_plants=allowed_plants, plant=plant, hours=hours)
    _HEALTH_CACHE[key] = (time.monotonic(), out)
    return dict(out)


def _run_health(*, allowed_plants, plant, hours: int) -> dict:
    with db._pool.connection() as conn, _cur(conn) as cur:
        waiting = "COALESCE(r.summary->>'waiting_for', '') <> ''"
        failed = "r.status = 'failed' AND r.ended_at >= now() - make_interval(hours => %(h)s)"
        cur.execute(
            "SELECT"
            f" COUNT(*) FILTER (WHERE r.status = 'running' AND NOT ({waiting})) AS running,"
            f" COUNT(*) FILTER (WHERE r.status = 'scheduled' OR (r.status = 'running' AND {waiting})) AS queued,"
            f" COUNT(*) FILTER (WHERE {failed}) AS failed,"
            f" COUNT(*) FILTER (WHERE {failed} AND r.summary->>'error_kind' = 'config') AS failed_config,"
            f" COUNT(*) FILTER (WHERE {failed} AND r.summary->>'error_kind' = 'transient') AS failed_transient,"
            f" COUNT(*) FILTER (WHERE {failed} AND COALESCE(r.summary->>'error_kind', 'system')"
            "                  NOT IN ('config', 'transient')) AS failed_system,"
            " COUNT(*) FILTER (WHERE r.status = 'warning' AND r.ended_at >= now() - make_interval(hours => %(h)s)) AS warn,"
            " COUNT(*) FILTER (WHERE r.status = 'skipped' AND r.error LIKE %(missed)s"
            "                  AND r.ended_at >= now() - make_interval(hours => %(h)s)) AS missed"
            " FROM job_run r"
            " WHERE (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND (%(plant)s::text IS NULL OR r.plant = %(plant)s)"
            "   AND (r.status IN ('scheduled','running') OR r.ended_at >= now() - make_interval(hours => %(h)s))",
            {"allowed": allowed_plants, "plant": plant, "h": hours, "missed": MISSED_PREFIX + "%"})
        c = cur.fetchone()
        cur.execute(
            "SELECT r.id, r.job_id, EXTRACT(EPOCH FROM (clock_timestamp() - r.started_at)) AS elapsed"
            f" FROM job_run r WHERE r.status = 'running' AND r.started_at IS NOT NULL AND NOT ({waiting})"
            "   AND (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND (%(plant)s::text IS NULL OR r.plant = %(plant)s)",
            {"allowed": allowed_plants, "plant": plant})
        live = cur.fetchall()
        longer: list[int] = []
        for r in live:
            cur.execute(
                "SELECT EXTRACT(EPOCH FROM (ended_at - started_at)) AS s FROM job_run WHERE job_id = %s"
                " AND status IN ('succeeded','warning') AND started_at IS NOT NULL AND ended_at IS NOT NULL"
                " ORDER BY id DESC LIMIT 10", (r["job_id"],))
            hist = [float(x["s"]) for x in cur.fetchall()]
            if longer_than_usual(float(r["elapsed"] or 0), hist):
                longer.append(r["id"])
    return {"running": c["running"], "queued": c["queued"], "failed_24h": c["failed"], "failed_config_24h": c["failed_config"],
            "failed_system_24h": c["failed_system"], "failed_transient_24h": c["failed_transient"],
            "missed_24h": c["missed"],
            "warning_24h": c["warn"], "longer_than_usual": sorted(longer)}


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


# ------------------------------------------------------------------------------------------ report artifacts
def save_artifact(run_id: int, artifact: dict, *, filename: str | None = None) -> dict:
    """Cap and store a report artifact (one row per run, replaced on a re-save). Returns
    {row_counts, size_bytes, truncated} for the run summary."""
    import json
    from backend.jobs import artifacts
    capped, truncated = artifacts.cap_artifact(artifact)
    body = json.dumps(capped, default=str, separators=(",", ":"), ensure_ascii=False)
    size = len(body.encode("utf-8"))
    counts = artifacts.row_counts(capped)
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO job_run_artifact (run_id, content_type, filename, body, row_count, size_bytes)"
            " VALUES (%s, 'application/json', %s, %s, %s, %s)"
            " ON CONFLICT (run_id) DO UPDATE SET filename = EXCLUDED.filename, body = EXCLUDED.body,"
            " row_count = EXCLUDED.row_count, size_bytes = EXCLUDED.size_bytes, created_at = clock_timestamp()",
            (run_id, filename, body, sum(counts.values()), size))
        conn.commit()
    return {"row_counts": counts, "size_bytes": size, "truncated": truncated}


def get_artifact(run_id: int) -> dict | None:
    """{run_id, filename, content_type, row_count, size_bytes, created_at, artifact (parsed JSON)} or None."""
    import json
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute("SELECT run_id, filename, content_type, body, row_count, size_bytes, created_at"
                    " FROM job_run_artifact WHERE run_id = %s", (run_id,))
        r = cur.fetchone()
    if r is None:
        return None
    r["artifact"] = json.loads(r.pop("body"))
    r["created_at"] = _iso(r["created_at"])
    return r


def last_success_started_at(job_id: int, before_run_id: int | None = None) -> datetime | None:
    """started_at of the job's most recent finished (succeeded or warning) run: the `last_success` window anchor.
    `before_run_id` excludes the current run and anything newer."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT started_at FROM job_run WHERE job_id = %s AND status IN ('succeeded','warning')"
                    " AND started_at IS NOT NULL AND (%s::bigint IS NULL OR id < %s::bigint)"
                    " ORDER BY id DESC LIMIT 1", (job_id, before_run_id, before_run_id))
        r = cur.fetchone()
    return r[0] if r else None


# ------------------------------------------------------------------------------------------------- sweeps
def boot_sweep() -> int:
    """Rows still `scheduled`/`running` when the process starts belong to a process that died: mark them failed.
    Single-replica assumption (a second replica would clobber the first one's live runs)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = 'failed', error = 'interrupted by restart',"
                    " summary = COALESCE(summary, '{}'::jsonb) || '{\"error_kind\": \"system\"}'::jsonb,"
                    " ended_at = clock_timestamp() WHERE status IN ('scheduled','running')")
        n = cur.rowcount
        conn.commit()
    return n


def sweep_job_runs(*, retention_days=None, chunk: int = 500, max_chunks: int = 200,
                   statement_timeout_ms: int = 30_000, pause_s: float = 0.1) -> dict:
    """Trim finished runs older than the retention window (log lines first, then the run rows) in chunks of
    `chunk` runs. Never raises. One transaction per chunk, opening with an advisory xact lock; another sweeper
    holding it yields {"locked": True}. Stores its result in DIAGNOSTICS["job_run_last_sweep"]."""
    result = {"deleted_runs": 0, "deleted_log_lines": 0, "deleted_artifacts": 0, "chunks": 0, "retention_days": None,
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
                    cur.execute("DELETE FROM job_run_artifact WHERE run_id = ANY(%s)", (ids,))
                    result["deleted_artifacts"] += cur.rowcount
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

