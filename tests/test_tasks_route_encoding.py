"""GET /tasks route-level encode/gzip contract (TestClient; the DB reader is
patched, so no Postgres is needed). The handler validates with TasksResponse,
dumps JSON bytes by_alias and gzips them itself in the threadpool; the app-wide
GZipMiddleware must pass the already-encoded body through.
"""
import copy

import pytest

try:
    import brain
    import backend.security.auth as auth
    from starlette.testclient import TestClient
except Exception as exc:  # pragma: no cover
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)

from backend.scheduling import routes
from backend.scheduling.models import TasksResponse
from test_tasks_builder_golden import mixed_rows


@pytest.fixture
def tasks_client(monkeypatch):
    rows = [r for r in mixed_rows() if r["PLANT"] == "P1"]
    rows[0] = dict(rows[0], RUN_TIME=float("nan"))          # NaN cell must come out as null (o003)
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: (copy.deepcopy(rows), None, None))
    monkeypatch.setattr(routes.db, "count_orders", lambda **kw: 0)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["P1"]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def _strip(body):
    body["meta"].pop("server_now", None)
    body["meta"].pop("color_merge_ms", None)
    return body


def test_gzip_and_identity_bodies_decode_identically(tasks_client):
    gz = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": "gzip"})
    plain = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": "identity"})
    assert gz.status_code == plain.status_code == 200
    assert gz.headers["content-encoding"] == "gzip"
    assert "content-encoding" not in plain.headers
    assert "accept-encoding" in gz.headers["vary"].lower()
    assert "accept-encoding" in plain.headers["vary"].lower()
    assert gz.headers["content-type"].startswith("application/json")
    gz_body, plain_body = gz.json(), plain.json()
    assert gz_body["meta"]["server_now"].endswith("Z") and plain_body["meta"]["server_now"].endswith("Z")
    assert _strip(gz_body) == _strip(plain_body)


def test_json_contract_aliases_nan_and_naive_dates(tasks_client):
    resp = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": "identity"})
    assert b"NaN" not in resp.content and b"Infinity" not in resp.content
    body = resp.json()
    first = next(t for t in body["data"] if t["id"] == "o003")
    assert first["RUN_TIME"] is None
    assert "ORDER_QUANTITY_(GMEIN)" in first and "order_quantity_gmein" not in first   # by_alias
    assert first["start_date"] == "2026-10-24T08:00:00"
    segments = next(t for t in body["data"] if t["id"] == "o001")["schedule_segments"]
    assert [s["sequence"] for s in segments] == [2, 1, 3]
    assert all(len(s["start_date"]) == 19 and "Z" not in s["start_date"] for s in segments)


def test_route_body_equals_response_model_serialisation(tasks_client):
    """Parity with what FastAPI's response_model pass would have produced."""
    body = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": "identity"}).json()
    payload = routes.build_tasks_payload("P1", None, None, None, None)
    expected = TasksResponse.model_validate(payload).model_dump(mode="json", by_alias=True)
    assert _strip(body) == _strip(expected)


def test_row_version_is_the_xmin_int(tasks_client):
    body = tasks_client.get("/tasks?plant=P1").json()
    by_id = {t["id"]: t for t in body["data"]}
    assert by_id["o001"]["row_version"] == 1001 and isinstance(by_id["o001"]["row_version"], int)
    assert by_id["o004"]["row_version"] is None


def test_out_of_scope_plant_still_403(tasks_client):
    assert tasks_client.get("/tasks?plant=OTHER").status_code == 403
    assert tasks_client.get("/tasks").status_code == 400


def test_response_validation_failure_is_a_500_that_leaks_no_row_values(tasks_client, monkeypatch):
    """pydantic's ValidationError is a ValueError, which brain's `_value_error_handler`
    would turn into a 400 echoing the offending value; the handler must raise FastAPI's
    ResponseValidationError (500) instead, with input values stripped."""
    bad = [dict(r, FORM_SIZE=5) for r in mixed_rows() if r["PLANT"] == "P1"]
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: (copy.deepcopy(bad), None, None))
    client = TestClient(brain.api, raise_server_exceptions=False)
    resp = client.get("/tasks?plant=P1")
    assert resp.status_code == 500
    assert "FORM_SIZE" not in resp.text and "input_value" not in resp.text and "o001" not in resp.text
    with pytest.raises(routes.ResponseValidationError) as info:
        routes.encode_tasks_response(routes.build_tasks_payload("P1", None, None, None, None))
    assert all("input" not in e for e in info.value.errors())


def test_vary_accept_encoding_appears_exactly_once(tasks_client, monkeypatch):
    for enc in ("gzip", "identity"):
        resp = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": enc})
        values = [v for k, v in resp.headers.multi_items() if k.lower() == "vary"]
        assert values == ["Accept-Encoding"], (enc, values)
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: ([], None, None))
    for enc in ("gzip", "identity"):                      # small body: under the middleware floor
        resp = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": enc})
        values = [v for k, v in resp.headers.multi_items() if k.lower() == "vary"]
        assert values == ["Accept-Encoding"], (enc, "small", values)
        assert "content-encoding" not in resp.headers


def test_routine_timing_stays_out_of_the_backend_log_ring(tasks_client):
    from backend.admin_ops.logbuffer import _BACKEND_LOG
    _BACKEND_LOG.clear()
    assert tasks_client.get("/tasks?plant=P1").status_code == 200
    assert not [e for e in _BACKEND_LOG if e.get("event") == "tasks.timing"]
    routes._log_tasks_timing("P1", 3, sql=2.0, build=0.1)      # slow (> 1500 ms): enters the ring as warn
    slow = [e for e in _BACKEND_LOG if e.get("event") == "tasks.timing"]
    assert len(slow) == 1 and slow[0]["level"] == "warn" and slow[0]["ctx"]["sql_ms"] == 2000.0


def test_timing_records_sql_before_the_empty_early_return(monkeypatch):
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: ([], None, None))
    timings = {}
    routes.build_tasks_payload("P1", None, None, None, None, _timings=timings)
    assert "sql" in timings


def test_empty_result_carries_fresh_server_now(tasks_client, monkeypatch):
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: ([], None, None))
    body = tasks_client.get("/tasks?plant=P1", headers={"Accept-Encoding": "identity"}).json()
    assert body["data"] == [] and body["links"] == [] and body["meta"]["server_now"].endswith("Z")
