"""Job type `chain`: an ordered list of steps, each one an ordinary job type, run one after another like SAP job steps.

Semantics (owner ruling 2026-10-28, W4a)
- Sequential. Every step commits by itself from a FRESH read (the step bodies gather their own data), so step 2 sees what
  step 1 committed, and each write step has its own `action_id` (its own Undo in the Inspector history).
- A failed step STOPS the chain: later steps are `skipped`, the run is `failed`. A step marked `continue_on_failure`
  does not stop it (the run ends `warning`, the step itself shows `failed`). `run_on` makes a step a cleanup:
  `success` (default) runs only while no step has stopped the chain, `failure` only after some step failed, `always` runs
  regardless. A cancel or a timeout skips EVERYTHING left, cleanup steps included.
- One cancel event and one timeout (the sum of the step timeouts) for the whole run; a cancel is honoured at the current
  step's own atomic boundary (the optimizer checks it right before its write).
- Mixed dry-run / apply chains are refused when the chain is saved: a chain either only previews or only applies.
- Locks and slots are the UNION of the steps': a chain cannot run beside a standalone job of the same kind on the plant.

Persistence goes through `_store` (the `data` module in production; tests swap in an in-memory one), so the semantics
are tested without a database. Step rows live in `job_step_run`; the log lines carry `job_run_log.step_seq`.
"""
from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from backend.jobs import data as _data
from backend.jobs.context import CHAIN_MAX_LINES, MAX_LINES, JobCancelled
from backend.jobs.registry import REGISTRY, JobOutcome, JobType, get_type, register

MAX_STEPS = 10
STEP_TIMEOUT_MARGIN_S = 30
ERROR_KINDS = ("config", "system", "transient")
_STEP_SUMMARY_DROP = ("proposal",)        # large; the run summary carries the (last) proposal once

_store = _data                            # tests replace this with an in-memory store


class StepSpec(BaseModel):
    type: str
    params: dict = Field(default_factory=dict)
    label: str | None = Field(None, max_length=80)
    continue_on_failure: bool = False
    run_on: Literal["success", "failure", "always"] = "success"


def check_steps(steps: list[StepSpec]) -> list[StepSpec]:
    """Validate every step through its type's own params model (the same check `POST /jobs` makes for a single job) and
    return the steps with their params normalised to the full model dump. Raises ValueError with a readable message."""
    if len(steps) > MAX_STEPS:
        raise ValueError(f"a chain has at most {MAX_STEPS} steps")
    out: list[StepSpec] = []
    modes: set[bool] = set()
    for i, st in enumerate(steps, 1):
        jt = get_type(st.type)
        if jt is None:
            raise ValueError(f"step {i}: unknown job type {st.type!r}")
        if jt.composite:
            raise ValueError(f"step {i}: a chain cannot contain a chain")
        try:
            p = jt.params_model.model_validate(st.params or {})
        except ValidationError as e:
            raise ValueError(f"step {i} ({st.type}): invalid params: "
                             f"{e.errors(include_url=False, include_context=False, include_input=False)[:3]}") from e
        if jt.mutates:
            modes.add(bool(jt.is_dry_run(p)))
        out.append(st.model_copy(update={"params": p.model_dump(mode="json")}))
    if len(modes) > 1:
        raise ValueError("a chain cannot mix dry-run and apply steps")
    return out


def normalize_steps(raw: list[dict]) -> list[dict]:
    """`check_steps` over plain dicts (template routes, seeds); returns plain dicts."""
    return [s.model_dump(mode="json") for s in check_steps([StepSpec.model_validate(r) for r in raw])]


class ChainParams(BaseModel):
    steps: list[StepSpec] = Field(default_factory=list, max_length=MAX_STEPS)

    @field_validator("steps")
    @classmethod
    def _check(cls, steps: list[StepSpec]) -> list[StepSpec]:
        return check_steps(steps)


def _models(params: ChainParams) -> list[tuple[StepSpec, JobType, BaseModel]]:
    return [(st, REGISTRY[st.type], REGISTRY[st.type].params_model.model_validate(st.params or {}))
            for st in params.steps]


def timeout_s(params: ChainParams) -> int:
    """One timeout for the whole run: the sum of the step timeouts (plus a margin per step)."""
    return sum(jt.timeout_for(p) + STEP_TIMEOUT_MARGIN_S for _st, jt, p in _models(params)) or 60


