"""W3b schedule policy (pure, no DB): DST matrix, closed days, run windows, monthly modes, catch-up planning, the
preview == trigger == fire-time-recheck property, options validation and legacy (options NULL) behaviour.

Every test pins `now`; the calendar is a fake view (the real one is exercised in test_jobs_policy_db.py)."""
from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.jobs import calview, triggers

NY, LON, SYD, SAO, HAV = "America/New_York", "Europe/London", "Australia/Sydney", "America/Sao_Paulo", "America/Havana"


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


class FakeCal:
    """Closed on the given dates and (optionally) on every Saturday / Sunday. Plant is ignored."""

    def __init__(self, closed=(), weekends=True):
        self.closed, self.weekends = {date.fromisoformat(c) if isinstance(c, str) else c for c in closed}, weekends

    def is_working_day(self, plant, d):
        return d not in self.closed and not (self.weekends and d.weekday() >= 5)

    def next_working_day(self, plant, d, limit=31):
        return next((d + timedelta(days=i) for i in range(1, limit + 1) if self.is_working_day(plant, d + timedelta(days=i))), None)

    def previous_working_day(self, plant, d, limit=31):
        return next((d - timedelta(days=i) for i in range(1, limit + 1) if self.is_working_day(plant, d - timedelta(days=i))), None)


def sched(kind="daily", tz=NY, options=None, **kw):
    base = {"kind": kind, "timezone": tz, "time_of_day": "08:00", "options": options}
    if kind == "once":
        base.pop("time_of_day")
    base.update(kw)
    return triggers.validate_schedule(base)


def local_list(s, n, now, cal=None):
    return [f.isoformat() for f in triggers.next_fire_times(s, n, now=now, cal=cal, plant="P")]


# ----------------------------------------------------------------------------------------------------- DST matrix
def test_london_gap_0130_shifts_to_0230_bst_or_skips():
    now = utc(2027, 3, 27, 12)
    shift = sched(tz=LON, time_of_day="01:30")
    assert local_list(shift, 3, now) == ["2027-03-28T02:30:00+01:00", "2027-03-29T01:30:00+01:00", "2027-03-30T01:30:00+01:00"]
    skip = sched(tz=LON, time_of_day="01:30", options={"dst_gap": "skip"})
    entries, skipped = triggers.preview_full(skip, 3, now=now, plant="P")
    assert [e["at_local"][:10] for e in entries] == ["2027-03-29", "2027-03-30", "2027-03-31"]
    assert skipped and skipped[0]["reason"] == "dst_gap" and skipped[0]["dst_skipped"] is True


def test_sydney_southern_hemisphere_gap_and_overlap():
    gap = sched(tz=SYD, time_of_day="02:30")                    # 2026-10-04 02:00 -> 03:00
    got = triggers.preview(gap, 2, now=utc(2026, 10, 3, 0), plant="P")
    assert got[0]["at_local"] == "2026-10-04T03:30:00+11:00" and got[0]["dst_shifted"] and got[0]["policy_note"] == "dst_gap_shifted"
    assert got[1]["at_local"] == "2026-10-05T02:30:00+11:00"
    ov = sched(tz=SYD, time_of_day="02:30")                     # 2027-04-04 03:00 -> 02:00 (02:30 twice)
    once = triggers.preview(ov, 3, now=utc(2027, 4, 3, 0), plant="P")
    assert [e["at_local"] for e in once] == ["2027-04-04T02:30:00+11:00", "2027-04-05T02:30:00+10:00", "2027-04-06T02:30:00+10:00"]
    twice = sched(tz=SYD, time_of_day="02:30", options={"dst_overlap": "twice"})
    t = triggers.preview(twice, 3, now=utc(2027, 4, 3, 0), plant="P")
    assert [(e["at_local"], e["policy_note"]) for e in t] == [
        ("2027-04-04T02:30:00+11:00", None), ("2027-04-04T02:30:00+10:00", "dst_overlap_second"),
        ("2027-04-05T02:30:00+10:00", None)]


