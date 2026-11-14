import { z } from "zod";

import { InterviewFinalizationRepository } from "../interviewFinalizationRepository.ts";
import type { RuntimeControllerRow } from "../interviewFinalizationRepository.ts";
import { projectInterviewFinalizationPublicState } from "../interviewFinalizationPublicProjection.ts";
import type { InterviewFinalizationPublicState } from "../interviewFinalizationPublicProjection.ts";
import {
  completedReasonOf,
  drainCheckpointAt,
  getSerializedTranscriptTurns,
  isFinishingNode,
  nodeLimitation,
  type FinalInputState,
  type FinalizationEffectRecord,
  type GracefulCompletionState,
  type InterviewFinalizationAggregate,
  type InterviewFinalizationState,
  type ApplicationTranscriptProof,
  type ProviderObservationOrder,
  type ProviderResponseLifecycle,
  type RuntimePublicationState,
  type SerializedTranscriptCapture,
  type SerializedTranscriptItem,
} from "../interviewFinalizationModel.ts";
import type {
  ConversationNodeDispatchRecord,
  ConversationNodeExecution,
  FinishingConversationNode,
} from "../conversationNode.ts";
import type { ConversationVisit } from "../executionContracts.ts";
import type { RuntimeUsageAccountingState } from "../runtimeUsage.ts";
import {
  createDurableObjectState,
  type TestInterviewRuntimeDurableObjectContext,
} from "./interviewRuntimeControllerTestHarness.ts";

const runJson = z.json();
type RunJson = z.output<typeof runJson>;

/**
 * Read-only Run facts for Runtime controller regression suites.
 *
 * Suites assert observable Run facts through this view instead of the persisted
 * finalization aggregate or the controller row. Only this module, and the tests
 * that `scripts/check-runtime-controller-test-boundary.ts` allowlists as
 * persistence-encoding tests, read that encoding directly, so a reshaped
 * persisted model changes the mapping here rather than the assertions.
 */
export type RunViewSource =
  | InterviewFinalizationRepository
  | Readonly<{ ctx: TestInterviewRuntimeDurableObjectContext }>;

export type RunOrderView = Readonly<{
  generation: number;
  sequence: number;
  providerEventId: string | undefined;
  observedAt: number | undefined;
  toolInvocations: ProviderObservationOrder["toolInvocations"];
}>;

type RunLiveSignalsView = Readonly<{
  activeInputItemId: string | null;
  activeResponseId: string | null;
  outputAudioActive: boolean;
  sessionClosed: boolean;
  providerCloseBarrier: RunOrderView | undefined;
}>;

type RunEndingView = Readonly<{
  endReason: Exclude<InterviewFinalizationState, { stage: "live" | "ended" }>["endReason"];
  source: string;
  strategy: Exclude<InterviewFinalizationState, { stage: "live" | "ended" }>["strategy"];
  endingStartedAt: number;
  finalizationCutoffAt: number;
  admittedResponseId: string | null;
  warnings: readonly string[];
}>;

/** The Run lifecycle stage and the facts that stage carries. */
export type RunLifecycleView =
  | (Readonly<{ stage: "live" }> & RunLiveSignalsView)
  | (Readonly<{ stage: "draining"; drainDeadline: number }> & RunEndingView & RunLiveSignalsView)
  | (Readonly<{
      stage: "closing_provider";
      drainDeadline: number;
    }> &
      RunEndingView &
      RunLiveSignalsView)
  | (Readonly<{
      stage: "finalizing";
      activeInputItemId: string | null;
      activeResponseId: string | null;
      sessionClosed: boolean;
    }> &
      RunEndingView)
  | Readonly<{
      stage: "ended";
      completion: Extract<InterviewFinalizationState, { stage: "ended" }>["completion"];
      frozenTranscript: RunTranscriptCaptureView;
      warnings: readonly string[];
    }>;

