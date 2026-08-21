"""
Workstream C1 (2026-08-20) — plant visibility horizon.

`db.compute_visibility_horizon_end` is pure logic — no database required, runs
unconditionally (same convention as tests/test_make_id.py). The
query_orders/count_orders agreement test requires Postgres -> marked
@pytest.mark.pg (auto-skipped when the DB is down) — it closes the PT-16
hazard the C1 spec calls out: count_orders used to be a completely separate
WHERE builder with no order_schedule_segments LATERAL, so a horizon bound
referencing the segments-aware three-way coalesce could disagree between the
two, silently lying about /tasks' meta.total whenever paging is active.

Tests insert sentinel rows/plant (ZZTEST_* keys) and clean up in teardown, so
they are safe to run against a populated dev DB (mirrors
tests/test_data_integrity.py's convention).
"""
import datetime as dt

import pytest

import db


# ---------------------------------------------------------------------------
# Pure-logic: db.compute_visibility_horizon_end
# ---------------------------------------------------------------------------
class TestComputeVisibilityHorizonEnd:
    def test_unlimited_when_days_is_none(self):
        now_utc = dt.datetime(2026, 8, 20, 12, 0, tzinfo=dt.timezone.utc)
        assert db.compute_visibility_horizon_end(now_utc, "UTC", 19, None) is None

    def test_plant_local_midnight_before_roll_hour(self):
        # 10:00 UTC, roll hour 19 -> not yet rolled -> anchor_day stays "today" (UTC tz).
        now_utc = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        end = db.compute_visibility_horizon_end(now_utc, "UTC", 19, 2)
        assert end == dt.datetime(2026, 8, 22, 0, 0)  # today (20th) + 2 days, midnight

    def test_anchor_day_advances_once_utc_passes_roll_hour(self):
        # 20:00 UTC, roll hour 19 -> already past roll -> anchor_day advances to tomorrow.
        now_utc = dt.datetime(2026, 8, 20, 20, 0, tzinfo=dt.timezone.utc)
        end = db.compute_visibility_horizon_end(now_utc, "UTC", 19, 2)
        assert end == dt.datetime(2026, 8, 23, 0, 0)  # tomorrow (21st) + 2 days, midnight

    def test_roll_at_exactly_the_boundary_hour_counts_as_passed(self):
        # 19:00:00 UTC, roll hour 19 -> "passes" is inclusive of the boundary hour.
        now_utc = dt.datetime(2026, 8, 20, 19, 0, tzinfo=dt.timezone.utc)
        end = db.compute_visibility_horizon_end(now_utc, "UTC", 19, 0)
        assert end == dt.datetime(2026, 8, 21, 0, 0)  # tomorrow (21st) + 0 days, midnight

    def test_plant_local_clock_and_utc_roll_clock_are_allowed_to_disagree(self):
        # OD-C1c: a plant west of UTC can still be "yesterday" locally at the
        # moment the UTC roll hour fires -- anchor_day uses the LOCAL date,
        # independent of whether the UTC clock has rolled.
        now_utc = dt.datetime(2026, 8, 21, 1, 0, tzinfo=dt.timezone.utc)  # 20:00 the 20th in America/Chicago (UTC-5)
        end = db.compute_visibility_horizon_end(now_utc, "America/Chicago", 19, 1)
        # Local date is still the 20th (20:00 CDT); UTC hour 1 has NOT reached
        # roll hour 19, so anchor_day stays the 20th -> +1 day -> midnight the 21st.
        assert end == dt.datetime(2026, 8, 21, 0, 0)

    def test_unknown_timezone_falls_back_instead_of_raising(self):
        now_utc = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        end = db.compute_visibility_horizon_end(now_utc, "Not/A_Real_Zone", 19, 1)
        assert end == dt.datetime(2026, 8, 21, 0, 0)  # falls back to treating now_utc as local

    def test_naive_now_utc_is_treated_as_utc(self):
        now_naive = dt.datetime(2026, 8, 20, 10, 0)  # no tzinfo
        end = db.compute_visibility_horizon_end(now_naive, "UTC", 19, 0)
        assert end == dt.datetime(2026, 8, 20, 0, 0)  # hour 10 < roll hour 19 -> no advance


