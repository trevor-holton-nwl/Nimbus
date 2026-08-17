"""Regression coverage for the global system_settings blob (admin-configurable
Orders field visibility) — get/upsert shallow-merge behavior, mirroring the
mocked-pool pattern in test_master_data_setup_policy.py so no live DB is
required."""
from contextlib import contextmanager

import master_data as md


class _Cursor:
    def __init__(self, fetchone_results=None):
        self.executed = []
        self._fetchone_results = list(fetchone_results or [])
        self.rowcount = 1

    def execute(self, statement, params=None):
        self.executed.append((str(statement), params))

    def fetchone(self):
        if self._fetchone_results:
            return self._fetchone_results.pop(0)
        return None


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


def test_get_system_settings_returns_empty_dict_when_row_missing(monkeypatch):
    cursor = _Cursor(fetchone_results=[None])
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert md.get_system_settings() == {}


def test_get_system_settings_returns_stored_blob(monkeypatch):
    cursor = _Cursor(fetchone_results=[({"orderFields": {"PLANT": {"grid": True}}},)])
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert md.get_system_settings() == {"orderFields": {"PLANT": {"grid": True}}}


def test_upsert_system_settings_shallow_merges_top_level_keys(monkeypatch):
    """Only the 'orderFields' key is replaced wholesale; a hypothetical sibling
    key already in storage must survive an orderFields-only patch."""
    cursor = _Cursor(fetchone_results=[({"orderFields": {"PLANT": {"grid": False}}, "otherKey": 1},)])
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.upsert_system_settings(
        {"orderFields": {"PLANT": {"grid": True, "inspector": False}}},
        user_email="owner@example.com",
    )

    assert result == {
        "orderFields": {"PLANT": {"grid": True, "inspector": False}},
        "otherKey": 1,
    }
    assert any("UPDATE system_settings" in statement for statement, _ in cursor.executed)
    assert any("INSERT INTO admin_audit" in statement for statement, _ in cursor.executed)


def test_upsert_system_settings_self_heals_missing_singleton_row(monkeypatch):
    """rowcount == 0 on the UPDATE (row bootstrapped but somehow missing) must
    insert rather than silently no-op."""
    cursor = _Cursor(fetchone_results=[None])
    cursor.rowcount = 0
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.upsert_system_settings({"orderFields": {}}, user_email=None)

    assert result == {"orderFields": {}}
    assert any("INSERT INTO system_settings" in statement for statement, _ in cursor.executed)


def test_upsert_system_settings_rejects_non_dict_patch(monkeypatch):
    monkeypatch.setattr(md, "_pool", _Pool(_Cursor()))
    try:
        md.upsert_system_settings("not-a-dict")
        assert False, "expected ValueError"
    except ValueError:
        pass
