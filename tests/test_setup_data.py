"""Stage 0 setup-data contracts that do not require a PostgreSQL target."""
from datetime import datetime
import json
from math import inf, nan
import asyncio

import pytest

import backend.setup.data as setup_data


def test_canonical_state_key_preserves_registered_definition_order_and_values():
    """A reordered signature must not silently identify the same transition."""
    assert setup_data.canonical_state_key(
        ["prt01", "colorWheel"], {"colorWheel": " Blue ", "prt01": 12}
    ) == [
        {"fieldKey": "prt01", "value": "12"},
        {"fieldKey": "colorWheel", "value": "BLUE"},
    ]


@pytest.mark.parametrize("raw, folded", [
    ("Black", "BLACK"), (" black ", "BLACK"), ("BLACK", "BLACK"),
    ("Mold-A", "MOLD-A"), (12, "12"),
])
def test_canonical_state_key_uppercases_non_boolean_values(raw, folded):
    """A hand-typed 'Black' and an ingested 'BLACK' must resolve to the same
    canonical JSONB state-key value — the false 'no setup defined' alert this
    fold exists to close."""
    assert setup_data.canonical_state_key(["colorWheel"], {"colorWheel": raw}) == [
        {"fieldKey": "colorWheel", "value": folded},
    ]


@pytest.mark.parametrize("value", [True, False])
def test_canonical_state_key_exempts_booleans_from_the_uppercase_fold(value):
    """Booleans must stay lowercase 'true'/'false' — never reach the uppercase
    branch — matching the TS side's String(true)/String(false)."""
    assert setup_data.canonical_state_key(["colorWheel"], {"colorWheel": value}) == [
        {"fieldKey": "colorWheel", "value": "true" if value else "false"},
    ]


def test_page_matrix_rows_from_key_case_fold_round_trip(monkeypatch):
    """A List-view lookup with a differently-cased from_key (as brain.py's
    json.loads of the raw query string would produce) must resolve to the
    exact same rows as the canonical-uppercase form — the end-to-end
    regression this fold was chasing, not just the fold function in
    isolation."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MatrixRowsCursor()))
    canonical = setup_data.page_matrix_rows("5512", "LINE-1", 4, from_key=_state("GREEN"))
    mixed_case = setup_data.page_matrix_rows(
        "5512", "LINE-1", 4, from_key=[{"fieldKey": "colorWheel", "value": "green"}],
    )
    assert mixed_case["rows"] == canonical["rows"]
    assert mixed_case["meta"]["total"] == 1


def test_derived_order_state_values_are_scoped_to_the_setup_definition():
    """Pre-upload state capture must not submit registered fields the plant did not configure."""
    assert setup_data.derived_order_state_values(
        ["colorWheel", "prt01"], "Blue", "Tool-1", "Mold-2", "0007"
    ) == {"colorWheel": "Blue", "prt01": "Tool-1"}


@pytest.mark.parametrize("fields", [
    ["not_registered"],
    ["colorWheel", "colorWheel"],
])
def test_canonical_state_key_rejects_unknown_or_duplicate_fields(fields):
    """A malformed signature must not be persisted as a key another caller cannot resolve."""
    with pytest.raises(ValueError):
        setup_data.canonical_state_key(fields, {"colorWheel": "RED", "prt01": "M1"})


@pytest.mark.parametrize("value", [-1, 1.5, nan, inf, "4.2", True])
def test_validate_minutes_rejects_non_finite_or_non_integer_values(value):
    """Bad units must not reach the database's seven-day guard as an implicit conversion."""
    with pytest.raises(ValueError):
        setup_data.validate_setup_minutes(value)


def test_validate_minutes_accepts_integer_boundary_and_rejects_more_than_seven_days():
    """The documented upper bound prevents accidental unbounded setup durations."""
    assert setup_data.validate_setup_minutes("10080") == 10080
    with pytest.raises(ValueError):
        setup_data.validate_setup_minutes(10081)


def test_validate_override_minutes_accepts_unbounded_nonnegative_integer():
    """A long-running physical override must not be limited by the matrix's seven-day standard cap."""
    assert setup_data.validate_override_minutes(100_081) == 100_081


