"""
Unit tests for brain._log_event v2 (error-log architecture spec §1.2 / §1.3).

No DB needed: _log_event only appends to the in-memory ring buffer and emits a
JSON log line. We import brain at module scope — the eager psycopg pool opens in
the background and does not block import even when Postgres is down — but guard
with a skip so the file degrades cleanly if brain cannot be constructed on this
machine (e.g. hardcoded COLOR_FILE paths).
"""
import psycopg
import pytest

try:
    import brain
except Exception as e:  # pragma: no cover - environment dependent
    pytest.skip(f"brain could not be imported in this environment: {e}",
                allow_module_level=True)


@pytest.fixture(autouse=True)
def _clean_ring():
    """Isolate each test: clear the ring before, and reset the rid contextvar after."""
    brain._BACKEND_LOG.clear()
    token = brain._RID_CTX.set(None)
    yield
    brain._RID_CTX.reset(token)
    brain._BACKEND_LOG.clear()


def _last():
    return brain._BACKEND_LOG[-1]


def test_basic_event_shape_no_exc():
    """A plain call (the legacy positional + **ctx form) behaves as before:
    no error_type/exc/error_code keys, ctx scalar-coerced."""
    brain._log_event("info", "startup", "hello world", count=3, plant="5512")
    e = _last()
    assert e["level"] == "info"
    assert e["category"] == "startup"
    assert e["msg"] == "hello world"
    assert "ts" in e
    assert "error_type" not in e
    assert "exc" not in e
    assert "error_code" not in e
    assert e["ctx"] == {"count": 3, "plant": "5512"}


def test_exc_captures_error_type_and_traceback():
    try:
        raise ValueError("bad input")
    except ValueError as ex:
        brain._log_event("error", "validation", "failed to parse", exc=ex)
    e = _last()
    assert e["error_type"] == "ValueError"
    assert "exc" in e
    assert isinstance(e["exc"], str)
    # The formatted traceback string carries the exception class + message.
    assert "ValueError" in e["exc"]
    assert "bad input" in e["exc"]
    assert "Traceback" in e["exc"]


def test_explicit_error_code_is_preserved():
    brain._log_event("error", "worker", "compute failed", error_code="worker.compute")
    assert _last()["error_code"] == "worker.compute"


class _FakeDbError(psycopg.Error):
    """psycopg.Error subclass with a settable sqlstate (base class makes it a
    read-only property). isinstance(_, psycopg.Error) stays True."""
    def __init__(self, sqlstate):
        self._sqlstate = sqlstate

    @property
    def sqlstate(self):
        return self._sqlstate

    @property
    def diag(self):
        return None


def test_error_code_derived_from_psycopg_error_via_translator():
    """When exc is a psycopg.Error and no explicit code is given, the code is
    derived from db.translate_db_error (spec §1.2)."""
    ex = _FakeDbError("23505")
    brain._log_event("error", "db", "insert failed", exc=ex)
    e = _last()
    assert e["error_code"] == "db.unique_violation"
    assert e["error_type"] == "_FakeDbError"
    assert "exc" in e


def test_explicit_error_code_wins_over_derived():
    ex = _FakeDbError("23505")
    brain._log_event("error", "db", "insert failed", exc=ex, error_code="custom.code")
    assert _last()["error_code"] == "custom.code"


def test_rid_read_from_contextvar():
    """rid auto-carries from the request contextvar (set by request_id_mw)."""
    token = brain._RID_CTX.set("req-abc-123")
    try:
        brain._log_event("info", "test", "with rid")
    finally:
        brain._RID_CTX.reset(token)
    assert _last()["rid"] == "req-abc-123"


def test_no_rid_when_contextvar_unset():
    """Outside a request the rid is None and the key is omitted entirely."""
    brain._log_event("info", "test", "no rid")
    assert "rid" not in _last()


def test_ctx_scalar_coercion_for_non_scalars():
    """Non-scalar ctx values are str()-coerced (so the ring stays JSON-safe)."""
    brain._log_event("warn", "test", "obj ctx", obj={"a": 1}, n=None, flag=True)
    ctx = _last()["ctx"]
    assert ctx["obj"] == "{'a': 1}"
    assert ctx["n"] is None
    assert ctx["flag"] is True


def test_logging_does_not_raise_with_unknown_level():
    """An unrecognized level still records (maps to INFO for the stdout line)."""
    brain._log_event("trace", "test", "weird level")
    assert _last()["level"] == "trace"
