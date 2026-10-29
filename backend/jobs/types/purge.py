"""Job type `purge.orders`: delete one plant's old orders, unattended and guarded.

Wraps the same two functions the Admin purge uses (`db.preview_purge_orders`, `db.purge_orders_by_date`), so the preview
count and the delete describe one row set, the share retirement, the admin audit row and the schedule-event history
(source `purge`) come from the one implementation, and the setup states are captured right before the delete exactly as
the `/purge` route does. The actor is `job:<id>`.

Guards (a scheduled job fires again and again, so a typo must not become "purge everything"):
- The window is a rolling `DateWindow` resolved in the plant's timezone ("older than 90 days"). A MINIMUM-AGE FLOOR
  (`NIMBUS_JOBS_PURGE_MIN_AGE_DAYS`, default 7, never below 1) refuses any window that reaches orders younger than that,
  at save time when the window is statically too young and again at run time against the resolved dates.
- `max_rows` is checked against the preview BEFORE anything is deleted, and again inside the delete's own transaction
  (`db.PurgeLimitExceeded`), which rolls back, so a race cannot slip a larger set through.
- `dry_run` stops after the preview and only reports what would go.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field, field_validator

import db
from backend.jobs import window_service, windows
from backend.jobs.registry import JobOutcome, JobType, register

DEFAULT_MIN_AGE_DAYS = 7
_UNIT_DAYS = {"day": 1, "week": 7, "month": 28}      # a month counted at its shortest, so the static check is safe


def min_age_days() -> int:
    """The system floor: how old (in whole days) the newest purged order must be."""
    try:
        return max(1, int(os.environ.get("NIMBUS_JOBS_PURGE_MIN_AGE_DAYS", DEFAULT_MIN_AGE_DAYS)))
    except ValueError:
        return DEFAULT_MIN_AGE_DAYS


class PurgeParams(BaseModel):
    window: windows.DateWindow = Field(
        default_factory=lambda: windows.DateWindow.model_validate(windows.older_than_days(90)),
        description="Orders whose finish falls in this window are removed", json_schema_extra={"x-widget": "date-window"})
    machines: list[str] = Field(default_factory=list, max_length=500, description="Only these machines (empty = all)")
    max_rows: int = Field(5000, ge=1, le=1_000_000, description="Refuse (delete nothing) when more orders match")
    dry_run: bool = Field(False, description="Only count what would be removed")

    @field_validator("window")
    @classmethod
    def _not_too_young(cls, w: windows.DateWindow) -> windows.DateWindow:
        floor = min_age_days()
        if w.mode == "rolling":
            r = w.rolling
            if r.anchor == "last_success":
                raise ValueError("a purge window cannot be 'since the last successful run'")
            if r.to_offset * _UNIT_DAYS[r.unit] > -floor:
                raise ValueError(f"the window can reach orders younger than the {floor}-day minimum age")
        return w


def check_for_plant(p: PurgeParams, plant: str | None) -> None:
    """Save-time check of a FIXED window against the plant's today (a rolling one is checked statically by the model).
    The plant's own timezone is used when it has one; otherwise the check is conservative: it refuses only a window that
    is too young even where the calendar is furthest ahead (UTC+14). The run-time re-check stays."""
    w = p.window
    if w.mode != "fixed" or w.fixed is None:
        return
    floor = min_age_days()
    today = None
    if plant:
        try:
            from backend.jobs import data as _data, triggers
            if _data.plant_has_timezone(plant):
                today = datetime.now(triggers.get_zone(_data.plant_timezone(plant))).date()
        except Exception:  # noqa: BLE001 - fall back to the conservative check
            today = None
    if today is None:
        today = (datetime.now(timezone.utc) + timedelta(hours=14)).date()
    newest_ok = today - timedelta(days=floor)
    if w.fixed.to > newest_ok:
        raise ValueError(f"the window reaches {w.fixed.to.isoformat()}; the newest day a purge may touch is "
                         f"{newest_ok.isoformat()} (orders must be at least {floor} days old)")


def _fail(ctx, kind: str, step: str, msg: str, summary: dict | None = None) -> JobOutcome:
    ctx.log("error", msg, step=step)
    return JobOutcome("failed", {**(summary or {}), "error_kind": kind, "failed_step": step}, msg)


def run(ctx, p: PurgeParams) -> JobOutcome:
    floor = min_age_days()
    try:
        w = window_service.resolve_for_plant(ctx.plant, p.window, job_id=ctx.job_id, before_run_id=ctx.run_id)
    except windows.WindowConfigError as e:
        return _fail(ctx, "config", "window", str(e))
    ctx.log("info", f"window resolved: {w['label']} ({w['timezone']}, plant time)", start=w["start"], end=w["end"])
    start, end = w["start_naive"], w["end_naive"] - timedelta(microseconds=1)     # purge is inclusive at both ends
    newest_ok = w["now_naive"].date() - timedelta(days=floor)
    if end.date() > newest_ok:
        return _fail(ctx, "config", "guard",
                     f"refused: the window reaches {end.date().isoformat()}; the newest day a purge may touch is "
                     f"{newest_ok.isoformat()} (orders must be at least {floor} days old)")
    machines = [m.strip() for m in p.machines if m.strip()]
    base = {"window": window_service.public(w), "max_rows": p.max_rows, "min_age_days": floor, "dry_run": p.dry_run}
    with ctx.step("preview"):
        pre = db.preview_purge_orders(ctx.plant, start, end, machines or None)
    total = int(pre["total"])
    base.update(matched=total, planner_overridden=int(pre["planner_overridden"]))
    ctx.log("info", f"{total} order(s) match ({base['planner_overridden']} with a planner-set schedule)")
    if total > p.max_rows:                                           # BEFORE anything is deleted
        return _fail(ctx, "config", "guard",
                     f"refused: {total} orders match, more than the limit of {p.max_rows}; nothing was deleted", base)
    if p.dry_run:
        return JobOutcome("succeeded", {**base, "deleted": 0}, None)
    if total == 0:
        ctx.log("info", "nothing to purge")
        return JobOutcome("succeeded", {**base, "deleted": 0}, None)
    ctx.check_cancel()                                               # the last cancel point before the delete
    from backend.schedule_events.events import new_action_id
    import backend.setup.data as setup_data
    actor, action_id = f"job:{ctx.job_id}", new_action_id()
    try:
        with ctx.step("purge"):
            # Adjacent to the delete on purpose, as in the /purge route: a derived state may only observe the schedule
            # while it still exists.
            setup_data.capture_setup_states_before_schedule_mutation(actor=actor, reason="order purge",
                                                                     plants=[ctx.plant])
            res = db.purge_orders_by_date(ctx.plant, start, end, machines or None, user_email=actor,
                                          max_rows=p.max_rows, action_id=action_id)
    except db.PurgeLimitExceeded as e:
        return _fail(ctx, "transient", "guard", f"refused: {e}; nothing was deleted", base)
    deleted = int(res.get("deleted", 0))
    ctx.log("info", f"{deleted} order(s) purged", deleted=deleted, shares_purged=res.get("shares_purged", 0))
    out = {**base, "deleted": deleted, "action_id": action_id}
    for k in ("shares_purged", "headers_deleted"):
        if res.get(k):
            out[k] = res[k]
    return JobOutcome("succeeded", out, None)


PURGE = register(JobType(key="purge.orders", label="Purge old orders", params_model=PurgeParams, run=run,
                         default_timeout_s=300, needs_plant_timezone=True, dry_run=("dry_run", True),
                         estimate_s=30, idempotent=False, plant_check=check_for_plant,
                         # also the optimizer's lock: a purge and an optimizer apply must not interleave on one plant
                         lock_keys=lambda plant, _p: [f"jobs:purge.orders:{plant}", f"jobs:optimizer.plant:{plant}"]))
