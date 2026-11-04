// optimization/headless-cli.mts: run the optimizer in a Node process (the Jobs scheduler's runner).
//
//   node frontend/optimization/headless-cli.mjs --phase run   --input bundle.json   (or --input - for stdin)
//   node frontend/optimization/headless-cli.mjs --phase apply --input apply.json
//
// `run` input:   { plant, wire: HeadlessWire, params: RunParams }
//   -> stdout:   { ok, status, patches (TaskDateUpdate items), summary, findings, validation, blockers,
//                  log, state }   `state` is an opaque tagged-JSON string the `apply` phase needs back.
// `apply` input: { plant, runWire, liveWire, state, params, jobId }
//   -> stdout:   { ok, refusal?, apply (items), dropped, findings, body (the /tasks/update body), versions }
//
// One plant per process, started with TZ=<plant timezone> (the engine reads naive plant wall-clock values
// through local Date getters, so the process zone is part of the input; this entry sets TZ itself when the
// caller did not). Log lines stream to stderr as JSON lines and are returned in `log`. Exit code 0 on any
// answer (success or a reported failure); non-zero only when the process itself broke.
//
// The compute core must exist before the engine module loads, so every engine-side import below is dynamic.
import { encodeTagged, decodeTagged } from './headless-codec.mjs';
import type { HeadlessWire } from './headless-snapshot.mjs';
import type { CandidateResult, ScheduleSnapshot, ValidationFinding } from './setup-scheduler.mjs';
import type { TaskDateUpdateItem, DroppedPatch } from './headless-writer.mjs';
import type { OptimizerMode } from '../platform/types.mjs';
import { backlogWindow, budgetFor, isRunMode } from './run-params.mjs';
import type { SerializedOptimizerValidation } from './optimizer-worker-contract.mjs';

/** What the Node runtime provides; `@types/node` is not part of the frontend build. */
interface NodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(text: string, callback?: () => void): void };
  stderr: { write(text: string): void };
  stdin: AsyncIterable<Uint8Array>;
  exit(code: number): never;
}
declare const process: NodeProcess;

export interface RunParams {
  /** 'backlog' is Remove Backlog (Jobs W4b): a schedule repair, not a search; `search` is ignored for it. */
  mode: OptimizerMode;
  search: 'normal' | 'exhaustive';
  /** Backlog only: also move orders already running on the line (the browser's Backlog does; default true). With false
   *  a patch for an order in progress is left out at run time and dropped at apply time. */
  include_running?: boolean;
  /** "Respect planner-firmed orders"; default true. */
  respect_firmed?: boolean;
  respect_calendar?: boolean;
  /** Overrides the plant row's timezone when given (the row stays authoritative otherwise). */
  plantTimezone?: string;
  /** The server's instant, ISO-8601 with zone: the one clock. */
  serverNow: string;
  /** Apply phase only: the server's instant when the LIVE bundle was read. The live snapshot, its derived starts and
   *  the "has it started running since" test use this clock; `serverNow` stays the run's clock and only rebuilds the
   *  run snapshot. Defaults to `serverNow` (same-instant callers, tests). */
  liveServerNow?: string;
  /** Planning horizon in days from now; default 28 (the Optimize dialog's default window). */
  horizonDays?: number;
  lines?: string[];
  /** Absolute iteration cap replacing the scaled default (deterministic runs). */
  iterationCap?: number;
  /** Freeze Date.now at `serverNow` and performance.now at 0: no deadline can fire, so the search ends on
   *  iterations/convergence alone and the same input gives the same output (tests, replays). */
  fakeClock?: boolean;
  /** Reserved: the engine has no random source today, so every run is already seed-free. */
  seed?: number;
}

export interface RunInput { plant: string; wire: HeadlessWire; params: RunParams }

export interface LogEntry { at: string; level: 'info' | 'warn' | 'error'; step: string; msg: string; ms?: number; data?: Record<string, unknown> }
export type LogSink = (entry: LogEntry) => void;

export interface RunSummary {
  patched: number;
  scheduled: number;
  needs_planning: number;
  protected: number;
  late_count: number | null;
  lateness_minutes: number | null;
  setup_minutes: number | null;
  scheduled_count: number | null;
  tool_blocked: number;
  tool_moved: number;
  window_end_held: number;
  termination: string | null;
  search_complete: boolean | null;
  iterations_used: number | null;
  runtime_ms: number | null;
  mode: string;
  search: string;
  plant: string;
  run_now: string | null;
  /** Remove Backlog only: the engine's own diagnostics counts and how many running orders were left out. */
  backlog?: { found: number; moved: number; firmed_moved: number; frozen_moved: number; running_moved: number;
    running_skipped: number; moved_runtime_hours: number; largest_delay_minutes: number; invalid_runtime: number;
    missing_start: number; overlong: number; capacity_failures: number; boundary_conflicts: number;
    window_start: string; window_end: string };
}

