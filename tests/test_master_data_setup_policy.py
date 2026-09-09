"""Regression coverage for setup-policy changes beside existing setup admin writes."""
from contextlib import contextmanager

import master_data as md


class _Cursor:
    rowcount = 1

    def __init__(self):
        self.executed = []

    def execute(self, statement, params=None):
        self.executed.append((str(statement), params))


class _Pool:
    def __init__(self, cursor):
        self.cursor_value = cursor

    @contextmanager
    def connection(self):
        yield _Connection(self.cursor_value)


class _Connection:
    def __init__(self, cursor):
        self.cursor_value = cursor
        self.committed = False

    @contextmanager
    def cursor(self):
        yield self.cursor_value

    def commit(self):
        self.committed = True


def test_setup_compatibility_write_returns_its_persisted_plant_line_payload(monkeypatch):
    """A policy-sidecar insertion must not strand the preceding write return."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_setup_line_compatibility("5512", "LINE-1", False, "Tooling differs", "owner@example.com")

    assert result == {
        "plant": "5512", "machine": "LINE-1", "setup_compatible": False,
        "setup_compatibility_reason": "Tooling differs",
    }
    assert any("UPDATE machine" in statement for statement, _ in cursor.executed)


def test_max_pull_forward_write_persists_nullable_integer_and_audits(monkeypatch):
    """A plant-scoped limit must be persisted and attributed to the admin actor."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_max_pull_forward_days("SN", "5512", 7, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "max_pull_forward_days": 7}
    update = next((item for item in cursor.executed if "UPDATE plants SET max_pull_forward_days" in item[0]), None)
    assert update is not None
    assert update[1] == [7, "5512", "SN"]
    assert any("set_max_pull_forward_days" in statement for statement, _ in cursor.executed)


def test_max_pull_forward_rejects_invalid_values():
    for value in (-1, 1.5, "7", True):
        try:
            md.set_plant_max_pull_forward_days("SN", "5512", value)
        except ValueError as error:
            assert "max_pull_forward_days" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_max_push_forward_write_persists_nullable_integer_and_audits(monkeypatch):
    """A plant-scoped limit must be persisted and attributed to the admin actor."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_max_push_forward_days("SN", "5512", 7, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "max_push_forward_days": 7}
    update = next((item for item in cursor.executed if "UPDATE plants SET max_push_forward_days" in item[0]), None)
    assert update is not None
    assert update[1] == [7, "5512", "SN"]
    assert any("set_max_push_forward_days" in statement for statement, _ in cursor.executed)


def test_max_push_forward_rejects_invalid_values():
    for value in (-1, 1.5, "7", True):
        try:
            md.set_plant_max_push_forward_days("SN", "5512", value)
        except ValueError as error:
            assert "max_push_forward_days" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_min_productive_segment_minutes_write_persists_positive_integer_and_audits(monkeypatch):
    """B3 (2026-08-21): the plant-configurable productive-segment floor must
    be persisted and attributed to the admin actor, mirroring
    set_plant_max_pull_forward_days's validated-write shape."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_min_productive_segment_minutes("SN", "5512", 15, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "min_productive_segment_minutes": 15}
    update = next(
        (item for item in cursor.executed if "UPDATE plants SET min_productive_segment_minutes" in item[0]), None,
    )
    assert update is not None
    assert update[1] == [15, "5512", "SN"]
    assert any("set_min_productive_segment_minutes" in statement for statement, _ in cursor.executed)


def test_min_productive_segment_minutes_rejects_invalid_values():
    """Unlike max_pull_forward_days, this column is NOT NULL — null, zero,
    negative, non-integer, and bool values must all be rejected."""
    for value in (-1, 0, 1.5, "30", True, None):
        try:
            md.set_plant_min_productive_segment_minutes("SN", "5512", value)
        except ValueError as error:
            assert "min_productive_segment_minutes" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_setup_active_write_persists_bool_and_audits(monkeypatch):
    """The relocated plant-level "include setup times" flag must persist to
    plants.setup_active and land in admin_audit, mirroring
    set_setup_line_compatibility's validated-write shape."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_setup_active("5512", True, subnetwork="SN", user_email="owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "setup_active": True}
    update = next((item for item in cursor.executed if "UPDATE plants SET setup_active" in item[0]), None)
    assert update is not None
    assert update[1] == [True, "5512", "SN"]
    assert any("set_setup_active" in statement for statement, _ in cursor.executed)


def test_setup_active_rejects_non_bool_the_same_way_setup_compatible_does():
    """No truthy-string coercion — a real bool or a ValueError, exactly like
    set_setup_line_compatibility's setup_compatible check."""
    for value in ("true", 1, None, 0):
        try:
            md.set_plant_setup_active("5512", value)
        except ValueError as error:
            assert "active" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_get_plant_setup_active_reads_the_persisted_column(monkeypatch):
    """A read-only fetch used to embed `plant_active` into GET /setup/{plant}."""
    class _ReadCursor(_Cursor):
        def execute(self, statement, params=None):
            super().execute(statement, params)
            self._row = (True,) if "setup_active" in str(statement) else None

        def fetchone(self):
            return self._row

    cursor = _ReadCursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert md.get_plant_setup_active("5512") is True
