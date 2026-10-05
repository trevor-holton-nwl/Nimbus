"""
Real-DB coverage for the Excel/BOM ingest data layer (db.ingest_orders_from_excel,
master_data.ingest_bom_from_excel, db.purge_orders_by_date).

Plan reference: docs/superpowers/plans/2026-09-04-code-review-verification-triage.md,
Task 4 -- Code_Review_09_01.md section 10 item 2 ("backend/integration/ has zero
coverage ... the widest bulk-write blast radius in the app"). Existing
tests/test_integration_routes.py only exercises the /upload, /bom/upload, /purge
ROUTES with these three functions mocked out -- this file drives the real
parsing/upsert SQL against a real Postgres connection instead.

Requires a local Postgres with NIMBUS_TEST_DB=1 (see tests/conftest.py) --
auto-skipped otherwise.
"""
import datetime as dt
import io

import pandas as pd
import pytest

import master_data


def _xlsx(rows: list[dict]) -> bytes:
    buf = io.BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


@pytest.mark.pg
class TestIngestOrdersFromExcelRealDb:
    ORDER, MATERIAL, PLANT, MACHINE = (
        "ZZTEST_ING_ORD", "ZZTEST_ING_MAT", "ZZTEST_ING_PLANT", "ZZTEST_ING_LINE",
    )

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            cur.execute(
                "DELETE FROM upload_audit WHERE filename LIKE 'zztest_ingest%'"
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            cur.execute(
                "DELETE FROM upload_audit WHERE filename LIKE 'zztest_ingest%'"
            )
            conn.commit()

    def test_insert_then_reupload_updates_same_row_not_a_duplicate(self, pg):
        """First upload inserts one row; a second upload of the SAME
        production_order/material with a changed start date must UPDATE that
        row in place, not insert a second one -- this is the literal
        replace-on-reupload contract the ingest path is supposed to honor."""
        db_ = pg
        start_1 = "2026-09-10 08:00"
        workbook_1 = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "WERKS": self.PLANT,
            "MACHINE": self.MACHINE,
            "BASIC_START_DATE": start_1,
        }])

        result_1 = db_.ingest_orders_from_excel(workbook_1, "zztest_ingest_1.xlsx")
        assert result_1["status"] == "ok"
        assert result_1["inserted"] == 1
        assert result_1["updated"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*), MIN(basic_start_date) FROM orders WHERE production_order = %s",
                (self.ORDER,),
            )
            count, first_start = cur.fetchone()
        assert count == 1

        start_2 = "2026-09-11 09:00"
        workbook_2 = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "WERKS": self.PLANT,
            "MACHINE": self.MACHINE,
            "BASIC_START_DATE": start_2,
        }])
        result_2 = db_.ingest_orders_from_excel(workbook_2, "zztest_ingest_2.xlsx")
        assert result_2["status"] == "ok"
        assert result_2["updated"] == 1
        assert result_2["inserted"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*), MIN(basic_start_date) FROM orders WHERE production_order = %s",
                (self.ORDER,),
            )
            count_after, start_after = cur.fetchone()
        assert count_after == 1, "reupload must UPDATE the existing row, not insert a duplicate"
        assert start_after != first_start, "the updated start date must actually persist"

    def test_missing_required_column_rejects_with_zero_rows_written(self, pg):
        """A workbook missing BASIC_START_DATE must be rejected before any
        row is written -- the required-columns guard at db.py:2248-2256."""
        db_ = pg
        workbook = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
        }])
        result = db_.ingest_orders_from_excel(workbook, "zztest_ingest_bad.xlsx")
        assert result["status"] == "error"
        assert result["inserted"] == 0
        assert result["updated"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            (count,) = cur.fetchone()
        assert count == 0


@pytest.mark.pg
class TestIngestBomFromExcelRealDb:
    MATERIAL, COMPONENT, UNKNOWN_COMPONENT, PLANT = (
        "ZZTEST_BOM_MAT", "ZZTEST_BOM_COMP", "ZZTEST_BOM_NOPE", "ZZT_BOMPLT",
    )

    @pytest.fixture(autouse=True)
    def _seed_and_cleanup(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for mat in (self.MATERIAL, self.COMPONENT):
                cur.execute(
                    "INSERT INTO materials (material_id) VALUES (%s) "
                    "ON CONFLICT (material_id) DO NOTHING",
                    (mat,),
                )
                cur.execute(
                    "INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) "
                    "ON CONFLICT (material_id, plant) DO NOTHING",
                    (mat, self.PLANT),
                )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bom_items WHERE material_id = %s", (self.MATERIAL,)
            )
            cur.execute(
                "DELETE FROM material_plants WHERE material_id IN (%s, %s)",
                (self.MATERIAL, self.COMPONENT),
            )
            cur.execute(
                "DELETE FROM materials WHERE material_id IN (%s, %s)",
                (self.MATERIAL, self.COMPONENT),
            )
            # master_data.ingest_bom_from_excel's bulk_apply() call writes an
            # admin_audit row (table_name='bom_items', action='bulk_apply',
            # user_email=<the ingest caller>) on every run -- scoped narrowly
            # to this test's own actor so real audit history is untouched.
            cur.execute(
                "DELETE FROM admin_audit WHERE table_name = %s AND action = %s"
                " AND user_email = %s",
                ("bom_items", "bulk_apply", "tester@example.com"),
            )
            conn.commit()

    def test_valid_row_inserts_and_unknown_pair_is_rejected_not_hard_failed(self, pg):
        """A row referencing a real (material, plant) / (component, plant)
        pair in material_plants must insert into bom_items; a row referencing
        an unknown component must be individually rejected (warnings +
        rejected count) WITHOUT failing the rest of the upload -- the
        documented per-row-reject behavior at master_data.py:2474-2486."""
        workbook = _xlsx([
            {
                "MATERIAL": self.MATERIAL, "PLANT": self.PLANT,
                "ALTERNATIVE_BOM": "01", "LEVEL": 1, "ITEM_NUMBER": "0010",
                "COMPONENT": self.COMPONENT,
            },
            {
                "MATERIAL": self.MATERIAL, "PLANT": self.PLANT,
                "ALTERNATIVE_BOM": "01", "LEVEL": 1, "ITEM_NUMBER": "0020",
                "COMPONENT": self.UNKNOWN_COMPONENT,
            },
        ])

        result = master_data.ingest_bom_from_excel(workbook, "zztest_bom.xlsx", "tester@example.com")
        assert result["status"] == "ok"
        assert result["inserted"] == 1
        assert result["rejected"] == 1
        assert any("not found at plant" in w["msg"] for w in result["warnings"])

        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT component_id FROM bom_items WHERE material_id = %s AND plant = %s",
                (self.MATERIAL, self.PLANT),
            )
            rows = [r[0] for r in cur.fetchall()]
        assert rows == [self.COMPONENT]


