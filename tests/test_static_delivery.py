"""
Static-delivery contract tests for the CQ-1 static asset boundary (Phase 0 Task 4).

Frontend assets are served from a dedicated `frontend/` directory via the StaticFiles
mount registered last in brain.py, independent of the process's current working
directory. These tests pin: the UI loads at "/", `.mjs` responses carry
`Cache-Control: no-cache`, and backend source/config are never reachable through
the mount (they live outside `frontend/`, so the mount can't see them regardless of
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


def test_markdown_files_are_never_served(client):
    r = client.get("/scheduling/CLAUDE.md")
    assert r.status_code == 404


# GET /setup/{plant} and GET /master-data/{table} are bare 2-path-segment API
# routes, the same shape as a request for a static file directly inside
# frontend/setup/ or frontend/master-data/ (e.g. frontend/setup/setup-domain.mjs from the
# frontend domain reorganization). Without domain_static_asset_mw in brain.py,
# Starlette's router matches those API routes first and the static file is
# never reached. These pin that fix using hand-written fixtures (not the
# tsc-compiled .mjs files, which don't exist until `npm run build` runs).
@pytest.mark.parametrize("path", [
    "/setup/_static-delivery-check.mjs",
    "/master-data/_static-delivery-check.mjs",
])
def test_domain_static_files_are_served_not_shadowed_by_api_route(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]
    assert r.headers.get("cache-control") == "no-cache"


@pytest.mark.parametrize("path", [
    "/setup/_nonexistent-static-check.mjs",
    "/master-data/_nonexistent-static-check.mjs",
])
def test_domain_static_lookalike_paths_404_without_reaching_api_route(client, path):
    # A dotted final segment under these two prefixes is treated as a
    # filename, not a route parameter — even when the file doesn't exist, so
    # it must 404 like a missing static asset rather than fall through into
    # get_setup()/md_list() (which would 401/404 for a different reason).
    r = client.get(path)
    assert r.status_code == 404


def test_setup_route_still_reachable_for_real_plant_codes(client):
    # A real plant code never contains a dot, so it must still reach the
    # actual API route (get_setup requires auth -> 401 here, not 404).
    r = client.get("/setup/5512")
    assert r.status_code == 401


def test_master_data_route_still_reachable_for_real_table_names(client):
    # An unknown-but-dotless table name must still reach md_list's own
    # not-found handling, not the static-asset short-circuit.
    r = client.get("/master-data/not-a-real-table")
    assert r.status_code == 404


def test_setup_3segment_route_with_dotted_final_segment_still_reachable(client):
    # GET /setup/{plant}/missing-pairs.csv is a real, shipped 3-segment route
    # whose own final segment contains a dot. The static-asset gate must be
    # scoped to exactly 2 segments so this keeps reaching get_setup's sibling
    # handler (auth-gated -> 401), not the static-asset short-circuit (which
    # would wrongly 404 it, since no static file exists at that path).
    r = client.get("/setup/5512/missing-pairs.csv")
    assert r.status_code == 401
