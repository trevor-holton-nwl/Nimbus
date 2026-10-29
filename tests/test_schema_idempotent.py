"""
Regression guards for the schema.sql ×1440 horizon idempotency fix (2026-07-07).

Background: schema.sql used to re-run an UNGUARDED
    UPDATE plants SET *_horizon = *_horizon * 1440 WHERE *_horizon <= 365
on every apply, silently re-multiplying any legitimate sub-365-MINUTE horizon
edit into garbage. It is now recorded in a `schema_migrations` ledger and no
longer re-runs. See MIGRATION.md → "Schema migration ledger".

Two layers:
  * Static tests (no DB) pin the *file* content — the recurring multiply is gone
    and the ledger is in place. These run unconditionally.
  * The @pytest.mark.pg test re-applies the whole schema.sql against a seeded
    sub-365 plant and asserts the value SURVIVES (the true end-to-end idempotency
    check; catches a reintroduced data mutation anywhere in the file).
"""
import contextlib
import os
import re
import sys

import pytest

from scripts import schema_bootstrap_smoke

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(ROOT, "schema.sql")
SETUP_MIGRATION_PATH = os.path.join(ROOT, "migrations", "2026-08-13-changeover-matrix-stage-0.sql")


@contextlib.contextmanager
def _rolled_back(pg):
    """A cursor whose whole transaction is ROLLED BACK on exit. Every test that applies schema.sql runs inside
    one: schema.sql ends with the ledger-guarded backward-scheduling cutover, and a COMMITTED apply on a
    developer database that lacks the ledger id would null its placed finishes and delete its segments once
    (senior review I14). Nothing here may commit."""
    with pg._pool.connection() as conn, conn.cursor() as cur:
        try:
            yield cur
        finally:
            conn.rollback()


def _schema_text() -> str:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return f.read()


def _setup_schema_texts() -> list[tuple[str, str]]:
    """Both deployment paths must provide identical setup persistence guards.

    SETUP_MIGRATION_PATH (2026-08-13-changeover-matrix-stage-0.sql) is EXCLUDED
    from this comparison as of the 2026-08-20 Production Line -> Machine rename.
    That migration is a frozen historical record of what was actually applied to
    Azure on 2026-08-13 (pre-rename naming: `line`, `production_lines`) and is not
    rewritten retroactively — schema.sql now uses `machine` naming, so the two
    would permanently disagree on those tokens. The live Azure DB is reconciled
    to the new naming by a separate, one-time hand-applied cutover migration
    (migrations/manual/2026-08-20-line-to-machine.sql), not by keeping this dated file
    in lockstep with schema.sql. Only SCHEMA_PATH is checked here now; the
    constant is kept (unused below) so this rationale stays attached to it."""
    return [(SCHEMA_PATH, _schema_text())]


def _table_block(text: str, table: str) -> str:
    """Return one CREATE TABLE body so each contract stays table-specific."""
    match = re.search(
        rf"CREATE TABLE IF NOT EXISTS {table} \((?P<body>.*?)\n\);",
        text,
        re.DOTALL,
    )
    assert match is not None, f"missing CREATE TABLE IF NOT EXISTS {table}"
    return match.group("body")


def test_no_unguarded_horizon_multiply_statement():
    """The recurring, unguarded `UPDATE plants SET *_horizon = *_horizon * 1440`
    must not exist as a live statement. It is preserved ONLY inside comment lines
    (the documented one-off restore step), which we strip before checking."""
    text = _schema_text()
    live_lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("--")]
    live_sql = "\n".join(live_lines)
    assert not re.search(r"UPDATE\s+plants\s+SET.*\*\s*1440", live_sql, re.IGNORECASE), (
        "The unguarded ×1440 horizon UPDATE is back as a live statement — this "
        "re-introduces the landmine (it re-multiplies sub-365 values on every apply)."
    )


def test_schema_migrations_ledger_present():
    text = _schema_text()
    assert "CREATE TABLE IF NOT EXISTS schema_migrations" in text
    assert "plants_horizon_minutes" in text, (
        "The horizon conversion must be recorded in the schema_migrations ledger."
    )


def test_workcenter_exists_before_distribution_foreign_key():
    text = _schema_text()
    assert text.index("CREATE TABLE IF NOT EXISTS sap_workcenter (") < text.index(
        "CREATE TABLE IF NOT EXISTS order_distribution ("
    )


def test_order_distribution_plant_start_index_in_schema_and_migration():
    """D42: `_fetch_header_rows`' ORDER BY (plant WHERE + basic_start_date,
    reviewed, production_order, material_number) needs a matching index — it
    must exist both in schema.sql (the always-safe-to-reapply baseline) and
    in the dated migrations/ file deploys actually apply (root CLAUDE.md:
    "Deploys apply migrations/, never schema.sql")."""
    index_stmt = (
        "CREATE INDEX IF NOT EXISTS idx_order_distribution_plant_start\n"
        "    ON order_distribution (plant, basic_start_date, reviewed, production_order, material_number);"
    )
    assert index_stmt in _schema_text()

    migration_path = os.path.join(ROOT, "migrations", "2026-10-01-order-distribution-plant-start-index.sql")
    with open(migration_path, encoding="utf-8") as f:
        migration_text = f.read()
    assert index_stmt in migration_text


def test_manual_migrations_folder_is_pinned_and_retired_column_stays_out_of_top_level():
    """Senior audit #4: 2026-08-10 re-created the retired default_workcenter
    column on current-schema databases; it now lives in migrations/manual/."""
    mig = os.path.join(ROOT, "migrations")
    manual = {n for n in os.listdir(os.path.join(mig, "manual")) if n.endswith(".sql")}
    assert manual == {
        "2026-07-03-production-line-optimizer-flags.sql",
        "2026-08-10-material-plant-default-workcenter.sql",
        "2026-08-13-changeover-matrix-stage-0.sql",
        "2026-08-17-line-key-columns.sql",
        "2026-08-20-line-to-machine.sql",
        "2026-08-20-setup-value-case-fold-backfill.sql",
        "2026-10-08-nimbus-mulesoft-role.sql",
        "2026-10-20-restore-precutover-snapshot.sql",
    }
    for name in os.listdir(mig):
        if name.endswith(".sql"):
            with open(os.path.join(mig, name), encoding="utf-8") as f:
                assert "ADD COLUMN IF NOT EXISTS default_workcenter" not in f.read(), name


