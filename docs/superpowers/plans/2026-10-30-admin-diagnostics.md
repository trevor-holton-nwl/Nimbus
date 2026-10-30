# Admin Diagnostics Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Token efficiency (read this first):** read only the files your task names; do not grep repo-wide; do not run the whole suite. Run the named test files and the named build/lint commands only. The orchestrator runs the gates (`npm run test`, `npm run check:legacy-surface`) between waves. Append one line per task to `docs/superpowers/plans/progress-admin-diagnostics.md`. Do not touch files outside your task's list without a ledger note. Write each file as soon as it is ready and commit after each task.

**Goal:** Turn the Admin Diagnostics sub-tab into one page of collapsible sections with a sticky jump rail, and make every Overview link land on the exact section (opened, scrolled, flashed, focused).

**Architecture:** One new pure module `diag-sections.mts` computes the 13 section severities/lines/figures from cached data using `THRESHOLDS` from `signals.mts`; `admin-ui.mts` renders rail + section headers from it and keeps the existing body renderers; deep links add `gotoSub(sub, {anchor})`, a pending-anchor reveal that waits for late-painting renderers, an anchor grammar (`id` or `pane:innerTab`) and anchors on every `nav.*` fix and detail link in `signals.mts`. No backend change.

**Tech Stack:** TypeScript (`.mts` compiled in place to `.mjs`, gitignored), node:test with hand-faked DOM, vanilla DOM, CSS tokens, five locale files.

**Spec:** `docs/superpowers/specs/2026-10-30-admin-diagnostics-design.md` (plan of record: `C:\Users\PJ29587\.claude\plans\i-want-to-re-do-kind-falcon.md`). Base `main` 00d512c; worktree `.claude/worktrees/admin-diagnostics`, branch `feature/admin-diagnostics-rail`.

## Work packages

| Wave | Model | Task | Files owned | Depends on |
|---|---|---|---|---|
| W1 | Sonnet (Haiku may add locale rows from the table) | T1, T2 | `frontend/admin-ops/diag-sections.mts`, `.gitignore`, `tests/modules/admin-ops/diag-sections.test.mjs`, `frontend/locales/{en,de,es,fr,pt}.js` | none |
| W2 | Sonnet | T3 | `frontend/index.html`, `frontend/admin-ops/admin-ui.mts`, `frontend/styles.css` | W1 |
| W3 | Sonnet | T4 | `admin-ui.mts`, `signals.mts`, `jobs-pane.mts`, `frontend/integration/sap-interface-ui.mts`, tests | W2 |
| W4 | Sonnet design pass (Chrome), then Sonnet apply | T5 | CSS/markup/locales only per punch list | W3 |
| Final | Sonnet | T6 | `frontend/admin-ops/CLAUDE.md`, root `CLAUDE.md` | W4 |

Never Fable or Opus for code or for the design pass: the owner approved the plan with "have sonnet do everything. Go!". Every wave: one Sonnet implementer, then one fresh Sonnet reviewer given the diff and this plan, not the implementer's summary. Merge to local `main` with `--no-ff`; nothing pushed or deployed without the owner's say.

## Global Constraints

- All new text via `data-i18n` or `Util.t()`; keys in all five locale files with identical `{{placeholders}}`; fr apostrophes escaped as `\'`.
- Tokens only; hairline borders; no side stripes; warn text `--warn-text`; dark mode works; server strings via `textContent`.
- No inline handlers (`npm run check:legacy-surface`). Delegated listeners only.
- Thresholds only from `THRESHOLDS` in `signals.mts`: pool 60/85 + waiting; `longQueryWarnS` 30; `slowQueryWarnMs` 100 / `slowQueryErrMs` 500; `heapWarnPct` 80; `errRateErrPerMin` 10; `dbStatsStaleMs` 10 min; tables any `needs_vacuum` warn; locks any wait err; indexes unused is info only; sequences > 80 warn, > 95 err; thread P95 >= 16 ms warn, >= 50 ms err.
- Keep ids: `admin-diagnostics-pane`, `admin-pipeline`, `admin-pipeline-detail`, `admin-backend-warnings`, `admin-bwarn-count`, `admin-db-deep`, `admin-perf-tbody`, `admin-thread-clear`, `admin-diag-storage`, `admin-diag-export`, `admin-diag-reset`, `admin-diag-refresh`. Remove `admin-pipeline-refresh`, `admin-db-deep-refresh`.
- `gotoSub(sub)` keeps its name; the two `app.js` callers pass no opts.
- Caps: tables 10, indexes 15, backend warnings 20, slow queries 10 (`_capList`).
- Scroll container is `.admin-scroll` (`styles.css:2999`), not the window; rail is sticky like `.ulog-rail` (`styles.css:6414`); sections carry `scroll-margin-top:12px`.
- Compiled `.mjs` twins are gitignored: add `frontend/admin-ops/diag-sections.mjs` to `.gitignore`.
- No backend change, no migration, no pytest. Business terms only in docs; no emojis in repo text.
- Commit trailer on every commit: blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Build after any `.mts` edit: `npm run build`. Single JS test: `node --test <file>`.

