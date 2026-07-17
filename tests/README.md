# NIMBUS backend tests

The pytest suite covers backend contracts, schema regressions, in-memory log
behavior, and PostgreSQL-backed workflows. Tests that need a database are marked
`@pytest.mark.pg`; `tests/conftest.py` skips them automatically when Postgres is
unreachable.

## Run locally

From the project root, with the app dependencies and pytest installed:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

To run only the tests that do not require Postgres:

```powershell
.\.venv\Scripts\python.exe -m pytest -m "not pg"
```

To exercise the full suite, start Postgres, configure the `PG_*` values in
`.env`, and apply `schema.sql` to the test database before running pytest.
Database tests create and remove `ZZTEST_*` records, but use a dedicated local
database rather than a shared environment whenever possible.

## Coverage

| Area | Test files | Database required |
|---|---|:---:|
| Stable order IDs and Excel-value normalization | `test_make_id.py` | No |
| Datetime parsing and local-time persistence contract | `test_to_pydt.py` | No |
| PostgreSQL error translation | `test_translate_db_error.py` | No |
| Backend log-event schema and log-buffer endpoints | `test_log_event.py`, `test_logs_endpoints.py` | No |
| `schema.sql` static checks and re-application idempotency | `test_schema_idempotent.py` | Mixed |
| Durable per-plant color-wheel serialization and CRUD | `test_color_wheel_store.py` | Mixed |
| Cross-plant attribution, cascade preview, and bulk-update contracts | `test_data_integrity.py` | Yes |
| User-name validation and `user_security` persistence | `test_user_names.py` | Mixed |
| Self-service password changes | `test_change_password.py` | Yes |

Some no-database tests import `brain.py`. They may skip cleanly if the app cannot
be imported in the local environment; CI supplies temporary color-wheel paths so
those imports are deterministic.

## CI

GitHub Actions runs the complete Python suite against PostgreSQL 16. The workflow
installs application dependencies plus pytest, bootstraps `schema.sql`, then runs
`pytest -ra`. JavaScript linting and Node tests run in a separate CI job.