@pytest.mark.parametrize("value", [-1, 1.5, nan, inf, "4.2", True])
def test_validate_override_minutes_rejects_non_finite_or_non_integer_values(value):
    """Only finite, whole, nonnegative override duration is meaningful operational truth."""
    with pytest.raises(ValueError):
        setup_data.validate_override_minutes(value)


def test_validate_matrix_rows_rejects_duplicate_canonical_transition():
    """Two spellings of one canonical transition must not make import order decide the duration."""
    fields = ["colorWheel"]
    duplicate_rows = [
        {"from": {"colorWheel": "RED"}, "to": {"colorWheel": "BLUE"}, "setup_min": 10},
        {"from": {"colorWheel": " RED "}, "to": {"colorWheel": "BLUE"}, "setup_min": 15},
    ]
    with pytest.raises(ValueError, match="Duplicate"):
        setup_data.validate_matrix_rows(fields, duplicate_rows)


def test_validate_signature_version_rejects_stale_write():
    """An old editor cannot write rows that look current after a definition change."""
    with pytest.raises(ValueError, match="signature version"):
        setup_data.validate_signature_version(3, 2)


def test_should_replace_derived_state_never_overwrites_newer_manual_or_actual_state():
    """A delayed replacement snapshot cannot erase a more trusted floor confirmation."""
    captured = datetime(2026, 8, 13, 10, 0)
    newer_manual = {"observed_at": datetime(2026, 8, 13, 10, 1), "source": "manual"}
    older_actual = {"observed_at": datetime(2026, 8, 13, 9, 59), "source": "actual"}
    assert not setup_data.should_replace_machine_state(newer_manual, captured, "derived")
    assert not setup_data.should_replace_machine_state(older_actual, captured, "derived")


def test_manual_line_state_requires_a_nonblank_reason_before_database_access(monkeypatch):
    """An unauditable manual floor assertion must be rejected before it can be persisted."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.set_machine_state("5512", "LINE-1", {"colorWheel": "RED"}, 1,
                                  datetime(2026, 8, 13, 10), "manual", " ", "owner@example.com")


def test_override_requires_a_nonblank_reason_before_database_access(monkeypatch):
    """A remaining-duration override is physical truth and must retain its explanation."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.upsert_occurrence_override(
            "5512", "LINE-1", "before", "after", {"colorWheel": "RED"},
            {"colorWheel": "BLUE"}, 12, 100_081, 1, "", "owner@example.com"
        )


def test_initial_override_preserves_an_explicit_null_predecessor(monkeypatch):
    """The first setup transition is bound to no prior order, not to an empty id."""
    cursor = _InitialOverrideCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.upsert_occurrence_override(
        "5512", "LINE-1", None, "after", {"colorWheel": "GREEN"},
        {"colorWheel": "BLUE"}, 12, 4, 1, "initial floor state", "owner@example.com"
    )
    assert result["id"] == 42
    update_sql, _ = cursor.executed[-2]
    insert_sql, insert_params = cursor.executed[-1]
    assert "IS NOT DISTINCT FROM %s" in update_sql
    assert "predecessor_order_id" in insert_sql
    assert insert_params[3] is None


def test_clear_override_requires_nonblank_reason_before_database_access(monkeypatch):
    """Clearing physical setup truth must retain an auditable explanation too."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.clear_occurrence_override("5512", "LINE-1", 7, 1, "owner@example.com", " ")


def test_clear_override_persists_its_reason(monkeypatch):
    """A valid clear records why the remaining-duration override stopped applying."""
    cursor = _ClearCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.clear_occurrence_override(
        "5512", "LINE-1", 7, 1, "owner@example.com", "completed on floor"
    )
    assert result == {"id": 7, "plant": "5512", "machine": "LINE-1", "cleared": True,
                      "signature_version": 1}
    update_sql, update_params = cursor.executed[-1]
    assert "reason = %s" in update_sql
    assert update_params == ("completed on floor", "owner@example.com", 7, "5512", "LINE-1")


def test_public_line_matrix_write_rejects_line_outside_plant(monkeypatch):
    """Sparse line setup values cannot be written under a plant that does not own the line."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MissingLineCursor()))
    with pytest.raises(ValueError, match="does not belong"):
        setup_data.upsert_machine_matrix_rows(
            "5512", "OTHER-PLANT-LINE", [], 1, "owner@example.com"
        )


