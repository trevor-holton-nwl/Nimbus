"""Read-only report job types (kind 'report', mutates False). Each reads live data for ONE plant and returns a
`JobOutcome` whose `artifact` is stored by the runner (backend/jobs/artifacts.py): sections of rows for the viewer
and CSV download, plus a run summary with row counts and the resolved date window.

Status: `succeeded`, or `warning` when the report found issues (late orders, missing master data, unranked values,
missing setup pairs, unresolved distribution orders) so the Jobs health strip surfaces it. Nothing here writes to
orders or master data. No outbound delivery exists (no email/Teams channel): results live in the run viewer and CSV.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

import db
import master_data as md
from backend.jobs import artifacts, window_service, windows
from backend.jobs.registry import JobOutcome, JobType, register

REPORT_TIMEOUT_S = 120
LATE_ROW_CAP = 5000          # the artifact cap also applies; this bounds the SQL result itself


def _window_field(preset: dict, desc: str):
    return Field(default_factory=lambda: windows.DateWindow.model_validate(preset), description=desc,
                 json_schema_extra={"x-widget": "date-window"})


def _resolve(ctx, window, lookback: int = 1) -> dict:
    """Resolve a DateWindow in the plant timezone and log it; a config error fails the run as kind 'config'."""
    resolved = window_service.resolve_for_plant(ctx.plant, window, job_id=ctx.job_id, before_run_id=ctx.run_id,
                                                first_run_lookback_days=lookback)
    ctx.log("info", f"window resolved: {resolved['label']} ({resolved['timezone']}, plant time)",
            start=resolved["start"], end=resolved["end"])
    return resolved


def _fail_config(ctx, err: Exception) -> JobOutcome:
    ctx.log("error", str(err), step="window")
    return JobOutcome("failed", {"error_kind": "config", "failed_step": "window"}, str(err))


def _outcome(sections: list[dict], *, warn: bool, summary: dict, window: dict | None = None) -> JobOutcome:
    art = {"sections": sections, "summary": dict(summary)}
    s = {**summary, "row_counts": {sec["key"]: len(sec["rows"]) for sec in sections},
         "rows": sum(len(sec["rows"]) for sec in sections)}
    if window:
        s["window"] = window_service.public(window)
    return JobOutcome("warning" if warn else "succeeded", s, artifact=art)


# ------------------------------------------------------------------------------------------ what changed
class WhatChangedParams(BaseModel):
    window: windows.DateWindow = _window_field(windows.since_last_success(), "Change window")
    first_run_lookback_days: int = Field(1, ge=1, le=60, description="Days to look back on the first run")
    top_n: int = Field(20, ge=1, le=200, description="Orders to list")


def run_what_changed(ctx, p: WhatChangedParams) -> JobOutcome:
    try:
        w = _resolve(ctx, p.window, p.first_run_lookback_days)
    except windows.WindowConfigError as e:
        return _fail_config(ctx, e)
    # schedule_event.at is timestamptz: use the window's aware instants; idx_schedule_event_plant (plant, id) drives it.
    start, end = w["start"], w["end"]
    where = "plant = %s AND at >= %s::timestamptz AND at < %s::timestamptz"
    args = (ctx.plant, start, end)
    with ctx.step("counts"), db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT 'source', source, COUNT(*) FROM schedule_event WHERE {where} GROUP BY source"
                    f" UNION ALL SELECT 'actor', COALESCE(actor, ''), COUNT(*) FROM schedule_event WHERE {where}"
                    f" GROUP BY actor UNION ALL SELECT 'op', op, COUNT(*) FROM schedule_event WHERE {where} GROUP BY op",
                    args * 3)
        counts = sorted(cur.fetchall(), key=lambda r: (r[0], -r[2], r[1]))
        cur.execute(f"SELECT COUNT(*), COUNT(DISTINCT order_id) FROM schedule_event WHERE {where}", args)
        total, orders = cur.fetchone()
    with ctx.step("top orders"), db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(f"SELECT order_id, MAX(production_order), MAX(material_number), COUNT(*), MAX(at)"
                    f" FROM schedule_event WHERE {where} GROUP BY order_id ORDER BY COUNT(*) DESC, order_id LIMIT %s",
                    (*args, p.top_n))
        top = cur.fetchall()
    sections = [
        artifacts.section("counts", "Changes by source, actor and type", ["dimension", "value", "events"], counts),
        artifacts.section("top_orders", "Orders with the most changes",
                          ["order_id", "production_order", "material_number", "changes", "last_change"], top),
    ]
    return _outcome(sections, warn=False, window=w, summary={"events": int(total), "orders_changed": int(orders)})


# -------------------------------------------------------------------------------------------- late orders
class LateOrdersParams(BaseModel):
    horizon: windows.DateWindow = _window_field(windows.next_days(14), "Orders finishing in this window")
    min_days_late: float = Field(0, ge=0, le=365, description="Only orders at least this many days late")


def run_late_orders(ctx, p: LateOrdersParams) -> JobOutcome:
    try:
        w = _resolve(ctx, p.horizon)
    except windows.WindowConfigError as e:
        return _fail_config(ctx, e)
    eff_end = db._EFF_END_SQL
    q = f"""
        SELECT o.machine, o.production_order, o.material_number, {eff_end} AS finish, o.original_finish_received,
               ROUND((EXTRACT(EPOCH FROM ({eff_end} - o.original_finish_received)) / 86400)::numeric, 2) AS days_late,
               o.planning_status
          FROM orders o {db._SCHEDULE_SEGMENTS_LATERAL_SQL}
         WHERE o.plant = %s AND o.planning_status <> 'needs_planning'
           AND o.original_finish_received IS NOT NULL
           AND {eff_end} > o.original_finish_received
           AND EXTRACT(EPOCH FROM ({eff_end} - o.original_finish_received)) / 86400 >= %s
           AND {eff_end} >= %s AND {eff_end} < %s
         ORDER BY days_late DESC, o.machine, o.production_order
         LIMIT %s"""
    with ctx.step("late orders"), db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(q, (ctx.plant, float(p.min_days_late), w["start_naive"], w["end_naive"], LATE_ROW_CAP))
        rows = [[r[0], r[1], r[2], r[3], r[4], float(r[5]), r[6]] for r in cur.fetchall()]
    by_machine: dict = {}
    for machine, _po, _mat, _fin, _due, late, _st in rows:
        m = by_machine.setdefault(machine or "", [0, 0.0])
        m[0] += 1
        m[1] = max(m[1], float(late))
    summary_rows = sorted(([k, v[0], round(v[1], 2)] for k, v in by_machine.items()), key=lambda r: (-r[1], r[0]))
    sections = [
        artifacts.section("by_machine", "Late orders by machine", ["machine", "late_orders", "max_days_late"],
                          summary_rows),
        artifacts.section("orders", "Late orders",
                          ["machine", "production_order", "material_number", "finish", "due_date", "days_late",
                           "status"], rows),
    ]
    return _outcome(sections, warn=bool(rows), window=w,
                    summary={"late_orders": len(rows), "capped": len(rows) >= LATE_ROW_CAP})


# ------------------------------------------------------------------------------------ missing master data
class MissingMasterDataParams(BaseModel):
    pass


def run_missing_master_data(ctx, p: MissingMasterDataParams) -> JobOutcome:
    with ctx.step("missing master data"):
        rep = db.missing_master_data_for_plant(ctx.plant)
    rows = [[e["reason"], e.get("material_number"), e.get("production_version"), e["order_count"]]
            for e in rep["exceptions"]]
    sections = [artifacts.section("exceptions", "Missing master data",
                                  ["reason", "material_number", "production_version", "order_count"], rows)]
    return _outcome(sections, warn=rep["unmatched_pairs"] > 0,
                    summary={"unmatched_pairs": rep["unmatched_pairs"], "unmatched_orders": rep["unmatched_orders"]})


# ----------------------------------------------------------------------------------------------- coverage
class CoverageParams(BaseModel):
    sections: list[Literal["tools", "priority_lists", "setup"]] = Field(
        default_factory=lambda: ["tools", "priority_lists", "setup"], description="Sections to include")


def run_coverage(ctx, p: CoverageParams) -> JobOutcome:
    sections: list[dict] = []
    summary: dict = {}
    warn = False
    wanted = list(dict.fromkeys(p.sections))
    if "tools" in wanted:
        with ctx.step("tools"):
            ids = db.tool_ids_in_use(ctx.plant)
            counts = db.tool_usage_counts(ctx.plant, ids)
            inv = {r["tool_id"]: r for r in md.load_tool_inventory_rows(ctx.plant)}
            rows = [[t, counts.get(t, {}).get("count", 0), "yes" if t in inv else "no",
                     inv[t]["total_qty"] if t in inv else None,
                     inv[t]["out_of_service_qty"] if t in inv else None] for t in ids]
        sections.append(artifacts.section("tools", "Tools in use",
                                          ["tool_id", "orders", "in_inventory", "total_qty", "out_of_service_qty"], rows))
        summary["tools_in_use"] = len(ids)
        summary["tools_without_inventory_row"] = sum(1 for r in rows if r[2] == "no")   # informational: one copy is assumed
    if "priority_lists" in wanted:
        with ctx.step("priority lists"):
            cov = db.priority_list_coverage(
                ctx.plant, {k: v["orders_column"] for k, v in md.CONFIGURABLE_PRIORITY_FIELDS.items()})
        rows = []
        for field, per in cov.items():
            for machine, c in sorted(per.items(), key=lambda kv: (kv[0] != db.PLANT_TOTAL_COVERAGE_KEY, kv[0])):
                dv, rv = int(c["distinct_values"]), int(c["ranked_values"])
                rows.append([field, "(plant total)" if machine == db.PLANT_TOTAL_COVERAGE_KEY else (machine or "(plant-wide)"),
                             dv, rv, dv - rv])
        sections.append(artifacts.section("priority_lists", "Priority list coverage",
                                          ["field", "machine", "distinct_values", "ranked_values", "unranked_values"], rows))
        unranked = sum(r[4] for r in rows if r[1] == "(plant total)")
        summary["unranked_values"] = unranked
        warn = warn or unranked > 0
    if "setup" in wanted:
        with ctx.step("setup coverage"):
            import backend.setup.data as setup_data
            cov = setup_data.get_setup_coverage(ctx.plant)       # ~0.8 s on a large plant; totals only
        rows = [[kind, cov[kind]["total_pairs"], cov[kind]["covered_pairs"], cov[kind]["default_covered_pairs"],
                 cov[kind]["missing_pairs"]] for kind in ("observed", "reachable")]
        sections.append(artifacts.section("setup", "Setup coverage",
                                          ["scope", "total_pairs", "covered_pairs", "default_covered_pairs",
                                           "missing_pairs"], rows))
        summary["setup_missing_pairs"] = {r[0]: r[4] for r in rows}
        warn = warn or any(r[4] > 0 for r in rows)
    return _outcome(sections, warn=warn, summary=summary)


# ------------------------------------------------------------------------------------------ distribution
class DistributionParams(BaseModel):
    filter_by_window: bool = Field(False, description="Limit the aggregate view to a date window")
    window: windows.DateWindow = _window_field(windows.next_days(14), "Aggregate view window")


def run_distribution(ctx, p: DistributionParams) -> JobOutcome:
    import backend.distribution.data as dist
    w = None
    kw = {}
    if p.filter_by_window:
        try:
            w = _resolve(ctx, p.window)
        except windows.WindowConfigError as e:
            return _fail_config(ctx, e)
        kw = {"date_from": w["start_naive"], "date_to": w["end_naive"]}
    with ctx.step("unresolved"):
        un = dist.get_unresolved(ctx.plant)
    with ctx.step("aggregate"):
        agg = dist.get_aggregate(ctx.plant, **kw)
    rows = [[e["machine"], e["order_count"], e["reason"]] for e in un["exceptions"]]
    arows = [[a["production_order"], a["material_number"], a["machine"], a["quantity"], a["sum_child_quantity"],
              a["child_count"], a["queued_children"], "yes" if a["all_scheduled"] else "no", a["start"], a["finish"],
              a["due_date"]] for a in agg]
    sections = [
        artifacts.section("unresolved", "Unresolved orders", ["machine", "order_count", "reason"], rows),
        artifacts.section("aggregate", "Aggregate headers",
                          ["production_order", "material_number", "work_center", "quantity", "sum_child_quantity",
                           "children", "queued_children", "all_scheduled", "start", "finish", "due_date"], arows),
    ]
    return _outcome(sections, warn=un["unmatched_orders"] > 0, window=w,
                    summary={"unresolved_pairs": un["unmatched_pairs"], "unresolved_orders": un["unmatched_orders"],
                             "headers": len(agg)})


def _rt(key: str, label: str, model, fn) -> JobType:
    return register(JobType(key=key, label=label, params_model=model, run=fn, kind="report", mutates=False,
                            default_timeout_s=REPORT_TIMEOUT_S))


WHAT_CHANGED = _rt("report.what_changed", "What changed (schedule events)", WhatChangedParams, run_what_changed)
LATE_ORDERS = _rt("report.late_orders", "Late-order digest", LateOrdersParams, run_late_orders)
MISSING_MASTER_DATA = _rt("report.missing_master_data", "Missing master data", MissingMasterDataParams,
                          run_missing_master_data)
COVERAGE = _rt("report.coverage", "Coverage (tools, priority lists, setup)", CoverageParams, run_coverage)
DISTRIBUTION = _rt("report.distribution", "Distribution (unresolved and aggregate)", DistributionParams,
                   run_distribution)
