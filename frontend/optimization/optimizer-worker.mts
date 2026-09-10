// Module-worker entry for detached optimizer previews. The classic compute
// core is imported first because Calendar/setup placement delegates to the
// ambient NimbusComputeCore object in every browser realm.
// @ts-ignore The compute core is a browser-loaded classic script with no ESM declarations.
import '../nimbus-compute-core.js';
import { evaluateSchedule } from './engine.mjs';
import type { CandidateResult } from './setup-scheduler.mjs';
import { serializeOptimizerValidation } from './optimizer-worker-contract.mjs';
import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';
export type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer-worker-contract.mjs';

export function localizeOptimizerDeadline(
  request: OptimizerWorkerRequest,
  clock: () => number = () => performance.now(),
): OptimizerWorkerRequest {
  if (request.deadlineDurationMs === undefined) return request;
  if (!Number.isFinite(request.deadlineDurationMs)) throw new TypeError('Optimizer worker received an invalid deadline duration.');
  return {
    ...request,
    request: {
      ...request.request,
      deadlineAt: clock() + Math.max(0, request.deadlineDurationMs),
    },
  };
}

export function evaluateOptimizerWorkerRequest(
  request: OptimizerWorkerRequest,
  clock: () => number = () => performance.now(),
): CandidateResult {
  const localized = localizeOptimizerDeadline(request, clock);
  return evaluateSchedule(localized.snapshot, { ...localized.request, mode: localized.mode });
}

export function buildOptimizerWorkerResponse(
  request: OptimizerWorkerRequest,
  clock: () => number = () => performance.now(),
): OptimizerWorkerResponse {
  const result = evaluateOptimizerWorkerRequest(request, clock);
  const validation = serializeOptimizerValidation(result);
  if (!validation) throw new Error('Optimizer worker produced no validation metadata.');
  const { validationContext: _validationContext, ...candidate } = result;
  return { runId: request.runId, candidate, validation };
}

interface WorkerRealm {
  document?: unknown;
  onmessage: ((event: MessageEvent<OptimizerWorkerRequest>) => void) | null;
  postMessage(message: OptimizerWorkerResponse): void;
}

const realm = globalThis as unknown as WorkerRealm;
// This module is loaded only by a Worker in production. The document guard
// keeps an accidental main-thread import inert, and also makes the adapter
// directly importable in Node tests without installing a fake worker global.
if (typeof realm.postMessage === 'function' && typeof realm.document === 'undefined') {
  realm.onmessage = ({ data }): void => {
    try {
      realm.postMessage(buildOptimizerWorkerResponse(data));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      realm.postMessage({ runId: data.runId, error: failure.message, stack: failure.stack });
    }
  };
}
