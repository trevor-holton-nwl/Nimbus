"""DateWindow resolver (pure, no database): calendar-day arithmetic in the plant timezone across DST transitions,
month-end clamping, Monday week start, the last_success watermark and config errors."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.jobs import windows as w

CHI = "America/Chicago"


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def roll(anchor, f, t, unit="day"):
    return {"mode": "rolling", "rolling": {"anchor": anchor, "from_offset": f, "to_offset": t, "unit": unit}}


def _span_h(s, e):
    """Real elapsed hours (same-zone aware datetimes subtract by wall clock, so go through UTC)."""
    return (e.astimezone(timezone.utc) - s.astimezone(timezone.utc)).total_seconds() / 3600


def local(tz, *a):
    return datetime(*a, tzinfo=ZoneInfo(tz))


# ------------------------------------------------------------------------------------------ DST, by calendar day
@pytest.mark.parametrize("tz,now,days,start_local", [
    # America/Chicago spring forward 2026-03-08 02:00, fall back 2026-11-01 02:00
    (CHI, utc(2026, 3, 10, 15), 3, (2026, 3, 7, 0, 0)),          # crosses the gap: 3 calendar days = 47 h
    (CHI, utc(2026, 11, 3, 15), 3, (2026, 10, 31, 0, 0)),        # crosses the repeat hour: 3 days = 49 h
    ("Europe/London", utc(2026, 3, 30, 12), 2, (2026, 3, 28, 0, 0)),
    ("Europe/London", utc(2026, 10, 27, 12), 3, (2026, 10, 24, 0, 0)),
    ("Australia/Sydney", utc(2026, 4, 7, 12), 3, (2026, 4, 4, 0, 0)),     # southern fall-back 2026-04-05
    ("Australia/Sydney", utc(2026, 10, 6, 12), 3, (2026, 10, 3, 0, 0)),   # spring forward 2026-10-04
    ("America/Sao_Paulo", utc(2026, 10, 28, 12), 30, (2026, 9, 28, 0, 0)),  # no DST: plain
])
def test_last_days_is_calendar_midnight_not_24h_multiples(tz, now, days, start_local):
    s, e, _ = w.resolve_window(w.last_days(days), tz, now)
    assert s == local(tz, *start_local)
    assert s.hour == 0 and s.minute == 0
    nl = now.astimezone(ZoneInfo(tz)).date() + timedelta(days=1)
    assert e == local(tz, nl.year, nl.month, nl.day)


def test_spring_forward_span_is_not_a_multiple_of_24h():
    s, e, _ = w.resolve_window(roll("start_of_day", -3, 0), CHI, utc(2026, 3, 10, 15))
    assert _span_h(s, e) == 71                            # 3 calendar days, one of them 23 h long


def test_fall_back_span_is_73h():
    s, e, _ = w.resolve_window(roll("start_of_day", -3, 0), CHI, utc(2026, 11, 3, 15))
    assert _span_h(s, e) == 73


def test_label_is_inclusive_dates_in_plant_time():
    _, _, label = w.resolve_window(w.last_days(30), "America/Sao_Paulo", utc(2026, 10, 28, 12))
    assert label == "2026-09-28 to 2026-10-28"


def test_plant_date_differs_from_utc_date():
    # 03:00 UTC on Oct 29 is still Oct 28 evening in Chicago
    s, e, label = w.resolve_window(w.next_days(1), CHI, utc(2026, 10, 29, 3))
    assert s == local(CHI, 2026, 10, 28) and label == "2026-10-28 to 2026-10-28"


def test_older_than_is_open_start():
    s, e, label = w.resolve_window(w.older_than_days(30), CHI, utc(2026, 10, 28, 15))
    assert e == local(CHI, 2026, 9, 28) and label == "before 2026-09-28"
    assert s.year < 2017


def test_wall_time_in_gap_resolves_to_real_instant():
    # now 02:30 local does not exist on 2026-03-08 in Chicago; a +1 day shift from the day before lands in the gap
    s, e, _ = w.resolve_window(roll("now", -1, 0), CHI, utc(2026, 3, 9, 7, 30))
    assert s.utcoffset() is not None and s.astimezone(timezone.utc) < e.astimezone(timezone.utc)


# --------------------------------------------------------------------------------------------- months and weeks
@pytest.mark.parametrize("now,off,expect", [
    (utc(2026, 1, 31, 18), 1, date(2026, 2, 28)),
    (utc(2028, 1, 31, 18), 1, date(2028, 2, 29)),           # leap year
    (utc(2026, 3, 31, 18), -1, date(2026, 2, 28)),
    (utc(2026, 5, 31, 18), -3, date(2026, 2, 28)),
    (utc(2026, 12, 15, 18), 2, date(2027, 2, 15)),
])
def test_month_offsets_clamp_to_month_end(now, off, expect):
    s, e, _ = w.resolve_window(roll("start_of_day", min(0, off) - 1, off, "month"), CHI, now)
    assert e.date() == expect


def test_week_starts_monday():
    # 2026-10-28 is a Wednesday
    s, e, label = w.resolve_window(w.this_week(), CHI, utc(2026, 10, 28, 15))
    assert s.date() == date(2026, 10, 26) and s.weekday() == 0
    assert e.date() == date(2026, 11, 2)
    assert label == "2026-10-26 to 2026-11-01"


def test_this_month_and_start_of_month():
    s, e, label = w.resolve_window(w.this_month(), CHI, utc(2026, 10, 28, 15))
    assert (s.date(), e.date()) == (date(2026, 10, 1), date(2026, 11, 1))
    assert label == "2026-10-01 to 2026-10-31"


def test_sunday_belongs_to_the_week_that_started_the_monday_before():
    s, _, _ = w.resolve_window(w.this_week(), CHI, utc(2026, 11, 1, 20))     # Sunday
    assert s.date() == date(2026, 10, 26)


# -------------------------------------------------------------------------------------------------- fixed
def test_fixed_window_is_whole_days_inclusive():
    win = {"mode": "fixed", "fixed": {"from": "2026-10-01", "to": "2026-10-31"}}
    s, e, label = w.resolve_window(win, CHI, utc(2026, 10, 28, 15))
    assert (s, e) == (local(CHI, 2026, 10, 1), local(CHI, 2026, 11, 1))
    assert label == "2026-10-01 to 2026-10-31"


def test_fixed_requires_range_and_order():
    with pytest.raises(ValueError):
        w.DateWindow.model_validate({"mode": "fixed"})
    with pytest.raises(ValueError):
        w.DateWindow.model_validate({"mode": "fixed", "fixed": {"from": "2026-10-31", "to": "2026-10-01"}})


def test_fixed_dumps_with_from_alias():
    win = w.DateWindow.model_validate({"mode": "fixed", "fixed": {"from": "2026-10-01", "to": "2026-10-02"}})
    assert win.model_dump(mode="json")["fixed"] == {"from": "2026-10-01", "to": "2026-10-02"}


# ---------------------------------------------------------------------------------------------- last_success
def test_last_success_runs_from_watermark_to_now():
    now = utc(2026, 10, 28, 15)
    last = utc(2026, 10, 27, 13)
    s, e, _ = w.resolve_window(w.since_last_success(), CHI, now, last)
    assert s.astimezone(timezone.utc) == last and e.astimezone(timezone.utc) == now - timedelta(seconds=w.LAST_SUCCESS_MARGIN_S)


def test_last_success_without_prior_run_uses_lookback_calendar_days():
    now = utc(2026, 11, 3, 15)
    s, _, _ = w.resolve_window(w.since_last_success(), CHI, now, None, first_run_lookback_days=3)
    assert s == now.astimezone(ZoneInfo(CHI)).replace(day=31, month=10)      # same wall time, 3 calendar days back
    s1, _, _ = w.resolve_window(w.since_last_success(), CHI, now, None)       # default lookback is 1 day
    assert s1.day == 2


# ------------------------------------------------------------------------------------------------ config errors
@pytest.mark.parametrize("tz", [None, "", "  ", "Mars/Base"])
def test_missing_or_unknown_timezone_is_a_config_error(tz):
    with pytest.raises(w.WindowConfigError) as ei:
        w.resolve_window(w.last_days(7), tz, utc(2026, 10, 28))
    assert ei.value.kind == "config"


def test_end_before_start_is_rejected():
    with pytest.raises(w.WindowConfigError):
        w.resolve_window(roll("start_of_day", 2, -1), CHI, utc(2026, 10, 28, 15))


def test_naive_now_rejected():
    with pytest.raises(ValueError):
        w.resolve_window(w.last_days(1), CHI, datetime(2026, 10, 28))


def test_presets_validate():
    for p in (w.older_than_days(30), w.last_days(7), w.next_days(14), w.since_last_success(), w.this_week(),
              w.this_month()):
        w.DateWindow.model_validate(p)


# ------------------------------------------------------------------ W2 fix wave: gap days, labels, bounds, skew
def _is_first_valid_instant_of_day(dt, zone):
    from backend.jobs.windows import _local
    return dt == _local(ZoneInfo(zone), dt.date())


@pytest.mark.parametrize("tz,now", [("America/Sao_Paulo", utc(2018, 11, 6, 15)), ("America/Havana", utc(2026, 3, 10, 15)),
                                    ("America/Santiago", utc(2026, 9, 10, 15))])
def test_last_days_30_is_midnight_to_midnight_even_across_a_day_without_midnight(tz, now):
    s, e, _ = w.resolve_window(w.last_days(30), tz, now)
    assert _is_first_valid_instant_of_day(s, tz) and _is_first_valid_instant_of_day(e, tz)
    assert e.hour == 0 and e.minute == 0


def test_gap_day_anchor_does_not_poison_shifted_bounds():
    # Sao Paulo 2018-11-04 has no local midnight (starts 01:00). Anchored ON that day, the bound 3 days back is 00:00.
    now = utc(2018, 11, 4, 15)
    s, e, label = w.resolve_window(w.last_days(3), "America/Sao_Paulo", now)
    assert (s.date().isoformat(), s.hour) == ("2018-11-01", 0)
    assert (e.date().isoformat(), e.hour) == ("2018-11-05", 0)
    assert label == "2018-11-01 to 2018-11-04"
    s0, _, _ = w.resolve_window(roll("start_of_day", 0, 1), "America/Sao_Paulo", now)
    assert (s0.date().isoformat(), s0.hour) == ("2018-11-04", 1)


def test_fixed_label_uses_requested_dates_in_a_gap_zone():
    win = {"mode": "fixed", "fixed": {"from": "2018-11-01", "to": "2018-11-03"}}
    assert w.resolve_window(win, "America/Sao_Paulo", utc(2018, 11, 10))[2] == "2018-11-01 to 2018-11-03"
    win = {"mode": "fixed", "fixed": {"from": "2018-11-01", "to": "2018-11-04"}}
    assert w.resolve_window(win, "America/Sao_Paulo", utc(2018, 11, 10))[2] == "2018-11-01 to 2018-11-04"


def test_fixed_range_bounds_and_overflow_are_config_errors():
    with pytest.raises(ValueError):
        w.DateWindow.model_validate({"mode": "fixed", "fixed": {"from": "2026-01-01", "to": "9999-12-31"}})
    with pytest.raises(ValueError):
        w.DateWindow.model_validate({"mode": "fixed", "fixed": {"from": "1900-01-01", "to": "2026-01-01"}})
    with pytest.raises(w.WindowConfigError):
        w.resolve_window(roll("now", 0, 3660, "month"), CHI, utc(9999, 6, 1))


def test_last_success_in_the_future_falls_back_to_the_lookback():
    now = utc(2026, 11, 3, 15)
    s, _, _ = w.resolve_window(w.since_last_success(), CHI, now, utc(2026, 11, 9), first_run_lookback_days=2)
    assert s.date().isoformat() == "2026-11-01"


def test_last_success_end_leaves_a_safety_margin():
    now = utc(2026, 10, 28, 15)
    _, e, _ = w.resolve_window(w.since_last_success(), CHI, now, utc(2026, 10, 27, 13))
    assert (now - e.astimezone(timezone.utc)).total_seconds() == w.LAST_SUCCESS_MARGIN_S


def test_zero_width_window_is_rejected_for_non_watermark_anchors():
    with pytest.raises(w.WindowConfigError):
        w.resolve_window(roll("start_of_day", 0, 0), CHI, utc(2026, 10, 28, 15))
    with pytest.raises(w.WindowConfigError):
        w.resolve_window(roll("now", 0, 0), CHI, utc(2026, 10, 28, 15))
