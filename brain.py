"""
NIMBUS 2.0 — FastAPI backend (brain.py).

STATELESS: Postgres is the single source of truth. There is no in-memory order
cache — every request queries the DB with a server-side plant/line scope, so the
app can run as multiple uvicorn workers / replicas behind a load balancer
(edits made on one replica are immediately visible to all).

Data flow:
  Postgres orders
        │
        ├─ GET /tasks?plant=… ──► db.query_orders() → color merge → JSON  (per request)
        ├─ POST /task(s)/update ─► db.update_task_dates_bulk()  (write-through, one txn)
        ├─ POST /upload ─────────► db.ingest_orders_from_excel() (batched upsert)
        └─ POST /reload ─────────► re-read color-wheel files (the cross-replica
                                   refresh hook; orders are never cached)

Task IDs are stable MD5 hashes of "{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"
computed in db.make_id(). The frontend keys every drag/edit operation on these IDs.

Color wheels are still per-plant .xlsx files under COLOR_WHEEL_DIR, loaded into a
small in-process cache (GLOBAL_CW / PLANT_CWS); POST /reload refreshes that cache.
"""
import collections
import contextvars
import io
import json
import logging
import os
import re
import sys
import time
import traceback
import uuid
import pandas as pd
import psycopg
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from pydantic import BaseModel

import auth
import db
import master_data as md
import sap_sync
from auth import require_admin


# =========================
# STRUCTURED LOGGING
# =========================
# Emit one JSON object per log line to stdout so container/Azure log pipelines
# can index level/category/rid without regex-scraping. Scoped to the "nimbus"
# logger tree (propagate=False) so we don't fight uvicorn's own handlers.
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # Prefer the NIMBUS event level/ts when the caller (_log_event) supplied
        # them via `extra`, so the ring buffer and this JSON line agree on the
        # canonical level vocab (info|warn|error) and the event timestamp rather
        # than recomputing them here. Falls back to the stdlib record for any
        # non-nimbus log that reaches this formatter.
        payload = {
            "ts":    getattr(record, "evt_ts", None) or pd.Timestamp.utcnow().isoformat(),
            "level": getattr(record, "evt_level", None) or record.levelname.lower(),
            "logger": record.name,
            "msg":   record.getMessage(),
        }
        for k in ("category", "ctx", "rid", "error_code", "error_type"):
            v = getattr(record, k, None)
            if v is not None:
                payload[k] = v
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    nimbus_log = logging.getLogger("nimbus")
    nimbus_log.handlers[:] = [handler]
    nimbus_log.setLevel(logging.INFO)
    nimbus_log.propagate = False


_configure_logging()
_evt_log = logging.getLogger("nimbus.event")

# Per-request id, set in request_id_mw and read by _log_event so every structured
# event auto-carries the rid (both the ring buffer entry and the JSON log line)
# without threading it through every call site. None outside a request.
_RID_CTX: contextvars.ContextVar[str | None] = contextvars.ContextVar("nimbus_rid", default=None)


def _current_rid() -> str | None:
    """Read the request id from the contextvar (None outside a request)."""
    return _RID_CTX.get()

# =========================
# GLOBAL DATA
# =========================
# (No in-memory order cache — see module docstring. Orders are queried per request.)
COLOR_FILE = os.getenv("COLOR_FILE", r"C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\color_wheel.xlsx")

# Color-wheel cache populated by load_color_wheels(); apply_color_merge() reads from these
# instead of touching disk per request.
GLOBAL_CW: dict = {}        # { COLOR -> ORDER_Y }
PLANT_CWS: dict = {}        # { safe_plant_key: { COLOR: ORDER_Y } }
CW_LOADED_AT: str | None = None

# =============================================================================
# COLOR WHEEL STORAGE — PLANT-SPECIFIC FILES
# =============================================================================
# Per-plant color wheels are uploaded through the Plant tab UI and stored here.
#
# ► IF YOU MOVE THIS APP TO A NEW MACHINE, change COLOR_WHEEL_DIR below to any
#   folder you have read/write access to. The folder is created automatically
#   on startup if it does not already exist. Nothing else needs to change.
#
# File layout inside COLOR_WHEEL_DIR:
#   color_wheel_<PLANT>.xlsx   — one file per plant (plant code sanitized to [A-Z0-9_])
#   _meta.json                 — upload metadata per plant (filename, row count, timestamp, user)
#   _audit_log.json            — append-only log of all color-wheel + optimization events
# =============================================================================
COLOR_WHEEL_DIR = os.getenv("COLOR_WHEEL_DIR", r"C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\color_wheels")

# Opt-in one-time migration of legacy on-disk color_wheel_<SAFE>.xlsx files into
# the color_wheel table at startup (only when the table is empty). OFF by default
# so running the app locally against a REMOTE DB never silently pushes local dev
# wheels into it — enable deliberately (NIMBUS_CW_BACKFILL=1) on the box that
# holds the authoritative files. A no-op in the container regardless (its /data
# is ephemeral and empty on boot).
CW_BACKFILL_FROM_DISK = os.getenv("NIMBUS_CW_BACKFILL", "").strip().lower() in ("1", "true", "yes")

# Directory holding the frontend served by the StaticFiles mount at the bottom of
# this file. Defaults to the "web" directory next to this file — not the process's
# current working directory — so `uvicorn brain:api` always serves the dedicated
# frontend tree (never brain.py/db.py/schema.sql alongside it) regardless of where
# it's launched from. NIMBUS_STATIC_DIR can still override this for the container.
STATIC_DIR = os.getenv("NIMBUS_STATIC_DIR") or str(Path(__file__).resolve().parent / "web")

# =========================
# LIFESPAN
# =========================
async def _run_sap_job(object_key: str) -> None:
    """APScheduler job body for one SAP object. Offloads the blocking sync to the
    threadpool (sap_sync.sync_object is sync + does DB I/O) so the event loop is
    never stalled, and logs the outcome. Never raises — a failed sync is logged,
    not allowed to crash the scheduler thread."""
    try:
        result = await run_in_threadpool(
            sap_sync.sync_object, object_key, user_email="sap-scheduler")
        if result.get("status") == "ok":
            _log_event("info", "sap_sync", "Scheduled SAP sync completed",
                       object_key=object_key,
                       rows_read=result.get("rows_read", 0),
                       rows_inserted=result.get("rows_inserted", 0),
                       rows_updated=result.get("rows_updated", 0),
                       rows_failed=result.get("rows_failed", 0))
        else:
            _log_event("error", "sap_sync", "Scheduled SAP sync failed",
                       object_key=object_key, error=result.get("error"))
    except Exception as e:
        _log_event("error", "sap_sync", "Scheduled SAP sync raised",
                   exc=e, object_key=object_key)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(COLOR_WHEEL_DIR, exist_ok=True)
    _migrate_audit_log()
    db.ensure_color_wheel_table()
    if CW_BACKFILL_FROM_DISK:
        _backfill_color_wheels_from_disk()
    load_color_wheels(COLOR_FILE)
    md.ensure_labor_plan_table()
    md.ensure_labor_plan_line_table()
    md.ensure_plant_constraints_column()
    md.ensure_work_hours_columns()
    md.ensure_line_calendar_table()
    md.ensure_line_blackout_table()
    md.ensure_line_key_columns()
    md.ensure_plant_blackout_table()
    md.ensure_unique_plant()
    md.ensure_roles_table()
    md.ensure_role_plants_table()
    auth.ensure_user_security_table()
    auth.ensure_bootstrap_admin()
    auth.ensure_role_settings_column()
    auth.ensure_user_settings_table()
    _log_event("info", "startup", "Color wheels loaded",
               global_colors=len(GLOBAL_CW), plant_wheels=len(PLANT_CWS))
    # Stateless backend: orders are NOT loaded into memory at startup — every
    # /tasks request queries Postgres with a plant/line scope. This is what lets
    # the app run as multiple workers/replicas. We just probe the DB so startup
    # surfaces a connection problem early and logs the current row count.
    DIAGNOSTICS["loaded_at"] = pd.Timestamp.utcnow().isoformat()
    DIAGNOSTICS["source_file"] = "postgres://nimbus/orders"
    try:
        health = db.get_health_stats()
        _log_event("info", "startup", "Connected to Postgres (stateless mode)",
                   total_orders=health.get("total_orders", 0),
                   connected=health.get("connected", False))
    except Exception as e:
        _log_event("error", "startup", "DB probe failed at startup", error=str(e))

    # SAP background sync scheduler — DISABLED by default (see SAP_SYNC_ENABLED).
    # When enabled, register one cron job per enabled+scheduled SAP object. APScheduler
    # is imported lazily so it is only a hard dependency when the feature is on.
    app.state.sap_scheduler = None
    if SAP_SYNC_ENABLED:
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
            from apscheduler.triggers.cron import CronTrigger
            scheduler = AsyncIOScheduler()
            jobs = sap_sync.list_enabled_jobs()
            for job in jobs:
                object_key = job["object_key"]
                scheduler.add_job(
                    _run_sap_job,
                    CronTrigger.from_crontab(job["schedule_cron"]),
                    args=[object_key],
                    id="sap:" + object_key,
                    max_instances=1,
                    coalesce=True,
                    replace_existing=True,
                )
            scheduler.start()
            app.state.sap_scheduler = scheduler
            _log_event("info", "sap_sync", "SAP sync scheduler started",
                       jobs=len(jobs))
        except Exception as e:
            _log_event("error", "sap_sync", "SAP sync scheduler failed to start", exc=e)
    else:
        _log_event("info", "sap_sync", "SAP sync scheduler disabled (NIMBUS_SAP_SYNC_ENABLED not set)")

    yield

    scheduler = getattr(app.state, "sap_scheduler", None)
    if scheduler is not None:
        with suppress(Exception):
            scheduler.shutdown(wait=False)
        _log_event("info", "sap_sync", "SAP sync scheduler stopped")
    _log_event("info", "startup", "Server shutting down")

api = FastAPI(lifespan=lifespan)

# CORS. The frontend uses header-based identity and sends NO cookies/credentials, so
# allow_credentials MUST be False — a wildcard origin combined with credentials is
# rejected by the CORS spec (browsers refuse it; Starlette won't echo "*"). Origins
# default to "*" (any dev origin works for credential-less requests) but can be pinned
# for hosting via NIMBUS_ALLOWED_ORIGINS (comma-separated). Set an explicit allowlist
# before any internet-facing deployment.
_origins_env = os.getenv("NIMBUS_ALLOWED_ORIGINS", "*").strip()
ALLOWED_ORIGINS = (
    ["*"] if _origins_env == "*"
    else [o.strip() for o in _origins_env.split(",") if o.strip()]
)

api.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["x-request-id"],
)

# Gzip every response over ~1 KB (honours Accept-Encoding). The single biggest
# wire-size win for the static frontend: app.js (~717 KB) + the active locale +
# styles.css + JSON payloads all ship compressed (~75% smaller) through the same
# StaticFiles mount and API. Cheap, transparent, and safe behind Container Apps.
api.add_middleware(GZipMiddleware, minimum_size=1000)

