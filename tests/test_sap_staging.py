"""Coverage for backend/integration/sap_staging.py (docs/SAP_STAGING_DESIGN.md, plan step 10).

Two layers, mirroring tests/test_orders_routing_ingest.py:

  * pure-logic tests -- zone conversion, open quantity, the vanish gate, the row builders,
    the material-plant / planned-order validators, the upload value coercion, and the SQL
    shape of the supersede / stale-expiry helpers on a recording fake cursor. No database.
  * `@pytest.mark.pg` end-to-end tests (auto-skipped without a local test Postgres and
    `NIMBUS_TEST_DB=1`): material-plant apply, the routing-required hold, the 25 % vanish
    hold + confirmed apply with archive, and poll_once supersede ordering.

The pg tests could not be run where this file was written (no local Postgres); they are
written against the real schema and must be run before ship.
"""
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import pytest
from psycopg.types.json import Jsonb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import backend.integration.sap_staging as st  # noqa: E402

# ---------------------------------------------------------------------------
# Shared fixtures: a field map shaped like the migration seeds (Appendix C)
# ---------------------------------------------------------------------------
_PLANNED_MAP = [
    ("PLNUM", "production_order", "strip_zeros"), ("MATNR", "material_number", "alpha_strip"),
    ("PLWRK", "plant", "none"), ("MDV01", "machine", "none"),
    ("PSTTR", "basic_start_date", "dats"), ("PSTTI", "basic_start_time", "tims"),
    ("PEDTR", "basic_finish_date", "dats"), ("PEDTI", "basic_finish_time", "tims"),
    ("GSMNG", "order_quantity", "decimal"), ("ABMNG", "reduced_quantity", "decimal"),
    ("VERID", "production_version", "none"), ("AUFFX", "firming_indicator", "none"),
    ("STLAN", "bom_usage", "none"), ("STALT", "bom_alternative", "none"),
]
_MATERIAL_MAP = [
    ("MATNR", "material_id", "alpha_strip"), ("WERKS", "plant", "none"), ("MMSTA", "status_pl", "none"),
    ("MINLS", "min_lot_size", "decimal"), ("LTINC", "incremental_lot_size", "decimal"),
    ("ZZ_SUBNET", "subnetwork", "none"),
]


def _fmap(spec, inactive=()):
    return [{"sap_field": f, "nimbus_column": c, "transform": t, "active": f not in inactive, "field_order": i}
            for i, (f, c, t) in enumerate(spec)]


def _planned_stage(**over):
    row = {"id": 1, "plnum": "000000123", "matnr": "000000000000012345", "plwrk": "ZZP1", "mdv01": "LINE1",
           "psttr": "20261008", "pstti": "060000", "pedtr": "20261008", "pedti": "180000",
           "gsmng": Decimal("100"), "abmng": Decimal("30"), "verid": "", "auffx": "X", "stlan": "1", "stalt": "2",
           "production_order": "123", "material_id": "12345", "plant": "ZZP1"}
    row.update(over)
    return row


# ---------------------------------------------------------------------------
# Zone conversion
# ---------------------------------------------------------------------------
def test_sap_to_plant_local_converts_system_zone_to_plant_zone():
    # 15:30 New York == 14:30 Chicago, same day.
    got = st.sap_to_plant_local("20261008", "153000", "America/Chicago", system_tz="America/New_York")
    assert got == datetime(2026, 10, 8, 14, 30)
    # 12:00 UTC == 21:00 Tokyo; ISO date + HH:MM:SS time are accepted too.
    got = st.sap_to_plant_local("2026-10-08", "12:00:00", "Asia/Tokyo", system_tz="UTC")
    assert got == datetime(2026, 10, 8, 21, 0)


def test_sap_to_plant_local_date_only_and_sentinels_and_unknown_zone():
    # '000000' / missing time = date-only: midnight, never zone-shifted onto the previous day.
    assert st.sap_to_plant_local("20261008", "000000", "Asia/Tokyo", system_tz="America/New_York") \
        == datetime(2026, 10, 8, 0, 0)
    assert st.sap_to_plant_local("20261008", None, "Asia/Tokyo", system_tz="UTC") == datetime(2026, 10, 8)
    assert st.sap_to_plant_local("00000000", "120000", "UTC") is None
    assert st.sap_to_plant_local("", None, "UTC") is None
    assert st.sap_to_plant_local(None, None, "UTC") is None
    # Unknown / missing plant zone: no conversion.
    assert st.sap_to_plant_local("20261008", "120000", None, system_tz="UTC") == datetime(2026, 10, 8, 12)
    assert st.sap_to_plant_local("20261008", "120000", "Not/AZone", system_tz="UTC") == datetime(2026, 10, 8, 12)


@pytest.mark.parametrize("d,t", [("2026-13-45", "120000"), ("20261340", None), ("abc", None),
                                 ("20261008", "256000"), ("20261008", "12x"), ("20261008", "1:2:3:4")])
def test_sap_to_plant_local_malformed_raises(d, t):
    with pytest.raises(ValueError):
        st.sap_to_plant_local(d, t, "UTC")


def test_plant_local_to_sap_round_trips():
    tz, sys_tz = "America/Chicago", "America/New_York"
    local = st.sap_to_plant_local("20261008", "233000", tz, system_tz=sys_tz)
    assert st.plant_local_to_sap(local, tz, system_tz=sys_tz) == (date(2026, 10, 8), time(23, 30))
    # Crossing midnight: 23:30 New York == 22:30 Chicago, and back.
    assert local == datetime(2026, 10, 8, 22, 30)
    # Different zones that cross the date line.
    local = st.sap_to_plant_local("20261008", "230000", "Asia/Tokyo", system_tz="UTC")
    assert local == datetime(2026, 10, 9, 8, 0)
    assert st.plant_local_to_sap(local, "Asia/Tokyo", system_tz="UTC") == (date(2026, 10, 8), time(23, 0))
    # No zone: unchanged.
    assert st.plant_local_to_sap(datetime(2026, 1, 2, 3, 4, 5, 999), None, system_tz="UTC") \
        == (date(2026, 1, 2), time(3, 4, 5))


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------
def test_open_quantity():
    assert st.open_quantity(Decimal("100"), Decimal("30")) == Decimal("70")
    assert st.open_quantity("100.5", "0.5") == Decimal("100")
    assert st.open_quantity(10, None) == Decimal("10")
    assert st.open_quantity(5, 5) == Decimal("0")
    assert st.open_quantity(5, 8) == Decimal("-3")
    assert st.open_quantity(None, 3) is None
    with pytest.raises(ValueError):
        st.open_quantity("x", 1)


def test_truncate_subnetwork():
    assert st.truncate_subnetwork("ABCD") == "ABC"
    assert st.truncate_subnetwork(" AB ") == "AB"
    assert st.truncate_subnetwork("") is None
    assert st.truncate_subnetwork(None) is None


def test_vanish_gate_threshold_is_strictly_above_25_percent():
    assert st.vanish_gate(100, 24) == (False, 0.24)
    held, pct = st.vanish_gate(100, 26)
    assert held is True and pct == pytest.approx(0.26)
    assert st.vanish_gate(100, 25)[0] is False        # exactly 25 % applies
    assert st.vanish_gate(0, 0) == (False, 0.0)       # nothing live: never held
    assert st.vanish_gate(0, 5) == (False, 0.0)


def test_active_map_honours_active_flag_and_lowercases():
    m = st.active_map("stage_planned_orders", _fmap(_PLANNED_MAP, inactive=("MDV01",)))
    assert "mdv01" not in m
    assert m["psttr"] == ("basic_start_date", "dats")
    assert m["matnr"] == ("material_number", "alpha_strip")


def test_module_constants():
    assert st.VANISH_HOLD_PCT == 0.25
    assert st.APPLY_ORDER == ("stage_material_plants", "stage_production_version",
                              "stage_routing_operation", "stage_planned_orders")
    assert (st.ARCHIVE_RETENTION_DAYS, st.SENT_RETENTION_DAYS, st.DEAD_BATCH_RETENTION_DAYS) == (30, 30, 7)


def test_exception_hierarchy():
    e = st.BatchSuperseded("newer exists", {"newer_batch_id": "x"})
    assert isinstance(e, st.BatchNotApplicable)
    assert e.detail["newer_batch_id"] == "x" and e.detail["message"] == "newer exists"


# ---------------------------------------------------------------------------
# build_order_rows
# ---------------------------------------------------------------------------
def test_build_order_rows_composite_dates_quantity_and_casts(monkeypatch):
    monkeypatch.setattr(st, "SAP_SYSTEM_TZ", "UTC")
    warnings: list = []
    rows, problems = st.build_order_rows([_planned_stage()], "America/Chicago", _fmap(_PLANNED_MAP), warnings)
    assert problems == [] and len(rows) == 1
    r = rows[0]
    assert r["production_order"] == "123" and r["material_number"] == "12345" and r["plant"] == "ZZP1"
    assert r["machine"] == "LINE1"
    # 06:00 UTC -> 01:00 CDT; finish 18:00 UTC -> 13:00 CDT.
    assert r["basic_start_date"] == datetime(2026, 10, 8, 1, 0)
    assert r["basic_finish_date"] == datetime(2026, 10, 8, 13, 0)
    assert r["sap_basic_finish_date"] == datetime(2026, 10, 8, 13, 0)
    assert r["order_quantity"] == 70.0
    assert r["planned_order_initial_quantity"] == 100.0 and r["reduced_quantity"] == 30.0
    assert r["bom_usage"] == 1 and r["bom_alternative"] == 2
    assert r["firming_indicator"] == "X"
    assert r["_zero_open"] is False and r["_stage_row_id"] == 1
    # The pseudo time columns never reach the upsert row.
    assert "basic_start_time" not in r and "basic_finish_time" not in r


def test_build_order_rows_blank_version_means_material_default_with_empty_baseline():
    rows, _ = st.build_order_rows([_planned_stage(verid="")], None, _fmap(_PLANNED_MAP))
    assert rows[0]["production_version"] is None and rows[0]["sap_production_version"] == ""
    rows, _ = st.build_order_rows([_planned_stage(verid=" 0001 ")], None, _fmap(_PLANNED_MAP))
    assert rows[0]["production_version"] == "0001" and rows[0]["sap_production_version"] == "0001"
    # VERID inactive: column "not sent" -- neither key is produced.
    rows, _ = st.build_order_rows([_planned_stage(verid="0002")], None, _fmap(_PLANNED_MAP, inactive=("VERID",)))
    assert "sap_production_version" not in rows[0]


def test_build_order_rows_zero_open_quantity_flags_needs_planning():
    rows, _ = st.build_order_rows([_planned_stage(gsmng=Decimal("30"), abmng=Decimal("30")),
                                   _planned_stage(id=2, plnum="000000124", production_order="124",
                                                  gsmng=Decimal("30"), abmng=Decimal("40"))],
                                  None, _fmap(_PLANNED_MAP))
    assert [r["_zero_open"] for r in rows] == [True, True]
    assert [r["order_quantity"] for r in rows] == [0.0, 0.0]       # never negative
    assert st.zero_open_keys(rows) == ["123", "124"]


def test_build_order_rows_inactive_map_rows_do_not_flow():
    rows, _ = st.build_order_rows([_planned_stage()], None,
                                  _fmap(_PLANNED_MAP, inactive=("MDV01", "GSMNG", "STLAN")))
    r = rows[0]
    assert r["machine"] is None
    assert "planned_order_initial_quantity" not in r and "order_quantity" not in r
    assert "bom_usage" not in r


def test_build_order_rows_missing_start_is_kept_with_a_null_start():
    """Backward scheduling Task 2.7: the start is optional, the finish is not."""
    rows, problems = st.build_order_rows([_planned_stage(id=7, psttr="00000000")], None, _fmap(_PLANNED_MAP))
    assert problems == [] and len(rows) == 1
    assert rows[0]["basic_start_date"] is None and rows[0]["basic_finish_date"] is not None
    assert rows[0]["sap_basic_finish_date"] == rows[0]["basic_finish_date"]


def test_build_order_rows_missing_finish_is_dropped_and_reported():
    rows, problems = st.build_order_rows([_planned_stage(id=8, pedtr="00000000")], None, _fmap(_PLANNED_MAP))
    assert rows == [] and problems == [(8, "invalid_date")]


def test_build_order_rows_int_cast_failure_is_a_problem_not_a_crash():
    rows, problems = st.build_order_rows([_planned_stage(id=9, stlan="x"), _planned_stage(id=10)], None,
                                         _fmap(_PLANNED_MAP))
    assert problems == [(9, "invalid_int")]
    assert [r["_stage_row_id"] for r in rows] == [10]


# ---------------------------------------------------------------------------
# build_material_plant_rows
# ---------------------------------------------------------------------------
def test_build_material_plant_rows_int_casts_truncates_and_warns():
    stage = [{"id": 1, "matnr": "000012345", "werks": "ZZP1", "mmsta": "A1", "minls": Decimal("10.4"),
              "ltinc": Decimal("5"), "zz_subnet": "ABCD", "material_id": "12345", "plant": "ZZP1"},
             {"id": 2, "matnr": "777", "werks": "ZZP1", "mmsta": None, "minls": None, "ltinc": None,
              "zz_subnet": None, "material_id": "777", "plant": "ZZP1"}]
    warnings: list = []
    rows = st.build_material_plant_rows(stage, _fmap(_MATERIAL_MAP), warnings)
    assert rows[0] == {"material_id": "12345", "plant": "ZZP1", "status_pl": "A1", "min_lot_size": 10,
                       "incremental_lot_size": 5, "subnetwork": "ABC"}
    # Missing SAP values are dropped (never NULL into a NOT NULL column); keys survive.
    assert rows[1] == {"material_id": "777", "plant": "ZZP1"}
    assert warnings == [{"level": "warn", "code": "lot_size_rounded", "count": 1,
                         "msg": "1 fractional lot size value(s) were rounded to whole numbers."}]


def test_build_material_plant_rows_no_warning_for_whole_lots():
    stage = [{"id": 1, "matnr": "1", "werks": "P", "minls": Decimal("10.000"), "material_id": "1", "plant": "P"}]
    warnings: list = []
    rows = st.build_material_plant_rows(stage, _fmap(_MATERIAL_MAP), warnings)
    assert rows[0]["min_lot_size"] == 10 and warnings == []


# ---------------------------------------------------------------------------
# Pure validators
# ---------------------------------------------------------------------------
def _by_id(results):
    return {r["id"]: r for r in results}


