"""SAP chain steps: `sap.apply_batch` (live) and `sap.send` (scaffold only, not available).

`sap.apply_batch` applies the plant's newest VALIDATED staged batch, one object at a time in the staging order
(`sap_staging.APPLY_ORDER`: material-plant rows, production versions, routing operations, planned orders), through the same
`sap_staging.apply_batch` the Admin "Apply" button and the staging poll call. That function keeps every guard (a
newer complete batch supersedes, the vanish threshold, the routing-required gate, one apply per object and plant, the SAP
system time zone check); this step adds none of its own and never confirms a held batch (a held batch needs a person).
Actor `job:<id>`.

Per object, the newest batch of this plant that is still actionable decides:
  `validated`  -> applied (or only listed when `dry_run`);
  `held`       -> not applied; the step ends `warning` ("needs confirmation"); `error` -> `warning` too (resume from the SAP pane);
  `ready` / `applying` -> not applied, noted (the poll validates a ready batch; an apply is running);
  none, or the newest is already `applied` -> "nothing to apply".
Idempotent: a second run finds nothing validated and applies nothing.

`sap.send` is registered only so the chain builder can show it disabled. The SAP interface does not exist yet, so the
server refuses to save it and again to run it (`JobType.available=False`). Planned contract (see backend/jobs/CLAUDE.md):
a plant-level opt-in setting, a send only after a successful apply step in the same chain, never after a failed step,
and the existing outbound queue (`sap_staging.build_outbound_groups`) as the payload. Nothing here calls the Mulesoft code.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from backend.jobs.registry import JobOutcome, JobType, register

_OBJECT_LABELS = {"stage_material_plants": "material-plant rows", "stage_production_version": "production versions",
                  "stage_routing_operation": "routing operations", "stage_planned_orders": "planned orders"}


class SapApplyParams(BaseModel):
    objects: list[Literal["stage_material_plants", "stage_production_version", "stage_routing_operation",
                          "stage_planned_orders"]] = Field(
        default_factory=lambda: list(_OBJECT_LABELS), description="Which staged objects to apply")
    dry_run: bool = Field(False, description="Only list the batches that would be applied")

    @field_validator("objects")
    @classmethod
    def _nonempty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("pick at least one object")
        return list(dict.fromkeys(v))


def _newest_batch(plant: str, object_key: str) -> dict | None:
    """The newest un-applied-or-applied batch of this object and plant, in the staging total order (None = none)."""
    from backend.integration import sap_staging
    rows = sap_staging.list_batches(object_key=object_key, plant=plant, limit=1)
    return rows[0] if rows else None


def _fail(ctx, kind: str, step: str, msg: str, summary: dict) -> JobOutcome:
    ctx.log("error", msg, step=step)
    return JobOutcome("failed", {**summary, "error_kind": kind, "failed_step": step}, msg)


def run_apply(ctx, p: SapApplyParams) -> JobOutcome:
    from backend.integration import sap_staging
    plant = ctx.plant
    actor = f"job:{ctx.job_id}"
    order = [o for o in sap_staging.APPLY_ORDER if o in p.objects]
    applied: list[dict] = []
    notes: list[dict] = []
    waiting = False
    for object_key in order:
        ctx.check_cancel()
        label = _OBJECT_LABELS[object_key]
        with ctx.step(object_key):
            batch = _newest_batch(plant, object_key)
        status = batch["status"] if batch else None
        if batch is None or status in ("applied", "superseded", "discarded", "rejected"):
            ctx.log("info", f"{label}: nothing to apply" + (f" (newest batch is {status})" if status else ""))
            notes.append({"object": object_key, "result": "nothing"})
            continue
        bid = str(batch["batch_id"])
        if status != "validated":
            if status in ("held", "error"):
                waiting = True
                ctx.log("warn", f"{label}: batch {bid} is {status} and needs a person (open the SAP staging pane)")
            else:
                ctx.log("info", f"{label}: batch {bid} is {status}; not applied")
            notes.append({"object": object_key, "batch_id": bid, "result": status})
            continue
        if p.dry_run:
            ctx.log("info", f"{label}: batch {bid} would be applied (dry run)")
            notes.append({"object": object_key, "batch_id": bid, "result": "would_apply"})
            continue
        ctx.check_cancel()                                       # the last cancel point before each write
        try:
            with ctx.step(f"apply {object_key}"):
                res = sap_staging.apply_batch(bid, actor=actor)
        except sap_staging.BatchNotApplicable as exc:
            code = str((getattr(exc, "detail", None) or {}).get("code") or "")
            kind = "transient" if code == "apply_in_progress" or isinstance(exc, sap_staging.BatchSuperseded) else "config"
            return _fail(ctx, kind, f"apply {object_key}", f"{label}: batch {bid} was not applied: {exc}",
                         {"applied": applied, "notes": notes})
        except Exception as exc:  # noqa: BLE001 - the apply failed part-way; the batch is `error`, later objects must not run
            return _fail(ctx, "system", f"apply {object_key}", f"{label}: batch {bid} failed: {type(exc).__name__}: {exc}",
                         {"applied": applied, "notes": notes})
        applied.append({"object": object_key, "batch_id": bid, "counts": res.get("counts")})
        ctx.log("info", f"{label}: batch {bid} applied", counts=res.get("counts"))
    summary: dict = {"dry_run": p.dry_run, "applied_batches": len(applied), "applied": applied, "notes": notes}
    if not applied and not waiting and not p.dry_run:
        summary["note"] = "no validated batch to apply"
        ctx.log("info", "no validated batch to apply")
    if waiting:
        summary["warnings"] = ["a held or failed batch needs a person; it was not applied"]
    return JobOutcome("warning" if waiting else "succeeded", summary)


APPLY = register(JobType(
    key="sap.apply_batch", label="Apply validated SAP batch", params_model=SapApplyParams, run=run_apply,
    default_timeout_s=1800, idempotent=True, dry_run=("dry_run", True), estimate_s=120,
    # the optimizer's lock too: a planned-orders apply writes orders, so it never interleaves with another order writer
    lock_keys=lambda plant, _p: [f"jobs:sap.apply_batch:{plant}", f"jobs:optimizer.plant:{plant}"]))


# ------------------------------------------------------------------------------------------------ Send to SAP (scaffold)
class SapSendParams(BaseModel):
    plant: str | None = Field(None, description="Defaults to the job's plant")
    only_if_previous_steps_succeeded: bool = Field(
        True, description="Fixed: a send never follows a failed step")

    @field_validator("only_if_previous_steps_succeeded")
    @classmethod
    def _fixed(cls, v: bool) -> bool:
        if v is not True:
            raise ValueError("a send always requires the earlier steps to have succeeded")
        return True


def run_send(ctx, _p: SapSendParams) -> JobOutcome:
    """Never reached: `available=False` stops it at save and at the run's guard. Kept explicit so a future caller that
    bypasses both still cannot send anything."""
    raise RuntimeError("Send to SAP is not available yet: the SAP interface is not live")


SEND = register(JobType(
    key="sap.send", label="Send to SAP", params_model=SapSendParams, run=run_send, mutates=True, idempotent=False,
    default_timeout_s=600, estimate_s=None, available=False,
    unavailable_reason="SAP interface is not live"))
