"""
NIMBUS 2.0 — scheduling domain routes: GET/POST /task(s)* — the `/tasks` read
path and the whole task-date-update write path, including the xmin optimistic-
concurrency contract.

P5 relocation: pure move from brain.py (lines 1493-1982 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths, payload shapes, and response models are byte-identical to before —
only the file that owns them changed. `_clean_id`, `_to_pydt`,
`_schedule_segments_to_wire`, and `_apply_task_date_updates` are private
helpers used only within this domain and moved along with their callers.
"""
import gzip
import logging
import time
from datetime import datetime, timezone

import pandas as pd
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from fastapi.exceptions import ResponseValidationError
from pydantic import TypeAdapter, ValidationError

import db
import master_data as md
from backend.admin_ops.diagnostics_state import DIAGNOSTICS, _warn
from backend.admin_ops.logbuffer import _current_rid, _log_event
from backend.priority_lists import cache as plcache
from backend.scheduling.models import (
    BulkUpdateResult,
    HorizonsResponse,
    TaskDateUpdate,
    TaskRefreshPayload,
    TasksRefreshResponse,
    TasksResponse,
    TasksUpdatePayload,
    TaskUpdateResult,
)
from backend.schedule_events.events import PLANNER_SOURCES, EventCtx, new_action_id
from backend.security import auth

router = APIRouter()


def _clean_id(v):
    """Strip Excel float suffix from SAP IDs: '1000261702.0' → '1000261702'."""
    if v is None:
        return None
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].lstrip('-').isdigit():
        return s[:-2]
    return s


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


def _fast_pydt(val):
    """`_to_pydt` without pandas for the overwhelmingly common inputs (naive datetime or
    ISO string, which is what the JSONB aggregate holds); anything else (or any parse
    failure) falls back to `_to_pydt`, so results never differ for a value pandas accepts."""
    if isinstance(val, datetime):
        return val.replace(tzinfo=None)
    if isinstance(val, str) and val:
        try:
            return datetime.fromisoformat(val).replace(tzinfo=None)
        except ValueError:
            pass
    return _to_pydt(val)


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
        start = _fast_pydt(segment.get("start_date"))
        end = _fast_pydt(segment.get("end_date"))
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


def _server_now_iso() -> str:
    """The server's instant as ISO-8601 UTC ('...Z'). Rides in `/tasks` `meta.server_now` so the browser
    derives ONE plant-zone clock (Store.plantNow) from the server instead of each viewer's own clock
    (backward scheduling OQ52). Never a DTO field."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_DT_MIN = datetime.min
_UNSET = object()
_ISO_FMT = "%Y-%m-%dT%H:%M:%S"
_DEFAULT_RANK = 999999
_NORMALISED_ATTRS = ("COLOR", "PRT_01", "PRT_02", "PRODUCTION_VERSION")


def _nn(v):
    """NaN-like -> None (float NaN, Decimal NaN); everything else unchanged."""
    return None if v != v else v


def _iso(dt):
    return dt.strftime(_ISO_FMT) if dt is not None else None


def _norm_attr(v):
    """Mirror of apply_priority_merge's `astype(str).str.upper().str.strip()` under
    pandas 3: a null stays null (it does NOT become "NONE"/"nan")."""
    return None if v is None else str(v).upper().strip()


def _rank_value(v):
    """Rank as `pd.to_numeric(errors='coerce')` would see it: a number, or None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if v != v else v
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _stamp_order_y(rows: list[dict], plant: str | None) -> None:
    """Set row["ORDER_Y"] (rank or None = unlisted) in place — the plain-Python twin of
    plcache.apply_priority_merge's scope stamping. Plant-wide colorWheel list first;
    a machine-specific list then REPLACES it for that machine's rows (a colour absent
    from it is None -> unlisted, even if the plant-wide list has it)."""
    for r in rows:
        r["ORDER_Y"] = None

    def _stamp(by_machine: dict, subset: list[dict]) -> None:
        plantwide = (by_machine.get("") or {}).get("colorWheel")
        if plantwide:
            for r in subset:
                r["ORDER_Y"] = _rank_value(plantwide.get(r["COLOR"]))
        for scope_key, fields in by_machine.items():
            if scope_key == "":
                continue
            machine_map = fields.get("colorWheel")
            if machine_map:
                for r in subset:
                    if r["MACHINE"] == scope_key:
                        r["ORDER_Y"] = _rank_value(machine_map.get(r["COLOR"]))

    if plant:
        by_machine = plcache.PLANT_LISTS.get(plant)
        if by_machine:
            _stamp(by_machine, rows)
    else:
        for plant_key, by_machine in plcache.PLANT_LISTS.items():
            subset = [r for r in rows if r["PLANT"] == plant_key]
            if subset:
                _stamp(by_machine, subset)


