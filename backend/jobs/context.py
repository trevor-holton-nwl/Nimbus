"""Run context handed to a job body: structured, capped logging plus cooperative cancellation.

Pure (stdlib only). Rows go to an injected `sink(list[row])` (the DB in production, a list in tests), so the caps
and ordering can be tested without Postgres. Caps: msg 2 KB, data 8 KB, 2000 lines per run (the last slot is a
truncation marker). warn/error lines are also handed to `mirror` (the in-memory _BACKEND_LOG in production).
"""
from __future__ import annotations

import json
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

LEVELS = ("debug", "info", "warn", "error")
LEVEL_RANK = {name: i for i, name in enumerate(LEVELS)}
MSG_MAX_BYTES = 2048
DATA_MAX_BYTES = 8192
MAX_LINES = 2000
FLUSH_INTERVAL_S = 0.5


class JobCancelled(Exception):
    """Raised by ctx.check_cancel() when the run was cancelled or timed out."""


def cap_text(text, limit: int = MSG_MAX_BYTES) -> str:
    text = str(text)
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    marker = " ...[truncated]"
    keep = raw[: limit - len(marker.encode("utf-8"))].decode("utf-8", errors="ignore")
    return keep + marker


def cap_data(data: dict) -> dict | None:
    if not data:
        return None
    try:
        text = json.dumps(data, default=str)
    except (TypeError, ValueError):
        text = json.dumps({k: str(v) for k, v in data.items()})
    if len(text.encode("utf-8")) <= DATA_MAX_BYTES:
        return json.loads(text)
    return {"_truncated": True, "preview": cap_text(text, 1000)}


class JobContext:
    def __init__(self, *, run_id: int, plant: str, job_id: int, sink, mirror=None,
                 cancel_event: threading.Event | None = None, flush_interval_s: float = FLUSH_INTERVAL_S):
        self.run_id, self.plant, self.job_id = run_id, plant, job_id
        self._sink, self._mirror = sink, mirror
        self.cancel_event = cancel_event or threading.Event()
        self._flush_interval = flush_interval_s
        self._lock = threading.Lock()
        self._buf: list[dict] = []
        self._seq = 0
        self._timer: threading.Timer | None = None
        self._last_flush = 0.0
        self.truncated = False
        self.timed_out = False
        # A job type that queues for a shared resource (the optimizer slot) keeps the hard-timeout clock stopped
        # until it actually has the resource: the runner sets `defer_clock`, the body calls `begin_work()`.
        self.defer_clock = False
        self.work_started = threading.Event()
        self.failed_step: str | None = None          # the last `ctx.step` an exception escaped from
        self.last_error_step: str | None = None      # the step of the most recent error-level line
        self.step_timings: list[dict] = []           # [{step, duration_ms}] of every `ctx.step` that ended

    def begin_work(self) -> None:
        """The body holds its resource now: the run's hard-timeout clock starts (a no-op unless deferred)."""
        self.work_started.set()

    # ---- cancellation -------------------------------------------------------------------------------
    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled("run timed out" if self.timed_out else "run was cancelled")

    def sleep(self, seconds: float) -> None:
        """Cancellable sleep; raises JobCancelled if cancelled while waiting."""
        if self.cancel_event.wait(seconds):
            self.check_cancel()

    # ---- logging ------------------------------------------------------------------------------------
    def log(self, level: str, msg, *, step: str | None = None, duration_ms: int | None = None, **data) -> None:
        level = level if level in LEVEL_RANK else "info"
        if level == "error" and step:
            self.last_error_step = step
        if level in ("warn", "error") and self._mirror:
            try:
                self._mirror(level, str(msg), self.run_id, self.plant)
            except Exception:  # noqa: BLE001 - mirroring must never break the run
                pass
        with self._lock:
            if self._seq >= MAX_LINES:
                return
            self._seq += 1
            if self._seq == MAX_LINES:
                self.truncated = True
                row = self._row("warn", f"log truncated: line limit of {MAX_LINES} reached, further lines dropped",
                                None, None, {})
            else:
                row = self._row(level, cap_text(msg), step, duration_ms, data)
            self._buf.append(row)
            immediate = (time.monotonic() - self._last_flush) >= self._flush_interval
        if immediate:
            self.flush()
        else:
            self._arm_timer()

    def _row(self, level, msg, step, duration_ms, data) -> dict:
        return {"seq": self._seq, "at": datetime.now(timezone.utc), "level": level, "step": step,
                "msg": msg, "duration_ms": duration_ms, "data": cap_data(data)}

    @contextmanager
    def step(self, name: str, **data):
        """`with ctx.step("load"):` logs a debug start line and an info end line with duration_ms; an exception
        inside logs an error line (with the duration) and propagates."""
        self.log("debug", f"{name}: started", step=name, **data)
        t0 = time.monotonic()
        try:
            yield
        except BaseException as exc:
            ms = int((time.monotonic() - t0) * 1000)
            self.failed_step = name
            self.step_timings.append({"step": name, "duration_ms": ms})
            self.log("error", f"{name}: failed ({type(exc).__name__}: {exc})", step=name, duration_ms=ms)
            raise
        ms = int((time.monotonic() - t0) * 1000)
        self.step_timings.append({"step": name, "duration_ms": ms})
        self.log("info", f"{name}: done", step=name, duration_ms=ms, **data)

    def _arm_timer(self) -> None:
        with self._lock:
            if self._timer is not None:
                return
            t = threading.Timer(self._flush_interval, self.flush)
            t.daemon = True
            self._timer = t
        t.start()

    def flush(self) -> None:
        with self._lock:
            rows, self._buf = self._buf, []
            self._timer = None
            self._last_flush = time.monotonic()
        if rows:
            self._sink(rows)

    @property
    def lines(self) -> int:
        return self._seq