def test_schema_bootstrap_smoke_skips_current_schema_incompatible_migrations():
    """The smoke script replays only migrations safe after current schema.sql.

    Frozen pre-machine-rename and hand-applied cutover migrations are already
    represented in current schema.sql; replaying them afterward would target
    legacy production_lines/line_* names or duplicate one-shot data backfills.
    """
    applied, skipped = schema_bootstrap_smoke._migration_files()
    skipped_names = {name for name, _reason in skipped}
    expected_skipped = {
        "2026-06-30-sap-interface.sql",
        "2026-08-11-priority-lists.sql",
    }

    expected_replayable = {
        "2026-10-19-2-rounding-value-label.sql",
        "2026-10-20-2-alert-profiles.sql",
        "2026-10-20-3-reset-date-format.sql",
        "2026-10-23-1-schedule-event.sql",
        "2026-10-27-1-setup-value-defaults.sql",
        "2026-10-27-1-tool-inventory.sql",
        "2026-10-29-1-job-scheduler.sql",
        "2026-10-30-1-job-artifacts.sql",
        "2026-07-07-color-wheel-table.sql",
        "2026-07-07-security-tables.sql",
        "2026-07-08-username-ci-index.sql",
        "2026-07-08-user-name-fields.sql",
        "2026-07-09-user-settings.sql",
        "2026-07-15-bom-items.sql",
        "2026-08-03-user-last-login.sql",
        "2026-08-07-material-plant-attributes.sql",
        "2026-08-12-order-schedule-segments.sql",
        "2026-08-12-plant-timezone.sql",
        "2026-08-13-changeover-matrix-stage-2-policies.sql",
        "2026-08-17-plant-max-pull-forward-days.sql",
        "2026-08-17-system-settings.sql",
        "2026-08-20-plant-frozen-horizon.sql",
        "2026-08-20-plant-visibility-horizon.sql",
        "2026-08-21-min-productive-segment-minutes.sql",
        "2026-08-21-plants-grid-roll-hour.sql",
        "2026-08-21-plants-grid-visibility.sql",
        "2026-08-24-orders-firming-indicator.sql",
        "2026-09-01-orders-sap-coois-fields.sql",
        "2026-09-02-drop-redundant-setup-matrix-index.sql",
        "2026-09-02-orders-plant-column.sql",
        "2026-09-09_optimizer_planning_exceptions.sql",
        "2026-09-09-plant-max-push-forward-days.sql",
        "2026-09-17-order-distribution.sql",
        "2026-09-18-sap-workcenter-allow-unconfigured.sql",
        "2026-09-25-routing-production-version-backfill.sql",
        "2026-09-24-routing-production-version-structure.sql",
        "2026-09-25-orders-run-time-bounds.sql",
        "2026-09-26-orders-run-time-bounds-validate.sql",
        "2026-10-01-order-distribution-plant-start-index.sql",
        "2026-10-06-sap-truth-firming.sql",
        "2026-10-08-sap-staging-columns.sql",
        "2026-10-08-sap-staging-tables.sql",
        "2026-10-15-1-orders-original-dates.sql",
        "2026-10-15-2-orders-run-time-bounds-336.sql",
        "2026-10-16-1-orders-placement-exception.sql",
        "2026-10-16-2-orders-original-finish-date-only.sql",
        "2026-10-16-3-plant-calendar-periods.sql",
        "2026-10-19-1-machine-workcenter-autolink.sql",
        "2026-10-20-0-orders-precutover-snapshot.sql",
        "2026-10-20-1-backward-cutover.sql",
    }
    all_names = {
        os.path.basename(path)
        for path in schema_bootstrap_smoke.glob.glob(
            os.path.join(schema_bootstrap_smoke.MIGRATIONS_DIR, "*.sql")
        )
    }
    applied_names = {os.path.basename(path) for path in applied}

    assert skipped_names == expected_skipped
    assert applied_names == expected_replayable
    assert all_names == expected_replayable | expected_skipped
    assert applied_names.isdisjoint(skipped_names)


def _stub_smoke_dependencies(monkeypatch):
    schema_db = "nimbus_bootstrap_test_schema_tmp"
    migrations_db = "nimbus_bootstrap_test_migrations_tmp"
    calls = []
    cleaned = []
    seeded = []
    orders_calls = []

    monkeypatch.setattr(
        schema_bootstrap_smoke,
        "_scratch_db_names",
        lambda: (schema_db, migrations_db),
    )
    def create_stub(_args, dbname):
        calls.append(("create", dbname))

    monkeypatch.setattr(schema_bootstrap_smoke, "_create_database", create_stub)
    monkeypatch.setattr(
        schema_bootstrap_smoke,
        "_drop_database_best_effort",
        lambda _args, dbname: cleaned.append(dbname),
    )
    monkeypatch.setattr(
        schema_bootstrap_smoke,
        "_seed_data_contract",
        lambda _args, dbname: seeded.append(dbname),
    )
    monkeypatch.setattr(
        schema_bootstrap_smoke,
        "_apply_file",
        lambda _args, dbname, path: calls.append(("apply", dbname, os.path.basename(path))),
    )

    def fake_orders(_args, dbname):
        orders_calls.append(dbname)
        return "orders"

    monkeypatch.setattr(schema_bootstrap_smoke, "_orders_columns", fake_orders)
    monkeypatch.setattr(sys, "argv", ["schema_bootstrap_smoke.py", "--host", "localhost"])
    return schema_db, migrations_db, calls, cleaned, seeded, orders_calls


