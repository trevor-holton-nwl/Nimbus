"""Guarded Postgres integration coverage for Excel ingest and purge paths.

These tests require the existing `tests/conftest.py` safety gates:
`@pytest.mark.pg`, `NIMBUS_TEST_DB=1`, and a local/CI Postgres host. All
records use `ZZTEST_*` values and are cleaned before and after each test.
"""
from __future__ import annotations

import datetime as dt
from io import BytesIO
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import uuid

import pandas as pd
import psycopg
import pytest
from psycopg import sql

import db
import master_data as md


_TEST_RUN_TOKEN = uuid.uuid4().hex[:8].upper()
ZZTEST_PLANT = "ZZTEST_P3"
ZZTEST_PLANT_OTHER = "ZZTEST_P4"
ZZTEST_USER = f"zztest.integration+{_TEST_RUN_TOKEN.lower()}@example.com"
ZZTEST_MAT_PARENT = f"ZZTEST_{_TEST_RUN_TOKEN}P"
ZZTEST_MAT_COMPONENT = f"ZZTEST_{_TEST_RUN_TOKEN}C"
ZZTEST_ORDER_NO = f"ZZTEST_INT_ORD_{_TEST_RUN_TOKEN}"
ZZTEST_ORDER_FILENAME = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_orders.xlsx"
ZZTEST_BOM_FILENAME = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_bom.xlsx"
ZZTEST_ORDER_ID = db.make_id(ZZTEST_ORDER_NO, ZZTEST_MAT_PARENT)
ZZTEST_PURGE_BASIC_ID = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_PURGE_BASIC"
ZZTEST_PURGE_SCHEDULED_ID = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_PURGE_SCHEDULED"
ZZTEST_PURGE_KEEP_ID = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_PURGE_KEEP"
ZZTEST_PURGE_OTHER_PLANT_ID = f"ZZTEST_INT_{_TEST_RUN_TOKEN}_PURGE_OTHER_PLANT"
ZZTEST_PURGE_IDS = frozenset({ZZTEST_PURGE_BASIC_ID, ZZTEST_PURGE_SCHEDULED_ID, ZZTEST_PURGE_KEEP_ID,
                              ZZTEST_PURGE_OTHER_PLANT_ID})
ZZTEST_BOM_KEY = (
    ZZTEST_MAT_PARENT,
    ZZTEST_PLANT,
    "1",
    1,
    "10",
    ZZTEST_MAT_COMPONENT,
)


def _xlsx(rows: list[dict]) -> bytes:
    buf = BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


def _connect_pg_database(dbname: str, *, autocommit: bool = False):
    return psycopg.connect(
        host=db.PG_HOST,
        port=db.PG_PORT,
        dbname=dbname,
        user=db.PG_USER,
        password=db.PG_PASS,
        sslmode=db.PG_SSLMODE,
        connect_timeout=5,
        autocommit=autocommit,
    )


def _drop_isolated_database(dbname: str) -> None:
    with _connect_pg_database("postgres", autocommit=True) as conn:
        conn.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(dbname))
        )


