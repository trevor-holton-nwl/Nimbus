# SAP ECC → NIMBUS Integration Roadmap

**SAP-side build guide for the Basis / ABAP / Security teams**

| | |
|---|---|
| **Owning app** | NIMBUS (Newell Integrated Batch & Unified Scheduling) — Python / FastAPI + PostgreSQL, hosted on Azure Container Apps |
| **SAP system of record** | SAP ECC (PP / PP‑PI, MM, classification) |
| **Direction** | SAP → NIMBUS, **read‑only** from SAP. NIMBUS never writes back to ECC. |
| **Cadence** | Scheduled, idempotent upserts (full‑then‑delta) |
| **Data scope** | Master data (plants, work centers, materials, material‑plant data) + production orders |
| **Document audience** | SAP Basis, ABAP development, SAP Security/GRC, and the network/infra team |
| **Status of NIMBUS side** | A non‑live skeleton already exists (Interface admin tab, stub connectors, `sap_sync.py`, three `sap_sync_*` tables, scheduler **disabled by default**). No live SAP call is made until the items in §6 are resolved. |

---

## Executive summary

NIMBUS needs an automated, scheduled feed from SAP ECC to replace today's manual Excel upload of production orders and manual entry of master data. This document specifies the **SAP‑side** work required to deliver that feed: which tables and fields are the source for each NIMBUS data object, the exact transactions and transport steps for three candidate integration patterns, the well‑known SAP interface pitfalls that *will* bite if not handled, and the open decisions that only Basis/Security/PP can answer.

**Recommendation:** Start with a **file‑drop MVP** (SAP background job extracts to a file landing zone that NIMBUS ingests) and **graduate to OData** via SAP Gateway as the strategic target. The file‑drop pattern requires **no inbound network path into SAP**, reuses NIMBUS's existing Excel ingest code, and can pilot in days; OData gives a clean, governed HTTP/JSON delta interface once a private network path (VPN / ExpressRoute / SAP Cloud Connector) exists. A **custom RFC (PyRFC)** pattern is documented as the high‑volume / fine‑control option but is **not** recommended for the pilot.

**Why this matters for the integration design:** NIMBUS upserts orders on a stable business key (`MD5(production_order | material_number)`) and deliberately **never overwrites** user scheduling edits (`scheduled_start` / `scheduled_end`) or notes on re‑sync. That makes re‑runs safe and idempotent **by construction** — so the SAP side does **not** need to compute deltas perfectly, guarantee exactly‑once delivery, or de‑duplicate. SAP's job is simply to make the current truth available; NIMBUS reconciles. This relaxes the SAP build considerably and is the single most important fact for the SAP team to internalize.

**Single biggest unknown:** the network direction between an on‑prem ECC (behind the corporate firewall) and an Azure Container App (today external ingress, no VNet integration). This is what decides file‑drop vs. pull and must be answered by infra/Basis early — see §5 and §6.

---

## 1. Integration patterns

Three patterns are documented. NIMBUS supports all three behind a transport abstraction, so the choice can change later without reworking the NIMBUS side. **Recommendation: file‑drop MVP → OData target.**

### 1.1 Comparison

