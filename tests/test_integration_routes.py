"""
require_api_key sweep (2026-09-02) — POST /upload/audit/clear was
require_admin-only despite being destructive (wipes all upload history),
the same class of route as POST /logs/backend/clear and
POST /audit/log/clear, both of which already required the key. Same
negative-test template as
test_setup_endpoints.py::test_setup_writes_reject_missing_api_key.

DB-free: require_api_key fails before the handler (and therefore before any
db.py call) ever runs, so no database is needed for this file.
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


def test_upload_audit_clear_rejects_missing_api_key(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        response = TestClient(brain.api).post("/upload/audit/clear")
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert response.status_code == 401


def test_upload_orders_rejects_oversized_file_with_413(monkeypatch):
    """Orders upload must reject files exceeding NIMBUS_MAX_UPLOAD_BYTES
    with HTTP 413 Payload Too Large, preventing unbounded memory consumption."""
    import backend.integration.routes as int_routes
    monkeypatch.setattr(int_routes, "NIMBUS_MAX_UPLOAD_BYTES", 1000)  # 1 KB limit for test
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)  # Disable API key check
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        # Create oversized payload (1.5 KB > 1 KB limit)
        oversized = b"x" * 1500
        response = TestClient(brain.api).post("/upload",
                                              files={"file": ("oversized.xlsx", oversized)})
        assert response.status_code == 413
        assert "exceeds maximum allowed size" in response.json()["detail"]
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)


def test_upload_bom_rejects_oversized_file_with_413(monkeypatch):
    """BOM upload must reject files exceeding NIMBUS_MAX_UPLOAD_BYTES
    with HTTP 413 Payload Too Large."""
    import backend.integration.routes as int_routes
    monkeypatch.setattr(int_routes, "NIMBUS_MAX_UPLOAD_BYTES", 1000)  # 1 KB limit for test
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)  # Disable API key check
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        # Create oversized payload (1.5 KB > 1 KB limit)
        oversized = b"y" * 1500
        response = TestClient(brain.api).post("/bom/upload",
                                              files={"file": ("oversized.xlsx", oversized)})
        assert response.status_code == 413
        assert "exceeds maximum allowed size" in response.json()["detail"]
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