## Review Focus

Five inputs the plan does not otherwise pin and that most likely bite. The reviewer checks each by reading the code path; the named task owns the test.

1. **Anchor id not in the DOM yet** (Diagnostics opened by a link before `/diagnostics/db` returns, or Jobs/SAP before their async render). `_revealPendingAnchor` must be a no-op and keep the pending anchor, then be consumed by the next paint, never throw, never reveal a stale id after a new `_setSub`. Test: T4 `admin-ui.test.mjs` ("not-yet-rendered id consumed by next paint, not before"; "new _setSub clears stale anchor").
2. **`/diagnostics/db` returns 403 for a non-admin** (or fails). All `db*` sections must be `info` with `diag.line_unavailable` / `sig.admin_only`, the rail lights must be neutral, and no section may open as if healthy or flag err. Test: T1 `diag-sections.test.mjs` (null and 403 inputs).
3. **Repaint while a section is open** (30 s refresh, Refresh button). `_diagOpen` must win over the severity rule; a section the user closed while warn stays closed, one they opened while ok stays open; header repaint must not replace the `<details>` element itself. Test: T4 `admin-ui.test.mjs` (`_diagOpen` wins on repaint) plus T3 reviewer reads `mkSection` for element reuse.
4. **`prefers-reduced-motion`.** No animation, outline-only highlight, `scrollIntoView` `behavior:'auto'`, and the `.is-target` class still removed (fallback timer, since `animationend` never fires). Test: T4 `admin-ui.test.mjs` (stubbed `matchMedia` returns reduce; assert `behavior:'auto'` and class cleared by timer).
5. **Rail at 220 px with fr/de labels** ("Chargement des donnees", "Datenbankverbindungen" plus a mono figure). Labels must truncate with ellipsis and `title`, figure never wraps under the dot; chip row at <= 1000 px. Test: T2 locale-length guard (each `diag.short_*` and rail title string <= 24 characters in all five locales) and T5 Chrome measurement at 220 px.

---

## Task 1: Pure module `diag-sections.mts`

**Files:**
- Create: `frontend/admin-ops/diag-sections.mts`
- Create: `tests/modules/admin-ops/diag-sections.test.mjs`
- Modify: `.gitignore` (add `frontend/admin-ops/diag-sections.mjs`)

**Interfaces:**

```ts
import { THRESHOLDS, type Severity } from './signals.mjs';

export type DiagSectionId = 'client'|'pipe'|'bwarn'|'db'|'db-pool'|'db-server'|'db-tables'|'db-conn'|'db-locks'|'db-idx'|'db-slow'|'db-seq'|'thread';
export interface DiagSection {
  id: DiagSectionId; severity: Severity; titleKey: string; count?: number;
  lineKey: string; lineArgs: Record<string, unknown>;   // one-line state in the header
  shortKey: string; shortArgs: Record<string, unknown>; // the rail's mono figure
}
export interface DiagInputs {
  client: ClientStats | null; deep: DeepData | null; dbDeep: DbDeep | null;
  perf: PerfSample[]; dbStatsAt: number | null; now: number;
}
export function buildDiagSections(inputs: DiagInputs, thresholds = THRESHOLDS): DiagSection[]; // always 13, in page order
export function defaultOpen(sec: DiagSection, pendingAnchor: string | null): boolean;
export const ANCHOR_IDS: Record<DiagSectionId, string>; // 'db-conn' -> 'diag-db-conn'
```

