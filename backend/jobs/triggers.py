"""Schedule -> fire times. Pure (stdlib + APScheduler); no DB, no project imports.

ONE layer decides when a schedule fires: `occurrences(row, ...)` turns a stored `job_schedule` row (plus its
`options` policy, plus an INJECTED calendar view) into an ordered stream of fire / policy-skip occurrences. The
scheduler's trigger (`PolicyTrigger`), the next-N preview, the timeline's upcoming bars, the fire-time re-check and the
catch-up planner all read that one stream, so what the UI promises is what fires.

Time model. `once`, `daily`, `weekdays`, `weekly`, `monthly` and `cron` are wall-clock schedules in the row's IANA
`timezone`: a raw wall time (naive, plant-local) is produced by a floating cron, then mapped to an instant by the DST
policy (`dst_gap` shift|skip, `dst_overlap` once|twice), after the closed-day rule (run|skip|next|previous working
day, decided on the raw wall date) and before the run window. `hourly` is a UTC-anchored real-time interval (the minute
offset is kept), so the fall-back day has 25 fires and the spring-forward day 23; it ignores the DST options.

Calendar data comes in through a duck-typed `cal` with `is_working_day(plant, date)`, `next_working_day(plant, date)`
and `previous_working_day(plant, date)` (see backend/jobs/calview.py); `cal=None` means every day is a working day.
"""
from __future__ import annotations

import heapq
import re
from dataclasses import dataclass
from datetime import date, datetime, time as _time, timedelta, timezone as _tz
from typing import Iterator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.triggers.base import BaseTrigger
from apscheduler.triggers.cron import CronTrigger

KINDS = ("once", "hourly", "daily", "weekdays", "weekly", "monthly", "cron")
PRESET_KINDS = ("hourly", "daily", "weekdays", "weekly", "monthly")
DOW_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")   # index 0 = Monday (Python weekday())
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
# standard cron day-of-week: 0 and 7 = Sunday, 1 = Monday ... 6 = Saturday
_CRON_DOW = {0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 7: "sun"}

DST_GAP = ("shift", "skip")
DST_OVERLAP = ("once", "twice")
CLOSED_DAY = ("run", "skip", "next_working_day", "previous_working_day")
WINDOW_ACTIONS = ("skip", "defer")
MONTHLY_MODES = ("day_of_month", "last_day", "first_working_day", "last_working_day")
WORKING_MONTHLY = ("first_working_day", "last_working_day")
MOVABLE_KINDS = ("once", "daily", "weekdays", "weekly", "monthly")   # closed-day moves keep a once-a-day shape
MAX_SHIFT_DAYS = 31              # next / previous working day search; none within it = the occurrence is skipped
MAX_SCAN = 4000                  # raw occurrences one consumer may scan before it gives up
CATCH_UP_GRACE_DEFAULT_S = 3600
OPTION_KEYS = ("dst_gap", "dst_overlap", "closed_day", "run_window", "monthly", "monthly_clamp", "catch_up")
_UTC = ZoneInfo("UTC")


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


# ------------------------------------------------------------------------------------------------------- policy
@dataclass(frozen=True)
class Policy:
    """The schedule's options. Defaults reproduce the pre-W3b behaviour exactly (a NULL `options` column)."""
    dst_gap: str = "shift"
    dst_overlap: str = "once"
    closed_day: str = "run"
    run_window: tuple | None = None          # (start_minute, end_minute, 'skip'|'defer'), plant-local, [start, end)
    monthly: str = "day_of_month"
    monthly_clamp: bool = False              # day 29-31 in a short month: false = no fire that month, true = last day
    catch_up: bool = True
    grace_s: int = CATCH_UP_GRACE_DEFAULT_S

    def needs_calendar(self) -> bool:
        """The fire times depend on the plant calendar (so the arm re-arms when the calendar changes)."""
        return self.closed_day != "run" or self.monthly in WORKING_MONTHLY

    def needs_recheck(self) -> bool:
        """A fire is re-evaluated against current data at fire time (calendar-driven or window rules)."""
        return self.needs_calendar() or self.run_window is not None


def _hhmm(v, what: str) -> int:
    h, m = parse_time_of_day(v)
    return h * 60 + m


