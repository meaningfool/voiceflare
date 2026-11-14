import type { z } from "zod";

import type {
  ConversationNodeDispatchRecord,
  ConversationNodeExecution,
  FinishingConversationNode,
} from "./conversationNode.ts";
import type { ConversationToolInvocation } from "./implementationContracts.ts";
import type {
  finalInputStateSchema,
  finalizationEffectRecordSchema,
  gracefulCompletionStateSchema,
  interviewFinalizationAggregateSchema,
  interviewFinalizationStateSchema,
  applicationTranscriptProofSchema,
  providerObservationOrderSchema,
  providerResponseLifecycleSchema,
  runtimeFinalizationCompletionSchema,
  runtimePublicationStateSchema,
  serializedTranscriptCaptureSchema,
} from "./interviewFinalizationPersistenceDecoder.ts";
import type { TranscriptIncompleteReason } from "../shared/contracts/runtimeTerminalResult.ts";
import {
  type RuntimeEndReason,
  type ResultWarning,
  type RuntimeTranscriptTurn,
} from "../shared/runtimeControllerCallback.ts";
import {
  resultDeliveryGraceMs,
  runtimeFinalizationAllowanceMs,
} from "../shared/contracts/interviewLifecyclePolicy.ts";
import type { ConversationUsageEvidence, RuntimeUsageAccountingState } from "./runtimeUsage.ts";

export type { RuntimeEndReason } from "../shared/runtimeControllerCallback.ts";

// Persisted types are the z.output of the schemas at the storage trust boundary
// (interviewFinalizationPersistenceDecoder.ts). This module keeps behavior and constants.

export type InterviewFinalizationAggregate = z.output<typeof interviewFinalizationAggregateSchema>;
export type InterviewFinalizationState = z.output<typeof interviewFinalizationStateSchema>;
export type InterviewFinalizationStage = InterviewFinalizationState["stage"];
export type FinalizationLiveState = Extract<InterviewFinalizationState, { stage: "live" }>;
export type FinalizationDrainingState = Extract<InterviewFinalizationState, { stage: "draining" }>;
export type FinalizationClosingProviderState = Extract<
  InterviewFinalizationState,
  { stage: "closing_provider" }
>;
export type FinalizationFinalizingState = Extract<
  InterviewFinalizationState,
  { stage: "finalizing" }
>;
export type FinalizationEndedState = Extract<InterviewFinalizationState, { stage: "ended" }>;
export type FinalizationStrategy = FinalizationFinalizingState["strategy"];
export type RuntimeFinalizationCompletion = z.output<typeof runtimeFinalizationCompletionSchema>;
export type RuntimePublicationState = z.output<typeof runtimePublicationStateSchema>;
export type SerializedTranscriptCapture = z.output<typeof serializedTranscriptCaptureSchema>;
export type SerializedTranscriptItem = SerializedTranscriptCapture["items"][number];
export type FinalizationEffectRecord = z.output<typeof finalizationEffectRecordSchema>;
export type FinalizationEffectStatus = FinalizationEffectRecord["status"];
export type FinalizationEffectAcceptance = FinalizationEffectRecord["acceptance"];
export type FinalInputState = z.output<typeof finalInputStateSchema>;
export type PersistedProviderOrder = z.output<typeof providerObservationOrderSchema>;
export type ProviderResponseLifecycle = z.output<typeof providerResponseLifecycleSchema>;
export type ProviderResponseTerminalStatus = Exclude<
  ProviderResponseLifecycle["status"],
  "unobserved" | "active"
>;
export type GracefulCompletionState = z.output<typeof gracefulCompletionStateSchema>;
export type ApplicationTranscriptProof = z.output<typeof applicationTranscriptProofSchema>;
export type TranscriptObligation = ApplicationTranscriptProof["obligations"][number];

export type RuntimeTranscriptIncompleteReason = TranscriptIncompleteReason;

