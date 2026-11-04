// Module-worker entry for detached optimizer previews. The classic compute
// core is loaded first (below) because Calendar/setup placement delegates to the
// ambient NimbusComputeCore object in every browser realm.
import { evaluateSchedule } from './engine.mjs';
import type { CandidateResult } from './setup-scheduler.mjs';
import { evalRequestOf, serializeOptimizerValidation } from './optimizer-worker-contract.mjs';
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
  return evaluateSchedule(localized.snapshot, evalRequestOf(localized));
}

export function buildOptimizerWorkerResponse(
  request: OptimizerWorkerRequest,
  clock: () => number = () => performance.now(),
): OptimizerWorkerResponse {
  const result = evaluateOptimizerWorkerRequest(request, clock);
  const { validationContext: _validationContext, ...candidate } = result;
  // KPI-only requests (alternate plans) never reach Apply, so the per-task bound maps are not built or cloned back.
  if (request.kpiOnly === true) return { runId: request.runId, candidate };
  const validation = serializeOptimizerValidation(result);
  // An `invalid_horizon` candidate is a caller error with no schedule proposal, so it has no validation seam by design:
  // answer it as a normal response and let the dialog name the reason, instead of throwing "no validation metadata".
  if (!validation && result.status === 'invalid_horizon') return { runId: request.runId, candidate };
  if (!validation) throw new Error('Optimizer worker produced no validation metadata.');
  return { runId: request.runId, candidate, validation };
}

/** Install the request handler on a worker realm. Every request waits for `corePromise` (the compute core load)
 * before evaluating; a rejected load answers with the `{ runId, error }` shape the client already rejects on. */
export function installOptimizerWorkerHandler(
  target: WorkerRealm,
  corePromise: Promise<unknown>,
): void {
  target.onmessage = async ({ data }): Promise<void> => {
    try {
      await corePromise;
      const evalT0 = performance.now();
      const response = buildOptimizerWorkerResponse(data);
      // evalMs lets the client separate boot + clone overhead from search time (PerfMonitor Optimize.workerBoot).
      target.postMessage({ ...response, evalMs: performance.now() - evalT0 });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      target.postMessage({ runId: data.runId, error: failure.message, stack: failure.stack });
    }
  };
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
  // `self.NimbusComputeCore`. Skipped when a core is already present (Node tests install one). `onmessage` is
  // assigned synchronously (no top-level await), because the client posts its first message right after
  // `new Worker(...)`; the handler waits for the core instead, and a failed load surfaces as an error response.
  // The `compute-core-stale` guard in the engine/client stays as the second line of defence.
  let corePromise: Promise<unknown> = Promise.resolve();
  if (!realm.NimbusComputeCore) {
    const version = new URLSearchParams(realm.location?.search ?? '').get('v');
    const coreUrl = new URL('../nimbus-compute-core.js', import.meta.url);
    if (version) coreUrl.search = `?v=${encodeURIComponent(version)}`;
    corePromise = import(coreUrl.href);
  }
  installOptimizerWorkerHandler(realm, corePromise);
}
