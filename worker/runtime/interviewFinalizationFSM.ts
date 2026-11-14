import { deferConversationFreezeForReceiptPrefix } from "./conversationEnd.ts";
import type { InputClosureSettlement } from "./interviewFinalizationModel.ts";
import {
  applyEndedEffectOutcomeObservation,
  applyEndedInterruptedEffectsRecovered,
  containEffectAtResultFreeze,
  requestConversationCleanup,
  advanceConversationClosingProviderDeadlineObservation,
  advanceConversationDrainingDeadlineObservation,
  advanceConversationEffectOutcomeObservation,
  toFinalizingState,
  endConversation,
  applyInputClosureSettlement,
} from "./conversationEnd.ts";
import {
  readConversationCompletionReference,
  observeConversation,
  projectConversationEvidence,
  hasPendingRetainedInterviewerText,
  recoverInterruptedEffects,
  isDuplicateProviderObservation,
  isMatchingSettledFinalInputObservation,
  isOrderedProviderObservation,
  isAfterProviderCloseBarrier,
  compareProviderOrder,
} from "./conversationObserve.ts";
import {
  completedReasonOf,
  interruptedProof,
  interviewFinalizationPeriodMs,
  interviewResultPublicationPeriodMs,
  getSerializedTranscriptTurns,
  isFinishingNode,
  nodeLimitation,
  playbackEndingAt,
  updateNodeDispatch,
  type FinalizationAdvanceFacts,
  type InterviewFinalizationStage,
  type FinalizationFinalizingState,
  type FinalizationEndedState,
  type FinalizationEffectRecord,
  type ProviderFinalizationObservation,
  type FinalizationInput,
  type RuntimePublicEvent,
  type RuntimeFinalizationCompletion,
  type InterviewFinalizationAggregate,
  type FinalizationDecision,
} from "./interviewFinalizationModel.ts";
import { observeConversationUsage } from "./conversationUsage.ts";
import { sealRuntimeUsage, applyRuntimeUsageEvidence } from "./runtimeUsage.ts";
import {
  type FinalizationObservationKind,
  type FinalizationAggregateAtStage,
  type FinalizationObservationOfKind,
  observationAt,
  withEffects,
  replaceFinalizationStateEffects,
  addEffect,
  addEvent,
  allocateEventId,
  withEndingWarning,
  withResultWarning,
} from "./interviewFinalizationComposition.ts";

type FinalizationTransitionCell<
  Stage extends InterviewFinalizationStage,
  Kind extends FinalizationObservationKind,
> = (
  aggregate: FinalizationAggregateAtStage<Stage>,
  observation: FinalizationObservationOfKind<Kind>,
) => FinalizationDecision;

type FinalizationStageTable<Stage extends InterviewFinalizationStage> = {
  readonly [Kind in FinalizationObservationKind]: FinalizationTransitionCell<Stage, Kind>;
};

type InterviewFinalizationRegistry = {
  readonly [Stage in InterviewFinalizationStage]: FinalizationStageTable<Stage>;
};

function keepEndedAggregateImmutable<Kind extends FinalizationObservationKind>(
  aggregate: FinalizationAggregateAtStage<"ended">,
  _observation: FinalizationObservationOfKind<Kind>,
): FinalizationDecision {
  return { aggregate, effects: [], events: [] };
}

const endedFinalizationTable = {
  conversation_evidence_observed: keepEndedAggregateImmutable,
  evidence_prefix_processed: keepEndedAggregateImmutable,
  end_requested: keepEndedAggregateImmutable,
  runtime_failure_observed: keepEndedAggregateImmutable,
  execution_warning_attached: attachExecutionWarning,
  transcript_item_observed: keepEndedAggregateImmutable,
  participant_answer_created: keepEndedAggregateImmutable,
  participant_answer_transcribed: keepEndedAggregateImmutable,
  participant_answer_transcription_failed: keepEndedAggregateImmutable,
  agent_transcript_finalized: keepEndedAggregateImmutable,
  reply_started: keepEndedAggregateImmutable,
  reply_generated: keepEndedAggregateImmutable,
  reply_cancelled: keepEndedAggregateImmutable,
  reply_delivery_started: keepEndedAggregateImmutable,
  reply_delivery_stopped: keepEndedAggregateImmutable,
  session_activity_observed: keepEndedAggregateImmutable,
  session_error_observed: keepEndedAggregateImmutable,
  nothing_to_settle: keepEndedAggregateImmutable,
  nothing_to_cancel: keepEndedAggregateImmutable,
  session_closed_observed: keepEndedAggregateImmutable,
  effect_outcome: applyEndedEffectOutcomeObservation,
  interrupted_effects_recovered: applyEndedInterruptedEffectsRecovered,
  transcript_digest_computed: keepEndedAggregateImmutable,
  deadline_reached: keepEndedAggregateImmutable,
} satisfies FinalizationStageTable<"ended">;

