"""Ack ownership, future-only `until`, primary-key unack and profile no-op / stale semantics (no DB: scripted fake pool)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.alert_profiles import data as ap


class _Cur:
    """Scripted cursor: `script` maps a SQL fragment to a (fetchone, fetchall) result; first matching fragment wins."""

    def __init__(self, log, script):
        self.log, self.script = log, script
        self.rowcount = script.get("rowcount", 1)
        self._res = (None, [])

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        sql = " ".join(sql.split())
        self.log.append((sql, params))
        self._res = (None, [])
        for frag, res in self.script.items():
            if frag != "rowcount" and frag in sql:
                self._res = res
                break

    def fetchone(self):
        return self._res[0]

    def fetchall(self):
        return self._res[1]


class _Conn:
    def __init__(self, pool):
        self.pool = pool

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *a):
        self.pool.state["rolled_back" if exc_type else "clean_exit"] = True
        return False

    def cursor(self):
        return _Cur(self.pool.log, self.pool.script)

    def commit(self):
        self.pool.state["committed"] = True


class _Pool:
    def __init__(self, script):
        self.log, self.state, self.script = [], {}, script

    def connection(self):
        return _Conn(self)


_ACK_ROW = ("P1", "a1", "owner@x.com", "r", None, datetime(2026, 10, 20))
_PROFILE_ROW = ("abc", "P1", "N", "", [], "impact", "o", "o", datetime(2026, 10, 20), datetime(2026, 10, 20),
                None, True, False)


def _fake(monkeypatch, script):
    pool = _Pool({"FROM plants": (("UTC",), []), **script})
    monkeypatch.setattr(ap, "_pool", pool)
    audited = []
    monkeypatch.setattr(ap, "_audit", lambda *a, **k: audited.append(a))
    pool.audited = audited
    return pool


def _inserts(pool):
    return [(sql, p) for sql, p in pool.log if sql.startswith("INSERT")]


def test_single_ack_over_someone_elses_raises_and_writes_nothing(monkeypatch):
    pool = _fake(monkeypatch, {"INSERT INTO alert_ack": (None, [])})   # the guarded DO UPDATE returned no row
    with pytest.raises(ap.AckNotOwner):
        ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", actor="other@x.com")
    assert not pool.audited and "committed" not in pool.state
    sql = _inserts(pool)[0][0]
    assert "WHERE (lower(alert_ack.acknowledged_by) = lower(EXCLUDED.acknowledged_by) OR %s::boolean)" in sql


def test_single_ack_passes_actor_and_admin_flag_to_the_guard(monkeypatch):
    pool = _fake(monkeypatch, {"INSERT INTO alert_ack": (_ACK_ROW, [])})
    assert ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", actor="u@x.com", is_admin=True)["alert_id"] == "a1"
    params = _inserts(pool)[0][1]
    assert params[2] == "u@x.com" and params[-1] is True and pool.state.get("committed")
    pool = _fake(monkeypatch, {"INSERT INTO alert_ack": (_ACK_ROW, [])})
    ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", actor="u@x.com")
    assert _inserts(pool)[0][1][-1] is False


def test_bulk_ack_conflict_is_checked_before_any_insert(monkeypatch):
    pool = _fake(monkeypatch, {"FOR UPDATE": (None, [("a2",)])})
    with pytest.raises(ap.AckNotOwner):
        ap.upsert_alert_acks(plant="P1", alert_ids=["a2", "a1"], reason="r", actor="other@x.com")
    assert not _inserts(pool) and "committed" not in pool.state and not pool.audited
    check = next((sql, p) for sql, p in pool.log if "FOR UPDATE" in sql)
    assert "lower(acknowledged_by) <> lower(%s)" in check[0]
    assert check[1] == ("P1", ["a1", "a2"], "other@x.com")   # ids sorted and de-duplicated


def test_bulk_ack_admin_skips_the_check_and_a_rowcount_mismatch_aborts(monkeypatch):
    pool = _fake(monkeypatch, {"rowcount": 2, "SELECT plant": (None, [_ACK_ROW])})
    ap.upsert_alert_acks(plant="P1", alert_ids=["a1", "a2"], reason="r", actor="admin@x.com", is_admin=True)
    assert not any("FOR UPDATE" in sql for sql, _ in pool.log) and pool.state.get("committed")
    # a rival ack slipped in after the check: the guarded upsert wrote 1 of 2, so the batch is abandoned
    pool = _fake(monkeypatch, {"rowcount": 1})
    with pytest.raises(ap.AckNotOwner):
        ap.upsert_alert_acks(plant="P1", alert_ids=["a1", "a2"], reason="r", actor="u@x.com")
    assert "committed" not in pool.state and pool.state.get("rolled_back")


def test_until_must_be_in_the_future_single_and_bulk(monkeypatch):
    pool = _fake(monkeypatch, {})
    past = (_utcnow() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
    with pytest.raises(ValueError, match="until must be in the future"):
        ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until=past, actor="u")
    with pytest.raises(ValueError, match="until must be in the future"):
        ap.upsert_alert_acks(plant="P1", alert_ids=["a1"], reason="r", until=past, actor="u")
    assert not any(sql.startswith(("INSERT", "DELETE")) for sql, _ in pool.log)
    future = (_utcnow() + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S")
    pool = _fake(monkeypatch, {"INSERT INTO alert_ack": (_ACK_ROW, [])})
    ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until=future, actor="u")
    assert pool.state.get("committed")


def test_delete_ack_is_one_primary_key_statement(monkeypatch):
    pool = _fake(monkeypatch, {"RETURNING alert_id": (("a1",), [])})
    assert ap.delete_alert_ack("P1", "a1", actor="Owner@x.com") is True
    deletes = [(sql, p) for sql, p in pool.log if sql.startswith("DELETE")]
    assert len(deletes) == 1 and "plant = %s AND alert_id = %s" in deletes[0][0]
    assert deletes[0][1][0:2] == ("P1", "a1") and deletes[0][1][3:] == ("Owner@x.com", False)
    assert not any("ORDER BY" in sql for sql, _ in pool.log)   # never lists every ack
    assert pool.audited and pool.state.get("committed")


def test_delete_ack_missing_forbidden_and_admin(monkeypatch):
    pool = _fake(monkeypatch, {})   # nothing deleted and nothing active: deleted False
    assert ap.delete_alert_ack("P1", "a1", actor="u") is False
    assert not pool.audited
    _fake(monkeypatch, {"SELECT 1 FROM alert_ack": ((1,), [])})   # an active row exists but is not the actor's
    with pytest.raises(ap.AckNotOwner):
        ap.delete_alert_ack("P1", "a1", actor="u")
    pool = _fake(monkeypatch, {"RETURNING alert_id": (("a1",), [])})
    assert ap.delete_alert_ack("P1", "a1", actor="admin", is_admin=True) is True
    assert next(p for sql, p in pool.log if sql.startswith("DELETE"))[-1] is True


def test_update_with_nothing_supplied_does_not_write(monkeypatch):
    pool = _fake(monkeypatch, {"FOR UPDATE": (_PROFILE_ROW, [])})
    out = ap.update_alert_profile("abc", actor="u", expected_updated_at="2026-10-20T00:00:00")
    assert out["id"] == "abc"
    assert not any(sql.startswith("UPDATE") for sql, _ in pool.log)
    assert "committed" not in pool.state and not pool.audited


def test_stale_profile_is_a_valueerror_raised_on_a_mismatch(monkeypatch):
    _fake(monkeypatch, {"FOR UPDATE": (_PROFILE_ROW, [])})
    assert issubclass(ap.StaleProfile, ValueError) and not issubclass(ap.AckNotOwner, ValueError)
    with pytest.raises(ap.StaleProfile):
        ap.update_alert_profile("abc", actor="u", name="X", expected_updated_at="1999-01-01T00:00:00")


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)
