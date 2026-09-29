"""
NIMBUS 2.0 — admin-ops domain routes: diagnostics, health/liveness, the
priority-list cache reload hook, global system settings, DB maintenance, and
the backend/frontend log sinks.

P5 relocation: pure move from brain.py (lines 1365-1502 and 3294-3313 and
3874-4063 as verified against the pre-split file — the system-settings pair
sits between master-data's roles/page-access route and integration's
material-plant-attrs/resync routes in the original file, but is admin-ops
per docs/architecture/domain-refactor-plan.md §4: "system-settings ... ->
admin-ops"), per that same §4. Route paths and payload/response shapes are
byte-identical to before. `_diag_snapshot`, `_truncate`, and the `_FE_MAX_*`
constants are used only within this domain and moved along with their
callers.
"""
import psycopg
import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException, Request

import db
import master_data as md
from backend.admin_ops.diagnostics_state import DIAGNOSTICS
from backend.admin_ops.logbuffer import _BACKEND_LOG, _current_rid, _log_event
from backend.priority_lists import cache as plcache
from backend.security.auth import require_admin, require_api_key

router = APIRouter()


@router.get("/health")
def get_health():
    """Fast DB ping + system snapshot. Polled every 30 s by the Admin Cockpit."""
    db_stats = db.get_health_stats()
    pool_stats = db.get_pool_stats()

    # This endpoint is unauthenticated (polled by the Admin Cockpit before
    # login), so raw exception text from either stats dict — which can
    # contain internal hostnames/ports/DB details — must not leak here.
    # db.py's own error field stays untouched for the admin-gated
    # /diagnostics/db deep-dive route, which needs the real text.
    if db_stats.get("error"):
        db_stats = {**db_stats, "error": "unavailable"}
    if pool_stats.get("error"):
        pool_stats = {**pool_stats, "error": "unavailable"}

    # Stateless: "loaded" now means "DB reachable" rather than "DataFrame in RAM".
    return {
        "db": db_stats,
        "pool": pool_stats,
        "memory": {
            "stateless":   True,
            "loaded":      bool(db_stats.get("connected")),
            "task_count":  db_stats.get("total_orders", 0),
            "loaded_at":   DIAGNOSTICS.get("loaded_at"),
        },
        # No more "path"/"reachable" file check (GLOBAL_CW/COLOR_FILE retired —
        # priority lists are DB-backed, covered by db.connected above). Key
        # name kept as color_wheel for frontend compat — only .misses is read
        # (frontend/plant-and-administration.mts _renderHealth).
        "color_wheel": {
            "misses":    DIAGNOSTICS.get("color_merge_misses", 0),
            "missed_colors": DIAGNOSTICS.get("missed_colors", []),
        },
    }


@router.get("/livez")
def livez():
    """Liveness probe: a process-up check ONLY — never touches Postgres or the
    filesystem. Point the Container Apps *liveness* probe here; readiness and the
    Admin Cockpit keep using /health (which pings the DB). Keeping liveness DB-free
    means a slow or briefly-unreachable database can't trigger needless restarts."""
    return {"status": "ok"}


@router.get("/diagnostics/deep", dependencies=[Depends(require_admin)])
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
            for by_machine in plcache.PLANT_LISTS.values()
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


@router.post("/reload", dependencies=[Depends(require_api_key), Depends(require_admin)])
def reload_data():
    """
    Refresh the in-process priority-list cache from Postgres. In stateless mode
    orders are never cached, so there is nothing to re-read for them.

    Single-replica caveat: this only refreshes the process that handles THIS
    request. On a multi-replica deployment it is not a cross-replica hook —
    every other replica keeps serving its own last-loaded PLANT_LISTS until it
    independently receives its own /reload call or restarts. Fine for the
    current single-replica pilot; would need a shared cache or a fan-out call
    to every replica before this claim would be true at scale.
    """
    try:
        plcache.load_priority_lists()
        DIAGNOSTICS["loaded_at"] = pd.Timestamp.now('UTC').isoformat()
        _log_event("info", "reload", "Priority-list cache refreshed",
                   plants_with_lists=len(plcache.PLANT_LISTS))
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


@router.get("/system-settings")
def get_system_settings():
    """Return the global system-settings blob (currently just orderFields —
    which optional Orders fields show by default in the AG Grid / Inspector).
    Unauthenticated: every user's boot needs this, same as color-wheel reads.
    Response body IS the settings content directly, no wrapper envelope."""
    return md.get_system_settings()


@router.post("/system-settings", dependencies=[Depends(require_api_key), Depends(require_admin)])
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


@router.get("/diagnostics/db", dependencies=[Depends(require_api_key), Depends(require_admin)])
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
        "fetched_at":   pd.Timestamp.now('UTC').isoformat(),
    }


# =============================================================================
# DB MAINTENANCE — safe, non-locking operations exposed to Admin Cockpit
# Excluded intentionally: VACUUM FULL (exclusive lock), REINDEX TABLE (ShareLock),
# terminate-idle (kills app's own pool connections), reset-stats (destroys forensics).
# =============================================================================

@router.post("/maintenance/vacuum-analyze", dependencies=[Depends(require_api_key), Depends(require_admin)])
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


@router.post("/maintenance/analyze", dependencies=[Depends(require_api_key), Depends(require_admin)])
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

@router.get("/logs/backend", dependencies=[Depends(require_api_key), Depends(require_admin)])
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


@router.post("/logs/backend/clear", dependencies=[Depends(require_api_key), Depends(require_admin)])
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


@router.post("/logs/frontend")
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
            "ts":       str(raw.get("ts") or pd.Timestamp.now('UTC').isoformat()),
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