def test_last_completed_order_excludes_future_planned_work_at_snapshot_time():
    """A pre-replacement snapshot must not treat a future planned order as physical state."""
    at = datetime(2026, 8, 13, 10, 0)
    rows = [
        {"id": "done", "completed_at": datetime(2026, 8, 13, 9, 58), "color": "RED"},
        {"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1), "color": "BLUE"},
    ]
    assert setup_data.last_completed_order(rows, at)["id"] == "done"


def test_failed_ingest_or_purge_snapshot_cannot_advance_from_future_work():
    """Even when the following mutation fails, a snapshot cannot use future planned work."""
    at = datetime(2026, 8, 13, 10, 0)
    assert setup_data.last_completed_order(
        [{"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1)}], at
    ) is None


def test_purge_captures_observation_before_deleting_source_schedule_with_actor(monkeypatch):
    """A purge must preserve only a pre-mutation observation, never schedule-changing
    setup work — exercised via brain's back-compat re-export (brain.purge_orders IS
    backend.integration.routes.purge_orders, same function object) to pin that path
    too, not just the direct backend.integration.routes import used elsewhere.

    Routed through TestClient rather than called as a bare function: the route now
    depends on FastAPI-resolved `allowed_plants` (Depends(...)), which only resolves
    inside a real request lifecycle."""
    import brain
    from starlette.testclient import TestClient
    import backend.security.auth as auth

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))
    monkeypatch.setattr(brain.db, "purge_orders_by_date",
                        lambda plant, start, end, machines=None, **kw: calls.append(("purge", plant, start, end))
                        or {"status": "ok", "deleted": 1, "plant": plant, "machines": []})
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    try:
        response = TestClient(brain.api).post(
            "/purge",
            json={"plant": "1006", "start_date": "2026-08-01", "end_date": "2026-08-02"},
            headers={"x-user-email": "scheduler@example.com"},
        )
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
        brain.api.dependency_overrides.pop(auth.get_allowed_plants_for_request, None)

    assert response.status_code == 200
    assert response.json()["deleted"] == 1
    assert [call[0] for call in calls] == ["snapshot", "purge"]
    assert calls[0][1]["actor"] == "scheduler@example.com"
    assert calls[0][1]["plants"] == ["1006"]


def test_upload_captures_observation_before_ingesting_replacement(monkeypatch):
    """The route's controlled snapshot happens before the threadpool ingest begins, and is
    scoped to whichever plants a read-only pre-parse of the upload found (P1-8 follow-up:
    capture_setup_states_before_schedule_mutation no longer scans every plant on /upload)."""
    import brain
    import backend.integration.routes as integration_routes

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))

    async def fake_threadpool(fn, *args, **kwargs):
        if fn is brain.db.extract_upload_plants:
            calls.append(("extract", args, kwargs))
            return ["P1"]
        if fn is brain.setup_data.capture_setup_states_before_schedule_mutation:
            calls.append(("snapshot", args, kwargs))
            return None
        calls.append(("ingest", args, kwargs))
        return {"status": "ok", "inserted": 1, "updated": 0, "raw_row_count": 1,
                "warnings": [], "lines": []}

    # P5 note: upload_orders now lives in backend/integration/routes.py, which
    # resolves its own bare `run_in_threadpool` name from ITS module globals
    # (a separate `from fastapi.concurrency import run_in_threadpool`), not
    # brain's — so the patch target moved with the function.
    monkeypatch.setattr(integration_routes, "run_in_threadpool", fake_threadpool)
    monkeypatch.setattr(brain.md, "known_plant_line_codes", lambda: {"lines": set()})
    request = type("Request", (), {
        "headers": {"x-user-email": "scheduler@example.com"},
        "state": type("State", (), {})(),
    })()
    upload = type("Upload", (), {"filename": "orders.xlsx", "read": lambda self: _async_bytes(b"xlsx")})()
    result = asyncio.run(brain.upload_orders(request, upload))
    assert result["inserted"] == 1
    assert [call[0] for call in calls] == ["extract", "snapshot", "ingest"]
    assert calls[1][2] == {"actor": "scheduler@example.com", "reason": "Excel upload replacement",
                           "plants": ["P1"]}


