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
import type { SerializedOptimizerValidation } from './optimizer-worker-contract.mjs';

/** What the Node runtime provides; `@types/node` is not part of the frontend build. */
interface NodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  stdin: AsyncIterable<Uint8Array>;
  exit(code: number): never;
}
declare const process: NodeProcess;

export interface RunParams {
  mode: Exclude<OptimizerMode, 'backlog'>;
  search: 'normal' | 'exhaustive';
  /** "Respect planner-firmed orders"; default true. */
  respect_firmed?: boolean;
  respect_calendar?: boolean;
  /** Overrides the plant row's timezone when given (the row stays authoritative otherwise). */
  plantTimezone?: string;
  /** The server's instant, ISO-8601 with zone: the one clock. */
  serverNow: string;
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
}

const isoOr = (value: Date | null | undefined): string | null => (value && Number.isFinite(value.getTime()) ? value.toISOString() : null);

/** Install the compute core, the zone, the optional fake clock and the DOM stubs the engine's guards read. */
async function bootstrapRuntime(params: Pick<RunParams, 'plantTimezone' | 'serverNow' | 'fakeClock'>, tzFromRow: string | null, warn: (msg: string) => void): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown> & { performance: { now(): number } };
  if (!g.NimbusComputeCore) {
    const { createRequire } = (await import('node:module' as string)) as { createRequire(url: string): (id: string) => unknown };
    g.NimbusComputeCore = createRequire(import.meta.url)('../nimbus-compute-core.js');
  }
  const wanted = params.plantTimezone || tzFromRow;
  if (!process.env.TZ && wanted) process.env.TZ = wanted;
  else if (process.env.TZ && wanted && process.env.TZ !== wanted) {
    warn(`process TZ ${process.env.TZ} differs from the plant timezone ${wanted}`);
  }
  if (typeof g.window === 'undefined') g.window = {};
  if (typeof g.document === 'undefined') g.document = { getElementById: () => null };
  if (params.fakeClock) {
    const fixed = new Date(params.serverNow).getTime();
    Date.now = (): number => fixed;
    Object.defineProperty(g.performance, 'now', { value: (): number => 0, configurable: true, writable: true });
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

/** Phase `run`: build the snapshot, derive display starts, evaluate, map the result. */
export async function runOptimizer(input: RunInput, sink: LogSink = () => undefined): Promise<RunResult> {
  const log: LogEntry[] = [];
  const emit = (level: LogEntry['level'], step: string, msg: string, extra: { ms?: number; data?: Record<string, unknown> } = {}): void => {
    const entry: LogEntry = { at: new Date().toISOString(), level, step, msg, ...extra };
    log.push(entry);
    sink(entry);
  };
  const { plant, wire, params } = input;
  const serverNow = new Date(params.serverNow);
  if (!Number.isFinite(serverNow.getTime())) return failure('invalid_server_now', `serverNow is not a valid instant: ${params.serverNow}`, log);
  if (!['duedate', 'changeover', 'spt'].includes(params.mode)) return failure('invalid_mode', `unsupported mode: ${String(params.mode)}`, log);
  const tz = params.plantTimezone || plantTimezoneOf(wire, plant);
  if (!tz) return failure('plant_no_timezone', `plant ${plant} has no timezone`, log);

  await bootstrapRuntime(params, tz, msg => emit('warn', 'bootstrap', msg));
  const { buildScheduleSnapshot } = await import('./headless-snapshot.mjs');
  const { deriveDisplayStarts, quiesceStore } = await import('./headless-runtime.mjs');
  const { patchesToUpdateItems } = await import('./headless-writer.mjs');
  const { SETUP_AWARE_NORMAL_BUDGET_MS, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS, evaluateSchedule } = await import('./engine.mjs');
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
  const exhaustive = params.search === 'exhaustive';
  const budget = exhaustive ? SETUP_AWARE_EXHAUSTIVE_BUDGET_MS : SETUP_AWARE_NORMAL_BUDGET_MS;
  const request = {
    mode: params.mode, plant,
    lines: params.lines && params.lines.length ? params.lines : null,
    startDate, endDate: new Date(plantNow.getTime() + days * 86_400_000), runAt: serverNow,
    respectFirmed: params.respect_firmed ?? true, respectCalendar: params.respect_calendar ?? true,
    deadlineAt: performance.now() + budget, searchBudgetMs: budget, exhaustive,
    ...(params.iterationCap ? { iterationCap: params.iterationCap } : {}),
  };
  emit('info', 'optimize', `evaluating ${params.mode} (${params.search}, budget ${budget} ms)`);
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
  const validationFindings = validateCandidateForApply(candidate, snapshot);
  const errors = validationFindings.filter(f => f.severity === 'error');
  const toolBlocked = candidate.toolBlocked?.length ?? 0;
  const blockers: string[] = [];
  if (candidate.status === 'invalid_horizon') blockers.push('invalid_horizon');
  if (!serialized) blockers.push('no_validation_context');
  for (const code of new Set(errors.map(f => f.code))) blockers.push(`finding:${code}`);
  if (toolBlocked) blockers.push(`tool_blocked:${toolBlocked}`);

  const disposition = (status: string): number => candidate.dispositions?.filter(d => d.status === status).length ?? 0;
  const summary: RunSummary = {
    patched: candidate.patches.length,
    scheduled: disposition('scheduled'), needs_planning: disposition('needs_planning'), protected: disposition('protected'),
    late_count: candidate.objective?.lateCount ?? null, lateness_minutes: candidate.objective?.latenessMinutes ?? null,
    setup_minutes: candidate.objective?.setupMinutes ?? null, scheduled_count: candidate.objective?.scheduledCount ?? null,
    tool_blocked: toolBlocked, tool_moved: candidate.toolMoved?.length ?? 0, window_end_held: candidate.windowEndHeldIds?.length ?? 0,
    termination: candidate.diagnostics.termination ?? null, search_complete: candidate.searchComplete ?? null,
    iterations_used: candidate.diagnostics.iterationsUsed ?? null, runtime_ms: candidate.diagnostics.runtimeMs ?? null,
    mode: params.mode, search: params.search, plant, run_now: isoOr(serialized ? new Date(serialized.runNow) : null),
  };
  const { validationContext: _context, ...bare } = candidate;
  const state: RunState | null = serialized ? { candidate: bare, validation: serialized, serverNow: params.serverNow, mode: params.mode } : null;
  emit(blockers.length ? 'warn' : 'info', 'result', blockers.length ? `blocked: ${blockers.join(', ')}` : 'result is applicable');
  return {
    ok: blockers.length === 0,
    status: candidate.status ?? 'completed',
    patches: patchesToUpdateItems(snapshot.tasks, candidate.patches),
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
  const emit = (level: LogEntry['level'], step: string, msg: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = { at: new Date().toISOString(), level, step, msg, ...(data ? { data } : {}) };
    log.push(entry);
    sink(entry);
  };
  const state = decodeTagged(input.state) as RunState;
  const serverNow = new Date(input.params.serverNow);
  const tz = input.params.plantTimezone || plantTimezoneOf(input.runWire, input.plant) || '';
  await bootstrapRuntime(input.params, tz, msg => emit('warn', 'bootstrap', msg));
  const { buildScheduleSnapshot } = await import('./headless-snapshot.mjs');
  const { deriveDisplayStarts, quiesceStore } = await import('./headless-runtime.mjs');
  const { patchesToUpdateItems, planApply, buildApplyBody } = await import('./headless-writer.mjs');
  const { rehydrateOptimizerCandidate } = await import('./engine.mjs');
  quiesceStore();

  const empty = (refusal: string, extra: Partial<ApplyResult> = {}): ApplyResult => ({
    ok: false, refusal, apply: [], dropped: [], findings: [], body: null,
    versions: { calendar_changed: false, tool_inventory_changed: false }, log, ...extra,
  });
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

  const liveSnapshot = deriveDisplayStarts(
    buildScheduleSnapshot(input.liveWire, { plant: input.plant, serverNow }), { plant: input.plant, serverNow });
  const core = (globalThis as unknown as { NimbusComputeCore: { plantWallClockFromInstant(tz: string, d: Date): Date | null } }).NimbusComputeCore;
  const now = core.plantWallClockFromInstant(tz, serverNow) ?? serverNow;
  const plan = planApply({ candidate, runSnapshot, liveSnapshot, now });
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

async function main(argv: string[]): Promise<void> {
  const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help')) {
    process.stdout.write('usage: headless-cli --phase run|apply [--input file|-]   (JSON in, one JSON result on stdout)\n');
    return;
  }
  const phase = arg('phase') ?? 'run';
  const input = JSON.parse(await readInput(arg('input') ?? '-')) as RunInput & ApplyInput;
  const sink: LogSink = entry => process.stderr.write(`${JSON.stringify(entry)}\n`);
  const result = phase === 'apply' ? await planApplyFromState(input, sink) : await runOptimizer(input, sink);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run only when this file is the process entry (importing it from a test must stay inert).
if (typeof process !== 'undefined' && /headless-cli\.m?js$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then(() => process.exit(0), error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
