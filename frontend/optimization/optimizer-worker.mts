// Module-worker entry for detached optimizer previews. The classic compute
// core is loaded first (below) because Calendar/setup placement delegates to the
// ambient NimbusComputeCore object in every browser realm.
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

const realm = globalThis as unknown as WorkerRealm & {
  NimbusComputeCore?: unknown;
  location?: { search?: string };
};
// This module is loaded only by a Worker in production. The document guard
// keeps an accidental main-thread import inert, and also makes the adapter
// directly importable in Node tests without installing a fake worker global.
if (typeof realm.postMessage === 'function' && typeof realm.document === 'undefined') {
  // Load the classic compute core with the SAME `?v=<build id>` the client stamped on this worker's URL, so a
  // proxy-cached core can never sit behind a fresh worker (mirrors nimbus-worker.ts). The UMD factory sets
  // `self.NimbusComputeCore`. Skipped when a core is already present (Node tests install one). onmessage is
  // assigned only after the load, so no request can run against a missing core; the `compute-core-stale` guard in
  // the engine/client stays as the second line of defence.
  if (!realm.NimbusComputeCore) {
    const version = new URLSearchParams(realm.location?.search ?? '').get('v');
    const coreUrl = new URL('../nimbus-compute-core.js', import.meta.url);
    if (version) coreUrl.search = `?v=${encodeURIComponent(version)}`;
    await import(coreUrl.href);
  }
  realm.onmessage = ({ data }): void => {
    try {
      realm.postMessage(buildOptimizerWorkerResponse(data));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      realm.postMessage({ runId: data.runId, error: failure.message, stack: failure.stack });
    }
  };
}
