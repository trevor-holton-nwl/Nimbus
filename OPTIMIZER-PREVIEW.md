# Optimizer Preview — implementation spec

Everything needed to rebuild the optimization preview dialog. Visual reference:
`Optimizer Preview Redesign.dc.html` (a prototype — hardcoded data, inline styles, its own
`support.js` runtime; read it as the target, do not copy its markup).

Target surface: the `modal-opt-preview` dialog rendered by `OptimizerPreview._render()` in
`web/schedule-workbench.mts`. Entered from `OptimizeDialog.run()` → `showLoading()` →
`runWithPreview()`.

---

## 1. What is wrong today

The engine side is sound — nothing touches `Store` until Apply, the detached-snapshot discipline is
careful, and `_installAbandonGuard()` correctly treats a backdrop close as a discard. The problems
are all in presentation.

1. **The decision is buried.** `_render()` writes, in order: mode/plant chips → backlog results →
   *Candidate explanation* → verdict → KPI cards → footer note. The explanation block alone emits an
   impact grid, search diagnostics, a constraints line, an unchanged-lines line, a reasons list and
   a missing-pairs table. The two things the planner decides on — verdict and KPI cards — sit below
   all of it, in a modal that scrolls.
2. **The same numbers render twice, with different names.** The explanation impact grid restates
   four of the five KPI cards as `before → after` text. Labels disagree: card "Changeovers" vs grid
   "Setup changeovers"; card "Schedule span" vs grid "Occupied time" — and both read `span_h`. Two
   names for one measurement in one dialog.
3. **The verdict scoring doesn't hold up.** `soft` KPIs (`span_h`, `peak_util_pct`) count as wins
   when they fall but never as losses, yet stay in the denominator. "Big win — every KPI improved"
   can fire off a 0.06 h span reduction. `peak_util_pct` is scored lower-is-better while its own
   tooltip says "high is good for throughput".
4. **Truncation is invisible.** `PREVIEW_REASON_LIMIT = 8` caps the reasons list, the constraints
   list and the unchanged-lines list. At 50 lines the engine may report 200+ decisions; the dialog
   shows the first 8 in engine order with no indication the rest exist and no ranking.
5. **Hardcoded English** in the cards, verdict copy, backlog rows, footer note, stale tooltip and
   Apply toast, while the explanation block uses `Util.t` — the dialog is half-translated.
6. **Emoji as iconography** (`🔁 ↔ ⏰ ⛌ ▲ 📍 ⏱`). Against DESIGN.md §6; `⛌` renders
   unpredictably across platforms.
7. **The counter animation fires on every `_render()`**, including the `markSetupStale()` repaint, so
   numbers re-animate when data goes stale. It always counts from zero, making a 1% change look
   dramatic. Against DESIGN.md §5's "brisk, exact" motion rule.
8. **Apply's disabled state is poked into the DOM.** `markSetupStale()` selects
   `.modal-foot .btn-primary` and sets `disabled` directly rather than deriving from `canApply()`,
   and `hideLoading()` re-enables *all* foot buttons unconditionally — a path that can re-enable
   Apply while stale.
9. **`var(--danger, #c0392b)`** in the error state. There is no `--danger` token in NIMBUS; it's
   `--err`. That red is off-palette.
10. **Bars carry almost no information.** `preW`/`postW` normalise to `max(pre, post)`, so a 2%
    improvement draws as 100% vs 98%, and `0 → 0` still draws 2% stubs.
11. **Wasted work.** `summarizeCandidate()` builds `missingPairs`, then `runWithPreview()` overwrites
    it immediately with `describeMissingPairs()`.
12. **`_previewDiagnostics`** is collected and stored but never rendered anywhere.

---

## 2. What must NOT change

The requester explicitly wants today's KPI visualisation kept. **Do not restyle the verdict banner
or the KPI cards.** That means all of this stays byte-identical:

- `.opt-pv-verdict` — the tinted gradient, the 4px left rail via `::before`, the 44px white icon disc
  with `✓` / `!` / `◐`, the `x/5` score block with its left hairline.
- `.opt-pv-card` — 2px severity top-border, icon chip, uppercase label, `?` help dot with the dark
  `.opt-pv-tip` tooltip, Before → After at 22px mono, the dashed-rule pre/post bars, the rounded
  delta pill with its `▼`/`▲` glyph and percent.
