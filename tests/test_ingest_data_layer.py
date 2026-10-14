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
from psycopg.types.json import Jsonb

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
            "BASIC_FINISH_DATE": "2026-09-10 12:00",
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
            "BASIC_FINISH_DATE": "2026-09-11 13:00",
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
        """A workbook missing BASIC_FINISH_DATE (the one required date column since backward scheduling Task
        2.7) must be rejected before any row is written -- the required-columns guard."""
        db_ = pg
        workbook = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "BASIC_START_DATE": "2026-09-10 08:00",
        }])
        result = db_.ingest_orders_from_excel(workbook, "zztest_ingest_bad.xlsx")
        assert result["status"] == "error"
        assert "BASIC_FINISH_DATE" in result["message"]
        assert result["inserted"] == 0
        assert result["updated"] == 0

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM orders WHERE production_order = %s", (self.ORDER,)
            )
            (count,) = cur.fetchone()
        assert count == 0

    def test_a_workbook_with_no_start_column_loads_rows_with_a_null_start(self, pg):
        """The start is optional: a workbook with PRODUCTION_ORDER, MATERIAL_NUMBER and BASIC_FINISH_DATE only
        loads, every row keeping its finish as received and a NULL start (never placed, so the browser derives
        the start from the finish)."""
        db_ = pg
        finish = dt.datetime(2026, 9, 12, 14, 0)
        workbook = _xlsx([{
            "PRODUCTION_ORDER": self.ORDER,
            "MATERIAL_NUMBER": self.MATERIAL,
            "BASIC_FINISH_DATE": finish.strftime("%Y-%m-%d %H:%M"),
        }])
        try:
            result = db_.ingest_orders_from_excel(workbook, "zztest_ingest_nostart.xlsx")
            assert result["status"] == "ok", result
            assert result["inserted"] == 1
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT basic_start_date, basic_finish_date, original_start_received,"
                            " original_finish_received, scheduled_start, scheduled_end FROM orders"
                            " WHERE production_order = %s", (self.ORDER,))
                assert cur.fetchone() == (None, finish, None, finish, None, None)
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE production_order = %s", (self.ORDER,))
                conn.commit()


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
            assert got[order_b][2] == dt.datetime(2026, 9, 11)  # date-only finish stored as received
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE production_order = %s", (order_b,))
                conn.commit()

    def test_float_machine_cells_stored_as_clean_text(self, pg):
        """A MACHINE column holding the float 101.0 (alongside 101.5, which
        forces pandas to read the whole column as float64) must store '101'
        for the whole-number cell (Excel float suffix stripped by _str_id) and
        keep '101.5' verbatim -- never '101.0'."""
        db_ = pg
        order_b = self.ORDER + "_F"
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE production_order = %s", (order_b,))
            conn.commit()
        try:
            workbook = _xlsx([
                {"PRODUCTION_ORDER": self.ORDER, "MATERIAL_NUMBER": self.MATERIAL,
                 "WERKS": self.PLANT, "MACHINE": 101.0, "BASIC_START_DATE": "2026-09-10 08:00",
                 "BASIC_FINISH_DATE": "2026-09-10 12:00"},
                {"PRODUCTION_ORDER": order_b, "MATERIAL_NUMBER": self.MATERIAL,
                 "WERKS": self.PLANT, "MACHINE": 101.5, "BASIC_START_DATE": "2026-09-10 08:00",
                 "BASIC_FINISH_DATE": "2026-09-10 12:00"},
            ])
            assert pd.read_excel(io.BytesIO(workbook))["MACHINE"].dtype.kind == "f"
            assert db_.ingest_orders_from_excel(workbook, "zztest_ingest_floatmach.xlsx")["status"] == "ok"
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT production_order, machine FROM orders WHERE production_order IN (%s, %s)",
                            (self.ORDER, order_b))
                got = dict(cur.fetchall())
            assert got == {self.ORDER: "101", order_b: "101.5"}
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE production_order = %s", (order_b,))
                conn.commit()


@pytest.mark.pg
class TestPurgeOrdersByIdsRealDb:
    ORDER, MATERIAL, PLANT, MACHINE = (
        "ZZTEST_PIDS_ORD", "ZZTEST_PIDS_MAT", "ZZTEST_PIDS_PLANT", "ZZTEST_PIDS_LINE",
    )

    def _cleanup(self, db_):
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM order_distribution WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM orders WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM sap_stage_vanished_order WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM admin_audit WHERE table_name = 'orders' AND details->>'plant' = %s",
                        (self.PLANT,))
            conn.commit()

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        self._cleanup(db_)
        now = dt.datetime(2026, 9, 10, 8, 0)
        self.oid = db_.make_id(self.ORDER, self.MATERIAL)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date, scheduled_start, scheduled_end) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.oid, self.ORDER, self.MATERIAL, self.MACHINE, self.PLANT,
                 now, now + dt.timedelta(hours=4), now, now + dt.timedelta(hours=4)),
            )
            cur.execute(
                "INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                " VALUES (%s, 1, %s, %s)", (self.oid, now, now + dt.timedelta(hours=4)))
            cur.execute(
                "INSERT INTO sap_workcenter (plant, sap_workcenter) VALUES (%s,'WC')"
                " ON CONFLICT DO NOTHING", (self.PLANT,))
            cur.execute(
                "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter)"
                " VALUES (%s,%s,%s,'WC')", (self.PLANT, self.ORDER, self.MATERIAL))
            cur.execute(
                "INSERT INTO order_distribution_share (plant, production_order, material_number, machine,"
                " letter, weight, child_id) VALUES (%s,%s,%s,%s,'A',1,%s)",
                (self.PLANT, self.ORDER, self.MATERIAL, self.MACHINE, self.oid))
            conn.commit()
        yield
        self._cleanup(db_)

    def test_purge_by_ids_retires_shares_and_audits(self, pg):
        db_ = pg
        res = db_.purge_orders_by_ids(self.PLANT, [self.oid], user_email="t@example.com")
        assert res == {"status": "ok", "deleted": 1, "archived": 0, "shares_purged": 1, "headers_deleted": 1}
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT COUNT(*) FROM order_distribution WHERE plant = %s", (self.PLANT,))
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT details FROM admin_audit WHERE action = 'sap_snapshot_vanish'"
                        " AND details->>'plant' = %s", (self.PLANT,))
            details = cur.fetchone()[0]
        assert details["deleted"] == 1 and details["order_ids"] == [self.oid]
        assert details["shares_purged"] == 1 and details["headers_deleted"] == 1

    def test_purge_by_ids_archives_then_restore_roundtrip(self, pg):
        db_ = pg
        batch = "00000000-0000-0000-0000-00000000a001"
        res = db_.purge_orders_by_ids(self.PLANT, [self.oid], user_email="t@example.com",
                                      archive_batch_id=batch)
        assert res["deleted"] == 1 and res["archived"] == 1
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT id, order_row, segments, shares FROM sap_stage_vanished_order"
                        " WHERE plant = %s", (self.PLANT,))
            archive_id, order_row, segments, shares = cur.fetchone()
        assert order_row["id"] == self.oid
        assert len(segments) == 1 and len(shares) == 1
        out = db_.restore_vanished_order(archive_id, user_email="t@example.com")
        assert out == {"status": "ok", "order_id": self.oid, "restored": True}
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT COUNT(*) FROM order_schedule_segments WHERE order_id = %s", (self.oid,))
            assert cur.fetchone()[0] == 1
        with pytest.raises(KeyError):
            db_.restore_vanished_order(archive_id)

    def test_empty_id_list_deletes_nothing_and_writes_no_audit(self, pg):
        db_ = pg
        assert db_.purge_orders_by_ids(self.PLANT, [], user_email="t@example.com", archive_batch_id=None) == {
            "status": "ok", "deleted": 0, "archived": 0, "shares_purged": 0, "headers_deleted": 0}
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT COUNT(*) FROM admin_audit WHERE table_name = 'orders' AND details->>'plant' = %s",
                        (self.PLANT,))
            assert cur.fetchone()[0] == 0

    def test_archive_restore_keeps_segments_and_leaves_untouched_orders_xmin_alone(self, pg):
        db_ = pg
        other = db_.make_id("ZZTEST_PIDS_OTHER", self.MATERIAL)
        now = dt.datetime(2026, 9, 10, 8, 0)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date)"
                " VALUES (%s,'ZZTEST_PIDS_OTHER',%s,%s,%s,%s)", (other, self.MATERIAL, self.MACHINE, self.PLANT, now))
            conn.commit()
            cur.execute("SELECT xmin::text FROM orders WHERE id = %s", (other,))
            xmin_before = cur.fetchone()[0]
        batch = "00000000-0000-0000-0000-00000000a003"
        db_.purge_orders_by_ids(self.PLANT, [self.oid], user_email="t@example.com", archive_batch_id=batch)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM sap_stage_vanished_order WHERE plant = %s", (self.PLANT,))
            archive_id = cur.fetchone()[0]
        db_.restore_vanished_order(archive_id, user_email="t@example.com")
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT xmin::text FROM orders WHERE id = %s", (other,))
            assert cur.fetchone()[0] == xmin_before                       # never touched by purge or restore
            cur.execute("SELECT segment_no, scheduled_start, scheduled_end FROM order_schedule_segments"
                        " WHERE order_id = %s", (self.oid,))
            assert cur.fetchall() == [(1, now, now + dt.timedelta(hours=4))]
            cur.execute("SELECT id FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] == self.oid                          # same id back
        with pytest.raises(KeyError):                                     # already restored: refused
            db_.restore_vanished_order(archive_id, user_email="t@example.com")

    def test_restore_with_live_id_collision_keeps_archive_restorable(self, pg):
        """A4: the id is live again -> ValueError('order_exists'), archive row not burned, no audit."""
        db_ = pg
        batch = "00000000-0000-0000-0000-00000000a002"
        db_.purge_orders_by_ids(self.PLANT, [self.oid], user_email="t@example.com", archive_batch_id=batch)
        now = dt.datetime(2026, 9, 11, 8, 0)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM sap_stage_vanished_order WHERE plant = %s", (self.PLANT,))
            archive_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date)"
                " VALUES (%s,%s,%s,%s,%s,%s)", (self.oid, self.ORDER, self.MATERIAL, self.MACHINE, self.PLANT, now))
            conn.commit()
        with pytest.raises(ValueError, match="order_exists"):
            db_.restore_vanished_order(archive_id, user_email="t@example.com")
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT restored_at FROM sap_stage_vanished_order WHERE id = %s", (archive_id,))
            assert cur.fetchone()[0] is None
            cur.execute("SELECT COUNT(*) FROM admin_audit WHERE action = 'sap_vanish_restore'"
                        " AND details->>'archive_id' = %s", (str(archive_id),))
            assert cur.fetchone()[0] == 0