`ClientStats`, `DeepData`, `DbDeep`, `PerfSample` are local type copies shaped like the payloads `admin-ui.mts` already reads (copy, do not import from `admin-ui.mts`). `Severity` and `THRESHOLDS` are imported, never re-declared. Page order: client, pipe, bwarn, db, db-pool, db-server, db-tables, db-conn, db-locks, db-idx, db-slow, db-seq, thread. `titleKey` reuses existing keys (`ui.diag_client_title`, `ui.data_pipeline`, `ui.backend_warnings`, `ui.db_deep_dive`, `thread.title`, and the eight existing `mkSection` title keys in `en.js`).

`defaultOpen`: true when severity is `warn` or `err`, or when `pendingAnchor` equals `ANCHOR_IDS[sec.id]`, or when `sec.id === 'db'` and `pendingAnchor` starts with `diag-db-`; otherwise false.

- [ ] **Step 1: Write the failing test** `tests/modules/admin-ops/diag-sections.test.mjs`. Cases (use a `base()` inputs factory with healthy values):
  - returns exactly 13 sections in page order; `ANCHOR_IDS['db-conn'] === 'diag-db-conn'`.
  - ladders: pool 59/60/85 % (ok/warn/err) and waiting > 0 warns; long query 29/30 s; slow 99/100/500 ms; heap 79/80 %; browser errors/min 0/1/10 (ok/warn/err); any `needs_vacuum` warn; any lock wait err; unused indexes info (never warn); sequences 80/81/95/96 %; thread P95 15/16/50 ms; stats age 9/10 min on the `db` line (warn at 10).
  - `dbDeep: null` gives `info` and `lineKey 'diag.line_unavailable'` for `db` and every `db-*`; a 403 input (`dbDeep: { forbidden: true }`) gives `sig.admin_only`.
  - `defaultOpen`: warn/err true, ok false, pending anchor opens its section and the `db` parent.
  - every `lineKey`, `shortKey` and `titleKey` emitted exists in `frontend/locales/en.js`, and the `{{placeholders}}` of each match across all five locales (pattern: `tests/modules/admin-ops/overview-locales.test.mjs`).
  - length guard: every `diag.short_*` string and every rail title string is <= 24 characters in all five locales.
- [ ] **Step 2: Run and confirm it fails** (`node --test tests/modules/admin-ops/diag-sections.test.mjs`; module missing).
- [ ] **Step 3: Implement** `diag-sections.mts` per the interfaces. Severity per section: use `THRESHOLDS` fields only; indexes cap at `info`.
- [ ] **Step 4: Build and run**: `npm run build`, then the test file. Locale assertions stay red until Task 2; implement T2 immediately after, then re-run.
- [ ] **Step 5: Commit** `feat(admin-ops): diag-sections pure module`.

## Task 2: Locale keys in all five locales

**Files:** Modify `frontend/locales/{en,de,es,fr,pt}.js`.

**Interfaces:** the keys below, identical `{{placeholders}}` across locales. Existing keys reused, not re-added: `btn.vacuum_analyze`, `thread.col_p50`, `thread.col_p95`, the section title keys. Remove `ui.db_deep_hint`, `ui.pipeline_hint`, `ui.bwarn_hint` only after Task 3 confirms they are unreferenced (do the removal in T3 Step 7).

