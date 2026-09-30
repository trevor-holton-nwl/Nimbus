"""Routing edit/concurrency contracts against real, guarded local PostgreSQL.

All rows belong to an isolated ZZTEST_AR plant. Both eligibility calculation
and order writes use production code; no resolver or SQL mocks are installed.
"""
import datetime as dt
from decimal import Decimal

import pytest

from backend.routing import resolver


@pytest.mark.pg
class TestRoutingEditTransactions:
    SUB, PLANT, MATERIAL = "ZZTEST_AR_S", "ZZTEST_ARP", "ZZTEST_AR_M"
    M1, M2 = "ZZTEST_AR_L1", "ZZTEST_AR_L2"
    W1, W2 = "ZZTEST_AR_W1", "ZZTEST_AR_W2"
    START = dt.datetime(2026, 10, 5, 8)

    def _cleanup(self, cur):
        cur.execute("DELETE FROM orders WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM routing_operation WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM production_version WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM routing_rules WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM machine WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM sap_workcenter WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM material_plants WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM materials WHERE material_id=%s", (self.MATERIAL,))
        cur.execute("DELETE FROM plants WHERE plant=%s AND subnetwork=%s", (self.PLANT, self.SUB))
        cur.execute("DELETE FROM subnetworks WHERE code=%s", (self.SUB,))

    @pytest.fixture(autouse=True)
    def seed(self, pg):
        self.ids = [pg.make_id(f"ZZTEST_AR_O{i}", self.MATERIAL) for i in (1, 2)]
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("INSERT INTO subnetworks (code,name) VALUES (%s,'Routing audit test')", (self.SUB,))
            cur.execute(
                "INSERT INTO plants (subnetwork,plant,routing_runtime_enabled,split_order_policy,timezone)"
                " VALUES (%s,%s,TRUE,'partial_allowed','America/New_York')", (self.SUB, self.PLANT),
            )
            cur.execute("INSERT INTO materials (material_id) VALUES (%s)", (self.MATERIAL,))
            cur.execute("INSERT INTO material_plants (material_id,plant) VALUES (%s,%s)",
                        (self.MATERIAL, self.PLANT))
            for machine, wc in ((self.M1, self.W1), (self.M2, self.W2)):
                cur.execute("INSERT INTO sap_workcenter (plant,sap_workcenter) VALUES (%s,%s)", (self.PLANT, wc))
                cur.execute("INSERT INTO machine (subnetwork,plant,machine,sap_workcenter) VALUES (%s,%s,%s,%s)",
                            (self.SUB, self.PLANT, machine, wc))
            for pv, group, hours in (("0001", "AR000001", 3), ("0002", "AR000002", 9)):
                cur.execute(
                    "INSERT INTO production_version (plant,material_id,production_version,task_list_type,"
                    " routing_group,group_counter,valid_from,valid_to,sap_workcenter)"
                    " VALUES (%s,%s,%s,'N',%s,'01','2026-01-01','2027-12-31',%s)",
                    (self.PLANT, self.MATERIAL, pv, group, self.W1),
                )
                for activity, wc, duration in (("0010", self.W1, hours), ("0020", self.W2, hours + 3)):
                    cur.execute(
                        "INSERT INTO routing_operation (plant,material_id,task_list_type,routing_group,"
                        " group_counter,sequence_no,activity,sap_workcenter,workcenter_category,base_quantity,"
                        " std_value_machine,std_value_unit_machine)"
                        " VALUES (%s,%s,'N',%s,'01','000000',%s,%s,'0001',10,%s,'H')",
                        (self.PLANT, self.MATERIAL, group, activity, wc, duration),
                    )
            for i, oid in enumerate(self.ids, start=1):
                start = self.START + dt.timedelta(days=i - 1)
                cur.execute(
                    "INSERT INTO orders (id,production_order,material_number,plant,machine,production_version,"
                    " order_quantity,basic_start_date,basic_finish_date,scheduled_start,scheduled_end,"
                    " run_time,run_time_source,planning_status,prt_01,prt_02)"
                    " VALUES (%s,%s,%s,%s,%s,'0001',10,%s,%s,%s,%s,3,'routing','scheduled','OLD-TOOL','OLD-TOOL2')",
                    (oid, f"ZZTEST_AR_O{i}", self.MATERIAL, self.PLANT, self.M1, start,
                     start + dt.timedelta(days=2), start, start + dt.timedelta(hours=3)),
                )
            conn.commit()
        try:
            report = resolver.resolve_orders(self.PLANT)
            assert report["resolved"] == 2
            yield
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                self._cleanup(cur)
                conn.commit()

    def _row(self, pg, oid=None):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id,machine,production_version,run_time,run_time_source,run_time_basis,"
                " planning_status,planning_reason,scheduled_start,scheduled_end,prt_01,prt_02,"
                " xmin::text::bigint AS version FROM orders WHERE id=%s", (oid or self.ids[0],),
            )
            return dict(zip([column.name for column in cur.description], cur.fetchone(), strict=True))

    def _save(self, pg, patch, **options):
        row = self._row(pg)
        return pg.update_task_dates_bulk(
            [{"id": row["id"], "base_version": row["version"], **patch}],
            allowed_plants=[self.PLANT], **options,
        )

    def test_pv_edit_commits_candidate_runtime_and_response_version_then_next_save_succeeds(self, pg):
        before = self._row(pg)
        assert before["run_time"] == Decimal(3)
        result = self._save(pg, {"PRODUCTION_VERSION": "0002", "RUN_TIME": 9,
                                 "start": self.START, "end": self.START + dt.timedelta(hours=9)})
        assert result["persisted"] == 1 and result["stale"] == []
        after = self._row(pg)
        assert after["run_time"] == Decimal(9)
        assert after["production_version"] == "0002"
        assert after["run_time_source"] == "routing"
        assert after["run_time_basis"]["production_version"] == "0002"
        assert after["run_time_basis"]["total_hours"] == 9
        assert after["version"] == result["versions"][self.ids[0]]
        # These are ordinary browser save echoes, not new PV/runtime edits.
        second = pg.update_task_dates_bulk([{
            "id": self.ids[0], "base_version": result["versions"][self.ids[0]],
            "MACHINE": self.M1, "PRODUCTION_VERSION": "0002", "RUN_TIME": 9,
            "start": self.START + dt.timedelta(hours=1), "end": self.START + dt.timedelta(hours=10),
            "schedule_segments": [],
        }], allowed_plants=[self.PLANT])
        assert second["persisted"] == 1 and second["stale"] == [] and second["invalid_ids"] == []
        assert self._row(pg)["version"] == second["versions"][self.ids[0]]

    def test_machine_edit_commits_runtime_basis_and_refresh_carries_cleared_attributes(self, pg):
        result = self._save(pg, {"MACHINE": self.M2, "RUN_TIME": 6, "PRT_01": "", "PRT_02": None,
                                 "start": self.START, "end": self.START + dt.timedelta(hours=6)})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["machine"] == self.M2 and row["run_time"] == Decimal(6)
        assert row["run_time_basis"]["machine"] == self.M2
        assert row["run_time_basis"]["workcenter"] == self.W2
        fresh = pg.get_task_versions([self.ids[0]])[0]
        assert fresh["row_version"] == result["versions"][self.ids[0]]
        assert fresh["MACHINE"] == self.M2 and fresh["RUN_TIME"] == Decimal(6)
        assert fresh["PRT_01"] is None and fresh["PRT_02"] is None
        assert fresh["PRODUCTION_VERSION"] == "0001"
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET production_version=NULL WHERE id=%s", (self.ids[0],))
            conn.commit()
        cleared = pg.get_task_versions([self.ids[0]])[0]
        assert cleared["PRODUCTION_VERSION"] is None

    def test_stale_token_wins_over_runtime_override_validation(self, pg):
        before = self._row(pg)
        result = self._save(pg, {"PRT_01": "FIRST-WRITER"})
        assert result["persisted"] == 1
        stale = pg.update_task_dates_bulk([{
            "id": self.ids[0], "base_version": before["version"], "RUN_TIME": 99,
        }], allowed_plants=[self.PLANT])
        assert stale["stale"] == [self.ids[0]] and stale["invalid_ids"] == []
        assert stale["persisted"] == 0
        assert self._row(pg)["run_time"] == Decimal(3)

    def test_changed_routing_preview_is_stale_without_mutating_the_order(self, pg):
        before = self._row(pg)
        result = self._save(pg, {"PRODUCTION_VERSION": "0002", "RUN_TIME": 8,
                                 "start": self.START, "end": self.START + dt.timedelta(hours=8)})
        assert result["stale"] == [self.ids[0]]
        assert result["rejection_reasons"] == {self.ids[0]: "runtime_preview_changed"}
        assert result["invalid_ids"] == [] and result["persisted"] == 0 and result["versions"] == {}
        assert self._row(pg) == before

    @pytest.mark.parametrize("hold_code", [None, "capacity_exhausted", "runtime_unknown"])
    def test_manual_runtime_override_only_releases_runtime_unknown_hold(self, pg, hold_code):
        if hold_code:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute(
                    "UPDATE orders SET planning_status='needs_planning',"
                    " planning_reason=jsonb_build_object('code',%s::text,'message','Held'),"
                    " scheduled_start=NULL,scheduled_end=NULL,run_time=NULL WHERE id=%s",
                    (hold_code, self.ids[0]),
                )
                conn.commit()
        before = self._row(pg)
        result = self._save(pg, {"RUN_TIME": 5, "start": self.START,
                                 "end": self.START + dt.timedelta(hours=5)})
        if hold_code == "runtime_unknown":
            assert result["persisted"] == 1
            after = self._row(pg)
            assert after["run_time"] == Decimal(5) and after["run_time_source"] == "manual"
            assert after["planning_status"] == "scheduled" and after["planning_reason"] is None
        else:
            assert result["invalid_ids"] == [self.ids[0]] and result["persisted"] == 0
            assert self._row(pg) == before

    def test_disabled_plant_preserves_legacy_runtime_and_attribute_edits(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE plants SET routing_runtime_enabled=FALSE WHERE plant=%s", (self.PLANT,))
            conn.commit()
        result = self._save(pg, {"PRODUCTION_VERSION": "9999", "RUN_TIME": 7})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["run_time"] == Decimal(7) and row["production_version"] == "9999"

    def test_manual_runtime_without_anchor_can_remain_explicitly_queued(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE orders SET planning_status='needs_planning',"
                " planning_reason=jsonb_build_object('code','runtime_unknown','message','Needs placement'),"
                " basic_start_date=NULL,basic_finish_date=NULL,scheduled_start=NULL,scheduled_end=NULL,"
                " run_time=NULL WHERE id=%s", (self.ids[0],),
            )
            conn.commit()
        reason = {"code": "runtime_unknown", "message": "Needs placement"}
        result = self._save(pg, {"RUN_TIME": 5, "planning_status": "needs_planning", "planning_reason": reason})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["run_time"] == Decimal(5) and row["run_time_source"] == "manual"
        assert row["planning_status"] == "needs_planning" and row["planning_reason"] == reason
        assert row["scheduled_start"] is None and row["scheduled_end"] is None

    @pytest.mark.parametrize("second_hours,accepted", [(5, True), (1, False)])
    def test_split_duration_validates_against_candidate_runtime(self, pg, second_hours, accepted):
        before = self._row(pg)
        segments = [
            {"sequence": 1, "start": self.START, "end": self.START + dt.timedelta(hours=4)},
            {"sequence": 2, "start": self.START + dt.timedelta(hours=5),
             "end": self.START + dt.timedelta(hours=5 + second_hours)},
        ]
        result = self._save(pg, {"PRODUCTION_VERSION": "0002", "RUN_TIME": 9,
                                 "schedule_segments": segments})
        if accepted:
            assert result["persisted"] == 1
            fresh = pg.get_task_versions([self.ids[0]])[0]
            assert fresh["RUN_TIME"] == Decimal(9)
            assert len(fresh["schedule_segments"]) == 2
            assert fresh["row_version"] == result["versions"][self.ids[0]]
        else:
            assert result["invalid_ids"] == [self.ids[0]] and result["persisted"] == 0
            assert self._row(pg) == before
            assert pg.get_task_versions([self.ids[0]])[0]["schedule_segments"] == []

    def test_atomic_batch_keeps_every_row_unchanged_when_one_candidate_fails(self, pg):
        before = [self._row(pg, oid) for oid in self.ids]
        result = pg.update_task_dates_bulk([
            {"id": self.ids[0], "base_version": before[0]["version"], "PRODUCTION_VERSION": "0002", "RUN_TIME": 9},
            {"id": self.ids[1], "base_version": before[1]["version"], "PRODUCTION_VERSION": "9999"},
        ], allowed_plants=[self.PLANT], atomic_optimizer=True)
        assert result["persisted"] == 0 and result["failed"] == 2 and result["versions"] == {}
        assert result["invalid_ids"] == [self.ids[1]]
        assert result["rejection_reasons"] == {self.ids[1]: "pv_not_found"}
        assert [self._row(pg, oid) for oid in self.ids] == before