def test_validate_material_plant_rows_reasons_and_duplicates():
    rows = [
        {"id": 1, "matnr": "000012345", "werks": "ZZP1"},          # valid, resolves to 12345
        {"id": 2, "matnr": "", "werks": "ZZP1"},                   # missing_key
        {"id": 3, "matnr": "000000000", "werks": "ZZP1"},          # all-zero material -> missing_key
        {"id": 4, "matnr": "55", "werks": "OTHER"},                # plant_mismatch
        {"id": 5, "matnr": "66", "werks": "ZZP1"},                 # unknown_plant (not in known set below)
        {"id": 6, "matnr": "7" * 19, "werks": "ZZP1"},             # key_too_long
        {"id": 7, "matnr": "88", "werks": "ZZP1"},                 # duplicate pair ...
        {"id": 8, "matnr": "0088", "werks": "ZZP1"},               # ... after alpha_strip
    ]
    res = _by_id(st.validate_material_plant_rows(rows, "ZZP1", {"ZZP1"}))
    assert res[1]["status"] == "valid" and res[1]["resolved"] == {"material_id": "12345", "plant": "ZZP1"}
    assert res[2]["reason"] == "missing_key" and res[3]["reason"] == "missing_key"
    assert res[4]["reason"] == "plant_mismatch"
    assert res[6]["reason"] == "key_too_long"
    assert res[7]["reason"] == res[8]["reason"] == "duplicate_key"        # ALL duplicates rejected
    res = _by_id(st.validate_material_plant_rows([rows[4]], "ZZP1", {"SOMETHING"}))
    assert res[5]["reason"] == "unknown_plant"


def test_validate_planned_order_rows_reasons():
    ok = _planned_stage()
    rows = [
        {**ok, "id": 1},
        {**ok, "id": 2, "plnum": "000000000"},                      # all-zero order number -> missing_key
        {**ok, "id": 3, "plnum": "300", "plwrk": "OTHER"},          # plant_mismatch
        {**ok, "id": 4, "plnum": "400", "psttr": "20269999"},       # invalid_date
        {**ok, "id": 5, "plnum": "500", "psttr": "00000000"},       # missing start: valid, the start is optional
        {**ok, "id": 6, "plnum": "600", "pstti": "250000"},         # invalid_time
        {**ok, "id": 7, "plnum": "700", "gsmng": None},             # invalid_number
        {**ok, "id": 8, "plnum": "800", "abmng": Decimal("-1")},    # invalid_number
        {**ok, "id": 9, "plnum": "900", "stalt": "x"},              # invalid_int
        {**ok, "id": 10, "plnum": "1000", "pedtr": "00000000"},     # no finish: rejected, the finish is required
        {**ok, "id": 11, "plnum": "0000001100"},                    # duplicate order+material ...
        {**ok, "id": 12, "plnum": "1100"},                          # ... after strip_zeros
    ]
    res = _by_id(st.validate_planned_order_rows(rows, "ZZP1", {"ZZP1"}))
    assert res[1]["status"] == "valid"
    assert res[1]["resolved"] == {"production_order": "123", "material_id": "12345", "plant": "ZZP1"}
    assert res[2]["reason"] == "missing_key"
    assert res[3]["reason"] == "plant_mismatch"
    assert res[4]["reason"] == "invalid_date"                               # a malformed start is not a missing one
    assert res[5]["status"] == "valid" and res[5]["reason"] is None         # no start at all is fine
    assert res[6]["reason"] == "invalid_time"
    assert res[7]["reason"] == "invalid_number" and res[8]["reason"] == "invalid_number"
    assert res[9]["reason"] == "invalid_int"
    assert res[10]["reason"] == "invalid_date"
    assert res[11]["reason"] == res[12]["reason"] == "duplicate_key"
    # A rejected row still resolves its order number (the vanish guard protects it).
    assert res[4]["resolved"]["production_order"] == "400"
    # Unknown header plant -> unknown_plant.
    only = _by_id(st.validate_planned_order_rows([rows[0]], "ZZP1", set()))
    assert only[1]["reason"] == "unknown_plant"


# ---------------------------------------------------------------------------
# Upload value coercion
# ---------------------------------------------------------------------------
def test_coerce_for_column():
    assert st._coerce_for_column("12.5", "numeric") == Decimal("12.5")
    assert st._coerce_for_column("7.0", "integer") == 7
    assert st._coerce_for_column("", "numeric") is None
    assert st._coerce_for_column(float("nan"), "text") is None
    assert st._coerce_for_column(" abc ", "text") == "abc"
    assert st._coerce_for_column("20261008", "date") == date(2026, 10, 8)
    assert st._coerce_for_column("X", "boolean") is True and st._coerce_for_column("0", "boolean") is False
    with pytest.raises(ValueError):
        st._coerce_for_column("twelve", "numeric")
    with pytest.raises(ValueError):
        st._coerce_for_column("2026-99-99", "date")


# ---------------------------------------------------------------------------
# Recording fake cursor: SQL shape of the lifecycle helpers
# ---------------------------------------------------------------------------
class _RecCursor:
    def __init__(self, fetchall_results=()):
        self.executed = []
        self._results = list(fetchall_results)

    def execute(self, statement, params=None):
        self.executed.append((str(getattr(statement, "as_string", lambda _c: statement)(None))
                              if hasattr(statement, "as_string") else str(statement), params))

    def fetchall(self):
        return self._results.pop(0) if self._results else []


def test_supersede_older_only_touches_older_unapplied_batches_and_their_rows():
    keep = uuid.uuid4()
    old = uuid.uuid4()
    cur = _RecCursor([[(old,)]])
    ids = st.supersede_older(cur, "stage_material_plants", "ZZP1", keep)
    assert ids == [str(old)]
    stmt, params = cur.executed[0]
    assert "status = 'superseded'" in stmt
    assert "(received_at, COALESCE(ready_at, received_at), batch_id) < (SELECT" in stmt     # B4: total order
    assert params[0] == "stage_material_plants" and params[1] == "ZZP1" and params[2] == str(keep)
    assert params[3] == ["ready", "validated", "held"]
    assert params[4] is None and params[5] is None                                         # no source restriction
    assert len(cur.executed) == 2 and cur.executed[1][1] == ([str(old)],)


def test_supersede_older_with_nothing_older_skips_the_row_update():
    cur = _RecCursor([[]])
    assert st.supersede_older(cur, "stage_planned_orders", "ZZP1", uuid.uuid4()) == []
    assert len(cur.executed) == 1


def test_expire_stale_loading_uses_the_timeout():
    cur = _RecCursor([[(uuid.uuid4(),), (uuid.uuid4(),)]])
    assert st.expire_stale_loading(cur) == 2
    stmt, params = cur.executed[0]
    assert "status = 'loading'" in stmt and "make_interval(mins => %s)" in stmt
    assert params[-1] == st.LOADING_TIMEOUT_MIN


def test_write_row_results_sets_status_reason_and_resolved_columns():
    cur = _RecCursor()
    results = [{"id": 1, "status": "valid", "reason": None, "resolved": {"material_id": "1", "plant": "P"}},
               {"id": 2, "status": "rejected", "reason": "missing_key", "resolved": {"material_id": None,
                                                                                    "plant": "P"}}]
    st._write_row_results(cur, "sap_stage_material_plant", results, ("material_id", "plant"))
    assert len(cur.executed) == 1
    params = cur.executed[0][1]
    assert params[0] == [1, 2] and params[1] == ["valid", "rejected"] and params[2] == [None, "missing_key"]
    assert params[3] == ["1", None] and params[4] == ["P", "P"]


# ---------------------------------------------------------------------------
# Review round: completeness gate, auto-apply rule, frozen deletion set, env parsing, length checks
# ---------------------------------------------------------------------------
def test_env_int_never_raises_and_floors(monkeypatch, caplog):
    monkeypatch.setenv("NIMBUS_T_ENV", "30s")
    assert st.env_int("NIMBUS_T_ENV", 120, 1) == 120                  # not an integer -> default
    monkeypatch.setenv("NIMBUS_T_ENV", " 45 ")
    assert st.env_int("NIMBUS_T_ENV", 120, 1) == 45
    monkeypatch.setenv("NIMBUS_T_ENV", "-3")
    with caplog.at_level("WARNING", logger="nimbus.sap"):
        assert st.env_int("NIMBUS_T_ENV", 120, 1) == 1                # floored at the minimum, with a warning
    assert "below the minimum" in caplog.text
    monkeypatch.setenv("NIMBUS_T_ENV", "")
    assert st.env_int("NIMBUS_T_ENV", 7, 0) == 7
    monkeypatch.delenv("NIMBUS_T_ENV")
    assert st.env_int("NIMBUS_T_ENV", 0, 0) == 0


def test_check_batch_complete_gate():
    st.check_batch_complete("upload", None, 5)                         # uploads keep today's behaviour
    st.check_batch_complete("mulesoft", 5, 5)
    for expected, actual in ((None, 5), (6, 5), (4, 5)):
        with pytest.raises(st.BatchNotApplicable) as ei:
            st.check_batch_complete("mulesoft", expected, actual)
        assert ei.value.detail["code"] == "incomplete_rows"


def test_should_auto_apply_never_for_uploads():
    assert st.should_auto_apply("mulesoft", "validated", "auto") is True
    assert st.should_auto_apply("upload", "validated", "auto") is False        # D18
    assert st.should_auto_apply("mulesoft", "validated", "manual") is False
    assert st.should_auto_apply("mulesoft", "held", "auto") is False


@pytest.mark.parametrize("stored, current, exceeded", [
    (100, 100, False), (100, 105, False), (100, 106, True),            # 5 % of 100 = 5 rows
    (10, 15, False), (10, 16, True),                                   # small sets: 5 rows is the floor
    (1000, 1050, False), (1000, 1051, True),                           # large sets: 5 %
    (50, 40, False),                                                   # shrinking never trips
])
def test_vanish_set_exceeded_tolerance(stored, current, exceeded):
    assert st.vanish_set_exceeded(stored, current) is exceeded


def test_master_vanish_stats_uses_the_25_percent_gate():
    live = {(f"M{i}",) for i in range(10)}
    n, absent, held, pct = st.master_vanish_stats(live, {(f"M{i}",) for i in range(8)})
    assert (n, absent, held, pct) == (10, [("M8",), ("M9",)], False, 0.2)
    n, absent, held, pct = st.master_vanish_stats(live, {(f"M{i}",) for i in range(7)})
    assert held is True and len(absent) == 3
    assert st.master_vanish_stats(set(), set())[2] is False            # nothing live -> never held


def test_material_protection_set_excludes_only_foreign_or_overlong_rejections():
    cur = _RecCursor([[("A",), ("B",)]])
    assert st._sent_material_ids(cur, "sap_stage_material_plant", uuid.uuid4()) == {"A", "B"}
    stmt = cur.executed[0][0]
    # B1: rejected rows are protected whenever material_id resolved -- duplicates, too-long values AND
    # missing_key (a blank plant column must not make the sweep delete the live row).
    for protected in ("duplicate_key", "value_too_long", "missing_key"):
        assert protected not in stmt
    assert "material_id IS NOT NULL" in stmt
    for unprotected in ("plant_mismatch", "unknown_plant", "key_too_long"):
        assert unprotected in stmt


def test_blank_plant_material_row_resolves_its_material_so_it_is_protected():
    res = st.validate_material_plant_rows([{"id": 1, "matnr": "000555", "werks": ""}], "ZZP1", {"ZZP1"})
    assert res[0]["reason"] == "missing_key" and res[0]["resolved"]["material_id"] == "555"


class _DescCursor(_RecCursor):
    """Recording cursor that also answers `.description` for `SELECT *` readers."""

    def __init__(self, names, rows):
        super().__init__([rows])
        self.description = [type("D", (), {"name": n})() for n in names]


def test_routing_group_is_protected_even_when_activity_is_blank():
    cols = ["id", "plant", "material_id", "task_list_type", "routing_group", "group_counter", "sequence_no",
            "activity", "row_status", "reject_reason"]
    rows = [(1, "ZZP1", "000777", "N", "G1", "1", "10", "", "rejected", "missing_key"),      # blank activity
            (2, "ZZP1", "888", "N", "G2", "01", "10", "0010", "valid", None),                # complete
            (3, "ZZP1", "999", "N", "", "01", "10", "0010", "rejected", "missing_key")]      # no group: nothing to protect
    cur = _DescCursor(cols, rows)
    keys = st._sent_routing_keys(cur, "sap_stage_routing_operation", uuid.uuid4(), "stage_routing_operation")
    groups = {tuple(k[1:5]) for k in keys}
    assert ("777", "N", "G1", "01") in groups and ("888", "N", "G2", "01") in groups
    assert not any(g[0] == "999" for g in groups)
    assert "missing_key" not in cur.executed[0][0] and "deleted_flag" in cur.executed[0][0]


def test_production_version_with_a_blank_version_is_not_protected_by_a_group_key():
    cols = ["id", "plant", "material_id", "production_version", "row_status", "reject_reason"]
    cur = _DescCursor(cols, [(1, "ZZP1", "777", "", "rejected", "missing_key")])
    assert st._sent_routing_keys(cur, "sap_stage_production_version", uuid.uuid4(), "stage_production_version") == set()


def test_material_plant_value_too_long_rejected_with_column_name():
    rows = [{"id": 1, "matnr": "1", "werks": "ZZP1", "mmsta": "ABC"},
            {"id": 2, "matnr": "2", "werks": "ZZP1", "mmsta": "A1"}]
    res = _by_id(st.validate_material_plant_rows(rows, "ZZP1", {"ZZP1"}))
    assert res[1]["reason"] == "value_too_long:mmsta" and res[2]["status"] == "valid"


def test_material_plant_duplicates_still_resolve_their_material_for_the_protection_set():
    rows = [{"id": i, "matnr": m, "werks": "ZZP1"} for i, m in ((1, "1"), (2, "2"), (3, "3"), (4, "4"), (5, "4"))]
    res = st.validate_material_plant_rows(rows, "ZZP1", {"ZZP1"})
    dup = [r for r in res if r["reason"] == "duplicate_key"]
    assert len(dup) == 2 and {r["resolved"]["material_id"] for r in dup} == {"4"}


class _ScriptCursor:
    """Cursor with scripted fetchone() answers; records executed statements."""

    def __init__(self, ones=()):
        self.ones = list(ones)
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return self

    def execute(self, statement, params=None):
        self.executed.append((str(statement), params))

    def fetchone(self):
        return self.ones.pop(0) if self.ones else None

    def fetchall(self):
        return []

    def commit(self):
        pass

    def rollback(self):
        pass


