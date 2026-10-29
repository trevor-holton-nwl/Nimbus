"""STUB job type `noop`: logs a few steps, sleeps briefly, honours cancellation. Exists so the scheduler,
run lifecycle and log API can be exercised end to end without the optimizer. Hidden from GET /jobs/types
unless NIMBUS_JOBS_STUBS=1."""
from __future__ import annotations

from pydantic import BaseModel, Field

from backend.jobs.registry import JobOutcome, JobType, register


class NoopParams(BaseModel):
    steps: int = Field(3, ge=0, le=50)
    sleep_s: float = Field(0.2, ge=0, le=60)
    outcome: str = Field("succeeded", pattern="^(succeeded|warning|failed)$")


def run(ctx, params: NoopParams) -> JobOutcome:
    ctx.log("info", f"noop started for plant {ctx.plant}", steps=params.steps)
    for i in range(params.steps):
        with ctx.step(f"step {i + 1}"):
            ctx.sleep(params.sleep_s)           # raises JobCancelled when the run is cancelled or times out
    if params.outcome == "warning":
        ctx.log("warn", "noop finished with a warning")
    if params.outcome == "failed":
        return JobOutcome("failed", {"steps": params.steps}, "noop was told to fail")
    return JobOutcome(params.outcome, {"steps": params.steps})


NOOP = register(JobType(key="noop", label="No-op (test)", params_model=NoopParams, run=run,
                        default_timeout_s=60, stub=True))