| Key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `diag.rail_sections` | Sections | Abschnitte | Secciones | Sections | Secoes |
| `diag.stats_age` | DB stats {{db}} · pipeline {{pipe}} | DB-Statistik {{db}} · Pipeline {{pipe}} | Estadisticas BD {{db}} · pipeline {{pipe}} | Stats BD {{db}} · pipeline {{pipe}} | Estatisticas BD {{db}} · pipeline {{pipe}} |
| `diag.line_client` | {{build}} · heap {{heap}} % · autosave {{autosave}} · {{errs}} errors/min | {{build}} · Heap {{heap}} % · Autosave {{autosave}} · {{errs}} Fehler/Min | {{build}} · heap {{heap}} % · autoguardado {{autosave}} · {{errs}} errores/min | {{build}} · heap {{heap}} % · sauvegarde auto {{autosave}} · {{errs}} erreurs/min | {{build}} · heap {{heap}} % · autosave {{autosave}} · {{errs}} erros/min |
| `diag.line_pipe` | {{loaded}} loaded > {{plant}} plant > {{rendered}} rendered · {{misses}} misses | {{loaded}} geladen > {{plant}} Werk > {{rendered}} gerendert · {{misses}} Fehltreffer | {{loaded}} cargadas > {{plant}} planta > {{rendered}} mostradas · {{misses}} fallos | {{loaded}} chargees > {{plant}} usine > {{rendered}} affichees · {{misses}} manques | {{loaded}} carregadas > {{plant}} planta > {{rendered}} exibidas · {{misses}} falhas |
| `diag.line_bwarn` | From the last data load | Vom letzten Datenladen | De la ultima carga de datos | Du dernier chargement de donnees | Do ultimo carregamento de dados |
| `diag.line_db` | pool {{pool}} % · {{vacuum}} tables need vacuum · {{slow}} over 30 s · stats {{age}} | Pool {{pool}} % · {{vacuum}} Tabellen brauchen Vacuum · {{slow}} ueber 30 s · Statistik {{age}} | pool {{pool}} % · {{vacuum}} tablas necesitan vacuum · {{slow}} sobre 30 s · estadisticas {{age}} | pool {{pool}} % · {{vacuum}} tables a nettoyer · {{slow}} au-dela de 30 s · stats {{age}} | pool {{pool}} % · {{vacuum}} tabelas precisam de vacuum · {{slow}} acima de 30 s · estatisticas {{age}} |
| `diag.line_pool` | {{used}} of {{max}} in use · {{waiting}} waiting | {{used}} von {{max}} belegt · {{waiting}} wartend | {{used}} de {{max}} en uso · {{waiting}} en espera | {{used}} sur {{max}} utilisees · {{waiting}} en attente | {{used}} de {{max}} em uso · {{waiting}} aguardando |
| `diag.line_server` | {{version}} · up {{uptime}} · ping {{ping}} ms | {{version}} · Laufzeit {{uptime}} · Ping {{ping}} ms | {{version}} · activo {{uptime}} · ping {{ping}} ms | {{version}} · actif {{uptime}} · ping {{ping}} ms | {{version}} · ativo {{uptime}} · ping {{ping}} ms |
| `diag.line_tables` | {{n}} tables · {{vacuum}} need vacuum | {{n}} Tabellen · {{vacuum}} brauchen Vacuum | {{n}} tablas · {{vacuum}} necesitan vacuum | {{n}} tables · {{vacuum}} a nettoyer | {{n}} tabelas · {{vacuum}} precisam de vacuum |
| `diag.line_conn` | {{n}} connections · longest {{longest}} s | {{n}} Verbindungen · laengste {{longest}} s | {{n}} conexiones · la mas larga {{longest}} s | {{n}} connexions · la plus longue {{longest}} s | {{n}} conexoes · a mais longa {{longest}} s |
| `diag.line_locks_ok` | No lock waits | Keine Sperrwartezeiten | Sin esperas de bloqueo | Aucune attente de verrou | Sem esperas de bloqueio |
| `diag.line_locks_n` | {{n}} waiting on locks | {{n}} warten auf Sperren | {{n}} esperando bloqueos | {{n}} en attente de verrous | {{n}} aguardando bloqueios |
| `diag.line_idx` | {{n}} unused indexes (advice) | {{n}} ungenutzte Indizes (Hinweis) | {{n}} indices sin uso (consejo) | {{n}} index inutilises (conseil) | {{n}} indices sem uso (dica) |
| `diag.line_slow` | Slowest {{ms}} ms · {{n}} over 100 ms | Langsamste {{ms}} ms · {{n}} ueber 100 ms | Mas lenta {{ms}} ms · {{n}} sobre 100 ms | Plus lente {{ms}} ms · {{n}} au-dela de 100 ms | Mais lenta {{ms}} ms · {{n}} acima de 100 ms |
| `diag.line_slow_ok` | No slow queries | Keine langsamen Abfragen | Sin consultas lentas | Aucune requete lente | Sem consultas lentas |
| `diag.line_seq` | Highest {{pct}} % used | Hoechste {{pct}} % belegt | Maxima {{pct}} % usada | Maximum {{pct}} % utilise | Maxima {{pct}} % usada |
| `diag.line_thread` | P95 {{p95}} ms · slowest {{op}} {{ms}} ms | P95 {{p95}} ms · langsamste {{op}} {{ms}} ms | P95 {{p95}} ms · mas lenta {{op}} {{ms}} ms | P95 {{p95}} ms · plus lente {{op}} {{ms}} ms | P95 {{p95}} ms · mais lenta {{op}} {{ms}} ms |
| `diag.line_thread_empty` | No samples yet | Noch keine Messwerte | Sin muestras aun | Aucun echantillon | Sem amostras ainda |
| `diag.line_unavailable` | Not available | Nicht verfuegbar | No disponible | Indisponible | Indisponivel |
| `diag.short_client` | {{heap}} % heap | {{heap}} % Heap | {{heap}} % heap | {{heap}} % heap | {{heap}} % heap |
| `diag.short_pipe` | {{misses}} misses | {{misses}} Fehltreffer | {{misses}} fallos | {{misses}} manques | {{misses}} falhas |
| `diag.short_bwarn` | {{n}} warnings | {{n}} Warnungen | {{n}} avisos | {{n}} alertes | {{n}} avisos |
| `diag.short_db` | pool {{pct}} % | Pool {{pct}} % | pool {{pct}} % | pool {{pct}} % | pool {{pct}} % |
| `diag.short_pool` | {{used}} / {{max}} · {{pct}} % | {{used}} / {{max}} · {{pct}} % | {{used}} / {{max}} · {{pct}} % | {{used}} / {{max}} · {{pct}} % | {{used}} / {{max}} · {{pct}} % |
| `diag.short_server` | ping {{ping}} ms | Ping {{ping}} ms | ping {{ping}} ms | ping {{ping}} ms | ping {{ping}} ms |
| `diag.short_tables` | {{vacuum}} to vacuum | {{vacuum}} Vacuum | {{vacuum}} a limpiar | {{vacuum}} a nettoyer | {{vacuum}} a limpar |
| `diag.short_conn` | {{n}} open | {{n}} offen | {{n}} abiertas | {{n}} ouvertes | {{n}} abertas |
| `diag.short_locks` | {{n}} waiting | {{n}} wartend | {{n}} en espera | {{n}} en attente | {{n}} aguardando |
| `diag.short_idx` | {{n}} unused | {{n}} ungenutzt | {{n}} sin uso | {{n}} inutilises | {{n}} sem uso |
| `diag.short_slow` | {{ms}} ms | {{ms}} ms | {{ms}} ms | {{ms}} ms | {{ms}} ms |
| `diag.short_seq` | {{pct}} % | {{pct}} % | {{pct}} % | {{pct}} % | {{pct}} % |
| `diag.short_thread` | P95 {{p95}} ms | P95 {{p95}} ms | P95 {{p95}} ms | P95 {{p95}} ms | P95 {{p95}} ms |
| `diag.see_bwarn` | {{n}} warnings from this load · Backend warnings › | {{n}} Warnungen aus diesem Laden · Backend-Warnungen › | {{n}} avisos de esta carga · Avisos del backend › | {{n}} alertes de ce chargement · Alertes backend › | {{n}} avisos desta carga · Avisos do backend › |
| `diag.lock_blocking` | BLOCKING | BLOCKIEREND | BLOQUEANDO | BLOQUANT | BLOQUEANDO |
| `diag.lock_blocked` | BLOCKED | BLOCKIERT | BLOQUEADO | BLOQUE | BLOQUEADO |
| `diag.calls` | calls | Aufrufe | llamadas | appels | chamadas |
| `btn.analyze` | ANALYZE | ANALYZE | ANALYZE | ANALYZE | ANALYZE |
| `btn.export_bundle` | Export bundle | Paket exportieren | Exportar paquete | Exporter le paquet | Exportar pacote |
| `aria.help` | Help | Hilfe | Ayuda | Aide | Ajuda |
| `ui.none` | none | keine | ninguno | aucun | nenhum |