def _hdr_row(*, source="mulesoft", status="validated", expected=None, counts=None,
             object_key="stage_material_plants"):
    now = datetime(2026, 10, 7, 8)
    return (uuid.uuid4(), object_key, "ZZP1", source, status, expected, now, now, None, None, None, "t",
            counts or {}, [], None)


def test_validate_refuses_an_incomplete_mulesoft_batch():
    cur = _ScriptCursor([_hdr_row(status="ready", expected=5), (3,)])
    with pytest.raises(st.BatchNotApplicable) as ei:
        st._validate(cur, uuid.uuid4())
    assert ei.value.detail["code"] == "incomplete_rows"


def test_validate_refuses_a_mulesoft_batch_without_an_expected_count():
    cur = _ScriptCursor([_hdr_row(status="ready", expected=None), (3,)])
    with pytest.raises(st.BatchNotApplicable) as ei:
        st._validate(cur, uuid.uuid4())
    assert ei.value.detail["code"] == "incomplete_rows"


def test_apply_rechecks_completeness_for_mulesoft_batches():
    # header, "newer batch?" -> none, stage row count (3 found vs 5 expected)
    cur = _ScriptCursor([_hdr_row(status="validated", expected=5), None, (3,)])
    with pytest.raises(st.BatchNotApplicable) as ei:
        st._apply_locked(cur, uuid.uuid4(), "pytest", False)
    assert ei.value.detail["code"] == "incomplete_rows"


def test_get_batch_with_an_unknown_object_key_returns_a_warning_not_a_500(monkeypatch):
    class _Pool:
        def connection(self):
            return _ScriptCursor([_hdr_row(object_key="stage_bogus")])
    monkeypatch.setattr(st, "_pool", _Pool())
    out = st.get_batch(uuid.uuid4())
    assert out["row_counts"] == {} and any(w["code"] == "unknown_object_key" for w in out["warnings"])


def test_header_dict_hides_the_stored_deletion_key_list():
    d = st._header_dict(_hdr_row(counts={"vanish_candidates": 2, "vanish_keys": ["a", "b"]}))
    assert d["counts"] == {"vanish_candidates": 2}


def test_outbound_candidate_rows_read_the_shared_stored_finish_not_start_plus_run_time():
    """Backward scheduling: what Send transmits is the order's stored finish (last segment, stored end, locked
    SAP finish), the same fragment the Gantt reads; the start is the first segment, else the stored start."""
    cur = _RecCursor()
    st._outbound_candidate_rows(cur, "ZZP1")
    sql = cur.executed[0][0]
    assert st.db._EFF_END_SQL in sql
    # F15: the firm rule's start is the LOCKED start (never the echo-movable basic start ahead of the received one)
    assert "COALESCE(seg.first_start, o.scheduled_start, o.original_start_received, o.basic_start_date)" in sql
    assert st.db._EFF_START_SQL not in sql
    assert "INTERVAL" not in sql and "run_time" not in sql


# ===========================================================================
# Send to SAP -- pure pieces (firm rule, roll-up, zone conversion of the outbound value)
# ===========================================================================
_FROZEN = datetime(2026, 10, 10)


@pytest.mark.parametrize("manual, ind, start, frozen, expected", [
    (False, None, datetime(2026, 10, 20), _FROZEN, ""),               # nothing qualifies
    (True, None, datetime(2026, 10, 20), _FROZEN, "X"),               # planner firmed
    (False, "X", datetime(2026, 10, 20), _FROZEN, "X"),               # SAP already firmed -- never blanked
    (False, " x ", datetime(2026, 10, 20), None, "X"),                # tolerant of case / whitespace
    (False, None, datetime(2026, 10, 9), _FROZEN, "X"),               # inside the frozen horizon
    (False, None, datetime(2026, 10, 10), _FROZEN, ""),               # exactly at the boundary is outside
    (False, None, datetime(2026, 10, 9), None, ""),                   # no frozen horizon -> no frozen firming
    (False, None, None, _FROZEN, ""),                                 # no start -> cannot be inside
    (False, "", datetime(2026, 10, 20), _FROZEN, ""),
    (None, "N", datetime(2026, 10, 20), _FROZEN, ""),
])
def test_firm_flag_truth_table(manual, ind, start, frozen, expected):
    assert st.firm_flag(manual, ind, start, frozen) == expected


def _o(oid, po, *, parent=None, mat="777", end=datetime(2026, 11, 1, 8), start=datetime(2026, 11, 1, 2),
       manual=False, ind=None, version="V1", status="scheduled"):
    return {"id": oid, "production_order": po, "parent_production_order": parent, "material_number": mat,
            "manual_firmed": manual, "firming_indicator": ind, "production_version": version,
            "planning_status": status, "eff_start": start, "eff_end": end}


def test_build_outbound_groups_rolls_children_up_with_max_end_and_any_firm():
    rows = [
        _o("c1", "PAR1-A", parent="PAR1", end=datetime(2026, 11, 1, 8), version=None),
        _o("c2", "PAR1-B", parent="PAR1", end=datetime(2026, 11, 2, 9), manual=True, version="V2"),
        _o("c3", "PAR1-C", parent="PAR1", end=None, status="needs_planning"),           # skipped member, still a member
        _o("p1", "1001", end=datetime(2026, 11, 3, 6), manual=True),
        _o("n1", "1002", end=None),
        _o("n2", "1003", status="needs_planning"),
    ]
    groups, skipped, unfirmed = st.build_outbound_groups(rows, None)
    by = {g["plnum"]: g for g in groups}
    assert sorted(by) == ["1001", "PAR1"] and skipped == 3 and unfirmed == 0
    par = by["PAR1"]
    assert par["end"] == datetime(2026, 11, 2, 9)                                       # max child end
    assert par["auffx"] == "X" and par["rolled_up"] is True and par["verid"] == "V2"
    assert par["member_ids"] == ["c1", "c2", "c3"] and par["nimbus_order_id"] is None
    assert par["sent_ids"] == ["c1", "c2"]                                              # L9: skipped member not remembered
    plain = by["1001"]
    assert plain["auffx"] == "X" and plain["rolled_up"] is False and plain["nimbus_order_id"] == "p1"
    assert plain["verid"] == "V1"


def test_build_outbound_groups_groups_by_material_and_applies_frozen_firming():
    rows = [_o("a", "9", mat="M1", start=datetime(2026, 10, 9)), _o("b", "9", mat="M2", start=datetime(2026, 10, 20))]
    groups, skipped, unfirmed = st.build_outbound_groups(rows, _FROZEN)
    assert skipped == 0 and unfirmed == 1 and len(groups) == 1           # M2 starts after the frozen end: not firmed
    assert {g["matnr"]: g["auffx"] for g in groups} == {"M1": "X"}


def test_send_skips_unfirmed_orders():
    """OQ61: only firmed planned orders are sent -- planner-firmed, SAP-firmed or inside the frozen horizon."""
    rows = [
        _o("u1", "U1"),                                                  # nothing qualifies -> dropped
        _o("m1", "M1", manual=True),                                     # planner-firmed
        _o("s1", "S1", ind="X"),                                         # SAP-firmed
        _o("f1", "F1", start=datetime(2026, 10, 9)),                     # starts inside the frozen horizon
        _o("n1", "N1", end=None, manual=True),                           # firmed but no end: counted as no-end, not unfirmed
        # an aggregate with one firmed child stays; its end is the latest over ALL children (the unfirmed one too)
        _o("c1", "AG-A", parent="AG", end=datetime(2026, 11, 1, 8), manual=True),
        _o("c2", "AG-B", parent="AG", end=datetime(2026, 11, 5, 8)),
        # an aggregate with no firmed child is dropped as ONE planned order
        _o("d1", "DG-A", parent="DG"),
        _o("d2", "DG-B", parent="DG"),
    ]
    groups, no_end, unfirmed = st.build_outbound_groups(rows, _FROZEN)
    by = {g["plnum"]: g for g in groups}
    assert sorted(by) == ["AG", "F1", "M1", "S1"]
    assert all(g["auffx"] == "X" for g in groups)
    assert by["AG"]["end"] == datetime(2026, 11, 5, 8) and by["AG"]["member_ids"] == ["c1", "c2"]
    assert no_end == 1 and unfirmed == 2                                 # unfirmed planned orders: U1 and the DG aggregate



def test_outbound_end_is_converted_plant_local_to_sap_system_zone():
    end = datetime(2026, 7, 1, 8, 30, 15, 999)                   # naive plant-local (America/Chicago, UTC-5 in July)
    d, t = st.plant_local_to_sap(end, "America/Chicago", system_tz="Europe/Berlin")
    assert (d, t) == (date(2026, 7, 1), time(15, 30, 15))        # Berlin is UTC+2 -> +7h, seconds precision


# ===========================================================================
# @pytest.mark.pg -- end-to-end against a real (local, opted-in) Postgres
# ===========================================================================
PLANT = "ZZSTG1"
SUB = "ZZSTGSUB"


@contextmanager
def _conn(pg):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        yield conn, cur


def _cleanup(pg):
    with _conn(pg) as (conn, cur):
        cur.execute("DELETE FROM sap_stage_vanished_order WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM sap_stage_batch WHERE btrim(plant) = %s", (PLANT,))   # incl. the padded-plant test
        cur.execute("DELETE FROM order_distribution WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM orders WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM machine WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM routing_operation WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM production_version WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM material_plants WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM materials WHERE material_id LIKE 'ZZSTG%%' OR material_id IN ('12345', '777')")
        cur.execute("DELETE FROM plants WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM subnetworks WHERE code = %s", (SUB,))
        conn.commit()


@pytest.fixture
def stg_plant(pg):
    """One throwaway plant (routing switch / horizon set per test via `_set_plant`). Cleans up."""
    _cleanup(pg)
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (SUB, SUB))
        cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'UTC')", (SUB, PLANT))
        cur.execute("SELECT clock_timestamp()::timestamp")
        started = cur.fetchone()[0]
        conn.commit()
    yield PLANT
    _cleanup(pg)
    with _conn(pg) as (conn, cur):
        # Planned-order applies write an `upload_audit` row (filename 'sap:sap') each; leaving them piles up
        # and crowds the fixed-size window of test_integration_pg's upload-audit source-filter test.
        cur.execute("DELETE FROM upload_audit WHERE filename = 'sap:sap' AND uploaded_at >= %s", (started,))
        conn.commit()


def _set_plant(pg, *, routing: bool, horizon_days):
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET routing_runtime_enabled = %s, visibility_horizon_days = %s WHERE plant = %s",
                    (routing, horizon_days, PLANT))
        conn.commit()


def _make_batch(pg, object_key, table, rows: list[dict], *, status="ready", age_minutes=0, expected=None):
    """Header + rows + (ready) the way Mulesoft would write them."""
    bid = uuid.uuid4()
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO sap_stage_batch (batch_id, object_key, plant, source, status, row_count_expected,"
                    " received_at, ready_at) VALUES (%s, %s, %s, 'mulesoft', %s, %s,"
                    " now() - make_interval(mins => %s), now() - make_interval(mins => %s))",
                    (bid, object_key, PLANT, status, len(rows) if expected is None else expected,
                     age_minutes, age_minutes))
        for r in rows:
            cols = list(r)
            cur.execute(f"INSERT INTO {table} (batch_id, {', '.join(cols)}) VALUES (%s, {', '.join(['%s'] * len(cols))})",
                        [bid, *r.values()])
        conn.commit()
    return bid


def _status(pg, bid):
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT status FROM sap_stage_batch WHERE batch_id = %s", (bid,))
        row = cur.fetchone()
        return row[0] if row else None


@pytest.mark.pg
def test_material_plant_apply_creates_bare_material_and_deletes_or_flags_absent_rows(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGDEL'), ('ZZSTGKEEP')")
        cur.execute("INSERT INTO material_plants (material_id, plant) VALUES ('ZZSTGDEL', %s), ('ZZSTGKEEP', %s)",
                    (PLANT, PLANT))
        # ZZSTGKEEP is referenced by an order -> flagged, not deleted; ZZSTGDEL is unreferenced -> deleted.
        cur.execute("INSERT INTO orders (id, production_order, material_number, plant) VALUES ('zzstg-o1','PO1',"
                    "'ZZSTGKEEP', %s)", (PLANT,))
        conn.commit()
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant",
                      [{"matnr": "000012345", "werks": PLANT, "mmsta": "A1", "minls": 10, "ltinc": 5,
                        "zz_subnet": "ABCD"}])
    res = st.validate_batch(bid)
    # Both live rows are absent from the snapshot (100 % > 25 %): held, so apply needs the confirmation.
    assert res["status"] == "held" and "vanish_threshold" in res["held_reasons"] and res["counts"]["valid"] == 1
    out = st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert out["status"] == "applied"
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT material_description FROM materials WHERE material_id = '12345'")
        assert cur.fetchone() == ("",)                                   # bare row, blank description
        cur.execute("SELECT subnetwork, min_lot_size FROM material_plants WHERE material_id = '12345' AND plant = %s",
                    (PLANT,))
        assert cur.fetchone() == ("ABC", 10)
        cur.execute("SELECT count(*) FROM material_plants WHERE material_id = 'ZZSTGDEL' AND plant = %s", (PLANT,))
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT sap_missing_since IS NOT NULL FROM material_plants WHERE material_id = 'ZZSTGKEEP'"
                    " AND plant = %s", (PLANT,))
        assert cur.fetchone()[0] is True
    # Retention: a second applied batch removes the first.
    bid2 = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant",
                       [{"matnr": "12345", "werks": PLANT}, {"matnr": "ZZSTGKEEP", "werks": PLANT}])
    st.validate_batch(bid2)                                              # nothing absent now: validated, no hold
    st.apply_batch(bid2, actor="pytest")
    assert _status(pg, bid) is None and _status(pg, bid2) == "applied"


@pytest.mark.pg
def test_planned_order_batch_is_held_when_routing_is_off(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=30)
    start = (datetime.utcnow() + timedelta(days=1)).strftime("%Y%m%d")
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                      [{"plnum": "000000001", "matnr": "777", "plwrk": PLANT, "psttr": start, "pedtr": start, "gsmng": 10}])
    res = st.validate_batch(bid)
    assert res["status"] == "held" and "routing_required" in res["held_reasons"]
    assert any(w.get("code") == "routing_required" for w in res["warnings"])
    with pytest.raises(st.BatchNotApplicable):
        st.apply_batch(bid, actor="pytest", confirm_held=True)       # routing_required can never be confirmed
    assert _status(pg, bid) == "held"