export type RunEffectView = Readonly<{
  id: string;
  kind: FinalizationEffectRecord["kind"];
  status: FinalizationEffectRecord["status"];
  acceptance: FinalizationEffectRecord["acceptance"];
  attemptCount: number;
  responseId: string | undefined;
  revision: number | undefined;
}>;

export type RunVisitView = Readonly<{
  state: string;
  visitId: string;
  operationId: string;
  revision: number | undefined;
  context: ConversationVisit["context"];
}>;

/** Dispatch identity is the current `visit`; a node view does not repeat it. */
export type RunNodeExecutionView = Readonly<{
  mediaCutoffAt: number | null;
  closingCutoffAt: number | undefined;
  /** A completed node waits until then for its last reply to play before Ending. */
  endingAt: number | undefined;
  timers: readonly Readonly<{
    id: string;
    deadlineAt: number;
    event: ConversationNodeExecution["timers"][number]["event"];
  }>[];
  associatedTimerId: string | undefined;
  retainedOutput: boolean | undefined;
  cleanupAt: number | undefined;
  cleanupClaimed: boolean | undefined;
  cleanupEffectId: string | undefined;
  reservation:
    | Readonly<{
        reason: FinishingConversationNode["reservation"]["reason"];
        source: FinishingConversationNode["reservation"]["source"];
        at: number;
        triggeringResponseId: string | undefined;
        toolCallId: string | undefined;
      }>
    | undefined;
  dispatch:
    | Readonly<{
        input: ConversationNodeDispatchRecord["input"];
        triggeringResponseId: string | undefined;
        toolCallId: string | undefined;
        status: ConversationNodeDispatchRecord["status"];
      }>
    | undefined;
  limitation: string | undefined;
  participantEnd: Readonly<{ at: number; source: string }> | undefined;
}>;

/** The Conversation Agent's own completion request and its settlement. */
export type RunAgentCompletionView = Readonly<{
  callId: string | null;
  responseId: string;
  itemId: string | null;
  responseSettlement: GracefulCompletionState["responseSettlement"];
  outputAudioSettlement: GracefulCompletionState["outputAudioSettlement"];
  participantMediaSafetyOverride: boolean;
  executionIdentity: GracefulCompletionState["executionIdentity"];
}>;

export type RunFinalInputView = Readonly<{
  admissionCutoffAt: number;
  fence: Readonly<{ generation: number; sequence: number }>;
  effectId: string;
  obligation: FinalInputState["obligation"];
  admittedItemId: string | null;
  inputToSettle: boolean;
  answerFollows: boolean;
  settledByTerminalObservation: boolean | undefined;
  quietDeadline: number;
  duplicateCount: number;
  warning: FinalInputState["warning"];
}>;

export type RunTranscriptItemView = Readonly<{
  itemId: string;
  firstSeenSequence: number;
  previousItemId: string | undefined;
  role: SerializedTranscriptItem["role"];
  responseId: string | undefined;
  outputIndex: number | undefined;
  contentIndex: number | undefined;
  nonTranscript: boolean | undefined;
  text: string | undefined;
  finalSequence: number | undefined;
}>;

export type RunTranscriptCaptureView = Readonly<{
  sequence: number;
  items: readonly RunTranscriptItemView[];
  turns: readonly Readonly<{ role: "participant" | "conversationAgent"; text: string }>[];
}>;

export type RunTranscriptView = RunTranscriptCaptureView &
  Readonly<{ revision: number; digest: string | null }>;

export type RunTranscriptProofView = Readonly<{
  liveAt: number;
  interrupted: boolean;
  evidenceGap: boolean | undefined;
  completedReason: ReturnType<typeof completedReasonOf>;
  inventoriedResponseIds: readonly string[] | undefined;
  obligations: readonly Readonly<{
    itemId: string;
    role: ApplicationTranscriptProof["obligations"][number]["role"];
    status: ApplicationTranscriptProof["obligations"][number]["status"];
  }>[];
  closeBarrier: RunOrderView | null;
  result: ApplicationTranscriptProof["result"];
}>;

