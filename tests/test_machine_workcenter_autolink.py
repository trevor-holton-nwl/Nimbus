"""Auto-link of a machine to the SAP work center sharing its ID (owner decision 2026-10-19).

`master_data._autolink_same_named_machines` runs inside `bulk_apply` for the `machine` and
`sap_workcenter` tables, so every writer (grid, ProdLines, SAP sync, staging) gets it whichever
of the two rows arrives second. Rules: fill an EMPTY link only; never re-point; skip distribute
mode and work centers that already have members; skip a name repeated across subnetworks.

Real-Postgres tests (`@pytest.mark.pg`): they use their own subnetworks/plant (`ZZAL*`) and
clean up after themselves. The migration is exercised by applying its SQL twice.
"""
from pathlib import Path

import pytest

import master_data as md

PLANT = "ZZAL"
SUB1, SUB2 = "ZZAL1", "ZZAL2"
ACTOR = "zzal-test"


@pytest.fixture
def seeded(pg):
    def wipe():
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM machine WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM plants WHERE plant = %s", (PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code IN (%s, %s)", (SUB1, SUB2))
            cur.execute("DELETE FROM admin_audit WHERE user_email = %s", (ACTOR,))
            conn.commit()

    wipe()
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for sub in (SUB1, SUB2):
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s)", (sub, sub))
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s, %s)", (SUB1, PLANT))
        conn.commit()
    yield pg
    wipe()


def _wc(code, mode="single"):
    return {"plant": PLANT, "sap_workcenter": code, "distribution_mode": mode}


def _machine(name, sub=SUB1, wc=None):
    row = {"subnetwork": sub, "plant": PLANT, "machine": name}
    if wc is not None:
        row["sap_workcenter"] = wc
    return row


def _apply(table, rows):
    return md.bulk_apply(table, {"upserts": rows, "deletes": []}, user_email=ACTOR)


def _links(pg):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT machine, sap_workcenter FROM machine WHERE plant = %s ORDER BY subnetwork, machine",
                    (PLANT,))
        return cur.fetchall()