const liveFinalizationTable = {
  conversation_evidence_observed: applyConversationEvidence,
  evidence_prefix_processed: applyEvidencePrefixProcessed,
  end_requested: applyLiveEndRequestedObservation,
  runtime_failure_observed: applyLiveRuntimeFailureObservation,
  execution_warning_attached: attachExecutionWarning,
  transcript_item_observed: applyLiveProviderObservation,
  participant_answer_created: applyLiveProviderObservation,
  participant_answer_transcribed: applyLiveProviderObservation,
  participant_answer_transcription_failed: applyLiveProviderObservation,
  agent_transcript_finalized: applyLiveProviderObservation,
  reply_started: applyLiveProviderObservation,
  reply_generated: applyLiveProviderObservation,
  reply_cancelled: applyLiveProviderObservation,
  reply_delivery_started: applyLiveProviderObservation,
  reply_delivery_stopped: applyLiveProviderObservation,
  session_activity_observed: applyLiveProviderObservation,
  session_error_observed: applyLiveProviderObservation,
  nothing_to_settle: applyLiveProviderObservation,
  nothing_to_cancel: applyLiveProviderObservation,
  session_closed_observed: applyLiveProviderObservation,
  effect_outcome: applyLiveEffectOutcomeObservation,
  interrupted_effects_recovered: applyLiveInterruptedEffectsRecovered,
  transcript_digest_computed: applyLiveTranscriptDigestObservation,
  deadline_reached: applyLiveDeadlineObservation,
} satisfies FinalizationStageTable<"live">;

const finalizingFinalizationTable = {
  conversation_evidence_observed: applyConversationEvidence,
  evidence_prefix_processed: applyEvidencePrefixProcessed,
  end_requested: applyFinalizingEndRequestedObservation,
  runtime_failure_observed: applyFinalizingRuntimeFailureObservation,
  execution_warning_attached: attachExecutionWarning,
  transcript_item_observed: applyFinalizingProviderObservation,
  participant_answer_created: applyFinalizingProviderObservation,
  participant_answer_transcribed: applyFinalizingProviderObservation,
  participant_answer_transcription_failed: applyFinalizingProviderObservation,
  agent_transcript_finalized: applyFinalizingProviderObservation,
  reply_started: applyFinalizingProviderObservation,
  reply_generated: applyFinalizingProviderObservation,
  reply_cancelled: applyFinalizingProviderObservation,
  reply_delivery_started: applyFinalizingProviderObservation,
  reply_delivery_stopped: applyFinalizingProviderObservation,
  session_activity_observed: applyFinalizingProviderObservation,
  session_error_observed: applyFinalizingProviderObservation,
  nothing_to_settle: applyFinalizingProviderObservation,
  nothing_to_cancel: applyFinalizingProviderObservation,
  session_closed_observed: applyFinalizingProviderObservation,
  effect_outcome: applyFinalizingEffectOutcomeObservation,
  interrupted_effects_recovered: applyFinalizingInterruptedEffectsRecovered,
  transcript_digest_computed: applyFinalizingTranscriptDigestObservation,
  deadline_reached: applyFinalizingDeadlineObservation,
} satisfies FinalizationStageTable<"finalizing">;

const closingProviderFinalizationTable = {
  conversation_evidence_observed: applyConversationEvidence,
  evidence_prefix_processed: applyEvidencePrefixProcessed,
  end_requested: applyClosingProviderEndRequestedObservation,
  runtime_failure_observed: applyClosingProviderRuntimeFailureObservation,
  execution_warning_attached: attachExecutionWarning,
  transcript_item_observed: applyOpenEndingProviderObservation,
  participant_answer_created: applyOpenEndingProviderObservation,
  participant_answer_transcribed: applyOpenEndingProviderObservation,
  participant_answer_transcription_failed: applyOpenEndingProviderObservation,
  agent_transcript_finalized: applyOpenEndingProviderObservation,
  reply_started: applyOpenEndingProviderObservation,
  reply_generated: applyOpenEndingProviderObservation,
  reply_cancelled: applyOpenEndingProviderObservation,
  reply_delivery_started: applyOpenEndingProviderObservation,
  reply_delivery_stopped: applyOpenEndingProviderObservation,
  session_activity_observed: applyOpenEndingProviderObservation,
  session_error_observed: applyOpenEndingProviderObservation,
  nothing_to_settle: applyOpenEndingProviderObservation,
  nothing_to_cancel: applyOpenEndingProviderObservation,
  session_closed_observed: applyOpenEndingProviderObservation,
  effect_outcome: applyClosingProviderEffectOutcomeObservation,
  interrupted_effects_recovered: applyClosingProviderInterruptedEffectsRecovered,
  transcript_digest_computed: applyClosingProviderTranscriptDigestObservation,
  deadline_reached: applyClosingProviderDeadlineObservation,
} satisfies FinalizationStageTable<"closing_provider">;

const drainingFinalizationTable = {
  conversation_evidence_observed: applyConversationEvidence,
  evidence_prefix_processed: applyEvidencePrefixProcessed,
  end_requested: applyDrainingEndRequestedObservation,
  runtime_failure_observed: applyDrainingRuntimeFailureObservation,
  execution_warning_attached: attachExecutionWarning,
  transcript_item_observed: applyOpenEndingProviderObservation,
  participant_answer_created: applyOpenEndingProviderObservation,
  participant_answer_transcribed: applyOpenEndingProviderObservation,
  participant_answer_transcription_failed: applyOpenEndingProviderObservation,
  agent_transcript_finalized: applyOpenEndingProviderObservation,
  reply_started: applyOpenEndingProviderObservation,
  reply_generated: applyOpenEndingProviderObservation,
  reply_cancelled: applyOpenEndingProviderObservation,
  reply_delivery_started: applyOpenEndingProviderObservation,
  reply_delivery_stopped: applyOpenEndingProviderObservation,
  session_activity_observed: applyOpenEndingProviderObservation,
  session_error_observed: applyOpenEndingProviderObservation,
  nothing_to_settle: applyOpenEndingProviderObservation,
  nothing_to_cancel: applyOpenEndingProviderObservation,
  session_closed_observed: applyOpenEndingProviderObservation,
  effect_outcome: applyDrainingEffectOutcomeObservation,
  interrupted_effects_recovered: applyDrainingInterruptedEffectsRecovered,
  transcript_digest_computed: applyDrainingTranscriptDigestObservation,
  deadline_reached: applyDrainingDeadlineObservation,
} satisfies FinalizationStageTable<"draining">;