def lock_keys(plant: str, params: ChainParams) -> list[str]:
    return [k for _st, jt, p in _models(params) for k in jt.lock_names(plant, p)]


def slots(params: ChainParams) -> list:
    """The semaphores of the steps' types, each once, held by the RUNNER for the whole chain (taken before the global
    semaphore, like a standalone slot-gated run, so the lock order stays slot -> global and cannot deadlock)."""
    seen, out = set(), []
    for _st, jt, p in _models(params):
        for s in jt.slot_list(p):
            if id(s) not in seen:
                seen.add(id(s))
                out.append(s)
    return out


def all_idempotent(params: ChainParams) -> bool:
    return all(jt.idempotent for _st, jt, _p in _models(params))


def step_label(st: StepSpec) -> str:
    jt = REGISTRY.get(st.type)
    return st.label or (jt.label if jt else st.type)


def _kind_of(status: str, summary: dict | None, exc: BaseException | None = None) -> str | None:
    if status != "failed":
        return None
    if exc is not None and isinstance(exc, ValidationError):
        return "config"
    k = (summary or {}).get("error_kind")
    return k if k in ERROR_KINDS else "system"


def run(ctx, params: ChainParams) -> JobOutcome:
    steps = list(params.steps)
    resume = _store.run_resume(ctx.run_id)
    start_at = 1
    if resume:                                # restart from a failed step: the ORIGINAL run's snapshot, never today's edit
        steps = [StepSpec(type=r["step_type"], params=r["params"], label=r["label"],
                          continue_on_failure=r["continue_on_failure"], run_on=r["run_on"])
                 for r in _store.list_steps(int(resume["from_run"]))]
        start_at = int(resume["from_seq"])
    n = len(steps)
    if n == 0:
        return JobOutcome("failed", {"error_kind": "config", "failed_step": "validate"}, "the chain has no steps")
    ctx.max_lines = min(MAX_LINES * n, CHAIN_MAX_LINES)
    _store.insert_step_rows(ctx.run_id, [
        {"seq": i, "step_type": st.type, "label": st.label, "run_on": st.run_on,
         "continue_on_failure": st.continue_on_failure, "params": st.params,
         **({"status": "skipped", "summary": {"reason": "ran in an earlier run", "ran_in_run": resume["from_run"]}}
            if i < start_at else {})}
        for i, st in enumerate(steps, 1)])
    ctx.log("info", f"chain of {n} step{'s' if n != 1 else ''} started"
            + (f" (resuming at step {start_at})" if start_at > 1 else ""))
    stopped = any_failed = any_warning = cancelled = False
    rows: list[dict] = []                       # one per step, for the run summary
    artifact = proposal = None
    window = None
    first_error: tuple[int, str, str, str] | None = None     # (seq, label, error, kind) of the step that stopped it
    for seq, st in enumerate(steps, 1):
        label = step_label(st)
        if seq < start_at:
            continue
        info = {"seq": seq, "step": label, "type": st.type}
        if cancelled or ctx.cancelled:
            cancelled = True
            _store.finish_step(ctx.run_id, seq, "skipped", {"reason": "the run was cancelled"})
            rows.append({**info, "status": "skipped", "duration_ms": None})
            continue
        runs = (st.run_on == "always" or (st.run_on == "success" and not stopped)
                or (st.run_on == "failure" and any_failed))
        if not runs:
            why = "an earlier step failed" if st.run_on == "success" else "no earlier step failed"
            _store.finish_step(ctx.run_id, seq, "skipped", {"reason": why})
            rows.append({**info, "status": "skipped", "duration_ms": None})
            continue
        status, summary, error, kind, action_id, art, ms = _run_step(ctx, seq, n, st, label)
        rows.append({**info, "status": status, "duration_ms": ms,
                     **({"action_id": action_id} if action_id else {})})
        if art is not None:
            artifact = art
        if summary.get("proposal") is not None:
            proposal = {k: summary[k] for k in ("proposal", "proposal_truncated") if k in summary}
        if summary.get("window") and REGISTRY[st.type].kind == "report":
            window = summary["window"]       # only a report's window feeds the `since last success` watermark (last wins)
        if status == "cancelled":
            cancelled = True
        elif status == "failed":
            any_failed = True
            if not st.continue_on_failure:
                stopped = True
                if first_error is None:
                    first_error = (seq, label, error or "step failed", kind or "system")
        elif status == "warning":
            any_warning = True
    ctx.step_seq = None                          # the lines the runner writes next belong to the run, not a step
    out: dict = {"chain": True, "steps": rows,
                 "step_counts": {s: sum(1 for r in rows if r["status"] == s) for s in
                                 ("succeeded", "warning", "failed", "skipped", "cancelled")}}
    mut = {bool(REGISTRY[s.type].is_dry_run(REGISTRY[s.type].params_model.model_validate(s.params or {})))
           for s in steps if REGISTRY[s.type].mutates}
    out["mode"] = "report" if not mut else ("dry_run" if mut == {True} else "apply")
    if out["mode"] == "dry_run":
        out["apply_mode"] = "propose"           # the proposal route and the Dry run badge read this
    action_ids = [r["action_id"] for r in rows if r.get("action_id")]
    if action_ids:
        out["action_ids"] = action_ids
    if resume:
        out["resume"] = resume
    if window:
        out["window"] = window                   # keeps a later `since last successful run` report contiguous
    if proposal:
        out.update(proposal)
    if first_error:
        seq, label, error, kind = first_error
        out["failed_step"] = f"step {seq}: {label}"
        out["error_kind"] = kind
        return JobOutcome("failed", out, f"step {seq} ({label}) failed: {error}", artifact)
    if cancelled or ctx.cancelled:
        return JobOutcome("warning", out, None, artifact)     # the runner turns this into `cancelled`
    return JobOutcome("warning" if (any_failed or any_warning) else "succeeded", out, None, artifact)


