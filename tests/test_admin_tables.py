"""
Tests for Workstream E — the read-only, catalog-driven admin table browser
(admin_tables.py + the three GET /admin/tables* routes in brain.py).

Two layers, mirroring the rest of this suite:
  * Pure-logic / route-topology tests (no DB) — the internal-flagging rule,
    the true-read-only source scan (OD-E3), and that all three routes are
    actually gated by require_admin and reject when it fails. These run
    unconditionally, including when .env points at a non-local DB.
  * @pytest.mark.pg tests exercise the real catalog: PK/FK resolution
    (including a composite PK and a composite FK), paginated + filtered row
    listing (meta.total, unmatched-value-is-not-an-error), and the streaming
    CSV export's truncation marker.
"""
import csv
import io
import os
import re
import sys

import pytest
from fastapi.routing import iter_route_contexts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import backend.master_data.browser as at  # noqa: E402
import backend.security.auth as auth  # noqa: E402
import brain  # noqa: E402


# ---------------------------------------------------------------------------
# Pure-logic: internal flagging is a flag, not an exclusion
# ---------------------------------------------------------------------------
def test_internal_flag_marks_known_system_tables():
    assert at._is_internal("schema_migrations")
    assert at._is_internal("admin_audit")
    assert at._is_internal("column_metadata")
    assert at._is_internal("sap_field_map")
    assert at._is_internal("sap_sync_config")
    assert at._is_internal("sap_sync_run")
    assert at._is_internal("sap_stage_batch")


def test_internal_flag_leaves_business_tables_alone():
    for name in ("plants", "orders", "machine", "materials", "material_plants"):
        assert not at._is_internal(name)


# ---------------------------------------------------------------------------
# Pure-logic: OD-E3 — no write/DDL statement anywhere in this module.
# ---------------------------------------------------------------------------
def test_admin_tables_module_never_constructs_a_write_or_ddl_statement():
    """Scans the actual source for SQL verb+continuation phrases a write or
    DDL statement would use. Docstring prose that merely NAMES these verbs
    (e.g. "never an INSERT/UPDATE/DELETE") uses a slash, not the multi-word
    phrases below, so it can't produce a false pass."""
    with open(at.__file__, encoding="utf-8") as f:
        source = f.read()
    forbidden = [
        r"\binsert\s+into\b",
        r"\bupdate\s+\w+\s+set\b",
        r"\bdelete\s+from\b",
        r"\bdrop\s+(table|column|index|schema)\b",
        r"\balter\s+table\b",
        r"\bcreate\s+(table|index|view|schema)\b",
        r"\btruncate\s+table\b",
    ]
    for pattern in forbidden:
        assert not re.search(pattern, source, re.IGNORECASE), f"forbidden SQL pattern found: {pattern}"


def test_export_row_cap_is_the_documented_soft_cap():
    assert at.EXPORT_ROW_CAP == 250_000


# ---------------------------------------------------------------------------
# Pure-logic: filter-list "empty means no filter" semantics
# ---------------------------------------------------------------------------
def test_normalize_filters_drops_empty_value_lists():
    assert at._normalize_filters({"plant": [], "machine": ["L1"]}) == {"machine": ["L1"]}
    assert at._normalize_filters(None) == {}
    assert at._normalize_filters({}) == {}


# ---------------------------------------------------------------------------
# Pure-logic / route-topology: all three routes require_admin, and reject
# the same way when it fails (mirrors the override-to-throw idiom already
# used for /setup/* in tests/test_setup_endpoints.py).
# ---------------------------------------------------------------------------
_ADMIN_TABLE_ROUTE_TEMPLATES = [
    ("GET", "/admin/tables"),
    ("GET", "/admin/tables/{table}"),
    ("GET", "/admin/tables/{table}/export.csv"),
]
_ADMIN_TABLE_CONCRETE_PATHS = [
    ("GET", "/admin/tables"),
    ("GET", "/admin/tables/plants"),
    ("GET", "/admin/tables/plants/export.csv"),
]


