"""Plant-aware window resolution shared by a run and the dialog preview (POST /jobs/windows/preview).

Both callers go through `resolve_for_plant`, which reads the plant timezone and the job's last-success watermark
and hands them to the pure `windows.resolve_window`, so the preview can never disagree with the run.
"""
from __future__ import annotations

from datetime import datetime, timezone

from backend.jobs import data, windows


def resolve_for_plant(plant: str, window, *, job_id: int | None = None, before_run_id: int | None = None,
                      now: datetime | None = None, first_run_lookback_days: int = 1) -> dict:
    """The resolved window as {start, end, label, timezone} (plant-local ISO strings), plus the naive plant-local
    datetimes `start_naive` / `end_naive` for comparing against TIMESTAMP columns. Raises
    windows.WindowConfigError (kind 'config') when the plant has no usable timezone."""
    if not data.plant_has_timezone(plant):
        raise windows.WindowConfigError(
            f"plant {plant!r} has no timezone; set one in Plants before using a date window")
    tz = data.plant_timezone(plant)
    now = now or datetime.now(timezone.utc)
    last = data.last_success_started_at(job_id, before_run_id) if job_id else None
    start, end, label = windows.resolve_window(window, tz, now, last, first_run_lookback_days)
    out = windows.window_wire(start, end, label, tz)
    # Full-precision values for SQL (the wire strings are cut to seconds, which would drop an event from the last second).
    out["start_naive"], out["end_naive"] = start.replace(tzinfo=None), end.replace(tzinfo=None)
    out["start_aware"], out["end_aware"] = start, end
    return out


def public(resolved: dict) -> dict:
    """The JSON-safe part (what the summary and the preview route carry)."""
    return {k: v for k, v in resolved.items() if not k.endswith(("_naive", "_aware"))}
