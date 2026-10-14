"""Backward-scheduling cutover migrations (spec test group 9).

Applies migrations/2026-10-20-0-orders-precutover-snapshot.sql and migrations/2026-10-20-1-backward-cutover.sql
(read from disk) twice to a seeded fleet and pins the write set per row class. Everything runs in ONE
transaction that is rolled back, so the test database is never left changed (the ledger ids and snapshot
tables are cleared inside the transaction first, so it works whether or not the files were applied by hand).
now() is stable inside a transaction, so "plant-local now" read from SQL is exactly what the cutover sees.
"""
import os
from datetime import timedelta

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_SQL = os.path.join(ROOT, "migrations", "2026-10-20-0-orders-precutover-snapshot.sql")
CUTOVER_SQL = os.path.join(ROOT, "migrations", "2026-10-20-1-backward-cutover.sql")
LEDGER_IDS = ("backward_cutover_snapshot", "backward_scheduling_cutover")
SNAP_TABLES = (
    "orders_precutover_snapshot",
    "order_schedule_segments_precutover_snapshot",
    "order_sap_sent_precutover_snapshot",
)
AK, NOTZ = "ZZCUT_AK", "ZZCUT_NOTZ"  # Auckland (UTC+12/13, far from UTC) and a plant with no timezone
OLD = "2020-01-01 00:00:00"


def _h(n):
    return timedelta(hours=n)


def _d(days, hours=0):
    return timedelta(days=days, hours=hours)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _seed(cur):
    cur.execute("INSERT INTO subnetworks (code, name) VALUES ('ZZCUT_SUB', 'cutover test') ON CONFLICT DO NOTHING")
    cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES ('ZZCUT_SUB', %s, 'Pacific/Auckland')", (AK,))
    cur.execute("INSERT INTO plants (subnetwork, plant, timezone) VALUES ('ZZCUT_SUB', %s, NULL)", (NOTZ,))
    cur.execute("SELECT now() AT TIME ZONE 'Pacific/Auckland', now() AT TIME ZONE 'UTC'")
    pnow, utcnow = cur.fetchone()

    def add(oid, plant, *, base, start=None, end=None, run=4, due_days=0, firmed=False, exc=None,
            status="scheduled", parent=None, letter=None):
        due = base + _d(due_days)
        cur.execute(
            """INSERT INTO orders (id, production_order, material_number, machine, plant,
                   basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time,
                   original_finish_received, manual_firmed, firming_indicator, placement_exception,
                   planning_status, planning_reason, parent_production_order, distribution_letter,
                   runtime_schedule_mismatch, updated_at)
               VALUES (%s, %s, 'ZZCUT_MAT', 'ZZCUT_M1', %s,
                   %s, %s, %s, %s, %s,
                   %s, %s, %s, %s,
                   %s, CASE WHEN %s = 'needs_planning' THEN '{"code":"x","message":"y"}'::jsonb END, %s, %s,
                   FALSE, %s)""",
            (oid, oid, plant, due - _h(10), due, start, end, run, due, firmed,
             "X" if firmed else None, exc, status, status, parent, letter, OLD),
        )

    a = pnow
    add("zzcut-run-pastdue", AK, base=a, start=a - _h(2), end=a + _h(3), run=4, due_days=-5)  # old end = start + run_time
    add("zzcut-run-futuredue", AK, base=a, start=a - _h(1), end=a + _h(2), run=3, due_days=3)
    add("zzcut-run-split", AK, base=a, start=a - _h(3), end=a + _h(9), run=6, due_days=1)  # old end = last segment end
    add("zzcut-run-noruntime", AK, base=a, start=a - _h(1), end=a + _h(6), run=None, due_days=1)  # old end = scheduled_end
    add("zzcut-future", AK, base=a, start=a + _d(1), end=a + _d(1, 4), due_days=2)
    add("zzcut-never", AK, base=a, due_days=2)
    add("zzcut-queued", AK, base=a, status="needs_planning", due_days=2)
    add("zzcut-split-future", AK, base=a, start=a + _d(2), end=a + _d(2, 9), run=6, due_days=3)
    add("zzcut-firmed", AK, base=a, start=a + _d(1), end=a + _d(1, 4), due_days=2, firmed=True)
    add("zzcut-marked", AK, base=a, start=a + _d(1), end=a + _d(1, 4), due_days=2, exc="overlong")
    add("zzcut-dist-A", AK, base=a, start=a + _d(1), end=a + _d(1, 4), due_days=2, parent="ZZP1", letter="A")
    add("zzcut-dist-B", AK, base=a, start=a - _h(1), end=a + _h(3), run=4, due_days=2, parent="ZZP1", letter="B")
    # No-timezone plant: the SQL falls back to UTC, so a start 1 h before UTC now reads as running.
    add("zzcut-notz-run", NOTZ, base=utcnow, start=utcnow - _h(1), end=utcnow + _h(2), run=3, due_days=1)
    add("zzcut-notz-never", NOTZ, base=utcnow, due_days=1)
    # I4: a running row whose plant is NULL, or names no plants row, still reads as running (UTC clock).
    add("zzcut-nullplant-run", None, base=utcnow, start=utcnow - _h(2), end=utcnow + _h(3), run=5, due_days=1)
    add("zzcut-noplantrow-run", "ZZCUT_NOPLANTROW", base=utcnow, start=utcnow - _h(2), end=utcnow + _h(3), run=5,
        due_days=1)
    add("zzcut-nullplant-future", None, base=utcnow, start=utcnow + _d(1), end=utcnow + _d(1, 4), due_days=2)
    for oid, segs in (
        ("zzcut-run-split", [(-3, -1), (4, 8)]),  # last segment ends at pnow + 8 h
        ("zzcut-split-future", [(48, 52), (54, 59)]),
    ):
        for n, (x, y) in enumerate(segs, 1):
            cur.execute(
                "INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end) "
                "VALUES (%s, %s, %s, %s)",
                (oid, n, pnow + _h(x), pnow + _h(y)),
            )
    cur.execute("INSERT INTO order_sap_sent (order_id, plant, sent_finish, sent_firm) VALUES ('zzcut-firmed', %s, %s, TRUE)",
                (AK, pnow + _d(1, 4)))
    return pnow


