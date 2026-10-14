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

    def _manual_firmed(self, db_, oid):
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT manual_firmed FROM orders WHERE id = %s", (oid,))
            return cur.fetchone()[0]

    def test_firmed_only_save_persists_bumps_xmin_and_is_read_back(self, pg):
        """A planner's manual firm travels alone (FIRMED, no dates/attrs): it is a
        valid edit, bumps xmin, and both GET /tasks's frame and the refresh read
        return it."""
        db_ = pg
        base_version = self._current_version(db_)
        assert self._manual_firmed(db_, self.oid) is False
        res = db_.update_task_dates_bulk(
            [{"id": self.oid, "FIRMED": True, "base_version": base_version}], allowed_plants=[self.PLANT])
        assert res["persisted"] == 1 and res["invalid_ids"] == []
        assert res["versions"][self.oid] != base_version
        assert self._manual_firmed(db_, self.oid) is True
        assert db_.get_task_versions([self.oid])[0]["firmed"] is True
        frame = db_.query_orders(plant=self.PLANT)[0]
        by_id = {i: bool(f) for i, f in zip(frame["id"], frame["FIRMED"], strict=True)}
        assert by_id[self.oid] is True and by_id[self.oid2] is False
        res = db_.update_task_dates_bulk(
            [{"id": self.oid, "FIRMED": False, "base_version": res["versions"][self.oid]}],
            allowed_plants=[self.PLANT])
        assert res["persisted"] == 1
        assert self._manual_firmed(db_, self.oid) is False

    def test_firmed_only_save_is_still_subject_to_the_stale_check(self, pg):
        db_ = pg
        base_version = self._current_version(db_)
        db_.update_task_dates_bulk(
            [{"id": self.oid, "start": self.start + dt.timedelta(hours=1), "end": self.end + dt.timedelta(hours=1),
              "base_version": base_version}], allowed_plants=[self.PLANT])
        res = db_.update_task_dates_bulk(
            [{"id": self.oid, "FIRMED": True, "base_version": base_version}], allowed_plants=[self.PLANT])
        assert res["persisted"] == 0 and res["stale"] == [self.oid]
        assert self._manual_firmed(db_, self.oid) is False

    def test_firmed_is_allowed_on_a_distribution_child(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET parent_production_order = %s, distribution_letter = 'A' WHERE id = %s",
                        ("ZZTEST_PARENT", self.oid2))
            conn.commit()
        version = db_.get_task_versions([self.oid2])[0]["row_version"]
        res = db_.update_task_dates_bulk(
            [{"id": self.oid2, "FIRMED": True, "base_version": version}], allowed_plants=[self.PLANT])
        assert res["persisted"] == 1 and res["invalid_ids"] == []
        assert self._manual_firmed(db_, self.oid2) is True

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

    def test_mixed_batch_leaves_seeded_unset_columns_untouched(self, pg):
        """P6 (#26) mutation guard: every column is SEEDED non-NULL, then a mixed
        batch saves a different subset per row. A batched UPDATE that wrote
        NULL (or a default) for columns absent from a row's payload would wipe
        the seeded scheduled_end / run_time / prt values -- they must survive."""
        db_ = pg
        sched_start = self.start + dt.timedelta(days=5)
        sched_end = sched_start + dt.timedelta(hours=6)    # the seeded 6 h run time, so a re-saved bar passes the width check
        oids = [db_.make_id(self.ORDER + f"_S{i}", self.MATERIAL) for i in range(3)]
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for i, oid in enumerate(oids):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
                cur.execute(
                    "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                    " basic_finish_date, scheduled_start, scheduled_end, run_time, prt_01, prt_02)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,6,'K1','K2')",
                    (oid, self.ORDER + f"_S{i}", self.MATERIAL, self.MACHINE, self.PLANT,
                     self.start, self.end, sched_start, sched_end),
                )
            conn.commit()
        try:
            def snap(oid):
                with db_._pool.connection() as conn, conn.cursor() as cur:
                    cur.execute("SELECT scheduled_start, scheduled_end, run_time, prt_01, prt_02"
                                " FROM orders WHERE id = %s", (oid,))
                    return cur.fetchone()

            new_start = sched_start + dt.timedelta(days=1)
            new_end = sched_end + dt.timedelta(days=1)
            res = db_.update_task_dates_bulk([
                {"id": oids[0], "start": new_start, "end": new_end},          # dates only
                {"id": oids[1], "PRT_01": "N1"},                              # attribute only
                {"id": oids[2], "RUN_TIME": 9},                               # run time only
            ])
            assert res["persisted"] == 3 and res["invalid_ids"] == [] and res["stale"] == []
            assert snap(oids[0]) == (new_start, new_end, 6, "K1", "K2")
            assert snap(oids[1]) == (sched_start, sched_end, 6, "N1", "K2")
            assert snap(oids[2]) == (sched_start, sched_end, 9, "K1", "K2")
            # A single-edge save is rejected outright (both edges or segments, always): neither stored edge
            # is completed from the other, so nothing changes.
            early_start = sched_start - dt.timedelta(hours=1)
            res = db_.update_task_dates_bulk([{"id": oids[1], "end": new_end}, {"id": oids[2], "start": early_start}])
            assert res["persisted"] == 0 and sorted(res["invalid_ids"]) == sorted([oids[1], oids[2]])
            assert res["rejection_reasons"] == {oids[1]: "single_edge", oids[2]: "single_edge"}
            assert snap(oids[1]) == (sched_start, sched_end, 6, "N1", "K2")
            assert snap(oids[2]) == (sched_start, sched_end, 9, "K1", "K2")
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = ANY(%s)", (oids,))
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

    def test_run_time_edit_over_the_cap_is_rejected_with_a_reason_and_writes_nothing(self, pg):
        """OQ28: a planner run-time edit longer than the plant's cap (336 h on a plant with no
        visibility horizon) is rejected for that id alone (200 envelope, rejection reason), even
        though the database now accepts anything under 8,760 h."""
        db_ = pg
        version = self._current_version(db_)
        result = db_.update_task_dates_bulk([{"id": self.oid, "RUN_TIME": 400, "base_version": version}])
        assert result["invalid_ids"] == [self.oid]
        assert result["rejection_reasons"] == {self.oid: "run_time_over_cap"}
        assert result["persisted"] == 0 and self.oid not in result["versions"]
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT run_time FROM orders WHERE id = %s", (self.oid,))
            assert cur.fetchone()[0] is None
        # The same edit at the cap (and a sibling row in the same batch) is accepted.
        ok = db_.update_task_dates_bulk([
            {"id": self.oid, "RUN_TIME": 336, "base_version": version},
            {"id": self.oid2, "RUN_TIME": 400},
        ])
        assert ok["persisted"] == 1 and ok["invalid_ids"] == [self.oid2]
        assert ok["rejection_reasons"] == {self.oid2: "run_time_over_cap"}
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT run_time FROM orders WHERE id = %s", (self.oid,))
            assert float(cur.fetchone()[0]) == 336.0

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
        with db_._pool.connection() as conn, conn.cursor() as cur:   # the scan judges PLACED neighbours only
            cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE id = %s",
                        (self.start2, self.end2, self.oid2))
            conn.commit()
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

    def test_conflict_scan_judges_overlap_on_the_stored_finish_not_start_plus_run_time(self, pg):
        """Backward scheduling: a placed order whose stored finish is far past start + run time (a short
        run time drawn over a long window) is found, because the scan reads the stored finish."""
        db_ = pg
        long_id = db_.make_id(self.ORDER + "_STORED", self.MATERIAL)
        long_start = self.start - dt.timedelta(days=2)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (long_id,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,2)",
                (long_id, self.ORDER + "_STORED", self.MATERIAL, self.MACHINE, self.PLANT,
                 long_start, long_start + dt.timedelta(hours=2),
                 long_start, long_start + dt.timedelta(days=3)),       # stored finish reaches into the window
            )
            conn.commit()
        try:
            base = self._current_version(db_)
            new_start = self.start + dt.timedelta(hours=7)
            result = db_.update_task_dates_bulk([
                {"id": self.oid, "start": new_start, "end": new_start + dt.timedelta(hours=2), "base_version": base},
            ])
            pairs = {frozenset((c["order_a"], c["order_b"])) for c in result["conflicts"]}
            assert frozenset((self.oid, long_id)) in pairs
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = %s", (long_id,))
                conn.commit()

    def test_get_tasks_row_order_follows_the_stored_edges_for_a_finish_only_row(self, pg):
        """U7: the link order (machine, effective start) falls back scheduled_start -> scheduled_end ->
        basic_start_date, so a finish-only placement sits after a never-placed order with an earlier SAP start
        instead of at its own (earlier) SAP start."""
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_end = %s WHERE id = %s",
                        (self.start + dt.timedelta(hours=20), self.oid))     # oid: SAP start t0, stored end t0+20h
            conn.commit()                                                    # oid2: never placed, SAP start t0+6h
        df, _, _ = db_.query_orders(plant=self.PLANT)
        id_col = next(c for c in df.columns if c.lower() == "id")
        assert list(df[id_col]) == [self.oid2, self.oid]

    def test_conflict_scan_sees_a_finish_only_neighbour(self, pg):
        """U2: a placed neighbour with a stored finish and no stored start (a distribution carry) is found
        through its stored end; before, only its start key was consulted, so it escaped the scan."""
        db_ = pg
        fin_id = db_.make_id(self.ORDER + "_FINONLY", self.MATERIAL)
        new_start = self.start + dt.timedelta(hours=7)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = %s", (fin_id,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time)"
                " VALUES (%s,%s,%s,%s,%s,NULL,%s,NULL,%s,4)",
                (fin_id, self.ORDER + "_FINONLY", self.MATERIAL, self.MACHINE, self.PLANT,
                 self.start + dt.timedelta(hours=9), self.start + dt.timedelta(hours=9)))
            conn.commit()
        try:
            base = self._current_version(db_)
            result = db_.update_task_dates_bulk([
                {"id": self.oid, "start": new_start, "end": new_start + dt.timedelta(hours=2), "base_version": base},
            ])
            pairs = {frozenset((c["order_a"], c["order_b"])) for c in result["conflicts"]}
            assert frozenset((self.oid, fin_id)) in pairs
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = %s", (fin_id,))
                conn.commit()

    def test_conflict_scan_judges_placed_neighbours_only(self, pg):
        """A never-placed neighbour occupies its whole SAP window server-side, so it is not scanned (no phantom
        conflicts, no strict-save rejection from an untouched order); a placed neighbour with a stored end is."""
        db_ = pg
        never_id = db_.make_id(self.ORDER + "_NEVER", self.MATERIAL)
        placed_id = db_.make_id(self.ORDER + "_PLACEDN", self.MATERIAL)
        new_start = self.start + dt.timedelta(hours=7)
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for oid in (never_id, placed_id):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            # never placed: only its SAP window (and a locked finish), spanning the moved row's slot
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, original_finish_received, run_time)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,2)",
                (never_id, self.ORDER + "_NEVER", self.MATERIAL, self.MACHINE, self.PLANT,
                 self.start - dt.timedelta(hours=2), self.start + dt.timedelta(days=3),
                 self.start + dt.timedelta(days=3)))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,2)",
                (placed_id, self.ORDER + "_PLACEDN", self.MATERIAL, self.MACHINE, self.PLANT,
                 self.start, self.start + dt.timedelta(hours=2),
                 self.start + dt.timedelta(hours=8), self.start + dt.timedelta(hours=9)))
            conn.commit()
        try:
            base = self._current_version(db_)
            result = db_.update_task_dates_bulk([
                {"id": self.oid, "start": new_start, "end": new_start + dt.timedelta(hours=2), "base_version": base},
            ])
            pairs = {frozenset((c["order_a"], c["order_b"])) for c in result["conflicts"]}
            assert frozenset((self.oid, never_id)) not in pairs
            assert frozenset((self.oid, placed_id)) in pairs
        finally:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                for oid in (never_id, placed_id):
                    cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
                conn.commit()

    @staticmethod
    def _wait_for_advisory_wait(db_, timeout=10.0):
        """Poll pg_locks until a backend is blocked on an advisory lock."""
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with db_._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted LIMIT 1")
                if cur.fetchone():
                    return True
            time.sleep(0.02)
        return False

    @pytest.mark.parametrize("spelling", ["same", "lower"])
    def test_strict_save_waits_on_the_machine_advisory_lock(self, pg, spelling):
        """Plan Part 2 #18: strict optimizer saves serialise on (plant, machine),
        keyed on the canonical match key (so a differently-cased MACHINE edit of
        the same machine blocks too -- senior audit #5)."""
        import threading
        db_ = pg
        base = self._current_version(db_)
        done = threading.Event()
        errors = []

        def _save():
            try:
                item = {"id": self.oid, "start": self.start, "end": self.end, "base_version": base}
                if spelling == "lower":
                    item["MACHINE"] = self.MACHINE.lower()
                db_.update_task_dates_bulk([item], atomic_optimizer=True, strict_conflicts=True)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                done.set()

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                        (db_._strict_lock_key(self.PLANT, db_._machine_match_key(self.MACHINE)),))
            t = threading.Thread(target=_save)
            t.start()
            assert self._wait_for_advisory_wait(db_), "save never blocked on the advisory lock"
            assert not done.is_set()
            conn.rollback()
        t.join(10)
        assert done.is_set()
        assert not errors, errors


