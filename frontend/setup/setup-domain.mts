/*
 * Pure setup-transition canonicalization and resolution.
 *
 * This module deliberately has no browser, Store, network, persistence, or
 * cache dependency. Stage 0 consumes its results only as observation data.
 *
 * No cache lives here: this module holds zero module-level or mutable state.
 * `resolveSetup` remains a pure deterministic function of its inputs. It
 * optionally accepts a caller-owned prebuilt lookup index (`ResolveSetupInput.index`,
 * built by the exported `buildSetupResolutionIndex`) so a caller who resolves the
 * same plant snapshot thousands of times per optimize run can replace the three
 * linear scans (`matchingMatrixRow` ×2, `matchingOverride`) with O(1) map lookups.
 * Building and owning that index is entirely the caller's responsibility — this
 * module never builds, caches, or mutates one itself.
 */

import type {
  NimbusTask,
  ResolveSetupInput,
  ResolvedSetup,
  SetupDefinition,
  SetupMatrixRow,
  SetupOccurrenceOverride,
  SetupStateKey,
  SetupValueDefault,
} from '../platform/types.mjs';

const ORDER_FIELD_BY_SIGNATURE_FIELD: Readonly<Record<string, string>> = {
  colorWheel: 'COLOR',
  prt01: 'PRT_01',
  prt02: 'PRT_02',
  productionVersion: 'PRODUCTION_VERSION',
};

/**
 * Canonicalizes one setup-attribute value to the same fold `setup_data._normalise_value`
 * applies server-side: trimmed and uppercased, except the literal booleans `"true"`/`"false"`
 * (case-insensitive), which pass through lowercase so they agree with `String(true)`/`String(false)`.
 * The Python side's `_normalise_value` mirrors this only for real booleans: it upper-folds the
 * STRING "true" to "TRUE", so server-sourced strings (state values, stored rows, observed order
 * values) must be re-run through this client rule before any value-default lookup. This is the single source of truth for
 * setup state-value canonicalization on the client — see `setup-scheduler.mts`'s
 * `normalizedPriorityValue`, which reuses this fold for rank-lookup values.
 */
export function normalizedValue(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  const lowered = trimmed.toLowerCase();
  return lowered === 'true' || lowered === 'false' ? lowered : trimmed.toUpperCase();
}

function hasUsableDefinition(definition: SetupDefinition): boolean {
  return definition.fields.length > 0
    && definition.fields.every((fieldKey, index) => (
      typeof fieldKey === 'string'
      && fieldKey.length > 0
      && ORDER_FIELD_BY_SIGNATURE_FIELD[fieldKey] !== undefined
      && definition.fields.indexOf(fieldKey) === index
    ));
}

function hasCanonicalShape(state: SetupStateKey | null, definition: SetupDefinition): state is SetupStateKey {
  return Array.isArray(state)
    && state.length === definition.fields.length
    && state.every((entry, index) => (
      entry != null
      && entry.fieldKey === definition.fields[index]
      && typeof entry.value === 'string'
    ));
}

function isCompleteState(state: SetupStateKey | null, definition: SetupDefinition): state is SetupStateKey {
  return hasCanonicalShape(state, definition) && state.every(entry => entry.value.trim().length > 0);
}

function statesEqual(left: SetupStateKey, right: SetupStateKey): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.fieldKey === right[index]?.fieldKey && entry.value === right[index]?.value
  ));
}

