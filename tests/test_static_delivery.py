"""
Static-delivery contract tests for the CQ-1 static asset boundary (Phase 0 Task 4).

Frontend assets are served from a dedicated `web/` directory via the StaticFiles
mount registered last in brain.py, independent of the process's current working
directory. These tests pin: the UI loads at "/", `.mjs` responses carry
`Cache-Control: no-cache`, and backend source/config are never reachable through
the mount (they live outside `web/`, so the mount can't see them regardless of
where the process is launched from).
"""
import pytest


def test_root_serves_the_nimbus_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "NIMBUS" in r.text


def test_app_js_is_served_as_javascript(client):
    r = client.get("/app.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]


def test_mjs_responses_carry_no_cache_header(client):
    r = client.get("/_static-delivery-check.mjs")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    assert r.headers.get("cache-control") == "no-cache"


def test_non_mjs_static_responses_are_not_forced_no_cache(client):
    r = client.get("/app.js")
    assert r.headers.get("cache-control") != "no-cache"


@pytest.mark.parametrize("path", [
    "/brain.py", "/db.py", "/master_data.py", "/schema.sql",
    "/.env", "/.git/config", "/requirements.txt", "/Dockerfile",
])
def test_backend_source_and_config_are_never_served(client, path):
    assert client.get(path).status_code == 404
