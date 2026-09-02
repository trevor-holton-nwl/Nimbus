"""
Tests for Stage 1 of docs/scheduling_priority.md ("data plumbing"): the
priority_list table, the material_plants -> orders attribute stamp
(db._stamp_order_attributes / db.resync_order_attributes), the generalized
apply_priority_merge, and the /color-wheel/* legacy-compat repoint.

Two layers, mirroring test_color_wheel_store.py / test_schema_idempotent.py:
  * Pure-logic tests (no DB) pin the registry/schema/DTO shape. These run
    unconditionally, including when .env points at the live Azure DB (which
    makes the @pytest.mark.pg suite refuse to collect).
  * @pytest.mark.pg tests exercise the real tables (auto-skipped when
    Postgres is down or NIMBUS_TEST_DB isn't set) — including the R3 "inverse
    ledger trap" regression: a stamp that runs before material_plants is
    populated must NOT block anything, and a resync afterward must fix it.
"""
import os
import sys
from datetime import datetime

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import brain  # noqa: E402
import master_data as md  # noqa: E402
import backend.setup.data as setup_data  # noqa: E402
from backend.security import auth  # noqa: E402


# ---------------------------------------------------------------------------
# Pure-logic: RANKABLE_FIELDS registry (master_data.py)
# ---------------------------------------------------------------------------
def test_rankable_fields_exposes_only_three_configurable_entries():
    assert set(md.CONFIGURABLE_PRIORITY_FIELDS) == {"colorWheel", "prt01", "prt02"}
    assert md.RANKABLE_FIELDS["colorWheel"] == {
        "mp_column": "color", "orders_column": "color", "task_field": "COLOR",
        "default_label": "Color Wheel",
    }
    assert md.RANKABLE_FIELDS["prt01"] == {
        "mp_column": "prt_01", "orders_column": "prt_01", "task_field": "PRT_01",
        "default_label": "Prod. Resource Tool (01)",
    }
    assert md.RANKABLE_FIELDS["prt02"] == {
        "mp_column": "prt_02", "orders_column": "prt_02", "task_field": "PRT_02",
        "default_label": "Prod. Resource Tool (02)",
    }


def test_production_version_mp_column_is_not_editable_via_attributes_endpoint():
    """default_production_version is SAP-owned and deliberately excluded from
    EDITABLE_MATERIAL_PLANT_ATTRS (see that frozenset's comment) — confirms the
    fourth rankable field is NOT default_machine (an earlier draft's mistake,
    corrected 2026-08-11) and that RANKABLE_FIELDS/EDITABLE_MATERIAL_PLANT_ATTRS
    are allowed to diverge."""
    mp_col = md.RANKABLE_FIELDS["productionVersion"]["mp_column"]
    assert mp_col == "default_production_version"
    assert mp_col not in md.EDITABLE_MATERIAL_PLANT_ATTRS
    for key, spec in md.RANKABLE_FIELDS.items():
        if key == "productionVersion":
            continue
        assert spec["mp_column"] in md.EDITABLE_MATERIAL_PLANT_ATTRS


# ---------------------------------------------------------------------------
# Pure-logic: brain.py surface (renames, retirements, no RANKS on the DTO)
# ---------------------------------------------------------------------------
def test_apply_priority_merge_replaces_apply_color_merge():
    assert hasattr(brain, "apply_priority_merge")
    assert not hasattr(brain, "apply_color_merge")


def test_global_wheel_fallback_is_fully_retired():
    """GLOBAL_CW / COLOR_FILE must not exist as module attributes — the 'Default
    tier: Per-plant only' decision (docs/scheduling_priority.md)."""
    assert not hasattr(brain, "GLOBAL_CW")
    assert not hasattr(brain, "COLOR_FILE")
    assert hasattr(brain, "PLANT_LISTS")
    assert isinstance(brain.PLANT_LISTS, dict)


def test_task_dto_has_new_fields_and_never_a_ranks_field():
    """N2b: ranks are never stamped onto the task DTO — they resolve client-side
    (Stage 3) from separate per-plant maps, precisely because a stamped rank
    goes stale the instant an order changes line."""
    fields = brain.TaskDTO.model_fields
    for f in ("PRT_01", "PRT_02", "PRODUCTION_VERSION"):
        assert f in fields, f"TaskDTO is missing {f}"
    assert "RANKS" not in fields, "TaskDTO must never carry a generic RANKS field (N2b)"


def test_resync_route_is_registered_for_admin_audit_logging():
    assert brain._ADMIN_WRITE_OPERATIONS.get("/master-data/resync-order-attributes") == (
        "material_plants.resync_order_attributes"
    )


def test_priority_list_write_route_is_registered_for_admin_audit_logging():
    assert brain._ADMIN_WRITE_OPERATIONS["/priority-list/{plant}/{field_key}"] == "priority_list.write"


def test_configurable_priority_fields_carry_default_labels():
    expected = {
        'colorWheel': 'Color Wheel',
        'prt01': 'Prod. Resource Tool (01)',
        'prt02': 'Prod. Resource Tool (02)',
    }
    for key, label in expected.items():
        assert md.CONFIGURABLE_PRIORITY_FIELDS[key]['default_label'] == label


def test_new_setup_signatures_reject_retired_production_version():
    with pytest.raises(ValueError, match="Unknown setup field"):
        setup_data._normalise_fields(
            ["productionVersion"], allowed_fields=md.CONFIGURABLE_PRIORITY_FIELDS
        )


def test_priority_fields_endpoint_lists_only_configurable_fields(client):
    r = client.get("/priority-fields")
    assert r.status_code == 200
    body = r.json()
    keys = [f["field_key"] for f in body["fields"]]
    assert keys == ["colorWheel", "prt01", "prt02"]
    color = body["fields"][0]
    assert color == {
        "field_key": "colorWheel", "mp_column": "color", "orders_column": "color",
        "task_field": "COLOR", "default_label": "Color Wheel",
    }


def test_row_order_sentinel_forces_row_order_over_an_auto_detectable_column():
    """The mapping modal's "— use row order —" option used to send rank_column=''
    which is falsy, so the backend fell through to auto-detection and could rank
    by a column (here ORDER) the user had just explicitly declined — silently,
    and Stage 3 sequences real orders off these ranks. The explicit sentinel must
    suppress auto-detection entirely and use 1..N row order."""
    import pandas as pd
    spec = md.RANKABLE_FIELDS["colorWheel"]
    df = pd.DataFrame({"COLOR": ["RED", "BLUE"], "ORDER": [90, 80]})

    # Baseline: with no explicit rank column, ORDER is auto-detected.
    auto = brain._resolve_priority_list_columns(df, "5512", spec)
    assert auto["rank_col"] == "ORDER"
    assert auto["entries"] == {"RED": 90.0, "BLUE": 80.0}

    # Sentinel: auto-detection is skipped, ranks are row order, and the
    # sentinel itself is never persisted as a column name.
    forced = brain._resolve_priority_list_columns(
        df, "5512", spec, explicit_rank_col=brain.ROW_ORDER_SENTINEL)
    assert forced["rank_col"] is None
    assert forced["entries"] == {"RED": 1.0, "BLUE": 2.0}


