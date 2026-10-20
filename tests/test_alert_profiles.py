"""Alert profile + acknowledgement routes: HTTP behaviour only (data layer is monkeypatched, no DB)."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import master_data as md
from backend.alert_profiles import data
from backend.alert_profiles.routes import router
from backend.security import auth

RULES = [{"types": ["late"], "dayFrom": None, "dayTo": None, "minSev": None, "minLateHours": None}]
PROFILE = {"id": "abc", "plant": "P1", "name": "N", "description": "", "rules": RULES, "ranking": "impact",
           "created_by": "owner@example.com", "updated_by": "owner@example.com",
           "created_at": "2026-10-20T08:00:00", "updated_at": "2026-10-20T08:00:00"}
ACK = {"plant": "P1", "alert_id": "a1", "acknowledged_by": "owner@example.com", "reason": "r",
       "until": None, "created_at": "2026-10-20T08:00:00"}


@pytest.fixture
def ctx(monkeypatch):
    """Returns (client, state); state['actor'] is the signed-in user, calls are recorded in state['calls']."""
    state = {"actor": "owner@example.com", "calls": [], "monkeypatch": monkeypatch}
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[auth.require_authenticated] = lambda: state["actor"]
    app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["P1"]
    monkeypatch.setattr(auth, "get_user_role", lambda u: "planner")

    def rec(name, ret):
        def fn(*a, **kw):
            state["calls"].append((name, a, kw))
            return ret
        return fn
    for name, ret in (("list_alert_profiles", [PROFILE]), ("get_alert_profile", PROFILE),
                      ("create_alert_profile", PROFILE), ("update_alert_profile", PROFILE),
                      ("delete_alert_profile", PROFILE), ("list_alert_acks", [ACK]),
                      ("upsert_alert_ack", ACK), ("delete_alert_ack", True)):
        monkeypatch.setattr(data, name, rec(name, ret))
    return TestClient(app), state


def _names(state):
    return [c[0] for c in state["calls"]]


def test_page_access_keys_has_alerts():
    assert "alerts" in md.PAGE_ACCESS_KEYS


# ---- plant scoping -------------------------------------------------------
def test_list_requires_plant(ctx):
    c, _ = ctx
    assert c.get("/alert-profiles").status_code == 400
    assert c.get("/alert-profiles?plant=").status_code == 400
    assert c.get("/alert-acks").status_code == 400


def test_other_plant_403_on_every_route(ctx):
    c, _ = ctx
    body = {"plant": "P2", "name": "N", "rules": RULES}
    assert c.get("/alert-profiles?plant=P2").status_code == 403
    assert c.post("/alert-profiles", json=body).status_code == 403
    assert c.get("/alert-acks?plant=P2").status_code == 403
    assert c.post("/alert-acks", json={"plant": "P2", "alert_id": "a", "reason": "r"}).status_code == 403
    assert c.delete("/alert-acks/P2/a1").status_code == 403


def test_put_delete_check_stored_row_plant(ctx):
    c, s = ctx
    s["monkeypatch"].setattr(data, "get_alert_profile", lambda i: {**PROFILE, "plant": "P2"})
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 403
    assert c.delete("/alert-profiles/abc?plant=P1").status_code == 403


# ---- profiles ------------------------------------------------------------
def test_list_profiles(ctx):
    c, _ = ctx
    r = c.get("/alert-profiles?plant=P1")
    assert r.status_code == 200 and r.json() == {"plant": "P1", "profiles": [PROFILE]}


def test_create_201_passes_actor(ctx):
    c, s = ctx
    r = c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": RULES})
    assert r.status_code == 201 and r.json()["id"] == "abc"
    kw = s["calls"][-1][2]
    assert kw["actor"] == "owner@example.com" and kw["plant"] == "P1" and kw["ranking"] == "impact"


def test_create_validation_400(ctx):
    c, s = ctx

    def boom(**kw):
        raise ValueError("bad rules")
    s["monkeypatch"].setattr(data, "create_alert_profile", boom)
    r = c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": []})
    assert r.status_code == 400 and "bad rules" in r.json()["detail"]
    assert c.post("/alert-profiles", json={"plant": "", "name": "N", "rules": RULES}).status_code == 400


def test_create_duplicate_409(ctx):
    c, s = ctx

    def dup(**kw):
        raise data.DuplicateName("dup")
    s["monkeypatch"].setattr(data, "create_alert_profile", dup)
    r = c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": RULES})
    assert r.status_code == 409 and r.json() == {"detail": "name_taken"}


def test_put_creator_ok_other_forbidden_admin_ok(ctx):
    c, s = ctx
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 200
    assert s["calls"][-1][2]["actor"] == "owner@example.com"
    s["actor"] = "OWNER@example.com"  # case-insensitive
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 200
    s["actor"] = "other@example.com"
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 403
    s["monkeypatch"].setattr(auth, "get_user_role", lambda u: "admin")
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 200


def test_put_404_empty_body_stale_dup_invalid(ctx):
    c, s = ctx
    assert c.put("/alert-profiles/abc", json={}).status_code == 400
    assert "update_alert_profile" not in _names(s)
    s["monkeypatch"].setattr(data, "get_alert_profile", lambda i: None)
    assert c.put("/alert-profiles/nope", json={"name": "x"}).status_code == 404
    s["monkeypatch"].setattr(data, "get_alert_profile", lambda i: PROFILE)
    s["monkeypatch"].setattr(data, "update_alert_profile", lambda *a, **k: None)  # vanished mid-flight
    assert c.put("/alert-profiles/abc", json={"name": "x"}).status_code == 404

    def stale(*a, **k):
        raise ValueError("stale")
    s["monkeypatch"].setattr(data, "update_alert_profile", stale)
    r = c.put("/alert-profiles/abc", json={"name": "x", "expected_updated_at": "t"})
    assert r.status_code == 409 and r.json() == {"detail": "stale"}

    def dup(*a, **k):
        raise data.DuplicateName("dup")
    s["monkeypatch"].setattr(data, "update_alert_profile", dup)
    r = c.put("/alert-profiles/abc", json={"name": "x"})
    assert r.status_code == 409 and r.json() == {"detail": "name_taken"}

    def bad(*a, **k):
        raise ValueError("ranking must be one of")
    s["monkeypatch"].setattr(data, "update_alert_profile", bad)
    assert c.put("/alert-profiles/abc", json={"ranking": "zzz"}).status_code == 400


def test_delete_profile(ctx):
    c, s = ctx
    r = c.delete("/alert-profiles/abc?plant=P1")
    assert r.status_code == 200 and r.json() == {"deleted": True, "id": "abc"}
    s["actor"] = "other@example.com"
    assert c.delete("/alert-profiles/abc?plant=P1").status_code == 403
    s["monkeypatch"].setattr(auth, "get_user_role", lambda u: "admin")
    assert c.delete("/alert-profiles/abc?plant=P1").status_code == 200
    s["monkeypatch"].setattr(data, "get_alert_profile", lambda i: None)
    assert c.delete("/alert-profiles/abc?plant=P1").status_code == 404


# ---- acknowledgements ----------------------------------------------------
def test_list_acks(ctx):
    c, _ = ctx
    r = c.get("/alert-acks?plant=P1")
    assert r.status_code == 200 and r.json() == {"plant": "P1", "acks": [ACK]}


def test_post_ack_happy_and_validation(ctx):
    c, s = ctx
    r = c.post("/alert-acks", json={"plant": "P1", "alert_id": "a1", "reason": "  because  ",
                                    "until": "2026-10-25T08:00:00"})
    assert r.status_code == 200 and r.json()["alert_id"] == "a1"
    kw = s["calls"][-1][2]
    assert kw["reason"] == "because" and kw["until"] == "2026-10-25T08:00:00" and kw["actor"] == "owner@example.com"
    assert c.post("/alert-acks", json={"plant": "P1", "alert_id": "a1", "reason": "x"}).status_code == 200
    assert s["calls"][-1][2]["until"] is None
    for bad in ({"reason": ""}, {"reason": "   "}, {"reason": "x" * 201}, {"reason": 5}, {}):
        assert c.post("/alert-acks", json={"plant": "P1", "alert_id": "a1", **bad}).status_code == 400, bad
    assert c.post("/alert-acks", json={"plant": "P1", "alert_id": "", "reason": "x"}).status_code == 400
    assert c.post("/alert-acks", json={"plant": "P1", "alert_id": "a", "reason": "x" * 200}).status_code == 200


def test_post_ack_data_valueerror_400(ctx):
    c, s = ctx

    def bad(**kw):
        raise ValueError("until must be an ISO datetime or null")
    s["monkeypatch"].setattr(data, "upsert_alert_ack", bad)
    r = c.post("/alert-acks", json={"plant": "P1", "alert_id": "a", "reason": "x", "until": "nope"})
    assert r.status_code == 400


def test_delete_ack_permissions(ctx):
    c, s = ctx
    r = c.delete("/alert-acks/P1/a1")
    assert r.status_code == 200 and r.json() == {"deleted": True}
    s["actor"] = "other@example.com"
    assert c.delete("/alert-acks/P1/a1").status_code == 403
    s["monkeypatch"].setattr(auth, "get_user_role", lambda u: "admin")
    assert c.delete("/alert-acks/P1/a1").status_code == 200
    s["monkeypatch"].setattr(data, "list_alert_acks", lambda p: [])
    assert c.delete("/alert-acks/P1/a1").json() == {"deleted": False}
