"""Job templates: the built-in ones and the step diff behind "template changed, update?". PURE (stdlib only).

A template is an ordered step list plus optional defaults. A job made from a template stores a COPY of the steps (in its
own params) and the template's id and version; it never reads the template again until an admin presses Update. So an
edit to a template changes nothing silently, and a run always uses the steps its job held when it started.
"""
from __future__ import annotations

# Built-in templates (seeded once by `key` at startup; an admin can edit or archive them like any other).
BUILTIN_TEMPLATES: list[dict] = [
    {"key": "purge_then_reoptimize", "name": "Purge then re-optimize",
     "description": "Remove orders older than 90 days (refuses above 5000 orders), then re-optimize the plant.",
     "steps": [
         {"type": "purge.orders", "params": {"max_rows": 5000}, "label": None,
          "continue_on_failure": False, "run_on": "success"},
         {"type": "optimizer.plant", "params": {"mode": "due_date", "search": "exhaustive", "apply_mode": "apply"},
          "label": None, "continue_on_failure": False, "run_on": "success"}],
     "defaults": {}},
    {"key": "optimize_then_report", "name": "Optimize then report",
     "description": "Re-optimize the plant, then report the orders that are still late.",
     "steps": [
         {"type": "optimizer.plant", "params": {"mode": "due_date", "search": "exhaustive", "apply_mode": "apply"},
          "label": None, "continue_on_failure": False, "run_on": "success"},
         {"type": "report.late_orders", "params": {}, "label": None, "continue_on_failure": False, "run_on": "success"}],
     "defaults": {}},
    {"key": "remove_backlog_then_reoptimize", "name": "Remove backlog, then re-optimize",
     "description": "Compress the overdue backlog into now (including orders already running), then re-optimize the plant.",
     "steps": [
         {"type": "optimizer.backlog", "params": {"include_running": True, "apply_mode": "apply"}, "label": None,
          "continue_on_failure": False, "run_on": "success"},
         {"type": "optimizer.plant", "params": {"mode": "due_date", "search": "exhaustive", "apply_mode": "apply"},
          "label": None, "continue_on_failure": False, "run_on": "success"}],
     "defaults": {}},
]

_STEP_FIELDS = ("type", "label", "continue_on_failure", "run_on")


def _fields_changed(a: dict, b: dict) -> list[str]:
    out = [f for f in _STEP_FIELDS if a.get(f) != b.get(f)]
    pa, pb = a.get("params") or {}, b.get("params") or {}
    out += [f"params.{k}" for k in sorted(set(pa) | set(pb)) if pa.get(k) != pb.get(k)]
    return out


def diff_steps(job_steps: list[dict], template_steps: list[dict]) -> list[dict]:
    """Position-by-position comparison, both sides already normalised: `[{seq, change, job, template, fields}]` where
    change is `same` | `changed` | `added` (only in the template) | `removed` (only in the job's copy)."""
    out = []
    for i in range(max(len(job_steps), len(template_steps))):
        j = job_steps[i] if i < len(job_steps) else None
        t = template_steps[i] if i < len(template_steps) else None
        if j is None:
            out.append({"seq": i + 1, "change": "added", "job": None, "template": t, "fields": []})
        elif t is None:
            out.append({"seq": i + 1, "change": "removed", "job": j, "template": None, "fields": []})
        else:
            fields = _fields_changed(j, t)
            out.append({"seq": i + 1, "change": "changed" if fields else "same", "job": j, "template": t,
                        "fields": fields})
    return out
