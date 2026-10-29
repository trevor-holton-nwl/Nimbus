"""Jobs W4b step types, no database: Remove Backlog through the shared optimizer runner (node params, include_running,
propose / apply), routing.recompute, attributes.resync, sap.apply_batch (against fakes of the staging functions) and the
Send to SAP scaffold (refused at save, at the chain's guard and at the run's guard)."""
import json
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response

import backend.jobs.types  # noqa: F401  (registers every type)
from backend.jobs import routes, runner
from backend.jobs.context import JobContext
from backend.jobs.registry import REGISTRY, get_type, list_types
from backend.jobs.types import backlog, chain, optimizer, optimizer_runner as orun, order_steps, sap_steps


def make_ctx(plant="P", job_id=9):
    rows = []
    return JobContext(run_id=1, plant=plant, job_id=job_id, sink=rows.extend, flush_interval_s=0), rows


# --------------------------------------------------------------------------------------------- optimizer.backlog
ECHO_CLI = r'''
import json, sys
phase = sys.argv[sys.argv.index("--phase") + 1]
body = json.loads(sys.stdin.read())
items = [{"id": "1", "start_date": "2035-08-07T08:00:00", "end_date": "2035-08-07T10:00:00", "source": "optimizer", "base_version": 7, "force": False}]
if phase == "run":
    sys.stderr.write(json.dumps({"level": "info", "step": "params", "msg": "got", "data": {"node_params": body["params"]}}) + "\n")
    print(json.dumps({"ok": True, "status": "completed", "patches": items, "findings": [], "blockers": [],
                      "summary": {"patched": 1, "backlog": {"found": 3, "moved": 1, "running_moved": 1, "running_skipped": 0}}, "state": "S"}))
else:
    print(json.dumps({"ok": True, "apply": items, "dropped": []}))
'''


@pytest.fixture
def echo(tmp_path, monkeypatch):
    script = tmp_path / "echo_cli.py"
    script.write_text(ECHO_CLI, encoding="utf-8")
    monkeypatch.setattr(orun, "node_bin", lambda: sys.executable)
    monkeypatch.setattr(orun, "cli_path", lambda: str(script))
    monkeypatch.setattr(orun, "MAX_OLD_SPACE_MB", 0)
    state = {"writes": []}
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {
        "wire": {"masterData": {"plants": {"rows": [{"plant": plant, "timezone": "America/Chicago"}]}}},
        "server_now": "2035-08-06T13:00:00Z", "snapshot_version": "v1"})
    import backend.scheduling.routes as sched
    monkeypatch.setattr(sched, "_apply_task_date_updates",
                        lambda items, allowed, **kw: state["writes"].append((items, kw)) or {"status": "ok", "persisted": len(items), "stale": [], "conflicts": []})
    monkeypatch.setattr(sched, "optimizer_snapshot_version", lambda plant: "v1")
    optimizer.set_runner(orun.run_optimizer)
    yield state
    optimizer.set_runner(None)


def test_backlog_type_contract():
    jt = REGISTRY["optimizer.backlog"]
    assert "is_backlog" not in backlog.BacklogParams.model_fields, "the runner switch is not a param"
    assert backlog.BacklogParams().model_dump() == {"include_running": True, "apply_mode": "apply"}
    assert (jt.idempotent, jt.mutates, jt.dry_run, jt.needs_plant_timezone, jt.defer_clock) == (False, True, ("apply_mode", "propose"), True, True)
    assert jt.lock_names("P1", backlog.BacklogParams()) == ["jobs:optimizer.backlog:P1", "jobs:optimizer.plant:P1"]
    assert jt.slot_list(backlog.BacklogParams()) == [REGISTRY["optimizer.plant"].slot()], "the optimizer's own slot"
    assert jt.is_dry_run(backlog.BacklogParams(apply_mode="propose")) is True
    # a purge, an optimizer and a backlog on one plant all share the optimizer's lock
    assert "jobs:optimizer.plant:P1" in REGISTRY["purge.orders"].lock_names("P1", REGISTRY["purge.orders"].params_model())
    assert jt.timeout_for(backlog.BacklogParams()) == 120


