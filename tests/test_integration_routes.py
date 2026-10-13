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

from starlette.testclient import TestClient  # noqa: E402

import backend.integration.routes as int_routes  # noqa: E402
import backend.security.auth as auth  # noqa: E402
import brain  # noqa: E402


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


def test_material_plant_attributes_rejects_missing_api_key_and_anonymous_actor(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    client = TestClient(brain.api)
    payload = {"plant": "PLANT-A", "updates": []}

    assert client.post("/master-data/material-plants/attributes", json=payload).status_code == 401
    assert client.post(
        "/master-data/material-plants/attributes",
        json=payload,
        headers={"x-api-key": "required-key"},
    ).status_code == 401


def test_material_plant_attributes_accepts_authenticated_planner(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    monkeypatch.setattr(auth, "get_user_role", lambda email: "planner" if email == "planner@example.com" else None)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["PLANT-A"]
    monkeypatch.setattr(int_routes.md, "set_material_plant_attributes", lambda **kwargs: {"updated": 0, "columns": []})
    try:
        response = TestClient(brain.api).post(
            "/master-data/material-plants/attributes",
            json={"plant": "PLANT-A", "updates": []},
            headers={"x-api-key": "required-key", "x-user-email": "planner@example.com"},
        )
    finally:
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)
    assert response.status_code == 200


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

    def fake_ingest(raw, filename, diag=None):
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

    def fake_ingest(file_bytes, filename, diag=None):
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


def test_upload_orders_unexpected_failure_logs_traceback_and_stage(admin_client, monkeypatch):
    """An unexpected ingest crash must leave the exception (traceback) and the
    diagnostic context (stage, size, rows) on the backend log entry."""
    def fake_ingest(raw, filename, diag=None):
        diag["stage"] = "upsert_orders"
        diag["rows"] = 7
        raise RuntimeError("boom")

    monkeypatch.setattr(int_routes.setup_data, "capture_setup_states_before_schedule_mutation", lambda **kw: None)
    monkeypatch.setattr(int_routes.db, "ingest_orders_from_excel", fake_ingest)
    from backend.admin_ops.logbuffer import _BACKEND_LOG
    _BACKEND_LOG.clear()
    try:
        admin_client.post("/upload", files={"file": ("bad.xlsx", b"x")})
    except RuntimeError:
        pass  # TestClient re-raises server exceptions by default
    entry = next(e for e in _BACKEND_LOG if e["msg"] == "Orders upload failed")
    assert entry["error_type"] == "RuntimeError" and "boom" in entry["exc"]
    assert entry["ctx"]["stage"] == "upsert_orders" and entry["ctx"]["rows"] == 7
    assert entry["ctx"]["size_bytes"] == 1 and entry["ctx"]["filename"] == "bad.xlsx"


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
    destructive date-range delete and return the delete result. Also pins
    that the capture is now scoped to just the target plant (plants=[plant]),
    matching how /upload already scopes its own capture."""
    events = []

    def fake_capture(**kwargs):
        events.append(("capture", kwargs))

    def fake_purge(plant, start, end, machines=None, *, user_email=None):
        events.append(("purge", {"plant": plant, "start": start.isoformat(), "end": end.isoformat(),
                                  "machines": machines, "user_email": user_email}))
        return {"status": "ok", "deleted": 3, "plant": plant, "machines": list(machines or [])}

    monkeypatch.setattr(int_routes.setup_data, "capture_setup_states_before_schedule_mutation", fake_capture)
    monkeypatch.setattr(int_routes.db, "purge_orders_by_date", fake_purge)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    try:
        response = admin_client.post(
            "/purge",
            json={"plant": "1006", "start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"},
            headers={"x-user-email": "planner@example.com"},
        )
    finally:
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "deleted": 3, "plant": "1006", "machines": []}
    assert [name for name, _ in events] == ["capture", "purge"]
    assert events[0][1] == {"actor": "planner@example.com", "reason": "order purge", "plants": ["1006"]}
    assert events[1][1] == {"plant": "1006", "start": "2026-09-01T00:00:00", "end": "2026-09-30T23:59:59",
                             "machines": None, "user_email": "planner@example.com"}


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
        lambda plant, start, end, machines=None, **kw: events.append(("purge", plant, start, end)) or {"status": "ok", "deleted": 0},
    )

    response = admin_client.post(
        "/purge", json={"plant": "1006", "start_date": "not-a-date", "end_date": "2026-09-30"}
    )

    assert response.status_code == 400
    assert response.json()["detail"].startswith("Invalid date range:")
    assert events == []


def test_purge_requires_plant(admin_client, monkeypatch):
    """A purge with no plant must be rejected before any side effects — this
    is the guard that makes /purge scoped rather than global."""
    events = []
    monkeypatch.setattr(
        int_routes.setup_data,
        "capture_setup_states_before_schedule_mutation",
        lambda **kwargs: events.append(("capture", kwargs)),
    )
    monkeypatch.setattr(
        int_routes.db,
        "purge_orders_by_date",
        lambda plant, start, end, machines=None, **kw: events.append(("purge",)) or {"status": "ok", "deleted": 0},
    )

    response = admin_client.post(
        "/purge", json={"start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "plant is required"
    assert events == []


def test_purge_rejects_inverted_range(admin_client, monkeypatch):
    """start_date after end_date must 400, not silently delete zero rows."""
    events = []
    monkeypatch.setattr(
        int_routes.setup_data,
        "capture_setup_states_before_schedule_mutation",
        lambda **kwargs: events.append(("capture", kwargs)),
    )
    monkeypatch.setattr(
        int_routes.db,
        "purge_orders_by_date",
        lambda plant, start, end, machines=None, **kw: events.append(("purge",)) or {"status": "ok", "deleted": 0},
    )

    response = admin_client.post(
        "/purge",
        json={"plant": "1006", "start_date": "2026-09-30T00:00:00", "end_date": "2026-09-01T00:00:00"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "start_date must be on or before end_date"
    assert events == []


def test_purge_rejects_out_of_scope_plant(admin_client, monkeypatch):
    """A plant outside the caller's role_plants scope must 403 before either
    the setup-state capture or the delete runs — the regression guard for the
    original global-delete vulnerability."""
    events = []
    monkeypatch.setattr(
        int_routes.setup_data,
        "capture_setup_states_before_schedule_mutation",
        lambda **kwargs: events.append(("capture", kwargs)),
    )
    monkeypatch.setattr(
        int_routes.db,
        "purge_orders_by_date",
        lambda plant, start, end, machines=None, **kw: events.append(("purge",)) or {"status": "ok", "deleted": 0},
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["ZZTEST_PA"]
    try:
        response = admin_client.post(
            "/purge",
            json={"plant": "ZZTEST_PB", "start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"},
        )
    finally:
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)

    assert response.status_code == 403
    assert "not in your assigned plants" in response.json()["detail"]
    assert events == []


def test_purge_preview_enforces_allowed_plant_scope(monkeypatch):
    """/purge/preview must apply the same plant-scope guard as /purge —
    otherwise the read-only preview would leak counts for plants the caller
    isn't authorized to purge."""
    calls = []
    brain.api.dependency_overrides[int_routes.require_admin] = lambda: "test-admin"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["ZZTEST_PA"]
    monkeypatch.setattr(int_routes.db, "preview_purge_orders", lambda *a, **kw: calls.append((a, kw)))
    try:
        response = TestClient(brain.api).post(
            "/purge/preview",
            json={"plant": "ZZTEST_PB", "start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"},
        )
    finally:
        brain.api.dependency_overrides.pop(int_routes.require_admin, None)
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)

    assert response.status_code == 403
    assert "not in your assigned plants" in response.json()["detail"]
    assert calls == []


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