export const interviewFinalizationPeriodMs = runtimeFinalizationAllowanceMs;
export const interviewResultPublicationPeriodMs = resultDeliveryGraceMs;
/** Early-settlement and containment checkpoint after Ending entry; never a result deadline. */
export const drainCheckpointPeriodMs = 9_000;
/**
 * A normal end announces itself only once the last reply has had time to play: its delivery,
 * its remaining playing time and this margin, which covers what Runtime cannot see: the network,
 * the browser's buffer and the speaker. Pipecat's default; the user chose it on 2026-11-04 (#1018).
 */
export const playbackMarginMs = 2_000;

/**
 * When a normal end may announce itself after the reply that completed it: once that reply's
 * audio has played, by the execution's account or else at its completion, plus the margin.
 */
export function playbackEndingAt(
  aggregate: Pick<InterviewFinalizationAggregate, "providerResponses">,
  responseId: string,
  completedAt: number,
): number {
  const playbackEndsAt = aggregate.providerResponses.find(
    (response) => response.responseId === responseId,
  )?.playbackEndsAt;
  return Math.max(completedAt, playbackEndsAt ?? completedAt) + playbackMarginMs;
}

/** The derived nine-second checkpoint of an open Ending. */
export function drainCheckpointAt(ending: Readonly<{ endingStartedAt: number }>): number {
  return ending.endingStartedAt + drainCheckpointPeriodMs;
}

/**
 * Ending's five steps, named by what each achieves, and Runtime's own work. Each execution
 * translates the steps into its own work:
 * - `cancel_reply`: cancel the named reply. A reply that already finished answers "nothing to
 *   cancel" (`nothing_to_cancel`);
 * - `stop_output`: drop audio still waiting and start no new reply;
 * - `close_input`: close participant input and settle the last answer. It answers "settled",
 *   when the answer's item and text are reported, or "nothing to settle" (`nothing_to_settle`).
 *   The step carries the answer Runtime already holds, if any, which it does not settle again;
 * - `discard_later_input`: drop participant input that was not settled;
 * - `release_session`: release the execution's session.
 */
export const finalizationEffectKinds = [
  "compute_transcript_digest",
  "close_input",
  "discard_later_input",
  "cancel_reply",
  "stop_output",
  "release_session",
  "arm_alarm",
] as const;

export type FinalizationEffectKind = (typeof finalizationEffectKinds)[number];

export const finalInputWarnings = [
  "ambiguous_final_activity",
  "final_input_may_be_incomplete",
  "participant_transcription_failed",
] as const;

export type FinalInputWarning = (typeof finalInputWarnings)[number];

/** The Transcript revision a digest effect computes; other effects have none. */
export function effectRevision(effect: FinalizationEffectRecord): number | undefined {
  return effect.kind === "compute_transcript_digest" ? effect.revision : undefined;
}

/** The completion an uninterrupted proof accepted, if any. */
export function completedReasonOf(
  proof: ApplicationTranscriptProof,
): Extract<ApplicationTranscriptProof, { interrupted: false }>["completedReason"] {
  return proof.interrupted ? undefined : proof.completedReason;
}

/** The proof once the Run is interrupted: an interrupted Run has no completed reason. */
export function interruptedProof(proof: ApplicationTranscriptProof): ApplicationTranscriptProof {
  if (proof.interrupted) return proof;
  const { completedReason: _completedReason, ...retained } = proof;
  return { ...retained, interrupted: true };
}

/** Warnings accepted so far: none while Live, and the completion's once the result froze. */
export function stateWarnings(
  state: InterviewFinalizationState,
): FinalizationFinalizingState["warnings"] {
  if (state.stage === "live") return [];
  return state.stage === "ended" ? state.completion.warnings : state.warnings;
}

/** The input item admitted at closure, derived from the one persisted final-input obligation. */
export function admittedFinalInputItemId(
  aggregate: Pick<InterviewFinalizationAggregate, "finalInput">,
): string | null {
  return aggregate.finalInput?.admittedItemId ?? null;
}

export type ProviderObservationOrder = Readonly<{
  toolInvocations?: readonly ConversationToolInvocation[];
  providerEventId?: string;
  generation: number;
  sequence: number;
  /** Runtime receipt time of a native observation. */
  observedAt?: number;
  /** The usage the execution reports with this observation. */
  usage?: readonly ConversationUsageEvidence[];
}>;

