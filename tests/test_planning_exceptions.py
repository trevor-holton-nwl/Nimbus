from datetime import datetime, timedelta
from contextlib import contextmanager
from uuid import uuid4
import pytest
from backend.scheduling.models import TaskDTO, TaskDateUpdate
from backend.scheduling.routes import _apply_task_date_updates
import db


def test_queued_dto_keeps_null_dates_and_reason():
    row = TaskDTO(id='q', text='q', start_date=None, end_date=None, user_scheduled=False,
                  MACHINE='m', MATERIAL_DESCRIPTION='q', ecc_firmed=False,
                  planning_status='needs_planning', planning_reason={'code': 'no_fit_found', 'message': 'Full'})
    assert row.model_dump()['planning_status'] == 'needs_planning'


def test_atomic_normalization_rejects_entire_batch(monkeypatch):
    calls = []
    monkeypatch.setattr(db, 'update_task_dates_bulk', lambda *a, **k: calls.append(a))
    result = _apply_task_date_updates([
        TaskDateUpdate(id='ok', start_date='2026-09-09T08:00:00', base_version=1),
        TaskDateUpdate(id='bad', schedule_segments=None, base_version=1),
    ], atomic_optimizer=True)
    assert result['persisted'] == 0
    assert result['invalid_ids'] == ['bad']
    assert calls == []


@pytest.mark.parametrize('rejection', ['stale', 'missing_version', 'invalid', 'not_found'])
def test_atomic_db_validation_writes_nothing(monkeypatch, rejection):
    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def execute(self, sql, params=None):
            assert not sql.lstrip().startswith(('UPDATE', 'DELETE', 'INSERT'))
        def fetchall(self):
            return [(i, datetime(2026,9,9,8), datetime(2026,9,9,12), 4, 42, 0, 'p', 'L1', 'scheduled', None, False, None,
                      None, None, None, None, None, None, None) for i in ['a','b']]
    class Connection:
        def cursor(self): return Cursor()
        def rollback(self): pass
    class Pool:
        @contextmanager
        def connection(self): yield Connection()
    monkeypatch.setattr(db, '_pool', Pool())
    monkeypatch.setattr(db, '_min_segment_minutes_by_plant', lambda *a: {})
    good = dict(id='a', start=datetime(2026,9,9,9), base_version=42)
    bad = dict(id='b', start=datetime(2026,9,9,9), base_version=42, force=True)
    if rejection == 'stale':
        bad['base_version'] = 41
    if rejection == 'missing_version':
        bad.pop('base_version')
    if rejection == 'invalid':
        bad['end'] = datetime(2026,9,9,7)
    if rejection == 'not_found':
        bad['id'] = 'unknown'
    result = db.update_task_dates_bulk([good,bad], atomic_optimizer=True)
    assert result['persisted'] == 0
    assert result['versions'] == {}
    assert result['stale'] or result['invalid_ids'] or result['not_found_ids']

def test_queue_write_clears_parent_and_children_without_baseline_mutation(monkeypatch):
    statements = []
    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def execute(self, sql, params=None): statements.append((sql, params))  # batched UPDATE ... RETURNING (#26) yields (id, xmin) pairs
        def fetchall(self):
            if statements and statements[-1][0].startswith('UPDATE'):
                return [('q', 43)]
            return [('q', datetime(2026,9,9,8), datetime(2026,9,9,12), 4, 42, 2, 'p', 'L1', 'scheduled', None, False, None,
                                      None, None, None, None, None, None, None)]
        def fetchone(self): return ('q', 43)
    class Connection:
        def cursor(self): return Cursor()
        def commit(self): pass
    class Pool:
        @contextmanager
        def connection(self): yield Connection()
    monkeypatch.setattr(db, '_pool', Pool())
    monkeypatch.setattr(db, '_min_segment_minutes_by_plant', lambda *a: {})
    result = _apply_task_date_updates([TaskDateUpdate(
        id='q', planning_status='needs_planning', planning_reason={'code':'no_fit_found','message':'Full'},
        start_date=None, end_date=None, schedule_segments=[], base_version=42,
    )], atomic_optimizer=True)
    assert result['persisted'] == 1
    update = next(sql for sql, _ in statements if sql.startswith('UPDATE'))
    assert 'scheduled_start = NULL' in update and 'scheduled_end = NULL' in update
    assert 'basic_start_date' not in update and 'basic_finish_date' not in update
    assert any(sql.startswith('DELETE FROM order_schedule_segments') for sql, _ in statements)
    # A queued order has no bar, so the same write nulls its placement marker (never a parameter).
    assert 'placement_exception = NULL' in update