def test_backlog_run_sends_backlog_mode_with_running_orders_by_default_and_writes_as_the_optimizer(echo):
    ctx, rows = make_ctx()
    out = backlog.run(ctx, backlog.BacklogParams())
    assert out.status == "succeeded" and out.summary["applied"] == 1 and out.summary["mode"] == "backlog"
    assert out.summary["include_running"] is True and out.summary["backlog"]["found"] == 3
    sent = next(r for r in rows if r["step"] == "params")["data"]["node_params"]
    assert sent["mode"] == "backlog" and sent["include_running"] is True and sent["plantTimezone"] == "America/Chicago"
    assert "respect_firmed" not in sent, "backlog has no firmed option"
    items, kw = echo["writes"][0]
    assert kw["atomic_optimizer"] and kw["strict_conflicts"] and kw["actor"] == "job:9" and kw["ev"].source == "optimizer"


def test_backlog_include_running_off_is_passed_to_the_engine(echo):
    ctx, rows = make_ctx()
    out = backlog.run(ctx, backlog.BacklogParams(include_running=False))
    assert out.summary["include_running"] is False
    assert next(r for r in rows if r["step"] == "params")["data"]["node_params"]["include_running"] is False


def test_backlog_dry_run_stores_a_proposal_and_writes_nothing(echo):
    ctx, _ = make_ctx()
    out = backlog.run(ctx, backlog.BacklogParams(apply_mode="propose"))
    assert out.status == "succeeded" and out.summary["apply_mode"] == "propose"
    assert out.summary["proposal"]["base_versions"] == {"1": 7} and "applied" not in out.summary
    assert echo["writes"] == [], "a dry run is read-only"


def test_backlog_dropped_orders_make_it_a_warning(monkeypatch):
    monkeypatch.setattr(optimizer, "_runner", lambda ctx, plant, p: {"moved": 3, "applied": 2, "dropped": 1})
    ctx, _ = make_ctx()
    out = backlog.run(ctx, backlog.BacklogParams())
    assert out.status == "warning" and out.summary["dropped"] == 1
    monkeypatch.setattr(optimizer, "_runner", lambda ctx, plant, p: {"status": "failed", "error": "calendar changed"})
    assert backlog.run(make_ctx()[0], backlog.BacklogParams()).status == "failed"


def test_the_optimizer_runner_still_reads_its_own_params_for_a_plain_optimizer_run(echo):
    ctx, rows = make_ctx()
    optimizer.run(ctx, optimizer.OptimizerParams(mode="spt", search="normal"))
    sent = next(r for r in rows if r["step"] == "params")["data"]["node_params"]
    assert sent["mode"] == "spt" and sent["respect_firmed"] is True and "include_running" not in sent


def test_the_proposal_route_accepts_a_backlog_dry_run():
    assert "optimizer.backlog" in routes._PROPOSAL_TYPES and "optimizer.backlog" in routes._OPTIMIZER_TYPES


# --------------------------------------------------------------------------------------------- routing.recompute
def test_routing_recompute_is_a_noop_with_a_message_on_a_routing_off_plant(monkeypatch):
    monkeypatch.setattr(order_steps, "_routing_enabled", lambda plant: False)
    import backend.routing.resolver as resolver
    monkeypatch.setattr(resolver, "resolve_orders", lambda *a, **k: pytest.fail("must not resolve a routing-off plant"))
    ctx, rows = make_ctx()
    out = order_steps.run_routing_recompute(ctx, order_steps.RoutingRecomputeParams())
    assert out.status == "succeeded" and out.summary["routing_enabled"] is False and out.summary["skipped"] == "routing_off"
    assert any("switched off" in r["msg"] for r in rows)


def test_routing_recompute_wraps_the_resolver_with_the_job_actor(monkeypatch):
    calls = []
    import backend.routing.resolver as resolver
    monkeypatch.setattr(order_steps, "_routing_enabled", lambda plant: True)
    monkeypatch.setattr(resolver, "resolve_orders", lambda plant, **kw: calls.append((plant, kw)) or {
        "resolved": 12, "unknown_by_step": {"a": 2, "b": 1}, "legacy_retained": 4, "pv_defaulted": 1, "over_cap": 2, "unmapped_workcenters": ["W1"]})
    ctx, _ = make_ctx(plant="1008", job_id=77)
    out = order_steps.run_routing_recompute(ctx, order_steps.RoutingRecomputeParams())
    assert calls == [("1008", {"full": True, "actor": "job:77"})]
    assert out.status == "warning" and out.summary["resolved"] == 12 and out.summary["unknown"] == 3
    assert out.summary["warnings"] == ["3 order(s) held for unknown routing data", "2 order(s) over the run-time cap"]
    assert out.summary["unmapped_workcenters"] == 1 and out.summary["over_cap"] == 2


