"""Guarded Postgres integration coverage for Excel ingest and purge paths.

These tests require the existing `tests/conftest.py` safety gates:
`@pytest.mark.pg`, `NIMBUS_TEST_DB=1`, and a local/CI Postgres host. All
records use `ZZTEST_*` values and are cleaned before and after each test.
"""
from __future__ import annotations

import datetime as dt
from io import BytesIO

import pandas as pd
import pytest

import db
import master_data as md


ZZTEST_PLANT = "ZZTEST_P3"
ZZTEST_USER = "zztest.integration@example.com"
ZZTEST_MAT_PARENT = "ZZTEST_IPAR"
ZZTEST_MAT_COMPONENT = "ZZTEST_ICMP"


def _xlsx(rows: list[dict]) -> bytes:
    buf = BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


@pytest.fixture
def zztest_integration_records(pg):
    def cleanup():
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM bom_items
                 WHERE plant = %s
                    OR material_id LIKE 'ZZTEST_I%%'
                    OR component_id LIKE 'ZZTEST_I%%'
                """,
                (ZZTEST_PLANT,),
            )
            cur.execute(
                """
                DELETE FROM orders
                 WHERE plant = %s
                    OR production_order LIKE 'ZZTEST_INT_%%'
                    OR material_number LIKE 'ZZTEST_I%%'
                    OR id LIKE 'ZZTEST_INT_%%'
                """,
                (ZZTEST_PLANT,),
            )
            cur.execute("DELETE FROM upload_audit WHERE filename LIKE 'ZZTEST_INT_%%'")
            cur.execute("DELETE FROM admin_audit WHERE user_email = %s", (ZZTEST_USER,))
            cur.execute(
                """
                DELETE FROM material_plants
                 WHERE plant = %s OR material_id LIKE 'ZZTEST_I%%'
                """,
                (ZZTEST_PLANT,),
            )
            cur.execute("DELETE FROM materials WHERE material_id LIKE 'ZZTEST_I%%'")
            conn.commit()

    cleanup()
    yield
    cleanup()


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
    order_no = "ZZTEST_INT_ORD_1"
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

    result = db.ingest_orders_from_excel(body, "ZZTEST_INT_orders.xlsx")

    assert result["status"] == "ok"
    assert result["raw_row_count"] == 1
    assert result["inserted"] == 1
    assert result["updated"] == 0
    oid = db.make_id(order_no, ZZTEST_MAT_PARENT)
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
    assert audit == ("ZZTEST_INT_orders.xlsx", 1, 1)


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

    result = md.ingest_bom_from_excel(body, "ZZTEST_INT_bom.xlsx", ZZTEST_USER)

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
        "01",
        1,
        "0010",
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
            "ZZTEST_INT_PURGE_BASIC",
            "ZZTEST_INT_ORD_PURGE_BASIC",
            "ZZTEST_INT_MAT_PURGE_BASIC",
            dt.datetime(2026, 11, 5, 8, 0),
            dt.datetime(2026, 11, 5, 12, 0),
            None,
            None,
        ),
        (
            "ZZTEST_INT_PURGE_SCHEDULED",
            "ZZTEST_INT_ORD_PURGE_SCHEDULED",
            "ZZTEST_INT_MAT_PURGE_SCHEDULED",
            dt.datetime(2026, 12, 5, 8, 0),
            dt.datetime(2026, 12, 5, 12, 0),
            dt.datetime(2026, 11, 6, 8, 0),
            dt.datetime(2026, 11, 6, 12, 0),
        ),
        (
            "ZZTEST_INT_PURGE_KEEP",
            "ZZTEST_INT_ORD_PURGE_KEEP",
            "ZZTEST_INT_MAT_PURGE_KEEP",
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

    result = db.purge_orders_by_date(start, end)

    assert result == {"status": "ok", "deleted": 2}
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM orders WHERE id LIKE 'ZZTEST_INT_PURGE_%%' ORDER BY id")
        remaining = [r[0] for r in cur.fetchall()]

    assert remaining == ["ZZTEST_INT_PURGE_KEEP"]