def test_queue_write_ignores_a_marker_sent_with_it(monkeypatch):
    """A save that queues a row and also carries a marker writes the NULL, never the marker, and does not
    assign the column twice (Postgres rejects `SET a = .., a = ..`)."""
    statements = []
    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def execute(self, sql, params=None): statements.append((sql, params))
        def fetchall(self):
            if statements and statements[-1][0].startswith('UPDATE'):
                return [('q', 43)]
            return [('q', datetime(2026,9,9,8), datetime(2026,9,9,12), 4, 42, 0, 'p', 'L1', 'scheduled', None, False, None,
                     None, None, None, None, None, 'overtime', None)]
        def fetchone(self): return ('q', 43)
    class Connection:
        def cursor(self): return Cursor()
        def commit(self): pass
    class Pool:
        @contextmanager
        def connection(self): yield Connection()
    monkeypatch.setattr(db, '_pool', Pool())
    monkeypatch.setattr(db, '_min_segment_minutes_by_plant', lambda *a: {})
    result = db.update_task_dates_bulk([dict(
        id='q', planning_status='needs_planning', planning_reason=dict(code='no_fit_found', message='Full'),
        placement_exception='overlong', base_version=42)])
    assert result['persisted'] == 1
    update = next(sql for sql, _ in statements if sql.startswith('UPDATE'))
    assert update.count('placement_exception') == 1 and 'placement_exception = NULL' in update


def test_ingest_does_not_overwrite_planning_state():
    update = db._UPSERT_SQL.split('DO UPDATE SET')[1]
    assert 'planning_status =' not in update
    assert 'planning_reason =' not in update