def _run_step(ctx, seq: int, n: int, st: StepSpec, label: str):
    """Run one step on its own step row. Returns (status, summary, error, error_kind, action_id, artifact, ms)."""
    jt = REGISTRY[st.type]
    ctx.step_seq = seq
    _store.start_step(ctx.run_id, seq)
    ctx.log("info", f"step {seq} of {n}: {label} started", step=f"step {seq}")
    t0 = time.monotonic()
    out: JobOutcome | None = None
    err: str | None = None
    exc: BaseException | None = None
    status = "succeeded"
    try:
        out = jt.run(ctx, jt.params_model.model_validate(st.params or {}))
        status = out.status if out.status in ("succeeded", "warning", "failed") else "succeeded"
        err = out.error
        if ctx.cancelled and status != "failed":
            status = "cancelled"
    except JobCancelled:
        status = "cancelled"
    except BaseException as e:  # noqa: BLE001 - a step may raise anything; it fails the step, not the worker thread
        exc, status, err = e, "failed", f"{type(e).__name__}: {e}"
        ctx.log("error", f"step {seq} ({label}) failed: {err}", step=f"step {seq}")
    if ctx.timed_out and status == "cancelled":
        status, err = "failed", err or "timed out"
    ms = int((time.monotonic() - t0) * 1000)
    summary = dict(out.summary) if out and out.summary else {}
    kind = _kind_of(status, summary, exc)
    action_id = summary.get("action_id") if isinstance(summary.get("action_id"), str) else None
    if status == "failed" and err and not ctx.error_lines:
        ctx.log("error", f"step {seq} ({label}) failed: {err}", step=f"step {seq}")
    ctx.log("info" if status in ("succeeded", "cancelled") else "warn",
            f"step {seq} of {n}: {label} finished: {status}" + (f" ({err})" if err and status == "failed" else ""),
            step=f"step {seq}", duration_ms=ms)
    stored = {k: v for k, v in summary.items() if k not in _STEP_SUMMARY_DROP}
    if out is not None and out.artifact:
        stored["artifact"] = True
    _store.finish_step(ctx.run_id, seq, status, stored or None, err, kind, action_id)
    ctx.flush()
    return status, summary, err, kind, action_id, (out.artifact if out else None), ms


CHAIN = register(JobType(key="chain", label="Chain of steps", params_model=ChainParams, run=run, default_timeout_s=3600,
                         timeout_fn=timeout_s, needs_plant_timezone=True, composite=True, mutates=True,
                         lock_keys=lock_keys, slots=slots, estimate_s=None))
