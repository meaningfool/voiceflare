import { z } from "zod";

import { boundary } from "../../tools/boundary-contracts/boundary-contracts.mjs";
import {
  conversationNodeExecutionSchema,
  hasCompleteNodeTranscriptInventory,
} from "./conversationNode.ts";
import { conversationVisitSchema, executionIdentitySchema } from "./executionContracts.ts";
import { permitsPendingFinalizationEffectPersistence } from "./interviewFinalizationEffectPolicy.ts";
import {
  finalInputWarnings,
  finalizationEffectKinds,
  getSerializedTranscriptTurns,
  interviewFinalizationPeriodMs,
  interviewResultPublicationPeriodMs,
  nodeLimitation,
  type InterviewFinalizationAggregate,
} from "./interviewFinalizationModel.ts";
import { runtimeUsageAccountingSchema } from "./runtimeUsage.ts";
import {
  liveTerminalResultSchema,
  type TranscriptIncompleteReason,
} from "../shared/contracts/runtimeTerminalResult.ts";
import {
  isRuntimeTranscriptTurn,
  runtimeEndReasons,
  resultWarningSchema,
  runtimeTerminalOutcomes,
  type RuntimeTranscriptTurn,
} from "../shared/runtimeControllerCallback.ts";

// The persisted finalization aggregate. Each persisted type in interviewFinalizationModel.ts is
// the z.output of a schema here. Structure rules out invalid combinations; the aggregate
// refinement keeps only named facts that relate separate fields.

const safeInteger = z.number().int();
const nonNegativeInteger = safeInteger.nonnegative();
const positiveInteger = safeInteger.positive();
const identifier = z.string().min(1);
const nonBlank = z.string().refine((value) => value.trim().length > 0);
const transcriptDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const transcriptRole = z.enum(["participant", "conversationAgent"]);
const finalizationWarnings = z.array(resultWarningSchema).readonly();
const endReasonSchema = z.enum(runtimeEndReasons);
const responseTerminalStatus = z.enum(["completed", "cancelled", "failed", "incomplete"]);

/** The persisted order of an accepted native observation or close barrier. */
export const providerObservationOrderSchema = z
  .strictObject({ generation: nonNegativeInteger, sequence: nonNegativeInteger })
  .readonly();

const serializedTranscriptItemSchema = z
  .strictObject({
    itemId: identifier,
    firstSeenSequence: nonNegativeInteger,
    previousItemId: z.string().optional(),
    role: transcriptRole.optional(),
    responseId: z.string().optional(),
    outputIndex: nonNegativeInteger.optional(),
    contentIndex: nonNegativeInteger.optional(),
    nonTranscript: z.boolean().optional(),
    text: z.string().optional(),
    finalSequence: nonNegativeInteger.optional(),
  })
  .readonly();

export const serializedTranscriptCaptureSchema = z
  .strictObject({
    sequence: nonNegativeInteger,
    items: z.array(serializedTranscriptItemSchema).readonly(),
  })
  .readonly()
  .refine(({ items }) => isUnique(items.map(({ itemId }) => itemId)), {
    message: "duplicate_transcript_item",
  });

const effectFields = {
  id: identifier,
  status: z.enum(["pending", "sending", "dispatched", "failed", "uncertain"]),
  acceptance: z.enum(["unobserved", "benign_rejection", "rejected"]),
  attemptCount: nonNegativeInteger,
};

/**
 * A finalization effect. Cancellation names its reply, the digest its Transcript revision, and
 * the input closure the participant item Runtime already held when input closed, or null.
 */
export const finalizationEffectRecordSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({ ...effectFields, kind: z.literal("cancel_reply"), responseId: nonBlank })
    .readonly(),
  z
    .strictObject({
      ...effectFields,
      kind: z.literal("compute_transcript_digest"),
      revision: nonNegativeInteger,
    })
    .readonly(),
  z
    .strictObject({
      ...effectFields,
      kind: z.literal("close_input"),
      heldItemId: nonBlank.nullable(),
    })
    .readonly(),
  z
    .strictObject({
      ...effectFields,
      kind: z
        .enum(finalizationEffectKinds)
        .exclude(["cancel_reply", "compute_transcript_digest", "close_input"]),
    })
    .readonly(),
]);