def test_routing_and_attribute_steps_declare_what_they_are():
    for key in ("routing.recompute", "attributes.resync"):
        jt = REGISTRY[key]
        assert (jt.idempotent, jt.mutates, jt.dry_run, jt.available) == (True, True, None, True)
        assert jt.lock_names("P1", jt.params_model()) == sorted([f"jobs:{key}:P1", "jobs:optimizer.plant:P1"])
        assert jt.is_dry_run(jt.params_model()) is False, "no dry run: it always applies"


# --------------------------------------------------------------------------------------------- attributes.resync
def test_attributes_resync_wraps_the_db_function_with_the_job_actor(monkeypatch):
    calls = []
    monkeypatch.setattr(order_steps.db, "resync_order_attributes", lambda plant, actor=None: calls.append((plant, actor)) or {
        "unmatched_pairs": 2, "unmatched_orders": 5, "exceptions": [{"plant": plant}]})
    ctx, _ = make_ctx(plant="1008", job_id=5)
    out = order_steps.run_attributes_resync(ctx, order_steps.AttributesResyncParams())
    assert calls == [("1008", "job:5")]
    assert out.status == "warning" and out.summary["unmatched_pairs"] == 2 and out.summary["unmatched_orders"] == 5
    assert "2 material(s)" in out.summary["warnings"][0], "unmatched materials make the step yellow, with the counts"
    monkeypatch.setattr(order_steps.db, "resync_order_attributes", lambda plant, actor=None: {"unmatched_pairs": 0, "unmatched_orders": 0})
    assert order_steps.run_attributes_resync(make_ctx()[0], order_steps.AttributesResyncParams()).status == "succeeded"