def _drop_isolated_database_best_effort(dbname: str, attempts: int = 3) -> bool:
    """Retry scratch cleanup and report failures without raising from teardown."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            _drop_isolated_database(dbname)
            return True
        except Exception as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(0.1)
    print(
        f"WARNING: isolated purge database cleanup failed for {dbname} after "
        f"{attempts} attempts: {last_error}",
        file=sys.stderr,
    )
    return False


def _cleanup_isolated_purge_database(scratch_name, created, scratch_conn, original_pool) -> None:
    """Restore the application pool, close safely, and drop only owned scratch DBs."""
    db._pool = original_pool
    if scratch_conn is not None:
        try:
            scratch_conn.close()
        except Exception as exc:
            print(f"WARNING: isolated purge connection close failed: {exc}", file=sys.stderr)
    if created:
        try:
            _drop_isolated_database_best_effort(scratch_name)
        except Exception as exc:  # pragma: no cover - defensive around cleanup monkeypatches
            print(f"WARNING: isolated purge database cleanup failed for {scratch_name}: {exc}", file=sys.stderr)


@pytest.mark.parametrize("created", [False, True])
def test_isolated_purge_cleanup_drops_only_owned_databases(monkeypatch, capsys, created):
    dropped = []
    original_pool = db._pool

    class Connection:
        def close(self):
            raise RuntimeError("synthetic connection close failure")

    def record_drop(dbname):
        dropped.append(dbname)

    monkeypatch.setattr(sys.modules[__name__], "_drop_isolated_database_best_effort", record_drop)

    _cleanup_isolated_purge_database("nimbus_task3_purge_owned", created, Connection(), original_pool)

    assert db._pool is original_pool
    assert dropped == (["nimbus_task3_purge_owned"] if created else [])
    assert "connection close failed" in capsys.readouterr().err


def test_isolated_purge_drop_retries_and_reports_without_raising(monkeypatch, capsys):
    attempts = []

    def flaky_drop(dbname):
        attempts.append(dbname)
        if len(attempts) < 3:
            raise RuntimeError("synthetic transient drop failure")

    monkeypatch.setattr(sys.modules[__name__], "_drop_isolated_database", flaky_drop)
    monkeypatch.setattr(sys.modules[__name__].time, "sleep", lambda _seconds: None, raising=False)

    assert _drop_isolated_database_best_effort("nimbus_task3_purge_retry") is True
    assert attempts == ["nimbus_task3_purge_retry"] * 3

    def always_fail_drop(_dbname):
        raise RuntimeError("synthetic permanent drop failure")

    monkeypatch.setattr(sys.modules[__name__], "_drop_isolated_database", always_fail_drop)
    assert _drop_isolated_database_best_effort("nimbus_task3_purge_failure") is False
    assert "cleanup failed for nimbus_task3_purge_failure after 3 attempts" in capsys.readouterr().err


@pytest.fixture
def isolated_purge_database(pg):
    """Yield a schema-bootstrapped DB used only by the real purge SQL test.

    The scratch name is unique to this invocation. The fixture temporarily
    routes db.purge_orders_by_date's existing pool lookup to one real psycopg
    connection in that database, eliminating a shared-database TOCTOU window
    without changing production route semantics or SQL.
    """
    del pg  # The fixture dependency is the collection-time local-DB safety gate.
    scratch_name = f"nimbus_task3_purge_{uuid.uuid4().hex[:12]}"
    original_pool = db._pool
    scratch_conn = None
    created = False
    try:
        with _connect_pg_database("postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(scratch_name)))
            created = True

        scratch_conn = _connect_pg_database(scratch_name)
        schema_sql = Path(__file__).resolve().parents[1].joinpath("schema.sql").read_text(encoding="utf-8")
        with scratch_conn.cursor() as cur:
            cur.execute(schema_sql)
        scratch_conn.commit()

        class _ConnectionLease:
            def __enter__(self):
                return scratch_conn

            def __exit__(self, *_args):
                return False

        class _SingleConnectionPool:
            def connection(self):
                return _ConnectionLease()

        db._pool = _SingleConnectionPool()
        yield scratch_conn
    finally:
        _cleanup_isolated_purge_database(scratch_name, created, scratch_conn, original_pool)


def test_fixture_values_fit_material_plant_schema_lengths():
    assert len(ZZTEST_PLANT) <= 10
    assert all(len(material_id) <= 18 for material_id in (ZZTEST_MAT_PARENT, ZZTEST_MAT_COMPONENT))
    assert len("ZZT") <= 3
    assert all(len(version) <= 4 for version in ("PV01", "PV02"))
    assert len("FERT") <= 4
    assert len("EA") <= 3


class _OwnedIntegrationRecords:
    def __init__(self):
        self.order_ids = {ZZTEST_ORDER_ID, *ZZTEST_PURGE_IDS}
        self.upload_batch_ids: set[str] = set()
        self.upload_audit_filenames = {ZZTEST_ORDER_FILENAME}
        self.admin_audit_ids: set[int] = set()


def _cleanup_owned_records(pg, records) -> None:
    """Remove only exact rows created by this module's current run."""
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM bom_items
             WHERE material_id = %s
               AND plant = %s
               AND alternative_bom = %s
               AND level = %s
               AND item_number = %s
               AND component_id = %s
            """,
            ZZTEST_BOM_KEY,
        )
        if records.order_ids:
            order_ids = list(records.order_ids)
            cur.execute(
                "DELETE FROM order_schedule_segments WHERE order_id = ANY(%s)",
                (order_ids,),
            )
            cur.execute("DELETE FROM orders WHERE id = ANY(%s)", (order_ids,))
        if records.upload_batch_ids:
            cur.execute(
                "DELETE FROM upload_audit WHERE batch_id = ANY(%s)",
                (list(records.upload_batch_ids),),
            )
        if records.upload_audit_filenames:
            cur.execute(
                "DELETE FROM upload_audit WHERE filename = ANY(%s)",
                (list(records.upload_audit_filenames),),
            )
        if records.admin_audit_ids:
            cur.execute(
                "DELETE FROM admin_audit WHERE id = ANY(%s)",
                (list(records.admin_audit_ids),),
            )
        for material_id in (ZZTEST_MAT_PARENT, ZZTEST_MAT_COMPONENT):
            cur.execute(
                "DELETE FROM material_plants WHERE material_id = %s AND plant = %s",
                (material_id, ZZTEST_PLANT),
            )
            cur.execute("DELETE FROM materials WHERE material_id = %s", (material_id,))
        conn.commit()


def _admin_audit_max_id(pg) -> int:
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT COALESCE(MAX(id), 0) FROM admin_audit")
        return int(cur.fetchone()[0])


def _capture_bom_audit_rows(pg, records, previous_max_id: int) -> list[int]:
    """Track exact audit IDs created by this ingest for ownership-safe cleanup."""
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id
              FROM admin_audit
             WHERE id > %s
               AND table_name = 'bom_items'
               AND action = 'bulk_apply'
               AND user_email = %s
             ORDER BY id
            """,
            (previous_max_id, ZZTEST_USER),
        )
        audit_ids = [int(row[0]) for row in cur.fetchall()]
    records.admin_audit_ids.update(audit_ids)
    return audit_ids