const interviewFinalizationRegistry = {
  live: liveFinalizationTable,
  draining: drainingFinalizationTable,
  closing_provider: closingProviderFinalizationTable,
  finalizing: finalizingFinalizationTable,
  ended: endedFinalizationTable,
} satisfies InterviewFinalizationRegistry;

function dispatchInterviewFinalizationRegistry(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationInput,
): FinalizationDecision {
  if (isFinalizationAggregateAtStage(aggregate, "live")) {
    return dispatchFinalizationStageTable(
      interviewFinalizationRegistry.live,
      aggregate,
      observation,
    );
  }
  if (isFinalizationAggregateAtStage(aggregate, "draining")) {
    return dispatchFinalizationStageTable(
      interviewFinalizationRegistry.draining,
      aggregate,
      observation,
    );
  }
  if (isFinalizationAggregateAtStage(aggregate, "closing_provider")) {
    return dispatchFinalizationStageTable(
      interviewFinalizationRegistry.closing_provider,
      aggregate,
      observation,
    );
  }
  if (isFinalizationAggregateAtStage(aggregate, "finalizing")) {
    return dispatchFinalizationStageTable(
      interviewFinalizationRegistry.finalizing,
      aggregate,
      observation,
    );
  }
  if (isFinalizationAggregateAtStage(aggregate, "ended")) {
    return dispatchFinalizationStageTable(
      interviewFinalizationRegistry.ended,
      aggregate,
      observation,
    );
  }
  throw new Error(`Unknown Interview finalization stage: ${aggregate.state.stage}.`);
}

function isFinalizationAggregateAtStage<Stage extends InterviewFinalizationStage>(
  aggregate: InterviewFinalizationAggregate,
  stage: Stage,
): aggregate is FinalizationAggregateAtStage<Stage> {
  return aggregate.state.stage === stage;
}

function dispatchFinalizationStageTable<Stage extends InterviewFinalizationStage>(
  stageTable: FinalizationStageTable<Stage>,
  aggregate: FinalizationAggregateAtStage<Stage>,
  observation: FinalizationInput,
): FinalizationDecision {
  switch (observation.kind) {
    case "conversation_evidence_observed":
      return stageTable.conversation_evidence_observed(aggregate, observation);
    case "evidence_prefix_processed":
      return stageTable.evidence_prefix_processed(aggregate, observation);
    case "end_requested":
      return stageTable.end_requested(aggregate, observation);
    case "execution_warning_attached":
      return stageTable.execution_warning_attached(aggregate, observation);
    case "runtime_failure_observed":
      return stageTable.runtime_failure_observed(aggregate, observation);
    case "transcript_item_observed":
      return stageTable.transcript_item_observed(aggregate, observation);
    case "participant_answer_created":
      return stageTable.participant_answer_created(aggregate, observation);
    case "participant_answer_transcribed":
      return stageTable.participant_answer_transcribed(aggregate, observation);
    case "participant_answer_transcription_failed":
      return stageTable.participant_answer_transcription_failed(aggregate, observation);
    case "agent_transcript_finalized":
      return stageTable.agent_transcript_finalized(aggregate, observation);
    case "reply_started":
      return stageTable.reply_started(aggregate, observation);
    case "reply_generated":
      return stageTable.reply_generated(aggregate, observation);
    case "reply_cancelled":
      return stageTable.reply_cancelled(aggregate, observation);
    case "reply_delivery_started":
      return stageTable.reply_delivery_started(aggregate, observation);
    case "reply_delivery_stopped":
      return stageTable.reply_delivery_stopped(aggregate, observation);
    case "session_activity_observed":
      return stageTable.session_activity_observed(aggregate, observation);
    case "session_error_observed":
      return stageTable.session_error_observed(aggregate, observation);
    case "nothing_to_settle":
      return stageTable.nothing_to_settle(aggregate, observation);
    case "nothing_to_cancel":
      return stageTable.nothing_to_cancel(aggregate, observation);
    case "session_closed_observed":
      return stageTable.session_closed_observed(aggregate, observation);
    case "effect_outcome":
      return stageTable.effect_outcome(aggregate, observation);
    case "interrupted_effects_recovered":
      return stageTable.interrupted_effects_recovered(aggregate, observation);
    case "transcript_digest_computed":
      return stageTable.transcript_digest_computed(aggregate, observation);
    case "deadline_reached":
      return stageTable.deadline_reached(aggregate, observation);
  }
}

type OrderedProviderObservationPreludeResult = Readonly<{
  aggregate: InterviewFinalizationAggregate;
  decision: FinalizationDecision | null;
}>;

function applyLiveEndRequestedObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: FinalizationObservationOfKind<"end_requested">,
): FinalizationDecision {
  return applyEndRequestedObservation(aggregate, observation);
}

function applyLiveRuntimeFailureObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: FinalizationObservationOfKind<"runtime_failure_observed">,
): FinalizationDecision {
  return applyRuntimeFailureObservation(aggregate, observation);
}

function applyLiveEffectOutcomeObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  return applyEffectOutcomeObservation(aggregate, observation);
}

function applyLiveInterruptedEffectsRecovered(
  aggregate: FinalizationAggregateAtStage<"live">,
  _observation: FinalizationObservationOfKind<"interrupted_effects_recovered">,
): FinalizationDecision {
  return recoverInterruptedEffects(aggregate);
}

function applyLiveTranscriptDigestObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: FinalizationObservationOfKind<"transcript_digest_computed">,
): FinalizationDecision {
  return applyTranscriptDigestObservation(aggregate, observation);
}

function applyLiveDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
): FinalizationDecision {
  return applyLifecycleDeadlineObservation(aggregate, observation);
}

function applyFinalizingEndRequestedObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: FinalizationObservationOfKind<"end_requested">,
): FinalizationDecision {
  return applyEndRequestedObservation(aggregate, observation);
}

function applyFinalizingRuntimeFailureObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: FinalizationObservationOfKind<"runtime_failure_observed">,
): FinalizationDecision {
  return applyRuntimeFailureObservation(aggregate, observation);
}

function applyFinalizingEffectOutcomeObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  return applyEffectOutcomeObservation(aggregate, observation);
}

function applyFinalizingInterruptedEffectsRecovered(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  _observation: FinalizationObservationOfKind<"interrupted_effects_recovered">,
): FinalizationDecision {
  return recoverInterruptedEffects(aggregate);
}

function applyFinalizingTranscriptDigestObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: FinalizationObservationOfKind<"transcript_digest_computed">,
): FinalizationDecision {
  return applyTranscriptDigestObservation(aggregate, observation);
}

function applyFinalizingDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
): FinalizationDecision {
  if (
    observation.deadline === "timebox" ||
    observation.deadline === "presence_grace" ||
    observation.deadline === "browser_media_ready"
  ) {
    return applyLifecycleDeadlineObservation(aggregate, observation);
  }
  return { aggregate, effects: [], events: [] };
}

function applyFinalizingProviderObservation(
  aggregate: FinalizationAggregateAtStage<"finalizing">,
  observation: ProviderFinalizationObservation,
): FinalizationDecision {
  const handoff = observeConversation(aggregate, observation);
  return maybeComplete(handoff.aggregate, [...handoff.effects], [], observationAt(observation));
}

function applyClosingProviderEndRequestedObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"end_requested">,
): FinalizationDecision {
  return applyEndRequestedObservation(aggregate, observation);
}

function applyClosingProviderRuntimeFailureObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"runtime_failure_observed">,
): FinalizationDecision {
  return applyRuntimeFailureObservation(aggregate, observation);
}

function applyClosingProviderEffectOutcomeObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  return applyEffectOutcomeObservation(aggregate, observation);
}

function applyClosingProviderInterruptedEffectsRecovered(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  _observation: FinalizationObservationOfKind<"interrupted_effects_recovered">,
): FinalizationDecision {
  return recoverInterruptedEffects(aggregate);
}

function applyClosingProviderTranscriptDigestObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"transcript_digest_computed">,
): FinalizationDecision {
  return applyTranscriptDigestObservation(aggregate, observation);
}

function applyClosingProviderDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"closing_provider">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
): FinalizationDecision {
  if (
    observation.deadline === "timebox" ||
    observation.deadline === "presence_grace" ||
    observation.deadline === "browser_media_ready"
  ) {
    return applyLifecycleDeadlineObservation(aggregate, observation);
  }
  return advanceConversationClosingProviderDeadlineObservation(aggregate, observation, {
    freeze: beginResultFreeze,
    reconcile: maybeComplete,
  });
}

function applyOpenEndingProviderObservation(
  aggregate: FinalizationAggregateAtStage<"draining" | "closing_provider">,
  observation: ProviderFinalizationObservation,
): FinalizationDecision {
  const handoff = observeConversation(aggregate, observation);
  return maybeComplete(
    handoff.aggregate,
    [...handoff.effects],
    [],
    aggregate.state.stage === "closing_provider" && observation.kind === "session_closed_observed"
      ? observation.at
      : observationAt(observation),
  );
}

function applyDrainingEndRequestedObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"end_requested">,
): FinalizationDecision {
  return applyEndRequestedObservation(aggregate, observation);
}

function applyDrainingRuntimeFailureObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"runtime_failure_observed">,
): FinalizationDecision {
  return applyRuntimeFailureObservation(aggregate, observation);
}

function applyDrainingEffectOutcomeObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  return applyEffectOutcomeObservation(aggregate, observation);
}

function applyDrainingInterruptedEffectsRecovered(
  aggregate: FinalizationAggregateAtStage<"draining">,
  _observation: FinalizationObservationOfKind<"interrupted_effects_recovered">,
): FinalizationDecision {
  return recoverInterruptedEffects(aggregate);
}

function applyDrainingTranscriptDigestObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"transcript_digest_computed">,
): FinalizationDecision {
  return applyTranscriptDigestObservation(aggregate, observation);
}

function applyDrainingDeadlineObservation(
  aggregate: FinalizationAggregateAtStage<"draining">,
  observation: FinalizationObservationOfKind<"deadline_reached">,
): FinalizationDecision {
  if (
    observation.deadline === "timebox" ||
    observation.deadline === "presence_grace" ||
    observation.deadline === "browser_media_ready"
  ) {
    return applyLifecycleDeadlineObservation(aggregate, observation);
  }
  return advanceConversationDrainingDeadlineObservation(aggregate, observation, {
    freeze: beginResultFreeze,
    reconcile: maybeComplete,
  });
}

