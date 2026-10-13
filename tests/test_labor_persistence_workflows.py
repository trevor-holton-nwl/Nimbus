"""Labor plan round trips, isolation and atomicity against real PostgreSQL."""

import psycopg
import pytest

import master_data as md
from tests.support.planning_pg import audit_rows

pytest_plugins = ("tests.support.planning_pg",)
pytestmark = pytest.mark.pg


@pytest.fixture(params=["aggregate", "machine"])
def labor_kind(request):
    if request.param == "aggregate":
        return {
            "save": md.upsert_labor_plan, "load": md.load_labor_plan, "table": "labor_plan",
            "cell": {"wc_group": "CUT", "period": "2026-W42"},
            "next": {"wc_group": "PACK", "period": "2026-W43"},
        }
    return {
        "save": md.upsert_labor_plan_machine, "load": md.load_labor_plan_machine, "table": "labor_plan_machine",
        "cell": {"machine": "SHARED_LINE", "day": "2026-10-13"},
        "next": {"machine": "PACK_LINE", "day": "2026-10-14"},
    }


def save(context, kind, cells, *, plant=None):
    return kind["save"](context.subnet, plant or context.plant, cells, user_email=context.actor)


def test_repeat_save_updates_one_cell_and_records_each_actor_action(planning_pg, labor_kind):
    c, k = planning_pg, labor_kind
    for hours in [8, 12.75, 0]:
        assert save(c, k, [{**k["cell"], "avail_hours": hours}]) == {"upserted": 1, "deleted": 0}
        rows = k["load"](c.plant)["rows"]
        assert len(rows) == 1
        assert rows[0]["avail_hours"] == hours
    audit = audit_rows(c, k["table"])
    assert len(audit) == 3
    assert all(action == "upsert" and detail == {"plant": c.plant, "upserted": 1, "deleted": 0}
               for action, detail in audit)


@pytest.mark.parametrize("empty", [None, ""], ids=["null", "empty-string"])
def test_clear_is_explicit_idempotent_and_plant_scoped(planning_pg, labor_kind, empty):
    c, k = planning_pg, labor_kind
    for plant in [c.plant, c.other]:
        save(c, k, [{**k["cell"], "avail_hours": 8}], plant=plant)
    assert save(c, k, [{**k["cell"], "avail_hours": empty}]) == {"upserted": 0, "deleted": 1}
    assert save(c, k, [{**k["cell"], "avail_hours": empty}]) == {"upserted": 0, "deleted": 0}
    assert k["load"](c.plant) == {"rows": []}
    assert k["load"](c.other)["rows"][0]["avail_hours"] == 8


def test_empty_batch_preserves_cells_and_missing_keys_do_not_create_records(planning_pg, labor_kind):
    c, k = planning_pg, labor_kind
    save(c, k, [{**k["cell"], "avail_hours": 5}])
    before = k["load"](c.plant)
    assert save(c, k, []) == {"upserted": 0, "deleted": 0}
    assert save(c, k, [{"avail_hours": 9}, {}]) == {"upserted": 0, "deleted": 0}
    assert k["load"](c.plant) == before


def test_mixed_delete_and_upsert_commits_together_without_pruning_omitted_cells(planning_pg, labor_kind):
    c, k = planning_pg, labor_kind
    save(c, k, [{**k["cell"], "avail_hours": 5}, {**k["next"], "avail_hours": 7}])
    assert save(c, k, [{**k["cell"], "avail_hours": 6}]) == {"upserted": 1, "deleted": 0}
    assert len(k["load"](c.plant)["rows"]) == 2
    assert save(c, k, [{**k["cell"], "avail_hours": None}, {**k["next"], "avail_hours": 0}]) == {
        "upserted": 1, "deleted": 1,
    }
    rows = k["load"](c.plant)["rows"]
    assert len(rows) == 1 and rows[0]["avail_hours"] == 0