@pytest.mark.parametrize("method,path", _ADMIN_TABLE_ROUTE_TEMPLATES)
def test_admin_table_routes_declare_require_admin(method, path):
    # Route objects carry the templated path ("/admin/tables/{table}"), not
    # a concrete resolved one.
    # P5 note: brain.api.routes now holds one _IncludedRouter per domain
    # router — iter_route_contexts() walks those to yield real per-path
    # route contexts (.path/.methods/.dependencies), same helper app.openapi()
    # uses internally.
    route = next(
        r for r in iter_route_contexts(brain.api.routes)
        if getattr(r, "path", None) == path and method in r.methods
    )
    assert any(dep.dependency is brain.require_admin for dep in route.dependencies), (
        f"{method} {path} must be gated by require_admin"
    )


@pytest.mark.parametrize("method,path", _ADMIN_TABLE_CONCRETE_PATHS)
def test_admin_table_routes_reject_when_require_admin_fails(method, path):
    """Same rejection posture as any other require_admin-gated route: when
    the dependency itself denies the caller, the route 403s — independent
    of whatever admin_tables.py would have returned."""
    from starlette.testclient import TestClient

    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    try:
        response = TestClient(brain.api).request(method, path)
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 403


# ---------------------------------------------------------------------------
# require_api_key sweep (2026-09-02) — these routes previously had no
# require_api_key at all (unlike their destructive/DDL siblings that already
# had it). Same negative-test template as
# test_setup_endpoints.py::test_setup_writes_reject_missing_api_key: the
# guard must reject when X-API-Key is missing even though require_admin is
# overridden to succeed.
# ---------------------------------------------------------------------------
_API_KEY_SWEPT_PATHS = [
    ("GET", "/admin/tables"),
    ("GET", "/admin/tables/plants"),
    ("GET", "/admin/tables/plants/export.csv"),
    ("GET", "/master-data/_schema-export"),
]


@pytest.mark.parametrize("method,path", _API_KEY_SWEPT_PATHS)
def test_admin_table_and_schema_export_routes_reject_missing_api_key(monkeypatch, method, path):
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        response = TestClient(brain.api).request(method, path)
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert response.status_code == 401


def test_audit_log_clear_rejects_missing_api_key(monkeypatch):
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        response = TestClient(brain.api).post("/audit/log/clear")
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /security/client-config (2026-09-02) — public/unauthenticated by design,
# so the SPA can learn the current NIMBUS_API_KEY value at boot and echo it
# back as X-API-Key on every subsequent request (see Util.setApiKey/
# fetchTraced in frontend/platform/foundation.mts). Must stay reachable with
# NO headers at all, in both the unset (no-op) and set states.
# ---------------------------------------------------------------------------
def test_client_config_returns_empty_key_when_unset(monkeypatch):
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    response = TestClient(brain.api).get("/security/client-config")
    assert response.status_code == 200
    assert response.json() == {"apiKey": ""}


def test_client_config_returns_the_key_when_set(monkeypatch):
    from starlette.testclient import TestClient

    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    response = TestClient(brain.api).get("/security/client-config")
    assert response.status_code == 200
    assert response.json() == {"apiKey": "required-key"}


# ---------------------------------------------------------------------------
# @pytest.mark.pg — real catalog / real tables
# ---------------------------------------------------------------------------
@pytest.mark.pg
def test_catalog_lists_known_business_tables_and_flags_internal_ones(pg):
    tables = {t["table"]: t for t in at.list_tables()}
    for name in ("plants", "orders", "machine"):
        assert name in tables, f"{name} missing from catalog listing"
        assert tables[name]["internal"] is False
        assert isinstance(tables[name]["approx_row_count"], int)
    for name in ("admin_audit", "schema_migrations"):
        assert tables[name]["internal"] is True


@pytest.mark.pg
def test_pk_and_fk_resolution_for_a_composite_pk_and_fk_table(pg):
    """machine has a 3-column composite PK and 2-column composite FKs to
    plants and sap_workcenter — the classic case where a naive
    key_column_usage/constraint_column_usage join (joined on constraint_name
    alone) would cross-product every referencing column against every
    referenced column instead of pairing them correctly."""
    tables = {t["table"]: t for t in at.list_tables()}
    machine = tables["machine"]
    assert machine["pk_columns"] == ["subnetwork", "plant", "machine"]
    fk_pairs = {(f["column"], f["ref_table"], f["ref_column"]) for f in machine["fk_columns"]}
    assert fk_pairs == {
        ("subnetwork", "plants", "subnetwork"),
        ("plant", "plants", "plant"),
        ("plant", "sap_workcenter", "plant"),
        ("sap_workcenter", "sap_workcenter", "sap_workcenter"),
    }


