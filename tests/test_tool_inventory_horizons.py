"""Tool Inventory Wave 3: the /tasks/horizons freshness probe fields (tool_inventory_version, tooling_rule).
No real Postgres: a fake pool/cursor dispatches on the SQL text (same style as tests/test_tool_inventory.py)."""
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

import db

pytest.importorskip("fastapi")
from backend.scheduling import routes as scheduling_routes  # noqa: E402
from backend.scheduling.models import HorizonsResponse  # noqa: E402

PLANT = "ZZTEST_HZ_PLANT"


class _Conn:
    def __init__(self, cur):
        self._cur = cur
        self.rolled_back = False

    @contextmanager
    def cursor(self):
        yield self._cur

    def rollback(self):
        self.rolled_back = True


class _Pool:
    def __init__(self, cur):
        self.cur = cur

    @contextmanager
    def connection(self):
        yield self.cur.connection_obj


class _Cur:
    def __init__(self, plant_row, inv_row=None, inv_raises=False, plant_exists=True):
        self.plant_row, self.inv_row, self.inv_raises, self.plant_exists = plant_row, inv_row, inv_raises, plant_exists
        self.connection_obj = _Conn(self)
        self.connection = self.connection_obj
        self._last = ""

    def execute(self, stmt, params=None):
        self._last = str(stmt)
        if "FROM tool_inventory" in self._last and self.inv_raises:
            raise RuntimeError('relation "tool_inventory" does not exist')

    def fetchone(self):
        if "visibility_horizon_days" in self._last:
            return self.plant_row if self.plant_exists else None
        if "FROM tool_inventory" in self._last:
            return self.inv_row
        return ("cal-v1",)  # plant_calendar_version


def _plant_row(policy):
    return (None, 0, "UTC", None, 100, policy)


def _probe(monkeypatch, **kw):
    cur = _Cur(**kw)
    monkeypatch.setattr(db, "_pool", _Pool(cur))
    return db.plant_horizons(PLANT), cur


def test_version_is_count_and_max_updated_at(monkeypatch):
    ts = datetime(2026, 10, 27, 10, 0, 0, 123456, tzinfo=timezone.utc)
    out, _ = _probe(monkeypatch, plant_row=_plant_row({}), inv_row=(3, ts))
    assert out["tool_inventory_version"] == "3|2026-10-27T10:00:00.123456+00:00"
    assert out["calendar_version"] == "cal-v1" and out["alert_horizon_minutes"] == 100


def test_empty_inventory_is_none(monkeypatch):
    out, _ = _probe(monkeypatch, plant_row=_plant_row({}), inv_row=(0, None))
    assert out["tool_inventory_version"] is None


def test_missing_table_is_fail_open_and_rolls_back(monkeypatch):
    out, cur = _probe(monkeypatch, plant_row=_plant_row({"toolingRule": "hard"}), inv_raises=True)
    assert out["tool_inventory_version"] is None
    assert out["tooling_rule"] == "hard", "the rule was read before the failed probe"
    assert cur.connection_obj.rolled_back


@pytest.mark.parametrize("policy,expected", [
    ({}, "off"), (None, "off"), ({"toolingRule": "hard"}, "hard"), ({"toolingRule": "off"}, "off"),
    ({"toolingRule": "bogus"}, "off"), ({"unknownSetupPolicy": "zero"}, "off"),
])
def test_tooling_rule_defaults_to_off(monkeypatch, policy, expected):
    out, _ = _probe(monkeypatch, plant_row=_plant_row(policy), inv_row=(0, None))
    assert out["tooling_rule"] == expected


def test_unknown_plant_is_none_and_off(monkeypatch):
    out, _ = _probe(monkeypatch, plant_row=None, plant_exists=False)
    assert out["tool_inventory_version"] is None and out["tooling_rule"] == "off" and out["calendar_version"] is None


def test_route_returns_the_new_fields_and_the_model_accepts_them(monkeypatch):
    monkeypatch.setattr(db, "plant_horizons", lambda plant: {
        "visibility_horizon_end": None, "frozen_horizon_end": None, "alert_horizon_minutes": None,
        "calendar_version": "c", "tool_inventory_version": "2|x", "tooling_rule": "hard"})
    body = scheduling_routes.get_task_horizons(plant=PLANT, allowed_plants=None)
    assert body["tool_inventory_version"] == "2|x" and body["tooling_rule"] == "hard"
    HorizonsResponse(**body)
    # an older db layer result without the keys still yields the defaults
    monkeypatch.setattr(db, "plant_horizons", lambda plant: {
        "visibility_horizon_end": None, "frozen_horizon_end": None, "alert_horizon_minutes": None})
    body = scheduling_routes.get_task_horizons(plant=PLANT, allowed_plants=None)
    assert body["tool_inventory_version"] is None and body["tooling_rule"] == "off"
