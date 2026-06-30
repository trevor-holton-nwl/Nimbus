export const meta = {
  name: 'nimbus-full-audit',
  description: 'Examine entire NIMBUS codebase: verify CLAUDE.md accuracy, find perf issues, UI improvements, and moonshots',
  phases: [
    { title: 'Examine', detail: 'parallel readers over every code slice' },
    { title: 'Verify', detail: 'adversarially re-check doc-drift, bugs, high-impact perf against live code' },
    { title: 'Synthesize', detail: 'CLAUDE.md edits + perf + UI + moonshot deliverables' },
  ],
}

const BASE = 'C:/Users/PJ29587/OneDrive - Newell Brands/Documents/AI_ML Testing/Claude'

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slice', 'summary', 'docDrift', 'perf', 'ui', 'bugs', 'notes'],
  properties: {
    slice: { type: 'string' },
    summary: { type: 'string' },
    docDrift: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['claim', 'reality', 'location', 'severity', 'suggestedFix'],
      properties: {
        claim: { type: 'string', description: 'the CLAUDE.md statement that is wrong/outdated/missing' },
        reality: { type: 'string' }, location: { type: 'string', description: 'file:line' },
        severity: { enum: ['high', 'med', 'low'] }, suggestedFix: { type: 'string' } } } },
    perf: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'location', 'problem', 'impact', 'effort', 'area', 'recommendation'],
      properties: {
        title: { type: 'string' }, location: { type: 'string' }, problem: { type: 'string' },
        impact: { enum: ['high', 'med', 'low'] }, effort: { enum: ['high', 'med', 'low'] },
        area: { enum: ['frontend', 'backend'] }, recommendation: { type: 'string' } } } },
    ui: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'location', 'problem', 'recommendation', 'impact'],
      properties: { title: { type: 'string' }, location: { type: 'string' }, problem: { type: 'string' },
        recommendation: { type: 'string' }, impact: { enum: ['high', 'med', 'low'] } } } },
    bugs: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'location', 'problem', 'severity'],
      properties: { title: { type: 'string' }, location: { type: 'string' }, problem: { type: 'string' },
        severity: { enum: ['high', 'med', 'low'] } } } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['claim', 'category', 'verdict', 'evidence'],
    properties: {
      claim: { type: 'string' }, category: { enum: ['docDrift', 'bug', 'perf'] },
      verdict: { enum: ['confirmed', 'refuted', 'partial'] },
      evidence: { type: 'string', description: 'quoted real code with file:line' },
      correctedNote: { type: 'string' } } } } },
}

const CLAUDEMD_EDITS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['edits', 'additions'],
  properties: {
    edits: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['currentText', 'newText', 'reason'],
      properties: { currentText: { type: 'string', description: 'EXACT substring copied verbatim from CLAUDE.md to replace' },
        newText: { type: 'string' }, reason: { type: 'string' } } } },
    additions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['anchorText', 'content', 'reason'],
      properties: { anchorText: { type: 'string', description: 'exact CLAUDE.md substring after which to insert' },
        content: { type: 'string' }, reason: { type: 'string' } } } },
  },
}