def test_order_steps_classify_a_database_timeout_as_transient(monkeypatch):
    class QueryCanceled(Exception):
        pass
    def boom(*a, **k):
        raise QueryCanceled("canceling statement due to statement timeout")
    monkeypatch.setattr(order_steps.db, "resync_order_attributes", boom)
    out = order_steps.run_attributes_resync(make_ctx()[0], order_steps.AttributesResyncParams())
    assert out.status == "failed" and out.summary["error_kind"] == "transient"
    import backend.routing.resolver as resolver
    monkeypatch.setattr(order_steps, "_routing_enabled", lambda plant: True)
    monkeypatch.setattr(resolver, "resolve_orders", boom)
    assert order_steps.run_routing_recompute(make_ctx()[0], order_steps.RoutingRecomputeParams()).summary["error_kind"] == "transient"
    monkeypatch.setattr(order_steps.db, "resync_order_attributes", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad")))
    with pytest.raises(ValueError):
        order_steps.run_attributes_resync(make_ctx()[0], order_steps.AttributesResyncParams())


# --------------------------------------------------------------------------------------------- sap.apply_batch
class FakeStaging:
    """Stands in for backend.integration.sap_staging: newest batch per object, and an apply that can raise."""
    APPLY_ORDER = ("stage_material_plants", "stage_production_version", "stage_routing_operation", "stage_planned_orders")

    class BatchNotApplicable(Exception):
        def __init__(self, message, detail=None):
            super().__init__(message)
            self.detail = detail or {}

    class BatchSuperseded(BatchNotApplicable):
        pass

    def __init__(self, newest):
        self.newest, self.applied, self.raises, self.once, self.listed = newest, [], {}, {}, 0

    def list_batches(self, *, object_key=None, plant=None, limit=1, **kw):
        self.listed += 1
        b = self.newest.get(object_key)
        return [{"batch_id": f"b-{object_key}", "status": b}] if b else []

    def apply_batch(self, batch_id, *, actor, confirm_held=False):
        key = batch_id[2:]
        if key in self.once:
            raise self.once.pop(key)
        if key in self.raises:
            raise self.raises[key]
        self.applied.append((key, actor, confirm_held))
        return {"batch_id": batch_id, "status": "applied", "counts": {"rows": 3}}


@pytest.fixture
def staging(monkeypatch):
    def install(newest):
        fake = FakeStaging(newest)
        import backend.integration.sap_staging as real
        for name in ("APPLY_ORDER", "list_batches", "apply_batch", "BatchNotApplicable", "BatchSuperseded"):
            monkeypatch.setattr(real, name, getattr(fake, name) if name in ("list_batches", "apply_batch") else getattr(FakeStaging, name))
        return fake
    return install


def test_sap_apply_applies_the_validated_batches_in_staging_order_as_the_job(staging):
    fake = staging({"stage_planned_orders": "validated", "stage_material_plants": "validated", "stage_production_version": "applied"})
    out = sap_steps.run_apply(make_ctx(plant="1008", job_id=4)[0], sap_steps.SapApplyParams())
    assert [a[0] for a in fake.applied] == ["stage_material_plants", "stage_planned_orders"]
    assert all(a[1] == "job:4" and a[2] is False for a in fake.applied), "never confirms a held batch"
    assert out.status == "succeeded" and out.summary["applied_batches"] == 2


def test_sap_apply_with_nothing_validated_is_a_clear_noop(staging):
    fake = staging({})
    ctx, rows = make_ctx()
    out = sap_steps.run_apply(ctx, sap_steps.SapApplyParams())
    assert fake.applied == [] and out.status == "succeeded" and out.summary["note"] == "no validated batch to apply"
    assert any("no validated batch" in r["msg"] for r in rows)


def test_sap_apply_fails_on_a_held_or_failed_batch_and_never_applies_it(staging):
    fake = staging({"stage_material_plants": "held", "stage_production_version": "validated", "stage_planned_orders": "ready"})
    out = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams())
    assert fake.applied == [], "a held batch is never confirmed and the later objects do not run"
    assert out.status == "failed" and out.summary["error_kind"] == "config" and "a person must review the held batch" in out.error
    assert out.summary["notes"] == [{"object": "stage_material_plants", "batch_id": "b-stage_material_plants", "result": "held"}]
    err = staging({"stage_production_version": "error"})
    assert sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams()).status == "failed"
    ready = staging({"stage_planned_orders": "ready"})
    ok = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams())
    assert ok.status == "succeeded" and ready.applied == [] and ok.summary["notes"][-1]["result"] == "ready"


def test_sap_apply_dry_run_only_warns_about_a_held_batch(staging):
    staging({"stage_material_plants": "held"})
    out = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams(dry_run=True))
    assert out.status == "warning" and "a person must review the held batch" in out.summary["warnings"][0]


def test_sap_apply_relists_once_when_the_batch_was_superseded(staging):
    fake = staging({"stage_material_plants": "validated"})
    fake.once["stage_material_plants"] = FakeStaging.BatchSuperseded("a newer complete batch exists")
    out = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams())
    assert out.status == "succeeded" and [a[0] for a in fake.applied] == ["stage_material_plants"] and fake.listed >= 5
    both = staging({"stage_material_plants": "validated", "stage_production_version": "validated"})
    both.raises["stage_material_plants"] = FakeStaging.BatchSuperseded("again")
    out2 = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams())
    assert out2.status == "warning" and "superseded" in out2.summary["warnings"][0]
    assert [a[0] for a in both.applied] == ["stage_production_version"], "the other objects still apply"


def test_sap_apply_dry_run_lists_without_applying_and_objects_can_be_chosen(staging):
    fake = staging({"stage_material_plants": "validated", "stage_planned_orders": "validated"})
    out = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams(dry_run=True, objects=["stage_planned_orders"]))
    assert fake.applied == [] and [n["object"] for n in out.summary["notes"]] == ["stage_planned_orders"]
    assert out.summary["notes"][0]["result"] == "would_apply" and REGISTRY["sap.apply_batch"].is_dry_run(sap_steps.SapApplyParams(dry_run=True)) is True
    with pytest.raises(ValueError):
        sap_steps.SapApplyParams(objects=[])


