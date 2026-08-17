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
        "plant": "5512", "line": "LINE-1", "setup_compatible": False,
        "setup_compatibility_reason": "Tooling differs",
    }
    assert any("UPDATE production_lines" in statement for statement, _ in cursor.executed)


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