const effects = z.array(finalizationEffectRecordSchema).readonly();

const liveSignalFields = {
  activeInputItemId: z.string().nullable(),
  activeResponseId: z.string().nullable(),
  outputAudioActive: z.boolean(),
  sessionClosed: z.boolean(),
  providerCloseBarrier: providerObservationOrderSchema.optional(),
};

/** Facts accepted at Ending entry and retained by every Ending stage before the result freezes. */
const endingFields = {
  endReason: endReasonSchema,
  source: z.string(),
  strategy: z.literal("hard_stop"),
  endingStartedAt: safeInteger,
  finalizationCutoffAt: safeInteger,
  activeInputItemId: z.string().nullable(),
  activeResponseId: z.string().nullable(),
  admittedResponseId: z.string().nullable(),
  sessionClosed: z.boolean(),
  effects,
  warnings: finalizationWarnings,
};

/** Draining and provider closing still observe participant and output signals. */
const openEndingFields = { ...endingFields, ...liveSignalFields };

export const runtimeFinalizationCompletionSchema = z
  .strictObject({
    runId: z.string(),
    outcome: z.enum(runtimeTerminalOutcomes),
    endReason: endReasonSchema,
    source: z.string(),
    endingStartedAt: safeInteger,
    endedAt: safeInteger,
    finalizationCutoffAt: safeInteger,
    finalizedAt: safeInteger,
    transcriptSnapshot: z
      .strictObject({
        revision: nonNegativeInteger,
        digest: transcriptDigest,
        turnCount: nonNegativeInteger,
      })
      .readonly(),
    warnings: finalizationWarnings,
  })
  .readonly();

const publicationFields = {
  /** finalizedAt plus the publication period, fixed when the result froze. */
  publicationCutoffAt: nonNegativeInteger,
  transcriptDelivered: z.boolean(),
  completionDelivered: z.boolean(),
  attemptCount: nonNegativeInteger,
};

/** Delivery of the frozen result; it exists only once the Run has ended. */
export const runtimePublicationStateSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      ...publicationFields,
      status: z.literal("pending"),
      retryAt: nonNegativeInteger.nullable(),
      deliveredAt: z.null(),
      lastError: z.null(),
    })
    .readonly(),
  z
    .strictObject({
      ...publicationFields,
      status: z.enum(["retrying", "blocked_snapshot_conflict", "blocked_nonretryable_callback"]),
      retryAt: nonNegativeInteger.nullable(),
      deliveredAt: z.null(),
      lastError: identifier,
    })
    .readonly(),
  z
    .strictObject({
      ...publicationFields,
      status: z.literal("delivered"),
      transcriptDelivered: z.literal(true),
      completionDelivered: z.literal(true),
      retryAt: z.null(),
      deliveredAt: nonNegativeInteger,
      lastError: z.null(),
    })
    .readonly(),
  z
    .strictObject({
      ...publicationFields,
      status: z.literal("expired"),
      retryAt: z.null(),
      deliveredAt: z.null(),
      lastError: z.string().nullable(),
    })
    .readonly(),
]);

/**
 * Lifecycle stages. Live carries no ending facts, every Ending stage composes the accepted
 * ending, and only an ended Run has a completion and its publication.
 */
export const interviewFinalizationStateSchema = z.discriminatedUnion("stage", [
  z
    .strictObject({
      stage: z.literal("live"),
      ...liveSignalFields,
      effects,
    })
    .readonly(),
  z.strictObject({ stage: z.literal("draining"), ...openEndingFields }).readonly(),
  z.strictObject({ stage: z.literal("closing_provider"), ...openEndingFields }).readonly(),
  z.strictObject({ stage: z.literal("finalizing"), ...endingFields }).readonly(),
  z
    .strictObject({
      stage: z.literal("ended"),
      completion: runtimeFinalizationCompletionSchema,
      publication: runtimePublicationStateSchema,
      effects,
    })
    .readonly(),
]);

