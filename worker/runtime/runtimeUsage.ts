import { z } from "zod";

import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  runtimeUsageObservationsSchema,
  type RuntimeUsageAggregate,
  type RuntimeUsageObservation,
} from "../shared/contracts/runtimeTerminalResult.ts";

/** An operation an execution said will report usage: its component and its key. */
export type RuntimeUsagePendingOperation = Readonly<{
  componentRole: string;
  key: string;
}>;

/**
 * Runtime's usage accounting: the operations each execution said will report usage, the ones it
 * settled, and the entries it reported. Each entry names its model; Runtime only adds them up.
 */
export type RuntimeUsageAccountingState = Readonly<{
  pending: readonly RuntimeUsagePendingOperation[];
  processedKeys: readonly string[];
  observations: readonly RuntimeUsageObservation[];
  incomplete: boolean;
}>;

type UsageOperationIdentity = Readonly<{
  componentRole: string;
  key: string;
  pendingKey?: string;
}>;
/**
 * What an execution reports of its usage, attached to its observations:
 *
 * - `expected`: an operation started that will report usage, under its key;
 * - `satisfied`: the operation settled with these entries, possibly none; a `pendingKey`
 *   names the expected operation it settles when its own key differs;
 * - `unavailable`: the operation settled, but its usage is unknown;
 * - `uncertain`: usage may have gone unreported, outside any one operation.
 *
 * An operation still expected when the usage is sealed, and any unavailable or uncertain
 * report, make the published usage incomplete.
 */
export type ConversationUsageEvidence =
  | Readonly<{ status: "expected"; componentRole: string; key: string }>
  | (UsageOperationIdentity &
      Readonly<{ status: "satisfied"; measurements: readonly RuntimeUsageObservation[] }>)
  | (UsageOperationIdentity & Readonly<{ status: "unavailable" }>)
  | Readonly<{ status: "uncertain" }>;

/** An operation an execution says will report usage, before it does. */
export type ExpectedUsageEvidence = Extract<ConversationUsageEvidence, { status: "expected" }>;

export type RuntimeUsageNormalization =
  | Readonly<{ status: "valid"; observations: readonly RuntimeUsageObservation[] }>
  | Readonly<{ status: "invalid" }>;

const nonBlank = z.string().trim().min(1);
export const runtimeUsageAccountingSchema = z
  .strictObject({
    pending: z
      .array(
        z
          .strictObject({
            componentRole: nonBlank,
            key: nonBlank,
          })
          .readonly(),
      )
      .readonly(),
    processedKeys: z.array(nonBlank).readonly(),
    observations: runtimeUsageObservationsSchema,
    incomplete: z.boolean(),
  })
  .readonly()
  .superRefine((state, context) => {
    const pendingKeys = state.pending.map(({ key }) => key);
    if (new Set(pendingKeys).size !== pendingKeys.length) {
      context.addIssue({ code: "custom", message: "Pending operation keys must be unique." });
    }
    if (new Set(state.processedKeys).size !== state.processedKeys.length) {
      context.addIssue({ code: "custom", message: "Processed operation keys must be unique." });
    }
    if (pendingKeys.some((key) => state.processedKeys.includes(key))) {
      context.addIssue({
        code: "custom",
        message: "An operation cannot be pending and processed.",
      });
    }
  });

export function createRuntimeUsageAccounting(): RuntimeUsageAccountingState {
  return { pending: [], processedKeys: [], observations: [], incomplete: false };
}

export function isRuntimeUsageAccountingState<Value>(
  value: Value,
): value is Value & RuntimeUsageAccountingState {
  return runtimeUsageAccountingSchema.safeParse(value).success;
}

const runtimeUsageAccountingBoundary = boundary({
  schema: z.preprocess((value) => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized === undefined ? undefined : z.unknown().parse(JSON.parse(serialized));
  }, runtimeUsageAccountingSchema),
  convert: (value): RuntimeUsageAccountingState => structuredClone(value),
});

export function parseRuntimeUsageAccountingState<Value>(
  value: Value,
): RuntimeUsageAccountingState | null {
  try {
    return runtimeUsageAccountingBoundary(value);
  } catch {
    return null;
  }
}

export function admitRuntimeUsageOperation(
  state: RuntimeUsageAccountingState,
  operation: RuntimeUsagePendingOperation,
): RuntimeUsageAccountingState {
  if (
    state.processedKeys.includes(operation.key) ||
    state.pending.some((pending) => pending.key === operation.key)
  ) {
    return state;
  }
  return { ...state, pending: [...state.pending, operation] };
}

export function settleRuntimeUsageOperation(
  state: RuntimeUsageAccountingState,
  input: Readonly<{
    componentRole: string;
    key: string;
    pendingKey?: string;
    usage: RuntimeUsageNormalization;
  }>,
): RuntimeUsageAccountingState {
  if (state.processedKeys.includes(input.key)) return state;
  const pendingKey = input.pendingKey ?? input.key;
  const pending = state.pending.filter((operation) => operation.key !== pendingKey);
  const observations =
    input.usage.status === "valid"
      ? addObservations(state.observations, input.usage.observations)
      : state.observations;
  return {
    ...state,
    pending,
    processedKeys: [...new Set([...state.processedKeys, pendingKey, input.key])],
    observations: observations ?? state.observations,
    incomplete: state.incomplete || input.usage.status === "invalid" || observations === null,
  };
}

export function markRuntimeUsageIncomplete(
  state: RuntimeUsageAccountingState,
): RuntimeUsageAccountingState {
  return state.incomplete ? state : { ...state, incomplete: true };
}

export function sealRuntimeUsage(state: RuntimeUsageAccountingState): RuntimeUsageAggregate {
  return {
    completeness: state.incomplete || state.pending.length > 0 ? "incomplete" : "complete",
    observations: [...state.observations].sort(compareObservations),
  };
}

function addObservations(
  current: readonly RuntimeUsageObservation[],
  added: readonly RuntimeUsageObservation[],
): readonly RuntimeUsageObservation[] | null {
  const sums = new Map(current.map((item) => [observationKey(item), item]));
  for (const item of added) {
    const key = observationKey(item);
    const existing = sums.get(key);
    const quantity = (existing?.quantity ?? 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) return null;
    sums.set(key, existing === undefined ? item : { ...existing, quantity });
  }
  return [...sums.values()].sort(compareObservations);
}

function observationKey(item: RuntimeUsageObservation): string {
  return [item.componentRole, item.provider, item.model, item.measure, item.unit].join(":");
}

function compareObservations(
  left: RuntimeUsageObservation,
  right: RuntimeUsageObservation,
): number {
  const leftKey = observationKey(left);
  const rightKey = observationKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function applyRuntimeUsageEvidence(
  state: RuntimeUsageAccountingState,
  evidence: readonly ConversationUsageEvidence[],
): RuntimeUsageAccountingState {
  return evidence.reduce((current, item) => {
    switch (item.status) {
      case "expected":
        return admitRuntimeUsageOperation(current, {
          componentRole: item.componentRole,
          key: item.key,
        });
      case "satisfied":
        return settleRuntimeUsageOperation(current, {
          ...item,
          usage: { status: "valid", observations: item.measurements },
        });
      case "unavailable":
        return settleRuntimeUsageOperation(current, { ...item, usage: { status: "invalid" } });
      case "uncertain":
        return markRuntimeUsageIncomplete(current);
    }
  }, state);
}
