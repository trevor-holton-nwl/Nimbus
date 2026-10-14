"""Regression coverage for backend/routing/ingest.py's Excel parsers
(ROUTING_RUNTIME_DESIGN.md §6.1/§10).

No live Postgres needed: `parse_production_versions_upload`/
`parse_routing_operations_upload` both accept a `conn=` kwarg used for their
one reference-lookup round trip (known plants / material_plants /
sap_workcenter), so a fake connection+cursor is passed directly instead of
monkeypatching `db._pool` -- same fake-cursor spirit as
tests/test_master_data.py, adapted for the three SELECTs this module issues
per parse call (one per reference table) rather than an upsert executemany().

Inputs are genuine `.xlsx` bytes (built via pandas `to_excel`/`read_excel`,
matching exactly what `ingest._read_excel` expects), not pre-parsed dicts --
this also naturally reproduces Excel's own numeric coercion (a numeric-
looking string or whole-number cell round-trips as a float), which is the
real-world trigger for the zero-padding and `db._str_id` stripping this file
covers.
"""
from contextlib import contextmanager
import io

import pandas as pd
import pytest

import backend.routing.ingest as ingest


# ---------------------------------------------------------------------------
# Fake DB plumbing
# ---------------------------------------------------------------------------
class _FakeCursor:
    """Answers the three SELECTs `_known_plants`/`_known_material_plants`/
    `_known_workcenters` issue, from three pre-seeded "known to NIMBUS" sets.
    Dispatches on a substring of the SQL text rather than tracking call order,
    since a single parse call issues exactly one of each."""

    def __init__(self, known_plants=frozenset(), known_mp=frozenset(), known_wc=frozenset()):
        self.known_plants = known_plants
        self.known_mp = known_mp
        self.known_wc = known_wc
        self.queries = []
        self._result = []

    def execute(self, statement, params=None):
        stmt = str(statement)
        self.queries.append((stmt, params))
        if "FROM plants" in stmt:
            (wanted,) = params
            self._result = [(p,) for p in self.known_plants if p in wanted]
        elif "FROM material_plants" in stmt:
            plant_list, material_list = params
            wanted = set(zip(plant_list, material_list, strict=True))
            self._result = [(p, m) for (p, m) in self.known_mp if (p, m) in wanted]
        elif "FROM sap_workcenter" in stmt:
            plant_list, wc_list = params
            wanted = set(zip(plant_list, wc_list, strict=True))
            self._result = [(p, w) for (p, w) in self.known_wc if (p, w) in wanted]
        else:
            self._result = []

    def fetchall(self):
        return self._result


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    @contextmanager
    def cursor(self):
        yield self._cursor


def _fake_conn(known_plants=(), known_mp=(), known_wc=()):
    return _FakeConnection(_FakeCursor(
        known_plants=frozenset(known_plants),
        known_mp=frozenset(known_mp),
        known_wc=frozenset(known_wc),
    ))


def _xlsx_bytes(rows: list[dict]) -> bytes:
    """Build genuine `.xlsx` bytes from a list of header->value dict rows,
    the same shape `ingest._read_excel` (`pd.read_excel` + `db.clean`)
    expects. Every row must share the same set of headers."""
    df = pd.DataFrame(rows)
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    return buf.getvalue()


def _reject_msgs(warnings):
    return [w["msg"] for w in warnings if w["level"] == "reject"]


def _warn_msgs(warnings):
    return [w["msg"] for w in warnings if w["level"] == "warn"]


# ---------------------------------------------------------------------------
# 1. Header mapping/normalization (db.clean())
# ---------------------------------------------------------------------------
def test_production_version_headers_normalized_case_and_spaces():
    """Lowercase headers, and one with embedded spaces, must still map --
    db.clean() upper-cases and turns spaces into underscores before matching
    against PRODUCTION_VERSION_HEADERS."""
    file_bytes = _xlsx_bytes([
        {"plant": "5512", "material_id": "1000261702", "production version": 7},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    assert _reject_msgs(warnings) == []
    assert len(result["upserts"]) == 1
    row = result["upserts"][0]
    assert row["plant"] == "5512"
    assert row["material_id"] == "1000261702"
    assert row["production_version"] == "0007"


# ---------------------------------------------------------------------------
# 2. Zero-padding of key fields
# ---------------------------------------------------------------------------
def test_production_version_and_group_counter_zero_padded():
    """production_version pads to width 4, group_counter to width 2 -- exact
    widths pinned from ingest.py's PRODUCTION_VERSION_ZERO_PAD."""
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 1,
         "GROUP_COUNTER": 1},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    assert _reject_msgs(warnings) == []
    row = result["upserts"][0]
    assert row["production_version"] == "0001"
    assert row["group_counter"] == "01"


def test_routing_operation_activity_sequence_group_counter_zero_padded():
    """activity pads to width 4, sequence_no to width 6, group_counter to
    width 2 -- exact widths pinned from ingest.py's ROUTING_OPERATION_ZERO_PAD."""
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "TASK_LIST_TYPE": "N",
         "ROUTING_GROUP": "50001234", "GROUP_COUNTER": 1, "SEQUENCE_NO": 10,
         "ACTIVITY": 5},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    groups, warnings = ingest.parse_routing_operations_upload(file_bytes, conn=conn)

    assert _reject_msgs(warnings) == []
    assert len(groups) == 1
    ((row,),) = groups.values()
    assert row["group_counter"] == "01"
    assert row["sequence_no"] == "000010"
    assert row["activity"] == "0005"


