"""Read-only report job types (kind 'report', mutates False). Each reads live data for ONE plant and returns a
`JobOutcome` whose `artifact` is stored by the runner (backend/jobs/artifacts.py): sections of typed rows for the viewer
and CSV download, plus a run summary with row counts and the resolved date window.

Status (owner ruling 2026-10-29): REPORT CONTENT NEVER CHANGES RUN STATUS. A report that ran to the end is
`succeeded` with its counts in the summary and tiles; `failed` only when the run did not complete. A report type with a
"finding count" (late orders, missing master data, coverage, distribution) takes an optional `warn_if_over` integer
(default off): the run becomes `warning` when that count EXCEEDS it. `report.what_changed` has none and never warns.
Nothing here writes to orders or master data (the SQL this module runs is read-only; pinned by a test that scans this
file, and our own transactions are opened READ ONLY). No outbound delivery exists: results live in the run viewer and CSV.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Literal

from pydantic import BaseModel, Field

import db
import master_data as md
from backend.jobs import artifacts, due, window_service, windows
from backend.jobs.artifacts import col
from backend.jobs.registry import JobOutcome, JobType, register

REPORT_TIMEOUT_S = 120
LATE_ROW_CAP = 5000          # detail rows shown per section; the totals and the by-machine roll-up cover the full set
DIST_ROW_CAP = 2000
PLANT_TOTAL = "__plant_total__"      # sentinels the client translates (jobs.a.sentinel.*)
PLANT_WIDE = "__plant_wide__"
SAFETY_MARGIN_NOTE_S = windows.LAST_SUCCESS_MARGIN_S


def _window_field(preset: dict, desc: str):
    return Field(default_factory=lambda: windows.DateWindow.model_validate(preset), description=desc,
                 json_schema_extra={"x-widget": "date-window"})


def _warn_field(what: str):
    return Field(None, ge=0, le=1_000_000, description=f"Mark the run as a warning when {what} exceeds this (empty = never)")


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


def _over(count: int, threshold: int | None) -> bool:
    return threshold is not None and count > threshold


def _outcome(sections: list[dict], *, summary: dict, window: dict | None = None, count: int | None = None,
             warn_if_over: int | None = None) -> JobOutcome:
    """`succeeded`, or `warning` only when the report's finding `count` exceeds `warn_if_over`."""
    art = {"sections": sections, "summary": dict(summary)}
    s = {**summary, "row_counts": {sec["key"]: len(sec["rows"]) for sec in sections},
         "rows": sum(len(sec["rows"]) for sec in sections)}
    if count is not None:
        s["findings"] = count
    if warn_if_over is not None:
        s["warn_if_over"] = warn_if_over
    if window:
        s["window"] = window_service.public(window)
    warn = count is not None and _over(count, warn_if_over)
    return JobOutcome("warning" if warn else "succeeded", s, artifact=art)


def _ro(conn) -> None:
    """Open the current transaction READ ONLY (a report can never write, whatever its SQL says)."""
    conn.execute("SET TRANSACTION READ ONLY")


# ------------------------------------------------------------------------------------------ what changed
# Planner-facing categories over the raw schedule_event.source values (the raw source stays as a detail row).
SOURCE_CATEGORY = {
    "drag": "planner", "keyboard": "planner", "grid": "planner", "inspector": "planner", "alert_fix": "planner",
    "optimizer": "optimizer",
    "sap_ingest": "ingest", "excel": "ingest", "excel_upload": "ingest", "sap_reset": "ingest",
    "routing_hold": "routing", "routing_recompute": "routing", "master_data_stamp": "routing",
    "purge": "purge", "sap_vanish": "purge",
    "distribution": "distribution",
}
CATEGORY_ORDER = ["planner", "optimizer", "ingest", "routing", "purge", "distribution", "other"]


