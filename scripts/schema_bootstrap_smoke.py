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
  2. Applying the current-schema-compatible migration subset, filename-sorted,
     ON TOP of that same schema.sql bootstrap succeeds twice. After both
     replays, it compares the SAME `orders` column shape, a bounded structural
     public-schema fingerprint (tables, columns, indexes, and constraints), and
     a bounded deterministic data/ledger contract against schema.sql alone. The
     data contract covers stable schema-migration IDs, column metadata, the
     singleton system settings row, and a deterministic sentinel order while
     excluding volatile timestamps and sequence values. Frozen pre-cutover
     migrations that target legacy production_lines/line_* names,
     default_workcenter, or hand-applied one-shot cutovers are explicitly
     skipped and printed; those files are not checked by this smoke test.

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

Exit code 0 = schema.sql bootstrap plus the replayable/current-schema-compatible
migration subset passed a second replay, and the `orders` column shape, bounded
structural fingerprint, and bounded deterministic data/ledger contract matched
the schema.sql baseline. Nonzero = a `psql` step failed (ON_ERROR_STOP=1 aborts
that step), a second replay failed, or one of those bounded comparisons
diverged. Explicitly skipped historical/hand-applied migrations are not
checked by this script.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import os
import subprocess
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_SQL = os.path.join(ROOT, "schema.sql")
MIGRATIONS_DIR = os.path.join(ROOT, "migrations")

SCRATCH_DB_PREFIX = "nimbus_bootstrap_test_"

ORDERS_COLUMNS_SQL = (
    "SELECT column_name, data_type, is_nullable, column_default "
    "FROM information_schema.columns "
    "WHERE table_name = 'orders' ORDER BY column_name;"
)

# Deliberately bounded and structural: this catches drift in every ordinary
# public table, column, index, and table constraint without depending on
# volatile row contents, sequence values, object identifiers, or excluded
# historical/hand-applied migrations. The output is sorted and hashed by
# Python, so identical fresh databases produce the same fingerprint.
SCHEMA_FINGERPRINT_SQL = """
WITH objects AS (
    SELECT
        'table'::text AS object_type,
        table_name AS object_name,
        table_type AS object_detail
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
    UNION ALL
    SELECT
        'column'::text,
        table_name || '.' || lpad(ordinal_position::text, 4, '0') || '.' || column_name,
        concat_ws('|', data_type, udt_schema, udt_name, is_nullable,
                  character_maximum_length, numeric_precision, column_default)
      FROM information_schema.columns
     WHERE table_schema = 'public'
    UNION ALL
    SELECT
        'index'::text,
        schemaname || '.' || indexname,
        indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
    UNION ALL
    SELECT
        'constraint'::text,
        ns.nspname || '.' || cls.relname || '.' || con.conname,
        concat_ws('|', pg_get_constraintdef(con.oid, true), con.convalidated)
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE ns.nspname = 'public'
)
SELECT object_type, object_name, object_detail
  FROM objects
 ORDER BY object_type, object_name, object_detail;
"""

# Deliberately bounded data contract: compare deterministic rows and ledger
# keys that data-mutating migrations can touch without hashing volatile audit
# timestamps, upload timestamps, or sequence-backed IDs. The fixed order and
# settings/metadata sentinel are seeded in both scratch databases before the
# first replay, so a second replay that mutates these stable values is visible.
DATA_CONTRACT_SQL = """
WITH contracts AS (
    SELECT
        'schema_migrations'::text AS contract_name,
        id::text AS contract_key,
        id::text AS contract_value
      FROM schema_migrations
    UNION ALL
    SELECT
        'column_metadata'::text,
        table_name || '.' || column_name,
        concat_ws('|', display_label, is_locked::text, column_order::text)
      FROM column_metadata
    UNION ALL
    SELECT
        'system_settings'::text,
        id::text,
        settings::text
      FROM system_settings
     WHERE id = 1
    UNION ALL
    SELECT
        'orders'::text,
        o.id,
        (to_jsonb(o) - ARRAY['uploaded_at', 'updated_at', 'upload_batch_id'])::text
      FROM orders AS o
     WHERE o.id = 'ZZTEST_SMOKE_ORDER'
)
SELECT contract_name, contract_key, contract_value
  FROM contracts
 ORDER BY contract_name, contract_key, contract_value;
"""

