// Autosave cache record (T2): a PURE, DOM-free, zero-import builder for the compact record the IndexedDB cache
// store keeps per user+plant. Only DIRTY rows are stored, projected to their edited fields; the rest of the board is
// re-read from the server on restore. Nothing here touches persistence state, storage or the clock.
// Plan: autosave-cache redesign, "Record = one JSON string".

/** Record format version. Bump on any incompatible shape change; parseCacheRecord rejects other values. */
export const CACHE_RECORD_VERSION = 1;

/**
 * Row fields a dirty row keeps in the record. UNION of:
 *  - snapshot: every key `Persistence._taskEditSnapshot` emits, mapped to its in-memory row key
 *    (planning_status, planning_reason, placement_exception, start_date, end_date, PRT_01, PRT_02,
 *    PRODUCTION_VERSION, RUN_TIME, MACHINE, scheduleSegments (wire: schedule_segments), firmed (wire: FIRMED));
 *    `source` is not a row field, it travels in `dirtySource`;
 *  - overlay: every key `_overlayUserMoves` reads from a cached row (adds original_start_date, user_scheduled,
 *    run_time_source, derivationIssue, row_version, id, plus segments through `_segmentsFromRaw`, which accepts
 *    either `scheduleSegments` or `schedule_segments`);
 *  - mismatch: runtime_schedule_mismatch (the restore dry-run skips those rows).
 */
export const CACHE_ROW_FIELDS: readonly string[] = [
  'id', 'row_version',
  // snapshot
  'planning_status', 'planning_reason', 'placement_exception', 'start_date', 'end_date',
  'PRT_01', 'PRT_02', 'PRODUCTION_VERSION', 'RUN_TIME', 'MACHINE', 'scheduleSegments', 'schedule_segments', 'firmed',
  // overlay
  'original_start_date', 'user_scheduled', 'run_time_source', 'derivationIssue',
  // mismatch
  'runtime_schedule_mismatch',
];

/** Source of each projected key, for the guard test and the T3/T4 hand-off. */
export const CACHE_FIELD_SOURCE: Readonly<Record<string, 'identity' | 'snapshot' | 'overlay' | 'mismatch'>> = {
  id: 'identity', row_version: 'identity',
  planning_status: 'snapshot', planning_reason: 'snapshot', placement_exception: 'snapshot', start_date: 'snapshot',
  end_date: 'snapshot', PRT_01: 'snapshot', PRT_02: 'snapshot', PRODUCTION_VERSION: 'snapshot', RUN_TIME: 'snapshot',
  MACHINE: 'snapshot', scheduleSegments: 'snapshot', schedule_segments: 'snapshot', firmed: 'snapshot',
  original_start_date: 'overlay', user_scheduled: 'overlay', run_time_source: 'overlay', derivationIssue: 'overlay',
  runtime_schedule_mismatch: 'mismatch',
};

/** Wire key (`_taskEditSnapshot`) -> in-memory row key. Keys not listed map to themselves; `source` has no row key. */
export const SNAPSHOT_WIRE_TO_ROW: Readonly<Record<string, string | null>> = {
  FIRMED: 'firmed', schedule_segments: 'scheduleSegments', source: null,
};

type Row = Record<string, unknown>;

export interface CacheRecordContext {
  lineSettings?: unknown; calendars?: unknown; blocks?: unknown; plants?: unknown; plantBlocks?: unknown;
  userSettings?: unknown;
}

export interface CacheRecordInput {
  user: string;
  plant: string;
  schemaVersion: number | string;
  buildId: string | null;
  savedAt: number | string;
  seq: number;
  rows: Row[];
  dirtyIds: Iterable<string>;
  forceIds: Iterable<string>;
  dirtySource: Map<string, string> | Record<string, string>;
  context: CacheRecordContext;
}

export interface CacheRecord {
  v: number;
  user: string;
  plant: string;
  seq: number;
  schemaVersion: number | string;
  buildId: string | null;
  savedAt: number | string;
  complete: true;
  optimizerIds: string[];
  rows: Row[];
  context: CacheRecordContext;
}

/**
 * Keep only the edited fields of a dirty row. Absent keys stay absent (`key in row`); a present key keeps its value,
 * including an explicit null (`placement_exception: null` clears a stored marker, absence means never carried).
 * `snapshotFields` adds extra keys to the fixed set (for a caller that wants to project a key not listed here).
 */
export function projectRowForCache(row: Row, snapshotFields?: Iterable<string>): Row {
  const out: Row = {};
  const copy = (key: string): void => { if (key in row) out[key] = row[key]; };
  for (const key of CACHE_ROW_FIELDS) copy(key);
  if (snapshotFields) for (const key of snapshotFields) copy(SNAPSHOT_WIRE_TO_ROW[key] === undefined ? key : (SNAPSHOT_WIRE_TO_ROW[key] ?? ''));
  return out;
}

function toIdSet(ids: Iterable<string>): Set<string> {
  return new Set(Array.from(ids ?? [], id => String(id)));
}

/** Build the plain-object record. Only the rows passed in (the dirty ones) are stored. */
export function buildCacheRecord(input: CacheRecordInput): CacheRecord {
  const dirty = toIdSet(input.dirtyIds);
  const force = toIdSet(input.forceIds);
  const optimizerIds = Array.from(force).filter(id => dirty.has(id));
  const src = input.dirtySource instanceof Map ? input.dirtySource : new Map(Object.entries(input.dirtySource ?? {}));
  const rows = input.rows.map(row => {
    const projected = projectRowForCache(row);
    const source = src.get(String(row.id));
    if (source !== undefined) projected.dirtySource = source;
    return projected;
  });
  const ctx = input.context ?? {};
  return {
    v: CACHE_RECORD_VERSION,
    user: input.user,
    plant: input.plant,
    seq: input.seq,
    schemaVersion: input.schemaVersion,
    buildId: input.buildId,
    savedAt: input.savedAt,
    complete: true,
    optimizerIds,
    rows,
    context: {
      lineSettings: ctx.lineSettings, calendars: ctx.calendars, blocks: ctx.blocks,
      plants: ctx.plants, plantBlocks: ctx.plantBlocks, userSettings: ctx.userSettings,
    },
  };
}

export function serializeCacheRecord(record: CacheRecord): string {
  return JSON.stringify(record);
}

/** Parse a stored record; null on bad JSON, a wrong version or a missing complete/seq/plant/user. Never throws. */
export function parseCacheRecord(json: unknown): CacheRecord | null {
  try {
    if (typeof json !== 'string') return null;
    const rec = JSON.parse(json) as Partial<CacheRecord> | null;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    if (rec.v !== CACHE_RECORD_VERSION || rec.complete !== true) return null;
    if (typeof rec.seq !== 'number' || !Number.isFinite(rec.seq)) return null;
    if (typeof rec.plant !== 'string' || !rec.plant || typeof rec.user !== 'string' || !rec.user) return null;
    if (!Array.isArray(rec.rows)) return null;
    if (!Array.isArray(rec.optimizerIds)) rec.optimizerIds = [];
    return rec as CacheRecord;
  } catch {
    return null;
  }
}
