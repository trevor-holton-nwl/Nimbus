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
    """Both deployment paths must provide identical setup persistence guards."""
    paths = (SCHEMA_PATH, SETUP_MIGRATION_PATH)
    return [(path, open(path, encoding="utf-8").read()) for path in paths]


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


def test_setup_schema_has_versioned_plant_and_line_scoped_keys():
    """Breaking any setup identity key would permit cross-scope/version data collisions."""
    for path, text in _setup_schema_texts():
        assert re.search(
            r"CREATE TABLE IF NOT EXISTS setup_definition \(.*plant\s+TEXT\s+PRIMARY KEY", text, re.DOTALL
        ), path
        assert re.search(
            r"CREATE TABLE IF NOT EXISTS setup_matrix \(.*PRIMARY KEY \(plant, line, signature_version, from_key, to_key\)",
            text,
            re.DOTALL,
        ), path
        assert re.search(
            r"CREATE TABLE IF NOT EXISTS line_setup_state \(.*PRIMARY KEY \(plant, line\)", text, re.DOTALL
        ), path


def test_setup_schema_prevents_duplicate_active_occurrence_adjacencies():
    """Dropping the partial unique index would allow conflicting active overrides."""
    expected = (
        r"CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_occurrence_override_active_adjacency\s+"
        r"ON setup_occurrence_override \(\s*plant, line, signature_version,\s+"
        r"predecessor_order_id,\s+successor_order_id,\s+predecessor_state_key,\s+successor_state_key\s*\)\s+"
        r"WHERE status = 'active'"
    )
    for path, text in _setup_schema_texts():
        assert re.search(expected, text, re.DOTALL), path


def test_setup_schema_enforces_bounded_minutes_and_controlled_values():
    """Invalid setup duration, source, or override status must be rejected at the DB boundary."""
    for path, text in _setup_schema_texts():
        assert "CHECK (setup_min BETWEEN 0 AND 10080)" in text, path
        assert "CHECK (standard_min BETWEEN 0 AND 10080)" in text, path
        assert "CHECK (remaining_min BETWEEN 0 AND 10080)" in text, path
        assert "CHECK (source IN ('manual', 'derived', 'actual'))" in text, path
        assert "CHECK (status IN ('active', 'inactive', 'cleared', 'replaced'))" in text, path


def test_setup_schema_keeps_compatibility_separate_from_global_optimizer_exclusion():
    """An incompatible line must opt out with a reason without mutating excl_optimizer."""
    expected = (
        r"ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatible "
        r"BOOLEAN NOT NULL DEFAULT TRUE;\s*"
        r"ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS setup_compatibility_reason TEXT;"
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
