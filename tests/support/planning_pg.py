"""Owned, independently named rows for real labor/calendar integration tests.

The existing ``pg`` fixture enforces localhost, opt-in, and availability. No
schema changes or global cleanup are performed by this fixture.
"""

from types import SimpleNamespace
from uuid import uuid4

import pytest


def cleanup_schedule_events(cur, *, actor=None, plants=()):
    """Remove schedule_event rows written by a test (by actor and/or plant). Tolerates a database that
    predates the table: the statement runs under a savepoint so a missing table never aborts teardown."""
    plants = list(plants or ())
    if actor is None and not plants:
        return
    try:
        cur.execute("SAVEPOINT cleanup_sched_ev")
        cur.execute("DELETE FROM schedule_event WHERE actor = %s OR plant = ANY(%s)", (actor, plants))
        cur.execute("RELEASE SAVEPOINT cleanup_sched_ev")
    except Exception:  # noqa: BLE001 - e.g. UndefinedTable on an older DB
        try:
            cur.execute("ROLLBACK TO SAVEPOINT cleanup_sched_ev")
        except Exception:  # noqa: BLE001
            pass


@pytest.fixture
def planning_pg(pg):
    token = uuid4().hex[:10]
    context = SimpleNamespace(
        db=pg,
        subnet=f"ZZTEST_PC_{token}",
        plant=f"ZZTEST_PC_{token}_A",
        other=f"ZZTEST_PC_{token}_B",
        actor=f"zztest.planning.{token}@example.com",
        machine="SHARED_LINE",
    )
    plants = [context.plant, context.other]
    try:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks(code, name) VALUES (%s, %s)",
                        (context.subnet, "Planning integration tests"))
            cur.executemany("INSERT INTO plants(subnetwork, plant) VALUES (%s, %s)",
                            [(context.subnet, plant) for plant in plants])
            cur.executemany(
                "INSERT INTO machine(subnetwork, plant, machine, wc_group) VALUES (%s, %s, %s, %s)",
                [(context.subnet, context.plant, context.machine, "CUT"),
                 (context.subnet, context.plant, "PACK_LINE", "PACK"),
                 (context.subnet, context.other, context.machine, "PACK")],
            )
        yield context
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            # Line labor deliberately has no FK; remove only this fixture's rows.
            cur.execute("DELETE FROM labor_plan_machine WHERE subnetwork = %s", (context.subnet,))
            cur.execute("DELETE FROM admin_audit WHERE user_email = %s", (context.actor,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (context.subnet,))
            cleanup_schedule_events(cur, actor=context.actor, plants=plants)


def audit_rows(context, table):
    with context.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT action, details FROM admin_audit WHERE user_email = %s AND table_name = %s ORDER BY id",
            (context.actor, table),
        )
        return cur.fetchall()