def _build_task_rows(raw_rows: list[dict], plant: str | None) -> tuple[list[dict], list[dict], dict, int]:
    """Pandas-free builder behind GET /tasks: raw `db.query_orders_rows` dicts ->
    (data, links, color-merge stats, pre-merge row count). Same wire rows as the former
    DataFrame path (pinned by tests/test_tasks_builder_golden.py).

    ORDER: machines ascending ('' first, NULL machine last), then within a machine
    BASIC_START_DATE ascending with nulls last, then ORDER_Y, then original SQL row
    order (a STABLE sort; the old per-machine quicksort left start-time ties in an
    unspecified order). Rows are copied before ORDER_Y/COLOR stamping, so the caller's
    dicts are never mutated. Read-only: nothing here touches `orders`."""
    stats: dict = {"color_merge_misses": 0, "missed_colors": [], "emitted_task_count": 0, "color_merge_ms": 0}
    # Start is optional (backward scheduling OQ24/OQ25): a never-placed order has a finish and no start and
    # is still served. Only a row with neither edge and no queue state has nothing to draw.
    kept = [dict(r) for r in raw_rows
            if r["BASIC_START_DATE"] is not None or r["BASIC_FINISH_DATE"] is not None
            or r.get("PLANNING_STATUS") == "needs_planning"]
    pre_merge_count = len(kept)
    if not kept:
        return [], [], stats, pre_merge_count

    t_color = time.monotonic()
    try:
        for r in kept:
            for col in _NORMALISED_ATTRS:
                r[col] = _norm_attr(r.get(col))
        _stamp_order_y(kept, plant)
        missed = [r for r in kept if r["ORDER_Y"] is None]
        if missed:
            stats["color_merge_misses"] = len(missed)
            stats["missed_colors"] = sorted({r["COLOR"] for r in missed if r["COLOR"] is not None})
        for r in missed:
            r["ORDER_Y"] = _DEFAULT_RANK
    except Exception as e:
        _warn("error", f"Priority-list merge failed: {e}; all rows get priority 999999")
        stats.update(color_merge_misses=0, missed_colors=[])
        for r in kept:
            r["ORDER_Y"] = _DEFAULT_RANK
    stats["emitted_task_count"] = len(kept)
    stats["color_merge_ms"] = round((time.monotonic() - t_color) * 1000)

    # Stable sort: python's sort is stable, so equal keys keep SQL order.
    kept.sort(key=lambda r: (
        r["MACHINE"] is None, r["MACHINE"] or "",
        r["BASIC_START_DATE"] is None, r["BASIC_START_DATE"] or _DT_MIN,
        r["ORDER_Y"],
    ))

    data: list[dict] = []
    links: list[dict] = []
    link_id = 1
    prev_machine = _UNSET
    prev_task_id = None
    for r in kept:
        # TaskRow.MACHINE is a required str; the UI shows '' as 'Unknown'.
        prod_line = r["MACHINE"] or ""
        if r["MACHINE"] != prev_machine:
            prev_machine = r["MACHINE"]
            prev_task_id = None
        task_id = r["id"]
        task_text = str(_nn(r.get("MATERIAL_DESCRIPTION"))).strip()
        if not task_text or task_text == "nan":
            task_text = f"Order {task_id[:8]}"
        status = r.get("PLANNING_STATUS")
        rv = r.get("ROW_VERSION")
        data.append({
            "id": task_id,
            "text": task_text,
            "start_date": _iso(r["BASIC_START_DATE"]),
            "end_date": _iso(r["BASIC_FINISH_DATE"]),
            "original_start_date": _iso(r.get("ORIGINAL_START_DATE")),
            "original_end_date": _iso(r.get("ORIGINAL_END_DATE")),
            "user_scheduled": bool(r.get("USER_SCHEDULED")),
            "MACHINE": prod_line,
            "MATERIAL_DESCRIPTION": task_text,
            "MATERIAL_NUMBER": _clean_id(r.get("MATERIAL_NUMBER")),
            "ORDER_QUANTITY_(GMEIN)": _nn(r.get("ORDER_QUANTITY_(GMEIN)")),
            "COLOR": r["COLOR"],
            "PRT_01": r["PRT_01"],
            "PRT_02": r["PRT_02"],
            "PRODUCTION_VERSION": r["PRODUCTION_VERSION"],
            "PLANT": r.get("PLANT"),
            "ORDER": _clean_id(r.get("PRODUCTION_ORDER")),
            "ORDER_Y": r["ORDER_Y"],
            "RUN_TIME": _nn(r.get("RUN_TIME")),
            "FORM_SIZE": r.get("FORM_SIZE"),
            "notes": r.get("NOTES"),
            # Normalised like the outbound firm rule (sap_staging.firm_flag): ingest stores the indicator raw (Excel)
            # or only stripped (SAP staging), so strip + upper here keeps the grid X, the Inspector tag and Send's X
            # in agreement. Display only: it never locks an order.
            "ecc_firmed": str(r.get("FIRMING_INDICATOR") or "").strip().upper() == "X",
            "firmed": bool(r.get("FIRMED")),
            "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)": _nn(r.get("PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)")),
            "REDUCED_QUANTITY_(GMEIN)": _nn(r.get("REDUCED_QUANTITY_(GMEIN)")),
            "ORDER_CATEGORY": r.get("ORDER_CATEGORY"),
            "ORDER_TYPE": r.get("ORDER_TYPE"),
            "BOM_ALTERNATIVE": _nn(r.get("BOM_ALTERNATIVE")),
            "BOM_USAGE": _nn(r.get("BOM_USAGE")),
            "LABOR_HOURS_(MEINH)": _nn(r.get("LABOR_HOURS_(MEINH)")),
            "MACHINE_HOURS_(MEINH)": _nn(r.get("MACHINE_HOURS_(MEINH)")),
            "NO_OF_FTE_(MEINH)": _nn(r.get("NO_OF_FTE_(MEINH)")),
            "PARENT_ORDER": r.get("PARENT_ORDER"),
            "DISTRIBUTION_LETTER": r.get("DISTRIBUTION_LETTER"),
            # Optimistic-concurrency token (Postgres xmin). The client echoes it
            # back on edit so the server can reject writes computed from stale data.
            "row_version": int(rv) if rv is not None else None,
            "schedule_segments": _schedule_segments_to_wire(r.get("SCHEDULE_SEGMENTS")),
            "runtime_schedule_mismatch": bool(r.get("RUNTIME_SCHEDULE_MISMATCH")),
            "placement_exception": r.get("PLACEMENT_EXCEPTION") or None,
            "planning_status": status or "scheduled",
            "planning_reason": r.get("PLANNING_REASON"),
            "run_time_source": r.get("run_time_source"),
            "run_time_basis": r.get("run_time_basis"),
        })
        # No links for queued rows or rows with no machine (chaining unrelated unassigned orders is meaningless).
        if status == "needs_planning" or not prod_line:
            continue
        if prev_task_id:
            links.append({"id": link_id, "source": prev_task_id, "target": task_id, "type": "0"})
            link_id += 1
        prev_task_id = task_id
    return data, links, stats, pre_merge_count


