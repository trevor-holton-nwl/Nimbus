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

# Identical text lives in migrations/2026-10-31-1-job-targets.sql and the schema.sql mirror block (pinned verbatim by
# tests/test_jobs.py). CREATE-only: the deploy gate refuses ALTER/DROP/DELETE/UPDATE words in migrations.
JOB_TARGET_DDL = """
CREATE TABLE IF NOT EXISTS job_target (
    id               BIGSERIAL PRIMARY KEY,
    job_id           BIGINT NOT NULL REFERENCES job_definition (id),
    kind             TEXT NOT NULL CHECK (kind IN ('explicit','subnetwork','all')),
    value            TEXT NOT NULL DEFAULT '',   -- plant code | subnetwork code | '*' or a plant list for 'all'
    excluded         BOOLEAN NOT NULL DEFAULT FALSE,
    params_override  JSONB,                      -- deep-merged over the job params for the plants this row adds
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_job_target_job ON job_target (job_id, id);

CREATE TABLE IF NOT EXISTS job_batch (
    id             BIGSERIAL PRIMARY KEY,
    job_id         BIGINT NOT NULL REFERENCES job_definition (id),
    schedule_id    BIGINT REFERENCES job_schedule (id),
    scheduled_for  TIMESTAMPTZ,
    trigger        TEXT NOT NULL CHECK (trigger IN ('schedule','manual','restart')),
    triggered_by   TEXT,
    status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','warning','failed')),
    counts         JSONB,                        -- {total, <status>: n}
    started_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ended_at       TIMESTAMPTZ,
    summary        JSONB
);
CREATE INDEX IF NOT EXISTS idx_job_batch_job ON job_batch (job_id, id DESC);
"""

# W3a columns and indexes on EXISTING job tables: startup hook + schema.sql mirror only (never a migration, which the
# deploy gate allows to CREATE only). Runs after JOB_TARGET_DDL because job_run.batch_id references job_batch.
JOB_COLUMN_DDL = """
ALTER TABLE job_run        ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES job_batch (id);
CREATE INDEX IF NOT EXISTS idx_job_run_batch ON job_run (batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE job_schedule   ADD COLUMN IF NOT EXISTS tz_mode TEXT NOT NULL DEFAULT 'plant' CHECK (tz_mode IN ('plant','fixed','utc'));
ALTER TABLE job_schedule   ADD COLUMN IF NOT EXISTS fixed_timezone TEXT;
ALTER TABLE job_definition ADD COLUMN IF NOT EXISTS fan_out JSONB;
ALTER TABLE job_definition ADD COLUMN IF NOT EXISTS scope_plants JSONB;
-- W3b: the schedule policy (DST, closed days, run window, monthly mode, catch-up) and the last fire the scheduler saw.
ALTER TABLE job_schedule   ADD COLUMN IF NOT EXISTS options JSONB;
ALTER TABLE job_schedule   ADD COLUMN IF NOT EXISTS last_fire_at TIMESTAMPTZ;
-- W3b fix wave: the newest fire each arm saw, {plant: iso} ('*' = the schedule's plant-less arm), so catch-up baselines are per arm.
ALTER TABLE job_schedule   ADD COLUMN IF NOT EXISTS arm_fire_at JSONB;
"""

# W3b: a catch-up fire is recorded as trigger 'catchup'. The original CHECK only allows schedule|manual|retry and a
# migration may not touch it, so the startup hook swaps it once (idempotent: it only acts while the constraint lacks it).
JOB_TRIGGER_DDL = """
DO $job_trigger$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('nimbus:job-trigger-ddl'));
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'job_run'::regclass AND conname = 'job_run_trigger_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%catchup%') THEN
    ALTER TABLE job_run DROP CONSTRAINT IF EXISTS job_run_trigger_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'job_run'::regclass AND conname = 'job_run_trigger_check') THEN
    ALTER TABLE job_run ADD CONSTRAINT job_run_trigger_check CHECK (trigger IN ('schedule','manual','retry','catchup'));
  END IF;
EXCEPTION WHEN duplicate_object OR undefined_object THEN
  NULL;   -- another booting process swapped it first
END
$job_trigger$;
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
             "created_by, created_at, modified_by, modified_at, fan_out, scope_plants")
_SCHED_COLS = ("id, job_id, kind, cron_expr, time_of_day, days_of_week, day_of_month, run_at, timezone, "
               "valid_from, valid_until, paused, retired, misfire_grace_s, skip_if_running, "
               "tz_mode, fixed_timezone, options, last_fire_at, created_by, created_at, modified_by, modified_at")
_RUN_COLS = ("r.id, r.job_id, d.name AS job_name, r.plant, r.job_type, r.schedule_id, r.status, r.trigger, "
             "r.attempt, r.scheduled_for, r.started_at, r.ended_at, r.triggered_by, r.summary, r.error, "
             "r.log_truncated, r.cancel_requested, r.batch_id")


def _cur(conn):
    return conn.cursor(row_factory=dict_row)


def _iso(v):
    return v.isoformat() if isinstance(v, (datetime, date)) else v


def ensure_job_tables() -> None:
    """Idempotent bootstrap (mirrors migrations/2026-10-29-1-job-scheduler.sql and schema.sql)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(JOB_DDL)
        cur.execute(JOB_ARTIFACT_DDL)
        cur.execute(JOB_TARGET_DDL)
        cur.execute(JOB_COLUMN_DDL)
        cur.execute(JOB_TRIGGER_DDL)
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


class PlantRows(list):
    """The plant rows list, carrying a per-request calendar-view memo (`cal_memo`: plant -> view) so one route call reads
    each plant's calendar version once, however many schedules and arms it expands."""
    cal_memo: dict

    def __init__(self, rows=()):
        super().__init__(rows)
        self.cal_memo = {}