DATA_SENTINEL_SQL = """
INSERT INTO column_metadata
    (table_name, column_name, display_label, is_locked, column_order)
VALUES ('ZZTEST_SMOKE', 'sentinel', 'Task 3 smoke sentinel', TRUE, 999)
ON CONFLICT (table_name, column_name) DO UPDATE SET
    display_label = EXCLUDED.display_label,
    is_locked = EXCLUDED.is_locked,
    column_order = EXCLUDED.column_order;

INSERT INTO system_settings (id, settings)
VALUES (1, '{"task3SmokeSentinel": "v1"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings;

INSERT INTO orders
    (id, production_order, material_number, material_description, machine,
     basic_start_date, basic_finish_date, plant, run_time, color,
     order_quantity, notes)
VALUES
    ('ZZTEST_SMOKE_ORDER', 'ZZTEST_SMOKE_ORDER', 'ZZTEST_SMOKE_MATERIAL',
     'Task 3 smoke sentinel order', 'ZZTEST_SMOKE_MACHINE',
     TIMESTAMP '2026-01-02 08:00:00', TIMESTAMP '2026-01-02 12:00:00',
     'ZZTEST_SMOKE', 4, 'ZZTEST_BLUE', 25, 'Task 3 smoke sentinel')
ON CONFLICT (id) DO UPDATE SET
    production_order = EXCLUDED.production_order,
    material_number = EXCLUDED.material_number,
    material_description = EXCLUDED.material_description,
    machine = EXCLUDED.machine,
    basic_start_date = EXCLUDED.basic_start_date,
    basic_finish_date = EXCLUDED.basic_finish_date,
    plant = EXCLUDED.plant,
    run_time = EXCLUDED.run_time,
    color = EXCLUDED.color,
    order_quantity = EXCLUDED.order_quantity,
    notes = EXCLUDED.notes;
"""

SKIPPED_POST_SCHEMA_MIGRATIONS = {
    # Pre machine-rename SAP seed uses the legacy production_lines object key.
    "2026-06-30-sap-interface.sql": "pre-cutover production_lines SAP object key",
    # These frozen files target tables/columns renamed by the 2026-08-20 cutover.
    # (production-line-optimizer-flags / changeover-matrix-stage-0 / default-workcenter and the
    # other cutover files live in migrations/manual/, which this non-recursive glob never sees.)
    "2026-08-11-priority-lists.sql": "pre-cutover priority_list.line column",
}


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


def _quote_identifier(identifier: str) -> str:
    """Quote a generated database name as a PostgreSQL identifier."""
    return '"' + identifier.replace('"', '""') + '"'


def _scratch_db_names() -> tuple[str, str]:
    """Return unique names owned by this invocation only."""
    token = uuid.uuid4().hex[:12]
    return (
        f"{SCRATCH_DB_PREFIX}schema_{token}",
        f"{SCRATCH_DB_PREFIX}migrations_{token}",
    )


def _create_database(args, dbname: str) -> None:
    admin = _psql_base(args) + ["-d", "postgres"]
    _run(admin + ["-c", f"CREATE DATABASE {_quote_identifier(dbname)};"])


def _drop_database_best_effort(args, dbname: str) -> None:
    """Drop only this run's scratch database without masking an earlier error."""
    admin = _psql_base(args) + ["-d", "postgres"]
    try:
        result = _run(
            admin
            + [
                "-c",
                f"DROP DATABASE IF EXISTS {_quote_identifier(dbname)} WITH (FORCE);",
            ],
            check=False,
        )
    except Exception as exc:  # pragma: no cover - subprocess startup failure
        print(f"WARNING: scratch database cleanup failed for {dbname}: {exc}", file=sys.stderr)
        return
    if result.returncode != 0:
        print(f"WARNING: scratch database cleanup failed for {dbname}", file=sys.stderr)


