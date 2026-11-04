// scheduling/unsaved-diff.mjs - the pure diff behind the "unsaved changes" dialog (#unsaved-modal).
//
// For every unsaved order id it compares the order's saved reference (Persistence._savedBaseline: the parsed
// `_taskEditSnapshot` key of the last server-proven state) with the order's live edit snapshot, and reports
// the changed fields. It reads state; it never changes baseline policy, dirty marks or any schedule value.
//
// No imports and no DOM: the caller injects the two things it needs from the app (`snapshot`, `parseDate`) so
// the module tests without Persistence/Store. See frontend/scheduling/CLAUDE.md ("Unsaved changes dialog").

export type UnsavedStatus = 'moved' | 'machine' | 'firm' | 'runtime' | 'tooling' | 'needs' | 'noref' | 'nochange';
export type UnsavedFieldKey = 'machine' | 'start' | 'finish' | 'runtime' | 'pv' | 'prt1' | 'prt2' | 'segments' | 'firm';
export type UnsavedFieldKind = 'text' | 'date' | 'hours' | 'bool' | 'count';

export interface UnsavedField {
  key: UnsavedFieldKey;
  kind: UnsavedFieldKind;
  /** Absent on a "No saved reference" row (there is nothing to compare with). null = the field was empty. */
  before?: string | number | boolean | Date | null;
  after: string | number | boolean | Date | null;
}

export interface UnsavedMoveNote {
  /** A reason code the Inspector knows (`ui.insp_move_reason_<code>`). */
  reason: string;
  from: Date;
  to: Date;
}

export interface UnsavedChange {
  id: string;
  material: string;
  materialDescription: string;
  /** The order's live machine (what the table shows and the filter matches). */
  machine: string;
  status: UnsavedStatus;
  /** After minus before finish in ms (start when the finish did not move). 0 when neither moved or unknown. */
  deltaMs: number;
  /** |deltaMs| in hours, the "Biggest move first" key. */
  magnitude: number;
  /** Rank among rows with the same magnitude (higher sorts first). */
  rank: number;
  fields: UnsavedField[];
  hasBaseline: boolean;
  /** The wire source of the last edit (`drag`, `grid`, `optimizer`, `undo`...), or null when none is recorded. */
  source: string | null;
  moveNote: UnsavedMoveNote | null;
}

/** What `unsavedChanges` needs from the app. */
export interface UnsavedContext {
  /** `Persistence._taskEditSnapshot`: the wire-shape edit snapshot of a live task (includes `source`/`FIRMED`). */
  snapshot(task: Record<string, unknown>): Record<string, unknown>;
  /** `Util.parseDate`: a plant-naive local-seconds string (or Date) -> Date, null when not a date. */
  parseDate(v: unknown): Date | null;
  /** `Persistence._firmDirtyIds`: ids whose planner firm changed (FIRMED is not part of the baseline key). */
  firmDirtyIds: ReadonlySet<string>;
  /** `Persistence._dirtySource`. */
  dirtySource: ReadonlyMap<string, string>;
  /** `Store.isFirmed`. */
  isFirmed(id: string): boolean;
}

export type UnsavedBaselines = ReadonlyMap<string, { version: unknown; key: string }>;

export interface UnsavedResult {
  rows: UnsavedChange[];
  /** Unsaved ids whose order is no longer in the Store (not listed; the badge count may exceed rows.length). */
  skipped: string[];
}

const MOVE_REASONS = ['finish_moved_earlier', 'reversal_forward', 'pull_floor_crossed', 'run_time_changed', 'due_date_derivation', 'cutover'];
const RANK: Record<UnsavedStatus, number> = { needs: 6, machine: 5, moved: 4, runtime: 3, tooling: 2, firm: 2, noref: 1, nochange: 0 };

type Snap = Record<string, unknown>;
type Task = Record<string, unknown>;

const FIELD_DEFS: ReadonlyArray<{ key: UnsavedFieldKey; wire: string; kind: UnsavedFieldKind }> = [
  { key: 'machine', wire: 'MACHINE', kind: 'text' },
  { key: 'start', wire: 'start_date', kind: 'date' },
  { key: 'finish', wire: 'end_date', kind: 'date' },
  { key: 'runtime', wire: 'RUN_TIME', kind: 'hours' },
  { key: 'pv', wire: 'PRODUCTION_VERSION', kind: 'text' },
  { key: 'prt1', wire: 'PRT_01', kind: 'text' },
  { key: 'prt2', wire: 'PRT_02', kind: 'text' },
];

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function parseKey(json: string): Snap | null {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? v as Snap : null;
  } catch { return null; }
}

function emptyToNull(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

function valueOf(kind: UnsavedFieldKind, raw: unknown, ctx: UnsavedContext): string | number | Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (kind === 'date') return ctx.parseDate(raw);
  if (kind === 'hours') { const n = Number(raw); return Number.isFinite(n) ? n : null; }
  return String(raw);
}

function segmentCount(snap: Snap): number | null {
  return Array.isArray(snap.schedule_segments) ? snap.schedule_segments.length : null;
}

function moveNoteOf(task: Task): UnsavedMoveNote | null {
  const issue = task.derivationIssue as { code?: string; from?: Date; to?: Date } | null | undefined;
  const move = task.systemMove as { reason?: string; from?: Date; to?: Date } | null | undefined;
  const code = issue?.code && MOVE_REASONS.includes(issue.code) ? issue.code
    : move?.reason && MOVE_REASONS.includes(move.reason) ? move.reason : null;
  const from = issue?.from ?? move?.from;
  const to = issue?.to ?? move?.to;
  if (!code || !(from instanceof Date) || !(to instanceof Date)) return null;
  return { reason: code, from, to };
}

