"""Routing edit/concurrency contracts against real, guarded local PostgreSQL.

All rows belong to an isolated ZZTEST_AR plant. Both eligibility calculation
and order writes use production code; no resolver or SQL mocks are installed.
"""
import datetime as dt
import uuid
from decimal import Decimal

import pytest

from backend.routing import resolver
from backend.scheduling.models import TaskRefreshPayload, TasksRefreshResponse, TasksUpdatePayload
from backend.scheduling.routes import tasks_refresh, tasks_update


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

    def _refresh_route(self, ids=None, allowed_plants=None):
        response = tasks_refresh(TaskRefreshPayload(ids=ids or [self.ids[0]]),
                                 allowed_plants=[self.PLANT] if allowed_plants is None else allowed_plants)
        return TasksRefreshResponse.model_validate(response).model_dump(mode="json", by_alias=True)

    def _save_route(self, snapshot, patch):
        return tasks_update(TasksUpdatePayload(tasks=[{
            "id": snapshot["id"], "base_version": snapshot["row_version"], **patch,
        }]), allowed_plants=[self.PLANT])

    @pytest.mark.parametrize("pv_echo", [None, "", "   "])
    def test_refresh_null_pv_ordinary_edit_saves_through_route(self, pg, pv_echo):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET production_version=NULL,run_time=2,run_time_source='manual' WHERE id=%s",
                        (self.ids[0],))
            conn.commit()
        fresh = self._refresh_route()["data"][0]
        assert fresh["PRODUCTION_VERSION"] is None
        result = self._save_route(fresh, {
            "PRODUCTION_VERSION": pv_echo, "RUN_TIME": fresh["RUN_TIME"], "PRT_01": "NEW-TOOL",
            "start_date": self.START.isoformat(), "end_date": (self.START + dt.timedelta(hours=2)).isoformat(),
        })
        assert result["persisted"] == 1 and result["rejection_reasons"] == {}
        assert self._row(pg)["production_version"] is None
        assert self._row(pg)["prt_01"] == "NEW-TOOL"

    @pytest.mark.parametrize("pv_clear", [None, "", "   "])
    def test_explicit_pv_clear_still_runs_eligibility_gate(self, pg, pv_clear):
        fresh = self._refresh_route()["data"][0]
        before = self._row(pg)
        result = self._save_route(fresh, {"PRODUCTION_VERSION": pv_clear, "PRT_01": "NEW-TOOL"})
        assert result["persisted"] == 0
        assert result["rejection_reasons"] == {self.ids[0]: "pv_missing"}
        assert self._row(pg) == before

    def test_omitted_pv_and_explicit_null_machine_retain_distinct_semantics(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET run_time_source='manual' WHERE id=%s", (self.ids[0],))
            conn.commit()
        fresh = self._refresh_route()["data"][0]
        result = self._save_route(fresh, {"MACHINE": None, "PRT_01": None})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["machine"] is None and row["prt_01"] is None
        assert row["production_version"] == "0001"

    @pytest.mark.parametrize("pv,hours,accepted", [("0002", 9, True), ("9999", 2, False)])
    def test_explicit_pv_edit_on_null_manual_order_still_opts_into_routing(self, pg, pv, hours, accepted):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET production_version=NULL,run_time=2,run_time_source='manual' WHERE id=%s",
                        (self.ids[0],))
            conn.commit()
        fresh = self._refresh_route()["data"][0]
        before = self._row(pg)
        result = self._save_route(fresh, {"PRODUCTION_VERSION": pv, "RUN_TIME": hours,
                                        "start_date": self.START.isoformat(),
                                        "end_date": (self.START + dt.timedelta(hours=hours)).isoformat()})
        if accepted:
            assert result["persisted"] == 1
            row = self._row(pg)
            assert row["production_version"] == pv and row["run_time"] == Decimal(hours)
            assert row["run_time_source"] == "routing"
        else:
            assert result["persisted"] == 0
            assert result["rejection_reasons"] == {self.ids[0]: "pv_not_found"}
            assert self._row(pg) == before

    def test_refresh_quantity_and_raw_baseline_allow_correct_machine_preview(self, pg):
        baseline = dt.datetime(2026, 11, 10, 9)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET order_quantity=20,basic_start_date=%s,run_time=6 WHERE id=%s",
                        (baseline, self.ids[0]))
            conn.commit()
        fresh = self._refresh_route()["data"][0]
        assert fresh["ORDER_QUANTITY_(GMEIN)"] == 20
        assert fresh["MATERIAL_NUMBER"] == self.MATERIAL and fresh["PLANT"] == self.PLANT
        assert fresh["original_start_date"] == baseline.isoformat()
        assert fresh["start_date"] == self.START.isoformat()  # baseline is not scheduled placement
        assert fresh["row_version"] == self._row(pg)["version"]
        hours = fresh["ORDER_QUANTITY_(GMEIN)"] * 6 / 10
        result = self._save_route(fresh, {"MACHINE": self.M2, "RUN_TIME": hours,
                                        "start_date": fresh["start_date"],
                                        "end_date": (self.START + dt.timedelta(hours=hours)).isoformat()})
        assert result["persisted"] == 1 and result["rejection_reasons"] == {}
        assert self._row(pg)["run_time"] == Decimal(12)

    def test_refresh_changed_baseline_controls_pv_validity(self, pg):
        baseline = dt.datetime(2028, 1, 1, 8)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE orders SET basic_start_date=%s WHERE id=%s", (baseline, self.ids[0]))
            conn.commit()
        fresh = self._refresh_route()["data"][0]
        assert fresh["original_start_date"] == baseline.isoformat()
        result = self._save_route(fresh, {"PRODUCTION_VERSION": "0002", "RUN_TIME": 9})
        assert result["persisted"] == 0 and result["rejection_reasons"] == {self.ids[0]: "pv_expired"}

    def test_refresh_runtime_inputs_remain_plant_scoped(self, pg):
        result = self._refresh_route(allowed_plants=["UNAUTHORIZED"])
        assert result == {"data": [], "missing": [self.ids[0]]}

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

    def test_planner_unscheduled_save_persists_with_null_dates_and_resolver_leaves_it_queued(self, pg):
        reason = {"code": "planner_unscheduled", "message": "Unscheduled by planner"}
        result = self._save(pg, {"planning_status": "needs_planning", "planning_reason": reason})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["planning_status"] == "needs_planning" and row["planning_reason"] == reason
        assert row["scheduled_start"] is None and row["scheduled_end"] is None
        resolver.resolve_orders(self.PLANT, full=True)
        row = self._row(pg)
        assert row["planning_status"] == "needs_planning" and row["planning_reason"] == reason
        assert row["scheduled_start"] is None and row["scheduled_end"] is None

    def test_routing_switch_on_keeps_no_order_in_place(self, pg):
        # Back to a never-switched-on plant: no routing-sourced order, wrong stored run
        # times; one order firmed by SAP, the other firmed by the planner.
        self._set(pg, "UPDATE orders SET run_time_source = NULL, run_time = 99, runtime_schedule_mismatch = FALSE,"
                      " firming_indicator = CASE WHEN id = %s THEN 'X' ELSE NULL END,"
                      " manual_firmed = (id = %s) WHERE plant = %s", (self.ids[0], self.ids[1], self.PLANT))
        report = resolver.resolve_orders(self.PLANT)
        assert report["resolved"] == 2
        assert "orders_kept_in_place" not in report
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT run_time, run_time_source, runtime_schedule_mismatch FROM orders"
                        " WHERE plant = %s ORDER BY id", (self.PLANT,))
            rows = cur.fetchall()
        assert len(rows) == 2
        for run_time, source, mismatch in rows:
            assert run_time == Decimal(3) and source == "routing"
            assert mismatch is True   # every placed order is re-placed, SAP-firmed or planner-firmed alike

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

    # ---- Bundle 1 (routing switch-on gate): re-upload / hold / resolve contracts ----
    def _upload_row(self, oid, *, quantity, plant=None, run_time=99.0, machine=None):
        return {
            "id": oid, "production_order": oid.split("|")[0], "material_number": self.MATERIAL,
            "machine": machine or self.M1, "plant": plant, "basic_start_date": self.START,
            "basic_finish_date": self.START + dt.timedelta(days=2), "run_time": run_time,
            "order_quantity": quantity, "production_version": "0001",
        }

    def _upload(self, pg, rows, **kw):
        return pg.upsert_orders(rows, batch_id=kw.pop("batch_id", str(uuid.uuid4())), source="excel",
                                filename="f.xlsx", resolve_fn=resolver.resolve_orders, **kw)

    def _set(self, pg, sql, params):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()

    def test_reupload_rederives_non_manual_run_time_when_quantity_changes(self, pg):
        # Stale-duration regression: qty 10 -> 20 must re-derive 3h -> 6h, not keep 3h or take SAP's 99.
        self._upload(pg, [self._upload_row(self.ids[0], quantity=20, plant=self.PLANT)])
        row = self._row(pg)
        assert row["run_time"] == Decimal(6) and row["run_time_source"] == "routing"

    def test_reupload_batch_rederives_sap_order_sourced_row(self, pg):
        # A 'sap_order' row is neither routing-sourced, held nor NULL, so ONLY the
        # batch clause in _load_orders can pick it up (a routing row is always
        # reloaded, which let the test above survive removing that clause).
        self._set(pg, "UPDATE orders SET run_time_source='sap_order', run_time=3 WHERE id=%s", (self.ids[0],))
        self._upload(pg, [self._upload_row(self.ids[0], quantity=20, plant=self.PLANT)])
        row = self._row(pg)
        assert row["run_time"] == Decimal(6) and row["run_time_source"] == "routing"

    def test_failed_resolve_is_repaired_by_explicit_recompute(self, pg):
        from types import SimpleNamespace
        from backend.routing.routes import recompute_plant

        def boom(plant, *, conn, batch_id=None, ids=None, protect_ids=None):
            with conn.cursor() as cur:
                cur.execute("SELECT 1/0")

        self._set(pg, "UPDATE orders SET run_time_source='sap_order', run_time=3 WHERE id=%s", (self.ids[0],))
        res = pg.upsert_orders([self._upload_row(self.ids[0], quantity=20, plant=self.PLANT)],
                               batch_id=str(uuid.uuid4()), source="excel", filename="f.xlsx", resolve_fn=boom)
        assert res["status"] == "ok"
        assert self._row(pg)["run_time"] == Decimal(3)  # stale: qty doubled, duration not re-derived
        # A routine (non-batch) resolve does not reload a plain 'sap_order' row ...
        resolver.resolve_orders(self.PLANT)
        assert self._row(pg)["run_time"] == Decimal(3)
        # ... the explicit admin recompute re-derives every non-manual order.
        recompute_plant(self.PLANT, SimpleNamespace(state=SimpleNamespace()), allowed_plants=[self.PLANT])
        row = self._row(pg)
        assert row["run_time"] == Decimal(6) and row["run_time_source"] == "routing"

    def test_unresolvable_non_manual_order_is_held_not_kept_as_legacy(self, pg):
        # Routing cannot resolve (no production version row for 9999) and there is no
        # machine_hours: a stored non-manual run time must not survive as 'legacy'.
        self._set(pg, "UPDATE orders SET run_time_source='sap_order', run_time=3, production_version='9999'"
                      " WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT, full=True)
        row = self._row(pg)
        assert row["planning_status"] == "needs_planning"
        assert row["planning_reason"]["code"] == "runtime_unknown"
        assert row["run_time_source"] == "sap_order"

    def test_reupload_keeps_manual_run_time_when_row_unchanged(self, pg):
        # First upload records SAP's baseline; the identical second upload is skipped,
        # so the planner's manual run time is untouched.
        self._upload(pg, [self._upload_row(self.ids[0], quantity=10, plant=self.PLANT)])
        self._set(pg, "UPDATE orders SET run_time=7, run_time_source='manual' WHERE id=%s", (self.ids[0],))
        before = self._row(pg)
        self._upload(pg, [self._upload_row(self.ids[0], quantity=10, plant=self.PLANT)])
        row = self._row(pg)
        assert row["run_time"] == Decimal(7) and row["run_time_source"] == "manual"
        assert row["version"] == before["version"]

    def test_reupload_recalculates_manual_run_time_when_sap_changed_the_row(self, pg):
        # SAP sent a different quantity: the row is written, the manual run time is dropped
        # and the resolver recalculates it from routing (quantity 20 -> 6h).
        self._upload(pg, [self._upload_row(self.ids[0], quantity=10, plant=self.PLANT)])
        self._set(pg, "UPDATE orders SET run_time=7, run_time_source='manual' WHERE id=%s", (self.ids[0],))
        self._upload(pg, [self._upload_row(self.ids[0], quantity=20, plant=self.PLANT)])
        row = self._row(pg)
        assert row["run_time"] == Decimal(6) and row["run_time_source"] == "routing"

    def test_first_upload_after_migration_keeps_manual_run_time(self, pg):
        # Baselines are NULL (fixture rows predate them): filling them is not "SAP changed it".
        self._set(pg, "UPDATE orders SET run_time=7, run_time_source='manual' WHERE id=%s", (self.ids[0],))
        line = self._upload_row(self.ids[0], quantity=10, plant=self.PLANT)
        line["production_order"] = "ZZTEST_AR_O1"   # exactly what the fixture row already holds
        self._upload(pg, [line])
        row = self._row(pg)
        assert row["run_time"] == Decimal(7) and row["run_time_source"] == "manual"

    def test_reupload_without_plant_column_still_holds_resolves_and_keeps_manual(self, pg):
        # No PLANT column: plant is only known after the machine backfill.
        self._upload(pg, [self._upload_row(self.ids[1], quantity=10)])  # records the baseline
        self._set(pg, "UPDATE orders SET run_time=7, run_time_source='manual' WHERE id=%s", (self.ids[1],))
        new_id = pg.make_id("ZZTEST_AR_O3", self.MATERIAL)
        res = self._upload(pg, [
            self._upload_row(self.ids[0], quantity=20),
            self._upload_row(self.ids[1], quantity=10),
            self._upload_row(new_id, quantity=30),
        ])
        assert res["status"] == "ok"
        assert self._row(pg, self.ids[0])["run_time"] == Decimal(6)
        assert self._row(pg, self.ids[1])["run_time"] == Decimal(7)
        fresh = self._row(pg, new_id)
        # held as runtime_pending, then released by the resolve (pending code recognised)
        assert fresh["run_time"] == Decimal(9) and fresh["run_time_source"] == "routing"
        assert fresh["planning_status"] == "scheduled" and fresh["planning_reason"] is None
        assert any(w.get("category") == "routing_resolve" and w.get("plant") == self.PLANT
                   for w in res["warnings"])

    def test_plantless_upload_new_row_is_held_runtime_pending_until_resolved(self, pg):
        # Hold half of the no-PLANT path: plant is only known after the machine
        # backfill, so the new row must still be held when the resolver is reached
        # (and stay held if that resolve does nothing), then be released by a real one.
        new_id = pg.make_id("ZZTEST_AR_O3", self.MATERIAL)
        seen = {}

        def spy(plant, *, conn, batch_id=None, ids=None, protect_ids=None):
            with conn.cursor() as cur:
                cur.execute("SELECT planning_status, planning_reason->>'code' FROM orders WHERE id=%s",
                            (new_id,))
                seen[plant] = cur.fetchone()
            return {"status": "ok"}

        res = pg.upsert_orders([self._upload_row(new_id, quantity=30)], batch_id=str(uuid.uuid4()),
                               source="excel", filename="f.xlsx", resolve_fn=spy)
        assert res["status"] == "ok"
        assert seen == {self.PLANT: ("needs_planning", "runtime_pending")}
        held = self._row(pg, new_id)
        assert held["planning_status"] == "needs_planning"
        assert held["planning_reason"]["code"] == "runtime_pending"
        resolver.resolve_orders(self.PLANT)
        done = self._row(pg, new_id)
        assert done["planning_status"] == "scheduled" and done["planning_reason"] is None
        assert done["run_time"] == Decimal(9) and done["run_time_source"] == "routing"

    def test_runtime_pending_hold_is_released_by_resolve(self, pg):
        self._set(pg, "UPDATE orders SET planning_status='needs_planning', scheduled_start=NULL,"
                      " scheduled_end=NULL, run_time_source=NULL, run_time=NULL,"
                      " planning_reason='{\"code\":\"runtime_pending\",\"message\":\"x\"}'::jsonb"
                      " WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT)
        row = self._row(pg)
        assert row["planning_status"] == "scheduled" and row["planning_reason"] is None
        assert row["run_time"] == Decimal(3)

    def test_planner_run_time_releases_runtime_pending_hold(self, pg):
        self._set(pg, "UPDATE orders SET planning_status='needs_planning', scheduled_start=NULL,"
                      " scheduled_end=NULL, run_time_source=NULL, run_time=NULL,"
                      " planning_reason='{\"code\":\"runtime_pending\",\"message\":\"x\"}'::jsonb"
                      " WHERE id=%s", (self.ids[0],))
        result = self._save(pg, {"RUN_TIME": 5})
        assert result["persisted"] == 1
        row = self._row(pg)
        assert row["run_time_source"] == "manual" and row["planning_status"] == "scheduled"

    def test_resolver_failure_becomes_upload_warning_not_failed_upload(self, pg):
        def boom(plant, *, conn, batch_id=None, ids=None, protect_ids=None):
            with conn.cursor() as cur:
                cur.execute("SELECT 1/0")

        boom_batch = str(uuid.uuid4())
        res = pg.upsert_orders([self._upload_row(self.ids[0], quantity=20, plant=self.PLANT)],
                               batch_id=boom_batch, source="excel", filename="f.xlsx",
                               resolve_fn=boom)
        assert res["status"] == "ok" and res["updated"] == 1
        failed = [w for w in res["warnings"] if w.get("category") == "routing_resolve"]
        assert failed and failed[0]["status"] == "failed" and failed[0]["level"] == "warn"
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT warnings FROM upload_audit WHERE batch_id=%s", (boom_batch,))
            assert cur.fetchone() is not None
            cur.execute("DELETE FROM upload_audit WHERE batch_id=%s", (boom_batch,))
            conn.commit()

    def test_disabled_plant_reupload_unchanged_sap_run_time_wins(self, pg):
        self._set(pg, "UPDATE plants SET routing_runtime_enabled=FALSE WHERE plant=%s", (self.PLANT,))
        self._upload(pg, [self._upload_row(self.ids[0], quantity=20, plant=self.PLANT, run_time=99.0)])
        assert self._row(pg)["run_time"] == Decimal(99)

    def test_disabled_plant_leftover_manual_row_sap_wins_on_reupload(self, pg):
        self._set(pg, "UPDATE plants SET routing_runtime_enabled=FALSE WHERE plant=%s", (self.PLANT,))
        self._set(pg, "UPDATE orders SET run_time=7, run_time_source='manual' WHERE id=%s", (self.ids[0],))
        self._upload(pg, [self._upload_row(self.ids[0], quantity=20, plant=self.PLANT, run_time=99.0)])
        assert self._row(pg)["run_time"] == Decimal(99)

    # ---- audit fix round: a running order is never held (F1) / a hold clears firm + segments (F2) ----
    def _make_running(self, pg, oid=None, *, firm=True):
        from zoneinfo import ZoneInfo
        now = dt.datetime.now(ZoneInfo("America/New_York")).replace(tzinfo=None)
        start, end = now - dt.timedelta(hours=1), now + dt.timedelta(hours=2)
        self._set(pg, "UPDATE orders SET scheduled_start=%s, scheduled_end=%s, basic_start_date=%s,"
                      " basic_finish_date=%s, run_time=3, manual_firmed=%s WHERE id=%s",
                  (start, end, start, end, firm, oid or self.ids[0]))
        return start, end

    def _state(self, pg, oid=None):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT planning_status, scheduled_start, manual_firmed,"
                        " (SELECT count(*) FROM order_schedule_segments WHERE order_id = o.id)"
                        " FROM orders o WHERE id=%s", (oid or self.ids[0],))
            return cur.fetchone()

    def test_running_order_stays_scheduled_when_sap_changes_pv_to_one_without_routing(self, pg):
        start, end = self._make_running(pg)

        def line(**kw):   # fresh dict per upload: upsert_orders annotates the rows it is given
            return dict(self._upload_row(self.ids[0], quantity=10, plant=self.PLANT),
                        basic_start_date=start, basic_finish_date=end, **kw)

        self._upload(pg, [line()])                      # records SAP's baseline
        res = self._upload(pg, [line(production_version="9999")])
        status, sched_start, firmed, _ = self._state(pg)
        assert status == "scheduled" and sched_start == start and firmed is True
        warn = next(w for w in res["warnings"] if w.get("category") == "sap_changed_running")
        assert self.ids[0] in warn["order_ids"]
        assert "kept" in warn["msg"]

    def test_full_resolve_never_holds_a_running_order(self, pg):
        start, _ = self._make_running(pg)
        self._set(pg, "UPDATE orders SET production_version='9999' WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT, full=True)
        status, sched_start, firmed, _ = self._state(pg)
        assert status == "scheduled" and sched_start == start and firmed is True
        # ... while an identical order that is NOT running is held as before.
        self._set(pg, "UPDATE orders SET production_version='9999' WHERE id=%s", (self.ids[1],))
        resolver.resolve_orders(self.PLANT, full=True)
        assert self._state(pg, self.ids[1])[0] == "needs_planning"

    def test_protect_ids_are_never_held(self, pg):
        self._set(pg, "UPDATE orders SET production_version='9999' WHERE id=%s", (self.ids[1],))
        resolver.resolve_orders(self.PLANT, full=True, protect_ids=[self.ids[1]])
        assert self._state(pg, self.ids[1])[0] == "scheduled"

    def test_hold_clears_manual_firm_and_segments_and_release_leaves_no_stale_bar(self, pg):
        t0 = dt.datetime(2026, 10, 20, 8)
        self._set(pg, "UPDATE orders SET manual_firmed=TRUE, scheduled_start=%s, scheduled_end=%s WHERE id=%s",
                  (t0, t0 + dt.timedelta(hours=3), self.ids[0]))
        self._set(pg, "INSERT INTO order_schedule_segments(order_id, segment_no, scheduled_start, scheduled_end)"
                      " VALUES (%s,1,%s,%s),(%s,2,%s,%s)",
                  (self.ids[0], t0, t0 + dt.timedelta(hours=1), self.ids[0],
                   t0 + dt.timedelta(hours=5), t0 + dt.timedelta(hours=7)))
        self._set(pg, "UPDATE orders SET production_version='9999' WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT, full=True)
        assert self._state(pg) == ("needs_planning", None, False, 0)
        self._set(pg, "UPDATE orders SET production_version='0001' WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT, full=True)
        status, sched_start, firmed, segments = self._state(pg)
        assert (status, sched_start, firmed, segments) == ("scheduled", None, False, 0)
        task = pg.get_task_versions([self.ids[0]])[0]
        assert not task["schedule_segments"]

    def test_running_kept_is_reported_in_plain_words(self, pg):
        start, end = self._make_running(pg)

        def line(**kw):
            return dict(self._upload_row(self.ids[0], quantity=10, plant=self.PLANT),
                        basic_start_date=start, basic_finish_date=end, **kw)

        self._upload(pg, [line()])
        res = self._upload(pg, [line(production_version="9999")])
        warn = next(w for w in res["warnings"] if w.get("category") == "routing_running_kept")
        assert warn["count"] == 1 and "running" in warn["msg"] and "run time" in warn["msg"]

    def test_repeat_resolve_of_an_already_held_order_does_not_touch_it(self, pg):
        self._set(pg, "UPDATE orders SET production_version='9999' WHERE id=%s", (self.ids[0],))
        resolver.resolve_orders(self.PLANT, full=True)
        before = self._row(pg)
        # a segment added after the hold must survive a repeat resolve that changes nothing
        self._set(pg, "INSERT INTO order_schedule_segments(order_id, segment_no, scheduled_start, scheduled_end)"
                      " VALUES (%s,1,%s,%s)", (self.ids[0], self.START, self.START + dt.timedelta(hours=1)))
        resolver.resolve_orders(self.PLANT, full=True)
        assert self._row(pg)["version"] == before["version"]
        assert self._state(pg)[3] == 1, "an already-held row is not a transition: no segment delete"