const finalInputFields = {
  admissionCutoffAt: nonNegativeInteger,
  fence: providerObservationOrderSchema,
  effectId: identifier,
  /** The execution reported participant input that this closure settles. */
  inputToSettle: z.boolean(),
  /** The execution answers the closure itself: Runtime settles no answer at quiet. */
  answerFollows: z.boolean(),
  settledByTerminalObservation: z.boolean().optional(),
  quietDeadline: positiveInteger,
  duplicateCount: nonNegativeInteger,
  warning: z.enum(finalInputWarnings).nullable(),
};

/**
 * Persisted final-input obligation. The obligation decides whether an admitted item exists:
 * none while awaiting an item, exactly one while awaiting its transcription, and either once
 * settled. Ending states derive admission from this value through `admittedFinalInputItemId`.
 */
export const finalInputStateSchema = z.discriminatedUnion("obligation", [
  z
    .strictObject({
      ...finalInputFields,
      obligation: z.literal("awaiting_item"),
      admittedItemId: z.null(),
    })
    .readonly(),
  z
    .strictObject({
      ...finalInputFields,
      obligation: z.literal("awaiting_transcription"),
      admittedItemId: z.string(),
    })
    .readonly(),
  z
    .strictObject({
      ...finalInputFields,
      obligation: z.literal("settled"),
      admittedItemId: z.string().nullable(),
    })
    .readonly(),
]);

const providerResponseFields = {
  responseId: identifier,
  outputAudio: z.enum(["pending", "active", "stopped"]),
  /**
   * When the reply's delivered audio has finished playing at the participant, as far as the
   * execution can tell, when it reported more than that its delivery stopped.
   */
  playbackEndsAt: nonNegativeInteger.optional(),
  /** Native evidence retains its issuing operation even after semantic authority expires. */
  conversationScope: executionIdentitySchema.readonly().nullable().optional(),
};

/** Only a terminal response can have proven a complete non-Transcript inventory. */
export const providerResponseLifecycleSchema = z.discriminatedUnion("status", [
  z
    .strictObject({ ...providerResponseFields, status: z.enum(["unobserved", "active"]) })
    .readonly(),
  z
    .strictObject({
      ...providerResponseFields,
      status: responseTerminalStatus,
      /** A completed, nonempty terminal inventory conclusively contained no Transcript output. */
      nonTranscriptInventoryComplete: z.literal(true).optional(),
    })
    .readonly(),
]);

const gracefulCompletionFields = {
  callId: identifier.nullable(),
  responseId: identifier,
  itemId: z.string().nullable(),
  responseSettlement: z.enum(["pending", "completed", "cancelled", "failed", "incomplete"]),
  executionIdentity: executionIdentitySchema.readonly().optional(),
};

/** A participant safety override always contained the selected output. */
export const gracefulCompletionStateSchema = z.discriminatedUnion(
  "participantMediaSafetyOverride",
  [
    z
      .strictObject({
        ...gracefulCompletionFields,
        participantMediaSafetyOverride: z.literal(false),
        outputAudioSettlement: z.enum(["pending", "active", "stopped", "contained"]),
      })
      .readonly(),
    z
      .strictObject({
        ...gracefulCompletionFields,
        participantMediaSafetyOverride: z.literal(true),
        outputAudioSettlement: z.literal("contained"),
      })
      .readonly(),
  ],
);

const transcriptObligationSchema = z
  .strictObject({
    itemId: identifier,
    role: transcriptRole,
    status: z.enum(["pending", "captured", "failed", "non_transcript"]),
  })
  .readonly();

