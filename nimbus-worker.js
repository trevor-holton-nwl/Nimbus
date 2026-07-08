/* nimbus-worker.js — off-main-thread compute for Alerts and Utilization.
 * Receives serialised Store state via postMessage, returns computed results.
 * Zero DOM access; no NIMBUS namespace dependencies.
 *
 * The compute logic (Calendar capacity engine + Alerts rule set + Utilization
 * matrix) now lives in nimbus-compute-core.js — the SINGLE source of truth,
 * shared with the Node test-suite. This file is just the message-protocol shim:
 * it importScripts the core and dispatches. Do NOT re-inline compute logic here.
 *
 * Message protocol
 * ----------------
 *  IN  { type:'ALERTS',      id, payload:{ tasks, blocks, plantBlocks, calendars,
 *                                          plants, lineSettings, masterData,
 *                                          dismissed, opts:{lines?} } }
 *  IN  { type:'UTILIZATION', id, payload:{ tasks, lineSettings, calendars, plants,
 *                                          blocks, plantBlocks, masterData,
 *                                          startMs, days } }
 *  OUT { type:'ALERTS_RESULT',      id, alerts, elapsed }
 *  OUT { type:'UTILIZATION_RESULT', id, matrix }
 *  OUT { type:'ERROR',              id, error }
 */
'use strict';

// Load the shared compute core. self.location.search carries the same `?v=<BUILD_ID>`
// cache-bust the main thread stamped onto the worker URL (new Worker('...?v=…')), so
// the core is fetched with the SAME version and can never be served stale behind the
// worker. If this ever fails to load, the worker errors and app.js's Compute wrapper
// falls back to synchronous main-thread compute for the session.
importScripts('nimbus-compute-core.js' + (self.location && self.location.search ? self.location.search : ''));

const Core = self.NimbusComputeCore;

self.onmessage = function ({ data }) {
  const { type, id, payload } = data;
  try {
    if (type === 'ALERTS') {
      const { alerts, elapsed } = Core.computeAlerts(payload);
      self.postMessage({ type: 'ALERTS_RESULT', id, alerts, elapsed });
    } else if (type === 'UTILIZATION') {
      const { matrix } = Core.computeUtilization(payload);
      self.postMessage({ type: 'UTILIZATION_RESULT', id, matrix });
    }
  } catch (err) {
    const out = { type: 'ERROR', id, error: err.message, stack: err.stack, failingType: type };
    if (id != null) out.jobId = id;
    self.postMessage(out);
  }
};
