"""SAP mapping and orchestration contracts, with only persistence/transport mocked."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend.integration import sap_sync as sync


@pytest.mark.parametrize("raw, expected", [
    ("1,234.50-", -1234.5), ("1,234.50+", 1234.5),
    (" - 12.75 ", -12.75), ("+12.75", 12.75),
    ("0-", 0), (" ", None), ("not-a-number", None), (None, None),
])
def test_packed_decimal_mapping_supports_sap_signs_and_invalid_values(raw, expected):
    assert sync.apply_transform("decimal", raw) == expected


@pytest.mark.parametrize("raw, expected", [
    (" x ", True), ("yes", True), (1, True), (True, True),
    ("false", False), ("0", False), ("unexpected", False), (None, False),
])
def test_sap_boolean_mapping_has_explicit_true_vocabulary(raw, expected):
    assert sync.apply_transform("bool_x", raw) is expected


def test_unknown_transform_preserves_original_object_and_warns(caplog):
    value = {"opaque": [1, 2]}
    assert sync.apply_transform("retired_transform", value) is value
    assert "Unknown SAP transform" in caplog.text


@pytest.mark.parametrize("object_key, keys", [
    ("materials", {"material_id": None}),
    ("material_plants", {"material_id": None, "plant": None}),
    ("plants", {"subnetwork": None, "plant": None}),
    ("machine", {"subnetwork": None, "plant": None, "machine": None}),
    ("sap_workcenter", {"plant": None, "sap_workcenter": None}),
    ("subnetworks", {"code": None}),
])
def test_empty_master_record_has_all_required_key_columns(object_key, keys):
    assert sync.map_records(object_key, [{}], field_map=[]) == [keys]


def test_mapping_distinguishes_absent_null_and_inactive_fields_without_mutation():
    records = [{"MATNR": "00123", "DESC": None, "HIDDEN": "secret"}, {"MATNR": "00456"}]
    mappings = [
        {"sap_field": "MATNR", "nimbus_column": "material_id", "transform": "alpha_strip"},
        {"sap_field": "DESC", "nimbus_column": "description"},
        {"sap_field": "HIDDEN", "nimbus_column": "hidden", "active": False},
    ]
    original = deepcopy((records, mappings))
    assert sync.map_records("materials", records, mappings) == [
        {"material_id": "123", "description": None}, {"material_id": "456"},
    ]
    assert (records, mappings) == original


def test_mapping_skips_nonrecord_items_but_retains_empty_valid_records():
    assert sync.map_records("orders", [None, 0, "bad", [], {}, {"UNMAPPED": 1}], []) == [{}, {}]


@pytest.fixture
def sync_boundary(monkeypatch):
    """A deterministic external connector; production mapping/dispatch remain real."""
    config = {"transport": "file_drop", "source_params": {}, "last_watermark": "wm-17"}
    connector = SimpleNamespace(extract=Mock(return_value=[{"MATNR": "00042"}]))
    boundary = SimpleNamespace(
        config=Mock(return_value=config), start=Mock(return_value=71), finish=Mock(),
        connector=connector, bulk=Mock(return_value={"inserted": 1, "updated": 0}),
        upsert=Mock(return_value={"inserted": 0, "updated": 1, "failed": 2}),
        capture=Mock(),
    )
    monkeypatch.setattr(sync, "get_config", boundary.config)
    monkeypatch.setattr(sync, "_run_start", boundary.start)
    monkeypatch.setattr(sync, "_run_finish", boundary.finish)
    monkeypatch.setattr(sync, "make_connector", Mock(return_value=connector))
    monkeypatch.setattr(sync, "load_field_map", Mock(return_value=[
        {"sap_field": "MATNR", "nimbus_column": "material_id", "transform": "alpha_strip"},
    ]))
    monkeypatch.setattr(sync.md, "bulk_apply", boundary.bulk)
    monkeypatch.setattr(sync.db, "upsert_orders", boundary.upsert)
    monkeypatch.setattr(sync.setup_data, "capture_setup_states_before_schedule_mutation", boundary.capture)
    return boundary


def test_master_sync_maps_then_writes_with_actor_and_records_exact_counts(sync_boundary):
    b = sync_boundary
    result = sync.sync_object("materials", user_email="planner@example.test")
    assert result == {"object_key": "materials", "status": "ok", "rows_read": 1,
                      "rows_inserted": 1, "rows_updated": 0, "rows_failed": 0, "error": None, "run_id": 71}
    b.connector.extract.assert_called_once_with("materials", since="wm-17")
    b.bulk.assert_called_once_with("materials", {"upserts": [{"material_id": "42"}], "deletes": []},
                                   "planner@example.test")
    b.finish.assert_called_once_with(71, status="ok", rows_read=1, rows_inserted=1,
                                     rows_updated=0, rows_failed=0, watermark_after="wm-17")
    b.capture.assert_not_called()


@pytest.mark.parametrize("object_key", ["materials", "orders"])
def test_dry_run_extracts_and_maps_without_mutating_live_data(sync_boundary, object_key):
    b = sync_boundary
    result = sync.sync_object(object_key, dry_run=True)
    assert result["rows_read"] == 1
    assert result["status"] == "ok"
    b.bulk.assert_not_called()
    b.upsert.assert_not_called()
    b.capture.assert_not_called()
    b.finish.assert_called_once_with(71, status="ok", rows_read=1, watermark_after="wm-17")


def test_empty_extract_does_not_write_or_capture_state(sync_boundary):
    b = sync_boundary
    b.connector.extract.return_value = []
    assert sync.sync_object("orders")["rows_read"] == 0
    b.upsert.assert_not_called()
    b.capture.assert_not_called()
    b.finish.assert_called_once_with(71, status="ok", rows_read=0, watermark_after="wm-17")


@pytest.mark.parametrize("failure_site, expected_reads", [("start", 0), ("extract", 0), ("bulk", 1)])
def test_sync_failures_are_structured_and_preserve_watermark(sync_boundary, failure_site, expected_reads):
    b = sync_boundary
    target = b.connector.extract if failure_site == "extract" else getattr(b, failure_site)
    target.side_effect = RuntimeError("dependency unavailable")
    result = sync.sync_object("materials")
    assert result["status"] == "error"
    assert result["error"] == "RuntimeError: dependency unavailable"
    assert result["rows_read"] == expected_reads
    if failure_site == "start":
        assert result["run_id"] is None
        b.finish.assert_not_called()
        b.connector.extract.assert_not_called()
    else:
        b.finish.assert_called_once_with(71, status="error", rows_read=expected_reads,
                                         error=result["error"], watermark_after="wm-17")


def test_failure_to_record_error_does_not_hide_original_connector_failure(sync_boundary):
    b = sync_boundary
    b.connector.extract.side_effect = ValueError("invalid SAP payload")
    b.finish.side_effect = RuntimeError("audit storage unavailable")
    result = sync.sync_object("materials")
    assert result["status"] == "error"
    assert result["error"] == "ValueError: invalid SAP payload"
    b.bulk.assert_not_called()


def test_order_capture_failure_prevents_schedule_mutation(sync_boundary):
    b = sync_boundary
    b.capture.side_effect = RuntimeError("cannot capture physical state")
    result = sync.sync_object("orders")
    assert result["status"] == "error"
    b.upsert.assert_not_called()


def test_order_sync_preserves_failed_count_and_wires_domain_seams(sync_boundary):
    from backend.distribution import data as distribution
    from backend.routing import resolver

    b = sync_boundary
    events = []
    b.capture.side_effect = lambda **kwargs: events.append("capture")
    b.upsert.side_effect = lambda *args, **kwargs: events.append("write") or {
        "inserted": 2, "updated": 3, "failed": 1,
    }
    result = sync.sync_object("orders", user_email="sap-operator")
    assert events == ["capture", "write"]
    assert (result["rows_inserted"], result["rows_updated"], result["rows_failed"]) == (2, 3, 1)
    kwargs = b.upsert.call_args.kwargs
    assert kwargs["source"] == "sap"
    assert kwargs["raw_row_count"] == 1
    assert kwargs["plan_fn"] is distribution.plan
    assert kwargs["apply_fn"] is distribution.apply
    assert kwargs["resolve_fn"].func is resolver.resolve_orders
    assert kwargs["resolve_fn"].keywords == {"actor": "sap-operator"}
    assert kwargs["actor"] == "sap-operator"
    b.capture.assert_called_once_with(actor="sap-operator", reason="SAP order replacement", plants=None)


@pytest.mark.xfail(strict=True, raises=RuntimeError,
                   reason="sync_object loads get_config outside its error boundary; configuration DB failures escape")
def test_configuration_failure_returns_the_documented_structured_error(sync_boundary):
    sync_boundary.config.side_effect = RuntimeError("configuration storage unavailable")
    result = sync.sync_object("materials")
    assert result["status"] == "error"
    assert result["run_id"] is None
    assert result["error"] == "RuntimeError: configuration storage unavailable"