function applyOrderedProviderObservationPrelude(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationInput,
): OrderedProviderObservationPreludeResult {
  if (!isOrderedProviderObservation(observation)) {
    return { aggregate, decision: null };
  }

  const observedAt = observation.observedAt;
  if (
    observedAt !== undefined &&
    (aggregate.state.stage === "draining" || aggregate.state.stage === "closing_provider") &&
    observedAt >= aggregate.state.finalizationCutoffAt
  ) {
    return {
      aggregate,
      decision: advanceFinalizationHandoff(aggregate, {
        kind: "deadline_reached",
        deadline: "finalization_cutoff",
        at: observedAt,
      }),
    };
  }

  const proofBarrier = aggregate.applicationTranscriptProof.closeBarrier;
  if (proofBarrier !== null && compareProviderOrder(observation, proofBarrier) > 0) {
    return { aggregate, decision: { aggregate, effects: [], events: [] } };
  }
  if (isDuplicateProviderObservation(aggregate, observation)) {
    return { aggregate, decision: { aggregate, effects: [], events: [] } };
  }

  let next: InterviewFinalizationAggregate = {
    ...aggregate,
    nextProviderSequence:
      observation.generation > aggregate.providerGeneration
        ? observation.sequence + 1
        : Math.max(aggregate.nextProviderSequence, observation.sequence + 1),
    providerGeneration: Math.max(aggregate.providerGeneration, observation.generation),
    acceptedProviderOrder: {
      generation: observation.generation,
      sequence: observation.sequence,
    },
  };
  next = observeRuntimeUsage(next, observation);

  if (aggregate.state.stage === "live") {
    next = {
      ...next,
      lastProviderObservationAt: Math.max(
        aggregate.applicationTranscriptProof.liveAt,
        aggregate.lastProviderObservationAt ?? 0,
        observationAt(observation),
      ),
    };
  }

  if (
    (next.state.stage === "draining" || next.state.stage === "closing_provider") &&
    isAfterProviderCloseBarrier(next.state, observation)
  ) {
    return {
      aggregate: next,
      decision: maybeComplete(next, [], [], observationAt(observation)),
    };
  }

  if (isMatchingSettledFinalInputObservation(next, observation)) {
    return {
      aggregate: next,
      decision: maybeComplete(next, [], [], observationAt(observation)),
    };
  }

  return { aggregate: next, decision: null };
}

function applyRuntimeFailureObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"runtime_failure_observed">,
): FinalizationDecision {
  let next = aggregate;
  const node = aggregate.conversationNodeExecution;
  if (
    aggregate.state.stage === "live" &&
    node?.dispatch !== undefined &&
    (node.dispatch.status === "pending" ||
      node.dispatch.status === "claimed" ||
      node.dispatch.status === "dispatched")
  )
    next = {
      ...next,
      conversationNodeExecution: {
        ...node,
        dispatch: updateNodeDispatch(node.dispatch, {
          status: "failed",
          limitation: nodeLimitation(node) ?? "closing_interrupted",
        }),
      },
    };
  if (next.state.stage === "live")
    next = {
      ...next,
      applicationTranscriptProof: interruptedProof(next.applicationTranscriptProof),
    };
  if (next.state.stage === "live") {
    return applyEndRequestedObservation(next, {
      kind: "end_requested",
      reason: "runtime_failed",
      source: observation.source,
      at: observation.at,
    });
  }
  if (next.state.stage === "ended" || next.state.endReason === "runtime_failed") {
    return { aggregate: next, effects: [], events: [] };
  }
  return {
    aggregate: {
      ...next,
      state: withEndingWarning(next.state, "runtime_failed_during_finalization"),
    },
    effects: [],
    events: [],
  };
}

function applyLifecycleDeadlineObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"deadline_reached">,
): FinalizationDecision {
  const next = { ...aggregate };
  if (
    next.state.stage !== "live" ||
    (observation.deadline !== "timebox" &&
      observation.deadline !== "presence_grace" &&
      observation.deadline !== "browser_media_ready")
  ) {
    return { aggregate: next, effects: [], events: [] };
  }
  return applyEndRequestedObservation(next, {
    kind: "end_requested",
    reason:
      observation.deadline === "timebox"
        ? "timebox_reached"
        : observation.deadline === "browser_media_ready"
          ? "runtime_failed"
          : "participant_disconnected",
    source:
      observation.deadline === "timebox"
        ? "timebox_alarm"
        : observation.deadline === "browser_media_ready"
          ? "browser_media_ready_timeout"
          : "presence_timeout",
    at: observation.at,
  });
}

function applyEffectOutcomeObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"effect_outcome">,
): FinalizationDecision {
  return advanceConversationEffectOutcomeObservation(aggregate, observation, {
    freeze: beginResultFreeze,
    reconcile: maybeComplete,
  });
}

function applyTranscriptDigestObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"transcript_digest_computed">,
): FinalizationDecision {
  const next = { ...aggregate };
  if (observation.revision !== next.transcriptRevision) {
    return { aggregate: next, effects: [], events: [] };
  }
  return maybeComplete(
    {
      ...next,
      transcriptDigest: observation.digest,
      state: replaceFinalizationStateEffects(
        next.state,
        next.state.effects.map((effect) =>
          effect.kind === "compute_transcript_digest" && effect.revision === observation.revision
            ? { ...effect, status: "dispatched" }
            : effect,
        ),
      ),
    },
    [],
    [],
    observation.at,
  );
}

function applyLiveProviderObservation(
  aggregate: FinalizationAggregateAtStage<"live">,
  observation: ProviderFinalizationObservation,
): FinalizationDecision {
  const handoff = observeConversation(aggregate, observation);
  if (observation.kind === "session_closed_observed")
    return applyRuntimeFailureObservation(handoff.aggregate, {
      kind: "runtime_failure_observed",
      source: "session_closed_observed",
      at: observation.at,
    });
  return maybeComplete(handoff.aggregate, [...handoff.effects], [], observationAt(observation));
}

