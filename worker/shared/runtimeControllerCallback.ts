import {
  runtimeDiagnosticRecordSchema,
  type RuntimeDiagnosticRecord,
} from "./contracts/runtimeDiagnostics.ts";
import { z } from "zod";
import { resultWarningSchema, type ResultWarning } from "./contracts/resultWarnings.ts";

import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import type {
  RuntimeTranscriptSnapshot,
  RuntimeTranscriptSnapshotRef,
  RuntimeTranscriptTurn,
} from "./runtimeTranscriptSnapshot.ts";

export type {
  RuntimeTranscript,
  RuntimeTranscriptSnapshot,
  RuntimeTranscriptSnapshotRef,
  RuntimeTranscriptTurn,
} from "./runtimeTranscriptSnapshot.ts";

export const runtimeCompletedCallbackType = "runtimeCompleted";
export const runtimeTranscriptUpdatedCallbackType = "runtimeTranscriptUpdated";

export const runtimeTerminalOutcomes = Object.freeze(["ended", "failed"] as const);
export const runtimeEndReasons = Object.freeze([
  "participant_stopped",
  "timebox_reached",
  "agent_requested_end",
  "participant_disconnected",
  "runtime_failed",
] as const);

export type RuntimeTerminalOutcome = (typeof runtimeTerminalOutcomes)[number];
export type RuntimeEndReason = (typeof runtimeEndReasons)[number];

export {
  resultWarningSchema,
  runtimeWarnings,
  type ResultWarning,
  type RuntimeWarning,
} from "./contracts/resultWarnings.ts";

export type RuntimeCompletion = Readonly<{
  runId: string;
  outcome: RuntimeTerminalOutcome;
  endReason: RuntimeEndReason;
  source: string;
  endingStartedAt: number;
  endedAt: number;
  finalizedAt: number;
  transcriptSnapshot: RuntimeTranscriptSnapshotRef;
  warnings: readonly ResultWarning[];
}>;

export type RuntimeTranscriptUpdatedCallback = Readonly<{
  version: 2;
  type: typeof runtimeTranscriptUpdatedCallbackType;
  runId: string;
  snapshot: RuntimeTranscriptSnapshot;
}>;

export type RuntimeCompletedCallback = Readonly<{
  version: 2;
  type: typeof runtimeCompletedCallbackType;
  completion: RuntimeCompletion;
}>;

export type SnapshotReceiptStatus = "stored" | "idempotent" | "stale" | "conflict" | "sealed";

export type SnapshotReceipt = Readonly<{
  version: 2;
  status: SnapshotReceiptStatus;
  storedSnapshot: RuntimeTranscriptSnapshotRef | null;
  requestedMatches: boolean;
}>;

export type CompletionReceiptStatus =
  | "completed"
  | "idempotent"
  | "snapshot_mismatch"
  | "completion_conflict";

export type CompletionReceipt = Readonly<{
  version: 2;
  status: CompletionReceiptStatus;
  storedSnapshot: RuntimeTranscriptSnapshotRef | null;
  requestedMatches: boolean;
}>;

export type RuntimeTranscriptPayload = Readonly<{
  turns: readonly unknown[];
}>;

type RuntimeTranscriptPayloadWithValidatedTurns = Readonly<{
  turns: readonly RuntimeTranscriptTurn[];
}>;

export type RuntimeEventRecordEnvelope = RuntimeDiagnosticRecord;

type TranscriptPayloadOptions = Readonly<{
  requireTranscriptTurns?: boolean;
}>;

interface RuntimeTranscriptTurnGuard {
  (value: unknown): value is RuntimeTranscriptTurn;
}

interface RuntimeTranscriptSnapshotRefGuard {
  (value: unknown): value is RuntimeTranscriptSnapshotRef;
}

interface ResultWarningGuard {
  (value: unknown): value is ResultWarning;
}

interface RuntimeTerminalOutcomeGuard {
  (value: unknown): value is RuntimeTerminalOutcome;
}

interface RuntimeEndReasonGuard {
  (value: unknown): value is RuntimeEndReason;
}

