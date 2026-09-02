"""
NIMBUS 2.0 — admin-ops event log ring buffer + request-id plumbing.

P5 relocation: this is one of the two narrow accessor modules called out by
docs/architecture/domain-refactor-plan.md §4 ("the _BACKEND_LOG ring buffer +
_log_event (+ the admin-audit append helper)"). Extracted verbatim from
brain.py — behavior is unchanged, only the file that owns it.

Extended slightly beyond the plan's literal three names (_BACKEND_LOG,
_log_event, _log_admin_action): `_set_admin_log_details` traveled with them
because it is the write-side half of the SAME admin-audit feature (route
handlers across every domain call it to attach safe context fields; brain.py's
`request_id_mw` middleware reads what it wrote via `request.state`), and
`_RID_CTX`/`_current_rid` traveled with them because `_log_event` reads the
contextvar internally and dozens of route handlers across every domain call
`_current_rid()` to build an error-reference string. Keeping all five together
avoids a second, mostly-empty module and matches how tightly they were already
coupled in brain.py.

Module-private state (`_BACKEND_LOG`, the deque; `_RID_CTX`, the ContextVar) is
never *reassigned* by any function here — only mutated in place (append/clear,
set/reset) — so importing modules can safely bind the names directly
(`from backend.admin_ops.logbuffer import _BACKEND_LOG`) without the staleness
hazard that would apply to a wholesale-reassigned global. No `global` statement
is needed anywhere in this module; the `PLW0603` ruff exception that covered
brain.py's old color-wheel globals does NOT need to move here (see
backend/priority_lists/cache.py, which does still need it).
"""
import collections
import contextvars
import logging
import traceback

import pandas as pd
import psycopg
from fastapi import Request

import db

# Per-request id, set in brain.py's request_id_mw and read by _log_event so
# every structured event auto-carries the rid (both the ring buffer entry and
# the JSON log line) without threading it through every call site. None
# outside a request. Shared ContextVar instance — brain.py imports this same
# object and calls .set()/.reset() on it directly from its middleware.
_RID_CTX: contextvars.ContextVar[str | None] = contextvars.ContextVar("nimbus_rid", default=None)


def _current_rid() -> str | None:
    """Read the request id from the contextvar (None outside a request)."""
    return _RID_CTX.get()


# In-memory backend event log — ring buffer, newest appended at right.
_BACKEND_LOG: collections.deque = collections.deque(maxlen=2000)

_LOG_LEVELS = {"info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}

# Child of brain.py's `nimbus.*` structured-logging tree (propagates up to the
# handler _configure_logging() installs there).
_evt_log = logging.getLogger("nimbus.event")


def _log_event(level: str, category: str, msg: str, *,
               exc: BaseException | None = None,
               error_code: str | None = None,
               event: str | None = None, outcome: str | None = None, **ctx) -> None:
    """Append a structured event to the in-memory ring buffer AND emit it as a
    JSON line via the nimbus logger (for container log aggregation).

    v2 (backward compatible — existing callers pass only positional + **ctx):
      - `exc`: when given, capture error_type + the formatted traceback into the
        RING entry (so /logs/backend shows traces, not just str(e)) AND pass
        exc_info=exc to the logger so the JSON-line 'exc' branch fires.
      - `error_code`: explicit code; else, when `exc` is a psycopg.Error, derived
        via db.translate_db_error; else omitted.
      - `rid`: read from the request contextvar so every event auto-carries it
        (and populates the _JsonFormatter rid slot)."""
    ts = pd.Timestamp.utcnow().isoformat()
    rid = _current_rid()
    entry: dict = {
        "ts":       ts,
        "level":    level,
        "category": category,
        "msg":      msg,
    }
    if rid:
        entry["rid"] = rid
    if event:
        entry["event"] = event
    if outcome:
        entry["outcome"] = outcome
    if exc is not None and error_code is None and isinstance(exc, psycopg.Error):
        error_code = db.translate_db_error(exc).get("error_code")
    if error_code:
        entry["error_code"] = error_code
    error_type = None
    if exc is not None:
        error_type = type(exc).__name__
        entry["error_type"] = error_type
        entry["exc"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )
    if ctx:
        entry["ctx"] = {k: (v if isinstance(v, (int, float, bool, type(None))) else str(v))
                        for k, v in ctx.items()}
    _BACKEND_LOG.append(entry)
    _evt_log.log(_LOG_LEVELS.get(level, logging.INFO), msg,
                 exc_info=exc if exc is not None else None,
                 extra={"category": category, "ctx": entry.get("ctx"),
                        "rid": rid, "error_code": error_code, "error_type": error_type,
                        "event": event, "outcome": outcome,
                        "evt_level": level, "evt_ts": ts})


_SENSITIVE_LOG_KEYS = frozenset({
    "authorization", "api_key", "password", "password_hash", "secret", "token",
    "cookie", "set_cookie", "raw", "body", "payload", "file_content",
})


def _log_admin_action(event: str, outcome: str, *, actor: str | None = None,
                      route: str | None = None, method: str | None = None,
                      duration_ms: int | None = None, exc: BaseException | None = None,
                      error_code: str | None = None, **details) -> None:
    """Emit one safe, terminal audit event for an admin write.

    This is deliberately transient (stdout + the bounded process-local ring),
    and accepts only caller-curated summaries.  Sensitive-looking keys are
    dropped defensively so an endpoint cannot accidentally copy credentials or
    raw request content into a diagnostic stream.
    """
    ctx = {
        "actor": actor or "unknown",
        **({"route": route} if route else {}),
        **({"method": method} if method else {}),
        **({"duration_ms": duration_ms} if duration_ms is not None else {}),
    }
    for key, value in details.items():
        if key.lower() not in _SENSITIVE_LOG_KEYS:
            ctx[key] = value
    level = "info" if outcome == "success" else ("warn" if outcome == "rejected" else "error")
    _log_event(level, "admin", f"Admin action {outcome}: {event}", exc=exc,
               error_code=error_code, event=event, outcome=outcome, **ctx)


def _set_admin_log_details(request: Request, **details) -> None:
    """Attach endpoint-curated safe summary fields to its terminal event.

    Endpoint handlers must never pass raw request payloads here.  The terminal
    middleware (brain.py's request_id_mw) applies the same sensitive-key guard
    as _log_admin_action.
    """
    current = getattr(request.state, "admin_log_details", {})
    current.update(details)
    request.state.admin_log_details = current