@pytest.mark.pg
def test_pk_and_fk_resolution_for_material_plants(pg):
    tables = {t["table"]: t for t in at.list_tables()}
    mp = tables["material_plants"]
    assert mp["pk_columns"] == ["material_id", "plant"]
    fk_pairs = {(f["column"], f["ref_table"], f["ref_column"]) for f in mp["fk_columns"]}
    assert ("material_id", "materials", "material_id") in fk_pairs


@pytest.fixture
def zz_plants(pg):
    """Five throwaway `plants` rows under one subnetwork, for pagination /
    filter tests. Cleaned up unconditionally."""
    sub = "ZZADMTBL"
    plant_codes = [f"ZZAT{i}" for i in range(5)]
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, sub))
        for p in plant_codes:
            cur.execute(
                "INSERT INTO plants (subnetwork, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, p)
            )
        conn.commit()
    try:
        yield sub, plant_codes
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM plants WHERE subnetwork = %s", (sub,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            conn.commit()


@pytest.mark.pg
def test_fetch_rows_pagination_reports_full_filtered_total(zz_plants):
    sub, plant_codes = zz_plants
    page1 = at.fetch_rows("plants", limit=2, offset=0, filters={"subnetwork": [sub]})
    page2 = at.fetch_rows("plants", limit=2, offset=2, filters={"subnetwork": [sub]})
    assert page1["meta"]["total"] == 5
    assert page2["meta"]["total"] == 5
    assert len(page1["rows"]) == 2
    assert len(page2["rows"]) == 2
    seen = {r["plant"] for r in page1["rows"]} | {r["plant"] for r in page2["rows"]}
    assert seen.issubset(set(plant_codes))
    assert len(seen) == 4  # two distinct pages, no overlap


@pytest.mark.pg
def test_fetch_rows_multivalue_pk_filter_ignores_unmatched_pasted_value(zz_plants):
    sub, plant_codes = zz_plants
    result = at.fetch_rows(
        "plants", limit=10, offset=0,
        filters={"subnetwork": [sub], "plant": [plant_codes[0], plant_codes[1], "ZZ_DOES_NOT_EXIST"]},
    )
    assert result["meta"]["total"] == 2
    assert {r["plant"] for r in result["rows"]} == {plant_codes[0], plant_codes[1]}


@pytest.mark.pg
def test_fetch_rows_empty_filter_list_means_no_filter_not_match_nothing(zz_plants):
    sub, plant_codes = zz_plants
    with_empty_list = at.fetch_rows("plants", limit=10, offset=0, filters={"subnetwork": [sub], "plant": []})
    assert with_empty_list["meta"]["total"] == 5


@pytest.mark.pg
def test_fetch_rows_column_metadata_flags_pk_and_fk(zz_plants):
    result = at.fetch_rows("plants", limit=1, offset=0)
    by_name = {c["name"]: c for c in result["columns"]}
    assert by_name["subnetwork"]["is_pk"] is True
    assert by_name["subnetwork"]["is_fk"] is True
    assert by_name["subnetwork"]["ref_table"] == "subnetworks"
    assert by_name["plant"]["is_pk"] is True
    assert by_name["plant"]["is_fk"] is False


@pytest.mark.pg
def test_fetch_rows_rejects_unknown_table(pg):
    with pytest.raises(at.UnknownTable):
        at.fetch_rows("not_a_real_table", limit=10, offset=0)


@pytest.mark.pg
def test_fetch_rows_rejects_unknown_filter_column(pg):
    with pytest.raises(at.UnknownColumn):
        at.fetch_rows("plants", limit=10, offset=0, filters={"not_a_real_column": ["x"]})