def test_sao_paulo_midnight_gap_and_havana():
    now = utc(2018, 11, 2, 12)
    s = sched(tz=SAO, time_of_day="00:00")                      # 2018-11-04 00:00 does not exist -> 01:00
    got = triggers.preview(s, 3, now=now, plant="P")
    assert [e["at_local"] for e in got] == ["2018-11-03T00:00:00-03:00", "2018-11-04T01:00:00-02:00", "2018-11-05T00:00:00-02:00"]
    assert got[1]["dst_shifted"] and not got[0]["dst_shifted"]
    h = sched(tz=HAV, time_of_day="00:30")                      # 2027-03-14 00:00 -> 01:00 in Havana
    got = triggers.preview(h, 2, now=utc(2027, 3, 13, 12), plant="P")
    assert got[0]["at_local"] == "2027-03-14T01:30:00-04:00" and got[0]["dst_shifted"]


def _count_between(s, start_local, tz):
    z = ZoneInfo(tz)
    a = start_local.replace(tzinfo=z)
    b = (start_local + timedelta(days=1)).replace(tzinfo=z)
    return len(triggers.fires_between(s, start=a, end=b, cap=100, plant="P"))


def test_hourly_is_real_time_25_fires_on_fall_back_and_23_on_spring_forward():
    s = sched("hourly", time_of_day="00:15")
    assert _count_between(s, datetime(2026, 11, 1), NY) == 25
    assert _count_between(s, datetime(2027, 3, 14), NY) == 23
    assert _count_between(s, datetime(2026, 11, 2), NY) == 24
    assert _count_between(s, datetime(2026, 10, 25), LON) == 25   # UK fall-back
    first = triggers.next_fire_times(s, 3, now=utc(2026, 11, 1, 3, 40), plant="P")
    assert [f.isoformat() for f in first] == ["2026-11-01T00:15:00-04:00", "2026-11-01T01:15:00-04:00",
                                              "2026-11-01T01:15:00-05:00"]          # the repeated 01:xx hour fires twice


def test_hourly_keeps_minute_offset_in_half_hour_zone():
    s = sched("hourly", tz="Asia/Kolkata", time_of_day="00:20")
    got = triggers.next_fire_times(s, 3, now=utc(2026, 10, 28, 10, 0), plant="P")
    assert all(f.minute == 20 for f in got) and (got[1] - got[0]) == timedelta(hours=1)


def test_validity_window_straddling_a_transition():
    s = sched(time_of_day="02:30", valid_from="2027-03-13T00:00", valid_until="2027-03-14T12:00")
    got = triggers.preview(s, 5, now=utc(2027, 3, 12), plant="P")
    assert [e["at_local"][:16] for e in got] == ["2027-03-13T02:30", "2027-03-14T03:30"]
    assert got[1]["dst_shifted"]


def test_legacy_options_null_matches_documented_behaviour():
    s = sched(time_of_day="01:30")
    assert s["options"] is None
    got = triggers.preview(s, 4, now=utc(2026, 10, 31, 12), plant="P")
    assert [g["at_utc"] for g in got] == ["2026-11-01T05:30:00+00:00", "2026-11-02T06:30:00+00:00",
                                          "2026-11-03T06:30:00+00:00", "2026-11-04T06:30:00+00:00"]
    assert triggers.policy_of(s) == triggers.Policy()


def test_trigger_get_next_fire_time_follows_apscheduler_contract():
    s = sched(time_of_day="08:00")
    trig = triggers.build_trigger(s)
    now = utc(2026, 10, 28, 15)
    a = trig.get_next_fire_time(None, now)
    b = trig.get_next_fire_time(a, a)
    assert a.isoformat() == "2026-10-29T08:00:00-04:00" and b.isoformat() == "2026-10-30T08:00:00-04:00"