def load_plant_rows() -> list[dict]:
    """Every plant with its timezone and subnetworks: [{plant, subnetworks, timezone}] sorted by plant code. One small
    query (tens of plants); target expansion and reconcile read it fresh so a timezone edit is seen at once."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute("SELECT plant, array_agg(DISTINCT subnetwork ORDER BY subnetwork) AS subnetworks,"
                    " MIN(NULLIF(BTRIM(timezone), '')) AS timezone FROM plants GROUP BY plant ORDER BY plant")
        return PlantRows({"plant": r["plant"], "subnetworks": list(r["subnetworks"] or []), "timezone": r["timezone"]}
                         for r in cur.fetchall())


def has_active_run(job_id: int, plant: str | None = None) -> bool:
    """A non-terminal (scheduled or running) run exists for the job (for `plant` when given)."""
    return bool(active_runs(job_id, plant, limit=1))


def active_runs(job_id: int, plant: str | None = None, limit: int = 20) -> list[dict]:
    """The job's scheduled|running runs as [{plant, status}] (only `plant`'s when given), plants in code order, so a 409
    can say what is in the way."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute("SELECT DISTINCT plant, status FROM job_run WHERE job_id = %s AND status IN ('scheduled','running')"
                    " AND (%s::text IS NULL OR plant = %s) ORDER BY plant LIMIT %s", (job_id, plant, plant, limit))
        return cur.fetchall()


def plant_exists(plant: str) -> bool:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM plants WHERE plant = %s LIMIT 1", (plant,))
        return cur.fetchone() is not None


# ---------------------------------------------------------------------------------------------- wire shapes
def definition_to_wire(r: dict) -> dict:
    return {**{k: r[k] for k in ("id", "plant", "job_type", "name", "params", "enabled", "archived", "retry_max",
                                  "timeout_s", "created_by", "modified_by")},
            "fan_out": r.get("fan_out"),
            "targets": [target_to_wire(t) for t in r.get("targets") or []],
            "created_at": _iso(r["created_at"]), "modified_at": _iso(r["modified_at"])}


def schedule_to_wire(r: dict) -> dict:
    return {
        "id": r["id"], "job_id": r["job_id"], "kind": r["kind"], "cron_expr": r["cron_expr"],
        "time_of_day": r["time_of_day"], "days_of_week": list(r["days_of_week"]) if r["days_of_week"] is not None else None,
        "day_of_month": r["day_of_month"], "run_at": _iso(r["run_at"]), "timezone": r["timezone"],
        "valid_from": _iso(r["valid_from"]), "valid_until": _iso(r["valid_until"]), "paused": r["paused"],
        "retired": r["retired"], "misfire_grace_s": r["misfire_grace_s"], "skip_if_running": r["skip_if_running"],
        "tz_mode": r["tz_mode"], "fixed_timezone": r["fixed_timezone"], "options": r.get("options"),
        "last_fire_at": _iso(r.get("last_fire_at")),
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
        "log_truncated": r["log_truncated"], "cancel_requested": r["cancel_requested"], "batch_id": r.get("batch_id"),
    }


def target_to_wire(t: dict) -> dict:
    return {"kind": t["kind"], "value": t["value"], "excluded": bool(t["excluded"]),
            "params_override": t["params_override"]}


def batch_to_wire(b: dict) -> dict:
    started, ended = b["started_at"], b["ended_at"]
    return {"id": b["id"], "job_id": b["job_id"], "job_name": b.get("job_name"), "schedule_id": b["schedule_id"],
            "scheduled_for": _iso(b["scheduled_for"]), "trigger": b["trigger"], "triggered_by": b["triggered_by"],
            "status": b["status"], "counts": b["counts"] or {}, "started_at": _iso(started), "ended_at": _iso(ended),
            "duration_ms": int((ended - started).total_seconds() * 1000) if started and ended else None,
            "summary": b["summary"]}


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
        d["targets"] = _targets_for(cur, [job_id]).get(job_id, [])
    return d


def _targets_for(cur, job_ids: list[int]) -> dict[int, list[dict]]:
    cur.execute("SELECT job_id, kind, value, excluded, params_override FROM job_target"
                " WHERE job_id = ANY(%s) ORDER BY id", (job_ids,))
    out: dict[int, list[dict]] = {}
    for t in cur.fetchall():
        out.setdefault(t["job_id"], []).append(t)
    return out


def _insert_targets(cur, job_id: int, targets: list[dict]) -> None:
    for t in targets:
        cur.execute("INSERT INTO job_target (job_id, kind, value, excluded, params_override) VALUES (%s,%s,%s,%s,%s)",
                    (job_id, t["kind"], t["value"], bool(t["excluded"]),
                     Jsonb(t["params_override"]) if t.get("params_override") else None))