# ---------------------------------------------------------------------------
# Adversarial injection-shaped names — the allowlist-based validation must
# treat these identically to any other unknown name (UnknownTable/
# UnknownColumn), never attempting to build SQL with them.
# ---------------------------------------------------------------------------
_INJECTION_PAYLOADS = [
    "plants; DROP TABLE orders; --",
    '"><script>alert(1)</script>',
    "plants' OR '1'='1",
]


@pytest.mark.pg
@pytest.mark.parametrize("payload", _INJECTION_PAYLOADS)
def test_fetch_rows_rejects_injection_shaped_table_name(pg, payload):
    with pytest.raises(at.UnknownTable):
        at.fetch_rows(payload, limit=10, offset=0)


@pytest.mark.pg
@pytest.mark.parametrize("payload", _INJECTION_PAYLOADS)
def test_fetch_rows_rejects_injection_shaped_filter_column(pg, payload):
    with pytest.raises(at.UnknownColumn):
        at.fetch_rows("plants", limit=10, offset=0, filters={payload: ["x"]})


@pytest.mark.pg
def test_export_csv_produces_parseable_csv_matching_filtered_rows(zz_plants):
    sub, plant_codes = zz_plants
    chunks = list(at.stream_csv_rows("plants", filters={"subnetwork": [sub]}))
    text = "".join(chunks)
    assert at.TRUNCATION_MARKER_PREFIX not in text  # under the cap -> no marker at all
    assert text.startswith("﻿")  # UTF-8 BOM for Excel (plan Part 1 #8)
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    header[0] = header[0].lstrip("﻿")
    assert "plant" in header
    plant_idx = header.index("plant")
    rows = list(reader)
    assert {r[plant_idx] for r in rows} == set(plant_codes)


@pytest.mark.pg
def test_export_csv_truncates_at_cap_and_signals_resume_offset(zz_plants):
    sub, plant_codes = zz_plants
    chunks = list(at.stream_csv_rows("plants", filters={"subnetwork": [sub]}, offset=0, row_cap=2))
    text = "".join(chunks)
    lines = text.strip("\r\n").splitlines()
    assert lines[-1].startswith(at.TRUNCATION_MARKER_PREFIX)
    match = re.match(r"# NIMBUS_TRUNCATED,resume_offset=(\d+),rows_written=(\d+)", lines[-1])
    assert match is not None
    resume_offset, rows_written = int(match.group(1)), int(match.group(2))
    assert rows_written == 2
    assert resume_offset == 2
    # header + 2 data rows + 1 marker line = 4
    assert len(lines) == 4


@pytest.mark.pg
def test_export_csv_resume_offset_continues_where_it_left_off(zz_plants):
    sub, plant_codes = zz_plants
    first = "".join(at.stream_csv_rows("plants", filters={"subnetwork": [sub]}, offset=0, row_cap=2))
    marker = first.strip().splitlines()[-1]
    resume_offset = int(re.match(r"# NIMBUS_TRUNCATED,resume_offset=(\d+)", marker).group(1))
    second = "".join(at.stream_csv_rows("plants", filters={"subnetwork": [sub]}, offset=resume_offset))
    reader = csv.reader(io.StringIO(second))
    header = next(reader)
    plant_idx = header.index("plant")
    remaining_rows = [r for r in reader if not r[0].startswith(at.TRUNCATION_MARKER_PREFIX)]
    assert len(remaining_rows) == 3  # 5 total, 2 already consumed
    assert {r[plant_idx] for r in remaining_rows}.issubset(set(plant_codes))


@pytest.mark.pg
def test_validate_table_and_filters_raises_before_any_streaming_would_start(pg):
    with pytest.raises(at.UnknownTable):
        at.validate_table_and_filters("not_a_real_table")
    with pytest.raises(at.UnknownColumn):
        at.validate_table_and_filters("plants", {"not_a_real_column": ["x"]})
    # A valid table/filter combination must not raise.
    at.validate_table_and_filters("plants", {"plant": ["anything"]})


# ---------------------------------------------------------------------------
# @pytest.mark.pg — route-level, through FastAPI, with require_admin allowed
# ---------------------------------------------------------------------------
@pytest.fixture
def admin_client(pg):
    from starlette.testclient import TestClient

    brain.api.dependency_overrides[brain.require_admin] = lambda: "admin@example.com"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