def _run_bom_ingest_with_capture(pg, records, body, filename, user, audit_floor: int):
    """Run BOM ingest and preserve its exception while capturing owned audits."""
    ingest_error = None
    try:
        result = md.ingest_bom_from_excel(body, filename, user)
    except Exception as exc:
        ingest_error = exc

    try:
        audit_ids = _capture_bom_audit_rows(pg, records, audit_floor)
    except Exception as capture_error:
        if ingest_error is not None:
            print(
                f"WARNING: BOM audit capture failed after ingest failure: {capture_error}",
                file=sys.stderr,
            )
            raise ingest_error from capture_error
        raise

    if ingest_error is not None:
        raise ingest_error
    return result, audit_ids


def _fake_audit_pg(rows=(), error=None):
    executed = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, params=()):
            executed.append((statement, params))
            if error is not None:
                raise error

        def fetchall(self):
            return list(rows)

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def cursor(self):
            return Cursor()

    class Pool:
        def connection(self):
            return Connection()

    return SimpleNamespace(_pool=Pool()), executed


def test_bom_ingest_failure_preserves_original_and_captures_exact_audit_ids(monkeypatch):
    records = SimpleNamespace(admin_audit_ids=set())
    pg, _executed = _fake_audit_pg(rows=[(41,)])

    def fail_ingest(*_args):
        raise ValueError("synthetic BOM ingest failure")

    monkeypatch.setattr(md, "ingest_bom_from_excel", fail_ingest)

    with pytest.raises(ValueError, match="synthetic BOM ingest failure"):
        _run_bom_ingest_with_capture(pg, records, b"body", "file.xlsx", ZZTEST_USER, 40)

    assert records.admin_audit_ids == {41}


