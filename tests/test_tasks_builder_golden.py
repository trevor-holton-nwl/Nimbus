"""Golden comparison for the GET /tasks row/link/meta builder.

`legacy_build_tasks` below is a FROZEN copy of the pandas builder that shipped
before the workload-relief rewrite (backend/scheduling/routes.py, `get_tasks`
body from the DataFrame merge to the `meta` assembly). `build_tasks_payload`
(the live code) is driven through a patched DB reader with the same synthetic
rows and must produce an identical `data`, `links` and `meta`.

Documented ordering decision (the one sanctioned difference): the legacy
per-machine `sort_values("BASIC_START_DATE")` used pandas' default quicksort,
which is NOT stable, so rows sharing a start time within one machine came out
in an unspecified order. The rewrite defines the order as stable by
(machine, start with nulls last, ORDER_Y, original SQL row order). Only the
dedicated tie test relaxes the comparison, and only for that tie.

No DB needed: query readers are monkeypatched.
"""
import copy
from datetime import datetime

import pandas as pd
import pytest

from backend.admin_ops.diagnostics_state import DIAGNOSTICS
from backend.priority_lists import cache as plcache
from backend.scheduling import routes

COLS = [
    "id", "PRODUCTION_ORDER", "MATERIAL_NUMBER", "MATERIAL_DESCRIPTION", "MACHINE", "PLANT",
    "BASIC_START_DATE", "BASIC_FINISH_DATE", "PLANNING_STATUS", "PLANNING_REASON",
    "ORIGINAL_START_DATE", "ORIGINAL_END_DATE", "USER_SCHEDULED", "RUN_TIME",
    "run_time_source", "run_time_basis", "COLOR", "PRT_01", "PRT_02", "PRODUCTION_VERSION",
    "ORDER_QUANTITY_(GMEIN)", "FORM_SIZE", "NOTES", "FIRMING_INDICATOR", "FIRMED",
    "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)", "REDUCED_QUANTITY_(GMEIN)", "ORDER_CATEGORY",
    "ORDER_TYPE", "BOM_ALTERNATIVE", "BOM_USAGE", "LABOR_HOURS_(MEINH)", "MACHINE_HOURS_(MEINH)",
    "NO_OF_FTE_(MEINH)", "PARENT_ORDER", "DISTRIBUTION_LETTER", "ROW_VERSION",
    "SCHEDULE_SEGMENTS", "RUNTIME_SCHEDULE_MISMATCH", "PLACEMENT_EXCEPTION",
]


def D(day, hour=8, minute=0):
    return datetime(2026, 10, day, hour, minute)


def mk(oid, machine, start, end, **over):
    row = {c: None for c in COLS}
    row.update({
        "id": oid, "PRODUCTION_ORDER": "1000" + oid[-3:] + ".0", "MATERIAL_NUMBER": "MAT-" + oid,
        "MATERIAL_DESCRIPTION": "Desc " + oid, "MACHINE": machine, "PLANT": "P1",
        "BASIC_START_DATE": start, "BASIC_FINISH_DATE": end, "PLANNING_STATUS": "scheduled",
        "ORIGINAL_START_DATE": start, "ORIGINAL_END_DATE": end, "USER_SCHEDULED": True,
        "RUN_TIME": 4.5, "COLOR": "RED", "PRT_01": "T1", "PRT_02": "T2", "PRODUCTION_VERSION": "0001",
        "ORDER_QUANTITY_(GMEIN)": 100.0, "FIRMED": False, "FIRMING_INDICATOR": None,
        "BOM_ALTERNATIVE": 1, "BOM_USAGE": 1, "ROW_VERSION": 1000 + int(oid[-3:]),
        "SCHEDULE_SEGMENTS": [], "RUNTIME_SCHEDULE_MISMATCH": False,
    })
    row.update(over)
    return row


def legacy_segments_to_wire(raw):
    """FROZEN copy of the pre-rewrite `_schedule_segments_to_wire`: every datetime goes
    through pandas-based `_to_pydt` (the live version uses `fromisoformat` first)."""
    if not isinstance(raw, list):
        return []
    clean = []
    for index, segment in enumerate(raw, start=1):
        if not isinstance(segment, dict):
            continue
        start = routes._to_pydt(segment.get("start_date"))
        end = routes._to_pydt(segment.get("end_date"))
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