_perf_log = logging.getLogger("nimbus.perf")   # child of brain.py's `nimbus` JSON handler
_SLOW_TASKS_MS = 1500


def _log_tasks_timing(plant, row_count: int, **stages_s: float) -> None:
    """One structured `tasks.timing` event per GET /tasks. Deliberately NOT a DIAGNOSTICS
    key: `meta` is built from DIAGNOSTICS and would leak it into the response. Stage values
    are ms (rounded). Every request goes to the JSON logger only (`nimbus.perf`); it enters
    the 2000-entry `_BACKEND_LOG` ring (as a `warn`) only when slower than
    `_SLOW_TASKS_MS`, so routine timings never push real warnings out of the ring."""
    ms = {f"{k}_ms": round(v * 1000, 1) for k, v in stages_s.items()}
    ms["total_ms"] = round(sum(stages_s.values()) * 1000, 1)
    msg = f"GET /tasks timing plant={plant} rows={row_count}"
    if ms["total_ms"] > _SLOW_TASKS_MS:
        _log_event("warn", "perf", msg + " (slow)", event="tasks.timing", plant=plant, rows=row_count, **ms)
        return
    _perf_log.info(msg, extra={"category": "perf", "event": "tasks.timing",
                               "ctx": {"plant": plant, "rows": row_count, **ms}, "rid": _current_rid()})