_FORMULA_EXCEPTIONS = [{"plant": "=PLANT", "material_number": "+MAT", "order_count": 3, "reason": "-no_mp_row"},
                       {"plant": "@P2", "material_number": "MAT2", "order_count": 1, "reason": "no_mp_row"}]


def _assert_formula_guarded_csv(response):
    import csv
    import io
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows[0] == ["plant", "material_number", "order_count", "reason"]
    assert rows[1] == ["'=PLANT", "'+MAT", "3", "'-no_mp_row"]
    assert rows[2] == ["'@P2", "MAT2", "1", "no_mp_row"]


def test_batch_missing_master_data_csv_is_bom_prefixed_and_formula_guarded(admin_client, monkeypatch):
    """Exporter wiring (plan Part 1 #8) for GET /upload/{batch}/missing-master-data?format=csv."""
    monkeypatch.setattr(int_routes.db, "get_upload_audit_warnings", lambda batch_id: [
        {"category": "missing_master_data", "exceptions": _FORMULA_EXCEPTIONS}])
    _assert_formula_guarded_csv(admin_client.get("/upload/B1/missing-master-data", params={"format": "csv"}))


def test_live_missing_master_data_csv_is_bom_prefixed_and_formula_guarded(monkeypatch):
    """Exporter wiring (plan Part 1 #8) for GET /master-data/{plant}/missing-master-data?format=csv."""
    monkeypatch.setattr(int_routes.db, "missing_master_data_for_plant",
                        lambda plant: {"exceptions": _FORMULA_EXCEPTIONS})
    brain.api.dependency_overrides[int_routes.require_admin] = lambda: "test-admin"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    try:
        response = TestClient(brain.api).get("/master-data/ZZTEST_PA/missing-master-data", params={"format": "csv"})
    finally:
        brain.api.dependency_overrides.pop(int_routes.require_admin, None)
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)
    _assert_formula_guarded_csv(response)