def _apply_file(args, dbname: str, path: str) -> None:
    cmd = _psql_base(args) + ["-d", dbname, "-f", path]
    _run(cmd)


def _orders_columns(args, dbname: str) -> str:
    cmd = _psql_base(args) + ["-d", dbname, "-A", "-t", "-c", ORDERS_COLUMNS_SQL]
    result = _run(cmd)
    return result.stdout.strip()


def _schema_fingerprint(args, dbname: str) -> str:
    """Return a stable hash of the bounded public-schema structural contract."""
    cmd = _psql_base(args) + ["-d", dbname, "-A", "-t", "-c", SCHEMA_FINGERPRINT_SQL]
    result = _run(cmd)
    return hashlib.sha256(result.stdout.encode("utf-8")).hexdigest()


def _seed_data_contract(args, dbname: str) -> None:
    """Seed stable, disposable rows used by the replay data-idempotence check."""
    cmd = _psql_base(args) + ["-d", dbname, "-c", DATA_SENTINEL_SQL]
    _run(cmd)


def _data_fingerprint(args, dbname: str) -> str:
    """Return a stable hash of the bounded deterministic data/ledger contract."""
    cmd = _psql_base(args) + ["-d", dbname, "-A", "-t", "-c", DATA_CONTRACT_SQL]
    result = _run(cmd)
    return hashlib.sha256(result.stdout.encode("utf-8")).hexdigest()


def _migration_files() -> tuple[list[str], list[tuple[str, str]]]:
    migration_files = sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql")))
    applied: list[str] = []
    skipped: list[tuple[str, str]] = []
    for path in migration_files:
        name = os.path.basename(path)
        reason = SKIPPED_POST_SCHEMA_MIGRATIONS.get(name)
        if reason:
            skipped.append((name, reason))
        else:
            applied.append(path)
    return applied, skipped


