"""
NIMBUS 2.0 — priority-list in-process cache + the merge logic that reads it.

P5 relocation: this is one of the two narrow accessor modules called out by
docs/architecture/domain-refactor-plan.md §4 ("brain.py `PLANT_LISTS` cache
(module state + load/refresh) -> backend/priority_lists/cache.py — module-
private dict behind narrow accessors"). Extracted verbatim from brain.py.

Extended beyond the plan's literal two functions (load_priority_lists,
implicitly _reload_one_plant_lists): `apply_priority_merge` and its private
helper `_apply_priority_scope` traveled here too, and DELIBERATELY — not just
moved for tidiness. `apply_priority_merge` is PLANT_LISTS's primary *reader*
(called once per GET /tasks request in backend/scheduling/routes.py) and
PLANT_LISTS is periodically *reassigned wholesale* (not just mutated) by
load_priority_lists()/_reload_one_plant_lists() below. A module that did
`from backend.priority_lists.cache import PLANT_LISTS` and then read that
bound name later would silently keep seeing the OLD dict object after a
reload rebinds the name here — Python import semantics, not a hypothetical.
Defining the reader in the SAME module as the dict sidesteps that hazard
entirely (ordinary same-module global lookups always see the current value).
Every OTHER cross-module reader (backend/scheduling/routes.py doesn't need
one; backend/priority_lists/routes.py's GET /priority-rank-maps does) accesses
PLANT_LISTS through the module object (`from backend.priority_lists import
cache as plcache; plcache.PLANT_LISTS...`), never via a bound top-level name,
for the same reason.

pyproject.toml's ruff per-file-ignores PLW0603 key (global-statement) moves
here from "brain.py" — load_priority_lists/_reload_one_plant_lists still
reassign PLANT_LISTS/CW_LOADED_AT wholesale, same as before.
"""
import time

import pandas as pd

import db
from backend.admin_ops.diagnostics_state import _warn
from backend.admin_ops.logbuffer import _log_event

# Priority-list cache populated by load_priority_lists(); apply_priority_merge()
# reads from this instead of touching the DB per request. Keyed by RAW plant
# name (docs/scheduling_priority.md: "drop _cw_safe_name() from the lookup
# path") — NOT the _cw_safe_name() slug the old PLANT_CWS/color_wheel table
# used; that sanitizer is kept in brain.py only for the legacy-compat
# /color-wheel/* file-era disk-backfill helpers. There is no more global
# fallback wheel (GLOBAL_CW/COLOR_FILE are retired — Stage 1 decision:
# "Default tier: Per-plant only").
PLANT_LISTS: dict = {}      # { plant: { line_or_'': { field_key: {VALUE: RANK} } } }
CW_LOADED_AT: str | None = None


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