Spelling rule: write the strings with their proper accents in the locale files (the table above is ASCII-folded to keep this doc portable; use "Secoes" as "Seções", "ueber" as "über", "verfuegbar" as "verfügbar", "laengste" as "längste", "Hoechste" as "Höchste", "Estadisticas" as "Estadísticas", "indices" as "índices", "chargees" as "chargées", "utilises" as "utilisés", "echantillon" as "échantillon", "BLOQUE" as "BLOQUÉ", "a nettoyer" as "à nettoyer", "usine"/"affichees" as "affichées", "au-dela" as "au-delà", "Aufrufe" unchanged). fr strings containing apostrophes are written `\'` as `fr.js` does. If a key already exists in a locale, do not duplicate it; keep the existing value.

- [ ] **Step 1:** Re-run `node --test tests/modules/admin-ops/diag-sections.test.mjs tests/modules/locale-completeness.test.mjs tests/js/locale-keys.test.js`; confirm missing-key failures.
- [ ] **Step 2:** Add the rows to all five files (append beside the other `diag.*` keys, same quoting style as the file).
- [ ] **Step 3:** Re-run the same three tests; green, including the <= 24-character guard (shorten a `diag.short_*` only if the guard trips, keeping placeholders).
- [ ] **Step 4:** `npm run lint` scoped to `frontend/locales` (eslint on the five files).
- [ ] **Step 5: Commit** `feat(i18n): diagnostics rail keys x5`.

