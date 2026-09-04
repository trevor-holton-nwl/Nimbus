"""
Real-DB proof that get_setup_snapshot's machine-roster scoping (Code_Review_09_01.md
P1-9) actually excludes a stale machine code and includes both a registered-but-idle
machine and an order-only machine, against a real Postgres connection -- not just the
mocked-cursor unit test in tests/test_setup_data.py.

Requires a local Postgres with NIMBUS_TEST_DB=1 (see tests/conftest.py) --
auto-skipped otherwise.
"""
import datetime as dt

import pytest
from psycopg.types.json import Jsonb

import backend.setup.data as setup_data


@pytest.mark.pg
class TestSnapshotMachineRosterScopingRealDb:
    PLANT = "ZZTEST_SNAP_PLANT"
    REGISTERED_IDLE = "ZZTEST_SNAP_REGISTERED_IDLE"
    ORDER_ONLY = "ZZTEST_SNAP_ORDER_ONLY"
    STALE = "ZZTEST_SNAP_STALE_CODE"
    SUBNETWORK = "ZZT"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db_ = pg
        with db_._pool.connection() as conn, conn.cursor() as cur:
            # plants.subnetwork FKs to subnetworks(code); subnetworks.name is
            # NOT NULL with no default (see Code_Review_09_01.md's newly-recorded
            # subnetworks fixture bug elsewhere in this suite) -- supply it here
            # too, rather than repeating that exact gap in a new test.
            cur.execute(
                "INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, "ZZTEST Subnetwork"),
            )
            cur.execute(
                "INSERT INTO plants (subnetwork, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, self.PLANT),
            )
            cur.execute(
                "INSERT INTO machine (subnetwork, plant, machine) VALUES (%s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                (self.SUBNETWORK, self.PLANT, self.REGISTERED_IDLE),
            )
            cur.execute(
                "INSERT INTO setup_definition (plant, fields, signature_version, strict_blanks, active) "
                "VALUES (%s, %s, 1, TRUE, TRUE) ON CONFLICT (plant) DO NOTHING",
                (self.PLANT, Jsonb(["colorWheel"])),
            )
            oid = db_.make_id("ZZTEST_SNAP_ORD", "ZZTEST_SNAP_MAT")
            now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant, "
                "basic_start_date, basic_finish_date) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (oid, "ZZTEST_SNAP_ORD", "ZZTEST_SNAP_MAT", self.ORDER_ONLY, self.PLANT,
                 now, now + dt.timedelta(hours=1)),
            )
            for machine in (self.REGISTERED_IDLE, self.ORDER_ONLY, self.STALE):
                cur.execute(
                    "INSERT INTO setup_matrix (plant, machine, signature_version, from_key, to_key, "
                    "setup_min, source) VALUES (%s, %s, 1, %s, %s, 5, 'manual') ON CONFLICT DO NOTHING",
                    (self.PLANT, machine,
                     Jsonb([{"fieldKey": "colorWheel", "value": "RED"}]),
                     Jsonb([{"fieldKey": "colorWheel", "value": "BLUE"}])),
                )
            conn.commit()
        yield
        with db_._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM setup_matrix WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM setup_definition WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM orders WHERE id = %s", (oid,))
            cur.execute(
                "DELETE FROM machine WHERE subnetwork = %s AND plant = %s", (self.SUBNETWORK, self.PLANT)
            )
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUBNETWORK, self.PLANT))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUBNETWORK,))
            conn.commit()

    def test_registered_and_order_only_machines_included_stale_code_excluded(self, pg):
        snapshot = setup_data.get_setup_snapshot(self.PLANT)
        machines_in_snapshot = {row["machine"] for row in snapshot["machine_rows"]}
        assert self.REGISTERED_IDLE in machines_in_snapshot, \
            "a registered-but-idle machine (no loaded order) must still be included"
        assert self.ORDER_ONLY in machines_in_snapshot, \
            "a machine with a loaded order but no master-data registration must still be included"
        assert self.STALE not in machines_in_snapshot, \
            "a machine code with neither a master-data registration nor a loaded order must be excluded"