export type OrderedProviderFinalizationObservation = ProviderObservationOrder &
  (
    | { kind: "session_activity_observed"; at: number }
    | {
        kind: "transcript_item_observed";
        nonTranscript?: boolean;
        itemId: string;
        previousItemId?: string;
        role?: "participant" | "conversationAgent";
        responseId?: string;
        outputIndex?: number;
        contentIndex?: number;
      }
    | { kind: "participant_answer_created"; itemId: string }
    | {
        kind: "participant_answer_transcribed";
        itemId: string;
        contentIndex?: number;
        text?: string;
      }
    | { kind: "participant_answer_transcription_failed"; itemId: string; code?: string }
    | {
        kind: "agent_transcript_finalized";
        itemId: string;
        responseId?: string;
        text?: string;
      }
    | { kind: "reply_started"; responseId: string }
    | {
        kind: "reply_generated";
        responseId: string;
        status?: Exclude<ProviderResponseTerminalStatus, "cancelled">;
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
      }
    | {
        kind: "reply_cancelled";
        responseId: string;
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
      }
    | { kind: "reply_delivery_started"; responseId?: string }
    | {
        kind: "reply_delivery_stopped";
        responseId?: string;
        /**
         * When the reply's delivered audio finishes playing at the participant, as far as the
         * execution can tell: Cascade sends audio faster than it plays. Absent when it plays out
         * as it is delivered, as OpenAI sends Realtime audio.
         */
        playbackEndsAt?: number;
      }
    | {
        kind: "provider_finish_interview_observed";
        itemId?: string;
        responseId: string;
        callId: string;
        responseStatus?: ProviderResponseTerminalStatus;
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
        at: number;
      }
    | {
        kind: "provider_finish_interview_rejected";
        itemId?: string;
        callId?: string;
        responseId?: string;
        missingIdentities: readonly ("callId" | "responseId")[];
        responseStatus?: ProviderResponseTerminalStatus;
        transcriptItems?: readonly ProviderTranscriptItemObservation[];
        transcriptInventoryComplete?: boolean;
      }
    | {
        kind: "session_error_observed";
        eventId?: string;
        code?: string;
      }
    /** Ending's `close_input` step, sent as `commandId`, found no answer to settle. */
    | { kind: "nothing_to_settle"; commandId: string }
    /** Ending's `cancel_reply` step, sent as `commandId`, found its reply already finished. */
    | { kind: "nothing_to_cancel"; commandId: string }
    /** The execution's session closed: its own report, which bounds the reports before it. */
    | { kind: "session_closed_observed"; at: number }
  );

export type ProviderFinalizationObservation = OrderedProviderFinalizationObservation;

export type ProviderTranscriptItemObservation = Readonly<{
  nonTranscript?: boolean;
  text?: string;
  itemId: string;
  previousItemId?: string;
  role?: "participant" | "conversationAgent";
  responseId?: string;
  outputIndex?: number;
}>;

export type FinalizationDeadline =
  | "timebox"
  | "presence_grace"
  | "browser_media_ready"
  | "finalization_cutoff"
  /** The nine-second Ending checkpoint. */
  | "drain"
  /** Retained-output cleanup during Live. */
  | "provider_close";

export type FinalizationEffectOutcome = Readonly<{
  status: "dispatched" | "failed" | "uncertain" | "benign_rejection";
  acceptance?: FinalizationEffectAcceptance;
  /** `session_closed` when the release answered closed; otherwise the execution's own code. */
  code?: string;
  /** A failed or uncertain release that ran out of time. */
  timedOut?: true;
  /** How the execution carries out a `close_input` step's settlement. */
  settlement?: InputClosureSettlement;
}>;

/**
 * How an execution carries out the `close_input` step, which it tells Runtime with the step's
 * outcome:
 * - `supersedesHeld`: the answer Runtime held is not the last one; the step settles a later one;
 * - `answerFollows`: the execution answers the step with a report, settled or nothing to settle,
 *   so Runtime does not settle it at quiet;
 * - `inputToSettle`: the participant gave input that the step settles.
 */