def test_row_order_sentinel_value_matches_the_frontend_option():
    """Must stay in sync with ROW_ORDER_SENTINEL in
    frontend/plant-and-administration.mts and the static <option value> in
    frontend/index.html's #pl-mapping-rank-col."""
    assert brain.ROW_ORDER_SENTINEL == "__row_order__"


def test_get_priority_list_maps_blank_plant_to_400_not_500(client):
    """_assert_plant_allowed raises ValueError (not PlantNotAllowed) for a
    blank/whitespace plant; this route caught only PlantNotAllowed, so the
    ValueError escaped as an unhandled 500. Its sibling routes
    (GET /priority-lists, POST /priority-list/...) already mapped it to 400.
    DB-free: with no identity header the allowed-plants resolver short-circuits
    and the plant check runs before any query."""
    r = client.get("/priority-list/%20/colorWheel")
    assert r.status_code == 400
    assert "plant is required" in r.json()["detail"]


@pytest.mark.pg
def test_set_plant_constraints_preserves_nested_children(pg):
    import master_data as md
    sub, plant = "ZZTEST_TREE_SUB", "ZZTEST_TREE_PLANT"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, sub))
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (sub, plant))
        conn.commit()
    try:
        tree = [
            {"key": "colorWheel", "enabled": True, "order": 1, "children": [
                {"key": "prt01", "enabled": True, "order": 1},
            ]},
        ]
        md.set_plant_constraints(subnetwork=sub, plant=plant, constraints=tree)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT constraints FROM plants WHERE plant = %s", (plant,))
            stored = cur.fetchone()[0]
        assert stored[0]["children"][0]["key"] == "prt01"
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM plants WHERE plant = %s", (plant,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            conn.commit()


def test_set_plant_constraints_rejects_depth_beyond_three():
    import master_data as md
    deep = {"key": "colorWheel", "enabled": True, "order": 1, "children": [
        {"key": "prt01", "enabled": True, "order": 1, "children": [
            {"key": "prt02", "enabled": True, "order": 1, "children": [
                {"key": "productionVersion", "enabled": True, "order": 1},
            ]},
        ]},
    ]}
    with pytest.raises(ValueError, match="depth"):
        md.set_plant_constraints(subnetwork="", plant="ZZANY", constraints=[deep])


@pytest.mark.pg
def test_known_line_codes_for_plant_is_scoped(pg):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES ('ZZTEST_SUB','ZZTEST_SUB') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP2') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES ('ZZTEST_SUB','ZZTEST_LP','L01') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES ('ZZTEST_SUB','ZZTEST_LP2','L99') ON CONFLICT DO NOTHING")
        conn.commit()
    try:
        assert md.known_line_codes_for_plant('ZZTEST_LP') == {'L01'}
        assert 'L99' not in md.known_line_codes_for_plant('ZZTEST_LP')
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM machine WHERE plant IN ('ZZTEST_LP','ZZTEST_LP2')")
            cur.execute("DELETE FROM plants WHERE plant IN ('ZZTEST_LP','ZZTEST_LP2')")
            cur.execute("DELETE FROM subnetworks WHERE code = 'ZZTEST_SUB'")
            conn.commit()


# ---------------------------------------------------------------------------
# Pure-logic: schema.sql pins the priority_list table + the right column names
# ---------------------------------------------------------------------------
def _schema_text() -> str:
    with open(os.path.join(ROOT, "schema.sql"), encoding="utf-8") as f:
        return f.read()


def test_schema_declares_priority_list_table_and_orders_columns():
    text = _schema_text()
    assert "CREATE TABLE IF NOT EXISTS priority_list" in text
    assert "PRIMARY KEY (plant, machine, field_key)" in text
    assert 'ADD COLUMN IF NOT EXISTS production_version TEXT' in text
    # The corrected column — must NOT be default_machine (2026-08-11 fix).
    assert "orders ADD COLUMN IF NOT EXISTS default_machine" not in text


def test_schema_ledger_guards_the_two_data_mutating_steps():
    text = _schema_text()
    assert "priority_list_from_color_wheel" in text
    assert "orders_mp_attrs_backfill" in text


@pytest.mark.pg
def test_schema_reapply_is_a_no_op_for_priority_list_migration(pg):
    """Mirrors test_schema_idempotent.py's TestHorizonMigrationIdempotent
    pattern: re-applying the whole (idempotent) schema.sql, exactly like a
    redeploy would, must record both ledger rows and must not duplicate
    priority_list rows on a second pass."""
    schema_sql = _schema_text()
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(schema_sql)
        conn.commit()
        cur.execute("SELECT COUNT(*) FROM priority_list")
        count_after_first = cur.fetchone()[0]

        cur.execute(schema_sql)
        conn.commit()
        cur.execute("SELECT COUNT(*) FROM priority_list")
        count_after_second = cur.fetchone()[0]

        for ledger_id in ("priority_list_from_color_wheel", "orders_mp_attrs_backfill"):
            cur.execute("SELECT 1 FROM schema_migrations WHERE id = %s", (ledger_id,))
            assert cur.fetchone() is not None, f"{ledger_id} missing from schema_migrations"

    assert count_after_second == count_after_first, (
        "Re-applying schema.sql changed priority_list's row count — the "
        "ledger guard did not prevent a second color_wheel copy-in."
    )