## Task 3: Diagnostics restructure

**Files:** Modify `frontend/index.html` (Diagnostics pane, lines ~1984-2056), `frontend/admin-ops/admin-ui.mts`, `frontend/styles.css` (new rules; delete `.admin-db-summary`, `.admin-db-stat-tile*` and the unmatched parts of `.admin-db-section*` at ~5964-5995), `tests/modules/admin-ops/admin-ui.test.mjs`.

**Interfaces (all in `admin-ui.mts`, module-private unless a test seam is needed):**
- `_diagOpen: Map<string, boolean>`; one delegated capture-phase `toggle` listener on `#admin-diag-pane` records `el.id -> el.open` for `details.diag-sec[id]`.
- `mkSection(id, titleKey, count, severity, lineKey, lineArgs, bodyHTML, actionsHTML?)`: consults `_diagOpen` first, `defaultOpen` second; reuses an existing element on repaint (update header and body in place, do not replace the `<details>`).
- `_renderDiagRail(sections)`, `_paintSectionHead(id, sec)`, `_renderDiagnosticsPane()` (rebuilt per the plan: `buildDiagSections(inputs)` from `_deepData`, `_ovSlow.dbDeep`/`_dbDeep`, `Persistence.stats()`, `ErrorLog` rates, `PerfMonitor` samples).

- [ ] **Step 1: Write failing tests** in `admin-ui.test.mjs`: every `getElementById('admin-...')` in `admin-ui.mts` still resolves against `index.html` (existing id-vs-HTML check; update its allowlist: drop the two removed ids); head Refresh re-runs `_renderDiagnosticsPane` with force; `_diagOpen` wins over the severity rule on repaint (closed-while-warn stays closed; opened-while-ok stays open); the pane renders 13 section headers.
- [ ] **Step 2: Run** `node --test tests/modules/admin-ops/admin-ui.test.mjs`; confirm failures.
- [ ] **Step 3: Markup.** Replace the five cards with `.diag-head`, `.diag-layout`, `nav.diag-rail`, `.diag-main` and the section skeleton per spec 6.1, keeping the ids in Global Constraints. Add `thread.col_p50`/`thread.col_p95` `data-i18n` on the P50/P95 headers. Remove `admin-pipeline-refresh` and `admin-db-deep-refresh` and their `init()` listeners; wire `admin-diag-refresh` to force-repaint everything; add the page-head `#admin-diag-ts` and `diag.stats_age` paint.
- [ ] **Step 4: Rail + headers + scroll-spy.** Implement `_renderDiagRail` (light + title + `.diag-rail-short`, `title` attribute on truncated labels, Database caption with eight indented sub-links), `_paintSectionHead`, rail click handling (`preventDefault`, go through `_revealAnchor` once T4 lands; until then open + scroll), one `IntersectionObserver` (`rootMargin: '-80px 0px -60% 0px'`) over `.diag-sec[id]` created on first `_setSub('diagnostics')` and disconnected on leaving.
- [ ] **Step 5: Body renderers.** `_renderDbDeep`: delete `_dbSummaryStrip` (ui:2257-2321) and `.admin-db-fetched`; `mkSection` ids per spec; pool severity via THRESHOLDS; `_dbSlowQueryBars` through `_capList(..., 10)`. `_pipelineDetailEmitted`: replace `_warningList` with the single `diag.see_bwarn` line whose button carries `data-anchor="diag-bwarn"`; delete `_warningList` if unused. Each body renderer, on completion, recomputes its own header via `_paintSectionHead`. Key/value grid to two columns via CSS `columns:2` at >= 860 px.
- [ ] **Step 6: i18n sweep.** `VACUUM ANALYZE`/`ANALYZE` to `btn.vacuum_analyze`/`btn.analyze`; `BLOCKING`/`BLOCKED` to `diag.lock_blocking`/`diag.lock_blocked`; `calls` to `diag.calls`; `aria-label="Help"` to `aria.help`; `<em>none</em>` to `ui.none` (all via `Util.t()`).
- [ ] **Step 7: CSS + cleanup.** New `.diag-head`, `.diag-layout`, `.diag-rail*`, `.diag-sec*`, `.diag-sub*`, `.is-target`, `@keyframes diag-flash`, `.diag-kv2`; sticky rail like `.ulog-rail`; `scroll-margin-top:12px`; `<= 1000px` chip row; `<= 760px` header line and actions under the title; `prefers-reduced-motion` outline only. Delete the dead rules. Remove `ui.db_deep_hint`, `ui.pipeline_hint`, `ui.bwarn_hint` from all five locales if grep (scoped to `frontend/`) finds no reference.
- [ ] **Step 8: Build and run**: `npm run build`, `npm run typecheck`, `node --test tests/modules/admin-ops/*.test.mjs`, `npm run check:legacy-surface`, `npm run check:static-assets`. Green.
- [ ] **Step 9: Commit** `feat(admin-ops): diagnostics jump-rail sections`.