@pytest.mark.pg
class TestPurgeOrdersByDateRealDb:
    ORDER, MATERIAL, PLANT, MACHINE = (
        "ZZTEST_PURGE_ORD", "ZZTEST_PURGE_MAT", "ZZTEST_PURGE_PLANT", "ZZTEST_PURGE_LINE",
    )

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        self.oid = db_.make_id(self.ORDER, self.MATERIAL)
        self.finish = now + dt.timedelta(days=2)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (self.oid, self.ORDER, self.MATERIAL, self.MACHINE, self.PLANT,
                 self.finish - dt.timedelta(hours=4), self.finish),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            conn.commit()

    def test_deletes_only_rows_in_range_by_effective_end_date(self, pg):
        """db.purge_orders_by_date is now plant-scoped (a required leading
        `plant = %s` predicate, see db.py's _PURGE_WHERE_SQL) -- the fix for
        the original hazard this test used to document, where an unscoped
        DELETE run against a real, possibly shared database could silently
        mass-delete unrelated rows sharing the date window. This sentinel's
        PLANT ('ZZTEST_PURGE_PLANT') is itself the isolation boundary now, but
        the pre-count discipline below is kept as defense in depth -- it
        would still catch a regression that dropped the plant filter."""
        db_ = pg

        def _matching_count(start, end):
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM orders WHERE plant = %s AND "
                    "COALESCE(scheduled_end, basic_finish_date) BETWEEN %s AND %s",
                    (self.PLANT, start, end),
                )
                (count,) = cur.fetchone()
            return count

        out_of_range_start = self.finish + dt.timedelta(days=30)
        out_of_range_end = self.finish + dt.timedelta(days=31)
        pre_miss = _matching_count(out_of_range_start, out_of_range_end)
        if pre_miss != 0:
            pytest.fail(
                f"expected 0 matching rows before purge, found {pre_miss} -- "
                "refusing to run a destructive purge that would delete unrelated data"
            )
        result_miss = db_.purge_orders_by_date(self.PLANT, out_of_range_start, out_of_range_end)
        assert result_miss["status"] == "ok"
        assert result_miss["deleted"] == 0
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            (still_there,) = cur.fetchone()
        assert still_there == 1, "purge must not delete rows outside the requested range"

        in_range_start = self.finish - dt.timedelta(days=1)
        in_range_end = self.finish + dt.timedelta(days=1)
        pre_hit = _matching_count(in_range_start, in_range_end)
        if pre_hit != 1:
            pytest.fail(
                f"expected 1 matching row (the sentinel) before purge, found {pre_hit} -- "
                "refusing to run a destructive purge that would delete unrelated data"
            )
        result_hit = db_.purge_orders_by_date(self.PLANT, in_range_start, in_range_end)
        assert result_hit["status"] == "ok"
        assert result_hit["deleted"] == 1
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            (gone,) = cur.fetchone()
        assert gone == 0

    def test_finish_dates_and_numeric_machine_normalised(self, pg):
        """Plan Part 1 #42/#44: a real 00:30 finish is kept (only an exact
        midnight is date-only and re-derived from RUN_TIME), and a numeric
        MACHINE cell is stored as clean text via _str_id."""
        db_ = pg
        order_b = self.ORDER + "_B"
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE production_order = %s", (order_b,))
            conn.commit()
        try:
            workbook = _xlsx([
                {"PRODUCTION_ORDER": self.ORDER, "MATERIAL_NUMBER": self.MATERIAL,
                 "WERKS": self.PLANT, "MACHINE": 4001, "RUN_TIME": 2,
                 "BASIC_START_DATE": "2026-09-10 08:00", "BASIC_FINISH_DATE": "2026-09-11 00:30"},
                {"PRODUCTION_ORDER": order_b, "MATERIAL_NUMBER": self.MATERIAL,
                 "WERKS": self.PLANT, "MACHINE": 4001, "RUN_TIME": 2,
                 "BASIC_START_DATE": "2026-09-10 08:00", "BASIC_FINISH_DATE": "2026-09-11"},
            ])
            assert db_.ingest_orders_from_excel(workbook, "zztest_ingest_dates.xlsx")["status"] == "ok"
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT production_order, machine, basic_finish_date FROM orders"
                    " WHERE production_order IN (%s, %s)", (self.ORDER, order_b))
                got = {r[0]: r for r in cur.fetchall()}
            assert got[self.ORDER][1] == "4001"
            assert got[self.ORDER][2] == dt.datetime(2026, 9, 11, 0, 30)
            assert got[order_b][2] == dt.datetime(2026, 9, 10, 10, 0)  # date-only -> start + 2h
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE production_order = %s", (order_b,))
                conn.commit()