const advanceFacts = Symbol("host finalization handoff");

type HandoffAggregate = InterviewFinalizationAggregate & {
  [advanceFacts]?: FinalizationConversationFacts;
};

function readAdvanceFacts(aggregate: HandoffAggregate): FinalizationConversationFacts | undefined {
  return aggregate[advanceFacts];
}

/** The selected Conversation's declared terminals accompany every live visit. */
export type FinalizationConversationFacts = FinalizationAdvanceFacts &
  Readonly<{
    conversationTerminals?: Readonly<{ completion: string; interruption: string }> | undefined;
  }>;

export function advanceInterviewFinalization(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationInput,
  facts: FinalizationConversationFacts = {},
): FinalizationDecision {
  if (
    facts.receiptPrefix === undefined &&
    facts.usageEvidenceSupplied !== true &&
    facts.excludedParticipantInput !== true &&
    facts.conversationTerminals === undefined
  )
    return advanceFinalizationHandoff(aggregate, observation);
  const scoped: HandoffAggregate = { ...aggregate, [advanceFacts]: facts };
  const decision = advanceFinalizationHandoff(scoped, observation);
  if (decision.aggregate === scoped) return { ...decision, aggregate };
  const withFacts: HandoffAggregate = decision.aggregate;
  const { [advanceFacts]: _facts, ...committed } = withFacts;
  return { ...decision, aggregate: committed };
}

function advanceFinalizationHandoff(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationInput,
): FinalizationDecision {
  if (aggregate.state.stage === "ended") {
    return dispatchInterviewFinalizationRegistry(aggregate, observation);
  }

  const prelude = applyOrderedProviderObservationPrelude(aggregate, observation);
  if (prelude.decision !== null) return prelude.decision;

  const accountingAggregate = isOrderedProviderObservation(observation)
    ? prelude.aggregate
    : observeRuntimeUsage(prelude.aggregate, observation);
  if (readAdvanceFacts(aggregate)?.excludedParticipantInput === true)
    return { aggregate: accountingAggregate, effects: [], events: [] };
  return dispatchInterviewFinalizationRegistry(accountingAggregate, observation);
}

function observeRuntimeUsage(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationInput,
): InterviewFinalizationAggregate {
  if (
    readAdvanceFacts(aggregate)?.usageEvidenceSupplied === true ||
    aggregate.state.stage === "ended"
  )
    return aggregate;
  const runtimeUsage = applyRuntimeUsageEvidence(
    aggregate.runtimeUsage,
    observeConversationUsage(observation, aggregate.state.stage, aggregate.runtimeUsage),
  );
  return runtimeUsage === aggregate.runtimeUsage ? aggregate : { ...aggregate, runtimeUsage };
}

function beginResultFreeze(
  aggregate: InterviewFinalizationAggregate,
  effects: FinalizationEffectRecord[],
  events: RuntimePublicEvent[],
  at: number,
): FinalizationDecision {
  if (aggregate.state.stage !== "draining" && aggregate.state.stage !== "closing_provider") {
    return withEffects(aggregate, effects, events);
  }
  if (at < aggregate.state.finalizationCutoffAt && hasPendingRetainedInterviewerText(aggregate)) {
    return deferConversationFreezeForReceiptPrefix(aggregate, effects, events, at);
  }
  if (!permitsResultFreezeAtReceivedPrefix(aggregate, at)) {
    return deferConversationFreezeForReceiptPrefix(aggregate, effects, events, at);
  }
  const state = aggregate.state;
  const prefix = readAdvanceFacts(aggregate)?.receiptPrefix;
  if (
    at >= aggregate.state.finalizationCutoffAt &&
    (hasPendingRetainedInterviewerText(aggregate) ||
      (prefix !== undefined &&
        prefix.receivedOrder !== null &&
        (prefix.processedThroughOrder === null ||
          compareProviderOrder(prefix.processedThroughOrder, prefix.receivedOrder) < 0)))
  ) {
    aggregate = {
      ...aggregate,
      applicationTranscriptProof: { ...aggregate.applicationTranscriptProof, evidenceGap: true },
    };
  }
  const finalizing: FinalizationFinalizingState =
    state.stage === "closing_provider"
      ? toFinalizingState(state)
      : {
          stage: "finalizing",
          endReason: state.endReason,
          source: state.source,
          strategy: state.strategy,
          endingStartedAt: state.endingStartedAt,
          finalizationCutoffAt: state.finalizationCutoffAt,
          activeInputItemId: state.activeInputItemId,
          activeResponseId: state.activeResponseId,
          admittedResponseId: state.admittedResponseId,
          sessionClosed: state.sessionClosed,
          effects: state.effects,
          warnings: state.warnings,
        };
  const retainedEffects = effects.map(containEffectAtResultFreeze);
  return maybeComplete({ ...aggregate, state: finalizing }, retainedEffects, events, at);
}

