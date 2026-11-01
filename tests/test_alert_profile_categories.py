"""W3: stored alert-group categories on alert profiles (validation, update semantics, routes, parity with the frontend)."""
import re
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.alert_profiles import data as ap
from backend.alert_profiles import data
from backend.alert_profiles.routes import router
from backend.security import auth

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_PROFILES = ROOT / "frontend" / "insights" / "alert-profiles.mts"


def _cats(on=("late",), **colors):
    return {c: {"on": c in on, "color": colors.get(c, "amber")} for c in ap.CATEGORIES}


def _rule(**kw):
    base = {"types": None, "dayFrom": None, "dayTo": None, "minSev": None, "minLateHours": None}
    base.update(kw)
    return base


# --------------------------------------------------------------------------- pure validation

def test_validate_categories_normalises_and_accepts_a_complete_map():
    out = ap.validate_categories({c: {"on": True, "color": "sky", "junk": 1} for c in ap.CATEGORIES})
    assert set(out) == ap.CATEGORIES and all(v == {"on": True, "color": "sky"} for v in out.values())


@pytest.mark.parametrize("mutate,msg", [
    (lambda c: c.pop("late"), "exactly the keys"),
    (lambda c: c.update(extra={"on": True, "color": "sky"}), "exactly the keys"),
    (lambda c: c.update(late="x"), "object"),
    (lambda c: c.update(late={"on": 1, "color": "sky"}), "true or false"),
    (lambda c: c.update(late={"on": True, "color": "chartreuse"}), "color"),
    (lambda c: c.update(late={"on": True}), "color"),
])
def test_validate_categories_rejects(mutate, msg):
    cats = _cats(on=("setup",))
    mutate(cats)
    with pytest.raises(ValueError, match=msg):
        ap.validate_categories(cats)


def test_validate_categories_needs_one_on_and_a_dict():
    with pytest.raises(ValueError, match="At least one"):
        ap.validate_categories(_cats(on=()))
    for bad in (None, [], "x"):
        with pytest.raises(ValueError, match="object"):
            ap.validate_categories(bad)


def test_validate_rules_allow_empty():
    assert ap.validate_rules([], allow_empty=True) == []
    with pytest.raises(ValueError, match="at least one"):
        ap.validate_rules([])
    with pytest.raises(ValueError, match="at most"):
        ap.validate_rules([_rule()] * 21, allow_empty=True)


def test_create_requires_a_rule_without_categories_and_allows_none_with_them(monkeypatch):
    # Validation happens before the first connection is opened; make any DB touch fail loudly instead of connecting.
    class _NoDb:
        def connection(self):
            raise RuntimeError("db reached")
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="at least one"):
        ap.create_alert_profile(plant="P", name="N", rules=[], ranking="impact", actor="a@x")
    with pytest.raises(RuntimeError, match="db reached"):
        ap.create_alert_profile(plant="P", name="N", rules=[], ranking="impact", actor="a@x", categories=_cats())
    with pytest.raises(ValueError, match="At least one"):
        ap.create_alert_profile(plant="P", name="N", rules=[], ranking="impact", actor="a@x", categories=_cats(on=()))


def test_update_rejects_bad_categories_before_touching_the_db(monkeypatch):
    class _NoDb:
        def connection(self):
            raise RuntimeError("db reached")
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="At least one"):
        ap.update_alert_profile("x", actor="a@x", categories=_cats(on=()))
    with pytest.raises(ValueError, match="at least one"):
        ap.update_alert_profile("x", actor="a@x", rules=[], categories=None)


def test_profile_cols_put_categories_at_ten_gantt_colors_at_eleven_and_show_acknowledged_at_twelve():
    cols = [c.strip() for c in ap._PROFILE_COLS.split(",")]
    assert cols[10] == "categories" and cols[11] == "gantt_colors" and cols[12] == "show_acknowledged"
    row = ap._profile_row(("i", "p", "n", "d", [], "impact", "c", "u", None, None, {"late": 1}, False, True))
    assert row["categories"] == {"late": 1} and row["gantt_colors"] is False and row["show_acknowledged"] is True


def test_validate_show_acknowledged_accepts_booleans_only():
    assert ap.validate_show_acknowledged(True) is True and ap.validate_show_acknowledged(False) is False
    for bad in (None, 0, 1, "true", [], {}):
        with pytest.raises(ValueError, match="true or false"):
            ap.validate_show_acknowledged(bad)


def test_create_and_update_reject_a_non_boolean_show_acknowledged_before_the_db(monkeypatch):
    class _NoDb:
        def connection(self):
            raise RuntimeError("db reached")
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="show_acknowledged"):
        ap.create_alert_profile(plant="P", name="N", rules=[_rule()], ranking="impact", actor="a@x", show_acknowledged="yes")
    with pytest.raises(ValueError, match="show_acknowledged"):
        ap.update_alert_profile("x", actor="a@x", show_acknowledged=1)


