"""Real runner for `optimizer.plant`: gather one plant bundle in-process, run the headless optimizer in a Node child.

Wired through `optimizer.set_runner(run_optimizer)` in `scheduler.install` (the lifespan), so tests and tools that
import `backend.jobs.types.optimizer` keep the unwired seam.

Flow (one plant per Node process, `TZ=<plant timezone>`, `--max-old-space-size`, stdin/stdout JSON):
  gather bundle -> `--phase run` -> propose: keep the patches on the run summary, done
                                 -> apply:   fresh bundle -> `--phase apply` (drops changed-row_version families,
                                    refuses on calendar / tool inventory / error findings) -> snapshot-version check
                                    -> post the survivors in-process through `_apply_task_date_updates` (atomic,
                                    strict conflicts, never forced, actor `job:<id>`).
A hard timeout (search budget + 60 s) and a cancel both kill the child. The child never gets the DB credentials.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from backend.jobs.context import JobCancelled

REPO_ROOT = Path(__file__).resolve().parents[3]
MODE_MAP = {"due_date": "duedate", "min_changeover": "changeover", "spt": "spt"}
BUDGET_S = {"normal": 8, "exhaustive": 180}      # mirrors SETUP_AWARE_*_BUDGET_MS in engine.mts
TIMEOUT_MARGIN_S = 60
MAX_OLD_SPACE_MB = int(os.environ.get("NIMBUS_OPTIMIZER_NODE_MB", "1536") or 1536)
MAX_STORED_PATCH_BYTES = 256 * 1024              # job_run.summary is JSONB: a bigger proposal keeps counts only
MAX_CHILD_STDOUT_BYTES = 64 * 1024 * 1024        # a runaway child is killed past this (the answer is one JSON line)
MAX_STDERR_LINE_BYTES = 64 * 1024                # a longer log line is cut and noted; the child is not trusted to be polite
_ENV_KEEP = ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "LANG")


def _concurrency() -> int:
    try:
        return max(1, min(2, int(os.environ.get("NIMBUS_OPTIMIZER_CONCURRENCY", "1"))))
    except ValueError:
        return 1


_SLOTS = threading.BoundedSemaphore(_concurrency())
_CHILDREN: set = set()                           # live node processes, so a shutdown can kill them (runner.cancel_all)
_CHILDREN_LOCK = threading.Lock()


def kill_children() -> int:
    """Kill every live child process (shutdown path). Returns how many were signalled."""
    with _CHILDREN_LOCK:
        procs = list(_CHILDREN)
    for proc in procs:
        _kill(proc)
    return len(procs)


def node_bin() -> str | None:
    return os.environ.get("NIMBUS_NODE_BIN") or shutil.which("node")


def cli_path() -> str:
    return os.environ.get("NIMBUS_HEADLESS_CLI") or str(REPO_ROOT / "frontend" / "optimization" / "headless-cli.mjs")


class _Steps:
    """Step timings for the run summary (`steps: [{step, duration_ms}]`), fed by Python phases and Node log lines."""

    def __init__(self, ctx):
        self.ctx, self.items = ctx, []

    def add(self, step: str, ms: float) -> None:
        for it in self.items:
            if it["step"] == step:
                it["duration_ms"] += int(ms)
                return
        self.items.append({"step": step, "duration_ms": int(ms)})

    @contextmanager
    def phase(self, name: str):
        t0 = time.monotonic()
        try:
            with self.ctx.step(name):
                yield
        finally:
            self.add(name, (time.monotonic() - t0) * 1000)


# ------------------------------------------------------------------------------------------------ bundle
def gather_bundle(plant: str) -> dict:
    """The `HeadlessWire` bundle plus its snapshot-version token. The token is read BEFORE the wire is built and
    again after: an input that changed while building would otherwise pair a new token with an old wire. One retry;
    if it still moves, the token read before the second build is kept (a later comparison then fails safely)."""
    from backend.scheduling import routes as sched

    for _attempt in (1, 2):
        before = sched.optimizer_snapshot_version(plant)
        bundle = _build_bundle(plant)
        if sched.optimizer_snapshot_version(plant) == before:
            break
    bundle["snapshot_version"] = before
    return bundle


def _build_bundle(plant: str) -> dict:
    """The body each browser endpoint would serve, built from the same in-process code."""
    from fastapi.encoders import jsonable_encoder

    import backend.setup.data as setup_data
    import db
    import master_data as md
    from backend.priority_lists import cache as plcache
    from backend.scheduling import routes as sched

    payload = sched.build_tasks_payload(plant, None, None, None, None)
    model = sched._TASKS_ADAPTER.validate_python(payload)
    tasks = sched._TASKS_ADAPTER.dump_python(model, by_alias=True, mode="json")
    calendar = md.load_plant_calendar(plant)
    calendar["calendar_version"] = db.plant_calendar_version(plant)
    setup = dict(setup_data.get_setup_snapshot(plant))
    setup["plant_active"] = md.get_plant_setup_active(plant)

    def grid(table: str, scoped: bool = True):
        try:
            return md.list_rows(table, plant=plant if scoped else None)
        except Exception:  # noqa: BLE001 - a missing optional table must not fail the run (null = not loaded)
            return None

    horizons = db.plant_horizons(plant)
    frozen = horizons.get("frozen_horizon_end")
    bundle = {
        "tasks": {"data": tasks["data"], "meta": tasks.get("meta")},
        "calendar": calendar,
        "setup": setup,
        "priorityRankMaps": plcache.PLANT_LISTS.get(plant, {}),
        "masterData": {"plants": grid("plants", False), "machine": grid("machine"),
                       "sap_workcenter": grid("sap_workcenter"), "tool_inventory": grid("tool_inventory")},
        "horizons": {"calendar_version": horizons.get("calendar_version"),
                     "tool_inventory_version": horizons.get("tool_inventory_version"),
                     "frozen_horizon_end": frozen.isoformat() if frozen else None},
    }
    return {"wire": jsonable_encoder(bundle), "server_now": sched._server_now_iso()}


def plant_timezone(wire: dict, plant: str) -> str:
    rows = ((wire.get("masterData") or {}).get("plants") or {}).get("rows") or []
    for row in rows:
        if str(row.get("plant")) == plant:
            return str(row.get("timezone") or "")
    return ""


# ------------------------------------------------------------------------------------------------ node child
def _log_child_line(ctx, steps: _Steps, line: str) -> None:
    line = line.strip()
    if not line:
        return
    try:
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError("not an object")
        level = entry.get("level") if entry.get("level") in ("info", "warn", "error") else "info"
        ms = entry.get("ms")
        step = str(entry.get("step") or "") or None
        has_ms = isinstance(ms, (int, float))
        if has_ms and step:
            steps.add(step, ms)
        extra = entry.get("data") if isinstance(entry.get("data"), dict) else {}
        # The child's own keys must never collide with ctx.log's parameters (a TypeError would end the reader thread).
        extra = {k: v for k, v in extra.items() if k not in ("level", "msg", "step", "duration_ms")}
        ctx.log(level, str(entry.get("msg", "")), step=step, duration_ms=int(ms) if has_ms else None, **extra)
    except Exception:  # noqa: BLE001 - noise, a non-object line or a bad field: keep the text, never raise
        ctx.log("warn", f"node: {line}")


def _kill(proc: subprocess.Popen) -> None:
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(5)
    except Exception:  # noqa: BLE001
        pass


def run_node(ctx, steps: _Steps, phase: str, payload: dict, *, tz: str, timeout_s: float) -> dict:
    """Run the headless CLI once. Raises JobCancelled on cancel, RuntimeError on timeout / crash / bad output."""
    exe = node_bin()
    if not exe:
        raise RuntimeError("node is not available on this host (set NIMBUS_NODE_BIN)")
    env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
    env["TZ"] = tz
    heap = [f"--max-old-space-size={MAX_OLD_SPACE_MB}"] if MAX_OLD_SPACE_MB > 0 else []
    cmd = [exe, *heap, cli_path(), "--phase", phase, "--input", "-"]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    with _CHILDREN_LOCK:
        _CHILDREN.add(proc)
    body = json.dumps(payload).encode("utf-8")
    out_chunks: list[bytes] = []
    over = {"stdout": False}

    def feed():
        try:
            proc.stdin.write(body)
            proc.stdin.close()
        except OSError:
            pass

    def read_out():
        total = 0
        while True:
            chunk = proc.stdout.read1(65536)
            if not chunk:
                return
            total += len(chunk)
            if total > MAX_CHILD_STDOUT_BYTES:
                over["stdout"] = True
                return
            out_chunks.append(chunk)

    def read_err():
        while True:
            raw = proc.stderr.readline(MAX_STDERR_LINE_BYTES + 1)
            if not raw:
                return
            if len(raw) > MAX_STDERR_LINE_BYTES and not raw.endswith(b"\n"):
                while True:                      # drop the rest of an over-long line without holding it in memory
                    rest = proc.stderr.readline(MAX_STDERR_LINE_BYTES)
                    if not rest or rest.endswith(b"\n"):
                        break
                ctx.log("warn", f"node: log line over {MAX_STDERR_LINE_BYTES} bytes dropped")
                continue
            _log_child_line(ctx, steps, raw.decode("utf-8", errors="replace"))

    threads = [threading.Thread(target=f, daemon=True) for f in (feed, read_out, read_err)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + timeout_s
    try:
        while proc.poll() is None:
            if over["stdout"]:
                _kill(proc)
                raise RuntimeError(f"optimizer process wrote more than {MAX_CHILD_STDOUT_BYTES} bytes and was killed")
            if ctx.cancelled:
                _kill(proc)
                ctx.check_cancel()
            if time.monotonic() >= deadline:
                _kill(proc)
                raise RuntimeError(f"optimizer process timed out after {int(timeout_s)}s and was killed")
            time.sleep(0.05)
    finally:
        if proc.poll() is None:
            _kill(proc)
        with _CHILDREN_LOCK:
            _CHILDREN.discard(proc)
    for t in threads:
        t.join(5)
    if over["stdout"]:
        raise RuntimeError(f"optimizer process wrote more than {MAX_CHILD_STDOUT_BYTES} bytes and was killed")
    if proc.returncode != 0:
        raise RuntimeError(f"optimizer process exited with code {proc.returncode}")
    try:
        return json.loads(b"".join(out_chunks).decode("utf-8"))
    except ValueError as exc:
        raise RuntimeError("optimizer process returned unreadable output") from exc


# ------------------------------------------------------------------------------------------------ the run
REFUSALS = {
    "calendar_changed": "the plant calendar changed since the run; nothing applied",
    "tool_inventory_changed": "the tool inventory changed since the run; nothing applied",
}


def _fail(steps: _Steps, error: str, *, kind: str = "system", step: str | None = None, **extra) -> dict:
    """`kind` is the run summary's error_kind: config = the job or its inputs need fixing, system = the platform failed."""
    return {**extra, "status": "failed", "error": error, "steps": steps.items, "error_kind": kind,
            **({"failed_step": step} if step else {})}