const applicationTranscriptProofFields = {
  liveAt: nonNegativeInteger,
  /** Cutoff left selected output or a required received prefix unprovable. */
  evidenceGap: z.boolean().optional(),
  /** Response inventories accepted before sealing; absent until the first is accepted. */
  inventoriedResponseIds: z.array(identifier).readonly().optional(),
  obligations: z.array(transcriptObligationSchema).readonly(),
  closeBarrier: z
    .strictObject({
      generation: nonNegativeInteger,
      sequence: nonNegativeInteger,
      providerEventId: z.string().optional(),
    })
    .readonly()
    .nullable(),
  result: liveTerminalResultSchema.readonly().nullable(),
};

/** The Transcript proof created at go-live. An interrupted Run has no completed reason. */
export const applicationTranscriptProofSchema = z
  .discriminatedUnion("interrupted", [
    z
      .strictObject({
        ...applicationTranscriptProofFields,
        interrupted: z.literal(false),
        completedReason: z
          .enum(["participant_stopped", "timebox_reached", "agent_requested_end"])
          .optional(),
      })
      .readonly(),
    z
      .strictObject({ ...applicationTranscriptProofFields, interrupted: z.literal(true) })
      .readonly(),
  ])
  .refine(
    (proof) =>
      isUnique(proof.inventoriedResponseIds ?? []) &&
      isUnique(proof.obligations.map(({ itemId }) => itemId)),
    { message: "duplicate_transcript_proof_identity" },
  );

const interviewFinalizationAggregateFields = z
  .strictObject({
    runId: identifier,
    state: interviewFinalizationStateSchema,
    conversationVisit: conversationVisitSchema.optional(),
    conversationNodeExecution: conversationNodeExecutionSchema.optional(),
    applicationTranscriptProof: applicationTranscriptProofSchema,
    /** Current output selected by the first participant End or duration expiry. */
    retainedInterviewerResponseId: nonBlank.optional(),
    runtimeUsage: runtimeUsageAccountingSchema,
    lastProviderObservationAt: nonNegativeInteger.optional(),
    transcriptCapture: serializedTranscriptCaptureSchema,
    transcriptRevision: nonNegativeInteger,
    transcriptDigest: transcriptDigest.nullable(),
    nextProviderSequence: positiveInteger,
    nextEffectSequence: positiveInteger,
    nextEventSequence: positiveInteger,
    providerGeneration: nonNegativeInteger,
    acceptedProviderOrder: providerObservationOrderSchema.nullable(),
    providerResponses: z.array(providerResponseLifecycleSchema).readonly(),
    /** Warnings the execution attached while Live, which the result carries. */
    executionWarnings: finalizationWarnings.optional(),
    unidentifiedOutputAudioActive: z.boolean(),
    gracefulCompletion: gracefulCompletionStateSchema.nullable(),
    finalInput: finalInputStateSchema.nullable(),
  })
  .readonly();

type AggregateFields = z.output<typeof interviewFinalizationAggregateFields>;

/** Facts that relate separate fields. Each is named, and a failure reports which one. */
const aggregateRefinements: readonly (readonly [string, (value: AggregateFields) => boolean])[] = [
  ["effect_identities", hasValidEffectIdentities],
  ["stage_pending_effects", hasStagePermittedPendingEffects],
  ["ending_cutoffs", hasPersistedEndingCutoffs],
  ["provider_tracking", hasConsistentProviderTracking],
  ["provider_responses", hasConsistentProviderResponses],
  ["conversation_node", hasConsistentConversationNode],
  ["retained_interviewer_response", hasValidRetainedInterviewerResponse],
  ["last_provider_observation", hasLiveProviderObservationTime],
  ["transcript_digest", hasConsistentTranscriptDigest],
  ["graceful_completion", hasConsistentGracefulCompletion],
  ["final_input", hasConsistentFinalInput],
  ["frozen_result", hasConsistentFrozenResult],
  ["application_transcript_proof", hasValidApplicationTranscriptProof],
];

export const interviewFinalizationAggregateSchema =
  interviewFinalizationAggregateFields.superRefine((value, context) => {
    const failed = aggregateRefinements.find(([, holds]) => !holds(value));
    if (failed !== undefined)
      context.addIssue({ code: "custom", message: `inconsistent_${failed[0]}` });
  });