# ---------------------------------------------------------------------------
# Backward scheduling Task 2.2: the stored finish is the order's finish on every read path.
# ---------------------------------------------------------------------------
@pytest.mark.pg
class TestStoredFinishReadRule:
    PLANT = "ZZTEST_RR_PLANT"
    MACHINE = "ZZTEST_RR_LINE"
    T0 = dt.datetime(2031, 3, 3, 6, 0)

    @pytest.fixture(autouse=True)
    def _clean(self, pg):
        self.db = pg
        self._wipe()
        yield
        self._wipe()

    def _wipe(self):
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE plant = %s", (self.PLANT,))
            conn.commit()

    def _seed(self, name, *, start=None, end=None, run_time=None, due=None, sap_start=None, status="scheduled",
              segments=()):
        sap_start = sap_start or self.T0
        due = due or self.T0 + dt.timedelta(hours=60)
        oid = self.db.make_id("ZZTEST_RR_" + name, "ZZTEST_RR_MAT")
        reason = '{"code": "t", "message": "t"}' if status == "needs_planning" else None
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, original_start_received, original_finish_received, scheduled_start,"
                " scheduled_end, run_time, planning_status, planning_reason)"
                " VALUES (%s,%s,'ZZTEST_RR_MAT',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                (oid, "ZZTEST_RR_" + name, self.MACHINE, self.PLANT, sap_start, due, sap_start, due,
                 start, end, run_time, status, reason))
            for n, (s0, e0) in enumerate(segments, 1):
                cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start,"
                            " scheduled_end) VALUES (%s,%s,%s,%s)", (oid, n, s0, e0))
            conn.commit()
        return oid

    def _read(self, oid):
        df, _h, _f = self.db.query_orders(plant=self.PLANT)
        row = df[df["id"] == oid].iloc[0]
        ver = self.db.get_task_versions([oid])[0]
        return row, ver

    @staticmethod
    def _iso(t):
        return t.strftime("%Y-%m-%dT%H:%M:%S")

    def test_a_placed_orders_finish_is_its_stored_scheduled_end_whatever_the_run_time(self):
        start, end = self.T0 + dt.timedelta(days=1), self.T0 + dt.timedelta(days=1, hours=30)
        oid = self._seed("PLACED", start=start, end=end, run_time=2)         # 2 h of work drawn over 30 h
        row, ver = self._read(oid)
        assert row["BASIC_START_DATE"] == start and row["BASIC_FINISH_DATE"] == end
        assert ver["start_date"] == self._iso(start) and ver["end_date"] == self._iso(end)
        with self.db._pool.connection() as conn, conn.cursor() as cur:       # a run-time change cannot move it
            cur.execute("UPDATE orders SET run_time = 20 WHERE id = %s", (oid,))
            conn.commit()
        row, ver = self._read(oid)
        assert row["BASIC_FINISH_DATE"] == end and ver["end_date"] == self._iso(end)

    def test_a_never_placed_orders_finish_is_its_original_end_date(self):
        due = self.T0 + dt.timedelta(hours=60)
        oid = self._seed("NEVER", run_time=5, due=due)
        row, ver = self._read(oid)
        assert row["BASIC_FINISH_DATE"] == row["ORIGINAL_END_DATE"] == due
        assert ver["end_date"] == ver["original_end_date"] == self._iso(due)
        assert row["BASIC_START_DATE"] == self.T0 and bool(row["USER_SCHEDULED"]) is False

    def test_the_last_segment_end_wins_over_the_parent_columns(self):
        a0, a1 = self.T0 + dt.timedelta(days=2), self.T0 + dt.timedelta(days=2, hours=3)
        b0, b1 = self.T0 + dt.timedelta(days=3), self.T0 + dt.timedelta(days=3, hours=4)
        oid = self._seed("SEG", start=a0, end=a1, run_time=7, segments=[(a0, a1), (b0, b1)])
        row, ver = self._read(oid)
        assert row["BASIC_START_DATE"] == a0 and row["BASIC_FINISH_DATE"] == b1
        assert ver["end_date"] == self._iso(b1)

    def test_a_queued_order_has_no_start_or_finish(self):
        oid = self._seed("QUEUED", run_time=4, status="needs_planning")
        row, ver = self._read(oid)
        assert row["BASIC_START_DATE"] is None or str(row["BASIC_START_DATE"]) == "NaT"
        assert ver["start_date"] is None and ver["end_date"] is None

    def test_diagnostics_range_and_purge_selector_read_the_locked_finish(self):
        """The purge selector and its preview count read the stored finish, then the locked SAP finish
        (segments are not joined there), then basic_finish_date."""
        placed = self._seed("P_PLACED", start=self.T0, end=self.T0 + dt.timedelta(hours=4), run_time=2)
        never = self._seed("P_NEVER", run_time=2)                            # finish = original_finish_received
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET basic_finish_date = %s WHERE id = %s",
                        (self.T0 + dt.timedelta(days=400), never))            # an echo moved the planning copy
            conn.commit()
        window = (self.T0 + dt.timedelta(hours=50), self.T0 + dt.timedelta(hours=70))   # holds only the due date
        assert self.db.preview_purge_orders(self.PLANT, *window)["total"] == 1
        assert self.db.preview_purge_orders(self.PLANT, self.T0, self.T0 + dt.timedelta(hours=5))["total"] == 1
        assert placed and never

    def test_purge_preview_counts_a_finish_only_placement_as_planner_overridden(self):
        """U10: a planner placement is `scheduled_start IS NOT NULL OR scheduled_end IS NOT NULL`."""
        both = self._seed("O_BOTH", start=self.T0, end=self.T0 + dt.timedelta(hours=4), run_time=2)
        fin_only = self._seed("O_FINONLY", run_time=2)
        self._seed("O_NEVER", run_time=2)
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_end = %s WHERE id = %s", (self.T0 + dt.timedelta(hours=3), fin_only))
            conn.commit()
        preview = self.db.preview_purge_orders(self.PLANT, self.T0 - dt.timedelta(days=1), self.T0 + dt.timedelta(days=30))
        assert preview["planner_overridden"] == 2 and both


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