def test_schema_bootstrap_smoke_replays_subset_twice_and_compares_bounded_contracts(monkeypatch, capsys):
    """The smoke entrypoint must exercise every baseline/replay contract call."""
    schema_db, migrations_db, calls, cleaned, seeded, orders_calls = _stub_smoke_dependencies(monkeypatch)
    structural_calls = []
    data_calls = []

    def fake_structural_fingerprint(_args, dbname):
        structural_calls.append(dbname)
        return "bounded-structural-fingerprint"

    def fake_data_fingerprint(_args, dbname):
        data_calls.append(dbname)
        return "bounded-data-contract"

    monkeypatch.setattr(schema_bootstrap_smoke, "_schema_fingerprint", fake_structural_fingerprint)
    monkeypatch.setattr(schema_bootstrap_smoke, "_data_fingerprint", fake_data_fingerprint)

    assert schema_bootstrap_smoke.main() == 0

    applied_names = [
        call[2]
        for call in calls
        if call[0] == "apply" and call[1] == migrations_db and call[2] != "schema.sql"
    ]
    assert [call[1] for call in calls if call[0] == "create"] == [schema_db, migrations_db]
    counts = {name: applied_names.count(name) for name in set(applied_names)}
    expected_names = {os.path.basename(path) for path in schema_bootstrap_smoke._migration_files()[0]}
    assert counts == {name: 2 for name in expected_names}
    assert seeded == [schema_db, migrations_db]
    assert orders_calls == [schema_db, migrations_db, migrations_db]
    assert structural_calls == [schema_db, migrations_db, migrations_db]
    assert data_calls == [schema_db, migrations_db, migrations_db]
    assert cleaned == [migrations_db, schema_db]

    output = capsys.readouterr().out.lower()
    assert "second replay" in output
    assert "bounded public-schema structural fingerprint" in output
    assert "bounded deterministic data/ledger contract" in output
    assert "not checked" in output


def test_schema_bootstrap_smoke_cleans_only_created_databases_after_failure(monkeypatch):
    """A failed bootstrap must still clean the database created by that run."""
    schema_db, _migrations_db, _calls, cleaned, _seeded, _orders_calls = _stub_smoke_dependencies(monkeypatch)

    def fail_during_schema_apply(_args, _dbname, _path):
        raise SystemExit("synthetic schema failure")

    monkeypatch.setattr(schema_bootstrap_smoke, "_apply_file", fail_during_schema_apply)

    with pytest.raises(SystemExit, match="synthetic schema failure"):
        schema_bootstrap_smoke.main()

    assert cleaned == [schema_db]


def test_schema_bootstrap_smoke_uses_unique_quoted_database_identifiers():
    first = schema_bootstrap_smoke._scratch_db_names()
    second = schema_bootstrap_smoke._scratch_db_names()

    assert first != second
    assert all(name.startswith(schema_bootstrap_smoke.SCRATCH_DB_PREFIX) for name in first + second)
    assert all(len(name) <= 63 for name in first + second)
    assert schema_bootstrap_smoke._quote_identifier('scratch"db') == '"scratch""db"'


@pytest.mark.parametrize(
    ("fingerprint_values", "expected_message"),
    [
        (("baseline", "changed-on-first-replay", "changed-on-second-replay"), "after first replay"),
        (("baseline", "baseline", "changed-on-second-replay"), "between replays"),
    ],
)
def test_schema_bootstrap_smoke_fails_when_structural_fingerprint_changes(
    monkeypatch, capsys, fingerprint_values, expected_message
):
    """Structural mismatches are enforced against both replay comparison points."""
    _stub_smoke_dependencies(monkeypatch)
    fingerprints = iter(fingerprint_values)
    monkeypatch.setattr(schema_bootstrap_smoke, "_schema_fingerprint", lambda _args, _dbname: next(fingerprints))
    monkeypatch.setattr(schema_bootstrap_smoke, "_data_fingerprint", lambda _args, _dbname: "same")

    assert schema_bootstrap_smoke.main() == 1

    error = capsys.readouterr().err.lower()
    assert f"bounded structural fingerprint {expected_message}" in error
    assert "not checked" in error


@pytest.mark.parametrize(
    ("data_values", "expected_message"),
    [
        (("baseline", "changed-on-first-replay", "changed-on-second-replay"), "after first replay"),
        (("baseline", "baseline", "changed-on-second-replay"), "between replays"),
    ],
)
def test_schema_bootstrap_smoke_fails_when_data_contract_changes(
    monkeypatch, capsys, data_values, expected_message
):
    """Data/ledger mismatches are enforced against both replay comparison points."""
    _stub_smoke_dependencies(monkeypatch)
    monkeypatch.setattr(schema_bootstrap_smoke, "_schema_fingerprint", lambda _args, _dbname: "same")
    data_contracts = iter(data_values)
    monkeypatch.setattr(schema_bootstrap_smoke, "_data_fingerprint", lambda _args, _dbname: next(data_contracts))

    assert schema_bootstrap_smoke.main() == 1

    error = capsys.readouterr().err.lower()
    assert f"bounded data/ledger contract {expected_message}" in error


@pytest.mark.parametrize(
    ("column_values", "expected_message"),
    [
        (("baseline", "changed-on-first-replay", "changed-on-second-replay"), "after first replay"),
        (("baseline", "baseline", "changed-on-second-replay"), "between replays"),
    ],
)
def test_schema_bootstrap_smoke_fails_when_orders_columns_change(
    monkeypatch, capsys, column_values, expected_message
):
    """The original orders-column contract remains protected at both points."""
    _stub_smoke_dependencies(monkeypatch)
    columns = iter(column_values)
    monkeypatch.setattr(schema_bootstrap_smoke, "_orders_columns", lambda _args, _dbname: next(columns))
    monkeypatch.setattr(schema_bootstrap_smoke, "_schema_fingerprint", lambda _args, _dbname: "same")
    monkeypatch.setattr(schema_bootstrap_smoke, "_data_fingerprint", lambda _args, _dbname: "same")

    assert schema_bootstrap_smoke.main() == 1

    error = capsys.readouterr().err.lower()
    assert f"orders columns {expected_message}" in error