type PersistedJsonValue =
  | string
  | number
  | boolean
  | null
  | PersistedJsonRecord
  | readonly PersistedJsonValue[];
interface PersistedJsonRecord {
  readonly [key: string]: PersistedJsonValue | undefined;
}

const storedJsonValueSchema = z.custom<PersistedJsonValue>(isPersistedJsonValue);
// A caller's in-memory value is detached; text parsed from storage is already owned.
const persistedJsonValueSchema = storedJsonValueSchema.transform((value) => structuredClone(value));

export function parseJsonValue(value: string | null): PersistedJsonValue {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = storedJsonValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseJsonObject(value: string | null): PersistedJsonRecord | null {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : null;
}

export function readStoredTranscriptTurns(value: string | null): RuntimeTranscriptTurn[] {
  const parsed = parseJsonObject(value);
  return Array.isArray(parsed?.turns) ? parsed.turns.filter(isRuntimeTranscriptTurn) : [];
}

export const decodeInterviewFinalizationAggregate = boundary({
  schema: z.union([z.string(), persistedJsonValueSchema, z.undefined().transform(() => null)]),
  convert: (value): InterviewFinalizationAggregate | null => {
    const parsed = typeof value === "string" ? parseJsonValue(value) : value;
    return isInterviewFinalizationAggregate(parsed) ? parsed : null;
  },
});

export function isInterviewFinalizationAggregate<Value>(
  value: Value,
): value is Value & InterviewFinalizationAggregate {
  return interviewFinalizationAggregateSchema.safeParse(value).success;
}

/** Effect ids are allocated from this Run's sequence; one active intent per kind and target. */
function hasValidEffectIdentities({ runId, nextEffectSequence, state }: AggregateFields): boolean {
  const ids = new Set<string>();
  const activeIntents = new Set<string>();
  const prefix = `${runId}:`;
  for (const effect of state.effects) {
    if (ids.has(effect.id) || !effect.id.startsWith(prefix)) return false;
    ids.add(effect.id);
    const sequenceText = effect.id.slice(prefix.length);
    const sequence = Number(sequenceText);
    if (!/^[1-9][0-9]*$/u.test(sequenceText) || !Number.isSafeInteger(sequence)) return false;
    if (sequence >= nextEffectSequence) return false;
    if (effect.status === "failed") continue;
    const target =
      effect.kind === "cancel_reply"
        ? effect.responseId
        : effect.kind === "compute_transcript_digest"
          ? String(effect.revision)
          : "";
    const intent = `${effect.kind}:${target}`;
    if (activeIntents.has(intent)) return false;
    activeIntents.add(intent);
  }
  return true;
}

/**
 * Pending records follow the stage's effect policy. A live or draining hangup is pending only
 * as the retained-output cleanup that the node has claimed.
 */
function hasStagePermittedPendingEffects({
  state,
  conversationNodeExecution: node,
}: AggregateFields): boolean {
  const claimedCleanupId =
    node?.kind === "retained_output" && node.cleanup.status === "claimed"
      ? node.cleanup.effectId
      : undefined;
  return state.effects.every(
    (effect) =>
      effect.status !== "pending" ||
      (permitsPendingFinalizationEffectPersistence(state.stage, effect.kind) &&
        ((state.stage !== "live" && state.stage !== "draining") ||
          effect.kind !== "release_session" ||
          effect.id === claimedCleanupId)),
  );
}

/** Ending keeps its persisted absolute cutoff, and a frozen result its publication cutoff. */
function hasPersistedEndingCutoffs({ state }: AggregateFields): boolean {
  if (state.stage === "live") return true;
  const ending = state.stage === "ended" ? state.completion : state;
  return (
    ending.finalizationCutoffAt === ending.endingStartedAt + interviewFinalizationPeriodMs &&
    (state.stage !== "ended" ||
      state.publication.publicationCutoffAt ===
        state.completion.finalizedAt + interviewResultPublicationPeriodMs)
  );
}

/** The accepted order never runs ahead of the next expected report. */
function hasConsistentProviderTracking({
  acceptedProviderOrder: accepted,
  providerGeneration,
  nextProviderSequence,
}: AggregateFields): boolean {
  return (
    accepted === null ||
    (accepted.generation <= providerGeneration &&
      (accepted.generation < providerGeneration || accepted.sequence < nextProviderSequence))
  );
}

/**
 * Responses are unique and scoped to this Run; a graceful completion's identity is the one its
 * response retained.
 */
function hasConsistentProviderResponses({
  runId,
  providerResponses,
  gracefulCompletion: graceful,
}: AggregateFields): boolean {
  if (!isUnique(providerResponses.map(({ responseId }) => responseId))) return false;
  if (
    providerResponses.some(
      ({ conversationScope }) => conversationScope != null && conversationScope.runId !== runId,
    )
  )
    return false;
  const identity = graceful?.executionIdentity;
  if (graceful === null || identity === undefined) return true;
  const retained = providerResponses.find(
    ({ responseId }) => responseId === graceful.responseId,
  )?.conversationScope;
  return (
    retained != null &&
    retained.visitId === identity.visitId &&
    retained.operationId === identity.operationId &&
    retained.generation === identity.generation &&
    identity.runId === runId
  );
}

/** A dispatch belongs to the current visit, and a finishing reservation to the accepted end. */
function hasConsistentConversationNode({
  conversationNodeExecution: node,
  conversationVisit: visit,
  state,
}: AggregateFields): boolean {
  if (node?.dispatch === undefined) return true;
  if (visit === undefined) return false;
  if (state.stage === "live") return true;
  if (
    node.dispatch.status === "pending" ||
    node.dispatch.status === "claimed" ||
    node.dispatch.status === "dispatched"
  )
    return false;
  if (node.kind === "ordinary") return true;
  const ending = state.stage === "ended" ? state.completion : state;
  if (ending.endReason !== node.reservation.reason) return false;
  if (node.participantEnd === undefined) return true;
  return (
    ending.endingStartedAt === node.participantEnd.at &&
    ending.finalizationCutoffAt === node.participantEnd.at + interviewFinalizationPeriodMs &&
    ending.source === node.reservation.source
  );
}

/** Only an End that retains the current output selects it, as the Ending's admitted output. */
function hasValidRetainedInterviewerResponse({
  retainedInterviewerResponseId: responseId,
  conversationNodeExecution: node,
  gracefulCompletion,
  state,
}: AggregateFields): boolean {
  if (responseId === undefined) return true;
  if (state.stage === "live") return node !== undefined;
  const reason = state.stage === "ended" ? state.completion.endReason : state.endReason;
  return (
    (reason === "participant_stopped" ||
      reason === "timebox_reached" ||
      (reason === "agent_requested_end" && (node !== undefined || gracefulCompletion !== null))) &&
    (state.stage === "ended" || state.admittedResponseId === responseId)
  );
}

function hasLiveProviderObservationTime({
  lastProviderObservationAt,
  applicationTranscriptProof,
}: AggregateFields): boolean {
  return (
    lastProviderObservationAt === undefined ||
    lastProviderObservationAt >= applicationTranscriptProof.liveAt
  );
}

/** A persisted digest has its dispatched effect; finalizing still owes the current one. */
function hasConsistentTranscriptDigest({
  state,
  transcriptRevision,
  transcriptDigest: digest,
}: AggregateFields): boolean {
  if (state.stage === "ended") return true;
  const currentDigestEffects = state.effects.filter(
    (effect) =>
      effect.kind === "compute_transcript_digest" && effect.revision === transcriptRevision,
  );
  if (digest !== null) return currentDigestEffects.some(({ status }) => status === "dispatched");
  return (
    state.stage !== "finalizing" ||
    currentDigestEffects.some(({ status }) => status === "pending" || status === "sending")
  );
}

/** Graceful completion exists exactly when the accepted end selected an agent's output. */
function hasConsistentGracefulCompletion({
  gracefulCompletion: graceful,
  providerResponses,
  conversationNodeExecution: node,
  state,
}: AggregateFields): boolean {
  // Live holds a completion only for Original's retained output, or for a node that completed
  // and waits for its last reply to play before Ending.
  if (state.stage === "live")
    return (
      graceful === null ||
      node?.kind === "retained_output" ||
      (node?.kind === "finishing" && node.endingAt !== undefined)
    );
  if (state.stage === "ended") {
    const agentEnded = state.completion.endReason === "agent_requested_end";
    if (node === undefined) return agentEnded ? graceful !== null : graceful === null;
    if (node.kind === "ordinary" && node.dispatch?.status === "complete")
      return graceful === null || agentEnded;
    if (node.kind === "ordinary") return agentEnded ? graceful !== null : graceful === null;
    if (node.kind === "retained_output") return graceful !== null;
    return node.dispatch.status === "complete"
      ? graceful !== null
      : nodeLimitation(node) !== undefined && graceful === null;
  }
  return (
    graceful === null ||
    (state.admittedResponseId === graceful.responseId &&
      providerResponses.some(({ responseId }) => responseId === graceful.responseId))
  );
}

/**
 * One input closure serves the final-input obligation, settled before the result freezes. An
 * answer Runtime held at closure is never awaited as a new item.
 */
function hasConsistentFinalInput({
  finalInput,
  conversationNodeExecution,
  state,
}: AggregateFields): boolean {
  const closures = state.effects.filter(
    (effect): effect is Extract<typeof effect, { kind: "close_input" }> =>
      effect.kind === "close_input",
  );
  if (state.stage === "live" && finalInput === null) return true;
  if (finalInput === null) return false;
  const closure = closures[0];
  if (closures.length !== 1 || closure?.id !== finalInput.effectId) return false;
  if (state.stage === "live") return conversationNodeExecution !== undefined;
  // A held answer is awaited, unless the execution settles a later one in its place.
  if (
    closure.heldItemId !== null &&
    finalInput.obligation === "awaiting_item" &&
    !finalInput.inputToSettle
  )
    return false;
  const warnings = state.stage === "ended" ? state.completion.warnings : state.warnings;
  if (finalInput.warning !== null && !warnings.includes(finalInput.warning)) return false;
  if (state.stage === "ended" || state.stage === "finalizing")
    return finalInput.obligation === "settled";
  return (
    finalInput.obligation !== "awaiting_transcription" ||
    state.activeInputItemId === finalInput.admittedItemId
  );
}

/** The frozen completion names this Run and its persisted Transcript revision, digest and turns. */
function hasConsistentFrozenResult({
  runId,
  state,
  transcriptCapture,
  transcriptRevision,
  transcriptDigest: digest,
}: AggregateFields): boolean {
  if (state.stage !== "ended") return true;
  const snapshot = state.completion.transcriptSnapshot;
  return (
    state.completion.runId === runId &&
    snapshot.revision === transcriptRevision &&
    snapshot.digest === digest &&
    snapshot.turnCount === getSerializedTranscriptTurns(transcriptCapture).length
  );
}

/** Captured obligations have text, and a sealed result matches its proof and completion. */
function hasValidApplicationTranscriptProof(value: AggregateFields): boolean {
  const { applicationTranscriptProof: proof, transcriptCapture, state } = value;
  const captured = new Map(transcriptCapture.items.map((item) => [item.itemId, item]));
  if (
    proof.obligations.some((obligation) => {
      const item = captured.get(obligation.itemId);
      return (
        obligation.status === "captured" &&
        (item?.text === undefined || item.role !== obligation.role)
      );
    })
  )
    return false;
  const completedReason = proof.interrupted ? undefined : proof.completedReason;
  // A Live Run has accepted no completion and sealed no result.
  if (state.stage === "live")
    return !proof.interrupted && completedReason === undefined && proof.result === null;
  const endReason = state.stage === "ended" ? state.completion.endReason : state.endReason;
  if (completedReason !== undefined && endReason !== completedReason) return false;
  if (
    proof.interrupted &&
    endReason !== "runtime_failed" &&
    endReason !== "participant_disconnected" &&
    value.conversationNodeExecution === undefined
  )
    return false;
  if (state.stage !== "ended" || (!proof.interrupted && completedReason === undefined))
    return proof.result === null;
  if (
    transcriptCapture.items.some(
      (item) =>
        item.text !== undefined &&
        item.role !== undefined &&
        !proof.obligations.some(
          (obligation) => obligation.itemId === item.itemId && obligation.status === "captured",
        ),
    )
  )
    return false;
  const result = proof.result;
  if (result === null) return false;
  const incompleteReasons = expectedTranscriptIncompleteReasons(value);
  const completion = state.completion;
  return (
    (proof.interrupted
      ? result.outcome === "interrupted"
      : result.outcome === "completed" && result.reason === completedReason) &&
    result.runId === value.runId &&
    result.liveAt === proof.liveAt &&
    result.endedAt === completion.endedAt &&
    result.transcriptSnapshot.revision === completion.transcriptSnapshot.revision &&
    result.transcriptSnapshot.digest === completion.transcriptSnapshot.digest &&
    result.transcriptSnapshot.turnCount === completion.transcriptSnapshot.turnCount &&
    result.transcriptCompleteness ===
      (incompleteReasons.length === 0 ? "complete" : "incomplete") &&
    result.transcriptIncompleteReasons !== undefined &&
    JSON.stringify(result.transcriptIncompleteReasons) === JSON.stringify(incompleteReasons)
  );
}

/** The incomplete reasons a sealed proof implies, in their sealed order. */
function expectedTranscriptIncompleteReasons({
  applicationTranscriptProof: proof,
  finalInput,
  state,
  conversationNodeExecution: node,
  conversationVisit: visit,
  gracefulCompletion: graceful,
  providerResponses,
}: AggregateFields): readonly TranscriptIncompleteReason[] {
  const inputBufferProved =
    finalInput === null ||
    !finalInput.inputToSettle ||
    finalInput.admittedItemId !== null ||
    state.effects.some(
      (effect) =>
        effect.id === finalInput.effectId &&
        effect.kind === "close_input" &&
        effect.acceptance === "benign_rejection",
    );
  const responseProved =
    proof.interrupted ||
    proof.completedReason !== "agent_requested_end" ||
    (node?.kind === "ordinary" && node.dispatch?.status === "complete" && graceful === null) ||
    nodeLimitation(node) !== undefined ||
    (graceful !== null && proof.inventoriedResponseIds?.includes(graceful.responseId) === true);
  const nodeInventoryGap =
    nodeLimitation(node) !== undefined &&
    !hasCompleteNodeTranscriptInventory(visit, providerResponses, proof.inventoriedResponseIds);
  const reasons: TranscriptIncompleteReason[] = [];
  if (proof.evidenceGap === true || nodeInventoryGap)
    reasons.push({ kind: "conversation_evidence_gap" });
  for (const item of proof.obligations) {
    if (item.status === "pending")
      reasons.push({
        kind: "eligible_transcript_item_pending",
        itemId: item.itemId,
        role: item.role,
      });
    if (item.status === "failed")
      reasons.push({
        kind: "eligible_transcript_item_failed",
        itemId: item.itemId,
        role: item.role,
      });
  }
  if (!inputBufferProved) reasons.push({ kind: "final_input_unresolved" });
  if (!responseProved && graceful !== null)
    reasons.push({
      kind: "closing_response_inventory_unresolved",
      responseId: graceful.responseId,
    });
  return reasons;
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isPersistedJsonValue<Value>(value: Value): value is Value & PersistedJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPersistedJsonValue);
  if (typeof value !== "object") return false;
  return (
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    // Zod strict objects accept an own `__proto__` key, which JSON.parse can produce; stored
    // JSON never names an Object.prototype member.
    Object.keys(value).every((key) => !(key in Object.prototype)) &&
    Object.values(value).every(isPersistedJsonValue)
  );
}

function isRecord<Value>(value: Value): value is Value & PersistedJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