# --------------------------------------------------------------------------------------------------- closed days
def test_closed_day_actions_with_weekends_and_a_holiday():
    cal = FakeCal(closed=["2026-11-03"])                         # Tue closed; Sat/Sun closed
    now = utc(2026, 10, 29, 12)                                  # Thu
    daily = lambda a: sched(options={"closed_day": a})
    assert [e["at_local"][:10] for e in triggers.preview(daily("run"), 6, now=now, cal=cal, plant="P")] == [
        "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]      # default: closed days still fire
    e, sk = triggers.preview_full(daily("skip"), 6, now=now, cal=cal, plant="P")
    assert [x["at_local"][:10] for x in e] == ["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06"]
    assert [x["reason"] for x in sk] == ["closed_day"] * 3                                     # Sat, Sun and the Tuesday holiday
    nxt = triggers.preview(daily("next_working_day"), 6, now=now, cal=cal, plant="P")
    assert [x["at_local"][:10] for x in nxt] == ["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06"]
    assert [x["policy_note"] for x in nxt][2:4] == ["moved_next_working_day"] * 2             # Sat/Sun collapse onto Monday; Tue -> Wed
    prev = triggers.preview(daily("previous_working_day"), 6, now=now, cal=cal, plant="P")
    assert [x["at_local"][:10] for x in prev] == ["2026-10-29", "2026-10-30", "2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06"]


def test_previous_working_day_moves_earlier_and_dedupes():
    cal = FakeCal(closed=[])
    now = utc(2026, 10, 28, 12)                                  # Wed
    s = sched("weekly", days_of_week=[5], options={"closed_day": "previous_working_day"})   # Saturday -> Friday
    got = triggers.preview(s, 3, now=now, cal=cal, plant="P")
    assert [e["at_local"][:10] for e in got] == ["2026-10-30", "2026-11-06", "2026-11-13"]
    assert got[0]["policy_note"] == "moved_previous_working_day"
    both = sched("weekly", days_of_week=[4, 5], options={"closed_day": "previous_working_day"})   # Fri + Sat -> one Friday
    assert [e["at_local"][:10] for e in triggers.preview(both, 2, now=now, cal=cal, plant="P")] == ["2026-10-30", "2026-11-06"]


def test_closed_day_with_no_working_day_in_range_is_a_skip():
    cal = FakeCal(closed=[date(2026, 11, 1) + timedelta(days=i) for i in range(0, 60)], weekends=False)
    s = sched(options={"closed_day": "next_working_day"})
    entries, skipped = triggers.preview_full(s, 1, now=utc(2026, 11, 1, 12), cal=cal, plant="P")
    assert skipped and skipped[0]["reason"] == "no_working_day"


def test_real_calendar_view_periods_and_blackouts():
    plant_wh = {str(d): (None if d in (0, 6) else [7, 19]) for d in range(7)}
    cal = {"plant_work_hours": plant_wh,
           "plant_periods": [{"id": "p", "valid_from": "2026-12-24", "valid_to": "2026-12-27",
                              "work_hours": {str(d): None for d in range(7)}}],
           "plant_blackouts": [{"id": "b", "start": "2026-11-10T05:00:00Z", "end": "2026-11-11T05:00:00Z"}]}
    v = calview.PlantCalendarView({"P": cal}, {"P": ZoneInfo(NY)})
    assert v.is_working_day("P", date(2026, 11, 9))
    assert not v.is_working_day("P", date(2026, 11, 8))                     # Sunday
    assert not v.is_working_day("P", date(2026, 12, 24))                    # closed period
    assert not v.is_working_day("P", date(2026, 11, 10))                    # a blackout covers 00:00-24:00 local (>= 7-19)
    assert v.next_working_day("P", date(2026, 11, 9)) == date(2026, 11, 11)
    assert v.previous_working_day("P", date(2026, 11, 11)) == date(2026, 11, 9)
    assert v.is_working_day("Unknown", date(2026, 11, 8))                   # no calendar: fail open
    s = sched(options={"closed_day": "skip"})
    got = triggers.preview(s, 3, now=utc(2026, 11, 6, 12), cal=v, plant="P")
    assert [e["at_local"][:10] for e in got] == ["2026-11-06", "2026-11-09", "2026-11-11"]


# ------------------------------------------------------------------------------------------------ run windows
def test_run_window_skip_and_defer_and_midnight_crossing():
    now = utc(2026, 10, 28, 16)
    inside = sched(time_of_day="09:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "skip"}})
    assert local_list(inside, 1, now) == ["2026-10-29T09:00:00-04:00"]
    out_skip = sched(time_of_day="18:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "skip"}})
    e, sk = triggers.preview_full(out_skip, 2, now=now, plant="P")
    assert e == [] and sk and sk[0]["reason"] == "outside_run_window"
    early = sched(time_of_day="06:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "defer"}})
    got = triggers.preview(early, 2, now=now, plant="P")
    assert [x["at_local"] for x in got] == ["2026-10-29T08:00:00-04:00", "2026-10-30T08:00:00-04:00"]
    assert got[0]["policy_note"] == "deferred_to_window"
    late = sched(time_of_day="18:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "defer"}})
    assert [x["at_local"] for x in triggers.preview(late, 2, now=now, plant="P")] == ["2026-10-29T08:00:00-04:00", "2026-10-30T08:00:00-04:00"]
    cross = {"start": "22:00", "end": "05:00"}
    night = sched(time_of_day="23:30", options={"run_window": {**cross, "action": "skip"}})
    assert local_list(night, 2, now) == ["2026-10-28T23:30:00-04:00", "2026-10-29T23:30:00-04:00"]   # inside the crossing window
    noon = sched(time_of_day="12:00", options={"run_window": {**cross, "action": "defer"}})
    assert local_list(noon, 2, now) == ["2026-10-28T22:00:00-04:00", "2026-10-29T22:00:00-04:00"]    # outside by day: next opening
    morning = sched(time_of_day="03:00", options={"run_window": {**cross, "action": "skip"}})
    assert local_list(morning, 1, now)[0].startswith("2026-10-29T03:00")             # 03:00 is inside the crossing window


def test_hourly_run_window_skips_outside_hours():
    s = sched("hourly", time_of_day="00:00", options={"run_window": {"start": "08:00", "end": "10:00", "action": "skip"}})
    got = triggers.next_fire_times(s, 4, now=utc(2026, 10, 28, 16), plant="P")
    assert [f.strftime("%d %H") for f in got] == ["29 08", "29 09", "30 08", "30 09"]


# ------------------------------------------------------------------------------------------------- monthly modes
def test_monthly_last_day_and_clamp_and_default_skip():
    now = utc(2027, 1, 15, 12)
    default31 = sched("monthly", day_of_month=31, tz="UTC")
    assert [f.strftime("%m-%d") for f in triggers.next_fire_times(default31, 4, now=now)] == ["01-31", "03-31", "05-31", "07-31"]   # short months skip
    clamp = sched("monthly", day_of_month=31, tz="UTC", options={"monthly_clamp": True})
    assert [f.strftime("%m-%d") for f in triggers.next_fire_times(clamp, 4, now=now)] == ["01-31", "02-28", "03-31", "04-30"]
    last = sched("monthly", tz="UTC", options={"monthly": "last_day"})
    assert [f.strftime("%m-%d") for f in triggers.next_fire_times(last, 3, now=now)] == ["01-31", "02-28", "03-31"]


def test_first_and_last_working_day_of_month():
    cal = FakeCal(closed=["2027-02-01"])                           # Monday closed -> first working day is Tue 02-02
    now = utc(2027, 1, 15, 12)
    first = sched("monthly", tz="UTC", options={"monthly": "first_working_day"})
    assert [f.strftime("%m-%d") for f in triggers.next_fire_times(first, 3, now=now, cal=cal, plant="P")] == ["02-02", "03-01", "04-01"]
    last = sched("monthly", tz="UTC", options={"monthly": "last_working_day"})
    got = [f.strftime("%m-%d") for f in triggers.next_fire_times(last, 3, now=now, cal=cal, plant="P")]
    assert got == ["01-29", "02-26", "03-31"]                      # Jan 31 is a Sunday; Feb 28 a Sunday


# ----------------------------------------------------------- property: preview == trigger == fire-time recheck
def _random_row(rng):
    kind = rng.choice(["daily", "weekdays", "weekly", "monthly", "hourly", "cron"])
    tz = rng.choice([NY, LON, SYD, SAO, "UTC"])
    opts = {"dst_gap": rng.choice(["shift", "skip"]), "dst_overlap": rng.choice(["once", "twice"])}
    if kind in triggers.MOVABLE_KINDS:
        opts["closed_day"] = rng.choice(list(triggers.CLOSED_DAY))
    elif kind in ("hourly", "cron"):
        opts["closed_day"] = rng.choice(["run", "skip"])
    if rng.random() < .4:
        opts["run_window"] = {"start": rng.choice(["00:00", "06:00", "22:00"]), "end": rng.choice(["05:00", "12:00", "23:00"]),
                              "action": rng.choice(["skip", "defer"])}
        if opts["run_window"]["start"] == opts["run_window"]["end"]:
            opts.pop("run_window")
    row = {"kind": kind, "timezone": tz, "time_of_day": f"{rng.choice([0, 1, 2, 3, 8, 23]):02d}:{rng.choice([0, 15, 30]):02d}",
           "options": opts}
    if kind == "weekly":
        row["days_of_week"] = rng.sample(range(7), rng.randint(1, 3))
    if kind == "monthly":
        row["day_of_month"] = rng.randint(1, 31)
        if rng.random() < .5:
            row["options"]["monthly"] = rng.choice(list(triggers.MONTHLY_MODES))
            row["options"]["monthly_clamp"] = rng.random() < .5
    if kind == "cron":
        row["cron_expr"] = rng.choice(["*/20 0-4 * * *", "30 1,2 * * mon-fri", "0 */6 * * *"])
    return row


@pytest.mark.parametrize("seed", range(80))
def test_property_preview_equals_simulated_fires_and_recheck(seed):
    rng = random.Random(seed)
    row = triggers.validate_schedule(_random_row(rng))
    closed = [date(2026, 11, 1) + timedelta(days=rng.randrange(0, 150)) for _ in range(rng.randrange(0, 12))]
    cal = FakeCal(closed=closed, weekends=rng.random() < .7)
    now = datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(days=rng.randrange(0, 150), minutes=rng.randrange(0, 1440))
    entries = triggers.next_fire_times(row, 12, now=now, cal=cal, plant="P")
    trig = triggers.build_trigger(row, cal=cal, plant="P")
    sim, prev, cursor = [], None, now
    for _ in range(12):                                          # exactly how APScheduler drives a trigger
        nxt = trig.get_next_fire_time(prev, cursor)
        if nxt is None:
            break
        sim.append(nxt)
        prev, cursor = nxt, nxt + timedelta(microseconds=1)
    assert [e.astimezone(timezone.utc) for e in entries] == [s.astimezone(timezone.utc) for s in sim]
    assert all(a < b for a, b in zip(entries, entries[1:]))                      # strictly increasing, no duplicates
    pol = triggers.policy_of(row)
    for e in entries[:6]:                                         # the fire-time re-check agrees with the preview
        assert triggers.recheck(row, at=e, window_s=300, cal=cal, plant="P") is None, (row, e)
    if pol.closed_day == "skip" and pol.run_window is None:      # an independent check of the rule itself
        assert all(cal.is_working_day("P", e.date()) for e in entries)
    if pol.run_window is not None:
        s, en, _ = pol.run_window
        for e in entries:
            m = e.hour * 60 + e.minute
            assert (s <= m < en) if s < en else (m >= s or m < en), (row, e)


def test_recheck_rejects_when_the_calendar_changed_since_arming():
    s = sched(options={"closed_day": "skip"})
    at = datetime(2026, 11, 2, 8, 0, tzinfo=ZoneInfo(NY))          # Monday 08:00 fires under an open calendar
    assert triggers.recheck(s, at=at, window_s=300, cal=FakeCal(), plant="P") is None
    assert triggers.recheck(s, at=at, window_s=300, cal=FakeCal(closed=["2026-11-02"]), plant="P") == "closed day"
    w = sched(time_of_day="18:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "skip"}})
    assert triggers.recheck(w, at=datetime(2026, 11, 2, 18, 0, tzinfo=ZoneInfo(NY)), window_s=300, plant="P") == "outside run window"


# ---------------------------------------------------------------------------------------------------- catch-up
def _plan(row, baseline, now, **kw):
    return triggers.plan_catch_up(row, baseline=baseline, now=now, plant="P", **kw)


def test_catch_up_within_grace_fires_once_with_the_expected_time():
    s = sched(tz="UTC", time_of_day="08:00")
    p = _plan(s, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 20))           # down across 08:00, back 20 min later
    assert p.fire is not None and p.fire.utc == utc(2026, 10, 28, 8, 0) and p.missed == 0


def test_catch_up_beyond_grace_records_one_missed_count():
    s = sched(tz="UTC", time_of_day="08:00")
    p = _plan(s, utc(2026, 10, 24, 8, 0, 1), utc(2026, 10, 28, 11, 0))           # 08:00 on 25,26,27,28 missed; last 3 h ago
    assert p.fire is None and p.missed == 4 and p.missed_last == utc(2026, 10, 28, 8, 0)


def test_catch_up_runs_the_latest_and_counts_the_older_misses():
    s = sched(tz="UTC", time_of_day="08:00")
    p = _plan(s, utc(2026, 10, 24, 8, 0, 1), utc(2026, 10, 28, 8, 30))
    assert p.fire.utc == utc(2026, 10, 28, 8, 0) and p.missed == 3 and p.missed_last == utc(2026, 10, 27, 8, 0)


def test_catch_up_nothing_missed_disabled_option_and_custom_grace():
    s = sched(tz="UTC", time_of_day="08:00")
    assert _plan(s, utc(2026, 10, 28, 8, 0, 1), utc(2026, 10, 28, 9)) is None
    off = sched(tz="UTC", time_of_day="08:00", options={"catch_up": {"enabled": False}})
    p = _plan(off, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 10))
    assert p.fire is None and p.missed == 1
    short = sched(tz="UTC", time_of_day="08:00", options={"catch_up": {"enabled": True, "grace_s": 300}})
    assert _plan(short, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 10)).fire is None
    assert _plan(short, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 4)).fire is not None


def test_catch_up_ignores_a_fire_still_settling_and_respects_policy_and_validity():
    s = sched(tz="UTC", time_of_day="08:00")
    assert _plan(s, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 0, 1)) is None            # 1 s old: the normal fire has it
    closed = sched(tz="UTC", time_of_day="08:00", options={"closed_day": "skip"})
    assert _plan(closed, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 10), cal=FakeCal(closed=["2026-10-28"])) is None
    expired = sched(tz="UTC", time_of_day="08:00", valid_until="2026-10-27T23:00")
    assert _plan(expired, utc(2026, 10, 27, 8, 0, 1), utc(2026, 10, 28, 8, 10)) is None
    assert _plan(sched("once", tz="UTC", run_at="2026-10-28T08:00"), utc(2026, 10, 27), utc(2026, 10, 28, 8, 10)) is None