@pytest.mark.pg
def test_route_admin_list_tables_shape(admin_client):
    response = admin_client.get("/admin/tables")
    assert response.status_code == 200
    body = response.json()
    assert "tables" in body
    by_name = {t["table"]: t for t in body["tables"]}
    assert "plants" in by_name
    assert set(by_name["plants"].keys()) == {"table", "approx_row_count", "internal", "pk_columns", "fk_columns"}


@pytest.mark.pg
def test_route_admin_table_rows_pagination_and_filter(admin_client, zz_plants):
    sub, plant_codes = zz_plants
    response = admin_client.get(
        "/admin/tables/plants",
        params=[("limit", 2), ("offset", 0), ("subnetwork", sub)],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 5
    assert body["meta"]["limit"] == 2
    assert body["meta"]["offset"] == 0
    assert len(body["rows"]) == 2

    multi = admin_client.get(
        "/admin/tables/plants",
        params=[("subnetwork", sub), ("plant", plant_codes[0]), ("plant", plant_codes[1]),
                ("plant", "ZZ_DOES_NOT_EXIST")],
    )
    assert multi.status_code == 200
    assert multi.json()["meta"]["total"] == 2


@pytest.mark.pg
def test_route_admin_table_rows_unknown_table_is_404(admin_client):
    response = admin_client.get("/admin/tables/not_a_real_table")
    assert response.status_code == 404


@pytest.mark.pg
def test_route_admin_table_rows_unknown_filter_column_is_400(admin_client):
    response = admin_client.get("/admin/tables/plants", params={"not_a_real_column": "x"})
    assert response.status_code == 400


@pytest.mark.pg
def test_route_export_csv_headers_and_body(admin_client, zz_plants):
    sub, plant_codes = zz_plants
    response = admin_client.get("/admin/tables/plants/export.csv", params={"subnetwork": sub})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert "plants.csv" in response.headers["content-disposition"]
    reader = csv.reader(io.StringIO(response.text))
    header = next(reader)
    plant_idx = header.index("plant")
    rows = list(reader)
    assert {r[plant_idx] for r in rows} == set(plant_codes)


@pytest.mark.pg
def test_route_export_csv_unknown_table_is_404_not_a_csv_body(admin_client):
    """404 must come back BEFORE any StreamingResponse is constructed —
    otherwise a bad table name would produce a 200 with an empty/garbled CSV
    body instead of a normal error."""
    response = admin_client.get("/admin/tables/not_a_real_table/export.csv")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


def test_csv_cell_guards_text_formula_leads_only():
    from backend.csv_util import csv_cell, csv_row
    assert csv_cell("=1+1") == "'=1+1"
    assert csv_cell("+SUM(A1)") == "'+SUM(A1)"
    assert csv_cell("-2+3") == "'-2+3"
    assert csv_cell("@x") == "'@x"
    assert csv_cell("	cmd") == "'	cmd"
    assert csv_cell("plain") == "plain"
    assert csv_cell("") == ""
    # numbers (including negatives), None and bools are never touched
    assert csv_row([-5, 3.5, None, True, "ok"]) == [-5, 3.5, None, True, "ok"]


@pytest.mark.pg
def test_export_csv_neutralises_formula_leading_text_cells(zz_plants, pg):
    """Exporter wiring (plan Part 1 #8): stream_csv_rows must pass each row
    through csv_row -- a text cell starting with = + - @ gets a leading '."""
    sub, plant_codes = zz_plants
    payload = "=HYPERLINK(\"http://x\")"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE plants SET timezone = %s WHERE subnetwork = %s AND plant = %s",
                    (payload, sub, plant_codes[0]))
        conn.commit()
    text = "".join(at.stream_csv_rows("plants", filters={"subnetwork": [sub]}))
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = next(reader)
    tz_idx, plant_idx = header.index("timezone"), header.index("plant")
    by_plant = {r[plant_idx]: r[tz_idx] for r in reader}
    assert by_plant[plant_codes[0]] == "'" + payload