| Pattern | How it works | Pros | Cons / prerequisites | When to use |
|---|---|---|---|---|
| **File‑drop / batch extract** **(recommended MVP)** | An SAP background job (ABAP report or SAP Query) extracts CSV/XLSX and writes it to a landing zone — SAP app‑server directory via `OPEN DATASET`, SFTP, or Azure Blob — that NIMBUS then ingests. | • **No inbound connection into SAP** (firewall‑friendly; SAP pushes outbound or writes to a share) <br>• Reuses NIMBUS's existing, battle‑tested Excel ingest path <br>• Lowest ABAP/Basis effort; fastest to pilot <br>• Easy to audit (the file is a tangible artifact) | • Latency = job cadence (e.g. hourly/nightly), not real‑time <br>• File hygiene: encoding, decimal/date formats, partial‑write/locking, retention, naming <br>• Needs a landing zone + a transfer mechanism (SFTP server, Blob container, or shared path) | **Start here.** Pilot and prove the data mapping with minimal Basis/network dependency. |
| **OData via SAP Gateway** **(strategic target)** | A Gateway/OData service (built in `SEGW`) exposes Plant / Material / MaterialPlant / WorkCenter / ProductionOrder entity sets over HTTPS/JSON; NIMBUS pulls with `httpx`, using `$filter` for delta and `$skiptoken` for paging. | • Clean, governed HTTP/JSON contract <br>• Standard auth (Basic comm‑user or OAuth/SAML) <br>• Built‑in delta (`$filter` on change date) and server paging (`$skiptoken`) <br>• Reusable by other consumers; first‑class in S/4 migration | • Requires **SAP_GWFND** (Gateway Foundation) installed, activated, and licensed <br>• Requires a **private network path Azure → on‑prem SAP** (NIMBUS pulls) <br>• ABAP effort to model entities + map them (DPC_EXT or CDS) <br>• Service registration, `SICF` activation, role + comm user | **Graduate to this** once a private network path and Gateway are confirmed. The long‑term interface. |
| **RFC + custom Z (PyRFC)** | Custom remote‑enabled function modules `Z_NIMBUS_GET_*` return flat tables; NIMBUS calls them via PyRFC (SAP NW RFC SDK in the container). | • Maximum control over the exact payload and joins <br>• Best throughput for very large extracts <br>• Server‑side classification resolution (COLOR / FORM_SIZE) in one round trip | • SAP **NW RFC SDK** must be shipped in the NIMBUS container image (licensing + image size) <br>• RFC/gateway ports open from Azure to SAP (private path required) <br>• Full ABAP development + transport lifecycle <br>• More brittle to SAP upgrades than OData | High‑volume or fine‑grained control **after** the pattern is proven. Not for the pilot. |

### 1.2 Why file‑drop first, OData next

- **De‑risks the hardest unknown first.** File‑drop sidesteps the Azure→on‑prem inbound question entirely (SAP writes outbound / drops a file). We can validate the *data* mapping before solving the *network*.
- **Reuses NIMBUS code.** The production‑order extract just needs to match the existing upload shape; NIMBUS's `POST /upload` ingest path consumes it with no new parsing.
- **OData is the right end state**, not RFC, because it is HTTP/JSON (trivial for FastAPI/`httpx`), governed by standard SAP role/auth, has built‑in delta and paging, and survives the eventual S/4HANA move better than bespoke RFCs.
- **RFC stays in reserve** for the case where OData paging/perf proves inadequate at full volume, or where server‑side classification resolution must happen in a single call.

The exact SAP build steps for each pattern are in §3.

---

## 2. Data object → SAP source mapping

This is the heart of the document. Each NIMBUS data object is mapped to its ECC source tables and fields, with the display transaction for verification and the per‑field gotchas (detailed in §4). Items marked **OPEN** require a Basis/PP decision (collected in §6).

### 2.1 Master data

#### `plants` — NIMBUS key `(subnetwork, plant)`

| NIMBUS column | SAP source | Notes |
|---|---|---|
| `plant` | `T001W‑WERKS` | Plant / branch code (4 chars). |
| `name` (label) | `T001W‑NAME1` | Plant description. |
| `subnetwork` | **OPEN** — see below | NIMBUS groups plants under a "subnetwork". No standard 1:1 ECC field. |

- **Display / verify:** `OX10` (plant definition) or `SM30` on view `V_T001W` / table browse `SE16N → T001W`.
- **Volume:** tiny (tens of rows). **Full pull every run** — no delta needed.
- **Subnetwork is a Newell org concept, not a standard SAP field.** Candidate sources to confirm with Basis/PP: MRP controller area (`T024D`), a planning‑plant or plant‑grouping attribute, valuation/company grouping, or a custom **Z** field/table maintained for this purpose. **Flagged in §6.**