def test_validate_gantt_colors_accepts_booleans_only():
    assert ap.validate_gantt_colors(True) is True and ap.validate_gantt_colors(False) is False
    for bad in (None, 0, 1, "true", [], {}):
        with pytest.raises(ValueError, match="true or false"):
            ap.validate_gantt_colors(bad)


def test_create_and_update_reject_a_non_boolean_gantt_colors_before_the_db(monkeypatch):
    class _NoDb:
        def connection(self):
            raise RuntimeError("db reached")
    monkeypatch.setattr(ap, "_pool", _NoDb())
    with pytest.raises(ValueError, match="gantt_colors"):
        ap.create_alert_profile(plant="P", name="N", rules=[_rule()], ranking="impact", actor="a@x", gantt_colors="yes")
    with pytest.raises(ValueError, match="gantt_colors"):
        ap.update_alert_profile("x", actor="a@x", gantt_colors=1)


# --------------------------------------------------------------------------- frontend parity

def _ts_list(name: str) -> list[str]:
    src = FRONTEND_PROFILES.read_text(encoding="utf-8")
    m = re.search(rf"export const {name}[^=]*=\s*\[([^\]]*)\]", src)
    assert m, f"{name} literal not found"
    return re.findall(r"'([a-z_-]+)'", m.group(1))


def test_palette_matches_frontend_literal():
    assert set(_ts_list("PALETTE")) == ap.PALETTE and len(_ts_list("PALETTE")) == len(ap.PALETTE)


def test_categories_match_frontend_alert_category_order():
    src = FRONTEND_PROFILES.read_text(encoding="utf-8")
    block = re.search(r"export const ALERT_CATEGORIES[^=]*=\s*\{(.*?)\n\};", src, re.S).group(1)
    keys = re.findall(r"^  (\w+): ", block, re.M)
    assert "ALERT_CATEGORY_ORDER: readonly AlertCategory[] = Object.keys(ALERT_CATEGORIES)" in src
    assert set(keys) == ap.CATEGORIES and len(keys) == len(ap.CATEGORIES)


# --------------------------------------------------------------------------- routes pass-through

PROFILE = {"id": "abc", "plant": "P1", "name": "N", "description": "", "rules": [], "ranking": "impact",
           "created_by": "owner@example.com", "updated_by": "owner@example.com",
           "created_at": "2026-10-30T08:00:00", "updated_at": "2026-10-30T08:00:00", "categories": None, "gantt_colors": True,
           "show_acknowledged": False}


@pytest.fixture
def client(monkeypatch):
    calls = []
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[auth.require_authenticated] = lambda: "owner@example.com"
    app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["P1"]
    monkeypatch.setattr(auth, "get_user_role", lambda u: "planner")
    monkeypatch.setattr(data, "get_alert_profile", lambda i: PROFILE)

    def create(**kw):
        calls.append(("create", kw))
        return PROFILE

    def update(pid, **kw):
        calls.append(("update", kw))
        return PROFILE
    monkeypatch.setattr(data, "create_alert_profile", create)
    monkeypatch.setattr(data, "update_alert_profile", update)
    return TestClient(app), calls


def test_post_passes_categories_through(client):
    c, calls = client
    cats = _cats()
    assert c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [], "categories": cats}).status_code == 201
    assert calls[-1][1]["categories"] == cats
    c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [_rule()]})
    assert calls[-1][1]["categories"] is None


def test_put_passes_explicit_null_and_omits_when_absent(client):
    c, calls = client
    assert c.put("/alert-profiles/abc", json={"categories": None}).status_code == 200
    assert "categories" in calls[-1][1] and calls[-1][1]["categories"] is None
    c.put("/alert-profiles/abc", json={"name": "x"})
    assert "categories" not in calls[-1][1]
    c.put("/alert-profiles/abc", json={"categories": _cats()})
    assert calls[-1][1]["categories"] == _cats()


# --------------------------------------------------------------------------- DB round trips

@pytest.mark.pg
def test_categories_round_trip_update_semantics_and_null_revert():
    plant = "AC_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        ap.ensure_alert_profile_tables()  # bootstrap twice: idempotent
        legacy = ap.create_alert_profile(plant=plant, name="Legacy", rules=[_rule(types=["late"])], ranking="impact", actor="a@x")
        assert legacy["categories"] is None
        p = ap.create_alert_profile(plant=plant, name="Cats", rules=[], ranking="impact", actor="a@x", categories=_cats(on=("late", "setup")))
        assert p["rules"] == [] and p["categories"]["late"] == {"on": True, "color": "amber"}
        assert ap.get_alert_profile(p["id"])["categories"] == p["categories"]
        # omitted keeps the stored map
        u = ap.update_alert_profile(p["id"], name="Cats2", actor="a@x")
        assert u["categories"] == p["categories"] and u["rules"] == []
        # a map replaces it; rules may stay empty
        u = ap.update_alert_profile(p["id"], categories=_cats(on=("capacity",), capacity="sky"), actor="a@x")
        assert u["categories"]["capacity"] == {"on": True, "color": "sky"}
        # explicit null with empty rules: the merged row would match nothing
        with pytest.raises(ValueError, match="at least one rule"):
            ap.update_alert_profile(p["id"], categories=None, actor="a@x")
        # explicit null together with a rule reverts to derived
        u = ap.update_alert_profile(p["id"], categories=None, rules=[_rule(types=["overlap"])], actor="a@x")
        assert u["categories"] is None and len(u["rules"]) == 1
        # rules-only profile cannot be emptied
        with pytest.raises(ValueError, match="at least one rule"):
            ap.update_alert_profile(legacy["id"], rules=[], actor="a@x")
        with ap._pool.connection() as conn, conn.cursor() as cur:
            with pytest.raises(Exception):
                cur.execute("UPDATE alert_profile SET categories = '[]'::jsonb WHERE id = %s", (legacy["id"],))
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_profile WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))