@pytest.mark.pg
def test_planned_order_apply_holds_at_over_25_percent_then_confirm_archives_and_deletes(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, group_counter,"
                    " sequence_no, activity) VALUES (%s, '777', 'N', 'G1', '01', '000010', '0010')", (PLANT,))
        for i in range(1, 5):                                          # four live in-horizon orders
            cur.execute("INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                        " basic_finish_date) VALUES (%s, %s, '777', %s, %s, %s)",
                        (pg.make_id(f"PO{i}", "777"), f"PO{i}", PLANT, soon, soon + timedelta(hours=4)))
        conn.commit()
    # The snapshot keeps only PO1: 3 of 4 (75 %) would vanish -> held.
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                      [{"plnum": "PO1", "matnr": "777", "plwrk": PLANT, "psttr": soon.strftime("%Y%m%d"),
                        "pstti": "060000", "pedtr": soon.strftime("%Y%m%d"), "pedti": "100000", "gsmng": 10}])
    res = st.validate_batch(bid)
    assert res["status"] == "held" and "vanish_threshold" in res["held_reasons"]
    assert res["counts"]["in_horizon_live"] == 4 and res["counts"]["vanish_candidates"] == 3
    dels = st.held_deletions(bid)
    assert sorted(d["production_order"] for d in dels) == ["PO2", "PO3", "PO4"]
    with pytest.raises(st.BatchNotApplicable):
        st.apply_batch(bid, actor="pytest")                             # held needs confirmation
    out = st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert out["status"] == "applied" and out["counts"]["deleted"] == 3 and out["counts"]["archived"] == 3
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT production_order FROM orders WHERE plant = %s ORDER BY production_order", (PLANT,))
        assert [r[0] for r in cur.fetchall()] == ["PO1"]
    archived = st.list_archived(PLANT)
    assert sorted(a["production_order"] for a in archived) == ["PO2", "PO3", "PO4"]
    restored = st.restore_archived(archived[0]["id"], actor="pytest")
    assert restored["restored"] is True


@pytest.mark.pg
def test_vanish_key_is_the_locked_sap_start_not_the_echoed_planning_copy(pg, stg_plant):
    """Backward scheduling OQ26/OQ27: the in-horizon (vanish) key reads the start SAP first sent, so an echo that
    moved `basic_start_date` or `sap_basic_start_date` never moves an order across the horizon."""
    _set_plant(pg, routing=True, horizon_days=30)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    soon, far = now + timedelta(days=1), now + timedelta(days=200)
    with _conn(pg) as (conn, cur):
        for oid, basic, sap_basic, locked in (
                ("zzstg-vk-in", soon, soon, soon),            # locked start inside -> a vanish candidate
                ("zzstg-vk-echo-out", soon, soon, far),       # echo pulled the planning copy in; locked start is out
                ("zzstg-vk-echo-in", far, far, soon)):        # echo pushed the planning copy out; locked start is in
            cur.execute("INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                        " basic_finish_date, sap_basic_start_date, original_start_received)"
                        " VALUES (%s, %s, '777', %s, %s, %s, %s, %s)",
                        (oid, oid.upper(), PLANT, basic, basic + timedelta(hours=4), sap_basic, locked))
        conn.commit()
    with _conn(pg) as (_c, cur):
        visibility_end, _frozen = pg._horizon_bounds_for_plant(cur, PLANT)
        assert sorted(st._vanish_candidates(cur, PLANT, set(), visibility_end)) == ["zzstg-vk-echo-in", "zzstg-vk-in"]


@pytest.mark.pg
def test_poll_once_supersedes_older_ready_batches(pg, stg_plant):
    row = {"matnr": "12345", "werks": PLANT}
    old = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=30)
    new = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=1)
    incomplete = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=0,
                             expected=5)                               # still loading rows: left alone
    out = st.poll_once(actor="pytest")
    assert out["errors"] == []
    assert _status(pg, old) == "superseded"
    assert _status(pg, new) in ("validated", "applied")               # manual mode unless configured auto
    assert _status(pg, incomplete) == "ready"
    assert any(p.get("batch_id") == str(new) for p in out["processed"])


@pytest.mark.pg
def test_send_to_sap_queues_rolls_up_remembers_and_requeue_retires_old_rows(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=None)
    t0 = datetime(2030, 1, 10, 6, 0)

    def ins(cur, oid, po, *, parent=None, start=t0, status="scheduled", run_time=2, with_dates=True):
        queued = status == "needs_planning"          # orders_planning_state_check: queued = no slot + an object reason
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, parent_production_order,"
            " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time, planning_status,"
            " planning_reason, production_version) VALUES (%s, %s, '777', %s, %s, %s, %s, %s, %s, %s, %s, %s, 'V1')",
            # the STORED finish (start + 3 h) differs from start + run_time (2 h): Send reads the stored one
            (oid, po, PLANT, parent, start if with_dates else None, start + timedelta(hours=2) if with_dates else None,
             start if with_dates and not queued else None, start + timedelta(hours=3) if with_dates and not queued else None,
             run_time if with_dates else None, status,
             Jsonb({"code": "test", "message": "test"}) if queued else None))

    with _conn(pg) as (conn, cur):
        ins(cur, "zzstg-p1", "P1")
        ins(cur, "zzstg-c1", "PAR1-A", parent="PAR1")
        ins(cur, "zzstg-c2", "PAR1-B", parent="PAR1", start=t0 + timedelta(days=1))
        ins(cur, "zzstg-np", "NP", status="needs_planning")
        ins(cur, "zzstg-nd", "ND", with_dates=False)
        ins(cur, "zzstg-uf", "UF")                                        # unfirmed plain order: never queued (OQ61)
        cur.execute("UPDATE orders SET manual_firmed = TRUE WHERE id IN ('zzstg-c1', 'zzstg-p1')")
        conn.commit()
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT id, xmin::text FROM orders WHERE plant = %s ORDER BY id", (PLANT,))
        xmin_initial = dict(cur.fetchall())
    try:
        res = st.queue_send_to_sap(PLANT, actor="pytest")
        with _conn(pg) as (_c, cur):                                      # A2: the FIRST send writes no orders row
            cur.execute("SELECT id, xmin::text FROM orders WHERE plant = %s ORDER BY id", (PLANT,))
            assert dict(cur.fetchall()) == xmin_initial
        assert res["queued"] == 2 and res["skipped_no_end"] == 2 and res["firmed"] == 2
        assert res["skipped_unfirmed"] == 1
        assert res["rolled_up_groups"] == 1 and res["send_batch_id"]
        rows = {r["plnum"]: r for r in st.outbound_rows(PLANT)}
        assert sorted(rows) == ["P1", "PAR1"] and all(r["row_status"] == "ready" for r in rows.values())
        assert rows["PAR1"]["auffx"] == "X" and rows["P1"]["auffx"] == "X"
        child_end = t0 + timedelta(days=1, hours=3)
        d, t = st.plant_local_to_sap(child_end, "UTC")
        assert rows["PAR1"]["pedtr"] == d.isoformat() and rows["PAR1"]["pedti"] == t.isoformat()
        assert st.outbound_status(PLANT)["ready"] == 2

        with _conn(pg) as (_c, cur):
            cur.execute("SELECT id, ss.sent_finish, ss.sent_version, ss.sent_firm, ss.sent_at IS NOT NULL"
                        " FROM orders o LEFT JOIN order_sap_sent ss ON ss.order_id = o.id"
                        " WHERE o.plant = %s ORDER BY id", (PLANT,))
            sent = {r[0]: r[1:] for r in cur.fetchall()}
        assert sent["zzstg-c1"] == (child_end, "V1", True, True)         # children remember the rolled-up end
        assert sent["zzstg-c2"] == (child_end, "V1", True, True)
        assert sent["zzstg-p1"] == (t0 + timedelta(hours=3), "V1", True, True)
        assert sent["zzstg-np"][0] is None and sent["zzstg-nd"][0] is None
        assert sent["zzstg-uf"][0] is None                                # the unfirmed order was not sent, so nothing is remembered

        with _conn(pg) as (_c, cur):
            cur.execute("SELECT id, xmin::text FROM orders WHERE plant = %s ORDER BY id", (PLANT,))
            xmin_before = dict(cur.fetchall())
        again = st.queue_send_to_sap(PLANT, actor="pytest")
        assert again["send_batch_id"] != res["send_batch_id"]
        with _conn(pg) as (_c, cur):                                      # M4: nothing changed -> no row rewritten
            cur.execute("SELECT id, xmin::text FROM orders WHERE plant = %s ORDER BY id", (PLANT,))
            assert dict(cur.fetchall()) == xmin_before
        status = st.outbound_status(PLANT)
        assert (status["ready"], status["error"]) == (2, 2)
        old = st.outbound_rows(PLANT, status="error")
        assert {r["error_text"] for r in old} == {"requeued"}
        with _conn(pg) as (_c, cur):
            cur.execute("SELECT count(*) FROM admin_audit WHERE table_name = 'sap_stage_planned_order_out'"
                        " AND action = 'send_to_sap' AND details->>'plant' = %s", (PLANT,))
            assert cur.fetchone()[0] == 2
    finally:
        with _conn(pg) as (conn, cur):
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM admin_audit WHERE table_name = 'sap_stage_planned_order_out'"
                        " AND details->>'plant' = %s", (PLANT,))
            conn.commit()


@pytest.mark.pg
def test_a_firmed_never_placed_order_is_sent_with_its_sap_finish_and_the_echo_of_it_matches(pg, stg_plant):
    """Review Focus 2 (backward scheduling Task 2.7): a firmed order nobody placed has no stored placement, so
    Send transmits the finish SAP gave it (`original_finish_received`), remembers exactly that value, and SAP
    sending it straight back is an echo (`finish_echoes`) -- it must not read as an SAP change."""
    _set_plant(pg, routing=False, horizon_days=None)
    due = datetime(2030, 2, 5, 14, 30)
    with _conn(pg) as (conn, cur):
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date, basic_finish_date,"
            " original_start_received, original_finish_received, run_time, firming_indicator)"
            " VALUES ('zzstg-fnp', 'FNP', '777', %s, NULL, %s, NULL, %s, 3, 'X')", (PLANT, due, due))
        conn.commit()
    try:
        res = st.queue_send_to_sap(PLANT, actor="pytest")
        assert res["queued"] == 1 and res["firmed"] == 1 and res["skipped_no_end"] == 0
        (row,) = st.outbound_rows(PLANT)
        d, t = st.plant_local_to_sap(due, "UTC")
        assert row["plnum"] == "FNP" and row["auffx"] == "X"
        assert row["pedtr"] == d.isoformat() and row["pedti"] == t.isoformat()
        with _conn(pg) as (_c, cur):
            cur.execute("SELECT sent_finish FROM order_sap_sent WHERE order_id = 'zzstg-fnp'")
            assert cur.fetchone()[0] == due
        # SAP echoes the finish it was sent (date + time in the SAP frame, which is UTC here)
        assert st.finish_echoes(due, False, due, "UTC", "UTC") is True
        assert st.finish_echoes(due.replace(minute=45), False, due, "UTC", "UTC") is False
        before = {"sap_basic_start_date": None, "sap_basic_finish_date": due - timedelta(days=1),
                  "sap_sent_finish": due, "sap_sent_version": None, "tz": "UTC", "scheduled_start": None,
                  "scheduled_end": None}
        echo = {"basic_start_date": due - timedelta(hours=3), "basic_finish_date": due, "_finish_date_only": False}
        assert st.db.sap_changed_fields(before, echo, None, sap_tz="UTC") == set()
    finally:
        with _conn(pg) as (conn, cur):
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM admin_audit WHERE table_name = 'sap_stage_planned_order_out'"
                        " AND details->>'plant' = %s", (PLANT,))
            conn.commit()


# ===========================================================================
# Review round -- pg end-to-end
# ===========================================================================
@pytest.mark.pg
def test_poll_never_auto_applies_an_upload_batch(pg, stg_plant, monkeypatch):
    monkeypatch.setattr(st.sap_sync, "get_config", lambda _k: {"apply_mode": "auto"})
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [{"matnr": "12345", "werks": PLANT}])
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE sap_stage_batch SET source = 'upload' WHERE batch_id = %s", (bid,))
        conn.commit()
    out = st.poll_once(actor="pytest")
    assert out["applied"] == []
    assert any(s.get("batch_id") == str(bid) for s in out["skipped"])
    assert _status(pg, bid) == "validated"


@pytest.mark.pg
def test_incomplete_mulesoft_batch_is_refused_at_validate_and_apply(pg, stg_plant):
    row = {"matnr": "12345", "werks": PLANT}
    short = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], expected=3)
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.validate_batch(short)
    assert ei.value.detail["code"] == "incomplete_rows"
    ok = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row])
    st.validate_batch(ok)
    with _conn(pg) as (conn, cur):                                        # rows change after validation
        cur.execute("INSERT INTO sap_stage_material_plant (batch_id, matnr, werks) VALUES (%s, '99', %s)", (ok, PLANT))
        conn.commit()
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.apply_batch(ok, actor="pytest")
    assert ei.value.detail["code"] == "incomplete_rows"


@pytest.mark.pg
def test_material_absent_sweep_protects_rows_rejected_as_duplicates(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGD1'), ('ZZSTGD2'), ('ZZSTGGONE')")
        cur.execute("INSERT INTO material_plants (material_id, plant) VALUES ('ZZSTGD1', %s), ('ZZSTGD2', %s),"
                    " ('ZZSTGGONE', %s)", (PLANT, PLANT, PLANT))
        conn.commit()
    rows = [{"matnr": f"ZZSTGK{i}", "werks": PLANT} for i in range(3)]
    rows += [{"matnr": "ZZSTGD1", "werks": PLANT}] * 2 + [{"matnr": "ZZSTGD2", "werks": PLANT}] * 2
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", rows)
    res = st.validate_batch(bid)
    assert res["counts"]["by_reason"] == {"duplicate_key": 4}
    st.apply_batch(bid, actor="pytest", confirm_held=res["status"] == "held")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT material_id FROM material_plants WHERE plant = %s"
                    " AND material_id IN ('ZZSTGD1', 'ZZSTGD2', 'ZZSTGGONE') ORDER BY material_id", (PLANT,))
        left = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT count(*) FROM material_plants WHERE plant = %s AND sap_missing_since IS NOT NULL", (PLANT,))
        flagged = cur.fetchone()[0]
    assert left == ["ZZSTGD1", "ZZSTGD2"] and flagged == 0              # protected; only the truly absent one went