#### `subnetworks` — NIMBUS key `(code, name)`

| NIMBUS column | SAP source | Notes |
|---|---|---|
| `code` | **OPEN** | Depends on what "subnetwork" maps to (see above). |
| `name` | **OPEN** | Description for the chosen grouping. |

- Until the source is decided, `subnetworks` can be **maintained manually** in NIMBUS's master‑data grid and **not** synced from SAP. **Flagged in §6.**

#### `production_lines` — NIMBUS key `(subnetwork, plant, production_line)`

| NIMBUS column | SAP source | Notes |
|---|---|---|
| `production_line` | `CRHD‑ARBPL` | Work center code. NIMBUS treats a work center as a "production line". |
| `plant` | `CRHD‑WERKS` | Work‑center plant. |
| `name` (label) | `CRTX‑KTEXT` (join `CRHD‑OBJID = CRTX‑OBJID`, filter `SPRAS`) | Work‑center text by language. |
| `subnetwork` | derived from `plants` mapping | Inherited from the plant's subnetwork. |

- **Display / verify:** `CR03` (display work center). For REM lines, line/production version may be the better grain — **confirm with PP.**
- **Filter** by work‑center **category** (`CRHD‑VERWE` usage / category) so only genuine production lines are pulled, not labor/QA/cost‑center work centers.
- **Volume:** small–moderate (≤ a few thousand at full Newell scale). Periodic full pull is acceptable; delta on `CRHD‑AEDAT` (change date) optional.

#### `materials` — NIMBUS key `material_id`

| NIMBUS column | SAP source | Notes |
|---|---|---|
| `material_id` | `MARA‑MATNR` | **ALPHA conversion** — strip leading zeros on the way out (§4.1). |
| material type | `MARA‑MTART` | Optional filter (e.g. only FERT/HALB). |
| base UoM | `MARA‑MEINS` | UoM internal vs ISO (§4.4). |
| description (label) | `MAKT‑MAKTX` (join `MAKT‑MATNR = MARA‑MATNR`, filter `MAKT‑SPRAS`) | By language. |

- **Display / verify:** `MM03`.
- **Delta:** `MARA‑LAEDA` (last change date) is the natural watermark for changed‑since extracts.
- **Volume:** potentially large. **Scope to the pilot plant's materials and paginate** (§4.6).

#### `material_plants` — NIMBUS key `(material_id, plant)`

| NIMBUS column | SAP source | Notes |
|---|---|---|
| `material_id` | `MARC‑MATNR` | ALPHA conversion. |
| `plant` | `MARC‑WERKS` | |
| MRP status / fields | `MARC‑MMSTA`, `MARC‑BSTMI`, `MARC‑BSTRF`, etc. | Plant‑specific MRP/lot‑size data, as needed by scheduling. |
| production version | `MKAL‑VERID` (+ routing/BOM linkage) | Production version per material/plant. |

- **Display / verify:** `MM03` (MRP views), `C223` (production version maintenance).
- **Delta:** changes via `MARC` change date; pair with material delta.
- **Volume:** material × plant — can be very large. **Scope to pilot plant(s)** and paginate.

### 2.2 Production orders → NIMBUS `orders`

NIMBUS keys each order row on `id = MD5(production_order | material_number)` (stable across reloads) and **never overwrites** `scheduled_start` / `scheduled_end` / `notes` on upsert — so SAP only needs to supply current order truth.