const SLICES = [
  { key: 'backend-api', label: 'Backend FastAPI endpoints (brain.py)',
    files: 'brain.py (1270 lines, ~30 endpoints)', read: 'Read brain.py in full.' },
  { key: 'backend-db', label: 'Data layer + schema (db.py, schema.sql, migration_perf.sql)',
    files: 'db.py (1025), schema.sql (273), migration_perf.sql',
    read: 'Read db.py, schema.sql, and migration_perf.sql in full. Pay attention to query patterns, indexes, transactions, connection pool, make_id().' },
  { key: 'backend-masterdata', label: 'Master-data layer (master_data.py)',
    files: 'master_data.py (663)', read: 'Read master_data.py in full. Check dynamic SQL safety (psycopg.sql.Identifier), pagination/filtering for plants/lines.' },
  { key: 'fe-foundation', label: 'Frontend Foundation/State/Domain: Config, Util, Store, Calendar',
    files: 'app.js lines 55-1352', read: 'Read app.js lines 55 to 1360.' },
  { key: 'fe-masterdata-ui', label: 'Frontend Master-data UI: Plant, ProdLines, LaborPlanning',
    files: 'app.js lines 1352-3410', read: 'Read app.js lines 1352 to 3415.' },
  { key: 'fe-engine', label: 'Frontend compute core: Compute(worker wrapper), Alerts, Utilization, Engine',
    files: 'app.js lines 3410-5188', read: 'Read app.js lines 3410 to 5195.' },
  { key: 'fe-render1', label: 'Frontend infra+render: ErrorLog, Toast, Modal, Timeline, Table',
    files: 'app.js lines 5188-6740', read: 'Read app.js lines 5188 to 6745.' },
  { key: 'fe-render2', label: 'Frontend render: Inspector, Hierarchy, Dashboard, TimelineNav, GanttFilter, DependencyOverlay, ContextMenu, Selection',
    files: 'app.js lines 6740-8748', read: 'Read app.js lines 6740 to 8755.' },
  { key: 'fe-interaction', label: 'Frontend UndoStack, Sandbox, Interaction',
    files: 'app.js lines 8748-10239', read: 'Read app.js lines 8748 to 10245.' },
  { key: 'fe-persistence-admin', label: 'Frontend Persistence + AdminCockpit',
    files: 'app.js lines 10239-13113', read: 'Read app.js lines 10239 to 13120.' },
  { key: 'fe-boot', label: 'Frontend Printer, PlantSelector, App (boot/tab switching)',
    files: 'app.js lines 13113-15097', read: 'Read app.js lines 13113 to 15097.' },
  { key: 'fe-intelligence', label: 'Intelligence layer (nimbus-intelligence.js)',
    files: 'nimbus-intelligence.js (2141)', read: 'Read nimbus-intelligence.js in full. Modules: CommandPalette, NeedsEngine, TimeMachine, Confidence, RipplePreview, Diff, Patterns, Voice, Haptic, DarkMode.' },
  { key: 'fe-worker', label: 'Web Worker (nimbus-worker.js) + sync-drift with app.js',
    files: 'nimbus-worker.js (482)', read: 'Read nimbus-worker.js in full, then Grep app.js for the duplicated constants/helpers (OVERLOAD_THRESHOLD, DEFAULT_SHIFT, parseDate, dayKey) to check they are still in sync.' },
  { key: 'ui-css', label: 'Styling / design system (styles.css) — UI FEEL focus',
    files: 'styles.css (4912)', read: 'Read styles.css — focus on the design-token system, dark-mode layer, Flatpickr theme overrides, and overall visual craft. Sample broadly (read the token :root block, several component blocks, and the bottom). This slice is the primary source for the UI-feel deliverable, so be generous with ui findings.' },
  { key: 'ui-html', label: 'Markup / structure / CDN deps (index.html) — UI + load perf',
    files: 'index.html (2408)', read: 'Read index.html — focus on document structure, inline <style> (~850 lines not yet in styles.css), CDN script/link tags (versioning, render-blocking), accessibility (aria, semantic tags, focus), and NIMBUS_BUILD_ID vs APP_VERSION.' },
]

function readerPrompt(s) {
  return `You are a senior engineer auditing NIMBUS, a production-scheduling web app (FastAPI backend in brain.py/db.py/master_data.py; vanilla-JS frontend in app.js + nimbus-intelligence.js + nimbus-worker.js; styles.css; index.html). All files are under: ${BASE}

STEP 1 — Read the project guide ${BASE}/CLAUDE.md IN FULL (~187 lines). It states the intended architecture and makes specific factual claims about the code.

STEP 2 — Examine THIS slice only: ${s.label}
Files: ${s.files}
${s.read}
Use Grep/Read to follow references when needed, but keep findings scoped to this slice.

Report a structured object:
- summary: 2-4 sentences on what this code actually does.
- docDrift: places where CLAUDE.md is INACCURATE, OUTDATED, or SILENT about something significant in THIS slice. Quote the exact CLAUDE.md claim and the contradicting reality with file:line. Report ONLY genuine discrepancies — never invent drift. CLAUDE.md being silent about a meaningful module/endpoint/behavior = a 'missing' drift (severity low/med).
- perf: concrete performance problems (file:line, the cost, impact, effort, frontend/backend, specific fix). Hunt real hotspots: N+1 / repeated full-table queries, missing indexes, per-request recompute with no cache, layout thrash / forced reflow, large structured-clone over postMessage, unbounded loops, O(n^2) scans, sync work blocking the main thread, re-rendering whole DOM subtrees, redundant network calls.
- ui: UX / visual / interaction / accessibility issues in this slice with a concrete recommendation.
- bugs: correctness issues or latent bugs with severity.
- notes: anything else notable — new modules/endpoints/behaviors CLAUDE.md omits, dead code, security concerns, scalability risks vs the 50+ plants / 3,500+ lines roadmap in CLAUDE.md.

Cite file:line for EVERYTHING and quote the relevant code. Be precise and evidence-based. Your structured object IS the deliverable — no prose preamble.`
}