# ---------------------------------------------------------------------------
# SAP staging catalog entries, apply_mode config, alpha_strip transform
# ---------------------------------------------------------------------------
_STAGING_KEYS = ("stage_material_plants", "stage_planned_orders",
                 "stage_production_version", "stage_routing_operation")


@pytest.mark.parametrize("raw, expected", [
    ("000000000012345678", "12345678"),
    ("ABC-001", "ABC-001"),
    (" 12345678.0 ", "12345678"),
    (None, None),
    ("", None),
    ("0000", None),
])
def test_alpha_strip_transform(raw, expected):
    import backend.integration.sap_sync as sap_sync
    assert sap_sync.apply_transform("alpha_strip", raw) == expected


def test_staging_objects_in_catalog():
    import backend.integration.sap_sync as sap_sync
    for key in _STAGING_KEYS:
        meta = sap_sync.SAP_OBJECTS[key]
        assert meta["kind"] == "staging"
        assert meta["stage_table"].startswith("sap_stage_")
        assert meta["live_table"] and meta["key_fields"]
    assert len(sap_sync.SAP_OBJECTS["stage_routing_operation"]["key_fields"]) == 7
    assert "stage_table" not in sap_sync.SAP_OBJECTS["materials"]


def test_map_records_staging_does_not_add_master_keys():
    import backend.integration.sap_sync as sap_sync
    fm = [{"sap_field": "MATNR", "nimbus_column": "material_id", "transform": "alpha_strip"}]
    out = sap_sync.map_records("stage_material_plants", [{"MATNR": "0000012"}], field_map=fm)
    assert out == [{"material_id": "12"}]


def test_sync_object_staging_returns_error_without_run_row(monkeypatch):
    import backend.integration.sap_sync as sap_sync

    def _boom(*_a, **_k):
        raise AssertionError("must not touch the database for a staging object")

    monkeypatch.setattr(sap_sync, "_run_start", _boom)
    monkeypatch.setattr(sap_sync, "get_config", _boom)
    result = sap_sync.sync_object("stage_planned_orders")
    assert result["status"] == "error"
    assert result["error"] == "staging objects are applied via /sap/staging/*"
    assert result["rows_read"] == 0 and result["run_id"] is None


