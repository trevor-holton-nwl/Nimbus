"""Dump brain.py's live FastAPI OpenAPI schema to stdout as JSON.

Feeds `npm run generate:api-types` (see package.json), which pipes this into
`openapi-typescript` to produce frontend/types/api-generated.d.mts.

Sets NIMBUS_PG_POOL_MIN=0 BEFORE importing brain/db — the same guard
tests/conftest.py uses — so this runs on a machine with no Postgres running.
api.openapi() is pure route/Pydantic-model introspection and never touches the
database, but `import db` (transitively, via `import brain`) unconditionally
opens a connection pool at module load (psycopg_pool.ConnectionPool(...,
open=True)) unless min_size=0.
"""
import json
import os
import sys

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import brain  # noqa: E402

json.dump(brain.api.openapi(), sys.stdout)