def test_bom_audit_capture_failure_does_not_replace_ingest_failure(monkeypatch, capsys):
    records = SimpleNamespace(admin_audit_ids=set())
    pg, _executed = _fake_audit_pg(error=RuntimeError("synthetic audit query failure"))

    def fail_ingest(*_args):
        raise ValueError("synthetic BOM ingest failure")

    monkeypatch.setattr(md, "ingest_bom_from_excel", fail_ingest)

    with pytest.raises(ValueError, match="synthetic BOM ingest failure") as raised:
        _run_bom_ingest_with_capture(pg, records, b"body", "file.xlsx", ZZTEST_USER, 40)

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert "audit capture failed after ingest failure" in capsys.readouterr().err


def test_bom_audit_capture_failure_surfaces_when_ingest_succeeds(monkeypatch):
    records = SimpleNamespace(admin_audit_ids=set())
    pg, _executed = _fake_audit_pg(error=RuntimeError("synthetic audit query failure"))
    monkeypatch.setattr(md, "ingest_bom_from_excel", lambda *_args: {"status": "ok"})

    with pytest.raises(RuntimeError, match="synthetic audit query failure"):
        _run_bom_ingest_with_capture(pg, records, b"body", "file.xlsx", ZZTEST_USER, 40)


@pytest.mark.parametrize("audit_ids", [[], [41, 42]])
def test_bom_audit_capture_tracks_zero_or_multiple_exact_ids(monkeypatch, audit_ids):
    records = SimpleNamespace(admin_audit_ids=set())
    pg, _executed = _fake_audit_pg(rows=[(audit_id,) for audit_id in audit_ids])
    monkeypatch.setattr(md, "ingest_bom_from_excel", lambda *_args: {"status": "ok"})

    result, captured_ids = _run_bom_ingest_with_capture(
        pg, records, b"body", "file.xlsx", ZZTEST_USER, 40
    )

    assert result == {"status": "ok"}
    assert captured_ids == audit_ids
    assert records.admin_audit_ids == set(audit_ids)


def test_cleanup_targets_explicit_keys_only():
    """The guarded fixture must never delete every row at its namespace plant."""
    executed = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, params=()):
            executed.append((statement, params))

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def cursor(self):
            return Cursor()

        def commit(self):
            pass

    class Pool:
        def connection(self):
            return Connection()

    records = SimpleNamespace(
        order_ids={"ZZTEST_INT_owned_order", "ZZTEST_INT_owned_order_2"},
        upload_batch_ids={"owned-batch-1", "owned-batch-2"},
        upload_audit_filenames={"ZZTEST_INT_owned.xlsx", "ZZTEST_INT_owned_2.xlsx"},
        admin_audit_ids={101, 202},
    )

    _cleanup_owned_records(SimpleNamespace(_pool=Pool()), records)

    normalized = [(" ".join(statement.split()).lower(), params) for statement, params in executed]

    def params_for(fragment):
        matches = [params for statement, params in normalized if fragment in statement]
        assert len(matches) == 1, f"expected one cleanup statement containing {fragment!r}"
        return matches[0]

    assert set(params_for("delete from order_schedule_segments where order_id = any(%s)")[0]) == records.order_ids
    assert set(params_for("delete from orders where id = any(%s)")[0]) == records.order_ids
    assert params_for("delete from bom_items") == ZZTEST_BOM_KEY
    assert set(params_for("delete from upload_audit where batch_id = any(%s)")[0]) == records.upload_batch_ids
    assert set(params_for("delete from upload_audit where filename = any(%s)")[0]) == records.upload_audit_filenames
    assert set(params_for("delete from admin_audit where id = any(%s)")[0]) == records.admin_audit_ids
    assert {
        params
        for statement, params in normalized
        if "delete from material_plants" in statement
    } == {
        (ZZTEST_MAT_PARENT, ZZTEST_PLANT),
        (ZZTEST_MAT_COMPONENT, ZZTEST_PLANT),
    }
    assert {
        params
        for statement, params in normalized
        if "delete from materials where material_id = %s" in statement
    } == {(ZZTEST_MAT_PARENT,), (ZZTEST_MAT_COMPONENT,)}
    assert all("where plant = %s" not in statement for statement, _params in normalized)