def test_catch_up_hourly_cap_is_a_lower_bound():
    s = sched("hourly", tz="UTC", time_of_day="00:00")
    p = _plan(s, utc(2026, 10, 1), utc(2026, 10, 28, 8, 30), cap=50)
    assert p.fire is None and p.capped and p.missed == 50


# --------------------------------------------------------------------------------------------- options validation
@pytest.mark.parametrize("opts", [
    {"dst_gap": "maybe"}, {"dst_overlap": "thrice"}, {"closed_day": "tomorrow"}, {"bogus": 1},
    {"run_window": {"start": "08:00", "end": "08:00"}}, {"run_window": {"start": "8", "end": "09:00"}},
    {"run_window": {"start": "08:00", "end": "09:00", "action": "wait"}}, {"catch_up": {"grace_s": 5}},
    {"catch_up": {"enabled": True, "grace_s": 100000}}, {"monthly": "last_day"}, {"monthly_clamp": True},
])
def test_bad_options_rejected(opts):
    with pytest.raises(triggers.ScheduleError):
        triggers.validate_schedule({"kind": "daily", "timezone": "UTC", "time_of_day": "08:00", "options": opts})


def test_movable_closed_day_needs_a_once_a_day_kind_and_monthly_options_need_monthly():
    for kind, extra in (("hourly", {}), ("cron", {"cron_expr": "0 * * * *"})):
        with pytest.raises(triggers.ScheduleError):
            triggers.validate_schedule({"kind": kind, "timezone": "UTC", "time_of_day": "00:00", **extra,
                                        "options": {"closed_day": "next_working_day"}})
    ok = triggers.validate_schedule({"kind": "hourly", "timezone": "UTC", "time_of_day": "00:00", "options": {"closed_day": "skip"}})
    assert ok["options"]["closed_day"] == "skip"
    with pytest.raises(triggers.ScheduleError):
        triggers.validate_schedule({"kind": "monthly", "timezone": "UTC", "time_of_day": "08:00"})          # needs a day
    assert triggers.validate_schedule({"kind": "monthly", "timezone": "UTC", "time_of_day": "08:00",
                                       "options": {"monthly": "last_day"}})["day_of_month"] is None


