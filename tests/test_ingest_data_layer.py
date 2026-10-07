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
                 "WERKS": self.PLANT, "MACHINE": 101.0, "BASIC_START_DATE": "2026-09-10 08:00"},
                {"PRODUCTION_ORDER": order_b, "MATERIAL_NUMBER": self.MATERIAL,
                 "WERKS": self.PLANT, "MACHINE": 101.5, "BASIC_START_DATE": "2026-09-10 08:00"},
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

    def test_midnight_finish_becomes_start_plus_run_time(self):
        out, _ = self._run([{"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 11),
                             "run_time": 2}])
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 10, 0)
        assert out[0]["sap_basic_finish_date"] == dt.datetime(2026, 9, 11)

    def test_finish_before_start_becomes_start_plus_run_time(self):
        out, _ = self._run([{"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 10, 6, 30),
                             "run_time": 3}])
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 11, 0)

    def test_missing_finish_defaults_to_start_then_run_time_default(self):
        out, _ = self._run([{"basic_start_date": self.S, "basic_finish_date": None, "run_time": None}])
        # finish := start, then start-equal finish is "bad" -> start + default 1.0h
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 9, 0)
        assert out[0]["sap_basic_finish_date"] is None
        assert out[0]["run_time"] == 1.0 and out[0]["_run_time_was_defaulted"] is True

    def test_real_time_of_day_finish_kept_and_bad_start_dropped_with_warning(self):
        good = {"basic_start_date": self.S, "basic_finish_date": dt.datetime(2026, 9, 10, 15, 45),
                "run_time": 1, "tag": "keep"}
        bad = {"basic_start_date": "not-a-date", "basic_finish_date": None, "run_time": 1}
        out, warnings = self._run([bad, good])
        assert [r["tag"] for r in out] == ["keep"]
        assert out[0]["basic_finish_date"] == dt.datetime(2026, 9, 10, 15, 45)
        assert warnings == [{"level": "error", "msg": "1 row(s) dropped — unparseable BASIC_START_DATE"}]


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

    def test_baseline_correct_then_same_file_resets_nothing(self):
        # No finish in the file: the finish is derived (start + RUN_TIME) on every
        # upload, and the stored baseline is that same derived value.
        line = self._line()
        del line["BASIC_FINISH_DATE"]
        self._up([line])
        self._schedule(self.base + dt.timedelta(days=3))
        row = self._row()
        corrected = row["basic_start_date"] + dt.timedelta(days=5)
        out = self.pg.correct_due_date_baselines(
            [{"id": row["id"], "basic_finish_date": corrected, "base_version": row["version"]}])
        assert out["persisted"] == 1
        before = self._row()
        assert before["basic_finish_date"] == corrected
        res = self._up([line], "zztest_st_2.xlsx")
        after = self._row()
        assert after == before and res["unchanged"] == 1 and res["updated"] == 0

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

    def test_run_time_column_dropped_is_not_a_sap_date_change(self):
        self._up([self._date_only_line(RUN_TIME=4)])
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        line = self._date_only_line()
        del line["RUN_TIME"]
        res = self._up([line], "zztest_st_2.xlsx")
        self._no_sap_reset(res)
        assert self._row()["scheduled_start"] == slot and self._row()["manual_firmed"] is True

    def test_finish_column_absent_run_time_change_is_not_a_date_change(self):
        line4, line6 = self._line(RUN_TIME=4), self._line(RUN_TIME=6)
        del line4["BASIC_FINISH_DATE"], line6["BASIC_FINISH_DATE"]
        self._up([line4])
        assert self._row()["sap_basic_finish_date"] is None, "SAP sent no finish: nothing to baseline"
        slot = self.base + dt.timedelta(days=3)
        self._schedule(slot)
        res = self._up([line6], "zztest_st_2.xlsx")
        self._no_sap_reset(res)
        assert self._row()["scheduled_start"] == slot

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