# ---------------------------------------------------------------------------
# DB round-trip (auto-skipped when Postgres is unreachable / not opted in)
# ---------------------------------------------------------------------------
@pytest.mark.pg
class TestPriorityListStore:
    PLANT = "ZZTEST_PL_PLANT"
    LINE = "ZZTEST_LINE"

    @pytest.fixture(autouse=True)
    def _clean(self, pg):
        pg.ensure_priority_list_table()
        self._delete(pg)
        yield
        self._delete(pg)

    def _delete(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (self.PLANT,))
            conn.commit()

    def test_upsert_insert_then_replace_round_trips_entries(self, pg):
        entries = {"RED": 1.0, "BLUE": 2.0, "GREEN": None}
        res = pg.upsert_priority_list(self.PLANT, "colorWheel", entries, line="",
                                      source_column="color", filename="wheel.xlsx",
                                      row_count=3, uploaded_by="tester")
        assert res["inserted"] is True

        row = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        assert row is not None
        assert row["entries"] == entries
        assert row["source_column"] == "color"
        assert row["filename"] == "wheel.xlsx"
        assert row["row_count"] == 3

        res2 = pg.upsert_priority_list(self.PLANT, "colorWheel", {"RED": 5.0}, line="",
                                       source_column="color", filename="wheel2.xlsx",
                                       row_count=1, uploaded_by="tester")
        assert res2["inserted"] is False
        row2 = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        assert row2["entries"] == {"RED": 5.0}

    def test_line_scope_is_independent_of_plant_wide_scope(self, pg):
        pg.upsert_priority_list(self.PLANT, "colorWheel", {"RED": 1.0}, line="",
                                source_column="color")
        pg.upsert_priority_list(self.PLANT, "colorWheel", {"RED": 9.0}, line=self.LINE,
                                source_column="color")

        plant_wide = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        line_scoped = pg.get_priority_list(self.PLANT, "colorWheel", line=self.LINE)
        assert plant_wide["entries"] == {"RED": 1.0}
        assert line_scoped["entries"] == {"RED": 9.0}

        all_lists = pg.load_all_priority_lists()
        assert all_lists[self.PLANT][""]["colorWheel"] == {"RED": 1.0}
        assert all_lists[self.PLANT][self.LINE]["colorWheel"] == {"RED": 9.0}

    def test_list_meta_and_delete(self, pg):
        pg.upsert_priority_list(self.PLANT, "colorWheel", {"RED": 1.0}, line="",
                                source_column="color", filename="w.xlsx", row_count=1)
        rows, total = pg.list_priority_lists_meta(plant=self.PLANT)
        assert total >= 1
        assert any(r["field_key"] == "colorWheel" and r["filename"] == "w.xlsx" for r in rows)

        assert pg.delete_priority_list(self.PLANT, "colorWheel", line="") == {"filename": "w.xlsx"}
        assert pg.get_priority_list(self.PLANT, "colorWheel", line="") is None
        assert pg.delete_priority_list(self.PLANT, "colorWheel", line="") is None  # idempotent


@pytest.mark.pg
class TestStampOrderAttributesAndTheInverseLedgerTrap:
    """The R3 regression test: a stamp/backfill that runs before material_plants
    is populated must be a harmless no-op (never a block), and resync afterward
    must fix it — proving the resync endpoint, not the ledger-guarded migration
    step, is the real mechanism."""

    SUB, PLANT = "ZZTESTSUB2", "ZZTESTP2"
    LINE = "ZZTESTLINE2"
    MATERIAL = "ZZMAT-1"
    ORDER_NO = "ZZORD-1"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db = pg
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO subnetworks (code, name) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB, self.SUB),
            )
            cur.execute(
                "INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB, self.PLANT),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine) "
                "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB, self.PLANT, self.LINE),
            )
            cur.execute(
                "INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING",
                (self.MATERIAL,),
            )
            conn.commit()
        # Clean slate: no material_plants row yet — that's the point of this test.
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM material_plants WHERE material_id = %s AND plant = %s",
                       (self.MATERIAL, self.PLANT))
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE production_order = %s", (self.ORDER_NO,))
            cur.execute("DELETE FROM material_plants WHERE material_id = %s AND plant = %s",
                       (self.MATERIAL, self.PLANT))
            cur.execute("DELETE FROM machine_setup_state WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM setup_definition WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM machine WHERE subnetwork = %s AND plant = %s",
                       (self.SUB, self.PLANT))
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUB, self.PLANT))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MATERIAL,))
            conn.commit()

    def _upsert_one_order(self, db):
        return db.upsert_orders([{
            "production_order": self.ORDER_NO,
            "material_number": self.MATERIAL,
            "machine": self.LINE,
            "plant": self.PLANT,
            "basic_start_date": "2026-08-11T00:00:00",
            "basic_finish_date": "2026-08-11T08:00:00",
            "run_time": 8,
            "color": "LEGACY_EXCEL_COLOR",
        }])

    def test_upload_never_blocks_and_reports_the_exception(self, pg):
        db = pg
        result = self._upsert_one_order(db)
        assert result["status"] == "ok"  # never blocks (N5/N6/N7), regardless of unmatched count
        mmd = result["missing_master_data"]
        assert mmd["unmatched_pairs"] >= 1
        assert mmd["unmatched_orders"] >= 1

        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT color, prt_01, prt_02, production_version FROM orders "
                       "WHERE production_order = %s", (self.ORDER_NO,))
            color, prt01, prt02, prod_ver = cur.fetchone()
        # No material_plants row -> the stamp touches nothing; the row keeps
        # whatever the base upsert wrote (here, the legacy Excel color).
        assert color == "LEGACY_EXCEL_COLOR"
        assert prt01 is None and prt02 is None and prod_ver is None

        found = [
            e for w in result["warnings"] if w.get("category") == "missing_master_data"
            for e in w.get("exceptions", [])
            if e["material_number"] == self.MATERIAL and e["plant"] == self.PLANT
        ]
        assert found and found[0]["reason"] == "no_mp_row"

    def test_resync_after_material_plants_populated_fixes_the_order(self, pg):
        db = pg
        self._upsert_one_order(db)  # stamp runs, finds nothing (no MP row yet)

        # NOW populate material_plants — simulating the inverse-ledger-trap
        # scenario: master data arrives AFTER the (one-time) stamp already ran.
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO material_plants (material_id, plant, color, prt_01, prt_02, "
                "default_production_version) VALUES (%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (material_id, plant) DO UPDATE SET "
                "color = EXCLUDED.color, prt_01 = EXCLUDED.prt_01, prt_02 = EXCLUDED.prt_02, "
                "default_production_version = EXCLUDED.default_production_version",
                (self.MATERIAL, self.PLANT, "RED", "MOLD-A", "MOLD-B", "0001"),
            )
            conn.commit()

        # The ingest-time stamp will NEVER re-run for this batch (no re-upload) —
        # resync is the real mechanism (R3).
        result = db.resync_order_attributes(self.PLANT)
        assert result["unmatched_pairs"] == 0

        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT color, prt_01, prt_02, production_version FROM orders "
                       "WHERE production_order = %s", (self.ORDER_NO,))
            color, prt01, prt02, prod_ver = cur.fetchone()
        assert (color, prt01, prt02, prod_ver) == ("RED", "MOLD-A", "MOLD-B", "0001")

    def test_setup_signature_on_tooling_fields_reads_the_materialized_orders_columns(self, pg):
        """The setup/changeover matrix's tooling-based signature (prt01/prt02) reads
        orders.prt_01/prt_02 directly (backend/setup/data.py's
        derive_machine_state_before_replacement) — the exact query that would raise
        UndefinedColumn if migrations/2026-08-11-priority-lists.sql were unapplied.
        No prior test exercised this path against a live database row."""
        db = pg
        self._upsert_one_order(db)
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET color = %s, prt_01 = %s, prt_02 = %s, production_version = %s "
                "WHERE production_order = %s",
                ("RED", "MOLD-A", "MOLD-B", "0001", self.ORDER_NO),
            )
            conn.commit()

        setup_data.save_definition(self.PLANT, ["prt01", "prt02"], False, "owner@example.com")
        result = setup_data.derive_machine_state_before_replacement(
            self.PLANT, self.LINE, captured_at=datetime(2026, 8, 11, 9, 0), actor="owner@example.com",
        )
        assert result["accepted"] is True
        assert result["state_key"] == [
            {"fieldKey": "prt01", "value": "MOLD-A"},
            {"fieldKey": "prt02", "value": "MOLD-B"},
        ]


