"""Classify a database failure for a job step's `error_kind` (pure; psycopg only for the exception classes).

A statement or lock timeout, a deadlock, a pool that could not hand out a connection and a dropped connection are the
platform being busy, not the job being wrong: running the step again is the right response, so they are `transient`
(a retry may help). Anything else keeps the caller's own mapping (`system` unless the step says `config`).
"""
from __future__ import annotations

_TRANSIENT_NAMES = ("QueryCanceled", "LockNotAvailable", "DeadlockDetected", "SerializationFailure",
                    "IdleInTransactionSessionTimeout", "PoolTimeout", "ConnectionTimeout", "AdminShutdown",
                    "CrashShutdown", "CannotConnectNow", "ConnectionFailure", "ConnectionDoesNotExist")


def is_transient_db_error(exc: BaseException | None) -> bool:
    """True for a database timeout / contention / connectivity failure (matched by class name through the MRO, so a
    psycopg or pool error is recognised without importing either here); a plain `OperationalError` counts only when
    its text says timeout or connection."""
    seen = 0
    while exc is not None and seen < 4:                      # follow `raise ... from` a few levels
        for cls in type(exc).__mro__:
            if cls.__name__ in _TRANSIENT_NAMES:
                return True
            if cls.__name__ == "OperationalError" and any(
                    w in str(exc).lower() for w in ("timeout", "timed out", "connection", "could not connect")):
                return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False
