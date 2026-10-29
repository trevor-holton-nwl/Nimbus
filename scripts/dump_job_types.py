"""Write tests/fixtures/jobs_types.json: every non-stub job type as GET /jobs/types serves it (kind, mutates, param
metadata, defaults). tests/test_jobs_contract.py asserts the committed file equals the live registry, and the Jobs
frontend tests (tests/modules/admin-ops/) render their forms from it, so the generic form is tested against what
the server really sends. Run `python scripts/dump_job_types.py` after changing a job type's params."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend.jobs.registry import describe_params, list_types  # noqa: E402
import backend.jobs.types  # noqa: E402,F401  (registers the types)


def live() -> dict:
    return {"types": [
        {"key": jt.key, "label": jt.label, "plant_scoped": jt.plant_scoped, "kind": jt.kind, "mutates": jt.mutates,
         "params": describe_params(jt), "defaults": jt.params_model().model_dump(mode="json")}
        for jt in list_types()]}


if __name__ == "__main__":
    path = os.path.join(ROOT, "tests", "fixtures", "jobs_types.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(live(), f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)
