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
