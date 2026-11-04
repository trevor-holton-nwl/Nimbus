// Detached optimizer preview worker client. The worker is an optional UI
// acceleration path: callers without Worker support (tests, server-side
// tooling, and non-UI integrations) keep the synchronous Engine evaluator.
import type { CandidateResult, ScheduleSnapshot } from './setup-scheduler.mjs';
import type { EngineEvaluationRequest } from './scheduler-contract.mjs';
import { evaluateSchedule, rehydrateOptimizerCandidate, SETUP_AWARE_NORMAL_BUDGET_MS } from './engine.mjs';
import { Config, ErrorLog, PerfMonitor, Util } from '../platform/foundation.mjs';
import { evalRequestOf } from './optimizer-worker-contract.mjs';
import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';
export type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';

export interface OptimizerWorkerLike {
  onmessage: ((event: MessageEvent<OptimizerWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  /** A message the worker posted could not be deserialised here (optional: older fakes omit it). */
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: OptimizerWorkerRequest): void;
  terminate(): void;
}

export type OptimizerWorkerFactory = (url: string) => OptimizerWorkerLike | null;

function workerRequestWithRemainingDeadline(request: OptimizerWorkerRequest): OptimizerWorkerRequest {
  const duration = request.deadlineDurationMs === undefined
    ? Number.isFinite(request.request.deadlineAt)
      ? Math.max(0, Number(request.request.deadlineAt) - performance.now())
      : undefined
    : request.deadlineDurationMs;
  if (duration === undefined) return request;
  if (!Number.isFinite(duration)) throw new TypeError('Optimizer preview received an invalid deadline duration.');
  return {
    ...request,
    deadlineDurationMs: duration,
    request: { ...request.request, deadlineAt: undefined },
  };
}

/** Thrown by the detached scheduler when dated plant periods exist but the realm's compute core predates them. */
const COMPUTE_CORE_STALE = 'compute-core-stale';
let _staleCoreWarned = false;

/** An exhaustive / background request: it carries `exhaustive` or a budget above the Normal one (up to 180 s). Run
 *  synchronously on the main thread it would freeze the page for that long and ignore the AbortSignal, so a stale
 *  worker core must fail such a run instead of falling back (the foreground Normal run keeps the fallback). */
function isLongRunRequest(request: OptimizerWorkerRequest): boolean {
  const r = request.request;
  return r?.exhaustive === true || Number(r?.searchBudgetMs) > SETUP_AWARE_NORMAL_BUDGET_MS;
}

function staleCoreError(): Error {
  const error = new Error(Util.t('toast.opt_bg_stale_core'));
  error.name = 'OptimizerCoreStale';
  return error;
}

function abortError(): Error {
  const error = new Error('Optimizer preview was cancelled.');
  error.name = 'AbortError';
  return error;
}

function defaultWorkerFactory(url: string): OptimizerWorkerLike | null {
  if (typeof Worker !== 'function') return null;
  return new Worker(url, { type: 'module' });
}

export interface OptimizerWorkerSessionOptions {
  /** Inject a fake worker in tests or an application-specific worker pool. */
  workerFactory?: OptimizerWorkerFactory | null;
  /** Explicitly retain the synchronous path when a caller needs it. */
  syncEvaluator?: (snapshot: ScheduleSnapshot, request: EngineEvaluationRequest) => CandidateResult;
  workerUrl?: string;
  /** Most workers alive at once (default 1). Requests beyond that wait in a queue, one request per worker. */
  maxWorkers?: number;
  /** Keep a worker alive after its request finishes so the next request skips the boot (default true). */
  keepAlive?: boolean;
  /** Aborting it terminates every worker and rejects every request still waiting or running. */
  signal?: AbortSignal;
}

export interface OptimizerWorkerSessionRunOptions {
  signal?: AbortSignal;
  /** The caller reads only `patches`/score facts (an alternate's KPIs): the worker skips the validation serialization
   *  and the client returns the candidate without a `validationContext`. Ignored on the synchronous path. */
  kpiOnly?: boolean;
}

export interface OptimizerWorkerSession {
  run(request: OptimizerWorkerRequest, options?: OptimizerWorkerSessionRunOptions): CandidateResult | Promise<CandidateResult>;
  /** Boot idle workers ahead of use (up to `maxWorkers`), so their start overlaps another request. A failed spawn is ignored. */
  prewarm(count: number): void;
  /** Terminate every worker and reject whatever is still waiting or running. Safe to call twice. */
  close(): void;
  /** True while a request would go to a worker: a factory exists, no spawn has failed to yield one, the core is not stale. */
  readonly workerBacked: boolean;
  readonly stats: { spawned: number; terminated: number };
}

interface SessionPending {
  request: OptimizerWorkerRequest;
  kpiOnly: boolean;
  long: boolean;
  signal?: AbortSignal;
  resolve: (candidate: CandidateResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
  postedAt: number;
}

interface SessionSlot {
  worker: OptimizerWorkerLike;
  pending: SessionPending | null;
  spawnedAt: number;
  runs: number;
  dead: boolean;
  /** Spawned ahead of its first request (prewarm), so its boot overlapped other work. */
  prewarmed: boolean;
}

/** A pool of at most `maxWorkers` detached optimizer workers that serves many preview requests. Each worker runs one
 *  request at a time and is reused by the next, so a foreground Optimize (primary + two alternates) boots one or two
 *  workers instead of three. Requests carry a runId and a worker only accepts the answer for its own request.
 *  Abort of one request terminates its worker (the only way to stop a synchronous search); closing the session, or the
 *  session signal, terminates all of them. After a stale compute core answer the session stops using workers. */
export function createOptimizerWorkerSession(options: OptimizerWorkerSessionOptions = {}): OptimizerWorkerSession {
  const factory = options.workerFactory === undefined ? defaultWorkerFactory : options.workerFactory;
  const maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? 1));
  const keepAlive = options.keepAlive !== false;
  // The build id rides on the worker URL so the worker can load the classic compute core with the same cache-bust
  // (the corporate proxy caches .js by URL; a stale core would push every preview to the main thread).
  const defaultUrl = `${new URL('./optimizer-worker.mjs', import.meta.url).href}?v=${encodeURIComponent(String(Config.BUILD_ID))}`;
  const slots: SessionSlot[] = [];
  const queue: Array<{ request: OptimizerWorkerRequest; entry: SessionPending }> = [];
  const stats = { spawned: 0, terminated: 0 };
  let closed = false;
  let stale = false;
  let noWorker = false;