def test_sap_apply_failures_stop_later_objects_and_are_classified(staging):
    fake = staging({"stage_material_plants": "validated", "stage_production_version": "validated"})
    fake.raises["stage_material_plants"] = FakeStaging.BatchNotApplicable("routing must be enabled", {"code": "routing_required"})
    out = sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams())
    assert out.status == "failed" and out.summary["error_kind"] == "config" and out.summary["failed_step"] == "apply stage_material_plants"
    assert fake.applied == [], "a later object is never applied after a failure"
    fake2 = staging({"stage_material_plants": "validated"})
    fake2.raises["stage_material_plants"] = FakeStaging.BatchNotApplicable("busy", {"code": "apply_in_progress"})
    assert sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams()).summary["error_kind"] == "transient"
    fake3 = staging({"stage_material_plants": "validated"})
    fake3.raises["stage_material_plants"] = RuntimeError("db down")
    assert sap_steps.run_apply(make_ctx()[0], sap_steps.SapApplyParams()).summary["error_kind"] == "system"


def test_sap_apply_type_contract():
    jt = REGISTRY["sap.apply_batch"]
    assert (jt.idempotent, jt.mutates, jt.available, jt.dry_run) == (True, True, True, ("dry_run", True))
    assert jt.lock_names("P1", sap_steps.SapApplyParams()) == ["jobs:optimizer.plant:P1", "jobs:sap.apply_batch:P1"]


# --------------------------------------------------------------------------------------------- Send to SAP scaffold
def test_send_to_sap_is_registered_unavailable_and_listed_with_its_reason():
    jt = REGISTRY["sap.send"]
    assert (jt.available, jt.unavailable_reason, jt.idempotent, jt.mutates) == (False, "SAP interface is not live", False, True)
    body = routes.job_types(Response())
    served = {t["key"]: t for t in body["types"]}
    assert served["sap.send"]["available"] is False and served["sap.send"]["unavailable_reason"] == "SAP interface is not live"
    assert "sap.send" in [t.key for t in list_types()] and all(t["available"] for k, t in served.items() if k != "sap.send")
    assert get_type("sap.send") is jt


def test_send_to_sap_params_fix_the_precondition():
    p = sap_steps.SapSendParams()
    assert p.plant is None and p.only_if_previous_steps_succeeded is True
    with pytest.raises(ValueError):
        sap_steps.SapSendParams(only_if_previous_steps_succeeded=False)


def test_send_to_sap_is_refused_when_saving_a_job_or_a_chain_step():
    jt = REGISTRY["sap.send"]
    with pytest.raises(HTTPException) as e:
        routes._validate_params(jt, {}, plant="P1")
    assert e.value.status_code == 400 and "not available yet" in e.value.detail and "SAP interface is not live" in e.value.detail
    with pytest.raises(ValueError, match="step 2.*not available yet"):
        chain.normalize_steps([{"type": "optimizer.plant", "params": {}}, {"type": "sap.send", "params": {}}])


def test_send_to_sap_never_runs_even_if_a_row_exists():
    # the run guard: _prepare refuses it before any body starts
    jt, params, err = runner._prepare({"job_type": "sap.send", "params": {}})
    assert params is None and "not available yet" in err
    # the chain's own guard: a stored snapshot (a restart) bypasses the save-time check, so the run stops before step 1
    steps = chain.ChainParams.model_construct(steps=[
        chain.StepSpec(type="noop", params={"steps": 1, "sleep_s": 0, "outcome": "succeeded"}),
        chain.StepSpec(type="sap.send", params={})])
    chain._store = SimpleNamespace(run_resume=lambda run_id: None)
    try:
        ctx, rows = make_ctx()
        out = chain.run(ctx, steps)
    finally:
        import backend.jobs.data as data
        chain._store = data
    assert out.status == "failed" and out.summary["error_kind"] == "config" and out.summary["failed_step"] == "validate"
    assert "step 2" in out.error and "not available yet" in out.error and any(r["level"] == "error" for r in rows)
    # and the body itself refuses, whatever calls it
    with pytest.raises(RuntimeError, match="not available yet"):
        sap_steps.run_send(make_ctx()[0], sap_steps.SapSendParams())


def test_send_to_sap_does_not_call_the_sap_send_code():
    import inspect
    body = inspect.getsource(sap_steps.run_send).split('"""')[-1]       # the body after its docstring
    assert "sap_staging" not in body and "send" not in body.replace("Send to SAP", "").lower().replace("not available", "")