- The five cards and their order: Changeovers, Schedule span, Late orders, Cumulative lateness, Peak
  line utilization.

Those styles live in **`web/index.html`** (roughly lines 541–840), not `styles.css`. The bars stay
despite §1.11 — that was a suggestion the requester declined.

The two emoji items (§1.6) and the animation (§1.7) are still in scope to fix, since neither is part
of the card *layout*.

---

## 3. Files to change

| File | Why |
| --- | --- |
| `web/schedule-workbench.mts` | `OptimizerPreview._render()` reorder, new sections, verdict scoring, Apply state, error color |
| `web/index.html` | `.opt-pv-*` CSS: add disclosure/section/plan-table/prune-bar styles |
| `web/locales/en.js` | Move hardcoded copy into keys (§7) |
| `web/schedule-workbench.mjs` | **Generated** — do not hand-edit; `npm run build` |
| Engine (`schedule-services.mts` / `nimbus-compute-core`) | `CandidateResult` additions (§6) — blocks the plan table only |

---

## 4. New structure

Modal body, top to bottom:

1. **Stale banner** (conditional) — amber, `--warn-soft` on `--warn`, 3px `border-top`:
   "Setup data changed while this comparison was open. Run optimization again before applying."
   Replaces the current invisible-until-you-hover-Apply treatment.
2. **Verdict banner** — unchanged component, new scoring (§5).
3. **KPI card grid** — unchanged component, all five cards.
4. **Backlog results** — unchanged `.opt-pv-backlog` section, `backlog` mode only. Moves to *below*
   the cards.
5. **Three collapsed disclosure sections**, in one bordered stack:
   - *Why this candidate* — open by default
   - *Missing setup times* — collapsed
   - *Search diagnostics* — collapsed
6. **Footer note + Discard / Apply** — unchanged wording, Apply state derived (§5.3).

### 4.1 Disclosure header pattern

Each header is a full-width `<button>`: mono uppercase eyebrow on the left, a summary string beside
it, a `▼`/`▲` caret on the right, `--bg-strong` when open. Toggling must **not** repaint the modal
body — flip `hidden` on the panel and update `aria-expanded` in place, or an open selection and the
counter state die on every click.

**Every header summary must be derived from the same data as its body.** A literal count in the
header will contradict the body the moment the run scale changes — that is exactly the bug the
prototype had at 50-line scale.

- Why: `3 finalists of {{count}} candidates`
- Missing setup times: badge `{{count}} pairs` (amber tint)
- Search diagnostics: `{{method}} · {{count}} candidates · {{runtime}}`

### 4.2 "Why this candidate" — plan comparison

**Plan-level, not per-line.** A per-line branch tree was prototyped and rejected: at 50 lines it is
150–400 rows and answers the wrong question. The planner wants "what would the whole plan have been,
and what did we pick".

A table, four columns × the five KPI rows:

| | Current | **Applied** (plan A) | Alt B | Alt C |
| --- | --- | --- | --- | --- |
| Changeovers | 34 | **27** `−7` | 24 `−10` | 31 `−3` |
| Late orders | 12 | **9** `−3` | 13 `+1` | 7 `−5` |
| … | | | | |

- Applied column tinted (`--accent-wash` head, `--bg-subtle` cells) with a 2px navy top-border.
- Every cell shows the value plus its delta **against Current**, colored green/red/neutral.
- A `<tfoot>` "Verdict" row gives each plan one sentence: `Chosen. Best balance — cuts changeovers
  and late orders without pushing a line over capacity.` / `Pruned. Fewest changeovers, but one more
  late order and 65 h more slip.`
- Row headers carry the existing card tooltips via `title`.
- Fixed four columns regardless of run size — this is why it replaces the tree.
- `overflow-x: auto` with `min-width: 560px` on the table.

### 4.3 "Why this candidate" — aggregate prunes

Below the table, "Where the other candidates went": one row per rejection reason **for the whole
run**, not per line. Each row is label + proportional bar + count, with the reason explained on
hover:

```
Broke a color block            ███████████████  9,120
Exceeded calendar capacity     ███████           4,201
Missed a due date              ██████            3,860
Fixed order conflict           █                   606
Missing setup time             █                   612   ← amber bar
```

- Bars are `width: (count / max) * 100%`, `--line-strong` fill.
- **`Missing setup time` gets the amber fill** because it is the only class the planner can act on.
  Footnote states it: "Only the missing-setup-time class is fixable from here — N candidates could
  not be costed at all. The rest were rejected on merit."