def run_optimizer(ctx, plant: str, params) -> dict:
    """The `optimizer.set_runner` callable. Never raises except JobCancelled; every other failure is a failed result."""
    steps = _Steps(ctx)
    ctx.log("info", "waiting for an optimizer slot", step="queue")
    while not _SLOTS.acquire(timeout=0.5):
        ctx.check_cancel()
    getattr(ctx, "begin_work", lambda: None)()    # the run's time limit starts now, not while it queued for the slot
    try:
        return _run(ctx, plant, params, steps)
    except JobCancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        ctx.log("error", f"optimizer run failed: {type(exc).__name__}: {exc}")
        return _fail(steps, f"{type(exc).__name__}: {exc}")
    finally:
        _SLOTS.release()


def _run(ctx, plant: str, params, steps: _Steps) -> dict:
    with steps.phase("gather"):
        bundle = gather_bundle(plant)
    wire = bundle["wire"]
    tz = plant_timezone(wire, plant)
    if not tz:
        return _fail(steps, f"plant {plant} has no timezone; the optimizer cannot run", kind="config", step="gather")
    node_params = {"mode": MODE_MAP[params.mode], "search": params.search, "respect_firmed": params.respect_firmed,
                   "serverNow": bundle["server_now"], "plantTimezone": tz}
    result = run_node(ctx, steps, "run", {"plant": plant, "wire": wire, "params": node_params},
                      tz=tz, timeout_s=BUDGET_S[params.search] + TIMEOUT_MARGIN_S)
    summary = result.get("summary") or {}
    out = {"late": summary.get("late_count"), "moved": summary.get("patched"),
           "setup_minutes": summary.get("setup_minutes"), "search_complete": summary.get("search_complete"),
           "termination": summary.get("termination"), "tool_blocked": summary.get("tool_blocked")}
    out = {k: v for k, v in out.items() if v is not None}
    blockers = result.get("blockers") or []
    if result.get("status") not in (None, "completed"):
        return _fail(steps, f"optimizer did not complete: {result.get('status')} {result.get('error') or ''}".strip(), step="optimize", **out)

    if params.apply_mode == "propose":
        patches = result.get("patches") or []
        proposal = {"snapshot_version": bundle["snapshot_version"], "patches": patches, "base_versions": {p["id"]: p.get("base_version") for p in patches},
                    "findings": (result.get("findings") or [])[:50]}
        if len(json.dumps(proposal)) <= MAX_STORED_PATCH_BYTES:      # the whole object, not just the patches
            out["proposal"] = proposal
        else:
            out["proposal_truncated"] = True
            ctx.log("warn", f"proposal of {len(patches)} patches is too large to store; counts kept only")
        if blockers:
            out["warnings"] = [f"proposal is not applicable: {', '.join(blockers)}"]
        out["steps"] = steps.items
        return out

    if blockers or not result.get("ok"):
        reason = ", ".join(blockers) or str(result.get("error") or "unknown")
        ctx.log("error", f"result is not applicable: {reason}")
        return _fail(steps, f"optimizer result blocked, nothing applied: {reason}", kind="config", step="optimize", **out)
    if not result.get("patches"):
        ctx.log("info", "no orders need to move; nothing to apply")
        return {**out, "applied": 0, "steps": steps.items}
    return _apply(ctx, plant, steps, bundle, tz, node_params, result, out)


