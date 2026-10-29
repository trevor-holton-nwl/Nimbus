"""Chain steps that re-derive order data from master data: `routing.recompute` and `attributes.resync`.

Both wrap the function the Admin route already calls (reused, not forked), so the counts, the schedule-event history and the
guards come from the one implementation; the actor is `job:<id>`. Both write order rows, so both take the optimizer's
lock (`jobs:optimizer.plant:<plant>`, the one every order writer shares): they cannot run beside an optimizer, a backlog
or a purge on the plant.

`routing.recompute` -> `routing.resolver.resolve_orders(plant, full=True, actor=...)` (what `POST /routing/{plant}/recompute`
runs): re-resolves run time and production version for every non-manual order from the plant's routings. A plant with
routing switched off is a clean no-op with a message (the resolver itself answers an empty report for it). No dry run: the
resolver has no preview. Idempotent: a second pass over unchanged routing data resolves the same values.

`attributes.resync` -> `db.resync_order_attributes(plant, actor=...)` (what `POST /master-data/resync-order-attributes`
runs): re-stamps color, PRT 1 and 2 and production version on the plant's orders from the material-plant master data.
Only rows whose values really differ are written (so only those get a new row version and a `master_data_stamp` history
row), which makes a second run a no-op: idempotent. No dry run: `report.missing_master_data` is the read-only view of the
unmatched materials. The step never fails on unmatched materials; their count is on the summary.
"""
from __future__ import annotations

from pydantic import BaseModel

import db
from backend.jobs.registry import JobOutcome, JobType, register


class RoutingRecomputeParams(BaseModel):
    """No parameters: the whole plant is re-resolved, like the Admin recompute button."""


class AttributesResyncParams(BaseModel):
    """No parameters: every order of the plant is re-stamped from material-plant master data."""


def _routing_enabled(plant: str) -> bool:
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT routing_runtime_enabled FROM plants WHERE plant = %s", (plant,))
        row = cur.fetchone()
    return bool(row and row[0])


def _lock_keys(key: str):
    # the optimizer's lock too (order writers never interleave), like purge
    return lambda plant, _p: [f"jobs:{key}:{plant}", f"jobs:optimizer.plant:{plant}"]


def run_routing_recompute(ctx, _params: RoutingRecomputeParams) -> JobOutcome:
    plant = ctx.plant
    with ctx.step("check"):
        enabled = _routing_enabled(plant)
    if not enabled:
        ctx.log("info", f"routing run times are switched off for plant {plant}; nothing to recompute")
        return JobOutcome("succeeded", {"routing_enabled": False, "skipped": "routing_off",
                                        "note": "routing run times are switched off for this plant"})
    import backend.routing.resolver as routing_resolver
    ctx.check_cancel()                                  # the last cancel point before the write
    with ctx.step("recompute"):
        report = routing_resolver.resolve_orders(plant, full=True, actor=f"job:{ctx.job_id}")
    unknown = sum(int(v or 0) for v in (report.get("unknown_by_step") or {}).values())
    summary = {"routing_enabled": True, "resolved": int(report.get("resolved") or 0),
               "unknown": unknown, "legacy_retained": int(report.get("legacy_retained") or 0),
               "pv_sap_restored": int(report.get("pv_sap_restored") or 0), "pv_defaulted": int(report.get("pv_defaulted") or 0),
               "over_cap": int(report.get("over_cap") or 0), "lot_size_warnings": int(report.get("lot_size_warnings") or 0),
               "sap_order_fallback": int(report.get("sap_order_fallback_count") or 0),
               "unmapped_workcenters": len(report.get("unmapped_workcenters") or [])}
    ctx.log("info", f"{summary['resolved']} order(s) resolved, {unknown} held for unknown routing data", **summary)
    return JobOutcome("succeeded", summary)


def run_attributes_resync(ctx, _params: AttributesResyncParams) -> JobOutcome:
    ctx.check_cancel()
    with ctx.step("resync"):
        result = db.resync_order_attributes(ctx.plant, actor=f"job:{ctx.job_id}")
    summary = {"unmatched_pairs": int(result.get("unmatched_pairs") or 0),
               "unmatched_orders": int(result.get("unmatched_orders") or 0)}
    ctx.log("info", f"order attributes re-stamped; {summary['unmatched_pairs']} material(s) with no master-data row "
                    f"({summary['unmatched_orders']} order(s))", **summary)
    return JobOutcome("succeeded", summary)


ROUTING_RECOMPUTE = register(JobType(
    key="routing.recompute", label="Recompute routing run times", params_model=RoutingRecomputeParams,
    run=run_routing_recompute, default_timeout_s=900, idempotent=True, dry_run=None, estimate_s=60,
    lock_keys=_lock_keys("routing.recompute")))

ATTRIBUTES_RESYNC = register(JobType(
    key="attributes.resync", label="Resync order attributes", params_model=AttributesResyncParams,
    run=run_attributes_resync, default_timeout_s=600, idempotent=True, dry_run=None, estimate_s=15,
    lock_keys=_lock_keys("attributes.resync")))
