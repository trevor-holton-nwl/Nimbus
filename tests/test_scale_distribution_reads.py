"""Distribution page hydration and aggregate exports across large plant catalogs."""

import datetime as dt
import uuid

import pytest
from psycopg.types.json import Jsonb

import backend.distribution.data as distribution
from tests.support.scale_catalog_sql import RecordingPool

pytestmark = pytest.mark.pg


@pytest.fixture(scope="module")
def distribution_catalog(pg):
    token = uuid.uuid4().hex[:6]
    sub = f"scale_distribution_{token}"
    plants = [f"D{token}{i}" for i in range(2)]
    materials = [f"D{token}M{i}" for i in range(2)]
    parents = [f"D{token}P{i:04}" for i in range(120)]
    headers, children, shares, segments = [], [], [], []
    for p, plant in enumerate(plants):
        for i, parent in enumerate(parents):
            day = dt.datetime(2026, 11, 1 if i < 60 else 2, 8)
            quantity = 100 if p == 0 else 1800
            for mat in materials:
                headers.append((plant, parent, mat, f"WC{i % 2}", quantity, day))
                for child_index in range(2):
                    letter = "AB"[child_index]
                    machine = f"LINE{i % 2 + child_index * 2:03}"
                    child_id = f"{plant}:{parent}:{mat}:{letter}"
                    start = day if child_index == 0 else None
                    end = day + dt.timedelta(hours=3) if child_index == 0 else None
                    status = "scheduled" if child_index == 0 else "needs_planning"
                    reason = None if child_index == 0 else Jsonb({"code": "unplaced", "message": "Queued"})
                    children.append((child_id, f"{letter}-{parent}", mat, machine, plant, parent,
                                     quantity // 2, day, start, end, status, reason))
                    shares.append((plant, parent, mat, machine, letter, child_id))
                    if child_index == 0:
                        segments.extend([(child_id, n, day + dt.timedelta(hours=a), day + dt.timedelta(hours=b))
                                         for n, a, b in ((1, 1, 2), (2, 5, 6))])
    try:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks(code, name) VALUES (%s, %s)", (sub, sub))
            cur.executemany("INSERT INTO plants(subnetwork, plant) VALUES (%s, %s)",
                            [(sub, plant) for plant in plants])
            cur.executemany("INSERT INTO materials(material_id) VALUES (%s)", [(mat,) for mat in materials])
            cur.executemany("INSERT INTO material_plants(material_id, plant) VALUES (%s, %s)",
                            [(mat, plant) for mat in materials for plant in plants])
            cur.executemany(
                "INSERT INTO sap_workcenter(plant, sap_workcenter, distribution_mode) VALUES (%s, %s, 'distribute')",
                [(plant, f"WC{i}") for plant in plants for i in range(2)],
            )
            cur.executemany(
                "INSERT INTO machine(subnetwork, plant, machine, sap_workcenter) VALUES (%s, %s, %s, %s)",
                [(sub, plant, f"LINE{i:03}", f"WC{i % 2}") for plant in plants for i in range(70)],
            )
            cur.executemany(
                "INSERT INTO order_distribution(plant, production_order, material_number, sap_workcenter, "
                "order_quantity, basic_start_date) VALUES (%s, %s, %s, %s, %s, %s)", headers,
            )
            cur.executemany(
                "INSERT INTO orders(id, production_order, material_number, machine, plant, parent_production_order, "
                "order_quantity, basic_start_date, scheduled_start, scheduled_end, planning_status, planning_reason, "
                "run_time) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 2)", children,
            )
            cur.executemany(
                "INSERT INTO order_distribution_share(plant, production_order, material_number, machine, letter, "
                "child_id, weight) VALUES (%s, %s, %s, %s, %s, %s, 1)", shares,
            )
            cur.executemany(
                "INSERT INTO order_schedule_segments(order_id, segment_no, scheduled_start, scheduled_end) "
                "VALUES (%s, %s, %s, %s)", segments,
            )
        yield {"plants": plants, "parents": parents, "materials": materials}
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM order_distribution WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM materials WHERE material_id = ANY(%s)", (materials,))


def test_distribution_hydrates_one_and_hundred_header_pages_with_same_query_budget(
    distribution_catalog, pg, monkeypatch,
):
    plant = distribution_catalog["plants"][0]
    recorder = RecordingPool(pg._pool)
    monkeypatch.setattr(distribution, "_pool", recorder)
    counts = []
    for limit in (1, 100):
        recorder.calls.clear()
        page = distribution.list_headers_for_plant(plant, limit=limit, offset=11)
        counts.append(len(recorder.calls))
        assert len(page["data"]) == limit
        assert page["meta"] == {"total": 240, "scheduled_children": 240, "truncated": False}
        visible_parents = {row["header"]["production_order"] for row in page["data"]}
        visible_materials = {row["header"]["material_number"] for row in page["data"]}
        for item in page["data"]:
            assert item["header"]["plant"] == plant
            assert item["children_summary"]["count"] == 2
            assert item["children_summary"]["total_quantity"] == 100
            assert len(item["shares"]) == 2
            assert all(share["child_id"].startswith(f"{plant}:") for share in item["shares"])
        # Share and child hydration must be constrained to keys on this page.
        hydration = [(query, params) for query, params in recorder.calls
                     if "production_order = ANY(%s)" in query]
        assert len(hydration) == 2
        for _query, params in hydration:
            assert params[0] == plant
            assert set(params[1]) == visible_parents
            assert set(params[2]) == visible_materials
    assert counts[0] == counts[1]
    assert counts[1] <= 7, "page enrichment must not grow one query per header or share"


def test_distribution_export_scopes_plant_workcenter_date_and_uses_segment_extents(distribution_catalog):
    fixture = distribution_catalog
    rows = distribution.get_aggregate(
        fixture["plants"][0], workcenter="WC0",
        date_from=dt.datetime(2026, 11, 2), date_to=dt.datetime(2026, 11, 2, 23, 59),
    )
    expected = [(parent, mat) for parent in fixture["parents"][60::2] for mat in fixture["materials"]]
    assert [(r["production_order"], r["material_number"]) for r in rows] == expected
    assert len(rows) == 60
    for row in rows:
        assert row["machine"] == "WC0"
        assert row["quantity"] == row["sum_child_quantity"] == 100
        assert row["child_count"] == 2
        assert row["queued_children"] == 1
        assert row["all_scheduled"] is False
        assert row["start"] == dt.datetime(2026, 11, 2, 9)
        assert row["finish"] == dt.datetime(2026, 11, 2, 14)
        assert sorted(child["quantity"] for child in row["children"]) == [50, 50]
        queued = next(child for child in row["children"] if child["machine"] == "LINE002")
        assert queued["start"] is None and queued["end"] is None