@pytest.mark.pg
class TestSaveContractWidthValidator:
    """Backward scheduling Task 2.3: both edges or segments always, the continuous-width validator, the stale
    flag that only a passed check clears, and the placement_exception marker."""
    SUB, PLANT, PLANT_NOTZ = "ZZTEST_SCW_SUB", "ZZTEST_SCW_PLANT", "ZZTEST_SCW_NOTZ"
    MACHINE = "ZZTEST_SCW_LINE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.pg = pg
        self.s = dt.datetime(2026, 6, 1, 8, 0)          # a plain Monday morning, no DST change nearby
        self._cleanup()
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'scw') ON CONFLICT DO NOTHING", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'America/Chicago')",
                        (self.SUB, self.PLANT))
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s, %s)", (self.SUB, self.PLANT_NOTZ))
            conn.commit()
        yield
        self._cleanup()

    def _cleanup(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE plant = ANY(%s)", ([self.PLANT, self.PLANT_NOTZ],))
            cur.execute("DELETE FROM plants WHERE plant = ANY(%s)", ([self.PLANT, self.PLANT_NOTZ],))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def _order(self, name, *, plant=None, run_time=4, mismatch=True, exception=None, start=None, hours=None):
        """A placed order (stored start/end) of `run_time` hours, flagged stale by default."""
        oid = self.pg.make_id("ZZTEST_SCW_" + name, "ZZTEST_SCW_MAT")
        start = start or self.s
        end = start + dt.timedelta(hours=hours if hours is not None else (run_time or 4))
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, scheduled_start, scheduled_end, run_time, runtime_schedule_mismatch,"
                " placement_exception) VALUES (%s,%s,'ZZTEST_SCW_MAT',%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (oid, "ZZTEST_SCW_" + name, self.MACHINE, plant or self.PLANT, start, end, start, end,
                 run_time, mismatch, exception))
            conn.commit()
        return oid

    def _state(self, oid):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT scheduled_start, scheduled_end, runtime_schedule_mismatch, placement_exception"
                        " FROM orders WHERE id = %s", (oid,))
            return cur.fetchone()

    def _save(self, oid, **fields):
        return self.pg.update_task_dates_bulk([{"id": oid, **fields}])

    def test_an_end_only_save_is_rejected_and_writes_nothing(self):
        oid = self._order("END_ONLY")
        before = self._state(oid)
        res = self._save(oid, end=self.s + dt.timedelta(hours=4))
        assert res["persisted"] == 0 and res["invalid_ids"] == [oid]
        assert res["rejection_reasons"] == {oid: "single_edge"}
        assert self._state(oid) == before

    def test_a_start_only_save_is_rejected_too(self):
        oid = self._order("START_ONLY")
        res = self._save(oid, start=self.s + dt.timedelta(hours=1))
        assert res["persisted"] == 0 and res["rejection_reasons"] == {oid: "single_edge"}

    def test_a_status_only_scheduled_save_on_a_never_placed_row_is_rejected_and_writes_nothing(self):
        """The read path falls back to the SAP window for a never-placed row, but that is not a stored placement:
        a status-only 'scheduled' save (no edges) is refused as `single_edge` instead of labelling an unplaced row."""
        oid = self._order("UNPLACED")
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET scheduled_start = NULL, scheduled_end = NULL WHERE id = %s", (oid,))
            conn.commit()
        before = self._state(oid)
        assert before[0] is None and before[1] is None
        res = self._save(oid, planning_status="scheduled")
        assert res["persisted"] == 0 and res["invalid_ids"] == [oid]
        assert res["rejection_reasons"] == {oid: "single_edge"}
        assert self._state(oid) == before, "nothing stamped from the SAP window"

    def test_a_status_only_scheduled_save_on_a_placed_row_is_accepted_without_touching_its_edges(self):
        oid = self._order("PLACED_STATUS")
        before = self._state(oid)
        res = self._save(oid, planning_status="scheduled")
        assert res["persisted"] == 1 and res["invalid_ids"] == [] and res["rejection_reasons"] == {}
        assert self._state(oid)[:2] == before[:2], "the stored edges are not rewritten"

    def test_both_edges_with_a_width_that_is_not_the_run_time_are_rejected(self):
        oid = self._order("WIDE")
        before = self._state(oid)
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=5))   # 5 h bar, 4 h run time
        assert res["persisted"] == 0 and res["invalid_ids"] == [oid]
        assert res["rejection_reasons"] == {oid: "width_mismatch"}
        assert self._state(oid) == before, "a rejected save changes nothing, flag included"

    def test_a_width_within_sixty_seconds_is_accepted_and_clears_the_stale_flag(self):
        oid = self._order("CLOSE")
        new_start = self.s + dt.timedelta(days=1)
        res = self._save(oid, start=new_start, end=new_start + dt.timedelta(hours=4, seconds=45))
        assert res["persisted"] == 1 and res["invalid_ids"] == [] and res["rejection_reasons"] == {}
        assert self._state(oid) == (new_start, new_start + dt.timedelta(hours=4, seconds=45), False, None)

    def test_a_width_just_over_sixty_seconds_is_rejected(self):
        oid = self._order("EDGE")
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=4, seconds=61))
        assert res["rejection_reasons"] == {oid: "width_mismatch"}

    def test_an_overtime_marker_lets_a_mismatched_width_through_and_leaves_the_flag_alone(self):
        oid = self._order("OT")
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=7), placement_exception="overtime")
        assert res["persisted"] == 1 and res["rejection_reasons"] == {}
        assert self._state(oid) == (self.s, self.s + dt.timedelta(hours=7), True, "overtime")
        row = self.pg.get_task_versions([oid])[0]
        assert row["placement_exception"] == "overtime"

    def test_a_stored_marker_keeps_standing_the_check_down_on_later_saves(self):
        oid = self._order("OT_STORED", exception="overlong", hours=9)
        res = self._save(oid, start=self.s + dt.timedelta(days=1), end=self.s + dt.timedelta(days=1, hours=9))
        assert res["persisted"] == 1
        assert self._state(oid)[3] == "overlong"

    def test_an_explicit_null_clears_the_marker_and_the_check_applies_again(self):
        oid = self._order("CLEAR", exception="overtime", hours=7)
        bad = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=7, minutes=1), placement_exception=None)
        assert bad["rejection_reasons"] == {oid: "width_mismatch"}
        assert self._state(oid)[3] == "overtime", "a rejected save does not clear the marker"
        good = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=4), placement_exception=None)
        assert good["persisted"] == 1
        assert self._state(oid) == (self.s, self.s + dt.timedelta(hours=4), False, None)

    def test_a_bad_marker_value_is_rejected(self):
        oid = self._order("BADMARK")
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=4), placement_exception="sideways")
        assert res["persisted"] == 0 and res["invalid_ids"] == [oid]

    def test_an_unknown_run_time_skips_the_width_check_and_leaves_the_flag_alone(self):
        oid = self._order("NORT", run_time=None, hours=3)
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=11))
        assert res["persisted"] == 1
        assert self._state(oid)[2] is True

    def test_a_24_7_bar_across_the_spring_forward_gap_is_judged_in_elapsed_plant_time(self):
        # 2026-03-08 02:00 Chicago does not exist: 00:00 -> 06:00 on the wall clock is 5 hours elapsed.
        start = dt.datetime(2026, 3, 8, 0, 0)
        end = dt.datetime(2026, 3, 8, 6, 0)
        oid = self._order("DST", run_time=5, start=start, hours=5)
        res = self._save(oid, start=start, end=end)
        assert res["persisted"] == 1 and res["rejection_reasons"] == {}, "naive width is 6 h, elapsed is 5 h"
        assert self._state(oid) == (start, end, False, None)

    def test_the_same_bar_without_a_plant_zone_is_judged_on_the_wall_clock(self):
        start = dt.datetime(2026, 3, 8, 0, 0)
        oid = self._order("NOTZ", plant=self.PLANT_NOTZ, run_time=5, start=start, hours=5)
        res = self._save(oid, start=start, end=dt.datetime(2026, 3, 8, 6, 0))
        assert res["rejection_reasons"] == {oid: "width_mismatch"}

    def test_a_segmented_save_is_judged_by_the_segment_rules_and_clears_the_flag(self):
        oid = self._order("SEG", run_time=4, hours=10)
        pieces = [{"sequence": 1, "start": self.s, "end": self.s + dt.timedelta(hours=2)},
                  {"sequence": 2, "start": self.s + dt.timedelta(hours=8), "end": self.s + dt.timedelta(hours=10)}]
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=10), schedule_segments=pieces)
        assert res["persisted"] == 1 and res["rejection_reasons"] == {}
        assert self._state(oid)[2] is False

    def test_a_browser_shaped_continuous_save_carries_an_empty_segment_list_and_is_still_checked(self):
        oid = self._order("BROWSER")
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=5), schedule_segments=[])
        assert res["rejection_reasons"] == {oid: "width_mismatch"}
        moved = self.s + dt.timedelta(days=1)       # a moved bar (an unmoved one is not judged)
        ok = self._save(oid, start=moved, end=moved + dt.timedelta(hours=4), schedule_segments=[])
        assert ok["persisted"] == 1 and self._state(oid)[2] is False

    def test_an_unmoved_bar_resaved_with_an_attribute_edit_is_accepted_and_the_flag_stays(self):
        """The browser resends the full snapshot on a PRT/machine-only edit: a stale bar (width != run time,
        flag set) whose edges are unchanged is not judged, and the flag is left alone."""
        oid = self._order("UNMOVED", run_time=4, hours=6)
        res = self.pg.update_task_dates_bulk([{"id": oid, "start": self.s, "end": self.s + dt.timedelta(hours=6),
                                              "PRT_01": "P9", "schedule_segments": []}])
        assert res["persisted"] == 1 and res["rejection_reasons"] == {}
        assert self._state(oid) == (self.s, self.s + dt.timedelta(hours=6), True, None)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT prt_01 FROM orders WHERE id = %s", (oid,))
            assert cur.fetchone()[0] == "P9"

    def test_the_same_stale_bar_with_its_end_moved_a_minute_is_judged_again(self):
        oid = self._order("MOVED1", run_time=4, hours=6)
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=6, minutes=1))
        assert res["rejection_reasons"] == {oid: "width_mismatch"}
        assert self._state(oid)[1] == self.s + dt.timedelta(hours=6)

    def test_an_unmoved_bar_whose_run_time_changes_in_the_same_save_is_still_judged(self):
        oid = self._order("RTCHG", run_time=4, hours=4)
        res = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=4), RUN_TIME=9)
        assert res["rejection_reasons"] == {oid: "width_mismatch"}

    def test_an_unplaced_row_sent_with_its_sap_window_is_still_gated_not_stamped(self):
        oid = self.pg.make_id("ZZTEST_SCW_UNPLACED", "ZZTEST_SCW_MAT")
        sap_end = self.s + dt.timedelta(hours=9)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, original_start_received, original_finish_received, run_time)"
                " VALUES (%s,%s,'ZZTEST_SCW_MAT',%s,%s,%s,%s,%s,%s,4)",
                (oid, "ZZTEST_SCW_UNPLACED", self.MACHINE, self.PLANT, self.s, sap_end, self.s, sap_end))
            conn.commit()
        res = self._save(oid, start=self.s, end=sap_end)          # a 9 h window for a 4 h run time
        assert res["rejection_reasons"] == {oid: "width_mismatch"}
        assert self._state(oid)[:2] == (None, None), "never stamped as a placement"
        ok = self._save(oid, start=self.s, end=self.s + dt.timedelta(hours=4))
        assert ok["persisted"] == 1

    def test_a_marker_only_save_is_a_valid_edit(self):
        oid = self._order("MARKONLY")
        res = self._save(oid, placement_exception="overlong")
        assert res["persisted"] == 1
        assert self._state(oid)[3] == "overlong" and self._state(oid)[2] is True


