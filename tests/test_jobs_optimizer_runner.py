"""The optimizer.plant runner: a fake `node` (a Python script speaking the headless CLI's JSON protocol) drives
propose, apply, drop-and-warn, timeout kill, cancel kill, version refusals and step timings. No database: the bundle
gather, the snapshot-version token and the write are replaced. One test runs the real headless CLI when node exists."""
import json
import shutil
import sys
import threading
import time

import pytest

from backend.jobs.context import JobCancelled, JobContext
from backend.jobs.types import optimizer, optimizer_runner as orun

FAKE_CLI = r'''
import json, sys, time
phase = sys.argv[sys.argv.index("--phase") + 1]
body = json.loads(sys.stdin.read())
plant = body["plant"]
sys.stderr.write(json.dumps({"at": "x", "level": "info", "step": "optimize", "msg": "searching", "ms": 40}) + "\n")
sys.stderr.write("not json noise\n")
sys.stderr.flush()
if plant == "hang":
    time.sleep(60)
if plant == "crash":
    sys.exit(3)
if plant == "flood":
    sys.stdout.write("x" * 5000)
    sys.stdout.flush()
    time.sleep(60)
if plant == "longline":
    sys.stderr.write("y" * 200000 + "\n")
    sys.stderr.write(json.dumps({"level": "info", "step": "dup", "msg": "collide", "data": {"step": "other", "msg": "m", "level": "l", "duration_ms": 1, "ok": 1}}) + "\n")
    sys.stderr.flush()
items = [{"id": "1", "start_date": "2035-08-07T08:00:00", "end_date": "2035-08-07T10:00:00", "source": "optimizer", "base_version": 7, "force": False},
         {"id": "2", "start_date": "2035-08-07T10:00:00", "end_date": "2035-08-07T12:00:00", "source": "optimizer", "base_version": 8, "force": False}]
if phase == "run":
    ok = plant != "blocked"
    print(json.dumps({"ok": ok, "status": "completed", "patches": items, "findings": [], "blockers": [] if ok else ["tool_blocked:2"],
                      "summary": {"late_count": 3, "patched": 2, "setup_minutes": 90, "search_complete": True, "termination": "converged", "tool_blocked": 0},
                      "state": "STATE"}))
else:
    if plant == "refuse":
        print(json.dumps({"ok": False, "refusal": "calendar_changed", "apply": [], "dropped": []}))
    elif plant == "drop":
        print(json.dumps({"ok": True, "apply": items[:1], "dropped": [{"id": "2", "reason": "row_version_changed"}]}))
    else:
        print(json.dumps({"ok": True, "apply": items, "dropped": []}))
'''


class Params:
    def __init__(self, apply_mode="apply", search="normal"):
        self.mode, self.search, self.respect_firmed, self.apply_mode = "due_date", search, True, apply_mode


def make_ctx():
    rows = []
    ctx = JobContext(run_id=1, plant="P", job_id=9, sink=rows.extend, flush_interval_s=0)
    return ctx, rows


@pytest.fixture
def fake(tmp_path, monkeypatch):
    script = tmp_path / "fake_cli.py"
    script.write_text(FAKE_CLI, encoding="utf-8")
    monkeypatch.setattr(orun, "node_bin", lambda: sys.executable)
    monkeypatch.setattr(orun, "cli_path", lambda: str(script))
    monkeypatch.setattr(orun, "MAX_OLD_SPACE_MB", 0)
    state = {"version": "v1", "writes": [], "write_result": None}
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {
        "wire": {"masterData": {"plants": {"rows": [{"plant": plant, "timezone": "America/Chicago"}]}}},
        "server_now": "2035-08-06T13:00:00Z", "snapshot_version": state["version"]})
    import backend.scheduling.routes as sched

    def write(items, allowed, **kw):
        state["writes"].append((items, kw))
        return state["write_result"] or {"status": "ok", "persisted": len(items), "stale": [], "conflicts": []}

    monkeypatch.setattr(sched, "_apply_task_date_updates", write)
    monkeypatch.setattr(sched, "optimizer_snapshot_version", lambda plant: state["version"])
    return state


def test_propose_stores_patches_and_steps(fake):
    ctx, rows = make_ctx()
    out = orun.run_optimizer(ctx, "ok", Params("propose"))
    assert out["moved"] == 2 and out["late"] == 3
    assert out["proposal"]["base_versions"] == {"1": 7, "2": 8}
    assert fake["writes"] == []
    names = {s["step"] for s in out["steps"]}
    assert {"gather", "optimize"} <= names
    assert next(s for s in out["steps"] if s["step"] == "optimize")["duration_ms"] == 40
    assert any(r["msg"] == "node: not json noise" for r in rows)


def test_apply_posts_atomic_non_forced_batch_with_job_actor(fake):
    ctx, _ = make_ctx()
    out = orun.run_optimizer(ctx, "ok", Params())
    assert out["applied"] == 2 and out["action_id"] and "status" not in out
    items, kw = fake["writes"][0]
    assert kw["atomic_optimizer"] and kw["strict_conflicts"] and kw["actor"] == "job:9" and kw["client_id"] == "job:9"
    assert kw["ev"].source == "optimizer" and kw["ev"].action_id == out["action_id"]
    assert all(i.force is False and i.source == "optimizer" for i in items)
    assert [s["step"] for s in out["steps"]][-1] == "write"