def test_set_config_rejects_bad_apply_mode():
    import backend.integration.sap_sync as sap_sync
    with pytest.raises(ValueError):
        sap_sync.set_config("orders", apply_mode="bogus")


def test_sap_config_route_rejects_bad_apply_mode_with_400(admin_client):
    response = admin_client.post("/sap/interface/config/stage_planned_orders", json={"apply_mode": "bogus"})
    assert response.status_code == 400


def test_sap_objects_lists_staging_keys_with_kind_and_apply_mode(admin_client, monkeypatch):
    import backend.integration.sap_sync as sap_sync
    monkeypatch.setattr(sap_sync, "get_config", lambda key: {"enabled": False, "transport": "file_drop",
                                                              "schedule_cron": None, "apply_mode": "auto"})
    monkeypatch.setattr(sap_sync, "list_runs", lambda **_k: [])
    response = admin_client.get("/sap/interface/objects")
    assert response.status_code == 200
    by_key = {o["object_key"]: o for o in response.json()["objects"]}
    for key in _STAGING_KEYS:
        assert by_key[key]["kind"] == "staging"
        assert by_key[key]["apply_mode"] == "auto"
    assert by_key["orders"]["kind"] == "orders"


# ---------------------------------------------------------------------------
# /sap/staging/* routes -- service functions monkeypatched, no database
# ---------------------------------------------------------------------------
_BID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def stage_client(monkeypatch):
    """Admin caller, unrestricted plant scope, a stub service layer; `calls` records invocations."""
    import backend.integration.sap_staging as ss
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    calls: list = []
    batch = {"batch_id": _BID, "object_key": "stage_planned_orders", "plant": "PL1", "status": "validated",
             "row_counts": {"valid": 2}, "actual_rows": 2}

    def rec(name, ret):
        def f(*a, **k):
            calls.append((name, a, k))
            return ret
        return f

    monkeypatch.setattr(ss, "get_batch", lambda bid: batch if str(bid) == _BID else None)
    monkeypatch.setattr(ss, "list_batches", rec("list_batches", [batch]))
    monkeypatch.setattr(ss, "rejected_rows", rec("rejected_rows", [{"id": 1, "plnum": "=1", "reject_reason": "missing_key"}]))
    monkeypatch.setattr(ss, "held_deletions", rec("held_deletions", [{"id": "o1", "production_order": "1001"}]))
    monkeypatch.setattr(ss, "validate_batch", rec("validate_batch", {"status": "validated"}))
    monkeypatch.setattr(ss, "apply_batch", rec("apply_batch", {"batch_id": _BID, "status": "applied", "counts": {}}))
    monkeypatch.setattr(ss, "discard_batch", rec("discard_batch", {"batch_id": _BID, "status": "discarded"}))
    monkeypatch.setattr(ss, "poll_once", rec("poll_once", {"processed": [], "applied": [], "held": [], "skipped": [], "errors": []}))
    monkeypatch.setattr(ss, "stage_rows_from_upload", rec("stage_rows_from_upload", {"batch_id": _BID, "status": "validated", "rows_staged": 1, "rows_skipped": 0}))
    monkeypatch.setattr(ss, "list_archived", rec("list_archived", [{"id": 7, "production_order": "1001"}]))
    monkeypatch.setattr(ss, "archived_plant", lambda aid: "PL1" if aid == 7 else None)
    monkeypatch.setattr(ss, "restore_archived", rec("restore_archived", {"status": "restored"}))
    monkeypatch.setattr(ss, "queue_send_to_sap", rec("queue_send_to_sap", {"send_batch_id": _BID, "queued": 3, "skipped_no_end": 1, "firmed": 2, "rolled_up_groups": 1}))
    monkeypatch.setattr(ss, "outbound_status", rec("outbound_status", {"ready": 3, "sent": 0, "error": 0, "last_queued_at": None, "last_sent_at": None}))
    monkeypatch.setattr(ss, "outbound_rows", rec("outbound_rows", [{"plnum": "=1001", "row_status": "ready"}]))
    brain.api.dependency_overrides[int_routes.require_admin] = lambda: "test-admin"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    try:
        client = TestClient(brain.api)
        client.calls = calls
        yield client
    finally:
        brain.api.dependency_overrides.pop(int_routes.require_admin, None)
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)