# ---------------------------------------------------------------------------
# 3. Material ID normalization via db._str_id
# ---------------------------------------------------------------------------
def test_material_id_strips_excel_float_suffix():
    """A material id that round-trips through Excel as a numeric-looking
    cell ('1000261702.0') must be normalized via db._str_id to
    '1000261702' -- matching how it's stored in material_plants."""
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702.0", "PRODUCTION_VERSION": 1},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    assert _reject_msgs(warnings) == []
    assert result["upserts"][0]["material_id"] == "1000261702"


# ---------------------------------------------------------------------------
# 4. Row rejection for unknown plant / material / SAP work center
# ---------------------------------------------------------------------------
def test_unknown_plant_material_and_workcenter_each_rejected():
    file_bytes = _xlsx_bytes([
        {"PLANT": "9999", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 1,
         "SAP_WORKCENTER": "MOLD01"},                                            # unknown plant
        {"PLANT": "5512", "MATERIAL_ID": "2000000000", "PRODUCTION_VERSION": 2,
         "SAP_WORKCENTER": "MOLD01"},                                            # unknown material
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 3,
         "SAP_WORKCENTER": "UNKNOWNWC"},                                         # unknown workcenter
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 4,
         "SAP_WORKCENTER": "MOLD01"},                                            # valid
    ])
    conn = _fake_conn(
        known_plants={"5512"},
        known_mp={("5512", "1000261702")},
        known_wc={("5512", "MOLD01")},
    )

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    reasons = _reject_msgs(warnings)
    assert any(r.startswith("unknown_plant:") for r in reasons)
    assert any(r.startswith("unknown_material:") for r in reasons)
    assert any(r.startswith("unknown_workcenter:") for r in reasons)
    assert len(result["upserts"]) == 1
    assert result["upserts"][0]["production_version"] == "0004"


# ---------------------------------------------------------------------------
# 5. Duplicate-key-within-file rejection
# ---------------------------------------------------------------------------
def test_duplicate_key_within_file_rejected_keeps_first():
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 1,
         "PRODUCTION_VERSION_TEXT": "first"},
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 1,
         "PRODUCTION_VERSION_TEXT": "second-duplicate"},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    assert any(r.startswith("duplicate_key:") for r in _reject_msgs(warnings))
    assert len(result["upserts"]) == 1
    assert result["upserts"][0]["production_version_text"] == "first"


def test_routing_operation_duplicate_full_key_rejected():
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "TASK_LIST_TYPE": "N",
         "ROUTING_GROUP": "50001234", "GROUP_COUNTER": 1, "SEQUENCE_NO": 10,
         "ACTIVITY": 5},
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "TASK_LIST_TYPE": "N",
         "ROUTING_GROUP": "50001234", "GROUP_COUNTER": 1, "SEQUENCE_NO": 10,
         "ACTIVITY": 5},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    groups, warnings = ingest.parse_routing_operations_upload(file_bytes, conn=conn)

    assert any(r.startswith("duplicate_key:") for r in _reject_msgs(warnings))
    total_rows = sum(len(rows) for rows in groups.values())
    assert total_rows == 1


# ---------------------------------------------------------------------------
# 6. DELETED-flagged routing_operation row: skipped, never stored, never
#    counted as rejected
# ---------------------------------------------------------------------------
def test_routing_operation_deleted_row_skipped_not_rejected():
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "TASK_LIST_TYPE": "N",
         "ROUTING_GROUP": "50001234", "GROUP_COUNTER": 1, "SEQUENCE_NO": 10,
         "ACTIVITY": 5, "DELETED": "X"},
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "TASK_LIST_TYPE": "N",
         "ROUTING_GROUP": "50001234", "GROUP_COUNTER": 1, "SEQUENCE_NO": 20,
         "ACTIVITY": 6, "DELETED": ""},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    groups, warnings = ingest.parse_routing_operations_upload(file_bytes, conn=conn)

    total_rows = sum(len(rows) for rows in groups.values())
    assert total_rows == 1, "the DELETED row must never be stored"
    assert _reject_msgs(warnings) == [], "the DELETED row must never count as rejected"
    info_msgs = [w["msg"] for w in warnings if w["level"] == "info"]
    assert any("DELETED flag set" in m and "1 row" in m for m in info_msgs)