def set_targets(job_id: int, targets: list[dict], actor: str | None) -> None:
    """Replace the job's target rows (configuration, not history: the old rows are removed)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM job_target WHERE job_id = %s", (job_id,))
        _insert_targets(cur, job_id, targets)
        cur.execute("UPDATE job_definition SET modified_by = %s, modified_at = clock_timestamp() WHERE id = %s",
                    (actor, job_id))
        conn.commit()


def get_schedule(schedule_id: int) -> dict | None:
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_SCHED_COLS} FROM job_schedule WHERE id = %s", (schedule_id,))
        return cur.fetchone()


def _insert_schedule(cur, job_id: int, s: dict, actor: str | None) -> int:
    cur.execute(
        "INSERT INTO job_schedule (job_id, kind, cron_expr, time_of_day, days_of_week, day_of_month, run_at, timezone,"
        " valid_from, valid_until, paused, misfire_grace_s, skip_if_running, tz_mode, fixed_timezone, options,"
        " created_by, modified_by)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (job_id, s["kind"], s["cron_expr"], s["time_of_day"], s["days_of_week"], s["day_of_month"], s["run_at"],
         s["timezone"], s["valid_from"], s["valid_until"], bool(s.get("paused", False)),
         int(s.get("misfire_grace_s", 300)), bool(s.get("skip_if_running", True)),
         s.get("tz_mode") or "plant", s.get("fixed_timezone"),
         Jsonb(s["options"]) if s.get("options") else None, actor, actor))
    return cur.fetchone()[0]


def create_job(*, plant: str, job_type: str, name: str, params: dict, enabled: bool, retry_max: int,
               timeout_s: int | None, schedules: list[dict], actor: str | None, targets: list[dict] | None = None,
               fan_out: dict | None = None, scope_plants: list[str] | None = None) -> int:
    """`scope_plants` is the creator's allowed plant list (None = an unrestricted creator): fire-time expansion is
    intersected with it, so a job never reaches plants its creator could not."""
    with db._pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO job_definition (plant, job_type, name, params, enabled, retry_max, timeout_s,"
                " created_by, modified_by, fan_out, scope_plants) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (plant, job_type, name, Jsonb(params), enabled, retry_max, timeout_s, actor, actor,
                 Jsonb(fan_out) if fan_out else None,
                 Jsonb(sorted(scope_plants)) if scope_plants is not None else None))
            job_id = cur.fetchone()[0]
            _insert_targets(cur, job_id, targets or [])
            for s in schedules:
                _insert_schedule(cur, job_id, s, actor)
        conn.commit()
    return job_id


_JOB_PATCHABLE = {"name": None, "params": Jsonb, "enabled": None, "archived": None, "retry_max": None,
                  "timeout_s": None, "fan_out": Jsonb}


def patch_job(job_id: int, fields: dict, actor: str | None, *, targets: list[dict] | None = None,
              scope_plants: list[str] | None = None, set_scope: bool = False) -> bool:
    """Patch the definition and (when `targets` is not None) replace its target rows in ONE transaction, so a failure
    cannot leave new params with old targets. `set_scope` writes `scope_plants` (a scoped admin's save refreshes it)."""
    sets, vals = [], []
    for k, v in fields.items():
        if k not in _JOB_PATCHABLE:
            continue
        sets.append(f"{k} = %s")
        vals.append(Jsonb(v) if k in ("params", "fan_out") and v is not None else v)
    if set_scope:
        sets.append("scope_plants = %s")
        vals.append(Jsonb(sorted(scope_plants)) if scope_plants is not None else None)
    if not sets and targets is None:
        return True
    sets += ["modified_by = %s", "modified_at = clock_timestamp()"]
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"UPDATE job_definition SET {', '.join(sets)} WHERE id = %s", (*vals, actor, job_id))
        ok = cur.rowcount == 1
        if ok and (fields.get("enabled") is True or fields.get("archived") is False):
            # Re-enabled / restored: the downtime of the PAUSE is not process downtime, so move every schedule's
            # catch-up floor to now (it also re-arms them, which is what a resume needs anyway).
            cur.execute("UPDATE job_schedule SET modified_at = clock_timestamp() WHERE job_id = %s", (job_id,))
        if ok and targets is not None:
            cur.execute("DELETE FROM job_target WHERE job_id = %s", (job_id,))
            _insert_targets(cur, job_id, targets)
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
        if "options" in s:
            sets.append("options = %s")
            vals.append(Jsonb(s["options"]) if s["options"] else None)
    for k in ("paused", "retired", "misfire_grace_s", "skip_if_running", "tz_mode", "fixed_timezone"):
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


# ----------------------------------------------------------------------------- W3b: fire bookkeeping, calendars
ARM_KEY_NONE = "*"          # `arm_fire_at` key for a schedule's plant-less arm (single plant, fixed / UTC fan-out)


def touch_last_fire(schedule_id: int, plant: str | None = None) -> None:
    """The scheduler saw a fire for this schedule's arm for `plant` (it ran, or was recorded skipped). Stamps the
    schedule-wide `last_fire_at` (display) AND that arm's own `arm_fire_at` entry: the catch-up baseline is per arm, so
    one arm's fire never moves another arm's baseline. Does not touch `modified_at`, so it never looks like an edit to
    the re-arm signature."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE job_schedule SET last_fire_at = clock_timestamp(),"
            " arm_fire_at = COALESCE(arm_fire_at, '{}'::jsonb) || jsonb_build_object(%s::text,"
            "   to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'))"
            " WHERE id = %s", (plant or ARM_KEY_NONE, schedule_id))
        conn.commit()


def schedule_baseline(schedule_id: int, plant: str | None = None, arm: str | None = None) -> datetime | None:
    """The newest instant already accounted for, for ONE arm: the later of the schedule's last edit (`modified_at`: a
    save, resume, enable or restore bumps it) and the arm's own evidence: its `arm_fire_at` entry (`arm` = the arm's
    plant, None = the plant-less arm, which also honours the legacy schedule-wide `last_fire_at`) and the newest
    `scheduled_for` of any run it produced (for `plant` when given). NO evidence at all (first boot after the upgrade,
    a plant that just joined the targets) = None: there is no reliable baseline, so nothing is counted as missed. Catch-up
    counts fires after this."""
    key = arm or ARM_KEY_NONE
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT s.modified_at,"
            "  NULLIF(s.arm_fire_at ->> %s, '')::timestamptz,"
            "  CASE WHEN %s::text = %s::text THEN s.last_fire_at END,"
            "  (SELECT MAX(r.scheduled_for) FROM job_run r WHERE r.schedule_id = s.id"
            "   AND (%s::text IS NULL OR r.plant = %s))"
            " FROM job_schedule s WHERE s.id = %s", (key, key, ARM_KEY_NONE, plant, plant, schedule_id))
        row = cur.fetchone()
    if not row:
        return None
    evidence = [v for v in row[1:] if v is not None]
    if not evidence:
        return None
    return max([row[0], *evidence])


def run_since(schedule_id: int, plant: str | None, since: datetime) -> bool:
    """A run (any status) of this schedule exists with scheduled_for >= since: the expected fire is already covered."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM job_run WHERE schedule_id = %s AND (%s::text IS NULL OR plant = %s)"
                    " AND scheduled_for >= %s LIMIT 1", (schedule_id, plant, plant, since))
        return cur.fetchone() is not None