@pytest.mark.pg
def test_material_snapshot_deleting_over_25_percent_is_held_then_audited(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO materials (material_id) SELECT 'ZZSTGM' || g FROM generate_series(1, 4) g")
        cur.execute("INSERT INTO material_plants (material_id, plant) SELECT 'ZZSTGM' || g, %s"
                    " FROM generate_series(1, 4) g", (PLANT,))
        conn.commit()
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant",
                      [{"matnr": "ZZSTGM1", "werks": PLANT}])             # 3 of 4 (75 %) would vanish
    res = st.validate_batch(bid)
    assert res["status"] == "held" and "vanish_threshold" in res["held_reasons"]
    assert res["counts"]["vanish_candidates"] == 3
    assert sorted(d["material_id"] for d in st.held_deletions(bid)) == ["ZZSTGM2", "ZZSTGM3", "ZZSTGM4"]
    with pytest.raises(st.BatchNotApplicable):
        st.apply_batch(bid, actor="pytest")
    out = st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert out["counts"]["deleted"] == 3
    with _conn(pg) as (conn, cur):
        cur.execute("SELECT details FROM admin_audit WHERE table_name = 'material_plants'"
                    " AND action = 'sap_snapshot_vanish' AND details->>'batch_id' = %s", (str(bid),))
        det = cur.fetchone()[0]
        cur.execute("DELETE FROM admin_audit WHERE action = 'sap_snapshot_vanish' AND details->>'plant' = %s", (PLANT,))
        conn.commit()
    assert det["deleted_count"] == 3 and det["plant"] == PLANT


@pytest.mark.pg
def test_confirmed_apply_aborts_when_the_reviewed_deletion_set_grew(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, group_counter,"
                    " sequence_no, activity) VALUES (%s, '777', 'N', 'G1', '01', '000010', '0010')", (PLANT,))
        for i in range(1, 5):
            cur.execute("INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                        " basic_finish_date) VALUES (%s, %s, '777', %s, %s, %s)",
                        (f"zzstg-fz{i}", f"FZ{i}", PLANT, soon, soon + timedelta(hours=4)))
        conn.commit()
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                      [{"plnum": "FZ1", "matnr": "777", "plwrk": PLANT, "psttr": soon.strftime("%Y%m%d"),
                        "pstti": "060000", "pedtr": soon.strftime("%Y%m%d"), "pedti": "100000", "gsmng": 10}])
    res = st.validate_batch(bid)
    assert res["counts"]["vanish_candidates"] == 3 and "vanish_keys" not in st.get_batch(bid)["counts"]
    with _conn(pg) as (conn, cur):                                        # 10 more live orders appear after review
        for i in range(5, 15):
            cur.execute("INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                        " basic_finish_date) VALUES (%s, %s, '777', %s, %s, %s)",
                        (f"zzstg-fz{i}", f"FZ{i}", PLANT, soon, soon + timedelta(hours=4)))
        conn.commit()
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert ei.value.detail["code"] == "revalidate_required"


@pytest.mark.pg
def test_resume_of_an_errored_planned_order_batch_reruns_the_gates(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=30)                        # routing off -> routing_required
    start = (datetime.utcnow() + timedelta(days=1)).strftime("%Y%m%d")
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                      [{"plnum": "000000001", "matnr": "777", "plwrk": PLANT, "psttr": start, "gsmng": 10}],
                      status="validated")
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE sap_stage_batch SET status = 'error', error = 'upsert: boom' WHERE batch_id = %s", (bid,))
        conn.commit()
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.apply_batch(bid, actor="pytest")
    assert ei.value.detail["code"] == "routing_required"


@pytest.mark.pg
@pytest.mark.parametrize("mismatch", [True, False])
def test_send_transmits_the_stored_finish_whatever_the_run_time_or_mismatch_flag(pg, stg_plant, mismatch):
    _set_plant(pg, routing=False, horizon_days=None)
    t0 = datetime(2030, 1, 10, 6, 0)
    with _conn(pg) as (conn, cur):
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date, basic_finish_date,"
            " scheduled_start, scheduled_end, run_time, runtime_schedule_mismatch, planning_status, manual_firmed)"
            " VALUES ('zzstg-rm', 'RM1', '777', %s, %s, %s, %s, %s, 2, %s, 'scheduled', TRUE)",
            (PLANT, t0, t0 + timedelta(hours=9), t0, t0 + timedelta(hours=9), mismatch))
        conn.commit()
    try:
        st.queue_send_to_sap(PLANT, actor="pytest")
        row = st.outbound_rows(PLANT)[0]
        d, t = st.plant_local_to_sap(t0 + timedelta(hours=9), "UTC")       # the stored finish, not start+run_time
        assert (row["pedtr"], row["pedti"]) == (d.isoformat(), t.isoformat())
    finally:
        with _conn(pg) as (conn, cur):
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM admin_audit WHERE table_name = 'sap_stage_planned_order_out'"
                        " AND details->>'plant' = %s", (PLANT,))
            conn.commit()


# ===========================================================================
# Reviewer round 3 (B1-B18) -- pure regressions
# ===========================================================================
class _FakeConn:
    """Pool-connection stand-in: scripted fetchone() answers, records statements, optional unlock failure."""

    def __init__(self, ones=(), fail_on=None):
        self.ones = list(ones)
        self.executed = []
        self.fail_on = fail_on
        self.closed = False
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return self

    def execute(self, statement, params=None):
        text = str(statement)
        self.executed.append((text, params))
        if self.fail_on and self.fail_on in text:
            raise RuntimeError("boom")

    def fetchone(self):
        return self.ones.pop(0) if self.ones else None

    def fetchall(self):
        return []

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def close(self):
        self.closed = True


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def connection(self):
        return self.conn


def test_int_or_none_rejects_non_finite_and_fractions_without_overflow():
    assert st._int_or_none("12", "f") == 12 and st._int_or_none(" 7.0 ", "f") == 7 and st._int_or_none("", "f") is None
    for bad in ("inf", "-Infinity", "2.5", "abc"):
        with pytest.raises(ValueError, match="integer"):
            st._int_or_none(bad, "f")
    assert st._int_or_none("2.5", "f", round_fraction=True) == 2
    assert st._int_or_none("3.5", "f", round_fraction=True) == 4            # banker's rounding, same as round()


def test_planned_order_inf_integer_field_is_invalid_int_not_a_crash():
    res = st.validate_planned_order_rows([_planned_stage(id=1, stlan="inf")], "ZZP1", {"ZZP1"})
    assert res[0]["reason"] == "invalid_int"


def test_material_lot_sizes_validated_and_built_without_crashing_on_inf():
    rows = [{"id": 1, "matnr": "1", "werks": "ZZP1", "minls": "inf"},
            {"id": 2, "matnr": "2", "werks": "ZZP1", "ltinc": "abc"},
            {"id": 3, "matnr": "3", "werks": "ZZP1", "minls": Decimal("2.5"), "ltinc": Decimal("5")}]
    res = _by_id(st.validate_material_plant_rows(rows, "ZZP1", {"ZZP1"}))
    assert res[1]["reason"] == "invalid_int" and res[2]["reason"] == "invalid_int" and res[3]["status"] == "valid"
    stage = [{"id": 1, "matnr": "1", "werks": "ZZP1", "minls": Decimal("Infinity"), "material_id": "1", "plant": "ZZP1"}]
    built = st.build_material_plant_rows(stage, _fmap(_MATERIAL_MAP), [])
    assert "min_lot_size" not in built[0]


def test_coerce_for_column_integer_columns_reject_inf_and_fractions():
    for bad in ("inf", "1.5"):
        with pytest.raises(ValueError):
            st._coerce_for_column(bad, "integer")
    with pytest.raises(ValueError):
        st._coerce_for_column("inf", "numeric")


def test_supersede_older_can_be_limited_to_uploads():
    cur = _RecCursor([[]])
    st.supersede_older(cur, "stage_planned_orders", "ZZP1", uuid.uuid4(), source="upload")
    stmt, params = cur.executed[0]
    assert "source = %s::text" in stmt and params[4] == "upload" and params[5] == "upload"


def test_absent_predicate_skips_the_array_for_an_empty_list():
    assert st._absent_predicate("x", set()) == ("TRUE", ())
    assert st._absent_predicate("x", {"b", "a"}) == ("x <> ALL(%s)", (["a", "b"],))


def test_zero_row_planned_order_batch_gates_without_an_empty_array(monkeypatch):
    monkeypatch.setattr(st, "_plant_info", lambda cur, plant: {"timezone": None, "routing_enabled": True})
    monkeypatch.setattr(st.db, "_horizon_bounds_for_plant", lambda cur, plant: (datetime(2026, 11, 1), None))

    class Cur(_RecCursor):
        def fetchone(self):
            return (True,) if "routing_operation" in self.executed[-1][0] else (4, 4)

    cur = Cur()
    info, _w, held, _ve = st._planned_order_gates(cur, "ZZP1", set())
    assert info["in_horizon_live"] == 4 and info["vanish_candidates"] == 4 and "vanish_threshold" in held
    assert info["horizon_end_present"] is True
    assert all("ALL(" not in stmt for stmt, _ in cur.executed)
    cur2 = _RecCursor([[]])
    assert st._vanish_candidates(cur2, "ZZP1", set(), datetime(2026, 11, 1)) == []
    assert "ALL(" not in cur2.executed[0][0]


def test_zero_row_material_batch_is_held_empty_snapshot_not_an_error(monkeypatch):
    monkeypatch.setattr(st, "_known_plants", lambda cur, plants: {"ZZP1"})
    monkeypatch.setattr(st, "_fetch_rows", lambda *a, **k: [])
    monkeypatch.setattr(st, "_master_gate", lambda *a, **k: (
        {"in_horizon_live": 3, "vanish_candidates": 3, "vanish_pct": 1.0},
        [{"code": "vanish_threshold"}], ["vanish_threshold"], [("A",), ("B",), ("C",)]))
    cur = _ScriptCursor([_hdr_row(status="ready", expected=0), (0,)])
    out = st._validate(cur, uuid.uuid4())
    assert out["status"] == "held" and "empty_snapshot" in out["held_reasons"]


def test_validate_sets_a_transaction_local_statement_timeout_first():
    cur = _ScriptCursor([_hdr_row(status="ready", expected=5), (3,)])
    with pytest.raises(st.BatchNotApplicable):
        st._validate(cur, uuid.uuid4())
    first = cur.executed[0][0]
    assert "SET LOCAL statement_timeout" in first and str(st.STATEMENT_TIMEOUT_MS) in first


def test_validate_rejects_a_header_naming_an_unknown_plant(monkeypatch):
    monkeypatch.setattr(st, "_known_plants", lambda cur, plants: set())
    monkeypatch.setattr(st, "_fetch_rows", lambda *a, **k: [])
    cur = _ScriptCursor([_hdr_row(status="ready", expected=0), (0,)])
    out = st._validate(cur, uuid.uuid4())
    assert out["status"] == "rejected" and out["warnings"][0]["code"] == "unknown_plant"
    assert any("error = 'unknown_plant'" in s for s, _ in cur.executed)


def test_header_plant_is_trimmed():
    row = list(_hdr_row())
    row[2] = " ZZP1  "
    assert st._header_dict(tuple(row))["plant"] == "ZZP1"


def test_frozen_vanish_reads_the_raw_list_and_regate_refuses_an_unconfirmed_trip():
    cur = _ScriptCursor([(["a", "b"], "true", "true")])
    assert st._frozen_vanish(cur, uuid.uuid4()) == {"keys": {"a", "b"}, "confirmed": True}
    assert st._frozen_vanish(_ScriptCursor([(["a"], "false", None)]), uuid.uuid4())["keys"] is None   # over the cap
    assert st._frozen_vanish(_ScriptCursor([(None, None, None)]), uuid.uuid4())["keys"] is None       # legacy batch
    with pytest.raises(st.BatchNotApplicable) as ei:
        st._regate_deletion(10, 3, False, "orders")
    assert ei.value.detail["code"] == "vanish_threshold"
    st._regate_deletion(10, 3, True, "orders")
    st._regate_deletion(10, 2, False, "orders")


def test_apply_batch_refuses_when_another_apply_holds_the_object_plant_lock(monkeypatch):
    conn = _FakeConn([_hdr_row(status="validated"), (False,)])
    monkeypatch.setattr(st, "_pool", _FakePool(conn))
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.apply_batch(uuid.uuid4(), actor="pytest")
    assert ei.value.detail["code"] == "apply_in_progress"
    lock = [p for s, p in conn.executed if "pg_try_advisory_lock" in s][0]
    assert lock == ("sap:apply:stage_material_plants:ZZP1",)         # per object + plant, not per batch


def test_apply_batch_closes_the_connection_when_unlock_fails(monkeypatch):
    conn = _FakeConn([_hdr_row(status="validated"), (True,)], fail_on="pg_advisory_unlock")
    monkeypatch.setattr(st, "_pool", _FakePool(conn))
    monkeypatch.setattr(st, "_apply_locked", lambda *a, **k: {"status": "applied"})
    logged = []
    monkeypatch.setattr(st, "_log", lambda level, msg, **ctx: logged.append((level, msg, ctx)))
    assert st.apply_batch(uuid.uuid4(), actor="pytest") == {"status": "applied"}
    assert conn.closed is True
    assert any(level == "error" and isinstance(ctx.get("exc"), RuntimeError) for level, _m, ctx in logged)


def test_apply_batch_keeps_the_connection_when_unlock_succeeds(monkeypatch):
    conn = _FakeConn([_hdr_row(status="validated"), (True,)])
    monkeypatch.setattr(st, "_pool", _FakePool(conn))
    monkeypatch.setattr(st, "_apply_locked", lambda *a, **k: {})
    st.apply_batch(uuid.uuid4(), actor="pytest")
    assert conn.closed is False
    assert any("pg_advisory_unlock" in s for s, _ in conn.executed)
    assert any("SET statement_timeout" in s for s, _ in conn.executed)