@pytest.mark.parametrize("failure_stage", ["after_schema_creation", "after_migrations_creation", "during_first_replay"])
def test_schema_bootstrap_smoke_preserves_original_failure_when_cleanup_fails(monkeypatch, capsys, failure_stage):
    """Every created DB is attempted during cleanup without replacing the failure."""
    schema_db, migrations_db, calls, cleaned, _seeded, _orders_calls = _stub_smoke_dependencies(monkeypatch)
    expected_created = {
        "after_schema_creation": (schema_db,),
        "after_migrations_creation": (schema_db, migrations_db),
        "during_first_replay": (schema_db, migrations_db),
    }[failure_stage]
    first_migration = os.path.basename(schema_bootstrap_smoke._migration_files()[0][0])

    def fail_at_stage(_args, dbname, path):
        calls.append(("apply", dbname, os.path.basename(path)))
        basename = os.path.basename(path)
        if (
            failure_stage == "after_schema_creation"
            and dbname == schema_db
            and basename == "schema.sql"
        ) or (
            failure_stage == "after_migrations_creation"
            and dbname == migrations_db
            and basename == "schema.sql"
        ) or (
            failure_stage == "during_first_replay"
            and dbname == migrations_db
            and basename == first_migration
        ):
            raise SystemExit(f"synthetic {failure_stage} failure")

    monkeypatch.setattr(schema_bootstrap_smoke, "_apply_file", fail_at_stage)

    def fail_one_cleanup(_args, dbname):
        cleaned.append(dbname)
        if dbname == expected_created[-1]:
            raise RuntimeError("synthetic cleanup failure")

    monkeypatch.setattr(schema_bootstrap_smoke, "_drop_database_best_effort", fail_one_cleanup)

    with pytest.raises(SystemExit, match=f"synthetic {failure_stage} failure"):
        schema_bootstrap_smoke.main()

    assert cleaned == list(reversed(expected_created))
    assert "scratch database cleanup failed" in capsys.readouterr().err.lower()


def test_schema_bootstrap_smoke_fingerprint_is_bounded_public_catalog_structure():
    """The documented fingerprint covers stable public structure, not volatile rows."""
    fingerprint_sql = schema_bootstrap_smoke.SCHEMA_FINGERPRINT_SQL.lower()

    for fragment in (
        "information_schema.tables",
        "information_schema.columns",
        "pg_indexes",
        "pg_constraint",
        "pg_get_constraintdef",
        "table_schema = 'public'",
    ):
        assert fragment in fingerprint_sql


def test_setup_schema_has_versioned_plant_and_line_scoped_table_contracts():
    """Each setup table must retain its own scope, state, audit, and validation contract."""
    for path, text in _setup_schema_texts():
        definition = _table_block(text, "setup_definition")
        for required in (
            "plant             TEXT PRIMARY KEY",
            "fields            JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array')",
            "signature_version INTEGER NOT NULL CHECK (signature_version > 0)",
            "strict_blanks     BOOLEAN NOT NULL DEFAULT TRUE",
            "active            BOOLEAN NOT NULL DEFAULT FALSE",
            "created_by        TEXT",
            "created_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "updated_by        TEXT",
            "updated_at        TIMESTAMP NOT NULL DEFAULT NOW()",
        ):
            assert required in definition, f"{path}: setup_definition missing {required}"

        matrix = _table_block(text, "setup_matrix")
        for required in (
            "plant             TEXT NOT NULL",
            "machine           TEXT NOT NULL DEFAULT ''",
            "signature_version INTEGER NOT NULL CHECK (signature_version > 0)",
            "from_key          JSONB NOT NULL CHECK (jsonb_typeof(from_key) = 'array')",
            "to_key            JSONB NOT NULL CHECK (jsonb_typeof(to_key) = 'array')",
            "setup_min         INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080)",
            "source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'derived', 'actual'))",
            "source_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb",
            "created_by        TEXT",
            "created_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "updated_by        TEXT",
            "updated_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "PRIMARY KEY (plant, machine, signature_version, from_key, to_key)",
        ):
            assert required in matrix, f"{path}: setup_matrix missing {required}"

        line_state = _table_block(text, "machine_setup_state")
        for required in (
            "plant             TEXT NOT NULL",
            "machine           TEXT NOT NULL",
            "state_key         JSONB NOT NULL CHECK (jsonb_typeof(state_key) = 'array')",
            "signature_version INTEGER NOT NULL CHECK (signature_version > 0)",
            "physical_mold_id  TEXT",
            "observed_at       TIMESTAMP NOT NULL DEFAULT NOW()",
            "source            TEXT NOT NULL CHECK (source IN ('manual', 'derived', 'actual'))",
            "reason            TEXT",
            "created_by        TEXT",
            "created_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "updated_by        TEXT",
            "updated_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "PRIMARY KEY (plant, machine)",
        ):
            assert required in line_state, f"{path}: machine_setup_state missing {required}"

        occurrence = _table_block(text, "setup_occurrence_override")
        for required in (
            "id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
            "plant                TEXT NOT NULL",
            "machine              TEXT NOT NULL",
            "signature_version    INTEGER NOT NULL CHECK (signature_version > 0)",
            "predecessor_order_id TEXT",
            "successor_order_id   TEXT NOT NULL",
            "predecessor_state_key JSONB NOT NULL CHECK (jsonb_typeof(predecessor_state_key) = 'array')",
            "successor_state_key   JSONB NOT NULL CHECK (jsonb_typeof(successor_state_key) = 'array')",
            "standard_min         INTEGER NOT NULL CHECK (standard_min >= 0)",
            "remaining_min        INTEGER NOT NULL CHECK (remaining_min >= 0)",
            "status               TEXT NOT NULL DEFAULT 'active'",
            "CHECK (status IN ('active', 'inactive', 'cleared', 'replaced'))",
            "reason               TEXT",
            "created_by           TEXT",
            "created_at           TIMESTAMP NOT NULL DEFAULT NOW()",
            "updated_by           TEXT",
            "updated_at           TIMESTAMP NOT NULL DEFAULT NOW()",
        ):
            assert required in occurrence, f"{path}: setup_occurrence_override missing {required}"


def test_setup_schema_prevents_duplicate_active_occurrence_adjacencies():
    """Dropping the partial unique index would allow conflicting active overrides."""
    expected = (
        r"CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_occurrence_override_active_adjacency\s+"
        r"ON setup_occurrence_override \(\s*plant, machine, signature_version,\s+"
        r"predecessor_order_id,\s+successor_order_id,\s+predecessor_state_key,\s+successor_state_key\s*\)\s+"
        r"NULLS NOT DISTINCT\s+WHERE status = 'active'"
    )
    for path, text in _setup_schema_texts():
        assert re.search(expected, text, re.DOTALL), path


