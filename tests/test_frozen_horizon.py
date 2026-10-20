"""
Workstream C2 (2026-08-20) — plant frozen horizon.

`db.compute_frozen_horizon_end` is a ROLLING window since 2026-10-19: plant-local
now + frozen_horizon_days (both window edges advance with the clock, like the
alert horizon). It no longer shares C1's daily anchor-day/roll-hour clock
(`db._horizon_boundary_core`, still used by the visibility horizon only; pinned
by tests/test_visibility_horizon.py). These tests pin the null/off convention
(NULL *and* 0 both disable it, unlike C1's NULL-only rule), the moving edge,
that the roll hour is ignored, and the timezone fallback.

Also pins `db.query_orders`' three-way return (df, visibility_horizon_end,
frozen_horizon_end) — frozen_horizon_end must never gate the WHERE clause
(it's a placement floor for the optimizer, not a /tasks visibility bound).
"""
import datetime as dt

import pytest

import db


# ---------------------------------------------------------------------------
# Pure-logic: db.compute_frozen_horizon_end
# ---------------------------------------------------------------------------
class TestComputeFrozenHorizonEnd:
    def test_off_when_days_is_none(self):
        now_utc = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.timezone.utc)
        assert db.compute_frozen_horizon_end(now_utc, "UTC", 19, None) is None

    def test_off_when_days_is_zero(self):
        # The one deliberate divergence from C1's visibility_horizon_days,
        # where 0 is a normal (if odd) day-count, not "off".
        now_utc = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.timezone.utc)
        assert db.compute_frozen_horizon_end(now_utc, "UTC", 19, 0) is None

    def test_end_is_plant_local_now_plus_days_not_midnight(self):
        # Rolling window (2026-10-19): now + N days, NOT a plant-local midnight.
        now_utc = dt.datetime(2026, 8, 20, 10, 30, tzinfo=dt.timezone.utc)
        end = db.compute_frozen_horizon_end(now_utc, "UTC", 19, 2)
        assert end == dt.datetime(2026, 8, 22, 10, 30)
        assert end.tzinfo is None  # naive plant-local wall clock

    def test_edge_moves_continuously_with_now(self):
        # Two clocks an hour apart give ends an hour apart (no daily jump).
        t1 = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        t2 = t1 + dt.timedelta(hours=1)
        e1 = db.compute_frozen_horizon_end(t1, "UTC", 19, 3)
        e2 = db.compute_frozen_horizon_end(t2, "UTC", 19, 3)
        assert e2 - e1 == dt.timedelta(hours=1)

    def test_roll_hour_no_longer_affects_the_frozen_horizon(self):
        # Before and after the UTC roll hour used to differ by a whole day.
        before = dt.datetime(2026, 8, 20, 18, 0, tzinfo=dt.timezone.utc)
        after = dt.datetime(2026, 8, 20, 20, 0, tzinfo=dt.timezone.utc)
        assert db.compute_frozen_horizon_end(before, "UTC", 19, 3) == dt.datetime(2026, 8, 23, 18, 0)
        assert db.compute_frozen_horizon_end(after, "UTC", 19, 3) == dt.datetime(2026, 8, 23, 20, 0)
        # ...and the roll-hour argument itself is ignored.
        assert (db.compute_frozen_horizon_end(after, "UTC", 0, 3)
                == db.compute_frozen_horizon_end(after, "UTC", 23, 3))

    def test_uses_the_plant_local_clock(self):
        # 02:00 UTC is 22:00 the previous day in New York (EDT, UTC-4).
        now_utc = dt.datetime(2026, 8, 20, 2, 0, tzinfo=dt.timezone.utc)
        end = db.compute_frozen_horizon_end(now_utc, "America/New_York", 19, 1)
        assert end == dt.datetime(2026, 8, 20, 22, 0)

    def test_visibility_horizon_keeps_the_daily_roll(self):
        # Unchanged: the visibility horizon is still a plant-local midnight.
        now_utc = dt.datetime(2026, 8, 20, 10, 30, tzinfo=dt.timezone.utc)
        assert db.compute_visibility_horizon_end(now_utc, "UTC", 19, 2) == dt.datetime(2026, 8, 22, 0, 0)

    def test_unknown_timezone_falls_back_instead_of_raising(self):
        now_utc = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        end = db.compute_frozen_horizon_end(now_utc, "Not/A_Real_Zone", 19, 1)
        assert end == dt.datetime(2026, 8, 21, 10, 0)  # falls back to UTC as the local clock

    def test_missing_timezone_falls_back_to_utc(self):
        now_utc = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        assert db.compute_frozen_horizon_end(now_utc, None, 19, 1) == dt.datetime(2026, 8, 21, 10, 0)

    def test_naive_now_is_treated_as_utc(self):
        now = dt.datetime(2026, 8, 20, 10, 0)
        assert db.compute_frozen_horizon_end(now, "UTC", 19, 1) == dt.datetime(2026, 8, 21, 10, 0)