JOBS_PAUSED_KEY = "jobs_paused"
_MAINT_TTL_S = 3.0
_MAINT: dict = {"at": 0.0, "value": None}


def _truthy(v) -> bool:
    """A stored flag read strictly: the string 'false' (or '0', 'no', '') is NOT paused."""
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes", "on")
    return bool(v) if isinstance(v, (bool, int, float)) else False


def maintenance_state(*, fresh: bool = False) -> dict:
    """{enabled, since, by}: the global `jobs_paused` setting. Cached a few seconds (a fan-out reads it per child);
    a failed read answers 'not paused' so a settings glitch never silences the scheduler."""
    if not fresh and _MAINT["value"] is not None and time.monotonic() - _MAINT["at"] < _MAINT_TTL_S:
        return dict(_MAINT["value"])
    try:
        st = md.get_system_settings()
        val = {"enabled": _truthy(st.get(JOBS_PAUSED_KEY)), "since": st.get("jobs_paused_at"), "by": st.get("jobs_paused_by")}
    except Exception:  # noqa: BLE001
        return {"enabled": False, "since": None, "by": None}
    _MAINT.update(at=time.monotonic(), value=val)
    return dict(val)


def set_maintenance(enabled: bool, actor: str | None) -> dict:
    patch = {JOBS_PAUSED_KEY: bool(enabled), "jobs_paused_at": datetime.now(timezone.utc).isoformat(timespec="seconds") if enabled else None,
             "jobs_paused_by": actor if enabled else None}
    md.upsert_system_settings(patch, actor)
    _MAINT["value"] = None
    return maintenance_state(fresh=True)


_CAL_CACHE: dict[str, tuple] = {}


def calendar_versions(plants) -> dict[str, str | None]:
    """plant -> `plant_calendar_version` (a failed probe is None)."""
    out: dict[str, str | None] = {}
    for p in sorted({x for x in plants if x}):
        try:
            out[p] = db.plant_calendar_version(p)
        except Exception:  # noqa: BLE001
            out[p] = None
    return out


def load_calendar_view(plants, zones: dict[str, str] | None = None):
    """A `PlantCalendarView` over these plants' calendars (full calendar re-read only when its version changed). A
    plant whose calendar cannot be read is left out, so the view treats it as always working (fail open)."""
    from zoneinfo import ZoneInfo
    from backend.jobs.calview import PlantCalendarView
    cals: dict[str, dict] = {}
    for p, ver in calendar_versions(plants).items():
        hit = _CAL_CACHE.get(p)
        if hit and ver is not None and hit[0] == ver:
            cals[p] = hit[1]
            continue
        try:
            cal = md.load_plant_calendar(p)
        except Exception:  # noqa: BLE001
            continue
        _CAL_CACHE[p] = (ver, cal)
        cals[p] = cal
    zs = {}
    for p, z in (zones or {}).items():
        try:
            zs[p] = ZoneInfo(z)
        except Exception:  # noqa: BLE001
            pass
    return PlantCalendarView(cals, zs)


def timeline_run_plants(*, allowed_plants, start: datetime, end: datetime, limit: int = 2000) -> list[str]:
    """Plants with at least one run overlapping [start, end) (the lanes that have history)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT r.plant FROM job_run r"
            " WHERE (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND COALESCE(r.started_at, r.scheduled_for, r.created_at) < %(end)s"
            "   AND COALESCE(r.ended_at, clock_timestamp()) >= %(start)s ORDER BY r.plant LIMIT %(lim)s",
            {"allowed": allowed_plants, "start": start, "end": end, "lim": limit})
        return [r[0] for r in cur.fetchall()]


def timeline_runs(*, allowed_plants, plants: list[str] | None, start: datetime, end: datetime, limit: int) -> list[dict]:
    """Runs overlapping [start, end) in the visible plants (oldest first), at most `limit + 1` rows (the caller trims
    and reports `truncated`)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT r.id, r.job_id, d.name AS job_name, r.plant, r.job_type, r.status, r.trigger, r.batch_id,"
            " r.scheduled_for, r.started_at, r.ended_at, r.created_at, r.error"
            "  FROM job_run r JOIN job_definition d ON d.id = r.job_id"
            " WHERE (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "   AND (%(plants)s::text[] IS NULL OR r.plant = ANY(%(plants)s))"
            "   AND COALESCE(r.started_at, r.scheduled_for, r.created_at) < %(end)s"
            "   AND COALESCE(r.ended_at, clock_timestamp()) >= %(start)s"
            " ORDER BY COALESCE(r.started_at, r.scheduled_for, r.created_at), r.id LIMIT %(lim)s",
            {"allowed": allowed_plants, "plants": plants, "start": start, "end": end, "lim": limit + 1})
        return cur.fetchall()