class _AuditCursor:
    """Fake cursor for the non-DB purge audit-shape test."""

    def __init__(self):
        self.executed = []
        self._rows = []

    def execute(self, stmt, params=None):
        stmt = str(stmt)
        self.executed.append((stmt, params))
        if stmt.startswith("DELETE FROM orders"):
            self._rows = [("O1",), ("O2",)]
        elif "UPDATE order_distribution_share" in stmt or "DELETE FROM order_distribution od" in stmt:
            self._rows = [("PO", "M")]
        else:
            self._rows = []

    def fetchall(self):
        return self._rows


class _AuditConn:
    def __init__(self, cur):
        self._cur = cur

    def cursor(self):
        import contextlib
        return contextlib.nullcontext(self._cur)

    def commit(self):
        pass

    def rollback(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_purge_by_date_audit_details_keys_unchanged(monkeypatch):
    import db as db_
    cur = _AuditCursor()
    conn = _AuditConn(cur)

    class _P:
        def connection(self):
            return conn

    monkeypatch.setattr(db_, "_pool", _P())
    res = db_.purge_orders_by_date("P1", dt.date(2026, 9, 1), dt.date(2026, 9, 2), ["M1"], user_email="u@x")
    assert res == {"status": "ok", "deleted": 2, "plant": "P1", "machines": ["M1"],
                   "shares_purged": 1, "headers_deleted": 1}
    audit = next((s, p) for s, p in cur.executed if "INSERT INTO admin_audit" in s)
    assert "'orders', %s" in audit[0]
    action, details, email = audit[1][0], audit[1][1].obj, audit[1][2]
    assert action == "purge_by_date_range" and email == "u@x"
    assert set(details) == {"plant", "machines", "start", "end", "deleted", "order_ids",
                            "order_id_count", "truncated", "shares_purged", "headers_deleted"}


class TestApplyOrderDateHygieneRows:
    """Non-DB: the shared date rules used by the Excel and SAP staging paths."""

    S = dt.datetime(2026, 9, 10, 8, 0)

    def _run(self, rows):
        import db as db_
        warnings: list = []
        return db_.apply_order_date_hygiene_rows(rows, warnings), warnings

    def test_midnight_finish_is_stored_as_received(self):
        out, warnings = self._run([{"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 11),
                                    "run_time": 2}])
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 11)
        assert out[0]["sap_basic_finish_date"] == dt.datetime(2026, 9, 11)
        assert warnings == []

    def test_finish_before_start_same_date_is_stored_as_received(self):
        out, warnings = self._run([{"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 10, 6, 30),
                                    "run_time": 3}])
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 6, 30)
        assert warnings == []

    def test_finish_on_an_earlier_date_than_start_is_dropped_with_warning(self):
        import backend.admin_ops.diagnostics_state as ds
        before = ds.DIAGNOSTICS.get("dropped_no_finish_date", 0)
        out, warnings = self._run([{"production_order": "PO-EARLY", "basic_start_date": self.S,
                                    "basic_finish_date": dt.datetime(2026, 9, 9, 23, 0), "run_time": 3}])
        assert out == []
        assert [w["level"] for w in warnings] == ["error"]
        assert "PO-EARLY" in warnings[0]["msg"] and "earlier" in warnings[0]["msg"]
        assert ds.DIAGNOSTICS["dropped_no_finish_date"] == before + 1

    def test_missing_finish_is_dropped_with_warning_and_counter(self):
        import backend.admin_ops.diagnostics_state as ds
        before = ds.DIAGNOSTICS.get("dropped_no_finish_date", 0)
        good = {"production_order": "PO-OK", "basic_start_date": self.S,
                "basic_finish_date": dt.datetime(2026, 9, 10, 15, 45), "run_time": 1}
        bad = {"production_order": "PO-NOFIN", "basic_start_date": self.S, "basic_finish_date": None,
               "run_time": None}
        out, warnings = self._run([bad, good])
        assert [r["production_order"] for r in out] == ["PO-OK"]
        assert len(warnings) == 1 and warnings[0]["level"] == "error"
        assert "PO-NOFIN" in warnings[0]["msg"] and "BASIC_FINISH_DATE" in warnings[0]["msg"]
        assert ds.DIAGNOSTICS["dropped_no_finish_date"] == before + 1
        assert "dropped_no_finish_date_filled" not in ds.DIAGNOSTICS

    def test_unparseable_finish_is_dropped_with_warning(self):
        out, warnings = self._run([{"basic_start_date": self.S, "basic_finish_date": "not-a-date", "run_time": 1}])
        assert out == []
        assert warnings and warnings[0]["level"] == "error" and "BASIC_FINISH_DATE" in warnings[0]["msg"]

    def test_excel_unparseable_finish_is_dropped_with_warning(self, monkeypatch):
        """Excel path: a text finish that cannot be read drops the row (never filled),
        with an error warning naming the order and the finish counter incremented."""
        import db as db_
        import backend.admin_ops.diagnostics_state as ds
        captured = {}

        def _fake_upsert_orders(rows, **kwargs):
            captured["rows"] = rows
            captured["warnings"] = kwargs.get("warnings")
            return {"status": "ok", "batch_id": kwargs.get("batch_id"),
                    "inserted": len(rows), "updated": 0, "warnings": [], "lines": []}

        monkeypatch.setattr(db_, "upsert_orders", _fake_upsert_orders)
        before = ds.DIAGNOSTICS.get("dropped_no_finish_date", 0)
        res = db_.ingest_orders_from_excel(_xlsx([
            {"PRODUCTION_ORDER": "PO-OK", "MATERIAL_NUMBER": "M-1",
             "BASIC_START_DATE": "2026-09-10 08:00", "BASIC_FINISH_DATE": "2026-09-10 12:00"},
            {"PRODUCTION_ORDER": "PO-JUNK", "MATERIAL_NUMBER": "M-2",
             "BASIC_START_DATE": "2026-09-10 08:00", "BASIC_FINISH_DATE": "not-a-date"},
        ]), "unparseable_finish.xlsx")
        assert res["status"] == "ok"
        assert [r["production_order"] for r in captured["rows"]] == ["PO-OK"]
        errors = [w["msg"] for w in captured["warnings"] if w.get("level") == "error"]
        assert len(errors) == 1 and "BASIC_FINISH_DATE" in errors[0] and "PO-JUNK" in errors[0], errors
        assert ds.DIAGNOSTICS["dropped_no_finish_date"] == before + 1

    def test_parse_finish_dates_retries_mixed_formats_per_value(self):
        import db as db_
        import pandas as pd
        col = pd.Series(["2026-09-11 00:30", "2026-09-11", "garbage", None])
        out = db_._parse_finish_dates(col)
        assert out.iloc[0] == pd.Timestamp("2026-09-11 00:30")
        assert out.iloc[1] == pd.Timestamp("2026-09-11")
        assert pd.isna(out.iloc[2]) and pd.isna(out.iloc[3])

    def test_real_time_of_day_finish_kept_and_bad_start_kept_with_a_null_start_and_a_warning(self):
        good = {"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 10, 15, 45),
                "run_time": 1, "tag": "keep"}
        bad = {"basic_start_date": "not-a-date", "basic_finish_date": dt.datetime(2026, 9, 10, 9, 0), "run_time": 1,
               "tag": "no-start"}
        import backend.admin_ops.diagnostics_state as ds
        before = ds.DIAGNOSTICS.get("unreadable_start_date", 0)
        out, warnings = self._run([bad, good])
        assert ds.DIAGNOSTICS["unreadable_start_date"] == before + 1
        assert [r["tag"] for r in out] == ["no-start", "keep"]
        assert out[0]["basic_start_date"] is None and out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 9, 0)
        assert out[1]["basic_finish_date"] == dt.datetime(2026, 9, 10, 15, 45)
        assert warnings == [{"level": "warn", "msg": "1 row(s) loaded with no start — BASIC_START_DATE is not a "
                                                      "readable date"}]

    def test_a_blank_start_is_simply_absent_not_a_warning(self):
        import backend.admin_ops.diagnostics_state as ds
        before = ds.DIAGNOSTICS.get("unreadable_start_date", 0)
        out, warnings = self._run([{"production_order": "PO-NS", "basic_start_date": None,
                                    "basic_finish_date": dt.datetime(2026, 9, 11, 7, 0), "run_time": 2}])
        assert len(out) == 1 and out[0]["basic_start_date"] is None
        assert out[0]["basic_finish_date"] == out[0]["sap_basic_finish_date"] == dt.datetime(2026, 9, 11, 7, 0)
        assert warnings == []
        assert ds.DIAGNOSTICS.get("unreadable_start_date", 0) == before, "a blank start is not a data problem, so nothing is counted"

    def test_a_finish_with_no_start_is_not_judged_against_the_start(self):
        # the "finish on an earlier date than the start" rule needs a start; without one the row stays
        out, warnings = self._run([{"basic_start_date": None, "basic_finish_date": dt.datetime(2026, 9, 1), "run_time": 1}])
        assert len(out) == 1 and warnings == []

    # One shared fixture set: (start, finish, run_time) as the Excel frame and the SAP row dicts carry them.
    PARITY_CASES = [
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 11), 2),                  # exact-midnight finish: kept as received
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 10, 6, 30), 3),           # finish before start, same date: kept
        (dt.datetime(2026, 9, 10, 8, 0), None, None),                                   # no finish: dropped
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 10, 8, 0), 4),            # finish == start: kept
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 10, 15, 45), 1),          # real finish kept
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 10, 0, 30), "x"),         # junk run time; same-date early finish kept
        (dt.datetime(2026, 9, 10, 8, 0), dt.datetime(2026, 9, 9, 12, 0), 1),            # finish on an earlier date: dropped
        ("not-a-date", dt.datetime(2026, 9, 10, 12, 0), 1),                             # unparseable start: kept, no start
        (None, dt.datetime(2026, 9, 10, 12, 0), 1),                                     # blank start: kept, no start
    ]

    def test_excel_and_sap_paths_give_identical_results_for_the_same_inputs(self):
        import db as db_
        import pandas as pd
        ex_warn: list = []
        df = db_._date_hygiene_df(pd.DataFrame({
            "BASIC_START_DATE": [c[0] for c in self.PARITY_CASES],
            "BASIC_FINISH_DATE": [c[1] for c in self.PARITY_CASES],
            "RUN_TIME": [c[2] for c in self.PARITY_CASES],
        }), ex_warn)
        sap_warn: list = []
        rows = db_.apply_order_date_hygiene_rows(
            [{"basic_start_date": s, "basic_finish_date": f, "run_time": r} for s, f, r in self.PARITY_CASES],
            sap_warn)
        assert sap_warn == ex_warn and len(rows) == len(df) == len(self.PARITY_CASES) - 2
        for (_, h), r in zip(df.iterrows(), rows, strict=True):
            assert r["basic_start_date"] == (h["BASIC_START_DATE"].to_pydatetime()
                                             if pd.notna(h["BASIC_START_DATE"]) else None)
            assert r["basic_finish_date"] == h["BASIC_FINISH_DATE"].to_pydatetime()
            assert r["sap_basic_finish_date"] == (h["_SAP_FINISH_DATE"].to_pydatetime()
                                                  if pd.notna(h["_SAP_FINISH_DATE"]) else None)
            assert r["run_time"] == float(h["RUN_TIME"])
            assert r["_run_time_was_defaulted"] == bool(h["_RUN_TIME_DEFAULTED"])