export type InputClosureSettlement = Readonly<{
  supersedesHeld: boolean;
  answerFollows: boolean;
  inputToSettle: boolean;
}>;

export type ConversationSemanticEvidence = Readonly<{
  kind: "conversation_evidence_observed";
  diagnostics?: readonly import("./diagnosticContracts.ts").DiagnosticDescription[];
  /** Each provider tool call this receipt carried and what Runtime did with it. */
  toolCalls?: readonly import("./toolCallRecord.ts").RuntimeToolCallDescription[];
  snapshot: InterviewFinalizationAggregate;
  usageEvidence: readonly ConversationUsageEvidence[];
  effects: readonly FinalizationEffectRecord[];
  at: number;
  notification: "none" | "completion" | "unable_to_continue";
}>;

export type FinalizationObservation =
  | ConversationSemanticEvidence
  | Readonly<{ kind: "evidence_prefix_processed"; at: number }>
  | Readonly<{
      kind: "end_requested";
      reason: RuntimeEndReason;
      source: string;
      at: number;
    }>
  | Readonly<{ kind: "runtime_failure_observed"; source: string; at: number }>
  /** The execution attached a warning to the Run's result. */
  | Readonly<{
      kind: "execution_warning_attached";
      warning: ResultWarning;
      at: number;
    }>
  | ProviderFinalizationObservation
  | Readonly<{
      kind: "effect_outcome";
      effectId: string;
      outcome: FinalizationEffectOutcome;
      providerCloseBarrier?: ProviderObservationOrder;
      at?: number;
    }>
  | Readonly<{ kind: "interrupted_effects_recovered" }>
  | Readonly<{ kind: "transcript_digest_computed"; revision: number; digest: string; at?: number }>
  | Readonly<{ kind: "deadline_reached"; deadline: FinalizationDeadline; at: number }>;

/** Native agent-finish evidence. Only the selected Conversation interprets it. */
export type AgentFinishReceipt = Extract<
  ProviderFinalizationObservation,
  {
    kind: "provider_finish_interview_observed" | "provider_finish_interview_rejected";
  }
>;

/** What finalization advances on: agent finish arrives only as Conversation evidence. */
export type FinalizationInput = Exclude<FinalizationObservation, AgentFinishReceipt>;

/**
 * What an execution reports to Runtime: its native receipts. An agent finish is never one;
 * Runtime's own `interpretConversationTools` derives it from a receipt's tool invocations.
 */
export type ExecutionObservation = Exclude<ProviderFinalizationObservation, AgentFinishReceipt>;

export type RuntimePublicEventPayloads = Readonly<{
  "runtime.ending": Readonly<{
    endReason: RuntimeEndReason;
    source: string;
    strategy: FinalizationStrategy;
    finalizationCutoffAt: number;
    /** Derived nine-second early-settlement and containment checkpoint. */
    drainDeadline: number;
  }>;
  "runtime.agent_completed_interview": Readonly<{
    responseId: string;
    callId: string;
  }>;
  "runtime.controller_completed": Readonly<{
    completion: RuntimeFinalizationCompletion;
  }>;
}>;

export type RuntimePublicEventType = keyof RuntimePublicEventPayloads;

export type RuntimePublicEventOfType<Type extends RuntimePublicEventType> = Readonly<{
  id: string;
  type: Type;
  payload: RuntimePublicEventPayloads[Type];
}>;

