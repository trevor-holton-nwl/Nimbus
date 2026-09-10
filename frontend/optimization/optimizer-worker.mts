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

export function evaluateOptimizerWorkerRequest(request: OptimizerWorkerRequest): CandidateResult {
  return evaluateSchedule(request.snapshot, { ...request.request, mode: request.mode });
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
      const result = evaluateOptimizerWorkerRequest(data);
      const validation = serializeOptimizerValidation(result);
      const { validationContext: _validationContext, ...candidate } = result;
      realm.postMessage({ runId: data.runId, candidate, validation });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      realm.postMessage({ runId: data.runId, error: failure.message, stack: failure.stack });
    }
  };
}
