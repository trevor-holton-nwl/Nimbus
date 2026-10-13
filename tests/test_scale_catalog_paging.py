"""Real SQL coverage for the large, scoped catalogs planners browse.

Sixty plants share a 2,003-material catalog. Assertions concern complete
page traversal and bounded SQL statements, rather than workstation timing.
"""

import uuid

import pytest

import master_data as md
from tests.support.scale_catalog_sql import RecordingPool

pytestmark = pytest.mark.pg


@pytest.fixture(scope="module")
def catalog(pg):
    # brain.py's lifespan creates this runtime-managed JSONB column; schema.sql
    # alone does not represent a started app. Use the same idempotent bootstrap.
    md.ensure_plant_constraints_column()
    token = uuid.uuid4().hex[:6]
    sub = f"scale_catalog_{token}"
    plants = [f"C{token}{i:02}" for i in range(60)]
    literal = f"C{token}_%\\"
    materials = sorted([f"C{token}{i:05}" for i in range(1996)]
                       + [f"{literal}{i:03}" for i in range(7)])
    try:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks(code, name) VALUES (%s, %s)", (sub, sub))
            cur.executemany(
                "INSERT INTO plants(subnetwork, plant, frozen_horizon_days) VALUES (%s, %s, %s)",
                [(sub, plant, i) for i, plant in enumerate(plants)],
            )
            cur.executemany(
                "INSERT INTO materials(material_id, material_description, material_type) VALUES (%s, %s, 'FERT')",
                [(mat, f"Catalog part {i}") for i, mat in enumerate(materials)],
            )
            cur.executemany(
                "INSERT INTO material_plants(material_id, plant, min_lot_size) VALUES (%s, %s, %s)",
                [(mat, plant, p + 1) for p, plant in enumerate(plants)
                 for i, mat in enumerate(materials) if p == 0 or i % 59 == p - 1],
            )
        yield {"sub": sub, "plants": plants, "materials": materials, "literal": literal}
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM materials WHERE material_id = ANY(%s)", (materials,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))


@pytest.mark.parametrize("grid", [md.material_grid, md.material_plant_grid])
def test_material_grids_traverse_every_material_once_with_constant_query_budget(catalog, pg, monkeypatch, grid):
    plant = catalog["plants"][0]
    expected = catalog["materials"]
    recorder = RecordingPool(pg._pool)
    monkeypatch.setattr(md, "_pool", recorder)
    seen = []
    query_counts = []
    for offset in range(0, len(expected) + 137, 137):
        before = len(recorder.calls)
        page = grid(plant, limit=137, offset=offset, allowed_plants=[plant])
        query_counts.append(len(recorder.calls) - before)
        assert page["meta"] == {"total": len(expected), "plant": plant}
        assert len(page["rows"]) <= 137
        for row in page["rows"]:
            assert row["material_type"] == "FERT"
            if grid is md.material_plant_grid:
                assert row["plant"] == plant
                assert row["min_lot_size"] == 1
        seen.extend(row["material_id"] for row in page["rows"])
    assert seen == expected
    assert len(set(seen)) == len(expected)
    assert len(set(query_counts)) == 1
    assert max(query_counts) <= 4, "catalog enrichment must not query once per material"


def test_sparse_plant_membership_and_access_scope_do_not_expand_to_global_catalog(catalog):
    plant = catalog["plants"][37]
    expected = catalog["materials"][36::59]
    result = md.material_plant_grid(plant, limit=100, allowed_plants=[plant])
    assert [r["material_id"] for r in result["rows"]] == expected
    assert all(r["min_lot_size"] == 38 for r in result["rows"])
    assert result["meta"]["total"] == len(expected)
    assert md.list_rows("material_plants", plant=plant, allowed_plants=[], limit=100)["rows"] == []
    assert md.list_rows("material_plants", plant=plant,
                        allowed_plants=[catalog["plants"][0]], limit=100)["meta"]["total"] == 0


def test_literal_search_keeps_count_and_pages_consistent_in_large_catalog(catalog):
    expected = [mat for mat in catalog["materials"] if catalog["literal"] in mat]
    seen = []
    for offset in (0, 3, 6, 9):
        page = md.list_rows("materials", search=catalog["literal"], limit=3, offset=offset)
        assert page["meta"]["total"] == len(expected)
        seen.extend(row["material_id"] for row in page["rows"])
    assert seen == expected, "percent, underscore and backslash must be literal search characters"


def test_sixty_plant_paging_attaches_only_visible_policies(catalog, pg, monkeypatch):
    recorder = RecordingPool(pg._pool)
    monkeypatch.setattr(md, "_pool", recorder)
    allowed = catalog["plants"][::2]
    seen = []
    for offset in range(0, len(allowed), 7):
        recorder.calls.clear()
        page = md.list_rows("plants", allowed_plants=allowed, limit=7, offset=offset)
        assert page["meta"]["total"] == 30
        visible = [r["plant"] for r in page["rows"]]
        sidecar = [(query, params) for query, params in recorder.calls
                   if "constraints, split_order_policy" in query]
        assert len(sidecar) == 1
        assert set(sidecar[0][1][0]) == set(visible)
        assert len(recorder.calls) <= 4
        for row in page["rows"]:
            assert row["frozen_horizon_days"] == catalog["plants"].index(row["plant"])
        seen.extend(visible)
    assert seen == allowed