def test_extract_upload_plants_reads_plant_column(tmp_path):
    """Read-only pre-parse used to scope the /upload capture seam: finds PLANT/WERKS,
    falls back to None (unscoped) when absent or unparsable, matching
    ingest_orders_from_excel's own WERKS->PLANT normalization."""
    import db

    def _xlsx_bytes(df):
        import io as _io
        buf = _io.BytesIO()
        df.to_excel(buf, index=False)
        return buf.getvalue()

    import pandas as pd

    with_plant = pd.DataFrame({"PLANT": ["P2", "P1", "P1", None], "OTHER": [1, 2, 3, 4]})
    assert db.extract_upload_plants(_xlsx_bytes(with_plant)) == ["P1", "P2"]

    with_werks = pd.DataFrame({"WERKS": ["P3"], "OTHER": [1]})
    assert db.extract_upload_plants(_xlsx_bytes(with_werks)) == ["P3"]

    neither = pd.DataFrame({"OTHER": [1, 2]})
    assert db.extract_upload_plants(_xlsx_bytes(neither)) is None

    assert db.extract_upload_plants(b"not an xlsx file") is None


def test_ingest_orders_from_excel_normalizes_plant_and_flags_defaulted_run_time(monkeypatch):
    """D24: PLANT must come through db._str_id (same normalization as
    production_order/material_number) so a numeric or float-typed Excel cell
    lands as a plain string, not a raw int/float/np.float64. D54: a blank
    RUN_TIME cell must be flagged via `_run_time_was_defaulted` BEFORE db.py's
    own RUN_TIME->1.0 fallback overwrites the original absence — this is the
    row key backend/distribution/data.py's _extract_parent_facts already
    reads, previously never set by any ingest call site."""
    import io

    import pandas as pd

    import db

    captured_rows = []

    def _fake_upsert_orders(rows, **kwargs):
        captured_rows.append(rows)
        return {"status": "ok", "batch_id": kwargs.get("batch_id"),
                "inserted": len(rows), "updated": 0, "warnings": [], "lines": []}

    monkeypatch.setattr(db, "upsert_orders", _fake_upsert_orders)

    def _xlsx_bytes(df):
        buf = io.BytesIO()
        df.to_excel(buf, index=False)
        return buf.getvalue()

    # First upload: a plain integer PLANT cell (no NaN in the column, so
    # pandas/openpyxl round-trip it as a Python int) together with a filled
    # RUN_TIME.
    int_plant_df = pd.DataFrame({
        "PRODUCTION_ORDER": ["PO-1"],
        "MATERIAL_NUMBER": ["MAT-1"],
        "BASIC_START_DATE": pd.to_datetime(["2026-01-01"]),
        "PLANT": [1000],
        "RUN_TIME": [5.0],
    })
    result = db.ingest_orders_from_excel(_xlsx_bytes(int_plant_df), "int_plant.xlsx")
    assert result["status"] == "ok"
    row = captured_rows[-1][0]
    assert row["plant"] == "1000"
    assert row["_run_time_was_defaulted"] is False

    # Second upload: a genuinely float-typed PLANT column (forced by a NaN
    # elsewhere in the same column) plus one row with a blank RUN_TIME.
    float_plant_df = pd.DataFrame({
        "PRODUCTION_ORDER": ["PO-2", "PO-3"],
        "MATERIAL_NUMBER": ["MAT-2", "MAT-3"],
        "BASIC_START_DATE": pd.to_datetime(["2026-01-02", "2026-01-03"]),
        "PLANT": [1000.0, None],
        "RUN_TIME": [None, 3.0],
    })
    result = db.ingest_orders_from_excel(_xlsx_bytes(float_plant_df), "float_plant.xlsx")
    assert result["status"] == "ok"
    rows = captured_rows[-1]
    assert isinstance(float_plant_df["PLANT"][0], float)  # sanity: genuinely float, not int
    assert rows[0]["plant"] == "1000"
    assert rows[0]["_run_time_was_defaulted"] is True
    assert rows[1]["plant"] is None
    assert rows[1]["_run_time_was_defaulted"] is False


async def _async_bytes(value):
    return value