# Optional shared-secret guard for destructive / DDL / maintenance routes. It is a
# NO-OP until NIMBUS_API_KEY is set in the environment, so the (login-less) frontend
# keeps working untouched in dev; set the env var AND have admin clients send the
# matching X-API-Key header to lock these routes down for a hosted deployment.
# NOTE: this is a deployment-config patch, NOT user-level auth — actor identity is
# still taken from spoofable X-User / x-user-email headers. Proper per-user auth/SSO
# with server-verified identity is the real fix (see MIGRATION.md → "User security").
NIMBUS_API_KEY = os.getenv("NIMBUS_API_KEY")

# Master kill-switch for the SAP background sync scheduler. DISABLED by default —
# the SAP interface endpoints (config/mappings/test/manual-sync) always work, but
# NO cron jobs fire unless this is explicitly turned on. This is the non-live
# skeleton stance: connectors are stubs and nothing reaches out on a timer until
# an operator opts in. Honored once at startup in the lifespan below.
SAP_SYNC_ENABLED = os.getenv("NIMBUS_SAP_SYNC_ENABLED", "0") in ("1", "true", "True")


def require_api_key(x_api_key: str | None = Header(default=None)):
    if NIMBUS_API_KEY and x_api_key != NIMBUS_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# Request-ID middleware: accept inbound x-request-id, generate one if missing,
# echo it back on the response, and log slow requests with the id so frontend
# ErrorLog and backend logs can be joined for support cases.
_req_log = logging.getLogger("nimbus.req")

@api.middleware("http")
async def request_id_mw(request: Request, call_next):
    rid = request.headers.get("x-request-id") or str(uuid.uuid4())
    # Stash the rid on the contextvar so _log_event (and any code it reaches in
    # this request) auto-carries it. Reset on the way out so it never leaks into
    # a pooled worker's next request.
    rid_token = _RID_CTX.set(rid)
    t0 = time.perf_counter()
    try:
        try:
            response = await call_next(request)
        except Exception as exc:
            ms = int((time.perf_counter() - t0) * 1000)
            _req_log.exception(f"unhandled {request.method} {request.url.path} {ms}ms rid={rid}: {exc}")
            _log_event("error", "request", f"Unhandled {request.method} {request.url.path}",
                       exc=exc, ms=ms)
            raise
        ms = int((time.perf_counter() - t0) * 1000)
        response.headers["x-request-id"] = rid
        if ms > 1500:
            _req_log.warning(f"slow {request.method} {request.url.path} {ms}ms rid={rid}")
            _log_event("warn", "request", f"Slow request: {request.method} {request.url.path}",
                       ms=ms, status=response.status_code)
        return response
    finally:
        # Clear the rid so it never leaks into the next request on this worker.
        _RID_CTX.reset(rid_token)