export type RuntimePublicEvent = Readonly<{
  id: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type FinalizationDecision = Readonly<{
  aggregate: InterviewFinalizationAggregate;
  effects: readonly FinalizationEffectRecord[];
  events: readonly RuntimePublicEvent[];
}>;

/**
 * The aggregate a Run enters Live with. Its Transcript proof starts at `liveAt` and owes every
 * captured or still pending role-attributed item already in the capture.
 */

export function createLiveInterviewFinalizationAggregate({
  runId,
  liveAt,
  runtimeUsage,
  transcriptCapture = { sequence: 0, items: [] },
}: Readonly<{
  runId: string;
  liveAt: number;
  runtimeUsage: RuntimeUsageAccountingState;
  transcriptCapture?: SerializedTranscriptCapture;
}>): InterviewFinalizationAggregate {
  return {
    runId,
    runtimeUsage,
    applicationTranscriptProof: {
      liveAt,
      interrupted: false,
      obligations: transcriptCapture.items.flatMap((item) =>
        item.role === undefined
          ? []
          : [
              {
                itemId: item.itemId,
                role: item.role,
                status: item.text === undefined ? ("pending" as const) : ("captured" as const),
              },
            ],
      ),
      closeBarrier: null,
      result: null,
    },
    state: {
      stage: "live",
      activeInputItemId: null,
      activeResponseId: null,
      outputAudioActive: false,
      sessionClosed: false,
      effects: [],
    },
    transcriptCapture,
    transcriptRevision: 0,
    transcriptDigest: null,
    nextProviderSequence: 1,
    nextEffectSequence: 1,
    nextEventSequence: 1,
    providerGeneration: 0,
    acceptedProviderOrder: null,
    providerResponses: [],
    unidentifiedOutputAudioActive: false,
    gracefulCompletion: null,
    finalInput: null,
  };
}

/**
 * The one rule for the deadline that governs a Conversation node. Once a finishing reservation
 * exists, its reserved closing cutoff governs; `closingCutoffAt` is recorded exactly with that
 * reservation, until the node completed and waits for its last reply to play: that wait's end,
 * `endingAt`, then governs, and the reply's own cutoff no longer does. Otherwise the earliest
 * declared timer governs. No timer means no business cutoff; operational acquisition and presence
 * bounds remain separate.
 */
export function conversationNodeDeadline(
  node: Readonly<{
    timers: readonly Readonly<{ deadlineAt: number }>[];
    closingCutoffAt?: number | undefined;
    endingAt?: number | undefined;
  }>,
): number | null {
  if (node.endingAt !== undefined) return node.endingAt;
  if (node.closingCutoffAt !== undefined) return node.closingCutoffAt;
  return node.timers.length === 0
    ? null
    : Math.min(...node.timers.map(({ deadlineAt }) => deadlineAt));
}

/**
 * The interviewer reply in progress while Live: the response still generating, or else the one
 * response whose audio is still playing. Stop and a deadline's closing keep its text.
 */
export function speakingResponseId(
  aggregate: Pick<InterviewFinalizationAggregate, "providerResponses">,
  live: Pick<FinalizationLiveState, "activeResponseId">,
): string | undefined {
  if (live.activeResponseId !== null) return live.activeResponseId;
  const playing = aggregate.providerResponses.filter(
    (response) => response.outputAudio === "active",
  );
  return playing.length === 1 ? playing[0]?.responseId : undefined;
}

/** A finishing node, including Original's retained output, holds a reservation. */
export function isFinishingNode(
  node: ConversationNodeExecution | undefined,
): node is FinishingConversationNode {
  return node !== undefined && node.kind !== "ordinary";
}

/** The limitation a failed or uncertain dispatch retained, if any. */
export function nodeLimitation(node: ConversationNodeExecution | undefined): string | undefined {
  const dispatch = node?.dispatch;
  return dispatch?.status === "failed" || dispatch?.status === "uncertain"
    ? dispatch.limitation
    : undefined;
}

/** Moves a dispatch to a new status; only a failed or uncertain dispatch retains a limitation. */
export function updateNodeDispatch(
  dispatch: ConversationNodeDispatchRecord,
  update:
    | Readonly<{ status: "pending" | "claimed" | "dispatched" | "complete" }>
    | Readonly<{ status: "failed" | "uncertain"; limitation?: string | undefined }>,
): ConversationNodeDispatchRecord {
  let retained: Pick<
    ConversationNodeDispatchRecord,
    "input" | "triggeringResponseId" | "toolCallId"
  > = { input: dispatch.input };
  if (dispatch.triggeringResponseId !== undefined)
    retained = { ...retained, triggeringResponseId: dispatch.triggeringResponseId };
  if (dispatch.toolCallId !== undefined)
    retained = { ...retained, toolCallId: dispatch.toolCallId };
  if (update.status !== "failed" && update.status !== "uncertain")
    return { ...retained, status: update.status };
  const failed = { ...retained, status: update.status };
  return "limitation" in update && update.limitation !== undefined
    ? { ...failed, limitation: update.limitation }
    : failed;
}

export function readFinalizationTranscriptTurns(
  aggregate: InterviewFinalizationAggregate,
): readonly RuntimeTranscriptTurn[] {
  return getSerializedTranscriptTurns(aggregate.transcriptCapture);
}

export function completionFromAggregate(
  aggregate: InterviewFinalizationAggregate,
): RuntimeFinalizationCompletion | undefined {
  return aggregate.state.stage === "ended" ? aggregate.state.completion : undefined;
}

export function getSerializedTranscriptTurns(
  capture: SerializedTranscriptCapture,
): readonly Readonly<{ role: "participant" | "conversationAgent"; text: string }>[] {
  const itemsById = new Map(capture.items.map((item) => [item.itemId, item]));
  return [...capture.items]
    .sort((left, right) => compareTranscriptItems(itemsById, left, right))
    .flatMap((item) =>
      item.role === undefined || item.text === undefined
        ? []
        : [{ role: item.role, text: item.text }],
    );
}

function compareTranscriptItems(
  itemsById: ReadonlyMap<string, SerializedTranscriptItem>,
  left: SerializedTranscriptItem,
  right: SerializedTranscriptItem,
): number {
  if (isAfterProviderItem(itemsById, left.itemId, right.itemId)) return 1;
  if (isAfterProviderItem(itemsById, right.itemId, left.itemId)) return -1;
  if (left.responseId !== undefined && left.responseId === right.responseId) {
    return (
      compareOptionalNumber(left.outputIndex, right.outputIndex) ||
      compareOptionalNumber(left.contentIndex, right.contentIndex)
    );
  }
  return providerItemSequence(left) - providerItemSequence(right);
}

function isAfterProviderItem(
  itemsById: ReadonlyMap<string, SerializedTranscriptItem>,
  itemId: string,
  possiblePreviousItemId: string,
): boolean {
  const seen = new Set<string>();
  let cursor = itemsById.get(itemId)?.previousItemId;
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === possiblePreviousItemId) return true;
    seen.add(cursor);
    cursor = itemsById.get(cursor)?.previousItemId;
  }
  return false;
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function providerItemSequence(item: SerializedTranscriptItem): number {
  return Math.min(item.firstSeenSequence, item.finalSequence ?? Number.POSITIVE_INFINITY);
}