class WhatChangedParams(BaseModel):
    window: windows.DateWindow = _window_field(windows.since_last_success(), "Change window")
    first_run_lookback_days: int = Field(1, ge=1, le=60, description="Days to look back on the first run")
    top_n: int = Field(20, ge=1, le=200, description="Orders to list")


_WHAT_CHANGED_SQL = """
WITH ev AS MATERIALIZED (
    SELECT order_id, production_order, material_number, source, COALESCE(actor, '') AS actor, op, at
      FROM schedule_event
     WHERE plant = %s AND at >= %s::timestamptz AND at < %s::timestamptz),
cats AS (
    SELECT GROUPING(source, actor, op) AS g, source, actor, op, COUNT(*) AS n, COUNT(DISTINCT order_id) AS orders
      FROM ev GROUP BY GROUPING SETS ((source), (actor), (op), ())),
tops AS (
    SELECT MAX(production_order) AS po, MAX(material_number) AS mat, COUNT(*) AS n, MAX(at) AS at
      FROM ev GROUP BY order_id ORDER BY COUNT(*) DESC, MAX(production_order) LIMIT %s)
SELECT 'c', g, source, actor, op, n, orders, NULL::text, NULL::text, NULL::timestamp FROM cats
UNION ALL
SELECT 't', 0, NULL, NULL, NULL, n, 0, po, mat, (at AT TIME ZONE %s) FROM tops
"""


def run_what_changed(ctx, p: WhatChangedParams) -> JobOutcome:
    try:
        w = _resolve(ctx, p.window, p.first_run_lookback_days)
    except windows.WindowConfigError as e:
        return _fail_config(ctx, e)
    start, end = w["start_aware"], w["end_aware"]
    retention = int(md.get_schedule_event_retention_days())
    truncated_window = start < w["now_aware"] - timedelta(days=retention)
    # schedule_event.at is timestamptz; idx_schedule_event_plant_at (plant, at DESC) drives the one scan below.
    with ctx.step("changes"), db._pool.connection() as conn:
        _ro(conn)
        with conn.cursor() as cur:
            cur.execute(_WHAT_CHANGED_SQL, (ctx.plant, start, end, p.top_n, w["timezone"]))
            fetched = cur.fetchall()
    by_dim: dict[int, list] = {3: [], 5: [], 6: []}
    total = orders = 0
    top = []
    for kind, g, source, actor, op, n, ords, po, mat, at in fetched:
        if kind == "t":
            top.append((po, mat, int(n), at))
        elif g == 7:
            total, orders = int(n), int(ords)
        else:
            by_dim[int(g)].append((source if g == 3 else actor if g == 5 else op, int(n)))
    cat_totals: dict[str, int] = {}
    for src, n in by_dim[3]:
        c = SOURCE_CATEGORY.get(src, "other")
        cat_totals[c] = cat_totals.get(c, 0) + n
    counts = [["category", c, "", cat_totals[c]] for c in CATEGORY_ORDER if c in cat_totals]
    counts += [["source", src, SOURCE_CATEGORY.get(src, "other"), n] for src, n in sorted(by_dim[3], key=lambda r: (-r[1], r[0]))]
    counts += [["actor", a, "", n] for a, n in sorted(by_dim[5], key=lambda r: (-r[1], r[0]))]
    counts += [["op", o, "", n] for o, n in sorted(by_dim[6], key=lambda r: (-r[1], r[0]))]
    top.sort(key=lambda r: (-r[2], r[0] or ""))
    sections = []
    if truncated_window:
        sections.append(artifacts.section("notes", "Notes", [col("code"), col("detail", "number")],
                                          [["window_truncated", retention]]))
    sections += [
        artifacts.section("counts", "Changes by category, source, actor and type",
                          [col("dimension"), col("value"), col("category"), col("events", "number")], counts),
        artifacts.section("top_orders", "Orders with the most changes",
                          [col("production_order"), col("material_number"), col("changes", "number"),
                           col("last_change", "datetime")], [[po, mat, n, at] for po, mat, n, at in top]),
    ]
    summary = {"events": total, "orders_changed": orders}
    if truncated_window:
        summary.update({"window_truncated": True, "retention_days": retention})
    if p.window.mode == "rolling" and p.window.rolling.anchor == "last_success":
        summary["safety_margin_s"] = SAFETY_MARGIN_NOTE_S      # the window ends this long before the run started
    return _outcome(sections, window=w, summary=summary)