function maybeComplete(
  aggregate: InterviewFinalizationAggregate,
  effects: FinalizationEffectRecord[],
  events: RuntimePublicEvent[],
  at?: number,
): FinalizationDecision {
  if (
    (aggregate.state.stage === "draining" || aggregate.state.stage === "closing_provider") &&
    !projectConversationEvidence(aggregate).pending &&
    at !== undefined &&
    at < aggregate.state.finalizationCutoffAt
  ) {
    if (!permitsResultFreezeAtReceivedPrefix(aggregate, at))
      return deferConversationFreezeForReceiptPrefix(aggregate, effects, events, at);
    const effectsWithHangup = [...effects];
    requestConversationCleanup(aggregate, effectsWithHangup);
    return beginResultFreeze(aggregate, effectsWithHangup, events, at);
  }
  if (
    aggregate.state.stage === "closing_provider" &&
    permitsResultFreezeAtReceivedPrefix(aggregate, at) &&
    !projectConversationEvidence(aggregate).pending &&
    projectConversationEvidence(aggregate).closureReadyForFreeze
  ) {
    aggregate = { ...aggregate, state: toFinalizingState(aggregate.state) };
  }
  const finalizing = aggregate.state;
  if (finalizing.stage !== "finalizing") return withEffects(aggregate, effects, events);
  // A frozen result cannot retain runnable media mutations. A command whose
  // dispatch was claimed is uncertain; one that is still pending definitely
  // never started. Provider hangup settles separately after result freeze.
  const state: FinalizationFinalizingState = {
    ...finalizing,
    effects: finalizing.effects.map(containEffectAtResultFreeze),
  };
  aggregate = { ...aggregate, state };
  if (aggregate.transcriptDigest === null) {
    const digestEffect = aggregate.state.effects.find(
      (effect) =>
        effect.kind === "compute_transcript_digest" &&
        effect.revision === aggregate.transcriptRevision,
    );
    if (digestEffect === undefined)
      addEffect(aggregate, effects, {
        kind: "compute_transcript_digest",
        revision: aggregate.transcriptRevision,
      });
    return withEffects(aggregate, effects, events);
  }

  const finalizedAt = at ?? state.endingStartedAt;
  const completion: RuntimeFinalizationCompletion = {
    runId: aggregate.runId,
    outcome: state.endReason === "runtime_failed" ? "failed" : "ended",
    endReason: state.endReason,
    source: state.source,
    endingStartedAt: state.endingStartedAt,
    endedAt: state.endingStartedAt,
    finalizationCutoffAt: state.finalizationCutoffAt,
    finalizedAt,
    transcriptSnapshot: {
      revision: aggregate.transcriptRevision,
      digest: aggregate.transcriptDigest,
      turnCount: getSerializedTranscriptTurns(aggregate.transcriptCapture).length,
    },
    warnings: state.warnings,
  };
  const ended: FinalizationEndedState = {
    stage: "ended",
    completion,
    publication: {
      status: "pending",
      publicationCutoffAt: finalizedAt + interviewResultPublicationPeriodMs,
      transcriptDelivered: false,
      completionDelivered: false,
      retryAt: null,
      attemptCount: 0,
      deliveredAt: null,
      lastError: null,
    },
    effects: state.effects,
  };
  const proof = aggregate.applicationTranscriptProof;
  const completedReason = completedReasonOf(proof);
  let next: InterviewFinalizationAggregate = { ...aggregate, state: ended };
  if (proof.interrupted || completedReason !== undefined) {
    const transcriptIncompleteReasons =
      projectConversationEvidence(aggregate).transcriptIncompleteReasons;
    next = {
      ...next,
      applicationTranscriptProof: {
        ...proof,
        result: {
          runId: aggregate.runId,
          ...(completedReason === undefined
            ? { outcome: "interrupted" as const }
            : { outcome: "completed" as const, reason: completedReason }),
          liveAt: proof.liveAt,
          endedAt: state.endingStartedAt,
          transcriptSnapshot: completion.transcriptSnapshot,
          transcriptCompleteness:
            transcriptIncompleteReasons.length === 0 ? "complete" : "incomplete",
          transcriptIncompleteReasons,
          runtimeUsage: sealRuntimeUsage(next.runtimeUsage),
        },
      },
    };
  }
  events.push({
    id: allocateEventId(next),
    type: "runtime.controller_completed",
    payload: { completion },
  });
  return withEffects(next, effects, events);
}

function permitsResultFreezeAtReceivedPrefix(
  aggregate: InterviewFinalizationAggregate,
  at?: number,
): boolean {
  if (aggregate.state.stage !== "draining" && aggregate.state.stage !== "closing_provider")
    return true;
  if (at !== undefined && at >= aggregate.state.finalizationCutoffAt) return true;
  const prefix = readAdvanceFacts(aggregate)?.receiptPrefix;
  if (prefix?.receivedOrder === null || prefix === undefined) return true;
  return (
    prefix.processedThroughOrder !== null &&
    compareProviderOrder(prefix.processedThroughOrder, prefix.receivedOrder) >= 0
  );
}

function applyEvidencePrefixProcessed(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"evidence_prefix_processed">,
): FinalizationDecision {
  return maybeComplete(aggregate, [], [], observation.at);
}