const runtimeTerminalOutcomeSchema = z.enum(runtimeTerminalOutcomes);
const runtimeEndReasonSchema = z.enum(runtimeEndReasons);
const runtimeCallbackRunIdSchema = z.string().refine((value) => value.trim().length > 0);
const runtimeTranscriptDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const finiteIntegerSchema = z.number().int().safe().finite();
const runtimeTranscriptTurnSchema = z.object({
  role: z.enum(["participant", "conversationAgent"]),
  text: z.string(),
});
const runtimeTranscriptPayloadSchema = z.object({ turns: z.array(z.unknown()) });
const validatedRuntimeTranscriptPayloadSchema = z.object({
  turns: z.array(runtimeTranscriptTurnSchema),
});
const runtimeTranscriptSnapshotRefSchema = z.object({
  revision: nonNegativeSafeIntegerSchema,
  digest: runtimeTranscriptDigestSchema,
  turnCount: nonNegativeSafeIntegerSchema,
});
const runtimeTranscriptSnapshotSchema = z
  .object({
    revision: nonNegativeSafeIntegerSchema,
    digest: runtimeTranscriptDigestSchema,
    turnCount: nonNegativeSafeIntegerSchema,
    transcript: validatedRuntimeTranscriptPayloadSchema,
  })
  .refine((snapshot) => snapshot.turnCount === snapshot.transcript.turns.length);
const runtimeCompletionSchema = z.object({
  runId: runtimeCallbackRunIdSchema,
  outcome: runtimeTerminalOutcomeSchema,
  endReason: runtimeEndReasonSchema,
  source: z.string(),
  endingStartedAt: finiteIntegerSchema,
  endedAt: finiteIntegerSchema,
  finalizedAt: finiteIntegerSchema,
  transcriptSnapshot: runtimeTranscriptSnapshotRefSchema,
  warnings: z.array(resultWarningSchema),
});
const runtimeTranscriptUpdatedCallbackSchema = z.object({
  version: z.literal(2),
  type: z.literal(runtimeTranscriptUpdatedCallbackType),
  runId: runtimeCallbackRunIdSchema,
  snapshot: runtimeTranscriptSnapshotSchema,
});
const runtimeCompletedCallbackSchema = z
  .object({
    version: z.literal(2),
    type: z.literal(runtimeCompletedCallbackType),
    completion: runtimeCompletionSchema,
    runId: z.unknown().optional(),
  })
  .refine((callback) => !Object.hasOwn(callback, "runId"));
const runtimeEventRecordEnvelopeSchema = runtimeDiagnosticRecordSchema;

export const isRuntimeTerminalOutcome: RuntimeTerminalOutcomeGuard = (
  value,
): value is RuntimeTerminalOutcome => runtimeTerminalOutcomeSchema.safeParse(value).success;

export const isRuntimeEndReason: RuntimeEndReasonGuard = (value): value is RuntimeEndReason =>
  runtimeEndReasonSchema.safeParse(value).success;

export const isResultWarning: ResultWarningGuard = (value): value is ResultWarning =>
  resultWarningSchema.safeParse(value).success;

export const isRuntimeTranscriptTurn: RuntimeTranscriptTurnGuard = (
  value,
): value is RuntimeTranscriptTurn => runtimeTranscriptTurnSchema.safeParse(value).success;

export function isRuntimeTranscriptPayload(
  value: unknown,
  options: TranscriptPayloadOptions & Readonly<{ requireTranscriptTurns: true }>,
): value is RuntimeTranscriptPayloadWithValidatedTurns;
export function isRuntimeTranscriptPayload(
  value: unknown,
  options?: TranscriptPayloadOptions & Readonly<{ requireTranscriptTurns?: false }>,
): value is RuntimeTranscriptPayload;
export function isRuntimeTranscriptPayload(
  value: unknown,
  options: TranscriptPayloadOptions,
): value is RuntimeTranscriptPayload;
export function isRuntimeTranscriptPayload<Value>(
  value: Value,
  { requireTranscriptTurns = false }: TranscriptPayloadOptions = {},
): value is Value & RuntimeTranscriptPayload {
  return requireTranscriptTurns
    ? validatedRuntimeTranscriptPayloadSchema.safeParse(value).success
    : runtimeTranscriptPayloadSchema.safeParse(value).success;
}

export const isRuntimeTranscriptSnapshotRef: RuntimeTranscriptSnapshotRefGuard = (
  value,
): value is RuntimeTranscriptSnapshotRef =>
  runtimeTranscriptSnapshotRefSchema.safeParse(value).success;

export const decodeRuntimeTranscriptUpdatedCallback = boundary({
  schema: z.json().pipe(runtimeTranscriptUpdatedCallbackSchema),
  convert: (callback): RuntimeTranscriptUpdatedCallback => callback,
});

export const decodeRuntimeCompletedCallback = boundary({
  schema: z.preprocess((value) => z.json().parse(value), runtimeCompletedCallbackSchema),
  convert: (callback): RuntimeCompletedCallback => callback,
});

export const decodeRuntimeEventRecordEnvelope = boundary({
  schema: runtimeEventRecordEnvelopeSchema,
  convert: (record): RuntimeEventRecordEnvelope => record,
});