def test_sap_sync_captures_observation_before_upserting_orders(monkeypatch):
    """SAP replacement shares the exact controlled snapshot boundary as Excel ingest."""
    import backend.integration.sap_sync as sap_sync

    calls = []
    monkeypatch.setattr(sap_sync.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))
    monkeypatch.setattr(sap_sync, "get_config", lambda _: {"transport": "file_drop", "last_watermark": None})
    monkeypatch.setattr(sap_sync, "_run_start", lambda *args: 1)
    monkeypatch.setattr(sap_sync, "_run_finish", lambda *args, **kwargs: None)
    monkeypatch.setattr(sap_sync, "map_records", lambda _key, records: records)
    monkeypatch.setattr(sap_sync, "make_connector", lambda *_: type(
        "Connector", (), {"extract": lambda self, *_args, **_kwargs: [{"id": "order-1"}]}
    )())
    monkeypatch.setattr(sap_sync.db, "upsert_orders", lambda *args, **kwargs: calls.append(("upsert", args)) or {
        "inserted": 1, "updated": 0, "failed": 0
    })
    result = sap_sync.sync_object("orders", user_email="scheduler@example.com")
    assert result["status"] == "ok"
    assert [call[0] for call in calls] == ["snapshot", "upsert"]


def test_definition_edit_versions_and_deactivates_without_rewriting_prior_matrix_keys(monkeypatch):
    """Changing a signature invalidates old keys instead of corrupting their historical meaning."""
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    saved = setup_data.save_definition(
        "5512", ["prt01", "colorWheel"], True, "owner@example.com", expected_signature_version=2
    )
    assert saved == {
        "plant": "5512", "fields": ["prt01", "colorWheel"], "signature_version": 3,
        "strict_blanks": True, "active": False,
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "UPDATE setup_definition" in statements
    assert "signature_version = %s" in statements
    assert "DELETE FROM setup_matrix" not in statements
    assert "UPDATE setup_matrix" not in statements


def test_set_definition_active_toggles_without_touching_fields(monkeypatch):
    """The single 'Include Setup Times in Optimizer' checkbox flips one column only."""
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.set_definition_active("5512", True, "owner@example.com", expected_signature_version=2)
    assert result == {
        "plant": "5512", "fields": ["colorWheel"], "signature_version": 2,
        "strict_blanks": True, "active": True,
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "UPDATE setup_definition" in statements
    assert "SET active = %s" in statements


def test_set_definition_active_rejects_stale_signature_version(monkeypatch):
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="signature version"):
        setup_data.set_definition_active("5512", True, "owner@example.com", expected_signature_version=1)


def test_snapshot_reads_only_one_current_signature_version_in_a_repeatable_transaction(monkeypatch):
    """A setup hydration never combines historical rows with a newer definition's effective truth."""
    cursor = _SnapshotCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    snapshot = setup_data.get_setup_snapshot("5512")
    assert snapshot["definition"]["signature_version"] == 4
    assert snapshot["plant_rows"][0]["signature_version"] == 4
    assert snapshot["machine_states"][0]["signature_version"] == 4
    assert snapshot["overrides"][0]["signature_version"] == 4
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "REPEATABLE READ READ ONLY" in statements
    assert statements.count("signature_version = %s") >= 3
    assert "status IN ('active', 'inactive')" in statements


def test_snapshot_scopes_machine_rows_states_and_overrides_to_the_live_machine_roster(monkeypatch):
    """machine_rows/machine_states/overrides must be bounded to the plant's live
    machine set (Code_Review_09_01.md P1-9) -- plant_rows (machine = '') stay
    unscoped, since they're the single fallback tier every machine inherits from."""
    cursor = _SnapshotCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    setup_data.get_setup_snapshot("5512")
    statements = [sql for sql, _params in cursor.executed]
    live_machine_query = next(sql for sql in statements if "SELECT machine FROM machine" in sql)
    assert "UNION" in live_machine_query
    assert "FROM orders" in live_machine_query

    matrix_query, matrix_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM setup_matrix" in sql
    )
    assert "machine = '' OR machine = ANY(%s)" in matrix_query
    assert matrix_params[-1] == ["LINE-1"]

    states_query, states_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM machine_setup_state" in sql
    )
    assert "machine = ANY(%s)" in states_query
    assert states_params[-1] == ["LINE-1"]

    overrides_query, overrides_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM setup_occurrence_override" in sql
    )
    assert "machine = ANY(%s)" in overrides_query
    assert overrides_params[-1] == ["LINE-1"]