export type RunUsageView = Readonly<{
  pending: readonly Readonly<{
    componentRole: RuntimeUsageAccountingState["pending"][number]["componentRole"];
    key: string;
  }>[];
  processedKeys: readonly string[];
  observations: RuntimeUsageAccountingState["observations"];
  incomplete: boolean;
}>;

export type RunProviderResponseView = Readonly<{
  responseId: string;
  status: ProviderResponseLifecycle["status"];
  outputAudio: ProviderResponseLifecycle["outputAudio"];
  conversationScope: ProviderResponseLifecycle["conversationScope"];
  nonTranscriptInventoryComplete: true | undefined;
}>;

export type RunProviderView = Readonly<{
  generation: number;
  acceptedOrder: RunOrderView | null;
  nextSequence: number;
  responses: readonly RunProviderResponseView[];
  unidentifiedOutputAudioActive: boolean;
  lastObservationAt: number | undefined;
}>;

export type RunPublicationView = Readonly<{
  status: RuntimePublicationState["status"];
  publicationCutoffAt: number | null;
  transcriptDelivered: boolean;
  completionDelivered: boolean;
  retryAt: number | null;
  attemptCount: number;
  deliveredAt: number | null;
  lastError: string | null;
}>;

/** Controller record facts that exist before and after the live finalization state. */
export type RunRecordView = Readonly<{
  runId: string;
  phase: RuntimeControllerRow["phase"];
  deadlineAt: number | null;
  sessionId: string | null;
  sessionReplyJson: string | null;
  setupCleanupPending: boolean;
  readinessDisposition: string | null;
  readinessDeliveredAt: number | null;
  openingState: RuntimeControllerRow["opening_state"];
  callbackAttemptCount: number;
  callbackLastError: string | null;
  providerEventCount: number;
  /** The latest Transcript snapshot as published to callbacks; null before one exists. */
  transcriptSnapshot: RunJson | null;
  /** The frozen Transcript snapshot text; compared as sealed evidence. */
  frozenTranscript: string | null;
  /** The sealed completion text; compared as sealed evidence. */
  sealedCompletion: string | null;
  conversationSelection: RunJson | null;
  setupUsage: RunJson | null;
}>;

export type RunView = Readonly<{
  runId: string;
  phase: InterviewFinalizationPublicState["phase"];
  pendingClose: InterviewFinalizationPublicState["pendingClose"];
  completion: InterviewFinalizationPublicState["completion"];
  lifecycle: RunLifecycleView;
  effects: readonly RunEffectView[];
  visit: RunVisitView | null;
  nodeExecution: RunNodeExecutionView | null;
  agentCompletion: RunAgentCompletionView | null;
  finalInput: RunFinalInputView | null;
  retainedInterviewerResponseId: string | undefined;
  transcript: RunTranscriptView;
  transcriptProof: RunTranscriptProofView | null;
  usage: RunUsageView | null;
  provider: RunProviderView;
  /** The selected execution's own state, which Runtime keeps for it, as stored. */
  execution: unknown;
  publication: RunPublicationView;
  record: RunRecordView;
  /**
   * The complete persisted Run state, for assertions that it did not change at all.
   * Compare whole snapshots only; never read fields from it.
   */
  persistedState: unknown;
}>;

