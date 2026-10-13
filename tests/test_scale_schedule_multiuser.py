"""Real concurrent planner requests: HTTP -> role scope -> PostgreSQL transactions.

Workloads model 2/8 planners sharing a plant and simultaneous optimizer Apply
operations. Barriers and observed database locks coordinate contention; no sleep
is used to assume a write has happened, and no timing threshold claims throughput.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta
from threading import Barrier
from time import monotonic, sleep

import pytest
from fastapi.testclient import TestClient

import brain

pytest_plugins = ("tests.support.planning_pg",)
pytestmark = pytest.mark.pg


@pytest.fixture
def planners(planning_pg):
    c = planning_pg
    c.roles = [c.subnet + "_role_A", c.subnet + "_role_B"]
    c.users = [f"{c.subnet.lower()}.{i}@example.com" for i in range(8)]
    c.other_user = c.subnet.lower() + ".other@example.com"
    c.start = datetime(2031, 1, 6, 8)
    c.target = c.start + timedelta(days=14)
    c.ids = [c.db.make_id(c.subnet + f"_ORDER_{i}", "ZZTEST_MATERIAL") for i in range(8)]
    c.other_id = c.db.make_id(c.subnet + "_OTHER", "ZZTEST_MATERIAL")
    try:
        with c.db._pool.connection() as conn, conn.cursor() as cur:
            cur.executemany("INSERT INTO roles(role) VALUES (%s)", [(role,) for role in c.roles])
            cur.executemany("INSERT INTO role_plants(role, plant) VALUES (%s, %s)",
                            list(zip(c.roles, [c.plant, c.other], strict=True)))
            cur.executemany("INSERT INTO user_security(username, role) VALUES (%s, %s)",
                            [(user, c.roles[0]) for user in c.users] + [(c.other_user, c.roles[1])])
            cur.execute("UPDATE plants SET split_order_policy='partial_allowed' WHERE subnetwork=%s", (c.subnet,))
            cur.executemany(
                "INSERT INTO orders(id, production_order, material_number, plant, machine,"
                " basic_start_date, basic_finish_date, scheduled_start, scheduled_end, run_time)"
                " VALUES (%s,%s,'ZZTEST_MATERIAL',%s,%s,%s,%s,%s,%s,1)",
                [(oid, c.subnet + f"_ORDER_{i}", plant, c.machine,
                  c.start + timedelta(hours=i * 2), c.start + timedelta(hours=i * 2 + 1),
                  c.start + timedelta(hours=i * 2), c.start + timedelta(hours=i * 2 + 1))
                 for i, (oid, plant) in enumerate([(oid, c.plant) for oid in c.ids] + [(c.other_id, c.other)])],
            )
        c.initial = versions(c, c.ids + [c.other_id])
        yield c
    finally:
        with c.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id=ANY(%s)", (c.ids + [c.other_id],))
            cur.execute("DELETE FROM user_security WHERE username=ANY(%s)", (c.users + [c.other_user],))
            cur.execute("DELETE FROM roles WHERE role=ANY(%s)", (c.roles,))


def request(user, path, body):
    # Do not enter TestClient: app startup launches unrelated background tasks.
    with closing(TestClient(brain.api)) as client:
        response = client.post(path, headers={"x-user-email": user}, json=body)
        assert response.status_code == 200, response.text
        return response.json()


def versions(c, ids):
    return {row["id"]: row for row in c.db.get_task_versions(ids)}


def edit(c, oid, *, offset=0, **extra):
    start = c.target + timedelta(hours=offset)
    return {"id": oid, "base_version": c.initial[oid]["row_version"],
            "start_date": start.isoformat(), "end_date": (start + timedelta(hours=1)).isoformat(), **extra}


def simultaneous(jobs):
    ready = Barrier(len(jobs))

    def run(job):
        ready.wait(timeout=15)
        return job()

    with ThreadPoolExecutor(max_workers=len(jobs)) as executor:
        futures = [executor.submit(run, job) for job in jobs]
        return [future.result(timeout=45) for future in futures]


@pytest.mark.parametrize("users", [2, 8])
def test_same_snapshot_has_one_winner_and_every_loser_can_refresh_then_retry(planners, users):
    c = planners
    oid = c.ids[0]
    proposals = [edit(c, oid, offset=i * 2) for i in range(users)]
    results = simultaneous([
        lambda i=i: request(c.users[i], "/tasks/update", {"tasks": [proposals[i]]}) for i in range(users)
    ])
    winners = [i for i, result in enumerate(results) if result["persisted"] == 1]
    assert len(winners) == 1
    winner = winners[0]
    saved = versions(c, [oid])[oid]
    assert saved["start_date"] == proposals[winner]["start_date"]
    assert saved["row_version"] == results[winner]["versions"][oid]
    assert saved["row_version"] != c.initial[oid]["row_version"]
    for i, result in enumerate(results):
        if i == winner:
            assert result["stale"] == []
            continue
        assert result["persisted"] == 0 and result["stale"] == [oid]
        assert result["versions"] == {} and result["failed"] == 0
        refreshed = request(c.users[i], "/tasks/refresh", {"ids": [oid]})
        assert refreshed["missing"] == []
        assert refreshed["data"][0]["row_version"] == saved["row_version"]
        assert refreshed["data"][0]["start_date"] == saved["start_date"]
    loser = next(i for i in range(users) if i != winner)
    retried = request(c.users[loser], "/tasks/update", {
        "tasks": [{**proposals[loser], "base_version": saved["row_version"]}],
    })
    assert retried["persisted"] == 1 and retried["stale"] == []
    assert versions(c, [oid])[oid]["start_date"] == proposals[loser]["start_date"]


@pytest.mark.parametrize("users", [2, 8])
def test_competing_strict_optimizers_cannot_both_claim_the_same_machine_slot(planners, users):
    c = planners
    proposals = [edit(c, oid, FIRMED=True) for oid in c.ids[:users]]
    results = simultaneous([
        lambda i=i: request(c.users[i], "/tasks/update", {
            "tasks": [proposals[i]], "atomic_optimizer": True, "strict_conflicts": True,
        }) for i in range(users)
    ])
    winners = [i for i, result in enumerate(results) if result["persisted"] == 1]
    assert len(winners) == 1, results
    winner = winners[0]
    stored = versions(c, c.ids[:users])
    for i, result in enumerate(results):
        oid = c.ids[i]
        if i == winner:
            assert result["status"] == "ok" and result["conflicts"] == []
            assert stored[oid]["firmed"] is True
            assert stored[oid]["start_date"] == c.target.isoformat()
        else:
            assert result["status"] == "error" and result["error_code"] == "schedule.conflicts"
            assert result["persisted"] == 0 and result["versions"] == {}
            assert any({conflict["order_a"], conflict["order_b"]} == {oid, c.ids[winner]}
                       for conflict in result["conflicts"])
            assert stored[oid] == c.initial[oid], "rejected Apply must roll back dates, firming and xmin"


def test_reversed_overlapping_batch_orders_do_not_deadlock_or_partially_commit(planners):
    c = planners
    ids = c.ids[:4]
    first = [edit(c, oid, offset=i * 2) for i, oid in enumerate(ids)]
    second = [edit(c, oid, offset=i * 2 + 12) for i, oid in reversed(list(enumerate(ids)))]
    results = simultaneous([
        lambda: request(c.users[0], "/tasks/update", {"tasks": first, "atomic_optimizer": True}),
        lambda: request(c.users[1], "/tasks/update", {"tasks": second, "atomic_optimizer": True}),
    ])
    assert sorted(result["persisted"] for result in results) == [0, 4]
    winner = next(i for i, result in enumerate(results) if result["persisted"] == 4)
    loser = results[1 - winner]
    assert set(loser["stale"]) == set(ids) and loser["versions"] == {}
    stored = versions(c, ids)
    for item in [first, second][winner]:
        assert stored[item["id"]]["start_date"] == item["start_date"]
        assert stored[item["id"]]["row_version"] == results[winner]["versions"][item["id"]]


@pytest.mark.parametrize("atomic", [False, True], ids=["manual-best-effort", "optimizer-atomic"])
def test_one_peer_edit_has_the_correct_batch_rejection_scope(planners, atomic):
    c = planners
    peer = request(c.users[1], "/tasks/update", {"tasks": [edit(c, c.ids[3], offset=20)]})
    assert peer["persisted"] == 1
    peer_row = versions(c, [c.ids[3]])[c.ids[3]]
    proposals = [edit(c, oid, offset=i * 2, force=True) for i, oid in enumerate(c.ids[:4])]
    # Force is explicitly ignored in atomic mode. For a manual batch use the
    # browser's normal concurrency-checked save, without its opt-out flag.
    if not atomic:
        for item in proposals:
            item.pop("force")
    result = request(c.users[0], "/tasks/update", {"tasks": proposals, "atomic_optimizer": atomic})
    assert result["persisted"] == (0 if atomic else 3)
    assert result["stale"] == [c.ids[3]]
    current = versions(c, c.ids[:4])
    assert current[c.ids[3]] == peer_row
    for item in proposals[:3]:
        oid = item["id"]
        if atomic:
            assert current[oid] == c.initial[oid]
        else:
            assert current[oid]["start_date"] == item["start_date"]
            assert current[oid]["row_version"] == result["versions"][oid]


def test_parallel_refreshes_and_cross_plant_saves_do_not_share_request_identity(planners):
    c = planners
    requested = [c.ids[0], c.other_id]
    jobs = []
    for i in range(8):
        user = c.users[i] if i % 2 == 0 else c.other_user
        jobs.append(lambda user=user: request(user, "/tasks/refresh", {"ids": requested}))
    for i, result in enumerate(simultaneous(jobs)):
        visible, hidden = requested if i % 2 == 0 else list(reversed(requested))
        assert [row["id"] for row in result["data"]] == [visible]
        assert result["missing"] == [hidden]
    denied = simultaneous([
        lambda: request(c.users[0], "/tasks/update", {"tasks": [edit(c, c.other_id)]}),
        lambda: request(c.other_user, "/tasks/update", {"tasks": [edit(c, c.ids[0])]}),
    ])
    assert [result["not_found_ids"] for result in denied] == [[c.other_id], [c.ids[0]]]
    assert all(result["persisted"] == 0 and result["versions"] == {} for result in denied)
    assert versions(c, requested) == {oid: c.initial[oid] for oid in requested}


def test_scope_change_is_observed_by_next_request_using_same_client(planners):
    c = planners
    with closing(TestClient(brain.api)) as client:
        headers = {"x-user-email": c.users[0]}
        first = client.post("/tasks/refresh", headers=headers, json={"ids": c.ids[:1]})
        assert first.status_code == 200 and len(first.json()["data"]) == 1
        # Reassign the role, retaining a scope row (zero rows means unrestricted
        # under the documented pilot compatibility rule).
        with c.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE role_plants SET plant=%s WHERE role=%s", (c.other, c.roles[0]))
        refreshed = client.post("/tasks/refresh", headers=headers, json={"ids": [c.ids[0], c.other_id]})
        assert refreshed.status_code == 200
        assert [row["id"] for row in refreshed.json()["data"]] == [c.other_id]
        assert refreshed.json()["missing"] == c.ids[:1]
        result = client.post("/tasks/update", headers=headers, json={"tasks": [edit(c, c.ids[0])]})
        assert result.status_code == 200 and result.json()["not_found_ids"] == c.ids[:1]
        assert versions(c, c.ids[:1])[c.ids[0]] == c.initial[c.ids[0]]


def test_busy_machine_in_one_plant_does_not_block_same_machine_code_in_another(planners):
    c = planners
    def payload(oid):
        return {"tasks": [edit(c, oid)], "atomic_optimizer": True, "strict_conflicts": True}
    # Hold the actual machine advisory lock, then observe the first save waiting
    # on that exact lock before proving the other plant can commit independently.
    with c.db._pool.connection() as blocker, blocker.cursor() as cur:
        cur.execute("SELECT pg_backend_pid()")
        blocker_pid = cur.fetchone()[0]
        cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (c.db._strict_lock_key(c.plant, c.db._machine_match_key(c.machine)),))
        with ThreadPoolExecutor(max_workers=2) as executor:
            blocked = executor.submit(request, c.users[0], "/tasks/update", payload(c.ids[0]))
            try:
                deadline = monotonic() + 10
                while monotonic() < deadline:
                    with c.db._pool.connection() as observer, observer.cursor() as obs:
                        obs.execute(
                            "SELECT EXISTS(SELECT 1 FROM pg_locks held JOIN pg_locks waiting"
                            " USING (locktype, database, classid, objid, objsubid)"
                            " WHERE held.pid=%s AND held.granted AND NOT waiting.granted"
                            " AND held.locktype='advisory')", (blocker_pid,),
                        )
                        if obs.fetchone()[0]:
                            break
                    sleep(0.01)
                else:
                    pytest.fail("save never waited on the fixture's machine lock")
                assert not blocked.done()
                independent = executor.submit(request, c.other_user, "/tasks/update", payload(c.other_id))
                result = independent.result(timeout=10)
                assert result["persisted"] == 1 and result["conflicts"] == []
                assert not blocked.done(), "the original plant must still be waiting for its lock"
            finally:
                blocker.rollback()
            assert blocked.result(timeout=15)["persisted"] == 1