@pytest.mark.pg
class TestAutolinkRule:
    def test_fills_an_empty_link_when_the_machine_is_written_second(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M1")])
        res = _apply("machine", [_machine("ZZ-M1")])
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-M1"}]
        assert _links(seeded) == [("ZZ-M1", "ZZ-M1")]

    def test_fills_an_empty_link_when_the_work_center_is_written_second(self, seeded):
        res = _apply("machine", [_machine("ZZ-M2")])
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-M2", None)]
        res = _apply("sap_workcenter", [_wc("ZZ-M2")])
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-M2"}]
        assert _links(seeded) == [("ZZ-M2", "ZZ-M2")]

    def test_never_repoints_an_existing_link(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M3"), _wc("ZZ-OTHER")])
        res = _apply("machine", [_machine("ZZ-M3", wc="ZZ-OTHER")])
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-M3", "ZZ-OTHER")]

    def test_skips_a_distribute_mode_work_center(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M4", mode="distribute")])
        res = _apply("machine", [_machine("ZZ-M4")])
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-M4", None)]

    def test_skips_a_work_center_that_already_has_other_members(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M5")])
        _apply("machine", [_machine("ZZ-MEMBER", wc="ZZ-M5")])
        res = _apply("machine", [_machine("ZZ-M5")])
        assert "linked" not in res
        assert dict(_links(seeded)) == {"ZZ-MEMBER": "ZZ-M5", "ZZ-M5": None}

    def test_skips_a_name_repeated_across_subnetworks(self, seeded):
        # plants.plant is UNIQUE today (uq_plants_plant), so a plant can't span subnetworks and
        # this guard is defensive. Lift the constraint inside one rolled-back transaction to prove it.
        with seeded._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("ALTER TABLE plants DROP CONSTRAINT uq_plants_plant")
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s, %s)", (SUB2, PLANT))
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter) VALUES (%s, 'ZZ-M6')", (PLANT,))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,'ZZ-M6'),(%s,%s,'ZZ-M6')",
                        (SUB1, PLANT, SUB2, PLANT))
            assert md._autolink_same_named_machines(cur, [PLANT]) == []
            cur.execute("SELECT count(*) FROM machine WHERE plant = %s AND sap_workcenter IS NOT NULL", (PLANT,))
            assert cur.fetchone()[0] == 0
            conn.rollback()
    def test_exact_text_match_only(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M7")])
        res = _apply("machine", [_machine("zz-m7")])
        assert "linked" not in res
        assert _links(seeded) == [("zz-m7", None)]

    def test_sap_sync_path_links_and_a_machine_mapping_without_the_link_column_keeps_it(self, seeded):
        """sap_sync.sync_object calls md.bulk_apply(table, {"upserts": map_records(...)}) directly;
        replay that shape. Mapped rows carry only the mapped columns, so a machine sync that does
        not map the link column leaves an existing link alone (no clobber)."""
        import backend.integration.sap_sync as sap_sync

        fm_wc = [{"sap_field": "WC", "nimbus_column": "sap_workcenter", "transform": "none"},
                 {"sap_field": "PL", "nimbus_column": "plant", "transform": "none"}]
        fm_m = [{"sap_field": "M", "nimbus_column": "machine", "transform": "none"},
                {"sap_field": "SN", "nimbus_column": "subnetwork", "transform": "none"},
                {"sap_field": "PL", "nimbus_column": "plant", "transform": "none"}]
        _apply("machine", [_machine("ZZ-M8")])
        wc_rows = sap_sync.map_records("sap_workcenter", [{"WC": "ZZ-M8", "PL": PLANT}], field_map=fm_wc)
        res = _apply("sap_workcenter", wc_rows)
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-M8"}]

        m_rows = sap_sync.map_records("machine", [{"M": "ZZ-M8", "SN": SUB1, "PL": PLANT}], field_map=fm_m)
        assert "sap_workcenter" not in m_rows[0]
        _apply("machine", m_rows)
        assert _links(seeded) == [("ZZ-M8", "ZZ-M8")]

    def test_a_machine_write_links_only_the_machines_written(self, seeded):
        # Raw inserts so the in-application rule does not pre-empt the scenario: B is an
        # unrelated, unlinked, same-named machine in the same plant.
        with seeded._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES "
                        "(%s,'ZZ-SA','single'),(%s,'ZZ-SB','single')", (PLANT, PLANT))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,'ZZ-SB')", (SUB1, PLANT))
            conn.commit()
        res = _apply("machine", [_machine("ZZ-SA")])
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-SA"}]
        assert dict(_links(seeded)) == {"ZZ-SA": "ZZ-SA", "ZZ-SB": None}

    def test_a_work_center_write_links_only_that_code(self, seeded):
        with seeded._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES "
                        "(%s,'ZZ-WY','single')", (PLANT,))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES "
                        "(%s,%s,'ZZ-WX'),(%s,%s,'ZZ-WY')", (SUB1, PLANT, SUB1, PLANT))
            conn.commit()
        res = _apply("sap_workcenter", [_wc("ZZ-WX")])
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-WX"}]
        assert dict(_links(seeded)) == {"ZZ-WX": "ZZ-WX", "ZZ-WY": None}

    def test_a_cleared_link_stays_cleared_when_that_machine_is_next_saved(self, seeded):
        # Auto-link fires on creation only (2026-10-19): a planner's explicit clear sticks.
        _apply("sap_workcenter", [_wc("ZZ-RF")])
        _apply("machine", [_machine("ZZ-RF")])
        assert _links(seeded) == [("ZZ-RF", "ZZ-RF")]
        res = _apply("machine", [_machine("ZZ-RF", wc="")])  # the Machines pane's clear
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-RF", None)]
        res = _apply("machine", [_machine("ZZ-RF")])  # a later save of the same machine
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-RF", None)]

    def test_a_cleared_link_stays_cleared_when_the_work_center_is_next_written(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-RG")])
        _apply("machine", [_machine("ZZ-RG")])
        _apply("machine", [_machine("ZZ-RG", wc="")])
        res = _apply("sap_workcenter", [_wc("ZZ-RG")])  # update of an existing work center
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-RG", None)]

    def test_a_new_machine_with_a_blank_link_key_is_still_auto_linked(self, seeded):
        # Nothing to clear on creation: a blank/null sap_workcenter must not suppress the link.
        _apply("sap_workcenter", [_wc("ZZ-RH")])
        res = _apply("machine", [_machine("ZZ-RH", wc="")])
        assert res["linked"] == [{"plant": PLANT, "machine": "ZZ-RH"}]
        assert _links(seeded) == [("ZZ-RH", "ZZ-RH")]

    def test_a_new_machine_with_an_explicit_other_link_keeps_it(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-RH"), _wc("ZZ-RI")])
        res = _apply("machine", [_machine("ZZ-RH", wc="ZZ-RI")])
        assert "linked" not in res
        assert _links(seeded) == [("ZZ-RH", "ZZ-RI")]

    def test_the_audit_row_records_the_auto_link(self, seeded):
        _apply("sap_workcenter", [_wc("ZZ-M9")])
        _apply("machine", [_machine("ZZ-M9")])
        with seeded._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT details->'auto_linked' FROM admin_audit WHERE user_email = %s AND table_name = 'machine'"
                        " ORDER BY id DESC LIMIT 1", (ACTOR,))
            assert cur.fetchone()[0] == [{"plant": PLANT, "machine": "ZZ-M9"}]


@pytest.mark.pg
def test_backfill_migration_links_empty_links_only_and_is_idempotent(seeded):
    sql_text = (Path(__file__).resolve().parent.parent / "migrations"
                / "2026-10-19-1-machine-workcenter-autolink.sql").read_text(encoding="utf-8")
    ledger_id = "machine_workcenter_autolink_backfill"
    with seeded._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM schema_migrations WHERE id = %s", (ledger_id,))
        # Raw inserts, so the in-application auto-link does not pre-empt the backfill.
        cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) VALUES "
                    "(%s,'ZZ-B1','single'),(%s,'ZZ-B2','single'),(%s,'ZZ-B3','distribute')",
                    (PLANT, PLANT, PLANT))
        cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) VALUES "
                    "(%s,%s,'ZZ-B1',NULL),(%s,%s,'ZZ-B2','ZZ-B1'),(%s,%s,'ZZ-B3',NULL)",
                    (SUB1, PLANT, SUB1, PLANT, SUB1, PLANT))
        conn.commit()
        try:
            cur.execute(sql_text)
            conn.commit()
            # B1: machine B1 is empty but B2 already belongs to work center B1 -> skipped (has a member).
            # B2: has a link -> untouched. B3: distribute mode -> skipped.
            assert dict(_links(seeded)) == {"ZZ-B1": None, "ZZ-B2": "ZZ-B1", "ZZ-B3": None}
            cur.execute("SELECT count(*) FROM schema_migrations WHERE id = %s", (ledger_id,))
            assert cur.fetchone()[0] == 1

            # Second apply is a ledger no-op, even though new empty candidates now exist.
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter) VALUES (%s,'ZZ-B4')", (PLANT,))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine) VALUES (%s,%s,'ZZ-B4')", (SUB1, PLANT))
            conn.commit()
            cur.execute(sql_text)
            conn.commit()
            assert dict(_links(seeded))["ZZ-B4"] is None

            # A fresh ledger runs the rule and links the unambiguous candidate.
            cur.execute("DELETE FROM schema_migrations WHERE id = %s", (ledger_id,))
            cur.execute(sql_text)
            conn.commit()
            assert dict(_links(seeded))["ZZ-B4"] == "ZZ-B4"
        finally:
            cur.execute("DELETE FROM schema_migrations WHERE id = %s", (ledger_id,))
            cur.execute("INSERT INTO schema_migrations (id) VALUES (%s) ON CONFLICT DO NOTHING", (ledger_id,))
            conn.commit()