@pytest.mark.pg
class TestUntrustedStartSave:
    """Backward scheduling Task 2.7 (OQ59): an outside writer's start is not trusted. The finish it sends is
    the placed finish; the stale flag is forced TRUE (it takes precedence over the width validator's
    clearing, which is skipped for that save) and the response names the ids whose start the browser must
    re-derive (`start_derived`)."""
    SUB, PLANT = "ZZTEST_UTS_SUB", "ZZTEST_UTS_PLANT"
    MACHINE = "ZZTEST_UTS_LINE"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.pg = pg
        self.s = dt.datetime(2026, 6, 1, 8, 0)
        self._cleanup()
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'uts') ON CONFLICT DO NOTHING", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'America/Chicago')",
                        (self.SUB, self.PLANT))
            conn.commit()
        yield
        self._cleanup()

    def _cleanup(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def _order(self, name, *, run_time=4, mismatch=False):
        oid = self.pg.make_id("ZZTEST_UTS_" + name, "ZZTEST_UTS_MAT")
        end = self.s + dt.timedelta(hours=run_time)
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, scheduled_start, scheduled_end, run_time, runtime_schedule_mismatch)"
                " VALUES (%s,%s,'ZZTEST_UTS_MAT',%s,%s,%s,%s,%s,%s,%s,%s)",
                (oid, "ZZTEST_UTS_" + name, self.MACHINE, self.PLANT, self.s, end, self.s, end, run_time, mismatch))
            conn.commit()
        return oid

    def _state(self, oid):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT scheduled_start, scheduled_end, runtime_schedule_mismatch FROM orders WHERE id = %s",
                        (oid,))
            return cur.fetchone()

    def test_an_untrusted_start_skips_the_width_validator_forces_the_flag_and_reports_start_derived(self):
        oid = self._order("UNTRUSTED")
        s1, e1 = self.s + dt.timedelta(days=1), self.s + dt.timedelta(days=1, hours=9)   # 9 h bar for a 4 h run time
        res = self.pg.update_task_dates_bulk([{"id": oid, "start": s1, "end": e1, "trust_start": False}])
        assert res["persisted"] == 1 and res["invalid_ids"] == [] and res["rejection_reasons"] == {}
        assert res["start_derived"] == {oid: True}
        assert self._state(oid) == (s1, e1, True), "the finish is stored as the placed finish, the flag is forced"

    def test_the_forced_flag_beats_the_validators_clearing_even_when_the_width_would_pass(self):
        oid = self._order("PASSES")
        s1 = self.s + dt.timedelta(days=1)
        res = self.pg.update_task_dates_bulk([{"id": oid, "start": s1, "end": s1 + dt.timedelta(hours=4),
                                              "trust_start": False}])
        assert res["persisted"] == 1 and res["start_derived"] == {oid: True}
        assert self._state(oid)[2] is True, "a width that happens to fit does not clear an untrusted start's flag"

    def test_a_trusted_save_is_unchanged_and_reports_no_start_derived(self):
        oid = self._order("TRUSTED", mismatch=True)
        s1 = self.s + dt.timedelta(days=1)
        res = self.pg.update_task_dates_bulk([{"id": oid, "start": s1, "end": s1 + dt.timedelta(hours=4)}])
        assert res["persisted"] == 1 and res["start_derived"] == {}
        assert self._state(oid)[2] is False
        bad = self.pg.update_task_dates_bulk([{"id": oid, "start": s1, "end": s1 + dt.timedelta(hours=9),
                                              "trust_start": True}])
        assert bad["rejection_reasons"] == {oid: "width_mismatch"} and bad["start_derived"] == {}

    def test_an_untrusted_save_still_needs_both_edges_and_rejects_an_inverted_range(self):
        oid = self._order("EDGES")
        res = self.pg.update_task_dates_bulk([{"id": oid, "end": self.s + dt.timedelta(hours=4), "trust_start": False}])
        assert res["rejection_reasons"] == {oid: "single_edge"} and res["start_derived"] == {}
        res = self.pg.update_task_dates_bulk([{"id": oid, "start": self.s, "end": self.s - dt.timedelta(hours=1),
                                              "trust_start": False}])
        assert res["invalid_ids"] == [oid] and res["start_derived"] == {}

    def test_the_bulk_route_takes_trust_start_from_the_request_and_carries_start_derived(self, client):
        import backend.security.auth as auth
        oid = self._order("ROUTE")
        s1, e1 = self.s + dt.timedelta(days=2), self.s + dt.timedelta(days=2, hours=7)
        base = self.pg.get_task_versions([oid])[0]["row_version"]
        client.app.dependency_overrides[auth.require_authenticated] = lambda: "uts@example.com"
        client.app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
        try:
            res = client.post("/tasks/bulk_update", json=[{
                "id": oid, "start_date": s1.isoformat(), "end_date": e1.isoformat(),
                "base_version": base, "trust_start": False}])
            assert res.status_code == 200, res.text
            body = res.json()
            assert body["persisted"] == 1 and body["start_derived"] == {oid: True}
            assert self._state(oid) == (s1, e1, True)
            # the default is a trusted start: the same wide bar is refused by the width check, and nothing derives
            base = self.pg.get_task_versions([oid])[0]["row_version"]
            res = client.post("/tasks/bulk_update", json=[{
                "id": oid, "start_date": (s1 + dt.timedelta(days=1)).isoformat(),
                "end_date": (e1 + dt.timedelta(days=1)).isoformat(), "base_version": base}])
            body = res.json()
            assert body["persisted"] == 0 and body["rejection_reasons"] == {oid: "width_mismatch"}
            assert body["start_derived"] == {}
        finally:
            client.app.dependency_overrides.clear()