def test_setup_value_default_table_contract_matches_in_schema_and_migration():
    """The value-defaults table is additive and identical in schema.sql and its dated migration."""
    migration_path = os.path.join(ROOT, "migrations", "2026-10-27-1-setup-value-defaults.sql")
    with open(migration_path, encoding="utf-8") as handle:
        migration = handle.read()
    for path, text in ((SCHEMA_PATH, _schema_text()), (migration_path, migration)):
        block = _table_block(text, "setup_value_default")
        for required in (
            "plant             TEXT NOT NULL",
            "signature_version INTEGER NOT NULL CHECK (signature_version > 0)",
            "field_key         TEXT NOT NULL",
            "value             TEXT NOT NULL",
            "setup_min         INTEGER NOT NULL CHECK (setup_min BETWEEN 0 AND 10080)",
            "created_by        TEXT",
            "created_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "updated_by        TEXT",
            "updated_at        TIMESTAMP NOT NULL DEFAULT NOW()",
            "PRIMARY KEY (plant, signature_version, field_key, value)",
        ):
            assert required in block, f"{path}: setup_value_default missing {required}"


def test_setup_value_default_migration_is_additive_and_clears_the_destructive_regex():
    """The deploy runner scans comments too, so the file must avoid every destructive word."""
    migration_path = os.path.join(ROOT, "migrations", "2026-10-27-1-setup-value-defaults.sql")
    with open(migration_path, encoding="utf-8") as handle:
        migration = handle.read()
    assert re.search(r"(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)", migration, re.IGNORECASE) is None
    assert "CREATE TABLE IF NOT EXISTS setup_value_default" in migration


def test_setup_schema_enforces_matrix_bound_and_unbounded_override_minutes():
    """Only standards use the seven-day cap; physical remaining work stays nonnegative but unbounded."""
    for path, text in _setup_schema_texts():
        assert "CHECK (setup_min BETWEEN 0 AND 10080)" in text, path
        assert "CHECK (standard_min >= 0)" in text, path
        assert "CHECK (remaining_min >= 0)" in text, path
        assert "CHECK (source IN ('manual', 'derived', 'actual'))" in text, path
        assert "CHECK (status IN ('active', 'inactive', 'cleared', 'replaced'))" in text, path


def test_setup_schema_keeps_compatibility_separate_from_global_optimizer_exclusion():
    """An incompatible line must opt out with a reason without mutating excl_optimizer."""
    expected = (
        r"ALTER TABLE machine ADD COLUMN IF NOT EXISTS setup_compatible "
        r"BOOLEAN NOT NULL DEFAULT TRUE;\s*"
        r"ALTER TABLE machine ADD COLUMN IF NOT EXISTS setup_compatibility_reason TEXT;"
    )
    for path, text in _setup_schema_texts():
        assert re.search(expected, text), path


@pytest.mark.pg
class TestHorizonMigrationIdempotent:
    SUB, PLANT = "ZZTESTSUB", "ZZTESTP"
    ALT, CONF = 300, 200  # sub-365 MINUTE values that the old landmine would ×1440

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        db = pg
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (self.SUB, "Horizon migration test"),
            )
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUB, self.PLANT))
            cur.execute(
                "INSERT INTO plants (subnetwork, plant, alt_flag_horizon, conf_score_horizon) "
                "VALUES (%s,%s,%s,%s)",
                (self.SUB, self.PLANT, self.ALT, self.CONF),
            )
            conn.commit()
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM plants WHERE subnetwork = %s AND plant = %s", (self.SUB, self.PLANT))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def test_reapplying_schema_does_not_remultiply(self, pg):
        db = pg
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        # Re-apply the full (idempotent) schema, exactly like a redeploy would (rolled back, see _rolled_back).
        with _rolled_back(db) as cur:
            cur.execute(schema_sql)
            cur.execute(
                "SELECT alt_flag_horizon, conf_score_horizon FROM plants "
                "WHERE subnetwork = %s AND plant = %s",
                (self.SUB, self.PLANT),
            )
            alt, conf = cur.fetchone()
        assert alt == self.ALT, f"sub-365 alt_flag_horizon was mutated on re-apply ({self.ALT} -> {alt})"
        assert conf == self.CONF, f"sub-365 conf_score_horizon was mutated on re-apply ({self.CONF} -> {conf})"

    def test_ledger_records_horizon_migration(self, pg):
        db = pg
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        with _rolled_back(db) as cur:
            cur.execute(schema_sql)
            cur.execute("SELECT 1 FROM schema_migrations WHERE id = 'plants_horizon_minutes'")
            assert cur.fetchone() is not None


SAP_TRUTH_COLUMN_STATEMENTS = (
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_firmed BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_workcenter TEXT;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_production_version TEXT;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_start_date TIMESTAMP;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS sap_basic_finish_date TIMESTAMP;",
)


def test_sap_truth_columns_in_schema_and_migration():
    """SAP-is-truth firming: five additive orders columns must exist in both
    schema.sql and the dated migration deploys actually apply."""
    migration_path = os.path.join(ROOT, "migrations", "2026-10-06-sap-truth-firming.sql")
    with open(migration_path, encoding="utf-8") as f:
        migration_text = f.read()
    schema_text = _schema_text()
    for stmt in SAP_TRUTH_COLUMN_STATEMENTS:
        assert stmt in schema_text, stmt
        assert stmt in migration_text, stmt


SAP_STAGE_TABLES = (
    "sap_stage_batch",
    "sap_stage_material_plant",
    "sap_stage_planned_order",
    "sap_stage_production_version",
    "sap_stage_routing_operation",
    "sap_stage_planned_order_out",
    "sap_stage_vanished_order",
    "order_sap_sent",
)

SAP_STAGE_COLUMN_STATEMENTS = (
    "ALTER TABLE sap_sync_config ADD COLUMN IF NOT EXISTS apply_mode TEXT NOT NULL DEFAULT 'manual';",
    "ALTER TABLE material_plants ADD COLUMN IF NOT EXISTS sap_missing_since TIMESTAMPTZ;",
    "ALTER TABLE production_version ADD COLUMN IF NOT EXISTS sap_missing_since TIMESTAMPTZ;",
)


