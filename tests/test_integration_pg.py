"""Guarded Postgres integration coverage for Excel ingest and purge paths.

These tests require the existing `tests/conftest.py` safety gates:
`@pytest.mark.pg`, `NIMBUS_TEST_DB=1`, and a local/CI Postgres host. All
records use `ZZTEST_*` values and are cleaned before and after each test.
"""
from __future__ import annotations

import datetime as dt
from io import BytesIO
from types import SimpleNamespace
import uuid

import pandas as pd
import pytest

import db
import master_data as md


_TEST_RUN_TOKEN = uuid.uuid4().hex[:8].upper()
ZZTEST_PLANT = "ZZTEST_P3"
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
ZZTEST_PURGE_IDS = frozenset({ZZTEST_PURGE_BASIC_ID, ZZTEST_PURGE_SCHEDULED_ID, ZZTEST_PURGE_KEEP_ID})
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
        cur.execute(
            """
            DELETE FROM admin_audit
             WHERE table_name = 'bom_items'
               AND action = 'bulk_apply'
               AND user_email = %s
               AND details @> '{"inserted": 1, "updated": 0, "deleted": 0}'::jsonb
            """,
            (ZZTEST_USER,),
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


def _record_bom_audit_rows(pg, records, previous_max_id: int) -> None:
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
    assert len(audit_ids) == 1, "BOM ingest must create exactly one owned admin audit row"
    records.admin_audit_ids.update(audit_ids)


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
        order_ids={"ZZTEST_INT_owned_order"},
        upload_batch_ids=set(),
        upload_audit_filenames={"ZZTEST_INT_owned.xlsx"},
        admin_audit_ids=set(),
    )

    _cleanup_owned_records(SimpleNamespace(_pool=Pool()), records)

    statements = [" ".join(statement.split()).lower() for statement, _params in executed]
    assert any("delete from orders where id = any(%s)" in statement for statement in statements)
    assert any(
        "delete from bom_items" in statement
        and "material_id = %s" in statement
        and "plant = %s" in statement
        for statement in statements
    )
    assert any(
        "delete from material_plants" in statement
        and "material_id = %s" in statement
        and "plant = %s" in statement
        for statement in statements
    )
    assert any("delete from materials where material_id = %s" in statement for statement in statements)
    assert all("where plant = %s" not in statement for statement in statements)


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
    result = md.ingest_bom_from_excel(body, ZZTEST_BOM_FILENAME, ZZTEST_USER)
    _record_bom_audit_rows(pg, zztest_integration_records, audit_floor)

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
def test_purge_orders_by_date_deletes_only_in_range_effective_end_dates(pg, zztest_integration_records):
    """A real date-range purge must delete rows whose effective end falls in
    range and preserve rows outside the range."""
    start = dt.datetime(2026, 11, 1, 0, 0)
    end = dt.datetime(2026, 11, 30, 23, 59)
    rows = [
        (
            ZZTEST_PURGE_BASIC_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_BASIC",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_BASIC",
            dt.datetime(2026, 11, 5, 8, 0),
            dt.datetime(2026, 11, 5, 12, 0),
            None,
            None,
        ),
        (
            ZZTEST_PURGE_SCHEDULED_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_SCHEDULED",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_SCHEDULED",
            dt.datetime(2026, 12, 5, 8, 0),
            dt.datetime(2026, 12, 5, 12, 0),
            dt.datetime(2026, 11, 6, 8, 0),
            dt.datetime(2026, 11, 6, 12, 0),
        ),
        (
            ZZTEST_PURGE_KEEP_ID,
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_ORD_PURGE_KEEP",
            f"ZZTEST_INT_{_TEST_RUN_TOKEN}_MAT_PURGE_KEEP",
            dt.datetime(2026, 12, 6, 8, 0),
            dt.datetime(2026, 12, 6, 12, 0),
            None,
            None,
        ),
    ]
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO orders
                (id, production_order, material_number, plant, basic_start_date,
                 basic_finish_date, scheduled_start, scheduled_end)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [(row[0], row[1], row[2], ZZTEST_PLANT, *row[3:]) for row in rows],
        )
        conn.commit()
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id
              FROM orders
             WHERE COALESCE(scheduled_end, basic_finish_date) BETWEEN %s AND %s
             ORDER BY id
            """,
            (start, end),
        )
        matched_ids = [r[0] for r in cur.fetchall()]

    assert all(order_id.startswith("ZZTEST_INT_") for order_id in matched_ids), (
        "Refusing to exercise global purge on a date range containing non-test orders"
    )
    expected_purge_ids = sorted([ZZTEST_PURGE_BASIC_ID, ZZTEST_PURGE_SCHEDULED_ID])
    assert matched_ids == expected_purge_ids

    result = db.purge_orders_by_date(start, end)

    assert result == {"status": "ok", "deleted": 2}
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM orders WHERE id = ANY(%s) ORDER BY id",
            (list(ZZTEST_PURGE_IDS),),
        )
        remaining = [r[0] for r in cur.fetchall()]

    assert remaining == [ZZTEST_PURGE_KEEP_ID]
