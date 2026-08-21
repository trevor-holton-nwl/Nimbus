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

Per-plant/per-line priority lists (color today; PRT_01/PRT_02/production_version
materialized but not yet ranked — docs/scheduling_priority.md Stage 1) persist in
the Postgres `priority_list` table and are loaded into a small in-process cache
(PLANT_LISTS); POST /reload refreshes that cache. There is no more global
fallback wheel — COLOR_FILE/GLOBAL_CW are retired.
"""
import collections
import contextvars
import csv
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
from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from typing import Any
from pydantic import BaseModel, ConfigDict, Field

import admin_tables
import auth
import db
import master_data as md
import sap_sync
import setup_data
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
        for k in ("category", "ctx", "rid", "error_code", "error_type", "event", "outcome"):
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

# Priority-list cache populated by load_priority_lists(); apply_priority_merge()
# reads from this instead of touching the DB per request. Keyed by RAW plant
# name (docs/scheduling_priority.md: "drop _cw_safe_name() from the lookup
# path") — NOT the _cw_safe_name() slug the old PLANT_CWS/color_wheel table
# used; that sanitizer is kept below only for the legacy-compat /color-wheel/*
# file-era helpers. There is no more global fallback wheel (GLOBAL_CW/
# COLOR_FILE are retired — Stage 1 decision: "Default tier: Per-plant only").
PLANT_LISTS: dict = {}      # { plant: { line_or_'': { field_key: {VALUE: RANK} } } }
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
    db.ensure_priority_list_table()
    db.ensure_order_schedule_segments_table()
    if CW_BACKFILL_FROM_DISK:
        _backfill_color_wheels_from_disk()
    load_priority_lists()
    md.ensure_labor_plan_table()
    md.ensure_labor_plan_machine_table()
    md.ensure_plant_constraints_column()
    md.ensure_plant_split_order_policy_column()
    md.ensure_plant_max_pull_forward_days_column()
    md.ensure_plant_visibility_horizon_columns()
    md.ensure_plant_setup_active_column()
    md.ensure_work_hours_columns()
    md.ensure_machine_calendar_table()
    md.ensure_machine_blackout_table()
    md.ensure_machine_key_columns()
    md.ensure_plant_blackout_table()
    md.ensure_unique_plant()
    md.ensure_material_plant_attributes()
    md.ensure_roles_table()
    md.ensure_role_plants_table()
    auth.ensure_user_security_table()
    auth.ensure_bootstrap_admin()
    auth.ensure_role_settings_column()
    auth.ensure_user_settings_table()
    md.ensure_system_settings_table()
    _log_event("info", "startup", "Priority lists loaded",
               plants_with_lists=len(PLANT_LISTS))
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
            operation, details = _admin_route_details(request)
            if operation:
                details.update(getattr(request.state, "admin_log_details", {}))
                _log_admin_action(operation, "failure",
                                  actor=request.headers.get("x-user-email") or request.headers.get("x-user"),
                                  route=request.url.path, method=request.method, duration_ms=ms,
                                  exc=exc, **details)
            _req_log.exception(f"unhandled {request.method} {request.url.path} {ms}ms rid={rid}: {exc}")
            _log_event("error", "request", f"Unhandled {request.method} {request.url.path}",
                       exc=exc, ms=ms)
            raise
        ms = int((time.perf_counter() - t0) * 1000)
        response.headers["x-request-id"] = rid
        operation, details = _admin_route_details(request)
        if operation:
            details.update(getattr(request.state, "admin_log_details", {}))
            outcome = "success" if response.status_code < 400 else "rejected"
            _log_admin_action(operation, outcome,
                              actor=request.headers.get("x-user-email") or request.headers.get("x-user"),
                              route=request.url.path, method=request.method, duration_ms=ms,
                              status=response.status_code, **details)
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
_BACKEND_LOG: collections.deque = collections.deque(maxlen=2000)


_LOG_LEVELS = {"info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


def _log_event(level: str, category: str, msg: str, *,
               exc: BaseException | None = None,
               error_code: str | None = None,
               event: str | None = None, outcome: str | None = None, **ctx) -> None:
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
    if event:
        entry["event"] = event
    if outcome:
        entry["outcome"] = outcome
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
                        "event": event, "outcome": outcome,
                        "evt_level": level, "evt_ts": ts})


_SENSITIVE_LOG_KEYS = frozenset({
    "authorization", "api_key", "password", "password_hash", "secret", "token",
    "cookie", "set_cookie", "raw", "body", "payload", "file_content",
})


def _log_admin_action(event: str, outcome: str, *, actor: str | None = None,
                      route: str | None = None, method: str | None = None,
                      duration_ms: int | None = None, exc: BaseException | None = None,
                      error_code: str | None = None, **details) -> None:
    """Emit one safe, terminal audit event for an admin write.

    This is deliberately transient (stdout + the bounded process-local ring),
    and accepts only caller-curated summaries.  Sensitive-looking keys are
    dropped defensively so an endpoint cannot accidentally copy credentials or
    raw request content into a diagnostic stream.
    """
    ctx = {
        "actor": actor or "unknown",
        **({"route": route} if route else {}),
        **({"method": method} if method else {}),
        **({"duration_ms": duration_ms} if duration_ms is not None else {}),
    }
    for key, value in details.items():
        if key.lower() not in _SENSITIVE_LOG_KEYS:
            ctx[key] = value
    level = "info" if outcome == "success" else ("warn" if outcome == "rejected" else "error")
    _log_event(level, "admin", f"Admin action {outcome}: {event}", exc=exc,
               error_code=error_code, event=event, outcome=outcome, **ctx)


# Route templates are used instead of raw paths so IDs and other target values
# are retained in the safe structured context rather than embedded in messages.
_ADMIN_WRITE_OPERATIONS = {
    "/upload": "orders.upload",
    "/bom/upload": "bom.upload",
    "/purge": "orders.purge",
    "/reload": "color_wheel.reload",
    "/upload/audit/clear": "upload_audit.clear",
    "/logs/backend/clear": "backend_log.clear",
    "/audit/log/clear": "audit_log.clear",
    "/color-wheel/{plant}": "color_wheel.write",
    "/priority-list/{plant}/{field_key}": "priority_list.write",
    "/master-data/{table}/bulk": "master_data.bulk_write",
    "/master-data/{table}/columns": "master_data.column_write",
    "/master-data/{table}/columns/{column}": "master_data.column_write",
    "/master-data/plants/{plant}/constraints": "plant.constraints_update",
    "/master-data/plants/{plant}/split-order-policy": "plant.split_order_policy_update",
    "/master-data/plants/{plant}/max-pull-forward-days": "plant.max_pull_forward_days_update",
    "/master-data/plants/{plant}/visibility-horizon": "plant.visibility_horizon_update",
    "/master-data/roles/{role}/page-access": "role.page_access_update",
    "/system-settings": "system_settings.update",
    "/master-data/material-plants/attributes": "material_plants.attributes_update",
    "/master-data/resync-order-attributes": "material_plants.resync_order_attributes",
    "/security/users/bulk": "security.users_bulk_write",
    "/security/users/{username}/reset-password": "security.password_reset",
    "/sap/interface/mappings/{object}": "sap.mapping_update",
    "/sap/interface/config/{object}": "sap.config_update",
    "/sap/interface/test-connection": "sap.connection_test",
    "/sap/interface/sync/{object}": "sap.manual_sync",
    "/labor-plan": "labor_plan.write",
    "/labor-plan/line": "labor_plan.line_write",
    "/plant-calendar/plant-hours": "calendar.plant_hours_update",
    "/plant-calendar/line-hours": "calendar.line_hours_update",
    "/plant-calendar/line-blackouts": "calendar.line_blackouts_update",
    "/plant-calendar/plant-blackouts": "calendar.plant_blackouts_update",
    "/setup/{plant}/definition": "setup.definition_write",
    "/setup/{plant}/active": "setup.active_write",  # D2: vestigial-but-retained; see plant.setup_active_update below
    "/plant/{plant}/setup-active": "plant.setup_active_update",
    "/setup/{plant}/matrix/import": "setup.matrix_import",
    "/setup/{plant}/matrix": "setup.matrix_delete",
    "/setup/{plant}/lines/{machine}/state": "setup.line_state_write",
    "/setup/{plant}/lines/{machine}/compatibility": "setup.line_compatibility_write",
    "/setup/{plant}/overrides": "setup.override_create",
    "/setup/{plant}/overrides/{override_id}": "setup.override_write",
    "/maintenance/vacuum-analyze": "maintenance.vacuum_analyze",
    "/maintenance/analyze": "maintenance.analyze",
}

_ADMIN_TARGET_PARAMS = frozenset({"plant", "machine", "override_id", "table", "column", "object", "username"})


def _admin_route_details(request: Request) -> tuple[str | None, dict]:
    """Return a recognized admin operation and safe path parameters only."""
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    operation = _ADMIN_WRITE_OPERATIONS.get(route_path)
    details = {
        key: value for key, value in request.path_params.items()
        if key in _ADMIN_TARGET_PARAMS
    }
    return operation, details


def _set_admin_log_details(request: Request, **details) -> None:
    """Attach endpoint-curated safe summary fields to its terminal event.

    Endpoint handlers must never pass raw request payloads here.  The terminal
    middleware applies the same sensitive-key guard as _log_admin_action.
    """
    current = getattr(request.state, "admin_log_details", {})
    current.update(details)
    request.state.admin_log_details = current


def _setup_plant_guard(plant: str, allowed_plants: list[str] | None) -> None:
    """Translate the shared plant scope choke point for setup routes."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _setup_error(exc: ValueError) -> HTTPException:
    """Keep setup signature conflicts distinct from malformed request data."""
    status = 409 if "signature version is stale" in str(exc).lower() else 400
    return HTTPException(status_code=status, detail=str(exc))


def _setup_freshness(result: dict) -> dict:
    """Attach only a correlation token and current signature marker to responses."""
    version = result.get("signature_version")
    if version is None and isinstance(result.get("definition"), dict):
        version = result["definition"].get("signature_version")
    return {**result, "freshness": {"signature_version": version, "request_id": _current_rid()}}


def _setup_observed_at(value) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("observed_at is required as an ISO datetime")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("observed_at is required as an ISO datetime") from exc


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


# Explicit "use row order, do NOT auto-detect a rank column" marker sent by the
# mapping modal's "— use row order —" option (web/index.html
# #pl-mapping-rank-col + PriorityListMapping.open in
# web/plant-and-administration.mts). Must stay in sync with that <option>'s
# value. A real spreadsheet header can't collide with it (dunder-wrapped), and
# it is never persisted — _resolve_priority_list_columns strips it and stores
# rank_column NULL.
ROW_ORDER_SENTINEL = "__row_order__"


