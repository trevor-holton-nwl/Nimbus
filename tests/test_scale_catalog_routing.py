"""Production-version/operation joins at realistic machine and material scale."""

import uuid

import pytest

import master_data as md
from tests.support.scale_catalog_sql import RecordingPool

pytestmark = pytest.mark.pg


@pytest.fixture(scope="module")
def routing_catalog(pg):
    token = uuid.uuid4().hex[:6]
    sub = f"scale_routing_{token}"
    plants = [f"R{token}{i}" for i in range(2)]
    materials = [f"R{token}{i:04}" for i in range(160)]
    machines = [f"LINE{i:03}" for i in range(70)]
    try:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks(code, name) VALUES (%s, %s)", (sub, sub))
            cur.executemany("INSERT INTO plants(subnetwork, plant) VALUES (%s, %s)",
                            [(sub, plant) for plant in plants])
            cur.executemany("INSERT INTO materials(material_id) VALUES (%s)", [(mat,) for mat in materials])
            cur.executemany("INSERT INTO sap_workcenter(plant, sap_workcenter) VALUES (%s, 'WC')",
                            [(plant,) for plant in plants])
            cur.executemany(
                "INSERT INTO machine(subnetwork, plant, machine, sap_workcenter) VALUES (%s, %s, %s, 'WC')",
                [(sub, plants[0], machine) for machine in machines]
                + [(sub, plants[1], "OTHER_PLANT_ONLY")],
            )
            # Every material deliberately reuses the same routing group. The
            # join must retain material and plant identity, not just that group.
            cur.executemany(
                "INSERT INTO production_version(plant, material_id, production_version, task_list_type, "
                "routing_group, group_counter, sap_workcenter) VALUES (%s, %s, %s, 'N', 'SHARED', '01', 'WC')",
                [(plant, mat, pv) for plant in plants for mat in materials for pv in ("0001", "0002")],
            )
            cur.executemany(
                "INSERT INTO production_version(plant, material_id, production_version, task_list_type, "
                "routing_group, group_counter) VALUES (%s, %s, '0099', 'N', 'MISSING', '01')",
                [(plants[0], mat) for mat in materials[::20]],
            )
            cur.executemany(
                "INSERT INTO routing_operation(plant, material_id, task_list_type, routing_group, group_counter, "
                "sequence_no, activity, sap_workcenter, workcenter_category, base_quantity, "
                "std_value_machine, std_value_unit_machine, operation_text) "
                "VALUES (%s, %s, 'N', 'SHARED', '01', '000000', %s, 'WC', '0001', 1, %s, 'MIN', %s)",
                [(plant, mat, activity, (i + 1) if plant == plants[0] else 999,
                  f"operation for {mat}")
                 for plant in plants for i, mat in enumerate(materials) for activity in ("0010", "0020", "0030")],
            )
        yield {"plants": plants, "materials": materials, "machines": machines}
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM routing_operation WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM production_version WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = ANY(%s)", (plants,))
            cur.execute("DELETE FROM materials WHERE material_id = ANY(%s)", (materials,))


def test_routing_grid_join_pages_do_not_multiply_by_machine_or_other_material(routing_catalog, pg, monkeypatch):
    fixture = routing_catalog
    recorder = RecordingPool(pg._pool)
    monkeypatch.setattr(md, "_pool", recorder)
    expected = []
    for i, mat in enumerate(fixture["materials"]):
        expected.extend((mat, pv, "000000", activity)
                        for pv in ("0001", "0002") for activity in ("0010", "0020", "0030"))
        if i % 20 == 0:
            expected.append((mat, "0099", None, None))
    seen = []
    for offset in range(0, len(expected) + 83, 83):
        recorder.calls.clear()
        page = md.routing_pv_grid(fixture["plants"][0], limit=83, offset=offset,
                                  allowed_plants=[fixture["plants"][0]])
        assert page["meta"]["total"] == len(expected)
        assert len(recorder.calls) <= 2, "machine enrichment must remain in the set-based read"
        assert len(page["rows"]) <= 83
        for row in page["rows"]:
            assert row["plant"] == fixture["plants"][0]
            seen.append((row["material_id"], row["production_version"], row["sequence_no"], row["activity"]))
            if row["production_version"] == "0099":
                assert row["machines"] == []
                assert row["operation_text"] is None
                assert row["counts_toward_runtime"] is False
            else:
                assert row["machines"] == fixture["machines"]
                assert row["operation_text"] == f"operation for {row['material_id']}"
                assert row["std_value_machine"] == fixture["materials"].index(row["material_id"]) + 1
                assert row["counts_toward_runtime"] is True
    assert seen == expected
    assert len(set(seen)) == len(expected)


def test_routing_search_count_and_machine_enrichment_stay_on_selected_plant(routing_catalog):
    fixture = routing_catalog
    material = fixture["materials"][117]
    seen = []
    for offset in (0, 4, 8):
        page = md.routing_pv_grid(fixture["plants"][1], search=material, limit=4, offset=offset)
        assert page["meta"]["total"] == 6
        for row in page["rows"]:
            assert row["material_id"] == material
            assert row["machines"] == ["OTHER_PLANT_ONLY"]
            assert row["std_value_machine"] == 999
        seen.extend((row["production_version"], row["activity"]) for row in page["rows"])
    assert seen == [(pv, activity) for pv in ("0001", "0002") for activity in ("0010", "0020", "0030")]