## Task 4: Exact-section deep links

**Files:** Modify `frontend/admin-ops/admin-ui.mts`, `frontend/admin-ops/signals.mts`, `frontend/admin-ops/jobs-pane.mts`, `frontend/integration/sap-interface-ui.mts`, `tests/modules/admin-ops/admin-ui.test.mjs`, `tests/modules/admin-ops/signals.test.mjs`, plus the existing `jobs-pane` / `sap-interface-ui` test files under `tests/modules/` (add minimal ones if none exist).

**Interfaces:**

```ts
// admin-ui.mts
function gotoSub(sub: string, opts?: { anchor?: string }): void;   // name and arity pinned
function _setSub(sub: string, anchor?: string): void;              // _pendingAnchor = anchor ?? null, render, then _revealPendingAnchor()
function _revealPendingAnchor(): void;   // no-op if _pendingAnchor null or element absent (pending kept); else _revealAnchor then clear
function _revealAnchor(el: HTMLElement): void; // open el + <details> ancestors, scrollIntoView, .is-target, focus summary preventScroll

// signals.mts
interface DetailTable { /* existing */ linkSub?: string; linkAnchor?: string; }
// Fix.args.anchor?: string on every nav.* fix

// jobs-pane.mts export
showTab(tab: 'jobs'|'runs'|'upcoming'|'templates'): void;
// sap-interface-ui.mts export
showTab(tab: string, objectKey = 'orders'): void;  // sets _selected/_tab and re-renders
```

`_revealAnchor`: `scrollIntoView({ block:'start', behavior: reduced ? 'auto' : 'smooth' })` where `reduced` is `matchMedia('(prefers-reduced-motion: reduce)').matches` (guard for missing `matchMedia`); remove `.is-target` on `animationend` with a 2.6 s fallback timer; focus the `<summary>` (or the element with `tabindex="-1"`) with `preventScroll:true`. Anchor grammar and Jobs/SAP resolution per spec 6.7; `openRun` keeps `gotoSub('jobs')`, `await render()`, `openRun(id)`.

- [ ] **Step 1: Write failing tests.**
  - `admin-ui.test.mjs` (extend `fakeNode` with `tagName`, `parentElement`, `open`, `focus()`, `scrollIntoView()`; custom `getElementById`/`querySelector`): `gotoSub('diagnostics', { anchor })` sets the pending anchor and calls `_setSub` once; `_revealAnchor` opens the element and its `<details>` ancestors, adds `.is-target`, focuses the summary; a pending anchor for a not-yet-rendered id is consumed by the next paint and not before; a new `_setSub` clears a stale pending anchor; reduced motion gives `behavior:'auto'` and `.is-target` cleared by the fallback timer; leaving Diagnostics disconnects the observer; `logs.open` with `level:'error'` sets level error and honours `source`; `jobs:runs` calls `JobsAdmin.showTab('runs')` after `render()` resolves; the `sap:staging` form calls the SAP `showTab` and falls back to `#sap-tabbody`.
  - `signals.test.mjs`: every `nav.*` fix and every `DetailTable.linkSub` carries the anchor from the map in spec 6.6; Data load emits the new secondary `nav.diagnostics` fix and detail link with `diag-pipe`; `logs.open` fixes carry `level`.
  - jobs/SAP tests: `showTab` is on the exported object and switches the inner view.
