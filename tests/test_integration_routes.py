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
from io import BytesIO

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

try:
    from starlette.testclient import TestClient

    import backend.integration.routes as int_routes
    import backend.security.auth as auth
    import brain
except Exception as e:  # pragma: no cover - environment dependent
    pytest.skip(f"brain/TestClient unavailable in this environment: {e}",
                allow_module_level=True)


@pytest.fixture
def admin_client(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    brain.api.dependency_overrides[int_routes.require_admin] = lambda: "test-admin"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.pop(int_routes.require_admin, None)


def _xlsx(rows: list[dict]) -> bytes:
    buf = BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


def test_upload_audit_clear_rejects_missing_api_key(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        response = TestClient(brain.api).post("/upload/audit/clear")
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert response.status_code == 401


def test_upload_orders_captures_uploaded_plants_before_ingest(admin_client, monkeypatch):
    """A valid upload must scope setup-state capture to the workbook's plants
    and perform that capture before mutating orders."""
    events = []
    workbook = _xlsx([
        {"ORDER": "ZZTEST_UPLOAD_1", "MATERIAL_NUMBER": "ZZTEST_MAT_1",
         "WERKS": "ZZTEST_PB", "BASIC_START_DATE": "2026-09-10 08:00"},
        {"ORDER": "ZZTEST_UPLOAD_2", "MATERIAL_NUMBER": "ZZTEST_MAT_2",
         "WERKS": "ZZTEST_PA", "BASIC_START_DATE": "2026-09-10 09:00"},
    ])

    def fake_capture(**kwargs):
        events.append(("capture", kwargs))

    def fake_ingest(raw, filename):
        events.append(("ingest", {"raw": raw, "filename": filename}))
        return {
            "status": "ok",
            "batch_id": "batch-123",
            "raw_row_count": 2,
            "inserted": 2,
            "updated": 0,
            "lines": ["LINE_1"],
            "warnings": [],
        }

    monkeypatch.setattr(int_routes.setup_data, "capture_setup_states_before_schedule_mutation", fake_capture)
    monkeypatch.setattr(int_routes.db, "ingest_orders_from_excel", fake_ingest)
    monkeypatch.setattr(int_routes.md, "known_plant_line_codes", lambda: {"lines": {"LINE_1"}})

    response = admin_client.post(
        "/upload",
        files={"file": ("orders.xlsx", workbook)},
        headers={"x-user-email": "planner@example.com"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["batch_id"] == "batch-123"
    assert body["inserted"] == 2
    assert [name for name, _ in events] == ["capture", "ingest"]
    assert events[0][1] == {
        "actor": "planner@example.com",
        "reason": "Excel upload replacement",
        "plants": ["ZZTEST_PA", "ZZTEST_PB"],
    }
    assert events[1][1]["raw"] == workbook
    assert events[1][1]["filename"] == "orders.xlsx"


def test_upload_orders_malformed_file_still_captures_before_ingest_error(admin_client, monkeypatch):
    """Malformed order uploads must still take the pre-mutation setup snapshot,
    then surface the ingest error as HTTP 400."""
    events = []
    raw = b"not an excel workbook"

    def fake_capture(**kwargs):
        events.append(("capture", kwargs))

    def fake_ingest(file_bytes, filename):
        events.append(("ingest", {"raw": file_bytes, "filename": filename}))
        return {
            "status": "error",
            "message": "Could not parse xlsx: bad file",
            "raw_row_count": 0,
            "inserted": 0,
            "updated": 0,
            "warnings": [],
            "batch_id": "failed-batch",
        }

    monkeypatch.setattr(int_routes.setup_data, "capture_setup_states_before_schedule_mutation", fake_capture)
    monkeypatch.setattr(int_routes.db, "ingest_orders_from_excel", fake_ingest)

    response = admin_client.post(
        "/upload",
        files={"file": ("bad.xlsx", raw)},
        headers={"x-user-email": "planner@example.com"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["detail"] == "Could not parse xlsx: bad file"
    assert body["message"] == "Could not parse xlsx: bad file"
    assert body["status"] == "error"
    assert [name for name, _ in events] == ["capture", "ingest"]
    assert events[0][1] == {
        "actor": "planner@example.com",
        "reason": "Excel upload replacement",
        "plants": None,
    }


def test_upload_bom_returns_ingest_result_and_actor(admin_client, monkeypatch):
    """Successful BOM uploads must return the ingest result and pass the
    caller identity into the BOM ingest/audit path."""
    calls = []
    workbook = _xlsx([
        {"MATERIAL": "ZZTEST_PARENT", "PLANT": "ZZTEST_PA",
         "ALTERNATIVE_BOM": "01", "LEVEL": 1, "ITEM_NUMBER": "0010",
         "COMPONENT": "ZZTEST_COMPONENT"},
    ])

    def fake_ingest(raw, filename, user_email):
        calls.append({"raw": raw, "filename": filename, "user_email": user_email})
        return {
            "status": "ok",
            "raw_row_count": 1,
            "inserted": 1,
            "updated": 0,
            "rejected": 0,
            "warnings": [],
        }

    monkeypatch.setattr(int_routes.md, "ingest_bom_from_excel", fake_ingest)

    response = admin_client.post(
        "/bom/upload",
        files={"file": ("bom.xlsx", workbook)},
        headers={"x-user-email": "bom.admin@example.com"},
    )

    assert response.status_code == 200
    assert response.json()["inserted"] == 1
    assert response.json()["rejected"] == 0
    assert calls == [{"raw": workbook, "filename": "bom.xlsx", "user_email": "bom.admin@example.com"}]


def test_upload_bom_surfaces_ingest_failure_as_400(admin_client, monkeypatch):
    """BOM parse/validation failures must be client errors, not a successful
    response with status=error."""
    monkeypatch.setattr(int_routes.md, "ingest_bom_from_excel", lambda *args: {
        "status": "error",
        "message": "Uploaded file is missing required columns: ['COMPONENT']",
        "raw_row_count": 1,
        "inserted": 0,
        "updated": 0,
        "rejected": 0,
        "warnings": [],
    })

    response = admin_client.post(
        "/bom/upload",
        files={"file": ("bom.xlsx", _xlsx([{"MATERIAL": "ZZTEST_PARENT"}]))},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["detail"] == "Uploaded file is missing required columns: ['COMPONENT']"
    assert body["message"] == "Uploaded file is missing required columns: ['COMPONENT']"
    assert body["status"] == "error"


def test_purge_captures_immediately_before_deleting_orders(admin_client, monkeypatch):
    """Purge must preserve setup observability immediately before the
    destructive date-range delete and return the delete result."""
    events = []

    def fake_capture(**kwargs):
        events.append(("capture", kwargs))

    def fake_purge(start, end):
        events.append(("purge", {"start": start.isoformat(), "end": end.isoformat()}))
        return {"status": "ok", "deleted": 3}

    monkeypatch.setattr(int_routes.setup_data, "capture_setup_states_before_schedule_mutation", fake_capture)
    monkeypatch.setattr(int_routes.db, "purge_orders_by_date", fake_purge)

    response = admin_client.post(
        "/purge",
        json={"start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"},
        headers={"x-user-email": "planner@example.com"},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "deleted": 3}
    assert [name for name, _ in events] == ["capture", "purge"]
    assert events[0][1] == {"actor": "planner@example.com", "reason": "order purge"}
    assert events[1][1] == {"start": "2026-09-01T00:00:00", "end": "2026-09-30T23:59:59"}


def test_purge_rejects_invalid_date_range_before_capture_or_delete(admin_client, monkeypatch):
    """Invalid purge payloads must fail before snapshot or delete side effects."""
    events = []
    monkeypatch.setattr(
        int_routes.setup_data,
        "capture_setup_states_before_schedule_mutation",
        lambda **kwargs: events.append(("capture", kwargs)),
    )
    monkeypatch.setattr(
        int_routes.db,
        "purge_orders_by_date",
        lambda start, end: events.append(("purge", start, end)) or {"status": "ok", "deleted": 0},
    )

    response = admin_client.post("/purge", json={"start_date": "not-a-date", "end_date": "2026-09-30"})

    assert response.status_code == 400
    assert response.json()["detail"].startswith("Invalid date range:")
    assert events == []


def test_live_missing_master_data_enforces_allowed_plant_scope(monkeypatch):
    """Live missing-master-data reports must reject an out-of-scope plant
    before reading order/material state."""
    calls = []

    def fail_if_called(plant):
        calls.append(plant)

    brain.api.dependency_overrides[int_routes.require_admin] = lambda: "test-admin"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["ZZTEST_PA"]
    monkeypatch.setattr(int_routes.db, "missing_master_data_for_plant", fail_if_called)
    try:
        response = TestClient(brain.api).get("/master-data/ZZTEST_PB/missing-master-data")
    finally:
        brain.api.dependency_overrides.pop(int_routes.require_admin, None)
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)

    assert response.status_code == 403
    assert "not in your assigned plants" in response.json()["detail"]
    assert calls == []


def test_upload_orders_rejects_oversized_file_with_413(monkeypatch):
    """Orders upload must reject files exceeding NIMBUS_MAX_UPLOAD_BYTES
    with HTTP 413 Payload Too Large, preventing unbounded memory consumption."""
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
