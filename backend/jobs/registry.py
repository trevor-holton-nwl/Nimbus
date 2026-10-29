"""Job-type registry. Pure (stdlib + pydantic); the run bodies live in backend/jobs/types/."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel


@dataclass
class JobOutcome:
    """What a job body returns. status is succeeded|warning|failed; raising is also a failure."""
    status: str = "succeeded"
    summary: dict = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True)
class JobType:
    key: str
    label: str
    params_model: type[BaseModel]
    run: Callable[[Any, BaseModel], JobOutcome]               # run(ctx, params) -> JobOutcome
    plant_scoped: bool = True
    default_timeout_s: int = 600
    timeout_fn: Callable[[BaseModel], int] | None = None     # per-params timeout (search budget + margin)
    lock_key: Callable[[str, BaseModel], str] | None = None  # None -> one run at a time per (type, plant)
    stub: bool = False                                        # hidden from the types list unless stubs enabled
    needs_plant_timezone: bool = False                        # a schedule cannot be saved for a plant with no timezone
    defer_clock: bool = False                                 # the body starts the timeout clock itself (ctx.begin_work)

    def timeout_for(self, params: BaseModel) -> int:
        return int(self.timeout_fn(params)) if self.timeout_fn else self.default_timeout_s

    def lock_name(self, plant: str, params: BaseModel) -> str:
        return self.lock_key(plant, params) if self.lock_key else f"jobs:{self.key}:{plant}"


REGISTRY: dict[str, JobType] = {}


def register(jt: JobType) -> JobType:
    REGISTRY[jt.key] = jt
    return jt


def stubs_enabled() -> bool:
    return os.environ.get("NIMBUS_JOBS_STUBS", "").strip().lower() in ("1", "true", "yes", "on")


def get_type(key: str) -> JobType | None:
    """Registered type, or None (also None for a stub type while stubs are disabled)."""
    jt = REGISTRY.get(key)
    if jt is None or (jt.stub and not stubs_enabled()):
        return None
    return jt


def list_types() -> list[JobType]:
    return [jt for jt in REGISTRY.values() if not jt.stub or stubs_enabled()]
