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

    import backend.security.auth as auth
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
    import backend.admin_ops.routes as admin_routes
    brain._BACKEND_LOG.clear()
    admin_routes._CSP_SEEN.clear()
    admin_routes._CSP_RATE.update(window_start=0.0, admitted=0, dropped=0)
    yield
    brain._BACKEND_LOG.clear()
    admin_routes._CSP_SEEN.clear()
    admin_routes._CSP_RATE.update(window_start=0.0, admitted=0, dropped=0)


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
# require_api_key sweep (2026-09-02) — GET /logs/backend and GET             #
# /diagnostics/db now also require the shared-secret API key on top of       #
# require_admin, matching every destructive/DDL sibling route. Same          #
# negative-test template as test_setup_endpoints.py::                        #
# test_setup_writes_reject_missing_api_key: the guard must reject a request  #
# missing X-API-Key even when the admin/identity dependency is satisfied.    #
# --------------------------------------------------------------------------- #
def test_logs_backend_get_rejects_missing_api_key(monkeypatch, tc):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    r = tc.get("/logs/backend")
    assert r.status_code == 401


def test_logs_backend_get_allows_correct_api_key(monkeypatch, tc):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    r = tc.get("/logs/backend", headers={"X-API-Key": "required-key"})
    assert r.status_code == 200


