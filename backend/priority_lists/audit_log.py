"""
NIMBUS 2.0 — color-wheel / priority-list append-only audit trail (JSONL file).

Not one of the plan's two named accessor modules — a second P5 addition (see
backend/admin_ops/diagnostics_state.py for the other). COLOR_WHEEL_DIR/_audit_log.json
is CLAUDE.md's "shared append-only log of all color-wheel + optimization events":
written by backend/priority_lists/routes.py (every priority-list/color-wheel
upload+delete), read/written/cleared by backend/master_data/routes.py's
GET/POST /audit/log endpoints, and migrated-on-disk-format once at startup by
brain.py's lifespan. Three domains + brain.py itself needed a shared, brain.py-free
home for it, so it gets the same narrow-module treatment as PLANT_LISTS and
_BACKEND_LOG.

COLOR_WHEEL_DIR is read once at import time and never reassigned, so importing
modules can bind it directly with no staleness hazard.
"""
import json
import os

# Per-plant color wheels are uploaded through the Plant tab UI and stored here.
#
# ► IF YOU MOVE THIS APP TO A NEW MACHINE, change COLOR_WHEEL_DIR below to any
#   folder you have read/write access to. The folder is created automatically
#   on startup if it does not already exist. Nothing else needs to change.
#
# File layout inside COLOR_WHEEL_DIR:
#   color_wheel_<PLANT>.xlsx   — one file per plant (plant code sanitized to [A-Z0-9_])
#   _meta.json                 — upload metadata per plant (filename, row count, timestamp, user)
#   _audit_log.json            — append-only log of all color-wheel + optimization events
COLOR_WHEEL_DIR = os.getenv("COLOR_WHEEL_DIR", r"C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\color_wheels")


# The audit log stays file-based for now: COLOR_WHEEL_DIR/_audit_log.json is a
# shared append-only log of color-wheel AND optimization events (see the
# /audit/log endpoints). Wheel DATA + metadata now live in the color_wheel
# Postgres table; only this audit trail remains on disk. Its durability is a
# separately-tracked follow-up (see MIGRATION.md).
def _cw_audit_path() -> str:
    return os.path.join(COLOR_WHEEL_DIR, "_audit_log.json")


def _migrate_audit_log() -> None:
    """Convert a legacy JSON-array audit file to JSON-Lines (idempotent, runs at startup)."""
    path = _cw_audit_path()
    try:
        with open(path, encoding='utf-8') as f:
            content = f.read()
        if content.strip().startswith('['):
            old = json.loads(content)
            with open(path, 'w', encoding='utf-8') as f:
                for e in old:
                    f.write(json.dumps(e) + '\n')
    except (FileNotFoundError, json.JSONDecodeError):
        pass


def _cw_append_audit(entry: dict) -> None:
    with open(_cw_audit_path(), 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')
