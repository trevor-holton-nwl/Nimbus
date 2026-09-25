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
import os
import re
import sys

import pytest

from scripts import schema_bootstrap_smoke

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(ROOT, "schema.sql")
SETUP_MIGRATION_PATH = os.path.join(ROOT, "migrations", "2026-08-13-changeover-matrix-stage-0.sql")


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
    (migrations/2026-08-20-line-to-machine.sql), not by keeping this dated file
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
        "2026-07-03-production-line-optimizer-flags.sql",
        "2026-08-10-material-plant-default-workcenter.sql",
        "2026-08-11-priority-lists.sql",
        "2026-08-13-changeover-matrix-stage-0.sql",
        "2026-08-17-line-key-columns.sql",
        "2026-08-20-line-to-machine.sql",
        "2026-08-20-setup-value-case-fold-backfill.sql",
    }

    expected_replayable = {
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
        "2026-09-24-routing-production-version-backfill.sql",
        "2026-09-24-routing-production-version-structure.sql",
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
            cur.execute("INSERT INTO subnetworks (code) VALUES (%s) ON CONFLICT DO NOTHING", (self.SUB,))
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
        # Re-apply the full (idempotent) schema, exactly like a redeploy would.
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(schema_sql)
            conn.commit()
        with db._pool.connection() as conn, conn.cursor() as cur:
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
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(schema_sql)
            conn.commit()
            cur.execute("SELECT 1 FROM schema_migrations WHERE id = 'plants_horizon_minutes'")
            assert cur.fetchone() is not None