- Header right side shows the total: `18,399 pruned`.

Then a footnote row: Constraints, Lines changed (`12 of 50`), Sequences changed
(`candidate.patches.length`).

**This whole section replaces** the current impact grid, reasons `<ul>`, constraints line and
unchanged-lines line. Delete them — §1.2.

### 4.4 "Missing setup times"

The existing `describeMissingPairs()` table (Line / From / To / Reason), capped at
`PREVIEW_MISSING_PAIR_LIMIT = 12`, plus:

- A lead paragraph: "The optimizer could not evaluate these transitions because no setup time is
  recorded for them. Filling them in may produce a better candidate on the next run."
- Explicit truncation when the cap bites: "Showing the 4 pairs that blocked the most orders, of 31."
  Rank by orders blocked, not engine order.
- State values rendered in the same `Blue · T1` form the Setup Matrix list uses — not
  `colorWheel=BLUE | prt01=T2`.
- Actions: **`Fill these in the Setup Matrix`** (primary), Copy, Export CSV. The primary button keeps
  the existing `SetupAdmin.reviewMissingPairs()` handoff, which already narrows scope and discards
  the preview. With Setup Matrix v2 shipped it should land on the **list view** filtered to those
  pairs — see `SETUP-MATRIX-V2.md`.

### 4.5 "Search diagnostics"

A definition list from `candidate.diagnostics`: Method, Candidates, Termination, Runtime, Orders in
scope (`before → after`). This is where `_previewDiagnostics` (§1.12) should finally surface — render
its `error`/`warn` events here as a short list when non-empty.

---

## 5. Logic changes

### 5.1 Verdict scoring

Replace the `lowerIsBetter: true | false | 'soft' | null` scoring with an explicit split:

- **Targets** (count toward the verdict, `lowerIsBetter: true`): `changeovers`, `late_count`,
  `late_h`.
- **Context** (never scored): `span_h`, `peak_util_pct`.

The score becomes `better of 3`, not `better of 5`, and "every KPI improved" can only fire when all
three targets actually improved. Keep the ±0.05 tolerance dead-band. Fix the `peak_util_pct` tooltip
so it stops claiming a direction it isn't scored on.

> Note: the requester kept the `x/5` score block visually. Either widen the denominator to 5 while
> only scoring 3 (misleading), or render `x/3` in the same block. **Recommend `x/3`** — the block is
> unchanged, only the number differs. Confirm before building.

### 5.2 Truncation transparency

Raise `PREVIEW_REASON_LIMIT` handling: rank before slicing, and always report the true total next to
the slice. Never show "8 decisions" when 214 were reported.

### 5.3 Apply state

```ts
function syncFootButtons(): void {
  const apply = root?.querySelector<HTMLButtonElement>('.modal-foot .btn-primary');
  if (!apply) return;
  apply.disabled = !OptimizerPreview.canApply();
  apply.title = OptimizerPreview.stale ? Util.t('ui.opt_stale_apply_title') : Util.t('ui.opt_apply_title');
}
```

Call it from `_render()`, `markSetupStale()` and `hideLoading()`. Remove the direct `disabled` poke in
`markSetupStale()`, and stop `hideLoading()` blanket-enabling foot buttons.

### 5.4 Deletions

- The `requestAnimationFrame` counter animation on `.opt-pv-num-post` (§1.7).
- `summarizeCandidate()`'s `missingPairs` construction — `describeMissingPairs()` overwrites it
  (§1.11). Keep one.
- The impact grid / reasons / constraints / unchanged-lines markup, replaced by §4.3.
- Emoji chips `📍` and `⏱` in the header chips (§1.6); keep the chips, drop the glyphs. The five card
  icons need non-emoji replacements — HTML entities (`&#8635; &#8596; &#9201; &#8721; &#9650;`) are
  what the prototype uses.

---

## 6. Engine need (blocks §4.2 and §4.3 only)

`CandidateResult` currently returns the winner's `patches`, `explanation`, `missingEdges`,
`unchangedLines` and `diagnostics`. The plan comparison needs two additions:

