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

function normalizedValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
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
  return Number.isFinite(value) && value >= 0;
}

function matchingMatrixRow(
  rows: ReadonlyArray<SetupMatrixRow>,
  line: string,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
  definition: SetupDefinition,
): SetupMatrixRow | undefined {
  return rows.find(row => (
    row.line === line
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
    && override.line === input.line
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

  const lineRow = matchingMatrixRow(input.lineRows, input.line, predecessorState, successorState, definition);
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
