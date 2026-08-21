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

import pytest

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