/** Read the current Run facts. The Run must have entered live finalization. */
export function readRunView(source: RunViewSource): RunView {
  const repository = repositoryFor(source);
  const row = repository.requireState();
  const aggregate = repository.readAggregate(row);
  const lifecycle = projectInterviewFinalizationPublicState(aggregate);
  return {
    runId: aggregate.runId,
    phase: lifecycle.phase,
    pendingClose: lifecycle.pendingClose,
    completion: lifecycle.completion,
    lifecycle: viewLifecycle(aggregate.state, aggregate.transcriptCapture),
    effects: aggregate.state.effects.map(viewEffect),
    visit:
      aggregate.conversationVisit === undefined ? null : viewVisit(aggregate.conversationVisit),
    nodeExecution:
      aggregate.conversationNodeExecution === undefined
        ? null
        : viewNodeExecution(aggregate.conversationNodeExecution),
    agentCompletion:
      aggregate.gracefulCompletion === null
        ? null
        : viewAgentCompletion(aggregate.gracefulCompletion),
    finalInput: aggregate.finalInput === null ? null : viewFinalInput(aggregate.finalInput),
    retainedInterviewerResponseId: aggregate.retainedInterviewerResponseId,
    transcript: {
      ...viewTranscriptCapture(aggregate.transcriptCapture),
      revision: aggregate.transcriptRevision,
      digest: aggregate.transcriptDigest,
    },
    transcriptProof: viewTranscriptProof(aggregate.applicationTranscriptProof),
    execution:
      row.execution_state_json === null || row.execution_state_json === undefined
        ? null
        : JSON.parse(row.execution_state_json),
    usage: viewUsage(aggregate.runtimeUsage),
    provider: viewProvider(aggregate),
    publication: viewPublication(aggregate.state),
    record: viewRecord(row),
    persistedState: aggregate,
  };
}

/** Read controller record facts, including before live finalization exists. */
export function readRunRecordView(source: RunViewSource): RunRecordView {
  return viewRecord(repositoryFor(source).requireState());
}

/** Read controller record facts, or null when no Run has been admitted. */
export function findRunRecordView(source: RunViewSource): RunRecordView | null {
  const row = repositoryFor(source).readState();
  return row === null ? null : viewRecord(row);
}

function repositoryFor(source: RunViewSource): InterviewFinalizationRepository {
  return source instanceof InterviewFinalizationRepository
    ? source
    : new InterviewFinalizationRepository(createDurableObjectState(source.ctx).storage);
}

function viewRecord(row: RuntimeControllerRow): RunRecordView {
  return {
    runId: row.run_id,
    phase: row.phase,
    deadlineAt: row.deadline_at,
    sessionId: row.session_id,
    sessionReplyJson: row.session_reply_json,
    setupCleanupPending: row.setup_cleanup_pending !== 0,
    readinessDisposition: row.readiness_disposition,
    readinessDeliveredAt: row.readiness_delivered_at,
    openingState: row.opening_state,
    callbackAttemptCount: row.callback_attempt_count,
    callbackLastError: row.callback_last_error,
    providerEventCount: row.session_event_count,
    transcriptSnapshot: parseOptionalJson(row.transcript_json),
    frozenTranscript: row.frozen_transcript_json,
    sealedCompletion: row.completion_json,
    conversationSelection: parseOptionalJson(row.conversation_selection_json ?? null),
    setupUsage: parseOptionalJson(row.runtime_usage_json),
  };
}

function parseOptionalJson(encoded: string | null): RunJson | null {
  return encoded === null ? null : runJson.parse(JSON.parse(encoded));
}

function viewLifecycle(
  state: InterviewFinalizationState,
  transcriptCapture: SerializedTranscriptCapture,
): RunLifecycleView {
  switch (state.stage) {
    case "live":
      return {
        stage: "live",
        ...viewLiveSignals(state),
      };
    case "draining":
      return {
        stage: "draining",
        drainDeadline: drainCheckpointAt(state),
        ...viewEnding(state),
        ...viewLiveSignals(state),
      };
    case "closing_provider":
      return {
        stage: "closing_provider",
        drainDeadline: drainCheckpointAt(state),
        ...viewEnding(state),
        ...viewLiveSignals(state),
      };
    case "finalizing":
      return {
        stage: "finalizing",
        activeInputItemId: state.activeInputItemId,
        activeResponseId: state.activeResponseId,
        sessionClosed: state.sessionClosed,
        ...viewEnding(state),
      };
    case "ended":
      return {
        stage: "ended",
        completion: state.completion,
        frozenTranscript: viewTranscriptCapture(transcriptCapture),
        warnings: state.completion.warnings,
      };
  }
}