def _member_sql(p: str) -> str:
    """SQL: plant code expression `p` is in job `d`'s CURRENT target expansion (an included row names it, no excluded
    row removes it). Mirrors `targets.expand_targets`; used for the list's plant filter and scoped visibility."""
    hit = (f"(%s.kind = 'explicit' AND %s.value = {p}) OR (%s.kind = 'subnetwork' AND %s.value IN"
           f" (SELECT subnetwork FROM plants WHERE plant = {p}))")
    inc = hit.replace("%s", "t") + f" OR (t.kind = 'all' AND (t.value = '*' OR {p} = ANY(string_to_array(t.value, ','))))"
    exc = hit.replace("%s", "x")
    return (f"(EXISTS (SELECT 1 FROM job_target t WHERE t.job_id = d.id AND NOT t.excluded AND ({inc}))"
            f" AND NOT EXISTS (SELECT 1 FROM job_target x WHERE x.job_id = d.id AND x.excluded AND ({exc})))")


def list_jobs(*, allowed_plants, plant, job_type, status, q, include_archived, limit, before_id) -> dict:
    """Newest-first page of definitions with their schedules and last run attached (raw dicts)."""
    has_t = "EXISTS (SELECT 1 FROM job_target ht WHERE ht.job_id = d.id)"
    sql = f"""
    SELECT d.id FROM job_definition d
      LEFT JOIN LATERAL (SELECT status, error FROM job_run r WHERE r.job_id = d.id
                          AND (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s)) ORDER BY r.id DESC LIMIT 1) lr ON TRUE
      LEFT JOIN LATERAL (SELECT b.status FROM job_batch b WHERE b.job_id = d.id AND (%(allowed)s::text[] IS NULL
                          OR EXISTS (SELECT 1 FROM job_run br WHERE br.batch_id = b.id AND br.plant = ANY(%(allowed)s)))
                          ORDER BY b.id DESC LIMIT 1) lb ON TRUE
     WHERE (%(allowed)s::text[] IS NULL OR d.plant = ANY(%(allowed)s)
            OR EXISTS (SELECT 1 FROM unnest(%(allowed)s::text[]) ap(code) WHERE {_member_sql('ap.code')}))
       AND (%(plant)s::text IS NULL OR (NOT {has_t} AND d.plant = %(plant)s) OR ({has_t} AND {_member_sql('%(plant)s')}))
       AND (%(jt)s::text IS NULL OR d.job_type = %(jt)s)
       AND (%(status)s::text IS NULL
            OR (CASE WHEN {has_t} THEN COALESCE(lb.status, lr.status) ELSE lr.status END) = %(status)s
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
                        " ON d.id = r.job_id WHERE r.job_id = ANY(%s) AND (%s::text[] IS NULL OR r.plant = ANY(%s))"
                        " ORDER BY r.job_id, r.id DESC", (page, allowed_plants, allowed_plants))
            last = {r["job_id"]: r for r in cur.fetchall()}
            tgt = _targets_for(cur, page)
            multi = [i for i in page if tgt.get(i)]
            lastb: dict = {}
            if multi:
                cur.execute(f"SELECT DISTINCT ON (b.job_id) {_BATCH_COLS} FROM job_batch b JOIN job_definition d"
                            " ON d.id = b.job_id WHERE b.job_id = ANY(%s) AND (%s::text[] IS NULL OR EXISTS"
                            " (SELECT 1 FROM job_run r WHERE r.batch_id = b.id AND r.plant = ANY(%s)))"
                            " ORDER BY b.job_id, b.id DESC", (multi, allowed_plants, allowed_plants))
                lastb = {b["job_id"]: b for b in cur.fetchall()}
            for j in jobs:
                j["schedules"] = by_job.get(j["id"], [])
                j["targets"] = tgt.get(j["id"], [])
                j["last_run"] = last.get(j["id"])
                j["last_batch"] = lastb.get(j["id"])
    batches = scope_batches([j["last_batch"] for j in jobs if j.get("last_batch")], allowed_plants)
    live = {b["job_id"]: b for b in batches}
    for j in jobs:
        j["last_batch"] = live.get(j["id"])
    return {"jobs": jobs, "next_before_id": page[-1] if len(ids) > limit and page else None}


def list_active_schedules() -> list[dict]:
    """Every schedule the scheduler should currently be armed with (joined with its job's plant/params)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT s.id, s.job_id, s.kind, s.cron_expr, s.time_of_day, s.days_of_week, s.day_of_month, s.run_at,"
            " s.timezone, s.valid_from, s.valid_until, s.misfire_grace_s, s.modified_at, s.tz_mode, s.fixed_timezone,"
            " s.options, s.last_fire_at, s.skip_if_running, d.plant, d.job_type, d.modified_at AS job_modified_at, d.scope_plants"
            "  FROM job_schedule s JOIN job_definition d ON d.id = s.job_id"
            " WHERE NOT s.retired AND NOT s.paused AND d.enabled AND NOT d.archived ORDER BY s.id")
        rows = cur.fetchall()
        tgt = _targets_for(cur, sorted({r["job_id"] for r in rows})) if rows else {}
        for r in rows:
            r["targets"] = tgt.get(r["job_id"], [])
        return rows