def test_dropped_rows_warn_and_the_rest_applies(fake):
    ctx, rows = make_ctx()
    optimizer.set_runner(orun.run_optimizer)
    try:
        ctx.plant = "drop"
        outcome = optimizer.run(ctx, Params())
    finally:
        optimizer.set_runner(None)
    assert outcome.status == "warning" and outcome.summary["applied"] == 1 and outcome.summary["dropped"] == 1
    assert len(fake["writes"][0][0]) == 1
    assert any(r["level"] == "warn" and "dropped 1" in r["msg"] and "2:row_version_changed" in json.dumps(r["data"]) for r in rows)


def test_refusal_and_blockers_fail_with_nothing_written(fake):
    for plant, text in (("refuse", "calendar changed"), ("blocked", "blocked")):
        ctx, _ = make_ctx()
        out = orun.run_optimizer(ctx, plant, Params())
        assert out["status"] == "failed" and text in out["error"] and out["steps"]
    assert fake["writes"] == []


def test_snapshot_version_mismatch_fails_before_and_after_the_child(fake, monkeypatch):
    import backend.scheduling.routes as sched
    # live bundle differs from the run bundle
    calls = iter(["v1", "v2"])
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {
        "wire": {"masterData": {"plants": {"rows": [{"plant": plant, "timezone": "UTC"}]}}},
        "server_now": "2035-08-06T13:00:00Z", "snapshot_version": next(calls)})
    ctx, _ = make_ctx()
    out = orun.run_optimizer(ctx, "ok", Params())
    assert out["status"] == "failed" and "changed since the run" in out["error"]
    # token moves between the child and the write
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {
        "wire": {"masterData": {"plants": {"rows": [{"plant": plant, "timezone": "UTC"}]}}},
        "server_now": "2035-08-06T13:00:00Z", "snapshot_version": "v1"})
    monkeypatch.setattr(sched, "optimizer_snapshot_version", lambda plant: "v9")
    out = orun.run_optimizer(make_ctx()[0], "ok", Params())
    assert out["status"] == "failed" and "while applying" in out["error"]
    assert fake["writes"] == []


def test_a_refused_write_is_a_failed_run(fake):
    fake["write_result"] = {"status": "error", "error_code": "schedule.conflicts", "persisted": 0, "stale": [], "conflicts": []}
    out = orun.run_optimizer(make_ctx()[0], "ok", Params())
    assert out["status"] == "failed" and "nothing applied" in out["error"]


def test_timeout_kills_the_child(fake, monkeypatch):
    monkeypatch.setattr(orun, "BUDGET_S", {"normal": 1, "exhaustive": 1})
    monkeypatch.setattr(orun, "TIMEOUT_MARGIN_S", 0)
    t0 = time.monotonic()
    out = orun.run_optimizer(make_ctx()[0], "hang", Params())
    assert out["status"] == "failed" and "timed out" in out["error"]
    assert time.monotonic() - t0 < 15


def test_cancel_kills_the_child(fake):
    ctx, _ = make_ctx()
    threading.Timer(1.0, ctx.cancel_event.set).start()
    t0 = time.monotonic()
    with pytest.raises(JobCancelled):
        orun.run_optimizer(ctx, "hang", Params())
    assert time.monotonic() - t0 < 15


def test_a_crashing_child_is_a_failed_result_not_an_exception(fake):
    out = orun.run_optimizer(make_ctx()[0], "crash", Params())
    assert out["status"] == "failed" and "code 3" in out["error"]


