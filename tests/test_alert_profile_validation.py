"""Alert profile / ack input validation hardening (pure: no DB is ever reached)."""
from datetime import datetime, timezone

import pytest

from backend.alert_profiles import data as ap


class _NoDb:
    def connection(self):
        raise RuntimeError("db reached")


def _rule():
    return {"types": None, "dayFrom": None, "dayTo": None, "minSev": None, "minLateHours": None}


def test_ranking_rejects_unhashable_json_without_a_typeerror():
    for bad in ([], {}, ["impact"], {"a": 1}, 3, None, True):
        with pytest.raises(ValueError, match="ranking"):
            ap.validate_ranking(bad)


def test_description_must_be_text_or_null_and_is_capped(monkeypatch):
    monkeypatch.setattr(ap, "_pool", _NoDb())
    assert ap._validate_description(None) == "" and ap._validate_description("  hi  ") == "hi"
    assert ap._validate_description("x" * ap.MAX_DESCRIPTION_LEN) == "x" * ap.MAX_DESCRIPTION_LEN
    for bad in (5, ["a"], {"a": 1}, True, "x" * (ap.MAX_DESCRIPTION_LEN + 1)):
        with pytest.raises(ValueError, match="description"):
            ap._validate_description(bad)
    # both write paths validate it before touching the DB (the update path used to AttributeError on a number)
    with pytest.raises(ValueError, match="description"):
        ap.create_alert_profile(plant="P", name="N", rules=[_rule()], ranking="impact", actor="a@x", description=5)
    with pytest.raises(ValueError, match="description"):
        ap.update_alert_profile("x", actor="a@x", description=5)
    with pytest.raises(ValueError, match="description"):
        ap.update_alert_profile("x", actor="a@x", description=["a"])


def test_reason_and_alert_id_validators():
    assert ap.validate_reason("  because ") == "because"
    for bad in (None, "", "   ", 5, "x" * 201):
        with pytest.raises(ValueError, match="reason"):
            ap.validate_reason(bad)
    assert ap.validate_reason("x" * 200) == "x" * 200
    assert ap.validate_alert_id("a" * 200) == "a" * 200
    for bad in (None, "", " ", 5, "a" * 201):
        with pytest.raises(ValueError, match="alert_id"):
            ap.validate_alert_id(bad)
    assert ap.validate_alert_ids(["a", "b"]) == ["a", "b"]
    assert len(ap.validate_alert_ids(["a"] * 500)) == 500
    for bad in ([], None, "a1", ["a"] * 501, ["a", 3], ["a", ""], ["a", "b" * 201]):
        with pytest.raises(ValueError, match="alert_ids"):
            ap.validate_alert_ids(bad)


def test_ack_writers_validate_reason_and_ids_before_the_db(monkeypatch):
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="reason"):
        ap.upsert_alert_ack(plant="P", alert_id="a", reason="", actor="u")
    with pytest.raises(ValueError, match="alert_id"):
        ap.upsert_alert_ack(plant="P", alert_id="a" * 201, reason="r", actor="u")
    with pytest.raises(ValueError, match="reason"):
        ap.upsert_alert_acks(plant="P", alert_ids=["a"], reason="x" * 201, actor="u")
    with pytest.raises(ValueError, match="alert_ids"):
        ap.upsert_alert_acks(plant="P", alert_ids=["a"] * 501, reason="r", actor="u")


@pytest.mark.parametrize("until", [
    "2026-10-27T23:59:59Z", "2026-10-27T23:59:59+00:00", "2026-10-27T23:59:59-05:00",   # offsets / Z
    "2026-10-27", "20261027",                                                           # date only
    "nope", "", 5, [], {},
])
def test_parse_until_rejects_offsets_date_only_and_junk(until):
    with pytest.raises(ValueError, match="until"):
        ap._parse_until(until)


def test_parse_until_accepts_naive_local_datetimes_and_null():
    assert ap._parse_until(None) is None
    assert ap._parse_until("2026-10-27T23:59:59") == datetime(2026, 10, 27, 23, 59, 59)
    assert ap._parse_until("2026-10-27 23:59:59") == datetime(2026, 10, 27, 23, 59, 59)
    d = datetime(2026, 10, 27, 8, 0)
    assert ap._parse_until(d) is d
    with pytest.raises(ValueError, match="offset"):
        ap._parse_until(datetime(2026, 10, 27, 8, 0, tzinfo=timezone.utc))


def test_malformed_until_is_rejected_before_any_connection(monkeypatch):
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="until"):
        ap.upsert_alert_ack(plant="P1", alert_id="a1", reason="r", until="2030-01-01T00:00:00Z", actor="u")
    with pytest.raises(ValueError, match="until"):
        ap.upsert_alert_acks(plant="P1", alert_ids=["a1"], reason="r", until="2030-01-01", actor="u")