function viewLiveSignals(
  state: Extract<InterviewFinalizationState, { stage: "live" | "draining" | "closing_provider" }>,
): RunLiveSignalsView {
  return {
    activeInputItemId: state.activeInputItemId,
    activeResponseId: state.activeResponseId,
    outputAudioActive: state.outputAudioActive,
    sessionClosed: state.sessionClosed,
    providerCloseBarrier:
      state.providerCloseBarrier === undefined ? undefined : viewOrder(state.providerCloseBarrier),
  };
}

function viewEnding(
  state: Exclude<InterviewFinalizationState, { stage: "live" | "ended" }>,
): RunEndingView {
  return {
    endReason: state.endReason,
    source: state.source,
    strategy: state.strategy,
    endingStartedAt: state.endingStartedAt,
    finalizationCutoffAt: state.finalizationCutoffAt,
    admittedResponseId: state.admittedResponseId,
    warnings: state.warnings,
  };
}

function viewOrder(
  order: Readonly<{
    generation: number;
    sequence: number;
    providerEventId?: string | undefined;
    observedAt?: number | undefined;
    toolInvocations?: ProviderObservationOrder["toolInvocations"] | undefined;
  }>,
): RunOrderView {
  return {
    generation: order.generation,
    sequence: order.sequence,
    providerEventId: order.providerEventId,
    observedAt: order.observedAt,
    toolInvocations: order.toolInvocations,
  };
}

function viewEffect(effect: FinalizationEffectRecord): RunEffectView {
  return {
    id: effect.id,
    kind: effect.kind,
    status: effect.status,
    acceptance: effect.acceptance,
    attemptCount: effect.attemptCount,
    responseId: effect.kind === "cancel_reply" ? effect.responseId : undefined,
    revision: effect.kind === "compute_transcript_digest" ? effect.revision : undefined,
  };
}

function viewVisit(visit: ConversationVisit): RunVisitView {
  return {
    state: visit.state,
    visitId: visit.visitId,
    operationId: visit.operationId,
    revision: visit.revision,
    context: visit.context,
  };
}

function viewNodeExecution(execution: ConversationNodeExecution): RunNodeExecutionView {
  const { dispatch } = execution;
  const finishing = isFinishingNode(execution) ? execution : undefined;
  const reservation = finishing?.reservation;
  const participantEnd = finishing?.participantEnd;
  const cleanup = execution.kind === "retained_output" ? execution.cleanup : undefined;
  return {
    mediaCutoffAt: execution.mediaCutoffAt,
    closingCutoffAt: finishing?.closingCutoffAt,
    endingAt: finishing?.endingAt,
    timers: execution.timers.map((timer) => ({
      id: timer.id,
      deadlineAt: timer.deadlineAt,
      event: timer.event,
    })),
    associatedTimerId: execution.associatedTimerId,
    retainedOutput: cleanup === undefined ? undefined : true,
    cleanupAt: cleanup?.at,
    cleanupClaimed: cleanup === undefined ? undefined : cleanup.status === "claimed",
    cleanupEffectId: cleanup?.status === "claimed" ? cleanup.effectId : undefined,
    reservation:
      reservation === undefined
        ? undefined
        : {
            reason: reservation.reason,
            source: reservation.source,
            at: reservation.at,
            triggeringResponseId: reservation.triggeringResponseId,
            toolCallId: reservation.toolCallId,
          },
    dispatch:
      dispatch === undefined
        ? undefined
        : {
            input: dispatch.input,
            triggeringResponseId: dispatch.triggeringResponseId,
            toolCallId: dispatch.toolCallId,
            status: dispatch.status,
          },
    limitation: nodeLimitation(execution),
    participantEnd:
      participantEnd === undefined
        ? undefined
        : { at: participantEnd.at, source: participantEnd.source },
  };
}

function viewAgentCompletion(completion: GracefulCompletionState): RunAgentCompletionView {
  return {
    callId: completion.callId,
    responseId: completion.responseId,
    itemId: completion.itemId,
    responseSettlement: completion.responseSettlement,
    outputAudioSettlement: completion.outputAudioSettlement,
    participantMediaSafetyOverride: completion.participantMediaSafetyOverride,
    executionIdentity: completion.executionIdentity,
  };
}

