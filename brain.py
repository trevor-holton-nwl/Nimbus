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
owned by backend/priority_lists/cache.py; POST /reload refreshes that cache. There
is no more global fallback wheel — COLOR_FILE/GLOBAL_CW are retired.

P5 (docs/architecture/domain-refactor-plan.md) reorganized this file from
~4,074 lines holding all 103 routes down to this thin app-assembly file: app
construction, middleware, exception handlers, lifespan bootstrap,
`include_router` calls for the nine domain routers, and the StaticFiles mount
(kept last). Routes themselves now live in `backend/<domain>/routes.py`; four
whole modules moved to `backend/`: `auth.py` -> `backend/security/auth.py`,
`setup_data.py` -> `backend/setup/data.py`, `admin_tables.py` ->
`backend/master_data/browser.py`, `sap_sync.py` -> `backend/integration/sap_sync.py`.
`db.py` and `master_data.py` are UNCHANGED and stay at repo root — every
router imports them exactly as this file always did. A handful of names below
are imported purely so `brain.<name>` keeps resolving for existing tests that
reach into backend internals directly (see the "Backward-compat re-exports"
section) — the real owner of each is the module it's imported from.
"""
import json
import logging
import os
import re
import sys
import time
import uuid
import pandas as pd
import psycopg
from fastapi import FastAPI, HTTPException, Request  # noqa: F401 — HTTPException: back-compat, see below
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import db
import master_data as md
import backend.integration.sap_staging as sap_staging
import backend.integration.sap_sync as sap_sync
import backend.security.auth as auth
import backend.setup.data as setup_data  # noqa: F401 — back-compat (brain.setup_data), see below
from backend.priority_lists.audit_log import COLOR_WHEEL_DIR, _migrate_audit_log
from backend.security.auth import require_admin, require_api_key  # noqa: F401 — back-compat, see below

# The event-log ring buffer + structured _log_event/_log_admin_action helpers,
# the per-request-id contextvar, and the DIAGNOSTICS load-metadata bag are all
# module state extracted in P5 to backend/admin_ops/ (see that package's
# logbuffer.py / diagnostics_state.py docstrings for why). brain.py imports
# them directly here because its own middleware/lifespan/exception handlers
# use them, same as before the split.
from backend.admin_ops.diagnostics_state import DIAGNOSTICS
from backend.admin_ops.logbuffer import _BACKEND_LOG, _log_admin_action, _log_event, _RID_CTX  # noqa: F401 — _BACKEND_LOG: back-compat, see below
from backend.priority_lists import cache as plcache

# Nine domain-scoped routers (docs/architecture/domain-refactor-plan.md §4).
# Safe to import here, ahead of `api = FastAPI(...)` below — none of them (or
# anything they import) ever imports `brain`, so there is no ordering hazard;
# `api.include_router(...)` for each happens later, once `api` exists.
import backend.admin_ops.routes as admin_ops_routes
import backend.calendars.routes as calendars_routes
import backend.distribution.routes as distribution_routes
import backend.integration.routes as integration_routes
import backend.labor.routes as labor_routes
import backend.master_data.routes as master_data_routes
import backend.priority_lists.routes as priority_lists_routes
import backend.routing.routes as routing_routes
import backend.scheduling.routes as scheduling_routes
import backend.security.routes as security_routes
import backend.setup.routes as setup_routes


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
            "ts":    getattr(record, "evt_ts", None) or pd.Timestamp.now('UTC').isoformat(),
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


# =========================
# COLOR WHEEL STORAGE — PLANT-SPECIFIC FILES
# =============================================================================
# Per-plant color wheels are uploaded through the Plant tab UI and stored in
# COLOR_WHEEL_DIR (now owned by backend/priority_lists/audit_log.py — see that
# module's docstring; imported above). The disk->DB one-time backfill below is
# lifespan-only legacy machinery kept here rather than in a domain routes.py
# because no route calls it — only NIMBUS_CW_BACKFILL-gated startup does.
#
# ► IF YOU MOVE THIS APP TO A NEW MACHINE, change COLOR_WHEEL_DIR (in
#   backend/priority_lists/audit_log.py) to any folder you have read/write
#   access to. The folder is created automatically on startup if it does not
#   already exist. Nothing else needs to change.
# =============================================================================

# Opt-in one-time migration of legacy on-disk color_wheel_<SAFE>.xlsx files into
# the color_wheel table at startup (only when the table is empty). OFF by default
# so running the app locally against a REMOTE DB never silently pushes local dev
# wheels into it — enable deliberately (NIMBUS_CW_BACKFILL=1) on the box that
# holds the authoritative files. A no-op in the container regardless (its /data
# is ephemeral and empty on boot).
CW_BACKFILL_FROM_DISK = os.getenv("NIMBUS_CW_BACKFILL", "").strip().lower() in ("1", "true", "yes")

# Directory holding the frontend served by the StaticFiles mount at the bottom of
# this file. Defaults to the "frontend" directory next to this file — not the process's
# current working directory — so `uvicorn brain:api` always serves the dedicated
# frontend tree (never brain.py/db.py/schema.sql alongside it) regardless of where
# it's launched from. NIMBUS_STATIC_DIR can still override this for the container.
STATIC_DIR = os.getenv("NIMBUS_STATIC_DIR") or str(Path(__file__).resolve().parent / "frontend")


def _cw_safe_name(plant: str) -> str:
    """Sanitize a plant code to a safe filename component (uppercase alphanumeric
    + underscore). Kept only for the legacy-compat /color-wheel/* file-era disk
    helpers below — the live lookup path uses the RAW plant name instead (see
    backend/priority_lists/cache.py's PLANT_LISTS comment)."""
    return re.sub(r'[^\w]', '_', plant.strip().upper())


def _cw_df_to_entries(cw_df) -> dict:
    """Turn a cleaned color-wheel DataFrame into a JSONB-safe {COLOR: ORDER_Y}
    map: colors upper/stripped, ranks coerced to native float (blank/NaN -> None
    so the JSON is valid and reads back as last-priority 999999). Used only by
    the one-time disk->DB backfill below."""
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


# =========================
# LIFESPAN
# =========================
async def _run_sap_job(object_key: str) -> None:
    """APScheduler job body for one SAP object. Offloads the blocking sync to the
    threadpool (sap_sync.sync_object is sync + does DB I/O) so the event loop is
    never stalled, and logs the outcome. Never raises — a failed sync is logged,
    not allowed to crash the scheduler thread."""
    from fastapi.concurrency import run_in_threadpool
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


async def _run_sap_staging_poll() -> None:
    """APScheduler job body for the SAP staging poll (expire stale loading -> validate ready
    batches -> auto-apply objects in auto mode -> sweeps). `poll_once` is blocking and never
    raises; it is offloaded to the threadpool so the event loop is never stalled. This wrapper
    also never raises."""
    from fastapi.concurrency import run_in_threadpool
    try:
        result = await run_in_threadpool(sap_staging.poll_once, actor="sap-staging-poll")
        errors = result.get("errors") or []
        _log_event("error" if errors else "info", "sap_staging", "Scheduled staging poll finished",
                   processed=len(result.get("processed") or []), applied=len(result.get("applied") or []),
                   held=len(result.get("held") or []), skipped=len(result.get("skipped") or []),
                   errors=len(errors),
                   error_samples=[str(e_)[:300] for e_ in errors[:5]])
    except Exception as e:
        _log_event("error", "sap_staging", "Scheduled staging poll raised", exc=e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(COLOR_WHEEL_DIR, exist_ok=True)
    _migrate_audit_log()
    db.ensure_color_wheel_table()
    db.ensure_priority_list_table()
    db.ensure_order_schedule_segments_table()
    db.ensure_order_distribution_tables()
    if CW_BACKFILL_FROM_DISK:
        _backfill_color_wheels_from_disk()
    plcache.load_priority_lists()
    md.ensure_labor_plan_table()
    md.ensure_labor_plan_machine_table()
    md.ensure_plant_constraints_column()
    md.ensure_plant_split_order_policy_column()
    md.ensure_plant_max_pull_forward_days_column()
    md.ensure_plant_max_push_forward_days_column()
    md.ensure_plant_min_productive_segment_minutes_column()
    md.ensure_plant_visibility_horizon_columns()
    md.ensure_plant_frozen_horizon_column()
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
               plants_with_lists=len(plcache.PLANT_LISTS))
    # Stateless backend: orders are NOT loaded into memory at startup — every
    # /tasks request queries Postgres with a plant/line scope. This is what lets
    # the app run as multiple workers/replicas. We just probe the DB so startup
    # surfaces a connection problem early and logs the current row count.
    DIAGNOSTICS["loaded_at"] = pd.Timestamp.now('UTC').isoformat()
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
    # The scheduler object also exists when only the staging poll is on
    # (NIMBUS_SAP_STAGING_POLL_SECONDS > 0); the per-object cron jobs stay under SAP_SYNC_ENABLED.
    if SAP_SYNC_ENABLED or SAP_STAGING_POLL_SECONDS > 0:
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
            from apscheduler.triggers.cron import CronTrigger
            from apscheduler.triggers.interval import IntervalTrigger
            scheduler = AsyncIOScheduler()
            jobs = sap_sync.list_enabled_jobs() if SAP_SYNC_ENABLED else []
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
            if SAP_STAGING_POLL_SECONDS > 0:
                scheduler.add_job(
                    _run_sap_staging_poll,
                    IntervalTrigger(seconds=SAP_STAGING_POLL_SECONDS),
                    id="sap:staging-poll",
                    max_instances=1,
                    coalesce=True,
                    replace_existing=True,
                )
            scheduler.start()
            app.state.sap_scheduler = scheduler
            if SAP_SYNC_ENABLED:
                _log_event("info", "sap_sync", "SAP sync scheduler started", jobs=len(jobs))
            else:
                _log_event("info", "sap_sync", "SAP sync scheduler disabled (NIMBUS_SAP_SYNC_ENABLED not set)")
            if SAP_STAGING_POLL_SECONDS > 0:
                _log_event("info", "sap_staging", "SAP staging poll started",
                           interval_seconds=SAP_STAGING_POLL_SECONDS)
        except Exception as e:
            _log_event("error", "sap_sync", "SAP scheduler failed to start", exc=e)
    else:
        _log_event("info", "sap_sync", "SAP sync scheduler disabled (NIMBUS_SAP_SYNC_ENABLED not set)")
    if SAP_STAGING_POLL_SECONDS <= 0:
        _log_event("info", "sap_staging", "SAP staging poll disabled (NIMBUS_SAP_STAGING_POLL_SECONDS not set)")

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

# Master kill-switch for the SAP background sync scheduler. DISABLED by default —
# the SAP interface endpoints (config/mappings/test/manual-sync) always work, but
# NO cron jobs fire unless this is explicitly turned on. This is the non-live
# skeleton stance: connectors are stubs and nothing reaches out on a timer until
# an operator opts in. Honored once at startup in the lifespan below.
SAP_SYNC_ENABLED = os.getenv("NIMBUS_SAP_SYNC_ENABLED", "0") in ("1", "true", "True")

# SAP staging (Mulesoft -> sap_stage_* tables) poll interval in seconds; 0 (default) = no
# poll job. Independent of SAP_SYNC_ENABLED. Two more knobs are read inside
# backend/integration/sap_staging.py, not here:
#   NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN (default 120) -- a batch left in `loading` longer is rejected as stale;
#   NIMBUS_SAP_SYSTEM_TZ (IANA name, default UTC) -- the zone SAP's dates/times are expressed in.
SAP_STAGING_POLL_SECONDS = sap_staging.env_int("NIMBUS_SAP_STAGING_POLL_SECONDS", 0, 0)


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


# GET /setup/{plant} and GET /master-data/{table} are bare 2-path-segment API
# routes with an unconstrained string parameter, registered (like every API
# route) before the StaticFiles mount. The frontend domain reorganization
# (Phase P1) put real static files directly inside frontend/setup/ and
# frontend/master-data/ (e.g. frontend/setup/setup-domain.mjs,
# frontend/master-data/admin-tables.mjs) — a request for one of those has the same
# 2-segment shape, so Starlette's router matches it against the API route
# first (plant="setup-domain.mjs" / table="admin-tables.mjs") and the static
# file is never reached. A `Path(..., pattern=...)` constraint on the route
# parameter can't fix this: Starlette matches the path *template* (the
# default `str` segment converter accepts anything without a slash, dots
# included) before FastAPI's Pydantic-level parameter validation ever runs,
# so a failed pattern check dispatches into a 422 from the already-matched
# route rather than falling through to try other routes or StaticFiles. This
# has to be fixed here, at the middleware layer, before routing dispatch.
#
# Scoped to exactly these prefixes — verified to be the domain folders whose
# name collides with an existing "/<segment>/{param}"-shaped API route
# ("distribution" added when GET /distribution/{plant} shadowed
# frontend/distribution/distribution-pane.mjs and shares-editor.mjs). Do not
# generalize this to "any static file anywhere," which would be needless
# surface area.
#
# Also scoped to EXACTLY 2 path segments (the prefix segment + one more) —
# matching the bug as it's actually shaped. brain.py has real, shipped
# 3+-segment routes under these prefixes whose own final segment contains a
# dot, e.g. GET /setup/{plant}/missing-pairs.csv — those must keep falling
# through to call_next() unconditionally, since no static file collides with
# them and treating them like the 2-segment case would 404 a real endpoint
# that should reach its auth-gated handler instead.
#
# A real plant code (Config.KNOWN_PLANTS, e.g. "5512") or table name
# (master_data.ALLOWED_TABLES, snake_case) never contains a ".", so "does the
# second segment contain a dot" cleanly distinguishes a filename from a route
# parameter at that depth. When it does look like a filename, this middleware
# owns the response outright — serving the file if it exists, or a bare 404
# if it doesn't — rather than falling through to call_next(): falling through
# would still hit the same colliding 2-segment API route (Starlette matches
# on path shape, not on whether the segment looks like a filename), producing
# a misleading 401/422 from get_setup()/md_list() instead of a plain 404.
#
# Must run *before* (i.e. inside/downstream of) static_mjs_no_cache_mw below
# so a .mjs file served here still gets stamped no-cache by that middleware —
# Starlette's `@api.middleware("http")` stack nests in reverse declaration
# order (the last-declared middleware ends up outermost), so declaring this
# one first, above static_mjs_no_cache_mw, makes it the inner of the two.
_DOMAIN_STATIC_PREFIXES = ("setup", "master-data", "distribution")


@api.middleware("http")
async def domain_static_asset_mw(request: Request, call_next):
    path = request.url.path
    segments = path.strip("/").split("/")
    if len(segments) == 2 and segments[0] in _DOMAIN_STATIC_PREFIXES and "." in segments[1]:
        static_root = Path(STATIC_DIR).resolve()
        candidate = (static_root / segments[0] / segments[1]).resolve()
        if candidate.is_relative_to(static_root) and candidate.is_file():
            media_type = "text/javascript" if candidate.suffix == ".mjs" else None
            return FileResponse(candidate, media_type=media_type)
        return Response(status_code=404)
    return await call_next(request)


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


# Content-Security-Policy, REPORT-ONLY (#28): nothing is blocked; violations are
# POSTed to /logs/csp-report and land in the backend log ring. The static inline
# on*= handlers (~105) and the document.write bootstrap in index.html WILL report
# (script-src deliberately omits 'unsafe-inline') -- that report stream is the
# work list for eventually enforcing. Origins are the exact CDNs index.html pins
# (unpkg: vis-timeline, jsdelivr: ag-grid + flatpickr, Google Fonts CSS/fonts).
# HTML responses only; JSON/static assets get no header. See frontend/shell/CLAUDE.md.
_CSP_REPORT_ONLY = "; ".join((
    "default-src 'self'",
    "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "report-uri /logs/csp-report",
))


@api.middleware("http")
async def csp_report_only_mw(request: Request, call_next):
    response = await call_next(request)
    if response.headers.get("content-type", "").lower().startswith("text/html"):
        response.headers["Content-Security-Policy-Report-Only"] = _CSP_REPORT_ONLY
    return response


# Future domain phases (P6) place a CLAUDE.md inside each frontend/<domain>/ folder
# so Claude Code's ancestor-directory doc auto-load picks it up while editing
# that domain's source. Those files must never be reachable through the public
# StaticFiles mount on the live Azure pilot — this is a security boundary, so
# it short-circuits before call_next/routing rather than just adjusting
# headers on the way out.
@api.middleware("http")
async def block_markdown_mw(request: Request, call_next):
    if request.url.path.endswith(".md"):
        return Response(status_code=404)
    return await call_next(request)


# Overall request-body cap for the two free-form sinks (/logs/frontend is
# unauthenticated by design). Starlette buffers a whole body before the route
# runs, so the cap has to be enforced here on Content-Length; a chunked body
# with no declared length is refused rather than buffered unbounded.
# /logs/frontend: 1 MB (a 50-entry batch with 8 KB stacks legitimately exceeds 256 KB);
# /logs/csp-report: unauthenticated, so tiny (reports are ~1 KB; the route reads <= 8 KB).
_BODY_CAPS = {("POST", "/logs/frontend"): 1024 * 1024, ("POST", "/audit/log"): 64 * 1024,
              ("POST", "/logs/csp-report"): 16 * 1024}


@api.middleware("http")
async def body_size_cap_mw(request: Request, call_next):
    cap = _BODY_CAPS.get((request.method, request.url.path))
    if cap is not None:
        declared = request.headers.get("content-length")
        if declared is None or not declared.isdigit():
            return Response(status_code=411)
        if int(declared) > cap:
            return Response(status_code=413)
    return await call_next(request)


# Error semantics: surface real HTTP status codes behind ONE consistent JSON
# envelope — {status:"error", message, detail} — instead of the legacy
# `200 + {status:"error"}` AND instead of FastAPI's default {"detail": ...}.
# Unifying the shape means every frontend callsite that reads body.message /
# body.status works the same for every error, whatever its origin.
def _error_response(status_code: int, message: str, rid: str | None,
                    extra_headers: dict | None = None, detail=None) -> JSONResponse:
    headers = dict(extra_headers or {})
    if rid:
        headers["x-request-id"] = rid
    # D10: `detail` can carry non-JSON-native values (e.g. backend/distribution's
    # `_distribution_conflict` puts a raw `datetime` in `detail.children[*].scheduled_start`)
    # -- a plain JSONResponse can't serialize those, so every such error degraded
    # into an unhandled 500 instead of the real status code. jsonable_encoder
    # recursively converts datetimes/Decimals/etc. to JSON-native types first.
    content = jsonable_encoder({
        "status": "error", "message": message, "detail": message if detail is None else detail,
    })
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers=headers or None,
    )


@api.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Covers fastapi.HTTPException too (subclass). Re-shapes {"detail":…} into
    # our envelope while preserving status code + any exception headers.
    #
    # A structured `detail={"code": ..., "message": ...}` (backend/setup and
    # backend/distribution's routes both raise these, e.g. `_distribution_error`/
    # `_distribution_conflict`) used to collapse to the bare literal string
    # "error" here, silently discarding the whole object -- a real,
    # previously-unnoticed bug: aggregate_to_detail.md SS6 documents the
    # frontend keying UI copy off `detail.code`, which never reached the
    # client. Fixed by passing a dict `detail` through unchanged and
    # synthesizing `message` from its own `message`/`code`; a plain string
    # detail (the overwhelming majority of routes) is completely unaffected
    # -- `message` and `detail` are still the identical string, as before.
    rid = request.headers.get("x-request-id")
    if isinstance(exc.detail, str):
        msg, detail = exc.detail, exc.detail
    elif isinstance(exc.detail, dict):
        msg = str(exc.detail.get("message") or exc.detail.get("code") or "error")
        detail = exc.detail
    else:
        msg, detail = "error", "error"
    return _error_response(exc.status_code, msg, rid, getattr(exc, "headers", None), detail=detail)


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
    "/master-data/plants/{plant}/max-push-forward-days": "plant.max_push_forward_days_update",
    "/master-data/plants/{plant}/min-productive-segment-minutes": "plant.min_productive_segment_minutes_update",
    "/master-data/plants/{plant}/visibility-horizon": "plant.visibility_horizon_update",
    "/master-data/plants/{plant}/frozen-horizon-days": "plant.frozen_horizon_update",
    "/master-data/plants/{plant}/unknown-setup-policy": "plant.unknown_setup_policy_update",
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
    "/sap/staging/batches/{batch_id}/validate": "sap.staging_validate",
    "/sap/staging/batches/{batch_id}/apply": "sap.staging_apply",
    "/sap/staging/batches/{batch_id}/discard": "sap.staging_discard",
    "/sap/staging/poll": "sap.staging_poll",
    "/sap/staging/upload/{object}": "sap.staging_upload",
    "/sap/staging/archive/{archive_id}/restore": "sap.staging_restore",
    "/sap/staging/send/{plant}": "sap.send_to_sap",
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
    "/distribution/{plant}/workcenters/{wc}": "distribution.workcenter_write",
    "/distribution/{plant}/{order}/{material}/shares": "distribution.shares_write",
    "/distribution/{plant}/review": "distribution.review_write",
    "/distribution/{plant}/reset": "distribution.reset_write",
    "/distribution/{plant}/reapply-defaults": "distribution.reapply_defaults",
    "/distribution/{plant}/resolve": "distribution.resolve_write",
    "/routing/upload/production-versions": "routing.upload_production_versions",
    "/routing/upload/operations": "routing.upload_operations",
    "/routing/{plant}/recompute": "routing.recompute",
    "/master-data/{table}/delete-filtered": "master_data.delete_filtered",
    "/maintenance/vacuum-analyze": "maintenance.vacuum_analyze",
    "/maintenance/analyze": "maintenance.analyze",
}

_ADMIN_TARGET_PARAMS = frozenset({"plant", "machine", "override_id", "table", "column", "object", "username", "batch_id", "archive_id"})


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


# =========================
# ROUTERS — ten domain-scoped routers (nine from docs/architecture/domain-refactor-plan.md
# §4, plus backend/distribution/ added 2026-09-17 per aggregate_to_detail.md; imported at
# the top of this file — the module objects are already bound here)
# =========================
api.include_router(scheduling_routes.router)
api.include_router(integration_routes.router)
api.include_router(priority_lists_routes.router)
api.include_router(setup_routes.router)
api.include_router(distribution_routes.router)
api.include_router(routing_routes.router)
api.include_router(master_data_routes.router)
api.include_router(security_routes.router)
api.include_router(labor_routes.router)
api.include_router(calendars_routes.router)
api.include_router(admin_ops_routes.router)


# =========================
# Backward-compat re-exports
# =========================
# A handful of existing tests reach into `brain.<name>` directly (calling a
# moved route function as a plain Python function, unit-testing a moved
# helper, or monkeypatching moved module state) rather than only going
# through `TestClient(brain.api)`. Per the P5 brief, only the four whole-file
# moves' bare `import setup_data`/`import auth`/`import admin_tables`/
# `import sap_sync` test imports were in scope to edit — every other test
# file's `import brain` usage stays as-is, which means brain.py must keep
# resolving these names. Each import below is otherwise unused by brain.py's
# OWN logic; the real owner is named in the comment.
from backend.integration.routes import purge_orders, upload_orders  # noqa: E402,F401
from backend.priority_lists.cache import apply_priority_merge  # noqa: E402,F401
from backend.priority_lists.routes import ROW_ORDER_SENTINEL, _resolve_priority_list_columns  # noqa: E402,F401
from backend.scheduling.models import BulkUpdateResult, TaskDateUpdate, TaskDTO  # noqa: E402,F401
from backend.scheduling.routes import _apply_task_date_updates, _to_pydt  # noqa: E402,F401

# `PLANT_LISTS` is NOT re-exported as a static `PLANT_LISTS = plcache.PLANT_LISTS`
# binding here — unlike _BACKEND_LOG/DIAGNOSTICS (mutated in place, never
# rebound), backend/priority_lists/cache.py's load_priority_lists() DOES
# reassign PLANT_LISTS wholesale (`global PLANT_LISTS; PLANT_LISTS = ...`) on
# every /reload and at every app startup. A one-time `brain.PLANT_LISTS =
# plcache.PLANT_LISTS` snapshot taken at import time would go stale the
# instant lifespan/reload runs — a regression the original single-file
# brain.py could never have, since there was only ever one PLANT_LISTS
# object. Module-level `__getattr__` (PEP 562) instead resolves
# `brain.PLANT_LISTS` to whatever `plcache.PLANT_LISTS` IS at access time, on
# every access — matching the pre-split live-global behavior exactly.
def __getattr__(name: str):
    if name == "PLANT_LISTS":
        return plcache.PLANT_LISTS
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# `setup_data` as a bare module reference: brain.setup_data.<fn> calls and
# monkeypatch.setattr(brain.setup_data, ...) both resolve to the SAME module
# object as backend/setup/routes.py's and backend/integration/routes.py's own
# `import backend.setup.data as setup_data` (Python caches modules by name in
# sys.modules), so a monkeypatch made via brain.setup_data is visible to the
# real route handlers too.
_FE_MAX_MSG = admin_ops_routes._FE_MAX_MSG
_FE_MAX_STACK = admin_ops_routes._FE_MAX_STACK


# =============================================================================
# STATIC FRONTEND  (MUST stay the last route registered)
# A mount at "/" is a catch-all: every router route above is matched first, so
# /health, /tasks, /upload, /master-data/*, etc. keep working untouched.
# Everything else is served from STATIC_DIR: "/" -> index.html, plus /app.js,
# /styles.css, /nimbus-intelligence.js, /nimbus-worker.js, /locales/*.js.
# html=True serves index.html at "/" and as the SPA fallback for unknown paths.
# =============================================================================
api.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