def _row(cur, oid):
    cur.execute("SELECT scheduled_start, scheduled_end, placement_exception, runtime_schedule_mismatch, "
                "manual_firmed, firming_indicator, updated_at, basic_start_date, basic_finish_date "
                "FROM orders WHERE id = %s", (oid,))
    cols = ("start", "end", "exc", "mismatch", "firmed", "fi", "updated_at", "bstart", "bfinish")
    return dict(zip(cols, cur.fetchone()))


FLEET = ("zzcut-run-pastdue", "zzcut-run-futuredue", "zzcut-run-split", "zzcut-run-noruntime", "zzcut-future",
         "zzcut-never", "zzcut-queued", "zzcut-split-future", "zzcut-firmed", "zzcut-marked", "zzcut-dist-A",
         "zzcut-dist-B", "zzcut-notz-run", "zzcut-notz-never", "zzcut-nullplant-run", "zzcut-noplantrow-run",
         "zzcut-nullplant-future")


@pytest.mark.pg
def test_backward_cutover_write_set_and_idempotence(pg):
    snapshot_sql, cutover_sql = _read(SNAPSHOT_SQL), _read(CUTOVER_SQL)
    with pg._pool.connection() as conn, conn.cursor() as cur:
        try:
            cur.execute("DELETE FROM schema_migrations WHERE id = ANY(%s)", (list(LEDGER_IDS),))
            for t in SNAP_TABLES:
                cur.execute(f"DROP TABLE IF EXISTS {t}")
            pnow = _seed(cur)
            before = {oid: _row(cur, oid) for oid in FLEET}
            cur.execute("SELECT to_jsonb(o) FROM orders o WHERE id = 'zzcut-queued'")
            queued_before = cur.fetchone()[0]
            cur.execute("SELECT (SELECT count(*) FROM orders), (SELECT count(*) FROM order_schedule_segments), "
                        "(SELECT count(*) FROM order_sap_sent)")
            counts = cur.fetchone()

            # Run 1: the cutover for real. Run 2: must be a no-op, proven by a disturbance it must leave alone.
            cur.execute(snapshot_sql)
            cur.execute(cutover_sql)
            r = {oid: _row(cur, oid) for oid in FLEET}
            cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE id = 'zzcut-future'",
                        (pnow + _d(5), pnow + _d(5, 4)))
            cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end) "
                        "VALUES ('zzcut-future', 1, %s, %s)", (pnow + _d(5), pnow + _d(5, 4)))
            cur.execute(snapshot_sql)
            cur.execute(cutover_sql)
            assert (_row(cur, "zzcut-future")["start"], _row(cur, "zzcut-future")["end"]) == (pnow + _d(5), pnow + _d(5, 4))
            cur.execute("SELECT count(*) FROM order_schedule_segments WHERE order_id = 'zzcut-future'")
            assert cur.fetchone()[0] == 1

            # Running rows keep start AND the old end (arm order: last segment end, start + run_time, scheduled_end).
            assert (r["zzcut-run-pastdue"]["start"], r["zzcut-run-pastdue"]["end"]) == (pnow - _h(2), pnow + _h(2))
            assert r["zzcut-run-pastdue"]["bfinish"] < pnow  # due date already past, still running
            assert (r["zzcut-run-futuredue"]["start"], r["zzcut-run-futuredue"]["end"]) == (pnow - _h(1), pnow + _h(2) - _h(0))
            assert (r["zzcut-run-split"]["start"], r["zzcut-run-split"]["end"]) == (pnow - _h(3), pnow + _h(8))
            assert (r["zzcut-run-noruntime"]["start"], r["zzcut-run-noruntime"]["end"]) == (pnow - _h(1), pnow + _h(6))
            # Future placed (plant-local now matters: Auckland is far ahead of UTC) -> both NULL.
            assert (r["zzcut-future"]["start"], r["zzcut-future"]["end"]) == (None, None)
            # Never placed: dates untouched (NULL), SAP dates untouched, flag TRUE.
            assert (r["zzcut-never"]["start"], r["zzcut-never"]["end"]) == (None, None)
            assert (r["zzcut-never"]["bstart"], r["zzcut-never"]["bfinish"]) == (
                before["zzcut-never"]["bstart"], before["zzcut-never"]["bfinish"])
            assert r["zzcut-never"]["mismatch"] is True
            # Queued: untouched entirely.
            cur.execute("SELECT to_jsonb(o) FROM orders o WHERE id = 'zzcut-queued'")
            assert cur.fetchone()[0] == queued_before
            assert r["zzcut-queued"]["mismatch"] is False
            # Split future -> NULL/NULL and its segments are removed; the RUNNING split row keeps its edges AND
            # both fragments (I3: dropping them would draw it as one bar through closed hours).
            assert (r["zzcut-split-future"]["start"], r["zzcut-split-future"]["end"]) == (None, None)
            cur.execute("SELECT count(*) FROM order_schedule_segments WHERE order_id = 'zzcut-split-future'")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT segment_no, scheduled_start, scheduled_end FROM order_schedule_segments "
                        "WHERE order_id = 'zzcut-run-split' ORDER BY segment_no")
            assert cur.fetchall() == [(1, pnow - _h(3), pnow - _h(1)), (2, pnow + _h(4), pnow + _h(8))]
            # I4: NULL / unknown plant: running rows keep both edges, the future one is cleared.
            for oid in ("zzcut-nullplant-run", "zzcut-noplantrow-run"):
                assert (r[oid]["start"], r[oid]["end"]) == (before[oid]["start"], before[oid]["end"]), oid
            assert (r["zzcut-nullplant-future"]["start"], r["zzcut-nullplant-future"]["end"]) == (None, None)
            # Firmed: flag TRUE, firm kept, sent row kept.
            assert r["zzcut-firmed"]["mismatch"] is True
            assert r["zzcut-firmed"]["firmed"] is True and r["zzcut-firmed"]["fi"] == "X"
            assert (r["zzcut-firmed"]["start"], r["zzcut-firmed"]["end"]) == (None, None)
            cur.execute("SELECT count(*) FROM order_sap_sent WHERE order_id = 'zzcut-firmed'")
            assert cur.fetchone()[0] == 1
            # Marked: placement_exception cleared.
            assert before["zzcut-marked"]["exc"] == "overlong" and r["zzcut-marked"]["exc"] is None
            # Distribution family: members handled like any other row.
            assert (r["zzcut-dist-A"]["start"], r["zzcut-dist-A"]["end"]) == (None, None)
            assert (r["zzcut-dist-B"]["start"], r["zzcut-dist-B"]["end"]) == (pnow - _h(1), pnow + _h(3))
            # No-timezone plant falls back to UTC without error: running row keeps edges, never-placed stays NULL.
            assert r["zzcut-notz-run"]["start"] is not None and r["zzcut-notz-run"]["end"] is not None
            assert (r["zzcut-notz-never"]["start"], r["zzcut-notz-never"]["end"]) == (None, None)
            # Every non-queued row is flagged and its updated_at moved.
            for oid, row in r.items():
                if oid == "zzcut-queued":
                    continue
                assert row["mismatch"] is True, oid
                assert str(row["updated_at"]) > OLD, oid
            cur.execute("SELECT count(*) FROM orders WHERE planning_status <> 'needs_planning' AND "
                        "(runtime_schedule_mismatch IS NOT TRUE OR updated_at <= %s)", (OLD,))
            assert cur.fetchone()[0] == 0

            # Ledger: each id exactly once; snapshot counts equal the pre-cutover counts.
            cur.execute("SELECT id, count(*) FROM schema_migrations WHERE id = ANY(%s) GROUP BY id", (list(LEDGER_IDS),))
            assert dict(cur.fetchall()) == {i: 1 for i in LEDGER_IDS}
            for table, expect in zip(SNAP_TABLES, counts):
                cur.execute(f"SELECT count(*) FROM {table}")
                assert cur.fetchone()[0] == expect, table
            # The snapshot holds the PRE-cutover edges of a placed row.
            cur.execute("SELECT scheduled_start, scheduled_end FROM orders_precutover_snapshot WHERE id = 'zzcut-firmed'")
            assert cur.fetchone() == (before["zzcut-firmed"]["start"], before["zzcut-firmed"]["end"])
        finally:
            conn.rollback()

