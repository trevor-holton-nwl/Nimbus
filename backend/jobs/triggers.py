"""Schedule -> APScheduler trigger. Pure (stdlib + APScheduler); no DB, no project imports.

`build_trigger(row)` is the ONE place a stored `job_schedule` row becomes a trigger. The scheduler wiring and
the next-N preview both call it, so the preview can never disagree with what actually fires. Presets
(hourly/daily/weekdays/weekly/monthly) compile to a 5-field cron; `once` becomes a DateTrigger.
Times are naive plant-local wall-clock values interpreted in the row's IANA `timezone`.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone as _tz
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

KINDS = ("once", "hourly", "daily", "weekdays", "weekly", "monthly", "cron")
PRESET_KINDS = ("hourly", "daily", "weekdays", "weekly", "monthly")
DOW_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")   # index 0 = Monday (Python weekday())
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
# standard cron day-of-week: 0 and 7 = Sunday, 1 = Monday ... 6 = Saturday
_CRON_DOW = {0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 7: "sun"}


class PlantCronTrigger(CronTrigger):
    """CronTrigger that is safe across DST. Stock APScheduler on zoneinfo returns a non-existent wall time in a
    spring-forward gap and fires an ambiguous fall-back hour twice (the second pass can even repeat forever).
    Here every candidate is derived from instants (UTC), normalised through UTC so a gap time lands after the
    gap (02:30 -> 03:30), and fire times are strictly increasing, so an ambiguous 01:30 fires once."""

    def get_next_fire_time(self, previous_fire_time, now):
        now_utc = now.astimezone(_tz.utc)
        if previous_fire_time is not None:
            now_utc = max(now_utc, previous_fire_time.astimezone(_tz.utc) + timedelta(seconds=1))
        for _ in range(3):
            cand = super().get_next_fire_time(None, now_utc)
            if cand is None:
                return None
            cand = cand.astimezone(_tz.utc).astimezone(self.timezone)
            if (previous_fire_time is not None
                    and cand.replace(tzinfo=None) == previous_fire_time.astimezone(self.timezone).replace(tzinfo=None)):
                now_utc = cand.astimezone(_tz.utc) + timedelta(seconds=1)   # second pass of an ambiguous hour
                continue
            return cand
        return None


class ScheduleError(ValueError):
    """A schedule payload that cannot be compiled (the route turns it into a 400)."""


def get_zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo((name or "").strip() or "UTC")
    except (ZoneInfoNotFoundError, ValueError, OSError) as e:
        raise ScheduleError(f"unknown timezone {name!r}") from e


def parse_time_of_day(value) -> tuple[int, int]:
    m = _TIME_RE.match(str(value or "").strip())
    if not m:
        raise ScheduleError("time_of_day must be HH:MM (00:00-23:59)")
    return int(m.group(1)), int(m.group(2))


def _to_naive(value, field: str) -> datetime | None:
    """Accept a datetime or ISO string; return a naive plant-local datetime. The value is a wall-clock time,
    never an instant, so any offset is dropped rather than converted."""
    if value in (None, ""):
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.strip().replace("Z", ""))
        except ValueError as e:
            raise ScheduleError(f"{field} is not an ISO date-time") from e
    if not isinstance(value, datetime):
        raise ScheduleError(f"{field} is not a date-time")
    return value.replace(tzinfo=None)


def _normalize_dow_token(token: str) -> str:
    """One day-of-week cron token. Names pass through; numbers are translated from standard cron semantics
    (0/7 = Sunday) to names, because APScheduler numbers Monday as 0 and the two would silently disagree."""
    token = token.strip().lower()
    if not token or token == "*" or re.search(r"[a-z]", token):
        return token
    step = 1
    body = token
    if "/" in token:
        body, s = token.split("/", 1)
        if not s.isdigit() or int(s) < 1:
            raise ScheduleError("bad day-of-week step")
        step = int(s)
    if body == "*":
        lo, hi = 0, 6
    elif "-" in body:
        a, b = body.split("-", 1)
        if not (a.isdigit() and b.isdigit()):
            raise ScheduleError("bad day-of-week range")
        lo, hi = int(a), int(b)
    elif body.isdigit():
        lo = hi = int(body)
    else:
        raise ScheduleError("bad day-of-week value")
    if not (0 <= lo <= 7 and 0 <= hi <= 7 and lo <= hi):
        raise ScheduleError("day-of-week must be 0-7 (0 and 7 are Sunday)")
    names: list[str] = []
    for n in range(lo, hi + 1, step):
        nm = _CRON_DOW[n]
        if nm not in names:
            names.append(nm)
    return ",".join(names)


def _normalize_cron(expr: str) -> tuple[str, dict]:
    parts = str(expr or "").split()
    if len(parts) != 5:
        raise ScheduleError("cron expression needs 5 fields: minute hour day month day-of-week")
    minute, hour, day, month, dow = parts
    dow = ",".join(_normalize_dow_token(t) for t in dow.split(","))
    fields = {"minute": minute, "hour": hour, "day": day, "month": month, "day_of_week": dow}
    return " ".join((minute, hour, day, month, dow)), fields


def compile_cron(row: dict) -> tuple[str, dict]:
    """(cron_expr, CronTrigger field kwargs) for a non-once schedule row."""
    kind = row.get("kind")
    if kind == "cron":
        return _normalize_cron(row.get("cron_expr"))
    if kind not in PRESET_KINDS:
        raise ScheduleError(f"unknown schedule kind {kind!r}")
    hh, mm = parse_time_of_day(row.get("time_of_day"))
    if kind == "hourly":
        return _normalize_cron(f"{mm} * * * *")
    if kind == "daily":
        return _normalize_cron(f"{mm} {hh} * * *")
    if kind == "weekdays":
        return _normalize_cron(f"{mm} {hh} * * mon-fri")
    if kind == "weekly":
        days = row.get("days_of_week") or []
        if not days or any((not isinstance(d, int)) or isinstance(d, bool) or not 0 <= d <= 6 for d in days):
            raise ScheduleError("weekly needs days_of_week: integers 0 (Monday) to 6 (Sunday)")
        names = ",".join(DOW_NAMES[d] for d in sorted(set(days)))
        return _normalize_cron(f"{mm} {hh} * * {names}")
    dom = row.get("day_of_month")                                  # monthly
    if not isinstance(dom, int) or isinstance(dom, bool) or not 1 <= dom <= 31:
        raise ScheduleError("monthly needs day_of_month 1-31")
    return _normalize_cron(f"{mm} {hh} {dom} * *")


def validate_schedule(row: dict) -> dict:
    """Normalise a schedule payload: returns the columns to store (cron_expr compiled, times naive) or raises
    ScheduleError. Builds the trigger once so anything APScheduler would reject is rejected here."""
    kind = row.get("kind")
    if kind not in KINDS:
        raise ScheduleError(f"kind must be one of {', '.join(KINDS)}")
    get_zone(row.get("timezone"))
    out = {
        "kind": kind, "timezone": (row.get("timezone") or "UTC").strip(), "cron_expr": None, "time_of_day": None,
        "days_of_week": None, "day_of_month": None, "run_at": None,
        "valid_from": _to_naive(row.get("valid_from"), "valid_from"),
        "valid_until": _to_naive(row.get("valid_until"), "valid_until"),
    }
    if out["valid_from"] and out["valid_until"] and out["valid_until"] <= out["valid_from"]:
        raise ScheduleError("valid_until must be after valid_from")
    if kind == "once":
        out["run_at"] = _to_naive(row.get("run_at"), "run_at")
        if out["run_at"] is None:
            raise ScheduleError("once needs run_at")
    else:
        if kind in PRESET_KINDS:
            hh, mm = parse_time_of_day(row.get("time_of_day"))
            out["time_of_day"] = f"{hh:02d}:{mm:02d}"
        if kind == "weekly":
            out["days_of_week"] = sorted(set(row.get("days_of_week") or []))
        if kind == "monthly":
            out["day_of_month"] = row.get("day_of_month")
        out["cron_expr"], _ = compile_cron({**out, "cron_expr": row.get("cron_expr")})
    try:
        build_trigger(out)
    except ScheduleError:
        raise
    except (ValueError, TypeError) as e:
        raise ScheduleError(f"invalid schedule: {e}") from e
    return out


def build_trigger(row: dict):
    """APScheduler trigger for a schedule row (dict with the job_schedule columns)."""
    tz = get_zone(row.get("timezone"))
    start = _to_naive(row.get("valid_from"), "valid_from")
    end = _to_naive(row.get("valid_until"), "valid_until")
    if row.get("kind") == "once":
        run_at = _to_naive(row.get("run_at"), "run_at")
        if run_at is None:
            raise ScheduleError("once needs run_at")
        return DateTrigger(run_date=run_at, timezone=tz)
    _, fields = compile_cron(row)
    return PlantCronTrigger(**fields, timezone=tz,
                       start_date=start.replace(tzinfo=tz) if start else None,
                       end_date=end.replace(tzinfo=tz) if end else None)


def next_fire_times(row: dict, n: int = 5, *, now: datetime | None = None) -> list[datetime]:
    """The next `n` fire instants (aware, plant timezone) from the SAME trigger the scheduler uses."""
    trig = build_trigger(row)
    now = (now or datetime.now(_tz.utc)).astimezone(get_zone(row.get("timezone")))
    out: list[datetime] = []
    prev = None
    cursor = now
    for _ in range(max(0, min(int(n), 50))):
        nxt = trig.get_next_fire_time(prev, cursor)
        if nxt is None:
            break
        out.append(nxt)
        prev, cursor = nxt, nxt + timedelta(microseconds=1)
    return out


def preview(row: dict, n: int = 5, *, now: datetime | None = None) -> list[dict]:
    """Wire form of `next_fire_times`; `dst_shifted` marks a preset fire whose local wall time differs from the
    configured time_of_day (a spring-forward gap moved it) so the UI can warn."""
    want = None
    if row.get("kind") in ("daily", "weekdays", "weekly", "monthly") and row.get("time_of_day"):
        want = parse_time_of_day(row["time_of_day"])
    res = []
    for t in next_fire_times(row, n, now=now):
        res.append({
            "at_utc": t.astimezone(_tz.utc).isoformat(timespec="seconds"),
            "at_local": t.isoformat(timespec="seconds"),
            "dst_shifted": bool(want and (t.hour, t.minute) != want),
        })
    return res