- [ ] **Step 2: Run** the test files; confirm failures.
- [ ] **Step 3: `admin-ui.mts`.** Implement `gotoSub` opts, `_pendingAnchor`, `_revealPendingAnchor`, `_revealAnchor`; call `_revealPendingAnchor()` after `_renderDbDeep` (after `/diagnostics/db` returns), `_renderPipeline`, `_renderDiagnosticsPane`; Interface and Order Maintenance reveal immediately; `onOvClick` forwards `data-anchor`; fix dispatch `nav.jobs|diagnostics|interface|order_maintenance` uses `gotoSub(sub, { anchor: fix.args?.anchor })`; `logs.open` uses `fix.args.level ?? 'warn'` and `fix.args.source ?? 'backend'`; rail clicks now go through `_revealAnchor`; the Emitted-step `data-anchor="diag-bwarn"` button uses the same path with no sub-tab change.
- [ ] **Step 4: `jobs-pane.mts` and `sap-interface-ui.mts`.** Add the public `showTab` on each export (Jobs beside `openRun`, using `_setTab`; SAP setting `_selected`/`_tab` per `sap-interface-ui.mts:1776-1780`, then re-render). Reveal targets: `#jobs-view-<tab>`; `#sap-stage-batches`, falling back to `#sap-tabbody`. If the SAP pane is not yet rendered for the plant, keep the pending anchor until its render completes.
- [ ] **Step 5: `signals.mts`.** Add `DetailTable.linkAnchor`; put `Fix.args.anchor` on every `nav.*` fix and the anchors on detail links per spec 6.6; add the Data load secondary `nav.diagnostics` fix and detail link; Browser rows and links `diag-client`; pass `level` on `logs.open` fixes (`error` for error emitters).
- [ ] **Step 6: Build and run**: `npm run build`, `npm run typecheck`, `node --test tests/modules/admin-ops/*.test.mjs` plus the jobs/SAP test files, `npm run check:legacy-surface`, `npm run check:static-assets`. Green.
- [ ] **Step 7: Commit** `feat(admin-ops): exact-section deep links from Overview`.

## Task 5: Sonnet design pass and apply (W4)

**Files:** CSS, markup and locale strings only, per the punch list.

- [ ] **Step 1:** One Sonnet agent runs the app (`uvicorn brain:api --port 8000` against the local test DB per the orchestrator's env, env vars on the process, never a worktree `.env`) and reviews Diagnostics in Chrome against the mockup (https://claude.ai/artifact/GFPmDv2a5yQRN2G7PuFMhD), `DESIGN.md` and the fit list: rail labels in fr/de at 220 px, header lines at 760/1000/1440 px, chip row at 900 px, dark mode, flash visibility, reduced motion, head timestamp plus two buttons at 375 px. It returns a numbered punch list only (no edits).
- [ ] **Step 2:** A second Sonnet agent applies the punch list; ledger lines per fix.
- [ ] **Step 3:** Re-run `npm run build`, `npm run typecheck`, `node --test tests/modules/admin-ops/*.test.mjs`, locale tests, legacy-surface, static-assets.
- [ ] **Step 4:** Fresh Sonnet reviewer on the whole branch diff against this plan and the five Review Focus items. Commit fixes as `fix(admin-ops): diagnostics review fixes`.

## Task 6: Docs

**Files:** Modify `frontend/admin-ops/CLAUDE.md`, root `CLAUDE.md`.

- [ ] **Step 1:** `frontend/admin-ops/CLAUDE.md` "Admin sub-tabs" section: Diagnostics sections and ids (rail, 13 sections, `diag-db-*` sub-sections), the anchor contract (`gotoSub(sub, {anchor})`, `_pendingAnchor`/`_revealAnchor`, grammar `id` or `pane:innerTab`, `JobsAdmin.showTab`, SAP `showTab`), thresholds source (`THRESHOLDS` in `signals.mts`, never re-declared), `diag-sections.mts` as the pure module, open-state memory (`_diagOpen`).
- [ ] **Step 2:** Root `CLAUDE.md` Admin Ops row: add "Diagnostics jump-rail sections and exact-section deep links from Overview (2026-10-30)".
- [ ] **Step 3:** Fill the spec's Appendix B (Learnings). Commit `docs(admin-ops): diagnostics rail contract`.
