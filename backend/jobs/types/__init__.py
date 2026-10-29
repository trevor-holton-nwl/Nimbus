"""Importing this package registers every job type."""
from backend.jobs.types import noop, optimizer, backlog, reports, purge, order_steps, sap_steps, chain  # noqa: F401
