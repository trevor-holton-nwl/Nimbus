"""W4b: exact join keys. upload_audit.rid, and rid + plant on /audit/log rows.
DB-free: the pool and the JSONL file are stubbed."""
import datetime as dt
import pathlib

import pytest

pytest.importorskip("fastapi")
from starlette.testclient import TestClient  # noqa: E402

import brain  # noqa: E402
import db  # noqa: E402
from backend.admin_ops.logbuffer import _RID_CTX  # noqa: E402
from backend.master_data import routes as md_routes  # noqa: E402
from backend.security import auth  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_migration_is_additive_and_idempotent():
    sql = (ROOT / "migrations" / "2026-10-30-1-upload-audit-rid.sql").read_text(encoding="utf-8")
    assert "ADD COLUMN IF NOT EXISTS rid" in sql
    assert "DROP" not in sql.upper() and "TYPE" not in sql.upper().replace("TEXT", "")


def test_schema_sql_mirrors_rid_column():
    assert "ALTER TABLE upload_audit ADD COLUMN IF NOT EXISTS rid TEXT" in (ROOT / "schema.sql").read_text(encoding="utf-8")


def test_audit_rid_reads_request_contextvar():
    assert db._audit_rid() is None
    tok = _RID_CTX.set("abc123")
    try:
        assert db._audit_rid() == "abc123"
    finally:
        _RID_CTX.reset(tok)


class _FakeCur:
    def __init__(self, rows): self._rows = rows
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql, params=None): self.sql = sql
    def fetchall(self): return self._rows


class _FakeConn:
    def __init__(self, rows): self._rows = rows
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def cursor(self): return _FakeCur(self._rows)


class _FakePool:
    def __init__(self, rows): self._rows = rows
    def connection(self): return _FakeConn(self._rows)


def test_upload_audit_log_returns_rid_and_null_for_old_rows(monkeypatch):
    ts = dt.datetime(2026, 10, 30, 10, 0, 0)
    rows = [("b1", "f.xlsx", 3, 1, 2, ts, [], "abc123"), ("b2", "g.xlsx", 1, 0, 0, ts, None, None)]
    monkeypatch.setattr(db, "_pool", _FakePool(rows))
    out = db.upload_audit_log(10)
    assert out[0]["rid"] == "abc123"
    assert out[1]["rid"] is None


@pytest.fixture
def tc(monkeypatch):
    written: list[dict] = []
    monkeypatch.setattr(md_routes, "_cw_append_audit", written.append)
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "u"
    try:
        c = TestClient(brain.api)
        c.written = written
        yield c
    finally:
        brain.api.dependency_overrides.pop(auth.require_authenticated, None)


def test_post_audit_log_stamps_rid_server_side(tc):
    r = tc.post("/audit/log", json={"action": "x", "rid": "forged"}, headers={"x-request-id": "rid-77"})
    assert r.status_code == 200
    assert tc.written[0]["rid"] == "rid-77"


def test_post_audit_log_keeps_caller_plant(tc):
    assert tc.post("/audit/log", json={"action": "x", "plant": "1008"}).status_code == 200
    assert tc.written[0]["plant"] == "1008"


def test_post_audit_log_rejects_long_or_non_string_plant(tc):
    assert tc.post("/audit/log", json={"action": "x", "plant": "P" * 33}).status_code == 400
    assert tc.post("/audit/log", json={"action": "x", "plant": 5}).status_code == 400
    assert tc.post("/audit/log", json={"action": "x", "plant": "P" * 32}).status_code == 200


def test_get_audit_log_returns_rid_and_plant(monkeypatch, tmp_path):
    f = tmp_path / "audit.jsonl"
    f.write_text('{"ts": "t", "action": "a", "plant": "1008", "rid": "r9"}\n', encoding="utf-8")
    monkeypatch.setattr(md_routes, "_cw_audit_path", lambda: str(f))
    brain.api.dependency_overrides[brain.require_admin] = lambda: "admin"
    try:
        e = TestClient(brain.api).get("/audit/log").json()["entries"][0]
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert e["rid"] == "r9" and e["plant"] == "1008"