# -------------------------------------------------------------------------------------------- late orders
class LateOrdersParams(BaseModel):
    horizon: windows.DateWindow = _window_field(windows.next_days(14), "Orders due in this window (plus everything already overdue)")
    min_days_late: float = Field(0, ge=0, le=365, description="Only orders at least this many days late")
    warn_if_over: int | None = _warn_field("the number of late orders")


def late_orders_compute(rows, close_for, now: datetime, start: datetime, end: datetime, min_days_late: float = 0.0):
    """The app's rule over (machine, production_order, material_number, finish|None, due_raw, status) rows.

    Returns (late, queued): `late` = placed orders whose finish is after their due instant and whose due falls before
    the window end (bucket 'overdue' when due is before the window start, else 'window'); `queued` = unplaced
    (needs_planning) orders due before the window end, 'past_due' when the plant clock is past the due instant
    (counted late against `now`, like the app) else 'due_soon'. Each item is a dict.
    """
    late, queued, memo = [], [], {}
    for machine, po, mat, finish, raw, status in rows:
        key = (machine, raw)
        di = memo.get(key)
        if di is None:
            di = memo[key] = due.due_instant(raw, lambda d, m=machine: close_for(m, d))
        if di >= end:
            continue                                   # not due inside this horizon
        if status == "needs_planning":
            days = (now - di).total_seconds() / 86400
            if days > 0 and days < min_days_late:
                continue
            queued.append({"machine": machine, "production_order": po, "material_number": mat, "due": di,
                           "days_late": round(max(days, 0.0), 2), "state": "past_due" if days > 0 else "due_soon",
                           "bucket": "overdue" if di < start else "window"})
            continue
        if finish is None or not finish > di:
            continue
        days = (finish - di).total_seconds() / 86400
        if days < min_days_late:
            continue
        late.append({"machine": machine, "production_order": po, "material_number": mat, "finish": finish, "due": di,
                     "days_late": round(days, 2), "status": status, "bucket": "overdue" if di < start else "window"})
    return late, queued