@pytest.mark.pg
class TestSapTruthReupload:
    """SAP-is-truth re-upload rules: planner machine kept inside SAP's work
    center, locked reset only when SAP changed the order, unchanged rows
    skipped, PV and manual run-time rules."""
    SUB, PLANT = "ZZTEST_STS", "ZZTEST_STP"
    WC, WC2 = "ZZTEST_ST_WC", "ZZTEST_ST_WC2"
    M1, M2, M3 = "ZZTEST_ST_M1", "ZZTEST_ST_M2", "ZZTEST_ST_M3"
    ORDER, MATERIAL, MATERIAL2 = "ZZTEST_ST_ORD", "ZZTEST_ST_MAT", "ZZTEST_ST_MAT2"
    DEFAULT_PV = "DPV1"

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE plant = %s OR production_order LIKE 'ZZTEST_ST_ORD%%'", (self.PLANT,))
        cur.execute("DELETE FROM upload_audit WHERE filename LIKE 'zztest_st_%'")
        cur.execute("DELETE FROM machine WHERE plant = %s", (self.PLANT,))
        cur.execute("DELETE FROM sap_workcenter WHERE plant = %s", (self.PLANT,))
        cur.execute("DELETE FROM material_plants WHERE plant = %s", (self.PLANT,))
        cur.execute("DELETE FROM materials WHERE material_id IN (%s, %s)", (self.MATERIAL, self.MATERIAL2))
        cur.execute("DELETE FROM plants WHERE plant = %s AND subnetwork = %s", (self.PLANT, self.SUB))
        cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.pg = pg
        # A future, non-running slot well outside any default horizon.
        self.base = (dt.datetime.now() + dt.timedelta(days=40)).replace(hour=8, minute=0, second=0, microsecond=0)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("SELECT clock_timestamp()::timestamp")
            started = cur.fetchone()[0]
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'sap truth test')", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'UTC')",
                        (self.SUB, self.PLANT))
            cur.execute("INSERT INTO materials (material_id) VALUES (%s)", (self.MATERIAL,))
            cur.execute("INSERT INTO material_plants (material_id, plant, default_production_version)"
                        " VALUES (%s, %s, %s)", (self.MATERIAL, self.PLANT, self.DEFAULT_PV))
            for wc, default in ((self.WC, self.M1), (self.WC2, self.M3)):
                cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode, default_machine)"
                            " VALUES (%s, %s, 'single', %s)", (self.PLANT, wc, default))
            for m, wc in ((self.M1, self.WC), (self.M2, self.WC), (self.M3, self.WC2)):
                cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES (%s,%s,%s,%s)",
                            (self.SUB, self.PLANT, m, wc))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            # source="sap" upserts write an upload_audit row (filename 'sap:sap') that the filename-LIKE
            # cleanup above does not match; remove the ones this test created (by time) so they cannot
            # crowd test_integration_pg's limit-50 upload-audit window.
            cur.execute("DELETE FROM upload_audit WHERE filename = 'sap:sap' AND uploaded_at >= %s", (started,))
            conn.commit()

    # ---- helpers -------------------------------------------------------
    def _line(self, **kw):
        row = {
            "PRODUCTION_ORDER": self.ORDER, "MATERIAL_NUMBER": self.MATERIAL, "WERKS": self.PLANT,
            "MACHINE": self.WC, "BASIC_START_DATE": self.base,
            "BASIC_FINISH_DATE": self.base + dt.timedelta(days=1), "RUN_TIME": 4,
            "ORDER_QUANTITY_(GMEIN)": 100,
        }
        row.update(kw)
        return row

    def _up(self, rows=None, name="zztest_st_1.xlsx"):
        rows = rows if rows is not None else [self._line()]
        res = self.pg.ingest_orders_from_excel(_xlsx(rows), name)
        assert res["status"] == "ok", res
        return res

    def _oid(self, order=None):
        return self.pg.make_id(order or self.ORDER, self.MATERIAL)

    def _row(self, oid=None):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, machine, production_version, order_quantity, run_time, run_time_source,"
                " scheduled_start, scheduled_end, manual_firmed, planning_status, basic_start_date,"
                " basic_finish_date, sap_workcenter, sap_production_version, sap_basic_start_date,"
                " sap_basic_finish_date, xmin::text::bigint AS version, plant"
                " FROM orders WHERE id = %s", (oid or self._oid(),))
            return dict(zip([c.name for c in cur.description], cur.fetchone(), strict=True))

    def _sql(self, sql, params=()):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()

    def _schedule(self, start, hours=4, machine=None, firm=True, oid=None):
        """Planner state: moved/placed slot + segment + firm."""
        oid = oid or self._oid()
        end = start + dt.timedelta(hours=hours)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET scheduled_start=%s, scheduled_end=%s, manual_firmed=%s,"
                " machine=COALESCE(%s, machine) WHERE id=%s", (start, end, firm, machine, oid))
            cur.execute("DELETE FROM order_schedule_segments WHERE order_id=%s", (oid,))
            cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start,"
                        " scheduled_end) VALUES (%s, 1, %s, %s)", (oid, start, end))
            conn.commit()

    def _planning_reason(self, oid=None):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT planning_reason FROM orders WHERE id=%s", (oid or self._oid(),))
            return cur.fetchone()[0]

    def _segments(self, oid=None):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM order_schedule_segments WHERE order_id=%s", (oid or self._oid(),))
            return cur.fetchone()[0]

    # ---- machine rules -------------------------------------------------
    def test_same_workcenter_move_survives_reupload(self):
        self._up()
        assert self._row()["machine"] == self.M1               # single-mode default
        self._sql("UPDATE orders SET machine=%s WHERE id=%s", (self.M2, self._oid()))
        self._up([self._line(**{"ORDER_QUANTITY_(GMEIN)": 120})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["machine"] == self.M2, "planner's machine inside SAP's work center must survive"
        assert row["order_quantity"] == 120

    def test_changed_workcenter_takes_new_default(self):
        self._up()
        self._sql("UPDATE orders SET machine=%s WHERE id=%s", (self.M2, self._oid()))
        self._up([self._line(MACHINE=self.WC2)], "zztest_st_2.xlsx")
        row = self._row()
        assert row["machine"] == self.M3 and row["sap_workcenter"] == self.WC2

    def test_workcenter_echo_keeps_machine(self):
        # NIMBUS moved the order to a machine of ANOTHER work center and SAP
        # now sends that work center back: the correction came back, no reset.
        self._up()
        slot = self.base + dt.timedelta(days=2)
        self._schedule(slot, machine=self.M3)
        res = self._up([self._line(MACHINE=self.WC2)], "zztest_st_2.xlsx")
        row = self._row()
        assert row["machine"] == self.M3
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True
        assert row["sap_workcenter"] == self.WC2
        assert not [w for w in res["warnings"] if w.get("category") == "sap_changed"]

    def test_unregistered_workcenter_passthrough_unchanged(self):
        self._up([self._line(MACHINE="ZZTEST_ST_UNREG")])
        self._up([self._line(MACHINE="ZZTEST_ST_UNREG", **{"ORDER_QUANTITY_(GMEIN)": 110})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["machine"] == "ZZTEST_ST_UNREG" and row["sap_workcenter"] == "ZZTEST_ST_UNREG"

    # ---- reset on SAP change ------------------------------------------
    def test_sap_date_change_resets_slot_and_unfirms(self):
        self._up()
        self._schedule(self.base + dt.timedelta(days=3))
        # Planner un-scheduled it (Needs Planning); SAP changing the order puts it back.
        self._sql("DELETE FROM order_schedule_segments WHERE order_id=%s", (self._oid(),))
        self._sql("UPDATE orders SET scheduled_start=NULL, scheduled_end=NULL, planning_status='needs_planning',"
                  " planning_reason=%s::jsonb WHERE id=%s",
                  ('{"code":"planner_unscheduled","message":"Unscheduled by planner"}', self._oid()))
        assert self._row()["planning_status"] == "needs_planning"
        res = self._up([self._line(BASIC_START_DATE=self.base + dt.timedelta(days=1),
                                   BASIC_FINISH_DATE=self.base + dt.timedelta(days=2))], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] is None and row["scheduled_end"] is None
        assert row["manual_firmed"] is False and row["planning_status"] == "scheduled"
        assert self._planning_reason() is None
        assert self._segments() == 0
        assert row["sap_basic_start_date"] == self.base + dt.timedelta(days=1)
        cats = {w["category"]: w for w in res["warnings"] if w.get("category") in ("sap_changed", "unfirmed")}
        assert cats["sap_changed"]["count"] == 1 and cats["unfirmed"]["count"] == 1

    def test_sap_change_on_running_order_keeps_slot_and_warns(self):
        self._up()
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        self._schedule(now - dt.timedelta(hours=1), hours=3)
        before = self._row()
        res = self._up([self._line(**{"ORDER_QUANTITY_(GMEIN)": 150})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] == before["scheduled_start"] and row["manual_firmed"] is True
        assert self._segments() == 1
        assert row["order_quantity"] == 150
        warn = next(w for w in res["warnings"] if w.get("category") == "sap_changed_running")
        assert warn["count"] == 1 and self._oid() in warn["order_ids"]
        assert not [w for w in res["warnings"] if w.get("category") == "sap_changed"]

    def test_sap_change_on_never_scheduled_running_window_is_not_a_kept_slot(self):
        # Nothing was scheduled, so there is no slot or firm that "was kept".
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        start, finish = now - dt.timedelta(hours=2), now + dt.timedelta(hours=6)
        self._up([self._line(BASIC_START_DATE=start, BASIC_FINISH_DATE=finish)])
        res = self._up([self._line(BASIC_START_DATE=start + dt.timedelta(days=1),
                                   BASIC_FINISH_DATE=finish + dt.timedelta(days=1))], "zztest_st_2.xlsx")
        assert not [w for w in res["warnings"] if w.get("category") == "sap_changed_running"]

    def test_sap_change_on_frozen_order_resets(self):
        self._up()
        self._sql("UPDATE plants SET frozen_horizon_days=3650 WHERE plant=%s", (self.PLANT,))
        self._schedule(self.base)
        self._up([self._line(**{"ORDER_QUANTITY_(GMEIN)": 150})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] is None and row["manual_firmed"] is False

    def test_unchanged_reupload_keeps_slot_firm_xmin_and_manual_runtime(self):
        self._up()
        self._schedule(self.base + dt.timedelta(days=3))
        # Non-routing plant: SAP's run time (4) stays the truth, so the planner's flag is
        # only observable here on a run time equal to SAP's; the routing-plant rule (a
        # manual value surviving) is pinned in test_audit_routing_db.py.
        self._sql("UPDATE orders SET run_time=4, run_time_source='manual' WHERE id=%s", (self._oid(),))
        before = self._row()
        res = self._up(name="zztest_st_2.xlsx")
        after = self._row()
        assert after == before, "an unchanged re-upload must not touch the row (xmin included)"
        assert res["inserted"] == 0 and res["updated"] == 0 and res["unchanged"] == 1

    # ---- locked original_*_received (backward-scheduling Task 1.2) ------
    def _orig(self, oid=None):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT original_start_received, original_finish_received, basic_start_date,"
                        " basic_finish_date FROM orders WHERE id = %s", (oid or self._oid(),))
            return dict(zip([c.name for c in cur.description], cur.fetchone(), strict=True))

    def _remember_sent(self, finish, oid=None):
        self._sql("INSERT INTO order_sap_sent (order_id, plant, sent_finish) VALUES (%s, %s, %s)"
                  " ON CONFLICT (order_id) DO UPDATE SET sent_finish = EXCLUDED.sent_finish",
                  (oid or self._oid(), self.PLANT, finish))

    def test_first_ingest_sets_the_locked_original_dates(self):
        self._up()
        o = self._orig()
        assert o["original_start_received"] == self.base
        assert o["original_finish_received"] == self.base + dt.timedelta(days=1)

    def test_sent_then_echo_upload_keeps_the_original_dates_while_basic_moves(self):
        self._up()
        sent = self.base + dt.timedelta(days=3)
        self._remember_sent(sent)
        # SAP echoes the finish NIMBUS sent and back-schedules its start
        self._up([self._line(BASIC_START_DATE=self.base + dt.timedelta(days=2), BASIC_FINISH_DATE=sent)],
                 "zztest_st_2.xlsx")
        o = self._orig()
        assert o["basic_finish_date"] == sent and o["basic_start_date"] == self.base + dt.timedelta(days=2)
        assert o["original_finish_received"] == self.base + dt.timedelta(days=1)
        assert o["original_start_received"] == self.base, "a start-only change after an echo must not refresh it"

    def test_sent_then_genuinely_later_sap_finish_updates_the_original_dates(self):
        self._up()
        self._remember_sent(self.base + dt.timedelta(days=3))
        later_s, later_f = self.base + dt.timedelta(days=4), self.base + dt.timedelta(days=5)
        self._up([self._line(BASIC_START_DATE=later_s, BASIC_FINISH_DATE=later_f)], "zztest_st_2.xlsx")
        o = self._orig()
        assert o["original_finish_received"] == later_f and o["original_start_received"] == later_s

    def test_never_sent_sap_change_refreshes_the_original_dates(self):
        self._up()
        later_s, later_f = self.base + dt.timedelta(days=2), self.base + dt.timedelta(days=4)
        self._up([self._line(BASIC_START_DATE=later_s, BASIC_FINISH_DATE=later_f)], "zztest_st_2.xlsx")
        o = self._orig()
        assert o["original_finish_received"] == later_f and o["original_start_received"] == later_s

    # ---- a start-only SAP change keeps the placement (backward scheduling OQ25 c, Task 2.7) -------------
    def test_start_only_sap_change_on_a_never_sent_order_keeps_the_slot_and_refreshes_the_original_start(self):
        self._up()
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        moved_s = self.base - dt.timedelta(days=1)          # SAP moved the start; the finish is unchanged
        res = self._up([self._line(BASIC_START_DATE=moved_s)], "zztest_st_2.xlsx")
        row, o = self._row(), self._orig()
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True and self._segments() == 1
        assert not [w for w in res["warnings"] if w.get("category") in ("sap_changed", "unfirmed")]
        assert row["sap_basic_start_date"] == moved_s and row["basic_start_date"] == moved_s
        # never sent, so the finish is not an echo: the locked start follows SAP; the finish did not change
        assert o["original_start_received"] == moved_s
        assert o["original_finish_received"] == self.base + dt.timedelta(days=1)

    def test_start_only_sap_change_on_a_sent_order_whose_finish_echoes_keeps_the_slot_and_both_locked_dates(self):
        self._up()
        f = self.base + dt.timedelta(days=1)
        self._remember_sent(f)                                  # NIMBUS sent the very finish SAP still holds
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        moved_s = self.base - dt.timedelta(days=1)
        res = self._up([self._line(BASIC_START_DATE=moved_s)], "zztest_st_2.xlsx")
        row, o = self._row(), self._orig()
        assert row["basic_start_date"] == moved_s, "the row was written (SAP's start moved)"
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True
        assert not [w for w in res["warnings"] if w.get("category") == "sap_changed"]
        assert o["original_start_received"] == self.base, "an echo keeps BOTH locked dates"
        assert o["original_finish_received"] == f

    def test_a_finish_change_still_resets_whatever_the_start_does(self):
        self._up()
        self._schedule(self.base + dt.timedelta(days=3))
        self._up([self._line(BASIC_FINISH_DATE=self.base + dt.timedelta(days=5))], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] is None and row["manual_firmed"] is False

    def test_a_reupload_that_sends_no_start_keeps_the_stored_start_and_the_slot(self):
        self._up()
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        self._up([self._line(BASIC_START_DATE=None, RUN_TIME=5)], "zztest_st_2.xlsx")   # run time differs, so the row is written
        row = self._row()
        assert row["basic_start_date"] == self.base, "a start SAP did not send never erases the stored one"
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True

    def test_echo_with_null_stored_originals_still_populates_them(self):
        self._up()
        sent = self.base + dt.timedelta(days=3)
        self._remember_sent(sent)
        self._sql("UPDATE orders SET original_start_received = NULL, original_finish_received = NULL WHERE id = %s",
                  (self._oid(),))
        self._up([self._line(BASIC_START_DATE=self.base + dt.timedelta(days=2), BASIC_FINISH_DATE=sent)],
                 "zztest_st_2.xlsx")
        o = self._orig()
        assert o["original_finish_received"] == sent and o["original_start_received"] == self.base + dt.timedelta(days=2)

    def test_cross_zone_date_only_echo_via_sap_path_keeps_the_original_dates(self):
        """M1 at the database: a Chicago plant, SAP in UTC. NIMBUS sent Thu 19:00 CDT (= 00:00 UTC Fri);
        SAP echoes the finish as the date-only Fri, back-scheduling the start."""
        self._sql("UPDATE plants SET timezone = 'America/Chicago' WHERE plant = %s", (self.PLANT,))
        thu = dt.datetime(2026, 10, 22, 19, 0)            # Thu 22 Oct 2026, CDT (UTC-5): 19:00 = 00:00 UTC Fri 23
        first_s, first_f = dt.datetime(2026, 10, 19, 8, 0), dt.datetime(2026, 10, 20, 8, 0)

        def row(start, finish, date_only):
            return {"production_order": self.ORDER, "material_number": self.MATERIAL, "machine": self.M1,
                    "plant": self.PLANT, "basic_start_date": start, "basic_finish_date": finish,
                    "_finish_date_only": date_only, "order_quantity": 100, "run_time": 4.0}
        self.pg.upsert_orders([row(first_s, first_f, False)], source="sap", sap_tz="UTC")
        self._remember_sent(thu)
        fri = dt.datetime(2026, 10, 23, 0, 0)
        res = self.pg.upsert_orders([row(dt.datetime(2026, 10, 21, 8, 0), fri, True)], source="sap", sap_tz="UTC")
        assert res["updated"] == 1
        o = self._orig()
        assert o["basic_finish_date"] == fri
        assert o["original_finish_received"] == first_f and o["original_start_received"] == first_s
        # Saturday is a genuine change: both locked dates move
        sat = dt.datetime(2026, 10, 24, 0, 0)
        self.pg.upsert_orders([row(dt.datetime(2026, 10, 22, 8, 0), sat, True)], source="sap", sap_tz="UTC")
        o = self._orig()
        assert o["original_finish_received"] == sat and o["original_start_received"] == dt.datetime(2026, 10, 22, 8, 0)

    def test_first_upload_after_migration_resets_nothing(self):
        self._up()
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot, machine=self.M2)
        self._sql("UPDATE orders SET production_version='PLNR', sap_workcenter=NULL, sap_production_version=NULL,"
                  " sap_basic_start_date=NULL, sap_basic_finish_date=NULL WHERE id=%s", (self._oid(),))
        self._up([self._line(BASIC_START_DATE=self.base + dt.timedelta(days=1),
                             BASIC_FINISH_DATE=self.base + dt.timedelta(days=2),
                             PRODUCTION_VERSION="SAP1")], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True
        assert row["machine"] == self.M2, "same-work-center move survives the first upload"
        assert row["production_version"] == "PLNR", "planner PV survives while the baseline is unknown"
        assert row["sap_workcenter"] == self.WC and row["sap_production_version"] == "SAP1"
        assert row["sap_basic_start_date"] == self.base + dt.timedelta(days=1)

    # ---- duplicates ----------------------------------------------------
    def test_duplicate_rows_reordered_keep_ids(self):
        early = self._line(BASIC_START_DATE=self.base, BASIC_FINISH_DATE=self.base + dt.timedelta(days=1))
        late = self._line(BASIC_START_DATE=self.base + dt.timedelta(days=2),
                          BASIC_FINISH_DATE=self.base + dt.timedelta(days=3))
        self._up([early, late])
        plain, suffixed = self._oid(), self._oid() + "_1"
        assert self._row(plain)["basic_start_date"] == self.base
        assert self._row(suffixed)["basic_start_date"] == self.base + dt.timedelta(days=2)
        before = (self._row(plain), self._row(suffixed))
        res = self._up([late, early], "zztest_st_2.xlsx")
        assert (self._row(plain), self._row(suffixed)) == before
        assert res["updated"] == 0 and res["unchanged"] == 2

    # ---- production version -------------------------------------------
    def test_pv_echo_is_not_a_change(self):
        self._up([self._line(PRODUCTION_VERSION="PV01")])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        self._sql("UPDATE orders SET production_version='PV02' WHERE id=%s", (self._oid(),))
        self._up([self._line(PRODUCTION_VERSION="PV02")], "zztest_st_2.xlsx")
        row = self._row()
        assert row["production_version"] == "PV02" and row["sap_production_version"] == "PV02"
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True

    def test_planner_pv_survives_when_sap_pv_unchanged(self):
        self._up([self._line(PRODUCTION_VERSION="PV01")])
        self._sql("UPDATE orders SET production_version='PV02' WHERE id=%s", (self._oid(),))
        self._up([self._line(PRODUCTION_VERSION="PV01", **{"ORDER_QUANTITY_(GMEIN)": 130})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["production_version"] == "PV02" and row["order_quantity"] == 130

    def test_blank_pv_takes_material_default(self):
        self._up([self._line(PRODUCTION_VERSION="PV07")])
        assert self._row()["production_version"] == "PV07"
        self._up([self._line(PRODUCTION_VERSION=None)], "zztest_st_2.xlsx")
        row = self._row()
        assert row["production_version"] == self.DEFAULT_PV and row["sap_production_version"] == ""

    def test_pv_column_absent_keeps_stored_version(self):
        self._up([self._line(PRODUCTION_VERSION="PV07")])
        self._up([self._line(**{"ORDER_QUANTITY_(GMEIN)": 130})], "zztest_st_2.xlsx")
        row = self._row()
        assert row["production_version"] == "PV07" and row["sap_production_version"] == "PV07"

    # ---- reports / counts ---------------------------------------------
    def test_missing_master_data_report_includes_unchanged_rows(self):
        line = self._line(MATERIAL_NUMBER=self.MATERIAL2)
        self._up([line])
        res = self._up([line], "zztest_st_2.xlsx")
        assert res["unchanged"] == 1
        entry = next(w for w in res["warnings"] if w.get("category") == "missing_master_data")
        assert [e["material_number"] for e in entry["exceptions"]] == [self.MATERIAL2]

    def test_counts_inserted_updated_unchanged(self):
        rows = [self._line(PRODUCTION_ORDER=f"{self.ORDER}_{i}") for i in range(3)]
        res1 = self._up(rows)
        assert (res1["inserted"], res1["updated"], res1["unchanged"]) == (3, 0, 0)
        rows[1] = {**rows[1], "ORDER_QUANTITY_(GMEIN)": 999}
        res2 = self._up(rows, "zztest_st_2.xlsx")
        assert (res2["inserted"], res2["updated"], res2["unchanged"]) == (0, 1, 2)
        notes = [w for w in res2["warnings"] if w.get("category") == "upload_counts"]
        assert notes and notes[0]["unchanged"] == 2

    def test_unchanged_reupload_heals_null_plant_and_machine_key(self):
        # No plant on the row and a machine master data does not know yet: plant stays
        # NULL. (Straight to upsert_orders, no plan_fn, so only the post-upload backfill
        # can fill it once the machine exists and the row itself is unchanged.)
        row_in = {"production_order": self.ORDER, "material_number": self.MATERIAL,
                  "machine": "ZZTEST_ST_LATE", "basic_start_date": self.base,
                  "basic_finish_date": self.base + dt.timedelta(days=1), "order_quantity": 100,
                  "run_time": 4.0}
        self.pg.upsert_orders([dict(row_in)], source="excel", filename="zztest_st_1.xlsx")
        assert self._row()["plant"] is None
        self._sql("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s, %s, %s)",
                  (self.SUB, self.PLANT, "ZZTEST_ST_LATE"))
        res = self.pg.upsert_orders([dict(row_in)], source="excel", filename="zztest_st_2.xlsx")
        row = self._row()
        assert res["unchanged"] == 1 and res["updated"] == 0
        assert row["plant"] == self.PLANT
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT machine_key FROM orders WHERE id = %s", (self._oid(),))
            assert cur.fetchone()[0] is not None

    def test_routing_switch_on_padding_is_not_a_pv_change(self):
        # Baseline '1' recorded while the plant was not routing-enabled; enabling routing
        # pads the incoming '1' to '0001' -- must be neither a write nor a reset.
        row = {"production_order": self.ORDER, "material_number": self.MATERIAL, "machine": self.M1,
               "plant": self.PLANT, "basic_start_date": self.base,
               "basic_finish_date": self.base + dt.timedelta(days=1), "order_quantity": 100,
               "run_time": 4.0, "production_version": "1"}
        self.pg.upsert_orders([dict(row)], source="excel", filename="zztest_st_1.xlsx")
        self._schedule(self.base + dt.timedelta(days=3))
        self._sql("UPDATE plants SET routing_runtime_enabled = TRUE WHERE plant = %s", (self.PLANT,))
        before = self._row()
        res = self.pg.upsert_orders([dict(row)], source="excel", filename="zztest_st_2.xlsx")
        assert res["updated"] == 0 and res["unchanged"] == 1
        assert self._row() == before

    # ---- audit fix round: derived finish is never an SAP date change (F3) ----
    def _date_only_line(self, **kw):
        d0 = self.base.replace(hour=0)
        return self._line(BASIC_START_DATE=d0, BASIC_FINISH_DATE=d0 + dt.timedelta(days=1), **kw)

    def _no_sap_reset(self, res):
        assert not [w for w in res["warnings"] if w.get("category") in ("sap_changed", "unfirmed")], res["warnings"]

    def test_run_time_change_alone_is_not_a_sap_date_change(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        res = self._up([self._date_only_line(RUN_TIME=6)], "zztest_st_2.xlsx")
        row = self._row()
        self._no_sap_reset(res)
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True

    def _flags(self, oid=None):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT runtime_schedule_mismatch, placement_exception, run_time FROM orders WHERE id = %s",
                        (oid or self._oid(),))
            return cur.fetchone()

    def test_run_time_change_flags_a_placed_plain_order(self):
        """Backward scheduling OQ34: ANY placed order whose run time moves on a re-upload is flagged stale
        (this used to be distribution children only); the planner's slot itself is untouched."""
        self._up([self._date_only_line(RUN_TIME=4)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        assert self._flags()[0] is False
        self._up([self._date_only_line(RUN_TIME=6)], "zztest_st_2.xlsx")
        flag, _marker, run_time = self._flags()
        assert flag is True and float(run_time) == 6
        assert self._row()["scheduled_start"] == slot

    def test_run_time_change_flags_an_order_placed_by_a_finish_alone(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        self._sql("UPDATE orders SET scheduled_end = %s WHERE id = %s",
                  (self.base + dt.timedelta(days=3), self._oid()))
        self._up([self._date_only_line(RUN_TIME=6)], "zztest_st_2.xlsx")
        assert self._flags()[0] is True

    def test_run_time_change_does_not_flag_a_never_placed_order(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        self._up([self._date_only_line(RUN_TIME=6)], "zztest_st_2.xlsx")
        flag, _marker, run_time = self._flags()
        assert flag is False and float(run_time) == 6

    def test_an_unchanged_run_time_leaves_a_placed_order_unflagged(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        self._schedule(self.base + dt.timedelta(days=3))
        self._up([self._date_only_line(RUN_TIME=4, **{"ORDER_QUANTITY_(GMEIN)": 150})], "zztest_st_2.xlsx")
        assert self._flags()[0] is False

    def test_an_sap_date_change_resets_the_slot_and_clears_the_flag_and_the_marker(self):
        self._up()
        self._schedule(self.base + dt.timedelta(days=3))
        self._sql("UPDATE orders SET runtime_schedule_mismatch = TRUE, placement_exception = 'overtime' WHERE id = %s",
                  (self._oid(),))
        self._up([self._line(BASIC_FINISH_DATE=self.base + dt.timedelta(days=2))], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] is None and row["scheduled_end"] is None
        assert self._flags()[:2] == (False, None)

    def test_run_time_column_dropped_is_not_a_sap_date_change(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        line = self._date_only_line()
        del line["RUN_TIME"]
        res = self._up([line], "zztest_st_2.xlsx")
        self._no_sap_reset(res)
        assert self._row()["scheduled_start"] == slot and self._row()["manual_firmed"] is True

    def test_finish_column_absent_is_rejected_before_any_row_is_written(self):
        """BASIC_FINISH_DATE is the one required date column (backward scheduling Task 2.7)."""
        line = self._line()
        del line["BASIC_FINISH_DATE"]
        res = self.pg.ingest_orders_from_excel(_xlsx([line]), "zztest_st_1.xlsx")
        assert res["status"] == "error" and res["inserted"] == 0 and res["updated"] == 0, res
        assert "BASIC_FINISH_DATE" in res["message"]
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM orders WHERE id = %s", (self._oid(),))
            assert cur.fetchone()[0] == 0

    def test_run_time_change_on_routing_plant_is_not_a_sap_date_change(self):
        self._sql("UPDATE plants SET routing_runtime_enabled = TRUE WHERE plant=%s", (self.PLANT,))
        self._up([self._date_only_line(RUN_TIME=4)])
        res = self._up([self._date_only_line(RUN_TIME=6)], "zztest_st_2.xlsx")
        self._no_sap_reset(res)
        assert res["updated"] == 0 and res["unchanged"] == 1

    def test_real_sap_finish_date_change_resets(self):
        self._up()
        self._schedule(self.base + dt.timedelta(days=3))
        res = self._up([self._line(BASIC_FINISH_DATE=self.base + dt.timedelta(days=2))], "zztest_st_2.xlsx")
        row = self._row()
        assert row["scheduled_start"] is None and row["manual_firmed"] is False
        assert [w for w in res["warnings"] if w.get("category") == "sap_changed"]
        assert row["sap_basic_finish_date"] == self.base + dt.timedelta(days=2)

    # ---- audit fix round: machine follows SAP only when SAP's field changed (F6) ----
    def test_name_feed_benign_change_keeps_planner_machine(self):
        # SAP sends machine NAMES; a description-only change must not revert the planner's machine.
        self._up([self._line(MACHINE=self.M1)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot, machine=self.M2)
        res = self._up([self._line(MACHINE=self.M1, MATERIAL_DESCRIPTION="renamed")], "zztest_st_2.xlsx")
        row = self._row()
        assert res["updated"] == 1
        assert row["machine"] == self.M2, "planner machine must survive a benign SAP write"
        assert row["scheduled_start"] == slot and row["manual_firmed"] is True

    def test_name_feed_machine_change_by_sap_still_wins(self):
        self._up([self._line(MACHINE=self.M1)])
        self._schedule(self.base + dt.timedelta(days=3), machine=self.M2)
        self._up([self._line(MACHINE=self.M3)], "zztest_st_2.xlsx")
        assert self._row()["machine"] == self.M3

    def test_machine_name_echo_is_not_a_workcenter_change(self):
        self._up([self._line(MACHINE=self.M1)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot, machine=self.M2)
        res = self._up([self._line(MACHINE=self.M2)], "zztest_st_2.xlsx")
        row = self._row()
        self._no_sap_reset(res)
        assert row["machine"] == self.M2 and row["scheduled_start"] == slot and row["manual_firmed"] is True

    # ---- audit fix round: unchanged re-upload fills NULL master-data attributes (F8) ----
    def test_unchanged_reupload_fills_null_master_data_attributes(self):
        line = self._line(MATERIAL_NUMBER=self.MATERIAL2)
        self._sql("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (self.MATERIAL2,))
        self._up([line])
        oid = self.pg.make_id(self.ORDER, self.MATERIAL2)
        assert self._row(oid)["production_version"] is None
        self._sql("INSERT INTO material_plants (material_id, plant, default_production_version, color, prt_01)"
                  " VALUES (%s, %s, 'NPV1', 'RED', 'T1')", (self.MATERIAL2, self.PLANT))
        res = self._up([line], "zztest_st_2.xlsx")
        assert res["unchanged"] == 1
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT production_version, color, prt_01 FROM orders WHERE id=%s", (oid,))
            assert cur.fetchone() == ("NPV1", "RED", "T1")

    def test_unchanged_reupload_with_nothing_to_fill_keeps_xmin(self):
        self._up()
        before = self._row()
        res = self._up(name="zztest_st_2.xlsx")
        assert res["unchanged"] == 1 and self._row() == before

    # ---- audit fix round: SAP-sync path passes ISO strings (F9) ----
    def test_iso_string_dates_description_change_is_not_a_reset(self):
        def row_in(**kw):
            r = {"production_order": self.ORDER, "material_number": self.MATERIAL, "machine": self.M1,
                 "plant": self.PLANT, "basic_start_date": self.base.isoformat(),
                 "basic_finish_date": (self.base + dt.timedelta(days=1)).isoformat(),
                 "order_quantity": 100, "run_time": 4.0}
            r.update(kw)
            return r
        self.pg.upsert_orders([row_in()], source="sap")
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        res = self.pg.upsert_orders([row_in(material_description="renamed")], source="sap")
        self._no_sap_reset(res)
        assert self._row()["scheduled_start"] == slot and self._row()["manual_firmed"] is True

    # ---- fix round 1 ----
    def test_machine_deleted_then_benign_write_takes_sap_default(self):
        self._up()
        self._sql("UPDATE orders SET machine=%s WHERE id=%s", (self.M2, self._oid()))
        self._sql("UPDATE orders SET machine=%s WHERE id=%s", ("ZZTEST_ST_GONE", self._oid()))
        self._up([self._line(MATERIAL_DESCRIPTION="renamed")], "zztest_st_2.xlsx")
        assert self._row()["machine"] == self.M1, "a machine that no longer exists self-heals to SAP's default"

    def test_plant_change_with_same_workcenter_takes_machine_of_new_plant(self):
        plant2 = self.PLANT + "B"
        self._sql("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'UTC')", (self.SUB, plant2))
        self._sql("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode, default_machine)"
                  " VALUES (%s, %s, 'single', %s)", (plant2, self.WC, "ZZTEST_ST_B1"))
        self._sql("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES (%s,%s,%s,%s)",
                  (self.SUB, plant2, "ZZTEST_ST_B1", self.WC))
        try:
            self._up()
            self._up([self._line(WERKS=plant2, MATERIAL_DESCRIPTION="moved")], "zztest_st_2.xlsx")
            row = self._row()
            assert row["plant"] == plant2 and row["machine"] == "ZZTEST_ST_B1"
        finally:
            self._sql("DELETE FROM orders WHERE plant = %s", (plant2,))
            self._sql("DELETE FROM machine WHERE plant = %s", (plant2,))
            self._sql("DELETE FROM sap_workcenter WHERE plant = %s", (plant2,))
            self._sql("DELETE FROM plants WHERE plant = %s", (plant2,))

    def test_sap_apply_keeps_excel_only_columns_and_identical_reapply_keeps_xmin(self):
        """A1: a SAP row never carries description / labor / FTE; they must survive a SAP apply,
        and an identical re-apply must write nothing (xmin unchanged)."""
        def row_in(qty):
            return {"production_order": self.ORDER, "material_number": self.MATERIAL, "machine": self.M1,
                    "plant": self.PLANT, "basic_start_date": self.base,
                    "basic_finish_date": self.base + dt.timedelta(days=1),
                    "order_quantity": qty, "planned_order_initial_quantity": qty, "run_time": 4.0}
        seed = row_in(100)
        seed.update(material_description="Widget", labor_hours=7.5, no_of_fte=3)
        self.pg.upsert_orders([seed], source="excel", filename="zztest_st_1.xlsx")
        res = self.pg.upsert_orders([row_in(150)], source="sap")
        assert res["updated"] == 1
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT material_description, labor_hours, no_of_fte, order_quantity FROM orders WHERE id=%s",
                        (self._oid(),))
            desc, labor, fte, qty = cur.fetchone()
        assert desc == "Widget" and float(labor) == 7.5 and float(fte) == 3 and float(qty) == 150
        before = self._row()
        res = self.pg.upsert_orders([row_in(150)], source="sap")
        assert res["unchanged"] == 1 and self._row()["version"] == before["version"]

    def test_unparseable_incoming_date_is_counted_in_a_warning(self):
        def row_in(finish):
            return {"production_order": self.ORDER, "material_number": self.MATERIAL, "machine": self.M1,
                    "plant": self.PLANT, "basic_start_date": self.base, "basic_finish_date": finish,
                    "order_quantity": 100, "run_time": 4.0}
        res = self.pg.upsert_orders([row_in("not-a-date")], source="sap")
        warn = next(w for w in res["warnings"] if w.get("category") == "unparseable_dates")
        assert warn["count"] == 1
        res = self.pg.upsert_orders([row_in(None)], source="sap")
        assert not [w for w in res["warnings"] if w.get("category") == "unparseable_dates"]


@pytest.mark.pg
class TestOriginalDatesBackfill:
    """Backward-scheduling Task 1.1: the ledger-guarded backfill of the locked SAP dates
    (migrations/2026-10-15-1-orders-original-dates.sql). Everything runs inside one transaction that
    is rolled back, so re-running the backfill never touches data another test or a dev DB holds."""
    SUB, PLANT, WC = "ZZTEST_OD_SUB", "ZZTEST_OD_P", "ZZTEST_OD_WC"
    D1 = dt.datetime(2026, 11, 2, 8, 0)
    D2 = dt.datetime(2026, 11, 5, 16, 0)
    D3 = dt.datetime(2026, 11, 9, 6, 0)

    @staticmethod
    def _migration_sql() -> str:
        import os
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "migrations", "2026-10-15-1-orders-original-dates.sql")
        with open(path, encoding="utf-8") as f:
            return f.read()

    def _seed(self, cur):
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'orig dates test')", (self.SUB,))
        cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'UTC')", (self.SUB, self.PLANT))
        cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s, %s, 'ZZTEST_OD_M')",
                    (self.SUB, self.PLANT))
        cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode, default_machine)"
                    " VALUES (%s, %s, 'single', 'ZZTEST_OD_M')", (self.PLANT, self.WC))
        # (id, basic_start, basic_finish, sap_basic_start, sap_basic_finish)
        rows = [
            ("zzod_unsent_sap", self.D1, self.D2, self.D1 - dt.timedelta(days=1), self.D2 - dt.timedelta(days=1)),
            ("zzod_unsent_nosap", self.D1, self.D2, None, None),
            ("zzod_sent", self.D1, self.D2, self.D1 - dt.timedelta(days=1), self.D2 - dt.timedelta(days=1)),
        ]
        for oid, bs, bf, sbs, sbf in rows:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date,"
                " basic_finish_date, sap_basic_start_date, sap_basic_finish_date)"
                " VALUES (%s, %s, 'ZZTEST_OD_MAT', %s, %s, %s, %s, %s)",
                (oid, oid, self.PLANT, bs, bf, sbs, sbf),
            )
        cur.execute("INSERT INTO order_sap_sent (order_id, plant, sent_finish) VALUES ('zzod_sent', %s, %s)",
                    (self.PLANT, self.D3))
        cur.execute(
            "INSERT INTO order_distribution (plant, production_order, material_number, sap_workcenter,"
            " basic_start_date, basic_finish_date) VALUES (%s, 'zzod_header', 'ZZTEST_OD_MAT', %s, %s, %s)",
            (self.PLANT, self.WC, self.D1, self.D2),
        )

    def _orig(self, cur, oid):
        cur.execute("SELECT original_start_received, original_finish_received FROM orders WHERE id = %s", (oid,))
        return cur.fetchone()

    def test_backfill_rules_per_sent_state_and_header(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            try:
                self._seed(cur)
                cur.execute("DELETE FROM schema_migrations WHERE id = 'orders_original_dates_backfill'")
                cur.execute("UPDATE orders SET original_start_received = NULL, original_finish_received = NULL"
                            " WHERE plant = %s", (self.PLANT,))
                cur.execute("UPDATE order_distribution SET original_finish_received = NULL WHERE plant = %s",
                            (self.PLANT,))
                cur.execute(self._migration_sql())
                # No sent row: SAP-as-received wins when present, else the current basic dates.
                assert self._orig(cur, "zzod_unsent_sap") == (self.D1 - dt.timedelta(days=1),
                                                              self.D2 - dt.timedelta(days=1))
                assert self._orig(cur, "zzod_unsent_nosap") == (self.D1, self.D2)
                # A sent row means the original was lost: fall back to basic_* (never the sap_* copy).
                assert self._orig(cur, "zzod_sent") == (self.D1, self.D2)
                cur.execute("SELECT original_finish_received FROM order_distribution WHERE plant = %s",
                            (self.PLANT,))
                assert cur.fetchone()[0] == self.D2
                cur.execute("SELECT count(*) FROM schema_migrations WHERE id = 'orders_original_dates_backfill'")
                assert cur.fetchone()[0] == 1
            finally:
                conn.rollback()

    def test_second_run_is_a_no_op_once_the_ledger_row_exists(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            try:
                self._seed(cur)
                cur.execute("INSERT INTO schema_migrations (id) VALUES ('orders_original_dates_backfill')"
                            " ON CONFLICT DO NOTHING")
                sentinel = dt.datetime(2030, 1, 1, 0, 0)
                cur.execute("UPDATE orders SET original_finish_received = %s WHERE id = 'zzod_unsent_nosap'",
                            (sentinel,))
                cur.execute(self._migration_sql())
                assert self._orig(cur, "zzod_unsent_nosap")[1] == sentinel
            finally:
                conn.rollback()



# ---------------------------------------------------------------------------
# Run-time cap (backward-scheduling OQ28): an order longer than 336 h (or the plant's visibility
# horizon, when shorter) is queued in Needs Planning at upload instead of being scheduled; a row
# outside the database's representation bound (8,760 h) is rejected BY ROW NUMBER, not by failing
# the chunk.
# ---------------------------------------------------------------------------
class TestCapHoursPure:
    def test_cap_is_a_flat_336_and_the_visibility_horizon_does_not_lower_it(self):
        import db as db_
        assert db_.cap_hours(None) == 336.0
        assert db_.cap_hours({}) == 336.0
        assert db_.cap_hours({"visibility_horizon_days": None}) == 336.0
        assert db_.cap_hours({"visibility_horizon_days": 0}) == 336.0
        assert db_.cap_hours({"visibility_horizon_days": -3}) == 336.0
        assert db_.cap_hours({"visibility_horizon_days": 5}) == 336.0     # U5: no horizon term
        assert db_.cap_hours({"visibility_horizon_days": 14}) == 336.0
        assert db_.cap_hours({"visibility_horizon_days": 90}) == 336.0

    def test_reason_shape_is_the_queue_shape(self):
        import db as db_
        reason = db_.run_time_over_cap_reason(400, 336.0)
        assert reason["code"] == "run_time_over_cap"
        assert isinstance(reason["message"], str) and "400" in reason["message"] and "336" in reason["message"]


@pytest.mark.pg
class TestRunTimeCapIngestRealDb:
    SUB, PLANT, MACHINE = "ZZTEST_CAP_SUB", "ZZTEST_CAP_PLANT", "ZZTEST_CAP_LINE"
    SHORT_PLANT = "ZZTEST_CAP_SHORT"   # visibility horizon 5 days (no effect on the flat 336 h cap)
    MATERIAL = "ZZTEST_CAP_MAT"
    PREFIX = "ZZTEST_CAP_ORD"

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE production_order LIKE %s", (self.PREFIX + "%",))
        cur.execute("DELETE FROM upload_audit WHERE filename LIKE 'zztest_cap_%'")
        cur.execute("DELETE FROM plants WHERE plant = %s", (self.SHORT_PLANT,))
        cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.pg = pg
        self.base = (dt.datetime.now() + dt.timedelta(days=40)).replace(hour=8, minute=0, second=0, microsecond=0)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'cap test')", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork, plant, timezone, visibility_horizon_days)"
                        " VALUES (%s, %s, 'UTC', 5)", (self.SUB, self.SHORT_PLANT))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            conn.commit()

    def _line(self, order, run_time, plant=None, **kw):
        row = {
            "PRODUCTION_ORDER": f"{self.PREFIX}_{order}", "MATERIAL_NUMBER": self.MATERIAL,
            "WERKS": plant or self.PLANT, "MACHINE": self.MACHINE, "BASIC_START_DATE": self.base,
            "BASIC_FINISH_DATE": self.base + dt.timedelta(days=1), "RUN_TIME": run_time,
        }
        row.update(kw)
        return row

    def _up(self, rows, name="zztest_cap_1.xlsx"):
        res = self.pg.ingest_orders_from_excel(_xlsx(rows), name)
        assert res["status"] == "ok", res
        return res

    def _row(self, order):
        oid = self.pg.make_id(f"{self.PREFIX}_{order}", self.MATERIAL)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT planning_status, planning_reason, scheduled_start, scheduled_end, run_time,"
                " manual_firmed, (SELECT COUNT(*) FROM order_schedule_segments s WHERE s.order_id = o.id)"
                " FROM orders o WHERE id = %s", (oid,))
            r = cur.fetchone()
        if not r:
            return None
        return dict(zip(("status", "reason", "start", "end", "run_time", "firmed", "segments"), r, strict=True))

    def test_over_cap_row_is_queued_with_reason_and_null_dates(self):
        self._up([self._line("A", 400)])
        row = self._row("A")
        assert row["status"] == "needs_planning"
        assert row["reason"]["code"] == "run_time_over_cap"
        assert "400" in row["reason"]["message"] and "336" in row["reason"]["message"]
        assert row["start"] is None and row["end"] is None
        assert float(row["run_time"]) == 400.0

    def test_run_time_at_the_cap_is_scheduled_normally(self):
        self._up([self._line("B", 336)])
        row = self._row("B")
        assert row["status"] == "scheduled" and row["reason"] is None

    def test_plant_visibility_horizon_does_not_lower_the_cap(self):
        # U5: a 5-day horizon plant takes a 200 h order like any other plant; only > 336 h is queued.
        self._up([self._line("C", 200, plant=self.SHORT_PLANT), self._line("D", 400, plant=self.SHORT_PLANT)])
        assert self._row("C")["status"] == "scheduled"
        assert self._row("D")["status"] == "needs_planning"

    def test_machine_hours_run_time_over_cap_is_queued_too(self):
        self._up([self._line("E", 4, **{"MACHINE_HOURS_(MEINH)": 500})])
        row = self._row("E")
        assert float(row["run_time"]) == 500.0 and row["status"] == "needs_planning"

    def test_a_placed_order_made_too_long_loses_its_slot_segments_and_firm_then_is_released(self):
        self._up([self._line("F", 100)])
        oid = self.pg.make_id(f"{self.PREFIX}_F", self.MATERIAL)
        start = self.base + dt.timedelta(hours=2)
        end = start + dt.timedelta(hours=100)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start=%s, scheduled_end=%s, manual_firmed=TRUE WHERE id=%s",
                        (start, end, oid))
            cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start,"
                        " scheduled_end) VALUES (%s, 1, %s, %s)", (oid, start, end))
            conn.commit()
        self._up([self._line("F", 400)], "zztest_cap_2.xlsx")
        row = self._row("F")
        assert row["status"] == "needs_planning" and row["reason"]["code"] == "run_time_over_cap"
        assert row["start"] is None and row["end"] is None
        assert row["segments"] == 0 and row["firmed"] is False
        # Re-upload within the cap releases it again (and only it).
        self._up([self._line("F", 50)], "zztest_cap_3.xlsx")
        row = self._row("F")
        assert row["status"] == "scheduled" and row["reason"] is None and float(row["run_time"]) == 50.0

    def _place_and_firm(self, order, hours=400):
        oid = self.pg.make_id(f"{self.PREFIX}_{order}", self.MATERIAL)
        start = self.base + dt.timedelta(hours=2)
        end = start + dt.timedelta(hours=hours)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET planning_status='scheduled', planning_reason=NULL, scheduled_start=%s,"
                        " scheduled_end=%s, manual_firmed=TRUE WHERE id=%s", (start, end, oid))
            cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start,"
                        " scheduled_end) VALUES (%s, 1, %s, %s)", (oid, start, end))
            conn.commit()

    def test_a_released_placed_over_cap_order_survives_a_reupload_but_a_changed_run_time_requeues_it(self):
        # R-I5 (V2 reproduction): queue at 400 h, planner releases + firms it, an upload that does not
        # change the run time must leave it placed; a changed (still over-cap) run time re-queues it.
        self._up([self._line("R", 400), self._line("R2", 100)])
        assert self._row("R")["status"] == "needs_planning"
        self._place_and_firm("R")
        self._up([self._line("R", 400, MATERIAL_DESCRIPTION="renamed")], "zztest_cap_6.xlsx")
        row = self._row("R")
        assert row["status"] == "scheduled" and row["start"] is not None and row["end"] is not None
        assert row["firmed"] is True and row["segments"] == 1 and float(row["run_time"]) == 400.0
        self._up([self._line("R", 450)], "zztest_cap_7.xlsx")
        row = self._row("R")
        assert row["status"] == "needs_planning" and row["reason"]["code"] == "run_time_over_cap"
        assert row["start"] is None and row["firmed"] is False and row["segments"] == 0

    def test_another_hold_reason_is_not_overwritten_or_released(self):
        self._up([self._line("G", 100)])
        oid = self.pg.make_id(f"{self.PREFIX}_G", self.MATERIAL)
        planner_hold = Jsonb({"code": "planner_unscheduled", "message": "Unscheduled by planner"})
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET planning_status='needs_planning', scheduled_start=NULL, scheduled_end=NULL,"
                " planning_reason=%s WHERE id=%s", (planner_hold, oid))
            conn.commit()
        self._up([self._line("G", 120)], "zztest_cap_4.xlsx")          # changed but within the cap
        assert self._row("G")["reason"]["code"] == "planner_unscheduled"
        self._up([self._line("G", 500)], "zztest_cap_5.xlsx")          # over the cap: a planner hold keeps its reason
        assert self._row("G")["reason"]["code"] == "planner_unscheduled"

    def test_representation_overflow_row_on_a_routing_plant_loads_and_the_value_is_ignored(self):
        # U12: RUN_TIME is ignored on a routing-enabled plant (the resolver prices the order), so a junk
        # value there must not drop the row; a non-routing plant still rejects it by row number.
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE plants SET routing_runtime_enabled = TRUE WHERE plant = %s", (self.SHORT_PLANT,))
            conn.commit()
        res = self._up([self._line("J1", 9000, plant=self.SHORT_PLANT), self._line("J2", 9000)])
        row = self._row("J1")
        assert row is not None, "the routing-plant row loaded"
        assert row["run_time"] is None or float(row["run_time"]) < 8760.0, "the junk value was never stored"
        assert self._row("J2") is None, "a non-routing plant still rejects it"
        msgs = [w["msg"] for w in res["warnings"] if w.get("level") == "error"]
        assert not any("J1" in m for m in msgs) and any("J2" in m for m in msgs), msgs

    def test_representation_overflow_rejects_the_row_by_number_and_commits_the_rest(self):
        res = self._up([self._line("H1", 10), self._line("H2", 9000), self._line("H3", 20)])
        assert res["inserted"] == 2 and self._row("H2") is None
        assert self._row("H1")["status"] == "scheduled" and self._row("H3")["status"] == "scheduled"
        msgs = [w["msg"] for w in res["warnings"] if w.get("level") == "error"]
        # H2 is the second data row = spreadsheet row 3 (the header is row 1).
        assert any(m.startswith("Row 3") and "H2" in m and "8,760" in m for m in msgs), msgs


class TestOrderIsRunningOnStoredEdges:
    """Backward scheduling (Task 2.2): "running" is judged on STORED edges only -- the first and last segment,
    else the stored start and end -- never on the SAP dates or start + run time. A never-placed order is never
    running, even when its SAP window covers now."""
    NOW = dt.datetime(2026, 10, 20, 12, 0)
    H = dt.timedelta(hours=1)

    def _running(self, **b):
        import db
        return db._order_is_running({"planning_status": "scheduled", **b}, self.NOW)

    def test_a_never_placed_order_is_never_running_even_when_the_sap_window_covers_now(self):
        assert self._running(basic_start_date=self.NOW - 2 * self.H, basic_finish_date=self.NOW + 6 * self.H,
                             run_time=8) is False

    def test_stored_start_and_end_that_bracket_now_is_running(self):
        assert self._running(scheduled_start=self.NOW - self.H, scheduled_end=self.NOW + self.H) is True

    def test_the_stored_end_decides_not_start_plus_run_time(self):
        # start + run_time (1 h) is long past, but the stored finish is still ahead: running.
        assert self._running(scheduled_start=self.NOW - 3 * self.H, scheduled_end=self.NOW + 2 * self.H,
                             run_time=1) is True
        # start + run_time (10 h) reaches past now, but the stored finish is behind: finished.
        assert self._running(scheduled_start=self.NOW - 3 * self.H, scheduled_end=self.NOW - self.H,
                             run_time=10) is False

    def test_first_and_last_segment_win_over_the_parent_columns(self):
        assert self._running(first_start=self.NOW - self.H, last_end=self.NOW + self.H,
                             scheduled_start=self.NOW + 5 * self.H, scheduled_end=self.NOW + 9 * self.H) is True

    def test_one_stored_edge_alone_is_not_running(self):
        assert self._running(scheduled_start=self.NOW - self.H, basic_finish_date=self.NOW + self.H) is False
        assert self._running(scheduled_end=self.NOW + self.H, basic_start_date=self.NOW - self.H) is False

    def test_needs_planning_is_never_running(self):
        import db
        assert db._order_is_running({"planning_status": "needs_planning", "scheduled_start": self.NOW - self.H,
                                     "scheduled_end": self.NOW + self.H}, self.NOW) is False


class TestDuplicateIdSortKeyFinishFallback:
    """Rows sharing one ORDER|MATERIAL id are ordered by (start, quantity, machine); a row with no usable start
    orders by its finish (the shared end rule) instead of tying with every other startless row."""

    def _ordered(self, rows):
        import db
        return sorted(range(len(rows)), key=lambda i: db._duplicate_id_sort_key(rows[i]))

    def test_rows_with_a_start_sort_exactly_as_before(self):
        a = {"basic_start_date": dt.datetime(2026, 10, 2), "order_quantity": 5, "machine": "B"}
        b = {"basic_start_date": dt.datetime(2026, 10, 1), "order_quantity": 9, "machine": "A",
             "basic_finish_date": dt.datetime(2026, 12, 1)}       # a later finish never reorders rows that have a start
        assert self._ordered([a, b]) == [1, 0]

    def test_startless_rows_follow_started_rows_and_order_by_finish(self):
        started = {"basic_start_date": dt.datetime(2026, 10, 1), "order_quantity": 1}
        late = {"basic_start_date": None, "basic_finish_date": dt.datetime(2026, 10, 9), "order_quantity": 1}
        early = {"basic_start_date": None, "original_finish_received": dt.datetime(2026, 10, 5), "order_quantity": 1}
        assert self._ordered([late, early, started]) == [2, 1, 0]