```ts
interface CandidateResult {
  // …existing
  /** Runner-up plans that survived to the final beam, winner first. KPI vectors
   *  only — never a full schedule (the preview must stay detached). */
  finalists: Array<{
    label: string;                 // 'A' | 'B' | 'C'
    kpis: OptimizerKpis;           // same shape Util.scheduleKpis returns
    whyNot: string | null;         // null for the applied plan
  }>;
  /** Aggregate prune tally for the whole run, keyed by reason code. */
  prunedByReason: Record<string, number>;
}
```

`finalists[n].kpis` must be computed the same way the applied plan's post-KPIs are
(`applyPatchesToSnapshot` → `Util.scheduleKpis`), or the columns won't be comparable.

**These two additions are not the same size of work.** `prunedByReason` is self-contained
instrumentation: wrap each of the ~30 `explanation.push(...)` call sites in `setup-scheduler.mts`
(e.g. lines 1407, 1843, 2777, 2942, 2987, 3050, 3192) to also increment a `Record<string, number>`
tally keyed by `code`, and return it alongside `explanation`. No search-algorithm change required —
ship this independently of `finalists` if needed. `finalists` is genuinely blocked: the engine is a
confirmed single-pass greedy dispatch with no beam retained (see the fallback-tier note above), so a
true N-wide finalist list requires new search-algorithm work, not plumbing.

**If this can't ship in the same change:** build sections §4.4 and §4.5 and the reorder, and render
the Why section with the constraints/sequences/lines footnote only. Do not fabricate finalist
numbers.

> **Existing fallback tier, undocumented until now.** `OptimizerPreview` already has a `_finalists`
> field (`web/schedule-workbench.mts`, ~line 7653/7900) populated by running one hardcoded alt mode
> (changeover↔spt swap via `altModeMap`) and keeping only its KPI vector — patches discarded
> immediately. It is **2-wide** (Applied + one Alt), not the 3-wide Applied/Alt B/Alt C this table
> mocks up, and its "alternate" is a different dispatch *mode* entirely, not a runner-up from the same
> search, so it has no `whyNot`. The engine is confirmed single-pass greedy
> (`Engine._dispatchDayIntegrity`, see `docs/architecture/optimizer-dispatch.md`) with no beam
> retained — the only multi-plan comparison anywhere is a pairwise baseline-vs-candidate chooser
> (`evaluateMinChangeover`/`selectThroughputCandidate` in `setup-scheduler.mts`) that discards the
> loser immediately. A true N-wide finalist beam is real search-algorithm work, not plumbing. If §4.2
> ships before that work lands, reuse this prototype for a **2-column** Current/Applied/Alt-B table
> (Alt C omitted) rather than re-inventing it — but note its "alt" is a mode swap, not a beam runner-up,
> so `whyNot` copy must be written accordingly (e.g. "Would have used {{mode}} dispatch instead").

---

## 7. New i18n keys (`web/locales/en.js`)