  const syncEvaluate = (request: OptimizerWorkerRequest): CandidateResult => {
    const evalRequest = evalRequestOf(request);
    // A relative budget starts when the evaluation starts (a queued request that fell back), as it does on a worker.
    if (request.deadlineDurationMs !== undefined && Number.isFinite(request.deadlineDurationMs)) {
      evalRequest.deadlineAt = performance.now() + Math.max(0, request.deadlineDurationMs);
    }
    return (options.syncEvaluator ?? evaluateSchedule)(request.snapshot, evalRequest);
  };

  const terminateSlot = (slot: SessionSlot): void => {
    if (slot.dead) return;
    slot.dead = true;
    const at = slots.indexOf(slot);
    if (at >= 0) slots.splice(at, 1);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    stats.terminated++;
    slot.worker.terminate();
  };

  /** Spawn one worker, or null when none can be had. A throwing factory propagates so the caller can apply the
   *  long-run rule (an exhaustive run must not land on the main thread). */
  const spawn = (): SessionSlot | null => {
    if (!factory || noWorker) return null;
    const worker = factory(options.workerUrl ?? defaultUrl);
    if (!worker) { noWorker = true; return null; }
    stats.spawned++;
    const slot: SessionSlot = { worker, pending: null, spawnedAt: performance.now(), runs: 0, dead: false, prewarmed: false };
    slots.push(slot);
    worker.onmessage = ({ data }): void => onMessage(slot, data);
    worker.onerror = (event): void => failSlot(slot, new Error(event.message || 'Optimizer worker failed.'));
    worker.onmessageerror = (): void => failSlot(slot, new Error('Optimizer worker response could not be read (message deserialisation failed).'));
    return slot;
  };

  /** End the slot's request. `terminate` retires a worker that is broken, stale or not kept alive; otherwise it goes
   *  back to the pool and takes the next queued request. The callback runs after the worker is released. */
  function settle(slot: SessionSlot, terminate: boolean, callback: (pending: SessionPending) => void): void {
    const pending = slot.pending;
    if (!pending || slot.dead) return;
    slot.pending = null;
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (terminate || !keepAlive || stale || closed) terminateSlot(slot);
    callback(pending);
    drain();
  }

  /** A worker reported a failure. With a request running it rejects that request; an IDLE (pre-warmed or kept-alive)
   *  worker has nothing to reject but is just as dead: retire it so no later request is posted to it, and let any
   *  queued request spawn a replacement (or take the fallback). */
  function failSlot(slot: SessionSlot, error: Error): void {
    if (slot.dead) return;
    if (slot.pending) { settle(slot, true, p => p.reject(error)); return; }
    terminateSlot(slot);
    drain();
  }

  function dispatch(slot: SessionSlot, request: OptimizerWorkerRequest, entry: SessionPending): void {
    slot.pending = entry;
    entry.postedAt = performance.now();
    try {
      const posted = workerRequestWithRemainingDeadline(request);
      slot.worker.postMessage(entry.kpiOnly ? { ...posted, kpiOnly: true } : posted);
    } catch (error) {
      settle(slot, true, p => p.reject(error));
    }
  }