@pytest.fixture
def zztest_integration_records(pg):
    records = _OwnedIntegrationRecords()
    _cleanup_owned_records(pg, records)
    yield records
    _cleanup_owned_records(pg, records)


def _seed_material_plants(pg):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO materials (material_id, material_description, material_type, base_uom)
            VALUES (%s, %s, 'FERT', 'EA')
            ON CONFLICT (material_id) DO UPDATE SET
                material_description = EXCLUDED.material_description,
                material_type = EXCLUDED.material_type,
                base_uom = EXCLUDED.base_uom,
                updated_at = NOW()
            """,
            [
                (ZZTEST_MAT_PARENT, "ZZTEST parent material"),
                (ZZTEST_MAT_COMPONENT, "ZZTEST component material"),
            ],
        )
        cur.executemany(
            """
            INSERT INTO material_plants
                (material_id, plant, subnetwork, status_pl, default_production_version,
                 min_lot_size, incremental_lot_size, prt_01, prt_02, color)
            VALUES (%s, %s, 'ZZT', '', %s, 0, 0, %s, %s, %s)
            ON CONFLICT (material_id, plant) DO UPDATE SET
                default_production_version = EXCLUDED.default_production_version,
                prt_01 = EXCLUDED.prt_01,
                prt_02 = EXCLUDED.prt_02,
                color = EXCLUDED.color,
                updated_at = NOW()
            """,
            [
                (ZZTEST_MAT_PARENT, ZZTEST_PLANT, "PV01", "TOOL_A", "TOOL_B", "BLUE"),
                (ZZTEST_MAT_COMPONENT, ZZTEST_PLANT, "PV02", "TOOL_C", "TOOL_D", "GREEN"),
            ],
        )
        conn.commit()


@pytest.mark.pg
def test_ingest_orders_from_excel_persists_order_and_stamps_material_attributes(pg, zztest_integration_records):
    """A real orders workbook ingest must persist the order row and stamp
    material_plants attributes for the uploaded plant/material pair."""
    _seed_material_plants(pg)
    order_no = ZZTEST_ORDER_NO
    body = _xlsx([
        {
            "PRODUCTION_ORDER": order_no,
            "MATERIAL_NUMBER": ZZTEST_MAT_PARENT,
            "MATERIAL_DESCRIPTION": "Uploaded parent material",
            "MACHINE": "ZZTEST_INT_MACHINE",
            "PLANT": ZZTEST_PLANT,
            "BASIC_START_DATE": "2026-10-01 08:00",
            "BASIC_FINISH_DATE": "2026-10-01 12:00",
            "RUN_TIME": 4,
            "ORDER_QUANTITY_(GMEIN)": 25,
        }
    ])

    result = db.ingest_orders_from_excel(body, ZZTEST_ORDER_FILENAME)
    zztest_integration_records.upload_batch_ids.add(result["batch_id"])

    assert result["status"] == "ok"
    assert result["raw_row_count"] == 1
    assert result["inserted"] == 1
    assert result["updated"] == 0
    oid = ZZTEST_ORDER_ID
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT production_order, material_number, plant, machine, color,
                   prt_01, prt_02, production_version, order_quantity
              FROM orders
             WHERE id = %s
            """,
            (oid,),
        )
        row = cur.fetchone()
        cur.execute("SELECT filename, row_count, inserted_count FROM upload_audit WHERE batch_id = %s", (result["batch_id"],))
        audit = cur.fetchone()

    assert row == (
        order_no,
        ZZTEST_MAT_PARENT,
        ZZTEST_PLANT,
        "ZZTEST_INT_MACHINE",
        "BLUE",
        "TOOL_A",
        "TOOL_B",
        "PV01",
        25,
    )
    assert audit == (ZZTEST_ORDER_FILENAME, 1, 1)