```js
// Optimizer preview — sections
'ui.opt_pv_title':                 'Optimization preview',
'ui.opt_pv_why':                   'Why this candidate',
'ui.opt_pv_why_summary':           '3 finalists of {{count}} candidates',
'ui.opt_pv_gaps':                  'Missing setup times',
'ui.opt_pv_gaps_badge':            '{{count}} pairs',
'ui.opt_pv_gaps_hint':             'The optimizer could not evaluate these transitions because no setup time is recorded for them. Filling them in may produce a better candidate on the next run.',
'ui.opt_pv_gaps_truncated':        'Showing the {{shown}} pairs that blocked the most orders, of {{total}}.',
'ui.opt_pv_diag':                  'Search diagnostics',
'ui.opt_pv_diag_summary':          '{{method}} · {{count}} candidates · {{runtime}}',
// Plan comparison
'ui.opt_pv_plans_hint':            'The optimizer kept the three strongest whole-plan candidates and pruned the rest. Each column is a complete plan for the window; deltas are against the current schedule.',
'ui.opt_pv_col_current':           'Current',
'ui.opt_pv_col_current_sub':       'in place now',
'ui.opt_pv_col_applied':           'Applied',
'ui.opt_pv_col_alt':               'Alt {{label}}',
'ui.opt_pv_col_not_applied':       'not applied',
'ui.opt_pv_plan_chosen':           'Chosen.',
'ui.opt_pv_plan_pruned':           'Pruned.',
'ui.opt_pv_baseline':              'Baseline',
// Aggregate prunes
'ui.opt_pv_prunes_title':          'Where the other candidates went',
'ui.opt_pv_prunes_total':          '{{count}} pruned',
'ui.opt_pv_prune_colorblock':      'Broke a color block',
'ui.opt_pv_prune_capacity':        'Exceeded calendar capacity',
'ui.opt_pv_prune_duedate':         'Missed a due date',
'ui.opt_pv_prune_fixed':           'Fixed order conflict',
'ui.opt_pv_prune_setup':           'Missing setup time',
'ui.opt_pv_prune_footnote':        'Only the missing-setup-time class is fixable from here — {{count}} candidates could not be costed at all. The rest were rejected on merit.',
'ui.opt_pv_lines_changed':         'Lines changed',
'ui.opt_pv_sequences_changed':     'Sequences changed',
// KPI cards (currently hardcoded)
'ui.opt_kpi_changeovers':          'Changeovers',
'ui.opt_kpi_span':                 'Schedule span',
'ui.opt_kpi_late_count':           'Late orders',
'ui.opt_kpi_late_h':               'Cumulative lateness',
'ui.opt_kpi_peak_util':            'Peak line utilization',
'ui.opt_kpi_before':               'Before',
'ui.opt_kpi_after':                'After',
'ui.opt_kpi_no_change':            'No change',
'ui.opt_kpi_improved':            'KPIs improved',
// Verdict (currently hardcoded)
'ui.opt_verdict_none':             'No measurable change',
'ui.opt_verdict_none_sub':         'The optimizer ran but the KPIs are unchanged within tolerance.',
'ui.opt_verdict_all':              'Big win — every target improved',
'ui.opt_verdict_better':           'Schedule improved',
'ui.opt_verdict_better_sub':       '{{better}} of {{total}} targets moved in your favor with no regressions.',
'ui.opt_verdict_mixed':            'Net improvement, with trade-offs',
'ui.opt_verdict_mixed_sub':        '{{better}} improved, {{worse}} regressed. Review before applying.',
'ui.opt_verdict_worse':            'Net regression',
'ui.opt_verdict_worse_sub':        '{{worse}} got worse, {{better}} improved. Discard recommended.',
// Stale + actions
'ui.opt_stale_banner':             'Setup data changed while this comparison was open. Run optimization again before applying — these numbers no longer describe the current setup times.',
'ui.opt_stale_apply_title':        'Setup data changed. Run optimization again before applying.',
'ui.opt_apply_title':              'Commit this candidate schedule',
'ui.opt_pv_footer_note':           'Apply commits this candidate — still undoable with Ctrl+Z. Discard leaves the current schedule untouched.',
'ui.opt_pv_loading':               'Calculating optimization impact…',
'ui.opt_pv_loading_sub':           'Running {{mode}} on {{plant}}',
'ui.opt_pv_failed':                'Optimization failed',
'btn.opt_fill_setup_matrix':       'Fill these in the Setup Matrix',
```

Backlog-section rows (`Backlogged orders found`, `Orders moved`, …) are also hardcoded today — move
them too, keys named `ui.opt_backlog_*`.

---

## 8. Bug fixes to fold in

Independent of the redesign, all in `OptimizerPreview`:

1. `var(--danger, #c0392b)` → `var(--err)` in the failure state.
2. Derive Apply's disabled state from `canApply()`; stop `hideLoading()` re-enabling it while stale
   (§5.3).
3. Drop the duplicate `missingPairs` computation in `summarizeCandidate()` (§1.11).
4. Surface `_previewDiagnostics` in Search diagnostics, or delete the field (§1.12).
5. Escape helper: `_render()` defines a local `esc()` while `runWithPreview()`'s catch block does its
   own inline `.replace(/[<>&]/g, …)`. Use one.

---

## 9. Open questions

1. **Score denominator** — `x/3` (targets only) or keep `x/5`? §5.1 recommends `x/3`.
2. **Prune reason codes.** §4.3's five buckets are invented for the prototype. What codes does the
   evaluator actually emit, and should unmapped codes roll into an "Other" bar?
3. **Finalist count.** Three columns assumes the beam keeps ≥3 plans — but no beam exists today (see
   §6's fallback-tier note); the engine is single-pass greedy. Resolved for now as: ship §4.2 as a
   2-column Current/Applied/Alt-B table backed by the existing mode-swap `_finalists` prototype until
   real beam retention is built, rather than leaving Alt C empty or fabricating a third plan.
4. **Backlog mode.** Should the backlog results block become a fourth disclosure section, or stay
   inline above the disclosures? Currently specced inline.