export interface RunResult {
  ok: boolean;
  /** 'completed', or the engine's own status ('invalid_horizon') / a runner failure code. */
  status: string;
  patches: TaskDateUpdateItem[];
  summary: RunSummary | null;
  findings: Array<Pick<ValidationFinding, 'code' | 'message' | 'severity' | 'taskId' | 'line'>>;
  /** validateCandidateForApply against the end-of-run snapshot. */
  validation: { findings: ValidationFinding[]; errors: number; warnings: number } | null;
  /** Reasons the caller must NOT apply this result (error findings, tool-blocked orders, invalid horizon, ...). */
  blockers: string[];
  log: LogEntry[];
  /** Tagged JSON: the candidate (without its validation context), the serialized validation bounds and the
   *  planning-clock facts. Hand it back to the `apply` phase unchanged. */
  state: string | null;
  error?: string;
}

interface RunState {
  candidate: Omit<CandidateResult, 'validationContext'>;
  validation: SerializedOptimizerValidation;
  serverNow: string;
  mode: string;
  /** Backlog only (never written for another mode): running orders may be written (see RunParams.include_running). */
  includeRunning?: boolean;
  /** Backlog only: ids of the orders in progress at the run's clock. Apply drops a patched order whose running state
   *  changed since (it started, or finished, between the run and the write). */
  runningIds?: string[];
}

const isoOr = (value: Date | null | undefined): string | null => (value && Number.isFinite(value.getTime()) ? value.toISOString() : null);

/** Install the compute core, the zone, the optional fake clock and the DOM stubs the engine's guards read. */
async function bootstrapRuntime(params: Pick<RunParams, 'plantTimezone' | 'serverNow' | 'fakeClock'>, tzFromRow: string | null): Promise<string | null> {
  const g = globalThis as unknown as Record<string, unknown> & { performance: { now(): number } };
  if (!g.NimbusComputeCore) {
    const { createRequire } = (await import('node:module' as string)) as { createRequire(url: string): (id: string) => unknown };
    g.NimbusComputeCore = createRequire(import.meta.url)('../nimbus-compute-core.js');
  }
  const wanted = params.plantTimezone || tzFromRow;
  if (!process.env.TZ && wanted) process.env.TZ = wanted;
  if (typeof g.window === 'undefined') g.window = {};
  if (typeof g.document === 'undefined') g.document = { getElementById: () => null };
  if (params.fakeClock) {
    const fixed = new Date(params.serverNow).getTime();
    Date.now = (): number => fixed;
    Object.defineProperty(g.performance, 'now', { value: (): number => 0, configurable: true, writable: true });
  }
  return timezoneMismatch(wanted);
}

/** The engine reads naive plant wall-clock values through local Date getters, so a process zone that is not the
 *  plant's zone silently shifts every date: the run is refused, not warned. Compared through canonical IANA names
 *  (an alias such as US/Central is not a mismatch); the zone Node actually resolved counts, not the env string. */
function timezoneMismatch(wanted: string | null): string | null {
  if (!wanted) return null;
  try {
    const canonical = (zone?: string): string => new Intl.DateTimeFormat('en-US', zone ? { timeZone: zone } : {}).resolvedOptions().timeZone;
    const actual = canonical();
    const expected = canonical(wanted);
    // Runtimes spell UTC several ways; those are one zone.
    const utc = (name: string): boolean => /^(UTC|Etc\/UTC|Etc\/GMT|GMT|Etc\/Universal|Universal|Zulu)$/.test(name);
    if (actual === expected || (utc(actual) && utc(expected))) return null;
    return `process timezone ${actual} differs from the plant timezone ${wanted}`;
  } catch {
    return `timezone ${wanted} is not valid`;
  }
}

/** The plant row's timezone, read before the core exists (plain data, no engine). */
function plantTimezoneOf(wire: HeadlessWire, plant: string): string | null {
  const tz = wire.masterData.plants.rows.find(row => row.plant === plant)?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
}

function failure(status: string, error: string, log: LogEntry[]): RunResult {
  return { ok: false, status, patches: [], summary: null, findings: [], validation: null, blockers: [status], log, state: null, error };
}