def test_stage_read_routes_return_expected_shapes(stage_client):
    r = stage_client.get("/sap/staging/batches", params={"object": "stage_planned_orders", "plant": "PL1", "limit": 5})
    assert r.status_code == 200 and r.json()["batches"][0]["batch_id"] == _BID
    kw = [c for c in stage_client.calls if c[0] == "list_batches"][0][2]
    assert kw["object_key"] == "stage_planned_orders" and kw["plant"] == "PL1" and kw["limit"] == 5
    assert kw["allowed_plants"] is None
    assert stage_client.get(f"/sap/staging/batches/{_BID}").json()["actual_rows"] == 2
    assert stage_client.get(f"/sap/staging/batches/{_BID}/deletions").json() == {"orders": [{"id": "o1", "production_order": "1001"}]}
    assert stage_client.get("/sap/staging/archive/PL1").json()["orders"][0]["id"] == 7
    assert stage_client.get("/sap/staging/send/PL1/status").json()["ready"] == 3


def test_stage_rejected_json_and_csv(stage_client):
    assert stage_client.get(f"/sap/staging/batches/{_BID}/rejected").json()["rows"][0]["reject_reason"] == "missing_key"
    r = stage_client.get(f"/sap/staging/batches/{_BID}/rejected", params={"format": "csv"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert f"sap-staging-rejected-{_BID}.csv" in r.headers["content-disposition"]
    assert r.content.startswith(b"\xef\xbb\xbf")
    assert "'=1" in r.text           # formula-guarded
    header = r.text.lstrip("﻿").splitlines()[0].split(",")
    assert header[header.index("reject_reason") + 1] == "reject_reason_text"      # human text next to the raw code
    assert "missing_key" in r.text and "A key field is blank." in r.text


def test_stage_unknown_batch_is_404_everywhere(stage_client):
    unknown = "22222222-2222-2222-2222-222222222222"
    for method, path in [("get", f"/sap/staging/batches/{unknown}"), ("get", f"/sap/staging/batches/{unknown}/rejected"),
                         ("get", f"/sap/staging/batches/{unknown}/deletions"),
                         ("post", f"/sap/staging/batches/{unknown}/validate"),
                         ("post", f"/sap/staging/batches/{unknown}/apply"),
                         ("post", f"/sap/staging/batches/{unknown}/discard"),
                         ("post", "/sap/staging/archive/99/restore")]:
        assert getattr(stage_client, method)(path).status_code == 404, path


def test_stage_write_routes_return_service_results(stage_client):
    assert stage_client.post(f"/sap/staging/batches/{_BID}/validate").json() == {"status": "validated"}
    r = stage_client.post(f"/sap/staging/batches/{_BID}/apply", json={"confirm_held": True},
                          headers={"x-user-email": "boss@example.com"})
    assert r.status_code == 200 and r.json()["status"] == "applied"
    name, args, kw = [c for c in stage_client.calls if c[0] == "apply_batch"][0]
    assert kw == {"actor": "boss@example.com", "confirm_held": True}
    assert stage_client.post(f"/sap/staging/batches/{_BID}/discard").json()["status"] == "discarded"
    assert stage_client.post("/sap/staging/poll", headers={"x-user-email": "boss@example.com"}).json()["errors"] == []
    assert [c for c in stage_client.calls if c[0] == "poll_once"][0][2] == {"actor": "boss@example.com"}
    assert stage_client.post("/sap/staging/archive/7/restore").json() == {"status": "restored"}
    sent = stage_client.post("/sap/staging/send/PL1").json()
    assert sent["queued"] == 3 and sent["rolled_up_groups"] == 1
    rows = stage_client.get("/sap/staging/send/PL1/rows", params={"status": "ready"}).json()
    assert rows["rows"][0]["row_status"] == "ready"
    csv_r = stage_client.get("/sap/staging/send/PL1/rows", params={"format": "csv"})
    assert csv_r.status_code == 200 and "sap-send-PL1.csv" in csv_r.headers["content-disposition"]
    assert stage_client.get("/sap/staging/send/PL1/rows", params={"status": "bogus"}).status_code == 400


def test_stage_restore_order_exists_is_409(stage_client, monkeypatch):
    import backend.integration.sap_staging as ss

    def _exists(*_a, **_k):
        raise ValueError("order_exists")
    monkeypatch.setattr(ss, "restore_archived", _exists)
    r = stage_client.post("/sap/staging/archive/7/restore")
    assert r.status_code == 409 and r.json()["detail"] == {"error": "order_exists"}


def test_stage_async_routes_offload_the_batch_lookup(stage_client, monkeypatch):
    """validate/apply/discard are async: the batch header read (pool checkout + query) must go
    through run_in_threadpool, not run on the event loop."""
    offloaded = []
    real = int_routes.run_in_threadpool

    async def _spy(fn, *a, **k):
        offloaded.append(getattr(fn, "__name__", ""))
        return await real(fn, *a, **k)

    monkeypatch.setattr(int_routes, "run_in_threadpool", _spy)
    for action in ("validate", "apply", "discard"):
        offloaded.clear()
        assert stage_client.post(f"/sap/staging/batches/{_BID}/{action}").status_code == 200
        assert "_stage_batch_or_404" in offloaded, action


def test_stage_apply_maps_superseded_and_not_applicable_to_409(stage_client, monkeypatch):
    import backend.integration.sap_staging as ss

    def _superseded(*_a, **_k):
        raise ss.BatchSuperseded("a newer batch exists", {"newer_batch_id": "n1"})

    monkeypatch.setattr(ss, "apply_batch", _superseded)
    r = stage_client.post(f"/sap/staging/batches/{_BID}/apply")
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "superseded" and r.json()["detail"]["newer_batch_id"] == "n1"

    def _held(*_a, **_k):
        raise ss.BatchNotApplicable("needs confirmation", {"code": "held_needs_confirm"})

    monkeypatch.setattr(ss, "apply_batch", _held)
    r = stage_client.post(f"/sap/staging/batches/{_BID}/apply")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "held_needs_confirm"

    def _plain(*_a, **_k):
        raise ss.BatchNotApplicable("not now")

    monkeypatch.setattr(ss, "discard_batch", _plain)
    r = stage_client.post(f"/sap/staging/batches/{_BID}/discard")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_applicable"


def test_stage_upload_ok_400_404_and_413(stage_client, monkeypatch):
    import backend.integration.sap_staging as ss
    files = {"file": ("orders.csv", b"plnum,matnr\n1,2\n")}
    r = stage_client.post("/sap/staging/upload/stage_planned_orders", files=files, data={"plant": "PL1"})
    assert r.status_code == 200 and r.json()["rows_staged"] == 1
    args = [c for c in stage_client.calls if c[0] == "stage_rows_from_upload"][0][1]
    assert args[:2] == ("stage_planned_orders", "PL1")

    assert stage_client.post("/sap/staging/upload/orders", files=files, data={"plant": "PL1"}).status_code == 404

    def _bad(*_a, **_k):
        raise ValueError("The file has no data rows")

    monkeypatch.setattr(ss, "stage_rows_from_upload", _bad)
    r = stage_client.post("/sap/staging/upload/stage_planned_orders", files=files, data={"plant": "PL1"})
    assert r.status_code == 400 and "no data rows" in r.json()["detail"]

    monkeypatch.setattr(int_routes, "NIMBUS_MAX_UPLOAD_BYTES", 10)
    r = stage_client.post("/sap/staging/upload/stage_planned_orders", files={"file": ("big.csv", b"x" * 50)},
                          data={"plant": "PL1"})
    assert r.status_code == 413


def test_stage_routes_enforce_plant_scope(stage_client):
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["OTHER"]
    for method, path in [("get", f"/sap/staging/batches/{_BID}"), ("post", f"/sap/staging/batches/{_BID}/apply"),
                         ("post", "/sap/staging/archive/7/restore"), ("get", "/sap/staging/archive/PL1"),
                         ("post", "/sap/staging/send/PL1"), ("get", "/sap/staging/send/PL1/status"),
                         ("get", "/sap/staging/send/PL1/rows")]:
        assert getattr(stage_client, method)(path).status_code == 403, path
    names = [c[0] for c in stage_client.calls]
    assert "apply_batch" not in names and "queue_send_to_sap" not in names and "restore_archived" not in names


# ---------------------------------------------------------------------------
# Staging poll job on the lifespan scheduler (NIMBUS_SAP_STAGING_POLL_SECONDS)
# ---------------------------------------------------------------------------
def _run_lifespan(monkeypatch, *, poll_seconds, sync_enabled=False):
    """Enter/exit brain.lifespan with every database touch stubbed out; returns
    (job_ids registered on the scheduler, scheduler-was-created)."""
    import asyncio
    from types import SimpleNamespace

    import db as db_mod
    import master_data as md_mod

    for mod in (db_mod, md_mod, auth):
        for name in dir(mod):
            if name.startswith("ensure_"):
                monkeypatch.setattr(mod, name, lambda *a, **k: None)
    monkeypatch.setattr(brain, "_migrate_audit_log", lambda: None)
    monkeypatch.setattr(brain.plcache, "load_priority_lists", lambda: None)
    monkeypatch.setattr(brain.db, "get_health_stats", lambda: {"total_orders": 0, "connected": True})
    monkeypatch.setattr(brain, "SAP_STAGING_POLL_SECONDS", poll_seconds)
    monkeypatch.setattr(brain, "SAP_SYNC_ENABLED", sync_enabled)
    monkeypatch.setattr(brain.sap_sync, "list_enabled_jobs", lambda: [])
    app = SimpleNamespace(state=SimpleNamespace())
    seen = {}

    async def _go():
        async with brain.lifespan(app):
            sched = app.state.sap_scheduler
            seen["created"] = sched is not None
            seen["jobs"] = [j.id for j in sched.get_jobs()] if sched is not None else []

    asyncio.run(_go())
    return seen["jobs"], seen["created"]


def test_lifespan_registers_staging_poll_job_when_interval_set(monkeypatch):
    pytest.importorskip("apscheduler")      # pinned in requirements.txt; absent from some dev venvs
    jobs, created = _run_lifespan(monkeypatch, poll_seconds=30)
    assert created and jobs == ["sap:staging-poll"]


def test_lifespan_has_no_scheduler_when_poll_and_sync_are_off(monkeypatch):
    jobs, created = _run_lifespan(monkeypatch, poll_seconds=0)
    assert not created and jobs == []


@pytest.mark.parametrize("result", [
    {"processed": [], "applied": [], "held": [], "skipped": [], "errors": []},
    {"errors": [{"error": "x"}]},
])
def test_run_sap_staging_poll_offloads_poll_once_and_never_raises(monkeypatch, result):
    import asyncio
    calls = []
    monkeypatch.setattr(brain.sap_staging, "poll_once", lambda **k: calls.append(k) or result)
    asyncio.run(brain._run_sap_staging_poll())
    assert calls == [{"actor": "sap-staging-poll"}]

    def _boom(**_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(brain.sap_staging, "poll_once", _boom)
    asyncio.run(brain._run_sap_staging_poll())     # must not raise