def next_fire_schedules(*, allowed_plants, plant) -> list[dict]:
    """Armed schedules of enabled, non-archived jobs in the visible plants, with the job's name and plant: all the
    next-fire summary needs (no runs, no params). Scoped by plant in SQL, not by a page of the newest jobs."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            "SELECT s.id, s.job_id, s.kind, s.cron_expr, s.time_of_day, s.days_of_week, s.day_of_month, s.run_at,"
            " s.timezone, s.valid_from, s.valid_until, s.misfire_grace_s, s.tz_mode, s.fixed_timezone, s.options,"
            " d.name AS job_name, d.plant, d.scope_plants"
            "  FROM job_schedule s JOIN job_definition d ON d.id = s.job_id"
            " WHERE NOT s.retired AND NOT s.paused AND d.enabled AND NOT d.archived"
            "   AND (%(allowed)s::text[] IS NULL OR d.plant = ANY(%(allowed)s)"
            f"        OR EXISTS (SELECT 1 FROM unnest(%(allowed)s::text[]) ap(code) WHERE {_member_sql('ap.code')}))"
            # A plant filter names a TARGETED plant, not the home plant: a multi-plant job matches by its expansion
            # and the route keeps only that plant's arms.
            "   AND (%(plant)s::text IS NULL OR (NOT EXISTS (SELECT 1 FROM job_target ht WHERE ht.job_id = d.id)"
            f"        AND d.plant = %(plant)s) OR {_member_sql('%(plant)s')}) ORDER BY s.id",
            {"allowed": allowed_plants, "plant": plant})
        rows = cur.fetchall()
        tgt = _targets_for(cur, sorted({r["job_id"] for r in rows})) if rows else {}
        for r in rows:
            r["targets"] = tgt.get(r["job_id"], [])
        return rows


def schedule_has_run(schedule_id: int) -> bool:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM job_run WHERE schedule_id = %s LIMIT 1", (schedule_id,))
        return cur.fetchone() is not None


def schedule_fired_plants(schedule_id: int) -> set[str]:
    """Plants that already have a run for the schedule (a `once` schedule in each plant's local time is spent per plant)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT plant FROM job_run WHERE schedule_id = %s", (schedule_id,))
        return {r[0] for r in cur.fetchall()}


# ------------------------------------------------------------------------------------------------------ runs
def insert_run(*, job_id: int, schedule_id: int | None, plant: str, job_type: str, status: str, trigger: str,
               attempt: int = 1, scheduled_for: datetime | None = None, triggered_by: str | None = None,
               error: str | None = None, batch_id: int | None = None, summary: dict | None = None) -> int:
    ended = status in TERMINAL
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO job_run (job_id, schedule_id, plant, job_type, status, trigger, attempt, scheduled_for,"
            " triggered_by, error, batch_id, summary, ended_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
            " CASE WHEN %s THEN clock_timestamp() END) RETURNING id",
            (job_id, schedule_id, plant, job_type, status, trigger, attempt, scheduled_for, triggered_by, error,
             batch_id, Jsonb(summary) if summary is not None else None, ended))
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


# ----------------------------------------------------------------------------------------------------- batches
_BATCH_COLS = ("b.id, b.job_id, d.name AS job_name, b.schedule_id, b.scheduled_for, b.trigger, b.triggered_by,"
               " b.status, b.counts, b.started_at, b.ended_at, b.summary")


def insert_batch(*, job_id: int, schedule_id: int | None, scheduled_for: datetime | None, trigger: str,
                 triggered_by: str | None, summary: dict | None = None) -> int:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO job_batch (job_id, schedule_id, scheduled_for, trigger, triggered_by, summary)"
                    " VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                    (job_id, schedule_id, scheduled_for, trigger, triggered_by,
                     Jsonb(summary) if summary is not None else None))
        bid = cur.fetchone()[0]
        conn.commit()
    return bid


def batch_idle_check_and_insert(*, job: dict, trigger: str, triggered_by: str | None,
                                scheduled_for: datetime, plant: str | None = None) -> int | None:
    """A manual/restart batch, unless the job has a scheduled|running run or a live batch. Check and insert share one
    transaction under the same per-job advisory xact lock `insert_manual_run_if_idle` uses. None = already active.
    A running batch only counts while it is live: it has no children yet (being prepared) or a child still active
    (already covered by the run check); one whose children are all terminal is just waiting for its rollup and never
    blocks. `plant` (a per-plant restart) checks only that plant's runs and ignores batches."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"jobs:manual:{job['id']}",))
        cur.execute(
            "INSERT INTO job_batch (job_id, scheduled_for, trigger, triggered_by)"
            " SELECT %s, %s, %s, %s WHERE NOT EXISTS (SELECT 1 FROM job_run WHERE job_id = %s"
            " AND status IN ('scheduled','running') AND (%s::text IS NULL OR plant = %s))"
            " AND (%s::text IS NOT NULL OR NOT EXISTS (SELECT 1 FROM job_batch b WHERE b.job_id = %s"
            " AND b.status = 'running' AND (NOT EXISTS (SELECT 1 FROM job_run r WHERE r.batch_id = b.id)"
            " OR EXISTS (SELECT 1 FROM job_run r WHERE r.batch_id = b.id AND r.status IN ('scheduled','running')))))"
            " RETURNING id",
            (job["id"], scheduled_for, trigger, triggered_by, job["id"], plant, plant, plant, job["id"]))
        row = cur.fetchone()
        conn.commit()
    clear_health_cache()
    return row[0] if row else None


def get_batch(batch_id: int) -> dict | None:
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_BATCH_COLS} FROM job_batch b JOIN job_definition d ON d.id = b.job_id WHERE b.id = %s",
                    (batch_id,))
        return cur.fetchone()


BATCH_RUNS_DEFAULT = 200


def batch_runs(batch_id: int, allowed_plants, limit: int = BATCH_RUNS_DEFAULT, offset: int = 0) -> list[dict]:
    """Child runs of a batch (plant, then id), restricted to the caller's plants, one page (`limit`/`offset`)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(f"SELECT {_RUN_COLS} FROM job_run r JOIN job_definition d ON d.id = r.job_id"
                    " WHERE r.batch_id = %s AND (%s::text[] IS NULL OR r.plant = ANY(%s)) ORDER BY r.plant, r.id"
                    " LIMIT %s OFFSET %s", (batch_id, allowed_plants, allowed_plants, limit, offset))
        return cur.fetchall()