def _replay_migrations(args, dbname: str, migration_files: list[str], pass_name: str) -> None:
    print(f"{pass_name}: {len(migration_files)} replayable/current-schema-compatible migration files")
    for path in migration_files:
        _apply_file(args, dbname, path)


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

    schema_db, migrations_db = _scratch_db_names()
    created_databases: list[str] = []
    print(f"Scratch databases for this run: {schema_db}, {migrations_db}")

    try:
        print("== Step 1: fresh schema.sql bootstrap (the literal A3 regression check) ==")
        _create_database(args, schema_db)
        created_databases.append(schema_db)
        _apply_file(args, schema_db, SCHEMA_SQL)

        print("\n== Step 2: schema.sql bootstrap, THEN the replayable/current-schema-compatible migration subset ==")
        print("(frozen legacy/hand-applied cutover files are explicitly skipped and are not checked)")
        _create_database(args, migrations_db)
        created_databases.append(migrations_db)
        _apply_file(args, migrations_db, SCHEMA_SQL)
        _seed_data_contract(args, schema_db)
        _seed_data_contract(args, migrations_db)
        migration_files, skipped = _migration_files()
        if not migration_files:
            raise SystemExit(f"No migration files found under {MIGRATIONS_DIR}")
        if skipped:
            print("Skipped post-schema migration replay files:")
            for name, reason in skipped:
                print(f"  - {name}: {reason}")
        _replay_migrations(args, migrations_db, migration_files, "First replay")

        print(
            "\n== Step 3: compare orders columns, bounded public-schema structural "
            "fingerprint, and bounded deterministic data/ledger contract after first replay =="
        )
        schema_cols = _orders_columns(args, schema_db)
        first_replay_cols = _orders_columns(args, migrations_db)
        schema_fingerprint = _schema_fingerprint(args, schema_db)
        first_replay_fingerprint = _schema_fingerprint(args, migrations_db)
        schema_data_fingerprint = _data_fingerprint(args, schema_db)
        first_replay_data_fingerprint = _data_fingerprint(args, migrations_db)

        print("\n== Step 4: replay the same replayable/current-schema-compatible migration subset a second time ==")
        _replay_migrations(args, migrations_db, migration_files, "Second replay")
        second_replay_cols = _orders_columns(args, migrations_db)
        second_replay_fingerprint = _schema_fingerprint(args, migrations_db)
        second_replay_data_fingerprint = _data_fingerprint(args, migrations_db)

        scope = (
            "schema.sql plus the replayable/current-schema-compatible migration subset "
            f"({len(migration_files)} files), a second replay, the bounded structural "
            "fingerprint (tables, columns, indexes, constraints), and the bounded "
            "deterministic data/ledger contract (schema_migrations IDs, column_metadata, "
            "system_settings, and the sentinel order; volatile timestamps/sequence values "
            f"excluded); explicitly skipped historical/hand-applied files ({len(skipped)} files) "
            "were not checked"
        )
        mismatches = []
        if schema_cols != first_replay_cols:
            mismatches.append("orders columns after first replay")
        if schema_cols != second_replay_cols:
            mismatches.append("orders columns after second replay")
        if first_replay_cols != second_replay_cols:
            mismatches.append("orders columns between replays")
        if schema_fingerprint != first_replay_fingerprint:
            mismatches.append("bounded structural fingerprint after first replay")
        if schema_fingerprint != second_replay_fingerprint:
            mismatches.append("bounded structural fingerprint after second replay")
        if first_replay_fingerprint != second_replay_fingerprint:
            mismatches.append("bounded structural fingerprint between replays")
        if schema_data_fingerprint != first_replay_data_fingerprint:
            mismatches.append("bounded data/ledger contract after first replay")
        if schema_data_fingerprint != second_replay_data_fingerprint:
            mismatches.append("bounded data/ledger contract after second replay")
        if first_replay_data_fingerprint != second_replay_data_fingerprint:
            mismatches.append("bounded data/ledger contract between replays")

        if not mismatches:
            print(
                "PASS: "
                f"{scope}; first and second replay completed, orders columns match, "
                "and both bounded fingerprints match the schema.sql baseline."
            )
            return 0

        print(f"FAIL: {scope}; comparison mismatch: {', '.join(mismatches)}.", file=sys.stderr)
        print(
            "The smoke check covered schema.sql, the replayable/current-schema-compatible "
            "subset, a second replay, the bounded structural fingerprint, and the bounded "
            "deterministic data/ledger contract; excluded historical/hand-applied migrations "
            "were not checked.",
            file=sys.stderr,
        )
        print("--- schema.sql orders columns ---", file=sys.stderr)
        print(schema_cols, file=sys.stderr)
        print("--- first replay orders columns ---", file=sys.stderr)
        print(first_replay_cols, file=sys.stderr)
        print("--- second replay orders columns ---", file=sys.stderr)
        print(second_replay_cols, file=sys.stderr)
        print("--- schema.sql bounded structural fingerprint ---", file=sys.stderr)
        print(schema_fingerprint, file=sys.stderr)
        print("--- first replay bounded structural fingerprint ---", file=sys.stderr)
        print(first_replay_fingerprint, file=sys.stderr)
        print("--- second replay bounded structural fingerprint ---", file=sys.stderr)
        print(second_replay_fingerprint, file=sys.stderr)
        print("--- schema.sql bounded data/ledger contract ---", file=sys.stderr)
        print(schema_data_fingerprint, file=sys.stderr)
        print("--- first replay bounded data/ledger contract ---", file=sys.stderr)
        print(first_replay_data_fingerprint, file=sys.stderr)
        print("--- second replay bounded data/ledger contract ---", file=sys.stderr)
        print(second_replay_data_fingerprint, file=sys.stderr)
        return 1
    finally:
        for dbname in reversed(created_databases):
            try:
                _drop_database_best_effort(args, dbname)
            except Exception as exc:  # pragma: no cover - defensive around cleanup helpers
                print(f"WARNING: scratch database cleanup failed for {dbname}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