def test_invalid_numeric_value_rolls_back_earlier_delete_upsert_and_audit(planning_pg, labor_kind):
    c, k = planning_pg, labor_kind
    save(c, k, [{**k["cell"], "avail_hours": 11}])
    before = k["load"](c.plant)
    audit_before = audit_rows(c, k["table"])
    # DELETE runs first, then executemany writes a valid row before the bad row.
    with pytest.raises(psycopg.errors.InvalidTextRepresentation):
        save(c, k, [{**k["cell"], "avail_hours": None},
                    {**k["next"], "avail_hours": 6},
                    {**k["cell"], "avail_hours": "not-a-number"}])
    assert k["load"](c.plant) == before
    assert audit_rows(c, k["table"]) == audit_before
    # The failed transaction must not poison the pooled connection.
    assert save(c, k, [{**k["cell"], "avail_hours": 12}])["upserted"] == 1


@pytest.mark.parametrize("field,value", [("period", "2026-W99"), ("day", "2026-02-30")])
def test_invalid_later_cell_preserves_all_existing_values(planning_pg, field, value):
    c = planning_pg
    if field == "period":
        kind = {"save": md.upsert_labor_plan, "load": md.load_labor_plan,
                "cell": {"wc_group": "CUT", "period": "2026-W42"}, "table": "labor_plan"}
    else:
        kind = {"save": md.upsert_labor_plan_machine, "load": md.load_labor_plan_machine,
                "cell": {"machine": c.machine, "day": "2026-10-13"}, "table": "labor_plan_machine"}
    save(c, kind, [{**kind["cell"], "avail_hours": 8}])
    before = kind["load"](c.plant)
    with pytest.raises(ValueError, match=f"Invalid {field}"):
        save(c, kind, [{**kind["cell"], "avail_hours": None},
                       {**kind["cell"], field: value, "avail_hours": 4}])
    assert kind["load"](c.plant) == before
    assert len(audit_rows(c, kind["table"])) == 1


@pytest.mark.parametrize("filters,expected", [
    ({}, [("PACK_LINE", "2026-10-14"), ("SHARED_LINE", "2026-10-13"),
          ("SHARED_LINE", "2026-10-14"), ("SHARED_LINE", "2026-10-15"), ("UNREGISTERED", "2026-10-14")]),
    ({"group": "CUT"}, [("SHARED_LINE", "2026-10-13"), ("SHARED_LINE", "2026-10-14"),
                           ("SHARED_LINE", "2026-10-15")]),
    ({"group": "PACK"}, [("PACK_LINE", "2026-10-14")]),
    ({"from_date": "2026-10-14", "to_date": "2026-10-14", "group": "CUT"},
     [("SHARED_LINE", "2026-10-14")]),
    ({"from_date": "2026-10-15"}, [("SHARED_LINE", "2026-10-15")]),
    ({"to_date": "2026-10-13"}, [("SHARED_LINE", "2026-10-13")]),
    ({"group": "' OR 1=1 --"}, []),
    ({"from_date": "2026-10-15", "to_date": "2026-10-13"}, []),
])
def test_line_filters_are_inclusive_sorted_and_join_the_correct_plant(planning_pg, filters, expected):
    c = planning_pg
    cells = [{"machine": c.machine, "day": f"2026-10-{day}", "avail_hours": 8} for day in [15, 13, 14]]
    cells += [{"machine": machine, "day": "2026-10-14", "avail_hours": 7}
              for machine in ["PACK_LINE", "UNREGISTERED"]]
    md.upsert_labor_plan_machine(c.subnet, c.plant, cells, c.actor)
    md.upsert_labor_plan_machine(c.subnet, c.other, [cells[0]], c.actor)
    rows = md.load_labor_plan_machine(c.plant, **filters)["rows"]
    assert [(r["machine"], r["day"]) for r in rows] == expected


def test_line_source_changes_survive_reload(planning_pg):
    c = planning_pg
    cell = {"machine": c.machine, "day": "2028-02-29", "avail_hours": "7.25"}
    md.upsert_labor_plan_machine(c.subnet, c.plant, [cell], c.actor)
    assert md.load_labor_plan_machine(c.plant)["rows"] == [{**cell, "avail_hours": 7.25, "source": "auto_split"}]
    md.upsert_labor_plan_machine(c.subnet, c.plant, [{**cell, "source": "manual", "avail_hours": 0}], c.actor)
    assert md.load_labor_plan_machine(c.plant)["rows"] == [{**cell, "avail_hours": 0.0, "source": "manual"}]
