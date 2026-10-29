"""The app's "due" rule, ported to Python for the late-order digest. PURE (stdlib only).

Twin of `NimbusComputeCore.dueDateInstant` / `Util.sapDueDate` (frontend/nimbus-compute-core.js, frontend/platform/
foundation.mts), pinned by `tests/fixtures/due_rule_vectors.json` which both a pytest and a node test read:

- A SAP due date that is not exactly local midnight is a TIMED due date and is used as is.
- A date-only due date arrives as an exact-midnight timestamp and means the CLOSE of that day's working window (the
  line's hours intersected with the plant's, effective-dated plant periods honoured). A closed day looks back up to 30
  days for the previous open day's close; a close at or after the next midnight is capped at that next midnight; no
  window at all falls back to 23:59:59 on the due date.
- An order is late when its finish is strictly after that instant. A queued (unplaced) order has no finish: the plant
  clock stands in for it, so a queued order whose due instant has passed is late. A past due date therefore counts as
  due now.

Calendar scope: plant weekly hours (+ periods) and the line's own weekly hours (machine_calendar.work_hours; a line
without its own row follows the plant). Blackouts are NOT considered, exactly like the app's due rule.
Hours maps are keyed by the JS weekday (0 = Sunday) as the calendar tables store them.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Callable

DEFAULT_SHIFT = (7, 19)      # nimbus-compute-core.js DEFAULT_SHIFT
LOOKBACK_DAYS = 30


def default_week() -> dict:
    return {str(d): (None if d in (0, 6) else list(DEFAULT_SHIFT)) for d in range(7)}


def _hours_for(wh, d: date):
    """[open_h, close_h] for the calendar day, or None when closed / unknown."""
    if not isinstance(wh, dict):
        return None
    js = (d.weekday() + 1) % 7
    v = wh.get(str(js))
    if v is None:
        v = wh.get(js)
    if not v or len(v) < 2:
        return None
    return float(v[0]), float(v[1])


def _active_hours(default, periods, d: date):
    best = None
    key = d.isoformat()
    for p in periods or []:
        vf, vt = str(p["valid_from"])[:10], (str(p["valid_to"])[:10] if p.get("valid_to") else None)
        if vf <= key and (vt is None or key <= vt) and (best is None or vf < best[0]):
            best = (vf, p)
    return best[1]["work_hours"] if best else default


def _at(d: date, hours: float) -> datetime:
    return datetime.combine(d, time(0, 0)) + timedelta(minutes=round(hours * 60))


def make_close_for(cal: dict | None) -> Callable[[str | None, date], datetime | None]:
    """`cal` is `md.load_plant_calendar(plant)`; returns close_for(machine, day) -> naive local close or None."""
    cal = cal or {}
    plant_wh = cal.get("plant_work_hours") or default_week()
    periods = cal.get("plant_periods") or []
    line_wh = cal.get("line_work_hours") or {}

    def close_for(machine, d: date):
        ph = _hours_for(_active_hours(plant_wh, periods, d), d)
        if ph is None:
            return None
        own = line_wh.get(machine) if machine else None
        lh = _hours_for(own, d) if own else (0.0, 24.0)       # a line without its own hours follows the plant
        if lh is None:
            return None
        open_h, close_h = max(ph[0], lh[0]), min(ph[1], lh[1])
        if open_h >= close_h:
            return None
        return _at(d, close_h)

    return close_for


def due_instant(raw: datetime, close_for: Callable[[date], datetime | None]) -> datetime:
    """The due instant of a SAP due date (naive plant-local); `close_for(day)` is the line's close that day."""
    if raw.time() != time(0, 0):
        return raw
    for back in range(LOOKBACK_DAYS + 1):
        day = raw.date() - timedelta(days=back)
        close = close_for(day)
        if close is None:
            continue
        cap = datetime.combine(day + timedelta(days=1), time(0, 0))
        return cap if close > cap else close
    return raw.replace(hour=23, minute=59, second=59)