# ---------------------------------------------------------------------------
# query_orders' frozen_horizon_end must be reported but never gate the query
# ---------------------------------------------------------------------------
@pytest.mark.pg
class TestFrozenHorizonNeverGatesQueryOrders:
    SUBNETWORK = "WTG"  # seeded by schema.sql
    PLANT = "ZZTEST_C2_PLANT"
    MACHINE = "ZZTEST_C2_LINE"
    FROZEN_DAYS = 3
    ROLL_HOUR = 0  # deterministic regardless of wall-clock hour

    ORD_SOON, MAT_SOON = "ZZTEST_ORD_C2_SOON", "ZZTEST_MAT_C2_SOON"
    ORD_LATER, MAT_LATER = "ZZTEST_ORD_C2_LATER", "ZZTEST_MAT_C2_LATER"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        oid_soon = db_.make_id(self.ORD_SOON, self.MAT_SOON)
        oid_later = db_.make_id(self.ORD_LATER, self.MAT_LATER)

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO plants (subnetwork, plant, timezone, frozen_horizon_days, "
                "horizon_roll_hour_utc, visibility_horizon_days) "
                "VALUES (%s,%s,'UTC',%s,%s,NULL) "
                "ON CONFLICT (subnetwork, plant) DO UPDATE SET "
                "timezone = 'UTC', frozen_horizon_days = EXCLUDED.frozen_horizon_days, "
                "horizon_roll_hour_utc = EXCLUDED.horizon_roll_hour_utc, "
                "visibility_horizon_days = NULL",
                (self.SUBNETWORK, self.PLANT, self.FROZEN_DAYS, self.ROLL_HOUR),
            )
            for oid in (oid_soon, oid_later):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            # Starts well inside the frozen window (tomorrow).
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (oid_soon, self.ORD_SOON, self.MAT_SOON, self.MACHINE, self.PLANT,
                 now + dt.timedelta(days=1)),
            )
            # Starts well beyond the frozen window.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (oid_later, self.ORD_LATER, self.MAT_LATER, self.MACHINE, self.PLANT,
                 now + dt.timedelta(days=30)),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for oid in (oid_soon, oid_later):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s",
                        (self.SUBNETWORK, self.PLANT))
            conn.commit()

    def test_both_orders_are_returned_despite_an_active_frozen_window(self, pg):
        db_ = pg
        df, visibility_end, frozen_end = db_.query_orders(plant=self.PLANT)
        oid_soon = db_.make_id(self.ORD_SOON, self.MAT_SOON)
        oid_later = db_.make_id(self.ORD_LATER, self.MAT_LATER)
        ids = set(df["id"])
        assert oid_soon in ids, "frozen_horizon_days must never filter /tasks rows"
        assert oid_later in ids
        assert visibility_end is None  # this plant has no C1 horizon configured
        assert frozen_end is not None  # but DOES have a resolved C2 bound to report

    def test_count_orders_is_unaffected_by_the_frozen_window(self, pg):
        db_ = pg
        assert db_.count_orders(plant=self.PLANT) == 2
