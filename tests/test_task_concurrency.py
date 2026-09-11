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