def _resolve_priority_list_columns(
        df: pd.DataFrame, plant: str, spec: dict, *,
        explicit_machine: str = "", explicit_value_col: str | None = None,
        explicit_rank_col: str | None = None, reject_conflicts: bool = True,
) -> dict:
    """Shared column-resolution/validation for POST /priority-list/{plant}/{field_key}
    (Stage 2) and the legacy POST /color-wheel/{plant} (Decision 9b — the two
    were independent implementations before this consolidation). The legacy
    caller passes no explicit_* — auto-detect finds COLOR/ORDER_Y|ORDER exactly
    as it always did, since COLOR is spec['mp_column'] and is therefore always
    the sole candidate in a well-formed color-wheel file. The two routes differ
    only in how they react to a "needs_mapping" result: the generic endpoint
    returns it to the client for the mapping modal; the legacy endpoint (no
    mapping UI on the other end) turns it into a 400. `reject_conflicts`
    likewise differs by caller: the generic endpoint 400s on a duplicate value
    with conflicting ranks (Decision 6 — new, desired behavior); the legacy
    endpoint passes False so a previously-valid color-wheel file that relied
    on the old _cw_df_to_entries's last-value-wins tolerance keeps working
    (Decision 9b's "no previously-valid file starts failing" invariant).

    NOTE on pandas 3 / requirements.txt's pandas==3.0.3: `Series.astype(str)`
    on a column with missing values no longer turns them into the literal
    string "nan" (pandas 2 behavior) — a NaN cell survives as an actual float,
    which then blows up any `.str.*` accessor call or raw-NaN JSON encoding.
    Every column read here is `.fillna("")`'d *before* `.astype(str)`, not
    after, to normalize blanks up front instead of chasing NaN artifacts once
    they've already leaked into string ops or the JSON response.

    Returns {"status": "needs_mapping", "headers": [...], "sample": [...]} or
    {"status": "resolved", "value_col": str, "rank_col": str | None,
     "machine": str, "entries": {VALUE: RANK|None}}.
    Raises HTTPException(400) for plant-mismatch, unknown-machine, multi-value
    LINE column, an explicitly-named column that doesn't exist in the file, or
    (when reject_conflicts) conflicting ranks for the same value.
    """
    headers = list(df.columns)

    if "PLANT" in headers:
        # Normalize the same way db._str_id does (strips the Excel float
        # suffix, e.g. a numeric-typed PLANT column read as 5512.0 -> "5512")
        # and treats NaN/None as blank — both handled per-value since a mixed
        # numeric/blank column can't be safely blanket-.astype(str)'d under
        # pandas 3 (see the NaN note above).
        file_plants = {db._str_id(v) for v in df["PLANT"]} - {""}
        if file_plants and file_plants != {plant}:
            raise HTTPException(status_code=400,
                detail=f"File's PLANT column ({sorted(file_plants)}) doesn't match target plant {plant!r}")

    # "LINE" here is the uploaded spreadsheet's own column header — the
    # SAP/user-facing Excel format for this per-file scoping column — and is
    # unrelated to the JSON wire-facing "machine" key; it stays LINE.
    resolved_machine = explicit_machine.strip()
    if "LINE" in headers and not resolved_machine:
        file_lines = {v for v in df["LINE"].fillna("").astype(str).str.strip() if v and v.lower() != "nan"}
        if len(file_lines) > 1:
            raise HTTPException(status_code=400,
                detail=f"File contains multiple LINE values {sorted(file_lines)} — upload once per line, or pass a single line explicitly")
        if len(file_lines) == 1:
            resolved_machine = next(iter(file_lines))
    if resolved_machine:
        known_lines = md.known_line_codes_for_plant(plant)
        if resolved_machine not in known_lines:
            raise HTTPException(status_code=400,
                detail=f"{resolved_machine!r} is not a known machine for plant {plant!r}")

    resolved_value_col = explicit_value_col
    if resolved_value_col and resolved_value_col not in headers:
        raise HTTPException(status_code=400, detail=f"Missing required column: {resolved_value_col!r}")
    if not resolved_value_col:
        candidates = [h for h in headers if h.upper() in {spec["mp_column"].upper(), "VALUE"}]
        if len(candidates) == 1:
            resolved_value_col = candidates[0]
        else:
            # NaN -> None per-value on the already-extracted records, not via
            # DataFrame.where(): under pandas 3's default "str"-dtype text
            # columns, .where(df.notna(), None) silently leaves NaN in place
            # (verified against the pinned pandas==3.0.3), which would then
            # blow up JSONResponse's strict allow_nan=False encoding.
            sample = [
                {k: (None if pd.isna(v) else v) for k, v in rec.items()}
                for rec in df.head(5).to_dict(orient="records")
            ]
            return {"status": "needs_mapping", "headers": headers, "sample": sample}

    # An explicit ROW_ORDER_SENTINEL means the user picked the mapping modal's
    # "— use row order —" option ON PURPOSE. That option used to have value ''
    # which arrives here as a falsy string, indistinguishable from "the client
    # sent no rank_column at all" — so it fell through to auto-detect and could
    # rank by a column (e.g. ORDER) the user had explicitly declined, silently.
    # Stage 3 sequences real orders off these ranks, so the two cases must not
    # be conflated: the sentinel forces row order and skips auto-detect.
    force_row_order = (explicit_rank_col or "").strip() == ROW_ORDER_SENTINEL
    resolved_rank_col = None if force_row_order else explicit_rank_col
    if resolved_rank_col and resolved_rank_col not in headers:
        raise HTTPException(status_code=400, detail=f"Missing required column: {resolved_rank_col!r}")
    if not resolved_rank_col and not force_row_order:
        # Deterministic priority (not "exactly one match") so a file that
        # happens to carry more than one rank-shaped column (e.g. both a real
        # ORDER_Y and an unrelated ORDER) still picks a rank column instead of
        # silently discarding real rank data by falling back to row order.
        upper_to_header = {h.upper(): h for h in headers}
        for candidate_name in ("ORDER_Y", "RANK", "ORDER"):
            if candidate_name in upper_to_header:
                resolved_rank_col = upper_to_header[candidate_name]
                break

    values = df[resolved_value_col].fillna("").astype(str).str.upper().str.strip()
    if resolved_rank_col:
        ranks = pd.to_numeric(df[resolved_rank_col], errors="coerce")
    else:
        ranks = pd.Series(range(1, len(df) + 1), dtype=float)

    entries: dict[str, float | None] = {}
    conflicts: list[str] = []
    for v, r in zip(values, ranks, strict=True):
        if not v:
            continue
        r_val = None if pd.isna(r) else float(r)
        if reject_conflicts and v in entries and entries[v] != r_val:
            conflicts.append(v)
        entries[v] = r_val
    if conflicts:
        raise HTTPException(status_code=400,
            detail=f"Conflicting ranks for the same value in this file: {sorted(set(conflicts))}")

    return {"status": "resolved", "value_col": resolved_value_col, "rank_col": resolved_rank_col,
            "machine": resolved_machine, "entries": entries}


def _persist_priority_list(plant: str, field_key: str, spec: dict, entries: dict, *,
                           machine: str, value_col: str, rank_col: str | None,
                           filename: str, file_row_count: int, user: str,
                           legacy_action_names: bool = False) -> bool:
    """Shared upsert+audit+cache-reload step (Decision 9b) — this part was
    ALREADY byte-for-byte identical between the legacy and generic upload
    paths before consolidation; only the audit action-name family differs,
    controlled by legacy_action_names so /color-wheel/{plant}'s historical
    audit trail (color_wheel_upload/color_wheel_replace) doesn't fork into a
    second naming scheme for the same route. Returns is_replace.

    `priority_list.row_count` stores len(entries) — the number of value/rank
    pairs actually STORED — not the uploaded file's raw row count. Every
    consumer of that column renders it as "N values" (the Stage 2 field card,
    a machine-override row, PriorityListViewer's meta line, the legacy
    GET /color-wheels list), and _resolve_priority_list_columns drops blank
    values and collapses duplicates, so a 500-row file with 40 distinct values
    displayed "500 values" while only 40 could ever affect sequencing. This is
    the single choke point for both upload routes, so the stored count can't
    fork between them. The raw file row count is kept in the audit trail
    (`file_row_count`) — that is where upload provenance belongs.
    """
    stored_count = len(entries)
    res = db.upsert_priority_list(
        plant, field_key, entries, line=machine,
        source_column=spec["orders_column"], value_column=value_col,
        rank_column=rank_col, filename=filename, row_count=stored_count, uploaded_by=user,
    )
    is_replace = not res["inserted"]
    if legacy_action_names:
        action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    else:
        action = "priority_list_replace" if is_replace else "priority_list_upload"
    _cw_append_audit({
        "ts": datetime.utcnow().isoformat() + "Z", "user": user, "action": action, "plant": plant,
        "details": {"field_key": field_key, "machine": machine, "filename": filename,
                    "row_count": stored_count, "file_row_count": file_row_count,
                    "replaced": is_replace},
    })
    _reload_one_plant_lists(plant)
    return is_replace


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


def load_priority_lists() -> None:
    """
    Populate the PLANT_LISTS module-level cache from the durable priority_list
    Postgres table — { plant: { line_or_'': { field_key: {VALUE: RANK} } } },
    keyed by RAW plant name. Called at startup, on /reload, and after a
    priority-list upload/delete/resync. No global fallback wheel anymore
    (GLOBAL_CW/COLOR_FILE retired — docs/scheduling_priority.md "Default tier"
    decision): a plant with nothing uploaded just has no entry here.
    """
    global PLANT_LISTS, CW_LOADED_AT
    try:
        PLANT_LISTS = db.load_all_priority_lists()
    except Exception as e:
        # Degrade (no priority-list ordering) but record why — orders still
        # schedule, just without color/PRT ordering, matching the old
        # missing-wheel behavior.
        PLANT_LISTS = {}
        _log_event("error", "color_wheel", "Could not load priority lists from DB",
                   exc=e, error_code="db.read")
    CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()


def _reload_one_plant_lists(plant: str) -> None:
    """
    Refresh the PLANT_LISTS cache entry for a single plant from the
    priority_list table — used after an upload/delete/resync so we don't
    reload every plant's lists. Keyed by the RAW plant name (no
    _cw_safe_name() — see the PLANT_LISTS module comment). Currently reloads
    the whole plant (all machines/fields) since Stage 1 has no per-(machine, field)
    upload endpoint yet; Stage 2 can narrow this once it does.
    """
    global CW_LOADED_AT
    try:
        all_lists = db.load_all_priority_lists()
        if plant in all_lists:
            PLANT_LISTS[plant] = all_lists[plant]
        else:
            PLANT_LISTS.pop(plant, None)
    except Exception as e:
        _log_event("warn", "color_wheel", "Could not refresh plant priority lists",
                   exc=e, error_code="db.read", plant=plant)
    CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()


def _apply_priority_scope(df: pd.DataFrame, mask: "pd.Series[bool]", cw_map: dict | None) -> None:
    """Stamp ORDER_Y for the rows selected by `mask` from `cw_map`, in place.
    A no-op when `cw_map` is empty/None or nothing in `df` matches `mask`."""
    if cw_map and mask.any():
        df.loc[mask, "ORDER_Y"] = df.loc[mask, "COLOR"].map(cw_map)