def test_diagnostics_db_rejects_missing_api_key(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[brain.require_admin] = lambda: "test-admin"
    try:
        r = TestClient(brain.api).get("/diagnostics/db")
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
    assert r.status_code == 401


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


# --------------------------------------------------------------------------- #
# Plan Part 1 #3 / #4: deep-diagnostics key guard, ctx caps, body-size cap     #
# --------------------------------------------------------------------------- #
def test_diagnostics_deep_rejects_missing_api_key(tc, monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    assert tc.get("/diagnostics/deep").status_code == 401


def test_frontend_sink_caps_ctx_keys_and_values(tc):
    from backend.admin_ops import routes as _ao_routes
    ctx = {f"k{i}" * 40: "x" * 2000 for i in range(60)}
    tc.post("/logs/frontend", json={"entries": [{"msg": "m", "ctx": ctx}]})
    got = brain._BACKEND_LOG[-1]["ctx"]
    assert len(got) <= _ao_routes._FE_MAX_CTX_KEYS
    assert all(len(k) <= _ao_routes._FE_MAX_CTX_KEY for k in got)
    assert all(len(v) <= _ao_routes._FE_MAX_CTX_VALUE + len("…[truncated]") for v in got.values())


def test_frontend_sink_rejects_oversize_body_413(tc):
    big = "x" * (1100 * 1024)
    r = tc.post("/logs/frontend", json={"entries": [{"msg": big}]})
    assert r.status_code == 413
    assert not brain._BACKEND_LOG


def test_audit_log_post_rejects_oversize_entry(tc):
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "u"
    try:
        # 40 KB: under the 64 KB body cap, over the 32 KB entry cap (route-level 413)
        r = tc.post("/audit/log", json={"action": "x", "details": {"blob": "y" * 40_000}})
        assert r.status_code == 413
        # > 64 KB: refused by the body-size middleware before routing
        r = tc.post("/audit/log", json={"action": "x", "details": {"blob": "y" * 100_000}})
        assert r.status_code == 413
    finally:
        brain.api.dependency_overrides.pop(auth.require_authenticated, None)


# --------------------------------------------------------------------------- #
# CSP report-only header + POST /logs/csp-report (#28)                         #
# --------------------------------------------------------------------------- #
def test_csp_report_only_header_on_html_not_on_json(tc):
    html = tc.get("/")
    assert html.status_code == 200
    policy = html.headers.get("content-security-policy-report-only", "")
    assert "default-src 'self'" in policy and "report-uri /logs/csp-report" in policy
    assert "https://unpkg.com" in policy and "https://cdn.jsdelivr.net" in policy
    assert "content-security-policy" not in html.headers      # report-only: never enforcing
    api = tc.get("/logs/backend")
    assert "content-security-policy-report-only" not in api.headers


def test_csp_report_endpoint_logs_legacy_and_reports_api_bodies_and_tolerates_junk(tc):
    legacy = '{"csp-report": {"document-uri": "http://x/", "violated-directive": "script-src-attr", "blocked-uri": "inline"}}'
    r = tc.post("/logs/csp-report", content=legacy, headers={"content-type": "application/csp-report"})
    assert r.status_code == 204
    e = brain._BACKEND_LOG[-1]
    assert e["category"] == "csp" and e["event"] == "csp.report"
    assert "script-src-attr" in e["msg"] and e["ctx"]["blocked_uri"] == "inline"

    modern = '[{"type": "csp-violation", "body": {"effectiveDirective": "x", "violated-directive": "img-src"}}]'
    assert tc.post("/logs/csp-report", content=modern, headers={"content-type": "application/reports+json"}).status_code == 204
    assert "img-src" in brain._BACKEND_LOG[-1]["msg"]

    n = len(brain._BACKEND_LOG)
    assert tc.post("/logs/csp-report", content="not json {{", headers={"content-type": "application/csp-report"}).status_code == 204
    assert tc.post("/logs/csp-report", content="x" * 12000).status_code == 204   # under the 16 KB cap, junk -> dropped
    assert len(brain._BACKEND_LOG) == n


def test_csp_report_oversize_body_413_and_frontend_cap_is_1mb(tc):
    n = len(brain._BACKEND_LOG)
    assert tc.post("/logs/csp-report", content="x" * 50000).status_code == 413
    assert len(brain._BACKEND_LOG) == n
    assert brain._BODY_CAPS[("POST", "/logs/frontend")] == 1024 * 1024


def _csp(tc, directive="script-src-attr", blocked="inline", src="http://x/app.js", line=1):
    body = ('{"csp-report": {"violated-directive": "%s", "blocked-uri": "%s", "source-file": "%s", "line-number": %d}}'
            % (directive, blocked, src, line))
    return tc.post("/logs/csp-report", content=body, headers={"content-type": "application/csp-report"})


def test_csp_reports_are_deduplicated_with_a_counter(tc):
    import backend.admin_ops.routes as admin_routes
    for _ in range(250):
        assert _csp(tc).status_code == 204
    csp = [e for e in brain._BACKEND_LOG if e["category"] == "csp"]
    # first sighting + the 10/100 milestones, never 250 entries
    assert [e["ctx"].get("occurrences") for e in csp] == [None, 10, 100]
    assert admin_routes._CSP_SEEN[("script-src-attr", "inline", "http://x/app.js", "1")] == 250
    # a different line is a different violation
    _csp(tc, line=2)
    assert len([e for e in brain._BACKEND_LOG if e["category"] == "csp"]) == 4


def test_csp_distinct_flood_is_rate_limited_and_cannot_evict_real_errors(tc, monkeypatch):
    import backend.admin_ops.routes as admin_routes
    clock = {"t": 1000.0}
    monkeypatch.setattr(admin_routes.time, "monotonic", lambda: clock["t"])
    brain._log_event("error", "scheduling", "real error")
    for i in range(500):
        _csp(tc, blocked=f"https://evil{i}.example/x")
    csp = [e for e in brain._BACKEND_LOG if e["category"] == "csp"]
    assert len(csp) == admin_routes._CSP_MAX_DISTINCT_PER_MIN
    assert any(e["msg"] == "real error" for e in brain._BACKEND_LOG)
    assert admin_routes._CSP_RATE["dropped"] == 480
    # next minute: the drop count is reported once and admission resumes
    clock["t"] += 61
    _csp(tc, blocked="https://another.example/")
    msgs = [e["msg"] for e in brain._BACKEND_LOG if e["category"] == "csp"]
    assert any("rate-limited: 480" in m for m in msgs)
    assert any("another.example" in str(e["ctx"]) for e in brain._BACKEND_LOG if e["category"] == "csp")


# --------------------------------------------------------------------------- #
# Exact-boundary pins for the ctx / audit / body-size caps, the 411 path, and  #
# /diagnostics/deep's two-guard wiring                                         #
# --------------------------------------------------------------------------- #
def test_frontend_sink_ctx_caps_hold_at_the_exact_boundary(tc):
    from backend.admin_ops import routes as _ao_routes
    assert (_ao_routes._FE_MAX_CTX_KEYS, _ao_routes._FE_MAX_CTX_KEY, _ao_routes._FE_MAX_CTX_VALUE) == (20, 64, 1024)

    def post(ctx):
        brain._BACKEND_LOG.clear()
        assert tc.post("/logs/frontend", json={"entries": [{"msg": "m", "ctx": ctx}]}).status_code == 200
        return brain._BACKEND_LOG[-1]["ctx"]

    # 20 keys kept whole; the 21st is dropped (first-in-order win).
    assert len(post({f"k{i:02d}": i for i in range(20)})) == 20
    got = post({f"k{i:02d}": i for i in range(21)})
    assert len(got) == 20 and "k20" not in got and "k19" in got
    # key length: 64 chars intact, 65 cut to 64.
    got = post({"a" * 64: 1, "b" * 65: 2})
    assert set(got) == {"a" * 64, "b" * 64}
    # value length: 1024 chars intact (no marker), 1025 truncated with the marker.
    got = post({"ok": "v" * 1024, "over": "v" * 1025})
    assert got["ok"] == "v" * 1024
    assert got["over"] == "v" * 1024 + "…[truncated]"


def test_audit_log_entry_caps_hold_at_the_exact_boundary(tc, monkeypatch):
    import json as _json
    import backend.master_data.routes as md_routes
    written = []
    monkeypatch.setattr(md_routes, "_cw_append_audit", written.append)
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "u"
    try:
        assert (md_routes._AUDIT_MAX_KEYS, md_routes._AUDIT_MAX_BYTES) == (50, 32 * 1024)
        # 50 keys accepted, 51 rejected by the route (413).
        assert tc.post("/audit/log", json={f"k{i}": 1 for i in range(50)}).status_code == 200
        assert tc.post("/audit/log", json={f"k{i}": 1 for i in range(51)}).status_code == 413
        # Serialized (json.dumps default separators) size: exactly 32768 accepted, 32769 rejected.
        exact = {"a": "y" * (32 * 1024 - 9)}
        assert len(_json.dumps(exact, default=str)) == 32 * 1024
        before = len(written)
        assert tc.post("/audit/log", json=exact).status_code == 200
        assert len(written) == before + 1
        over = {"a": "y" * (32 * 1024 - 8)}
        assert tc.post("/audit/log", json=over).status_code == 413
        assert len(written) == before + 1
    finally:
        brain.api.dependency_overrides.pop(auth.require_authenticated, None)


def test_body_size_cap_middleware_boundary_and_missing_content_length(tc):
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "u"
    try:
        hdr = {"content-type": "application/json"}
        cap = 64 * 1024
        assert brain._BODY_CAPS[("POST", "/audit/log")] == cap
        # Exactly at the cap the middleware lets it through (junk JSON then 422s in the app);
        # one byte over is refused by the middleware itself with an empty 413.
        at_cap = tc.post("/audit/log", content=b"x" * cap, headers=hdr)
        assert at_cap.status_code == 422
        over = tc.post("/audit/log", content=b"x" * (cap + 1), headers=hdr)
        assert over.status_code == 413 and over.content == b""
        # No Content-Length (chunked body) on a capped route -> 411 Length Required.
        chunked = tc.post("/audit/log", content=iter([b'{"a": 1}']), headers=hdr)
        assert chunked.status_code == 411 and chunked.content == b""
        assert tc.post("/logs/frontend", content=iter([b'{"entries": []}']), headers=hdr).status_code == 411
        # An uncapped route is unaffected by the missing header.
        assert tc.post("/logs/frontend", content=b'{"entries": []}', headers=hdr).status_code == 200
    finally:
        brain.api.dependency_overrides.pop(auth.require_authenticated, None)


def test_diagnostics_deep_route_requires_api_key_and_admin(monkeypatch):
    route = next(r for r in iter_route_contexts(brain.api.routes)
                 if getattr(r, "path", None) == "/diagnostics/deep" and "GET" in r.methods)
    deps = [d.dependency for d in route.dependencies]
    assert auth.require_api_key in deps and auth.require_admin in deps

    def must_not_run():
        raise AssertionError("handler ran without passing both guards")

    monkeypatch.setattr(brain.db, "get_db_deep_stats", must_not_run)
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "k")
    monkeypatch.setattr(auth, "get_user_role", lambda email: "planner")
    monkeypatch.setattr(auth, "admin_exists", lambda: True)
    client = TestClient(brain.api)
    # Valid key but non-admin actor -> 403 from require_admin (no override in play).
    r = client.get("/diagnostics/deep", headers={"x-api-key": "k", "x-user-email": "planner@example.com"})
    assert r.status_code == 403
    # Admin actor but wrong/missing key -> 401 from require_api_key.
    monkeypatch.setattr(auth, "get_user_role", lambda email: "admin")
    assert client.get("/diagnostics/deep", headers={"x-user-email": "a@example.com"}).status_code == 401
