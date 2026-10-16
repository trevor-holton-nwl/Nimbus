"""
require_api_key sweep (2026-09-02) — the four POST /plant-calendar/* routes
were require_admin-only with zero require_api_key usage anywhere in
backend/calendars/routes.py, unlike every mutation-shaped sibling elsewhere
in the app. Same negative-test template as
test_setup_endpoints.py::test_setup_writes_reject_missing_api_key: the guard
must reject a request missing X-API-Key even when require_admin is
overridden to succeed.

DB-free: require_api_key fails before the handler (and therefore before any
master_data.py call) ever runs, so no database is needed for this file.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

try:
    from starlette.testclient import TestClient

    import backend.security.auth as auth
    import brain
except Exception as e:  # pragma: no cover - environment dependent
    pytest.skip(f"brain/TestClient unavailable in this environment: {e}",
                allow_module_level=True)


_PLANT_CALENDAR_POST_PATHS = [
    "/plant-calendar/plant-hours",
    "/plant-calendar/line-hours",
    "/plant-calendar/line-blackouts",
    "/plant-calendar/plant-blackouts",
    "/plant-calendar/plant-periods",
]


@pytest.mark.parametrize("path", _PLANT_CALENDAR_POST_PATHS)
def test_plant_calendar_post_rejects_missing_api_key(monkeypatch, path):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        response = TestClient(brain.api).post(path, json={"plant": "5512"})
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert response.status_code == 401
