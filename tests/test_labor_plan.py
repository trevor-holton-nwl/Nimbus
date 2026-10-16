"""Labor writes: one transaction across aggregate, derived cells and audit records."""
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import master_data as md
from backend.labor.routes import router
from backend.security import auth


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[auth.require_authenticated] = lambda: 'audit@example.com'
    app.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ['P']
    return TestClient(app)


def test_batch_rejects_other_plant(client):
    assert client.post('/labor-plan/batch', json={'plant': 'OTHER'}).status_code == 403


def test_batch_passes_both_sets_to_transaction(client, monkeypatch):
    seen = []
    monkeypatch.setattr(md, 'upsert_labor_plan_batch', lambda **kw: seen.append(kw) or {'ok': True})
    payload = {'subnetwork': 'S', 'plant': 'P', 'cells': [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': 70}],
               'line_cells': [{'machine': 'L', 'day': '2026-10-12', 'avail_hours': 10, 'source': 'auto_split'}]}
    assert client.post('/labor-plan/batch', json=payload).status_code == 200
    assert seen[0]['cells'] == payload['cells']
    assert seen[0]['line_cells'] == payload['line_cells']


@pytest.mark.pg
def test_batch_rolls_back_aggregate_when_line_statement_fails(monkeypatch):
    key = 'LAB_' + uuid.uuid4().hex[:12]
    with md._pool.connection() as conn, conn.cursor() as cur:
        cur.execute('INSERT INTO subnetworks (code, name) VALUES (%s, %s)', (key, key))
        cur.execute('INSERT INTO plants (subnetwork, plant) VALUES (%s, %s)', (key, key))
    try:
        original = md._write_labor_plan_machine
        def failing_line_write(cur, *args, **kwargs):
            original(cur, *args, **kwargs)
            cur.execute('SELECT 1 / 0')
        monkeypatch.setattr(md, '_write_labor_plan_machine', failing_line_write)
        with pytest.raises(Exception, match='division by zero'):
            md.upsert_labor_plan_batch(key, key,
                [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': 70}],
                [{'machine': 'L', 'day': '2026-10-12', 'avail_hours': 10, 'source': 'auto_split'}])
        assert md.load_labor_plan(key)['rows'] == []
        assert md.load_labor_plan_machine(key)['rows'] == []
        monkeypatch.setattr(md, '_write_labor_plan_machine', original)
        md.upsert_labor_plan_batch(key, key,
            [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': 70}],
            [{'machine': 'L', 'day': '2026-10-12', 'avail_hours': 10, 'source': 'auto_split'}])
        assert md.load_labor_plan(key)['rows'][0]['avail_hours'] == 70
        assert md.load_labor_plan_machine(key)['rows'][0]['avail_hours'] == 10
    finally:
        with md._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('DELETE FROM labor_plan_machine WHERE plant=%s', (key,))
            cur.execute('DELETE FROM subnetworks WHERE code=%s', (key,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant'=%s", (key,))


@pytest.mark.parametrize('hours', [-1, 'NaN', 'Infinity', 'invalid'])
def test_rejects_invalid_hours_before_writing(hours):
    with pytest.raises(ValueError):
        md.upsert_labor_plan_batch('S', 'P', [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': hours}], [])


@pytest.fixture
def labor_plant():
    key = 'LAB_' + uuid.uuid4().hex[:12]
    with md._pool.connection() as conn, conn.cursor() as cur:
        cur.execute('INSERT INTO subnetworks (code, name) VALUES (%s, %s)', (key, key))
        cur.execute('INSERT INTO plants (subnetwork, plant) VALUES (%s, %s)', (key, key))
    try:
        yield key
    finally:
        with md._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('DELETE FROM labor_plan_machine WHERE plant=%s', (key,))
            cur.execute('DELETE FROM subnetworks WHERE code=%s', (key,))
            cur.execute("DELETE FROM admin_audit WHERE details->>'plant'=%s", (key,))


@pytest.mark.pg
@pytest.mark.parametrize('hours', [10, None], ids=['automatic-upsert', 'automatic-clear'])
@pytest.mark.parametrize('initial', [False, True], ids=['read-absent', 'read-automatic'])
def test_reconciliation_preserves_pin_committed_after_client_read(labor_plant, hours, initial):
    plant = labor_plant
    # A read before B pinned this cell. Its subsequent payload still says auto_split.
    cell = {'machine': 'L', 'day': '2026-10-12', 'avail_hours': 8, 'source': 'auto_split'}
    if initial:
        md.upsert_labor_plan_machine(plant, plant, [cell])
        assert md.load_labor_plan_machine(plant)['rows'][0]['source'] == 'auto_split'
    else:
        assert md.load_labor_plan_machine(plant)['rows'] == []
    pin = {**cell, 'avail_hours': 3, 'source': 'override'}
    md.upsert_labor_plan_machine(plant, plant, [pin])
    result = md.upsert_labor_plan_batch(plant, plant,
        [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': None if hours is None else 70}],
        [{**cell, 'avail_hours': hours}])
    assert md.load_labor_plan_machine(plant)['rows'] == [pin]
    assert result['lines']['rows'] == [pin]
    assert result['lines']['skipped'] == [pin]
    assert result['lines']['applied'] == []
    assert result['lines']['upserted'] == result['lines']['deleted'] == 0


@pytest.mark.pg
@pytest.mark.parametrize('reset_hours', [10, None], ids=['reset-split', 'reset-calendar'])
def test_explicit_reset_and_undo_intentionally_replace_pin(labor_plant, reset_hours):
    plant = labor_plant
    pin = {'machine': 'L', 'day': '2026-10-12', 'avail_hours': 3, 'source': 'override'}
    md.upsert_labor_plan_machine(plant, plant, [pin])
    reset = {**pin, 'avail_hours': reset_hours, 'source': 'auto_split'}
    result = md.upsert_labor_plan_batch(plant, plant, [], [reset], intent='explicit')
    assert result['lines']['rows'] == [reset]
    assert result['lines']['skipped'] == []
    assert md.load_labor_plan_machine(plant)['rows'] == ([] if reset_hours is None else [reset])
    undo = md.upsert_labor_plan_batch(plant, plant, [], [pin], intent='undo')
    assert undo['lines']['rows'] == [pin]
    assert md.load_labor_plan_machine(plant)['rows'] == [pin]


@pytest.mark.pg
@pytest.mark.parametrize('initial,hours', [(False, 10), (True, 10), (True, None)],
                         ids=['concurrent-insert', 'concurrent-update', 'concurrent-delete'])
def test_conditional_reconciliation_rechecks_pin_after_lock_wait(labor_plant, monkeypatch, initial, hours):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from time import monotonic, sleep

    plant = labor_plant
    cell = {'machine': 'L', 'day': '2026-10-12', 'avail_hours': 8, 'source': 'auto_split'}
    if initial:
        md.upsert_labor_plan_machine(plant, plant, [cell])
    started = Event()
    worker = {}
    original = md._write_labor_plan_machine

    def observed_write(cur, *args, **kwargs):
        worker['pid'] = cur.connection.info.backend_pid
        started.set()
        return original(cur, *args, **kwargs)

    monkeypatch.setattr(md, '_write_labor_plan_machine', observed_write)
    # Client B holds an uncommitted pin. Client A must actually wait on this row,
    # then recheck the conditional mutation against B's newly committed override.
    with md._pool.connection() as pin_conn, pin_conn.cursor() as pin_cur:
        pin_cur.execute(
            "INSERT INTO labor_plan_machine (subnetwork,plant,machine,day,avail_hours,source)"
            " VALUES (%s,%s,'L','2026-10-12',3,'override')"
            " ON CONFLICT (subnetwork,plant,machine,day) DO UPDATE SET avail_hours=3,source='override'",
            (plant, plant),
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(md.upsert_labor_plan_batch, plant, plant,
                [{'wc_group': 'G', 'period': '2026-W42', 'avail_hours': None if hours is None else 70}],
                [{**cell, 'avail_hours': hours}])
            try:
                assert started.wait(5), 'client A reached the line mutation'
                deadline = monotonic() + 5
                blocked = False
                while monotonic() < deadline:
                    pin_cur.execute('SELECT %s = ANY(pg_blocking_pids(%s))',
                                    (pin_conn.info.backend_pid, worker['pid']))
                    blocked = pin_cur.fetchone()[0]
                    if blocked:
                        break
                    sleep(0.01)
                assert blocked, 'verified real row-lock overlap, not merely sequential transactions'
            finally:
                pin_conn.commit()
            result = pending.result(timeout=5)
    pin = {**cell, 'avail_hours': 3, 'source': 'override'}
    assert result['lines']['rows'] == result['lines']['skipped'] == [pin]
    assert result['lines']['applied'] == []
    assert result['lines']['upserted'] == result['lines']['deleted'] == 0
    assert md.load_labor_plan_machine(plant)['rows'] == [pin]
    with md._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT details FROM admin_audit WHERE table_name='labor_plan_machine'"
                    " AND details->>'plant'=%s AND details->>'intent'='reconcile' ORDER BY id DESC LIMIT 1",
                    (plant,))
        audit = cur.fetchone()[0]
    assert audit['upserted'] == audit['deleted'] == 0
    assert audit['preserved_overrides'] == 1