def test_sap_staging_tables_in_schema_and_migration():
    """SAP staging: the seven sap_stage_* tables, the order_sap_sent side table (D20, kept
    off `orders` so a Send never bumps xmin) and the three additive columns must exist in
    both schema.sql and the dated migrations deploys actually apply."""
    tables_path = os.path.join(ROOT, "migrations", "2026-10-08-sap-staging-tables.sql")
    columns_path = os.path.join(ROOT, "migrations", "2026-10-08-sap-staging-columns.sql")
    with open(tables_path, encoding="utf-8") as f:
        tables_text = f.read()
    with open(columns_path, encoding="utf-8") as f:
        columns_text = f.read()
    schema_text = _schema_text()
    for table in SAP_STAGE_TABLES:
        stmt = f"CREATE TABLE IF NOT EXISTS {table} ("
        assert stmt in schema_text, stmt
        assert stmt in tables_text, stmt
    for stmt in SAP_STAGE_COLUMN_STATEMENTS:
        assert stmt in schema_text, stmt
        assert stmt in columns_text, stmt
    # The remembered-send values are NOT orders columns any more.
    assert "orders ADD COLUMN IF NOT EXISTS sap_sent_" not in schema_text
    assert "orders ADD COLUMN IF NOT EXISTS sap_sent_" not in columns_text


# --- Structural parity of the two SAP staging migrations (applied) -----------------------------------------
STAGE_MIGRATIONS = ("2026-10-08-sap-staging-tables.sql", "2026-10-08-sap-staging-columns.sql")
STAGE_COLUMNS = (("sap_sync_config", "apply_mode"), ("material_plants", "sap_missing_since"),
                 ("production_version", "sap_missing_since"))
STAGE_INDEXES = (
    "idx_sap_stage_batch_lookup", "idx_sap_stage_material_plant_batch", "idx_sap_stage_planned_order_batch",
    "idx_sap_stage_production_version_batch", "idx_sap_stage_routing_operation_batch",
    "idx_sap_stage_planned_order_out_status", "idx_sap_stage_planned_order_out_send_batch",
    "idx_sap_stage_planned_order_out_plant_status", "idx_sap_stage_vanished_order_plant_deleted",
    "idx_order_sap_sent_plant",
)


def _schema_fingerprint(cur) -> dict:
    """Tables + columns (type, nullability, default) + constraints + indexes of the public schema."""
    cur.execute("SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length"
                " FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, ordinal_position")
    columns = [tuple(r) for r in cur.fetchall()]
    cur.execute("SELECT c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid) FROM pg_constraint c"
                " JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' ORDER BY 1, 2")
    constraints = [tuple(r) for r in cur.fetchall()]
    cur.execute("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2")
    indexes = [tuple(r) for r in cur.fetchall()]
    return {"columns": columns, "constraints": constraints, "indexes": indexes}


@pytest.mark.pg
def test_sap_staging_migrations_are_idempotent_and_create_every_object(pg):
    """Re-applying the two staging migrations changes nothing structurally (fingerprint before == after) and every
    table, column, index and the apply_mode CHECK the design names exists afterwards."""
    sqls = []
    for name in STAGE_MIGRATIONS:
        with open(os.path.join(ROOT, "migrations", name), encoding="utf-8") as f:
            sqls.append(f.read())
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for sql_text in sqls:                       # first apply (a no-op where schema.sql already built them)
            cur.execute(sql_text)
        conn.commit()
        before = _schema_fingerprint(cur)
        for sql_text in sqls:                       # second apply: must be a structural no-op
            cur.execute(sql_text)
        conn.commit()
        after = _schema_fingerprint(cur)
        assert after == before, "re-applying the staging migrations changed the schema"

        tables = {r[0] for r in before["columns"]}
        for table in SAP_STAGE_TABLES:
            assert table in tables, f"{table} missing after the migrations"
        have_cols = {(r[0], r[1]) for r in before["columns"]}
        for tc in STAGE_COLUMNS:
            assert tc in have_cols, f"{tc} missing after the migrations"
        have_idx = {r[1] for r in before["indexes"]}
        for idx in STAGE_INDEXES:
            assert idx in have_idx, f"{idx} missing after the migrations"
        assert any(r[1] == "chk_sap_sync_config_apply_mode" for r in before["constraints"])


# --- Locked original SAP dates (backward-scheduling Phase 1, Task 1.1) ---------------------------------------
ORIGINAL_DATES_MIGRATION = "2026-10-15-1-orders-original-dates.sql"
ORIGINAL_DATES_COLUMN_STATEMENTS = (
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_start_received  TIMESTAMP;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;",
    "ALTER TABLE order_distribution ADD COLUMN IF NOT EXISTS original_finish_received TIMESTAMP;",
)


def test_original_dates_columns_and_ledger_in_schema_and_migration():
    """The locked SAP start/finish columns and the ledger-guarded backfill live in BOTH schema.sql (safe to
    re-apply) and the dated migration deploys actually apply; the migration says it is destructive by text."""
    with open(os.path.join(ROOT, "migrations", ORIGINAL_DATES_MIGRATION), encoding="utf-8") as f:
        migration_text = f.read()
    schema_text = _schema_text()
    for stmt in ORIGINAL_DATES_COLUMN_STATEMENTS:
        assert stmt in schema_text, stmt
        assert stmt in migration_text, stmt
    for text in (schema_text, migration_text):
        assert "WHERE id = 'orders_original_dates_backfill'" in text
        assert "VALUES ('orders_original_dates_backfill')" in text
    assert "Destructive by text" in migration_text
    # The backfill reads order_sap_sent, so schema.sql must create it first.
    assert schema_text.index("CREATE TABLE IF NOT EXISTS order_sap_sent (") < schema_text.index(
        "VALUES ('orders_original_dates_backfill')"
    )