function verifierPrompt(s, claims) {
  return `You are an ADVERSARIAL verifier checking an auditor's claims about the NIMBUS codebase (slice: ${s.label}). Files under: ${BASE}

Auditors here are known to misread code or flag already-fixed items — roughly half of raw findings are wrong. Your job is to re-open the cited code and CONFIRM or REFUTE each claim by reading the ACTUAL lines. Default to 'refuted' or 'partial' unless the real code clearly supports the claim. Quote the actual code you find.

Claims to verify (JSON):
${JSON.stringify(claims, null, 1)}

For each claim return: claim (short echo), category, verdict (confirmed | refuted | partial), evidence (quote the real code with file:line), and correctedNote (for partial/refuted: what is actually true). Open every cited location — do not trust the claim's own quote.`
}

// ---- Phase 1+2: read each slice, then adversarially verify its high-stakes claims (pipeline, no barrier) ----
const sliceResults = await pipeline(
  SLICES,
  (s) => agent(readerPrompt(s), { schema: FINDINGS_SCHEMA, phase: 'Examine', label: `read:${s.key}` }),
  async (findings, s) => {
    if (!findings) return null
    const claims = [
      ...findings.docDrift.map(d => ({ category: 'docDrift', claim: d.claim, reality: d.reality, location: d.location })),
      ...findings.bugs.map(b => ({ category: 'bug', claim: b.title + ' — ' + b.problem, location: b.location })),
      ...findings.perf.filter(p => p.impact === 'high').map(p => ({ category: 'perf', claim: p.title + ' — ' + p.problem, location: p.location })),
    ]
    if (claims.length === 0) return { ...findings, verdicts: [] }
    const v = await agent(verifierPrompt(s, claims), { schema: VERDICTS_SCHEMA, phase: 'Verify', label: `verify:${s.key}`, effort: 'high' })
    return { ...findings, verdicts: (v && v.verdicts) || [] }
  },
)

const clean = sliceResults.filter(Boolean)
log(`Examined ${clean.length}/${SLICES.length} slices. Findings: ` +
  `${clean.reduce((n, r) => n + r.docDrift.length, 0)} doc-drift, ` +
  `${clean.reduce((n, r) => n + r.perf.length, 0)} perf, ` +
  `${clean.reduce((n, r) => n + r.ui.length, 0)} ui, ` +
  `${clean.reduce((n, r) => n + r.bugs.length, 0)} bugs.`)

const digest = JSON.stringify(clean, null, 1)

// ---- Phase 3: four synthesizers, each owns one deliverable, all see the full verified digest ----
phase('Synthesize')