function msOf(f: UnsavedField | undefined): number | null {
  if (!f || !(f.before instanceof Date) || !(f.after instanceof Date)) return null;
  return f.after.getTime() - f.before.getTime();
}

/** One row per unsaved order whose live row still exists. `dirtyIds` is `Persistence._dirtyIds`. */
export function unsavedChanges(
  dirtyIds: Iterable<string>,
  baselines: UnsavedBaselines,
  rows: Readonly<Record<string, unknown>>,
  ctx: UnsavedContext,
): UnsavedResult {
  const out: UnsavedChange[] = [];
  const skipped: string[] = [];
  for (const rawId of dirtyIds) {
    const id = String(rawId);
    const live = rows[id] as Task | undefined;
    if (!live) { skipped.push(id); continue; }
    const { source: _source, FIRMED: _firmed, ...now } = ctx.snapshot(live) as Snap;
    const base = baselines.get(id);
    const before = base ? parseKey(base.key) : null;
    const firmDirty = ctx.firmDirtyIds.has(id);
    const firmNow = ctx.isFirmed(id);
    const src = ctx.dirtySource.get(id);
    const common = {
      id,
      material: String(live.MATERIAL_NUMBER ?? ''),
      materialDescription: String(live.MATERIAL_DESCRIPTION ?? ''),
      machine: String(live.MACHINE ?? ''),
      source: src ? String(src) : null,
      moveNote: moveNoteOf(live),
    };
    const finish = (status: UnsavedStatus, fields: UnsavedField[], deltaMs: number, hasBaseline: boolean): UnsavedChange => ({
      ...common, status, fields, deltaMs, hasBaseline,
      magnitude: Math.abs(deltaMs) / 3_600_000,
      rank: RANK[status],
    });

    if (!before) {
      // No server-proven reference: show what the order is now, never a made-up "before".
      const fields: UnsavedField[] = FIELD_DEFS.map(d => ({ key: d.key, kind: d.kind, after: valueOf(d.kind, now[d.wire], ctx) }));
      const segs = segmentCount(now);
      if (segs !== null) fields.push({ key: 'segments', kind: 'count', after: segs });
      if (firmDirty) fields.push({ key: 'firm', kind: 'bool', after: firmNow });
      out.push(finish('noref', fields, 0, false));
      continue;
    }

    const fields: UnsavedField[] = [];
    for (const d of FIELD_DEFS) {
      const b = valueOf(d.kind, before[d.wire], ctx);
      const a = valueOf(d.kind, now[d.wire], ctx);
      if (!same(a, b)) fields.push({ key: d.key, kind: d.kind, before: b, after: a });
    }
    const bSegs = segmentCount(before), aSegs = segmentCount(now);
    const segsChanged = JSON.stringify(before.schedule_segments ?? null) !== JSON.stringify(now.schedule_segments ?? null);
    if (segsChanged) fields.push({ key: 'segments', kind: 'count', before: bSegs, after: aSegs });
    if (firmDirty) fields.push({ key: 'firm', kind: 'bool', before: !firmNow, after: firmNow });

    const has = (k: UnsavedFieldKey): boolean => fields.some(f => f.key === k);
    const startMs = msOf(fields.find(f => f.key === 'start'));
    const finishMs = msOf(fields.find(f => f.key === 'finish'));
    const deltaMs = finishMs ? finishMs : (startMs ?? 0);
    const needsNow = emptyToNull(now.planning_status) === 'needs_planning';
    const needsBefore = emptyToNull(before.planning_status) === 'needs_planning';

    let status: UnsavedStatus;
    if (needsNow && !needsBefore) status = 'needs';
    else if (has('machine')) status = 'machine';
    // Finish-anchored: a run time edit that holds the finish only moves the start, and that is a run time change.
    else if (has('runtime') && !has('finish') && !has('segments')) status = 'runtime';
    else if (has('start') || has('finish') || has('segments')) status = 'moved';
    else if (has('runtime')) status = 'runtime';
    else if (has('pv') || has('prt1') || has('prt2')) status = 'tooling';
    else if (has('firm')) status = 'firm';
    else status = 'nochange';
    // A queued order loses its dates: the delta column says "unscheduled", not a made-up gap.
    out.push(finish(status, status === 'nochange' ? [] : fields, status === 'needs' ? 0 : deltaMs, true));
  }
  return { rows: out, skipped };
}

/** "Biggest move first": largest |delta| hours, then the more significant change kind, then the order id. */
export function sortUnsaved(rows: readonly UnsavedChange[], by: 'move' | 'order' | 'machine'): UnsavedChange[] {
  const cmpId = (a: UnsavedChange, b: UnsavedChange): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const biggest = (a: UnsavedChange, b: UnsavedChange): number => (b.magnitude - a.magnitude) || (b.rank - a.rank) || cmpId(a, b);
  const copy = [...rows];
  if (by === 'order') return copy.sort(cmpId);
  if (by === 'machine') return copy.sort((a, b) => a.machine.localeCompare(b.machine) || biggest(a, b));
  return copy.sort(biggest);
}

/** Case-insensitive match on order id, material number/description or machine. */
export function filterUnsaved(rows: readonly UnsavedChange[], query: string): UnsavedChange[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(r => `${r.id} ${r.material} ${r.materialDescription} ${r.machine}`.toLowerCase().includes(q));
}

/** "+2d 19h", "-2h", "+45m": a signed duration for the delta column (days only from 24 h). */
export function formatDeltaMs(ms: number): string {
  if (!ms) return '0h';
  const sign = ms < 0 ? '-' : '+';
  const totalMin = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  if (d) return `${sign}${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${sign}${h}h${m ? ` ${m}m` : ''}`;
  return `${sign}${m}m`;
}
