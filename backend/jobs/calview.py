"""Calendar view for the schedule policy. PURE (stdlib + backend.jobs.due); plant calendars are INJECTED as the dicts
`md.load_plant_calendar(plant)` returns, so nothing here touches the DB.

A day is a working day when the plant's active weekly hours (effective-dated periods win over the default week, the
same rule as the app) give it a window AND no plant blackout covers that whole window. Plant-level blackouts only:
machine blackouts and line hours are line concerns, and a job schedule belongs to a plant. `is_working_day` /
`next_working_day` / `previous_working_day` / `working_window` are the duck-typed interface `triggers.occurrences` uses
(plant arg first, so one view can serve many plants).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from backend.jobs import due

MAX_SEARCH_DAYS = 31


def _blackout_range(b: dict, tz) -> tuple[datetime, datetime] | None:
    """A plant blackout as naive plant-local (start, end)."""
    try:
        s = datetime.fromisoformat(str(b["start"]).replace("Z", "+00:00"))
        e = datetime.fromisoformat(str(b["end"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return None
    if s.tzinfo is None:
        s = s.replace(tzinfo=timezone.utc)
    if e.tzinfo is None:
        e = e.replace(tzinfo=timezone.utc)
    return s.astimezone(tz).replace(tzinfo=None), e.astimezone(tz).replace(tzinfo=None)


class PlantCalendarView:
    """`cals` = {plant: load_plant_calendar() dict}; `zones` = {plant: ZoneInfo} (blackouts are stored in UTC). A plant
    with no calendar entry works every day (fail open: a missing calendar must not silence a schedule)."""

    def __init__(self, cals: dict[str, dict], zones: dict | None = None):
        self.cals = cals or {}
        self.zones = zones or {}
        self._parsed: dict = {}

    def working_window(self, plant, d: date):
        """(open_hour, close_hour) for the day, or None when closed (no hours, or a plant blackout covers them)."""
        cal = self.cals.get(plant)
        if cal is None:
            return (0.0, 24.0)
        wh = due._active_hours(cal.get("plant_work_hours") or due.default_week(), cal.get("plant_periods"), d)
        hours = due._hours_for(wh, d)
        if hours is None:
            return None
        tz = self.zones.get(plant)
        if tz is not None:
            lo, hi = due._at(d, hours[0]), due._at(d, hours[1])
            for r in self._blackouts(plant, cal, tz):
                if r[0] <= lo and r[1] >= hi:
                    return None
        return hours

    def _blackouts(self, plant, cal: dict, tz) -> list:
        """The plant's blackouts as naive plant-local (start, end), parsed once per view (a 50-plant list asks about
        thousands of days)."""
        hit = self._parsed.get(plant)
        if hit is None:
            hit = [r for r in (_blackout_range(b, tz) for b in cal.get("plant_blackouts") or []) if r]
            self._parsed[plant] = hit
        return hit

    def is_working_day(self, plant, d: date) -> bool:
        return self.working_window(plant, d) is not None

    def next_working_day(self, plant, d: date, limit: int = MAX_SEARCH_DAYS):
        for i in range(1, limit + 1):
            n = d + timedelta(days=i)
            if self.is_working_day(plant, n):
                return n
        return None

    def previous_working_day(self, plant, d: date, limit: int = MAX_SEARCH_DAYS):
        for i in range(1, limit + 1):
            n = d - timedelta(days=i)
            if self.is_working_day(plant, n):
                return n
        return None