function viewFinalInput(input: FinalInputState): RunFinalInputView {
  return {
    admissionCutoffAt: input.admissionCutoffAt,
    fence: { generation: input.fence.generation, sequence: input.fence.sequence },
    effectId: input.effectId,
    obligation: input.obligation,
    admittedItemId: input.admittedItemId,
    inputToSettle: input.inputToSettle,
    answerFollows: input.answerFollows,
    settledByTerminalObservation: input.settledByTerminalObservation,
    quietDeadline: input.quietDeadline,
    duplicateCount: input.duplicateCount,
    warning: input.warning,
  };
}

function viewTranscriptCapture(capture: SerializedTranscriptCapture): RunTranscriptCaptureView {
  return {
    sequence: capture.sequence,
    items: capture.items.map((item) => ({
      itemId: item.itemId,
      firstSeenSequence: item.firstSeenSequence,
      previousItemId: item.previousItemId,
      role: item.role,
      responseId: item.responseId,
      outputIndex: item.outputIndex,
      contentIndex: item.contentIndex,
      nonTranscript: item.nonTranscript,
      text: item.text,
      finalSequence: item.finalSequence,
    })),
    turns: getSerializedTranscriptTurns(capture),
  };
}

function viewTranscriptProof(proof: ApplicationTranscriptProof): RunTranscriptProofView {
  return {
    liveAt: proof.liveAt,
    interrupted: proof.interrupted,
    evidenceGap: proof.evidenceGap,
    completedReason: completedReasonOf(proof),
    inventoriedResponseIds: proof.inventoriedResponseIds,
    obligations: proof.obligations.map((obligation) => ({
      itemId: obligation.itemId,
      role: obligation.role,
      status: obligation.status,
    })),
    closeBarrier: proof.closeBarrier === null ? null : viewOrder(proof.closeBarrier),
    result: proof.result,
  };
}

function viewUsage(usage: RuntimeUsageAccountingState): RunUsageView {
  return {
    pending: usage.pending.map((operation) => ({
      componentRole: operation.componentRole,
      key: operation.key,
    })),
    processedKeys: usage.processedKeys,
    observations: usage.observations,
    incomplete: usage.incomplete,
  };
}

function viewProvider(aggregate: InterviewFinalizationAggregate): RunProviderView {
  return {
    generation: aggregate.providerGeneration,
    acceptedOrder:
      aggregate.acceptedProviderOrder === null ? null : viewOrder(aggregate.acceptedProviderOrder),
    nextSequence: aggregate.nextProviderSequence,
    responses: aggregate.providerResponses.map((response) => ({
      responseId: response.responseId,
      status: response.status,
      outputAudio: response.outputAudio,
      conversationScope: response.conversationScope,
      nonTranscriptInventoryComplete:
        "nonTranscriptInventoryComplete" in response
          ? response.nonTranscriptInventoryComplete
          : undefined,
    })),
    unidentifiedOutputAudioActive: aggregate.unidentifiedOutputAudioActive,
    lastObservationAt: aggregate.lastProviderObservationAt,
  };
}

/** Before the result freezes there is no publication; it reads as pending and unscheduled. */
function viewPublication(state: InterviewFinalizationState): RunPublicationView {
  if (state.stage !== "ended")
    return {
      status: "pending",
      publicationCutoffAt: null,
      transcriptDelivered: false,
      completionDelivered: false,
      retryAt: null,
      attemptCount: 0,
      deliveredAt: null,
      lastError: null,
    };
  const publication: RuntimePublicationState = state.publication;
  return {
    status: publication.status,
    publicationCutoffAt: publication.publicationCutoffAt,
    transcriptDelivered: publication.transcriptDelivered,
    completionDelivered: publication.completionDelivered,
    retryAt: publication.retryAt,
    attemptCount: publication.attemptCount,
    deliveredAt: publication.deliveredAt,
    lastError: publication.lastError,
  };
}
