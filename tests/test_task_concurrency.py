"""
Real-DB xmin optimistic-concurrency test for the primary save path
(`db.update_task_dates_bulk`, backing `/task/update`, `/tasks/update`, and
`/tasks/bulk_update` in backend/scheduling/routes.py).

Plan reference: docs plan `rippling-brewing-hamming.md`, section B8 item 1 —
"the P0-equivalent gap": nothing previously drove two competing writes
through a REAL Postgres connection on this path. `tests/test_frozen_horizon.py`
(`TestFrozenHorizonNeverGatesQueryOrders`) is the established in-repo pattern
for a real-DB test — `@pytest.mark.pg`, an autouse `_seed` fixture that opens
`pg._pool.connection()` directly, inserts/cleans up its own `ZZTEST_*`-prefixed
rows, and a plain test method taking the `pg` fixture. This file follows that
pattern exactly.

Requires a local Postgres with `NIMBUS_TEST_DB=1` (see tests/conftest.py) —
auto-skipped otherwise. NOT RUN in this sandboxed environment (`.env`'s
PG_HOST points at the live Azure pilot, and the DB-safety guard correctly
refuses to even collect pytest in that state) — verified only via
`ast.parse`, not an actual pytest run. A human with a local Postgres instance
must run this to confirm pass/fail.
"""
import datetime as dt

import pytest

