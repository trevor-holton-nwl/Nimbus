# Setup Matrix — Tab Reformulation

**Status:** proposal, **partially superseded 2026-08-14** (same day, later commit `8da20d7`). Originally
written 2026-08-14 as a UI reformulation proposal (§9's four-band layout, with Activation Readiness relocated
into a modal behind a status chip). Before this proposal was picked up for implementation, a separate,
narrower request replaced Activation Readiness outright: the 18-control section (§2's last row) is gone,
along with `plants.setup_policy_config`/`setup_release_evidence` and their four `/setup/{plant}/policy` +
`/setup/{plant}/release-evidence` endpoints. In their place is a single checkbox — "Include setup times in
optimizer" — in the tab header, bound directly to the pre-existing `setup_definition.active` column, with no
modal and no verification-gate UI. See **§15** for the full account of what changed and what in this document
is now stale as a result. Everything **not** about Activation Readiness — the carryover duplication (§3), the
noise/alignment findings (§4-5), the scale problem (§6), the cell-semantics gap (§7), and the proposed grid
redesign (§9 bands B-D) — is untouched and still an accurate, unimplemented proposal.
**Scope:** the **Setup Matrix** inner tab only (Master Data › Plant › System Settings › Setup Matrix),
rendered by `SetupAdmin` in `web/plant-and-administration.mts:127-1129`.
**Supersedes:** the IA half of `docs/setup_matrix_ui_redesign.md` (implemented earlier the same day). That
pass fixed real bugs — the `btn.copy` literal, the misleading "REFERENCE DATA" eyebrow, the flat 11-zone
stack — and introduced the from×to grid. This document says what it did **not** fix, and proposes the
structural change it explicitly deferred.
**Not in scope:** backend, API, schema, or permission logic. Every change below uses endpoints that already
exist.

---

## 1. Context

The tab was reorganized once already today: eleven flat zones became four labeled groups, and the CSV-only
matrix write path became an editable from-state × to-state grid. The result is better organized but not
lighter — the same content is still all on screen at once, now with an extra heading tier wrapped around it.
Reviewing the shipped result surfaced three complaints, all of which hold up against the code:

1. **It duplicates its neighbours.** Not settings-for-settings, but *editors over the same registry*, in two
   different vocabularies — §3.
2. **There is too much going on**, and too much of it is prose — §4. The tab states "setup is not live"
   **ten times**, in three identically-styled amber banners plus seven paragraphs.
3. **Text isn't aligned properly**, specifically *"No setup signature has been defined for this plant."* That
   string renders **twice on one screen, in two different styles**, and neither uses the app's existing
   empty-state component — §5.

Underneath those are two problems nobody has hit yet: the grid builds an **uncapped cartesian product** with
one live `<input>` per cell (§6), and the cell rendering **cannot express three of the five states** the
resolution model defines (§7).

### 1.1 An important correction to the premise

The tab's eyebrow reads `STAGE 0 · NOT YET LIVE`, and the four untracked design docs in `docs/`
(`changeover_matrix.md`, `changeover_matrix_stage_1.md`, `Setup_teardown_bars.md`, `setup_debate.md`) all
carry status headers saying the feature is not implemented. **That is stale.** Git log shows Stage 0, Stage 1
*and* Stage 2 shipped across ~50 commits: `setup_data.py` (40 KB), `web/setup-domain.mts`,
`web/setup-scheduler.mts` (**142 KB**), four tables in `schema.sql`, setup-aware placement, due-date search,
capacity diagnostics, derived Gantt bars, drag reflow, and preview explanations — with main-thread and worker
parity, and five pytest suites.

What is off is the **authorization**, not the machinery. `plants.setup_policy_config` defaults all three
modes to `false`, and the server refuses to enable any of them until seven flags in
`plants.setup_release_evidence` are recorded. Per `changeover_matrix_stage_2.md`'s own release decision, the
outstanding gates are external: local-DB round-trip, browser/perf UAT, representative-plant replay, and
scheduling-owner approval.

Two consequences for this redesign:

- **Activation Readiness is a real gate, not vestigial scaffolding.** It should be relocated and quieted, not
  deleted. But it is a *one-time, per-plant, engineering* action, and 47% of the tab's controls is the wrong
  price for it (§2).
- **The entire setup UI has been built but never seen in a browser.** `setup_matrix_ui_redesign.md` §10 says
  so explicitly, and Stage 0/1/2 carry the same caveat. Visual rendering, keyboard interaction, and dark-mode
  contrast are all unverified. That is the single biggest opportunity here — and the reason §12's manual pass
  matters more than the automated one.

Worth fixing while in here: those four stale status headers, `changeover_matrix_stage_1.md`'s 49 unticked
checkboxes (every one of which shipped), and `docs/architecture/optimizer-dispatch.md:63`, which still lists
"sequence-dependent setup-time minutes" as out of scope.

---

## 2. What is actually on the tab

`SetupAdmin.renderSnapshot` (`plant-and-administration.mts:566-657`) emits a header plus four `.setup-group`
blocks. Control count for an admin, with a definition present and a line selected:

| Group | Controls | Notes |
|---|---:|---|
| Header | 0 | eyebrow, title, subtitle, status banner, version badge |
| **Setup Standard** | ~10 + (R×C) | N field `<select>`s, 2N reorder buttons, Add field, strict-blanks, Save, grid filter, Copy, Export, Import, grid Save, grid Discard, **one `<input type="number">` per matrix cell** |
| **Line Status** | 5 | line combobox, Update state, compatible checkbox, reason input, Save |
| **Coverage & Verification** | 5 | 2 KPI tiles, Copy missing, Export missing, audit toggle |
| **Activation Readiness** | 18 | 7 evidence checkboxes, owner email, ISO timestamp, notes textarea, Save, 2 policy numerics, 3 mode checkboxes, Save, Disable all |

**≈38 chrome controls before you touch a single matrix cell — and 18 of them (47%) are Activation
Readiness**, a one-time engineering release gate. Almost half the tab's interactive surface serves an action
that happens once per plant, ever, performed by someone who is not a scheduler.

It also sits **six navigation levels deep**:

```
Master Data → Plant → System Settings → Setup Matrix → group → panel → step → control
```

Three heading tiers (`.setup-group-eyebrow` → `.panel-head h4` → "1." / "2." step numbers) inside a tab that
is already the fourth tab strip in the chain.

---

## 3. The carryover — three editors over one registry

`_registeredFields` comes from `GET /priority-fields` (`plant-and-administration.mts:491-494`) — the same
`master_data.RANKABLE_FIELDS` registry (`colorWheel`, `prt01`, `prt02`, `productionVersion`) that backs two
other Plant surfaces:

| Surface | Question it answers | Editor |
|---|---|---|
| Plant › **Optimization** | Which *values* exist for each field, and in what rank order? | per-field priority-list dropzones |
| Plant › System Settings › **Scheduling Rules** | Which fields drive *sequencing priority*, and in what order? | nested constraint tree + effective-sequence readout |
| Plant › System Settings › **Setup Matrix** | Which fields define a *physical tooling state*? | "Ordered setup signature" |

These are genuinely three different questions, and `docs/scheduling_priority.md` reasons the separation
deliberately: the priority tree is *ordinal preference*, the matrix is *physical cost*, and policy config is
*authorization*. Setup data was kept in its own table specifically so it would not become columns on
`priority_list`.

**The problem is that nothing on screen says so, and the Setup editor is presented in a way that maximizes
the resemblance:**

- Scheduling Rules renders friendly labels via `Util.t('constraint.<key>')` — "Color Wheel". The Setup
  signature renders **raw field keys** in a bare `<select>` — `colorWheel`, `prt01` (`mts:606`). Same four
  fields, same registry, two vocabularies.
- Both are "an ordered list of fields from a dropdown, with ▲▼ reorder buttons, that changes how the
  optimizer behaves." One tab-click apart.
- Setup Matrix additionally carries **three evaluator toggles** — "Due-date-first evaluator", "Min
  Changeover evaluator", "Throughput evaluator" (`mts:678`) — naming the same optimizer modes as the Optimize
  dialog's `spt`/`changeover`/`combined`, with no stated relationship to either the dialog or the tree.

Three further real duplications, all confirmed in code:

- **A second, unsynced line picker.** `#setup-line-combobox` (`mts:650`) writes to a module-local `_lineScope`
  and ignores `Store.selectedLines`, the global line filter that syncs Gantt / Orders / Dashboard / Labor
  Plan / Master Data. Selecting a line here selects it nowhere else. A *third* per-line selector exists on the
  Optimization tab's override rows (`mts:2110-2118`).
- **Two fallbacks for the same registry** that disagree: `Engine.CONSTRAINT_CATALOG` (**1** entry —
  `schedule-services.mts:2071-2074`) vs `SetupAdmin.FALLBACK_REGISTERED_FIELDS` (**4** entries — `mts:129`).
  On a transient `/priority-fields` failure the two tabs show different field lists.
- **The same rank-map load, twice.** Scheduling Rules loads `Persistence.loadPriorityRankMaps` for its "no
  priority list uploaded" hint; Setup Matrix loads it again for the grid axes. The comment at `mts:554-558`
  documents that splitting into two inner tabs is what forced the duplicate.

---

## 4. The noise — ten sentences for one fact

With no definition set, the tab tells you setup is off, in this order:

| # | Where | Text |
|---|---|---|
| 1 | `.setup-kicker` | STAGE 0 · NOT YET LIVE |
| 2 | subtitle | "…once setup-aware scheduling is turned on for {{plant}}. This doesn't affect today's schedule yet." |
| 3 | `.setup-status.warn` **#1** | "Setup-aware optimization inactive — Create an ordered setup signature before…" |
| 4 | `.setup-help` (definition panel) | "No setup signature has been defined for this plant." |
| 5 | `.setup-empty` (grid mount) | "No setup signature has been defined for this plant." ← **verbatim duplicate** |
| 6 | `.setup-help` | "Changing the definition disables activation. A version-matched matrix and reachable coverage pass are required before activation review." |
| 7 | group description | "Engineering release gate for turning on setup-aware optimization. Plant schedulers don't need this section." |
| 8 | `.setup-status.warn` **#2** (evidence) | "Setup-aware optimization inactive — <reason>" |
| 9 | `.setup-status.warn` **#3** (policy) | "Setup-aware optimization inactive — Setup-aware optimization is not yet enabled for this plant. Contact your scheduling administrator to enable it." |
| 10 | `.setup-help` | "These modes cannot be enabled until your scheduling administrator completes sign-off for this plant." |

**Three identically-styled amber banners** (`.setup-status.warn`, `styles.css:6057`) stacked down one page.
Worse, they are fed by **two different computations** — `activationStatus` (`mts:170-180`) and
`policyActivationStatus` (`mts:182-192`) — which can disagree while wearing identical bold labels. A user
seeing two "Setup-aware optimization inactive" pills with different reasons has no way to know which governs.

Line 6 is pure restatement: it says in prose what the header pill's `ui.setup_status_version_mismatch` /
`_coverage_fail` reasons already say.

### 4.1 Seven competing uppercase micro-labels

| Class | Spec | Where |
|---|---|---|
| `.setup-kicker` | 700 10px mono, .07em | header eyebrow |
| `.setup-group-eyebrow` | 700 10px mono, .07em, upper | 4× group headers |
| `.setup-coverage strong` | 700 10px mono, .07em, upper | missing-pairs review |
| `.kpi-tile .k` | 600 10px mono, .08em, upper | 2× coverage tiles |
| `.setup-table th` / grid heads | 700 10.5px mono, .04em, upper | every table |
| `.setup-definition h4` (+ matrix/state/audit) | 12px **sans**, .05em, upper | 4× panel heads |
| `.setup-toolbar label`, `.setup-policy-grid label`, `.setup-evidence-notes` | 700 11px **sans**, .04em, upper | form labels |

Seven treatments differing by 0.5–2px and 0.01–0.04em — too similar to read as hierarchy, different enough
to read as inconsistency. `DESIGN.md` §3 sanctions exactly **two**: Mono-Eyebrow and Label.

---

## 5. The alignment defect, precisely

`ui.setup_no_definition` is rendered from two call sites with two different classes:

| Site | Class | CSS |
|---|---|---|
| `plant-and-administration.mts:607` | `.setup-help` | `margin: 4px 0 0; color: --fg-mute; 12px` (`styles.css:6052`) |
| `plant-and-administration.mts:770` | `.setup-empty` | `color: --fg-mute; 12px; padding: 9px 0` (`styles.css:6092`) |

Neither centers, neither has a container, and the second sits alone in an otherwise-empty full-width panel
body — a 12px gray sentence pinned to the left edge of a wide card, no icon, no action. That is what reads as
"not centered correctly."

**The app already has the right component and it isn't used here:** `EmptyState`
(`application-shell.mts:1513`) and `.empty-state` (`styles.css:903`). Five more sites share the problem:
`.setup-empty` at `mts:540` (loading), `:642` (no overrides), `:660` (policy loading), `:778` and `:785`
(grid empty / no filter matches).

---

## 6. The scale problem (not yet visible, will be fatal)

`cartesianStates()` (`mts:291-300`) builds the **full, uncapped cross-product** of every priority-list value
in every signature field, and uses it for **both** axes. `paintGrid` (`mts:801-816`) then renders
`rowStates × colStates` `<td>`s, each containing a live `<input type="number">`.

`docs/changeover_matrix.md` §2 gives the canonical example — **"Plant 5512: PRT_01 + Color"**. At 30 PRT_01
values × 20 colors that is 600 states → **360,000 cells, 360,000 DOM inputs**. Even a single-field Color-only
signature at 40 colors is 1,600 inputs. Against CLAUDE.md's target (50+ plants, 70+ lines per plant) this
does not survive first contact with real master data.

Two related defects in the same code:

- **One filter query is applied to both axes** (`mts:782-783`). Filtering `BLUE` collapses the grid to the
  BLUE→BLUE block — you can never inspect BLUE→RED, which is the entire point of a *directional* matrix.
- **Every missing cell renders the literal words "Not set"** as an input placeholder (`mts:812`,
  `ui.setup_grid_missing_placeholder`). On a sparse matrix that is thousands of repetitions of two words —
  by volume, the largest single source of text on the page.

---

## 7. The cell cannot say what it needs to say

`docs/changeover_matrix.md` defines a **five-level resolution precedence**, and the UI must distinguish all
of them — plus the explicit diagonal, which outranks the implicit one:

| # | Resolution | Meaning |
|---|---|---|
| 1 | Occurrence override active | This specific transition was overridden for one order pair |
| 2 | Exact **line** matrix row | Line-specific value, overrides the plant default |
| 3 | Exact **plant** matrix row | Plant default |
| 4 | **Implicit zero** — identical, fully known, valid states only | Structurally free, not a recorded value |
| 5 | **Uncovered** | Unknown. The optimizer treats the edge as unavailable. **Never zero.** |

`gridCellValue` (`mts:343-347`) collapses this to three: dirty > stored > `0` on the diagonal > `null`.
So today a cell **cannot distinguish**:

- a **line override** from an **inherited plant value** (both render as a plain number — `.setup-table
  tr.inherited` exists in CSS but no longer matches anything since the flat table was replaced);
- an **explicit diagonal row** ("A→A takes 10 min") from an **implicit zero** (both render as a number, and
  implicit zero renders as a real, editable `0`);
- a cell carrying an **active occurrence override** from a plain matrix value.

The design docs are emphatic that missing must never read as zero. Today's implicit-zero diagonal renders as
an editable `0` in a normal cell — visually identical to a recorded ten-minute value typed by an engineer.
Any cell design must carry these six states distinctly. Note `changeover_matrix.md` also forbids resurrecting
teardown, proportional shading, or a combined `[setup|production]` envelope — none of which this proposal
introduces.

---

## 8. What is truly needed

The tab answers three questions for two people, plus one governance question for a third:

| Question | Who | How often |
|---|---|---|
| What defines a tooling state, and how long does each change take? | IE / master-data owner | rarely — set once, edited on equipment change |
| Is the standard complete enough to trust? | same, + scheduling admin | on change |
| What state is line X in right now? | plant scheduler | daily-ish |
| Has engineering signed off to switch it on? | release engineer | once per plant, ever |

Everything else is scaffolding around those four.

**The organizing insight: this tab is one artifact — the matrix.** Everything else is either a *parameter* of
it (the signature that defines its axes), a *quality readout* on it (coverage), a *pointer into* it (a line's
current state), or *governance around* it (activation). None of those needs to be a peer panel.
So: **the grid is the page**, and the rest becomes chrome around it.

---

## 9. Proposed structure — one canvas, three rails

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ A  Setup Matrix                                    ● Not live      v3  ✎     │
│    How long it takes to change a line's tooling between two orders.          │
├──────────────────────────────────────────────────────────────────────────────┤
│ B  State = [Color] › [PRT 01]        Scope [Plant default ▾]                 │
│                                      Coverage 128/144 · 16 missing ▸         │
├──────────────────────────────────────────────────────────────────────────────┤
│ C                                                                            │
│                    from-state × to-state grid                                │
│                    sticky headers · fills the pane · scrolls                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ D  3 unsaved changes          [Discard] [Save]        Import · Export · ⋯     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Four horizontal bands, replacing four groups × two-to-three panels × three heading tiers.

### A — Context bar
Replaces: eyebrow + title + subtitle + version badge + **all three** `.setup-status` banners.

- **One** status chip (`● Not live` / `● Live`), pill-scale, using the existing `.setup-status.ok/.warn`
  tokens. It is a **button** → opens the **Activation modal**, where all 18 Activation Readiness controls go
  (evidence checklist, owner/timestamp/notes, policy numerics, mode toggles, Disable all). Admin-gated
  exactly as today via `permissions.definitionWrite` — same check, new container.
- Reconcile the two status computations behind that one chip: `activationStatus` governs the chip; the
  `policyActivationStatus` detail belongs inside the modal, where it has room to explain itself.
- `v3 ✎` opens the **signature popover** (below).
- Visible prose: **two lines**, down from ten.

### B — Standard rail
Replaces: the "1. Define the setup signature" panel, the `.setup-toolbar`, and the two coverage KPI tiles.

- **Signature as a read-only chip breadcrumb** — `[Color] › [PRT 01]`. Editing a signature version-bumps and
  invalidates the entire matrix; it is rare and destructive, and does not deserve a permanently-open panel
  with a step number, an Add button, a checkbox, a Save button and two help paragraphs. `✎` opens a popover
  with exactly those controls, plus one clarifying line:
  > *Which attributes physically change the tooling. Separate from Scheduling Rules, which decides
  > sequencing order.*
  Render the chips with `Util.t('constraint.<key>')` — the **same labels Scheduling Rules uses** — instead of
  raw `field_key` strings. Same vocabulary, clearly different question.
- **Scope** — the line combobox, relabeled `Scope` with values `Plant default` / `<line>`.
- **Coverage as an inline readout**, not two KPI tiles. `16 missing ▸` is the click target that filters the
  grid to missing cells. Two `.kpi-tile`s for two integers is Dashboard-weight furniture on a settings page
  — and one of them (OBSERVED PAIRS, `mts:638`) is a `<button>` with **no click handler**, so it is a control
  that does nothing.

### C — The grid
In priority order:

1. **Cap the rendered universe.** Render at most `MAX_AXIS` (start at 60) states per axis; above that,
   require a filter and show `Showing 60 of 600 states — narrow the filter`. Bounded DOM, unconditionally.
2. **Split the filter in two** — `From` and `To` — so directional inspection works. Keep single-box "both
   axes" behaviour as the default when only one is filled.
3. **Read-only cells; edit on click.** Replace one live `<input>` per cell with rendered text plus a single
   floating editor that moves to the focused cell. Largest single performance win, and it is the model Labor
   Planning's Aggregate grid already uses (`mts:2940-3424`) — the internal precedent the prior redesign cited
   but did not follow for cell rendering.
4. **Six distinct cell states**, per §7 — plain value (plant default), line-override value, explicit diagonal,
   implicit zero, uncovered, dirty. Uncovered is a single `·` glyph in `--fg-faint` with its meaning stated
   once in the rail — never the word "Not set" repeated thousands of times, and never a `0`.
5. **"You are here."** When a line is scoped and has a known current state, mark that row. This is what makes
   the Line Status panel unnecessary.

### D — Action bar
Always present (not `hidden` until dirty) so Import/Export/History have a stable home.

- Dirty count + Discard + Save, as today.
- `⋯` menu: Copy matrix, Export matrix, Import CSV, **Override history (N)** → the existing audit content in
  a `Modal` instead of an inline collapsed panel.
- **The two copy/export pairs collapse to one.** With the grid filterable to missing cells, "Export" exports
  what is shown. The ambiguity the previous pass solved by lengthening four labels
  (`btn.setup_copy_matrix` / `_export_matrix` / `_copy_missing` / `_export_missing`) dissolves instead of
  being described.

### What moves off the page

| Today | Becomes |
|---|---|
| Group "Line Status" (5 controls, own panel) | Scope selector popover + a marked row in the grid |
| Group "Activation Readiness" (18 controls) | Activation modal, behind the status chip |
| Override audit panel | Modal, behind `⋯ → History` |
| Missing-pairs review table (from optimizer preview) | A filter chip on the grid — *"Showing 12 pairs from optimizer run ✕"* — so the pairs appear in the surface you have to edit anyway. This also removes a **third** copy of the same 4-column table markup, which Optimizer Preview re-renders at `schedule-workbench.mts:7752` |

---

## 10. Cleanup this should sweep up

Found while inventorying; all low-risk and adjacent.

- **15 orphaned locale keys**, present in all five locale files with zero code references — including
  `ui.setup_matrix_observation` ("REFERENCE DATA"), which the prior redesign said it *retired* but is still
  shipping (`en.js:1282`). Also `ui.setup_matrix_rows`, `_from_state`, `_to_state`, `_minutes`, `_no_rows`,
  `_inherited`, `_import_long_form`, `_definition`, `_state_prompt`, `_line_metadata_unavailable`,
  `_coverage_observed`, `_coverage_reachable`, `btn.setup_export_csv`, `btn.setup_delete_override`.
- **Dead code:** `[data-setup-delete-row]` wiring (`mts:746-748`) matches no rendered markup, so
  `deleteRow()` (`mts:1040-1043`) is unreachable from the UI. `.setup-matrix .panel-head` / `.setup-matrix h4`
  (`styles.css:6076-6077`) match no element.
- **Accessibility gaps against the prior doc's own §6:** group headers use `<div class="setup-group-eyebrow">`
  (`mts:604, 627, 636, 646`), not the real `<h4>` that doc specified — so screen-reader users cannot navigate
  the groups by heading. The inner tab panes carry `role="tablist"`/`role="tab"` but **no `role="tabpanel"`
  and no `aria-controls"`**.
- **`.panel-quiet` does not land.** It styles `.panel-head h3` (`styles.css:747-755`), but the readiness
  group's panels use `h4` — so the intended visual recession mostly does not apply.
- **Sibling-tab note (out of scope, worth logging):** three of Scheduling Rules' four panels hardcode English
  headers, help text and toasts, even though locale keys exist for them (`ui.alert_horizon_title`,
  `ui.conf_horizon_title`, `ui.show_alerts_within`, `ui.score_covers`, `ui.days` at `en.js:526-531`). The
  entire Split-order panel has no keys at all. This contradicts the project's standing i18n rule.

---

## 11. Text and type budget

**Prose:** from ~19 always-visible blocks (10 status sentences + 5 group/panel descriptions + 4 help
paragraphs) to **≤4**. Rule to hold: *explanatory prose appears once, at the point of action, and only when
the action is ambiguous.* Everything else becomes a `title` tooltip or lives in `docs/changeover_matrix.md`.

**Type:** collapse the seven uppercase micro-label treatments to the two `DESIGN.md` §3 sanctions —
Mono-Eyebrow (10px/600 mono, .08em) for status/coverage/grid headers, Label (11px/600 sans, .04em) for form
labels inside popovers and modals. Everything else drops to sentence-case 12.5px control text.

**Terminology:** `changeover_matrix.md` §1 fixes the user-facing word as **"setup"** — never "changeover" or
"transition" (those survive in code and API naming only). The current copy still mixes all three; the rail
and grid headers are the places to enforce it.

**Empty states:** route all six sites through `EmptyState` / `.empty-state`, centered, with an action where
one exists — and **delete the duplicate at `mts:607`** so "No setup signature has been defined for this
plant." appears exactly once:

| Condition | Copy | Action |
|---|---|---|
| No signature | "Define what makes a tooling state" | **Define signature** → signature popover |
| Signature set, no ranked values | "No values are ranked for these attributes yet" | **Go to Optimization** (where priority lists are uploaded) |
| Filter matches nothing | "No states match" | **Clear filter** |
| Loading / no overrides | quiet inline text, no card | — |

---

## 12. Files touched

- `web/plant-and-administration.mts` — `SetupAdmin.renderSnapshot` (four-band shell), `renderPolicyPanel`
  (→ Activation modal body), `renderLineState` (→ scope popover + grid row marker), `paintGrid` (axis cap,
  two-axis filter, read-only cells + floating editor, six cell states), `gridCellValue` (carry provenance,
  not just a number), `wire` (rewire to new containers), `cartesianStates`/`filterStates` (cap + directional
  filter).
- `web/styles.css` — collapse `.setup-*` label styles to two; add the four-band layout; remove
  `.setup-kpi-row` and the dead `.setup-matrix` rules; keep `.setup-grid-*` geometry.
- `web/locales/{en,de,es,fr,pt}.js` — retire the redundant status/help keys (§4) and the 15 orphans (§10);
  add the small set of new ones. `tests/modules/locale-completeness.test.mjs` enforces five-locale parity, so
  this cannot ship English-only.
- Reuse, do not rebuild: `EmptyState` (`application-shell.mts:1513`), `Modal`, `_mkCombobox`, Labor Planning's
  grid interaction model (`mts:2940-3424`), `Store.selectedLines`.

**No changes to** `setup_data.py`, any `/setup/*` route, `schema.sql`, or `SetupAdmin`'s permission
functions. Save paths are unchanged: `PUT /setup/{plant}/definition`, `POST /setup/{plant}/matrix/import`,
`DELETE /setup/{plant}/matrix`, `PUT /setup/{plant}/lines/{line}/state`, `.../compatibility`,
`PUT /setup/{plant}/policy`, `PUT /setup/{plant}/release-evidence`.

---

## 13. Phasing

| Phase | Content | Independently shippable? |
|---|---|---|
| **1 — Noise, bug, cleanup** (~1 day) | Delete the duplicate empty state; route all six through `EmptyState`; three status banners → one chip; seven label styles → two; delete redundant prose; the §10 sweep (orphan keys, dead code, `h4` headings, `role="tabpanel"`) | Yes |
| **2 — IA** (~1–2 days) | Four-band layout; signature → popover; readiness → modal; line status → scope popover + row marker; history → modal; missing-review → grid filter chip | Needs sign-off on §9's shape |
| **3 — Scale & cell semantics** (~2 days) | Axis cap; two-axis filter; read-only cells + floating editor; the six cell states from §7 | Yes |

Phases 1 and 3 stand alone. Phase 2 is the one that changes the shape and should be agreed before it starts.

---

## 14. Verification

- `npm run typecheck`, `npm run lint:errors`, `npm run build`, `npm run check:static-assets`.
- `node --test tests/modules/*.test.mjs` — including `locale-completeness` and the 13 grid-helper tests added
  by the prior pass. `cartesianStates`/`filterStates` tests need updating for the cap and the split filter;
  `gridCellValue` needs new cases for the six states.
- **Manual, with a real signature loaded** — this matters more than usual, because *no part of the setup UI
  has ever been opened in a browser* (§1.1):
  - "No setup signature has been defined for this plant." appears **exactly once**, centered, with an action.
  - Exactly one status pill exists on the page.
  - A 2-field signature over realistic master data (≥20 values per field) renders in bounded time and never
    exceeds `MAX_AXIS` per axis.
  - Filtering `From: BLUE` with `To:` empty shows BLUE→**all**, not BLUE→BLUE.
  - An uncovered cell is visually distinct from an implicit-zero diagonal, and neither reads as a recorded
    value. A line override is distinguishable from an inherited plant value.
  - Save still splits line-scoped (sparse upsert) vs plant-default (merge-then-replace) correctly; Discard
    makes no backend call.
  - A non-admin scheduler sees no Activation affordance at all.
  - Dark mode: status chip, grid headers, uncovered glyph, and dirty marker all read correctly.
  - Keyboard: the five groups are navigable by heading; setup detail remains reachable without hover.
- Confirm no new references to setup data appear in `Engine`, `Calendar`, `Alerts`, `Utilization`,
  `Timeline`, or `Interaction` — this is a presentation change, not a new consumer.

---

## 15. What actually shipped instead (2026-08-14, commit `8da20d7`)

Before this document's Phase 2 (the four-band IA, §9) was implemented, the user asked for something more
direct: fold Activation Readiness's 18 controls down to exactly one checkbox — no evidence checklist, no
owner/timestamp/notes, no policy numerics, no per-mode toggles, no modal — and, unlike this proposal's
no-backend-changes scope (§12), make it **do** something, since nothing in the optimizer consumed
`setup_definition.active` outside incremental auto-reflow. That request was explicitly out of scope for a
"proposal, not implemented" reformulation, so it was brainstormed and implemented as its own bounded change,
landing same-day but after this document was written. It **replaces** §9's Context-bar plan for Activation
Readiness rather than building on it:

- **Backend:** `setup_data.set_definition_active()` (new) flips `setup_definition.active` directly, gated by
  `expected_signature_version` optimistic concurrency. `brain.py`'s four `/setup/{plant}/policy` +
  `/setup/{plant}/release-evidence` endpoints are gone, replaced by one
  `PUT /setup/{plant}/active {active, expected_signature_version}`. `master_data.py` lost
  `SETUP_POLICY_DEFAULTS`/`SETUP_RELEASE_EVIDENCE_DEFAULTS` and all seven functions that read/wrote them
  (~175 lines) — this makes **§12's "no changes to `setup_data.py`, any `/setup/*` route" and the
  `PUT /setup/{plant}/policy` / `PUT /setup/{plant}/release-evidence` save-path list stale.**
- **Frontend:** `SetupAdmin.renderSnapshot` (`plant-and-administration.mts`) renders the checkbox inline in the
  header next to the existing status chip — not in a modal, and not gated behind §9's proposed
  `activationStatus`/`policyActivationStatus` reconciliation, because `policyActivationStatus` and everything
  that fed it (`renderPolicyPanel`, `safeDisablePolicy`, `normalizePolicyThresholds`, `releaseEvidenceReady`,
  `releaseEvidencePayload`) were deleted rather than relocated. `activationStatus` (the version-match/coverage
  chip) is untouched and still governs the status pill described in §4/§9-A.
- **Optimizer wiring (the part this document didn't cover at all):** `Engine.runAndApply`
  (`schedule-services.mts`) now checks `Store.setupSnapshot.definition?.active` for the run's plant and, if
  true, routes `spt`/`changeover`/`combined` through `Engine.evaluateSetupAware` — which had existed fully
  implemented in `setup-scheduler.mts` since Stage 0/1 (`evaluateDueDateFirst`, `evaluateSptWithSetup`,
  `evaluateMinChangeover`, `evaluateThroughput`) but had zero callers before this change. `setup-scheduler.mts`
  itself was not modified. The `DueDateFirstBounds` search-safety limits that Stage 0 deferred to an unrun
  perf-measurement gate (`exactSearchThreshold`, `iterationCap`, `deadline`) are now hardcoded
  (`SETUP_AWARE_EXACT_SEARCH_THRESHOLD = 8`, `SETUP_AWARE_ITERATION_CAP = 20000`,
  `SETUP_AWARE_DEADLINE_MS = 5000`) rather than measured — an explicit, user-accepted risk, not an oversight.
- **What this resolves from §16:** Q1 (modal vs. Admin Cockpit) is moot — there is no modal. Q4 (the three
  evaluator-toggle names) is moot — there are no per-mode toggles; the checkbox enables all setup-aware modes
  uniformly, so the naming clash with the Optimize dialog's `spt`/`changeover`/`combined` never surfaces in
  the UI.
- **What this does NOT resolve:** §1.1's correction (machinery was already built, only authorization was
  gated) still holds — this change just removed the authorization ceremony rather than relocating it. §§3-9
  (carryover duplication, noise, alignment, scale, cell semantics, the grid redesign itself) are all still
  open and were not touched by this change. §14's "no new references to setup data in `Engine`" verification
  bullet is now **inverted by design** for this feature — `Engine.runAndApply` is the intended new consumer —
  though it should still hold for `Calendar`/`Alerts`/`Utilization`/`Timeline`/`Interaction`.

## 16. Open questions for you

1. **Activation Readiness — modal, or move to Admin Cockpit entirely?** This proposal puts it in a modal
   behind the status chip (keeps it plant-scoped; smallest change). Moving it to Admin Cockpit is arguably
   more correct — it is an engineering release gate, and AdminCockpit already owns ops consoles — but it
   splits setup config across two top-level tabs.
2. **Should `Scope` bind to `Store.selectedLines`?** Binding removes a duplicate picker, but then changing the
   Gantt's line filter silently re-scopes the matrix you are editing. The safer alternative is to keep them
   separate and merely *seed* the scope from `selectedLines` on open. I lean toward seeding.
3. **`MAX_AXIS = 60` is a guess.** The right cap depends on real signature cardinality, which nobody has
   measured — no plant has a production signature loaded yet. Worth measuring before committing to a number.
4. **The three evaluator toggles** ("Due-date-first" / "Min Changeover" / "Throughput") name the same modes as
   the Optimize dialog. This proposal relocates them into the Activation modal but does not reconcile the
   naming; that belongs with the optimizer work, not this tab.
5. **Should the stale doc headers be fixed in the same pass?** Four untracked docs claim the feature is
   unimplemented, Stage 1's plan shows 0/49 done, and `optimizer-dispatch.md:63` still calls setup minutes
   out of scope. Cheap to correct, and actively misleading until someone does.
