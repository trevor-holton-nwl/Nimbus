"""Alert profiles + acknowledgements data layer (validation is pure; round trips need pg)."""
import uuid
from datetime import datetime, timedelta

import pytest

from backend.alert_profiles import data as ap


def _rule(**kw):
    base = {"types": None, "dayFrom": None, "dayTo": None, "minSev": None, "minLateHours": None}
    base.update(kw)
    return base


def test_valid_rules_round_trip_normalised():
    out = ap.validate_rules([_rule(types=["late", "overlap"], dayFrom=-2, dayTo=5, minSev="warn", minLateHours=1.5)])
    assert out == [{"types": ["late", "overlap"], "dayFrom": -2, "dayTo": 5, "minSev": "warn", "minLateHours": 1.5}]


def test_missing_keys_default_to_null():
    assert ap.validate_rules([{}]) == [_rule()]


@pytest.mark.parametrize("rules,msg", [
    ([], "at least one"),
    (None, "list"),
    ([_rule()] * 21, "at most"),
    ([_rule(types=["bogus"])], "Unknown alert type"),
    ([_rule(types=[])], "types"),
    ([_rule(dayFrom="x")], "dayFrom"),
    ([_rule(dayFrom=1.5)], "dayFrom"),
    ([_rule(dayFrom=True)], "dayFrom"),
    ([_rule(dayTo=366)], "dayTo"),
    ([_rule(dayFrom=-366)], "dayFrom"),
    ([_rule(dayFrom=3, dayTo=2)], "dayFrom"),
    ([_rule(minSev="info")], "minSev"),
    ([_rule(minLateHours=-1)], "minLateHours"),
    ([_rule(minLateHours="3")], "minLateHours"),
    (["notadict"], "object"),
])
def test_invalid_rules_rejected(rules, msg):
    with pytest.raises(ValueError, match=msg):
        ap.validate_rules(rules)


def test_twenty_rules_allowed():
    assert len(ap.validate_rules([_rule()] * 20)) == 20


def test_rankings():
    for r in ("impact", "time", "severity", "orders"):
        assert ap.validate_ranking(r) == r
    with pytest.raises(ValueError):
        ap.validate_ranking("random")


def test_alert_types_exclude_never_firing():
    assert "late" in ap.ALERT_TYPES
    assert "queued_now_fits" in ap.ALERT_TYPES
    assert "needs_planning" in ap.ALERT_TYPES
    assert "near-capacity" not in ap.ALERT_TYPES
    assert "line_no_calendar" not in ap.ALERT_TYPES


@pytest.mark.pg
def test_profile_round_trip_and_audit():
    plant = "AP_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        p = ap.create_alert_profile(plant=plant, name="Morning", rules=[_rule(types=["late"])],
                                    ranking="time", description="d", actor="a@x.com")
        assert p["plant"] == plant and p["ranking"] == "time"
        assert [x["id"] for x in ap.list_alert_profiles(plant)] == [p["id"]]
        assert ap.get_alert_profile(p["id"])["name"] == "Morning"
        with pytest.raises(ap.DuplicateName):
            ap.create_alert_profile(plant=plant, name="Morning", rules=[_rule()], ranking="impact",
                                    description="", actor="a@x.com")
        u = ap.update_alert_profile(p["id"], name="Evening", actor="a@x.com", expected_updated_at=p["updated_at"])
        assert u["name"] == "Evening"
        with pytest.raises(ValueError, match="stale"):
            ap.update_alert_profile(p["id"], name="X", actor="a@x.com", expected_updated_at=p["updated_at"])
        assert ap.delete_alert_profile(p["id"], actor="a@x.com")["id"] == p["id"]
        assert ap.delete_alert_profile(p["id"], actor="a@x.com") is None
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT action FROM admin_audit WHERE table_name='alert_profile' AND details->>'plant'=%s", (plant,))
            assert len(cur.fetchall()) >= 3
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_profile WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))


@pytest.mark.pg
def test_ack_upsert_list_expire_delete():
    plant = "AK_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        future = datetime.now() + timedelta(days=1)
        ap.upsert_alert_ack(plant=plant, alert_id="a1", reason="r", until=None, actor="a@x.com")
        ap.upsert_alert_ack(plant=plant, alert_id="a2", reason="r", until=future, actor="a@x.com")
        ap.upsert_alert_ack(plant=plant, alert_id="a3", reason="r", until=datetime.now() - timedelta(days=1), actor="a@x.com")
        assert sorted(a["alert_id"] for a in ap.list_alert_acks(plant)) == ["a1", "a2"]
        ap.upsert_alert_ack(plant=plant, alert_id="a1", reason="again", until=None, actor="a@x.com")
        assert [a["reason"] for a in ap.list_alert_acks(plant) if a["alert_id"] == "a1"] == ["again"]
        assert ap.delete_alert_ack(plant, "a1", actor="a@x.com") is True
        assert ap.delete_alert_ack(plant, "a1", actor="a@x.com") is False
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM alert_ack WHERE plant=%s AND alert_id='a3'", (plant,))
            assert cur.fetchone()[0] == 0  # expired row purged by a later upsert
            cur.execute("SELECT count(*) FROM admin_audit WHERE table_name='alert_ack' AND details->>'plant'=%s", (plant,))
            assert cur.fetchone()[0] >= 4
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_ack WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))


@pytest.mark.pg
def test_ack_bulk_upsert_round_trip():
    plant = "AB_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        out = ap.upsert_alert_acks(plant=plant, alert_ids=["a3", "a1", "a2", "a1"], reason="first", until=None, actor="a@x.com")
        assert sorted(a["alert_id"] for a in out) == ["a1", "a2", "a3"]
        out2 = ap.upsert_alert_acks(plant=plant, alert_ids=["a1", "a2"], reason="second",
                                    until="2099-01-01T23:59:59", actor="b@x.com")
        assert sorted(a["alert_id"] for a in out2) == ["a1", "a2"] and all(a["reason"] == "second" for a in out2)
        listed = {a["alert_id"]: a["reason"] for a in ap.list_alert_acks(plant)}
        assert listed == {"a1": "second", "a2": "second", "a3": "first"}
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT details FROM admin_audit WHERE table_name='alert_ack' AND details->>'plant'=%s"
                        " AND (details->>'count')::int = 3", (plant,))
            rows = cur.fetchall()
            assert len(rows) == 1
            assert rows[0][0]["alert_ids"] == ["a1", "a2", "a3"]   # de-duplicated and sorted
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_ack WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))


def test_ack_bulk_validation_pure():
    with pytest.raises(ValueError):
        ap.upsert_alert_acks(plant="P", alert_ids=[], reason="r", until=None, actor="a")
    with pytest.raises(ValueError):
        ap.upsert_alert_acks(plant="P", alert_ids=["a", 3], reason="r", until=None, actor="a")
    with pytest.raises(ValueError):
        ap.upsert_alert_acks(plant="P", alert_ids=["a"], reason="r", until="nope", actor="a")
