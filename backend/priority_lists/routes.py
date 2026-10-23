"""
NIMBUS 2.0 — priority-lists domain routes: the generic per-field priority-list
upload/read/delete family plus the legacy color-wheel-shaped compatibility
endpoints, and the /priority-fields registry + /priority-rank-maps optimizer
read.

P5 relocation: pure move from brain.py (lines 2166-2510 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and response/request shapes are byte-identical to before. Local helpers
(`_resolve_priority_list_columns`, `_persist_priority_list`,
`ROW_ORDER_SENTINEL`) are used only within this domain and moved along with
their callers. The `RANKABLE_FIELDS`/`CONFIGURABLE_PRIORITY_FIELDS` registry
itself stays in root master_data.py (deferred extraction — see
docs/architecture/domain-refactor-plan.md §2 row 7 and MIGRATION.md).
"""
import io
import os
from datetime import datetime, timezone

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

import db
import master_data as md
from backend.admin_ops.logbuffer import _log_event
from backend.priority_lists import cache as plcache
from backend.priority_lists.audit_log import _cw_append_audit
from backend.security import auth
from backend.security.auth import require_api_key

router = APIRouter()
require_admin = auth.require_admin

# Maximum upload file size: 50 MB by default, overridable via NIMBUS_MAX_UPLOAD_BYTES env var.
NIMBUS_MAX_UPLOAD_BYTES = int(os.environ.get("NIMBUS_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))

# Explicit "use row order, do NOT auto-detect a rank column" marker sent by the
# mapping modal's "— use row order —" option (frontend/index.html
# #pl-mapping-rank-col + PriorityListMapping.open in
# frontend/plant-and-administration.mts). Must stay in sync with that <option>'s
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
        "ts": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z", "user": user, "action": action, "plant": plant,
        "details": {"field_key": field_key, "machine": machine, "filename": filename,
                    "row_count": stored_count, "file_row_count": file_row_count,
                    "replaced": is_replace},
    })
    plcache._reload_one_plant_lists(plant)
    return is_replace


@router.get("/priority-fields")
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