| NIMBUS column | SAP source | Notes / gotchas |
|---|---|---|
| `production_order` | `AFKO‑AUFNR` / `AUFK‑AUFNR` | Order number. Strip leading zeros (§4.1). `AFKO` = order header (PP), `AUFK` = order master (cross‑app). |
| `material_number` | `AFPO‑MATNR` | Order item material. **ALPHA conversion** (§4.1). |
| `material_description` | `MAKT‑MAKTX` (join on `AFPO‑MATNR`, by `SPRAS`) | Language‑dependent text. |
| `production_line` | operation work center: `AFVC‑ARBID → CRHD‑ARBPL`; or order header work center | Map the work center to the NIMBUS line. Decide **which operation's** work center represents the line (typically the lead/first operation) — **confirm with PP.** |
| `plant` | `AFPO‑DWERK` (production plant) / `AUFK‑WERKS` | Materialized onto each NIMBUS order row at ingest. Prefer `AFPO‑DWERK`. |
| `basic_start_date` | `AFKO‑GSTRP` | DATS `YYYYMMDD`; `00000000` ⇒ NULL; timezone (§4.2). |
| `basic_finish_date` | `AFKO‑GLTRP` | DATS; same handling. |
| `order_quantity` | `AFKO‑GAMNG` (+ unit `AFKO‑GMEIN`) | Decimal handling (§4.3) + UoM (§4.4). |
| `run_time` | **OPEN** — routing standard values (`AFVV` machine/processing time) or a Newell‑defined calc | NIMBUS uses this as the scheduling duration. **Definition must be confirmed** (§6). |
| `color` | **classification** characteristic (`AUSP` / `CABN` / `CAWN`) | **Classification gotcha** (§4.5) — not in a transparent order table. Resolve server‑side. |
| `form_size` | **classification** characteristic | Same classification gotcha. |
| `firming_indicator` | **OPEN** — order firming flag (`AFPO‑/header FIXKZ`) or planned‑order firming (`PLAF‑FIXKZ`) | NIMBUS column maps to SAP `FIXKZ`. Confirm exactly which firming flag is intended (§6). |

#### Order scope (system status — `JEST` / `JSTO`)

Extract only orders in the relevant lifecycle states. Status is stored as status objects in **`JEST`** (active statuses per object, `OBJNR`) keyed against **`JSTO`**; the order's `OBJNR` comes from `AUFK‑OBJNR`.

| Status | SAP status code | NIMBUS scope |
|---|---|---|
| Created | `I0001` (CRTD) | **Include** |
| Released | `I0002` (REL) | **Include** |
| Technically complete | `I0045` (TECO) | **Exclude** |
| Closed | CLSD | **Exclude** |
| Deletion flag / deleted | DLT / LKD | **Exclude** |
| Locked | LKD | **Exclude** |

- Practically: select active statuses from `JEST` where `INACT = ' '` (active) and the status is in the include set, and **exclude** any order carrying a TECO/CLSD/DLT/LKD active status.
- Implementation options: a **`COOIS`/`COHV`** order‑info selection variant with the status profile set, or an explicit status check inside the Z extractor / OData provider. Prefer doing the status filter **on the SAP side** so NIMBUS never sees out‑of‑scope orders.

---

## 3. SAP build steps by transport (transaction level)

Each pattern below lists the concrete transactions and the transport lifecycle (DEV → QA → PRD via `STMS`). All ABAP objects ship through the standard transport path; nothing is built directly in PRD.

### 3.1 File‑drop / batch extract (recommended MVP)

1. **Build the extract.** Pick one:
   - **`SQ01` / `SQVI`** — SAP Query / QuickViewer joining `AFKO` + `AFPO` + `AUFK` (orders) and `MARA` + `MARC` (materials), with status filtering. Fastest to stand up; limited transform/classification ability.
   - **`SE38` / `SE80`** — a custom ABAP report (`Z_NIMBUS_EXTRACT_*`) for full control: status filter via `JEST`, classification resolve for COLOR/FORM_SIZE, ALPHA/DATS/decimal/UoM normalization, and a clean delimited or fixed output. **Recommended** for production orders because of the classification and conversion handling.
   - **`COOIS`** (order info system) with a saved selection variant exported to file — quick but coarse.
