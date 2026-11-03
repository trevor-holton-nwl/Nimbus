"""Ack expiry is judged in the plant's local time (no DB: a recording fake pool)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.alert_profiles import data as ap


class _FakeCur:
    def __init__(self, log, tz):
        self.log = log
        self.tz = tz
        self.rowcount = 1
        self._last = ""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._last = " ".join(sql.split())
        self.log.append((self._last, params))

    def fetchall(self):
        return []

    def fetchone(self):
        if "FROM plants" in self._last:
            return (self.tz,)
        return ("P1", "a1", "u", "r", None, datetime(2026, 10, 20))


class _FakeConn:
    def __init__(self, log, tz):
        self.log, self.tz = log, tz

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _FakeCur(self.log, self.tz)

    def commit(self):
        pass


class _FakePool:
    def __init__(self, log, tz=None):
        self.log, self.tz = log, tz

    def connection(self):
        return _FakeConn(self.log, self.tz)


def _setup(monkeypatch, tz=None):
    log = []
    monkeypatch.setattr(ap, "_pool", _FakePool(log, tz))
    monkeypatch.setattr(ap, "_audit", lambda *a, **k: None)
    return log


def _future():
    return (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT23:59:59")


def test_ack_expiry_is_judged_in_plant_local_time(monkeypatch):
    """`until` is a naive plant-local wall clock: list + purge compare it with the plant's local now (a bound
    parameter computed from plants.timezone), never a bare NOW() (the DB session zone, UTC on Azure)."""
    log = _setup(monkeypatch, "America/New_York")
    ap.list_alert_acks("P1")
    ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until=_future(), actor="u")
    # Each call: the zone lookup first, then the statements that compare against the bound plant-local now.
    assert log[0] == ("SELECT MIN(timezone) FROM plants WHERE plant = %s", ("P1",))
    listing = log[1]
    assert log[2][0].startswith("SELECT MIN(timezone)")
    purge = log[3]
    for sql, params in (listing, purge):
        assert "NOW()" not in sql and "AT TIME ZONE" not in sql
        assert "until > %s" in sql or "until <= %s" in sql
        assert params[0] == "P1" and isinstance(params[1], datetime) and params[1].tzinfo is None
    # The bound "now" is the plant's wall clock, not UTC: New York is 4-5 hours behind UTC.
    behind = _utcnow() - listing[1][1]
    assert timedelta(hours=3, minutes=59) < behind < timedelta(hours=5, minutes=1)


@pytest.mark.parametrize("tz", ["Not/AZone", "garbage zone", "../../etc/passwd", "", None])
def test_unknown_or_blank_zone_falls_back_to_utc(monkeypatch, tz):
    """An invalid plants.timezone must not 500 every ack read and write for the plant: it behaves as UTC."""
    log = _setup(monkeypatch, tz)
    assert ap.list_alert_acks("P1") == []
    ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until=_future(), actor="u")
    now = log[1][1][1]
    assert abs(_utcnow() - now) < timedelta(seconds=5)


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)
