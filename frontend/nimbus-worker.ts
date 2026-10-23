/* nimbus-worker.ts — off-main-thread compute for Alerts and Utilization.
 * Receives serialised Store state via postMessage, returns computed results.
 * Zero DOM access; no NIMBUS namespace dependencies.
 *
 * The compute logic (Calendar capacity engine + Alerts rule set + Utilization
 * matrix) now lives in nimbus-compute-core.js — the SINGLE source of truth,
 * shared with the Node test-suite. This file is just the message-protocol shim:
 * it importScripts the core and dispatches. Do NOT re-inline compute logic here.
 *
 * TypeScript note: this file has NO top-level import/export on purpose — that keeps
 * it a "global script" to tsc, which emits plain unwrapped JS (importScripts(...)
 * preserved verbatim). Adding one (even a type-only import) reclassifies it as a
 * module and tsc adds CommonJS exports-object boilerplate that would throw at
 * runtime (Web Workers have no `exports`/`module` global). The NimbusComputeCore
 * ambient type (from nimbus-compute-core.d.ts) is a true global, so it's usable here
 * without an import. See docs/archive/typescript_migration.md for the full write-up.
 *
 * Message protocol
 * ----------------
 *  IN  { type:'ALERTS',      id, payload:{ tasks, blocks, plantBlocks, calendars,
 *                                          plants, lineSettings, masterData,
 *                                          dismissed, opts:{lines?},
 *                                          setup:{intervals,diagnostics} } }
 *  IN  { type:'UTILIZATION', id, payload:{ tasks, lineSettings, calendars, plants,
 *                                          blocks, plantBlocks, masterData,
 *                                          startMs, days, setup:{intervals,diagnostics} } }
 *  IN  { type:'LEVERAGE_BATCH', id, payload:{ base:{ ...ALERTS payload, startMs, days, lines? },
 *                                             variants:[{ key, setup:{intervals,diagnostics} }] } }
 *      Replays computeAlerts + computeUtilization once per variant on the shared base with that
 *      variant's hypothetical setup observation; calendars/plants are cloned per variant because
 *      the core's ensureCalendar/ensurePlant write defaults into them.
 *  OUT { type:'ALERTS_RESULT',      id, alerts, elapsed }
 *  OUT { type:'UTILIZATION_RESULT', id, matrix }
 *  OUT { type:'LEVERAGE_BATCH_RESULT', id, results:[{ key, alerts, matrix }] }
 *  OUT { type:'ERROR',              id, error }
 */
'use strict';

// Load the shared compute core. self.location.search carries the same `?v=<BUILD_ID>`
// cache-bust the main thread stamped onto the worker URL (new Worker('...?v=…')), so
// the core is fetched with the SAME version and can never be served stale behind the
// worker. If this ever fails to load, the worker errors and app.js's Compute wrapper
// falls back to synchronous main-thread compute for the session.
importScripts('nimbus-compute-core.js' + (self.location && self.location.search ? self.location.search : ''));

// Non-null assertion: if importScripts above failed, the whole worker script fails to
// load and this line never runs — matches the original untyped behavior exactly.
const Core = self.NimbusComputeCore!;

type IncomingMessage =
  | { type: 'ALERTS'; id: unknown; payload: ComputeAlertsPayload }
  | { type: 'UTILIZATION'; id: unknown; payload: ComputeUtilizationPayload }
  | { type: 'LEVERAGE_BATCH'; id: unknown; payload: {
      base: ComputeAlertsPayload & { startMs: number; days: number; lines?: string[] };
      variants: Array<{ key: string; setup: NimbusSetupObservation }>;
    } };

self.onmessage = function ({ data }: MessageEvent<IncomingMessage>) {
  const { type, id, payload } = data;
  try {
    if (type === 'ALERTS') {
      const { alerts, elapsed } = Core.computeAlerts(payload);
      self.postMessage({ type: 'ALERTS_RESULT', id, alerts, elapsed });
    } else if (type === 'UTILIZATION') {
      const { matrix } = Core.computeUtilization(payload);
      self.postMessage({ type: 'UTILIZATION_RESULT', id, matrix });
    } else if (type === 'LEVERAGE_BATCH') {
      const { base, variants } = payload;
      // ensureCalendar/ensurePlant only ADD missing top-level keys to calendars/plants (never edit an existing
      // entry), so every core call gets its own shallow copy of the two maps instead of a deep clone.
      const fresh = () => ({ calendars: { ...base.calendars }, plants: { ...base.plants } });
      const results = variants.map(({ key, setup }) => ({
        key,
        alerts: Core.computeAlerts({ ...base, ...fresh(), setup }).alerts,
        matrix: Core.computeUtilization({ ...base, ...fresh(), setup }).matrix,
      }));
      self.postMessage({ type: 'LEVERAGE_BATCH_RESULT', id, results });
    }
  } catch (err) {
    const e = err as Error;
    const out: Record<string, unknown> = { type: 'ERROR', id, error: e.message, stack: e.stack, failingType: type };
    if (id != null) out.jobId = id;
    self.postMessage(out);
  }
};