@pytest.mark.pg
def test_ingest_bom_from_excel_persists_valid_bom_item(pg, zztest_integration_records):
    """A real BOM workbook ingest must accept rows whose parent and component
    both exist in material_plants for the row's plant."""
    _seed_material_plants(pg)
    body = _xlsx([
        {
            "MATERIAL": ZZTEST_MAT_PARENT,
            "PLANT": ZZTEST_PLANT,
            "ALTERNATIVE_BOM": "01",
            "LEVEL": 1,
            "ITEM_NUMBER": "0010",
            "COMPONENT": ZZTEST_MAT_COMPONENT,
            "BASE_QUANTITY": 1,
            "COMPONENT_QUANTITY": 2.5,
            "BASE_UNIT_OF_MEASURE": "EA",
            "VALID_FROM": "2026-01-01",
        }
    ])

    audit_floor = _admin_audit_max_id(pg)
    result, audit_ids = _run_bom_ingest_with_capture(
        pg, zztest_integration_records, body, ZZTEST_BOM_FILENAME, ZZTEST_USER, audit_floor
    )

    assert len(audit_ids) == 1, "BOM ingest must create exactly one owned admin audit row"

    assert result == {
        "status": "ok",
        "raw_row_count": 1,
        "inserted": 1,
        "updated": 0,
        "rejected": 0,
        "warnings": [],
    }
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT material_id, plant, alternative_bom, level, item_number,
                   component_id, base_quantity, component_quantity, base_unit_of_measure
              FROM bom_items
             WHERE material_id = %s AND plant = %s
            """,
            (ZZTEST_MAT_PARENT, ZZTEST_PLANT),
        )
        row = cur.fetchone()

    assert row == (
        ZZTEST_MAT_PARENT,
        ZZTEST_PLANT,
        "1",
        1,
        "10",
        ZZTEST_MAT_COMPONENT,
        1,
        2.5,
        "EA",
    )


@pytest.mark.pg
def test_purge_orders_by_date_deletes_only_in_range_effective_end_dates(isolated_purge_database):
    """The real purge SQL runs in an isolated scratch DB with no TOCTOU window.
    Also proves plant scoping: an order in ZZTEST_PLANT_OTHER with an end date
    in the same range must survive a purge of ZZTEST_PLANT."""
    conn = isolated_purge_database
    start = dt.datetime(2026, 11, 1, 0, 0)
    end = dt.datetime(2026, 11, 30, 23, 59)
    rows = [
        (
            ZZTEST_PURGE_BASIC_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_BASIC",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_BASIC",
            ZZTEST_PLANT,
            dt.datetime(2026, 11, 5, 8, 0),
            dt.datetime(2026, 11, 5, 12, 0),
            None,
            None,
        ),
        (
            ZZTEST_PURGE_SCHEDULED_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_SCHEDULED",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_SCHEDULED",
            ZZTEST_PLANT,
            dt.datetime(2026, 12, 5, 8, 0),
            dt.datetime(2026, 12, 5, 12, 0),
            dt.datetime(2026, 11, 6, 8, 0),
            dt.datetime(2026, 11, 6, 12, 0),
        ),
        (
            ZZTEST_PURGE_KEEP_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_KEEP",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_KEEP",
            ZZTEST_PLANT,
            dt.datetime(2026, 12, 6, 8, 0),
            dt.datetime(2026, 12, 6, 12, 0),
            None,
            None,
        ),
        (
            ZZTEST_PURGE_OTHER_PLANT_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_OTHER_PLANT",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_OTHER_PLANT",
            ZZTEST_PLANT_OTHER,
            dt.datetime(2026, 11, 5, 8, 0),
            dt.datetime(2026, 11, 5, 12, 0),
            None,
            None,
        ),
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO orders
                (id, production_order, material_number, plant, basic_start_date,
                 basic_finish_date, scheduled_start, scheduled_end)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
        conn.commit()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id
              FROM orders
             WHERE plant = %s
               AND COALESCE(scheduled_end, basic_finish_date) BETWEEN %s AND %s
             ORDER BY id
            """,
            (ZZTEST_PLANT, start, end),
        )
        matched_ids = [r[0] for r in cur.fetchall()]

    assert all(order_id.startswith("ZZTEST_INT_") for order_id in matched_ids), (
        "Refusing to exercise a purge on a date range containing non-test orders"
    )
    expected_purge_ids = sorted([ZZTEST_PURGE_BASIC_ID, ZZTEST_PURGE_SCHEDULED_ID])
    assert matched_ids == expected_purge_ids

    result = db.purge_orders_by_date(ZZTEST_PLANT, start, end, user_email=ZZTEST_USER)

    assert result == {"status": "ok", "deleted": 2, "plant": ZZTEST_PLANT, "machines": []}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM orders WHERE id = ANY(%s) ORDER BY id",
            (list(ZZTEST_PURGE_IDS),),
        )
        remaining = [r[0] for r in cur.fetchall()]

    assert remaining == sorted([ZZTEST_PURGE_KEEP_ID, ZZTEST_PURGE_OTHER_PLANT_ID])

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT details, user_email FROM admin_audit
             WHERE table_name = 'orders' AND action = 'purge_by_date_range'
             ORDER BY id DESC LIMIT 1
            """
        )
        audit_row = cur.fetchone()

    assert audit_row is not None, "purge must write a durable admin_audit row"
    details, user_email = audit_row
    assert details["plant"] == ZZTEST_PLANT
    assert details["deleted"] == 2
    assert sorted(details["order_ids"]) == expected_purge_ids
    assert user_email == ZZTEST_USER


@pytest.mark.pg
def test_purge_preview_matches_delete_count(isolated_purge_database):
    """Regression guard for the original defect: the preview and the real
    delete must agree exactly on how many rows are in scope, because they now
    share one selector fragment (db._purge_scope_sql_params). This is the one
    test that would have caught a client-side preview count silently
    diverging from the server-side DELETE."""
    conn = isolated_purge_database
    start = dt.datetime(2026, 11, 1, 0, 0)
    end = dt.datetime(2026, 11, 30, 23, 59)
    rows = [
        (
            ZZTEST_PURGE_BASIC_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_BASIC",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_BASIC",
            ZZTEST_PLANT,
            dt.datetime(2026, 11, 5, 8, 0),
            dt.datetime(2026, 11, 5, 12, 0),
            dt.datetime(2026, 11, 5, 8, 0),
            None,
        ),
        (
            ZZTEST_PURGE_KEEP_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_KEEP",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_KEEP",
            ZZTEST_PLANT,
            dt.datetime(2026, 12, 6, 8, 0),
            dt.datetime(2026, 12, 6, 12, 0),
            None,
            None,
        ),
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO orders
                (id, production_order, material_number, plant, basic_start_date,
                 basic_finish_date, scheduled_start, scheduled_end)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
        conn.commit()

    preview = db.preview_purge_orders(ZZTEST_PLANT, start, end)
    result = db.purge_orders_by_date(ZZTEST_PLANT, start, end)

    assert preview["total"] == result["deleted"] == 1
    assert preview["planner_overridden"] == 1  # ZZTEST_PURGE_BASIC_ID has scheduled_start set