def run_late_orders(ctx, p: LateOrdersParams) -> JobOutcome:
    try:
        w = _resolve(ctx, p.horizon)
    except windows.WindowConfigError as e:
        return _fail_config(ctx, e)
    now, start, end = w["now_naive"], w["start_naive"], w["end_naive"]
    today = datetime.combine(now.date(), time(0, 0))
    eff_end = db._EFF_END_SQL
    # A SUPERSET of the late set (the due instant is never before the raw due date); the exact rule runs in Python
    # because a date-only due is the close of the line's working window (see backend/jobs/due.py). Like the app's alert
    # scan, a placed order that finished before today is history, not overdue.
    q = f"""
        SELECT o.machine, o.production_order, o.material_number,
               CASE WHEN o.planning_status = 'needs_planning' THEN NULL ELSE {eff_end} END AS finish,
               o.original_finish_received, o.planning_status
          FROM orders o {db._SCHEDULE_SEGMENTS_LATERAL_SQL}
         WHERE o.plant = %s AND o.original_finish_received IS NOT NULL AND o.original_finish_received < %s
           AND (o.planning_status = 'needs_planning'
                OR ({eff_end} > o.original_finish_received AND {eff_end} >= %s))"""
    with ctx.step("load orders"), db._pool.connection() as conn:
        _ro(conn)
        with conn.cursor() as cur:
            cur.execute(q, (ctx.plant, end, today))
            rows = cur.fetchall()
        cal = md.load_plant_calendar(ctx.plant)
    close_for = due.make_close_for(cal)
    with ctx.step("apply due rule"):
        late, queued = late_orders_compute(rows, close_for, now, start, end, float(p.min_days_late))
    late.sort(key=lambda r: (-r["days_late"], r["machine"] or "", r["production_order"] or ""))
    queued.sort(key=lambda r: (r["state"] != "past_due", -r["days_late"], r["due"], r["production_order"] or ""))
    by_machine: dict = {}
    for r in late:
        m = by_machine.setdefault(r["machine"] or "", [0, 0.0])
        m[0] += 1
        m[1] = max(m[1], r["days_late"])
    summary_rows = sorted(([k, v[0], round(v[1], 2)] for k, v in by_machine.items()), key=lambda r: (-r[1], r[0]))
    shown, qshown = late[:LATE_ROW_CAP], queued[:LATE_ROW_CAP]
    sections = [
        artifacts.section("by_machine", "Late orders by machine",
                          [col("machine"), col("late_orders", "number"), col("max_days_late", "number")], summary_rows),
        artifacts.section("orders", "Late orders",
                          [col("bucket"), col("machine"), col("production_order"), col("material_number"),
                           col("finish", "datetime"), col("due_date", "datetime"), col("days_late", "number"),
                           col("status")],
                          [[r["bucket"], r["machine"], r["production_order"], r["material_number"], r["finish"], r["due"],
                            r["days_late"], r["status"]] for r in shown]),
        artifacts.section("queued", "Queued orders past or near due",
                          [col("state"), col("bucket"), col("machine"), col("production_order"), col("material_number"),
                           col("due_date", "datetime"), col("days_late", "number")],
                          [[r["state"], r["bucket"], r["machine"], r["production_order"], r["material_number"], r["due"],
                            r["days_late"]] for r in qshown]),
    ]
    past_due = sum(1 for r in queued if r["state"] == "past_due")
    summary = {"late_orders": len(late), "late_orders_shown": len(shown), "capped": len(late) > len(shown),
               "overdue_orders": sum(1 for r in late if r["bucket"] == "overdue"),
               "queued_past_due": past_due, "queued_due_soon": len(queued) - past_due,
               "queued_shown": len(qshown), "queued_capped": len(queued) > len(qshown),
               "due_rule": "working_window_close"}
    return _outcome(sections, window=w, summary=summary, count=len(late) + past_due, warn_if_over=p.warn_if_over)


# ------------------------------------------------------------------------------------ missing master data
class MissingMasterDataParams(BaseModel):
    warn_if_over: int | None = _warn_field("the number of unmatched material / production version pairs")


def run_missing_master_data(ctx, p: MissingMasterDataParams) -> JobOutcome:
    with ctx.step("missing master data"):
        rep = db.missing_master_data_for_plant(ctx.plant)
    exc = sorted(rep["exceptions"], key=lambda e: (-int(e["order_count"]), e["reason"], str(e.get("material_number") or "")))
    rows = [[e["reason"], e.get("material_number"), e.get("production_version"), e["order_count"]] for e in exc]
    sections = [artifacts.section("exceptions", "Missing master data",
                                  [col("reason"), col("material_number"), col("production_version"),
                                   col("order_count", "number")], rows)]
    return _outcome(sections, count=rep["unmatched_pairs"], warn_if_over=p.warn_if_over,
                    summary={"unmatched_pairs": rep["unmatched_pairs"], "unmatched_orders": rep["unmatched_orders"]})


# ----------------------------------------------------------------------------------------------- coverage
class CoverageParams(BaseModel):
    sections: list[Literal["tools", "priority_lists", "setup"]] = Field(
        default_factory=lambda: ["tools", "priority_lists", "setup"], description="Sections to include")
    warn_if_over: int | None = _warn_field("the findings (unranked values, missing observed setup pairs, tools with no usable copy)")


