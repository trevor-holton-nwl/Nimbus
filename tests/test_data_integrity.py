"""
Data-integrity regression guards for the high-severity DB findings
(#202 cross-plant attribution, #211 cascade preview, #203 bulk-update contract).

All require Postgres -> marked @pytest.mark.pg (auto-skipped when the DB is down).

#202 and #211 are now FIXED, so their tests assert the corrected behavior directly
(ambiguous shared line code stays NULL; materials cascade preview reports
material_plants). #203 (lost-rows-as-success) still needs a concurrency harness, so
its target test stays skipped (`test_desired_*`) until that lands.

Tests insert sentinel rows (ZZTEST_* keys) and clean up in teardown, so they are
safe to run against a populated dev DB.
"""
import datetime as dt

import pytest


@pytest.mark.pg
class TestCrossPlantAttribution_202:
    LINE = "ZZTEST_SHARED_LINE"
    SUB_A, PLANT_A = "WTG", "1006"   # seeded by schema.sql
    SUB_B, PLANT_B = "HMF", "5512"   # seeded by schema.sql
    ORD, MAT = "ZZTEST_ORD_202", "ZZTEST_MAT_202"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        with db._pool.connection() as conn, conn.cursor() as cur:
            # One line CODE existing under TWO different plants (the scale reality).
            cur.execute(
                "INSERT INTO production_lines (subnetwork, plant, production_line) "
                "VALUES (%s,%s,%s),(%s,%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB_A, self.PLANT_A, self.LINE, self.SUB_B, self.PLANT_B, self.LINE),
            )
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, production_line, plant) "
                "VALUES (%s,%s,%s,%s,NULL)",
                (oid, self.ORD, self.MAT, self.LINE),
            )
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute("DELETE FROM production_lines WHERE production_line = %s", (self.LINE,))
            conn.commit()

    def _plant_of(self, db, oid):
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT plant FROM orders WHERE id = %s", (oid,))
            return cur.fetchone()[0]

    def test_leaves_ambiguous_plant_null(self, pg):
        """#202 FIXED: a line code shared across >1 plant must stay NULL, not be guessed."""
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        db.reattribute_null_plant_orders()
        assert self._plant_of(db, oid) is None  # don't guess when >1 plant matches the line code

    def test_single_plant_line_is_attributed(self, pg):
        """Sanity: when the line maps to exactly ONE plant, derivation still happens."""
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        with db._pool.connection() as conn, conn.cursor() as cur:
            # Collapse to a single plant for this line, then re-derive.
            cur.execute("DELETE FROM production_lines WHERE production_line = %s AND plant = %s",
                        (self.LINE, self.PLANT_B))
            conn.commit()
        db.reattribute_null_plant_orders()
        assert self._plant_of(db, oid) == self.PLANT_A


@pytest.mark.pg
class TestCascadePreviewMaterials_211:
    def test_materials_preview_reports_children(self, pg):
        """#211 FIXED: materials cascade preview must report the material_plants count key."""
        import master_data as md
        res = md.cascade_preview("materials", [{"material_id": "ZZTEST_NOEXIST"}])
        assert "material_plants" in res
        assert res["material_plants"] == 0  # sentinel id has no children


@pytest.mark.pg
class TestBulkUpdateContract_203:
    ORD, MAT = "ZZTEST_ORD_203", "ZZTEST_MAT_203"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, production_line, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,'ZZTEST_LINE',%s,%s)",
                (oid, self.ORD, self.MAT, dt.datetime(2026, 1, 1, 8), dt.datetime(2026, 1, 1, 16)),
            )
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            conn.commit()

    def test_happy_path_persisted_equals_applied(self, pg):
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        res = db.update_task_dates_bulk(
            [{"id": oid, "start": dt.datetime(2026, 1, 2, 8), "end": dt.datetime(2026, 1, 2, 16)}]
        )
        assert res["persisted"] == 1 and res["applied"] == 1 and res["failed"] == 0

    def test_inverted_range_is_rejected(self, pg):
        """Defense-in-depth: end <= start must be rejected, not persisted (also a DB CHECK)."""
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        res = db.update_task_dates_bulk(
            [{"id": oid, "start": dt.datetime(2026, 1, 2, 16), "end": dt.datetime(2026, 1, 2, 8)}]
        )
        assert res["invalid"] == 1 and res["persisted"] == 0

    @pytest.mark.skip(reason="#203 lost-rows-as-success needs a concurrent DELETE injected between "
                             "SELECT FOR UPDATE and the UPDATE; document here, implement with a "
                             "concurrency harness when the #203 fix lands.")
    def test_desired_lost_rows_counted_as_failed(self, pg):
        ...