# ES modules must never be served from a stale browser cache while a module
# graph is being migrated in (CQ-1 Phase 1+) — unlike app.js, .mjs files carry
# no APP_VERSION-driven cache-bust query string. Scoped to .mjs only; every
# other static response and API route keeps its existing caching behavior.
@api.middleware("http")
async def static_mjs_no_cache_mw(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.endswith(".mjs"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# Error semantics: surface real HTTP status codes behind ONE consistent JSON
# envelope — {status:"error", message, detail} — instead of the legacy
# `200 + {status:"error"}` AND instead of FastAPI's default {"detail": ...}.
# Unifying the shape means every frontend callsite that reads body.message /
# body.status works the same for every error, whatever its origin.
def _error_response(status_code: int, message: str, rid: str | None,
                    extra_headers: dict | None = None) -> JSONResponse:
    headers = dict(extra_headers or {})
    if rid:
        headers["x-request-id"] = rid
    return JSONResponse(
        status_code=status_code,
        content={"status": "error", "message": message, "detail": message},
        headers=headers or None,
    )


@api.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Covers fastapi.HTTPException too (subclass). Re-shapes {"detail":…} into
    # our envelope while preserving status code + any exception headers.
    rid = request.headers.get("x-request-id")
    msg = exc.detail if isinstance(exc.detail, str) else "error"
    return _error_response(exc.status_code, msg, rid, getattr(exc, "headers", None))


@api.exception_handler(ValueError)
async def _value_error_handler(request: Request, exc: ValueError):
    rid = request.headers.get("x-request-id")
    _log_event("warn", "request", f"Bad request {request.method} {request.url.path}",
               exc=exc, error_code="validation")
    return _error_response(400, str(exc), rid)


@api.exception_handler(psycopg.Error)
async def _db_error_handler(request: Request, exc: psycopg.Error):
    # Translate an uncaught DB error (e.g. an IntegrityError surfacing a
    # constraint violation from a master_data write) into the unified envelope
    # with the right status + an actionable, leak-free client_message. The full
    # SQL/traceback stays in the admin log only.
    info = db.translate_db_error(exc)
    rid = request.headers.get("x-request-id")
    _log_event("error", "db", f"DB error {request.method} {request.url.path}",
               exc=exc, error_code=info["error_code"],
               sqlstate=info.get("sqlstate"), constraint=info.get("constraint_name"),
               table=info.get("table_name"))
    return _error_response(info["http_status"], info["client_message"], rid,
                           {"x-error-code": info["error_code"]})


@api.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception):
    # request_id_mw already logged the traceback on the way out; here we just
    # return a clean JSON 500 (Starlette's default is plain text). Per the
    # client-message policy, leak nothing — just a request-id reference the
    # operator can join to the full traceback in the backend log.
    rid = request.headers.get("x-request-id")
    return _error_response(500, f"Internal error — ref: {rid}", rid)

# =========================
# ENGINE
# =========================
# Global diagnostics bucket populated on every load
DIAGNOSTICS: dict = {
    "loaded_at": None,
    "load_ms": None,
    "source_file": None,
    "raw_row_count": 0,
    "dropped_no_start_date": 0,
    "dropped_no_finish_date_filled": 0,
    "duplicate_ids_suffixed": 0,
    "color_merge_misses": 0,
    "color_merge_ms": None,
    "missed_colors": [],
    "emitted_task_count": 0,
    "unique_id_count": 0,
    "lines": {},
    "warnings": []
}

# In-memory backend event log — ring buffer, newest appended at right
_BACKEND_LOG: collections.deque = collections.deque(maxlen=500)


_LOG_LEVELS = {"info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


def _log_event(level: str, category: str, msg: str, *,
               exc: BaseException | None = None,
               error_code: str | None = None, **ctx) -> None:
    """Append a structured event to the in-memory ring buffer AND emit it as a
    JSON line via the nimbus logger (for container log aggregation).

    v2 (backward compatible — existing callers pass only positional + **ctx):
      - `exc`: when given, capture error_type + the formatted traceback into the
        RING entry (so /logs/backend shows traces, not just str(e)) AND pass
        exc_info=exc to the logger so the JSON-line 'exc' branch fires.
      - `error_code`: explicit code; else, when `exc` is a psycopg.Error, derived
        via db.translate_db_error; else omitted.
      - `rid`: read from the request contextvar so every event auto-carries it
        (and populates the _JsonFormatter rid slot)."""
    ts = pd.Timestamp.utcnow().isoformat()
    rid = _current_rid()
    entry: dict = {
        "ts":       ts,
        "level":    level,
        "category": category,
        "msg":      msg,
    }
    if rid:
        entry["rid"] = rid
    if exc is not None and error_code is None and isinstance(exc, psycopg.Error):
        error_code = db.translate_db_error(exc).get("error_code")
    if error_code:
        entry["error_code"] = error_code
    error_type = None
    if exc is not None:
        error_type = type(exc).__name__
        entry["error_type"] = error_type
        entry["exc"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )
    if ctx:
        entry["ctx"] = {k: (v if isinstance(v, (int, float, bool, type(None))) else str(v))
                        for k, v in ctx.items()}
    _BACKEND_LOG.append(entry)
    _evt_log.log(_LOG_LEVELS.get(level, logging.INFO), msg,
                 exc_info=exc if exc is not None else None,
                 extra={"category": category, "ctx": entry.get("ctx"),
                        "rid": rid, "error_code": error_code, "error_type": error_type,
                        "evt_level": level, "evt_ts": ts})


def _warn(level, msg, **ctx):
    DIAGNOSTICS["warnings"].append({
        "level": level, "msg": msg, "ctx": ctx,
        "ts": pd.Timestamp.utcnow().isoformat(),
    })
    _log_event(level, "load", msg, **ctx)


# =========================
# COLOR WHEEL HELPERS
# =========================
def _cw_safe_name(plant: str) -> str:
    """Sanitize a plant code to a safe filename component (uppercase alphanumeric + underscore)."""
    return re.sub(r'[^\w]', '_', plant.strip().upper())

# The audit log stays file-based for now: COLOR_WHEEL_DIR/_audit_log.json is a
# shared append-only log of color-wheel AND optimization events (see the
# /audit/log endpoints). Wheel DATA + metadata now live in the color_wheel
# Postgres table; only this audit trail remains on disk. Its durability is a
# separately-tracked follow-up (see MIGRATION.md).
def _cw_audit_path() -> str:
    return os.path.join(COLOR_WHEEL_DIR, "_audit_log.json")

def _migrate_audit_log() -> None:
    """Convert a legacy JSON-array audit file to JSON-Lines (idempotent, runs at startup)."""
    path = _cw_audit_path()
    try:
        with open(path, encoding='utf-8') as f:
            content = f.read()
        if content.strip().startswith('['):
            old = json.loads(content)
            with open(path, 'w', encoding='utf-8') as f:
                for e in old:
                    f.write(json.dumps(e) + '\n')
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def _cw_append_audit(entry: dict) -> None:
    with open(_cw_audit_path(), 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')


def _cw_df_to_entries(cw_df) -> dict:
    """Turn a cleaned color-wheel DataFrame into a JSONB-safe {COLOR: ORDER_Y}
    map: colors upper/stripped, ranks coerced to native float (blank/NaN -> None
    so the JSON is valid and reads back as last-priority 999999). Shared by the
    upload path and the disk->DB backfill so the parse rules can't drift."""
    if "ORDER" in cw_df.columns and "ORDER_Y" not in cw_df.columns:
        cw_df = cw_df.rename(columns={"ORDER": "ORDER_Y"})
    colors = cw_df["COLOR"].astype(str).str.upper().str.strip()
    ranks = pd.to_numeric(cw_df["ORDER_Y"], errors="coerce")
    return {
        str(c): (None if pd.isna(v) else float(v))
        for c, v in zip(colors, ranks, strict=True)
    }


def _parse_color_wheel(path: str) -> dict:
    """Read one per-plant color-wheel .xlsx from disk into a {COLOR: ORDER_Y}
    map. Used only by the one-time disk->DB backfill now that wheels persist in
    the color_wheel Postgres table."""
    return _cw_df_to_entries(db.clean(pd.read_excel(path)))


def _backfill_color_wheels_from_disk() -> None:
    """One-time cutover helper (opt-in via NIMBUS_CW_BACKFILL — gated at the
    call site in lifespan): if the color_wheel table is empty but legacy
    color_wheel_<SAFE>.xlsx files still exist in COLOR_WHEEL_DIR, import them into
    the table. A no-op whenever the table already has rows — it never clobbers DB
    data. Preserves an operator's existing on-disk wheels through the file->DB
    cutover when run on the box that holds the authoritative files."""
    try:
        existing, _ = db.list_color_wheels_meta()
        if existing:
            return  # table already populated — leave it alone
    except Exception as e:
        _log_event("warn", "color_wheel", "Color-wheel backfill skipped (table check failed)",
                   exc=e, error_code="db.read")
        return
    if not os.path.isdir(COLOR_WHEEL_DIR):
        return
    imported = 0
    for fname in os.listdir(COLOR_WHEEL_DIR):
        m = re.match(r'^color_wheel_(.+)\.xlsx$', fname, re.IGNORECASE)
        if not m:
            continue
        plant_key = m.group(1).upper()
        try:
            entries = _parse_color_wheel(os.path.join(COLOR_WHEEL_DIR, fname))
            db.upsert_color_wheel(plant_key, plant_key, entries,
                                  filename=fname, row_count=len(entries),
                                  uploaded_by="backfill")
            imported += 1
        except Exception as e:
            _log_event("warn", "color_wheel", "Could not backfill plant color wheel",
                       exc=e, error_code="file.read", filename=fname)
    if imported:
        _log_event("info", "color_wheel",
                   f"Backfilled {imported} color wheel(s) from disk into the color_wheel table",
                   count=imported)


def load_color_wheels(color_file: str = COLOR_FILE) -> None:
    """
    Populate the GLOBAL_CW / PLANT_CWS module-level cache. The global wheel is
    still read from COLOR_FILE on disk (a deploy-time file); per-plant wheels are
    loaded from the durable color_wheel Postgres table. Called at startup, on
    /reload, and after a color-wheel upload/delete.
    """
    global GLOBAL_CW, PLANT_CWS, CW_LOADED_AT

    g_cw: dict = {}
    try:
        gdf = db.clean(pd.read_excel(color_file))
        if "ORDER" in gdf.columns:
            gdf = gdf.rename(columns={"ORDER": "ORDER_Y"})
        gdf["COLOR"] = gdf["COLOR"].astype(str).str.upper().str.strip()
        g_cw = dict(zip(gdf["COLOR"], pd.to_numeric(gdf["ORDER_Y"], errors="coerce"), strict=True))
    except Exception as e:
        # Degrade (empty global wheel) but record why — a missing/corrupt global
        # file silently disabling color priority used to be invisible.
        _log_event("warn", "color_wheel", "Could not read global color wheel",
                   exc=e, error_code="file.read", filename=color_file)

    try:
        p_cws = db.load_all_color_wheels()   # { safe_plant_key: {COLOR: ORDER_Y} }
    except Exception as e:
        # Degrade (no per-plant priority) but record why — orders still schedule,
        # just without color-wheel ordering, matching the missing-wheel behavior.
        p_cws = {}
        _log_event("error", "color_wheel", "Could not load plant color wheels from DB",
                   exc=e, error_code="db.read")

    GLOBAL_CW = g_cw
    PLANT_CWS = p_cws
    CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()


def _reload_one_plant_wheel(plant: str) -> None:
    """
    Refresh the PLANT_CWS cache entry for a single plant from the color_wheel
    table — used after an upload/delete so we don't reload every plant's wheel.
    Pops the key when the plant has no stored wheel (delete path). The key
    derivation matches load_all_color_wheels() exactly: _cw_safe_name(plant).
    """
    global PLANT_CWS, CW_LOADED_AT
    key = _cw_safe_name(plant)
    try:
        row = db.get_color_wheel_row(key)
        if row is None:
            PLANT_CWS.pop(key, None)
        else:
            PLANT_CWS[key] = row["entries"]
    except Exception as e:
        _log_event("warn", "color_wheel", "Could not refresh plant color wheel",
                   exc=e, error_code="db.read", plant=plant)
    CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()


def apply_color_merge(df: pd.DataFrame, plant: str | None = None) -> tuple[pd.DataFrame, dict]:
    """
    Apply per-plant color-wheel priority (with global fallback) to a possibly
    plant-filtered DataFrame. Adds ORDER_Y. Orders whose color isn't in any
    wheel are NOT dropped — they are assigned last priority (999999) so they
    sequence after listed colors. Returns (df, stats). Reads wheels from the
    GLOBAL_CW / PLANT_CWS module cache — callers should ensure
    load_color_wheels() has been invoked at least once.

    When `plant` is supplied (the /tasks path already has a plant-scoped df),
    only that plant's wheel is consulted — we skip the loop over every plant's
    wheel. `plant=None` preserves the original all-plants behavior.
    """
    stats: dict = {
        "color_merge_misses": 0,
        "missed_colors": [],
        "emitted_task_count": 0,
        "color_merge_ms": 0,
    }

    if df is None or df.empty:
        return df, stats

    t_color = time.monotonic()

    try:
        df = df.copy()
        df["COLOR"] = df["COLOR"].astype(str).str.upper().str.strip()
        df["PLANT_SAFE"] = df["PLANT"].fillna("").astype(str).apply(_cw_safe_name)
        df = df.drop(columns=["ORDER_Y"], errors="ignore")
        df["ORDER_Y"] = None

        if plant:
            # Scoped path: only this plant's wheel matters for a plant-scoped df.
            cw_map = PLANT_CWS.get(_cw_safe_name(plant))
            if cw_map:
                df["ORDER_Y"] = df["COLOR"].map(cw_map)
        else:
            for plant_key, cw_map in PLANT_CWS.items():
                mask = df["PLANT_SAFE"] == plant_key
                if mask.any():
                    df.loc[mask, "ORDER_Y"] = df.loc[mask, "COLOR"].map(cw_map)

        still_missing = df["ORDER_Y"].isna()
        if still_missing.any() and GLOBAL_CW:
            df.loc[still_missing, "ORDER_Y"] = df.loc[still_missing, "COLOR"].map(GLOBAL_CW)

        df = df.drop(columns=["PLANT_SAFE"], errors="ignore")

        # Orders whose COLOR isn't found in any wheel are NOT dropped — they flow
        # through and sequence LAST via ORDER_Y = 999999 below. Color wheels are
        # plant-optional (and switchable per plant on the frontend), so a missing
        # match must never remove an order from the schedule. We still record the
        # unlisted colors so the diagnostics panel can surface them.
        miss_mask = df["ORDER_Y"].isna()
        color_miss = int(miss_mask.sum())
        if color_miss:
            missed = sorted(df.loc[miss_mask, "COLOR"].dropna().unique().tolist())
            stats["color_merge_misses"] = color_miss
            stats["missed_colors"] = missed

        df["ORDER_Y"] = pd.to_numeric(df["ORDER_Y"], errors="coerce").fillna(999999)
    except Exception as e:
        _warn("error", f"Color-wheel merge failed: {e}; all rows get priority 999999")
        df = df.copy()
        df["ORDER_Y"] = 999999

    df = df.sort_values(
        by=["BASIC_START_DATE", "PRODUCTION_LINE", "ORDER_Y"]
    ).reset_index(drop=True)

    stats["emitted_task_count"] = len(df)
    stats["color_merge_ms"] = round((time.monotonic() - t_color) * 1000)

    return df, stats


def _to_pydt(val):
    """Pandas/ISO/None → naive datetime or None, for db.update_task_dates."""
    if val is None or val == "":
        return None
    ts = pd.to_datetime(val, errors="coerce")
    if pd.isna(ts):
        return None
    # Input contract: the frontend save path now sends NAIVE-LOCAL strings (no Z,
    # via Util.toLocalSeconds), which pd.to_datetime parses tz-naive — so the
    # .replace(tzinfo=None) below is a no-op and the local clock digits are stored
    # verbatim, matching the tz-less strftime read path (round-trips correctly for
    # non-UTC clients). The .replace stays as a defensive guard: a stray tz-aware
    # input (e.g. an external /tasks/bulk_update caller still sending a UTC Z
    # string) is coerced to tz-naive, since Postgres columns are TIMESTAMP WITHOUT
    # TIME ZONE and psycopg3 rejects tz-aware values for them.
    return ts.to_pydatetime().replace(tzinfo=None)


# =========================
# ROUTES
# =========================
@api.get("/diagnostics", dependencies=[Depends(require_admin)])
def get_diagnostics():
    """Return diagnostics: base metadata merged with live DB counts (stateless)."""
    return _diag_snapshot()


@api.get("/health")
def get_health():
    """Fast DB ping + system snapshot. Polled every 30 s by the Admin Cockpit."""
    db_stats = db.get_health_stats()
    color_reachable = True
    try:
        color_reachable = os.path.isfile(COLOR_FILE)
    except Exception:
        color_reachable = False

    # Stateless: "loaded" now means "DB reachable" rather than "DataFrame in RAM".
    return {
        "db": db_stats,
        "pool": db.get_pool_stats(),
        "memory": {
            "stateless":   True,
            "loaded":      bool(db_stats.get("connected")),
            "task_count":  db_stats.get("total_orders", 0),
            "loaded_at":   DIAGNOSTICS.get("loaded_at"),
        },
        "color_wheel": {
            "path":      COLOR_FILE,
            "reachable": color_reachable,
            "misses":    DIAGNOSTICS.get("color_merge_misses", 0),
            "missed_colors": DIAGNOSTICS.get("missed_colors", []),
        },
    }


@api.get("/livez")
def livez():
    """Liveness probe: a process-up check ONLY — never touches Postgres or the
    filesystem. Point the Container Apps *liveness* probe here; readiness and the
    Admin Cockpit keep using /health (which pings the DB). Keeping liveness DB-free
    means a slow or briefly-unreachable database can't trigger needless restarts."""
    return {"status": "ok"}


@api.get("/diagnostics/deep", dependencies=[Depends(require_admin)])
def get_diagnostics_deep():
    """Full pipeline breakdown: DB stats + color-wheel analysis + current DIAGNOSTICS."""
    db_deep = db.get_db_deep_stats()

    # Color wheel analysis against the colors currently in the orders table.
    # Source distinct colors from the DB (color column only — no full-table load)
    # and the wheel from the already-cached GLOBAL_CW dict (no Excel re-read).
    color_stats: dict = {"error": None, "total_in_orders": 0, "matched": 0,
                         "missed": 0, "missed_colors": DIAGNOSTICS.get("missed_colors", [])}
    try:
        # Normalize order colors the same way GLOBAL_CW keys are (upper/strip).
        order_colors = {
            c.upper().strip()
            for c in db.distinct_order_colors()
            if c is not None and str(c).strip()
        }
        wheel_colors = set(GLOBAL_CW.keys())
        if order_colors:
            missed = order_colors - wheel_colors
            color_stats.update({
                "total_in_orders": len(order_colors),
                "wheel_total":     len(wheel_colors),
                "matched":         len(order_colors & wheel_colors),
                "missed":          len(missed),
                "missed_colors":   sorted(missed),
                "missed_order_count": int(DIAGNOSTICS.get("color_merge_misses", 0)),
                # Unlisted colors are sequenced last (ORDER_Y 999999), never dropped.
                "missed_behavior": "sequenced_last",
            })
    except Exception as e:
        color_stats["error"] = str(e)

    pipeline = dict(DIAGNOSTICS)
    # Signal to the frontend that color-merge stats in this payload are *not*
    # authoritative — they reflect load-time defaults (zero). The pipeline panel
    # should read color_merge_misses / missed_colors / emitted_task_count from the
    # last /tasks response (Persistence.stats().backend_meta) instead.
    pipeline["color_merge_is_per_request"] = True
    return {
        "pipeline":   pipeline,
        "db_stats":   db_deep,
        "color_wheel": color_stats,
    }


@api.post("/reload", dependencies=[Depends(require_api_key), Depends(require_admin)])
def reload_data():
    """
    Refresh the in-process color-wheel cache from disk. In stateless mode orders
    are never cached, so there is nothing to re-read for them — this is the
    cross-replica hook to pick up a newly uploaded color wheel without a restart.
    """
    try:
        load_color_wheels(COLOR_FILE)
        DIAGNOSTICS["loaded_at"] = pd.Timestamp.utcnow().isoformat()
        _log_event("info", "reload", "Color-wheel cache refreshed",
                   global_colors=len(GLOBAL_CW), plant_wheels=len(PLANT_CWS))
        return {"status": "ok", "diagnostics": _diag_snapshot()}
    except Exception as e:
        _log_event("error", "reload", "Color-wheel reload failed", exc=e)
        raise HTTPException(status_code=500,
                            detail=f"Reload failed — ref: {_current_rid()}") from e


def _diag_snapshot() -> dict:
    """DIAGNOSTICS base merged with live DB counts (no in-memory load counters)."""
    snap = dict(DIAGNOSTICS)
    try:
        h = db.get_health_stats()
        snap["total_orders"] = h.get("total_orders", 0)
        snap["user_overrides"] = h.get("user_overrides", 0)
        snap["db_connected"] = h.get("connected", False)
    except Exception:
        pass
    return snap

def _clean_id(v):
    """Strip Excel float suffix from SAP IDs: '1000261702.0' → '1000261702'."""
    if v is None:
        return None
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].lstrip('-').isdigit():
        return s[:-2]
    return s


@api.get("/tasks")
def get_tasks(plant: str | None = None, line: str | None = None,
              limit: int | None = Query(default=None, ge=1, le=10000,
                  description="Max rows to return. Omit for the full plant-scoped list."),
              offset: int | None = Query(default=None, ge=0,
                  description="Rows to skip before returning (for paging)."),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Return tasks as JSON with finish-to-start links and pipeline metadata.

    Stateless: queries Postgres per request (db.query_orders) rather than
    copying an in-memory frame. ?plant= is the scaling unit (bounds the result
    to one plant); ?line= narrows further; ?limit/?offset= are a coarse guard
    rail for unscoped tooling (links are only coherent within a plant/line scope).
    Color merge still runs per-request from the in-process color-wheel cache.
    Response: { data: Task[], links: Link[], meta: DiagnosticsDict }
    When ?limit/?offset= are supplied, meta.total carries the full filtered
    row count (ignoring limit/offset) so callers can paginate.

    Per-user plant scope (role_plants, via auth.get_allowed_plants) is
    enforced here: an explicit ?plant= (or the plant a ?line= resolves to)
    outside the caller's allowed set 403s; an unscoped (?limit=-only) pull
    is silently bounded to the allowed set rather than rejected.
    """
    paging = limit is not None or offset is not None
    # A request with no plant, no line, and no explicit limit would materialize the
    # entire order book. Refuse it — plant is the scaling unit, so callers must scope
    # by ?plant=/?line=, or bound an unscoped tooling pull with ?limit=.
    if plant is None and line is None and limit is None:
        raise HTTPException(
            status_code=400,
            detail=("Specify ?plant= (or ?line=) to scope the request, or ?limit= "
                    "for a bounded unscoped tooling pull — refusing to load the full order book."),
        )
    if allowed_plants is not None:
        if plant is not None and plant not in allowed_plants:
            raise HTTPException(status_code=403, detail=f"Plant {plant!r} is not in your assigned plants")
        if plant is None and line is not None:
            line_plants = md.plants_for_line(line)
            if line_plants and not (set(line_plants) & set(allowed_plants)):
                raise HTTPException(status_code=403, detail=f"Line {line!r} is not on any of your assigned plants")
    df = db.query_orders(plant=plant, line=line, limit=limit, offset=offset, allowed_plants=allowed_plants)
    if df is None or df.empty:
        empty_meta = {"rendered": 0, "link_count": 0, "plant_filter_active": plant,
                      "line_filter_active": line, "pre_color_merge_count": 0,
                      "raw_row_count": 0, "unique_id_count": 0,
                      "color_merge_misses": 0, "missed_colors": [],
                      "emitted_task_count": 0, "color_merge_ms": 0,
                      "total": (db.count_orders(plant=plant, line=line, allowed_plants=allowed_plants) if paging else 0),
                      "loaded_at": DIAGNOSTICS.get("loaded_at"),
                      "source_file": "postgres://nimbus/orders"}
        return {"data": [], "links": [], "meta": empty_meta}

    # Drop rows with no usable start date (query can't enforce this without
    # losing the NULL diagnostic), then color-merge the scoped subset.
    df = df.dropna(subset=["BASIC_START_DATE"]).reset_index(drop=True)
    pre_merge_count = len(df)

    df, cm_stats = apply_color_merge(df, plant=plant)
    df = df.astype(object).where(pd.notna(df), other=None)
    data = []
    link_id_counter = 1
    links = []

    for prod_line, group_raw in df.groupby("PRODUCTION_LINE"):
        group = group_raw.sort_values("BASIC_START_DATE")
        prev_task_id = None

        for _, row in group.iterrows():
            task_id = row["id"]
            task_text = str(row.get("MATERIAL_DESCRIPTION", "")).strip()
            if not task_text or task_text == "nan":
                task_text = f"Order {task_id[:8]}"

            orig_start = row.get("ORIGINAL_START_DATE")
            orig_end   = row.get("ORIGINAL_END_DATE")
            data.append({
                "id": task_id,
                "text": task_text,
                "start_date": row["BASIC_START_DATE"].strftime("%Y-%m-%dT%H:%M:%S"),
                "end_date": row["BASIC_FINISH_DATE"].strftime("%Y-%m-%dT%H:%M:%S"),
                "original_start_date": orig_start.strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(orig_start) else None,
                "original_end_date":   orig_end.strftime("%Y-%m-%dT%H:%M:%S")   if pd.notna(orig_end)   else None,
                "user_scheduled": bool(row.get("USER_SCHEDULED")),
                "PRODUCTION_LINE": prod_line,
                "MATERIAL_DESCRIPTION": task_text,
                "MATERIAL_NUMBER": _clean_id(row.get("MATERIAL_NUMBER")),
                "ORDER_QUANTITY_(GMEIN)": row.get("ORDER_QUANTITY_(GMEIN)"),
                "COLOR": row.get("COLOR"),
                "PLANT": row.get("PLANT"),
                "ORDER": _clean_id(row.get("PRODUCTION_ORDER")),
                "ORDER_Y": row.get("ORDER_Y"),
                "RUN_TIME": row.get("RUN_TIME"),
                "FORM_SIZE": row.get("FORM_SIZE"),
                "notes": row.get("NOTES"),
                "firmed": row.get("FIRMING_INDICATOR") == "X",
                # Optimistic-concurrency token (Postgres xmin). The client echoes it
                # back on edit so the server can reject writes computed from stale data.
                "row_version": int(row["ROW_VERSION"]) if pd.notna(row.get("ROW_VERSION")) else None,
            })

            if prev_task_id:
                links.append({
                    "id": link_id_counter,
                    "source": prev_task_id,
                    "target": task_id,
                    "type": "0"
                })
                link_id_counter += 1
            prev_task_id = task_id

    # Merge base diagnostics with this request's color stats so the pipeline UI
    # sees plant-scoped color_merge_misses / missed_colors / emitted_task_count.
    meta = dict(DIAGNOSTICS, **cm_stats)
    meta["rendered"] = len(data)
    meta["link_count"] = len(links)
    meta["plant_filter_active"] = plant
    meta["line_filter_active"] = line
    meta["pre_color_merge_count"] = pre_merge_count
    meta["raw_row_count"] = pre_merge_count
    meta["unique_id_count"] = len(data)
    meta["total"] = db.count_orders(plant=plant, line=line, allowed_plants=allowed_plants) if paging else len(data)
    return {"data": data, "links": links, "meta": meta}


# ---------------------------------------------------------------------------
# Task date updates — shared model + validation + apply/persist/rollback
# ---------------------------------------------------------------------------
class TaskDateUpdate(BaseModel):
    """One task's optional start/end edit. Unknown fields are ignored.

    Optimistic concurrency: `base_version` is the xmin the client last saw for this
    row. The write is rejected (reported as `stale`) if the row's current xmin differs,
    unless `force` is set. `force=True` is used for authoritative bulk reschedules
    (the optimizer), which intentionally overwrite regardless of concurrent edits.
    """
    id: str
    start_date: str | None = None
    end_date: str | None = None
    base_version: int | None = None
    force: bool = False


class TasksUpdatePayload(BaseModel):
    """Frontend autosave payload: { tasks, blocks?, calendars? }. Only `tasks` is
    consumed here. Calendars and blackout blocks now persist through the dedicated
    /plant-calendar/* endpoints (backend-authoritative); any blocks/calendars sent
    here are ignored (legacy ride-along, harmless)."""
    tasks: list[TaskDateUpdate] = []


def _apply_task_date_updates(items: list[TaskDateUpdate]) -> dict:
    """
    Normalize start/end edits and persist them write-through to Postgres in a
    single transaction (db.update_task_dates_bulk). No in-memory frame to mutate
    anymore — the DB is the source of truth.

    Single source of truth for /task/update, /tasks/update and /tasks/bulk_update.
    Inverted ranges are validated against each row's effective current dates and
    counted as `invalid`; unknown ids are counted as `not_found`. Edits whose
    `base_version` no longer matches the row (a concurrent write landed first) are
    rejected and reported in `stale` unless `force` is set.

    Returns { applied, persisted, failed, invalid, not_found, stale, versions }.
    """
    norm: list[dict] = []
    invalid = 0
    for it in items:
        if not it.id:
            invalid += 1
            continue
        start_dt = _to_pydt(it.start_date) if it.start_date else None
        end_dt   = _to_pydt(it.end_date)   if it.end_date   else None
        if start_dt is None and end_dt is None:
            continue
        norm.append({"id": it.id, "start": start_dt, "end": end_dt,
                     "base_version": it.base_version, "force": it.force})

    if not norm:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": invalid,
                "not_found": 0, "stale": [], "versions": {}}

    try:
        res = db.update_task_dates_bulk(norm)
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "db", "Bulk task-date persist failed (transaction rolled back)",
                   exc=e, error_code=error_code, count=len(norm))
        # Honest body signal: the HTTP status stays 200 (per-row reporting
        # contract), but flag the hard failure + a stable cause so the frontend
        # can tell a rolled-back persist apart from a partial success.
        return {"applied": 0, "persisted": 0, "failed": len(norm),
                "invalid": invalid, "not_found": 0, "stale": [], "versions": {},
                "status": "error", "error_code": error_code,
                "cause": "Bulk task-date persist failed (transaction rolled back)"}
    res["invalid"] = res.get("invalid", 0) + invalid
    return res


@api.post("/task/update")
def update_task(task: TaskDateUpdate):
    """
    Update a single task's start/end and persist to DB.
    Payload: { id, start_date?, end_date?, base_version?, force? }
    Response: 200 { status, persisted, failed, stale, versions } | 400 invalid | 404 not found.
    A version conflict is NOT a 4xx — it returns 200 with the id in `stale` so the
    client can refetch and warn uniformly with the bulk path.
    """
    res = _apply_task_date_updates([task])
    if res.get("not_found"):
        raise HTTPException(status_code=404, detail="Task not found")
    if res.get("invalid"):
        raise HTTPException(status_code=400, detail="Invalid date range (end must be after start)")
    return {"status": "ok", "persisted": res["persisted"], "failed": res["failed"],
            "stale": res.get("stale", []), "versions": res.get("versions", {})}


@api.post("/task/note")
def update_task_note(payload: dict):
    """
    Persist a free-text note for a single task (max 500 chars).
    Payload: { id: str, notes: str }
    """
    task_id = payload.get("id")
    notes = payload.get("notes")
    if not task_id:
        raise HTTPException(status_code=400, detail="id required")
    if notes and len(notes) > 500:
        raise HTTPException(status_code=400, detail="Note exceeds 500 character limit")
    try:
        return db.update_task_note(task_id, notes)
    except Exception as e:
        _log_event("error", "db", "Note persist failed", exc=e, task_id=task_id)
        raise HTTPException(status_code=500,
                            detail=f"Note persist failed — ref: {_current_rid()}") from e


# Frontend calls /tasks/update (plural) with {tasks, blocks, calendars}; keep
# /tasks/bulk_update as a flat-list alias for external tooling. Both are
# best-effort and report per-row counts in the body (no whole-batch 4xx).
@api.post("/tasks/update")
def tasks_update(payload: TasksUpdatePayload):
    """
    Bulk-update task dates and persist to DB (one transaction).
    Payload: { tasks: [{ id, start_date?, end_date?, base_version?, force? }], blocks?, calendars? }
    Response: { status, updated, persisted, failed, invalid, not_found, stale, versions }
    """
    res = _apply_task_date_updates(payload.tasks)
    total = len(payload.tasks)
    stale = res.get("stale", [])
    if res["persisted"] < total:
        _log_event("warn", "db", "Bulk update: some tasks not persisted",
                   total=total, persisted=res["persisted"], failed=res["failed"],
                   invalid=res["invalid"], not_found=res.get("not_found", 0),
                   stale=len(stale))
    # Honest body signal: HTTP status stays 200, but surface a hard-failure flag +
    # cause when the whole transaction rolled back (default 'ok' otherwise).
    out = {"status": res.get("status", "ok"), "updated": total, "persisted": res["persisted"],
           "failed": res["failed"], "invalid": res["invalid"],
           "not_found": res.get("not_found", 0),
           "stale": stale, "versions": res.get("versions", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


@api.post("/tasks/bulk_update")
def bulk_update(tasks: list[TaskDateUpdate]):
    """
    Alias for /tasks/update with a flat list payload (used by external tooling/Postman).
    Payload: [{ id, start_date?, end_date?, base_version?, force? }]
    Response: { status, updated, persisted, failed, invalid, not_found, stale, versions }
    """
    res = _apply_task_date_updates(tasks)
    total = len(tasks)
    stale = res.get("stale", [])
    if res["persisted"] < total:
        _log_event("warn", "db", "bulk_update: some tasks not persisted",
                   total=total, persisted=res["persisted"], failed=res["failed"],
                   invalid=res["invalid"], not_found=res.get("not_found", 0),
                   stale=len(stale))
    out = {"status": res.get("status", "ok"), "updated": total, "persisted": res["persisted"],
           "failed": res["failed"], "invalid": res["invalid"],
           "not_found": res.get("not_found", 0),
           "stale": stale, "versions": res.get("versions", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


class TaskRefreshPayload(BaseModel):
    """Ids the client needs to reconcile after a concurrency conflict."""
    ids: list[str] = []


@api.post("/tasks/refresh")
def tasks_refresh(payload: TaskRefreshPayload):
    """
    Lean refetch of specific orders' current dates + row_version, for optimistic-
    concurrency conflict reconciliation. Returns only what the client needs to
    overwrite its stale copies — no links, no color merge.
    Payload: { ids: [str] }
    Response: { data: [{ id, start_date, end_date, row_version }] }
    """
    return {"data": db.get_task_versions(payload.ids)}


class DueDateCorrection(BaseModel):
    """One order's due-date-baseline correction, computed client-side by
    Persistence._snapToWorkingHours's due-date-baseline phase in app.js.
    `base_version` is the row's xmin as of the client's last load/save of it —
    used server-side to pin the write against ANY concurrent change to the row
    (a SAP re-upload, a normal scheduling save, or another tab's correction).
    Deliberately not a raw date value: a date round-trips through JS
    Date/JSON.stringify, which would re-label a naive local timestamp as UTC
    and never match Postgres's naive basic_start_date for a non-UTC client.
    See db.correct_due_date_baselines."""
    id: str
    basic_finish_date: str
    base_version: int


class DueDateCorrectionPayload(BaseModel):
    corrections: list[DueDateCorrection] = []


@api.post("/tasks/baseline-correct")
def baseline_correct(payload: DueDateCorrectionPayload):
    """
    Persist due-date-baseline (basic_finish_date) corrections found by the
    frontend's Persistence._snapToWorkingHours. Fire-and-forget from the
    client's perspective — every row is re-validated server-side
    (db.correct_due_date_baselines) before being written, so a late,
    duplicate, or concurrent call can never overwrite an already-corrected or
    genuinely fresh (re-uploaded) value; a failed re-validation is a safe
    per-row no-op, not an error.
    Payload: { corrections: [{ id, basic_finish_date, base_version }] }
    Response: { status, applied, persisted, skipped, not_matched, versions }
    """
    items = [
        {
            "id": c.id,
            "basic_finish_date": _to_pydt(c.basic_finish_date),
            "base_version": c.base_version,
        }
        for c in payload.corrections
        if c.id and c.basic_finish_date and c.base_version is not None
    ]
    try:
        res = db.correct_due_date_baselines(items)
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "db", "Due-date baseline correction failed (transaction rolled back)",
                   exc=e, error_code=error_code, count=len(items))
        return {"status": "error", "applied": 0, "persisted": 0, "skipped": len(items),
                "not_matched": 0, "versions": {}, "error_code": error_code,
                "cause": "Due-date baseline correction failed (transaction rolled back)"}
    return {"status": "ok", **res}


# =========================
# ADMIN COCKPIT — upload, purge, audit
# =========================
@api.post("/upload", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_orders(file: UploadFile = File(...)):
    """
    Receive an xlsx file (sequence_testing-shaped) and upsert into the orders
    table. Stateless: there is no in-memory frame to refresh — the next /tasks
    call reads the new rows straight from Postgres. The blocking parse/upsert is
    offloaded to a worker thread so it doesn't block the event loop.
    """
    raw = await file.read()
    result = await run_in_threadpool(db.ingest_orders_from_excel, raw,
                                     file.filename or "upload.xlsx")
    if result.get("status") != "ok":
        # Bad file / missing columns is a client error.
        raise HTTPException(status_code=400, detail=result.get("message", "Upload failed"))

    _log_event("info", "upload", "Orders uploaded and ingested",
               filename=file.filename, inserted=result.get("inserted", 0),
               updated=result.get("updated", 0), raw=result.get("raw_row_count", 0))
    # Soft-warn on production lines not yet in master data (lines come from the
    # ingest result now, not a global frame). Never let this blow up the response.
    try:
        known = md.known_plant_line_codes()
        if known["lines"]:
            for ul in sorted(set(result.get("lines", [])) - set(known["lines"])):
                result.setdefault("warnings", []).append(
                    {"level": "warn", "msg": f"Unknown production line: {ul} — add it in Admin Cockpit > Manage Data Tables"}
                )
    except Exception as e:
        # Soft-warn enrichment is best-effort; never fail the upload over it — but
        # log so a broken master-data lookup doesn't silently skip the warnings.
        _log_event("warn", "upload", "Unknown-line validation skipped",
                   exc=e, filename=file.filename)
    return result


@api.post("/bom/upload", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_bom(request: Request, file: UploadFile = File(...)):
    """
    Receive a BOM export (.xlsx) and upsert into bom_items — the bulk-load path
    for Bill of Materials data (expected at real scale, tens of thousands of
    rows+), mirroring /upload for orders. Every row's (material, plant) and
    (component, plant) must already exist in material_plants; rows that don't
    are rejected individually (reported in `warnings`/`rejected`) rather than
    failing the whole file. The blocking parse/upsert is offloaded to a worker
    thread so it doesn't block the event loop.
    """
    raw = await file.read()
    result = await run_in_threadpool(md.ingest_bom_from_excel, raw,
                                     file.filename or "bom_upload.xlsx",
                                     request.headers.get("x-user-email"))
    if result.get("status") != "ok":
        raise HTTPException(status_code=400, detail=result.get("message", "Upload failed"))
    _log_event("info", "upload", "BOM uploaded and ingested",
               filename=file.filename, inserted=result.get("inserted", 0),
               updated=result.get("updated", 0), rejected=result.get("rejected", 0),
               raw=result.get("raw_row_count", 0))
    return result


@api.post("/purge", dependencies=[Depends(require_api_key), Depends(require_admin)])
def purge_orders(payload: dict):
    """
    payload: { start_date: ISO, end_date: ISO } — both inclusive.
    Deletes orders where effective end date falls in the range. Stateless:
    no in-memory frame to refresh afterward. (Sync handler → runs in the
    threadpool, so the blocking DELETE doesn't stall the event loop.)
    """
    try:
        start = datetime.fromisoformat(str(payload["start_date"]).replace("Z", ""))
        end   = datetime.fromisoformat(str(payload["end_date"]).replace("Z", ""))
    except (KeyError, ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid date range: {e}") from e
    result = db.purge_orders_by_date(start, end)
    if result.get("status") == "ok":
        _log_event("info", "purge", "Orders purged by date range",
                   deleted=result.get("deleted", 0), start=str(start), end=str(end))
    return result


@api.get("/upload/audit", dependencies=[Depends(require_admin)])
def get_upload_audit(limit: int = 50):
    """Recent uploads, newest first, for the Admin Cockpit history card."""
    return {"audit": db.upload_audit_log(limit)}


@api.post("/upload/audit/clear", dependencies=[Depends(require_admin)])
def clear_upload_audit():
    """Delete all upload history records."""
    return db.clear_upload_audit()


# =========================
# COLOR WHEEL ENDPOINTS
# =========================

@api.post("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...)):
    """Upload or replace a plant-specific color wheel (persisted to the color_wheel table)."""
    raw = await file.read()
    # Excel parse is blocking/CPU-bound — keep it off the event loop.
    try:
        cw_df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
        if "ORDER" in cw_df.columns and "ORDER_Y" not in cw_df.columns:
            cw_df = cw_df.rename(columns={"ORDER": "ORDER_Y"})
        missing = [c for c in ["COLOR", "ORDER_Y"] if c not in cw_df.columns]
        if missing:
            raise HTTPException(status_code=400, detail=f"Missing required columns: {missing}")
    except HTTPException:
        raise
    except Exception as e:
        _log_event("warn", "color_wheel", "Color-wheel xlsx parse failed",
                   exc=e, error_code="xlsx.parse", plant=plant,
                   filename=file.filename)
        raise HTTPException(
            status_code=400,
            detail="Could not parse the uploaded color-wheel file — check it is a valid .xlsx with COLOR and ORDER columns",
        ) from e

    entries = _cw_df_to_entries(cw_df)
    row_count = len(cw_df)
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    fname = file.filename or "upload.xlsx"
    safe = _cw_safe_name(plant)

    def _persist():
        # upsert (insert-or-replace) is a single statement; RETURNING (xmax = 0)
        # tells us whether this was a first upload or a replace.
        res = db.upsert_color_wheel(safe, plant, entries,
                                    filename=fname, row_count=row_count, uploaded_by=user)
        is_replace = not res["inserted"]
        _cw_append_audit({
            "ts": ts, "user": user,
            "action": "color_wheel_replace" if is_replace else "color_wheel_upload",
            "plant": plant,
            "details": {"filename": fname, "row_count": row_count, "replaced": is_replace},
        })
        # Color-merge runs per-request from the cache; refresh ONLY this plant's
        # wheel so the new wheel takes effect on the next /tasks call without
        # reloading every plant's wheel (or requiring a full /reload).
        _reload_one_plant_wheel(plant)
        return is_replace

    is_replace = await run_in_threadpool(_persist)
    action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    return {"status": "ok", "row_count": row_count, "action": action, "replaced": is_replace}


@api.get("/color-wheel/{plant}")
def get_color_wheel(plant: str):
    """Return the stored color wheel for a plant as sorted JSON entries."""
    row = db.get_color_wheel_row(_cw_safe_name(plant))
    if row is None:
        raise HTTPException(status_code=404, detail=f"No color wheel uploaded for plant {plant!r}")
    # entries: {COLOR: ORDER_Y|None} -> [{color, order_y}] ascending by rank, with
    # a null/blank rank sorting last (999999), matching apply_color_merge().
    entries = [
        {"color": c, "order_y": (999999 if o is None else o)}
        for c, o in row["entries"].items()
    ]
    entries.sort(key=lambda e: e["order_y"])
    meta = {
        "uploaded_at": row["uploaded_at"].isoformat() if row["uploaded_at"] else None,
        "uploaded_by": row["uploaded_by"],
        "filename": row["filename"],
        "row_count": row["row_count"],
    }
    return {"plant": plant, "entries": entries, "meta": meta}


@api.delete("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def delete_color_wheel(plant: str, request: Request):
    """Delete a plant's stored color wheel."""
    res = db.delete_color_wheel(_cw_safe_name(plant))
    if res is None:
        return {"status": "not_found"}
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "color_wheel_delete", "plant": plant,
        "details": {"filename": res.get("filename") or "unknown"},
    })
    # Row already removed above — drop just this plant's cache entry.
    _reload_one_plant_wheel(plant)
    return {"status": "ok"}


@api.get("/color-wheels")
def list_color_wheels(
        limit: int | None = Query(default=None, ge=1, le=100000,
            description="Max color wheels to return. Omit for the full listing."),
        offset: int | None = Query(default=None, ge=0,
            description="Wheels to skip before returning (for paging).")):
    """List plants with stored color wheels and their metadata.

    Optional ?limit=/?offset= page the listing (default = full catalog). When
    supplied, meta.total carries the full count so callers can paginate."""
    plants, total = db.list_color_wheels_meta(limit, offset)
    if limit is None and offset is None:
        return {"plants": plants}
    return {"plants": plants, "meta": {"total": total}}


# =========================
# AUDIT LOG ENDPOINTS
# =========================

@api.get("/audit/log", dependencies=[Depends(require_admin)])
def get_audit_log(limit: int = 200):
    """Return the most recent N audit log entries, newest first."""
    log = []
    try:
        with open(_cw_audit_path(), encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                with suppress(json.JSONDecodeError):
                    log.append(json.loads(line))
    except FileNotFoundError:
        pass
    return {"entries": list(reversed(log[-limit:]))}


@api.post("/audit/log")
def append_audit_log(entry: dict, request: Request):
    """Frontend-triggered audit entry (e.g. optimization_run events)."""
    entry.setdefault("ts", datetime.utcnow().isoformat() + "Z")
    entry.setdefault("user", request.headers.get("X-User", "system"))
    _cw_append_audit(entry)
    return {"status": "ok"}


@api.post("/audit/log/clear", dependencies=[Depends(require_admin)])
def clear_audit_log():
    """Wipe the full audit log."""
    try:
        open(_cw_audit_path(), 'w', encoding='utf-8').close()
        return {"status": "ok"}
    except Exception as e:
        _log_event("error", "audit", "Could not clear audit log", exc=e)
        raise HTTPException(status_code=500,
                            detail=f"Could not clear audit log — ref: {_current_rid()}") from e


# =============================================================================
# MASTER DATA — Subnetwork / Plant / Production Line management
# =============================================================================

# NOTE: these two literal-path routes MUST be registered before the generic
# GET /master-data/{table} below — FastAPI/Starlette matches routes in
# registration order, not by specificity, so a route declared after {table}
# is permanently shadowed (a request for it just gets captured as table="...",
# then 404s inside md_list/_assert_table). _audit was previously registered
# after {table} and was completely unreachable in production as a result.
@api.get("/master-data/_audit", dependencies=[Depends(require_admin)])
def md_audit(limit: int = 100):
    """Return the most recent N master-data change audit entries."""
    return {"entries": md.list_audit(limit)}


@api.get("/master-data/_schema-export", dependencies=[Depends(require_admin)])
def md_schema_export():
    """
    Read-only: dump every column currently registered (via column_metadata)
    on the Manage Data Tables tables as idempotent SQL (ALTER TABLE ... ADD
    COLUMN IF NOT EXISTS + column_metadata INSERT ... ON CONFLICT DO NOTHING).
    This is the recovery path for columns added through the "Add Column"
    wizard (md.add_column), which mutates the live DB directly with no other
    record in git — hit this against whichever DB is live (local or Azure) to
    get copy-pasteable text to fold back into schema.sql / a migrations file.
    """
    return {"sql": md.export_schema_sql()}


@api.get("/master-data/{table}")
def md_list(table: str,
            limit: int | None = Query(default=None, ge=1, le=100000,
                description="Max rows to return. Omit for the full table."),
            offset: int | None = Query(default=None, ge=0,
                description="Rows to skip before returning (for paging)."),
            plant: str | None = Query(default=None,
                description="Filter to one plant (only honored for tables with a plant column)."),
            material_id: str | None = Query(default=None,
                description="Filter to one material (only honored for tables with a material_id column)."),
            allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """List rows for a master-data table (subnetworks | plants | production_lines | ...).

    Optional ?limit=/?offset=/?plant=/?material_id= scope the result server-side;
    all default to the full-catalog behavior. When supplied, meta.total carries
    the full filtered row count for paging. bom_items in particular relies on
    ?plant=+?material_id= to never load its full (potentially huge) table.

    Per-user plant scope (role_plants) is enforced for tables in
    md.PLANT_SCOPED_TABLES: an explicit ?plant= outside the caller's allowed
    set 403s; otherwise the row set is silently bounded to the allowed set."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    if (allowed_plants is not None and table in md.PLANT_SCOPED_TABLES
            and plant is not None and plant not in allowed_plants):
        raise HTTPException(status_code=403, detail=f"Plant {plant!r} is not in your assigned plants")
    return md.list_rows(table, limit=limit, offset=offset, plant=plant,
                         allowed_plants=allowed_plants, material_id=material_id)


@api.post("/master-data/{table}/cascade-preview", dependencies=[Depends(require_admin)])
def md_cascade_preview(table: str, body: dict = Body(default={})):
    """Preview cascading deletes before committing. Payload: { deletes: key[] }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    return md.cascade_preview(table, body.get("deletes", []))


@api.post("/master-data/{table}/bulk", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_bulk(table: str, request: Request, body: dict = Body(default={})):
    """Apply upserts and deletes in one transaction. Payload: { upserts: row[], deletes: key[] }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        result = md.bulk_apply(
            table,
            ops={"upserts": body.get("upserts", []), "deletes": body.get("deletes", [])},
            user_email=request.headers.get("x-user-email"),
        )
        # Adding/editing production lines may let orders uploaded before the line
        # existed resolve their materialized plant. Re-derive NULL-plant orders so they
        # stop being invisible to the plant-scoped read path (best-effort, non-fatal).
        if table == "production_lines":
            try:
                n = db.reattribute_null_plant_orders()
                if n:
                    _log_event("info", "db", "Re-attributed orders to plant after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "Plant re-attribution after line change failed", error=str(e))
            try:
                n = db.backfill_line_keys()
                if n:
                    _log_event("info", "db", "Backfilled order line_key after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "line_key backfill after line change failed", error=str(e))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/{table}/columns", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_add_column(table: str, request: Request, body: dict = Body(default={})):
    """Add a new user-defined column to a master-data table. Payload: { column_name, sql_type, length?, nullable?, default?, display_label? }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.add_column(
            table=table,
            column_name=body.get("column_name", ""),
            sql_type=body.get("sql_type", ""),
            length=body.get("length"),
            nullable=body.get("nullable", True),
            default=body.get("default"),
            display_label=body.get("display_label", body.get("column_name", "")),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.delete("/master-data/{table}/columns/{column}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_drop_column(table: str, column: str, request: Request):
    """Drop a user-defined column from a master-data table (system columns are protected)."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.drop_column(table, column, user_email=request.headers.get("x-user-email"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.patch("/master-data/{table}/columns/{column}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_rename_label(table: str, column: str, request: Request, body: dict = Body(default={})):
    """Update the display_label of an existing column. Payload: { display_label: str }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.rename_label(
            table, column,
            new_label=body.get("display_label", ""),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/plants/{plant}/constraints", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_constraints(plant: str, request: Request, body: dict = Body(default={})):
    """Persist a plant's switchable-constraint config (ordered list).

    Payload: { subnetwork?, constraints: [{ key, enabled, order }, ...] }
    Only 'colorWheel' is consumed today; the ordered list is the first step
    toward a general per-plant constraint registry (tooling, etc.)."""
    try:
        return md.set_plant_constraints(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            constraints=body.get("constraints", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# =========================
# SECURITY — users, roles admin
# =========================

@api.post("/security/login")
def security_login(body: dict = Body(default={})):
    """Authenticate against user_security. Never exposes the hash."""
    result = auth.authenticate(body.get("username", ""), body.get("password", ""))
    if not result:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return result


@api.get("/security/bootstrap-status")
def security_bootstrap_status():
    return {"admin_exists": auth.admin_exists()}


@api.get("/security/me")
def security_me(request: Request):
    """Live identity + effective admin status for the caller. Ungated on purpose
    (like /security/bootstrap-status): the frontend calls it to reconcile the
    role it cached at login against backend truth, so it must be reachable even
    when the caller is NOT an admin. Returns {username, role, is_admin,
    first_name, last_name, allowed_plants, settings, role_settings}; no secrets."""
    return auth.whoami(request)


@api.patch("/security/me")
def security_update_me(request: Request, body: dict = Body(default={})):
    """Self-service: update the CALLER's own first/last name only. Ungated
    (like GET /security/me) — identity comes from the header, and
    auth.update_own_name scopes the write to exactly that one row."""
    try:
        return auth.update_own_name(
            request.headers.get("x-user-email") or request.headers.get("X-User"),
            body.get("first_name"),
            body.get("last_name"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.patch("/security/me/settings")
def security_update_my_settings(request: Request, body: dict = Body(default={})):
    """Self-service: shallow-merge a PARTIAL settings patch into the CALLER's own
    user_settings blob. Ungated (like PATCH /security/me) — identity comes from
    the header, and auth.upsert_user_settings scopes the write to exactly that
    one row (resolving canonical username casing so header casing can't create a
    duplicate). Body: {settings: {...}}. Returns {username, settings} with the
    full merged blob. A blank/unknown actor -> 401; a non-dict settings -> 400."""
    try:
        return auth.upsert_user_settings(
            auth._actor_email(request),
            body.get("settings"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.patch("/security/me/password")
def security_change_my_password(request: Request, body: dict = Body(default={})):
    """Self-service: change the CALLER's own password. Requires the correct
    current password (see auth.change_own_password) since identity here comes
    from a client header, not a verified session token."""
    try:
        return auth.change_own_password(
            auth._actor_email(request),
            body.get("current_password", ""),
            body.get("new_password", ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.get("/security/users", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_list_users(
        limit: int | None = Query(default=None, ge=1, le=100000,
            description="Max users to return. Omit for the full list."),
        offset: int | None = Query(default=None, ge=0,
            description="Rows to skip before returning (for paging)."),
        search: str | None = Query(default=None,
            description="Filter to usernames containing this substring.")):
    """List users (never includes password hashes)."""
    return auth.list_users(limit=limit, offset=offset, search=search)


@api.post("/security/users/bulk", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_bulk_users(request: Request, body: dict = Body(default={})):
    """Apply user upserts/deletes (username + role only — never touches passwords).
    Payload: { upserts: [{username, role}], deletes: [{username}] }"""
    try:
        return auth.bulk_upsert_users(
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email") or request.headers.get("X-User"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/security/users/{username}/reset-password", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_reset_password(username: str, request: Request, body: dict = Body(default={})):
    """Set/replace a user's password. Hashed before storage; never retrievable afterward."""
    try:
        return auth.set_user_password(
            username, body.get("password", ""),
            user_email=request.headers.get("x-user-email") or request.headers.get("X-User"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# =============================================================================
# SAP INTERFACE — object catalog, field mappings, per-object config, on-demand
#                 sync, and run history. Reads are UNGATED; writes are gated by
#                 the shared-secret guard. Connectors are STUBS in this skeleton
#                 (no live SAP calls), and the scheduler is disabled by default.
# =============================================================================

# Source-param keys that may hold credentials/secrets. NEVER returned by the
# config GET (only has_secret:bool) and NEVER fed to _log_event.
_SAP_SECRET_KEYS = frozenset({
    "password", "passwd", "secret", "client_secret", "token", "api_key",
    "apikey", "sap_password", "rfc_password", "passwd_hash", "auth_token",
    "private_key", "credential", "credentials",
})


def _sap_strip_secrets(params: dict | None) -> dict:
    """Return source_params with any secret-bearing keys removed (case-insensitive)."""
    if not isinstance(params, dict):
        return {}
    return {k: v for k, v in params.items() if k.lower() not in _SAP_SECRET_KEYS}


def _sap_has_secret(params: dict | None) -> bool:
    if not isinstance(params, dict):
        return False
    return any(k.lower() in _SAP_SECRET_KEYS for k in params)


@api.get("/sap/interface/objects", dependencies=[Depends(require_admin)])
def sap_objects():
    """List the SAP-syncable objects with their config + last/next run summary."""
    objects = []
    for object_key, meta in sap_sync.SAP_OBJECTS.items():
        cfg = sap_sync.get_config(object_key)
        runs = sap_sync.list_runs(object_key=object_key, limit=1)
        last_run = runs[0] if runs else None
        job = None
        sched = getattr(api.state, "sap_scheduler", None)
        if sched is not None:
            job = sched.get_job("sap:" + object_key)
        next_run = job.next_run_time.isoformat() if (job and job.next_run_time) else None
        objects.append({
            "object_key":    object_key,
            "label":         meta.get("label"),
            "kind":          meta.get("kind"),
            "enabled":       cfg.get("enabled", False),
            "transport":     cfg.get("transport"),
            "schedule_cron": cfg.get("schedule_cron"),
            "last_run":      last_run,
            "next_run":      next_run,
        })
    return {"objects": objects}


@api.get("/sap/interface/mappings/{object}", dependencies=[Depends(require_admin)])
def sap_get_mappings(object: str):
    """Return the field-map rows (including inactive) for one SAP object."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    return {"object_key": object, "mappings": sap_sync.load_field_map(object)}


@api.post("/sap/interface/mappings/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_set_mappings(object: str, request: Request, body: dict = Body(default={})):
    """Replace the field map for one SAP object. Payload: { mappings: [...] }"""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    try:
        result = sap_sync.replace_field_map(object, body.get("mappings", []),
                                             user_email=actor)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _log_event("info", "sap_sync", "SAP field map replaced",
               object_key=object, actor=actor,
               mappings=len(body.get("mappings", []) or []))
    return result


@api.get("/sap/interface/config/{object}", dependencies=[Depends(require_admin)])
def sap_get_config(object: str):
    """Return one SAP object's config. Secret source_params keys are stripped —
    only non-secret keys are returned, plus has_secret:bool."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    cfg = sap_sync.get_config(object)
    params = cfg.get("source_params") or {}
    return {
        "object_key":    object,
        "enabled":       cfg.get("enabled", False),
        "transport":     cfg.get("transport"),
        "schedule_cron": cfg.get("schedule_cron"),
        "source_params": _sap_strip_secrets(params),
        "has_secret":    _sap_has_secret(params),
    }


@api.post("/sap/interface/config/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_set_config(object: str, request: Request, body: dict = Body(default={})):
    """Update one SAP object's config. Payload: { enabled?, transport?, schedule_cron?,
    source_params? }. source_params is MERGED into the stored params (omitted keys are
    never wiped). transport and cron are validated."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    fields: dict = {}
    if "enabled" in body:
        fields["enabled"] = bool(body["enabled"])
    if "transport" in body:
        transport = body["transport"]
        if transport not in ("file_drop", "odata", "rfc"):
            raise HTTPException(status_code=400, detail=f"Unknown transport: {transport!r}")
        fields["transport"] = transport
    if "schedule_cron" in body:
        cron = body["schedule_cron"]
        if cron not in (None, ""):
            # Validate the cron expression without keeping a live trigger around.
            try:
                from apscheduler.triggers.cron import CronTrigger
                CronTrigger.from_crontab(str(cron))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid cron: {e}") from e
        fields["schedule_cron"] = cron
    if "source_params" in body:
        incoming = body["source_params"]
        if not isinstance(incoming, dict):
            raise HTTPException(status_code=400, detail="source_params must be an object")
        # MERGE: start from stored params so omitted keys (incl. secrets) survive.
        current = sap_sync.get_config(object).get("source_params") or {}
        merged = dict(current)
        merged.update(incoming)
        fields["source_params"] = merged
    try:
        result = sap_sync.set_config(object, **fields)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Log only NON-SECRET, NON-VALUE config metadata — never source_params values.
    _log_event("info", "sap_sync", "SAP object config updated",
               object_key=object, actor=actor,
               changed=sorted(k for k in fields if k != "source_params"),
               source_params_changed=("source_params" in fields))
    # Re-shape through the same secret-stripping the GET uses — the response must
    # never echo stored source_params secrets (set_config returns the raw config).
    cfg_params = result.get("source_params") or {}
    return {
        "object_key":    object,
        "enabled":       result.get("enabled", False),
        "transport":     result.get("transport"),
        "schedule_cron": result.get("schedule_cron"),
        "source_params": _sap_strip_secrets(cfg_params),
        "has_secret":    _sap_has_secret(cfg_params),
    }


@api.post("/sap/interface/test-connection", dependencies=[Depends(require_api_key), Depends(require_admin)])
def sap_test_connection(request: Request, body: dict = Body(default={})):
    """Test connectivity for a transport + source_params combo. Payload: { transport,
    source_params }. Connectors are stubs in this skeleton, so this returns the
    stub's {ok:false, detail:...} unless a real transport is configured."""
    transport = body.get("transport")
    params = body.get("source_params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="source_params must be an object")
    try:
        result = sap_sync.test_connection(transport, params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Never log source_params values (may carry secrets).
    _log_event("info", "sap_sync", "SAP test-connection invoked",
               actor=request.headers.get("x-user-email"),
               transport=transport, ok=result.get("ok"))
    return result


@api.post("/sap/interface/sync/{object}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def sap_sync_now(object: str, request: Request, body: dict = Body(default={})):
    """Run a sync for one SAP object on demand. Payload: { dry_run? }. Offloaded to
    the threadpool (the sync is blocking + does DB I/O)."""
    if object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    actor = request.headers.get("x-user-email")
    dry_run = bool(body.get("dry_run", False))
    _log_event("info", "sap_sync", "Manual SAP sync requested",
               object_key=object, actor=actor, dry_run=dry_run)
    result = await run_in_threadpool(
        sap_sync.sync_object, object, user_email=actor, dry_run=dry_run)
    return result


@api.get("/sap/interface/runs", dependencies=[Depends(require_admin)])
def sap_runs(object: str | None = Query(default=None),
             limit: int = Query(default=50, ge=1, le=500)):
    """Return recent SAP sync runs, newest first, optionally scoped to one object."""
    if object is not None and object not in sap_sync.SAP_OBJECTS:
        raise HTTPException(status_code=404, detail=f"Unknown SAP object: {object!r}")
    return {"runs": sap_sync.list_runs(object_key=object, limit=limit)}


# =============================================================================
# LABOR PLANNING — available labor hours by line group × ISO week (aggregate)
#                  and by production line × calendar day (line-level)
# =============================================================================

@api.get("/labor-plan")
def labor_plan_get(plant: str):
    """Return all aggregate labor-plan cells (avail_hours) for the given plant."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    return md.load_labor_plan(plant)


@api.post("/labor-plan")
def labor_plan_post(request: Request, body: dict = Body(default={})):
    """Upsert or delete aggregate labor-plan cells. Payload: { subnetwork, plant, cells:[{pl_group, period, avail_hours}] }"""
    try:
        return md.upsert_labor_plan(
            subnetwork=body.get("subnetwork", ""),
            plant=body.get("plant", ""),
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.get("/labor-plan/line")
def labor_plan_line_get(plant: str, group: str | None = None, from_date: str | None = None, to_date: str | None = None):
    """Return line-level available-hours cells for the given plant, optionally filtered by group and date range."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    return md.load_labor_plan_line(plant, group=group, from_date=from_date, to_date=to_date)


@api.post("/labor-plan/line")
def labor_plan_line_post(request: Request, body: dict = Body(default={})):
    """Upsert or delete line-level labor cells. Payload: { subnetwork, plant, cells:[{production_line, day, avail_hours, source}] }"""
    try:
        return md.upsert_labor_plan_line(
            subnetwork=body.get("subnetwork", ""),
            plant=body.get("plant", ""),
            cells=body.get("cells", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# =============================================================================
# PLANT CALENDARS — per-plant/per-line working hours + blackout blocks.
#   Backend-authoritative store for what used to be localStorage-only frontend
#   state. GET /plant-calendar (the read path) stays open, matching /tasks/update
#   and /labor-plan. The four write endpoints below require require_admin, per
#   the endpoint-gating table shipped with mandatory login — subnetwork is
#   resolved server-side (frontend keys by plant only). Blackout writes are
#   DELTA-based: { upserts, deletes } — never prune-by-omission.
# =============================================================================

@api.get("/plant-calendar")
def plant_calendar_get(plant: str):
    """Return a plant's full calendar/blackout config for Store hydration:
    { plant, subnetwork, plant_work_hours, line_work_hours:{line:{0..6}},
      line_blackouts:[...], plant_blackouts:[...] }."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        return md.load_plant_calendar(plant)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/plant-hours", dependencies=[Depends(require_admin)])
def plant_calendar_plant_hours_post(request: Request, body: dict = Body(default={})):
    """Set a plant's weekly working hours. Payload: { plant, work_hours:{0..6:[h1,h2]|null} }."""
    try:
        return md.set_plant_work_hours(
            plant=body.get("plant", ""),
            work_hours=body.get("work_hours") or {},
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/line-hours", dependencies=[Depends(require_admin)])
def plant_calendar_line_hours_post(request: Request, body: dict = Body(default={})):
    """Upsert per-line working hours (batched). Payload:
    { plant, lines:[{production_line, work_hours:{0..6:[h1,h2]|null}}] }."""
    try:
        return md.set_line_work_hours(
            plant=body.get("plant", ""),
            lines=body.get("lines", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/line-blackouts", dependencies=[Depends(require_admin)])
def plant_calendar_line_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of line blackouts. Payload:
    { plant, upserts:[{id, line?, start, end, reason?}], deletes?:[id] }.
    line omitted/null = all lines in this plant."""
    try:
        return md.save_line_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/plant-blackouts", dependencies=[Depends(require_admin)])
def plant_calendar_plant_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of plant-level blackouts. Payload:
    { plant, upserts:[{id, start, end, reason?}], deletes?:[id] }."""
    try:
        return md.save_plant_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# =============================================================================
# DB DIAGNOSTICS — comprehensive backend health for Admin Cockpit
# =============================================================================

@api.get("/diagnostics/db", dependencies=[Depends(require_admin)])
def get_diagnostics_db():
    """
    Full DB deep-dive: pool stats, server info, table health, connection activity,
    lock waits, index usage, slow queries (pg_stat_statements), and sequence health.
    Intended for the Admin Cockpit DB Deep Dive panel — loaded on demand, not polled.
    """
    _log_event("info", "diagnostics", "DB deep-dive requested")
    return {
        "pool":         db.get_pool_stats(),
        "server":       db.get_db_server_info(),
        "tables":       db.get_db_table_stats(),
        "connections":  db.get_db_connection_activity(),
        "locks":        db.get_db_lock_waits(),
        "indexes":      db.get_db_index_usage(),
        "slow_queries": db.get_db_slow_queries(),
        "sequences":    db.get_db_sequence_health(),
        "fetched_at":   pd.Timestamp.utcnow().isoformat(),
    }


# =============================================================================
# DB MAINTENANCE — safe, non-locking operations exposed to Admin Cockpit
# Excluded intentionally: VACUUM FULL (exclusive lock), REINDEX TABLE (ShareLock),
# terminate-idle (kills app's own pool connections), reset-stats (destroys forensics).
# =============================================================================

@api.post("/maintenance/vacuum-analyze", dependencies=[Depends(require_api_key), Depends(require_admin)])
def maintenance_vacuum_analyze(body: dict = Body(default={})):
    table = body.get("table") or None
    _log_event("info", "maintenance", f"VACUUM ANALYZE {table if table else 'all tables'}")
    try:
        result = db.run_vacuum_analyze(table)
        return {"ok": True, **result}
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "maintenance", "VACUUM ANALYZE failed",
                   exc=e, error_code=error_code, table=table)
        return {"ok": False, "status": "error", "error_code": error_code,
                "error": str(e)}


@api.post("/maintenance/analyze", dependencies=[Depends(require_api_key), Depends(require_admin)])
def maintenance_analyze(body: dict = Body(default={})):
    table = body.get("table")
    if not table:
        return {"ok": False, "error": "table is required"}
    _log_event("info", "maintenance", f"ANALYZE {table}")
    try:
        return {"ok": True, **db.run_analyze(table)}
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "maintenance", "ANALYZE failed",
                   exc=e, error_code=error_code, table=table)
        return {"ok": False, "status": "error", "error_code": error_code,
                "error": str(e)}


# =============================================================================
# BACKEND EVENT LOG — in-memory ring buffer, surfaced in Admin Cockpit
# =============================================================================

@api.get("/logs/backend", dependencies=[Depends(require_admin)])
def get_backend_logs(level: str | None = None, limit: int = 200,
                     category: str | None = None, since: str | None = None,
                     q: str | None = None, offset: int = 0):
    """
    Return recent backend events from the in-memory ring buffer, newest first.

    Filters (all optional, AND-combined, applied before paging):
      ?level=     info|warn|error (legacy; "all" = no filter)
      ?category=  exact category match
      ?since=     ISO-8601 — only entries with ts >= since
      ?q=         free-text, case-insensitive, matched against msg+category+ctx
    Paging: ?offset= (rows to skip) + ?limit= (cap). `total` is the full filtered
    count (pre-paging) so the viewer can show "showing N of total".
    """
    entries = list(reversed(_BACKEND_LOG))
    if level and level != "all":
        entries = [e for e in entries if e.get("level") == level]
    if category:
        entries = [e for e in entries if e.get("category") == category]
    if since:
        # String ISO compare is correct for the isoformat() values we store
        # (lexicographic == chronological for a fixed format). Bad input → no-op.
        entries = [e for e in entries if str(e.get("ts", "")) >= since]
    if q:
        needle = q.lower()
        def _match(e):
            hay = f"{e.get('msg', '')} {e.get('category', '')} {e.get('ctx', '')}"
            return needle in hay.lower()
        entries = [e for e in entries if _match(e)]
    total = len(entries)
    if offset:
        entries = entries[offset:]
    return {"entries": entries[:limit], "total": total}


@api.post("/logs/backend/clear", dependencies=[Depends(require_api_key), Depends(require_admin)])
def clear_backend_logs(request: Request):
    """Wipe the in-memory backend event log ring buffer. Gated behind the
    optional shared-secret guard; records the actor that triggered it."""
    actor = request.headers.get("X-User") or request.headers.get("x-user-email") or "system"
    _BACKEND_LOG.clear()
    _log_event("info", "admin", "Backend event log cleared by user", actor=actor)
    return {"status": "ok"}


# =============================================================================
# FRONTEND LOG SINK — fold browser ErrorLog batches into the same ring buffer
# =============================================================================
_FE_MAX_ENTRIES = 50
_FE_MAX_STACK = 8 * 1024   # 8 KB
_FE_MAX_MSG = 2 * 1024     # 2 KB


def _truncate(s, cap: int):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= cap else s[:cap] + "…[truncated]"


@api.post("/logs/frontend")
def ingest_frontend_logs(payload: dict = Body(default={})):
    """
    Best-effort sink for browser-side ErrorLog entries. No auth (it is a log
    sink), but size-bounded: at most 50 entries per batch, stack ≤ 8 KB, msg ≤
    2 KB. Each entry is folded into the same in-memory ring buffer tagged
    source:'frontend', category = scope || 'frontend', preserving
    rid/error_code/stack/level.

    Body: { entries: [ { ts, level, scope, msg, errorCode?, reqId?, stack?,
            buildId?, sessionId?, plant?, route?, ctx? } ] }
    Returns: { status:'ok', accepted: N }
    """
    raw_entries = payload.get("entries") or []
    if not isinstance(raw_entries, list):
        raise HTTPException(status_code=400, detail="entries must be a list")
    accepted = 0
    for raw in raw_entries[:_FE_MAX_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        level = raw.get("level")
        if level == "warning":
            level = "warn"
        if level not in ("info", "warn", "error"):
            level = "info"
        scope = raw.get("scope")
        entry: dict = {
            "ts":       str(raw.get("ts") or pd.Timestamp.utcnow().isoformat()),
            "level":    level,
            "category": str(scope) if scope else "frontend",
            "msg":      _truncate(raw.get("msg"), _FE_MAX_MSG) or "",
            "source":   "frontend",
        }
        rid = raw.get("reqId") or raw.get("rid")
        if rid:
            entry["rid"] = str(rid)
        if raw.get("errorCode"):
            entry["error_code"] = str(raw.get("errorCode"))
        stack = _truncate(raw.get("stack"), _FE_MAX_STACK)
        if stack:
            entry["exc"] = stack
        # Preserve the remaining structured fields (buildId/sessionId/plant/route
        # + any caller ctx) under the ring's ctx slot, scalar-coerced like backend
        # events. Drop the keys already promoted above.
        ctx_src = dict(raw.get("ctx") or {})
        for k in ("buildId", "sessionId", "plant", "route"):
            if raw.get(k) is not None:
                ctx_src[k] = raw.get(k)
        if ctx_src:
            entry["ctx"] = {k: (v if isinstance(v, (int, float, bool, type(None))) else str(v))
                            for k, v in ctx_src.items()}
        _BACKEND_LOG.append(entry)
        accepted += 1
    return {"status": "ok", "accepted": accepted}


# =============================================================================
# STATIC FRONTEND  (MUST stay the last route registered)
# A mount at "/" is a catch-all: every @api.* route above is matched first, so
# /health, /tasks, /upload, /master-data/*, etc. keep working untouched.
# Everything else is served from STATIC_DIR: "/" -> index.html, plus /app.js,
# /styles.css, /nimbus-intelligence.js, /nimbus-worker.js, /locales/*.js.
# html=True serves index.html at "/" and as the SPA fallback for unknown paths.
# =============================================================================
api.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
