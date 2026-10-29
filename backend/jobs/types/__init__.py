"""Importing this package registers every job type."""
from backend.jobs.types import noop, optimizer, reports, purge, chain  # noqa: F401
