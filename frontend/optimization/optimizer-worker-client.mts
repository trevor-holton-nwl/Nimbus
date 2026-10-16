// Detached optimizer preview worker client. The worker is an optional UI
// acceleration path: callers without Worker support (tests, server-side
// tooling, and non-UI integrations) keep the synchronous Engine evaluator.
import type { CandidateResult, EvaluationRequest, ScheduleSnapshot } from './setup-scheduler.mjs';
import { evaluateSchedule, rehydrateOptimizerCandidate } from './engine.mjs';
import { ErrorLog } from '../platform/foundation.mjs';
import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';
export type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';

export interface OptimizerWorkerLike {
  onmessage: ((event: MessageEvent<OptimizerWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
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
  const worker = factory?.(options.workerUrl ?? new URL('./optimizer-worker.mjs', import.meta.url).href) ?? null;
  if (!worker) {
    const evaluator = options.syncEvaluator ?? evaluateSchedule;
    return evaluator(request.snapshot, request.request);
  }

  const workerRequest = workerRequestWithRemainingDeadline(request);

  return new Promise<CandidateResult>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    worker.onmessage = ({ data }): void => {
      if (!data || data.runId !== request.runId) return;
      if (data.error) {
        if (String(data.error).includes(COMPUTE_CORE_STALE)) {
          // The worker realm loaded a cached compute core without the dated-period helpers. The main thread
          // has the current core, so evaluate there instead of failing the preview (logged once per session).
          finish(() => {
            if (!_staleCoreWarned) {
              _staleCoreWarned = true;
              ErrorLog.warn('optimizer', 'Optimizer worker has a stale compute core; evaluating on the main thread.');
            }
            try {
              resolve((options.syncEvaluator ?? evaluateSchedule)(request.snapshot, request.request));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
        finish(() => reject(new Error(data.error)));
        return;
      }
      if (!data.candidate) {
        finish(() => reject(new Error('Optimizer worker returned no candidate.')));
        return;
      }
      try {
        const rehydrated = rehydrateOptimizerCandidate(
          data.candidate as CandidateResult, request.snapshot, data.validation,
        );
        finish(() => resolve(rehydrated));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    worker.onerror = (event): void => finish(() => reject(new Error(event.message || 'Optimizer worker failed.')));
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
    }
    try {
      worker.postMessage(workerRequest);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