2. **Schedule the job.** `SM36` to define the background job (one step per object or one combined step), with a variant and a periodicity (e.g. hourly for orders, nightly for material/master). Monitor in `SM37`.
3. **Write the output.**
   - To the SAP application server: **`OPEN DATASET … FOR OUTPUT`** then `TRANSFER`, into a directory visible in **`AL11`**. Use a deterministic filename + a temp‑then‑rename (write `*.tmp`, rename on close) so NIMBUS never reads a half‑written file.
   - To a share / external target: **`CG3Y`** (download server file) for manual/ad‑hoc, or an OS‑level script / **SAP PI‑PO file adapter** / SFTP step to push to an SFTP server or **Azure Blob** container that NIMBUS watches.
4. **Hand off to NIMBUS.** NIMBUS ingests from the agreed landing zone (Blob/SFTP/share) into its existing upload path. Provide a fixed column order, UTF‑8 encoding, ISO dates, period decimal separator, and a stable file‑naming convention with a timestamp/sequence.
5. **Transport.** Report, query objects, and job definitions move DEV → QA → PRD via **`STMS`**. Validate the extract in the **QA client** before PRD.

### 3.2 OData via SAP Gateway (strategic target)

1. **Verify Gateway.** Confirm **SAP_GWFND** is installed/active (`SPAM`/`SAINT` component check) and that **`/IWFND/MAINT_SERVICE`** is available. Confirm licensing.
2. **Model the service — `SEGW`.** Create a project (e.g. `ZNIMBUS_SRV`) and define entity types: **Plant, Material, MaterialPlant, WorkCenter, ProductionOrder**, each with the properties mapped in §2 and an appropriate key.
3. **Map the data provider.** Either redefine the generated **`DPC_EXT`** class methods (`GET_ENTITYSET`, with `$filter`/`$top`/`$skiptoken` handling) over RFC/BAPI/OpenSQL, **or** map to **CDS views** (preferred where the release supports it — cleaner and reusable). Implement status filtering, classification resolution, and the conversions from §4 here.
4. **Generate** runtime artifacts from `SEGW`.
5. **Register & activate — `/IWFND/MAINT_SERVICE`.** Add the service, assign the backend **system alias**, and activate it.
6. **Check the ICF node — `SICF`.** Ensure the service node is active and the path is reachable over HTTPS.
7. **Test — `/IWFND/GW_CLIENT`.** Validate `$metadata`, a sample `GET` with **`$filter`** (delta by change date), **`$top`/`$skiptoken`** (paging), and language/UoM handling.
8. **Authorize.** Create a **`PFCG`** role granting access to the service (`S_SERVICE` + relevant `S_RFC`/data auth objects) and a **`SU01` Communication user** (user type *Communications/System*, not Dialog) bound to that role. Credentials are provisioned by Security and stored **outside** NIMBUS code (see §4.10 and the NIMBUS architecture doc — secrets go to Azure Key Vault, referenced not embedded).
9. **Transport** the `SEGW` project and role through `STMS`; register/activate the service per system.

### 3.3 RFC + custom Z (PyRFC) — reserve option

1. **Define structures — `SE11`.** DDIC structures for each output (flat, NIMBUS‑aligned column order).
2. **Build remote FMs — `SE37` / `SE80`.** A remote‑enabled function group with `Z_NIMBUS_GET_PLANTS`, `Z_NIMBUS_GET_WORKCENTERS`, `Z_NIMBUS_GET_MATERIALS`, `Z_NIMBUS_GET_MATERIAL_PLANTS`, `Z_NIMBUS_GET_ORDERS`. Imports: `IV_PLANT`, `IV_CHANGED_SINCE`, `IV_STATUS_SCOPE`, paging (`IV_MAX_ROWS`, `IV_OFFSET`/cursor); exports: a flat table. Inside: optimized **OpenSQL** joins, **server‑side classification resolve** for COLOR/FORM_SIZE, and the §4 conversions.
3. **Transport — `STMS`** DEV → QA → PRD.
4. **Authorize.** **`SU01`** Communication user + **`PFCG`** role scoped to **`S_RFC`** for that function group only (least privilege), plus any BAPI/data auth objects the FMs touch.
5. **Connectivity.** `SM59` is only needed for SAP‑*outbound* RFC; for NIMBUS→SAP pull, the network path + comm user suffice. The NIMBUS container must bundle the **SAP NW RFC SDK** and `pyrfc` (deferred — see the NIMBUS architecture doc / MIGRATION.md).