def test_snapshot_with_empty_live_machine_roster_keeps_plant_rows_and_empties_machine_rows(monkeypatch):
    """When the live-machine-set query returns zero rows (e.g. a plant with no
    registered machines and no orders yet), plant_rows -- the single
    plant-default fallback tier, unscoped by live_machines -- must still come
    back populated from setup_matrix, while machine_rows/machine_states/
    overrides (all scoped by the empty live_machines list) come back empty."""
    cursor = _EmptyRosterSnapshotCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    snapshot = setup_data.get_setup_snapshot("5512")
    assert snapshot["plant_rows"] != []
    assert snapshot["plant_rows"][0]["machine"] == ""
    assert snapshot["machine_rows"] == []
    assert snapshot["machine_states"] == []
    assert snapshot["overrides"] == []

    matrix_query, matrix_params = next(
        (sql, params) for sql, params in cursor.executed if "FROM setup_matrix" in sql
    )
    assert matrix_params[-1] == []


def test_identified_override_update_rejects_cleared_history_before_writing(monkeypatch):
    """A URL-bound override update cannot resurrect or alter cleared/replaced historical truth."""
    cursor = _InactiveOverrideCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="not active"):
        setup_data.update_occurrence_override(
            "5512", "LINE-1", 7, 12, 4, 1, "confirmed work", "owner@example.com"
        )
    assert not any("UPDATE setup_occurrence_override" in sql for sql, _params in cursor.executed)


def test_capture_coordinator_forwards_one_plant_local_timestamp_to_every_line(monkeypatch):
    """A plant replacement snapshot is one instant shared by every line at that plant."""
    cursor = _PairsCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    calls = []
    monkeypatch.setattr(setup_data, "derive_machine_state_before_replacement",
                        lambda plant, line, **kwargs: calls.append((plant, line, kwargs)) or {})
    setup_data.capture_setup_states_before_schedule_mutation(actor="system", reason="purge")
    assert [(plant, line) for plant, line, _kwargs in calls] == [("5512", "LINE-1"), ("5512", "LINE-2")]
    first_capture = calls[0][2]["captured_at"]
    assert first_capture == calls[1][2]["captured_at"]
    assert first_capture.tzinfo is None
    assert all(kwargs["actor"] == "system" and kwargs["reason"] == "purge" for _, _, kwargs in calls)
    query, _params = cursor.executed[0]
    assert "JOIN machine" in query


def test_page_matrix_rows_lets_a_line_override_replace_the_plant_default(monkeypatch):
    """One effective row per pair — the line's value wins, and the plant default
    it displaced is still reported as `plant_value` so the UI can offer a revert."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MatrixRowsCursor()))
    page = setup_data.page_matrix_rows("5512", "LINE-1", 4)
    blue_red = [r for r in page["rows"] if r["from_key"] == _state("BLUE") and r["to_key"] == _state("RED")]
    assert len(blue_red) == 1, "the plant default and its line override must merge into one row"
    assert blue_red[0]["setup_min"] == 35
    assert blue_red[0]["plant_value"] == 30
    assert blue_red[0]["inherited"] is False
    # LINE-2's row is another line's override and must never leak into this scope.
    assert all(r["setup_min"] != 99 for r in page["rows"])


def test_page_matrix_rows_marks_a_plant_default_as_inherited_only_in_line_scope(monkeypatch):
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MatrixRowsCursor()))
    line_page = setup_data.page_matrix_rows("5512", "LINE-1", 4)
    plant_page = setup_data.page_matrix_rows("5512", "", 4)
    line_default = next(r for r in line_page["rows"] if r["to_key"] == _state("WHITE"))
    plant_default = next(r for r in plant_page["rows"] if r["to_key"] == _state("WHITE"))
    assert line_default["inherited"] is True
    assert plant_default["inherited"] is False


def test_page_matrix_rows_reports_null_plant_value_for_an_override_with_no_default(monkeypatch):
    """A line override on a pair the plant has no default for keeps its own
    setup_min and a null plant_value — the case the List view's
    "hide states with no value" filter must not treat as valueless."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MatrixRowsCursor()))
    page = setup_data.page_matrix_rows("5512", "LINE-1", 4)
    green_red = next(r for r in page["rows"] if r["from_key"] == _state("GREEN"))
    assert green_red["setup_min"] == 55
    assert green_red["plant_value"] is None
    assert green_red["inherited"] is False