@pytest.mark.pg
class TestUpdateTaskDatesBulkXminConflict:
    PLANT = "ZZTEST_CONC_PLANT"
    MACHINE = "ZZTEST_CONC_LINE"
    ORDER, MATERIAL = "ZZTEST_ORD_CONC", "ZZTEST_MAT_CONC"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        self.oid = db_.make_id(self.ORDER, self.MATERIAL)
        self.start = now + dt.timedelta(days=1)
        self.end = self.start + dt.timedelta(hours=4)
        self.oid2 = db_.make_id(self.ORDER + "_B", self.MATERIAL)
        self.start2 = self.start + dt.timedelta(hours=6)
        self.end2 = self.start + dt.timedelta(hours=10)

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (self.oid, self.ORDER, self.MATERIAL, self.MACHINE, self.PLANT, self.start, self.end),
            )
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid2,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (self.oid2, self.ORDER + "_B", self.MATERIAL, self.MACHINE, self.PLANT, self.start2, self.end2),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid,))
            cur.execute("DELETE FROM orders WHERE id = %s", (self.oid2,))
            conn.commit()

    def _current_version(self, db_):
        rows = db_.get_task_versions([self.oid])
        assert len(rows) == 1
        return rows[0]["row_version"]

    def test_second_write_with_the_same_stale_base_version_lands_in_stale_not_persisted(self, pg):
        """Two competing writes computed from the SAME base_version: the first
        commits and bumps xmin; the second (still holding the now-stale
        version) must be rejected -- reported in `stale`, not written -- even
        though both requests were built from identical, once-valid data. This
        is the real row-lock/xmin check firing, not a mocked stand-in."""
        db_ = pg
        base_version = self._current_version(db_)
        new_start_1 = self.start + dt.timedelta(hours=1)
        new_end_1 = self.end + dt.timedelta(hours=1)
        new_start_2 = self.start + dt.timedelta(hours=2)
        new_end_2 = self.end + dt.timedelta(hours=2)

        first = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start_1, "end": new_end_1, "base_version": base_version},
        ])
        assert first["persisted"] == 1
        assert first["stale"] == []
        assert self.oid in first["versions"]
        bumped_version = first["versions"][self.oid]
        assert bumped_version != base_version, "a successful UPDATE must bump orders.xmin"

        # Second call reuses the SAME (now-stale) base_version the first call
        # started from -- simulating a genuinely concurrent second writer that
        # read the row before the first write landed.
        second = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start_2, "end": new_end_2, "base_version": base_version},
        ])
        assert second["persisted"] == 0
        assert second["stale"] == [self.oid]
        assert self.oid not in second["versions"]

        # Prove the row itself reflects only the FIRST write.
        persisted_rows = db_.get_task_versions([self.oid])
        assert persisted_rows[0]["row_version"] == bumped_version
        assert persisted_rows[0]["start_date"] == new_start_1.strftime("%Y-%m-%dT%H:%M:%S")
        assert persisted_rows[0]["end_date"] == new_end_1.strftime("%Y-%m-%dT%H:%M:%S")

    def test_heterogeneous_batch_writes_only_each_rows_own_columns(self, pg):
        """P6 (#26): rows with different SET shapes are batched per shape; each
        row still gets its own new xmin back, and neither an unedited row nor
        a column a row did not set is touched."""
        db_ = pg
        oid3 = db_.make_id(self.ORDER + "_C", self.MATERIAL)
        oid4 = db_.make_id(self.ORDER + "_D", self.MATERIAL)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for oid, po in ((oid3, self.ORDER + "_C"), (oid4, self.ORDER + "_D")):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
                cur.execute(
                    "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                    " basic_finish_date, prt_01) VALUES (%s,%s,%s,%s,%s,%s,%s,'KEEP')",
                    (oid, po, self.MATERIAL, self.MACHINE, self.PLANT, self.start, self.end),
                )
            conn.commit()
        try:
            def snap(oid):
                with db_._pool.connection() as conn, conn.cursor() as cur:
                    cur.execute("SELECT xmin::text::bigint, scheduled_start, scheduled_end, run_time, prt_01, prt_02"
                                " FROM orders WHERE id = %s", (oid,))
                    return cur.fetchone()

            before3 = snap(oid3)
            s1, e1 = self.start + dt.timedelta(days=2), self.end + dt.timedelta(days=2)
            res = db_.update_task_dates_bulk([
                {"id": self.oid, "start": s1, "end": e1, "PRT_01": "P1"},
                {"id": oid4, "start": s1 + dt.timedelta(days=1), "end": e1 + dt.timedelta(days=1), "PRT_01": "P4"},
                {"id": self.oid2, "RUN_TIME": 7, "PRT_02": "Q2"},
            ])
            assert res["persisted"] == 3 and res["invalid_ids"] == [] and res["stale"] == []
            for oid in (self.oid, oid4, self.oid2):
                assert res["versions"][oid] == snap(oid)[0], "versions carry each row's own new xmin"
            assert snap(oid3) == before3, "an unedited row must not be touched (no xmin bump)"
            a, b, c = snap(self.oid), snap(oid4), snap(self.oid2)
            assert (a[1], a[2], a[4]) == (s1, e1, "P1")
            assert (b[1], b[2], b[4]) == (s1 + dt.timedelta(days=1), e1 + dt.timedelta(days=1), "P4")
            assert (c[1], c[2], c[3], c[5]) == (None, None, 7, "Q2")   # dates and prt_01 never set for this row
            assert a[3] is None and a[5] is None   # run_time / prt_02 not set for the date-only shape
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = ANY(%s)", ([oid3, oid4],))
                conn.commit()

    def test_machine_edit_to_unknown_machine_is_rejected_with_reason(self, pg):
        """Plan Part 2 #27: a MACHINE the plant neither registers nor already
        holds orders on is rejected per item (200 envelope, rejection reason)."""
        db_ = pg
        result = db_.update_task_dates_bulk([
            {"id": self.oid, "MACHINE": "ZZTEST_NOT_A_LINE", "base_version": self._current_version(db_)},
        ])
        assert result["invalid_ids"] == [self.oid]
        assert result["rejection_reasons"] == {self.oid: "machine_unknown"}
        assert result["persisted"] == 0
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT machine FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] == self.MACHINE

    def test_machine_edit_accepts_case_space_variant_of_a_machine_holding_orders(self, pg):
        """The seeded machine is unregistered but holds orders in the plant, so
        a case/space variant of it is a legitimate target."""
        db_ = pg
        result = db_.update_task_dates_bulk([
            {"id": self.oid2, "MACHINE": " " + self.MACHINE.lower() + " ",
             "base_version": db_.get_task_versions([self.oid2])[0]["row_version"]},
        ])
        assert result["invalid_ids"] == [] and result["persisted"] == 1
        # Review round: the CANONICAL spelling is stored, never the typed variant.
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT machine FROM orders WHERE id = %s", (self.oid2,))
            assert cur.fetchone()[0] == self.MACHINE

    def test_force_true_bypasses_the_stale_check_and_persists_anyway(self, pg):
        """A `force: True` edit must succeed even against a stale base_version
        -- the optimizer's authoritative-bulk-reschedule escape hatch."""
        db_ = pg
        base_version = self._current_version(db_)
        new_start_1 = self.start + dt.timedelta(hours=1)
        new_end_1 = self.end + dt.timedelta(hours=1)
        new_start_2 = self.start + dt.timedelta(hours=5)
        new_end_2 = self.end + dt.timedelta(hours=5)

        first = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start_1, "end": new_end_1, "base_version": base_version},
        ])
        assert first["persisted"] == 1

        # Second call carries the SAME stale base_version as the prior test,
        # but with force=True -- must persist despite the mismatch.
        forced = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start_2, "end": new_end_2,
             "base_version": base_version, "force": True},
        ])
        assert forced["persisted"] == 1
        assert forced["stale"] == []
        assert self.oid in forced["versions"]

        persisted_rows = db_.get_task_versions([self.oid])
        assert persisted_rows[0]["start_date"] == new_start_2.strftime("%Y-%m-%dT%H:%M:%S")
        assert persisted_rows[0]["end_date"] == new_end_2.strftime("%Y-%m-%dT%H:%M:%S")

    def test_allowed_plants_scoping_masks_an_out_of_scope_row_as_not_found(self, pg):
        """A1's plant-scoping addition: a row whose plant falls outside
        allowed_plants is folded into not_found_ids, identically to a
        genuinely nonexistent id -- proven here against the real row (not a
        mock), confirming the scoping check and the not-found path share the
        same observable outcome."""
        db_ = pg
        base_version = self._current_version(db_)
        result = db_.update_task_dates_bulk(
            [{"id": self.oid, "start": self.start, "end": self.end, "base_version": base_version}],
            allowed_plants=["SOME_OTHER_PLANT_NOT_THIS_ONE"],
        )
        assert result["persisted"] == 0
        assert result["not_found_ids"] == [self.oid]
        assert result["stale"] == []

    def test_saving_into_an_occupied_slot_reports_the_conflict_and_strict_atomic_rolls_back(self, pg):
        db_ = pg
        base = self._current_version(db_)
        new_start = self.start + dt.timedelta(hours=7)   # inside oid2's 6h-10h window
        new_end = new_start + dt.timedelta(hours=2)

        advisory = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start, "end": new_end, "base_version": base},
        ])
        assert advisory["persisted"] == 1
        assert [(c["order_a"], c["order_b"]) for c in advisory["conflicts"]] == [tuple(sorted((self.oid, self.oid2)))]
        assert advisory["conflicts"][0]["overlap_minutes"] == 120

        base = self._current_version(db_)
        strict = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start + dt.timedelta(minutes=30), "end": new_end + dt.timedelta(minutes=30),
             "base_version": base},
        ], atomic_optimizer=True, strict_conflicts=True)
        assert strict["status"] == "error" and strict["error_code"] == "schedule.conflicts"
        assert db_.get_task_versions([self.oid])[0]["start_date"] == new_start.strftime("%Y-%m-%dT%H:%M:%S")

    def test_conflict_scan_sees_a_long_order_that_started_before_the_window(self, pg):
        """Plan Part 2 #18: a 130 h order starting 5 days earlier used to fall
        outside the fixed 1-day start lookback and its overlap went unreported."""
        db_ = pg
        long_id = db_.make_id(self.ORDER + "_LONG", self.MATERIAL)
        long_start = self.start - dt.timedelta(days=5)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (long_id,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,130)",
                (long_id, self.ORDER + "_LONG", self.MATERIAL, self.MACHINE, self.PLANT,
                 long_start, long_start + dt.timedelta(hours=130),
                 long_start, long_start + dt.timedelta(hours=130)),
            )
            conn.commit()
        try:
            base = self._current_version(db_)
            new_start = self.start + dt.timedelta(hours=7)
            result = db_.update_task_dates_bulk([
                {"id": self.oid, "start": new_start, "end": new_start + dt.timedelta(hours=2),
                 "base_version": base},
            ])
            pairs = {frozenset((c["order_a"], c["order_b"])) for c in result["conflicts"]}
            assert frozenset((self.oid, long_id)) in pairs
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = %s", (long_id,))
                conn.commit()

    def test_strict_save_waits_on_the_machine_advisory_lock(self, pg):
        """Plan Part 2 #18: strict optimizer saves serialise on (plant, machine)."""
        import threading
        import time
        db_ = pg
        base = self._current_version(db_)
        done = threading.Event()

        def _save():
            db_.update_task_dates_bulk(
                [{"id": self.oid, "start": self.start, "end": self.end, "base_version": base}],
                atomic_optimizer=True, strict_conflicts=True)
            done.set()

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                        (f"{self.PLANT}{self.MACHINE}",))
            t = threading.Thread(target=_save)
            t.start()
            time.sleep(0.5)
            assert not done.is_set()
            conn.rollback()
        t.join(10)
        assert done.is_set()