def test_bulk_delete_blocks_only_reference_errors(monkeypatch):
    blocked_msg = "Cannot apply change to 'material_plants': it is referenced by or references other rows."
    logged = []
    monkeypatch.setattr(st, "_log", lambda level, msg, **ctx: logged.append((level, msg, ctx)))
    calls = []

    def reference_then_ok(table, ops, actor):
        calls.append(1)
        if len(calls) == 1:
            raise ValueError(blocked_msg)

    monkeypatch.setattr(st.md, "bulk_apply", reference_then_ok)
    keys = [{"material_id": str(i), "plant": "P"} for i in range(600)]          # chunks of 500 / 100
    done, blocked = st._bulk_delete("material_plants", keys, "pytest", "bid-2")
    assert len(blocked) == 500 and len(done) == 100
    assert logged and logged[0][2]["batch_id"] == "bid-2" and logged[0][2]["rows"] == 500

    def other_error(table, ops, actor):
        raise ValueError("Column 'x' is a system column")

    monkeypatch.setattr(st.md, "bulk_apply", other_error)
    with pytest.raises(ValueError, match="system column"):
        st._bulk_delete("material_plants", keys, "pytest", "bid-3")


def test_mark_rejected_at_apply_writes_reasons_and_logs(monkeypatch):
    conn = _FakeConn()
    logged = []
    monkeypatch.setattr(st, "_log", lambda level, msg, **ctx: logged.append((level, msg, ctx)))
    st._mark_rejected_at_apply(conn, "sap_stage_planned_order", "bid-1", [(7, "invalid_date"), (9, "invalid_int")])
    stmt, params = conn.executed[0]
    assert "row_status = 'rejected'" in stmt and "row_status = 'valid'" in stmt
    assert params == ([7, 9], ["invalid_date", "invalid_int"], "bid-1") and conn.commits == 1
    assert logged[0][0] == "warn" and logged[0][2]["batch_id"] == "bid-1" and logged[0][2]["count"] == 2
    conn2 = _FakeConn()
    st._mark_rejected_at_apply(conn2, "t", "bid", [])
    assert conn2.executed == []


def test_build_order_rows_reports_each_unbuildable_row_with_a_reason():
    stage = [_planned_stage(id=1), _planned_stage(id=2, stlan="inf"), _planned_stage(id=3, psttr="2026-99-99")]
    rows, problems = st.build_order_rows(stage, "UTC", _fmap(_PLANNED_MAP))
    assert [r["_stage_row_id"] for r in rows] == [1]
    assert dict(problems) == {2: "invalid_int", 3: "invalid_date"}


def test_poll_error_keeps_the_exception_class_and_logs_with_the_batch_id(monkeypatch):
    logged = []
    monkeypatch.setattr(st, "_log", lambda level, msg, **ctx: logged.append((level, msg, ctx)))
    out = {"errors": []}
    exc = KeyError("nope")
    st._poll_error(out, exc, batch_id="bid-1", object_key="stage_planned_orders")
    assert out["errors"] == [{"object_key": "stage_planned_orders", "batch_id": "bid-1", "error": "KeyError: 'nope'"}]
    assert logged[0][0] == "error" and logged[0][2]["exc"] is exc and logged[0][2]["batch_id"] == "bid-1"
    st._poll_error(out, ValueError("x"), step="sweeps")
    assert out["errors"][1] == {"step": "sweeps", "error": "ValueError: x"}


def test_snapshot_vanish_audit_is_written_before_the_deletes_and_finished_after():
    conn = _FakeConn([(42,)])
    audit_id = st._audit_snapshot_vanish_begin(conn, "material_plants", "bid-1", "ZZP1", "pytest", ["A", "B"])
    assert audit_id == 42 and "INSERT INTO admin_audit" in conn.executed[0][0] and conn.commits == 1
    st._audit_snapshot_vanish_finish(conn, audit_id, ["A"], 1)
    assert "UPDATE admin_audit" in conn.executed[1][0] and conn.executed[1][1][1] == 42
    assert st._audit_snapshot_vanish_begin(_FakeConn(), "t", "b", "p", "a", []) is None
    st._audit_snapshot_vanish_finish(_FakeConn(), None, [], 0)


def test_mulesoft_role_file_does_not_grant_server_owned_header_columns():
    path = os.path.join(ROOT, "migrations", "manual", "2026-10-08-nimbus-mulesoft-role.sql")
    with open(path, encoding="utf-8") as source:
        text = source.read()
    grant = next(line for line in text.splitlines() if line.startswith("GRANT INSERT (batch_id"))
    assert "received_at" not in grant and "ready_at" not in grant and "created_by" not in grant
    assert "NEW.received_at := now()" in text and "NEW.ready_at := now()" in text   # the trigger owns the clocks
    assert "status" not in grant                                    # status always starts 'loading' (7.2 must not name it)
    assert "sap_stage_row_mulesoft_guard" in text and "BEFORE INSERT ON %I" in text   # no late rows / rows into upload batches
    assert "CONNECTION LIMIT" in text
    assert "sap_stage_out_mulesoft_guard" in text and "OLD.row_status = 'ready' AND NEW.row_status IN ('sent', 'error')" in text   # outbound rows never leave sent/error


# ===========================================================================
# Reviewer round 3 -- pg regressions
# ===========================================================================
@pytest.mark.pg
def test_apply_refuses_while_another_apply_for_the_object_and_plant_runs(pg, stg_plant):
    row = {"matnr": "12345", "werks": PLANT}
    b_batch = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=5)
    a_batch = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=1)
    st.validate_batch(a_batch)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE sap_stage_batch SET status = 'applying' WHERE batch_id = %s", (b_batch,))
        conn.commit()
    key = f"sap:apply:stage_material_plants:{PLANT}"
    with pg._pool.connection() as holder:                               # B's apply, running in another session
        with holder.cursor() as hcur:
            hcur.execute("SELECT pg_advisory_lock(hashtext(%s))", (key,))
        holder.commit()
        try:
            with pytest.raises(st.BatchNotApplicable) as ei:
                st.apply_batch(a_batch, actor="pytest")
            assert ei.value.detail["code"] == "apply_in_progress"
        finally:
            with holder.cursor() as hcur:
                hcur.execute("SELECT pg_advisory_unlock(hashtext(%s))", (key,))
            holder.commit()


@pytest.mark.pg
def test_same_instant_batches_have_exactly_one_winner(pg, stg_plant):
    row = {"matnr": "12345", "werks": PLANT}
    a = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row])
    b = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row])
    with _conn(pg) as (conn, cur):
        # Relative to now so the shared instant always sits inside the 7-day retention window.
        cur.execute("UPDATE sap_stage_batch SET received_at = date_trunc('second', now()) - interval '1 hour',"
                    " ready_at = date_trunc('second', now()) - interval '1 hour' + interval '1 second'"
                    " WHERE batch_id IN (%s, %s)", (a, b))
        conn.commit()
    out = st.poll_once(actor="pytest")
    winner, loser = (a, b) if str(a) > str(b) else (b, a)
    assert out["errors"] == []
    assert _status(pg, loser) == "superseded" and _status(pg, winner) in ("validated", "applied")


@pytest.mark.pg
def test_a_ready_batch_with_an_unknown_object_key_is_rejected_by_the_poll(pg, stg_plant):
    bid = uuid.uuid4()
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO sap_stage_batch (batch_id, object_key, plant, source, status, row_count_expected,"
                    " ready_at) VALUES (%s, 'stage_bogus', %s, 'mulesoft', 'ready', 0, now())", (bid, PLANT))
        conn.commit()
    st.poll_once(actor="pytest")
    assert _status(pg, bid) == "rejected"
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT error FROM sap_stage_batch WHERE batch_id = %s", (bid,))
        assert cur.fetchone()[0] == "unknown_object_key"


@pytest.mark.pg
def test_padded_header_plant_still_validates_against_trimmed_rows(pg, stg_plant):
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [{"matnr": "12345", "werks": PLANT}])
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE sap_stage_batch SET plant = %s WHERE batch_id = %s", (f" {PLANT} ", bid))
        conn.commit()
    assert st.validate_batch(bid)["counts"]["valid"] == 1


@pytest.mark.pg
def test_a_missing_key_material_row_still_protects_the_live_row_from_the_sweep(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGB1'), ('ZZSTGB2')")
        cur.execute("INSERT INTO material_plants (material_id, plant) VALUES ('ZZSTGB1', %s), ('ZZSTGB2', %s)",
                    (PLANT, PLANT))
        conn.commit()
    rows = [{"matnr": "ZZSTGB1", "werks": ""}, {"matnr": "ZZSTGB2", "werks": PLANT}]      # blank plant on the first
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", rows)
    res = st.validate_batch(bid)
    assert res["counts"]["by_reason"] == {"missing_key": 1}
    st.apply_batch(bid, actor="pytest", confirm_held=res["status"] == "held")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT material_id FROM material_plants WHERE plant = %s AND material_id LIKE 'ZZSTGB%%'"
                    " ORDER BY 1", (PLANT,))
        assert [r[0] for r in cur.fetchall()] == ["ZZSTGB1", "ZZSTGB2"]


@pytest.mark.pg
def test_a_routing_with_blank_activity_ops_survives_the_snapshot_sweep(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGR1')")
        cur.execute("INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, group_counter,"
                    " sequence_no, activity) VALUES (%s, 'ZZSTGR1', 'N', 'G1', '01', '000010', '0010')", (PLANT,))
        conn.commit()
    bid = _make_batch(pg, "stage_routing_operation", "sap_stage_routing_operation",
                      [{"plant": PLANT, "material_id": "ZZSTGR1", "task_list_type": "N", "routing_group": "G1",
                        "group_counter": "01", "sequence_no": "10", "activity": ""}])
    res = st.validate_batch(bid)
    assert res["counts"]["by_reason"].get("missing_key") == 1
    assert res["counts"]["vanish_candidates"] == 0                      # the group is protected at validation


def _live_orders(pg, n, start, prefix="FZ"):
    with _conn(pg) as (conn, cur):
        for i in range(1, n + 1):
            cur.execute("INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                        " basic_finish_date) VALUES (%s, %s, '777', %s, %s, %s)",
                        (pg.make_id(f"{prefix}{i}", "777"), f"{prefix}{i}", PLANT, start, start + timedelta(hours=4)))
        cur.execute("INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, group_counter,"
                    " sequence_no, activity) VALUES (%s, '777', 'N', 'G1', '01', '000010', '0010')"
                    " ON CONFLICT DO NOTHING", (PLANT,))
        conn.commit()


def _snapshot_row(po, start):
    return {"plnum": po, "matnr": "777", "plwrk": PLANT, "psttr": start.strftime("%Y%m%d"), "pstti": "060000",
            "pedtr": start.strftime("%Y%m%d"), "pedti": "100000", "gsmng": 10}


@pytest.mark.pg
def test_orders_created_after_review_are_never_deleted_by_the_apply(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 4, soon)
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("FZ1", soon)])
    res = st.validate_batch(bid)
    assert res["status"] == "held" and res["counts"]["vanish_candidates"] == 3
    _live_orders(pg, 1, soon, prefix="NEW")                              # a planner adds an order after the review
    out = st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert out["counts"]["deleted"] == 3
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT production_order FROM orders WHERE plant = %s ORDER BY production_order", (PLANT,))
        assert [r[0] for r in cur.fetchall()] == ["FZ1", "NEW1"]


@pytest.mark.pg
def test_horizon_set_after_an_unlimited_review_forces_revalidation(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=None)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 4, soon)
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("FZ1", soon)])
    res = st.validate_batch(bid)
    assert res["status"] == "validated" and res["counts"]["horizon_end_present"] is False
    _set_plant(pg, routing=True, horizon_days=30)
    with pytest.raises(st.BatchNotApplicable) as ei:
        st.apply_batch(bid, actor="pytest")
    assert ei.value.detail["code"] == "revalidate_required"


@pytest.mark.pg
def test_zero_open_reset_leaves_a_planners_reslot_alone_on_an_unchanged_batch(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=3)
    _live_orders(pg, 1, soon, prefix="ZO")
    row = {**_snapshot_row("ZO1", soon), "gsmng": 10, "abmng": 10}      # open quantity 0
    first = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [row])
    st.validate_batch(first)
    st.apply_batch(first, actor="pytest")
    with _conn(pg) as (conn, cur):                                       # the planner re-slots the order
        # ...with a hand-keyed run time (the resolver never loads manual rows; this plant has no production
        # version, so a NULL run time would be re-resolved and held on every apply whatever SAP sent).
        cur.execute("UPDATE orders SET planning_status = 'scheduled', planning_reason = NULL,"
                    " scheduled_start = %s, scheduled_end = %s, run_time = 2, run_time_source = 'manual'"
                    " WHERE plant = %s AND production_order = 'ZO1'",
                    (soon, soon + timedelta(hours=2), PLANT))
        conn.commit()
    second = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [row], age_minutes=-1)
    st.validate_batch(second)
    st.apply_batch(second, actor="pytest")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT planning_status FROM orders WHERE plant = %s AND production_order = 'ZO1'", (PLANT,))
        assert cur.fetchone()[0] == "scheduled"                          # unchanged SAP row: not rewritten


@pytest.mark.pg
def test_zero_open_sweep_clears_the_stale_flag_and_the_placement_marker(pg, stg_plant):
    """Backward scheduling: an order swept into Needs Planning has no bar, so it keeps neither the stale-run-time
    flag nor a placement marker."""
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=3)
    _live_orders(pg, 1, soon, prefix="ZO")
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s, run_time = 2, run_time_source = 'manual',"
                    " runtime_schedule_mismatch = TRUE, placement_exception = 'overtime'"
                    " WHERE plant = %s AND production_order = 'ZO1'",
                    (soon, soon + timedelta(hours=5), PLANT))
        conn.commit()
    row = {**_snapshot_row("ZO1", soon), "gsmng": 10, "abmng": 10}      # open quantity 0
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [row])
    st.validate_batch(bid)
    st.apply_batch(bid, actor="pytest")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT planning_status, scheduled_start, runtime_schedule_mismatch, placement_exception"
                    " FROM orders WHERE plant = %s AND production_order = 'ZO1'", (PLANT,))
        assert cur.fetchone() == ("needs_planning", None, False, None)


@pytest.mark.pg
def test_unbuildable_rows_are_rejected_at_apply_never_stamped_applied(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 1, soon)
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("FZ1", soon)])
    st.validate_batch(bid)
    with _conn(pg) as (conn, cur):                                       # passed validation, unbuildable at apply
        cur.execute("INSERT INTO sap_stage_planned_order (batch_id, plnum, matnr, plwrk, psttr, pstti, pedtr, pedti,"
                    " gsmng, row_status, production_order, material_id, plant)"
                    " VALUES (%s, 'FZ2', '777', %s, %s, '060000', %s, '999999', 10, 'valid', 'FZ2', '777', %s)",
                    (bid, PLANT, soon.strftime("%Y%m%d"), soon.strftime("%Y%m%d"), PLANT))
        # the completeness gate re-counts at apply: keep the header's expected count in step with the extra row
        cur.execute("UPDATE sap_stage_batch SET row_count_expected = 2 WHERE batch_id = %s", (bid,))
        conn.commit()
    st.apply_batch(bid, actor="pytest", confirm_held=True)
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT row_status, reject_reason FROM sap_stage_planned_order WHERE batch_id = %s"
                    " AND plnum = 'FZ2'", (bid,))
        status, reason = cur.fetchone()
    assert status == "rejected" and reason