def legacy_build_tasks(rows, plant, machine=None, paging=False, total=0):
    """Frozen pre-rewrite builder (verbatim logic). Returns the response dict."""
    df = pd.DataFrame(rows, columns=COLS)
    df = df[df["BASIC_START_DATE"].notna() | df["BASIC_FINISH_DATE"].notna() |
            (df.get("PLANNING_STATUS", pd.Series("scheduled", index=df.index)) == "needs_planning")].reset_index(drop=True)
    pre_merge_count = len(df)
    df, cm_stats = plcache.apply_priority_merge(df, plant=plant)
    df = df.astype(object).where(pd.notna(df), other=None)
    data = []
    link_id_counter = 1
    links = []
    for machine_key, group_raw in df.groupby("MACHINE", dropna=False):
        prod_line = "" if pd.isna(machine_key) else machine_key
        group = group_raw.sort_values("BASIC_START_DATE")
        prev_task_id = None
        for _, row in group.iterrows():
            task_id = row["id"]
            task_text = str(row.get("MATERIAL_DESCRIPTION", "")).strip()
            if not task_text or task_text == "nan":
                task_text = f"Order {task_id[:8]}"
            orig_start = row.get("ORIGINAL_START_DATE")
            orig_end = row.get("ORIGINAL_END_DATE")
            data.append({
                "id": task_id,
                "text": task_text,
                "start_date": row["BASIC_START_DATE"].strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(row["BASIC_START_DATE"]) else None,
                "end_date": row["BASIC_FINISH_DATE"].strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(row["BASIC_FINISH_DATE"]) else None,
                "original_start_date": orig_start.strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(orig_start) else None,
                "original_end_date": orig_end.strftime("%Y-%m-%dT%H:%M:%S") if pd.notna(orig_end) else None,
                "user_scheduled": bool(row.get("USER_SCHEDULED")),
                "MACHINE": prod_line,
                "MATERIAL_DESCRIPTION": task_text,
                "MATERIAL_NUMBER": routes._clean_id(row.get("MATERIAL_NUMBER")),
                "ORDER_QUANTITY_(GMEIN)": row.get("ORDER_QUANTITY_(GMEIN)"),
                "COLOR": row.get("COLOR"),
                "PRT_01": row.get("PRT_01"),
                "PRT_02": row.get("PRT_02"),
                "PRODUCTION_VERSION": row.get("PRODUCTION_VERSION"),
                "PLANT": row.get("PLANT"),
                "ORDER": routes._clean_id(row.get("PRODUCTION_ORDER")),
                "ORDER_Y": row.get("ORDER_Y"),
                "RUN_TIME": row.get("RUN_TIME"),
                "FORM_SIZE": row.get("FORM_SIZE"),
                "notes": row.get("NOTES"),
                "ecc_firmed": row.get("FIRMING_INDICATOR") == "X",
                "firmed": bool(row.get("FIRMED")),
                "PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)": row.get("PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)"),
                "REDUCED_QUANTITY_(GMEIN)": row.get("REDUCED_QUANTITY_(GMEIN)"),
                "ORDER_CATEGORY": row.get("ORDER_CATEGORY"),
                "ORDER_TYPE": row.get("ORDER_TYPE"),
                "BOM_ALTERNATIVE": row.get("BOM_ALTERNATIVE"),
                "BOM_USAGE": row.get("BOM_USAGE"),
                "LABOR_HOURS_(MEINH)": row.get("LABOR_HOURS_(MEINH)"),
                "MACHINE_HOURS_(MEINH)": row.get("MACHINE_HOURS_(MEINH)"),
                "NO_OF_FTE_(MEINH)": row.get("NO_OF_FTE_(MEINH)"),
                "PARENT_ORDER": row.get("PARENT_ORDER"),
                "DISTRIBUTION_LETTER": row.get("DISTRIBUTION_LETTER"),
                "row_version": int(row["ROW_VERSION"]) if pd.notna(row.get("ROW_VERSION")) else None,
                "schedule_segments": legacy_segments_to_wire(row.get("SCHEDULE_SEGMENTS")),
                "runtime_schedule_mismatch": bool(row.get("RUNTIME_SCHEDULE_MISMATCH")),
                "placement_exception": row.get("PLACEMENT_EXCEPTION") or None,
                "planning_status": row.get("PLANNING_STATUS") or "scheduled",
                "planning_reason": row.get("PLANNING_REASON"),
                "run_time_source": row.get("run_time_source"),
                "run_time_basis": row.get("run_time_basis"),
            })
            if row.get("PLANNING_STATUS") == "needs_planning" or not prod_line:
                continue
            if prev_task_id:
                links.append({"id": link_id_counter, "source": prev_task_id, "target": task_id, "type": "0"})
                link_id_counter += 1
            prev_task_id = task_id
    # /tasks meta now echoes an explicit allow-list of DIAGNOSTICS keys (Wave 3 S8-8), not the whole bag.
    from backend.scheduling.routes import _TASKS_META_DIAGNOSTIC_KEYS
    meta = {k: DIAGNOSTICS[k] for k in _TASKS_META_DIAGNOSTIC_KEYS if k in DIAGNOSTICS}
    meta.update(cm_stats)
    meta["rendered"] = len(data)
    meta["link_count"] = len(links)
    meta["plant_filter_active"] = plant
    meta["machine_filter_active"] = machine
    meta["pre_color_merge_count"] = pre_merge_count
    meta["raw_row_count"] = pre_merge_count
    meta["unique_id_count"] = len(data)
    meta["total"] = total if paging else len(data)
    meta["visibility_horizon_end"] = None
    meta["frozen_horizon_end"] = None
    return {"data": data, "links": links, "meta": meta}


