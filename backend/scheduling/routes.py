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
import pandas as pd
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query

import db
import master_data as md
from backend.admin_ops.diagnostics_state import DIAGNOSTICS
from backend.admin_ops.logbuffer import _current_rid, _log_event
from backend.priority_lists import cache as plcache
from backend.scheduling.models import (
    BaselineCorrectResult,
    BulkUpdateResult,
    DueDateCorrectionPayload,
    HorizonsResponse,
    TaskDateUpdate,
    TaskRefreshPayload,
    TasksRefreshResponse,
    TasksResponse,
    TasksUpdatePayload,
    TaskUpdateResult,
)
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


@router.get("/tasks", response_model=TasksResponse)
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
    # C2 (2026-08-20): query_orders resolves the plant's frozen-horizon bound
    # the SAME way (same shared clock, see db._horizon_bounds_for_plant) —
    # it does not filter this query, only rides along for reporting, so
    # `meta.frozen_horizon_end` reaches Store.frozenHorizonEnd for the
    # Timeline band and the optimizer's placement-floor helper without a
    # second copy of the clock math on either side.
    df, visibility_horizon_end, frozen_horizon_end = db.query_orders(plant=plant, line=machine, limit=limit, offset=offset, allowed_plants=allowed_plants)
    if df is None or df.empty:
        empty_meta = {"rendered": 0, "link_count": 0, "plant_filter_active": plant,
                      "machine_filter_active": machine, "pre_color_merge_count": 0,
                      "raw_row_count": 0, "unique_id_count": 0,
                      "color_merge_misses": 0, "missed_colors": [],
                      "emitted_task_count": 0, "color_merge_ms": 0,
                      "total": (db.count_orders(plant=plant, line=machine, allowed_plants=allowed_plants) if paging else 0),
                      "loaded_at": DIAGNOSTICS.get("loaded_at"),
                      "source_file": "postgres://nimbus/orders",
                      "visibility_horizon_end": visibility_horizon_end.isoformat() if visibility_horizon_end else None,
                      "frozen_horizon_end": frozen_horizon_end.isoformat() if frozen_horizon_end else None}
        return {"data": [], "links": [], "meta": empty_meta}

    # Drop rows with no usable start date (query can't enforce this without
    # losing the NULL diagnostic), then color-merge the scoped subset.
    df = df[df["BASIC_START_DATE"].notna() |
            (df.get("PLANNING_STATUS", pd.Series("scheduled", index=df.index)) == "needs_planning")].reset_index(drop=True)
    pre_merge_count = len(df)

    df, cm_stats = plcache.apply_priority_merge(df, plant=plant)
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
                "start_date": row["BASIC_START_DATE"].strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(row["BASIC_START_DATE"]) else None,
                "end_date": row["BASIC_FINISH_DATE"].strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(row["BASIC_FINISH_DATE"]) else None,
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
                "ecc_firmed": row.get("FIRMING_INDICATOR") == "X",
                "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)": row.get("PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)"),
                "REDUCED_QUANTITY_(GMEIN)": row.get("REDUCED_QUANTITY_(GMEIN)"),
                "ORDER_CATEGORY": row.get("ORDER_CATEGORY"),
                "ORDER_TYPE": row.get("ORDER_TYPE"),
                "BOM_ALTERNATIVE": row.get("BOM_ALTERNATIVE"),
                "BOM_USAGE": row.get("BOM_USAGE"),
                "LABOR_HOURS_(MEINH)": row.get("LABOR_HOURS_(MEINH)"),
                "MACHINE_HOURS_(MEINH)": row.get("MACHINE_HOURS_(MEINH)"),
                "NO_OF_FTE_(MEINH)": row.get("NO_OF_FTE_(MEINH)"),
                # Optimistic-concurrency token (Postgres xmin). The client echoes it
                # back on edit so the server can reject writes computed from stale data.
                "row_version": int(row["ROW_VERSION"]) if pd.notna(row.get("ROW_VERSION")) else None,
                "schedule_segments": _schedule_segments_to_wire(row.get("SCHEDULE_SEGMENTS")),
                "runtime_schedule_mismatch": bool(row.get("RUNTIME_SCHEDULE_MISMATCH")),
                "planning_status": row.get("PLANNING_STATUS") or "scheduled",
                "planning_reason": row.get("PLANNING_REASON"),
            })

            if row.get("PLANNING_STATUS") == "needs_planning":
                continue
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
    meta["frozen_horizon_end"] = frozen_horizon_end.isoformat() if frozen_horizon_end else None
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
    }