def test_post_gantt_colors_defaults_true_and_passes_an_explicit_false(client):
    c, calls = client
    c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [_rule()]})
    assert calls[-1][1]["gantt_colors"] is True
    c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [_rule()], "gantt_colors": False})
    assert calls[-1][1]["gantt_colors"] is False


def test_put_passes_gantt_colors_when_present_and_omits_it_when_absent(client):
    c, calls = client
    assert c.put("/alert-profiles/abc", json={"gantt_colors": False}).status_code == 200
    assert calls[-1][1]["gantt_colors"] is False
    c.put("/alert-profiles/abc", json={"name": "x"})
    assert "gantt_colors" not in calls[-1][1]


def test_post_show_acknowledged_defaults_false_and_passes_an_explicit_true(client):
    c, calls = client
    c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [_rule()]})
    assert calls[-1][1]["show_acknowledged"] is False
    c.post("/alert-profiles", json={"plant": "P1", "name": "N", "rules": [_rule()], "show_acknowledged": True})
    assert calls[-1][1]["show_acknowledged"] is True


def test_put_passes_show_acknowledged_when_present_and_omits_it_when_absent(client):
    c, calls = client
    assert c.put("/alert-profiles/abc", json={"show_acknowledged": True}).status_code == 200
    assert calls[-1][1]["show_acknowledged"] is True
    c.put("/alert-profiles/abc", json={"name": "x"})
    assert "show_acknowledged" not in calls[-1][1]


@pytest.mark.pg
def test_show_acknowledged_round_trip_and_survives_an_update_without_the_field():
    plant = "AS_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        ap.ensure_alert_profile_tables()  # bootstrap twice: the ADD COLUMN is idempotent
        default = ap.create_alert_profile(plant=plant, name="Default", rules=[_rule(types=["late"])], ranking="impact", actor="a@x")
        assert default["show_acknowledged"] is False
        p = ap.create_alert_profile(plant=plant, name="Lists acked", rules=[_rule(types=["late"])], ranking="impact",
                                    actor="a@x", show_acknowledged=True)
        assert p["show_acknowledged"] is True
        assert ap.get_alert_profile(p["id"])["show_acknowledged"] is True
        u = ap.update_alert_profile(p["id"], name="Lists acked 2", actor="a@x")
        assert u["show_acknowledged"] is True, "an update without the field keeps the stored flag"
        u = ap.update_alert_profile(p["id"], show_acknowledged=False, actor="a@x")
        assert u["show_acknowledged"] is False
        assert [x["show_acknowledged"] for x in ap.list_alert_profiles(plant)] == [False, False]
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_profile WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))


@pytest.mark.pg
def test_gantt_colors_round_trip_and_survives_an_update_without_the_field():
    plant = "AG_" + uuid.uuid4().hex[:10]
    try:
        ap.ensure_alert_profile_tables()
        ap.ensure_alert_profile_tables()  # bootstrap twice: the ADD COLUMN is idempotent
        default = ap.create_alert_profile(plant=plant, name="Default", rules=[_rule(types=["late"])], ranking="impact", actor="a@x")
        assert default["gantt_colors"] is True
        p = ap.create_alert_profile(plant=plant, name="Plain bars", rules=[_rule(types=["late"])], ranking="impact",
                                    actor="a@x", gantt_colors=False)
        assert p["gantt_colors"] is False
        assert ap.get_alert_profile(p["id"])["gantt_colors"] is False
        u = ap.update_alert_profile(p["id"], name="Plain bars 2", actor="a@x")
        assert u["gantt_colors"] is False, "an update without the field keeps the stored flag"
        u = ap.update_alert_profile(p["id"], gantt_colors=True, actor="a@x")
        assert u["gantt_colors"] is True
        assert [x["gantt_colors"] for x in ap.list_alert_profiles(plant)] == [True, True]
    finally:
        with ap._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM alert_profile WHERE plant=%s", (plant,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant' = %s", (plant,))