---

## 4. Cross‑cutting gotchas (the shortcomings section)

These are the recurring SAP‑interface failure modes. Each *will* cause silent data corruption or job failure if not handled. Wherever possible, **resolve on the SAP side** (in the extractor / DPC / FM) so NIMBUS receives clean, normalized values.

### 4.1 MATNR / AUFNR leading zeros (ALPHA conversion)
Material and order numbers are stored internally with leading zeros under the **ALPHA** conversion exit. A raw table read returns e.g. `000000000000123456`; the user‑facing value is `123456`. Apply **`CONVERSION_EXIT_MATN1`** (output) on the SAP side, or strip leading zeros consistently. **The number used as a business key must be identical on every run** or NIMBUS will create duplicate orders/materials instead of upserting. NIMBUS's order key is `MD5(production_order | material_number)` — any drift in zero‑padding breaks idempotency.

### 4.2 DATS / TIMS strings, `00000000` null, and timezone
SAP dates are `DATS` (`CHAR(8)`, `YYYYMMDD`) and times are `TIMS` (`CHAR(6)`, `HHMMSS`) — **strings, not date types**. The "empty" sentinel **`00000000`** (and `000000` for time) must be converted to **NULL**, not parsed as year 0. Timestamps in SAP are in the **SAP system timezone**; NIMBUS/Postgres work in UTC‑ish app time. Decide and document the timezone conversion once (system tz → UTC) and apply it consistently to `GSTRP`/`GLTRP` and any datetime.

### 4.3 Decimals: trailing sign and locale
SAP numeric output can carry a **trailing minus** (`123.45-` means −123.45) and, depending on user/locale settings, a **comma decimal separator** (`1.234,56`). Normalize to a leading‑sign, period‑decimal numeric (`-123.45`, `1234.56`) on the SAP side. Quantities (`GAMNG`) and any `run_time` derived from routing standard values are affected.

### 4.4 Units of measure: internal vs ISO
UoM codes (`MEINS`, `GMEIN`) are stored **internally** (e.g. `ST`) and differ from the external/ISO code (e.g. `PCE`). Convert with **`CONVERSION_EXIT_CUNIT`** or read the mapping from **`T006`** so NIMBUS and downstream reporting use a consistent UoM. Agree on internal **or** ISO and stick to it.

### 4.5 Classification (COLOR / FORM_SIZE) — the performance trap
COLOR and FORM_SIZE are almost certainly **classification characteristics**, not columns on any order/material transparent table. They live in **`AUSP`** (characteristic values) keyed by `OBJEK`/`KLART`/`ATINN`, with characteristic metadata in **`CABN`** and value text in **`CAWN`**. Reading these per‑material/per‑order **one object at a time is a severe performance trap** (N+1 over a huge table). **Resolve server‑side in bulk** — a set‑based join in the extractor/DPC/FM for the whole result set in one pass — and pass NIMBUS the final string. **The class type (`KLART`) and the exact characteristic names (`ATNAM`) for COLOR and FORM_SIZE must be confirmed** (§6).

### 4.6 Authorizations
Grant **least privilege**: for RFC, **`S_RFC`** scoped to the specific function group only; for material/plant data, **`M_MATE_WRK`** (and related `M_MATE_*`) for the pilot plant(s); for OData, `S_SERVICE` plus the data auth objects the provider reads. Use the relevant **BAPI auth objects** where BAPIs are called. **Avoid `RFC_READ_TABLE`** entirely — it has a 512‑byte row‑width limit, cannot do joins, returns positionally fragile output, and is a known security/audit red flag. Build a purpose‑specific Z FM or OData entity instead.

