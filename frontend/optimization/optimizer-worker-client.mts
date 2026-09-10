// Detached optimizer preview worker client. The worker is an optional UI
// acceleration path: callers without Worker support (tests, server-side
// tooling, and non-UI integrations) keep the synchronous Engine evaluator.
import type { CandidateResult, EvaluationRequest, ScheduleSnapshot } from './setup-scheduler.mjs';
import { evaluateSchedule, rehydrateOptimizerCandidate } from './engine.mjs';
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
        finish(() => reject(new Error(data.error)));
        return;
      }
      if (!data.candidate) {
        finish(() => reject(new Error('Optimizer worker returned no candidate.')));
        return;
      }
      finish(() => resolve(rehydrateOptimizerCandidate(
        data.candidate as CandidateResult, request.snapshot, data.validation,
      )));
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
      worker.postMessage(request);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