def test_options_normalise_to_a_full_dict_and_none_when_empty():
    assert triggers.validate_schedule({"kind": "daily", "timezone": "UTC", "time_of_day": "08:00", "options": {}})["options"] is None
    o = triggers.validate_schedule({"kind": "daily", "timezone": "UTC", "time_of_day": "08:00",
                                    "options": {"closed_day": "skip", "run_window": {"start": "6:00", "end": "18:00"}}})["options"]
    assert o == {"dst_gap": "shift", "dst_overlap": "once", "closed_day": "skip",
                 "run_window": {"start": "06:00", "end": "18:00", "action": "skip"}, "monthly": "day_of_month",
                 "monthly_clamp": False, "catch_up": {"enabled": True, "grace_s": 3600}}
    assert triggers.options_need_plant_time(o) and not triggers.options_need_plant_time({"closed_day": "run"})


# ------------------------------------------------------------------------------------- W3b fix wave (pure)
def test_deferred_fire_never_lands_on_a_closed_day():
    # 2027-04-02 is a Friday; a 20:00 fire is outside 08:00-17:00 and opens next at Saturday 08:00 (closed).
    win = {"start": "08:00", "end": "17:00", "action": "defer"}
    now = utc(2027, 4, 2, 12)
    mv = sched(tz="UTC", time_of_day="20:00", options={"closed_day": "next_working_day", "run_window": win})
    assert local_list(mv, 1, now, FakeCal()) == ["2027-04-05T08:00:00+00:00"], "walks to Monday's opening"
    sk = sched(tz="UTC", time_of_day="20:00", options={"closed_day": "skip", "run_window": win})
    entries, skipped = triggers.preview_full(sk, 2, now=now, cal=FakeCal(), plant="P")
    assert all(e["at_local"][:10] not in ("2027-04-03", "2027-04-04") for e in entries)
    assert any(s["reason"] == "closed_day" and s["at_local"].startswith("2027-04-02") for s in skipped)