@pytest.mark.pg
def test_real_queue_reload_ingest_and_retry(pg):
    from pathlib import Path
    oid = 'ZZTEST_PLANNING_QUEUE'
    batch_id = str(uuid4())
    start = datetime.now().replace(microsecond=0) + timedelta(days=60)
    end = start + timedelta(hours=4)
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(Path('migrations/2026-09-09_optimizer_planning_exceptions.sql').read_text())
        cur.execute('DELETE FROM orders WHERE id=%s', (oid,))
        cur.execute("INSERT INTO subnetworks (code, name) VALUES ('ZZTEST', 'Queue test') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (plant, subnetwork, visibility_horizon_days) VALUES ('ZZTEST_PLANT', 'ZZTEST', 1) "
                    "ON CONFLICT (subnetwork, plant) DO UPDATE SET visibility_horizon_days=1")
        cur.execute('INSERT INTO orders (id, production_order, material_number, machine, plant, '
                    'basic_start_date, basic_finish_date, run_time) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                    (oid, oid, 'ZZTEST_MATERIAL', 'ZZTEST_LINE', 'ZZTEST_PLANT', start, end, 4))
        conn.commit()
    try:
        version = pg.get_task_versions([oid])[0]['row_version']
        assert pg.update_task_dates_bulk([dict(id=oid, planning_status='needs_planning',
            planning_reason=dict(code='no_fit_found', message='Full'), base_version=version)],
            atomic_optimizer=True)['persisted'] == 1
        queued = pg.get_task_versions([oid])[0]
        assert queued['start_date'] is None and queued['end_date'] is None
        assert queued['planning_status'] == 'needs_planning'
        imported = pg.upsert_orders([dict(id=oid, production_order=oid, material_number='ZZTEST_MATERIAL',
            machine='ZZTEST_LINE', plant='ZZTEST_PLANT', basic_start_date=start,
            basic_finish_date=end, run_time=4)], source='sap', batch_id=batch_id)
        assert imported['failed'] == 0
        queued = pg.get_task_versions([oid])[0]
        assert queued['planning_status'] == 'needs_planning'
        assert queued['start_date'] is None and queued['end_date'] is None
        assert queued['schedule_segments'] == []
        frame, horizon, _ = pg.query_orders(plant='ZZTEST_PLANT', line='ZZTEST_LINE', limit=1, offset=0)
        assert horizon < start
        assert oid in frame['id'].tolist()
        assert pg.count_orders(plant='ZZTEST_PLANT', line='ZZTEST_LINE') == 1
        assert pg.query_orders(plant='ZZTEST_PLANT', limit=1, offset=1)[0].empty
        assert pg.query_orders(plant='ZZTEST_PLANT', allowed_plants=['OTHER'])[0].empty
        assert pg.update_task_dates_bulk([dict(id=oid, start=start, end=end, base_version=queued['row_version'])],
                                        atomic_optimizer=True)['persisted'] == 1
        scheduled = pg.get_task_versions([oid])[0]
        assert scheduled['planning_status'] == 'scheduled' and scheduled['planning_reason'] is None
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('DELETE FROM orders WHERE id=%s', (oid,))
            cur.execute('DELETE FROM upload_audit WHERE batch_id=%s', (batch_id,))
            cur.execute("DELETE FROM plants WHERE plant='ZZTEST_PLANT'")
            cur.execute("DELETE FROM subnetworks WHERE code='ZZTEST'")
            conn.commit()


@pytest.mark.pg
def test_atomic_real_write_error_rolls_back_prior_order(pg):
    ids = ['ZZTEST_ATOMIC_A', 'ZZTEST_ATOMIC_B']
    start, end = datetime(2026, 9, 9, 8), datetime(2026, 9, 9, 12)
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for oid in ids:
            cur.execute('INSERT INTO orders (id, production_order, material_number, basic_start_date, '
                        'basic_finish_date, run_time) VALUES (%s,%s,%s,%s,%s,4)',
                        (oid, oid, 'ZZTEST_MATERIAL', start, end))
        cur.execute("CREATE FUNCTION zztest_reject_atomic_b() RETURNS trigger LANGUAGE plpgsql AS $$ "
                    "BEGIN IF NEW.id = 'ZZTEST_ATOMIC_B' THEN RAISE EXCEPTION 'injected rejection'; "
                    "END IF; RETURN NEW; END $$")
        cur.execute('CREATE TRIGGER zztest_reject_atomic_b BEFORE UPDATE ON orders '
                    'FOR EACH ROW EXECUTE FUNCTION zztest_reject_atomic_b()')
        conn.commit()
    try:
        before = {row['id']: row for row in pg.get_task_versions(ids)}
        result = _apply_task_date_updates([TaskDateUpdate(id=oid, start_date=(start + timedelta(hours=1)).isoformat(),
            end_date=(end + timedelta(hours=1)).isoformat(), base_version=before[oid]['row_version']) for oid in ids],
            atomic_optimizer=True)
        assert result['persisted'] == 0
        assert result['versions'] == {}
        assert {row['id']: row for row in pg.get_task_versions(ids)} == before
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('DROP TRIGGER zztest_reject_atomic_b ON orders')
            cur.execute('DROP FUNCTION zztest_reject_atomic_b()')
            cur.execute('DELETE FROM orders WHERE id = ANY(%s)', (ids,))
            conn.commit()


@pytest.mark.pg
def test_queued_rows_null_the_placement_marker_and_the_stale_flag(pg):
    """Every queue write drops the marker: the optimizer's queue save, and (via the same save) a planner's Delete."""
    oid = 'ZZTEST_PE_QUEUE'
    start = datetime(2026, 6, 1, 8)
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute('DELETE FROM orders WHERE id=%s', (oid,))
        cur.execute('INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,'
                    ' basic_finish_date, scheduled_start, scheduled_end, run_time, runtime_schedule_mismatch,'
                    ' placement_exception) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,4,TRUE,%s)',
                    (oid, oid, 'ZZTEST_PE_MAT', 'ZZTEST_PE_LINE', 'ZZTEST_PE_PLANT', start, start + timedelta(hours=7),
                     start, start + timedelta(hours=7), 'overtime'))
        conn.commit()
    try:
        version = pg.get_task_versions([oid])[0]['row_version']
        assert pg.get_task_versions([oid])[0]['placement_exception'] == 'overtime'
        res = pg.update_task_dates_bulk([dict(id=oid, planning_status='needs_planning', base_version=version,
            planning_reason=dict(code='planner_unscheduled', message='Unscheduled by planner'))])
        assert res['persisted'] == 1
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('SELECT planning_status, scheduled_start, scheduled_end, placement_exception,'
                        ' runtime_schedule_mismatch FROM orders WHERE id=%s', (oid,))
            assert cur.fetchone() == ('needs_planning', None, None, None, False)
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute('DELETE FROM orders WHERE id=%s', (oid,))
            conn.commit()