  /** The main-thread answer for a request no worker will serve. */
  function fallback(request: OptimizerWorkerRequest, entry: SessionPending): void {
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (stale && entry.long) { entry.reject(staleCoreError()); return; }
    try { entry.resolve(syncEvaluate(request)); } catch (error) { entry.reject(error); }
  }

  /** Hand queued requests to idle or newly spawned workers; with no worker to be had they take the fallback path. */
  function drain(): void {
    while (queue.length && !closed) {
      const next = queue[0];
      if (stale || noWorker) {
        queue.shift();
        fallback(next.request, next.entry);
        continue;
      }
      let slot = slots.find(s => !s.pending && !s.dead) ?? null;
      if (!slot && slots.length < maxWorkers) {
        try {
          slot = spawn();
        } catch (error) {
          queue.shift();
          if (next.entry.long) {
            next.entry.signal?.removeEventListener('abort', next.entry.onAbort);
            next.entry.reject(error instanceof Error ? error : new Error(String(error)));
          } else {
            ErrorLog.warn('optimizer', 'Optimizer worker could not be created; evaluating on the main thread.', error);
            fallback(next.request, next.entry);
          }
          continue;
        }
        if (!slot) continue;   // the factory yielded no worker: the next pass takes the fallback branch
      }
      if (!slot) break;
      queue.shift();
      const target = slot;
      next.entry.signal?.removeEventListener('abort', next.entry.onAbort);
      next.entry.onAbort = (): void => settle(target, true, p => p.reject(abortError()));
      next.entry.signal?.addEventListener('abort', next.entry.onAbort, { once: true });
      dispatch(slot, next.request, next.entry);
    }
  }

