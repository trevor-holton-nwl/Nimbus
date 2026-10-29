"""Job type `optimizer.backlog`: Remove Backlog for one plant (the headless engine mode 'backlog').

Remove Backlog compresses the overdue backlog into now, keeping the line's order (a schedule repair, not a search). It is
the same headless Node run as `optimizer.plant` (`optimizer_runner.run_optimizer`, reached through the same
`optimizer.get_runner()` seam), so the stale-write guard, the atomic strict write, the dropped-changed-families rule,
the dry run (`apply_mode: propose`), the actor `job:<id>` and the schedule-event history (source `optimizer`, as the
browser's Backlog writes) are the optimizer's own. It takes the optimizer's locks and slot: it cannot run beside an
optimizer, a purge or another backlog on the plant.

`include_running` (default true, owner ruling 2026-10-29, kept explicitly): running orders are RE-PLACED FROM THE RUN'S
'NOW' on every run, exactly as the browser's Backlog does. Turned off, it is a true plan-around: an order in progress
holds its slot (a fixed obstacle) and the rest is placed around it, so what the run offers is what apply writes.

NOT idempotent (`idempotent=False`): with running orders included, a second run moves a running order again (its new
start is the new 'now'); only the non-running backlog is already compressed after a run. So a chain with this step is not
retried as a whole, and restarting from a failed backlog step asks for confirmation. With `include_running=false` a second
run would move nothing, but the flag is a property of the type, so it stays False.
"""
from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from backend.jobs.registry import JobOutcome, JobType, register
from backend.jobs.types import optimizer


class BacklogParams(BaseModel):
    is_backlog: ClassVar[bool] = True                  # the runner's switch; not a field, never in the schema
    include_running: bool = Field(True, description="Also move orders already running on the line")
    apply_mode: Literal["propose", "apply"] = "apply"  # "propose" is a dry run: viewable, never applied


def timeout_s(_params: BacklogParams) -> int:
    """Not a search: the Node run is a few seconds. 120 s covers the bundle build and the apply phase."""
    return 120


def run(ctx, params: BacklogParams) -> JobOutcome:
    ctx.log("info", f"remove backlog: plant {ctx.plant}, running orders "
                    f"{'included' if params.include_running else 'left alone'}, result {params.apply_mode}")
    result = optimizer.get_runner()(ctx, ctx.plant, params) or {}
    keys = ("moved", "applied", "dropped", "action_id", "warnings", "steps", "backlog", "proposal", "proposal_truncated",
            "error_kind", "failed_step")
    summary = {k: result[k] for k in keys if k in result}
    summary.update({"mode": "backlog", "include_running": params.include_running, "apply_mode": params.apply_mode})
    if result.get("status") == "failed":
        return JobOutcome("failed", summary, result.get("error") or "remove backlog failed")
    warn = bool(result.get("warnings")) or int(result.get("dropped") or 0) > 0
    return JobOutcome("warning" if warn else "succeeded", summary)


BACKLOG = register(JobType(
    key="optimizer.backlog", label="Remove backlog (one plant)", params_model=BacklogParams, run=run,
    default_timeout_s=120, timeout_fn=timeout_s, needs_plant_timezone=True, defer_clock=True,
    slot=optimizer._slot, idempotent=False, dry_run=("apply_mode", "propose"), estimate_s=20,
    # also the optimizer's lock (and through it the purge's): backlog, optimizer and purge never interleave on one plant
    lock_keys=lambda plant, _p: [f"jobs:optimizer.backlog:{plant}", f"jobs:optimizer.plant:{plant}"]))
