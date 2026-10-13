"""Batched save efficiency and transaction boundaries at one large plant.

2,100 orders = 30 daily orders on each of 70 machines. SQL is observed while
still executed by PostgreSQL. Assertions constrain database round trips rather
than comparing elapsed time on developer/CI machines.
"""

from datetime import datetime, timedelta
from math import ceil

import psycopg
import pytest

from tests.support.scale_catalog_sql import RecordingPool

pytest_plugins = ("tests.support.planning_pg",)
pytestmark = pytest.mark.pg


@pytest.fixture
def schedule(planning_pg):
    c = planning_pg
    c.start = datetime(2031, 1, 6, 8)
    c.ids = [f"{c.subnet}_BATCH_{i:04}" for i in range(2100)]
    try:
        with c.db._pool.connection() as conn, conn.cursor() as cur:
            cur.executemany("INSERT INTO machine(subnetwork,plant,machine) VALUES (%s,%s,%s)",
                            [(c.subnet, c.plant, f"M{i:02}") for i in range(70)])
            cur.executemany(
                "INSERT INTO orders(id,production_order,material_number,plant,machine,"
                " basic_start_date,basic_finish_date,scheduled_start,scheduled_end,run_time,prt_01)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,'ORIGINAL_TOOL')",
                [(oid, oid, f"ZZTEST_M{i:04}", c.plant, f"M{i % 70:02}",
                  c.start + timedelta(days=i // 70), c.start + timedelta(days=i // 70, hours=1),
                  c.start + timedelta(days=i // 70), c.start + timedelta(days=i // 70, hours=1))
                 for i, oid in enumerate(c.ids)],
            )
        c.initial = rows(c)
        yield c
    finally:
        with c.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id=ANY(%s)", (c.ids,))


def rows(c):
    return {row["id"]: row for row in c.db.get_task_versions(c.ids)}


def updates(recorder):
    return [(sql, params) for sql, params in recorder.calls if sql.startswith("UPDATE orders o SET")]


@pytest.mark.parametrize("count", [70, 500, 501, 2100])
def test_large_firm_selection_uses_bounded_update_batches_and_returns_every_version(schedule, monkeypatch, count):
    c = schedule
    recorder = RecordingPool(c.db._pool)
    monkeypatch.setattr(c.db, "_pool", recorder)
    items = [{"id": oid, "FIRMED": True, "base_version": c.initial[oid]["row_version"]} for oid in c.ids[:count]]
    result = c.db.update_task_dates_bulk(items, allowed_plants=[c.plant])
    assert result["persisted"] == count
    assert result["stale"] == [] and result["invalid_ids"] == [] and result["not_found_ids"] == []
    assert set(result["versions"]) == set(c.ids[:count])
    writes = updates(recorder)
    # 500 rows is the current batching contract; an implementation using fewer
    # round trips is welcome, an UPDATE per order is a regression.
    assert 1 <= len(writes) <= ceil(count / 500)
    touched = [value for _, params in writes for value in params if isinstance(value, str) and value in c.initial]
    assert sorted(touched) == sorted(c.ids[:count])
    locks = [sql for sql, _ in recorder.calls if "FOR UPDATE OF o" in sql]
    assert len(locks) == 1, "all optimistic versions should be locked and read together"
    current = rows(c)
    for oid in c.ids[:count]:
        expected = {**c.initial[oid], "firmed": True, "row_version": result["versions"][oid]}
        assert current[oid] == expected
        assert current[oid]["row_version"] != c.initial[oid]["row_version"]
    for oid in c.ids[count:]:
        assert current[oid] == c.initial[oid], "orders outside the bulk selection must be untouched"


def test_mixed_save_shapes_batch_independently_without_clearing_omitted_columns(schedule, monkeypatch):
    c = schedule
    recorder = RecordingPool(c.db._pool)
    monkeypatch.setattr(c.db, "_pool", recorder)
    items = []
    for i, oid in enumerate(c.ids):
        item = {"id": oid, "base_version": c.initial[oid]["row_version"]}
        if i % 3 == 0:
            item["FIRMED"] = True
        elif i % 3 == 1:
            item["PRT_01"] = "NEW_TOOL"
        else:
            item["PRT_02"] = "SECOND_TOOL"
        items.append(item)
    result = c.db.update_task_dates_bulk(items, allowed_plants=[c.plant], atomic_optimizer=True)
    assert result["persisted"] == 2100 and len(result["versions"]) == 2100
    assert len(updates(recorder)) <= 6, "three SET shapes need at most two 500-row writes each"
    current = rows(c)
    for i, oid in enumerate(c.ids):
        expected = {**c.initial[oid], "row_version": result["versions"][oid]}
        expected.update([{"firmed": True}, {"PRT_01": "NEW_TOOL"}, {"PRT_02": "SECOND_TOOL"}][i % 3])
        assert current[oid] == expected


def test_stale_order_beyond_first_chunk_prevents_every_atomic_write(schedule, monkeypatch):
    c = schedule
    peer_id = c.ids[1000]
    peer = c.db.update_task_dates_bulk([
        {"id": peer_id, "PRT_01": "PEER_TOOL", "base_version": c.initial[peer_id]["row_version"]},
    ], allowed_plants=[c.plant])
    assert peer["persisted"] == 1
    before = rows(c)
    recorder = RecordingPool(c.db._pool)
    monkeypatch.setattr(c.db, "_pool", recorder)
    result = c.db.update_task_dates_bulk([
        {"id": oid, "FIRMED": True, "base_version": c.initial[oid]["row_version"]} for oid in c.ids
    ], allowed_plants=[c.plant], atomic_optimizer=True)
    assert result["persisted"] == 0 and result["stale"] == [peer_id]
    assert result["versions"] == {} and updates(recorder) == []
    assert rows(c) == before


def test_statement_timeout_on_second_chunk_rolls_back_first_chunk_and_keeps_pool_usable(schedule, monkeypatch):
    c = schedule
    original_execute = psycopg.Cursor.execute
    update_calls = 0

    def execute(cursor, query, params=None, **kwargs):
        nonlocal update_calls
        if isinstance(query, str) and query.startswith("UPDATE orders o SET"):
            update_calls += 1
            if update_calls == 2:
                # Produce PostgreSQL's genuine statement-timeout failure after
                # the first chunk has written. This models the configured
                # production statement timeout without waiting 30 seconds.
                original_execute(cursor, "SET LOCAL statement_timeout = '1ms'")
                original_execute(cursor, "SELECT pg_sleep(0.1)")
        return original_execute(cursor, query, params, **kwargs)

    items = [{"id": oid, "FIRMED": True, "base_version": c.initial[oid]["row_version"]} for oid in c.ids[:1001]]
    with monkeypatch.context() as patch:
        patch.setattr(psycopg.Cursor, "execute", execute)
        with pytest.raises(psycopg.errors.QueryCanceled, match="statement timeout"):
            c.db.update_task_dates_bulk(items, allowed_plants=[c.plant], atomic_optimizer=True)
    assert update_calls == 2
    assert rows(c) == c.initial, "a later SQL timeout cannot commit the earlier 500 rows"
    retried = c.db.update_task_dates_bulk(items, allowed_plants=[c.plant], atomic_optimizer=True)
    assert retried["persisted"] == 1001 and len(retried["versions"]) == 1001