# ---------------------------------------------------------------------------
# query_orders / count_orders agreement under an active horizon bound (PT-16)
# ---------------------------------------------------------------------------
@pytest.mark.pg
class TestQueryAndCountAgreeUnderHorizonBound:
    SUBNETWORK = "WTG"  # seeded by schema.sql
    PLANT = "ZZTEST_C1_PLANT"
    MACHINE = "ZZTEST_C1_LINE"
    HORIZON_DAYS = 2
    # 0 makes compute_visibility_horizon_end's roll-hour advance unconditional
    # (every UTC hour is >= 0), so the effective horizon is deterministic
    # regardless of what wall-clock hour the test suite happens to run at.
    ROLL_HOUR = 0

    ORD_INSIDE, MAT_INSIDE = "ZZTEST_ORD_C1_IN", "ZZTEST_MAT_C1_IN"
    ORD_OUTSIDE, MAT_OUTSIDE = "ZZTEST_ORD_C1_OUT", "ZZTEST_MAT_C1_OUT"
    ORD_SEG, MAT_SEG = "ZZTEST_ORD_C1_SEG", "ZZTEST_MAT_C1_SEG"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        oid_in = db_.make_id(self.ORD_INSIDE, self.MAT_INSIDE)
        oid_out = db_.make_id(self.ORD_OUTSIDE, self.MAT_OUTSIDE)
        oid_seg = db_.make_id(self.ORD_SEG, self.MAT_SEG)

        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO plants (subnetwork, plant, timezone, visibility_horizon_days, horizon_roll_hour_utc) "
                "VALUES (%s,%s,'UTC',%s,%s) "
                "ON CONFLICT (subnetwork, plant) DO UPDATE SET "
                "timezone = 'UTC', visibility_horizon_days = EXCLUDED.visibility_horizon_days, "
                "horizon_roll_hour_utc = EXCLUDED.horizon_roll_hour_utc",
                (self.SUBNETWORK, self.PLANT, self.HORIZON_DAYS, self.ROLL_HOUR),
            )
            for oid in (oid_in, oid_out, oid_seg):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            # Clearly inside the (today+1)..(today+1+HORIZON_DAYS) window.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (oid_in, self.ORD_INSIDE, self.MAT_INSIDE, self.MACHINE, self.PLANT,
                 now + dt.timedelta(days=1)),
            )
            # Clearly beyond the horizon.
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (oid_out, self.ORD_OUTSIDE, self.MAT_OUTSIDE, self.MACHINE, self.PLANT,
                 now + dt.timedelta(days=10)),
            )
            # basic_start_date alone LOOKS inside the horizon (same as oid_in), but
            # its only schedule segment starts well beyond it -- this order must be
            # excluded via the segments-aware three-way coalesce, not the two-way
            # COALESCE(scheduled_start, basic_start_date) shortcut (OD-C1b).
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (oid_seg, self.ORD_SEG, self.MAT_SEG, self.MACHINE, self.PLANT,
                 now + dt.timedelta(days=1)),
            )
            cur.execute(
                "INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end) "
                "VALUES (%s, 1, %s, %s)",
                (oid_seg, now + dt.timedelta(days=10), now + dt.timedelta(days=10, hours=4)),
            )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            for oid in (oid_in, oid_out, oid_seg):
                cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s",
                        (self.SUBNETWORK, self.PLANT))
            conn.commit()

    def test_count_orders_agrees_with_query_orders_row_count(self, pg):
        db_ = pg
        df, horizon_end, _frozen_end = db_.query_orders(plant=self.PLANT)
        total = db_.count_orders(plant=self.PLANT)
        assert total == len(df), (
            f"count_orders ({total}) disagrees with query_orders ({len(df)}) under an "
            "active visibility horizon -- meta.total would lie about pagination (PT-16)"
        )
        # query_orders must hand back the SAME bound it applied (this is what
        # lets brain.py's GET /tasks report meta.visibility_horizon_end without
        # a third, purely-reporting round-trip re-resolving the plant config).
        assert horizon_end is not None

    def test_horizon_excludes_orders_starting_beyond_the_bound(self, pg):
        db_ = pg
        df, _horizon_end, _frozen_end = db_.query_orders(plant=self.PLANT)
        ids = set(df["id"])
        oid_in = db_.make_id(self.ORD_INSIDE, self.MAT_INSIDE)
        oid_out = db_.make_id(self.ORD_OUTSIDE, self.MAT_OUTSIDE)
        oid_seg = db_.make_id(self.ORD_SEG, self.MAT_SEG)
        assert oid_in in ids
        assert oid_out not in ids
        assert oid_seg not in ids  # excluded via seg.first_start, not basic_start_date
        assert db_.count_orders(plant=self.PLANT) == 1  # exactly oid_in survives
