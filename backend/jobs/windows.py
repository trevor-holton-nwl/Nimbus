"""Rolling / fixed date windows for job params. PURE (stdlib + pydantic); imports no project code.

`resolve_window` is the ONE resolver: a job run and the dialog preview (`POST /jobs/windows/preview`) both call it,
so "Resolves today to ..." can never disagree with what the run uses (same invariant as the next-N-runs preview).

Rules
- Resolved in the PLANT's timezone, by CALENDAR date (never 24 h multiples), DST-safe: "30 days ago" is the plant's
  local calendar day 30 days back at 00:00, and a wall time in a spring-forward gap is moved to a real instant.
- Month offsets clamp to the target month's last day (Jan 31 + 1 month = Feb 28/29). Weeks start on Monday.
- The window is [start, end): `end` is exclusive. For a day-granular window `end` is local midnight, and the label
  shows the last INCLUDED date.
- Anchor `last_success` is the watermark: the start side is the job's last finished (succeeded or warning) run's
  started_at, the END side is the run's own `now`, so `since last successful run` is from_offset 0 / to_offset 0.
  With no prior success the start falls back to `first_run_lookback_days` calendar days before now.
- A missing or unknown plant timezone raises WindowConfigError (kind 'config': fix the plant, not the platform).
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator

Anchor = Literal["now", "start_of_day", "start_of_week", "start_of_month", "last_success"]
Unit = Literal["day", "week", "month"]
MAX_OFFSET = 3660
OPEN_START = 3650                    # a day-unit from_offset at or below -3650 means "no lower bound" (older than N)


class WindowConfigError(ValueError):
    """The window cannot be resolved because of configuration (no plant timezone, bad zone)."""
    kind = "config"


class FixedRange(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)
    from_: date = Field(alias="from")
    to: date


class RollingRange(BaseModel):
    anchor: Anchor = "now"
    from_offset: int = Field(0, ge=-MAX_OFFSET, le=MAX_OFFSET)     # negative = past
    to_offset: int = Field(0, ge=-MAX_OFFSET, le=MAX_OFFSET)
    unit: Unit = "day"


class DateWindow(BaseModel):
    """A date range a job param may take: fixed dates, or a rolling window resolved at run time."""
    mode: Literal["fixed", "rolling"] = "rolling"
    fixed: FixedRange | None = None
    rolling: RollingRange | None = None

    @model_validator(mode="after")
    def _shape(self):
        if self.mode == "fixed":
            if self.fixed is None:
                raise ValueError("fixed window needs fixed.from and fixed.to")
            if self.fixed.to < self.fixed.from_:
                raise ValueError("fixed window: 'to' is before 'from'")
        elif self.rolling is None:
            self.rolling = RollingRange()
        return self


# ------------------------------------------------------------------------------------------------ presets
def _rolling(anchor: str, f: int, t: int, unit: str = "day") -> dict:
    return {"mode": "rolling", "rolling": {"anchor": anchor, "from_offset": f, "to_offset": t, "unit": unit}}


def older_than_days(n: int) -> dict:
    """Everything before the plant's local day `n` days ago (open start)."""
    return _rolling("start_of_day", -OPEN_START, -int(n))


def last_days(n: int) -> dict:
    """From the local day `n` days ago through the end of today."""
    return _rolling("start_of_day", -int(n), 1)


def next_days(n: int) -> dict:
    """From today (local midnight) for `n` calendar days."""
    return _rolling("start_of_day", 0, int(n))


def since_last_success() -> dict:
    return _rolling("last_success", 0, 0)


def this_week() -> dict:
    return _rolling("start_of_week", 0, 1, "week")


def this_month() -> dict:
    return _rolling("start_of_month", 0, 1, "month")


# ------------------------------------------------------------------------------------------------ resolver
def get_zone(tz: str | None) -> ZoneInfo:
    name = (tz or "").strip()
    if not name:
        raise WindowConfigError("the plant has no timezone; set one in Plants before using a rolling window")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise WindowConfigError(f"unknown plant timezone {name!r}") from e


def _local(zone: ZoneInfo, d: date, t: time = time(0, 0)) -> datetime:
    """Wall time `t` on calendar day `d` as a real instant in `zone`; a time in a gap moves to the real instant."""
    w = datetime.combine(d, t, tzinfo=zone)
    return w.astimezone(timezone.utc).astimezone(zone)


def _add_months(d: date, n: int) -> date:
    m = d.year * 12 + (d.month - 1) + n
    y, mo = divmod(m, 12)
    mo += 1
    return date(y, mo, min(d.day, calendar.monthrange(y, mo)[1]))


def _shift(dt: datetime, n: int, unit: str, zone: ZoneInfo) -> datetime:
    d = dt.date()
    if unit == "day":
        nd = d + timedelta(days=n)
    elif unit == "week":
        nd = d + timedelta(days=7 * n)
    else:
        nd = _add_months(d, n)
    return _local(zone, nd, dt.timetz().replace(tzinfo=None))


def _anchor(kind: str, now_l: datetime, zone: ZoneInfo) -> datetime:
    d = now_l.date()
    if kind == "now":
        return now_l
    if kind == "start_of_day":
        return _local(zone, d)
    if kind == "start_of_week":
        return _local(zone, d - timedelta(days=d.weekday()))
    if kind == "start_of_month":
        return _local(zone, d.replace(day=1))
    raise WindowConfigError(f"unknown anchor {kind!r}")


def _label(start: datetime, end: datetime, open_start: bool) -> str:
    midnight = end.timetz().replace(tzinfo=None) == time(0, 0)
    last = (end.date() - timedelta(days=1)) if midnight else end.date()
    if open_start:
        return f"before {end.date().isoformat()}"
    return f"{start.date().isoformat()} to {last.isoformat()}"


def resolve_window(window, tz: str | None, now: datetime, last_success_at: datetime | None = None,
                   first_run_lookback_days: int = 1) -> tuple[datetime, datetime, str]:
    """(start_dt, end_dt, label) in the plant timezone; `now` must be timezone-aware."""
    if not isinstance(window, DateWindow):
        window = DateWindow.model_validate(window)
    zone = get_zone(tz)
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now_l = now.astimezone(zone)
    if window.mode == "fixed":
        f = window.fixed
        start = _local(zone, f.from_)
        end = _local(zone, f.to + timedelta(days=1))
        return start, end, _label(start, end, False)
    r = window.rolling
    if r.anchor == "last_success":
        base = (last_success_at.astimezone(zone) if last_success_at is not None
                else _shift(now_l, -max(0, int(first_run_lookback_days)), "day", zone))
        start = _shift(base, r.from_offset, r.unit, zone)
        end = _shift(now_l, r.to_offset, r.unit, zone)
    else:
        a = _anchor(r.anchor, now_l, zone)
        start = _shift(a, r.from_offset, r.unit, zone)
        end = _shift(a, r.to_offset, r.unit, zone)
    if end < start:
        raise WindowConfigError("the window ends before it starts")
    open_start = r.unit == "day" and r.from_offset <= -OPEN_START
    return start, end, _label(start, end, open_start)


def window_wire(start: datetime, end: datetime, label: str, tz: str) -> dict:
    """The resolved window as it is written to a run summary and served by the preview route."""
    return {"start": start.isoformat(timespec="seconds"), "end": end.isoformat(timespec="seconds"),
            "label": label, "timezone": tz}