/** Phase `run`. Any throw outside the evaluator (a malformed bundle, a snapshot or derive failure) is answered as an
 *  `internal_error` result, so the Jobs runner always gets a JSON answer instead of a dead process. */
export async function runOptimizer(input: RunInput, sink: LogSink = () => undefined): Promise<RunResult> {
  const log: LogEntry[] = [];
  try {
    return await runOptimizerImpl(input, sink, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry: LogEntry = { at: new Date().toISOString(), level: 'error', step: 'run', msg: `unexpected failure: ${message}` };
    log.push(entry);
    sink(entry);
    return failure('internal_error', message, log);
  }
}

async function runOptimizerImpl(input: RunInput, sink: LogSink, log: LogEntry[]): Promise<RunResult> {
  const emit = (level: LogEntry['level'], step: string, msg: string, extra: { ms?: number; data?: Record<string, unknown> } = {}): void => {
    const entry: LogEntry = { at: new Date().toISOString(), level, step, msg, ...extra };
    log.push(entry);
    sink(entry);
  };
  const { plant, wire, params } = input;
  const serverNow = new Date(params.serverNow);
  if (!Number.isFinite(serverNow.getTime())) return failure('invalid_server_now', `serverNow is not a valid instant: ${params.serverNow}`, log);
  if (!isRunMode(params.mode)) return failure('invalid_mode', `unsupported mode: ${String(params.mode)}`, log);
  const tz = params.plantTimezone || plantTimezoneOf(wire, plant);
  if (!tz) return failure('plant_no_timezone', `plant ${plant} has no timezone`, log);

  const tzProblem = await bootstrapRuntime(params, tz);
  if (tzProblem) { emit('error', 'bootstrap', tzProblem); return failure('tz_mismatch', tzProblem, log); }
  const { buildScheduleSnapshot } = await import('./headless-snapshot.mjs');
  const { deriveDisplayStarts, quiesceStore } = await import('./headless-runtime.mjs');
  const { patchesToUpdateItems } = await import('./headless-writer.mjs');
  const { evaluateSchedule, Engine } = await import('./engine.mjs');
  const { serializeOptimizerValidation } = await import('./optimizer-worker-contract.mjs');
  const { validateCandidateForApply } = await import('./setup-scheduler.mjs');
  quiesceStore();

  const t0 = performance.now();
  const base = buildScheduleSnapshot(wire, { plant, serverNow });
  emit('info', 'snapshot', `built snapshot: ${base.tasks.length} orders, ${Object.keys(base.calendars).length} lines`, { ms: performance.now() - t0 });
  const t1 = performance.now();
  const snapshot = deriveDisplayStarts(base, { plant, serverNow });
  const baseStart = new Map(base.tasks.map(task => [String(task.id), task.start_date?.getTime()]));
  const derived = snapshot.tasks.filter(task => task.start_date?.getTime() !== baseStart.get(String(task.id))).length;
  emit('info', 'derive', `display starts derived for ${derived} orders`, { ms: performance.now() - t1 });

  // The same dates the Optimize dialog hands the engine: plant "now" floored to the minute as the window start,
  // the absolute server instant as run-at (the engine projects it into the plant zone), 28 days out.
  const core = (globalThis as unknown as { NimbusComputeCore: { plantWallClockFromInstant(tz: string, d: Date): Date | null } }).NimbusComputeCore;
  const plantNow = core.plantWallClockFromInstant(tz, serverNow);
  if (!plantNow) return failure('plant_no_timezone', `timezone ${tz} is not valid`, log);
  const startDate = new Date(plantNow);
  startDate.setSeconds(0, 0);
  const days = params.horizonDays && params.horizonDays > 0 ? params.horizonDays : 28;
  const backlogMode = params.mode === 'backlog';
  const includeRunning = params.include_running !== false;
  const exhaustive = !backlogMode && params.search === 'exhaustive';
  const budget = budgetFor(exhaustive);
  // Remove Backlog's window is the dialog's default (optimize-ui `_applyBacklogDefaults`): from the earliest start in the
  // past to the latest end, capped four calendar months out; a run with nothing in the past starts at now.
  const lineSet = params.lines && params.lines.length ? new Set(params.lines) : null;
  const bw = backlogMode ? backlogWindow(snapshot.tasks, plantNow, lineSet) : null;
  const request = {
    mode: params.mode, plant,
    lines: params.lines && params.lines.length ? params.lines : null,
    startDate: bw ? bw.start : startDate,
    endDate: bw ? bw.end : new Date(plantNow.getTime() + days * 86_400_000), runAt: serverNow,
    respectFirmed: params.respect_firmed ?? true, respectCalendar: backlogMode ? true : (params.respect_calendar ?? true),
    // include_running=false is a TRUE plan-around: orders in progress hold their slot and the rest is placed around them.
    ...(backlogMode && !includeRunning ? { holdRunning: true } : {}),
    deadlineAt: performance.now() + budget, searchBudgetMs: budget, exhaustive,
    ...(params.iterationCap ? { iterationCap: params.iterationCap } : {}),
  };
  emit('info', 'optimize', backlogMode ? `removing backlog (running orders ${params.include_running === false ? 'left alone' : 'included'})`
    : `evaluating ${params.mode} (${params.search}, budget ${budget} ms)`);
  const t2 = performance.now();
  let candidate: CandidateResult;
  try {
    candidate = evaluateSchedule(snapshot, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('error', 'optimize', `evaluation threw: ${message}`);
    return failure('evaluation_failed', message, log);
  }
  emit('info', 'optimize', `search ended: ${candidate.diagnostics.termination}, ${candidate.patches.length} patches`, { ms: performance.now() - t2 });

  const serialized = serializeOptimizerValidation(candidate);
  const validationFindings = validateCandidateForApply(candidate, snapshot, { skipStale: true });
  const errors = validationFindings.filter(f => f.severity === 'error');
  const toolBlocked = backlogMode ? 0 : candidate.toolBlocked?.length ?? 0;
  const blockers: string[] = [];
  if (candidate.status === 'invalid_horizon') blockers.push('invalid_horizon');
  if (!serialized) blockers.push('no_validation_context');
  for (const code of new Set(errors.map(f => f.code))) blockers.push(`finding:${code}`);
  if (toolBlocked) blockers.push(`tool_blocked:${toolBlocked}`);

  // Backlog: which orders are in progress at the run's clock. With include_running=false the engine held them (they are
  // fixed obstacles, never patched), so the offered set IS the candidate's patch set and equals what apply writes; a
  // patch for a running order here would break that, so it blocks the run instead of being quietly filtered.
  const runningIds: string[] = [];
  const runningPatchIds = new Set<string>();
  if (backlogMode) {
    for (const task of snapshot.tasks) if (Engine.isInProgress(task, plantNow)) runningIds.push(String(task.id));
    const running = new Set(runningIds);
    for (const patch of candidate.patches) if (running.has(String(patch.id))) runningPatchIds.add(String(patch.id));
    if (!includeRunning && runningPatchIds.size) blockers.push(`running_patch:${runningPatchIds.size}`);
  }
  const offered = candidate.patches;
  const diag = candidate.backlogResult?.diagnostics;
  const backlog = backlogMode && bw ? {
    found: diag?.backlogFound ?? 0, moved: diag?.moved ?? 0, firmed_moved: diag?.firmedMoved ?? 0, frozen_moved: diag?.frozenMoved ?? 0,
    running_moved: includeRunning ? runningPatchIds.size : 0, running_skipped: includeRunning ? 0 : (diag?.runningHeldIds?.length ?? 0),
    moved_runtime_hours: Math.round((diag?.movedRuntimeHours ?? 0) * 100) / 100, largest_delay_minutes: diag?.largestDelayMinutes ?? 0,
    invalid_runtime: diag?.invalidRuntimeIds.length ?? 0, missing_start: diag?.missingStartIds.length ?? 0, overlong: diag?.overlongIds.length ?? 0,
    capacity_failures: diag?.calendarSearchFailures.length ?? 0, boundary_conflicts: diag?.boundaryConflicts.length ?? 0,
    window_start: bw.start.toISOString(), window_end: bw.end.toISOString(),
  } : undefined;
  const disposition = (status: string): number => candidate.dispositions?.filter(d => d.status === status).length ?? 0;
  const summary: RunSummary = {
    patched: offered.length,
    scheduled: disposition('scheduled'), needs_planning: disposition('needs_planning'), protected: disposition('protected'),
    late_count: candidate.objective?.lateCount ?? null, lateness_minutes: candidate.objective?.latenessMinutes ?? null,
    setup_minutes: candidate.objective?.setupMinutes ?? null, scheduled_count: candidate.objective?.scheduledCount ?? null,
    tool_blocked: toolBlocked, tool_moved: candidate.toolMoved?.length ?? 0, window_end_held: candidate.windowEndHeldIds?.length ?? 0,
    termination: candidate.diagnostics.termination ?? null, search_complete: candidate.searchComplete ?? null,
    iterations_used: candidate.diagnostics.iterationsUsed ?? null, runtime_ms: candidate.diagnostics.runtimeMs ?? null,
    mode: params.mode, search: params.search, plant, run_now: isoOr(serialized ? new Date(serialized.runNow) : null),
    ...(backlog ? { backlog } : {}),
  };
  const { validationContext: _context, ...bare } = candidate;
  const state: RunState | null = serialized
    ? { candidate: bare, validation: serialized, serverNow: params.serverNow, mode: params.mode,
        ...(backlogMode ? { includeRunning, runningIds } : {}) } : null;
  emit(blockers.length ? 'warn' : 'info', 'result', blockers.length ? `blocked: ${blockers.join(', ')}` : 'result is applicable');
  return {
    ok: blockers.length === 0,
    status: candidate.status ?? 'completed',
    patches: patchesToUpdateItems(snapshot.tasks, offered),
    summary,
    findings: (candidate.validationFindings ?? []).map(({ code, message, severity, taskId, line }) => ({ code, message, severity, taskId, line })),
    validation: { findings: validationFindings, errors: errors.length, warnings: validationFindings.length - errors.length },
    blockers,
    log,
    state: state ? encodeTagged(state) : null,
  };
}

export interface ApplyInput {
  plant: string;
  runWire: HeadlessWire;
  liveWire: HeadlessWire;
  state: string;
  params: RunParams;
  jobId: string | number;
}

export interface ApplyResult {
  ok: boolean;
  refusal?: string;
  apply: TaskDateUpdateItem[];
  dropped: DroppedPatch[];
  findings: ValidationFinding[];
  /** The /tasks/update body to POST (atomic, strict conflicts, client_id `job:<id>`); null when not ok. */
  body: ReturnType<typeof import('./headless-writer.mjs').buildApplyBody> | null;
  versions: { calendar_changed: boolean; tool_inventory_changed: boolean };
  log: LogEntry[];
}

/** Phase `apply`: compare version tokens, rebuild the LIVE snapshot, drop what changed, re-validate the rest. */
export async function planApplyFromState(input: ApplyInput, sink: LogSink = () => undefined): Promise<ApplyResult> {
  const log: LogEntry[] = [];
  try {
    return await planApplyImpl(input, sink, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry: LogEntry = { at: new Date().toISOString(), level: 'error', step: 'apply', msg: `unexpected failure: ${message}`, data: { error: message } };
    log.push(entry);
    sink(entry);
    return { ok: false, refusal: 'internal_error', apply: [], dropped: [], findings: [], body: null,
      versions: { calendar_changed: false, tool_inventory_changed: false }, log };
  }
}

async function planApplyImpl(input: ApplyInput, sink: LogSink, log: LogEntry[]): Promise<ApplyResult> {
  const emit = (level: LogEntry['level'], step: string, msg: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = { at: new Date().toISOString(), level, step, msg, ...(data ? { data } : {}) };
    log.push(entry);
    sink(entry);
  };
  const state = decodeTagged(input.state) as RunState;
  const serverNow = new Date(input.params.serverNow);
  const liveNow = new Date(input.params.liveServerNow ?? input.params.serverNow);
  const tz = input.params.plantTimezone || plantTimezoneOf(input.runWire, input.plant) || '';
  const tzProblem = await bootstrapRuntime(input.params, tz || null);
  if (tzProblem) emit('error', 'bootstrap', tzProblem);
  const { buildScheduleSnapshot } = await import('./headless-snapshot.mjs');
  const { deriveDisplayStarts, quiesceStore } = await import('./headless-runtime.mjs');
  const { patchesToUpdateItems, planApply, buildApplyBody } = await import('./headless-writer.mjs');
  const { rehydrateOptimizerCandidate } = await import('./engine.mjs');
  quiesceStore();

  const empty = (refusal: string, extra: Partial<ApplyResult> = {}): ApplyResult => ({
    ok: false, refusal, apply: [], dropped: [], findings: [], body: null,
    versions: { calendar_changed: false, tool_inventory_changed: false }, log, ...extra,
  });
  if (tzProblem) return empty('tz_mismatch');
  if (!tz) return empty('plant_no_timezone');
  if (!Number.isFinite(serverNow.getTime()) || !Number.isFinite(liveNow.getTime())) return empty('invalid_server_now');
  // The run's own bundle gives the run snapshot back exactly (same builder, same derivation, same clock).
  const runSnapshot: ScheduleSnapshot = deriveDisplayStarts(
    buildScheduleSnapshot(input.runWire, { plant: input.plant, serverNow }), { plant: input.plant, serverNow });
  const candidate = rehydrateOptimizerCandidate(state.candidate as CandidateResult, runSnapshot, state.validation);
  // Version tokens: a plant calendar or tool inventory edit since the run changes what is legal (they have no
  // per-row version), so it refuses the whole apply rather than guessing which orders it touched.
  const runV = input.runWire.horizons ?? {}; const liveV = input.liveWire.horizons ?? {};
  const versions = {
    calendar_changed: (runV.calendar_version ?? null) !== (liveV.calendar_version ?? null)
      || (input.runWire.calendar?.calendar_version ?? null) !== (input.liveWire.calendar?.calendar_version ?? null),
    tool_inventory_changed: (runV.tool_inventory_version ?? null) !== (liveV.tool_inventory_version ?? null),
  };
  if (versions.calendar_changed) { emit('warn', 'guard', 'plant calendar changed since the run'); return empty('calendar_changed', { versions }); }
  if (versions.tool_inventory_changed) { emit('warn', 'guard', 'tool inventory changed since the run'); return empty('tool_inventory_changed', { versions }); }

  // The live board is read at the live clock: an order that started running since the run must read as running.
  const liveSnapshot = deriveDisplayStarts(
    buildScheduleSnapshot(input.liveWire, { plant: input.plant, serverNow: liveNow }), { plant: input.plant, serverNow: liveNow });
  const core = (globalThis as unknown as { NimbusComputeCore: { plantWallClockFromInstant(tz: string, d: Date): Date | null } }).NimbusComputeCore;
  const now = core.plantWallClockFromInstant(tz, liveNow);
  if (!now) return empty('plant_no_timezone');
  // Only Remove Backlog may write an order that is running (the browser's Backlog does); every other mode drops it.
  const includeRunning = state.mode === 'backlog' && state.includeRunning !== false;
  const plan = planApply({ plant: input.plant, candidate, runSnapshot, liveSnapshot, now, includeRunning,
    ...(state.mode === 'backlog' ? { useRunFirmed: true } : {}),
    ...(state.mode === 'backlog' && state.runningIds ? { runningAtRun: new Set(state.runningIds) } : {}) });
  emit(plan.ok ? 'info' : 'warn', 'guard', `apply ${plan.apply.length} of ${candidate.patches.length} patches, dropped ${plan.dropped.length}`,
    { dropped: plan.dropped.map(d => `${d.id}:${d.reason}`) });
  // Items carry the LIVE row version: that is the token the server compares, and a changed row was dropped above.
  const items = patchesToUpdateItems(liveSnapshot.tasks, plan.apply);
  return {
    ok: plan.ok, ...(plan.refusal ? { refusal: plan.refusal } : {}),
    apply: items, dropped: plan.dropped, findings: plan.findings,
    body: plan.ok && items.length ? buildApplyBody(items, input.jobId) : null,
    versions, log,
  };
}

async function readInput(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return new TextDecoder().decode(all);
  }
  const { readFileSync } = (await import('node:fs' as string)) as { readFileSync(path: string, enc: string): string };
  return readFileSync(path, 'utf8');
}

/** Exit only after stdout has flushed: a multi-MB result written to a pipe must not be cut by `process.exit`. */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help')) {
    process.stdout.write('usage: headless-cli --phase run|apply [--input file|-]   (JSON in, one JSON result on stdout)\n');
    return 0;
  }
  const phase = arg('phase') ?? 'run';
  // A typo must not silently run the other phase (an `aply` would start a full optimizer run).
  if (phase !== 'run' && phase !== 'apply') {
    process.stderr.write(`unknown phase: ${phase} (expected run or apply)\n`);
    return 2;
  }
  const input = JSON.parse(await readInput(arg('input') ?? '-')) as RunInput & ApplyInput;
  const sink: LogSink = entry => process.stderr.write(`${JSON.stringify(entry)}\n`);
  const result = phase === 'apply' ? await planApplyFromState(input, sink) : await runOptimizer(input, sink);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

// Run only when this file is the process entry (importing it from a test must stay inert).
if (typeof process !== 'undefined' && /headless-cli\.m?js$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(exitAfterFlush, error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    exitAfterFlush(1);
  });
}
