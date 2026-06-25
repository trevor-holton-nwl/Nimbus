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
import io
import json
import logging
import os
import re
import sys
import time
import uuid
import pandas as pd
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pydantic import BaseModel

import db
import master_data as md


# =========================
# STRUCTURED LOGGING
# =========================
# Emit one JSON object per log line to stdout so container/Azure log pipelines
# can index level/category/rid without regex-scraping. Scoped to the "nimbus"
# logger tree (propagate=False) so we don't fight uvicorn's own handlers.
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts":    pd.Timestamp.utcnow().isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg":   record.getMessage(),
        }
        for k in ("category", "ctx", "rid"):
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

# =========================
# GLOBAL DATA
# =========================
# (No in-memory order cache — see module docstring. Orders are queried per request.)
COLOR_FILE = r"C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\color_wheel.xlsx"

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
COLOR_WHEEL_DIR = r"C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\color_wheels"

# =========================
# LIFESPAN
# =========================
@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(COLOR_WHEEL_DIR, exist_ok=True)
    _migrate_audit_log()
    load_color_wheels(COLOR_FILE)
    md.ensure_labor_plan_table()
    md.ensure_labor_plan_line_table()
    md.ensure_plant_constraints_column()
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
    yield
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

# Optional shared-secret guard for destructive / DDL / maintenance routes. It is a
# NO-OP until NIMBUS_API_KEY is set in the environment, so the (login-less) frontend
# keeps working untouched in dev; set the env var AND have admin clients send the
# matching X-API-Key header to lock these routes down for a hosted deployment.
# NOTE: this is a deployment-config patch, NOT user-level auth — actor identity is
# still taken from spoofable X-User / x-user-email headers. Proper per-user auth/SSO
# with server-verified identity is the real fix (see MIGRATION.md → "User security").
NIMBUS_API_KEY = os.getenv("NIMBUS_API_KEY")


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
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:
        ms = int((time.perf_counter() - t0) * 1000)
        _req_log.exception(f"unhandled {request.method} {request.url.path} {ms}ms rid={rid}: {exc}")
        _log_event("error", "request", f"Unhandled {request.method} {request.url.path}",
                   ms=ms, rid=rid, error=str(exc))
        raise
    ms = int((time.perf_counter() - t0) * 1000)
    response.headers["x-request-id"] = rid
    if ms > 1500:
        _req_log.warning(f"slow {request.method} {request.url.path} {ms}ms rid={rid}")
        _log_event("warn", "request", f"Slow request: {request.method} {request.url.path}",
                   ms=ms, rid=rid, status=response.status_code)
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
               rid=rid, error=str(exc))
    return _error_response(400, str(exc), rid)


@api.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception):
    # request_id_mw already logged the traceback on the way out; here we just
    # return a clean JSON 500 (Starlette's default is plain text).
    rid = request.headers.get("x-request-id")
    return _error_response(500, "Internal server error", rid)