VOLATILE_META = {"server_now", "color_merge_ms"}


def live_build(monkeypatch, rows, plant, machine=None, limit=None):
    """Drive the real builder with a patched DB reader (works for both the
    DataFrame reader and the rewrite's row-dict reader)."""
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: (copy.deepcopy(rows), None, None))
    monkeypatch.setattr(routes.db, "count_orders", lambda **kw: 0)
    return routes.build_tasks_payload(plant, machine, limit, None, None)


def strip_volatile(meta):
    return {k: v for k, v in meta.items() if k not in VOLATILE_META}


def assert_same(live, legacy):
    assert live["data"] == legacy["data"]
    assert live["links"] == legacy["links"]
    assert strip_volatile(live["meta"]) == strip_volatile(legacy["meta"])
    assert live["meta"]["server_now"].endswith("Z")


PLANT_LISTS = {
    "P1": {
        "": {"colorWheel": {"RED": 1, "BLUE": 2, "GREEN": 3}},
        # machine-specific list REPLACES the plant-wide one for M2 (RED absent -> 999999)
        "M2": {"colorWheel": {"BLUE": 1, "GREEN": 2}},
    },
    "P2": {"": {"colorWheel": {"RED": 5}}},
}


@pytest.fixture(autouse=True)
def _lists(monkeypatch):
    monkeypatch.setattr(plcache, "PLANT_LISTS", copy.deepcopy(PLANT_LISTS))


def mixed_rows():
    seg = [
        {"sequence": 2, "start_date": "2026-10-23T08:00:00", "end_date": "2026-10-23T12:00:00"},
        {"sequence": 1, "start_date": "2026-10-22 08:00:00", "end_date": "2026-10-22T10:30:00"},
        {"sequence": "x", "start_date": "2026-10-24T08:00:00", "end_date": "2026-10-24T09:00:00"},
        {"sequence": 4, "start_date": "2026-10-25T09:00:00", "end_date": "2026-10-25T08:00:00"},  # inverted -> skipped
        {"sequence": 5, "start_date": None, "end_date": "2026-10-26T08:00:00"},                    # skipped
        "garbage",
    ]
    return [
        # M1 (plant-wide list): start order is deliberately not insertion order
        mk("o003", "M1", D(24), D(24, 12), COLOR="  blue ", PRT_01=" t9 ", PRODUCTION_VERSION=" 0002 "),
        mk("o001", "M1", D(22), D(22, 12), COLOR="Red", SCHEDULE_SEGMENTS=seg, **{"BOM_ALTERNATIVE": None}),
        mk("o002", "M1", D(23), D(23, 12), COLOR="PURPLE", NOTES="note", FIRMING_INDICATOR="X", FIRMED=True),
        mk("o004", "M1", D(25), D(25, 12), COLOR=None, MATERIAL_DESCRIPTION=None, PRT_01=None, PRT_02=None,
           PRODUCTION_VERSION=None, RUN_TIME=None, ROW_VERSION=None, USER_SCHEDULED=None, FIRMED=None),
        mk("o005", "M1", D(26), D(26, 12), MATERIAL_DESCRIPTION="   ", MATERIAL_NUMBER="123456.0",
           PLACEMENT_EXCEPTION="overtime", RUNTIME_SCHEDULE_MISMATCH=True, run_time_source="routing",
           run_time_basis={"rate": 2}, PLANNING_REASON=None),
        # M2 (machine-specific list wins): RED not in it -> 999999
        mk("o010", "M2", D(22), D(22, 12), COLOR="RED"),
        mk("o011", "M2", D(23), D(23, 12), COLOR="BLUE"),
        mk("o012", "M2", D(24), D(24, 12), COLOR="green"),
        # queued rows: null dates, kept, no links, sort last in machine
        mk("o020", "M2", None, None, PLANNING_STATUS="needs_planning",
           PLANNING_REASON={"code": "pv_missing", "message": "m", "step": "pv"}, ORIGINAL_START_DATE=D(21),
           ORIGINAL_END_DATE=D(21, 18), USER_SCHEDULED=False, RUN_TIME=None),
        # finish only (never placed): start None, kept, linked
        mk("o021", "M2", None, D(27, 12), COLOR="BLUE", USER_SCHEDULED=False),
        # no machine (None) and empty-string machine: emitted, no links, machine ''
        mk("o030", None, D(22), D(22, 12), COLOR="RED"),
        mk("o031", None, D(23), D(23, 12), COLOR="RED"),
        mk("o032", "", D(22), D(22, 12), COLOR="BLUE"),
        mk("o033", "", D(23), D(23, 12), COLOR="BLUE"),
        # no dates and not queued: DROPPED
        mk("o040", "M1", None, None),
        # plant without lists
        mk("o050", "M9", D(22), D(22, 12), PLANT="P3", COLOR="RED", **{"ORDER_QUANTITY_(GMEIN)": None}),
        mk("o051", "M9", D(23), D(23, 12), PLANT="P3", COLOR="BLUE"),
    ]