@pytest.mark.pg
class TestApplyPriorityMerge:
    PLANT = "ZZTEST_MERGE_PLANT"

    @pytest.fixture(autouse=True)
    def _reset_cache(self, pg):
        # apply_priority_merge reads brain.PLANT_LISTS directly (no DB call), so
        # tests can seed the cache without touching Postgres at all.
        brain.PLANT_LISTS[self.PLANT] = {"": {"colorWheel": {"RED": 1.0, "BLUE": 2.0}}}
        yield
        brain.PLANT_LISTS.pop(self.PLANT, None)

    def test_order_y_stamped_and_unlisted_sequenced_last_no_ranks_key(self):
        import pandas as pd
        df = pd.DataFrame({
            "COLOR": ["red", "blue", "green"],
            "PLANT": [self.PLANT, self.PLANT, self.PLANT],
            "MACHINE": ["L1", "L1", "L1"],
            "BASIC_START_DATE": pd.to_datetime(["2026-08-11", "2026-08-11", "2026-08-11"]),
        })
        out, stats = brain.apply_priority_merge(df, plant=self.PLANT)
        by_color = dict(zip(out["COLOR"], out["ORDER_Y"], strict=True))
        assert by_color["RED"] == 1.0
        assert by_color["BLUE"] == 2.0
        assert by_color["GREEN"] == 999999  # unlisted -> last, never dropped
        assert "RANKS" not in out.columns
        assert stats["color_merge_misses"] == 1
        assert stats["missed_colors"] == ["GREEN"]

    def test_prt_and_production_version_are_uppercased_alongside_color(self):
        """PRT_01/PRT_02/PRODUCTION_VERSION are equally rankable fields and
        equally subject to the case-mismatch pathology this fold exists to
        close for COLOR (docs/multi_change_spec_08.20.26.md D1) — a
        hand-typed 'mold-a' must present the same as an ingested 'MOLD-A'."""
        import pandas as pd
        df = pd.DataFrame({
            "COLOR": ["red"],
            "PRT_01": ["mold-a"],
            "PRT_02": [" Mold-B "],
            "PRODUCTION_VERSION": ["v01"],
            "PLANT": [self.PLANT],
            "MACHINE": ["L1"],
            "BASIC_START_DATE": pd.to_datetime(["2026-08-11"]),
        })
        out, _ = brain.apply_priority_merge(df, plant=self.PLANT)
        assert out.loc[0, "PRT_01"] == "MOLD-A"
        assert out.loc[0, "PRT_02"] == "MOLD-B"
        assert out.loc[0, "PRODUCTION_VERSION"] == "V01"

    def test_line_override_wins_over_plant_wide(self):
        import pandas as pd
        brain.PLANT_LISTS[self.PLANT]["L2"] = {"colorWheel": {"RED": 50.0}}
        df = pd.DataFrame({
            "COLOR": ["red", "red"],
            "PLANT": [self.PLANT, self.PLANT],
            "MACHINE": ["L1", "L2"],
            "BASIC_START_DATE": pd.to_datetime(["2026-08-11", "2026-08-11"]),
        })
        out, _ = brain.apply_priority_merge(df, plant=self.PLANT)
        rows = out.set_index("MACHINE")["ORDER_Y"]
        assert rows["L1"] == 1.0    # plant-wide list applies
        assert rows["L2"] == 50.0   # line override wins for L2 only


@pytest.mark.pg
def test_color_wheel_endpoints_are_backed_by_priority_list(client, pg):
    """Legacy /color-wheel/{plant} contract must survive the repoint at
    priority_list untouched (same response shape)."""
    plant = "ZZTEST_CW_COMPAT"
    pg.delete_priority_list(plant, "colorWheel", line="")
    try:
        r = client.get(f"/color-wheel/{plant}")
        assert r.status_code == 404

        pg.upsert_priority_list(plant, "colorWheel", {"RED": 1.0, "BLUE": None},
                                line="", source_column="color",
                                filename="w.xlsx", row_count=2, uploaded_by="tester")
        r = client.get(f"/color-wheel/{plant}")
        assert r.status_code == 200
        body = r.json()
        assert body["plant"] == plant
        entries = {e["color"]: e["order_y"] for e in body["entries"]}
        assert entries == {"RED": 1.0, "BLUE": 999999}  # blank rank -> last, matching apply_priority_merge

        r = client.get("/color-wheels")
        assert plant in r.json()["plants"]
    finally:
        pg.delete_priority_list(plant, "colorWheel", line="")


# --- GET /color-wheel/{plant} plant gate ----------------------------------
# This route shipped without the per-user plant scope every sibling in this
# block carries (same gap already found and fixed once for GET
# /priority-rank-maps — see that trio above), so a plant-restricted user
# could read any plant's color wheel. The DB-free style below (monkeypatch
# db.get_priority_list) mirrors that fix's approach of not requiring a live
# Postgres for a pure auth-gate test.

def test_color_wheel_get_rejects_a_plant_outside_the_users_scope(client, monkeypatch):
    import db
    import backend.security.auth as auth
    monkeypatch.setattr(auth, "get_allowed_plants", lambda email: ["1006"])
    monkeypatch.setattr(db, "get_priority_list", lambda plant, field_key, line="": {
        "entries": {"RED": 1.0}, "uploaded_at": None, "uploaded_by": "tester",
        "filename": "w.xlsx", "row_count": 1,
    })
    r = client.get("/color-wheel/5512", headers={"x-user-email": "scoped.user@example.com"})
    assert r.status_code == 403
    # And the payload must not leak on the way out.
    assert "RED" not in r.text