# =========================
# ENGINE
# =========================
# Global diagnostics bucket populated on every load
DIAGNOSTICS = {
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


def _log_event(level: str, category: str, msg: str, **ctx) -> None:
    """Append a structured event to the in-memory ring buffer AND emit it as a
    JSON line via the nimbus logger (for container log aggregation)."""
    entry: dict = {
        "ts":       pd.Timestamp.utcnow().isoformat(),
        "level":    level,
        "category": category,
        "msg":      msg,
    }
    if ctx:
        entry["ctx"] = {k: (v if isinstance(v, (int, float, bool, type(None))) else str(v))
                        for k, v in ctx.items()}
    _BACKEND_LOG.append(entry)
    _evt_log.log(_LOG_LEVELS.get(level, logging.INFO), msg,
                 extra={"category": category, "ctx": entry.get("ctx")})


def _warn(level, msg, **ctx):
    DIAGNOSTICS["warnings"].append({
        "level": level, "msg": msg, "context": ctx,
        "ts": pd.Timestamp.utcnow().isoformat(),
    })
    _log_event(level, "load", msg, **ctx)


# =========================
# COLOR WHEEL HELPERS
# =========================
def _cw_safe_name(plant: str) -> str:
    """Sanitize a plant code to a safe filename component (uppercase alphanumeric + underscore)."""
    return re.sub(r'[^\w]', '_', plant.strip().upper())

def _cw_path(plant: str) -> str:
    return os.path.join(COLOR_WHEEL_DIR, f"color_wheel_{_cw_safe_name(plant)}.xlsx")

def _cw_meta_path() -> str:
    return os.path.join(COLOR_WHEEL_DIR, "_meta.json")

def _cw_audit_path() -> str:
    return os.path.join(COLOR_WHEEL_DIR, "_audit_log.json")

def _cw_read_meta() -> dict:
    try:
        with open(_cw_meta_path(), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _cw_write_meta(meta: dict) -> None:
    with open(_cw_meta_path(), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)

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


def _parse_color_wheel(path: str) -> dict:
    """
    Read one per-plant color-wheel .xlsx into a {COLOR: ORDER_Y} dict (colors
    upper/stripped, order coerced numeric). Shared by load_color_wheels and the
    single-plant refresh so the per-plant parse rules can't drift between them.
    """
    pdf = db.clean(pd.read_excel(path))
    if "ORDER" in pdf.columns and "ORDER_Y" not in pdf.columns:
        pdf = pdf.rename(columns={"ORDER": "ORDER_Y"})
    pdf["COLOR"] = pdf["COLOR"].astype(str).str.upper().str.strip()
    return dict(zip(pdf["COLOR"], pd.to_numeric(pdf["ORDER_Y"], errors="coerce"), strict=True))


def load_color_wheels(color_file: str = COLOR_FILE) -> None:
    """
    Populate the GLOBAL_CW / PLANT_CWS module-level cache from disk.
    Called at startup, on /reload, and after a color-wheel upload/delete.
    """
    global GLOBAL_CW, PLANT_CWS, CW_LOADED_AT

    g_cw: dict = {}
    try:
        gdf = db.clean(pd.read_excel(color_file))
        if "ORDER" in gdf.columns:
            gdf = gdf.rename(columns={"ORDER": "ORDER_Y"})
        gdf["COLOR"] = gdf["COLOR"].astype(str).str.upper().str.strip()
        g_cw = dict(zip(gdf["COLOR"], pd.to_numeric(gdf["ORDER_Y"], errors="coerce"), strict=True))
    except Exception:
        pass

    p_cws: dict = {}
    if os.path.isdir(COLOR_WHEEL_DIR):
        for fname in os.listdir(COLOR_WHEEL_DIR):
            m = re.match(r'^color_wheel_(.+)\.xlsx$', fname, re.IGNORECASE)
            if not m:
                continue
            try:
                p_cws[m.group(1).upper()] = _parse_color_wheel(os.path.join(COLOR_WHEEL_DIR, fname))
            except Exception:
                pass

    GLOBAL_CW = g_cw
    PLANT_CWS = p_cws
    CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()


def _reload_one_plant_wheel(plant: str) -> None:
    """
    Refresh the PLANT_CWS cache entry for a single plant from its own file —
    used after an upload/delete so we don't os.listdir + re-parse every wheel.
    Pops the key when the file is absent (delete path). The key derivation
    matches load_color_wheels() exactly: _cw_safe_name(plant) (which equals the
    regex capture .upper() of the on-disk color_wheel_<safe>.xlsx filename).
    """
    global PLANT_CWS, CW_LOADED_AT
    key = _cw_safe_name(plant)
    path = _cw_path(plant)
    if not os.path.isfile(path):
        PLANT_CWS.pop(key, None)
        CW_LOADED_AT = pd.Timestamp.utcnow().isoformat()
        return
    try:
        PLANT_CWS[key] = _parse_color_wheel(path)
    except Exception:
        pass
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
    # strip tzinfo — Postgres columns are TIMESTAMP WITHOUT TIME ZONE;
    # JS Date.toISOString() always emits UTC Z strings which make pd.to_datetime
    # return a tz-aware Timestamp, which psycopg3 rejects for tz-naive columns.
    return ts.to_pydatetime().replace(tzinfo=None)


# =========================
# ROUTES
# =========================
@api.get("/diagnostics")
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


@api.get("/diagnostics/deep")
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


@api.post("/reload")
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
        raise HTTPException(status_code=500, detail=f"Reload failed: {e}") from e


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
                  description="Rows to skip before returning (for paging).")):
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
    df = db.query_orders(plant=plant, line=line, limit=limit, offset=offset)
    if df is None or df.empty:
        empty_meta = {"rendered": 0, "link_count": 0, "plant_filter_active": plant,
                      "line_filter_active": line, "pre_color_merge_count": 0,
                      "raw_row_count": 0, "unique_id_count": 0,
                      "color_merge_misses": 0, "missed_colors": [],
                      "emitted_task_count": 0, "color_merge_ms": 0,
                      "total": (db.count_orders(plant=plant, line=line) if paging else 0),
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
    meta["total"] = db.count_orders(plant=plant, line=line) if paging else len(data)
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
    consumed here; blocks/calendars are persisted browser-side (localStorage)."""
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
        _log_event("error", "db", "Bulk task-date persist failed (transaction rolled back)",
                   count=len(norm), error=str(e))
        return {"applied": 0, "persisted": 0, "failed": len(norm),
                "invalid": invalid, "not_found": 0, "stale": [], "versions": {}}
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
        _log_event("error", "db", "Note persist failed", task_id=task_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Note persist failed: {e}") from e


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
    return {"status": "ok", "updated": total, "persisted": res["persisted"],
            "failed": res["failed"], "invalid": res["invalid"],
            "not_found": res.get("not_found", 0),
            "stale": stale, "versions": res.get("versions", {})}


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
    return {"status": "ok", "updated": total, "persisted": res["persisted"],
            "failed": res["failed"], "invalid": res["invalid"],
            "not_found": res.get("not_found", 0),
            "stale": stale, "versions": res.get("versions", {})}


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


# =========================
# ADMIN COCKPIT — upload, purge, audit
# =========================
@api.post("/upload", dependencies=[Depends(require_api_key)])
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
    except Exception:
        pass
    return result


@api.post("/purge", dependencies=[Depends(require_api_key)])
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


@api.get("/upload/audit")
def get_upload_audit(limit: int = 50):
    """Recent uploads, newest first, for the Admin Cockpit history card."""
    return {"audit": db.upload_audit_log(limit)}


@api.post("/upload/audit/clear")
def clear_upload_audit():
    """Delete all upload history records."""
    return db.clear_upload_audit()


# =========================
# COLOR WHEEL ENDPOINTS
# =========================

@api.post("/color-wheel/{plant}", dependencies=[Depends(require_api_key)])
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...)):
    """Upload or replace a plant-specific color wheel xlsx."""
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
        raise HTTPException(status_code=400, detail=f"Could not parse xlsx: {e}") from e

    path = _cw_path(plant)
    is_replace = os.path.isfile(path)
    row_count = len(cw_df)
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    fname = file.filename or "upload.xlsx"

    def _do_file_ops():
        with open(path, 'wb') as fh:
            fh.write(raw)
        meta = _cw_read_meta()
        meta[plant] = {
            "uploaded_at": ts, "uploaded_by": user,
            "filename": fname, "row_count": row_count,
        }
        _cw_write_meta(meta)
        _cw_append_audit({
            "ts": ts, "user": user, "action": action, "plant": plant,
            "details": {"filename": fname, "row_count": row_count, "replaced": is_replace},
        })

    await run_in_threadpool(_do_file_ops)
    # Color-merge runs per-request from the cache; refresh ONLY this plant's wheel
    # so the new wheel takes effect on the next /tasks call without re-reading
    # every plant's file (or requiring a full /reload).
    await run_in_threadpool(_reload_one_plant_wheel, plant)
    return {"status": "ok", "row_count": row_count, "action": action, "replaced": is_replace}


@api.get("/color-wheel/{plant}")
def get_color_wheel(plant: str):
    """Return the parsed color wheel for a plant as JSON entries."""
    path = _cw_path(plant)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"No color wheel uploaded for plant {plant!r}")
    try:
        cw_df = db.clean(pd.read_excel(path))
        if "ORDER" in cw_df.columns and "ORDER_Y" not in cw_df.columns:
            cw_df = cw_df.rename(columns={"ORDER": "ORDER_Y"})
        cw_df["COLOR"] = cw_df["COLOR"].astype(str).str.upper().str.strip()
        cw_df["ORDER_Y"] = pd.to_numeric(cw_df["ORDER_Y"], errors="coerce").fillna(999999)
        entries = (
            cw_df.sort_values("ORDER_Y")[["COLOR", "ORDER_Y"]]
            .rename(columns={"COLOR": "color", "ORDER_Y": "order_y"})
            .to_dict(orient="records")
        )
        meta = _cw_read_meta().get(plant, {})
        return {"plant": plant, "entries": entries, "meta": meta}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read color wheel: {e}") from e


@api.delete("/color-wheel/{plant}", dependencies=[Depends(require_api_key)])
def delete_color_wheel(plant: str, request: Request):
    """Delete a plant's uploaded color wheel file."""
    path = _cw_path(plant)
    if not os.path.isfile(path):
        return {"status": "not_found"}
    os.remove(path)
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    meta = _cw_read_meta()
    filename = meta.pop(plant, {}).get("filename", "unknown")
    _cw_write_meta(meta)
    _cw_append_audit({
        "ts": ts, "user": user, "action": "color_wheel_delete", "plant": plant,
        "details": {"filename": filename},
    })
    # File already removed above — drop just this plant's cache entry rather than
    # re-reading the whole directory.
    _reload_one_plant_wheel(plant)
    return {"status": "ok"}


@api.get("/color-wheels")
def list_color_wheels(
        limit: int | None = Query(default=None, ge=1, le=100000,
            description="Max color wheels to return. Omit for the full listing."),
        offset: int | None = Query(default=None, ge=0,
            description="Wheels to skip before returning (for paging).")):
    """List plants with uploaded color wheels and their metadata.

    Optional ?limit=/?offset= page the listing (default = full catalog). When
    supplied, meta.total carries the full count so callers can paginate."""
    meta = _cw_read_meta()
    # Cross-reference with actual files in case meta is stale after manual deletion
    if os.path.isdir(COLOR_WHEEL_DIR):
        for fname in os.listdir(COLOR_WHEEL_DIR):
            if not (fname.startswith("color_wheel_") and fname.endswith(".xlsx")):
                continue
            safe_key = fname[len("color_wheel_"):-len(".xlsx")]
            if not any(_cw_safe_name(p) == safe_key for p in meta):
                meta[safe_key] = {"uploaded_at": None, "row_count": None, "filename": fname}

    if limit is None and offset is None:
        return {"plants": meta}

    # Page a deterministic (key-sorted) slice; meta.total is the full count.
    total = len(meta)
    start = offset or 0
    items = sorted(meta.items())
    items = items[start:] if limit is None else items[start:start + int(limit)]
    return {"plants": dict(items), "meta": {"total": total}}


# =========================
# AUDIT LOG ENDPOINTS
# =========================

@api.get("/audit/log")
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


@api.post("/audit/log/clear")
def clear_audit_log():
    """Wipe the full audit log."""
    try:
        open(_cw_audit_path(), 'w', encoding='utf-8').close()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not clear audit log: {e}") from e


# =============================================================================
# MASTER DATA — Subnetwork / Plant / Production Line management
# =============================================================================

@api.get("/master-data/{table}")
def md_list(table: str,
            limit: int | None = Query(default=None, ge=1, le=100000,
                description="Max rows to return. Omit for the full table."),
            offset: int | None = Query(default=None, ge=0,
                description="Rows to skip before returning (for paging)."),
            plant: str | None = Query(default=None,
                description="Filter to one plant (only honored for tables with a plant column).")):
    """List rows for a master-data table (subnetworks | plants | production_lines | ...).

    Optional ?limit=/?offset=/?plant= scope the result server-side; all default
    to the full-catalog behavior. When supplied, meta.total carries the full
    filtered row count for paging."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    return md.list_rows(table, limit=limit, offset=offset, plant=plant)


@api.post("/master-data/{table}/cascade-preview")
def md_cascade_preview(table: str, body: dict = Body(default={})):
    """Preview cascading deletes before committing. Payload: { deletes: key[] }"""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    return md.cascade_preview(table, body.get("deletes", []))


@api.post("/master-data/{table}/bulk", dependencies=[Depends(require_api_key)])
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
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.post("/master-data/{table}/columns", dependencies=[Depends(require_api_key)])
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


@api.delete("/master-data/{table}/columns/{column}", dependencies=[Depends(require_api_key)])
def md_drop_column(table: str, column: str, request: Request):
    """Drop a user-defined column from a master-data table (system columns are protected)."""
    if table not in md.ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table!r}")
    try:
        return md.drop_column(table, column, user_email=request.headers.get("x-user-email"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@api.patch("/master-data/{table}/columns/{column}", dependencies=[Depends(require_api_key)])
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


@api.get("/master-data/_audit")
def md_audit(limit: int = 100):
    """Return the most recent N master-data change audit entries."""
    return {"entries": md.list_audit(limit)}


@api.post("/master-data/plants/{plant}/constraints", dependencies=[Depends(require_api_key)])
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
# DB DIAGNOSTICS — comprehensive backend health for Admin Cockpit
# =============================================================================

@api.get("/diagnostics/db")
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

@api.post("/maintenance/vacuum-analyze", dependencies=[Depends(require_api_key)])
def maintenance_vacuum_analyze(body: dict = Body(default={})):
    table = body.get("table") or None
    _log_event("info", "maintenance", f"VACUUM ANALYZE {table if table else 'all tables'}")
    try:
        result = db.run_vacuum_analyze(table)
        return {"ok": True, **result}
    except Exception as e:
        _log_event("error", "maintenance", f"VACUUM ANALYZE failed: {e}")
        return {"ok": False, "error": str(e)}


@api.post("/maintenance/analyze", dependencies=[Depends(require_api_key)])
def maintenance_analyze(body: dict = Body(default={})):
    table = body.get("table")
    if not table:
        return {"ok": False, "error": "table is required"}
    _log_event("info", "maintenance", f"ANALYZE {table}")
    try:
        return {"ok": True, **db.run_analyze(table)}
    except Exception as e:
        _log_event("error", "maintenance", f"ANALYZE {table} failed: {e}")
        return {"ok": False, "error": str(e)}


# =============================================================================
# BACKEND EVENT LOG — in-memory ring buffer, surfaced in Admin Cockpit
# =============================================================================

@api.get("/logs/backend")
def get_backend_logs(level: str | None = None, limit: int = 200):
    """
    Return recent backend events from the in-memory ring buffer, newest first.
    Optional ?level= filter (info|warn|error); ?limit= caps the result set.
    """
    entries = list(reversed(_BACKEND_LOG))
    if level and level != "all":
        entries = [e for e in entries if e.get("level") == level]
    return {"entries": entries[:limit], "total": len(_BACKEND_LOG)}


@api.post("/logs/backend/clear")
def clear_backend_logs():
    """Wipe the in-memory backend event log ring buffer."""
    _BACKEND_LOG.clear()
    _log_event("info", "admin", "Backend event log cleared by user")
    return {"status": "ok"}