def apply_priority_merge(df: pd.DataFrame, plant: str | None = None) -> tuple[pd.DataFrame, dict]:
    """
    Generalizes the old apply_color_merge to every plant's configured
    priority lists (docs/scheduling_priority.md). Stage 1 still only stamps
    ORDER_Y — the color-compat alias the emitted row sort and ColorWheelViewer
    depend on — from each plant's 'colorWheel' list; PRT_01/PRT_02/
    production_version are materialized onto orders (Task 2's seam) but not
    yet consulted here (Stage 3 is the optimizer change, and ranks resolve
    client-side there — N2b, no generic RANKS field is ever emitted).

    A machine-specific 'colorWheel' list wins over the plant-wide one for that
    machine (docs/scheduling_priority.md "List scope" decision); orders whose
    color isn't in the applicable list are NOT dropped — they are assigned
    last priority (999999) so they sequence after listed colors. Returns
    (df, stats). Reads from the PLANT_LISTS module cache — callers should
    ensure load_priority_lists() has been invoked at least once. No global
    fallback wheel anymore (GLOBAL_CW/COLOR_FILE retired).

    When `plant` is supplied (the /tasks path already has a plant-scoped df),
    only that plant's lists are consulted — we skip the loop over every
    plant. `plant=None` preserves the original all-plants behavior.
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
        # PRT_01/PRT_02/PRODUCTION_VERSION are equally rankable (master_data.
        # RANKABLE_FIELDS) and equally subject to the case-mismatch pathology
        # this fold exists to close for COLOR: _resolve_priority_list_columns
        # already uppercases uploaded priority-list values, so an order's own
        # attribute value must be folded the same way before any rank lookup
        # compares the two, whether that lookup happens here or client-side.
        # Guarded by column presence — the real /tasks df (db.query_orders'
        # _ORDERS_SELECT) always carries these, but this function is also
        # exercised in tests against minimal synthetic frames.
        for _attr_col in ("PRT_01", "PRT_02", "PRODUCTION_VERSION"):
            if _attr_col in df.columns:
                df[_attr_col] = df[_attr_col].astype(str).str.upper().str.strip()
        df = df.drop(columns=["ORDER_Y"], errors="ignore")
        df["ORDER_Y"] = None

        def _merge_one_plant(by_machine: dict, plant_mask) -> None:
            plantwide = (by_machine.get("") or {}).get("colorWheel")
            _apply_priority_scope(df, plant_mask, plantwide)
            for priority_scope_key, fields in by_machine.items():
                if priority_scope_key == "":
                    continue
                machine_map = fields.get("colorWheel")
                if machine_map:
                    _apply_priority_scope(df, plant_mask & (df["MACHINE"] == priority_scope_key), machine_map)

        if plant:
            # Scoped path: only this plant's lists matter for a plant-scoped df.
            by_machine = PLANT_LISTS.get(plant)
            if by_machine:
                _merge_one_plant(by_machine, pd.Series(True, index=df.index))
        else:
            for plant_key, by_machine in PLANT_LISTS.items():
                plant_mask = df["PLANT"] == plant_key
                if plant_mask.any():
                    _merge_one_plant(by_machine, plant_mask)

        # Orders whose COLOR isn't found in any applicable list are NOT dropped —
        # they flow through and sequence LAST via ORDER_Y = 999999 below.
        # Priority lists are plant-optional (and switchable per plant on the
        # frontend), so a missing match must never remove an order from the
        # schedule. We still record the unlisted colors so the diagnostics
        # panel can surface them.
        miss_mask = df["ORDER_Y"].isna()
        color_miss = int(miss_mask.sum())
        if color_miss:
            missed = sorted(df.loc[miss_mask, "COLOR"].dropna().unique().tolist())
            stats["color_merge_misses"] = color_miss
            stats["missed_colors"] = missed

        df["ORDER_Y"] = pd.to_numeric(df["ORDER_Y"], errors="coerce").fillna(999999)
    except Exception as e:
        _warn("error", f"Priority-list merge failed: {e}; all rows get priority 999999")
        df = df.copy()
        df["ORDER_Y"] = 999999

    # Presentation + finish-to-start-link-building order ONLY (R6) — never the
    # optimizer's order. The optimizer (Engine._sortTerms/_dispatchDayIntegrity,
    # frontend) reads plants.constraints and computes its own sequence; this
    # sort only affects what order rows arrive in this response and therefore
    # which rows get linked into a chain in get_tasks. Do not "fix" this by
    # reading plants.constraints here — the optimizer overwrites it anyway.
    df = df.sort_values(
        by=["BASIC_START_DATE", "MACHINE", "ORDER_Y"]
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


def _schedule_segments_to_wire(raw) -> list[dict]:
    """Normalize the JSONB child aggregate into the API's naive-local date
    contract. Bad legacy data is skipped rather than allowed through a strict
    response model as a malformed schedule."""
    if not isinstance(raw, list):
        return []
    clean: list[dict] = []
    for index, segment in enumerate(raw, start=1):
        if not isinstance(segment, dict):
            continue
        start = _to_pydt(segment.get("start_date"))
        end = _to_pydt(segment.get("end_date"))
        if start is None or end is None or end <= start:
            continue
        try:
            sequence = int(segment.get("sequence", index))
        except (TypeError, ValueError):
            sequence = index
        clean.append({
            "sequence": sequence,
            "start_date": start.strftime("%Y-%m-%dT%H:%M:%S"),
            "end_date": end.strftime("%Y-%m-%dT%H:%M:%S"),
        })
    return clean


# =========================
# Response models (Phase 4 Task 1 — response_model= additions)
# =========================
class LinkDTO(BaseModel):
    """One finish-to-start link in GET /tasks's `links` array."""
    id: int
    source: str
    target: str
    type: str


class ScheduleSegmentDTO(BaseModel):
    """One productive child interval of a logical production order."""
    sequence: int
    start_date: str
    end_date: str