def test_color_wheel_get_allows_a_plant_inside_the_users_scope(client, monkeypatch):
    """The gate must not break the legitimate case — regression guard for the
    coupled frontend change: ColorWheelViewer._load() had to move from a bare
    fetch() to Util.fetchTraced so the x-user-email header this reads is
    actually sent. Without that, this path 403s for every scoped user."""
    import db
    import backend.security.auth as auth
    monkeypatch.setattr(auth, "get_allowed_plants", lambda email: ["5512", "1006"])
    monkeypatch.setattr(db, "get_priority_list", lambda plant, field_key, line="": {
        "entries": {"RED": 1.0}, "uploaded_at": None, "uploaded_by": "tester",
        "filename": "w.xlsx", "row_count": 1,
    })
    r = client.get("/color-wheel/5512", headers={"x-user-email": "scoped.user@example.com"})
    assert r.status_code == 200
    assert r.json()["entries"] == [{"color": "RED", "order_y": 1.0}]


def test_color_wheel_get_maps_a_blank_plant_to_400_not_500(client):
    """_assert_plant_allowed raises ValueError (not PlantNotAllowed) for a
    blank/whitespace plant — catch both, or the ValueError escapes as a 500.
    Same trap the sibling GET /priority-rank-maps already hit."""
    r = client.get("/color-wheel/%20")
    assert r.status_code == 400
    assert "plant is required" in r.json()["detail"]


@pytest.mark.pg
class TestMissingMasterDataForPlant:
    PLANT = "ZZTEST_MMD_PLANT"
    SUB = "ZZTEST_MMD_SUB"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (self.SUB, self.SUB))
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (self.SUB, self.PLANT))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date)"
                " VALUES ('zzmmd1','PO1','MAT-NO-MP',%s, NOW()) ON CONFLICT (id) DO NOTHING",
                (self.PLANT,),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = 'zzmmd1'")
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def test_reports_unmatched_pair_with_no_update(self, pg):
        result = pg.missing_master_data_for_plant(self.PLANT)
        assert result["unmatched_pairs"] == 1
        assert result["unmatched_orders"] == 1
        assert result["exceptions"][0] == {
            "plant": self.PLANT, "material_number": "MAT-NO-MP",
            "order_count": 1, "reason": "no_mp_row",
        }
        # Read-only: confirm the order's color is still untouched (no UPDATE ran)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT color FROM orders WHERE id = 'zzmmd1'")
            assert cur.fetchone()[0] is None


@pytest.mark.pg
def test_priority_lists_endpoint_groups_by_field_with_coverage(client, pg):
    plant = "ZZTEST_PLE_PLANT"
    # Plant-wide list ranks RED only; L01's override ranks BLUE only.
    pg.upsert_priority_list(plant, "colorWheel", {"RED": 1.0}, line="",
                            source_column="color", filename="w.xlsx", row_count=1, uploaded_by="t")
    pg.upsert_priority_list(plant, "colorWheel", {"BLUE": 1.0}, line="L01",
                            source_column="color", filename="w2.xlsx", row_count=1, uploaded_by="t")
    # Orders chosen so the plant total can't be confused with any single line's
    # number AND can't be reproduced by summing the per-line numbers:
    #   L01: RED, BLUE      -> 2 distinct, 1 ranked (L01's override has BLUE only)
    #   L02: RED, GREEN     -> 2 distinct, 1 ranked (falls back to plant-wide RED)
    # Plant total: {RED, BLUE, GREEN} = 3 distinct (NOT 2+2=4 — RED is shared),
    # ranked = {RED (via L02/plant-wide), BLUE (via L01)} = 2.
    orders = [
        ("zzple1", "L01", "RED"), ("zzple2", "L01", "BLUE"),
        ("zzple3", "L02", "RED"), ("zzple4", "L02", "GREEN"),
    ]
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for oid, line, color in orders:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, plant,"
                " machine, color, basic_start_date)"
                " VALUES (%s,%s,%s,%s,%s,%s, NOW()) ON CONFLICT (id) DO NOTHING",
                (oid, oid.upper(), "MAT-" + oid, plant, line, color),
            )
        conn.commit()
    try:
        r = client.get(f"/priority-lists?plant={plant}")
        assert r.status_code == 200
        body = r.json()
        assert body["plant"] == plant
        cw = body["fields"]["colorWheel"]
        assert cw["plant_wide"]["filename"] == "w.xlsx"
        assert len(cw["machine_overrides"]) == 1
        assert cw["machine_overrides"][0]["machine"] == "L01"

        cov = cw["coverage"]
        # Per-line buckets, keyed by line code.
        assert cov["L01"] == {"distinct_values": 2, "ranked_values": 1}
        assert cov["L02"] == {"distinct_values": 2, "ranked_values": 1}
        # The plant-wide roll-up lives under the reserved key, NOT under '' —
        # '' means "orders with no production line", which is why the
        # plant-wide field card used to render no ratio at all here.
        assert "" not in cov, "'' must stay the no-production-line bucket, not a plant total"
        total = cov[pg.PLANT_TOTAL_COVERAGE_KEY]
        # De-duplicated across lines: 3, not 2+2=4. Distinct from either line's 2.
        assert total == {"distinct_values": 3, "ranked_values": 2}
        assert total["distinct_values"] > cov["L01"]["distinct_values"]
        assert total["distinct_values"] != sum(
            v["distinct_values"] for k, v in cov.items() if k != pg.PLANT_TOTAL_COVERAGE_KEY
        ), "summing per-line distinct counts double-counts shared values — hence the dedicated total"

        # A field with no list uploaded still reports its own coverage denominator.
        assert body["fields"]["prt01"]["plant_wide"] is None
        assert body["fields"]["prt01"]["machine_overrides"] == []
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (plant,))
            cur.execute("DELETE FROM orders WHERE plant = %s", (plant,))
            conn.commit()


@pytest.mark.pg
def test_missing_master_data_endpoint(client, pg):
    batch_id = "00000000-0000-0000-0000-000000000000"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM upload_audit WHERE batch_id = %s", (batch_id,))
        cur.execute(
            "INSERT INTO upload_audit (batch_id, filename, row_count, inserted_count, "
            "updated_count, warnings) VALUES (%s,%s,%s,%s,%s,%s)",
            (batch_id, "test.xlsx", 1, 1, 0, __import__("json").dumps([
                {"level": "info", "category": "missing_master_data",
                 "exceptions": [{"plant": "5512", "material_number": "MAT-X",
                                "order_count": 3, "reason": "no_mp_row"}]},
            ])),
        )
        conn.commit()
    try:
        r = client.get(f"/upload/{batch_id}/missing-master-data")
        assert r.status_code == 200
        body = r.json()
        assert body["unmatched_pairs"] == 1
        assert body["unmatched_orders"] == 3
        assert body["exceptions"][0]["material_number"] == "MAT-X"

        r_csv = client.get(f"/upload/{batch_id}/missing-master-data", params={"format": "csv"})
        assert r_csv.status_code == 200
        assert r_csv.headers["content-type"].startswith("text/csv")
        assert "MAT-X" in r_csv.text
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM upload_audit WHERE batch_id = %s", (batch_id,))
            conn.commit()