@pytest.mark.pg
def test_original_dates_schema_applies_twice_and_ledger_has_one_row(pg):
    """Apply schema.sql twice: the three columns exist and the backfill ledger id is recorded exactly once."""
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()
    with _rolled_back(pg) as cur:
        cur.execute(schema_sql)
        cur.execute(schema_sql)
        cur.execute(
            "SELECT table_name, column_name FROM information_schema.columns"
            " WHERE table_schema = 'public' AND column_name IN ('original_start_received', 'original_finish_received')"
        )
        have = {tuple(r) for r in cur.fetchall()}
        assert have == {
            ("orders", "original_start_received"),
            ("orders", "original_finish_received"),
            ("order_distribution", "original_finish_received"),
        }
        cur.execute("SELECT count(*) FROM schema_migrations WHERE id = 'orders_original_dates_backfill'")
        assert cur.fetchone()[0] == 1


# --- Run-time cap (backward-scheduling Task 1.6): the CHECK becomes a representation bound ------------------
RUN_TIME_BOUNDS_MIGRATION = "2026-10-15-2-orders-run-time-bounds-336.sql"


def test_run_time_bounds_8760_in_schema_and_migration_say_destructive_and_use_the_ledger():
    with open(os.path.join(ROOT, "migrations", RUN_TIME_BOUNDS_MIGRATION), encoding="utf-8") as f:
        migration_text = f.read()
    schema_text = _schema_text()
    assert "Destructive by text" in migration_text
    for text in (schema_text, migration_text):
        assert "DROP CONSTRAINT IF EXISTS chk_orders_run_time_bounds" in text
        assert "run_time >= 0 AND run_time < 8760" in text
        assert "orders_run_time_bounds_8760" in text
    # schema.sql must not keep creating the old 168-hour bound under the same name.
    assert "run_time < 168" not in schema_text


@pytest.mark.pg
def test_run_time_bounds_schema_reapply_raises_an_old_bound_exactly_once(pg):
    """An initialised database carries the old < 168 constraint under the same name: re-applying
    schema.sql (ledger row absent) must drop and re-add it at 8760, then leave it alone."""
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()
    with _rolled_back(pg) as cur:
        cur.execute("DELETE FROM schema_migrations WHERE id = 'orders_run_time_bounds_8760'")
        cur.execute("ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_run_time_bounds")
        cur.execute("ALTER TABLE orders ADD CONSTRAINT chk_orders_run_time_bounds"
                    " CHECK (run_time IS NULL OR (run_time >= 0 AND run_time < 168))")
        cur.execute(schema_sql)
        cur.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_orders_run_time_bounds'")
        assert "8760" in cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM schema_migrations WHERE id = 'orders_run_time_bounds_8760'")
        assert cur.fetchone()[0] == 1
        # Second apply: the ledger row stops it; the bound is unchanged.
        cur.execute(schema_sql)
        cur.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_orders_run_time_bounds'")
        assert "8760" in cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM schema_migrations WHERE id = 'orders_run_time_bounds_8760'")
        assert cur.fetchone()[0] == 1


# --- Placement-exception marker (backward-scheduling Task 2.3) ---------------------------------------------
PLACEMENT_EXCEPTION_MIGRATION = "2026-10-16-1-orders-placement-exception.sql"


def test_placement_exception_column_in_schema_and_migration_say_destructive():
    with open(os.path.join(ROOT, "migrations", PLACEMENT_EXCEPTION_MIGRATION), encoding="utf-8") as f:
        migration_text = f.read()
    schema_text = _schema_text()
    assert "Destructive by text" in migration_text
    for text in (schema_text, migration_text):
        assert "ADD COLUMN IF NOT EXISTS placement_exception TEXT NULL" in text
        assert "CHECK (placement_exception IN ('overtime', 'overlong'))" in text


@pytest.mark.pg
def test_placement_exception_migration_and_schema_apply_twice_and_check_holds(pg):
    """Replay the migration and schema.sql twice: one column, one CHECK, bad values refused, NULL allowed."""
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()
    with open(os.path.join(ROOT, "migrations", PLACEMENT_EXCEPTION_MIGRATION), encoding="utf-8") as f:
        migration_sql = f.read()
    with _rolled_back(pg) as cur:
        cur.execute(migration_sql)
        cur.execute(migration_sql)
        cur.execute(schema_sql)
        cur.execute(schema_sql)
        cur.execute("SELECT count(*) FROM information_schema.columns"
                    " WHERE table_name = 'orders' AND column_name = 'placement_exception'")
        assert cur.fetchone()[0] == 1
        cur.execute("SELECT count(*) FROM pg_constraint WHERE conname = 'chk_orders_placement_exception'")
        assert cur.fetchone()[0] == 1
        cur.execute("SAVEPOINT bad")
        with pytest.raises(Exception):
            cur.execute("INSERT INTO orders (id, production_order, material_number, placement_exception)"
                        " VALUES ('pe-bad', 'pe-bad', 'm', 'sideways')")
        cur.execute("ROLLBACK TO SAVEPOINT bad")


@pytest.mark.pg
def test_schema_reapply_has_no_data_effect_without_the_cutover_ledger_rows(pg):
    """I14: re-applying schema.sql on a database that has NOT recorded the cutover ledger ids must leave order
    placements and segments exactly as they were once the (rolled-back) transaction ends. Seeds a placed,
    flagged order and a segment, deletes the ledger ids, applies, and checks the data only inside the
    transaction; then confirms from a second connection that nothing survived."""
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema_sql = f.read()
    with _rolled_back(pg) as cur:
        cur.execute("DELETE FROM schema_migrations WHERE id IN ('backward_cutover_snapshot', 'backward_scheduling_cutover')")
        for t in ("orders_precutover_snapshot", "order_schedule_segments_precutover_snapshot",
                  "order_sap_sent_precutover_snapshot"):
            cur.execute(f"DROP TABLE IF EXISTS {t}")  # in-transaction: the snapshot block recreates them
        cur.execute("INSERT INTO orders (id, production_order, material_number, planning_status, "
                    "scheduled_start, scheduled_end) VALUES ('zzi14', 'zzi14', 'm', 'scheduled', "
                    "'2031-01-01 08:00', '2031-01-01 12:00')")
        cur.execute(schema_sql)
        cur.execute("SELECT scheduled_start FROM orders WHERE id = 'zzi14'")
        assert cur.fetchone()[0] is None  # proves the guard is what protects the data outside the transaction
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM orders WHERE id = 'zzi14'")
        assert cur.fetchone()[0] == 0
        conn.rollback()