@pytest.mark.pg
def test_outbound_error_rows_age_out_with_the_sent_rows(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        for status in ("sent", "error", "ready"):
            cur.execute("INSERT INTO sap_stage_planned_order_out (send_batch_id, plant, matnr, plwrk, plnum, row_status,"
                        " queued_at) VALUES (%s, %s, '777', %s, %s, %s, now() - interval '40 days')",
                        (uuid.uuid4(), PLANT, PLANT, f"OLD-{status}", status))
        conn.commit()
    try:
        st.poll_once(actor="pytest")
        with _conn(pg) as (_c, cur):
            cur.execute("SELECT plnum FROM sap_stage_planned_order_out WHERE plant = %s ORDER BY plnum", (PLANT,))
            assert [r[0] for r in cur.fetchall()] == ["OLD-ready"]
    finally:
        with _conn(pg) as (conn, cur):
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE plant = %s", (PLANT,))
            conn.commit()


@pytest.mark.pg
def test_an_upload_batch_does_not_supersede_a_validated_mulesoft_batch(pg, stg_plant):
    row = {"matnr": "12345", "werks": PLANT}
    mule = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row], age_minutes=5)
    st.validate_batch(mule)
    up = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [row])
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE sap_stage_batch SET source = 'upload' WHERE batch_id = %s", (up,))
        st.supersede_older(cur, "stage_material_plants", PLANT, up, source="upload")
        conn.commit()
    assert _status(pg, mule) == "validated"
    st.apply_batch(mule, actor="pytest")                                # not blocked by the newer upload


# ===========================================================================
# Validation plan section 2 -- remaining proof lines
# ===========================================================================
@pytest.mark.pg
def test_resume_after_a_crash_mid_vanish_reaches_applied_without_double_delete_or_duplicate_archive(
        pg, stg_plant, monkeypatch):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 4, soon)
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("FZ1", soon)])
    assert st.validate_batch(bid)["status"] == "held"                      # 3 of 4 would vanish
    real_purge = st.db.purge_orders_by_ids
    calls = {"n": 0}

    def crash_after_commit(*a, **kw):
        real_purge(*a, **kw)                                               # the delete + archive really commit
        calls["n"] += 1
        raise RuntimeError("forced crash after the purge committed")

    monkeypatch.setattr(st.db, "purge_orders_by_ids", crash_after_commit)
    with pytest.raises(RuntimeError, match="forced crash"):
        st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert _status(pg, bid) == "error" and calls["n"] == 1
    monkeypatch.setattr(st.db, "purge_orders_by_ids", real_purge)
    out = st.apply_batch(bid, actor="pytest")                              # resume: the confirmation is remembered
    assert out["status"] == "applied"
    assert out["counts"]["deleted"] == 0                                   # nothing left to delete a second time
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT production_order FROM orders WHERE plant = %s ORDER BY 1", (PLANT,))
        assert [r[0] for r in cur.fetchall()] == ["FZ1"]
        cur.execute("SELECT order_row->>'production_order', count(*) FROM sap_stage_vanished_order"
                    " WHERE plant = %s GROUP BY 1 ORDER BY 1", (PLANT,))
        assert cur.fetchall() == [("FZ2", 1), ("FZ3", 1), ("FZ4", 1)]     # one archive row per order, no duplicates


@pytest.mark.pg
def test_a_running_order_that_vanished_from_the_snapshot_is_deleted_and_archived(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)                           # D21: deliberate, even while running
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 4, soon)
    now = datetime.utcnow()
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE plant = %s"
                    " AND production_order = 'FZ2'", (now - timedelta(hours=1), now + timedelta(hours=1), PLANT))
        conn.commit()
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("FZ1", soon)])
    assert st.validate_batch(bid)["status"] == "held"
    # The deletion review marks the running order so the admin is told before confirming.
    assert {d["production_order"]: d["running"] for d in st.held_deletions(bid)} == {"FZ2": True, "FZ3": False, "FZ4": False}
    out = st.apply_batch(bid, actor="pytest", confirm_held=True)
    assert out["counts"]["deleted"] == 3 and out["counts"]["archived"] == 3
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT count(*) FROM orders WHERE plant = %s AND production_order = 'FZ2'", (PLANT,))
        assert cur.fetchone()[0] == 0
    assert "FZ2" in {a["production_order"] for a in st.list_archived(PLANT)}


@pytest.mark.pg
def test_24_percent_missing_applies_without_confirmation_and_26_percent_is_held(pg, stg_plant):
    """The 25 % boundary end to end: 50 live in-horizon orders, a snapshot of 38 (12 missing = 24 %) applies
    straight from `validated`; a snapshot of 37 (13 missing = 26 %) is held and needs confirmation."""
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 50, soon)
    ok = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                     [_snapshot_row(f"FZ{i}", soon) for i in range(1, 39)])
    res = st.validate_batch(ok)
    assert res["status"] == "validated", res
    assert res["counts"]["in_horizon_live"] == 50 and res["counts"]["vanish_candidates"] == 12
    out = st.apply_batch(ok, actor="pytest")                                 # no confirm_held needed
    assert out["status"] == "applied" and out["counts"]["deleted"] == 12
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT count(*) FROM orders WHERE plant = %s", (PLANT,))
        assert cur.fetchone()[0] == 38
    _live_orders(pg, 12, soon, prefix="FY")                                  # back to 50 live orders
    held = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                       [_snapshot_row(f"FZ{i}", soon) for i in range(1, 38)], age_minutes=-1)
    res = st.validate_batch(held)
    assert res["status"] == "held" and "vanish_threshold" in res["held_reasons"], res
    assert res["counts"]["vanish_candidates"] == 13
    with pytest.raises(st.BatchNotApplicable):
        st.apply_batch(held, actor="pytest")                                 # 26 % needs confirmation


@pytest.mark.pg
def test_a_second_concurrent_poll_skips_while_the_first_holds_the_advisory_lock(pg, stg_plant):
    bid = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [{"matnr": "12345", "werks": PLANT}])
    with pg._pool.connection() as holder:                                   # the first poll, running in another session
        with holder.cursor() as hcur:
            hcur.execute("SELECT pg_advisory_lock(hashtext('sap:staging-poll'))")
        holder.commit()
        try:
            out = st.poll_once(actor="pytest")
            assert out["skipped"] == [{"reason": "another poll is running"}]
            assert out["processed"] == [] and out["errors"] == []
            assert _status(pg, bid) == "ready"                              # untouched by the skipped poll
        finally:
            with holder.cursor() as hcur:
                hcur.execute("SELECT pg_advisory_unlock(hashtext('sap:staging-poll'))")
            holder.commit()
    assert st.poll_once(actor="pytest")["skipped"] == []                    # lock released: the next poll runs


@pytest.mark.pg
def test_sap_apply_keeps_excel_only_values_on_distributed_children(pg, stg_plant):
    """Track 4 / E2: a SAP planned-order row carries no description / labor / FTE keys, so a distributed
    parent's header facts and every child keep what the Excel upload stored (the plain-order rule)."""
    import backend.distribution.data as dd
    import backend.routing.resolver as rr
    import db as db_
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES (%s, 'ZZWCD',"
                    " 'distribute')", (PLANT,))
        cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight)"
                    " VALUES (%s, %s, 'ZZMA', 'ZZWCD', 1), (%s, %s, 'ZZMB', 'ZZWCD', 1)", (SUB, PLANT, SUB, PLANT))
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGDIST') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO material_plants (material_id, plant) VALUES ('ZZSTGDIST', %s)", (PLANT,))
        conn.commit()
    start = datetime(2030, 1, 10, 6, 0)
    excel_row = {"production_order": "9000001", "material_number": "ZZSTGDIST", "machine": "ZZWCD", "plant": PLANT,
                 "basic_start_date": start, "basic_finish_date": start + timedelta(hours=8), "run_time": 8.0,
                 "order_quantity": 100.0, "material_description": "Excel description", "labor_hours": 10.0,
                 "no_of_fte": 2.0, "form_size": "XL"}
    db_.upsert_orders([dict(excel_row)], source="excel", filename="t.xlsx", plan_fn=dd.plan, apply_fn=dd.apply,
                      resolve_fn=rr.resolve_orders)
    sap_row = {k: v for k, v in excel_row.items()
               if k not in ("material_description", "labor_hours", "no_of_fte", "form_size")}
    db_.upsert_orders([sap_row], source="sap", plan_fn=dd.plan, apply_fn=dd.apply, resolve_fn=rr.resolve_orders)
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT material_description, form_size, labor_hours, no_of_fte FROM orders"
                    " WHERE plant = %s AND parent_production_order = '9000001' ORDER BY machine", (PLANT,))
        kids = cur.fetchall()
        cur.execute("SELECT sap_facts FROM order_distribution WHERE plant = %s AND production_order = '9000001'",
                    (PLANT,))
        facts = cur.fetchone()[0]
    assert len(kids) == 2
    for desc, form, labor, fte in kids:
        assert desc == "Excel description" and form == "XL" and fte == 2 and float(labor) == 5.0
    assert facts["material_description"] == "Excel description"


@pytest.mark.pg
def test_partial_conversion_keeps_the_slot_for_plain_and_distributed_orders(pg, stg_plant):
    """Track 4 / E3b (D15 / A3): SAP raising the reduced quantity while the total stays the same is not a
    quantity change -- it must not unschedule a plain order or the children of a distributed aggregate; a
    different TOTAL still does."""
    import backend.distribution.data as dd
    import backend.routing.resolver as rr
    import db as db_
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES (%s, 'ZZWCD',"
                    " 'distribute')", (PLANT,))
        cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter, distribution_weight)"
                    " VALUES (%s, %s, 'ZZMA', 'ZZWCD', 1), (%s, %s, 'ZZMB', 'ZZWCD', 1), (%s, %s, 'ZZMP', NULL, NULL)",
                    (SUB, PLANT, SUB, PLANT, SUB, PLANT))
        cur.execute("INSERT INTO materials (material_id) VALUES ('ZZSTGDIST') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO material_plants (material_id, plant) VALUES ('ZZSTGDIST', %s)", (PLANT,))
        conn.commit()
    start = datetime(2030, 1, 10, 6, 0)

    def row(order, machine, total, reduced):
        return {"production_order": order, "material_number": "ZZSTGDIST", "machine": machine, "plant": PLANT,
                "basic_start_date": start, "basic_finish_date": start + timedelta(hours=8), "run_time": 8.0,
                "order_quantity": float(total - reduced), "planned_order_initial_quantity": float(total),
                "reduced_quantity": float(reduced)}

    def go(rows, source):
        db_.upsert_orders(rows, source=source, filename="t.xlsx" if source == "excel" else None,
                          plan_fn=dd.plan, apply_fn=dd.apply, resolve_fn=rr.resolve_orders)

    go([row("9100001", "ZZMP", 400, 0), row("9100002", "ZZWCD", 400, 0)], "excel")
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE plant = %s"
                    " AND (production_order = '9100001' OR parent_production_order = '9100002')",
                    (start + timedelta(hours=1), start + timedelta(hours=9), PLANT))
        conn.commit()

    def slots():
        with _conn(pg) as (_c, cur):
            cur.execute("SELECT production_order, scheduled_start IS NOT NULL FROM orders WHERE plant = %s"
                        " ORDER BY 1", (PLANT,))
            return dict(cur.fetchall())
    assert all(slots().values()) and len(slots()) == 3
    go([row("9100001", "ZZMP", 400, 100), row("9100002", "ZZWCD", 400, 100)], "sap")      # partial conversion
    assert all(slots().values()), slots()
    go([row("9100001", "ZZMP", 500, 100), row("9100002", "ZZWCD", 500, 100)], "sap")      # the TOTAL changed
    assert not any(slots().values()), slots()


@pytest.mark.pg
def test_repeat_material_snapshot_rewrites_nothing(pg, stg_plant):
    """Track 4 / S2: a second identical Material Plant snapshot reports every row unchanged, leaves each
    live row's xmin alone and writes no empty bulk_apply audit row."""
    rows = [{"matnr": f"ZZSTGR{i}", "werks": PLANT, "mmsta": "B2", "minls": 20, "ltinc": 10} for i in range(4)]
    first = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", rows, age_minutes=5)
    st.validate_batch(first)
    out1 = st.apply_batch(first, actor="pytest")
    assert out1["counts"]["inserted"] == 4 and out1["counts"]["unchanged"] == 0

    def snap():
        with _conn(pg) as (_c, cur):
            cur.execute("SELECT material_id, xmin::text FROM material_plants WHERE plant = %s ORDER BY 1", (PLANT,))
            x = dict(cur.fetchall())
            cur.execute("SELECT count(*) FROM admin_audit WHERE table_name = 'material_plants'")
            return x, cur.fetchone()[0]
    x1, audits1 = snap()
    second = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", rows, age_minutes=1)
    st.validate_batch(second)
    out2 = st.apply_batch(second, actor="pytest")
    x2, audits2 = snap()
    assert out2["counts"]["unchanged"] == 4 and out2["counts"]["updated"] == 0 and out2["counts"]["inserted"] == 0
    assert x2 == x1 and audits2 == audits1
    changed = [dict(r, mmsta="C3") if i == 0 else r for i, r in enumerate(rows)]       # one real change is still written
    third = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", changed, age_minutes=0)
    st.validate_batch(third)
    out3 = st.apply_batch(third, actor="pytest")
    assert out3["counts"]["updated"] == 1 and out3["counts"]["unchanged"] == 3


# ---------------------------------------------------------------------------
# Track 5 (failure injection): F7 invalid SAP system zone, F8 19-character order material
# ---------------------------------------------------------------------------
def test_planned_order_material_longer_than_18_is_key_too_long_and_still_protected():
    ok = _planned_stage()
    rows = [{**ok, "id": 1}, {**ok, "id": 2, "plnum": "200", "matnr": "A" * 19}]
    res = _by_id(st.validate_planned_order_rows(rows, "ZZP1", {"ZZP1"}))
    assert res[1]["status"] == "valid"
    assert res[2]["reason"] == "key_too_long"
    assert res[2]["resolved"]["production_order"] == "200"      # the vanish guard still protects the order SAP sent


