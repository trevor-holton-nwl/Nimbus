"""
Schema bootstrap smoke check (plan `rippling-brewing-hamming.md`, section A3 /
B8 item 3).

**Correction vs. the plan's literal wording** (found on direct inspection,
same spirit as the plan's own "Changes" section — verify before trusting):
the plan describes applying `migrations/*.sql` ALONE to an empty scratch
database and diffing its `orders` shape against a fresh `schema.sql` bootstrap.
That does not work as stated: grepping `migrations/*.sql` shows **no**
migration file contains `CREATE TABLE orders` (or `machine`) — every
migration is an `ALTER TABLE`/data-only change that assumes those tables
already exist. This matches root CLAUDE.md's own description of the ledger
("dated, additive, idempotent .sql files mirroring what schema.sql also
carries") and `docs/DEPLOYMENT.md`'s first-time-provisioning step ("load
schema ONCE"): the migrations/ ledger is additive on top of a schema.sql-
bootstrapped database, not a from-scratch bootstrap path of its own. Applying
migrations/*.sql to a truly empty database would fail on the first
orders/plants-touching file for a reason unrelated to A3's actual bug
(bootstrap-order inside schema.sql itself).

So this script instead checks the two things that are actually true and
actually matter:

  1. A fresh `psql -v ON_ERROR_STOP=1 -f schema.sql` bootstrap succeeds
     end-to-end against an EMPTY database (the literal A3 regression: schema.sql
     used to reference `orders.plant` in an index before the column existed).
  2. Applying the full `migrations/*.sql` ledger, filename-sorted, ON TOP of
     that same schema.sql bootstrap (simulating Azure's real history: schema
     loaded once, then every dated migration applied since) produces the
     SAME `orders` column shape as schema.sql alone -- i.e. the ledger never
     silently drifts the live shape away from what a fresh clone of the repo
     would produce.

This is a STANDALONE script, not a pytest test: it shells out to `psql`
against two throwaway scratch databases and does not touch the app's own
`NIMBUS_TEST_DB=1` DB-safety guard (tests/conftest.py) at all -- there is no
app import here, just raw `psql` invocations. CI runs it after the main
`schema.sql` bootstrap, using the workflow's local Postgres service and
`PGPASSWORD` environment variable.

Usage (matches the local dev setup in root CLAUDE.md's "Database Setup"):
    & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" --version   # confirm psql is on PATH first
    python scripts/schema_bootstrap_smoke.py
    python scripts/schema_bootstrap_smoke.py --host localhost --port 5432 --user postgres

Requires:
  - A reachable local/CI Postgres server (never point this at the Azure pilot
    -- it CREATEs and DROPs scratch databases).
  - `psql` on PATH, or pass --psql "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe".
  - PGPASSWORD set in the environment (or a trust/peer-auth local setup).

Exit code 0 = both paths produced an identical `orders` column set; nonzero =
either a `psql` step failed (ON_ERROR_STOP=1 aborts that step) or the two
`orders` shapes diverged (diff printed to stdout).
"""
from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_SQL = os.path.join(ROOT, "schema.sql")
MIGRATIONS_DIR = os.path.join(ROOT, "migrations")

SCHEMA_DB = "nimbus_bootstrap_test_schema"
MIGRATIONS_DB = "nimbus_bootstrap_test_migrations"

ORDERS_COLUMNS_SQL = (
    "SELECT column_name, data_type, is_nullable, column_default "
    "FROM information_schema.columns "
    "WHERE table_name = 'orders' ORDER BY column_name;"
)


def _psql_base(args) -> list[str]:
    base = [args.psql, "-h", args.host, "-p", str(args.port), "-U", args.user, "-v", "ON_ERROR_STOP=1"]
    return base


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.stdout.strip():
        print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        if check:
            raise SystemExit(f"Command failed (exit {result.returncode}): {' '.join(cmd)}")
    return result


def _dropcreate_db(args, dbname: str) -> None:
    admin = _psql_base(args) + ["-d", "postgres"]
    _run(admin + ["-c", f'DROP DATABASE IF EXISTS "{dbname}";'])
    _run(admin + ["-c", f'CREATE DATABASE "{dbname}";'])


def _apply_file(args, dbname: str, path: str) -> None:
    cmd = _psql_base(args) + ["-d", dbname, "-f", path]
    _run(cmd)


def _orders_columns(args, dbname: str) -> str:
    cmd = _psql_base(args) + ["-d", dbname, "-A", "-t", "-c", ORDERS_COLUMNS_SQL]
    result = _run(cmd)
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("PG_HOST", "localhost"))
    parser.add_argument("--port", default=os.environ.get("PG_PORT", "5432"))
    parser.add_argument("--user", default=os.environ.get("PG_USER", "postgres"))
    parser.add_argument("--psql", default="psql", help="Path to the psql executable if not on PATH")
    args = parser.parse_args()

    if args.host not in ("localhost", "127.0.0.1"):
        raise SystemExit(
            f"Refusing to run against non-local host {args.host!r} -- this script CREATEs "
            "and DROPs scratch databases; never point it at the Azure pilot."
        )

    print("== Step 1: fresh schema.sql bootstrap (the literal A3 regression check) ==")
    _dropcreate_db(args, SCHEMA_DB)
    _apply_file(args, SCHEMA_DB, SCHEMA_SQL)

    print("\n== Step 2: schema.sql bootstrap, THEN the full migrations/*.sql ledger on top ==")
    print("(mirrors Azure's real history: schema loaded ONCE at provisioning, "
          "every dated migration applied since -- see docs/DEPLOYMENT.md)")
    _dropcreate_db(args, MIGRATIONS_DB)
    _apply_file(args, MIGRATIONS_DB, SCHEMA_SQL)
    migration_files = sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql")))
    if not migration_files:
        raise SystemExit(f"No migration files found under {MIGRATIONS_DIR}")
    for path in migration_files:
        _apply_file(args, MIGRATIONS_DB, path)

    print("\n== Step 3: diff orders column shape ==")
    schema_cols = _orders_columns(args, SCHEMA_DB)
    migrations_cols = _orders_columns(args, MIGRATIONS_DB)

    if schema_cols == migrations_cols:
        print("MATCH: schema.sql alone and schema.sql+migrations/*.sql produce an "
              "identical orders table shape -- the ledger has not drifted.")
        return 0

    print("MISMATCH: applying the full migrations/*.sql ledger changed the orders "
          "shape relative to schema.sql alone.", file=sys.stderr)
    print("--- schema.sql orders columns ---", file=sys.stderr)
    print(schema_cols, file=sys.stderr)
    print("--- schema.sql + migrations/*.sql orders columns ---", file=sys.stderr)
    print(migrations_cols, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