def normalize_options(options, kind: str) -> dict | None:
    """Validate an `options` payload and return the dict to store (every key explicit), or None when nothing was set.
    Raises ScheduleError. Calendar-driven rules that need a PLANT's calendar are also checked against `tz_mode` by the
    route (`options_need_plant_time`)."""
    if options in (None, {}):
        return None
    if not isinstance(options, dict):
        raise ScheduleError("options must be an object")
    extra = set(options) - set(OPTION_KEYS)
    if extra:
        raise ScheduleError(f"unknown option(s): {', '.join(sorted(extra))}")
    out = {"dst_gap": options.get("dst_gap", "shift"), "dst_overlap": options.get("dst_overlap", "once"),
           "closed_day": options.get("closed_day", "run"), "run_window": None,
           "monthly": options.get("monthly", "day_of_month"), "monthly_clamp": bool(options.get("monthly_clamp", False)),
           "catch_up": {"enabled": True, "grace_s": CATCH_UP_GRACE_DEFAULT_S}}
    for key, allowed in (("dst_gap", DST_GAP), ("dst_overlap", DST_OVERLAP), ("closed_day", CLOSED_DAY),
                         ("monthly", MONTHLY_MODES)):
        if out[key] not in allowed:
            raise ScheduleError(f"{key} must be one of {', '.join(allowed)}")
    if out["closed_day"] in ("next_working_day", "previous_working_day") and kind not in MOVABLE_KINDS:
        raise ScheduleError("next/previous working day needs a once-a-day schedule (daily, weekdays, weekly or monthly)")
    if (out["monthly"] != "day_of_month" or out["monthly_clamp"]) and kind != "monthly":
        raise ScheduleError("monthly options need a monthly schedule")
    rw = options.get("run_window")
    if rw is not None:
        if not isinstance(rw, dict) or set(rw) - {"start", "end", "action"}:
            raise ScheduleError("run_window must be {start, end, action}")
        start, end = _hhmm(rw.get("start"), "run_window.start"), _hhmm(rw.get("end"), "run_window.end")
        if start == end:
            raise ScheduleError("run_window start and end must differ")
        action = rw.get("action", "skip")
        if action not in WINDOW_ACTIONS:
            raise ScheduleError("run_window.action must be skip or defer")
        out["run_window"] = {"start": f"{start // 60:02d}:{start % 60:02d}", "end": f"{end // 60:02d}:{end % 60:02d}",
                             "action": action}
    cu = options.get("catch_up")
    if cu is not None:
        if not isinstance(cu, dict) or set(cu) - {"enabled", "grace_s"}:
            raise ScheduleError("catch_up must be {enabled, grace_s}")
        grace = cu.get("grace_s", CATCH_UP_GRACE_DEFAULT_S)
        if isinstance(grace, bool) or not isinstance(grace, int) or not 60 <= grace <= 86400:
            raise ScheduleError("catch_up.grace_s must be 60-86400 seconds")
        out["catch_up"] = {"enabled": bool(cu.get("enabled", True)), "grace_s": grace}
    return out


def options_need_plant_time(options) -> bool:
    """True when the options use a plant calendar rule, which only makes sense in the plant's own time."""
    if not options:
        return False
    return (options.get("closed_day", "run") != "run" or options.get("monthly") in WORKING_MONTHLY)


def policy_of(row: dict) -> Policy:
    """The Policy of a stored row. Lenient: a bad stored value falls back to its default rather than breaking the
    scheduler (the route validated it on the way in)."""
    o = row.get("options") or {}
    if not isinstance(o, dict):
        return Policy()
    rw = o.get("run_window")
    window = None
    if isinstance(rw, dict):
        try:
            window = (_hhmm(rw["start"], "start"), _hhmm(rw["end"], "end"),
                      rw.get("action") if rw.get("action") in WINDOW_ACTIONS else "skip")
        except (KeyError, ScheduleError):
            window = None
    cu = o.get("catch_up") if isinstance(o.get("catch_up"), dict) else {}
    grace = cu.get("grace_s", CATCH_UP_GRACE_DEFAULT_S)
    return Policy(
        dst_gap=o.get("dst_gap") if o.get("dst_gap") in DST_GAP else "shift",
        dst_overlap=o.get("dst_overlap") if o.get("dst_overlap") in DST_OVERLAP else "once",
        closed_day=o.get("closed_day") if o.get("closed_day") in CLOSED_DAY else "run",
        run_window=window,
        monthly=o.get("monthly") if o.get("monthly") in MONTHLY_MODES else "day_of_month",
        monthly_clamp=bool(o.get("monthly_clamp", False)),
        catch_up=bool(cu.get("enabled", True)),
        grace_s=grace if isinstance(grace, int) and not isinstance(grace, bool) and 60 <= grace <= 86400
        else CATCH_UP_GRACE_DEFAULT_S)


