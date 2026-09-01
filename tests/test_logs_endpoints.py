"""
Endpoint tests for the backend log buffer + frontend log sink
(error-log architecture spec §1.6 / §2.8 / §2.10).

These exercise GET /logs/backend filtering+pagination and POST /logs/frontend
folding through FastAPI's TestClient. They are DB-free: the ring buffer is an
in-process deque seeded directly. We import brain at module scope and skip the
whole file if it cannot be constructed on this machine.
"""
import pytest

try:
    from fastapi.routing import iter_route_contexts
    from starlette.testclient import TestClient

    import brain
except Exception as e:  # pragma: no cover - environment dependent
    pytest.skip(f"brain/TestClient unavailable in this environment: {e}",
                allow_module_level=True)


@pytest.fixture
def tc():
    # Endpoint behavior here is about the in-process log buffer, not the
    # database-backed admin role state. Make that independent of whichever
    # users happen to exist in a developer's local database — but first
    # confirm the route actually still requires require_admin, so overriding
    # it can't silently mask the dependency having been dropped from the route.
    #
    # P5 note: brain.api.routes now holds one _IncludedRouter per domain
    # router (api.include_router(...)) rather than flat route objects —
    # fastapi.routing.iter_route_contexts() is the public helper (also used
    # internally by app.openapi()) that walks included routers and yields
    # the real per-path route contexts (.path/.methods/.dependencies).
    route = next(
        route for route in iter_route_contexts(brain.api.routes)
        if getattr(route, "path", None) == "/logs/backend" and "GET" in route.methods
    )
    assert any(
        dependency.dependency is brain.require_admin
        for dependency in route.dependencies
    )
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)


@pytest.fixture(autouse=True)
def _clean_ring():
    brain._BACKEND_LOG.clear()
    yield
    brain._BACKEND_LOG.clear()


def _seed(entries):
    """Append raw ring entries oldest→newest (the buffer keeps newest at right)."""
    for e in entries:
        brain._BACKEND_LOG.append(e)


# --------------------------------------------------------------------------- #
# GET /logs/backend                                                           #
# --------------------------------------------------------------------------- #
def test_backend_logs_newest_first_default(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "info", "category": "a", "msg": "first"},
        {"ts": "2026-06-25T11:00:00", "level": "info", "category": "b", "msg": "second"},
    ])
    r = tc.get("/logs/backend")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    # newest first
    assert body["entries"][0]["msg"] == "second"
    assert body["entries"][1]["msg"] == "first"


def test_backend_logs_filter_by_level(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "info", "category": "a", "msg": "i"},
        {"ts": "2026-06-25T10:01:00", "level": "error", "category": "a", "msg": "e"},
        {"ts": "2026-06-25T10:02:00", "level": "warn", "category": "a", "msg": "w"},
    ])
    body = tc.get("/logs/backend", params={"level": "error"}).json()
    assert body["total"] == 1
    assert body["entries"][0]["msg"] == "e"
    # level=all is an explicit no-op (legacy contract)
    assert tc.get("/logs/backend", params={"level": "all"}).json()["total"] == 3


def test_backend_logs_filter_by_category(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "info", "category": "upload", "msg": "u1"},
        {"ts": "2026-06-25T10:01:00", "level": "info", "category": "db", "msg": "d1"},
        {"ts": "2026-06-25T10:02:00", "level": "info", "category": "upload", "msg": "u2"},
    ])
    body = tc.get("/logs/backend", params={"category": "upload"}).json()
    assert body["total"] == 2
    assert {e["msg"] for e in body["entries"]} == {"u1", "u2"}


def test_backend_logs_filter_by_since(tc):
    _seed([
        {"ts": "2026-06-25T09:00:00", "level": "info", "category": "a", "msg": "old"},
        {"ts": "2026-06-25T12:00:00", "level": "info", "category": "a", "msg": "new"},
    ])
    body = tc.get("/logs/backend", params={"since": "2026-06-25T10:00:00"}).json()
    assert body["total"] == 1
    assert body["entries"][0]["msg"] == "new"


def test_backend_logs_free_text_q_matches_msg_category_and_ctx(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "info", "category": "x",
         "msg": "plant 5512 reloaded"},
        {"ts": "2026-06-25T10:01:00", "level": "info", "category": "color-wheel",
         "msg": "nothing relevant"},
        {"ts": "2026-06-25T10:02:00", "level": "info", "category": "x",
         "msg": "other", "ctx": {"plant": "5512"}},
    ])
    # case-insensitive match across msg
    body = tc.get("/logs/backend", params={"q": "RELOADED"}).json()
    assert body["total"] == 1
    # match against category
    assert tc.get("/logs/backend", params={"q": "color"}).json()["total"] == 1
    # match against ctx (5512 appears in msg of #1 and ctx of #3)
    assert tc.get("/logs/backend", params={"q": "5512"}).json()["total"] == 2


def test_backend_logs_pagination_offset_and_limit(tc):
    _seed([
        {"ts": f"2026-06-25T10:0{i}:00", "level": "info", "category": "a", "msg": f"m{i}"}
        for i in range(5)
    ])
    # newest-first order is m4, m3, m2, m1, m0
    body = tc.get("/logs/backend", params={"limit": 2}).json()
    assert body["total"] == 5  # total is pre-paging
    assert [e["msg"] for e in body["entries"]] == ["m4", "m3"]
    # skip 2, take 2
    body = tc.get("/logs/backend", params={"offset": 2, "limit": 2}).json()
    assert body["total"] == 5
    assert [e["msg"] for e in body["entries"]] == ["m2", "m1"]