def _apply_task_date_updates(items: list[TaskDateUpdate], allowed_plants: list[str] | None = None,
                             *, atomic_optimizer: bool = False,
                             strict_conflicts: bool = False) -> dict:
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

    Returns { applied, persisted, failed, invalid, not_found, invalid_ids,
              not_found_ids, stale, versions }. invalid_ids/not_found_ids carry
    the actual rejected ids (from db.update_task_dates_bulk) so the client can
    stop retrying terminal rejections while keeping transiently-lost rows dirty.
    """
    norm: list[dict] = []
    invalid = 0
    invalid_ids = []
    attribute_fields = ("PRT_01", "PRT_02", "PRODUCTION_VERSION")
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
        has_segments = "schedule_segments" in supplied
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
        if start_dt is None and end_dt is None and not attrs and not has_runtime and not has_segments and not has_planning:
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
        if has_segments:
            item["schedule_segments"] = segments
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
                "stale": [], "versions": {}, "conflicts": []}

    if not norm:
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": invalid,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {}, "conflicts": []}

    try:
        res = db.update_task_dates_bulk(
            norm, allowed_plants=allowed_plants,
            **({"atomic_optimizer": True} if atomic_optimizer else {}),
            **({"strict_conflicts": True} if (atomic_optimizer and strict_conflicts) else {}))
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
                "cause": "Bulk task update persist failed (transaction rolled back)"}
    res["invalid"] = res.get("invalid", 0) + invalid
    res["invalid_ids"] = res.get("invalid_ids", []) + invalid_ids
    return res


@router.post("/task/update", response_model=TaskUpdateResult,
             dependencies=[Depends(auth.require_authenticated)])
def update_task(task: TaskDateUpdate,
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Update a single task's schedule/priority attributes and persist to DB.
    Payload: { id, start_date?, end_date?, PRT_01?, PRT_02?,
               PRODUCTION_VERSION?, base_version?, force? }
    Response: 200 { status, persisted, failed, stale, versions } | 400 invalid | 404 not found.
    A version conflict is NOT a 4xx — it returns 200 with the id in `stale` so the
    client can refetch and warn uniformly with the bulk path.
    """
    res = _apply_task_date_updates([task], allowed_plants=allowed_plants)
    if res.get("not_found"):
        raise HTTPException(status_code=404, detail="Task not found")
    if res.get("invalid"):
        raise HTTPException(status_code=400, detail="Invalid date range (end must be after start)")
    return {"status": "ok", "persisted": res["persisted"], "failed": res["failed"],
            "stale": res.get("stale", []), "versions": res.get("versions", {}),
            "conflicts": res.get("conflicts", [])}


@router.post("/task/note", dependencies=[Depends(auth.require_authenticated)])
def update_task_note(payload: dict,
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
        return db.update_task_note(task_id, notes)
    except Exception as e:
        _log_event("error", "db", "Note persist failed", exc=e, task_id=task_id)
        raise HTTPException(status_code=500,
                            detail=f"Note persist failed — ref: {_current_rid()}") from e


# Frontend calls /tasks/update (plural) with {tasks, blocks, calendars}; keep
# /tasks/bulk_update as a flat-list alias for external tooling. Both are
# best-effort and report per-row counts in the body (no whole-batch 4xx).
@router.post("/tasks/update", response_model=BulkUpdateResult,
             dependencies=[Depends(auth.require_authenticated)])
def tasks_update(payload: TasksUpdatePayload,
                  allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Bulk-update task dates/priority attributes and persist to DB (one transaction).
    Payload: { tasks: [{ id, start_date?, end_date?, PRT_01?, PRT_02?,
                         PRODUCTION_VERSION?, base_version?, force? }],
               blocks?, calendars? }
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions }
    """
    res = _apply_task_date_updates(payload.tasks, allowed_plants=allowed_plants,
                                   atomic_optimizer=payload.atomic_optimizer,
                                   strict_conflicts=payload.strict_conflicts)
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
           "conflicts": conflicts}
    if res.get("status") == "error":
        out["error_code"] = res.get("error_code")
        out["cause"] = res.get("cause")
    return out


@router.post("/tasks/bulk_update", response_model=BulkUpdateResult,
             dependencies=[Depends(auth.require_authenticated)])
def bulk_update(tasks: list[TaskDateUpdate],
                 allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """
    Alias for /tasks/update with a flat list payload (used by external tooling/Postman).
    Payload: [{ id, start_date?, end_date?, base_version? }]
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions }

    `force` is accepted for wire compatibility but ignored (N2, 2026-09): an
    external caller may not bypass the base_version check. A stale row is
    reported in `stale`, never overwritten.
    """
    stripped = [it.model_copy(update={"force": False}) if it.force else it for it in tasks]
    res = _apply_task_date_updates(stripped, allowed_plants=allowed_plants)
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
           "conflicts": conflicts}
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
    Response: { data: [{ id, start_date, end_date, row_version }] }

    Rows outside `allowed_plants` (None for an unrestricted/admin caller) are
    silently dropped rather than 403'd — matching GET /tasks's silent-bound
    behavior for unscoped pulls. `plant` is only used for this server-side
    filter and is stripped before the response leaves — it isn't part of the
    TaskVersionRow wire contract.
    """
    rows = db.get_task_versions(payload.ids)
    if allowed_plants is not None:
        rows = [r for r in rows if r.get("plant") in allowed_plants]
    for row in rows:
        row.pop("plant", None)
        row["schedule_segments"] = _schedule_segments_to_wire(row.get("schedule_segments"))
    return {"data": rows}


@router.post("/tasks/baseline-correct", response_model=BaselineCorrectResult,
             dependencies=[Depends(auth.require_authenticated)])
def baseline_correct(payload: DueDateCorrectionPayload,
                      allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
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
        res = db.correct_due_date_baselines(items, allowed_plants=allowed_plants)
    except Exception as e:
        error_code = (db.translate_db_error(e).get("error_code")
                      if isinstance(e, psycopg.Error) else "db.error")
        _log_event("error", "db", "Due-date baseline correction failed (transaction rolled back)",
                   exc=e, error_code=error_code, count=len(items))
        return {"status": "error", "applied": 0, "persisted": 0, "skipped": len(items),
                "not_matched": 0, "versions": {}, "error_code": error_code,
                "cause": "Due-date baseline correction failed (transaction rolled back)"}
    return {"status": "ok", **res}
