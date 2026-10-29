"""Job type `optimizer.plant`: one heuristics (optimizer) run for one plant.

THIN PLACEHOLDER. The real headless runner (a Node subprocess that rebuilds the schedule snapshot, runs the engine
and writes back through POST /tasks/update with source=optimizer) is built elsewhere and wired later through the
seam below: call `set_runner(fn)` once at startup. Until then a run fails with a clear message.

Runner contract: `fn(ctx, plant, params) -> dict` with optional keys
  late, changeovers, moved, applied, dropped (ints), action_id (str), warnings (list[str]), status ('failed' to fail),
  plus steps ([{step, duration_ms}]), proposal and a few counts (see `keys` in run()).
`optimizer_runner.run_optimizer` is the real runner; `scheduler.install` wires it at startup.
It logs through `ctx.log` / `ctx.step`, polls `ctx.check_cancel()` (or `ctx.cancelled`) and kills its own
subprocess when cancelled. Raising fails the run.
"""
from __future__ import annotations

from typing import Callable, Literal

from pydantic import BaseModel

from backend.jobs.registry import JobOutcome, JobType, register


class OptimizerParams(BaseModel):
    # Remove Backlog is deliberately not offered: it moves running orders.
    mode: Literal["due_date", "min_changeover", "spt"] = "due_date"
    search: Literal["normal", "exhaustive"] = "exhaustive"
    respect_firmed: bool = True
    apply_mode: Literal["propose", "apply"] = "apply"   # "propose" is a dry run: viewable, never applied (owner 2026-10-28)


RunnerFn = Callable[[object, str, OptimizerParams], dict]


def _unwired_runner(ctx, plant: str, params: OptimizerParams) -> dict:
    raise NotImplementedError("the headless optimizer runner is not wired yet (backend/jobs/types/optimizer.py set_runner)")


_runner: RunnerFn = _unwired_runner


# --- SEAM: the headless Node runner plugs in here -------------------------------------------------------------
def set_runner(fn: RunnerFn | None) -> None:
    global _runner
    _runner = fn or _unwired_runner


def get_runner() -> RunnerFn:
    return _runner
# ---------------------------------------------------------------------------------------------------------------


def timeout_s(params: OptimizerParams) -> int:
    """Search budget + 60 s: Normal is ~8 s, Exhaustive ~3.6 min per plant (measure at W6 and adjust)."""
    return 120 if params.search == "normal" else 600


def run(ctx, params: OptimizerParams) -> JobOutcome:
    ctx.log("info", f"optimizer run: plant {ctx.plant}, mode {params.mode}, search {params.search}, "
                    f"result {params.apply_mode}")
    result = _runner(ctx, ctx.plant, params) or {}
    keys = ("late", "changeovers", "moved", "applied", "dropped", "action_id", "warnings", "steps", "setup_minutes",
            "search_complete", "termination", "tool_blocked", "proposal", "proposal_truncated", "error_kind",
            "failed_step")
    summary = {k: result[k] for k in keys if k in result}
    summary.update({"mode": params.mode, "search": params.search, "apply_mode": params.apply_mode})
    if result.get("status") == "failed":
        return JobOutcome("failed", summary, result.get("error") or "optimizer run failed")
    warn = bool(result.get("warnings")) or int(result.get("dropped") or 0) > 0
    return JobOutcome("warning" if warn else "succeeded", summary)


OPTIMIZER = register(JobType(key="optimizer.plant", label="Optimizer (one plant)", params_model=OptimizerParams,
                             run=run, default_timeout_s=600, timeout_fn=timeout_s,
                             needs_plant_timezone=True, defer_clock=True))