def test_validity_is_tested_on_the_final_moved_instant():
    # Saturday 08:00 is inside valid_until (Sat 23:00) but the closed-day move carries it to Monday, outside it.
    s = sched(tz="UTC", time_of_day="08:00", valid_until="2027-04-03T23:00:00", options={"closed_day": "next_working_day"})
    entries, skipped = triggers.preview_full(s, 5, now=utc(2027, 4, 2, 12), cal=FakeCal(), plant="P")
    assert all(e["at_local"][:10] <= "2027-04-03" for e in entries), "nothing moved past valid_until"
    assert any(x["reason"] == "outside_validity" for x in skipped)
    assert triggers.recheck(s, at=utc(2027, 4, 5, 8), window_s=120, cal=FakeCal(), plant="P") is not None


def test_recheck_scan_does_not_reject_a_valid_fire_of_a_busy_schedule():
    s = sched(kind="cron", tz="UTC", cron_expr="* * * * *")
    assert triggers.recheck(s, at=utc(2027, 4, 2, 12, 0, 1), window_s=86400, cal=None, plant="P") is None
    far = utc(2027, 4, 2, 12, 0, 0)
    assert triggers.recheck(sched(kind="cron", tz="UTC", cron_expr="0 12 * * *", options={"run_window": {"start": "11:00", "end": "13:00", "action": "skip"}}),
                            at=far, window_s=120, plant="P") is None


def test_fire_at_names_the_second_pass_of_a_repeated_hour():
    s = sched(tz="America/Chicago", time_of_day="01:30", options={"dst_overlap": "twice"})
    first = triggers.fire_at(s, at=utc(2026, 11, 1, 6, 30), window_s=60, plant="P")
    second = triggers.fire_at(s, at=utc(2026, 11, 1, 7, 30), window_s=60, plant="P")
    assert first is not None and first.note is None and second is not None and second.note == "dst_overlap_second"


def test_blocked_now_tests_the_current_instant():
    w = sched(tz="UTC", time_of_day="08:00", options={"run_window": {"start": "08:00", "end": "17:00", "action": "skip"}})
    assert triggers.blocked_now(w, now=utc(2027, 4, 2, 20), plant="P") == "outside run window"
    assert triggers.blocked_now(w, now=utc(2027, 4, 2, 10), plant="P") is None
    c = sched(tz="UTC", time_of_day="08:00", options={"closed_day": "skip"})
    assert triggers.blocked_now(c, now=utc(2027, 4, 3, 10), cal=FakeCal(), plant="P") == "closed day"
    assert triggers.blocked_now(c, now=utc(2027, 4, 2, 10), cal=FakeCal(), plant="P") is None
