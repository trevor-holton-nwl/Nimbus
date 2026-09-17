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
                "INSERT INTO machine (subnetwork, plant, machine) "
                "VALUES (%s,%s,%s),(%s,%s,%s) ON CONFLICT DO NOTHING",
                (self.SUB_A, self.PLANT_A, self.LINE, self.SUB_B, self.PLANT_B, self.LINE),
            )
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant) "
                "VALUES (%s,%s,%s,%s,NULL)",
                (oid, self.ORD, self.MAT, self.LINE),
            )
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute("DELETE FROM machine WHERE machine = %s", (self.LINE,))
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
            cur.execute("DELETE FROM machine WHERE machine = %s AND plant = %s",
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
class TestCascadePreviewSapWorkcenter:
    """P1-4a: sap_workcenter's cascade preview must count BOTH RESTRICT-FK
    referrers (machine.sap_workcenter, order_distribution.sap_workcenter) —
    never cascade-delete wording, since both FKs are ON DELETE RESTRICT."""
    SUB, PLANT = "WTG", "1006"   # seeded by schema.sql
    WC = "ZZTEST_WC_P14A"
    LINE = "ZZTEST_LINE_P14A"
    ORD, MAT = "ZZTEST_ORD_P14A", "ZZTEST_MAT_P14A"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db = pg
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM order_distribution WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.WC))
            cur.execute("DELETE FROM machine WHERE plant = %s AND machine = %s",
                        (self.PLANT, self.LINE))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.WC))
            # distribute mode so default_machine may stay NULL (no ordering
            # dependency on the machine row existing yet).
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                "VALUES (%s, %s, 'distribute')",
                (self.PLANT, self.WC),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                "VALUES (%s, %s, %s, %s)",
                (self.SUB, self.PLANT, self.LINE, self.WC),
            )
            cur.execute(
                "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter) "
                "VALUES (%s, %s, %s, %s)",
                (self.PLANT, self.ORD, self.MAT, self.WC),
            )
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM order_distribution WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.WC))
            cur.execute("DELETE FROM machine WHERE plant = %s AND machine = %s",
                        (self.PLANT, self.LINE))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.WC))
            conn.commit()

    def test_reports_both_machine_and_header_referrers(self, pg):
        import master_data as md
        res = md.cascade_preview("sap_workcenter", [{"plant": self.PLANT, "sap_workcenter": self.WC}])
        assert res["machine"] == 1
        assert res["headers"] == 1

    def test_seeds_all_six_keys_even_when_unreferenced(self, pg):
        """The result dict must always have a stable shape (all keys present,
        seeded to 0) so the delete-confirmation UI never sees an absent key."""
        import master_data as md
        res = md.cascade_preview("sap_workcenter", [{"plant": self.PLANT, "sap_workcenter": "ZZTEST_WC_NOEXIST"}])
        assert res == {"plants": 0, "machine": 0, "material_plants": 0, "bom_items": 0,
                        "role_plants": 0, "headers": 0}


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
                "INSERT INTO orders (id, production_order, material_number, machine, "
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

    def test_priority_attributes_persist_and_return_new_version(self, pg):
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT xmin::text::bigint FROM orders WHERE id = %s", (oid,))
            base_version = int(cur.fetchone()[0])
        res = db.update_task_dates_bulk([{
            "id": oid,
            "start": None,
            "end": None,
            "PRT_01": "MOLD-A",
            "PRT_02": "MOLD-B",
            "PRODUCTION_VERSION": "0001",
            "base_version": base_version,
        }])
        assert res["persisted"] == 1 and res["versions"][oid] != base_version

        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT prt_01, prt_02, production_version FROM orders WHERE id = %s",
                (oid,),
            )
            assert cur.fetchone() == ("MOLD-A", "MOLD-B", "0001")

    def test_priority_attribute_update_rejects_stale_version(self, pg):
        db = pg
        oid = db.make_id(self.ORD, self.MAT)
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT xmin::text::bigint FROM orders WHERE id = %s", (oid,))
            current_version = int(cur.fetchone()[0])
        res = db.update_task_dates_bulk([{
            "id": oid,
            "start": None,
            "end": None,
            "PRT_01": "SHOULD-NOT-WRITE",
            "base_version": current_version - 1,
        }])
        assert res["persisted"] == 0 and res["stale"] == [oid]

    @pytest.mark.skip(reason="#203 lost-rows-as-success needs a concurrent DELETE injected between "
                             "SELECT FOR UPDATE and the UPDATE; document here, implement with a "
                             "concurrency harness when the #203 fix lands.")
    def test_desired_lost_rows_counted_as_failed(self, pg):
        ...