### 4.7 Volume & performance
Always **scope the extract**: by **plant** (pilot WERKS), a **date window** (e.g. orders with basic dates in a rolling horizon), and **status** (§2.2). **Paginate** large pulls (`$top`/`$skiptoken` for OData; offset/cursor for RFC). Run as a **background job** (`SM36`), **never as a synchronous/dialog RFC** that can hit the `rdisp/max_wprun_time` work‑process timeout. Resolve classification in bulk (§4.5), not per row.

### 4.8 Landscape & clients
Build and test in **DEV**, validate in the **QA client**, then transport to **PRD** via **`STMS`**. Confirm the client number and logical system for each. NIMBUS's connection config (host, client, service path) is per‑environment and held in NIMBUS's `sap_sync_config` (non‑secret) + Key Vault (secret).

### 4.9 Delta watermarks
Strategy: **full load first, then changed‑since deltas.** Use `MARA‑LAEDA` (materials), `MARC`/`CRHD` change dates (master), and order change date for orders. NIMBUS persists the watermark **only on a successful run** (`sap_sync_config.last_watermark`) and runs **full‑then‑changed‑since**, so a failed run never advances the watermark and never loses rows. Because NIMBUS upserts idempotently on the business key, an **overlapping** delta window (re‑sending a few already‑seen rows) is harmless — prefer a slightly wide window over a missed row.

### 4.10 Idempotency (NIMBUS handles re‑runs)
NIMBUS upserts on the business key and **never overwrites** user scheduling edits. Re‑sending the same row, an overlapping window, or a full re‑load is **safe** and produces no duplicates. **SAP does not need exactly‑once delivery, perfect deltas, or de‑duplication.** This is the key relaxation that keeps the SAP build simple.

### 4.11 Monitoring & traceability
- **SAP side:** background jobs in **`SM37`**, tRFC/qRFC queues in **`SM58`**, application log in **`SLG1`** (write extract summaries — rows selected, filtered, errors — to a Z log object).
- **NIMBUS side:** every sync writes a `sap_sync_run` row (rows read/inserted/updated/failed, watermark before/after, status, error) plus structured JSON logs. Cross‑reference by run timestamp and object key.

---

## 5. Connectivity reality (Azure ↔ on‑prem SAP)

This is the gating infrastructure question and it determines the pattern choice.

- **Where things run:** ECC is on‑prem behind the corporate firewall. NIMBUS runs as an **Azure Container App** with, today, **external ingress and no VNet integration** — i.e. NIMBUS has no private route into the corporate network.
- **Pull patterns (OData, RFC) require inbound‑to‑SAP** from Azure. That means a **private network path** must be established first — one of: **site‑to‑site VPN**, **ExpressRoute**, or **SAP Cloud Connector** (for OData/HTTP), plus VNet integration for the Container App. None of this exists yet.
- **Push pattern (file‑drop) avoids inbound‑to‑SAP.** SAP writes a file outbound (to SFTP/Blob) or to a share NIMBUS can read. This is **firewall‑friendly** and needs no new inbound rule on SAP.

**Recommendation:** **Start with file‑drop precisely because it needs no inbound path into SAP.** In parallel, infra/Basis can stand up the private network path (VPN/ExpressRoute/Cloud Connector) + Container App VNet integration required for the **OData** target. Do not block the pilot on the network work — file‑drop lets the data mapping be proven while connectivity is being arranged.

---

## 6. Open questions for Basis & Security

A prioritized checklist. These are the decisions only the SAP/infra/PP teams can make; each blocks or shapes a specific part of the build.