class TaskDTO(BaseModel):
    """One row of GET /tasks's `data` array. Field set mirrors the dict literal
    built in get_tasks (brain.py, the `data.append({...})` block) verbatim —
    see docs/typescript_migration.md §F/§C. Optional fields are exactly the
    ones read via `row.get(...)` with no coercing default (i.e. can be None
    from a NaN source row); non-optional fields either have a code-level
    default (e.g. `text`, `firmed`, `user_scheduled`) or come from a groupby
    key that can't be null."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    text: str
    start_date: str
    end_date: str
    original_start_date: str | None = None
    original_end_date: str | None = None
    user_scheduled: bool
    MACHINE: str
    MATERIAL_DESCRIPTION: str
    MATERIAL_NUMBER: str | None = None
    order_quantity_gmein: float | None = Field(default=None, alias="ORDER_QUANTITY_(GMEIN)")
    COLOR: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    PLANT: str | None = None
    ORDER: str | None = None
    ORDER_Y: float | None = None
    RUN_TIME: float | None = None
    FORM_SIZE: str | None = None
    notes: str | None = None
    firmed: bool
    row_version: int | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False


class TasksResponse(BaseModel):
    """GET /tasks's full envelope. `meta` stays a loose dict: it's `DIAGNOSTICS`
    merged with per-request color-merge stats (brain.py's `meta = dict(DIAGNOSTICS, **cm_stats)`),
    a large, evolving diagnostics bag with no single fixed schema — modeling every
    key precisely is out of scope for this phase and would need to track
    DIAGNOSTICS's shape by hand forever. The empty-result path also returns a
    smaller `meta` subset (see get_tasks's `empty_meta`), which a strict schema
    would reject."""
    data: list[TaskDTO]
    links: list[LinkDTO]
    meta: dict[str, Any]


class TaskUpdateResult(BaseModel):
    """Response for POST /task/update (singular). Narrower than the bulk
    shape — this endpoint also raises 404/400 (response_model only applies
    to the 200 path)."""
    status: str
    persisted: int
    failed: int
    stale: list[str]
    versions: dict[str, int]


class BulkUpdateResult(BaseModel):
    """Shared response shape for POST /tasks/update and POST /tasks/bulk_update.
    Never 4xx — a version conflict or a rolled-back transaction is reported here,
    not as an HTTP error status. error_code/cause are only populated when status
    == 'error' (a whole-transaction rollback)."""
    status: str
    updated: int
    persisted: int
    failed: int
    invalid: int
    not_found: int
    invalid_ids: list[str]
    not_found_ids: list[str]
    stale: list[str]
    versions: dict[str, int]
    error_code: str | None = None
    cause: str | None = None


class TaskVersionRow(BaseModel):
    """One row of GET-equivalent /tasks/refresh's `data` array — db.get_task_versions'
    shape exactly (db.py:437-445)."""
    id: str
    start_date: str | None = None
    end_date: str | None = None
    row_version: int | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False


class TasksRefreshResponse(BaseModel):
    data: list[TaskVersionRow]


class BaselineCorrectResult(BaseModel):
    """Response for POST /tasks/baseline-correct — db.correct_due_date_baselines'
    shape (db.py:604+) plus the same status/error_code/cause failure fields as
    BulkUpdateResult."""
    status: str
    applied: int
    persisted: int
    skipped: int
    not_matched: int
    versions: dict[str, int]
    error_code: str | None = None
    cause: str | None = None


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
        # No more "path"/"reachable" file check (GLOBAL_CW/COLOR_FILE retired —
        # priority lists are DB-backed, covered by db.connected above). Key
        # name kept as color_wheel for frontend compat — only .misses is read
        # (web/plant-and-administration.mts _renderHealth).
        "color_wheel": {
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
    # and the wheel from the already-cached PLANT_LISTS dict (no DB re-read) —
    # union of every plant's plant-wide 'colorWheel' entries, repointed at
    # priority_list now that GLOBAL_CW is retired (docs/scheduling_priority.md
    # N18: this is a DB-wide summary, not per-plant coverage — the generalized
    # per-field, per-plant coverage panel is Stage 2/3, backed by
    # db.priority_list_coverage()).
    color_stats: dict = {"error": None, "total_in_orders": 0, "matched": 0,
                         "missed": 0, "missed_colors": DIAGNOSTICS.get("missed_colors", [])}
    try:
        # Normalize order colors the same way priority_list entries are (upper/strip).
        order_colors = {
            c.upper().strip()
            for c in db.distinct_order_colors()
            if c is not None and str(c).strip()
        }
        wheel_colors = {
            color
            for by_machine in PLANT_LISTS.values()
            for color in (by_machine.get("") or {}).get("colorWheel", {})
        }
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
    Refresh the in-process priority-list cache from Postgres. In stateless mode
    orders are never cached, so there is nothing to re-read for them — this is
    the cross-replica hook to pick up a newly uploaded/resynced priority list
    without a restart.
    """
    try:
        load_priority_lists()
        DIAGNOSTICS["loaded_at"] = pd.Timestamp.utcnow().isoformat()
        _log_event("info", "reload", "Priority-list cache refreshed",
                   plants_with_lists=len(PLANT_LISTS))
        return {"status": "ok", "diagnostics": _diag_snapshot()}
    except Exception as e:
        _log_event("error", "reload", "Priority-list reload failed", exc=e)
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


@api.get("/tasks", response_model=TasksResponse)
def get_tasks(plant: str | None = None, machine: str | None = None,
              limit: int | None = Query(default=None, ge=1, le=10000,
                  description="Max rows to return. Omit for the full plant-scoped list."),
              offset: int | None = Query(default=None, ge=0,
                  description="Rows to skip before returning (for paging)."),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Return tasks as JSON with finish-to-start links and pipeline metadata.

    Stateless: queries Postgres per request (db.query_orders) rather than
    copying an in-memory frame. ?plant= is the scaling unit (bounds the result
    to one plant); ?machine= narrows further; ?limit/?offset= are a coarse guard
    rail for unscoped tooling (links are only coherent within a plant/machine scope).
    Color merge still runs per-request from the in-process color-wheel cache.
    Response: { data: Task[], links: Link[], meta: DiagnosticsDict }
    When ?limit/?offset= are supplied, meta.total carries the full filtered
    row count (ignoring limit/offset) so callers can paginate.

    Per-user plant scope (role_plants, via auth.get_allowed_plants) is
    enforced here: an explicit ?plant= (or the plant a ?machine= resolves to)
    outside the caller's allowed set 403s; an unscoped (?limit=-only) pull
    is silently bounded to the allowed set rather than rejected.
    """
    paging = limit is not None or offset is not None
    # A request with no plant, no machine, and no explicit limit would materialize the
    # entire order book. Refuse it — plant is the scaling unit, so callers must scope
    # by ?plant=/?machine=, or bound an unscoped tooling pull with ?limit=.
    if plant is None and machine is None and limit is None:
        raise HTTPException(
            status_code=400,
            detail=("Specify ?plant= (or ?machine=) to scope the request, or ?limit= "
                    "for a bounded unscoped tooling pull — refusing to load the full order book."),
        )
    if allowed_plants is not None:
        if plant is not None and plant not in allowed_plants:
            raise HTTPException(status_code=403, detail=f"Plant {plant!r} is not in your assigned plants")
        if plant is None and machine is not None:
            line_plants = md.plants_for_line(machine)
            if line_plants and not (set(line_plants) & set(allowed_plants)):
                raise HTTPException(status_code=403, detail=f"Machine {machine!r} is not on any of your assigned plants")
    # C1 (2026-08-20): query_orders resolves the plant's visibility-horizon
    # bound internally (to filter its own WHERE) and hands it back here too,
    # so this response's `meta.visibility_horizon_end` reuses that ALREADY-
    # resolved value instead of a third round-trip re-resolving the same
    # plant config from scratch. Sent down rather than have the frontend keep
    # its own copy of the plant-local-midnight/roll-hour clock math (Step 2)
    # — Timeline.rebuild reads this to clamp the Gantt's far edge.
    df, visibility_horizon_end = db.query_orders(plant=plant, line=machine, limit=limit, offset=offset, allowed_plants=allowed_plants)
    if df is None or df.empty:
        empty_meta = {"rendered": 0, "link_count": 0, "plant_filter_active": plant,
                      "machine_filter_active": machine, "pre_color_merge_count": 0,
                      "raw_row_count": 0, "unique_id_count": 0,
                      "color_merge_misses": 0, "missed_colors": [],
                      "emitted_task_count": 0, "color_merge_ms": 0,
                      "total": (db.count_orders(plant=plant, line=machine, allowed_plants=allowed_plants) if paging else 0),
                      "loaded_at": DIAGNOSTICS.get("loaded_at"),
                      "source_file": "postgres://nimbus/orders",
                      "visibility_horizon_end": visibility_horizon_end.isoformat() if visibility_horizon_end else None}
        return {"data": [], "links": [], "meta": empty_meta}

    # Drop rows with no usable start date (query can't enforce this without
    # losing the NULL diagnostic), then color-merge the scoped subset.
    df = df.dropna(subset=["BASIC_START_DATE"]).reset_index(drop=True)
    pre_merge_count = len(df)

    df, cm_stats = apply_priority_merge(df, plant=plant)
    df = df.astype(object).where(pd.notna(df), other=None)
    data = []
    link_id_counter = 1
    links = []

    for prod_line, group_raw in df.groupby("MACHINE"):
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
                "MACHINE": prod_line,
                "MATERIAL_DESCRIPTION": task_text,
                "MATERIAL_NUMBER": _clean_id(row.get("MATERIAL_NUMBER")),
                "ORDER_QUANTITY_(GMEIN)": row.get("ORDER_QUANTITY_(GMEIN)"),
                "COLOR": row.get("COLOR"),
                "PRT_01": row.get("PRT_01"),
                "PRT_02": row.get("PRT_02"),
                "PRODUCTION_VERSION": row.get("PRODUCTION_VERSION"),
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
                "schedule_segments": _schedule_segments_to_wire(row.get("SCHEDULE_SEGMENTS")),
                "runtime_schedule_mismatch": bool(row.get("RUNTIME_SCHEDULE_MISMATCH")),
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
    meta["machine_filter_active"] = machine
    meta["pre_color_merge_count"] = pre_merge_count
    meta["raw_row_count"] = pre_merge_count
    meta["unique_id_count"] = len(data)
    meta["total"] = db.count_orders(plant=plant, line=machine, allowed_plants=allowed_plants) if paging else len(data)
    meta["visibility_horizon_end"] = visibility_horizon_end.isoformat() if visibility_horizon_end else None
    return {"data": data, "links": links, "meta": meta}


# ---------------------------------------------------------------------------
# Task date updates — shared model + validation + apply/persist/rollback
# ---------------------------------------------------------------------------
class ScheduleSegmentInput(BaseModel):
    """A value-only child interval. Extra keys are rejected so callers cannot
    smuggle child identities or unrelated writable fields into the aggregate."""
    model_config = ConfigDict(extra="forbid")

    sequence: int
    start_date: str
    end_date: str


class TaskDateUpdate(BaseModel):
    """One task's optional schedule/attribute edit. Unknown fields are ignored.

    Optimistic concurrency: `base_version` is the xmin the client last saw for this
    row. The write is rejected (reported as `stale`) if the row's current xmin differs,
    unless `force` is set. `force=True` is used for authoritative bulk reschedules
    (the optimizer), which intentionally overwrite regardless of concurrent edits.
    """
    id: str
    start_date: str | None = None
    end_date: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    RUN_TIME: float | None = None
    schedule_segments: list[ScheduleSegmentInput] | None = None
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
    Normalize schedule/attribute edits and persist them write-through to Postgres
    in a single transaction (db.update_task_dates_bulk). No in-memory frame to
    mutate anymore — the DB is the source of truth.

    Single source of truth for /task/update, /tasks/update and /tasks/bulk_update.
    Inverted ranges are validated against each row's effective current dates and
    counted as `invalid`; unknown ids are counted as `not_found`. Edits whose
    `base_version` no longer matches the row (a concurrent write landed first) are
    rejected and reported in `stale` unless `force` is set.

    Returns { applied, persisted, failed, invalid, not_found, invalid_ids,
              not_found_ids, stale, versions }. invalid_ids/not_found_ids carry
    the actual rejected ids (from db.update_task_dates_bulk) so the client can
    stop retrying terminal rejections while keeping transiently-lost rows dirty.
    """
    norm: list[dict] = []
    invalid = 0
    attribute_fields = ("PRT_01", "PRT_02", "PRODUCTION_VERSION")
    for it in items:
        if not it.id:
            invalid += 1
            continue
        start_dt = _to_pydt(it.start_date) if it.start_date else None
        end_dt   = _to_pydt(it.end_date)   if it.end_date   else None
        # Pydantic tracks explicitly supplied fields so an explicit null can
        # clear an attribute, while omitted attributes remain untouched.
        supplied = getattr(it, "model_fields_set", set())
        attrs = {
            field: (getattr(it, field).strip() if isinstance(getattr(it, field), str) else None)
            for field in attribute_fields
            if field in supplied
        }
        has_runtime = "RUN_TIME" in supplied
        has_segments = "schedule_segments" in supplied
        segments: list[dict] | None = None
        if has_segments:
            # An aggregate replacement is deliberately explicit.  Treating a
            # JSON null as [] would let a malformed client erase all durable
            # productive pieces without supplying the parent schedule it meant
            # to replace.
            if it.schedule_segments is None:
                invalid += 1
                continue
            segments = []
            for segment in it.schedule_segments:
                segment_start = _to_pydt(segment.start_date)
                segment_end = _to_pydt(segment.end_date)
                if segment_start is None or segment_end is None:
                    invalid += 1
                    segments = None
                    break
                segments.append({
                    "sequence": segment.sequence,
                    "start": segment_start,
                    "end": segment_end,
                })
            if segments is None:
                continue
        if start_dt is None and end_dt is None and not attrs and not has_runtime and not has_segments:
            continue
        item = {"id": it.id, "start": start_dt, "end": end_dt,
                **attrs,
                "base_version": it.base_version, "force": it.force}
        if has_runtime:
            item["RUN_TIME"] = it.RUN_TIME
        if has_segments:
            item["schedule_segments"] = segments
        norm.append(item)

    if not norm:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": invalid,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {}}

    try:
        res = db.update_task_dates_bulk(norm)
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "db", "Bulk task update persist failed (transaction rolled back)",
                   exc=e, error_code=error_code, count=len(norm))
        # Honest body signal: the HTTP status stays 200 (per-row reporting
        # contract), but flag the hard failure + a stable cause so the frontend
        # can tell a rolled-back persist apart from a partial success.
        return {"applied": 0, "persisted": 0, "failed": len(norm),
                "invalid": invalid, "not_found": 0,
                "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {},
                "status": "error", "error_code": error_code,
                "cause": "Bulk task update persist failed (transaction rolled back)"}
    res["invalid"] = res.get("invalid", 0) + invalid
    return res


@api.post("/task/update", response_model=TaskUpdateResult)
def update_task(task: TaskDateUpdate):
    """
    Update a single task's schedule/priority attributes and persist to DB.
    Payload: { id, start_date?, end_date?, PRT_01?, PRT_02?,
               PRODUCTION_VERSION?, base_version?, force? }
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
@api.post("/tasks/update", response_model=BulkUpdateResult)
def tasks_update(payload: TasksUpdatePayload):
    """
    Bulk-update task dates/priority attributes and persist to DB (one transaction).
    Payload: { tasks: [{ id, start_date?, end_date?, PRT_01?, PRT_02?,
                         PRODUCTION_VERSION?, base_version?, force? }],
               blocks?, calendars? }
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions }
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
           # Forward the actual rejected ids (not just counts) so the client can
           # tell terminal rejections (invalid range / not in DB — stop retrying)
           # from transiently-lost rows (keep dirty, retry). db.update_task_dates_bulk
           # produces these; without them the frontend's accounted-set logic
           # (saveAll R7) never clears a terminally-rejected id → it stays dirty and
           # re-warns "Partial DB save" on every subsequent save.
           "invalid_ids": res.get("invalid_ids", []),
           "not_found_ids": res.get("not_found_ids", []),
           "stale": stale, "versions": res.get("versions", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


@api.post("/tasks/bulk_update", response_model=BulkUpdateResult)
def bulk_update(tasks: list[TaskDateUpdate]):
    """
    Alias for /tasks/update with a flat list payload (used by external tooling/Postman).
    Payload: [{ id, start_date?, end_date?, base_version?, force? }]
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions }
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
           # Forward the actual rejected ids (not just counts) so the client can
           # tell terminal rejections (invalid range / not in DB — stop retrying)
           # from transiently-lost rows (keep dirty, retry). db.update_task_dates_bulk
           # produces these; without them the frontend's accounted-set logic
           # (saveAll R7) never clears a terminally-rejected id → it stays dirty and
           # re-warns "Partial DB save" on every subsequent save.
           "invalid_ids": res.get("invalid_ids", []),
           "not_found_ids": res.get("not_found_ids", []),
           "stale": stale, "versions": res.get("versions", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


class TaskRefreshPayload(BaseModel):
    """Ids the client needs to reconcile after a concurrency conflict."""
    ids: list[str] = []


@api.post("/tasks/refresh", response_model=TasksRefreshResponse)
def tasks_refresh(payload: TaskRefreshPayload):
    """
    Lean refetch of specific orders' current dates + row_version, for optimistic-
    concurrency conflict reconciliation. Returns only what the client needs to
    overwrite its stale copies — no links, no color merge.
    Payload: { ids: [str] }
    Response: { data: [{ id, start_date, end_date, row_version }] }
    """
    rows = db.get_task_versions(payload.ids)
    for row in rows:
        row["schedule_segments"] = _schedule_segments_to_wire(row.get("schedule_segments"))
    return {"data": rows}


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


@api.post("/tasks/baseline-correct", response_model=BaselineCorrectResult)
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
async def upload_orders(request: Request, file: UploadFile = File(...)):
    """
    Receive an xlsx file (sequence_testing-shaped) and upsert into the orders
    table. Stateless: there is no in-memory frame to refresh — the next /tasks
    call reads the new rows straight from Postgres. The blocking parse/upsert is
    offloaded to a worker thread so it doesn't block the event loop.
    """
    raw = await file.read()
    # Stage 0 observation seam: capture only already-completed planned work
    # before ingest can replace its source rows.  This never changes orders,
    # dates, capacity, alerts, or optimizer behavior.
    await run_in_threadpool(
        setup_data.capture_setup_states_before_schedule_mutation,
        actor=request.headers.get("x-user-email") or "system", reason="Excel upload replacement"
    )
    result = await run_in_threadpool(db.ingest_orders_from_excel, raw,
                                     file.filename or "upload.xlsx")
    if result.get("status") != "ok":
        # Bad file / missing columns is a client error.
        raise HTTPException(status_code=400, detail=result.get("message", "Upload failed"))

    _log_event("info", "upload", "Orders uploaded and ingested",
               filename=file.filename, inserted=result.get("inserted", 0),
               updated=result.get("updated", 0), raw=result.get("raw_row_count", 0))
    _set_admin_log_details(
        request, filename=file.filename or "upload.xlsx",
        rows_received=result.get("raw_row_count", 0), inserted=result.get("inserted", 0),
        updated=result.get("updated", 0), warning_count=len(result.get("warnings") or []),
    )
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
def purge_orders(payload: dict, request: Request):
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
    # This must remain adjacent to the DELETE below: a derived state may only
    # observe the prior schedule while it still exists.
    setup_data.capture_setup_states_before_schedule_mutation(
        actor=request.headers.get("x-user-email") or "system", reason="order purge"
    )
    result = db.purge_orders_by_date(start, end)
    if result.get("status") == "ok":
        _log_event("info", "purge", "Orders purged by date range",
                   deleted=result.get("deleted", 0), start=str(start), end=str(end))
    return result


@api.get("/upload/audit", dependencies=[Depends(require_admin)])
def get_upload_audit(limit: int = 50):
    """Recent uploads, newest first, for the Admin Cockpit history card."""
    return {"audit": db.upload_audit_log(limit)}


@api.get("/upload/{batch_id}/missing-master-data", dependencies=[Depends(require_admin)])
def get_missing_master_data(batch_id: str, format: str | None = Query(default=None)):
    """
    The missing-master-data exception report for one upload batch
    (docs/scheduling_priority.md "Unmatched MP rows" decision: uploads never
    block — this is what makes the resulting gap actionable). Reads the
    category=='missing_master_data' entries db._stamp_order_attributes wrote
    into that batch's upload_audit.warnings. ?format=csv returns a
    downloadable CSV instead of JSON, for handing to whoever owns collecting
    the missing material_plants rows.

    Response (JSON): {batch_id, unmatched_pairs, unmatched_orders,
    exceptions: [{plant, material_number, order_count, reason}, ...]}
    reason is 'no_mp_row' (material absent from material_plants at that
    plant) or 'no_plant_derived' (the order has no plant at all — an
    ambiguous multi-plant line code, a different pre-existing problem, N9).
    """
    warnings = db.get_upload_audit_warnings(batch_id)
    if warnings is None:
        raise HTTPException(status_code=404, detail=f"No upload found for batch {batch_id!r}")

    exceptions: list[dict] = []
    for w in warnings:
        if isinstance(w, dict) and w.get("category") == "missing_master_data":
            exceptions.extend(w.get("exceptions") or [])

    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["plant", "material_number", "order_count", "reason"])
        writer.writeheader()
        for e in exceptions:
            writer.writerow({k: e.get(k) for k in ["plant", "material_number", "order_count", "reason"]})
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="missing-master-data-{batch_id}.csv"'},
        )

    return {
        "batch_id": batch_id,
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(int(e.get("order_count") or 0) for e in exceptions),
        "exceptions": exceptions,
    }


@api.get("/master-data/{plant}/missing-master-data", dependencies=[Depends(require_admin)])
def get_live_missing_master_data(
        plant: str, format: str | None = Query(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Live (not batch-scoped) missing-master-data report for one plant's
    Optimization tab (docs/superpowers/plans/2026-08-11-priority-lists-stage-2.md
    Decision 3). Same JSON/CSV shape as GET /upload/{batch_id}/missing-master-data
    so the frontend shares one renderer."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    result = db.missing_master_data_for_plant(plant)
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["plant", "material_number", "order_count", "reason"])
        writer.writeheader()
        for e in result["exceptions"]:
            writer.writerow({k: e.get(k) for k in ["plant", "material_number", "order_count", "reason"]})
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="missing-master-data-{plant}.csv"'},
        )
    return {"plant": plant, **result}


@api.post("/upload/audit/clear", dependencies=[Depends(require_admin)])
def clear_upload_audit():
    """Delete all upload history records."""
    return db.clear_upload_audit()


@api.get("/priority-fields")
def list_priority_fields():
    """Registry of rankable fields for the priority-list upload UI (Stage 2)
    and, later, the Scheduling Constraints tree (Stage 3's GET /priority-fields
    consumer, per master_data.py's RANKABLE_FIELDS comment). Order matches
    RANKABLE_FIELDS' declaration order."""
    return {
        "fields": [
            {"field_key": key, **spec}
            for key, spec in md.CONFIGURABLE_PRIORITY_FIELDS.items()
        ]
    }


@api.get("/priority-rank-maps")
def get_priority_rank_maps(
        plant: str = Query(..., min_length=1),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """In-memory rank-map read for the optimizer's hot path (Stage 3) — the
    rank data itself is a zero-DB-hit read of brain.PLANT_LISTS (already kept
    current by every priority-list upload/delete (Stage 2) and POST /reload);
    the plant-authorization gate below does its own one-row user_security
    lookup when an identity header is present, same as every sibling in this
    block. Shape: {machine_or_empty: {field_key: {VALUE: RANK}}} — the exact
    native shape of PLANT_LISTS, no reshaping, since this runs on every
    optimize call and every alert auto-fix.

    Plant-scoped like every sibling in this block (/priority-lists,
    /priority-list/{plant}/{field_key}, GET /tasks), so it carries the same
    per-user plant gate. NOTE for anyone touching the client: this endpoint is
    read by Persistence.loadPriorityRankMaps, which MUST use Util.fetchTraced
    (not bare fetch) or the x-user-email header this gate reads never arrives
    and every load 403s for a plant-restricted user."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return PLANT_LISTS.get(plant, {})


@api.get("/priority-lists")
def get_priority_lists_for_plant(
        plant: str = Query(..., min_length=1),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Per-field metadata + coverage for one plant's Optimization tab (Stage 2).
    Groups the flat list_priority_lists_meta rows by field_key, splitting
    machine='' (plant-wide) from everything else (machine overrides), and
    merges in priority_list_coverage's per-machine ranked/distinct counts.

    `fields[<key>].coverage` is passed through verbatim, so it carries BOTH the
    per-machine buckets (keyed by the machine code, or '' for orders with no
    machine) and one true plant-wide roll-up keyed by db.PLANT_TOTAL_COVERAGE_KEY
    ('__plant_total__'). The plant-wide card must read that reserved key — '' is
    the no-machine bucket, NOT a plant total, and reading '' left the
    ratio blank on every plant whose orders all carry a machine. Summing the
    per-machine buckets client-side is also wrong: they are per-machine
    COUNT(DISTINCT ...), so a value used on two machines would be counted twice."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    rows, _total = db.list_priority_lists_meta(plant=plant)

    def _rekey(row: dict) -> dict:
        # db.py's rows use its own Python-facing "line" key (unchanged by
        # design) — rename it to "machine" at this JSON boundary only.
        out = {k: v for k, v in row.items() if k != "line"}
        out["machine"] = row["line"]
        return out

    coverage = db.priority_list_coverage(
        plant, {k: v["orders_column"] for k, v in md.CONFIGURABLE_PRIORITY_FIELDS.items()}
    )
    fields: dict = {}
    for key, spec in md.CONFIGURABLE_PRIORITY_FIELDS.items():
        field_rows = [r for r in rows if r["field_key"] == key]
        plant_wide_row = next((r for r in field_rows if r["line"] == ""), None)
        machine_overrides = [_rekey(r) for r in field_rows if r["line"] != ""]
        fields[key] = {
            "default_label": spec["default_label"],
            "plant_wide": _rekey(plant_wide_row) if plant_wide_row else None,
            "machine_overrides": machine_overrides,
            "coverage": coverage.get(key, {}),
        }
    return {"plant": plant, "fields": fields}


@api.post("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_priority_list(
        plant: str, field_key: str, request: Request, file: UploadFile = File(...),
        machine: str = Form(default=""), value_column: str | None = Form(default=None),
        rank_column: str | None = Form(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Generic priority-list upload (Stage 2) — one file per plant [+ optional
    machine override]. See docs/superpowers/plans/2026-08-11-priority-lists-stage-2.md
    Decisions 5-6 for the Line-column and implicit-rank rules, and Decision 9b
    for why this shares _resolve_priority_list_columns/_persist_priority_list
    with the legacy POST /color-wheel/{plant}."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    spec = md.CONFIGURABLE_PRIORITY_FIELDS.get(field_key)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")

    raw = await file.read()
    try:
        df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
    except Exception as e:
        raise HTTPException(status_code=400, detail="Could not parse the uploaded file as .xlsx") from e
    if df.empty:
        raise HTTPException(status_code=400, detail="Uploaded file has no rows")

    resolved = _resolve_priority_list_columns(
        df, plant, spec, explicit_machine=machine, explicit_value_col=value_column, explicit_rank_col=rank_column,
    )
    if resolved["status"] == "needs_mapping":
        return resolved

    # row_count is the STORED entry count (what the UI renders as "N values"),
    # not len(df) — blanks are dropped and duplicate values collapsed by
    # _resolve_priority_list_columns, so the two differ on any real file. The
    # raw file row count is still reported, separately and unambiguously named.
    file_row_count = len(df)
    row_count = len(resolved["entries"])
    user = request.headers.get("X-User", "system")
    fname = file.filename or "upload.xlsx"

    is_replace = await run_in_threadpool(
        _persist_priority_list, plant, field_key, spec, resolved["entries"],
        machine=resolved["machine"], value_col=resolved["value_col"], rank_col=resolved["rank_col"],
        filename=fname, file_row_count=file_row_count, user=user, legacy_action_names=False,
    )
    return {"status": "ok", "row_count": row_count, "file_row_count": file_row_count,
            "machine": resolved["machine"],
            "action": "replace" if is_replace else "upload", "replaced": is_replace}


@api.get("/priority-list/{plant}/{field_key}")
def get_priority_list_generic(
        plant: str, field_key: str, machine: str = Query(default=""),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Generic value/rank listing for one (plant, field_key[, machine]) — the
    Stage 2 field card's Preview data source for non-color fields (color
    keeps using GET /color-wheel/{plant} via ColorWheelViewer, unchanged)."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if field_key not in md.RANKABLE_FIELDS:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")
    row = db.get_priority_list(plant, field_key, line=machine)
    if row is None:
        raise HTTPException(status_code=404,
            detail=f"No {field_key!r} priority list uploaded for plant {plant!r}" + (f" machine {machine!r}" if machine else ""))
    entries = [
        {"value": v, "rank": (999999 if r is None else r)}
        for v, r in row["entries"].items()
    ]
    entries.sort(key=lambda e: e["rank"])
    return {
        "plant": plant, "field_key": field_key, "machine": machine, "entries": entries,
        "meta": {
            "uploaded_at": row["uploaded_at"].isoformat() if row["uploaded_at"] else None,
            "uploaded_by": row["uploaded_by"], "filename": row["filename"], "row_count": row["row_count"],
        },
    }


@api.delete("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def delete_priority_list_generic(
        plant: str, field_key: str, request: Request, machine: str = Query(default=""),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if field_key not in md.RANKABLE_FIELDS:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")
    res = db.delete_priority_list(plant, field_key, line=machine)
    if res is None:
        return {"status": "not_found"}
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "priority_list_delete", "plant": plant,
        "details": {"field_key": field_key, "machine": machine, "filename": res.get("filename") or "unknown"},
    })
    _reload_one_plant_lists(plant)
    return {"status": "ok"}


# =========================
# COLOR WHEEL ENDPOINTS (legacy-compat — now read/write priority_list rows
# with field_key='colorWheel', line='' — docs/scheduling_priority.md Stage 1
# "Storage" decision. Response shapes are UNCHANGED so ColorWheelViewer and
# the Admin Cockpit coverage panel keep working untouched. The underlying
# color_wheel table is left in place, unread from here on.)
# =========================

@api.post("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...)):
    """Upload or replace a plant-specific color wheel (persisted to the
    priority_list table). Consolidated (Decision 9b) onto the same
    _resolve_priority_list_columns/_persist_priority_list helpers
    POST /priority-list/{plant}/colorWheel uses — this route is now a thin
    back-compat wrapper for external callers that predate the generic
    endpoint; NIMBUS's own frontend uploads color the same way as every
    other field after Task 12. Preserves the historical contract: only
    `file` is accepted, a file with no resolvable COLOR column 400s
    immediately (no needs_mapping round-trip — there's no mapping UI on the
    other end of this route), and audit entries keep the historical
    color_wheel_upload/color_wheel_replace action names. Two deliberate
    loosenings, both strictly more permissive so no previously-valid file
    starts failing (Decision 9b): ORDER_Y is no longer required (row order is
    used if omitted, same as every other field, Decision 6), and this route
    never validated an empty (header-only) file — that check is intentionally
    NOT applied here (only the new generic endpoint gets it), so a 0-row file
    still succeeds with row_count 0, exactly as it always did.

    Two more preserved-behavior fixes: this route never supported machine
    scoping before this rewrite (external callers/`GET /color-wheel/{plant}`/
    `ColorWheelViewer` only ever read the plant-wide machine="" row), so it
    always persists with machine="" regardless of what
    _resolve_priority_list_columns resolved from an incidental LINE column in
    the file. And it passes reject_conflicts=False so a duplicate COLOR value
    with two different ranks resolves last-value-wins, matching the old
    _cw_df_to_entries's tolerance exactly, instead of the new 400 the generic
    endpoint deliberately introduces (Decision 6) — that stricter behavior is
    new/desired only for the generic endpoint's fresh, no-back-compat-promise
    contract.
    """
    raw = await file.read()
    spec = md.RANKABLE_FIELDS["colorWheel"]
    try:
        df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
    except Exception as e:
        _log_event("warn", "color_wheel", "Color-wheel xlsx parse failed",
                   exc=e, error_code="xlsx.parse", plant=plant, filename=file.filename)
        raise HTTPException(
            status_code=400,
            detail="Could not parse the uploaded color-wheel file — check it is a valid .xlsx with a COLOR column",
        ) from e

    resolved = _resolve_priority_list_columns(df, plant, spec, reject_conflicts=False)
    if resolved["status"] == "needs_mapping":
        raise HTTPException(status_code=400, detail="Missing required columns: ['COLOR']")

    # This route's RESPONSE `row_count` stays len(df) (raw file rows) — its
    # response shape is a pinned back-compat contract (see this class of tests
    # in tests/test_priority_lists.py, which assert the exact dict). What gets
    # PERSISTED to priority_list.row_count is len(entries), decided inside
    # _persist_priority_list so both upload routes store the same thing; the
    # two differ only for a file with blank or duplicated values, which a
    # well-formed color wheel doesn't have.
    file_row_count = len(df)
    user = request.headers.get("X-User", "system")
    fname = file.filename or "upload.xlsx"

    is_replace = await run_in_threadpool(
        _persist_priority_list, plant, "colorWheel", spec, resolved["entries"],
        machine="", value_col=resolved["value_col"], rank_col=resolved["rank_col"],
        filename=fname, file_row_count=file_row_count, user=user, legacy_action_names=True,
    )
    action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    return {"status": "ok", "row_count": file_row_count, "action": action, "replaced": is_replace}


@api.get("/color-wheel/{plant}")
def get_color_wheel(plant: str):
    """Return the stored color wheel for a plant as sorted JSON entries."""
    row = db.get_priority_list(plant, "colorWheel", line="")
    if row is None:
        raise HTTPException(status_code=404, detail=f"No color wheel uploaded for plant {plant!r}")
    # entries: {COLOR: ORDER_Y|None} -> [{color, order_y}] ascending by rank, with
    # a null/blank rank sorting last (999999), matching apply_priority_merge().
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
    res = db.delete_priority_list(plant, "colorWheel", line="")
    if res is None:
        return {"status": "not_found"}
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "color_wheel_delete", "plant": plant,
        "details": {"filename": res.get("filename") or "unknown"},
    })
    # Row already removed above — drop just this plant's cache entry.
    _reload_one_plant_lists(plant)
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
    rows, total = db.list_priority_lists_meta(field_key="colorWheel", limit=limit, offset=offset)
    # Response shape kept identical to the old color_wheel-table version: a
    # dict keyed by plant name (web/plant-and-administration.mts:270 pins this).
    plants = {
        r["plant"]: {
            "uploaded_at": r["uploaded_at"],
            "uploaded_by": r["uploaded_by"],
            "filename": r["filename"],
            "row_count": r["row_count"],
        }
        for r in rows
    }
    if limit is None and offset is None:
        return {"plants": plants}
    return {"plants": plants, "meta": {"total": total}}


# =========================
# SETUP MATRIX API — Stage 0 only: versioned observation/setup truth, never scheduling.
# =========================

@api.put("/setup/{plant}/active", dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                 Depends(require_admin)])
def set_setup_active(plant: str, request: Request, body: dict = Body(default={}),
                     allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                     actor: str = Depends(auth.require_authenticated)):
    """VESTIGIAL BUT RETAINED (Workstream D2, 2026-08-20): this used to be the
    "Include Setup Times in Optimizer" checkbox's write path. That checkbox
    now writes plants.setup_active via PUT /plant/{plant}/setup-active
    instead — no UI or optimizer gate reads setup_definition.active any
    more. Kept, unchanged, because removing it means also removing every
    caller/test of it, which was judged higher blast radius than leaving one
    unread write path in place."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, active=bool(body.get("active")))
    try:
        result = setup_data.set_definition_active(
            plant, bool(body.get("active")), actor,
            expected_signature_version=body.get("expected_signature_version"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    return _setup_freshness(result)


@api.get("/setup/{plant}", dependencies=[Depends(auth.require_authenticated)])
def get_setup(plant: str, request: Request,
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Return one authorized plant's complete setup snapshot, never a cross-plant aggregate."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        snapshot = setup_data.get_setup_snapshot(plant)
        # Workstream D2: the real "include setup times in optimizer" gate is
        # plants.setup_active, not setup_definition.active (which is
        # vestigial-but-retained — see schema.sql). Surfaced as its own
        # top-level field rather than overloading `definition.active`, so it
        # stays independently inspectable alongside machine.setup_compatible
        # and the snapshot's own plant-identity check.
        snapshot["plant_active"] = md.get_plant_setup_active(plant)
        return _setup_freshness(snapshot)
    except ValueError as exc:
        raise _setup_error(exc) from exc


@api.put("/plant/{plant}/setup-active", dependencies=[Depends(require_api_key), Depends(require_admin)])
def set_plant_setup_active_route(plant: str, request: Request, body: dict = Body(default={})):
    """Persist the plant-level "include setup times in optimizer" flag.

    Payload: { subnetwork?, active: bool }. Relocated off the per-signature-
    version setup_definition.active (see PUT /setup/{plant}/active above,
    now vestigial-but-retained) onto a durable plant-level setting, following
    the machine.setup_compatible precedent: unregistered column, dedicated
    validated endpoint. This is intentionally separate from that route and
    from machine.setup_compatible — three independent gates, never conflated."""
    active = body.get("active")
    if not isinstance(active, bool):
        raise HTTPException(status_code=400, detail="active must be boolean")
    _set_admin_log_details(request, plant=plant, active=active)
    try:
        return md.set_plant_setup_active(
            plant, active,
            subnetwork=body.get("subnetwork", ""),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _setup_coverage_payload(result: dict, *, machine: str | None = None, offset: int = 0, limit: int = 100) -> dict:
    """Keep coverage totals useful without embedding an unbounded missing-edge list."""
    payload = {"plant": result["plant"], "signature_version": result.get("definition", {}).get("signature_version")
               if result.get("definition") else None}
    for kind in ("observed", "reachable"):
        summary = result[kind]
        page = setup_data.page_missing_pairs(summary["missing"], machine=machine, offset=offset, limit=limit)
        payload[kind] = {key: value for key, value in summary.items() if key != "missing"}
        payload[kind]["missing_page"] = page
    return _setup_freshness(payload)


@api.get("/setup/{plant}/coverage", dependencies=[Depends(auth.require_authenticated)])
def get_setup_coverage(plant: str, machine: str | None = Query(default=None), offset: int = Query(default=0, ge=0),
                       limit: int = Query(default=100, ge=1, le=500),
                       allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Bounded Stage 0 transition coverage; this observes, never changes, schedules."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        return _setup_coverage_payload(setup_data.get_setup_coverage(plant), machine=machine, offset=offset, limit=limit)
    except ValueError as exc:
        raise _setup_error(exc) from exc


@api.get("/setup/{plant}/matrix-rows", dependencies=[Depends(auth.require_authenticated)])
def get_setup_matrix_rows(plant: str, machine: str = Query(default=""), from_key: str | None = Query(default=None),
                          offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Bounded, from-state-scoped page of effective matrix rows for the List view."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        # This is raw caller JSON, not yet case-folded — page_matrix_rows()
        # canonicalizes it (via setup_data.canonical_state_key, using this
        # plant's definition fields) before comparing against stored JSONB, so
        # a hand-typed "black" here still matches a stored "BLACK" key.
        parsed_from_key = json.loads(from_key) if from_key else None
        signature_version = setup_data.current_signature_version(plant)
        if signature_version is None:
            return _setup_freshness({"plant": plant, "machine": machine, "signature_version": None, "rows": [],
                                     "meta": {"total": 0, "offset": offset, "limit": limit}})
        return _setup_freshness(setup_data.page_matrix_rows(
            plant, machine, signature_version, from_key=parsed_from_key, offset=offset, limit=limit,
        ))
    except (ValueError, json.JSONDecodeError) as exc:
        raise _setup_error(exc) from exc


@api.get("/setup/{plant}/missing-pairs.csv", dependencies=[Depends(auth.require_authenticated)])
def export_setup_missing_pairs(plant: str, kind: str = Query(default="observed"), machine: str | None = Query(default=None),
                               offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500),
                               allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Export one bounded, selectable page of missing canonical long-form pairs."""
    _setup_plant_guard(plant, allowed_plants)
    if kind not in {"observed", "reachable"}:
        raise HTTPException(status_code=400, detail="kind must be observed or reachable")
    try:
        coverage = setup_data.get_setup_coverage(plant)
        page = setup_data.page_missing_pairs(coverage[kind]["missing"], machine=machine, offset=offset, limit=limit)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Plant", "Machine", "Scope", "Signature version", "From setup state", "To setup state"])
    version = coverage.get("definition", {}).get("signature_version") if coverage.get("definition") else ""
    for row in page["rows"]:
        writer.writerow([plant, row["machine"], row["scope"], version,
                         json.dumps(row["from_key"], separators=(",", ":")),
                         json.dumps(row["to_key"], separators=(",", ":"))])
    headers = {"Content-Disposition": f'attachment; filename="setup-missing-{kind}-{plant}.csv"',
               "X-Total-Count": str(page["meta"]["total"])}
    return Response(content=output.getvalue(), media_type="text/csv", headers=headers)


@api.put("/setup/{plant}/definition", dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def save_setup_definition(plant: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_authenticated)):
    """Master-data-owner write for a plant's ordered signature definition."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, field_count=len(body.get("fields", []))
                           if isinstance(body.get("fields"), list) else 0)
    try:
        result = setup_data.save_definition(
            plant, body.get("fields"), body.get("strict_blanks"), actor,
            expected_signature_version=body.get("expected_signature_version"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"])
    return _setup_freshness(result)


@api.post("/setup/{plant}/matrix/import", dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                         Depends(require_admin)])
def import_setup_matrix(plant: str, request: Request, body: dict = Body(default={}),
                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                        actor: str = Depends(auth.require_authenticated)):
    """Write canonical long-form plant rows or sparse rows for one owned machine."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine", "")
    rows = body.get("rows")
    _set_admin_log_details(request, plant=plant, machine=machine, row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        if machine:
            result = setup_data.upsert_line_matrix_rows(plant, machine, rows, body.get("signature_version"), actor)
        else:
            result = setup_data.replace_plant_matrix(plant, rows, body.get("signature_version"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], rows=result.get("rows", 0))
    return _setup_freshness(result)


@api.delete("/setup/{plant}/matrix", dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                     Depends(require_admin)])
def delete_setup_matrix_rows(plant: str, request: Request, body: dict = Body(default={}),
                             allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                             actor: str = Depends(auth.require_authenticated)):
    """Delete only selected cells; a sparse machine deletion exposes inherited plant truth."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine", "")
    rows = body.get("rows")
    # `scope` is an optional audit-only passenger field (Workstream D3): the
    # Setup Matrix admin UI's per-row/bulk/delete-all actions send 'row' /
    # 'bulk' / 'all' respectively so an auditor can tell a single-cell delete
    # from a scope-wide wipe without a brittle row-count heuristic. The
    # pre-existing minute-clear-via-Save path sends no `scope` at all, so it
    # is logged distinctly as 'edit' rather than defaulting to 'row'.
    _set_admin_log_details(request, plant=plant, machine=machine, scope=body.get("scope") or "edit",
                           row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        if machine:
            result = setup_data.delete_line_matrix_rows(plant, machine, rows, body.get("signature_version"), actor)
        else:
            result = setup_data.delete_plant_matrix_rows(plant, rows, body.get("signature_version"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], deleted=result.get("deleted", 0))
    return _setup_freshness(result)


@api.put("/setup/{plant}/lines/{machine}/state", dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def save_setup_line_state(plant: str, machine: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_setup_scheduler)):
    """Authorized plant schedulers assert current physical state for an owned machine."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = setup_data.set_line_state(
            plant, machine, body.get("values"), body.get("signature_version"),
            _setup_observed_at(body.get("observed_at")), body.get("source"), body.get("reason"), actor,
            body.get("physical_mold_id"),
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, signature_version=result["signature_version"], accepted=result.get("accepted"))
    return _setup_freshness(result)


@api.put("/setup/{plant}/lines/{machine}/compatibility", dependencies=[Depends(require_api_key), Depends(auth.require_authenticated),
                                                                      Depends(require_admin)])
def save_setup_line_compatibility(plant: str, machine: str, request: Request, body: dict = Body(default={}),
                                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                                  actor: str = Depends(auth.require_authenticated)):
    """Admin-only setup-signature opt-out, distinct from global optimizer exclusion."""
    _setup_plant_guard(plant, allowed_plants)
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = md.set_setup_line_compatibility(plant, machine, body.get("setup_compatible"), body.get("reason"), actor)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, setup_compatible=result["setup_compatible"])
    return result


@api.get("/setup/{plant}/lines/{machine}/compatibility", dependencies=[Depends(auth.require_authenticated)])
def get_setup_line_compatibility(plant: str, machine: str,
                                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    _setup_plant_guard(plant, allowed_plants)
    try:
        result = md.get_setup_line_compatibility(plant, machine)
    except ValueError as exc:
        raise _setup_error(exc) from exc
    return result


@api.post("/setup/{plant}/overrides", dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def create_setup_override(plant: str, request: Request, body: dict = Body(default={}),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                          actor: str = Depends(auth.require_setup_scheduler)):
    """Create one occurrence-specific override; its stable resource ID is server-assigned."""
    _setup_plant_guard(plant, allowed_plants)
    if "predecessor_order_id" not in body:
        raise _setup_error(ValueError("Predecessor order id is required; use null for initial state"))
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine)
    try:
        result = setup_data.upsert_occurrence_override(
            plant, machine, body.get("predecessor_order_id"), body.get("successor_order_id"),
            body.get("predecessor_values"), body.get("successor_values"), body.get("standard_min"),
            body.get("remaining_min"), body.get("signature_version"), body.get("reason"), actor,
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], signature_version=result["signature_version"],
                           persisted_override_id=result["id"])
    return _setup_freshness(result)


@api.put("/setup/{plant}/overrides/{override_id}", dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def save_setup_override(plant: str, override_id: int, request: Request, body: dict = Body(default={}),
                        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                        actor: str = Depends(auth.require_setup_scheduler)):
    """Update the exact occurrence override identified by the URL; never rebind its adjacency."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine, override_id=override_id)
    try:
        result = setup_data.update_occurrence_override(
            plant, machine, override_id, body.get("standard_min"), body.get("remaining_min"),
            body.get("signature_version"), body.get("reason"), actor,
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], signature_version=result["signature_version"],
                           persisted_override_id=result["id"])
    return _setup_freshness(result)


@api.delete("/setup/{plant}/overrides/{override_id}", dependencies=[Depends(require_api_key), Depends(auth.require_setup_scheduler)])
def clear_setup_override(plant: str, override_id: int, request: Request, body: dict = Body(default={}),
                         allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
                         actor: str = Depends(auth.require_setup_scheduler)):
    """Clear an active occurrence override while retaining its audit reason and history."""
    _setup_plant_guard(plant, allowed_plants)
    machine = body.get("machine")
    _set_admin_log_details(request, plant=plant, machine=machine, override_id=override_id)
    try:
        result = setup_data.clear_occurrence_override(
            plant, machine, override_id, body.get("signature_version"), actor, body.get("reason")
        )
    except ValueError as exc:
        raise _setup_error(exc) from exc
    _set_admin_log_details(request, machine=result["machine"], cleared=result["cleared"],
                           signature_version=result.get("signature_version"))
    return _setup_freshness(result)


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

# NOTE: these four literal-path routes MUST be registered before the generic
# GET /master-data/{table} below — FastAPI/Starlette matches routes in
# registration order, not by specificity, so a route declared after {table}
# is permanently shadowed (a request for it just gets captured as table="...",
# then 404s inside md_list/_assert_table). _audit was previously registered
# after {table} and was completely unreachable in production as a result.
# (POST /master-data/material-plants/attributes below is NOT at this risk —
# it's a two-segment path and the default `str` path converter behind
# {table} excludes "/", so it can never be captured by {table} regardless of
# registration order. Only single-segment literals need to precede it.)
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


# ---------------------------------------------------------------------------
# Admin universal table browser (Workstream E). Deliberately separate from
# /master-data/* — read-only, catalog-driven (admin_tables.py), and NOT
# gated by master_data.ALLOWED_TABLES. Every table in `public` is
# discoverable here, including ones ALLOWED_TABLES will never register.
#
# OD-E2 (documented data-exposure decision): unlike every other admin/master-
# data route, these three do NOT call _assert_plant_allowed / scope by
# role_plants. A catalog-wide browser is cross-plant by nature — there is no
# single-plant version of "list every table" — so scoping is deliberately
# skipped and access is gated on admin role alone (require_admin), same
# posture as GET /diagnostics and GET /master-data/_schema-export. All three
# are pure reads: admin_tables.py never builds an INSERT/UPDATE/DELETE or DDL
# statement (OD-E3).
# ---------------------------------------------------------------------------
def _admin_tables_query_filters(request: Request) -> dict[str, list[str]]:
    """Filter transport: a repeated query parameter per column, e.g.
    ?material_id=A&material_id=B&plant=5512 — multi-value via repetition,
    paste-splitting is the frontend's job before it builds the query
    string. Every query param other than limit/offset is treated as a
    candidate filter column; admin_tables validates each one against the
    table's real columns (fresh per request) before it ever reaches SQL, so
    an unrecognized param name 400s rather than silently no-op'ing."""
    reserved = {"limit", "offset"}
    filters: dict[str, list[str]] = {}
    for key in request.query_params:
        if key in reserved:
            continue
        values = request.query_params.getlist(key)
        if values:
            filters[key] = values
    return filters


@api.get("/admin/tables", dependencies=[Depends(require_admin)])
def admin_list_tables():
    """Catalog listing of every table in the `public` schema, discovered
    fresh on this request (see admin_tables.list_tables — no process-level
    cache, unlike db._get_maint_table_allowlist). Response:
        { "tables": [ { table, approx_row_count, internal,
                         pk_columns: [str], fk_columns: [{column, ref_table, ref_column}] }, ... ] }
    `internal` is a flag, not a filter — schema_migrations/admin_audit/
    column_metadata/sap_sync_*/sap_field_map still appear, just marked."""
    return {"tables": admin_tables.list_tables()}


@api.get("/admin/tables/{table}", dependencies=[Depends(require_admin)])
def admin_table_rows(table: str, request: Request,
                      limit: int = Query(default=100, ge=1, le=1000),
                      offset: int = Query(default=0, ge=0)):
    """Paginated rows for one table, PK/FK-aware, filterable by any real
    column of that table (see _admin_tables_query_filters for transport).
    Response:
        { "columns": [ { name, sql_type, is_nullable, ordinal_position,
                          is_pk, is_fk, ref_table, ref_column } ],
          "rows": [ {col: value, ...}, ... ],
          "meta": { "total": int, "limit": int, "offset": int } }
    `meta.total` is the full filtered count ignoring limit/offset, mirroring
    GET /tasks' paging contract. A filter value with no matching row is not
    an error — it simply contributes nothing to `rows`."""
    filters = _admin_tables_query_filters(request)
    try:
        return admin_tables.fetch_rows(table, limit=limit, offset=offset, filters=filters)
    except admin_tables.UnknownTable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except admin_tables.UnknownColumn as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@api.get("/admin/tables/{table}/export.csv", dependencies=[Depends(require_admin)])
def admin_table_export_csv(table: str, request: Request, offset: int = Query(default=0, ge=0)):
    """Streaming CSV export of `table` (same filter transport as
    GET /admin/tables/{table}), soft-capped at admin_tables.EXPORT_ROW_CAP
    (~250k) rows. Table/filter validation happens up front, BEFORE the
    StreamingResponse is constructed, so a bad table/column name comes back
    as a normal 404/400 rather than a truncated-looking CSV body.

    If the cap is hit, the CSV stream itself carries the truncation signal
    (a response header can't work here — this is a real stream, so whether
    the cap will be hit isn't known until the body is already underway):
    the last line is `# NIMBUS_TRUNCATED,resume_offset=<N>,rows_written=<N>`.
    A client must treat any line starting with that prefix as a marker, not
    a data row, and may resume via ?offset=<resume_offset>. No trailing
    marker at all means the export was not truncated."""
    filters = _admin_tables_query_filters(request)
    try:
        admin_tables.validate_table_and_filters(table, filters)
    except admin_tables.UnknownTable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except admin_tables.UnknownColumn as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StreamingResponse(
        admin_tables.stream_csv_rows(table, filters=filters, offset=offset),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
    )


@api.get("/master-data/_material-grid")
def md_material_grid(
        plant: str = Query(..., min_length=1,
            description="Required. Materials are returned only if they have a "
                        "material_plants row at this plant."),
        limit: int | None = Query(default=None, ge=1, le=100000),
        offset: int | None = Query(default=None, ge=0),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Plant-scoped Material grid (Master Data tab). Read-only.

    `plant` is REQUIRED on purpose: an optional plant would make omitting it
    the bypass around the role_plants scope enforced inside md.material_grid
    (materials has no plant column of its own, so it isn't in
    PLANT_SCOPED_TABLES and can't be scoped by the generic /master-data/{table}
    path). A plant with zero material_plants rows returns an empty grid — that
    is the rule, not an error. Not admin-gated, same as GET /master-data/{table}.
    """
    try:
        return md.material_grid(plant, limit=limit, offset=offset, allowed_plants=allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.get("/master-data/_material-plant-grid")
def md_material_plant_grid(
        plant: str = Query(..., min_length=1,
            description="Required. Returns material_plants rows for this plant, "
                        "with material_type/material_description joined in from materials."),
        limit: int | None = Query(default=None, ge=1, le=100000),
        offset: int | None = Query(default=None, ge=0),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Plant-scoped Material Plant grid (Master Data tab). Read-only except
    prt_01/prt_02/color/default_machine, which come back with
    columns[].editable=True and are written through
    POST /master-data/material-plants/attributes."""
    try:
        return md.material_plant_grid(plant, limit=limit, offset=offset, allowed_plants=allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


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
    """List rows for a master-data table (subnetworks | plants | machine | ...).

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
        _set_admin_log_details(
            request, upsert_count=len(body.get("upserts", [])), delete_count=len(body.get("deletes", [])),
            inserted=result.get("inserted", 0), updated=result.get("updated", 0),
            deleted=result.get("deleted", 0),
        )
        # Adding/editing production lines may let orders uploaded before the line
        # existed resolve their materialized plant. Re-derive NULL-plant orders so they
        # stop being invisible to the plant-scoped read path (best-effort, non-fatal).
        if table == "machine":
            try:
                n = db.reattribute_null_plant_orders()
                if n:
                    _log_event("info", "db", "Re-attributed orders to plant after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "Plant re-attribution after line change failed", error=str(e))
            try:
                n = db.backfill_machine_keys()
                if n:
                    _log_event("info", "db", "Backfilled order machine_key after line change", count=n)
            except Exception as e:
                _log_event("warn", "db", "machine_key backfill after line change failed", error=str(e))
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


@api.post("/master-data/plants/{plant}/split-order-policy", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_split_order_policy(plant: str, request: Request, body: dict = Body(default={})):
    """Persist one validated plant-level split-order allocation policy.

    Payload: { subnetwork?, split_order_policy: never|overlong_only|partial_allowed }.
    This is intentionally separate from the nested priority constraint tree.
    """
    try:
        return md.set_plant_split_order_policy(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            policy=body.get("split_order_policy", ""),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/plants/{plant}/max-pull-forward-days", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_max_pull_forward_days(plant: str, request: Request, body: dict = Body(default={})):
    """Persist a nullable, non-negative whole-calendar-day scheduling floor."""
    try:
        return md.set_plant_max_pull_forward_days(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            value=body.get("max_pull_forward_days"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/plants/{plant}/visibility-horizon", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_visibility_horizon(plant: str, request: Request, body: dict = Body(default={})):
    """Persist the C1 plant visibility-horizon setting (how far into the future
    a planner can see on the Gantt/Orders tab).

    Payload: { subnetwork?, visibility_horizon_days: int|null, horizon_roll_hour_utc: int }.
    Both fields are saved together — see master_data.set_plant_visibility_horizon.
    """
    try:
        return md.set_plant_visibility_horizon(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            visibility_horizon_days=body.get("visibility_horizon_days"),
            horizon_roll_hour_utc=body.get("horizon_roll_hour_utc"),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/roles/{role}/page-access", dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_role_page_access(role: str, request: Request, body: dict = Body(default={})):
    """Persist a role's per-page UI-visibility toggles (Dashboard/Scheduling
    Board/Labor Plan/Master Data/Admin Cockpit).

    Payload: { pages: { home?, gantt?, labor?, masterdata?, admin?: bool } }
    UI-visibility gating only — no endpoint-level enforcement, same as the
    existing Admin Cockpit tab check this generalizes."""
    try:
        return md.set_role_page_access(
            role=role,
            pages=body.get("pages", {}),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.get("/system-settings")
def get_system_settings():
    """Return the global system-settings blob (currently just orderFields —
    which optional Orders fields show by default in the AG Grid / Inspector).
    Unauthenticated: every user's boot needs this, same as color-wheel reads.
    Response body IS the settings content directly, no wrapper envelope."""
    return md.get_system_settings()


@api.post("/system-settings", dependencies=[Depends(require_api_key), Depends(require_admin)])
def post_system_settings(request: Request, body: dict = Body(default={})):
    """Persist a shallow-merge patch into the global system-settings blob.

    Payload: { orderFields?: { <FIELD_KEY>: { grid: bool, inspector: bool } } }
    The 'orderFields' key is replaced wholesale by whatever is sent — callers
    must POST the complete map, not a per-field diff. Response body is the
    full post-merge settings blob, same unwrapped shape as the GET above."""
    try:
        return md.upsert_system_settings(body, user_email=request.headers.get("x-user-email"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/material-plants/attributes")
def md_set_material_plant_attributes(request: Request, body: dict = Body(default={}),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Update the planner-editable material_plants attributes (prt_01, prt_02,
    color, default_machine) for one plant. Deliberately NOT admin-gated —
    this is the Master Data tab's Material Plant grid save, and planners (not
    just admins) are its users. The write surface is a hard server-side
    allowlist (md.EDITABLE_MATERIAL_PLANT_ATTRS); keys, status_pl,
    default_production_version and the lot sizes are unreachable from here
    regardless of what the client sends. Rows must already exist — this never
    inserts.

    Payload: { plant: str, updates: [{ material_id, prt_01?, prt_02?, color?, default_machine? }] }
    """
    plant = (body.get("plant") or "").strip()
    rows = body.get("updates") or []
    # Set BEFORE the call so the rejected/failure paths carry the target too —
    # this route has no path params, so _admin_route_details' path-param
    # harvest can't supply it on its own.
    _set_admin_log_details(request, plant=plant, row_count=len(rows) if isinstance(rows, list) else 0)
    try:
        result = md.set_material_plant_attributes(
            plant=plant, updates=rows, allowed_plants=allowed_plants,
            user_email=request.headers.get("x-user-email"))
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    _set_admin_log_details(request, updated=result.get("updated", 0),
                           columns=",".join(result.get("columns", [])))
    return result


@api.post("/master-data/resync-order-attributes", dependencies=[Depends(require_api_key), Depends(require_admin)])
def resync_order_attributes(
        request: Request, body: dict = Body(default={}),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Re-stamp one plant's orders.{color,prt_01,prt_02,production_version} from
    material_plants NOW, via seam 2 (db._stamp_order_attributes). This is the
    REAL mechanism — the batch-scoped ingest-time stamp is convenience only
    (R3 in docs/scheduling_priority.md, the inverse-ledger-trap risk). Call
    this after adding/fixing material_plants rows for a plant so its orders
    pick up the new values without waiting for a re-upload.

    WARNING: this bumps orders.xmin for every matched row, which IS the
    optimistic-concurrency base_version (db.py ROW_VERSION). Any planner's
    unsaved edit to an affected order is discarded on their next save
    (last-writer-loses reconciliation, R2) — run this at a quiet moment, not
    mid-shift. Admin-gated AND role_plants-scoped (_assert_plant_allowed below)
    for exactly that reason.

    Payload: { plant: str }
    Response: { status, plant, unmatched_pairs, unmatched_orders, exceptions }
    (same exception shape as GET /upload/{batch_id}/missing-master-data — a
    resync has no batch_id, so its unmatched pairs are returned here directly
    rather than persisted to upload_audit.)
    """
    plant = (body.get("plant") or "").strip()
    if not plant:
        raise HTTPException(status_code=400, detail="plant is required")

    # require_admin alone is NOT enough here: it proves the caller is an admin,
    # not that this plant is inside their role_plants scope. This route runs a
    # real UPDATE orders, which bumps orders.xmin (= base_version) and so
    # discards every planner's unsaved edit on the affected rows — a
    # plant-restricted admin must not be able to do that to a plant they aren't
    # assigned, whether from the Stage 2 "Resync Now" button or by hand-crafting
    # the request. `plant` arrives in the JSON body here (not a path param), so
    # the check runs after the body is unpacked, but is otherwise the same
    # choke point every other plant-scoped route in this family uses.
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # Note: this writes orders.* columns only — it never touches priority_list,
    # so no PLANT_LISTS cache refresh is needed (unlike the /color-wheel/*
    # upload path, which writes priority_list rows directly).
    result = db.resync_order_attributes(plant)
    _set_admin_log_details(request, plant=plant,
                           unmatched_pairs=result["unmatched_pairs"],
                           unmatched_orders=result["unmatched_orders"])
    _log_event("info", "master_data", "Order attributes resynced from material_plants",
               plant=plant, unmatched_pairs=result["unmatched_pairs"],
               unmatched_orders=result["unmatched_orders"])
    return {
        "status": "ok",
        "plant": plant,
        "unmatched_pairs": result["unmatched_pairs"],
        "unmatched_orders": result["unmatched_orders"],
        "exceptions": result["exceptions"],
    }


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
    """Upsert or delete aggregate labor-plan cells. Payload: { subnetwork, plant, cells:[{wc_group, period, avail_hours}] }"""
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
    return md.load_labor_plan_machine(plant, group=group, from_date=from_date, to_date=to_date)


@api.post("/labor-plan/line")
def labor_plan_line_post(request: Request, body: dict = Body(default={})):
    """Upsert or delete line-level labor cells. Payload: { subnetwork, plant, cells:[{machine, day, avail_hours, source}] }"""
    try:
        return md.upsert_labor_plan_machine(
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
      machine_blackouts:[{id, machine, start, end, reason}], plant_blackouts:[...] }."""
    if not plant:
        raise HTTPException(status_code=400, detail="plant query param is required")
    try:
        result = md.load_plant_calendar(plant)
        for block in result.get("machine_blackouts") or []:
            if "line" in block:
                block["machine"] = block.pop("line")
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/plant-hours", dependencies=[Depends(require_admin)])
def plant_calendar_plant_hours_post(request: Request, body: dict = Body(default={})):
    """Set a plant's weekly working hours. Payload: { plant, work_hours:{0..6:[h1,h2]|null} }."""
    try:
        result = md.set_plant_work_hours(
            plant=body.get("plant", ""),
            work_hours=body.get("work_hours") or {},
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(request, plant=body.get("plant", ""), days_configured=len(body.get("work_hours") or {}))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/line-hours", dependencies=[Depends(require_admin)])
def plant_calendar_line_hours_post(request: Request, body: dict = Body(default={})):
    """Upsert per-line working hours (batched). Payload:
    { plant, lines:[{machine, work_hours:{0..6:[h1,h2]|null}}] }."""
    try:
        result = md.set_line_work_hours(
            plant=body.get("plant", ""),
            lines=body.get("lines", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(request, plant=body.get("plant", ""), line_count=len(body.get("lines", [])))
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/line-blackouts", dependencies=[Depends(require_admin)])
def plant_calendar_line_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of line blackouts. Payload:
    { plant, upserts:[{id, line?, start, end, reason?}], deletes?:[id] }.
    line omitted/null = all lines in this plant."""
    try:
        result = md.save_machine_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, plant=body.get("plant", ""), upsert_count=len(body.get("upserts", [])),
            delete_count=len(body.get("deletes", [])),
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/plant-calendar/plant-blackouts", dependencies=[Depends(require_admin)])
def plant_calendar_plant_blackouts_post(request: Request, body: dict = Body(default={})):
    """Delta write of plant-level blackouts. Payload:
    { plant, upserts:[{id, start, end, reason?}], deletes?:[id] }."""
    try:
        result = md.save_plant_blackouts(
            plant=body.get("plant", ""),
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email"),
        )
        _set_admin_log_details(
            request, plant=body.get("plant", ""), upsert_count=len(body.get("upserts", [])),
            delete_count=len(body.get("deletes", [])),
        )
        return result
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
                     q: str | None = None, offset: int = 0,
                     rid: str | None = None, outcome: str | None = None,
                     event: str | None = None):
    """
    Return recent backend events from the in-memory ring buffer, newest first.

    Filters (all optional, AND-combined, applied before paging):
      ?level=     info|warn|error (legacy; "all" = no filter)
      ?category=  exact category match
      ?since=     ISO-8601 — only entries with ts >= since
      ?q=         free-text, case-insensitive, matched against msg+category+ctx
      ?rid=       exact request ID correlation match
      ?outcome=   exact terminal outcome (success|rejected|failure)
      ?event=     exact structured event name (for example, orders.upload)
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
    if rid:
        entries = [e for e in entries if e.get("rid") == rid]
    if outcome:
        entries = [e for e in entries if e.get("outcome") == outcome]
    if event:
        entries = [e for e in entries if e.get("event") == event]
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