@router.get("/tasks", response_model=TasksResponse)
def get_tasks(plant: str | None = None, machine: str | None = None,
              limit: int | None = Query(default=None, ge=1, le=10000,
                  description="Max rows to return. Omit for the full plant-scoped list."),
              offset: int | None = Query(default=None, ge=0,
                  description="Rows to skip before returning (for paging)."),
              allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request),
              request: Request = None):
    """
    Return tasks as JSON with finish-to-start links and pipeline metadata.

    Stateless: queries Postgres per request (db.query_orders_rows) rather than
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
    # NOTE (kept out of the docstring: it is the OpenAPI description). This is a sync `def`, so
    # FastAPI runs it in the threadpool and EVERYTHING heavy happens off the event loop: build the
    # payload, validate it with the same `TasksResponse` model the decorator advertises (returning
    # a Response skips FastAPI's own response_model pass, so validation is explicit here), encode
    # to JSON bytes and gzip them. `response_model=` stays on the decorator so OpenAPI is unchanged.
    timings: dict = {}
    payload = build_tasks_payload(plant, machine, limit, offset, allowed_plants, _timings=timings)
    accept = request.headers.get("accept-encoding", "") if request is not None else ""
    response = encode_tasks_response(payload, accept, _timings=timings)
    _log_tasks_timing(plant, len(payload["data"]), **timings)
    return response


_TASKS_ADAPTER = TypeAdapter(TasksResponse)
_GZIP_MIN_BYTES = 1000      # same floor as the app-wide GZipMiddleware
_GZIP_LEVEL = 6


def encode_tasks_response(payload: dict, accept_encoding: str = "", *, _timings: dict | None = None) -> Response:
    """Validate -> JSON bytes (by_alias, so `ORDER_QUANTITY_(GMEIN)` etc. keep their wire
    names; pydantic writes NaN/Infinity as null) -> gzip level 6 when the caller accepts
    it. `Content-Encoding` is set here, so the app-wide GZipMiddleware passes the body
    through untouched (starlette's responder skips a response that already has one).
    `Vary: Accept-Encoding` is set exactly once: by us when we gzip (the middleware then
    passes the body through) or when the body is under the middleware's 1000-byte floor
    (it leaves such a response alone); for an uncompressed body at or over the floor the
    middleware's IdentityResponder appends it, so we must not (it would be duplicated).

    A validation failure is re-raised as FastAPI's `ResponseValidationError` (a 500), NOT
    left as pydantic's `ValidationError`: that is a ValueError, which brain.py's
    `_value_error_handler` would turn into a 400 echoing the offending row values."""
    t0 = time.perf_counter()
    try:
        model = _TASKS_ADAPTER.validate_python(payload)
    except ValidationError as exc:
        raise ResponseValidationError(errors=exc.errors(include_input=False)) from exc
    t1 = time.perf_counter()
    body = _TASKS_ADAPTER.dump_json(model, by_alias=True)
    t2 = time.perf_counter()
    headers: dict[str, str] = {}
    if "gzip" in accept_encoding.lower() and len(body) >= _GZIP_MIN_BYTES:
        body = gzip.compress(body, compresslevel=_GZIP_LEVEL, mtime=0)
        headers["Content-Encoding"] = "gzip"
        headers["Vary"] = "Accept-Encoding"
    elif len(body) < _GZIP_MIN_BYTES:
        headers["Vary"] = "Accept-Encoding"
    t3 = time.perf_counter()
    if _timings is not None:
        _timings.update(validate=t1 - t0, encode=t2 - t1, gzip=t3 - t2)
    return Response(content=body, media_type="application/json", headers=headers)


def build_tasks_payload(plant: str | None, machine: str | None, limit: int | None,
                        offset: int | None, allowed_plants: list[str] | None,
                        *, _timings: dict | None = None) -> dict:
    """
    Return tasks as JSON with finish-to-start links and pipeline metadata.

    Stateless: queries Postgres per request (db.query_orders_rows) rather than
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
    # C2 (2026-08-20): query_orders resolves the plant's frozen-horizon bound
    # the SAME way (same shared clock, see db._horizon_bounds_for_plant) —
    # it does not filter this query, only rides along for reporting, so
    # `meta.frozen_horizon_end` reaches Store.frozenHorizonEnd for the
    # Timeline band and the optimizer's placement-floor helper without a
    # second copy of the clock math on either side.
    t_start = time.perf_counter()
    rows, visibility_horizon_end, frozen_horizon_end = db.query_orders_rows(plant=plant, line=machine, limit=limit, offset=offset, allowed_plants=allowed_plants)
    t_sql = time.perf_counter()
    if _timings is not None:
        _timings["sql"] = t_sql - t_start
    if not rows:
        empty_meta = {"rendered": 0, "link_count": 0, "plant_filter_active": plant,
                      "machine_filter_active": machine, "pre_color_merge_count": 0,
                      "raw_row_count": 0, "unique_id_count": 0,
                      "color_merge_misses": 0, "missed_colors": [],
                      "emitted_task_count": 0, "color_merge_ms": 0,
                      "total": (db.count_orders(plant=plant, line=machine, allowed_plants=allowed_plants) if paging else 0),
                      "loaded_at": DIAGNOSTICS.get("loaded_at"),
                      "source_file": "postgres://nimbus/orders",
                      "visibility_horizon_end": visibility_horizon_end.isoformat() if visibility_horizon_end else None,
                      "frozen_horizon_end": frozen_horizon_end.isoformat() if frozen_horizon_end else None,
                      "server_now": _server_now_iso()}
        return {"data": [], "links": [], "meta": empty_meta}

    data, links, cm_stats, pre_merge_count = _build_task_rows(rows, plant)
    t_build = time.perf_counter()

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
    meta["frozen_horizon_end"] = frozen_horizon_end.isoformat() if frozen_horizon_end else None
    meta["server_now"] = _server_now_iso()
    if _timings is not None:
        _timings.update(sql=t_sql - t_start, build=t_build - t_sql)
    return {"data": data, "links": links, "meta": meta}


@router.get("/tasks/horizons", response_model=HorizonsResponse)
def get_task_horizons(plant: str,
                      allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Meta-only probe: the plant's resolved visibility/frozen horizon instants and
    alert-flag horizon minutes — the same values GET /tasks carries in `meta`,
    without the task list. The Gantt calls this on timeline re-entry so its
    horizon bands refresh after an admin change or the daily roll without a
    full /tasks reload (which would clobber unsaved planner edits).
    """
    if allowed_plants is not None and plant not in allowed_plants:
        raise HTTPException(status_code=403, detail=f"Plant {plant!r} is not in your assigned plants")
    h = db.plant_horizons(plant)
    return {
        "visibility_horizon_end": h["visibility_horizon_end"].isoformat() if h["visibility_horizon_end"] else None,
        "frozen_horizon_end": h["frozen_horizon_end"].isoformat() if h["frozen_horizon_end"] else None,
        "alert_horizon_minutes": h["alert_horizon_minutes"],
        "calendar_version": h.get("calendar_version"),
    }


def _apply_task_date_updates(items: list[TaskDateUpdate], allowed_plants: list[str] | None = None,
                             *, atomic_optimizer: bool = False,
                             strict_conflicts: bool = False,
                             actor: str | None = None, client_id: str | None = None) -> dict:
    """
    Normalize schedule/attribute edits and persist them write-through to Postgres
    in a single transaction (db.update_task_dates_bulk). No in-memory frame to
    mutate anymore — the DB is the source of truth.

    Single source of truth for /task/update, /tasks/update and /tasks/bulk_update.
    Inverted ranges are validated against each row's effective current dates and
    counted as `invalid`; unknown ids are counted as `not_found`. Edits whose
    `base_version` no longer matches the row (a concurrent write landed first) are
    rejected and reported in `stale` unless `force` is set — which only the
    /tasks/update path can do (client CONCURRENCY_CHECK=false, non-atomic), and
    which is logged as a warn `forced_write` event. /tasks/bulk_update strips it.

    `allowed_plants` (None for an unrestricted/admin caller) is threaded through
    to db.update_task_dates_bulk, which treats an out-of-scope row identically
    to a nonexistent one (folded into not_found_ids) rather than leaking plant
    membership via a distinct rejection reason.

    Returns { applied, persisted, failed, invalid, not_found, invalid_ids, start_derived,
              not_found_ids, stale, versions, rejection_reasons }. invalid_ids/
    not_found_ids carry the actual rejected ids (from db.update_task_dates_bulk)
    so the client can stop retrying terminal rejections while keeping
    transiently-lost rows dirty. `rejection_reasons` is db.update_task_dates_bulk's
    own sparse {id: reason} map (§8.5 routing-eligibility rejections only) —
    forwarded as-is; this function's OWN pre-DB validation failures above (missing
    id, unparseable date, malformed segment) never populate it.
    """
    norm: list[dict] = []
    invalid = 0
    invalid_ids = []
    attribute_fields = ("PRT_01", "PRT_02", "PRODUCTION_VERSION", "MACHINE")
    for it in items:
        if not it.id:
            invalid += 1
            invalid_ids.append(it.id)
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
        has_planning = "planning_status" in supplied or "planning_reason" in supplied
        if (it.start_date and start_dt is None) or (it.end_date and end_dt is None):
            invalid += 1
            invalid_ids.append(it.id)
            continue
        has_runtime = "RUN_TIME" in supplied
        has_firmed = "FIRMED" in supplied and it.FIRMED is not None
        has_segments = "schedule_segments" in supplied
        has_exception = "placement_exception" in supplied
        segments: list[dict] | None = None
        if has_segments:
            # An aggregate replacement is deliberately explicit.  Treating a
            # JSON null as [] would let a malformed client erase all durable
            # productive pieces without supplying the parent schedule it meant
            # to replace.
            if it.schedule_segments is None:
                invalid += 1
                invalid_ids.append(it.id)
                continue
            segments = []
            for segment in it.schedule_segments:
                segment_start = _to_pydt(segment.start_date)
                segment_end = _to_pydt(segment.end_date)
                if segment_start is None or segment_end is None:
                    invalid += 1
                    invalid_ids.append(it.id)
                    segments = None
                    break
                segments.append({
                    "sequence": segment.sequence,
                    "start": segment_start,
                    "end": segment_end,
                })
            if segments is None:
                continue
        if start_dt is None and end_dt is None and not attrs and not has_runtime and not has_firmed and not has_segments and not has_planning and not has_exception:
            if atomic_optimizer:
                invalid += 1
                invalid_ids.append(it.id)
            continue
        item = {"id": it.id, "start": start_dt, "end": end_dt,
                **attrs,
                "base_version": it.base_version, "force": it.force}
        if has_planning:
            item["planning_status"] = it.planning_status
            item["planning_reason"] = it.planning_reason
        if has_runtime:
            item["RUN_TIME"] = it.RUN_TIME
        if has_firmed:
            item["FIRMED"] = it.FIRMED
        if has_segments:
            item["schedule_segments"] = segments
        if has_exception:
            item["placement_exception"] = it.placement_exception   # None = clear the marker
        if it.source in PLANNER_SOURCES:
            item["source"] = it.source    # unknown/absent -> not forwarded (recorded as 'planner')
        if "trust_start" in supplied and not it.trust_start:
            item["trust_start"] = False      # only a caller that distrusts its start sends it (True = default)
        norm.append(item)

    forced_ids = [it["id"] for it in norm if it.get("force")]
    if forced_ids and not atomic_optimizer:
        # Auditable trail for every last-write-wins write (the client's
        # Config.CONCURRENCY_CHECK=false path). rid is attached by _log_event.
        _log_event("warn", "db", "Forced task write bypasses the base_version check",
                   event="forced_write", count=len(forced_ids), ids=forced_ids[:20])

    if atomic_optimizer and invalid:
        return {"applied": 0, "persisted": 0, "failed": len(items), "invalid": invalid,
                "not_found": 0, "invalid_ids": invalid_ids, "not_found_ids": [],
                "stale": [], "versions": {}, "conflicts": [], "rejection_reasons": {}}

    if not norm:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": invalid,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {}, "conflicts": [], "rejection_reasons": {}}

    ev = EventCtx(source="planner", actor=actor, action_id=new_action_id(), client_id=client_id)
    try:
        res = db.update_task_dates_bulk(
            norm, allowed_plants=allowed_plants,
            **({"atomic_optimizer": True} if atomic_optimizer else {}),
            **({"strict_conflicts": True} if (atomic_optimizer and strict_conflicts) else {}),
            actor=actor, client_id=client_id, ev=ev)
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
                "stale": [], "versions": {}, "conflicts": [],
                "status": "error", "error_code": error_code,
                "cause": "Bulk task update persist failed (transaction rolled back)",
                "rejection_reasons": {}}
    res["invalid"] = res.get("invalid", 0) + invalid
    res["invalid_ids"] = res.get("invalid_ids", []) + invalid_ids
    return res


@router.post("/task/update", response_model=TaskUpdateResult)
def update_task(task: TaskDateUpdate,
                 actor: str = Depends(auth.require_authenticated),
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Update a single task's schedule/priority attributes and persist to DB.
    Payload: { id, start_date and end_date (both, or neither; a single edge is rejected as single_edge),
               PRT_01?, PRT_02?, PRODUCTION_VERSION?, base_version?, force? }
    Response: 200 { status, persisted, failed, stale, versions, conflicts, rejection_reasons, start_derived }
              | 400 { error: "invalid", rejection_reasons } | 404 not found.
    A version conflict is NOT a 4xx — it returns 200 with the id in `stale` so the
    client can refetch and warn uniformly with the bulk path.
    """
    res = _apply_task_date_updates([task], allowed_plants=allowed_plants, actor=actor)
    if res.get("not_found"):
        raise HTTPException(status_code=404, detail="Task not found")
    if res.get("invalid"):
        raise HTTPException(status_code=400, detail={"error": "invalid",
                                                     "rejection_reasons": res.get("rejection_reasons", {})})
    return {"status": "ok", "persisted": res["persisted"], "failed": res["failed"],
            "stale": res.get("stale", []), "versions": res.get("versions", {}),
            "conflicts": res.get("conflicts", []),
            "rejection_reasons": res.get("rejection_reasons", {}),
            "start_derived": res.get("start_derived", {})}


@router.post("/task/note")
def update_task_note(payload: dict,
                      actor: str = Depends(auth.require_authenticated),
                      allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
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
    plant = db.get_order_plant(task_id)
    if plant is None or (allowed_plants is not None and plant not in allowed_plants):
        raise HTTPException(status_code=404, detail="Task not found")
    try:
        return db.update_task_note(task_id, notes,
                                   ev=EventCtx(source="note", actor=actor, action_id=new_action_id()))
    except Exception as e:
        _log_event("error", "db", "Note persist failed", exc=e, task_id=task_id)
        raise HTTPException(status_code=500,
                            detail=f"Note persist failed — ref: {_current_rid()}") from e


# Frontend calls /tasks/update (plural) with {tasks, blocks, calendars}; keep
# /tasks/bulk_update as a flat-list alias for external tooling. Both are
# best-effort and report per-row counts in the body (no whole-batch 4xx).
@router.post("/tasks/update", response_model=BulkUpdateResult)
def tasks_update(payload: TasksUpdatePayload,
                  actor: str = Depends(auth.require_authenticated),
                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Bulk-update task dates/priority attributes and persist to DB (one transaction).
    Payload: { tasks: [{ id, start_date and end_date (both, or neither; a single edge is rejected as single_edge),
                         PRT_01?, PRT_02?,
                         PRODUCTION_VERSION?, base_version?, force? }],
               blocks?, calendars? }
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions, rejection_reasons }
    """
    res = _apply_task_date_updates(payload.tasks, allowed_plants=allowed_plants,
                                   atomic_optimizer=payload.atomic_optimizer,
                                   strict_conflicts=payload.strict_conflicts,
                                   actor=actor, client_id=payload.client_id)
    total = len(payload.tasks)
    stale = res.get("stale", [])
    if res["persisted"] < total:
        _log_event("warn", "db", "Bulk update: some tasks not persisted",
                   total=total, persisted=res["persisted"], failed=res["failed"],
                   invalid=res["invalid"], not_found=res.get("not_found", 0),
                   stale=len(stale))
    conflicts = res.get("conflicts", [])
    if conflicts:
        _log_event("info", "db", "Bulk update produced schedule conflicts",
                   event="schedule_conflicts", count=len(conflicts),
                   machines=sorted({c["machine"] for c in conflicts}),
                   strict=bool(payload.strict_conflicts and payload.atomic_optimizer))
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
           "stale": stale, "versions": res.get("versions", {}),
           "conflicts": conflicts,
           # §8.5: sparse {id: reason} map, populated only for the routing-
           # eligibility rejection inside db.update_task_dates_bulk — every
           # other invalid_ids cause has no entry here. Purely additive; does
           # not change invalid_ids' own shape.
           "rejection_reasons": res.get("rejection_reasons", {}),
           "start_derived": res.get("start_derived", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


@router.post("/tasks/bulk_update", response_model=BulkUpdateResult)
def bulk_update(tasks: list[TaskDateUpdate],
                 actor: str = Depends(auth.require_authenticated),
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Alias for /tasks/update with a flat list payload (used by external tooling/Postman).
    Payload: [{ id, start_date and end_date (both, or neither; a single edge is rejected as single_edge),
                base_version?, trust_start? }]
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions, rejection_reasons, start_derived }

    Both edges are accepted, and `end_date` is read as the PLACED FINISH (the anchor NIMBUS keeps; the start
    is derived from it). `trust_start` (default true) says whether the sent `start_date` was derived from
    the run time by the caller: an external or integration writer that cannot do that sends
    `trust_start: false`, which skips the width check, forces the row's stale flag so the browser re-derives
    the start from the finish, and lists the id in `start_derived` (backward scheduling OQ59). The default
    stays "trusted" because the browser's own saves send starts it computed; the width check then refuses a
    start that does not fit the run time.

    `force` is accepted for wire compatibility but ignored (N2, 2026-09): an
    external caller may not bypass the base_version check. A stale row is
    reported in `stale`, never overwritten.
    """
    stripped = [it.model_copy(update={"force": False}) if it.force else it for it in tasks]
    res = _apply_task_date_updates(stripped, allowed_plants=allowed_plants, actor=actor)
    total = len(tasks)
    stale = res.get("stale", [])
    if res["persisted"] < total:
        _log_event("warn", "db", "bulk_update: some tasks not persisted",
                   total=total, persisted=res["persisted"], failed=res["failed"],
                   invalid=res["invalid"], not_found=res.get("not_found", 0),
                   stale=len(stale))
    conflicts = res.get("conflicts", [])
    if conflicts:
        _log_event("info", "db", "Bulk update produced schedule conflicts",
                   event="schedule_conflicts", count=len(conflicts),
                   machines=sorted({c["machine"] for c in conflicts}))
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
           "stale": stale, "versions": res.get("versions", {}),
           "conflicts": conflicts,
           # §8.5: sparse {id: reason} map, populated only for the routing-
           # eligibility rejection inside db.update_task_dates_bulk — every
           # other invalid_ids cause has no entry here. Purely additive; does
           # not change invalid_ids' own shape.
           "rejection_reasons": res.get("rejection_reasons", {}),
           "start_derived": res.get("start_derived", {})}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


@router.post("/tasks/refresh", response_model=TasksRefreshResponse,
             dependencies=[Depends(auth.require_authenticated)])
def tasks_refresh(payload: TaskRefreshPayload,
                   allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Lean refetch of specific orders' current dates + row_version, for optimistic-
    concurrency conflict reconciliation. Returns only what the client needs to
    overwrite its stale copies — no links, no color merge.
    Payload: { ids: [str] }
    Response: { data: [{ id, start_date, end_date, row_version }], missing: [str] }

    Rows outside `allowed_plants` (None for an unrestricted/admin caller) are
    silently dropped rather than 403'd — matching GET /tasks's silent-bound
    behavior for unscoped pulls. Only authorized rows expose their plant as
    `PLANT`, alongside the material, quantity and raw SAP baseline date used
    by runtime calculation. These inputs and the version come from one read.

    `missing` mirrors the not_found_ids convention from the /tasks/update family
    (BulkUpdateResult): requested ids that no longer exist in `orders` (deleted
    by another session, a purge, an upload) OR that exist but fell outside
    `allowed_plants` — both folded into the same list, same as
    update_task_dates_bulk folds "not yours" into not_found_ids, so the client
    can't distinguish the two cases from this response. The client (Persistence.
    _refreshTasks) uses it to drop these ids from Store instead of leaving them
    as stale ghosts.
    """
    rows = db.get_task_versions(payload.ids)
    found_ids = {r["id"] for r in rows}
    if allowed_plants is not None:
        rows = [r for r in rows if r.get("plant") in allowed_plants]
        found_ids = {r["id"] for r in rows}
    missing = [i for i in payload.ids if i not in found_ids]
    for row in rows:
        row["PLANT"] = row.pop("plant", None)
        row["schedule_segments"] = _schedule_segments_to_wire(row.get("schedule_segments"))
    return {"data": rows, "missing": missing}