# ------------------------------------------------------------------------------------------------------ cron compile
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


def _monthly_mode(row: dict) -> str:
    o = row.get("options") or {}
    return o.get("monthly") if o.get("monthly") in MONTHLY_MODES else "day_of_month"


def compile_cron(row: dict) -> tuple[str, dict]:
    """(cron_expr, CronTrigger field kwargs) for a non-once schedule row. For the calendar-driven monthly modes the
    expression is only a stand-in for display (`1` / `last`): the real days come from the calendar."""
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
    mode = _monthly_mode(row)                                      # monthly
    if mode == "last_day":
        return _normalize_cron(f"{mm} {hh} last * *")
    if mode == "first_working_day":
        return _normalize_cron(f"{mm} {hh} 1 * *")
    if mode == "last_working_day":
        return _normalize_cron(f"{mm} {hh} last * *")
    dom = row.get("day_of_month")
    if not isinstance(dom, int) or isinstance(dom, bool) or not 1 <= dom <= 31:
        raise ScheduleError("monthly needs day_of_month 1-31")
    return _normalize_cron(f"{mm} {hh} {dom} * *")


def validate_schedule(row: dict) -> dict:
    """Normalise a schedule payload: returns the columns to store (cron_expr compiled, times naive, options normalised)
    or raises ScheduleError. Builds the trigger once so anything APScheduler would reject is rejected here."""
    kind = row.get("kind")
    if kind not in KINDS:
        raise ScheduleError(f"kind must be one of {', '.join(KINDS)}")
    get_zone(row.get("timezone"))
    out = {
        "kind": kind, "timezone": (row.get("timezone") or "UTC").strip(), "cron_expr": None, "time_of_day": None,
        "days_of_week": None, "day_of_month": None, "run_at": None,
        "valid_from": _to_naive(row.get("valid_from"), "valid_from"),
        "valid_until": _to_naive(row.get("valid_until"), "valid_until"),
        "options": normalize_options(row.get("options"), kind),
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
        if kind == "monthly" and _monthly_mode(out) == "day_of_month":
            out["day_of_month"] = row.get("day_of_month")
        out["cron_expr"], _ = compile_cron({**out, "cron_expr": row.get("cron_expr")})
    try:
        build_trigger(out)
    except ScheduleError:
        raise
    except (ValueError, TypeError) as e:
        raise ScheduleError(f"invalid schedule: {e}") from e
    return out


# ------------------------------------------------------------------------------------------------- the one stream
@dataclass
class Occ:
    """One occurrence the policy produced: a fire, or a policy-skip (`kind == 'skip'`, with its `reason` code)."""
    at: datetime                      # aware, plant timezone (for a skip: where it would have fallen)
    kind: str = "fire"
    reason: str | None = None         # skip: closed_day | no_working_day | dst_gap | outside_run_window | outside_validity
    shifted: bool = False             # a spring-forward gap moved it (wall time differs from the configured one)
    note: str | None = None           # dst_overlap_second | moved_next_working_day | moved_previous_working_day | deferred_to_window
    raw: datetime | None = None       # the configured wall time (naive plant-local) it came from

    @property
    def utc(self) -> datetime:
        return self.at.astimezone(_tz.utc)


def _instants(w: datetime, tz: ZoneInfo, pol: Policy) -> list[tuple[datetime, str | None]]:
    """Instants for one naive wall time: [(aware local, flag)] with flag None | 'gap' | 'second'. A gap time lands after
    the gap (02:30 -> 03:30); an ambiguous time is the first instance, plus the second under dst_overlap 'twice'."""
    a = w.replace(tzinfo=tz, fold=0)
    first = a.astimezone(_tz.utc).astimezone(tz)
    if first.replace(tzinfo=None) != w:
        return [(first, "gap")]
    b = w.replace(tzinfo=tz, fold=1)
    out: list[tuple[datetime, str | None]] = [(first, None)]
    if b.utcoffset() != a.utcoffset() and pol.dst_overlap == "twice":
        out.append((b.astimezone(_tz.utc).astimezone(tz), "second"))
    return out


def _window_hit(at: datetime, pol: Policy, tz: ZoneInfo, base: Occ, cal=None, plant: str | None = None) -> Occ:
    """Apply the run window to a fire: inside = as is; outside = skip, or defer to the next opening. A deferral that
    lands on a closed day re-applies the closed-day rule (bounded): `skip` skips it, a move rule walks forward to the
    next working day's opening (never backward: a deferred fire stays after the time it was due)."""
    if pol.run_window is None:
        return base
    s, e, action = pol.run_window
    m = at.hour * 60 + at.minute
    inside = s <= m < e if s < e else (m >= s or m < e)
    if inside:
        return base
    if action == "skip":
        return Occ(at, "skip", "outside_run_window", raw=base.raw)
    day = at.date() if m < s else at.date() + timedelta(days=1)
    if pol.closed_day != "run" and cal is not None:
        for _ in range(MAX_SHIFT_DAYS + 2):
            if cal.is_working_day(plant, day):
                break
            if pol.closed_day == "skip":
                return Occ(at, "skip", "closed_day", raw=base.raw)
            nxt = cal.next_working_day(plant, day)
            if nxt is None:
                return Occ(at, "skip", "no_working_day", raw=base.raw)
            day = nxt
        else:
            return Occ(at, "skip", "no_working_day", raw=base.raw)
    w2 = datetime.combine(day, _time(s // 60, s % 60))
    inst, flag = _instants(w2, tz, Policy(dst_overlap="once"))[0]
    return Occ(inst, "fire", shifted=flag == "gap", note="deferred_to_window", raw=base.raw)


def _process_wall(w: datetime, tz: ZoneInfo, pol: Policy, cal, plant: str | None) -> list[Occ]:
    note = None
    if pol.closed_day != "run" and cal is not None and not cal.is_working_day(plant, w.date()):
        if pol.closed_day == "skip":
            return [Occ(_instants(w, tz, pol)[0][0], "skip", "closed_day", raw=w)]
        fn = cal.next_working_day if pol.closed_day == "next_working_day" else cal.previous_working_day
        d2 = fn(plant, w.date())
        if d2 is None:
            return [Occ(_instants(w, tz, pol)[0][0], "skip", "no_working_day", raw=w)]
        w = datetime.combine(d2, w.time())
        note = "moved_" + pol.closed_day
    out: list[Occ] = []
    for at, flag in _instants(w, tz, pol):
        if flag == "gap" and pol.dst_gap == "skip":
            out.append(Occ(at, "skip", "dst_gap", raw=w))
            continue
        base = Occ(at, "fire", shifted=flag == "gap", note="dst_overlap_second" if flag == "second" else note, raw=w)
        out.append(_window_hit(at, pol, tz, base, cal, plant))
    return out


def _process_instant(at: datetime, tz: ZoneInfo, pol: Policy, cal, plant: str | None) -> list[Occ]:
    """An hourly instant: only the closed-day skip and the run window apply (no wall-clock mapping)."""
    if pol.closed_day == "skip" and cal is not None and not cal.is_working_day(plant, at.date()):
        return [Occ(at, "skip", "closed_day", raw=at.replace(tzinfo=None))]
    return [_window_hit(at, pol, tz, Occ(at, "fire", raw=at.replace(tzinfo=None)), cal, plant)]


def _floating_cron(row: dict) -> CronTrigger:
    """A cron read as FLOATING wall time (UTC stands in for 'no zone'), so its output is the configured wall clock and
    DST never touches it."""
    _, fields = compile_cron(row)
    return CronTrigger(**fields, timezone=_UTC)


def _is_cron_kind(row: dict, pol: Policy) -> bool:
    if row.get("kind") == "monthly":
        return pol.monthly in ("day_of_month", "last_day") and not (pol.monthly == "day_of_month" and pol.monthly_clamp)
    return row.get("kind") not in ("once", "hourly")


def _monthly_walls(row: dict, pol: Policy, cal, plant, lo: datetime, vu: datetime | None) -> Iterator[datetime]:
    """Raw wall times for the calendar-driven / clamped monthly modes, ascending, from `lo`."""
    hh, mm = parse_time_of_day(row.get("time_of_day"))
    first = date(lo.year, lo.month, 1)
    y, mth = first.year, first.month
    for _ in range(MAX_SCAN):
        last = (date(y + (mth == 12), mth % 12 + 1, 1) - timedelta(days=1)).day
        pick = None
        if pol.monthly == "last_day":
            pick = last
        elif pol.monthly == "day_of_month":
            dom = int(row.get("day_of_month") or 1)
            pick = min(dom, last) if pol.monthly_clamp else (dom if dom <= last else None)
        else:
            days = range(1, last + 1) if pol.monthly == "first_working_day" else range(last, 0, -1)
            for d in days:
                if cal is None or cal.is_working_day(plant, date(y, mth, d)):
                    pick = d
                    break
        if pick is not None:
            w = datetime(y, mth, pick, hh, mm)
            if vu is not None and w > vu:
                return
            if w >= lo:
                yield w
        y, mth = y + (mth == 12), mth % 12 + 1
        if y > 9998:
            return


def _raw_walls(row: dict, pol: Policy, cal, plant, lo: datetime) -> Iterator[datetime]:
    vf, vu = _to_naive(row.get("valid_from"), "valid_from"), _to_naive(row.get("valid_until"), "valid_until")
    if row.get("kind") == "once":
        w = _to_naive(row.get("run_at"), "run_at")
        if w is not None and w >= lo:
            yield w
        return
    if vf is not None and vf > lo:
        lo = vf
    if not _is_cron_kind(row, pol):
        yield from _monthly_walls(row, pol, cal, plant, lo, vu)
        return
    trig = _floating_cron(row)
    cursor = lo.replace(tzinfo=_UTC)
    for _ in range(MAX_SCAN):
        nxt = trig.get_next_fire_time(None, cursor)
        if nxt is None:
            return
        w = nxt.replace(tzinfo=None)
        if vu is not None and w > vu:
            return
        yield w
        cursor = nxt + timedelta(seconds=1)


def _raw_hourly(row: dict, tz: ZoneInfo, start: datetime) -> Iterator[datetime]:
    """UTC-anchored hourly instants (aware, plant tz) from `start` (aware), keeping the configured minute offset."""
    _, mm = parse_time_of_day(row.get("time_of_day"))
    ref = datetime(2024, 1, 15, 12, tzinfo=_tz.utc).astimezone(tz).utcoffset()
    m_utc = (mm - int(ref.total_seconds() // 60)) % 60
    vf, vu = _to_naive(row.get("valid_from"), "valid_from"), _to_naive(row.get("valid_until"), "valid_until")
    if vf is not None:
        start = max(start, vf.replace(tzinfo=tz).astimezone(_tz.utc))
    t = start.astimezone(_tz.utc).replace(minute=m_utc, second=0, microsecond=0)
    if t < start:
        t += timedelta(hours=1)
    for _ in range(MAX_SCAN):
        local = t.astimezone(tz)
        if vu is not None and local.replace(tzinfo=None) > vu:
            return
        yield local
        t += timedelta(hours=1)


def _bound(occs: list[Occ], row: dict) -> list[Occ]:
    """Validity (`valid_from` / `valid_until`) on the FINAL instant: a fire that a closed-day move or a window deferral
    carried outside the bounds becomes a skip `outside_validity` (the raw wall time was checked when it was generated).
    A once schedule ignores validity, as before."""
    if row.get("kind") == "once":
        return occs
    vf, vu = _to_naive(row.get("valid_from"), "valid_from"), _to_naive(row.get("valid_until"), "valid_until")
    if vf is None and vu is None:
        return occs
    out = []
    for o in occs:
        if o.kind == "fire" and o.note in ("moved_next_working_day", "moved_previous_working_day", "deferred_to_window"):
            local = o.at.replace(tzinfo=None)
            if (vf is not None and local < vf) or (vu is not None and local > vu):
                o = Occ(o.at, "skip", "outside_validity", raw=o.raw)
        out.append(o)
    return out


def occurrences(row: dict, *, after: datetime, cal=None, plant: str | None = None) -> Iterator[Occ]:
    """Fire and policy-skip occurrences with `at >= after`, ascending (an unbounded stream: the caller stops). `after`
    is an aware datetime. `plant` names whose calendar `cal` is asked about (the arm's plant, else the home plant)."""
    pol = policy_of(row)
    tz = get_zone(row.get("timezone"))
    plant = plant or row.get("arm_plant") or row.get("plant")
    after = after.astimezone(_tz.utc)
    if pol.closed_day == "next_working_day" or (pol.run_window is not None and pol.closed_day != "run"):
        fwd = timedelta(days=MAX_SHIFT_DAYS + 2)       # a move, or a deferral that walks past closed days, looks ahead
    elif pol.run_window is not None:
        fwd = timedelta(days=2)
    else:
        fwd = timedelta(hours=6)
    back = timedelta(days=MAX_SHIFT_DAYS + 2) if pol.closed_day == "previous_working_day" else timedelta(hours=4)
    start = after - fwd
    if row.get("kind") == "hourly":
        source = ((at, _bound(_process_instant(at, tz, pol, cal, plant), row)) for at in _raw_hourly(row, tz, start))
    else:
        lo = start.astimezone(tz).replace(tzinfo=None)
        source = ((w, _bound(_process_wall(w, tz, pol, cal, plant), row)) for w in _raw_walls(row, pol, cal, plant, lo))
    heap: list = []
    seq = 0
    seen: set = set()

    def pop(limit: datetime | None):
        while heap and (limit is None or heap[0][0] <= limit):
            inst, _, o = heapq.heappop(heap)
            key = (inst, o.kind, o.reason)
            if inst < after or key in seen:
                continue
            seen.add(key)
            yield o

    for item, occs in source:
        for o in occs:
            seq += 1
            heapq.heappush(heap, (o.utc, seq, o))
        ref = (item if isinstance(item, datetime) and item.tzinfo else item.replace(tzinfo=tz)).astimezone(_tz.utc)
        yield from pop(ref - back)
    yield from pop(None)


# -------------------------------------------------------------------------------------------------- the trigger
class PolicyTrigger(BaseTrigger):
    """The APScheduler trigger: the next FIRE of the occurrence stream. `cal` is a snapshot taken when the arm was
    built; the scheduler re-arms when the plant calendar changes, and fire time re-checks against current data."""

    def __init__(self, row: dict, cal=None, plant: str | None = None):
        self.row = dict(row)
        self.cal = cal
        self.plant = plant
        self.timezone = get_zone(row.get("timezone"))
        if row.get("kind") not in ("once", "hourly"):
            _floating_cron(row)                      # a bad cron field fails here, at build time

    def get_next_fire_time(self, previous_fire_time, now):
        cursor = now.astimezone(_tz.utc)
        if previous_fire_time is not None:
            cursor = max(cursor, previous_fire_time.astimezone(_tz.utc) + timedelta(seconds=1))
        for n, o in enumerate(occurrences(self.row, after=cursor, cal=self.cal, plant=self.plant)):
            if o.kind == "fire":
                return o.at
            if n > MAX_SCAN:
                break
        return None

    def __str__(self):
        return f"policy[{self.row.get('kind')} {self.row.get('cron_expr') or self.row.get('run_at')}]"


def build_trigger(row: dict, *, cal=None, plant: str | None = None):
    """APScheduler trigger for a schedule row (dict with the job_schedule columns). The ONE place a row becomes a
    trigger; `cal` is the injected calendar view (None = every day works)."""
    get_zone(row.get("timezone"))
    if row.get("kind") == "once" and _to_naive(row.get("run_at"), "run_at") is None:
        raise ScheduleError("once needs run_at")
    return PolicyTrigger(row, cal=cal, plant=plant or row.get("arm_plant") or row.get("plant"))


def _plant_of(row: dict, plant: str | None) -> str | None:
    return plant or row.get("arm_plant") or row.get("plant")


def fires(row: dict, *, after: datetime, n: int, cal=None, plant: str | None = None) -> tuple[list[Occ], list[Occ]]:
    """(fires, skips): the next `n` fires from `after`, and the policy-skipped occurrences that fall before the last of
    them (or within the scan cap when fewer than `n` fires exist). The preview, `next_fire_times` and the timeline are
    all this call."""
    out: list[Occ] = []
    skipped: list[Occ] = []
    for scanned, o in enumerate(occurrences(row, after=after, cal=cal, plant=_plant_of(row, plant))):
        if o.kind == "fire":
            out.append(o)
            if len(out) >= n:
                break
        elif len(skipped) < 60:
            skipped.append(o)
        if scanned > MAX_SCAN:
            break
    return out, skipped


def fires_between(row: dict, *, start: datetime, end: datetime, cap: int = 300, cal=None,
                  plant: str | None = None) -> list[Occ]:
    """Fires with start <= at < end (aware bounds), at most `cap`."""
    out: list[Occ] = []
    for scanned, o in enumerate(occurrences(row, after=start, cal=cal, plant=_plant_of(row, plant))):
        if o.at.astimezone(_tz.utc) >= end.astimezone(_tz.utc) or scanned > MAX_SCAN:
            break
        if o.kind == "fire":
            out.append(o)
            if len(out) >= cap:
                break
    return out


def next_fire_times(row: dict, n: int = 5, *, now: datetime | None = None, cal=None,
                    plant: str | None = None) -> list[datetime]:
    """The next `n` fire instants (aware, plant timezone) from the SAME occurrence stream the scheduler uses."""
    got, _ = fires(row, after=now or datetime.now(_tz.utc), n=max(0, min(int(n), 50)), cal=cal, plant=plant)
    return [o.at for o in got]


def occ_wire(o: Occ) -> dict:
    return {"at_utc": o.utc.isoformat(timespec="seconds"), "at_local": o.at.isoformat(timespec="seconds"),
            "dst_shifted": bool(o.shifted), "dst_skipped": o.kind == "skip" and o.reason == "dst_gap",
            "policy_note": ("dst_gap_shifted" if o.shifted and not o.note else o.note) if o.kind == "fire" else None,
            **({"reason": o.reason} if o.kind == "skip" else {})}


def preview_full(row: dict, n: int = 5, *, now: datetime | None = None, cal=None,
                 plant: str | None = None) -> tuple[list[dict], list[dict]]:
    """(entries, skipped) in wire form. `entries` = the next `n` fires with `dst_shifted` (a gap moved it), `dst_skipped`
    (false), `policy_note` (dst_gap_shifted | dst_overlap_second | moved_next_working_day | moved_previous_working_day |
    deferred_to_window | null); `skipped` = occurrences the policy removed, each with its `reason` code."""
    got, skipped = fires(row, after=now or datetime.now(_tz.utc), n=max(0, min(int(n), 50)), cal=cal, plant=plant)
    limit = got[-1].utc if len(got) >= max(0, min(int(n), 50)) and got else None
    return [occ_wire(o) for o in got], [occ_wire(o) for o in skipped if limit is None or o.utc <= limit]


def preview(row: dict, n: int = 5, *, now: datetime | None = None, cal=None, plant: str | None = None) -> list[dict]:
    """Wire form of `next_fire_times`; `dst_shifted` marks a fire a spring-forward gap moved."""
    return preview_full(row, n, now=now, cal=cal, plant=plant)[0]


# ------------------------------------------------------------------------------------- fire-time re-check, catch-up
SKIP_TEXT = {"closed_day": "closed day", "no_working_day": "closed day", "outside_run_window": "outside run window",
             "dst_gap": "daylight-saving gap"}


def recheck(row: dict, *, at: datetime, window_s: int, cal=None, plant: str | None = None) -> str | None:
    """Fire-time re-evaluation against CURRENT data. None = the stream has a fire within `window_s` seconds before `at`
    (so this fire stands); otherwise the reason text it is now rejected ('closed day', 'outside run window', else
    'schedule changed')."""
    plant = _plant_of(row, plant)
    at = at.astimezone(_tz.utc)
    for scanned, o in enumerate(occurrences(row, after=at - timedelta(seconds=window_s), cal=cal, plant=plant)):
        if o.utc > at + timedelta(seconds=5) or scanned > MAX_SCAN:
            break
        if o.kind == "fire":
            return None
    last = "schedule changed"
    for scanned, o in enumerate(occurrences(row, after=at - timedelta(days=1), cal=cal, plant=plant)):
        if o.utc > at + timedelta(seconds=5) or scanned > MAX_SCAN:
            break
        if o.kind == "skip" and SKIP_TEXT.get(o.reason or ""):
            last = SKIP_TEXT[o.reason]                 # the latest policy skip of the last day names the rejection
    return last


def fire_at(row: dict, *, at: datetime, window_s: int = 120, cal=None, plant: str | None = None) -> Occ | None:
    """The FIRE occurrence the stream has within `window_s` seconds before `at` (the closest one), else None. The fire
    path uses it to know WHICH occurrence it is running (for instance the second pass of a repeated hour)."""
    at = at.astimezone(_tz.utc)
    best = None
    for scanned, o in enumerate(occurrences(row, after=at - timedelta(seconds=window_s), cal=cal, plant=_plant_of(row, plant))):
        if o.utc > at + timedelta(seconds=5) or scanned > MAX_SCAN:
            break
        if o.kind == "fire":
            best = o
    return best


def blocked_now(row: dict, *, now: datetime, cal=None, plant: str | None = None) -> str | None:
    """A catch-up runs at `now`, not at the expected time, so the CURRENT instant is tested against the run window and
    the closed-day rule. Returns the reason text ('outside run window' | 'closed day') or None."""
    pol = policy_of(row)
    tz = get_zone(row.get("timezone"))
    local = now.astimezone(tz)
    if pol.run_window is not None:
        s, e, _ = pol.run_window
        m = local.hour * 60 + local.minute
        if not (s <= m < e if s < e else (m >= s or m < e)):
            return SKIP_TEXT["outside_run_window"]
    if pol.closed_day != "run" and cal is not None and not cal.is_working_day(_plant_of(row, plant), local.date()):
        return SKIP_TEXT["closed_day"]
    return None


@dataclass
class CatchUp:
    fire: Occ | None            # the one fire to run now (trigger 'catchup', scheduled_for = fire.at), or None
    missed: int                 # expected fires recorded as one skipped run (beyond grace, or older than `fire`)
    missed_last: datetime | None
    capped: bool                # more than `cap` fires were missed (the count is a lower bound)


CATCH_UP_SETTLE_S = 2
CATCH_UP_CAP = 500


def plan_catch_up(row: dict, *, baseline: datetime, now: datetime, cal=None, plant: str | None = None,
                  cap: int = CATCH_UP_CAP) -> CatchUp | None:
    """Pure catch-up plan. `baseline` = the newest instant already accounted for (last run's scheduled_for, last_fire_at
    or the schedule's modified_at); every expected fire in (baseline, now - settle] has no run. The MOST RECENT one runs
    once when the option is on and it is within `grace_s`; the rest (all of them when it is beyond grace, or the option
    is off) become one `missed` count. A `once` schedule is not caught up here (its spent logic lives in the runner)."""
    if row.get("kind") == "once":
        return None
    pol = policy_of(row)
    limit = now.astimezone(_tz.utc) - timedelta(seconds=CATCH_UP_SETTLE_S)
    base = baseline.astimezone(_tz.utc)
    got: list[Occ] = []
    capped = False
    for scanned, o in enumerate(occurrences(row, after=base + timedelta(microseconds=1), cal=cal, plant=_plant_of(row, plant))):
        if o.utc > limit or scanned > MAX_SCAN:
            break
        if o.kind != "fire":
            continue
        if len(got) >= cap:
            capped = True
            break
        got.append(o)
    if not got:
        return None
    if capped:                                  # the most recent miss is not known: count only, never fire
        return CatchUp(None, len(got), got[-1].at, True)
    last = got[-1]
    if pol.catch_up and (now.astimezone(_tz.utc) - last.utc).total_seconds() <= pol.grace_s:
        rest = got[:-1]
        return CatchUp(last, len(rest), rest[-1].at if rest else None, capped)
    return CatchUp(None, len(got), last.at, capped)