@router.get("/priority-rank-maps")
def get_priority_rank_maps(
        plant: str = Query(..., min_length=1),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """In-memory rank-map read for the optimizer's hot path (Stage 3) — the
    rank data itself is a zero-DB-hit read of the priority-lists cache
    (already kept current by every priority-list upload/delete (Stage 2) and
    POST /reload); the plant-authorization gate below does its own one-row
    user_security lookup when an identity header is present, same as every
    sibling in this block. Shape: {machine_or_empty: {field_key: {VALUE: RANK}}}
    — the exact native shape of the cache, no reshaping, since this runs on
    every optimize call and every alert auto-fix.

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
    return plcache.PLANT_LISTS.get(plant, {})


@router.get("/priority-lists")
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


@router.post("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_priority_list(
        plant: str, field_key: str, request: Request, file: UploadFile = File(...),
        machine: str = Form(default=""), value_column: str | None = Form(default=None),
        rank_column: str | None = Form(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Generic priority-list upload (Stage 2) — one file per plant [+ optional
    machine override]. See docs/superpowers/plans/archive/2026-08-11-priority-lists-stage-2.md
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
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
    try:
        df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
    except Exception as e:
        raise HTTPException(status_code=400, detail="Could not parse the uploaded file as .xlsx") from e
    if df.empty:
        raise HTTPException(status_code=400, detail="Uploaded file has no rows")

    # Threadpool: the resolver makes a blocking DB call (known_line_codes_for_plant);
    # HTTPException(400) it raises propagates unchanged through run_in_threadpool.
    resolved = await run_in_threadpool(
        _resolve_priority_list_columns,
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


@router.get("/priority-list/{plant}/{field_key}")
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


_TEMPLATE_HOW_TO = [
    "How to use this priority-list template",
    "",
    "1. Sheet 'List' has one row per value your plant's orders use (plus any value already ranked).",
    "2. Fill RANK: 1 runs first, 2 next, and so on. A blank RANK runs after every ranked value.",
    "3. Delete rows you do not care about; values left out are treated like a blank RANK.",
    "4. Values are matched case-insensitively. Do not rename the column headers.",
    "5. Upload the file back on Master Data > Plant > Optimization. One file covers the whole plant;",
    "   for a single machine use the card's '+ add line override'.",
]


def _build_priority_template(value_header: str, ranked: dict, order_values: list[str]) -> bytes:
    """xlsx bytes for the template: sheet 'List' (<value_header>, RANK) and an
    ignored English 'How to use' sheet. Ranked entries first in rank order, then
    every other value alphabetical with a blank RANK. The headers are exactly
    what _resolve_priority_list_columns auto-detects, so a re-upload never opens
    the mapping modal."""
    ranked_rows = sorted(((v, r) for v, r in ranked.items() if r is not None), key=lambda x: (x[1], x[0]))
    ranked_keys = {v for v, _ in ranked_rows}
    rest = sorted(({*order_values, *ranked.keys()}) - ranked_keys)
    rows = [{value_header: v, "RANK": r} for v, r in ranked_rows] + [{value_header: v, "RANK": None} for v in rest]
    df = pd.DataFrame(rows, columns=[value_header, "RANK"])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        df.to_excel(xw, sheet_name="List", index=False)
        pd.DataFrame({"How to use": _TEMPLATE_HOW_TO[2:]}).to_excel(xw, sheet_name="How to use", index=False)
        xw.sheets["List"].column_dimensions["A"].width = 28
        xw.sheets["How to use"].column_dimensions["A"].width = 100
    return buf.getvalue()


@router.get("/priority-list/{plant}/{field_key}/template")
async def get_priority_list_template(
        plant: str, field_key: str,
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Prefilled .xlsx for the field's upload: every value this plant's orders
    use, with the current plant-wide rank filled in when a list exists. Not
    admin-gated — it exposes nothing beyond GET /priority-list/{plant}/{field_key}."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    spec = md.CONFIGURABLE_PRIORITY_FIELDS.get(field_key)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")

    def _build() -> bytes:
        row = db.get_priority_list(plant, field_key, line="")
        values = db.distinct_order_values(plant, spec["orders_column"])
        return _build_priority_template(spec["mp_column"].upper(), row["entries"] if row else {}, values)

    data = await run_in_threadpool(_build)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{field_key}-template-{plant}.xlsx"'},
    )


@router.delete("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
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
    ts = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "priority_list_delete", "plant": plant,
        "details": {"field_key": field_key, "machine": machine, "filename": res.get("filename") or "unknown"},
    })
    plcache._reload_one_plant_lists(plant)
    return {"status": "ok"}


# =========================
# COLOR WHEEL ENDPOINTS (legacy-compat — now read/write priority_list rows
# with field_key='colorWheel', line='' — docs/scheduling_priority.md Stage 1
# "Storage" decision. Response shapes are UNCHANGED so ColorWheelViewer and
# the Admin Cockpit coverage panel keep working untouched. The underlying
# color_wheel table is left in place, unread from here on.)
# =========================

@router.post("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
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
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    raw = await file.read()
    if len(raw) > NIMBUS_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Upload exceeds maximum allowed size of {NIMBUS_MAX_UPLOAD_BYTES} bytes")
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

    resolved = await run_in_threadpool(
        _resolve_priority_list_columns, df, plant, spec, reject_conflicts=False,
    )
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


@router.get("/color-wheel/{plant}")
def get_color_wheel(plant: str,
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Return the stored color wheel for a plant as sorted JSON entries."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
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


@router.delete("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def delete_color_wheel(plant: str, request: Request,
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Delete a plant's stored color wheel."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    res = db.delete_priority_list(plant, "colorWheel", line="")
    if res is None:
        return {"status": "not_found"}
    ts = datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "color_wheel_delete", "plant": plant,
        "details": {"filename": res.get("filename") or "unknown"},
    })
    # Row already removed above — drop just this plant's cache entry.
    plcache._reload_one_plant_lists(plant)
    return {"status": "ok"}