function applyEndRequestedObservation(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"end_requested">,
): FinalizationDecision {
  const state = aggregate.state;
  if (state.stage === "ended") return { aggregate, effects: [], events: [] };
  if (
    state.stage === "live" &&
    observation.reason === "agent_requested_end" &&
    readConversationCompletionReference(aggregate) === null &&
    !isFinishingNode(aggregate.conversationNodeExecution) &&
    aggregate.conversationNodeExecution?.dispatch?.status !== "complete"
  )
    return { aggregate, effects: [], events: [] };
  const finishing = isFinishingNode(aggregate.conversationNodeExecution)
    ? aggregate.conversationNodeExecution
    : undefined;
  const accepted =
    state.stage === "live"
      ? {
          reason: finishing?.reservation.reason ?? observation.reason,
          source: finishing?.reservation.source ?? observation.source,
          acceptedAt: finishing?.participantEnd?.at ?? observation.at,
          cutoffAt:
            (finishing?.participantEnd?.at ?? observation.at) + interviewFinalizationPeriodMs,
        }
      : {
          reason: state.endReason,
          source: state.source,
          acceptedAt: state.endingStartedAt,
          cutoffAt: state.finalizationCutoffAt,
        };
  const next =
    state.stage !== "live" &&
    observation.reason === "runtime_failed" &&
    state.endReason !== "runtime_failed"
      ? { ...aggregate, state: withEndingWarning(state, "runtime_failed_during_finalization") }
      : aggregate;
  // Runtime names only a terminal the selected Conversation declares. A Run whose
  // selection cannot be resolved still ends; its last admitted visit is retained.
  const terminals = readAdvanceFacts(aggregate)?.conversationTerminals;
  const terminal =
    state.stage === "live" && aggregate.conversationVisit !== undefined && terminals !== undefined
      ? {
          ...next,
          conversationVisit: {
            ...aggregate.conversationVisit,
            state:
              observation.reason === "runtime_failed" ||
              observation.reason === "participant_disconnected"
                ? terminals.interruption
                : terminals.completion,
          },
        }
      : next;
  const completionReference = readConversationCompletionReference(aggregate);
  const participantTruncatesRetainedOutput =
    state.stage === "live" &&
    observation.reason === "participant_stopped" &&
    aggregate.conversationNodeExecution?.kind === "retained_output" &&
    completionReference !== null;
  return endConversation(terminal, {
    ...accepted,
    completionReference: participantTruncatesRetainedOutput
      ? {
          ...completionReference,
          participantMediaSafetyOverride: true,
          outputAudioSettlement: "contained",
        }
      : completionReference,
  });
}

function applyConversationEvidence(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"conversation_evidence_observed">,
): FinalizationDecision {
  if (aggregate.state.stage === "ended") return { aggregate, effects: [], events: [] };
  const snapshot = {
    ...observation.snapshot,
    runtimeUsage: applyRuntimeUsageEvidence(aggregate.runtimeUsage, observation.usageEvidence),
    [advanceFacts]: readAdvanceFacts(aggregate),
  };
  if (observation.notification === "unable_to_continue")
    return applyRuntimeFailureObservation(snapshot, {
      kind: "runtime_failure_observed",
      source: "session_closed_observed",
      at: observation.at,
    });
  if (observation.notification === "completion" && snapshot.state.stage === "live") {
    const reference = readConversationCompletionReference(snapshot);
    if (reference === null)
      return applyEndRequestedObservation(snapshot, {
        kind: "end_requested",
        reason: "agent_requested_end",
        source: "agent_completion",
        at: observation.at,
      });
    const event =
      reference.callId === null
        ? null
        : addEvent(snapshot, "runtime.agent_completed_interview", {
            responseId: reference.responseId,
            callId: reference.callId,
          });
    const node = snapshot.conversationNodeExecution;
    const reservation = isFinishingNode(node) ? node.reservation : undefined;
    const completed =
      event === null
        ? snapshot
        : { ...snapshot, nextEventSequence: snapshot.nextEventSequence + 1 };
    // A reply delivered to its end has time to play before Ending, which would cut it: the end
    // waits for its playing time and the margin. A reply already cut, as by Original's cleanup
    // releasing the session, gets no margin.
    if (
      isFinishingNode(node) &&
      node.dispatch.status === "complete" &&
      node.endingAt === undefined &&
      !reference.participantMediaSafetyOverride &&
      reference.responseSettlement === "completed" &&
      reference.outputAudioSettlement === "stopped" &&
      !(node.kind === "retained_output" && node.cleanup.status === "claimed")
    ) {
      const endingAt = playbackEndingAt(snapshot, reference.responseId, observation.at);
      if (endingAt > observation.at)
        return maybeComplete(
          { ...completed, conversationNodeExecution: { ...node, endingAt } },
          [...observation.effects],
          event === null ? [] : [event],
          observation.at,
        );
    }
    const decision = applyEndRequestedObservation(completed, {
      kind: "end_requested",
      reason: reservation?.reason ?? "agent_requested_end",
      source: reservation?.source ?? "agent_completion",
      at: observation.at,
    });
    return {
      ...decision,
      events: event === null ? decision.events : [event, ...decision.events],
    };
  }

  return maybeComplete(snapshot, [...observation.effects], [], observation.at);
}

/**
 * An execution's warning joins the result: while Live it is kept for the result, and once
 * Ending began it joins the Ending's warnings. A saved result does not change.
 */
function attachExecutionWarning(
  aggregate: InterviewFinalizationAggregate,
  observation: FinalizationObservationOfKind<"execution_warning_attached">,
): FinalizationDecision {
  const state = aggregate.state;
  if (state.stage === "ended") return { aggregate, effects: [], events: [] };
  if (state.stage === "live") {
    const kept = aggregate.executionWarnings ?? [];
    return kept.includes(observation.warning)
      ? { aggregate, effects: [], events: [] }
      : {
          aggregate: { ...aggregate, executionWarnings: [...kept, observation.warning] },
          effects: [],
          events: [],
        };
  }
  if (state.warnings.includes(observation.warning)) return { aggregate, effects: [], events: [] };
  return {
    aggregate: { ...aggregate, state: withResultWarning(state, observation.warning) },
    effects: [],
    events: [],
  };
}

/**
 * The execution's account of an input closure it has not carried out, as Runtime asks for it at
 * Ending's entry: input to settle, and an answer superseding the one Runtime held.
 */
export function describeInputClosure(
  aggregate: InterviewFinalizationAggregate,
  settlement: InputClosureSettlement,
): InterviewFinalizationAggregate {
  return applyInputClosureSettlement(aggregate, settlement);
}
