"""Job targets (W3a): which plants one job definition runs for. **Pure** (stdlib + `triggers.get_zone`); the plant rows
are injected, so expansion is testable without a database and `data.load_plant_rows()` is the only DB read.

A job with NO target rows is the legacy single-plant job (its home `plant`). With rows, the expansion happens at
FIRE time (a plant that joins a subnetwork starts being run without editing the job):

- `explicit`: `value` is a plant code.
- `subnetwork`: `value` is a subnetwork code (`plants.subnetwork`); every plant of it.
- `all`: `value` is `*` (every plant) or a comma list of plant codes (the scope the creating admin had when the job
  was saved, so a scoped admin's "all my plants" never grows into plants they cannot reach).
- `excluded` rows (explicit or subnetwork) remove plants from the union of the included rows.
- `params_override` on an included row is deep-merged over the job params for the plants that row contributes.
"""
from __future__ import annotations

import copy
from datetime import datetime

from backend.jobs import triggers

KINDS = ("explicit", "subnetwork", "all")
ALL_VALUE = "*"
SKIP_NO_TZ = "plant has no timezone"
SKIP_BAD_TZ = "plant timezone is not a valid IANA zone"
SKIP_GONE = "plant no longer exists"


class TargetError(ValueError):
    """A target payload that cannot be stored (the route turns it into a 400)."""


def deep_merge(base: dict, over: dict | None) -> dict:
    """`over` laid over `base`, nested dicts merged key by key (lists and scalars replace)."""
    out = copy.deepcopy(base or {})
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def normalize_targets(rows) -> list[dict]:
    """Validate and normalise incoming target dicts: {kind, value, excluded, params_override}."""
    out: list[dict] = []
    for r in rows or []:
        kind = (r.get("kind") or "").strip()
        if kind not in KINDS:
            raise TargetError(f"target kind must be one of {', '.join(KINDS)}")
        value = str(r.get("value") if r.get("value") is not None else "").strip()
        if kind == "all":
            value = value or ALL_VALUE
            if r.get("excluded"):
                raise TargetError("an 'all' target cannot be excluded; exclude plants individually")
        elif not value:
            raise TargetError(f"a {kind} target needs a value")
        ov = r.get("params_override")
        if ov is not None and not isinstance(ov, dict):
            raise TargetError("params_override must be an object")
        out.append({"kind": kind, "value": value, "excluded": bool(r.get("excluded", False)),
                    "params_override": ov or None})
    return out


def all_scope_value(allowed_plants: list[str] | None) -> str:
    """What an 'all' target stores: '*' for an unrestricted admin, else the plants the admin may reach."""
    return ALL_VALUE if allowed_plants is None else ",".join(sorted(allowed_plants))


def _tz_state(tz: str | None) -> tuple[str | None, str | None]:
    """(timezone, skip reason)."""
    tz = (tz or "").strip()
    if not tz:
        return None, SKIP_NO_TZ
    try:
        triggers.get_zone(tz)
    except triggers.ScheduleError:
        return tz, SKIP_BAD_TZ
    return tz, None


def expand_targets(job: dict, now: datetime | None = None, *, plants: list[dict]) -> dict:
    """Ordered plants a job runs for. `job` carries `plant` (home) and `targets` (rows as stored). `plants` is the plant
    master list `[{plant, subnetworks:[...], timezone}]`. `now` is reserved (membership is not time-dependent yet).

    Returns `{"plants": [{plant, timezone, skip, params_override}], "warnings": [str], "single": bool}`; a plant with
    `skip` set is still listed (the runner records a skipped child run `config` for it; scheduling never arms it).
    A job without target rows expands to its home plant only, `single` true, and is run exactly as before."""
    rows = job.get("targets") or []
    by_code = {p["plant"]: p for p in plants}
    if not rows:
        home = job["plant"]
        p = by_code.get(home)
        tz, skip = _tz_state(p["timezone"]) if p else (None, SKIP_GONE)
        return {"plants": [{"plant": home, "timezone": tz, "skip": skip, "params_override": {}}],
                "warnings": [f"{home}: {skip}"] if skip else [], "single": True}

    def members(r: dict) -> list[str]:
        if r["kind"] == "explicit":
            return [r["value"]]
        if r["kind"] == "subnetwork":
            return sorted(c for c, p in by_code.items() if r["value"] in (p.get("subnetworks") or ()))
        if r["value"] == ALL_VALUE:
            return sorted(by_code)
        wanted = {x.strip() for x in r["value"].split(",") if x.strip()}
        return sorted(c for c in by_code if c in wanted)

    removed: set[str] = set()
    for r in rows:
        if r.get("excluded"):
            removed.update(members(r))
    order: list[str] = []
    overrides: dict[str, dict] = {}
    for r in rows:
        if r.get("excluded"):
            continue
        for code in members(r):
            if code in removed:
                continue
            if code not in overrides:
                order.append(code)
                overrides[code] = {}
            if r.get("params_override"):
                overrides[code] = deep_merge(overrides[code], r["params_override"])
    out, warnings = [], []
    for code in order:
        p = by_code.get(code)
        tz, skip = _tz_state(p["timezone"]) if p else (None, SKIP_GONE)
        if skip:
            warnings.append(f"{code}: {skip}")
        out.append({"plant": code, "timezone": tz, "skip": skip, "params_override": overrides[code]})
    return {"plants": out, "warnings": warnings, "single": False}


def runnable(expansion: dict) -> list[dict]:
    return [p for p in expansion["plants"] if not p["skip"]]


def rollup(statuses: list[str]) -> str:
    """Batch status from the final status of each child: failed if any failed, warning if any warning, skipped or
    cancelled, else succeeded. (A batch with no children is `succeeded`.)"""
    s = set(statuses)
    if "failed" in s:
        return "failed"
    if s & {"warning", "skipped", "cancelled"}:
        return "warning"
    return "succeeded"


def counts_of(statuses: list[str]) -> dict:
    out: dict[str, int] = {"total": len(statuses)}
    for s in statuses:
        out[s] = out.get(s, 0) + 1
    return out