def _apply(ctx, plant, steps, bundle, tz, node_params, result, out) -> dict:
    from backend.schedule_events.events import EventCtx, new_action_id
    from backend.scheduling import routes as sched
    from backend.scheduling.models import TaskDateUpdate

    with steps.phase("gather_live"):
        live = gather_bundle(plant)
    if live["snapshot_version"] != bundle["snapshot_version"]:
        return _fail(steps, "priority lists, setup, calendar or tool inventory changed since the run; nothing applied", kind="config", step="gather_live", **out)
    plan = run_node(ctx, steps, "apply", {"plant": plant, "runWire": bundle["wire"], "liveWire": live["wire"],
                                          "state": result["state"], "jobId": ctx.job_id,
                                          # the live board is judged at the live clock, the run's own clock is for the run
                                          "params": {**node_params, "liveServerNow": live["server_now"]}},
                    tz=tz, timeout_s=TIMEOUT_MARGIN_S)
    dropped = plan.get("dropped") or []
    if dropped:
        ctx.log("warn", f"dropped {len(dropped)} order(s) changed since the run", step="guard",
                dropped=[f"{d.get('id')}:{d.get('reason')}" for d in dropped][:200])
    out["dropped"] = len(dropped)
    if not plan.get("ok"):
        reason = plan.get("refusal") or "unknown"
        return _fail(steps, REFUSALS.get(reason, f"apply refused ({reason}); nothing applied"), kind="config", step="guard", **out)
    items = plan.get("apply") or []
    if not items:
        ctx.log("warn" if dropped else "info", "nothing left to apply")
        warn = {"warnings": [f"all {len(dropped)} order(s) were dropped"]} if dropped else {}
        return {**out, **warn, "applied": 0, "steps": steps.items}
    # Last guard before the write: a change that landed while the child ran.
    if sched.optimizer_snapshot_version(plant) != bundle["snapshot_version"]:
        return _fail(steps, "inputs changed while applying; nothing applied", kind="config", step="guard", **out)
    ctx.check_cancel()
    actor = f"job:{ctx.job_id}"
    ev = EventCtx(source="optimizer", actor=actor, action_id=new_action_id(), client_id=actor)
    with steps.phase("write"):
        res = sched._apply_task_date_updates([TaskDateUpdate(**item) for item in items], None,
                                             atomic_optimizer=True, strict_conflicts=True,
                                             actor=actor, client_id=actor, ev=ev)
    if res.get("status") == "error" or res.get("persisted", 0) < len(items) or res.get("stale") or res.get("conflicts"):
        ctx.log("error", "write refused; the batch is atomic so nothing was applied", step="write",
                persisted=res.get("persisted"), stale=len(res.get("stale") or []),
                conflicts=len(res.get("conflicts") or []), error_code=res.get("error_code"))
        return _fail(steps, f"write refused ({res.get('error_code') or 'stale or conflicting rows'}); nothing applied", kind="config", step="write", **out)
    out.update({"applied": res["persisted"], "action_id": ev.action_id, "steps": steps.items})
    if dropped:
        out["warnings"] = [f"{len(dropped)} order(s) changed during the run and were skipped"]
    return out
