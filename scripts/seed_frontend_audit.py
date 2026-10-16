"""Add deterministic, synthetic UI audit data to a dedicated local audit DB.

Run after schema.sql using the worktree's untracked .env. No credentials are
printed. This script never deletes data and refuses non-local/non-audit targets.
Use --orders 10000 for the stress profile; default is 1000.
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb


def seed(order_count: int) -> dict[str, int]:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    host = os.getenv("PG_HOST", "")
    database = os.getenv("PG_DB", "")
    if host not in {"localhost", "127.0.0.1", "::1"} or not database.startswith("nimbus_frontend_audit"):
        raise SystemExit("Refusing target: a loopback host and nimbus_frontend_audit database are required")
    if os.getenv("NIMBUS_TEST_DB") != "1":
        raise SystemExit("NIMBUS_TEST_DB=1 is required")
    hours = {str(day): [6, 22] for day in range(1, 6)}
    today = datetime.now().replace(hour=10, minute=0, second=0, microsecond=0)
    with psycopg.connect(
        host=host, port=os.getenv("PG_PORT", "5432"), dbname=database,
        user=os.getenv("PG_USER"), password=os.getenv("PG_PASS"), connect_timeout=5,
    ) as conn, conn.cursor() as cur:
        # schema.sql includes these two sample plants; all other records must
        # belong to this fixture before the synthetic seed may be added.
        cur.execute(
            "SELECT count(*) FROM plants WHERE subnetwork <> 'AUDIT' "
            "AND NOT ((plant = '1006' AND subnetwork = 'WTG') OR (plant = '5512' AND subnetwork = 'HMF'))"
        )
        if cur.fetchone()[0]:
            raise SystemExit("Refusing to seed: database contains plants outside the AUDIT fixture")
        cur.execute("INSERT INTO subnetworks(code,name) VALUES ('AUDIT','Synthetic frontend audit') ON CONFLICT DO NOTHING")
        for index in range(1, 51):
            plant = f"AUD{index:02}"
            zone = "Europe/Berlin" if index == 2 else "America/New_York"
            cur.execute(
                "INSERT INTO plants(subnetwork,plant,timezone,description,work_hours) VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT DO NOTHING",
                ("AUDIT", plant, zone, f"Audit plant {index:02} — long translated description for layout verification", Jsonb(hours)),
            )
            for line in range(1, (70 if index <= 2 else 1) + 1):
                machine = f"AUD-L{line:03}"
                cur.execute(
                    "INSERT INTO machine(subnetwork,plant,machine,wc_group) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    ("AUDIT", plant, machine, ("CUT", "FORM", "PACK")[(line - 1) % 3]),
                )
                cur.execute(
                    "INSERT INTO machine_calendar(subnetwork,plant,machine,work_hours) VALUES (%s,%s,%s,%s) "
                    "ON CONFLICT DO NOTHING", ("AUDIT", plant, machine, Jsonb(hours)),
                )
        for index in range(1, 101):
            cur.execute(
                "INSERT INTO materials(material_id,material_description,base_uom) VALUES (%s,%s,'EA') "
                "ON CONFLICT DO NOTHING",
                (f"AUD-M{index:03}", f"Audit material {index:03} — Größe / descrição / descripción"),
            )
        for index in range(order_count):
            plant = "AUD02" if index % 20 == 0 else "AUD01"
            finish = today + timedelta(days=(index % 112) - 4)
            needs_planning = index % 11 == 0
            cur.execute(
                "INSERT INTO orders(id,production_order,material_number,material_description,plant,machine,"
                "basic_start_date,basic_finish_date,scheduled_start,scheduled_end,run_time,run_time_source,"
                "order_quantity,color,form_size,labor_hours,no_of_fte,manual_firmed,planning_status,planning_reason,notes) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,4,'manual',100,%s,%s,8,2,%s,%s,%s,%s) "
                "ON CONFLICT DO NOTHING",
                (f"AUD-ORDER-{index:06}", f"AUD-PO-{index:06}", f"AUD-M{index % 100 + 1:03}",
                 "Synthetic long material description — wrap, truncate and search this complete value", plant,
                 f"AUD-L{index % 70 + 1:03}", finish - timedelta(hours=8), finish - timedelta(hours=index % 3),
                 None if needs_planning else finish - timedelta(hours=4), None if needs_planning else finish,
                 ("Blue", "Orange", "Green")[index % 3], ("Small", "Medium", "Large")[index % 3],
                 index % 13 == 0, "needs_planning" if needs_planning else "scheduled",
                 Jsonb({"code": "audit_fixture", "message": "Synthetic unplanned order for exception workflows"})
                 if needs_planning else None, "Synthetic audit fixture; no real customer or production data."),
            )
        for week in range(16):
            day = today + timedelta(weeks=week)
            period = f"{day.isocalendar().year}-W{day.isocalendar().week:02}"
            for group, capacity in [("CUT", 80), ("FORM", 120), ("PACK", 160)]:
                cur.execute(
                    "INSERT INTO labor_plan(subnetwork,plant,wc_group,period,avail_hours) VALUES ('AUDIT','AUD01',%s,%s,%s) "
                    "ON CONFLICT DO NOTHING", (group, period, capacity),
                )
        cur.execute(
            "INSERT INTO labor_plan_machine(subnetwork,plant,machine,day,avail_hours,source) "
            "VALUES ('AUDIT','AUD01','AUD-L001',%s,7.5,'override') ON CONFLICT DO NOTHING", (today.date().isoformat(),),
        )
    return {"plants": 50, "machines": 188, "requested_orders": order_count, "labor_weeks": 16}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orders", type=int, choices=(1000, 10000), default=1000)
    print(seed(parser.parse_args().orders))