def test_page_matrix_rows_filters_by_from_key(monkeypatch):
    """The from-state scope is pushed into the SQL WHERE, so only that
    from-state's pairs come back."""
    cursor = _MatrixRowsCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    page = setup_data.page_matrix_rows("5512", "LINE-1", 4, from_key=_state("GREEN"))
    assert "from_key = %s" in cursor.executed[-1][0]
    assert [r["to_key"] for r in page["rows"]] == [_state("RED")]
    assert page["meta"]["total"] == 1


def test_page_matrix_rows_pages_over_the_post_merge_effective_rows(monkeypatch):
    """`meta.total` counts merged effective rows, not the raw pre-merge SQL rows
    (4 raw rows in this line's scope collapse to 3 effective pairs), and
    offset/limit slice that same merged list."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MatrixRowsCursor()))
    full = setup_data.page_matrix_rows("5512", "LINE-1", 4)
    assert full["meta"]["total"] == 3
    assert len(full["rows"]) == 3
    first = setup_data.page_matrix_rows("5512", "LINE-1", 4, limit=2)
    second = setup_data.page_matrix_rows("5512", "LINE-1", 4, offset=2, limit=2)
    assert first["rows"] == full["rows"][:2]
    assert second["rows"] == full["rows"][2:]
    assert first["meta"] == {"total": 3, "offset": 0, "limit": 2}
    assert second["meta"] == {"total": 3, "offset": 2, "limit": 2}


@pytest.mark.parametrize("kwargs", [{"offset": -1}, {"limit": 0}, {"limit": 501}, {"limit": True}])
def test_page_matrix_rows_rejects_out_of_range_paging(monkeypatch, kwargs):
    """Paging bounds are validated before any connection is opened."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError):
        setup_data.page_matrix_rows("5512", "LINE-1", 4, **kwargs)


class _DefinitionCursor:
    def __init__(self):
        self.executed = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchone(self):
        return (["colorWheel"], 2, True, True)


class _InitialOverrideCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT 1 FROM machine" in query:
            return (1,)
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, True)
        if "RETURNING id" in query:
            return (42,)
        return None


class _PairsCursor(_DefinitionCursor):
    def fetchall(self):
        return [("5512", "America/New_York", "LINE-1"), ("5512", "America/New_York", "LINE-2")]


class _SnapshotCursor(_DefinitionCursor):
    def fetchone(self):
        if "md5(" in self.executed[-1][0]:
            return ("tok-snapshot",)
        if "SELECT fields" in self.executed[-1][0]:
            return (["colorWheel"], 4, True, False)
        return None

    def fetchall(self):
        query = self.executed[-1][0]
        if "SELECT machine FROM machine" in query:
            return [("LINE-1",)]
        if "FROM setup_matrix" in query:
            return [("", 4, [], [], 12, "manual", {}, None, "owner", None, "owner", None)]
        if "FROM machine_setup_state" in query:
            return [("LINE-1", [], 4, None, None, "manual", "floor", "owner", None, "owner", None)]
        if "FROM setup_occurrence_override" in query:
            return [(9, "LINE-1", 4, "before", "after", [], [], 12, 4, "active", "floor", "owner", None,
                     "owner", None)]
        return []


class _EmptyRosterSnapshotCursor(_SnapshotCursor):
    """Same canned definition/matrix truth as _SnapshotCursor, but the
    live-machine-set query returns zero rows -- proving plant_rows (unscoped)
    survives while the machine-scoped tables come back empty."""

    def fetchall(self):
        query = self.executed[-1][0]
        if "SELECT machine FROM machine" in query:
            return []
        if "FROM setup_matrix" in query:
            return [("", 4, [], [], 12, "manual", {}, None, "owner", None, "owner", None)]
        if "FROM machine_setup_state" in query:
            return []
        if "FROM setup_occurrence_override" in query:
            return []
        return []


