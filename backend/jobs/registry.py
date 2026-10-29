"""Job-type registry. Pure (stdlib + pydantic); the run bodies live in backend/jobs/types/."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel


@dataclass
class JobOutcome:
    """What a job body returns. status is succeeded|warning|failed; raising is also a failure."""
    status: str = "succeeded"
    summary: dict = field(default_factory=dict)
    error: str | None = None
    artifact: dict | None = None      # report result: {sections:[{key,title,columns,rows}], summary} (see artifacts.py)


@dataclass(frozen=True)
class JobType:
    key: str
    label: str
    params_model: type[BaseModel]
    run: Callable[[Any, BaseModel], JobOutcome]               # run(ctx, params) -> JobOutcome
    plant_scoped: bool = True
    default_timeout_s: int = 600
    timeout_fn: Callable[[BaseModel], int] | None = None     # per-params timeout (search budget + margin)
    lock_key: Callable[[str, BaseModel], str] | None = None  # None -> one run at a time per (type, plant)
    stub: bool = False                                        # hidden from the types list unless stubs enabled
    needs_plant_timezone: bool = False                        # a schedule cannot be saved for a plant with no timezone
    defer_clock: bool = False                                 # the body starts the timeout clock itself (ctx.begin_work)
    kind: str = "action"                                      # 'action' (may change data) | 'report' (read-only, artifact)
    mutates: bool = True                                      # False for reports
    slot: Callable[[], Any] | None = None                     # returns the type's own semaphore; the RUNNER holds it

    def timeout_for(self, params: BaseModel) -> int:
        return int(self.timeout_fn(params)) if self.timeout_fn else self.default_timeout_s

    def lock_name(self, plant: str, params: BaseModel) -> str:
        return self.lock_key(plant, params) if self.lock_key else f"jobs:{self.key}:{plant}"


REGISTRY: dict[str, JobType] = {}


def register(jt: JobType) -> JobType:
    REGISTRY[jt.key] = jt
    return jt


def stubs_enabled() -> bool:
    return os.environ.get("NIMBUS_JOBS_STUBS", "").strip().lower() in ("1", "true", "yes", "on")


def get_type(key: str) -> JobType | None:
    """Registered type, or None (also None for a stub type while stubs are disabled)."""
    jt = REGISTRY.get(key)
    if jt is None or (jt.stub and not stubs_enabled()):
        return None
    return jt


def list_types() -> list[JobType]:
    return [jt for jt in REGISTRY.values() if not jt.stub or stubs_enabled()]


# ------------------------------------------------------------------------------------------ param metadata
def _resolve(schema: dict, defs: dict) -> dict:
    """Follow a $ref and unwrap Optional (anyOf with null); sibling keys of the $ref (title, x-widget) are kept."""
    out = dict(schema)
    for _ in range(4):
        if "$ref" in out:
            ref = defs.get(str(out.pop("$ref")).rsplit("/", 1)[-1], {})
            out = {**ref, **out}
        elif "anyOf" in out:
            alts = [a for a in out.pop("anyOf") if a.get("type") != "null"]
            out = {**(alts[0] if alts else {}), **out}
        else:
            break
    return out


def describe_params(jt: JobType) -> list[dict]:
    """Per-param metadata for the generic params form, derived from the pydantic model's JSON schema:
    {key, type: string|enum|boolean|integer|number|multi_enum|date_window, label_key, title, default, required,
    enum, enum_label_keys, min, max, pattern, widget}. Label keys are `jobs.p.<type>.<param>` and
    `jobs.p.<type>.<param>.<value>` (the UI falls back to `title` / the raw value)."""
    schema = jt.params_model.model_json_schema()
    defs = schema.get("$defs", {})
    required = set(schema.get("required") or [])
    defaults = jt.params_model().model_dump(mode="json")
    out = []
    for key, raw in (schema.get("properties") or {}).items():
        prop = _resolve(raw, defs)
        widget = raw.get("x-widget") or prop.get("x-widget")
        base = f"jobs.p.{jt.key}.{key}"
        t = prop.get("type")
        enum = prop.get("enum")
        if widget == "date-window":
            typ = "date_window"
        elif t == "array" and _resolve(prop.get("items") or {}, defs).get("enum"):
            typ, enum = "multi_enum", _resolve(prop["items"], defs)["enum"]
        elif enum:
            typ = "enum"
        elif t in ("boolean", "integer", "number"):
            typ = t
        else:
            typ = "string"
        meta = {"key": key, "type": typ, "label_key": base,
                "title": raw.get("title") or key.replace("_", " ").capitalize(),
                "default": defaults.get(key), "required": key in required, "widget": widget}
        if enum:
            meta["enum"] = list(enum)
            meta["enum_label_keys"] = {str(v): f"{base}.{v}" for v in enum}
        for src, dst in (("minimum", "min"), ("maximum", "max"), ("pattern", "pattern")):
            if src in prop:
                meta[dst] = prop[src]
        out.append(meta)
    return out