@pytest.mark.pg
class TestNeverPlacedRowWithoutAStartIsStillServed:
    """Backward scheduling Task 2.7: the start is optional at ingest, so a never-placed order can carry a NULL
    start. /tasks must still serve it (it reads its finish as the SAP finish); only a row with neither edge
    and no queue state has nothing to draw."""
    SUB, PLANT = "ZZTEST_NSR_SUB", "ZZTEST_NSR_PLANT"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        self.pg = pg
        self._cleanup()
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, 'nsr') ON CONFLICT DO NOTHING", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES (%s, %s, 'UTC')", (self.SUB, self.PLANT))
            conn.commit()
        yield
        self._cleanup()

    def _cleanup(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def test_get_tasks_returns_a_row_with_no_start_and_its_sap_finish(self, client):
        import backend.security.auth as auth
        due = dt.datetime(2031, 5, 5, 12, 0)
        oid = self.pg.make_id("ZZTEST_NSR_ORD", "ZZTEST_NSR_MAT")
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                " basic_finish_date, original_start_received, original_finish_received, run_time)"
                " VALUES (%s,'ZZTEST_NSR_ORD','ZZTEST_NSR_MAT','ZZTEST_NSR_LINE',%s,NULL,%s,NULL,%s,4)",
                (oid, self.PLANT, due, due))
            conn.commit()
        client.app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
        try:
            res = client.get("/tasks", params={"plant": self.PLANT})
        finally:
            client.app.dependency_overrides.clear()
        assert res.status_code == 200, res.text
        rows = {r["id"]: r for r in res.json()["data"]}
        assert oid in rows, "a NULL-start never-placed order must not vanish from /tasks"
        assert rows[oid]["start_date"] is None and rows[oid]["end_date"] == due.strftime("%Y-%m-%dT%H:%M:%S")
        assert rows[oid]["user_scheduled"] is False