class _InactiveOverrideCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT 1 FROM machine" in query:
            return (1,)
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, False)
        if "SELECT signature_version, status FROM setup_occurrence_override" in query:
            return (1, "cleared")
        return None


class _MissingLineCursor(_DefinitionCursor):
    def fetchone(self):
        return None


class _ClearCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, True)
        return (1,)

    def execute(self, sql, params=()):
        super().execute(sql, params)
        if "UPDATE setup_occurrence_override" in sql:
            self.rowcount = 1


class _FailPool:
    def connection(self):
        raise AssertionError("validation should reject before opening a database connection")


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self._cursor

    def commit(self):
        return None


class _Pool:
    def __init__(self, cursor):
        self._cursor = cursor

    def connection(self):
        return _Connection(self._cursor)


def _state(value):
    return [{"fieldKey": "colorWheel", "value": value}]


class _MatrixRowsCursor(_DefinitionCursor):
    """Serves `page_matrix_rows`' one setup_matrix SELECT from a fixed row set,
    applying the same `machine IN ('', %s)` / `from_key = %s` narrowing the SQL
    does so the merge under test sees a realistic raw result."""

    #      machine    from      to        min  source
    ROWS = [
        ("",       _state("BLUE"),  _state("RED"),   30, "manual"),
        ("",       _state("BLUE"),  _state("WHITE"), 40, "manual"),
        ("LINE-1", _state("BLUE"),  _state("RED"),   35, "manual"),
        ("LINE-1", _state("GREEN"), _state("RED"),   55, "manual"),
        ("LINE-2", _state("BLUE"),  _state("RED"),   99, "manual"),
    ]

    def fetchone(self):
        return (["colorWheel"], 4, True, True)

    def fetchall(self):
        sql, params = self.executed[-1]
        assert "FROM setup_matrix" in sql
        line = params[2]
        rows = [r for r in self.ROWS if r[0] in ("", line)]
        if "from_key = %s" in sql:
            wanted = params[3].obj if hasattr(params[3], "obj") else params[3]
            rows = [r for r in rows if r[1] == wanted]
        # Mirror the query's ORDER BY from_key, to_key, machine DESC.
        return sorted(rows, key=lambda r: (json.dumps(r[1]), json.dumps(r[2]), r[0]), reverse=False)


class _TokenCursor(_DefinitionCursor):
    """Definition + a canned plant-matrix content-hash token."""
    token = "tok-live"

    def fetchone(self):
        if "md5(" in self.executed[-1][0]:
            return (self.token,)
        return super().fetchone()


def test_snapshot_returns_the_plant_matrix_token(monkeypatch):
    monkeypatch.setattr(setup_data, "_pool", _Pool(_SnapshotCursor()))
    assert setup_data.get_setup_snapshot("5512")["plant_matrix_token"] == "tok-snapshot"


def test_replace_plant_matrix_requires_a_token(monkeypatch):
    """Plan Part 2 #20: no token, no delete-then-insert replace."""
    cursor = _TokenCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="token is required"):
        setup_data.replace_plant_matrix("5512", [], 2, "owner@example.com")
    assert not any("DELETE FROM setup_matrix" in sql for sql, _ in cursor.executed)


def test_replace_plant_matrix_rejects_a_stale_token_before_deleting(monkeypatch):
    cursor = _TokenCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="is stale"):
        setup_data.replace_plant_matrix("5512", [], 2, "owner@example.com", expected_token="tok-old")
    assert not any("DELETE FROM setup_matrix" in sql for sql, _ in cursor.executed)


def test_replace_plant_matrix_with_the_current_token_replaces_and_returns_a_new_token(monkeypatch):
    cursor = _TokenCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.replace_plant_matrix("5512", [], 2, "owner@example.com", expected_token="tok-live")
    assert result["plant_matrix_token"] == "tok-live" and result["rows"] == 0
    assert any("DELETE FROM setup_matrix" in sql for sql, _ in cursor.executed)


@pytest.mark.pg
def test_plant_matrix_token_sql_runs_and_is_stable_on_a_real_db(pg):
    import hashlib
    with pg._pool.connection() as conn, conn.cursor() as cur:
        token = setup_data.plant_matrix_token(cur, "ZZTEST_NO_SUCH_PLANT", 1)
    assert token == hashlib.md5(b"").hexdigest()