# --- schedule_event (per-order change history) -----------------------------------------------------------
SCHEDULE_EVENT_MIGRATION = "2026-10-23-1-schedule-event.sql"
SCHEDULE_EVENT_STATEMENTS = (
    "CREATE TABLE IF NOT EXISTS schedule_event (",
    "CREATE INDEX IF NOT EXISTS idx_schedule_event_order ON schedule_event (plant, order_id, id DESC);",
    "CREATE INDEX IF NOT EXISTS idx_schedule_event_at    ON schedule_event (at);",
)
DEPLOY_DESTRUCTIVE_RE = re.compile(r"(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)", re.IGNORECASE)


def _schedule_event_migration_text() -> str:
    with open(os.path.join(ROOT, "migrations", SCHEDULE_EVENT_MIGRATION), encoding="utf-8") as f:
        return f.read()


def test_schedule_event_ddl_in_schema_and_migration():
    """Both deployment paths carry the identical table and index statements verbatim."""
    schema_text, migration_text = _schema_text(), _schedule_event_migration_text()
    for stmt in SCHEDULE_EVENT_STATEMENTS:
        assert stmt in schema_text, stmt
        assert stmt in migration_text, stmt
    assert "CHECK (op IN ('create','modify','remove'))" in schema_text
    assert "at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()" in migration_text
    assert "autovacuum_vacuum_scale_factor = 0.02" in migration_text


def test_schedule_event_migration_has_no_deploy_destructive_words():
    """The deploy runner scans the whole file (comments included) for these words and demands -AllowDestructive."""
    match = DEPLOY_DESTRUCTIVE_RE.search(_schedule_event_migration_text())
    assert match is None, f"destructive word in migration: {match.group(0)!r}"


@pytest.mark.pg
def test_schedule_event_migration_is_idempotent_and_creates_every_object(pg):
    sql_text = _schedule_event_migration_text()
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(sql_text)                       # first apply (a no-op where schema.sql / boot hook built it)
        conn.commit()
        before = _schema_fingerprint(cur)
        cur.execute(sql_text)                       # second apply: must be a structural no-op
        conn.commit()
        after = _schema_fingerprint(cur)
        assert after == before, "re-applying the schedule_event migration changed the schema"
        have_cols = {r[1] for r in before["columns"] if r[0] == "schedule_event"}
        assert {"id", "plant", "order_id", "production_order", "material_number", "action_id", "source", "actor",
                "client_id", "op", "changes", "at"} <= have_cols
        have_idx = {r[1] for r in before["indexes"] if r[0] == "schedule_event"}
        assert {"idx_schedule_event_order", "idx_schedule_event_at"} <= have_idx
        assert any(r[0] == "schedule_event" and "create" in r[2] and "modify" in r[2] and "remove" in r[2]
                   for r in before["constraints"])



# --- tool_inventory (per-plant PRT copy counts) ------------------------------------------------------
TOOL_INVENTORY_MIGRATION = "2026-10-27-1-tool-inventory.sql"
# Word-bounded, like the deploy runner's own regex (apply-migrations.ps1 $DESTRUCTIVE); the older
# substring regex above would wrongly flag the harmless column name `updated_at`.
DEPLOY_DESTRUCTIVE_WORD_RE = re.compile(r"\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b", re.IGNORECASE)
TOOL_INVENTORY_BLOCK = (
    "CREATE TABLE IF NOT EXISTS tool_inventory (",
    "    plant              TEXT NOT NULL,",
    "    tool_id            TEXT NOT NULL,",
    "    total_qty          INTEGER NOT NULL DEFAULT 1,",
    "    out_of_service_qty INTEGER NOT NULL DEFAULT 0,",
    "    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    PRIMARY KEY (plant, tool_id),",
    "    CONSTRAINT chk_tool_inventory_total CHECK (total_qty >= 0),",
    "    CONSTRAINT chk_tool_inventory_qty   CHECK (out_of_service_qty >= 0 AND out_of_service_qty <= total_qty),",
    "    CONSTRAINT chk_tool_inventory_id    CHECK (tool_id = upper(btrim(tool_id)) AND tool_id <> '')",
    "    ('tool_inventory', 'plant',              'Plant',           TRUE,  1),",
    "    ('tool_inventory', 'tool_id',            'Tool ID',         TRUE,  2),",
    "    ('tool_inventory', 'total_qty',          'Total Inventory', FALSE, 3),",
    "    ('tool_inventory', 'out_of_service_qty', 'Out of Service',  FALSE, 4),",
    "    ('tool_inventory', 'note',               'Note',            FALSE, 5)",
)


def _tool_inventory_migration_text() -> str:
    with open(os.path.join(ROOT, "migrations", TOOL_INVENTORY_MIGRATION), encoding="utf-8") as f:
        return f.read()


def test_tool_inventory_ddl_in_schema_and_migration():
    """schema.sql, the migration and the boot hook carry the identical table, named constraints and seed."""
    schema_text, migration_text = _schema_text(), _tool_inventory_migration_text()
    with open(os.path.join(ROOT, "master_data.py"), encoding="utf-8") as f:
        hook_text = f.read()
    for line in TOOL_INVENTORY_BLOCK:
        assert line in schema_text, line
        assert line in migration_text, line
    for line in TOOL_INVENTORY_BLOCK[1:]:
        assert line.strip() in hook_text or line.lstrip() in hook_text, line  # whitespace-insensitive for the hook
    assert "ON CONFLICT (table_name, column_name) DO NOTHING" in migration_text
    assert "REFERENCES" not in migration_text  # no plant FK on purpose


def test_tool_inventory_migration_has_no_deploy_destructive_words():
    """The deploy runner scans the whole file (comments included); `updated_at` must NOT trip it."""
    text = _tool_inventory_migration_text()
    assert "updated_at" in text
    match = DEPLOY_DESTRUCTIVE_WORD_RE.search(text)
    assert match is None, f"destructive word in migration: {match.group(0)!r}"