/** In-memory FIFO progress, sampled by the host in the synchronous evidence commit. */
export type ConversationReceiptPrefix = Readonly<{
  receivedOrder: ProviderObservationOrder | null;
  processedThroughOrder: ProviderObservationOrder | null;
}>;
export type FinalizationAdvanceFacts = Readonly<{
  receiptPrefix?: ConversationReceiptPrefix | undefined;
  usageEvidenceSupplied?: boolean;
  /** Retain native order and usage, without admitting new participant work. */
  excludedParticipantInput?: boolean;
}>;

/** An owned value that Runtime stores as JSON; an `undefined` property is not stored. */
export type JsonDocument =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonDocument[]
  | Readonly<{ [key: string]: JsonDocument }>;

/**
 * Whether two owned JSON values serialize to the same document, ignoring object key order.
 * Change detection compares in place: it stops at the first difference and at shared
 * references, and it never serializes either value. As in `JSON.stringify`, an `undefined`
 * property is absent and an `undefined` array element is `null`.
 */
export function isSameJson(left: JsonDocument, right: JsonDocument): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (isList(left) || isList(right))
    return (
      isList(left) &&
      isList(right) &&
      left.length === right.length &&
      left.every((value, index) => isSameJson(value ?? null, right[index] ?? null))
    );
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
  const rightValues = new Map(Object.entries(right).filter(([, value]) => value !== undefined));
  return (
    leftEntries.length === rightValues.size &&
    leftEntries.every(
      ([key, value]) => rightValues.has(key) && isSameJson(value, rightValues.get(key)),
    )
  );
}

function isList(value: JsonDocument): value is readonly JsonDocument[] {
  return Array.isArray(value);
}