def test_conflict_scan_lookback_is_the_fixed_30_day_cap_and_reads_the_stored_finish():
    """Backward scheduling OQ27 (e): the start-indexed lookback is the fixed 30-day cap (no MAX(run_time)
    sizing query any more: a bar's drawn span is no longer start + run time), still bounded by the eff-start
    range (idx_orders_machine_eff_start), and the overlap test reads the shared end fragment."""
    import datetime as _dt
    import db as db_

    class Cur:
        def __init__(self): self.q = []
        def execute(self, sql, params=None): self.q.append((sql, params))
        def fetchone(self): return (0,)
        def fetchall(self): return []

    cur = Cur()
    t0 = _dt.datetime(2026, 10, 1, 8)
    rows = [{"id": "A", "moved": True, "queued": False, "machine": "M1", "start": t0, "end": t0 + _dt.timedelta(hours=2)}]
    db_._scan_conflicts_for_rows(cur, rows, {"A": {"plant": "1006", "start": t0, "end": t0}})
    assert len(cur.q) == 1, "one scan query, no run-time lookback sizing query"
    sql, params = cur.q[0]
    assert "MAX(run_time)" not in sql and "INTERVAL" not in sql
    assert "BETWEEN" in sql and "COALESCE(o.scheduled_start, o.basic_start_date)" in sql
    assert db_._EFF_END_SQL in sql and "seg.last_end" in sql
    lo, hi = params[2], params[3]
    assert lo == t0 - _dt.timedelta(days=1) - _dt.timedelta(days=30) and hi == t0 + _dt.timedelta(hours=2) + _dt.timedelta(days=1)
