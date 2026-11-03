// Detached optimizer preview worker client. The worker is an optional UI
// acceleration path: callers without Worker support (tests, server-side
// tooling, and non-UI integrations) keep the synchronous Engine evaluator.
import type { CandidateResult, EvaluationRequest, ScheduleSnapshot } from './setup-scheduler.mjs';
import { evaluateSchedule, rehydrateOptimizerCandidate, SETUP_AWARE_NORMAL_BUDGET_MS } from './engine.mjs';
import { Config, ErrorLog, Util } from '../platform/foundation.mjs';
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

export interface OptimizerWorkerRunOptions {
  /** Inject a fake worker in tests or an application-specific worker pool. */
  workerFactory?: OptimizerWorkerFactory | null;
  /** Explicitly retain the synchronous path when a caller needs it. */
  syncEvaluator?: (snapshot: ScheduleSnapshot, request: EvaluationRequest) => CandidateResult;
  signal?: AbortSignal;
  workerUrl?: string;
}

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

/** Run one detached preview candidate. The request is immutable by contract;
 * the worker receives the same snapshot and clock options as the synchronous
 * evaluator, so the UI never compares candidates generated from live Store
 * state at different times. Abort terminates the dedicated worker, which is
 * the only reliable way to cancel a synchronous search already executing in a
 * separate thread. */
export function runOptimizerPreview(
  request: OptimizerWorkerRequest,
  options: OptimizerWorkerRunOptions = {},
): CandidateResult | Promise<CandidateResult> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const factory = options.workerFactory === undefined ? defaultWorkerFactory : options.workerFactory;
  // The build id rides on the worker URL so the worker can load the classic compute core with the same cache-bust
  // (the corporate proxy caches .js by URL; a stale core would push every preview to the main thread).
  const defaultUrl = `${new URL('./optimizer-worker.mjs', import.meta.url).href}?v=${encodeURIComponent(String(Config.BUILD_ID))}`;
  // Build the worker request BEFORE spawning: a bad deadline must throw while there is nothing to leak.
  const workerRequest = workerRequestWithRemainingDeadline(request);
  let worker: OptimizerWorkerLike | null = null;
  try {
    worker = factory?.(options.workerUrl ?? defaultUrl) ?? null;
  } catch (error) {
    // The browser refused to construct the worker (CSP, quota, a blocked module). An exhaustive run must not
    // land on the main thread (see isLongRunRequest); a Normal run keeps the synchronous path.
    if (isLongRunRequest(request)) return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    ErrorLog.warn('optimizer', 'Optimizer worker could not be created; evaluating on the main thread.', error);
  }
  if (!worker) {
    const evaluator = options.syncEvaluator ?? evaluateSchedule;
    return evaluator(request.snapshot, evalRequestOf(request));
  }
  const liveWorker = worker;

  return new Promise<CandidateResult>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      liveWorker.onmessage = null;
      liveWorker.onerror = null;
      liveWorker.onmessageerror = null;
      liveWorker.terminate();
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    liveWorker.onmessage = ({ data }): void => {
      if (!data || data.runId !== request.runId) return;
      if ('error' in data && data.error !== undefined) {   // an empty message is still a failure
        if (String(data.error).includes(COMPUTE_CORE_STALE) && isLongRunRequest(request)) {
          // No main-thread fallback for an exhaustive run (see isLongRunRequest): fail with a clear, actionable error.
          ErrorLog.warn('optimizer', 'Optimizer worker has a stale compute core; the background run was refused.');
          finish(() => reject(staleCoreError()));
          return;
        }
        if (String(data.error).includes(COMPUTE_CORE_STALE)) {
          // The worker realm loaded a cached compute core without the dated-period helpers. The main thread
          // has the current core, so evaluate there instead of failing the preview (logged once per session).
          finish(() => {
            if (!_staleCoreWarned) {
              _staleCoreWarned = true;
              ErrorLog.warn('optimizer', 'Optimizer worker has a stale compute core; evaluating on the main thread.');
            }
            try {
              resolve((options.syncEvaluator ?? evaluateSchedule)(request.snapshot, evalRequestOf(request)));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
        finish(() => {
          const failure = new Error(data.error || 'Optimizer worker failed.');
          if (data.stack) failure.stack = data.stack;   // the worker-side stack is the useful one
          reject(failure);
        });
        return;
      }
      if (!data.candidate) {
        finish(() => reject(new Error('Optimizer worker returned no candidate.')));
        return;
      }
      if (!data.validation && data.candidate.status === 'invalid_horizon') {
        // No proposal and no validation seam by design (see buildOptimizerWorkerResponse): hand it back as-is.
        const invalid = data.candidate;
        finish(() => resolve(invalid));
        return;
      }
      try {
        const rehydrated = rehydrateOptimizerCandidate(
          data.candidate, request.snapshot, data.validation,
        );
        finish(() => resolve(rehydrated));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    liveWorker.onerror = (event): void => finish(() => reject(new Error(event.message || 'Optimizer worker failed.')));
    liveWorker.onmessageerror = (): void => finish(() => reject(new Error('Optimizer worker response could not be read (message deserialisation failed).')));
    // The signal was checked at the top and nothing awaited since, so it cannot already be aborted here.
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      liveWorker.postMessage(workerRequest);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
