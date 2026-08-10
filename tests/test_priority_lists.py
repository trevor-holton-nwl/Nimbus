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

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import brain  # noqa: E402
import master_data as md  # noqa: E402


# ---------------------------------------------------------------------------
# Pure-logic: RANKABLE_FIELDS registry (master_data.py)
# ---------------------------------------------------------------------------
def test_rankable_fields_has_exactly_four_entries_with_expected_columns():
    assert set(md.RANKABLE_FIELDS) == {"colorWheel", "prt01", "prt02", "productionVersion"}
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
    assert md.RANKABLE_FIELDS["productionVersion"] == {
        "mp_column": "default_production_version", "orders_column": "production_version",
        "task_field": "PRODUCTION_VERSION", "default_label": "Production Version",
    }


def test_production_version_mp_column_is_not_editable_via_attributes_endpoint():
    """default_production_version is SAP-owned and deliberately excluded from
    EDITABLE_MATERIAL_PLANT_ATTRS (see that frozenset's comment) — confirms the
    fourth rankable field is NOT default_workcenter (an earlier draft's mistake,
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


def test_rankable_fields_now_carry_a_default_label():
    expected = {
        'colorWheel': 'Color Wheel',
        'prt01': 'Prod. Resource Tool (01)',
        'prt02': 'Prod. Resource Tool (02)',
        'productionVersion': 'Production Version',
    }
    for key, label in expected.items():
        assert md.RANKABLE_FIELDS[key]['default_label'] == label


@pytest.mark.pg
def test_known_line_codes_for_plant_is_scoped(pg):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES ('ZZTEST_SUB','ZZTEST_SUB') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP2') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO production_lines (subnetwork, plant, production_line) VALUES ('ZZTEST_SUB','ZZTEST_LP','L01') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO production_lines (subnetwork, plant, production_line) VALUES ('ZZTEST_SUB','ZZTEST_LP2','L99') ON CONFLICT DO NOTHING")
        conn.commit()
    try:
        assert md.known_line_codes_for_plant('ZZTEST_LP') == {'L01'}
        assert 'L99' not in md.known_line_codes_for_plant('ZZTEST_LP')
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM production_lines WHERE plant IN ('ZZTEST_LP','ZZTEST_LP2')")
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
    assert "PRIMARY KEY (plant, line, field_key)" in text
    assert 'ADD COLUMN IF NOT EXISTS production_version TEXT' in text
    # The corrected column — must NOT be default_workcenter (2026-08-11 fix).
    assert "orders ADD COLUMN IF NOT EXISTS default_workcenter" not in text


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
            cur.execute("INSERT INTO subnetworks (code) VALUES (%s) ON CONFLICT DO NOTHING", (self.SUB,))
            cur.execute(
                "INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB, self.PLANT),
            )
            cur.execute(
                "INSERT INTO production_lines (subnetwork, plant, production_line) "
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
            cur.execute("DELETE FROM production_lines WHERE subnetwork = %s AND plant = %s",
                       (self.SUB, self.PLANT))
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUB, self.PLANT))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MATERIAL,))
            conn.commit()

    def _upsert_one_order(self, db):
        return db.upsert_orders([{
            "production_order": self.ORDER_NO,
            "material_number": self.MATERIAL,
            "production_line": self.LINE,
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
            "PRODUCTION_LINE": ["L1", "L1", "L1"],
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

    def test_line_override_wins_over_plant_wide(self):
        import pandas as pd
        brain.PLANT_LISTS[self.PLANT]["L2"] = {"colorWheel": {"RED": 50.0}}
        df = pd.DataFrame({
            "COLOR": ["red", "red"],
            "PLANT": [self.PLANT, self.PLANT],
            "PRODUCTION_LINE": ["L1", "L2"],
            "BASIC_START_DATE": pd.to_datetime(["2026-08-11", "2026-08-11"]),
        })
        out, _ = brain.apply_priority_merge(df, plant=self.PLANT)
        rows = out.set_index("PRODUCTION_LINE")["ORDER_Y"]
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