- [ ] **Gateway/OData** — Is **SAP_GWFND** installed, activated, and **licensed**? Is `/IWFND/MAINT_SERVICE` available? (Decides OData feasibility.)
- [ ] **Communication user + role** — Can Security provision a **`SU01` Communications/System user** and a scoped **`PFCG` role**? Which **auth objects** are approved (`S_RFC`, `S_SERVICE`, `M_MATE_WRK`, BAPI objects)?
- [ ] **Custom ABAP** — Is custom **Z** development sanctioned, what is the **transport path** (DEV→QA→PRD), and is there **ABAP capacity/timeline**?
- [ ] **Network connectivity direction** — Will infra provide an **Azure→on‑prem private path** (VPN / ExpressRoute / SAP Cloud Connector + Container App VNet integration) for pull, **or** must SAP **push out** (file‑drop)? (Decides pattern; see §5.)
- [ ] **Subnetwork source** — What does NIMBUS's **"subnetwork"** map to in SAP (MRP controller area `T024D`, a plant grouping, or a Z field)? Or is it maintained manually in NIMBUS for now?
- [ ] **COLOR / FORM_SIZE classification** — What is the **class type (`KLART`)** and the exact **characteristic names (`ATNAM`)** for COLOR and FORM_SIZE? (Needed for §4.5 server‑side resolve.)
- [ ] **`firming_indicator`** — Which SAP field is the firming indicator (`FIXKZ` on the production order vs. `PLAF‑FIXKZ` for planned orders)?
- [ ] **`run_time` definition** — Is it a routing standard value (`AFVV` machine/processing time), a derived calc, or a Newell‑specific definition?
- [ ] **Order type scope** — **Discrete** production orders only, or **process orders (PP‑PI)** too? (Changes the header/operation tables and the `COOIS`/`COHV` selection.)
- [ ] **Pilot plant scope** — Which **WERKS** (plant code[s]) for the pilot?
- [ ] **Data volumes** — Material count, material‑plant count, and **orders/day** at pilot and full scale? (Sizes paging and cadence.)
- [ ] **Refresh cadence per object** — Desired frequency for orders vs. materials vs. plants/work centers (e.g. orders hourly, master nightly)?

---

## Appendix A — SAP table / transaction quick reference

| Object | Key tables | Display t‑code |
|---|---|---|
| Plant | `T001W` | `OX10`, `SE16N` |
| Work center (line) | `CRHD`, `CRTX` | `CR03` |
| Material | `MARA`, `MAKT` | `MM03` |
| Material/plant | `MARC`, `MKAL` | `MM03` (MRP views), `C223` |
| Production order header | `AFKO`, `AUFK` | `CO03`, `COOIS` |
| Production order item | `AFPO` | `CO03` |
| Order operations / work center | `AFVC`, `AFVV` → `CRHD` | `CO03` |
| Order status | `JEST`, `JSTO` (via `AUFK‑OBJNR`) | `BS22`, status tab in `CO03` |
| Classification (COLOR / FORM_SIZE) | `AUSP`, `CABN`, `CAWN` | `CL03`, `CT04` |
| UoM mapping | `T006` | `CUNI` |
| Build / register / test | — | `SEGW`, `/IWFND/MAINT_SERVICE`, `SICF`, `/IWFND/GW_CLIENT`, `SE37`, `SE80`, `SE11`, `SQ01`, `SQVI`, `SE38`, `SM36`, `SM37`, `SM58`, `SLG1`, `AL11`, `CG3Y`, `STMS`, `SU01`, `PFCG` |

## Appendix B — How the SAP feed lands in NIMBUS (for context)

The SAP team does not need to engineer idempotency; this is how NIMBUS consumes the feed:

- **Production orders** upsert into the `orders` table on `id = MD5(production_order | material_number)`. The upsert (`ON CONFLICT (id) DO UPDATE`) refreshes SAP‑sourced columns (material, dates, qty, color, form_size, firming_indicator, …) but **deliberately never overwrites** `scheduled_start`, `scheduled_end`, or `notes` — so a planner's manual schedule survives every re‑sync.
- **Master data** upserts through the same NIMBUS master‑data apply path used by the admin grid, keyed on each table's business key.
- Each run is recorded in `sap_sync_run` (rows read/inserted/updated/failed, watermark before/after, status). The watermark advances **only on success**.
- The scheduler that drives this is **disabled by default** and gated both globally and per object; connectors are **stubs** until the §6 items are resolved and a transport is wired live.

*End of SAP‑side build guide.*
