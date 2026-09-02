"""
NIMBUS 2.0 — DIAGNOSTICS load-metadata bag.

Not one of the plan's two named accessor modules (docs/architecture/
domain-refactor-plan.md §4 calls out only the PLANT_LISTS cache and the
_BACKEND_LOG ring buffer) — this is a P5 addition, called out explicitly in
the phase report because it wasn't anticipated by the brief. DIAGNOSTICS is
mutated/read from brain.py's lifespan, from backend/admin_ops/routes.py
(GET /diagnostics, /health, /diagnostics/deep, POST /reload), from
backend/scheduling/routes.py (GET /tasks builds its `meta` from it), and from
backend/priority_lists/cache.py's apply_priority_merge (via _warn on a merge
failure) — four call sites across three domains plus brain.py itself, so it
needed the same "narrow module, no brain.py owner" treatment as the other two.

DIAGNOSTICS is never reassigned wholesale by any function in this codebase —
only mutated via `DIAGNOSTICS["key"] = value` / `.get(...)` / `dict(DIAGNOSTICS)`
— so, like the log ring buffer, importing modules can bind the name directly
with no staleness hazard and no `global` statement is needed anywhere.
"""
import pandas as pd

from backend.admin_ops.logbuffer import _log_event

# Global diagnostics bucket populated on every load.
DIAGNOSTICS: dict = {
    "loaded_at": None,
    "load_ms": None,
    "source_file": None,
    "raw_row_count": 0,
    "dropped_no_start_date": 0,
    "dropped_no_finish_date_filled": 0,
    "duplicate_ids_suffixed": 0,
    "color_merge_misses": 0,
    "color_merge_ms": None,
    "missed_colors": [],
    "emitted_task_count": 0,
    "unique_id_count": 0,
    "lines": {},
    "warnings": []
}


def _warn(level, msg, **ctx):
    DIAGNOSTICS["warnings"].append({
        "level": level, "msg": msg, "ctx": ctx,
        "ts": pd.Timestamp.utcnow().isoformat(),
    })
    _log_event(level, "load", msg, **ctx)