@pytest.mark.pg
def test_live_missing_master_data_endpoint(client, pg):
    plant = "ZZTEST_LMD_PLANT"
    sub = "ZZTEST_LMD_SUB"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, sub))
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (sub, plant))
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date)"
            " VALUES ('zzlmd1','PO1','MAT-X',%s, NOW()) ON CONFLICT (id) DO NOTHING", (plant,))
        conn.commit()
    try:
        r = client.get(f"/master-data/{plant}/missing-master-data")
        assert r.status_code == 200
        body = r.json()
        assert body["unmatched_pairs"] == 1
        assert body["exceptions"][0]["material_number"] == "MAT-X"

        r_csv = client.get(f"/master-data/{plant}/missing-master-data?format=csv")
        assert r_csv.status_code == 200
        assert r_csv.headers["content-type"].startswith("text/csv")
        assert "MAT-X" in r_csv.text
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = 'zzlmd1'")
            cur.execute("DELETE FROM plants WHERE plant = %s", (plant,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            conn.commit()


@pytest.mark.pg
class TestGenericPriorityListUpload:
    PLANT = "ZZTEST_UP_PLANT"
    SUB = "ZZTEST_UP_SUB"
    LINE = "ZZTEST_UP_L01"

    @pytest.fixture(autouse=True)
    def _seed(self, pg, client):
        self.client = client
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (self.SUB, self.SUB))
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (self.SUB, self.PLANT))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                        (self.SUB, self.PLANT, self.LINE))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM machine WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def _xlsx(self, rows: list[dict]) -> bytes:
        import io as _io
        import pandas as pd
        buf = _io.BytesIO()
        pd.DataFrame(rows).to_excel(buf, index=False)
        return buf.getvalue()

    def test_legacy_color_columns_auto_detect_with_no_mapping(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}, {"COLOR": "BLUE", "ORDER_Y": 2}])
        r = self.client.post(f"/priority-list/{self.PLANT}/colorWheel",
                             files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["machine"] == ""

    def test_no_rank_column_uses_row_order(self):
        body = self._xlsx([{"PRT_01": "DOG"}, {"PRT_01": "CAT"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "PRT_01"})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_row_count_is_stored_entries_not_file_rows(self, pg):
        """Both display sites (the field card's "N values" and
        PriorityListViewer's meta line) render priority_list.row_count, so it has
        to be the number of value/rank pairs actually STORED, not the uploaded
        file's raw row count — blanks are dropped and duplicate values collapsed,
        so a file with 4 rows can persist only 2 entries. The raw count is still
        reported separately as file_row_count."""
        body = self._xlsx([
            {"PRT_01": "DOG", "RANK": 1},
            {"PRT_01": "", "RANK": 2},      # blank value -> dropped
            {"PRT_01": "CAT", "RANK": 3},
            {"PRT_01": "cat", "RANK": 3},   # duplicate (upper/trim) with the SAME rank -> collapsed
        ])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "PRT_01", "rank_column": "RANK"})
        assert r.status_code == 200
        assert r.json()["row_count"] == 2       # DOG, CAT
        assert r.json()["file_row_count"] == 4  # raw spreadsheet rows
        row = pg.get_priority_list(self.PLANT, "prt01", line="")
        assert row["entries"] == {"DOG": 1.0, "CAT": 3.0}
        assert row["row_count"] == len(row["entries"]) == 2

    def test_explicit_row_order_sentinel_beats_an_auto_detectable_rank_column(self, pg):
        """End-to-end pin for the mapping modal's "— use row order —" pick: the
        sentinel must reach _resolve_priority_list_columns as an explicit
        "no rank column" instruction, not as a falsy value that lets ORDER win."""
        body = self._xlsx([{"PRT_01": "DOG", "ORDER": 90}, {"PRT_01": "CAT", "ORDER": 80}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "PRT_01", "rank_column": brain.ROW_ORDER_SENTINEL})
        assert r.status_code == 200
        row = pg.get_priority_list(self.PLANT, "prt01", line="")
        assert row["entries"] == {"DOG": 1.0, "CAT": 2.0}
        assert row["rank_column"] is None

    def test_ambiguous_columns_return_needs_mapping(self):
        body = self._xlsx([{"FOO": "DOG", "BAR": "CAT"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "needs_mapping"
        assert set(r.json()["headers"]) == {"FOO", "BAR"}

    def test_explicit_mapping_with_line_scope_persists(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK", "machine": self.LINE})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["machine"] == self.LINE

    def test_unknown_line_is_rejected(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK", "machine": "NOT-A-REAL-LINE"})
        assert r.status_code == 400

    def test_multiple_line_values_in_file_rejected_without_explicit_line(self):
        body = self._xlsx([
            {"TOOL": "DOG", "RANK": 1, "LINE": self.LINE},
            {"TOOL": "CAT", "RANK": 2, "LINE": "SOME-OTHER-LINE"},
        ])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 400
        assert "multiple" in r.json()["detail"].lower()

    def test_duplicate_value_conflicting_rank_rejected(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}, {"TOOL": "DOG", "RANK": 2}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 400
        assert "DOG" in r.json()["detail"]

    def test_unknown_field_key_rejected(self):
        body = self._xlsx([{"TOOL": "DOG"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/not-a-real-field",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 400

    def test_blank_line_cell_resolves_via_non_blank_value(self):
        """C1 regression: under pandas 3 (pinned pandas==3.0.3), a blank LINE
        cell survives as a raw float NaN even after .astype(str) — must not
        500 (AttributeError from .lower() on NaN). One row has the real line,
        the other is blank; the blank should just be ignored, not block
        resolution to the one real value."""
        body = self._xlsx([
            {"TOOL": "DOG", "RANK": 1, "LINE": self.LINE},
            {"TOOL": "CAT", "RANK": 2, "LINE": None},
        ])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["machine"] == self.LINE

    def test_all_blank_line_column_falls_back_to_plant_wide(self):
        """C1 companion case: if every LINE cell is blank, resolution must
        fall back to plant-wide (line="") instead of 500ing."""
        body = self._xlsx([
            {"TOOL": "DOG", "RANK": 1, "LINE": None},
            {"TOOL": "CAT", "RANK": 2, "LINE": None},
        ])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["machine"] == ""

    def test_ambiguous_columns_with_blank_and_numeric_cells_does_not_500(self):
        """C4 regression: the needs_mapping response's `sample` (df.head(5))
        must not carry a raw NaN — JSONResponse rejects that. Include a blank
        cell and a numeric (non-string) cell in the sampled rows."""
        body = self._xlsx([{"FOO": "DOG", "BAR": None}, {"FOO": 123, "BAR": "CAT"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 200
        body_json = r.json()
        assert body_json["status"] == "needs_mapping"
        assert set(body_json["headers"]) == {"FOO", "BAR"}
        # The blank BAR cell must decode as JSON null (None), never NaN.
        assert body_json["sample"][0]["BAR"] is None

    def test_order_y_wins_over_unrelated_order_column(self, pg):
        """I1 regression: when a file has both ORDER_Y and an unrelated
        ORDER column, ORDER_Y must win deterministically — not silently fall
        back to row-order ranking (which would discard the real rank data)."""
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 5, "ORDER": 99}])
        r = self.client.post(f"/priority-list/{self.PLANT}/colorWheel",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        row = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        assert row["entries"] == {"RED": 5.0}


@pytest.mark.pg
def test_generic_upload_normalizes_numeric_plant_column_and_tolerates_blanks(client, pg):
    """C2 regression: a numeric-typed PLANT column (as pandas reads a plain
    numeric Excel cell, e.g. a plant code like 5512) must normalize the same
    way db._str_id does (stripping the Excel float suffix) before comparing
    to the target plant, and a blank/NaN PLANT cell must not crash the
    comparison (TypeError mixing str/float in sorted()) or produce a
    false-positive mismatch. Uses a bare numeric plant code (not the usual
    ZZTEST_ prefix) specifically to exercise pandas' numeric-column dtype
    inference, mirroring a real SAP plant code like '5512'."""
    plant = "554433"
    body_rows = [{"COLOR": "RED", "PLANT": 554433}, {"COLOR": "BLUE", "PLANT": None}]
    import io as _io
    import pandas as pd
    buf = _io.BytesIO()
    pd.DataFrame(body_rows).to_excel(buf, index=False)
    try:
        r = client.post(f"/priority-list/{plant}/colorWheel", files={"file": ("t.xlsx", buf.getvalue())})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        row = pg.get_priority_list(plant, "colorWheel", line="")
        assert row["entries"] == {"RED": 1.0, "BLUE": 2.0}
    finally:
        pg.delete_priority_list(plant, "colorWheel", line="")


@pytest.mark.pg
def test_generic_upload_rejects_plant_mismatch_even_with_blank_cells(client):
    """C2 companion: a genuine PLANT mismatch must still 400 (not silently
    pass) once blank cells are tolerated. File's numeric PLANT column
    normalizes to "554433"; target plant below is a different code."""
    body_rows = [{"COLOR": "RED", "PLANT": 554433}, {"COLOR": "BLUE", "PLANT": None}]
    import io as _io
    import pandas as pd
    buf = _io.BytesIO()
    pd.DataFrame(body_rows).to_excel(buf, index=False)
    r = client.post("/priority-list/999999/colorWheel", files={"file": ("t.xlsx", buf.getvalue())})
    assert r.status_code == 400


@pytest.mark.pg
def test_generic_get_and_delete_priority_list(client, pg):
    plant = "ZZTEST_GD_PLANT"
    pg.upsert_priority_list(plant, "prt01", {"DOG": 1.0, "CAT": None}, line="",
                            source_column="prt_01", filename="t.xlsx", row_count=2, uploaded_by="t")
    r = client.get(f"/priority-list/{plant}/prt01")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == [{"value": "DOG", "rank": 1.0}, {"value": "CAT", "rank": 999999}]

    r2 = client.delete(f"/priority-list/{plant}/prt01",
                       headers={"X-API-Key": os.environ.get("NIMBUS_API_KEY", "")})
    assert r2.status_code == 200
    assert r2.json()["status"] == "ok"

    r3 = client.get(f"/priority-list/{plant}/prt01")
    assert r3.status_code == 404


@pytest.mark.pg
class TestLegacyColorWheelUploadConsolidation:
    """POST /color-wheel/{plant} now shares _resolve_priority_list_columns/
    _persist_priority_list with the generic endpoint (Decision 9b). No
    existing test exercised this route's POST before (confirmed by grep —
    only its GET and /color-wheels were tested), so these are new regression
    pins for the preserved contract, plus one test for the one deliberate,
    strictly-permissive behavior change (ORDER_Y is no longer required)."""
    PLANT = "ZZTEST_CWLEGACY_PLANT"

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg, client):
        self.client = client
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (self.PLANT,))
            conn.commit()

    def _xlsx(self, rows: list[dict]) -> bytes:
        import io as _io
        import pandas as pd
        buf = _io.BytesIO()
        pd.DataFrame(rows).to_excel(buf, index=False)
        return buf.getvalue()

    def test_color_and_order_y_still_uploads_with_legacy_action_names(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}, {"COLOR": "BLUE", "ORDER_Y": 2}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "row_count": 2, "action": "color_wheel_upload", "replaced": False}

    def test_order_column_still_auto_renames_to_rank(self, pg):
        body = self._xlsx([{"COLOR": "RED", "ORDER": 1}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        # I1/I5: assert the actual PERSISTED rank, not just status == "ok" —
        # a silently-discarded rank (falling back to row order) would still
        # report "ok" here, but the persisted entry would be wrong.
        row = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        assert row["entries"] == {"RED": 1.0}

    def test_missing_order_y_now_falls_back_to_row_order_instead_of_400ing(self):
        body = self._xlsx([{"COLOR": "RED"}, {"COLOR": "BLUE"}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_missing_color_column_still_400s(self):
        body = self._xlsx([{"FOO": "RED", "ORDER_Y": 1}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 400

    def test_replace_uses_legacy_replace_action_name(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}])
        self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w2.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["action"] == "color_wheel_replace"
        assert r.json()["replaced"] is True

    def test_audit_log_records_legacy_action_name(self):
        """I5: don't just trust the endpoint's self-reported `action` field —
        read the audit trail back via GET /audit/log (backed by
        _cw_append_audit's on-disk log) to confirm legacy_action_names is
        actually wired correctly, not just echoed in the response body."""
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        log = self.client.get("/audit/log", params={"limit": 20})
        assert log.status_code == 200
        entries = [e for e in log.json()["entries"] if e.get("plant") == self.PLANT]
        assert entries, "expected at least one audit entry for this plant"
        assert entries[0]["action"] == "color_wheel_upload"
        assert "priority_list_upload" not in {e["action"] for e in entries}

    def test_duplicate_color_value_last_value_wins_on_legacy_route(self, pg):
        """I2 regression: the legacy route must tolerate a duplicate COLOR
        value with two different ranks (last-value-wins, matching the old
        _cw_df_to_entries semantics exactly) rather than 400ing like the new
        generic endpoint deliberately does (Decision 6)."""
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}, {"COLOR": "RED", "ORDER_Y": 2}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        row = pg.get_priority_list(self.PLANT, "colorWheel", line="")
        assert row["entries"] == {"RED": 2.0}

    def test_empty_file_still_succeeds_on_legacy_route(self):
        """I4 regression: the OLD legacy endpoint had no empty-file check — a
        header-only (0-row) file succeeded with row_count 0, clearing the
        wheel. The new df.empty check is new/reasonable validation for the
        generic endpoint only; it must NOT be applied to this back-compat
        route."""
        import io as _io
        import pandas as pd
        buf = _io.BytesIO()
        pd.DataFrame(columns=["COLOR", "ORDER_Y"]).to_excel(buf, index=False)
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("empty.xlsx", buf.getvalue())})
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "row_count": 0, "action": "color_wheel_upload", "replaced": False}


def test_priority_rank_maps_endpoint_reads_in_memory_cache(client, monkeypatch):
    monkeypatch.setitem(brain.PLANT_LISTS, "ZZTEST_PRM_PLANT",
                        {"": {"colorWheel": {"RED": 1.0}}, "L01": {"prt01": {"DOG": 1.0}}})
    r = client.get("/priority-rank-maps?plant=ZZTEST_PRM_PLANT")
    assert r.status_code == 200
    body = r.json()
    assert body == {"": {"colorWheel": {"RED": 1.0}}, "L01": {"prt01": {"DOG": 1.0}}}


def test_priority_rank_maps_endpoint_empty_for_unknown_plant(client):
    r = client.get("/priority-rank-maps?plant=ZZ_TOTALLY_UNKNOWN")
    assert r.status_code == 200
    assert r.json() == {}


# --- GET /priority-rank-maps plant gate -----------------------------------
# This route shipped without the per-user plant scope every sibling in its block
# carries (GET /priority-lists, POST/GET/DELETE /priority-list/{plant}/{field_key},
# GET /tasks), so a plant-restricted user could read any plant's rank maps. The
# two tests above already cover the unrestricted case (no identity header ->
# auth.get_allowed_plants(None) -> None -> unscoped), which is what keeps local
# dev and the current pilot working; these three cover the scoped case.

def test_priority_rank_maps_rejects_a_plant_outside_the_users_scope(client, monkeypatch):
    """403, not a silent 200 with another plant's tooling ranks."""
    import backend.security.auth as auth
    monkeypatch.setattr(auth, "get_allowed_plants", lambda email: ["1006"])
    monkeypatch.setitem(brain.PLANT_LISTS, "5512", {"": {"colorWheel": {"RED": 1.0}}})
    r = client.get("/priority-rank-maps?plant=5512",
                   headers={"x-user-email": "scoped.user@example.com"})
    assert r.status_code == 403
    # And the payload must not leak on the way out.
    assert "RED" not in r.text


def test_priority_rank_maps_allows_a_plant_inside_the_users_scope(client, monkeypatch):
    """The gate must not break the legitimate case — regression guard for the
    coupled frontend change: Persistence.loadPriorityRankMaps had to move from a
    bare fetch() to Util.fetchTraced so the x-user-email header this reads is
    actually sent. Without that, this path 403s for every scoped user."""
    import backend.security.auth as auth
    monkeypatch.setattr(auth, "get_allowed_plants", lambda email: ["5512", "1006"])
    monkeypatch.setitem(brain.PLANT_LISTS, "5512", {"": {"colorWheel": {"RED": 1.0}}})
    r = client.get("/priority-rank-maps?plant=5512",
                   headers={"x-user-email": "scoped.user@example.com"})
    assert r.status_code == 200
    assert r.json() == {"": {"colorWheel": {"RED": 1.0}}}


def test_priority_rank_maps_maps_a_blank_plant_to_400_not_500(client):
    """_assert_plant_allowed raises ValueError (not PlantNotAllowed) for a
    blank/whitespace plant — catch both, or the ValueError escapes as a 500.
    Same trap the sibling GET /priority-list/{plant}/{field_key} already hit."""
    r = client.get("/priority-rank-maps?plant=%20")
    assert r.status_code == 400


def test_upload_priority_list_rejects_oversized_file_with_413(monkeypatch):
    """Priority list upload must reject files exceeding NIMBUS_MAX_UPLOAD_BYTES
    with HTTP 413 Payload Too Large, preventing unbounded memory consumption.
    Mocks require_admin (rather than hitting the real admin_exists() DB check,
    which needs a live Postgres) — mirrors the pattern in
    tests/test_integration_routes.py's sibling oversized-upload tests."""
    from starlette.testclient import TestClient
    import backend.priority_lists.routes as pl_routes
    monkeypatch.setattr(pl_routes, "NIMBUS_MAX_UPLOAD_BYTES", 1000)  # 1 KB limit for test
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)  # Disable API key check
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        # Create oversized payload (1.5 KB > 1 KB limit)
        oversized = b"x" * 1500
        r = TestClient(brain.api).post("/priority-list/ZZTEST_PL/colorWheel",
                                       files={"file": ("oversized.xlsx", oversized)})
        assert r.status_code == 413
        assert "exceeds maximum allowed size" in r.json()["detail"]
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)


def test_upload_color_wheel_rejects_oversized_file_with_413(monkeypatch):
    """Color wheel upload (legacy) must reject files exceeding NIMBUS_MAX_UPLOAD_BYTES
    with HTTP 413 Payload Too Large. Mocks require_admin — same reason as above."""
    from starlette.testclient import TestClient
    import backend.priority_lists.routes as pl_routes
    monkeypatch.setattr(pl_routes, "NIMBUS_MAX_UPLOAD_BYTES", 1000)  # 1 KB limit for test
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)  # Disable API key check
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        # Create oversized payload (1.5 KB > 1 KB limit)
        oversized = b"y" * 1500
        r = TestClient(brain.api).post("/color-wheel/ZZTEST_CW",
                                       files={"file": ("oversized.xlsx", oversized)})
        assert r.status_code == 413
        assert "exceeds maximum allowed size" in r.json()["detail"]
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