def batch_latest_by_plant(batch_id: int) -> dict[str, str]:
    """{plant: final status} (the newest run of each plant in the batch)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT ON (plant) plant, status FROM job_run WHERE batch_id = %s ORDER BY plant, id DESC",
                    (batch_id,))
        return {p: s for p, s in cur.fetchall()}


def cancel_batch_pending(batch_id: int) -> list[int]:
    """A cancelled batch: every child still `scheduled` becomes `skipped` ('batch cancelled'); returns the ids of the
    children that are `running` (the caller cancels those through the runner)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = 'skipped', error = 'batch cancelled', ended_at = clock_timestamp(),"
                    " summary = COALESCE(summary, '{}'::jsonb) || '{\"error_kind\": \"config\", \"failed_step\": \"cancel\"}'::jsonb"
                    " WHERE batch_id = %s AND status = 'scheduled'", (batch_id,))
        cur.execute("SELECT id FROM job_run WHERE batch_id = %s AND status = 'running'", (batch_id,))
        running = [r[0] for r in cur.fetchall()]
        conn.commit()
    clear_health_cache()
    return running


def fail_batch_children(batch_id: int, error: str, status: str = "failed") -> int:
    """Close every child of the batch that never started (`scheduled`) with `error` (a preparation or dispatch crash)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET status = %s, error = %s, ended_at = clock_timestamp(),"
                    " summary = COALESCE(summary, '{}'::jsonb) || '{\"error_kind\": \"system\"}'::jsonb"
                    " WHERE batch_id = %s AND status = 'scheduled'", (status, error, batch_id))
        n = cur.rowcount
        conn.commit()
    clear_health_cache()
    return n


def schedule_ran_on(schedule_id: int, plant: str, tz: str, local_date) -> bool:
    """A run (not a skip) of this schedule for `plant` already exists whose fire time falls on `local_date` in `tz`:
    a re-armed once-a-day fire (a timezone edit) must not run the same plant twice that day."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM job_run WHERE schedule_id = %s AND plant = %s AND trigger IN ('schedule','catchup')"
                    " AND status <> 'skipped' AND (scheduled_for AT TIME ZONE %s)::date = %s LIMIT 1",
                    (schedule_id, plant, tz, local_date))
        return cur.fetchone() is not None


def batch_latest_statuses(batch_ids: list[int], allowed_plants=None) -> dict[int, list[str]]:
    """Final status per plant (the newest run of each plant, so a retry replaces its failed attempt) for each batch."""
    out: dict[int, list[str]] = {b: [] for b in batch_ids}
    if not batch_ids:
        return out
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT batch_id, status FROM (SELECT DISTINCT ON (batch_id, plant) batch_id, plant, status"
                    " FROM job_run WHERE batch_id = ANY(%s) AND (%s::text[] IS NULL OR plant = ANY(%s))"
                    " ORDER BY batch_id, plant, id DESC) x", (batch_ids, allowed_plants, allowed_plants))
        for bid, st in cur.fetchall():
            out[bid].append(st)
    return out


def finish_batch(batch_id: int, *, force_status: str | None = None, summary_extra: dict | None = None) -> dict | None:
    """Recompute counts from the children's newest runs. While any child is still scheduled|running (and not forced)
    only the counts move; otherwise the status becomes the rollup (or `force_status`) and `ended_at` is set."""
    from backend.jobs import targets as jt
    sts = batch_latest_statuses([batch_id])[batch_id]
    live = any(s in ("scheduled", "running") for s in sts)
    counts = jt.counts_of(sts)
    done = force_status is not None or not live
    status = force_status or (jt.rollup(sts) if done else "running")
    if not sts and not force_status:
        status = "warning"                 # a batch with no children is never a green success
        summary_extra = {"note": "no plants to run", **(summary_extra or {})}
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_batch SET counts = %s, status = %s,"
                    " ended_at = CASE WHEN %s THEN COALESCE(ended_at, clock_timestamp()) ELSE ended_at END,"
                    " summary = COALESCE(summary, '{}'::jsonb) || %s::jsonb WHERE id = %s AND status = 'running'",
                    (Jsonb(counts), status, done, Jsonb(summary_extra or {}), batch_id))
        conn.commit()
    clear_health_cache()
    return get_batch(batch_id)


def list_batches(*, allowed_plants, plant, job_id, status, limit, before_id) -> dict:
    """Newest-first page of batches that contain at least one run for a plant the caller may see (and for `plant`)."""
    with db._pool.connection() as conn, _cur(conn) as cur:
        cur.execute(
            f"SELECT {_BATCH_COLS} FROM job_batch b JOIN job_definition d ON d.id = b.job_id"
            " WHERE (%(job)s::bigint IS NULL OR b.job_id = %(job)s)"
            "   AND (%(status)s::text IS NULL OR b.status = %(status)s)"
            "   AND (%(before)s::bigint IS NULL OR b.id < %(before)s)"
            "   AND EXISTS (SELECT 1 FROM job_run r WHERE r.batch_id = b.id"
            "               AND (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "               AND (%(plant)s::text IS NULL OR r.plant = %(plant)s))"
            " ORDER BY b.id DESC LIMIT %(lim)s",
            {"job": job_id, "status": status, "before": before_id, "allowed": allowed_plants, "plant": plant,
             "lim": limit + 1})
        rows = cur.fetchall()
    page = rows[:limit]
    return {"batches": page, "next_before_id": page[-1]["id"] if len(rows) > limit and page else None}