  function onMessage(slot: SessionSlot, data: OptimizerWorkerResponse | undefined): void {
    const pending = slot.pending;
    if (!pending || !data || data.runId !== pending.request.runId) return;
    const { request } = pending;
    if (typeof data.evalMs === 'number') {
      // Round trip minus search time, measured from the post: the first request on a worker that was spawned for it
      // pays the boot (workerBoot); a reused or pre-warmed worker shows only clone + post back (workerReuse).
      PerfMonitor.record(slot.runs === 0 && !slot.prewarmed ? 'Optimize.workerBoot' : 'Optimize.workerReuse', performance.now() - pending.postedAt - data.evalMs);
    }
    slot.runs++;
    if ('error' in data && data.error !== undefined) {   // an empty message is still a failure
      if (String(data.error).includes(COMPUTE_CORE_STALE)) {
        // The worker realm loaded a cached compute core without the dated-period helpers. Every worker of this
        // session shares that core, so stop using them: retire this one now, idle ones now, busy ones as they answer.
        stale = true;
        for (const other of [...slots]) if (other !== slot && !other.pending) terminateSlot(other);
        if (pending.long) {
          // No main-thread fallback for an exhaustive run (see isLongRunRequest): fail with a clear, actionable error.
          ErrorLog.warn('optimizer', 'Optimizer worker has a stale compute core; the background run was refused.');
          settle(slot, true, p => p.reject(staleCoreError()));
          return;
        }
        settle(slot, true, p => {
          // The main thread has the current core, so evaluate there instead of failing the preview (logged once per page).
          if (!_staleCoreWarned) {
            _staleCoreWarned = true;
            ErrorLog.warn('optimizer', 'Optimizer worker has a stale compute core; evaluating on the main thread.');
          }
          try { p.resolve(syncEvaluate(request)); } catch (error) { p.reject(error); }
        });
        return;
      }
      settle(slot, true, p => {
        const failure = new Error(data.error || 'Optimizer worker failed.');
        if (data.stack) failure.stack = data.stack;   // the worker-side stack is the useful one
        p.reject(failure);
      });
      return;
    }
    if (!data.candidate) {
      settle(slot, true, p => p.reject(new Error('Optimizer worker returned no candidate.')));
      return;
    }
    if (pending.kpiOnly) {
      // The caller reads patches only: no validation was serialized, so there is nothing to rehydrate.
      const kpi = data.candidate as CandidateResult;
      settle(slot, false, p => p.resolve(kpi));
      return;
    }
    if (!data.validation && data.candidate.status === 'invalid_horizon') {
      // No proposal and no validation seam by design (see buildOptimizerWorkerResponse): hand it back as-is.
      const invalid = data.candidate as CandidateResult;
      settle(slot, false, p => p.resolve(invalid));
      return;
    }
    try {
      const rehydrated = rehydrateOptimizerCandidate(data.candidate, request.snapshot, data.validation);
      settle(slot, false, p => p.resolve(rehydrated));
    } catch (error) {
      settle(slot, true, p => p.reject(error));
    }
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', close);
    const waiting = queue.splice(0).map(item => item.entry);
    const running = slots.map(slot => slot.pending).filter((p): p is SessionPending => !!p);
    for (const slot of [...slots]) {
      slot.pending = null;
      terminateSlot(slot);
    }
    for (const entry of [...running, ...waiting]) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(abortError());
    }
  };
  if (options.signal) {
    if (options.signal.aborted) closed = true;
    else options.signal.addEventListener('abort', close, { once: true });
  }

  return {
    run(request, runOptions = {}): CandidateResult | Promise<CandidateResult> {
      const signal = runOptions.signal;
      if (closed || options.signal?.aborted || signal?.aborted) return Promise.reject(abortError());
      // Validate the deadline BEFORE spawning: a bad one must throw while there is nothing to leak. A queued
      // request recomputes it when it is posted.
      workerRequestWithRemainingDeadline(request);
      const long = isLongRunRequest(request);
      if (stale && long) return Promise.reject(staleCoreError());
      if (stale || noWorker || !factory) return syncEvaluate(request);
      // Acquire a worker NOW (synchronously, as the one-shot client always did): an idle one, else a new one while
      // under the cap. No worker to be had means the synchronous evaluator answers in this same tick; only a request
      // that finds every worker busy waits in the queue.
      let slot = slots.find(s => !s.pending && !s.dead) ?? null;
      if (!slot && slots.length < maxWorkers) {
        try {
          slot = spawn();
        } catch (error) {
          // The browser refused to construct the worker (CSP, quota, a blocked module). An exhaustive run must not
          // land on the main thread (see isLongRunRequest); a Normal run keeps the synchronous path.
          if (long) return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          ErrorLog.warn('optimizer', 'Optimizer worker could not be created; evaluating on the main thread.', error);
          return syncEvaluate(request);
        }
        if (!slot) return syncEvaluate(request);
      }
      const acquired = slot;
      return new Promise<CandidateResult>((resolve, reject) => {
        const entry: SessionPending = {
          request, kpiOnly: runOptions.kpiOnly === true, long, signal, resolve, reject, postedAt: 0,
          onAbort: (): void => {
            const at = queue.findIndex(item => item.entry === entry);
            if (at >= 0) queue.splice(at, 1);
            reject(abortError());
          },
        };
        if (acquired) {
          entry.onAbort = (): void => settle(acquired, true, p => p.reject(abortError()));
          signal?.addEventListener('abort', entry.onAbort, { once: true });
          dispatch(acquired, request, entry);
          return;
        }
        signal?.addEventListener('abort', entry.onAbort, { once: true });
        queue.push({ request, entry });
        drain();
      });
    },
    prewarm(count: number): void {
      if (closed || stale || noWorker) return;
      while (slots.length < Math.min(maxWorkers, Math.max(0, Math.floor(count)))) {
        try {
          const warmed = spawn();
          if (!warmed) return;
          warmed.prewarmed = true;
        } catch (error) {
          ErrorLog.warn('optimizer', 'Optimizer worker could not be pre-started.', error);
          return;
        }
      }
    },
    close,
    get workerBacked(): boolean {
      return !closed && !stale && !noWorker && !!factory && (factory !== defaultWorkerFactory || typeof Worker === 'function');
    },
    stats,
  };
}

export interface OptimizerWorkerRunOptions {
  /** Inject a fake worker in tests or an application-specific worker pool. */
  workerFactory?: OptimizerWorkerFactory | null;
  /** Explicitly retain the synchronous path when a caller needs it. */
  syncEvaluator?: (snapshot: ScheduleSnapshot, request: EngineEvaluationRequest) => CandidateResult;
  signal?: AbortSignal;
  workerUrl?: string;
}

/** Run one detached preview candidate on a worker of its own (a one-request session that retires its worker when the
 * request ends). The request is immutable by contract; the worker receives the same snapshot and clock options as the
 * synchronous evaluator, so the UI never compares candidates generated from live Store state at different times.
 * Abort terminates the dedicated worker, which is the only reliable way to cancel a synchronous search already
 * executing in a separate thread. Use `createOptimizerWorkerSession` to share workers across several requests. */
export function runOptimizerPreview(
  request: OptimizerWorkerRequest,
  options: OptimizerWorkerRunOptions = {},
): CandidateResult | Promise<CandidateResult> {
  const session = createOptimizerWorkerSession({
    workerFactory: options.workerFactory, syncEvaluator: options.syncEvaluator, workerUrl: options.workerUrl,
    maxWorkers: 1, keepAlive: false,
  });
  let result: CandidateResult | Promise<CandidateResult>;
  try {
    result = session.run(request, { signal: options.signal });
  } catch (error) {
    session.close();
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => session.close());
  session.close();
  return result;
}