# ---------------------------------------------------------------------------
# 7. Missing required PK field, and unparseable numeric field -- per-row
#    rejection, not whole-file failure
# ---------------------------------------------------------------------------
def test_missing_key_and_bad_numeric_rejected_per_row_others_still_parsed():
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": None,
         "COSTING_LOT_SIZE": 10},                                   # missing key
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 2,
         "COSTING_LOT_SIZE": "not-a-number"},                        # bad numeric
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 3,
         "COSTING_LOT_SIZE": 10},                                   # valid
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    reasons = _reject_msgs(warnings)
    assert any(r.startswith("missing_key:") for r in reasons)
    assert any(r.startswith("invalid_numeric_value:") for r in reasons)
    assert len(result["upserts"]) == 1
    assert result["upserts"][0]["production_version"] == "0003"


# ---------------------------------------------------------------------------
# 9. Row-level entry points (the SAP staging path reuses these directly)
# ---------------------------------------------------------------------------
def test_pv_rows_accepts_dict_rows_and_ignores_foreign_keys():
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_rows(
        [{"plant": "5512", "material_id": "1000261702.0", "production_version": 1,
          "group_counter": 1, "not_a_column": "x"}],
        conn=conn)

    assert warnings == []
    (row,) = result["upserts"]
    assert row["material_id"] == "1000261702"
    assert row["production_version"] == "0001"
    assert row["group_counter"] == "01"
    assert "not_a_column" not in row


def test_pv_rows_unknown_plant_rejected_with_row_number():
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_rows(
        [{"plant": "9999", "material_id": "1000261702", "production_version": 1}],
        conn=conn, first_row=1)

    assert result["upserts"] == []
    assert _reject_msgs(warnings)[0].startswith("unknown_plant:")
    assert warnings[0]["row"] == 1


def test_operation_rows_duplicate_key_rejected_and_grouped():
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})
    base = {"plant": "5512", "material_id": "1000261702", "task_list_type": "N",
            "routing_group": "50001234", "group_counter": 1, "sequence_no": 10, "activity": 5}

    groups, warnings = ingest.parse_routing_operations_rows(
        [dict(base), dict(base), dict(base, sequence_no=20, deleted="X")], conn=conn)

    assert any(r.startswith("duplicate_key:") for r in _reject_msgs(warnings))
    ((key, rows),) = groups.items()
    assert key == ("5512", "1000261702", "N", "50001234", "01")
    assert len(rows) == 1
    assert rows[0]["sequence_no"] == "000010"
    assert rows[0]["sequence_category"] == "0"


# ---------------------------------------------------------------------------
# 8. Unknown/unrecognized header columns ignored with a warning, not an error
# ---------------------------------------------------------------------------
def test_unknown_header_column_ignored_with_warning_not_error():
    file_bytes = _xlsx_bytes([
        {"PLANT": "5512", "MATERIAL_ID": "1000261702", "PRODUCTION_VERSION": 1,
         "SOME_FUTURE_SAP_FIELD": "whatever"},
    ])
    conn = _fake_conn(known_plants={"5512"}, known_mp={("5512", "1000261702")})

    result, warnings = ingest.parse_production_versions_upload(file_bytes, conn=conn)

    warn_msgs = _warn_msgs(warnings)
    assert any("SOME_FUTURE_SAP_FIELD" in m for m in warn_msgs)
    assert _reject_msgs(warnings) == []
    assert len(result["upserts"]) == 1


# ---------------------------------------------------------------------------
# 9. map_row_keys -- shared header mapping for the Excel adapter and the
#    paste/validate route
# ---------------------------------------------------------------------------
def test_map_row_keys_maps_headers_and_nimbus_column_names():
    rows = [{"PLANT": "5512", "Material Id": "1000261702", "ALTERNATE_BOM": "1",
             "group_counter": 1}]

    mapped, warnings = ingest.map_row_keys(rows, ingest.PRODUCTION_VERSION_HEADERS)

    assert mapped == [{"plant": "5512", "material_id": "1000261702",
                       "alternative_bom": "1", "group_counter": 1}]
    assert warnings == []


def test_map_row_keys_drops_unknown_key_with_one_warning():
    rows = [{"PLANT": "5512", "FOO": 1}, {"PLANT": "5513", "FOO": 2}]

    mapped, warnings = ingest.map_row_keys(rows, ingest.PRODUCTION_VERSION_HEADERS)

    assert mapped == [{"plant": "5512"}, {"plant": "5513"}]
    assert len(warnings) == 1
    assert warnings[0]["level"] == "warn"
    assert "FOO" in warnings[0]["msg"]


def test_read_excel_rows_still_raises_on_missing_key_header():
    file_bytes = _xlsx_bytes([{"PLANT": "5512", "MATERIAL_ID": "1000261702"}])

    with pytest.raises(ValueError, match="PRODUCTION_VERSION"):
        ingest._read_excel_rows(file_bytes, ingest.PRODUCTION_VERSION_HEADERS,
                                ingest.PRODUCTION_VERSION_KEY_HEADERS)