function validMinutes(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function matchingMatrixRow(
  rows: ReadonlyArray<SetupMatrixRow>,
  machine: string,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
  definition: SetupDefinition,
): SetupMatrixRow | undefined {
  return rows.find(row => (
    row.machine === machine
    && row.signature_version === definition.signature_version
    && validMinutes(row.setup_min)
    && hasCanonicalShape(row.from_key, definition)
    && hasCanonicalShape(row.to_key, definition)
    && statesEqual(row.from_key, predecessorState)
    && statesEqual(row.to_key, successorState)
  ));
}

function matchingOverride(
  overrides: ReadonlyArray<SetupOccurrenceOverride>,
  input: ResolveSetupInput,
): SetupOccurrenceOverride | undefined {
  const { definition, predecessorState, successorState } = input;
  if (!hasCanonicalShape(predecessorState, definition) || !hasCanonicalShape(successorState, definition)) return undefined;

  return overrides.find(override => (
    override.status === 'active'
    && override.machine === input.machine
    && override.signature_version === definition.signature_version
    && override.predecessor_order_id === (input.predecessorOrderId ?? null)
    && override.successor_order_id === input.successorOrderId
    && validMinutes(override.standard_min)
    && validMinutes(override.remaining_min)
    && hasCanonicalShape(override.predecessor_state_key, definition)
    && hasCanonicalShape(override.successor_state_key, definition)
    && statesEqual(override.predecessor_state_key, predecessorState)
    && statesEqual(override.successor_state_key, successorState)
  ));
}

// ---------------------------------------------------------------------------
// Phase 1b — caller-owned prebuilt resolution index
// ---------------------------------------------------------------------------

/** Compound-key component join. `stateSignature` also joins with NUL, but one
 * level down (a state's own values); this joins independently-identified
 * components (machine, order id, a signature string). Joined with U+0000 (NUL), not a printable separator
 * like a space: machine codes and state values are real, uncontrolled
 * strings (e.g. a machine literally named "LINE 1", or a PRT value like
 * "TOOL A") that legitimately contain spaces, so a space-joined key lets two
 * DIFFERENT tuples collide on the SAME key string (machine "LINE" + from
 * "1 A" vs. machine "LINE 1" + from "A" both join to "LINE 1 A"). NUL is not
 * a character any of these domains can contain, so it is collision-safe for
 * this purpose — but see the residual checks in `indexedMatrixRow`/
 * `indexedOverride` below: correctness never depends on the key alone. */
function joinIndexKey(...parts: ReadonlyArray<string>): string {
  return parts.join('\0');
}

/** Sentinel for an absent/null key component (today: a null `predecessorOrderId`).
 * Chosen to be a string no real machine, order id, or signature value can equal. */
const ABSENT_KEY_COMPONENT = '__ABSENT_ORDER_ID__';

/**
 * Canonical string for a state's ordered VALUES, joined with a NUL escape
 * sequence (never a literal NUL byte; an empty join let ("10","220") and
 * ("102","20") share one key). In-memory key only, never persisted. Valid only
 * for states that have already passed `hasCanonicalShape` against the SAME
 * definition: shape validation already guarantees each state's fieldKeys equal
 * `definition.fields` in order, so `statesEqual` on two shape-valid states
 * reduces to value-array equality — which is exactly what comparing their
 * `stateSignature` strings tests. Do not key an unvalidated state this way.
 */
export function stateSignature(state: SetupStateKey): string {
  return state.map(entry => entry.value).join('\u0000');
}

/** Caller-owned prebuilt lookup index for `resolveSetup`. Built once per plant
 * snapshot (see `buildSetupResolutionIndex`) and passed in via
 * `ResolveSetupInput.index`; this module never builds or caches one itself. */
export interface SetupResolutionIndex {
  /** The `definition.signature_version` this index was built for. `resolveSetup`
   * ignores the index entirely when this doesn't match the call's definition. */
  signatureVersion: number;
  /** Line (machine) matrix rows keyed by `machine + NUL + fromSignature + NUL + toSignature`
   * (see `joinIndexKey`). Only rows that pass the exact build-time validation
   * `matchingMatrixRow` applies per-row are present; first-row-wins on a duplicate
   * key. The key alone is a bucketing optimization, not the correctness
   * guarantee — `resolveSetup`'s indexed path re-verifies `row.machine` and
   * both state keys via `indexedMatrixRow` before admitting a hit. */
  machineRows: ReadonlyMap<string, SetupMatrixRow>;
  /** Plant-default matrix rows (`machine === ''`) keyed by `fromSignature + NUL + toSignature`.
   * Same build-time validation, first-row-wins, and residual-verification semantics
   * as `machineRows`. */
  plantRows: ReadonlyMap<string, SetupMatrixRow>;
  /** Active, version-matched, shape-valid overrides grouped by the portion of
   * `matchingOverride`'s match identity that is fully known at build time —
   * `machine + NUL + (predecessorOrderId ?? ABSENT) + NUL + successorOrderId` —
   * in original relative order. The state-key equality checks depend on the
   * call's actual predecessor/successor states, which aren't part of any
   * override's identity key — so they are NOT baked into the key. `indexedOverride`
   * reruns those two `statesEqual` checks (plus a defensive re-check of the
   * machine/order-id components, guarding against a sentinel collision) over
   * this (small) group instead. */
  overrides: ReadonlyMap<string, ReadonlyArray<SetupOccurrenceOverride>>;
  /** Value defaults for this signature version: fieldKey -> (normalized value -> minutes).
   * Precomputed once so the resolver does two Map reads per changed field. */
  valueDefaults: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Builds the per-field default lookup. Version-filtered, keys normalized with the client rule,
 * minutes validated, blank values dropped, first entry wins on a (field, value) duplicate.
 * `undefined` is treated as no defaults (untyped callers). */
function buildValueDefaultMap(
  definition: SetupDefinition,
  valueDefaults: ReadonlyArray<SetupValueDefault> | undefined,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byField = new Map<string, Map<string, number>>();
  if (!valueDefaults) return byField;
  for (const entry of valueDefaults) {
    if (!entry || entry.signature_version !== definition.signature_version) continue;
    if (!definition.fields.includes(entry.field_key) || !validMinutes(entry.setup_min)) continue;
    const value = normalizedValue(entry.value);
    if (value.length === 0) continue;
    let values = byField.get(entry.field_key);
    if (!values) { values = new Map(); byField.set(entry.field_key, values); }
    if (!values.has(value)) values.set(value, entry.setup_min);
  }
  return byField;
}

/** The value-default tier: sums, over every field whose (normalized) value changed, the default
 * for the arriving value. A blank arriving value never contributes. Partial sums count: changed
 * fields with no default are named in `reason`. Returns null when no changed field contributes.
 * Raw values are compared first, so the normalization cost is paid only for fields that differ
 * (machine-state keys can arrive in the server's raw form, e.g. "TRUE"). */
function valueDefaultResolution(
  definition: SetupDefinition,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
  byField: ReadonlyMap<string, ReadonlyMap<string, number>>,
): { sum: number; reason: string } | null {
  if (byField.size === 0) return null;
  let sum = 0;
  let used: string[] | null = null;
  let missing: string[] | null = null;
  for (let i = 0; i < definition.fields.length; i += 1) {
    const from = predecessorState[i].value;
    const to = successorState[i].value;
    if (from === to) continue;
    const fieldKey = definition.fields[i];
    const values = byField.get(fieldKey);
    // Order-derived values are already normalized, so try the raw arriving value first: a hit proves
    // it is its own normalized form (map keys are normalized, and normalization is idempotent).
    let toValue = to;
    let minutes = values?.get(to);
    if (minutes === undefined) {
      toValue = normalizedValue(to);
      if (toValue.length === 0) continue;
      if (normalizedValue(from) === toValue) continue;
      minutes = toValue === to ? undefined : values?.get(toValue);
    } else if (normalizedValue(from) === toValue) continue;
    if (minutes === undefined) (missing ??= []).push(`${fieldKey}=${toValue}`);
    else { sum += minutes; (used ??= []).push(`${fieldKey}=${toValue} (${minutes})`); }
  }
  if (!used) return null;
  return {
    sum,
    reason: `Default by value: ${used.join(' + ')}${missing ? `; no default: ${missing.join(', ')}` : ''}`,
  };
}

/** Value-default tier entry point, hoisted so `resolveSetup` allocates no closure on calls an earlier tier
 * resolves. Uses the index's precomputed map when present, else builds one from `input.valueDefaults`. */
function resolveValueDefault(
  input: ResolveSetupInput,
  index: SetupResolutionIndex | null,
  definition: SetupDefinition,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
): { sum: number; reason: string } | null {
  const byField = index ? index.valueDefaults : buildValueDefaultMap(definition, input.valueDefaults);
  return valueDefaultResolution(definition, predecessorState, successorState, byField);
}

/**
 * Builds a `SetupResolutionIndex` from the same plant-snapshot inputs
 * `resolveSetup` already accepts (`definition`, `machineRows`, `plantRows`,
 * `overrides`). Pure and side-effect-free — the caller owns the returned index
 * and decides how long to keep it (e.g. per optimize run, invalidated whenever
 * the snapshot's `signature_version` changes).
 */
export function buildSetupResolutionIndex(input: {
  definition: SetupDefinition;
  machineRows: ReadonlyArray<SetupMatrixRow>;
  plantRows: ReadonlyArray<SetupMatrixRow>;
  overrides: ReadonlyArray<SetupOccurrenceOverride>;
  valueDefaults: ReadonlyArray<SetupValueDefault>;
}): SetupResolutionIndex {
  const { definition, machineRows, plantRows, overrides } = input;
  const signatureVersion = definition.signature_version;

  const isValidRow = (row: SetupMatrixRow): boolean => (
    row.signature_version === signatureVersion
    && validMinutes(row.setup_min)
    && hasCanonicalShape(row.from_key, definition)
    && hasCanonicalShape(row.to_key, definition)
  );

  const machineIndex = new Map<string, SetupMatrixRow>();
  for (const row of machineRows) {
    if (!isValidRow(row)) continue;
    const key = joinIndexKey(row.machine, stateSignature(row.from_key), stateSignature(row.to_key));
    if (!machineIndex.has(key)) machineIndex.set(key, row);
  }

  const plantIndex = new Map<string, SetupMatrixRow>();
  for (const row of plantRows) {
    // matchingMatrixRow is always called with machine === '' for plant rows,
    // so only plant-default rows can ever match — mirror that here.
    if (row.machine !== '' || !isValidRow(row)) continue;
    const key = joinIndexKey(stateSignature(row.from_key), stateSignature(row.to_key));
    if (!plantIndex.has(key)) plantIndex.set(key, row);
  }

  const overrideIndex = new Map<string, SetupOccurrenceOverride[]>();
  for (const override of overrides) {
    if (override.status !== 'active') continue;
    if (override.signature_version !== signatureVersion) continue;
    if (!validMinutes(override.standard_min) || !validMinutes(override.remaining_min)) continue;
    if (!hasCanonicalShape(override.predecessor_state_key, definition)) continue;
    if (!hasCanonicalShape(override.successor_state_key, definition)) continue;
    const key = joinIndexKey(override.machine, override.predecessor_order_id ?? ABSENT_KEY_COMPONENT, override.successor_order_id);
    const bucket = overrideIndex.get(key);
    if (bucket) bucket.push(override);
    else overrideIndex.set(key, [override]);
  }

  return {
    signatureVersion, machineRows: machineIndex, plantRows: plantIndex, overrides: overrideIndex,
    valueDefaults: buildValueDefaultMap(definition, input.valueDefaults),
  };
}

/** Fast-path matrix-row lookup: a Map hit is only a CANDIDATE. Correctness
 * must not depend on the key encoding alone, so this re-verifies the exact
 * predicates `matchingMatrixRow` applies beyond what build-time validation
 * already guarantees invariant of the call — `row.machine === machine` and
 * `statesEqual` on both from/to keys against the call's actual states —
 * before admitting the row. `machine` is `input.machine` for the line-row
 * index and `''` for the plant-row index, mirroring how `matchingMatrixRow`
 * is called today. */
function indexedMatrixRow(
  index: ReadonlyMap<string, SetupMatrixRow>,
  key: string,
  machine: string,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
): SetupMatrixRow | undefined {
  const row = index.get(key);
  if (!row) return undefined;
  if (row.machine !== machine) return undefined;
  if (!statesEqual(row.from_key, predecessorState)) return undefined;
  if (!statesEqual(row.to_key, successorState)) return undefined;
  return row;
}

/** Fast-path override lookup: narrows to the (small) group sharing the
 * build-time-known portion of `matchingOverride`'s match identity, then reruns
 * the ORIGINAL residual predicates over that group — not just the two
 * `statesEqual` checks that motivated grouping, but also machine/order-id
 * equality. That second layer is deliberate belt-and-suspenders: it is what
 * keeps this correct even in the theoretical case where a real order id
 * equals `ABSENT_KEY_COMPONENT`, which would otherwise make the sentinel and
 * a real "no predecessor" case collide on the same map key. First-row-wins
 * is preserved because the group retains original relative order. */
function indexedOverride(
  index: SetupResolutionIndex,
  input: ResolveSetupInput,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
): SetupOccurrenceOverride | undefined {
  const key = joinIndexKey(input.machine, input.predecessorOrderId ?? ABSENT_KEY_COMPONENT, input.successorOrderId);
  const bucket = index.overrides.get(key);
  if (!bucket) return undefined;
  return bucket.find(override => (
    override.machine === input.machine
    && override.predecessor_order_id === (input.predecessorOrderId ?? null)
    && override.successor_order_id === input.successorOrderId
    && statesEqual(override.predecessor_state_key, predecessorState)
    && statesEqual(override.successor_state_key, successorState)
  ));
}

function resolvedMatrix(row: SetupMatrixRow, source: 'line' | 'plant', signatureVersion: number): ResolvedSetup {
  return {
    covered: true,
    requiredMin: row.setup_min,
    effectiveMin: row.setup_min,
    standardMin: row.setup_min,
    source,
    reason: source === 'line' ? 'Line setup-matrix row' : 'Plant setup-matrix row',
    signatureVersion,
  };
}

function uncovered(signatureVersion: number): ResolvedSetup {
  return {
    covered: false,
    requiredMin: null,
    effectiveMin: null,
    standardMin: null,
    source: 'uncovered',
    reason: 'No version-matched setup transition covers this state pair',
    signatureVersion,
  };
}

/**
 * Builds an ordered signature for an order. Under strict blanks, one blank or
 * absent configured value makes the whole state unavailable rather than
 * allowing an ambiguous state to masquerade as an identical transition.
 */
export function stateForOrder(order: NimbusTask, definition: SetupDefinition): SetupStateKey | null {
  if (!hasUsableDefinition(definition)) return null;

  const state = definition.fields.map(fieldKey => ({
    fieldKey,
    value: normalizedValue(order[ORDER_FIELD_BY_SIGNATURE_FIELD[fieldKey]]),
  }));

  return definition.strict_blanks && state.some(entry => entry.value.length === 0) ? null : state;
}

/**
 * Resolves a version-matched setup transition without changing schedule data.
 * The deliberate precedence is occurrence override, line row, plant row,
 * complete identical-state zero, value default (sum of arriving-value defaults), then uncovered.
 */
export function resolveSetup(input: ResolveSetupInput): ResolvedSetup {
  const { definition, predecessorState, successorState } = input;
  const signatureVersion = definition.signature_version;
  if (!hasUsableDefinition(definition)
    || !hasCanonicalShape(predecessorState, definition)
    || !hasCanonicalShape(successorState, definition)) {
    return uncovered(signatureVersion);
  }

  const index = input.index && input.index.signatureVersion === signatureVersion ? input.index : null;

  let lineRow: SetupMatrixRow | undefined;
  let plantRow: SetupMatrixRow | undefined;
  let override: SetupOccurrenceOverride | undefined;

  if (index) {
    const fromSig = stateSignature(predecessorState);
    const toSig = stateSignature(successorState);
    lineRow = indexedMatrixRow(
      index.machineRows, joinIndexKey(input.machine, fromSig, toSig),
      input.machine, predecessorState, successorState,
    );
    plantRow = indexedMatrixRow(
      index.plantRows, joinIndexKey(fromSig, toSig),
      '', predecessorState, successorState,
    );
    override = indexedOverride(index, input, predecessorState, successorState);
  } else {
    lineRow = matchingMatrixRow(input.machineRows, input.machine, predecessorState, successorState, definition);
    plantRow = matchingMatrixRow(input.plantRows, '', predecessorState, successorState, definition);
    override = matchingOverride(input.overrides, input);
  }

  if (override) {
    const currentStandard = lineRow?.setup_min
      ?? plantRow?.setup_min
      ?? (isCompleteState(predecessorState, definition)
        && isCompleteState(successorState, definition)
        && statesEqual(predecessorState, successorState) ? 0 : (resolveValueDefault(input, index, definition, predecessorState, successorState)?.sum ?? override.standard_min));
    return {
      covered: true,
      requiredMin: override.remaining_min,
      effectiveMin: override.remaining_min,
      standardMin: currentStandard,
      source: 'occurrence',
      reason: override.reason || 'Occurrence-specific setup override',
      signatureVersion,
      overrideId: String(override.id),
    };
  }

  if (lineRow) return resolvedMatrix(lineRow, 'line', signatureVersion);

  if (plantRow) return resolvedMatrix(plantRow, 'plant', signatureVersion);

  if (isCompleteState(predecessorState, definition)
    && isCompleteState(successorState, definition)
    && statesEqual(predecessorState, successorState)) {
    return {
      covered: true,
      requiredMin: 0,
      effectiveMin: 0,
      standardMin: 0,
      source: 'implicit-zero',
      reason: 'Identical complete setup states',
      signatureVersion,
    };
  }

  const byDefault = resolveValueDefault(input, index, definition, predecessorState, successorState);
  if (byDefault) {
    return {
      covered: true,
      requiredMin: byDefault.sum,
      effectiveMin: byDefault.sum,
      standardMin: byDefault.sum,
      source: 'value-default',
      reason: byDefault.reason,
      signatureVersion,
    };
  }

  return uncovered(signatureVersion);
}

/**
 * Read-only Stage 0 measurement over an already-hydrated plant snapshot.
 * This deliberately derives counts only: it never writes a task, Store, or
 * persistence payload and it does not claim rendering/redraw performance.
 */
export function computeShadowDiagnostics(
  snapshot: {
    plant: string;
    definition: SetupDefinition | null;
    plant_rows: ReadonlyArray<SetupMatrixRow>;
    machine_rows: ReadonlyArray<SetupMatrixRow>;
    overrides: ReadonlyArray<SetupOccurrenceOverride>;
    value_defaults?: ReadonlyArray<SetupValueDefault>;
  },
  tasks: ReadonlyArray<NimbusTask>,
  policy: { percentile?: number } = {},
): {
  coveredTransitions: number;
  uncoveredTransitions: number;
  totalStandardMinutes: number;
  distinctStates: { count: number; median: number; max: number; percentile: number };
  taskCount: number;
  derivationMs: number;
} {
  const started = globalThis.performance?.now?.() ?? Date.now();
  const definition = snapshot.definition;
  const percentile = Math.min(1, Math.max(0, policy.percentile ?? 0.95));
  if (!definition) {
    return { coveredTransitions: 0, uncoveredTransitions: 0, totalStandardMinutes: 0,
      distinctStates: { count: 0, median: 0, max: 0, percentile: 0 }, taskCount: tasks.length,
      derivationMs: (globalThis.performance?.now?.() ?? Date.now()) - started };
  }

  const byLine = new Map<string, NimbusTask[]>();
  const density = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (task.PLANT && task.PLANT !== snapshot.plant) continue;
    const line = task.MACHINE;
    if (!line) continue;
    const state = stateForOrder(task, definition);
    const stamp = task.start_date instanceof Date ? task.start_date : null;
    if (state && stamp) {
      const day = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
      const key = `${line}\u0000${day}`;
      const states = density.get(key) ?? new Set<string>();
      states.add(JSON.stringify(state));
      density.set(key, states);
    }
    const lineTasks = byLine.get(line) ?? [];
    lineTasks.push(task);
    byLine.set(line, lineTasks);
  }

  let coveredTransitions = 0;
  let uncoveredTransitions = 0;
  let totalStandardMinutes = 0;
  for (const [line, lineTasks] of byLine) {
    lineTasks.sort((left, right) => Number(left.start_date) - Number(right.start_date));
    for (let index = 1; index < lineTasks.length; index += 1) {
      const predecessor = lineTasks[index - 1];
      const successor = lineTasks[index];
      const predecessorState = stateForOrder(predecessor, definition);
      const successorState = stateForOrder(successor, definition);
      if (!predecessorState || !successorState) continue;
      const result = resolveSetup({
        definition, machine: line, predecessorState, successorState,
        predecessorOrderId: predecessor.id, successorOrderId: successor.id,
        plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, overrides: snapshot.overrides,
        valueDefaults: snapshot.value_defaults ?? [],
      });
      if (result.covered) {
        coveredTransitions += 1;
        totalStandardMinutes += result.standardMin ?? 0;
      } else {
        uncoveredTransitions += 1;
      }
    }
  }
  const counts = [...density.values()].map(values => values.size).sort((left, right) => left - right);
  const at = (ratio: number) => counts.length ? counts[Math.min(counts.length - 1, Math.floor((counts.length - 1) * ratio))] : 0;
  return {
    coveredTransitions, uncoveredTransitions, totalStandardMinutes,
    distinctStates: { count: counts.reduce((sum, value) => sum + value, 0), median: at(0.5), max: counts.at(-1) ?? 0, percentile: at(percentile) },
    taskCount: tasks.length,
    derivationMs: (globalThis.performance?.now?.() ?? Date.now()) - started,
  };
}
