"""Ack expiry is judged in the plant's local time (no DB: a recording fake pool)."""
from datetime import datetime

from backend.alert_profiles import data as ap


class _FakeCur:
    def __init__(self, log):
        self.log = log
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.log.append((" ".join(sql.split()), params))

    def fetchall(self):
        return []

    def fetchone(self):
        return ("P1", "a1", "u", "r", None, datetime(2026, 10, 20))


class _FakeConn:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _FakeCur(self.log)

    def commit(self):
        pass


class _FakePool:
    def __init__(self, log):
        self.log = log

    def connection(self):
        return _FakeConn(self.log)


def test_ack_expiry_is_judged_in_plant_local_time(monkeypatch):
    """`until` is a naive plant-local wall clock: list + purge compare it with the plant's local now,
    never a bare NOW() (the DB session zone, UTC on Azure)."""
    log = []
    monkeypatch.setattr(ap, "_pool", _FakePool(log))
    monkeypatch.setattr(ap, "_audit", lambda *a, **k: None)
    ap.list_alert_acks("P1")
    ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until="2026-10-27T23:59:59", actor="u")
    listing, purge = log[0], log[1]
    for sql, params in (listing, purge):
        assert "until > NOW()" not in sql and "until <= NOW()" not in sql
        assert "NOW() AT TIME ZONE COALESCE(" in sql
        assert "FROM plants WHERE plant = %s" in sql
        assert params == ("P1", "P1")
