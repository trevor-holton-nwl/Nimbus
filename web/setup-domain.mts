/*
 * Pure setup-transition canonicalization and resolution.
 *
 * This module deliberately has no browser, Store, network, persistence, or
 * cache dependency. Stage 0 consumes its results only as observation data.
 */

import type {
  NimbusTask,
  ResolveSetupInput,
  ResolvedSetup,
  SetupDefinition,
  SetupMatrixRow,
  SetupOccurrenceOverride,
  SetupStateKey,
} from './types.mjs';

const ORDER_FIELD_BY_SIGNATURE_FIELD: Readonly<Record<string, string>> = {
  colorWheel: 'COLOR',
  prt01: 'PRT_01',
  prt02: 'PRT_02',
  productionVersion: 'PRODUCTION_VERSION',
};

/**
 * Canonicalizes one setup-attribute value to the same fold `setup_data._normalise_value`
 * applies server-side: trimmed and uppercased, except the literal booleans `"true"`/`"false"`
 * (case-insensitive), which pass through lowercase so they agree with `String(true)`/`String(false)`
 * and with the Python side's early bool-typed return. This is the single source of truth for
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
 * complete identical-state zero, then uncovered.
 */
export function resolveSetup(input: ResolveSetupInput): ResolvedSetup {
  const { definition, predecessorState, successorState } = input;
  const signatureVersion = definition.signature_version;
  if (!hasUsableDefinition(definition)
    || !hasCanonicalShape(predecessorState, definition)
    || !hasCanonicalShape(successorState, definition)) {
    return uncovered(signatureVersion);
  }

  const lineRow = matchingMatrixRow(input.machineRows, input.machine, predecessorState, successorState, definition);
  const plantRow = matchingMatrixRow(input.plantRows, '', predecessorState, successorState, definition);
  const override = matchingOverride(input.overrides, input);
  if (override) {
    const currentStandard = lineRow?.setup_min
      ?? plantRow?.setup_min
      ?? (isCompleteState(predecessorState, definition)
        && isCompleteState(successorState, definition)
        && statesEqual(predecessorState, successorState) ? 0 : override.standard_min);
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
