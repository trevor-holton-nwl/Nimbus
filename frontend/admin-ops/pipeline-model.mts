/* Admin > Diagnostics > Data pipeline: the pure model behind the strip (no DOM, no Store, no imports).
 *
 * Everything is about ONE plant. The all-plants database total is an info chip, never a step.
 * Steps: plant (all orders of the plant) -> horizon (inside the visibility horizon) -> sent (payload
 * rows) -> loaded (rows this browser kept). Each step may carry a delta the pane translates. */

export type PipelineStatus = 'ok' | 'warn' | 'err';
export type PipelineStepKey = 'plant' | 'horizon' | 'sent' | 'loaded';

export interface PipelineInputs {
  /** db_stats.total: every order, every plant. */
  inDb: number;
  /** The active plant, or null when none is picked. */
  plant: string | null;
  /** plant_stats.total (no horizon filter); null when the read has no plant block. */
  plantTotal: number | null;
  /** /tasks meta.queried_row_count (rows after plant scope and horizon); null before a load. */
  queried: number | null;
  /** /tasks meta.dropped_no_dates. */
  droppedNoDates: number;
  /** /tasks meta.visibility_horizon_end (ISO) or null. */
  horizonEnd: string | null;
  /** Rows in the last /tasks payload (Persistence raw_received). */
  sent: number;
  /** Rows this browser kept (Persistence rendered). */
  loaded: number;
}

export interface PipelineDelta { key: string; args: Record<string, unknown> }
export interface PipelineStepModel {
  key: PipelineStepKey;
  count: number;
  delta: PipelineDelta | null;
  status: PipelineStatus;
}
export interface PipelineModel {
  inDb: number;
  plant: string | null;
  steps: PipelineStepModel[];
  /** sent - loaded, never negative. */
  gap: number;
  dropped: number;
}

const _n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Build the strip. With no plant there are no steps (the pane shows the info chip and a hint). */
export function buildPipelineSteps(i: PipelineInputs): PipelineModel {
  const inDb = _n(i.inDb);
  const sent = _n(i.sent);
  const loaded = _n(i.loaded);
  const dropped = Math.max(0, _n(i.droppedNoDates));
  const gap = Math.max(0, sent - loaded);
  if (!i.plant) return { inDb, plant: null, steps: [], gap, dropped };

  const plantTotal = i.plantTotal === null ? null : _n(i.plantTotal);
  const queried = i.queried === null ? sent : _n(i.queried);
  const beyond = plantTotal === null ? 0 : Math.max(0, plantTotal - queried);
  let horizonDelta: PipelineDelta | null = null;
  if (beyond > 0) {
    horizonDelta = i.horizonEnd
      ? { key: 'pipe.delta_beyond_horizon', args: { n: beyond, date: i.horizonEnd } }
      : { key: 'pipe.delta_beyond_horizon_plain', args: { n: beyond } };
  }

  const steps: PipelineStepModel[] = [
    { key: 'plant', count: plantTotal ?? queried, delta: null, status: 'ok' },
    { key: 'horizon', count: queried, delta: horizonDelta, status: 'ok' },
    {
      key: 'sent', count: sent,
      delta: dropped > 0 ? { key: 'pipe.delta_no_dates', args: { n: dropped } } : null,
      status: dropped > 0 ? 'warn' : 'ok',
    },
    {
      key: 'loaded', count: loaded,
      delta: gap > 0 ? { key: 'pipe.delta_gap', args: { n: gap } } : null,
      status: gap > 0 ? 'err' : 'ok',
    },
  ];
  return { inDb, plant: i.plant, steps, gap, dropped };
}