def test_golden_plant_scoped_mixed(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    assert_same(live_build(monkeypatch, rows, "P1"), legacy_build_tasks(rows, "P1"))


def test_golden_all_plants_path(monkeypatch):
    rows = mixed_rows() + [mk("o060", "M1", D(22), D(22, 12), PLANT="P2", COLOR="RED"),
                           mk("o061", "M1", D(23), D(23, 12), PLANT="P2", COLOR="BLUE")]
    # unscoped pulls need ?limit= (paging) -> meta.total comes from count_orders (patched to 0)
    assert_same(live_build(monkeypatch, rows, None, limit=10000),
                legacy_build_tasks(rows, None, paging=True, total=0))


def test_golden_machine_filter_meta(monkeypatch):
    rows = [r for r in mixed_rows() if r["MACHINE"] == "M2"]
    assert_same(live_build(monkeypatch, rows, "P1", machine="M2"), legacy_build_tasks(rows, "P1", machine="M2"))


def test_golden_all_rows_undated_is_not_the_empty_meta_path(monkeypatch):
    rows = [mk("o070", "M1", None, None), mk("o071", "M2", None, None)]
    live = live_build(monkeypatch, rows, "P1")
    legacy = legacy_build_tasks(rows, "P1")
    assert_same(live, legacy)
    assert live["data"] == [] and live["meta"]["rendered"] == 0
    assert "loaded_at" in live["meta"] or "loaded_at" not in DIAGNOSTICS  # full DIAGNOSTICS meta, not empty_meta
    assert "pre_color_merge_count" in live["meta"] and live["meta"]["pre_color_merge_count"] == 0


def test_golden_no_rows_uses_empty_envelope(monkeypatch):
    live = live_build(monkeypatch, [], "P1")
    assert live["data"] == [] and live["links"] == []
    assert live["meta"]["rendered"] == 0 and live["meta"]["missed_colors"] == []
    assert live["meta"]["server_now"].endswith("Z")
    assert live["meta"]["source_file"] == "postgres://nimbus/orders"


def test_golden_missed_colors_and_default_rank(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    live = live_build(monkeypatch, rows, "P1")
    by_id = {t["id"]: t for t in live["data"]}
    assert by_id["o002"]["ORDER_Y"] == 999999          # PURPLE not listed
    assert by_id["o010"]["ORDER_Y"] == 999999          # M2 list replaces plant-wide: RED absent
    assert by_id["o011"]["ORDER_Y"] == 1               # M2 list rank
    assert by_id["o001"]["ORDER_Y"] == 1               # plant-wide RED
    assert by_id["o003"]["COLOR"] == "BLUE" and by_id["o003"]["PRT_01"] == "T9"
    assert by_id["o003"]["PRODUCTION_VERSION"] == "0002"
    assert by_id["o004"]["COLOR"] is None              # null colour stays null, not "NONE"/"nan"
    assert by_id["o004"]["text"] == "None"             # legacy quirk: str(None), pinned
    assert "PURPLE" in live["meta"]["missed_colors"] and None not in live["meta"]["missed_colors"]
    assert live["meta"]["color_merge_misses"] >= 3


def test_golden_row_version_and_links_contract(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    live = live_build(monkeypatch, rows, "P1")
    by_id = {t["id"]: t for t in live["data"]}
    assert by_id["o001"]["row_version"] == 1001 and isinstance(by_id["o001"]["row_version"], int)
    assert by_id["o004"]["row_version"] is None
    ids_in_links = {k["source"] for k in live["links"]} | {k["target"] for k in live["links"]}
    assert not ids_in_links & {"o020", "o030", "o031", "o032", "o033", "o040"}
    assert "o021" in ids_in_links
    assert "o040" not in by_id


def test_golden_group_order_sorted_machine_null_last(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    live = live_build(monkeypatch, rows, "P1")
    machines = []
    for t in live["data"]:
        if not machines or machines[-1] != t["MACHINE"]:
            machines.append(t["MACHINE"])
    # '' sorts first; a NULL machine group comes last (both emit MACHINE '')
    assert machines == ["", "M1", "M2", ""], machines
    ids = [t["id"] for t in live["data"]]
    assert ids[:2] == ["o032", "o033"] and ids[-2:] == ["o030", "o031"]


def test_tie_order_is_stable_by_order_y_then_input_order(monkeypatch):
    """Same machine + same start: legacy order unspecified; new order is
    (ORDER_Y, original row order). Legacy is compared as a set for the tie."""
    t = D(22)
    rows = [
        mk("o101", "M1", t, D(22, 12), COLOR="GREEN"),   # rank 3
        mk("o102", "M1", t, D(22, 12), COLOR="BLUE"),    # rank 2
        mk("o103", "M1", t, D(22, 12), COLOR="RED"),     # rank 1
        mk("o104", "M1", t, D(22, 12), COLOR="RED"),     # rank 1, later in input
        mk("o105", "M1", t, D(22, 12), COLOR="ZZZ"),     # 999999
        mk("o106", "M1", D(21), D(21, 12), COLOR="ZZZ"),
    ]
    live = live_build(monkeypatch, rows, "P1")
    legacy = legacy_build_tasks(rows, "P1")
    assert [d["id"] for d in live["data"]] == ["o106", "o103", "o104", "o102", "o101", "o105"]
    key = lambda d: d["id"]  # noqa: E731
    assert sorted(live["data"], key=key) == sorted(legacy["data"], key=key)
    assert len(live["links"]) == len(legacy["links"]) == 5
    assert strip_volatile(live["meta"]) == strip_volatile(legacy["meta"])


@pytest.mark.parametrize("val", [
    "2026-10-22T08:00:00", "2026-10-22 08:00:00", "2026-10-22T08:00:00.123456", "2026-10-22T08:00:00Z",
    "2026-10-22T08:00:00+02:00", "2026-10-22", datetime(2026, 10, 22, 8), "10/22/2026 08:00", "garbage", "", None,
])
def test_fast_pydt_matches_to_pydt(val):
    assert routes._fast_pydt(val) == routes._to_pydt(val)


def test_builder_does_not_mutate_input_rows(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    before = copy.deepcopy(rows)
    live_build(monkeypatch, rows, "P1")
    assert rows == before
    out = routes._build_task_rows(rows, "P1")
    assert out[3] == len([r for r in rows if r["BASIC_START_DATE"] or r["BASIC_FINISH_DATE"] or r["PLANNING_STATUS"] == "needs_planning"])
    assert rows == before


@pytest.mark.parametrize("raw, expected", [
    ("X", True), ("x", True), (" X ", True), (" x\t", True),
    ("", False), (None, False), ("N", False), ("XX", False),
])
def test_ecc_firmed_is_normalised_strip_upper(monkeypatch, raw, expected):
    """Universal firm B4: ingest stores the indicator raw (Excel) or only stripped (SAP staging), so the wire flag
    strips + uppercases like Send's firm rule. Display only (it never locks an order). Not a legacy-parity case:
    the frozen legacy copy compares `== "X"` exactly."""
    live = live_build(monkeypatch, [mk("o001", "M1", D(22), D(22, 12), FIRMING_INDICATOR=raw)], "P1")
    assert live["data"][0]["ecc_firmed"] is expected