const [claudeMdEdits, perfReport, uiReport, moonshotReport] = await parallel([
  () => agent(
    `You maintain ${BASE}/CLAUDE.md for the NIMBUS project. First READ ${BASE}/CLAUDE.md in full so you can copy exact substrings.

Below are verified audit findings (each slice has a 'verdicts' array; only docDrift items with verdict 'confirmed' or 'partial' are trustworthy — IGNORE 'refuted' ones and any docDrift not backed by a verdict).

VERIFIED FINDINGS:
${digest}

Produce precise CLAUDE.md updates:
- edits: for each confirmed/partial doc-drift, give currentText = an EXACT verbatim substring of the CURRENT CLAUDE.md (copy it character-for-character, including punctuation; keep it short but unique enough to match exactly), newText = the corrected replacement, and reason.
- additions: net-new documentation for significant modules/endpoints/behaviors CLAUDE.md currently omits — anchorText = exact substring after which to insert, content = the markdown to add, reason.

Match CLAUDE.md's existing voice, terseness, and formatting (tables where it uses tables). Do NOT bloat — only material corrections that a future engineer would be misled without. It is fine to return few or zero edits if CLAUDE.md is already accurate.`,
    { schema: CLAUDEMD_EDITS_SCHEMA, label: 'synth:claude-md' }),

  () => agent(
    `You are a performance architect. From the VERIFIED audit findings below, produce the PERFORMANCE RECOMMENDATIONS deliverable for NIMBUS. Trust 'confirmed'/'partial' verdicts; treat 'refuted' perf items skeptically (mention only if you independently believe them). You may Read code under ${BASE} to confirm specifics.

Keep in mind NIMBUS's scale roadmap (50+ plants, 70+ lines/plant, 3,500+ lines total) — weight recommendations that matter at scale.

VERIFIED FINDINGS:
${digest}

Output GitHub-flavored markdown. Split into "## Backend" and "## Frontend". Dedupe overlapping findings across slices. For each recommendation: a bold one-line title, then Impact (High/Med/Low) · Effort (S/M/L), the problem with file:line evidence, and the concrete fix. Order each section by impact-to-effort ratio (quick high-impact wins first). End with a short "Quick wins (do this week)" bullet list of the top 5. Be concrete and code-specific, not generic advice.`,
    { label: 'synth:perf' }),

  () => agent(
    `You are a senior product designer with strong frontend-craft taste. From the VERIFIED audit findings below, plus your own reading of ${BASE}/styles.css and ${BASE}/index.html, produce the "MAKE THE UI FEEL EXCEPTIONALLY BETTER" deliverable for NIMBUS (a dense, data-heavy manufacturing scheduling tool: Gantt timeline, AG-Grid orders table, dashboard, calendar manager; amber design-token system with dark mode; Flatpickr for all date inputs).

VERIFIED FINDINGS:
${digest}

Output GitHub-flavored markdown. Cover, with concrete and specific suggestions (reference real selectors/files where possible):
1. Visual hierarchy, typography, spacing & density tuning for an information-dense ops tool
2. Motion & micro-interactions (drag feedback on the Gantt, optimistic updates, transitions) — purposeful, not decorative
3. Feedback & state: loading/skeleton/empty/error states, optimistic UI, undo affordances
4. Color, contrast & dark-mode polish; accessibility (focus rings, keyboard nav, ARIA, WCAG contrast)
5. The "exceptional" tier: 3-5 signature touches that would make schedulers say "this feels premium" (e.g. command palette discoverability, smart defaults, density toggle, keyboard-first flows)
Group as "## Foundational polish" (table-stakes fixes) and "## Signature touches" (the wow tier). Tie each to a real file/selector and explain the felt difference. Prioritize impact.`,
    { label: 'synth:ui' }),

  () => agent(
    `You are a principal engineer/PM. First skim ${BASE}/docs/archive/NIMBUS_VISION.md (892 lines) for product context and ${BASE}/CLAUDE.md for current capabilities. Then, using the VERIFIED audit findings below, propose MOONSHOT ADDITIONS that would add substantive value to NIMBUS.

VERIFIED FINDINGS:
${digest}

NIMBUS today is a manual scheduling/visualization tool whose "optimization" is admittedly just dispatching heuristics (no changeover-cost matrix, no finite-capacity constraints, no precedence enforcement). Scale target: 50+ plants, 3,500+ lines.

Output GitHub-flavored markdown: 5-8 moonshots, each as "### <name>" with: the value proposition, what it would take (rough scope, leaning on the EXISTING architecture — Postgres, the worker, the Engine, the intelligence layer), why it's high-leverage now, and a rough difficulty (S/M/L/XL). Bias toward ideas that exploit assets NIMBUS already has (structured order data in Postgres, the what-if Sandbox, the Compute worker, the CommandPalette/NeedsEngine intelligence layer). Include at least one genuine optimization-engine moonshot (real constraint solver) and one AI/ML moonshot grounded in the data they actually have. Be ambitious but technically credible — no vaporware.`,
    { label: 'synth:moonshot' }),
])

return {
  stats: {
    slicesExamined: clean.length,
    docDrift: clean.reduce((n, r) => n + r.docDrift.length, 0),
    perf: clean.reduce((n, r) => n + r.perf.length, 0),
    ui: clean.reduce((n, r) => n + r.ui.length, 0),
    bugs: clean.reduce((n, r) => n + r.bugs.length, 0),
  },
  bugs: clean.flatMap(r => r.bugs.map(b => ({ slice: r.slice, ...b,
    verdict: (r.verdicts.find(v => v.category === 'bug' && v.claim.includes(b.title.slice(0, 20))) || {}).verdict || 'unverified' }))),
  claudeMdEdits,
  perfReport,
  uiReport,
  moonshotReport,
}
