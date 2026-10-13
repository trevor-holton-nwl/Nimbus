"""Security request contracts using real dependencies and mocked database I/O."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import brain
from backend.security import auth


class _MalformedUsernameInternalError(AssertionError):
    """Only the verified throttle-key AttributeError is an expected defect."""


@pytest.fixture
def security(monkeypatch):
    pool = MagicMock(name="security_pool")
    conn = pool.connection.return_value.__enter__.return_value
    cursor = conn.cursor.return_value.__enter__.return_value
    monkeypatch.setattr(auth, "_pool", pool)
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "deployment-test-key")
    monkeypatch.setattr(auth, "get_user_role", {"admin": "admin", "planner": "planner"}.get)
    monkeypatch.setattr(auth, "admin_exists", lambda: True)
    logs = list(brain._BACKEND_LOG)
    failures = {key: list(value) for key, value in auth._login_failures.items()}
    auth._login_failures.clear()
    try:
        yield TestClient(brain.api, raise_server_exceptions=False), pool, conn, cursor
    finally:
        brain._BACKEND_LOG.clear()
        brain._BACKEND_LOG.extend(logs)
        auth._login_failures.clear()
        auth._login_failures.update(failures)


@pytest.mark.parametrize("headers", [{}, {"x-user-email": " "}, {"X-User": " "}])
def test_settings_rejects_blank_actor_without_db_access(security, headers):
    client, pool, _, _ = security
    response = client.patch("/security/me/settings", headers=headers, json={"settings": {}})
    assert response.status_code == 401
    assert response.json()["detail"] == "Not signed in"
    pool.connection.assert_not_called()


@pytest.mark.parametrize("patch", [None, [], "dark", 123, True])
def test_settings_requires_json_object_before_db_access(security, patch):
    client, pool, _, _ = security
    response = client.patch("/security/me/settings", headers={"x-user-email": "planner"}, json={"settings": patch})
    assert response.status_code == 400
    assert response.json()["detail"] == "settings must be a JSON object"
    pool.connection.assert_not_called()


def test_settings_unknown_actor_rolls_back_and_never_upserts(security):
    client, _, conn, cursor = security
    cursor.fetchone.return_value = None
    response = client.patch("/security/me/settings", headers={"x-user-email": "missing"}, json={"settings": {}})
    assert response.status_code == 401
    assert cursor.execute.call_count == 1
    conn.rollback.assert_called_once_with()
    conn.commit.assert_not_called()


@pytest.mark.parametrize("headers,actor", [
    ({"x-user-email": "  pLaNnEr  "}, "pLaNnEr"),
    ({"X-User": " planner "}, "planner"),
    ({"x-user-email": "planner", "X-User": "admin"}, "planner"),
])
def test_settings_canonicalizes_identity_and_returns_merged_blob(security, headers, actor):
    client, _, conn, cursor = security
    merged = {"theme": "dark", "locale": "fr", "grid": {"columns": ["order"]}}
    cursor.fetchone.side_effect = [("Planner",), (merged,)]
    response = client.patch("/security/me/settings", headers=headers,
                            json={"username": "victim", "settings": {"theme": "dark"}})
    assert response.status_code == 200
    assert response.json() == {"username": "Planner", "settings": merged}
    lookup, update = cursor.execute.call_args_list
    assert lookup.args[1] == (actor,)
    assert update.args[1][0] == "Planner"
    assert update.args[1][1].obj == {"theme": "dark"}
    conn.commit.assert_called_once_with()
    conn.rollback.assert_not_called()


def test_settings_write_error_never_commits_or_returns_success(security):
    client, _, conn, cursor = security
    cursor.fetchone.return_value = ("Planner",)
    cursor.execute.side_effect = [None, RuntimeError("write failed")]
    response = client.patch("/security/me/settings", headers={"x-user-email": "planner"}, json={"settings": {}})
    assert response.status_code == 500
    conn.commit.assert_not_called()


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/security/users", None),
    ("POST", "/security/users/bulk", {"upserts": [], "deletes": []}),
    ("POST", "/security/users/planner/reset-password", {"password": "long-test-password"}),
])
@pytest.mark.parametrize("headers,status", [
    ({"x-user-email": "admin"}, 401),
    ({"x-user-email": "admin", "x-api-key": "wrong"}, 401),
    ({"x-user-email": "planner", "x-api-key": "deployment-test-key"}, 403),
    ({"x-api-key": "deployment-test-key"}, 403),
])
def test_admin_user_operations_enforce_both_live_dependencies_before_sql(security, method, path, body, headers, status):
    client, pool, _, _ = security
    response = client.request(method, path, headers=headers, json=body)
    assert response.status_code == status
    pool.connection.assert_not_called()


@pytest.mark.parametrize("query", ["limit=0", "limit=100001", "offset=-1", "limit=abc", "offset=0.5"])
def test_user_pagination_validation_runs_before_query(security, query):
    client, pool, _, _ = security
    response = client.get(f"/security/users?{query}", headers={"x-user-email": "admin", "x-api-key": "deployment-test-key"})
    assert response.status_code == 422
    pool.connection.assert_not_called()


def test_user_list_response_drops_secret_fields_and_retains_pagination(security, monkeypatch):
    client, _, _, _ = security
    fetch = MagicMock(return_value={"users": [{"username": "Planner", "has_password": True,
                                             "password_hash": "never-send-this", "role": None}], "meta": {"total": 17}})
    monkeypatch.setattr(auth, "list_users", fetch)
    response = client.get("/security/users", params={"limit": 1, "offset": 3, "search": "Plan"},
                          headers={"x-user-email": "admin", "x-api-key": "deployment-test-key"})
    assert response.status_code == 200
    fetch.assert_called_once_with(limit=1, offset=3, search="Plan")
    assert response.json()["meta"] == {"total": 17}
    assert response.json()["users"][0]["has_password"] is True
    assert "password_hash" not in response.text
    assert "never-send-this" not in response.text


@pytest.mark.parametrize("role,admin_exists,is_admin", [("admin", True, True), ("planner", True, False),
                                                       ("planner", False, True), (None, True, False)])
def test_me_composes_current_role_settings_and_plant_scope(security, monkeypatch, role, admin_exists, is_admin):
    client, _, _, _ = security
    monkeypatch.setattr(auth, "get_user_profile", lambda actor: {"role": role, "first_name": "Ada", "last_name": None})
    monkeypatch.setattr(auth, "admin_exists", lambda: admin_exists)
    monkeypatch.setattr(auth, "get_allowed_plants", lambda actor: ["P1", "P2"])
    monkeypatch.setattr(auth, "get_user_settings", lambda actor: {"locale": "fr"})
    monkeypatch.setattr(auth, "get_role_settings", lambda current_role: {"theme": "dark"})
    response = client.get("/security/me", headers={"X-User": " planner "})
    assert response.status_code == 200
    assert response.json() == {"username": "planner", "role": role, "is_admin": is_admin,
                               "first_name": "Ada", "last_name": None, "allowed_plants": ["P1", "P2"],
                               "settings": {"locale": "fr"}, "role_settings": {"theme": "dark"}}


def test_login_response_filters_internal_credentials(security, monkeypatch):
    client, _, _, _ = security
    monkeypatch.setattr(auth, "authenticate", lambda username, password: {
        "username": username, "role": "planner", "allowed_plants": ["P1"],
        "password_hash": "internal-hash", "password": password,
    })
    response = client.post("/security/login", json={"username": "planner", "password": "secret-password"})
    assert response.status_code == 200
    assert response.json() == {"username": "planner", "role": "planner", "allowed_plants": ["P1"],
                               "first_name": None, "last_name": None}
    assert "secret-password" not in response.text
    assert "internal-hash" not in response.text


@pytest.mark.xfail(strict=True, raises=_MalformedUsernameInternalError,
                   reason="Untyped login username reaches .strip() and raises AttributeError -> 500")
@pytest.mark.parametrize("username", [123, ["planner"], {"name": "planner"}, True])
def test_login_rejects_nonstring_identity_as_client_input(security, username):
    _, pool, _, _ = security
    client = TestClient(brain.api, raise_server_exceptions=True)
    try:
        response = client.post("/security/login", json={"username": username, "password": "test"})
    except AttributeError as exc:
        assert type(exc) is AttributeError
        assert str(exc) == f"'{type(username).__name__}' object has no attribute 'strip'"
        origin = exc.__traceback__
        while origin.tb_next is not None:
            origin = origin.tb_next
        assert origin.tb_frame.f_code is auth._throttle_key.__code__
        raise _MalformedUsernameInternalError("Malformed username reached throttle-key .strip() instead of validation") from exc
    finally:
        pool.connection.assert_not_called()
    assert response.status_code in (400, 422)