def scope_batches(batches: list[dict], allowed_plants) -> list[dict]:
    """Live counts for every batch (the newest run of each plant, one query for the page), so a running batch's tiles
    move while it runs; a plant-scoped caller sees counts and status over their own plants only (never the other
    plants' tally). An unrestricted caller keeps the stored status, which is the rollup over all plants."""
    if not batches:
        return batches
    from backend.jobs import targets as jt
    vis = batch_latest_statuses([b["id"] for b in batches], allowed_plants)
    out = []
    for b in batches:
        sts = vis[b["id"]]
        status = b["status"]
        if allowed_plants is not None and status != "running":
            status = jt.rollup(sts)
        out.append({**b, "counts": jt.counts_of(sts) if sts else (b["counts"] or {}), "status": status})
    return out


PERIODICITIES = ("once","hourly", "daily", "weekdays", "weekly", "monthly", "cron", "manual")


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
        # Batches (a fan-out of plant runs) that finished failed in the window: one tile detail, whatever the number
        # of plants behind each. The other counts above are PLANT RUNS.
        cur.execute(
            "SELECT COUNT(*) FROM job_batch b WHERE b.status = 'failed' AND b.ended_at >= now() - make_interval(hours => %(h)s)"
            " AND EXISTS (SELECT 1 FROM job_run r WHERE r.batch_id = b.id"
            "             AND (%(allowed)s::text[] IS NULL OR r.plant = ANY(%(allowed)s))"
            "             AND (%(plant)s::text IS NULL OR r.plant = %(plant)s))",
            {"allowed": allowed_plants, "plant": plant, "h": hours})
        failed_batches = cur.fetchone()["count"]
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
            "failed_batches_24h": failed_batches,
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
    body = artifacts._dumps(capped)
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
    info = {"row_counts": counts, "size_bytes": size, "truncated": truncated}
    if (capped.get("summary") or {}).get("artifact_error"):
        info["error"] = str(capped["summary"]["artifact_error"])
    return info


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


def last_success_watermark(job_id: int, before_run_id: int | None = None, plant: str | None = None) -> datetime | None:
    """The `last_success` window anchor: the RESOLVED END of the previous SCHEDULED finished (succeeded or warning) run
    (`summary.window.end`, so the next window starts exactly where the last one stopped and nothing is lost between
    runs); a run without a stored window falls back to its started_at. Manual runs never move it. Keyed by
    (job, plant): in a multi-plant job one plant's success must not move another plant's window (a plant that failed
    last night still owes that night). `plant` None = any plant (the legacy single-plant job)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT COALESCE(NULLIF(summary->'window'->>'end', '')::timestamptz, started_at) FROM job_run"
                    " WHERE job_id = %s AND trigger IN ('schedule','catchup') AND status IN ('succeeded','warning')"
                    " AND started_at IS NOT NULL AND (%s::bigint IS NULL OR id < %s::bigint)"
                    " AND (%s::text IS NULL OR plant = %s)"
                    " ORDER BY id DESC LIMIT 1", (job_id, before_run_id, before_run_id, plant, plant))
        r = cur.fetchone()
    return r[0] if r else None


# ------------------------------------------------------------------------------------------------- sweeps
def boot_sweep() -> int:
    """Rows still `scheduled`/`running` when the process starts belong to a process that died: mark them failed.
    Single-replica assumption (a second replica would clobber the first one's live runs)."""
    with db._pool.connection() as conn, conn.cursor() as cur:
        # A batch child that never started was not interrupted, it was not reached: `skipped`, so it neither counts as
        # a failure in the 24 h health tiles nor reads as a crash. Catch-up of these is W3b.
        cur.execute("UPDATE job_run SET status = 'skipped', error = 'not started: restart interrupted the batch',"
                    " summary = COALESCE(summary, '{}'::jsonb) || '{\"error_kind\": \"system\"}'::jsonb,"
                    " ended_at = clock_timestamp() WHERE status = 'scheduled' AND batch_id IN"
                    " (SELECT id FROM job_batch WHERE status = 'running')")
        cur.execute("UPDATE job_run SET status = 'failed', error = 'interrupted by restart',"
                    " summary = COALESCE(summary, '{}'::jsonb) || '{\"error_kind\": \"system\"}'::jsonb,"
                    " ended_at = clock_timestamp() WHERE status IN ('scheduled','running')")
        n = cur.rowcount
        cur.execute("SELECT id FROM job_batch WHERE status = 'running'")
        stale = [r[0] for r in cur.fetchall()]
        conn.commit()
    for bid in stale:                  # a batch never stays running after a restart: same rule as its children
        finish_batch(bid, force_status="failed", summary_extra={"error_kind": "system", "error": "interrupted by restart"})
    clear_health_cache()
    return n


def sweep_job_runs(*, retention_days=None, chunk: int = 500, max_chunks: int = 200,
                   statement_timeout_ms: int = 30_000, pause_s: float = 0.1) -> dict:
    """Trim finished runs older than the retention window (log lines first, then the run rows) in chunks of
    `chunk` runs. Never raises. One transaction per chunk, opening with an advisory xact lock; another sweeper
    holding it yields {"locked": True}. Stores its result in DIAGNOSTICS["job_run_last_sweep"]."""
    result = {"deleted_runs": 0, "deleted_log_lines": 0, "deleted_artifacts": 0, "deleted_batches": 0, "chunks": 0, "retention_days": None,
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
                # A batch goes once it is old enough and none of its runs is left (job_run.batch_id has no cascade).
                cur.execute("DELETE FROM job_batch b WHERE b.ended_at < now() - make_interval(days => %s)"
                            " AND NOT EXISTS (SELECT 1 FROM job_run r WHERE r.batch_id = b.id)", (days,))
                result["deleted_batches"] += cur.rowcount
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