def test_missing_timezone_fails_clearly(fake, monkeypatch):
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {"wire": {"masterData": {"plants": {"rows": []}}}, "server_now": "x", "snapshot_version": "v"})
    out = orun.run_optimizer(make_ctx()[0], "ok", Params())
    assert out["status"] == "failed" and "timezone" in out["error"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_real_headless_cli_runs_the_synthetic_fixture():
    import subprocess
    from pathlib import Path
    root = Path(orun.REPO_ROOT)
    cli = root / "frontend" / "optimization" / "headless-cli.mjs"
    if not cli.exists():
        pytest.skip("frontend not built (npm run build)")
    help_out = subprocess.run([shutil.which("node"), str(cli), "--help"], capture_output=True, text=True, timeout=60)
    assert help_out.returncode == 0 and "headless-cli" in help_out.stdout
    fixture = (root / "tests" / "modules" / "helpers" / "headless-wire-fixture.mjs").as_uri()
    gen = subprocess.run([shutil.which("node"), "--input-type=module", "-e",
                          f"import {{wireWithUnplaced, PLANT, SERVER_NOW}} from '{fixture}';"
                          "console.log(JSON.stringify({plant: PLANT, wire: wireWithUnplaced(), params: {mode: 'duedate',"
                          " search: 'normal', serverNow: SERVER_NOW.toISOString(), fakeClock: true, iterationCap: 400}}))"],
                         capture_output=True, text=True, timeout=60)
    assert gen.returncode == 0, gen.stderr
    run = subprocess.run([shutil.which("node"), str(cli), "--phase", "run", "--input", "-"], input=gen.stdout,
                         capture_output=True, text=True, timeout=120, env={k: v for k, v in __import__("os").environ.items() if k in orun._ENV_KEEP})
    assert run.returncode == 0, run.stderr
    result = json.loads(run.stdout)
    assert result["status"] == "completed" and result["patches"] and result["state"]
    assert '"step":"snapshot"' in run.stderr


def test_a_child_flooding_stdout_is_killed(fake, monkeypatch):
    monkeypatch.setattr(orun, "MAX_CHILD_STDOUT_BYTES", 1000)
    t0 = time.monotonic()
    out = orun.run_optimizer(make_ctx()[0], "flood", Params())
    assert out["status"] == "failed" and "bytes and was killed" in out["error"]
    assert time.monotonic() - t0 < 15


def test_overlong_stderr_line_is_dropped_and_colliding_keys_do_not_break_logging(fake):
    ctx, rows = make_ctx()
    out = orun.run_optimizer(ctx, "longline", Params("propose"))
    assert "status" not in out, out
    assert any("log line over" in r["msg"] for r in rows)
    collide = next(r for r in rows if r["msg"] == "collide")
    assert collide["step"] == "dup" and collide["data"] == {"ok": 1}
    assert not any(len(r["msg"]) > 5000 for r in rows)


def test_whole_proposal_is_measured_against_the_cap(fake, monkeypatch):
    monkeypatch.setattr(orun, "MAX_STORED_PATCH_BYTES", 150)    # the patches alone would fit, the whole object does not
    out = orun.run_optimizer(make_ctx()[0], "ok", Params("propose"))
    assert out.get("proposal_truncated") is True and "proposal" not in out


def test_apply_phase_gets_the_live_clock(fake, monkeypatch):
    seen = {}
    real = orun.run_node

    def spy(ctx, steps, phase, payload, **kw):
        seen[phase] = payload["params"]
        return real(ctx, steps, phase, payload, **kw)

    monkeypatch.setattr(orun, "run_node", spy)
    calls = iter(["2035-08-06T13:00:00Z", "2035-08-06T16:00:00Z"])
    monkeypatch.setattr(orun, "gather_bundle", lambda plant: {
        "wire": {"masterData": {"plants": {"rows": [{"plant": plant, "timezone": "America/Chicago"}]}}},
        "server_now": next(calls), "snapshot_version": "v1"})
    orun.run_optimizer(make_ctx()[0], "ok", Params())
    assert seen["run"]["serverNow"] == "2035-08-06T13:00:00Z" and "liveServerNow" not in seen["run"]
    assert seen["apply"]["serverNow"] == "2035-08-06T13:00:00Z"
    assert seen["apply"]["liveServerNow"] == "2035-08-06T16:00:00Z"


def test_bundle_token_is_read_before_the_wire_and_retried_once(monkeypatch):
    import backend.scheduling.routes as sched
    built = []
    monkeypatch.setattr(orun, "_build_bundle", lambda plant: built.append(1) or {"wire": {}, "server_now": "x"})
    tokens = iter(["a", "b", "b", "b"])          # attempt 1: before a, after b (moved) -> attempt 2: before b, after b
    monkeypatch.setattr(sched, "optimizer_snapshot_version", lambda plant: next(tokens))
    assert orun.gather_bundle("P")["snapshot_version"] == "b" and len(built) == 2
    tokens = iter(["a", "b", "c", "d"])          # never settles: the token read before the second build is kept
    monkeypatch.setattr(sched, "optimizer_snapshot_version", lambda plant: next(tokens))
    assert orun.gather_bundle("P")["snapshot_version"] == "c"


def test_kill_children_stops_a_live_child(fake):
    errors = []

    def go():
        try:
            orun.run_optimizer(make_ctx()[0], "hang", Params())
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    th = threading.Thread(target=go)
    th.start()
    for _ in range(100):
        if orun._CHILDREN:
            break
        time.sleep(0.05)
    assert orun.kill_children() == 1
    th.join(15)
    assert not th.is_alive() and not orun._CHILDREN


def test_a_cancel_that_lands_before_the_write_writes_nothing(fake, monkeypatch):
    ctx, _ = make_ctx()
    real = orun.run_node

    def spy(c, steps, phase, payload, **kw):
        out = real(c, steps, phase, payload, **kw)
        if phase == "apply":
            c.cancel_event.set()                 # e.g. the hard timeout fired while the child answered
        return out

    monkeypatch.setattr(orun, "run_node", spy)
    with pytest.raises(JobCancelled):
        orun.run_optimizer(ctx, "ok", Params())
    assert fake["writes"] == []


def test_the_run_clock_starts_once_the_slot_is_held(fake):
    ctx, _ = make_ctx()
    assert not ctx.work_started.is_set()
    orun.run_optimizer(ctx, "ok", Params("propose"))
    assert ctx.work_started.is_set()
