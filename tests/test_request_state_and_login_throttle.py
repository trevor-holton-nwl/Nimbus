"""Request state boundaries that can fail only across multiple HTTP requests."""

import re

import pytest
from fastapi.testclient import TestClient

import brain
import db
from backend.security import auth


@pytest.fixture
def login_client(monkeypatch):
    original = dict(auth._login_failures)
    auth._login_failures.clear()
    now = {"seconds": 1000.0}
    monkeypatch.setattr(auth.time, "time", lambda: now["seconds"])

    def authenticate(username, password):
        if password != "correct":
            return None
        return {"username": username, "role": "planner", "first_name": None,
                "last_name": None, "allowed_plants": ["5512"]}

    monkeypatch.setattr(auth, "authenticate", authenticate)
    yield TestClient(brain.api), now
    auth._login_failures.clear()
    auth._login_failures.update(original)


def _login(client, username, password="wrong"):
    return client.post("/security/login", json={"username": username, "password": password})


def test_throttle_combines_case_and_whitespace_but_does_not_block_another_account(login_client):
    client, _clock = login_client
    for username in ("Alice", "alice", " ALICE ", "alice", "ALICE", "alice", "Alice", "alice"):
        assert _login(client, username).status_code == 401

    blocked = _login(client, "aLiCe")
    assert blocked.status_code == 429
    assert "password" not in blocked.text.lower()
    assert _login(client, "bob").status_code == 401
    assert len(auth._login_failures[("bob", "testclient")]) == 1


def test_login_success_resets_only_its_own_throttle_bucket(login_client):
    client, _clock = login_client
    for _ in range(7):
        assert _login(client, "alice").status_code == 401
        assert _login(client, "bob").status_code == 401

    good = _login(client, "alice", "correct")
    assert good.status_code == 200
    assert good.json()["allowed_plants"] == ["5512"]
    assert ("alice", "testclient") not in auth._login_failures
    assert _login(client, "alice").status_code == 401
    assert _login(client, "bob").status_code == 401
    assert _login(client, "bob").status_code == 429


def test_expired_failures_let_same_account_attempt_again(login_client):
    client, clock = login_client
    for _ in range(8):
        assert _login(client, "alice").status_code == 401
    assert _login(client, "alice").status_code == 429

    clock["seconds"] += auth._LOGIN_THROTTLE_WINDOW_SECONDS
    assert _login(client, "alice").status_code == 401
    assert len(auth._login_failures[("alice", "testclient")]) == 1


def test_login_throttle_keeps_client_ip_buckets_separate(login_client):
    _client, _clock = login_client
    office = TestClient(brain.api, client=("192.0.2.10", 50000))
    vpn = TestClient(brain.api, client=("192.0.2.11", 50000))
    for _ in range(8):
        assert _login(office, "alice").status_code == 401
    assert _login(office, "alice").status_code == 429
    assert _login(vpn, "alice").status_code == 401
    assert len(auth._login_failures[("alice", "192.0.2.11")]) == 1


def test_request_ids_follow_each_audit_event_and_do_not_leak_to_the_next_request(monkeypatch):
    original = list(brain._BACKEND_LOG)
    brain._BACKEND_LOG.clear()
    monkeypatch.setattr(db, "run_analyze", lambda table: {"table": table})
    brain.api.dependency_overrides[auth.require_admin] = lambda: "admin@example.com"
    brain.api.dependency_overrides[auth.require_api_key] = lambda: None
    try:
        client = TestClient(brain.api)
        first = client.post("/maintenance/analyze", json={"table": "orders"}, headers={"x-request-id": "first-audit"})
        second = client.post("/maintenance/analyze", json={"table": "plants"}, headers={"x-request-id": "second-audit"})
        generated = client.post("/maintenance/analyze", json={"table": "machines"})

        assert [response.status_code for response in (first, second, generated)] == [200, 200, 200]
        assert first.headers["x-request-id"] == "first-audit"
        assert second.headers["x-request-id"] == "second-audit"
        assert re.fullmatch(r"[0-9a-f-]{36}", generated.headers["x-request-id"])

        audit = [entry for entry in brain._BACKEND_LOG if entry.get("category") == "admin"]
        assert [entry["rid"] for entry in audit] == [
            "first-audit", "second-audit", generated.headers["x-request-id"]]
        assert brain._RID_CTX.get() is None
    finally:
        brain.api.dependency_overrides.pop(auth.require_admin, None)
        brain.api.dependency_overrides.pop(auth.require_api_key, None)
        brain._BACKEND_LOG.clear()
        brain._BACKEND_LOG.extend(original)