# ---------------------------------------------------------------------------
# Bundle 0 #2 (Code_Review_Consolidated_10_05.md): cross-seam save contract.
# The body below is the browser's REAL saveAll() payload, emitted by the JS test
# in tests/modules/scheduling/persistence.test.mjs into a checked-in fixture
# (same shared-fixture pattern as routing_cases.json) and POSTed UNMODIFIED
# through FastAPI to the real route and DB. The only substitution is
# base_version (the fixture can't know the seeded row's xmin) -- every other
# byte is what the browser sent. Catches the C1/N09/R3 class: a payload the
# client legitimately produces being rejected as invalid/stale server-side.
# ---------------------------------------------------------------------------
import copy  # noqa: E402
import json  # noqa: E402
from pathlib import Path  # noqa: E402

_SAVE_FIXTURE = json.loads(
    (Path(__file__).parent / "modules" / "fixtures" / "save_payload_cases.json").read_text(encoding="utf-8")
)["cases"]
_XSEAM_SUBNETWORK = "ZZTEST_XSEAM_SUB"


@pytest.mark.pg
class TestBrowserSavePayloadCrossSeam:
    @pytest.fixture(autouse=True)
    def _db(self, pg):
        self.pg = pg
        self._cleanup()
        yield
        self._cleanup()

    def _cleanup(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            for case in _SAVE_FIXTURE.values():
                cur.execute("DELETE FROM orders WHERE id = %s", (case["request"]["tasks"][0]["id"],))
                cur.execute("DELETE FROM plants WHERE plant = %s", (case["seed"]["plant"],))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (_XSEAM_SUBNETWORK,))
            conn.commit()

    def _seed(self, case):
        seed, oid = case["seed"], case["request"]["tasks"][0]["id"]
        routing = seed["kind"] == "routing_plant"
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code,name) VALUES (%s,'xseam') ON CONFLICT DO NOTHING",
                        (_XSEAM_SUBNETWORK,))
            cur.execute(
                "INSERT INTO plants (subnetwork,plant,routing_runtime_enabled,timezone)"
                " VALUES (%s,%s,%s,'America/New_York')", (_XSEAM_SUBNETWORK, seed["plant"], routing),
            )
            cur.execute(
                "INSERT INTO orders (id,production_order,material_number,plant,machine,production_version,"
                " order_quantity,basic_start_date,basic_finish_date,scheduled_start,scheduled_end,run_time,"
                " run_time_source,planning_status,prt_01,parent_production_order,distribution_letter)"
                " VALUES (%s,%s,'ZZTEST_XSEAM_M',%s,%s,%s,10,%s,%s,%s,%s,%s,%s,'scheduled',%s,%s,%s)",
                (oid, seed["production_order"], seed["plant"], seed["machine"], seed["production_version"],
                 seed["start_date"], seed["end_date"], seed["start_date"], seed["end_date"], seed["run_time"],
                 "routing" if routing else "distributed", case["request"]["tasks"][0]["PRT_01"],
                 seed["parent_order"], seed["distribution_letter"]),
            )
            conn.commit()
        return oid

    @pytest.mark.parametrize("name", sorted(_SAVE_FIXTURE))
    def test_browser_payload_is_accepted_and_persisted(self, name, client):
        import backend.security.auth as auth
        case = _SAVE_FIXTURE[name]
        oid = self._seed(case)
        body = copy.deepcopy(case["request"])
        body["tasks"][0]["base_version"] = self.pg.get_task_versions([oid])[0]["row_version"]
        client.app.dependency_overrides[auth.require_authenticated] = lambda: "xseam@example.com"
        client.app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
        try:
            response = client.post("/tasks/update", json=body)
        finally:
            client.app.dependency_overrides.clear()
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "ok"
        assert result["invalid_ids"] == [] and result["stale"] == [] and result["not_found_ids"] == []
        assert result["rejection_reasons"] == {}
        assert result["persisted"] == 1 and oid in result["versions"]
        sent = body["tasks"][0]
        saved = self.pg.get_task_versions([oid])[0]
        assert saved["start_date"] == sent["start_date"] and saved["end_date"] == sent["end_date"]
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT machine, production_version, run_time FROM orders WHERE id = %s", (oid,))
            assert cur.fetchone() == (sent["MACHINE"], sent["PRODUCTION_VERSION"], sent["RUN_TIME"])
            cur.execute("SELECT count(*) FROM order_schedule_segments WHERE order_id = %s", (oid,))
            assert cur.fetchone()[0] == len(sent["schedule_segments"])