def test_backend_logs_combined_filters_and_paging(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "error", "category": "db", "msg": "e0"},
        {"ts": "2026-06-25T10:01:00", "level": "info", "category": "db", "msg": "i0"},
        {"ts": "2026-06-25T10:02:00", "level": "error", "category": "db", "msg": "e1"},
        {"ts": "2026-06-25T10:03:00", "level": "error", "category": "upload", "msg": "e2"},
    ])
    body = tc.get("/logs/backend",
                  params={"level": "error", "category": "db", "limit": 10}).json()
    assert body["total"] == 2
    assert [e["msg"] for e in body["entries"]] == ["e1", "e0"]


def test_backend_logs_filter_by_request_id_outcome_and_event(tc):
    _seed([
        {"ts": "2026-06-25T10:00:00", "level": "info", "category": "admin",
         "msg": "admin action", "rid": "r1", "event": "orders.upload", "outcome": "success"},
        {"ts": "2026-06-25T10:01:00", "level": "error", "category": "admin",
         "msg": "admin action", "rid": "r2", "event": "orders.upload", "outcome": "failure"},
    ])
    body = tc.get("/logs/backend", params={"rid": "r2", "outcome": "failure",
                                            "event": "orders.upload"}).json()
    assert body["total"] == 1
    assert body["entries"][0]["rid"] == "r2"


def test_admin_write_is_automatically_recorded_with_safe_route_scope(tc):
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        r = tc.post("/logs/backend/clear", headers={"x-user-email": "ops@example.com"})
    finally:
        brain.api.dependency_overrides.pop(brain.require_api_key, None)

    assert r.status_code == 200
    event = brain._BACKEND_LOG[-1]
    assert event["event"] == "backend_log.clear"
    assert event["outcome"] == "success"
    assert event["ctx"]["actor"] == "ops@example.com"
    assert event["ctx"]["status"] == 200


# --------------------------------------------------------------------------- #
# POST /logs/frontend                                                         #
# --------------------------------------------------------------------------- #
def test_frontend_sink_accepts_valid_batch_and_folds_into_ring(tc):
    payload = {"entries": [
        {"ts": "2026-06-25T10:00:00", "level": "error", "scope": "worker",
         "msg": "compute failed", "errorCode": "worker.compute", "reqId": "rid-1",
         "stack": "Error: boom\n  at x", "buildId": "v9", "sessionId": "s1",
         "plant": "5512", "route": "gantt"},
    ]}
    r = tc.post("/logs/frontend", json=payload)
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "accepted": 1}
    e = brain._BACKEND_LOG[-1]
    assert e["source"] == "frontend"
    assert e["category"] == "worker"          # scope → category
    assert e["level"] == "error"
    assert e["msg"] == "compute failed"
    assert e["error_code"] == "worker.compute"
    assert e["rid"] == "rid-1"
    assert e["exc"] == "Error: boom\n  at x"  # stack → exc
    # buildId/sessionId/plant/route folded into ctx
    assert e["ctx"]["buildId"] == "v9"
    assert e["ctx"]["sessionId"] == "s1"
    assert e["ctx"]["plant"] == "5512"
    assert e["ctx"]["route"] == "gantt"


def test_frontend_sink_defaults_category_and_level(tc):
    payload = {"entries": [{"msg": "no scope, no level"}]}
    r = tc.post("/logs/frontend", json=payload)
    assert r.json()["accepted"] == 1
    e = brain._BACKEND_LOG[-1]
    assert e["category"] == "frontend"   # scope omitted → 'frontend'
    assert e["level"] == "info"          # bad/absent level → info
    assert e["source"] == "frontend"


def test_frontend_sink_maps_warning_to_warn(tc):
    tc.post("/logs/frontend", json={"entries": [{"level": "warning", "msg": "x"}]})
    assert brain._BACKEND_LOG[-1]["level"] == "warn"


def test_frontend_sink_caps_batch_at_50(tc):
    entries = [{"msg": f"m{i}", "level": "info"} for i in range(120)]
    r = tc.post("/logs/frontend", json={"entries": entries})
    assert r.json()["accepted"] == 50
    assert len(brain._BACKEND_LOG) == 50


def test_frontend_sink_truncates_long_strings(tc):
    long_msg = "M" * 5000      # > 2 KB cap
    long_stack = "S" * 20000   # > 8 KB cap
    tc.post("/logs/frontend", json={"entries": [
        {"msg": long_msg, "stack": long_stack, "level": "error"},
    ]})
    e = brain._BACKEND_LOG[-1]
    assert len(e["msg"]) <= brain._FE_MAX_MSG + len("…[truncated]")
    assert e["msg"].endswith("…[truncated]")
    assert len(e["exc"]) <= brain._FE_MAX_STACK + len("…[truncated]")
    assert e["exc"].endswith("…[truncated]")


def test_frontend_sink_skips_non_dict_entries(tc):
    r = tc.post("/logs/frontend", json={"entries": [
        "not a dict", 42, {"msg": "valid", "level": "info"}, None,
    ]})
    # only the one dict is accepted
    assert r.json()["accepted"] == 1
    assert brain._BACKEND_LOG[-1]["msg"] == "valid"


def test_frontend_sink_empty_body_is_ok(tc):
    assert tc.post("/logs/frontend", json={}).json() == {"status": "ok", "accepted": 0}
    # entries: [] is also fine
    assert tc.post("/logs/frontend", json={"entries": []}).json()["accepted"] == 0


def test_frontend_sink_rejects_non_list_entries_with_400(tc):
    r = tc.post("/logs/frontend", json={"entries": "oops"})
    assert r.status_code == 400


def test_frontend_sink_reqId_falls_back_to_rid_key(tc):
    tc.post("/logs/frontend", json={"entries": [{"msg": "x", "rid": "alt-rid"}]})
    assert brain._BACKEND_LOG[-1]["rid"] == "alt-rid"