def _setup_active(plant: str) -> bool:
    with db._pool.connection() as conn:
        _ro(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT COALESCE(bool_and(COALESCE(setup_active, TRUE)), TRUE) FROM plants WHERE plant = %s", (plant,))
            r = cur.fetchone()
    return bool(r[0]) if r else True


def run_coverage(ctx, p: CoverageParams) -> JobOutcome:
    sections: list[dict] = []
    notes: list[list] = []
    summary: dict = {}
    findings = 0
    wanted = list(dict.fromkeys(p.sections))
    if "tools" in wanted:
        with ctx.step("tools"):
            ids = db.tool_ids_in_use(ctx.plant)
            counts = db.tool_usage_counts(ctx.plant, ids)
            inv = {r["tool_id"]: r for r in md.load_tool_inventory_rows(ctx.plant)}
            rows = []
            for t in ids:
                row = inv.get(t)
                # a tool with no inventory row is assumed to have ONE copy (Tool Inventory rule)
                usable = max(0, int(row["total_qty"]) - int(row["out_of_service_qty"])) if row else 1
                rows.append([t, counts.get(t, {}).get("count", 0), row is not None,
                             row["total_qty"] if row else None, row["out_of_service_qty"] if row else None,
                             usable, row is not None and usable == 0])
        sections.append(artifacts.section("tools", "Tools in use",
                                          [col("tool_id"), col("orders", "number"), col("in_inventory", "bool"),
                                           col("total_qty", "number"), col("out_of_service_qty", "number"),
                                           col("usable_qty", "number"), col("no_usable_copy", "bool")], rows))
        summary["tools_in_use"] = len(ids)
        summary["tools_without_inventory_row"] = sum(1 for r in rows if not r[2])   # informational: one copy is assumed
        summary["tools_without_usable_copy"] = sum(1 for r in rows if r[6])
        findings += summary["tools_without_usable_copy"]
    if "priority_lists" in wanted:
        with ctx.step("priority lists"):
            cov = db.priority_list_coverage(
                ctx.plant, {k: v["orders_column"] for k, v in md.CONFIGURABLE_PRIORITY_FIELDS.items()})
        rows = []
        for field, per in cov.items():
            total = per.get(db.PLANT_TOTAL_COVERAGE_KEY)
            if total is not None and int(total["ranked_values"]) == 0:
                notes.append(["no_list", field])           # no ranked values and no list: not a list to be incomplete
                continue
            for machine, c in sorted(per.items(), key=lambda kv: (kv[0] != db.PLANT_TOTAL_COVERAGE_KEY, kv[0])):
                dv, rv = int(c["distinct_values"]), int(c["ranked_values"])
                rows.append([field, PLANT_TOTAL if machine == db.PLANT_TOTAL_COVERAGE_KEY else (machine or PLANT_WIDE),
                             dv, rv, dv - rv])
        sections.append(artifacts.section("priority_lists", "Priority list coverage",
                                          [col("field"), col("machine"), col("distinct_values", "number"),
                                           col("ranked_values", "number"), col("unranked_values", "number")], rows))
        unranked = sum(r[4] for r in rows if r[1] == PLANT_TOTAL)
        summary["unranked_values"] = unranked
        findings += unranked
    if "setup" in wanted:
        if not _setup_active(ctx.plant):
            notes.append(["setup_off", ""])
            summary["setup_skipped"] = "setup_off"
        else:
            with ctx.step("setup coverage"):
                import backend.setup.data as setup_data
                cov = setup_data.get_setup_coverage(ctx.plant)       # ~0.8 s on a large plant; totals only
            rows = [[kind, cov[kind]["total_pairs"], cov[kind]["covered_pairs"], cov[kind]["default_covered_pairs"],
                     cov[kind]["missing_pairs"]] for kind in ("observed", "reachable")]
            sections.append(artifacts.section("setup", "Setup coverage",
                                              [col("scope"), col("total_pairs", "number"), col("covered_pairs", "number"),
                                               col("default_covered_pairs", "number"), col("missing_pairs", "number")], rows))
            summary["setup_missing_pairs"] = {r[0]: r[4] for r in rows}
            findings += rows[0][4]          # observed pairs only: `reachable` is a what-if, never a finding
    if notes:
        sections.append(artifacts.section("notes", "Notes", [col("code"), col("detail")], notes))
    return _outcome(sections, summary=summary, count=findings, warn_if_over=p.warn_if_over)


# ------------------------------------------------------------------------------------------ distribution
class DistributionParams(BaseModel):
    filter_by_window: bool = Field(False, description="Limit the aggregate view to a date window")
    window: windows.DateWindow = _window_field(windows.next_days(14), "Aggregate view window")
    warn_if_over: int | None = _warn_field("the number of unresolved orders")


def run_distribution(ctx, p: DistributionParams) -> JobOutcome:
    import backend.distribution.data as dist
    w = None
    kw = {}
    if p.filter_by_window:
        try:
            w = _resolve(ctx, p.window)
        except windows.WindowConfigError as e:
            return _fail_config(ctx, e)
        # get_aggregate compares `<= date_to`; the window end is exclusive, so pass its last microsecond.
        kw = {"date_from": w["start_naive"], "date_to": w["end_naive"] - timedelta(microseconds=1)}
    with ctx.step("unresolved"):
        un = dist.get_unresolved(ctx.plant)
    with ctx.step("aggregate"):
        agg = dist.get_aggregate(ctx.plant, **kw)
    exc = sorted(un["exceptions"], key=lambda e: (-int(e["order_count"]), e["machine"] or ""))
    rows = [[e["machine"], e["order_count"], e["reason"]] for e in exc]
    agg = sorted(agg, key=lambda a: (-int(a["queued_children"] or 0), a["production_order"] or "",
                                     a["material_number"] or ""))
    shown = agg[:DIST_ROW_CAP]
    arows = [[a["production_order"], a["material_number"], a["machine"], a["quantity"], a["sum_child_quantity"],
              a["child_count"], a["queued_children"], bool(a["all_scheduled"]), a["start"], a["finish"],
              a["due_date"]] for a in shown]
    sections = [
        artifacts.section("unresolved", "Unresolved orders",
                          [col("machine"), col("order_count", "number"), col("reason")], rows),
        artifacts.section("aggregate", "Aggregate headers",
                          [col("production_order"), col("material_number"), col("work_center"), col("quantity", "number"),
                           col("sum_child_quantity", "number"), col("children", "number"),
                           col("queued_children", "number"), col("all_scheduled", "bool"), col("start", "datetime"),
                           col("finish", "datetime"), col("due_date", "datetime")], arows),
    ]
    return _outcome(sections, window=w, count=un["unmatched_orders"], warn_if_over=p.warn_if_over,
                    summary={"unresolved_pairs": un["unmatched_pairs"], "unresolved_orders": un["unmatched_orders"],
                             "headers": len(agg), "headers_shown": len(shown), "headers_truncated": len(agg) > len(shown)})


def _rt(key: str, label: str, model, fn) -> JobType:
    return register(JobType(key=key, label=label, params_model=model, run=fn, kind="report", mutates=False,
                            default_timeout_s=REPORT_TIMEOUT_S, idempotent=True, estimate_s=20))


WHAT_CHANGED = _rt("report.what_changed", "What changed (schedule events)", WhatChangedParams, run_what_changed)
LATE_ORDERS = _rt("report.late_orders", "Late-order digest", LateOrdersParams, run_late_orders)
MISSING_MASTER_DATA = _rt("report.missing_master_data", "Missing master data", MissingMasterDataParams,
                          run_missing_master_data)
COVERAGE = _rt("report.coverage", "Coverage (tools, priority lists, setup)", CoverageParams, run_coverage)
DISTRIBUTION = _rt("report.distribution", "Distribution (unresolved and aggregate)", DistributionParams,
                   run_distribution)