def test_sap_system_tz_invalid_flag(monkeypatch):
    for good in ("UTC", "America/New_York"):
        monkeypatch.setattr(st, "SAP_SYSTEM_TZ", good)
        assert st.sap_system_tz_invalid() is False
    for bad in ("Not/AZone", "", None):
        monkeypatch.setattr(st, "SAP_SYSTEM_TZ", bad)
        assert st.sap_system_tz_invalid() is True


@pytest.mark.pg
def test_invalid_sap_system_tz_warns_on_every_batch_and_refuses_planned_order_apply_and_send(pg, stg_plant, monkeypatch):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    with _conn(pg) as (conn, cur):
        cur.execute("INSERT INTO routing_operation (plant, material_id, task_list_type, routing_group, group_counter,"
                    " sequence_no, activity) VALUES (%s, '777', 'N', 'G1', '01', '000010', '0010')", (PLANT,))
        conn.commit()
    monkeypatch.setattr(st, "SAP_SYSTEM_TZ", "Not/AZone")
    mat = _make_batch(pg, "stage_material_plants", "sap_stage_material_plant", [{"matnr": "ZZSTGT1", "werks": PLANT}])
    res = st.validate_batch(mat)
    assert res["status"] == "validated"                          # the batch still validates ...
    assert [w["code"] for w in res["warnings"] if w["code"] == "sap_system_tz_invalid"] == ["sap_system_tz_invalid"]
    po = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order",
                     [{"plnum": "PT1", "matnr": "777", "plwrk": PLANT, "psttr": soon.strftime("%Y%m%d"),
                       "pstti": "060000", "pedtr": soon.strftime("%Y%m%d"), "pedti": "100000", "gsmng": 10}])
    res = st.validate_batch(po)
    assert res["status"] == "validated"
    assert any(w["code"] == "sap_system_tz_invalid" for w in res["warnings"])
    with pytest.raises(st.BatchNotApplicable) as ei:             # ... but planned orders never apply on a wrong zone
        st.apply_batch(po, actor="pytest")
    assert ei.value.detail["code"] == "sap_system_tz_invalid"
    assert _status(pg, po) == "validated"
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT count(*) FROM orders WHERE plant = %s", (PLANT,))
        assert cur.fetchone()[0] == 0
    with pytest.raises(ValueError, match="NIMBUS_SAP_SYSTEM_TZ"):
        st.queue_send_to_sap(PLANT, actor="pytest")
    # master objects are not time-dependent: they still apply
    assert st.apply_batch(mat, actor="pytest")["status"] == "applied"
    monkeypatch.setattr(st, "SAP_SYSTEM_TZ", "UTC")              # fixed -> the planned-order batch applies
    assert st.apply_batch(po, actor="pytest")["status"] == "applied"


def test_unreadable_upload_says_so_in_plain_words():
    """Track 9: a file that is not a spreadsheet gets a readable message, not the pandas engine jargon."""
    with pytest.raises(ValueError) as exc:
        st.stage_rows_from_upload("stage_planned_orders", "P1", b"\x00\x01 this is not a spreadsheet", "bad.xlsx", actor="pytest")
    msg = str(exc.value)
    assert msg.startswith("Could not read the file")
    assert "engine" not in msg.lower()

# ===========================================================================
# Backward scheduling D10 / VI12 / VI13: date-only finish, working-window close, plant time zone
# ===========================================================================
def _date_only_order(pg, oid="zzstg-do", machine="ZZSTG-M1"):
    """A firmed, never-placed order whose SAP finish arrived as a date with no time (2030-02-05)."""
    due = datetime(2030, 2, 5, 0, 0)
    with _conn(pg) as (conn, cur):
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, machine, basic_start_date,"
            " basic_finish_date, original_start_received, original_finish_received, original_finish_date_only,"
            " run_time, firming_indicator)"
            " VALUES (%s, 'DO1', '777', %s, %s, NULL, %s, NULL, %s, TRUE, 3, 'X')", (oid, PLANT, machine, due, due))
        conn.commit()


def _clear_outbound(pg):
    with _conn(pg) as (conn, cur):
        cur.execute("DELETE FROM sap_stage_planned_order_out WHERE plant = %s", (PLANT,))
        cur.execute("DELETE FROM admin_audit WHERE table_name = 'sap_stage_planned_order_out'"
                    " AND details->>'plant' = %s", (PLANT,))
        conn.commit()


@pytest.mark.pg
def test_a_date_only_due_on_a_never_placed_firmed_order_is_sent_as_the_working_window_close(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=None)
    _date_only_order(pg)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET timezone = 'Europe/Berlin' WHERE plant = %s", (PLANT,))
        cur.execute("SELECT subnetwork FROM plants WHERE plant = %s", (PLANT,))
        sub = cur.fetchone()[0]
        # 2030-02-05 is a Tuesday: key 2 (0 = Sunday). Closes 22:00.
        cur.execute("INSERT INTO machine_calendar (subnetwork, plant, machine, work_hours) VALUES (%s, %s, %s, %s)",
                    (sub, PLANT, "ZZSTG-M1", Jsonb({"2": [6, 22]})))
        conn.commit()
    try:
        st.queue_send_to_sap(PLANT, actor="pytest")
        (row,) = st.outbound_rows(PLANT)
        d, t = st.plant_local_to_sap(datetime(2030, 2, 5, 22, 0), "Europe/Berlin")
        assert row["pedtr"] == d.isoformat() and row["pedti"] == t.isoformat()
        # the plant closes at 20:00: the line window is intersected with it, so Send transmits 20:00
        with _conn(pg) as (conn, cur):
            cur.execute("UPDATE plants SET work_hours = %s WHERE plant = %s", (Jsonb({"2": [6, 20]}), PLANT))
            conn.commit()
        st.queue_send_to_sap(PLANT, actor="pytest")
        newest = st.outbound_rows(PLANT)[0]
        d, t = st.plant_local_to_sap(datetime(2030, 2, 5, 20, 0), "Europe/Berlin")
        assert newest["pedtr"] == d.isoformat() and newest["pedti"] == t.isoformat()
    finally:
        _clear_outbound(pg)


@pytest.mark.pg
def test_review_focus_4_a_24_00_close_sends_23_59_59_of_the_due_date(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=None)
    _date_only_order(pg)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET timezone = 'Europe/Berlin' WHERE plant = %s", (PLANT,))
        cur.execute("SELECT subnetwork FROM plants WHERE plant = %s", (PLANT,))
        sub = cur.fetchone()[0]
        cur.execute("INSERT INTO machine_calendar (subnetwork, plant, machine, work_hours) VALUES (%s, %s, %s, %s)",
                    (sub, PLANT, "ZZSTG-M1", Jsonb({str(i): [0, 24] for i in range(7)})))
        conn.commit()
    try:
        st.queue_send_to_sap(PLANT, actor="pytest")
        (row,) = st.outbound_rows(PLANT)
        d, t = st.plant_local_to_sap(datetime(2030, 2, 5, 23, 59, 59), "Europe/Berlin")
        assert row["pedtr"] == d.isoformat() and row["pedti"] == t.isoformat()
    finally:
        _clear_outbound(pg)


class _PlantHoursCursor:
    """Fake cursor for `_working_window_close` with no machine: the only query is the plant's default hours."""

    def __init__(self, plant_hours):
        self._row = (plant_hours,) if plant_hours is not None else None

    def execute(self, *_a, **_k):
        pass

    def fetchone(self):
        return self._row


def _period(pid, vf, vt, hours):
    return {"id": pid, "valid_from": vf, "valid_to": vt, "work_hours": hours}


_TUE = date(2030, 2, 5)    # a Tuesday: stored key 2 (0 = Sunday)


def test_a_period_overriding_the_default_on_the_due_date_changes_the_close():
    cur = _PlantHoursCursor({"2": [6, 20]})
    periods = [_period("p", date(2030, 2, 1), None, {"2": [6, 16]})]
    assert st._working_window_close(cur, "P", None, _TUE, periods) == datetime(2030, 2, 5, 16, 0)


def test_a_due_inside_a_period_with_a_closed_weekday_walks_back_into_the_prior_pattern():
    cur = _PlantHoursCursor({"1": [6, 18], "2": [6, 20]})
    periods = [_period("p", _TUE, None, {"1": [6, 15], "2": None})]   # period starts on the due Tuesday and closes it
    assert st._working_window_close(cur, "P", None, _TUE, periods) == datetime(2030, 2, 4, 18, 0)


def test_a_24_hour_period_sends_23_59_59():
    cur = _PlantHoursCursor({"2": [6, 20]})
    periods = [_period("p", date(2030, 2, 1), date(2030, 2, 28), {str(i): [0, 24] for i in range(7)})]
    assert st._working_window_close(cur, "P", None, _TUE, periods) == datetime(2030, 2, 5, 23, 59, 59)


def test_no_periods_behaves_as_before():
    assert st._working_window_close(_PlantHoursCursor({"2": [6, 20]}), "P", None, _TUE, []) == datetime(2030, 2, 5, 20, 0)
    assert st._working_window_close(_PlantHoursCursor(None), "P", None, _TUE, []) == datetime(2030, 2, 5, 23, 59, 59)


def test_a_period_applies_to_its_dates_when_the_plant_has_no_default_hours():
    periods = [_period("p", date(2030, 2, 1), None, {"2": [6, 14]})]
    assert st._working_window_close(_PlantHoursCursor(None), "P", None, _TUE, periods) == datetime(2030, 2, 5, 14, 0)


def test_a_period_not_covering_the_due_date_with_no_default_hours_and_no_line_sends_end_of_day():
    periods = [_period("p", date(2030, 1, 1), date(2030, 2, 1), {"2": [6, 14]})]   # ends before the due Tuesday
    assert st._working_window_close(_PlantHoursCursor(None), "P", None, _TUE, periods) == datetime(2030, 2, 5, 23, 59, 59)


@pytest.mark.pg
def test_send_uses_the_calendar_period_covering_the_due_date(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=None)
    _date_only_order(pg)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET timezone = 'Europe/Berlin', work_hours = %s WHERE plant = %s",
                    (Jsonb({"2": [6, 20]}), PLANT))
        cur.execute("SELECT subnetwork FROM plants WHERE plant = %s", (PLANT,))
        sub = cur.fetchone()[0]
        cur.execute("INSERT INTO plant_calendar_period (subnetwork, plant, period_id, valid_from, valid_to, work_hours)"
                    " VALUES (%s, %s, 'zzstg-p', '2030-02-01', NULL, %s)", (sub, PLANT, Jsonb({"2": [6, 16]})))
        conn.commit()
    try:
        st.queue_send_to_sap(PLANT, actor="pytest")
        (row,) = st.outbound_rows(PLANT)
        d, t = st.plant_local_to_sap(datetime(2030, 2, 5, 16, 0), "Europe/Berlin")
        assert row["pedtr"] == d.isoformat() and row["pedti"] == t.isoformat()
    finally:
        _clear_outbound(pg)
        with _conn(pg) as (conn, cur):
            cur.execute("DELETE FROM plant_calendar_period WHERE plant = %s", (PLANT,))
            conn.commit()


@pytest.mark.pg
def test_send_refuses_a_plant_with_no_time_zone(pg, stg_plant):
    _set_plant(pg, routing=False, horizon_days=None)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET timezone = NULL WHERE plant = %s", (PLANT,))
        conn.commit()
    with pytest.raises(ValueError, match="time zone"):
        st.queue_send_to_sap(PLANT, actor="pytest")


@pytest.mark.pg
def test_ingest_marks_rows_of_a_plant_with_no_time_zone_as_errors(pg, stg_plant):
    """VI13: the rows are rejected at apply (the stage table's own error state) and no orders row is written."""
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 0, soon)
    with _conn(pg) as (conn, cur):
        cur.execute("UPDATE plants SET timezone = NULL WHERE plant = %s", (PLANT,))
        conn.commit()
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [_snapshot_row("NZ1", soon)])
    res = st.validate_batch(bid)
    st.apply_batch(bid, actor="pytest", confirm_held=res["status"] == "held")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT row_status, reject_reason FROM sap_stage_planned_order WHERE batch_id = %s", (bid,))
        assert cur.fetchall() == [("rejected", "plant has no valid time zone")]
        cur.execute("SELECT count(*) FROM orders WHERE plant = %s", (PLANT,))
        assert cur.fetchone()[0] == 0


@pytest.mark.pg
def test_ingest_stores_the_date_only_flag_from_the_sap_time(pg, stg_plant):
    _set_plant(pg, routing=True, horizon_days=30)
    soon = datetime.utcnow() + timedelta(days=1)
    _live_orders(pg, 0, soon)
    date_only = {**_snapshot_row("DO1", soon), "pedti": "000000"}
    timed = {**_snapshot_row("TM1", soon), "pedti": "180000"}
    bid = _make_batch(pg, "stage_planned_orders", "sap_stage_planned_order", [date_only, timed])
    res = st.validate_batch(bid)
    st.apply_batch(bid, actor="pytest", confirm_held=res["status"] == "held")
    with _conn(pg) as (_c, cur):
        cur.execute("SELECT production_order, original_finish_date_only FROM orders WHERE plant = %s"
                    " ORDER BY production_order", (PLANT,))
        assert cur.fetchall() == [("DO1", True), ("TM1", False)]


@pytest.mark.pg
def test_archive_paging_and_literal_search(pg, stg_plant):
    with _conn(pg) as (conn, cur):
        for n in range(65):
            cur.execute(
                "INSERT INTO sap_stage_vanished_order (plant, order_id, order_row, deleted_at)"
                " VALUES (%s, %s, %s, '2026-10-16T00:00:00Z')",
                (PLANT, f"ARCHIVE-{n:03}", Jsonb({"production_order": f"PO-{n:03}",
                                                "material_number": "MAT%_1" if n == 0 else "MAT-other",
                                                "machine": "LINE1"})),
            )
        conn.commit()
    first = st.list_archived(PLANT, limit=50)
    second = st.list_archived(PLANT, limit=50, offset=50)
    assert len(first) == 50 and len(second) == 15
    assert not {r["id"] for r in first} & {r["id"] for r in second}
    assert len(st.list_archived(PLANT, search="mat%_1")) == 1
    assert len(st.list_archived(PLANT, search="line1")) == 65
    assert len(st.list_archived(PLANT, search="po-064")) == 1
    assert st.list_archived("NOT-THIS-PLANT", search="line1") == []
